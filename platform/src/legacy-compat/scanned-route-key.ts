// Route key of a request as legacy serves it: the reload decided on the url as sent, the route on the scanned scopes.
import { portcullisScan } from './portcullis.js';
import { legacyScopeParams, legacyScopesFrom, portcullisInputsOf } from './request-scopes.js';
import { routeKeyForRequest, type RouteFamily, type RouteKeyOptions, type RouteKeyRequest, type RouteKeyResult } from './route-key.js';

/** Variant of a request whose scan outcome ColdFusion's runtime decides; no cut-over entry carries it, so legacy serves it. */
export const SCAN_HALT_VARIANT = 'scriptprotect=fault';

/** Families never halted: no legacy scan (opt2, static), unreachable from the edge (bridge), no request value read (sitemonitor). */
const UNHALTED_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['opt2', 'static', 'bridge', 'sitemonitor']);

/** A route-key request and, optionally, its target as sent, whose query string orders url values of names differing only in case. */
export interface ScannedRouteKeyRequest extends RouteKeyRequest {
  url?: string;
}

/** A request's route key, the url scope it read and whether legacy's start-up scan fails on the request. */
export interface ScannedRouteKey {
  result: RouteKeyResult;
  /** The url scope as start-up's script protection leaves it: one spelling per name, values as text. */
  urlScope: Record<string, string>;
  /** Whether legacy's scan throws on the url or the form scope, multipart file fields included. */
  scanFailed: boolean;
  /** The key `result` replaces when it carries {@link SCAN_HALT_VARIANT}: the one the scopes read as the port leaves them. */
  unhalted?: RouteKeyResult;
}

/** `result` under the halt variant, which replaces any declared one. */
function halted(result: RouteKeyResult): RouteKeyResult {
  return { ...result, key: `${result.baseKey}{${SCAN_HALT_VARIANT}}`, variant: SCAN_HALT_VARIANT };
}

/** Url or form fields as ColdFusion builds the scope: names differing only in case joined, values as text. */
function cfScope(fields: unknown, target?: string): Record<string, unknown> {
  return Object.fromEntries(portcullisInputsOf(fields, target).map(([key, value]) => [key, value]));
}

/** Header `name` (lower-case) ignoring case; repeated values joined with `, `. */
function headerOf(headers: RouteKeyRequest['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** The last spelling of `name` (lower-case) among the keys of `scope`. */
function spellingOf(scope: object, name: string): string | undefined {
  return Object.keys(scope).findLast((key) => key.toLowerCase() === name);
}

/** `scope.muraAction = scope.fuseaction`, as admin's Application.cfc runs it on the scope as sent (admin/Application.cfc:161-166). */
function withFuseaction<T>(scope: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const fuseaction = spellingOf(scope, 'fuseaction');
  if (fuseaction === undefined) return scope;
  const rest = Object.fromEntries(Object.entries(scope).filter(([name]) => name.toLowerCase() !== 'muraaction'));
  return { ...rest, muraAction: scope[fuseaction] as T };
}

/** Scanned admin params without a `fuseaction` the scan set apart from `muraAction`, so the key's own copy changes nothing. */
function settledAdmin(params: Record<string, string>): Record<string, string> {
  const fuseaction = spellingOf(params, 'fuseaction');
  const muraAction = spellingOf(params, 'muraaction');
  if (fuseaction !== undefined && (muraAction === undefined || params[muraAction] !== params[fuseaction])) delete params[fuseaction];
  return params;
}

/**
 * The key legacy serves `sent` under: reload as the url was sent (onRequestStart_include.cfm:114-138), the route on the
 * url and form scopes start-up's scan leaves, an admin scope's `fuseaction` copied first; JSON bodies and file names as sent.
 * A scope the scan fails on is keyed on its name and NUL fixes, never thrown. Where ColdFusion's runtime decides the
 * outcome (an admin scan fault, whose guard keeps what the scan reached in hash order; a runtime-decided scope), the key
 * carries {@link SCAN_HALT_VARIANT}; a reload, which legacy always serves, never does.
 */
export function scannedRouteKey(sent: ScannedRouteKeyRequest, options: RouteKeyOptions = {}): ScannedRouteKey {
  const asSent = routeKeyForRequest(sent, options);
  const admin = (asSent.afterReload ?? asSent).family === 'admin';
  // ColdFusion joins names differing only in case as it builds each scope, before admin's copy and the scan.
  const query = cfScope(sent.query, sent.url);
  const body = admin ? withFuseaction(cfScope(sent.form)) : cfScope(sent.form);
  const scopes = legacyScopesFrom({
    query: admin ? withFuseaction(query) : query,
    body,
    headers: { 'content-type': headerOf(sent.headers, 'content-type') },
  });
  const url = legacyScopeParams(scopes.url);
  const form = legacyScopeParams(scopes.form);
  // A file field's value is opaque to the scan, but its name is checked; it shares the form scope with the text fields.
  const files = (sent.multipartFileNames ?? []).map(({ field, filename }) => [field, filename, true] as const);
  const formScan = portcullisScan([...(scopes.json || scopes.url.failed ? [] : portcullisInputsOf(body)), ...files]);
  const scanFailed = scopes.url.failed || scopes.form.failed || formScan.failed;
  const scanned = routeKeyForRequest({ ...sent, query: admin ? settledAdmin(url) : url, form: admin ? settledAdmin(form) : form }, options);
  const served = scanned.afterReload ?? scanned;
  if (asSent.family !== 'reload') {
    const runtimeDecided = scopes.url.runtimeDecided === true || formScan.runtimeDecided === true;
    if (UNHALTED_FAMILIES.has(served.family) || !(runtimeDecided || (served.family === 'admin' && scanFailed))) {
      return { result: served, urlScope: url, scanFailed };
    }
    return { result: halted(served), urlScope: url, scanFailed, unhalted: served };
  }
  return { result: scanned.family === 'reload' ? scanned : { ...asSent, afterReload: served }, urlScope: url, scanFailed };
}
