/** Account, membership, login-block and pool-group reads against a throwaway `identity` schema: the batch row reads, account predicates, counts and user-name candidates, legacy group order, user-pool tenancy, strike loading, the closed-user wait and window read gates. */
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, type UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { UnitReadBlockedError, ensureUnitGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  CLOSED_USER_WAIT_MS,
  createAccountReads,
  type AccountCountRequest,
  type AccountWhere,
  type UsernameCandidateRequest,
} from '../../src/domain/account-reads.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { CREDENTIAL, GROUP_ACCOUNT, IDENTITY_UNITS, LOGIN_STATE, MEMBERSHIP, USER_ACCOUNT, USER_STRIKE } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SHORT_MS = 300;
const LONG_MS = 5_000;
const RELEASE_AFTER_MS = 400;
const PASSWORD_CREATED = new Date(2026, 5, 1, 9, 15, 0);
const LAST_LOGIN = new Date(2026, 5, 30, 9, 15, 0, 120);
const MINUTE_MS = 60_000;

/** `CLOCK`'s now less `minutes`. */
function minutesAgo(minutes: number): Date {
  return new Date(CLOCK.now().getTime() - minutes * MINUTE_MS);
}

function id(n: number, prefix = 'A'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const ACTIVE = id(1);
const PENDING = id(2);
const CLOSED = id(3);
const BARE = id(4);
const PUBLIC = id(5);
const OTHER_TENANT = id(6);
const DEFAULT_USER = id(10);
const POOL_ONLY = id(11);
const UNLISTED = id(12);
const GROUP = id(7, 'B');
const SECOND_GROUP = id(8, 'B');
const ORPHAN_GROUP = id(9, 'B');
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
    await registerSite('default', 'default', 'default');

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
    await gated('default', (tx) => repo.insertAccount(tx, account(DEFAULT_USER, 'dee', { siteid: 'default' })));
    // Stored under a pool no site registers itself, and under a tenant that is neither a registered site nor a pool.
    await gated('unregistered-pool', (tx) => repo.insertAccount(tx, account(POOL_ONLY, 'poe', { ispublic: 1, siteid: 'unregistered-pool' })));
    await gated('nowhere', (tx) => repo.insertAccount(tx, account(UNLISTED, 'una', { siteid: 'nowhere' })));
    // Membership rows live in the member's tenant; umbrella also holds orphans, one repeating a tenant-a row in other case.
    await gated('tenant-a', async (tx) => {
      await repo.addMembership(tx, ACTIVE, SECOND_GROUP);
      await repo.addMembership(tx, ACTIVE, GROUP);
      await repo.addMembership(tx, CLOSED, GROUP);
    });
    await gated('umbrella', async (tx) => {
      await repo.addMembership(tx, PUBLIC, SECOND_GROUP);
      await repo.addMembership(tx, ACTIVE, ORPHAN_GROUP);
      await repo.addMembership(tx, ACTIVE, GROUP.toLowerCase());
    });
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

    it('reads the listed users\' membership rows of the tenant with the users open operations close, rows or not, in one statement', async () => {
      const operationIds = [await openOperation(CLOSED), await openOperation(BARE)];
      try {
        expect(await gated('tenant-a', (tx) => repo.readMembershipRecords(tx, [MISSING, BARE, CLOSED.toLowerCase(), ACTIVE, PUBLIC]))).toEqual({
          rows: [
            { userid: ACTIVE, groupid: GROUP },
            { userid: ACTIVE, groupid: SECOND_GROUP },
            { userid: CLOSED, groupid: GROUP },
          ],
          closed: [CLOSED, BARE],
        });
      } finally {
        for (const operationId of operationIds) await endOperation(operationId);
      }
      expect(await gated('tenant-a', (tx) => repo.readMembershipRecords(tx, [BARE, MISSING]))).toEqual({ rows: [], closed: [] });
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
    const readMemberships: Read = (r, tx) => r.readMembershipRecords(tx, [ACTIVE]);

    it.each([
      [USER_ACCOUNT.unit, readAccounts],
      [CREDENTIAL.unit, readAccounts],
      [LOGIN_STATE.unit, readAccounts],
      [GROUP_ACCOUNT.unit, readGroups],
      [MEMBERSHIP.unit, readMemberships],
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

    it('looks users up across every registered site and its user pools, each found user once, in request order', async () => {
      const userIds = [OTHER_TENANT, DEFAULT_USER, MISSING, PENDING, PUBLIC, ACTIVE.toLowerCase(), GROUP, POOL_ONLY, UNLISTED];
      const found = await reads().lookupAccountsAllSites(handle.app, userIds);

      expect(found.map((record) => record.UserID)).toEqual([OTHER_TENANT, DEFAULT_USER, PUBLIC, ACTIVE, POOL_ONLY]);
      expect(found[3]).toEqual(await reads().getAccount(handle.app, claimsFor('tenant-a'), ACTIVE));
      expect((await reads().lookupAccounts(handle.app, claimsFor('tenant-a'), userIds)).map((record) => record.UserID)).toEqual([PUBLIC, ACTIVE]);
    });

    it('finds users by lower-cased ids and answers their stored ids, as SQL Server char equality matches them', async () => {
      const claims = claimsFor('tenant-a');

      expect(await reads().getAccount(handle.app, claims, ACTIVE.toLowerCase())).toMatchObject({ UserID: ACTIVE });
      expect((await reads().lookupAccounts(handle.app, claims, [PUBLIC.toLowerCase(), ACTIVE])).map((record) => record.UserID)).toEqual([PUBLIC, ACTIVE]);
    });

    it('looks memberships up across every registered tenant, one item per id in request order and spelling, groups de-duplicated by key', async () => {
      expect(await reads().lookupMemberships(handle.app, [OTHER_TENANT, ACTIVE.toLowerCase(), PUBLIC, MISSING, GROUP])).toEqual([
        { userId: OTHER_TENANT, groupIds: [] },
        { userId: ACTIVE.toLowerCase(), groupIds: [GROUP, SECOND_GROUP, ORPHAN_GROUP] },
        { userId: PUBLIC, groupIds: [SECOND_GROUP] },
        { userId: MISSING, groupIds: [] },
        { userId: GROUP, groupIds: [] },
      ]);
    });

    it('answers lookupMemberships with the legacy 503 once a listed user without membership rows stays closed past the wait', async () => {
      const operationId = await openOperation(BARE);
      try {
        const started = Date.now();
        const error = await reads().lookupMemberships(handle.app, [ACTIVE, BARE]).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
        expect(error).toMatchObject({ reason: 'user-closed', surface: 'auto' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_MS);
      } finally {
        await endOperation(operationId);
      }
    });

    it('waits while a listed user is closed and reads its memberships once the operation ends', async () => {
      const operationId = await openOperation(CLOSED);
      const started = Date.now();
      const read = createAccountReads({ repo, closedUserWaitMs: LONG_MS }).lookupMemberships(handle.app, [CLOSED, PUBLIC]);
      await sleep(RELEASE_AFTER_MS);
      await endOperation(operationId);

      expect(await read).toEqual([
        { userId: CLOSED, groupIds: [GROUP] },
        { userId: PUBLIC, groupIds: [SECOND_GROUP] },
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
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

    describe('loadLoginBlock', () => {
      const blocks = (): ReturnType<typeof createAccountReads> =>
        createAccountReads({ repo, closedUserWaitMs: SHORT_MS, gateWaitMs: SHORT_MS, clock: CLOCK });

      /** Replaces the strike row of `username` in `site`'s tenant with `state`, or removes it for null. */
      async function seedStrike(site: string, username: string, state: { strikes: number; at: Date } | null): Promise<void> {
        await gated(site, async (tx) => {
          await repo.delete(tx, USER_STRIKE.table, { username });
          if (state === null) return;
          await repo.ensureStrike(tx, username, CLOCK.now());
          await repo.setStrike(tx, username, { strikes: state.strikes, lastattempt: state.at });
        });
      }

      async function storedStrike(site: string, username: string): Promise<{ strikes: number | null; lastattempt: Date | null } | null> {
        const row = await gated(site, (tx) => repo.readStrike(tx, username));
        return row === null ? null : { strikes: row.strikes, lastattempt: row.lastattempt };
      }

      it.each([
        ['blocked within the window', { strikes: 5, at: minutesAgo(2) }, false, '2026-06-30T12:08:00.000', { strikes: 5, lastattempt: minutesAgo(2) }],
        ['at the allowed count', { strikes: 4, at: minutesAgo(2) }, false, null, { strikes: 4, lastattempt: minutesAgo(2) }],
        ['whose block window has passed, reset', { strikes: 9, at: minutesAgo(11) }, false, null, { strikes: 0, lastattempt: minutesAgo(1) }],
        ['blocked, cleared by removeBlock', { strikes: 5, at: minutesAgo(2) }, true, null, { strikes: 0, lastattempt: minutesAgo(1) }],
        ['without a strike row, which loading inserts', null, false, null, { strikes: 0, lastattempt: minutesAgo(1) }],
      ] as const)('reads a user %s', async (_label, seeded, removeBlock, blockedUntil, stored) => {
        await seedStrike('tenant-a', 'ada', seeded);

        expect(await blocks().loadLoginBlock(handle.app, claimsFor('tenant-a'), ACTIVE.toLowerCase(), { removeBlock })).toEqual({ blockedUntil });
        expect(await storedStrike('tenant-a', 'ada')).toEqual(stored);
      });

      it('writes the strikes of a public-pool user in the account\'s own tenant, recording the actor and request id', async () => {
        await seedStrike('umbrella', 'pub', null);

        expect(await blocks().loadLoginBlock(handle.app, claimsFor('tenant-a'), PUBLIC, { removeBlock: false, requestId: 'req-login-block' })).toEqual({
          blockedUntil: null,
        });
        expect(await storedStrike('umbrella', 'pub')).toEqual({ strikes: 0, lastattempt: minutesAgo(1) });
        expect(await storedStrike('tenant-a', 'pub')).toBeNull();
        const logged = await gated('umbrella', (tx) =>
          tx.query<{ actor_user_id: string; request_id: string }>(
            `SELECT actor_user_id, request_id FROM ${handle.schema}.changelog WHERE "table" LIKE '%user_strike' ORDER BY seq DESC LIMIT 1`,
          ),
        );
        expect(logged.rows).toEqual([{ actor_user_id: 'test-people', request_id: 'req-login-block' }]);
      });

      it.each([false, true])('reads no strikes for a user with an empty user name (removeBlock %s)', async (removeBlock) => {
        expect(await blocks().loadLoginBlock(handle.app, claimsFor('tenant-a'), BARE, { removeBlock })).toEqual({ blockedUntil: null });
        expect(await storedStrike('tenant-a', '')).toBeNull();
      });

      it.each([
        ['a missing user', MISSING],
        ['a group', GROUP],
        ['a pending account', PENDING],
        ['a user outside the token site\'s pools', OTHER_TENANT],
      ])('answers null for %s and loads no strikes', async (_label, userId) => {
        expect(await blocks().loadLoginBlock(handle.app, claimsFor('tenant-a'), userId, { removeBlock: true })).toBeNull();
        expect(await storedStrike('tenant-b', 'bea')).toBeNull();
      });

      it('answers the legacy 503 once the user stays closed past the wait, loading no strikes', async () => {
        const operationId = await openOperation(CLOSED);
        try {
          await expect(blocks().loadLoginBlock(handle.app, claimsFor('tenant-a'), CLOSED, { removeBlock: false })).rejects.toMatchObject({
            reason: 'user-closed',
          });
        } finally {
          await endOperation(operationId);
        }
        expect(await storedStrike('tenant-a', 'cal')).toBeNull();
      });
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
        await expect(reads().lookupAccountsAllSites(handle.app, [OTHER_TENANT, CLOSED])).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
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
      ['lookupAccountsAllSites', LOGIN_STATE.unit, () => reads().lookupAccountsAllSites(handle.app, [ACTIVE])],
      ['lookupMemberships', MEMBERSHIP.unit, () => reads().lookupMemberships(handle.app, [ACTIVE])],
      ['loadLoginBlock', USER_STRIKE.unit, (claims: UserClaims) => reads().loadLoginBlock(handle.app, claims, ACTIVE, { removeBlock: false })],
    ])('answers %s with the legacy 503 while a window outlasts the gate wait', async (_label, unit, read) => {
      await setPhase(unit, 'importing');
      await expect(read(claimsFor('tenant-a'))).rejects.toBeInstanceOf(UnitReadBlockedError);
    });
  });

  describe('selective reads', () => {
    // list-site pools privately in itself and publicly in list-pool; pooled-site pools in both and stores one account itself.
    const W_ASSIGNED = id(21, 'E');
    const W_SPACED = id(22, 'E');
    const W_SUPER = id(23, 'E');
    const W_FOREIGN = id(24, 'E');
    const W_PENDING = id(25, 'E');
    const W_OTHER_SITE = id(26, 'E');
    const W_NO_SITE = id(27, 'E');
    const P_MEMBER = id(31, 'E');
    const P_CASED = id(32, 'E');
    const P_UNREGISTERED = id(33, 'E');
    const Z_POOLED = id(34, 'E');
    const LIST_GROUP = id(39, 'E');
    const N_ALICE = id(41, 'F');
    const N_ALBERT = id(42, 'F');
    const N_UNDERSCORE = id(43, 'F');
    const N_BACKSLASH = id(44, 'F');
    const N_BRACKET = id(45, 'F');
    const N_PLAIN = id(46, 'F');
    const N_NULL = id(47, 'F');
    const N_ACCENT = id(48, 'F');
    const N_RUN = id(49, 'F');
    const N_PENDING = id(50, 'F');
    const N_ELSEWHERE = id(51, 'F');
    const N_PUBLIC = id(52, 'F');

    const POOL_PRIVATE_USERS = [W_ASSIGNED, W_SPACED, W_SUPER, W_FOREIGN, W_PENDING];
    const POOL_PUBLIC_USERS = [P_MEMBER, P_CASED, P_UNREGISTERED];
    const TENANT_USERS = [...POOL_PRIVATE_USERS, W_OTHER_SITE, W_NO_SITE];
    const LIST_USERS = [...TENANT_USERS, ...POOL_PUBLIC_USERS];
    const NAME_USERS = [N_ALICE, N_ALBERT, N_UNDERSCORE, N_BACKSLASH, N_BRACKET, N_PLAIN, N_NULL, N_ACCENT, N_RUN, N_PENDING, N_ELSEWHERE, N_PUBLIC];
    // Every account stored in a registered tenant: the outer seed's but POOL_ONLY and UNLISTED, and this suite's.
    const ALL_SITES_USERS = [ACTIVE, PENDING, CLOSED, BARE, PUBLIC, OTHER_TENANT, DEFAULT_USER, ...LIST_USERS, Z_POOLED, ...NAME_USERS];
    const RUN = 'a'.repeat(255);

    const reads = (waitMs = SHORT_MS): ReturnType<typeof createAccountReads> =>
      createAccountReads({ repo, closedUserWaitMs: waitMs, gateWaitMs: SHORT_MS });

    async function ids(found: Promise<Array<{ UserID: string }>>): Promise<string[]> {
      return (await found).map((record) => record.UserID);
    }

    /** Opens an update operation on `userId` in `site`'s tenant; the returned function finishes it. */
    async function openIn(site: string, userId: string): Promise<() => Promise<void>> {
      const op = await gated(site, (tx) => repo.insertAccountOperation(tx, { user_id: userId, kind: 'update', state: 'prepared' }));
      return async () => {
        await gated(site, (tx) => repo.setAccountOperationState(tx, op.operation_id, ['prepared', 'committed'], 'finished'));
      };
    }

    beforeAll(async () => {
      await registerSite('list-site', 'list-site', 'list-pool');
      await registerSite('list-pool', 'list-pool', 'list-pool');
      await registerSite('pooled-site', 'list-site', 'list-pool');
      await registerSite('name-site', 'name-site', 'name-pool');
      await registerSite('name-pool', 'name-pool', 'name-pool');
      const listed = (userid: string, values: Partial<AccountInput>): AccountInput => account(userid, `u${userid.slice(-2)}`, { siteid: 'list-site', ...values });
      await gated('list-site', async (tx) => {
        await repo.insertAccount(tx, listed(W_ASSIGNED, {}));
        await repo.insertAccount(tx, listed(W_SPACED, { s2: null, siteid: 'LIST-SITE ' }));
        await repo.insertAccount(tx, listed(W_SUPER, { ispublic: 1, s2: 1, inactive: 1 }));
        await repo.insertAccount(tx, listed(W_FOREIGN, { ispublic: null, inactive: null }));
        await repo.insertAccount(tx, listed(W_PENDING, { opt2_state: 'pending' }));
        await repo.insertAccount(tx, listed(W_OTHER_SITE, { s2: 2, siteid: 'elsewhere' }));
        await repo.insertAccount(tx, listed(W_NO_SITE, { siteid: '' }));
        await repo.insertGroup(tx, groupInput({ userid: LIST_GROUP, groupname: 'Listers', siteid: 'list-site' }), null);
        await repo.addMembership(tx, W_ASSIGNED, LIST_GROUP);
      });
      await gated('list-pool', async (tx) => {
        await repo.insertAccount(tx, listed(P_MEMBER, { ispublic: 1, siteid: 'list-pool' }));
        await repo.insertAccount(tx, listed(P_CASED, { ispublic: 1, siteid: 'List-Pool' }));
        await repo.insertAccount(tx, listed(P_UNREGISTERED, { s2: 1, siteid: 'list-pool' }));
        await repo.addMembership(tx, P_MEMBER, LIST_GROUP);
        // A row of a member stored in list-site, as an orphan import leaves it.
        await repo.addMembership(tx, W_FOREIGN, LIST_GROUP);
      });
      await gated('pooled-site', (tx) => repo.insertAccount(tx, listed(Z_POOLED, { siteid: 'pooled-site' })));
      // Rows in tenants no site registers count for no read.
      await gated('nowhere', (tx) => repo.addMembership(tx, P_UNREGISTERED, LIST_GROUP));
      await gated('unregistered-pool', (tx) => repo.addMembership(tx, POOL_ONLY, LIST_GROUP));
      const named = (userid: string, username: string, values: Partial<AccountInput> = {}): AccountInput =>
        account(userid, username, { siteid: 'name-site', ...values });
      await gated('name-site', async (tx) => {
        await repo.insertAccount(tx, named(N_ALICE, 'Alice'));
        await repo.insertAccount(tx, named(N_ALBERT, 'ALBERT', { inactive: 1, siteid: 'NAME-SITE' }));
        await repo.insertAccount(tx, named(N_UNDERSCORE, 'al_x'));
        await repo.insertAccount(tx, named(N_BACKSLASH, 'a\\b'));
        await repo.insertAccount(tx, named(N_BRACKET, '[x]yz'));
        await repo.insertAccount(tx, named(N_PLAIN, 'xyz'));
        await repo.insertAccount(tx, named(N_NULL, ''));
        await repo.insertAccount(tx, named(N_ACCENT, 'Élan'));
        await repo.insertAccount(tx, named(N_RUN, RUN));
        await repo.insertAccount(tx, named(N_PENDING, 'alpha', { opt2_state: 'pending' }));
        await repo.insertAccount(tx, named(N_ELSEWHERE, 'alpine', { siteid: 'elsewhere' }));
      });
      await gated('name-pool', (tx) => repo.insertAccount(tx, named(N_PUBLIC, 'Alfred', { ispublic: 1, siteid: 'name-pool' })));
    });

    it('reads the members of this tenant\'s membership rows that no account or group here stores, listed or all', async () => {
      expect(await gated('list-pool', (tx) => repo.foreignMemberIds(tx, null))).toEqual([W_FOREIGN]);
      expect(await gated('list-pool', (tx) => repo.foreignMemberIds(tx, [P_MEMBER, W_FOREIGN.toLowerCase()]))).toEqual([W_FOREIGN]);
      expect(await gated('list-pool', (tx) => repo.foreignMemberIds(tx, [P_MEMBER]))).toEqual([]);
      expect(await gated('umbrella', (tx) => repo.foreignMemberIds(tx, null))).toEqual([ACTIVE]);
    });

    const WHERES: Array<[string, AccountWhere, string[]]> = [
      ['no predicate', {}, [W_ASSIGNED, W_SPACED, W_SUPER, W_FOREIGN, W_OTHER_SITE, W_NO_SITE, P_MEMBER, P_CASED, P_UNREGISTERED]],
      ['isPublic 0', { isPublic: 0 }, [W_ASSIGNED, W_SPACED, W_OTHER_SITE, W_NO_SITE, P_UNREGISTERED]],
      ['isPublic 1', { isPublic: 1 }, [W_SUPER, P_MEMBER, P_CASED]],
      ['isPublic 0.5', { isPublic: 0.5 }, []],
      ['s2 0', { s2: 0 }, [W_ASSIGNED, W_FOREIGN, W_NO_SITE, P_MEMBER, P_CASED]],
      ['excludeS2Users', { excludeS2Users: true }, [W_ASSIGNED, W_FOREIGN, W_OTHER_SITE, W_NO_SITE, P_MEMBER, P_CASED]],
      ['inActive 1', { inActive: 1 }, [W_SUPER]],
      ['inActive 0', { inActive: 0 }, [W_ASSIGNED, W_SPACED, W_OTHER_SITE, W_NO_SITE, P_MEMBER, P_CASED, P_UNREGISTERED]],
      ['one site id', { siteIds: ['list-site'] }, [W_ASSIGNED, W_SPACED, W_SUPER, W_FOREIGN]],
      ['site ids in other case and with trailing spaces', { siteIds: ['LIST-POOL', 'elsewhere  '] }, [W_OTHER_SITE, P_MEMBER, P_CASED, P_UNREGISTERED]],
      ['unassigned', { unassigned: true }, [W_SPACED, W_SUPER, W_OTHER_SITE, W_NO_SITE, P_CASED, P_UNREGISTERED]],
      ['unassigned, isPublic 0 and excludeS2Users', { unassigned: true, isPublic: 0, excludeS2Users: true }, [W_OTHER_SITE, W_NO_SITE]],
      ['false flags', { unassigned: false, excludeS2Users: false }, [W_ASSIGNED, W_SPACED, W_SUPER, W_FOREIGN, W_OTHER_SITE, W_NO_SITE, P_MEMBER, P_CASED, P_UNREGISTERED]],
    ];

    it.each(WHERES)('looks the listed users up with %s, in request order', async (_label, where, expected) => {
      expect(await ids(reads().lookupAccounts(handle.app, claimsFor('list-site'), LIST_USERS, where))).toEqual(expected);
    });

    it('looks users up across every registered site without membership rows in any registered tenant', async () => {
      const userIds = [POOL_ONLY, ACTIVE, PUBLIC, OTHER_TENANT, DEFAULT_USER, BARE, W_FOREIGN];
      expect(await ids(reads().lookupAccountsAllSites(handle.app, userIds, { unassigned: true }))).toEqual([POOL_ONLY, OTHER_TENANT, DEFAULT_USER, BARE]);
      expect(await ids(reads().lookupAccountsAllSites(handle.app, userIds, { siteIds: ['TENANT-B', 'default'] }))).toEqual([OTHER_TENANT, DEFAULT_USER]);
    });

    const SCOPES: Array<[string, AccountCountRequest['scope'], boolean | undefined, string[], number]> = [
      ['the private pool', 'pool', false, POOL_PRIVATE_USERS, 4],
      ['the public pool', 'pool', true, POOL_PUBLIC_USERS, 3],
      ['the token tenant', 'tenant', undefined, TENANT_USERS, 6],
      ['every registered site', 'all-sites', undefined, ALL_SITES_USERS, 27],
    ];

    it.each(SCOPES.flatMap(([label, scope, publicPool, users, all]) => WHERES.map(([whereLabel, where]) => [label, whereLabel, scope, publicPool, users, all, where] as const)))(
      'counts %s with %s as many accounts as the lookup of the scope\'s users finds',
      async (_label, _whereLabel, scope, publicPool, users, all, where) => {
        const claims = claimsFor('list-site');
        const found = scope === 'all-sites' ? reads().lookupAccountsAllSites(handle.app, users, where) : reads().lookupAccounts(handle.app, claims, users, where);
        const count = await reads().countAccounts(handle.app, claims, { scope, ...(publicPool === undefined ? {} : { publicPool }), where });

        expect(count).toBe((await found).length);
        if (Object.keys(where).length === 0) expect(count).toBe(all);
      },
    );

    it.each([
      ['pooled-site', 'pool', false, 4],
      ['pooled-site', 'pool', true, 3],
      ['pooled-site', 'tenant', undefined, 0],
      ['poolless', 'tenant', undefined, 0],
      ['poolless', 'pool', true, 0],
      ['unregistered', 'pool', false, 0],
      ['unregistered', 'tenant', undefined, 0],
    ] as const)('counts %s scope %s (publicPool %s) from the registry only', async (site, scope, publicPool, expected) => {
      const request: AccountCountRequest = publicPool === undefined ? { scope } : { scope, publicPool };
      expect(await reads().countAccounts(handle.app, claimsFor(site), request)).toBe(expected);
    });

    it('counts without a closed user\'s wait elsewhere, but answers the legacy 503 for a scope holding one, matched or not', async () => {
      const finish = await openIn('list-site', W_SPACED);
      try {
        const claims = claimsFor('list-site');
        expect(await reads().countAccounts(handle.app, claims, { scope: 'pool', publicPool: true })).toBe(3);
        for (const where of [{}, { isPublic: 1 }]) {
          const error = await reads().countAccounts(handle.app, claims, { scope: 'pool', publicPool: false, where }).catch((err: unknown) => err);
          expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
          expect(error).toMatchObject({ reason: 'user-closed', surface: 'auto' });
        }
        await expect(reads().countAccounts(handle.app, claims, { scope: 'all-sites' })).rejects.toMatchObject({ reason: 'user-closed' });
        await expect(reads().lookupAccounts(handle.app, claims, [W_ASSIGNED, W_SPACED], { isPublic: 1 })).rejects.toMatchObject({ reason: 'user-closed' });
      } finally {
        await finish();
      }
    });

    it('waits while a counted user is closed and counts once the operation ends', async () => {
      const finish = await openIn('list-site', W_PENDING);
      const started = Date.now();
      const counted = reads(LONG_MS).countAccounts(handle.app, claimsFor('list-site'), { scope: 'tenant', where: { unassigned: true } });
      await sleep(RELEASE_AFTER_MS);
      await finish();

      expect(await counted).toBe(4);
      expect(Date.now() - started).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
    });

    it.each([
      ['an unassigned count', MEMBERSHIP.unit, () => reads().countAccounts(handle.app, claimsFor('list-site'), { scope: 'tenant', where: { unassigned: true } })],
      ['an unassigned lookup', MEMBERSHIP.unit, () => reads().lookupAccounts(handle.app, claimsFor('list-site'), [W_ASSIGNED], { unassigned: true })],
      ['a count', USER_ACCOUNT.unit, () => reads().countAccounts(handle.app, claimsFor('list-site'), { scope: 'tenant' })],
      ['a candidate read', USER_ACCOUNT.unit, () => reads().lookupUsernameCandidates(handle.app, claimsFor('name-site'), { publicPool: false, pattern: '%', limit: 1 })],
    ])('answers %s with the legacy 503 while a window on %s outlasts the gate wait', async (_label, unit, read) => {
      await setPhase(unit, 'importing');
      await expect(read()).rejects.toBeInstanceOf(UnitReadBlockedError);
    });

    it('counts and looks up without the membership unit when no unassigned filter asks for it', async () => {
      await setPhase(MEMBERSHIP.unit, 'importing');
      expect(await reads().countAccounts(handle.app, claimsFor('list-site'), { scope: 'tenant', where: { isPublic: 0 } })).toBe(4);
      expect(await ids(reads().lookupAccounts(handle.app, claimsFor('list-site'), [W_SUPER], { inActive: 1 }))).toEqual([W_SUPER]);
    });

    const candidates = (pattern: string, overrides: Partial<UsernameCandidateRequest> = {}, site = 'name-site') =>
      reads().lookupUsernameCandidates(handle.app, claimsFor(site), { publicPool: false, pattern, limit: 50, ...overrides });

    it.each([
      ['a prefix in another case', 'AL%', [N_ALICE, N_ALBERT, N_UNDERSCORE]],
      ['a lower-case prefix', 'al%', [N_ALICE, N_ALBERT, N_UNDERSCORE]],
      ['an _ wildcard', 'a_i%', [N_ALICE]],
      ['a literal backslash', 'a\\b', [N_BACKSLASH]],
      ['a backslash before %', 'a\\%', [N_BACKSLASH]],
      ['a literal [', '[x]%', [N_BRACKET]],
      ['%, which no NULL user name matches', '%', [N_ALICE, N_ALBERT, N_UNDERSCORE, N_BACKSLASH, N_BRACKET, N_PLAIN, N_ACCENT, N_RUN]],
      ['a non-ASCII letter in another case, which C does not fold', 'é%', []],
      ['a non-ASCII letter in its stored case', 'É%', [N_ACCENT]],
    ])('lists the pool\'s user names matching %s by user id', async (_label, pattern, expected) => {
      const { items, complete } = await candidates(pattern);

      expect(items.map((item) => item.userId)).toEqual(expected);
      expect(complete).toBe(true);
    });

    it('answers each candidate with its stored user name, applies where and reads the public pool on request', async () => {
      expect((await candidates('al%')).items).toEqual([
        { userId: N_ALICE, username: 'Alice' },
        { userId: N_ALBERT, username: 'ALBERT' },
        { userId: N_UNDERSCORE, username: 'al_x' },
      ]);
      expect((await candidates('al%', { where: { inActive: 0 } })).items.map((item) => item.userId)).toEqual([N_ALICE, N_UNDERSCORE]);
      expect((await candidates('al%', { publicPool: true })).items).toEqual([{ userId: N_PUBLIC, username: 'Alfred' }]);
      expect(await candidates('%', {}, 'unregistered')).toEqual({ items: [], complete: true });
    });

    it.each([
      [3, [N_ALICE, N_ALBERT, N_UNDERSCORE], false],
      [7, [N_ALICE, N_ALBERT, N_UNDERSCORE, N_BACKSLASH, N_BRACKET, N_PLAIN, N_ACCENT], false],
      [8, [N_ALICE, N_ALBERT, N_UNDERSCORE, N_BACKSLASH, N_BRACKET, N_PLAIN, N_ACCENT, N_RUN], true],
    ])('answers at most %s candidates and whether they were all', async (limit, expected, complete) => {
      const list = await candidates('%', { limit });

      expect(list.items.map((item) => item.userId)).toEqual(expected);
      expect(list.complete).toBe(complete);
    });

    it('matches a backtracking-shaped pattern against a 255-character run promptly', async () => {
      const started = Date.now();

      expect((await candidates('a%a%a%a%a%a%a%a%a%a%a%a%b')).items).toEqual([]);
      expect((await candidates('a%a%a%a%a%a%a%a%a%a%a%a%')).items).toEqual([{ userId: N_RUN, username: RUN }]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('answers the legacy 503 once a read candidate stays closed past the wait, and reads past a closed user it does not match', async () => {
      const finish = await openIn('name-site', N_ALICE);
      try {
        await expect(candidates('alice')).rejects.toMatchObject({ reason: 'user-closed', surface: 'auto' });
        expect((await candidates('al_x')).items).toEqual([{ userId: N_UNDERSCORE, username: 'al_x' }]);
      } finally {
        await finish();
      }
    });

    it('waits while a read candidate is closed and lists it once the operation ends', async () => {
      const finish = await openIn('name-site', N_ALICE);
      const started = Date.now();
      const list = createAccountReads({ repo, closedUserWaitMs: LONG_MS }).lookupUsernameCandidates(handle.app, claimsFor('name-site'), {
        publicPool: false,
        pattern: 'alice',
        limit: 1,
      });
      await sleep(RELEASE_AFTER_MS);
      await finish();

      expect(await list).toEqual({ items: [{ userId: N_ALICE, username: 'Alice' }], complete: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
    });
  });
});
