// Unit tests for the duplicate-batch fault script, with fake owners, catalog and snapshot reads.
import { LEGACY_PROGRAM_ID_COLUMN, encodeKey, encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
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
import { createTenantResolver, describeUnitTable, readTargetUnitRows, toUnitRow } from '../../src/reconcile/index.js';
import type { TargetUnitRows, TenantResolver, UnitTableShape } from '../../src/reconcile/index.js';
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
const BLACKOUT_COLUMNS = [...text('blackout_id', 'reason'), { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' } as const];

const unit = (id: string, owner: DataOwner, legacyTables: string[]): Unit => ({ id, owner, schema: id.split('.')[0] ?? '', legacyTables });
const target = (unitId: string, owner: DataOwner, keyColumns: string[]): LegacyTableTarget => ({
  unit: unitId,
  owner,
  rowPredicate: null,
  keyColumns,
  ownedColumns: 'whole-table',
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
  unit('identity.user_account', 'identity', ['tusers']),
  unit('timesheets.blackout', 'timesheets', ['Program_N.blackout']),
];

const TARGETS: Record<string, LegacyTableTarget[]> = {
  tusers: [target('identity.user_account', 'identity', ['UserID']), target('people.person', 'people', ['UserID'])],
  tusersinterests: [target('people.user_interest', 'people', [])],
  tuserstags: [target('people.user_tag', 'people', ['UserID', 'tag'])],
  'program_n.blackout': [target('timesheets.blackout', 'timesheets', ['blackout_id'])],
  tcontent: [target('content.content', 'strategies-content', ['ContentID'])],
};

/** Snapshot tables; `tclassextendattributes` is absent, as from a database without it. */
const LIVE: MigratableTable[] = [
  migratable('tusers', ['identity', 'people'], ['UserID']),
  migratable('tusersinterests', ['people'], []),
  migratable('tuserstags', ['people'], ['UserID', 'tag']),
  migratable('Program_N.blackout', ['timesheets'], ['blackout_id'], [1, 2]),
  migratable('tcontent', ['strategies-content'], ['ContentID']),
];

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
}

function userRow({ UserID, SiteID }: UserRow): CanonicalRow {
  const row = { UserID, SiteID, Type: '2', Fname: `F-${UserID}` };
  return { table: 'tusers', key: encodeKey(USER_COLUMNS, ['UserID'], row), keyValues: [UserID], encoding: encodeRow(USER_COLUMNS, row), row };
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
  folded: false,
};

/** Owner rows per table in the stream mock, and how many rows each stream yielded before it was closed. */
let tableRows: Record<string, CanonicalRow[]>;
let streamed: Record<string, { yielded: number; closed: boolean }>;
/** Target rows the export mock answers; `exportsSeen` counts the exports, so a test can change what later exports return. */
let targetRows: (exportIndex: number) => Record<string, string | null>[];
let exportsSeen: number;

function fakeOwners(options: { dedupe?: boolean; collide?: boolean } = {}) {
  const { dedupe = true, collide = false } = options;
  const seen = new Set<string>();
  const apply = vi.fn<OwnersClient['apply']>((owner, req) => {
    const duplicate = collide || (dedupe && seen.has(req.batchId));
    seen.add(req.batchId);
    const result: ApplyResult = duplicate
      ? { batchId: req.batchId, duplicate: true, applied: 0, skipped: 0, writePositions: new Map() }
      : { batchId: req.batchId, duplicate: false, applied: req.rows.length, skipped: 0, writePositions: new Map([[owner, String(100 + seen.size)]]) };
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
  tableRows = {
    tusers: [
      userRow({ UserID: 'U1', SiteID: 'tenant-a' }),
      userRow({ UserID: 'U2', SiteID: 'tenant-a' }),
      userRow({ UserID: 'U3', SiteID: 'tenant-b' }),
      userRow({ UserID: 'U4', SiteID: 'tenant-a' }),
      userRow({ UserID: 'U5', SiteID: 'tenant-a' }),
    ],
    tusersinterests: [userRow({ UserID: 'U1', SiteID: 'tenant-a' })],
    tuserstags: [],
    'Program_N.blackout': [blackoutRow('B1', 2), blackoutRow('B2', 1), blackoutRow('B3', 2)],
  };
  streamed = {};
  targetRows = () => [{ UserID: 'U1', Fname: 'F-U1' }];
  exportsSeen = 0;

  vi.mocked(latestSnapshot).mockResolvedValue(SNAPSHOT);
  vi.mocked(migratableTables).mockReturnValue(LIVE);
  vi.mocked(describeLegacyTable).mockImplementation((_deps, { table }) => {
    const name = typeof table === 'string' ? table : table.name;
    if (name === 'tusersinterests') return Promise.resolve(legacyShape(name, text('UserID', 'interestID'), false));
    return Promise.resolve(name.startsWith('Program_') ? legacyShape(name, BLACKOUT_COLUMNS, true) : legacyShape(name, USER_COLUMNS, true));
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
  vi.mocked(describeUnitTable).mockImplementation((_deps, options) => Promise.resolve({ ...PERSON_SHAPE, unit: options.unit, legacyTable: options.legacyTable }));
  vi.mocked(readTargetUnitRows).mockImplementation((_deps, shape) => {
    const rows = targetRows(exportsSeen).map((values) => toUnitRow(shape, values));
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

  it("resends the owner's first keyed table with rows under one batch id and passes when the repeat is a no-op", async () => {
    const owners = fakeOwners();
    const output = await duplicateBatch.run(envWith(owners), params({ rows: 4 }));

    // tusersinterests is keyless and tuserstags empty, so tusers is chosen; its stream closed after four rows.
    expect(streamed.tusersinterests).toBeUndefined();
    expect(streamed.tusers).toStrictEqual({ yielded: 4, closed: true });
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
      tenantId: TENANT_A,
      columns: USER_COLUMNS,
      units: ['people.person'],
      rows: [rows[0], rows[1], rows[3]].map((row) => ({ op: 'upsert', row: row?.encoding })),
    });
    expect(request).not.toHaveProperty('watermark');
    expect(vi.mocked(currentAuthority)).toHaveBeenCalledWith({ gateway: expect.anything(), config: loadConfig().paths });

    expect(output.assertions.map((assertion) => [assertion.name, assertion.status])).toStrictEqual([
      ['first-applied', 'pass'],
      ['second-is-noop', 'pass'],
    ]);
    expect(output.assertions[0]?.detail).toStrictEqual({ batchId: BATCH_ID, applied: 3, skipped: 0 });
    expect(output.assertions[1]?.detail).toMatchObject({
      batchId: BATCH_ID,
      owner: 'people',
      table: 'tusers',
      tenantId: TENANT_A,
      rows: 3,
      position: { before: '201', after: '202' },
    });
    expect(output.details).toStrictEqual({
      owner: 'people',
      table: 'tusers',
      unit: 'people.person',
      units: ['people.person'],
      snapshotSeq: 3,
      tenantId: TENANT_A,
      batchId: BATCH_ID,
      rows: 3,
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

  it('fails first-applied when the fresh batch id already collided', async () => {
    const output = await duplicateBatch.run(envWith(fakeOwners({ collide: true })), params());
    expect(output.assertions[0]).toStrictEqual({
      name: 'first-applied',
      status: 'fail',
      detail: { batchId: BATCH_ID, owner: 'people', table: 'tusers', tenantId: TENANT_A },
      reason: 'batch id collided',
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

  it.each<[string, Partial<DuplicateBatchParams>, string]>([
    ['an unknown owner', { owner: 'gateway' }, 'unknown data owner'],
    ['a table outside the snapshot', { table: 'tclassextendattributes' }, 'not a migratable table of the latest snapshot'],
    ['a table of another owner', { table: 'tcontent' }, 'table is not owned by people'],
    ['a keyless table', { table: 'tusersinterests' }, 'keyless table: owners insert resent keyless rows as extra occurrences'],
    ['an empty table', { table: 'tuserstags' }, 'table has no rows in the latest snapshot'],
    ['an owner without a keyed table with rows', { owner: 'identity' }, 'owner has no keyed migratable table with rows in the latest snapshot'],
  ])('fails without sending for %s', async (_label, overrides, reason) => {
    if (overrides.owner === 'identity') tableRows.tusers = [];
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
