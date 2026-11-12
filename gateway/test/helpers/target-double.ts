// Stand-in for an owning service or web in gateway tests: echoes what the gateway forwarded, or fails as a dead target.
import { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { WRITE_POSITION_HEADER, formatWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { ORIGINAL_URL_HEADER } from '../../src/admin/map.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from './http-double.js';

/** Request id header the gateway sends every callee. */
const REQUEST_ID_HEADER = 'x-request-id';
const ORIGINAL_URL_HEADER_LC = ORIGINAL_URL_HEADER.toLowerCase();
const SET_COOKIE = 'set-cookie';

/** What the target received; the JSON body of the default `ok` answer. */
export interface TargetEcho {
  service: string;
  method: string;
  path: string;
  url: string;
  query: Record<string, string | string[]>;
  authorization?: string;
  serverlessAuthorization?: string;
  traceparent?: string;
  tracestate?: string;
  originalUrl?: string;
  forwarded: { for?: string; proto?: string; host?: string };
  requestId?: string;
  cookie?: string;
  host?: string;
  contentType?: string;
  bodyBase64: string;
}

/** `refuse` listens nowhere; `timeout` hangs until `close()`, so shorten the gateway's timeout or fake its timers. */
export type TargetMode = 'ok' | 'refuse' | 'timeout' | '502' | '503' | '504';

/** A write-position header value as sent, or positions formatted by migration-kit. */
export type WritePositionInput = string | WritePositions | Readonly<Record<string, string>>;

/** An `ok` answer replacing the echo; a string or Buffer body is sent as is, any other defined body as JSON. */
export interface TargetResponse {
  /** Defaults to 200. */
  status?: number;
  /** An array value repeats the header. */
  headers?: Record<string, string | string[]>;
  body?: unknown;
}

/** Computes the `ok` answer of one request. */
export type TargetResponder = (echo: TargetEcho, req: RecordedRequest) => TargetResponse;

/** Initial behaviour of {@link startTargetDouble}. */
export interface TargetDoubleOptions {
  /** Defaults to `ok`. */
  mode?: TargetMode;
  /** Replaces the echo of `ok` answers. */
  response?: TargetResponse | TargetResponder;
  /** Sent as `X-Opt2-Write-Position` on every `ok` answer. */
  writePosition?: WritePositionInput;
  /** Each becomes one `Set-Cookie` header of every `ok` answer, after those the response itself sets. */
  setCookies?: readonly string[];
}

/** A loopback target whose answers and failure mode a suite switches at runtime. */
export interface TargetDouble {
  /** Service folder name, or `web`. */
  readonly name: string;
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly url: string;
  readonly port: number;
  readonly mode: TargetMode;
  /** Requests received in every listening mode, in arrival order. */
  readonly requests: RecordedRequest[];
  /** Echoes of `requests`, in the same order. */
  echoes(): TargetEcho[];
  clearRequests(): void;
  /** Switches the mode; leaving `refuse` listens on a new ephemeral port and updates `url` and `port`. */
  setMode(mode: TargetMode): Promise<void>;
  /** Replaces the `ok` answer; without an argument the echo is answered again. */
  setResponse(response?: TargetResponse | TargetResponder): void;
  /** Sets or, without an argument, removes the write position of `ok` answers. */
  setWritePosition(position?: WritePositionInput): void;
  setSetCookies(cookies: readonly string[]): void;
  /** Destroys open connections, hung `timeout` requests included, and stops listening; safe to call repeatedly. */
  close(): Promise<void>;
}

/** A header as one string; Node joins repeated values of most headers itself. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** The echo of `req` as received by `service`. */
export function echoOf(service: string, req: RecordedRequest): TargetEcho {
  const { headers } = req;
  return {
    service,
    method: req.method,
    path: req.path,
    url: req.url,
    query: req.query,
    authorization: headerValue(headers, 'authorization'),
    serverlessAuthorization: headerValue(headers, INVOCATION_HEADER),
    traceparent: headerValue(headers, 'traceparent'),
    tracestate: headerValue(headers, 'tracestate'),
    originalUrl: headerValue(headers, ORIGINAL_URL_HEADER_LC),
    forwarded: {
      for: headerValue(headers, 'x-forwarded-for'),
      proto: headerValue(headers, 'x-forwarded-proto'),
      host: headerValue(headers, 'x-forwarded-host'),
    },
    requestId: headerValue(headers, REQUEST_ID_HEADER),
    cookie: headerValue(headers, 'cookie'),
    host: headerValue(headers, 'host'),
    contentType: headerValue(headers, 'content-type'),
    bodyBase64: req.body.toString('base64'),
  };
}

/** Moves every `Set-Cookie` entry of `headers`, whatever its case, out of the map; returns their values in order. */
function takeSetCookies(headers: Record<string, string | string[]>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== SET_COOKIE) continue;
    values.push(...(Array.isArray(value) ? value : [value]));
    delete headers[name];
  }
  return values;
}

/** Starts the target double `name` on an ephemeral loopback port, or, in `refuse` mode, on none. */
export async function startTargetDouble(name: string, opts: TargetDoubleOptions = {}): Promise<TargetDouble> {
  let mode: TargetMode = opts.mode ?? 'ok';
  let response = opts.response;
  let writePosition = opts.writePosition;
  let setCookies: readonly string[] = [...(opts.setCookies ?? [])];
  let listener: HttpDouble | undefined;
  let port = 0;
  let closed = false;
  let switching: Promise<void> = Promise.resolve();
  const requests: RecordedRequest[] = [];

  function sendOk(req: RecordedRequest, res: ServerResponse): void {
    const echo = echoOf(name, req);
    const answer = typeof response === 'function' ? response(echo, req) : response;
    const headers: Record<string, string | string[]> = { ...answer?.headers };
    const position = typeof writePosition === 'object' ? formatWritePosition(writePosition) : writePosition;
    if (position) headers[WRITE_POSITION_HEADER] = position;
    if (setCookies.length > 0) headers['Set-Cookie'] = [...takeSetCookies(headers), ...setCookies];

    if (answer === undefined) {
      sendJson(res, 200, echo, headers);
      return;
    }
    const status = answer.status ?? 200;
    const { body } = answer;
    if (typeof body === 'string' || Buffer.isBuffer(body)) sendBytes(res, status, body, headers);
    else if (body === undefined) sendBytes(res, status, '', headers);
    else sendJson(res, status, body, headers);
  }

  function handle(req: RecordedRequest, res: ServerResponse): void {
    requests.push(req);
    switch (mode) {
      case 'ok':
        sendOk(req, res);
        return;
      case 'timeout':
        return;
      case 'refuse':
        // Reached only by a request that arrived while the listener was closing.
        res.destroy();
        return;
      default:
        sendJson(res, Number(mode), { service: name, error: 'upstream' });
    }
  }

  async function listen(): Promise<HttpDouble> {
    const double = await startHttpDouble(handle);
    port = double.port;
    return double;
  }

  async function apply(next: TargetMode): Promise<void> {
    if (closed) throw new Error(`target double ${name} is closed`);
    mode = next;
    if (next === 'refuse' && listener !== undefined) {
      const current = listener;
      listener = undefined;
      await current.close();
    } else if (next !== 'refuse' && listener === undefined) {
      listener = await listen();
    }
  }

  if (mode === 'refuse') {
    // Binding then closing yields a loopback port with nothing listening on it.
    await (await listen()).close();
  } else {
    listener = await listen();
  }

  return {
    name,
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    get mode() {
      return mode;
    },
    requests,
    echoes() {
      return requests.map((req) => echoOf(name, req));
    },
    clearRequests() {
      requests.length = 0;
      listener?.clearRequests();
    },
    setMode(next) {
      const run = switching.then(() => apply(next));
      switching = run.catch(() => undefined);
      return run;
    },
    setResponse(next) {
      response = next;
    },
    setWritePosition(position) {
      writePosition = position;
    },
    setSetCookies(cookies) {
      setCookies = [...cookies];
    },
    async close() {
      closed = true;
      await switching;
      await listener?.close();
    },
  };
}
