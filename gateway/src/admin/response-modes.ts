// Inventoried response mode of each admin action, which selects the web handler a target admin request is sent to.
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import type { InventoryFacts, ResponseMode, RouteFacts } from '../cutover/types.js';

const ADMIN_PREFIX = 'admin:';

/** Shape of a legacy admin response: page, fragment, json, redirect or download. */
export type AdminResponseMode = ResponseMode;

/** An admin action's response mode, with the content type legacy answers with where the inventory records one. */
export interface AdminResponseModeInfo {
  readonly responseMode: AdminResponseMode;
  readonly contentType?: string;
}

/** Response-mode lookup by admin route key. */
export interface ResponseModes {
  /** Mode of an admin key, or of its base key when its variant has none; `undefined` for other families and unrecorded keys. */
  modeFor(routeKey: string): AdminResponseModeInfo | undefined;
}

/** Frozen mode info of one route's facts; `undefined` when they record no mode. */
function infoOf(routeFacts: RouteFacts | undefined): AdminResponseModeInfo | undefined {
  const responseMode = routeFacts?.responseMode;
  if (responseMode === undefined) return undefined;
  const contentType = routeFacts?.contentType;
  return Object.freeze(contentType === undefined ? { responseMode } : { responseMode, contentType });
}

/** Indexes the response modes the inventory facts record for admin-family route keys. */
export function createResponseModes(facts: InventoryFacts): ResponseModes {
  const modes = new Map<string, AdminResponseModeInfo>();
  for (const route of facts.routes()) {
    const key = normaliseRouteKey(route);
    if (!key.startsWith(ADMIN_PREFIX)) continue;
    const info = infoOf(facts.get(route));
    if (info !== undefined) modes.set(key, info);
  }

  return Object.freeze({
    modeFor(routeKey: string): AdminResponseModeInfo | undefined {
      const key = normaliseRouteKey(routeKey);
      // Fixture keys carry braces (`{id}`) that are not variants, so only admin keys derive a base key.
      if (!key.startsWith(ADMIN_PREFIX)) return undefined;
      const own = modes.get(key);
      if (own !== undefined) return own;
      const variantAt = key.indexOf('{');
      return variantAt > 0 && key.endsWith('}') ? modes.get(key.slice(0, variantAt)) : undefined;
    },
  });
}
