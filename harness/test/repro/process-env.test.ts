import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';
import { PACKAGE_NAMES, portFor, type PackageName } from '../../src/repro/ports.js';

/** Synthetic value for `label`, assembled at run time so no credential-shaped literal sits in the source. */
const synthetic = (label: string): string => ['synthetic', label, 'value'].join('-');

/** PostgreSQL schema of each process with one (process_schema of processes.sh). */
const SCHEMAS = [
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
];

/** Masa password-policy settings, which carry PASSWORD in their name but hold no credential. */
const POLICY: Record<string, string> = {
  MURA_AUTORESETPASSWORDS: 'true',
  MURA_BCRYPTPASSWORDS: 'false',
  MURA_ENCRYPTPASSWORDS: 'true',
  MURA_EXPIREPASSWORDS: '90',
  MURA_STRONGPASSWORDREGEX: '(?=^.{7,15}$)(?=.*\\d)(?![.\\n])(?=.*[a-zA-Z]).*$',
  MURA_STRONGPASSWORDS: 'true',
};

/** Legacy database connection, handed to migration alone. */
const DB_CONNECTION: Record<string, string> = {
  MURA_DBHOST: '127.0.0.1',
  MURA_DBPORT: '14330',
  MURA_DATABASE: 'synthetic_db',
  MURA_DBUSERNAME: 'synthetic_user',
  MURA_DBPASSWORD: synthetic('db-password'),
  MURA_DATASOURCE: 'synthetic_dsn',
};

/** The connection names a process other than migration receives, which its legacy error pages print. */
const DB_NAME_READERS: Partial<Record<PackageName, readonly string[]>> = {
  'strategies-content': ['MURA_DATABASE'],
  identity: ['MURA_DATASOURCE', 'MURA_DATABASE'],
  people: ['MURA_DATASOURCE', 'MURA_DATABASE'],
};

/** Masa credentials no target process receives. */
const CREDENTIALS: Record<string, string> = {
  MURA_ADMIN_USERNAME: 'synthetic-admin',
  MURA_ADMIN_PASSWORD: synthetic('admin-password'),
  MURA_MAILSERVERPASSWORD: synthetic('mail-password'),
  MURA_PROXYPASSWORD: synthetic('proxy-password'),
  MURA_READONLYDBPASSWORD: synthetic('readonly-password'),
  MURA_ENCRYPTIONKEY: synthetic('encryption-key'),
  MURA_RECAPTCHASECRET: synthetic('recaptcha-secret'),
};

const RELOAD_KEY = synthetic('reload-key');
/** Processes that mirror legacy's appreloadkey. */
const RELOAD_KEY_READERS: PackageName[] = [
  'gateway',
  'web',
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'migration',
];
const RELOAD_KEY_OTHERS = PACKAGE_NAMES.filter((name) => !RELOAD_KEY_READERS.includes(name));

/** Masa s3assets, whose URL form carries an S3 key pair; only web reads it. */
const S3_ASSETS = `s3://${synthetic('s3-access')}:${synthetic('s3-secret')}@synthetic-bucket`;
const S3_ASSETS_OTHERS = PACKAGE_NAMES.filter((name) => name !== 'web');

const LEGACY_PORT = '20180';
/** A caller MURA_PORT and MURA_PROXYPORT that differ from the gateway port legacy's server.json sets. */
const CALLER_PORT = '9999';

let root = '';
let stateDir = '';

/** The environment the scripts run under: synthetic settings only, never the host's MURA_* or PG_* values. */
function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    TZ: 'UTC',
    OPT2_STATE_DIR: stateDir,
    OPT2_PRISTINE_DIR: path.join(root, 'pristine'),
    OPT2_SERVICE_URLS: '{}',
    PORT: LEGACY_PORT,
    PG_HOST: '127.0.0.1',
    PG_PORT: '15432',
    PG_DATABASE: 'synthetic_services',
    MURA_SITEIDINURLS: 'false',
    MURA_APPRELOADKEY: RELOAD_KEY,
    MURA_S3ASSETS: S3_ASSETS,
    MURA_PORT: CALLER_PORT,
    MURA_PROXYPORT: CALLER_PORT,
    ...POLICY,
    ...DB_CONNECTION,
    ...CREDENTIALS,
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Runs `<fn> <arg>` of processes.sh in the checkout `repo` and returns its KEY=value lines as a map. */
function runEnv(
  fn: 'process_env' | 'operator_env',
  arg: string,
  extra: Record<string, string | undefined> = {},
  repo = REPO_ROOT,
): Record<string, string> {
  const script =
    'source "$1/harness/repro/lib/common.sh" && source "$1/harness/repro/lib/processes.sh" && "$2" ${3:+"$3"}';
  const result = spawnSync('bash', ['-c', script, 'process-env-test', repo, fn, arg], {
    encoding: 'utf8',
    env: baseEnv(extra),
    timeout: 20_000,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const env: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

const envs = new Map<PackageName, Record<string, string>>();

/** The cached process_env of `name` under baseEnv(). */
function envOf(name: PackageName): Record<string, string> {
  const env = envs.get(name);
  if (env === undefined) throw new Error(`no process_env captured for ${name}`);
  return env;
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opt2-process-env-test-'));
  stateDir = path.join(root, 'state');
  mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
  mkdirSync(path.join(root, 'home'));
  for (const schema of SCHEMAS) {
    writeFileSync(path.join(stateDir, 'secrets', `db-${schema}-app`), synthetic(`${schema}-role`));
  }
  writeFileSync(path.join(stateDir, 'secrets', 'bridge-hmac-key'), synthetic('bridge-key'));
  for (const name of PACKAGE_NAMES) envs.set(name, runEnv('process_env', name));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('process_env Masa settings', () => {
  it.each(['people', 'web'] as const)('hands the password policy settings to %s', (name) => {
    for (const [key, value] of Object.entries(POLICY)) expect(envOf(name)[key], key).toBe(value);
  });

  it.each([...PACKAGE_NAMES])('passes ordinary Masa settings to %s', (name) => {
    expect(envOf(name).MURA_SITEIDINURLS).toBe('false');
  });

  it.each(PACKAGE_NAMES.filter((name) => name !== 'migration'))(
    'withholds the database connection and every credential from %s',
    (name) => {
      const env = envOf(name);
      const handed = DB_NAME_READERS[name] ?? [];
      for (const key of [...Object.keys(DB_CONNECTION), ...Object.keys(CREDENTIALS)].filter((key) => !handed.includes(key))) {
        expect(env, key).not.toHaveProperty(key);
      }
      const text = Object.values(env).join('\n');
      for (const value of [DB_CONNECTION.MURA_DBPASSWORD, ...Object.values(CREDENTIALS)]) {
        expect(text).not.toContain(value);
      }
    },
  );

  it('hands strategies-content the database name, which its SQL Server error messages name', () => {
    expect(envOf('strategies-content').MURA_DATABASE).toBe(DB_CONNECTION.MURA_DATABASE);
  });

  it.each(['identity', 'people'] as const)('hands %s the datasource and database names, which the debug page of a failed legacy query prints', (name) => {
    expect(envOf(name)).toMatchObject({ MURA_DATASOURCE: DB_CONNECTION.MURA_DATASOURCE, MURA_DATABASE: DB_CONNECTION.MURA_DATABASE });
  });

  it('hands migration the database connection and no other credential', () => {
    const env = envOf('migration');
    for (const key of ['MURA_DBHOST', 'MURA_DBPORT', 'MURA_DATABASE', 'MURA_DBUSERNAME', 'MURA_DBPASSWORD']) {
      expect(env[key], key).toBe(DB_CONNECTION[key]);
    }
    expect(env).not.toHaveProperty('MURA_DATASOURCE');
    for (const key of Object.keys(CREDENTIALS)) expect(env, key).not.toHaveProperty(key);
  });

  it.each(RELOAD_KEY_READERS)('hands the reload key to %s, which mirrors legacy appreloadkey', (name) => {
    expect(envOf(name).MURA_APPRELOADKEY).toBe(RELOAD_KEY);
  });

  it.each(RELOAD_KEY_OTHERS)('withholds the reload key from %s', (name) => {
    expect(envOf(name)).not.toHaveProperty('MURA_APPRELOADKEY');
    expect(Object.values(envOf(name))).not.toContain(RELOAD_KEY);
  });

  it('hands s3assets to web, which applies it to fileDir', () => {
    expect(envOf('web').MURA_S3ASSETS).toBe(S3_ASSETS);
  });

  it.each([...S3_ASSETS_OTHERS, 'operator_env'] as const)('withholds s3assets from %s', (name) => {
    const env = name === 'operator_env' ? runEnv('operator_env', '') : envOf(name);
    expect(env).not.toHaveProperty('MURA_S3ASSETS');
    expect(Object.values(env).join('\n')).not.toContain(synthetic('s3-secret'));
  });
});

describe('process_env Masa port pair', () => {
  it.each([...PACKAGE_NAMES])('gives %s the gateway port as MURA_PORT and MURA_PROXYPORT over the caller', (name) => {
    const gateway = String(portFor('gateway'));
    expect(gateway).not.toBe(CALLER_PORT);
    expect(envOf(name).MURA_PORT).toBe(gateway);
    expect(envOf(name).MURA_PROXYPORT).toBe(gateway);
  });
});

describe('process_env Masa web root', () => {
  it('gives web the checkout legacy serves as MURA_WEBROOT over the caller, and no other process any', () => {
    const others = PACKAGE_NAMES.filter((name) => name !== 'web');
    const web = runEnv('process_env', 'web', { MURA_WEBROOT: '/srv/caller-webroot' });

    expect(web.MURA_WEBROOT).toBe(realpathSync(REPO_ROOT));
    expect(envOf('web').MURA_WEBROOT).toBe(realpathSync(REPO_ROOT));
    for (const name of others) {
      expect(runEnv('process_env', name, { MURA_WEBROOT: '/srv/caller-webroot' }), name).not.toHaveProperty('MURA_WEBROOT');
    }
  });
});

describe('process_env OPT2_REPORTS_DIR', () => {
  it.each([
    ['a relative value against the checkout', 'out/reports', path.join(realpathSync(REPO_ROOT), 'out/reports')],
    ['an absolute value unchanged', '/srv/opt2-reports', '/srv/opt2-reports'],
  ])('hands migration and operator_env %s', (_label, value, expected) => {
    expect(runEnv('process_env', 'migration', { OPT2_REPORTS_DIR: value }).OPT2_REPORTS_DIR).toBe(expected);
    expect(runEnv('operator_env', '', { OPT2_REPORTS_DIR: value }).OPT2_REPORTS_DIR).toBe(expected);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('hands migration and operator_env none when %s, so migration keeps its default', (_label, value) => {
    expect(runEnv('process_env', 'migration', { OPT2_REPORTS_DIR: value })).not.toHaveProperty('OPT2_REPORTS_DIR');
    expect(runEnv('operator_env', '', { OPT2_REPORTS_DIR: value })).not.toHaveProperty('OPT2_REPORTS_DIR');
  });
});

describe('process_env of a second stack', () => {
  const KEYS = ['OPT2_PORTS_FILE', 'OPT2_CF_SERVER_NAME', 'OPT2_LOCK_DIR'] as const;

  /** A port file with every port of the committed one moved up by 10000, written under the test root. */
  function movedPortsFile(): string {
    const file = path.join(root, 'moved-ports.env');
    const text = readFileSync(repoPath('harness', 'repro', 'ports.env'), 'utf8');
    writeFileSync(file, text.replace(/^(OPT2_\w+)=(\d+)$/gm, (_line, key: string, port: string) => `${key}=${Number(port) + 10000}`));
    return file;
  }

  const values = (): Record<(typeof KEYS)[number], string> => ({
    OPT2_PORTS_FILE: movedPortsFile(),
    OPT2_CF_SERVER_NAME: 'opt2-legacy-c25',
    OPT2_LOCK_DIR: path.join(root, 'c25-lock'),
  });

  it.each(KEYS)("hands migration and operator_env the caller's %s, and no other process", (key) => {
    const extra = { [key]: values()[key] };
    expect(runEnv('process_env', 'migration', extra)[key]).toBe(extra[key]);
    expect(runEnv('operator_env', '', extra)[key]).toBe(extra[key]);
    for (const name of PACKAGE_NAMES.filter((other) => other !== 'migration')) {
      expect(runEnv('process_env', name, extra), name).not.toHaveProperty(key);
    }
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('hands migration and operator_env none of them when %s', (_label, value) => {
    const extra = Object.fromEntries(KEYS.map((key) => [key, value]));
    for (const env of [runEnv('process_env', 'migration', extra), runEnv('operator_env', '', extra)]) {
      for (const key of KEYS) expect(env, key).not.toHaveProperty(key);
    }
  });

  it('derives every port and loopback address of a process from OPT2_PORTS_FILE', () => {
    const moved = (name: PackageName): number => portFor(name) + 10000;
    expect(runEnv('process_env', 'communications', { OPT2_PORTS_FILE: movedPortsFile() })).toMatchObject({
      PORT: String(moved('communications')),
      OPT2_JWKS_URL: `http://127.0.0.1:${moved('identity')}/.well-known/jwks.json`,
      OPT2_GATEWAY_URL: `http://127.0.0.1:${moved('gateway')}`,
      OPT2_MIGRATION_URL: `http://127.0.0.1:${moved('migration')}`,
      MURA_PORT: String(moved('gateway')),
      PUBSUB_EMULATOR_HOST: 'localhost:18085',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:14319',
      SMTP_PORT: '11025',
      MAILPIT_API_URL: 'http://127.0.0.1:18025',
    });
  });
});

describe('process_env OPT2_LEGACY_RESTART_CMD', () => {
  it.each([
    ['a space', 'opt 2'],
    ['quotes, command substitution and shell operators', 'opt 2 $(touch injected);\'q\' "d" `touch tick` & | < > * \\'],
  ])('runs legacy-start.sh through /bin/sh from a checkout path with %s', (_label, dirName) => {
    const checkout = path.join(root, 'checkouts', dirName);
    const lib = path.join(checkout, 'harness', 'repro', 'lib');
    mkdirSync(lib, { recursive: true });
    copyFileSync(repoPath('harness', 'repro', 'ports.env'), path.join(checkout, 'harness', 'repro', 'ports.env'));
    for (const file of ['common.sh', 'processes.sh']) {
      copyFileSync(repoPath('harness', 'repro', 'lib', file), path.join(lib, file));
    }
    const stub = path.join(lib, 'legacy-start.sh');
    writeFileSync(stub, '#!/bin/sh\nprintf "legacy-start %s %s\\n" "$#" "$0"\n', { mode: 0o755 });
    const command = runEnv('process_env', 'migration', {}, checkout).OPT2_LEGACY_RESTART_CMD ?? '';
    const cwd = mkdtempSync(path.join(root, 'restart-cwd-'));

    // spawn(command, { shell: true }) runs `/bin/sh -c <command>`.
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: 10_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`legacy-start 0 ${realpathSync(stub)}\n`);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(path.join(checkout, 'injected'))).toBe(false);
  });
});
