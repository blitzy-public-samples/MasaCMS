// The shared route-key conflict table through the dispatcher's matcher over the committed variants.json and v0001 index,
// and the inventoried remote-function keys under app.ts's own route-key options.
import { routeKeyForRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import {
  routeKeyCaseOptions,
  routeKeyCaseVariants,
  routeKeyConflictCases,
  type RouteKeyConflictCase,
} from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../src/admin/response-modes.js';
import { routeKeyOptionsOf } from '../src/app.js';
import { loadInventoryFacts } from '../src/cutover/loader.js';
import { resolveGatewayPaths } from '../src/cutover/paths.js';
import type { CutoverEntry, EntryKind } from '../src/cutover/types.js';
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

// app.ts's own route-key options over the committed inventory, as buildApp wires them.
const facts = await loadInventoryFacts(resolveGatewayPaths({}));
const gatewayOptions = routeKeyOptionsOf(testEnv(), facts);
const gatewayMatcher = createMatcher({
  state: fakeCutoverState(index),
  variants,
  modes: createResponseModes(facts),
  env: testEnv(),
  clock: TEST_CLOCK,
  routeKeyOptions: gatewayOptions,
});

/** Every inventoried remote-function key, `<family>:<entity>.~<function>`. */
const remoteFunctionKeys = facts.routes().filter((route) => route.includes('.~'));

/** A JSON API or REST request to the default site, keyed `expectedKey`; a form is sent url-encoded. */
function apiCall(method: string, path: string, parts: ApiCallParts, expectedKey: string): RouteKeyConflictCase {
  const request: RouteKeyConflictCase['request'] = { method, path, query: parts.query ?? {}, headers: {} };
  if (parts.form !== undefined) {
    request.form = parts.form;
    request.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return { name: expectedKey, source: 'core/mura/client/api/json/v1/jsonApiUtility.cfc:953-960,1165-1171', request, expectedKey };
}

/** Query and form fields of {@link apiCall}. */
interface ApiCallParts {
  query?: Record<string, string>;
  form?: Record<string, string>;
}

/** The v0001 entry `c` matches through the gateway's options, once its key equals the inventory's and the platform's. */
async function gatewayEntry(c: RouteKeyConflictCase): Promise<CutoverEntry | undefined> {
  const { request, body } = matcherInputFromCase(c);
  const outcome = await gatewayMatcher.match(request, body, index);
  expect(outcome.result?.key).toBe(c.expectedKey);
  expect(routed(outcome.result)).toEqual(routed(routeKeyForRequest(c.request, { ...gatewayOptions, variants: variants.variants })));
  expect(outcome.entry).toBe(index.entryFor(c.expectedKey));
  return outcome.entry;
}

const DEFAULT_API = '/_api/json/v1/default';
const DEFAULT_REST = '/_api/rest/v1/default';

describe("remote-function keys through the gateway's route-key options", () => {
  it.each<[string, RouteKeyConflictCase, EntryKind]>([
    ['a dotted method in the query', apiCall('POST', `${DEFAULT_API}/`, { query: { method: 'comment.flag', commentid: 'X' } }, 'api:comment.~flag'), 'write'],
    ['its REST twin', apiCall('POST', `${DEFAULT_REST}/`, { query: { method: 'comment.flag', commentid: 'X' } }, 'rest:comment.~flag'), 'write'],
    [
      'a dotted form method against a path entity',
      apiCall('POST', `${DEFAULT_API}/content/`, { form: { method: 'comment.markAsSpam' } }, 'api:comment.~markasspam'),
      'write',
    ],
    ['the entity path form', apiCall('POST', `${DEFAULT_API}/comment/undelete`, {}, 'api:comment.~undelete'), 'write'],
    ['a mixed-case function name', apiCall('GET', `${DEFAULT_API}/`, { query: { method: 'user.pollState' } }, 'api:user.~pollstate'), 'read'],
    [
      'a file browser form call',
      apiCall('POST', `${DEFAULT_REST}/`, { form: { method: 'filebrowser.ckeditor_quick_upload' } }, 'rest:filebrowser.~ckeditor_quick_upload'),
      'read',
    ],
  ])('keys %s as its inventoried entry', async (_label, c, kind) => {
    expect((await gatewayEntry(c))?.kind).toBe(kind);
  });

  it('finds remote-function keys in the inventory', () => {
    expect(remoteFunctionKeys.length).toBeGreaterThan(0);
  });

  it.each(remoteFunctionKeys)('derives %s and keys its dotted call as its v0001 entry', async (key) => {
    const [family = '', call = ''] = key.split(':');
    const [entity = '', name = ''] = call.split('.~');
    expect(facts.entityRemoteFunctions[entity]).toContain(name);
    const root = family === 'rest' ? DEFAULT_REST : DEFAULT_API;
    expect(await gatewayEntry(apiCall('POST', `${root}/`, { query: { method: `${entity}.${name}` } }, key))).toBeDefined();
  });
});
