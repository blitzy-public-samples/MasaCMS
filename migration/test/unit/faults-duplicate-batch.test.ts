// Unit tests for the duplicate-batch fault script, with fake owners, catalog and snapshot reads.
import { LEGACY_PROGRAM_ID_COLUMN, decodeRow, encodeKey, encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { fixedClock } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { currentAuthority, type CurrentAuthority } from '../../src/cutover/index.js';
import { describeLegacyTable, migratableTables, streamLegacyTable } from '../../src/extract/index.js';
import type { CanonicalRow, LegacyTableShape, MigratableTable } from '../../src/extract/index.js';
import { duplicateBatch, type DuplicateBatchParams } from '../../src/faults/scripts/duplicate-batch.js';
import type { FaultEnv } from '../../src/faults/scripts/types.js';
import type { ApplyResult, DataOwner, LegacyTableTarget, OwnersClient, Unit, UnitCatalog } from '../../src/owners/index.js';
import { createTenantResolver, describeUnitTable, readLegacyUnitRows, readTargetUnitRows, toUnitRow } from '../../src/reconcile/index.js';
import type { LegacyUnitRows, TargetUnitRows, TenantResolver, UnitTableShape } from '../../src/reconcile/index.js';
import { latestSnapshot, type SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/extract/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/extract/index.js')>()),
  listLegacyTables: vi.fn(() => Promise.resolve([])),
  migratableTables: vi.fn(),
  describeLegacyTable: vi.fn(),
  streamLegacyTable: vi.fn(),
}));

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  latestSnapshot: vi.fn(),
}));

vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  createTenantResolver: vi.fn(),
  describeUnitTable: vi.fn(),
  readLegacyUnitRows: vi.fn(),
  readTargetUnitRows: vi.fn(),
}));

vi.mock('../../src/cutover/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cutover/index.js')>()),
  currentAuthority: vi.fn(),
}));

const NOW = '2026-06-30T12:00:00.000Z';
const BATCH_ID = `fault:duplicate-batch:${NOW}`;
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const SNAPSHOT_DB = 'muradb_opt2_snap_3';

const text = (...names: string[]): CanonicalColumn[] => names.map((name) => ({ name, type: 's' }));
const USER_COLUMNS = text('UserID', 'SiteID', 'Type', 'Fname');
const ADDRESS_COLUMNS = text('addressID', 'UserID', 'SiteID');
const TRASH_COLUMNS = text('objectID', 'objectClass', 'SiteID');
const BLACKOUT_COLUMNS = [...text('blackout_id', 'reason'), { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' } as const];

const unit = (id: string, owner: DataOwner, legacyTables: string[]): Unit => ({ id, owner, schema: id.split('.')[0] ?? '', legacyTables });
const target = (unitId: string, owner: DataOwner, keyColumns: string[], rowPredicate: string | null = null): LegacyTableTarget => ({
  unit: unitId,
  owner,
  rowPredicate,
  keyColumns,
  ownedColumns: 'whole-table',
  objectColumns: {},
});
const migratable = (name: string, owners: DataOwner[], keyColumns: string[], programIds: number[] = []): MigratableTable => ({
  name,
  owner: owners.length > 1 ? 'split' : (owners[0] as DataOwner),
  owners,
  physical:
    programIds.length === 0
      ? [{ ref: { schema: 'dbo', table: name, qualified: `dbo.${name}` } }]
      : programIds.map((programId) => ({ ref: { schema: `Program_${String(programId)}`, table: 'blackout', qualified: `Program_${String(programId)}.blackout` }, programId })),
  folded: programIds.length > 0,
  keyColumns,
});

const UNITS: Unit[] = [
  unit('people.extend_attribute', 'people', ['tclassextendattributes']),
  unit('people.user_interest', 'people', ['tusersinterests']),
  unit('people.user_tag', 'people', ['tuserstags']),
  unit('people.person', 'people', ['tusers']),
  unit('people.user_address', 'people', ['tuseraddresses']),
  unit('people.trash', 'people', ['ttrash']),
  unit('identity.group_account', 'identity', ['tusers']),
  unit('identity.user_account', 'identity', ['tusers']),
  unit('timesheets.blackout', 'timesheets', ['Program_N.blackout']),
];

/** Targets with the split predicates of the ownership file: a row column, a joined owner column and a class map. */
const TARGETS: Record<string, LegacyTableTarget[]> = {
  tusers: [
    target('identity.group_account', 'identity', ['UserID'], 'Type = 1'),
    target('identity.user_account', 'identity', ['UserID'], 'Type = 2'),
    target('people.person', 'people', ['UserID'], 'Type = 2'),
  ],
  tuseraddresses: [
    target('identity.user_address', 'identity', ['addressID'], 'owner Type = 1'),
    target('people.user_address', 'people', ['addressID'], 'owner Type = 2'),
  ],
  ttrash: [
    target('identity.trash', 'identity', ['objectID'], 'classMap owner = identity'),
    target('people.trash', 'people', ['objectID'], 'classMap owner = people'),
  ],
  tusersinterests: [target('people.user_interest', 'people', [])],
  tuserstags: [target('people.user_tag', 'people', ['UserID', 'tag'])],
  'program_n.blackout': [target('timesheets.blackout', 'timesheets', ['blackout_id'])],
  tcontent: [target('content.content', 'strategies-content', ['ContentID'])],
};

/** Snapshot tables; `tclassextendattributes` is absent, as from a database without it. */
const LIVE: MigratableTable[] = [
  migratable('tusers', ['identity', 'people'], ['UserID']),
  migratable('tuseraddresses', ['identity', 'people'], ['addressID']),
  migratable('ttrash', ['identity', 'people'], ['objectID']),
  migratable('tusersinterests', ['people'], []),
  migratable('tuserstags', ['people'], ['UserID', 'tag']),
  migratable('Program_N.blackout', ['timesheets'], ['blackout_id'], [1, 2]),
  migratable('tcontent', ['strategies-content'], ['ContentID']),
];

/** Legacy columns per table, as describeLegacyTable reports them; tusersinterests is keyless. */
const LEGACY_COLUMNS: Record<string, CanonicalColumn[]> = {
  tuseraddresses: ADDRESS_COLUMNS,
  ttrash: TRASH_COLUMNS,
  tusersinterests: text('UserID', 'interestID'),
  'Program_N.blackout': BLACKOUT_COLUMNS,
};

/** Unit shapes per legacy table, as describeUnitTable reports them. */
const UNIT_SHAPES: Record<string, Pick<UnitTableShape, 'keyColumns' | 'columns' | 'folded'>> = {
  tusers: { keyColumns: ['UserID'], columns: text('UserID', 'Fname'), folded: false },
  tuserstags: { keyColumns: ['UserID', 'tag'], columns: text('UserID', 'tag'), folded: false },
  tuseraddresses: { keyColumns: ['addressID'], columns: ADDRESS_COLUMNS, folded: false },
  ttrash: { keyColumns: ['objectID'], columns: TRASH_COLUMNS, folded: false },
  'Program_N.blackout': { keyColumns: ['blackout_id', LEGACY_PROGRAM_ID_COLUMN], columns: BLACKOUT_COLUMNS, folded: true },
};

type Values = Readonly<Record<string, unknown>>;

const PEOPLE_CLASSES = new Set(['userBean', 'addressBean']);
const userType = (userId: unknown): unknown => tableRows.tusers?.find((user) => user.row.UserID === userId)?.row.Type;

/** Rows each predicate unit takes in reconciliation's legacy row selection; units absent here take every row. */
const UNIT_TAKES: Record<string, (row: Values) => boolean> = {
  'identity.group_account': (row) => row.Type === '1',
  'identity.user_account': (row) => row.Type === '2',
  'people.person': (row) => row.Type === '2',
  'people.user_address': (row) => userType(row.UserID) === '2',
  'people.trash': (row) => PEOPLE_CLASSES.has(String(row.objectClass)),
};

/** Owner-side split acceptance per unit, as the mappings' acceptsRow decides it: a row column, else the sent discriminator. */
const OWNER_TAKES: Record<string, (values: Values, discriminator: string | number | undefined) => boolean> = {
  'identity.group_account': (values) => values.Type === '1',
  'identity.user_account': (values) => values.Type === '2',
  'people.person': (values) => values.Type === '2',
  'people.user_address': (_values, discriminator) => String(discriminator) === '2',
  'people.trash': (_values, discriminator) => discriminator === 'people',
};

const catalog = {
  foldProgramTable: (table: string) => {
    const match = /^Program_(\d+)\.(.+)$/i.exec(table);
    return match === null ? { legacyTable: table, programId: null } : { legacyTable: `Program_N.${match[2] ?? ''}`, programId: Number(match[1]) };
  },
  unitsOfOwner: (owner: string) => UNITS.filter((candidate) => candidate.owner === owner),
  legacyTablesOf: (id: string) => UNITS.find((candidate) => candidate.id === id)?.legacyTables ?? [],
  unitsForLegacyTable: (table: string) => TARGETS[table.toLowerCase()] ?? [],
} as unknown as UnitCatalog;

const SNAPSHOT = { seq: 3, state: 'ready', databaseName: SNAPSHOT_DB } as SnapshotRecord;

interface UserRow {
  UserID: string;
  SiteID: string;
  Type?: '1' | '2';
}

/** A snapshot row of a table keyed on its first column. */
function keyedRow(table: string, columns: CanonicalColumn[], row: Record<string, string>): CanonicalRow {
  const keyColumn = columns[0]?.name ?? '';
  return { table, key: encodeKey(columns, [keyColumn], row), keyValues: [row[keyColumn] ?? null], encoding: encodeRow(columns, row), row };
}

function userRow({ UserID, SiteID, Type = '2' }: UserRow): CanonicalRow {
  return keyedRow('tusers', USER_COLUMNS, { UserID, SiteID, Type, Fname: `F-${UserID}` });
}

function addressRow(addressID: string, UserID: string, SiteID: string): CanonicalRow {
  return keyedRow('tuseraddresses', ADDRESS_COLUMNS, { addressID, UserID, SiteID });
}

function trashRow(objectID: string, objectClass: string, SiteID: string): CanonicalRow {
  return keyedRow('ttrash', TRASH_COLUMNS, { objectID, objectClass, SiteID });
}

function blackoutRow(id: string, programId: number): CanonicalRow {
  const row = { blackout_id: id, reason: 'archived', [LEGACY_PROGRAM_ID_COLUMN]: String(programId) };
  return {
    table: 'Program_N.blackout',
    legacyProgramId: programId,
    key: encodeKey(BLACKOUT_COLUMNS, ['blackout_id', LEGACY_PROGRAM_ID_COLUMN], row),
    keyValues: [id, String(programId)],
    encoding: encodeRow(BLACKOUT_COLUMNS, row),
    row,
  };
}

const legacyShape = (table: string, columns: CanonicalColumn[], keyed: boolean): LegacyTableShape => ({
  table,
  folded: table.startsWith('Program_'),
  keyed,
  keyColumns: keyed ? [columns[0]?.name ?? ''] : [],
  columns,
  parts: [],
});

const PERSON_SHAPE: UnitTableShape = {
  unit: 'people.person',
  owner: 'people',
  legacyTable: 'tusers',
  keyed: true,
  keyColumns: ['UserID'],
  columns: text('UserID', 'Fname'),
  excludedColumns: [],
  objectColumns: [],
  folded: false,
};

/** Owner rows per table in the stream mock, and how many rows each stream yielded before it was closed. */
let tableRows: Record<string, CanonicalRow[]>;
let streamed: Record<string, { yielded: number; closed: boolean }>;
/** Units whose legacy rows were read, and whether each read was disposed. */
let unitReads: { unit: string; disposed: boolean }[];
/** Target rows the export mock answers; `exportsSeen` counts the exports, so a test can change what later exports return. */
let targetRows: (exportIndex: number) => Record<string, string | null>[];
let exportsSeen: number;

type OwnerTakes = (unit: string, values: Values, discriminator: string | number | undefined) => boolean;

const ownerTakes: OwnerTakes = (unitId, values, discriminator) => OWNER_TAKES[unitId]?.(values, discriminator) ?? true;

/** Owner double following the apply handler: a recorded batch id is a duplicate, and `applied` counts rows some listed unit takes. */
function fakeOwners(options: { dedupe?: boolean; collide?: boolean; takes?: OwnerTakes } = {}) {
  const { dedupe = true, collide = false, takes = ownerTakes } = options;
  const seen = new Set<string>();
  const apply = vi.fn<OwnersClient['apply']>((owner, req) => {
    const duplicate = collide || (dedupe && seen.has(req.batchId));
    seen.add(req.batchId);
    const applied = req.rows.filter((input) => {
      const values = decodeRow(req.columns, input.row);
      return (req.units ?? []).some((unitId) => takes(unitId, values, input.discriminator));
    }).length;
    const result: ApplyResult = duplicate
      ? { batchId: req.batchId, duplicate: true, applied: 0, skipped: 0, writePositions: new Map() }
      : { batchId: req.batchId, duplicate: false, applied, skipped: req.rows.length - applied, writePositions: new Map([[owner, String(100 + seen.size)]]) };
    return Promise.resolve(result);
  });
  let reads = 0;
  const position = vi.fn<OwnersClient['position']>((owner) => {
    reads += 1;
    return Promise.resolve({ owner, position: String(200 + reads), outbox: null, inbox: null });
  });
  return { apply, position };
}

function envWith(owners: ReturnType<typeof fakeOwners>) {
  const ctx = {
    config: loadConfig(),
    catalog,
    legacy: { database: vi.fn(() => Promise.resolve({} as ConnectionPool)) },
    owners,
    gateway: { status: vi.fn() },
  } as unknown as MigrationContext;
  return { ctx, clock: fixedClock(NOW) } as unknown as FaultEnv;
}

function authorityWith(targetUnits: string[]): CurrentAuthority {
  const set = new Set(targetUnits);
  return { tableVersion: set.size > 0 ? 'v0002' : 'v0001', epoch: 1, units: new Map(), targetUnits: set, isTargetAuthoritative: (id) => set.has(id), anyTarget: set.size > 0 };
}

const params = (overrides: Partial<DuplicateBatchParams> = {}): DuplicateBatchParams => ({ owner: 'people', rows: 10, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  // TENANT_B sorts before TENANT_A, so tenant-b is the first tenant with rows of every unit below.
  tableRows = {
    tusers: [
      userRow({ UserID: 'U1', SiteID: 'tenant-a' }),
      userRow({ UserID: 'G1', SiteID: 'tenant-b', Type: '1' }),
      userRow({ UserID: 'U2', SiteID: 'tenant-b' }),
      userRow({ UserID: 'U3', SiteID: 'tenant-a' }),
      userRow({ UserID: 'U4', SiteID: 'tenant-b' }),
      userRow({ UserID: 'U5', SiteID: 'tenant-b' }),
    ],
    tuseraddresses: [addressRow('A1', 'U2', 'tenant-b'), addressRow('A2', 'G1', 'tenant-b'), addressRow('A3', 'U1', 'tenant-a'), addressRow('A4', 'U4', 'tenant-b')],
    ttrash: [trashRow('T1', 'userBean', 'tenant-b'), trashRow('T2', 'contentBean', 'tenant-b'), trashRow('T3', 'addressBean', 'tenant-b'), trashRow('T4', 'userBean', 'tenant-a')],
    tusersinterests: [userRow({ UserID: 'U1', SiteID: 'tenant-a' })],
    tuserstags: [],
    'Program_N.blackout': [blackoutRow('B1', 2), blackoutRow('B2', 1), blackoutRow('B3', 2)],
  };
  streamed = {};
  unitReads = [];
  targetRows = () => [{ UserID: 'U1', Fname: 'F-U1' }];
  exportsSeen = 0;

  vi.mocked(latestSnapshot).mockResolvedValue(SNAPSHOT);
  vi.mocked(migratableTables).mockReturnValue(LIVE);
  vi.mocked(describeLegacyTable).mockImplementation((_deps, { table }) => {
    const name = typeof table === 'string' ? table : table.name;
    return Promise.resolve(legacyShape(name, LEGACY_COLUMNS[name] ?? USER_COLUMNS, name !== 'tusersinterests'));
  });
  vi.mocked(streamLegacyTable).mockImplementation(async function* (_deps, { table }) {
    const name = typeof table === 'string' ? table : table.name;
    const progress = { yielded: 0, closed: false };
    streamed[name] = progress;
    try {
      for (const row of tableRows[name] ?? []) {
        progress.yielded += 1;
        yield row;
      }
    } finally {
      progress.closed = true;
    }
  });
  vi.mocked(createTenantResolver).mockResolvedValue({
    resolve: (_table, row) => ({ tenantId: tenantIdForSite(typeof row.SiteID === 'string' ? row.SiteID : 'tenant-b'), orphan: false }),
    siteTenants: () => [TENANT_A, TENANT_B],
  } satisfies TenantResolver);
  vi.mocked(currentAuthority).mockResolvedValue(authorityWith([]));
  vi.mocked(describeUnitTable).mockImplementation((_deps, options) =>
    Promise.resolve({ ...PERSON_SHAPE, ...UNIT_SHAPES[options.legacyTable], unit: options.unit, legacyTable: options.legacyTable }),
  );
  vi.mocked(readLegacyUnitRows).mockImplementation((_deps, shape, { tenants }) => {
    const takes = UNIT_TAKES[shape.unit] ?? (() => true);
    const byTenant = new Map<string, CanonicalRow[]>();
    for (const source of tableRows[shape.legacyTable] ?? []) {
      if (!takes(source.row)) continue;
      const { tenantId } = tenants.resolve(shape.legacyTable, source.row);
      const values = Object.fromEntries(shape.columns.map((column) => [column.name, source.row[column.name] ?? null]));
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), toUnitRow(shape, values, source.legacyProgramId)]);
    }
    const read = { unit: shape.unit, disposed: false };
    unitReads.push(read);
    const sorted = [...byTenant.keys()].sort();
    const result: LegacyUnitRows = {
      tenants: sorted,
      counts: new Map(sorted.map((tenantId) => [tenantId, byTenant.get(tenantId)?.length ?? 0])),
      rows: (tenantId) => [...(byTenant.get(tenantId) ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      orphans: new Map(),
      dispose: () => {
        read.disposed = true;
        return Promise.resolve();
      },
    };
    return Promise.resolve(result);
  });
  vi.mocked(readTargetUnitRows).mockImplementation((_deps, shape) => {
    const rows = targetRows(exportsSeen).map((values) => toUnitRow(shape, Object.fromEntries(shape.columns.map((column) => [column.name, values[column.name] ?? null]))));
    exportsSeen += 1;
    const result: TargetUnitRows = { rows, count: rows.length, objects: null, dispose: vi.fn(() => Promise.resolve()) };
    return Promise.resolve(result);
  });
});

describe('duplicate-batch fault script', () => {
  it('is the config fault duplicate-batch, reconciles afterwards and has nothing to resume', async () => {
    expect(duplicateBatch.name).toBe('duplicate-batch');
    expect(duplicateBatch.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(duplicateBatch.name);
    await expect(duplicateBatch.resume(envWith(fakeOwners()), params())).resolves.toStrictEqual({ steps: [], assertions: [] });
  });

  it.each([
    [{}, { owner: 'people', rows: 10 }],
    [{ owner: 'identity', table: 'tusers', rows: 2 }, { owner: 'identity', table: 'tusers', rows: 2 }],
  ])('parses %j as %j', (input, expected) => {
    expect(duplicateBatch.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ rows: 0 }, { rows: 1.5 }, { owner: 7 }, { batch: 'x' }])('rejects params %j', (input) => {
    expect(duplicateBatch.paramsSchema.safeParse(input).success).toBe(false);
  });

  it("resends the owner's first keyed table its unit takes rows of under one batch id and passes when the repeat is a no-op", async () => {
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ rows: 2 }));

    // tusersinterests is keyless and people.user_tag takes no tuserstags row, so tusers is chosen: people.person takes
    // U2 and U4 first in tenant-b, and the tusers stream closed once both were found.
    expect(streamed.tusersinterests).toBeUndefined();
    expect(streamed.tusers).toStrictEqual({ yielded: 5, closed: true });
    expect(unitReads).toStrictEqual([
      { unit: 'people.user_tag', disposed: true },
      { unit: 'people.person', disposed: true },
    ]);
    expect(owners.apply).toHaveBeenCalledTimes(2);
    const [first, second] = owners.apply.mock.calls;
    expect(second).toStrictEqual(first);
    const request = first?.[1] as ApplyRequest;
    const rows = tableRows.tusers ?? [];
    expect(first?.[0]).toBe('people');
    expect(request).toStrictEqual({
      batchId: BATCH_ID,
      origin: 'migration-feed',
      legacyTable: 'tusers',
      tenantId: TENANT_B,
      columns: USER_COLUMNS,
      units: ['people.person'],
      rows: [rows[2], rows[4]].map((row) => ({ op: 'upsert', row: row?.encoding })),
    });
    expect(request).not.toHaveProperty('watermark');
    expect(vi.mocked(currentAuthority)).toHaveBeenCalledWith({ gateway: expect.anything(), config: loadConfig().paths });

    expect(output.assertions.map((assertion) => [assertion.name, assertion.status])).toStrictEqual([
      ['first-applied', 'pass'],
      ['second-is-noop', 'pass'],
    ]);
    expect(output.assertions[0]?.detail).toStrictEqual({ batchId: BATCH_ID, applied: 2, skipped: 0 });
    expect(output.assertions[1]?.detail).toMatchObject({
      batchId: BATCH_ID,
      owner: 'people',
      table: 'tusers',
      tenantId: TENANT_B,
      rows: 2,
      position: { before: '201', after: '202' },
    });
    expect(output.details).toStrictEqual({
      owner: 'people',
      table: 'tusers',
      unit: 'people.person',
      units: ['people.person'],
      snapshotSeq: 3,
      tenantId: TENANT_B,
      batchId: BATCH_ID,
      rows: 2,
      discriminator: null,
    });
  });

  it.each([
    ['people', 'people.person', ['people.person'], ['U2', 'U4', 'U5'], '2'],
    ['identity', 'identity.group_account', ['identity.group_account', 'identity.user_account'], ['G1'], '1'],
  ])('sends %s only the tusers rows of its column split, carrying Type without a discriminator', async (owner, unitId, units, userIds, type) => {
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ owner, table: 'tusers' }));

    const request = owners.apply.mock.calls[0]?.[1] as ApplyRequest;
    const sent = request.rows.map((input) => decodeRow(request.columns, input.row));
    expect(request.units).toStrictEqual(units);
    expect(sent.map((values) => values.UserID)).toStrictEqual(userIds);
    expect(sent.every((values) => values.Type === type)).toBe(true);
    expect(request.rows.every((input) => !('discriminator' in input))).toBe(true);
    expect(output.details).toMatchObject({ unit: unitId, tenantId: TENANT_B, discriminator: null });
    expect(output.assertions.map((assertion) => assertion.status)).toStrictEqual(['pass', 'pass']);
    expect(output.assertions[0]?.detail).toMatchObject({ applied: userIds.length, skipped: 0 });
  });

  it.each([
    ['a joined owner predicate', 'tuseraddresses', 'people.user_address', [0, 3], 2],
    ['a class map', 'ttrash', 'people.trash', [0, 2], 'people'],
  ])('sends each row the discriminator of %s, so the owner applies every one', async (_label, table, unitId, picked, discriminator) => {
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ table }));

    const rows = tableRows[table] ?? [];
    const request = owners.apply.mock.calls[0]?.[1] as ApplyRequest;
    expect(request).toMatchObject({ legacyTable: table, tenantId: TENANT_B, units: [unitId] });
    expect(request.rows).toStrictEqual(picked.map((index) => ({ op: 'upsert', row: rows[index]?.encoding, discriminator })));
    expect(output.details).toMatchObject({ unit: unitId, discriminator, rows: picked.length });
    expect(output.assertions.map((assertion) => [assertion.name, assertion.status])).toStrictEqual([
      ['first-applied', 'pass'],
      ['second-is-noop', 'pass'],
    ]);
    expect(output.assertions[0]?.detail).toStrictEqual({ batchId: BATCH_ID, applied: picked.length, skipped: 0 });
  });

  it.each<[string, OwnerTakes, string, { applied: number; skipped: number }]>([
    ['applies none', () => false, 'the owner applied none of the 2 rows', { applied: 0, skipped: 2 }],
    ['skips one', (_unit, values) => values.UserID !== 'U4', 'the owner skipped 1 of 2 selected rows', { applied: 1, skipped: 1 }],
  ])('fails both assertions when the owner %s of the first batch', async (_label, takes, reason, counts) => {
    const owners = fakeOwners({ takes });
    const output = await duplicateBatch.run(envWith(owners), params({ rows: 2 }));

    expect(owners.apply).toHaveBeenCalledTimes(2);
    expect(output.assertions[0]).toStrictEqual({
      name: 'first-applied',
      status: 'fail',
      detail: { batchId: BATCH_ID, owner: 'people', table: 'tusers', tenantId: TENANT_B, rows: 2, ...counts },
      reason,
    });
    expect(output.assertions[1]).toMatchObject({
      name: 'second-is-noop',
      status: 'fail',
      detail: { duplicate: true, applied: 0, writePosition: null },
      reason: `${reason}, so the repeat proves no data-write idempotency`,
    });
  });

  it('sends a folded table as its first program part, as the owner batcher partitions it', async () => {
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ owner: 'timesheets', table: 'Program_2.blackout' }));

    const request = owners.apply.mock.calls[0]?.[1];
    expect(request).toMatchObject({ legacyTable: 'Program_2.blackout', legacyProgramId: 2, tenantId: TENANT_B, units: ['timesheets.blackout'] });
    expect(request?.rows).toHaveLength(2);
    expect(output.assertions.every((assertion) => assertion.status === 'pass')).toBe(true);
  });

  it.each([
    ['an owner that does not deduplicate', { dedupe: false }, () => [{ UserID: 'U1', Fname: 'F-U1' }], /not report the resent batch as a duplicate; the resent batch committed a write at position 101/],
    ['an export that changes on the repeat', {}, (index: number) => [{ UserID: 'U1', Fname: index < 1 ? 'F-U1' : 'changed' }], /^the owner export changed for people\.person$/],
  ])('fails second-is-noop for %s', async (_label, owner, rows, reason) => {
    targetRows = rows;
    const output = await duplicateBatch.run(envWith(fakeOwners(owner)), params());

    const [firstApplied, noop] = output.assertions;
    expect(firstApplied?.status).toBe('pass');
    expect(noop).toMatchObject({ name: 'second-is-noop', status: 'fail', reason: expect.stringMatching(reason) });
    expect(noop?.detail).toHaveProperty('checksum.before');
  });

  it('fails first-applied when the fresh batch id already collided, and second-is-noop with it', async () => {
    const output = await duplicateBatch.run(envWith(fakeOwners({ collide: true })), params());
    expect(output.assertions[0]).toStrictEqual({
      name: 'first-applied',
      status: 'fail',
      detail: { batchId: BATCH_ID, owner: 'people', table: 'tusers', tenantId: TENANT_B },
      reason: 'batch id collided',
    });
    expect(output.assertions[1]).toMatchObject({
      name: 'second-is-noop',
      status: 'fail',
      reason: 'batch id collided, so the repeat proves no data-write idempotency',
    });
  });

  it('refuses a target-authoritative unit without sending anything', async () => {
    vi.mocked(currentAuthority).mockResolvedValue(authorityWith(['people.person']));
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ table: 'tusers' }));

    expect(owners.apply).not.toHaveBeenCalled();
    expect(output.assertions).toStrictEqual([
      {
        name: 'legacy-authoritative',
        status: 'fail',
        detail: { units: ['people.person'], tableVersion: 'v0002' },
        reason: 'applying snapshot rows to a target-authoritative unit is refused',
      },
    ]);
  });

  it.each<[string, Partial<DuplicateBatchParams>, Record<string, CanonicalRow[]>, string]>([
    ['an unknown owner', { owner: 'gateway' }, {}, 'unknown data owner'],
    ['a table outside the snapshot', { table: 'tclassextendattributes' }, {}, 'not a migratable table of the latest snapshot'],
    ['a table of another owner', { table: 'tcontent' }, {}, 'table is not owned by people'],
    ['a keyless table', { table: 'tusersinterests' }, {}, 'keyless table: owners insert resent keyless rows as extra occurrences'],
    ['an empty table', { table: 'tuserstags' }, {}, "the owner's unit takes no row of tuserstags in the latest snapshot"],
    [
      'a named table holding only rows of another owner',
      { table: 'tuseraddresses' },
      { tuseraddresses: [addressRow('A2', 'G1', 'tenant-b')] },
      "the owner's unit takes no row of tuseraddresses in the latest snapshot",
    ],
    ['an owner without a keyed table with rows', { owner: 'identity' }, { tusers: [] }, 'owner has no keyed migratable table with rows its units take'],
    [
      'an owner whose units take none of the rows',
      {},
      { tusers: [userRow({ UserID: 'G1', SiteID: 'tenant-b', Type: '1' })], tuseraddresses: [addressRow('A2', 'G1', 'tenant-b')], ttrash: [trashRow('T2', 'contentBean', 'tenant-b')] },
      'owner has no keyed migratable table with rows its units take',
    ],
  ])('fails without sending for %s', async (_label, overrides, rows, reason) => {
    Object.assign(tableRows, rows);
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params(overrides));

    expect(owners.apply).not.toHaveBeenCalled();
    expect(output.assertions).toHaveLength(1);
    expect(output.assertions[0]).toMatchObject({ name: 'second-is-noop', status: 'fail', reason });
  });

  it('fails without sending when no snapshot is ready', async () => {
    vi.mocked(latestSnapshot).mockResolvedValue(null);
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params());

    expect(owners.apply).not.toHaveBeenCalled();
    expect(output.assertions).toStrictEqual([
      { name: 'second-is-noop', status: 'fail', detail: 'no snapshot', reason: 'take S0 and backfill before this fault' },
    ]);
  });
});
