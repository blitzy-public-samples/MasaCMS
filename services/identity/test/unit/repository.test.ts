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
  type AccountFilter,
  type AccountInput,
  type GroupInput,
  type IdentityRepository,
  type ListedAccountCount,
  type SessionLockMode,
  type UsernameCandidateRow,
} from '../../src/repo/repository.js';
import {
  compileGroupFeed,
  isSqlExpressible,
  type FeedComparison,
  type GroupFeedCondition,
  type GroupFeedFilter,
  type GroupFeedQuery,
} from '../../src/repo/group-feed.js';
import {
  GROUP_ACCOUNT,
  IDENTITY_UNITS,
  OWNED_TABLES,
  USER_ACCOUNT,
  type AccountOperationRow,
  type GroupAccountRow,
  type MembershipRow,
  type UserAccountRow,
} from '../../src/repo/tables.js';
import { createMemoryIdentityRepo } from '../helpers/memory-repo.js';

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

  it.each([0, -1, 1.5, Number.NaN])('rejects a read page size of %s', (pageSize) => {
    expect(() => createIdentityRepository({ clock: CLOCK, pageSize })).toThrow(RangeError);
  });

  it('keeps a single space for two empty names and cuts the label at 50 UTF-16 units', () => {
    expect(lastUpdateInfo(null, { userid: 'R', fname: null, lname: null })).toEqual({ lastupdateby: ' ', lastupdatebyid: 'R' });
    expect(lastUpdateInfo({ userId: 'X', fname: 'x'.repeat(49), lname: 'yz', fromSnapshot: true }, { userid: 'R', fname: '', lname: '' }).lastupdateby).toBe(
      `${'x'.repeat(49)} `,
    );
  });

  it.each<[string, GroupFeedCondition, boolean]>([
    ['a LIKE class', { kind: 'like', column: 'groupname', pattern: 'a[bc]%' }, false],
    ['a LIKE negated class', { kind: 'like', column: 'groupname', pattern: '[^a]' }, false],
    ['an unterminated [', { kind: 'like', column: 'groupname', pattern: 'x[y' }, true],
    ['a ] before the [', { kind: 'like', column: 'groupname', pattern: ']x[' }, true],
    ['a lone surrogate pattern', { kind: 'like', column: 'groupname', pattern: 'a\uD83D%' }, false],
    ['a pattern holding the surrogate mark', { kind: 'like', column: 'groupname', pattern: '%\u{10FFFF}%' }, false],
    ['a NUL criteria', { kind: 'compare', column: 'groupname', type: 'varchar', op: '=', value: 'a\u0000' }, false],
    ['a lone surrogate IN item', { kind: 'in', column: 'groupname', type: 'varchar', negated: false, items: ['a', '\uDE00'] }, false],
    ['a supplementary character', { kind: 'like', column: 'groupname', pattern: '%\u{1F600}%' }, true],
    ['a numeric IN of any text', { kind: 'in', column: 'perm', type: 'numeric', negated: false, items: ['\u0000'] }, true],
  ])('compiles a group feed condition with %s to SQL only when PostgreSQL reproduces it exactly', (_label, condition, expressible) => {
    expect(isSqlExpressible(condition)).toBe(expressible);
  });

  it('refuses a group feed column group_account does not hold', () => {
    const condition: GroupFeedCondition = { kind: 'null', column: 'groupname" OR TRUE --', negated: false };
    expect(() => compileGroupFeed({ filters: [{ relationship: 'and', condition }], order: [] }, { textCollation: 'c', first: 1 })).toThrow(RangeError);
    expect(() => compileGroupFeed({ filters: [], order: [{ column: 'tenant_id', type: 'varchar', desc: false }] }, { textCollation: 'c', first: 1 })).toThrow(RangeError);
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

  /** `tx` recording the text of each statement it runs in `statements`. */
  function recording(tx: TenantTx, statements: string[]): TenantTx {
    const query = ((text: string, values?: unknown[]) => {
      statements.push(text);
      return tx.query(text, values);
    }) as TenantTx['query'];
    return { ...tx, query };
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

  it("reads every readGroupMemberships column: an account's from its account, credential, login-state and contact rows, a group's from its own row", async () => {
    const groupId = id(20, 'G');
    const memberGroup = id(21, 'G');
    const passwordCreated = new Date(2026, 0, 2, 3, 4, 5, 670);
    const lastLogin = new Date(2026, 5, 29, 8, 0, 0, 3);
    const created = new Date(2025, 11, 31, 23, 59, 59, 997);
    const lastUpdate = new Date(2026, 5, 30, 12, 0, 0, 123);
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: groupId, groupname: 'Listed' }), null);
      await repo.insertGroup(tx, groupInput({ userid: memberGroup, groupname: 'Nested', lname: 'Nest', jobtitle: 'Group Job', perm: 1, tablist: 'Basic', photofileid: id(22, 'F') }), null);
      await repo.insertAccount(tx, account(id(20), 'full', { perm: 1, remoteid: 'R-20', tablist: 'Basic,Advanced' }));
      await repo.insertAccount(tx, account(id(21), 'bare'));
      await repo.writeCredential(tx, id(20), { password: 'hash', passwordcreated: passwordCreated });
      await repo.touchLastLogin(tx, id(20), lastLogin);
      await repo.upsertPersonContact(tx, {
        user_id: id(20), site_id: 'site-a', email: 'f@x', fname: 'Fay', lname: 'Full', company: 'Co', subtype: 'Default', aggregate_version: 1,
        groupname: null, jobtitle: 'Analyst', mobilephone: '555', website: 'w.example', ext: 4, contactform: 'cf', subscribe: 1, notes: 'n',
        description: 'd', interests: 'i', keepprivate: 1, photofileid: id(23, 'F'), imname: 'im', imservice: 'AIM', tags: 't', created,
        lastupdate: lastUpdate, lastupdateby: 'Ada Admin', lastupdatebyid: SNAPSHOT_ACTOR.userId,
      });
      for (const member of [id(20), id(21), memberGroup]) await repo.addMembership(tx, member, groupId);
    });

    const [bare, full, nested] = await inTenant((tx) => repo.membersOf(tx, groupId));

    expect(full).toEqual({
      userid: id(20), type: 2, username: 'full', siteid: 'site-a', ispublic: 0, s2: 0, inactive: 0, fname: 'Fay', lname: 'Full', email: 'f@x',
      company: 'Co', groupname: null, passwordcreated: passwordCreated, jobtitle: 'Analyst', mobilephone: '555', website: 'w.example',
      subtype: 'Default', contactform: 'cf', lastlogin: lastLogin, lastupdate: lastUpdate, lastupdateby: 'Ada Admin',
      lastupdatebyid: SNAPSHOT_ACTOR.userId, perm: 1, subscribe: 1, notes: 'n', description: 'd', interests: 'i', keepprivate: 1,
      photofileid: id(23, 'F'), imname: 'im', imservice: 'AIM', created, remoteid: 'R-20', tags: 't', tablist: 'Basic,Advanced',
    });
    expect(bare).toMatchObject({ userid: id(21), username: 'bare', fname: null, lname: null, passwordcreated: null, lastlogin: null, jobtitle: null, photofileid: null, perm: 0 });
    const stored = await inTenant((tx) => repo.findGroup(tx, memberGroup));
    const { tenant_id: _tenant, password: _password, ext: _ext, admin: _admin, row_version: _version, ...groupColumns } = stored ?? expect.unreachable('no group');
    expect(nested).toEqual(groupColumns);
    expect(nested).toMatchObject({ type: 1, lname: 'Nest', jobtitle: 'Group Job', perm: 1, tablist: 'Basic', photofileid: id(22, 'F') });
  });

  /** An open-or-ended account operation of `id(user)` whose JSON columns name groups as account-operations records them. */
  type OperationSeed = { user: number; state?: 'prepared' | 'committed' | 'finished'; held?: readonly string[]; pending?: readonly string[] | null };
  async function seedOperations(seeds: readonly OperationSeed[]): Promise<void> {
    for (const { user, state = 'committed', held, pending } of seeds) {
      await inTenant((tx) =>
        repo.insertAccountOperation(tx, {
          user_id: id(user),
          kind: 'update',
          state,
          before_values: held === undefined ? null : JSON.stringify({ account: null, credential: null, lastlogin: null, groupIds: held }),
          pending_change: pending === undefined ? null : JSON.stringify({ account: {}, credential: null, memberships: pending === null ? null : { groupIds: pending, originId: null } }),
        }),
      );
    }
  }

  const MEMBER_CLOSURES: readonly (readonly [string, 'paged' | 'empty', readonly OperationSeed[], readonly number[]])[] = [
    ['no open operation', 'paged', [], []],
    ['a prepared operation of a member', 'paged', [{ user: 4, state: 'prepared' }], [4]],
    ['a finished operation of a member', 'paged', [{ user: 4, state: 'finished' }], []],
    ['a non-member whose before-image held the group', 'paged', [{ user: 6, held: [id(1, 'G')] }], [6]],
    ['a non-member whose pending change adds the group by a lower-case id', 'paged', [{ user: 6, pending: [id(1, 'G').toLowerCase()] }], [6]],
    ['a non-member whose pending change keeps the stored memberships', 'paged', [{ user: 6, held: [], pending: null }], []],
    ['non-members changing another group only', 'paged', [{ user: 6, held: [id(2, 'G')] }, { user: 7, pending: [id(2, 'G')] }], []],
    ['a group without members whose last member a committed change removed', 'empty', [{ user: 6, held: [id(3, 'G')], pending: [] }], [6]],
    ['a group without members and no open operation', 'empty', [], []],
  ];

  it.each(MEMBER_CLOSURES)('pages members from one fenced cursor in pages of two, the first page naming the closure for %s', async (_case, which, seeds, closedUsers) => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 2 });
    const members = [id(1), id(2), id(3), id(4), id(5)];
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), groupname: 'Paged' }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(3, 'G'), groupname: 'Empty' }), null);
      for (const member of [...members, id(6), id(7)]) await repo.insertAccount(tx, account(member, `m${member}`));
      for (const member of members) await repo.addMembership(tx, member, id(1, 'G'));
    });
    await seedOperations(seeds);
    const groupId = which === 'paged' ? id(1, 'G') : id(3, 'G');
    const closed = closedUsers.map((user) => id(user));
    const statements: string[] = [];
    const pages = await inTenant(async (tx) => {
      const read: { members: string[]; closed: string[] }[] = [];
      for await (const page of paged.memberPages(recording(tx, statements), groupId)) read.push({ members: page.members.map(({ member }) => member.userid), closed: page.closed });
      return read;
    });
    const expected = which === 'paged' ? [members.slice(0, 2), members.slice(2, 4), members.slice(4)] : [[]];
    expect(pages).toEqual(expected.map((ids, n) => ({ members: ids, closed: n === 0 ? closed : [] })));
    expect(statements.findIndex((text) => text.startsWith('DECLARE'))).toBeGreaterThan(statements.findIndex((text) => text.includes('unit_gate')));
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(expected.length);
    expect(statements.at(-1)).toMatch(/^CLOSE /);
    expect(await inTenant((tx) => paged.probeMembers(tx, groupId))).toEqual({ listed: which === 'paged', closed });
    expect(await inTenant((tx) => paged.countMembers(tx, groupId))).toEqual({ total: which === 'paged' ? members.length : 0, closed });
    const counted = await inTenant((tx) => repo.listCountedGroups(tx, 'site-a', 1));
    expect(counted.closed).toEqual(closed);
  });

  it('closes the member cursor when its consumer stops early, keeping the transaction usable', async () => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 1 });
    const groupId = id(1, 'G');
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: groupId, groupname: 'Stopped' }), null);
      for (const member of [id(1), id(2)]) {
        await repo.insertAccount(tx, account(member, `m${member}`));
        await repo.addMembership(tx, member, groupId);
      }
    });
    const statements: string[] = [];
    const after = await inTenant(async (tx) => {
      const recorded = recording(tx, statements);
      for await (const page of paged.memberPages(recorded, groupId)) {
        expect(page.members.map(({ key, member }) => [key, member.userid])).toEqual([[null, id(1)]]);
        break;
      }
      return (await tx.query<{ one: number }>('SELECT 1 AS one')).rows;
    });
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(1);
    expect(statements.at(-1)).toMatch(/^CLOSE /);
    expect(after).toEqual([{ one: 1 }]);
  });

  it.each([
    ['no open operation', [], [], 5, 3],
    ['a member of a group listed on the second page', [{ user: 3 }], [3], 2, 1],
    ['a non-member whose before-image held a listed group', [{ user: 6, held: [id(5, 'G')], pending: [] }], [6], 2, 1],
    ['a non-member changing an unlisted group only', [{ user: 6, pending: [id(9, 'G')] }], [], 5, 3],
  ] as const)('lists counted groups through one cursor in pages of two, ending after the first page for %s', async (_case, seeds, closedUsers, read, fetches) => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 2 });
    const groups = [id(1, 'G'), id(2, 'G'), id(3, 'G'), id(4, 'G'), id(5, 'G')];
    await gated(async (tx) => {
      for (const [n, groupId] of groups.entries()) {
        await repo.insertGroup(tx, groupInput({ userid: groupId, groupname: `Group ${n}` }), null);
        await repo.insertAccount(tx, account(id(n + 1), `m${n}`));
        await repo.addMembership(tx, id(n + 1), groupId);
      }
      await repo.insertAccount(tx, account(id(6), 'm6'));
    });
    await seedOperations(seeds);
    const statements: string[] = [];
    const result = await inTenant((tx) => paged.listCountedGroups(recording(tx, statements), 'site-a', 1));
    expect(result).toEqual({ groups: groups.slice(0, read).map((userid) => expect.objectContaining({ userid, counter: 1 })), closed: closedUsers.map((user) => id(user)) });
    expect(result.groups[0]).not.toHaveProperty('closed_users');
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(fetches);
  });

  /** Member groups of site-a whose listing order is G4, G2, G5, G1, G6, G3, a system group, and G4's and G5's members. */
  async function seedWindowedGroups(): Promise<string[]> {
    const groups = [
      { userid: id(1, 'G'), groupname: 'beta', perm: 0 },
      { userid: id(2, 'G'), groupname: 'Zulu', perm: 1 },
      { userid: id(3, 'G'), groupname: 'Alpha', perm: null },
      { userid: id(4, 'G'), groupname: 'alpha', perm: 1 },
      { userid: id(5, 'G'), groupname: '', perm: 0 },
      { userid: id(6, 'G'), groupname: 'Beta', perm: 0 },
    ];
    await gated(async (tx) => {
      for (const group of groups) await repo.insertGroup(tx, groupInput(group), null);
      await repo.insertGroup(tx, groupInput({ userid: id(7, 'G'), groupname: 'System', ispublic: 0 }), null);
      await repo.insertAccount(tx, account(id(1), 'm1'));
      await repo.insertAccount(tx, account(id(2), 'm2', { s2: 1 }));
      await repo.insertAccount(tx, account(id(3), 'm3', { opt2_state: 'pending' }));
      for (const member of [id(1), id(2), id(3), id(5, 'G')]) await repo.addMembership(tx, member, id(4, 'G'));
      await repo.addMembership(tx, id(1), id(5, 'G'));
    });
    return [id(4, 'G'), id(2, 'G'), id(5, 'G'), id(1, 'G'), id(6, 'G'), id(3, 'G')];
  }

  it.each([
    [0, 1000],
    [0, 2],
    [2, 2],
    [4, 5],
    [5, 1],
    [6, 1],
    [100, 3],
  ])('windows the counted groups at offset %i, limit %i in listGroups order with S2, group and active members counted and the listing total', async (offset, limit) => {
    const ordered = await seedWindowedGroups();
    const counters = new Map([[id(4, 'G'), 3], [id(5, 'G'), 1]]);

    const page = await inTenant((tx) => repo.pageCountedGroups(tx, 'site-a', 1, { offset, limit }));

    expect(page).toEqual({
      groups: ordered.slice(offset, offset + limit).map((userid) => expect.objectContaining({ userid, counter: counters.get(userid) ?? null })),
      total: 6,
      closed: [],
    });
    expect(page.groups[0] ?? {}).not.toHaveProperty('total');
    expect(page.groups[0] ?? {}).not.toHaveProperty('closed_users');
  });

  it('answers the whole listing as one window with the rows listCountedGroups lists, in the order listGroups sorts them', async () => {
    await seedWindowedGroups();
    const counted = await inTenant((tx) => repo.listCountedGroups(tx, 'site-a', 1));
    const byPerm = [...counted.groups].sort((a, b) => (a.perm === b.perm ? 0 : a.perm === null ? 1 : b.perm === null ? -1 : b.perm - a.perm));

    expect((await inTenant((tx) => repo.pageCountedGroups(tx, 'site-a', 1, { offset: 0, limit: 1000 }))).groups).toEqual(byPerm);
    expect(await inTenant((tx) => repo.pageCountedGroups(tx, 'site-a', 1, { offset: 0, limit: 1000 }), otherTenantId)).toEqual({ groups: [], total: 0, closed: [] });
  });

  it.each([
    ['a member of a group in the window', [{ user: 2 }], { offset: 0, limit: 1 }, [2]],
    ['a non-member whose pending change adds a group in the window', [{ user: 6, pending: [id(5, 'G')] }], { offset: 2, limit: 1 }, [6]],
    ['a member of a group outside the window only', [{ user: 2 }], { offset: 1, limit: 10 }, []],
    ['a member of a listed group past the window', [{ user: 1 }], { offset: 100, limit: 1 }, []],
  ] as const)('names the users closing a group of the window only, for %s', async (_case, seeds, window, closedUsers) => {
    await seedWindowedGroups();
    await seedOperations(seeds);

    const page = await inTenant((tx) => repo.pageCountedGroups(tx, 'site-a', 1, window));

    expect(page.closed).toEqual(closedUsers.map((user) => id(user)));
    expect(page.total).toBe(6);
  });

  it('counts the members a group lists, S2 ones only with includeS2, and bounds a paged member cursor to its first limit members', async () => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 2 });
    const groupId = id(1, 'G');
    const members = [id(1), id(2), id(3), id(4), id(5)];
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: groupId, groupname: 'Bounded' }), null);
      for (const member of members) await repo.insertAccount(tx, account(member, `m${member}`));
      await repo.insertAccount(tx, account(id(6), 'super', { s2: 1 }));
      await repo.insertAccount(tx, account(id(7), 'pending', { opt2_state: 'pending' }));
      for (const member of [...members, id(6), id(7)]) await repo.addMembership(tx, member, groupId);
    });
    const statements: string[] = [];
    const read = (limit: number, includeS2 = false) =>
      inTenant(async (tx) => {
        const pages: string[][] = [];
        for await (const page of paged.memberPages(recording(tx, statements), groupId, { includeS2, limit })) pages.push(page.members.map(({ member }) => member.userid));
        return pages;
      });

    expect(await inTenant((tx) => repo.countMembers(tx, groupId))).toEqual({ total: 5, closed: [] });
    expect(await inTenant((tx) => repo.countMembers(tx, groupId, { includeS2: true }))).toEqual({ total: 6, closed: [] });
    expect(await inTenant((tx) => repo.countMembers(tx, id(9, 'G')))).toEqual({ total: 0, closed: [] });
    expect(await read(3)).toEqual([members.slice(0, 2), members.slice(2, 3)]);
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(2);
    expect(await read(4)).toEqual([members.slice(0, 2), members.slice(2, 4)]);
    expect(await read(100, true)).toEqual([members.slice(0, 2), members.slice(2, 4), [id(5), id(6)]]);
    expect(await read(1)).toEqual([[id(1)]]);
  });

  it.each([
    [0, 1000],
    [0, 2],
    [3, 2],
    [4, 1],
    [5, 1],
  ])('windows the site OAuth clients at offset %i, limit %i by clientid with their total', async (offset, limit) => {
    const clientIds = [id(3, 'C'), id(1, 'C'), id(5, 'C'), id(2, 'C'), id(4, 'C')];
    await gated(async (tx) => {
      for (const [n, clientid] of [...clientIds, id(6, 'C')].entries()) {
        await repo.insertOAuthClient(tx, {
          clientid, clientsecret: 'S', siteid: n === 5 ? 'site-b' : 'site-a', granttype: 'basic', userid: '', name: `Client ${n}`, created: NOW, lastupdate: NOW,
          description: '', redirecturl: '', lastupdatebidy: '', lastupdateby: '',
        });
      }
    });

    const page = await inTenant((tx) => repo.listOAuthClients(tx, 'site-a', { offset, limit }));

    expect(page.items.map((row) => row.clientid)).toEqual([...clientIds].sort().slice(offset, offset + limit));
    expect(page.total).toBe(5);
    expect(page.items[0] ?? {}).not.toHaveProperty('total');
    expect(await inTenant((tx) => repo.listOAuthClients(tx, 'site-c', { offset, limit }))).toEqual({ items: [], total: 0 });
  });

  /** Seeds the site-a public pool with G1, G2 (S2), G3 (inactive), G4 (site SITE-A), G6 (NULL S2 and inactive) and G9 (inactive 2); G5, G7, G8 and another tenant's G10 lie outside it. */
  async function seedFeedPool(): Promise<void> {
    await gated(async (tx) => {
      await repo.insertGroup(tx, groupInput({ userid: id(6, 'G'), groupname: 'Six', s2: null, inactive: null }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(1, 'G'), groupname: 'One' }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(2, 'G'), groupname: 'Two', s2: 1 }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(3, 'G'), groupname: 'Three', inactive: 1 }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(4, 'G'), groupname: 'Four', siteid: 'SITE-A' }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(5, 'G'), groupname: 'Private', ispublic: 0 }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(7, 'G'), groupname: 'Person', type: 2 }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(8, 'G'), groupname: 'Elsewhere', siteid: 'site-b' }), null);
      await repo.insertGroup(tx, groupInput({ userid: id(9, 'G'), groupname: 'Wider', inactive: 2 }), null);
    });
    await gated((tx) => repo.insertGroup(tx, groupInput({ userid: id(10, 'G'), groupname: 'Other tenant' }), null), otherTenantId);
  }

  it.each([
    ['every group to an S2 reader', { includeS2: true }, [1, 2, 3, 4, 6, 9]],
    ['groups whose S2 is 0, never a NULL one', {}, [1, 3, 4, 9]],
    ['inactive groups', { includeS2: true, inactive: 1 }, [3]],
    ['active groups without S2', { inactive: 0 }, [1, 4]],
    ['no group for an inactive value no smallint equals', { includeS2: true, inactive: 0.5 }, []],
  ] as const)('pages the site-a public groups from one fenced cursor in pages of two by userid: %s', async (_case, opts, expected) => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 2 });
    await seedFeedPool();
    const stored = [
      ...(await inTenant(async (tx) => (await tx.query<GroupAccountRow>(`SELECT * FROM ${handle.schema}.group_account`)).rows)),
      ...(await inTenant(async (tx) => (await tx.query<GroupAccountRow>(`SELECT * FROM ${handle.schema}.group_account`)).rows, otherTenantId)),
    ];
    const memory = createMemoryIdentityRepo({ groups: stored }, { clock: CLOCK, schema: handle.schema, pageSize: 2 });
    const statements: string[] = [];
    const readPages = (source: IdentityRepository, record: boolean): Promise<string[][]> =>
      inTenant(async (tx) => {
        const read: string[][] = [];
        for await (const page of source.groupFeedPages(record ? recording(tx, statements) : tx, 'site-a', 1, opts)) read.push(page.map((row) => row.userid));
        return read;
      });
    const pages = await readPages(paged, true);
    const ids = expected.map((n) => id(n, 'G'));
    expect(pages).toEqual(Array.from({ length: Math.ceil(ids.length / 2) }, (_, n) => ids.slice(2 * n, 2 * n + 2)));
    expect(await readPages(memory, false)).toEqual(pages);
    expect(statements.findIndex((text) => text.startsWith('DECLARE'))).toBeGreaterThan(statements.findIndex((text) => text.includes('unit_gate')));
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(Math.floor(ids.length / 2) + 1);
    expect(statements.some((text) => /membership|account_operation|user_account/.test(text))).toBe(false);
    expect(statements.at(-1)).toMatch(/^CLOSE /);
  });

  it("closes the group feed cursor when its consumer stops early, and blocks the feed during a window's executing phase", async () => {
    const paged = createIdentityRepository({ clock: CLOCK, schema: handle.schema, pageSize: 1 });
    await seedFeedPool();
    const statements: string[] = [];
    const after = await inTenant(async (tx) => {
      for await (const page of paged.groupFeedPages(recording(tx, statements), 'site-a', true)) {
        expect(page.map((row) => row.groupname)).toEqual(['One']);
        break;
      }
      return (await tx.query<{ one: number }>('SELECT 1 AS one')).rows;
    });
    expect(statements.filter((text) => text.startsWith('FETCH'))).toHaveLength(1);
    expect(statements.at(-1)).toMatch(/^CLOSE /);
    expect(after).toEqual([{ one: 1 }]);
    await setGates('open', 'executing');
    const drain = async (tx: TenantTx): Promise<void> => {
      for await (const _page of paged.groupFeedPages(tx, 'site-a', 1)) break;
    };
    await expect(gated(drain)).rejects.toBeInstanceOf(UnitReadBlockedError);
  });

  it("answers people's account counts, user-name candidates, foreign members and membership rows from memory as PostgreSQL does", async () => {
    const [alpha, beta, gamma, delta, other, pending, nameless, umlaut, foreign] = [id(11), id(12), id(13), id(14), id(15), id(16), id(17), id(18), id(19)];
    const group = id(20, 'G');
    await gated(async (tx) => {
      await repo.insertAccount(tx, account(alpha, 'alpha'));
      await repo.insertAccount(tx, account(beta, 'Beta', { ispublic: 1, s2: 1 }));
      await repo.insertAccount(tx, account(gamma, 'gamma', { s2: null, inactive: 1 }));
      await repo.insertAccount(tx, account(delta, 'delta', { siteid: 'SITE-A ', s2: 2 }));
      await repo.insertAccount(tx, account(other, 'eta', { siteid: 'site-b' }));
      await repo.insertAccount(tx, account(pending, 'zeta', { opt2_state: 'pending' }));
      await repo.insertAccount(tx, account(nameless, ''));
      await repo.insertAccount(tx, account(umlaut, 'ÄLPHA'));
      await repo.insertGroup(tx, groupInput({ userid: group, ispublic: 0 }), null);
      for (const member of [alpha, foreign, group]) await repo.addMembership(tx, member, group);
      await repo.insertAccountOperation(tx, { user_id: pending, kind: 'create', state: 'prepared' });
      await repo.insertAccountOperation(tx, { user_id: beta, kind: 'update', state: 'aborted' });
    });
    const stored = <T extends QueryResultRow>(table: string): Promise<T[]> => inTenant(async (tx) => (await tx.query<T>(`SELECT * FROM ${handle.schema}.${table}`)).rows);
    const memory = createMemoryIdentityRepo(
      {
        accounts: await stored<UserAccountRow>('user_account'),
        groups: await stored<GroupAccountRow>('group_account'),
        memberships: await stored<MembershipRow>('membership'),
        accountOperations: await stored<AccountOperationRow>('account_operation'),
      },
      { clock: CLOCK, schema: handle.schema },
    );
    const unassigned = { ownMemberships: true, assignedElsewhere: [delta.toLowerCase()] };
    const filters: Array<AccountFilter | undefined> = [
      undefined,
      { isPublic: 0 },
      { s2: 1 },
      { excludeS2Users: true },
      { inActive: 1 },
      { siteIds: ['SITE-B'] },
      { unassigned },
    ];
    const patterns = [
      { pattern: 'A%', limit: 10 },
      { pattern: '%ta', limit: 10 },
      { pattern: '_eta', limit: 10 },
      { pattern: 'ä%', limit: 10 },
      { pattern: '%', limit: 2 },
    ];
    // One statement at a time, as a transaction's client runs them.
    const reads = (source: IdentityRepository) =>
      inTenant(async (tx) => {
        const counts: ListedAccountCount[] = [];
        const records: string[][] = [];
        for (const filter of filters) {
          counts.push(await source.countListedAccounts(tx, { siteId: 'site-a', filter }));
          records.push((await source.readAccountRecords(tx, [alpha, beta, gamma, delta, pending], filter)).map((row) => row.userid));
        }
        counts.push(await source.countListedAccounts(tx, { siteId: null }));
        const candidates: UsernameCandidateRow[][] = [];
        for (const query of patterns) candidates.push(await source.readUsernameCandidates(tx, { siteId: 'site-a', ...query }));
        const foreignIds = [await source.foreignMemberIds(tx, null), await source.foreignMemberIds(tx, [foreign.toLowerCase(), alpha])];
        return { counts, records, candidates, foreign: foreignIds, memberships: await source.readMembershipRecords(tx, [alpha, foreign, pending]) };
      });

    const sql = await reads(repo);
    expect(sql.counts.map((counted) => counted.count)).toEqual([6, 5, 1, 4, 1, 0, 4, 7]);
    expect(sql.counts[0]?.closed).toEqual([pending]);
    expect(sql.candidates.map((rows) => rows.map((row) => row.username))).toEqual([['alpha'], ['Beta', 'delta'], ['Beta'], [], ['alpha', 'Beta']]);
    expect(sql.foreign).toEqual([[foreign], [foreign]]);
    expect(sql.memberships).toEqual({ rows: [{ userid: alpha, groupid: group }, { userid: foreign, groupid: group }], closed: [pending] });
    expect(await reads(memory)).toEqual(sql);
  });

  describe('group feed reads', () => {
    const FEED_TENANT = tenantIdForSite('identity-repository-feed');
    const ADVERSARIAL = '%a%a%a%a%a%a%a%a%a%b%';
    /** The site-a public pool corpus, F1 upward in order; perm cycles 0, 1, 2, NULL and every third row has a lastlogin. */
    const NAMES: ReadonlyArray<string | null> = [
      'alpha', 'Alpha ', 'ALPHA', 'Álpha', 'beta', 'Bravo', 'straße', 'STRASSE', 'ſtar', 'star', 'ıota', 'Iota', '\u212Aelvin', 'kelvin',
      'µ-meter', 'Μ-meter', 'emoji\u{1F600}', 'x[y', 'a\\b', 'a_b', 'a%b', '', null, '  lead', 'Zeta', 'zeta', 'ÿ', 'Ÿ', '10', '9', 'ǆ', 'ǅ',
      'ς', 'Σ', 'ϑ', 'Θ', 'e\u0301', 'é', 'line\nbreak', 'a'.repeat(255), 'á'.repeat(255),
    ];
    const PADDED = NAMES.length + 1;
    let memory: IdentityRepository;

    const named = (...names: Array<string | null>): string[] => names.map((name) => id(NAMES.indexOf(name) + 1, 'F'));
    const where = (...conditions: GroupFeedCondition[]): GroupFeedFilter[] => conditions.map((condition) => ({ relationship: 'and', condition }));
    const like = (pattern: string, column = 'groupname'): GroupFeedCondition => ({ kind: 'like', column, pattern });
    const text = (op: FeedComparison, value: string, column = 'groupname'): GroupFeedCondition => ({ kind: 'compare', column, type: 'varchar', op, value });
    const query = (overrides: Partial<GroupFeedQuery> = {}): GroupFeedQuery => ({ includeS2: true, filters: [], order: [], top: Infinity, limit: Infinity, ...overrides });

    beforeAll(async () => {
      await setGates('open');
      await withGatedTenant(handle.app, FEED_TENANT, async (tx) => {
        for (const [n, name] of NAMES.entries()) {
          const userid = id(n + 1, 'F');
          await repo.insertGroup(tx, groupInput({ userid, groupname: name ?? '' }), null);
          const perm = [0, 1, 2, null][n % 4] ?? null;
          const lastlogin = n % 3 === 0 ? new Date(2025 + (n % 2), n % 12, 1 + (n % 27), n % 24, 0, 0, n) : null;
          await repo.update(tx, GROUP_ACCOUNT.table, { userid }, { groupname: name, perm, lastlogin, email: n % 5 === 0 ? null : `g${n % 7}@example.test` });
        }
        // A blank char(35) id, which pg returns as 35 spaces.
        await repo.insertGroup(tx, groupInput({ userid: id(PADDED, 'F'), groupname: 'Padded' }), null);
        await repo.update(tx, GROUP_ACCOUNT.table, { userid: id(PADDED, 'F') }, { photofileid: '' });
        await repo.insertGroup(tx, groupInput({ userid: id(90, 'F'), groupname: 'alpha', s2: 1 }), null);
        await repo.insertGroup(tx, groupInput({ userid: id(91, 'F'), groupname: 'alpha', inactive: 1 }), null);
        await repo.insertGroup(tx, groupInput({ userid: id(92, 'F'), groupname: 'alpha', ispublic: 0 }), null);
        await repo.insertGroup(tx, groupInput({ userid: id(93, 'F'), groupname: 'alpha', siteid: 'site-b' }), null);
        await repo.insertGroup(tx, groupInput({ userid: id(94, 'F'), groupname: 'alpha', type: 2 }), null);
      });
      const stored = await handle.app.withTenant(FEED_TENANT, async (tx) => (await tx.query<GroupAccountRow>(`SELECT * FROM ${handle.schema}.group_account`)).rows);
      memory = createMemoryIdentityRepo({ groups: stored }, { clock: CLOCK, schema: handle.schema });
    });

    /** `source`'s feed of the site-a public pool as ids and total, and the statements PostgreSQL ran with the rows each returned. */
    async function feedOf(source: IdentityRepository, feed: GroupFeedQuery): Promise<{ ids: string[]; total: number; reads: Array<{ text: string; rows: number }> }> {
      const reads: Array<{ text: string; rows: number }> = [];
      const page = await handle.app.withTenant(FEED_TENANT, (tx) => {
        const recorded = (async (sql: string, values?: unknown[]) => {
          const result = await tx.query(sql, values);
          reads.push({ text: sql, rows: result.rows.length });
          return result;
        }) as TenantTx['query'];
        return source.readGroupFeed({ ...tx, query: recorded }, 'site-a', 1, feed);
      });
      return { ids: page.rows.map((row) => row.userid), total: page.total, reads };
    }

    it.each<[string, GroupFeedQuery]>([
      ['every group by userid', query()],
      ['groups without S2 ones', query({ includeS2: false })],
      ['inactive groups', query({ inactive: 1 })],
      ['groupname ascending, NULL first and ties by userid', query({ order: [{ column: 'groupname', type: 'varchar', desc: false }] })],
      ['groupname descending, NULL last', query({ order: [{ column: 'groupname', type: 'varchar', desc: true }] })],
      ['perm descending, then groupname', query({ order: [{ column: 'perm', type: 'numeric', desc: true }, { column: 'groupname', type: 'varchar', desc: false }] })],
      ['lastlogin ascending', query({ order: [{ column: 'lastlogin', type: 'timestamp', desc: false }] })],
      ['email descending under TOP 7 in a page of 3', query({ order: [{ column: 'email', type: 'varchar', desc: true }], top: 7, limit: 3 })],
      ['groupname equal to alpha', query({ filters: where(text('=', 'alpha')) })],
      ['groupname unequal to ALPHA and a space', query({ filters: where(text('!=', 'ALPHA ')) })],
      ['groupname below b', query({ filters: where(text('<', 'b')) })],
      ['groupname at or above straße', query({ filters: where(text('>=', 'straße')) })],
      ['groupname in a list', query({ filters: where({ kind: 'in', column: 'groupname', type: 'varchar', negated: false, items: ['ALPHA', 'beta ', 'σ', 'nope'] }) })],
      ['groupname not in a list', query({ filters: where({ kind: 'in', column: 'groupname', type: 'varchar', negated: true, items: ['alpha', ''] }) })],
      ['userid in a list of any case', query({ filters: where({ kind: 'in', column: 'userid', type: 'varchar', negated: false, items: [id(1, 'F').toLowerCase(), id(2, 'F')] }) })],
      ['groupname NULL', query({ filters: where({ kind: 'null', column: 'groupname', negated: false }) })],
      ['groupname not NULL', query({ filters: where({ kind: 'null', column: 'groupname', negated: true }) })],
      ['perm 1', query({ filters: where({ kind: 'compare', column: 'perm', type: 'numeric', op: '=', value: 1 }) })],
      ['perm above 0', query({ filters: where({ kind: 'compare', column: 'perm', type: 'numeric', op: '>', value: 0 }) })],
      ['perm NaN', query({ filters: where({ kind: 'compare', column: 'perm', type: 'numeric', op: '=', value: Number.NaN }) })],
      ['perm below Infinity', query({ filters: where({ kind: 'compare', column: 'perm', type: 'numeric', op: '<', value: Infinity }) })],
      ['perm in items Number() reads', query({ filters: where({ kind: 'in', column: 'perm', type: 'numeric', negated: false, items: ['1', '', ' 2 ', 'x'] }) })],
      ['perm not in 0', query({ filters: where({ kind: 'in', column: 'perm', type: 'numeric', negated: true, items: ['0'] }) })],
      ['lastlogin after a date', query({ filters: where({ kind: 'compare', column: 'lastlogin', type: 'timestamp', op: '>', value: new Date(2026, 0, 1) }) })],
      ['lastlogin in text items, which no timestamp equals', query({ filters: where({ kind: 'in', column: 'lastlogin', type: 'timestamp', negated: false, items: ['2026-01-01'] }) })],
      ['lastlogin not in text items', query({ filters: where({ kind: 'in', column: 'lastlogin', type: 'timestamp', negated: true, items: ['2026-01-01'] }) })],
      ['a blank photofileid', query({ filters: where(text('=', '', 'photofileid')) })],
      ['a photofileid LIKE the empty pattern', query({ filters: where(like('', 'photofileid')) })],
      ['a photofileid LIKE a trailing space', query({ filters: where(like('% ', 'photofileid')) })],
      ...['%A%', 'stra_e', '%ss%', '%ß%', '_tar', 'STAR', 'IOTA', 'k%', 'µ%', 'ǅ', 'emoji__', 'emoji_', '%\u{1F600}', 'a\\b', 'a_b', '', '%', 'x[y', '%é', 'line_break', ADVERSARIAL, `%${'á%'.repeat(9)}b%`].map(
        (pattern): [string, GroupFeedQuery] => [`groupname LIKE ${JSON.stringify(pattern)}`, query({ filters: where(like(pattern)) })],
      ),
      [
        'AND before OR',
        query({
          filters: [
            { relationship: 'and', condition: like('a%') },
            { relationship: 'and', condition: { kind: 'compare', column: 'perm', type: 'numeric', op: '=', value: 1 } },
            { relationship: 'or', condition: text('=', 'ZETA') },
          ],
          order: [{ column: 'groupname', type: 'varchar', desc: false }],
        }),
      ],
      [
        'OR ahead of AND',
        query({
          filters: [
            { relationship: 'and', condition: text('=', 'ZETA') },
            { relationship: 'or', condition: like('a%') },
            { relationship: 'and', condition: { kind: 'null', column: 'perm', negated: false } },
          ],
        }),
      ],
      ['a TOP below the matches in a page of two', query({ order: [{ column: 'groupname', type: 'varchar', desc: false }], top: 5, limit: 2 })],
      ['only the count', query({ filters: where(like('a%')), limit: 0, top: 4 })],
    ])('reads %s in PostgreSQL as the feed tests and orders rows in memory', async (_label, feed) => {
      const pg = await feedOf(repo, feed);
      const expected = await feedOf(memory, feed);

      expect({ ids: pg.ids, total: pg.total }).toEqual({ ids: expected.ids, total: expected.total });
      expect(pg.ids.length).toBeLessThanOrEqual(feed.limit);
    });

    it.each<[string, GroupFeedCondition, string[]]>([
      ['case and trailing spaces, keeping accents', text('=', 'ALPHA'), [...named('alpha', 'Alpha ', 'ALPHA'), id(90, 'F'), id(91, 'F')]],
      ['final and capital sigma as sigma', { kind: 'in', column: 'groupname', type: 'varchar', negated: false, items: ['σ'] }, named('ς', 'Σ')],
      ['ß apart from ss', like('%ß%'), named('straße')],
      ['ſ apart from s', like('S%'), named('straße', 'STRASSE', 'star')],
      ['dotless ı apart from i', like('I%'), named('Iota')],
      ['the Kelvin sign apart from k', like('k%'), named('kelvin')],
      ['µ as Greek mu', like('µ%'), named('µ-meter', 'Μ-meter')],
      ['_ as one UTF-16 code unit', like('emoji__'), named('emoji\u{1F600}')],
      ['a backslash as a literal', like('a\\b'), named('a\\b')],
      ['_ as any character', like('a_b'), named('a\\b', 'a_b', 'a%b')],
      ['the blank-padded char(35) value', like('% ', 'photofileid'), [id(PADDED, 'F')]],
    ])('matches %s', async (_label, condition, ids) => {
      const pg = await feedOf(repo, query({ filters: where(condition) }));

      expect(pg.ids).toEqual(ids);
    });

    it.each<[string, GroupFeedQuery, number]>([
      ['a page of three under TOP 5', query({ order: [{ column: 'groupname', type: 'varchar', desc: false }], top: 5, limit: 3 }), 3],
      ['a filtered page of two', query({ filters: where(like('%a%')), order: [{ column: 'perm', type: 'numeric', desc: true }], limit: 2 }), 2],
      ['every match of a LIKE', query({ filters: where(like('a%')) }), 9],
    ])('reads %s in one fenced statement that filters, orders, counts and cuts in PostgreSQL', async (_label, feed, rows) => {
      const { ids, reads } = await feedOf(repo, feed);
      const feeds = reads.filter(({ text: sql }) => sql.includes('"group_account"'));

      expect(ids).toHaveLength(rows);
      expect(feeds).toEqual([{ text: expect.stringMatching(/^SELECT g\.\*, \(SELECT count\(\*\).* WHERE .* ORDER BY .* LIMIT \$\d+$/s), rows }]);
      expect(reads.findIndex(({ text: sql }) => sql.includes('unit_gate'))).toBeLessThan(reads.indexOf(feeds[0] as (typeof reads)[number]));
      expect(reads.some(({ text: sql }) => /DECLARE|FETCH|membership|account_operation|user_account/.test(sql))).toBe(false);
    });

    it('counts a feed whose page addresses no row without reading a group row', async () => {
      const { ids, total, reads } = await feedOf(repo, query({ filters: where(like('a%')), limit: 0 }));

      expect({ ids, total }).toEqual({ ids: [], total: 9 });
      expect(reads.filter(({ text: sql }) => sql.includes('"group_account"'))).toEqual([{ text: expect.stringMatching(/^SELECT \(SELECT count\(\*\)/), rows: 1 }]);
    });

    it.each([
      ['ASCII', ADVERSARIAL],
      ['non-ASCII', `%${'á%'.repeat(9)}b%`],
    ])('answers the backtracking %s LIKE pattern against a 255-character run quickly with no match', async (_label, pattern) => {
      const started = performance.now();
      const { total } = await feedOf(repo, query({ filters: where(like(pattern)), limit: 10 }));

      expect(total).toBe(0);
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("blocks a feed read during a window's executing phase", async () => {
      await setGates('open', 'executing');
      await expect(withGatedTenant(handle.app, FEED_TENANT, (tx) => repo.readGroupFeed(tx, 'site-a', 1, query()), { budgetMs: BUDGET_MS })).rejects.toBeInstanceOf(
        UnitReadBlockedError,
      );
    });
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

  it('locks a session of its own tenant only, and none when absent', async () => {
    await inTenant((tx) => repo.insertSession(tx, { session_id: 'S-LOCKED', csrf_secret: id(1, 'K'), mode: 'target-primary', state: 'active' }));

    expect(await inTenant((tx) => repo.lockSession(tx, 'S-LOCKED', 'update'))).toMatchObject({ session_id: 'S-LOCKED', epoch: '0', state: 'active' });
    expect(await inTenant((tx) => repo.lockSession(tx, 'S-LOCKED', 'share'), otherTenantId)).toBeNull();
    expect(await inTenant((tx) => repo.lockSession(tx, 'S-ABSENT', 'update'))).toBeNull();
  });

  it.each<[SessionLockMode, SessionLockMode, boolean]>([
    ['update', 'share', true],
    ['share', 'update', true],
    ['share', 'share', false],
  ])('holds a %s session lock against a concurrent %s lock until commit (waits: %s)', async (held, requested, waits) => {
    const sessionId = `S-LOCK-${held}-${requested}`;
    await inTenant((tx) => repo.insertSession(tx, { session_id: sessionId, csrf_secret: id(1, 'K'), mode: 'target-primary', state: 'active' }));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = inTenant(async (tx) => {
      const row = await repo.lockSession(tx, sessionId, held);
      holding();
      await released;
      return row;
    });
    await locked;

    let acquired = false;
    const waiter = inTenant(async (tx) => {
      const row = await repo.lockSession(tx, sessionId, requested);
      acquired = true;
      return row;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(acquired).toBe(!waits);
    release();

    expect(await holder).toMatchObject({ session_id: sessionId });
    expect(await waiter).toMatchObject({ session_id: sessionId });
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
    const listed = await inTenant((tx) => repo.listOAuthClients(tx, 'site-a', { offset: 0, limit: 1000 }));
    expect([listed.items.map((row) => row.clientid), listed.total]).toEqual([[client.clientid], 1]);
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
