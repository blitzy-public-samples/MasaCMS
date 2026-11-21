// Readies the snapshot backup directory so that only its owner and SQL Server's account can reach and change it.
import type { Stats } from 'node:fs';
import { chmod, chown, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import sql from 'mssql';

import type { MigrationContext } from '../context.js';

import { runMasterStatement, SnapshotError } from './master.js';

/** Mode of the backup directory: owner and SQL Server's group only. */
export const BACKUP_DIR_MODE = 0o770;

// Missing ancestors are created private, as the state directory's other writers create them.
const CREATED_DIR_MODE = 0o700;
const GROUP_SEARCH = 0o010;
const GROUP_BITS = 0o070;

const DATA_FILE_SQL =
  'SELECT TOP (1) physical_name AS physicalName FROM sys.master_files ' +
  'WHERE database_id = DB_ID(@database) AND type = 0 ORDER BY file_id;';
const DIRECTORY_VISIBLE_SQL = 'SELECT file_is_a_directory AS isDirectory FROM sys.dm_os_file_exists(@path);';

/** Status fields the policy reads. */
export type DirStat = Pick<Stats, 'uid' | 'gid' | 'mode' | 'isDirectory' | 'isSymbolicLink'>;

/** File-system calls the policy makes; tests replace them to stand for other accounts' files. */
export interface BackupDirFs {
  mkdir(dir: string, options: { recursive: true; mode: number }): Promise<unknown>;
  lstat(target: string): Promise<DirStat>;
  stat(target: string): Promise<DirStat>;
  realpath(target: string): Promise<string>;
  chown(target: string, uid: number, gid: number): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  rm(target: string, options: { force: true }): Promise<void>;
}

/** The host file system. */
export const NODE_BACKUP_DIR_FS: BackupDirFs = {
  mkdir,
  lstat: (target) => lstat(target),
  stat: (target) => stat(target),
  realpath: (target) => realpath(target),
  chown,
  chmod,
  rm,
};

/** Account SQL Server creates files as. */
export interface SqlServerAccount {
  uid: number;
  gid: number;
}

function accountLabel(account: SqlServerAccount): string {
  return `SQL Server's account (uid ${String(account.uid)}, gid ${String(account.gid)})`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new SnapshotError('Snapshot backup directories need a POSIX host');
  return uid;
}

/** Owner of the live database's primary data file, which is the account SQL Server writes files as. */
async function sqlServerAccount(ctx: Pick<MigrationContext, 'env' | 'legacy'>, fs: BackupDirFs): Promise<SqlServerAccount> {
  const database = ctx.env.MURA_DATABASE;
  const result = await runMasterStatement<{ physicalName: string }>(ctx, DATA_FILE_SQL, [
    { name: 'database', type: sql.NVarChar(128), value: database },
  ]);
  const dataFile = result.recordset[0]?.physicalName;
  if (dataFile === undefined) throw new SnapshotError(`SQL Server lists no data file of ${database}`);
  try {
    const { uid, gid } = await fs.stat(dataFile);
    return { uid, gid };
  } catch (error) {
    const reason = `${dataFile} of ${database} cannot be read: ${messageOf(error)}`;
    throw new SnapshotError(`Snapshots need SQL Server on this host and a readable data file, but ${reason}`, { cause: error });
  }
}

/** Whether `account` may search the directory `st` describes; the superuser always may. */
export function canSearch(account: SqlServerAccount, st: Pick<DirStat, 'uid' | 'gid' | 'mode'>): boolean {
  if (account.uid === 0) return true;
  if (st.uid === account.uid) return (st.mode & 0o100) !== 0;
  if (st.gid === account.gid) return (st.mode & GROUP_SEARCH) !== 0;
  return (st.mode & 0o001) !== 0;
}

/** Every directory a lookup of `dir` passes through before `dir` itself, symlinked components resolved. */
async function ancestorsOf(fs: BackupDirFs, dir: string): Promise<string[]> {
  const found = new Set<string>();
  for (let lexical = path.dirname(dir); ; lexical = path.dirname(lexical)) {
    for (let real = await fs.realpath(lexical); !found.has(real); real = path.dirname(real)) found.add(real);
    if (lexical === path.dirname(lexical)) return [...found];
  }
}

async function setGroup(fs: BackupDirFs, target: string, gid: number): Promise<void> {
  try {
    await fs.chown(target, -1, gid);
  } catch (error) {
    throw new SnapshotError(
      `Cannot give ${target} to group ${String(gid)}; this process must run as root or as a member of that group: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Lets `account` search ancestor `dir` when it cannot: only a directory this process owns whose group is the account's
 * or has no permissions is given to that group with g+x added, so nobody loses access and nothing opens to others.
 */
async function grantSearch(
  ctx: Pick<MigrationContext, 'logger'>,
  fs: BackupDirFs,
  dir: string,
  account: SqlServerAccount,
  uid: number,
): Promise<void> {
  const st = await fs.stat(dir);
  if (canSearch(account, st)) return;
  if (st.uid !== uid || (st.gid !== account.gid && (st.mode & GROUP_BITS) !== 0)) {
    throw new SnapshotError(`${accountLabel(account)} needs search permission on ${dir} to reach the snapshot backups`);
  }
  if (st.gid !== account.gid) await setGroup(fs, dir, account.gid);
  await fs.chmod(dir, (st.mode & 0o7777) | GROUP_SEARCH);
  ctx.logger.info(`granted group ${String(account.gid)} search permission on ${dir} for SQL Server's snapshot backups`);
}

/**
 * Creates the directory of `backupPath` as an owner-and-SQL-Server-group directory, grants SQL Server's group traversal
 * of its ancestors, removes any entry left at `backupPath`, and confirms SQL Server sees the directory.
 * @throws SnapshotError when the directory is a symlink or another account's, or an ancestor cannot be opened to SQL Server.
 */
export async function prepareBackupDir(
  ctx: Pick<MigrationContext, 'env' | 'legacy' | 'logger'>,
  backupPath: string,
  fs: BackupDirFs = NODE_BACKUP_DIR_FS,
): Promise<void> {
  const dir = path.dirname(backupPath);
  const account = await sqlServerAccount(ctx, fs);
  const uid = processUid();

  await fs.mkdir(dir, { recursive: true, mode: CREATED_DIR_MODE });
  const leaf = await fs.lstat(dir);
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) throw new SnapshotError(`Snapshot directory ${dir} is not a directory`);
  if (leaf.uid !== uid) {
    throw new SnapshotError(`Snapshot directory ${dir} belongs to uid ${String(leaf.uid)}, not to this process (uid ${String(uid)})`);
  }
  await setGroup(fs, dir, account.gid);
  await fs.chmod(dir, BACKUP_DIR_MODE);

  for (const ancestor of await ancestorsOf(fs, dir)) await grantSearch(ctx, fs, ancestor, account, uid);

  // Unlinks, never follows, whatever is left at the path, a symlink included.
  await fs.rm(backupPath, { force: true });

  // `file_is_a_directory` is tinyint.
  const visible = await runMasterStatement<{ isDirectory: number | null }>(ctx, DIRECTORY_VISIBLE_SQL, [
    { name: 'path', type: sql.NVarChar(4000), value: dir },
  ]);
  if (visible.recordset[0]?.isDirectory !== 1) {
    throw new SnapshotError(`SQL Server cannot see the snapshot directory ${dir} as ${accountLabel(account)}`);
  }
}
