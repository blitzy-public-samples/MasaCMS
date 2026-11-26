// Forwards a request to the legacy Masa origin; request and response bytes pass unchanged except the session cookie mapping.
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyReplyFromHooks, FastifyReplyFromResponse } from '@fastify/reply-from';
import type { HeaderMap } from '@opt2/platform/auth';
import { isLegacySessionCookie, parseSetCookie } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import type { FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
import { injectHttpHeaders } from '@opt2/platform/tracing';
import type { SessionMode } from '../session/mode.js';
import { LEGACY_CALLEE, replyFromCallee } from './callee-span.js';
import { failClosed, neverSent, type FailContext } from './fail-closed.js';
import { HOP_BY_HOP_HEADERS, forwardedHeaders } from './headers.js';
import { withLenientResponse } from './lenient-response.js';
import { withRequestTarget } from './request-target.js';
import { recordResponseHead, writeUpstreamHead, type RawResponseHead, type ResponseHeadSlot } from './response-head.js';
import { settlingRelay } from './settling-relay.js';

/** Legacy's status and headers; a `set-cookie` header is always a list. */
export interface LegacyUpstream {
  statusCode: number;
  headers: IncomingHttpHeaders;
}

/** Client-response change `beforeSend` asks for: `setCookies`, when defined, replaces every legacy `Set-Cookie`. */
export interface LegacyBeforeSendResult {
  setCookies?: string[];
}

/** Runs once legacy's status and headers are known, before any byte reaches the client; a rejection answers the 503 instead. */
export type LegacyBeforeSend = (upstream: LegacyUpstream) => Promise<LegacyBeforeSendResult | void>;

/** What `beforeSend` decided: the `Set-Cookie` replacement it asked for, or its rejection. */
type BeforeSendOutcome = { failed: false; setCookies: string[] | undefined } | { failed: true; error: unknown };

/** Fail-closed reason of a legacy response a rejected `beforeSend` withholds. */
const BEFORE_SEND_FAILED = 'legacy response withheld: beforeSend failed';

/** Fail-closed reason of a legacy response whose spool file failed; holdBody logged the file error. */
const SPOOL_LOST = 'legacy response withheld: response spool failed';

/** A complete legacy response held by the gateway: its status, headers and body length. */
export interface BufferedLegacyResponse extends LegacyUpstream {
  bytes: number;
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
  /** `buffer` holds the whole response, a body past 1 MiB in a request-owned file, until `beforeSend` and `onBuffered` have resolved. */
  mode: 'stream' | 'buffer';
  beforeSend?: LegacyBeforeSend;
  /**
   * Buffer mode only; called once, only for a complete body, after `onSettled` has run, also when `beforeSend` rejected,
   * the file failed, the client left before legacy's head or a status Fastify rejects answered the 503.
   */
  onBuffered?: (res: BufferedLegacyResponse) => Promise<void>;
  /** Called at most once, only when legacy can no longer commit for this exchange; never after an uncertain end. */
  onSettled?: (outcome: LegacySettlement) => Promise<void>;
  failContext: FailContext;
  /** Longest wait for legacy's head, and between its body bytes; defaults to {@link LEGACY_EXCHANGE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** True when legacy's head may hold `Location` bytes undici refuses: it is read by the lenient forward and relayed byte for byte. */
  lenientHead?: boolean;
}

/** Masa's longest request time: the 7200 s `requestTimeout` of its site import, export and publish (settingsManager.cfc:701). */
export const LEGACY_EXCHANGE_TIMEOUT_MS = 7_200_000;

/** Request headers never forwarded: hop-by-hop ones, `expect` (the gateway already answered it) and those set below. */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([...HOP_BY_HOP_HEADERS, 'expect', 'host', 'content-length']);

/** Only tells reply-from not to re-encode the body; the forwarded `content-type` is the inbound one or none. */
const RAW_BODY_CONTENT_TYPE = 'application/octet-stream';

/** True when undici refused to build the request, a target such as `*` included, so none of it reached legacy. */
function refusedBeforeSending(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'UND_ERR_INVALID_ARG';
}

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

/** Prefix of the directory that briefly names a buffered legacy body's file. */
const SPOOL_PREFIX = 'opt2-legacy-response-';

/** Body bytes buffer mode holds in memory; a longer body moves to a request-owned file. */
const HELD_BODY_MEMORY_BYTES = 1024 * 1024;

/** A legacy body read to its end, `bytes` long: in memory, in a spool file, or `lost` once its spool failed. */
type HeldBody =
  | { bytes: number; kind: 'memory'; data: Buffer }
  | { bytes: number; kind: 'file'; handle: FileHandle }
  | { bytes: number; kind: 'lost' };

/** Opens a new owner-only file under the OS temporary directory and removes its name, so only the handle holds it. */
async function openSpool(): Promise<FileHandle> {
  const dir = await mkdtemp(join(tmpdir(), SPOOL_PREFIX));
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(dir, 'body'), 'wx+', 0o600);
    await rm(dir, { recursive: true });
    return handle;
  } catch (error) {
    await handle?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Closes a spool `handle`; a failure is logged, never thrown. */
async function closeSpool(request: FastifyRequest, handle: FileHandle | undefined): Promise<void> {
  await guarded(request, 'response spool close', () => handle?.close());
}

/**
 * Reads `stream` to its end, in memory up to HELD_BODY_MEMORY_BYTES and in a spool file past it; rejects, with the file
 * closed, only when `stream` fails. A spool that cannot be opened or written is logged and dropped, and `stream` is
 * still read to its end, so legacy's completion is reported.
 */
async function holdBody(request: FastifyRequest, stream: Readable): Promise<HeldBody> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let handle: FileHandle | undefined;
  let lost = false;
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += data.length;
      if (lost) continue;
      if (handle === undefined && bytes <= HELD_BODY_MEMORY_BYTES) {
        chunks.push(data);
        continue;
      }
      try {
        if (handle === undefined) {
          handle = await openSpool();
          await handle.writeFile(Buffer.concat(chunks));
          chunks = [];
        }
        await handle.writeFile(data);
      } catch (error) {
        request.log.error({ error: serializeError(error) }, 'legacy forward response spool failed');
        await closeSpool(request, handle);
        handle = undefined;
        chunks = [];
        lost = true;
      }
    }
  } catch (error) {
    await closeSpool(request, handle);
    throw error;
  }
  if (lost) return { bytes, kind: 'lost' };
  return handle === undefined ? { bytes, kind: 'memory', data: Buffer.concat(chunks) } : { bytes, kind: 'file', handle };
}

/** The error Node's stream utilities report for a stream that closed before it ended. */
function prematureClose(): Error {
  return Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
}

/**
 * Pipes `body` to `res` as pipeline does, with two `close` listeners on `res` where pipeline adds seven.
 * A client gone first destroys `body`, a failed or cut `body` destroys `res`, and either end is logged once.
 */
function streamToClient(request: FastifyRequest, res: ServerResponse, body: Readable): void {
  let failed = false;
  let finished = false;
  const fail = (error: Error): void => {
    if (failed) return;
    failed = true;
    request.log.warn({ error: serializeError(error) }, 'legacy response stream ended early');
    body.destroy();
    res.destroy(error);
  };
  body.on('error', fail);
  body.once('close', () => {
    if (!body.readableEnded) fail(prematureClose());
  });
  res.on('error', fail);
  // 'finish', not writableFinished, which stays false while the socket still holds the last bytes.
  res.once('finish', () => {
    finished = true;
  });
  res.once('close', () => {
    if (!finished) fail(prematureClose());
  });
  // Either side may have closed while beforeSend ran, before these listeners existed.
  if (body.destroyed) fail(body.errored ?? prematureClose());
  else if (res.destroyed) fail(prematureClose());
  else body.pipe(res);
}

/**
 * Writes legacy's status, the reply's headers and `body` to the client as they are; with legacy's recorded `head`, in its
 * reason phrase, header order and spelling. `received` is reply-from's parsed copy of legacy's headers.
 * Bypasses Fastify's send, whose onSend hooks add gateway headers and whose Buffer path adds a content type and length.
 */
function sendAsLegacy(
  request: FastifyRequest,
  reply: FastifyReply,
  body: Readable | Buffer,
  head: RawResponseHead | undefined,
  received: IncomingHttpHeaders,
): void {
  const headers: OutgoingHttpHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
  );
  // Before hijack, so a header Node rejects throws while the reply can still answer the 503.
  if (head === undefined) reply.raw.writeHead(reply.statusCode, headers);
  else writeUpstreamHead(reply.raw, reply.statusCode, head, received, headers);
  reply.hijack();
  if (Buffer.isBuffer(body)) {
    reply.raw.end(body);
    return;
  }
  streamToClient(request, reply.raw, body);
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
 * Forwards `request` to `ctx.legacyOrigin` with its original path, query and body, within `ctx.timeoutMs` and without retry.
 * A failure before legacy answers, or a rejected `beforeSend`, sends the legacy-shaped 503 of `ctx.failContext`.
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
  /** Legacy's final response head as sent, recorded by reply-from's dispatcher when it is the gateway's. */
  const legacyHead: ResponseHeadSlot = {};
  /** Set once `respond` holds legacy's body in buffer mode, so `respond`, not legacy's completion, reports it. */
  let respondReports = false;

  /**
   * Settles a completed exchange, then reports legacy's response and the `bytes` it sent when buffer mode's `respond` will
   * not: reply-from skips it for an aborted client, and it skips a reply already answered for a status Fastify rejects.
   */
  async function complete(res: FastifyReplyFromResponse, bytes: number): Promise<void> {
    await settle('completed');
    if (ctx.mode !== 'buffer' || respondReports) return;
    await guarded(request, 'onBuffered', () => ctx.onBuffered?.({ ...upstreamOf(res), bytes }));
  }

  /** Runs `beforeSend`; a rejection is reported, so legacy's response does not leave. */
  async function runBeforeSend(upstream: LegacyUpstream): Promise<BeforeSendOutcome> {
    try {
      const extra = await ctx.beforeSend?.(upstream);
      return { failed: false, setCookies: extra?.setCookies };
    } catch (error) {
      return { failed: true, error };
    }
  }

  async function respond(res: FastifyReplyFromResponse): Promise<void> {
    // reply-from also calls onResponse after it answered an invalid upstream status through onError.
    if (reply.sent || reply.raw.headersSent) {
      res.stream.resume();
      return;
    }
    const upstream = upstreamOf(res);
    const received = res.headers as IncomingHttpHeaders;
    if (ctx.mode === 'stream') {
      const before = await runBeforeSend(upstream);
      if (before.failed) {
        // Drained rather than destroyed, so the exchange still settles once legacy's response has ended.
        res.stream.resume();
        failClosed(reply, ctx.failContext, { reason: BEFORE_SEND_FAILED, error: before.error });
        return;
      }
      replaceSetCookies(reply, ctx.sessionMode, upstream, before.setCookies);
      sendAsLegacy(request, reply, res.stream, legacyHead.head, received);
      return;
    }
    respondReports = true;
    const held = await holdBody(request, res.stream);
    let fromFile: Readable | undefined;
    try {
      const before = await runBeforeSend(upstream);
      // Legacy executed whether or not its response may leave, so the buffered response is reported either way.
      await guarded(request, 'onBuffered', () => ctx.onBuffered?.({ ...upstream, bytes: held.bytes }));
      if (before.failed) {
        failClosed(reply, ctx.failContext, { reason: BEFORE_SEND_FAILED, error: before.error });
        return;
      }
      if (held.kind === 'lost') {
        failClosed(reply, ctx.failContext, { reason: SPOOL_LOST });
        return;
      }
      replaceSetCookies(reply, ctx.sessionMode, upstream, before.setCookies);
      if (held.kind === 'memory') {
        sendAsLegacy(request, reply, held.data, legacyHead.head, received);
        return;
      }
      // Closes the handle once it ends or is destroyed, whichever side ends the send.
      fromFile = held.handle.createReadStream({ start: 0 });
      sendAsLegacy(request, reply, fromFile, legacyHead.head, received);
    } catch (error) {
      fromFile?.destroy();
      throw error;
    } finally {
      if (fromFile === undefined && held.kind === 'file') await closeSpool(request, held.handle);
    }
  }

  const body = Buffer.isBuffer(request.body) ? request.body : undefined;

  const options: FastifyReplyFromHooks = {
    // reply-from JSON-encodes a body sent under an empty content type, so an empty inbound one takes the raw one too.
    ...(body === undefined ? {} : { body, contentType: request.headers['content-type'] || RAW_BODY_CONTENT_TYPE }),
    rewriteRequestHeaders: () => legacyRequestHeaders(request, ctx, body?.length),
    // undici's headers and body timeouts; an expiry ends the exchange uncertainly, so it answers the 503 unsettled.
    timeout: ctx.timeoutMs ?? LEGACY_EXCHANGE_TIMEOUT_MS,
    retriesCount: 0,
    // Runs once per exchange, before reply-from may destroy the response of an aborted client; null disables retries.
    retryDelay: ({ err, res }) => {
      if (ctx.onSettled === undefined) return null;
      // Typed as the reply, but reply-from passes the upstream response here, or nothing when the exchange failed.
      const upstream = res as unknown as FastifyReplyFromResponse | undefined;
      if (upstream !== undefined) {
        let sent = 0;
        // Buffer mode counts legacy's bytes, which a relay reply-from destroyed for an aborted client no longer carries.
        if (ctx.mode === 'buffer') {
          upstream.stream.on('data', (chunk: Buffer) => {
            sent += chunk.length;
          });
        }
        // The same object reaches reply-from's abort check and onResponse, so both see only the relay.
        upstream.stream = settlingRelay(upstream.stream, () => complete(upstream, sent), unsettled);
      } else if (neverSent(err) || refusedBeforeSending(err)) notSentSettlement = settle('not-sent');
      else unsettled(err);
      return null;
    },
    onResponse: (_request, _reply, res) => {
      // No byte has reached the client before `respond` sends, so a failure here (a broken buffered body) answers the 503.
      respond(res).catch((error: unknown) => {
        res.stream.destroy();
        failClosed(reply, ctx.failContext, { reason: 'legacy response failed', error });
      });
    },
    onError: (_reply, { error }) => {
      const cause = { reason: 'legacy unavailable', error };
      // Synchronous otherwise: for an invalid status reply-from calls onResponse next, which must see the 503 sent.
      if (notSentSettlement === undefined) {
        failClosed(reply, ctx.failContext, cause);
        return;
      }
      void notSentSettlement.then(() => {
        failClosed(reply, ctx.failContext, cause);
      });
    },
  };

  let forwarded: FastifyReply;
  const send = (): FastifyReply => replyFromCallee(reply, LEGACY_CALLEE, ctx.legacyOrigin, options);
  try {
    // reply-from resolves only the origin; the gateway's agent (replyFromOptions) sends request.url as received in its place.
    forwarded = withRequestTarget(request.url, () =>
      recordResponseHead(legacyHead, () => (ctx.lenientHead === true ? withLenientResponse(send) : send())),
    );
  } catch (error) {
    // A synchronous reply-from rejection comes before anything is sent to legacy.
    await settle('not-sent');
    return failClosed(reply, ctx.failContext, { reason: 'forward to legacy rejected before sending', error, level: 'warn' });
  }
  return forwarded;
}
