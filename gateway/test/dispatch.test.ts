// Token site of OPT-2, fixture, template and remote CFC proxy requests, and the fixture Authorization relay, through the real matcher and edge dispatcher, against stand-in services.
import { Buffer } from 'node:buffer';
import replyFrom from '@fastify/reply-from';
import { UNREGISTERED_SITEID_HEADER } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  IDENTITY_SERVICE,
  LEGACY_POST_LIMIT_BYTES,
  ServiceUnavailableError,
  createService,
  loadEnv,
  systemClock,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResponseModes } from '../src/admin/response-modes.js';
import { buildRoutingIndex } from '../src/cutover/loader.js';
import type { CutoverEntry, EntryKind, InventoryFacts, OwningService, RoutingIndex } from '../src/cutover/types.js';
import { registerEdgeRoute, type DispatcherDeps } from '../src/dispatcher/dispatch.js';
import { FIXTURE_AUTHORIZATION_HEADER } from '../src/dispatcher/headers.js';
import { createMatcher } from '../src/dispatcher/match.js';
import { replyFromOptions } from '../src/dispatcher/response-head.js';
import { createSiteRegistry, type SiteRegistry } from '../src/dispatcher/site-registry.js';
import type { SiteListing } from '../src/session/bridge-client.js';
import type { SessionSnapshot } from '../src/session/identity-client.js';
import type { SessionResolution } from '../src/session/resolve.js';
import type { SessionToken } from '../src/session/token-cache.js';
import { sendBytes, startHttpDouble, type HttpDouble } from './helpers/http-double.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SESSION_ID = 'S1';
const EPOCH = 3;
const URLENCODED = 'application/x-www-form-urlencoded';
const ARCHIVE = '/legacy-fixtures/cfml/api.cfm/people/persons/00532E14-B51F-226C-36938FA3E4A6396C/archive';
const SURVEY = '/legacy-fixtures/cfml/api.cfm/surveys/surveys/7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const RATER = '/core/modules/v1/rater/ajax/saveRate.cfm';
const FAVORITES = '/core/modules/v1/favorites/ajax';
const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const NO_FACTS: InventoryFacts = { get: () => undefined, routes: () => [] };
const TOKEN_CLAIMS: SessionToken['claims'] = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: 'U',
  sid: SESSION_ID,
  tid: '00000000-0000-4000-8000-000000000001',
  site: 'default',
  roles: [],
  s2: false,
  epoch: EPOCH,
  iat: 1_700_000_000,
  exp: 4_000_000_000,
};

function entry(route: string, owningService: OwningService, kind: EntryKind): CutoverEntry {
  return { route, owningService, tableVersion: 'v0002', state: 'target', kind, group: null, units: [], disposition: 'carry' };
}

const INDEX: RoutingIndex = buildRoutingIndex(
  {
    tableVersion: 'v0002',
    previous: 'v0001',
    sourceSha: SHA,
    createdAt: '2026-06-30T12:00:00Z',
    groupAuthority: {},
    rollbackRefs: [],
    entries: [
      entry('opt2:/opt2/admin/reporting/**', 'web', 'read'),
      entry('opt2:/opt2/admin-actions/reporting/**', 'web', 'write'),
      entry('opt2:/opt2/stub/**', 'stub', 'read'),
      entry('fixture:people/persons/{id}/archive@post', 'people', 'write'),
      entry('fixture:surveys/surveys/{id}/launch@get', 'surveys', 'write'),
      entry('fixture:surveys/surveys/{id}/launch@post', 'surveys', 'write'),
      entry('cfm:/core/modules/v1/rater/ajax/saverate.cfm', 'strategies-content', 'write'),
      entry('cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm', 'people', 'write'),
      entry('cfm:/core/modules/v1/favorites/ajax/deletefavorite.cfm', 'people', 'write'),
      entry('cfm:/core/modules/v1/favorites/ajax/deleterssfavorite.cfm', 'people', 'write'),
      entry('cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=flag', 'strategies-content', 'write'),
    ],
  },
  { sourceSha: SHA, variants: [] },
  {
    sourceSha: SHA,
    generatedBy: 'gateway/src/cutover/build-groups.ts',
    inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
    groups: [],
  },
);

interface Harness {
  app: FastifyInstance;
  web: HttpDouble;
  stub: HttpDouble;
  people: HttpDouble;
  content: HttpDouble;
  surveys: HttpDouble;
  legacy: HttpDouble;
  deps: DispatcherDeps;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The edge dispatcher over the real matcher, with an active session whose token cache answers `tok:<site>`, and `sites` when given. */
async function harness(sites?: DispatcherDeps['sites']): Promise<Harness> {
  const web = await startHttpDouble((_req, res) => sendBytes(res, 200, 'web-body', { 'content-type': 'text/html' }));
  const stub = await startHttpDouble((_req, res) => sendBytes(res, 200, 'stub-body', { 'content-type': 'text/plain' }));
  const people = await startHttpDouble((_req, res) => sendBytes(res, 200, '{}', { 'content-type': 'application/json' }));
  const content = await startHttpDouble((_req, res) => sendBytes(res, 200, '{}', { 'content-type': 'text/html' }));
  const surveys = await startHttpDouble((_req, res) => sendBytes(res, 200, '{}', { 'content-type': 'application/json' }));
  const legacy = await startHttpDouble((_req, res) => sendBytes(res, 200, '{}', { 'content-type': 'application/json' }));
  const urls = { web: web.url, stub: stub.url, people: people.url, 'strategies-content': content.url, surveys: surveys.url };
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: SILENT,
  });
  const session: SessionResolution = {
    kind: 'session',
    sessionId: SESSION_ID,
    epoch: EPOCH,
    mode: 'legacy-primary',
    legacyCookies: {},
    setCookies: [],
  };
  const deps: DispatcherDeps = {
    matcher: createMatcher({
      state: { active: () => INDEX },
      variants: { sourceSha: SHA, variants: [] },
      modes: createResponseModes(NO_FACTS),
      env: { OPT2_SERVICE_URLS: urls, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: '/nonexistent' },
      clock: systemClock,
    }),
    state: {
      active: () => INDEX,
      readEpochForWrite: async () => ({ epoch: 1, index: INDEX }),
      isFrozen: () => false,
      waitUnfrozen: async () => true,
    },
    inflight: { register: async () => undefined, remove: async () => true, abandon: async () => true },
    windows: {
      open: async () => ({ windowId: 'W1' }),
      complete: async () => ({ state: 'import-pending' as const }),
      scope: () => ({ table: true as const }),
    },
    barrier: {
      declare: async () => undefined,
      record: async () => undefined,
      release: async () => undefined,
      awaitForSession: async () => undefined,
      awaitPositions: async () => undefined,
      awaitOwners: async () => undefined,
    },
    resolver: {
      resolveSession: vi.fn(async () => session),
      resolveLegacyBound: async () => ({ kind: 'none', setCookies: [] }),
      adoptAfterLegacy: async () => ({ kind: 'none', setCookies: [] }),
    },
    tokenCache: {
      get: vi.fn(async (_sessionId: string, siteId: string | undefined) => ({ token: `tok:${siteId ?? ''}`, claims: TOKEN_CLAIMS })),
    },
    identity: { adminSite: vi.fn(async () => ''), snapshot: vi.fn(async () => undefined) },
    sites,
    stateCheck: {
      check: async () => ({ state: 'active' as const, epoch: EPOCH, userId: 'U', siteId: 'default', epochChanged: false }),
    },
    hydrator: { ensureHydrated: async () => undefined },
    carry: { beforeLegacy: async () => undefined, afterLegacy: async () => undefined },
    csrf: { beforeLegacy: async () => undefined, afterLegacy: async () => undefined },
    invalidation: {
      afterTargetLogout: async () => undefined,
      beforeLegacyLogout: async () => undefined,
      afterLegacyLogout: async () => undefined,
      afterLegacyLogin: async () => undefined,
      completePending: async () => 'logged-out' as const,
      afterTargetLogin: () => undefined,
    },
    facts: NO_FACTS,
    auth: app.opt2.auth,
    relay: {
      env: { OPT2_SERVICE_URLS: urls },
      invocation: app.opt2.auth.invocationMinter,
      barrier: {
        declare: async () => undefined,
        record: async () => undefined,
        release: async () => undefined,
        awaitPositions: async () => undefined,
        awaitOwners: async () => undefined,
      },
      sessionMode: () => 'legacy-primary',
    },
    legacyOrigin: legacy.url,
    cookieSettings: { secure: false, domain: '' },
    clock: systemClock,
  };
  await app.register(replyFrom, replyFromOptions());
  await app.register(async (edge) => {
    edge.removeAllContentTypeParsers();
    edge.addContentTypeParser<Buffer>('*', { parseAs: 'buffer', bodyLimit: LEGACY_POST_LIMIT_BYTES }, (_request, body, done) =>
      done(null, body),
    );
    registerEdgeRoute(edge, deps);
  });
  await app.ready();
  closers.push(async () => {
    await app.opt2.shutdown();
    await Promise.all([web.close(), stub.close(), people.close(), content.close(), surveys.close(), legacy.close()]);
  });
  return { app, web, stub, people, content, surveys, legacy, deps };
}

/** Identity's snapshot of the session, its user's `siteID` as given. */
function snapshotOf(siteID: string): SessionSnapshot {
  return { sessionId: SESSION_ID, epoch: EPOCH, loginSnapshot: { user: { userID: 'U', siteID }, roles: [] }, csrfSecretKey: 'K', usedTokens: [] };
}

describe('OPT-2 user token site', () => {
  const EXPORTS = '/opt2/admin/reporting/exports';
  it.each<[string, string, string | undefined, string, string, boolean, 'web' | 'stub']>([
    ['a screen naming its site, over the stored one', `${EXPORTS}?siteid=tenant-b`, undefined, 'tenant-a', 'tenant-b', false, 'web'],
    ['a screen without a site, for the stored site', EXPORTS, undefined, 'tenant-a', 'tenant-a', true, 'web'],
    ['a screen with an empty siteid, for the stored site', `${EXPORTS}?siteid=`, undefined, 'tenant-a', 'tenant-a', true, 'web'],
    ['a screen without a site, for default when none is stored', `${EXPORTS}?page=2`, undefined, '', 'default', true, 'web'],
    ['a screen spelling siteid in any case, for the site as sent', `${EXPORTS}?SiteID=Tenant-B`, undefined, 'tenant-a', 'Tenant-B', false, 'web'],
    [
      'a post action whose form siteid overwrites the query one',
      '/opt2/admin-actions/reporting/create?siteid=tenant-a',
      'siteid=tenant-b',
      'tenant-a',
      'tenant-b',
      false,
      'web',
    ],
    ['a service request naming its site', '/opt2/stub/notes?siteid=tenant-b', undefined, 'tenant-a', 'tenant-b', false, 'stub'],
    ['a service request without a site, for default', '/opt2/stub/notes', undefined, 'tenant-a', 'default', false, 'stub'],
  ])('mints the token of %s', async (_label, url, form, stored, site, readsStored, served) => {
    const h = await harness();
    vi.mocked(h.deps.identity.adminSite).mockResolvedValue(stored);
    const res = await h.app.inject(
      form === undefined ? { method: 'GET', url } : { method: 'POST', url, headers: { 'content-type': URLENCODED }, payload: form },
    );
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID, site, EPOCH);
    expect(h.deps.identity.adminSite).toHaveBeenCalledTimes(readsStored ? 1 : 0);
    const [target, other] = served === 'web' ? [h.web, h.stub] : [h.stub, h.web];
    expect(target.requests.map((r) => r.headers.authorization)).toEqual([`Bearer tok:${site}`]);
    expect(other.requests).toHaveLength(0);
  });

  it('takes no site, tenant or role from forged headers or a client token, and forwards none of them', async () => {
    const h = await harness();
    vi.mocked(h.deps.identity.adminSite).mockResolvedValue('tenant-a');
    const forged = {
      authorization: 'Bearer forged-tenant-b',
      'x-serverless-authorization': 'Bearer forged',
      'x-opt2-original-url': '/opt2/admin/reporting/exports?siteid=tenant-b',
      'x-opt2-site-id': 'tenant-b',
      'x-opt2-tenant-id': '00000000-0000-4000-8000-00000000000b',
      'x-opt2-roles': 's2',
    };
    const res = await h.app.inject({ method: 'GET', url: EXPORTS, headers: forged });
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'tenant-a', EPOCH);
    const received = h.web.requests[0]?.headers ?? {};
    expect(received.authorization).toBe('Bearer tok:tenant-a');
    expect(received['x-serverless-authorization']).toMatch(/^Bearer (?!forged$)/);
    for (const name of ['x-opt2-original-url', 'x-opt2-site-id', 'x-opt2-tenant-id', 'x-opt2-roles']) {
      expect(received[name]).toBeUndefined();
    }
  });

  it('mints one token per tenant as a session moves between sites, the site-less request following the stored one', async () => {
    const h = await harness();
    vi.mocked(h.deps.identity.adminSite).mockResolvedValue('tenant-b');
    for (const url of [`${EXPORTS}?siteid=tenant-a`, `${EXPORTS}?siteid=tenant-b`, EXPORTS]) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
    expect(vi.mocked(h.deps.tokenCache.get).mock.calls.map(([, site]) => site)).toEqual(['tenant-a', 'tenant-b', 'tenant-b']);
    expect(h.deps.identity.adminSite).toHaveBeenCalledTimes(1);
    expect(h.web.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer tok:tenant-a',
      'Bearer tok:tenant-b',
      'Bearer tok:tenant-b',
    ]);
  });
});

describe('fixture user token site', () => {
  const FROM = 'effectiveFrom=2026-05-13';
  it.each<[string, string, [contentType: string, payload: string] | undefined, string | null, string, boolean]>([
    ['a form siteid', ARCHIVE, [URLENCODED, `siteid=tenant-a&${FROM}`], 'tenant-b', 'tenant-a', false],
    ['a query siteid', `${ARCHIVE}?siteid=tenant-a`, [URLENCODED, FROM], 'tenant-b', 'tenant-a', false],
    ['a form siteid over the query one', `${ARCHIVE}?siteid=tenant-b`, [URLENCODED, 'siteid=tenant-a'], 'tenant-b', 'tenant-a', false],
    [
      'a JSON body siteid over the query one',
      `${ARCHIVE}?siteid=tenant-b`,
      ['application/json', '{"siteid":"tenant-a"}'],
      'tenant-b',
      'tenant-a',
      false,
    ],
    ['a request without a site, for the session user site', ARCHIVE, [URLENCODED, FROM], 'tenant-b', 'tenant-b', true],
    ['an empty siteid, for the session user site', ARCHIVE, [URLENCODED, `siteid=&${FROM}`], 'tenant-b', 'tenant-b', true],
    ['a request without a site, for default when the user has no site', ARCHIVE, undefined, '', 'default', true],
    ['a request without a site, for default when identity holds no snapshot', ARCHIVE, undefined, null, 'default', true],
  ])('mints the token of %s', async (_label, url, body, userSite, site, readsSnapshot) => {
    const h = await harness();
    vi.mocked(h.deps.identity.snapshot).mockResolvedValue(userSite === null ? undefined : snapshotOf(userSite));
    const res = await h.app.inject(
      body === undefined ? { method: 'POST', url } : { method: 'POST', url, headers: { 'content-type': body[0] }, payload: body[1] },
    );
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID, site, EPOCH);
    expect(h.deps.identity.snapshot).toHaveBeenCalledTimes(readsSnapshot ? 1 : 0);
    if (readsSnapshot) expect(h.deps.identity.snapshot).toHaveBeenCalledWith(SESSION_ID);
    expect(h.deps.identity.adminSite).not.toHaveBeenCalled();
    expect(h.people.requests.map((r) => r.headers.authorization)).toEqual([`Bearer tok:${site}`]);
  });

  it.each([
    ['//legacy-fixtures/cfml/api.cfm/PEOPLE/Persons/00532E14-B51F-226C-36938FA3E4A6396C/ARCHIVE?siteid=tenant-a'],
    ['/legacy-fixtures//cfml/api.cfm/people%2Fpersons/00532E14-B51F-226C-36938FA3E4A6396C/archive/?siteid=tenant-a'],
  ])('forwards %s to the service on the api.cfm path legacy dispatches, the query as sent', async (url) => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url, headers: { 'content-type': URLENCODED }, payload: FROM });
    expect(res.statusCode).toBe(200);
    expect(h.people.requests.map((r) => r.url)).toEqual([`${ARCHIVE}?siteid=tenant-a`]);
  });

  it('fails closed with the fixture 503, calling no service, when identity cannot report the session user', async () => {
    const h = await harness();
    vi.mocked(h.deps.identity.snapshot).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));
    const res = await h.app.inject({ method: 'POST', url: ARCHIVE });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"apiversion":"v1","method":"people.persons.archive","error":{"code":"server_error","message":"Unhandled Exception"}}');
    expect(h.deps.tokenCache.get).not.toHaveBeenCalled();
    expect(h.people.requests).toHaveLength(0);
  });
});

describe('fixture Authorization relay', () => {
  const CREDENTIAL = `Basic ${Buffer.from('opt2-task:task-secret', 'utf8').toString('base64')}`;
  const SPOOFED = `Basic ${Buffer.from('opt2-task:spoofed', 'utf8').toString('base64')}`;
  const RELAYED = FIXTURE_AUTHORIZATION_HEADER.toLowerCase();
  const LAUNCH = `${SURVEY}/launch?siteid=tenant-a`;

  it.each<[string, 'GET' | 'POST', string]>([
    ['a GET task run Basic credential', 'GET', CREDENTIAL],
    ['a POST task run Basic credential', 'POST', CREDENTIAL],
    ['a scheme in another case with inner padding', 'GET', 'bAsIc   b3B0Mi10YXNrOnRhc2stc2VjcmV0'],
    ['a value of another scheme', 'GET', 'Bearer client-token'],
  ])('relays %s verbatim to a target fixture route of a request without a session', async (_label, method, authorization) => {
    const h = await harness();
    vi.mocked(h.deps.resolver.resolveSession).mockResolvedValueOnce({ kind: 'none', setCookies: [] });
    const res = await h.app.inject({ method, url: LAUNCH, headers: { authorization } });
    expect(res.statusCode).toBe(200);
    expect(h.surveys.requests.map((r) => [r.headers[RELAYED], r.headers.authorization])).toEqual([[authorization, undefined]]);
    expect(h.legacy.requests).toHaveLength(0);
  });

  it('relays the credential beside the session user token, which alone travels in Authorization', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: LAUNCH, headers: { authorization: CREDENTIAL } });
    expect(res.statusCode).toBe(200);
    expect(h.surveys.requests.map((r) => [r.headers[RELAYED], r.headers.authorization])).toEqual([[CREDENTIAL, 'Bearer tok:tenant-a']]);
  });

  it.each<[string, Record<string, string>, string | undefined]>([
    ['alone', { [FIXTURE_AUTHORIZATION_HEADER]: CREDENTIAL }, undefined],
    ['beside an Authorization, relaying only that', { [FIXTURE_AUTHORIZATION_HEADER]: SPOOFED, authorization: CREDENTIAL }, CREDENTIAL],
  ])('strips a client-sent fixture Authorization header %s', async (_label, headers, relayed) => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: LAUNCH, headers });
    expect(res.statusCode).toBe(200);
    expect(h.surveys.requests.map((r) => r.headers[RELAYED])).toEqual([relayed]);
  });

  it.each<[string, string, 'stub' | 'content']>([
    ['an OPT-2 service request', '/opt2/stub/notes', 'stub'],
    ['a remote CFC proxy call', '/core/modules/v1/comments/ajax/commentsProxy.cfc?method=flag&commentID=C', 'content'],
  ])('relays no Authorization for %s, which is no fixture route', async (_label, url, served) => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url, headers: { authorization: CREDENTIAL } });
    expect(res.statusCode).toBe(200);
    const target = served === 'stub' ? h.stub : h.content;
    expect(target.requests.map((r) => [r.headers[RELAYED], r.headers.authorization])).toEqual([[undefined, 'Bearer tok:default']]);
  });

  it.each<[string, Record<string, string>]>([
    ['a task run credential', { authorization: CREDENTIAL }],
    ['a task run credential beside a client-sent fixture Authorization header', { authorization: CREDENTIAL, [FIXTURE_AUTHORIZATION_HEADER]: SPOOFED }],
  ])('forwards %s of a legacy-bound fixture route to legacy in Authorization alone', async (_label, headers) => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: `${SURVEY}/remind?siteid=tenant-a&reminder=1`, headers });
    expect(res.statusCode).toBe(200);
    expect(h.legacy.requests.map((r) => [r.headers.authorization, r.headers[RELAYED]])).toEqual([[CREDENTIAL, undefined]]);
    expect(h.surveys.requests).toHaveLength(0);
  });
});

describe('template user token site', () => {
  const RATING = 'contentID=C&siteID=tenant-a&userID=U&rate=5';
  it.each<[string, string, string | undefined, string | undefined, string, 'content' | 'people']>([
    ['a rating, for its form siteID', RATER, RATING, undefined, 'tenant-a', 'content'],
    ['a rating on the default site host, for its form siteID', RATER, RATING, 'localhost:8100', 'tenant-a', 'content'],
    ['a rating, for its form siteID over the query one', `${RATER}?siteid=default`, RATING, 'tenant-b.localhost', 'tenant-a', 'content'],
    ['a rating without a form siteID, for default', `${RATER}?siteid=tenant-a`, 'rate=5', undefined, 'default', 'content'],
    [
      'a favorite, for its query siteID over the form one',
      `${FAVORITES}/saveFavorite.cfm?siteID=tenant-b&userID=U`,
      'siteid=tenant-a',
      undefined,
      'tenant-b',
      'people',
    ],
    [
      'an RSS favorite delete, for its query siteID',
      `${FAVORITES}/deleteRSSFavorite.cfm?userID=U&siteID=tenant-b`,
      undefined,
      undefined,
      'tenant-b',
      'people',
    ],
    [
      'a favorite delete, which binds no site, for default',
      `${FAVORITES}/deleteFavorite.cfm?favoriteID=F&siteid=tenant-a`,
      undefined,
      undefined,
      'default',
      'people',
    ],
  ])('mints the token of %s', async (_label, url, form, host, site, served) => {
    const h = await harness();
    const headers = host === undefined ? {} : { host };
    const res = await h.app.inject(
      form === undefined
        ? { method: 'GET', url, headers }
        : { method: 'POST', url, headers: { ...headers, 'content-type': URLENCODED }, payload: form },
    );
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID, site, EPOCH);
    expect(h.deps.identity.adminSite).not.toHaveBeenCalled();
    expect(h.deps.identity.snapshot).not.toHaveBeenCalled();
    const [target, other] = served === 'content' ? [h.content, h.people] : [h.people, h.content];
    expect(target.requests.map((r) => r.headers.authorization)).toEqual([`Bearer tok:${site}`]);
    expect(other.requests).toHaveLength(0);
  });
});

/** Legacy's sites on `<siteid>.localhost`, `default` on `localhost`, with `tenant-a` first in bind order and an admin domain. */
const CFC_SITES: SiteListing = {
  sites: ['default', 'tenant-a', 'tenant-b'],
  bindings: [
    { siteId: 'tenant-a', domain: 'tenant-a.localhost', aliases: [] },
    { siteId: 'default', domain: 'localhost', aliases: [] },
    { siteId: 'tenant-b', domain: 'tenant-b.localhost', aliases: [] },
  ],
  adminDomain: 'admin.localhost',
};

/** The site registry over {@link CFC_SITES}, loaded once without its refresh loop. */
async function loadedRegistry(): Promise<SiteRegistry> {
  const registry = createSiteRegistry({ list: () => Promise.resolve(CFC_SITES), logger: { error: () => undefined } });
  await registry.refresh();
  return registry;
}

describe('remote CFC proxy user token site', () => {
  const FLAG = '/core/modules/v1/comments/ajax/commentsProxy.cfc?method=flag&commentID=C';
  const UNDEFINED = `${FLAG}&siteid=undefined`;
  const TENANT_B_HOST = { host: 'tenant-b.localhost' };
  // `b.localhost` is no site's domain but tenant-b's contains it; legacy's absent-siteid default redirects it and the admin domain.
  const PARTIAL_HOST = { host: 'b.localhost' };
  const ADMIN_HOST = { host: 'admin.localhost' };
  it.each<[string, string, Record<string, string>, boolean, string, boolean]>([
    ['siteid=undefined, as comments.js sends it, for the Host site', UNDEFINED, TENANT_B_HOST, true, 'tenant-b', true],
    ['a registered siteid, over the Host site', `${FLAG}&siteid=tenant-a`, TENANT_B_HOST, true, 'tenant-a', false],
    ['a registered siteid in another case, for the site as sent', `${FLAG}&siteid=Tenant-A`, TENANT_B_HOST, true, 'Tenant-A', false],
    [
      'a registered siteid with a client-sent mark, which the gateway strips',
      `${FLAG}&siteid=tenant-a`,
      { ...TENANT_B_HOST, [UNREGISTERED_SITEID_HEADER]: 'true' },
      true,
      'tenant-a',
      false,
    ],
    ['no siteid, for the Host site without its port', FLAG, { host: 'tenant-b.localhost:8100' }, true, 'tenant-b', false],
    ['an empty siteid, for the Host site', `${FLAG}&siteid=`, { host: 'tenant-a.localhost' }, true, 'tenant-a', false],
    [
      'siteid=undefined, for the X-Forwarded-Host site over the Host one',
      UNDEFINED,
      { ...TENANT_B_HOST, 'x-forwarded-host': 'tenant-a.localhost' },
      true,
      'tenant-a',
      true,
    ],
    ['siteid=undefined on the default site host', UNDEFINED, { host: 'localhost:8100' }, true, 'default', true],
    ['siteid=undefined on an unbound host, for the first site in bind order', UNDEFINED, { host: 'other.test' }, true, 'tenant-a', true],
    ['no siteid on an unbound host, for the first site in bind order', FLAG, { host: 'other.test' }, true, 'tenant-a', false],
    ['siteid=undefined on a host a site domain contains, for that site', UNDEFINED, PARTIAL_HOST, true, 'tenant-b', true],
    ['an empty siteid on a host a site domain contains, for that site', `${FLAG}&siteid=`, PARTIAL_HOST, true, 'tenant-b', false],
    ['no siteid on a host a site domain contains, for default', FLAG, PARTIAL_HOST, true, 'default', false],
    ['siteid=undefined on the admin domain, for default', UNDEFINED, ADMIN_HOST, true, 'default', true],
    ['no siteid on the admin domain, for default', FLAG, ADMIN_HOST, true, 'default', false],
    ['siteid=undefined without a registry, for the siteid as sent', UNDEFINED, TENANT_B_HOST, false, 'undefined', false],
    ['no siteid without a registry, for default', FLAG, TENANT_B_HOST, false, 'default', false],
  ])('mints the token of %s, marking only a siteid naming no registered site', async (_label, url, headers, withRegistry, site, marked) => {
    const h = await harness(withRegistry ? await loadedRegistry() : undefined);
    const res = await h.app.inject({ method: 'GET', url, headers });
    expect(res.statusCode).toBe(200);
    expect(h.deps.tokenCache.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID, site, EPOCH);
    expect(h.deps.identity.adminSite).not.toHaveBeenCalled();
    expect(h.content.requests.map((r) => r.headers.authorization)).toEqual([`Bearer tok:${site}`]);
    expect(h.content.requests.map((r) => r.headers[UNREGISTERED_SITEID_HEADER.toLowerCase()])).toEqual([marked ? 'true' : undefined]);
  });
});
