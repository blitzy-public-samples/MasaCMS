// Unit tests for the reconciliation entry points over the real catalog and config, with fake reads, snapshots and gateway.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256Hex, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { fixedClock } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { loadGroups, loadVersion } from '../../src/cutover/index.js';
import { UnitCatalogError, loadUnitCatalog, type Unit, type UnitCatalog } from '../../src/owners/index.js';
import { TableNotFoundError, type CanonicalRow, type LegacyTableRef } from '../../src/extract/index.js';
import {
  FixtureStatusError,
  RECONCILIATION_DIR,
  ReconcileUsageError,
  reconcileUnits,
  runReconcile,
  toUnitRow,
  type FixtureStatus,
  type LegacyObjects,
  type ObjectEntry,
  type ReconcileContext,
  type ReconcileSources,
  type TenantResolver,
  type UnitTableShape,
} from '../../src/reconcile/index.js';

const PIN_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const LIVE_DB = 'muradb_test';
const A = tenantIdForSite('tenant-a');
const B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite('umbrella');
const FILE_UNIT = 'content.file_object';
const SHA_1 = '1'.repeat(64);
const SHA_2 = '2'.repeat(64);

const config = loadConfig();
const realCatalog = loadUnitCatalog(config.paths.tableOwnership);
const ownership = JSON.parse(readFileSync(config.paths.tableOwnership, 'utf8')) as { tables: { table: string; origin?: string }[] };
/** Ownership-file tables the legacy fixtures create. */
const FIXTURE_TABLES = new Set(ownership.tables.filter((entry) => entry.origin === 'fixture').map((entry) => entry.table));
/** Unit tables of a Masa install without the fixtures. */
const MASA_TABLES = [...new Set(realCatalog.units().flatMap((unit) => unit.legacyTables))].filter((table) => !FIXTURE_TABLES.has(table));

/** Units of the roster group set R that `v0003.rollbackRefs` names. */
function rosterGroupUnits(): string[] {
  const named = new Set(loadVersion(config.paths.cutoverDir, 'v0003').rollbackRefs.flatMap((ref) => ref.groups));
  return loadGroups(config.paths.groupsFile).groups.filter((group) => named.has(group.id)).flatMap((group) => group.units);
}

const PERSON_COLUMNS: CanonicalColumn[] = [
  { name: 'UserID', type: 's' },
  { name: 'Fname', type: 's' },
];
const STATS_COLUMNS: CanonicalColumn[] = [
  { name: 'EmailID', type: 's' },
  { name: 'Status', type: 'i' },
];

/** Legacy table whose fake shape sets an object column apart. */
const ATTACHMENT_TABLE = 'Program_N.finance_attachment';

/** Shape of a unit table: `temailstats` keyless, everything else keyed on its first column, attachments with an object column. */
function shapeOf(unit: string, legacyTable: string): UnitTableShape {
  const keyless = legacyTable === 'temailstats';
  const columns = keyless ? STATS_COLUMNS : PERSON_COLUMNS;
  return {
    unit,
    owner: realCatalog.units().find((candidate) => candidate.id === unit)?.owner ?? 'strategies-content',
    legacyTable,
    keyed: !keyless,
    keyColumns: keyless ? [] : [columns[0]?.name ?? ''],
    columns,
    excludedColumns: keyless ? [] : ['IdentityCol'],
    objectColumns: legacyTable === ATTACHMENT_TABLE ? [{ name: 'content', type: 'b' }] : [],
    folded: false,
  };
}

function rowsOf(shape: UnitTableShape, values: readonly Record<string, string>[]): CanonicalRow[] {
  return values.map((value) => toUnitRow(shape, value)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Per unit table and tenant, the rows each side holds. */
type Data = Record<string, Record<string, readonly Record<string, string>[]>>;

interface Fakes {
  legacy?: Data;
  target?: Data;
  orphans?: Record<string, readonly string[]>;
  legacyObjects?: LegacyObjects;
  targetObjects?: Record<string, readonly ObjectEntry[]>;
  /** Per tenant, the objects of object-column shapes: those the legacy rows hold and those the owner's manifest lists by legacyPath. */
  columnObjects?: { legacy: Record<string, ObjectEntry[]>; target: Record<string, ObjectEntry[]> };
  siteTenants?: readonly string[];
  /** Tenants every owner's registry names; none by default. */
  targetTenants?: readonly string[];
  /** Per tenant, the row encodings the owner exports for a unit without a migratable legacy table. */
  targetOnly?: Record<string, readonly string[]>;
  /** Fixture capability; loaded by default. */
  fixtures?: FixtureStatus;
  /** Qualified names of the tables the legacy database holds; every unit table by default. */
  liveTables?: readonly string[];
  /** Unit tables whose shape read finds no table, as `describeUnitTable` does for a table the database lacks. */
  missingTables?: readonly string[];
}

interface Calls {
  shapes: string[];
  resolverDatabases: string[];
  legacyRowDatabases: string[];
  targetRows: { unit: string; tenantId: string; includeObjects: boolean }[];
  targetObjects: { owner: string; unit: string; tenantId: string }[];
  targetOnlyRows: { owner: string; unit: string; tenantId: string }[];
  legacyObjects: unknown[];
  legacyTableDatabases: string[];
  targetTenantOwners: string[];
}

const LOADED: FixtureStatus = { available: true, reason: 'fixtures loaded', checkedAt: '2026-06-30T00:00:00.000Z' };
const UNAVAILABLE: FixtureStatus = { available: false, reason: 'cfpm package list unavailable', checkedAt: '2026-06-30T00:00:00.000Z' };
const SKIP_REASON = 'fixtures unavailable: cfpm package list unavailable';

/** Ref of a migration-wide table name: bare names are `dbo`. */
function refOf(qualified: string): LegacyTableRef {
  const dot = qualified.indexOf('.');
  return dot < 0 ? { schema: 'dbo', table: qualified, qualified } : { schema: qualified.slice(0, dot), table: qualified.slice(dot + 1), qualified };
}

function fakeSources(fakes: Fakes, calls: Calls): ReconcileSources {
  const sideRows = (data: Data | undefined, shape: UnitTableShape, tenantId: string): CanonicalRow[] =>
    rowsOf(shape, data?.[`${shape.unit}|${shape.legacyTable}`]?.[tenantId] ?? []);
  return {
    tableVersion: () => Promise.resolve('v0002'),
    tenantResolver: (_deps, options) => {
      calls.resolverDatabases.push(options.database);
      const resolver: TenantResolver = {
        prepare: () => Promise.resolve(),
        resolve: () => ({ tenantId: A, orphan: false }),
        siteTenants: () => [...(fakes.siteTenants ?? [A, B, UMBRELLA])],
        readsOtherRows: () => false,
      };
      return Promise.resolve(resolver);
    },
    tableShape: (_deps, options) => {
      calls.shapes.push(`${options.unit}|${options.legacyTable}`);
      if (fakes.missingTables?.includes(options.legacyTable) === true) return Promise.reject(new TableNotFoundError(options.database, options.legacyTable));
      return Promise.resolve(shapeOf(options.unit, options.legacyTable));
    },
    legacyTables: (_deps, options) => {
      calls.legacyTableDatabases.push(options.database);
      const names = fakes.liveTables ?? [...new Set(realCatalog.units().flatMap((unit) => unit.legacyTables))];
      return Promise.resolve(names.map(refOf));
    },
    fixtureStatus: () => Promise.resolve(fakes.fixtures ?? LOADED),
    legacyRows: (_deps, shape, options) => {
      calls.legacyRowDatabases.push(options.database);
      const tables = fakes.legacy?.[`${shape.unit}|${shape.legacyTable}`] ?? {};
      const byTenant = new Map(Object.keys(tables).map((tenantId) => [tenantId, sideRows(fakes.legacy, shape, tenantId)]));
      return Promise.resolve({
        tenants: [...byTenant.keys()].sort(),
        counts: new Map([...byTenant].map(([tenantId, rows]) => [tenantId, rows.length])),
        rows: (tenantId: string) => byTenant.get(tenantId) ?? [],
        orphans: new Map(Object.entries(fakes.orphans ?? {}).map(([tenantId, keys]) => [tenantId, { keys: [...keys], count: keys.length }])),
        objects: new Map(shape.objectColumns.length > 0 ? Object.entries(fakes.columnObjects?.legacy ?? {}) : []),
        dispose: () => Promise.resolve(),
      });
    },
    targetRows: (_deps, shape, tenantId, options) => {
      const includeObjects = options?.includeObjects === true;
      calls.targetRows.push({ unit: shape.unit, tenantId, includeObjects });
      const columnObjects = shape.objectColumns.length > 0 ? [...(fakes.columnObjects?.target[tenantId] ?? [])] : null;
      const objects = includeObjects ? [...(fakes.targetObjects?.[tenantId] ?? [])] : columnObjects;
      const rows = sideRows(fakes.target, shape, tenantId);
      return Promise.resolve({ rows, count: rows.length, objects, dispose: () => Promise.resolve() });
    },
    targetObjects: (_deps, source, tenantId) => {
      calls.targetObjects.push({ owner: source.owner, unit: source.unit, tenantId });
      return Promise.resolve([...(fakes.targetObjects?.[tenantId] ?? [])]);
    },
    targetOnlyRows: (_deps, source, tenantId) => {
      calls.targetOnlyRows.push({ owner: source.owner, unit: source.unit, tenantId });
      const encodings = [...(fakes.targetOnly?.[tenantId] ?? [])].sort();
      const rows = encodings.map((encoding): CanonicalRow => ({ table: source.unit, key: encoding, keyValues: [], encoding, row: {} }));
      return Promise.resolve({ rows, count: rows.length, objects: null, dispose: () => Promise.resolve() });
    },
    legacyObjects: (_deps, options) => {
      calls.legacyObjects.push(options);
      return Promise.resolve(fakes.legacyObjects ?? { status: 'compared', byTenant: new Map() });
    },
    targetTenants: (_deps, owner) => {
      calls.targetTenantOwners.push(owner);
      return Promise.resolve([...(fakes.targetTenants ?? [])]);
    },
  };
}

interface SnapshotSpec {
  seq: number;
  kind: string;
  state?: string;
}

/** `migration.snapshot` rows answering `getSnapshot`, `latestSnapshot` and `latestSnapshotOfKind`. */
function fakeDb(snapshots: readonly SnapshotSpec[]): TenantDb {
  const rowOf = (spec: SnapshotSpec) => ({
    seq: spec.seq,
    kind: spec.kind,
    state: spec.state ?? 'ready',
    database_name: `${LIVE_DB}_opt2_snap_${String(spec.seq)}`,
    backup_file: `snap-${String(spec.seq)}.bak`,
    checkpoint_lsn: '1',
    last_lsn: '2',
    taken_at: new Date('2026-06-30T00:00:00Z'),
    transition_id: null,
    source_sha: PIN_SHA,
    manifest_complete: true,
    objects: 0,
  });
  const query = (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('WHERE s.seq = $1')) return Promise.resolve({ rows: snapshots.filter((spec) => spec.seq === params[0]).map(rowOf) });
    const ofKind = sql.includes('WHERE s.kind = $1') ? snapshots.filter((spec) => spec.kind === params[0]) : snapshots;
    const ready = ofKind.filter((spec) => (spec.state ?? 'ready') === 'ready').sort((a, b) => b.seq - a.seq);
    return Promise.resolve({ rows: ready.slice(0, 1).map(rowOf) });
  };
  return { schema: 'migration', withMetadata: (fn: (tx: { query: typeof query }) => unknown) => fn({ query }) } as unknown as TenantDb;
}

let reportsDir: string;
let calls: Calls;

function contextOf(
  over: { snapshots?: readonly SnapshotSpec[]; catalog?: UnitCatalog; tableVersion?: string | null; stateDir?: string } = {},
): ReconcileContext {
  const ctx = {
    env: { MURA_DATABASE: LIVE_DB, OPT2_REPORTS_DIR: reportsDir, OPT2_STATE_DIR: over.stateDir ?? path.join(reportsDir, 'state') },
    config,
    clock: fixedClock('2026-06-30T12:00:00.000Z'),
    db: fakeDb(over.snapshots ?? [{ seq: 0, kind: 'seed' }]),
    catalog: over.catalog ?? realCatalog,
    gateway: { status: () => Promise.resolve({ tableVersion: over.tableVersion ?? null, epoch: 1 }) },
    legacy: {},
    bridge: {},
    owners: {},
  };
  return ctx as unknown as ReconcileContext;
}

/** The real catalog with `content.file_object` listed as a unit fed by `tfiles`, to reach the catalogued file-unit path. */
function catalogWithFileUnit(): UnitCatalog {
  const extra: Unit = { id: FILE_UNIT, owner: 'strategies-content', schema: 'content', legacyTables: ['tfiles', 'tcontentfilemetadata'] };
  return {
    ...realCatalog,
    units: () => [...realCatalog.units(), extra],
    unit: (id) => (id === FILE_UNIT ? extra : realCatalog.unit(id)),
    legacyTablesOf: (id) => (id === FILE_UNIT ? extra.legacyTables : realCatalog.legacyTablesOf(id)),
  };
}

const PERSON = 'people.person|tusers';
const STATS = 'communications.email_stat|temailstats';
const ann = { UserID: 'U1', Fname: 'Ann' };
const bob = { UserID: 'U2', Fname: 'Bob' };
const sent = { EmailID: 'E1', Status: '1' };
/** A row encoding the owner exports for a unit without a migratable legacy table. */
const TASK = 's3:T01s9:scheduled';

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(os.tmpdir(), 'reconcile-index-'));
  calls = {
    shapes: [],
    resolverDatabases: [],
    legacyRowDatabases: [],
    targetRows: [],
    targetObjects: [],
    targetOnlyRows: [],
    legacyObjects: [],
    legacyTableDatabases: [],
    targetTenantOwners: [],
  };
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

describe('runReconcile', () => {
  it('reports zero difference for identical data, exits 0 and writes the point report and summary with the pinned SHA', async () => {
    const data: Data = { [PERSON]: { [A]: [ann, bob] } };
    const result = await runReconcile(contextOf(), { point: 'post-cutover', units: ['people.person'] }, fakeSources({ legacy: data, target: data }, calls));

    expect(result).toMatchObject({ point: 'post-cutover', result: 'zero-difference', exitCode: 0 });
    expect(result.summary).toEqual({ units: 1, tenants: 1, unitsWithDifferences: 0, differences: 0, orphans: 0, haltedUnits: 0, skippedUnits: 0, emptyUnits: 0 });
    expect(result.reportPath).toBe(path.join(reportsDir, RECONCILIATION_DIR, 'post-cutover.json'));
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ sourceSha: PIN_SHA, point: 'post-cutover', legacyDatabase: LIVE_DB, legacySource: 'live', snapshotSeq: 0 });
    expect(written.units).toEqual([expect.objectContaining({ unit: 'people.person', legacyTable: 'tusers', tenantId: A, excludedColumns: ['IdentityCol'] })]);
    const summary = await readFile(path.join(reportsDir, RECONCILIATION_DIR, 'summary.md'), 'utf8');
    expect(summary).toContain(`Source SHA: ${PIN_SHA}`);
    expect(summary).toContain('| post-cutover | [post-cutover.json](post-cutover.json) | v0002 | 1 | 0 | 0 | zero-difference |');
  });

  it('records when the comparison began, before the generatedAt of the written report', async () => {
    const times: string[] = [];
    const clock = {
      now: (): Date => {
        const at = new Date(Date.UTC(2026, 5, 30, 12, 0, times.length));
        times.push(at.toISOString());
        return at;
      },
    };
    const data: Data = { [PERSON]: { [A]: [ann] } };
    const ctx = { ...contextOf(), clock } as ReconcileContext;

    const result = await runReconcile(ctx, { point: 'post-cutover', units: ['people.person'] }, fakeSources({ legacy: data, target: data }, calls));

    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as { startedAt: string; generatedAt: string };
    expect(written.startedAt).toBe(times[0]);
    expect(written.generatedAt).toBe(times.at(-1));
    expect(Date.parse(written.startedAt)).toBeLessThan(Date.parse(written.generatedAt));
  });

  it.each<[string, string, Fakes, object]>([
    [
      'a changed field',
      'people.person',
      { legacy: { [PERSON]: { [A]: [ann] } }, target: { [PERSON]: { [A]: [{ ...ann, Fname: 'Anne' }] } } },
      { kind: 'changed', column: 'Fname', legacy: 'Ann', target: 'Anne' },
    ],
    [
      'a missing row',
      'people.person',
      { legacy: { [PERSON]: { [A]: [ann, bob] } }, target: { [PERSON]: { [A]: [ann] } } },
      { kind: 'missing-in-target', column: null, target: null },
    ],
    [
      'a duplicated keyless row',
      'communications.email_stat',
      { legacy: { [STATS]: { [A]: [sent, sent] } }, target: { [STATS]: { [A]: [sent] } } },
      { kind: 'missing-in-target', occurrences: 1 },
    ],
    [
      'a file hash mismatch',
      FILE_UNIT,
      {
        legacyObjects: { status: 'compared', byTenant: new Map([[A, [{ key: `${A}/F1.pdf`, size: 4, sha256: SHA_1 }]]]) },
        targetObjects: { [A]: [{ key: `${A}/F1.pdf`, size: 4, sha256: SHA_2 }] },
      },
      { kind: 'object-mismatch', key: `${A}/F1.pdf`, column: 'sha256', legacy: SHA_1, target: SHA_2 },
    ],
  ])('reports %s as a difference and exits 1', async (_name, unit, fakes, difference) => {
    const ctx = contextOf();
    const result = await runReconcile(ctx, { point: 'post-cutover', units: [unit] }, fakeSources(fakes, calls));

    expect(result).toMatchObject({ result: 'difference', exitCode: 1 });
    expect(result.summary).toMatchObject({ unitsWithDifferences: 1, differences: 1 });
    // The written report digests row values and keys, so values are checked on the in-memory report.
    const { kind, column, occurrences } = difference as { kind: string; column?: string | null; occurrences?: number };
    const shape = { kind, ...(column === undefined ? {} : { column }), ...(occurrences === undefined ? {} : { occurrences }) };
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as { units: unknown[] };
    expect(written.units).toEqual([expect.objectContaining({ unit, tenantId: A, differences: [expect.objectContaining(shape)] })]);
    const report = await reconcileUnits(ctx, { point: 'post-cutover', units: [unit], database: LIVE_DB }, fakeSources(fakes, calls));
    expect(report.units).toEqual([expect.objectContaining({ unit, tenantId: A, differences: [expect.objectContaining(difference)] })]);
  });

  it('reconciles only the units of the roster group set R at a rollback point without --units, fixture tables included when loaded', async () => {
    const rosterUnits = rosterGroupUnits();
    const expected = rosterUnits.flatMap((unit) => realCatalog.legacyTablesOf(unit).map((table) => `${unit}|${table}`));

    const result = await runReconcile(contextOf(), { point: 'rollback-before' }, fakeSources({ fixtures: LOADED, liveTables: MASA_TABLES }, calls));

    expect(result).toMatchObject({ point: 'rollback-before', result: 'zero-difference', exitCode: 0 });
    expect(rosterUnits).toEqual(expect.arrayContaining(['people.person', 'people.person_archive', 'timesheets.blackout']));
    expect([...calls.shapes].sort()).toEqual([...new Set(expected)].sort());
    expect(calls.legacyObjects).toEqual([]);
    expect(calls.legacyTableDatabases).toEqual([]);
    expect(result.summary.skippedUnits).toBe(0);
  });

  it('refuses a rollback point whose rollbackRefs name groups the groups file lacks', async () => {
    const groupsFile = path.join(reportsDir, 'groups.json');
    await writeFile(groupsFile, JSON.stringify({ sourceSha: PIN_SHA, groups: [] }));
    const ctx = { ...contextOf(), config: { ...config, paths: { ...config.paths, groupsFile } } };

    await expect(runReconcile(ctx, { point: 'rollback-after' }, fakeSources({}, calls))).rejects.toThrow(
      /v0003 rollbackRefs name groups missing from .*groups\.json: grp:/,
    );
    expect(calls.shapes).toEqual([]);
  });

  it('reconciles every catalog unit plus the file units when --units is absent', async () => {
    await runReconcile(contextOf({ snapshots: [{ seq: 0, kind: 'seed' }] }), { point: 'after-backfill' }, fakeSources({}, calls));

    const units = new Set(calls.shapes.map((shape) => shape.slice(0, shape.indexOf('|'))));
    expect(units.has('people.person')).toBe(true);
    expect(new Set(calls.targetOnlyRows.map((call) => call.unit))).toEqual(new Set(['communications.scheduled_task']));
    expect(calls.legacyObjects).toEqual([{ legacySource: 'snapshot', snapshotSeq: 0, database: `${LIVE_DB}_opt2_snap_0` }]);
    expect(new Set(calls.targetObjects.map((call) => `${call.owner}:${call.unit}`))).toEqual(new Set(['strategies-content:content.file']));
  });

  it.each([
    ['after-backfill', 0],
    ['after-feed-1', 1],
    ['after-fault-duplicate-batch', 3],
  ])('reads %s from snapshot %i', async (point, seq) => {
    const snapshots = [
      { seq: 0, kind: 'seed' },
      { seq: 1, kind: 'feed' },
      { seq: 2, kind: 'seed', state: 'dropped' },
      { seq: 3, kind: 'checkpoint' },
    ];
    const result = await runReconcile(contextOf({ snapshots }), { point, units: ['people.person'] }, fakeSources({}, calls));

    const database = `${LIVE_DB}_opt2_snap_${String(seq)}`;
    expect(calls.resolverDatabases).toEqual([database]);
    expect(calls.legacyRowDatabases).toEqual([database]);
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ point, snapshotSeq: seq, legacyDatabase: database, legacySource: 'snapshot' });
  });

  it('reads the checkpoint point from the latest checkpoint snapshot, not the latest snapshot', async () => {
    const snapshots = [
      { seq: 0, kind: 'seed' },
      { seq: 1, kind: 'checkpoint' },
      { seq: 2, kind: 'feed' },
    ];
    const result = await runReconcile(contextOf({ snapshots }), { point: 'checkpoint', units: ['people.person'] }, fakeSources({}, calls));

    const database = `${LIVE_DB}_opt2_snap_1`;
    expect(calls.legacyRowDatabases).toEqual([database]);
    expect(result.reportPath).toBe(path.join(reportsDir, RECONCILIATION_DIR, 'checkpoint.json'));
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ point: 'checkpoint', snapshotSeq: 1, legacyDatabase: database, legacySource: 'snapshot' });
  });

  it('reads the live database for a live fault point and records the latest snapshot sequence', async () => {
    const ctx = contextOf({ snapshots: [{ seq: 0, kind: 'seed' }, { seq: 4, kind: 'feed' }] });
    const result = await runReconcile(ctx, { point: 'after-fault-window-import-interrupted', units: ['people.person'] }, fakeSources({}, calls));

    expect(calls.resolverDatabases).toEqual([LIVE_DB]);
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ snapshotSeq: 4, legacySource: 'live', legacyDatabase: LIVE_DB });
  });

  it.each<[string, { point: string; units?: string[] }, SnapshotSpec[]]>([
    ['an unknown point', { point: 'after-everything' }, [{ seq: 0, kind: 'seed' }]],
    ['an unknown unit', { point: 'post-cutover', units: ['people.nobody'] }, [{ seq: 0, kind: 'seed' }]],
    ['an empty unit list', { point: 'post-cutover', units: [] }, [{ seq: 0, kind: 'seed' }]],
    ['a missing feed snapshot', { point: 'after-feed-3', units: ['people.person'] }, [{ seq: 0, kind: 'seed' }]],
    ['no backfill snapshot', { point: 'after-backfill', units: ['people.person'] }, [{ seq: 0, kind: 'feed' }]],
    ['no checkpoint snapshot', { point: 'checkpoint', units: ['people.person'] }, [{ seq: 0, kind: 'seed' }]],
    ['no snapshot at all', { point: 'after-fault-duplicate-batch', units: ['people.person'] }, []],
    ['a snapshot not ready', { point: 'after-feed-1', units: ['people.person'] }, [{ seq: 1, kind: 'feed', state: 'creating' }]],
  ])('rejects %s with ReconcileUsageError', async (_name, options, snapshots) => {
    const error: unknown = await runReconcile(contextOf({ snapshots }), options, fakeSources({}, calls)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReconcileUsageError);
    expect((error as ReconcileUsageError).exitCode).toBe(2);
    expect(calls.shapes).toEqual([]);
  });

  it.each<[string, string[], Fakes, string]>([
    ['a fixture unit whose tables the database lacks', ['people.person', 'finance.record'], { fixtures: UNAVAILABLE, liveTables: MASA_TABLES }, `finance.record (${SKIP_REASON})`],
    ['a file unit of a halted store', [FILE_UNIT], { legacyObjects: { status: 'halted', store: 's3', reason: 'store is s3' } }, `${FILE_UNIT} (store is s3)`],
  ])('refuses a --units run naming %s before comparing or writing anything', async (_name, units, fakes, uncompared) => {
    const error: unknown = await runReconcile(contextOf(), { point: 'post-cutover', units }, fakeSources(fakes, calls)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReconcileUsageError);
    expect((error as ReconcileUsageError).message).toBe(`Requested units compare nothing at post-cutover: ${uncompared}`);
    expect(calls.shapes).toEqual([]);
    await expect(readFile(path.join(reportsDir, RECONCILIATION_DIR, 'post-cutover.json'))).rejects.toThrow();
  });

  it('accepts a file unit in --units although the catalog does not list it', async () => {
    const result = await runReconcile(contextOf(), { point: 'post-cutover', units: [FILE_UNIT, FILE_UNIT] }, fakeSources({}, calls));

    expect(result.exitCode).toBe(0);
    expect(calls.legacyObjects).toHaveLength(1);
  });
});

describe('reconcileUnits', () => {
  it('rejects an unknown point', async () => {
    await expect(reconcileUnits(contextOf(), { point: 'nope', units: [], database: LIVE_DB }, fakeSources({}, calls))).rejects.toBeInstanceOf(
      ReconcileUsageError,
    );
  });

  it('takes the table version from the gateway status by default and writes no file', async () => {
    const { tableVersion: _omit, ...sources } = fakeSources({ legacy: { [PERSON]: { [A]: [ann] } }, target: { [PERSON]: { [A]: [ann] } } }, calls);
    const report = await reconcileUnits(contextOf({ tableVersion: 'v0002' }), { point: 'post-cutover', units: ['people.person'], database: LIVE_DB }, sources);

    expect(report).toMatchObject({ tableVersion: 'v0002', tableVersionMatches: true, snapshotSeq: null, result: 'zero-difference' });
    expect(report.fileStore).toEqual({ store: null, status: 'not-applicable', haltedUnits: [] });
    await expect(readFile(path.join(reportsDir, RECONCILIATION_DIR, 'post-cutover.json'))).rejects.toThrow();
  });

  it('skips tenants empty on both sides, reports target-only rows and lists orphans', async () => {
    const fakes: Fakes = {
      legacy: { [PERSON]: { [UMBRELLA]: [ann] } },
      target: { [PERSON]: { [UMBRELLA]: [ann], [B]: [bob] } },
      orphans: { [UMBRELLA]: ['s2:U1'] },
    };
    const report = await reconcileUnits(contextOf(), { point: 'post-cutover', units: ['people.person'], database: LIVE_DB }, fakeSources(fakes, calls));

    expect(calls.targetRows.map((call) => call.tenantId)).toEqual([A, B, UMBRELLA].sort());
    expect(report.units.map((entry) => entry.tenantId)).toEqual([B, UMBRELLA].sort());
    expect(report.units.find((entry) => entry.tenantId === B)?.differences).toEqual([expect.objectContaining({ kind: 'extra-in-target' })]);
    expect(report.units.find((entry) => entry.tenantId === UMBRELLA)).toMatchObject({ orphans: ['s2:U1'], orphanCount: 1, differenceCount: 0 });
    expect(report.summary).toMatchObject({ orphans: 1, unitsWithDifferences: 1 });
  });

  it('compares the tenants only the owner registry names, asking each owner once per run', async () => {
    const targetOnly = tenantIdForSite('target-only');
    const favorite = 'people.user_favorite|tusersfavorites';
    const fakes: Fakes = { target: { [PERSON]: { [targetOnly]: [ann] }, [favorite]: { [targetOnly]: [bob] } }, targetTenants: [targetOnly] };
    const report = await reconcileUnits(
      contextOf(),
      { point: 'post-cutover', units: ['people.person', 'people.user_favorite'], database: LIVE_DB },
      fakeSources(fakes, calls),
    );

    expect(calls.targetTenantOwners).toEqual(['people']);
    expect(calls.targetRows.filter((call) => call.unit === 'people.person').map((call) => call.tenantId)).toEqual([A, B, UMBRELLA, targetOnly].sort());
    expect(report.units.map((entry) => [entry.unit, entry.tenantId, entry.legacyCount, entry.targetCount])).toEqual([
      ['people.person', targetOnly, 0, 1],
      ['people.user_favorite', targetOnly, 0, 1],
    ]);
    expect(report.units.every((entry) => entry.differences.every((difference) => difference.kind === 'extra-in-target'))).toBe(true);
    expect(report).toMatchObject({ result: 'difference', summary: { unitsWithDifferences: 2, differences: 2 } });
  });

  it.each<[string, string, string | null]>([
    ['a unit table', 'people.person_archive', 'synthetic.person_archive'],
    ['an uncatalogued file unit', FILE_UNIT, null],
  ])('keeps the 0=0 entry of every compared tenant for %s empty on both sides', async (_name, unit, legacyTable) => {
    const targetOnly = tenantIdForSite('target-only');
    const fakes: Fakes = {
      legacy: { [PERSON]: { [A]: [ann] } },
      target: { [PERSON]: { [A]: [ann] } },
      siteTenants: [A, UMBRELLA],
      targetTenants: [targetOnly],
      legacyObjects: { status: 'compared', byTenant: new Map() },
    };
    const report = await reconcileUnits(contextOf(), { point: 'post-cutover', units: [unit, 'people.person'], database: LIVE_DB }, fakeSources(fakes, calls));

    const empty = report.units.filter((entry) => entry.unit === unit);
    expect(empty.map((entry) => [entry.legacyTable, entry.tenantId, entry.legacyCount, entry.targetCount, entry.differenceCount])).toEqual(
      [A, UMBRELLA, targetOnly].sort().map((tenantId) => [legacyTable, tenantId, 0, 0, 0]),
    );
    expect(report.units.filter((entry) => entry.unit === 'people.person').map((entry) => entry.tenantId)).toEqual([A]);
    expect(report).toMatchObject({ result: 'zero-difference', summary: { units: 2, tenants: 3, differences: 0 } });
  });

  it.each<[string, Record<string, readonly string[]>, (targetOnly: string) => [string, number, object[]][]]>([
    ['the 0=0 entry of every compared tenant when it exports nothing', {}, (targetOnly) => [A, B, UMBRELLA, targetOnly].sort().map((tenantId) => [tenantId, 0, []])],
    [
      'an exported row as extra in the target',
      { [tenantIdForSite('target-only')]: [TASK] },
      (targetOnly) => [[targetOnly, 1, [{ kind: 'extra-in-target', key: sha256Hex(TASK), column: null, legacy: null, target: TASK, occurrences: 1 }]]],
    ],
  ])('compares a unit without a migratable legacy table with its owner export over no legacy rows, reporting %s', async (_name, targetOnly, expected) => {
    const targetTenant = tenantIdForSite('target-only');
    const report = await reconcileUnits(
      contextOf(),
      { point: 'post-cutover', units: ['communications.scheduled_task', 'people.person'], database: LIVE_DB, requireEveryUnit: true },
      fakeSources({ targetOnly, targetTenants: [targetTenant] }, calls),
    );

    const tenants = [A, B, UMBRELLA, targetTenant].sort();
    expect(calls.targetOnlyRows).toEqual(tenants.map((tenantId) => ({ owner: 'communications', unit: 'communications.scheduled_task', tenantId })));
    expect(calls.shapes).toEqual([PERSON]);
    const entries = report.units.filter((entry) => entry.unit === 'communications.scheduled_task');
    expect(entries.map((entry) => [entry.tenantId, entry.targetCount, entry.differences])).toEqual(expected(targetTenant));
    expect(entries.every((entry) => entry.owner === 'communications' && entry.legacyTable === null && entry.legacyCount === 0 && entry.files === null)).toBe(true);
    expect(report.skippedUnits).toEqual([]);
    expect(report.result).toBe(Object.keys(targetOnly).length === 0 ? 'zero-difference' : 'difference');
  });

  it('lists the unit tables and file units compared empty on both sides in every tenant and counts them among the units', async () => {
    const [archiveTable] = realCatalog.legacyTablesOf('people.person_archive');
    const blackoutTables = realCatalog.legacyTablesOf('timesheets.blackout').filter((table) => realCatalog.isMigratable(table));
    const archive = `people.person_archive|${archiveTable ?? ''}`;
    const fakes: Fakes = {
      legacy: { [archive]: { [A]: [ann] } },
      target: { [archive]: { [A]: [ann] } },
      legacyObjects: { status: 'compared', byTenant: new Map() },
    };
    const report = await reconcileUnits(
      contextOf(),
      { point: 'rollback-before', units: ['timesheets.blackout', 'people.person_archive', FILE_UNIT], database: LIVE_DB },
      fakeSources(fakes, calls),
    );

    const tenants = [A, B, UMBRELLA].sort();
    expect(blackoutTables.length).toBeGreaterThan(0);
    expect(report.units.filter((entry) => entry.legacyCount + entry.targetCount > 0).map((entry) => `${entry.unit}/${entry.tenantId}`)).toEqual([
      `people.person_archive/${A}`,
    ]);
    expect(
      report.units
        .filter((entry) => entry.unit !== 'people.person_archive')
        .map((entry) => [entry.unit, entry.legacyTable, entry.tenantId, entry.legacyCount, entry.targetCount, entry.differenceCount]),
    ).toEqual([
      ...tenants.map((tenantId) => [FILE_UNIT, null, tenantId, 0, 0, 0]),
      ...[...blackoutTables].sort().flatMap((legacyTable) => tenants.map((tenantId) => ['timesheets.blackout', legacyTable, tenantId, 0, 0, 0])),
    ]);
    expect(report.emptyUnits).toEqual([
      { unit: FILE_UNIT, legacyTable: null },
      ...[...blackoutTables].sort().map((legacyTable) => ({ unit: 'timesheets.blackout', legacyTable })),
    ]);
    expect(report.summary).toMatchObject({ units: 3, emptyUnits: 2, unitsWithDifferences: 0, skippedUnits: 0 });
    expect(report.result).toBe('zero-difference');
  });

  it("compares an uncatalogued file unit's objects through the export of the unit fed by tfiles", async () => {
    const entry = { key: `${A}/F1.pdf`, size: 4, sha256: SHA_1 };
    const orphan = { key: `${UMBRELLA}/F9.pdf`, size: 1, sha256: SHA_2, orphan: true };
    const fakes: Fakes = {
      siteTenants: [A, B],
      legacyObjects: { status: 'compared', byTenant: new Map([[A, [entry]], [UMBRELLA, [orphan]]]) },
      targetObjects: { [A]: [entry], [UMBRELLA]: [orphan] },
    };
    const report = await reconcileUnits(contextOf(), { point: 'post-cutover', units: [FILE_UNIT], database: LIVE_DB }, fakeSources(fakes, calls));

    expect(calls.targetObjects).toEqual([A, B, UMBRELLA].sort().map((tenantId) => ({ owner: 'strategies-content', unit: 'content.file', tenantId })));
    expect(report.units).toHaveLength(2);
    expect(report.units.every((unit) => unit.legacyTable === null && unit.legacyCount === 0 && unit.files?.legacyObjects === 1)).toBe(true);
    expect(report).toMatchObject({ result: 'zero-difference', fileStore: { store: 'fileDir', status: 'compared', haltedUnits: [] } });
  });

  it('compares objects on the first migratable table of a catalogued file unit only', async () => {
    const entry = { key: `${A}/F1.pdf`, size: 4, sha256: SHA_1 };
    const fakes: Fakes = {
      siteTenants: [A],
      legacyObjects: { status: 'compared', byTenant: new Map([[A, [entry]]]) },
      targetObjects: { [A]: [] },
    };
    const ctx = contextOf({ catalog: catalogWithFileUnit() });
    const report = await reconcileUnits(ctx, { point: 'post-cutover', units: [FILE_UNIT], database: LIVE_DB }, fakeSources(fakes, calls));

    expect(calls.shapes).toEqual([`${FILE_UNIT}|tfiles`, `${FILE_UNIT}|tcontentfilemetadata`]);
    expect(calls.targetRows).toEqual([
      { unit: FILE_UNIT, tenantId: A, includeObjects: true },
      { unit: FILE_UNIT, tenantId: A, includeObjects: false },
    ]);
    expect(report.units).toEqual([
      expect.objectContaining({ legacyTable: 'tcontentfilemetadata', files: null, legacyCount: 0, targetCount: 0, differenceCount: 0 }),
      expect.objectContaining({ legacyTable: 'tfiles', differences: [expect.objectContaining({ kind: 'object-missing-in-target', key: entry.key })] }),
    ]);
    expect(report.result).toBe('difference');
  });

  it.each<[string, ObjectEntry, 'zero-difference' | 'difference', object[]]>([
    ['equal bytes', { key: 'Program_1.finance_attachment/AT1', size: 4, sha256: SHA_1 }, 'zero-difference', []],
    [
      'a changed stored hash',
      { key: 'Program_1.finance_attachment/AT1', size: 4, sha256: SHA_2 },
      'difference',
      [expect.objectContaining({ kind: 'object-mismatch', key: 'Program_1.finance_attachment/AT1', column: 'sha256', legacy: SHA_1, target: SHA_2 })],
    ],
  ])("compares an object-column unit's values with its owner's manifest, outside the file store, for %s", async (_name, stored, result, differences) => {
    const attachments = `finance.attachment|${ATTACHMENT_TABLE}`;
    const fakes: Fakes = {
      siteTenants: [A],
      legacy: { [attachments]: { [A]: [ann] } },
      target: { [attachments]: { [A]: [ann] } },
      columnObjects: { legacy: { [A]: [{ key: 'Program_1.finance_attachment/AT1', size: 4, sha256: SHA_1, orphan: false }] }, target: { [A]: [stored] } },
    };
    const report = await reconcileUnits(contextOf(), { point: 'post-cutover', units: ['finance.attachment'], database: LIVE_DB }, fakeSources(fakes, calls));

    expect(calls.legacyObjects).toEqual([]);
    expect(calls.targetRows).toEqual([{ unit: 'finance.attachment', tenantId: A, includeObjects: false }]);
    expect(report).toMatchObject({ result, fileStore: { store: null, status: 'not-applicable', haltedUnits: [] } });
    expect(report.units).toEqual([
      expect.objectContaining({ unit: 'finance.attachment', legacyTable: ATTACHMENT_TABLE, tenantId: A, files: expect.objectContaining({ legacyObjects: 1, targetObjects: 1 }), differences }),
    ]);
  });

  it('skips the file units of a halted store and leaves the result to the other units', async () => {
    const fakes: Fakes = { legacyObjects: { status: 'halted', store: 's3', reason: 'store is s3' } };
    const report = await reconcileUnits(
      contextOf(),
      { point: 'post-cutover', units: [FILE_UNIT, 'people.person'], database: LIVE_DB },
      fakeSources(fakes, calls),
    );

    expect(report.fileStore).toEqual({ store: 's3', status: 'halted', reason: 'store is s3', haltedUnits: [FILE_UNIT] });
    expect(report.summary.haltedUnits).toBe(1);
    expect(calls.targetObjects).toEqual([]);
    expect(calls.shapes).toEqual([PERSON]);
    expect(report.result).toBe('zero-difference');
  });

  it('propagates a failed target read', async () => {
    const sources = { ...fakeSources({}, calls), targetRows: () => Promise.reject(new Error('owner unreachable')) };
    await expect(reconcileUnits(contextOf(), { point: 'post-cutover', units: ['people.person'], database: LIVE_DB }, sources)).rejects.toThrow(
      'owner unreachable',
    );
  });

  it('rejects a file unit when no unit of its schema is fed by tfiles', async () => {
    const catalog: UnitCatalog = { ...realCatalog, units: () => realCatalog.units().filter((unit) => unit.id !== 'content.file') };
    const fakes: Fakes = { legacyObjects: { status: 'compared', byTenant: new Map() } };
    await expect(
      reconcileUnits(contextOf({ catalog }), { point: 'post-cutover', units: [FILE_UNIT], database: LIVE_DB }, fakeSources(fakes, calls)),
    ).rejects.toThrow('No content unit is fed by tfiles');
  });
});

/** Migratable tables of `units`: the fixture ones as skip entries, the Masa ones as `unit|table` shape keys. */
function unitTablesOf(units: readonly string[]): { fixture: { unit: string; legacyTable: string }[]; masa: string[] } {
  const tables = [...new Set(units)].flatMap((unit) =>
    realCatalog
      .legacyTablesOf(unit)
      .filter((table) => realCatalog.isMigratable(table))
      .map((legacyTable) => ({ unit, legacyTable })),
  );
  return {
    fixture: tables.filter((entry) => FIXTURE_TABLES.has(entry.legacyTable)),
    masa: tables.filter((entry) => !FIXTURE_TABLES.has(entry.legacyTable)).map((entry) => `${entry.unit}|${entry.legacyTable}`),
  };
}

function byUnitAndTable(a: { unit: string; legacyTable: string }, b: { unit: string; legacyTable: string }): number {
  const text = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  return text(a.unit, b.unit) || text(a.legacyTable, b.legacyTable);
}

/** Units the default selection takes: every catalog unit. */
function defaultSelection(): string[] {
  return realCatalog.units().map((unit) => unit.id);
}

describe('fixture-backed units', () => {
  it.each<[string, { point: string; units?: string[] }, () => string[], string, FixtureStatus, string]>([
    ['the default after-backfill selection', { point: 'after-backfill' }, defaultSelection, `${LIVE_DB}_opt2_snap_0`, UNAVAILABLE, SKIP_REASON],
    ['the roster group set R of a rollback point', { point: 'rollback-after' }, rosterGroupUnits, LIVE_DB, { ...UNAVAILABLE, reason: null }, 'fixtures unavailable'],
  ])('compares the Masa tables of %s and lists its absent fixture tables as skipped', async (_name, options, selected, database, fixtures, reason) => {
    const { fixture, masa } = unitTablesOf(selected());

    const result = await runReconcile(contextOf(), options, fakeSources({ fixtures, liveTables: MASA_TABLES }, calls));

    expect(fixture.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ result: 'zero-difference', exitCode: 0 });
    expect([...new Set(calls.shapes)].sort()).toEqual([...new Set(masa)].sort());
    expect(calls.legacyTableDatabases).toEqual([database]);
    expect(result.summary).toMatchObject({ skippedUnits: new Set(fixture.map((entry) => entry.unit)).size, differences: 0 });
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as { skippedUnits: unknown; summary: { skippedUnits: unknown } };
    expect(written.skippedUnits).toEqual(fixture.map((entry) => ({ ...entry, reason })).sort(byUnitAndTable));
    expect(written.summary.skippedUnits).toBe(result.summary.skippedUnits);
  });

  it('compares the fixture tables a database holds although the status reads unavailable, Program_<id> parts folded', async () => {
    const { fixture } = unitTablesOf(rosterGroupUnits());
    const physical = fixture.flatMap(({ legacyTable }) =>
      legacyTable.startsWith('Program_N.') ? ['Program_1', 'Program_2'].map((schema) => `${schema}${legacyTable.slice('Program_N'.length)}`) : [legacyTable],
    );

    const result = await runReconcile(contextOf(), { point: 'rollback-before' }, fakeSources({ fixtures: UNAVAILABLE, liveTables: [...MASA_TABLES, ...physical] }, calls));

    expect(physical).toEqual(expect.arrayContaining(['Program_1.blackout', 'Program_2.blackout', 'synthetic.person_archive']));
    expect(calls.shapes).toEqual(expect.arrayContaining(fixture.map((entry) => `${entry.unit}|${entry.legacyTable}`)));
    expect(result.summary.skippedUnits).toBe(0);
    expect(calls.legacyTableDatabases).toEqual([LIVE_DB]);
  });

  it.each<[string, FixtureStatus, string[], string, string[]]>([
    ['Masa table while the fixtures are unavailable', UNAVAILABLE, ['people.person', 'finance.record'], 'tusers', ['Program_1.finance_record']],
    ['fixture table while the fixtures are loaded', LOADED, ['finance.record'], 'Program_N.finance_record', []],
  ])('stops on a missing %s', async (_name, fixtures, units, missing, present) => {
    const liveTables = [...MASA_TABLES.filter((table) => table !== missing), ...present];

    const error: unknown = await runReconcile(contextOf(), { point: 'post-cutover', units }, fakeSources({ fixtures, liveTables, missingTables: [missing] }, calls)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TableNotFoundError);
    expect(calls.shapes.at(-1)).toMatch(new RegExp(`\\|${missing.replace('.', '\\.')}$`));
    expect(calls.legacyTableDatabases).toEqual(fixtures.available ? [] : [LIVE_DB]);
    await expect(readFile(path.join(reportsDir, RECONCILIATION_DIR, 'post-cutover.json'))).rejects.toThrow();
  });

  it.each<[string, FixtureStatus | null, string]>([
    ['a missing fixtures.json as unavailable', null, 'fixtures unavailable: fixtures.json not found'],
    ['the recorded reason of an unavailable status', { ...UNAVAILABLE, reason: 'Mailpit unavailable' }, 'fixtures unavailable: Mailpit unavailable'],
  ])('reads the status from OPT2_STATE_DIR, reporting %s', async (_name, status, reason) => {
    const stateDir = path.join(reportsDir, 'state');
    if (status !== null) {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, 'fixtures.json'), JSON.stringify(status));
    }
    const sources: ReconcileSources = { ...fakeSources({ liveTables: MASA_TABLES }, calls), fixtureStatus: undefined };

    const report = await reconcileUnits(contextOf({ stateDir }), { point: 'post-cutover', units: ['finance.record'], database: LIVE_DB }, sources);

    expect(report.skippedUnits).toEqual([{ unit: 'finance.record', legacyTable: 'Program_N.finance_record', reason }]);
    expect(report.units).toEqual([]);
    expect(report.result).toBe('zero-difference');
  });

  it.each<[string, (file: string) => Promise<void>, RegExp]>([
    ['not JSON', (file) => writeFile(file, '{'), /fixtures\.json is not valid JSON/],
    ['off its schema', (file) => writeFile(file, JSON.stringify({ available: 'no', reason: null, checkedAt: '' })), /fixtures\.json is invalid: available: .*; checkedAt: /],
    ['unreadable', (file) => mkdir(file), /fixtures\.json cannot be read: /],
  ])('throws FixtureStatusError for a fixtures.json %s', async (_name, write, message) => {
    const stateDir = path.join(reportsDir, 'state');
    await mkdir(stateDir, { recursive: true });
    await write(path.join(stateDir, 'fixtures.json'));
    const sources: ReconcileSources = { ...fakeSources({ liveTables: MASA_TABLES }, calls), fixtureStatus: undefined };

    const error: unknown = await reconcileUnits(contextOf({ stateDir }), { point: 'post-cutover', units: ['finance.record'], database: LIVE_DB }, sources).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(FixtureStatusError);
    expect((error as Error).message).toMatch(message);
    expect(calls.shapes).toEqual([]);
  });

  it.each<[string, string | null, RegExp]>([
    ['missing', null, /cannot be read as JSON/],
    ['without its table list', JSON.stringify({ units: [] }), /is invalid: tables: /],
  ])('throws UnitCatalogError for an ownership file %s', async (_name, text, message) => {
    const tableOwnership = path.join(reportsDir, 'table-ownership.json');
    if (text !== null) await writeFile(tableOwnership, text);
    const ctx = { ...contextOf(), config: { ...config, paths: { ...config.paths, tableOwnership } } };

    const error: unknown = await reconcileUnits(ctx, { point: 'post-cutover', units: ['people.person'], database: LIVE_DB }, fakeSources({}, calls)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnitCatalogError);
    expect((error as Error).message).toMatch(message);
  });

  it('lists the tables of the database read through its pool by default', async () => {
    const database = 'muradb_reconcile_list';
    const opened: string[] = [];
    const statements: string[] = [];
    const pool = {
      config: { database },
      request: () => ({
        query: (text: string) => {
          statements.push(text);
          if (text.includes('Updateability')) return Promise.resolve({ recordset: [{ updateability: 'READ_ONLY' }] });
          return Promise.resolve({ recordset: MASA_TABLES.map(refOf).map((ref) => ({ schema_name: ref.schema, table_name: ref.table })) });
        },
      }),
    };
    const legacy = {
      database: (name: string) => {
        opened.push(name);
        return Promise.resolve(pool);
      },
    };
    const ctx = { ...contextOf(), legacy } as unknown as ReconcileContext;
    const sources: ReconcileSources = { ...fakeSources({ fixtures: UNAVAILABLE }, calls), legacyTables: undefined };

    const report = await reconcileUnits(ctx, { point: 'post-cutover', units: ['finance.rollup', 'people.person'], database }, sources);

    expect(opened).toEqual([database]);
    expect(statements.filter((text) => text.includes('sys.tables'))).toHaveLength(1);
    expect(report.skippedUnits).toEqual([{ unit: 'finance.rollup', legacyTable: 'Program_N.finance_rollup', reason: SKIP_REASON }]);
    expect(calls.shapes).toEqual(unitTablesOf(['people.person']).masa);
  });
});
