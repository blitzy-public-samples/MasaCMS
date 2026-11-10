// T-SQL text builders for copy-only snapshot backups, their read-only restores and the live-database reset.
import { quoteIdent } from '../legacy/legacy-db.js';

/** Infix between the live database name and the sequence in a snapshot database name. */
export const SNAPSHOT_DB_INFIX = '_opt2_snap_';

/** Renders `value` as a T-SQL Unicode string literal (`a'b` becomes `N'a''b'`). */
export function sqlNString(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

/** Name of the read-only database that holds snapshot `seq` of `database`, e.g. `muradb_opt2_snap_3`. */
export function snapshotDatabaseNameFor(database: string, seq: number): string {
  return `${database}${SNAPSHOT_DB_INFIX}${seq}`;
}

/** File name of the backup taken for snapshot `seq`. */
export function backupFileName(seq: number): string {
  return `snap-${seq}.bak`;
}

/** Copy-only, checksummed backup of `database` to `backupPath`, overwriting any earlier media at that path. */
export function backupDatabaseSql(database: string, backupPath: string): string {
  return `BACKUP DATABASE ${quoteIdent(database)} TO DISK = ${sqlNString(backupPath)} WITH COPY_ONLY, CHECKSUM, INIT;`;
}

/** Lists the logical files held in the backup at `backupPath`. */
export function restoreFileListSql(backupPath: string): string {
  return `RESTORE FILELISTONLY FROM DISK = ${sqlNString(backupPath)};`;
}

/** Reads the server's default data and log directories as `dataPath` and `logPath`. */
export const DEFAULT_PATHS_SQL =
  "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS dataPath, " +
  "CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS logPath;";

/** One row of `RESTORE FILELISTONLY`, from its `LogicalName`, `Type` and `FileId` columns. */
export interface FileListRow {
  logicalName: string;
  type: string;
  fileId: number;
}

/** Where one logical file of a backup is placed when it is restored as a snapshot database. */
export interface RestoreMove {
  logicalName: string;
  type: 'D' | 'L';
  physicalName: string;
}

/** A backup file that is neither a data (`D`) nor a log (`L`) file, such as FILESTREAM (`S`) or full-text (`F`). */
export class UnsupportedDatabaseFileError extends Error {
  readonly logicalName: string;
  readonly type: string;

  constructor(logicalName: string, type: string) {
    super(
      `Backup file '${logicalName}' has type '${type}'; only data (D) and log (L) files can be restored as a snapshot`,
    );
    this.name = 'UnsupportedDatabaseFileError';
    this.logicalName = logicalName;
    this.type = type;
  }
}

const FILE_EXTENSIONS: Readonly<Record<RestoreMove['type'], string>> = { D: 'mdf', L: 'ldf' };

/** Joins `fileName` onto `directory` with the directory's own separator style. */
function joinServerPath(directory: string, fileName: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${fileName}`;
}

/**
 * Plans one `MOVE` per backup file, in `fileId` order, onto files named after the snapshot database so they never
 * collide with the live database's files. Throws `UnsupportedDatabaseFileError` for a file that is not data or log.
 */
export function planRestoreMoves(
  files: FileListRow[],
  opts: { database: string; seq: number; dataPath: string; logPath: string },
): RestoreMove[] {
  const prefix = snapshotDatabaseNameFor(opts.database, opts.seq);
  return [...files]
    .sort((a, b) => a.fileId - b.fileId)
    .map((file): RestoreMove => {
      if (file.type !== 'D' && file.type !== 'L') throw new UnsupportedDatabaseFileError(file.logicalName, file.type);
      const directory = file.type === 'D' ? opts.dataPath : opts.logPath;
      const safeLogical = file.logicalName.replace(/[^A-Za-z0-9_.-]/g, '_');
      return {
        logicalName: file.logicalName,
        type: file.type,
        physicalName: joinServerPath(directory, `${prefix}_${safeLogical}.${FILE_EXTENSIONS[file.type]}`),
      };
    });
}

/** Restores the backup at `backupPath` as `targetDatabase`, relocating every logical file as `moves` plans. */
export function restoreSnapshotSql(targetDatabase: string, backupPath: string, moves: RestoreMove[]): string {
  const options = [
    ...moves.map((move) => `MOVE ${sqlNString(move.logicalName)} TO ${sqlNString(move.physicalName)}`),
    'RECOVERY',
  ];
  return `RESTORE DATABASE ${quoteIdent(targetDatabase)} FROM DISK = ${sqlNString(backupPath)} WITH ${options.join(', ')};`;
}

/** Marks `database` read-only. */
export function setReadOnlySql(database: string): string {
  return `ALTER DATABASE ${quoteIdent(database)} SET READ_ONLY;`;
}

/**
 * Reads the checkpoint and last LSN (as text, since `numeric(25,0)` exceeds the safe integer range) and finish time of
 * the latest copy-only backup of `@database` written to `@path`.
 */
export const BACKUPSET_LSN_SQL = [
  'SELECT TOP (1) CAST(b.checkpoint_lsn AS varchar(25)) AS checkpointLsn, CAST(b.last_lsn AS varchar(25)) AS lastLsn, b.backup_finish_date AS finishedAt',
  'FROM msdb.dbo.backupset AS b JOIN msdb.dbo.backupmediafamily AS f ON f.media_set_id = b.media_set_id',
  'WHERE b.database_name = @database AND b.is_copy_only = 1 AND f.physical_device_name = @path',
  'ORDER BY b.backup_finish_date DESC, b.backup_set_id DESC;',
].join('\n');

/** Returns the database id of `@name` as `id`, or NULL when no such database exists. */
export const DATABASE_EXISTS_SQL = 'SELECT DB_ID(@name) AS id;';

/** Drops `database` if it exists, first disconnecting every session on it. */
export function dropDatabaseSql(database: string): string {
  const name = quoteIdent(database);
  return `IF DB_ID(${sqlNString(database)}) IS NOT NULL BEGIN ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${name}; END;`;
}

/**
 * Overwrites `database` from the backup at `backupPath` in one batch, holding the single-user slot throughout and
 * returning the database to multi-user whether or not the restore succeeds.
 */
export function restoreLiveSql(database: string, backupPath: string): string {
  const name = quoteIdent(database);
  return [
    `ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
    'BEGIN TRY',
    `  RESTORE DATABASE ${name} FROM DISK = ${sqlNString(backupPath)} WITH REPLACE, RECOVERY;`,
    `  ALTER DATABASE ${name} SET MULTI_USER;`,
    'END TRY',
    'BEGIN CATCH',
    `  ALTER DATABASE ${name} SET MULTI_USER;`,
    '  THROW;',
    'END CATCH;',
  ].join('\n');
}
