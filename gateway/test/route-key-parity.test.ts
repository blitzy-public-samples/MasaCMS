// The shared route-key conflict table through the dispatcher's matcher: the key, family and site the platform computes.
import { routeKeyForRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { fixedClock, routeKeyCaseOptions, routeKeyConflictCases } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../src/admin/response-modes.js';
import { createMatcher } from '../src/dispatcher/match.js';
import { matcherInputFromCase } from './helpers/requests.js';

const { variants = [], ...routeKeyOptions } = routeKeyCaseOptions;

// No active version: every request is keyed, and nothing is routed.
const matcher = createMatcher({
  state: { active: () => undefined },
  variants: { sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f', variants: [...variants] },
  modes: createResponseModes({ get: () => undefined, routes: () => [] }),
  env: { OPT2_SERVICE_URLS: {}, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: '/nonexistent' },
  clock: fixedClock('2026-06-30T12:00:00Z'),
  routeKeyOptions,
});

/** What dispatch reads from a key: the key, its family and the request site. */
function routed(result: RouteKeyResult | undefined): Pick<RouteKeyResult, 'key' | 'family' | 'siteId'> | undefined {
  return result === undefined ? undefined : { key: result.key, family: result.family, siteId: result.siteId };
}

describe('route-key parity with the dispatcher matcher', () => {
  it.each(routeKeyConflictCases)('$name', async (c) => {
    const { request, body } = matcherInputFromCase(c);
    const { result } = await matcher.match(request, body);
    expect(result?.key).toBe(c.expectedKey);
    expect(routed(result)).toEqual(routed(routeKeyForRequest(c.request, routeKeyCaseOptions)));
  });
});
