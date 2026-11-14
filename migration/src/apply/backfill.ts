/** `opt2-migrate backfill --snapshot <n>`: loads one snapshot into the owners in dependency order, transfers its files and reconciles. */
import { encodeRow, formatCanonicalTimestamp, type CanonicalValue, type WatermarkRecord } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import { currentAuthority } from '../cutover/index.js';
import {
  describeLegacyTable,
  listLegacyTables,
  migratableTables,
  streamLegacyTable,
  type CanonicalRow,
  type LegacyTableShape,
  type MigratableTable,
} from '../extract/index.js';
import { FileStoreUnsupportedError, SUPPORTED_FILE_STORE, transferFiles, type TransferResult } from '../files/index.js';
import { compareTableNames, computeDependencyOrder, type DependencyOrder } from '../order/index.js';
import type { DataOwner, UnitCatalog } from '../owners/index.js';
import {
  fileUnitIds,
  reconcileUnits,
  reportTargetFor,
  tableLookupKey,
  writeReconciliationReport,
  type ReconcileResult,
} from '../reconcile/index.js';
import { requireSnapshot, SnapshotError, type SnapshotRecord } from '../snapshot/index.js';
import {
  batchSizeOf,
  createApplyTenantResolver,
  createBatchSender,
  createOwnerBatcher,
  type ApplyChange,
  type BatchDirection,
  type BatchSender,
  type OwnerBatcher,
  type OwnerBatchStats,
  type TenantResolver,
} from './batch.js';
import { Acceptance, addTaken, chunksOf, planTarget, type DiffSide, type TargetPlan } from './targets.js';

/** Context members the backfill reads: the snapshot, both data sides, the gateway's authority and the report target. */
export type BackfillContext = Pick<
  MigrationContext,
  'env' | 'config' | 'clock' | 'logger' | 'db' | 'legacy' | 'bridge' | 'catalog' | 'owners' | 'gateway'
>;

/** Options of {@link runBackfill}. */
export interface BackfillOptions {
  snapshotSeq: number;
}

/** Outcome of one table; `perOwner` lists the load pass's batchers, then the patch pass's for a table with deferred columns. */
export interface BackfillTableResult {
  table: string;
  owners: DataOwner[];
  rows: number;
  batches: number;
  orphans: number;
  deferredColumns: string[];
  perOwner: OwnerBatchStats[];
}

/** Outcome of {@link runBackfill}; `order` is the order the tables were applied in, and `exitCode` is 0 only for zero difference. */
export interface BackfillResult {
  snapshotSeq: number;
  order: string[];
  tables: BackfillTableResult[];
  files: TransferResult | { status: 'halted'; reason: string };
  reconciliation: { point: 'after-backfill'; result: ReconcileResult; reportPath: string };
  exitCode: 0 | 1;
}

/** Raised before any batch is sent when a unit the snapshot's tables feed is `target`-authoritative. */
export class BackfillAuthorityError extends Error {
  override readonly name = 'BackfillAuthorityError';
  /** The `target`-authoritative units, sorted. */
  readonly units: string[];

  constructor(units: string[]) {
    super(`Backfill writes only legacy-authoritative units, but these are target-authoritative: ${units.join(', ')}`);
    this.units = units;
  }
}

const AFTER_BACKFILL = 'after-backfill';

/** What every table of one run shares; `side` is the snapshot database that row acceptance reads. */
interface TableRun {
  readonly ctx: BackfillContext;
  readonly snapshot: SnapshotRecord;
  readonly tenants: TenantResolver;
  readonly side: DiffSide;
  readonly sender: BatchSender;
  readonly batchSize: number;
}

/** Each owner's planned targets of one table and the acceptance cache that selects their rows in the snapshot. */
interface TableRouting {
  readonly table: string;
  readonly keyed: boolean;
  readonly plans: ReadonlyMap<DataOwner, readonly TargetPlan[]>;
  readonly acceptance: Acceptance;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Units fed by `tables`, plus the file units the transfer writes. */
function unitsOf(ctx: Pick<BackfillContext, 'catalog' | 'config'>, tables: readonly MigratableTable[]): string[] {
  const units = tables.flatMap((table) => ctx.catalog.unitsForLegacyTable(table.name).map((target) => target.unit));
  return sorted([...units, ...fileUnitIds(ctx.config)]);
}

/** Program ids of the live `Program_<id>` parts, ascending. */
function programIdsOf(tables: readonly MigratableTable[]): number[] {
  const ids = new Set<number>();
  for (const table of tables) for (const part of table.physical) if (part.programId !== undefined) ids.add(part.programId);
  return [...ids].sort((a, b) => a - b);
}

/** Lookup key of an order entry: concrete `Program_<id>` tables stand for their folded ownership entry. */
function orderKey(catalog: Pick<UnitCatalog, 'foldProgramTable'>, table: string): string {
  return tableLookupKey(catalog.foldProgramTable(table).legacyTable);
}

/** `tables` in dependency order: a folded table at its first part's position, tables the order lacks last by name. */
function inDependencyOrder(
  catalog: Pick<UnitCatalog, 'foldProgramTable'>,
  tables: readonly MigratableTable[],
  order: DependencyOrder,
): MigratableTable[] {
  const pending = new Map(tables.map((table) => [tableLookupKey(table.name), table]));
  const ordered: MigratableTable[] = [];
  for (const name of order.order) {
    const key = orderKey(catalog, name);
    const table = pending.get(key);
    if (table === undefined) continue;
    ordered.push(table);
    pending.delete(key);
  }
  return [...ordered, ...[...pending.values()].sort((a, b) => compareTableNames(a.name, b.name))];
}

/** Deferred back-reference columns, lower-cased, per table lookup key. */
function deferredByTable(catalog: Pick<UnitCatalog, 'foldProgramTable'>, order: DependencyOrder): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const { table, column } of order.deferred) {
    const key = orderKey(catalog, table);
    const columns = byTable.get(key) ?? new Set<string>();
    columns.add(column.toLowerCase());
    byTable.set(key, columns);
  }
  return byTable;
}

/** The row with every `columns` value nulled, the image the load pass sends for a table with deferred columns. */
function withNulls(row: CanonicalRow['row'], columns: readonly string[]): Record<string, CanonicalValue> {
  return { ...row, ...Object.fromEntries(columns.map((name) => [name, null])) };
}

/** One batcher per owner of `table`, in catalog owner order. */
function batchersFor(
  run: TableRun,
  table: MigratableTable,
  shape: LegacyTableShape,
  direction: BatchDirection,
  watermark: WatermarkRecord | null,
): Map<DataOwner, OwnerBatcher> {
  const owners = run.ctx.catalog.ownersForLegacyTable(table.name);
  return new Map(
    owners.map((owner) => [
      owner,
      createOwnerBatcher({
        owner,
        legacyTable: table.name,
        direction,
        snapshotSeq: run.snapshot.seq,
        origin: 'backfill',
        columns: shape.columns,
        batchSize: run.batchSize,
        sender: run.sender,
        watermark,
      }),
    ]),
  );
}

/** Routing of `table`: every owner's targets planned over the snapshot's shape. @throws Error for a row predicate the backfill cannot read. */
function routingFor(run: TableRun, table: MigratableTable, shape: LegacyTableShape): TableRouting {
  const plans = new Map<DataOwner, TargetPlan[]>();
  for (const target of run.ctx.catalog.unitsForLegacyTable(table.name)) {
    plans.set(target.owner, [...(plans.get(target.owner) ?? []), planTarget(target, shape, 'backfill')]);
  }
  return { table: table.name, keyed: shape.keyed, plans, acceptance: new Acceptance(run.ctx, table.name) };
}

/** Reads the ownership joins every target of the table needs to judge `rows`, one chunk of rows at a time. */
function prepareRows(run: TableRun, routing: TableRouting, rows: readonly CanonicalRow[]): Promise<void> {
  const targets = [...routing.plans.values()].flatMap((plans) => plans.map((plan) => plan.target));
  return routing.acceptance.prepare(targets, rows.map((row) => [run.side, row] as const));
}

/** Adds `changes` of `row` to the batcher of each owner whose targets take the real row, with the discriminators those targets need. */
async function route(
  run: TableRun,
  routing: TableRouting,
  batchers: ReadonlyMap<DataOwner, OwnerBatcher>,
  row: CanonicalRow,
  tenantId: string,
  changes: readonly ApplyChange[],
): Promise<void> {
  for (const [owner, batcher] of batchers) {
    const taken = await routing.acceptance.filter(routing.plans.get(owner) ?? [], run.side, row);
    if (taken.length === 0) continue;
    const target = { table: routing.table, keyed: routing.keyed, owner };
    for (const change of changes) await addTaken(batcher, target, change, taken, tenantId, row.legacyProgramId);
  }
}

async function finishAll(batchers: ReadonlyMap<DataOwner, OwnerBatcher>): Promise<OwnerBatchStats[]> {
  const stats: OwnerBatchStats[] = [];
  for (const batcher of batchers.values()) stats.push(await batcher.finish());
  return stats;
}

/**
 * Patch of one row whose deferred columns hold values. The apply contract has no column-scoped update, so a keyed row is
 * upserted whole, which changes only the deferred columns, and a keyless row replaces its nulled occurrence.
 */
function patchChanges(shape: LegacyTableShape, row: CanonicalRow, deferred: readonly string[]): ApplyChange[] {
  if (shape.keyed) return [{ op: 'upsert', row: row.encoding }];
  return [
    { op: 'delete', row: encodeRow(shape.columns, withNulls(row.row, deferred)) },
    { op: 'insert', row: row.encoding },
  ];
}

/** A table loaded with its deferred columns nulled, waiting for its patch pass. */
interface PendingPatch {
  readonly table: MigratableTable;
  readonly shape: LegacyTableShape;
  readonly routing: TableRouting;
  readonly deferred: readonly string[];
  readonly result: BackfillTableResult;
}

/** Outcome of a table's load pass; `patch` is null for a table without deferred columns, which is then complete. */
interface LoadedTable {
  readonly result: BackfillTableResult;
  readonly patch: PendingPatch | null;
}

/** The `forward` watermark at the snapshot, stamped when the table's last pass starts. */
function forwardWatermark(run: TableRun, table: MigratableTable): WatermarkRecord {
  return {
    legacyTable: table.name,
    direction: 'forward',
    snapshotSeq: run.snapshot.seq,
    backupLsn: run.snapshot.checkpointLsn,
    finishedAt: formatCanonicalTimestamp(run.ctx.clock.now()),
  };
}

/** Totals the batches of a table whose last pass has run, and logs it. */
function completeTable(run: TableRun, result: BackfillTableResult): void {
  result.batches = result.perOwner.reduce((sum, stats) => sum + stats.batches, 0);
  run.ctx.logger.info(
    `backfill of snapshot ${String(run.snapshot.seq)} applied ${result.table}: ${String(result.rows)} rows, ` +
      `${String(result.batches)} batches, ${String(result.orphans)} orphans`,
  );
}

/** Load pass of one table into the owners whose targets take its rows; deferred columns load null and the watermark waits for the patch. */
async function loadTable(run: TableRun, table: MigratableTable, deferredNames: ReadonlySet<string>): Promise<LoadedTable> {
  const { ctx, snapshot, tenants } = run;
  const source = { table, database: snapshot.databaseName };
  const shape = await describeLegacyTable(ctx, source);
  const routing = routingFor(run, table, shape);
  const deferred = shape.columns.filter((column) => deferredNames.has(column.name.toLowerCase())).map((column) => column.name);
  const op: ApplyChange['op'] = shape.keyed ? 'upsert' : 'insert';

  const load = batchersFor(run, table, shape, 'backfill', deferred.length === 0 ? forwardWatermark(run, table) : null);
  let rows = 0;
  let orphans = 0;
  for await (const chunk of chunksOf(streamLegacyTable(ctx, source), run.batchSize)) {
    await prepareRows(run, routing, chunk);
    for (const row of chunk) {
      const resolved = tenants.resolve(table.name, row.row);
      rows += 1;
      if (resolved.orphan) orphans += 1;
      const encoding = deferred.length === 0 ? row.encoding : encodeRow(shape.columns, withNulls(row.row, deferred));
      await route(run, routing, load, row, resolved.tenantId, [{ op, row: encoding }]);
    }
  }
  const result: BackfillTableResult = {
    table: table.name,
    owners: [...ctx.catalog.ownersForLegacyTable(table.name)],
    rows,
    batches: 0,
    orphans,
    deferredColumns: deferred,
    perOwner: await finishAll(load),
  };
  if (deferred.length === 0) {
    completeTable(run, result);
    return { result, patch: null };
  }
  return { result, patch: { table, shape, routing, deferred, result } };
}

/** Patch pass of one loaded table: restores its deferred columns, the last patch batch per owner carrying the `forward` watermark. */
async function patchTable(run: TableRun, pending: PendingPatch): Promise<void> {
  const { table, shape, routing, deferred, result } = pending;
  const patch = batchersFor(run, table, shape, 'backfill-patch', forwardWatermark(run, table));
  for await (const chunk of chunksOf(streamLegacyTable(run.ctx, { table, database: run.snapshot.databaseName }), run.batchSize)) {
    const patched = chunk.filter((row) => !deferred.every((name) => (row.row[name] ?? null) === null));
    await prepareRows(run, routing, patched);
    for (const row of patched) {
      const { tenantId } = run.tenants.resolve(table.name, row.row);
      await route(run, routing, patch, row, tenantId, patchChanges(shape, row, deferred));
    }
  }
  result.perOwner.push(...(await finishAll(patch)));
  completeTable(run, result);
}

/** Why the snapshot's files cannot move, or null when its manifest is complete. */
function unsupportedStoreReason(snapshot: SnapshotRecord): string | null {
  const { fileStore } = snapshot;
  if (fileStore?.status === 'unsupported') {
    return `site ${fileStore.siteId} uses file store ${fileStore.fileStore}, not ${SUPPORTED_FILE_STORE}`;
  }
  // Read back from its row, a ready snapshot records an unsupported store only as an incomplete manifest.
  if (!snapshot.manifestComplete) {
    return `snapshot ${String(snapshot.seq)} recorded no file manifest: its legacy file store is not ${SUPPORTED_FILE_STORE}`;
  }
  return null;
}

/** Transfers the snapshot's file objects; a store other than `fileDir` halts the file units instead of failing the backfill. */
async function backfillFiles(ctx: BackfillContext, snapshot: SnapshotRecord): Promise<BackfillResult['files']> {
  let reason = unsupportedStoreReason(snapshot);
  if (reason === null) {
    try {
      return await transferFiles(ctx, snapshot.seq);
    } catch (error) {
      if (!(error instanceof FileStoreUnsupportedError)) throw error;
      reason = error.message;
    }
  }
  ctx.logger.warn(`backfill of snapshot ${String(snapshot.seq)} halted the file units: ${reason}`);
  return { status: 'halted', reason };
}

/**
 * Backfills the owners from snapshot `snapshotSeq`: loads every table in dependency order, then patches the deferred columns of
 * each table that has them in the same order, transfers its files and writes the `after-backfill` reconciliation; batch ids
 * repeat on a re-run, and the first failed batch fails the command.
 * @throws SnapshotError when the snapshot is not ready; BackfillAuthorityError before any batch when a unit is target-authoritative.
 */
export async function runBackfill(ctx: BackfillContext, options: BackfillOptions): Promise<BackfillResult> {
  const snapshot = await requireSnapshot(ctx, options.snapshotSeq);
  if (snapshot.state !== 'ready') throw new SnapshotError(`Snapshot ${String(snapshot.seq)} is ${snapshot.state}, not ready`);
  const database = snapshot.databaseName;
  const tables = migratableTables(ctx.catalog, await listLegacyTables(await ctx.legacy.database(database)));
  const units = unitsOf(ctx, tables);

  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const targetUnits = units.filter((unit) => authority.isTargetAuthoritative(unit));
  if (targetUnits.length > 0) throw new BackfillAuthorityError(targetUnits);

  const order = await computeDependencyOrder({
    inventory: ctx.config.paths.inventory,
    catalog: ctx.catalog,
    reportsOpts: { target: reportTargetFor(ctx), clock: ctx.clock },
    programIds: programIdsOf(tables),
  });
  const ordered = inDependencyOrder(ctx.catalog, tables, order);
  const deferred = deferredByTable(ctx.catalog, order);
  const tenants = await createApplyTenantResolver(ctx, { database });
  const run: TableRun = {
    ctx,
    snapshot,
    tenants,
    side: { database, tenants },
    sender: createBatchSender({ owners: ctx.owners }),
    batchSize: batchSizeOf(ctx.config),
  };

  const results: BackfillTableResult[] = [];
  const pending: PendingPatch[] = [];
  for (const table of ordered) {
    const loaded = await loadTable(run, table, deferred.get(tableLookupKey(table.name)) ?? new Set<string>());
    results.push(loaded.result);
    if (loaded.patch !== null) pending.push(loaded.patch);
  }
  for (const patch of pending) await patchTable(run, patch);
  const files = await backfillFiles(ctx, snapshot);

  const report = await reconcileUnits(ctx, { point: AFTER_BACKFILL, units, database, snapshotSeq: snapshot.seq });
  const reportPath = await writeReconciliationReport(ctx, report);
  return {
    snapshotSeq: snapshot.seq,
    order: ordered.map((table) => table.name),
    tables: results,
    files,
    reconciliation: { point: AFTER_BACKFILL, result: report.result, reportPath },
    exitCode: report.result === 'zero-difference' ? 0 : 1,
  };
}
