// Unit tests for the reconciliation entry points over the real catalog and config, with fake reads, snapshots and gateway.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CanonicalColumn } from '@opt2/platform/migration-kit';
import { fixedClock } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { loadGroups, loadVersion } from '../../src/cutover/index.js';
import { loadUnitCatalog, type Unit, type UnitCatalog } from '../../src/owners/index.js';
import type { CanonicalRow } from '../../src/extract/index.js';
import {
  RECONCILIATION_DIR,
  ReconcileUsageError,
  reconcileUnits,
  runReconcile,
  toUnitRow,
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

const PERSON_COLUMNS: CanonicalColumn[] = [
  { name: 'UserID', type: 's' },
  { name: 'Fname', type: 's' },
];
const STATS_COLUMNS: CanonicalColumn[] = [
  { name: 'EmailID', type: 's' },
  { name: 'Status', type: 'i' },
];

/** Shape of a unit table: `temailstats` keyless, everything else keyed on its first column. */
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
  siteTenants?: readonly string[];
}

interface Calls {
  shapes: string[];
  resolverDatabases: string[];
  legacyRowDatabases: string[];
  targetRows: { unit: string; tenantId: string; includeObjects: boolean }[];
  targetObjects: { owner: string; unit: string; tenantId: string }[];
  legacyObjects: unknown[];
}

function fakeSources(fakes: Fakes, calls: Calls): ReconcileSources {
  const sideRows = (data: Data | undefined, shape: UnitTableShape, tenantId: string): CanonicalRow[] =>
    rowsOf(shape, data?.[`${shape.unit}|${shape.legacyTable}`]?.[tenantId] ?? []);
  return {
    tableVersion: () => Promise.resolve('v0002'),
    tenantResolver: (_deps, options) => {
      calls.resolverDatabases.push(options.database);
      const resolver: TenantResolver = {
        resolve: () => ({ tenantId: A, orphan: false }),
        siteTenants: () => [...(fakes.siteTenants ?? [A, B, UMBRELLA])],
      };
      return Promise.resolve(resolver);
    },
    tableShape: (_deps, options) => {
      calls.shapes.push(`${options.unit}|${options.legacyTable}`);
      return Promise.resolve(shapeOf(options.unit, options.legacyTable));
    },
    legacyRows: (_deps, shape, options) => {
      calls.legacyRowDatabases.push(options.database);
      const tables = fakes.legacy?.[`${shape.unit}|${shape.legacyTable}`] ?? {};
      const byTenant = new Map(Object.keys(tables).map((tenantId) => [tenantId, sideRows(fakes.legacy, shape, tenantId)]));
      return Promise.resolve({ byTenant, orphans: new Map(Object.entries(fakes.orphans ?? {}).map(([tenantId, keys]) => [tenantId, [...keys]])) });
    },
    targetRows: (_deps, shape, tenantId, options) => {
      const includeObjects = options?.includeObjects === true;
      calls.targetRows.push({ unit: shape.unit, tenantId, includeObjects });
      const objects = includeObjects ? [...(fakes.targetObjects?.[tenantId] ?? [])] : null;
      return Promise.resolve({ rows: sideRows(fakes.target, shape, tenantId), objects });
    },
    targetObjects: (_deps, source, tenantId) => {
      calls.targetObjects.push({ owner: source.owner, unit: source.unit, tenantId });
      return Promise.resolve([...(fakes.targetObjects?.[tenantId] ?? [])]);
    },
    legacyObjects: (_deps, options) => {
      calls.legacyObjects.push(options);
      return Promise.resolve(fakes.legacyObjects ?? { status: 'compared', byTenant: new Map() });
    },
  };
}

interface SnapshotSpec {
  seq: number;
  kind: string;
  state?: string;
}

/** `migration.snapshot` rows answering `getSnapshot` and `latestSnapshot`. */
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
    const ready = snapshots.filter((spec) => (spec.state ?? 'ready') === 'ready').sort((a, b) => b.seq - a.seq);
    return Promise.resolve({ rows: ready.slice(0, 1).map(rowOf) });
  };
  return { schema: 'migration', withMetadata: (fn: (tx: { query: typeof query }) => unknown) => fn({ query }) } as unknown as TenantDb;
}

let reportsDir: string;
let calls: Calls;

function contextOf(over: { snapshots?: readonly SnapshotSpec[]; catalog?: UnitCatalog; tableVersion?: string | null } = {}): ReconcileContext {
  const ctx = {
    env: { MURA_DATABASE: LIVE_DB, OPT2_REPORTS_DIR: reportsDir },
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

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(os.tmpdir(), 'reconcile-index-'));
  calls = { shapes: [], resolverDatabases: [], legacyRowDatabases: [], targetRows: [], targetObjects: [], legacyObjects: [] };
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

describe('runReconcile', () => {
  it('reports zero difference for identical data, exits 0 and writes the point report and summary with the pinned SHA', async () => {
    const data: Data = { [PERSON]: { [A]: [ann, bob] } };
    const result = await runReconcile(contextOf(), { point: 'post-cutover', units: ['people.person'] }, fakeSources({ legacy: data, target: data }, calls));

    expect(result).toMatchObject({ point: 'post-cutover', result: 'zero-difference', exitCode: 0 });
    expect(result.summary).toEqual({ units: 1, tenants: 1, unitsWithDifferences: 0, differences: 0, orphans: 0, haltedUnits: 0 });
    expect(result.reportPath).toBe(path.join(reportsDir, RECONCILIATION_DIR, 'post-cutover.json'));
    const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ sourceSha: PIN_SHA, point: 'post-cutover', legacyDatabase: LIVE_DB, legacySource: 'live', snapshotSeq: 0 });
    expect(written.units).toEqual([expect.objectContaining({ unit: 'people.person', legacyTable: 'tusers', tenantId: A, excludedColumns: ['IdentityCol'] })]);
    const summary = await readFile(path.join(reportsDir, RECONCILIATION_DIR, 'summary.md'), 'utf8');
    expect(summary).toContain(`Source SHA: ${PIN_SHA}`);
    expect(summary).toContain('| post-cutover | [post-cutover.json](post-cutover.json) | v0002 | 1 | 0 | 0 | zero-difference |');
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

  it('reconciles only the units of the roster group set R at a rollback point without --units', async () => {
    const named = new Set(loadVersion(config.paths.cutoverDir, 'v0003').rollbackRefs.flatMap((ref) => ref.groups));
    const rosterUnits = loadGroups(config.paths.groupsFile).groups.filter((group) => named.has(group.id)).flatMap((group) => group.units);
    const expected = rosterUnits.flatMap((unit) => realCatalog.legacyTablesOf(unit).map((table) => `${unit}|${table}`));

    const result = await runReconcile(contextOf(), { point: 'rollback-before' }, fakeSources({}, calls));

    expect(result).toMatchObject({ point: 'rollback-before', result: 'zero-difference', exitCode: 0 });
    expect(rosterUnits).toEqual(expect.arrayContaining(['people.person', 'people.person_archive', 'timesheets.blackout']));
    expect([...calls.shapes].sort()).toEqual([...new Set(expected)].sort());
    expect(calls.legacyObjects).toEqual([]);
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

  it('reconciles every unit with a migratable legacy table plus the file units when --units is absent', async () => {
    await runReconcile(contextOf({ snapshots: [{ seq: 0, kind: 'seed' }] }), { point: 'after-backfill' }, fakeSources({}, calls));

    const units = new Set(calls.shapes.map((shape) => shape.slice(0, shape.indexOf('|'))));
    expect(units.has('people.person')).toBe(true);
    expect(units.has('communications.scheduled_task')).toBe(false);
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
    ['no snapshot at all', { point: 'after-fault-duplicate-batch', units: ['people.person'] }, []],
    ['a snapshot not ready', { point: 'after-feed-1', units: ['people.person'] }, [{ seq: 1, kind: 'feed', state: 'creating' }]],
  ])('rejects %s with ReconcileUsageError', async (_name, options, snapshots) => {
    const error: unknown = await runReconcile(contextOf({ snapshots }), options, fakeSources({}, calls)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReconcileUsageError);
    expect((error as ReconcileUsageError).exitCode).toBe(2);
    expect(calls.shapes).toEqual([]);
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
      expect.objectContaining({ legacyTable: 'tfiles', differences: [expect.objectContaining({ kind: 'object-missing-in-target', key: entry.key })] }),
    ]);
    expect(report.result).toBe('difference');
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
