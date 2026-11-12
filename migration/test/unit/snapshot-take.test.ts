// Unit tests for taking a snapshot and readying its backup directory, with fake SQL Server and migration pools.
import { EventEmitter } from 'node:events';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationEnv } from '../../src/env.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import { snapshotsDir } from '../../src/paths.js';
import {
  BACKUP_DIR_MODE,
  NODE_BACKUP_DIR_FS,
  canSearch,
  prepareBackupDir,
  type BackupDirFs,
  type DirStat,
} from '../../src/snapshot/backup-dir.js';
import {
  SnapshotBlockedError,
  SnapshotError,
  getSnapshot,
  takeSnapshot,
  type SnapshotContext,
  type SnapshotState,
} from '../../src/snapshot/snapshot.js';

const DATABASE = 'muradb_c54';
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const BASE = Date.parse('2026-07-01T09:00:00.000Z');
const OWN_UID = process.getuid?.() ?? 0;
const OWN_GID = process.getgid?.() ?? 0;
const SQL_UID = OWN_UID === 65534 ? 65533 : 65534;
const SQL_GID = OWN_GID;
const OTHER_UID = SQL_UID - 1;
const FOREIGN_GID = OWN_GID + 4242;
const ACCOUNT = `SQL Server's account (uid ${String(SQL_UID)}, gid ${String(SQL_GID)})`;

/** Rows one statement returns, or the error it fails with; `columns` gives an empty result its shape. */
type Outcome = { columns?: string[]; rows?: Record<string, unknown>[] } | Error;
type Responder = (params: Record<string, unknown>) => Outcome;

interface TediousRequestLike extends EventEmitter {
  sqlTextOrProcedure: string | undefined;
  parameters: { name: string; value: unknown }[];
  callback: (err?: Error) => void;
}

/** Short name of a SQL Server statement, as the event log records it. */
function mssqlLabel(text: string): string {
  const labels: [string, string][] = [
    ['sys.master_files', 'data-file'],
    ['sys.dm_os_file_exists', 'dir-visible'],
    ['SELECT DB_ID(@name)', 'db-exists'],
    ['IF DB_ID(', 'drop'],
    ['BACKUP DATABASE', 'backup'],
    ['RESTORE FILELISTONLY', 'filelist'],
    ['InstanceDefaultDataPath', 'default-paths'],
    ['RESTORE DATABASE', 'restore'],
    ['SET READ_ONLY', 'read-only'],
    ['msdb.dbo.backupset', 'lsn'],
    ['[tsettings]', 'sites'],
    ['[tfiles]', 'file-owners'],
  ];
  return labels.find(([needle]) => text.includes(needle))?.[1] ?? text;
}

const lsnOf = (params: Record<string, unknown>, base: string): string =>
  `${base}${/snap-(\d+)\.bak$/.exec(String(params.path))?.[1] ?? 'x'}`;

/** Answers of a quiet, fileDir-backed server with no sites, whose live data file is `dataFile`. */
function serverResponses(dataFile: string): Record<string, Responder> {
  return {
    'data-file': () => ({ rows: [{ physicalName: dataFile }] }),
    'dir-visible': () => ({ rows: [{ isDirectory: 1 }] }),
    'db-exists': () => ({ rows: [{ id: null }] }),
    filelist: () => ({
      rows: [
        { LogicalName: DATABASE, Type: 'D', FileId: '1' },
        { LogicalName: `${DATABASE}_log`, Type: 'L', FileId: '2' },
      ],
    }),
    'default-paths': () => ({ rows: [{ dataPath: '/var/opt/mssql/data/', logPath: '/var/opt/mssql/data/' }] }),
    lsn: (params) => ({
      rows: [{ checkpointLsn: lsnOf(params, '4500000012300'), lastLsn: lsnOf(params, '4500000013100'), finishedAt: new Date(BASE) }],
    }),
    sites: () => ({ columns: ['SiteID'], rows: [] }),
    'file-owners': () => ({ columns: ['fileID', 'siteID'], rows: [] }),
  };
}

/** Tedious connection answering each statement from `responses` and logging it to `events`. */
class FakeConnection extends EventEmitter {
  readonly statements: { label: string; sql: string; params: Record<string, unknown> }[] = [];
  private readonly events: string[];
  private readonly responses: Record<string, Responder>;

  constructor(events: string[], responses: Record<string, Responder>) {
    super();
    this.events = events;
    this.responses = responses;
  }

  execSql(request: TediousRequestLike): void {
    this.run(request);
  }

  execSqlBatch(request: TediousRequestLike): void {
    this.run(request);
  }

  cancel(): void {}

  private run(request: TediousRequestLike): void {
    const text = request.sqlTextOrProcedure ?? '';
    const params = Object.fromEntries(request.parameters.map((param) => [param.name, param.value]));
    const label = mssqlLabel(text);
    this.events.push(`mssql:${label}`);
    this.statements.push({ label, sql: text, params });
    const outcome = this.responses[label]?.(params) ?? {};
    setImmediate(() => {
      if (outcome instanceof Error) {
        request.callback(outcome);
        return;
      }
      const rows = outcome.rows ?? [];
      const columns = outcome.columns ?? Object.keys(rows[0] ?? {});
      if (columns.length > 0) {
        request.emit('columnMetadata', columns.map((colName) => ({ colName })));
        for (const row of rows) request.emit('row', columns.map((colName) => ({ value: row[colName], metadata: { colName } })));
        request.emit('doneInProc', rows.length, false);
      }
      request.callback();
    });
  }
}

/** Legacy port whose pools, `master` and snapshot databases alike, share one fake connection. */
function fakeLegacy(events: string[], responses: Record<string, Responder>) {
  const connection = new FakeConnection(events, responses);
  const pool = (name: string): ConnectionPool => {
    const fake = {
      connected: true,
      config: { database: name },
      acquire(_request: unknown, callback: (err: Error | null, conn: FakeConnection) => void) {
        setImmediate(callback, null, connection);
      },
      release() {},
      request: (): sql.Request => new sql.Request(fake as unknown as ConnectionPool),
    };
    return fake as unknown as ConnectionPool;
  };
  const legacy = {
    live: vi.fn(() => Promise.reject(new Error('a snapshot never uses the live pool'))),
    database: vi.fn((name: string) => Promise.resolve(pool(name))),
    transaction: vi.fn(() => Promise.reject(new Error('a snapshot runs no legacy transaction'))),
    close: vi.fn(() => Promise.resolve()),
  } satisfies LegacyDb;
  return { legacy, connection };
}

/** A `migration.snapshot` row as the fake stores it. */
interface StoredSnapshot {
  seq: number;
  database_name: string;
  backup_file: string;
  checkpoint_lsn: string | null;
  last_lsn: string | null;
  kind: string;
  transition_id: string | null;
  state: SnapshotState;
  manifest_complete: boolean;
  taken_at: Date;
  source_sha: string;
}

interface LeaseRow {
  unit: string;
  holder_id: string;
  kind: string;
}

function pgLabel(text: string, values: readonly unknown[]): string {
  if (text.includes('pg_advisory_xact_lock')) return 'lock';
  if (text.startsWith('SELECT unit, holder_id, kind FROM migration.unit_lease')) return 'leases';
  if (text.includes('COALESCE(MAX(seq) + 1, 0)')) return 'next-seq';
  if (text.startsWith('INSERT INTO migration.snapshot')) return 'reserve';
  if (text.startsWith('UPDATE migration.snapshot SET checkpoint_lsn')) return 'complete';
  if (text.startsWith('UPDATE migration.snapshot SET state = $2')) return `state:${String(values[1])}`;
  if (text.startsWith('SELECT database_name FROM migration.snapshot')) return 'manifest-db';
  if (text.startsWith('DELETE FROM migration.file_manifest')) return 'manifest-delete';
  if (text.startsWith('UPDATE migration.snapshot SET manifest_complete = true')) return 'manifest-complete';
  if (text.includes('FROM migration.snapshot AS s WHERE s.seq = $1')) return 'read';
  throw new Error(`unexpected statement: ${text}`);
}

/**
 * migration schema with READ COMMITTED visibility: a transaction's writes appear at its commit, and the advisory lock
 * is held until then. Every statement yields first, so unlocked transactions would interleave.
 */
function fakeMigrationDb(events: string[], opts: { leases?: LeaseRow[]; rows?: StoredSnapshot[]; failOn?: Record<string, Error> }) {
  const rows = new Map<number, StoredSnapshot>((opts.rows ?? []).map((row) => [row.seq, row]));
  const statements: { label: string; values: unknown[] }[] = [];
  let lockTail: Promise<void> = Promise.resolve();

  const withMetadata = async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
    let release: (() => void) | undefined;
    const staged = new Map<number, StoredSnapshot>();
    const writes: (() => void)[] = [];
    const rowFor = (seq: number): StoredSnapshot | undefined => staged.get(seq) ?? rows.get(seq);
    const query = async (text: string, values: unknown[] = []) => {
      await new Promise(setImmediate);
      const label = pgLabel(text, values);
      events.push(`pg:${label}`);
      statements.push({ label, values });
      const failure = opts.failOn?.[label];
      if (failure !== undefined) throw failure;
      const seq = values[0] as number;
      switch (label) {
        case 'lock': {
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => (release = resolve));
          await previous;
          return { rows: [{}], rowCount: 1 };
        }
        case 'leases':
          return { rows: opts.leases ?? [], rowCount: opts.leases?.length ?? 0 };
        case 'next-seq': {
          const seqs = [...rows.keys(), ...staged.keys()];
          return { rows: [{ seq: seqs.length === 0 ? 0 : Math.max(...seqs) + 1 }], rowCount: 1 };
        }
        case 'reserve': {
          const [, databaseName, backupFile, kind, transitionId, takenAt, sourceSha] = values;
          if (rowFor(seq) !== undefined) throw new Error('duplicate key value violates unique constraint "snapshot_pkey"');
          const row: StoredSnapshot = {
            seq,
            database_name: databaseName as string,
            backup_file: backupFile as string,
            checkpoint_lsn: null,
            last_lsn: null,
            kind: kind as string,
            transition_id: transitionId as string | null,
            state: 'creating',
            manifest_complete: false,
            taken_at: takenAt as Date,
            source_sha: sourceSha as string,
          };
          staged.set(seq, row);
          writes.push(() => {
            if (rows.has(seq)) throw new Error('duplicate key value violates unique constraint "snapshot_pkey"');
            rows.set(seq, row);
          });
          return { rows: [], rowCount: 1 };
        }
        case 'complete':
          writes.push(() => {
            Object.assign(rows.get(seq) ?? {}, { checkpoint_lsn: values[1], last_lsn: values[2], taken_at: values[3] });
          });
          return { rows: [], rowCount: 1 };
        case 'manifest-complete':
          writes.push(() => Object.assign(rows.get(seq) ?? {}, { manifest_complete: true }));
          return { rows: [], rowCount: 1 };
        case 'manifest-delete':
          return { rows: [], rowCount: 0 };
        case 'manifest-db': {
          const row = rowFor(seq);
          return { rows: row === undefined ? [] : [{ database_name: row.database_name }], rowCount: row === undefined ? 0 : 1 };
        }
        case 'read': {
          const row = rowFor(seq);
          return { rows: row === undefined ? [] : [{ ...row, objects: 0 }], rowCount: row === undefined ? 0 : 1 };
        }
        default:
          writes.push(() => Object.assign(rows.get(seq) ?? {}, { state: values[1] }));
          return { rows: [], rowCount: 1 };
      }
    };
    const tx = { schema: 'migration', kind: 'metadata', onCommit: () => undefined, query } as unknown as MetadataTx;
    try {
      const result = await fn(tx);
      for (const write of writes) write();
      events.push('pg:commit');
      return result;
    } catch (error) {
      events.push('pg:rollback');
      throw error;
    } finally {
      release?.();
    }
  };
  const db: TenantDb = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('snapshots are not tenant data')),
    withMetadata,
    end: () => Promise.resolve(),
  };
  return { db, rows, statements };
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opt2-snapshot-take-')));
  await chmod(root, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface TakeOptions {
  leases?: LeaseRow[];
  rows?: StoredSnapshot[];
  failOn?: Record<string, Error>;
  responses?: Record<string, Responder>;
  sites?: string[];
}

/** Snapshot context over the fakes; its clock reads one second per logged statement, so instants place statements. */
async function takeContext(opts: TakeOptions = {}) {
  const dataFile = path.join(root, `${DATABASE}.mdf`);
  await writeFile(dataFile, '');
  const sourcePin = path.join(root, 'source-pin.json');
  await writeFile(sourcePin, JSON.stringify({ sha: SHA }));
  const events: string[] = [];
  const responses = { ...serverResponses(dataFile), ...opts.responses };
  const sites = opts.sites;
  if (sites !== undefined) responses.sites = () => ({ columns: ['SiteID'], rows: sites.map((SiteID) => ({ SiteID })) });
  const legacy = fakeLegacy(events, responses);
  const migration = fakeMigrationDb(events, opts);
  const info = vi.fn();
  const warn = vi.fn();
  const stateDir = path.join(root, 'state');
  const ctx = {
    env: { MURA_DATABASE: DATABASE, OPT2_STATE_DIR: stateDir } as MigrationEnv,
    config: { paths: { sourcePin } },
    db: migration.db,
    legacy: legacy.legacy,
    bridge: { filesList: vi.fn(() => Promise.reject(new Error('the bridge is unavailable'))) },
    owners: {},
    clock: { now: () => new Date(BASE + events.length * 1000) },
    logger: { info, warn } as unknown as Logger,
  } as unknown as SnapshotContext;
  return { ctx, events, legacy, migration, info, warn, stateDir };
}

const backupOf = (stateDir: string, seq: number): string => path.posix.join(snapshotsDir(stateDir), `snap-${String(seq)}.bak`);

const stored = (seq: number, state: SnapshotState): StoredSnapshot => ({
  seq,
  database_name: `${DATABASE}_opt2_snap_${String(seq)}`,
  backup_file: `/state/snapshots/snap-${String(seq)}.bak`,
  checkpoint_lsn: state === 'creating' ? null : '1',
  last_lsn: state === 'creating' ? null : '2',
  kind: 'seed',
  transition_id: null,
  state,
  manifest_complete: false,
  taken_at: new Date(BASE),
  source_sha: SHA,
});

describe('takeSnapshot', () => {
  it('reserves the sequence under the snapshot lock and commits it before any SQL Server statement', async () => {
    const { ctx, events, migration, stateDir } = await takeContext();

    const record = await takeSnapshot(ctx, { kind: 'seed' });

    expect(events.slice(0, 15)).toEqual([
      'pg:lock',
      'pg:leases',
      'pg:next-seq',
      'pg:reserve',
      'pg:commit',
      'mssql:data-file',
      'mssql:dir-visible',
      'mssql:db-exists',
      'mssql:backup',
      'mssql:filelist',
      'mssql:default-paths',
      'mssql:restore',
      'mssql:read-only',
      'mssql:lsn',
      'pg:complete',
    ]);
    expect(events.slice(-2)).toEqual(['pg:state:ready', 'pg:commit']);
    expect(migration.statements[0]).toEqual({ label: 'lock', values: ['migration.snapshot'] });
    const backupPath = backupOf(stateDir, 0);
    expect(migration.statements[3]).toEqual({
      label: 'reserve',
      values: [0, `${DATABASE}_opt2_snap_0`, backupPath, 'seed', null, new Date(BASE + 3000), SHA],
    });
    const takenAt = new Date(BASE + (events.indexOf('mssql:backup') + 1) * 1000);
    expect(migration.statements.find((statement) => statement.label === 'complete')?.values).toEqual([
      0,
      '45000000123000',
      '45000000131000',
      takenAt,
    ]);
    expect(record).toEqual({
      seq: 0,
      kind: 'seed',
      state: 'ready',
      databaseName: `${DATABASE}_opt2_snap_0`,
      backupPath,
      checkpointLsn: '45000000123000',
      lastLsn: '45000000131000',
      takenAt,
      transitionId: null,
      sourceSha: SHA,
      manifestComplete: true,
      fileStore: { status: 'ok', objects: 0 },
    });
    expect(migration.rows.get(0)).toMatchObject({
      state: 'ready',
      checkpoint_lsn: '45000000123000',
      last_lsn: '45000000131000',
      taken_at: takenAt,
      manifest_complete: true,
    });
  });

  it('gives two concurrent takes distinct sequences, databases and backup files, both ready with their LSNs', async () => {
    const { ctx, legacy, migration, stateDir } = await takeContext();

    const records = await Promise.all([takeSnapshot(ctx, { kind: 'workload' }), takeSnapshot(ctx, { kind: 'workload' })]);

    expect(records.map((record) => record.seq).sort()).toEqual([0, 1]);
    expect(new Set(records.map((record) => record.databaseName))).toEqual(
      new Set([`${DATABASE}_opt2_snap_0`, `${DATABASE}_opt2_snap_1`]),
    );
    expect(new Set(records.map((record) => record.backupPath))).toEqual(new Set([backupOf(stateDir, 0), backupOf(stateDir, 1)]));
    const backups = legacy.connection.statements.filter((statement) => statement.label === 'backup').map((statement) => statement.sql);
    expect(backups.sort()).toEqual(
      [0, 1].map((seq) => `BACKUP DATABASE [${DATABASE}] TO DISK = N'${backupOf(stateDir, seq)}' WITH COPY_ONLY, CHECKSUM, INIT;`),
    );
    for (const seq of [0, 1]) {
      expect(migration.rows.get(seq)).toMatchObject({
        state: 'ready',
        checkpoint_lsn: `4500000012300${String(seq)}`,
        last_lsn: `4500000013100${String(seq)}`,
      });
    }
    expect(migration.statements.filter((statement) => statement.label === 'lock')).toHaveLength(2);
  });

  it('continues after the highest recorded sequence whatever its state', async () => {
    const { ctx, migration } = await takeContext({ rows: [stored(0, 'failed'), stored(1, 'dropped'), stored(2, 'creating')] });

    const record = await takeSnapshot(ctx, { kind: 'feed' });

    expect(record.seq).toBe(3);
    expect(migration.rows.get(2)?.state).toBe('creating');
  });

  it.each([
    ['a write window', { unit: 'people.roster', holder_id: 'window-7', kind: 'window' }, undefined],
    ['another transition', { unit: 'identity.login', holder_id: 'tr-1', kind: 'transition' }, 'tr-2'],
  ])('refuses with SnapshotBlockedError before any SQL Server statement while %s leases units', async (_case, lease, holderId) => {
    const { ctx, events, legacy, migration, stateDir } = await takeContext({ leases: [lease] });

    const error = await takeSnapshot(ctx, { kind: 'transition', holderId }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotBlockedError);
    expect((error as SnapshotBlockedError).leases).toEqual([{ holderId: lease.holder_id, kind: lease.kind, units: [lease.unit] }]);
    expect(events).toEqual(['pg:lock', 'pg:leases', 'pg:rollback']);
    expect(legacy.legacy.database).not.toHaveBeenCalled();
    expect(migration.rows.size).toBe(0);
    await expect(stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("is not blocked by its own transition's leases and records that transition", async () => {
    const { ctx, migration } = await takeContext({ leases: [{ unit: 'identity.login', holder_id: 'tr-1', kind: 'transition' }] });

    const record = await takeSnapshot(ctx, { kind: 'transition', holderId: 'tr-1' });

    expect(record.transitionId).toBe('tr-1');
    expect(migration.rows.get(0)).toMatchObject({ transition_id: 'tr-1', state: 'ready' });
  });

  it('drops a leftover database of the reserved name before the backup', async () => {
    const { ctx, events, legacy, warn } = await takeContext({ responses: { 'db-exists': () => ({ rows: [{ id: 12 }] }) } });

    await takeSnapshot(ctx, { kind: 'seed' });

    const name = `${DATABASE}_opt2_snap_0`;
    expect(events.indexOf('mssql:drop')).toBe(events.indexOf('mssql:db-exists') + 1);
    expect(events.indexOf('mssql:drop')).toBeLessThan(events.indexOf('mssql:backup'));
    expect(legacy.connection.statements.find((statement) => statement.label === 'drop')?.sql).toContain(`DROP DATABASE [${name}]`);
    expect(warn).toHaveBeenCalledWith(`dropping ${name}, left by an unrecorded snapshot 0`);
  });

  const backupFailed = new Error('BACKUP DATABASE is terminating abnormally.');
  const restoreFailed = new Error('RESTORE DATABASE is terminating abnormally.');
  it.each([
    ['the backup', { responses: { backup: () => backupFailed } }, backupFailed.message, 'mssql:backup'],
    ['the restore', { responses: { restore: () => restoreFailed } }, restoreFailed.message, 'mssql:restore'],
    [
      'the LSN read',
      { responses: { lsn: () => ({ columns: ['checkpointLsn', 'lastLsn', 'finishedAt'], rows: [] }) } },
      'msdb records no copy-only backup',
      'mssql:lsn',
    ],
    [
      'the server-side directory check',
      { responses: { 'dir-visible': () => ({ rows: [{ isDirectory: 0 }] }) } },
      'SQL Server cannot see the snapshot directory',
      'mssql:dir-visible',
    ],
    ['recording the LSNs', { failOn: { complete: new Error('connection terminated') } }, 'connection terminated', 'pg:complete'],
  ])('marks the reserved row failed and rethrows when %s fails', async (_case, opts: TakeOptions, message, lastStep) => {
    const { ctx, events, migration, info } = await takeContext(opts);

    await expect(takeSnapshot(ctx, { kind: 'seed' })).rejects.toThrow(message);

    expect(events.slice(events.indexOf(lastStep) + 1).filter((event) => event.startsWith('mssql:'))).toEqual([]);
    expect(events.slice(-2)).toEqual(['pg:state:failed', 'pg:commit']);
    expect(migration.rows.get(0)).toMatchObject({ state: 'failed', checkpoint_lsn: null, last_lsn: null });
    expect((await getSnapshot(ctx, 0))?.fileStore).toBeNull();
    expect(info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('snapshot 0 (seed) taken'));
  });

  it('throws an AggregateError of both causes when marking the row failed fails too', async () => {
    const backupError = new Error('BACKUP DATABASE is terminating abnormally.');
    const markError = new Error('connection terminated');
    const { ctx } = await takeContext({ responses: { backup: () => backupError }, failOn: { 'state:failed': markError } });

    const error = await takeSnapshot(ctx, { kind: 'seed' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('Snapshot 0 failed, and so did marking it failed');
    expect((error as AggregateError).errors.map((cause: Error) => cause.message)).toEqual([
      expect.stringContaining(backupError.message),
      markError.message,
    ]);
  });

  it('marks a snapshot whose manifest failed failed, keeping its LSNs, and reads it back as a manifest error', async () => {
    const { ctx, migration } = await takeContext({ sites: ['default'] });

    await expect(takeSnapshot(ctx, { kind: 'seed' })).rejects.toThrow('the bridge is unavailable');

    expect(migration.rows.get(0)).toMatchObject({ state: 'failed', checkpoint_lsn: '45000000123000' });
    expect((await getSnapshot(ctx, 0))?.fileStore).toEqual({ status: 'error', message: 'building the file manifest failed' });
  });
});

/** Host file system confined to `root`: its ancestors read as root's 0755 directories, and only `root` may change. */
function confinedFs(
  overrides: { stat?: Record<string, Partial<DirStat>>; lstat?: Record<string, Partial<DirStat>>; chown?: Error } = {},
) {
  const changes: string[] = [];
  const inside = (target: string): boolean => target === root || target.startsWith(`${root}${path.sep}`);
  const aboveRoot = (target: string): boolean => target === path.parse(root).root || root.startsWith(`${target}${path.sep}`);
  const rootOwned: DirStat = { uid: 0, gid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false };
  const merged = async (read: (target: string) => Promise<DirStat>, target: string, override: Partial<DirStat> | undefined) => {
    const real = aboveRoot(target) ? rootOwned : await read(target);
    return {
      uid: override?.uid ?? real.uid,
      gid: override?.gid ?? real.gid,
      mode: override?.mode ?? real.mode,
      isDirectory: () => real.isDirectory(),
      isSymbolicLink: () => real.isSymbolicLink(),
    };
  };
  const guard = (target: string): void => {
    if (!inside(target)) throw new Error(`the policy changed ${target}, outside the test directory`);
  };
  const fs: BackupDirFs = {
    mkdir: (dir, options) => (guard(dir), NODE_BACKUP_DIR_FS.mkdir(dir, options)),
    lstat: (target) => merged(NODE_BACKUP_DIR_FS.lstat, target, overrides.lstat?.[target]),
    stat: (target) => merged(NODE_BACKUP_DIR_FS.stat, target, overrides.stat?.[target]),
    realpath: (target) => (aboveRoot(target) ? Promise.resolve(target) : NODE_BACKUP_DIR_FS.realpath(target)),
    chown: async (target, uid, gid) => {
      guard(target);
      changes.push(`chown ${target} ${String(gid)}`);
      if (overrides.chown !== undefined) throw overrides.chown;
      await NODE_BACKUP_DIR_FS.chown(target, uid, gid);
    },
    chmod: async (target, mode) => {
      guard(target);
      changes.push(`chmod ${target} ${mode.toString(8)}`);
      await NODE_BACKUP_DIR_FS.chmod(target, mode);
    },
    rm: (target, options) => (guard(target), NODE_BACKUP_DIR_FS.rm(target, options)),
  };
  return { fs, changes };
}

/** Policy context whose SQL Server writes as (SQL_UID, SQL_GID) through the data file at `dataFile`. */
async function policyContext(responses: Record<string, Responder> = {}) {
  const dataFile = path.join(root, 'live.mdf');
  await writeFile(dataFile, '');
  const events: string[] = [];
  const legacy = fakeLegacy(events, { ...serverResponses(dataFile), ...responses });
  const info = vi.fn<(message: string) => void>();
  const ctx = {
    env: { MURA_DATABASE: DATABASE } as MigrationEnv,
    legacy: legacy.legacy,
    logger: { info } as unknown as Logger,
  };
  const stateDir = path.join(root, 'state');
  const dir = snapshotsDir(stateDir);
  return { ctx, info, legacy, dataFile, stateDir, dir, backupPath: path.join(dir, 'snap-3.bak') };
}

const accountStat = (dataFile: string) => ({ [dataFile]: { uid: SQL_UID, gid: SQL_GID } });
const permissionsOf = async (target: string): Promise<number> => (await stat(target)).mode & 0o7777;

describe('prepareBackupDir', () => {
  it.each([
    ['an existing private state directory', true],
    ['a missing state directory', false],
  ])('makes the backup directory 0770 for its owner and SQL Server group, adding only g+x to %s', async (_case, exists) => {
    const { ctx, info, dataFile, stateDir, dir, backupPath } = await policyContext();
    if (exists) await mkdir(stateDir, { mode: 0o700 });
    const { fs, changes } = confinedFs({ stat: accountStat(dataFile) });

    await prepareBackupDir(ctx, backupPath, fs);

    const leaf = await lstat(dir);
    expect(leaf.isDirectory()).toBe(true);
    expect(leaf.mode & 0o7777).toBe(BACKUP_DIR_MODE);
    expect(leaf.gid).toBe(SQL_GID);
    const state = await stat(stateDir);
    expect(state.mode & 0o7777).toBe(0o710);
    expect(state.gid).toBe(SQL_GID);
    expect(await permissionsOf(root)).toBe(0o755);
    expect(changes).toContain(`chmod ${stateDir} 710`);
    expect(changes.every((change) => change.includes(` ${stateDir} `) || change.includes(` ${dir} `))).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `granted group ${String(SQL_GID)} search permission on ${stateDir} for SQL Server's snapshot backups`,
    );
  });

  it.each([
    ['an ancestor others may search', 0o755, false],
    ['an ancestor whose group is SQL Server group with read only', 0o740, true],
  ])('handles %s', async (_case, mode, granted) => {
    const { ctx, info, dataFile, stateDir, backupPath } = await policyContext();
    await mkdir(stateDir);
    await chown(stateDir, -1, SQL_GID);
    await chmod(stateDir, mode);
    const { fs, changes } = confinedFs({ stat: accountStat(dataFile) });

    await prepareBackupDir(ctx, backupPath, fs);

    expect(await permissionsOf(stateDir)).toBe(granted ? mode | 0o010 : mode);
    expect(changes.some((change) => change.startsWith(`chown ${stateDir} `))).toBe(false);
    expect(info).toHaveBeenCalledTimes(granted ? 1 : 0);
  });

  it('gives a private ancestor of another group to SQL Server group before adding g+x', async () => {
    const { ctx, info, dataFile, stateDir, backupPath } = await policyContext();
    await mkdir(stateDir, { mode: 0o700 });
    const { fs, changes } = confinedFs({ stat: { ...accountStat(dataFile), [stateDir]: { gid: FOREIGN_GID } } });

    await prepareBackupDir(ctx, backupPath, fs);

    expect(changes.filter((change) => change.includes(` ${stateDir} `))).toEqual([
      `chown ${stateDir} ${String(SQL_GID)}`,
      `chmod ${stateDir} 710`,
    ]);
    expect(await stat(stateDir)).toMatchObject({ gid: SQL_GID });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('changes no ancestor when SQL Server runs as the superuser', async () => {
    const { ctx, info, dataFile, stateDir, dir, backupPath } = await policyContext();
    await mkdir(stateDir, { mode: 0o700 });
    const before = await permissionsOf(stateDir);
    const { fs, changes } = confinedFs({ stat: { [dataFile]: { uid: 0, gid: SQL_GID } } });

    await prepareBackupDir(ctx, backupPath, fs);

    expect(await permissionsOf(stateDir)).toBe(before);
    expect(changes).toEqual([`chown ${dir} ${String(SQL_GID)}`, `chmod ${dir} 770`]);
    expect(info).not.toHaveBeenCalled();
  });

  it('opens the real directories behind a symlinked ancestor, leaving the link itself alone', async () => {
    const { ctx, info, dataFile } = await policyContext();
    const real = path.join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, path.join(root, 'link'));
    const backupPath = path.join(root, 'link', 'state', 'snapshots', 'snap-0.bak');
    const { fs } = confinedFs({ stat: accountStat(dataFile) });

    await prepareBackupDir(ctx, backupPath, fs);

    expect((await permissionsOf(real)) & 0o070).toBe(0o010);
    expect((await permissionsOf(path.join(real, 'state'))) & 0o070).toBe(0o010);
    expect((await lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(true);
    expect(info.mock.calls.map(([message]: [string]) => /on (\S+) for/.exec(message)?.[1])).toEqual([path.join(real, 'state'), real]);
  });

  it.each([
    ['owned by another account', { uid: OTHER_UID }],
    ['in another group that has permissions', { gid: FOREIGN_GID, mode: 0o40750 }],
  ])('refuses an ancestor SQL Server cannot search and this process may not open: one %s', async (_case, override) => {
    const { ctx, dataFile, stateDir, backupPath } = await policyContext();
    await mkdir(stateDir, { mode: 0o700 });
    const before = await stat(stateDir);
    const { fs, changes } = confinedFs({ stat: { ...accountStat(dataFile), [stateDir]: override } });

    const error = await prepareBackupDir(ctx, backupPath, fs).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as Error).message).toBe(
      `${ACCOUNT} needs search permission on ${stateDir} to reach the snapshot backups`,
    );
    expect(changes.filter((change) => change.includes(`${stateDir} `))).toEqual([]);
    expect(await stat(stateDir)).toMatchObject({ mode: before.mode, gid: before.gid });
  });

  it.each([
    ['a symlink', 'symlink', 'is not a directory'],
    ['owned by another account', 'foreign', `belongs to uid ${String(OTHER_UID)}, not to this process (uid ${String(OWN_UID)})`],
  ])('refuses a backup directory that is %s and changes nothing', async (_case, kind, message) => {
    const { ctx, dataFile, stateDir, dir, backupPath } = await policyContext();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o755 });
    await mkdir(stateDir, { mode: 0o700 });
    if (kind === 'symlink') await symlink(elsewhere, dir);
    else await mkdir(dir, { mode: 0o700 });
    const { fs, changes } = confinedFs({ stat: accountStat(dataFile), lstat: kind === 'foreign' ? { [dir]: { uid: OTHER_UID } } : {} });

    const error = await prepareBackupDir(ctx, backupPath, fs).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as Error).message).toBe(`Snapshot directory ${dir} ${message}`);
    expect(changes).toEqual([]);
    expect(await permissionsOf(elsewhere)).toBe(0o755);
  });

  it('unlinks a symlink left at the backup path without touching its target', async () => {
    const { ctx, dataFile, dir, backupPath } = await policyContext();
    const victim = path.join(root, 'victim.bak');
    await writeFile(victim, 'keep');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await symlink(victim, backupPath);
    const { fs } = confinedFs({ stat: accountStat(dataFile) });

    await prepareBackupDir(ctx, backupPath, fs);

    await expect(lstat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(victim, 'utf8')).toBe('keep');
  });

  it('asks SQL Server about the backup directory itself, after the directory is ready', async () => {
    const { ctx, legacy, dataFile, dir, backupPath } = await policyContext();
    const { fs } = confinedFs({ stat: accountStat(dataFile) });

    await prepareBackupDir(ctx, backupPath, fs);

    expect(legacy.connection.statements.map((statement) => [statement.label, statement.params])).toEqual([
      ['data-file', { database: DATABASE }],
      ['dir-visible', { path: dir }],
    ]);
  });

  it.each([
    ['answers that it is not a directory', [{ isDirectory: 0 }]],
    ['returns no row', []],
  ])('refuses when SQL Server %s', async (_case, rows) => {
    const { ctx, dataFile, dir, backupPath } = await policyContext({ 'dir-visible': () => ({ columns: ['isDirectory'], rows }) });
    const { fs } = confinedFs({ stat: accountStat(dataFile) });

    await expect(prepareBackupDir(ctx, backupPath, fs)).rejects.toThrow(
      new SnapshotError(`SQL Server cannot see the snapshot directory ${dir} as ${ACCOUNT}`),
    );
  });

  it.each([
    ['lists no data file', { columns: ['physicalName'], rows: [] }, `SQL Server lists no data file of ${DATABASE}`],
    [
      'names a data file this host cannot read',
      { rows: [{ physicalName: '/nonexistent/opt2/live.mdf' }] },
      `Snapshots need SQL Server on this host and a readable data file, but /nonexistent/opt2/live.mdf of ${DATABASE} cannot be read: `,
    ],
  ])('refuses before touching the file system when SQL Server %s', async (_case, outcome, message) => {
    const { ctx, stateDir, backupPath } = await policyContext({ 'data-file': () => outcome });
    const { fs, changes } = confinedFs();

    const error = await prepareBackupDir(ctx, backupPath, fs).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as Error).message.startsWith(message)).toBe(true);
    expect(changes).toEqual([]);
    await expect(stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains a group change this process is not allowed to make', async () => {
    const { ctx, dataFile, dir, backupPath } = await policyContext();
    const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const { fs } = confinedFs({ stat: accountStat(dataFile), chown: denied });

    const error = await prepareBackupDir(ctx, backupPath, fs).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as Error).message).toBe(
      `Cannot give ${dir} to group ${String(SQL_GID)}; this process must run as root or as a member of that group: ${denied.message}`,
    );
    expect((error as Error).cause).toBe(denied);
  });

  it('refuses on a host without POSIX user ids', async () => {
    const { ctx, dataFile, backupPath } = await policyContext();
    const { fs, changes } = confinedFs({ stat: accountStat(dataFile) });
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
    try {
      await expect(prepareBackupDir(ctx, backupPath, fs)).rejects.toThrow(
        new SnapshotError('Snapshot backup directories need a POSIX host'),
      );
    } finally {
      if (getuid === undefined) Reflect.deleteProperty(process, 'getuid');
      else Object.defineProperty(process, 'getuid', getuid);
    }
    expect(changes).toEqual([]);
  });
});

describe('canSearch', () => {
  const account = { uid: 993, gid: 992 };

  it.each([
    ['the superuser, whatever the mode', { uid: 0, gid: 0 }, { uid: 1, gid: 1, mode: 0o40000 }, true],
    ['its owner with u+x', account, { uid: 993, gid: 1, mode: 0o40100 }, true],
    ['its owner without u+x, even with g+x and o+x', account, { uid: 993, gid: 992, mode: 0o40611 }, false],
    ['its group with g+x', account, { uid: 1, gid: 992, mode: 0o40010 }, true],
    ['its group without g+x, even with o+x', account, { uid: 1, gid: 992, mode: 0o40701 }, false],
    ['others with o+x', account, { uid: 1, gid: 1, mode: 0o40001 }, true],
    ['others without o+x, even with g+x', account, { uid: 1, gid: 1, mode: 0o40770 }, false],
  ])('answers for %s', (_case, who, st, expected) => {
    expect(canSearch(who, st)).toBe(expected);
  });
});
