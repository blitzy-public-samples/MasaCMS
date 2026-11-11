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
import { buildRoutingIndex, listVersions, loadVersion } from '../../src/cutover/loader.js';
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
import {
  BUCKET_OWNERS,
  RELAY_ALIAS_PREFIX,
  createMatcher,
  type MatchOutcome,
  type MatchRequest,
  type Matcher,
  type MatcherDeps,
} from '../../src/dispatcher/match.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const NOW = '2026-06-30T12:00:00Z';
const NOW_S = Date.parse(NOW) / 1000;
const CLOCK = fixedClock(NOW);
const URLENCODED = 'application/x-www-form-urlencoded';
const BOUNDARY = 'opt2-request-matcher';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const FILES_ROUTE_PREFIX = 'opt2:/opt2/files/';
const FINANCE_FILES_ROUTE = `${FILES_ROUTE_PREFIX}finance-attachments/**`;
const LIST_URL = '/admin/?muraAction=cUsers.list&siteid=default';
const HMAC_KEY = randomBytes(32).toString('hex');
const OTHER_HMAC_KEY = randomBytes(32).toString('hex');

const SERVICES: readonly OwningService[] = ['identity', 'people', 'strategies-content', 'reporting', 'finance', 'e-signature', 'stub', 'web'];
const urlOf = (service: string): string => `http://${service}.opt2.test`;
const SERVICE_URLS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(SERVICES.map((s) => [s, urlOf(s)])));

function entry(route: string, owningService: OwningService, state: Authority = 'target'): CutoverEntry {
  return { route, owningService, tableVersion: 'v0002', state, kind: 'read', group: null, units: [], disposition: 'carry' };
}

const ENTRIES: readonly CutoverEntry[] = [
  entry('opt2:/opt2/stub/**', 'stub'),
  entry('opt2:/opt2/admin/finance/**', 'web'),
  entry('opt2:/opt2/admin/reporting/**', 'web', 'legacy'),
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

const FILE_URL = signed('finance-attachments', 'reports/q2.pdf');
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
  const request: MatchRequest = bytes === undefined ? { url, method, headers } : { url, method, headers, body: bytes };
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
    ['/opt2/svc/finance/v1/records/a%20b/', 'finance', '/v1/records/a%20b/'],
    ['/opt2/svc/', '', '/'],
  ])('relays %s as service "%s" with service path %s', async (url, service, path) => {
    expect((await matchOf(matcherWith(), url)).destination).toStrictEqual({ kind: 'relay', service, path });
  });

  it.each(['/opt2/svc', '/OPT2/SVC/people/v1', '/opt2/%73vc/people/v1'])(
    'keys %s, which is not the exact alias prefix, and routes it by the table',
    async (url) => {
      const outcome = await matchOf(matcherWith(), url);
      expect(outcome.result?.key.startsWith('opt2:/opt2/svc')).toBe(true);
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
    expect(outcome.failContext).toStrictEqual({ surface: 'admin' });
  });

  it.each([
    ['/admin/?muraAction=cUsers.edit&userid=1', 'admin:cusers.edit'],
    ['/opt2/admin/reporting/exports', 'opt2:/opt2/admin/reporting/**'],
  ])('sends %s, whose entry is legacy, to legacy with the entry it matched', async (url, route) => {
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.entry?.route).toBe(route);
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

describe('createMatcher unavailable destinations', () => {
  it('answers no-active-version with the computed key and its fail context when no version is active', async () => {
    const outcome = await matchOf(matcherWith({ active: () => undefined }), '/opt2/stub/ping?siteid=default');
    expect(outcome.result?.key).toBe('opt2:/opt2/stub/ping');
    expect(outcome.entry).toBeUndefined();
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'no-active-version' });
    expect(outcome.failContext).toEqual({ surface: 'api', params: { siteid: 'default' } });
  });

  it.each([
    ['a variant without an inventoried response mode', '/admin/index.cfm', 'muraAction=cUsers.update&type=1', 'admin:cusers.update{type=1}'],
    ['a non-core subsystem action', '/admin/index.cfm', 'muraAction=myplugin:main.default', 'admin:myplugin:main.default'],
  ])('answers admin-unmapped, never legacy, for %s', async (_label, url, body, key) => {
    const outcome = await matchOf(matcherWith(), url, { method: 'POST', contentType: URLENCODED, body });
    expect(outcome.result?.key).toBe(key);
    expect(outcome.entry?.route).toBe(key);
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'admin-unmapped' });
    expect(outcome.failContext).toStrictEqual({ surface: 'admin' });
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
    ['finance', FILE_URL],
  ])('answers no-service-url when OPT2_SERVICE_URLS lacks %s for %s', async (service, url) => {
    const urls = Object.fromEntries(Object.entries(SERVICE_URLS).filter(([name]) => name !== service));
    const outcome = await matchOf(matcherWith({ env: { OPT2_SERVICE_URLS: urls } }), url);
    expect(outcome.destination).toStrictEqual({ kind: 'unavailable', reason: 'no-service-url' });
  });
});

describe('createMatcher bare destinations', () => {
  it.each<Authority>(['target', 'legacy'])('answers 404 for the legacy bridge in a %s entry, which the edge never reaches', async (state) => {
    const index = indexOf([entry('bridge:/gateway/legacy-bridge/**', 'gateway', state)]);
    const outcome = await matchOf(matcherWith({ active: () => index }), '/gateway/legacy-bridge/cfml/session.cfm?op=describe');
    expect(outcome.entry?.route).toBe('bridge:/gateway/legacy-bridge/**');
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });

  it('answers 404 for a signed file URL when storage is not the local adapter, without reading the key', async () => {
    const matcher = matcherWith({ env: { OPT2_STORAGE_ADAPTER: 'cloud', OPT2_STATE_DIR: keylessDir } });
    const outcome = await matchOf(matcher, FILE_URL);
    expect(outcome.entry?.route).toBe(FINANCE_FILES_ROUTE);
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 404 });
  });
});

describe('createMatcher target destinations', () => {
  it('sends a target entry to its owning service with the request target unchanged', async () => {
    const url = '/opt2/stub/ping?a=1&a=2&a=3';
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.entry?.route).toBe('opt2:/opt2/stub/**');
    expect(outcome.destination).toStrictEqual({ kind: 'target', service: 'stub', serviceUrl: urlOf('stub'), path: url, isWeb: false });
    expect(outcome.failContext).toEqual({ surface: 'api', params: { a: '1,2,3' } });
  });

  it('marks a web-owned entry outside the admin family as web, without an admin mapping', async () => {
    const url = '/opt2/admin/finance/records?id=7';
    expect((await matchOf(matcherWith(), url)).destination).toStrictEqual({
      kind: 'target',
      service: 'web',
      serviceUrl: urlOf('web'),
      path: url,
      isWeb: true,
    });
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
    });
  });

  it.each<[string, string, Sent, string, string]>([
    ['GET', LIST_URL, {}, '/admin/cusers/list?muraAction=cUsers.list&siteid=default', 'GET'],
    ['HEAD', LIST_URL, { method: 'HEAD' }, '/admin/cusers/list?muraAction=cUsers.list&siteid=default', 'HEAD'],
    [
      'POST',
      '/admin/index.cfm',
      { method: 'POST', contentType: URLENCODED, body: 'muraAction=cUsers.list&siteid=default&keywords=a+b' },
      '/admin/cusers/list?muraAction=cUsers.list&siteid=default&keywords=a+b',
      'GET',
    ],
  ])('maps a target page action sent as %s to web as %s with no body, whatever the entry owner', async (_method, url, sent, path, method) => {
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
      forwardBody: false,
    });
    expect(outcome.failContext).toStrictEqual({ surface: 'admin' });
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
    const url = signed('finance-attachments', 'Reports/Q2 Summary.PDF');
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.result?.key).toBe('opt2:/opt2/files/finance-attachments/reports/q2 summary.pdf');
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'finance', path: url });
  });

  it.each([
    ['an upper-case prefix', FILE_URL.replace('/opt2/files/', '/OPT2/FILES/')],
    ['a mixed-case prefix', FILE_URL.replace('/opt2/files/', '/opt2/Files/')],
    ['a percent-encoded files segment', FILE_URL.replace('/opt2/files/', '/opt2/%66iles/')],
    ['a percent-encoded namespace segment', FILE_URL.replace('/opt2/files/', '/%6Fpt2/files/')],
    ['an index.cfm segment the key drops', FILE_URL.replace('/opt2/files/', '/opt2/index.cfm/files/')],
    ['a dot segment out of the bucket', `/opt2/files/finance-attachments/../reporting-exports/q2.pdf${FILE_QUERY}`],
    ['a tampered signature', FILE_URL.replace(/sig=([0-9a-f])/, (_match, digit: string) => `sig=${digit === '0' ? '1' : '0'}`)],
    ['a signature from another key', signed('finance-attachments', 'reports/q2.pdf', { hmacKey: OTHER_HMAC_KEY })],
    ['an expired signature', signed('finance-attachments', 'reports/q2.pdf', { expires: NOW_S - 1 })],
    ['no signature', '/opt2/files/finance-attachments/reports/q2.pdf'],
  ])('answers 403 for %s, which still keys to the bucket entry', async (_label, url) => {
    const outcome = await matchOf(matcherWith(), url);
    expect(outcome.result?.key.startsWith(`${FILES_ROUTE_PREFIX}finance-attachments/`)).toBe(true);
    expect(outcome.entry?.route).toBe(FINANCE_FILES_ROUTE);
    expect(outcome.destination).toStrictEqual({ kind: 'bare', status: 403 });
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
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'finance' });
  });

  it('keeps the key it read for later requests', async () => {
    const stateDir = await mkdtemp(join(root, 'memo-'));
    await writeKey(stateDir, HMAC_KEY);
    const matcher = matcherWith({ env: { OPT2_STATE_DIR: stateDir } });
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'finance' });
    await writeKey(stateDir, OTHER_HMAC_KEY);
    expect((await matchOf(matcher, FILE_URL)).destination).toMatchObject({ kind: 'target', service: 'finance' });
    const resigned = signed('finance-attachments', 'reports/q2.pdf', { hmacKey: OTHER_HMAC_KEY });
    expect((await matchOf(matcher, resigned)).destination).toStrictEqual({ kind: 'bare', status: 403 });
  });
});
