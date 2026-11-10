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
  signal?: AbortSignal;
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
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_KINDS = ['form', 'json', 'multipart', 'body'] as const;
// Fetch-standard request-body-header names, removed when a redirect drops the body.
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];

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

/**
 * Creates a session with its own cookie jar that follows redirects by hand, recording every hop.
 * A 303, or a 301/302 answering anything but GET/HEAD, is followed as a bodiless GET; 307/308 keep
 * method and body. Throws once more than `maxRedirects` redirects would be followed.
 */
export function createHttpSession(options: HttpSessionOptions): HttpSession {
  const { baseUrl, defaultHeaders = {}, maxRedirects = 20 } = options;
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;
  const jar =
    options.jar ??
    new CookieJar(undefined, { looseMode: true, rejectPublicSuffixes: false, allowSpecialUseDomain: true });

  async function request(req: HttpRequest): Promise<HttpResult> {
    const encoded = await encodeBody(req);
    const follow = req.followRedirects ?? true;
    const hops: HttpHop[] = [];
    let method = (req.method ?? 'GET').toUpperCase();
    const startUrl = buildUrl(baseUrl, req.path, req.query);
    let url = startUrl;
    let body = encoded.body;
    let headers: Record<string, string> = {
      ...lowerKeys(defaultHeaders),
      ...(encoded.contentType === undefined ? {} : { 'content-type': encoded.contentType }),
      ...lowerKeys(req.headers),
    };

    for (;;) {
      const sent = { ...headers };
      if (sent.cookie === undefined) {
        const cookie = await jar.getCookieString(url);
        if (cookie) sent.cookie = cookie;
      }
      const res = await fetchImpl(url, { method, headers: sent, body, redirect: 'manual', signal: req.signal });
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
        const bytes = new Uint8Array(await res.arrayBuffer());
        const text = decodeText(bytes, res.headers.get('content-type'));
        return {
          status: res.status,
          url,
          headers: responseHeaders,
          bytes,
          text,
          json: <T = unknown>(): T => JSON.parse(text) as T,
          hops,
        };
      }

      await res.body?.cancel();
      if (hops.length > maxRedirects) {
        throw new Error(`Too many redirects (maxRedirects=${maxRedirects}) from ${startUrl}`);
      }
      const keepsMethod = method === 'GET' || method === 'HEAD';
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && !keepsMethod)) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.includes(name)));
      }
      url = new URL(location, url).href;
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
