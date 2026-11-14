// Unit tests for the backfill: per-owner split routing with discriminators, the deferred-column patch pass after every load, watermarks and batch ids.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import { LEGACY_PROGRAM_ID_COLUMN, encodeRow, formatCanonicalTimestamp } from '@opt2/platform/migration-kit';
import type { ApplyRequest, CanonicalColumn, WatermarkRecord } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, TENANT_LIST, TENANT_UMBRELLA, businessClock } from '@opt2/platform/testing';
import type { ConnectionPool } from 'mssql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackfillAuthorityError, runBackfill } from '../../src/apply/backfill.js';
import type { BackfillContext, BackfillResult } from '../../src/apply/backfill.js';
import { batchIdFor } from '../../src/apply/batch.js';
import type { ApplyChange, BatchDirection, TenantResolver } from '../../src/apply/batch.js';
import { loadConfig } from '../../src/config.js';
import { currentAuthority } from '../../src/cutover/index.js';
import { compareCanonicalRows, describeLegacyTable, listLegacyTables, streamLegacyTable } from '../../src/extract/index.js';
import type { CanonicalRow, LegacyTableRef } from '../../src/extract/index.js';
import { FileStoreUnsupportedError, transferFiles } from '../../src/files/index.js';
import type { TransferResult } from '../../src/files/index.js';
import { computeDependencyOrder } from '../../src/order/index.js';
import type { DeferredColumn } from '../../src/order/index.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import type { DataOwner, LegacyTableTarget, OwnersClient, UnitCatalog } from '../../src/owners/index.js';
import {
  buildReport,
  createTenantResolver,
  createUnitRowFilter,
  reconcileUnits,
  reportTargetFor,
  resolvePoint,
  toUnitRow,
  writeReconciliationReport,
} from '../../src/reconcile/index.js';
import type { ReconcileResult, UnitTableShape } from '../../src/reconcile/index.js';
import { SnapshotError, requireSnapshot } from '../../src/snapshot/index.js';
import type { SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/extract/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/extract/index.js')>()),
  listLegacyTables: vi.fn(),
  describeLegacyTable: vi.fn(),
  streamLegacyTable: vi.fn(),
}));

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  requireSnapshot: vi.fn(),
}));

vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  createTenantResolver: vi.fn(),
  createUnitRowFilter: vi.fn(),
  reconcileUnits: vi.fn(),
  reportTargetFor: vi.fn(),
  writeReconciliationReport: vi.fn(),
}));

vi.mock('../../src/cutover/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cutover/index.js')>()),
  currentAuthority: vi.fn(),
}));

vi.mock('../../src/files/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/files/index.js')>()),
  transferFiles: vi.fn(),
}));

vi.mock('../../src/order/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/order/index.js')>()),
  computeDependencyOrder: vi.fn(),
}));

type Row = Record<string, string | null>;

interface TableSpec {
  readonly columns: readonly CanonicalColumn[];
  readonly keyColumns: readonly string[];
  readonly programIds?: readonly number[];
}

interface StoredTable {
  readonly spec: TableSpec;
  readonly rows: readonly Row[];
}

const text = (...names: string[]): CanonicalColumn[] => names.map((name) => ({ name, type: 's' }));

const SPECS = {
  tusers: { columns: text('UserID', 'SiteID', 'Type', 'UserName', 'Fname'), keyColumns: ['UserID'] },
  tuseraddresses: { columns: text('addressID', 'userID', 'siteID', 'addressName'), keyColumns: ['addressID'] },
  tuserstags: { columns: text('userID', 'siteid', 'tag'), keyColumns: [] },
  ttrash: { columns: text('objectID', 'siteID', 'objectClass', 'objectLabel'), keyColumns: ['objectID'] },
  tcontent: { columns: text('ContentID', 'SiteID', 'FileID', 'Title'), keyColumns: ['ContentID'] },
  tfiles: { columns: text('fileID', 'siteID', 'filename'), keyColumns: ['fileID'] },
  temailstats: { columns: text('EmailID', 'Email', 'sent'), keyColumns: [] },
  'Program_N.blackout': {
    columns: [...text('blackout_id', 'reason'), { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' }],
    keyColumns: ['blackout_id', LEGACY_PROGRAM_ID_COLUMN],
    programIds: [1, 2],
  },
} satisfies Record<string, TableSpec>;

type TableName = keyof typeof SPECS;
type Tables = Partial<Record<TableName, readonly Row[]>>;

/** The parts of `opt2/table-ownership.json` the unit catalog reads. */
interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'explicit' | 'whole-table';
  ownedColumns?: string[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: {
    table: string;
    owner: string;
    primaryKey: string[];
    siteIdColumn?: string;
    tenantResolution?: string;
    programFold?: boolean;
    targets: OwnershipTarget[];
  }[];
}

const explicit = (unit: string, owner: string, rowPredicate: string, keyColumns: string[], ownedColumns: string[]): OwnershipTarget => ({
  unit,
  owner,
  rowPredicate,
  keyColumns,
  columnPolicy: 'explicit',
  ownedColumns,
});

const whole = (unit: string, owner: string, keyColumns: string[], rowPredicate: string | null = null): OwnershipTarget => ({
  unit,
  owner,
  rowPredicate,
  keyColumns,
  columnPolicy: 'whole-table',
});

const splitTable = (table: string, primaryKey: string[], siteIdColumn: string, targets: OwnershipTarget[]): Ownership['tables'][number] => ({
  table,
  owner: 'split',
  primaryKey,
  siteIdColumn,
  tenantResolution: 'siteID-or-umbrella',
  targets,
});

const unitsOf = (table: string, units: [string, string][]): Ownership['units'] => units.map(([unit, owner]) => ({ unit, owner, legacyTables: [table] }));

const OWNERSHIP: Ownership = {
  units: [
    ...unitsOf('tusers', [
      ['identity.group_account', 'identity'],
      ['identity.user_account', 'identity'],
      ['people.person', 'people'],
    ]),
    ...unitsOf('tuseraddresses', [
      ['identity.user_address', 'identity'],
      ['people.user_address', 'people'],
    ]),
    ...unitsOf('tuserstags', [
      ['identity.user_tag', 'identity'],
      ['people.user_tag', 'people'],
    ]),
    ...unitsOf('ttrash', [
      ['content.trash', 'strategies-content'],
      ['identity.trash', 'identity'],
      ['people.trash', 'people'],
    ]),
    ...unitsOf('tcontent', [['content.content', 'strategies-content']]),
    ...unitsOf('tfiles', [['content.file', 'strategies-content']]),
    ...unitsOf('temailstats', [['communications.email_stat', 'communications']]),
    ...unitsOf('Program_N.blackout', [['timesheets.blackout', 'timesheets']]),
  ],
  tables: [
    splitTable('tusers', ['UserID'], 'SiteID', [
      explicit('identity.group_account', 'identity', 'Type = 1', ['UserID'], ['UserID', 'SiteID', 'Type', 'UserName', 'Fname']),
      explicit('identity.user_account', 'identity', 'Type = 2', ['UserID'], ['UserID', 'UserName', 'Type', 'SiteID']),
      explicit('people.person', 'people', 'Type = 2', ['UserID', 'SiteID'], ['Fname']),
    ]),
    splitTable('tuseraddresses', ['addressID'], 'siteID', [
      whole('identity.user_address', 'identity', ['addressID'], 'owner Type = 1'),
      whole('people.user_address', 'people', ['addressID'], 'owner Type = 2'),
    ]),
    splitTable('tuserstags', [], 'siteid', [
      whole('identity.user_tag', 'identity', [], 'owner Type = 1'),
      whole('people.user_tag', 'people', [], 'owner Type = 2'),
    ]),
    splitTable('ttrash', ['objectID'], 'siteID', [
      whole('content.trash', 'strategies-content', ['objectID'], 'classMap owner = strategies-content'),
      whole('identity.trash', 'identity', ['objectID'], 'classMap owner = identity'),
      whole('people.trash', 'people', ['objectID'], 'classMap owner = people'),
    ]),
    {
      table: 'tcontent',
      owner: 'strategies-content',
      primaryKey: ['ContentID'],
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      targets: [whole('content.content', 'strategies-content', ['ContentID'])],
    },
    {
      table: 'tfiles',
      owner: 'strategies-content',
      primaryKey: ['fileID'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID-or-umbrella',
      targets: [whole('content.file', 'strategies-content', ['fileID'])],
    },
    { table: 'temailstats', owner: 'communications', primaryKey: [], targets: [whole('communications.email_stat', 'communications', [])] },
    {
      table: 'Program_N.blackout',
      owner: 'timesheets',
      primaryKey: ['blackout_id'],
      programFold: true,
      targets: [whole('timesheets.blackout', 'timesheets', ['blackout_id'])],
    },
  ],
};

/** OWNERSHIP with two communications targets taking every `temailstats` row under different class-map owners. */
function withEmailStatsByClass(): Ownership {
  const ownership = structuredClone(OWNERSHIP);
  ownership.units.push({ unit: 'communications.email_stat_alt', owner: 'communications', legacyTables: ['temailstats'] });
  const stats = ownership.tables.find((table) => table.table === 'temailstats');
  if (stats === undefined) throw new Error('OWNERSHIP has no temailstats entry');
  stats.targets = [
    whole('communications.email_stat', 'communications', [], 'classMap owner = a'),
    whole('communications.email_stat_alt', 'communications', [], 'classMap owner = b'),
  ];
  return ownership;
}

/** Owner of each trash `objectClass` the fixture rows use; an unlisted class has no owner. */
const CLASS_OWNERS: Readonly<Record<string, string>> = { content: 'strategies-content', group: 'identity', user: 'people' };

const SNAPSHOT_DB = 'snap_0';
const CLOCK = businessClock();
const FINISHED_AT = formatCanonicalTimestamp(CLOCK.now());
const TENANT_A_ID = TENANT_A.tenantId;
const TENANT_B_ID = TENANT_B.tenantId;
const UMBRELLA_ID = TENANT_UMBRELLA.tenantId;
const SITE_TENANTS = TENANT_LIST.map((fixture) => fixture.tenantId).sort();
const CONFIG: BackfillContext['config'] = { ...loadConfig(), backfill: { batchRows: 2 } };
const REPORT_TARGET = { reportsDir: '/reports', sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f' };

const user = (id: string, site: string, type: '1' | '2'): Row => ({ UserID: id, SiteID: site, Type: type, UserName: id.toLowerCase(), Fname: `First ${id}` });
const address = (id: string, userId: string, site: string): Row => ({ addressID: id, userID: userId, siteID: site, addressName: `Home of ${userId}` });
const tag = (userId: string, site: string, value: string): Row => ({ userID: userId, siteid: site, tag: value });
const trash = (id: string, site: string, objectClass: string): Row => ({ objectID: id, siteID: site, objectClass, objectLabel: `Deleted ${id}` });
const content = (id: string, site: string, fileId: string | null): Row => ({ ContentID: id, SiteID: site, FileID: fileId, Title: `Title ${id}` });
const file = (id: string, site: string): Row => ({ fileID: id, siteID: site, filename: `${id}.pdf` });
const stat = (id: string, email: string): Row => ({ EmailID: id, Email: email, sent: '1' });
const blackout = (id: string, programId: number): Row => ({ blackout_id: id, reason: 'leave', [LEGACY_PROGRAM_ID_COLUMN]: String(programId) });

/** Users the split child rows belong to: one group and two users. */
const USERS = [user('G1', 'tenant-a', '1'), user('U1', 'tenant-a', '2'), user('U2', 'tenant-b', '2')];

interface World {
  readonly tables: Map<string, StoredTable>;
  readonly applies: { owner: DataOwner; request: ApplyRequest }[];
  readonly puts: { owner: DataOwner; record: WatermarkRecord }[];
  readonly targetUnits: Set<string>;
  snapshot: SnapshotRecord;
  order: readonly string[];
  deferred: readonly DeferredColumn[];
  reconcileResult: ReconcileResult;
}

function snapshotRecord(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    seq: 0,
    kind: 'seed',
    state: 'ready',
    databaseName: SNAPSHOT_DB,
    backupPath: '/backups/snap-0.bak',
    checkpointLsn: '1000',
    lastLsn: '1000',
    takenAt: CLOCK.now(),
    transitionId: null,
    sourceSha: REPORT_TARGET.sourceSha,
    manifestComplete: true,
    fileStore: { status: 'ok', objects: 0 },
    ...overrides,
  };
}

function createWorld(): World {
  return {
    tables: new Map(),
    applies: [],
    puts: [],
    targetUnits: new Set(),
    snapshot: snapshotRecord(),
    order: [],
    deferred: [],
    reconcileResult: 'zero-difference',
  };
}

let world: World = createWorld();
let dir = '';
let baseCatalog: UnitCatalog;
let catalog: UnitCatalog;

const info = vi.fn();
const warn = vi.fn();
const logger = { info, warn } as unknown as Logger;

const lower = (name: string): string => name.toLowerCase();

const owners: Pick<OwnersClient, 'apply' | 'putWatermark'> = {
  apply(owner, request) {
    world.applies.push({ owner, request });
    return Promise.resolve({ batchId: request.batchId, duplicate: false, applied: request.rows.length, skipped: 0, writePositions: new Map() });
  },
  putWatermark(owner, record) {
    const stored: WatermarkRecord = {
      legacyTable: record.legacyTable,
      direction: record.direction,
      snapshotSeq: record.snapshotSeq ?? null,
      backupLsn: record.backupLsn ?? null,
      finishedAt: record.finishedAt,
    };
    world.puts.push({ owner, record: stored });
    return Promise.resolve(stored);
  },
};

const SITE_TENANT = new Map(TENANT_LIST.map((fixture) => [fixture.siteId, fixture.tenantId]));

/** Rows of a known site go to its tenant; rows without one, or of a site the snapshot lacks, are umbrella orphans. */
const resolver: TenantResolver = {
  resolve(_table, row) {
    const site = Object.entries(row).find(([column]) => lower(column) === 'siteid')?.[1];
    const tenantId = typeof site === 'string' ? SITE_TENANT.get(lower(site)) : undefined;
    return tenantId === undefined ? { tenantId: UMBRELLA_ID, orphan: true } : { tenantId, orphan: false };
  },
  siteTenants: () => [...SITE_TENANTS],
};

function contextFor(): BackfillContext {
  const pool = (database: string): ConnectionPool => ({ config: { database } }) as unknown as ConnectionPool;
  const legacy = { database: (name: string) => Promise.resolve(pool(name)) };
  return {
    env: {} as BackfillContext['env'],
    config: CONFIG,
    clock: CLOCK,
    logger,
    db: {} as BackfillContext['db'],
    legacy: legacy as unknown as BackfillContext['legacy'],
    bridge: {} as BackfillContext['bridge'],
    catalog,
    owners: owners as OwnersClient,
    gateway: {} as BackfillContext['gateway'],
  };
}

/** Stores `tables` as the snapshot database's contents. */
function seed(tables: Tables): void {
  for (const [name, rows] of Object.entries(tables)) world.tables.set(name, { spec: SPECS[name as TableName], rows: rows ?? [] });
}

function tableIn(database: string, name: string): StoredTable {
  const stored = database === SNAPSHOT_DB ? world.tables.get(name) : undefined;
  if (stored === undefined) throw new Error(`fake legacy: ${database} has no ${name}`);
  return stored;
}

function valueOf(row: Row, column: string): string | null {
  const name = Object.keys(row).find((candidate) => lower(candidate) === lower(column));
  return name === undefined ? null : (row[name] ?? null);
}

function project(columns: readonly CanonicalColumn[], row: Row): Row {
  return Object.fromEntries(columns.map((column) => [column.name, valueOf(row, column.name)]));
}

function canonicalRow(shape: Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns' | 'folded'>, row: Row): CanonicalRow {
  const programId = valueOf(row, LEGACY_PROGRAM_ID_COLUMN);
  return toUnitRow(shape, project(shape.columns, row), shape.folded && programId !== null ? Number(programId) : undefined);
}

function tableRows(database: string, name: string): CanonicalRow[] {
  const { spec, rows } = tableIn(database, name);
  const shape = { legacyTable: name, keyed: spec.keyColumns.length > 0, keyColumns: [...spec.keyColumns], columns: [...spec.columns], folded: spec.programIds !== undefined };
  return rows.map((row) => canonicalRow(shape, row)).sort(compareCanonicalRows);
}

function refsOf(name: string, spec: TableSpec): LegacyTableRef[] {
  if (spec.programIds === undefined) return [{ schema: 'dbo', table: name, qualified: name }];
  const table = name.slice(name.indexOf('.') + 1);
  return spec.programIds.map((id) => ({ schema: `Program_${String(id)}`, table, qualified: `Program_${String(id)}.${table}` }));
}

function targetOf(unit: string, legacyTable: string): LegacyTableTarget {
  const target = catalog.unitsForLegacyTable(legacyTable).find((candidate) => candidate.unit === unit);
  if (target === undefined) throw new Error(`fake legacy: ${unit} takes no rows of ${legacyTable}`);
  return target;
}

/**
 * Row selection of the fixture predicates: a column literal, the owning user's `Type` through `userID`, or the class map on
 * `objectClass`; a class map takes every row of a table without `objectClass`.
 */
function takes(database: string, predicate: string | null, row: Row): boolean {
  if (predicate === null) return true;
  const classOwner = /^classMap owner = (\S+)$/.exec(predicate)?.[1];
  if (classOwner !== undefined) {
    const objectClass = valueOf(row, 'objectClass');
    return objectClass === null || CLASS_OWNERS[objectClass] === classOwner;
  }
  const match = /^(owner )?(\w+) = (\d+)$/.exec(predicate);
  if (match === null) throw new Error(`fake legacy: unsupported predicate ${predicate}`);
  const column = match[2] ?? '';
  const literal = match[3] ?? '';
  if (match[1] === undefined) return valueOf(row, column) === literal;
  const ownerRow = tableIn(database, 'tusers').rows.find((candidate) => candidate.UserID === valueOf(row, 'userID'));
  return ownerRow !== undefined && valueOf(ownerRow, column) === literal;
}

function installFakes(): void {
  vi.mocked(currentAuthority).mockImplementation(() => {
    const targetUnits = new Set([...world.targetUnits].sort());
    return Promise.resolve({
      tableVersion: 'v0001',
      epoch: 1,
      units: new Map(),
      targetUnits,
      isTargetAuthoritative: (unit: string) => targetUnits.has(unit),
      anyTarget: targetUnits.size > 0,
    });
  });
  vi.mocked(requireSnapshot).mockImplementation(() => Promise.resolve(world.snapshot));
  vi.mocked(listLegacyTables).mockImplementation((pool) => {
    if (pool.config?.database !== SNAPSHOT_DB) throw new Error('fake legacy: the backfill lists only the snapshot database');
    return Promise.resolve([...world.tables].flatMap(([name, stored]) => refsOf(name, stored.spec)));
  });
  vi.mocked(describeLegacyTable).mockImplementation((_deps, options) => {
    const name = typeof options.table === 'string' ? options.table : options.table.name;
    const { spec } = tableIn(options.database ?? '', name);
    return Promise.resolve({ table: name, folded: spec.programIds !== undefined, keyed: spec.keyColumns.length > 0, keyColumns: spec.keyColumns, columns: spec.columns, parts: [] });
  });
  vi.mocked(streamLegacyTable).mockImplementation(async function* (_deps, options): AsyncGenerator<CanonicalRow, void, undefined> {
    const name = typeof options.table === 'string' ? options.table : options.table.name;
    yield* tableRows(options.database ?? '', name);
  });
  vi.mocked(computeDependencyOrder).mockImplementation(() =>
    Promise.resolve({ order: world.order, entries: [], deferred: world.deferred, relaxed: [], cycles: [], parentOf: () => null }),
  );
  vi.mocked(createTenantResolver).mockImplementation(() => Promise.resolve(resolver));
  vi.mocked(createUnitRowFilter).mockImplementation((_deps, options) => {
    const { rowPredicate } = targetOf(options.unit, options.legacyTable);
    return Promise.resolve({ prepare: () => Promise.resolve(), accepts: (row) => Promise.resolve(takes(options.database, rowPredicate, row as Row)) });
  });
  vi.mocked(reconcileUnits).mockImplementation((ctx, options) =>
    Promise.resolve({
      ...buildReport({
        point: resolvePoint(ctx.config, options.point),
        tableVersion: 'v0001',
        snapshotSeq: options.snapshotSeq ?? null,
        legacyDatabase: options.database,
        units: [],
        fileStore: { store: 'fileDir', status: 'compared', haltedUnits: [] },
      }),
      result: world.reconcileResult,
    }),
  );
  vi.mocked(reportTargetFor).mockReturnValue(REPORT_TARGET);
  vi.mocked(writeReconciliationReport).mockImplementation((_ctx, report) => Promise.resolve(`/reports/reconciliation/${report.point}.json`));
  vi.mocked(transferFiles).mockImplementation((_ctx, snapshotSeq) =>
    Promise.resolve({ snapshotSeq, transferred: 0, unchanged: 0, bytes: 0, orphans: [], misplaced: [] }),
  );
}

async function catalogFrom(ownership: Ownership): Promise<UnitCatalog> {
  const target = path.join(dir, `${randomUUID()}.json`);
  await writeFile(target, JSON.stringify(ownership));
  return loadUnitCatalog(target);
}

function encode(table: TableName, row: Row): string {
  return encodeRow(SPECS[table].columns, row);
}

function forward(legacyTable: string): WatermarkRecord {
  return { legacyTable, direction: 'forward', snapshotSeq: 0, backupLsn: '1000', finishedAt: FINISHED_AT };
}

const CARRIED = { direction: 'forward', snapshotSeq: 0, backupLsn: '1000', finishedAt: FINISHED_AT };

/** The pass a request belongs to, recovered from its deterministic batch id. */
function directionOf(request: ApplyRequest): BatchDirection {
  for (const direction of ['backfill', 'backfill-patch'] as const) {
    for (let ordinal = 0; ordinal < 10; ordinal++) {
      const id = batchIdFor({ direction, snapshotSeq: 0, legacyTable: request.legacyTable, tenantId: request.tenantId ?? '', ordinal });
      if (id === request.batchId) return direction;
    }
  }
  throw new Error(`batch ${request.batchId} is neither a backfill nor a patch batch`);
}

function requests(owner: DataOwner, table: string, direction: BatchDirection = 'backfill'): ApplyRequest[] {
  return world.applies
    .filter((apply) => apply.owner === owner && apply.request.legacyTable === table && directionOf(apply.request) === direction)
    .map((apply) => apply.request);
}

/** Changes one owner received for one table and pass, per tenant id. */
function sentRows(owner: DataOwner, table: string, direction: BatchDirection = 'backfill'): Record<string, ApplyChange[]> {
  const byTenant: Record<string, ApplyChange[]> = {};
  for (const request of requests(owner, table, direction)) {
    const tenantId = request.tenantId ?? '';
    byTenant[tenantId] = [...(byTenant[tenantId] ?? []), ...request.rows];
  }
  return byTenant;
}

function tableResult(result: BackfillResult, table: string): BackfillResult['tables'][number] | undefined {
  return result.tables.find((candidate) => candidate.table === table);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'apply-backfill-'));
  baseCatalog = await catalogFrom(OWNERSHIP);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  world = createWorld();
  catalog = baseCatalog;
  installFakes();
});

describe('runBackfill split routing', () => {
  const tables: Tables = {
    tusers: USERS,
    tuseraddresses: [address('A1', 'G1', 'tenant-a'), address('A2', 'U1', 'tenant-a'), address('A3', 'U2', 'gone')],
    ttrash: [trash('T1', 'tenant-a', 'content'), trash('T2', 'tenant-a', 'user'), trash('T3', 'tenant-b', 'group'), trash('T4', 'tenant-a', 'plugin')],
  };
  const [g1, u1, u2] = USERS.map((row) => encode('tusers', row));

  it.each([
    {
      name: 'a group address to identity with owner Type 1',
      owner: 'identity' as const,
      table: 'tuseraddresses',
      sent: { [TENANT_A_ID]: [{ op: 'upsert', row: encode('tuseraddresses', address('A1', 'G1', 'tenant-a')), discriminator: 1 }] },
    },
    {
      name: 'user addresses, orphans included, to people with owner Type 2',
      owner: 'people' as const,
      table: 'tuseraddresses',
      sent: {
        [TENANT_A_ID]: [{ op: 'upsert', row: encode('tuseraddresses', address('A2', 'U1', 'tenant-a')), discriminator: 2 }],
        [UMBRELLA_ID]: [{ op: 'upsert', row: encode('tuseraddresses', address('A3', 'U2', 'gone')), discriminator: 2 }],
      },
    },
    {
      name: 'content trash to strategies-content under its class-map owner',
      owner: 'strategies-content' as const,
      table: 'ttrash',
      sent: { [TENANT_A_ID]: [{ op: 'upsert', row: encode('ttrash', trash('T1', 'tenant-a', 'content')), discriminator: 'strategies-content' }] },
    },
    {
      name: 'group trash to identity under its class-map owner',
      owner: 'identity' as const,
      table: 'ttrash',
      sent: { [TENANT_B_ID]: [{ op: 'upsert', row: encode('ttrash', trash('T3', 'tenant-b', 'group')), discriminator: 'identity' }] },
    },
    {
      name: 'user trash to people under its class-map owner',
      owner: 'people' as const,
      table: 'ttrash',
      sent: { [TENANT_A_ID]: [{ op: 'upsert', row: encode('ttrash', trash('T2', 'tenant-a', 'user')), discriminator: 'people' }] },
    },
    {
      name: 'groups and users to identity without a discriminator, the split column riding in the row',
      owner: 'identity' as const,
      table: 'tusers',
      sent: {
        [TENANT_A_ID]: [
          { op: 'upsert', row: g1 },
          { op: 'upsert', row: u1 },
        ],
        [TENANT_B_ID]: [{ op: 'upsert', row: u2 }],
      },
    },
    {
      name: 'only users to people without a discriminator',
      owner: 'people' as const,
      table: 'tusers',
      sent: { [TENANT_A_ID]: [{ op: 'upsert', row: u1 }], [TENANT_B_ID]: [{ op: 'upsert', row: u2 }] },
    },
  ])('sends $name', async ({ owner, table, sent }) => {
    world.order = ['tusers', 'tuseraddresses', 'ttrash'];
    seed(tables);

    await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(sentRows(owner, table)).toEqual(sent);
  });

  it('counts every row and orphan of a split table, and stores the watermark of an owner that took no row', async () => {
    world.order = ['ttrash', 'tuseraddresses', 'tusers'];
    seed({ ...tables, ttrash: [trash('T1', 'tenant-a', 'content'), trash('T4', 'tenant-a', 'plugin')] });

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(tableResult(result, 'tuseraddresses')).toMatchObject({ rows: 3, orphans: 1, owners: ['identity', 'people'] });
    expect(tableResult(result, 'ttrash')?.perOwner.map(({ owner, changes, watermark }) => [owner, changes, watermark])).toEqual([
      ['identity', 0, 'putWatermark'],
      ['people', 0, 'putWatermark'],
      ['strategies-content', 1, 'batch'],
    ]);
    expect(world.applies.filter(({ request }) => request.legacyTable === 'ttrash').map(({ owner }) => owner)).toEqual(['strategies-content']);
    expect(world.puts).toEqual([
      { owner: 'identity', record: forward('ttrash') },
      { owner: 'people', record: forward('ttrash') },
    ]);
  });

  it('refuses a keyless row that one owner takes under two discriminators', async () => {
    catalog = await catalogFrom(withEmailStatsByClass());
    world.order = ['temailstats'];
    seed({ temailstats: [stat('E1', 'one@example.test')] });

    await expect(runBackfill(contextFor(), { snapshotSeq: 0 })).rejects.toThrow(
      'a keyless temailstats row is taken by communications targets with different discriminators',
    );
    expect(world.applies).toEqual([]);
  });

  it('names the backfill in the error for a row predicate it cannot read', async () => {
    const ownership = structuredClone(OWNERSHIP);
    const addresses = ownership.tables.find((table) => table.table === 'tuseraddresses');
    if (addresses?.targets[1] === undefined) throw new Error('OWNERSHIP has no people address target');
    addresses.targets[1].rowPredicate = 'owner Type > 1';
    catalog = await catalogFrom(ownership);
    world.order = ['tuseraddresses'];
    seed({ tusers: USERS, tuseraddresses: [] });

    await expect(runBackfill(contextFor(), { snapshotSeq: 0 })).rejects.toThrow('row predicate "owner Type > 1" has a form the backfill cannot read');
  });
});

describe('runBackfill deferred columns', () => {
  it.each([
    {
      keying: 'a keyed',
      table: 'tuseraddresses' as const,
      rows: [address('A1', 'G1', 'tenant-a'), address('A2', 'U1', 'tenant-a')],
      load: (row: Row): ApplyChange[] => [{ op: 'upsert', row: encode('tuseraddresses', { ...row, userID: null }) }],
      patch: (row: Row): ApplyChange[] => [{ op: 'upsert', row: encode('tuseraddresses', row) }],
    },
    {
      keying: 'a keyless',
      table: 'tuserstags' as const,
      rows: [tag('G1', 'tenant-a', 'board'), tag('U1', 'tenant-a', 'staff')],
      load: (row: Row): ApplyChange[] => [{ op: 'insert', row: encode('tuserstags', { ...row, userID: null }) }],
      patch: (row: Row): ApplyChange[] => [
        { op: 'delete', row: encode('tuserstags', { ...row, userID: null }) },
        { op: 'insert', row: encode('tuserstags', row) },
      ],
    },
  ])("routes $keying split table's nulled load and its patch to the owner of the real row under one discriminator", async ({ table, rows, load, patch }) => {
    world.order = ['tusers', table];
    world.deferred = [{ table, column: 'userID', references: { table: 'tusers', column: 'UserID' }, relationId: `rel:${table}.userID->tusers.UserID` }];
    seed({ tusers: USERS, [table]: rows });
    const [group, member] = rows as [Row, Row];
    const tagged = (changes: ApplyChange[], discriminator: number): ApplyChange[] => changes.map((change) => ({ ...change, discriminator }));

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(sentRows('identity', table)).toEqual({ [TENANT_A_ID]: tagged(load(group), 1) });
    expect(sentRows('identity', table, 'backfill-patch')).toEqual({ [TENANT_A_ID]: tagged(patch(group), 1) });
    expect(sentRows('people', table)).toEqual({ [TENANT_A_ID]: tagged(load(member), 2) });
    expect(sentRows('people', table, 'backfill-patch')).toEqual({ [TENANT_A_ID]: tagged(patch(member), 2) });
    expect(tableResult(result, table)).toMatchObject({ rows: 2, deferredColumns: ['userID'], batches: 4 });
  });

  it('patches a deferred back-reference only after every table, its referenced one included, has loaded', async () => {
    world.order = ['tcontent', 'tfiles'];
    world.deferred = [{ table: 'tcontent', column: 'FileID', references: { table: 'tfiles', column: 'fileID' }, relationId: 'rel:tcontent.FileID->tfiles.fileID' }];
    seed({ tcontent: [content('C1', 'tenant-a', 'F1'), content('C2', 'tenant-a', null)], tfiles: [file('F1', 'tenant-a')] });

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(world.applies.map(({ request }) => [request.legacyTable, directionOf(request)])).toEqual([
      ['tcontent', 'backfill'],
      ['tfiles', 'backfill'],
      ['tcontent', 'backfill-patch'],
    ]);
    expect(sentRows('strategies-content', 'tcontent')).toEqual({
      [TENANT_A_ID]: [
        { op: 'upsert', row: encode('tcontent', content('C1', 'tenant-a', null)) },
        { op: 'upsert', row: encode('tcontent', content('C2', 'tenant-a', null)) },
      ],
    });
    expect(sentRows('strategies-content', 'tcontent', 'backfill-patch')).toEqual({
      [TENANT_A_ID]: [{ op: 'upsert', row: encode('tcontent', content('C1', 'tenant-a', 'F1')) }],
    });
    expect(result.order).toEqual(['tcontent', 'tfiles']);
    expect(info.mock.calls.map(([message]) => message)).toEqual([
      'backfill of snapshot 0 applied tfiles: 1 rows, 1 batches, 0 orphans',
      'backfill of snapshot 0 applied tcontent: 2 rows, 2 batches, 0 orphans',
    ]);
  });

  it.each([
    {
      name: 'rides on the last patch batch only',
      fileIds: ['F1', 'F2', 'F3'],
      patchMarks: [undefined, CARRIED],
      watermarks: ['none', 'batch'],
      puts: [],
    },
    {
      name: 'is put alone when no row holds a deferred value',
      fileIds: [null, null, null],
      patchMarks: [],
      watermarks: ['none', 'putWatermark'],
      puts: [{ owner: 'strategies-content', record: forward('tcontent') }],
    },
  ])("keeps a deferred table's load batches without a watermark, which $name", async ({ fileIds, patchMarks, watermarks, puts }) => {
    world.order = ['tcontent', 'tfiles'];
    world.deferred = [{ table: 'tcontent', column: 'FileID', references: { table: 'tfiles', column: 'fileID' }, relationId: 'rel:tcontent.FileID->tfiles.fileID' }];
    seed({ tcontent: fileIds.map((fileId, index) => content(`C${String(index + 1)}`, 'tenant-a', fileId)), tfiles: [] });

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(requests('strategies-content', 'tcontent').map((request) => request.watermark)).toEqual([undefined, undefined]);
    expect(requests('strategies-content', 'tcontent', 'backfill-patch').map((request) => request.watermark)).toEqual(patchMarks);
    expect(tableResult(result, 'tcontent')?.perOwner.map((stats) => stats.watermark)).toEqual(watermarks);
    expect(world.puts.filter(({ record }) => record.legacyTable === 'tcontent')).toEqual(puts);
  });

  it('repeats every batch id, patch batches included, when re-run on the same snapshot', async () => {
    world.order = ['tusers', 'tuseraddresses', 'ttrash', 'tcontent', 'tfiles'];
    world.deferred = [{ table: 'tcontent', column: 'FileID', references: { table: 'tfiles', column: 'fileID' }, relationId: 'rel:tcontent.FileID->tfiles.fileID' }];
    seed({
      tusers: USERS,
      tuseraddresses: [address('A1', 'G1', 'tenant-a'), address('A2', 'U1', 'tenant-a'), address('A3', 'U2', 'tenant-b')],
      ttrash: [trash('T1', 'tenant-a', 'content'), trash('T2', 'tenant-b', 'user')],
      tcontent: [content('C1', 'tenant-a', 'F1'), content('C2', 'tenant-b', 'F2'), content('C3', 'tenant-a', 'F1')],
      tfiles: [file('F1', 'tenant-a'), file('F2', 'tenant-b')],
    });
    await runBackfill(contextFor(), { snapshotSeq: 0 });
    const first = world.applies.map(({ owner, request }) => [owner, request.batchId, request.rows]);
    world.applies.length = 0;

    await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(world.applies.map(({ owner, request }) => [owner, request.batchId, request.rows])).toEqual(first);
    expect(new Set(first.map(([owner, batchId]) => `${String(owner)} ${String(batchId)}`)).size).toBe(first.length);
  });
});

describe('runBackfill run', () => {
  it('loads tables in dependency order, folds Program_<id> parts once and appends tables the order omits by name', async () => {
    world.order = ['Program_2.blackout', 'Program_1.blackout', 'tcontent', 'tmissing'];
    seed({ tfiles: [], tcontent: [], 'Program_N.blackout': [blackout('B1', 1), blackout('B2', 2)] });

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(result.order).toEqual(['Program_N.blackout', 'tcontent', 'tfiles']);
    expect(computeDependencyOrder).toHaveBeenCalledWith({
      inventory: CONFIG.paths.inventory,
      catalog,
      reportsOpts: { target: REPORT_TARGET, clock: CLOCK },
      programIds: [1, 2],
    });
    expect(world.applies.filter(({ owner }) => owner === 'timesheets').map(({ request }) => [request.legacyTable, request.legacyProgramId])).toEqual([
      ['Program_1.blackout', 1],
      ['Program_2.blackout', 2],
    ]);
    expect(world.puts).toContainEqual({ owner: 'timesheets', record: forward('Program_N.blackout') });
  });

  it.each([
    { name: 'a transferred store', snapshot: {}, thrown: null, files: { snapshotSeq: 0, transferred: 0, unchanged: 0, bytes: 0, orphans: [], misplaced: [] } },
    {
      name: 'a store the snapshot recorded unsupported',
      snapshot: { fileStore: { status: 'unsupported', fileStore: 's3', siteId: 'tenant-a' } } satisfies Partial<SnapshotRecord>,
      thrown: null,
      files: { status: 'halted', reason: 'site tenant-a uses file store s3, not fileDir' },
    },
    {
      name: 'a snapshot without a complete manifest',
      snapshot: { manifestComplete: false },
      thrown: null,
      files: { status: 'halted', reason: 'snapshot 0 recorded no file manifest: its legacy file store is not fileDir' },
    },
    {
      name: 'a transfer that meets an unsupported store',
      snapshot: {},
      thrown: new FileStoreUnsupportedError('s3', 'tenant-a'),
      files: { status: 'halted', reason: new FileStoreUnsupportedError('s3', 'tenant-a').message },
    },
  ])('reports the files of $name and exits by the after-backfill reconciliation', async ({ snapshot, thrown, files }) => {
    world.snapshot = snapshotRecord(snapshot);
    world.order = ['tfiles'];
    seed({ tfiles: [file('F1', 'tenant-a')] });
    if (thrown !== null) vi.mocked(transferFiles).mockRejectedValueOnce(thrown);

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(result.files).toEqual(files as TransferResult);
    expect(result).toMatchObject({ exitCode: 0, reconciliation: { point: 'after-backfill', result: 'zero-difference', reportPath: '/reports/reconciliation/after-backfill.json' } });
  });

  it('exits 1 after a difference and reconciles the units of every table plus the file units', async () => {
    world.reconcileResult = 'difference';
    world.order = ['tcontent'];
    seed({ tcontent: [] });

    const result = await runBackfill(contextFor(), { snapshotSeq: 0 });

    expect(result.exitCode).toBe(1);
    expect(reconcileUnits).toHaveBeenCalledWith(expect.anything(), {
      point: 'after-backfill',
      units: ['content.content', 'content.file_object'],
      database: SNAPSHOT_DB,
      snapshotSeq: 0,
    });
  });

  it.each([
    {
      name: 'a snapshot that is not ready',
      prepare: (): void => {
        world.snapshot = snapshotRecord({ state: 'failed' });
      },
      error: SnapshotError,
      message: 'Snapshot 0 is failed, not ready',
    },
    {
      name: 'a target-authoritative unit',
      prepare: (): void => {
        world.targetUnits.add('content.content');
      },
      error: BackfillAuthorityError,
      message: 'Backfill writes only legacy-authoritative units, but these are target-authoritative: content.content',
    },
  ])('refuses $name before any batch', async ({ prepare, error, message }) => {
    world.order = ['tcontent'];
    seed({ tcontent: [content('C1', 'tenant-a', null)] });
    prepare();

    const caught = await runBackfill(contextFor(), { snapshotSeq: 0 }).catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(error);
    expect(caught).toMatchObject({ message });
    expect(world.applies).toEqual([]);
  });
});
