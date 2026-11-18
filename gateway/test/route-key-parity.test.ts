// The shared route-key conflict table through the dispatcher's matcher over the committed variants.json and v0001 index,
// the inventoried remote-function keys under app.ts's own route-key options, and v0002 routing of moved and halted entries.
import { matchRouteKey, routeKeyForRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
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
    const shared = routeKeyForRequest(c.request, routeKeyCaseOptions);
    expect(shared.key).toBe(c.expectedKey);
    // A legacy-bound opt2 request is keyed as legacy's own pipeline serves it.
    const served =
      shared.family === 'opt2' && outcome.destination.kind === 'legacy'
        ? routeKeyForRequest(c.request, { ...routeKeyCaseOptions, opt2Namespaces: false })
        : shared;
    expect(outcome.result?.key).toBe(served.key);
    expect(routed(outcome.result)).toEqual(routed(served));

    // The exact entry wins; otherwise only a glob may match, so a variant never falls back to its base entry.
    const exact = index.entryFor(served.key);
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

/** Every inventoried remote-function key, `<family>:<entity>.~<function>`; a `{variant}` key keys another spelling of the same call. */
const remoteFunctionKeys = facts.routes().filter((route) => route.includes('.~') && !route.includes('{'));

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

// The committed v0002 through app.ts's options: the synthetic screens and the comment, feed and form writes.
const v0002 = await committedIndex('v0002');
const v0002Matcher = createMatcher({
  state: fakeCutoverState(v0002),
  variants,
  modes: createResponseModes(facts),
  env: testEnv(),
  clock: TEST_CLOCK,
  routeKeyOptions: gatewayOptions,
});

/** The shared conflict case named `name`. */
function sharedCase(name: string): RouteKeyConflictCase {
  const found = routeKeyConflictCases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no shared route-key case ${name}`);
  return found;
}

/** A request with no body, keyed `expectedKey`. */
function bodiless(method: string, path: string, query: Record<string, string>, expectedKey: string): RouteKeyConflictCase {
  return { name: expectedKey, source: 'gateway/cutover/versions/v0002.json', request: { method, path, query, headers: {} }, expectedKey };
}

const TENANT = { siteid: 'tenant-a' };

describe("v0002 routing through the gateway's route-key options", () => {
  it.each<[string, RouteKeyConflictCase, Partial<CutoverEntry>, 'target' | 'legacy']>([
    [
      'the reporting export list',
      bodiless('GET', '/opt2/admin/reporting/exports', TENANT, 'opt2:/opt2/admin/reporting/exports'),
      { route: 'opt2:/opt2/admin/reporting/**', state: 'target', kind: 'read', units: ['reporting.export_job'] },
      'target',
    ],
    [
      'a reporting queue action',
      bodiless('POST', '/opt2/admin-actions/reporting/queue', TENANT, 'opt2:/opt2/admin-actions/reporting/queue'),
      { route: 'opt2:/opt2/admin-actions/reporting/**', state: 'target', kind: 'write' },
      'target',
    ],
    [
      'the communications templates',
      bodiless('GET', '/opt2/admin/communications/templates', TENANT, 'opt2:/opt2/admin/communications/templates'),
      { route: 'opt2:/opt2/admin/communications/**', state: 'target', kind: 'read' },
      'target',
    ],
    [
      'the timesheet list, whose sheets no carry entry writes',
      bodiless('GET', '/opt2/admin/timesheets/sheets', TENANT, 'opt2:/opt2/admin/timesheets/sheets'),
      { route: 'opt2:/opt2/admin/timesheets/**', state: 'legacy', kind: 'read' },
      'legacy',
    ],
    [
      'a compact-display feed save',
      sharedCase('admin-cfeed-update-close-compact-display-variant'),
      { route: 'admin:cfeed.update{closecompactdisplay=true}', state: 'legacy', kind: 'legacy-write' },
      'legacy',
    ],
    [
      'a form import with its zip',
      sharedCase('admin-cform-importform-zip-part-variant'),
      { route: 'admin:cform.importform{formzip}', state: 'legacy', kind: 'legacy-write' },
      'legacy',
    ],
    [
      'a single comment approval',
      bodiless('GET', '/admin/', { muraAction: 'cComments.singleEdit', updateaction: 'approve' }, 'admin:ccomments.singleedit'),
      {
        route: 'admin:ccomments.singleedit',
        state: 'target',
        kind: 'write',
        group: 'grp:content.comment',
        units: expect.arrayContaining(['content.commenter']),
      },
      'target',
    ],
  ])('routes %s', async (_label, c, expected, destination) => {
    const shared = routeKeyForRequest(c.request, { ...gatewayOptions, variants: variants.variants });
    expect(shared.key).toBe(c.expectedKey);
    const entry = v0002.entryFor(matchRouteKey(shared, v0002.matchKeys) ?? '');
    expect(entry).toMatchObject(expected);
    const { request, body } = matcherInputFromCase(c);
    const outcome = await v0002Matcher.match(request, body, v0002);
    expect(outcome.destination.kind).toBe(destination);
    if (destination === 'target') {
      expect(outcome.entry).toBe(entry);
      expect(outcome.destination).toMatchObject({ service: 'web' });
    } else if (entry?.kind === 'legacy-write') {
      expect(outcome.entry).toBe(entry);
    }
  });
});
