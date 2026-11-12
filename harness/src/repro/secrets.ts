import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** Outcome of {@link ensureLocalSecrets}: the secrets directory and the sorted file names written and left in place. */
export interface SecretsResult {
  dir: string;
  created: string[];
  kept: string[];
}

/** Writes every missing local secret into `dir` (default `<state>/secrets`), leaving existing files unchanged. */
export function ensureLocalSecrets(opts: { env?: EnvLike; dir?: string } = {}): SecretsResult {
  const dir = assertOutsideRepo(opts.dir ?? secretsDir(opts.env), 'secrets directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A symlinked path must not lead the keys into the checkout either.
  assertOutsideRepo(realpathSync(dir), 'secrets directory');
  chmodSync(dir, 0o700);

  const created: string[] = [];
  const kept: string[] = [];
  const fileOf = (name: string): string => path.join(dir, name);

  const privateFile = fileOf(TOKEN_PAIR[0]);
  const publicFile = fileOf(TOKEN_PAIR[1]);
  if (existsSync(privateFile) && existsSync(publicFile)) {
    kept.push(...TOKEN_PAIR);
  } else {
    // A lone half cannot match any new other half, so it is replaced together with the missing one.
    rmSync(privateFile, { force: true });
    rmSync(publicFile, { force: true });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // Private first: an interruption leaves a lone private key, which the next run replaces.
    writeSecret(privateFile, privateKey);
    writeSecret(publicFile, publicKey);
    created.push(...TOKEN_PAIR);
  }

  for (const name of RANDOM_FILES) {
    const file = fileOf(name);
    if (existsSync(file)) {
      kept.push(name);
      continue;
    }
    writeSecret(file, randomBytes(32).toString('hex'));
    created.push(name);
  }

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
  const { values } = parseFlags(argv, { options: { dir: { type: 'string' } }, usage: USAGE });
  const { dir, created, kept } = ensureLocalSecrets({ env, dir: values.dir });
  return { summary: { dir, created, kept } };
}

// `wx` refuses an existing file, so a concurrent run fails with EEXIST instead of overwriting a key in use.
function writeSecret(file: string, value: string): void {
  writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
