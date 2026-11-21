// Sends one forward through Node's HTTP client with its lenient parser, for an upstream head whose bytes undici's parser refuses.
import { AsyncLocalStorage } from 'node:async_hooks';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
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

/** Runs one exchange of `options` through Node's lenient client, reporting it to `handler` as an undici dispatch would. */
function dispatchLenient(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): void {
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
  try {
    const url = new URL(origin);
    req = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      // A raw list, which Node writes as given, adding no lines of its own.
      headers: requestLines(options, url),
      insecureHTTPParser: true,
      // The forward agent's response-head limit.
      maxHeaderSize: SERVICE_MAX_HEADER_SIZE,
      agent: false,
    });
  } catch (error) {
    fail(new LenientRequestRefusedError(`request refused before sending: ${(error as Error).message}`, { cause: error }));
    return;
  }
  disarm = timer(options.headersTimeout, () => fail(new LenientTimeoutError('UND_ERR_HEADERS_TIMEOUT')));
  req.on('error', fail);
  req.on('response', (message) => {
    res = message;
    disarm();
    if (done) {
      message.destroy();
      return;
    }
    controller.rawHeaders = rawBuffers(message.rawHeaders);
    // undici decodes the reason phrase as UTF-8; Node's parser reads it as latin1.
    const statusText = Buffer.from(message.statusMessage ?? '', 'latin1').toString('utf8');
    handler.onResponseStart?.(controller, message.statusCode ?? 0, parsedHeaders(message.rawHeaders), statusText);
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
 * Runs `forward` so the request it dispatches synchronously through an agent composed with {@link lenientResponse} goes
 * through Node's lenient parser, which reads a head byte for byte where undici refuses it.
 */
export function withLenientResponse<T>(forward: () => T): T {
  return pendingLenient.run({ claimed: false }, forward);
}

/** Sends the first request dispatched under {@link withLenientResponse} through Node's lenient client; others pass untouched. */
export const lenientResponse: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
  const pending = pendingLenient.getStore();
  if (pending === undefined || pending.claimed) return dispatch(options, handler);
  pending.claimed = true;
  dispatchLenient(options, handler);
  return true;
};
