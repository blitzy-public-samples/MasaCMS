// The shared route-key conflict table through the harness's inventory keying and golden coverage keying.
import {
  matchRouteKey,
  normaliseRouteKey,
  routeKeyForRequest,
  type RouteKeyOptions,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { routeKeyCaseOptions, routeKeyCaseVariants, routeKeyConflictCases } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { coverageRouteKey, coverageRouteResults, fromRouteKeyRequest, toRouteKeyRequest } from '../src/golden/coverage.js';
import {
  inventoryRouteKeyForRequest,
  loadInventoryVariants,
  normaliseInventoryKey,
  variantsFor,
} from '../src/inventory/route-keys.js';

const committed = await loadInventoryVariants();

/** The case options over the committed variants.json, as both harness paths receive them. */
const options: RouteKeyOptions = { ...routeKeyCaseOptions, variants: committed.variants };

/** What a cover match reads from a key: the key, its base, family, variant and request site. */
function keyed(result: RouteKeyResult): Pick<RouteKeyResult, 'key' | 'baseKey' | 'family' | 'variant' | 'siteId'> {
  return { key: result.key, baseKey: result.baseKey, family: result.family, variant: result.variant, siteId: result.siteId };
}

describe('route-key parity with the harness inventory and coverage gate', () => {
  it('has a non-empty case table with unique names', () => {
    const names = routeKeyConflictCases.map((c) => c.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('committed variants.json equals the shared case variants', () => {
    expect(committed.variants).toStrictEqual(routeKeyCaseVariants);
    expect(routeKeyCaseOptions.variants).toBe(routeKeyCaseVariants);
  });

  it.each(routeKeyConflictCases)('keys $name identically on the inventory path', async (c) => {
    const shared = routeKeyForRequest(c.request, routeKeyCaseOptions);
    const inventoried = await inventoryRouteKeyForRequest(c.request, options);
    expect(inventoried.key, c.source).toBe(c.expectedKey);
    expect(inventoried).toStrictEqual(shared);
    expect(normaliseInventoryKey(inventoried.key)).toBe(inventoried.key);
  });

  it.each(routeKeyConflictCases)('keys $name identically on the coverage path', (c) => {
    const shared = routeKeyForRequest(c.request, routeKeyCaseOptions);
    const step = fromRouteKeyRequest(c.request);
    expect(coverageRouteKey(step, options), c.source).toBe(c.expectedKey);
    expect(coverageRouteResults(step, options).map(keyed)).toStrictEqual([keyed(shared)]);
    // The catalogue step must carry every request fact the key depends on.
    expect(routeKeyForRequest(toRouteKeyRequest(step), routeKeyCaseOptions).key, c.source).toBe(c.expectedKey);
  });

  it.each(routeKeyConflictCases)('matches $name to its own entry and never falls back from a variant to its base', (c) => {
    const shared = routeKeyForRequest(c.request, routeKeyCaseOptions);
    expect(normaliseRouteKey(c.expectedKey)).toBe(c.expectedKey);
    expect(matchRouteKey(shared, [shared.baseKey, c.expectedKey]), c.source).toBe(c.expectedKey);
    if (shared.variant === undefined) return;
    expect(matchRouteKey(shared, [shared.baseKey])).toBeUndefined();
    expect(variantsFor(shared.baseKey, committed.variants).map((v) => v.variant)).toContain(shared.variant);
  });
});
