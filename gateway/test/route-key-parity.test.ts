// The shared route-key conflict table through the dispatcher's matcher over the committed variants.json and v0001 index.
import { routeKeyForRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { routeKeyCaseOptions, routeKeyCaseVariants, routeKeyConflictCases } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../src/admin/response-modes.js';
import { createMatcher } from '../src/dispatcher/match.js';
import { TEST_CLOCK, testEnv } from './helpers/env.js';
import { matcherInputFromCase } from './helpers/requests.js';
import { committedIndex, committedVariants, fakeCutoverState } from './helpers/versions.js';

const index = await committedIndex('v0001');
const variants = committedVariants();

const matcher = createMatcher({
  state: fakeCutoverState(index),
  variants,
  modes: createResponseModes({ get: () => undefined, routes: () => [] }),
  env: testEnv(),
  clock: TEST_CLOCK,
  // The matcher replaces these options' variants with the committed variants.json.
  routeKeyOptions: routeKeyCaseOptions,
});

/** What dispatch reads from a key: the key, its family and the request site. */
function routed(result: RouteKeyResult | undefined): Pick<RouteKeyResult, 'key' | 'family' | 'siteId'> | undefined {
  return result === undefined ? undefined : { key: result.key, family: result.family, siteId: result.siteId };
}

describe('route-key parity with the dispatcher matcher', () => {
  it('committed variants.json equals the shared case variants', () => {
    expect(variants.variants).toEqual(routeKeyCaseVariants);
  });

  it.each(routeKeyConflictCases)('$name', async (c) => {
    const { request, body } = matcherInputFromCase(c);
    const outcome = await matcher.match(request, body, index);
    expect(outcome.result?.key).toBe(c.expectedKey);
    expect(routed(outcome.result)).toEqual(routed(routeKeyForRequest(c.request, routeKeyCaseOptions)));

    // The exact entry wins; otherwise only a glob may match, so a variant never falls back to its base entry.
    const exact = index.entryFor(c.expectedKey);
    if (exact !== undefined) expect(outcome.entry).toBe(exact);
    else if (outcome.entry !== undefined) expect(outcome.entry.route).toMatch(/\/\*\*$/);
    else expect(outcome.destination).toEqual({ kind: 'legacy' });
  });
});
