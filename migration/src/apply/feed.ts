/** Forward change feed: snapshot-to-snapshot table diffs applied to the owners' legacy-authoritative units, and the feed restart after a rollback. */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  LEGACY_PROGRAM_ID_COLUMN,
  encodeRow,
  formatCanonicalTimestamp,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalValue,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';

import { ownerBySchema } from '../config.js';
import type { MigrationContext } from '../context.js';
import { currentAuthority, type CurrentAuthority } from '../cutover/index.js';
import { diffKeyedStreams, diffMultisetStreams, type KeyedChange, type MultisetChange, type RowSource } from '../diff/index.js';
import {
  describeLegacyTable,
  listLegacyTables,
  migratableTables,
  parseQualifiedName,
  qualifiedName,
  streamLegacyTable,
  type CanonicalRow,
  type LegacyTableShape,
  type MigratableTable,
} from '../extract/index.js';
import { FileStoreUnsupportedError, SUPPORTED_FILE_STORE, diffSnapshotManifests, removeDroppedObjects, transferFiles, type RemovalResult, type TransferResult } from '../files/index.js';
import { compareTableNames, computeDependencyOrder } from '../order/index.js';
import type { DataOwner, LegacyTableTarget } from '../owners/index.js';
import {
  describeUnitTable,
  fileUnitIds,
  objectLegacyPath,
  readLegacyUnitRows,
  readTargetUnitRows,
  reconcileUnits,
  writeReconciliationReport,
  type ObjectEntry,
  type ReconcileResult,
  type TargetUnitRows,
  type UnitTableShape,
} from '../reconcile/index.js';
import { latestSnapshot, requireSnapshot, takeSnapshot, type SnapshotRecord } from '../snapshot/index.js';
import {
  batchSizeOf,
  createApplyTenantResolver,
  createBatchSender,
  createOwnerBatcher,
  type ApplyChange,
  type BatchDirection,
  type BatchSender,
  type OwnerBatcher,
  type TenantResolver,
} from './batch.js';
import { Acceptance, addTaken, chunksOf, hintOf, planTarget, type DiffSide, type TargetPlan } from './targets.js';

/** Context members the feed reads: snapshots, both data sides through `legacy` and `owners`, the gateway's authority and the report target. */
export type FeedContext = Pick<
  MigrationContext,
  'env' | 'config' | 'clock' | 'logger' | 'db' | 'legacy' | 'bridge' | 'catalog' | 'owners' | 'gateway'
>;

/** Context members {@link applyTableDiff} reads. */
export type TableDiffContext = Pick<MigrationContext, 'config' | 'clock' | 'db' | 'legacy' | 'catalog' | 'owners'>;

/** Inputs of {@link applyTableDiff}; owners default to the table's owners and bases to their `forward` watermarks. */
export interface ApplyTableDiffOptions {
  table: MigratableTable;
  /** Snapshot the target is brought to. */
  to: SnapshotRecord;
  /** Units the diff may write; every other unit of the table is left untouched. */
  writableUnits: ReadonlySet<string>;
  owners?: readonly DataOwner[];
  /** Base snapshot per owner; an owner absent here is looked up through its `forward` watermark. */
  baseByOwner?: ReadonlyMap<DataOwner, number | null>;
  direction: Extract<BatchDirection, 'feed' | 'catch-up'>;
  /** Tenant resolver over snapshot `seq`'s database; callers cache one per sequence. */
  tenantsFor(seq: number): Promise<TenantResolver>;
  sender: BatchSender;
  batchSize: number;
  /** False sends no watermark; defaults to true, the last batch per owner then carrying `forward` at `to`. */
  watermark?: boolean;
  /** Also stores the watermark for owners left `not-writable` or `no-baseline`. */
  forceWatermark?: boolean;
}

/** What one owner's share of a table diff did; counts are logical changes, `orphans` those placed in the umbrella tenant. */
export interface OwnerDiffResult {
  owner: DataOwner;
  base: number | null;
  status: 'applied' | 'up-to-date' | 'not-writable' | 'no-baseline';
  inserts: number;
  updates: number;
  deletes: number;
  batches: number;
  orphans: number;
  /** Changes only the owner's `target`-authoritative units would take, which the feed never writes. */
  droppedTargetAuthoritative: number;
}

/** Outcome of {@link applyTableDiff} for one table. */
export interface TableDiffResult {
  table: string;
  owners: OwnerDiffResult[];
}

/** Options of {@link runFeed}; `snapshotSeq` resumes on an existing feed snapshot, whose batches repeat their ids. */
export interface FeedOptions {
  snapshotSeq?: number;
}

/** What the feed did with the legacy file store. */
export type FeedFilesResult =
  | { status: 'transferred'; from: number; to: number; transfer: TransferResult; removal: RemovalResult }
  | { status: 'up-to-date'; from: number; to: number }
  | { status: 'skipped-target-authoritative'; units: string[] }
  | { status: 'not-applicable'; reason: string }
  | { status: 'halted'; reason: string };

/** Outcome of {@link runFeed}; `bases` holds the base snapshot per table and owner, `exitCode` is 0 only for a zero-difference point. */
export interface FeedResult {
  snapshotSeq: number;
  tableVersion: string | null;
  bases: Record<string, Record<string, number>>;
  tables: TableDiffResult[];
  files: FeedFilesResult;
  reconciliation: { point: string; result: ReconcileResult; reportPath: string };
  exitCode: 0 | 1;
}

/** Options of {@link restartFeedFor}: the units to re-baseline and, optionally, the snapshot to re-baseline them at. */
export interface RestartFeedOptions {
  units: readonly string[];
  snapshotSeq?: number;
}

/** One (table, owner) pair of a restart: the catch-up of the owner's other legacy units and the re-baseline of the restarted ones. */
export interface RestartTableResult {
  table: string;
  owner: DataOwner;
  catchUp: OwnerDiffResult | null;
  rebaseline: { units: string[]; inserts: number; updates: number; deletes: number; batches: number };
}

/** Outcome of {@link restartFeedFor}. */
export interface RestartFeedResult {
  snapshotSeq: number;
  units: string[];
  tables: RestartTableResult[];
}

/** An owner holds legacy-authoritative units of a table but no `forward` watermark to diff from. */
export class FeedBaselineMissingError extends Error {
  override readonly name = 'FeedBaselineMissingError';
  readonly table: string;
  readonly owner: DataOwner;

  constructor(table: string, owner: DataOwner) {
    super(`${owner} has no forward watermark with a snapshot sequence for ${table}; run backfill first`);
    this.table = table;
    this.owner = owner;
  }
}

/** A unit asked to restart its feed is still `target`-authoritative. */
export class FeedAuthorityError extends Error {
  override readonly name = 'FeedAuthorityError';
  readonly units: string[];

  constructor(units: string[]) {
    super(`The forward feed cannot restart for target-authoritative units: ${units.join(', ')}`);
    this.units = units;
  }
}

type Resolved = ReturnType<TenantResolver['resolve']>;

const FEED_SNAPSHOT_KIND = 'feed';
const REBASELINE_SNAPSHOT_KIND = 'rebaseline';
/** Masa's file metadata table; the file store's objects follow its owner's watermark. */
const FILES_TABLE = 'tfiles';

const lower = (name: string): string => name.toLowerCase();

/** Lookup form of a table name: brackets and `dbo.` dropped, lower case. */
function tableKey(name: string): string {
  const { schema, table } = parseQualifiedName(name);
  return lower(qualifiedName(schema, table));
}

/** Union of the targets' written columns, always with the shape's key and, for folded tables, `legacy_program_id`. */
function writableColumnsFor(targets: readonly TargetPlan[], shape: Pick<LegacyTableShape, 'keyColumns' | 'folded'>): string[] {
  const columns = new Set(shape.keyColumns.map(lower));
  if (shape.folded) columns.add(LEGACY_PROGRAM_ID_COLUMN);
  for (const plan of targets) for (const column of plan.columns) columns.add(column);
  return [...columns];
}

function sameShape(a: LegacyTableShape, b: LegacyTableShape): boolean {
  const columns = (shape: LegacyTableShape): string => JSON.stringify(shape.columns.map((column) => [column.name, column.type, column.scale ?? null]));
  return a.keyed === b.keyed && a.keyColumns.join('\u0000') === b.keyColumns.join('\u0000') && columns(a) === columns(b);
}

function wallClock(ctx: Pick<MigrationContext, 'clock'>): string {
  return formatCanonicalTimestamp(ctx.clock.now());
}

function forwardWatermark(ctx: Pick<MigrationContext, 'clock'>, legacyTable: string, snapshot: SnapshotRecord): WatermarkRecord {
  return { legacyTable, direction: 'forward', snapshotSeq: snapshot.seq, backupLsn: snapshot.checkpointLsn, finishedAt: wallClock(ctx) };
}

/** Snapshot `seq`, which must be ready to be read. */
async function readySnapshot(ctx: Pick<MigrationContext, 'db'>, seq: number): Promise<SnapshotRecord> {
  const snapshot = await requireSnapshot(ctx, seq);
  if (snapshot.state !== 'ready') throw new Error(`Snapshot ${String(seq)} is ${snapshot.state}, so the feed cannot read it`);
  return snapshot;
}

/** One owner's share of a table diff: the targets it may write, those it may not, its batcher and its counts. */
interface OwnerShare {
  readonly writable: readonly TargetPlan[];
  readonly readOnly: readonly TargetPlan[];
  readonly batcher: OwnerBatcher;
  readonly result: OwnerDiffResult;
}

/** The two sides of one table diff and the acceptance that judges their rows. */
interface DiffRun {
  readonly table: string;
  readonly keyed: boolean;
  readonly before: DiffSide;
  readonly after: DiffSide;
  readonly acceptance: Acceptance;
}

/** An owner whose base precedes the target snapshot, before its share is planned. */
interface PendingOwner {
  readonly owner: DataOwner;
  readonly writable: readonly LegacyTableTarget[];
  readonly readOnly: readonly LegacyTableTarget[];
  readonly result: OwnerDiffResult;
}

function emptyResult(owner: DataOwner, base: number | null, status: OwnerDiffResult['status']): OwnerDiffResult {
  return { owner, base, status, inserts: 0, updates: 0, deletes: 0, batches: 0, orphans: 0, droppedTargetAuthoritative: 0 };
}

function samePlans(a: readonly TargetPlan[], b: readonly TargetPlan[]): boolean {
  return a.length === b.length && a.every((plan) => b.includes(plan));
}

/** Adds one apply row per distinct discriminator the taking targets need, or one row when none needs any. */
async function send(
  share: OwnerShare,
  run: DiffRun,
  op: ApplyChange['op'],
  row: CanonicalRow,
  taken: readonly TargetPlan[],
  resolved: Resolved,
): Promise<void> {
  const route = { table: run.table, keyed: run.keyed, owner: share.result.owner };
  await addTaken(share.batcher, route, { op, row: row.encoding }, taken, resolved.tenantId, row.legacyProgramId);
  if (resolved.orphan) share.result.orphans += 1;
}

/** Counts a change no writable target takes when one of the owner's `target`-authoritative targets would. */
async function countDropped(share: OwnerShare, run: DiffRun, rows: readonly (readonly [DiffSide, CanonicalRow])[]): Promise<void> {
  for (const [side, row] of rows) {
    if ((await run.acceptance.filter(share.readOnly, side, row)).length === 0) continue;
    share.result.droppedTargetAuthoritative += 1;
    return;
  }
}

/** Applies one keyed change to one owner's writable targets; a row changing targets, tenant or target key is deleted and re-inserted. */
async function applyKeyedChange(share: OwnerShare, run: DiffRun, change: KeyedChange): Promise<void> {
  const { result } = share;
  if (change.op === 'insert') {
    const taken = await run.acceptance.filter(share.writable, run.after, change.after);
    if (taken.length === 0) return countDropped(share, run, [[run.after, change.after]]);
    await send(share, run, 'upsert', change.after, taken, run.after.tenants.resolve(run.table, change.after.row));
    result.inserts += 1;
    return;
  }
  if (change.op === 'delete') {
    const taken = await run.acceptance.filter(share.writable, run.before, change.before);
    if (taken.length === 0) return countDropped(share, run, [[run.before, change.before]]);
    await send(share, run, 'delete', change.before, taken, run.before.tenants.resolve(run.table, change.before.row));
    result.deletes += 1;
    return;
  }
  const was = await run.acceptance.filter(share.writable, run.before, change.before);
  const now = await run.acceptance.filter(share.writable, run.after, change.after);
  if (was.length === 0 && now.length === 0) {
    return countDropped(share, run, [
      [run.before, change.before],
      [run.after, change.after],
    ]);
  }
  const old = run.before.tenants.resolve(run.table, change.before.row);
  const next = run.after.tenants.resolve(run.table, change.after.row);
  const changed = new Set(change.columns.map(lower));
  const keyMoved = [...was, ...now].some((plan) => plan.target.keyColumns.some((column) => changed.has(lower(column))));
  if (samePlans(was, now) && old.tenantId === next.tenantId && !keyMoved) {
    if (!now.some((plan) => [...plan.columns].some((column) => changed.has(column)))) {
      const readOnly = await run.acceptance.filter(share.readOnly, run.after, change.after);
      if (readOnly.some((plan) => [...plan.columns].some((column) => changed.has(column)))) result.droppedTargetAuthoritative += 1;
      return;
    }
    await send(share, run, 'upsert', change.after, now, next);
    result.updates += 1;
    return;
  }
  if (was.length > 0) {
    await send(share, run, 'delete', change.before, was, old);
    result.deletes += 1;
  }
  if (now.length > 0) {
    await send(share, run, 'upsert', change.after, now, next);
    result.inserts += 1;
  }
}

/** Applies one keyless occurrence change to one owner: a delete of one matching row per removed occurrence, an insert per added one. */
async function applyMultisetChange(share: OwnerShare, run: DiffRun, change: MultisetChange): Promise<void> {
  const side = change.added > 0 ? run.after : run.before;
  const taken = await run.acceptance.filter(share.writable, side, change.row);
  if (taken.length === 0) return countDropped(share, run, [[side, change.row]]);
  const resolved = side.tenants.resolve(run.table, change.row.row);
  for (let index = 0; index < change.removed; index++) {
    await send(share, run, 'delete', change.row, taken, resolved);
    share.result.deletes += 1;
  }
  for (let index = 0; index < change.added; index++) {
    await send(share, run, 'insert', change.row, taken, resolved);
    share.result.inserts += 1;
  }
}

/** Rows of a keyed change with the side each is judged on. */
function keyedRows(run: DiffRun, change: KeyedChange): (readonly [DiffSide, CanonicalRow])[] {
  if (change.op === 'insert') return [[run.after, change.after]];
  if (change.op === 'delete') return [[run.before, change.before]];
  return [
    [run.before, change.before],
    [run.after, change.after],
  ];
}

/** Base snapshot of `owner`: the caller's, else the sequence of its `forward` watermark; null when it has none. */
async function baseOf(ctx: Pick<TableDiffContext, 'owners'>, options: ApplyTableDiffOptions, owner: DataOwner): Promise<number | null> {
  if (options.baseByOwner?.has(owner) === true) return options.baseByOwner.get(owner) ?? null;
  return (await ctx.owners.watermark(owner, options.table.name, 'forward'))?.snapshotSeq ?? null;
}

/**
 * Streams the table once from base snapshot `base` and once from `to`, and applies each change to every owner of the group,
 * `batchSize` changes at a time after preparing their acceptance.
 */
async function diffGroup(
  ctx: TableDiffContext,
  options: ApplyTableDiffOptions,
  base: number,
  members: readonly PendingOwner[],
  watermark: WatermarkRecord | null,
): Promise<void> {
  const { table, to } = options;
  const from = await readySnapshot(ctx, base);
  const beforeShape = await describeLegacyTable(ctx, { table, database: from.databaseName });
  const shape = await describeLegacyTable(ctx, { table, database: to.databaseName });
  if (!sameShape(beforeShape, shape)) {
    throw new Error(`${table.name} has other columns or another key in snapshot ${String(to.seq)} than in snapshot ${String(base)}`);
  }
  const run: DiffRun = {
    table: table.name,
    keyed: shape.keyed,
    before: { database: from.databaseName, tenants: await options.tenantsFor(base) },
    after: { database: to.databaseName, tenants: await options.tenantsFor(to.seq) },
    acceptance: new Acceptance(ctx, table.name),
  };
  const shares: OwnerShare[] = members.map((member) => ({
    writable: member.writable.map((target) => planTarget(target, shape)),
    readOnly: member.readOnly.map((target) => planTarget(target, shape)),
    result: member.result,
    batcher: createOwnerBatcher({
      owner: member.owner,
      legacyTable: table.name,
      direction: options.direction,
      snapshotSeq: to.seq,
      origin: 'migration-feed',
      columns: shape.columns,
      units: member.writable.map((target) => target.unit),
      batchSize: options.batchSize,
      sender: options.sender,
      watermark,
    }),
  }));

  const targets = [...new Set(shares.flatMap((share) => [...share.writable, ...share.readOnly].map((plan) => plan.target)))];
  const before = streamLegacyTable(ctx, { table, database: from.databaseName });
  const after = streamLegacyTable(ctx, { table, database: to.databaseName });
  if (shape.keyed) {
    const writableColumns = writableColumnsFor(
      shares.flatMap((share) => share.writable),
      shape,
    );
    for await (const changes of chunksOf(diffKeyedStreams(before, after, { columns: shape.columns, writableColumns }), options.batchSize)) {
      await run.acceptance.prepare(targets, changes.flatMap((change) => keyedRows(run, change)));
      for (const change of changes) for (const share of shares) await applyKeyedChange(share, run, change);
    }
  } else {
    for await (const changes of chunksOf(diffMultisetStreams(before, after), options.batchSize)) {
      await run.acceptance.prepare(targets, changes.map((change) => [change.added > 0 ? run.after : run.before, change.row] as const));
      for (const change of changes) for (const share of shares) await applyMultisetChange(share, run, change);
    }
  }
  for (const share of shares) share.result.batches = (await share.batcher.finish()).batches;
}

/**
 * Brings each owner's writable units of one table from its base snapshot to `to`; units outside `writableUnits` are never written.
 * An owner's watermark covers all its units on the table, so pass every `legacy`-authoritative unit of it, or `watermark: false`.
 */
export async function applyTableDiff(ctx: TableDiffContext, options: ApplyTableDiffOptions): Promise<TableDiffResult> {
  const { table, to } = options;
  const targets = ctx.catalog.unitsForLegacyTable(table.name);
  const watermark = options.watermark === false ? null : forwardWatermark(ctx, table.name, to);
  const results: OwnerDiffResult[] = [];
  const groups = new Map<number, PendingOwner[]>();
  for (const owner of options.owners ?? ctx.catalog.ownersForLegacyTable(table.name)) {
    const own = targets.filter((target) => target.owner === owner);
    const writable = own.filter((target) => options.writableUnits.has(target.unit));
    const readOnly = own.filter((target) => !options.writableUnits.has(target.unit));
    const base = writable.length === 0 ? null : await baseOf(ctx, options, owner);
    const status: OwnerDiffResult['status'] =
      writable.length === 0 ? 'not-writable' : base === null ? 'no-baseline' : base >= to.seq ? 'up-to-date' : 'applied';
    const result = emptyResult(owner, base, status);
    results.push(result);
    if (status === 'applied' && base !== null) {
      groups.set(base, [...(groups.get(base) ?? []), { owner, writable, readOnly, result }]);
    } else if ((status === 'not-writable' || status === 'no-baseline') && options.forceWatermark === true && watermark !== null) {
      await options.sender.putWatermark(owner, watermark);
    }
  }
  for (const base of [...groups.keys()].sort((a, b) => a - b)) await diffGroup(ctx, options, base, groups.get(base) ?? [], watermark);
  return { table: table.name, owners: results };
}


/** Catalog units that are not `target`-authoritative under `authority`. */
function legacyUnits(ctx: Pick<FeedContext, 'catalog'>, authority: CurrentAuthority): Set<string> {
  return new Set(
    ctx.catalog
      .units()
      .map((unit) => unit.id)
      .filter((unit) => !authority.isTargetAuthoritative(unit)),
  );
}

/** Migratable tables of `database` (the live database when null) in dependency order, any the order does not name appended by name. */
async function orderedTables(ctx: Pick<FeedContext, 'config' | 'legacy' | 'catalog'>, database: string | null): Promise<MigratableTable[]> {
  const pool = database === null ? await ctx.legacy.live() : await ctx.legacy.database(database);
  const tables = migratableTables(ctx.catalog, await listLegacyTables(pool));
  const programIds = [...new Set(tables.flatMap((table) => table.physical.flatMap((part) => (part.programId === undefined ? [] : [part.programId]))))];
  const order = await computeDependencyOrder({
    inventory: ctx.config.paths.inventory,
    catalog: ctx.catalog,
    ...(programIds.length > 0 ? { programIds: programIds.sort((a, b) => a - b) } : {}),
  });
  // The order names each Program_<id> table and the migratable list its Program_N entry, so both fold to the ownership name.
  const byKey = new Map(tables.map((table) => [tableKey(table.name), table]));
  const ordered: MigratableTable[] = [];
  for (const name of order.order) {
    const key = tableKey(ctx.catalog.foldProgramTable(name).legacyTable);
    const table = byKey.get(key);
    if (table === undefined) continue;
    ordered.push(table);
    byKey.delete(key);
  }
  return [...ordered, ...[...byKey.values()].sort((a, b) => compareTableNames(a.name, b.name))];
}

/** Resolver per snapshot sequence, created once each over that snapshot's database. */
function tenantResolvers(ctx: TableDiffContext, to: SnapshotRecord): (seq: number) => Promise<TenantResolver> {
  const resolvers = new Map<number, Promise<TenantResolver>>();
  return (seq) => {
    let resolver = resolvers.get(seq);
    if (resolver === undefined) {
      resolver = (async () => {
        const database = seq === to.seq ? to.databaseName : (await readySnapshot(ctx, seq)).databaseName;
        return createApplyTenantResolver(ctx, { database });
      })();
      resolvers.set(seq, resolver);
    }
    return resolver;
  };
}

/** Forward watermark sequence per table and owner holding legacy-authoritative units of it. @throws FeedBaselineMissingError */
async function scanBases(
  ctx: Pick<FeedContext, 'catalog' | 'owners'>,
  tables: readonly MigratableTable[],
  writableUnits: ReadonlySet<string>,
): Promise<Map<string, Map<DataOwner, number>>> {
  const bases = new Map<string, Map<DataOwner, number>>();
  for (const table of tables) {
    const targets = ctx.catalog.unitsForLegacyTable(table.name);
    const owners = new Map<DataOwner, number>();
    for (const owner of ctx.catalog.ownersForLegacyTable(table.name)) {
      if (!targets.some((target) => target.owner === owner && writableUnits.has(target.unit))) continue;
      const seq = (await ctx.owners.watermark(owner, table.name, 'forward'))?.snapshotSeq ?? null;
      if (seq === null) throw new FeedBaselineMissingError(table.name, owner);
      owners.set(owner, seq);
    }
    bases.set(table.name, owners);
  }
  return bases;
}

/** Inputs of {@link feedFiles}. */
interface FilesInput {
  to: SnapshotRecord;
  authority: CurrentAuthority;
  writableUnits: ReadonlySet<string>;
  tables: readonly MigratableTable[];
  bases: ReadonlyMap<string, ReadonlyMap<DataOwner, number>>;
}

/** Transfers file-store objects added or changed since the file owner's `tfiles` watermark and deletes those dropped, before the later table pass advances it. */
async function feedFiles(ctx: FeedContext, input: FilesInput): Promise<FeedFilesResult> {
  const { to } = input;
  const filesTable = input.tables.find((table) => tableKey(table.name) === FILES_TABLE);
  if (filesTable === undefined) return { status: 'not-applicable', reason: `${FILES_TABLE} is not a migratable table of snapshot ${String(to.seq)}` };
  const fileUnits = fileUnitIds(ctx.config);
  const owners = [...new Set(fileUnits.map((unit) => ownerBySchema(ctx.config, unit.slice(0, unit.indexOf('.'))).name))];
  // A file unit is no catalog unit; the units its owner feeds from tfiles decide whether its objects are still legacy's.
  const fed = ctx.catalog
    .unitsForLegacyTable(filesTable.name)
    .filter((target) => owners.includes(target.owner))
    .map((target) => target.unit);
  const blocked = [...fileUnits.filter((unit) => input.authority.isTargetAuthoritative(unit)), ...fed.filter((unit) => !input.writableUnits.has(unit))];
  if (blocked.length > 0) return { status: 'skipped-target-authoritative', units: [...new Set(blocked)].sort() };
  const store = to.fileStore;
  if (store?.status === 'unsupported') return { status: 'halted', reason: new FileStoreUnsupportedError(store.fileStore, store.siteId).message };
  if (!to.manifestComplete) {
    return { status: 'halted', reason: `snapshot ${String(to.seq)} recorded no file manifest: its legacy file store is not ${SUPPORTED_FILE_STORE}` };
  }
  const from = Math.min(
    ...owners.map((owner) => {
      const base = input.bases.get(filesTable.name)?.get(owner);
      if (base === undefined) throw new FeedBaselineMissingError(filesTable.name, owner);
      return base;
    }),
  );
  if (from >= to.seq) return { status: 'up-to-date', from, to: to.seq };
  const diff = await diffSnapshotManifests(ctx, from, to.seq);
  let transfer: TransferResult;
  try {
    transfer = await transferFiles(ctx, to.seq, { only: diff.toTransfer });
  } catch (error) {
    if (error instanceof FileStoreUnsupportedError) return { status: 'halted', reason: error.message };
    throw error;
  }
  const removal = await removeDroppedObjects(ctx, diff);
  return { status: 'transferred', from, to: to.seq, transfer, removal };
}

/** Units the point after a feed reconciles: every legacy-authoritative unit with a migratable table, plus the file units when their objects were fed. */
function reconciledUnits(ctx: Pick<FeedContext, 'catalog' | 'config'>, writableUnits: ReadonlySet<string>, files: FeedFilesResult): string[] {
  const withTables = [...writableUnits].filter((unit) => ctx.catalog.legacyTablesOf(unit).some((table) => ctx.catalog.isMigratable(table)));
  const fileUnits = files.status === 'skipped-target-authoritative' || files.status === 'not-applicable' ? [] : fileUnitIds(ctx.config);
  return [...new Set([...withTables, ...fileUnits])].sort();
}

function describeResult(result: TableDiffResult): string {
  return result.owners
    .map((owner) =>
      owner.status === 'applied'
        ? `${owner.owner} +${String(owner.inserts)} ~${String(owner.updates)} -${String(owner.deletes)} in ${String(owner.batches)} batches`
        : `${owner.owner} ${owner.status}`,
    )
    .join(', ');
}

/**
 * `opt2-migrate feed`: applies each table's changes since its owners' watermarks to a new feed snapshot (or `snapshotSeq`)
 * for legacy-authoritative units only, then reconciles `after-feed-<seq>`.
 * @throws FeedBaselineMissingError before any snapshot is taken.
 */
export async function runFeed(ctx: FeedContext, options: FeedOptions = {}): Promise<FeedResult> {
  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const writableUnits = legacyUnits(ctx, authority);
  const resumed = options.snapshotSeq === undefined ? null : await readySnapshot(ctx, options.snapshotSeq);
  const listed = resumed ?? (await latestSnapshot(ctx));
  const tables = await orderedTables(ctx, listed?.databaseName ?? null);
  const bases = await scanBases(ctx, tables, writableUnits);
  const to = resumed ?? (await takeSnapshot(ctx, { kind: FEED_SNAPSHOT_KIND }));

  const files = await feedFiles(ctx, { to, authority, writableUnits, tables, bases });
  const sender = createBatchSender({ owners: ctx.owners });
  const tenantsFor = tenantResolvers(ctx, to);
  const batchSize = batchSizeOf(ctx.config);
  const results: TableDiffResult[] = [];
  for (const table of tables) {
    const result = await applyTableDiff(ctx, {
      table,
      to,
      writableUnits,
      baseByOwner: bases.get(table.name) ?? new Map(),
      direction: 'feed',
      tenantsFor,
      sender,
      batchSize,
    });
    results.push(result);
    ctx.logger.info(`feed to snapshot ${String(to.seq)}: ${table.name}: ${describeResult(result)}`);
  }

  const point = `after-feed-${String(to.seq)}`;
  const report = await reconcileUnits(ctx, { point, units: reconciledUnits(ctx, writableUnits, files), database: to.databaseName, snapshotSeq: to.seq });
  const reportPath = await writeReconciliationReport(ctx, report);
  return {
    snapshotSeq: to.seq,
    tableVersion: authority.tableVersion,
    bases: Object.fromEntries([...bases].map(([table, owners]) => [table, Object.fromEntries(owners)])),
    tables: results,
    files,
    reconciliation: { point, result: report.result, reportPath },
    exitCode: report.result === 'zero-difference' ? 0 : 1,
  };
}

/** Inputs of {@link rebaselineOwner}: one owner's restarted targets of one table, in catalog order. */
interface RebaselineInput {
  table: MigratableTable;
  owner: DataOwner;
  targets: readonly LegacyTableTarget[];
  snapshot: SnapshotRecord;
  runId: string;
  tenants: TenantResolver;
  sender: BatchSender;
  batchSize: number;
}

/** Column a re-baseline diff compares each row's stored object under; U+0000 keeps it apart from every SQL Server column name. */
const OBJECT_DIGEST: CanonicalColumn = { name: '\u0000object', type: 's' };

/** Size and SHA-256 of one object as comparable text. */
function objectDigest(entry: Pick<ObjectEntry, 'size' | 'sha256'>): string {
  return `${String(entry.size)}:${entry.sha256}`;
}

/** `rows` with `digestOf(row)` under {@link OBJECT_DIGEST}; leaving the iteration releases `rows`. */
async function* withDigest(rows: RowSource<CanonicalRow>, digestOf: (row: CanonicalRow) => string | null): AsyncGenerator<CanonicalRow, void, undefined> {
  for await (const row of rows) yield { ...row, row: { ...row.row, [OBJECT_DIGEST.name]: digestOf(row) } };
}

/** Diff sides of an object-backed unit with each row's object digest (target's by `legacyPath`, legacy's from its bytes). */
function withObjectDigests(
  shape: UnitTableShape,
  objectColumn: CanonicalColumn,
  current: TargetUnitRows,
  legacyRows: RowSource<CanonicalRow>,
): { before: RowSource<CanonicalRow>; after: RowSource<CanonicalRow>; columns: CanonicalColumn[] } {
  const byPath = new Map<string, string[]>();
  for (const entry of current.objects ?? []) byPath.set(entry.key, [...(byPath.get(entry.key) ?? []), objectDigest(entry)]);
  const stored = new Map([...byPath].map(([path, digests]) => [path, digests.sort().join(',')]));
  const targetDigest = (row: CanonicalRow): string | null => stored.get(objectLegacyPath(shape, row)) ?? null;
  const legacyDigest = (row: CanonicalRow): string | null => {
    const bytes = row.row[objectColumn.name] ?? null;
    return bytes === null ? null : objectDigest({ size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) });
  };
  return { before: withDigest(current.rows, targetDigest), after: withDigest(legacyRows, legacyDigest), columns: [...shape.columns, OBJECT_DIGEST] };
}

/** Turns each restarted unit's exported rows and stored objects into its legacy rows at the snapshot; the owner's last unit carries the table's watermark. */
async function rebaselineOwner(ctx: TableDiffContext, input: RebaselineInput): Promise<RestartTableResult['rebaseline']> {
  const { table, owner, snapshot, tenants } = input;
  const counts: RestartTableResult['rebaseline'] = { units: [], inserts: 0, updates: 0, deletes: 0, batches: 0 };
  const tableShape = await describeLegacyTable(ctx, { table, database: snapshot.databaseName });
  for (const [index, target] of input.targets.entries()) {
    counts.units.push(target.unit);
    const shape = await describeUnitTable(ctx, { unit: target.unit, legacyTable: table.name, database: snapshot.databaseName });
    const hint = hintOf(target, tableShape.columns);
    // The owner's mapping reads a column split from the row even when the unit owns no share of that column.
    const carried = shape.columns.some((column) => lower(column.name) === hint.predicateColumn) ? undefined : hint.carried;
    // describeUnitTable sets apart at most one object column; its bytes ride on the batch so the owner stores the object.
    const [objectColumn] = shape.objectColumns;
    const columns = [...shape.columns, ...(carried === undefined ? [] : [carried.column]), ...shape.objectColumns];
    const batcher = createOwnerBatcher({
      owner,
      legacyTable: table.name,
      // Batch ids do not name the unit, so each restarted unit of the owner batches under its own direction.
      direction: `rebaseline:${input.runId}:${target.unit}`,
      snapshotSeq: snapshot.seq,
      origin: 'migration-feed',
      columns,
      units: [target.unit],
      batchSize: input.batchSize,
      sender: input.sender,
      watermark: index === input.targets.length - 1 ? forwardWatermark(ctx, table.name, snapshot) : null,
    });
    // Legacy rows already encode over `columns` unless a split column is carried; a deleted target row holds no object bytes.
    const encodingOf = (op: ApplyChange['op'], row: CanonicalRow): string => {
      if (carried === undefined && (objectColumn === undefined || op !== 'delete')) return row.encoding;
      const values: Record<string, CanonicalValue> = { ...row.row };
      if (carried !== undefined) values[carried.column.name] = carried.value;
      if (objectColumn !== undefined && op === 'delete') values[objectColumn.name] = null;
      return encodeRow(columns, values);
    };
    const add = (tenantId: string, op: ApplyChange['op'], row: CanonicalRow): Promise<void> =>
      batcher.add(
        tenantId,
        {
          op,
          row: encodingOf(op, row),
          ...(hint.discriminator === undefined ? {} : { discriminator: hint.discriminator }),
        },
        row.legacyProgramId,
      );

    // The legacy rows of an object-backed unit also carry the object bytes, after the compared columns.
    const legacyShape = objectColumn === undefined ? shape : { ...shape, columns: [...shape.columns, objectColumn], objectColumns: [] };
    const legacy = await readLegacyUnitRows(ctx, legacyShape, { database: snapshot.databaseName, tenants });
    try {
      for (const tenantId of [...new Set([...tenants.siteTenants(), ...legacy.tenants])].sort()) {
        const current = await readTargetUnitRows(ctx, shape, tenantId);
        try {
          if (shape.keyed) {
            const sides =
              objectColumn === undefined
                ? { before: current.rows, after: legacy.rows(tenantId), columns: shape.columns }
                : withObjectDigests(shape, objectColumn, current, legacy.rows(tenantId));
            const writableColumns = sides.columns.map((column) => column.name);
            for await (const change of diffKeyedStreams(sides.before, sides.after, { columns: sides.columns, writableColumns })) {
              if (change.op === 'delete') {
                await add(tenantId, 'delete', change.before);
                counts.deletes += 1;
              } else {
                await add(tenantId, 'upsert', change.after);
                if (change.op === 'insert') counts.inserts += 1;
                else counts.updates += 1;
              }
            }
          } else {
            for await (const change of diffMultisetStreams(current.rows, legacy.rows(tenantId))) {
              for (let occurrence = 0; occurrence < change.removed; occurrence++) await add(tenantId, 'delete', change.row);
              for (let occurrence = 0; occurrence < change.added; occurrence++) await add(tenantId, 'insert', change.row);
              counts.deletes += change.removed;
              counts.inserts += change.added;
            }
          }
        } finally {
          await current.dispose();
        }
      }
    } finally {
      await legacy.dispose();
    }
    counts.batches += (await batcher.finish()).batches;
  }
  return counts;
}

/**
 * Restarts the forward feed for `units` at a fresh `rebaseline` snapshot (or `snapshotSeq`): per (table, owner), catches up the
 * owner's other legacy units, re-baselines the restarted ones against its exports and moves its watermark to the snapshot.
 * @throws FeedAuthorityError when a unit is still `target`-authoritative; UnknownUnitError for a unit the catalog lacks.
 */
export async function restartFeedFor(ctx: FeedContext, options: RestartFeedOptions): Promise<RestartFeedResult> {
  const units = [...new Set(options.units)].sort();
  for (const unit of units) ctx.catalog.unit(unit);
  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const held = units.filter((unit) => authority.isTargetAuthoritative(unit));
  if (held.length > 0) throw new FeedAuthorityError(held);

  const snapshot =
    options.snapshotSeq === undefined ? await takeSnapshot(ctx, { kind: REBASELINE_SNAPSHOT_KIND }) : await readySnapshot(ctx, options.snapshotSeq);
  const runId = randomUUID();
  const restarted = new Set(units);
  const wanted = new Set(
    units
      .flatMap((unit) => ctx.catalog.legacyTablesOf(unit))
      .filter((table) => ctx.catalog.isMigratable(table))
      .map((table) => tableKey(ctx.catalog.foldProgramTable(table).legacyTable)),
  );
  // Tables the snapshot lacks (fixture tables while the fixtures are unavailable) have nothing to re-baseline against.
  const tables = (await orderedTables(ctx, snapshot.databaseName)).filter((table) => wanted.has(tableKey(table.name)));
  const sender = createBatchSender({ owners: ctx.owners });
  const tenantsFor = tenantResolvers(ctx, snapshot);
  const batchSize = batchSizeOf(ctx.config);

  const results: RestartTableResult[] = [];
  for (const table of tables) {
    const targets = ctx.catalog.unitsForLegacyTable(table.name);
    for (const owner of ctx.catalog.ownersForLegacyTable(table.name)) {
      const own = targets.filter((target) => target.owner === owner);
      const mine = own.filter((target) => restarted.has(target.unit));
      if (mine.length === 0) continue;
      const others = own.filter((target) => !restarted.has(target.unit) && !authority.isTargetAuthoritative(target.unit)).map((target) => target.unit);
      const catchUp =
        others.length === 0
          ? null
          : ((
              await applyTableDiff(ctx, {
                table,
                to: snapshot,
                writableUnits: new Set(others),
                owners: [owner],
                direction: 'catch-up',
                tenantsFor,
                sender,
                batchSize,
                watermark: false,
              })
            ).owners[0] ?? null);
      const rebaseline = await rebaselineOwner(ctx, {
        table,
        owner,
        targets: mine,
        snapshot,
        runId,
        tenants: await tenantsFor(snapshot.seq),
        sender,
        batchSize,
      });
      results.push({ table: table.name, owner, catchUp, rebaseline });
      ctx.logger.info(
        `feed restart at snapshot ${String(snapshot.seq)}: ${table.name} ${owner} re-baselined ${rebaseline.units.join(', ')}: ` +
          `+${String(rebaseline.inserts)} ~${String(rebaseline.updates)} -${String(rebaseline.deletes)} in ${String(rebaseline.batches)} batches`,
      );
    }
  }
  return { snapshotSeq: snapshot.seq, units, tables: results };
}

