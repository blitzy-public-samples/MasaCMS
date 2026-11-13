// Legacy-shaped `Response` builders for the admin routes (server-only).
import {
  adminUnavailableResponse,
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_JSON_CONTENT_TYPE,
  legacyHeaders,
} from '@opt2/platform/legacy-compat';
import { negotiatesIdentityEncoding } from './accept-encoding';
import { isCompactDisplay } from './cfml';
import { CORE_VERSION, legacySettings } from './env';
import { toString as markupOf, type SafeHtml } from './html';
import { cf2Java } from './resource-bundles/rb';

export { isCompactDisplay, negotiatesIdentityEncoding };

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
export const REDIRECT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
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

// Java 17 `Locale` replaces the obsolete ISO 639 codes.
const OBSOLETE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['iw', 'he'],
  ['ji', 'yi'],
  ['in', 'id'],
]);

/** Request facts the servlet container's `Content-Language` and `Content-Encoding` depend on. */
export interface LegacyResponseContext {
  /** Session Java locale (`session.locale`); absent or empty uses the configured `locale` setting. */
  locale?: string;
  /** The request's combined `Accept-Encoding` value. */
  acceptEncoding?: string | null;
}

/** Options of {@link htmlResponse}. */
export interface HtmlResponseOptions {
  status?: number;
  /** Adds {@link NO_CACHE_HEADERS}, as the full layout does. */
  noCache?: boolean;
  /** Defaults to {@link HTML_CONTENT_TYPE}. */
  contentType?: string;
  headers?: HeadersInit;
  context?: LegacyResponseContext;
}

/** Options of {@link jsonResponse}. */
export interface JsonResponseOptions {
  status?: number;
  /** Defaults to {@link JSON_CONTENT_TYPE}. */
  contentType?: string;
  headers?: HeadersInit;
  context?: LegacyResponseContext;
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
  context?: LegacyResponseContext;
}

const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
const asciiUpper = (text: string): string => text.replace(/[a-z]+/g, (run) => run.toUpperCase());

/** `Content-Language` the servlet container derives from a Java locale (`ll_CC[_variant]`): `language-COUNTRY`. */
export function contentLanguage(javaLocale: string): string {
  const [language = '', country = ''] = javaLocale.split('_');
  const lower = asciiLower(language);
  return `${OBSOLETE_LANGUAGES.get(lower) ?? lower}-${asciiUpper(country)}`;
}

/** The servlet container's `Content-Language` and negotiated `Content-Encoding` for `context`. */
function containerHeaders(context: LegacyResponseContext = {}): Record<string, string> {
  const locale = context.locale || cf2Java(legacySettings().defaultLocale);
  return negotiatesIdentityEncoding(context.acceptEncoding)
    ? { 'content-language': contentLanguage(locale), 'content-encoding': 'identity' }
    : { 'content-language': contentLanguage(locale) };
}

/** The headers legacy adds to every response. */
function baseHeaders(context?: LegacyResponseContext): Headers {
  const headers = new Headers(legacyHeaders(CORE_VERSION));
  mergeInto(headers, containerHeaders(context));
  return headers;
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
  const headers = baseHeaders(opts.context);
  headers.set('content-type', opts.contentType ?? HTML_CONTENT_TYPE);
  if (opts.noCache) mergeInto(headers, NO_CACHE_HEADERS);
  mergeInto(headers, opts.headers);
  return new Response(typeof body === 'string' ? body : markupOf(body), { status: opts.status ?? 200, headers });
}

/** JSON view output: `bodyText` sent as given, never re-serialised. */
export function jsonResponse(bodyText: string, opts: JsonResponseOptions = {}): Response {
  const headers = baseHeaders(opts.context);
  headers.set('content-type', opts.contentType ?? JSON_CONTENT_TYPE);
  mergeInto(headers, opts.headers);
  return new Response(bodyText, { status: opts.status ?? 200, headers });
}

/** Lower-cased field names every `Connection` header of `headers` nominates. */
function connectionNominated(headers: DownloadSource['headers']): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const item of typeof value === 'string' ? [value] : value) {
      for (const token of item.split(',')) {
        const field = token.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase();
        if (field !== '') names.add(field);
      }
    }
  }
  return names;
}

/** A service download passed through: end-to-end headers kept; hop-by-hop, Connection-listed and `x-opt2-*` dropped. */
export function downloadResponse(res: DownloadSource, context?: LegacyResponseContext): Response {
  const headers = baseHeaders(context);
  const nominated = connectionNominated(res.headers);
  for (const [rawName, value] of Object.entries(res.headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || nominated.has(name) || name.startsWith(INTERNAL_HEADER_PREFIX)) continue;
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
  const headers = baseHeaders(opts.context);
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
export function legacyUnavailable(context?: LegacyResponseContext): Response {
  const { status, statusText, headers, body } = adminUnavailableResponse({ version: CORE_VERSION });
  const merged = new Headers(headers);
  mergeInto(merged, containerHeaders(context));
  return new Response(body, { status, statusText, headers: merged });
}

/** An empty 404 HTML response with the legacy headers. */
export function notFound(context?: LegacyResponseContext): Response {
  const headers = baseHeaders(context);
  headers.set('content-type', HTML_CONTENT_TYPE);
  return new Response(null, { status: 404, headers });
}
