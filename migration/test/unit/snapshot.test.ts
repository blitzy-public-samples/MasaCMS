// Unit tests for the T-SQL text builders behind snapshot backups, their read-only restores and the live-database reset,
// and for taking, reading, dropping and restoring snapshots over the migration schema and the fake SQL Server.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readManifest, storePath, type ManifestEntry } from '../../src/files/index.js';
import { snapshotsDir } from '../../src/paths.js';
import {
  SnapshotBlockedError,
  SnapshotNotFoundError,
  dropSnapshot,
  getSnapshot,
  latestSnapshot,
  requireSnapshot,
  restoreLiveFromSnapshot,
  takeSnapshot,
} from '../../src/snapshot/index.js';
import {
  MIGRATION_SCHEMA_SKIP_REASON,
  buildTestContext,
  withMigrationSchema,
  type MigrationSchemaHandle,
  type TestContext,
} from '../helpers/context.js';
import { TEST_SOURCE_SHA, createTestDirs, type TestDirs } from '../helpers/env.js';
import { createFakeLegacyDb, type FakeLegacyDb } from '../helpers/fake-legacy-db.js';
import { FILE_LISTINGS, FIXTURE_FILES, siteRow } from '../helpers/fixtures.js';
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

// ---------------------------------------------------------------------------------------------------------------------
// Snapshots over the migration schema

const schema = await withMigrationSchema();

afterAll(async () => {
  await schema?.drop();
});

/** Statement kind by a text only that statement contains; checked in order, so the drop and live restore precede RESTORE. */
const STATEMENT_KINDS: readonly (readonly [needle: string, kind: string])[] = [
  ['sys.master_files', 'data-file'],
  ['sys.dm_os_file_exists', 'dir-visible'],
  ['SELECT DB_ID(@name)', 'db-exists'],
  ['IF DB_ID(', 'drop'],
  ['WITH REPLACE', 'restore-live'],
  ['BACKUP DATABASE', 'backup'],
  ['RESTORE FILELISTONLY', 'filelist'],
  ['InstanceDefaultDataPath', 'default-paths'],
  ['RESTORE DATABASE', 'restore'],
  ['SET READ_ONLY', 'read-only'],
  ['msdb.dbo.backupset', 'lsn'],
  ['[dbo].[tsettings]', 'sites'],
  ['[dbo].[tfiles]', 'file-owners'],
];

/** `<database>:<kind>` of each statement the fake received from index `from` on; an unknown statement shows its text. */
function issued(legacy: FakeLegacyDb, from: number): string[] {
  return legacy.statements
    .slice(from)
    .map((statement) => `${statement.database}:${STATEMENT_KINDS.find(([needle]) => statement.sql.includes(needle))?.[1] ?? statement.sql}`);
}

/** Text of the one statement of `kind` received from index `from` on. */
function issuedSql(legacy: FakeLegacyDb, from: number, kind: string): string | undefined {
  const needle = STATEMENT_KINDS.find(([, name]) => name === kind)?.[0] ?? kind;
  const found = legacy.statements.slice(from).filter((statement) => statement.sql.includes(needle));
  expect(found).toHaveLength(1);
  return found[0]?.sql;
}

/** Copy-only backups msdb recorded, oldest first, with LSNs as text since numeric(25,0) exceeds safe integers. */
async function copyOnlyBackups(legacy: FakeLegacyDb): Promise<{ path: string; checkpointLsn: string; lastLsn: string }[]> {
  const pool = await legacy.database('msdb');
  const result = await pool
    .request()
    .query<{ path: string; checkpointLsn: string; lastLsn: string }>(
      'SELECT f.physical_device_name AS path, CAST(b.checkpoint_lsn AS varchar(25)) AS checkpointLsn, ' +
        'CAST(b.last_lsn AS varchar(25)) AS lastLsn FROM dbo.backupset AS b ' +
        'JOIN dbo.backupmediafamily AS f ON f.media_set_id = b.media_set_id WHERE b.is_copy_only = 1 ORDER BY b.backup_set_id;',
    );
  return result.recordset;
}

/** `DATABASEPROPERTYEX(name, 'Updateability')` of a database on the fake. */
async function updateability(legacy: FakeLegacyDb, database: string): Promise<string | null | undefined> {
  const pool = await legacy.database('master');
  const result = await pool
    .request()
    .input('name', database)
    .query<{ updateability: string | null }>("SELECT CAST(DATABASEPROPERTYEX(@name, 'Updateability') AS nvarchar(128)) AS updateability;");
  return result.recordset[0]?.updateability;
}

/** SiteID of every live `tsettings` row, in key order. */
function liveSites(legacy: FakeLegacyDb): unknown[] {
  return legacy.rows('dbo.tsettings').map((row) => row.SiteID);
}

/** The manifest a snapshot of the fixture store records: every listed object, the uncatalogued one an orphan. */
function fixtureManifest(snapshotSeq: number): ManifestEntry[] {
  const entries = Object.entries(FILE_LISTINGS).flatMap(([siteId, listing]) =>
    listing.files.map(
      (file): ManifestEntry => ({
        snapshotSeq,
        siteId,
        path: storePath(siteId, file.name),
        name: file.name,
        fileId: file.fileId,
        variant: file.variant,
        ext: file.ext,
        size: file.size,
        sha256: file.sha256,
        orphan: file.fileId === FIXTURE_FILES.orphan.fileId,
      }),
    ),
  );
  const byKey = (a: ManifestEntry, b: ManifestEntry): number => {
    const left = `${a.siteId}\u0000${a.path}`;
    const right = `${b.siteId}\u0000${b.path}`;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  return entries.sort(byKey);
}

const LIVE_DATABASE = 'masa_test';
const pgSuiteTitle = 'takeSnapshot over the migration schema';

describe.skipIf(schema === null)(schema === null ? `${pgSuiteTitle} (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})` : pgSuiteTitle, () => {
  let server: TestDirs;
  let dataDir: string;
  let tc: TestContext;

  const migrationSchema = (): MigrationSchemaHandle => {
    if (schema === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
    return schema;
  };

  /** `migration.snapshot` rows as stored, in sequence order. */
  const snapshotRows = async (): Promise<Record<string, unknown>[]> => {
    const result = await migrationSchema().db.withMetadata((tx) =>
      tx.query<Record<string, unknown>>(
        'SELECT seq, kind, state, database_name, backup_file, checkpoint_lsn::text AS checkpoint_lsn, last_lsn::text AS last_lsn, ' +
          'transition_id, source_sha, manifest_complete FROM migration.snapshot ORDER BY seq',
      ),
    );
    return result.rows;
  };

  const lease = async (unit: string, holderId: string, kind: 'window' | 'transition'): Promise<void> => {
    await migrationSchema().db.withMetadata((tx) =>
      tx.query('INSERT INTO migration.unit_lease (unit, holder_id, kind, acquired_at) VALUES ($1, $2, $3, $4)', [
        unit,
        holderId,
        kind,
        tc.clock.now(),
      ]),
    );
  };

  beforeEach(async () => {
    server = await createTestDirs();
    // SQL Server's default data directory; the backup directory policy reads its account from the live data file there.
    dataDir = path.join(server.stateDir, 'mssql-data');
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, `${LIVE_DATABASE}.mdf`), '');
    await migrationSchema().db.withMetadata(async (tx) => {
      await tx.query('DELETE FROM migration.file_manifest');
      await tx.query('DELETE FROM migration.unit_lease');
      await tx.query('DELETE FROM migration.snapshot');
    });
    tc = await buildTestContext({
      env: { MURA_DATABASE: LIVE_DATABASE },
      migrationDb: migrationSchema().db,
      legacy: createFakeLegacyDb({ database: LIVE_DATABASE, dataPath: dataDir }),
      legacySeed: true,
    });
  });

  afterEach(async () => {
    await tc.close();
    await server.cleanup();
  });


  const backupOf = (seq: number): string => path.posix.join(snapshotsDir(tc.dirs.stateDir), `snap-${String(seq)}.bak`);

  it('backs up copy-only on master, restores the copy read-only, records its msdb LSNs and pairs the file manifest', async () => {
    const from = tc.legacy.statements.length;

    const record = await takeSnapshot(tc.ctx, { kind: 'seed' });

    const snapshotDb = 'masa_test_opt2_snap_0';
    const backupPath = backupOf(0);
    expect(issued(tc.legacy, from)).toEqual([
      'master:data-file',
      'master:dir-visible',
      'master:db-exists',
      'master:backup',
      'master:filelist',
      'master:default-paths',
      'master:restore',
      'master:read-only',
      'master:lsn',
      `${snapshotDb}:sites`,
      `${snapshotDb}:file-owners`,
    ]);
    expect(issuedSql(tc.legacy, from, 'backup')).toBe(
      `BACKUP DATABASE [masa_test] TO DISK = N'${backupPath}' WITH COPY_ONLY, CHECKSUM, INIT;`,
    );
    expect(issuedSql(tc.legacy, from, 'restore')).toBe(
      `RESTORE DATABASE [${snapshotDb}] FROM DISK = N'${backupPath}' WITH ` +
        `MOVE N'masa_test' TO N'${dataDir}/${snapshotDb}_masa_test.mdf', ` +
        `MOVE N'masa_test_log' TO N'${dataDir}/${snapshotDb}_masa_test_log.ldf', RECOVERY;`,
    );
    expect(issuedSql(tc.legacy, from, 'read-only')).toBe(`ALTER DATABASE [${snapshotDb}] SET READ_ONLY;`);
    expect(tc.legacy.statements.find((statement) => statement.sql.includes('msdb.dbo.backupset'))?.params).toEqual({
      database: 'masa_test',
      path: backupPath,
    });
    expect(tc.legacy.databases()).toContain(snapshotDb);
    expect(await updateability(tc.legacy, snapshotDb)).toBe('READ_ONLY');
    expect(await updateability(tc.legacy, 'masa_test')).toBe('READ_WRITE');

    const backups = await copyOnlyBackups(tc.legacy);
    expect(backups).toEqual([{ path: backupPath, checkpointLsn: expect.stringMatching(/^\d+$/), lastLsn: expect.stringMatching(/^\d+$/) }]);
    const manifest = fixtureManifest(0);
    expect(record).toEqual({
      seq: 0,
      kind: 'seed',
      state: 'ready',
      databaseName: snapshotDb,
      backupPath,
      checkpointLsn: backups[0]?.checkpointLsn,
      lastLsn: backups[0]?.lastLsn,
      takenAt: tc.clock.now(),
      transitionId: null,
      sourceSha: TEST_SOURCE_SHA,
      manifestComplete: true,
      fileStore: { status: 'ok', objects: manifest.length },
    });
    expect(await snapshotRows()).toEqual([
      {
        seq: 0,
        kind: 'seed',
        state: 'ready',
        database_name: snapshotDb,
        backup_file: backupPath,
        checkpoint_lsn: record.checkpointLsn,
        last_lsn: record.lastLsn,
        transition_id: null,
        source_sha: TEST_SOURCE_SHA,
        manifest_complete: true,
      },
    ]);
    expect(await getSnapshot(tc.ctx, 0)).toEqual(record);

    const recorded = await readManifest(tc.ctx, 0);
    expect(recorded).toEqual(manifest);
    expect(new Set(recorded.map((entry) => entry.variant))).toEqual(new Set(['', '_source', '_small', '_medium']));
    expect(recorded.filter((entry) => entry.orphan).map((entry) => entry.name)).toEqual(FIXTURE_FILES.orphan.names);
  });

  it('numbers the next snapshot after the last and reads each back by sequence', async () => {
    const first = await takeSnapshot(tc.ctx, { kind: 'seed' });
    const second = await takeSnapshot(tc.ctx, { kind: 'workload' });

    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(second).toMatchObject({ kind: 'workload', databaseName: 'masa_test_opt2_snap_1', backupPath: backupOf(1) });
    expect(tc.legacy.databases()).toEqual(expect.arrayContaining([first.databaseName, second.databaseName]));
    expect((await copyOnlyBackups(tc.legacy)).map((backup) => backup.path)).toEqual([backupOf(0), backupOf(1)]);
    expect(await latestSnapshot(tc.ctx)).toEqual(second);
    expect(await getSnapshot(tc.ctx, 0)).toEqual(first);
    expect(await requireSnapshot(tc.ctx, 1)).toEqual(second);
    expect(await getSnapshot(tc.ctx, 99)).toBeNull();
    const missing = await requireSnapshot(tc.ctx, 99).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SnapshotNotFoundError);
    expect(missing).toMatchObject({ seq: 99, message: 'Snapshot 99 does not exist' });
  });

  it.each([
    ['a write window', { unit: 'people.person', holderId: 'window-7', kind: 'window' as const }, undefined],
    ['a write window named as the holder', { unit: 'people.person', holderId: 'window-7', kind: 'window' as const }, 'window-7'],
    ['another transition', { unit: 'identity.user_account', holderId: 'tr-1', kind: 'transition' as const }, 'tr-2'],
  ])('refuses while %s leases a unit, before any SQL Server statement or row', async (_case, held, holderId) => {
    await lease(held.unit, held.holderId, held.kind);
    const from = tc.legacy.statements.length;

    const error = await takeSnapshot(tc.ctx, { kind: 'transition', holderId }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotBlockedError);
    expect((error as SnapshotBlockedError).leases).toEqual([{ holderId: held.holderId, kind: held.kind, units: [held.unit] }]);
    expect(tc.legacy.statements.slice(from)).toEqual([]);
    expect(await snapshotRows()).toEqual([]);
    expect(tc.legacy.databases().filter((name) => name.includes('_opt2_snap_'))).toEqual([]);
  });

  it("takes the snapshot under its own transition's leases and records that transition", async () => {
    await lease('people.person', 'tr-1', 'transition');
    await lease('identity.user_account', 'tr-1', 'transition');

    await expect(takeSnapshot(tc.ctx, { kind: 'transition' })).rejects.toBeInstanceOf(SnapshotBlockedError);
    const record = await takeSnapshot(tc.ctx, { kind: 'transition', holderId: 'tr-1' });

    expect(record).toMatchObject({ seq: 0, state: 'ready', transitionId: 'tr-1', manifestComplete: true });
    expect(await snapshotRows()).toEqual([expect.objectContaining({ seq: 0, kind: 'transition', transition_id: 'tr-1', state: 'ready' })]);
  });

  it('keeps the database copy of a store other than fileDir and reports the unsupported store instead of a manifest', async () => {
    const bridge = tc.bridge;
    if (bridge === null) throw new Error('the context starts a bridge double');
    bridge.setFileStore('s3');

    const record = await takeSnapshot(tc.ctx, { kind: 'checkpoint' });

    expect(record).toMatchObject({
      seq: 0,
      state: 'ready',
      databaseName: 'masa_test_opt2_snap_0',
      checkpointLsn: (await copyOnlyBackups(tc.legacy))[0]?.checkpointLsn,
      manifestComplete: false,
      fileStore: { status: 'unsupported', fileStore: 's3', siteId: 'default' },
    });
    expect(tc.legacy.databases()).toContain(record.databaseName);
    expect(await readManifest(tc.ctx, 0)).toEqual([]);
    expect(await getSnapshot(tc.ctx, 0)).toMatchObject({ state: 'ready', manifestComplete: false, fileStore: null });
  });

  it('drops the copy, its backup file and manifest rows on master, keeps the row as dropped and drops nothing more again', async () => {
    const first = await takeSnapshot(tc.ctx, { kind: 'seed' });
    const second = await takeSnapshot(tc.ctx, { kind: 'workload' });
    // The fake keeps backups in memory; this stands for the file SQL Server wrote.
    await writeFile(second.backupPath, 'backup');
    const from = tc.legacy.statements.length;

    const dropped = await dropSnapshot(tc.ctx, 1);

    expect(dropped).toEqual({ seq: 1, databaseDropped: true, backupDeleted: true, manifestRowsDeleted: fixtureManifest(1).length });
    expect(issued(tc.legacy, from)).toEqual(['master:db-exists', 'master:drop']);
    expect(issuedSql(tc.legacy, from, 'drop')).toBe(
      'IF DB_ID(N\'masa_test_opt2_snap_1\') IS NOT NULL BEGIN ALTER DATABASE [masa_test_opt2_snap_1] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ' +
        'DROP DATABASE [masa_test_opt2_snap_1]; END;',
    );
    expect(tc.legacy.databases()).not.toContain(second.databaseName);
    expect(tc.legacy.databases()).toContain(first.databaseName);
    await expect(stat(second.backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readManifest(tc.ctx, 1)).toEqual([]);
    expect(await readManifest(tc.ctx, 0)).toEqual(fixtureManifest(0));
    expect(await getSnapshot(tc.ctx, 1)).toMatchObject({ state: 'dropped', manifestComplete: false, fileStore: null });
    expect(await latestSnapshot(tc.ctx)).toEqual(first);

    expect(await dropSnapshot(tc.ctx, 1)).toEqual({ seq: 1, databaseDropped: false, backupDeleted: false, manifestRowsDeleted: 0 });
  });

  it('restores the live database from a snapshot backup on master, undoing later live changes', async () => {
    const snapshot = await takeSnapshot(tc.ctx, { kind: 'checkpoint' });
    const sites = liveSites(tc.legacy);
    tc.legacy.seed('dbo.tsettings', [siteRow('tenant-c')]);
    expect(liveSites(tc.legacy)).toContain('tenant-c');
    const from = tc.legacy.statements.length;

    const result = await restoreLiveFromSnapshot(tc.ctx, 0);

    expect(result).toEqual({ seq: 0, database: 'masa_test', backupPath: snapshot.backupPath, durationMs: 0 });
    expect(issued(tc.legacy, from)).toEqual(['master:restore-live']);
    expect(issuedSql(tc.legacy, from, 'restore-live')).toBe(
      [
        'ALTER DATABASE [masa_test] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;',
        'BEGIN TRY',
        `  RESTORE DATABASE [masa_test] FROM DISK = N'${snapshot.backupPath}' WITH REPLACE, RECOVERY;`,
        '  ALTER DATABASE [masa_test] SET MULTI_USER;',
        'END TRY',
        'BEGIN CATCH',
        '  ALTER DATABASE [masa_test] SET MULTI_USER;',
        '  THROW;',
        'END CATCH;',
      ].join('\n'),
    );
    expect(liveSites(tc.legacy)).toEqual(sites);
    expect(await updateability(tc.legacy, 'masa_test')).toBe('READ_WRITE');
    expect(await updateability(tc.legacy, snapshot.databaseName)).toBe('READ_ONLY');
  });
});

