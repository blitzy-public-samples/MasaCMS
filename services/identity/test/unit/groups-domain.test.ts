/** Group CRUD and memberships against a throwaway `identity` schema: pools, legacy defaults and validation, create, update, delete with its trash packet, membership changes and reads. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { OperationBlockedError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import { currentTransaction, tenantIdForSite, withMetadata, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { cfHash } from '@opt2/platform/legacy-compat';
import { createCapturingPublisher, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  GroupPhotoWithheldError,
  GroupSaveHaltedError,
  addToGroup,
  createGroup,
  deleteGroup,
  findGroupForSite,
  groupSaveInputFrom,
  listGroupMembers,
  listGroups,
  newGroupRecord,
  removeFromGroup,
  resolveGroupSite,
  streamGroupMembers,
  updateGroup,
  type GroupActor,
  type GroupDeps,
} from '../../src/domain/groups.js';
import {
  USER_CLOSED_WAIT_MS,
  abortAccountOperation,
  commitAccountOperation,
  finishAccountOperation,
  prepareAccountOperation,
  type AccountOperationDeps,
} from '../../src/domain/account-operations.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import { verifyLegacyPassword } from '../../src/legacy/hash.js';
import { READ_PAGE_SIZE, createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { GROUP_TRASH, IDENTITY_UNITS, type GroupAddressRow, type GroupTrashRow } from '../../src/repo/tables.js';

/** The ttrash.objectString ACF 2023 stored for a group deleted through userManager.delete, as test/unit/wddx.test.ts records it. */
const CAPTURED_GROUP_TRASH_PACKET =
  "<wddxPacket version='1.0'><header/><data><struct>" +
  "<var name='ERRORS'><struct></struct></var>" +
  "<var name='MOBILEPHONE'><string></string></var>" +
  "<var name='LNAME'><string></string></var>" +
  "<var name='EMAIL'><string></string></var>" +
  "<var name='CONTACTFORM'><string></string></var>" +
  "<var name='LASTUPDATE'><dateTime>2026-11-11T09:41:05+00:00</dateTime></var>" +
  "<var name='EXTENDDATATABLE'><string>tclassextenddatauseractivity</string></var>" +
  "<var name='KEEPPRIVATE'><string>0</string></var>" +
  "<var name='USERID'><string>E3D2FAB9-D68C-2076-91E72671EDD2447F</string></var>" +
  "<var name='USERNAME'><string></string></var>" +
  "<var name='PASSEDPROTECT'><boolean value='true'/></var>" +
  "<var name='muraDeleteID'><string>E3D305BB-A90C-EC0F-183D2FF53867FACD</string></var>" +
  "<var name='type'><string>1</string></var>" +
  "<var name='LASTUPDATEBYID'><string>E3D2FAB9-D68C-2076-91E72671EDD2447F</string></var>" +
  "<var name='SUBTYPE'><string>Default</string></var>" +
  "<var name='CATEGORYID'><string></string></var>" +
  "<var name='REMOVEOBJECTS'><array length='0'></array></var>" +
  "<var name='FNAME'><string></string></var>" +
  "<var name='COMPANY'><string></string></var>" +
  "<var name='TABLIST'><string></string></var>" +
  "<var name='NEWFILE'><string></string></var>" +
  "<var name='PASSWORD'><string></string></var>" +
  "<var name='FROMMURACACHE'><boolean value='false'/></var>" +
  "<var name='ISPUBLIC'><string>0</string></var>" +
  "<var name='ADDRESSES'><recordset rowCount='0' fieldNames='addressid,userid,siteid,address1,address2,city,state,zip,country," +
  "isPrimary,addressName,addressNotes,phone,fax,addressURL,longitude,latitude,addressEmail,hours' type='coldfusion.sql.QueryTable'>" +
  "<field name='addressid'></field><field name='userid'></field><field name='siteid'></field>" +
  "<field name='address1'></field><field name='address2'></field><field name='city'></field>" +
  "<field name='state'></field><field name='zip'></field><field name='country'></field>" +
  "<field name='isPrimary'></field><field name='addressName'></field><field name='addressNotes'></field>" +
  "<field name='phone'></field><field name='fax'></field><field name='addressURL'></field>" +
  "<field name='longitude'></field><field name='latitude'></field><field name='addressEmail'></field>" +
  "<field name='hours'></field></recordset></var>" +
  "<var name='IMSERVICE'><string></string></var>" +
  "<var name='ISNEW'><string>0</string></var>" +
  "<var name='JOBTITLE'><string></string></var>" +
  "<var name='WEBSITE'><string></string></var>" +
  "<var name='LASTLOGIN'><string></string></var>" +
  "<var name='TAGS'><string></string></var>" +
  "<var name='S2'><string>0</string></var>" +
  "<var name='EXTENDAUTOCOMPLETE'><boolean value='true'/></var>" +
  "<var name='muraDeleteDateTime'><string>{ts '2026-11-11 09:41:05'}</string></var>" +
  "<var name='ADDOBJECTS'><array length='0'></array></var>" +
  "<var name='NOTES'><string>n\u00f6te<char code='0d'/><char code='0a'/>zwei<char code='09'/>end</string></var>" +
  "<var name='CREATED'><dateTime>2026-11-11T09:41:05+00:00</dateTime></var>" +
  "<var name='GROUPNAME'><string>Caf\u00e9 \u20ac &amp; &lt;Eds&gt;</string></var>" +
  "<var name='PERM'><string>0</string></var>" +
  "<var name='DESCRIPTION'><string></string></var>" +
  "<var name='HKEY'><string></string></var>" +
  "<var name='ADDRESSID'><string></string></var>" +
  "<var name='IMNAME'><string></string></var>" +
  "<var name='INSTANCEID'><string>E3D304F0-FEAB-2DB8-7292E9867F0B7556</string></var>" +
  "<var name='PASSWORDCREATED'><dateTime>2026-11-11T09:41:05+00:00</dateTime></var>" +
  "<var name='PHOTOFILEID'><string></string></var>" +
  "<var name='INTERESTS'><string></string></var>" +
  "<var name='SOURCEITERATOR'><string></string></var>" +
  "<var name='EXTENDSETID'><string></string></var>" +
  "<var name='SITEID'><string>default</string></var>" +
  "<var name='PRIMARYADDRESSID'><string></string></var>" +
  "<var name='SUBSCRIBE'><string>1</string></var>" +
  "<var name='UKEY'><string></string></var>" +
  "<var name='REMOTEID'><string></string></var>" +
  "<var name='GROUPID'><string></string></var>" +
  "<var name='INACTIVE'><string>0</string></var>" +
  "<var name='PHOTOFILEEXT'><string></string></var>" +
  "<var name='LASTUPDATEBY'><string></string></var>" +
  "<var name='EXTENDDATA'><string></string></var>" +
  "</struct></data></wddxPacket>";

const TRASHED_AT = new Date('2026-11-11T09:41:05.000Z');
const SITE_A = 'tenant-a';
const UMBRELLA = 'umbrella';
const SITE_B = 'tenant-b';
const DEFAULT = 'default';
const SUPER: GroupActor = { userId: 'ADDE0000-0000-0000-0000000000000001', fname: 'Admin', lname: 'User', isSuperUser: true };
const EDITOR: GroupActor = { userId: 'EDD10000-0000-0000-0000000000000001', fname: 'Ed', lname: 'Itor', isSuperUser: false };

function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
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

  let previousZone: string | undefined;

  beforeAll(async () => {
    // The captured packet's dateTime offsets are UTC's.
    previousZone = process.env.TZ;
    process.env.TZ = 'UTC';
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: capture, logger, clock, payloadValidators: identityPayloadValidators });
    await registerSite(SITE_A, SITE_A, UMBRELLA);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA);
    await registerSite(SITE_B, SITE_B, SITE_B);
    await registerSite(DEFAULT, DEFAULT, DEFAULT);
  });
  afterAll(async () => {
    await handle?.drop();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
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

  it('deletes the group, its tags, extended data and tokens, keeps memberships and addresses, trashes it once and publishes deleted', async () => {
    const userId = next('B');
    await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Doomed', tags: 't1' });
    const member = await seedUser(SITE_A);
    expect(await addToGroup(deps(), { userId: member, groupId: userId })).toBe(true);
    await gated(SITE_A, async (tx) => {
      await repo.replaceGroupExtendData(tx, { groupId: userId, rows: [{ attributeId: 7, values: { siteid: SITE_A, attributevalue: 'v', remoteid: null, datetimevalue: null, numericvalue: null, stringvalue: 'v' } }] });
      await repo.insertToken(tx, { granttype: 'client_credentials', userid: userId, clientid: 'C1', accesscode: null, data: null, expires: now, token: next('D') });
    });
    expect(await deleteGroup(deps(), SUPER, { groupId: userId, siteId: SITE_A })).toBe(true);
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).toBeNull();
    expect(await gated(SITE_A, (tx) => repo.membershipGroupIds(tx, member))).toEqual([userId]);
    const counts = await withTenant(handle.app, tenantIdForSite(SITE_A), async (tx) => {
      const q = async (table: string, column: string): Promise<number> => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.${table} WHERE ${column} = $1`, [userId])).rows[0]?.n);
      return { tags: await q('user_tag', 'userid'), extend: await q('extend_data_user_activity', 'baseid'), tokens: await q('oauth_token', 'userid'), addresses: await q('user_address', 'userid') };
    });
    expect(counts).toEqual({ tags: 0, extend: 0, tokens: 0, addresses: 1 });
    const trash = await gated(SITE_A, (tx) => repo.findByKey<GroupTrashRow>(tx, GROUP_TRASH.table, { objectid: userId }));
    expect(trash?.parentid.trimEnd()).toBe('NA');
    expect(trash).toMatchObject({ siteid: SITE_A, objectlabel: 'Doomed', objectclass: 'user', objecttype: 'Group', objectsubtype: 'Default', deletedby: 'Admin User', orderno: 1 });
    expect(trash?.objectstring).toContain("<var name='GROUPNAME'><string>Doomed</string></var>");
    expect(trash?.objectstring).toContain("<var name='TAGS'><string>t1</string></var>");
    const events = (await outbox(SITE_A)).filter((e) => e.payload.groupId === userId);
    expect(events.at(-1)).toMatchObject({ topic: 'identity.group.changed.v1', version: '2', payload: { deleted: true } });
    expect(await deleteGroup(deps(), SUPER, { groupId: userId, siteId: SITE_A })).toBe(false);
  });

  it('reproduces the captured ACF trash packet byte for byte', async () => {
    const userId = 'E3D2FAB9-D68C-2076-91E72671EDD2447F';
    await gated(DEFAULT, (tx) => repo.insertGroup(tx, {
      userid: userId, groupname: 'Caf\u00e9 \u20ac & <Eds>', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '',
      mobilephone: '', website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: DEFAULT,
      subscribe: 1, notes: 'n\u00f6te\r\nzwei\tend', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '',
    }, null));
    expect(await deleteGroup(deps(), SUPER, { groupId: userId, siteId: DEFAULT })).toBe(true);
    const trash = await gated(DEFAULT, (tx) => repo.findByKey<GroupTrashRow>(tx, GROUP_TRASH.table, { objectid: userId }));
    const packet = (trash?.objectstring ?? '')
      .replace(/(<var name='muraDeleteID'><string>)[^<]*/, '$1E3D305BB-A90C-EC0F-183D2FF53867FACD')
      .replace(/(<var name='INSTANCEID'><string>)[^<]*/, '$1E3D304F0-FEAB-2DB8-7292E9867F0B7556');
    expect(packet).toBe(CAPTURED_GROUP_TRASH_PACKET);
    expect(trash?.deleteddate).toEqual(TRASHED_AT);
  });

  it('refuses to delete a group with a stored photo and writes nothing', async () => {
    const userId = next('B');
    await createGroup(deps(), SUPER, { userId, siteId: SITE_A, isPublic: '0', groupName: 'Photo', photoFileID: 'F1' });
    const before = (await outbox(SITE_A)).length;
    await expect(deleteGroup(deps(), SUPER, { groupId: userId, siteId: SITE_A })).rejects.toBeInstanceOf(GroupPhotoWithheldError);
    expect(await gated(SITE_A, (tx) => repo.findGroup(tx, userId))).not.toBeNull();
    expect(await gated(SITE_A, (tx) => repo.findByKey(tx, GROUP_TRASH.table, { objectid: userId }))).toBeNull();
    expect((await outbox(SITE_A)).length).toBe(before);
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
  });

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

  describe('collection reads', () => {
    const CLOSED_SITE = 'closed-pool';
    const PAGE_SITE = 'page-pool';
    const COUNT_SITE = 'count-pool';
    const REPLAY_SITE = 'replay-pool';
    type Statement = { tenantId: string; text: string };

    beforeAll(async () => {
      for (const site of [CLOSED_SITE, PAGE_SITE, COUNT_SITE, REPLAY_SITE]) await registerSite(site, site, site);
    });

    /** `handle.app` whose tenant transactions record each statement with its tenant. */
    function recordingDb(statements: Statement[]): TenantDb {
      return {
        ...handle.app,
        withTenant: (tenantId, fn) =>
          handle.app.withTenant(tenantId, (tx) => {
            const query = ((text: string, values?: unknown[]) => {
              statements.push({ tenantId, text });
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
    };

    it.each([
      ['listGroupMembers', 'prepared', 'aborted'],
      ['listGroupMembers', 'committed', 'finished'],
      ['listGroups', 'prepared', 'aborted'],
      ['listGroups', 'committed', 'finished'],
    ] as const)('%s waits outside its transaction while a %s account operation keeps a member closed, then reads once it is %s', async (read, state, end) => {
      const { groupId, member } = await closedGroup();
      const operationId = await openOperation(CLOSED_SITE, member, state);
      const { sleep, slept, inTransaction } = sleeper(() => settleOperation(CLOSED_SITE, operationId, state, end));
      expect(await reads[read]({ ...deps(), sleep }, groupId)).toBe(1);
      expect(slept).toEqual([100]);
      expect(inTransaction).toEqual([false]);
    });

    it.each(['listGroupMembers', 'listGroups'] as const)('%s answers the legacy 503 naming the closed member once its sleeps total USER_CLOSED_WAIT_MS', async (read) => {
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
    });

    it.each(['listGroupMembers', 'listGroups'] as const)('%s waits while a prepared create holds a membership of its pending account, then neither lists nor counts it', async (read) => {
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
      expect(Object.keys(listed[0] ?? {})).toEqual(['userid', 'type', 'username', 'siteid', 'ispublic', 's2', 'inactive', 'fname', 'lname', 'email', 'company']);
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
      });
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
    });
  });
});
