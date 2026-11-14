/** Credential and user-id login, strikes, the legacy-hash upgrade gate, login snapshots and logout over the in-memory identity store. */
import { beforeEach, describe, expect, it } from 'vitest';
import { formatCanonicalTimestamp } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, businessClock, fixedClock, registryPayloads } from '@opt2/platform/testing';
import {
  lockdownLogin,
  login,
  loginByQuery,
  loginByUserID,
  logout,
  lookupByCredentials,
  type LockdownLoginRequest,
  type LoginDeps,
  type LoginRequest,
  type LoginSettings,
} from '../../src/domain/login.js';
import { ensureSession } from '../../src/domain/sessions.js';
import { DEFAULT_STRIKE_SETTINGS, blockedUntil, isBlocked, loadStrikes } from '../../src/domain/strikes.js';
import { cfmxCompatHash, hashNewPassword, isBcryptHash, type LegacyPasswordConfig } from '../../src/legacy/hash.js';
import { CREDENTIAL, LOGIN_STATE, SESSION, USER_STRIKE, type SessionRow, type UserStrikeRow } from '../../src/repo/tables.js';
import {
  createMemoryIdentityRepo,
  createRecordingDb,
  type IdentitySeed,
  type MemoryIdentityRepo,
  type MemoryWrite,
  type RecordingDb,
  type ResponderRows,
} from '../helpers/memory-repo.js';
import {
  ADMIN_S2,
  DEFAULT_SEED,
  DEFAULT_SITE_TENANT,
  EDITOR,
  POOLED_MEMBER,
  SITE_ADMIN_A,
  TEST_PASSWORDS,
  accountRow,
  actorSeed,
  credentialRow,
  groupRow,
  membershipRow,
  type TestActor,
} from '../helpers/rows.js';

const CLOCK = businessClock('13:30:00');
const NOW = CLOCK.now();
const MINUTE_MS = 60_000;
const WRONG_PASSWORD = 'opt2-test-wrong';
const BUSINESS_NOON_TEXT = '2026-06-30T12:00:00.000';

// Cost 4 keeps each legacy-hash upgrade fast; jBCrypt accepts costs 4-31, so the stored hash stays legacy-readable.
const PASSWORD: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: true, javaEnabled: true, bcryptLogRounds: 4 };
const SETTINGS: LoginSettings = { password: PASSWORD, strikes: DEFAULT_STRIKE_SETTINGS };

const REGISTRY_TABLE = /\bidentity\.tenant_registry\b/;
const SITE_TENANTS: ReadonlyMap<string, string> = new Map(
  [TENANT_A, TENANT_B, TENANT_UMBRELLA, DEFAULT_SITE_TENANT].map(({ siteId, tenantId }) => [siteId, tenantId]),
);

/** `tenant_registry` rows of the fixture sites and the installed `default` site, whose user pools are its own, by site id. */
const REGISTRY_ROWS = registryPayloads()
  .concat({ siteId: DEFAULT_SITE_TENANT.siteId })
  .sort((a, b) => a.siteId.localeCompare(b.siteId, 'en'))
  .map((site) => ({
    site_id: site.siteId,
    tenant_id: SITE_TENANTS.get(site.siteId),
    public_user_pool_id: site.publicUserPoolId ?? null,
    private_user_pool_id: site.privateUserPoolId ?? null,
    public_user_pool_tenant: SITE_TENANTS.get(site.publicUserPoolId ?? site.siteId),
    private_user_pool_tenant: SITE_TENANTS.get(site.privateUserPoolId ?? site.siteId),
    aggregate_version: '1',
    updated_at: NOW,
  }));

/** Answers the registry reads of `@opt2/platform/tenancy` by their WHERE clause. */
const registryAnswer: ResponderRows = (sql, values) => {
  const [first] = values;
  if (/WHERE tenant_id = \$1/.test(sql)) return REGISTRY_ROWS.filter((row) => row.tenant_id === first);
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) return REGISTRY_ROWS.filter((row) => row.site_id === String(first).toLowerCase());
  return REGISTRY_ROWS;
};

const GROUP_PASSWORD = 'opt2-test-group';
const INACTIVE_ACCOUNT = accountRow({ username: 'inactive_user', inactive: 1 });
const INACTIVE_CREDENTIAL = credentialRow({ userid: INACTIVE_ACCOUNT.userid });
const PENDING_ACCOUNT = accountRow({ username: 'pending_user', opt2_state: 'pending' });
const PENDING_CREDENTIAL = credentialRow({ userid: PENDING_ACCOUNT.userid });
const LOGIN_GROUP = groupRow({ groupname: 'Login Group', username: 'group_login', password: cfmxCompatHash(GROUP_PASSWORD) });

interface TestDeps extends LoginDeps {
  db: RecordingDb;
  repo: MemoryIdentityRepo;
}

/** Login dependencies over a fresh recording database that answers the site registry and a memory repository holding `seed`. */
function makeDeps(seed: IdentitySeed = DEFAULT_SEED, settings: Partial<LoginSettings> = {}): TestDeps {
  const db = createRecordingDb({ responses: [[REGISTRY_TABLE, registryAnswer]] });
  const repo = createMemoryIdentityRepo(seed, { clock: CLOCK });
  return { db, repo, clock: CLOCK, settings: { ...SETTINGS, ...settings }, sleep: () => Promise.resolve() };
}

/** `base` with the rows of `extra` appended table by table. */
function seedWith(base: IdentitySeed, extra: IdentitySeed): IdentitySeed {
  const fields = new Set([...Object.keys(base), ...Object.keys(extra)]) as Set<keyof IdentitySeed>;
  return Object.fromEntries([...fields].map((field) => [field, [...(base[field] ?? []), ...(extra[field] ?? [])]])) as IdentitySeed;
}

/** `at` moved by `minutes`. */
function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

/** A target-primary credential login of `actor` on its own site; `overrides` replace any field. */
function requestFor(actor: TestActor, overrides: Partial<LoginRequest> = {}): LoginRequest {
  return { username: actor.account.username ?? '', password: actor.plainPassword, sessionId: 'S-login', mode: 'target-primary', siteId: actor.siteId, ...overrides };
}

/** The success branch of a login result; fails the test with the refusal otherwise. */
function succeeded<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  if (!result.ok) throw new Error(`login refused: ${JSON.stringify(result)}`);
  return result as Extract<R, { ok: true }>;
}

/** The stored strike row of `username` in `tenantId`. */
function strikeOf(repo: MemoryIdentityRepo, tenantId: string, username: string): UserStrikeRow | undefined {
  return repo.rows(USER_STRIKE.table, tenantId).find((row) => row.username === username);
}

/** The stored row of session `sessionId`, wherever it lives. */
function sessionOf(repo: MemoryIdentityRepo, sessionId: string): SessionRow | undefined {
  return repo.rows(SESSION.table).find((row) => row.session_id === sessionId);
}

/** The stored password of `actor`. */
function storedPassword(repo: MemoryIdentityRepo, actor: TestActor): string | null | undefined {
  return repo.rows(CREDENTIAL.table, actor.tenant.tenantId).find((row) => row.userid === actor.account.userid)?.password;
}

/** Changes the memory repository recorded on `table`. */
function writesTo(repo: MemoryIdentityRepo, table: string): MemoryWrite[] {
  return repo.writes().filter((write) => write.table === table);
}

/** Units whose write gate a statement on `db` share-locked, in statement order. */
function writeGatedUnits(db: RecordingDb): string[] {
  return db
    .statements()
    .filter((statement) => /^SELECT unit, state FROM "?identity"?\."?unit_gate"? .*FOR SHARE/.test(statement.sql))
    .flatMap((statement) => statement.values[0] as string[]);
}

/** Logs `actor` in `times` times with a wrong password, expecting each refusal to be `invalid`. */
async function failTimes(deps: LoginDeps, actor: TestActor, times: number): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    expect(await login(deps, requestFor(actor, { password: WRONG_PASSWORD }))).toEqual({ ok: false, reason: 'invalid' });
  }
}

describe('strikes through login (userstrikes.cfc, userUtility.cfc:238-253)', () => {
  let deps: TestDeps;
  const tenantId = EDITOR.tenant.tenantId;
  const username = 'qa_editor';

  beforeEach(() => {
    deps = makeDeps(actorSeed(EDITOR));
  });

  it('creates the row of an unknown username with no strikes a minute ago, then records the failed attempt in the umbrella tenant', async () => {
    expect(await login(deps, requestFor(EDITOR, { username: 'nobody' }))).toEqual({ ok: false, reason: 'invalid' });

    expect(writesTo(deps.repo, USER_STRIKE.table).map(({ tenantId: tenant, op, after }) => ({ tenant, op, after }))).toEqual([
      { tenant: TENANT_UMBRELLA.tenantId, op: 'insert', after: expect.objectContaining({ strikes: 0, lastattempt: minutesAfter(NOW, -1) }) },
      { tenant: TENANT_UMBRELLA.tenantId, op: 'update', after: expect.objectContaining({ strikes: 1, lastattempt: NOW }) },
    ]);
  });

  it('leaves four wrong passwords unblocked, with the block end a minute ago', async () => {
    await failTimes(deps, EDITOR, 4);

    const state = await deps.db.withTenant(tenantId, (tx) => loadStrikes(deps.repo, tx, username, { clock: CLOCK }));
    expect(state).toEqual({ username, strikes: 4, lastAttempt: NOW });
    expect(isBlocked(state, DEFAULT_STRIKE_SETTINGS)).toBe(false);
    expect(blockedUntil(state, DEFAULT_STRIKE_SETTINGS, CLOCK)).toEqual(minutesAfter(NOW, -1));
  });

  it('logs in after four wrong passwords and clears the strikes to 0 a minute ago', async () => {
    await failTimes(deps, EDITOR, 4);

    succeeded(await login(deps, requestFor(EDITOR)));
    expect(strikeOf(deps.repo, tenantId, username)).toMatchObject({ strikes: 0, lastattempt: minutesAfter(NOW, -1) });
  });

  it('blocks the correct password after a fifth wrong one until ten minutes after the last attempt, recording the end on the session', async () => {
    await ensureSession(deps, { sessionId: 'S-login', mode: 'target-primary' });
    await failTimes(deps, EDITOR, 5);

    const until = minutesAfter(NOW, 10);
    expect(await login(deps, requestFor(EDITOR))).toEqual({ ok: false, reason: 'blocked', blockedUntil: until });
    expect(JSON.parse(sessionOf(deps.repo, 'S-login')?.admin_state ?? '{}')).toEqual({ blockLoginUntil: formatCanonicalTimestamp(until) });
    expect(sessionOf(deps.repo, 'S-login')?.user_id).toBeNull();
  });

  it('answers a wrong password while blocked as blocked, without another strike', async () => {
    await failTimes(deps, EDITOR, 5);

    expect(await login(deps, requestFor(EDITOR, { password: WRONG_PASSWORD }))).toEqual({ ok: false, reason: 'blocked', blockedUntil: minutesAfter(NOW, 10) });
    expect(strikeOf(deps.repo, tenantId, username)).toMatchObject({ strikes: 5, lastattempt: NOW });
  });

  it('keeps the block at exactly ten minutes and lifts it a millisecond later, when the correct password logs in', async () => {
    await failTimes(deps, EDITOR, 5);
    const atEnd = { ...deps, clock: fixedClock(minutesAfter(NOW, 10)) };
    const lapsed = fixedClock(minutesAfter(NOW, 10).getTime() + 1);

    expect(await login(atEnd, requestFor(EDITOR))).toMatchObject({ ok: false, reason: 'blocked' });
    succeeded(await login({ ...deps, clock: lapsed }, requestFor(EDITOR)));
    expect(strikeOf(deps.repo, tenantId, username)).toMatchObject({ strikes: 0, lastattempt: minutesAfter(lapsed.now(), -1) });
  });
});

describe('password forms and the legacy-hash upgrade (userUtility.cfc:133-173)', () => {
  it('compares a plain stored password case-insensitively, as CFML eq does, when encryptPasswords is off', async () => {
    const plain = { ...EDITOR.credential, password: EDITOR.plainPassword };
    const deps = makeDeps({ ...actorSeed(EDITOR), credentials: [plain] }, { password: { encryptPasswords: false, bcryptPasswords: true, javaEnabled: true } });

    succeeded(await login(deps, requestFor(EDITOR, { password: EDITOR.plainPassword.toUpperCase() })));
    expect(await login(deps, requestFor(EDITOR, { password: WRONG_PASSWORD }))).toEqual({ ok: false, reason: 'invalid' });
    expect(writesTo(deps.repo, CREDENTIAL.table)).toEqual([]);
  });

  it('logs a stored $2a$ bcrypt hash in and leaves the credential unchanged', async () => {
    const hashed = await hashNewPassword(EDITOR.plainPassword, PASSWORD);
    const deps = makeDeps({ ...actorSeed(EDITOR), credentials: [{ ...EDITOR.credential, password: hashed }] });

    expect(isBcryptHash(hashed)).toBe(true);
    succeeded(await login(deps, requestFor(EDITOR)));
    expect(storedPassword(deps.repo, EDITOR)).toBe(hashed);
    expect(writesTo(deps.repo, CREDENTIAL.table)).toEqual([]);
  });

  it('rewrites a matching CFMX_COMPAT hash as $2a$ bcrypt while identity.credential is open, and the new hash logs in', async () => {
    const deps = makeDeps(actorSeed(EDITOR));
    const md5 = cfmxCompatHash(EDITOR.plainPassword);
    deps.db.setGate(CREDENTIAL.unit, 'open');

    const { snapshot } = succeeded(await login(deps, requestFor(EDITOR)));

    const upgraded = storedPassword(deps.repo, EDITOR);
    expect(EDITOR.credential.password).toBe(md5);
    expect(upgraded).toMatch(/^\$2a\$04\$/);
    expect(isBcryptHash(upgraded)).toBe(true);
    expect(snapshot.password).toBe(md5);
    expect(writesTo(deps.repo, CREDENTIAL.table)).toEqual([
      expect.objectContaining({
        tenantId: EDITOR.tenant.tenantId,
        op: 'update',
        before: expect.objectContaining({ password: md5 }),
        after: expect.objectContaining({ password: upgraded, passwordcreated: NOW }),
      }),
    ]);
    expect(writeGatedUnits(deps.db)).toContain('identity.credential');

    succeeded(await login(deps, requestFor(EDITOR)));
    expect(storedPassword(deps.repo, EDITOR)).toBe(upgraded);
    expect(writesTo(deps.repo, CREDENTIAL.table)).toHaveLength(1);
  });

  it('logs a CFMX_COMPAT hash in without rewriting it while legacy holds identity.credential', async () => {
    const deps = makeDeps(actorSeed(EDITOR));
    deps.db.setGate(CREDENTIAL.unit, 'legacy');

    succeeded(await login(deps, requestFor(EDITOR)));

    expect(storedPassword(deps.repo, EDITOR)).toBe(cfmxCompatHash(EDITOR.plainPassword));
    expect(writesTo(deps.repo, CREDENTIAL.table)).toEqual([]);
    expect(writeGatedUnits(deps.db)).not.toContain(CREDENTIAL.unit);
    expect(writeGatedUnits(deps.db)).toContain(LOGIN_STATE.unit);
  });

  it('trims the username before the lookup', async () => {
    const deps = makeDeps(actorSeed(EDITOR));

    const { snapshot } = succeeded(await login(deps, requestFor(EDITOR, { username: '  qa_editor  ' })));

    expect(snapshot).toMatchObject({ userid: EDITOR.account.userid, username: 'qa_editor' });
  });

  it('returns the matched account, its checked credential and its tenant from lookupByCredentials, recording no strike', async () => {
    const deps = makeDeps(actorSeed(EDITOR));

    expect(await lookupByCredentials(deps, ' qa_editor', EDITOR.plainPassword)).toEqual({
      account: EDITOR.account,
      credential: EDITOR.credential,
      tenantId: EDITOR.tenant.tenantId,
    });
    expect(writesTo(deps.repo, USER_STRIKE.table)).toEqual([]);
  });

  it.each([
    ['a wrong password', 'qa_editor', WRONG_PASSWORD],
    ['an unknown username', 'nobody', TEST_PASSWORDS.editor],
  ])('answers undefined from lookupByCredentials for %s', async (_label, username, password) => {
    const deps = makeDeps(actorSeed(EDITOR));

    expect(await lookupByCredentials(deps, username, password)).toBeUndefined();
    expect(writesTo(deps.repo, USER_STRIKE.table)).toEqual([]);
  });
});

describe('who can log in (userUtility.cfc:133-138,195-203,226-228,261-283)', () => {
  it.each([
    ['an inactive account', INACTIVE_ACCOUNT.username, TEST_PASSWORDS.default, { accounts: [INACTIVE_ACCOUNT], credentials: [INACTIVE_CREDENTIAL] }, TENANT_A],
    ['a roster account still reserved as pending', PENDING_ACCOUNT.username, TEST_PASSWORDS.default, { accounts: [PENDING_ACCOUNT], credentials: [PENDING_CREDENTIAL] }, TENANT_A],
    ['a Type=1 group row with a matching name and password', LOGIN_GROUP.username, GROUP_PASSWORD, { groups: [LOGIN_GROUP] }, TENANT_UMBRELLA],
  ])('refuses %s as invalid and records one strike', async (_label, username, password, seed: IdentitySeed, strikeTenant) => {
    const deps = makeDeps(seed);

    expect(await login(deps, { username: username ?? '', password, sessionId: 'S-login', mode: 'target-primary', siteId: TENANT_A.siteId })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(strikeOf(deps.repo, strikeTenant.tenantId, username ?? '')).toMatchObject({ strikes: 1, lastattempt: NOW });
    expect(deps.repo.rows(SESSION.table)).toEqual([]);
  });

  it('logs a public account in on a site whose public user pool holds it', async () => {
    const deps = makeDeps(actorSeed(POOLED_MEMBER));

    const { snapshot } = succeeded(await login(deps, requestFor(POOLED_MEMBER, { siteId: TENANT_A.siteId })));

    expect(snapshot.userid).toBe(POOLED_MEMBER.account.userid);
    expect(strikeOf(deps.repo, TENANT_UMBRELLA.tenantId, 'pooled_member')).toMatchObject({ strikes: 0 });
  });

  it.each([
    ['a site with its own public user pool', TENANT_B.siteId],
    ['no site', ''],
  ])('refuses a public account on %s as public-pool and records one strike', async (_label, siteId) => {
    const deps = makeDeps(actorSeed(POOLED_MEMBER));

    expect(await login(deps, requestFor(POOLED_MEMBER, { siteId }))).toEqual({ ok: false, reason: 'public-pool' });
    expect(strikeOf(deps.repo, TENANT_UMBRELLA.tenantId, 'pooled_member')).toMatchObject({ strikes: 1, lastattempt: NOW });
    expect(deps.repo.rows(SESSION.table)).toEqual([]);
  });

  it('logs an active account in by user id without touching its strikes', async () => {
    const deps = makeDeps(actorSeed(EDITOR));

    const { snapshot, session } = succeeded(
      await loginByUserID(deps, { userId: EDITOR.account.userid, sessionId: 'S-by-id', mode: 'target-primary', siteId: TENANT_A.siteId }),
    );

    expect(snapshot.roleList).toBe('Editor;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,qa_editor;username;tenant-a');
    expect(session.sessionId).toBe('S-by-id');
    expect(writesTo(deps.repo, USER_STRIKE.table)).toEqual([]);
  });

  it.each([
    ['a site with its own public user pool', TENANT_B.siteId],
    ['no site, which reads the default site', ''],
  ])('refuses a public account by user id on %s without a strike', async (_label, siteId) => {
    const deps = makeDeps(actorSeed(POOLED_MEMBER));

    expect(await loginByUserID(deps, { userId: POOLED_MEMBER.account.userid, sessionId: 'S-by-id', mode: 'target-primary', siteId })).toEqual({
      ok: false,
      reason: 'public-pool',
    });
    expect(writesTo(deps.repo, USER_STRIKE.table)).toEqual([]);
    expect(deps.repo.rows(SESSION.table)).toEqual([]);
  });

  it.each([
    ['an inactive account', INACTIVE_ACCOUNT.userid, { accounts: [INACTIVE_ACCOUNT], credentials: [INACTIVE_CREDENTIAL] }],
    ['a Type=1 group', LOGIN_GROUP.userid, { groups: [LOGIN_GROUP] }],
    ['an unknown id', EDITOR.account.userid, {}],
  ])('refuses %s by user id as invalid', async (_label, userId, seed: IdentitySeed) => {
    const deps = makeDeps(seed);

    expect(await loginByUserID(deps, { userId, sessionId: 'S-by-id', mode: 'target-primary', siteId: TENANT_A.siteId })).toEqual({ ok: false, reason: 'invalid' });
    expect(writesTo(deps.repo, USER_STRIKE.table)).toEqual([]);
  });

  it('flags the default password for admin/admin and records it on the session', async () => {
    const adminPassword = credentialRow({ tenant_id: DEFAULT_SITE_TENANT.tenantId, userid: ADMIN_S2.account.userid, plainPassword: 'admin' });
    const deps = makeDeps({ ...actorSeed(ADMIN_S2), credentials: [adminPassword] });

    expect(succeeded(await login(deps, requestFor(ADMIN_S2, { password: 'admin' }))).hasDefaultPassword).toBe(true);
    expect(JSON.parse(sessionOf(deps.repo, 'S-login')?.admin_state ?? '{}')).toEqual({ blockLoginUntil: '', hasdefaultpassword: true });
  });

  it('leaves the default-password flag off for any other credentials', async () => {
    const deps = makeDeps(actorSeed(ADMIN_S2));

    expect(succeeded(await login(deps, requestFor(ADMIN_S2))).hasDefaultPassword).toBe(false);
    expect(JSON.parse(sessionOf(deps.repo, 'S-login')?.admin_state ?? '{}')).toEqual({ blockLoginUntil: '' });
  });
});

describe('login effects (userUtility.cfc:306-388)', () => {
  it.each([
    ['a private-pool member of a group', EDITOR, 'Editor;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,qa_editor;username;tenant-a'],
    ['a site admin', SITE_ADMIN_A, 'Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin_a;username;tenant-a'],
    ['an S2 super user', ADMIN_S2, 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default'],
    ['a public-pool member', POOLED_MEMBER, 'S2IsPublic;umbrella,S2IsPublic,pooled_member;username;umbrella'],
  ])('builds the loginByQuery role list of %s', async (_label, actor, roleList) => {
    const deps = makeDeps(actorSeed(actor));
    const siteId = actor === POOLED_MEMBER ? TENANT_A.siteId : actor.siteId;

    expect(succeeded(await login(deps, requestFor(actor, { siteId }))).snapshot.roleList).toBe(roleList);
  });

  it('fixes the setUserStruct fields, group ids then the user id, and the checked credential in the snapshot', async () => {
    const deps = makeDeps(actorSeed(EDITOR));
    const [editors] = EDITOR.groups;

    const { snapshot } = succeeded(await login(deps, requestFor(EDITOR)));

    expect(snapshot).toEqual({
      userid: EDITOR.account.userid,
      username: 'qa_editor',
      siteid: 'tenant-a',
      subtype: 'Default',
      password: cfmxCompatHash(EDITOR.plainPassword),
      fname: 'QA',
      lname: 'Editor',
      email: EDITOR.contact.email,
      remoteid: '',
      company: '',
      lastlogin: null,
      passwordcreated: BUSINESS_NOON_TEXT,
      roleList: 'Editor;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,qa_editor;username;tenant-a',
      membershipIds: `${editors?.userid ?? ''},${EDITOR.account.userid}`,
    });
  });

  it('finds member groups stored in other tenants and drops ids that name no group', async () => {
    const volunteers = groupRow({ groupname: 'Volunteers', ispublic: 1 });
    const missing = groupRow();
    const member = { tenant_id: TENANT_UMBRELLA.tenantId, userid: POOLED_MEMBER.account.userid };
    const deps = makeDeps(
      seedWith(actorSeed(POOLED_MEMBER), {
        groups: [volunteers],
        memberships: [membershipRow({ ...member, groupid: volunteers.userid }), membershipRow({ ...member, groupid: missing.userid })],
      }),
    );

    const { snapshot } = succeeded(await login(deps, requestFor(POOLED_MEMBER, { siteId: TENANT_A.siteId })));

    expect(snapshot.roleList).toBe('Volunteers;tenant-a;1,S2IsPublic;umbrella,S2IsPublic,pooled_member;username;umbrella');
    expect(snapshot.membershipIds).toBe(`${volunteers.userid},${POOLED_MEMBER.account.userid}`);
  });

  it('stamps LastLogin now while the snapshot keeps the previous last login', async () => {
    const deps = makeDeps(actorSeed(ADMIN_S2));

    const { snapshot } = succeeded(await login(deps, requestFor(ADMIN_S2)));

    expect(snapshot.lastlogin).toBe(BUSINESS_NOON_TEXT);
    expect(deps.repo.rows(LOGIN_STATE.table, DEFAULT_SITE_TENANT.tenantId)).toEqual([
      { tenant_id: DEFAULT_SITE_TENANT.tenantId, userid: ADMIN_S2.account.userid, lastlogin: NOW },
    ]);
  });

  it('keeps the session id at login, as legacy does not rotate it, with the next epoch and a new CSRF secret', async () => {
    const deps = makeDeps(actorSeed(EDITOR));
    const anonymous = await ensureSession(deps, { sessionId: 'S-1', mode: 'target-primary' });

    const { snapshot, session } = succeeded(await login(deps, requestFor(EDITOR, { sessionId: 'S-1' })));

    expect(session).toMatchObject({ sessionId: 'S-1', epoch: anonymous.epoch + 1, mode: 'target-primary' });
    expect(session.csrfSecret).not.toBe(anonymous.csrfSecret);
    expect(deps.repo.rows(SESSION.table)).toHaveLength(1);
    expect(sessionOf(deps.repo, 'S-1')).toMatchObject({
      user_id: EDITOR.account.userid,
      site_id: TENANT_A.siteId,
      state: 'active',
      epoch: String(anonymous.epoch + 1),
      csrf_secret: session.csrfSecret,
      login_snapshot: JSON.stringify(snapshot),
    });
  });

  it('ends the session at logout under the same id and bumps its epoch', async () => {
    const deps = makeDeps(actorSeed(EDITOR));
    const { session } = succeeded(await login(deps, requestFor(EDITOR, { sessionId: 'S-1' })));

    expect(await logout(deps, 'S-1')).toEqual({ epoch: session.epoch + 1 });
    expect(sessionOf(deps.repo, 'S-1')).toMatchObject({ state: 'ended', user_id: null, epoch: String(session.epoch + 1), ended_at: NOW });
  });

  it('answers epoch 0 for logout of an unknown session', async () => {
    expect(await logout(makeDeps(actorSeed(EDITOR)), 'S-unknown')).toEqual({ epoch: 0 });
  });

  it.each([
    ['reads the credential in the login transaction when none is given', undefined, cfmxCompatHash(EDITOR.plainPassword)],
    ['takes the credential the caller read', { ...EDITOR.credential, password: 'caller-read' }, 'caller-read'],
  ])('loginByQuery %s and stamps LastLogin', async (_label, credential, password) => {
    const deps = makeDeps(actorSeed(EDITOR));

    const { snapshot, session } = await loginByQuery(deps, {
      tenantId: TENANT_A.tenantId,
      account: EDITOR.account,
      ...(credential === undefined ? {} : { credential }),
      sessionId: 'S-query',
      mode: 'target-primary',
      siteId: TENANT_A.siteId,
    });

    expect(snapshot).toMatchObject({ userid: EDITOR.account.userid, password, roleList: 'Editor;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,qa_editor;username;tenant-a' });
    expect(session.sessionId).toBe('S-query');
    expect(deps.repo.rows(LOGIN_STATE.table, TENANT_A.tenantId)).toEqual([expect.objectContaining({ userid: EDITOR.account.userid, lastlogin: NOW })]);
  });
});

describe('lockdown check instead of the login (userUtility.cfc:183-184,207-221)', () => {
  it.each([
    ['passes a cookie-based check: strikes and block cleared, nobody logged in', 'check', false, { ok: true, hasDefaultPassword: false }, 0, { blockLoginUntil: '' }],
    ['refuses a session-based check before clearing strikes or touching the session', 'check', true, { ok: false, reason: 'session-lockdown' }, 2, {}],
    ['answers a check CFML cannot read once the block is cleared, keeping the strikes', 'unreadable', false, { ok: false, reason: 'unreadable' }, 2, { blockLoginUntil: '' }],
  ] as const)('on matching credentials %s', async (_label, lockdown, sessionBased, expected, strikes, adminState) => {
    const deps = makeDeps(actorSeed(EDITOR));
    const anonymous = await ensureSession(deps, { sessionId: 'S-login', mode: 'target-primary' });
    await failTimes(deps, EDITOR, 2);
    const request: LockdownLoginRequest = { ...requestFor(EDITOR), lockdown, sessionBased };

    expect(await lockdownLogin(deps, request)).toEqual(expected);
    expect(strikeOf(deps.repo, TENANT_A.tenantId, 'qa_editor')).toMatchObject({ strikes });
    expect(sessionOf(deps.repo, 'S-login')).toMatchObject({ user_id: null, epoch: String(anonymous.epoch) });
    expect(JSON.parse(sessionOf(deps.repo, 'S-login')?.admin_state ?? '{}')).toEqual(adminState);
    expect(writesTo(deps.repo, LOGIN_STATE.table)).toEqual([]);
  });
});
