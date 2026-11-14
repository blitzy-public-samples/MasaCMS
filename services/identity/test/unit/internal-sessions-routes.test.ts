/** The `adoptSession`, `getSessionState`, `getSessionAdminSite`, `getSessionSnapshot` and `endSession` routes over a throwaway `identity` schema: contract shape, gateway-only access, body validation, adoption, admin-site and hydration reads and ending. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { sessionCookieStrings } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { ANONYMOUS_USER_STRUCT, userStructOf } from '../../src/domain/roles.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import type { LoginSnapshot } from '../../src/repo/tables.js';
import { registerSessionRoutes } from '../../src/routes/internal-sessions.js';

type ContractOperation = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const CONTRACT_PATHS = [
  '/internal/v1/sessions:adopt',
  '/internal/v1/sessions/{sid}/state',
  '/internal/v1/sessions/{sid}/admin-site',
  '/internal/v1/sessions/{sid}/snapshot',
  '/internal/v1/sessions/{sid}:end',
];
const ADOPT = '/internal/v1/sessions:adopt';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const SITE = 'tenant-a';
const TENANT_A = tenantIdForSite(SITE);
const USER = 'U0000000-0000-0000-0000000000000001';
const GROUP = 'G0000000-0000-0000-0000000000000001';
const LEGACY_SECRET = 'L0000000-0000-0000-0000000000000001';
const RELOGIN_SECRET = 'L0000000-0000-0000-0000000000000002';
const JSON_BODY = { 'content-type': 'application/json' };
const LEGACY_USER = {
  ISLOGGEDIN: 'Yes',
  USERID: USER,
  UserName: 'ada',
  siteid: SITE,
  fname: 'Ada',
  lname: 'Admin',
  email: 'ada@example.test',
  lastLogin: '2026-06-30 09:15:00.120',
  membershipIds: `${GROUP},${USER}`,
};
const ROLES = ['Editors;tenant-a;0', 'S2IsPrivate;tenant-a'];
const LOGIN_SNAPSHOT: LoginSnapshot = {
  userid: USER,
  username: 'ada',
  siteid: SITE,
  subtype: 'Default',
  password: '',
  fname: 'Ada',
  lname: 'Admin',
  email: 'ada@example.test',
  remoteid: '',
  company: '',
  lastlogin: '2026-06-30 09:15:00.120',
  passwordcreated: null,
  roleList: ROLES.join(','),
  membershipIds: `${GROUP},${USER}`,
};

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: async () => undefined,
};

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let sessionSeq = 0;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-internal-sessions-routes-'));
  await writeTestSecrets(stateDir);
  const clock = fixedClock(NOW);
  repo = createIdentityRepository({ clock });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    const { schema } = handle;
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)`, [SITE, TENANT_A, NOW]),
    );
  }
  app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  await registerSessionRoutes(app, { sessions: { db: handle?.app ?? NO_DB, repo, clock } });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a `caller` service call, with a user token as well when `withUser` is set. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: USER, site: SITE, roles: [Roles.systemUser] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  return headers;
}

/** Injects a request and checks the answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: method === 'POST' ? { ...headers, ...JSON_BODY } : headers,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** A gateway call of the session route `op` of `sid`. */
async function gateway(op: 'state' | 'admin-site' | 'snapshot' | 'end', sid: string, reason = 'logout') {
  const headers = await headersFor('gateway');
  return op === 'end'
    ? send('POST', `/internal/v1/sessions/${sid}:end`, headers, { reason })
    : send('GET', `/internal/v1/sessions/${sid}/${op}`, headers);
}

/** An `AdoptSessionRequest` of legacy session `sid` described with `user`. */
function adoptBody(sid: string, user: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { legacySessionId: sid, siteId: SITE, describe: { user, roles: [], csrfSecretKey: LEGACY_SECRET, usedTokens: [], ...extra } };
}

function nextSessionId(): string {
  sessionSeq += 1;
  return `masacms_1000_${String(sessionSeq).padStart(8, '0')}`;
}

/** A fresh session id in ACF's `<appname>_<CFID>_<CFTOKEN>` form, assembled from low-entropy parts. */
function nextCfSessionId(): string {
  sessionSeq += 1;
  return `MURA${'C'.repeat(64)}_${String(sessionSeq).padStart(4, '0')}_${'b'.repeat(16)}-D0000000-0000-0000-0000000000000001`;
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/sessions'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: (operation['x-opt2-fastify-path'] as string | undefined) ?? template.replace('{sid}', ':sid'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        })),
    );
    expect(expected).toHaveLength(5);
    expect(declared.filter((route) => route.method !== 'HEAD')).toHaveLength(5);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
  });
});

describe('auth denials', () => {
  it.each<[Method, string, unknown]>([
    ['POST', ADOPT, adoptBody('S-denied', { isLoggedIn: false })],
    ['GET', '/internal/v1/sessions/S-denied/state', undefined],
    ['GET', '/internal/v1/sessions/S-denied/admin-site', undefined],
    ['GET', '/internal/v1/sessions/S-denied/snapshot', undefined],
    ['POST', '/internal/v1/sessions/S-denied:end', { reason: 'logout' }],
  ])('refuse %s %s to callers other than the gateway, with or without a user token', async (method, url, payload) => {
    for (const caller of ['people', 'identity', 'web', 'migration']) {
      expect((await send(method, url, await headersFor(caller), payload)).statusCode).toBe(403);
      expect((await send(method, url, await headersFor(caller, true), payload)).statusCode).toBe(403);
    }
    const anonymous = await send(method, url, await headersFor(null, true), payload);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });
});

describe('request validation', () => {
  it.each<[string, unknown]>([
    ['no body', undefined],
    ['no describe', { legacySessionId: 'S-1', siteId: SITE }],
    ['an empty legacySessionId', adoptBody('', { isLoggedIn: false })],
    ['an empty siteId', { ...adoptBody('S-1', { isLoggedIn: false }), siteId: '' }],
    ['a description without csrfSecretKey', { legacySessionId: 'S-1', siteId: SITE, describe: { user: {}, roles: [], usedTokens: [] } }],
    ['a description whose user is a list', { legacySessionId: 'S-1', siteId: SITE, describe: { user: ['ada'], roles: [], csrfSecretKey: LEGACY_SECRET, usedTokens: [] } }],
    ['used tokens given as an object', adoptBody('S-1', { isLoggedIn: false }, { usedTokens: { AA: 1 } })],
  ])('answers an adoption with %s with the legacy 400', async (_label, payload) => {
    const res = await send('POST', ADOPT, await headersFor('gateway'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });

  it.each<[string, unknown]>([
    ['no body', undefined],
    ['no reason', {}],
    ['a reason the contract does not name', { reason: 'timeout' }],
  ])('answers an end with %s with the legacy 400', async (_label, payload) => {
    const res = await send('POST', '/internal/v1/sessions/S-1:end', await headersFor('gateway'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });
});

describe.skipIf(!available)('sessions against PostgreSQL', () => {
  /** The stored mode of an adopted session in `tenantId`. */
  async function storedMode(sid: string, tenantId: string): Promise<string | undefined> {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    return (await withTenant(handle.app, tenantId, (tx) => repo.findSession(tx, sid)))?.mode;
  }

  it('adopts a logged-in legacy session under the system tenant and hands the gateway its session cookies', async () => {
    const sid = nextSessionId();

    const res = await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, LEGACY_USER, { roles: ROLES, usedTokens: ['bb', 'AA'] }));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; epoch: number; setCookie: string[] };
    expect([body.sessionId, body.epoch]).toEqual([sid, 1]);
    const cfid = /^CFID=([^;]*);/.exec(body.setCookie[0] ?? '')?.[1] ?? '';
    expect(cfid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.setCookie).toEqual(sessionCookieStrings({ CFID: cfid, CFTOKEN: '0', jsessionid: sid }, {}, NOW));
    expect(await storedMode(sid, TENANT_A)).toBeUndefined();
    expect(await storedMode(sid, SYSTEM_TENANT_ID)).toBe('legacy-primary');
    expect((await gateway('state', sid)).json()).toEqual({ state: 'active', epoch: 1, userId: USER, siteId: SITE });
    expect((await gateway('snapshot', sid)).json()).toEqual({
      sessionId: sid,
      epoch: 1,
      loginSnapshot: { user: userStructOf(LOGIN_SNAPSHOT), roles: ROLES },
      csrfSecretKey: LEGACY_SECRET,
      usedTokens: ['AA', 'BB'],
    });
  });

  it('adopts a not-logged-in legacy session as anonymous, keyed by the legacy session id, and ends it by that id', async () => {
    const sid = `${nextSessionId()}.node-1`;

    const res = await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, { isLoggedIn: false }, { usedTokens: ['cc'] }));

    expect(res.json()).toMatchObject({ sessionId: sid, epoch: 1 });
    expect((await gateway('state', sid)).json()).toEqual({ state: 'active', epoch: 1, userId: '', siteId: SITE });
    expect((await gateway('snapshot', sid)).json()).toEqual({
      sessionId: sid,
      epoch: 1,
      loginSnapshot: { user: { ...ANONYMOUS_USER_STRUCT }, roles: [] },
      csrfSecretKey: LEGACY_SECRET,
      usedTokens: ['CC'],
    });
    expect((await gateway('end', sid)).json()).toEqual({ ended: true, epoch: 2 });
    expect((await gateway('state', sid)).json()).toMatchObject({ state: 'ended', epoch: 2 });
  });

  it('keeps the epoch of an unchanged re-adoption and bumps it when legacy logged in again', async () => {
    const sid = nextSessionId();
    const headers = await headersFor('gateway');
    await send('POST', ADOPT, headers, adoptBody(sid, LEGACY_USER, { roles: ROLES }));

    const unchanged = await send('POST', ADOPT, headers, adoptBody(sid, LEGACY_USER, { roles: ROLES, usedTokens: ['dd'] }));
    const relogged = await send('POST', ADOPT, headers, adoptBody(sid, LEGACY_USER, { roles: ROLES.slice(0, 1), csrfSecretKey: RELOGIN_SECRET }));

    expect(unchanged.json()).toMatchObject({ sessionId: sid, epoch: 1 });
    expect(relogged.json()).toMatchObject({ sessionId: sid, epoch: 2 });
    expect((await gateway('snapshot', sid)).json()).toMatchObject({
      epoch: 2,
      loginSnapshot: { roles: ROLES.slice(0, 1) },
      csrfSecretKey: RELOGIN_SECRET,
      usedTokens: [],
    });
  });

  it.each(['logout', 'legacy-logout', 'expired'])('ends a session for reason %s once, bumping its epoch, after which it reads ended', async (reason) => {
    const sid = nextSessionId();
    await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, LEGACY_USER, { roles: ROLES }));

    const ended = await gateway('end', sid, reason);
    const again = await gateway('end', sid, reason);

    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ ended: true, epoch: 2 });
    expect(again.json()).toEqual({ ended: true, epoch: 2 });
    expect((await gateway('state', sid)).json()).toEqual({ state: 'ended', epoch: 2, userId: '', siteId: '' });
    expect((await gateway('snapshot', sid)).statusCode).toBe(404);
  });

  it('reads an unknown session as ended with epoch 0, answers its snapshot with the legacy 404 and ends it as a no-op', async () => {
    const sid = 'S-never-adopted';

    const snapshot = await gateway('snapshot', sid);

    expect((await gateway('state', sid)).json()).toEqual({ state: 'ended', epoch: 0, userId: '', siteId: '' });
    expect((await gateway('admin-site', sid)).json()).toEqual({ siteId: '' });
    expect(snapshot.statusCode).toBe(404);
    expect(snapshot.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } });
    expect((await gateway('end', sid)).json()).toEqual({ ended: true, epoch: 0 });
  });

  it.each<[string, Record<string, unknown> | undefined, string]>([
    ['the stored session.siteid', { siteid: 'tenant-b', topID: 'T1' }, 'tenant-b'],
    ['an empty site when the admin state stores none', { rb: 'en' }, ''],
    ['an empty site when the stored siteid is not a string', { siteid: ['tenant-b'] }, ''],
    ['an empty site when no admin state is stored', undefined, ''],
  ])('reads an active session admin site as %s', async (_label, adminState, expected) => {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    const sid = nextSessionId();
    await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, LEGACY_USER, { roles: ROLES }));
    const db = handle.app;
    if (adminState !== undefined) await withTenant(db, SYSTEM_TENANT_ID, (tx) => repo.mergeSessionAdminState(tx, sid, adminState));

    const res = await gateway('admin-site', sid);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ siteId: expected });
  });

  it('reads an ended session admin site as empty even when its row still holds one', async () => {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    const sid = nextSessionId();
    await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, LEGACY_USER, { roles: ROLES }));
    await gateway('end', sid);
    const db = handle.app;
    await withTenant(db, SYSTEM_TENANT_ID, (tx) => repo.mergeSessionAdminState(tx, sid, { siteid: 'tenant-b' }));

    expect((await gateway('admin-site', sid)).json()).toEqual({ siteId: '' });
  });

  it.each<['state' | 'admin-site' | 'snapshot' | 'end', (sid: string) => unknown]>([
    ['state', () => ({ state: 'active', epoch: 1, userId: USER, siteId: SITE })],
    ['admin-site', () => ({ siteId: '' })],
    [
      'snapshot',
      (sid) => ({
        sessionId: sid,
        epoch: 1,
        loginSnapshot: { user: userStructOf(LOGIN_SNAPSHOT), roles: ROLES },
        csrfSecretKey: LEGACY_SECRET,
        usedTokens: [],
      }),
    ],
    ['end', () => ({ ended: true, epoch: 2 })],
  ])('serves %s of an adopted session keyed by a 126-character ColdFusion session id', async (op, expected) => {
    const sid = nextCfSessionId();
    expect(sid).toHaveLength(126);
    await send('POST', ADOPT, await headersFor('gateway'), adoptBody(sid, LEGACY_USER, { roles: ROLES }));

    const res = await gateway(op, sid);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected(sid));
  });
});
