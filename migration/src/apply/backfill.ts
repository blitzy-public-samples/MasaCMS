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
  fanOut,
  type ApplyChange,
  type BatchDirection,
  type BatchSender,
  type OwnerBatcher,
  type OwnerBatchStats,
  type TenantResolver,
} from './batch.js';

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

/** What every table of one run shares. */
interface TableRun {
  readonly ctx: BackfillContext;
  readonly snapshot: SnapshotRecord;
  readonly tenants: TenantResolver;
  readonly sender: BatchSender;
  readonly batchSize: number;
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

/** Loads one table into every owner of it; with deferred columns, loads them null first and patches them in a second pass. */
async function backfillTable(run: TableRun, table: MigratableTable, deferredNames: ReadonlySet<string>): Promise<BackfillTableResult> {
  const { ctx, snapshot, tenants } = run;
  const source = { table, database: snapshot.databaseName };
  const shape = await describeLegacyTable(ctx, source);
  const deferred = shape.columns.filter((column) => deferredNames.has(column.name.toLowerCase())).map((column) => column.name);
  const watermark: WatermarkRecord = {
    legacyTable: table.name,
    direction: 'forward',
    snapshotSeq: snapshot.seq,
    backupLsn: snapshot.checkpointLsn,
    finishedAt: formatCanonicalTimestamp(ctx.clock.now()),
  };
  const op: ApplyChange['op'] = shape.keyed ? 'upsert' : 'insert';

  const load = batchersFor(run, table, shape, 'backfill', deferred.length === 0 ? watermark : null);
  let rows = 0;
  let orphans = 0;
  for await (const row of streamLegacyTable(ctx, source)) {
    const resolved = tenants.resolve(table.name, row.row);
    rows += 1;
    if (resolved.orphan) orphans += 1;
    const encoding = deferred.length === 0 ? row.encoding : encodeRow(shape.columns, withNulls(row.row, deferred));
    await fanOut(load, resolved.tenantId, { op, row: encoding }, row.legacyProgramId);
  }
  const perOwner = await finishAll(load);

  if (deferred.length > 0) {
    const patch = batchersFor(run, table, shape, 'backfill-patch', watermark);
    for await (const row of streamLegacyTable(ctx, source)) {
      if (deferred.every((name) => (row.row[name] ?? null) === null)) continue;
      const { tenantId } = tenants.resolve(table.name, row.row);
      for (const change of patchChanges(shape, row, deferred)) await fanOut(patch, tenantId, change, row.legacyProgramId);
    }
    perOwner.push(...(await finishAll(patch)));
  }

  const batches = perOwner.reduce((sum, stats) => sum + stats.batches, 0);
  ctx.logger.info(
    `backfill of snapshot ${String(snapshot.seq)} applied ${table.name}: ${String(rows)} rows, ` +
      `${String(batches)} batches, ${String(orphans)} orphans`,
  );
  return {
    table: table.name,
    owners: [...ctx.catalog.ownersForLegacyTable(table.name)],
    rows,
    batches,
    orphans,
    deferredColumns: deferred,
    perOwner,
  };
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
 * Backfills the owners from snapshot `snapshotSeq` table by table in dependency order, transfers its files and writes the
 * `after-backfill` reconciliation; batch ids repeat on a re-run, and the first failed batch fails the command.
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
  const run: TableRun = {
    ctx,
    snapshot,
    tenants: await createApplyTenantResolver(ctx, { database }),
    sender: createBatchSender({ owners: ctx.owners }),
    batchSize: batchSizeOf(ctx.config),
  };

  const results: BackfillTableResult[] = [];
  for (const table of ordered) {
    results.push(await backfillTable(run, table, deferred.get(tableLookupKey(table.name)) ?? new Set<string>()));
  }
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
