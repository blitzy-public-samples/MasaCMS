// Matcher precedence and destinations, then whole-gateway dispatch to legacy, the stub, the bridge guard, internal 404s and the no-version 503.
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adminUnavailableResponse, apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { BUCKETS, SIGNED_URL_TTL_S, signLocalUrl, type BucketName } from '@opt2/platform/storage';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import type { CutoverEntry, InventoryFacts, OwningService, ResponseMode, RouteFacts, RoutingIndex } from '../../src/cutover/types.js';
import { bodyParamsFrom } from '../../src/dispatcher/body.js';
import { BUCKET_OWNERS, RELAY_ALIAS_PREFIX, createMatcher, type MatchOutcome, type Matcher } from '../../src/dispatcher/match.js';
import { buildTestGateway, operatorHeaders, type TestGateway } from '../helpers/app.js';
import { TEST_CLOCK, TEST_STORAGE_HMAC_KEY, prepareTestStateDir, testEnv } from '../helpers/env.js';
import type { LegacyOrigin } from '../helpers/legacy-origin.js';
import { fakeEdgeRequest, type FakeEdgeRequestInit } from '../helpers/requests.js';
import { committedIndex, committedVariants, cutoverTable, entry, fakeCutoverState, indexFor } from '../helpers/versions.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const FIXTURE_VERSION = 'v9001';
const NOW_S = Math.floor(TEST_CLOCK.now().getTime() / 1000);
const HMAC_KEY = Buffer.from(TEST_STORAGE_HMAC_KEY, 'utf8');
const FILES_PREFIX = 'opt2:/opt2/files/';
const FILES_CATCH_ALL = `${FILES_PREFIX}**`;
const STUB_NOTES = '/opt2/stub/notes';
const BRIDGE_SESSION = '/gateway/legacy-bridge/cfml/session.cfm';

/** Inventory facts recording only these admin response modes, looked up normalised as the loader does. */
function factsOf(modes: Readonly<Record<string, ResponseMode>>): InventoryFacts {
  const facts = new Map<string, RouteFacts>(
    Object.entries(modes).map(([route, responseMode]) => [
      route,
      { route, csrfValidation: 'none', responseMode, writeSet: [], keyScope: [], sessionEffects: ['none'] },
    ]),
  );
  return { get: (key) => facts.get(key.trim().toLowerCase()), routes: () => [...facts.keys()] };
}

const ADMIN_MODES: Readonly<Record<string, ResponseMode>> = {
  'admin:cperm.main': 'page',
  'admin:carch.loaddiff': 'fragment',
  'admin:carch.loadsitemanager': 'json',
  'admin:cusers.download': 'download',
  'admin:cperm.update': 'redirect',
  'admin:cusers.update': 'redirect',
};

function targetEntry(route: string, owningService: OwningService): CutoverEntry {
  return entry({ route, owningService, state: 'target' });
}

function indexOf(entries: readonly CutoverEntry[]): RoutingIndex {
  return indexFor(cutoverTable({ tableVersion: FIXTURE_VERSION, entries: [...entries] }));
}

const USERS_UPDATE_BASE = targetEntry('admin:cusers.update', 'people');
const USERS_UPDATE_GROUP = entry({ route: 'admin:cusers.update{type=1}', owningService: 'identity' });
const USERS_UPDATE_ROSTER = targetEntry('admin:cusers.update{type=2,action=update}', 'people');

const FIXTURE_INDEX = indexOf([
  USERS_UPDATE_BASE,
  USERS_UPDATE_GROUP,
  targetEntry('admin:cperm.main', 'identity'),
  targetEntry('admin:carch.loaddiff', 'strategies-content'),
  targetEntry('admin:carch.loadsitemanager', 'strategies-content'),
  targetEntry('admin:cusers.download', 'people'),
  targetEntry('admin:cperm.update', 'identity'),
  targetEntry('admin:cusers.list', 'people'),
  targetEntry('opt2:/opt2/stub/**', 'stub'),
  ...BUCKETS.map((bucket) => targetEntry(`${FILES_PREFIX}${bucket}/**`, BUCKET_OWNERS[bucket])),
  targetEntry(FILES_CATCH_ALL, 'strategies-content'),
]);

let stateDir: string;
let env: ReturnType<typeof testEnv>;
let matcher: Matcher;

/** A matcher over the committed variants whose own active version is `active`; matches pass their index explicitly. */
function matcherWith(active: RoutingIndex | undefined, storageAdapter: 'local' | 'cloud' = 'local'): Matcher {
  return createMatcher({
    state: fakeCutoverState(active),
    variants: committedVariants(),
    modes: createResponseModes(factsOf(ADMIN_MODES)),
    env: { ...env, OPT2_STORAGE_ADAPTER: storageAdapter },
    clock: TEST_CLOCK,
  });
}

beforeAll(async () => {
  stateDir = await prepareTestStateDir(await mkdtemp(path.join(tmpdir(), 'opt2-dispatcher-test-')));
  env = testEnv({ OPT2_STATE_DIR: stateDir });
  matcher = matcherWith(undefined);
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A request as the edge receives it; `form` fields are posted url-encoded. */
type RequestInit = Omit<FakeEdgeRequestInit, 'body' | 'contentType'> & { form?: Readonly<Record<string, string>> };

function matchOf(init: RequestInit, index: RoutingIndex | undefined, using: Matcher = matcher): Promise<MatchOutcome> {
  const { form, ...rest } = init;
  const body = form === undefined ? undefined : Buffer.from(new URLSearchParams(form).toString(), 'utf8');
  const contentType = body === undefined ? undefined : URLENCODED;
  const request = fakeEdgeRequest({ ...rest, body, contentType });
  return using.match(request, bodyParamsFrom(contentType, body, request.method), index);
}

/** POST of an admin action named in the query, with its fields in the body. */
function adminPost(muraAction: string, form: Readonly<Record<string, string>>): RequestInit {
  return { method: 'POST', path: '/admin/index.cfm', query: { muraAction }, form };
}

/** A signed URL under `/opt2/files/`, valid for the default TTL from the matcher's clock unless `expires` says otherwise. */
function signed(bucket: BucketName, key: string, expires = NOW_S + SIGNED_URL_TTL_S): string {
  return signLocalUrl({ bucket, key, expires }, HMAC_KEY);
}

/** The path and query of a request target, as `fakeEdgeRequest` takes them. */
function requestFor(url: string): RequestInit {
  const parsed = new URL(url, 'http://localhost');
  return { method: 'GET', path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) };
}

describe('matcher precedence', () => {
  it('routes a declared variant by its own entry, never by the target base entry', async () => {
    const group = await matchOf(adminPost('cUsers.update', { type: '1', userid: 'U1' }), FIXTURE_INDEX);
    expect(group.result?.key).toBe('admin:cusers.update{type=1}');
    expect(group.entry?.route).toBe(USERS_UPDATE_GROUP.route);
    expect(group.destination).toStrictEqual({ kind: 'legacy' });

    const roster = await matchOf(adminPost('cUsers.update', { type: '2', action: 'Update', userid: 'U1' }), FIXTURE_INDEX);
    expect(roster.result?.key).toBe('admin:cusers.update{type=2,action=update}');
    expect(roster.entry).toBeUndefined();
    expect(roster.destination).toStrictEqual({ kind: 'legacy' });

    const base = await matchOf(adminPost('cUsers.update', { userid: 'U1' }), FIXTURE_INDEX);
    expect(base.entry?.route).toBe(USERS_UPDATE_BASE.route);
    expect(base.destination).toMatchObject({ kind: 'target', service: 'web', path: '/admin-actions/cusers/update?muraAction=cUsers.update' });
  });

  it('routes the variant to its target owner once the version names it', async () => {
    const index = indexOf([USERS_UPDATE_BASE, USERS_UPDATE_GROUP, USERS_UPDATE_ROSTER]);
    const outcome = await matchOf(adminPost('cUsers.update', { type: '2', action: 'Update', userid: 'U1' }), index);
    expect(outcome.entry).toStrictEqual(index.entryFor(USERS_UPDATE_ROSTER.route));
    expect(outcome.entry?.owningService).toBe('people');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'web', isWeb: true, responseMode: 'redirect' });
  });

  it('variant key never falls back to its base key', async () => {
    const outcome = await matchOf(adminPost('cUsers.update', { type: '1', userid: 'U1' }), indexOf([USERS_UPDATE_BASE]));
    expect(outcome.result?.key).toBe('admin:cusers.update{type=1}');
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it.each<[string, RequestInit, string]>([
    ['an unknown admin action', { method: 'GET', path: '/admin/', query: { muraAction: 'cUsers.noSuchAction' } }, 'admin'],
    ['an unknown JSON API method', { method: 'GET', path: '/_api/json/v1/default/', query: { method: 'noSuchMethod' } }, 'api'],
  ])('sends %s, which no entry names, to legacy', async (_label, init, family) => {
    const outcome = await matchOf(init, FIXTURE_INDEX);
    expect(outcome.result?.family).toBe(family);
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });
});

describe('admin target destinations', () => {
  it.each<[string, OwningService, ResponseMode, string, Record<string, string> | undefined, string]>([
    ['admin:cperm.main', 'identity', 'page', '/admin/?muraAction=cPerm.main&siteid=default&topid=T1', undefined, '/admin/cperm/main'],
    ['admin:carch.loaddiff', 'strategies-content', 'fragment', '/admin/?muraAction=cArch.loadDiff&siteid=default&contenthistid=H1', undefined, '/admin-raw/carch/loaddiff'],
    ['admin:carch.loadsitemanager', 'strategies-content', 'json', '/admin/?muraAction=cArch.loadSiteManager&siteid=default&topid=T1', undefined, '/admin-raw/carch/loadsitemanager'],
    ['admin:cusers.download', 'people', 'download', '/admin/?muraAction=cUsers.download&siteid=default&ispublic=1', undefined, '/admin-raw/cusers/download'],
    ['admin:cperm.update', 'identity', 'redirect', '/admin/index.cfm?muraAction=cPerm.update&siteid=default', { contentid: 'C1', groupid: 'G1' }, '/admin-actions/cperm/update'],
  ])('serves %s (owned by %s) from web by its %s mode, keeping the query', async (route, owner, mode, url, form, webPath) => {
    const outcome = await matchOf(form === undefined ? requestFor(url) : { ...requestFor(url), method: 'POST', form }, FIXTURE_INDEX);
    expect(outcome.entry).toMatchObject({ route, owningService: owner, state: 'target' });
    expect(outcome.destination).toMatchObject({
      kind: 'target',
      service: 'web',
      isWeb: true,
      responseMode: mode,
      path: `${webPath}${url.slice(url.indexOf('?'))}`,
    });
  });

  it('fails closed for a target admin action without an inventoried response mode, never reaching legacy', async () => {
    const outcome = await matchOf(requestFor('/admin/?muraAction=cUsers.list&siteid=default'), FIXTURE_INDEX);
    expect(outcome.entry?.route).toBe('admin:cusers.list');
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'admin-unmapped' });
  });
});

describe('signed file URLs', () => {
  it('names the owner of each bucket', () => {
    expect(BUCKET_OWNERS).toStrictEqual({
      'content-files': 'strategies-content',
      'reporting-exports': 'reporting',
      'finance-attachments': 'finance',
      'esignature-documents': 'e-signature',
    });
  });

  it.each(BUCKETS.map((bucket): [BucketName, OwningService] => [bucket, BUCKET_OWNERS[bucket]]))(
    'sends a verified %s URL to %s through its bucket entry, with the URL unchanged',
    async (bucket, owner) => {
      const url = signed(bucket, 'tenant-a/Report 2026.pdf');
      const outcome = await matchOf(requestFor(url), FIXTURE_INDEX);
      expect(outcome.entry?.route).toBe(`${FILES_PREFIX}${bucket}/**`);
      expect(outcome.destination).toStrictEqual({
        kind: 'target',
        service: owner,
        serviceUrl: env.OPT2_SERVICE_URLS[owner],
        path: url,
        isWeb: false,
      });
    },
  );

  const VALID = signed('finance-attachments', 'reports/q2.pdf');
  it.each<[string, string, string]>([
    ['a tampered signature', VALID.replace(/.$/, (digit) => (digit === '0' ? '1' : '0')), `${FILES_PREFIX}finance-attachments/**`],
    ['an expired signature', signed('finance-attachments', 'reports/q2.pdf', NOW_S - 1), `${FILES_PREFIX}finance-attachments/**`],
    ['no signature', '/opt2/files/finance-attachments/reports/q2.pdf', `${FILES_PREFIX}finance-attachments/**`],
    ['an unknown bucket', VALID.replace('/finance-attachments/', '/payroll-archive/'), FILES_CATCH_ALL],
  ])('answers a bare 403 for %s, neither target nor legacy', async (_label, url, route) => {
    const outcome = await matchOf(requestFor(url), FIXTURE_INDEX);
    expect(outcome.entry?.route).toBe(route);
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 403 });
  });

  it('answers a bare 404 for a signed URL when storage is not the local adapter', async () => {
    const outcome = await matchOf(requestFor(VALID), FIXTURE_INDEX, matcherWith(undefined, 'cloud'));
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });
});

describe('fixed destinations', () => {
  it('sends the stub namespace to the stub service under the committed v0001', async () => {
    const outcome = await matchOf({ method: 'GET', path: STUB_NOTES }, await committedIndex('v0001'));
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'stub', path: STUB_NOTES, isWeb: false });
  });

  it('answers a bare 404 for the legacy bridge under the committed v0001', async () => {
    const outcome = await matchOf({ method: 'GET', path: BRIDGE_SESSION, query: { op: 'describe' } }, await committedIndex('v0001'));
    expect(outcome.entry?.owningService).toBe('gateway');
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });

  it('relays a path under the relay alias without keying it', async () => {
    const outcome = await matchOf({ method: 'GET', path: `${RELAY_ALIAS_PREFIX}/people/v1/persons`, query: { siteid: 'default' } }, FIXTURE_INDEX);
    expect(outcome.result).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'relay', service: 'people', path: '/v1/persons?siteid=default' });
  });

  it('answers unavailable when no version is active', async () => {
    const outcome = await matchOf({ method: 'GET', path: '/_api/json/v1/default/content' }, undefined);
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'no-active-version' });
  });
});

describe('edge dispatch', () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  async function started(version?: 'v0001'): Promise<TestGateway> {
    gateway = await buildTestGateway(version === undefined ? {} : { version });
    return gateway;
  }

  /** Request targets legacy received, leaving out the gateway's own session bridge calls. */
  function forwardedToLegacy(legacy: LegacyOrigin): string[] {
    const bridgeRequests = new Set(legacy.bridgeCalls.map((call) => call.request));
    return legacy.requests.filter((request) => !bridgeRequests.has(request)).map((request) => request.url);
  }

  /** Requests received by legacy, identity, migration and every target, web included, by name. */
  function receivedCounts({ legacy, identity, migration, targets }: TestGateway): Record<string, number> {
    const doubles = { legacy, identity, migration, ...targets };
    return Object.fromEntries(Object.entries(doubles).map(([name, double]) => [name, double.requests.length]));
  }

  it.each<[string, 'GET' | 'HEAD' | 'OPTIONS' | 'POST', string]>([
    ['a GET of the POST-only activate route', 'GET', '/internal/v1/cutover/activate'],
    ['a HEAD of the GET-only status route', 'HEAD', '/internal/v1/cutover/status'],
    ['an OPTIONS of the relay', 'OPTIONS', '/internal/v1/relay/people/v1/persons'],
    ['an unknown internal path', 'POST', '/internal/v1/no-such-operation?siteid=default'],
    ['the namespace itself', 'GET', '/internal/v1'],
    ['the namespace with a trailing slash', 'GET', '/internal/v1/?x=1'],
    ['a percent-encoded spelling the router decodes', 'GET', '/%69nternal/v1/cutover/activate'],
  ])('answers %s with the gateway 404, reaching no upstream', async (_label, method, url) => {
    const gw = await started('v0001');
    const before = receivedCounts(gw);
    const res = await gw.app.inject({ method, url, headers: await operatorHeaders() });
    expect(res.statusCode).toBe(404);
    if (method !== 'HEAD') expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(receivedCounts(gw)).toEqual(before);
  });

  it('still serves a registered internal route itself', async () => {
    const gw = await started('v0001');
    const before = receivedCounts(gw);
    const res = await gw.app.inject({ method: 'GET', url: '/internal/v1/cutover/status', headers: await operatorHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tableVersion: 'v0001' });
    expect(receivedCounts(gw)).toEqual(before);
  });

  it.each([
    '/internal',
    '/internalx/v1',
    '/internal/v1x',
    '/internal/v2/cutover/activate',
    '/INTERNAL/v1/cutover/activate',
    '/internal%2Fv1/x',
  ])('forwards %s, outside the gateway namespace as the router reads it, to legacy', async (url) => {
    const { app, legacy } = await started('v0001');
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(forwardedToLegacy(legacy)).toEqual([url]);
  });

  it('forwards an unmoved public page to legacy', async () => {
    const { app, legacy, targets } = await started('v0001');
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(forwardedToLegacy(legacy)).toEqual(['/']);
    expect(Object.values(targets).flatMap((target) => target.requests)).toHaveLength(0);
  });

  it('forwards the stub namespace to the stub service, never to legacy', async () => {
    const { app, legacy, targets } = await started('v0001');
    const res = await app.inject({ method: 'GET', url: STUB_NOTES });
    expect(res.statusCode).toBe(200);
    expect(targets.stub?.echoes().map((echo) => echo.path)).toEqual([STUB_NOTES]);
    expect(forwardedToLegacy(legacy)).toEqual([]);
  });

  it("writes a target route's request start cookies under the configured MURA_SECURECOOKIES and MURA_COOKIEDOMAIN", async () => {
    gateway = await buildTestGateway({ version: 'v0002', env: { MURA_SECURECOOKIES: 'true', MURA_COOKIEDOMAIN: '.example.test' } });
    const res = await gateway.app.inject({
      method: 'POST',
      url: '/core/modules/v1/rater/ajax/saveRate.cfm',
      headers: { 'content-type': URLENCODED },
      payload: 'contentID=C1&siteID=default&rate=5',
    });
    expect(res.statusCode).toBe(200);
    expect(gateway.targets['strategies-content']?.requests).toHaveLength(1);
    const startCookies = [res.headers['set-cookie'] ?? []].flat().filter((value) => /^(MXP_TRACKINGID|mobileFormat)=/.test(value));
    expect(startCookies).toEqual([
      expect.stringMatching(/^MXP_TRACKINGID=[^;]+; path=\/; domain=\.example\.test; secure; HttpOnly; Max-Age=946080000; Expires=/),
      expect.stringMatching(/^mobileFormat=false; path=\/; domain=\.example\.test; secure; HttpOnly; Max-Age=946080000; Expires=/),
    ]);
  });

  it('answers the legacy bridge with a bodiless 404 that never reaches legacy', async () => {
    const { app, legacy } = await started('v0001');
    const res = await app.inject({ method: 'GET', url: BRIDGE_SESSION });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
    expect(legacy.requests).toHaveLength(0);
  });

  it('answers the JSON API with the legacy 503 envelope while no version is active', async () => {
    const { app, legacy } = await started();
    const url = '/_api/json/v1/default/content';
    const { failContext } = await matchOf({ method: 'GET', path: url }, undefined);
    const expected = apiUnavailableResponse({ method: failContext.method, params: failContext.params });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(JSON.parse(res.body)).toStrictEqual(JSON.parse(expected.body));
    expect(legacy.requests).toHaveLength(0);
  });

  it('answers the admin with the legacy error page while no version is active', async () => {
    const { app, legacy } = await started();
    const expected = adminUnavailableResponse();
    const res = await app.inject({ method: 'GET', url: '/admin/?muraAction=cperm.main' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(res.body).toBe(expected.body);
    expect(legacy.requests).toHaveLength(0);
  });
});
