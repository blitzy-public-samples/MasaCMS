// Legacy-shaped 503 responses for fail-closed and wait-timeout conditions (core/templates/error.html, onError_include.cfm:138-151, jsonApiUtility.cfc:1390-1400).
import {
  legacyErrorResponse,
  type LegacyErrorResponseOptions,
  type LegacyErrorSurface,
  type LegacyServiceUnavailableError,
} from './errors.js';
import type { SerializedLegacyResponse } from './envelope.js';
import { legacyHeaders } from './headers.js';

/** Byte-exact copy of core/templates/error.html: CRLF line endings and three trailing line breaks. */
export const LEGACY_ERROR_PAGE_HTML: string = [
  '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">',
  '<head>',
  '<meta http-equiv="content-type" content="text/html; charset=utf-8" />',
  '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />',
  '<meta http-equiv="cache control" content="no-cache, no-store, must-revalidate" />',
  '<meta name="robots" content="noindex, follow" />',
  '<title>Error</title>',
  '</head>',
  '<body>',
  '<h1></h1>',
  "<p>We're sorry, an error has occurred.  Please try again later.</p>",
  '</body>',
  '</html>',
  '',
  '',
  '',
].join('\r\n');

/** Reason phrase legacy's error handler sets with the error page (onError_include.cfm:144). */
export const LEGACY_ERROR_STATUS_TEXT = 'An Error Occurred';

// Wire form measured on the legacy oracle: the servlet container drops the space before `charset`.
/** Content type legacy sends with CFML page output, the error page included. */
export const LEGACY_HTML_CONTENT_TYPE = 'text/html;charset=UTF-8';

/** Inputs of the legacy headers both 503 surfaces carry. */
export interface LegacyHeaderOptions {
  /** HSTS max-age; 0 omits the header. */
  hstsMaxAge?: number;
  /** Masa version reported in `Generator`. */
  version?: string;
}

/** Options of the JSON API 503; `params` stay suppressed unless `suppressAPIParams` is false. */
export interface ApiUnavailableOptions
  extends Pick<LegacyErrorResponseOptions, 'method' | 'params' | 'methodCtx' | 'suppressAPIParams'>,
    LegacyHeaderOptions {}

/** Status, headers and exact body of a legacy-shaped 503; `statusText` is set on the admin page only. */
export interface LegacyUnavailableResponse extends SerializedLegacyResponse {
  statusText?: string;
}

/** Surface a 503 is rendered on. */
export type UnavailableSurface = Exclude<LegacyErrorSurface, 'auto'>;

const API_SURFACE_FAMILIES: ReadonlySet<string> = new Set(['api', 'rest', 'feed', 'render', 'fixture', 'opt2']);

/** JSON API 503: the `server_error` envelope with its ETag, plus the legacy headers. */
export function apiUnavailableResponse(a: ApiUnavailableOptions = {}): LegacyUnavailableResponse {
  const { hstsMaxAge, version, ...errorOptions } = a;
  const { headers, body } = legacyErrorResponse('server_error', errorOptions);
  return { status: 503, headers: { ...headers, ...legacyHeaders(version, hstsMaxAge) }, body };
}

/** Admin 503: the legacy error page with its reason phrase and the legacy headers. */
export function adminUnavailableResponse(a: LegacyHeaderOptions = {}): LegacyUnavailableResponse & { statusText: string } {
  return {
    status: 503,
    statusText: LEGACY_ERROR_STATUS_TEXT,
    headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE, ...legacyHeaders(a.version, a.hstsMaxAge) },
    body: LEGACY_ERROR_PAGE_HTML,
  };
}

/** Surface a route family answers a 503 on: `api` for the API-style families, `admin` for every other family. */
export function unavailableSurfaceForFamily(routeFamily: string): UnavailableSurface {
  return API_SURFACE_FAMILIES.has(routeFamily) ? 'api' : 'admin';
}

/** Legacy-shaped 503 on `surface`; the admin page ignores the API options. */
export function unavailableResponseFor(
  surface: UnavailableSurface,
  ctx: ApiUnavailableOptions = {},
): LegacyUnavailableResponse {
  return surface === 'api' ? apiUnavailableResponse(ctx) : adminUnavailableResponse(ctx);
}

/** Legacy-shaped 503 for `err`: its explicit surface, else the surface its route family selects. */
export function renderUnavailable(
  err: LegacyServiceUnavailableError,
  routeFamily: string,
  ctx: ApiUnavailableOptions = {},
): LegacyUnavailableResponse {
  return unavailableResponseFor(err.surface === 'auto' ? unavailableSurfaceForFamily(routeFamily) : err.surface, ctx);
}
