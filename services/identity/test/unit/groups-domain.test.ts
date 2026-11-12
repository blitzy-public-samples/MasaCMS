/** Group CRUD and memberships against a throwaway `identity` schema: pools, legacy defaults and validation, create, update, delete with its trash packet, membership changes and reads. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
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
  updateGroup,
  type GroupActor,
  type GroupDeps,
} from '../../src/domain/groups.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import { verifyLegacyPassword } from '../../src/legacy/hash.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
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
});
