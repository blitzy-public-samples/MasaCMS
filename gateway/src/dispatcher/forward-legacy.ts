// Forwards a request to the legacy Masa origin; request and response bytes pass unchanged except the session cookie mapping.
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { finished, pipeline, type Readable } from 'node:stream';
import type { FastifyReplyFromHooks, FastifyReplyFromResponse } from '@fastify/reply-from';
import type { HeaderMap } from '@opt2/platform/auth';
import type { FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
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

/** Inputs of one forward to legacy. */
export interface LegacyForwardContext {
  /** Legacy origin, e.g. `http://127.0.0.1:8080`. */
  legacyOrigin: string;
  /** Inbound headers as dispatch stripped them for legacy. */
  headers: HeaderMap;
  /** `Cookie` legacy receives in place of the inbound one; '' sends none, undefined keeps the inbound one. */
  cookieHeader?: string;
  /** `buffer` holds the whole response until `beforeSend` and `onBuffered` have resolved. */
  mode: 'stream' | 'buffer';
  beforeSend?: LegacyBeforeSend;
  /** Buffer mode only; called only for a complete body. */
  onBuffered?: (res: BufferedLegacyResponse) => Promise<void>;
  /** Called exactly once: when legacy's response ended or failed, or when the exchange failed before a response. */
  onSettled?: () => Promise<void>;
  failContext: FailContext;
}

/** Request headers never forwarded: hop-by-hop ones, `expect` (the gateway already answered it) and those set below. */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([...HOP_BY_HOP_HEADERS, 'expect', 'host', 'content-length']);

/** Only tells reply-from not to re-encode the body; the forwarded `content-type` is the inbound one or none. */
const RAW_BODY_CONTENT_TYPE = 'application/octet-stream';

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

/** Headers legacy receives: the stripped inbound ones, the inbound `Host`, `X-Forwarded-*` and the mapped `Cookie`. */
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
  return headers;
}

/** Legacy's status and a copy of its headers with `set-cookie` as a list. */
function upstreamOf(res: FastifyReplyFromResponse): LegacyUpstream {
  const headers = { ...res.headers } as IncomingHttpHeaders;
  const setCookie: unknown = headers['set-cookie'];
  if (typeof setCookie === 'string') headers['set-cookie'] = [setCookie];
  return { statusCode: res.statusCode, headers };
}

/** Replaces the reply's `Set-Cookie` headers with `setCookies` when it is defined. */
function replaceSetCookies(reply: FastifyReply, setCookies: readonly string[] | undefined): void {
  if (setCookies === undefined) return;
  reply.removeHeader('set-cookie');
  if (setCookies.length > 0) reply.header('set-cookie', [...setCookies]);
}

/** Every byte of `stream`. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
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
    if (error) request.log.warn({ error }, 'legacy response stream ended early');
  });
}

/** Runs a dispatcher callback; a failure is logged, never thrown, because legacy has already executed. */
async function guarded<T>(request: FastifyRequest, name: string, run: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    request.log.error({ error }, `legacy forward ${name} failed`);
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
  const settle = (): void => {
    if (settled) return;
    settled = true;
    void guarded(request, 'onSettled', () => ctx.onSettled?.());
  };

  async function respond(res: FastifyReplyFromResponse): Promise<void> {
    // reply-from also calls onResponse after it answered an invalid upstream status through onError.
    if (reply.sent || reply.raw.headersSent) {
      res.stream.resume();
      return;
    }
    const upstream = upstreamOf(res);
    if (ctx.mode === 'stream') {
      const extra = await guarded(request, 'beforeSend', () => ctx.beforeSend?.(upstream));
      replaceSetCookies(reply, extra?.setCookies);
      sendAsLegacy(request, reply, res.stream);
      return;
    }
    const body = await collect(res.stream);
    const extra = await guarded(request, 'beforeSend', () => ctx.beforeSend?.(upstream));
    await guarded(request, 'onBuffered', () => ctx.onBuffered?.({ ...upstream, body }));
    replaceSetCookies(reply, extra?.setCookies);
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
    retryDelay: ({ res }) => {
      // Typed as the reply, but reply-from passes the upstream response here, or nothing when the exchange failed.
      const upstream = res as unknown as FastifyReplyFromResponse | undefined;
      if (upstream?.stream === undefined) settle();
      else finished(upstream.stream, () => settle());
      return null;
    },
    onResponse: (_request, _reply, res) => {
      // No byte has reached the client before `respond` sends, so a failure here (a broken buffered body) answers the 503.
      respond(res).catch((error: unknown) => {
        request.log.error({ error }, 'legacy response failed');
        res.stream.destroy();
        failClosed(reply, ctx.failContext);
      });
    },
    onError: () => {
      failClosed(reply, ctx.failContext);
    },
  };

  try {
    return reply.from(`${ctx.legacyOrigin.replace(/\/+$/, '')}${path}`, options);
  } catch (error) {
    // reply-from rejects a path it cannot parse before anything is sent to legacy.
    request.log.warn({ error }, 'legacy forward rejected before sending');
    settle();
    return failClosed(reply, ctx.failContext);
  }
}
