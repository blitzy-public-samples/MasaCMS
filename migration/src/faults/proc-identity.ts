import { readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

/** `st` of a listening socket in `/proc/net/tcp` and `/proc/net/tcp6`. */
const TCP_LISTEN = '0A';
const MAX_TREE_DEPTH = 8;
const MAX_TREE_SIZE = 256;
/** Codes of a `/proc/<pid>` entry whose process exited while it was read. */
const GONE_CODES: readonly unknown[] = ['ENOENT', 'ESRCH'];

/** `pending`'s value, or undefined when the entry it reads is gone. */
async function unlessGone<T>(pending: Promise<T>): Promise<T | undefined> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof Error && 'code' in error && GONE_CODES.includes(error.code)) return undefined;
    throw error;
  }
}

/** Start time of `pid` in clock ticks after boot (field 22 of `<procRoot>/<pid>/stat`); undefined once it is gone. */
export async function processStartTime(procRoot: string, pid: number): Promise<string | undefined> {
  const file = path.join(procRoot, String(pid), 'stat');
  const text = await unlessGone(readFile(file, 'utf8'));
  if (text === undefined) return undefined;
  // comm, field 2, may itself hold spaces and ')', so fields are counted from the last ')', starting at field 3.
  const close = text.lastIndexOf(')');
  const startTime = close < 0 ? undefined : text.slice(close + 1).trim().split(/\s+/)[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) throw new Error(`${file} records no start time`);
  return startTime;
}

/** Inodes of the sockets listening on TCP `port`; a missing `tcp6` table means a kernel without IPv6. */
async function listeningInodes(procRoot: string, port: number): Promise<Set<string>> {
  const tables = [
    await readFile(path.join(procRoot, 'net', 'tcp'), 'utf8'),
    await unlessGone(readFile(path.join(procRoot, 'net', 'tcp6'), 'utf8')),
  ];
  const inodes = new Set<string>();
  for (const line of tables.flatMap((table) => (table ?? '').split('\n').slice(1))) {
    const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
    if (local === undefined || state !== TCP_LISTEN || inode === undefined || inode === '0') continue;
    if (Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16) === port) inodes.add(inode);
  }
  return inodes;
}

/** Children of every thread of `pid`. */
async function childPids(procRoot: string, pid: number): Promise<number[]> {
  const taskDir = path.join(procRoot, String(pid), 'task');
  const children: number[] = [];
  for (const tid of (await unlessGone(readdir(taskDir))) ?? []) {
    const text = (await unlessGone(readFile(path.join(taskDir, tid, 'children'), 'utf8'))) ?? '';
    for (const token of text.split(/\s+/)) if (/^\d+$/.test(token)) children.push(Number(token));
  }
  return children;
}

/** Whether a descriptor of `pid` is one of the sockets in `inodes`. */
async function holdsSocket(procRoot: string, pid: number, inodes: ReadonlySet<string>): Promise<boolean> {
  const fdDir = path.join(procRoot, String(pid), 'fd');
  for (const fd of (await unlessGone(readdir(fdDir))) ?? []) {
    const target = await unlessGone(readlink(path.join(fdDir, fd)));
    const inode = target === undefined ? undefined : /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode !== undefined && inodes.has(inode)) return true;
  }
  return false;
}

/** First member of `pid`'s bounded process tree holding a socket listening on TCP `port`; throws when unreadable. */
export async function listeningOwner(procRoot: string, pid: number, port: number): Promise<number | undefined> {
  const inodes = await listeningInodes(procRoot, port);
  if (inodes.size === 0) return undefined;
  const seen = new Set([pid]);
  let level = [pid];
  for (let depth = 0; depth <= MAX_TREE_DEPTH && level.length > 0; depth += 1) {
    const next: number[] = [];
    for (const member of level) {
      if (await holdsSocket(procRoot, member, inodes)) return member;
      for (const child of await childPids(procRoot, member)) {
        if (seen.size >= MAX_TREE_SIZE || seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    level = next;
  }
  return undefined;
}
