/** Account and pool-group reads against a throwaway `identity` schema: the batch row read, legacy group order, user-pool tenancy, the closed-user wait and window read gates. */
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, type UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { UnitReadBlockedError, ensureUnitGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CLOSED_USER_WAIT_MS, createAccountReads } from '../../src/domain/account-reads.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { CREDENTIAL, GROUP_ACCOUNT, IDENTITY_UNITS, LOGIN_STATE, USER_ACCOUNT } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SHORT_MS = 300;
const LONG_MS = 5_000;
const RELEASE_AFTER_MS = 400;
const PASSWORD_CREATED = new Date(2026, 5, 1, 9, 15, 0);
const LAST_LOGIN = new Date(2026, 5, 30, 9, 15, 0, 120);

function id(n: number, prefix = 'A'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const ACTIVE = id(1);
const PENDING = id(2);
const CLOSED = id(3);
const BARE = id(4);
const PUBLIC = id(5);
const OTHER_TENANT = id(6);
const GROUP = id(7, 'B');
const MISSING = id(99);

function account(userid: string, username: string, overrides: Partial<AccountInput> = {}): AccountInput {
  return { userid, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: 'tenant-a', remoteid: '', tablist: '', ...overrides };
}

function groupInput(overrides: Partial<GroupInput>): GroupInput {
  return {
    groupname: 'Editors', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: 'tenant-a',
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...overrides,
  };
}

function claimsFor(site: string): UserClaims {
  return {
    iss: 'opt2-local-identity', aud: 'opt2-local', sub: 'test-people', sid: 'sid', tid: tenantIdForSite(site), site,
    roles: [Roles.systemUser], s2: false, epoch: 0, iat: 0, exp: 0,
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('identity account reads against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  async function registerSite(site: string, privatePool: string | null, publicPool: string | null): Promise<void> {
    const tenantOf = (pool: string | null): string | null => (pool === null ? null : tenantIdForSite(pool));
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantOf(privatePool), tenantOf(publicPool), CLOCK.now()],
      ),
    );
  }

  async function setPhase(unit: string, phase: GatePhase): Promise<void> {
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET phase = $2 WHERE unit = $1`, [unit, phase]));
  }

  async function openOperation(userId: string): Promise<string> {
    const op = await gated('tenant-a', (tx) => repo.insertAccountOperation(tx, { user_id: userId, kind: 'update', state: 'prepared' }));
    return op.operation_id;
  }

  async function endOperation(operationId: string, to: 'finished' | 'aborted' = 'finished'): Promise<void> {
    await gated('tenant-a', (tx) => repo.setAccountOperationState(tx, operationId, ['prepared', 'committed'], to));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await registerSite('tenant-a', 'tenant-a', 'umbrella');
    await registerSite('umbrella', 'umbrella', 'umbrella');
    await registerSite('tenant-b', 'tenant-b', 'tenant-b');
    await registerSite('tenant-c', 'tenant-c', 'chain');
    await registerSite('chain', 'chain', 'umbrella');
    await registerSite('poolless', null, null);
    await registerSite('tenant-d', 'tenant-d', 'unregistered-pool');

    await gated('tenant-a', async (tx) => {
      await repo.insertAccount(tx, account(ACTIVE, 'ada', { admin: 1, s2: 1, perm: 1, inactive: 1, remoteid: 'r-1', tablist: 'Basic,Extended' }));
      await repo.writeCredential(tx, ACTIVE, { password: 'stored-hash', passwordcreated: PASSWORD_CREATED });
      await repo.touchLastLogin(tx, ACTIVE, LAST_LOGIN);
      await repo.insertAccount(tx, account(PENDING, 'pat', { opt2_state: 'pending' }));
      await repo.insertAccount(tx, account(CLOSED, 'cal'));
      await repo.insertAccount(tx, account(BARE, '', { siteid: '' }));
      await repo.insertGroup(tx, groupInput({ userid: GROUP, groupname: 'Zeta', perm: 1 }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'beta' }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Alpha' }), null);
      await repo.insertGroup(tx, groupInput({ groupname: '' }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Gamma', perm: null }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Site Members', ispublic: 1 }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Elsewhere', siteid: 'tenant-x' }), null);
    });
    await gated('umbrella', async (tx) => {
      await repo.insertAccount(tx, account(PUBLIC, 'pub', { ispublic: 1, siteid: 'umbrella' }));
      await repo.insertGroup(tx, groupInput({ groupname: 'Members', ispublic: 1, siteid: 'umbrella' }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Alumni', ispublic: 1, siteid: 'umbrella' }), null);
      await repo.insertGroup(tx, groupInput({ groupname: 'Umbrella Staff', siteid: 'umbrella' }), null);
    });
    await gated('tenant-b', (tx) => repo.insertAccount(tx, account(OTHER_TENANT, 'bea', { siteid: 'tenant-b' })));
    await gated('chain', (tx) => repo.insertGroup(tx, groupInput({ groupname: 'Chained', ispublic: 1, siteid: 'chain' }), null));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET phase = 'quiet'`));
  });

  describe('repository', () => {
    it('reads the listed Type=2 rows of the tenant in one statement, pending ones included, with credential and login-state columns', async () => {
      const operationId = await openOperation(CLOSED);
      try {
        const rows = await gated('tenant-a', (tx) => repo.readAccountRecords(tx, [MISSING, BARE, GROUP, CLOSED, PENDING, ACTIVE, OTHER_TENANT]));
        expect(rows.map((row) => [row.userid, row.opt2_state, row.closed])).toEqual([
          [ACTIVE, 'active', false],
          [PENDING, 'pending', false],
          [CLOSED, 'active', true],
          [BARE, 'active', false],
        ]);
        expect(rows[0]).toMatchObject({ username: 'ada', passwordcreated: PASSWORD_CREATED, lastlogin: LAST_LOGIN, tablist: 'Basic,Extended' });
        expect(rows[3]).toMatchObject({ username: null, remoteid: null, tablist: null, passwordcreated: null, lastlogin: null, admin: null });
      } finally {
        await endOperation(operationId);
      }
      expect((await gated('tenant-a', (tx) => repo.readAccountRecords(tx, [CLOSED])))[0]?.closed).toBe(false);
    });

    it('lists a pool site\'s groups of one visibility by Perm descending with NULL last, then name without case, NULL first', async () => {
      const names = async (isPublic: 0 | 1, site = 'tenant-a'): Promise<Array<string | null>> =>
        (await gated(site, (tx) => repo.listPoolGroups(tx, site, isPublic))).map((row) => row.groupname);

      expect(await names(0)).toEqual(['Zeta', null, 'Alpha', 'beta', 'Gamma']);
      expect(await names(1)).toEqual(['Site Members']);
      expect(await gated('tenant-a', (tx) => repo.listPoolGroups(tx, 'tenant-a', 0))).toContainEqual({
        userid: GROUP, groupname: 'Zeta', siteid: 'tenant-a', ispublic: 0, perm: 1,
      });
    });

    type Read = (r: IdentityRepository, tx: TenantTx) => Promise<unknown>;
    const readAccounts: Read = (r, tx) => r.readAccountRecords(tx, [ACTIVE]);
    const readGroups: Read = (r, tx) => r.listPoolGroups(tx, 'tenant-a', 0);

    it.each([
      [USER_ACCOUNT.unit, readAccounts],
      [CREDENTIAL.unit, readAccounts],
      [LOGIN_STATE.unit, readAccounts],
      [GROUP_ACCOUNT.unit, readGroups],
    ])('blocks the read while a window executes on %s', async (unit, read) => {
      await setPhase(unit, 'executing');
      await expect(withGatedTenant(handle.app, tenantIdForSite('tenant-a'), (tx) => read(repo, tx), { budgetMs: SHORT_MS })).rejects.toBeInstanceOf(
        UnitReadBlockedError,
      );
    });
  });

  describe('domain', () => {
    const reads = (): ReturnType<typeof createAccountReads> => createAccountReads({ repo, closedUserWaitMs: SHORT_MS, gateWaitMs: SHORT_MS });

    it('defaults the closed-user wait to 10 s', () => {
      expect(CLOSED_USER_WAIT_MS).toBe(10_000);
    });

    it('reads the site\'s private and public pool accounts and nothing outside them', async () => {
      const claims = claimsFor('tenant-a');

      expect(await reads().getAccount(handle.app, claims, ACTIVE)).toMatchObject({ UserID: ACTIVE, SiteID: 'tenant-a', Type: 2 });
      expect(await reads().getAccount(handle.app, claims, PUBLIC)).toMatchObject({ UserID: PUBLIC, SiteID: 'umbrella', isPublic: 1 });
      for (const userId of [MISSING, GROUP, PENDING, OTHER_TENANT]) {
        expect(await reads().getAccount(handle.app, claims, userId)).toBeNull();
      }
      expect(await reads().getAccount(handle.app, claimsFor('tenant-b'), OTHER_TENANT)).toMatchObject({ UserID: OTHER_TENANT });
      expect(await reads().getAccount(handle.app, claimsFor('unregistered'), ACTIVE)).toBeNull();
      expect(await reads().getAccount(handle.app, claimsFor('poolless'), ACTIVE)).toBeNull();
    });

    it('looks many users up across both pools in request order, leaving out the ones getAccount does not find', async () => {
      const found = await reads().lookupAccounts(handle.app, claimsFor('tenant-a'), [PUBLIC, MISSING, PENDING, ACTIVE, GROUP, OTHER_TENANT, BARE]);

      expect(found.map((record) => record.UserID)).toEqual([PUBLIC, ACTIVE, BARE]);
      expect(found[2]).toMatchObject({ SiteID: '', UserName: null, remoteID: null, tablist: null, PasswordCreated: null, LastLogin: null });
    });

    it('lists the private pool\'s system groups and the public pool\'s member groups', async () => {
      const groups = async (site: string, isPublic: 0 | 1): Promise<Array<string | null>> =>
        (await reads().listSiteGroups(handle.app, claimsFor(site), isPublic)).map((group) => group.GroupName);

      expect(await groups('tenant-a', 0)).toEqual(['Zeta', null, 'Alpha', 'beta', 'Gamma']);
      expect(await groups('tenant-a', 1)).toEqual(['Alumni', 'Members']);
      expect(await groups('umbrella', 0)).toEqual(['Umbrella Staff']);
      expect(await groups('tenant-b', 0)).toEqual([]);
    });

    it.each([
      ['a site whose public pool site pools its members elsewhere', 'tenant-c', 1 as const],
      ['a site without pools', 'poolless', 0 as const],
      ['a site whose public pool site is unregistered', 'tenant-d', 1 as const],
      ['an unregistered site', 'unregistered', 1 as const],
    ])('lists no groups for %s', async (_label, site, isPublic) => {
      expect(await reads().listSiteGroups(handle.app, claimsFor(site), isPublic)).toEqual([]);
    });

    it('answers the legacy 503 once a closed user stays closed past the wait, for a single or a batch read', async () => {
      const operationId = await openOperation(CLOSED);
      try {
        const started = Date.now();
        const error = await reads().getAccount(handle.app, claimsFor('tenant-a'), CLOSED).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
        expect(error).toMatchObject({ reason: 'user-closed', surface: 'auto' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_MS);
        await expect(reads().lookupAccounts(handle.app, claimsFor('tenant-a'), [ACTIVE, CLOSED])).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
        expect(await reads().getAccount(handle.app, claimsFor('tenant-a'), ACTIVE)).toMatchObject({ UserID: ACTIVE });
      } finally {
        await endOperation(operationId);
      }
    });

    it.each(['finished', 'aborted'] as const)('waits while a user is closed and reads it once the operation is %s', async (to) => {
      const operationId = await openOperation(CLOSED);
      const started = Date.now();
      const read = createAccountReads({ repo, closedUserWaitMs: LONG_MS }).lookupAccounts(handle.app, claimsFor('tenant-a'), [CLOSED, ACTIVE]);
      await sleep(RELEASE_AFTER_MS);
      await endOperation(operationId, to);

      expect((await read).map((record) => record.UserID)).toEqual([CLOSED, ACTIVE]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
    });

    it('waits out an executing window on the account units, then reads', async () => {
      await setPhase(LOGIN_STATE.unit, 'executing');
      const started = Date.now();
      const read = createAccountReads({ repo, gateWaitMs: LONG_MS }).getAccount(handle.app, claimsFor('tenant-a'), ACTIVE);
      await sleep(RELEASE_AFTER_MS);
      await setPhase(LOGIN_STATE.unit, 'quiet');

      expect(await read).toMatchObject({ UserID: ACTIVE, LastLogin: '2026-06-30T09:15:00.120' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
    });

    it.each([
      ['getAccount', USER_ACCOUNT.unit, (claims: UserClaims) => reads().getAccount(handle.app, claims, ACTIVE)],
      ['lookupAccounts', CREDENTIAL.unit, (claims: UserClaims) => reads().lookupAccounts(handle.app, claims, [ACTIVE])],
      ['listSiteGroups', GROUP_ACCOUNT.unit, (claims: UserClaims) => reads().listSiteGroups(handle.app, claims, 0)],
    ])('answers %s with the legacy 503 while a window outlasts the gate wait', async (_label, unit, read) => {
      await setPhase(unit, 'importing');
      await expect(read(claimsFor('tenant-a'))).rejects.toBeInstanceOf(UnitReadBlockedError);
    });
  });
});
