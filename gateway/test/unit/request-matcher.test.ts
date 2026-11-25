// Tests createMatcher: the relay alias, legacy, unavailable, bare and target destinations, and signed file URLs.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUCKETS, SIGNED_URL_TTL_S, signLocalUrl, type BucketName } from '@opt2/platform/storage';
import { fixedClock } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGINAL_URL_HEADER } from '../../src/admin/map.js';
import { createResponseModes, type ResponseModes } from '../../src/admin/response-modes.js';
import { buildRoutingIndex, listVersions, loadInventoryFacts, loadVersion } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type {
  Authority,
  CutoverEntry,
  CutoverTable,
  GroupsFile,
  InventoryFacts,
  OwningService,
  RouteFacts,
  RoutingIndex,
  VariantsFile,
} from '../../src/cutover/types.js';
import { bodyParamsFrom, type BodyParams } from '../../src/dispatcher/body.js';
import type { FailContext } from '../../src/dispatcher/fail-closed.js';
import {
  BUCKET_OWNERS,
  RELAY_ALIAS_PREFIX,
  createMatcher,
  type MatchOutcome,
  type MatchRequest,
  type Matcher,
  type MatcherDeps,
} from '../../src/dispatcher/match.js';
import { committedIndex, committedVariants } from '../helpers/versions.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const NOW = '2026-06-30T12:00:00Z';
const NOW_S = Date.parse(NOW) / 1000;
const CLOCK = fixedClock(NOW);
const URLENCODED = 'application/x-www-form-urlencoded';
const BOUNDARY = 'opt2-request-matcher';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const FILES_ROUTE_PREFIX = 'opt2:/opt2/files/';
const CONTENT_FILES_ROUTE = `${FILES_ROUTE_PREFIX}content-files/**`;
const LIST_URL = '/admin/?muraAction=cUsers.list&siteid=default';
const HMAC_KEY = randomBytes(32).toString('hex');
const OTHER_HMAC_KEY = randomBytes(32).toString('hex');

const SERVICES: readonly OwningService[] = ['identity', 'people', 'programs-sites', 'strategies-content', 'stub', 'web'];
const urlOf = (service: string): string => `http://${service}.opt2.test`;
const SERVICE_URLS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(SERVICES.map((s) => [s, urlOf(s)])));

function entry(route: string, owningService: OwningService, state: Authority = 'target'): CutoverEntry {
  return { route, owningService, tableVersion: 'v0002', state, kind: 'read', group: null, units: [], disposition: 'carry' };
}

const ENTRIES: readonly CutoverEntry[] = [
  entry('opt2:/opt2/stub/**', 'stub'),
  entry('opt2:/opt2/web-sample/**', 'web'),
  entry('opt2:/opt2/legacy-sample/**', 'web', 'legacy'),
  entry('bridge:/gateway/legacy-bridge/**', 'gateway'),
  entry('api:generatecsrftokens', 'identity'),
  entry('admin:cusers.list', 'people'),
  entry('admin:cusers.edit', 'people', 'legacy'),
  entry('admin:cusers.update{type=1}', 'people'),
  entry('admin:carch.loadsitemanager', 'strategies-content'),
  entry('admin:carch.update{upload=image}', 'strategies-content'),
  entry('admin:myplugin:main.default', 'strategies-content'),
  ...BUCKETS.map((bucket) => entry(`${FILES_ROUTE_PREFIX}${bucket}/**`, BUCKET_OWNERS[bucket])),
];

const VARIANTS: VariantsFile = {
  sourceSha: SHA,
  variants: [
    { route: 'admin:carch.update', variant: 'upload=image', when: [{ multipartExtensionIn: ['png', 'gif', 'jpg', 'jpeg', 'flv'] }] },
    { route: 'admin:cusers.update', variant: 'type=1', when: [{ param: 'type', equals: '1' }] },
  ],
};

const GROUPS: GroupsFile = {
  sourceSha: SHA,
  generatedBy: 'gateway/src/cutover/build-groups.ts',
  inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
  groups: [],
};

function indexOf(entries: readonly CutoverEntry[]): RoutingIndex {
  const table: CutoverTable = {
    tableVersion: 'v0002',
    previous: 'v0001',
    sourceSha: SHA,
    createdAt: NOW,
    groupAuthority: {},
    rollbackRefs: [],
    entries: [...entries],
  };
  return buildRoutingIndex(table, VARIANTS, GROUPS);
}

const INDEX = indexOf(ENTRIES);

/** Inventory facts of exactly `routes`, looked up normalised as the loader does. */
function factsOf(routes: Record<string, Pick<RouteFacts, 'responseMode' | 'contentType'>>): InventoryFacts {
  const byRoute = new Map<string, RouteFacts>(
    Object.entries(routes).map(([route, mode]) => [
      route,
      { route, csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects: ['none'], ...mode },
    ]),
  );
  return { get: (key) => byRoute.get(key.trim().toLowerCase()), routes: () => [...byRoute.keys()] };
}

const MODES: ResponseModes = createResponseModes(
  factsOf({
    'admin:cusers.list': { responseMode: 'page' },
    'admin:carch.loadsitemanager': { responseMode: 'json', contentType: 'application/json; charset=utf-8' },
    'admin:carch.update': { responseMode: 'redirect' },
  }),
);

/** A local signed URL under `/opt2/files/`, valid for the default TTL from NOW unless `expires` says otherwise. */
function signed(bucket: BucketName, key: string, { expires = NOW_S + SIGNED_URL_TTL_S, hmacKey = HMAC_KEY } = {}): string {
  return signLocalUrl({ bucket, key, expires }, Buffer.from(hmacKey, 'utf8'));
}

const FILE_URL = signed('content-files', 'reports/q2.pdf');
const FILE_QUERY = FILE_URL.slice(FILE_URL.indexOf('?'));

function multipartBody(parts: Array<{ name: string; value: string; filename?: string }>): Buffer {
  const lines = parts.flatMap(({ name, value, filename }) => [
    `--${BOUNDARY}`,
    filename === undefined
      ? `Content-Disposition: form-data; name="${name}"`
      : `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream`,
    '',
    value,
  ]);
  return Buffer.from([...lines, `--${BOUNDARY}--`, ''].join('\r\n'));
}

interface Sent {
  method?: string;
  contentType?: string;
  body?: string | Buffer;
}

/** The request and the body params the dispatcher reads from it. */
function requestOf(url: string, { method = 'GET', contentType, body }: Sent = {}): [MatchRequest, BodyParams] {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  const headers: Record<string, string> = contentType === undefined ? {} : { 'content-type': contentType };
  const request: MatchRequest = { url, method, headers };
  return [request, bodyParamsFrom(contentType, bytes, method)];
}

function matchOf(matcher: Matcher, url: string, sent?: Sent, index?: RoutingIndex): Promise<MatchOutcome> {
  const [request, body] = requestOf(url, sent);
  return matcher.match(request, body, index);
}

async function writeKey(stateDir: string, text: string): Promise<void> {
  await mkdir(join(stateDir, 'secrets'), { recursive: true });
  await writeFile(join(stateDir, 'secrets', 'storage-hmac-key'), text);
}

let root: string;
let keyedDir: string;
let keylessDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'opt2-request-matcher-'));
  keyedDir = join(root, 'keyed');
  keylessDir = join(root, 'keyless');
  await writeKey(keyedDir, `${HMAC_KEY}\n`);
  await mkdir(keylessDir);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Setup {
  active?: () => RoutingIndex | undefined;
  modes?: ResponseModes;
  env?: Partial<MatcherDeps['env']>;
  routeKeyOptions?: MatcherDeps['routeKeyOptions'];
}

function matcherWith({ active = () => INDEX, modes = MODES, env = {}, routeKeyOptions }: Setup = {}): Matcher {
  return createMatcher({
    state: { active },
    variants: VARIANTS,
    modes,
    env: { OPT2_SERVICE_URLS: SERVICE_URLS, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: keyedDir, ...env },
    clock: CLOCK,
    routeKeyOptions,
  });
}

describe('createMatcher relay alias', () => {
  it('relays a path under the alias to the named service before keying, even with no active version', async () => {
    const outcome = await matchOf(matcherWith({ active: () => undefined }), `${RELAY_ALIAS_PREFIX}/people/v1/persons?siteid=default`);
    expect(outcome).toStrictEqual({
      result: undefined,
      entry: undefined,
      destination: { kind: 'relay', service: 'people', path: '/v1/persons?siteid=default' },
      failContext: { surface: 'api' },
    });
  });

  it.each([
    ['/opt2/svc/people', 'people', '/'],
    ['/opt2/svc/people?siteid=default', 'people', '/?siteid=default'],
    ['/opt2/svc/programs-sites/v1/sites/a%20b/', 'programs-sites', '/v1/sites/a%20b/'],
    ['/opt2/svc/', '', '/'],
  ])('relays %s as service "%s" with service path %s', async (url, service, path) => {
    expect((await matchOf(matcherWith(), url)).destination).toStrictEqual({ kind: 'relay', service, path });
  });

  it.each(['/opt2/svc', '/OPT2/SVC/people/v1', '/opt2/%73vc/people/v1'])(
    'keys %s, which is not the exact alias prefix, and routes it by the table as the page legacy serves',
    async (url) => {
      const outcome = await matchOf(matcherWith(), url);
      expect(outcome.result?.key).toBe('page:render');
      expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    },
  );
});

describe('createMatcher legacy destinations', () => {
  it('sends a key no entry of the active version names to legacy, without an entry', async () => {
    const outcome = await matchOf(matcherWith(), '/admin/?muraAction=cUsers.delete');
    expect(outcome.result?.key).toBe('admin:cusers.delete');
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome.failContext).toStrictEqual({ surface: 'admin', route: 'admin:cusers.delete', owner: 'legacy' });
  });

  it('sends a request whose entry is legacy to legacy with the entry it matched', async () => {
    const outcome = await matchOf(matcherWith(), '/admin/?muraAction=cUsers.edit&userid=1');
    expect(outcome.entry?.route).toBe('admin:cusers.edit');
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it('reads the active version on every call', async () => {
    let active: RoutingIndex | undefined = INDEX;
    const matcher = matcherWith({ active: () => active });
    expect((await matchOf(matcher, LIST_URL)).destination.kind).toBe('target');
    active = indexOf([entry('admin:cusers.list', 'people', 'legacy')]);
    expect((await matchOf(matcher, LIST_URL)).destination).toStrictEqual({ kind: 'legacy' });
    active = undefined;
    expect((await matchOf(matcher, LIST_URL)).destination).toStrictEqual({ kind: 'unavailable', reason: 'no-active-version' });
  });

  it('matches against an explicit index instead of the active version', async () => {
    const outcome = await matchOf(matcherWith({ active: () => undefined }), LIST_URL, {}, INDEX);
    expect(outcome.entry?.route).toBe('admin:cusers.list');
    expect(outcome.destination.kind).toBe('target');
  });

  it('keys requests with the configured legacy settings, such as a relocated admin directory', async () => {
    const url = '/manage/?muraAction=cUsers.list';
    const relocated = await matchOf(matcherWith({ routeKeyOptions: { adminDir: '/manage' } }), url);
    expect(relocated.result?.key).toBe('admin:cusers.list');
    expect(relocated.destination).toMatchObject({ kind: 'target', service: 'web', path: '/admin/cusers/list?muraAction=cUsers.list' });
    const defaults = await matchOf(matcherWith(), url);
    expect(defaults.result?.key).toBe('page:render');
    expect(defaults.destination).toStrictEqual({ kind: 'legacy' });
  });
});

describe('createMatcher legacy-bound OPT-2 namespaces', () => {
  const legacyWrite = (route: string, owningService: OwningService, units: string[]): CutoverEntry => ({
    ...entry(route, owningService, 'legacy'),
    kind: 'legacy-write',
    units,
  });
  const PAGE_RENDER = legacyWrite('page:render', 'none', ['identity.credential', 'people.person']);
  const PAGE_LOGIN = legacyWrite('page:login', 'identity', ['identity.login_state']);
  const RELOAD = legacyWrite('reload:application', 'strategies-content', ['content.content']);
  const SERVED_INDEX = indexOf([...ENTRIES, PAGE_RENDER, PAGE_LOGIN, RELOAD]);
  const serving = (): Matcher => matcherWith({ active: () => SERVED_INDEX });

  it.each<[string, string, CutoverEntry]>([
    ['an opt2 path whose entry is legacy', '/opt2/legacy-sample/exports', PAGE_RENDER],
    ['an opt2 path no entry names', '/opt2/does-not-exist', PAGE_RENDER],
    ['a doaction on a legacy-bound opt2 path', '/opt2/does-not-exist?doaction=login', PAGE_LOGIN],
  ])('sends %s (%s) to legacy under the entry legacy serves it as', async (_label, url, served) => {
    const outcome = await matchOf(serving(), url);
    expect(outcome.result?.key).toBe(served.route);
    expect(outcome.entry).toBe(SERVED_INDEX.entryFor(served.route));
    expect(outcome.entry).toMatchObject({ state: 'legacy', kind: 'legacy-write' });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it.each(['/opt2/legacy-sample/exports?appreload'])(
    "serves the legacy-bound reload %s as the page writer behind it over both entries' units, held also by the reload entry",
    async (url) => {
      const outcome = await matchOf(serving(), url);
      expect(outcome.result).toMatchObject({ key: RELOAD.route, afterReload: { key: PAGE_RENDER.route } });
      expect(outcome.entry).toStrictEqual({ ...PAGE_RENDER, units: [...PAGE_RENDER.units, ...RELOAD.units] });
      expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
      expect(outcome).toMatchObject({ holdRoutes: [RELOAD.route] });
    },
  );

  it('serves a halted legacy-bound opt2 request under its unhalted page entry', async () => {
    const outcome = await matchOf(serving(), '/opt2/legacy-sample/exports?a-b=one&a.b=two');
    expect(outcome.result?.key).toBe('page:render');
    expect(outcome.entry).toMatchObject({ route: 'page:render', state: 'legacy', kind: 'legacy-write', units: PAGE_RENDER.units });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it.each<[string, FailContext]>([
    ['/opt2/legacy-sample/exports?doaction=login', { surface: 'admin', route: PAGE_LOGIN.route, owner: 'legacy' }],
  ])("fails %s closed as its namespace's surface with the served key's route and params", async (url, failContext) => {
    expect((await matchOf(serving(), url)).failContext).toEqual(failContext);
  });

  it.each<[string, string, OwningService]>([
    ['/opt2/stub/ping?appreload', 'opt2:/opt2/stub/**', 'stub'],
    ['/opt2/web-sample/records?doaction=login', 'opt2:/opt2/web-sample/**', 'web'],
    [FILE_URL, CONTENT_FILES_ROUTE, 'strategies-content'],
  ])('keeps the target-bound %s on its opt2 entry', async (url, route, service) => {
    const outcome = await matchOf(serving(), url);
    expect(outcome.result?.family).toBe('opt2');
    expect(outcome.entry?.route).toBe(route);
    expect(outcome.destination).toMatchObject({ kind: 'target', service, path: url });
  });
});

describe('createMatcher unavailable destinations', () => {
  it('answers no-active-version with the computed key and its fail context when no version is active', async () => {
    const outcome = await matchOf(matcherWith({ active: () => undefined }), '/opt2/stub/ping?siteid=default');
    expect(outcome.result?.key).toBe('opt2:/opt2/stub/ping');
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'no-active-version' });
    expect(outcome.failContext).toEqual({ surface: 'api', params: { siteid: 'default' }, route: 'opt2:/opt2/stub/ping' });
  });

  it.each([
    ['a variant without an inventoried response mode', '/admin/index.cfm', 'muraAction=cUsers.update&type=1', 'admin:cusers.update{type=1}'],
    ['a non-core subsystem action', '/admin/index.cfm', 'muraAction=myplugin:main.default', 'admin:myplugin:main.default'],
  ])('answers admin-unmapped, never legacy, for %s', async (_label, url, body, key) => {
    const outcome = await matchOf(matcherWith(), url, { method: 'POST', contentType: URLENCODED, body });
    expect(outcome.result?.key).toBe(key);
    expect(outcome.entry?.route).toBe(key);
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'admin-unmapped' });
    expect(outcome.failContext).toStrictEqual({ surface: 'admin', route: key, owner: 'web' });
  });

  it('propagates a failure other than an admin mapping error instead of answering unavailable', async () => {
    const modes: ResponseModes = {
      modeFor: () => {
        throw new TypeError('response modes unreadable');
      },
    };
    await expect(matchOf(matcherWith({ modes }), LIST_URL)).rejects.toThrow('response modes unreadable');
  });

  it.each([
    ['stub', '/opt2/stub/ping'],
    ['web', LIST_URL],
    ['strategies-content', FILE_URL],
  ])('answers no-service-url when OPT2_SERVICE_URLS lacks %s for %s', async (service, url) => {
    const urls = Object.fromEntries(Object.entries(SERVICE_URLS).filter(([name]) => name !== service));
    const outcome = await matchOf(matcherWith({ env: { OPT2_SERVICE_URLS: urls } }), url);
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'no-service-url' });
    expect(outcome.failContext.owner).toBe(service);
  });
});

describe('createMatcher bare destinations', () => {
  it.each<Authority>(['target', 'legacy'])('answers 404 for the legacy bridge in a %s entry, which the edge never reaches', async (state) => {
    const index = indexOf([entry('bridge:/gateway/legacy-bridge/**', 'gateway', state)]);
    const outcome = await matchOf(matcherWith({ active: () => index }), '/gateway/legacy-bridge/cfml/session.cfm?op=describe');
    expect(outcome.entry?.route).toBe('bridge:/gateway/legacy-bridge/**');
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });

  it.each([
    '/gateway//legacy-bridge/cfml/session.cfm?op=describe',
    '//gateway/legacy-bridge/cfml/session.cfm?op=describe',
    '/gateway/legacy-bridge;x/cfml/session.cfm?op=describe',
    '/gateway///legacy-bridge//cfml//jobs.cfm?job=getCursor',
    '/gateway/legacy-bridge',
    '/gateway/./legacy-bridge/cfml/session.cfm',
    '/gateway\\legacy-bridge/cfml/session.cfm',
    '/GATEWAY/Legacy-Bridge/cfml/session.cfm',
  ])('answers 404 under the committed v0001 table for the bridge spelling %s', async (url) => {
    const v0001 = await committedIndex('v0001');
    const outcome = await matchOf(matcherWith({ active: () => v0001 }), url);
    expect(outcome.result?.family).toBe('bridge');
    expect(outcome.entry?.route).toBe('bridge:/gateway/legacy-bridge/**');
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });

  it('sends /index.cfm/gateway/legacy-bridge/..., a front-controller page, to legacy under v0001', async () => {
    const v0001 = await committedIndex('v0001');
    const outcome = await matchOf(matcherWith({ active: () => v0001 }), '/index.cfm/gateway/legacy-bridge/cfml/session.cfm');
    expect(outcome.result?.key).toBe('page:render');
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it('answers 404 for a signed file URL when storage is not the local adapter, without reading the key', async () => {
    const matcher = matcherWith({ env: { OPT2_STORAGE_ADAPTER: 'cloud', OPT2_STATE_DIR: keylessDir } });
    const outcome = await matchOf(matcher, FILE_URL);
    expect(outcome.entry?.route).toBe(CONTENT_FILES_ROUTE);
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });
});

describe('createMatcher target destinations', () => {
  it('sends a target entry to its owning service with the request target unchanged', async () => {
    const url = '/opt2/stub/ping?a=1&a=2&a=3';
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.entry?.route).toBe('opt2:/opt2/stub/**');
    expect(outcome.destination).toStrictEqual({ kind: 'target', service: 'stub', serviceUrl: urlOf('stub'), path: url, isWeb: false });
    expect(outcome.failContext).toEqual({ surface: 'api', params: { a: '1,2,3' }, route: 'opt2:/opt2/stub/**', owner: 'stub' });
  });

  it('marks a web-owned entry outside the admin family as web, without an admin mapping', async () => {
    const url = '/opt2/web-sample/records?id=7';
    expect((await matchOf(matcherWith(), url)).destination).toStrictEqual({
      kind: 'target',
      service: 'web',
      serviceUrl: urlOf('web'),
      path: url,
      isWeb: true,
    });
  });

  const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
  const FIXTURE_INDEX = indexOf([
    entry('fixture:people/persons@get', 'people'),
    entry('fixture:people/persons@post', 'people'),
    entry('fixture:people/persons/{id}/archive@post', 'people'),
    entry('fixture:people/persons/{id}@get', 'people'),
    entry('fixture:people/persons/{id}/archives@get', 'people'),
  ]);
  it.each<[method: string, url: string, route: string, path: string]>([
    ['GET', `${FIXTURE}/people/persons?siteid=tenant-a`, 'fixture:people/persons@get', `${FIXTURE}/people/persons?siteid=tenant-a`],
    ['GET', '//legacy-fixtures/cfml/api.cfm/PEOPLE/persons?siteid=tenant-a', 'fixture:people/persons@get', `${FIXTURE}/people/persons?siteid=tenant-a`],
    ['GET', `${FIXTURE}/people%2Fpersons?siteid=tenant-a`, 'fixture:people/persons@get', `${FIXTURE}/people/persons?siteid=tenant-a`],
    ['POST', '/legacy-fixtures//cfml/api.cfm/people/Persons/?siteid=tenant-a&q=a+b%2f', 'fixture:people/persons@post', `${FIXTURE}/people/persons?siteid=tenant-a&q=a+b%2f`],
    ['POST', `${FIXTURE}/PEOPLE/Persons/Ab-1/ARCHIVE`, 'fixture:people/persons/{id}/archive@post', `${FIXTURE}/people/persons/Ab-1/archive`],
    ['GET', `${FIXTURE}/people/persons/a%5C..%5Cb/archives`, 'fixture:people/persons/{id}/archives@get', `${FIXTURE}/people/persons/a%5C..%5Cb/archives`],
    ['GET', `${FIXTURE}/people/persons/x../archives`, 'fixture:people/persons/{id}/archives@get', `${FIXTURE}/people/persons/x../archives`],
  ])('sends %s %s to its service on the api.cfm path legacy dispatches, the query as sent', async (method, url, route, path) => {
    const outcome = await matchOf(matcherWith({ active: () => FIXTURE_INDEX }), url, { method });
    expect(outcome.entry?.route).toBe(route);
    expect(outcome.destination).toStrictEqual({ kind: 'target', service: 'people', serviceUrl: urlOf('people'), path, isWeb: false, rawTarget: true });
  });

  it.each<[url: string, key: string]>([
    [`${FIXTURE}/people/persons/..%5C..%5Cweb.config`, 'cfm:/legacy-fixtures/cfml/api.cfm'],
    [`${FIXTURE}/people/persons/..%5C..%5Cweb.config/archives`, 'page:render'],
    [`${FIXTURE}/people/persons/.x/archives`, 'page:render'],
  ])('keys %s as %s, off its target fixture entry, and sends it to legacy', async (url, key) => {
    const outcome = await matchOf(matcherWith({ active: () => FIXTURE_INDEX }), url);
    expect(outcome.result?.key).toBe(key);
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it("keys a REST request without a client's consumed-params header, which only the gateway may send", async () => {
    const url = '/_api/rest/v1/default/group?client_id=C1';
    const [request, body] = requestOf(url);
    const outcome = await matcherWith().match({ ...request, headers: { 'X-Opt2-Consumed-Params': 'client_id' } }, body);
    expect(outcome.result?.key).toBe('rest:group.findquery');
    expect(outcome.result?.params).toMatchObject({ client_id: 'C1' });
  });

  it('keys a JSON body over the query as legacy merges them', async () => {
    const url = '/_api/json/v1/default/?method=logout';
    const outcome = await matchOf(matcherWith(), url, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ method: 'generateCSRFTokens' }),
    });
    expect(outcome.result?.key).toBe('api:generatecsrftokens');
    expect(outcome.destination).toStrictEqual({ kind: 'target', service: 'identity', serviceUrl: urlOf('identity'), path: url, isWeb: false });
    expect(outcome.failContext).toEqual({
      surface: 'api',
      method: 'generateCSRFTokens',
      params: { method: 'generateCSRFTokens', siteid: 'default' },
      route: 'api:generatecsrftokens',
      owner: 'identity',
    });
  });

  it.each<[string, string, Sent, string, string, boolean]>([
    ['GET', LIST_URL, {}, '/admin/cusers/list?muraAction=cUsers.list&siteid=default', 'GET', false],
    ['HEAD', LIST_URL, { method: 'HEAD' }, '/admin/cusers/list?muraAction=cUsers.list&siteid=default', 'HEAD', false],
    [
      'POST',
      '/admin/index.cfm',
      { method: 'POST', contentType: URLENCODED, body: 'muraAction=cUsers.list&siteid=default&keywords=a+b' },
      '/admin/cusers/list',
      'POST',
      true,
    ],
  ])('maps a target page action sent as %s to web as %s, whatever the entry owner', async (_method, url, sent, path, method, forwardBody) => {
    const outcome = await matchOf(matcherWith(), url, sent);
    expect(outcome.entry?.owningService).toBe('people');
    expect(outcome.destination).toStrictEqual({
      kind: 'target',
      service: 'web',
      serviceUrl: urlOf('web'),
      path,
      isWeb: true,
      extraHeaders: { [ORIGINAL_URL_HEADER]: url },
      responseMode: 'page',
      method,
      forwardBody,
    });
    expect(outcome.failContext).toStrictEqual({ surface: 'admin', route: 'admin:cusers.list', owner: 'web' });
  });

  it("maps a target json action to web's raw handler with its method, body and legacy content type", async () => {
    const url = '/admin/?muraAction=cArch.loadSiteManager';
    const outcome = await matchOf(matcherWith(), url, { method: 'POST', contentType: URLENCODED, body: 'siteid=default' });
    expect(outcome.destination).toStrictEqual({
      kind: 'target',
      service: 'web',
      serviceUrl: urlOf('web'),
      path: '/admin-raw/carch/loadsitemanager?muraAction=cArch.loadSiteManager',
      isWeb: true,
      extraHeaders: { [ORIGINAL_URL_HEADER]: url },
      responseMode: 'json',
      method: 'POST',
      forwardBody: true,
      contentType: 'application/json; charset=utf-8',
    });
  });

  it('keys multipart file names into the upload variant and maps it by its base action mode', async () => {
    const url = '/admin/index.cfm?muraAction=cArch.update';
    const body = multipartBody([
      { name: 'siteid', value: 'default' },
      { name: 'newFile', value: 'image bytes', filename: 'photo.PNG' },
    ]);
    const outcome = await matchOf(matcherWith(), url, { method: 'POST', contentType: MULTIPART, body });
    expect(outcome.result?.key).toBe('admin:carch.update{upload=image}');
    expect(outcome.destination).toStrictEqual({
      kind: 'target',
      service: 'web',
      serviceUrl: urlOf('web'),
      path: '/admin-actions/carch/update?muraAction=cArch.update',
      isWeb: true,
      extraHeaders: { [ORIGINAL_URL_HEADER]: url },
      responseMode: 'redirect',
      method: 'POST',
      forwardBody: true,
    });
  });
});

describe('createMatcher signed file URLs', () => {
  it.each(BUCKETS)('sends a valid signed %s URL to the bucket owner with the URL unchanged', async (bucket) => {
    const url = signed(bucket, 'tenant-a/file.pdf');
    const outcome = await matchOf(matcherWith(), url);
    const owner = BUCKET_OWNERS[bucket];
    expect(outcome.entry?.route).toBe(`${FILES_ROUTE_PREFIX}${bucket}/**`);
    expect(outcome.destination).toStrictEqual({ kind: 'target', service: owner, serviceUrl: urlOf(owner), path: url, isWeb: false });
  });

  it('names the BUCKET_OWNERS owner for every bucket entry of every committed version', async () => {
    const paths = resolveGatewayPaths({});
    const versions = await listVersions(paths);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const table = await loadVersion(paths, version);
      const owners = Object.fromEntries(
        table.entries
          .filter(({ route }) => route.startsWith(FILES_ROUTE_PREFIX))
          .map(({ route, owningService }) => [route.slice(FILES_ROUTE_PREFIX.length, -'/**'.length), owningService]),
      );
      expect(owners, version).toStrictEqual({ ...BUCKET_OWNERS });
    }
  });

  it('verifies an upper-case object key, which the route key lower-cases', async () => {
    const url = signed('content-files', 'Reports/Q2 Summary.PDF');
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.result?.key).toBe('opt2:/opt2/files/content-files/reports/q2 summary.pdf');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'strategies-content', path: url });
  });

  it.each([
    ['an upper-case prefix', FILE_URL.replace('/opt2/files/', '/OPT2/FILES/')],
    ['a mixed-case prefix', FILE_URL.replace('/opt2/files/', '/opt2/Files/')],
    ['a percent-encoded files segment', FILE_URL.replace('/opt2/files/', '/opt2/%66iles/')],
    ['a percent-encoded namespace segment', FILE_URL.replace('/opt2/files/', '/%6Fpt2/files/')],
    ['an index.cfm segment the key drops', FILE_URL.replace('/opt2/files/', '/opt2/index.cfm/files/')],
    ['a dot segment out of the bucket', `/opt2/files/content-files/../payroll-archive/q2.pdf${FILE_QUERY}`],
    ['a tampered signature', FILE_URL.replace(/sig=([0-9a-f])/, (_match, digit: string) => `sig=${digit === '0' ? '1' : '0'}`)],
    ['a signature from another key', signed('content-files', 'reports/q2.pdf', { hmacKey: OTHER_HMAC_KEY })],
    ['an expired signature', signed('content-files', 'reports/q2.pdf', { expires: NOW_S - 1 })],
    ['no signature', '/opt2/files/content-files/reports/q2.pdf'],
  ])('answers 403 for %s, which still keys to the bucket entry', async (_label, url) => {
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.result?.key.startsWith(`${FILES_ROUTE_PREFIX}content-files/`)).toBe(true);
    expect(outcome.entry?.route).toBe(CONTENT_FILES_ROUTE);
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 403 });
  });
});

describe('createMatcher halted requests', () => {
  const PERSON_UNITS = ['people.person', 'people.user_address'];
  const HALT_INDEX = indexOf([
    ...ENTRIES.filter(({ route }) => route !== 'admin:cusers.update{type=1}'),
    { ...entry('admin:cusers.update{type=1}', 'people'), kind: 'write', group: 'grp:people', units: PERSON_UNITS },
    entry('page:render', 'strategies-content'),
  ]);
  const modes = createResponseModes(factsOf({ 'admin:cusers.list': { responseMode: 'page' }, 'admin:cusers.update{type=1}': { responseMode: 'redirect' } }));
  const halting = (): Matcher => matcherWith({ active: () => HALT_INDEX, modes });
  const form = (body: string): Sent => ({ method: 'POST', contentType: URLENCODED, body });

  // Each halted request is one whose scan outcome varied between identical requests or runs on the legacy oracle.
  it.each<[string, string, Sent | undefined, string]>([
    ['an admin scan fault', '/admin/?muraAction=cUsers.list&siteid=default&x=null', undefined, 'admin:cusers.list'],
    ['admin url names stripped onto one', `${LIST_URL}&a-b=one&a.b=two`, undefined, 'admin:cusers.list'],
    ['JSON API url names renamed onto one', '/_api/json/v1/tenant-a/?method=generateCSRFTokens&amp%3Bxy=one&xyamp%3B=two', undefined, 'api:generatecsrftokens'],
    ['JSON API posted names stripped onto one', '/_api/json/v1/tenant-a/', form('method=generateCSRFTokens&a-b=one&a.b=two'), 'api:generatecsrftokens'],
    ['front-end url names stripped onto one', '/?a-b=one&a.b=two', undefined, 'page:render'],
    ['a front-end array nested as deep as the stack decides', `/?q=${'%5B'.repeat(600)}${'%5D'.repeat(600)}`, undefined, 'page:render'],
  ])('serves %s on legacy under its unhalted entry', async (_label, url, sent, route) => {
    const outcome = await matchOf(halting(), url, sent);
    expect(outcome.result?.key).toBe(route);
    expect(outcome.entry).toMatchObject({ route, state: 'legacy', kind: 'read' });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it('serves a halted carried write on legacy as a legacy-write over its units, so its write window opens', async () => {
    const outcome = await matchOf(halting(), '/admin/?muraAction=cUsers.update', form('type=1&a-b=one&a.b=two'));
    expect(outcome.entry).toStrictEqual({ ...entry('admin:cusers.update{type=1}', 'people', 'legacy'), kind: 'legacy-write', group: 'grp:people', units: PERSON_UNITS });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(HALT_INDEX.entryFor('admin:cusers.update{type=1}')).toMatchObject({ kind: 'write', state: 'target' });
  });

  it('sends a halted request whose unhalted key has no entry to legacy without one', async () => {
    const outcome = await matchOf(halting(), '/admin/?muraAction=cUsers.delete&a-b=one&a.b=two');
    expect([outcome.result?.key, outcome.entry, outcome.destination]).toStrictEqual(['admin:cusers.delete', undefined, { kind: 'legacy' }]);
  });

  it.each<[string, string, Sent | undefined, string]>([
    ['an ordinary admin request', `${LIST_URL}&ab=one`, undefined, 'web'],
    ['a stripped name over a plain one, which legacy scans alike every time', `${LIST_URL}&ab=one&a-b=two`, undefined, 'web'],
    ['a root-served scan fault, which the service answers with the error page', '/_api/json/v1/tenant-a/?method=generateCSRFTokens&x=null', undefined, 'identity'],
    ['names stripped onto one with equal values', '/?a-b=x&a.b=x', undefined, 'strategies-content'],
    ['a carried write', '/admin/?muraAction=cUsers.update', form('type=1&ab=one'), 'web'],
  ])('keeps %s on its target entry', async (_label, url, sent, service) => {
    const outcome = await matchOf(halting(), url, sent);
    expect(outcome.entry?.state).toBe('target');
    expect(outcome.destination).toMatchObject({ kind: 'target', service });
  });

  it('keeps target-only paths, which no legacy scan reads, on their entries', async () => {
    expect((await matchOf(halting(), '/opt2/stub/ping?a-b=one&a.b=two')).destination).toMatchObject({ kind: 'target', service: 'stub' });
    expect((await matchOf(halting(), '/gateway/legacy-bridge/cfml/session.cfm?a-b=one&a.b=two')).destination).toStrictEqual({ kind: 'bare', status: 404 });
  });
});

describe('createMatcher REST spellings under the committed v0002', () => {
  const REST_ID = 'A1B2C3D4-E5F6-7890-ABCDEF1234567890';
  let entityRemoteFunctions: Readonly<Record<string, readonly string[]>> = {};
  beforeAll(async () => {
    ({ entityRemoteFunctions } = await loadInventoryFacts(resolveGatewayPaths({})));
  });
  const committedMatcher = (index: RoutingIndex): Matcher =>
    createMatcher({
      state: { active: () => index },
      variants: committedVariants(),
      modes: MODES,
      env: { OPT2_SERVICE_URLS: SERVICE_URLS, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: keyedDir },
      clock: CLOCK,
      routeKeyOptions: { entityRemoteFunctions },
    });

  it.each<[string, string, string, Record<string, string>?]>([
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save'],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save'],
    ['DELETE', `/Index.cfm/_api/rest/v1/tenant-a/variationtargeting/${REST_ID}`, 'rest:variationtargeting.delete'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/address/', 'rest:address.save', { siteid: 'tenant-a' }],
    ['DELETE', '/Index.cfm/_api/rest/v1/tenant-a/category/00000000-0000-0000-0000000000000000', 'rest:category.delete'],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/category/', 'rest:category.save', { siteid: 'tenant-a' }],
    ['DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/changeset/00000000-0000-0000-0000000000000000', 'rest:changeset.delete'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/changeset/', 'rest:changeset.save', { siteid: 'tenant-a' }],
    ['DELETE', '/index.CFM/_api/rest/v1/tenant-a/changesetCategoryAssignment/00000000-0000-0000-0000000000000000', 'rest:changesetcategoryassignment.delete'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/changesetCategoryAssignment/', 'rest:changesetcategoryassignment.save', { siteid: 'tenant-a' }],
    ['DELETE', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000', 'rest:comment.delete'],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/comment/', 'rest:comment.save', { siteid: 'tenant-a' }],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/delete', 'rest:comment.~delete'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/flag', 'rest:comment.~flag'],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/markAsSpam', 'rest:comment.~markasspam'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/undelete', 'rest:comment.~undelete'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/unMarkAsSpam', 'rest:comment.~unmarkasspam'],
    ['DELETE', '/index.CFM/_api/rest/v1/tenant-a/content/00000000-0000-0000-0000000000000000', 'rest:content.delete'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/content/', 'rest:content.save', { siteid: 'tenant-a' }],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/?method=delete', 'rest:contentcategoryassign.delete', { siteid: 'tenant-a', entityname: 'contentCategoryAssign' }],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/contentCategoryAssign/', 'rest:contentcategoryassign.save', { siteid: 'tenant-a' }],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/', 'rest:contentnav.delete', { method: 'delete', entityname: 'contentnav', siteid: 'tenant-a' }],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/', 'rest:contentnav.save', { method: 'save', entityname: 'contentnav', siteid: 'tenant-a' }],
    ['DELETE', '/index.CFM/_api/rest/v1/tenant-a/feed/00000000-0000-0000-0000000000000000', 'rest:feed.delete'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/feed/', 'rest:feed.save', { siteid: 'tenant-a' }],
    ['DELETE', '/Index.cfm/_api/rest/v1/tenant-a/file/00000000-0000-0000-0000000000000000', 'rest:file.delete'],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/file/', 'rest:file.save'],
    ['DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/fileMetaData/00000000-0000-0000-0000000000000000', 'rest:filemetadata.delete'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/fileMetaData/', 'rest:filemetadata.save', { siteid: 'tenant-a' }],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/group/', 'rest:group.save', { siteid: 'tenant-a' }],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/login', 'rest:login'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/oauth', 'rest:oauth', { grant_type: 'client_credentials' }],
    ['POST', '/index.CFM/_api/rest/v1/tenant-a/oauth2', 'rest:oauth2', { grant_type: 'client_credentials' }],
    ['DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/stats/00000000-0000-0000-0000000000000000', 'rest:stats.delete'],
    ['POST', '/Index.cfm/_api/rest/v1/tenant-a/stats/', 'rest:stats.save', { siteid: 'tenant-a' }],
    ['GET', '/index.CFM/_api/rest/v1/tenant-a/tokeninfo?access_token=tokeninfo-session&client_id=tokeninfo-session', 'rest:tokeninfo'],
    ['POST', '/INDEX.CFM/_api/rest/v1/tenant-a/user/', 'rest:user.save', { siteid: 'tenant-a' }],
  ])('serves session-managed %s %s on legacy as the legacy-write {session} variant of %s', async (method, url, base, form) => {
    const v0002 = await committedIndex('v0002');
    const body = form === undefined ? {} : { contentType: URLENCODED, body: new URLSearchParams(form).toString() };
    const outcome = await matchOf(committedMatcher(v0002), url, { method, ...body });
    expect(outcome.result?.key).toBe(`${base}{session}`);
    expect(outcome.entry).toMatchObject({ route: `${base}{session}`, state: 'legacy', kind: 'legacy-write', units: v0002.entryFor(base)?.units });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    // The base is a carried write, target with its group, or a withheld legacy-write.
    const baseEntry = v0002.entryFor(base);
    expect(baseEntry).toMatchObject(baseEntry?.kind === 'write' ? { state: 'target' } : { state: 'legacy', kind: 'legacy-write' });
  });

  const SITE = { siteid: 'tenant-a' };
  const NEUTRAL = '00000000-0000-0000-0000000000000000';
  it.each<[string, string, string, Record<string, string>?]>([
    ['POST', '/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/variationtargeting/${REST_ID}?siteid=tenant-a`, 'rest:variationtargeting.delete'],
    ['POST', '/_api/rest/v1/tenant-a/address/', 'rest:address.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/category/${NEUTRAL}?siteid=tenant-a`, 'rest:category.delete'],
    ['POST', '/_api/rest/v1/tenant-a/category/', 'rest:category.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/changeset/${NEUTRAL}?siteid=tenant-a`, 'rest:changeset.delete'],
    ['POST', '/_api/rest/v1/tenant-a/changeset/', 'rest:changeset.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/changesetCategoryAssignment/${NEUTRAL}?siteid=tenant-a`, 'rest:changesetcategoryassignment.delete'],
    ['POST', '/_api/rest/v1/tenant-a/changesetCategoryAssignment/', 'rest:changesetcategoryassignment.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}?siteid=tenant-a`, 'rest:comment.delete'],
    ['POST', '/_api/rest/v1/tenant-a/comment/', 'rest:comment.save', SITE],
    ['POST', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}/delete`, 'rest:comment.~delete', SITE],
    ['POST', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}/flag`, 'rest:comment.~flag', SITE],
    ['POST', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}/markAsSpam`, 'rest:comment.~markasspam', SITE],
    ['POST', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}/undelete`, 'rest:comment.~undelete', SITE],
    ['POST', `/_api/rest/v1/tenant-a/comment/${NEUTRAL}/unMarkAsSpam`, 'rest:comment.~unmarkasspam', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/content/${NEUTRAL}?siteid=tenant-a`, 'rest:content.delete'],
    ['POST', '/_api/rest/v1/tenant-a/content/', 'rest:content.save', SITE],
    ['POST', '/_api/rest/v1/tenant-a/?method=delete', 'rest:contentcategoryassign.delete', { ...SITE, entityname: 'contentCategoryAssign' }],
    ['POST', '/_api/rest/v1/tenant-a/contentCategoryAssign/', 'rest:contentcategoryassign.save', SITE],
    ['POST', '/_api/rest/v1/tenant-a/', 'rest:contentnav.delete', { method: 'delete', entityname: 'contentnav', ...SITE }],
    ['POST', '/_api/rest/v1/tenant-a/', 'rest:contentnav.save', { method: 'save', entityname: 'contentnav', ...SITE }],
    ['DELETE', `/_api/rest/v1/tenant-a/feed/${NEUTRAL}?siteid=tenant-a`, 'rest:feed.delete'],
    ['POST', '/_api/rest/v1/tenant-a/feed/', 'rest:feed.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/file/${NEUTRAL}?siteid=tenant-a`, 'rest:file.delete'],
    ['POST', '/_api/rest/v1/tenant-a/file/', 'rest:file.save', SITE],
    ['DELETE', `/_api/rest/v1/tenant-a/fileMetaData/${NEUTRAL}?siteid=tenant-a`, 'rest:filemetadata.delete'],
    ['POST', '/_api/rest/v1/tenant-a/fileMetaData/', 'rest:filemetadata.save', SITE],
    ['POST', '/_api/rest/v1/tenant-a/group/', 'rest:group.save', SITE],
    ['POST', '/_api/rest/v1/tenant-a/login', 'rest:login', SITE],
    ['POST', '/_api/rest/v1/tenant-a/oauth', 'rest:oauth', { grant_type: 'client_credentials', ...SITE }],
    ['POST', '/_api/rest/v1/tenant-a/oauth2', 'rest:oauth2', { grant_type: 'client_credentials', ...SITE }],
    ['DELETE', `/_api/rest/v1/tenant-a/stats/${NEUTRAL}?siteid=tenant-a`, 'rest:stats.delete'],
    ['POST', '/_api/rest/v1/tenant-a/stats/', 'rest:stats.save', SITE],
    ['GET', '/_api/rest/v1/tenant-a/tokeninfo?access_token=tokeninfo-siteid&client_id=tokeninfo-siteid&siteid=tenant-a', 'rest:tokeninfo'],
    ['POST', '/_api/rest/v1/tenant-a/user/', 'rest:user.save', SITE],
  ])('serves sessionless %s %s carrying a siteid on legacy as the legacy-write {siteid} variant of %s', async (method, url, base, form) => {
    const v0002 = await committedIndex('v0002');
    const body = form === undefined ? {} : { contentType: URLENCODED, body: new URLSearchParams(form).toString() };
    const outcome = await matchOf(committedMatcher(v0002), url, { method, ...body });
    expect(outcome.result?.key).toBe(`${base}{siteid}`);
    expect(outcome.entry).toMatchObject({ route: `${base}{siteid}`, state: 'legacy', kind: 'legacy-write', units: v0002.entryFor(base)?.units });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    // The base is a carried write, target with its group, or a withheld legacy-write.
    const baseEntry = v0002.entryFor(base);
    expect(baseEntry).toMatchObject(baseEntry?.kind === 'write' ? { state: 'target' } : { state: 'legacy', kind: 'legacy-write' });
  });

  it.each<[string, string, Record<string, string>?]>([
    ['an empty form siteid over a url one', '/_api/rest/v1/tenant-a/variationtargeting?siteid=tenant-a', { siteid: '' }],
    ['an empty url siteid', '/_api/rest/v1/tenant-a/variationtargeting?siteid='],
  ])('keeps a sessionless REST save with %s on strategies-content', async (_label, url, form) => {
    const body = form === undefined ? {} : { contentType: URLENCODED, body: new URLSearchParams(form).toString() };
    const outcome = await matchOf(committedMatcher(await committedIndex('v0002')), url, { method: 'POST', ...body });
    expect(outcome.result?.key).toBe('rest:variationtargeting.save');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'strategies-content' });
  });

  it.each([
    ['POST', '/index.cfm/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save'],
    ['POST', '/_api/rest/v1/tenant-a/variationtargeting', 'rest:variationtargeting.save'],
    ['DELETE', `/_API/REST/v1/tenant-a/variationtargeting/${REST_ID}`, 'rest:variationtargeting.delete'],
  ])('keeps sessionless %s %s on strategies-content as %s', async (method, url, key) => {
    const outcome = await matchOf(committedMatcher(await committedIndex('v0002')), url, { method });
    expect(outcome.result?.key).toBe(key);
    expect(outcome.entry).toMatchObject({ route: key, state: 'target', kind: 'write' });
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'strategies-content', path: url });
  });
});

describe('createMatcher Site Manager sorts under the committed v0002', () => {
  const HOME = '00000000000000000000000000000000001';
  const LIST = '/admin/?muraAction=cArch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000';
  let facts: InventoryFacts = { get: () => undefined, routes: () => [] };
  beforeAll(async () => {
    facts = await loadInventoryFacts(resolveGatewayPaths({}));
  });
  const sortMatcher = (index: RoutingIndex): Matcher =>
    createMatcher({
      state: { active: () => index },
      variants: committedVariants(),
      modes: createResponseModes(facts),
      env: { OPT2_SERVICE_URLS: SERVICE_URLS, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: keyedDir },
      clock: CLOCK,
    });
  const sorting = (form: string): Sent => ({ method: 'POST', contentType: URLENCODED, body: form });

  // Repeated orderid fields arrive comma-joined, as legacy's form scope joins them; SQL Server's `=` ignores trailing spaces.
  it.each<[string, string, string]>([
    ['the home page as topid', `&topid=${HOME}`, 'orderperm=editor&sorted=true&orderid=C1&orderid=C2'],
    ['a module root as topid', '&topid=00000000000000000000000000000000003', 'orderperm=editor&sorted=false'],
    ['a shared orderid with trailing spaces', '&topid=F1', `orderperm=author&orderid=C1&orderid=${HOME}%20%20`],
    ['no topid, which before() takes from the session', '', 'orderperm=editor&orderid=C1'],
  ])('serves a sort with %s on legacy as the legacy-write admin:carch.list{sharedid}', async (_label, search, form) => {
    const v0002 = await committedIndex('v0002');
    const outcome = await matchOf(sortMatcher(v0002), `${LIST}${search}`, sorting(form));
    expect(outcome.result?.key).toBe('admin:carch.list{sharedid}');
    expect(outcome.entry).toMatchObject({ route: 'admin:carch.list{sharedid}', state: 'legacy', kind: 'legacy-write', units: ['content.content'] });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(v0002.entryFor('admin:carch.list')).toMatchObject({ state: 'target', kind: 'write', group: 'grp:content.approval_action' });
  });

  it.each<[string, string, string]>([
    ['a folder sort', '&topid=F1', 'orderperm=editor&sorted=true&orderid=C1&orderid=C2'],
    ['a home page view posting no orderperm', `&topid=${HOME}`, 'nextN=20'],
    ['a home page sort under a read orderperm', `&topid=${HOME}`, 'orderperm=read&orderid=C1'],
  ])('keeps %s on web as the target admin:carch.list', async (_label, search, form) => {
    const outcome = await matchOf(sortMatcher(await committedIndex('v0002')), `${LIST}${search}`, sorting(form));
    expect(outcome.result?.key).toBe('admin:carch.list');
    expect(outcome.entry).toMatchObject({ route: 'admin:carch.list', state: 'target', kind: 'write' });
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'web', responseMode: 'page' });
  });
});

describe('createMatcher Site Manager lists of an unregistered site under the committed v0002', () => {
  const LIST = '/admin/?muraAction=cArch.list&moduleid=00000000000000000000000000000000000';
  const REGISTERED = new Set(['default', 'tenant-a']);
  let facts: InventoryFacts = { get: () => undefined, routes: () => [] };
  beforeAll(async () => {
    facts = await loadInventoryFacts(resolveGatewayPaths({}));
  });
  const registryMatcher = (index: RoutingIndex): Matcher =>
    createMatcher({
      state: { active: () => index },
      variants: committedVariants(),
      modes: createResponseModes(facts),
      env: { OPT2_SERVICE_URLS: SERVICE_URLS, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: keyedDir },
      clock: CLOCK,
      // The verified registry, as the gateway passes it: legacy's site ids, matched without case.
      routeKeyOptions: { siteExists: (siteId) => REGISTERED.has(siteId.toLowerCase()) },
    });

  it.each<[string, string, Sent | undefined]>([
    ['a url siteid', `${LIST}&siteid=nosuchsite`, undefined],
    ['a form siteid', LIST, { method: 'POST', contentType: URLENCODED, body: 'siteid=nosuchsite' }],
    ['a path-pair siteid', '/admin/index.cfm/carch/list/siteid/nosuchsite?moduleid=00000000000000000000000000000000000', undefined],
  ])('serves a list whose %s names no registered site on legacy as the legacy-write of admin:carch.list', async (_label, url, sent) => {
    const v0002 = await committedIndex('v0002');
    const listed = v0002.entryFor('admin:carch.list');
    const outcome = await matchOf(registryMatcher(v0002), url, sent);
    expect(listed).toMatchObject({ state: 'target', kind: 'write', units: ['content.content'] });
    expect(outcome).toMatchObject({ result: { key: 'admin:carch.list' }, haltVariant: 'siteid=unregistered' });
    expect(outcome.entry).toStrictEqual({ ...listed, state: 'legacy', kind: 'legacy-write' });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it.each<[string, string]>([
    ['a registered siteid', `${LIST}&siteid=tenant-a`],
    ['a registered siteid in another case', `${LIST}&siteid=Tenant-A`],
    ["an empty siteid, which takes the session's site", `${LIST}&siteid=`],
    ['no siteid', LIST],
  ])('keeps a list with %s on web as the target admin:carch.list', async (_label, url) => {
    const outcome = await matchOf(registryMatcher(await committedIndex('v0002')), url);
    expect(outcome.result?.key).toBe('admin:carch.list');
    expect(outcome.entry).toMatchObject({ route: 'admin:carch.list', state: 'target', kind: 'write' });
    expect(outcome).not.toHaveProperty('haltVariant');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'web', responseMode: 'page' });
  });
});


describe('createMatcher reload requests', () => {
  const CONTENT = 'content.content';
  const TARGETING = 'content.variation_targeting';
  const RELOAD: CutoverEntry = { ...entry('reload:application', 'strategies-content', 'legacy'), kind: 'legacy-write', units: [CONTENT] };
  const TARGETING_SAVE: CutoverEntry = {
    ...entry('api:variationtargeting.save', 'strategies-content'),
    kind: 'write',
    group: `grp:${TARGETING}`,
    units: [TARGETING],
  };
  const TRASH_EMPTY: CutoverEntry = {
    ...entry('admin:ctrash.empty', 'strategies-content', 'legacy'),
    kind: 'legacy-write',
    units: ['content.trash', TARGETING],
  };
  const SITE_MONITOR: CutoverEntry = { ...entry('sitemonitor:run', 'programs-sites'), kind: 'job', units: [CONTENT, 'programs_sites.site'] };
  const GLOBAL_CONFIG: CutoverEntry = entry('admin:home.redirect', 'identity', 'legacy');
  const RELOAD_INDEX = indexOf([...ENTRIES, RELOAD, TARGETING_SAVE, TRASH_EMPTY, SITE_MONITOR, GLOBAL_CONFIG]);
  const TARGETING_URL = '/_api/json/v1/default/variationtargeting/';
  const TARGETING_FORM: Sent = { method: 'POST', contentType: URLENCODED, body: 'contentid=C1&targetingjs=probe' };
  const reloading = (index: RoutingIndex = RELOAD_INDEX): Matcher => matcherWith({ active: () => index });

  it.each<[string, string, Sent | undefined, CutoverEntry, string[]]>([
    ['a target write', `${TARGETING_URL}?appreload`, TARGETING_FORM, TARGETING_SAVE, [TARGETING, CONTENT]],
    ['a legacy-write', '/admin/?muraAction=cTrash.empty&appreload', undefined, TRASH_EMPTY, ['content.trash', TARGETING, CONTENT]],
    ['a target job sharing a unit with the reload', '/_api/sitemonitor/?appreload', undefined, SITE_MONITOR, [CONTENT, 'programs_sites.site']],
  ])("serves a reload in front of %s on legacy as that writer's legacy-write over both entries' units", async (_label, url, sent, served, units) => {
    const outcome = await matchOf(reloading(), url, sent);
    expect(outcome.result).toMatchObject({ key: 'reload:application', afterReload: { key: served.route } });
    expect(outcome.entry).toStrictEqual({ ...served, state: 'legacy', kind: 'legacy-write', units });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome).toMatchObject({ holdRoutes: ['reload:application'] });
  });

  it.each<[string, string, string[]]>([
    ['the Global Config reload, in front of a legacy read', '/admin/?appreload&reload=appreload', ['admin:home.redirect']],
    ['a reload in front of a target read', '/_api/json/v1/default/?method=generateCSRFTokens&appreload', ['api:generatecsrftokens']],
    ['a reload in front of a route no entry names', '/?appreload', []],
  ])('keeps %s on the reload entry on legacy, held also by any entry behind it', async (_label, url, holdRoutes) => {
    const outcome = await matchOf(reloading(), url);
    expect(outcome.result?.key).toBe('reload:application');
    expect(outcome.entry).toStrictEqual(RELOAD);
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome).toMatchObject({ holdRoutes });
  });

  it("gates only the writer's units when the version has no reload entry, and routes the request without the key by its own entry", async () => {
    const matcher = reloading(indexOf([...ENTRIES, TARGETING_SAVE]));
    const reload = await matchOf(matcher, `${TARGETING_URL}?appreload`, TARGETING_FORM);
    expect(reload.entry).toStrictEqual({ ...TARGETING_SAVE, state: 'legacy', kind: 'legacy-write' });
    expect(reload.destination).toStrictEqual({ kind: 'legacy' });
    expect(reload).toMatchObject({ holdRoutes: [] });
    const plain = await matchOf(matcher, TARGETING_URL, TARGETING_FORM);
    expect(plain.entry).toStrictEqual(TARGETING_SAVE);
    expect(plain.destination).toMatchObject({ kind: 'target', service: 'strategies-content', path: TARGETING_URL });
    expect(plain).not.toHaveProperty('holdRoutes');
  });
});

describe('createMatcher storage key', () => {
  it('reads no storage key for a request that is not a signed file URL', async () => {
    const outcome = await matchOf(matcherWith({ env: { OPT2_STATE_DIR: keylessDir } }), '/opt2/stub/ping');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'stub' });
  });

  it.each<[string, (stateDir: string) => Promise<void>, RegExp]>([
    ['missing', () => Promise.resolve(), /ENOENT/],
    ['empty', (stateDir) => writeKey(stateDir, ' \n'), /Storage HMAC key file is empty/],
  ])('rejects while the key file is %s, then reads it again on the next signed request', async (_label, prepare, failure) => {
    const stateDir = await mkdtemp(join(root, 'retry-'));
    await prepare(stateDir);
    const matcher = matcherWith({ env: { OPT2_STATE_DIR: stateDir } });
    await expect(matchOf(matcher, FILE_URL)).rejects.toThrow(failure);
    await expect(matchOf(matcher, FILE_URL)).rejects.toThrow(failure);
    await writeKey(stateDir, `${HMAC_KEY}\n`);
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'strategies-content' });
  });

  it('keeps the key it read for later requests', async () => {
    const stateDir = await mkdtemp(join(root, 'memo-'));
    await writeKey(stateDir, HMAC_KEY);
    const matcher = matcherWith({ env: { OPT2_STATE_DIR: stateDir } });
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'strategies-content' });
    await writeKey(stateDir, OTHER_HMAC_KEY);
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'strategies-content' });
    const resigned = signed('content-files', 'reports/q2.pdf', { hmacKey: OTHER_HMAC_KEY });
    expect((await matchOf(matcher, resigned)).destination).toStrictEqual({ kind: 'bare', status: 403 });
  });
});
