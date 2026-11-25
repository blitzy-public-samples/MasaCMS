// Text PostgreSQL cannot hold as legacy holds it: unpaired UTF-16 surrogates, written as legacy's answers write them, and NUL; requests storing a NUL halted to legacy.
import { isJsonContentType } from './request-scopes.js';
import { fixtureDispatchPath, routeKeyForRequest, type RouteFamily, type RouteKeyOptions, type RouteKeyResult } from './route-key.js';
import { scannedRouteKey, type ScannedRouteKey, type ScannedRouteKeyRequest } from './scanned-route-key.js';

const UNPAIRED_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = /\0/;

/** `text` as Java's UTF-8 encoder writes it, in legacy's responses and mail: each unpaired UTF-16 surrogate as `?`. */
export function javaUtf8Text(text: string): string {
  return text.replace(UNPAIRED_SURROGATES, '?');
}

/**
 * Variant of a request whose JSON body holds a NUL, which legacy stores and PostgreSQL text cannot, or whose fixture path,
 * JSON API or REST param values or admin path pairs do, which legacy binds unscanned and PostgreSQL cannot; no cut-over entry
 * carries it, so legacy serves it.
 */
export const NUL_TEXT_HALT_VARIANT = 'text=nul';

/** Families whose legacy handler merges a JSON object body into the params it stores (jsonApiUtility.cfc:405-412, fixture api.cfm). */
const JSON_BODY_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['api', 'rest', 'fixture']);

/** Families whose params also take the path's site, entity, id and path-pair values, which no scan strips (jsonApiUtility.cfc:903-1660). */
const PATH_PARAM_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['api', 'rest']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Header `name` (lower-case) ignoring case; repeated values joined with `, `. */
function headerOf(headers: ScannedRouteKeyRequest['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** Whether a key or string anywhere in the parsed JSON value `json` matches `text`; iterative, so no nesting depth exhausts the stack. */
function holdsText(json: unknown, text: RegExp): boolean {
  const pending: unknown[] = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (text.test(value)) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (text.test(key)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

/** Whether the path_info items api.cfm reads from a fixture request's raw `path` hold a NUL. */
function fixturePathHoldsNul(path: string, options: RouteKeyOptions): boolean {
  // Each item comes back URI-encoded: a NUL as `%00`, a literal `%` as `%25`.
  return fixtureDispatchPath(path, options)?.includes('%00') === true;
}

/** Whether an admin rc `params` keeps a path pair (framework.cfc:602-626) whose name or value holds a NUL; no scan reads path pairs. */
function adminPathPairHoldsNul(sent: ScannedRouteKeyRequest, params: Readonly<Record<string, string>>, options: RouteKeyOptions): boolean {
  // The family follows from the path alone, so the path keyed without scopes keys admin with only its pairs.
  const pairs = routeKeyForRequest({ method: sent.method, path: sent.path, query: {}, headers: {} }, options);
  // Action segments set only `muraaction`: a NUL there keys an unlisted action, unless url or form replaced it.
  return Object.entries(pairs.params).some(
    ([name, value]) => name !== 'muraaction' && (name + value).includes('\0') && params[name] === value,
  );
}

/** The text halt variant of an unhalted admin or JSON body family request keyed `result`, if its path, params or JSON body call for one. */
function textHaltVariant(sent: ScannedRouteKeyRequest, result: RouteKeyResult, options: RouteKeyOptions): string | undefined {
  if (result.family === 'admin') return adminPathPairHoldsNul(sent, result.params, options) ? NUL_TEXT_HALT_VARIANT : undefined;
  if (result.family === 'fixture' && fixturePathHoldsNul(sent.path, options)) return NUL_TEXT_HALT_VARIANT;
  const paramNul = PATH_PARAM_FAMILIES.has(result.family) && Object.values(result.params).some((value) => value.includes('\0'));
  if (paramNul) return NUL_TEXT_HALT_VARIANT;
  if (!isJsonContentType(headerOf(sent.headers, 'content-type')) || !isPlainObject(sent.jsonBody)) return undefined;
  return holdsText(sent.jsonBody, NUL) ? NUL_TEXT_HALT_VARIANT : undefined;
}

/**
 * The key the gateway routes `sent` under: {@link scannedRouteKey}'s, except that an unhalted fixture request whose path holds
 * a NUL, an unhalted JSON API or REST request a param value of which holds one (from the path, or Basic credentials), an
 * unhalted admin request whose rc keeps a path pair holding one, or an unhalted JSON API, REST or fixture request whose JSON
 * object body legacy merges, keys its base key under {@link NUL_TEXT_HALT_VARIANT} when the path, param, pair or body holds a
 * NUL; `unhalted` is then the key replaced.
 * Url and form scopes need no halt: legacy's start-up scan strips their values' NULs and a NUL name only adds its stripped
 * copy.
 */
export function textHaltedRouteKey(sent: ScannedRouteKeyRequest, options: RouteKeyOptions = {}): ScannedRouteKey {
  const scanned = scannedRouteKey(sent, options);
  const { result } = scanned;
  if (scanned.unhalted !== undefined || !(JSON_BODY_FAMILIES.has(result.family) || result.family === 'admin')) return scanned;
  const variant = textHaltVariant(sent, result, options);
  if (variant === undefined) return scanned;
  return { ...scanned, result: { ...result, key: `${result.baseKey}{${variant}}`, variant }, unhalted: result };
}
