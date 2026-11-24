// Sends one forward through Node's HTTP client and strict parser, for an upstream `Location` whose bytes undici's parser refuses: those bytes are escaped on the way in and restored once parsed.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Duplex, type Readable } from 'node:stream';
import { SERVICE_MAX_HEADER_SIZE, type Dispatcher } from '@opt2/platform/service-kit';

/** A forward that asked for the lenient parser, until its dispatch takes it. */
interface PendingLenient {
  claimed: boolean;
}

const pendingLenient = new AsyncLocalStorage<PendingLenient>();

/** Node's client refused to build the request, so none of it was sent; coded as undici codes an argument it refuses. */
export class LenientRequestRefusedError extends Error {
  override readonly name: string = 'LenientRequestRefusedError';
  readonly code = 'UND_ERR_INVALID_ARG';
}

/** An upstream that sent no head, or no next body byte, within the forward's bound; coded as undici codes each. */
class LenientTimeoutError extends Error {
  override readonly name: string = 'LenientTimeoutError';

  constructor(readonly code: 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT') {
    super(code === 'UND_ERR_HEADERS_TIMEOUT' ? 'Headers Timeout Error' : 'Body Timeout Error');
  }
}

/** A dispatch after its dispatcher closed or was destroyed; coded as undici codes each. */
class LenientEndedError extends Error {
  override readonly name: string = 'LenientEndedError';

  constructor(readonly code: 'UND_ERR_CLOSED' | 'UND_ERR_DESTROYED') {
    super(code === 'UND_ERR_CLOSED' ? 'The client is closed' : 'The client is destroyed');
  }
}

/** Whether `value`, read as latin1, is in the form legacy's login redirect sends a `Location` in: any byte but CR and LF. */
export function isLegacyLocationValue(value: string): boolean {
  return /^[^\r\n\u0100-\uffff]*$/.test(value);
}

const CR = 0x0d;
const LF = 0x0a;
/** Leads each escaped `Location` byte, which follows XOR {@link ESCAPE_MASK}; escaped itself, so restoring is exact. */
const ESCAPE = 0xff;
const ESCAPE_MASK = 0x40;
const LOCATION_PREFIX_LENGTH = 'location:'.length;

/** Whether a `Location` value byte is escaped: the escape byte, DEL, and each C0 control but TAB, LF and CR, which the strict parser refuses. */
function escaped(byte: number): boolean {
  return byte === ESCAPE || byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== LF && byte !== CR);
}

/** One head line, ended by its LF, with each escaped byte of a `Location` value escaped; any other line unchanged. */
function escapeLine(line: Buffer): Buffer {
  if (line.toString('latin1', 0, LOCATION_PREFIX_LENGTH).toLowerCase() !== 'location:') return line;
  let count = 0;
  for (let at = LOCATION_PREFIX_LENGTH; at < line.length; at += 1) if (escaped(line[at] as number)) count += 1;
  if (count === 0) return line;
  const out = Buffer.allocUnsafe(line.length + count);
  let to = line.copy(out, 0, 0, LOCATION_PREFIX_LENGTH);
  for (let at = LOCATION_PREFIX_LENGTH; at < line.length; at += 1) {
    const byte = line[at] as number;
    if (escaped(byte)) {
      out[to] = ESCAPE;
      out[to + 1] = byte ^ ESCAPE_MASK;
      to += 2;
    } else {
      out[to] = byte;
      to += 1;
    }
  }
  return out;
}

/** A `Location` value as Node's parser read it, read as latin1, its escaped bytes restored. */
function restoreLocation(value: string): string {
  return value.replace(/\u00ff(.)/gs, (_pair, byte: string) => String.fromCharCode(byte.charCodeAt(0) ^ ESCAPE_MASK));
}

/**
 * A connection whose inbound bytes reach Node's parser with each response head's `Location` values escaped, line by line;
 * the bytes after the final head, and a line longer than the head limit, pass unchanged.
 */
class LocationEscaping extends Duplex {
  /** The current head line's bytes before its LF. */
  #held: Buffer[] = [];
  #heldLength = 0;
  #inHeads = true;
  #atStatusLine = true;
  /** Whether the current head is a 1xx one Node reads past to the next head. */
  #informational = false;
  #upstreamEnded = false;

  constructor(private readonly socket: Duplex) {
    super({ allowHalfOpen: false });
    socket.on('data', (chunk: Buffer) => {
      const bytes = this.#inbound(chunk);
      if (bytes.length > 0 && !this.push(bytes)) socket.pause();
    });
    socket.on('end', () => {
      this.#upstreamEnded = true;
      if (this.#heldLength > 0) this.push(Buffer.concat(this.#held));
      this.push(null);
    });
    socket.on('error', (error: Error) => this.destroy(error));
    socket.on('close', () => {
      if (!this.#upstreamEnded) this.destroy();
    });
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.socket.writable) this.socket.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    callback(error);
  }

  /** Ends the connection once its writes are flushed, as Node's client ends a socket it does not keep. */
  destroySoon(): void {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once('finish', () => this.destroy());
  }

  /** `chunk` as Node's parser gets it: each head line it ends escaped, a line it leaves open held. */
  #inbound(chunk: Buffer): Buffer {
    if (!this.#inHeads) return chunk;
    const out: Buffer[] = [];
    let start = 0;
    for (let end = chunk.indexOf(LF); end >= 0 && this.#inHeads; end = chunk.indexOf(LF, start)) {
      const tail = chunk.subarray(start, end + 1);
      out.push(this.#line(this.#heldLength === 0 ? tail : Buffer.concat([...this.#held, tail])));
      this.#held = [];
      this.#heldLength = 0;
      start = end + 1;
    }
    const rest = chunk.subarray(start);
    if (!this.#inHeads) {
      out.push(rest);
    } else if (this.#heldLength + rest.length > SERVICE_MAX_HEADER_SIZE) {
      // Passed on unchanged, for Node's parser to refuse as a head over its limit.
      out.push(Buffer.concat(this.#held), rest);
      this.#held = [];
      this.#heldLength = 0;
      this.#inHeads = false;
    } else if (rest.length > 0) {
      this.#held.push(rest);
      this.#heldLength += rest.length;
    }
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out);
  }

  /** One head line as Node's parser gets it, noting where its head ends and whether another head follows. */
  #line(line: Buffer): Buffer {
    if (this.#atStatusLine) {
      this.#atStatusLine = false;
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(line.toString('latin1', 0, 12))?.[1]);
      // Node reads past each 1xx head but 101's.
      this.#informational = status >= 100 && status < 200 && status !== 101;
      return line;
    }
    if (line.length === 1 || (line.length === 2 && line[0] === CR)) {
      if (this.#informational) this.#atStatusLine = true;
      else this.#inHeads = false;
      return line;
    }
    return escapeLine(line);
  }
}

/** An agent of one exchange, its connection's `Location` bytes escaped. */
class EscapingHttpAgent extends HttpAgent {
  override createConnection(...args: Parameters<HttpAgent['createConnection']>): Duplex | null | undefined {
    const socket = super.createConnection(...args);
    return socket && new LocationEscaping(socket);
  }
}

/** An HTTPS agent of one exchange, its connection's `Location` bytes escaped once Node's TLS has read them. */
class EscapingHttpsAgent extends HttpsAgent {
  override createConnection(...args: Parameters<HttpsAgent['createConnection']>): Duplex | null | undefined {
    const socket = super.createConnection(...args);
    return socket && new LocationEscaping(socket);
  }
}

/** The controller undici's handlers expect, over one Node exchange. */
class LenientController implements Dispatcher.DispatchController {
  rawHeaders: Buffer[] | null = null;
  rawTrailers: Buffer[] | null = null;
  #aborted = false;
  #paused = false;
  #reason: Error | null = null;

  constructor(
    private readonly onAbort: (reason: Error) => void,
    private readonly onFlow: (paused: boolean) => void,
  ) {}

  get aborted(): boolean {
    return this.#aborted;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get reason(): Error | null {
    return this.#reason;
  }

  abort(reason: Error): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason;
    this.onAbort(reason);
  }

  pause(): void {
    this.#paused = true;
    this.onFlow(true);
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.onFlow(false);
  }
}

/** Node's raw header list, read as latin1 by its parser, as the bytes it received. */
function rawBuffers(lines: readonly string[]): Buffer[] {
  return lines.map((line) => Buffer.from(line, 'latin1'));
}

/** `lines` parsed as undici parses a head: lower-cased names, latin1 values, a repeated name as a list in order. */
function parsedHeaders(lines: readonly string[]): IncomingHttpHeaders {
  const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const name = (lines[index] as string).toLowerCase();
    const value = lines[index + 1] as string;
    const held = headers[name];
    headers[name] = held === undefined ? value : [held, value].flat();
  }
  return { ...headers };
}

/** Methods undici frames without a body as `content-length: 0`. */
const PAYLOAD_METHODS: ReadonlySet<string> = new Set(['PUT', 'POST', 'PATCH', 'QUERY', 'PROPFIND', 'PROPPATCH']);

/** Request header names undici writes itself rather than as given. */
const UNDICI_WRITTEN = new Set(['host', 'connection', 'content-length']);

/** Request header names undici refuses. */
const UNDICI_REFUSED = new Set(['transfer-encoding', 'keep-alive', 'upgrade', 'expect']);

/**
 * The request's header lines as undici writes them, so legacy answers as it answers undici: `host`, then `connection`
 * (`close` for a reset or a given `close`, else `keep-alive`), then the given lines in order, then the body's framing.
 * Throws for a header undici refuses.
 */
function requestLines(options: Dispatcher.DispatchOptions, url: URL): string[] {
  const given: string[] = [];
  const add = (name: string, value: string | number | readonly string[] | undefined): void => {
    if (value !== undefined) for (const item of [value].flat()) given.push(name, String(item));
  };
  const { headers, body, method } = options;
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) add(headers[index] as string, headers[index + 1] as string);
  } else if (headers !== undefined && headers !== null && Symbol.iterator in headers) {
    for (const [name, value] of headers as Iterable<[string, string | string[] | undefined]>) add(name, value);
  } else if (headers !== undefined && headers !== null) {
    for (const [name, value] of Object.entries(headers)) add(name, value);
  }
  const valueOf = (name: string): string | undefined => {
    const at = given.findIndex((item, index) => index % 2 === 0 && item.toLowerCase() === name);
    return at < 0 ? undefined : given[at + 1];
  };
  for (let index = 0; index < given.length; index += 2) {
    const name = (given[index] as string).toLowerCase();
    const value = (given[index + 1] as string).toLowerCase();
    if (UNDICI_REFUSED.has(name) || (name === 'connection' && value !== 'close' && value !== 'keep-alive')) throw new Error(`invalid ${name} header`);
  }
  const closes = options.reset === true || valueOf('connection')?.toLowerCase() === 'close';
  const lines = ['host', valueOf('host') ?? url.host, 'connection', closes ? 'close' : 'keep-alive'];
  for (let index = 0; index + 1 < given.length; index += 2) {
    if (!UNDICI_WRITTEN.has((given[index] as string).toLowerCase())) lines.push(given[index] as string, given[index + 1] as string);
  }
  const length = valueOf('content-length');
  if (length !== undefined) lines.push('content-length', length);
  else if (typeof body === 'string') lines.push('content-length', String(Buffer.byteLength(body)));
  else if (body instanceof Uint8Array) lines.push('content-length', String(body.byteLength));
  else if (body !== undefined && body !== null) lines.push('transfer-encoding', 'chunked');
  else if (PAYLOAD_METHODS.has(method)) lines.push('content-length', '0');
  return lines;
}

/** Arms a timer of `ms` (none for 0 or absent) that fails the exchange with `code`; returns its disarm. */
function timer(ms: number | null | undefined, fail: () => void): () => void {
  if (ms === undefined || ms === null || ms <= 0) return () => undefined;
  const handle = setTimeout(fail, ms);
  return () => clearTimeout(handle);
}

/** The TLS server name undici sends for a `host` value: its host name, none for an IP literal. */
function serverName(host: string): string {
  const colon = host.indexOf(':');
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : colon < 0 ? host : host.slice(0, colon);
  return isIP(name) === 0 ? name : '';
}

/** Node's refusal to build a request, which sent none of it. */
function refused(error: unknown): LenientRequestRefusedError {
  return new LenientRequestRefusedError(`request refused before sending: ${(error as Error).message}`, { cause: error });
}

/**
 * Runs one exchange of `options` through Node's client, within `forwards`' bound, reporting it to `handler` as an undici
 * dispatch would, each `Location` value as legacy sent it.
 */
function dispatchLenient(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler, forwards: LenientForwards): void {
  let req: ClientRequest | undefined;
  let res: IncomingMessage | undefined;
  let done = false;
  let disarm: () => void = () => undefined;
  /** Ends the exchange once, as undici reports a failure: the handler hears it and both directions stop. */
  const fail = (error: Error): void => {
    if (done) return;
    done = true;
    disarm();
    req?.destroy();
    res?.destroy();
    handler.onResponseError?.(controller, error);
  };
  const controller = new LenientController(fail, (paused) => {
    if (paused) res?.pause();
    else res?.resume();
  });

  handler.onRequestStart?.(controller, {});
  if (controller.aborted) return;
  const { origin = '', path, method } = options;
  let url: URL;
  let lines: string[];
  try {
    url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported protocol ${url.protocol}`);
    lines = requestLines(options, url);
  } catch (error) {
    fail(refused(error));
    return;
  }
  const release = forwards.open(url.origin, fail);
  if (release instanceof Error) {
    fail(release);
    return;
  }
  const request: RequestOptions = {
    // An IPv6 literal without the brackets the URL holds it in, as undici connects to it.
    hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
    port: url.port,
    path,
    method,
    // A raw list, which Node writes as given, adding no lines of its own.
    headers: lines,
    // The strict parser, whatever the process's --insecure-http-parser; only escaped `Location` bytes get past it.
    insecureHTTPParser: false,
    // The forward agent's response-head limit.
    maxHeaderSize: SERVICE_MAX_HEADER_SIZE,
  };
  try {
    // One connection per exchange, closed once it ends. Certificates verified, and the server name undici sends: the `Host` line's, else the origin's.
    req =
      url.protocol === 'https:'
        ? httpsRequest({ ...request, agent: new EscapingHttpsAgent(), servername: serverName(lines[1] as string) || serverName(url.host) })
        : httpRequest({ ...request, agent: new EscapingHttpAgent() });
  } catch (error) {
    release();
    fail(refused(error));
    return;
  }
  req.once('close', release);
  disarm = timer(options.headersTimeout, () => fail(new LenientTimeoutError('UND_ERR_HEADERS_TIMEOUT')));
  req.on('error', fail);
  req.on('response', (message) => {
    res = message;
    disarm();
    if (done) {
      message.destroy();
      return;
    }
    const rawHeaders = message.rawHeaders.map((item, index) =>
      index % 2 === 1 && (message.rawHeaders[index - 1] as string).toLowerCase() === 'location' ? restoreLocation(item) : item,
    );
    controller.rawHeaders = rawBuffers(rawHeaders);
    // undici decodes the reason phrase as UTF-8; Node's parser reads it as latin1.
    const statusText = Buffer.from(message.statusMessage ?? '', 'latin1').toString('utf8');
    handler.onResponseStart?.(controller, message.statusCode ?? 0, parsedHeaders(rawHeaders), statusText);
    if (controller.paused) message.pause();
    const idle = (): void => {
      disarm();
      disarm = timer(options.bodyTimeout, () => fail(new LenientTimeoutError('UND_ERR_BODY_TIMEOUT')));
    };
    idle();
    message.on('data', (chunk: Buffer) => {
      if (done) return;
      idle();
      handler.onResponseData?.(controller, chunk);
    });
    message.on('end', () => {
      if (done) return;
      done = true;
      disarm();
      controller.rawTrailers = rawBuffers(message.rawTrailers);
      handler.onResponseEnd?.(controller, parsedHeaders(message.rawTrailers));
    });
    // Node fails a body its connection cut short with ECONNRESET, which the gateway reads as undici's UND_ERR_SOCKET.
    message.on('error', fail);
  });
  const { body } = options;
  if (body === undefined || body === null) {
    req.end();
  } else if (typeof body === 'string' || body instanceof Uint8Array) {
    req.end(body);
  } else if (typeof (body as Partial<Readable>).pipe === 'function') {
    // Duck-typed as @fastify/reply-from tests a body stream.
    (body as Readable).on('error', fail);
    (body as Readable).pipe(req);
  } else {
    fail(new LenientRequestRefusedError('request refused before sending: unsupported body'));
  }
}

/**
 * Runs `forward` so the request it dispatches synchronously through an agent composed with a {@link LenientForwards}
 * interceptor goes through Node's client, which reads a `Location` byte for byte where undici refuses it.
 */
export function withLenientResponse<T>(forward: () => T): T {
  return pendingLenient.run({ claimed: false }, forward);
}

/** One dispatcher's lenient exchanges: at most `limit` in flight per origin, refused once it closes, failed once it is destroyed. */
export class LenientForwards {
  readonly #inFlight = new Map<string, number>();
  /** The fail of each exchange whose connection is open. */
  readonly #running = new Set<(error: Error) => void>();
  readonly #drained: Array<() => void> = [];
  #ended: LenientEndedError['code'] | undefined;

  constructor(private readonly limit: number) {}

  /** Sends the first request dispatched under {@link withLenientResponse} through Node's client; others pass untouched. */
  readonly interceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
    const pending = pendingLenient.getStore();
    if (pending === undefined || pending.claimed) return dispatch(options, handler);
    pending.claimed = true;
    dispatchLenient(options, handler, this);
    return true;
  };

  /** Takes a slot of `origin` for an exchange `fail` ends; returns its release, or the error refusing it before it is sent. */
  open(origin: string, fail: (error: Error) => void): (() => void) | Error {
    if (this.#ended !== undefined) return new LenientEndedError(this.#ended);
    const held = this.#inFlight.get(origin) ?? 0;
    if (held >= this.limit) return new LenientRequestRefusedError(`request refused before sending: ${String(this.limit)} lenient exchanges in flight to ${origin}`);
    this.#inFlight.set(origin, held + 1);
    this.#running.add(fail);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.#running.delete(fail);
      const left = (this.#inFlight.get(origin) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(origin, left);
      else this.#inFlight.delete(origin);
      if (this.#running.size === 0) for (const resolve of this.#drained.splice(0)) resolve();
    };
  }

  /** Refuses later exchanges as undici refuses a closed dispatcher's; resolves once the connections in flight have closed. */
  close(): Promise<void> {
    this.#ended ??= 'UND_ERR_CLOSED';
    return this.#settled();
  }

  /** Refuses later exchanges and fails those in flight with `error`, as undici's destroy does; resolves once their connections have closed. */
  destroy(error: Error | null): Promise<void> {
    this.#ended = 'UND_ERR_DESTROYED';
    const reason = error ?? new LenientEndedError('UND_ERR_DESTROYED');
    for (const fail of [...this.#running]) fail(reason);
    return this.#settled();
  }

  #settled(): Promise<void> {
    return this.#running.size === 0 ? Promise.resolve() : new Promise((resolve) => this.#drained.push(resolve));
  }
}
