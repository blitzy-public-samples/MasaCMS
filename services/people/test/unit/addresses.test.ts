/** The address saves' statements over a recording `people` database, and the stored address order over PostgreSQL. */
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { OperationBlockedError } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  ADDRESS_DEFAULTS,
  applyAddressInput,
  createAddress,
  insertAddressInTx,
  listAddresses,
  saveAddress,
  setPrimaryAddress,
  updateAddress,
  type AddressActor,
  type AddressDeps,
} from '../../src/domain/addresses.js';
import { fencePersons, withPersonsOpen } from '../../src/domain/roster-protocol.js';
import { PEOPLE_TRASH_ENABLED } from '../../src/domain/trash.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import type { AddressRow, PersonRow, TrashRow } from '../../src/repo/tables.js';
import { PG_AVAILABLE, TEST_CLOCK, createRecordingDb, withPgApp, type RecordingDb, type StatementMatcher } from '../helpers/app.js';
import { addressRow, personRow, seedPeople } from '../helpers/fixtures.js';

const A = TENANT_A.tenantId;
const ACTOR: AddressActor = { tid: A, write: { actorUserId: 'ACTOR', requestId: 'REQ-1' } };
const ADDRESS_TABLE = '"people"."user_address"';
const CHANGELOG_TABLE = '"people"."changelog"';
const TRASH_TABLE = '"people"."trash"';
const WRITE_TARGET = /^(?:INSERT INTO|UPDATE|DELETE FROM) ("\w+"\."\w+")/;
const QUALIFIED_NAME = /"(\w+)"\."\w+"/g;
const OPEN_OPERATION_READ = /^SELECT \* FROM "people"\."roster_operation" /;
const PERSON_READ = /^SELECT \* FROM "people"\."person" WHERE/;
const ADDRESS_READ = /^SELECT .+ FROM "people"\."user_address" WHERE/;
const ADDRESS_LOCKED_READ = /^SELECT \* FROM "people"\."user_address" WHERE tenant_id = \$1 AND addressid COLLATE \S+ = \$2::bpchar FOR UPDATE$/;
const ADDRESS_PLAIN_READ = /^SELECT \* FROM "people"\."user_address" WHERE tenant_id = \$1 AND addressid COLLATE \S+ = \$2::bpchar$/;
const instant = (): Promise<void> => Promise.resolve();

type Save = typeof createAddress;
type Row = Record<string, unknown>;

/** A request's posted parameters, keyed lower-case as the routes normalise them. */
function posted(params: Row): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(params).map(([key, value]) => [key.toLowerCase(), value] as const));
}

/** The row an `INSERT … (columns) VALUES ($n, …)` statement assigns. */
function insertedRow(text: string, values: readonly unknown[]): Row {
  const [, columns = '', params = ''] = /\(([^)]*)\) VALUES \(([^)]*)\)/.exec(text) ?? [];
  const indexes = params.split(',').map((param) => Number(param.trim().slice(1)) - 1);
  return Object.fromEntries(columns.split(',').map((column, i) => [column.trim().replace(/"/g, ''), values[indexes[i] ?? -1]]));
}

/** The `"column" = $n` assignments of an UPDATE's SET list. */
function assignments(text: string, values: readonly unknown[]): Row {
  const set = /\bSET (.+) WHERE /.exec(text)?.[1] ?? '';
  return Object.fromEntries([...set.matchAll(/"(\w+)" = \$(\d+)/g)].map(([, column = '', n = '']) => [column, values[Number(n) - 1]]));
}

/** The parameter value an UPDATE's WHERE clause binds to `column`. */
function keyOf(text: string, values: readonly unknown[], column: string): unknown {
  const where = /\bWHERE (.+)$/.exec(text)?.[1] ?? '';
  const n = new RegExp(`"${column}" = \\$(\\d+)`).exec(where)?.[1];
  return n === undefined ? undefined : values[Number(n) - 1];
}

function byAddressId(a: AddressRow, b: AddressRow): number {
  return a.addressid < b.addressid ? -1 : a.addressid > b.addressid ? 1 : 0;
}

/** A trash row of address `objectId`, as `DELETE … RETURNING *` answers it. */
function trashRow(objectId: string, parentId: string): TrashRow {
  return {
    tenant_id: A,
    objectid: objectId,
    parentid: parentId,
    siteid: TENANT_A.siteId,
    objectlabel: 'Home',
    objectclass: 'address',
    objecttype: 'Address',
    objectsubtype: 'Default',
    objectstring: '',
    deleteddate: TEST_CLOCK.now(),
    deletedby: 'Ada Admin',
    deleteid: 'DELETE-1',
    orderno: 1,
  };
}

interface Recording {
  db: RecordingDb;
  /** The `user_address` rows the recording database answers from, by addressid; writes change them. */
  store: Map<string, AddressRow>;
  deps: AddressDeps;
}

/**
 * A recording database holding `owner` as the tenant's person and `addresses` as its `user_address` table, plus any
 * `extra` responders; the saves fence through the roster protocol, whose waits return at once.
 */
function recording(
  owner: PersonRow,
  addresses: readonly AddressRow[] = [],
  extra: ReadonlyArray<readonly [StatementMatcher, Row[]]> = [],
): Recording {
  const store = new Map(addresses.map((row) => [row.addressid, { ...row }]));
  const db = createRecordingDb({
    responses: [
      [PERSON_READ, [owner]],
      [
        ADDRESS_READ,
        (text, values) => {
          if (text.includes('isprimary IS DISTINCT FROM 0')) {
            const others = [...store.values()].filter((row) => row.userid === values[1] && row.addressid !== values[2]);
            return others.filter((row) => row.isprimary !== 0).sort(byAddressId);
          }
          const row = store.get(String(values[1]));
          return row === undefined ? [] : [{ ...row }];
        },
      ],
      [
        /^INSERT INTO "people"\."user_address" /,
        (text, values) => {
          const row = insertedRow(text, values) as AddressRow;
          store.set(row.addressid, row);
          return [{ ...row }];
        },
      ],
      [
        /^UPDATE "people"\."user_address" /,
        (text, values) => {
          const row = store.get(String(keyOf(text, values, 'addressid')));
          if (row === undefined) return [];
          Object.assign(row, assignments(text, values));
          return [{ ...row }];
        },
      ],
      [/^DELETE FROM "people"\."trash" /, (_text, values) => [trashRow(String(values[1]), owner.userid)]],
      ...extra,
    ],
  });
  const fence: AddressDeps['fence'] = {
    fencePersons,
    withPersonsOpen: (fenceDb, tenantId, fn, opts) => withPersonsOpen(fenceDb, tenantId, fn, { ...opts, sleep: instant }),
  };
  const repo = createPeopleRepository({ clock: TEST_CLOCK, schema: 'people' });
  return { db, store, deps: { db, repo, clock: TEST_CLOCK, fence } };
}

/** The tables the recorded writes target, in order. */
function writtenTables(db: RecordingDb): string[] {
  return db.writes().map(({ text }) => WRITE_TARGET.exec(text)?.[1] ?? text);
}

/** The values each write of `table` assigns, in order. */
function writesOf(db: RecordingDb, table: string): Row[] {
  return db
    .writes()
    .filter(({ text }) => WRITE_TARGET.exec(text)?.[1] === table)
    .map(({ text, values }) => (text.startsWith('UPDATE') ? assignments(text, values) : insertedRow(text, values)));
}

/** Every schema a recorded statement names. */
function schemasNamed(db: RecordingDb): string[] {
  const names = db.statements().flatMap(({ text }) => [...text.matchAll(QUALIFIED_NAME)].map(([, schema = '']) => schema));
  return [...new Set(names)];
}

/** Transaction control statements and the tenant each transaction set, in order. */
function transactions(db: RecordingDb): string[] {
  return db.statements().flatMap(({ text, values }) => {
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(text)) return [text];
    return text.startsWith("SELECT set_config('app.tenant_id'") ? [`tenant ${String(values[0])}`] : [];
  });
}

/** Index of the first recorded statement `pattern` matches; -1 for none. */
function firstIndex(db: RecordingDb, pattern: RegExp): number {
  return db.statements().findIndex(({ text }) => pattern.test(text));
}

describe('insertAddressInTx', () => {
  it('binds a posted JSON boolean as its CFML text', async () => {
    const owner = personRow();
    const { db, deps } = recording(owner);
    const input = posted({ addressid: 'ADDR-1', userid: owner.userid, city: true, state: false });
    const values = applyAddressInput({ ...ADDRESS_DEFAULTS, errors: {} }, input);
    const row = await withTenant(db, A, (tx) => insertAddressInTx(deps.repo, tx, values, ACTOR.write));
    expect(row).toMatchObject({ addressid: 'ADDR-1', city: 'true', state: 'false' });
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE]);
  });
});

describe('createAddress over a recording database', () => {
  it('writes one address at the owner site in one tenant transaction, after fencing the owner', async () => {
    const owner = personRow();
    const { db, store, deps } = recording(owner);
    const result = await createAddress(deps, A, posted({ userID: owner.userid, siteid: TENANT_B.siteId, city: 'Oslo' }), ACTOR);
    const addressId = result.address?.addressid ?? '';
    expect(isCfUuid(addressId)).toBe(true);
    expect(store.get(addressId)).toMatchObject({ tenant_id: A, userid: owner.userid, siteid: TENANT_A.siteId, city: 'Oslo', isprimary: 0 });
    expect(transactions(db)).toEqual(['BEGIN', `tenant ${A}`, 'COMMIT']);
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE]);
    expect(writesOf(db, CHANGELOG_TABLE)).toMatchObject([{ table: 'user_address', op: 'insert', actor_user_id: 'ACTOR', request_id: 'REQ-1' }]);
    expect(schemasNamed(db)).toEqual(['people']);
    expect(firstIndex(db, OPEN_OPERATION_READ)).toBeLessThan(firstIndex(db, PERSON_READ));
  });

  it.skipIf(!PEOPLE_TRASH_ENABLED)('takes an address restored from the trash out of people.trash after the insert', async () => {
    const owner = personRow();
    const { db, deps } = recording(owner);
    await createAddress(deps, A, posted({ userid: owner.userid, addressid: 'ADDR-1', fromMuraTrash: 'true' }), ACTOR);
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE, TRASH_TABLE, CHANGELOG_TABLE]);
    expect(db.writes()[2]?.values).toEqual([A, 'ADDR-1']);
    expect(transactions(db)).toEqual(['BEGIN', `tenant ${A}`, 'COMMIT']);
  });
});

describe('updateAddress over a recording database', () => {
  it('creates without a posted addressid', async () => {
    const owner = personRow();
    const { db, store, deps } = recording(owner);
    const result = await updateAddress(deps, A, posted({ userid: owner.userid, addressid: '', city: 'Bergen' }), ACTOR);
    expect(store.get(result.address?.addressid ?? '')).toMatchObject({ userid: owner.userid, siteid: TENANT_A.siteId, city: 'Bergen' });
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE]);
    expect(db.writes()[0]?.text).toMatch(/^INSERT /);
  });

  it('updates the stored address at the owner site, leaving isPrimary', async () => {
    const owner = personRow();
    const stored = addressRow({ userid: owner.userid, siteid: TENANT_A.siteId, city: 'Oslo', isprimary: 1 });
    const { db, store, deps } = recording(owner, [stored]);
    const input = posted({ userid: owner.userid, addressid: stored.addressid, city: 'Bergen', isprimary: '0', siteid: TENANT_B.siteId });
    const result = await updateAddress(deps, A, input, ACTOR);
    expect(result.address).toEqual({ ...stored, city: 'Bergen' });
    expect(store.get(stored.addressid)).toEqual(result.address);
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE]);
    expect(writesOf(db, ADDRESS_TABLE)[0]).not.toHaveProperty('isprimary');
    expect(writesOf(db, CHANGELOG_TABLE)).toMatchObject([{ table: 'user_address', op: 'update' }]);
    expect(transactions(db)).toEqual(['BEGIN', `tenant ${A}`, 'COMMIT']);
    expect(schemasNamed(db)).toEqual(['people']);
  });

  it('locks a stored address anew when the locked read missed a row deleted and inserted again', async () => {
    const owner = personRow();
    const stored = addressRow({ userid: owner.userid, siteid: TENANT_A.siteId, city: 'Oslo' });
    let missed = 0;
    const { db, deps } = recording(owner, [stored], [[(text) => ADDRESS_LOCKED_READ.test(text) && missed++ === 0, []]]);
    const result = await updateAddress(deps, A, posted({ userid: owner.userid, addressid: stored.addressid, city: 'Bergen' }), ACTOR);
    expect(result.address).toMatchObject({ addressid: stored.addressid, city: 'Bergen' });
    const reads = db
      .statements()
      .flatMap(({ text }) => (ADDRESS_LOCKED_READ.test(text) ? ['locked'] : ADDRESS_PLAIN_READ.test(text) ? ['plain'] : []));
    expect(reads).toEqual(['locked', 'plain', 'locked']);
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE]);
  });
});

describe('address saves of a user an open roster operation keeps closed', () => {
  it.each<[string, Save, (address: AddressRow) => Row]>([
    ['createAddress', createAddress, (address) => ({ userid: address.userid, city: 'Bergen' })],
    ['updateAddress', updateAddress, (address) => ({ userid: address.userid, addressid: address.addressid, city: 'Bergen' })],
    ['saveAddress', saveAddress, (address) => ({ addressid: address.addressid, city: 'Bergen' })],
  ])('%s waits out the fence, then answers the legacy 503 having written nothing', async (_name, save, params) => {
    const owner = personRow();
    const stored = addressRow({ userid: owner.userid, siteid: TENANT_A.siteId });
    const open = { tenant_id: A, operation_id: 'OP-1', user_id: owner.userid, state: 'started' };
    const { db, store, deps } = recording(owner, [stored], [[OPEN_OPERATION_READ, [open]]]);
    const outcome = save(deps, A, posted(params(stored)), ACTOR);
    await expect(outcome).rejects.toBeInstanceOf(OperationBlockedError);
    await expect(outcome).rejects.toMatchObject({ reason: 'operation-blocked', message: `Roster operation OP-1 keeps user ${owner.userid} closed` });
    expect(db.writes()).toEqual([]);
    expect(store.get(stored.addressid)).toEqual(stored);
    const control = transactions(db).filter((entry) => !entry.startsWith('tenant '));
    expect(control.length).toBeGreaterThan(2);
    expect(new Set(control)).toEqual(new Set(['BEGIN', 'ROLLBACK']));
    expect(firstIndex(db, PERSON_READ)).toBe(-1);
  });
});

describe('setPrimaryAddress over a recording database', () => {
  it("sets the chosen address primary and the user's other primaries 0, skipping rows already there", async () => {
    const owner = personRow();
    const rows = [
      addressRow({ addressid: 'A0000000-0000-0000-0000000000000001', userid: owner.userid, isprimary: 1 }),
      addressRow({ addressid: 'A0000000-0000-0000-0000000000000002', userid: owner.userid, isprimary: 0 }),
      addressRow({ addressid: 'A0000000-0000-0000-0000000000000003', userid: owner.userid, isprimary: null }),
      addressRow({ addressid: 'A0000000-0000-0000-0000000000000004', userid: owner.userid, isprimary: 0 }),
      addressRow({ addressid: 'A0000000-0000-0000-0000000000000005', isprimary: 1 }),
    ];
    const { db, store, deps } = recording(owner, rows);
    const chosen = rows[3]?.addressid ?? '';
    await withTenant(db, A, (tx) => setPrimaryAddress(deps.repo, tx, owner.userid, chosen, ACTOR.write));
    expect([...store.values()].map((row) => row.isprimary)).toEqual([0, 0, 0, 1, 1]);
    const updates = db
      .writes()
      .filter(({ text }) => text.startsWith('UPDATE '))
      .map(({ text, values }) => [keyOf(text, values, 'addressid'), assignments(text, values)]);
    expect(updates).toEqual([
      [rows[0]?.addressid, { isprimary: 0 }],
      [rows[2]?.addressid, { isprimary: 0 }],
      [chosen, { isprimary: 1 }],
    ]);
    expect(writtenTables(db)).toEqual([ADDRESS_TABLE, CHANGELOG_TABLE, ADDRESS_TABLE, CHANGELOG_TABLE, ADDRESS_TABLE, CHANGELOG_TABLE]);
    expect(schemasNamed(db)).toEqual(['people']);
  });
});

describe.skipIf(!PG_AVAILABLE)('listAddresses against PostgreSQL', () => {
  it("lists the user's addresses primary first, then by addressid, a NULL isPrimary last", async () => {
    const owner = personRow();
    const id = (n: number): string => `B0000000-0000-0000-000000000000000${String(n)}`;
    const own = [
      addressRow({ addressid: id(1), userid: owner.userid, isprimary: null }),
      addressRow({ addressid: id(2), userid: owner.userid, isprimary: 0 }),
      addressRow({ addressid: id(3), userid: owner.userid, isprimary: 1 }),
      addressRow({ addressid: id(4), userid: owner.userid, isprimary: 0 }),
    ];
    const outcome = await withPgApp(async ({ db }) => {
      await seedPeople(db, {
        [A]: { persons: [owner], addresses: [...own, addressRow({ addressid: id(5), isprimary: 1 })] },
        [TENANT_B.tenantId]: { addresses: [addressRow({ addressid: id(6), userid: owner.userid, siteid: TENANT_B.siteId, isprimary: 1 })] },
      });
      const repo = createPeopleRepository({ clock: TEST_CLOCK, schema: db.schema });
      return withTenant(db, A, (tx) => listAddresses(repo, tx, owner.userid));
    });
    expect(outcome).not.toHaveProperty('skipped');
    expect((outcome as AddressRow[]).map((row) => [row.addressid, row.isprimary])).toEqual([
      [id(3), 1],
      [id(2), 0],
      [id(4), 0],
      [id(1), null],
    ]);
  });
});
