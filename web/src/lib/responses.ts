// Legacy-shaped `Response` builders for the admin route handlers (server-only).
import {
  adminUnavailableResponse,
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_JSON_CONTENT_TYPE,
  legacyHeaders,
} from '@opt2/platform/legacy-compat';
import { CORE_VERSION } from './env';
import { toString as markupOf, type SafeHtml } from './html';

/** Content type ACF sends with `.cfm` output. */
export const HTML_CONTENT_TYPE: string = LEGACY_HTML_CONTENT_TYPE;

// The legacy view's `cfcontent type="application/json; charset=utf-8"` reaches the wire without the space.
/** Content type of JSON view output when the caller names none. */
export const JSON_CONTENT_TYPE: string = LEGACY_JSON_CONTENT_TYPE;

/** Cache headers the full admin layout sends; the compact layout and bare views send neither. */
export const NO_CACHE_HEADERS: Readonly<{ 'cache-control': string; expires: string }> = Object.freeze({
  'cache-control': 'no-cache, no-store, must-revalidate',
  expires: '06 Nov 1994 08:37:34 GMT',
});

// Measured on every legacy `cflocation` 302, alongside the request-start headers.
const REDIRECT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'content-type': HTML_CONTENT_TYPE,
});

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const INTERNAL_HEADER_PREFIX = 'x-opt2-';

/** Options of {@link htmlResponse}. */
export interface HtmlResponseOptions {
  status?: number;
  /** Adds {@link NO_CACHE_HEADERS}, as the full layout does. */
  noCache?: boolean;
  /** Defaults to {@link HTML_CONTENT_TYPE}. */
  contentType?: string;
  headers?: HeadersInit;
}

/** Options of {@link jsonResponse}. */
export interface JsonResponseOptions {
  status?: number;
  /** Defaults to {@link JSON_CONTENT_TYPE}. */
  contentType?: string;
  headers?: HeadersInit;
}

/** A service download as received: status, raw header map and body. */
export interface DownloadSource {
  status: number;
  headers: Record<string, string | string[]>;
  body: Uint8Array | string | ReadableStream<Uint8Array>;
}

/** Options of {@link fw1Redirect}. */
export interface RedirectOptions {
  setCookies?: readonly string[];
}

/** The headers legacy adds to every response. */
function baseHeaders(): Headers {
  return new Headers(legacyHeaders(CORE_VERSION));
}

/** Overrides `target` with `init`; `Set-Cookie` values are appended. */
function mergeInto(target: Headers, init: HeadersInit | undefined): void {
  if (init === undefined) return;
  for (const [name, value] of new Headers(init)) {
    if (name === 'set-cookie') target.append(name, value);
    else target.set(name, value);
  }
}

/** HTML view output: the UTF-8 markup with the legacy headers. */
export function htmlResponse(body: SafeHtml | string, opts: HtmlResponseOptions = {}): Response {
  const headers = baseHeaders();
  headers.set('content-type', opts.contentType ?? HTML_CONTENT_TYPE);
  if (opts.noCache) mergeInto(headers, NO_CACHE_HEADERS);
  mergeInto(headers, opts.headers);
  return new Response(typeof body === 'string' ? body : markupOf(body), { status: opts.status ?? 200, headers });
}

/** JSON view output: `bodyText` sent as given, never re-serialised. */
export function jsonResponse(bodyText: string, opts: JsonResponseOptions = {}): Response {
  const headers = baseHeaders();
  headers.set('content-type', opts.contentType ?? JSON_CONTENT_TYPE);
  mergeInto(headers, opts.headers);
  return new Response(bodyText, { status: opts.status ?? 200, headers });
}

/** A service download passed through: every end-to-end header kept, hop-by-hop and `x-opt2-*` headers dropped. */
export function downloadResponse(res: DownloadSource): Response {
  const headers = baseHeaders();
  for (const [rawName, value] of Object.entries(res.headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name.startsWith(INTERNAL_HEADER_PREFIX)) continue;
    if (typeof value === 'string') {
      headers.set(name, value);
    } else {
      headers.delete(name);
      for (const item of value) headers.append(name, item);
    }
  }
  // `BodyInit` rejects only shared-memory-backed views, which an HTTP body never is.
  return new Response(res.body as BodyInit, { status: res.status, headers });
}

/** FW/1 `redirect()`: a 302 to `location` exactly as given, with an empty body. */
export function fw1Redirect(location: string, opts: RedirectOptions = {}): Response {
  const headers = baseHeaders();
  mergeInto(headers, REDIRECT_HEADERS);
  headers.set('location', location);
  for (const cookie of opts.setCookies ?? []) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** A copy of `res` with each of `cookies` appended as a `Set-Cookie` header, in order. */
export function withSetCookies(res: Response, cookies: readonly string[]): Response {
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  for (const cookie of cookies) out.headers.append('set-cookie', cookie);
  return out;
}

/** The legacy admin error page with status 503, for a target admin route whose service is unavailable. */
export function legacyUnavailable(): Response {
  const { status, statusText, headers, body } = adminUnavailableResponse({ version: CORE_VERSION });
  return new Response(body, { status, statusText, headers });
}

/** An empty 404 HTML response with the legacy headers. */
export function notFound(): Response {
  const headers = baseHeaders();
  headers.set('content-type', HTML_CONTENT_TYPE);
  return new Response(null, { status: 404, headers });
}
