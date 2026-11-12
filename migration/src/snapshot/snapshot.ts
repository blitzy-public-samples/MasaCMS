// Takes, reads and drops snapshots: copy-only backups of the live legacy database restored read-only beside it.
import { rm } from 'node:fs/promises';
import path from 'node:path';

import sql from 'mssql';

import type { MigrationContext } from '../context.js';
import type { MigrationEnv } from '../env.js';
import { clearCatalogCache } from '../extract/catalog.js';
import { buildFileManifest, FileStoreUnsupportedError, type FilesContext } from '../files/manifest.js';
import { snapshotsDir } from '../paths.js';
// The `source_sha` column is NOT NULL; the pin is read through the one existing pin reader rather than a second parser.
import { readSourceSha } from '../reports/source-pin.js';

import {
  BACKUPSET_LSN_SQL,
  DATABASE_EXISTS_SQL,
  DEFAULT_PATHS_SQL,
  backupDatabaseSql,
  backupFileName,
  dropDatabaseSql,
  planRestoreMoves,
  restoreFileListSql,
  restoreSnapshotSql,
  setReadOnlySql,
  snapshotDatabaseNameFor,
  type FileListRow,
} from './backup.js';
import { prepareBackupDir } from './backup-dir.js';
import { runMasterStatement, SnapshotError } from './master.js';

/** Kinds `migration.snapshot.kind` accepts. */
export const SNAPSHOT_KINDS = ['seed', 'workload', 'transition', 'rebaseline', 'checkpoint', 'feed'] as const;

/** Quiesced point a snapshot is taken at. */
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** Lifecycle state of a `migration.snapshot` row. */
export type SnapshotState = 'creating' | 'ready' | 'failed' | 'dropped';

/** Result of building the snapshot's file-store manifest. */
export type FileStoreOutcome =
  | { status: 'ok'; objects: number }
  | { status: 'unsupported'; fileStore: string; siteId: string }
  | { status: 'error'; message: string };

/**
 * One snapshot: its read-only database, backup file and LSNs (as text, since `numeric(25,0)` exceeds safe integers;
 * `null` until the backup completes).
 */
export interface SnapshotRecord {
  seq: number;
  kind: SnapshotKind;
  state: SnapshotState;
  databaseName: string;
  backupPath: string;
  checkpointLsn: string | null;
  lastLsn: string | null;
  takenAt: Date;
  /** Transition whose lease holder took the snapshot, if any. */
  transitionId: string | null;
  sourceSha: string;
  manifestComplete: boolean;
  /**
   * Manifest outcome, `null` while unknown. Read back from the row it is `ok` with the stored object count once the
   * manifest is complete and `error` once the build failed; an unsupported store is known only to `takeSnapshot`.
   */
  fileStore: FileStoreOutcome | null;
}

/** Options of {@link takeSnapshot}; `holderId` is the transition lease holder taking it, whose own leases do not block. */
export interface TakeSnapshotOptions {
  kind: SnapshotKind;
  holderId?: string;
}

/** Context the snapshot functions use; each function takes the narrowest part it needs. */
export type SnapshotContext = FilesContext & Pick<MigrationContext, 'env' | 'config' | 'db' | 'legacy' | 'clock' | 'logger'>;

/** Outcome of {@link dropSnapshot}; each flag says whether that artefact still existed and was removed. */
export interface DropSnapshotResult {
  seq: number;
  databaseDropped: boolean;
  backupDeleted: boolean;
  manifestRowsDeleted: number;
}

export { runMasterStatement, SnapshotError } from './master.js';
export type { MasterStatementInput } from './master.js';

/** The units one lease holder keeps. */
export interface SnapshotLeaseHolder {
  holderId: string;
  kind: string;
  units: string[];
}

/** Raised when unit leases of write windows or other transitions are held, so the legacy database is not quiesced. */
export class SnapshotBlockedError extends SnapshotError {
  override readonly name: string = 'SnapshotBlockedError';
  readonly leases: SnapshotLeaseHolder[];

  constructor(leases: SnapshotLeaseHolder[]) {
    const held = leases.map((lease) => `${lease.holderId} (${lease.kind}): ${lease.units.join(', ')}`).join('; ');
    super(`A snapshot needs a quiesced legacy database, but units are leased by ${held}`);
    this.leases = leases;
  }
}

/** Raised when no `migration.snapshot` row has the requested sequence. */
export class SnapshotNotFoundError extends SnapshotError {
  override readonly name: string = 'SnapshotNotFoundError';
  readonly seq: number;

  constructor(seq: number) {
    super(`Snapshot ${String(seq)} does not exist`);
    this.seq = seq;
  }
}

// Serialises sequence reservation, so two snapshots never read the same MAX(seq).
const SNAPSHOT_LOCK_KEY = 'migration.snapshot';
const LOCK_SNAPSHOTS_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const LEASES_SQL = 'SELECT unit, holder_id, kind FROM migration.unit_lease ORDER BY holder_id, unit';
const NEXT_SEQ_SQL = 'SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM migration.snapshot';
const RESERVE_SNAPSHOT_SQL =
  'INSERT INTO migration.snapshot (seq, database_name, backup_file, kind, transition_id, state, manifest_complete, ' +
  "taken_at, source_sha) VALUES ($1, $2, $3, $4, $5, 'creating', false, $6, $7)";
const COMPLETE_SNAPSHOT_SQL = 'UPDATE migration.snapshot SET checkpoint_lsn = $2, last_lsn = $3, taken_at = $4 WHERE seq = $1';
const SET_STATE_SQL = 'UPDATE migration.snapshot SET state = $2 WHERE seq = $1';
const SELECT_SNAPSHOT =
  'SELECT s.seq, s.kind, s.state, s.database_name, s.backup_file, s.checkpoint_lsn::text AS checkpoint_lsn, ' +
  's.last_lsn::text AS last_lsn, s.taken_at, s.transition_id, s.source_sha, s.manifest_complete, ' +
  '(SELECT count(*) FROM migration.file_manifest AS m WHERE m.snapshot_seq = s.seq)::integer AS objects ' +
  'FROM migration.snapshot AS s';
const SNAPSHOT_BY_SEQ_SQL = `${SELECT_SNAPSHOT} WHERE s.seq = $1`;
const LATEST_READY_SQL = `${SELECT_SNAPSHOT} WHERE s.state = 'ready' ORDER BY s.seq DESC LIMIT 1`;
const DELETE_MANIFEST_SQL = 'DELETE FROM migration.file_manifest WHERE snapshot_seq = $1';
const MARK_DROPPED_SQL = "UPDATE migration.snapshot SET state = 'dropped', manifest_complete = false WHERE seq = $1";

/** `migration.snapshot` row as `pg` returns it. */
interface SnapshotRow {
  seq: number;
  kind: SnapshotKind;
  state: SnapshotState;
  database_name: string;
  backup_file: string;
  checkpoint_lsn: string | null;
  last_lsn: string | null;
  taken_at: Date;
  transition_id: string | null;
  source_sha: string;
  manifest_complete: boolean;
  objects: number;
}

/** `migration.unit_lease` row. */
interface LeaseRecord {
  unit: string;
  holder_id: string;
  kind: string;
}

/** One row of `RESTORE FILELISTONLY`; `FileId` is bigint, which the driver returns as text. */
interface FileListRecord {
  LogicalName: string;
  Type: string;
  FileId: string | number;
}

/** Name of the read-only database holding snapshot `seq` of the live legacy database. */
export function snapshotDatabaseName(env: Pick<MigrationEnv, 'MURA_DATABASE'>, seq: number): string {
  return snapshotDatabaseNameFor(env.MURA_DATABASE, seq);
}

// Once the backup completed and its LSNs are recorded, `failed` is set only when the manifest build threw.
const MANIFEST_FAILED_MESSAGE = 'building the file manifest failed';

function fileStoreOf(row: SnapshotRow): FileStoreOutcome | null {
  if (row.manifest_complete) return { status: 'ok', objects: row.objects };
  return row.state === 'failed' && row.checkpoint_lsn !== null ? { status: 'error', message: MANIFEST_FAILED_MESSAGE } : null;
}

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    seq: row.seq,
    kind: row.kind,
    state: row.state,
    databaseName: row.database_name,
    backupPath: row.backup_file,
    checkpointLsn: row.checkpoint_lsn,
    lastLsn: row.last_lsn,
    takenAt: row.taken_at,
    transitionId: row.transition_id,
    sourceSha: row.source_sha,
    manifestComplete: row.manifest_complete,
    fileStore: fileStoreOf(row),
  };
}

/** Snapshot `seq`, or `null` when no row has it. */
export async function getSnapshot(ctx: Pick<SnapshotContext, 'db'>, seq: number): Promise<SnapshotRecord | null> {
  const result = await ctx.db.withMetadata((tx) => tx.query<SnapshotRow>(SNAPSHOT_BY_SEQ_SQL, [seq]));
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/** Snapshot `seq`; throws `SnapshotNotFoundError` when no row has it. */
export async function requireSnapshot(ctx: Pick<SnapshotContext, 'db'>, seq: number): Promise<SnapshotRecord> {
  const snapshot = await getSnapshot(ctx, seq);
  if (snapshot === null) throw new SnapshotNotFoundError(seq);
  return snapshot;
}

/** The ready snapshot with the highest sequence, or `null` when there is none. */
export async function latestSnapshot(ctx: Pick<SnapshotContext, 'db'>): Promise<SnapshotRecord | null> {
  const result = await ctx.db.withMetadata((tx) => tx.query<SnapshotRow>(LATEST_READY_SQL));
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

async function databaseExists(ctx: Pick<SnapshotContext, 'legacy'>, database: string): Promise<boolean> {
  const result = await runMasterStatement<{ id: number | null }>(ctx, DATABASE_EXISTS_SQL, [
    { name: 'name', type: sql.NVarChar(128), value: database },
  ]);
  const id = result.recordset[0]?.id;
  return id !== undefined && id !== null;
}

/** Leases that block a snapshot, per holder: every lease except those of the transition `holderId` taking it. */
function blockingLeases(rows: readonly LeaseRecord[], holderId: string | undefined): SnapshotLeaseHolder[] {
  const byHolder = new Map<string, SnapshotLeaseHolder>();
  for (const row of rows) {
    if (row.holder_id === holderId && row.kind === 'transition') continue;
    const lease = byHolder.get(row.holder_id) ?? { holderId: row.holder_id, kind: row.kind, units: [] };
    lease.units.push(row.unit);
    byHolder.set(row.holder_id, lease);
  }
  return [...byHolder.values()];
}

/** Sequence, database and backup file a `creating` row reserves for one snapshot attempt. */
interface Reservation {
  seq: number;
  databaseName: string;
  backupPath: string;
}

/**
 * Under the snapshot lock, checks that only the caller's own transition holds leases and records the next sequence as
 * a `creating` row without LSNs; the first snapshot is 0.
 */
async function reserveSnapshot(
  ctx: Pick<SnapshotContext, 'db' | 'env' | 'clock'>,
  opts: TakeSnapshotOptions,
  sourceSha: string,
): Promise<Reservation> {
  return ctx.db.withMetadata(async (tx) => {
    await tx.query(LOCK_SNAPSHOTS_SQL, [SNAPSHOT_LOCK_KEY]);
    const leases = await tx.query<LeaseRecord>(LEASES_SQL);
    const blocking = blockingLeases(leases.rows, opts.holderId);
    if (blocking.length > 0) throw new SnapshotBlockedError(blocking);
    const next = await tx.query<{ seq: number }>(NEXT_SEQ_SQL);
    const seq = next.rows[0]?.seq ?? 0;
    const databaseName = snapshotDatabaseName(ctx.env, seq);
    const backupPath = path.posix.join(snapshotsDir(ctx.env.OPT2_STATE_DIR), backupFileName(seq));
    const row = [seq, databaseName, backupPath, opts.kind, opts.holderId ?? null, ctx.clock.now(), sourceSha];
    await tx.query(RESERVE_SNAPSHOT_SQL, row);
    return { seq, databaseName, backupPath };
  });
}

/** Restores the backup at `backupPath` as read-only `databaseName`, with its files in the server's default directories. */
async function restoreReadOnly(
  ctx: Pick<SnapshotContext, 'env' | 'legacy'>,
  seq: number,
  databaseName: string,
  backupPath: string,
): Promise<void> {
  const listed = await runMasterStatement<FileListRecord>(ctx, restoreFileListSql(backupPath));
  const files: FileListRow[] = listed.recordset.map((row) => ({
    logicalName: row.LogicalName,
    type: row.Type,
    fileId: Number(row.FileId),
  }));
  const defaults = await runMasterStatement<{ dataPath: string | null; logPath: string | null }>(ctx, DEFAULT_PATHS_SQL);
  const dataPath = defaults.recordset[0]?.dataPath;
  const logPath = defaults.recordset[0]?.logPath;
  if (dataPath == null || logPath == null) throw new SnapshotError('SQL Server reports no default data or log directory');
  const moves = planRestoreMoves(files, { database: ctx.env.MURA_DATABASE, seq, dataPath, logPath });
  await runMasterStatement(ctx, restoreSnapshotSql(databaseName, backupPath, moves));
  await runMasterStatement(ctx, setReadOnlySql(databaseName));
}

/** Checkpoint and last LSN msdb recorded for the copy-only backup of the live database at `backupPath`. */
async function readBackupLsns(
  ctx: Pick<SnapshotContext, 'env' | 'legacy'>,
  backupPath: string,
): Promise<{ checkpointLsn: string; lastLsn: string }> {
  const result = await runMasterStatement<{ checkpointLsn: string; lastLsn: string }>(ctx, BACKUPSET_LSN_SQL, [
    { name: 'database', type: sql.NVarChar(128), value: ctx.env.MURA_DATABASE },
    { name: 'path', type: sql.NVarChar(4000), value: backupPath },
  ]);
  const row = result.recordset[0];
  if (row === undefined) {
    throw new SnapshotError(`msdb records no copy-only backup of ${ctx.env.MURA_DATABASE} at ${backupPath}`);
  }
  return { checkpointLsn: row.checkpointLsn, lastLsn: row.lastLsn };
}

/** Builds the manifest; a store other than `fileDir` is an outcome, not an error, since only the file units stay put. */
async function buildManifestOutcome(
  ctx: SnapshotContext,
  seq: number,
): Promise<Exclude<FileStoreOutcome, { status: 'error' }>> {
  try {
    const built = await buildFileManifest(ctx, seq);
    return { status: 'ok', objects: built.entries };
  } catch (error) {
    if (error instanceof FileStoreUnsupportedError) {
      return { status: 'unsupported', fileStore: error.fileStore, siteId: error.siteId };
    }
    throw error;
  }
}

async function setState(ctx: Pick<SnapshotContext, 'db'>, seq: number, state: SnapshotState): Promise<void> {
  await ctx.db.withMetadata((tx) => tx.query(SET_STATE_SQL, [seq, state]));
}

/** Marks snapshot `seq` failed; returns `error` to rethrow, or an AggregateError adding the marking error when that fails. */
async function markFailed(ctx: Pick<SnapshotContext, 'db'>, seq: number, error: unknown, what: string): Promise<unknown> {
  try {
    await setState(ctx, seq, 'failed');
  } catch (markError) {
    return new AggregateError([error, markError], `${what}, and so did marking it failed`);
  }
  return error;
}

function elapsedMs(ctx: Pick<SnapshotContext, 'clock'>, since: Date): number {
  return ctx.clock.now().getTime() - since.getTime();
}

/** LSNs of a completed backup and the instants it started, completed and was restored. */
interface CompletedBackup {
  checkpointLsn: string;
  lastLsn: string;
  startedAt: Date;
  takenAt: Date;
  restoredAt: Date;
}

/** Backs up the live database into the reserved file, restores it read-only and records the backup's LSNs on the row. */
async function backUpAndRestore(ctx: SnapshotContext, reserved: Reservation): Promise<CompletedBackup> {
  const { seq, databaseName, backupPath } = reserved;
  await prepareBackupDir(ctx, backupPath);

  // This attempt reserved `seq`, so a database of that name belongs to no recorded attempt, e.g. it outlived a
  // re-bootstrapped migration schema.
  if (await databaseExists(ctx, databaseName)) {
    ctx.logger.warn(`dropping ${databaseName}, left by an unrecorded snapshot ${String(seq)}`);
    await runMasterStatement(ctx, dropDatabaseSql(databaseName));
  }

  const startedAt = ctx.clock.now();
  await runMasterStatement(ctx, backupDatabaseSql(ctx.env.MURA_DATABASE, backupPath));
  const takenAt = ctx.clock.now();
  await restoreReadOnly(ctx, seq, databaseName, backupPath);
  const { checkpointLsn, lastLsn } = await readBackupLsns(ctx, backupPath);
  const restoredAt = ctx.clock.now();
  await ctx.db.withMetadata((tx) => tx.query(COMPLETE_SNAPSHOT_SQL, [seq, checkpointLsn, lastLsn, takenAt]));
  return { checkpointLsn, lastLsn, startedAt, takenAt, restoredAt };
}

/**
 * Reserves the next sequence as a `creating` row, backs up the live legacy database copy-only into the reserved file,
 * restores it read-only as the snapshot database, records the backup's LSNs and builds its file manifest; a failure
 * after the reservation marks the row `failed`. Call only at a quiesced point.
 * @throws SnapshotBlockedError, before any SQL Server statement, when a window or another transition holds unit leases.
 */
export async function takeSnapshot(ctx: SnapshotContext, opts: TakeSnapshotOptions): Promise<SnapshotRecord> {
  const sourceSha = readSourceSha(ctx.config.paths.sourcePin);
  const reserved = await reserveSnapshot(ctx, opts, sourceSha);
  const { seq, databaseName, backupPath } = reserved;

  let backup: CompletedBackup;
  try {
    backup = await backUpAndRestore(ctx, reserved);
  } catch (error) {
    throw await markFailed(ctx, seq, error, `Snapshot ${String(seq)} failed`);
  }
  const { checkpointLsn, lastLsn, startedAt, takenAt, restoredAt } = backup;
  const transitionId = opts.holderId ?? null;

  let fileStore: Exclude<FileStoreOutcome, { status: 'error' }>;
  try {
    fileStore = await buildManifestOutcome(ctx, seq);
  } catch (error) {
    throw await markFailed(ctx, seq, error, `File manifest of snapshot ${String(seq)} failed`);
  }
  await setState(ctx, seq, 'ready');

  const backupMs = takenAt.getTime() - startedAt.getTime();
  const restoreMs = restoredAt.getTime() - takenAt.getTime();
  const manifestMs = elapsedMs(ctx, restoredAt);
  const files =
    fileStore.status === 'ok'
      ? `${String(fileStore.objects)} file objects`
      : `no file manifest, since site ${fileStore.siteId} uses file store ${fileStore.fileStore}`;
  ctx.logger.info(
    { latencyMs: elapsedMs(ctx, startedAt) },
    `snapshot ${String(seq)} (${opts.kind}) taken as ${databaseName}: backup ${String(backupMs)} ms, ` +
      `restore ${String(restoreMs)} ms, manifest ${String(manifestMs)} ms, ${files}`,
  );

  return {
    seq,
    kind: opts.kind,
    state: 'ready',
    databaseName,
    backupPath,
    checkpointLsn,
    lastLsn,
    takenAt,
    transitionId,
    sourceSha,
    manifestComplete: fileStore.status === 'ok',
    fileStore,
  };
}

/**
 * Drops the snapshot database, deletes its backup file and manifest rows, and marks the row dropped; the row itself stays,
 * since watermarks and reports refer to its sequence. Repeating a drop removes nothing more.
 */
export async function dropSnapshot(ctx: Pick<SnapshotContext, 'db' | 'legacy'>, seq: number): Promise<DropSnapshotResult> {
  const snapshot = await requireSnapshot(ctx, seq);
  const databaseDropped = await databaseExists(ctx, snapshot.databaseName);
  if (databaseDropped) await runMasterStatement(ctx, dropDatabaseSql(snapshot.databaseName));

  let backupDeleted = true;
  try {
    await rm(snapshot.backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    backupDeleted = false;
  }

  const manifestRowsDeleted = await ctx.db.withMetadata(async (tx) => {
    const deleted = await tx.query(DELETE_MANIFEST_SQL, [seq]);
    await tx.query(MARK_DROPPED_SQL, [seq]);
    return deleted.rowCount ?? 0;
  });
  clearCatalogCache(snapshot.databaseName);
  return { seq, databaseDropped, backupDeleted, manifestRowsDeleted };
}
