/** Identity sessions: cookie values, anonymous creation and reactivation, login, legacy adoption, state and hydration reads and logout against a throwaway `identity` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionCookieStrings, sessionIdForJsessionid, type LegacyCookieConfig } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { importUsedTokens } from '../../src/domain/csrf.js';
import { ANONYMOUS_USER_STRUCT, snapshotOfUserStruct, userStructOf } from '../../src/domain/roles.js';
import {
  ANONYMOUS_LOGIN_SNAPSHOT,
  adoptLegacySession,
  applyLogin,
  applyRelogin,
  endSession,
  ensureSession,
  locateSession,
  newSessionTokens,
  sessionCookies,
  sessionSnapshot,
  sessionState,
  type AppliedSession,
  type LegacyDescribe,
  type LoginApplication,
  type SessionDeps,
} from '../../src/domain/sessions.js';
import { createIdentityRepository, type IdentityRepository, type SessionPatch } from '../../src/repo/repository.js';
import type { LoginSnapshot, SessionRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const HOUR_MS = 3_600_000;
const SITE = 'tenant-a';
const TENANT_A = tenantIdForSite(SITE);
const USER = 'U0000000-0000-0000-0000000000000001';
const GROUP = 'G0000000-0000-0000-0000000000000001';
const LEGACY_SECRET = 'L0000000-0000-0000-0000000000000001';
const RELOGIN_SECRET = 'L0000000-0000-0000-0000000000000002';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const ANONYMOUS_SNAPSHOT_TEXT = JSON.stringify(ANONYMOUS_LOGIN_SNAPSHOT);
const EFFECT_FAILURE = new Error('session effect write failed');

const SNAPSHOT: LoginSnapshot = {
  userid: USER,
  username: 'ada',
  siteid: SITE,
  subtype: 'Default',
  password: 'stored-hash',
  fname: 'Ada',
  lname: 'Admin',
  email: 'ada@example.test',
  remoteid: '',
  company: 'Acme',
  lastlogin: '2026-06-30 09:15:00.120',
  passwordcreated: null,
  roleList: 'Editors;tenant-a;0,,S2IsPrivate;tenant-a',
  membershipIds: `${GROUP},${USER}`,
};

describe('session values', () => {
  it.each([
    ['a CF-format session id', '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', '0A1B2C3D4E5F60718293A4B5C6D7E8F9'],
    ['an adopted legacy session id', 'masacms_1000_00000001', 'masacms_1000_00000001'],
  ])('gives %s a fresh v4 UUID CFID, CFTOKEN 0 and the JSESSIONID naming it', (_label, sessionId, jsessionid) => {
    const tokens = newSessionTokens(sessionId);

    expect(tokens.cfid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(tokens.cftoken).toBe('0');
    expect(tokens.jsessionid).toBe(jsessionid);
    expect(newSessionTokens(sessionId).cfid).not.toBe(tokens.cfid);
  });

  it('writes CFID, CFTOKEN and JSESSIONID with the legacy cookie attributes', () => {
    const tokens = { cfid: 'cfid-1', cftoken: '0', jsessionid: 'ABCDEF' };
    const cfg: LegacyCookieConfig = { secureCookies: true, cookiePath: '/' };

    const cookies = sessionCookies(tokens, cfg, NOW);

    expect(cookies).toEqual(sessionCookieStrings({ CFID: 'cfid-1', CFTOKEN: '0', jsessionid: 'ABCDEF' }, cfg, NOW));
    expect(cookies.map((cookie) => cookie.split('=')[0])).toEqual(['CFID', 'CFTOKEN', 'JSESSIONID']);
  });

  it('stores the not-logged-in session.mura values as the frozen anonymous snapshot', () => {
    expect(Object.isFrozen(ANONYMOUS_LOGIN_SNAPSHOT)).toBe(true);
    expect(ANONYMOUS_LOGIN_SNAPSHOT).toEqual(snapshotOfUserStruct(ANONYMOUS_USER_STRUCT));
    expect(ANONYMOUS_LOGIN_SNAPSHOT).toMatchObject({ userid: '', subtype: 'Default', lastlogin: null, passwordcreated: null, roleList: '', membershipIds: '' });
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('sessions against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let now: Date;
  let sessionSeq = 0;
  const clock: Clock = { now: () => new Date(now.getTime()) };

  function deps(sessionRepo: IdentityRepository = repo): SessionDeps {
    return { db: handle.app, repo: sessionRepo, clock };
  }

  function inTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(handle.app, tenantId, fn);
  }

  function nextSessionId(): string {
    sessionSeq += 1;
    return `S-${sessionSeq}`;
  }

  function stored(sessionId: string, tenantId: string): Promise<SessionRow | null> {
    return inTenant(tenantId, (tx) => repo.findSession(tx, sessionId));
  }

  async function claimKeys(sessionId: string, tenantId: string): Promise<string[]> {
    return (await inTenant(tenantId, (tx) => repo.listCsrfClaims(tx, sessionId))).map((row) => row.token);
  }

  function markUsed(sessionId: string, tenantId: string, tokens: readonly { token: string; usedAt: Date }[]): Promise<number> {
    return inTenant(tenantId, (tx) => importUsedTokens(repo, tx, sessionId, tokens));
  }

  function setColumns(sessionId: string, tenantId: string, patch: SessionPatch): Promise<SessionRow | null> {
    return inTenant(tenantId, (tx) => repo.updateSession(tx, sessionId, patch));
  }

  function login(sessionId: string, overrides: Partial<LoginApplication> = {}): Promise<AppliedSession> {
    return applyLogin(deps(), { sessionId, snapshot: SNAPSHOT, mode: 'target-primary', siteId: SITE, ...overrides });
  }

  /** Inserts a session row directly under `tenantId`, as a site tenant may hold one, at `epoch`. */
  async function seedSession(tenantId: string, state: 'active' | 'ended', epoch: number): Promise<string> {
    const sessionId = nextSessionId();
    await inTenant(tenantId, (tx) => repo.insertSession(tx, { session_id: sessionId, csrf_secret: LEGACY_SECRET, mode: 'legacy-primary', state, epoch }));
    return sessionId;
  }

  function describeLegacy(sessionId: string, user: Record<string, unknown>, extra: Partial<LegacyDescribe['describe']> = {}): LegacyDescribe {
    return { legacySessionId: sessionId, siteId: SITE, describe: { user, roles: [], csrfSecretKey: LEGACY_SECRET, usedTokens: [], ...extra } };
  }

  /** The repository with `insertSession` held until `count` callers reach it, so every caller has located the session as absent first. */
  function latchedInserts(count: number): IdentityRepository {
    let arrived = 0;
    let release: () => void = () => undefined;
    const allArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      ...repo,
      async insertSession(tx, row, ctx) {
        arrived += 1;
        if (arrived === count) release();
        await allArrived;
        return repo.insertSession(tx, row, ctx);
      },
    };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)`, [SITE, TENANT_A, NOW]),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    now = NOW;
  });

  describe('ensureSession', () => {
    it('creates an anonymous system-tenant session under a new CF-format id and returns the cookie values naming it', async () => {
      const ensured = await ensureSession(deps(), { mode: 'target-primary' });
      const jsessionid = ensured.tokens?.jsessionid ?? '';

      expect(ensured).toMatchObject({ tenantId: SYSTEM_TENANT_ID, epoch: 1, created: true, tokens: { cftoken: '0' } });
      expect(ensured.sessionId).toMatch(CF_UUID);
      expect(jsessionid).toMatch(/^[0-9A-F]{32}$/);
      expect(jsessionid).not.toBe(ensured.sessionId);
      expect(sessionIdForJsessionid(jsessionid)).toBe(ensured.sessionId);
      expect(ensured.csrfSecret).toMatch(CF_UUID);
      expect(await stored(ensured.sessionId, SYSTEM_TENANT_ID)).toMatchObject({
        user_id: null,
        site_id: null,
        login_snapshot: ANONYMOUS_SNAPSHOT_TEXT,
        csrf_secret: ensured.csrfSecret,
        mode: 'target-primary',
        state: 'active',
        epoch: '1',
      });
    });

    it('creates a requested session id once and returns the active session unchanged afterwards', async () => {
      const sessionId = nextSessionId();

      const first = await ensureSession(deps(), { sessionId, mode: 'legacy-primary' });
      expect(first).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, csrfSecret: first.csrfSecret, epoch: 1, created: true });
      expect(first.csrfSecret).toMatch(CF_UUID);
      expect(await ensureSession(deps(), { sessionId, mode: 'target-primary' })).toEqual({ ...first, created: false });
      expect((await stored(sessionId, SYSTEM_TENANT_ID))?.mode).toBe('legacy-primary');
    });

    it('returns an active session from the tenant holding it without locking its row', async () => {
      const sessionId = await seedSession(TENANT_A, 'active', 4);
      const unlockable: IdentityRepository = { ...repo, lockSession: () => Promise.reject(EFFECT_FAILURE) };

      expect(await ensureSession(deps(unlockable), { sessionId, mode: 'target-primary' })).toEqual({
        sessionId,
        tenantId: TENANT_A,
        csrfSecret: LEGACY_SECRET,
        epoch: 4,
        created: false,
      });
    });

    it('lets concurrent first requests of one session share the session one of them created', async () => {
      const sessionId = nextSessionId();
      const racing = deps(latchedInserts(3));

      const results = await Promise.all(Array.from({ length: 3 }, () => ensureSession(racing, { sessionId, mode: 'target-primary' })));

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.csrfSecret)).size).toBe(1);
      expect(results.map((result) => [result.tenantId, result.epoch])).toEqual(Array.from({ length: 3 }, () => [SYSTEM_TENANT_ID, 1]));
    });

    it.each([
      ['an insert failure', () => new Error('connection reset')],
      ['a unique violation whose session cannot be found', () => Object.assign(new Error('duplicate key value'), { code: '23505' })],
    ])('rethrows %s', async (_label, failure) => {
      const error = failure();
      const failing: IdentityRepository = {
        ...repo,
        insertSession() {
          return Promise.reject(error);
        },
      };

      await expect(ensureSession(deps(failing), { sessionId: nextSessionId(), mode: 'target-primary' })).rejects.toBe(error);
    });

    it('reactivates an ended session in place as anonymous under the same id at the next epoch', async () => {
      const sessionId = nextSessionId();
      await login(sessionId);
      const ended = await endSession(deps(), sessionId);
      const endedSecret = (await stored(sessionId, SYSTEM_TENANT_ID))?.csrf_secret;

      const reactivated = await ensureSession(deps(), { sessionId, mode: 'legacy-primary' });

      expect(reactivated).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, csrfSecret: reactivated.csrfSecret, epoch: ended.epoch + 1, created: false });
      expect(reactivated.csrfSecret).toMatch(CF_UUID);
      expect(reactivated.csrfSecret).not.toBe(endedSecret);
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({
        user_id: null,
        login_snapshot: ANONYMOUS_SNAPSHOT_TEXT,
        csrf_secret: reactivated.csrfSecret,
        mode: 'legacy-primary',
        state: 'active',
        ended_at: null,
        epoch: '3',
      });
    });

    it('reactivates an ended session once when concurrent requests find it ended', async () => {
      const sessionId = nextSessionId();
      await login(sessionId);
      const ended = await endSession(deps(), sessionId);

      const results = await Promise.all(Array.from({ length: 3 }, () => ensureSession(deps(), { sessionId, mode: 'target-primary' })));

      expect(results.map((result) => result.epoch)).toEqual(Array.from({ length: 3 }, () => ended.epoch + 1));
      expect(new Set(results.map((result) => result.csrfSecret)).size).toBe(1);
      expect((await stored(sessionId, SYSTEM_TENANT_ID))?.epoch).toBe(String(ended.epoch + 1));
    });
  });

  describe('applyLogin', () => {
    it('logs a snapshot into a new session of the system tenant at epoch 1 with a fresh CSRF secret', async () => {
      const sessionId = nextSessionId();

      const applied = await login(sessionId);

      expect(applied).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 1, csrfSecret: applied.csrfSecret, mode: 'target-primary' });
      expect(applied.csrfSecret).toMatch(CF_UUID);
      expect(await stored(sessionId, TENANT_A)).toBeNull();
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({
        user_id: USER,
        site_id: SITE,
        login_snapshot: JSON.stringify(SNAPSHOT),
        csrf_secret: applied.csrfSecret,
        state: 'active',
        jar_ref: null,
        admin_state: null,
        epoch: '1',
      });
    });

    it('logs an anonymous session in where it is, keeping its id, mode, jar and admin state and dropping its CSRF claims', async () => {
      const sessionId = nextSessionId();
      const anonymous = await ensureSession(deps(), { sessionId, mode: 'legacy-primary' });
      const adminState = JSON.stringify({ rb: 'en' });
      await setColumns(sessionId, SYSTEM_TENANT_ID, { jar_ref: 'jar-1', admin_state: adminState });
      await markUsed(sessionId, SYSTEM_TENANT_ID, [{ token: 'aa', usedAt: NOW }]);

      const applied = await login(sessionId, { mode: 'target-primary' });

      expect(applied).toMatchObject({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2, mode: 'legacy-primary' });
      expect(applied.csrfSecret).not.toBe(anonymous.csrfSecret);
      expect(await stored(sessionId, TENANT_A)).toBeNull();
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual([]);
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({
        user_id: USER,
        mode: 'legacy-primary',
        jar_ref: 'jar-1',
        admin_state: adminState,
        csrf_secret: applied.csrfSecret,
        epoch: '2',
      });
    });

    it('logs in again in place, dropping CSRF claims and bumping the epoch', async () => {
      const sessionId = nextSessionId();
      const first = await login(sessionId);
      await markUsed(sessionId, SYSTEM_TENANT_ID, [{ token: 'aa', usedAt: NOW }]);

      const again = await login(sessionId, { siteId: null });

      expect(again).toMatchObject({ tenantId: SYSTEM_TENANT_ID, epoch: 2 });
      expect(again.csrfSecret).not.toBe(first.csrfSecret);
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual([]);
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ site_id: null, csrf_secret: again.csrfSecret, epoch: '2' });
    });

    it('re-creates under the system tenant a session deleted between its lookup and its lock', async () => {
      const sessionId = await seedSession(TENANT_A, 'active', 4);
      const deleting: IdentityRepository = {
        ...repo,
        async lockSession(tx, id, mode) {
          await repo.deleteSession(tx, id);
          return repo.lockSession(tx, id, mode);
        },
      };

      const applied = await applyLogin(deps(deleting), { sessionId, snapshot: SNAPSHOT, mode: 'target-primary', siteId: SITE });

      expect(applied).toMatchObject({ tenantId: SYSTEM_TENANT_ID, epoch: 1 });
      expect(await stored(sessionId, TENANT_A)).toBeNull();
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: USER, csrf_secret: applied.csrfSecret, state: 'active', epoch: '1' });
    });

    it('serializes concurrent logins with ensure and reads of one session: none sees it absent, one row stays and each login takes the next epoch', async () => {
      const sessionId = nextSessionId();
      await ensureSession(deps(), { sessionId, mode: 'target-primary' });

      const [first, second, ensured, located, ...states] = await Promise.all([
        login(sessionId),
        login(sessionId),
        ensureSession(deps(), { sessionId, mode: 'target-primary' }),
        locateSession(deps(), sessionId),
        sessionState(deps(), sessionId),
        sessionState(deps(), sessionId),
      ]);

      expect([first.epoch, second.epoch].sort()).toEqual([2, 3]);
      expect(first.csrfSecret).not.toBe(second.csrfSecret);
      expect(ensured).toMatchObject({ sessionId, tenantId: SYSTEM_TENANT_ID, created: false });
      expect(located).toMatchObject({ tenantId: SYSTEM_TENANT_ID, row: { session_id: sessionId, state: 'active' } });
      expect(states.map((state) => state.state)).toEqual(['active', 'active']);
      expect(await stored(sessionId, TENANT_A)).toBeNull();
      const last = first.epoch > second.epoch ? first : second;
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: USER, csrf_secret: last.csrfSecret, epoch: '3' });
    });

    it.each<[string, Partial<IdentityRepository>, (d: SessionDeps, sessionId: string) => Promise<unknown>]>([
      ['a login whose session write fails', { updateSession: () => Promise.reject(EFFECT_FAILURE) }, (d, id) => applyLogin(d, { sessionId: id, snapshot: SNAPSHOT, mode: 'target-primary', siteId: SITE })],
      [
        'an adoption whose used-token import fails',
        { setCsrfClaimState: () => Promise.reject(EFFECT_FAILURE) },
        (d, id) => adoptLegacySession(d, describeLegacy(id, { isLoggedIn: true, userID: USER, siteID: SITE }, { csrfSecretKey: RELOGIN_SECRET, usedTokens: ['zz'] }), { mode: 'legacy-primary' }),
      ],
      ['a logout whose session write fails', { updateSession: () => Promise.reject(EFFECT_FAILURE) }, (d, id) => endSession(d, id)],
    ])('leaves the session row, its epoch and its CSRF claims intact after %s', async (_label, failure, effect) => {
      const sessionId = nextSessionId();
      await login(sessionId);
      await markUsed(sessionId, SYSTEM_TENANT_ID, [{ token: 'aa', usedAt: NOW }]);
      const before = await stored(sessionId, SYSTEM_TENANT_ID);

      await expect(effect(deps({ ...repo, ...failure }), sessionId)).rejects.toBe(EFFECT_FAILURE);

      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toEqual(before);
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual(['AA']);
    });
  });

  describe('applyRelogin', () => {
    const RELOGGED: LoginSnapshot = { ...SNAPSHOT, fname: 'Adele', roleList: 'Authors;tenant-a;0' };

    it.each<[string, (sessionId: string) => Promise<unknown>, boolean]>([
      [
        'logs an active session in again at its stored site, keeping its mode, jar and admin state and dropping its CSRF claims',
        async (id) => {
          await login(id, { mode: 'legacy-primary', siteId: 'tenant-b' });
          await setColumns(id, SYSTEM_TENANT_ID, { jar_ref: 'jar-1', admin_state: JSON.stringify({ rb: 'en' }) });
          await markUsed(id, SYSTEM_TENANT_ID, [{ token: 'aa', usedAt: NOW }]);
        },
        true,
      ],
      [
        'leaves an ended session unchanged',
        async (id) => {
          await login(id);
          await endSession(deps(), id);
        },
        false,
      ],
      [
        'leaves a session another effect moved past the claimed epoch unchanged',
        async (id) => {
          await login(id);
          await login(id);
        },
        false,
      ],
      ['creates nothing for an unknown session', async () => undefined, false],
    ])('%s', async (_label, setup, relogs) => {
      const sessionId = nextSessionId();
      await setup(sessionId);
      const before = await stored(sessionId, SYSTEM_TENANT_ID);

      const applied = await applyRelogin(deps(), { sessionId, snapshot: RELOGGED, epoch: 1 });

      const after = await stored(sessionId, SYSTEM_TENANT_ID);
      expect(after).toEqual(
        relogs
          ? { ...before, login_snapshot: JSON.stringify(RELOGGED), csrf_secret: expect.not.stringMatching(before?.csrf_secret ?? ''), epoch: '2' }
          : before,
      );
      expect(applied).toEqual(
        relogs ? { sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2, csrfSecret: after?.csrf_secret, mode: 'legacy-primary' } : undefined,
      );
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual([]);
      expect(await stored(sessionId, TENANT_A)).toBeNull();
    });
  });

  describe('adoptLegacySession', () => {
    const LEGACY_USER = {
      ISLOGGEDIN: 'Yes',
      USERID: USER,
      UserName: 'ada',
      siteid: SITE,
      fname: 'Ada',
      lname: 'Admin',
      email: 'ada@example.test',
      remoteID: 42,
      company: { name: 'not a simple value' },
      lastLogin: '2026-06-30 09:15:00.120',
      membershipIds: `${GROUP},${USER}`,
    };
    const ROLES = ['Editors;tenant-a;0', 'S2IsPrivate;tenant-a'];

    it('adopts a logged-in legacy session under the system tenant with its secret, struct, role list and used tokens', async () => {
      const sessionId = nextSessionId();

      const adopted = await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { roles: ROLES, usedTokens: ['aa', 'BB', 'AA'] }), {
        mode: 'legacy-primary',
        jarRef: 'jar-1',
      });

      expect(adopted).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 1, mode: 'legacy-primary' });
      const loginSnapshot: LoginSnapshot = {
        userid: USER,
        username: 'ada',
        siteid: SITE,
        subtype: 'Default',
        password: '',
        fname: 'Ada',
        lname: 'Admin',
        email: 'ada@example.test',
        remoteid: '42',
        company: '',
        lastlogin: '2026-06-30 09:15:00.120',
        passwordcreated: null,
        roleList: ROLES.join(','),
        membershipIds: `${GROUP},${USER}`,
      };
      expect(await sessionSnapshot(deps(), sessionId)).toEqual({
        sessionId,
        epoch: 1,
        loginSnapshot,
        user: userStructOf(loginSnapshot),
        roles: ROLES,
        csrfSecret: LEGACY_SECRET,
        usedTokens: [
          { token: 'AA', usedAt: NOW },
          { token: 'BB', usedAt: NOW },
        ],
      });
      expect(await stored(sessionId, TENANT_A)).toBeNull();
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: USER, site_id: SITE, jar_ref: 'jar-1', mode: 'legacy-primary' });
    });

    it('refreshes only mode, jar and used tokens of an unchanged adopted session, keeping the epoch', async () => {
      const sessionId = nextSessionId();
      await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { roles: ROLES, usedTokens: ['aa'] }), { mode: 'legacy-primary', jarRef: 'jar-1' });
      const before = await stored(sessionId, SYSTEM_TENANT_ID);

      const kept = await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { roles: [], usedTokens: ['cc'] }), { mode: 'target-primary' });

      expect(kept).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 1, mode: 'target-primary' });
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ login_snapshot: before?.login_snapshot, jar_ref: 'jar-1', mode: 'target-primary', epoch: '1' });
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual(['AA', 'CC']);

      await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER), { mode: 'target-primary', jarRef: null });
      expect((await stored(sessionId, SYSTEM_TENANT_ID))?.jar_ref).toBeNull();
    });

    it('replaces the snapshot, secret and used tokens at the next epoch when legacy logged in again', async () => {
      const sessionId = nextSessionId();
      await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { roles: ROLES, usedTokens: ['aa'] }), { mode: 'legacy-primary' });

      const relogged = await adoptLegacySession(
        deps(),
        describeLegacy(sessionId, { ...LEGACY_USER, fname: 'Adele' }, { roles: ['Authors;tenant-a;0'], csrfSecretKey: RELOGIN_SECRET, usedTokens: ['bb'] }),
        { mode: 'legacy-primary' },
      );

      expect(relogged).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2, mode: 'legacy-primary' });
      expect(await sessionSnapshot(deps(), sessionId)).toMatchObject({
        loginSnapshot: { fname: 'Adele', roleList: 'Authors;tenant-a;0' },
        csrfSecret: RELOGIN_SECRET,
        usedTokens: [{ token: 'BB', usedAt: NOW }],
      });
    });

    it('rebuilds the session as anonymous in place when legacy logged out since adoption, keeping jar and admin state', async () => {
      const sessionId = nextSessionId();
      await adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { roles: ROLES, usedTokens: ['aa'] }), { mode: 'legacy-primary', jarRef: 'jar-1' });
      const adminState = JSON.stringify({ rb: 'en' });
      await setColumns(sessionId, SYSTEM_TENANT_ID, { admin_state: adminState });

      const loggedOut = await adoptLegacySession(deps(), describeLegacy(sessionId, { isLoggedIn: false }, { csrfSecretKey: RELOGIN_SECRET, usedTokens: ['dd'] }), {
        mode: 'legacy-primary',
      });

      expect(loggedOut).toEqual({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2, mode: 'legacy-primary' });
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual(['DD']);
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toMatchObject({
        user_id: null,
        site_id: SITE,
        login_snapshot: ANONYMOUS_SNAPSHOT_TEXT,
        csrf_secret: RELOGIN_SECRET,
        jar_ref: 'jar-1',
        admin_state: adminState,
      });
      expect(await sessionSnapshot(deps(), sessionId)).toMatchObject({ user: ANONYMOUS_USER_STRUCT, roles: [], usedTokens: [{ token: 'DD', usedAt: NOW }] });
    });

    it.each([
      ['a target login', (sessionId: string) => login(sessionId)],
      [
        'a legacy login seen at adoption',
        (sessionId: string) => adoptLegacySession(deps(), describeLegacy(sessionId, LEGACY_USER, { csrfSecretKey: RELOGIN_SECRET }), { mode: 'legacy-primary' }),
      ],
      ['a re-login', (sessionId: string) => applyRelogin(deps(), { sessionId, snapshot: SNAPSHOT, epoch: 1 })],
    ])('drops the post-login session.mura values on %s, keeping the other admin state', async (_label, relogin) => {
      const sessionId = nextSessionId();
      await login(sessionId);
      await setColumns(sessionId, SYSTEM_TENANT_ID, { admin_state: JSON.stringify({ rb: 'en', mura: { errors: '', objectInstanceId: 'I1' } }) });

      await relogin(sessionId);

      expect(JSON.parse((await stored(sessionId, SYSTEM_TENANT_ID))?.admin_state ?? 'null')).toEqual({ rb: 'en' });
    });

    it.each([
      ['true', true, USER],
      ["'TRUE'", 'TRUE', USER],
      ["'yes'", 'yes', USER],
      ['1', 1, USER],
      ["'2'", '2', USER],
      ['false', false, ''],
      ["'no'", 'no', ''],
      ['0', 0, ''],
      ["'maybe'", 'maybe', ''],
      ['an absent key', undefined, ''],
    ])('reads isLoggedIn %s as CFML isBoolean and true', async (_label, isLoggedIn, userId) => {
      const user = isLoggedIn === undefined ? { userID: USER, siteID: SITE } : { isLoggedIn, userID: USER, siteID: SITE };
      const sessionId = nextSessionId();

      expect((await adoptLegacySession(deps(), describeLegacy(sessionId, user), { mode: 'legacy-primary' })).tenantId).toBe(SYSTEM_TENANT_ID);
      expect((await sessionState(deps(), sessionId)).userId).toBe(userId);
    });
  });

  describe('session row tenant', () => {
    it.each<[string, 'active' | 'ended', (sessionId: string) => Promise<unknown>]>([
      ['a login', 'active', (id) => login(id)],
      ['a reactivation', 'ended', (id) => ensureSession(deps(), { sessionId: id, mode: 'target-primary' })],
      [
        'an adoption after a legacy login',
        'active',
        (id) => adoptLegacySession(deps(), describeLegacy(id, { isLoggedIn: true, userID: USER, siteID: SITE }, { csrfSecretKey: RELOGIN_SECRET }), { mode: 'legacy-primary' }),
      ],
      ['a logout', 'active', (id) => endSession(deps(), id)],
    ])('rewrites a session a site tenant holds in place on %s, at the next epoch', async (_label, state, effect) => {
      const sessionId = await seedSession(TENANT_A, state, 4);

      await effect(sessionId);

      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toBeNull();
      expect(await stored(sessionId, TENANT_A)).toMatchObject({ session_id: sessionId, epoch: '5' });
    });
  });

  describe('sessionState and sessionSnapshot', () => {
    it('reads an unknown session as ended at epoch 0 without mode, user or site, and without a snapshot', async () => {
      expect(await sessionState(deps(), 'S-unknown')).toEqual({ epoch: 0, state: 'ended', mode: null, userId: '', siteId: '' });
      expect(await sessionSnapshot(deps(), 'S-unknown')).toBeUndefined();
    });

    it('reads the state, epoch, mode, user and site of a session through login and logout', async () => {
      const sessionId = nextSessionId();
      await login(sessionId, { mode: 'legacy-primary' });
      expect(await sessionState(deps(), sessionId)).toEqual({ epoch: 1, state: 'active', mode: 'legacy-primary', userId: USER, siteId: SITE });

      await endSession(deps(), sessionId);
      expect(await sessionState(deps(), sessionId)).toEqual({ epoch: 2, state: 'ended', mode: 'legacy-primary', userId: '', siteId: '' });
      expect(await sessionSnapshot(deps(), sessionId)).toBeUndefined();
    });

    it('hydrates an anonymous session with the not-logged-in values and no roles', async () => {
      const ensured = await ensureSession(deps(), { sessionId: nextSessionId(), mode: 'target-primary' });

      expect(await sessionSnapshot(deps(), ensured.sessionId)).toEqual({
        sessionId: ensured.sessionId,
        epoch: 1,
        loginSnapshot: ANONYMOUS_LOGIN_SNAPSHOT,
        user: ANONYMOUS_USER_STRUCT,
        roles: [],
        csrfSecret: ensured.csrfSecret,
        usedTokens: [],
      });
    });

    it('hydrates a session stored without a login snapshot as anonymous', async () => {
      const sessionId = nextSessionId();
      await inTenant(SYSTEM_TENANT_ID, (tx) => repo.insertSession(tx, { session_id: sessionId, csrf_secret: LEGACY_SECRET, mode: 'legacy-primary', state: 'active' }));

      expect(await sessionSnapshot(deps(), sessionId)).toMatchObject({ epoch: 0, loginSnapshot: ANONYMOUS_LOGIN_SNAPSHOT, user: ANONYMOUS_USER_STRUCT, roles: [] });
    });

    it('hydrates a logged-in session from its login-time snapshot, skipping empty role items and tokens used over 3 h ago', async () => {
      const sessionId = nextSessionId();
      const applied = await login(sessionId);
      await markUsed(sessionId, SYSTEM_TENANT_ID, [
        { token: 'old', usedAt: new Date(NOW.getTime() - 3 * HOUR_MS - 1) },
        { token: 'new', usedAt: NOW },
      ]);

      expect(await sessionSnapshot(deps(), sessionId)).toEqual({
        sessionId,
        epoch: 1,
        loginSnapshot: SNAPSHOT,
        user: userStructOf(SNAPSHOT),
        roles: ['Editors;tenant-a;0', 'S2IsPrivate;tenant-a'],
        csrfSecret: applied.csrfSecret,
        usedTokens: [{ token: 'NEW', usedAt: NOW }],
      });
    });
  });

  describe('endSession', () => {
    it('ends a session in place as logout clears its scope, keeping id and mode and dropping jar, admin state and CSRF claims', async () => {
      const sessionId = nextSessionId();
      const applied = await login(sessionId, { mode: 'legacy-primary' });
      await setColumns(sessionId, SYSTEM_TENANT_ID, { jar_ref: 'jar-1', admin_state: JSON.stringify({ rb: 'en' }) });
      await markUsed(sessionId, SYSTEM_TENANT_ID, [{ token: 'aa', usedAt: NOW }]);
      now = new Date(NOW.getTime() + 60_000);

      expect(await endSession(deps(), sessionId)).toEqual({ epoch: 2 });

      const ended = await stored(sessionId, SYSTEM_TENANT_ID);
      expect(ended).toMatchObject({
        user_id: null,
        site_id: null,
        login_snapshot: ANONYMOUS_SNAPSHOT_TEXT,
        mode: 'legacy-primary',
        state: 'ended',
        jar_ref: null,
        admin_state: null,
        ended_at: now,
        epoch: '2',
      });
      expect(ended?.csrf_secret).toMatch(CF_UUID);
      expect(ended?.csrf_secret).not.toBe(applied.csrfSecret);
      expect(await claimKeys(sessionId, SYSTEM_TENANT_ID)).toEqual([]);
    });

    it('leaves an ended session unchanged and answers epoch 0 for an unknown one', async () => {
      const sessionId = nextSessionId();
      await login(sessionId);
      await endSession(deps(), sessionId);
      const ended = await stored(sessionId, SYSTEM_TENANT_ID);
      now = new Date(NOW.getTime() + 60_000);

      expect(await endSession(deps(), sessionId)).toEqual({ epoch: 2 });
      expect(await stored(sessionId, SYSTEM_TENANT_ID)).toEqual(ended);
      expect(await endSession(deps(), 'S-unknown')).toEqual({ epoch: 0 });
    });
  });
});
