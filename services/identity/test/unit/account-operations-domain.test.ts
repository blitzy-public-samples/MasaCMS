/** Roster account operations against a throwaway `identity` schema: prepare's legacy save rules and validation, commit, abort, revert, finish with re-login, status reads and the closed-user wait. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, openOperations, registerOperation, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { createCapturingPublisher, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  ACCOUNT_OPERATION_UNITS,
  DEFAULT_ACCOUNT_SETTINGS,
  EN_ACCOUNT_MESSAGES,
  OperationBlockedError,
  USER_CLOSED_WAIT_MS,
  abortAccountOperation,
  accountOperationStatus,
  awaitAccountOpen,
  commitAccountOperation,
  finishAccountOperation,
  operationStatus,
  prepareAccountOperation,
  revertAccountOperation,
  type AccountChange,
  type AccountOperationDeps,
  type AccountSettings,
  type CommitInput,
  type PrepareInput,
  type PrepareResult,
} from '../../src/domain/account-operations.js';
import { applyLogin, endSession } from '../../src/domain/sessions.js';
import { createIdentityEvents, identityPayloadValidators, MEMBERSHIP_CHANGED_TOPIC } from '../../src/events/publish.js';
import { verifyLegacyPassword } from '../../src/legacy/hash.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import {
  IDENTITY_UNITS,
  LOGIN_STATE,
  type AccountOperationKind,
  type AccountOperationRow,
  type LoginSnapshot,
  type LoginStateRow,
  type SessionRow,
  type UserAccountRow,
} from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const LATER = new Date(2026, 5, 30, 13, 30, 0, 0);
const PASSWORD_CREATED = new Date(2026, 5, 1, 9, 15, 0, 0);
const LAST_LOGIN = new Date(2026, 5, 30, 9, 15, 0, 120);
const STORED_HASH = 'stored-hash';
const SITE_A = 'tenant-a';
const UMBRELLA = 'umbrella';
const SITE_B = 'tenant-b';
const SITE_C = 'tenant-c';
const CHAIN = 'chain';
const TENANT_A = tenantIdForSite(SITE_A);
const LEGACY_ROOT = new URL('../../../../', import.meta.url);

/** A 35-character CF UUID numbered `n` under the hex digit `prefix`. */
function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const EDITORS = id(1, 'B');
const AUTHORS = id(2, 'B');
const MEMBERS = id(4, 'B');
const B_STAFF = id(5, 'B');
const MISSING_GROUP = id(99, 'B');

/** The value of `key` in a Java properties file of the legacy tree. */
function legacyProperty(path: string, key: string): string {
  const line = readFileSync(new URL(path, LEGACY_ROOT), 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`${path} has no ${key}`);
  return line.slice(key.length + 1);
}

const EN_PROPERTIES = 'core/mura/resourceBundle/resources/en.properties';
const SETTINGS_TEMPLATE = 'core/templates/settings.template.cfm';
const STRENGTH_MESSAGE = legacyProperty(EN_PROPERTIES, 'user.passwordstrengthvalidate');

/** `messageFormat` of the legacy username message: quotes are literal, `{1}` is the first comma item of the name. */
function usernameMessage(name: string): string {
  return `The username '${name}' that you entered is being used by another user.`;
}

function groupInput(overrides: Partial<GroupInput>): GroupInput {
  return {
    groupname: 'Editors', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE_A,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...overrides,
  };
}

describe('account operation settings', () => {
  it('waits up to 10 s for a closed user and gates the account units the protocol writes', () => {
    expect(USER_CLOSED_WAIT_MS).toBe(10_000);
    expect([...ACCOUNT_OPERATION_UNITS]).toEqual(['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership']);
    expect(ACCOUNT_OPERATION_UNITS.every((unit) => (IDENTITY_UNITS as readonly string[]).includes(unit))).toBe(true);
  });

  it('defaults to the Masa password settings and the en resource-bundle texts', () => {
    expect(DEFAULT_ACCOUNT_SETTINGS).toEqual({
      password: { encryptPasswords: true, bcryptPasswords: true, javaEnabled: true },
      strongPasswords: legacyProperty(SETTINGS_TEMPLATE, 'strongpasswords') === 'true',
      strongPasswordRegex: legacyProperty(SETTINGS_TEMPLATE, 'strongpasswordregex'),
    });
    expect(Object.isFrozen(DEFAULT_ACCOUNT_SETTINGS)).toBe(true);
    expect(EN_ACCOUNT_MESSAGES).toEqual({
      'user.usernamevalidate': legacyProperty(EN_PROPERTIES, 'user.usernamevalidate'),
      'user.passwordstrengthvalidate': STRENGTH_MESSAGE,
    });
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('account operations against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let now: Date;
  let seq = 0;
  const clock: Clock = { now: () => new Date(now.getTime()) };
  const capture = createCapturingPublisher();
  // Four bcrypt rounds keep the suite fast; the stored value is still a jBCrypt $2a$ hash.
  const fastSettings: AccountSettings = {
    ...DEFAULT_ACCOUNT_SETTINGS,
    password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 },
  };
  const noSleep = async (): Promise<void> => undefined;

  function deps(overrides: Partial<AccountOperationDeps> = {}): AccountOperationDeps {
    return { db: handle.app, repo, events: createIdentityEvents(repo), clock, settings: fastSettings, sleep: noSleep, ...overrides };
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
    return `${label}-${seq}`;
  }

  function change(overrides: Partial<AccountChange>): AccountChange {
    return { username: uname('user'), password: '', s2: 0, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: null, ...overrides };
  }

  function input(kind: AccountOperationKind, userId: string, changes: Partial<AccountChange>, overrides: Partial<PrepareInput> = {}): PrepareInput {
    return { operationId: next('C'), kind, userId, requestSiteId: SITE_A, siteId: SITE_A, actorIsSuperUser: false, change: change(changes), ...overrides };
  }

  async function prepared(prepare: PrepareInput, d: AccountOperationDeps = deps()): Promise<PrepareInput> {
    const result = await prepareAccountOperation(d, prepare);
    expect(result.outcome).toBe('prepared');
    return prepare;
  }

  async function committed(prepare: PrepareInput, commit: CommitInput = {}): Promise<string> {
    await prepared(prepare);
    const outcome = await commitAccountOperation(deps(), prepare.operationId, commit);
    if (outcome.outcome !== 'committed') throw new Error(`commit of ${prepare.operationId} answered ${outcome.outcome}`);
    return outcome.result.writePosition;
  }

  async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), NOW],
      ),
    );
  }

  interface SeedOptions {
    site?: string;
    account?: Partial<AccountInput>;
    /** Null seeds no credential. */
    password?: string | null;
    /** Null seeds no login state. */
    lastlogin?: Date | null;
    groupIds?: string[];
  }

  async function seedUser(username: string, opts: SeedOptions = {}): Promise<string> {
    const userId = next('A');
    const site = opts.site ?? SITE_A;
    await gated(site, async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '', ...opts.account });
      if (opts.password !== null) await repo.writeCredential(tx, userId, { password: opts.password ?? STORED_HASH, passwordcreated: PASSWORD_CREATED });
      if (opts.lastlogin !== null) await repo.touchLastLogin(tx, userId, opts.lastlogin ?? LAST_LOGIN);
      if (opts.groupIds !== undefined) await repo.replaceMemberships(tx, { userId, groupIds: opts.groupIds });
    });
    return userId;
  }

  function accountOf(userId: string, site = SITE_A): Promise<UserAccountRow | null> {
    return gated(site, (tx) => repo.findAccountById(tx, userId, { includePending: true }));
  }

  function credentialOf(userId: string, site = SITE_A): Promise<{ password: string | null; passwordcreated: Date | null } | null> {
    return gated(site, (tx) => repo.readCredential(tx, userId));
  }

  function loginStateOf(userId: string, site = SITE_A): Promise<LoginStateRow | null> {
    return gated(site, (tx) => repo.findByKey<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId }));
  }

  function membershipsOf(userId: string, site = SITE_A): Promise<string[]> {
    return gated(site, (tx) => repo.membershipGroupIds(tx, userId));
  }

  function operationOf(operationId: string, site = SITE_A): Promise<AccountOperationRow | null> {
    return gated(site, (tx) => repo.findAccountOperation(tx, operationId));
  }

  function sessionOf(sessionId: string, site = SITE_A): Promise<SessionRow | null> {
    return withTenant(handle.app, tenantIdForSite(site), (tx) => repo.findSession(tx, sessionId));
  }

  async function registered(operationId: string): Promise<boolean> {
    return (await openOperations(handle.app)).some((op) => op.operationId === operationId);
  }

  async function eventsOf(operationId: string, site = SITE_A): Promise<Array<{ topic: string; held: boolean; payload: unknown }>> {
    return withTenant(handle.app, tenantIdForSite(site), async (tx) => {
      const { rows } = await tx.query<{ topic: string; held: boolean; payload: unknown }>(
        `SELECT topic, held, envelope->'payload' AS payload FROM ${handle.schema}.outbox WHERE operation_id = $1 ORDER BY seq`,
        [operationId],
      );
      return rows;
    });
  }

  /** The repository with `insertAccountOperation` held until two callers reach it, so both checked the user as open first. */
  function latchedOperationInserts(): IdentityRepository {
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      ...repo,
      async insertAccountOperation(tx, row, ctx) {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return repo.insertAccountOperation(tx, row, ctx);
      },
    };
  }

  beforeAll(async () => {
    now = NOW;
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: capture, logger, clock, payloadValidators: identityPayloadValidators });
    await registerSite(SITE_A, SITE_A, UMBRELLA);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA);
    await registerSite(SITE_B, SITE_B, SITE_B);
    await registerSite(SITE_C, SITE_C, CHAIN);
    await registerSite(CHAIN, CHAIN, UMBRELLA);
    await gated(SITE_A, async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: EDITORS, groupname: 'Editors' }), null);
      await repo.insertGroup(tx, groupInput({ userid: AUTHORS, groupname: 'Authors' }), null);
    });
    await gated(UMBRELLA, (tx) => repo.insertGroup(tx, groupInput({ userid: MEMBERS, groupname: 'Members', ispublic: 1, siteid: UMBRELLA }), null));
    await gated(SITE_B, (tx) => repo.insertGroup(tx, groupInput({ userid: B_STAFF, groupname: 'Staff', siteid: SITE_B }), null));
    await seedUser('bea', { site: SITE_B });
    await seedUser('dup,name', { site: SITE_B });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    now = NOW;
  });

  describe('prepareAccountOperation', () => {
    it('reserves a create as a pending account that cannot log in, with trimmed values and the posted password hashed', async () => {
      const userId = next('A');
      const username = uname('newbie');
      const prepare = input('create', userId, {
        username: `  ${username}  `,
        password: ' Secret12 ',
        perm: 1,
        remoteID: ' r-9 ',
        tablist: ' Basic ',
        groupIds: [EDITORS],
      });

      const result = await prepareAccountOperation(deps(), prepare);

      expect(result).toEqual({ outcome: 'prepared', operation: { operationId: prepare.operationId, userId, kind: 'create', state: 'prepared', before: null } });
      expect(await accountOf(userId)).toMatchObject({
        username, type: 2, admin: null, s2: 0, perm: 1, inactive: 0, ispublic: 0, siteid: SITE_A, remoteid: 'r-9', tablist: 'Basic', opt2_state: 'pending',
      });
      expect(await gated(SITE_A, (tx) => repo.findAccountById(tx, userId))).toBeNull();
      expect(await gated(SITE_A, (tx) => repo.findAccountByUsername(tx, username))).toBeNull();
      expect(await credentialOf(userId)).toBeNull();
      const row = await operationOf(prepare.operationId);
      expect(row).toMatchObject({ user_id: userId, kind: 'create', state: 'prepared', username, before_values: null, commit_xid: null });
      expect(row?.pending_change).not.toContain('Secret12');
      const pending = JSON.parse(row?.pending_change ?? '{}') as { credential: { password: string } };
      expect(pending.credential.password).toMatch(/^\$2a\$04\$/);
      expect(await verifyLegacyPassword('Secret12', pending.credential.password, fastSettings.password)).toEqual({ match: true, needsUpgrade: false });
      const registration = (await openOperations(handle.app)).find((op) => op.operationId === prepare.operationId);
      expect(registration).toMatchObject({ kind: 'roster-account' });
      expect([...(registration?.units ?? [])].sort()).toEqual([...ACCOUNT_OPERATION_UNITS].sort());
    });

    it('records an update with the before-image of the account, credential date, last login and memberships, never the stored password', async () => {
      const username = uname('ursula');
      const userId = await seedUser(username, { account: { perm: 1, remoteid: 'r-old', tablist: 'Old' }, groupIds: [EDITORS, B_STAFF] });
      const prepare = input('update', userId, { username: uname('renamed') });

      const result = await prepareAccountOperation(deps(), prepare);

      expect(result).toEqual({
        outcome: 'prepared',
        operation: {
          operationId: prepare.operationId,
          userId,
          kind: 'update',
          state: 'prepared',
          before: {
            account: {
              userid: userId, username, type: 2, admin: null, s2: 0, perm: 1, inactive: 0, ispublic: 0, siteid: SITE_A, remoteid: 'r-old', tablist: 'Old',
              passwordcreated: PASSWORD_CREATED.toISOString(), lastlogin: LAST_LOGIN.toISOString(),
            },
            groupIds: [EDITORS, B_STAFF],
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain(STORED_HASH);
      expect(await accountOf(userId)).toMatchObject({ username, opt2_state: 'active' });
    });

    it("answers a repeated prepare with the recorded operation and another user's prepare of that id with a conflict", async () => {
      const userId = await seedUser(uname('repeat'));
      const prepare = await prepared(input('update', userId, { username: uname('repeat2') }));
      const first = await accountOperationStatus(deps(), prepare.operationId);

      expect(await prepareAccountOperation(deps(), prepare)).toEqual({ outcome: 'prepared', operation: first });
      expect(await prepareAccountOperation(deps(), { ...prepare, userId: next('A') })).toEqual({ outcome: 'conflict', operation: first });
    });

    it.each([
      ['a private save', { isPublic: 0 }, SITE_A, 0],
      ['a public save', { isPublic: 1 }, UMBRELLA, 1],
      ['a switchToPublic save', { isPublic: 0, switchToPublic: true }, UMBRELLA, 1],
      ['a switchToPrivate save', { isPublic: 1, switchToPrivate: true }, SITE_A, 0],
    ] as const)('stores %s in the request site user pool its visibility picks', async (_label, visibility, pool, isPublic) => {
      const userId = next('A');

      await prepared(input('create', userId, visibility, { siteId: pool }));

      expect(await accountOf(userId, pool)).toMatchObject({ siteid: pool, ispublic: isPublic, opt2_state: 'pending' });
    });

    it.each([
      ['keeps S2 for a super user and makes the account private in the pool its posted visibility picked', true, 1, 0],
      ['drops S2 for a caller who is not a super user', false, 0, 1],
    ] as const)('%s', async (_label, actorIsSuperUser, s2, isPublic) => {
      const userId = next('A');

      await prepared(input('create', userId, { s2: 1, isPublic: 1 }, { siteId: UMBRELLA, actorIsSuperUser }));

      expect(await accountOf(userId, UMBRELLA)).toMatchObject({ siteid: UMBRELLA, s2, ispublic: isPublic });
    });

    it.each([
      ['a pool site other than the one the visibility picks', 'create', false, { requestSiteId: SITE_A, siteId: SITE_A }, { isPublic: 1 }],
      ['an unregistered request site', 'create', false, { requestSiteId: 'nowhere', siteId: 'nowhere' }, {}],
      ['a create of an existing account', 'create', true, {}, {}],
      ['an update of a missing account', 'update', false, {}, {}],
    ] as const)('rejects %s as badRequest and leaves no operation behind', async (_label, kind, existing, overrides, changes) => {
      const username = uname('bad');
      const userId = existing ? await seedUser(username) : next('A');
      const prepare = input(kind, userId, changes, overrides);

      await expect(prepareAccountOperation(deps(), prepare)).rejects.toMatchObject({ name: 'LegacyApiError', type: 'badRequest' });

      expect(await operationOf(prepare.operationId)).toBeNull();
      expect(await registered(prepare.operationId)).toBe(false);
      expect((await accountOf(userId))?.username ?? null).toBe(existing ? username : null);
    });

    it.each([
      ['held by an account of another tenant', 'bea', usernameMessage('bea')],
      ['held in another case and padded', '  BEA ', usernameMessage('BEA')],
      ['a comma list, formatted by its first item', 'dup,name', usernameMessage('dup')],
      ['blank', '   ', usernameMessage('{1}')],
    ])('answers a username %s with the legacy username error and records nothing', async (_label, username, message) => {
      const userId = next('A');
      const prepare = input('create', userId, { username });

      expect(await prepareAccountOperation(deps(), prepare)).toEqual({ outcome: 'invalid', errors: { username: message } });

      expect(await operationOf(prepare.operationId)).toBeNull();
      expect(await registered(prepare.operationId)).toBe(false);
      expect(await accountOf(userId)).toBeNull();
    });

    it("answers a username another user's open operation is renaming to with the username error until that operation ends", async () => {
      const taken = uname('zed');
      const holder = await seedUser(uname('holder'));
      const rename = await prepared(input('update', holder, { username: taken }));
      const userId = next('A');

      expect(await prepareAccountOperation(deps(), input('create', userId, { username: taken.toUpperCase() }))).toEqual({
        outcome: 'invalid',
        errors: { username: usernameMessage(taken.toUpperCase()) },
      });
      await abortAccountOperation(deps(), rename.operationId);
      expect((await prepareAccountOperation(deps(), input('create', userId, { username: taken }))).outcome).toBe('prepared');
    });

    it.each([
      ['a password the strength regex refuses', 'abcdefg', { password: STRENGTH_MESSAGE }],
      ['a password equal to the username in another case', 'STRONG1X', { password: STRENGTH_MESSAGE }],
      ['a strong password', 'Secret12', null],
      ['a blank password, which skips the check', '', null],
    ] as const)('checks %s under strongPasswords', async (_label, password, errors) => {
      const strong = deps({ settings: { ...fastSettings, strongPasswords: true } });
      const username = `Strong1x-${next('A').slice(-4)}`;
      const prepare = input('create', next('A'), { username: password === 'STRONG1X' ? 'strong1x' : username, password });

      const result = await prepareAccountOperation(strong, prepare);

      expect(result).toEqual(errors === null ? expect.objectContaining({ outcome: 'prepared' }) : { outcome: 'invalid', errors });
    });

    it('reports the password error before the username error, in the texts of the pool site resource bundle', async () => {
      const lookups: string[] = [];
      const rb = (siteId: string, key: string): string => {
        lookups.push(`${siteId}:${key}`);
        return key === 'user.usernamevalidate' ? `[${siteId}] '{1}' taken` : `[${siteId}] weak`;
      };
      const strong = deps({ settings: { ...fastSettings, strongPasswords: true }, rb });

      const result = (await prepareAccountOperation(strong, input('create', next('A'), { username: 'bea', password: 'weak', isPublic: 1 }, { siteId: UMBRELLA }))) as Extract<
        PrepareResult,
        { outcome: 'invalid' }
      >;

      expect(result).toEqual({ outcome: 'invalid', errors: { password: `[${UMBRELLA}] weak`, username: `[${UMBRELLA}] 'bea' taken` } });
      expect(Object.keys(result.errors)).toEqual(['password', 'username']);
      expect(lookups).toEqual([`${UMBRELLA}:user.passwordstrengthvalidate`, `${UMBRELLA}:user.usernamevalidate`]);
    });

    it('answers the legacy 503 when another open operation keeps the user closed for the whole wait', async () => {
      const userId = await seedUser(uname('closed'));
      await prepared(input('update', userId, {}));
      const sleeps: number[] = [];
      const waiting = deps({ sleep: async (ms) => void sleeps.push(ms) });
      const second = input('update', userId, {});

      await expect(prepareAccountOperation(waiting, second)).rejects.toBeInstanceOf(OperationBlockedError);

      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
      expect(await operationOf(second.operationId)).toBeNull();
      expect(await registered(second.operationId)).toBe(false);
    });

    it("lets concurrent prepares of one operation both answer with the winner's record", async () => {
      const userId = await seedUser(uname('twin'));
      const racing = deps({ repo: latchedOperationInserts() });
      const prepare = input('update', userId, { username: uname('twin2') });

      const results = await Promise.all([prepareAccountOperation(racing, prepare), prepareAccountOperation(racing, prepare)]);

      const recorded = await accountOperationStatus(deps(), prepare.operationId);
      expect(results).toEqual([
        { outcome: 'prepared', operation: recorded },
        { outcome: 'prepared', operation: recorded },
      ]);
      expect(await registered(prepare.operationId)).toBe(true);
    });

    it('closes the user to the loser of two concurrent prepares and drops its registration', async () => {
      const userId = await seedUser(uname('duel'));
      const racing = deps({ repo: latchedOperationInserts() });
      const left = input('update', userId, { username: uname('left') });
      const right = input('update', userId, { username: uname('right') });

      const results = await Promise.allSettled([prepareAccountOperation(racing, left), prepareAccountOperation(racing, right)]);

      const winner = results.findIndex((result) => result.status === 'fulfilled');
      const loser = results[1 - winner];
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(loser?.status).toBe('rejected');
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(OperationBlockedError);
      const [won, lost] = winner === 0 ? [left, right] : [right, left];
      expect((await operationOf(won.operationId))?.state).toBe('prepared');
      expect(await operationOf(lost.operationId)).toBeNull();
      expect(await registered(won.operationId)).toBe(true);
      expect(await registered(lost.operationId)).toBe(false);
    });
  });

  describe('commitAccountOperation', () => {
    it('commits a create: activates the account, adds its login state, credential and memberships, and holds the membership event', async () => {
      const userId = next('A');
      const prepare = input('create', userId, { password: 'Secret12', groupIds: [AUTHORS, EDITORS] });
      await prepared(prepare);
      now = LATER;

      const outcome = await commitAccountOperation(deps(), prepare.operationId, { userId });

      const row = await operationOf(prepare.operationId);
      expect(outcome).toEqual({ outcome: 'committed', result: { operationId: prepare.operationId, userId, state: 'committed', writePosition: row?.commit_xid } });
      expect(row?.commit_xid).toMatch(/^\d+$/);
      expect(await accountOf(userId)).toMatchObject({ opt2_state: 'active', username: prepare.change.username });
      expect(await loginStateOf(userId)).toMatchObject({ lastlogin: null });
      const credential = await credentialOf(userId);
      expect(credential?.passwordcreated).toEqual(LATER);
      expect((await verifyLegacyPassword('Secret12', credential?.password, fastSettings.password)).match).toBe(true);
      expect(await membershipsOf(userId)).toEqual([EDITORS, AUTHORS]);
      expect(await eventsOf(prepare.operationId)).toEqual([
        { topic: MEMBERSHIP_CHANGED_TOPIC, held: true, payload: { userId, siteId: SITE_A, groupIds: [EDITORS, AUTHORS] } },
      ]);
      expect(await registered(prepare.operationId)).toBe(true);
      expect((await accountOperationStatus(deps(), prepare.operationId)).state).toBe('committed');
      await expect(awaitAccountOpen(handle.app, TENANT_A, userId, { sleep: noSleep })).rejects.toBeInstanceOf(OperationBlockedError);
    });

    it('gives a create posted without a password a random 12-character alphanumeric one', async () => {
      const plain = deps({ settings: { ...fastSettings, password: { encryptPasswords: false, bcryptPasswords: false } } });
      const passwords: Array<string | null | undefined> = [];
      for (const userId of [next('A'), next('A')]) {
        const prepare = await prepared(input('create', userId, { password: '' }), plain);
        await commitAccountOperation(plain, prepare.operationId);
        passwords.push((await credentialOf(userId))?.password);
      }

      for (const password of passwords) expect(password).toMatch(/^[a-zA-Z0-9]{12}$/);
      expect(passwords[0]).not.toBe(passwords[1]);
    });

    it('keeps only the public groups of its pool site for a public account', async () => {
      const userId = next('A');
      const prepare = input('create', userId, { isPublic: 1, groupIds: [EDITORS, MEMBERS] }, { siteId: UMBRELLA });

      await committed(prepare);

      expect(await membershipsOf(userId, UMBRELLA)).toEqual([MEMBERS]);
      expect(await eventsOf(prepare.operationId, UMBRELLA)).toEqual([
        { topic: MEMBERSHIP_CHANGED_TOPIC, held: true, payload: { userId, siteId: UMBRELLA, groupIds: [MEMBERS] } },
      ]);
    });

    it('commits an update of the columns userDAO.update writes, leaving Perm, a blank password and unposted memberships as stored', async () => {
      const userId = await seedUser(uname('ulla'), { account: { perm: 1, remoteid: 'r-old', tablist: 'Old' }, groupIds: [EDITORS] });
      const username = uname('ulla2');
      const prepare = input('update', userId, { username, perm: 0, inActive: 1, remoteID: 'r-new', password: '' });

      await committed(prepare);

      expect(await accountOf(userId)).toMatchObject({ username, type: 2, s2: 0, perm: 1, inactive: 1, ispublic: 0, siteid: SITE_A, remoteid: 'r-new', tablist: 'Old' });
      expect(await credentialOf(userId)).toMatchObject({ password: STORED_HASH, passwordcreated: PASSWORD_CREATED });
      expect(await loginStateOf(userId)).toMatchObject({ lastlogin: LAST_LOGIN });
      expect(await membershipsOf(userId)).toEqual([EDITORS]);
      expect(await eventsOf(prepare.operationId)).toEqual([]);
    });

    it('stores a password posted with an update and dates it at the commit', async () => {
      const userId = await seedUser(uname('pw'));
      const prepare = input('update', userId, { password: 'Fresh123' });
      await prepared(prepare);
      now = LATER;

      await commitAccountOperation(deps(), prepare.operationId);

      const credential = await credentialOf(userId);
      expect(credential?.passwordcreated).toEqual(LATER);
      expect((await verifyLegacyPassword('Fresh123', credential?.password, fastSettings.password)).match).toBe(true);
    });

    it.each([
      ['keeps the stored tablist when none is posted', undefined, 'Old'],
      ['clears the tablist when posted as null', null, null],
      ['stores a posted tablist trimmed', ' Basic,Extended ', 'Basic,Extended'],
    ] as const)('%s', async (_label, tablist, stored) => {
      const userId = await seedUser(uname('tabs'), { account: { tablist: 'Old' } });

      await committed(input('update', userId, tablist === undefined ? {} : { tablist }));

      expect((await accountOf(userId))?.tablist).toBe(stored);
    });

    it.each([
      ['replaces every membership by default', [EDITORS, B_STAFF], { groupIds: [AUTHORS] }, [AUTHORS], true],
      ['leaves memberships as stored without updateGroups', [EDITORS], { groupIds: [AUTHORS], updateGroups: false }, [EDITORS], false],
      ['spares the groups of other sites under an originID', [EDITORS, B_STAFF], { groupIds: [AUTHORS], originID: SITE_A }, [AUTHORS, B_STAFF], true],
      ['replaces every membership under a blank originID', [EDITORS, B_STAFF], { groupIds: [AUTHORS], originID: '' }, [AUTHORS], true],
      ['adds the posted groups under an originID when none are held', [], { groupIds: [AUTHORS], originID: SITE_A }, [AUTHORS], true],
      ['publishes nothing when the posted groups equal the held ones', [AUTHORS, EDITORS], { groupIds: [EDITORS, AUTHORS] }, [EDITORS, AUTHORS], false],
    ] as const)('%s on an update', async (_label, held, posted, expected, published) => {
      const userId = await seedUser(uname('memb'), { groupIds: [...held] });
      const prepare = input('update', userId, { ...posted, groupIds: [...posted.groupIds] });

      await committed(prepare);

      expect(await membershipsOf(userId)).toEqual(expected);
      expect(await eventsOf(prepare.operationId)).toEqual(
        published ? [{ topic: MEMBERSHIP_CHANGED_TOPIC, held: true, payload: { userId, siteId: SITE_A, groupIds: expected } }] : [],
      );
    });

    it('answers a repeated commit, and a commit after finish, with the recorded write position', async () => {
      const userId = await seedUser(uname('again'));
      const prepare = input('update', userId, {});
      const position = await committed(prepare);
      const expected = { outcome: 'committed', result: { operationId: prepare.operationId, userId, state: 'committed', writePosition: position } };

      expect(await commitAccountOperation(deps(), prepare.operationId)).toEqual(expected);
      await finishAccountOperation(deps(), prepare.operationId);
      expect(await commitAccountOperation(deps(), prepare.operationId, { userId })).toEqual(expected);
    });

    it("refuses to commit an unknown, aborted or another user's operation", async () => {
      const userId = await seedUser(uname('refuse'));
      const prepare = await prepared(input('update', userId, {}));
      const unknown = next('C');
      const stranger = next('A');

      expect(await commitAccountOperation(deps(), unknown, { userId })).toEqual({ outcome: 'conflict', operation: { operationId: unknown, userId, state: 'unknown' } });
      expect(await commitAccountOperation(deps(), unknown)).toEqual({ outcome: 'conflict', operation: { operationId: unknown, userId: '', state: 'unknown' } });
      expect(await commitAccountOperation(deps(), prepare.operationId, { userId: stranger })).toMatchObject({
        outcome: 'conflict',
        operation: { operationId: prepare.operationId, userId, state: 'prepared' },
      });
      await abortAccountOperation(deps(), prepare.operationId);
      expect(await commitAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { state: 'aborted' } });
      expect(await accountOf(userId)).toMatchObject({ opt2_state: 'active' });
    });

    it('answers a commit that lost the state change to a concurrent abort with the state the abort left', async () => {
      const username = uname('race');
      const userId = await seedUser(username);
      const prepare = await prepared(input('update', userId, { username: uname('race2') }));
      let raced = false;
      const racing: IdentityRepository = {
        ...repo,
        async setAccountOperationState(tx, operationId, from, to, patch, ctx) {
          if (!raced) {
            raced = true;
            await abortAccountOperation(deps(), operationId);
          }
          return repo.setAccountOperationState(tx, operationId, from, to, patch, ctx);
        },
      };

      const outcome = await commitAccountOperation(deps({ repo: racing }), prepare.operationId);

      expect(outcome).toMatchObject({ outcome: 'conflict', operation: { operationId: prepare.operationId, state: 'aborted' } });
      expect(await accountOf(userId)).toMatchObject({ username });
    });

    it('rejects committing an operation recorded without a change', async () => {
      const userId = await seedUser(uname('bare'));
      const operationId = next('C');
      await gated(SITE_A, (tx) => repo.insertAccountOperation(tx, { operation_id: operationId, user_id: userId, kind: 'update', state: 'prepared' }));

      await expect(commitAccountOperation(deps(), operationId)).rejects.toThrow(`Account operation ${operationId} has no recorded change`);

      expect((await operationOf(operationId))?.state).toBe('prepared');
    });
  });

  describe('abortAccountOperation', () => {
    it('discards a prepared create, deletes its pending account, reopens the user and refuses a later prepare of that id', async () => {
      const userId = next('A');
      const prepare = await prepared(input('create', userId, { password: 'Secret12' }));
      const sleeps: number[] = [];

      const outcome = await abortAccountOperation(deps(), prepare.operationId, { userId });

      expect(outcome).toEqual({ outcome: 'stepped', step: { operationId: prepare.operationId, userId, state: 'aborted' } });
      expect(await accountOf(userId)).toBeNull();
      expect(await operationOf(prepare.operationId)).toMatchObject({ state: 'aborted', pending_change: null });
      expect(await registered(prepare.operationId)).toBe(false);
      await awaitAccountOpen(handle.app, TENANT_A, userId, { sleep: async (ms) => void sleeps.push(ms) });
      expect(sleeps).toEqual([]);
      expect(await abortAccountOperation(deps(), prepare.operationId)).toEqual(outcome);
      expect(await prepareAccountOperation(deps(), prepare)).toMatchObject({ outcome: 'conflict', operation: { state: 'aborted' } });
    });

    it('leaves the account of an aborted update as stored', async () => {
      const username = uname('keep');
      const userId = await seedUser(username, { groupIds: [EDITORS] });
      const prepare = await prepared(input('update', userId, { username: uname('keep2'), password: 'Fresh123', groupIds: [AUTHORS] }));

      expect((await abortAccountOperation(deps(), prepare.operationId)).outcome).toBe('stepped');

      expect(await accountOf(userId)).toMatchObject({ username, opt2_state: 'active' });
      expect(await credentialOf(userId)).toMatchObject({ password: STORED_HASH });
      expect(await membershipsOf(userId)).toEqual([EDITORS]);
    });

    it('answers an operation identity never recorded with unknown and drops its stale registration', async () => {
      const operationId = next('C');
      const userId = next('A');
      await registerOperation(handle.app, { operationId, kind: 'roster-account', units: [...ACCOUNT_OPERATION_UNITS] });

      expect(await abortAccountOperation(deps(), operationId, { userId })).toEqual({ outcome: 'conflict', operation: { operationId, userId, state: 'unknown' } });

      expect(await registered(operationId)).toBe(false);
    });

    it("refuses to abort a committed operation or another user's", async () => {
      const userId = await seedUser(uname('noabort'));
      const prepare = input('update', userId, {});
      await prepared(prepare);

      expect(await abortAccountOperation(deps(), prepare.operationId, { userId: next('A') })).toMatchObject({ outcome: 'conflict', operation: { state: 'prepared' } });
      await commitAccountOperation(deps(), prepare.operationId);
      expect(await abortAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { userId, state: 'committed' } });
      expect(await registered(prepare.operationId)).toBe(true);
    });
  });

  describe('revertAccountOperation', () => {
    it("restores a committed update's account, credential and memberships and discards its held events", async () => {
      const username = uname('rev');
      const userId = await seedUser(username, { account: { perm: 1, remoteid: 'r-old', tablist: 'Old' }, groupIds: [EDITORS, B_STAFF] });
      const prepare = input('update', userId, { username: uname('rev2'), password: 'Fresh123', inActive: 1, remoteID: 'r-new', tablist: 'New', groupIds: [AUTHORS] });
      await committed(prepare);
      expect(await eventsOf(prepare.operationId)).toHaveLength(1);

      const outcome = await revertAccountOperation(deps(), prepare.operationId, { userId });

      expect(outcome).toEqual({ outcome: 'stepped', step: { operationId: prepare.operationId, userId, state: 'reverted' } });
      expect(await accountOf(userId)).toMatchObject({ username, s2: 0, perm: 1, inactive: 0, ispublic: 0, siteid: SITE_A, remoteid: 'r-old', tablist: 'Old', opt2_state: 'active' });
      expect(await credentialOf(userId)).toMatchObject({ password: STORED_HASH, passwordcreated: PASSWORD_CREATED });
      expect(await membershipsOf(userId)).toEqual([EDITORS, B_STAFF]);
      expect(await eventsOf(prepare.operationId)).toEqual([]);
      expect(await registered(prepare.operationId)).toBe(false);
      expect((await accountOperationStatus(deps(), prepare.operationId)).state).toBe('reverted');
      expect(await revertAccountOperation(deps(), prepare.operationId)).toEqual(outcome);
    });

    it("removes a reverted create's account, credential, login state and memberships", async () => {
      const userId = next('A');
      const prepare = input('create', userId, { password: 'Secret12', groupIds: [EDITORS] });
      await committed(prepare);

      expect((await revertAccountOperation(deps(), prepare.operationId)).outcome).toBe('stepped');

      expect(await accountOf(userId)).toBeNull();
      expect(await credentialOf(userId)).toBeNull();
      expect(await loginStateOf(userId)).toBeNull();
      expect(await membershipsOf(userId)).toEqual([]);
    });

    it('deletes the credential a reverted update stored for an account that had none, keeping its memberships when none were posted', async () => {
      const userId = await seedUser(uname('nocred'), { password: null, groupIds: [EDITORS] });
      const prepare = input('update', userId, { password: 'Fresh123' });
      await committed(prepare);
      expect(await credentialOf(userId)).not.toBeNull();

      await revertAccountOperation(deps(), prepare.operationId);

      expect(await credentialOf(userId)).toBeNull();
      expect(await membershipsOf(userId)).toEqual([EDITORS]);
    });

    it('refuses to revert a prepared or finished operation', async () => {
      const userId = await seedUser(uname('norev'));
      const prepare = input('update', userId, {});
      await prepared(prepare);

      expect(await revertAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { state: 'prepared' } });
      await commitAccountOperation(deps(), prepare.operationId);
      await finishAccountOperation(deps(), prepare.operationId);
      expect(await revertAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { state: 'finished' } });
    });
  });

  describe('finishAccountOperation', () => {
    const SESSION_SNAPSHOT: Omit<LoginSnapshot, 'userid' | 'username' | 'roleList' | 'membershipIds'> = {
      siteid: SITE_A,
      subtype: 'Default',
      password: STORED_HASH,
      fname: 'Old',
      lname: 'Name',
      email: 'old@example.test',
      remoteid: '',
      company: '',
      lastlogin: null,
      passwordcreated: null,
    };

    async function loggedIn(userId: string, username: string, site = SITE_A): Promise<string> {
      const sessionId = `S-${next('D')}`;
      await applyLogin(
        { db: handle.app, repo, clock },
        {
          sessionId,
          tenantId: tenantIdForSite(site),
          snapshot: { ...SESSION_SNAPSHOT, userid: userId, username, siteid: site, roleList: `${username};username;${site}`, membershipIds: userId },
          mode: 'target-primary',
          siteId: site,
        },
      );
      return sessionId;
    }

    it('releases the held events, reopens the user and keeps the committed result', async () => {
      const userId = await seedUser(uname('fin'), { groupIds: [EDITORS] });
      const prepare = input('update', userId, { groupIds: [AUTHORS] });
      await committed(prepare);

      const outcome = await finishAccountOperation(deps(), prepare.operationId, { userId });

      expect(outcome).toEqual({ outcome: 'stepped', step: { operationId: prepare.operationId, userId, state: 'finished' } });
      expect(await eventsOf(prepare.operationId)).toEqual([
        { topic: MEMBERSHIP_CHANGED_TOPIC, held: false, payload: { userId, siteId: SITE_A, groupIds: [AUTHORS] } },
      ]);
      expect(await registered(prepare.operationId)).toBe(false);
      expect((await accountOperationStatus(deps(), prepare.operationId)).state).toBe('finished');
      expect(await finishAccountOperation(deps(), prepare.operationId)).toEqual(outcome);
      expect(await abortAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { state: 'finished' } });
      expect(await membershipsOf(userId)).toEqual([AUTHORS]);
    });

    it('refuses to finish a prepared operation', async () => {
      const userId = await seedUser(uname('nofin'));
      const prepare = await prepared(input('update', userId, {}));

      expect(await finishAccountOperation(deps(), prepare.operationId)).toMatchObject({ outcome: 'conflict', operation: { state: 'prepared' } });
      expect(await registered(prepare.operationId)).toBe(true);
    });

    it('logs a signalled session in again from the saved rows, with the person fields people sent and the previous last login', async () => {
      const userId = await seedUser(uname('rita'));
      const sessionId = await loggedIn(userId, 'rita');
      const before = await sessionOf(sessionId);
      const username = uname('rita2');
      const person = { fname: 'Rita', lname: 'Relogin', email: 'rita@example.test', company: 'Acme', subtype: 'Default' };
      const prepare = input('update', userId, { username, remoteID: 'r-7', groupIds: [MEMBERS, EDITORS, MISSING_GROUP] });
      await committed(prepare, { sessionEffects: { reloginSessionId: sessionId, person } });
      now = LATER;

      expect((await finishAccountOperation(deps(), prepare.operationId)).outcome).toBe('stepped');

      const after = await sessionOf(sessionId);
      expect(after).toMatchObject({ user_id: userId, state: 'active', epoch: String(Number(before?.epoch) + 1) });
      expect(after?.csrf_secret).not.toBe(before?.csrf_secret);
      expect(JSON.parse(after?.login_snapshot ?? '{}')).toEqual({
        userid: userId,
        username,
        siteid: SITE_A,
        subtype: 'Default',
        password: STORED_HASH,
        fname: 'Rita',
        lname: 'Relogin',
        email: 'rita@example.test',
        remoteid: 'r-7',
        company: 'Acme',
        lastlogin: '2026-06-30T09:15:00.120',
        passwordcreated: '2026-06-01T09:15:00.000',
        roleList: `Editors;${SITE_A};0,Members;${UMBRELLA};1,S2IsPrivate;${SITE_A},S2IsPrivate,${username};username;${SITE_A}`,
        membershipIds: `${EDITORS},${MEMBERS},${userId}`,
      });
      expect(await loginStateOf(userId)).toMatchObject({ lastlogin: LATER });
    });

    it('reads the person fields of a re-login from the contact projection when people sent none', async () => {
      const userId = await seedUser(uname('cara'), { lastlogin: null });
      await gated(SITE_A, (tx) =>
        repo.upsertPersonContact(tx, { user_id: userId, site_id: SITE_A, email: 'cara@example.test', fname: 'Cara', lname: 'Contact', company: '', subtype: 'Member', aggregate_version: 1 }),
      );
      const sessionId = await loggedIn(userId, 'cara');
      const prepare = input('update', userId, { s2: 1 }, { actorIsSuperUser: true });
      await committed(prepare, { sessionEffects: { reloginSessionId: sessionId } });

      await finishAccountOperation(deps(), prepare.operationId);

      const snapshot = JSON.parse((await sessionOf(sessionId))?.login_snapshot ?? '{}') as LoginSnapshot;
      expect(snapshot).toMatchObject({ fname: 'Cara', lname: 'Contact', email: 'cara@example.test', subtype: 'Member', lastlogin: null });
      expect(snapshot.roleList).toBe(`S2IsPrivate;${SITE_A},S2IsPrivate,S2,${prepare.change.username};username;${SITE_A}`);
    });

    it.each([
      ['the session is unknown', 'unknown', {}, SITE_A],
      ['the session has ended', 'ended', {}, SITE_A],
      ['the saved account is inactive', 'active', { inActive: 1 }, SITE_A],
    ] as const)('leaves the session as it was when %s', async (_label, session, changes, site) => {
      const userId = await seedUser(uname('skip'), { site });
      const sessionId = session === 'unknown' ? `S-${next('D')}` : await loggedIn(userId, 'skip', site);
      if (session === 'ended') await endSession({ db: handle.app, repo, clock }, sessionId);
      const before = await sessionOf(sessionId, site);
      const prepare = input('update', userId, changes, { siteId: site });
      await committed(prepare, { sessionEffects: { reloginSessionId: sessionId } });

      expect((await finishAccountOperation(deps(), prepare.operationId)).outcome).toBe('stepped');

      expect(await sessionOf(sessionId, site)).toEqual(before);
      expect(await loginStateOf(userId, site)).toMatchObject({ lastlogin: LAST_LOGIN });
    });

    it("leaves the session of a public account whose site's public user pool is another site", async () => {
      const userId = next('A');
      const prepare = input('create', userId, { isPublic: 1 }, { requestSiteId: SITE_C, siteId: CHAIN });
      await prepared(prepare);
      const sessionId = await loggedIn(userId, 'pub', CHAIN);
      const before = await sessionOf(sessionId, CHAIN);
      await commitAccountOperation(deps(), prepare.operationId, { sessionEffects: { reloginSessionId: sessionId } });

      await finishAccountOperation(deps(), prepare.operationId);

      expect(await sessionOf(sessionId, CHAIN)).toEqual(before);
    });

    it('logs a public account of its own public user pool in again', async () => {
      const userId = next('A');
      const prepare = input('create', userId, { isPublic: 1, groupIds: [MEMBERS] }, { siteId: UMBRELLA });
      await prepared(prepare);
      const sessionId = await loggedIn(userId, 'pub', UMBRELLA);
      await commitAccountOperation(deps(), prepare.operationId, { sessionEffects: { reloginSessionId: sessionId } });

      await finishAccountOperation(deps(), prepare.operationId);

      const snapshot = JSON.parse((await sessionOf(sessionId, UMBRELLA))?.login_snapshot ?? '{}') as LoginSnapshot;
      expect(snapshot.roleList).toBe(`Members;${UMBRELLA};1,S2IsPublic;${UMBRELLA},S2IsPublic,${prepare.change.username};username;${UMBRELLA}`);
    });
  });

  describe('operation status', () => {
    it('answers unknown for an operation identity never recorded or one of another user, and the recorded view otherwise', async () => {
      const userId = await seedUser(uname('stat'));
      const prepare = await prepared(input('update', userId, {}));
      const unknown = next('C');

      expect(await accountOperationStatus(deps(), unknown)).toEqual({ operationId: unknown, userId: '', state: 'unknown' });
      expect(await accountOperationStatus(deps(), prepare.operationId, { userId: next('A') })).toMatchObject({ operationId: prepare.operationId, state: 'unknown' });
      expect(await accountOperationStatus(deps(), prepare.operationId, { userId })).toMatchObject({ operationId: prepare.operationId, userId, kind: 'update', state: 'prepared' });
    });

    it('reports open, done and rolled-back migration statuses by state and omits operations never recorded', async () => {
      const ids: Record<string, string> = {};
      for (const target of ['prepared', 'committed', 'finished', 'aborted', 'reverted'] as const) {
        const userId = await seedUser(uname(target));
        const prepare = await prepared(input('update', userId, {}));
        ids[target] = prepare.operationId;
        if (target === 'aborted') await abortAccountOperation(deps(), prepare.operationId);
        if (target === 'prepared' || target === 'aborted') continue;
        await commitAccountOperation(deps(), prepare.operationId);
        if (target === 'finished') await finishAccountOperation(deps(), prepare.operationId);
        if (target === 'reverted') await revertAccountOperation(deps(), prepare.operationId);
      }
      const umbrellaOp = await prepared(input('create', next('A'), { isPublic: 1 }, { siteId: UMBRELLA }));
      const unknown = next('C');

      const statuses = await operationStatus(handle.app, [...Object.values(ids), umbrellaOp.operationId, unknown]);

      expect(statuses).toEqual({
        [ids.prepared as string]: 'open',
        [ids.committed as string]: 'open',
        [ids.finished as string]: 'done',
        [ids.aborted as string]: 'rolled-back',
        [ids.reverted as string]: 'rolled-back',
        [umbrellaOp.operationId]: 'open',
      });
      expect(await operationStatus(handle.app, [])).toEqual({});
    });
  });

  describe('awaitAccountOpen', () => {
    it("returns at once for a user no operation holds, or one held only by the caller's own operation", async () => {
      const userId = await seedUser(uname('free'));
      const sleeps: number[] = [];
      const sleep = async (ms: number): Promise<void> => void sleeps.push(ms);

      await awaitAccountOpen(handle.app, TENANT_A, userId, { sleep });
      const prepare = await prepared(input('update', userId, {}));
      await awaitAccountOpen(handle.app, TENANT_A, userId, { sleep, selfOperationId: prepare.operationId });

      expect(sleeps).toEqual([]);
    });

    it('polls while another operation keeps the user closed and returns once it ends', async () => {
      const userId = await seedUser(uname('poll'));
      const prepare = await prepared(input('update', userId, {}));
      let polls = 0;

      await awaitAccountOpen(handle.app, TENANT_A, userId, {
        sleep: async () => {
          polls += 1;
          if (polls === 3) await abortAccountOperation(deps(), prepare.operationId);
        },
      });

      expect(polls).toBe(3);
    });

    it('throws OperationBlockedError naming the operation once the waits reach USER_CLOSED_WAIT_MS', async () => {
      const userId = await seedUser(uname('stuck'));
      const prepare = await prepared(input('update', userId, {}));
      const sleeps: number[] = [];

      const failure = await awaitAccountOpen(handle.app, TENANT_A, userId, { sleep: async (ms) => void sleeps.push(ms) }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(OperationBlockedError);
      expect(failure).toMatchObject({ units: [...ACCOUNT_OPERATION_UNITS], message: `Account operation ${prepare.operationId} keeps user ${userId} closed` });
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
      expect(sleeps.every((ms) => ms > 0 && ms < USER_CLOSED_WAIT_MS)).toBe(true);
    });
  });
});
