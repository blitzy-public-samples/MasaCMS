/** Session epochs and login-time snapshots, legacy adoption, the gateway-only session routes and the session cookies, over the memory repository. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  LEGACY_SESSION_COOKIE_NAMES,
  generateCsrfToken,
  isCfUuid,
  sessionCookieStrings,
  type LegacyCookieConfig,
} from '@opt2/platform/legacy-compat';
import { SYSTEM_TENANT_ID, withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import { consumeToken, issueTokens } from '../../src/domain/csrf.js';
import { ANONYMOUS_USER_STRUCT, userStructOf } from '../../src/domain/roles.js';
import {
  adoptLegacySession,
  applyLogin,
  applyRelogin,
  endSession,
  ensureSession,
  locateSession,
  newSessionTokens,
  sessionAdminSite,
  sessionCookies,
  sessionSnapshot,
  sessionState,
  type LegacyDescribe,
  type SessionDeps,
} from '../../src/domain/sessions.js';
import { registerSessionRoutes } from '../../src/routes/internal-sessions.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { createMemoryIdentityRepo, createRecordingDb, type MemoryIdentityRepo, type RecordingDb } from '../helpers/memory-repo.js';
import { ADMIN_S2, SITE_ADMIN_A, actorSeed, loginSnapshotFixture, membershipRow, sessionRow } from '../helpers/rows.js';

type CsrfBridge = Parameters<typeof consumeToken>[0]['bridge'];
type Method = 'GET' | 'POST';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0, 123));
const LATER = fixedClock(new Date(2026, 5, 30, 12, 5, 0, 0));
const REGISTRY_READ = /FROM identity\.tenant_registry\b/;
const LEGACY_SID = 'masacms_1000_00000001';
const LEGACY_SECRET = 'A0000000-0000-0000-0000000000000001';
const RELOGIN_SECRET = 'A0000000-0000-0000-0000000000000002';
const JAR_REF = 'jar-masacms_1000_00000001';
const ADMIN_SNAPSHOT = loginSnapshotFixture({ actor: SITE_ADMIN_A });
const ADMIN_USER_ID = SITE_ADMIN_A.account.userid;
const BRIDGE: CsrfBridge = { markUsed: () => Promise.resolve({ applied: true }) };
const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
};

/** The legacy session's `session.mura`, its keys upper-cased as ACF serialises a struct. */
const LEGACY_USER = Object.fromEntries(Object.entries(userStructOf(ADMIN_SNAPSHOT)).map(([key, value]) => [key.toUpperCase(), value]));
const LEGACY_ROLES = ADMIN_SNAPSHOT.roleList.split(',');
const LEGACY_USED_TOKENS = [
  generateCsrfToken({ context: '', secret: LEGACY_SECRET, now: CLOCK.now() }).token,
  generateCsrfToken({ context: ADMIN_USER_ID, secret: LEGACY_SECRET, now: CLOCK.now() }).token,
];
/** The ledger keys of the used tokens, in the order claims are listed. */
const USED_TOKEN_KEYS = LEGACY_USED_TOKENS.map((token) => token.toUpperCase()).sort();

interface SessionFixture {
  db: RecordingDb;
  repo: MemoryIdentityRepo;
  deps: SessionDeps;
}

/** Session dependencies over a recording database that registers tenant-a and a memory repository seeded with the two actors. */
function sessionFixture(clock = CLOCK, extra: Parameters<typeof createMemoryIdentityRepo>[0] = {}): SessionFixture {
  const db = createRecordingDb({ responses: [[REGISTRY_READ, [{ tenant_id: TENANT_A.tenantId, site_id: TENANT_A.siteId }]]] });
  const repo = createMemoryIdentityRepo({ ...actorSeed(SITE_ADMIN_A, ADMIN_S2), ...extra }, { clock });
  return { db, repo, deps: { db, repo, clock } };
}

/** The stored session rows of `sessionId`, across every tenant. */
function sessionRows(f: SessionFixture, sessionId: string) {
  return f.repo.rows('session').filter((row) => row.session_id === sessionId);
}

/** The stored session row of `sessionId` in `tenantId`; throws when absent. */
function storedSession(f: SessionFixture, sessionId: string, tenantId = SYSTEM_TENANT_ID) {
  const row = f.repo.rows('session', tenantId).find((candidate) => candidate.session_id === sessionId);
  if (row === undefined) throw new Error(`no session ${sessionId} in tenant ${tenantId}`);
  return row;
}

/** The CSRF claims of `sessionId` in `tenantId`, by token. */
function claimsOf(f: SessionFixture, sessionId: string, tenantId = SYSTEM_TENANT_ID) {
  return f.repo
    .rows('csrf_claim', tenantId)
    .filter((row) => row.session_id === sessionId)
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/** Issues a token under the session's secret for `context` and consumes it through the ledger. */
async function issueAndConsume(f: SessionFixture, sessionId: string, csrfSecret: string, context: string) {
  const { token, expires } = issueTokens({ csrfSecret }, { context, clock: CLOCK });
  return consumeToken({ db: f.db, repo: f.repo, bridge: BRIDGE, clock: CLOCK }, { sessionId, token, expires, context });
}

/** An `op=describe` adoption body of the legacy session `sessionId`. */
function legacyDescribe(sessionId: string, overrides: Partial<LegacyDescribe['describe']> = {}): LegacyDescribe {
  return {
    legacySessionId: sessionId,
    siteId: TENANT_A.siteId,
    describe: { user: LEGACY_USER, roles: LEGACY_ROLES, csrfSecretKey: LEGACY_SECRET, usedTokens: LEGACY_USED_TOKENS, ...overrides },
  };
}

/** The response statuses the contract declares for `method` on `template`. */
function declaredStatuses(template: string, method: string): string[] {
  return Object.keys(OPENAPI.paths[template]?.[method]?.responses ?? {});
}

describe('epoch and login-time snapshot', () => {
  let f: SessionFixture;

  beforeEach(() => {
    f = sessionFixture();
  });

  it('creates an anonymous active session under the system tenant with a CF-format CSRF secret', async () => {
    const ensured = await ensureSession(f.deps, { mode: 'target-primary' });

    expect(ensured).toMatchObject({ tenantId: SYSTEM_TENANT_ID, epoch: 1, created: true });
    expect(isCfUuid(ensured.sessionId)).toBe(true);
    expect(ensured.csrfSecret).toHaveLength(35);
    expect(isCfUuid(ensured.csrfSecret)).toBe(true);
    expect(ensured.tokens?.jsessionid).toBe(ensured.sessionId.replaceAll('-', ''));
    expect(storedSession(f, ensured.sessionId)).toMatchObject({ state: 'active', user_id: null, csrf_secret: ensured.csrfSecret, mode: 'target-primary' });
    expect(await sessionSnapshot(f.deps, ensured.sessionId)).toMatchObject({ epoch: 1, user: ANONYMOUS_USER_STRUCT, roles: [], csrfSecret: ensured.csrfSecret });
    expect(await ensureSession(f.deps, { sessionId: ensured.sessionId, mode: 'legacy-primary' })).toEqual({ ...ensured, created: false, tokens: undefined });
  });

  it('creates a requested new session id once when two requests ensure it at the same time', async () => {
    const [first, second] = await Promise.all([
      ensureSession(f.deps, { sessionId: 'S-requested', mode: 'target-primary' }),
      ensureSession(f.deps, { sessionId: 'S-requested', mode: 'target-primary' }),
    ]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(second).toMatchObject({ sessionId: 'S-requested', tenantId: SYSTEM_TENANT_ID, epoch: 1, csrfSecret: first.csrfSecret });
    expect(first.tokens).toBeUndefined();
    expect(sessionRows(f, 'S-requested')).toHaveLength(1);
  });

  it('reactivates an ended session as anonymous under the same id with the next epoch and its jar', async () => {
    const ended = sessionRow({ tenant_id: SYSTEM_TENANT_ID, session_id: 'S-ended', state: 'ended', epoch: '3', jar_ref: JAR_REF, user_id: ADMIN_USER_ID });
    f = sessionFixture(CLOCK, { sessions: [ended] });

    const reactivated = await ensureSession(f.deps, { sessionId: ended.session_id, mode: 'legacy-primary' });

    expect(reactivated).toMatchObject({ sessionId: ended.session_id, tenantId: SYSTEM_TENANT_ID, epoch: 4, created: false });
    expect(reactivated.csrfSecret).not.toBe(ended.csrf_secret);
    expect(storedSession(f, ended.session_id)).toMatchObject({ state: 'active', user_id: null, jar_ref: JAR_REF, mode: 'legacy-primary', epoch: '4' });
  });

  it('logs in under the same session id with the next epoch, a new secret, no CSRF claims and the login snapshot', async () => {
    const anonymous = await ensureSession(f.deps, { mode: 'target-primary' });
    expect(await issueAndConsume(f, anonymous.sessionId, anonymous.csrfSecret, '')).toEqual({ valid: true });
    expect(claimsOf(f, anonymous.sessionId)).toHaveLength(1);

    const applied = await applyLogin(f.deps, { sessionId: anonymous.sessionId, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });

    expect(applied).toMatchObject({ sessionId: anonymous.sessionId, tenantId: SYSTEM_TENANT_ID, epoch: anonymous.epoch + 1, mode: 'target-primary' });
    expect(isCfUuid(applied.csrfSecret)).toBe(true);
    expect(applied.csrfSecret).not.toBe(anonymous.csrfSecret);
    expect(claimsOf(f, anonymous.sessionId)).toEqual([]);
    expect(storedSession(f, anonymous.sessionId)).toMatchObject({
      user_id: ADMIN_USER_ID,
      site_id: TENANT_A.siteId,
      login_snapshot: JSON.stringify(ADMIN_SNAPSHOT),
      csrf_secret: applied.csrfSecret,
      state: 'active',
    });
    const located = await locateSession(f.deps, anonymous.sessionId);
    expect(located?.tenantId).toBe(applied.tenantId);
    expect(located?.row).toMatchObject({ user_id: ADMIN_USER_ID, epoch: String(applied.epoch) });
    expect(sessionRows(f, anonymous.sessionId)).toHaveLength(1);
  });

  it('logs into a session held by a site tenant in place, where locateSession finds it', async () => {
    const held = sessionRow({ tenant_id: TENANT_A.tenantId, session_id: 'S-held-by-tenant-a', epoch: '4' });
    f = sessionFixture(CLOCK, { sessions: [held] });

    const applied = await applyLogin(f.deps, { sessionId: held.session_id, snapshot: ADMIN_SNAPSHOT, mode: 'legacy-primary', siteId: TENANT_A.siteId });

    expect(applied).toMatchObject({ tenantId: TENANT_A.tenantId, epoch: 5, mode: 'target-primary' });
    expect(await locateSession(f.deps, held.session_id)).toMatchObject({ tenantId: TENANT_A.tenantId, row: { user_id: ADMIN_USER_ID } });
    expect(sessionRows(f, held.session_id)).toEqual([expect.objectContaining({ tenant_id: TENANT_A.tenantId })]);
  });

  it('inserts a login into an unknown session id under the system tenant in the requested mode', async () => {
    const applied = await applyLogin(f.deps, { sessionId: 'S-first-login', snapshot: ADMIN_SNAPSHOT, mode: 'legacy-primary', siteId: TENANT_A.siteId });

    expect(applied).toMatchObject({ sessionId: 'S-first-login', tenantId: SYSTEM_TENANT_ID, epoch: 1, mode: 'legacy-primary' });
    expect(storedSession(f, 'S-first-login')).toMatchObject({ user_id: ADMIN_USER_ID, login_snapshot: JSON.stringify(ADMIN_SNAPSHOT) });
  });

  it('drops the post-login session.mura values at login and keeps the admin site the session selected', async () => {
    const adminState = JSON.stringify({ siteid: TENANT_A.siteId, mura: { showTrace: true }, rememberMe: 0 });
    const held = sessionRow({ tenant_id: SYSTEM_TENANT_ID, session_id: 'S-admin-state', admin_state: adminState });
    f = sessionFixture(CLOCK, { sessions: [held] });

    await applyLogin(f.deps, { sessionId: held.session_id, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });

    expect(JSON.parse(storedSession(f, held.session_id).admin_state ?? 'null')).toEqual({ siteid: TENANT_A.siteId, rememberMe: 0 });
    expect(await sessionAdminSite(f.deps, held.session_id)).toBe(TENANT_A.siteId);
    await endSession(f.deps, held.session_id);
    expect(await sessionAdminSite(f.deps, held.session_id)).toBe('');
    expect(await sessionAdminSite(f.deps, 'S-never-created')).toBe('');
  });

  it('replaces the snapshot and bumps the epoch again on a self-save re-login', async () => {
    const { sessionId } = await ensureSession(f.deps, { mode: 'target-primary' });
    const first = await applyLogin(f.deps, { sessionId, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });
    const refreshed = loginSnapshotFixture({ actor: SITE_ADMIN_A, overrides: { contact: { ...SITE_ADMIN_A.contact, fname: 'Renamed' } } });

    const second = await applyLogin(f.deps, { sessionId, snapshot: refreshed, mode: 'target-primary', siteId: TENANT_A.siteId });

    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.csrfSecret).not.toBe(first.csrfSecret);
    expect((await sessionSnapshot(f.deps, sessionId))?.loginSnapshot).toEqual(refreshed);
    expect(refreshed.fname).toBe('Renamed');
  });

  it('re-logs a self-saved user in at the stored site only while the session is active at the expected epoch', async () => {
    const { sessionId } = await ensureSession(f.deps, { mode: 'target-primary' });
    const login = await applyLogin(f.deps, { sessionId, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });
    const refreshed = loginSnapshotFixture({ actor: SITE_ADMIN_A, overrides: { contact: { ...SITE_ADMIN_A.contact, lname: 'Saved' } } });

    expect(await applyRelogin(f.deps, { sessionId, snapshot: refreshed, epoch: login.epoch - 1 })).toBeUndefined();
    expect(await sessionState(f.deps, sessionId)).toMatchObject({ epoch: login.epoch });

    const relogin = await applyRelogin(f.deps, { sessionId, snapshot: refreshed, epoch: login.epoch });

    expect(relogin).toMatchObject({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: login.epoch + 1, mode: 'target-primary' });
    expect(relogin?.csrfSecret).not.toBe(login.csrfSecret);
    expect(storedSession(f, sessionId)).toMatchObject({ site_id: TENANT_A.siteId, login_snapshot: JSON.stringify(refreshed) });
    await endSession(f.deps, sessionId);
    expect(await applyRelogin(f.deps, { sessionId, snapshot: refreshed, epoch: login.epoch + 2 })).toBeUndefined();
    expect(await applyRelogin(f.deps, { sessionId: 'S-never-created', snapshot: refreshed, epoch: 1 })).toBeUndefined();
  });

  it('ends a session on logout with the next epoch and leaves an ended session unchanged', async () => {
    const { sessionId } = await ensureSession(f.deps, { mode: 'target-primary' });
    const login = await applyLogin(f.deps, { sessionId, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });

    const ended = await endSession(f.deps, sessionId);

    expect(ended).toEqual({ epoch: login.epoch + 1 });
    expect(await sessionState(f.deps, sessionId)).toMatchObject({ state: 'ended', epoch: ended.epoch, userId: '' });
    expect(storedSession(f, sessionId)).toMatchObject({ state: 'ended', user_id: null, jar_ref: null, ended_at: CLOCK.now() });
    expect(await sessionSnapshot(f.deps, sessionId)).toBeUndefined();
    expect(await endSession(f.deps, sessionId)).toEqual(ended);
    expect(await endSession(f.deps, 'S-never-created')).toEqual({ epoch: 0 });
  });

  it('keeps the epoch and the snapshot through membership changes, CSRF use and state reads', async () => {
    const { sessionId } = await ensureSession(f.deps, { mode: 'target-primary' });
    const login = await applyLogin(f.deps, { sessionId, snapshot: ADMIN_SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });
    const stateBefore = await sessionState(f.deps, sessionId);
    const snapshotBefore = await sessionSnapshot(f.deps, sessionId);
    const storedBefore = storedSession(f, sessionId);

    const added = membershipRow({ userid: ADMIN_USER_ID });
    expect(await withTenant(f.db, added.tenant_id, (tx) => f.repo.addMembership(tx, added.userid, added.groupid))).toBe(true);
    expect(f.repo.rows('membership', TENANT_A.tenantId)).toContainEqual(expect.objectContaining(added));
    expect(await issueAndConsume(f, sessionId, login.csrfSecret, ADMIN_USER_ID)).toEqual({ valid: true });
    for (let read = 0; read < 3; read += 1) expect(await sessionState(f.deps, sessionId)).toEqual(stateBefore);

    const snapshotAfter = await sessionSnapshot(f.deps, sessionId);
    expect(stateBefore).toMatchObject({ epoch: login.epoch, state: 'active', userId: ADMIN_USER_ID, siteId: TENANT_A.siteId });
    expect(snapshotAfter).toMatchObject({
      epoch: snapshotBefore?.epoch,
      loginSnapshot: snapshotBefore?.loginSnapshot,
      user: snapshotBefore?.user,
      roles: snapshotBefore?.roles,
      csrfSecret: login.csrfSecret,
    });
    expect(storedSession(f, sessionId)).toMatchObject({ epoch: storedBefore.epoch, login_snapshot: storedBefore.login_snapshot });
  });
});

describe('adoption of a described legacy session', () => {
  let f: SessionFixture;

  beforeEach(() => {
    f = sessionFixture();
  });

  it('keys the session by the legacy id with its struct, roles, secret, used tokens, jar and mode', async () => {
    const adopted = await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID), { mode: 'target-primary', jarRef: JAR_REF });

    expect(adopted).toEqual({ sessionId: LEGACY_SID, tenantId: SYSTEM_TENANT_ID, epoch: 1, mode: 'target-primary' });
    expect(storedSession(f, LEGACY_SID)).toMatchObject({
      user_id: ADMIN_USER_ID,
      site_id: TENANT_A.siteId,
      csrf_secret: LEGACY_SECRET,
      mode: 'target-primary',
      jar_ref: JAR_REF,
      state: 'active',
    });
    expect(await sessionSnapshot(f.deps, LEGACY_SID)).toMatchObject({ user: userStructOf(ADMIN_SNAPSHOT), roles: LEGACY_ROLES, csrfSecret: LEGACY_SECRET });
    expect(claimsOf(f, LEGACY_SID)).toEqual(
      USED_TOKEN_KEYS.map((token) => expect.objectContaining({ token, state: 'used', used_at: CLOCK.now() })),
    );
  });

  it('adopts the same legacy session again without a second row, a second claim or a new epoch', async () => {
    await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID), { mode: 'legacy-primary', jarRef: JAR_REF });

    const again = await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID), { mode: 'target-primary' });

    expect(again).toMatchObject({ sessionId: LEGACY_SID, epoch: 1, mode: 'target-primary' });
    expect(sessionRows(f, LEGACY_SID)).toEqual([expect.objectContaining({ mode: 'target-primary', jar_ref: JAR_REF })]);
    expect(claimsOf(f, LEGACY_SID)).toHaveLength(LEGACY_USED_TOKENS.length);
  });

  it('rebuilds the session with the next epoch when legacy logged in again under a new secret', async () => {
    await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID), { mode: 'target-primary', jarRef: JAR_REF });

    const relogged = await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID, { csrfSecretKey: RELOGIN_SECRET, usedTokens: [] }), { mode: 'target-primary' });

    expect(relogged.epoch).toBe(2);
    expect(storedSession(f, LEGACY_SID)).toMatchObject({ csrf_secret: RELOGIN_SECRET, jar_ref: JAR_REF });
    expect(claimsOf(f, LEGACY_SID)).toEqual([]);
  });

  it('reads numeric struct values as CFML text and a complex value as the not-logged-in value', async () => {
    const user = { ...LEGACY_USER, COMPANY: 1234, FNAME: ['not', 'simple'] };

    await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID, { user }), { mode: 'target-primary' });

    expect((await sessionSnapshot(f.deps, LEGACY_SID))?.user).toMatchObject({ company: '1234', fname: ANONYMOUS_USER_STRUCT.fname });
  });

  it.each([
    ['no user fields', {}],
    ['isLoggedIn false', { ISLOGGEDIN: false, USERID: ADMIN_USER_ID }],
    ['isLoggedIn "No" under its own key casing', { isLoggedIn: 'No', userID: ADMIN_USER_ID }],
  ])('adopts a not-logged-in session described with %s as the anonymous user struct', async (_label, user) => {
    await adoptLegacySession(f.deps, legacyDescribe(LEGACY_SID, { user, roles: [], usedTokens: [] }), { mode: 'target-primary', jarRef: JAR_REF });

    expect(storedSession(f, LEGACY_SID)).toMatchObject({ user_id: null, csrf_secret: LEGACY_SECRET });
    expect(await sessionSnapshot(f.deps, LEGACY_SID)).toMatchObject({ user: ANONYMOUS_USER_STRUCT, roles: [], usedTokens: [] });
    expect(await sessionState(f.deps, LEGACY_SID)).toMatchObject({ state: 'active', userId: '', mode: 'target-primary' });
  });
});

describe('gateway session routes', () => {
  const MEMORY_PREFIX = '/memory';
  const ADOPT = '/internal/v1/sessions:adopt';
  const routeUrls = (sid: string) => ({
    state: `/internal/v1/sessions/${encodeURIComponent(sid)}/state`,
    adminSite: `/internal/v1/sessions/${encodeURIComponent(sid)}/admin-site`,
    snapshot: `/internal/v1/sessions/${encodeURIComponent(sid)}/snapshot`,
    end: `/internal/v1/sessions/${encodeURIComponent(sid)}:end`,
  });
  let testApp: TestApp;
  let memory: SessionFixture;

  /** Injects `method url` presenting `caller`'s invocation credential. */
  async function call(caller: string, method: Method, url: string, payload?: object) {
    return testApp.app.inject({ method, url, headers: await headersFor(caller), ...(payload === undefined ? {} : { payload }) });
  }

  /** Injects a gateway call of the session routes mounted over the memory repository. */
  function gateway(method: Method, url: string, payload?: object) {
    return call('service:gateway', method, MEMORY_PREFIX + url, payload);
  }

  beforeAll(async () => {
    testApp = await buildTestApp();
    memory = sessionFixture(testApp.clock);
    // The composed app's routes read through the recording database, which holds no rows, so a copy over the memory repository serves round trips.
    await testApp.app.register(
      async (scope) => {
        await registerSessionRoutes(scope, { sessions: memory.deps });
      },
      { prefix: MEMORY_PREFIX },
    );
    await testApp.app.ready();
  });

  afterAll(async () => {
    await testApp?.app.close();
  });

  it('adopts a legacy session through the composed app and inserts it under the system tenant', async () => {
    testApp.db.clear();

    const res = await call('service:gateway', 'POST', ADOPT, legacyDescribe(LEGACY_SID));

    expect(res.statusCode).toBe(200);
    const body = res.json<{ sessionId: string; epoch: number; setCookie: string[] }>();
    expect(body).toMatchObject({ sessionId: LEGACY_SID, epoch: 1 });
    expect(body.setCookie.map((cookie) => cookie.slice(0, cookie.indexOf('=')))).toEqual([...LEGACY_SESSION_COOKIE_NAMES]);
    expect(body.setCookie[2]).toMatch(new RegExp(`^JSESSIONID=${LEGACY_SID};`));
    expect(testApp.db.writes()).toContainEqual(expect.objectContaining({ table: 'identity.session', verb: 'INSERT', tenantId: SYSTEM_TENANT_ID }));
  });

  it('reads the adopted state and the hydration snapshot without changing the epoch, then ends the session', async () => {
    const sid = 'masacms_1000_00000002';
    const urls = routeUrls(sid);

    const adopted = await gateway('POST', ADOPT, legacyDescribe(sid));
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toMatchObject({ sessionId: sid, epoch: 1 });

    const domain = await sessionState(memory.deps, sid);
    const state = await gateway('GET', urls.state);
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ state: domain.state, epoch: domain.epoch, userId: domain.userId, siteId: domain.siteId });
    expect(domain).toMatchObject({ state: 'active', epoch: 1, mode: 'legacy-primary', userId: ADMIN_USER_ID });

    const snapshots = [await gateway('GET', urls.snapshot), await gateway('GET', urls.snapshot)];
    for (const snapshot of snapshots) {
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toEqual({
        sessionId: sid,
        epoch: 1,
        loginSnapshot: { user: userStructOf(ADMIN_SNAPSHOT), roles: LEGACY_ROLES },
        csrfSecretKey: LEGACY_SECRET,
        usedTokens: USED_TOKEN_KEYS,
      });
    }
    expect((await gateway('GET', urls.state)).json()).toEqual(state.json());
    expect((await gateway('GET', urls.adminSite)).json()).toEqual({ siteId: await sessionAdminSite(memory.deps, sid) });

    const ended = await gateway('POST', urls.end, { reason: 'logout' });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ ended: true, epoch: 2 });
    expect((await gateway('GET', urls.state)).json()).toMatchObject({ state: 'ended', epoch: 2 });
    expect((await gateway('GET', urls.snapshot)).statusCode).toBe(404);
  });

  it.each<[string, Method, keyof ReturnType<typeof routeUrls>, number, unknown]>([
    ['/internal/v1/sessions/{sid}/state', 'GET', 'state', 200, { state: 'ended', epoch: 0, userId: '', siteId: '' }],
    ['/internal/v1/sessions/{sid}/admin-site', 'GET', 'adminSite', 200, { siteId: '' }],
    ['/internal/v1/sessions/{sid}/snapshot', 'GET', 'snapshot', 404, undefined],
    ['/internal/v1/sessions/{sid}:end', 'POST', 'end', 200, { ended: true, epoch: 0 }],
  ])('answers %s of an unknown session with the declared status', async (template, method, route, status, body) => {
    const res = await gateway(method, routeUrls('S-unknown')[route], method === 'POST' ? { reason: 'expired' } : undefined);

    expect(declaredStatuses(template, method.toLowerCase())).toContain(String(status));
    expect(res.statusCode).toBe(status);
    if (body !== undefined) expect(res.json()).toEqual(body);
  });

  it.each<[Method, (sid: string) => string, object | undefined]>([
    ['POST', () => ADOPT, legacyDescribe(LEGACY_SID)],
    ['GET', (sid) => routeUrls(sid).state, undefined],
    ['GET', (sid) => routeUrls(sid).adminSite, undefined],
    ['GET', (sid) => routeUrls(sid).snapshot, undefined],
    ['POST', (sid) => routeUrls(sid).end, { reason: 'logout' }],
  ])('refuses %s to non-gateway callers before any handler runs', async (method, urlOf, payload) => {
    for (const caller of ['service:people', 'service:web', 'service:migration']) {
      testApp.db.clear();
      memory.repo.clear();

      const composed = await call(caller, method, urlOf(LEGACY_SID), payload);
      const mounted = await call(caller, method, MEMORY_PREFIX + urlOf(LEGACY_SID), payload);

      expect(composed.statusCode).toBe(403);
      expect(mounted.statusCode).toBe(403);
      expect(testApp.db.statements()).toEqual([]);
      expect(memory.repo.writes()).toEqual([]);
    }
  });
});

describe('session cookies', () => {
  it('gives each session a fresh CFID, CFTOKEN 0 and the JSESSIONID naming it', () => {
    const sid = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F91';
    const first = newSessionTokens(sid);
    const second = newSessionTokens(sid);
    const other = newSessionTokens(LEGACY_SID);

    for (const tokens of [first, second, other]) {
      expect(Object.keys(tokens).sort()).toEqual(['cfid', 'cftoken', 'jsessionid']);
      for (const value of Object.values(tokens)) expect(value).not.toBe('');
    }
    expect(second.cfid).not.toBe(first.cfid);
    expect(first.cftoken).toBe('0');
    expect(first.jsessionid).toBe(sid.replaceAll('-', ''));
    expect(other.jsessionid).toBe(LEGACY_SID);
  });

  it.each<[string, LegacyCookieConfig]>([
    ['Masa default settings', {}],
    ['a secure domain and path', { secureCookies: true, cookieDomain: 'tenant-a.opt2.test', cookiePath: '/admin', sessionCookiesExpires: '30' }],
  ])('writes one legacy Set-Cookie per session cookie name under %s', (_label, cfg) => {
    const tokens = newSessionTokens(LEGACY_SID);
    const now = LATER.now();

    const cookies = sessionCookies(tokens, cfg, now);

    expect(cookies).toEqual(sessionCookieStrings({ CFID: tokens.cfid, CFTOKEN: tokens.cftoken, jsessionid: tokens.jsessionid }, cfg, now));
    expect(cookies).toHaveLength(LEGACY_SESSION_COOKIE_NAMES.length);
    const values = [tokens.cfid, tokens.cftoken, tokens.jsessionid];
    LEGACY_SESSION_COOKIE_NAMES.forEach((name, index) => {
      expect(cookies[index]?.startsWith(`${name}=${values[index] ?? ''};`)).toBe(true);
    });
  });
});
