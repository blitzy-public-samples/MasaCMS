/** Credential and user-id login, `loginByQuery` snapshots, strikes, the legacy-hash upgrade gate and logout against a throwaway `identity` schema. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUnitGates, withGatedTenant, type GateState } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { OperationBlockedError, USER_CLOSED_WAIT_MS, withOpenAccount } from '../../src/domain/account-operations.js';
import {
  DEFAULT_LOGIN_SETTINGS,
  LOGIN_SESSION_KEYS,
  login,
  loginByQuery,
  loginByUserID,
  logout,
  lookupByCredentials,
  type LoginDeps,
  type LoginRequest,
  type LoginSettings,
} from '../../src/domain/login.js';
import { ANONYMOUS_LOGIN_SNAPSHOT, ensureSession } from '../../src/domain/sessions.js';
import { DEFAULT_STRIKE_SETTINGS } from '../../src/domain/strikes.js';
import type { LegacyPasswordConfig } from '../../src/legacy/hash.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository, type SessionAdminState } from '../../src/repo/repository.js';
import {
  IDENTITY_UNITS,
  LOGIN_STATE,
  type CredentialRow,
  type LoginSnapshot,
  type LoginStateRow,
  type SessionMode,
  type SessionRow,
  type UserAccountRow,
  type UserStrikeRow,
} from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const PASSWORD_CREATED = new Date(2026, 5, 1, 9, 15, 0, 0);
const LAST_LOGIN = new Date(2026, 5, 29, 9, 15, 0, 120);
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const PASSWORD = 'Secret12';
const SITE_A = 'tenant-a';
const SITE_B = 'tenant-b';
const SITE_C = 'tenant-c';
const UMBRELLA = 'umbrella';
const DEFAULT = 'default';
const TENANT_A = tenantIdForSite(SITE_A);
const CREDENTIAL_UNIT = 'identity.credential';
const LEGACY_ROOT = new URL('../../../../', import.meta.url);
const USER_UTILITY = 'core/mura/user/userUtility.cfc';
const USER_STRIKES = 'core/mura/user/userstrikes.cfc';
const CONFIG_BEAN = 'core/mura/configBean.cfc';
const FAST_PASSWORD: LegacyPasswordConfig = { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 };
const FAST_SETTINGS: LoginSettings = { password: FAST_PASSWORD, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const PLAIN_SETTINGS: LoginSettings = { password: { encryptPasswords: false, bcryptPasswords: true }, strikes: DEFAULT_STRIKE_SETTINGS };

/** A 35-character CF UUID numbered `n` under the hex digit `prefix`. */
function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const EDITORS = id(1, 'B');
const MEMBERS = id(4, 'B');
const MISSING_GROUP = id(99, 'B');

function legacySource(path: string): string {
  return readFileSync(new URL(path, LEGACY_ROOT), 'utf8');
}

/** The literal a legacy `<cfset name=value>` assigns. */
function legacyCfset(path: string, name: string): string {
  const match = new RegExp(`<cfset ${name.replaceAll('.', '\\.')}=([^\\s/>]+)`).exec(legacySource(path));
  if (match?.[1] === undefined) throw new Error(`${path} sets no ${name}`);
  return match[1];
}

/** ColdFusion `hash(value, 'CFMX_COMPAT')` of an ASCII value: the uppercase MD5 hex. */
function cfmxCompat(value: string): string {
  return createHash('md5').update(value, 'latin1').digest('hex').toUpperCase();
}

/** `YYYY-MM-DDTHH:MM:SS.mmm` in local time. */
function wallClock(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

function groupInput(userid: string, groupname: string, siteid: string, ispublic: number): GroupInput {
  return {
    userid, groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

describe('login settings', () => {
  it('defaults to the configBean password settings, loginStrikes and the userstrikes block duration, frozen', () => {
    const flag = (name: string): boolean => legacyCfset(CONFIG_BEAN, `variables.instance.${name}`) === 'true';

    expect(DEFAULT_LOGIN_SETTINGS).toEqual({
      password: { encryptPasswords: flag('encryptPasswords'), bcryptPasswords: flag('bCryptPasswords'), javaEnabled: flag('javaEnabled') },
      strikes: {
        allowedStrikes: Number(legacyCfset(CONFIG_BEAN, 'variables.instance.loginStrikes')),
        blockedDurationMinutes: Number(legacyCfset(USER_STRIKES, 'variables.blockedDuration')),
      },
    });
    expect(Object.isFrozen(DEFAULT_LOGIN_SETTINGS)).toBe(true);
  });

  it('names the session variables legacy login sets for the block and the default password, frozen', () => {
    const source = legacySource(USER_UTILITY);

    expect(LOGIN_SESSION_KEYS).toEqual({ blockLoginUntil: 'blockLoginUntil', hasDefaultPassword: 'hasdefaultpassword' });
    expect(source).toContain(`<cfset sessionData.${LOGIN_SESSION_KEYS.blockLoginUntil}=""/>`);
    expect(source).toContain(`<cfset sessionData.${LOGIN_SESSION_KEYS.blockLoginUntil}=strikes.blockedUntil()/>`);
    expect(source).toContain(`<cfset sessionData.${LOGIN_SESSION_KEYS.hasDefaultPassword}=true>`);
    expect(Object.isFrozen(LOGIN_SESSION_KEYS)).toBe(true);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('login against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let now: Date;
  let seq = 0;
  let bcryptStored: string;
  const clock: Clock = { now: () => new Date(now.getTime()) };
  const noSleep = (): Promise<void> => Promise.resolve();

  function deps(overrides: Partial<LoginDeps> = {}): LoginDeps {
    return { db: handle.app, repo, clock, settings: FAST_SETTINGS, sleep: noSleep, ...overrides };
  }

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  function next(prefix: string): string {
    seq += 1;
    return id(seq, prefix);
  }

  function uname(label: string): string {
    seq += 1;
    return `${label}-${String(seq)}`;
  }

  function request(username: string, password: string, sessionId: string, siteId = SITE_A): LoginRequest {
    return { username, password, sessionId, mode: 'target-primary', siteId };
  }

  async function registerSite(site: string, privatePool: string, publicPool: string | null): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), publicPool === null ? null : tenantIdForSite(publicPool), NOW],
      ),
    );
  }

  async function setGate(unit: string, state: GateState): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1::text, holder_id = CASE WHEN $1::text = 'closed' THEN 'w-login' END WHERE unit = $2`, [
        state,
        unit,
      ]),
    );
  }

  interface SeedOptions {
    site?: string;
    account?: Partial<AccountInput>;
    /** The stored password; null seeds no credential, absent seeds a bcrypt hash of PASSWORD. */
    password?: string | null;
    groupIds?: string[];
    contact?: { fname: string; lname: string; email: string; company: string };
  }

  async function seedUser(username: string, opts: SeedOptions = {}): Promise<string> {
    const userId = next('A');
    const site = opts.site ?? SITE_A;
    await gated(site, async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '', ...opts.account });
      if (opts.password !== null) await repo.writeCredential(tx, userId, { password: opts.password ?? bcryptStored, passwordcreated: PASSWORD_CREATED });
      await repo.touchLastLogin(tx, userId, LAST_LOGIN);
      if (opts.groupIds !== undefined) await repo.replaceMemberships(tx, { userId, groupIds: opts.groupIds });
      if (opts.contact !== undefined) await repo.upsertPersonContact(tx, { user_id: userId, site_id: site, subtype: 'Default', aggregate_version: 1, ...opts.contact });
    });
    return userId;
  }

  async function seedStrikes(username: string, strikes: number, lastattempt: Date, site = SITE_A): Promise<void> {
    await gated(site, async (tx) => {
      await repo.ensureStrike(tx, username, lastattempt);
      await repo.setStrike(tx, username, { strikes, lastattempt });
    });
  }

  async function newSession(mode: SessionMode = 'target-primary'): Promise<{ sessionId: string; csrfSecret: string }> {
    const sessionId = `S-${uname('login')}`;
    const { csrfSecret } = await ensureSession({ db: handle.app, repo, clock }, { sessionId, mode });
    return { sessionId, csrfSecret };
  }

  function accountOf(userId: string, site = SITE_A): Promise<UserAccountRow | null> {
    return gated(site, (tx) => repo.findAccountById(tx, userId));
  }

  function credentialOf(userId: string, site = SITE_A): Promise<CredentialRow | null> {
    return gated(site, (tx) => repo.readCredential(tx, userId));
  }

  async function lastLoginOf(userId: string, site = SITE_A): Promise<Date | null> {
    return (await gated(site, (tx) => repo.findByKey<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId })))?.lastlogin ?? null;
  }

  function strikeOf(username: string, site = SITE_A): Promise<UserStrikeRow | null> {
    return gated(site, (tx) => repo.readStrike(tx, username));
  }

  function sessionOf(sessionId: string, tenantId: string): Promise<SessionRow | null> {
    return withTenant(handle.app, tenantId, (tx) => repo.findSession(tx, sessionId));
  }

  function adminStateOf(sessionId: string, tenantId: string): Promise<SessionAdminState | null> {
    return withTenant(handle.app, tenantId, (tx) => repo.readSessionAdminState(tx, sessionId));
  }

  async function openOperation(userId: string, username: string, site = SITE_A): Promise<string> {
    return (await gated(site, (tx) => repo.insertAccountOperation(tx, { user_id: userId, kind: 'update', state: 'prepared', username }))).operation_id;
  }

  async function abortOperation(operationId: string, site = SITE_A): Promise<void> {
    await gated(site, (tx) => repo.setAccountOperationState(tx, operationId, ['prepared'], 'aborted'));
  }

  beforeAll(async () => {
    now = NOW;
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    bcryptStored = await bcrypt.hash(PASSWORD, (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
    await registerSite(SITE_A, SITE_A, UMBRELLA);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA);
    await registerSite(SITE_B, SITE_B, SITE_B);
    await registerSite(SITE_C, SITE_C, null);
    await registerSite(DEFAULT, DEFAULT, DEFAULT);
    await gated(SITE_A, (tx) => repo.insertGroup(tx, groupInput(EDITORS, 'Editors', SITE_A, 0), null));
    await gated(UMBRELLA, (tx) => repo.insertGroup(tx, groupInput(MEMBERS, 'Members', UMBRELLA, 1), null));
  });

  afterAll(async () => {
    await (handle as ThrowawaySchema | undefined)?.drop();
  });

  beforeEach(() => {
    now = NOW;
  });

  describe('lookupByCredentials', () => {
    it('returns the active account of the trimmed name with its tenant and stored credential', async () => {
      const username = uname('lucy');
      const userId = await seedUser(username, { site: SITE_B });

      const found = await lookupByCredentials(deps(), `  ${username}  `, PASSWORD);

      expect(found?.tenantId).toBe(tenantIdForSite(SITE_B));
      expect(found?.account).toMatchObject({ userid: userId, username, type: 2, inactive: 0, siteid: SITE_B });
      expect(found?.credential).toMatchObject({ password: bcryptStored, passwordcreated: PASSWORD_CREATED });
    });

    it.each([
      ['a wrong password', 'active', 'Secret13'],
      ['an unknown name', 'unknown', PASSWORD],
      ['an inactive account', 'inactive', PASSWORD],
      ['an account without a stored password', 'no-password', ''],
    ] as const)('finds nothing for %s', async (_case, kind, password) => {
      const username = uname(kind);
      if (kind === 'active') await seedUser(username);
      if (kind === 'inactive') await seedUser(username, { account: { inactive: 1 } });
      if (kind === 'no-password') await seedUser(username, { password: null });

      expect(await lookupByCredentials(deps(), username, password)).toBeUndefined();
    });

    it('compares a stored plain-text password case-insensitively, as CFML eq does, when encryptPasswords is off', async () => {
      const username = uname('plain');
      const userId = await seedUser(username, { password: PASSWORD });

      expect((await lookupByCredentials(deps({ settings: PLAIN_SETTINGS }), username, PASSWORD.toUpperCase()))?.account.userid).toBe(userId);
      expect(await lookupByCredentials(deps({ settings: PLAIN_SETTINGS }), username, 'Secret13')).toBeUndefined();
      expect((await credentialOf(userId))?.password).toBe(PASSWORD);
    });

    it('checks only the first account of a shared name by site id, as legacy compares row 1 of its unordered query', async () => {
      const username = uname('twin');
      const first = await seedUser(username, { site: SITE_B });
      await seedUser(username, { site: UMBRELLA, password: cfmxCompat('Other123') });

      expect(await lookupByCredentials(deps(), username, 'Other123')).toBeUndefined();
      expect(await lookupByCredentials(deps(), username, PASSWORD)).toMatchObject({ tenantId: tenantIdForSite(SITE_B), account: { userid: first } });
    });
  });

  describe('legacy-hash upgrade', () => {
    afterEach(async () => {
      await setGate(CREDENTIAL_UNIT, 'open');
    });

    it.each([
      ['open', 'bcrypt on', FAST_PASSWORD, true],
      ['legacy', 'bcrypt on', FAST_PASSWORD, false],
      ['closed', 'bcrypt on', FAST_PASSWORD, false],
      ['open', 'bcryptPasswords off', { ...FAST_PASSWORD, bcryptPasswords: false }, false],
      ['open', 'Java off', { ...FAST_PASSWORD, javaEnabled: false }, false],
    ] as const)(
      'with the identity.credential gate %s and %s, a CFMX_COMPAT match logs in and is rewritten as bcrypt: %s',
      async (gate, _bcrypt, password, upgraded) => {
        const username = uname('md5');
        const stored = cfmxCompat(PASSWORD);
        const userId = await seedUser(username, { password: stored });
        const { sessionId } = await newSession();
        await setGate(CREDENTIAL_UNIT, gate);
        now = minutesAfter(NOW, 5);

        const result = await login(deps({ settings: { password, strikes: DEFAULT_STRIKE_SETTINGS } }), request(username, PASSWORD, sessionId));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot).toMatchObject({ password: stored, passwordcreated: wallClock(PASSWORD_CREATED) });
        const credential = await credentialOf(userId);
        if (upgraded) {
          expect(credential?.password).toMatch(/^\$2a\$04\$[./A-Za-z0-9]{53}$/);
          expect(await bcrypt.compare(PASSWORD, credential?.password ?? '')).toBe(true);
          expect(credential?.passwordcreated).toEqual(now);
        } else {
          expect(credential).toMatchObject({ password: stored, passwordcreated: PASSWORD_CREATED });
        }
      },
    );

    it('rewrites a matching CFMX_COMPAT hash even on a blocked attempt, because the lookup runs before the block check', async () => {
      const username = uname('md5-blocked');
      const userId = await seedUser(username, { password: cfmxCompat(PASSWORD) });
      await seedStrikes(username, DEFAULT_STRIKE_SETTINGS.allowedStrikes + 1, NOW);
      const { sessionId } = await newSession();

      expect(await login(deps(), request(username, PASSWORD, sessionId))).toMatchObject({ ok: false, reason: 'blocked' });
      expect((await credentialOf(userId))?.password).toMatch(/^\$2a\$04\$/);
      expect(await lastLoginOf(userId)).toEqual(LAST_LOGIN);
    });

    it.each([
      ['login', { ok: false, reason: 'invalid' }],
      ['lookupByCredentials', undefined],
    ] as const)('%s never rewrites a credential a fenced writer changed after the lookup read it, and checks the password against the change', async (entry, expected) => {
      const username = uname('md5-changed');
      const userId = await seedUser(username, { password: cfmxCompat(PASSWORD) });
      const changed = await bcrypt.hash('Changed12', (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
      let reads = 0;
      // The lookup's first credential read lets a concurrent fenced writer commit a new credential before the password check.
      const racing: IdentityRepository = {
        ...repo,
        async readCredential(tx, id) {
          const row = await repo.readCredential(tx, id);
          reads += 1;
          if (reads === 1) {
            await withOpenAccount(handle.app, TENANT_A, userId, (other) => repo.writeCredential(other, userId, { password: changed, passwordcreated: LAST_LOGIN }));
          }
          return row;
        },
      };
      const { sessionId } = await newSession();

      const outcome = entry === 'login' ? await login(deps({ repo: racing }), request(username, PASSWORD, sessionId)) : await lookupByCredentials(deps({ repo: racing }), username, PASSWORD);

      expect(outcome).toEqual(expected);
      expect(await credentialOf(userId)).toMatchObject({ password: changed, passwordcreated: LAST_LOGIN });
    });
  });

  describe('login', () => {
    it('logs the session in under its id with the login-time role list, the previous last login, a stamped LastLogin and cleared strikes', async () => {
      const username = uname('ada');
      const userId = await seedUser(username, {
        account: { remoteid: 'r-1' },
        groupIds: [EDITORS, MEMBERS, MISSING_GROUP],
        contact: { fname: 'Ada', lname: 'Lovelace', email: 'ada@example.test', company: 'Acme' },
      });
      await seedStrikes(username, 2, minutesAfter(NOW, -2));
      const anonymous = await newSession();

      const result = await login(deps(), request(username, PASSWORD, anonymous.sessionId));

      const snapshot: LoginSnapshot = {
        userid: userId,
        username,
        siteid: SITE_A,
        subtype: 'Default',
        password: bcryptStored,
        fname: 'Ada',
        lname: 'Lovelace',
        email: 'ada@example.test',
        remoteid: 'r-1',
        company: 'Acme',
        lastlogin: wallClock(LAST_LOGIN),
        passwordcreated: wallClock(PASSWORD_CREATED),
        roleList: `Editors;${SITE_A};0,Members;${UMBRELLA};1,S2IsPrivate;${SITE_A},S2IsPrivate,${username};username;${SITE_A}`,
        membershipIds: `${EDITORS},${MEMBERS},${userId}`,
      };
      const row = await sessionOf(anonymous.sessionId, SYSTEM_TENANT_ID);
      expect(result).toEqual({
        ok: true,
        hasDefaultPassword: false,
        snapshot,
        session: { sessionId: anonymous.sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2, csrfSecret: row?.csrf_secret, mode: 'target-primary' },
      });
      expect(row?.csrf_secret).not.toBe(anonymous.csrfSecret);
      expect(await sessionOf(anonymous.sessionId, TENANT_A)).toBeNull();
      expect(row).toMatchObject({ user_id: userId, site_id: SITE_A, state: 'active', epoch: '2' });
      expect(JSON.parse(row?.login_snapshot ?? 'null')).toEqual(snapshot);
      expect(await adminStateOf(anonymous.sessionId, SYSTEM_TENANT_ID)).toEqual({ blockLoginUntil: '' });
      expect(await lastLoginOf(userId)).toEqual(NOW);
      expect(await strikeOf(username)).toMatchObject({ strikes: 0, lastattempt: minutesAfter(NOW, -1) });
    });

    it.each([
      ['keeps the mode of an existing legacy-primary session', true, 'legacy-primary', 2],
      ['creates a missing session in the requested mode', false, 'target-primary', 1],
    ] as const)('%s and stores no site for siteId ""', async (_case, existing, mode, epoch) => {
      const username = uname('nosite');
      const userId = await seedUser(username);
      const sessionId = existing ? (await newSession('legacy-primary')).sessionId : `S-${uname('fresh')}`;

      const result = await login(deps(), request(username, PASSWORD, sessionId, ''));

      expect(result).toMatchObject({ ok: true, session: { sessionId, tenantId: SYSTEM_TENANT_ID, epoch, mode } });
      expect(await sessionOf(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: userId, site_id: null, mode, epoch: String(epoch) });
    });

    describe('default password', () => {
      let adminId: string;

      beforeAll(async () => {
        adminId = await seedUser('admin', { site: DEFAULT, password: 'admin' });
      });

      it.each([
        ['admin', 'admin', true],
        ['ADMIN', 'Admin', true],
        [' admin', 'admin', false],
      ] as const)('sets hasdefaultpassword for %j with password %j only when both equal "admin" case-insensitively: %s', async (username, password, expected) => {
        const { sessionId } = await newSession();

        const result = await login(deps({ settings: PLAIN_SETTINGS }), request(username, password, sessionId, DEFAULT));

        expect(result).toMatchObject({ ok: true, hasDefaultPassword: expected, snapshot: { userid: adminId } });
        expect(await adminStateOf(sessionId, SYSTEM_TENANT_ID)).toEqual(
          expected ? { blockLoginUntil: '', [LOGIN_SESSION_KEYS.hasDefaultPassword]: true } : { blockLoginUntil: '' },
        );
      });
    });

    it.each([
      ['a wrong password', 'active', 'Secret13', SITE_B],
      ['an unknown name', 'unknown', PASSWORD, UMBRELLA],
      ['an inactive account', 'inactive', PASSWORD, SITE_B],
    ] as const)('refuses %s as invalid with one strike in the tenant of the name, else the umbrella', async (_case, kind, password, strikeSite) => {
      const username = uname(kind);
      if (kind === 'active') await seedUser(username, { site: SITE_B });
      if (kind === 'inactive') await seedUser(username, { site: SITE_B, account: { inactive: 1 } });
      const { sessionId } = await newSession();

      expect(await login(deps(), request(username, password, sessionId))).toEqual({ ok: false, reason: 'invalid' });
      expect(await strikeOf(username, strikeSite)).toMatchObject({ strikes: 1, lastattempt: NOW });
      expect(await sessionOf(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: null, epoch: '1' });
      expect(await adminStateOf(sessionId, SYSTEM_TENANT_ID)).toEqual({});
    });

    it.each([
      ['the Masa defaults', DEFAULT_STRIKE_SETTINGS],
      ['two allowed strikes and a three-minute block', { allowedStrikes: 2, blockedDurationMinutes: 3 }],
    ] as const)(
      'under %s, blocks after allowedStrikes + 1 failures until blockedDurationMinutes after the last, then logs in and clears',
      async (_case, strikes) => {
        const username = uname('bo');
        const userId = await seedUser(username);
        const { sessionId } = await newSession();
        const d = deps({ settings: { password: FAST_PASSWORD, strikes } });

        for (let attempt = 1; attempt <= strikes.allowedStrikes + 1; attempt += 1) {
          now = new Date(NOW.getTime() + attempt * SECOND_MS);
          expect(await login(d, request(username, 'Secret13', sessionId))).toEqual({ ok: false, reason: 'invalid' });
          expect(await strikeOf(username)).toMatchObject({ strikes: attempt, lastattempt: now });
        }
        const lastFailure = now;
        const until = minutesAfter(lastFailure, strikes.blockedDurationMinutes);

        now = minutesAfter(lastFailure, 1);
        expect(await login(d, request(username, PASSWORD, sessionId))).toEqual({ ok: false, reason: 'blocked', blockedUntil: until });
        expect(await strikeOf(username)).toMatchObject({ strikes: strikes.allowedStrikes + 1, lastattempt: lastFailure });
        expect(await adminStateOf(sessionId, SYSTEM_TENANT_ID)).toEqual({ blockLoginUntil: wallClock(until) });
        expect(await lastLoginOf(userId)).toEqual(LAST_LOGIN);

        now = until;
        expect(await login(d, request(username, 'Secret13', sessionId))).toEqual({ ok: false, reason: 'blocked', blockedUntil: until });
        expect(await strikeOf(username)).toMatchObject({ strikes: strikes.allowedStrikes + 1, lastattempt: lastFailure });

        now = new Date(until.getTime() + SECOND_MS);
        expect(await login(d, request(username, PASSWORD, sessionId))).toMatchObject({ ok: true, session: { sessionId, tenantId: SYSTEM_TENANT_ID } });
        expect(await strikeOf(username)).toMatchObject({ strikes: 0, lastattempt: minutesAfter(now, -1) });
        expect(await adminStateOf(sessionId, SYSTEM_TENANT_ID)).toEqual({ blockLoginUntil: '' });
        expect(await lastLoginOf(userId)).toEqual(now);
      },
    );

    it('answers a blocked attempt for an unknown session without creating one', async () => {
      const username = uname('blocky');
      await seedUser(username);
      await seedStrikes(username, DEFAULT_STRIKE_SETTINGS.allowedStrikes + 1, minutesAfter(NOW, -4));
      const sessionId = `S-${uname('absent')}`;

      expect(await login(deps(), request(username, PASSWORD, sessionId))).toEqual({
        ok: false,
        reason: 'blocked',
        blockedUntil: minutesAfter(NOW, DEFAULT_STRIKE_SETTINGS.blockedDurationMinutes - 4),
      });
      expect(await sessionOf(sessionId, SYSTEM_TENANT_ID)).toBeNull();
      expect(await sessionOf(sessionId, TENANT_A)).toBeNull();
    });

    it.each([
      [UMBRELLA, SITE_A, 'ok'],
      [UMBRELLA, UMBRELLA, 'ok'],
      [SITE_C, SITE_C, 'ok'],
      [DEFAULT, 'nowhere', 'ok'],
      [UMBRELLA, '', 'public-pool'],
      [UMBRELLA, SITE_B, 'public-pool'],
      [UMBRELLA, 'nowhere', 'public-pool'],
    ] as const)('logs a public account of pool %j in on site %j only where that site reads it as its public user pool: %s', async (pool, siteId, expected) => {
      const username = uname('pub');
      const userId = await seedUser(username, { site: pool, account: { ispublic: 1 } });
      const { sessionId } = await newSession();

      const result = await login(deps(), request(username, PASSWORD, sessionId, siteId));

      if (expected === 'ok') {
        expect(result).toMatchObject({ ok: true, snapshot: { userid: userId }, session: { tenantId: SYSTEM_TENANT_ID } });
        expect(await strikeOf(username, pool)).toMatchObject({ strikes: 0 });
        expect(await lastLoginOf(userId, pool)).toEqual(NOW);
      } else {
        expect(result).toEqual({ ok: false, reason: 'public-pool' });
        expect(await strikeOf(username, pool)).toMatchObject({ strikes: 1, lastattempt: NOW });
        expect(await lastLoginOf(userId, pool)).toEqual(LAST_LOGIN);
        expect(await sessionOf(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: null });
        expect(await adminStateOf(sessionId, SYSTEM_TENANT_ID)).toEqual({});
      }
    });

    it('waits while an open account operation keeps the user closed, then logs in', async () => {
      const username = uname('olga');
      const userId = await seedUser(username);
      const operationId = await openOperation(userId, username);
      const { sessionId } = await newSession();
      const sleep = vi.fn((): Promise<void> => abortOperation(operationId));

      expect(await login(deps({ sleep }), request(username, PASSWORD, sessionId))).toMatchObject({ ok: true, snapshot: { userid: userId } });
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('fails with the legacy 503 once an open account operation keeps the user closed for the whole wait', async () => {
      const username = uname('olaf');
      const userId = await seedUser(username);
      const operationId = await openOperation(userId, username);
      const { sessionId } = await newSession();
      const waits: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        waits.push(ms);
        return Promise.resolve();
      };

      await expect(login(deps({ sleep }), request(username, PASSWORD, sessionId))).rejects.toBeInstanceOf(OperationBlockedError);
      expect(waits.reduce((total, ms) => total + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
      await abortOperation(operationId);
    });

    it.each([
      ['changes its remote id: the login uses the changed account', { remoteid: 'r-changed' }, { ok: true, snapshot: { remoteid: 'r-changed' } }],
      ['deactivates it: the login is refused as invalid', { inactive: 1 }, { ok: false, reason: 'invalid' }],
    ] as const)('decides on the account the strike transaction reads when a fenced writer, right after the lookup, %s', async (_case, change, expected) => {
      const username = uname('moved');
      const userId = await seedUser(username, { account: { remoteid: 'r-before' } });
      let reads = 0;
      // The lookup's first account read lets a concurrent fenced writer commit a change before the strike transaction.
      const racing: IdentityRepository = {
        ...repo,
        async findAccountsByUsername(tx, name, poolSiteId) {
          const rows = await repo.findAccountsByUsername(tx, name, poolSiteId);
          reads += 1;
          if (reads === 1) {
            const account = { username, type: 2, s2: 0, inactive: 0, ispublic: 0, siteid: SITE_A, remoteid: 'r-before', tablist: '', ...change };
            await withOpenAccount(handle.app, TENANT_A, userId, (other) => repo.updateAccount(other, userId, account));
          }
          return rows;
        },
      };
      const { sessionId } = await newSession();

      expect(await login(deps({ repo: racing }), request(username, PASSWORD, sessionId))).toMatchObject(expected);
      expect(await lastLoginOf(userId)).toEqual(expected.ok ? NOW : LAST_LOGIN);
    });
  });

  describe('loginByUserID', () => {
    it('logs an active account in by id without a password check, leaving its strikes as they were', async () => {
      const username = uname('uma');
      const userId = await seedUser(username, { account: { s2: 1 }, password: null });
      await seedStrikes(username, 3, minutesAfter(NOW, -2));
      const { sessionId } = await newSession();

      const result = await loginByUserID(deps(), { userId, sessionId, mode: 'target-primary', siteId: SITE_A });

      expect(result).toMatchObject({
        ok: true,
        snapshot: { userid: userId, password: '', passwordcreated: null, roleList: `S2IsPrivate;${SITE_A},S2IsPrivate,S2,${username};username;${SITE_A}` },
        session: { sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2 },
      });
      expect(await strikeOf(username)).toMatchObject({ strikes: 3, lastattempt: minutesAfter(NOW, -2) });
      expect(await lastLoginOf(userId)).toEqual(NOW);
    });

    it.each([
      ['an unknown id', 'unknown'],
      ['an inactive account', 'inactive'],
      ['a group', 'group'],
    ] as const)('refuses %s as invalid', async (_case, kind) => {
      const userId = kind === 'group' ? EDITORS : kind === 'inactive' ? await seedUser(uname('idle'), { account: { inactive: 1 } }) : next('A');
      const { sessionId } = await newSession();

      expect(await loginByUserID(deps(), { userId, sessionId, mode: 'target-primary', siteId: SITE_A })).toEqual({ ok: false, reason: 'invalid' });
      expect(await sessionOf(sessionId, SYSTEM_TENANT_ID)).toMatchObject({ user_id: null });
    });

    it.each([
      [DEFAULT, '', 'ok'],
      [DEFAULT, 'nowhere', 'ok'],
      [UMBRELLA, SITE_A, 'ok'],
      [UMBRELLA, '', 'public-pool'],
      [UMBRELLA, SITE_B, 'public-pool'],
    ] as const)('logs a public account of pool %j in on site %j, an empty site reading the default site: %s', async (pool, siteId, expected) => {
      const userId = await seedUser(uname('member'), { site: pool, account: { ispublic: 1 } });
      const { sessionId } = await newSession();

      const result = await loginByUserID(deps(), { userId, sessionId, mode: 'target-primary', siteId });

      if (expected === 'ok') {
        expect(result).toMatchObject({ ok: true, snapshot: { userid: userId }, session: { tenantId: SYSTEM_TENANT_ID } });
        expect(await lastLoginOf(userId, pool)).toEqual(NOW);
      } else {
        expect(result).toEqual({ ok: false, reason: 'public-pool' });
      }
    });

    it('re-reads the account after the closed-user wait and refuses one deactivated meanwhile', async () => {
      const username = uname('vera');
      const userId = await seedUser(username);
      const operationId = await openOperation(userId, username);
      const { sessionId } = await newSession();
      const sleep = vi.fn(async (): Promise<void> => {
        await gated(SITE_A, (tx) =>
          repo.updateAccount(tx, userId, { username, type: 2, s2: 0, inactive: 1, ispublic: 0, siteid: SITE_A, remoteid: '', tablist: '' }),
        );
        await abortOperation(operationId);
      });

      expect(await loginByUserID(deps({ sleep }), { userId, sessionId, mode: 'target-primary', siteId: SITE_A })).toEqual({ ok: false, reason: 'invalid' });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(await lastLoginOf(userId)).toEqual(LAST_LOGIN);
    });
  });

  describe('loginByQuery', () => {
    it.each([
      ['the credential the caller read', 'given', 'caller-read', null],
      ['no credential row the caller read', 'none', '', null],
      ['the stored credential when the caller passes none', 'omitted', 'stored', wallClock(PASSWORD_CREATED)],
    ] as const)('builds the snapshot password from %s', async (_case, source, password, passwordcreated) => {
      const userId = await seedUser(uname('quinn'));
      const account = await accountOf(userId);
      if (account === null) throw new Error(`seeded account ${userId} is missing`);
      const { sessionId } = await newSession();
      const credential: CredentialRow | null | undefined =
        source === 'given' ? { tenant_id: TENANT_A, userid: userId, password: 'caller-read', passwordcreated: null } : source === 'none' ? null : undefined;

      const result = await loginByQuery(deps(), { sessionId, mode: 'target-primary', siteId: SITE_A, tenantId: TENANT_A, account, credential });

      expect(result.snapshot).toMatchObject({ password: password === 'stored' ? bcryptStored : password, passwordcreated, lastlogin: wallClock(LAST_LOGIN) });
      expect(result.session).toMatchObject({ sessionId, tenantId: SYSTEM_TENANT_ID, epoch: 2 });
      expect(await lastLoginOf(userId)).toEqual(NOW);
    });

    it.each([
      ['a private super user', SITE_A, { s2: 1 }, (name: string) => `S2IsPrivate;${SITE_A},S2IsPrivate,S2,${name};username;${SITE_A}`],
      ['a public member', UMBRELLA, { ispublic: 1 }, (name: string) => `S2IsPublic;${UMBRELLA},S2IsPublic,${name};username;${UMBRELLA}`],
    ] as const)('lists the pool marker pair, S2 and the username entry for %s', async (_case, site, flags, roleList) => {
      const username = uname('rolf');
      const userId = await seedUser(username, { site, account: flags });
      const account = await accountOf(userId, site);
      if (account === null) throw new Error(`seeded account ${userId} is missing`);
      const { sessionId } = await newSession();

      const result = await loginByQuery(deps(), { sessionId, mode: 'target-primary', siteId: site, tenantId: tenantIdForSite(site), account });

      expect(result.snapshot).toMatchObject({ roleList: roleList(username), membershipIds: userId, subtype: 'Default', fname: '', lname: '', email: '', company: '' });
    });
  });

  describe('logout', () => {
    it('ends a logged-in session under its id with the next epoch, the anonymous snapshot and no session-scope values', async () => {
      const username = uname('lou');
      await seedUser(username);
      const { sessionId } = await newSession();
      const loggedIn = await login(deps(), request(username, PASSWORD, sessionId));
      if (!loggedIn.ok) throw new Error(`login of ${username} answered ${loggedIn.reason}`);
      now = minutesAfter(NOW, 30);

      expect(await logout(deps(), sessionId)).toEqual({ epoch: loggedIn.session.epoch + 1 });

      const row = await sessionOf(sessionId, SYSTEM_TENANT_ID);
      expect(row).toMatchObject({ state: 'ended', user_id: null, site_id: null, admin_state: null, ended_at: now, epoch: String(loggedIn.session.epoch + 1) });
      expect(JSON.parse(row?.login_snapshot ?? 'null')).toEqual(ANONYMOUS_LOGIN_SNAPSHOT);
      expect(await logout(deps(), sessionId)).toEqual({ epoch: loggedIn.session.epoch + 1 });
    });

    it('answers epoch 0 for an unknown session', async () => {
      expect(await logout(deps(), `S-${uname('never')}`)).toEqual({ epoch: 0 });
    });
  });
});
