// Reconciliation: the folder's public API, per-unit and per-tenant comparison of legacy with the owners' exports, and the CLI command.
import type { ResolvedPaths } from '../config.js';
import type { MigrationContext } from '../context.js';
import { CutoverDataError, currentAuthority, loadGroups, loadVersion } from '../cutover/index.js';
import { SUPPORTED_FILE_STORE } from '../files/index.js';
import { UnknownUnitError, type UnitCatalog } from '../owners/index.js';
import { getSnapshot, latestSnapshot, type SnapshotKind, type SnapshotRecord } from '../snapshot/index.js';
import { compareObjects, compareRows, type ObjectEntry, type RowComparison } from './compare.js';
import {
  createTenantResolver,
  describeUnitTable,
  fileUnitIds,
  readLegacyObjects,
  readLegacyUnitRows,
  type LegacyObjectsOptions,
  type TenantResolver,
} from './legacy-side.js';
import {
  ReconcileUsageError,
  buildReport,
  buildUnitReport,
  resolvePoint,
  writeReconciliationReport,
  type FileStoreReport,
  type LegacySource,
  type ReconcileReport,
  type ReconcileResult,
  type ReconcileSummary,
  type ResolvedPoint,
  type UnitReport,
} from './report.js';
import { readTargetObjects, readTargetUnitRows, type TargetObjectsSource } from './target-side.js';

export * from './compare.js';
export * from './legacy-side.js';
export * from './target-side.js';
export * from './report.js';

/** Context members reconciliation reads: both data sides, snapshots, the gateway's active version and the report target. */
export type ReconcileContext = Pick<
  MigrationContext,
  'env' | 'config' | 'clock' | 'db' | 'legacy' | 'bridge' | 'catalog' | 'owners' | 'gateway'
>;

/** Options of {@link reconcileUnits}; `legacySource` overrides the point's own, `database` is the legacy side read. */
export interface ReconcileUnitsOptions {
  point: string;
  units: readonly string[];
  database: string;
  snapshotSeq?: number | null;
  legacySource?: LegacySource;
}

/** Reads {@link reconcileUnits} makes, replaceable by fakes; each defaults to the legacy-side, target-side or cut-over function. */
export interface ReconcileSources {
  tableShape?: typeof describeUnitTable;
  legacyRows?: typeof readLegacyUnitRows;
  targetRows?: typeof readTargetUnitRows;
  targetObjects?: typeof readTargetObjects;
  legacyObjects?: typeof readLegacyObjects;
  tenantResolver?: typeof createTenantResolver;
  /** Active cut-over version; defaults to the gateway's status through `currentAuthority`. */
  tableVersion?: () => Promise<string | null>;
}

/** Options of {@link runReconcile}: the point name and the `--units` ids, every applicable unit when absent. */
export interface RunReconcileOptions {
  point: string;
  units?: readonly string[];
}

/** Outcome of {@link runReconcile}; `exitCode` is 0 only for a zero-difference point. */
export interface RunReconcileResult {
  point: string;
  result: ReconcileResult;
  reportPath: string;
  summary: ReconcileSummary;
  exitCode: 0 | 1;
}

type Reads = Required<ReconcileSources>;

/** Legacy file-store objects of a run, per tenant. */
type TenantObjects = ReadonlyMap<string, readonly ObjectEntry[]>;

/** Snapshot kind of `S0`, the seeded state the backfill applies. */
const BACKFILL_SNAPSHOT_KIND: SnapshotKind = 'seed';

/** Version whose `rollbackRefs` name the roster group set R that the rollback points reconcile. */
const ROLLBACK_VERSION = 'v0003';

/** Masa's file metadata table [core/setup/db/mssql.sql]; the owner exports its object manifest with the unit this table feeds. */
const FILES_TABLE = 'tfiles';

const NO_FILE_STORE: FileStoreReport = { store: null, status: 'not-applicable', haltedUnits: [] };

function readsOf(ctx: ReconcileContext, sources: ReconcileSources): Reads {
  return {
    tableShape: sources.tableShape ?? describeUnitTable,
    legacyRows: sources.legacyRows ?? readLegacyUnitRows,
    targetRows: sources.targetRows ?? readTargetUnitRows,
    targetObjects: sources.targetObjects ?? readTargetObjects,
    legacyObjects: sources.legacyObjects ?? readLegacyObjects,
    tenantResolver: sources.tenantResolver ?? createTenantResolver,
    tableVersion:
      sources.tableVersion ?? (async () => (await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths })).tableVersion),
  };
}

function sortedUnion(...parts: readonly Iterable<string>[]): string[] {
  return [...new Set(parts.flatMap((part) => [...part]))].sort();
}

function isCatalogued(catalog: Pick<UnitCatalog, 'units'>, unit: string): boolean {
  return catalog.units().some((candidate) => candidate.id === unit);
}

/** Migratable legacy tables of `unit` in catalog order; a file unit the catalog does not list has none. */
function migratableTablesOf(catalog: UnitCatalog, unit: string, fileUnit: boolean): string[] {
  if (fileUnit && !isCatalogued(catalog, unit)) return [];
  return catalog.legacyTablesOf(unit).filter((table) => catalog.isMigratable(table));
}

/**
 * Owner and exported unit carrying a file unit's object manifest: the unit itself when catalogued, otherwise the unit of
 * its schema fed by `tfiles` (an object-manifest table such as `content.file_object` is that unit's data, not a unit).
 */
function objectExportSource(catalog: Pick<UnitCatalog, 'units'>, unit: string): TargetObjectsSource {
  const units = catalog.units();
  const own = units.find((candidate) => candidate.id === unit);
  if (own !== undefined) return { owner: own.owner, unit: own.id };
  const schema = unit.slice(0, unit.indexOf('.'));
  const fed = units.find(
    (candidate) => candidate.schema === schema && candidate.legacyTables.some((table) => table.replace(/^dbo\./i, '').toLowerCase() === FILES_TABLE),
  );
  if (fed === undefined) throw new Error(`No ${schema} unit is fed by ${FILES_TABLE}, so no export carries the object manifest of ${unit}`);
  return { owner: fed.owner, unit: fed.id };
}

/** The file-store state of the run and, when compared, the legacy objects per tenant. */
async function fileStoreOf(
  ctx: ReconcileContext,
  reads: Reads,
  fileUnits: readonly string[],
  options: LegacyObjectsOptions,
): Promise<{ fileStore: FileStoreReport; objects: TenantObjects }> {
  if (fileUnits.length === 0) return { fileStore: NO_FILE_STORE, objects: new Map() };
  const legacy = await reads.legacyObjects(ctx, options);
  if (legacy.status === 'halted') {
    return { fileStore: { store: legacy.store, status: 'halted', reason: legacy.reason, haltedUnits: [...fileUnits] }, objects: new Map() };
  }
  return { fileStore: { store: SUPPORTED_FILE_STORE, status: 'compared', haltedUnits: [] }, objects: legacy.byTenant };
}

/** Entries of one unit table, one per tenant either side holds rows or (with `objects`) objects in. */
async function reconcileTable(
  ctx: ReconcileContext,
  reads: Reads,
  input: { unit: string; legacyTable: string; database: string; tenants: TenantResolver; objects: TenantObjects | null },
): Promise<UnitReport[]> {
  const { database, tenants, objects } = input;
  const shape = await reads.tableShape(ctx, { unit: input.unit, legacyTable: input.legacyTable, database });
  const legacy = await reads.legacyRows(ctx, shape, { database, tenants });
  const includeObjects = objects !== null;
  const entries: UnitReport[] = [];
  for (const tenantId of sortedUnion(legacy.byTenant.keys(), tenants.siteTenants(), objects?.keys() ?? [])) {
    const target = await reads.targetRows(ctx, shape, tenantId, { includeObjects });
    const legacyRows = legacy.byTenant.get(tenantId) ?? [];
    const legacyObjects = objects?.get(tenantId) ?? [];
    const targetObjects = target.objects ?? [];
    if (legacyRows.length + target.rows.length + legacyObjects.length + targetObjects.length === 0) continue;
    const rows = await compareRows({ keyed: shape.keyed, columns: shape.columns, legacy: legacyRows, target: target.rows });
    const orphans = legacy.orphans.get(tenantId) ?? [];
    entries.push(
      buildUnitReport({
        unit: shape.unit,
        owner: shape.owner,
        legacyTable: shape.legacyTable,
        tenantId,
        rows,
        files: includeObjects ? compareObjects(legacyObjects, targetObjects) : null,
        excludedColumns: shape.excludedColumns,
        orphans,
        orphanCount: orphans.length,
      }),
    );
  }
  return entries;
}

/** Entries of a file unit without a migratable legacy table: an empty row comparison plus the object manifests per tenant. */
async function reconcileObjectsOnly(
  ctx: ReconcileContext,
  reads: Reads,
  input: { unit: string; tenants: TenantResolver; objects: TenantObjects },
): Promise<UnitReport[]> {
  const source = objectExportSource(ctx.catalog, input.unit);
  let noRows: RowComparison | undefined;
  const entries: UnitReport[] = [];
  for (const tenantId of sortedUnion(input.tenants.siteTenants(), input.objects.keys())) {
    const legacyObjects = input.objects.get(tenantId) ?? [];
    const targetObjects = await reads.targetObjects(ctx, source, tenantId);
    if (legacyObjects.length + targetObjects.length === 0) continue;
    noRows ??= await compareRows({ keyed: false, columns: [], legacy: [], target: [] });
    entries.push(
      buildUnitReport({
        unit: input.unit,
        owner: source.owner,
        legacyTable: null,
        tenantId,
        rows: noRows,
        files: compareObjects(legacyObjects, targetObjects),
      }),
    );
  }
  return entries;
}

/**
 * Reconciles `units` at a point with zero tolerance, unit by unit in sorted order and tenant by tenant, and returns the
 * report body without writing it; the caller has reached the quiesced point. Read failures of either side propagate.
 */
export async function reconcileUnits(
  ctx: ReconcileContext,
  options: ReconcileUnitsOptions,
  sources: ReconcileSources = {},
): Promise<ReconcileReport> {
  const point = resolvePoint(ctx.config, options.point);
  const legacySource = options.legacySource ?? point.legacySource;
  const snapshotSeq = options.snapshotSeq ?? null;
  const { database } = options;
  const reads = readsOf(ctx, sources);
  const tableVersion = await reads.tableVersion();
  const tenants = await reads.tenantResolver(ctx, { database });
  const units = sortedUnion(options.units);
  const fileUnits = fileUnitIds(ctx.config).filter((unit) => units.includes(unit)).sort();
  const { fileStore, objects } = await fileStoreOf(ctx, reads, fileUnits, { legacySource, snapshotSeq, database });

  const entries: UnitReport[] = [];
  for (const unit of units) {
    // A halted store's units never move, so they are not compared.
    if (fileStore.haltedUnits.includes(unit)) continue;
    const fileUnit = fileUnits.includes(unit);
    const tables = migratableTablesOf(ctx.catalog, unit, fileUnit);
    if (fileUnit && tables.length === 0) {
      entries.push(...(await reconcileObjectsOnly(ctx, reads, { unit, tenants, objects })));
      continue;
    }
    for (const [index, legacyTable] of tables.entries()) {
      const tableObjects = fileUnit && index === 0 ? objects : null;
      entries.push(...(await reconcileTable(ctx, reads, { unit, legacyTable, database, tenants, objects: tableObjects })));
    }
  }
  return buildReport({ point, legacySource, tableVersion, snapshotSeq, legacyDatabase: database, units: entries, fileStore });
}

/** `--units` ids, each a catalog unit or a file unit, sorted and without repeats. @throws ReconcileUsageError */
function requestedUnits(ctx: Pick<ReconcileContext, 'catalog' | 'config'>, units: readonly string[]): string[] {
  if (units.length === 0) throw new ReconcileUsageError('--units names no unit');
  const fileUnits = new Set(fileUnitIds(ctx.config));
  for (const id of units) {
    if (fileUnits.has(id)) continue;
    try {
      ctx.catalog.unit(id);
    } catch (error) {
      if (error instanceof UnknownUnitError) throw new ReconcileUsageError(error.message, { cause: error });
      throw error;
    }
  }
  return sortedUnion(units);
}

/** Units of the roster group set R: every unit of the groups `v0003.rollbackRefs` names. @throws CutoverDataError */
function rosterGroupUnits(paths: Pick<ResolvedPaths, 'cutoverDir' | 'groupsFile'>): string[] {
  const named = sortedUnion(loadVersion(paths.cutoverDir, ROLLBACK_VERSION).rollbackRefs.flatMap((ref) => ref.groups));
  const groups = new Map(loadGroups(paths.groupsFile).groups.map((group) => [group.id, group]));
  const missing = named.filter((id) => !groups.has(id));
  if (named.length === 0 || missing.length > 0) {
    const problem = named.length === 0 ? 'name no group' : `name groups missing from ${paths.groupsFile}: ${missing.join(', ')}`;
    throw new CutoverDataError(`${ROLLBACK_VERSION} rollbackRefs ${problem}, so the roster group set R is unknown`);
  }
  return sortedUnion(named.flatMap((id) => groups.get(id)?.units ?? []));
}

/** Units a point reconciles without `--units`: R for rollback points, otherwise every unit with a migratable legacy table plus the file units. */
function defaultUnits(ctx: Pick<ReconcileContext, 'catalog' | 'config'>, point: ResolvedPoint): string[] {
  if (point.rollback) return rosterGroupUnits(ctx.config.paths);
  const { catalog } = ctx;
  const withTables = catalog.units().filter((unit) => unit.legacyTables.some((table) => catalog.isMigratable(table)));
  return sortedUnion(
    withTables.map((unit) => unit.id),
    fileUnitIds(ctx.config),
  );
}

/** The ready snapshot of `kind` with the highest sequence, or `null`. */
async function latestSnapshotOfKind(ctx: Pick<ReconcileContext, 'db'>, kind: SnapshotKind): Promise<SnapshotRecord | null> {
  const latest = await latestSnapshot(ctx);
  for (let seq = latest?.seq ?? -1; seq >= 0; seq -= 1) {
    const snapshot = seq === latest?.seq ? latest : await getSnapshot(ctx, seq);
    if (snapshot?.kind === kind && snapshot.state === 'ready') return snapshot;
  }
  return null;
}

/** Snapshot a snapshot point compares against. @throws ReconcileUsageError when it does not exist or is not ready */
async function pointSnapshot(ctx: Pick<ReconcileContext, 'db'>, point: ResolvedPoint): Promise<SnapshotRecord> {
  let snapshot: SnapshotRecord | null;
  if (point.kind === 'after-backfill') snapshot = await latestSnapshotOfKind(ctx, BACKFILL_SNAPSHOT_KIND);
  // `after-feed-<n>` is named by the sequence of the snapshot the feed applied (S0, seq 0, is the backfill's), so
  // snapshot n, not n + 1, is the state the target was brought to.
  else if (point.feedN !== undefined) snapshot = await getSnapshot(ctx, point.feedN);
  else snapshot = await latestSnapshot(ctx);
  if (snapshot === null || snapshot.state !== 'ready') {
    throw new ReconcileUsageError(`Point ${point.name} needs a ready snapshot to compare against, and none was found`);
  }
  return snapshot;
}

/** Legacy database a point reads and the snapshot sequence it records. */
async function legacySideOf(ctx: Pick<ReconcileContext, 'db' | 'env'>, point: ResolvedPoint): Promise<{ database: string; snapshotSeq: number | null }> {
  if (point.legacySource === 'live') return { database: ctx.env.MURA_DATABASE, snapshotSeq: (await latestSnapshot(ctx))?.seq ?? null };
  const snapshot = await pointSnapshot(ctx, point);
  return { database: snapshot.databaseName, snapshotSeq: snapshot.seq };
}

/**
 * `opt2-migrate reconcile --point <name> [--units ...]`: reconciles the point's units, writes `reconciliation/<point>.json`
 * and `summary.md`, and returns the summary with exit code 1 on any difference.
 * @throws ReconcileUsageError for an unknown point, an unknown unit or a missing snapshot.
 */
export async function runReconcile(
  ctx: ReconcileContext,
  options: RunReconcileOptions,
  sources: ReconcileSources = {},
): Promise<RunReconcileResult> {
  const point = resolvePoint(ctx.config, options.point);
  const units = options.units === undefined ? defaultUnits(ctx, point) : requestedUnits(ctx, options.units);
  const { database, snapshotSeq } = await legacySideOf(ctx, point);
  const report = await reconcileUnits(ctx, { point: point.name, units, database, snapshotSeq, legacySource: point.legacySource }, sources);
  const reportPath = await writeReconciliationReport(ctx, report);
  return { point: point.name, result: report.result, reportPath, summary: report.summary, exitCode: report.result === 'zero-difference' ? 0 : 1 };
}
