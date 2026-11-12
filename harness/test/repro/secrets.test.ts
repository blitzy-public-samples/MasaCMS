import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SECRET_FILES, loadLocalSigningKeys, localSecretPath } from '@opt2/platform/auth';

import { runCli } from '../../src/lib/cli.js';
import { HARNESS_ROOT, REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { DB_SCHEMAS, SECRET_FILES, ensureLocalSecrets, main, readSecret } from '../../src/repro/secrets.js';

const COMMAND = 'repro:secrets';
const PRIVATE_PEM = LOCAL_SECRET_FILES.tokenSigningPrivateKey;
const PUBLIC_PEM = LOCAL_SECRET_FILES.tokenSigningPublicKey;
const PEM_PAIR = [PRIVATE_PEM, PUBLIC_PEM] as const;
const RANDOM_HEX = /^[0-9a-f]{64}$/;

let root: string;
let state: string;
let env: EnvLike;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-secrets-'));
  state = path.join(root, 'state');
  env = { OPT2_STATE_DIR: state };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function secretsOf(dir: string): Map<string, string> {
  return new Map(SECRET_FILES.map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]));
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
});
