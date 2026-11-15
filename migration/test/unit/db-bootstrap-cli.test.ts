// Unit tests for the `opt2-db` CLI: argument parsing, help and usage output, the summary line and exit codes, plus a gated run against PostgreSQL.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MigrateIo } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { USAGE, main, parseArgs, type ParsedArgs } from '../../src/db-bootstrap/cli.js';
import { bootstrap, bootstrapOwners, secretPathsFor, type BootstrapSummary } from '../../src/db-bootstrap/index.js';
import { resetLocalSchemas, SchemaNotEmptyError } from '../../src/db-bootstrap/migrations.js';

vi.mock('../../src/db-bootstrap/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db-bootstrap/index.js')>();
  return { ...actual, bootstrap: vi.fn(actual.bootstrap) };
});

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CLI_SOURCE = path.join(PACKAGE_DIR, 'src', 'db-bootstrap', 'cli.ts');
const config = loadConfig();
// Sample credentials are assembled at run time so no password literal sits in source.
const SAMPLE_PASSWORD = ['sample', 'admin', 'value'].join('-');

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

describe('main', () => {
  it('writes the usage to stdout and returns 0 for help', async () => {
    const io = captureIo();
    expect(await main(['--help'], io, {})).toBe(0);
    expect(io.out()).toBe(USAGE);
    expect(io.err()).toBe('');
    expect(USAGE).toMatch(/^Usage: opt2-db bootstrap --target local\|cloud\n {7}opt2-db --help\n/);
  });

  it('writes the message and the usage to stderr and returns 2 for a usage error', async () => {
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'staging'], io, {})).toBe(2);
    expect(io.out()).toBe('');
    expect(io.err()).toBe(`opt2-db: --target must be one of local, cloud, got "staging"\n${USAGE}`);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('fails with one JSON line naming the variable an empty environment lacks', async () => {
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'cloud'], io, {})).toBe(1);
    const line = onlyJsonLine(io.out());
    expect(line).toEqual({ command: 'bootstrap', target: 'cloud', ok: false, error: expect.stringContaining('OPT2_ENV') as unknown });
    expect(io.err()).toMatch(/^opt2-db: bootstrap failed: db-bootstrap: invalid environment/);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('names every variable the cloud target lacks before a logger exists, and no value', async () => {
    const io = captureIo();
    const source = { OPT2_ENV: 'cloud', PG_PASSWORD: SAMPLE_PASSWORD };
    expect(await main(['bootstrap', '--target=cloud'], io, source)).toBe(1);
    expect(onlyJsonLine(io.out())).toEqual({
      command: 'bootstrap',
      target: 'cloud',
      ok: false,
      error: 'db-bootstrap needs PG_DATABASE, CLOUD_SQL_INSTANCE, GOOGLE_CLOUD_PROJECT, OPT2_CLOUDSQL_ADMIN_PASSWORD',
    });
    expect(`${io.out()}${io.err()}`).not.toContain(SAMPLE_PASSWORD);
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
      error: 'refusing to apply migrations: schemas already hold tables: identity',
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

  it('reports a thrown non-Error value by its text', async () => {
    vi.mocked(bootstrap).mockRejectedValueOnce('connection lost');
    const io = captureIo();
    expect(await main(['bootstrap', '--target', 'local'], io, localSource())).toBe(1);
    expect(onlyJsonLine(io.out())).toEqual({ command: 'bootstrap', target: 'local', ok: false, error: 'connection lost' });
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
    { args: ['bootstrap', '--target', 'cloud'], status: 1 },
  ])('exits $status for $args', ({ args, status }) => {
    const child = runCli(CLI_SOURCE, args);
    expect(child.status, child.stderr).toBe(status);
    if (status === 0) expect(child.stdout).toBe(USAGE);
    if (status === 1) expect(onlyJsonLine(child.stdout)).toMatchObject({ command: 'bootstrap', target: 'cloud', ok: false });
    if (status === 2) expect(child.stderr).toMatch(/^opt2-db: /);
  });

  it('runs through a symlinked bin path', async () => {
    const link = path.join(tmp, 'opt2-db.ts');
    await symlink(CLI_SOURCE, link);
    const child = runCli(link, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(USAGE);
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
});
