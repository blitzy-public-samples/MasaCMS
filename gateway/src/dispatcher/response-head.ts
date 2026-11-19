// Records an upstream's final response head as it was sent, and writes it to the client in its reason phrase, header order and spelling.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  validateHeaderName,
  validateHeaderValue,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { FastifyReplyFromOptions } from '@fastify/reply-from';
import { Agent, SERVICE_MAX_HEADER_SIZE, type Dispatcher } from '@opt2/platform/service-kit';
import { lenientResponse } from './lenient-response.js';
import { sendRequestTarget } from './request-target.js';

/** A final response head as received: status, reason phrase and header lines in wire order, each value's bytes read as latin1. */
export interface RawResponseHead {
  statusCode: number;
  statusMessage: string;
  /** Flat list: name, value, name, value, ... */
  lines: string[];
}

/** Receives the final head of the first request dispatched while it is current. */
export interface ResponseHeadSlot {
  head?: RawResponseHead;
}

const currentSlot = new AsyncLocalStorage<ResponseHeadSlot>();
const claimedSlots = new WeakSet<ResponseHeadSlot>();

/** `Transfer-Encoding` values whose final coding is chunked. */
const CHUNKED_LAST = /(?:^|,)\s*chunked\s*$/i;

/** A `Connection` value with the `close` option, matched as Node matches it. */
const CONNECTION_CLOSE = /(?:^|\W)close(?:$|\W)/i;

/** undici's raw header list as latin1 strings; undefined when it exposes none. */
function latin1Lines(raw: Dispatcher.DispatchController['rawHeaders']): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Array<Buffer | string>).map((item) => (typeof item === 'string' ? item : item.toString('latin1')));
}

/** `handler` with every callback passed through, the first final head recorded into `slot` before it is handed on. */
function recording(handler: Dispatcher.DispatchHandler, slot: ResponseHeadSlot): Dispatcher.DispatchHandler {
  return {
    onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
    onRequestUpgrade: (controller, statusCode, headers, socket) => handler.onRequestUpgrade?.(controller, statusCode, headers, socket),
    onResponseStart: (controller, statusCode, headers, statusMessage) => {
      const lines = latin1Lines(controller.rawHeaders);
      if (slot.head === undefined && statusCode >= 200 && lines !== undefined) {
        slot.head = { statusCode, statusMessage: statusMessage ?? '', lines };
      }
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
    onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
  };
}

/** Records the head of the first request dispatched under a slot, a HEAD kept on a persistent connection; requests outside one pass untouched. */
const recordHead: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
  const slot = currentSlot.getStore();
  if (slot === undefined || claimedSlots.has(slot)) return dispatch(options, handler);
  claimedSlots.add(slot);
  // undici otherwise sends every HEAD as `connection: close`, which legacy answers as a closing client's.
  return dispatch(options.method === 'HEAD' ? { ...options, reset: false } : options, recording(handler, slot));
};

/** Runs `forward` with `slot` current; reply-from dispatches synchronously inside it, so the forward's final head lands in `slot`. */
export function recordResponseHead<T>(slot: ResponseHeadSlot, forward: () => T): T {
  return currentSlot.run(slot, forward);
}

/**
 * reply-from options of every forward: reply-from's own agent defaults, the lenient parser a forward may ask for, the head
 * recorder, the raw request target, and a response-head limit that admits legacy echoing a request head of its limit (a
 * redirect's `Location`); the agent is destroyed on close.
 * reply-from's per-forward info lines are off, so each request logs only the service kit's request line.
 */
export function replyFromOptions(): FastifyReplyFromOptions {
  const agent = new Agent({ pipelining: 1, connections: 128, maxHeaderSize: SERVICE_MAX_HEADER_SIZE });
  // reply-from types `undici` against its own undici copy, but calls only `request(options, callback)` and `destroy()` on it.
  return {
    undici: agent.compose(lenientResponse, recordHead, sendRequestTarget) as FastifyReplyFromOptions['undici'],
    destroyAgent: true,
    disableRequestLogging: true,
  };
}

/** Whether `current` holds exactly the values reply-from copied from `received`. */
function sameValues(current: number | string | readonly string[], received: string | string[] | undefined): boolean {
  if (received === undefined) return false;
  const now = [current].flat().map(String);
  const then = [received].flat();
  return now.length === then.length && now.every((value, index) => value === then[index]);
}

/**
 * Whether the client connection ends after this response: the client asked to, legacy answered `Connection: close`, the
 * gateway did (reply-from for an unread request body, Fastify while closing), or a body without a length could only be close-delimited.
 */
function clientCloses(
  res: ServerResponse,
  statusCode: number,
  received: IncomingHttpHeaders,
  headers: OutgoingHttpHeaders,
): boolean {
  const replied = headers.connection;
  const gatewaySet = [res.getHeader('connection'), replied === undefined || sameValues(replied, received.connection) ? undefined : replied];
  // Legacy frames an answer to HEAD as one with a body, whatever its status.
  const bodiless = res.req.method !== 'HEAD' && (statusCode === 204 || statusCode === 304);
  const closeDelimited = headers['content-length'] === undefined && !res.useChunkedEncodingByDefault && !bodiless;
  return (
    !res.shouldKeepAlive ||
    closeDelimited ||
    [received.connection, ...gatewaySet].some((value) => value !== undefined && CONNECTION_CLOSE.test(String(value)))
  );
}

/**
 * The client's header lines in the upstream's order and spelling: a header the reply kept as received keeps its received lines,
 * a changed one gets its new values at its first received line, a removed one is dropped and an added one is appended.
 * `Connection` keeps only its first line, valued `connection`; the upstream's chunked `Transfer-Encoding` stays only when
 * the client response is chunked too.
 * @param received reply-from's parsed copy of the head, against which the reply's `headers` count as kept or changed
 */
function upstreamHeaderLines(
  head: RawResponseHead,
  received: IncomingHttpHeaders,
  headers: OutgoingHttpHeaders,
  connection: 'close' | 'keep-alive',
  chunked: boolean,
): string[] {
  const reply = new Map(
    Object.entries(headers).filter((entry): entry is [string, number | string | string[]] => entry[1] !== undefined),
  );
  const lines: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < head.lines.length; index += 2) {
    const name = head.lines[index] as string;
    const value = head.lines[index + 1] as string;
    const key = name.toLowerCase();
    const first = !seen.has(key);
    seen.add(key);
    const current = reply.get(key);
    if (key === 'connection') {
      if (first) lines.push(name, connection);
    } else if (key === 'transfer-encoding') {
      if (chunked && !reply.has('content-length') && CHUNKED_LAST.test(value)) lines.push(name, value);
    } else if (current === undefined) {
      continue;
    } else if (sameValues(current, Object.hasOwn(received, key) ? received[key] : undefined)) {
      lines.push(name, value);
    } else if (first) {
      for (const item of [current].flat()) lines.push(name, String(item));
    }
  }
  for (const [key, current] of reply) {
    if (!seen.has(key) && key !== 'connection') for (const item of [current].flat()) lines.push(key, String(item));
  }
  return lines;
}

/**
 * `head`'s reason phrase as the client response writes it while `statusCode` is its status, else undefined.
 * Throws as `writeHead` does for a phrase it rejects.
 */
export function upstreamReasonPhrase(head: RawResponseHead, statusCode: number): string | undefined {
  if (statusCode !== head.statusCode) return undefined;
  // undici decodes the reason phrase as UTF-8; re-encoded, Node's latin1 write restores the upstream's bytes.
  const reason = Buffer.from(head.statusMessage, 'utf8').toString('latin1');
  validateHeaderValue('statusMessage', reason);
  return reason;
}

/** Whether `name: value` is a line of `head` as received, the name compared without case. */
function isUpstreamLine(head: RawResponseHead, name: string, value: string): boolean {
  const key = name.toLowerCase();
  for (let index = 0; index + 1 < head.lines.length; index += 2) {
    if ((head.lines[index] as string).toLowerCase() === key && head.lines[index + 1] === value) return true;
  }
  return false;
}

/**
 * `lines` with each upstream value Node rejects, as a lenient parser reads one, swapped for a placeholder `writeHead` takes,
 * and the raw line each placeholder line stands for; any other value Node rejects throws as `writeHead` does.
 */
function rawUpstreamLines(head: RawResponseHead, lines: readonly string[]): { lines: string[]; raw: Map<string, string> } {
  const out = [...lines];
  const raw = new Map<string, string>();
  for (let index = 0; index + 1 < out.length; index += 2) {
    const name = out[index] as string;
    const value = out[index + 1] as string;
    validateHeaderName(name);
    try {
      validateHeaderValue(name, value);
    } catch (error) {
      if (!isUpstreamLine(head, name, value)) throw error;
      const placeholder = `opt2-raw-${randomUUID()}`;
      out[index + 1] = placeholder;
      raw.set(`${name}: ${placeholder}\r\n`, `${name}: ${value}\r\n`);
    }
  }
  return { lines: out, raw };
}

/**
 * Writes the response head from `head`: its reason phrase while `statusCode` is its status, {@link upstreamHeaderLines},
 * no Date the upstream did not send, the client's HTTP/1.0 or HTTP/1.1, and `Connection` and framing for the client
 * connection, which, when it closes, gets a close-delimited body in place of a chunked one. An upstream value Node
 * refuses to write, which only a lenient parser reads, is written byte for byte. Throws as `writeHead` does, leaving
 * `res` able to send another head.
 */
export function writeUpstreamHead(
  res: ServerResponse,
  statusCode: number,
  head: RawResponseHead,
  received: IncomingHttpHeaders,
  headers: OutgoingHttpHeaders,
): void {
  const closes = clientCloses(res, statusCode, received, headers);
  const upstreamLines = upstreamHeaderLines(head, received, headers, closes ? 'close' : 'keep-alive', !closes && res.useChunkedEncodingByDefault);
  // writeHead's own checks, ahead of the state changes below, which Node offers no way to undo.
  const reason = upstreamReasonPhrase(head, statusCode);
  const { lines, raw } = rawUpstreamLines(head, upstreamLines);
  res.sendDate = false;
  res.shouldKeepAlive = !closes;
  // Without the upstream's line Node writes none, and keeps or closes the connection by shouldKeepAlive.
  if (!lines.some((item, index) => index % 2 === 0 && item.toLowerCase() === 'connection')) res.removeHeader('connection');
  // Without a chunked coding, Node delimits a body of unknown length by closing.
  if (closes && headers['content-length'] === undefined) res.removeHeader('transfer-encoding');
  res.writeHead(statusCode, reason, lines);
  // Node stores the head as text, unsent until the first body write, and writes it as latin1, one byte per character.
  const stored = res as ServerResponse & { _header?: unknown };
  if (typeof stored._header === 'string' && raw.size > 0) {
    let text = stored._header;
    for (const [placeholder, line] of raw) text = text.replace(placeholder, () => line);
    stored._header = text;
  }
  // Node stores only HTTP/1.1 status lines; legacy answers HTTP/1.0 in HTTP/1.0.
  if (res.req.httpVersion === '1.0' && typeof stored._header === 'string' && stored._header.startsWith('HTTP/1.1 ')) {
    stored._header = `HTTP/1.0 ${stored._header.slice('HTTP/1.1 '.length)}`;
  }
}
