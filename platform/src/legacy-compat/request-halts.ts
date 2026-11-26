// Halts the request alone decides: unstorable text, a Site Manager list of an unregistered site, a login redirect Node cannot send.
import { sendsNodeRefusedLocationBytes } from './location.js';
import type { RouteKeyOptions, RouteKeyResult } from './route-key.js';
import type { ScannedRouteKey, ScannedRouteKeyRequest } from './scanned-route-key.js';
import { textHaltedRouteKey } from './unstorable-text.js';

/**
 * Variant of a Site Manager list whose rc `siteid` names no registered site, for which `getSite` answers the `default`
 * site (settingsManager.cfc:537-566) and carch's gate, list and view read and write its values; no cut-over entry carries
 * it, so legacy serves it.
 */
export const UNREGISTERED_SITE_HALT_VARIANT = 'siteid=unregistered';

/**
 * Variant of an admin login whose redirect legacy sends with a `Location` byte Node's HTTP server writes in no header
 * (loginManager.cfc:154,240); no cut-over entry carries it, so legacy serves it and the gateway relays its head raw.
 */
export const RAW_LOCATION_HALT_VARIANT = 'location=raw';

/** The halt variants {@link haltedRouteKey} adds to {@link textHaltedRouteKey}'s. */
export const REQUEST_HALT_VARIANTS: readonly string[] = Object.freeze([UNREGISTERED_SITE_HALT_VARIANT, RAW_LOCATION_HALT_VARIANT]);

const SITE_LIST_KEY = 'admin:carch.list';
const LOGIN_KEY = 'admin:clogin.login';

/** rc values a login redirect carries as sent: handleSuccess's `returnURL` and `linkServID`, handleFailure's `rememberMe`, `contentid` and `linkServID` (loginManager.cfc:110-156,236-241). */
const LOCATION_PARAMS: readonly string[] = ['returnurl', 'linkservid', 'contentid', 'rememberme'];

/** The halt variant of an unhalted key, if the request calls for one; a declared variant of either key already runs on legacy. */
function requestHaltVariant(result: RouteKeyResult, options: RouteKeyOptions): string | undefined {
  if (result.key === SITE_LIST_KEY) {
    // An empty rc.siteid takes the session's site, which is registered (admin/Application.cfc:384-412).
    const siteId = result.params.siteid ?? '';
    const exists = options.siteExists ?? (() => true);
    return siteId !== '' && !exists(siteId) ? UNREGISTERED_SITE_HALT_VARIANT : undefined;
  }
  if (result.key === LOGIN_KEY) {
    return LOCATION_PARAMS.some((name) => sendsNodeRefusedLocationBytes(result.params[name] ?? '')) ? RAW_LOCATION_HALT_VARIANT : undefined;
  }
  return undefined;
}

/**
 * The key the gateway routes `sent` under: {@link textHaltedRouteKey}'s, except that an unhalted Site Manager list of an
 * unregistered site keys under {@link UNREGISTERED_SITE_HALT_VARIANT}, and an unhalted admin login one of whose redirect
 * values legacy sends a Node-refused byte for under {@link RAW_LOCATION_HALT_VARIANT}; `unhalted` is then the key replaced.
 */
export function haltedRouteKey(sent: ScannedRouteKeyRequest, options: RouteKeyOptions = {}): ScannedRouteKey {
  const scanned = textHaltedRouteKey(sent, options);
  if (scanned.unhalted !== undefined) return scanned;
  const { result } = scanned;
  const variant = requestHaltVariant(result, options);
  if (variant === undefined) return scanned;
  return { ...scanned, result: { ...result, key: `${result.baseKey}{${variant}}`, variant }, unhalted: result };
}
