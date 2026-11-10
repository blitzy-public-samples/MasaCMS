// Unit tests for the T-SQL text builders behind snapshot backups, their read-only restores and the live-database reset.
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { snapshotsDir } from '../../src/paths.js';
import {
  BACKUPSET_LSN_SQL,
  DATABASE_EXISTS_SQL,
  DEFAULT_PATHS_SQL,
  SNAPSHOT_DB_INFIX,
  UnsupportedDatabaseFileError,
  backupDatabaseSql,
  backupFileName,
  dropDatabaseSql,
  planRestoreMoves,
  restoreFileListSql,
  restoreLiveSql,
  restoreSnapshotSql,
  setReadOnlySql,
  snapshotDatabaseNameFor,
  sqlNString,
  type FileListRow,
  type RestoreMove,
} from '../../src/snapshot/backup.js';

const STATE_DIR = path.join(os.tmpdir(), 'opt2-snapshot-state');
const LINUX_PATHS = { database: 'muradb', seq: 2, dataPath: '/var/opt/mssql/data', logPath: '/var/opt/mssql/log' };
const MURADB_FILES: FileListRow[] = [
  { logicalName: 'muradb_log', type: 'L', fileId: 2 },
  { logicalName: 'muradb', type: 'D', fileId: 1 },
];

describe('snapshot naming', () => {
  it('names the snapshot database <database>_opt2_snap_<seq> and its backup file snap-<seq>.bak', () => {
    expect(SNAPSHOT_DB_INFIX).toBe('_opt2_snap_');
    expect(snapshotDatabaseNameFor('masa', 3)).toBe('masa_opt2_snap_3');
    expect(snapshotDatabaseNameFor('muradb', 0)).toBe(`muradb${SNAPSHOT_DB_INFIX}0`);
    expect(backupFileName(3)).toBe('snap-3.bak');
    expect(backupFileName(0)).toBe('snap-0.bak');
  });
});

describe('sqlNString', () => {
  it.each([
    ["a'b", "N'a''b'"],
    ['', "N''"],
    ["''", "N''''''"],
    ['/s/snap-0.bak', "N'/s/snap-0.bak'"],
    ['C:\\Backups\\snap-1.bak', "N'C:\\Backups\\snap-1.bak'"],
  ])('renders %j as the Unicode literal %s', (value, expected) => {
    expect(sqlNString(value)).toBe(expected);
  });
});

describe('backupDatabaseSql', () => {
  it('takes a copy-only, checksummed backup that overwrites earlier media at the path', () => {
    expect(backupDatabaseSql('muradb', '/s/snap-0.bak')).toBe(
      "BACKUP DATABASE [muradb] TO DISK = N'/s/snap-0.bak' WITH COPY_ONLY, CHECKSUM, INIT;",
    );
  });

  it('writes to snap-<n>.bak in the state directory snapshots folder', () => {
    const backupPath = path.join(snapshotsDir(STATE_DIR), backupFileName(4));
    const sql = backupDatabaseSql('muradb', backupPath);

    expect(backupPath).toBe(path.join(STATE_DIR, 'snapshots', 'snap-4.bak'));
    expect(sql).toBe(`BACKUP DATABASE [muradb] TO DISK = N'${backupPath}' WITH COPY_ONLY, CHECKSUM, INIT;`);
    expect(sql).toContain('COPY_ONLY');
    expect(sql).toContain('CHECKSUM');
    expect(sql).not.toContain('DIFFERENTIAL');
    expect(sql).not.toContain('NOINIT');
  });

  it('doubles ] in the database name and quotes in the backup path', () => {
    expect(backupDatabaseSql('mura]db', "/s/o'neil/snap-1.bak")).toBe(
      "BACKUP DATABASE [mura]]db] TO DISK = N'/s/o''neil/snap-1.bak' WITH COPY_ONLY, CHECKSUM, INIT;",
    );
  });
});

describe('restore discovery queries', () => {
  it('lists the logical files of the backup at a quoted path', () => {
    expect(restoreFileListSql('/s/snap-2.bak')).toBe("RESTORE FILELISTONLY FROM DISK = N'/s/snap-2.bak';");
    expect(restoreFileListSql("/s/o'neil.bak")).toBe("RESTORE FILELISTONLY FROM DISK = N'/s/o''neil.bak';");
  });

  it('reads the instance default data and log directories as dataPath and logPath', () => {
    expect(DEFAULT_PATHS_SQL).toBe(
      "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS dataPath, " +
        "CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS logPath;",
    );
  });
});

describe('planRestoreMoves', () => {
  it('places data files in dataPath as .mdf and log files in logPath as .ldf, in fileId order', () => {
    expect(planRestoreMoves(MURADB_FILES, LINUX_PATHS)).toEqual([
      { logicalName: 'muradb', type: 'D', physicalName: '/var/opt/mssql/data/muradb_opt2_snap_2_muradb.mdf' },
      { logicalName: 'muradb_log', type: 'L', physicalName: '/var/opt/mssql/log/muradb_opt2_snap_2_muradb_log.ldf' },
    ]);
  });

  it('sorts by fileId whatever the input order and leaves the input array unchanged', () => {
    const files: FileListRow[] = [
      { logicalName: 'extra', type: 'D', fileId: 3 },
      { logicalName: 'muradb', type: 'D', fileId: 1 },
      { logicalName: 'muradb_log', type: 'L', fileId: 2 },
    ];
    const before = structuredClone(files);

    const moves = planRestoreMoves(files, LINUX_PATHS);

    expect(moves.map((move) => move.logicalName)).toEqual(['muradb', 'muradb_log', 'extra']);
    expect(files).toEqual(before);
    expect(planRestoreMoves([...files].reverse(), LINUX_PATHS)).toEqual(moves);
  });

  it.each([
    ['/var/opt/mssql/data/', '/var/opt/mssql/data/muradb_opt2_snap_2_muradb.mdf'],
    ['/var/opt/mssql/data//', '/var/opt/mssql/data/muradb_opt2_snap_2_muradb.mdf'],
    ['C:\\SQL\\Data', 'C:\\SQL\\Data\\muradb_opt2_snap_2_muradb.mdf'],
    ['C:\\SQL\\Data\\', 'C:\\SQL\\Data\\muradb_opt2_snap_2_muradb.mdf'],
    ['C:/SQL\\Data\\', 'C:/SQL\\Data/muradb_opt2_snap_2_muradb.mdf'],
  ])('joins onto data directory %j as %s', (dataPath, physicalName) => {
    const [move] = planRestoreMoves([{ logicalName: 'muradb', type: 'D', fileId: 1 }], { ...LINUX_PATHS, dataPath });

    expect(move?.physicalName).toBe(physicalName);
  });

  it('replaces characters outside [A-Za-z0-9_.-] in the physical name only', () => {
    const [move] = planRestoreMoves([{ logicalName: "mura db/'x'é.v-1", type: 'L', fileId: 2 }], LINUX_PATHS);

    expect(move).toEqual({
      logicalName: "mura db/'x'é.v-1",
      type: 'L',
      physicalName: '/var/opt/mssql/log/muradb_opt2_snap_2_mura_db__x__.v-1.ldf',
    });
  });

  it.each(['S', 'F'])('rejects a backup file of type %s with UnsupportedDatabaseFileError', (type) => {
    const files: FileListRow[] = [...MURADB_FILES, { logicalName: 'muradb_extra', type, fileId: 3 }];
    let thrown: unknown;
    try {
      planRestoreMoves(files, LINUX_PATHS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedDatabaseFileError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: 'UnsupportedDatabaseFileError',
      logicalName: 'muradb_extra',
      type,
      message: `Backup file 'muradb_extra' has type '${type}'; only data (D) and log (L) files can be restored as a snapshot`,
    });
  });

  it('plans nothing for an empty file list', () => {
    expect(planRestoreMoves([], LINUX_PATHS)).toEqual([]);
  });
});

describe('restoreSnapshotSql', () => {
  it('restores under the snapshot name with one MOVE per planned file, in order, then RECOVERY', () => {
    const moves = planRestoreMoves(MURADB_FILES, LINUX_PATHS);
    const sql = restoreSnapshotSql('muradb_opt2_snap_2', '/s/snap-2.bak', moves);

    expect(sql).toBe(
      "RESTORE DATABASE [muradb_opt2_snap_2] FROM DISK = N'/s/snap-2.bak' WITH " +
        "MOVE N'muradb' TO N'/var/opt/mssql/data/muradb_opt2_snap_2_muradb.mdf', " +
        "MOVE N'muradb_log' TO N'/var/opt/mssql/log/muradb_opt2_snap_2_muradb_log.ldf', " +
        'RECOVERY;',
    );
    expect(sql).not.toContain('REPLACE');
  });

  it('doubles ] in the target name and quotes in the path, logical and physical names', () => {
    const moves: RestoreMove[] = [{ logicalName: "o'data", type: 'D', physicalName: "/d/o'data.mdf" }];

    expect(restoreSnapshotSql('snap]2', "/s/o'neil.bak", moves)).toBe(
      "RESTORE DATABASE [snap]]2] FROM DISK = N'/s/o''neil.bak' WITH MOVE N'o''data' TO N'/d/o''data.mdf', RECOVERY;",
    );
  });

  it('restores with RECOVERY alone when no file is moved', () => {
    expect(restoreSnapshotSql('muradb_opt2_snap_2', '/s/snap-2.bak', [])).toBe(
      "RESTORE DATABASE [muradb_opt2_snap_2] FROM DISK = N'/s/snap-2.bak' WITH RECOVERY;",
    );
  });
});

describe('snapshot database state queries', () => {
  it('marks a database read-only', () => {
    expect(setReadOnlySql('muradb_opt2_snap_2')).toBe('ALTER DATABASE [muradb_opt2_snap_2] SET READ_ONLY;');
    expect(setReadOnlySql('snap]2')).toBe('ALTER DATABASE [snap]]2] SET READ_ONLY;');
  });

  it('reads checkpoint and last LSN of the latest copy-only backup of @database to @path from msdb', () => {
    expect(BACKUPSET_LSN_SQL).toBe(
      [
        'SELECT TOP (1) CAST(b.checkpoint_lsn AS varchar(25)) AS checkpointLsn, CAST(b.last_lsn AS varchar(25)) AS lastLsn, b.backup_finish_date AS finishedAt',
        'FROM msdb.dbo.backupset AS b JOIN msdb.dbo.backupmediafamily AS f ON f.media_set_id = b.media_set_id',
        'WHERE b.database_name = @database AND b.is_copy_only = 1 AND f.physical_device_name = @path',
        'ORDER BY b.backup_finish_date DESC, b.backup_set_id DESC;',
      ].join('\n'),
    );
    expect(BACKUPSET_LSN_SQL).toContain('b.checkpoint_lsn');
    expect(BACKUPSET_LSN_SQL).toContain('b.last_lsn');
    expect(BACKUPSET_LSN_SQL).toContain('msdb.dbo.backupset');
    expect(BACKUPSET_LSN_SQL).toContain('b.is_copy_only = 1');
  });

  it('looks a database up by the @name parameter', () => {
    expect(DATABASE_EXISTS_SQL).toBe('SELECT DB_ID(@name) AS id;');
  });

  it('drops an existing database after disconnecting its sessions', () => {
    expect(dropDatabaseSql('muradb_opt2_snap_2')).toBe(
      "IF DB_ID(N'muradb_opt2_snap_2') IS NOT NULL BEGIN ALTER DATABASE [muradb_opt2_snap_2] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [muradb_opt2_snap_2]; END;",
    );
  });

  it('quotes the dropped name as a literal and as an identifier', () => {
    expect(dropDatabaseSql("snap]'2")).toBe(
      "IF DB_ID(N'snap]''2') IS NOT NULL BEGIN ALTER DATABASE [snap]]'2] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [snap]]'2]; END;",
    );
  });
});

describe('restoreLiveSql', () => {
  it('overwrites the live database in single-user mode and returns it to multi-user on success or failure', () => {
    const sql = restoreLiveSql('muradb', '/s/snap-4.bak');

    expect(sql).toBe(
      [
        'ALTER DATABASE [muradb] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;',
        'BEGIN TRY',
        "  RESTORE DATABASE [muradb] FROM DISK = N'/s/snap-4.bak' WITH REPLACE, RECOVERY;",
        '  ALTER DATABASE [muradb] SET MULTI_USER;',
        'END TRY',
        'BEGIN CATCH',
        '  ALTER DATABASE [muradb] SET MULTI_USER;',
        '  THROW;',
        'END CATCH;',
      ].join('\n'),
    );
    const order = ['SINGLE_USER WITH ROLLBACK IMMEDIATE', 'WITH REPLACE', 'RECOVERY', 'MULTI_USER'].map((token) =>
      sql.indexOf(token),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sql).not.toContain('MOVE');
  });

  it('doubles ] in the database name and quotes in the backup path', () => {
    const sql = restoreLiveSql('mura]db', "/s/o'neil.bak");

    expect(sql.split('\n')[0]).toBe('ALTER DATABASE [mura]]db] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;');
    expect(sql).toContain("  RESTORE DATABASE [mura]]db] FROM DISK = N'/s/o''neil.bak' WITH REPLACE, RECOVERY;");
    expect(sql.match(/ALTER DATABASE \[mura\]\]db\] SET MULTI_USER;/g)).toHaveLength(2);
  });
});
