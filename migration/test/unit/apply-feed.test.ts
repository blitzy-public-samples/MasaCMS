// Unit tests for the forward change feed: real diffing, batching and encoding over scripted snapshots, legacy reads and recording owners.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import { LEGACY_PROGRAM_ID_COLUMN, decodeRow, encodeRow, formatCanonicalTimestamp, sha256Hex } from '@opt2/platform/migration-kit';
import type { ApplyRequest, CanonicalColumn, WatermarkDirection, WatermarkRecord } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, TENANT_LIST, TENANT_UMBRELLA, businessClock } from '@opt2/platform/testing';
import type { ConnectionPool } from 'mssql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchIdFor, createBatchSender } from '../../src/apply/batch.js';
import type { TenantResolver } from '../../src/apply/batch.js';
import { FeedAuthorityError, FeedBaselineMissingError, applyTableDiff, restartFeedFor, runFeed } from '../../src/apply/feed.js';
import type { FeedContext, FeedFilesResult } from '../../src/apply/feed.js';
import { loadConfig } from '../../src/config.js';
import { currentAuthority } from '../../src/cutover/index.js';
import { compareCanonicalRows, describeLegacyTable, listLegacyTables, migratableTables, streamLegacyTable } from '../../src/extract/index.js';
import type { CanonicalRow, LegacyTableRef, MigratableTable } from '../../src/extract/index.js';
import { FileStoreUnsupportedError, diffSnapshotManifests, removeDroppedObjects, transferFiles } from '../../src/files/index.js';
import type { ManifestEntry, RemovalResult, TransferResult } from '../../src/files/index.js';
import { computeDependencyOrder } from '../../src/order/index.js';
import { UnknownUnitError, loadUnitCatalog } from '../../src/owners/index.js';
import type { DataOwner, LegacyTableTarget, OwnersClient, UnitCatalog } from '../../src/owners/index.js';
import {
  buildReport,
  createTenantResolver,
  createUnitRowFilter,
  describeUnitTable,
  readLegacyUnitRows,
  readTargetUnitRows,
  reconcileUnits,
  resolvePoint,
  toUnitRow,
  writeReconciliationReport,
} from '../../src/reconcile/index.js';
import type { ObjectEntry, ReconcileResult, UnitTableShape } from '../../src/reconcile/index.js';
import { SnapshotNotFoundError, latestSnapshot, requireSnapshot, takeSnapshot } from '../../src/snapshot/index.js';
import type { SnapshotKind, SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/extract/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/extract/index.js')>()),
  listLegacyTables: vi.fn(),
  describeLegacyTable: vi.fn(),
  streamLegacyTable: vi.fn(),
}));

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  takeSnapshot: vi.fn(),
  requireSnapshot: vi.fn(),
  latestSnapshot: vi.fn(),
}));

vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  createTenantResolver: vi.fn(),
  createUnitRowFilter: vi.fn(),
  describeUnitTable: vi.fn(),
  readLegacyUnitRows: vi.fn(),
  readTargetUnitRows: vi.fn(),
  reconcileUnits: vi.fn(),
  writeReconciliationReport: vi.fn(),
}));

vi.mock('../../src/cutover/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cutover/index.js')>()),
  currentAuthority: vi.fn(),
}));

vi.mock('../../src/files/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/files/index.js')>()),
  diffSnapshotManifests: vi.fn(),
  transferFiles: vi.fn(),
  removeDroppedObjects: vi.fn(),
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

type Database = Map<string, StoredTable>;

const text = (...names: string[]): CanonicalColumn[] => names.map((name) => ({ name, type: 's' }));

const SPECS = {
  tusers: { columns: text('UserID', 'SiteID', 'Type', 'UserName', 'Password', 'Fname', 'Email'), keyColumns: ['UserID'] },
  tcontent: { columns: text('ContentID', 'SiteID', 'Title'), keyColumns: ['ContentID'] },
  tfiles: { columns: text('fileID', 'siteID', 'filename'), keyColumns: ['fileID'] },
  temailstats: { columns: text('EmailID', 'Email', 'sent'), keyColumns: [] },
  'Program_N.blackout': {
    columns: [...text('blackout_id', 'reason'), { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' }],
    keyColumns: ['blackout_id', LEGACY_PROGRAM_ID_COLUMN],
    programIds: [1, 2],
  },
  tredirects: { columns: text('redirectID', 'URL'), keyColumns: ['redirectID'] },
  'Program_N.finance_attachment': {
    columns: [...text('attachment_id', 'sha256'), { name: 'content', type: 'b' }, { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' }],
    keyColumns: ['attachment_id', LEGACY_PROGRAM_ID_COLUMN],
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
  objectColumns?: Record<string, string>;
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

const USER_COLUMNS = ['UserID', 'SiteID', 'Type', 'UserName', 'Password', 'Fname', 'Email'];

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

const OWNERSHIP: Ownership = {
  units: [
    { unit: 'identity.group_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'identity.user_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'identity.credential', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'people.person', owner: 'people', legacyTables: ['tusers'] },
    { unit: 'content.content', owner: 'strategies-content', legacyTables: ['tcontent'] },
    { unit: 'content.file', owner: 'strategies-content', legacyTables: ['tfiles'] },
    { unit: 'communications.email_stat', owner: 'communications', legacyTables: ['temailstats'] },
    { unit: 'timesheets.blackout', owner: 'timesheets', legacyTables: ['Program_N.blackout'] },
  ],
  tables: [
    {
      table: 'tusers',
      owner: 'split',
      primaryKey: ['UserID'],
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      targets: [
        explicit('identity.group_account', 'identity', 'Type = 1', ['UserID'], USER_COLUMNS),
        explicit('identity.user_account', 'identity', 'Type = 2', ['UserID'], ['UserID', 'UserName', 'Type', 'SiteID']),
        explicit('identity.credential', 'identity', 'Type = 2', ['UserID'], ['Password']),
        explicit('people.person', 'people', 'Type = 2', ['UserID', 'SiteID'], ['Fname', 'Email']),
      ],
    },
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
    { table: 'tredirects', owner: 'retired', primaryKey: ['redirectID'], targets: [] },
  ],
};

/** OWNERSHIP with `people.person` selecting rows by `predicate`. */
function withPersonPredicate(predicate: string): Ownership {
  const ownership = structuredClone(OWNERSHIP);
  const users = ownership.tables.find((table) => table.table === 'tusers');
  const person = users?.targets.find((target) => target.unit === 'people.person');
  if (person === undefined) throw new Error('OWNERSHIP has no people.person target');
  person.rowPredicate = predicate;
  return ownership;
}

/** OWNERSHIP with `temailstats` split between two communications units told apart by class-map discriminators. */
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

/** OWNERSHIP with the folded `finance.attachment` unit, whose `content` bytes finance stores as objects. */
function withAttachments(): Ownership {
  const ownership = structuredClone(OWNERSHIP);
  ownership.units.push({ unit: 'finance.attachment', owner: 'finance', legacyTables: ['Program_N.finance_attachment'] });
  ownership.tables.push({
    table: 'Program_N.finance_attachment',
    owner: 'finance',
    primaryKey: ['attachment_id'],
    programFold: true,
    targets: [{ ...whole('finance.attachment', 'finance', ['attachment_id']), objectColumns: { content: 'finance-attachments' } }],
  });
  return ownership;
}

const LIVE = 'muradb';
const CLOCK = businessClock();
const FINISHED_AT = formatCanonicalTimestamp(CLOCK.now());
const TENANT_A_ID = TENANT_A.tenantId;
const TENANT_B_ID = TENANT_B.tenantId;
const UMBRELLA_ID = TENANT_UMBRELLA.tenantId;
const SITE_TENANTS = TENANT_LIST.map((fixture) => fixture.tenantId).sort();
const CONFIG: FeedContext['config'] = { ...loadConfig(), backfill: { batchRows: 2 } };
const IDENTITY_USER_UNITS = ['identity.group_account', 'identity.user_account', 'identity.credential'];

const user = (id: string, site: string, type: '1' | '2', changes: Row = {}): Row => ({
  UserID: id,
  SiteID: site,
  Type: type,
  UserName: id.toLowerCase(),
  Password: 'p0',
  Fname: `First ${id}`,
  Email: `${id.toLowerCase()}@example.test`,
  ...changes,
});
const content = (id: string, site: string, title: string): Row => ({ ContentID: id, SiteID: site, Title: title });
const file = (id: string, site: string): Row => ({ fileID: id, siteID: site, filename: `${id}.pdf` });
const stat = (id: string, email: string): Row => ({ EmailID: id, Email: email, sent: '1' });
const blackout = (id: string, programId: number, reason: string): Row => ({ blackout_id: id, reason, [LEGACY_PROGRAM_ID_COLUMN]: String(programId) });

interface World {
  readonly databases: Map<string, Database>;
  readonly snapshots: Map<number, SnapshotRecord>;
  readonly watermarks: Map<string, WatermarkRecord>;
  readonly applies: { owner: DataOwner; request: ApplyRequest }[];
  readonly puts: { owner: DataOwner; record: WatermarkRecord }[];
  /** Owner-exported rows per `<unit>|<tenantId>`. */
  readonly target: Map<string, readonly Row[]>;
  /** Owner object manifests of object-column units per `<unit>|<tenantId>`, keyed by `legacyPath`. */
  readonly targetObjects: Map<string, readonly ObjectEntry[]>;
  readonly targetUnits: Set<string>;
  readonly readers: { opened: number; disposed: number };
  nextSnapshot: Partial<SnapshotRecord>;
  order: readonly string[];
  reconcileResult: ReconcileResult;
}

function createWorld(): World {
  return {
    databases: new Map(),
    snapshots: new Map(),
    watermarks: new Map(),
    applies: [],
    puts: [],
    target: new Map(),
    targetObjects: new Map(),
    targetUnits: new Set(),
    readers: { opened: 0, disposed: 0 },
    nextSnapshot: {},
    order: ['tusers', 'tcontent', 'tfiles', 'temailstats', 'Program_1.blackout', 'Program_2.blackout'],
    reconcileResult: 'zero-difference',
  };
}

let world: World = createWorld();
let dir = '';
let baseCatalog: UnitCatalog;
let catalog: UnitCatalog;

const info = vi.fn();
const logger = { info } as unknown as Logger;

const lower = (name: string): string => name.toLowerCase();
const watermarkKey = (owner: string, table: string, direction: WatermarkDirection): string => JSON.stringify([owner, table, direction]);

function forward(legacyTable: string, seq: number): WatermarkRecord {
  return { legacyTable, direction: 'forward', snapshotSeq: seq, backupLsn: String(1000 + seq), finishedAt: FINISHED_AT };
}

function storeWatermark(owner: DataOwner, record: WatermarkRecord): void {
  world.watermarks.set(watermarkKey(owner, record.legacyTable, record.direction), record);
}

function watermarkOf(owner: DataOwner, table: string): WatermarkRecord | undefined {
  return world.watermarks.get(watermarkKey(owner, table, 'forward'));
}

const owners: Pick<OwnersClient, 'apply' | 'putWatermark' | 'watermark'> = {
  apply(owner, request) {
    world.applies.push({ owner, request });
    const mark = request.watermark;
    if (mark !== undefined) {
      storeWatermark(owner, {
        legacyTable: request.legacyTable,
        direction: mark.direction,
        snapshotSeq: mark.snapshotSeq ?? null,
        backupLsn: mark.backupLsn ?? null,
        finishedAt: mark.finishedAt,
      });
    }
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
    storeWatermark(owner, stored);
    return Promise.resolve(stored);
  },
  watermark(owner, legacyTable, direction) {
    return Promise.resolve(world.watermarks.get(watermarkKey(owner, legacyTable, direction)) ?? null);
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

function contextFor(): FeedContext {
  const pool = (database: string): ConnectionPool => ({ config: { database } }) as unknown as ConnectionPool;
  const legacy = { live: () => Promise.resolve(pool(LIVE)), database: (name: string) => Promise.resolve(pool(name)) };
  return {
    env: {} as FeedContext['env'],
    config: CONFIG,
    clock: CLOCK,
    logger,
    db: {} as FeedContext['db'],
    legacy: legacy as unknown as FeedContext['legacy'],
    bridge: {} as FeedContext['bridge'],
    catalog,
    owners: owners as OwnersClient,
    gateway: {} as FeedContext['gateway'],
  };
}

function snapshotRecord(seq: number, kind: SnapshotKind, overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    seq,
    kind,
    state: 'ready',
    databaseName: `snap_${String(seq)}`,
    backupPath: `/backups/snap-${String(seq)}.bak`,
    checkpointLsn: String(1000 + seq),
    lastLsn: String(1000 + seq),
    takenAt: CLOCK.now(),
    transitionId: null,
    sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f',
    manifestComplete: true,
    fileStore: { status: 'ok', objects: 0 },
    ...overrides,
  };
}

function databaseOf(tables: Tables): Database {
  return new Map(Object.entries(tables).map(([name, rows]) => [name, { spec: SPECS[name as TableName], rows: rows ?? [] }]));
}

/** Copies the live database into the next snapshot, as `takeSnapshot` does. */
function snapshotLive(kind: SnapshotKind): SnapshotRecord {
  const record = snapshotRecord(Math.max(...world.snapshots.keys()) + 1, kind, world.nextSnapshot);
  world.databases.set(record.databaseName, new Map(world.databases.get(LIVE)));
  world.snapshots.set(record.seq, record);
  return record;
}

/** Snapshot 0 holds `before`, the live database `after`; every owner of a `before` table has a forward watermark at 0. */
function seed(before: Tables, after: Tables): void {
  world.snapshots.set(0, snapshotRecord(0, 'seed'));
  world.databases.set('snap_0', databaseOf(before));
  world.databases.set(LIVE, databaseOf(after));
  for (const table of Object.keys(before)) for (const owner of catalog.ownersForLegacyTable(table)) storeWatermark(owner, forward(table, 0));
}

function tableIn(database: string, name: string): StoredTable {
  const stored = world.databases.get(database)?.get(name);
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

/** `row` as the extractor yields it over the shape's columns: values decoded, so `\x` hex of a `b` column becomes bytes. */
function canonicalRow(shape: Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns' | 'folded'>, row: Row): CanonicalRow {
  const programId = valueOf(row, LEGACY_PROGRAM_ID_COLUMN);
  const values = decodeRow(shape.columns, encodeRow(shape.columns, project(shape.columns, row)));
  return toUnitRow(shape, values, shape.folded && programId !== null ? Number(programId) : undefined);
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

/** Row selection of the predicate forms the fixture ownership uses; class-map predicates take every row. */
function takes(predicate: string | null, row: Row): boolean {
  if (predicate === null || predicate.startsWith('classMap ')) return true;
  const match = /^(\w+) = (\d+)$/.exec(predicate);
  if (match === null) throw new Error(`fake legacy: unsupported predicate ${predicate}`);
  return valueOf(row, match[1] ?? '') === match[2];
}

function requests(owner: DataOwner): ApplyRequest[] {
  return world.applies.filter((apply) => apply.owner === owner).map((apply) => apply.request);
}

function encode(table: TableName, row: Row): string {
  return encodeRow(SPECS[table].columns, row);
}

function migratable(name: TableName): MigratableTable {
  const table = migratableTables(catalog, refsOf(name, SPECS[name]))[0];
  if (table === undefined) throw new Error(`${name} is not migratable`);
  return table;
}

function manifestEntry(fileId: string): ManifestEntry {
  const name = `${fileId}.pdf`;
  return { siteId: 'tenant-a', path: `tenant-a/cache/file/${name}`, snapshotSeq: 1, name, fileId, variant: '', ext: 'pdf', size: 42, sha256: 'a'.repeat(64), orphan: false };
}

function installFakes(): void {
  vi.mocked(currentAuthority).mockImplementation(() => {
    const targetUnits = new Set([...world.targetUnits].sort());
    return Promise.resolve({
      tableVersion: 'v0002',
      epoch: 3,
      units: new Map(),
      targetUnits,
      isTargetAuthoritative: (unit: string) => targetUnits.has(unit),
      anyTarget: targetUnits.size > 0,
    });
  });
  vi.mocked(listLegacyTables).mockImplementation((pool) => {
    const database = world.databases.get(pool.config?.database ?? LIVE) ?? new Map<string, StoredTable>();
    return Promise.resolve([...database].flatMap(([name, stored]) => refsOf(name, stored.spec)));
  });
  vi.mocked(describeLegacyTable).mockImplementation((_deps, options) => {
    const name = typeof options.table === 'string' ? options.table : options.table.name;
    const { spec } = tableIn(options.database ?? LIVE, name);
    return Promise.resolve({
      table: name,
      folded: spec.programIds !== undefined,
      keyed: spec.keyColumns.length > 0,
      keyColumns: spec.keyColumns,
      columns: spec.columns,
      parts: [],
    });
  });
  vi.mocked(streamLegacyTable).mockImplementation(async function* (_deps, options): AsyncGenerator<CanonicalRow, void, undefined> {
    const name = typeof options.table === 'string' ? options.table : options.table.name;
    yield* tableRows(options.database ?? LIVE, name);
  });
  vi.mocked(computeDependencyOrder).mockImplementation(() =>
    Promise.resolve({ order: world.order, entries: [], deferred: [], relaxed: [], cycles: [], parentOf: () => null }),
  );
  vi.mocked(takeSnapshot).mockImplementation((_ctx, opts) => Promise.resolve(snapshotLive(opts.kind)));
  vi.mocked(requireSnapshot).mockImplementation((_ctx, seq) => {
    const snapshot = world.snapshots.get(seq);
    return snapshot === undefined ? Promise.reject(new SnapshotNotFoundError(seq)) : Promise.resolve(snapshot);
  });
  vi.mocked(latestSnapshot).mockImplementation(() => {
    const ready = [...world.snapshots.values()].filter((snapshot) => snapshot.state === 'ready').sort((a, b) => b.seq - a.seq);
    return Promise.resolve(ready[0] ?? null);
  });
  vi.mocked(createTenantResolver).mockImplementation(() => Promise.resolve(resolver));
  vi.mocked(createUnitRowFilter).mockImplementation((_deps, options) => {
    const { rowPredicate } = targetOf(options.unit, options.legacyTable);
    return Promise.resolve({ prepare: () => Promise.resolve(), accepts: (row) => Promise.resolve(takes(rowPredicate, row as Row)) });
  });
  vi.mocked(describeUnitTable).mockImplementation((_deps, options) => {
    const target = targetOf(options.unit, options.legacyTable);
    const { spec } = tableIn(options.database, options.legacyTable);
    const owned = target.ownedColumns === 'whole-table' ? null : new Set([...target.ownedColumns, ...target.keyColumns].map(lower));
    const objects = new Set(Object.keys(target.objectColumns).map(lower));
    const folded = spec.programIds !== undefined;
    return Promise.resolve({
      unit: options.unit,
      owner: target.owner,
      legacyTable: options.legacyTable,
      keyed: target.keyColumns.length > 0,
      keyColumns: folded ? [...target.keyColumns, LEGACY_PROGRAM_ID_COLUMN] : [...target.keyColumns],
      columns: spec.columns.filter((column) => (owned === null || owned.has(lower(column.name))) && !objects.has(lower(column.name))),
      excludedColumns: [],
      objectColumns: spec.columns.filter((column) => objects.has(lower(column.name))),
      folded,
    });
  });
  vi.mocked(readLegacyUnitRows).mockImplementation((_deps, shape, options) => {
    const { rowPredicate } = targetOf(shape.unit, shape.legacyTable);
    const byTenant = new Map<string, CanonicalRow[]>();
    for (const row of tableIn(options.database, shape.legacyTable).rows) {
      if (!takes(rowPredicate, row)) continue;
      const { tenantId } = options.tenants.resolve(shape.legacyTable, row);
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), canonicalRow(shape, row)]);
    }
    world.readers.opened += 1;
    const tenants = [...byTenant.keys()].sort();
    return Promise.resolve({
      tenants,
      counts: new Map(tenants.map((tenantId) => [tenantId, byTenant.get(tenantId)?.length ?? 0])),
      rows: (tenantId: string) => (byTenant.get(tenantId) ?? []).sort(compareCanonicalRows),
      orphans: new Map(),
      objects: new Map(),
      dispose: () => {
        world.readers.disposed += 1;
        return Promise.resolve();
      },
    });
  });
  vi.mocked(readTargetUnitRows).mockImplementation((_deps, shape, tenantId) => {
    const rows = (world.target.get(`${shape.unit}|${tenantId}`) ?? []).map((row) => canonicalRow(shape, row)).sort(compareCanonicalRows);
    world.readers.opened += 1;
    return Promise.resolve({
      rows,
      count: rows.length,
      objects: shape.objectColumns.length > 0 ? [...(world.targetObjects.get(`${shape.unit}|${tenantId}`) ?? [])] : null,
      dispose: () => {
        world.readers.disposed += 1;
        return Promise.resolve();
      },
    });
  });
  vi.mocked(reconcileUnits).mockImplementation((ctx, options) =>
    Promise.resolve({
      ...buildReport({
        point: resolvePoint(ctx.config, options.point),
        tableVersion: 'v0002',
        snapshotSeq: options.snapshotSeq ?? null,
        legacyDatabase: options.database,
        units: [],
        fileStore: { store: 'fileDir', status: 'compared', haltedUnits: [] },
      }),
      result: world.reconcileResult,
    }),
  );
  vi.mocked(writeReconciliationReport).mockImplementation((_ctx, report) => Promise.resolve(`/reports/reconciliation/${report.point}.json`));
  vi.mocked(diffSnapshotManifests).mockImplementation((_ctx, from, to) =>
    Promise.resolve({ from, to, added: [], changed: [], removed: [], unchanged: 0, toTransfer: [] }),
  );
  vi.mocked(transferFiles).mockImplementation((_ctx, snapshotSeq) =>
    Promise.resolve({ snapshotSeq, transferred: 0, unchanged: 0, bytes: 0, orphans: [], misplaced: [] }),
  );
  vi.mocked(removeDroppedObjects).mockImplementation((_ctx, diff) =>
    Promise.resolve({ from: diff.from, to: diff.to, deleted: 0, absent: 0, retained: 0, misplaced: 0 }),
  );
}

async function catalogFrom(ownership: Ownership): Promise<UnitCatalog> {
  const file = path.join(dir, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(ownership));
  return loadUnitCatalog(file);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'apply-feed-'));
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

describe('runFeed', () => {
  it("drops an update of a column only a target-authoritative unit owns while the legacy units' columns still apply", async () => {
    world.targetUnits.add('identity.credential');
    seed(
      { tusers: [user('U1', 'tenant-a', '2'), user('U2', 'tenant-a', '2')] },
      { tusers: [user('U1', 'tenant-a', '2', { Password: 'p1' }), user('U2', 'tenant-a', '2', { UserName: 'renamed', Password: 'p1' })] },
    );

    const result = await runFeed(contextFor());

    expect(result.tables[0]?.owners).toMatchObject([
      { owner: 'identity', status: 'applied', base: 0, updates: 1, batches: 1, droppedTargetAuthoritative: 1 },
      { owner: 'people', status: 'applied', base: 0, updates: 0, batches: 0, droppedTargetAuthoritative: 0 },
    ]);
    expect(world.applies.map((apply) => apply.owner)).toEqual(['identity']);
    const [request] = requests('identity');
    expect(request?.units).toEqual(['identity.group_account', 'identity.user_account']);
    expect(request?.rows).toEqual([{ op: 'upsert', row: encode('tusers', user('U2', 'tenant-a', '2', { UserName: 'renamed', Password: 'p1' })) }]);
  });

  it.each([
    { owners: 'every owner', targetUnits: [] as string[], receivers: ['identity', 'people'] },
    { owners: 'people alone', targetUnits: IDENTITY_USER_UNITS, receivers: ['people'] },
  ])('fans a split-table insert out to $owners when only those owners hold writable units', async ({ targetUnits, receivers }) => {
    for (const unit of targetUnits) world.targetUnits.add(unit);
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [user('U1', 'tenant-a', '2'), user('U3', 'tenant-b', '2')] });

    const result = await runFeed(contextFor());

    expect(world.applies.map((apply) => apply.owner)).toEqual(receivers);
    for (const { request } of world.applies) {
      expect(request).toMatchObject({ tenantId: TENANT_B_ID, rows: [{ op: 'upsert', row: encode('tusers', user('U3', 'tenant-b', '2')) }] });
    }
    for (const owner of result.tables[0]?.owners.filter((candidate) => !receivers.includes(candidate.owner)) ?? []) {
      expect(owner).toMatchObject({ status: 'not-writable', base: null, batches: 0 });
      expect(watermarkOf(owner.owner, 'tusers')?.snapshotSeq).toBe(0);
    }
    expect(result.bases).toEqual({ tusers: Object.fromEntries(receivers.map((owner) => [owner, 0])) });
  });

  it('sends nothing for a table whose only unit is target-authoritative and keeps its watermark', async () => {
    world.targetUnits.add('content.content');
    seed({ tcontent: [content('C1', 'tenant-a', 'Old')] }, { tcontent: [content('C1', 'tenant-a', 'New'), content('C2', 'tenant-b', 'Added')] });

    const result = await runFeed(contextFor());

    expect(result.tables).toEqual([
      {
        table: 'tcontent',
        owners: [
          { owner: 'strategies-content', base: null, status: 'not-writable', inserts: 0, updates: 0, deletes: 0, batches: 0, orphans: 0, droppedTargetAuthoritative: 0 },
        ],
      },
    ]);
    expect(world.applies).toEqual([]);
    expect(world.puts).toEqual([]);
    expect(watermarkOf('strategies-content', 'tcontent')).toEqual(forward('tcontent', 0));
    expect(info).toHaveBeenCalledWith('feed to snapshot 1: tcontent: strategies-content not-writable');
  });

  it('deletes exactly one occurrence of a duplicated keyless row that lost a copy', async () => {
    const kept = stat('E1', 'kept@example.test');
    const other = stat('E2', 'other@example.test');
    const added = stat('E3', 'added@example.test');
    seed({ temailstats: [kept, kept, other] }, { temailstats: [kept, other, added] });

    const result = await runFeed(contextFor());

    const sent = requests('communications');
    const rows = sent.flatMap((request) => request.rows);
    expect(rows.filter((change) => change.op === 'delete')).toEqual([{ op: 'delete', row: encode('temailstats', kept) }]);
    expect(rows.filter((change) => change.op === 'insert')).toEqual([{ op: 'insert', row: encode('temailstats', added) }]);
    expect(rows).toHaveLength(2);
    expect(sent.map((request) => request.tenantId)).toEqual([UMBRELLA_ID]);
    expect(result.tables[0]?.owners[0]).toMatchObject({ status: 'applied', deletes: 1, inserts: 1, orphans: 2 });
  });

  it('carries the forward watermark at the new snapshot on the last batch of each owner only', async () => {
    for (const unit of IDENTITY_USER_UNITS) world.targetUnits.add(unit);
    seed({ tusers: [] }, { tusers: ['U3', 'U4', 'U5'].map((id) => user(id, 'tenant-a', '2')) });

    const result = await runFeed(contextFor());

    const sent = requests('people');
    expect(sent.map((request) => request.batchId)).toEqual(
      [0, 1].map((ordinal) => batchIdFor({ direction: 'feed', snapshotSeq: 1, legacyTable: 'tusers', tenantId: TENANT_A_ID, ordinal })),
    );
    expect(sent.map((request) => request.rows.length)).toEqual([2, 1]);
    expect(sent[0]?.watermark).toBeUndefined();
    expect(sent[1]?.watermark).toEqual({ direction: 'forward', snapshotSeq: 1, backupLsn: world.snapshots.get(1)?.checkpointLsn, finishedAt: FINISHED_AT });
    expect(watermarkOf('people', 'tusers')).toEqual(forward('tusers', 1));
    expect(result.tables[0]?.owners[1]).toMatchObject({ owner: 'people', inserts: 3, batches: 2 });
    expect(info).toHaveBeenCalledWith('feed to snapshot 1: tusers: identity not-writable, people +3 ~0 -0 in 2 batches');
  });

  it("prepares acceptance for each chunk of batchRows changes with that chunk's rows on their sides before judging any of them", async () => {
    const events: [string, string, (string | null)[] | string | null][] = [];
    vi.mocked(createUnitRowFilter).mockImplementation((_deps, options) => {
      const { rowPredicate } = targetOf(options.unit, options.legacyTable);
      const log = options.unit === 'people.person' ? events : [];
      return Promise.resolve({
        prepare: (rows) => {
          log.push(['prepare', options.database, rows.map((row) => valueOf(row as Row, 'UserID'))]);
          return Promise.resolve();
        },
        accepts: (row) => {
          log.push(['accepts', options.database, valueOf(row as Row, 'UserID')]);
          return Promise.resolve(takes(rowPredicate, row as Row));
        },
      });
    });
    seed(
      { tusers: [user('U1', 'tenant-a', '2')] },
      { tusers: [user('U1', 'tenant-a', '2', { Fname: 'Renamed' }), user('U2', 'tenant-a', '2'), user('U3', 'tenant-b', '2')] },
    );

    const result = await runFeed(contextFor());

    expect(events).toEqual([
      ['prepare', 'snap_0', ['U1']],
      ['prepare', 'snap_1', ['U1', 'U2']],
      ['accepts', 'snap_0', 'U1'],
      ['accepts', 'snap_1', 'U1'],
      ['accepts', 'snap_1', 'U2'],
      ['prepare', 'snap_1', ['U3']],
      ['accepts', 'snap_1', 'U3'],
    ]);
    expect(result.tables[0]?.owners[1]).toMatchObject({ owner: 'people', status: 'applied', updates: 1, inserts: 2 });
  });

  it('raises FeedBaselineMissingError for an owner without a forward watermark before any snapshot is taken', async () => {
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [] });
    world.watermarks.delete(watermarkKey('people', 'tusers', 'forward'));

    const error = await runFeed(contextFor()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeedBaselineMissingError);
    expect(error).toMatchObject({ table: 'tusers', owner: 'people', message: 'people has no forward watermark with a snapshot sequence for tusers; run backfill first' });
    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(world.applies).toEqual([]);
  });

  it('reproduces identical batch ids when resumed on the snapshot of an interrupted run', async () => {
    seed({ tusers: [] }, { tusers: ['U3', 'U4', 'U5'].map((id) => user(id, 'tenant-a', '2')) });
    await runFeed(contextFor());
    const first = world.applies.map(({ owner, request }) => [owner, request.batchId]);
    world.applies.length = 0;
    storeWatermark('identity', forward('tusers', 0));
    storeWatermark('people', forward('tusers', 0));

    const resumed = await runFeed(contextFor(), { snapshotSeq: 1 });

    expect(resumed.snapshotSeq).toBe(1);
    expect(world.applies.map(({ owner, request }) => [owner, request.batchId])).toEqual(first);
    expect(first).toHaveLength(4);
    expect(takeSnapshot).toHaveBeenCalledTimes(1);
    expect(latestSnapshot).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume on a snapshot that is not ready', async () => {
    seed({ tusers: [] }, { tusers: [] });
    world.snapshots.set(4, snapshotRecord(4, 'feed', { state: 'failed' }));

    await expect(runFeed(contextFor(), { snapshotSeq: 4 })).rejects.toThrow('Snapshot 4 is failed, so the feed cannot read it');
    expect(takeSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      change: 'to another tenant',
      before: user('U1', 'tenant-a', '2'),
      after: user('U1', 'tenant-b', '2'),
      identity: { sent: [['delete', TENANT_A_ID], ['upsert', TENANT_B_ID]], counts: [0, 1, 1] },
      people: { sent: [['delete', TENANT_A_ID], ['upsert', TENANT_B_ID]], counts: [0, 1, 1] },
    },
    {
      change: 'to other targets',
      before: user('U1', 'tenant-a', '2'),
      after: user('U1', 'tenant-a', '1'),
      identity: { sent: [['delete', TENANT_A_ID], ['upsert', TENANT_A_ID]], counts: [0, 1, 1] },
      people: { sent: [['delete', TENANT_A_ID]], counts: [0, 1, 0] },
    },
    {
      change: 'to another target key within one tenant',
      before: user('U1', 'closed-site', '2'),
      after: user('U1', 'other-closed-site', '2'),
      identity: { sent: [['upsert', UMBRELLA_ID]], counts: [1, 0, 0] },
      people: { sent: [['delete', UMBRELLA_ID], ['upsert', UMBRELLA_ID]], counts: [0, 1, 1] },
    },
  ])('re-sends a row moving $change as a delete of its before-image and an upsert of its after-image', async ({ before, after, identity, people }) => {
    seed({ tusers: [before] }, { tusers: [after] });

    const result = await runFeed(contextFor());

    const sent = (owner: DataOwner): string[][] =>
      requests(owner)
        .flatMap((request) => request.rows.map((change) => [change.op, request.tenantId ?? '', change.row]))
        .sort();
    const expected = (pairs: string[][]): string[][] =>
      pairs.map(([op = '', tenantId = '']) => [op, tenantId, encode('tusers', op === 'delete' ? before : after)]).sort();
    expect(sent('identity')).toEqual(expected(identity.sent));
    expect(sent('people')).toEqual(expected(people.sent));
    expect(result.tables[0]?.owners.map((owner) => [owner.owner, owner.updates, owner.deletes, owner.inserts])).toEqual([
      ['identity', ...identity.counts],
      ['people', ...people.counts],
    ]);
  });

  it('counts inserts, deletes and updates only a target-authoritative unit would take as dropped and sends none of them', async () => {
    world.targetUnits.add('identity.group_account');
    seed(
      { tusers: [user('G1', 'tenant-a', '1'), user('G3', 'tenant-a', '1')] },
      { tusers: [user('G2', 'tenant-a', '1'), user('G3', 'tenant-a', '1', { Fname: 'Renamed' })] },
    );

    const result = await runFeed(contextFor());

    expect(result.tables[0]?.owners).toMatchObject([
      { owner: 'identity', status: 'applied', inserts: 0, updates: 0, deletes: 0, batches: 0, droppedTargetAuthoritative: 3 },
      { owner: 'people', status: 'applied', inserts: 0, updates: 0, deletes: 0, batches: 0, droppedTargetAuthoritative: 0 },
    ]);
    expect(world.applies).toEqual([]);
    expect(world.puts).toEqual([
      { owner: 'identity', record: forward('tusers', 1) },
      { owner: 'people', record: forward('tusers', 1) },
    ]);
  });

  it('feeds tables in dependency order, folds Program_<id> parts once and appends tables the order omits by name', async () => {
    world.order = ['tcontent', 'Program_2.blackout', 'Program_1.blackout', 'tusers', 'tmissing'];
    const unchanged = { tusers: [], tcontent: [], temailstats: [], tredirects: [] };
    seed(
      { ...unchanged, 'Program_N.blackout': [blackout('B1', 1, 'leave')] },
      { ...unchanged, 'Program_N.blackout': [blackout('B1', 1, 'sick'), blackout('B2', 2, 'leave')] },
    );

    const result = await runFeed(contextFor());

    expect(result.tables.map((table) => table.table)).toEqual(['tcontent', 'Program_N.blackout', 'tusers', 'temailstats']);
    expect(computeDependencyOrder).toHaveBeenCalledWith({ inventory: CONFIG.paths.inventory, catalog, programIds: [1, 2] });
    expect(requests('timesheets').map((request) => [request.legacyTable, request.legacyProgramId, request.rows.map((change) => change.op)])).toEqual([
      ['Program_1.blackout', 1, ['upsert']],
      ['Program_2.blackout', 2, ['upsert']],
    ]);
    expect(world.puts).toContainEqual({ owner: 'timesheets', record: forward('Program_N.blackout', 1) });
    expect(vi.mocked(createTenantResolver).mock.calls.map(([, options]) => options.database)).toEqual(['snap_0', 'snap_1']);
  });

  it('refuses a table whose columns differ between the base and the new snapshot', async () => {
    seed({ tusers: [] }, { tusers: [] });
    world.databases.get('snap_0')?.set('tusers', { spec: { ...SPECS.tusers, columns: SPECS.tusers.columns.slice(0, -1) }, rows: [] });

    await expect(runFeed(contextFor())).rejects.toThrow('tusers has other columns or another key in snapshot 1 than in snapshot 0');
  });

  it.each([
    { predicate: 'Type > 1', message: 'row predicate "Type > 1" has a form the feed cannot read' },
    { predicate: 'Type in (abc)', message: 'row predicate "Type in (abc)" has a value list the feed cannot read' },
  ])('refuses a split table whose row predicate $predicate it cannot read', async ({ predicate, message }) => {
    catalog = await catalogFrom(withPersonPredicate(predicate));
    seed({ tusers: [] }, { tusers: [user('U1', 'tenant-a', '2')] });

    await expect(runFeed(contextFor())).rejects.toThrow(message);
  });

  it('refuses a keyless row that one owner takes under two discriminators', async () => {
    catalog = await catalogFrom(withEmailStatsByClass());
    seed({ temailstats: [] }, { temailstats: [stat('E1', 'one@example.test')] });

    await expect(runFeed(contextFor())).rejects.toThrow('a keyless temailstats row is taken by communications targets with different discriminators');
  });

  it.each([
    [0, 'zero-difference'],
    [1, 'difference'],
  ] as const)('exits with %i after a %s reconciliation of the legacy-authoritative units at after-feed-<seq>', async (exitCode, outcome) => {
    world.reconcileResult = outcome;
    world.targetUnits.add('identity.credential');
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [user('U1', 'tenant-a', '2')] });

    const result = await runFeed(contextFor());

    expect(result).toMatchObject({
      snapshotSeq: 1,
      tableVersion: 'v0002',
      exitCode,
      reconciliation: { point: 'after-feed-1', result: outcome, reportPath: '/reports/reconciliation/after-feed-1.json' },
    });
    expect(reconcileUnits).toHaveBeenCalledWith(expect.anything(), {
      point: 'after-feed-1',
      units: [
        'communications.email_stat',
        'content.content',
        'content.file',
        'identity.group_account',
        'identity.user_account',
        'people.person',
        'timesheets.blackout',
      ],
      database: 'snap_1',
      snapshotSeq: 1,
    });
    expect(writeReconciliationReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ point: 'after-feed-1', result: outcome }));
  });
});

describe('runFeed files step', () => {
  const unsupported = new FileStoreUnsupportedError('s3', 'tenant-a');
  const cases: { name: string; targetUnits: string[]; snapshot: Partial<SnapshotRecord>; files: FeedFilesResult; reconciled: boolean }[] = [
    {
      name: 'its file unit is target-authoritative',
      targetUnits: ['content.file_object'],
      snapshot: {},
      files: { status: 'skipped-target-authoritative', units: ['content.file_object'] },
      reconciled: false,
    },
    {
      name: 'its tfiles unit is target-authoritative',
      targetUnits: ['content.file_object', 'content.file'],
      snapshot: {},
      files: { status: 'skipped-target-authoritative', units: ['content.file', 'content.file_object'] },
      reconciled: false,
    },
    {
      name: 'the store is unsupported',
      targetUnits: [],
      snapshot: { fileStore: { status: 'unsupported', fileStore: 's3', siteId: 'tenant-a' } },
      files: { status: 'halted', reason: unsupported.message },
      reconciled: true,
    },
    {
      name: 'the snapshot recorded no manifest',
      targetUnits: [],
      snapshot: { manifestComplete: false, fileStore: null },
      files: { status: 'halted', reason: 'snapshot 1 recorded no file manifest: its legacy file store is not fileDir' },
      reconciled: true,
    },
  ];

  it.each(cases)('transfers nothing when $name', async ({ targetUnits, snapshot, files, reconciled }) => {
    for (const unit of targetUnits) world.targetUnits.add(unit);
    world.nextSnapshot = snapshot;
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F1', 'tenant-a'), file('F2', 'tenant-a')] });

    const result = await runFeed(contextFor());

    expect(result.files).toEqual(files);
    expect(diffSnapshotManifests).not.toHaveBeenCalled();
    expect(transferFiles).not.toHaveBeenCalled();
    expect(removeDroppedObjects).not.toHaveBeenCalled();
    expect(vi.mocked(reconcileUnits).mock.calls[0]?.[1].units.includes('content.file_object')).toBe(reconciled);
  });

  it('reports the file store not applicable when the snapshot lacks tfiles', async () => {
    seed({ tusers: [] }, { tusers: [] });

    const result = await runFeed(contextFor());

    expect(result.files).toEqual({ status: 'not-applicable', reason: 'tfiles is not a migratable table of snapshot 1' });
  });

  it('reports the file store up to date when the tfiles watermark already reached the resumed snapshot', async () => {
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F1', 'tenant-a')] });
    snapshotLive('feed');
    storeWatermark('strategies-content', forward('tfiles', 1));

    const result = await runFeed(contextFor(), { snapshotSeq: 1 });

    expect(result.files).toEqual({ status: 'up-to-date', from: 1, to: 1 });
    expect(result.tables[0]?.owners[0]).toMatchObject({ owner: 'strategies-content', status: 'up-to-date', base: 1 });
    expect(diffSnapshotManifests).not.toHaveBeenCalled();
    expect(world.applies).toEqual([]);
  });

  it('transfers the objects added or changed since the tfiles watermark, then deletes the removed ones before the watermark moves', async () => {
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F2', 'tenant-a')] });
    const added = manifestEntry('F2');
    const removed = manifestEntry('F1');
    const only = [{ siteId: added.siteId, path: added.path }];
    const diff = { from: 0, to: 1, added: [added], changed: [], removed: [removed], unchanged: 0, toTransfer: only };
    const transfer: TransferResult = { snapshotSeq: 1, transferred: 1, unchanged: 0, bytes: 42, orphans: [], misplaced: [] };
    const removal: RemovalResult = { from: 0, to: 1, deleted: 1, absent: 0, retained: 0, misplaced: 0 };
    vi.mocked(diffSnapshotManifests).mockResolvedValueOnce(diff);
    vi.mocked(transferFiles).mockResolvedValueOnce(transfer);
    const seen: { watermark: number | null | undefined; applies: number }[] = [];
    vi.mocked(removeDroppedObjects).mockImplementationOnce(() => {
      seen.push({ watermark: watermarkOf('strategies-content', 'tfiles')?.snapshotSeq, applies: world.applies.length });
      return Promise.resolve(removal);
    });

    const result = await runFeed(contextFor());

    expect(result.files).toEqual({ status: 'transferred', from: 0, to: 1, transfer, removal });
    expect(diffSnapshotManifests).toHaveBeenCalledWith(expect.anything(), 0, 1);
    expect(transferFiles).toHaveBeenCalledWith(expect.anything(), 1, { only });
    expect(removeDroppedObjects).toHaveBeenCalledWith(expect.anything(), diff);
    expect(vi.mocked(transferFiles).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeDroppedObjects).mock.invocationCallOrder[0] ?? 0);
    expect(seen).toEqual([{ watermark: 0, applies: 0 }]);
    expect(watermarkOf('strategies-content', 'tfiles')?.snapshotSeq).toBe(1);
    expect(vi.mocked(reconcileUnits).mock.calls[0]?.[1].units).toContain('content.file_object');
    expect(requests('strategies-content').flatMap((request) => request.rows.map((change) => change.op))).toEqual(['delete', 'upsert']);
  });

  it('stops before any table batch, its watermark unmoved, when a removal fails, and deletes again on the resumed run', async () => {
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F2', 'tenant-a')] });
    const diff = { from: 0, to: 1, added: [], changed: [], removed: [manifestEntry('F1')], unchanged: 0, toTransfer: [] };
    vi.mocked(diffSnapshotManifests).mockResolvedValue(diff);
    vi.mocked(removeDroppedObjects).mockRejectedValueOnce(new Error('strategies-content unavailable'));

    await expect(runFeed(contextFor())).rejects.toThrow('strategies-content unavailable');
    expect(world.applies).toEqual([]);
    expect(watermarkOf('strategies-content', 'tfiles')?.snapshotSeq).toBe(0);

    const resumed = await runFeed(contextFor(), { snapshotSeq: 1 });
    expect(removeDroppedObjects).toHaveBeenCalledTimes(2);
    expect(vi.mocked(removeDroppedObjects).mock.calls.map(([, called]) => called)).toEqual([diff, diff]);
    expect(resumed.files).toMatchObject({ status: 'transferred', from: 0, to: 1 });
    expect(watermarkOf('strategies-content', 'tfiles')?.snapshotSeq).toBe(1);
  });

  it('halts the files step when the transfer meets an unsupported store', async () => {
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F1', 'tenant-a')] });
    const error = new FileStoreUnsupportedError('s3', 'tenant-b');
    vi.mocked(transferFiles).mockRejectedValueOnce(error);

    const result = await runFeed(contextFor());

    expect(result.files).toEqual({ status: 'halted', reason: error.message });
    expect(removeDroppedObjects).not.toHaveBeenCalled();
  });

  it('propagates any other transfer failure', async () => {
    seed({ tfiles: [file('F1', 'tenant-a')] }, { tfiles: [file('F1', 'tenant-a')] });
    vi.mocked(transferFiles).mockRejectedValueOnce(new Error('object store offline'));

    await expect(runFeed(contextFor())).rejects.toThrow('object store offline');
    expect(world.applies).toEqual([]);
    expect(removeDroppedObjects).not.toHaveBeenCalled();
  });
});

describe('applyTableDiff', () => {
  it.each([
    {
      skipped: 'no-baseline',
      writable: ['identity.user_account', 'people.person'],
      bases: [['identity', 1], ['people', null]] as [DataOwner, number | null][],
      statuses: [['identity', 'up-to-date', 1], ['people', 'no-baseline', null]],
      forced: ['people'],
    },
    {
      skipped: 'not-writable',
      writable: ['people.person'],
      bases: [['people', 1]] as [DataOwner, number | null][],
      statuses: [['identity', 'not-writable', null], ['people', 'up-to-date', 1]],
      forced: ['identity'],
    },
  ])('forces the watermark at the target snapshot onto a $skipped owner and leaves an up-to-date one alone', async ({ writable, bases, statuses, forced }) => {
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [user('U1', 'tenant-a', '2'), user('U2', 'tenant-a', '2')] });
    const to = snapshotLive('feed');

    const result = await applyTableDiff(contextFor(), {
      table: migratable('tusers'),
      to,
      writableUnits: new Set(writable),
      baseByOwner: new Map(bases),
      direction: 'feed',
      tenantsFor: () => Promise.resolve(resolver),
      sender: createBatchSender({ owners, fault: null }),
      batchSize: 2,
      forceWatermark: true,
    });

    expect(result.owners.map((owner) => [owner.owner, owner.status, owner.base])).toEqual(statuses);
    expect(world.applies).toEqual([]);
    expect(world.puts).toEqual(forced.map((owner) => ({ owner, record: forward('tusers', 1) })));
  });

  it('looks each base up through the forward watermark when the caller passes none', async () => {
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [user('U1', 'tenant-a', '2'), user('U2', 'tenant-a', '2')] });
    world.watermarks.delete(watermarkKey('people', 'tusers', 'forward'));
    const to = snapshotLive('feed');

    const result = await applyTableDiff(contextFor(), {
      table: migratable('tusers'),
      to,
      writableUnits: new Set(['identity.user_account', 'people.person']),
      direction: 'feed',
      tenantsFor: () => Promise.resolve(resolver),
      sender: createBatchSender({ owners, fault: null }),
      batchSize: 2,
    });

    expect(result.owners.map((owner) => [owner.owner, owner.status, owner.base, owner.inserts])).toEqual([
      ['identity', 'applied', 0, 1],
      ['people', 'no-baseline', null, 0],
    ]);
    expect(world.applies.map(({ owner, request }) => [owner, request.units, request.watermark?.snapshotSeq])).toEqual([['identity', ['identity.user_account'], 1]]);
    expect(world.puts).toEqual([]);
  });
});

describe('restartFeedFor', () => {
  it('refuses to restart a unit that is still target-authoritative', async () => {
    world.targetUnits.add('people.person');
    seed({ tusers: [] }, { tusers: [] });

    const error = await restartFeedFor(contextFor(), { units: ['people.person', 'identity.credential'] }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeedAuthorityError);
    expect(error).toMatchObject({ units: ['people.person'], message: 'The forward feed cannot restart for target-authoritative units: people.person' });
    expect(takeSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a unit the catalog does not know before reading authority', async () => {
    await expect(restartFeedFor(contextFor(), { units: ['people.nobody'] })).rejects.toBeInstanceOf(UnknownUnitError);
    expect(currentAuthority).not.toHaveBeenCalled();
  });

  it("re-baselines a restarted unit against its exports at a fresh snapshot and moves only that owner's watermark there", async () => {
    seed(
      { tusers: [] },
      { tusers: [user('U1', 'tenant-a', '2', { Fname: 'Ann' }), user('U2', 'tenant-b', '2'), user('G1', 'tenant-a', '1')] },
    );
    world.target.set(`people.person|${TENANT_A_ID}`, [user('U1', 'tenant-a', '2', { Fname: 'Old' }), user('U9', 'tenant-a', '2')]);

    const result = await restartFeedFor(contextFor(), { units: ['people.person'] });

    expect(takeSnapshot).toHaveBeenCalledWith(expect.anything(), { kind: 'rebaseline' });
    expect(result).toEqual({
      snapshotSeq: 1,
      units: ['people.person'],
      tables: [{ table: 'tusers', owner: 'people', catchUp: null, rebaseline: { units: ['people.person'], inserts: 1, updates: 1, deletes: 1, batches: 2 } }],
    });
    const sent = requests('people');
    expect(sent.map((request) => request.columns.map((column) => column.name))).toEqual([
      ['UserID', 'SiteID', 'Fname', 'Email', 'Type'],
      ['UserID', 'SiteID', 'Fname', 'Email', 'Type'],
    ]);
    expect(
      sent.map((request) => [request.tenantId, request.units, request.rows.map((change) => [change.op, decodeRow(request.columns, change.row)])]),
    ).toEqual([
      [
        TENANT_A_ID,
        ['people.person'],
        [
          ['upsert', { UserID: 'U1', SiteID: 'tenant-a', Fname: 'Ann', Email: 'u1@example.test', Type: '2' }],
          ['delete', { UserID: 'U9', SiteID: 'tenant-a', Fname: 'First U9', Email: 'u9@example.test', Type: '2' }],
        ],
      ],
      [TENANT_B_ID, ['people.person'], [['upsert', { UserID: 'U2', SiteID: 'tenant-b', Fname: 'First U2', Email: 'u2@example.test', Type: '2' }]]],
    ]);
    expect(sent[0]?.watermark).toBeUndefined();
    expect(sent[1]?.watermark).toEqual({ direction: 'forward', snapshotSeq: 1, backupLsn: '1001', finishedAt: FINISHED_AT });
    expect(watermarkOf('people', 'tusers')).toEqual(forward('tusers', 1));
    expect(watermarkOf('identity', 'tusers')).toEqual(forward('tusers', 0));
    expect(world.readers.disposed).toBe(world.readers.opened);
    expect(info).toHaveBeenCalledWith('feed restart at snapshot 1: tusers people re-baselined people.person: +1 ~1 -1 in 2 batches');
  });

  it("catches up the owner's other legacy units without a watermark before re-baselining the restarted one at a given snapshot", async () => {
    seed({ tusers: [user('U1', 'tenant-a', '2')] }, { tusers: [user('U1', 'tenant-a', '2', { UserName: 'renamed', Password: 'p1' })] });
    const at = snapshotLive('rebaseline');
    world.target.set(`identity.credential|${TENANT_A_ID}`, [user('U1', 'tenant-a', '2', { Password: 'stale' })]);

    const result = await restartFeedFor(contextFor(), { units: ['identity.credential'], snapshotSeq: at.seq });

    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(result.tables).toEqual([
      {
        table: 'tusers',
        owner: 'identity',
        catchUp: { owner: 'identity', base: 0, status: 'applied', inserts: 0, updates: 1, deletes: 0, batches: 1, orphans: 0, droppedTargetAuthoritative: 0 },
        rebaseline: { units: ['identity.credential'], inserts: 0, updates: 1, deletes: 0, batches: 1 },
      },
    ]);
    const [catchUp, rebaseline] = requests('identity');
    expect(catchUp).toMatchObject({
      batchId: batchIdFor({ direction: 'catch-up', snapshotSeq: 1, legacyTable: 'tusers', tenantId: TENANT_A_ID, ordinal: 0 }),
      units: ['identity.group_account', 'identity.user_account'],
      rows: [{ op: 'upsert', row: encode('tusers', user('U1', 'tenant-a', '2', { UserName: 'renamed', Password: 'p1' })) }],
    });
    expect(catchUp?.watermark).toBeUndefined();
    expect(rebaseline?.columns).toEqual(text('UserID', 'Password', 'Type'));
    expect(rebaseline?.units).toEqual(['identity.credential']);
    expect(rebaseline?.rows).toEqual([{ op: 'upsert', row: encodeRow(text('UserID', 'Password', 'Type'), { UserID: 'U1', Password: 'p1', Type: '2' }) }]);
    expect(rebaseline?.watermark).toMatchObject({ direction: 'forward', snapshotSeq: 1 });
    expect(watermarkOf('identity', 'tusers')?.snapshotSeq).toBe(1);
    expect(requests('people')).toEqual([]);
  });

  it('re-baselines an object-column unit, sending the bytes of each row the target lacks or whose stored object is missing or differs', async () => {
    catalog = await catalogFrom(withAttachments());
    const attachment = (id: string, programId: number, bytes: Buffer): Row => ({
      attachment_id: id,
      sha256: sha256Hex(bytes),
      content: `\\x${bytes.toString('hex')}`,
      [LEGACY_PROGRAM_ID_COLUMN]: String(programId),
    });
    const stored = (id: string, programId: number, bytes: Buffer): ObjectEntry => ({
      key: `Program_${String(programId)}.finance_attachment/${id}`,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    const bytesOf = (name: string): Buffer => Buffer.from(`attachment ${name}`);
    const [added, kept, corrupted, lost, removed] = [bytesOf('added'), bytesOf('kept'), bytesOf('corrupted'), bytesOf('lost'), bytesOf('removed')];
    const table = 'Program_N.finance_attachment';
    seed({ [table]: [] }, { [table]: [attachment('AT1', 1, added), attachment('AT2', 1, kept), attachment('AT3', 2, corrupted), attachment('AT4', 1, lost)] });
    const exported = `finance.attachment|${UMBRELLA_ID}`;
    world.target.set(exported, [attachment('AT2', 1, kept), attachment('AT3', 2, corrupted), attachment('AT4', 1, lost), attachment('AT5', 2, removed)]);
    world.targetObjects.set(exported, [stored('AT2', 1, kept), { ...stored('AT3', 2, corrupted), sha256: sha256Hex(removed) }, stored('AT5', 2, removed)]);

    const result = await restartFeedFor(contextFor(), { units: ['finance.attachment'] });

    expect(result.tables).toEqual([
      { table, owner: 'finance', catchUp: null, rebaseline: { units: ['finance.attachment'], inserts: 1, updates: 2, deletes: 1, batches: 2 } },
    ]);
    const sent = requests('finance');
    expect(sent.map((request) => request.columns.map((column) => column.name))).toEqual(sent.map(() => ['attachment_id', 'sha256', LEGACY_PROGRAM_ID_COLUMN, 'content']));
    const rows = sent.flatMap((request) => request.rows.map((change) => [change.op, decodeRow(request.columns, change.row)]));
    const program = (id: number): Record<string, string> => ({ [LEGACY_PROGRAM_ID_COLUMN]: String(id) });
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['upsert', { attachment_id: 'AT1', sha256: sha256Hex(added), ...program(1), content: added }],
        ['upsert', { attachment_id: 'AT3', sha256: sha256Hex(corrupted), ...program(2), content: corrupted }],
        ['upsert', { attachment_id: 'AT4', sha256: sha256Hex(lost), ...program(1), content: lost }],
        ['delete', { attachment_id: 'AT5', sha256: sha256Hex(removed), ...program(2), content: null }],
      ]),
    );
    expect(world.readers.disposed).toBe(world.readers.opened);
  });

  it('re-baselines a keyless unit by occurrence, deleting one surplus copy and inserting the missing row', async () => {
    const kept = stat('E1', 'kept@example.test');
    const other = stat('E2', 'other@example.test');
    const missing = stat('E3', 'missing@example.test');
    seed({ temailstats: [], tusers: [] }, { temailstats: [kept, other, missing], tusers: [user('U1', 'tenant-a', '2')] });
    world.target.set(`communications.email_stat|${UMBRELLA_ID}`, [kept, kept, other]);

    const result = await restartFeedFor(contextFor(), { units: ['communications.email_stat'] });

    expect(result.tables).toEqual([
      { table: 'temailstats', owner: 'communications', catchUp: null, rebaseline: { units: ['communications.email_stat'], inserts: 1, updates: 0, deletes: 1, batches: 1 } },
    ]);
    const rows = requests('communications').flatMap((request) => request.rows);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { op: 'delete', row: encode('temailstats', kept) },
        { op: 'insert', row: encode('temailstats', missing) },
      ]),
    );
    expect(world.applies.map((apply) => apply.owner)).toEqual(['communications']);
  });
});
