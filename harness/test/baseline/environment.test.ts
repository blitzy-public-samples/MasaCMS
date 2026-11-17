import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  LOCAL_PROBES,
  PLANNED_PINS,
  PROBE_TIMEOUT_MS,
  UNPROBED_PINS,
  defaultCommandRunner,
  environmentEnvSchema,
  main,
  mergeRecord,
  probeLocal,
  probeServices,
  recordedSections,
  renderEnvironmentMarkdown,
  runEnvironment,
  type CommandResult,
  type CommandRunner,
  type EnvironmentConfig,
  type EnvironmentDeps,
  type EnvironmentRecord,
  type EnvironmentSettings,
  type PhaseBlock,
  type ProbeRow,
  type VersionMenu,
} from '../../src/baseline/environment.js';
import { UsageError, runCli } from '../../src/lib/cli.js';
import { assertReadOnlySql, type ReadOnlyMssql } from '../../src/lib/mssql.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import type { CatalogClient } from '../../src/lib/pg.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

type RunInfo = Record<string, unknown> & { cluster: Record<string, unknown>; startup: Record<string, unknown> };

const FIXTURE = new URL('../fixtures/testbox/run-info.json', import.meta.url);
const RUN_INFO_TEXT = await fs.readFile(FIXTURE, 'utf8');
const RUN_INFO = JSON.parse(RUN_INFO_TEXT) as RunInfo;
/** `opt2/reports/environment.md` as committed at HEAD, since `up.sh` rewrites the working-tree copy. */
const COMMITTED_REPORT_TEXT = execFileSync('git', ['show', 'HEAD:opt2/reports/environment.md'], { cwd: REPO_ROOT, encoding: 'utf8' });
const PIN_SHA = (JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'opt2', 'source-pin.json'), 'utf8')) as { sha: string }).sha;

const LEGACY = 'http://legacy.test';
const MAILPIT = 'http://mailpit.test';
const INFO_URL = `${LEGACY}/harness/legacy-baseline/cfml/run.cfm?info=1`;
const MAILPIT_INFO_URL = `${MAILPIT}/api/v1/info`;
const MAILPIT_INFO = { Version: 'v1.21.0', Database: '/var/lib/mailpit/mailpit.db', Messages: 0 };
const PINNED_NODE = `v${PLANNED_PINS.node}`;
const LOCAL_AT = new Date('2026-06-30T08:00:00.000Z');
const SERVICES_AT = new Date('2026-06-30T09:00:00.000Z');
const SQLSERVER_VERSION =
  'Microsoft SQL Server 2022 (RTM-CU20) - 16.0.4305.5 (X64) \n\tJun 30 2026 00:00:00 \n\tExpress Edition (64-bit) on Linux (Ubuntu 25.10) <X64>';
const PG_VERSION = 'PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg25.10+1) on x86_64-pc-linux-gnu, compiled by gcc 15.2.0, 64-bit';
const NOT_FOUND: Partial<CommandResult> = { ok: false, code: null, stdout: '', stderr: '', error: 'not found' };
const DEVIATION_TAIL = 'a baseline deviation, and the migration stages stop, because SQL Server (mssql) is the only supported source';

const HEADINGS = {
  local: '## Local phase (`--phase local`)',
  services: '## Services phase (`--phase services`)',
  settings: '## Settings',
} as const;

/** Plausible output of each local probe, by probe id. */
const LOCAL_OUTPUT: Record<string, Partial<CommandResult>> = {
  node: { stdout: `${PINNED_NODE}\n` },
  npm: { stdout: `${PLANNED_PINS.npm}\n` },
  terraform: {
    stdout: JSON.stringify({ terraform_version: '1.17.1', platform: 'linux_amd64', provider_selections: {}, terraform_outdated: false }),
  },
  'otelcol-contrib': { stdout: 'otelcol-contrib version 0.164.0\n' },
  gcloud: { stdout: JSON.stringify({ 'Google Cloud SDK': '591.0.0', core: '2026.06.30', 'pubsub-emulator': '0.8.25' }) },
  box: { stdout: '\u001b[32mCommandBox 6.3.5+00811\u001b[0m\n' },
  java: {
    stderr:
      'Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8\nopenjdk version "21.0.13" 2026-10-20\nOpenJDK Runtime Environment (build 21.0.13+11)\n',
  },
  'java-coldfusion': { stderr: 'openjdk version "17.0.21" 2026-10-20\nOpenJDK Runtime Environment (build 17.0.21+7)\n' },
  sqlcmd: { stdout: 'Microsoft (R) SQL Server Command Line Tool\nVersion 18.7.0001.1 Linux\nCopyright (C) 2017 Microsoft Corporation.\n' },
  psql: { stdout: 'psql (PostgreSQL) 16.15 (Ubuntu 16.15-1.pgdg25.10+1)\n' },
};

/** What `probeLocal` records from {@link LOCAL_OUTPUT}, by probe id. */
const LOCAL_RECORDED: Record<string, string> = {
  node: PINNED_NODE,
  npm: PLANNED_PINS.npm,
  terraform: '1.17.1',
  'otelcol-contrib': '0.164.0',
  gcloud: 'Google Cloud SDK 591.0.0; pubsub-emulator 0.8.25',
  box: 'CommandBox 6.3.5+00811',
  java: 'openjdk version "21.0.13" 2026-10-20',
  'java-coldfusion': 'openjdk version "17.0.21" 2026-10-20',
  sqlcmd: 'Version 18.7.0001.1 Linux',
  psql: '16.15',
};

/** Version menu values `probeServices` derives from the fixture. */
const FIXTURE_VERSION_MENU: VersionMenu = {
  appServerProductName: 'ColdFusion Server',
  appServerVersion: '2023,0,13,330833',
  dbProductName: 'Microsoft SQL Server',
  dbProductVersion: 'Microsoft SQL Server 2022 - 16.0.4305.5',
  javaVersion: null,
  osName: 'UNIX',
  osVersion: '6.12.105+',
};

/** Settings `probeServices` derives from the fixture with the base environment. */
const FIXTURE_SETTINGS: EnvironmentSettings = {
  timeZone: 'America/New_York',
  utcTotalOffset: 14400,
  processTz: 'America/New_York',
  timeZoneMatchesProcess: true,
  ping: false,
  siteMonitorTaskRegistered: false,
  nativeTasks: { status: 'absent', originalPing: null, siteMonitorTask: null, detail: 'native-tasks.json absent' },
  cluster: {
    broadcastClusterCommands: false,
    broadcastCachePurges: false,
    broadcastAppreloads: false,
    peerCount: 0,
    tclustercommandsCount: 0,
    broadcastingOff: true,
    noPeers: true,
    clusterSafe: true,
  },
  startup: {
    projectSiteID: 'default',
    projectSiteExists: true,
    deployBundlePath: '/tmp/MuraBundle.zip',
    deployBundlePresent: false,
    autoDiscoverPlugins: false,
    applyDbUpdates: false,
    appAutoUpdated: false,
    themeStandardImageSizes: [],
    writersClosed: true,
    openGuards: [],
  },
  dbtype: 'mssql',
  mysqlFallback: false,
  deviation: false,
  deviationReason: null,
  edition: 'Developer',
  expiration: '',
  defaultHashAlgorithm: 'CFMX_COMPAT',
  versionMenu: FIXTURE_VERSION_MENU,
};

const REAL_NODE_VERSION = Object.getOwnPropertyDescriptor(process, 'version') ?? {
  value: process.version,
  configurable: true,
  enumerable: true,
};

let root: string;
let stateDir: string;
let reportsDir: string;
let pristine: string;
let unexpectedUrls: string[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-baseline-env-'));
  stateDir = path.join(root, 'state');
  reportsDir = path.join(root, 'reports');
  pristine = path.join(root, 'pristine');
  await fs.mkdir(pristine);
  unexpectedUrls = [];
  runningNode(PINNED_NODE);
});

afterEach(async () => {
  Object.defineProperty(process, 'version', REAL_NODE_VERSION);
  vi.mocked(execFile).mockReset();
  const stray = unexpectedUrls;
  await fs.rm(root, { recursive: true, force: true });
  expect(stray).toEqual([]);
});

/** Makes `process.version` report `version` until the test ends. */
function runningNode(version: string): void {
  Object.defineProperty(process, 'version', { ...REAL_NODE_VERSION, value: version });
}

function baseEnv(): EnvLike {
  return {
    OPT2_STATE_DIR: stateDir,
    OPT2_REPORTS_DIR: reportsDir,
    OPT2_PRISTINE_DIR: pristine,
    LEGACY_ORIGIN: LEGACY,
    MAILPIT_API_URL: MAILPIT,
    MURA_DBTYPE: 'mssql',
    MURA_DEFAULTHASHALGORITHM: 'CFMX_COMPAT',
    TZ: 'America/New_York',
  };
}

function fakeRunner(overrides: Record<string, Partial<CommandResult>> = {}): Mock<CommandRunner> {
  return vi.fn<CommandRunner>(async (cmd, args) => {
    const probe = LOCAL_PROBES.find((p) => p.command === cmd && p.args.join(' ') === args.join(' '));
    if (probe === undefined) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return { ok: true, code: 0, stdout: '', stderr: '', ...LOCAL_OUTPUT[probe.id], ...overrides[probe.id] };
  });
}

function respond(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Answers run.cfm?info=1 with the fixture and Mailpit with its info, unless `routes` replaces them; any other URL is recorded as stray. */
function fakeFetch(routes: Record<string, () => Response> = {}): Mock<typeof fetch> {
  const table: Record<string, () => Response> = {
    [INFO_URL]: () => respond(RUN_INFO_TEXT),
    [MAILPIT_INFO_URL]: () => respond(MAILPIT_INFO),
    ...routes,
  };
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const route = table[url];
    if (route === undefined) {
      unexpectedUrls.push(url);
      throw new Error(`unexpected fetch: ${url}`);
    }
    return route();
  });
}

/** Route answering run.cfm?info=1 with the fixture overlaid by `patch`; an undefined value drops the key. */
function info(patch: Record<string, unknown>): Record<string, () => Response> {
  return { [INFO_URL]: () => respond({ ...RUN_INFO, ...patch }) };
}

function cluster(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...RUN_INFO.cluster, ...patch };
}

function startup(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...RUN_INFO.startup, ...patch };
}

type SqlOptions = { version?: unknown[]; count?: unknown[]; connectError?: Error };

function fakeMssql(opts: SqlOptions = {}) {
  const statements: string[] = [];
  const close = vi.fn(async () => undefined);
  const answers: Record<string, unknown[]> = {
    'SELECT @@VERSION AS version': opts.version ?? [{ version: SQLSERVER_VERSION }],
    'SELECT COUNT(*) AS n FROM tclustercommands': opts.count ?? [{ n: 0 }],
  };
  const client: ReadOnlyMssql = {
    async readOnlyQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      statements.push(sql);
      assertReadOnlySql(sql);
      const rows = answers[sql];
      if (rows === undefined) throw new Error(`unexpected SQL Server query: ${sql}`);
      return structuredClone(rows) as T[];
    },
    close,
  };
  const factory = vi.fn<NonNullable<EnvironmentDeps['mssqlFactory']>>(async () => {
    if (opts.connectError !== undefined) throw opts.connectError;
    return client;
  });
  return { factory, statements, close };
}

type PgOptions = { rows?: unknown[]; connectError?: Error };

function fakePg(opts: PgOptions = {}) {
  const statements: string[] = [];
  const close = vi.fn(async () => undefined);
  const client: CatalogClient = {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      statements.push(sql);
      if (sql !== 'SELECT version() AS version') throw new Error(`unexpected PostgreSQL query: ${sql}`);
      return structuredClone(opts.rows ?? [{ version: PG_VERSION }]) as T[];
    },
    close,
  };
  const factory = vi.fn<NonNullable<EnvironmentDeps['pgFactory']>>(async () => {
    if (opts.connectError !== undefined) throw opts.connectError;
    return client;
  });
  return { factory, statements, close };
}

type RigOptions = {
  env?: EnvLike;
  local?: Record<string, Partial<CommandResult>>;
  routes?: Record<string, () => Response>;
  sql?: SqlOptions;
  pg?: PgOptions;
  at?: Date;
};

/** Every process boundary of the command replaced by a fake. */
function rig(opts: RigOptions = {}) {
  const runner = fakeRunner(opts.local);
  const fetchFake = fakeFetch(opts.routes);
  const mssql = fakeMssql(opts.sql);
  const pg = fakePg(opts.pg);
  const at = opts.at ?? SERVICES_AT;
  const deps: EnvironmentDeps = {
    env: { ...baseEnv(), ...opts.env },
    runCommand: runner,
    fetch: fetchFake,
    mssqlFactory: mssql.factory,
    pgFactory: pg.factory,
    now: () => at,
  };
  return { deps, runner, fetch: fetchFake, mssql, pg };
}

function probe(block: PhaseBlock, id: string): ProbeRow | undefined {
  return block.probes.find((row) => row.id === id);
}

function brief(rows: readonly ProbeRow[]): Pick<ProbeRow, 'id' | 'recorded' | 'status' | 'detail'>[] {
  return rows.map(({ id, recorded, status, detail }) => ({ id, recorded, status, detail }));
}

/** Lines of the section opened by `heading`, up to the next `## ` heading. */
function section(lines: readonly string[], heading: string): string[] {
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start, end < 0 ? lines.length : end);
}

/** Data rows of the table in the section opened by `heading`. */
function tableRows(lines: readonly string[], heading: string): string[] {
  return section(lines, heading)
    .filter((line) => line.startsWith('|'))
    .slice(2);
}

function cells(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Last cell of the row labelled `label` in the section opened by `heading`. */
function recordedCell(lines: readonly string[], heading: string, label: string): string | undefined {
  const line = tableRows(lines, heading).find((row) => cells(row)[0] === label);
  return line === undefined ? undefined : cells(line).at(-1);
}

async function readReport(): Promise<string[]> {
  return (await fs.readFile(path.join(reportsDir, 'environment.md'), 'utf8')).split('\n');
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(stateDir, 'baseline', 'environment.json'), 'utf8')) as Record<string, unknown>;
}

async function removeState(): Promise<void> {
  await fs.rm(path.join(stateDir, 'baseline', 'environment.json'));
}

async function cli(argv: string[], deps: EnvironmentDeps): Promise<{ code: number; lines: string[]; exit: Mock<(code: number) => void> }> {
  const lines: string[] = [];
  const exit = vi.fn<(code: number) => void>();
  const code = await runCli((args) => main(args, deps), {
    argv,
    stdout: { write: (chunk: string) => lines.push(chunk) },
    exit,
    command: 'baseline:environment',
  });
  return { code, lines, exit };
}

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Makes the mocked `execFile` answer through its callback; returns the child's `stdin.end`. */
function execFileAnswers(answer: (callback: ExecCallback) => void): Mock<() => void> {
  const end = vi.fn<() => void>();
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: ExecCallback) => {
    queueMicrotask(() => answer(callback));
    return { stdin: { end } };
  }) as unknown as typeof execFile);
  return end;
}

describe('run-info.json fixture', () => {
  it('carries exactly the keys run.cfm?info=1 emits, in its order, with the bundle list it derives', async () => {
    const cfm = await fs.readFile(path.join(REPO_ROOT, 'harness', 'legacy-baseline', 'cfml', 'run.cfm'), 'utf8');
    const branch = cfm.slice(cfm.indexOf('<cfelseif url.info eq "1">'), cfm.indexOf('<cfelseif url.info eq "entities">'));
    const keys = (pattern: RegExp): string[] => [...new Set([...branch.matchAll(pattern)].map((m) => m[1] ?? ''))];
    const specs = await fs.readdir(path.join(REPO_ROOT, 'core', 'tests', 'specs', 'mura', 'core'));

    expect(Object.keys(RUN_INFO)).toEqual(keys(/\benvironment\["(\w+)"\]/g));
    expect(Object.keys(RUN_INFO.cluster)).toEqual(keys(/\bcluster\["(\w+)"\]/g));
    expect(Object.keys(RUN_INFO.startup)).toEqual(keys(/\bstartup\["(\w+)"\]/g));
    expect(RUN_INFO.bundles).toEqual(
      specs
        .filter((name) => name.endsWith('.cfc'))
        .map((name) => name.slice(0, -'.cfc'.length))
        .filter((name) => name !== 'bundleValidatorSecurity')
        .sort(),
    );
    expect(RUN_INFO.bundles).toHaveLength(22);
    expect(RUN_INFO.excludedBundles).toEqual(['bundleValidatorSecurity']);
    expect((await fs.stat(FIXTURE)).size).toBeLessThan(20_000);
  });
});

describe('PLANNED_PINS and LOCAL_PROBES', () => {
  it('pins the planned tool versions and names the pins no probe reads', () => {
    expect(PLANNED_PINS).toEqual({
      node: '22.23.4',
      npm: '11.21.0',
      terraform: '1.17.1',
      googleProvider: '8.9.0',
      otelcolContrib: 'v0.164.0',
      postgresql: '16',
      typescript: '5.9.3',
    });
    expect(UNPROBED_PINS.map((pin) => [pin.name, pin.version])).toEqual([
      ['TypeScript', '5.9.3'],
      ['provider hashicorp/google', '8.9.0'],
    ]);
  });

  it('probes the local tools in report order, the ColdFusion JVM by its absolute path', () => {
    expect(LOCAL_PROBES.map((p) => [p.id, p.command, p.args.join(' ')])).toEqual([
      ['node', 'node', '-v'],
      ['npm', 'npm', '-v'],
      ['terraform', 'terraform', 'version -json'],
      ['otelcol-contrib', 'otelcol-contrib', '--version'],
      ['gcloud', 'gcloud', 'version --format=json'],
      ['box', 'box', 'version'],
      ['java', 'java', '-version'],
      ['java-coldfusion', '/usr/lib/jvm/java-17-openjdk-amd64/bin/java', '-version'],
      ['sqlcmd', 'sqlcmd', '-?'],
      ['psql', 'psql', '--version'],
    ]);
  });
});

describe('defaultCommandRunner', () => {
  it('runs the tool without a shell under the probe deadline and closes its stdin', async () => {
    const end = execFileAnswers((callback) => callback(null, 'v22.23.4\n', ''));

    await expect(defaultCommandRunner('node', ['-v'])).resolves.toStrictEqual({ ok: true, code: 0, stdout: 'v22.23.4\n', stderr: '' });
    expect(execFile).toHaveBeenCalledWith(
      'node',
      ['-v'],
      { encoding: 'utf8', shell: false, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Error, Partial<CommandResult>]>([
    ['a missing tool', Object.assign(new Error('spawn terraform ENOENT'), { code: 'ENOENT' }), { code: null, error: 'not found' }],
    ['a non-zero exit', Object.assign(new Error('Command failed: sqlcmd -?'), { code: 1, killed: false }), { code: 1 }],
    [
      'the probe deadline',
      Object.assign(new Error('Command failed: box version'), { code: null, killed: true, signal: 'SIGKILL' }),
      { code: null, error: `timed out after ${PROBE_TIMEOUT_MS} ms` },
    ],
    [
      'output over maxBuffer',
      Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }),
      { code: null, error: 'stdout maxBuffer length exceeded' },
    ],
    ['a permission failure', Object.assign(new Error('spawn /usr/bin/box EACCES'), { code: 'EACCES' }), { code: null, error: 'spawn /usr/bin/box EACCES' }],
  ])('reports %s with the output it produced', async (_name, error, expected) => {
    execFileAnswers((callback) => callback(error, 'partial out', 'partial err'));

    await expect(defaultCommandRunner('box', ['version'])).resolves.toStrictEqual({
      ok: false,
      stdout: 'partial out',
      stderr: 'partial err',
      ...expected,
    });
  });

  it('reports a synchronous execFile failure as an error result', async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new TypeError('The "file" argument must be of type string');
    });

    await expect(defaultCommandRunner('', [])).resolves.toStrictEqual({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'The "file" argument must be of type string',
    });
  });
});

describe('probeLocal', () => {
  it('records every probe once, in order, and passes when Node and npm match their pins', async () => {
    const r = rig({ at: LOCAL_AT });

    const { local, failed } = await probeLocal(r.deps);

    expect(failed).toEqual([]);
    expect(local.recordedAt).toBe(LOCAL_AT.toISOString());
    expect(r.runner.mock.calls).toEqual(LOCAL_PROBES.map((p) => [p.command, [...p.args]]));
    expect(brief(local.probes)).toEqual(LOCAL_PROBES.map((p) => ({ id: p.id, recorded: LOCAL_RECORDED[p.id], status: 'ok', detail: null })));
    expect(local.probes.map((row) => [row.label, row.source, row.planned])).toEqual(LOCAL_PROBES.map((p) => [p.label, p.probe, p.planned]));
  });

  it.each<[string, string, string, string | null]>([
    ['node', 'v22.22.0', 'Node.js', 'this process runs v22.23.4'],
    ['npm', '11.20.1', 'npm', null],
  ])('fails the phase with exit 1 naming %s when its version differs from the pin', async (id, version, label, detail) => {
    const local = { [id]: { stdout: `${version}\n` } };

    const result = await probeLocal(rig({ local }).deps);
    const outcome = await runEnvironment('local', rig({ local, at: LOCAL_AT }).deps);

    expect(result.failed).toEqual([id]);
    expect(probe(result.local, id)).toMatchObject({ recorded: version, status: 'mismatch', detail });
    expect(result.local.probes.filter((row) => row.status !== 'ok').map((row) => row.id)).toEqual([id]);
    expect(outcome).toEqual({
      code: 1,
      summary: {
        phase: 'local',
        status: 'deviation',
        deviations: [`${label} ${version} differs from the pinned ${PLANNED_PINS[id as 'node' | 'npm']}`],
        failed: [id],
        mysqlFallback: null,
        clusterSafe: null,
        startupWritersClosed: null,
        ping: null,
        timeZone: null,
      },
    });
  });

  it('fails the node probe when this process runs another Node than node -v reports', async () => {
    runningNode('v22.22.0');

    const { local, failed } = await probeLocal(rig().deps);

    expect(failed).toEqual(['node']);
    expect(probe(local, 'node')).toMatchObject({ recorded: PINNED_NODE, status: 'mismatch', detail: 'this process runs v22.22.0' });
  });

  it('stamps the phase with the system clock when no clock is injected', async () => {
    const before = Date.now();

    const { local } = await probeLocal({ ...rig().deps, now: undefined });

    expect(Date.parse(local.recordedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(local.recordedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('fails the phase when npm cannot be run', async () => {
    const { local, failed } = await probeLocal(rig({ local: { npm: NOT_FOUND } }).deps);

    expect(failed).toEqual(['npm']);
    expect(probe(local, 'npm')).toMatchObject({ recorded: null, status: 'unavailable', detail: 'not found' });
  });

  it('records a missing, failing or unrecognised unasserted tool without failing the phase', async () => {
    const r = rig({
      local: {
        terraform: NOT_FOUND,
        gcloud: { ok: false, code: 1, stdout: 'ERROR: (gcloud) unexpected failure\n' },
        sqlcmd: { ok: false, code: 1 },
        psql: { stdout: '' },
      },
    });

    const { local, failed } = await probeLocal(r.deps);

    expect(failed).toEqual([]);
    expect(probe(local, 'terraform')).toMatchObject({ recorded: null, status: 'unavailable', detail: 'not found' });
    expect(probe(local, 'gcloud')).toMatchObject({ recorded: null, status: 'unavailable', detail: 'unrecognised output (exit 1)' });
    expect(probe(local, 'sqlcmd')).toMatchObject({ recorded: LOCAL_RECORDED.sqlcmd, status: 'ok', detail: 'exit 1' });
    expect(probe(local, 'psql')).toMatchObject({ recorded: null, status: 'unavailable', detail: 'unrecognised output (exit 0)' });
  });

  it('flags unasserted pin mismatches without failing the phase', async () => {
    const r = rig({
      local: {
        terraform: { stdout: JSON.stringify({ terraform_version: '1.16.0' }) },
        'otelcol-contrib': { stdout: '', stderr: 'otelcol-contrib version v0.163.0\n' },
        gcloud: { stdout: JSON.stringify({ 'Google Cloud SDK': '591.0.0' }) },
        'java-coldfusion': { stderr: 'openjdk version "21.0.13" 2026-10-20\n' },
        psql: { stdout: 'psql (PostgreSQL) 15.8\n' },
      },
    });

    const { local, failed } = await probeLocal(r.deps);

    expect(failed).toEqual([]);
    expect(brief(local.probes.filter((row) => row.status !== 'ok'))).toEqual([
      { id: 'terraform', recorded: '1.16.0', status: 'mismatch', detail: null },
      { id: 'otelcol-contrib', recorded: 'v0.163.0', status: 'mismatch', detail: null },
      { id: 'java-coldfusion', recorded: 'openjdk version "21.0.13" 2026-10-20', status: 'mismatch', detail: null },
      { id: 'psql', recorded: '15.8', status: 'mismatch', detail: null },
    ]);
    expect(probe(local, 'gcloud')).toMatchObject({ recorded: 'Google Cloud SDK 591.0.0; pubsub-emulator not installed', status: 'ok' });
  });
});

describe('probeServices', () => {
  it('records ColdFusion, SQL Server, PostgreSQL and Mailpit versions over read-only connections it closes', async () => {
    const r = rig();

    const { services, failed } = await probeServices(r.deps);

    expect(failed).toEqual([]);
    expect(services.recordedAt).toBe(SERVICES_AT.toISOString());
    expect(brief(services.probes)).toEqual([
      { id: 'coldfusion', recorded: 'ColdFusion Server 2023,0,13,330833 (Developer)', status: 'ok', detail: null },
      { id: 'coldfusion-edition', recorded: 'Developer; expiration ', status: 'ok', detail: null },
      {
        id: 'cfpm',
        recorded: 'adminapi; administrator; caching; debugger; document; feed; image; mail; pdf; scheduler; spreadsheet; sqlserver; zip',
        status: 'ok',
        detail: null,
      },
      {
        id: 'sqlserver',
        recorded: 'Microsoft SQL Server 2022 (RTM-CU20) - 16.0.4305.5 (X64) Jun 30 2026 00:00:00 Express Edition (64-bit) on Linux (Ubuntu 25.10) <X64>',
        status: 'ok',
        detail: null,
      },
      { id: 'postgresql', recorded: PG_VERSION, status: 'ok', detail: null },
      { id: 'mailpit', recorded: 'v1.21.0', status: 'ok', detail: `at ${MAILPIT}` },
      { id: 'testbox', recorded: 'enabled true; installed true', status: 'ok', detail: null },
      { id: 'coldfusion-java', recorded: '17.0.12', status: 'ok', detail: null },
    ]);
    expect(r.fetch.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      [INFO_URL, 'GET'],
      [MAILPIT_INFO_URL, 'GET'],
    ]);
    expect(r.mssql.factory).toHaveBeenCalledWith(r.deps.env);
    expect(r.pg.factory).toHaveBeenCalledWith(r.deps.env);
    expect(r.mssql.statements).toEqual(['SELECT @@VERSION AS version', 'SELECT COUNT(*) AS n FROM tclustercommands']);
    expect(r.pg.statements).toEqual(['SELECT version() AS version']);
    expect([...r.mssql.statements, ...r.pg.statements].every((sql) => /^(SELECT|WITH)\b/i.test(sql))).toBe(true);
    expect(r.mssql.close).toHaveBeenCalledTimes(1);
    expect(r.pg.close).toHaveBeenCalledTimes(1);
    expect(r.runner).not.toHaveBeenCalled();
  });

  it('records the time zone, ping and a cluster-safe start-up guard, with native-tasks.json not captured', async () => {
    const { settings, failed } = await probeServices(rig().deps);

    expect(settings).toEqual(FIXTURE_SETTINGS);
    expect(failed).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, unknown[], Partial<EnvironmentSettings['cluster']>]>([
    [
      'broadcasting on with two peers',
      { cluster: cluster({ broadcastClusterCommands: true, broadcastCachePurges: true, broadcastAppreloads: true, peerCount: 2 }) },
      [{ n: 0 }],
      { broadcastingOff: false, noPeers: false, clusterSafe: false },
    ],
    [
      'three tclustercommands rows',
      {},
      [{ n: 3 }],
      { broadcastingOff: true, noPeers: true, tclustercommandsCount: 3, clusterSafe: false },
    ],
    [
      'unreadable cluster settings',
      { cluster: 'n/a' },
      [{ n: 0 }],
      { broadcastClusterCommands: null, peerCount: null, broadcastingOff: false, noPeers: false, clusterSafe: false },
    ],
    [
      'broadcasting on with no peers',
      { cluster: cluster({ broadcastClusterCommands: true, peerCount: 0 }) },
      [{ n: 0 }],
      { broadcastingOff: false, noPeers: true, clusterSafe: true },
    ],
    [
      'broadcasting off with two peers',
      { cluster: cluster({ peerCount: 2 }) },
      [{ n: 0 }],
      { broadcastingOff: true, noPeers: false, clusterSafe: true },
    ],
    [
      'string-typed flags and counts',
      { cluster: cluster({ broadcastClusterCommands: 'NO', broadcastCachePurges: 'yes', peerCount: '0' }) },
      [{ n: '0' }],
      { broadcastClusterCommands: false, broadcastCachePurges: true, peerCount: 0, tclustercommandsCount: 0, clusterSafe: true },
    ],
  ])('judges the start-up guard for %s', async (_name, patch, count, expected) => {
    const { settings } = await probeServices(rig({ routes: info(patch), sql: { count } }).deps);

    expect(settings.cluster).toMatchObject(expected);
  });

  it.each<[string, Record<string, unknown> | undefined, Partial<EnvironmentSettings['startup']>, string[]]>([
    ['an existing project site other than default', { projectSiteID: 'umbrella' }, { projectSiteID: 'umbrella' }, []],
    ['the default project site in another case', { projectSiteID: 'DEFAULT', projectSiteExists: false }, {}, []],
    ['a project site start-up would create', { projectSiteID: 'umbrella', projectSiteExists: false }, {}, ['projectSiteID umbrella names no existing site']],
    ['a present deploy bundle', { deployBundlePresent: true }, {}, ['deploy bundle present at /tmp/MuraBundle.zip']],
    ['plugin discovery on', { autoDiscoverPlugins: true }, {}, ['autoDiscoverPlugins is true']],
    ['DB updates on, as without MURA_APPLYDBUPDATES=false', { applyDbUpdates: true }, {}, ['applyDbUpdates is true']],
    ['a pending auto-update', { appAutoUpdated: true }, {}, ['appAutoUpdated is true']],
    [
      'themes declaring standard image sizes',
      { themeStandardImageSizes: ['default', 'tenant-a'] },
      { themeStandardImageSizes: ['default', 'tenant-a'] },
      ['themeStandardImageSizes: default, tenant-a'],
    ],
    ['string-typed flags', { projectSiteExists: 'yes', autoDiscoverPlugins: 'NO', applyDbUpdates: 'false' }, { projectSiteExists: true }, []],
    [
      'unreadable values',
      { projectSiteExists: 'maybe', themeStandardImageSizes: ['default', null] },
      { projectSiteExists: null, themeStandardImageSizes: null },
      ['projectSiteExists unreadable', 'themeStandardImageSizes unreadable'],
    ],
    [
      'an open bundle at an unreadable path and DB updates on',
      { deployBundlePath: undefined, deployBundlePresent: true, applyDbUpdates: true },
      { deployBundlePath: null },
      ['deployBundlePath unreadable', 'deploy bundle present at an unreadable path', 'applyDbUpdates is true'],
    ],
    [
      'no startup block',
      undefined,
      { projectSiteID: null, themeStandardImageSizes: null },
      [
        'projectSiteID unreadable',
        'projectSiteExists unreadable',
        'deployBundlePath unreadable',
        'deployBundlePresent unreadable',
        'autoDiscoverPlugins unreadable',
        'applyDbUpdates unreadable',
        'appAutoUpdated unreadable',
        'themeStandardImageSizes unreadable',
      ],
    ],
  ])('judges the start-up writer guards for %s', async (_name, patch, fields, openGuards) => {
    const { settings } = await probeServices(rig({ routes: info({ startup: patch === undefined ? undefined : startup(patch) }) }).deps);

    expect(settings.startup).toMatchObject({ ...fields, writersClosed: openGuards.length === 0, openGuards });
  });

  it.each<[string | undefined, string, boolean, string]>([
    ['mysql', 'mysql', true, 'the MySQL fallback is in use'],
    [undefined, 'unset', false, 'MURA_DBTYPE is unset'],
    ['PostgreSQL', 'postgresql', false, 'MURA_DBTYPE is postgresql'],
  ])('reports MURA_DBTYPE %s as a deviation that skips SQL Server and exits 4', async (dbtype, recorded, mysqlFallback, which) => {
    const r = rig({ env: { MURA_DBTYPE: dbtype } });

    const { services, settings, failed } = await probeServices(r.deps);
    const outcome = await runEnvironment('services', rig({ env: { MURA_DBTYPE: dbtype } }).deps);

    expect(r.mssql.factory).not.toHaveBeenCalled();
    expect(failed).toEqual([]);
    expect(probe(services, 'sqlserver')).toMatchObject({ recorded: null, status: 'unavailable', detail: `dbtype ${recorded}` });
    expect(settings).toMatchObject({
      dbtype: recorded,
      mysqlFallback,
      deviation: true,
      deviationReason: `${which}: ${DEVIATION_TAIL}`,
      cluster: { tclustercommandsCount: null, clusterSafe: false },
    });
    expect(outcome.code).toBe(4);
    expect(outcome.summary).toMatchObject({ status: 'deviation', deviations: [`${which}: ${DEVIATION_TAIL}`], mysqlFallback, clusterSafe: false });
  });

  it.each<[string, EnvLike, Record<string, () => Response>, string]>([
    ['an HTTP 500', {}, { [INFO_URL]: () => respond('<h1>Error</h1>', 500) }, `GET ${INFO_URL} answered HTTP 500`],
    ['a JSON array', {}, { [INFO_URL]: () => respond([RUN_INFO]) }, '/harness/legacy-baseline/cfml/run.cfm?info=1 did not answer a JSON object'],
    ['no legacy origin', { LEGACY_ORIGIN: undefined, PORT: undefined }, {}, 'LEGACY_ORIGIN or PORT must name the legacy ColdFusion origin'],
  ])('marks every run.cfm row unavailable and fails coldfusion on %s', async (_name, env, routes, detail) => {
    const r = rig({ env, routes });

    const { services, settings, failed } = await probeServices(r.deps);

    expect(failed).toEqual(['coldfusion']);
    for (const id of ['coldfusion', 'coldfusion-edition', 'cfpm', 'testbox', 'coldfusion-java']) {
      expect(probe(services, id)).toMatchObject({ recorded: null, status: 'unavailable', detail });
    }
    expect(settings).toMatchObject({
      timeZone: null,
      timeZoneMatchesProcess: false,
      ping: null,
      edition: null,
      cluster: { broadcastClusterCommands: null, peerCount: null, clusterSafe: false },
      startup: { projectSiteID: null, applyDbUpdates: null, writersClosed: false },
      versionMenu: null,
    });
  });

  it.each<[string, Record<string, unknown>, VersionMenu | null, string[]]>([
    ['a server.java version', { serverJavaVersion: '11.0.2' }, { ...FIXTURE_VERSION_MENU, javaVersion: '11.0.2' }, []],
    ['no server.os name', { osName: null, osVersion: null }, { ...FIXTURE_VERSION_MENU, osName: null, osVersion: null }, []],
    ['no database version', { dbProductVersion: undefined }, null, ['coldfusion']],
    ['an OS name that is no text', { osName: { name: 'UNIX' } }, { ...FIXTURE_VERSION_MENU, osName: null }, ['coldfusion']],
  ])('records the Version menu values for %s', async (_name, patch, expected, failedIds) => {
    const { settings, failed } = await probeServices(rig({ routes: info(patch) }).deps);

    expect(settings.versionMenu).toEqual(expected);
    expect(failed).toEqual(failedIds);
  });

  it.each<[string, Record<string, unknown>, string, Partial<ProbeRow>, string[]]>([
    [
      'no productVersion',
      { productVersion: undefined },
      'coldfusion',
      { status: 'unavailable', detail: 'no productVersion in the answer; run.cfm?info=1 lacks or mistypes: productVersion' },
      ['coldfusion'],
    ],
    ['another release', { productVersion: '2021,0,0,1' }, 'coldfusion', { status: 'mismatch', recorded: 'ColdFusion Server 2021,0,0,1 (Developer)', detail: null }, []],
    [
      'no name or level',
      { productName: undefined, productLevel: undefined },
      'coldfusion',
      { status: 'ok', recorded: 'ColdFusion 2023,0,13,330833 (level unknown)', detail: 'run.cfm?info=1 lacks or mistypes: productLevel' },
      ['coldfusion'],
    ],
    ['no edition', { edition: undefined }, 'coldfusion-edition', { status: 'unavailable', detail: 'no edition in the answer' }, ['coldfusion']],
    ['no expiration', { expiration: undefined }, 'coldfusion-edition', { status: 'ok', recorded: 'Developer; expiration none' }, []],
    [
      'a cfpm failure',
      { cfpmPackages: null, cfpmError: 'cfpm.sh: Permission denied' },
      'cfpm',
      { status: 'unavailable', detail: 'cfpm.sh: Permission denied' },
      [],
    ],
    ['no package list', { cfpmPackages: undefined }, 'cfpm', { status: 'unavailable', detail: 'no package list in the answer' }, ['coldfusion']],
    ['a null package list without cfpmError', { cfpmPackages: null }, 'cfpm', { status: 'unavailable', detail: 'no package list in the answer' }, ['coldfusion']],
    [
      'packages listed with versions, two missing',
      { cfpmPackages: ['adminapi 2023.0.13.330833', 'mail 2023.0.13.330833', 'scheduler 2023.0.13.330833'] },
      'cfpm',
      {
        status: 'mismatch',
        recorded: 'adminapi 2023.0.13.330833; mail 2023.0.13.330833; scheduler 2023.0.13.330833',
        detail: 'missing: spreadsheet, document',
      },
      [],
    ],
    [
      'an empty package list',
      { cfpmPackages: [] },
      'cfpm',
      { status: 'mismatch', recorded: 'none', detail: 'missing: spreadsheet, document, mail, scheduler' },
      [],
    ],
    [
      'no testbox flags',
      { testboxEnabled: undefined, testboxInstalled: undefined },
      'testbox',
      { status: 'unavailable', detail: 'no testbox flags in the answer' },
      ['coldfusion'],
    ],
    ['testbox disabled', { testboxEnabled: 'false' }, 'testbox', { status: 'mismatch', recorded: 'enabled false; installed true' }, []],
    ['no javaVersion', { javaVersion: undefined }, 'coldfusion-java', { status: 'unavailable', detail: 'no javaVersion in the answer' }, ['coldfusion']],
    ['a Java 8 runtime', { javaVersion: '1.8.0_402' }, 'coldfusion-java', { status: 'mismatch', recorded: '1.8.0_402' }, []],
    ['a javaVersion serialised as a number', { javaVersion: 17 }, 'coldfusion-java', { status: 'ok', recorded: '17' }, []],
  ])('records %s in the run.cfm rows', async (_name, patch, id, expected, failedIds) => {
    const { services, failed } = await probeServices(rig({ routes: info(patch) }).deps);

    expect(probe(services, id)).toMatchObject(expected);
    expect(failed).toEqual(failedIds);
  });

  const readable = { recorded: 'ColdFusion Server 2023,0,13,330833 (Developer)', status: 'ok' } as const;

  it.each<[string, Record<string, () => Response>, Partial<ProbeRow>]>([
    [
      'an empty object',
      { [INFO_URL]: () => respond({}) },
      {
        recorded: null,
        status: 'unavailable',
        detail:
          'no productVersion in the answer; run.cfm?info=1 lacks or mistypes: productVersion, productLevel, edition, javaVersion, dbProductName, dbProductVersion, serverJavaVersion, osName, osVersion, testboxEnabled, testboxInstalled, ping, siteMonitorTaskRegistered, timeZone, utcTotalOffset, cfpmPackages, cluster',
      },
    ],
    ['a ping that is no flag', info({ ping: 'maybe' }), { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: ping' }],
    ['a numeric time zone', info({ timeZone: 42 }), { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: timeZone' }],
    ['a non-integer utcTotalOffset', info({ utcTotalOffset: 'x' }), { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: utcTotalOffset' }],
    ['cluster settings that are no object', info({ cluster: 'n/a' }), { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: cluster' }],
    [
      'cluster settings with a non-flag and a non-integer peer count',
      info({ cluster: cluster({ broadcastAppreloads: 'sometimes', peerCount: 'many' }) }),
      { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: cluster.broadcastAppreloads, cluster.peerCount' },
    ],
    [
      'no siteMonitorTaskRegistered and a package line that is no text',
      info({ siteMonitorTaskRegistered: undefined, cfpmPackages: ['mail', { name: 'scheduler' }] }),
      { ...readable, detail: 'run.cfm?info=1 lacks or mistypes: siteMonitorTaskRegistered, cfpmPackages' },
    ],
  ])('fails coldfusion and names the malformed fields on %s', async (_name, routes, expected) => {
    const { services, failed } = await probeServices(rig({ routes }).deps);

    expect(failed).toEqual(['coldfusion']);
    expect(probe(services, 'coldfusion')).toMatchObject(expected);
  });

  it('flags SQL Server and PostgreSQL releases outside the plan without failing the phase', async () => {
    const r = rig({
      sql: { version: [{ version: 'Microsoft SQL Server 2019 (RTM) - 15.0.2000.5 (X64)' }] },
      pg: { rows: [{ version: 'PostgreSQL 15.8 on x86_64-pc-linux-gnu' }] },
    });

    const { services, failed } = await probeServices(r.deps);

    expect(failed).toEqual([]);
    expect(probe(services, 'sqlserver')).toMatchObject({ status: 'mismatch', recorded: 'Microsoft SQL Server 2019 (RTM) - 15.0.2000.5 (X64)' });
    expect(probe(services, 'postgresql')).toMatchObject({ status: 'mismatch', recorded: 'PostgreSQL 15.8 on x86_64-pc-linux-gnu' });
  });

  it.each<[string, SqlOptions, string, number]>([
    [
      'an unreachable server',
      { connectError: new Error('Failed to connect to 127.0.0.1:1433 - Could not connect (sequence)') },
      'Failed to connect to 127.0.0.1:1433 - Could not connect (sequence)',
      0,
    ],
    ['an empty @@VERSION answer', { version: [] }, 'SELECT @@VERSION returned no version', 1],
    ['a non-integer tclustercommands count', { count: [{ n: 'many' }] }, 'SELECT COUNT(*) FROM tclustercommands returned no count', 1],
  ])('fails sqlserver and leaves the cluster unsafe on %s', async (_name, sql, detail, closes) => {
    const r = rig({ sql });

    const { services, settings, failed } = await probeServices(r.deps);

    expect(failed).toEqual(['sqlserver']);
    expect(probe(services, 'sqlserver')).toMatchObject({ recorded: null, status: 'unavailable', detail });
    expect(settings.cluster).toMatchObject({ tclustercommandsCount: null, clusterSafe: false });
    expect(r.mssql.close).toHaveBeenCalledTimes(closes);
  });

  it.each<[string, PgOptions, string, number]>([
    ['an unreachable server', { connectError: new Error('connect ECONNREFUSED 127.0.0.1:5432') }, 'connect ECONNREFUSED 127.0.0.1:5432', 0],
    ['an empty version() answer', { rows: [] }, 'SELECT version() returned no version', 1],
  ])('fails postgresql on %s', async (_name, pg, detail, closes) => {
    const r = rig({ pg });

    const { services, failed } = await probeServices(r.deps);

    expect(failed).toEqual(['postgresql']);
    expect(probe(services, 'postgresql')).toMatchObject({ recorded: null, status: 'unavailable', detail });
    expect(r.pg.close).toHaveBeenCalledTimes(closes);
  });

  it.each<[string, () => Response, string]>([
    ['an HTTP 503', () => respond('unavailable', 503), `GET ${MAILPIT_INFO_URL} answered HTTP 503`],
    ['an answer without Version', () => respond({ Database: 'mailpit.db', Messages: 0 }), 'GET /api/v1/info answered no Version'],
  ])('fails mailpit on %s', async (_name, route, detail) => {
    const { services, failed } = await probeServices(rig({ routes: { [MAILPIT_INFO_URL]: route } }).deps);

    expect(failed).toEqual(['mailpit']);
    expect(probe(services, 'mailpit')).toMatchObject({ recorded: null, status: 'unavailable', detail });
  });

  it('reads Mailpit on 127.0.0.1:8025 when MAILPIT_API_URL is unset', async () => {
    const defaultInfo = 'http://127.0.0.1:8025/api/v1/info';
    const r = rig({ env: { MAILPIT_API_URL: undefined }, routes: { [defaultInfo]: () => respond(MAILPIT_INFO) } });

    const { services } = await probeServices(r.deps);

    expect(probe(services, 'mailpit')).toMatchObject({ recorded: 'v1.21.0', status: 'ok', detail: null });
    expect(r.fetch.mock.calls.map(([input]) => String(input))).toContain(defaultInfo);
  });

  it.each<[string, (dir: string) => Promise<EnvLike>, (dir: string) => unknown]>([
    [
      'a captured original ping',
      async (dir) => {
        await fs.writeFile(path.join(dir, 'native-tasks.json'), JSON.stringify({ originalPing: false, siteMonitorTask: null, tasks: [] }));
        return {};
      },
      () => ({ status: 'captured', originalPing: false, siteMonitorTask: null, detail: null }),
    ],
    [
      'a string ping and a siteMonitor task',
      async (dir) => {
        await fs.writeFile(
          path.join(dir, 'native-tasks.json'),
          JSON.stringify({ originalPing: 'true', siteMonitorTask: '/opt/masa/index.cfm/_api/sitemonitor/' }),
        );
        return {};
      },
      () => ({ status: 'captured', originalPing: true, siteMonitorTask: '/opt/masa/index.cfm/_api/sitemonitor/', detail: null }),
    ],
    [
      'a capture without a boolean ping',
      async (dir) => {
        await fs.writeFile(path.join(dir, 'native-tasks.json'), JSON.stringify({ tasks: [] }));
        return {};
      },
      (dir) => ({
        status: 'unreadable',
        originalPing: null,
        siteMonitorTask: null,
        detail: `${path.join(dir, 'native-tasks.json')} holds no boolean originalPing`,
      }),
    ],
    [
      'a capture that is not JSON',
      async (dir) => {
        await fs.writeFile(path.join(dir, 'native-tasks.json'), 'originalPing=false');
        return {};
      },
      (dir) => ({
        status: 'unreadable',
        originalPing: null,
        siteMonitorTask: null,
        detail: `${path.join(dir, 'native-tasks.json')} holds no boolean originalPing`,
      }),
    ],
    [
      'a capture path that is a directory',
      async (dir) => {
        await fs.mkdir(path.join(dir, 'native-tasks.json'));
        return {};
      },
      () => ({ status: 'unreadable', originalPing: null, siteMonitorTask: null, detail: expect.stringMatching(/EISDIR/) }),
    ],
    [
      'a pristine directory inside the checkout',
      async () => ({ OPT2_PRISTINE_DIR: path.join(REPO_ROOT, 'opt2', 'pristine') }),
      () => ({
        status: 'unreadable',
        originalPing: null,
        siteMonitorTask: null,
        detail: expect.stringMatching(/^OPT2_PRISTINE_DIR must be outside the repository checkout/),
      }),
    ],
  ])('records %s from native-tasks.json without failing the phase', async (_name, setup, expected) => {
    const env = await setup(pristine);

    const { settings, failed } = await probeServices(rig({ env }).deps);

    expect(settings.nativeTasks).toEqual(expected(pristine));
    expect(failed).toEqual([]);
  });
});

describe('mergeRecord', () => {
  const local: PhaseBlock = { recordedAt: LOCAL_AT.toISOString(), probes: [] };
  const services: PhaseBlock = { recordedAt: SERVICES_AT.toISOString(), probes: [] };
  const empty: EnvironmentRecord = { local: null, services: null, settings: null };

  it('keeps both phases whichever runs first', () => {
    const localFirst = mergeRecord(mergeRecord(empty, 'local', { local }), 'services', { services, settings: FIXTURE_SETTINGS });
    const servicesFirst = mergeRecord(mergeRecord(empty, 'services', { services, settings: FIXTURE_SETTINGS }), 'local', { local });

    expect(localFirst).toEqual({ local, services, settings: FIXTURE_SETTINGS });
    expect(servicesFirst).toEqual(localFirst);
  });

  it('replaces only the local block on a newer local run and leaves its inputs unmutated', () => {
    const existing: EnvironmentRecord = { local, services, settings: FIXTURE_SETTINGS };
    const newer: PhaseBlock = { recordedAt: '2026-07-01T08:00:00.000Z', probes: [] };
    const before = structuredClone(existing);

    const merged = mergeRecord(existing, 'local', { local: newer, services: null, settings: null });

    expect(merged.local).toBe(newer);
    expect(merged.services).toBe(services);
    expect(merged.settings).toBe(FIXTURE_SETTINGS);
    expect(existing).toEqual(before);
    expect(newer).toEqual({ recordedAt: '2026-07-01T08:00:00.000Z', probes: [] });
  });

  it('clears the blocks a phase owns when its result lacks them', () => {
    expect(mergeRecord({ local, services, settings: FIXTURE_SETTINGS }, 'services', {})).toEqual({ local, services: null, settings: null });
  });
});

describe('renderEnvironmentMarkdown and recordedSections', () => {
  const empty: EnvironmentRecord = { local: null, services: null, settings: null };

  it('renders the committed placeholder, below its title and Source SHA lines, when nothing is recorded', () => {
    const committed = COMMITTED_REPORT_TEXT.split('\n');

    const rendered = renderEnvironmentMarkdown(empty);

    expect(committed.slice(0, 3)).toEqual(['# Environment record', '', `Source SHA: ${PIN_SHA}`]);
    expect([...committed.slice(0, 3), ...rendered, '']).toEqual(committed);
    for (const key of ['local', 'services', 'settings'] as const) {
      expect(tableRows(rendered, HEADINGS[key]).length).toBeGreaterThan(0);
      expect(tableRows(rendered, HEADINGS[key]).every((line) => cells(line).at(-1) === 'pending-run')).toBe(true);
    }
    expect(section(rendered, HEADINGS.local)).toContain(
      'Not probed by `--phase local`: TypeScript 5.9.3 (pinned in `harness/package.json`; installed by `npm ci` after `--phase local`); provider hashicorp/google 8.9.0 (pinned in `infra/terraform/envs/plan/versions.tf`; selected by `terraform init`).',
    );
  });

  it('finds no recorded section in the committed placeholder', () => {
    expect(recordedSections(COMMITTED_REPORT_TEXT)).toEqual({});
  });

  it('round-trips recorded sections verbatim, from LF or CRLF text', async () => {
    const { local } = await probeLocal(rig({ at: LOCAL_AT }).deps);
    const { services, settings } = await probeServices(rig().deps);
    const lines = renderEnvironmentMarkdown({ local, services, settings });

    for (const text of [lines.join('\n'), `${lines.join('\r\n')}\r\n\r\n`]) {
      const found = recordedSections(text);
      expect(found).toEqual({
        local: section(lines, HEADINGS.local).slice(0, -1),
        services: section(lines, HEADINGS.services).slice(0, -1),
        settings: section(lines, HEADINGS.settings),
      });
      const again = renderEnvironmentMarkdown(empty, found);
      expect(again[0]).toBe('Status: recorded');
      expect(again[2]).toBe('Generated at: pending-run');
      expect(again.slice(3)).toEqual(lines.slice(3));
    }
    expect(lines.slice(0, 3)).toEqual([
      'Status: recorded',
      'Generated by: harness/src/baseline/environment.ts (--phase local, then --phase services)',
      `Generated at: ${SERVICES_AT.toISOString()}`,
    ]);
  });

  it('keeps only the recorded sections a partial report holds', () => {
    const lines = renderEnvironmentMarkdown({ local: null, services: null, settings: FIXTURE_SETTINGS });

    expect(recordedSections(section(lines, HEADINGS.settings).join('\n'))).toEqual({ settings: section(lines, HEADINGS.settings) });
    expect(recordedSections(lines.join('\n'))).toEqual({ settings: section(lines, HEADINGS.settings) });
  });

  it('writes mismatches, unavailable probes and escaped, collapsed values into the cells', () => {
    const base = { source: '`x`', planned: '—' };
    const record: EnvironmentRecord = {
      local: {
        recordedAt: LOCAL_AT.toISOString(),
        probes: [
          { ...base, id: 'node', label: 'Node.js', planned: '22.23.4', recorded: 'v22.22.0', status: 'mismatch', detail: 'this process runs v22.23.4' },
          { ...base, id: 'terraform', label: 'Terraform', recorded: null, status: 'unavailable', detail: 'not found' },
          { ...base, id: 'box', label: 'CommandBox', recorded: null, status: 'unavailable', detail: null },
          { ...base, id: 'sqlcmd', label: 'sqlcmd', recorded: 'a|b\n   c', status: 'ok', detail: null },
        ],
      },
      services: null,
      settings: null,
    };

    const lines = renderEnvironmentMarkdown(record);

    expect(tableRows(lines, HEADINGS.local)).toEqual([
      '| Node.js | `x` | 22.23.4 | v22.22.0 (mismatch: expected 22.23.4); this process runs v22.23.4 |',
      '| Terraform | `x` | — | unavailable: not found |',
      '| CommandBox | `x` | — | unavailable: no detail |',
      '| sqlcmd | `x` | — | a\\|b c |',
    ]);
    expect(lines[0]).toBe('Status: deviation');
    expect(lines[2]).toBe(`Generated at: ${LOCAL_AT.toISOString()}`);
  });

  it('renders the fixture settings as expected by the committed placeholder', () => {
    const lines = renderEnvironmentMarkdown({ ...empty, settings: FIXTURE_SETTINGS });

    expect(tableRows(lines, HEADINGS.settings).map((line) => [cells(line)[0], cells(line)[3]])).toEqual([
      ['Server time zone', 'America/New_York (utcTotalOffset 14400); process TZ America/New_York'],
      ['`ping` (original)', 'not captured: native-tasks.json absent'],
      ['`ping` (running)', 'false, read from `run.cfm?info=1`'],
      ['Native `siteMonitor` task present', 'captured: not captured; running (`cfschedule` list): none'],
      ['Cluster broadcasting', 'off (broadcastCachePurges false, broadcastAppreloads false)'],
      ['Cluster peers', 'none (0 other instances)'],
      ['`tclustercommands` row count', '0'],
      ['MySQL fallback used', 'no (`mssql`)'],
      ['Default hash algorithm', '`CFMX_COMPAT`'],
      ['Start-up guard verdict (`clusterSafe`)', 'true: the content units may become `target`-authoritative'],
      ['Project site (`ProjectSiteID`)', 'default (exists)'],
      ['Deploy bundle', 'absent at /tmp/MuraBundle.zip'],
      ['`autoDiscoverPlugins`', 'false'],
      ['`applyDbUpdates`', 'false'],
      ['`appAutoUpdated`', 'false'],
      ['Theme `small`, `medium` or `large` image sizes', 'none'],
      ['Start-up writers verdict (`writersClosed`)', 'true: application start-up runs none of these writers'],
    ]);
  });

  it.each<[string, (s: EnvironmentSettings) => EnvironmentSettings, string, string]>([
    ['an unknown time zone', (s) => ({ ...s, timeZone: null }), 'Server time zone', 'unavailable'],
    [
      'a process TZ that differs',
      (s) => ({ ...s, processTz: 'UTC', timeZoneMatchesProcess: false }),
      'Server time zone',
      'America/New_York (utcTotalOffset 14400); process TZ UTC, which differs',
    ],
    [
      'an unset process TZ',
      (s) => ({ ...s, processTz: null, timeZoneMatchesProcess: false }),
      'Server time zone',
      'America/New_York (utcTotalOffset 14400); process TZ unset, which differs',
    ],
    [
      'a captured original ping',
      (s) => ({ ...s, nativeTasks: { status: 'captured', originalPing: true, siteMonitorTask: 'siteMonitor', detail: null } }),
      '`ping` (original)',
      'true',
    ],
    [
      'an unreadable capture',
      (s) => ({ ...s, nativeTasks: { status: 'unreadable', originalPing: null, siteMonitorTask: null, detail: 'x holds no boolean originalPing' } }),
      '`ping` (original)',
      'unreadable: x holds no boolean originalPing',
    ],
    ['ping on', (s) => ({ ...s, ping: true }), '`ping` (running)', 'true, read from `run.cfm?info=1` (expected false)'],
    ['an unknown ping', (s) => ({ ...s, ping: null }), '`ping` (running)', 'unavailable'],
    [
      'a captured and running siteMonitor task',
      (s) => ({
        ...s,
        siteMonitorTaskRegistered: true,
        nativeTasks: { status: 'captured', originalPing: true, siteMonitorTask: 'siteMonitor', detail: null },
      }),
      'Native `siteMonitor` task present',
      'captured: siteMonitor; running (`cfschedule` list): registered',
    ],
    [
      'a capture without a task and no task list',
      (s) => ({
        ...s,
        siteMonitorTaskRegistered: null,
        nativeTasks: { status: 'captured', originalPing: false, siteMonitorTask: null, detail: null },
      }),
      'Native `siteMonitor` task present',
      'captured: none; running (`cfschedule` list): unavailable',
    ],
    [
      'broadcasting on',
      (s) => ({ ...s, cluster: { ...s.cluster, broadcastClusterCommands: true, broadcastCachePurges: true, broadcastAppreloads: true } }),
      'Cluster broadcasting',
      'on (broadcastCachePurges true, broadcastAppreloads true)',
    ],
    ['unknown broadcasting', (s) => ({ ...s, cluster: { ...s.cluster, broadcastClusterCommands: null } }), 'Cluster broadcasting', 'unavailable'],
    ['one peer', (s) => ({ ...s, cluster: { ...s.cluster, peerCount: 1 } }), 'Cluster peers', '1 other instance'],
    ['two peers', (s) => ({ ...s, cluster: { ...s.cluster, peerCount: 2 } }), 'Cluster peers', '2 other instances'],
    ['unknown peers', (s) => ({ ...s, cluster: { ...s.cluster, peerCount: null } }), 'Cluster peers', 'unavailable'],
    [
      'an uncounted tclustercommands on mssql',
      (s) => ({ ...s, cluster: { ...s.cluster, tclustercommandsCount: null } }),
      '`tclustercommands` row count',
      'unavailable',
    ],
    [
      'an uncounted tclustercommands on mysql',
      (s) => ({ ...s, dbtype: 'mysql', cluster: { ...s.cluster, tclustercommandsCount: null } }),
      '`tclustercommands` row count',
      'unavailable: dbtype mysql',
    ],
    [
      'the MySQL fallback',
      (s) => ({ ...s, dbtype: 'mysql', mysqlFallback: true, deviation: true, deviationReason: `the MySQL fallback is in use: ${DEVIATION_TAIL}` }),
      'MySQL fallback used',
      `yes (\`mysql\`): the MySQL fallback is in use: ${DEVIATION_TAIL}`,
    ],
    ['an unset hash algorithm', (s) => ({ ...s, defaultHashAlgorithm: null }), 'Default hash algorithm', 'unset'],
    [
      'an unsafe cluster',
      (s) => ({
        ...s,
        cluster: { ...s.cluster, broadcastingOff: false, noPeers: false, tclustercommandsCount: 3, clusterSafe: false },
      }),
      'Start-up guard verdict (`clusterSafe`)',
      'false (broadcasting not off and peers not ruled out; 3 tclustercommands rows): the content units stay `legacy`',
    ],
    [
      'an uncounted cluster',
      (s) => ({ ...s, cluster: { ...s.cluster, tclustercommandsCount: null, clusterSafe: false } }),
      'Start-up guard verdict (`clusterSafe`)',
      'false (tclustercommands not counted): the content units stay `legacy`',
    ],
    ['an unread project site', (s) => ({ ...s, startup: { ...s.startup, projectSiteID: null } }), 'Project site (`ProjectSiteID`)', 'unavailable'],
    [
      'a missing project site',
      (s) => ({ ...s, startup: { ...s.startup, projectSiteID: 'umbrella', projectSiteExists: false } }),
      'Project site (`ProjectSiteID`)',
      'umbrella (no such site)',
    ],
    [
      'an unread project site existence',
      (s) => ({ ...s, startup: { ...s.startup, projectSiteExists: null } }),
      'Project site (`ProjectSiteID`)',
      'default (existence unavailable)',
    ],
    [
      'a present deploy bundle at an unread path',
      (s) => ({ ...s, startup: { ...s.startup, deployBundlePresent: true, deployBundlePath: null } }),
      'Deploy bundle',
      'present at an unreadable path',
    ],
    ['an unread deploy bundle', (s) => ({ ...s, startup: { ...s.startup, deployBundlePresent: null } }), 'Deploy bundle', 'unavailable'],
    ['plugin discovery on', (s) => ({ ...s, startup: { ...s.startup, autoDiscoverPlugins: true } }), '`autoDiscoverPlugins`', 'true'],
    ['unread plugin discovery', (s) => ({ ...s, startup: { ...s.startup, autoDiscoverPlugins: null } }), '`autoDiscoverPlugins`', 'unavailable'],
    ['DB updates on', (s) => ({ ...s, startup: { ...s.startup, applyDbUpdates: true } }), '`applyDbUpdates`', 'true'],
    ['unread DB updates', (s) => ({ ...s, startup: { ...s.startup, applyDbUpdates: null } }), '`applyDbUpdates`', 'unavailable'],
    ['a pending auto-update', (s) => ({ ...s, startup: { ...s.startup, appAutoUpdated: true } }), '`appAutoUpdated`', 'true'],
    ['an unread auto-update', (s) => ({ ...s, startup: { ...s.startup, appAutoUpdated: null } }), '`appAutoUpdated`', 'unavailable'],
    [
      'themes declaring standard image sizes',
      (s) => ({ ...s, startup: { ...s.startup, themeStandardImageSizes: ['default', 'tenant-a'] } }),
      'Theme `small`, `medium` or `large` image sizes',
      'sites default, tenant-a',
    ],
    [
      'unread theme image sizes',
      (s) => ({ ...s, startup: { ...s.startup, themeStandardImageSizes: null } }),
      'Theme `small`, `medium` or `large` image sizes',
      'unavailable',
    ],
    [
      'open start-up writer guards',
      (s) => ({
        ...s,
        startup: { ...s.startup, applyDbUpdates: true, writersClosed: false, openGuards: ['applyDbUpdates is true', 'appAutoUpdated unreadable'] },
      }),
      'Start-up writers verdict (`writersClosed`)',
      'false (applyDbUpdates is true; appAutoUpdated unreadable): `up.sh` stops',
    ],
  ])('renders %s in the settings table', (_name, patch, label, expected) => {
    const lines = renderEnvironmentMarkdown({ local: null, services: null, settings: patch(FIXTURE_SETTINGS) });

    expect(recordedCell(lines, HEADINGS.settings, label)).toBe(expected);
  });
});

describe('runEnvironment', () => {
  it('records local then services into one report stamped with the pinned SHA and one state file', async () => {
    const localRig = rig({ at: LOCAL_AT });
    const servicesRig = rig({ at: SERVICES_AT });

    const first = await runEnvironment('local', localRig.deps);
    const second = await runEnvironment('services', servicesRig.deps);

    expect(first).toEqual({
      code: 0,
      summary: {
        phase: 'local',
        status: 'partial',
        deviations: [],
        failed: [],
        mysqlFallback: null,
        clusterSafe: null,
        startupWritersClosed: null,
        ping: null,
        timeZone: null,
      },
    });
    expect(second).toEqual({
      code: 0,
      summary: {
        phase: 'services',
        status: 'recorded',
        deviations: [],
        failed: [],
        mysqlFallback: false,
        clusterSafe: true,
        startupWritersClosed: true,
        ping: false,
        timeZone: 'America/New_York',
      },
    });
    expect(localRig.runner).toHaveBeenCalledTimes(LOCAL_PROBES.length);
    expect(localRig.fetch).not.toHaveBeenCalled();
    expect(servicesRig.runner).not.toHaveBeenCalled();

    const md = await readReport();
    expect(md.slice(0, 7)).toEqual([
      '# Environment record',
      `Source SHA: ${PIN_SHA}`,
      '',
      'Status: recorded',
      'Generated by: harness/src/baseline/environment.ts (--phase local, then --phase services)',
      `Generated at: ${SERVICES_AT.toISOString()}`,
      '',
    ]);
    expect(md.at(-1)).toBe('');
    expect(recordedCell(md, HEADINGS.local, 'Node.js')).toBe(PINNED_NODE);
    expect(recordedCell(md, HEADINGS.local, 'PostgreSQL client')).toBe('16.15');
    expect(recordedCell(md, HEADINGS.services, 'ColdFusion product version and level')).toBe('ColdFusion Server 2023,0,13,330833 (Developer)');
    expect(recordedCell(md, HEADINGS.services, 'Mailpit')).toBe(`v1.21.0; at ${MAILPIT}`);
    expect(recordedCell(md, HEADINGS.settings, '`ping` (original)')).toBe('not captured: native-tasks.json absent');
    expect(recordedCell(md, HEADINGS.settings, 'Start-up guard verdict (`clusterSafe`)')).toBe(
      'true: the content units may become `target`-authoritative',
    );

    const state = await readState();
    expect(Object.keys(state)).toEqual(['local', 'services', 'settings']);
    expect(state).toMatchObject({
      local: { recordedAt: LOCAL_AT.toISOString() },
      services: { recordedAt: SERVICES_AT.toISOString() },
      settings: { timeZone: 'America/New_York', ping: false, mysqlFallback: false, cluster: { clusterSafe: true } },
    });
    expect(state.settings).toEqual(FIXTURE_SETTINGS);
    expect((state.local as PhaseBlock).probes.map((row) => row.id)).toEqual(LOCAL_PROBES.map((p) => p.id));
  });

  it('keeps a recorded report section when the state file no longer holds its phase', async () => {
    await runEnvironment('local', rig({ at: LOCAL_AT }).deps);
    const localSection = section(await readReport(), HEADINGS.local);
    await removeState();

    const outcome = await runEnvironment('services', rig().deps);

    const md = await readReport();
    expect(section(md, HEADINGS.local)).toEqual(localSection);
    expect(md[3]).toBe('Status: recorded');
    expect(outcome.summary.status).toBe('recorded');
    expect(await readState()).toMatchObject({ local: null, settings: { cluster: { clusterSafe: true } } });
  });

  it.each<[string, 'local' | 'services', RigOptions, 'local' | 'services', string]>([
    ['a Node pin mismatch', 'local', { local: { node: { stdout: 'v22.22.0\n' } } }, 'services', 'Node.js pin mismatch in the preserved local record'],
    ['the MySQL fallback', 'services', { env: { MURA_DBTYPE: 'mysql' } }, 'local', 'MURA_DBTYPE deviation in the preserved settings record'],
  ])('reports %s that only the preserved report still shows', async (_name, firstPhase, firstRig, secondPhase, deviation) => {
    await runEnvironment(firstPhase, rig(firstRig).deps);
    await removeState();

    const outcome = await runEnvironment(secondPhase, rig().deps);

    expect(outcome.code).toBe(0);
    expect(outcome.summary).toMatchObject({ status: 'deviation', deviations: [deviation] });
    expect((await readReport())[3]).toBe('Status: deviation');
  });

  it.each<[string, 'local' | 'services', RigOptions, number, string[], boolean | null]>([
    ['an npm pin mismatch', 'local', { local: { npm: { stdout: '11.20.1\n' } } }, 1, ['npm'], null],
    ['an unreachable Mailpit', 'services', { routes: { [MAILPIT_INFO_URL]: () => respond('down', 503) } }, 1, ['mailpit'], false],
    [
      'the MySQL fallback with an unreachable Mailpit',
      'services',
      { env: { MURA_DBTYPE: 'mysql' }, routes: { [MAILPIT_INFO_URL]: () => respond('down', 503) } },
      4,
      ['mailpit'],
      true,
    ],
    ['an empty run.cfm answer', 'services', { routes: { [INFO_URL]: () => respond({}) } }, 1, ['coldfusion'], false],
    [
      'the MySQL fallback with an empty run.cfm answer',
      'services',
      { env: { MURA_DBTYPE: 'mysql' }, routes: { [INFO_URL]: () => respond({}) } },
      4,
      ['coldfusion'],
      true,
    ],
    ['all services on mssql', 'services', {}, 0, [], false],
  ])('exits with the code for %s', async (_name, phase, opts, code, failed, mysqlFallback) => {
    const outcome = await runEnvironment(phase, rig(opts).deps);

    expect(outcome.code).toBe(code);
    expect(outcome.summary).toMatchObject({ phase, failed, mysqlFallback });
  });

  it('names the fields a run.cfm answer mistypes in the report and keeps the rows it could read', async () => {
    const outcome = await runEnvironment('services', rig({ routes: info({ ping: 'maybe' }) }).deps);

    const md = await readReport();
    expect(outcome).toMatchObject({ code: 1, summary: { failed: ['coldfusion'], ping: null, timeZone: 'America/New_York' } });
    expect(recordedCell(md, HEADINGS.services, 'ColdFusion product version and level')).toBe(
      'ColdFusion Server 2023,0,13,330833 (Developer); run.cfm?info=1 lacks or mistypes: ping',
    );
    expect(recordedCell(md, HEADINGS.services, 'Java (ColdFusion runtime)')).toBe('17.0.12');
    expect(recordedCell(md, HEADINGS.settings, '`ping` (running)')).toBe('unavailable');
  });

  it('keeps a recorded MySQL deviation on a later local run, which exits on its own probes', async () => {
    await runEnvironment('services', rig({ env: { MURA_DBTYPE: 'mysql' } }).deps);

    const outcome = await runEnvironment('local', rig({ at: LOCAL_AT }).deps);

    expect(outcome).toEqual({
      code: 0,
      summary: {
        phase: 'local',
        status: 'deviation',
        deviations: [`the MySQL fallback is in use: ${DEVIATION_TAIL}`],
        failed: [],
        mysqlFallback: true,
        clusterSafe: false,
        startupWritersClosed: true,
        ping: false,
        timeZone: 'America/New_York',
      },
    });
  });

  it.each(['[1, 2]', 'not json'])('refuses a state file holding %s', async (text) => {
    await fs.mkdir(path.join(stateDir, 'baseline'), { recursive: true });
    await fs.writeFile(path.join(stateDir, 'baseline', 'environment.json'), text);

    await expect(runEnvironment('local', rig().deps)).rejects.toThrow(
      `${path.join(stateDir, 'baseline', 'environment.json')} does not hold a JSON object; remove it to record both phases afresh`,
    );
  });

  it('treats settings recorded without the start-up writer guards as unrecorded on a later local run', async () => {
    const stale: Partial<EnvironmentSettings> = structuredClone(FIXTURE_SETTINGS);
    delete stale.startup;
    await fs.mkdir(path.join(stateDir, 'baseline'), { recursive: true });
    await fs.writeFile(path.join(stateDir, 'baseline', 'environment.json'), JSON.stringify({ local: null, services: null, settings: stale }));

    const outcome = await runEnvironment('local', rig({ at: LOCAL_AT }).deps);

    expect(outcome).toMatchObject({ code: 0, summary: { status: 'partial', clusterSafe: null, startupWritersClosed: null } });
    expect(tableRows(await readReport(), HEADINGS.settings).every((line) => cells(line).at(-1) === 'pending-run')).toBe(true);
    expect(await readState()).toMatchObject({ settings: null });
  });
});

describe('environmentEnvSchema', () => {
  const UNSET: EnvironmentConfig = { MURA_DBTYPE: 'unset', MAILPIT_API_URL: 'http://127.0.0.1:8025', TZ: undefined, MURA_DEFAULTHASHALGORITHM: undefined };

  it.each<[string, EnvLike, EnvironmentConfig]>([
    ['nothing set as the defaults', {}, UNSET],
    ['empty values as unset', { MURA_DBTYPE: '', MAILPIT_API_URL: '', TZ: '', MURA_DEFAULTHASHALGORITHM: '' }, UNSET],
    [
      'set values, the database type lower-cased',
      { MURA_DBTYPE: 'MSSQL', MAILPIT_API_URL: MAILPIT, TZ: 'UTC', MURA_DEFAULTHASHALGORITHM: 'CFMX_COMPAT' },
      { MURA_DBTYPE: 'mssql', MAILPIT_API_URL: MAILPIT, TZ: 'UTC', MURA_DEFAULTHASHALGORITHM: 'CFMX_COMPAT' },
    ],
    ['whitespace values as set', { MURA_DBTYPE: ' ', TZ: ' ' }, { ...UNSET, MURA_DBTYPE: ' ', TZ: ' ' }],
  ])('parses %s', (_case, env, expected) => {
    expect(environmentEnvSchema.parse(env)).toEqual(expected);
  });

  it('gives the services probes an injected config in place of the variables of env', async () => {
    const r = rig({ env: { MURA_DBTYPE: 'mssql', TZ: 'America/New_York' } });

    const { settings } = await probeServices({ ...r.deps, config: environmentEnvSchema.parse({ MURA_DBTYPE: 'MySQL', TZ: 'UTC', MAILPIT_API_URL: MAILPIT }) });

    expect(settings).toMatchObject({ dbtype: 'mysql', mysqlFallback: true, processTz: 'UTC', defaultHashAlgorithm: null });
    expect(r.mssql.factory).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  it('parses the variables once and records the services phase from them', async () => {
    const parse = vi.spyOn(environmentEnvSchema, 'parse');
    const r = rig({ env: { MURA_DBTYPE: 'MySQL' } });

    const outcome = await main(['--phase', 'services'], r.deps);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(r.deps.env);
    expect(outcome).toMatchObject({ code: 4, summary: { phase: 'services', mysqlFallback: true } });
    parse.mockRestore();
  });

  it('prints one JSON summary line and exits 0 for --phase local', async () => {
    const r = rig({ at: LOCAL_AT });

    const { code, lines, exit } = await cli(['--phase', 'local'], r.deps);

    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      command: 'baseline:environment',
      ok: true,
      code: 0,
      phase: 'local',
      status: 'partial',
      deviations: [],
      failed: [],
      mysqlFallback: null,
      clusterSafe: null,
      startupWritersClosed: null,
      ping: null,
      timeZone: null,
    });
  });

  it.each<[string[], RegExp]>([
    [['--phase', 'cloud'], /^--phase must be local or services, got "cloud"$/],
    [[], /^--phase is required$/],
    [['--phase', 'local', '--verbose'], /Unknown option '--verbose'/],
  ])('rejects %j as a usage error with exit 2 and probes nothing', async (argv, message) => {
    const r = rig();

    const rejection = main(argv, r.deps);
    await expect(rejection).rejects.toThrow(UsageError);
    await expect(rejection).rejects.toThrow(message);
    const { code, lines } = await cli(argv, r.deps);

    expect(code).toBe(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      ok: false,
      code: 2,
      error: { type: 'UsageError' },
      usage: 'usage: tsx src/baseline/environment.ts --phase local|services',
    });
    expect(r.runner).not.toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('prints its help and exits 0 for --help without probing', async () => {
    const r = rig();

    const { code, lines } = await cli(['--help'], r.deps);

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('usage: tsx src/baseline/environment.ts --phase local|services\n')).toBe(true);
    expect(r.runner).not.toHaveBeenCalled();
  });
});
