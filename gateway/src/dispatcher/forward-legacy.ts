// Forwards a request to the legacy Masa origin; request and response bytes pass unchanged except the session cookie mapping.
import { channel } from 'node:diagnostics_channel';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { PassThrough, finished, pipeline, type Readable } from 'node:stream';
import type { FastifyReplyFromHooks, FastifyReplyFromResponse } from '@fastify/reply-from';
import type { HeaderMap } from '@opt2/platform/auth';
import { isLegacySessionCookie, parseSetCookie } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import type { FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
import { injectHttpHeaders } from '@opt2/platform/tracing';
import type { SessionMode } from '../session/mode.js';
import { failClosed, type FailContext } from './fail-closed.js';
import { HOP_BY_HOP_HEADERS, forwardedHeaders } from './headers.js';

/** Legacy's status and headers; a `set-cookie` header is always a list. */
export interface LegacyUpstream {
  statusCode: number;
  headers: IncomingHttpHeaders;
}

/** Client-response change `beforeSend` asks for: `setCookies`, when defined, replaces every legacy `Set-Cookie`. */
export interface LegacyBeforeSendResult {
  setCookies?: string[];
}

/** Runs once legacy's status and headers are known, before any byte reaches the client. */
export type LegacyBeforeSend = (upstream: LegacyUpstream) => Promise<LegacyBeforeSendResult | void>;

/** A complete legacy response held by the gateway. */
export interface BufferedLegacyResponse extends LegacyUpstream {
  body: Buffer;
}

/** Why legacy can no longer commit for an exchange: its response ended, or the request never reached it. */
export type LegacySettlement = 'completed' | 'not-sent';

/** Inputs of one forward to legacy. */
export interface LegacyForwardContext {
  /** Legacy origin, e.g. `http://127.0.0.1:8080`. */
  legacyOrigin: string;
  /** Inbound headers as dispatch stripped them for legacy. */
  headers: HeaderMap;
  /** `Cookie` legacy receives in place of the inbound one; '' sends none, undefined keeps the inbound one. */
  cookieHeader?: string;
  /** In `target-primary`, legacy session `Set-Cookie` values reach the client only through `beforeSend`'s `setCookies`. */
  sessionMode: SessionMode;
  /** `buffer` holds the whole response until `beforeSend` and `onBuffered` have resolved. */
  mode: 'stream' | 'buffer';
  beforeSend?: LegacyBeforeSend;
  /** Buffer mode only; called only for a complete body, after `onSettled` has run. */
  onBuffered?: (res: BufferedLegacyResponse) => Promise<void>;
  /** Called at most once, only when legacy can no longer commit for this exchange; never after an uncertain end. */
  onSettled?: (outcome: LegacySettlement) => Promise<void>;
  failContext: FailContext;
}

/** Request headers never forwarded: hop-by-hop ones, `expect` (the gateway already answered it) and those set below. */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([...HOP_BY_HOP_HEADERS, 'expect', 'host', 'content-length']);

/** Only tells reply-from not to re-encode the body; the forwarded `content-type` is the inbound one or none. */
const RAW_BODY_CONTENT_TYPE = 'application/octet-stream';

/** Connection-establishment failure codes, after which legacy never received the request. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

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

// The OTel undici instrumentation subscribes here and appends, never replaces, the active trace context's headers.
const undiciRequestCreated = channel('undici:request:create');

/** Headers legacy receives: the stripped inbound ones, the inbound `Host`, `X-Forwarded-*`, the mapped `Cookie` and one trace context. */
function legacyRequestHeaders(
  request: FastifyRequest,
  ctx: LegacyForwardContext,
  bodyLength: number | undefined,
): Record<string, string | string[]> {
  const listed = connectionTokens(ctx.headers.connection);
  // fromEntries defines own properties, so a header named `__proto__` stays a header.
  const headers: Record<string, string | string[]> = Object.fromEntries(
    Object.entries(ctx.headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(
        (entry): entry is readonly [string, string | string[]] =>
          entry[1] !== undefined && !DROPPED_REQUEST_HEADERS.has(entry[0]) && !listed.has(entry[0]),
      ),
  );
  if (request.headers.host !== undefined) headers.host = request.headers.host;
  Object.assign(headers, forwardedHeaders(request));
  if (ctx.cookieHeader === '') delete headers.cookie;
  else if (ctx.cookieHeader !== undefined) headers.cookie = ctx.cookieHeader;
  if (bodyLength !== undefined) headers['content-length'] = String(bodyLength);
  if (undiciRequestCreated.hasSubscribers) {
    delete headers.traceparent;
    delete headers.tracestate;
  } else {
    injectHttpHeaders(headers);
  }
  return headers;
}

/** Legacy's status and a copy of its headers with `set-cookie` as a list. */
function upstreamOf(res: FastifyReplyFromResponse): LegacyUpstream {
  const headers = { ...res.headers } as IncomingHttpHeaders;
  const setCookie: unknown = headers['set-cookie'];
  if (typeof setCookie === 'string') headers['set-cookie'] = [setCookie];
  return { statusCode: res.statusCode, headers };
}

/** Replaces the reply's `Set-Cookie` headers with `setCookies`; without them, target-primary withholds legacy's session cookies. */
function replaceSetCookies(
  reply: FastifyReply,
  sessionMode: SessionMode,
  upstream: LegacyUpstream,
  setCookies: readonly string[] | undefined,
): void {
  if (setCookies === undefined && sessionMode === 'legacy-primary') return;
  const cookies =
    setCookies ?? (upstream.headers['set-cookie'] ?? []).filter((value) => !isLegacySessionCookie(parseSetCookie(value).name));
  reply.removeHeader('set-cookie');
  if (cookies.length > 0) reply.header('set-cookie', [...cookies]);
}

/** Every byte of `stream`. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** True when `error` failed to establish the connection, so legacy never received the request. */
function neverSent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NOT_SENT_CODES.has(code);
}

/** Relay of `origin` that ends after `onEnd` resolved; destroying it leaves `origin` draining, an origin failure calls `onFail`. */
function settlingRelay(origin: Readable, onEnd: () => Promise<void>, onFail: (error: Error) => void): PassThrough {
  const relay = new PassThrough();
  // The last byte so far waits for the next chunk, so a Content-Length response completes only after `onEnd`.
  let held: Buffer = Buffer.alloc(0);
  origin.on('data', (chunk: Buffer) => {
    if (relay.destroyed || chunk.length === 0) return;
    const ready = held.length === 0 ? chunk.subarray(0, -1) : Buffer.concat([held, chunk.subarray(0, -1)]);
    held = chunk.subarray(-1);
    if (ready.length > 0 && !relay.write(ready)) origin.pause();
  });
  relay.on('drain', () => origin.resume());
  relay.on('close', () => origin.resume());
  finished(origin, (error) => {
    if (error) {
      onFail(error);
      // Without an error, so a relay nobody reads yet emits none; its readers see a premature close.
      relay.destroy();
      return;
    }
    void onEnd().then(() => {
      if (relay.destroyed) return;
      if (held.length > 0) relay.end(held);
      else relay.end();
    });
  });
  return relay;
}

/**
 * Writes legacy's status, the reply's headers and `body` to the client as they are.
 * Bypasses Fastify's send, whose onSend hooks add gateway headers and whose Buffer path adds a content type and length.
 */
function sendAsLegacy(request: FastifyRequest, reply: FastifyReply, body: Readable | Buffer): void {
  const headers: OutgoingHttpHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
  );
  // Before hijack, so a header Node rejects throws while the reply can still answer the 503.
  reply.raw.writeHead(reply.statusCode, headers);
  reply.hijack();
  if (Buffer.isBuffer(body)) {
    reply.raw.end(body);
    return;
  }
  pipeline(body, reply.raw, (error) => {
    if (error) request.log.warn({ error: serializeError(error) }, 'legacy response stream ended early');
  });
}

/** Runs a dispatcher callback; a failure is logged, never thrown, because legacy has already executed. */
async function guarded<T>(request: FastifyRequest, name: string, run: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    request.log.error({ error: serializeError(error) }, `legacy forward ${name} failed`);
    return undefined;
  }
}

/**
 * Forwards `request` to `ctx.legacyOrigin` with its original path, query and body, without a gateway timeout or retry.
 * A failure before legacy answers sends the legacy-shaped 503 of `ctx.failContext`.
 */
export async function forwardToLegacy(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: LegacyForwardContext,
): Promise<FastifyReply> {
  let settled = false;
  /** Runs `onSettled` once with `outcome`; a later call returns at once. */
  const settle = async (outcome: LegacySettlement): Promise<void> => {
    if (settled) return;
    settled = true;
    await guarded(request, 'onSettled', () => ctx.onSettled?.(outcome));
  };
  /** Logs an end after which legacy may still commit, which therefore leaves the exchange unsettled. */
  const unsettled = (error: unknown): void => {
    request.log.warn({ error: serializeError(error) }, 'legacy exchange ended uncertainly; in-flight registration kept');
  };
  /** Settlement of a request that never reached legacy, which its 503 waits for. */
  let notSentSettlement: Promise<void> | undefined;

  async function respond(res: FastifyReplyFromResponse): Promise<void> {
    // reply-from also calls onResponse after it answered an invalid upstream status through onError.
    if (reply.sent || reply.raw.headersSent) {
      res.stream.resume();
      return;
    }
    const upstream = upstreamOf(res);
    if (ctx.mode === 'stream') {
      const extra = await guarded(request, 'beforeSend', () => ctx.beforeSend?.(upstream));
      replaceSetCookies(reply, ctx.sessionMode, upstream, extra?.setCookies);
      sendAsLegacy(request, reply, res.stream);
      return;
    }
    const body = await collect(res.stream);
    const extra = await guarded(request, 'beforeSend', () => ctx.beforeSend?.(upstream));
    await guarded(request, 'onBuffered', () => ctx.onBuffered?.({ ...upstream, body }));
    replaceSetCookies(reply, ctx.sessionMode, upstream, extra?.setCookies);
    sendAsLegacy(request, reply, body);
  }

  const url = request.url;
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? '' : url.slice(queryAt + 1);
  const body = Buffer.isBuffer(request.body) ? request.body : undefined;

  const options: FastifyReplyFromHooks = {
    // The query bypasses reply-from's URL parsing and traversal check, so it reaches legacy byte for byte.
    queryString: () => query,
    ...(body === undefined ? {} : { body, contentType: request.headers['content-type'] ?? RAW_BODY_CONTENT_TYPE }),
    rewriteRequestHeaders: () => legacyRequestHeaders(request, ctx, body?.length),
    // 0 disables undici's headers and body timeouts.
    timeout: 0,
    retriesCount: 0,
    // Runs once per exchange, before reply-from may destroy the response of an aborted client; null disables retries.
    retryDelay: ({ err, res }) => {
      if (ctx.onSettled === undefined) return null;
      // Typed as the reply, but reply-from passes the upstream response here, or nothing when the exchange failed.
      const upstream = res as unknown as FastifyReplyFromResponse | undefined;
      // The same object reaches reply-from's abort check and onResponse, so both see only the relay.
      if (upstream !== undefined) upstream.stream = settlingRelay(upstream.stream, () => settle('completed'), unsettled);
      else if (neverSent(err)) notSentSettlement = settle('not-sent');
      else unsettled(err);
      return null;
    },
    onResponse: (_request, _reply, res) => {
      // No byte has reached the client before `respond` sends, so a failure here (a broken buffered body) answers the 503.
      respond(res).catch((error: unknown) => {
        request.log.error({ error: serializeError(error) }, 'legacy response failed');
        res.stream.destroy();
        failClosed(reply, ctx.failContext);
      });
    },
    onError: () => {
      // Synchronous otherwise: for an invalid status reply-from calls onResponse next, which must see the 503 sent.
      if (notSentSettlement === undefined) {
        failClosed(reply, ctx.failContext);
        return;
      }
      void notSentSettlement.then(() => {
        failClosed(reply, ctx.failContext);
      });
    },
  };

  try {
    return reply.from(`${ctx.legacyOrigin.replace(/\/+$/, '')}${path}`, options);
  } catch (error) {
    // reply-from rejects a path it cannot parse before anything is sent to legacy.
    request.log.warn({ error: serializeError(error) }, 'legacy forward rejected before sending');
    await settle('not-sent');
    return failClosed(reply, ctx.failContext);
  }
}
