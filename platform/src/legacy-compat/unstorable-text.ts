// Text PostgreSQL cannot hold as legacy holds it: unpaired UTF-16 surrogates, written as legacy's answers write them, and NUL; requests storing either halted to legacy.
import { isJsonContentType } from './request-scopes.js';
import { fixtureDispatchPath, routeKeyForRequest, type RouteFamily, type RouteKeyOptions, type RouteKeyResult } from './route-key.js';
import { scannedRouteKey, type ScannedRouteKey, type ScannedRouteKeyRequest } from './scanned-route-key.js';

const UNPAIRED_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUL = /\0/;

/** `text` as Java's UTF-8 encoder writes it, in legacy's responses and mail: each unpaired UTF-16 surrogate as `?`. */
export function javaUtf8Text(text: string): string {
  return text.replace(UNPAIRED_SURROGATES, '?');
}

/**
 * Variant of a request whose JSON body holds a NUL, which legacy stores and PostgreSQL text cannot, or whose fixture path,
 * JSON API or REST param values or admin path pairs do, which legacy binds unscanned and PostgreSQL cannot; no cut-over entry
 * carries it, so legacy serves it. The fixture writes the target answers exactly carry none, nor do finance, survey and
 * e-signature path ids.
 */
export const NUL_TEXT_HALT_VARIANT = 'text=nul';

/**
 * Variant of a fixture write storing request text whose JSON object body holds an unpaired surrogate, which legacy stores as
 * sent and PostgreSQL text cannot; no cut-over entry carries it, so legacy serves it.
 */
export const SURROGATE_TEXT_HALT_VARIANT = 'text=surrogate';

/** Families whose legacy handler merges a JSON object body into the params it stores (jsonApiUtility.cfc:405-412, fixture api.cfm). */
const JSON_BODY_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['api', 'rest', 'fixture']);

/** Families whose params also take the path's site, entity, id and path-pair values, which no scan strips (jsonApiUtility.cfc:903-1660). */
const PATH_PARAM_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['api', 'rest']);

/**
 * Fixture writes binding request text as `cf_sql_nvarchar` or `cf_sql_longnvarchar`, which store an unpaired surrogate's code
 * unit as sent (legacy-fixtures/cfml/modules). The other fixture routes store no request text.
 */
const RAW_TEXT_FIXTURE_WRITES: ReadonlySet<string> = new Set([
  'fixture:communications/messages@post',
  'fixture:communications/templates@post',
  'fixture:esignature/requests/{id}/sign@post',
  'fixture:esignature/requests@post',
  'fixture:finance/records/{id}/edit@post',
  'fixture:finance/records@post',
  'fixture:surveys/surveys/{id}/responses@post',
  'fixture:surveys/surveys/{id}/targets/bulk@post',
  'fixture:surveys/surveys@post',
  'fixture:timesheets/days/{id}/primary-approve@post',
  'fixture:timesheets/days/{id}/resubmit@post',
  'fixture:timesheets/days/{id}/return@post',
  'fixture:timesheets/days/{id}/secondary-approve@post',
  'fixture:timesheets/days/{id}/submit@post',
]);

/**
 * Fixture writes whose target answers a NUL in any text they read as legacy does, binding none, so no NUL halts them: served
 * by legacy, the export create starts a `cfthread` job and the schedule registers ACF tasks, both outliving the write window.
 */
const NUL_ANSWERED_FIXTURE_WRITES: ReadonlySet<string> = new Set(['fixture:reporting/exports@post', 'fixture:surveys/surveys/{id}/schedule@post']);

/**
 * Fixture modules whose services look up only CF UUIDs, so a path id holding a NUL finds no row there as in legacy's
 * `char(35)` lookup, after the same auth and CSRF checks.
 */
const NUL_ID_ANSWERED_FIXTURE_MODULES: ReadonlySet<string> = new Set(['finance', 'surveys', 'esignature']);

/** Whether a NUL in a fixture path keyed `key` lies only in the path ids the key names `{id}`, of a module answering them. */
function nulOnlyInAnsweredId(key: string): boolean {
  const module = key.slice('fixture:'.length).split('/', 1)[0] ?? '';
  return !key.includes('\0') && NUL_ID_ANSWERED_FIXTURE_MODULES.has(module);
}

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
  if (NUL_ANSWERED_FIXTURE_WRITES.has(result.baseKey)) return undefined;
  if (result.family === 'fixture' && fixturePathHoldsNul(sent.path, options) && !nulOnlyInAnsweredId(result.baseKey)) return NUL_TEXT_HALT_VARIANT;
  const paramNul = PATH_PARAM_FAMILIES.has(result.family) && Object.values(result.params).some((value) => value.includes('\0'));
  if (paramNul) return NUL_TEXT_HALT_VARIANT;
  if (!isJsonContentType(headerOf(sent.headers, 'content-type')) || !isPlainObject(sent.jsonBody)) return undefined;
  if (holdsText(sent.jsonBody, NUL)) return NUL_TEXT_HALT_VARIANT;
  const rawText = RAW_TEXT_FIXTURE_WRITES.has(result.baseKey) && holdsText(sent.jsonBody, UNPAIRED_SURROGATE);
  return rawText ? SURROGATE_TEXT_HALT_VARIANT : undefined;
}

/**
 * The key the gateway routes `sent` under: {@link scannedRouteKey}'s, except that an unhalted fixture request whose path holds
 * a NUL outside a finance, survey or e-signature path id, an unhalted JSON API or REST request a param value of which holds
 * one (from the path, or Basic credentials), an unhalted admin request whose rc keeps a path pair holding one, or an unhalted
 * JSON API, REST or fixture request whose JSON object body legacy merges, keys its base key under {@link NUL_TEXT_HALT_VARIANT}
 * when the path, param, pair or body holds a NUL, else under {@link SURROGATE_TEXT_HALT_VARIANT} when a fixture write storing
 * request text has a key or string in that body holding an unpaired surrogate; `unhalted` is then the key replaced. The
 * reporting export create and the survey schedule are never halted.
 * Url and form scopes need neither: legacy's start-up scan strips their values' NULs, a NUL name only adds its stripped
 * copy, and their decoding leaves no unpaired surrogate.
 */
export function textHaltedRouteKey(sent: ScannedRouteKeyRequest, options: RouteKeyOptions = {}): ScannedRouteKey {
  const scanned = scannedRouteKey(sent, options);
  const { result } = scanned;
  if (scanned.unhalted !== undefined || !(JSON_BODY_FAMILIES.has(result.family) || result.family === 'admin')) return scanned;
  const variant = textHaltVariant(sent, result, options);
  if (variant === undefined) return scanned;
  return { ...scanned, result: { ...result, key: `${result.baseKey}{${variant}}`, variant }, unhalted: result };
}
