/** Legacy database snapshots: every public export of the T-SQL builders, snapshot lifecycle and live-database reset. */
export {
  SNAPSHOT_DB_INFIX,
  snapshotDatabaseNameFor,
  backupFileName,
  sqlNString,
  planRestoreMoves,
  backupDatabaseSql,
  restoreFileListSql,
  DEFAULT_PATHS_SQL,
  restoreSnapshotSql,
  setReadOnlySql,
  BACKUPSET_LSN_SQL,
  DATABASE_EXISTS_SQL,
  dropDatabaseSql,
  restoreLiveSql,
  UnsupportedDatabaseFileError,
} from './backup.js';
export type { FileListRow, RestoreMove } from './backup.js';

export {
  SNAPSHOT_KINDS,
  takeSnapshot,
  snapshotDatabaseName,
  getSnapshot,
  requireSnapshot,
  latestSnapshot,
  latestSnapshotOfKind,
  dropSnapshot,
  runMasterStatement,
  SnapshotError,
  SnapshotBlockedError,
  SnapshotNotFoundError,
} from './snapshot.js';
export type {
  SnapshotKind,
  SnapshotState,
  SnapshotRecord,
  FileStoreOutcome,
  TakeSnapshotOptions,
  SnapshotContext,
  DropSnapshotResult,
  MasterStatementInput,
  SnapshotLeaseHolder,
} from './snapshot.js';

export { restoreLiveFromSnapshot } from './restore.js';
export type { RestoreLiveResult } from './restore.js';
