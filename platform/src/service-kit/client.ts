// Service-to-service HTTP client of @opt2/platform/service-kit: one undici call per request, bounded by one timeout.
import { channel } from 'node:diagnostics_channel';
import { Agent, errors, request, type Dispatcher } from 'undici';
import { INVOCATION_HEADER, type InvocationMinter } from '../auth/index.js';
import { LegacyServiceUnavailableError } from '../legacy-compat/index.js';
import { injectHttpHeaders } from '../tracing/index.js';
import { currentRequestContext } from './context.js';

/** Upper bound of one service call, from connect to the last body byte. */
export const SERVICE_CALL_TIMEOUT_MS = 10_000;

/** One call to another OPT-2 service. */
export interface ServiceRequest {
  /** Callee name, a key of `serviceUrls`, for example `identity` or `migration`. */
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute path, for example `/internal/v1/csrf/consume`. */
  path: string;
  /** Query parameters; array values repeat the key and undefined values are skipped. */
  query?: Record<string, string | string[] | undefined>;
  /** Body sent as `application/json`. */
  json?: unknown;
  /** Body sent as `application/x-www-form-urlencoded`; array values repeat the key. */
  form?: Record<string, string | string[]>;
  /** Raw body; the caller sets its content type in `headers`. */
  body?: Buffer | string;
  headers?: Record<string, string>;
  /** User token for `Authorization`: undefined forwards the request context's token, null sends none. */
  userToken?: string | null;
}

/** A callee's answer; every status is returned as data, 4xx and 5xx included. */
export interface ServiceResponse<T = unknown> {
  status: number;
  /** Response headers with lower-cased names, for example `x-opt2-write-position`. */
  headers: Record<string, string | string[]>;
  /** Parsed JSON for JSON media types (undefined when empty), a string for `text/*`, otherwise a Buffer. */
  body: T;
}

/** Construction options of {@link createServiceClient}. */
export interface ServiceClientOptions {
  /** Callee name to base URL, from `OPT2_SERVICE_URLS` plus the gateway and migration URLs. */
  serviceUrls: Record<string, string>;
  /** This process's service name (`OPT2_SERVICE_NAME`). */
  self: string;
  /** Mints this workload's invocation credential for each callee. */
  credentials: InvocationMinter;
  /** Replaces the owned Agent, for example with a MockAgent in tests; the client never closes it. */
  dispatcher?: Dispatcher;
  /** Replaces SERVICE_CALL_TIMEOUT_MS in tests. */
  timeoutMs?: number;
}

/** Client for calls to other OPT-2 services. */
export interface ServiceClient {
  /** Sends the call exactly once and returns the callee's response, whatever its status. */
  request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>>;
  /** Closes the owned Agent; an injected dispatcher stays open. */
  close(): Promise<void>;
}

function failureCode(cause: unknown): string {
  const { code, name } = (cause ?? {}) as { code?: unknown; name?: unknown };
  if (typeof code === 'string') return code;
  return typeof name === 'string' ? name : 'unknown';
}

/** The callee refused, dropped or outlasted the call; renders as the legacy 503. */
export class ServiceUnavailableError extends LegacyServiceUnavailableError {
  override readonly name: string = 'ServiceUnavailableError';

  constructor(
    readonly service: string,
    override readonly cause: unknown,
  ) {
    super(`Service ${service} unavailable (${failureCode(cause)})`, 'auto', 'service-unavailable');
  }
}

/** The callee has no configured URL; a configuration error that renders as a 500. */
export class UnknownServiceError extends Error {
  override readonly name: string = 'UnknownServiceError';

  constructor(readonly service: string) {
    super(`No URL is configured for service ${service}`);
  }
}

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH']);

function isUnreachable(err: unknown): boolean {
  return (
    err instanceof errors.ConnectTimeoutError ||
    err instanceof errors.HeadersTimeoutError ||
    err instanceof errors.BodyTimeoutError ||
    err instanceof errors.SocketError ||
    (err instanceof Error && UNREACHABLE_CODES.has(String((err as NodeJS.ErrnoException).code)))
  );
}

// The OTel undici instrumentation subscribes here and appends its client span's traceparent to every request.
// Injecting as well would send two traceparent headers, which the callee joins into one invalid value and drops.
const undiciRequestCreated = channel('undici:request:create');

function lowerCased(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value;
  return result;
}

function appendAll(params: URLSearchParams, entries: Record<string, string | string[] | undefined>): URLSearchParams {
  for (const [name, value] of Object.entries(entries)) {
    for (const item of value === undefined ? [] : [value].flat()) params.append(name, item);
  }
  return params;
}

function encodeBody(req: ServiceRequest, headers: Record<string, string>): string | Buffer | undefined {
  if (req.json !== undefined) {
    headers['content-type'] = 'application/json';
    return JSON.stringify(req.json);
  }
  if (req.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    return appendAll(new URLSearchParams(), req.form).toString();
  }
  return req.body;
}

function mediaType(contentType: string | string[] | undefined): string {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (value?.split(';')[0] ?? '').trim().toLowerCase();
}

function decodeBody(raw: Buffer, contentType: string | string[] | undefined, callee: string): unknown {
  const type = mediaType(contentType);
  if (type === 'application/json' || type.endsWith('+json')) {
    if (raw.length === 0) return undefined;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw new Error(`${callee} answered with invalid JSON`, { cause: err });
    }
  }
  return type.startsWith('text/') ? raw.toString('utf8') : raw;
}

/** Creates the service-to-service client: user token in `Authorization`, invocation credential, trace context. */
export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  const timeoutMs = options.timeoutMs ?? SERVICE_CALL_TIMEOUT_MS;
  const ownsDispatcher = options.dispatcher === undefined;
  const dispatcher: Dispatcher =
    options.dispatcher ?? new Agent({ connectTimeout: timeoutMs, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });

  async function send<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    const base = options.serviceUrls[req.service];
    if (base === undefined) throw new UnknownServiceError(req.service);
    const url = new URL(req.path, base);
    appendAll(url.searchParams, req.query ?? {});

    const headers = lowerCased(req.headers ?? {});
    const body = encodeBody(req, headers);
    const userToken = req.userToken === undefined ? currentRequestContext()?.userToken : req.userToken;
    if (typeof userToken === 'string') headers.authorization = `Bearer ${userToken}`;
    else if (userToken === null) delete headers.authorization;
    // Only this workload's own credential for this callee is ever sent, never one a caller passed along.
    delete headers[INVOCATION_HEADER];
    Object.assign(headers, lowerCased(await options.credentials.headersFor({ name: req.service, url: base })));
    if (!undiciRequestCreated.hasSubscribers) injectHttpHeaders(headers);

    // undici's parser timers fire up to ~500 ms late and a MockAgent ignores them, so the signal bounds the whole call.
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Dispatcher.ResponseData;
    let raw: Buffer;
    try {
      response = await request(url, {
        method: req.method,
        headers,
        body,
        dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: deadline,
      });
      raw = Buffer.from(await response.body.arrayBuffer());
    } catch (err) {
      if (deadline.aborted || isUnreachable(err)) throw new ServiceUnavailableError(req.service, err);
      throw err;
    }

    const responseHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders[name.toLowerCase()] = value;
    }
    const callee = `Service ${req.service} (called by ${options.self})`;
    const decoded = decodeBody(raw, responseHeaders['content-type'], callee);
    return { status: response.statusCode, headers: responseHeaders, body: decoded as T };
  }

  return {
    request: send,
    async close() {
      if (ownsDispatcher) await dispatcher.close();
    },
  };
}
