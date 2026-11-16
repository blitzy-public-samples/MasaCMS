// Unit tests for the `opt2-db` CLI: argument parsing, help and usage output, the summary line and exit codes, plus a gated run against PostgreSQL.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateLogRecord } from '@opt2/platform/logging';
import { pg } from '@opt2/platform/tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MigrateIo } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { HELP, USAGE, main, parseArgs, type ParsedArgs } from '../../src/db-bootstrap/cli.js';
import { BOOTSTRAP_TARGETS, bootstrapEnvSchema, loadBootstrapEnv, missingForTarget } from '../../src/db-bootstrap/env.js';
import {
  bootstrap,
  BootstrapStatementError,
  bootstrapOwners,
  secretPathsFor,
  teardown,
  type BootstrapSummary,
  type TeardownSummary,
} from '../../src/db-bootstrap/index.js';
import { MigrationFailedError, resetLocalSchemas, SchemaNotEmptyError } from '../../src/db-bootstrap/migrations.js';

vi.mock('../../src/db-bootstrap/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db-bootstrap/index.js')>();
  return { ...actual, bootstrap: vi.fn(actual.bootstrap), teardown: vi.fn(actual.teardown) };
});

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CLI_SOURCE = path.join(PACKAGE_DIR, 'src', 'db-bootstrap', 'cli.ts');
const config = loadConfig();
// Sample credentials are assembled at run time so no password literal sits in source.
const SAMPLE_PASSWORD = ['sample', 'admin', 'value'].join('-');
const SECRET = ['s3cr3t', 'db', 'credential'].join('-');

let tmp: string;
let stateDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'opt2-db-cli-'));
  stateDir = path.join(tmp, 'state');
  await mkdir(stateDir);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(bootstrap).mockClear();
  vi.mocked(teardown).mockClear();
});

/** Streams that record what `main` writes. */
function captureIo(): MigrateIo & { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

/** The only line of `text`, parsed; fails unless `text` is exactly one newline-terminated JSON line. */
function onlyJsonLine(text: string): Record<string, unknown> {
  expect(text.endsWith('\n')).toBe(true);
  const lines = text.slice(0, -1).split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

/** The stderr lines, each parsed and validated against log-record.v1. */
function logRecords(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
      return record;
    });
}

/** A PostgreSQL server error as `pg` raises it: SQLSTATE `code`, `severity` and optional `position`. */
function pgError(message: string, code: string, position?: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...(position === undefined ? {} : { position }) });
}

const localSource = (): NodeJS.ProcessEnv => ({
  OPT2_ENV: 'local',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  PG_DATABASE: 'opt2_test',
  PG_USER: 'admin_role',
  PG_PASSWORD: SAMPLE_PASSWORD,
  OPT2_STATE_DIR: stateDir,
});

const cloudSource = (): NodeJS.ProcessEnv => ({
  OPT2_ENV: 'cloud',
  PG_DATABASE: 'opt2',
  CLOUD_SQL_INSTANCE: 'example-project:us-central1:opt2',
  GOOGLE_CLOUD_PROJECT: 'example-project',
  OPT2_CLOUDSQL_ADMIN_PASSWORD: SAMPLE_PASSWORD,
});

const summaryOf = (overrides: Partial<BootstrapSummary> = {}): BootstrapSummary => ({
  command: 'bootstrap',
  target: 'local',
  ok: true,
  schemas: [{ schema: 'identity', owner: 'identity', migrations: 3 }],
  roles: 3,
  iamGrants: 0,
  findings: [],
  ...overrides,
});

describe('parseArgs', () => {
  it.each<{ argv: string[]; expected: ParsedArgs }>([
    { argv: ['--help'], expected: { kind: 'help' } },
    { argv: ['-h'], expected: { kind: 'help' } },
    { argv: ['help'], expected: { kind: 'help' } },
    { argv: ['bootstrap', '--target', 'local', '--help'], expected: { kind: 'help' } },
    { argv: ['nope', '-h'], expected: { kind: 'help' } },
    { argv: ['bootstrap', '--target', 'local'], expected: { kind: 'bootstrap', target: 'local' } },
    { argv: ['bootstrap', '--target=cloud'], expected: { kind: 'bootstrap', target: 'cloud' } },
    { argv: [], expected: { kind: 'usage-error', message: 'missing command' } },
    { argv: ['--target', 'local'], expected: { kind: 'usage-error', message: 'missing command' } },
    { argv: ['migrate'], expected: { kind: 'usage-error', message: 'unknown command "migrate"' } },
    { argv: ['bootstrap'], expected: { kind: 'usage-error', message: '--target local|cloud is required' } },
    { argv: ['bootstrap', '--target'], expected: { kind: 'usage-error', message: '--target needs a value' } },
    {
      argv: ['bootstrap', '--target', 'staging'],
      expected: { kind: 'usage-error', message: '--target must be one of local, cloud, got "staging"' },
    },
    { argv: ['bootstrap', '--target='], expected: { kind: 'usage-error', message: '--target must be one of local, cloud, got ""' } },
    { argv: ['bootstrap', '--target', 'local', '--force'], expected: { kind: 'usage-error', message: 'unknown option "--force"' } },
    { argv: ['bootstrap', '--targets=local'], expected: { kind: 'usage-error', message: 'unknown option "--targets=local"' } },
    { argv: ['bootstrap', '--target', 'local', 'extra'], expected: { kind: 'usage-error', message: 'unexpected argument "extra"' } },
    {
      argv: ['bootstrap', '--target', 'local', '--target=cloud'],
      expected: { kind: 'usage-error', message: '--target given more than once' },
    },
    { argv: ['teardown', '--target', 'local'], expected: { kind: 'teardown', target: 'local' } },
    { argv: ['teardown', '--target=local'], expected: { kind: 'teardown', target: 'local' } },
    { argv: ['teardown'], expected: { kind: 'usage-error', message: '--target local is required' } },
    {
      argv: ['teardown', '--target', 'cloud'],
      expected: { kind: 'usage-error', message: 'teardown supports only --target local, not "cloud"' },
    },
    {
      argv: ['teardown', '--target', 'staging'],
      expected: { kind: 'usage-error', message: '--target must be one of local, got "staging"' },
    },
    { argv: ['teardown', '--target', 'local', 'extra'], expected: { kind: 'usage-error', message: 'unexpected argument "extra"' } },
  ])('parses $argv', ({ argv, expected }) => {
    const parsed = parseArgs(argv);
    expect(parsed).toEqual(expected);
    if (parsed.kind === 'usage-error') expect(parsed.message).not.toContain('\n');
  });

  it('leaves its argument unchanged', () => {
    const argv = Object.freeze(['bootstrap', '--target', 'local']);
    expect(parseArgs(argv)).toEqual({ kind: 'bootstrap', target: 'local' });
  });
});

describe('HELP', () => {
  /** Each `Environment:` entry of HELP, its continuation lines joined, keyed by variable name. */
  const entries = new Map<string, string>();
  for (const line of HELP.slice(HELP.indexOf('Environment:\n')).split('\n').slice(1)) {
    const entry = /^ {2}([A-Z][A-Z0-9_]*) +(.+)$/.exec(line);
    const continuation = /^ {32}(.+)$/.exec(line);
    const last = [...entries.keys()].at(-1);
    if (entry?.[1] !== undefined && entry[2] !== undefined) entries.set(entry[1], entry[2]);
    else if (continuation?.[1] !== undefined && last !== undefined) entries.set(last, `${entries.get(last) ?? ''} ${continuation[1]}`);
    else break;
  }

  it('lists every variable of bootstrapEnvSchema', () => {
    expect([...entries.keys()].sort()).toEqual(Object.keys(bootstrapEnvSchema.shape).sort());
  });

  it.each(BOOTSTRAP_TARGETS)('marks as required for --target %s exactly the variables that target needs', (target) => {
    const required = [...entries].filter(([, text]) => text.endsWith('(required)') || text.endsWith(`(required for --target ${target})`));
    const needed = ['OPT2_ENV', ...missingForTarget(loadBootstrapEnv({ OPT2_ENV: target }), target)];
    expect(required.map(([name]) => name).sort()).toEqual(needed.sort());
  });

  it('closes with exit codes, a README section that exists and an example', async () => {
    const readme = await readFile(path.join(PACKAGE_DIR, 'README.md'), 'utf8');
    expect(readme.split('\n')).toContain('### Bootstrap environment');
    expect(HELP.split('\n').slice(-5)).toEqual([
      'Exit codes: 0 success, 1 failure (an invalid environment included) or role-assertion finding, 2 usage error.',
      'Documentation: migration/README.md, section "Bootstrap environment".',
      'Example, from the repository root with the local variables above exported:',
      '  OPT2_ENV=local node migration/dist/db-bootstrap/cli.js bootstrap --target local',
      '',
    ]);
  });
});

describe('main', () => {
  it('writes the help to stdout and returns 0 for help', async () => {
    const io = captureIo();
    expect(await main(['--help'], io, {})).toBe(0);
    expect(io.out()).toBe(HELP);
    expect(io.err()).toBe('');
    for (const text of [HELP, USAGE]) {
      expect(text).toMatch(/^Usage: opt2-db bootstrap --target local\|cloud\n {7}opt2-db teardown --target local\n {7}opt2-db --help\n/);
    }
  });

  it('writes the message and the usage to stderr and returns 2 for a usage error', async () => {
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'staging'], io, {})).toBe(2);
    expect(io.out()).toBe('');
    expect(io.err()).toBe(`opt2-db: --target must be one of local, cloud, got "staging"\n${USAGE}`);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('fails with one JSON line naming the variable an empty environment lacks, logged as a local record', async () => {
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'cloud'], io, {})).toBe(1);
    const error = { type: 'EnvValidationError', message: 'db-bootstrap: invalid environment (OPT2_ENV)' };
    expect(onlyJsonLine(io.out())).toEqual({ command: 'bootstrap', target: 'cloud', ok: false, error });
    const records = logRecords(io.err());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ severity: 'ERROR', message: 'bootstrap failed', service: 'db-bootstrap', version: '1.0.0', env: 'local', error });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it.each([
    {
      argv: ['bootstrap', '--target=cloud'],
      source: { OPT2_ENV: 'cloud', PG_PASSWORD: SAMPLE_PASSWORD },
      missing: 'PG_DATABASE, CLOUD_SQL_INSTANCE, GOOGLE_CLOUD_PROJECT, OPT2_CLOUDSQL_ADMIN_PASSWORD',
    },
    {
      argv: ['teardown', '--target=local'],
      source: { OPT2_ENV: 'local', PG_PASSWORD: SAMPLE_PASSWORD },
      missing: 'PG_HOST, PG_PORT, PG_DATABASE, PG_USER',
    },
  ])('names every variable $argv lacks before a logger exists, and no value', async ({ argv, source, missing }) => {
    const io = captureIo();
    expect(await main(argv, io, source)).toBe(1);
    const [command, target] = [argv[0], argv[1]?.split('=')[1]];
    const error = { type: 'BootstrapEnvError', message: `db-bootstrap: invalid environment (${missing})` };
    expect(onlyJsonLine(io.out())).toEqual({ command, target, ok: false, error });
    expect(logRecords(io.err())).toMatchObject([{ message: `${command} failed`, env: 'local', error }]);
    expect(`${io.out()}${io.err()}`).not.toContain(SAMPLE_PASSWORD);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it('prints the teardown summary as the only stdout line, without OPT2_STATE_DIR, and returns 0', async () => {
    const summary: TeardownSummary = {
      command: 'teardown',
      target: 'local',
      ok: true,
      schemas: { dropped: ['identity'], absent: ['people'] },
      roles: 3,
    };
    vi.mocked(teardown).mockResolvedValueOnce(summary);
    const io = captureIo();
    const { OPT2_STATE_DIR: _unused, ...source } = localSource();
    expect(await main(['teardown', '--target', 'local'], io, source)).toBe(0);
    expect(io.out()).toBe(`${JSON.stringify(summary)}\n`);
    const [options] = vi.mocked(teardown).mock.calls[0] ?? [];
    expect(options?.config).toBe(config);
    expect(options?.env).toMatchObject({ PG_HOST: '127.0.0.1', PG_PORT: 5432 });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('names each badly formatted variable, never its value', async () => {
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'local'], io, { ...localSource(), PG_PORT: SECRET, OPT2_STATE_DIR: `relative/${SECRET}` })).toBe(1);
    const error = { type: 'EnvValidationError', message: 'db-bootstrap: invalid environment (PG_PORT, OPT2_STATE_DIR)' };
    expect(onlyJsonLine(io.out())).toEqual({ command: 'bootstrap', target: 'local', ok: false, error });
    expect(logRecords(io.err())).toMatchObject([{ message: 'bootstrap failed', error }]);
    expect(`${io.out()}${io.err()}`).not.toContain(SECRET);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, code: 0 },
    { ok: false, code: 1 },
  ])('prints the summary as the only stdout line and returns $code when ok is $ok', async ({ ok, code }) => {
    const summary = summaryOf({
      ok,
      findings: ok ? [] : [{ kind: 'login-attribute', subject: 'identity_owner', detail: 'is LOGIN, expected NOLOGIN' }],
    });
    vi.mocked(bootstrap).mockResolvedValueOnce(summary);
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'local'], io, localSource())).toBe(code);
    expect(io.out()).toBe(`${JSON.stringify(summary)}\n`);
    const [options] = vi.mocked(bootstrap).mock.calls[0] ?? [];
    expect(options?.target).toBe('local');
    expect(options?.config).toBe(config);
    expect(options?.env).toMatchObject({ PG_HOST: '127.0.0.1', PG_PORT: 5432, OPT2_STATE_DIR: stateDir });
    expect(options?.logger).toBeDefined();
    expect(io.err()).not.toContain('bootstrap failed');
  });

  it('logs a bootstrap error as a cloud log record on stderr and prints the failure line', async () => {
    vi.mocked(bootstrap).mockImplementationOnce(async ({ logger }) => {
      logger.info('created roles for identity');
      throw new SchemaNotEmptyError(['identity']);
    });
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'cloud'], io, cloudSource())).toBe(1);
    expect(onlyJsonLine(io.out())).toEqual({
      command: 'bootstrap',
      target: 'cloud',
      ok: false,
      error: { type: 'SchemaNotEmptyError', message: '[REDACTED]', schemas: ['identity'] },
    });
    const records = io
      .err()
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(records.map((record) => record.message)).toEqual(['created roles for identity', 'bootstrap failed']);
    expect(records[1]).toMatchObject({
      severity: 'ERROR',
      service: 'db-bootstrap',
      version: '1.0.0',
      env: 'cloud',
      error: { type: 'SchemaNotEmptyError' },
    });
    expect(io.err()).not.toContain(SAMPLE_PASSWORD);
  });

  it.each([
    { command: 'bootstrap', run: bootstrap },
    { command: 'teardown', run: teardown },
  ] as const)('reports a thrown non-Error value of $command by its type alone and logs the failure', async ({ command, run }) => {
    vi.mocked(run).mockRejectedValueOnce(`connection lost: ${SECRET}`);
    const io = captureIo();
    expect(await main([command, '--target', 'local'], io, localSource())).toBe(1);
    expect(onlyJsonLine(io.out())).toEqual({ command, target: 'local', ok: false, error: { type: 'string', message: '[REDACTED]' } });
    expect(logRecords(io.err())).toMatchObject([{ severity: 'ERROR', message: `${command} failed` }]);
    expect(`${io.out()}${io.err()}`).not.toContain(SECRET);
  });

  it.each([
    {
      name: 'a connection string',
      error: new Error(`connect postgres://admin_role:${SECRET}@127.0.0.1:5432/opt2_test failed`, {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED', syscall: 'connect' }),
      }),
      summary: {
        type: 'Error',
        message: 'connect ECONNREFUSED',
        causes: [{ type: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }],
      },
      messages: ['bootstrap failed', 'caused by (code=ECONNREFUSED)'],
    },
    {
      name: 'a password quoted by a failed migration',
      error: new MigrationFailedError('people', '0002_people.sql', pgError(`syntax error at or near '${SECRET}'`, '42601', '17'), 3),
      summary: {
        type: 'MigrationFailedError',
        message: 'PostgreSQL error 42601',
        schema: 'people',
        file: '0002_people.sql',
        sqlState: '42601',
        line: 3,
        position: 17,
        causes: [{ type: 'Error', message: 'PostgreSQL error 42601', code: '42601' }],
      },
      messages: ['bootstrap failed (schema=people)', 'caused by (code=42601)'],
    },
    {
      name: 'a password in a failed statement',
      error: new BootstrapStatementError(`ALTER ROLE people_app PASSWORD '${SECRET}'`, pgError(`role people_app with password ${SECRET} does not exist`, '42704')),
      summary: {
        type: 'BootstrapStatementError',
        message: 'PostgreSQL error 42704',
        causes: [{ type: 'Error', message: 'PostgreSQL error 42704', code: '42704' }],
      },
      messages: ['bootstrap failed', 'caused by (code=42704)'],
    },
  ])('keeps $name out of stdout and stderr, printing its type, identifiers and causes', async ({ error, summary, messages }) => {
    vi.mocked(bootstrap).mockRejectedValueOnce(error);
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'local'], io, localSource())).toBe(1);
    expect(onlyJsonLine(io.out())).toEqual({ command: 'bootstrap', target: 'local', ok: false, error: summary });
    const records = logRecords(io.err());
    expect(records.map((record) => record.message)).toEqual(messages);
    expect(records[0]).toMatchObject({ severity: 'ERROR', service: 'db-bootstrap', env: 'local', error: { type: summary.type, message: summary.message } });
    expect(`${io.out()}${io.err()}`).not.toContain(SECRET);
    expect(`${io.out()}${io.err()}`).not.toContain(SAMPLE_PASSWORD);
  });
});

describe('opt2-db as a process', () => {
  /** Runs the CLI source through tsx without any database or cloud variable. */
  function runCli(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:OPT2_|PG_|MURA_|GOOGLE_|CLOUD_SQL_)/.test(key)),
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: PACKAGE_DIR, env, encoding: 'utf8' });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  it.each([
    { args: ['--help'], status: 0 },
    { args: [], status: 2 },
    { args: ['bootstrap', '--target', 'staging'], status: 2 },
    { args: ['teardown', '--target', 'cloud'], status: 2 },
    { args: ['bootstrap', '--target', 'cloud'], status: 1 },
    { args: ['teardown', '--target', 'local'], status: 1 },
  ])('exits $status for $args', ({ args, status }) => {
    const child = runCli(CLI_SOURCE, args);
    expect(child.status, child.stderr).toBe(status);
    if (status === 0) expect(child.stdout).toBe(HELP);
    if (status === 1) {
      expect(onlyJsonLine(child.stdout)).toMatchObject({ command: args[0], target: args[2], ok: false, error: { type: 'EnvValidationError' } });
      expect(logRecords(child.stderr)).toMatchObject([{ severity: 'ERROR', message: `${args[0]} failed` }]);
    }
    if (status === 2) expect(child.stderr).toMatch(/^opt2-db: /);
  });

  it('runs through a symlinked bin path', async () => {
    const link = path.join(tmp, 'opt2-db.ts');
    await symlink(CLI_SOURCE, link);
    const child = runCli(link, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(HELP);
  });
});

// Opt-in: the local bootstrap drops and recreates fixed-name roles cluster-wide, so PG_* must name a cluster this run owns.
const PG_CONFIG: pg.ClientConfig = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  connectionTimeoutMillis: 2000,
};

async function dedicatedPgReachable(): Promise<boolean> {
  if (process.env.OPT2_DEDICATED_PG !== '1' || !process.env.PG_HOST || !process.env.PG_USER || !process.env.PG_DATABASE) return false;
  const client = new pg.Client(PG_CONFIG);
  try {
    await client.connect();
  } catch {
    return false;
  }
  await client.end();
  return true;
}

const dedicated = await dedicatedPgReachable();

describe.skipIf(!dedicated)('opt2-db bootstrap against a dedicated PostgreSQL cluster', () => {
  const owners = bootstrapOwners(config, 'local');
  const passwords: string[] = [];
  let dbStateDir: string;

  beforeAll(async () => {
    dbStateDir = path.join(tmp, 'db-state');
    await mkdir(path.join(dbStateDir, 'secrets'), { recursive: true });
    for (const owner of owners) {
      const files = secretPathsFor(dbStateDir, owner.schema);
      for (const file of [files.app, files.migrator]) {
        const password = randomBytes(18).toString('base64url');
        passwords.push(password);
        await writeFile(file, `${password}\n`, { mode: 0o600 });
      }
    }
  });

  afterAll(async () => {
    const admin = new pg.Client(PG_CONFIG);
    await admin.connect();
    try {
      await resetLocalSchemas(admin, owners.map((owner) => owner.roles));
    } finally {
      await admin.end();
    }
  });

  it('bootstraps all thirteen schemas and prints exactly one JSON line', async () => {
    const io = captureIo();
    const source: NodeJS.ProcessEnv = {
      OPT2_ENV: 'local',
      PG_HOST: process.env.PG_HOST,
      PG_PORT: process.env.PG_PORT,
      PG_DATABASE: process.env.PG_DATABASE,
      PG_USER: process.env.PG_USER,
      PG_PASSWORD: process.env.PG_PASSWORD,
      OPT2_STATE_DIR: dbStateDir,
    };
    expect(await main(['bootstrap', '--target', 'local'], io, source), io.out()).toBe(0);
    const line = onlyJsonLine(io.out()) as unknown as BootstrapSummary;
    expect(line).toMatchObject({ command: 'bootstrap', target: 'local', ok: true, findings: [] });
    expect(line.schemas).toHaveLength(13);
    expect(line.schemas.map((entry) => entry.schema)).toEqual(Object.values(config.owners).map((owner) => owner.schema));
    for (const password of passwords) expect(`${io.out()}${io.err()}`).not.toContain(password);
  });

  it('tears every schema and role down without OPT2_STATE_DIR, and a repeat finds them absent', async () => {
    const schemas = owners.map((owner) => owner.schema);
    const roleNames = owners.flatMap(({ roles }) => [roles.owner, roles.app, roles.migrator]);
    const source = (stateDirectory?: string): NodeJS.ProcessEnv => ({
      OPT2_ENV: 'local',
      PG_HOST: process.env.PG_HOST,
      PG_PORT: process.env.PG_PORT,
      PG_DATABASE: process.env.PG_DATABASE,
      PG_USER: process.env.PG_USER,
      PG_PASSWORD: process.env.PG_PASSWORD,
      ...(stateDirectory === undefined ? {} : { OPT2_STATE_DIR: stateDirectory }),
    });
    const bootstrapIo = captureIo();
    expect(await main(['bootstrap', '--target', 'local'], bootstrapIo, source(dbStateDir)), bootstrapIo.out()).toBe(0);

    const io = captureIo();
    expect(await main(['teardown', '--target', 'local'], io, source()), io.out()).toBe(0);
    expect(onlyJsonLine(io.out())).toEqual({
      command: 'teardown',
      target: 'local',
      ok: true,
      schemas: { dropped: schemas, absent: [] },
      roles: roleNames.length,
    });
    const again = captureIo();
    expect(await main(['teardown', '--target', 'local'], again, source())).toBe(0);
    expect(onlyJsonLine(again.out())).toMatchObject({ ok: true, schemas: { dropped: [], absent: schemas }, roles: 0 });

    const admin = new pg.Client(PG_CONFIG);
    await admin.connect();
    try {
      const left = await admin.query<{ name: string }>(
        'SELECT nspname AS name FROM pg_namespace WHERE nspname = ANY($1::text[]) UNION ALL ' +
          'SELECT rolname FROM pg_roles WHERE rolname = ANY($2::text[])',
        [schemas, roleNames],
      );
      expect(left.rows).toEqual([]);
    } finally {
      await admin.end();
    }
    // A full local bootstrap applies every package's migrations, which takes minutes on a loaded host.
  }, 1_800_000);
});
