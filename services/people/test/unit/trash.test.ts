/** Masa trashManager throwIn of a deleted address and takeOut of a restored object, over the recording database. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import {
  PEOPLE_TRASH_ENABLED,
  TAKEOUT_UNBUILT,
  TrashRequestCounter,
  takeOut,
  throwInAddress,
  type ThrowInContext,
  type TrashActor,
  type TrashedAddress,
} from '../../src/domain/trash.js';
import { addressTrashValues, cfml2wddx, type AddressRow as LegacyAddressRow } from '../../src/legacy/wddx.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import type { TrashRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createRecordingDb, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import { addressRow } from '../helpers/fixtures.js';

const repo = createPeopleRepository({ clock: TEST_CLOCK });

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const DELETE_ID = '6A1D3E2F-4B5C-6D7E-8F90A1B2C3D4E5F6';
const INSTANCE_ID = 'C0FFEE00-1111-2222-3333444455556666';
const OBJECT_ID = '0B1EC7ED-0000-4000-8000000000000001';
const ACTOR: TrashActor = { fullName: 'Ada Lovelace' };

const TRASH_EXISTS = /^SELECT objectid FROM "people"\."trash" /;
const TRASH_INSERT = /^INSERT INTO "people"\."trash" /;
const TRASH_DELETE = /^DELETE FROM "people"\."trash" /;
const TRANSACTION_FRAME = /^(?:BEGIN|COMMIT|ROLLBACK)\b|^SELECT set_config\('app\.tenant_id'/;

/** The row an INSERT binds, by its column list; answers `RETURNING *` as PostgreSQL would. */
function insertedRow(text: string, values: readonly unknown[]): Record<string, unknown> {
  const columns = /\(([^)]*)\) VALUES/.exec(text)?.[1]?.split(',') ?? [];
  return Object.fromEntries(columns.map((column, i) => [column.trim().replace(/"/g, ''), values[i]]));
}

/** A recording database whose trash inserts return the row they bind. */
function trashDb(): RecordingDb {
  const db = createRecordingDb();
  db.respond(TRASH_INSERT, (text, values) => [insertedRow(text, values)]);
  return db;
}

/** Trash rows the recorded inserts bound, in statement order. */
function insertedTrash(db: RecordingDb): Record<string, unknown>[] {
  return db
    .writes()
    .filter((statement) => TRASH_INSERT.test(statement.text))
    .map((statement) => insertedRow(statement.text, statement.values));
}

/** Statements beyond the BEGIN, tenant setting and COMMIT that withTenant issues. */
function ownStatements(db: RecordingDb): RecordedStatement[] {
  return db.statements().filter((statement) => !TRANSACTION_FRAME.test(statement.text));
}

function inTenantA<T>(db: RecordingDb, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(db, TENANT_A.tenantId, fn);
}

/** A stored tenant-a address as userDAO.readAddress loads it. */
function trashedAddress(overrides: Partial<TrashedAddress> = {}): TrashedAddress {
  const { tenant_id: _tenantId, ...stored } = addressRow({ addressname: 'Summer House', phone: '555-0101' });
  return { ...stored, ...overrides };
}

function context(overrides: Partial<ThrowInContext> = {}): ThrowInContext {
  return {
    actor: ACTOR,
    clock: TEST_CLOCK,
    counter: new TrashRequestCounter(),
    write: {},
    extend: { entries: [], extendSetId: '' },
    ...overrides,
  };
}

/** The stored address in the legacy column names the WDDX struct is built from. */
function legacyRow(address: TrashedAddress): LegacyAddressRow {
  return {
    addressID: address.addressid,
    userID: address.userid,
    siteID: address.siteid,
    addressName: address.addressname,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    phone: address.phone,
    fax: address.fax,
    isPrimary: address.isprimary,
    addressNotes: address.addressnotes,
    addressURL: address.addressurl,
    longitude: address.longitude,
    latitude: address.latitude,
    addressEmail: address.addressemail,
    hours: address.hours,
  };
}

/** A stored people.trash row of `objectId`. */
function storedTrash(objectId: string): TrashRow {
  return {
    tenant_id: TENANT_A.tenantId,
    objectid: objectId,
    parentid: 'D15EA5E0-0000-4000-8000000000000002',
    siteid: TENANT_A.siteId,
    objectlabel: 'Summer House',
    objectclass: 'address',
    objecttype: 'Address',
    objectsubtype: 'Default',
    objectstring: "<wddxPacket version='1.0'><header/><data><struct></struct></data></wddxPacket>",
    deleteddate: TEST_CLOCK.now(),
    deletedby: ACTOR.fullName,
    deleteid: DELETE_ID,
    orderno: 1,
  };
}

describe.runIf(PEOPLE_TRASH_ENABLED)('throwInAddress', () => {
  it('inserts one address-class trash row numbered by the request counter', async () => {
    const db = trashDb();
    const counter = new TrashRequestCounter();
    const address = trashedAddress();

    const returned = await inTenantA(db, (tx) => throwInAddress(repo, tx, address, context({ counter })));

    const inserted = insertedTrash(db);
    expect(inserted).toHaveLength(1);
    const [row] = inserted;
    expect(row).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      objectid: address.addressid,
      parentid: address.userid,
      siteid: TENANT_A.siteId,
      objectclass: 'address',
      objecttype: 'Address',
      objectsubtype: 'Default',
      objectlabel: 'Summer House',
      deleteddate: TEST_CLOCK.now(),
      deletedby: ACTOR.fullName,
      orderno: 1,
    });
    expect(row?.objectclass).not.toBe('group');
    expect(row?.deleteid).toMatch(CF_UUID);
    expect(counter.next(String(row?.deleteid))).toBe(2);
    expect(returned).toEqual(row);
  });

  it('stores the cfml2wddx packet of the address values as objectString', async () => {
    const db = trashDb();
    const extend: ThrowInContext['extend'] = { entries: [['favoriteColor', 'Blue']], extendSetId: 'EXTEND-SET-1' };
    const address = trashedAddress({ muradeleteid: DELETE_ID, instanceid: INSTANCE_ID });

    await inTenantA(db, (tx) => throwInAddress(repo, tx, address, context({ extend })));

    const expected = cfml2wddx(
      addressTrashValues({
        address: legacyRow(address),
        extendedData: { extendSetId: extend.extendSetId, data: extend.entries },
        deleteDateTime: TEST_CLOCK.now(),
        deleteId: DELETE_ID,
        instanceId: INSTANCE_ID,
      }),
    );
    expect(insertedTrash(db).map((row) => row.objectstring)).toEqual([expected]);
  });

  it('keeps the first 50 characters of the actor full name as deletedBy', async () => {
    const db = trashDb();
    const fullName = '0123456789'.repeat(6);
    expect(fullName).toHaveLength(60);

    await inTenantA(db, (tx) => throwInAddress(repo, tx, trashedAddress(), context({ actor: { fullName } })));

    expect(insertedTrash(db).map((row) => row.deletedby)).toEqual(['0123456789'.repeat(5)]);
  });

  it('inserts nothing when a trash row exists for the address id, though the throw-in is counted', async () => {
    const db = trashDb();
    const counter = new TrashRequestCounter();
    const address = trashedAddress({ muradeleteid: DELETE_ID });
    db.respond(TRASH_EXISTS, [{ objectid: address.addressid }]);

    const returned = await inTenantA(db, (tx) => throwInAddress(repo, tx, address, context({ counter })));

    expect(returned).toBeNull();
    expect(db.statements().filter((statement) => TRASH_EXISTS.test(statement.text)).map((statement) => statement.values)).toEqual([
      [TENANT_A.tenantId, address.addressid],
    ]);
    expect(db.writes()).toEqual([]);
    expect(counter.next(DELETE_ID)).toBe(2);
  });

  it('gives throw-ins of one request that share a delete id the same deleteID and increasing orderno', async () => {
    const db = trashDb();
    const ctx = context();
    const first = trashedAddress({ muradeleteid: DELETE_ID });
    const second = trashedAddress({ muradeleteid: DELETE_ID, addressname: 'Office' });
    const other = trashedAddress();

    await inTenantA(db, async (tx) => {
      await throwInAddress(repo, tx, first, ctx);
      await throwInAddress(repo, tx, second, ctx);
      await throwInAddress(repo, tx, other, ctx);
    });

    const rows = insertedTrash(db);
    expect(rows.map((row) => [row.objectid, row.deleteid, row.orderno])).toEqual([
      [first.addressid, DELETE_ID, 1],
      [second.addressid, DELETE_ID, 2],
      [other.addressid, expect.stringMatching(CF_UUID), 1],
    ]);
    expect(rows[2]?.deleteid).not.toBe(DELETE_ID);
    expect(rows.map((row) => row.objectclass)).toEqual(['address', 'address', 'address']);
  });
});

describe.runIf(PEOPLE_TRASH_ENABLED)('takeOut', () => {
  it.each([
    ['a stored trash row', [storedTrash(OBJECT_ID)], true],
    ['no trash row', [], false],
  ] as const)('deletes the trash row of the object id when the values hold frommuratrash, with %s', async (_label, stored, deleted) => {
    const db = createRecordingDb();
    db.respond(TRASH_DELETE, stored);

    const outcome = await inTenantA(db, (tx) => takeOut(repo, tx, OBJECT_ID, new Map([['frommuratrash', 'true']]), { write: {} }));

    expect(outcome).toBe(deleted);
    expect(db.writes().filter((statement) => TRASH_DELETE.test(statement.text))).toEqual([
      { text: expect.stringMatching(/WHERE "tenant_id" = \$1 AND "objectid" = \$2 RETURNING \*$/), values: [TENANT_A.tenantId, OBJECT_ID] },
    ]);
  });

  it('issues no statement when the values lack frommuratrash', async () => {
    const db = createRecordingDb();

    const outcome = await inTenantA(db, (tx) => takeOut(repo, tx, OBJECT_ID, new Map([['userid', OBJECT_ID]]), { write: {} }));

    expect(outcome).toBe(false);
    expect(ownStatements(db)).toEqual([]);
  });

  it('names the file-restore and child-restore parts it leaves unbuilt in a readonly list', () => {
    expectTypeOf(TAKEOUT_UNBUILT).toExtend<readonly string[]>();
    expectTypeOf(TAKEOUT_UNBUILT).not.toExtend<string[]>();
    expect(TAKEOUT_UNBUILT.length).toBeGreaterThan(0);
    expect(TAKEOUT_UNBUILT).toEqual(expect.arrayContaining([expect.stringContaining('restoreVersion'), expect.stringContaining('child')]));
  });
});

describe.skipIf(PEOPLE_TRASH_ENABLED)('trash writes while people does not hold people.trash', () => {
  it('throwInAddress and takeOut record no statement', async () => {
    const db = trashDb();

    const [thrown, restored] = await inTenantA(db, async (tx) => [
      await throwInAddress(repo, tx, trashedAddress(), context()),
      await takeOut(repo, tx, OBJECT_ID, new Map([['frommuratrash', 'true']]), { write: {} }),
    ]);

    expect(thrown).toBeNull();
    expect(restored).toBe(false);
    expect(ownStatements(db)).toEqual([]);
  });
});
