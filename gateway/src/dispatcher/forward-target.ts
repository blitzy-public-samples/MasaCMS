// Forwards a target-bound request to its owning service or to web with gateway-issued credentials; failures fail closed.
import { channel } from 'node:diagnostics_channel';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyReplyFromHooks, FastifyReplyFromResponse } from '@fastify/reply-from';
import type { HeaderMap, InvocationMinter } from '@opt2/platform/auth';
import { serializeError } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, parseWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import {
  REQUEST_ID_HEADER,
  SERVICE_CALL_TIMEOUT_MS,
  currentRequestContext,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { injectHttpHeaders } from '@opt2/platform/tracing';
import type { SessionMode } from '../session/mode.js';
import type { SessionBarrier } from './barrier.js';
import { failClosed, isTargetUnavailable, neverSent, type FailContext } from './fail-closed.js';
import {
  HOP_BY_HOP_HEADERS,
  applyLegacyHeaders,
  forwardedHeaders,
  isWebPageRedirect,
  normaliseWebResponseHeaders,
} from './headers.js';
import { settlingRelay } from './settling-relay.js';

/** A target's status and headers as received; a `set-cookie` header is always a list. */
export interface TargetUpstream {
  statusCode: number;
  headers: IncomingHttpHeaders;
}

/** Inputs of one forward to a target service or web. */
export interface TargetForwardContext {
  /** Callee name, for example `people` or `web`. */
  service: string;
  /** Callee base URL from `OPT2_SERVICE_URLS`. */
  serviceUrl: string;
  /** Path and query the callee receives: `request.url`, or the web path of an admin action. */
  path: string;
  /** Inbound headers as dispatch stripped them after the credential exchange. */
  headers: HeaderMap;
  /** Site-scoped user token sent as `Authorization: Bearer`; without it no `Authorization` is sent. */
  userToken?: string;
  /** Gateway-authored headers, for example `X-Opt2-Original-Url` for web. */
  extraHeaders?: Readonly<Record<string, string>>;
  /** Method the callee receives; absent means the request's own. */
  method?: string;
  /** False when the callee must receive no body; absent means the raw body is forwarded. */
  forwardBody?: boolean;
  /** Identity session whose barrier records the response's write positions. */
  sessionId?: string;
  /** True for a write the session's legacy reads must await; it is declared in the barrier before it is forwarded. */
  declaresWrite?: boolean;
  /** Session mode of the active version, reported with forwarding failures. */
  mode: SessionMode;
  /** True for web, whose responses are normalised and whose every 5xx fails closed. */
  isWeb: boolean;
  failContext: FailContext;
  /** Mints the gateway's own invocation credential for the callee. */
  invocation: InvocationMinter;
  /** Declares a write and records the response's write positions; when recording fails, legacy confirms them before the response leaves. */
  barrier: Pick<SessionBarrier, 'declare' | 'record' | 'release' | 'awaitPositions' | 'awaitOwners'>;
  /** Returns the `Set-Cookie` values the client receives for the target's (possibly empty) list. */
  mapSetCookies?: (setCookies: string[]) => Promise<string[]>;
  /** Runs once the client response is ready, before any byte is sent; a rejection answers the legacy-shaped 503 instead. */
  beforeSend?: (upstream: TargetUpstream) => Promise<void>;
  /** Called at most once, only when the target can no longer commit: its response completed or the request never reached it. */
  onSettled?: () => Promise<void>;
}

/** Request headers never forwarded: hop-by-hop ones, `expect` (the gateway already answered it) and those set below. */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([...HOP_BY_HOP_HEADERS, 'expect', 'host', 'content-length']);

/** Only tells reply-from not to re-encode the body; the forwarded `content-type` is the inbound one or none. */
const RAW_BODY_CONTENT_TYPE = 'application/octet-stream';

/** Web's runtime assets, forwarded unchanged in both directions. */
const WEB_RUNTIME_ASSET_PREFIX = '/_next/';

/** Request headers that would switch Next to its client-router protocol. */
const NEXT_ROUTER_HEADERS: ReadonlySet<string> = new Set(['rsc', 'next-url', 'next-action']);
const NEXT_ROUTER_HEADER_PREFIX = 'next-router-';

/** Status of legacy's `cflocation`, which a page-mode Next redirect becomes. */
const LEGACY_REDIRECT_STATUS = 302;

// The OTel undici instrumentation subscribes here and appends, never replaces, the active trace context's headers.
const undiciRequestCreated = channel('undici:request:create');

/** Lower-cased header names a `Connection` value lists. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
}

function isNextRouterHeader(name: string): boolean {
  return NEXT_ROUTER_HEADERS.has(name) || name.startsWith(NEXT_ROUTER_HEADER_PREFIX);
}

/** The owner names a write-position header lists, valid or not, plus the callee's, each once. */
function listedOwners(value: string | string[], service: string): string[] {
  const owners = (Array.isArray(value) ? value.join(',') : value).split(',').map((entry) => {
    const equals = entry.indexOf('=');
    return (equals === -1 ? entry : entry.slice(0, equals)).trim();
  });
  return [...new Set([...owners.filter((owner) => owner !== ''), service])];
}

/**
 * Headers the callee receives: the stripped inbound ones, `X-Forwarded-*`, the gateway's own headers, the user token,
 * the invocation credential, one trace context, the gateway's request id and the callee's own `Host`.
 */
function targetRequestHeaders(
  request: FastifyRequest,
  ctx: TargetForwardContext,
  credential: Readonly<Record<string, string>>,
  bodyLength: number | undefined,
): Record<string, string | string[]> {
  const listed = connectionTokens(ctx.headers.connection);
  const stripRouter = ctx.isWeb && !ctx.path.startsWith(WEB_RUNTIME_ASSET_PREFIX);
  // fromEntries defines own properties, so a header named `__proto__` stays a header.
  const headers: Record<string, string | string[]> = Object.fromEntries(
    Object.entries(ctx.headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(
        (entry): entry is readonly [string, string | string[]] =>
          entry[1] !== undefined &&
          !DROPPED_REQUEST_HEADERS.has(entry[0]) &&
          !listed.has(entry[0]) &&
          !(stripRouter && isNextRouterHeader(entry[0])),
      ),
  );
  Object.assign(headers, forwardedHeaders(request));
  for (const [name, value] of Object.entries(ctx.extraHeaders ?? {})) headers[name.toLowerCase()] = value;
  if (ctx.forwardBody === false) delete headers['content-type'];
  if (bodyLength !== undefined) headers['content-length'] = String(bodyLength);
  if (ctx.userToken === undefined) delete headers.authorization;
  else headers.authorization = `Bearer ${ctx.userToken}`;
  for (const [name, value] of Object.entries(credential)) headers[name.toLowerCase()] = value;
  if (undiciRequestCreated.hasSubscribers) {
    delete headers.traceparent;
    delete headers.tracestate;
  } else {
    injectHttpHeaders(headers);
  }
  headers[REQUEST_ID_HEADER] = currentRequestContext()?.requestId ?? request.id;
  headers.host = new URL(ctx.serviceUrl).host;
  return headers;
}

/** Response headers without hop-by-hop ones, which describe the callee's connection, not the client's. */
function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = connectionTokens(headers.connection);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return !HOP_BY_HOP_HEADERS.has(lower) && !listed.has(lower);
    }),
  );
}

/** The target's status and a copy of its headers with `set-cookie` as a list. */
function upstreamOf(res: FastifyReplyFromResponse): TargetUpstream {
  const headers = { ...res.headers } as IncomingHttpHeaders;
  const setCookie: unknown = headers['set-cookie'];
  if (typeof setCookie === 'string') headers['set-cookie'] = [setCookie];
  return { statusCode: res.statusCode, headers };
}

/** Replaces every reply header with the web-normalised set for `path` and `statusCode`. */
function normaliseWebReply(reply: FastifyReply, path: string, statusCode: number): void {
  const current = reply.getHeaders();
  const normalised = normaliseWebResponseHeaders(current, { path, statusCode });
  for (const name of Object.keys(current)) reply.removeHeader(name);
  for (const [name, value] of Object.entries(normalised)) reply.header(name, value);
}

/**
 * Forwards `request` to `ctx.serviceUrl` + `ctx.path` once, bounded by SERVICE_CALL_TIMEOUT_MS and never retried.
 * Connection failure, timeout or an unavailable status sends the legacy-shaped 503 of `ctx.failContext`.
 */
export async function forwardToTarget(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: TargetForwardContext,
): Promise<FastifyReply> {
  const logFields = { service: ctx.service, sessionMode: ctx.mode };
  let settled = false;
  /** Session whose declaration of this write the exchange still holds. */
  let declared: string | undefined;
  /** Runs `onSettled` once; a later call returns at once and a failure is logged. */
  const settle = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await ctx.onSettled?.();
    } catch (error) {
      request.log.error({ ...logFields, error: serializeError(error) }, 'target forward onSettled failed');
    }
  };
  /** Ends the held declaration of a write legacy need not await; a failure only adds an owner await to each later legacy read. */
  const release = async (): Promise<void> => {
    const sessionId = declared;
    declared = undefined;
    if (sessionId === undefined) return;
    try {
      await ctx.barrier.release(sessionId, ctx.service);
    } catch (error) {
      request.log.error({ ...logFields, error: serializeError(error) }, 'target write declaration not released');
    }
  };
  /** Settles an exchange that never reached the callee, then answers the 503. */
  const failUnsent = async (error: unknown, message: string): Promise<FastifyReply> => {
    request.log.error({ ...logFields, error: serializeError(error) }, message);
    await settle();
    await release();
    return failClosed(reply, ctx.failContext);
  };
  /** Logs an end after which the target may still commit, which therefore leaves the exchange unsettled. */
  const unsettled = (error: unknown): void => {
    request.log.warn(
      { ...logFields, error: serializeError(error) },
      'target exchange ended uncertainly; in-flight registration kept',
    );
  };

  let credential: Record<string, string>;
  try {
    credential = await ctx.invocation.headersFor(
      { name: ctx.service, url: ctx.serviceUrl },
      { signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS) },
    );
  } catch (error) {
    return failUnsent(error, 'invocation credential for target forward failed');
  }

  // Web's writes reach the services through the relay, which declares them there.
  const declaring = ctx.declaresWrite === true && !ctx.isWeb ? ctx.sessionId : undefined;
  if (declaring !== undefined) {
    try {
      await ctx.barrier.declare(declaring, ctx.service);
    } catch (error) {
      return failUnsent(error, 'target write declaration failed');
    }
    declared = declaring;
  }

  /** Records the response's write positions for the session; when that fails, legacy confirms them before any byte leaves. */
  async function recordPositions(value: string | string[] | undefined): Promise<void> {
    if (value === undefined || ctx.sessionId === undefined) return;
    // Recording ends the declaration; unrecorded, it ends only once legacy confirms the write, so legacy reads await the owner.
    const owner = declared === undefined ? undefined : ctx.service;
    let positions: WritePositions;
    try {
      positions = parseWritePosition(value);
    } catch (error) {
      request.log.error({ ...logFields, error: serializeError(error) }, 'target write position not recorded');
      await ctx.barrier.awaitOwners(listedOwners(value, ctx.service));
      await release();
      return;
    }
    try {
      await ctx.barrier.record(ctx.sessionId, positions, owner);
    } catch (error) {
      request.log.error({ ...logFields, error: serializeError(error) }, 'target write position not recorded');
      await ctx.barrier.awaitPositions(positions);
      await release();
      return;
    }
    declared = undefined;
  }

  async function respond(res: FastifyReplyFromResponse): Promise<void> {
    // reply-from also calls onResponse after it answered an invalid upstream status through onError.
    if (reply.sent || reply.raw.headersSent) {
      res.stream.resume();
      return;
    }
    const { statusCode } = res;
    if (ctx.isWeb ? statusCode >= 500 : isTargetUnavailable(statusCode)) {
      res.stream.resume();
      failClosed(reply, ctx.failContext);
      return;
    }
    const upstream = upstreamOf(res);
    reply.removeHeader(WRITE_POSITION_HEADER_LC);
    await recordPositions(upstream.headers[WRITE_POSITION_HEADER_LC]);
    if (ctx.mapSetCookies !== undefined) {
      const cookies = await ctx.mapSetCookies(upstream.headers['set-cookie'] ?? []);
      reply.removeHeader('set-cookie');
      if (cookies.length > 0) reply.header('set-cookie', [...cookies]);
    }
    const pageRedirect = ctx.isWeb && isWebPageRedirect({ path: ctx.path, statusCode });
    if (ctx.isWeb) normaliseWebReply(reply, ctx.path, statusCode);
    applyLegacyHeaders(reply);
    try {
      await ctx.beforeSend?.(upstream);
    } catch (error) {
      request.log.error({ ...logFields, error: serializeError(error) }, 'target forward beforeSend failed');
      res.stream.resume();
      failClosed(reply, ctx.failContext);
      return;
    }
    // Answered without a write position, the write committed nothing the session's legacy reads must await.
    await release();
    if (pageRedirect) {
      res.stream.resume();
      reply.code(LEGACY_REDIRECT_STATUS).send();
      return;
    }
    reply.send(res.stream);
  }

  const queryAt = ctx.path.indexOf('?');
  const path = queryAt === -1 ? ctx.path : ctx.path.slice(0, queryAt);
  const query = queryAt === -1 ? '' : ctx.path.slice(queryAt + 1);
  const body = ctx.forwardBody !== false && Buffer.isBuffer(request.body) ? request.body : undefined;

  const options: FastifyReplyFromHooks = {
    ...(ctx.method === undefined ? {} : { method: ctx.method }),
    // The query bypasses reply-from's URL parsing, so it reaches the callee byte for byte.
    queryString: () => query,
    // null keeps reply-from from re-reading and re-encoding `request.body` itself.
    ...(body === undefined ? { body: null } : { body, contentType: RAW_BODY_CONTENT_TYPE }),
    rewriteRequestHeaders: () => targetRequestHeaders(request, ctx, credential, body?.length),
    rewriteHeaders: (headers) => endToEndHeaders(headers),
    timeout: SERVICE_CALL_TIMEOUT_MS,
    retriesCount: 0,
    // Runs once per exchange, before reply-from may destroy the response of an aborted client; null disables retries.
    retryDelay: ({ err, res }) => {
      if (ctx.onSettled === undefined && declared === undefined) return null;
      // Typed as the reply, but reply-from passes the upstream response here, or nothing when the exchange failed.
      const upstream = res as unknown as FastifyReplyFromResponse | undefined;
      // The same object reaches reply-from's abort check and onResponse, so both see only the relay.
      if (upstream !== undefined) upstream.stream = settlingRelay(upstream.stream, () => settle(), unsettled);
      else if (neverSent(err)) void Promise.all([settle(), release()]);
      else unsettled(err);
      return null;
    },
    onResponse: (_request, _reply, res) => {
      // No byte has reached the client before `respond` sends, so a failure here answers the 503.
      respond(res).catch((error: unknown) => {
        request.log.error({ ...logFields, error: serializeError(error) }, 'target response failed');
        res.stream.destroy();
        failClosed(reply, ctx.failContext);
      });
    },
    // Synchronous: for an invalid status reply-from calls onResponse next, which must see the 503 sent.
    onError: () => {
      failClosed(reply, ctx.failContext);
    },
  };

  let forwarded: FastifyReply;
  try {
    forwarded = reply.from(`${ctx.serviceUrl.replace(/\/+$/, '')}${path}`, options);
  } catch (error) {
    // reply-from rejects a path it cannot parse, and a GET or HEAD carrying a body, before anything is sent.
    return failUnsent(error, 'target forward rejected before sending');
  }
  return forwarded;
}
