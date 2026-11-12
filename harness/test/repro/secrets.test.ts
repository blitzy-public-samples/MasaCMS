import { execFile, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SECRET_FILES, loadLocalSigningKeys, localSecretPath } from '@opt2/platform/auth';

import { runCli } from '../../src/lib/cli.js';
import { HARNESS_ROOT, REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { DB_SCHEMAS, SECRET_FILES, ensureLocalSecrets, main, readSecret } from '../../src/repro/secrets.js';

/** The next call of `op` whose last argument ends with `target` (any call when unset) throws EIO. */
const fault = vi.hoisted(() => ({ op: undefined as string | undefined, target: undefined as string | undefined }));
/** Runs once, just before the next renameSync whose source ends with `source`. */
const beforeRename = vi.hoisted(() => ({ source: undefined as string | undefined, run: (): void => undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const inject = (op: string, arg: unknown): void => {
    if (fault.op !== op || (fault.target !== undefined && !String(arg).endsWith(fault.target))) return;
    fault.op = undefined;
    throw Object.assign(new Error(`injected ${op} failure`), { code: 'EIO' });
  };
  return {
    ...fs,
    fsyncSync: (fd: number): void => {
      inject('fsyncSync', fd);
      fs.fsyncSync(fd);
    },
    linkSync: (existing: PathLike, link: PathLike): void => {
      inject('linkSync', link);
      fs.linkSync(existing, link);
    },
    renameSync: (from: PathLike, to: PathLike): void => {
      inject('renameSync', to);
      if (beforeRename.source !== undefined && String(from).endsWith(beforeRename.source)) {
        beforeRename.source = undefined;
        beforeRename.run();
      }
      fs.renameSync(from, to);
    },
  };
});

const COMMAND = 'repro:secrets';
const PRIVATE_PEM = LOCAL_SECRET_FILES.tokenSigningPrivateKey;
const PUBLIC_PEM = LOCAL_SECRET_FILES.tokenSigningPublicKey;
const PEM_PAIR = [PRIVATE_PEM, PUBLIC_PEM] as const;
const RANDOM_NAMES = SECRET_FILES.filter((name) => !(PEM_PAIR as readonly string[]).includes(name));
const RANDOM_HEX = /^[0-9a-f]{64}$/;
const LOCK_NAME = '.secrets.lock';
const HEX16 = '0123456789abcdef';
const TSX = path.join(HARNESS_ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = 'harness/src/repro/secrets.ts';
const execFileAsync = promisify(execFile);

let root: string;
let state: string;
let env: EnvLike;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-secrets-'));
  state = path.join(root, 'state');
  env = { OPT2_STATE_DIR: state };
});

afterEach(async () => {
  fault.op = undefined;
  fault.target = undefined;
  beforeRename.source = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Asserts `dir` holds exactly the catalogue, owner-only, with a matching key pair and 64-hex random values. */
function expectCompleteSecrets(dir: string): void {
  expect(readdirSync(dir).sort()).toEqual([...SECRET_FILES]);
  expect(modeOf(dir)).toBe(0o700);
  const secrets = secretsOf(dir);
  const privateKey = createPrivateKey(secrets.get(PRIVATE_PEM) ?? '');
  expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })).toBe(secrets.get(PUBLIC_PEM));
  for (const name of SECRET_FILES) {
    expect(modeOf(path.join(dir, name)), name).toBe(0o600);
  }
  for (const name of RANDOM_NAMES) {
    expect(secrets.get(name), name).toMatch(RANDOM_HEX);
  }
}

/** Pid of a child process that has already exited and been reaped. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  return pid;
}

/** Creates `dir` with a lock directory holding the holder `entry`, or none; returns the lock's path. */
function seedLock(dir: string, entry?: string): string {
  const lock = path.join(dir, LOCK_NAME);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  if (entry !== undefined) writeFileSync(path.join(lock, entry), '');
  return lock;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function secretsOf(dir: string, names: readonly string[] = SECRET_FILES): Map<string, string> {
  return new Map(names.map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]));
}

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

/** Every 16-character window of a secret outside its PEM armour; finding one in output means the value leaked. */
function windows(value: string): string[] {
  return value
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .flatMap((line) => Array.from({ length: Math.max(line.length - 15, 0) }, (_, i) => line.slice(i, i + 16)));
}

async function runSecretsCli(argv: string[]): Promise<{ code: number; stdout: string; exit: ReturnType<typeof vi.fn> }> {
  const chunks: string[] = [];
  const exit = vi.fn();
  const code = await runCli((args) => main(args, env), {
    argv,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit,
    command: COMMAND,
  });
  return { code, stdout: chunks.join(''), exit };
}

describe('secret file catalogue', () => {
  it('lists the thirteen schemas that receive database role passwords', () => {
    expect(DB_SCHEMAS).toEqual([
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
    ]);
  });

  it('names the key pair, the three keys and an app and migrator password per schema, sorted and frozen', () => {
    const expected = [
      ...PEM_PAIR,
      LOCAL_SECRET_FILES.pubsubPushKey,
      'storage-hmac-key',
      'bridge-hmac-key',
      ...DB_SCHEMAS.flatMap((schema) => [`db-${schema}-app`, `db-${schema}-migrator`]),
    ].sort();
    expect(SECRET_FILES).toEqual(expected);
    expect(SECRET_FILES).toHaveLength(31);
    expect(new Set(SECRET_FILES).size).toBe(SECRET_FILES.length);
    expect(Object.isFrozen(SECRET_FILES)).toBe(true);
  });

  it('includes every file name the platform reads from the secrets directory', () => {
    expect(SECRET_FILES).toEqual(expect.arrayContaining(Object.values(LOCAL_SECRET_FILES)));
  });
});

describe('ensureLocalSecrets', () => {
  it('creates every secret under <state>/secrets with an owner-only directory and files', () => {
    const result = ensureLocalSecrets({ env });

    expect(result).toEqual({ dir: path.join(state, 'secrets'), created: [...SECRET_FILES], kept: [] });
    expect(modeOf(result.dir)).toBe(0o700);
    for (const name of SECRET_FILES) {
      expect(modeOf(path.join(result.dir, name)), name).toBe(0o600);
    }
  });

  it('writes each file where the platform resolves it', async () => {
    ensureLocalSecrets({ env });

    for (const name of SECRET_FILES) {
      expect(existsSync(localSecretPath(state, name)), name).toBe(true);
    }
    const keys = await loadLocalSigningKeys(state, { requirePrivate: true });
    expect(keys.privateKey).toBeDefined();
    expect(keys.kid).not.toBe('');
  });

  it('writes a 2048-bit RSA key pair as PKCS#8 and SPKI PEM whose private key signs what the public key verifies', () => {
    const { dir } = ensureLocalSecrets({ env });
    const privatePem = readFileSync(path.join(dir, PRIVATE_PEM), 'utf8');
    const publicPem = readFileSync(path.join(dir, PUBLIC_PEM), 'utf8');

    const privateKey = createPrivateKey(privatePem);
    expect(privateKey.export({ type: 'pkcs8', format: 'pem' })).toBe(privatePem);
    expect(privateKey.asymmetricKeyType).toBe('rsa');
    expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })).toBe(publicPem);

    const data = Buffer.from('cut-over probe');
    const signature = sign('sha256', data, privatePem);
    expect(verify('sha256', data, publicPem, signature)).toBe(true);
    expect(verify('sha256', Buffer.from('other probe'), publicPem, signature)).toBe(false);
  });

  it('writes 32 random bytes as hex into every other file, each value distinct', () => {
    const secrets = secretsOf(ensureLocalSecrets({ env }).dir);
    const randomNames = SECRET_FILES.filter((name) => !(PEM_PAIR as readonly string[]).includes(name));

    for (const name of randomNames) {
      expect(secrets.get(name), name).toMatch(RANDOM_HEX);
    }
    expect(new Set(secrets.values()).size).toBe(SECRET_FILES.length);
  });

  it('gives a second state directory different values', () => {
    const first = secretsOf(ensureLocalSecrets({ env }).dir);
    const second = secretsOf(ensureLocalSecrets({ dir: path.join(root, 'other') }).dir);

    for (const name of SECRET_FILES) {
      expect(second.get(name), name).not.toBe(first.get(name));
    }
  });

  it('keeps every existing file byte for byte and owner-only on a second run', () => {
    const { dir } = ensureLocalSecrets({ env });
    const before = secretsOf(dir);

    expect(ensureLocalSecrets({ env })).toEqual({ dir, created: [], kept: [...SECRET_FILES] });
    expect(secretsOf(dir)).toEqual(before);
    expect(modeOf(dir)).toBe(0o700);
    for (const name of SECRET_FILES) {
      expect(modeOf(path.join(dir, name)), name).toBe(0o600);
    }
  });

  it.each([
    { removed: 'bridge-hmac-key', recreated: ['bridge-hmac-key'] },
    { removed: 'db-people-migrator', recreated: ['db-people-migrator'] },
    { removed: PUBLIC_PEM, recreated: [...PEM_PAIR].sort() },
    { removed: PRIVATE_PEM, recreated: [...PEM_PAIR].sort() },
  ])('recreates only $recreated after $removed is deleted', ({ removed, recreated }) => {
    const { dir } = ensureLocalSecrets({ env });
    const before = secretsOf(dir);
    rmSync(path.join(dir, removed));

    const result = ensureLocalSecrets({ env });

    expect(result.created).toEqual(recreated);
    expect(result.kept).toEqual(SECRET_FILES.filter((name) => !recreated.includes(name)));
    const after = secretsOf(dir);
    for (const name of SECRET_FILES) {
      if (recreated.includes(name)) {
        expect(after.get(name), name).not.toBe(before.get(name));
        expect(modeOf(path.join(dir, name)), name).toBe(0o600);
      } else {
        expect(after.get(name), name).toBe(before.get(name));
      }
    }
  });

  it.each([
    { label: 'nothing', name: 'bridge-hmac-key', content: '' },
    { label: 'only whitespace', name: LOCAL_SECRET_FILES.pubsubPushKey, content: ' \n' },
    { label: 'a truncated hex value', name: 'db-people-app', content: '0f1e2d3c4b5a' },
    { label: '63 hex digits', name: 'storage-hmac-key', content: `${'a'.repeat(63)}\n` },
  ])('replaces $name holding $label and keeps every other file', ({ name, content }) => {
    const { dir } = ensureLocalSecrets({ env });
    writeFileSync(path.join(dir, name), content);
    const before = secretsOf(dir);

    expect(ensureLocalSecrets({ env })).toEqual({ dir, created: [name], kept: SECRET_FILES.filter((n) => n !== name) });
    const after = secretsOf(dir);
    expect(after.get(name)).toMatch(RANDOM_HEX);
    expect(modeOf(path.join(dir, name))).toBe(0o600);
    for (const other of SECRET_FILES.filter((n) => n !== name)) {
      expect(after.get(other), other).toBe(before.get(other));
    }
  });

  it.each([
    { label: 'an operator-chosen password', content: 'Operator chosen password 1!\n' },
    { label: '64 hex digits and a newline', content: `${'b'.repeat(64)}\n` },
    { label: 'uppercase hex', content: 'ABCDEF' },
  ])('keeps a random secret holding $label byte for byte', ({ content }) => {
    const { dir } = ensureLocalSecrets({ env });
    writeFileSync(path.join(dir, 'db-gateway-app'), content);

    expect(ensureLocalSecrets({ env })).toEqual({ dir, created: [], kept: [...SECRET_FILES] });
    expect(readFileSync(path.join(dir, 'db-gateway-app'), 'utf8')).toBe(content);
  });

  it.each([
    {
      label: 'the public key of another pair',
      file: PUBLIC_PEM,
      content: () =>
        generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }).publicKey,
    },
    {
      label: 'a truncated private key',
      file: PRIVATE_PEM,
      content: (pem: string) => pem.slice(0, Math.floor(pem.length / 2)),
    },
    { label: 'nothing', file: PUBLIC_PEM, content: () => '' },
    { label: 'text that is not a key', file: PRIVATE_PEM, content: () => 'not a key\n' },
  ])('regenerates both halves when $file holds $label', ({ file, content }) => {
    const { dir } = ensureLocalSecrets({ env });
    const before = secretsOf(dir);
    writeFileSync(path.join(dir, file), content(before.get(file) ?? ''));

    expect(ensureLocalSecrets({ env })).toEqual({ dir, created: [...PEM_PAIR].sort(), kept: RANDOM_NAMES });
    expectCompleteSecrets(dir);
    const after = secretsOf(dir);
    for (const half of PEM_PAIR) {
      expect(after.get(half), half).not.toBe(before.get(half));
    }
    for (const name of RANDOM_NAMES) {
      expect(after.get(name), name).toBe(before.get(name));
    }
  });

  it.each([
    { label: 'an exited process', entry: (): string | undefined => `${String(exitedPid())}.${HEX16}` },
    { label: 'no holder', entry: (): string | undefined => undefined },
    { label: 'no pid', entry: (): string | undefined => 'holder' },
    { label: 'a pid beyond the kernel range', entry: (): string | undefined => `99999999999.${HEX16}` },
  ])('takes over a lock naming $label and releases it afterwards', ({ entry }) => {
    const dir = path.join(root, 'stale');
    seedLock(dir, entry());

    expect(ensureLocalSecrets({ dir })).toEqual({ dir, created: [...SECRET_FILES], kept: [] });
    expectCompleteSecrets(dir);
  });

  it('fails naming the lock when a live process holds it past the wait, writing nothing', () => {
    const dir = path.join(root, 'held');
    const holder = `${String(process.ppid)}.${HEX16}`;
    const lock = seedLock(dir, holder);
    // Deadline taken at 0, one poll still inside it, the next past it.
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(Number.POSITIVE_INFINITY);

    expect(() => ensureLocalSecrets({ dir })).toThrow(
      `secrets lock ${lock} is still held by pid ${String(process.ppid)} after 30000 ms`,
    );
    expect(readdirSync(dir)).toEqual([LOCK_NAME]);
    expect(readdirSync(lock)).toEqual([holder]);
  });

  it('keeps waiting, touching nothing, when a live holder took the lock after it judged the last stale', () => {
    const dir = path.join(root, 'swapped');
    const stale = `${String(exitedPid())}.${HEX16}`;
    const lock = seedLock(dir, stale);
    const live = `${String(process.ppid)}.${HEX16}`;
    let taken = 0;
    // Another waiter displaces the stale holder and publishes its own lock between this one's judgement and its move.
    Object.assign(beforeRename, {
      source: stale,
      run: (): void => {
        rmSync(path.join(lock, stale));
        const other = path.join(root, 'other-waiter');
        mkdirSync(other);
        writeFileSync(path.join(other, live), '');
        taken = statSync(other).ino;
        renameSync(other, lock);
      },
    });
    const sleep = vi.spyOn(Atomics, 'wait');
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(Number.POSITIVE_INFINITY);

    expect(() => ensureLocalSecrets({ dir })).toThrow(
      `secrets lock ${lock} is still held by pid ${String(process.ppid)} after 30000 ms`,
    );
    expect(beforeRename.source).toBeUndefined();
    expect(sleep).toHaveBeenCalledOnce();
    expect(readdirSync(dir)).toEqual([LOCK_NAME]);
    expect(statSync(lock).ino).toBe(taken);
    expect(readdirSync(lock)).toEqual([live]);
  });

  it('takes the lock when another waiter has already displaced the stale holder it judged', () => {
    const dir = path.join(root, 'displaced');
    const stale = `${String(exitedPid())}.${HEX16}`;
    const lock = seedLock(dir, stale);
    Object.assign(beforeRename, { source: stale, run: (): void => rmSync(path.join(lock, stale)) });

    expect(ensureLocalSecrets({ dir })).toEqual({ dir, created: [...SECRET_FILES], kept: [] });
    expect(beforeRename.source).toBeUndefined();
    expectCompleteSecrets(dir);
  });

  it('removes what an exited writer staged or displaced and keeps every other file', () => {
    const dir = path.join(root, 'sweep');
    mkdirSync(dir, { mode: 0o700 });
    const dead = String(exitedPid());
    const stale = [
      `.bridge-hmac-key.${dead}.${HEX16}.tmp`,
      `.${LOCK_NAME}.${dead}.${HEX16}.tmp`,
      `.db-stub-app.0.${HEX16}.tmp`,
    ];
    const others = [`.db-people-app.${String(process.ppid)}.${HEX16}.tmp`, `.notes.${dead}.${HEX16}.tmp`, 'notes.txt'];
    for (const name of [...stale, ...others]) writeFileSync(path.join(dir, name), 'partial');
    const stagedLock = path.join(dir, `.${LOCK_NAME}.${dead}.${'f'.repeat(16)}.tmp`);
    mkdirSync(stagedLock);
    writeFileSync(path.join(stagedLock, `${dead}.${HEX16}`), '');

    ensureLocalSecrets({ dir });

    expect(readdirSync(dir).sort()).toEqual([...SECRET_FILES, ...others].sort());
  });

  it.each([
    {
      label: 'moving the staged lock into place fails',
      fail: { op: 'renameSync', target: LOCK_NAME },
      prepare: (): void => undefined,
      present: [] as string[],
    },
    {
      label: 'flushing the staged private key fails',
      fail: { op: 'fsyncSync', target: undefined },
      prepare: (): void => undefined,
      present: [] as string[],
    },
    {
      label: 'linking a new bridge-hmac-key fails',
      fail: { op: 'linkSync', target: 'bridge-hmac-key' },
      prepare: (): void => undefined,
      present: [...PEM_PAIR, LOCAL_SECRET_FILES.pubsubPushKey, 'storage-hmac-key'],
    },
    {
      label: 'renaming over an empty bridge-hmac-key fails',
      fail: { op: 'renameSync', target: 'bridge-hmac-key' },
      prepare: (dir: string): void => {
        ensureLocalSecrets({ dir });
        writeFileSync(path.join(dir, 'bridge-hmac-key'), '');
      },
      present: [...SECRET_FILES],
    },
    {
      label: 'a secret path is a directory',
      fail: { op: undefined, target: undefined },
      prepare: (dir: string): void => {
        mkdirSync(path.join(dir, 'bridge-hmac-key'), { recursive: true });
      },
      present: [...PEM_PAIR, LOCAL_SECRET_FILES.pubsubPushKey, 'storage-hmac-key', 'bridge-hmac-key'],
    },
  ])('leaves no lock, staging file or partial secret when $label, and the next run completes', (testCase) => {
    const { fail, prepare, present } = testCase;
    const dir = path.join(root, 'faults');
    prepare(dir);
    Object.assign(fault, fail);

    expect(() => ensureLocalSecrets({ dir })).toThrow(fail.op === undefined ? /EISDIR/ : `injected ${fail.op} failure`);
    expect(readdirSync(dir).sort()).toEqual([...present].sort());
    const left = secretsOf(dir, present.filter((name) => statSync(path.join(dir, name)).isFile()));
    if (left.has(PRIVATE_PEM)) {
      const derived = createPublicKey(left.get(PRIVATE_PEM) ?? '').export({ type: 'spki', format: 'pem' });
      expect(derived).toBe(left.get(PUBLIC_PEM));
    }
    for (const name of RANDOM_NAMES.filter((n) => left.has(n))) {
      expect(left.get(name), name).toMatch(/^(?:[0-9a-f]{64})?$/);
    }

    // Only the directory needs repair by hand; the rerun recovers every other failure itself.
    const bridge = path.join(dir, 'bridge-hmac-key');
    if (statSync(bridge, { throwIfNoEntry: false })?.isDirectory() === true) rmSync(bridge, { recursive: true });
    ensureLocalSecrets({ dir });
    expectCompleteSecrets(dir);
  });

  it('tightens an existing secrets directory to owner-only', () => {
    const dir = path.join(state, 'secrets');
    mkdirSync(dir, { recursive: true, mode: 0o755 });

    ensureLocalSecrets({ env });

    expect(modeOf(dir)).toBe(0o700);
  });

  it('defaults to <HOME>/.opt2/state/secrets when OPT2_STATE_DIR is unset', () => {
    expect(ensureLocalSecrets({ env: { HOME: root } }).dir).toBe(path.join(root, '.opt2', 'state', 'secrets'));
  });

  it('writes into an explicit directory instead of the state directory', () => {
    const dir = path.join(root, 'explicit', 'secrets');

    expect(ensureLocalSecrets({ env, dir })).toMatchObject({ dir, created: [...SECRET_FILES] });
    expect(existsSync(path.join(state, 'secrets'))).toBe(false);
  });

  it.each([
    { label: 'an explicit directory', opts: () => ({ dir: path.join(REPO_ROOT, 'opt2-secrets-probe') }) },
    { label: 'OPT2_STATE_DIR', opts: () => ({ env: { OPT2_STATE_DIR: path.join(REPO_ROOT, 'opt2-state-probe') } }) },
  ])('refuses $label inside the checkout before writing anything', ({ opts }) => {
    expect(() => ensureLocalSecrets(opts())).toThrow(/must be outside the repository checkout/);
    expect(existsSync(path.join(REPO_ROOT, 'opt2-secrets-probe'))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, 'opt2-state-probe'))).toBe(false);
  });

  it('refuses a symlink that resolves into the checkout before writing any secret', () => {
    const target = path.join(HARNESS_ROOT, 'node_modules');
    const link = path.join(root, 'linked-secrets');
    symlinkSync(target, link, 'dir');

    expect(() => ensureLocalSecrets({ dir: link })).toThrow(/secrets directory must be outside the repository checkout/);
    for (const name of SECRET_FILES) {
      expect(existsSync(path.join(target, name)), name).toBe(false);
    }
  });
});

describe('readSecret', () => {
  it('returns the stored value of a generated secret', () => {
    const { dir } = ensureLocalSecrets({ env });

    expect(readSecret('bridge-hmac-key', { env })).toBe(readFileSync(path.join(dir, 'bridge-hmac-key'), 'utf8'));
  });

  it('trims surrounding whitespace', () => {
    mkdirSync(path.join(state, 'secrets'), { recursive: true });
    writeFileSync(localSecretPath(state, 'db-stub-app'), '\n  placeholder-value  \n');

    expect(readSecret('db-stub-app', { env })).toBe('placeholder-value');
  });

  it.each([
    { label: 'a catalogued secret not yet generated', name: 'storage-hmac-key', prepare: () => undefined },
    { label: 'a name outside the catalogue', name: 'unknown-secret', prepare: () => ensureLocalSecrets({ env }) },
  ])('names the missing file and the command that generates it for $label', ({ name, prepare }) => {
    prepare();
    const file = localSecretPath(state, name);

    expect(() => readSecret(name, { env })).toThrow(
      `secret file ${file} does not exist; run \`npm run repro:secrets\` in harness/`,
    );
  });

  it('refuses a file holding only whitespace', () => {
    mkdirSync(path.join(state, 'secrets'), { recursive: true });
    const file = localSecretPath(state, 'pubsub-push-key');
    writeFileSync(file, ' \n\t\n');

    expect(() => readSecret('pubsub-push-key', { env })).toThrow(`secret file ${file} is empty`);
  });

  it('rethrows a read failure other than a missing file', () => {
    mkdirSync(localSecretPath(state, 'db-gateway-app'), { recursive: true });

    expect(() => readSecret('db-gateway-app', { env })).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
});

describe('repro:secrets CLI', () => {
  it('prints the directory and the file names created, never a secret value', async () => {
    const { code, stdout, exit } = await runSecretsCli([]);

    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout)).toEqual({
      command: COMMAND,
      ok: true,
      code: 0,
      dir: path.join(state, 'secrets'),
      created: [...SECRET_FILES],
      kept: [],
    });
    const leaked = [...secretsOf(path.join(state, 'secrets')).values()]
      .flatMap(windows)
      .filter((fragment) => stdout.includes(fragment));
    expect(leaked).toEqual([]);
  });

  it('reports every file as kept on a repeated run', async () => {
    await runSecretsCli([]);
    const { code, stdout } = await runSecretsCli([]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ created: [], kept: [...SECRET_FILES] });
  });

  it('writes into the directory given by --dir', async () => {
    const dir = path.join(root, 'flagged');
    const { code, stdout } = await runSecretsCli(['--dir', dir]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ dir, created: [...SECRET_FILES] });
    expect(existsSync(state)).toBe(false);
  });

  it.each([
    { label: 'releases it', stale: false },
    { label: 'leaves it stale', stale: true },
  ])('serialises processes queued on a holder that $label: one creates all, the rest keep all', async ({ stale }) => {
    const dir = path.join(root, 'race');
    const holder = `${String(process.pid)}.${HEX16}`;
    const exited = `${String(exitedPid())}.${HEX16}`;
    // Held by this process until every child has queued, so all of them contend for it at once.
    const lock = seedLock(dir, holder);
    const runs = Array.from({ length: 6 }, () =>
      execFileAsync(TSX, [path.join(REPO_ROOT, SCRIPT), '--dir', dir], { cwd: HARNESS_ROOT, encoding: 'utf8' }),
    );
    const settled = Promise.allSettled(runs);
    try {
      const queued = (): number => readdirSync(dir).filter((name) => name.startsWith(`.${LOCK_NAME}.`)).length;
      await waitFor(() => queued() === runs.length, 'every process to wait on the lock');
    } finally {
      // Renaming the entry to an exited pid leaves a stale lock that every waiter judges at the same poll.
      if (stale) renameSync(path.join(lock, holder), path.join(lock, exited));
      else rmSync(path.join(lock, holder));
    }

    expect((await settled).map(({ status }) => status)).toEqual(runs.map(() => 'fulfilled'));
    const summaries = (await Promise.all(runs)).map(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>);
    const creators = summaries.filter((summary) => (summary.created as string[]).length > 0);
    expect(creators).toEqual([{ command: SCRIPT, ok: true, code: 0, dir, created: [...SECRET_FILES], kept: [] }]);
    expect(summaries.filter((summary) => !creators.includes(summary))).toEqual(
      runs.slice(1).map(() => ({ command: SCRIPT, ok: true, code: 0, dir, created: [], kept: [...SECRET_FILES] })),
    );
    expectCompleteSecrets(dir);
  }, 60_000);

  it('exits 2 with the usage text for an unknown flag and writes nothing', async () => {
    const { code, stdout } = await runSecretsCli(['--bogus']);

    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      code: 2,
      error: { type: 'UsageError' },
      usage: 'usage: tsx src/repro/secrets.ts [--dir <secrets-dir>]',
    });
    expect(existsSync(state)).toBe(false);
  });

  it('prints the help text naming OPT2_STATE_DIR and --dir, exits 0 and writes nothing', async () => {
    const { code, stdout, exit } = await runSecretsCli(['--help']);

    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(stdout.startsWith('usage: tsx src/repro/secrets.ts [--dir <secrets-dir>]\n')).toBe(true);
    expect(stdout).toContain('OPT2_STATE_DIR');
    expect(stdout).toMatch(/^ +--dir <secrets-dir> /m);
    expect(stdout).not.toMatch(/^\{/m);
    expect(existsSync(state)).toBe(false);
  });
});
