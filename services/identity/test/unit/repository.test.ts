/** Identity repository helpers against a throwaway `identity` schema: changelog rows, write positions, gates, legacy lookup and NULL rules, id sequences, single-winner claims and tenant isolation. */
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  RepositoryError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  ensureUnitGates,
  requestMigrationAuthority,
  withGatedTenant,
  type GatePhase,
  type GateState,
} from '@opt2/platform/migration-kit';
import { Roles } from '@opt2/platform/auth';
import { tenantIdForSite, withMetadata, type QueryConfig, type QueryResultRow, type TenantTx } from '@opt2/platform/tenancy';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  OWNER,
  SCHEMA,
  createIdentityRepository,
  lastUpdateInfo,
  type AccountInput,
  type GroupInput,
  type IdentityRepository,
} from '../../src/repo/repository.js';
import { GROUP_ACCOUNT, IDENTITY_UNITS, OWNED_TABLES, USER_ACCOUNT, type GroupAccountRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0);
const CLOCK = fixedClock(NOW);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const BUDGET_MS = 300;
const SNAPSHOT_ACTOR = { userId: 'A0000000-0000-0000-0000000000000001', fname: 'Ada', lname: 'Admin', fromSnapshot: true };

function id(n: number, prefix = 'U'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

function groupInput(overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    groupname: 'Editors', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 1, siteid: 'site-a',
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...overrides,
  };
}

function account(userid: string, username: string, overrides: Partial<AccountInput> = {}): AccountInput {
  return { userid, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: 'site-a', remoteid: '', tablist: '', ...overrides };
}

describe('identity repository surface', () => {
  it('extends the platform repository of the owned tables and exposes it as base', () => {
    const repository = createIdentityRepository({ clock: CLOCK });

    expect([OWNER, SCHEMA]).toEqual(['identity', 'identity']);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'identity', schema: 'identity' });
    expect(repository.units()).toEqual([...IDENTITY_UNITS]);
    expect(repository.base.units()).toEqual([...IDENTITY_UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table).table)).toEqual(OWNED_TABLES.map((table) => table.table));
  });

  it.each([
    ['a snapshot actor by its own names', SNAPSHOT_ACTOR, null, { lastupdateby: 'Ada Admin', lastupdatebyid: SNAPSHOT_ACTOR.userId }],
    ['an actor without a snapshot by its person contact', { userId: 'T1', fromSnapshot: false }, { fname: 'Rest', lname: 'Caller' }, { lastupdateby: 'Rest Caller', lastupdatebyid: 'T1' }],
    ['an actor without a snapshot or contact by a single space', { userId: 'T2', fromSnapshot: false }, null, { lastupdateby: ' ', lastupdatebyid: 'T2' }],
    ['no actor by the row itself', null, null, { lastupdateby: 'Row Self', lastupdatebyid: 'ROW' }],
  ] as const)('names %s', (_label, actor, contact, expected) => {
    expect(lastUpdateInfo(actor, { userid: 'ROW', fname: 'Row', lname: 'Self' }, contact)).toEqual(expected);
  });

  it('keeps a single space for two empty names and cuts the label at 50 UTF-16 units', () => {
    expect(lastUpdateInfo(null, { userid: 'R', fname: null, lname: null })).toEqual({ lastupdateby: ' ', lastupdatebyid: 'R' });
    expect(lastUpdateInfo({ userId: 'X', fname: 'x'.repeat(49), lname: 'yz', fromSnapshot: true }, { userid: 'R', fname: '', lname: '' }).lastupdateby).toBe(
      `${'x'.repeat(49)} `,
    );
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('identity repository against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let tenants = 0;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    tenants += 1;
    tenantId = tenantIdForSite(`identity-repository-${tenants}`);
    otherTenantId = tenantIdForSite(`identity-repository-${tenants}-other`);
  });

  async function setGates(state: GateState, phase: GatePhase = 'quiet'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = $3`, [state, state === 'closed' ? 'test-holder' : null, phase]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function gated<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return withGatedTenant(handle.app, tenant, fn, { budgetMs: BUDGET_MS });
  }

  async function changelog(tenant = tenantId): Promise<{ table: string; op: string; before: string | null }[]> {
    return inTenant(
      async (tx) => (await tx.query<{ table: string; op: string; before: string | null }>(`SELECT "table", op, before FROM ${handle.schema}.changelog ORDER BY seq`)).rows,
      tenant,
    );
  }

  it('writes one changelog row per changed row in the business transaction and records the write position on commit', async () => {
    const store = newRequestContext();
    const group = await runWithRequestContext(store, () => gated((tx) => repo.insertGroup(tx, groupInput({ tags: 'a, b' }), SNAPSHOT_ACTOR)));
    await gated((tx) => repo.replaceGroupTags(tx, { groupId: group.userid, siteId: 'site-a', tags: ' red ,, blue , ' }));

    expect(store.writePositions.get('identity')).toMatch(/^\d+$/);
    expect((await changelog()).map(({ table, op }) => `${table}:${op}`)).toEqual(['group_account:insert', 'user_tag:insert', 'user_tag:insert']);

    const failed = gated(async (tx) => {
      await repo.updateGroup(tx, group.userid, groupInput({ groupname: 'Lost' }), null);
      throw new Error('abort');
    });
    await expect(failed).rejects.toThrow('abort');
    expect(await changelog()).toHaveLength(3);
  });

  it('inserts a group as userDAO.create does and updates only the userDAO.update columns', async () => {
    const created = await gated((tx) => repo.insertGroup(tx, groupInput({ groupname: 'Members', email: '', password: 'stored-hash' }), SNAPSHOT_ACTOR));

    expect(created.userid).toMatch(CF_UUID);
    expect(created).toMatchObject({ groupname: 'Members', email: null, fname: null, ext: null, admin: null, lastlogin: null, row_version: '1' });
    expect(created).toMatchObject({ lastupdateby: 'Ada Admin', lastupdatebyid: SNAPSHOT_ACTOR.userId, password: 'stored-hash', perm: 0 });
    expect([created.created, created.lastupdate, created.passwordcreated]).toEqual([NOW, NOW, NOW]);

    const lastLogin = new Date(2026, 0, 2, 3, 4, 5, 6);
    await gated((tx) => repo.update(tx, GROUP_ACCOUNT.table, { userid: created.userid }, { perm: 1, ext: 7, admin: 1, lastlogin: lastLogin }));
    const kept = (await gated((tx) => repo.updateGroup(tx, created.userid, groupInput({ groupname: 'Renamed', siteid: ' site-a ', password: '' }), null))) as GroupAccountRow;

    expect(kept).toMatchObject({ groupname: 'Renamed', siteid: 'site-a', password: 'stored-hash', perm: 1, ext: 7, admin: 1, row_version: '2' });
    expect([kept.lastlogin, kept.created]).toEqual([lastLogin, NOW]);
    expect(kept).toMatchObject({ lastupdateby: ' ', lastupdatebyid: created.userid });

    const changed = (await gated((tx) => repo.updateGroup(tx, created.userid, groupInput({ password: 'new-hash', siteid: '' }), null))) as GroupAccountRow;
    expect(changed).toMatchObject({ password: 'new-hash', siteid: '', row_version: '3' });
    expect(await gated((tx) => repo.updateGroup(tx, id(99, 'G'), groupInput(), null))).toBeNull();
  });

  it('rejects writes of a legacy unit, waits out a closed gate and blocks reads during a window', async () => {
    await setGates('legacy');
    await expect(gated((tx) => repo.insertGroup(tx, groupInput(), null))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await setGates('closed');
    const started = Date.now();
    await expect(gated((tx) => repo.insertGroup(tx, groupInput(), null))).rejects.toBeInstanceOf(GateClosedError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 50);
    await setGates('open', 'executing');
    await expect(gated((tx) => repo.listGroups(tx, 'site-a', 1))).rejects.toBeInstanceOf(UnitReadBlockedError);
    await setGates('open');
    expect(await gated((tx) => repo.listGroups(tx, 'site-a', 1))).toEqual([]);
  });

  it('finds active Type=2 accounts by trimmed, case-insensitive username ignoring trailing spaces and pending accounts', async () => {
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(2), 'admin  '));
      await repo.insertAccount(tx, account(id(1), 'ADMIN', { siteid: 'site-b' }));
      await repo.insertAccount(tx, account(id(3), 'pending', { opt2_state: 'pending' }));
      await repo.insertAccount(tx, account(id(4), 'gone', { inactive: 1 }));
      await repo.insertAccount(tx, account(id(5), '', { remoteid: 'r' }));
    });

    const found = await inTenant((tx) => repo.findAccountsByUsername(tx, ' Admin\t'));
    expect(found.map((row) => row.userid)).toEqual([id(1), id(2)]);
    expect((await inTenant((tx) => repo.findAccountByUsername(tx, 'admin', 'site-a')))?.userid).toBe(id(2));
    expect(await inTenant((tx) => repo.findAccountByUsername(tx, 'pending'))).toBeNull();
    expect(await inTenant((tx) => repo.findAccountByUsername(tx, 'gone'))).toBeNull();
    expect(await inTenant((tx) => repo.findAccountById(tx, id(3)))).toBeNull();
    expect(await inTenant((tx) => repo.findAccountById(tx, id(3), { includePending: true }))).toMatchObject({ opt2_state: 'pending' });
    expect(await inTenant((tx) => repo.findAccountById(tx, id(5)))).toMatchObject({ username: null, remoteid: 'r', tablist: null, admin: null });
    expect(await inTenant((tx) => repo.isUsernameTaken(tx, 'PENDING ', id(9)))).toBe(true);
    expect(await inTenant((tx) => repo.isUsernameTaken(tx, 'pending', id(3)))).toBe(false);
    expect(await inTenant((tx) => repo.findAccountByUsername(tx, 'admin'), otherTenantId)).toBeNull();
  });

  it('updates, re-states and deletes accounts with their credential and login state', async () => {
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(1), 'user', { opt2_state: 'pending' }));
      await repo.writeCredential(tx, id(1), { password: '', passwordcreated: NOW });
      await repo.insertLoginState(tx, id(1));
    });
    expect(await inTenant((tx) => repo.readCredential(tx, id(1)))).toMatchObject({ password: null, passwordcreated: NOW });

    const updated = await gated(async (tx) => {
      await repo.update(tx, USER_ACCOUNT.table, { userid: id(1) }, { perm: 1, admin: 1 });
      await repo.setAccountState(tx, id(1), 'active');
      await repo.writeCredential(tx, id(1), { password: 'hash', passwordcreated: NOW });
      await repo.touchLastLogin(tx, id(1), NOW);
      return repo.updateAccount(tx, id(1), { username: 'renamed', type: 2, s2: 1, inactive: 0, ispublic: 0, siteid: null, remoteid: '', tablist: 'x' });
    });
    expect(updated).toMatchObject({ username: 'renamed', s2: 1, siteid: '', remoteid: null, tablist: 'x', perm: 1, admin: 1, opt2_state: 'active' });
    expect(await inTenant((tx) => repo.readCredential(tx, id(1)))).toMatchObject({ password: 'hash' });
    expect(await inTenant((tx) => repo.findByKey(tx, 'login_state', { userid: id(1) }))).toMatchObject({ lastlogin: NOW });

    expect(await gated((tx) => repo.deleteAccount(tx, id(1)))).toBe(true);
    expect(await gated((tx) => repo.deleteAccount(tx, id(1)))).toBe(false);
    expect(await inTenant((tx) => repo.readCredential(tx, id(1)))).toBeNull();
  });

  it('looks groups up by id and case-insensitive name, and lists them by name with Admin excluded on request', async () => {
    const [admin, beta, alpha, priv] = await gated(async (tx) => [
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), groupname: 'Admin' }), null),
      await repo.insertGroup(tx, groupInput({ userid: id(2, 'G'), groupname: 'beta' }), null),
      await repo.insertGroup(tx, groupInput({ userid: id(3, 'G'), groupname: 'Alpha' }), null),
      await repo.insertGroup(tx, groupInput({ userid: id(4, 'G'), groupname: 'Private', ispublic: 0 }), null),
    ]);

    expect((await inTenant((tx) => repo.listGroups(tx, 'site-a', true))).map((row) => row.groupname)).toEqual(['Admin', 'Alpha', 'beta']);
    expect((await inTenant((tx) => repo.listGroups(tx, 'site-a', 1, { excludeAdmin: true }))).map((row) => row.groupname)).toEqual(['Alpha', 'beta']);
    expect((await inTenant((tx) => repo.listGroups(tx, 'site-a', false))).map((row) => row.userid)).toEqual([priv?.userid]);
    expect((await inTenant((tx) => repo.findGroupByName(tx, 'ALPHA ', { siteId: 'site-a' })))?.userid).toBe(alpha?.userid);
    expect(await inTenant((tx) => repo.findGroupByName(tx, 'alpha', { siteId: 'site-a', isPublic: false }))).toBeNull();
    expect((await inTenant((tx) => repo.findGroupByName(tx, 'private', { siteId: 'site-a', isPublic: false })))?.userid).toBe(priv?.userid);
    expect((await inTenant((tx) => repo.findGroupsByIds(tx, [id(2, 'G'), id(1, 'G'), id(9, 'G')]))).map((row) => row.userid)).toEqual([
      admin?.userid,
      beta?.userid,
    ]);
    expect(await inTenant((tx) => repo.findGroupsByIds(tx, []))).toEqual([]);
    expect(await inTenant((tx) => repo.findGroup(tx, id(1, 'G')), otherTenantId)).toBeNull();
    expect((await gated((tx) => repo.deleteGroupRow(tx, id(1, 'G'))))?.groupname).toBe('Admin');
    expect(await gated((tx) => repo.deleteGroupRow(tx, id(1, 'G')))).toBeNull();
  });

  it('writes group child rows only for groups, with negative descending ids for tags and extended data', async () => {
    const groupId = (await gated((tx) => repo.insertGroup(tx, groupInput(), null))).userid;
    await expect(gated((tx) => repo.replaceGroupTags(tx, { groupId: id(5), siteId: 'site-a', tags: 'x' }))).rejects.toBeInstanceOf(RepositoryError);

    const tags = await gated((tx) => repo.replaceGroupTags(tx, { groupId, siteId: '', tags: ' one, ,two,one ' }));
    expect(tags.map((row) => [row.tag, row.siteid])).toEqual([['one', ''], ['two', ''], ['one', '']]);
    expect(tags.every((row) => row.tagid < 0)).toBe(true);
    expect(tags.map((row) => row.tagid)).toEqual([...tags.map((row) => row.tagid)].sort((a, b) => b - a));
    expect(await gated((tx) => repo.replaceGroupTags(tx, { groupId, siteId: 'site-a', tags: null }))).toEqual([]);
    expect(await gated((tx) => repo.deleteGroupTags(tx, groupId))).toBe(0);

    const values = { siteid: 'site-a', attributevalue: '5', remoteid: '', datetimevalue: null, numericvalue: 5, stringvalue: '5' };
    const extend = await gated((tx) => repo.replaceGroupExtendData(tx, { groupId, rows: [{ attributeId: 7, values }, { attributeId: 8, values: null }] }));
    expect(extend).toHaveLength(1);
    expect(extend[0]).toMatchObject({ baseid: groupId, attributeid: 7, remoteid: '', numericvalue: 5 });
    expect(extend[0]?.dataid).toBeLessThan(0);
    const replaced = await gated((tx) => repo.replaceGroupExtendData(tx, { groupId, rows: [{ attributeId: 7, values: { ...values, stringvalue: '6' } }] }));
    expect(replaced[0]?.stringvalue).toBe('6');
    expect(await gated((tx) => repo.deleteGroupExtendData(tx, groupId))).toBe(1);

    await gated((tx) => repo.replaceGroupInterests(tx, { groupId, categoryIds: [id(1, 'C'), '', id(1, 'C'), id(2, 'C'), 'x'.repeat(36)] }));
    await gated((tx) => repo.replaceGroupInterests(tx, { groupId, categoryIds: [id(3, 'C'), id(1, 'C')], onlyCategoryIds: [id(2, 'C')] }));
    const interests = await inTenant(async (tx) => (await tx.query<{ categoryid: string }>(`SELECT categoryid FROM ${handle.schema}.user_interest ORDER BY categoryid`)).rows);
    expect(interests.map((row) => row.categoryid)).toEqual([id(1, 'C'), id(3, 'C')]);

    await gated((tx) => repo.insert(tx, 'user_favorite', { favoriteid: id(1, 'F'), userid: groupId, favorite: 'f', type: 'Link', datecreated: NOW }));
    expect(await gated((tx) => repo.deleteGroupFavorites(tx, groupId))).toBe(1);
  });

  it('keeps one primary group address and deletes addresses with their extended data', async () => {
    const groupId = (await gated((tx) => repo.insertGroup(tx, groupInput(), null))).userid;
    const first = await gated((tx) => repo.insertGroupAddress(tx, { userid: groupId, siteid: 'site-a', city: '' }));
    const second = await gated((tx) => repo.insertGroupAddress(tx, { userid: groupId, addressid: id(2, 'D'), addressname: 'Office', isprimary: 0 }));
    expect(first).toMatchObject({ addressname: 'Primary', isprimary: 1, longitude: 0, latitude: 0, city: null });
    expect(first.addressid).toMatch(CF_UUID);

    const logged = (await changelog()).length;
    await gated((tx) => repo.setPrimaryGroupAddress(tx, groupId, second.addressid));
    expect((await changelog()).slice(logged).map(({ table, op }) => `${table}:${op}`)).toEqual(['user_address:update', 'user_address:update']);
    expect((await inTenant((tx) => repo.listGroupAddresses(tx, groupId))).map((row) => [row.addressid, row.isprimary])).toEqual([
      [second.addressid, 1],
      [first.addressid, 0],
    ]);
    const updated = await gated((tx) => repo.updateGroupAddress(tx, second.addressid, { userid: groupId, city: 'Rome', siteid: ' site-a ' }));
    expect(updated).toMatchObject({ city: 'Rome', siteid: 'site-a', addressname: null, isprimary: 1 });

    await gated((tx) => repo.insert(tx, 'extend_data_user_activity', { dataid: 11, baseid: second.addressid, attributeid: 1, siteid: 'site-a' }));
    expect(await gated((tx) => repo.deleteGroupAddresses(tx, groupId))).toBe(2);
    expect(await inTenant((tx) => repo.findByKey(tx, 'extend_data_user_activity', { dataid: 11 }))).toBeNull();
  });

  it('replaces, clears, adds and removes memberships, and lists members by last name without S2 or pending accounts', async () => {
    const [pub, priv, other] = await gated(async (tx) => [
      (await repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), groupname: 'Public' }), null)).userid,
      (await repo.insertGroup(tx, groupInput({ userid: id(2, 'G'), groupname: 'Private', ispublic: 0 }), null)).userid,
      (await repo.insertGroup(tx, groupInput({ userid: id(3, 'G'), groupname: 'Other', siteid: 'site-b' }), null)).userid,
    ]);
    const result = await gated((tx) => repo.replaceMemberships(tx, { userId: id(1), groupIds: [pub, '', pub, priv, other, id(8, 'G')] }));
    expect(result).toEqual({ removed: [], added: [pub, priv, other, id(8, 'G')] });
    expect(await inTenant((tx) => repo.membershipGroupIds(tx, id(1)))).toEqual([pub, priv, other, id(8, 'G')]);
    expect((await inTenant((tx) => repo.membershipsOf(tx, id(1)))).map((row) => [row.userId, row.groupName, row.isPublic])).toEqual([
      [pub, 'Public', 1],
      [priv, 'Private', 0],
      [other, 'Other', 1],
    ]);

    const restricted = await gated((tx) => repo.replaceMemberships(tx, { userId: id(1), groupIds: [pub], onlyGroupIds: [pub, other] }));
    expect(restricted).toEqual({ removed: [pub, other], added: [pub] });
    expect(await gated((tx) => repo.clearBadMemberships(tx, { userId: id(1), siteId: 'site-a', s2: 1, ispublic: 1 }))).toEqual([]);
    expect(await gated((tx) => repo.clearBadMemberships(tx, { userId: id(1), siteId: 'site-a', s2: 0, ispublic: 0 }))).toEqual([]);
    expect(await gated((tx) => repo.clearBadMemberships(tx, { userId: id(1), siteId: 'site-a', s2: 0, ispublic: 1 }))).toEqual([priv, id(8, 'G')]);
    expect(await gated((tx) => repo.addMembership(tx, id(1), pub))).toBe(false);
    expect(await gated((tx) => repo.addMembership(tx, id(1), ''))).toBe(false);
    expect(await gated((tx) => repo.removeMembership(tx, id(1), pub))).toBe(true);
    expect(await gated((tx) => repo.removeMembership(tx, id(1), pub))).toBe(false);

    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(2), 'zed'));
      await repo.insertAccount(tx, account(id(3), 'amy'));
      await repo.insertAccount(tx, account(id(4), 'boss', { s2: 1 }));
      await repo.insertAccount(tx, account(id(5), 'new', { opt2_state: 'pending' }));
      await repo.upsertPersonContact(tx, { user_id: id(2), site_id: 'site-a', email: 'z@x', fname: 'Zed', lname: 'Zulu', company: null, subtype: null, aggregate_version: 1 });
      await repo.upsertPersonContact(tx, { user_id: id(3), site_id: 'site-a', email: 'a@x', fname: 'Amy', lname: 'alpha', company: null, subtype: null, aggregate_version: 1 });
      for (const member of [id(2), id(3), id(4), id(5), other]) {
        await repo.addMembership(tx, member, pub);
      }
    });
    expect((await inTenant((tx) => repo.membersOf(tx, pub))).map((row) => row.userid)).toEqual([other, id(3), id(2)]);
    expect((await inTenant((tx) => repo.membersOf(tx, pub, { includeS2: true }))).map((row) => row.userid)).toEqual([other, id(4), id(3), id(2)]);
    expect((await inTenant((tx) => repo.membersOf(tx, pub)))[1]).toMatchObject({ fname: 'Amy', email: 'a@x', type: 2 });
    expect(await inTenant((tx) => repo.membersOf(tx, pub), otherTenantId)).toEqual([]);
  });

  it('replaces node and module permissions and reads module grants', async () => {
    const node = id(1, 'N');
    const grants = [{ groupId: id(2, 'G'), type: 'Editor' }, { groupId: id(1, 'G'), type: 'Read' }];
    expect((await gated((tx) => repo.replaceNodePermissions(tx, { contentId: node, siteId: 'site-a', grants }))).map((row) => row.type)).toEqual(['Editor', 'Read']);
    await gated((tx) => repo.replaceNodePermissions(tx, { contentId: node, siteId: 'site-a', grants: grants.slice(1) }));
    expect((await inTenant((tx) => repo.permissionsFor(tx, { contentId: node, siteId: 'site-a' }))).map((row) => row.groupid)).toEqual([id(1, 'G')]);
    expect(await inTenant((tx) => repo.permissionsFor(tx, { contentId: node, siteId: 'site-a', type: 'Editor' }))).toEqual([]);

    const moduleId = '00000000000000000000000000000000008';
    const granted = await gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-a', groupIds: [id(1, 'G'), '', id(2, 'G')] }));
    expect([granted.rows.map((row) => row.groupid), granted.removed]).toEqual([[id(1, 'G'), id(2, 'G')], []]);
    expect(await inTenant((tx) => repo.moduleGrants(tx, [id(2, 'G'), id(3, 'G')], 'site-a'))).toEqual([{ contentId: moduleId, groupId: id(2, 'G') }]);
    expect(await inTenant((tx) => repo.moduleGrants(tx, [], 'site-a'))).toEqual([]);
    const regranted = await gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-a', groupIds: [id(2, 'G')] }));
    expect(regranted.removed.map((row) => [row.groupid, row.type])).toEqual([
      [id(1, 'G'), 'module'],
      [id(2, 'G'), 'module'],
    ]);
    await expect(gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-a', groupIds: [id(1, 'G'), id(1, 'G')] }))).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('reads the permissions of a group in one site, and reads inside a migration apply without waiting out its window import', async () => {
    const node = id(2, 'N');
    const moduleId = '00000000000000000000000000000000008';
    await gated((tx) => repo.replaceNodePermissions(tx, { contentId: node, siteId: 'site-a', grants: [{ groupId: id(1, 'G'), type: 'Read' }] }));
    await gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-a', groupIds: [id(1, 'G'), id(2, 'G')] }));
    await gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-b', groupIds: [id(1, 'G')] }));
    const rows = await inTenant((tx) => repo.groupPermissions(tx, id(1, 'G'), 'site-a'));
    expect(rows.map((row) => [row.contentid, row.siteid, row.type])).toEqual([[moduleId, 'site-a', 'module'], [node, 'site-a', 'Read']]);

    await gated((tx) => repo.insertAccount(tx, account(id(1), 'apply-user')));
    await gated((tx) => repo.addMembership(tx, id(1), id(1, 'G')));
    const migration = { ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } };
    const write = { origin: 'legacy-window' as const, authority: runWithRequestContext(migration, () => requestMigrationAuthority()) };
    await setGates('closed', 'importing');
    await expect(gated((tx) => repo.membershipGroupIds(tx, id(1)))).rejects.toBeInstanceOf(UnitReadBlockedError);
    expect(await inTenant((tx) => repo.membershipGroupIds(tx, id(1), write))).toEqual([id(1, 'G')]);
    expect(await inTenant((tx) => repo.findAccountById(tx, id(1), {}, write))).toMatchObject({ username: 'apply-user' });
    expect(await inTenant((tx) => repo.groupPermissions(tx, id(1, 'G'), 'site-a', write))).toHaveLength(2);
  });

  it('keeps strike rows as userstrikes.cfc does, matched without case or trailing spaces', async () => {
    const ensured = await gated((tx) => repo.ensureStrike(tx, 'Admin', NOW));
    expect(ensured).toMatchObject({ username: 'Admin', strikes: 0, lastattempt: new Date(NOW.getTime() - 60_000) });
    expect((await gated((tx) => repo.ensureStrike(tx, 'admin ', NOW))).username).toBe('Admin');
    expect(await gated((tx) => repo.addStrike(tx, 'ADMIN', NOW))).toMatchObject({ strikes: 1, lastattempt: NOW });
    expect(await gated((tx) => repo.setStrike(tx, 'admin', { strikes: null, lastattempt: null }))).toMatchObject({ strikes: null });
    expect(await gated((tx) => repo.addStrike(tx, 'admin', NOW))).toMatchObject({ strikes: null, lastattempt: NOW });
    expect(await gated((tx) => repo.addStrike(tx, 'nobody', NOW))).toBeNull();
    expect(await gated((tx) => repo.setStrike(tx, 'nobody', { strikes: 0, lastattempt: NOW }))).toBeNull();
    expect(await inTenant((tx) => repo.readStrike(tx, 'admin'), otherTenantId)).toBeNull();
  });

  it('stores sessions, remote sessions, devices and redirects with the ORM NULL rule', async () => {
    const session = await inTenant((tx) => repo.insertSession(tx, { session_id: 'S1', csrf_secret: id(1, 'K'), mode: 'legacy-primary', state: 'active' }));
    expect(session).toMatchObject({ epoch: '0', user_id: null, created_at: NOW, updated_at: NOW });
    expect(await inTenant((tx) => repo.updateSession(tx, 'S1', { epoch: 2, state: 'ended', ended_at: NOW }))).toMatchObject({ epoch: '2', state: 'ended' });
    expect(await inTenant((tx) => repo.findSession(tx, 'S1'), otherTenantId)).toBeNull();
    expect(await inTenant((tx) => repo.deleteSession(tx, 'S1'))).toBe(true);
    expect(await inTenant((tx) => repo.findSession(tx, 'S1'))).toBeNull();

    await gated((tx) => repo.saveRemoteSession(tx, { userid: id(1), authtoken: 'a'.repeat(32), data: '{}', created: NOW, lastaccessed: NOW }));
    expect((await inTenant((tx) => repo.findRemoteSessionByToken(tx, 'a'.repeat(32))))?.userid).toBe(id(1));
    expect((await inTenant((tx) => repo.findRemoteSession(tx, id(1))))?.data).toBe('{}');
    expect(await gated((tx) => repo.deleteRemoteSession(tx, id(1)))).toBe(true);

    expect(await gated((tx) => repo.saveDevice(tx, { deviceid: id(1, 'V'), userid: id(1), siteid: 'NULL', created: NOW, lastlogin: null }))).toMatchObject({ siteid: null });
    expect(await inTenant((tx) => repo.findDevice(tx, { userId: id(1), deviceId: id(1, 'V') }))).not.toBeNull();
    expect(await inTenant((tx) => repo.findDevice(tx, { userId: id(1), deviceId: id(1, 'V'), siteId: 'site-a' }))).toBeNull();

    const redirect = await gated((tx) => repo.insertRedirect(tx, { userid: id(1), siteid: '', url: 'https://example.test/' }));
    expect(redirect).toMatchObject({ siteid: null, created: NOW });
    expect(redirect.redirectid).toMatch(CF_UUID);
    expect((await inTenant((tx) => repo.findRedirect(tx, redirect.redirectid)))?.url).toBe('https://example.test/');
    await gated((tx) => repo.insertRedirect(tx, { userid: id(1), siteid: 'site-a', url: 'x' }));
    expect(await gated((tx) => repo.removePrevRedirects(tx, id(1)))).toBe(2);
  });

  it('merges admin session state by top-level key, replacing a given key whole', async () => {
    await inTenant((tx) => repo.insertSession(tx, { session_id: 'S1', csrf_secret: id(1, 'K'), mode: 'target-primary', state: 'active' }));
    expect(await inTenant((tx) => repo.readSessionAdminState(tx, 'S1'))).toEqual({});

    const first = { siteid: 'tenant-a', flash: { '1': { msg: 'Saved', siteid: 'tenant-a' } }, nextPreserveKey: 2 };
    expect(await inTenant((tx) => repo.mergeSessionAdminState(tx, 'S1', first))).toEqual(first);
    expect(await inTenant((tx) => repo.readSessionAdminState(tx, 'S1'))).toEqual(first);

    const second = { flash: { '2': { msg: 'Deleted' } }, rb: 'de_DE' };
    const merged = { siteid: 'tenant-a', flash: { '2': { msg: 'Deleted' } }, nextPreserveKey: 2, rb: 'de_DE' };
    expect(await inTenant((tx) => repo.mergeSessionAdminState(tx, 'S1', second))).toEqual(merged);
    expect(await inTenant((tx) => repo.readSessionAdminState(tx, 'S1'))).toEqual(merged);
    expect(JSON.parse((await inTenant((tx) => repo.findSession(tx, 'S1')))?.admin_state ?? 'null')).toEqual(merged);
    expect((await changelog()).filter(({ table }) => table === 'session').map(({ op }) => op)).toEqual(['insert', 'update', 'update']);

    expect(await inTenant((tx) => repo.readSessionAdminState(tx, 'S9'))).toBeNull();
    expect(await inTenant((tx) => repo.mergeSessionAdminState(tx, 'S9', { siteid: 'x' }))).toBeNull();
    expect(await inTenant((tx) => repo.readSessionAdminState(tx, 'S1'), otherTenantId)).toBeNull();
  });

  it('stores OAuth clients and tokens, reuses only user-bound unexpired tokens and purges day-old ones', async () => {
    const client = await gated((tx) =>
      repo.insertOAuthClient(tx, {
        clientsecret: '', siteid: 'site-a', granttype: 'client_credentials', userid: '', name: 'Client', created: NOW, lastupdate: NOW,
        description: 'null', redirecturl: '', lastupdatebidy: id(1), lastupdateby: 'Ada Admin',
      }),
    );
    expect(client).toMatchObject({ clientsecret: null, userid: null, description: null, lastupdatebidy: id(1) });
    const { tenant_id: _tenant, clientid: _clientid, ...values } = client;
    expect(await gated((tx) => repo.updateOAuthClient(tx, client.clientid, { ...values, name: 'Renamed', description: '' }))).toMatchObject({
      name: 'Renamed',
      description: null,
    });
    expect((await inTenant((tx) => repo.listOAuthClients(tx, 'site-a'))).map((row) => row.clientid)).toEqual([client.clientid]);
    expect(await inTenant((tx) => repo.findOAuthClient(tx, client.clientid), otherTenantId)).toBeNull();
    expect((await inTenant((tx) => repo.findOAuthClient(tx, client.clientid)))?.name).toBe('Renamed');

    const later = new Date(NOW.getTime() + 3_600_000);
    const old = new Date(2026, 5, 29, 11, 0, 0);
    await gated(async (tx) => {
      await repo.insertToken(tx, { token: `000${'A'.repeat(32)}`, clientid: client.clientid, granttype: 'client_credentials', userid: '', accesscode: '', data: '', expires: later });
      await repo.insertToken(tx, { token: `000${'B'.repeat(32)}`, clientid: client.clientid, granttype: 'client_credentials', userid: id(1), accesscode: 'CODE', data: null, expires: later });
      await repo.insertToken(tx, { token: `000${'C'.repeat(32)}`, clientid: client.clientid, granttype: 'client_credentials', userid: id(2), accesscode: null, data: null, expires: old });
      await repo.insertToken(tx, { token: `000${'D'.repeat(32)}`, clientid: client.clientid, granttype: 'client_credentials', userid: id(2), accesscode: null, data: null, expires: NOW });
    });
    const lookup = { clientId: client.clientid, grantType: 'client_credentials', now: NOW };
    expect(await inTenant((tx) => repo.findReusableToken(tx, { ...lookup, userId: '' }))).toBeNull();
    expect((await inTenant((tx) => repo.findReusableToken(tx, { ...lookup, userId: id(1) })))?.token).toBe(`000${'B'.repeat(32)}`);
    expect(await inTenant((tx) => repo.findReusableToken(tx, { ...lookup, userId: id(2) }))).toBeNull();
    expect((await inTenant((tx) => repo.findTokenByAccessCode(tx, 'CODE')))?.userid).toBe(id(1));
    expect(await inTenant((tx) => repo.findToken(tx, `000${'A'.repeat(32)}`))).toMatchObject({ userid: null, accesscode: null, data: null });

    expect(await gated((tx) => repo.purgeExpiredTokens(tx, lookup))).toBe(1);
    expect(await gated((tx) => repo.deleteTokensByUser(tx, id(2), [`000${'X'.repeat(32)}`]))).toBe(0);
    expect(await gated((tx) => repo.deleteTokensByUser(tx, id(2)))).toBe(1);
    expect(await gated((tx) => repo.deleteToken(tx, `000${'B'.repeat(32)}`))).toBe(true);
    expect(await gated((tx) => repo.deleteOAuthClient(tx, client.clientid))).toBe(true);
    expect(await inTenant((tx) => repo.findToken(tx, `000${'A'.repeat(32)}`))).toBeNull();
    expect(await gated((tx) => repo.deleteOAuthClient(tx, client.clientid))).toBe(false);
  });

  it('lets exactly one of two concurrent CSRF claims win and keeps the losing transaction usable', async () => {
    const claim = (delayBefore: number, holdAfter: number) =>
      inTenant(async (tx) => {
        await sleep(delayBefore);
        const row = await repo.insertCsrfClaim(tx, { sessionId: 'S1', token: 'TOKEN', state: 'used' });
        await sleep(holdAfter);
        await tx.query('SELECT 1');
        return row;
      });
    const [first, second] = await Promise.all([claim(0, 150), claim(50, 0)]);
    expect(first).toMatchObject({ state: 'used', claimed_at: NOW, used_at: NOW });
    expect(second).toBeNull();
    expect((await changelog()).filter(({ table }) => table === 'csrf_claim')).toHaveLength(1);

    expect(await inTenant((tx) => repo.insertCsrfClaim(tx, { sessionId: 'S1', token: 'PEND', state: 'pending-legacy' }))).toMatchObject({ used_at: null });
    expect(await inTenant((tx) => repo.setCsrfClaimState(tx, 'S1', 'PEND', 'used', 'pending-legacy'))).toBe(false);
    expect(await inTenant((tx) => repo.setCsrfClaimState(tx, 'S1', 'PEND', 'pending-legacy', 'used'))).toBe(true);
    expect(await inTenant((tx) => repo.setCsrfClaimState(tx, 'S1', 'NONE', 'pending-legacy', 'used'))).toBe(false);
    expect(await inTenant((tx) => repo.findCsrfClaim(tx, 'S1', 'PEND'))).toMatchObject({ state: 'used', used_at: NOW });
    expect((await inTenant((tx) => repo.listCsrfClaims(tx, 'S1', { state: 'used', since: NOW }))).map((row) => row.token)).toEqual(['PEND', 'TOKEN']);
    expect(await inTenant((tx) => repo.deleteCsrfClaim(tx, 'S1', 'PEND'))).toBe(true);
    expect(await inTenant((tx) => repo.purgeCsrfClaims(tx, { olderThan: NOW }))).toBe(0);
    expect(await inTenant((tx) => repo.purgeCsrfClaims(tx, { sessionId: 'S1', olderThan: new Date(NOW.getTime() + 1) }))).toBe(1);
  });

  it('records account operations, refuses a second open one and moves state by compare-and-set', async () => {
    const op = await inTenant((tx) => repo.insertAccountOperation(tx, { user_id: id(1), kind: 'create', state: 'prepared', username: 'Neo' }));
    expect(op.operation_id).toMatch(CF_UUID);
    await expect(inTenant((tx) => repo.insertAccountOperation(tx, { user_id: id(2), kind: 'create', state: 'prepared', username: 'neo' }))).rejects.toMatchObject({
      code: '23505',
    });
    expect((await inTenant((tx) => repo.findOpenAccountOperation(tx, { username: 'NEO' })))?.operation_id).toBe(op.operation_id);
    expect((await inTenant((tx) => repo.findOpenAccountOperation(tx, { userId: id(1) })))?.operation_id).toBe(op.operation_id);
    expect(await inTenant((tx) => repo.setAccountOperationState(tx, op.operation_id, ['committed'], 'finished'))).toBe(false);
    expect(await inTenant((tx) => repo.setAccountOperationState(tx, op.operation_id, ['prepared'], 'committed', { commit_xid: '42' }))).toBe(true);
    expect(await inTenant((tx) => repo.findAccountOperation(tx, op.operation_id))).toMatchObject({ state: 'committed', commit_xid: '42' });
    expect(await inTenant((tx) => repo.setAccountOperationState(tx, op.operation_id, ['committed'], 'finished'))).toBe(true);
    expect(await inTenant((tx) => repo.findOpenAccountOperation(tx, { userId: id(1) }))).toBeNull();
    expect(await inTenant((tx) => repo.setAccountOperationState(tx, id(9), ['prepared'], 'aborted'))).toBe(false);
  });

  it('finds the account operations among a list of ids in one query of the transaction tenant, matching ids as findAccountOperation does', async () => {
    const [first, second, foreign] = [id(1, 'C'), id(2, 'C'), id(3, 'C')];
    await inTenant(async (tx) => {
      await repo.insertAccountOperation(tx, { operation_id: second, user_id: id(2), kind: 'update', state: 'committed' });
      await repo.insertAccountOperation(tx, { operation_id: first, user_id: id(1), kind: 'create', state: 'prepared' });
    });
    await inTenant((tx) => repo.insertAccountOperation(tx, { operation_id: foreign, user_id: id(3), kind: 'create', state: 'prepared' }), otherTenantId);
    const probes = [second, `${first} `, first.toLowerCase(), foreign, id(9, 'C'), first];
    let queries = 0;
    const counted = (tx: TenantTx): TenantTx => ({
      ...tx,
      query: <R extends QueryResultRow>(text: string | QueryConfig, values?: unknown[]) => {
        queries += 1;
        return tx.query<R>(text, values);
      },
    });
    const statesIn = async (tenant: string, ids: string[] = probes): Promise<string[][]> =>
      (await inTenant((tx) => repo.findAccountOperations(counted(tx), ids), tenant)).map((row) => [row.operation_id, row.state]);

    expect(await statesIn(tenantId)).toEqual([[first, 'prepared'], [second, 'committed']]);
    expect(await statesIn(otherTenantId)).toEqual([[foreign, 'prepared']]);
    expect(await statesIn(tenantId, [])).toEqual([]);
    expect(queries).toBe(2);
    const single = await inTenant(async (tx) => {
      const found: Array<string | null> = [];
      for (const probe of probes) found.push((await repo.findAccountOperation(tx, probe))?.operation_id ?? null);
      return found;
    });
    expect(single).toEqual([second, first, null, null, null, first]);
  });

  it('finds person contacts by email without case and numbers aggregate versions under concurrency', async () => {
    await inTenant((tx) => repo.upsertPersonContact(tx, { user_id: id(1), site_id: 'site-a', email: 'Ada@Example.test', fname: 'Ada', lname: 'L', company: null, subtype: null, aggregate_version: '3' }));
    expect((await inTenant((tx) => repo.findContactsByEmail(tx, 'ada@example.TEST'))).map((row) => row.user_id)).toEqual([id(1)]);
    expect(await inTenant((tx) => repo.findPersonContact(tx, id(1)), otherTenantId)).toBeNull();

    const versions = await Promise.all([1, 2, 3].map(() => inTenant((tx) => repo.nextAggregateVersion(tx, 'membership', id(1)))));
    expect([...versions].sort()).toEqual([1, 2, 3]);
    expect(await inTenant((tx) => repo.nextAggregateVersion(tx, 'membership', id(1)))).toBe(4);
    expect(await inTenant((tx) => repo.nextAggregateVersion(tx, 'membership', id(1)), otherTenantId)).toBe(1);
  });

  it('finds contacts and their active Type=2 accounts by an email stored with a trailing space, as SQL Server nvarchar equality does', async () => {
    const stored = 'Member@Example.test ';
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(2), 'second'));
      await repo.insertAccount(tx, account(id(1), 'first'));
      await repo.insertAccount(tx, account(id(3), 'gone', { inactive: 1 }));
      await repo.insertAccount(tx, account(id(4), 'pending', { opt2_state: 'pending' }));
      await repo.insertAccount(tx, account(id(5), 'type-one', { type: 1 }));
      for (const n of [1, 2, 3, 4, 5, 6]) {
        await repo.upsertPersonContact(tx, { user_id: id(n), site_id: 'site-a', email: stored, fname: `F${n}`, lname: 'L', company: null, subtype: null, aggregate_version: 1 });
      }
    });
    const typed = 'member@example.TEST';

    expect((await inTenant((tx) => repo.findContactsByEmail(tx, typed))).map((row) => row.user_id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => id(n)));
    expect((await inTenant((tx) => repo.findPersonContact(tx, id(1))))?.email).toBe(stored);
    const found = await inTenant((tx) => repo.findAccountsByEmail(tx, typed));
    expect(found.map((row) => [row.userid, row.username, row.fname, row.lname])).toEqual([[id(1), 'first', 'F1', 'L'], [id(2), 'second', 'F2', 'L']]);
    expect(found[0]).toMatchObject({ type: 2, inactive: 0, opt2_state: 'active', siteid: 'site-a' });
    expect((await inTenant((tx) => repo.findAccountsByEmail(tx, typed, id(2)))).map((row) => row.userid)).toEqual([id(2)]);
    expect(await inTenant((tx) => repo.findAccountsByEmail(tx, typed, id(3)))).toEqual([]);
    expect(await inTenant((tx) => repo.findAccountsByEmail(tx, ` ${typed}`))).toEqual([]);
    expect(await inTenant((tx) => repo.findAccountsByEmail(tx, typed), otherTenantId)).toEqual([]);
    await setGates('open', 'executing');
    await expect(gated((tx) => repo.findAccountsByEmail(tx, typed))).rejects.toBeInstanceOf(UnitReadBlockedError);
  });

  it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
    ['findContactsByEmail', (tx) => repo.findContactsByEmail(tx, 'member@example.test')],
    ['findAccountsByEmail', (tx) => repo.findAccountsByEmail(tx, 'member@example.test')],
  ])('%s reads person_contact through its email index under forced row-level security', async (_label, lookup) => {
    const plan = await inTenant(async (tx) => {
      const statements: { text: string; values: unknown[] }[] = [];
      const recording: TenantTx = {
        ...tx,
        query: ((text: string, values: unknown[] = []) => {
          statements.push({ text, values });
          return tx.query(text, values);
        }) as TenantTx['query'],
      };
      await tx.query('SET LOCAL enable_seqscan = off');
      await lookup(recording);
      const statement = statements.find(({ text }) => text.includes('person_contact')) ?? expect.unreachable('the lookup read no person_contact');
      return (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${statement.text}`, statement.values)).rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('person_contact_tenant_email_idx');
  });

  it.each<[string, (tx: TenantTx, groupIds: string[]) => Promise<string[]>]>([
    ['replaceMemberships', async (tx, groupIds) => (await repo.replaceMemberships(tx, { userId: id(1), groupIds })).added],
    [
      'addMembership',
      async (tx, groupIds) => {
        const added: string[] = [];
        for (const groupId of groupIds) if (await repo.addMembership(tx, id(1), groupId)) added.push(groupId);
        return added;
      },
    ],
  ])('%s stores a group id and its lower-case variant once, keeping the stored case', async (_label, add) => {
    const groupId = id(1, 'G');
    expect(await gated((tx) => add(tx, [groupId, groupId.toLowerCase()]))).toEqual([groupId]);
    expect(await inTenant((tx) => repo.membershipGroupIds(tx, id(1).toLowerCase()))).toEqual([groupId]);
  });

  it('stores a category id and its lower-case variant as one group interest, keeping the stored case', async () => {
    const groupId = (await gated((tx) => repo.insertGroup(tx, groupInput(), null))).userid;
    await gated((tx) => repo.replaceGroupInterests(tx, { groupId, categoryIds: [id(1, 'C'), id(1, 'C').toLowerCase()] }));
    await gated((tx) => repo.replaceGroupInterests(tx, { groupId, categoryIds: [id(1, 'C').toLowerCase()], onlyCategoryIds: [] }));
    const interests = await inTenant(async (tx) => (await tx.query<{ categoryid: string }>(`SELECT categoryid FROM ${handle.schema}.user_interest`)).rows);
    expect(interests).toEqual([{ categoryid: id(1, 'C') }]);
  });

  it.each<[string, string, string, Record<string, unknown>, (tx: TenantTx, filter: string) => Promise<unknown>]>([
    ['replaceMemberships onlyGroupIds', 'membership', 'groupid', { userid: id(1), groupid: id(1, 'G') }, (tx, filter) =>
      repo.replaceMemberships(tx, { userId: id(1), groupIds: [], onlyGroupIds: [filter] })],
    ['replaceGroupInterests onlyCategoryIds', 'user_interest', 'categoryid', { userid: id(1, 'G'), categoryid: id(1, 'C') }, (tx, filter) =>
      repo.replaceGroupInterests(tx, { groupId: id(1, 'G'), categoryIds: [], onlyCategoryIds: [filter] })],
    ['deleteTokensByUser tokens', 'oauth_token', 'token', { token: `000${'A'.repeat(32)}`, clientid: id(1, 'K'), userid: id(1), expires: NOW }, (tx, filter) =>
      repo.deleteTokensByUser(tx, id(1), [filter])],
  ])('%s removes the stored row of a lower-cased filter id with a trailing space', async (_label, table, column, stored, remove) => {
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G') }), null);
      await repo.insert(tx, table, stored);
    });
    await gated((tx) => remove(tx, `${String(stored[column]).toLowerCase()} `));
    expect(await inTenant(async (tx) => (await tx.query(`SELECT ${column} FROM ${handle.schema}.${table}`)).rows)).toEqual([]);
  });

  it.each<[string, string, (tx: TenantTx, key: string) => Promise<{ userid: string } | null>]>([
    ['findAccountById', id(1), (tx, key) => repo.findAccountById(tx, key)],
    ['readCredential', id(1), (tx, key) => repo.readCredential(tx, key)],
    ['findGroup', id(1, 'G'), (tx, key) => repo.findGroup(tx, key)],
    ['findGroupsByIds', id(1, 'G'), async (tx, key) => (await repo.findGroupsByIds(tx, [key]))[0] ?? null],
    ['findGroupsByIds with a trailing space', id(1, 'G'), async (tx, key) => (await repo.findGroupsByIds(tx, [`${key} `]))[0] ?? null],
    ['readAccountRecords with a trailing space', id(1), async (tx, key) => (await repo.readAccountRecords(tx, [`${key} `]))[0] ?? null],
  ])('%s reads the row of a lower-cased id and returns its stored case', async (_label, stored, read) => {
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(1), 'user'));
      await repo.writeCredential(tx, id(1), { password: 'hash', passwordcreated: NOW });
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G') }), null);
    });
    expect((await inTenant((tx) => read(tx, stored.toLowerCase())))?.userid).toBe(stored);
  });

  it('updates and upserts by a lower-cased id on the stored row, keeping its stored case', async () => {
    const lower = id(1).toLowerCase();
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(1), 'user'));
      await repo.writeCredential(tx, id(1), { password: 'old', passwordcreated: NOW });
    });
    const values = { username: 'renamed', type: 2, s2: 0, inactive: 0, ispublic: 0, siteid: 'site-a', remoteid: '', tablist: '' };
    expect(await gated((tx) => repo.updateAccount(tx, lower, values))).toMatchObject({ userid: id(1), username: 'renamed' });
    expect(await gated((tx) => repo.writeCredential(tx, lower, { password: 'new', passwordcreated: NOW }))).toMatchObject({ userid: id(1), password: 'new' });
    const stored = await inTenant(async (tx) => [
      ...(await tx.query<{ userid: string }>(`SELECT userid FROM ${handle.schema}.user_account`)).rows,
      ...(await tx.query<{ userid: string }>(`SELECT userid FROM ${handle.schema}.credential`)).rows,
    ]);
    expect(stored).toEqual([{ userid: id(1) }, { userid: id(1) }]);
  });

  it.each([
    ['user_account', { userid: id(1), type: 2 }, { userid: id(1).toLowerCase(), type: 2 }],
    ['user_interest', { userid: id(1, 'G'), categoryid: id(1, 'C') }, { userid: id(1, 'G').toLowerCase(), categoryid: id(1, 'C').toLowerCase() }],
    [
      'permission',
      { contentid: id(1, 'N'), groupid: id(1, 'G'), siteid: 'site-a', type: 'Editor' },
      { contentid: id(1, 'N').toLowerCase(), groupid: id(1, 'G').toLowerCase(), siteid: 'SITE-A', type: 'editor' },
    ],
    ['user_strike', { username: 'Admin', strikes: 0 }, { username: 'ADMIN', strikes: 0 }],
  ])('rejects a case variant of a stored %s key as SQL Server does', async (table, stored, variant) => {
    await gated((tx) => repo.insert(tx, table, stored));
    await expect(gated((tx) => repo.insert(tx, table, variant))).rejects.toMatchObject({ code: '23505' });
  });

  it('matches site ids without case in username and group name lookups', async () => {
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(id(1), 'user', { siteid: 'Site-A' }));
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), siteid: 'Site-A' }), null);
    });
    expect((await inTenant((tx) => repo.findAccountsByUsername(tx, 'user', 'site-a'))).map((row) => [row.userid, row.siteid])).toEqual([[id(1), 'Site-A']]);
    expect((await inTenant((tx) => repo.findGroupByName(tx, 'editors', { siteId: 'SITE-A' })))?.userid).toBe(id(1, 'G'));
  });

  it('reads module grants by lower-cased group ids and a differently cased site id, returning the stored case', async () => {
    const moduleId = '00000000000000000000000000000000008';
    await gated((tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: 'site-a', groupIds: [id(1, 'G'), id(2, 'G')] }));
    expect(await inTenant((tx) => repo.moduleGrants(tx, [id(2, 'G').toLowerCase()], 'SITE-A'))).toEqual([{ contentId: moduleId, groupId: id(2, 'G') }]);
  });

  it.each([
    ['an expansion of a stored ß', 'Straße', 'STRASSE', true],
    ['a soft hyphen SQL Server does not ignore', 'admin', 'ad\u00ADmin', false],
    ['a no-break space for a space', 'ad min', 'ad\u00A0min', false],
  ])('matches a username differing by %s only as SQL Server nvarchar equality does', async (_label, stored, lookup, matches) => {
    await gated((tx) => repo.insertAccount(tx, account(id(1), stored)));
    expect((await inTenant((tx) => repo.findAccountsByUsername(tx, lookup, 'site-a'))).map((row) => row.userid)).toEqual(matches ? [id(1)] : []);
  });

  it('finds a stored group name and reserves an open operation username by their SQL Server expansion', async () => {
    await gated((tx) => repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), groupname: 'Straße' }), null));
    expect((await inTenant((tx) => repo.findGroupByName(tx, 'STRASSE', { siteId: 'site-a' })))?.userid).toBe(id(1, 'G'));
    const op = await inTenant((tx) => repo.insertAccountOperation(tx, { user_id: id(1), kind: 'create', state: 'prepared', username: 'Straße' }));
    await expect(inTenant((tx) => repo.insertAccountOperation(tx, { user_id: id(2), kind: 'create', state: 'prepared', username: 'STRASSE ' }))).rejects.toMatchObject({
      code: '23505',
    });
    expect((await inTenant((tx) => repo.findOpenAccountOperation(tx, { username: 'strasse' })))?.operation_id).toBe(op.operation_id);
  });

  it.each([
    ['ß and ss', 'ß', 'ss', true],
    ['Š and š', 'Š', 'š', true],
    ['Ÿ and ÿ', 'Ÿ', 'ÿ', true],
    ['É and é', 'É', 'é', false],
  ])('keeps group ids differing by %s apart only where SQL Server char equality does', async (_label, first, second, distinct) => {
    const [a, b] = [`G${first}${'0'.repeat(32)}`, `G${second}${'0'.repeat(32)}`];
    expect(await gated(async (tx) => (await repo.replaceMemberships(tx, { userId: id(1), groupIds: [a, b] })).added)).toEqual(distinct ? [a, b] : [a]);
    expect(await inTenant((tx) => repo.membershipGroupIds(tx, id(1)))).toHaveLength(distinct ? 2 : 1);
  });
});
