import { CookieJar } from 'tough-cookie';

/** Fetch-compatible function the session calls once per hop. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One file part of a multipart request. */
export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** One request; `form`, `json`, `multipart` and `body` are mutually exclusive. */
export interface HttpRequest {
  method?: string;
  /** Path resolved against the session's base URL, or an absolute URL. */
  path?: string;
  query?: Record<string, string | readonly string[]>;
  headers?: Record<string, string>;
  form?: Record<string, string | readonly string[]> | URLSearchParams;
  json?: unknown;
  multipart?: {
    fields?: Record<string, string | readonly string[]>;
    files?: readonly MultipartFile[];
  };
  body?: string | Uint8Array;
  /** Defaults to true. */
  followRedirects?: boolean;
  /** Caller cancellation, combined with the deadline; it cannot extend it, so a long run sets `timeoutMs`. */
  signal?: AbortSignal;
  /** Deadline in ms for every hop and the final body; overrides the session's. */
  timeoutMs?: number;
}

/** One request/response exchange; `setCookie` keeps every raw line, including lines the jar rejected. */
export interface HttpHop {
  method: string;
  url: string;
  status: number;
  location?: string;
  setCookie: string[];
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string | string[]>;
}

/** Final response with every hop that led to it, the final hop last. */
export interface HttpResult {
  status: number;
  url: string;
  /** Lower-cased names; `set-cookie` is always an array. */
  headers: Record<string, string | string[]>;
  bytes: Uint8Array;
  text: string;
  json<T = unknown>(): T;
  hops: HttpHop[];
}

/** Cookie-carrying client for one scenario. */
export interface HttpSession {
  readonly baseUrl: string;
  readonly jar: CookieJar;
  request(req: HttpRequest): Promise<HttpResult>;
  get(path: string, req?: Omit<HttpRequest, 'method' | 'path'>): Promise<HttpResult>;
  post(path: string, req?: Omit<HttpRequest, 'method' | 'path'>): Promise<HttpResult>;
  /** `Cookie` header the jar would send to `url` (default: the base URL). */
  cookieHeader(url?: string): Promise<string>;
}

/** Options for {@link createHttpSession}. */
export interface HttpSessionOptions {
  baseUrl: string;
  fetch?: FetchLike;
  jar?: CookieJar;
  defaultHeaders?: Record<string, string>;
  maxRedirects?: number;
  /** Default request deadline in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Default whole-exchange deadline, in ms. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** A failed exchange; `target` is the URL's origin and path only, never its query, fragment or userinfo. */
export class HttpRequestError extends Error {
  override readonly name: string = 'HttpRequestError';
  readonly method: string;
  readonly target: string;
  /** 1-based index of the hop being attempted or read. */
  readonly hop: number;
  readonly status?: number;

  constructor(what: string, method: string, url: string, hop: number, status?: number, options?: ErrorOptions) {
    const { origin, pathname } = new URL(url);
    const target = `${origin}${pathname}`;
    const suffix = status === undefined ? '' : `, status ${status}`;
    super(`${what}: ${method} ${target} (hop ${hop}${suffix})`, options);
    this.method = method;
    this.target = target;
    this.hop = hop;
    this.status = status;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_KINDS = ['form', 'json', 'multipart', 'body'] as const;
// Fetch-standard request-body-header names, removed when a redirect drops the body.
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];
// Removed for the rest of the exchange once a redirect leaves the current origin.
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-serverless-authorization'];
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_CAUSE_DEPTH = 8;

interface EncodedBody {
  body?: string | Uint8Array;
  contentType?: string;
}

function appendEntries(
  target: { append(name: string, value: string): void },
  entries: Record<string, string | readonly string[]>,
): void {
  for (const [name, value] of Object.entries(entries)) {
    for (const item of typeof value === 'string' ? [value] : value) target.append(name, item);
  }
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

function buildUrl(baseUrl: string, path: string | undefined, query: HttpRequest['query']): string {
  const url = new URL(path ?? '', baseUrl);
  if (query) {
    const extra = new URLSearchParams();
    appendEntries(extra, query);
    const encoded = extra.toString();
    // Appended rather than rebuilt through searchParams, so the path's own query keeps its exact encoding.
    if (encoded) url.search = url.search ? `${url.search}&${encoded}` : encoded;
  }
  return url.href;
}

async function encodeBody(req: HttpRequest): Promise<EncodedBody> {
  const kinds = BODY_KINDS.filter((kind) => req[kind] !== undefined);
  if (kinds.length > 1) throw new Error(`HttpRequest accepts one body kind, got: ${kinds.join(', ')}`);
  if (req.form !== undefined) {
    const params = req.form instanceof URLSearchParams ? req.form : new URLSearchParams();
    if (!(req.form instanceof URLSearchParams)) appendEntries(params, req.form);
    return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  if (req.json !== undefined) return { body: JSON.stringify(req.json), contentType: 'application/json' };
  if (req.multipart !== undefined) {
    const form = new FormData();
    appendEntries(form, req.multipart.fields ?? {});
    for (const file of req.multipart.files ?? []) {
      form.append(file.name, new Blob([file.data], { type: file.contentType }), file.filename);
    }
    // Serialised once by the runtime's own FormData encoder, so its boundary header is recorded in the hop
    // and the bytes can be resent on 307/308.
    const encoded = new Response(form);
    return {
      body: new Uint8Array(await encoded.arrayBuffer()),
      contentType: encoded.headers.get('content-type') ?? 'multipart/form-data',
    };
  }
  return req.body === undefined ? {} : { body: req.body };
}

function collectHeaders(headers: Headers, setCookie: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  out['set-cookie'] = setCookie;
  return out;
}

function decodeText(bytes: Uint8Array, contentType: string | null): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unsupported charset label: fall back to UTF-8 below.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** ` (CODE)` for the first system error code on `err`'s cause chain, such as `ECONNREFUSED`, else ''. */
function errorCode(err: unknown): string {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && ERROR_CODE.test(code)) return ` (${code})`;
    current = cause;
  }
  return '';
}

/** Settles as `promise` does, or rejects with `signal.reason` once `signal` aborts, even if `promise` won't. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Reads the whole body; an abort cancels the stream and rejects with `signal.reason`. */
async function readBody(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const onAbort = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // A read pending at cancellation resolves as done, so the abort surfaces here.
    signal.throwIfAborted();
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function withoutHeaders(headers: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
}

/**
 * Creates a session with its own cookie jar that follows redirects by hand, recording every hop.
 * As in Fetch, a 301/302 after POST, or a 303 after anything but GET/HEAD, is followed as a bodiless GET;
 * other redirects keep method and body. A cross-origin hop drops credential headers and refuses to resend
 * a body. Throws {@link HttpRequestError} on a failed or timed-out exchange, or past `maxRedirects`; a caller
 * abort rejects with the caller's reason.
 */
export function createHttpSession(options: HttpSessionOptions): HttpSession {
  const { baseUrl, defaultHeaders = {}, maxRedirects = 20 } = options;
  const sessionTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;
  const jar =
    options.jar ??
    new CookieJar(undefined, { looseMode: true, rejectPublicSuffixes: false, allowSpecialUseDomain: true });

  async function request(req: HttpRequest): Promise<HttpResult> {
    const timeoutMs = req.timeoutMs ?? sessionTimeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    const encoded = await encodeBody(req);
    const follow = req.followRedirects ?? true;
    const hops: HttpHop[] = [];
    let method = (req.method ?? 'GET').toUpperCase();
    let url = buildUrl(baseUrl, req.path, req.query);
    let body = encoded.body;
    let headers: Record<string, string> = {
      ...lowerKeys(defaultHeaders),
      ...(encoded.contentType === undefined ? {} : { 'content-type': encoded.contentType }),
      ...lowerKeys(req.headers),
    };

    /** The caller's abort reason unchanged, else an {@link HttpRequestError} for `hop`. */
    const failure = (err: unknown, what: string, hop: number, status?: number): unknown => {
      if (req.signal?.aborted) return req.signal.reason;
      const reason = deadline.aborted ? `timed out after ${timeoutMs} ms` : `${what}${errorCode(err)}`;
      return new HttpRequestError(reason, method, url, hop, status, { cause: err });
    };

    for (;;) {
      const hop = hops.length + 1;
      const sent = { ...headers };
      if (sent.cookie === undefined) {
        const cookie = await jar.getCookieString(url);
        if (cookie) sent.cookie = cookie;
      }
      let res: Response;
      try {
        signal.throwIfAborted();
        const init: RequestInit = { method, headers: sent, body, redirect: 'manual', signal };
        res = await untilAborted(fetchImpl(url, init), signal);
      } catch (err) {
        throw failure(err, 'request failed', hop);
      }
      const setCookie = res.headers.getSetCookie();
      for (const line of setCookie) await jar.setCookie(line, url, { ignoreError: true });
      const responseHeaders = collectHeaders(res.headers, setCookie);
      const location = res.headers.get('location');
      hops.push({
        method,
        url,
        status: res.status,
        ...(location === null ? {} : { location }),
        setCookie,
        requestHeaders: sent,
        responseHeaders,
      });

      if (!follow || location === null || !REDIRECT_STATUSES.has(res.status)) {
        let bytes: Uint8Array;
        try {
          bytes = await readBody(res, signal);
        } catch (err) {
          throw failure(err, 'response body read failed', hop, res.status);
        }
        const text = decodeText(bytes, res.headers.get('content-type'));
        const { status } = res;
        return {
          status,
          url,
          headers: responseHeaders,
          bytes,
          text,
          json: <T = unknown>(): T => {
            try {
              return JSON.parse(text) as T;
            } catch (err) {
              // The parse error quotes the body, so it is kept as the cause only.
              throw new HttpRequestError('response body is not JSON', method, url, hop, status, { cause: err });
            }
          },
          hops,
        };
      }

      try {
        await untilAborted(res.body?.cancel() ?? Promise.resolve(), signal);
      } catch (err) {
        throw failure(err, 'redirect body cancel failed', hop, res.status);
      }
      const redirectError = (what: string): HttpRequestError =>
        new HttpRequestError(what, method, url, hop, res.status);
      if (hops.length > maxRedirects) throw redirectError(`Too many redirects (maxRedirects=${maxRedirects})`);
      if (!URL.canParse(location, url)) throw redirectError('invalid redirect location');
      const next = new URL(location, url);
      const rewritesToGet =
        ((res.status === 301 || res.status === 302) && method === 'POST') ||
        (res.status === 303 && method !== 'GET' && method !== 'HEAD');
      if (rewritesToGet) {
        method = 'GET';
        body = undefined;
        headers = withoutHeaders(headers, BODY_HEADERS);
      }
      if (next.origin !== new URL(url).origin) {
        if (body !== undefined) throw redirectError('refusing to resend the request body to another origin');
        headers = withoutHeaders(headers, CREDENTIAL_HEADERS);
      }
      url = next.href;
    }
  }

  return {
    baseUrl,
    jar,
    request,
    get: (path, req = {}) => request({ ...req, method: 'GET', path }),
    post: (path, req = {}) => request({ ...req, method: 'POST', path }),
    cookieHeader: (url) => jar.getCookieString(new URL(url ?? baseUrl, baseUrl).href),
  };
}
