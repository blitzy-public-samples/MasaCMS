/** Group saves and memberships against a throwaway `identity` schema: pools, legacy defaults and validation, create, update, membership changes and reads. */
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { OperationBlockedError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import type { Clock, ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { currentTransaction, tenantDbFromPool, tenantIdForSite, withMetadata, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { cfHash } from '@opt2/platform/legacy-compat';
import { createCapturingPublisher, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  GroupSaveHaltedError,
  addToGroup,
  createGroup,
  findGroupForSite,
  groupSaveInputFrom,
  MEMBER_BATCH_SIZE,
  listGroupMembers,
  listGroupMembersPage,
  listGroups,
  listGroupsPage,
  newGroupRecord,
  readFeedGroups,
  removeFromGroup,
  resolveGroupSite,
  resolveMemberPhotos,
  scanFeedGroups,
  streamGroupMembers,
  streamListedGroupMembers,
  updateGroup,
  type GroupActor,
  type GroupDeps,
  type GroupMemberRow,
  type ListedGroupMember,
  type GroupRecord,
  type GroupSaveInput,
} from '../../src/domain/groups.js';
import {
  USER_CLOSED_WAIT_MS,
  abortAccountOperation,
  commitAccountOperation,
  finishAccountOperation,
  prepareAccountOperation,
  withOpenAccount,
  type AccountOperationDeps,
} from '../../src/domain/account-operations.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import { createContentClient, type ContentClient } from '../../src/legacy/content-client.js';
import { verifyLegacyPassword } from '../../src/legacy/hash.js';
import { READ_PAGE_SIZE, charKey, createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type GroupAddressRow } from '../../src/repo/tables.js';

const TRASHED_AT = new Date('2026-11-11T09:41:05.000Z');
const SITE_A = 'tenant-a';
const UMBRELLA = 'umbrella';
const SITE_B = 'tenant-b';
const SUPER: GroupActor = { userId: 'ADDE0000-0000-0000-0000000000000001', fname: 'Admin', lname: 'User', isSuperUser: true };
const EDITOR: GroupActor = { userId: 'EDD10000-0000-0000-0000000000000001', fname: 'Ed', lname: 'Itor', isSuperUser: false };

function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** identity's content client over a strategies-content double that stores no file. */
const NO_PHOTOS: ContentClient = createContentClient({
  request<T>(): Promise<ServiceResponse<T>> {
    return Promise.resolve({ status: 200, headers: {}, body: { items: [] } as T });
  },
  close: () => Promise.resolve(),
});

/** The first window of the largest size, which holds every listing these tests seed. */
const WHOLE = { offset: 0, limit: 1000 };

/** Timeout of a case whose read polls a closed user until its sleeps total USER_CLOSED_WAIT_MS: a transaction per 100 ms poll, 3 s each under load. */
const CLOSED_POLL_TIMEOUT_MS = (USER_CLOSED_WAIT_MS / 100) * 3_000;

/** The legacy database the query faults name, and the driver prefix of their messages. */
const LEGACY_DATABASE = 'muradb_t';
const DRIVER = '[Macromedia][SQLServer JDBC Driver][SQLServer]';

/** Ungranted advisory locks on the account fence key `$1`. */
const FENCE_WAITERS_SQL =
  "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1" +
  ' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())' +
  ' AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)';

/** The columns of a private Type=1 group `groupname` of `siteid` under `userid`. */
function groupColumns(userid: string, groupname: string, siteid: string): GroupInput {
  return {
    userid, groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('groups domain', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let now = TRASHED_AT;
  let seq = 0;
  const clock: Clock = { now: () => new Date(now.getTime()) };
  const capture = createCapturingPublisher();
  const next = (prefix: string): string => id(++seq, prefix);

  function deps(): GroupDeps {
    return {
      db: handle.app,
      repo,
      events: createIdentityEvents(repo),
      clock,
      settings: { password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 }, hashAlgorithm: 'CFMX_COMPAT' },
      sleep: async () => undefined,
    };
  }
  const gated = <T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withGatedTenant(handle.app, tenantIdForSite(site), fn);
  async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), now],
      ),
    );
  }
  async function outbox(site: string): Promise<Array<{ topic: string; payload: Record<string, unknown>; version: string }>> {
    return withTenant(handle.app, tenantIdForSite(site), async (tx) => {
      const { rows } = await tx.query<{ topic: string; payload: Record<string, unknown>; version: string }>(
        `SELECT topic, envelope->'payload' AS payload, envelope->>'aggregateVersion' AS version FROM ${handle.schema}.outbox ORDER BY seq`,
      );
      return rows;
    });
  }
  async function seedUser(site: string, opts: { s2?: number; lname?: string } = {}): Promise<string> {
    const userId = next('A');
    await gated(site, async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username: `u${seq}`, type: 2, s2: opts.s2 ?? 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '' });
      await repo.upsertPersonContact(tx, { user_id: userId, site_id: site, email: null, fname: 'F', lname: opts.lname ?? null, company: null, subtype: null, aggregate_version: 1 });
    });
    return userId;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: capture, logger, clock, payloadValidators: identityPayloadValidators });
    await registerSite(SITE_A, SITE_A, UMBRELLA);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA);
    await registerSite(SITE_B, SITE_B, SITE_B);
  });
  afterAll(async () => {
    await handle?.drop();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['public visibility', { siteId: SITE_A, isPublic: 1 }, UMBRELLA, 1],
    ['private visibility', { siteId: SITE_A, isPublic: 0 }, SITE_A, 0],
    ['switchToPublic', { siteId: SITE_A, isPublic: 0, switchToPublic: ' 1 ' }, UMBRELLA, 1],
    ['switchToPrivate', { siteId: SITE_A, isPublic: 1, switchToPrivate: '1' }, SITE_A, 0],
    ['an unregistered site', { siteId: 'nowhere', isPublic: 1 }, null, 1],
  ] as const)('resolves the user pool for %s as userBean.set does', async (_case, input, pool, isPublic) => {
    expect(await resolveGroupSite(handle.app, input)).toEqual({ poolSiteId: pool, isPublic, tenantId: pool === null ? null : tenantIdForSite(pool) });
  });

  it('creates with legacy defaults: Member (isPublic=1) in the public pool, primary address, hashed random password, one group event', async () => {
    const before = (await outbox(UMBRELLA)).length;
    const result = await createGroup(deps(), SUPER, groupSaveInputFrom({ siteid: SITE_A, groupname: ' Members ', action: 'Add', type: '1' }));
    expect(result.written).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.group).toMatchObject({ groupname: 'Members', ispublic: 1, siteid: UMBRELLA, subtype: 'Default', perm: 0, inactive: 0, s2: 0, subscribe: 1, type: 1, lastupdateby: 'Admin User', lastupdatebyid: SUPER.userId });
    expect(result.group.userid).toHaveLength(35);
    const stored = await gated(UMBRELLA, (tx) => repo.findGroup(tx, result.group.userid));
    expect(stored?.password).toMatch(/^\$2a\$04\$/);
    const addresses = await gated(UMBRELLA, (tx) => repo.listGroupAddresses(tx, result.group.userid));
    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatchObject({ addressname: 'Primary', isprimary: 1, siteid: SITE_A, longitude: 0, latitude: 0 });
    const events = (await outbox(UMBRELLA)).slice(before);
    expect(events.map((e) => e.topic)).toEqual(['identity.group.changed.v1']);
    expect(events[0]?.payload).toMatchObject({ groupId: result.group.userid, siteId: UMBRELLA, isPublic: 1, deleted: false });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, result.group.userid))).toBeNull();
  });

  it('creates a private group in the private pool with the posted id, address pool, memberships and tags', async () => {
    const userId = next('B');
    const parent = next('B');
    await createGroup(deps(), SUPER, { userId: parent, siteId: SITE_A, isPublic: '0', groupName: 'Parent' });
    const result = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Editors', tags: ' a , b ,', groupID: `${parent},`, password: ' fake-pw-0001 ' });
    expect(result.group).toMatchObject({ userid: userId, siteid: SITE_A, ispublic: 0 });
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, userId))).toEqual([parent]);
    const stored = await gated(SITE_A, (tx) => repo.findGroup(tx, userId));
    expect(await verifyLegacyPassword('fake-pw-0001', stored?.password, { encryptPasswords: true, bcryptPasswords: true })).toMatchObject({ match: true });
    const addresses = await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, userId));
    expect(addresses[0]?.siteid).toBe(SITE_A);
    const events = (await outbox(SITE_A)).filter((e) => (e.payload.groupId ?? e.payload.userId) === userId);
    expect(events.map((e) => e.topic)).toEqual(['identity.group.changed.v1', 'identity.membership.changed.v1']);
    expect(events[1]?.payload).toEqual({ userId, siteId: SITE_A, groupIds: [parent] });
  });

  it('strips S2 for non-super actors and forces S2 groups private', async () => {
    const stripped = await createGroup(deps(), EDITOR, { siteId: SITE_A, isPublic: '0', s2: '1', groupName: 'NotSuper' });
    expect(stripped.group.s2).toBe(0);
    const superGroup = await createGroup(deps(), SUPER, { siteId: SITE_A, isPublic: '1', s2: '1', groupName: 'Super' });
    // The pool follows the posted visibility before S2 forces the group private.
    expect(superGroup.group).toMatchObject({ s2: 1, ispublic: 0, siteid: UMBRELLA });
  });

  it('validates as legacy and writes nothing on errors; a missing site id throws', async () => {
    const userId = next('B');
    const bad = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, groupName: 'X', hKey: 'abc', uKey: 'def', passedProtect: 'false' });
    expect(bad.written).toBe(false);
    expect(bad.errors).toEqual({ SecurityCode: "The 'Security Code' entered was not correct.", Spam: 'This submission has been marked as spam.' });
    expect(bad.group).toMatchObject({ userid: userId, groupname: 'X', password: null, ispublic: 1 });
    expect(await findGroupForSite(deps(), { groupId: userId, siteId: SITE_A })).toBeNull();
    const good = await createGroup(deps(), SUPER, { siteId: SITE_A, groupName: 'Y', hKey: cfHash('def', 'CFMX_COMPAT').toLowerCase(), uKey: 'def', passedProtect: 'notbool' });
    expect(good.errors).toEqual({});
    const unknown = await createGroup(deps(), SUPER, { siteId: 'nowhere', groupName: 'Z' });
    expect(unknown).toMatchObject({ written: false, errors: { siteid: "The 'SiteID' variable is missing." } });
    await expect(createGroup(deps(), SUPER, { siteId: '', groupName: 'Z' })).rejects.toThrow("The attribute 'SITEID' is required when saving a user.");
    await expect(updateGroup(deps(), SUPER, { userId: next('B'), groupName: 'Z' })).rejects.toThrow("The attribute 'SITEID' is required when saving a user.");
  });

  it('updates over stored values, keeps unposted memberships, replaces tags, bumps the event version, halts pool moves', async () => {
    const userId = next('B');
    const parent = next('B');
    await createGroup(deps(), SUPER, { userId: parent, siteId: SITE_A, isPublic: '0', groupName: 'P2' });
    await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Old', email: 'old@x', tags: 'one', groupID: parent });
    const storedBefore = await gated(SITE_A, (tx) => repo.findGroup(tx, userId));
    now = new Date(TRASHED_AT.getTime() + 60_000);
    const result = await updateGroup(deps(), EDITOR, groupSaveInputFrom({ userid: userId, siteid: SITE_A, isPublic: '0', groupname: 'New', tags: 'two,three' }));
    now = TRASHED_AT;
    expect(result.written).toBe(true);
    expect(result.group).toMatchObject({ groupname: 'New', email: 'old@x', siteid: SITE_A, lastupdateby: 'Ed Itor', lastupdatebyid: EDITOR.userId });
    const storedAfter = await gated(SITE_A, (tx) => repo.findGroup(tx, userId));
    expect(storedAfter?.password).toBe(storedBefore?.password);
    expect(storedAfter?.row_version).toBe('2');
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, userId))).toEqual([parent]);
    const tags = await withTenant(handle.app, tenantIdForSite(SITE_A), async (tx) => (await tx.query<{ tag: string }>(`SELECT tag FROM ${handle.schema}.user_tag WHERE userid = $1 ORDER BY tag`, [userId])).rows.map((r) => r.tag));
    expect(tags).toEqual(['three', 'two']);
    const events = (await outbox(SITE_A)).filter((e) => e.payload.groupId === userId);
    expect(events.map((e) => e.version)).toEqual(['1', '2']);
    // Posting an empty groupID list removes the memberships.
    await updateGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupID: '' });
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, userId))).toEqual([]);
    await expect(updateGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '1' })).rejects.toBeInstanceOf(GroupSaveHaltedError);
    await expect(updateGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', originID: SITE_A, categoryID: 'x' })).rejects.toBeInstanceOf(GroupSaveHaltedError);
    const missing = await updateGroup(deps(), SUPER, { userId: next('B'), siteId: SITE_A, groupName: 'Ghost' });
    expect(missing.written).toBe(false);
    const created = await updateGroup(deps(), SUPER, { siteId: SITE_A, isPublic: '0', groupName: 'ViaUpdate' });
    expect(created.written).toBe(true);
  });

  it('updates the posted address over the stored one and sets the primary address', async () => {
    const userId = next('B');
    const result = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Addr', address: { city: 'Old City', zip: '1' } });
    expect(result.written).toBe(true);
    const [primary] = await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, userId));
    await updateGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', address: { addressID: primary?.addressid, city: 'New City' }, primaryAddressID: primary?.addressid });
    const [after] = await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, userId));
    expect(after).toMatchObject<Partial<GroupAddressRow>>({ city: 'New City', zip: '1', addressname: 'Primary', isprimary: 1, siteid: SITE_A });
  });

  /** The changelog and outbox row counts of a tenant. */
  async function writeCounts(site: string): Promise<{ changelog: number; outbox: number }> {
    return withTenant(handle.app, tenantIdForSite(site), async (tx) => {
      const { rows } = await tx.query<{ changelog: number; outbox: number }>(
        `SELECT (SELECT count(*)::int FROM ${handle.schema}.changelog) AS changelog, (SELECT count(*)::int FROM ${handle.schema}.outbox) AS outbox`,
      );
      return rows[0] as { changelog: number; outbox: number };
    });
  }

  /** The driver's message for a value its column cuts, quoting the first 100 characters kept, as legacy's debug page shows it. */
  function truncation(table: string, column: string, kept: string): string {
    return `${DRIVER}String or binary data would be truncated in table '${LEGACY_DATABASE}.dbo.${table}', column '${column}'. Truncated value: '${kept}'.`;
  }
  /** The driver's message for an INSERT INTO tusers of the held id `userId`, quoting the key as stored. */
  function keyViolation(userId: string): string {
    return `${DRIVER}Violation of PRIMARY KEY constraint 'PK_tusers'. Cannot insert duplicate key in object 'dbo.tusers'. The duplicate key value is (${userId}).`;
  }
  async function tagsOf(site: string, userId: string): Promise<string[]> {
    return withTenant(handle.app, tenantIdForSite(site), async (tx) =>
      (await tx.query<{ tag: string }>(`SELECT tag FROM ${handle.schema}.user_tag WHERE userid = $1 ORDER BY tagid`, [userId])).rows.map((r) => r.tag),
    );
  }

  it.each<[string, Partial<GroupSaveInput>, string, string]>([
    ['an email of 256', { email: 'e'.repeat(256) }, 'Email', 'e'.repeat(100)],
    ['a subtype of 51', { subType: 's'.repeat(51) }, 'subType', 's'.repeat(50)],
    ['a tablist of 256', { tablist: 't'.repeat(256) }, 'tablist', 't'.repeat(100)],
  ])('fails a create and an update posting %s with the query fault of its statement, after validation and with nothing written', async (_label, posted, column, kept) => {
    vi.stubEnv('MURA_DATABASE', LEGACY_DATABASE);
    const userId = next('B');
    const stored = next('B');
    await createGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Stored' });
    const before = await writeCounts(SITE_A);

    const created = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Wide', ...posted }).catch((err: unknown) => err);
    const updated = await updateGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Renamed', ...posted }).catch((err: unknown) => err);

    const detail = truncation('tusers', column, kept);
    expect(created).toMatchObject({ name: 'LegacyQueryFault', type: 'Database', errorCode: 'HY000', detail, sql: expect.stringMatching(/^INSERT INTO tusers /) });
    expect(updated).toMatchObject({ name: 'LegacyQueryFault', errorCode: 'HY000', detail, sql: expect.stringMatching(new RegExp(`^UPDATE tusers SET[^]*WHERE UserID = '${stored}'$`)) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toBeNull();
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, stored))).toMatchObject({ groupname: 'Stored', row_version: '1' });
    expect(await writeCounts(SITE_A)).toEqual(before);
    const invalid = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Wide', hKey: 'abc', uKey: 'def', ...posted });
    expect(invalid).toMatchObject({ written: false, errors: { SecurityCode: expect.any(String) } });
  });

  it('keeps a created group without its primary address the INSERT of which fails, and fails a stored address UPDATE writing nothing', async () => {
    vi.stubEnv('MURA_DATABASE', LEGACY_DATABASE);
    const userId = next('B');
    const stored = next('B');
    await createGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Stored' });
    const [primary] = await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, stored));
    const city = 'c'.repeat(51);

    const created = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'NoAddress', tags: 'kept', address: { city } }).catch((err: unknown) => err);
    expect(created).toMatchObject({ name: 'LegacyQueryFault', detail: truncation('tuseraddresses', 'city', 'c'.repeat(50)), sql: expect.stringMatching(/^INSERT INTO tuseraddresses /) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toMatchObject({ groupname: 'NoAddress' });
    expect(await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, userId))).toEqual([]);
    expect(await tagsOf(SITE_A, userId)).toEqual(['kept']);
    expect((await outbox(SITE_A)).filter((e) => e.payload.groupId === userId).map((e) => e.topic)).toEqual(['identity.group.changed.v1']);

    const before = await writeCounts(SITE_A);
    const updated = await updateGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Renamed', address: { addressID: primary?.addressid, city } }).catch((err: unknown) => err);
    expect(updated).toMatchObject({ name: 'LegacyQueryFault', detail: truncation('tuseraddresses', 'city', 'c'.repeat(50)), sql: expect.stringMatching(/^UPDATE tuseraddresses SET/) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, stored))).toMatchObject({ groupname: 'Stored', row_version: '1' });
    expect(await writeCounts(SITE_A)).toEqual(before);
  });

  it('keeps the address update a group UPDATE failing after it leaves, and the writes before a tag the tag INSERT of which fails', async () => {
    vi.stubEnv('MURA_DATABASE', LEGACY_DATABASE);
    const stored = next('B');
    await createGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Stored', tags: 'old', address: { city: 'Old City' } });
    const [primary] = await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, stored));

    const wide = { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Renamed', subType: 's'.repeat(51), address: { addressID: primary?.addressid, city: 'New City' } };
    expect(await updateGroup(deps(), SUPER, wide).catch((err: unknown) => err)).toMatchObject({ name: 'LegacyQueryFault', detail: truncation('tusers', 'subType', 's'.repeat(50)) });
    expect(await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, stored))).toMatchObject([{ city: 'New City' }]);
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, stored))).toMatchObject({ groupname: 'Stored', row_version: '1' });

    const tag = 't'.repeat(101);
    const tagged = await updateGroup(deps(), SUPER, { userId: stored, siteId: SITE_A, isPublic: '0', groupName: 'Tagged', tags: `one,${tag},three` }).catch((err: unknown) => err);
    expect(tagged).toMatchObject({ name: 'LegacyQueryFault', detail: truncation('tuserstags', 'tag', 't'.repeat(100)), sql: expect.stringMatching(/^insert into tuserstags /) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, stored))).toMatchObject({ groupname: 'Tagged', row_version: '2' });
    expect(await tagsOf(SITE_A, stored)).toEqual(['one']);

    const userId = next('B');
    const created = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'NewTagged', tags: `one,${tag}` }).catch((err: unknown) => err);
    expect(created).toMatchObject({ name: 'LegacyQueryFault', detail: truncation('tuserstags', 'tag', 't'.repeat(100)) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toMatchObject({ groupname: 'NewTagged' });
    expect(await tagsOf(SITE_A, userId)).toEqual(['one']);
    // createAddress follows createTags, so the failed tag leaves the group without its primary address.
    expect(await gated(SITE_A, (tx) => repo.listGroupAddresses(tx, userId))).toEqual([]);
  });

  it.each<[string, string, 'group' | 'active' | 'pending', (posted: string) => string]>([
    ['a group of another tenant', SITE_B, 'group', (posted) => posted],
    ['a group of its own tenant', SITE_A, 'group', (posted) => posted],
    ['an active account of another tenant', SITE_B, 'active', (posted) => posted],
    ['a pending account of another tenant', SITE_B, 'pending', (posted) => posted],
    ['an account of its own tenant', SITE_A, 'active', (posted) => posted],
    ['a group of another tenant under the id in lower case', SITE_B, 'group', (posted) => posted.toLowerCase()],
  ])('fails a create of an id %s holds with the PK_tusers fault of its INSERT, writing nothing', async (_label, site, holder, heldId) => {
    const userId = next('B');
    const held = heldId(userId);
    await gated(site, async (tx) => {
      if (holder === 'group') await repo.insertGroup(tx, groupColumns(held, `Holder ${seq}`, site), null);
      else await repo.insertAccount(tx, { userid: held, username: `h${seq}`, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '', opt2_state: holder });
    });
    const stored = (tx: TenantTx): Promise<unknown> => (holder === 'group' ? repo.findGroup(tx, held) : repo.findAccountById(tx, held, { includePending: true }));
    const before = await gated(site, stored);
    const counts = await writeCounts(SITE_A);

    const created = await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Taken', tags: 'kept', address: { city: 'Held' } }).catch((err: unknown) => err);

    expect(created).toMatchObject({
      name: 'LegacyQueryFault',
      type: 'Database',
      errorCode: '23000',
      detail: keyViolation(userId),
      sql: expect.stringMatching(new RegExp(`^INSERT INTO tusers [^]*VALUES\\(\\n         '${userId}',`)),
    });
    expect(before).not.toBeNull();
    expect(await gated(site, stored)).toEqual(before);
    expect(await writeCounts(SITE_A)).toEqual(counts);
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toEqual(holder === 'group' && site === SITE_A ? before : null);
    expect(await tagsOf(SITE_A, userId)).toEqual([]);
  });

  it('lets one of two concurrent creates of one id in two tenants write, failing the other with the PK_tusers fault', async () => {
    const userId = next('B');

    const results = await Promise.allSettled([SITE_A, SITE_B].map((siteId) => createGroup(deps(), SUPER, { userId, siteId, isPublic: '0', groupName: `Twin ${siteId}` })));

    expect(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.written] : []))).toEqual([true]);
    expect(results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))).toEqual([
      expect.objectContaining({ name: 'LegacyQueryFault', errorCode: '23000', detail: keyViolation(userId) }),
    ]);
    const rows = await Promise.all([SITE_A, SITE_B].map((site) => gated(site, (tx) => repo.findGroup(tx, userId))));
    expect(rows.filter((row) => row !== null)).toHaveLength(1);
  });

  it("fails a create that queued on the account fence of another process's create of the id in another tenant, once that create commits", async () => {
    const userId = next('B');
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The other process's create: its group row commits when it ends the transaction holding the exclusive fence.
    const other = withOpenAccount(
      handle.app,
      tenantIdForSite(SITE_B),
      userId,
      async (tx) => {
        await repo.insertGroup(tx, groupColumns(userId, 'Other process', SITE_B), null);
        entered();
        await released;
      },
      { exclusive: true },
    );
    await holding;
    let settled = false;
    const creating = createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'This process' })
      .catch((err: unknown) => err)
      .finally(() => {
        settled = true;
      });
    const key = `${handle.schema}.account_operation:${charKey(userId)}`;
    while (!settled && ((await handle.adminPool.query<{ waiting: number }>(FENCE_WAITERS_SQL, [key])).rows[0]?.waiting ?? 0) === 0) await delay(5);
    release();
    await other;

    expect(await creating).toMatchObject({ name: 'LegacyQueryFault', errorCode: '23000', detail: keyViolation(userId) });
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toBeNull();
    expect(await gated(SITE_B, (tx) => repo.findGroup(tx, userId))).toMatchObject({ groupname: 'Other process' });
  });

  it('answers a create whose holder check gets no second connection within USER_CLOSED_WAIT_MS with the legacy 503, writing nothing', async () => {
    // The create's own transaction holds the only connection.
    const single = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    const userId = next('B');
    const from = performance.now();

    const outcome = await createGroup({ ...deps(), db: single, sleep: undefined }, SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Starved' }).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(OperationBlockedError);
    expect(outcome).toMatchObject({ reason: 'operation-blocked', message: expect.stringContaining(userId) });
    expect(performance.now() - from).toBeLessThan(USER_CLOSED_WAIT_MS + 2_500);
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toBeNull();
  }, USER_CLOSED_WAIT_MS * 4);

  it('answers an update of an unknown group id with no write and no fault, as legacy\'s UPDATE matches no row', async () => {
    expect(await updateGroup(deps(), SUPER, { userId: next('B'), siteId: SITE_A, isPublic: '0', groupName: 'Ghost', subType: 's'.repeat(51) })).toMatchObject({ written: false });
    expect(await updateGroup(deps(), SUPER, { userId: next('B'), siteId: SITE_A, isPublic: '0', groupName: 'Ghost', perm: '300' })).toMatchObject({ written: false });
  });

  it('saves values at the legacy widths: email 255, subtype 50 and tablist 255', async () => {
    const wide = { email: 'e'.repeat(255), subType: 's'.repeat(50), tablist: 't'.repeat(255) };
    const result = await createGroup(deps(), SUPER, { siteId: SITE_A, isPublic: '0', groupName: 'AtWidth', ...wide });
    expect(result).toMatchObject({ written: true, group: { email: wide.email, subtype: wide.subType, tablist: wide.tablist } });
    const updated = await updateGroup(deps(), SUPER, { userId: result.group.userid, siteId: SITE_A, isPublic: '0', groupName: 'AtWidth', ...wide });
    expect(updated.written).toBe(true);
  });

  it.each([
    ['ends during the first wait, then lands', true],
    ['outlasts the wait, answering the legacy 503 with nothing written', false],
  ] as const)('holds a membership change of a user an open account operation keeps closed: one that %s', async (_case, ends) => {
    const groupId = next('B');
    await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: 'Held', perm: '0' });
    const userId = await seedUser(SITE_A);
    const operationId = (await gated(SITE_A, (tx) => repo.insertAccountOperation(tx, { user_id: userId, kind: 'update', state: 'prepared' }))).operation_id;
    const before = (await outbox(SITE_A)).length;
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      if (ends && sleeps.length === 1) await gated(SITE_A, (tx) => repo.setAccountOperationState(tx, operationId, ['prepared'], 'aborted'));
    };

    const outcome = await addToGroup({ ...deps(), sleep }, { userId, groupId }).catch((err: unknown) => err);

    expect(outcome).toEqual(ends ? true : expect.any(OperationBlockedError));
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(ends ? sleeps[0] : USER_CLOSED_WAIT_MS);
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, userId))).toEqual(ends ? [groupId] : []);
    expect((await outbox(SITE_A)).length).toBe(ends ? before + 1 : before);
  }, CLOSED_POLL_TIMEOUT_MS);

  it('adds idempotently, removes, emits full sets, lists members and groups with counters', async () => {
    const groupId = next('B');
    await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: 'Team', perm: '1' });
    const zed = await seedUser(SITE_A, { lname: 'Zed' });
    const amy = await seedUser(SITE_A, { lname: 'amy' });
    const boss = await seedUser(SITE_A, { lname: 'Boss', s2: 1 });
    const before = (await outbox(SITE_A)).length;
    expect(await addToGroup(deps(), { userId: zed, groupId })).toBe(true);
    expect(await addToGroup(deps(), { userId: zed, groupId })).toBe(false);
    expect(await addToGroup(deps(), { userId: amy, groupId })).toBe(true);
    expect(await addToGroup(deps(), { userId: boss, groupId })).toBe(true);
    expect(await addToGroup(deps(), { userId: next('A'), groupId })).toBe(false);
    const events = (await outbox(SITE_A)).slice(before);
    expect(events.map((e) => e.payload)).toEqual([
      { userId: zed, siteId: SITE_A, groupIds: [groupId] },
      { userId: amy, siteId: SITE_A, groupIds: [groupId] },
      { userId: boss, siteId: SITE_A, groupIds: [groupId] },
    ]);
    expect((await listGroupMembers(deps(), groupId)).map((m) => m.lname)).toEqual(['amy', 'Zed']);
    expect((await listGroupMembers(deps(), groupId, { includeS2: true })).map((m) => m.lname)).toEqual(['amy', 'Boss', 'Zed']);
    const groups = await listGroups(deps(), { siteId: SITE_A, isPublic: 0 });
    expect(groups[0]).toMatchObject({ userid: groupId, perm: 1, counter: 3 });
    expect(groups.slice(1).every((g) => g.perm === 0)).toBe(true);
    expect(await removeFromGroup(deps(), { userId: amy, groupId })).toBe(true);
    expect(await removeFromGroup(deps(), { userId: amy, groupId })).toBe(false);
    expect((await outbox(SITE_A)).at(-1)?.payload).toEqual({ userId: amy, siteId: SITE_A, groupIds: [] });
    expect(newGroupRecord(clock, 'X')).toMatchObject({ userid: 'X', ispublic: 1, subtype: 'Default', type: 1, subscribe: 1 });
    expect((await findGroupForSite(deps(), { groupId, siteId: SITE_B }))?.tenantId).toBe(tenantIdForSite(SITE_A));
  });

  it('settles concurrent adds of one membership with one row, one changelog insert and one event; the rest add nothing', async () => {
    const groupId = next('B');
    await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: 'Race' });
    const userId = await seedUser(SITE_A);
    const before = (await outbox(SITE_A)).length;
    const lockWaits = async (): Promise<number> =>
      (await handle.adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND wait_event = 'transactionid'", [handle.roles.app])).rows[0]?.n ?? 0;
    const rollback = new Error('rollback');
    let adds: Promise<boolean[]> = Promise.resolve([]);
    // An uncommitted row holds the adds' inserts until two wait, so they contend for the row once it rolls back.
    await expect(
      gated(SITE_A, async (tx) => {
        await repo.addMembership(tx, userId, groupId);
        adds = Promise.all(Array.from({ length: 10 }, () => addToGroup(deps(), { userId, groupId })));
        while ((await lockWaits()) < 2) await delay(5);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    const outcomes = await adds;

    expect(outcomes.filter((added) => added)).toHaveLength(1);
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, userId))).toEqual([groupId]);
    const logged = await withTenant(handle.app, tenantIdForSite(SITE_A), async (tx) =>
      (await tx.query<{ op: string }>(`SELECT op FROM ${handle.schema}.changelog WHERE "table" = 'membership' AND strpos(key, $1) > 0`, [userId])).rows,
    );
    expect(logged).toEqual([{ op: 'insert' }]);
    expect((await outbox(SITE_A)).slice(before).map((e) => e.payload)).toEqual([{ userId, siteId: SITE_A, groupIds: [groupId] }]);
  });

  describe('collection reads', () => {
    const CLOSED_SITE = 'closed-pool';
    const PAGE_SITE = 'page-pool';
    const COUNT_SITE = 'count-pool';
    const REPLAY_SITE = 'replay-pool';
    const WINDOW_SITE = 'window-pool';
    type Statement = { tenantId: string; text: string; values?: unknown[] };

    beforeAll(async () => {
      for (const site of [CLOSED_SITE, PAGE_SITE, COUNT_SITE, REPLAY_SITE, WINDOW_SITE]) await registerSite(site, site, site);
    });

    /** `handle.app` whose tenant transactions record each statement with its tenant and values. */
    function recordingDb(statements: Statement[]): TenantDb {
      return {
        ...handle.app,
        withTenant: (tenantId, fn) =>
          handle.app.withTenant(tenantId, (tx) => {
            const query = ((text: string, values?: unknown[]) => {
              statements.push({ tenantId, text, values });
              return tx.query(text, values);
            }) as TenantTx['query'];
            return fn({ ...tx, query });
          }),
      };
    }

    /** A sleep recording each wait and whether a transaction was open during it, then running `onSleep`. */
    function sleeper(onSleep: () => Promise<void> = async () => undefined): { sleep: (ms: number) => Promise<void>; slept: number[]; inTransaction: boolean[] } {
      const slept: number[] = [];
      const inTransaction: boolean[] = [];
      const sleep = async (ms: number): Promise<void> => {
        slept.push(ms);
        inTransaction.push(currentTransaction() !== undefined);
        await onSleep();
      };
      return { sleep, slept, inTransaction };
    }

    async function openOperation(site: string, userId: string, state: 'prepared' | 'committed', kind: 'create' | 'update' = 'update'): Promise<string> {
      return (await gated(site, (tx) => repo.insertAccountOperation(tx, { user_id: userId, kind, state }))).operation_id;
    }

    async function settleOperation(site: string, operationId: string, from: 'prepared' | 'committed', to: 'aborted' | 'finished'): Promise<void> {
      expect(await gated(site, (tx) => repo.setAccountOperationState(tx, operationId, [from], to))).toBe(true);
    }

    async function insertPendingAccount(site: string): Promise<string> {
      const userId = next('A');
      await gated(site, (tx) =>
        repo.insertAccount(tx, { userid: userId, username: `p${seq}`, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '', opt2_state: 'pending' }),
      );
      return userId;
    }

    async function addMembers(site: string, groupId: string, userIds: readonly string[]): Promise<void> {
      await gated(site, async (tx) => {
        for (const userId of userIds) await repo.addMembership(tx, userId, groupId);
      });
    }

    async function closedGroup(): Promise<{ groupId: string; member: string }> {
      const groupId = next('B');
      await createGroup(deps(), SUPER, { userId: groupId, siteId: CLOSED_SITE, isPublic: '0', groupName: `Closed ${seq}` });
      const member = await seedUser(CLOSED_SITE, { lname: 'Member' });
      await addMembers(CLOSED_SITE, groupId, [member]);
      return { groupId, member };
    }

    const reads = {
      listGroupMembers: async (d: GroupDeps, groupId: string): Promise<number | null> => (await listGroupMembers(d, groupId, { includeS2: true })).length,
      listGroups: async (d: GroupDeps, groupId: string): Promise<number | null> =>
        (await listGroups(d, { siteId: CLOSED_SITE, isPublic: 0 })).find((row) => row.userid === groupId)?.counter ?? null,
      listGroupMembersPage: async (d: GroupDeps, groupId: string): Promise<number | null> => {
        const { members, total } = await listGroupMembersPage(d, NO_PHOTOS, groupId, { includeS2: true, page: WHOLE });
        expect(total).toBe(members.length);
        return total;
      },
      listGroupsPage: async (d: GroupDeps, groupId: string): Promise<number | null> =>
        (await listGroupsPage(d, { siteId: CLOSED_SITE, isPublic: 0, page: WHOLE })).rows.find((row) => row.userid === groupId)?.counter ?? null,
    };
    const READ_NAMES = Object.keys(reads) as (keyof typeof reads)[];

    it.each(READ_NAMES.flatMap((read) => [[read, 'prepared', 'aborted'], [read, 'committed', 'finished']] as const))('%s waits outside its transaction while a %s account operation keeps a member closed, then reads once it is %s', async (read, state, end) => {
      const { groupId, member } = await closedGroup();
      const operationId = await openOperation(CLOSED_SITE, member, state);
      const { sleep, slept, inTransaction } = sleeper(() => settleOperation(CLOSED_SITE, operationId, state, end));
      expect(await reads[read]({ ...deps(), sleep }, groupId)).toBe(1);
      expect(slept).toEqual([100]);
      expect(inTransaction).toEqual([false]);
    });

    it.each(READ_NAMES)('%s answers the legacy 503 naming the closed member once its sleeps total USER_CLOSED_WAIT_MS', async (read) => {
      const { groupId, member } = await closedGroup();
      const operationId = await openOperation(CLOSED_SITE, member, 'committed');
      const { sleep, slept, inTransaction } = sleeper();
      try {
        const failure = await reads[read]({ ...deps(), sleep }, groupId).then(
          () => null,
          (err: unknown) => err,
        );
        expect(failure).toBeInstanceOf(OperationBlockedError);
        expect(failure).toMatchObject({ reason: 'operation-blocked', message: expect.stringContaining(member) });
        expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
        expect(inTransaction.every((open) => !open)).toBe(true);
      } finally {
        await settleOperation(CLOSED_SITE, operationId, 'committed', 'finished');
      }
    }, CLOSED_POLL_TIMEOUT_MS);

    it.each(READ_NAMES)('%s waits while a prepared create holds a membership of its pending account, then neither lists nor counts it', async (read) => {
      const { groupId } = await closedGroup();
      const pending = await insertPendingAccount(CLOSED_SITE);
      await addMembers(CLOSED_SITE, groupId, [pending]);
      const operationId = await openOperation(CLOSED_SITE, pending, 'prepared', 'create');
      const { sleep, slept } = sleeper(() => settleOperation(CLOSED_SITE, operationId, 'prepared', 'aborted'));
      expect(await reads[read]({ ...deps(), sleep }, groupId)).toBe(1);
      expect(slept).toEqual([100]);
    });

    it.each([1, 2, 7, READ_PAGE_SIZE])('reads a tenant in pages of %i into the full list: NULL last names first, then case-insensitively, ties by userid', async (pageSize) => {
      const groupId = next('B');
      await createGroup(deps(), SUPER, { userId: groupId, siteId: PAGE_SITE, isPublic: '0', groupName: `Paged ${seq}` });
      const members: string[] = [];
      for (const lname of [null, 'beta', 'alpha', 'Alpha', null, 'Charlie', 'bravo']) members.push(await seedUser(PAGE_SITE, lname === null ? {} : { lname }));
      await addMembers(PAGE_SITE, groupId, members);
      const [nullA, beta, alpha, upperAlpha, nullB, charlie, bravo] = members;
      const statements: Statement[] = [];
      const paged = { ...deps(), db: recordingDb(statements), repo: createIdentityRepository({ clock, schema: handle.schema, pageSize }) };
      const listed = await listGroupMembers(paged, groupId, { includeS2: true });
      expect(listed.map((row) => row.userid)).toEqual([nullA, nullB, alpha, upperAlpha, beta, bravo, charlie]);
      expect(listed).toEqual(await listGroupMembers(deps(), groupId, { includeS2: true }));
      expect(Object.keys(listed[0] ?? {})).toEqual([
        'userid', 'type', 'username', 'siteid', 'ispublic', 's2', 'inactive', 'fname', 'lname', 'email', 'company', 'groupname', 'passwordcreated',
        'jobtitle', 'mobilephone', 'website', 'subtype', 'contactform', 'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'perm',
        'subscribe', 'notes', 'description', 'interests', 'keepprivate', 'photofileid', 'imname', 'imservice', 'created', 'remoteid', 'tags', 'tablist',
      ]);
      const fetches = statements.filter((s) => s.tenantId === tenantIdForSite(PAGE_SITE) && s.text.startsWith('FETCH'));
      expect(fetches).toHaveLength(Math.floor(members.length / pageSize) + 1);
    });

    it.each([1, READ_PAGE_SIZE])('merges members held in several tenants in last-name order, read in pages of %i', async (pageSize) => {
      const groupId = next('B');
      await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: `Merged ${seq}` });
      const seeds: readonly (readonly [string, string | null])[] = [
        [SITE_B, null],
        [SITE_A, null],
        [SITE_A, 'b'],
        [UMBRELLA, 'B'],
        [SITE_B, 'A'],
        [SITE_B, 'c'],
        [SITE_A, 'D'],
        [SITE_B, 'e'],
      ];
      const ids: string[] = [];
      for (const [site, lname] of seeds) {
        const member = await seedUser(site, lname === null ? {} : { lname });
        await addMembers(site, groupId, [member]);
        ids.push(member);
      }
      const [nullB, nullA, lowerB, upperB, upperA, lowerC, upperD, lowerE] = ids;
      const paged = { ...deps(), repo: createIdentityRepository({ clock, schema: handle.schema, pageSize }) };
      expect((await listGroupMembers(paged, groupId, { includeS2: true })).map((row) => row.userid)).toEqual([nullB, nullA, upperA, lowerB, upperB, lowerC, upperD, lowerE]);
    });

    it('counts every listed group in the listing statement: NULL for none, S2, group and active members counted, pending ones not', async () => {
      const statements: Statement[] = [];
      const counting = { ...deps(), db: recordingDb(statements) };
      const memberReads = (): number => statements.filter((s) => s.text.includes(`"${handle.schema}"."membership"`)).length;
      const team = next('B');
      await createGroup(deps(), SUPER, { userId: team, siteId: COUNT_SITE, isPublic: '0', groupName: 'Team', perm: '1' });
      expect((await listGroups(counting, { siteId: COUNT_SITE, isPublic: 0 })).map((row) => [row.groupname, row.counter])).toEqual([['Team', null]]);
      const oneGroup = { statements: statements.length, memberReads: memberReads() };
      expect(oneGroup.memberReads).toBe(1);

      const solo = next('B');
      const pendingOnly = next('B');
      await createGroup(deps(), SUPER, { userId: solo, siteId: COUNT_SITE, isPublic: '0', groupName: 'solo' });
      await createGroup(deps(), SUPER, { userId: pendingOnly, siteId: COUNT_SITE, isPublic: '0', groupName: 'Pending' });
      await createGroup(deps(), SUPER, { siteId: COUNT_SITE, isPublic: '0', groupName: 'Empty' });
      await createGroup(deps(), SUPER, { siteId: COUNT_SITE, isPublic: '0', groupName: 'Child', groupID: team });
      const active = await seedUser(COUNT_SITE);
      const superUser = await seedUser(COUNT_SITE, { s2: 1 });
      await addMembers(COUNT_SITE, team, [active, superUser]);
      await addMembers(COUNT_SITE, solo, [active]);
      await addMembers(COUNT_SITE, pendingOnly, [await insertPendingAccount(COUNT_SITE)]);
      statements.length = 0;
      const listed = await listGroups(counting, { siteId: COUNT_SITE, isPublic: 0 });
      expect(listed.map((row) => [row.groupname, row.counter])).toEqual([
        ['Team', 3],
        ['Child', null],
        ['Empty', null],
        ['Pending', null],
        ['solo', 1],
      ]);
      expect({ statements: statements.length, memberReads: memberReads() }).toEqual(oneGroup);
      expect(listed[0]).not.toHaveProperty('closed_users');
    });

    describe('group windows', () => {
      beforeAll(async () => {
        const groups: readonly (readonly [string, string])[] = [['beta', '0'], ['Zulu', '1'], ['alpha', '1'], ['Beta', '0'], ['gamma', '0'], ['Alpha', '0']];
        const ids: string[] = [];
        for (const [groupName, perm] of groups) {
          const userId = next('B');
          await createGroup(deps(), SUPER, { userId, siteId: WINDOW_SITE, isPublic: '0', groupName, perm });
          ids.push(userId);
        }
        const member = await seedUser(WINDOW_SITE, { s2: 1 });
        await addMembers(WINDOW_SITE, ids[0] ?? '', [member]);
        await addMembers(WINDOW_SITE, ids[2] ?? '', [member, await seedUser(WINDOW_SITE)]);
      });

      it.each([
        [0, 1000],
        [0, 2],
        [1, 3],
        [4, 2],
        [5, 1],
        [6, 1],
        [50, 10],
      ])("answers the window at offset %i, limit %i of listGroups' rows, order and counts byte for byte, with its total", async (offset, limit) => {
        const whole = await listGroups(deps(), { siteId: WINDOW_SITE, isPublic: 0 });

        const page = await listGroupsPage(deps(), { siteId: WINDOW_SITE, isPublic: 0, page: { offset, limit } });

        expect(page).toEqual({ rows: whole.slice(offset, offset + limit), total: whole.length });
        expect(whole.map((row) => [row.groupname, row.perm, row.counter])).toEqual([
          ['alpha', 1, 2],
          ['Zulu', 1, null],
          ['Alpha', 0, null],
          ['beta', 0, 1],
          ['Beta', 0, null],
          ['gamma', 0, null],
        ]);
      });

      it('answers a site without a user pool tenant with an empty listing', async () => {
        expect(await listGroupsPage(deps(), { siteId: 'nowhere', isPublic: 0, page: WHOLE })).toEqual({ rows: [], total: 0 });
      });
    });

    describe('feed scans', () => {
      const FEED_SITE = 'feed-pool';
      const FEED_PUBLIC = 'feed-public';
      const groupIds = new Map<string, string>();
      let closing = '';

      beforeAll(async () => {
        await registerSite(FEED_SITE, FEED_SITE, FEED_PUBLIC);
        await registerSite(FEED_PUBLIC, FEED_PUBLIC, FEED_PUBLIC);
        const seeds: ReadonlyArray<[string, GroupSaveInput]> = [
          ['Private', { siteId: FEED_SITE, isPublic: '0' }],
          ['Super', { siteId: FEED_SITE, isPublic: '0', s2: '1' }],
          ['Dormant', { siteId: FEED_SITE, isPublic: '0', inActive: '1' }],
          ['Public', { siteId: FEED_SITE, isPublic: '1' }],
          ['Public dormant', { siteId: FEED_SITE, isPublic: '1', inActive: '1' }],
          ['Public site private', { siteId: FEED_PUBLIC, isPublic: '0' }],
        ];
        for (const [groupName, input] of seeds) {
          const userId = next('B');
          groupIds.set(groupName, userId);
          await createGroup(deps(), SUPER, { ...input, userId, groupName });
        }
        // An open operation on a member of Private, which a counted listing would wait out.
        const member = await seedUser(FEED_SITE, { lname: 'Member' });
        await addMembers(FEED_SITE, groupIds.get('Private') ?? '', [member]);
        closing = await openOperation(FEED_SITE, member, 'committed');
      });

      afterAll(async () => {
        await settleOperation(FEED_SITE, closing, 'committed', 'finished');
      });

      it.each<[string, string, 0 | 1, boolean, number | undefined, number, string[]]>([
        ['the private pool to an S2 reader', FEED_SITE, 0, true, undefined, 1, ['Private', 'Super', 'Dormant']],
        ['the private pool without S2 groups', FEED_SITE, 0, false, undefined, 2, ['Private', 'Dormant']],
        ['the inactive groups of the private pool', FEED_SITE, 0, true, 1, 2, ['Dormant']],
        ['the active groups of the public pool another tenant holds', FEED_SITE, 1, false, 0, 1, ['Public']],
        ['the public pool in pages of the read size', FEED_SITE, 1, true, undefined, READ_PAGE_SIZE, ['Public', 'Public dormant']],
        ['no page of an unregistered site', 'no-such-feed-site', 0, true, undefined, 1, []],
      ])('scanFeedGroups passes %s by userid page by page, reading no member and waiting on no closed one', async (_label, siteId, isPublic, includeS2, inactive, pageSize, names) => {
        const statements: Statement[] = [];
        const { sleep, slept } = sleeper();
        const scanning = { ...deps(), sleep, db: recordingDb(statements), repo: createIdentityRepository({ clock, schema: handle.schema, pageSize }) };
        const pages: GroupRecord[][] = [];

        await scanFeedGroups(scanning, { siteId, isPublic, includeS2, inactive }, (rows) => pages.push(rows));

        const ids = names.map((name) => groupIds.get(name));
        expect(pages.map((rows) => rows.map((row) => row.userid))).toEqual(
          Array.from({ length: Math.ceil(ids.length / pageSize) }, (_, n) => ids.slice(n * pageSize, (n + 1) * pageSize)),
        );
        expect(pages.flat().some((row) => 'tenant_id' in row || 'row_version' in row)).toBe(false);
        expect(statements.filter((s) => s.text.startsWith('DECLARE'))).toHaveLength(siteId === FEED_SITE ? 1 : 0);
        expect(statements.some((s) => s.text.includes(`"${handle.schema}"."membership"`) || s.text.includes(`"${handle.schema}"."account_operation"`))).toBe(false);
        expect(slept).toEqual([]);
      });

      it.each<[string, string, 0 | 1, boolean, number | undefined, number, number, string[], number]>([
        ['the private pool to an S2 reader by name', FEED_SITE, 0, true, undefined, Infinity, Infinity, ['Dormant', 'Private', 'Super'], 3],
        ['the first two private groups without S2 ones', FEED_SITE, 0, false, undefined, 2, Infinity, ['Dormant', 'Private'], 2],
        ['the inactive private groups', FEED_SITE, 0, true, 1, 5, Infinity, ['Dormant'], 1],
        ['the private pool counted up to a TOP of two', FEED_SITE, 0, true, undefined, 2, 2, ['Dormant', 'Private'], 2],
        ['no row but the count of the public pool another tenant holds', FEED_SITE, 1, true, undefined, 0, Infinity, [], 2],
        ['nothing of an unregistered site', 'no-such-feed-site', 0, true, undefined, 5, Infinity, [], 0],
      ])('readFeedGroups reads %s in one statement, reading no member and waiting on no closed one', async (_label, siteId, isPublic, includeS2, inactive, limit, top, names, total) => {
        const statements: Statement[] = [];
        const { sleep, slept } = sleeper();
        const reading = { ...deps(), sleep, db: recordingDb(statements) };
        const order = [{ column: 'groupname', type: 'varchar' as const, desc: false }];

        const page = await readFeedGroups(reading, { siteId, isPublic }, { includeS2, inactive, filters: [], order, top, limit });

        expect(page.rows.map((row) => row.userid)).toEqual(names.map((name) => groupIds.get(name)));
        expect(page.total).toBe(total);
        expect(page.rows.some((row) => 'tenant_id' in row || 'row_version' in row)).toBe(false);
        const feeds = statements.filter((s) => s.text.includes(`"${handle.schema}"."group_account"`));
        expect(feeds).toHaveLength(siteId === FEED_SITE ? 1 : 0);
        expect(feeds.every((s) => s.text.startsWith('SELECT') && s.text.includes('count(*)'))).toBe(true);
        expect(statements.some((s) => s.text.includes(`"${handle.schema}"."membership"`) || s.text.includes(`"${handle.schema}"."account_operation"`))).toBe(false);
        expect(slept).toEqual([]);
      });
    });

    describe('roster operations', () => {
      const accountDeps = (): AccountOperationDeps => ({
        db: handle.app,
        repo,
        events: createIdentityEvents(repo),
        clock,
        settings: { password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 }, strongPasswords: false, strongPasswordRegex: '' },
        sleep: async () => undefined,
      });

      async function seedRosterUser(groupIds: readonly string[]): Promise<{ userId: string; username: string }> {
        const userId = next('A');
        const username = `roster${seq}`;
        await gated(REPLAY_SITE, async (tx) => {
          await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: REPLAY_SITE, remoteid: '', tablist: '' });
          await repo.writeCredential(tx, userId, { password: 'stored', passwordcreated: now });
          await repo.upsertPersonContact(tx, { user_id: userId, site_id: REPLAY_SITE, email: null, fname: 'F', lname: 'Roster', company: null, subtype: null, aggregate_version: 1 });
          for (const groupId of groupIds) await repo.addMembership(tx, userId, groupId);
        });
        return { userId, username };
      }

      /** A fresh id that a prepared roster create keeps closed in `siteId`'s private pool until the operation ends. */
      async function closedId(siteId: string): Promise<{ userId: string; operationId: string }> {
        const userId = next('B');
        const operationId = next('C');
        const change = { username: `closed${seq}`, password: '', s2: 0, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: null };
        const prepared = await prepareAccountOperation(accountDeps(), { operationId, kind: 'create', userId, requestSiteId: siteId, actorUserId: SUPER.userId, siteId, actorIsSuperUser: true, change });
        expect(prepared.outcome).toBe('prepared');
        return { userId, operationId };
      }

      /** A timer sleep that first calls `onFirst`, so a case can start work while the poll waits. */
      function signallingSleep(onFirst: () => void): (ms: number) => Promise<void> {
        return (ms) => {
          onFirst();
          return delay(ms);
        };
      }

      /** Each change: whether the user starts as the group's member, the S2 it posts and whether it keeps or adds the group. */
      const CHANGES = {
        'removes the sole member': { member: true, s2: 0, joins: false },
        'raises S2 of the sole member': { member: true, s2: 1, joins: true },
        'adds the first member': { member: false, s2: 0, joins: true },
      } as const;
      type Change = keyof typeof CHANGES;
      type Membership = { member: boolean; s2: number };

      const READS = {
        'listGroupMembers': {
          read: async (d: GroupDeps, groupId: string): Promise<unknown> => (await listGroupMembers(d, groupId)).map((row) => row.userid),
          shows: ({ member, s2 }: Membership, userId: string): unknown => (member && s2 === 0 ? [userId] : []),
        },
        'listGroupMembers with includeS2': {
          read: async (d: GroupDeps, groupId: string): Promise<unknown> => (await listGroupMembers(d, groupId, { includeS2: true })).map((row) => row.userid),
          shows: ({ member }: Membership, userId: string): unknown => (member ? [userId] : []),
        },
        'listGroups': {
          read: async (d: GroupDeps, groupId: string): Promise<unknown> =>
            (await listGroups(d, { siteId: REPLAY_SITE, isPublic: 0 })).find((row) => row.userid === groupId)?.counter,
          shows: ({ member }: Membership): unknown => (member ? 1 : null),
        },
        'listGroupMembersPage': {
          read: async (d: GroupDeps, groupId: string): Promise<unknown> =>
            (await listGroupMembersPage(d, NO_PHOTOS, groupId, { page: WHOLE })).members.map((row) => row.userid),
          shows: ({ member, s2 }: Membership, userId: string): unknown => (member && s2 === 0 ? [userId] : []),
        },
        'listGroupsPage': {
          read: async (d: GroupDeps, groupId: string): Promise<unknown> =>
            (await listGroupsPage(d, { siteId: REPLAY_SITE, isPublic: 0, page: WHOLE })).rows.find((row) => row.userid === groupId)?.counter,
          shows: ({ member }: Membership): unknown => (member ? 1 : null),
        },
      } as const;
      type Read = keyof typeof READS;

      const cases = (Object.keys(CHANGES) as Change[]).flatMap((change) =>
        (['prepared', 'committed'] as const).flatMap((state) => (Object.keys(READS) as Read[]).map((read) => [change, state, read] as const)),
      );

      it.each(cases)('an update that %s keeps it %s: %s answers the legacy 503 after USER_CLOSED_WAIT_MS, then waits for the end and reads its outcome', async (change, state, read) => {
        const { member, s2, joins } = CHANGES[change];
        const groupId = next('B');
        await createGroup(deps(), SUPER, { userId: groupId, siteId: REPLAY_SITE, isPublic: '0', groupName: `Replay ${seq}` });
        const { userId, username } = await seedRosterUser(member ? [groupId] : []);
        const operationId = next('C');
        const prepared = await prepareAccountOperation(accountDeps(), {
          operationId,
          kind: 'update',
          userId,
          requestSiteId: REPLAY_SITE,
          actorUserId: SUPER.userId,
          siteId: REPLAY_SITE,
          actorIsSuperUser: true,
          change: { username, password: '', s2, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: joins ? [groupId] : [] },
        });
        expect(prepared.outcome).toBe('prepared');
        if (state === 'committed') expect((await commitAccountOperation(accountDeps(), operationId)).outcome).toBe('committed');
        const { read: runRead, shows } = READS[read];

        const blocked = sleeper();
        const failure = await runRead({ ...deps(), sleep: blocked.sleep }, groupId).then(
          () => null,
          (err: unknown) => err,
        );
        expect(failure).toBeInstanceOf(OperationBlockedError);
        expect(failure).toMatchObject({ message: expect.stringContaining(userId) });
        expect(blocked.slept.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
        expect(blocked.inTransaction.every((open) => !open)).toBe(true);

        const end = state === 'prepared' ? abortAccountOperation : finishAccountOperation;
        const waiting = sleeper(async () => {
          expect((await end(accountDeps(), operationId)).outcome).toBe('stepped');
        });
        const outcome: Membership = state === 'prepared' ? { member, s2: 0 } : { member: joins, s2 };
        expect(await runRead({ ...deps(), sleep: waiting.sleep }, groupId)).toEqual(shows(outcome, userId));
        expect(waiting.slept).toEqual([100]);
      }, CLOSED_POLL_TIMEOUT_MS);

      it('keeps one holder of an id a roster create and a group create of another tenant race for, refusing the other', async () => {
        const userId = next('B');
        const operationId = next('C');
        const change = { username: `racer${seq}`, password: '', s2: 0, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: null };
        const prepare = { operationId, kind: 'create', userId, requestSiteId: REPLAY_SITE, actorUserId: SUPER.userId, siteId: REPLAY_SITE, actorIsSuperUser: true, change } as const;

        const [roster, group] = await Promise.allSettled([
          prepareAccountOperation(accountDeps(), prepare),
          createGroup(deps(), SUPER, { userId, siteId: SITE_B, isPublic: '0', groupName: `Racer ${seq}` }),
        ]);

        const rosterWon = roster.status === 'fulfilled';
        expect(roster).toEqual(
          rosterWon
            ? { status: 'fulfilled', value: expect.objectContaining({ outcome: 'prepared' }) }
            : { status: 'rejected', reason: expect.objectContaining({ name: 'LegacyApiError', type: 'badRequest' }) },
        );
        expect(group).toEqual(
          rosterWon
            ? { status: 'rejected', reason: expect.objectContaining({ name: 'LegacyQueryFault', errorCode: '23000' }) }
            : { status: 'fulfilled', value: expect.objectContaining({ written: true }) },
        );
        const account = await gated(REPLAY_SITE, (tx) => repo.findAccountById(tx, userId, { includePending: true }));
        const stored = await gated(SITE_B, (tx) => repo.findGroup(tx, userId));
        expect({ account: account !== null, group: stored !== null }).toEqual({ account: rosterWon, group: !rosterWon });
        if (rosterWon) expect((await abortAccountOperation(accountDeps(), operationId)).outcome).toBe('stepped');
      });

      it('answers each of two overlapping creates of ids closed in tenant-a and tenant-b with the legacy 503 within its own USER_CLOSED_WAIT_MS', async ({ annotate }) => {
        const closed = [await closedId(SITE_A), await closedId(SITE_B)] as const;
        let firstWaits: () => void = () => undefined;
        const waiting = new Promise<void>((resolve) => {
          firstWaits = resolve;
        });
        const timed = async (siteId: string, userId: string, sleep?: (ms: number) => Promise<void>): Promise<{ userId: string; outcome: unknown; elapsedMs: number }> => {
          const from = performance.now();
          const outcome = await createGroup({ ...deps(), sleep }, SUPER, { userId, siteId, isPublic: '0', groupName: `Closed ${userId}` }).catch((err: unknown) => err);
          return { userId, outcome, elapsedMs: performance.now() - from };
        };
        try {
          const first = timed(SITE_A, closed[0].userId, signallingSleep(firstWaits));
          await waiting;
          const second = timed(SITE_B, closed[1].userId);
          const results = await Promise.all([first, second]);
          await annotate(`elapsed ms: ${results.map((result) => Math.round(result.elapsedMs)).join(', ')}`);

          for (const { userId, outcome, elapsedMs } of results) {
            expect(outcome).toBeInstanceOf(OperationBlockedError);
            expect(outcome).toMatchObject({ reason: 'operation-blocked', message: expect.stringContaining(userId) });
            // The polls' own transactions and scheduling add to the sleeps.
            expect(elapsedMs).toBeLessThan(USER_CLOSED_WAIT_MS + 2_500);
          }
          expect(await gated(SITE_A, (tx) => repo.findGroup(tx, closed[0].userId))).toBeNull();
          expect(await gated(SITE_B, (tx) => repo.findGroup(tx, closed[1].userId))).toBeNull();
        } finally {
          for (const { operationId } of closed) expect((await abortAccountOperation(accountDeps(), operationId)).outcome).toBe('stepped');
        }
      }, USER_CLOSED_WAIT_MS * 4);

      it('writes a fresh id of tenant-b while a create of an id closed in tenant-a still waits, which writes once the operation ends', async () => {
        const { userId, operationId } = await closedId(SITE_A);
        let blockedWaits: () => void = () => undefined;
        const waiting = new Promise<void>((resolve) => {
          blockedWaits = resolve;
        });
        let settled = false;
        const blocked = createGroup({ ...deps(), sleep: signallingSleep(blockedWaits) }, SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: `Blocked ${seq}` })
          .catch((err: unknown) => err)
          .finally(() => {
            settled = true;
          });
        await waiting;
        const fresh = next('B');
        try {
          expect(await createGroup(deps(), SUPER, { userId: fresh, siteId: SITE_B, isPublic: '0', groupName: `Fresh ${seq}` })).toMatchObject({ written: true });
          expect(settled).toBe(false);
        } finally {
          expect((await abortAccountOperation(accountDeps(), operationId)).outcome).toBe('stepped');
        }

        expect(await blocked).toMatchObject({ written: true });
        expect(await gated(SITE_B, (tx) => repo.findGroup(tx, fresh))).toMatchObject({ siteid: SITE_B });
        expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toMatchObject({ siteid: SITE_A });
      }, USER_CLOSED_WAIT_MS * 4);
    });

    it.each([
      ['across tenant-a and the umbrella', [SITE_A, SITE_A, UMBRELLA]],
      ['in tenant-a alone', [SITE_A, SITE_A, SITE_A]],
    ] as const)('lists astral and BMP last names in code-point order %s', async (_case, sites) => {
      const groupId = next('B');
      await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: `Unicode ${seq}` });
      for (const [n, lname] of ['\uFA0E', '\u{20000}', '\uFA0F'].entries()) {
        const site = sites[n] ?? SITE_A;
        await addMembers(site, groupId, [await seedUser(site, { lname })]);
      }
      expect((await listGroupMembers(deps(), groupId)).map((row) => row.lname)).toEqual(['\uFA0E', '\uFA0F', '\u{20000}']);
    });

    describe('streaming', () => {
      /** `handle.app` counting each tenant's FETCH statements and the tenant transactions still running. */
      function trackingDb(): { db: TenantDb; fetches: Map<string, number>; running: () => number } {
        const fetches = new Map<string, number>();
        let running = 0;
        const db: TenantDb = {
          ...handle.app,
          withTenant: (tenantId, fn) => {
            running += 1;
            return handle.app
              .withTenant(tenantId, (tx) => {
                const query = ((text: string, values?: unknown[]) => {
                  if (text.startsWith('FETCH')) fetches.set(tenantId, (fetches.get(tenantId) ?? 0) + 1);
                  return tx.query(text, values);
                }) as TenantTx['query'];
                return fn({ ...tx, query });
              })
              .finally(() => {
                running -= 1;
              });
          },
        };
        return { db, fetches, running: () => running };
      }

      /** Backends of the app role idle inside a transaction. */
      async function idleInTransaction(): Promise<number> {
        const { rows } = await handle.adminPool.query<{ idle: number }>(
          "SELECT count(*)::int AS idle FROM pg_stat_activity WHERE usename = $1 AND state LIKE 'idle in transaction%'",
          [handle.roles.app],
        );
        return rows[0]?.idle ?? -1;
      }

      /** A private tenant-a group with members in tenant-a, the umbrella and tenant-b, and their ids in listing order. */
      async function spreadGroup(): Promise<{ groupId: string; ordered: string[] }> {
        const groupId = next('B');
        await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: `Spread ${seq}` });
        const seeds: readonly (readonly [string, string | null])[] = [
          [SITE_A, 'd'],
          [UMBRELLA, 'A'],
          [SITE_B, 'c'],
          [SITE_A, 'b'],
          [UMBRELLA, 'f'],
          [SITE_B, null],
          [SITE_A, 'E'],
          [UMBRELLA, 'g'],
        ];
        const byName = new Map<string | null, string>();
        for (const [site, lname] of seeds) {
          const member = await seedUser(site, lname === null ? {} : { lname });
          await addMembers(site, groupId, [member]);
          byName.set(lname, member);
        }
        const ordered = [null, 'A', 'b', 'c', 'd', 'E', 'f', 'g'].map((lname) => byName.get(lname) ?? '');
        return { groupId, ordered };
      }

      it.each([1, 2])('merges three member tenants holding one page each when the first row is yielded, in pages of %i', async (pageSize) => {
        const { groupId, ordered } = await spreadGroup();
        const tracking = trackingDb();
        const paged = { ...deps(), db: tracking.db, repo: createIdentityRepository({ clock, schema: handle.schema, pageSize }) };
        const streamed: string[] = [];
        let atFirstRow: { fetches: number[]; idle: number } | undefined;
        for await (const member of streamGroupMembers(paged, groupId, { includeS2: true })) {
          atFirstRow ??= { fetches: [...tracking.fetches.values()], idle: await idleInTransaction() };
          streamed.push(member.userid);
        }
        expect(atFirstRow).toEqual({ fetches: [1, 1, 1], idle: 3 });
        expect(streamed).toEqual(ordered);
        expect(streamed).toEqual((await listGroupMembers(deps(), groupId, { includeS2: true })).map((row) => row.userid));
        expect(tracking.running()).toBe(0);
      });

      it('ends every pager transaction when its consumer stops after the first row', async () => {
        const { groupId, ordered } = await spreadGroup();
        const tracking = trackingDb();
        const paged = { ...deps(), db: tracking.db, repo: createIdentityRepository({ clock, schema: handle.schema, pageSize: 1 }) };
        const taken: string[] = [];
        for await (const member of streamGroupMembers(paged, groupId)) {
          taken.push(member.userid);
          expect(tracking.running()).toBe(3);
          break;
        }
        expect(taken).toEqual(ordered.slice(0, 1));
        expect(tracking.running()).toBe(0);
        expect(await idleInTransaction()).toBe(0);
      });

      it.each(['its first page', 'a later page'] as const)('propagates the error of one tenant reading %s and ends every pager transaction', async (failing) => {
        const { groupId } = await spreadGroup();
        const tracking = trackingDb();
        const paged = createIdentityRepository({ clock, schema: handle.schema, pageSize: 1 });
        const boom = new Error('page read failed');
        const umbrella = tenantIdForSite(UMBRELLA);
        const broken: IdentityRepository = {
          ...paged,
          memberPages: async function* (tx, id, opts) {
            for await (const page of paged.memberPages(tx, id, opts)) {
              if (tx.tenantId === umbrella && failing === 'its first page') throw boom;
              yield page;
              if (tx.tenantId === umbrella) throw boom;
            }
          },
        };
        await expect(listGroupMembers({ ...deps(), db: tracking.db, repo: broken }, groupId)).rejects.toBe(boom);
        expect(tracking.running()).toBe(0);
        expect(await idleInTransaction()).toBe(0);
      });

      it.each([
        [0, 1000],
        [0, 3],
        [2, 3],
        [5, 2],
        [7, 5],
        [8, 1],
        [20, 2],
      ])('windows the merged listing of three member tenants at offset %i, limit %i, no tenant cursor reaching past the window end', async (offset, limit) => {
        const { groupId, ordered } = await spreadGroup();
        const statements: Statement[] = [];
        const paged = { ...deps(), db: recordingDb(statements), repo: createIdentityRepository({ clock, schema: handle.schema, pageSize: 1 }) };

        const page = await listGroupMembersPage(paged, NO_PHOTOS, groupId, { includeS2: true, page: { offset, limit } });

        expect(page.members.map((member) => member.userid)).toEqual(ordered.slice(offset, offset + limit));
        expect(page.total).toBe(ordered.length);
        const bounds = statements.filter((s) => s.text.startsWith('DECLARE')).map((s) => s.values?.[2]);
        expect(bounds).toEqual(offset >= ordered.length ? [] : [offset + limit, offset + limit, offset + limit]);
        expect(await idleInTransaction()).toBe(0);
      });

      it('counts and lists S2 members only with includeS2, and resolves each window member as streamListedGroupMembers does', async () => {
        const groupId = next('B');
        await createGroup(deps(), SUPER, { userId: groupId, siteId: SITE_A, isPublic: '0', groupName: `Filtered ${seq}` });
        const plain = await seedUser(SITE_A, { lname: 'a' });
        const superUser = await seedUser(SITE_A, { lname: 'b', s2: 1 });
        const pooled = await seedUser(UMBRELLA, { lname: 'c' });
        await addMembers(SITE_A, groupId, [plain, superUser]);
        await addMembers(UMBRELLA, groupId, [pooled]);
        const window = async (includeS2: boolean, offset: number, limit: number): Promise<[string[], number]> => {
          const { members, total } = await listGroupMembersPage(deps(), NO_PHOTOS, groupId, { includeS2, page: { offset, limit } });
          return [members.map((member) => member.userid), total];
        };

        expect(await window(false, 0, 1000)).toEqual([[plain, pooled], 2]);
        expect(await window(true, 0, 1000)).toEqual([[plain, superUser, pooled], 3]);
        expect(await window(false, 1, 1)).toEqual([[pooled], 2]);
        expect(await window(true, 1, 1)).toEqual([[superUser], 3]);
        const streamed: ListedGroupMember[] = [];
        for await (const batch of streamListedGroupMembers(deps(), NO_PHOTOS, groupId, { includeS2: true })) streamed.push(...batch);
        expect((await listGroupMembersPage(deps(), NO_PHOTOS, groupId, { includeS2: true, page: WHOLE })).members).toEqual(streamed);
      });
    });
  });

  describe('member photos', () => {
    const PHOTO_SITE = 'photo-pool';
    const STORED = id(1, 'F');
    const NULL_EXT = id(2, 'F');
    const UNSTORED = id(3, 'F');

    beforeAll(async () => {
      await registerSite(PHOTO_SITE, PHOTO_SITE, PHOTO_SITE);
    });

    /** identity's content client over a strategies-content double that records each lookup's ids and answers from `stored`. */
    function photoContent(stored: ReadonlyMap<string, string | null>): { content: ContentClient; lookups: string[][] } {
      const lookups: string[][] = [];
      const client: ServiceClient = {
        request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
          const { fileIds } = req.json as { fileIds: string[] };
          lookups.push(fileIds);
          const items = fileIds.flatMap((fileId) => (stored.has(fileId) ? [{ fileId, fileExt: stored.get(fileId) ?? null }] : []));
          return Promise.resolve({ status: 200, headers: {}, body: { items } as T });
        },
        close: () => Promise.resolve(),
      };
      return { content: createContentClient(client), lookups };
    }

    /** A private group of PHOTO_SITE whose members' contacts carry `photos` in last-name order; null seeds no contact. */
    async function photoGroup(photos: readonly (string | null)[]): Promise<string> {
      const groupId = next('B');
      await createGroup(deps(), SUPER, { userId: groupId, siteId: PHOTO_SITE, isPublic: '0', groupName: `Photos ${seq}` });
      await gated(PHOTO_SITE, async (tx) => {
        for (const [n, photo] of photos.entries()) {
          const userId = next('A');
          await repo.insertAccount(tx, { userid: userId, username: `p${seq}`, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: PHOTO_SITE, remoteid: '', tablist: '' });
          if (photo !== null) {
            const lname = `m${String(n).padStart(4, '0')}`;
            await repo.upsertPersonContact(tx, { user_id: userId, site_id: PHOTO_SITE, email: null, fname: null, lname, company: null, subtype: null, aggregate_version: 1, photofileid: photo });
          }
          await repo.addMembership(tx, userId, groupId);
        }
      });
      return groupId;
    }

    it('resolves a batch in order with one lookup of its distinct photo ids; null without a photo id, a stored file or its fileEXT', async () => {
      const groupId = await photoGroup([null, STORED, STORED, NULL_EXT, UNSTORED, '']);
      const listed = await listGroupMembers(deps(), groupId);
      const { content, lookups } = photoContent(new Map([[STORED, 'jpg'], [NULL_EXT, null]]));

      const resolved = await resolveMemberPhotos(content, listed);

      expect(resolved).toEqual(listed.map((member, n) => ({ ...member, photofileext: [null, 'jpg', 'jpg', null, null, null][n] })));
      expect(resolved.map((member) => member.photofileid)).toEqual([null, STORED, STORED, NULL_EXT, UNSTORED, ' '.repeat(35)]);
      expect(lookups).toEqual([[STORED, NULL_EXT, UNSTORED]]);
    });

    it('makes no lookup for members without photos, and refuses a batch over MEMBER_BATCH_SIZE before any lookup', async () => {
      const listed = await listGroupMembers(deps(), await photoGroup([null, '']));
      const { content, lookups } = photoContent(new Map());

      expect((await resolveMemberPhotos(content, listed)).map((member) => member.photofileext)).toEqual([null, null]);
      await expect(resolveMemberPhotos(content, Array.from({ length: MEMBER_BATCH_SIZE + 1 }, () => listed[0] as GroupMemberRow))).rejects.toBeInstanceOf(RangeError);
      expect(lookups).toEqual([]);
    });

    it('streams a group one MEMBER_BATCH_SIZE batch at a time in listing order, each with one lookup', async () => {
      const photos = Array.from({ length: MEMBER_BATCH_SIZE + 1 }, (_, n) => id(100 + n, 'F'));
      const groupId = await photoGroup(photos);
      const { content, lookups } = photoContent(new Map(photos.map((photo, n) => [photo, n % 2 === 0 ? 'png' : null])));

      const batches: ListedGroupMember[][] = [];
      for await (const batch of streamListedGroupMembers(deps(), content, groupId)) batches.push(batch);

      expect(batches.map((batch) => batch.length)).toEqual([MEMBER_BATCH_SIZE, 1]);
      expect(lookups).toEqual([photos.slice(0, MEMBER_BATCH_SIZE), photos.slice(MEMBER_BATCH_SIZE)]);
      expect(batches.flat().map((member) => member.userid)).toEqual((await listGroupMembers(deps(), groupId)).map((member) => member.userid));
      expect(batches.flat().map((member) => member.photofileext)).toEqual(photos.map((_, n) => (n % 2 === 0 ? 'png' : null)));
    });

    it.each([
      ['a window of 1000 in one MEMBER_BATCH_SIZE lookup and one of the rest', { offset: 0, limit: 1000 }, [[0, MEMBER_BATCH_SIZE], [MEMBER_BATCH_SIZE, MEMBER_BATCH_SIZE + 1]]],
      ['a window of two in one lookup of its own photos', { offset: 1, limit: 2 }, [[1, 3]]],
    ] as const)('resolves the photos of %s only', async (_case, page, batches) => {
      const photos = Array.from({ length: MEMBER_BATCH_SIZE + 1 }, (_, n) => id(2000 + n, 'F'));
      const groupId = await photoGroup(photos);
      const { content, lookups } = photoContent(new Map(photos.map((photo, n) => [photo, n % 2 === 0 ? 'png' : null])));

      const listed = await listGroupMembersPage(deps(), content, groupId, { page });

      expect(lookups).toEqual(batches.map(([from, to]) => photos.slice(from, to)));
      expect(listed.total).toBe(photos.length);
      expect(listed.members.map((member) => member.photofileid)).toEqual(photos.slice(page.offset, page.offset + page.limit));
      expect(listed.members.map((member) => member.photofileext)).toEqual(listed.members.map((_, n) => ((page.offset + n) % 2 === 0 ? 'png' : null)));
    });
  });
});
