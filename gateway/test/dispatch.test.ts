// Token site of OPT-2 and fixture requests through the real matcher and edge dispatcher, against stand-in web, stub and people services.
import { Buffer } from 'node:buffer';
import replyFrom from '@fastify/reply-from';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
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
import { createMatcher } from '../src/dispatcher/match.js';
import type { SessionSnapshot } from '../src/session/identity-client.js';
import type { SessionResolution } from '../src/session/resolve.js';
import { sendBytes, startHttpDouble, type HttpDouble } from './helpers/http-double.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SESSION_ID = 'S1';
const EPOCH = 3;
const URLENCODED = 'application/x-www-form-urlencoded';
const ARCHIVE = '/legacy-fixtures/cfml/api.cfm/people/persons/00532E14-B51F-226C-36938FA3E4A6396C/archive';
const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const NO_FACTS: InventoryFacts = { get: () => undefined, routes: () => [] };

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
  deps: DispatcherDeps;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The edge dispatcher over the real matcher, with an active session whose token cache answers `tok:<site>`. */
async function harness(): Promise<Harness> {
  const web = await startHttpDouble((_req, res) => sendBytes(res, 200, 'web-body', { 'content-type': 'text/html' }));
  const stub = await startHttpDouble((_req, res) => sendBytes(res, 200, 'stub-body', { 'content-type': 'text/plain' }));
  const people = await startHttpDouble((_req, res) => sendBytes(res, 200, '{}', { 'content-type': 'application/json' }));
  const urls = { web: web.url, stub: stub.url, people: people.url };
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
    inflight: { register: async () => undefined, remove: async () => true },
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
    tokenCache: { get: vi.fn(async (_sessionId: string, siteId: string | undefined) => `tok:${siteId ?? ''}`) },
    identity: { adminSite: vi.fn(async () => ''), snapshot: vi.fn(async () => undefined) },
    stateCheck: {
      check: async () => ({ state: 'active' as const, epoch: EPOCH, userId: 'U', siteId: 'default', epochChanged: false }),
    },
    hydrator: { ensureHydrated: async () => undefined },
    csrf: { beforeLegacy: async () => undefined, afterLegacy: async () => undefined },
    invalidation: {
      afterTargetLogout: async () => undefined,
      beforeLegacyLogout: async () => undefined,
      afterLegacyLogout: async () => undefined,
      afterLegacyLogin: async () => undefined,
      completePending: async () => undefined,
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
    legacyOrigin: 'http://127.0.0.1:9',
    clock: systemClock,
  };
  await app.register(replyFrom);
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
    await Promise.all([web.close(), stub.close(), people.close()]);
  });
  return { app, web, stub, people, deps };
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

  it('fails closed with the API 503, calling no service, when identity cannot report the session user', async () => {
    const h = await harness();
    vi.mocked(h.deps.identity.snapshot).mockRejectedValueOnce(new ServiceUnavailableError(IDENTITY_SERVICE, new Error('down')));
    const res = await h.app.inject({ method: 'POST', url: ARCHIVE });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailableResponse().body);
    expect(h.deps.tokenCache.get).not.toHaveBeenCalled();
    expect(h.people.requests).toHaveLength(0);
  });
});
