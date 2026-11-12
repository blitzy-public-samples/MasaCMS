import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { LOCAL_SECRET_FILES, localSecretPath } from '@opt2/platform/auth';

import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { assertOutsideRepo, secretsDir, stateDir, type EnvLike } from '../lib/paths.js';

/** PostgreSQL schemas whose app and migrator role passwords are generated. */
export const DB_SCHEMAS = [
  'identity',
  'people',
  'programs_sites',
  'content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'esignature',
  'stub',
  'gateway',
  'migration',
] as const;

const TOKEN_PAIR = [LOCAL_SECRET_FILES.tokenSigningPrivateKey, LOCAL_SECRET_FILES.tokenSigningPublicKey] as const;

// Mirrors `secretPathsFor` in migration/src/db-bootstrap/index.ts, its reader; the harness does not depend on migration.
const DB_ROLE_FILES = DB_SCHEMAS.flatMap((schema) => [`db-${schema}-app`, `db-${schema}-migrator`]);

// `storage-hmac-key` is read by the platform's local storage adapter, `bridge-hmac-key` by legacy-start.sh.
const RANDOM_FILES: readonly string[] = [
  LOCAL_SECRET_FILES.pubsubPushKey,
  'storage-hmac-key',
  'bridge-hmac-key',
  ...DB_ROLE_FILES,
];

/** Every file name under `${OPT2_STATE_DIR}/secrets/`, sorted. */
export const SECRET_FILES: readonly string[] = Object.freeze([...TOKEN_PAIR, ...RANDOM_FILES].sort());

const USAGE = 'usage: tsx src/repro/secrets.ts [--dir <secrets-dir>]';
const HELP = `${USAGE}

Writes every missing or incomplete local secret and leaves complete ones and a matching key pair unchanged:
the token-signing RSA pair (${TOKEN_PAIR.join(', ')}), ${LOCAL_SECRET_FILES.pubsubPushKey}, storage-hmac-key,
bridge-hmac-key and the db-<schema>-app and db-<schema>-migrator passwords of ${String(DB_SCHEMAS.length)} schemas.

Options:
  --dir <secrets-dir>  directory to write (default: \${OPT2_STATE_DIR}/secrets)
  --help               print this help and exit 0

Environment: OPT2_STATE_DIR, the state directory (default: $HOME/.opt2/state).
The directory must resolve outside the checkout; it is set to mode 0700 and each new file to 0600.

Output: one JSON summary line on stdout naming the directory and the files created and kept, never their values.
Exit: 0 ok, 1 failure, 2 usage error.

Example (from harness/): npm run repro:secrets`;

const LOCK_DIR = '.secrets.lock';
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 50;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
// `.<final name>.<writer pid>.<16 hex>.tmp`: every staged file or lock directory, and a displaced lock entry.
const TEMP_NAME = /^\.(.+)\.(\d+)\.[0-9a-f]{16}\.tmp$/;
const STAGED_NAMES: ReadonlySet<string> = new Set([...SECRET_FILES, LOCK_DIR]);
const NOT_EMPTY: ReadonlySet<string | undefined> = new Set(['ENOTEMPTY', 'EEXIST']);
// An earlier interrupted write leaves a shorter hex prefix of a 32-byte value.
const INCOMPLETE_RANDOM = /^[0-9a-f]{0,63}$/;

/** Outcome of {@link ensureLocalSecrets}: the secrets directory and the sorted file names written and left in place. */
export interface SecretsResult {
  dir: string;
  created: string[];
  kept: string[];
}

/**
 * Writes every missing or incomplete local secret into `dir` (default `<state>/secrets`) under a per-directory lock.
 * A matching key pair and every other non-empty value that is not a hex prefix shorter than 64 digits stay unchanged.
 */
export function ensureLocalSecrets(opts: { env?: EnvLike; dir?: string } = {}): SecretsResult {
  const dir = assertOutsideRepo(opts.dir ?? secretsDir(opts.env), 'secrets directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A symlinked path must not lead the keys into the checkout either.
  assertOutsideRepo(realpathSync(dir), 'secrets directory');
  chmodSync(dir, 0o700);
  return withDirLock(dir, () => publishSecrets(dir));
}

function publishSecrets(dir: string): SecretsResult {
  removeStaleTemps(dir);
  const created: string[] = [];
  const kept: string[] = [];

  const privateFile = path.join(dir, TOKEN_PAIR[0]);
  const publicFile = path.join(dir, TOKEN_PAIR[1]);
  const privatePem = readExisting(privateFile);
  const publicPem = readExisting(publicFile);
  if (privatePem !== undefined && publicPem !== undefined && derivedPublicPem(privatePem) === publicPem) {
    kept.push(...TOKEN_PAIR);
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // Private first: an interruption leaves a mismatched pair, which the next run replaces.
    publish(privateFile, privateKey, privatePem !== undefined);
    publish(publicFile, publicKey, publicPem !== undefined);
    created.push(...TOKEN_PAIR);
  }

  for (const name of RANDOM_FILES) {
    const file = path.join(dir, name);
    const value = readExisting(file);
    if (value !== undefined && !INCOMPLETE_RANDOM.test(value.trim())) {
      kept.push(name);
      continue;
    }
    publish(file, randomBytes(32).toString('hex'), value !== undefined);
    created.push(name);
  }

  if (created.length > 0) fsyncDir(dir);
  return { dir, created: created.sort(), kept: kept.sort() };
}

/** Trimmed contents of the local secret `name`; throws naming the file, never its value, when it is missing or empty. */
export function readSecret(name: string, opts: { env?: EnvLike } = {}): string {
  const file = localSecretPath(stateDir(opts.env), name);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`secret file ${file} does not exist; run \`npm run repro:secrets\` in harness/`, { cause: err });
    }
    throw err;
  }
  const value = text.trim();
  if (value === '') throw new Error(`secret file ${file} is empty`);
  return value;
}

/** CLI entry: ensures every local secret and summarises the file names created and kept, never their values. */
export function main(argv: string[], env: EnvLike = process.env): CliOutcome {
  const { values } = parseFlags(argv, { options: { dir: { type: 'string' } }, usage: USAGE, help: HELP });
  const { dir, created, kept } = ensureLocalSecrets({ env, dir: values.dir });
  return { summary: { dir, created, kept } };
}

/**
 * Runs `fn` while holding the directory `<dir>/.secrets.lock`, whose one entry `<pid>.<16 hex>` names the holder.
 * A holder that is no longer running is displaced; a live holder is awaited for up to {@link LOCK_WAIT_MS}.
 */
function withDirLock<T>(dir: string, fn: () => T): T {
  const lock = path.join(dir, LOCK_DIR);
  const entry = `${String(process.pid)}.${randomBytes(8).toString('hex')}`;
  // Renaming a directory that already holds the entry publishes the lock and its holder in one step.
  const staged = tempPathFor(lock);
  mkdirSync(staged, { mode: 0o700 });
  try {
    writeFileSync(path.join(staged, entry), '', { mode: 0o600, flag: 'wx' });
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (!tryRename(staged, lock)) {
      const holder = lockHolder(lock);
      if (typeof holder === 'object') {
        displaceEntry(lock, holder.stale);
      } else if (holder !== 'gone') {
        if (performance.now() >= deadline) {
          throw new Error(`secrets lock ${lock} is still held by pid ${String(holder)} after ${String(LOCK_WAIT_MS)} ms`);
        }
        Atomics.wait(SLEEP_CELL, 0, 0, LOCK_POLL_MS);
      }
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  try {
    return fn();
  } finally {
    rmSync(path.join(lock, entry), { force: true });
    // Only an empty lock is removed; one another process has published since stays.
    try {
      rmdirSync(lock);
    } catch (err) {
      const { code } = err as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && !NOT_EMPTY.has(code)) throw err;
    }
  }
}

/** Moves the stale holder `entry` out of the lock, freeing it; a lock taken since holds another entry and stays. */
function displaceEntry(lock: string, entry: string): void {
  const aside = tempPathFor(lock);
  try {
    renameSync(path.join(lock, entry), aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  rmSync(aside, { recursive: true, force: true });
}

/** Whether `from` was renamed to `to`; false when `to` is a directory that is not empty. */
function tryRename(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (NOT_EMPTY.has((err as NodeJS.ErrnoException).code)) return false;
    throw err;
  }
}

/** Live pid holding the lock; the entry of a holder that is not running; `'gone'` when the lock is missing or empty. */
function lockHolder(lock: string): number | { stale: string } | 'gone' {
  let entries: string[];
  try {
    entries = readdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw err;
  }
  const [entry] = entries;
  if (entry === undefined) return 'gone';
  const pid = parsePid(entry.split('.', 1)[0] ?? '');
  return pid !== undefined && isAlive(pid) ? pid : { stale: entry };
}

function parsePid(text: string): number | undefined {
  const pid = Number(text);
  return /^[1-9]\d*$/.test(text) && pid <= 0x7fffffff ? pid : undefined;
}

/** Whether `pid` exists; a process this user may not signal (EPERM) counts as alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Deletes staging files and lock directories of this module's names whose writer process has exited. */
function removeStaleTemps(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const match = TEMP_NAME.exec(entry);
    if (match === null || !STAGED_NAMES.has(match[1] ?? '')) continue;
    const writer = parsePid(match[2] ?? '');
    if (writer === undefined || !isAlive(writer)) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function tempPathFor(file: string): string {
  const suffix = `${String(process.pid)}.${randomBytes(8).toString('hex')}`;
  return path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
}

/** Publishes `value` as `file` from a flushed 0600 staging file: a hard link for a new file, a rename to replace one. */
function publish(file: string, value: string, replace: boolean): void {
  const temp = tempPathFor(file);
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(temp, file);
    else linkSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Contents of `file`, or `undefined` when it does not exist. */
function readExisting(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** SPKI PEM of the public half of `privatePem`, or `undefined` when it does not parse as a private key. */
function derivedPublicPem(privatePem: string): string | undefined {
  try {
    return createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return undefined;
  }
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
