// Unit tests for the `opt2-ops` CLI: argument parsing, help, the summary line and exit codes, with tracing, the context and the quiesce commands stubbed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateLogRecord } from '@opt2/platform/logging';
import { EnvValidationError } from '@opt2/platform/service-kit';
import { shutdownTracing, startTracing } from '@opt2/platform/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMigrationContext, type MigrationContext } from '../../src/context.js';
import { MIGRATION_ENVIRONMENT_HELP } from '../../src/env-help.js';
import { OwnerCallError } from '../../src/owners/index.js';
import { HELP, OpsUsageError, USAGE, main, parseOpsCommand, type OpsCommand, type OpsIo } from '../../src/quiesce/cli.js';
import {
  BackgroundCallError,
  DrainTimeoutError,
  InvocationsRunningError,
  MissingSubscriptionError,
  OrphanedWritesError,
  ResumeReconcileError,
  SeekVerificationError,
  drainAndSuspend,
  resume,
  seekSubscriptions,
  type DrainAndSuspendResult,
  type ResumeResult,
  type SeekResult,
} from '../../src/quiesce/index.js';

vi.mock('@opt2/platform/tracing', () => ({
  startTracing: vi.fn(async () => undefined),
  shutdownTracing: vi.fn(async () => undefined),
}));

vi.mock('../../src/context.js', () => ({ createMigrationContext: vi.fn() }));

vi.mock('../../src/quiesce/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/quiesce/index.js')>()),
  drainAndSuspend: vi.fn(),
  resume: vi.fn(),
  seekSubscriptions: vi.fn(),
}));

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_SOURCE = path.join(PACKAGE_DIR, 'src/quiesce/cli.ts');
const TO = '2026-06-30T00:00:00.000Z';
const PUSH_KEY = 'local-push-key-value';
const PUSH_ENDPOINT = `http://127.0.0.1:21815/internal/v1/events/communications.surveys.survey.scheduled.v1?key=${PUSH_KEY}`;
// Assembled at run time so no credential literal sits in source.
const SECRET = ['s3cr3t', 'ops', 'credential'].join('-');

const EMPTY_RECORD = { suspended: false, since: null, reason: null, pushConfigs: {}, pausedQueues: [], pausedTasks: [] };

const SUSPEND_RESULT: DrainAndSuspendResult = {
  alreadySuspended: false,
  drained: { owners: [{ owner: 'people', unpublished: 0, held: 0, pendingReceipts: 0 }], polls: 1, elapsedMs: 4 },
  finalDrained: { owners: [{ owner: 'people', unpublished: 0, held: 0, pendingReceipts: 0 }], polls: 2, elapsedMs: 1003 },
  pausedTasks: ['opt2-survey-41-launch'],
  pausedQueues: [{ service: 'people', queue: 'people-outbox-sweep' }],
  switchedToPull: ['timesheets.people.person.archived.v1'],
  record: {
    ...EMPTY_RECORD,
    suspended: true,
    since: TO,
    reason: 'drain-and-suspend',
    pushConfigs: { 'timesheets.people.person.archived.v1': { pushEndpoint: 'http://127.0.0.1:21818/internal/v1/events/x' } },
    pausedQueues: [{ service: 'people', queue: 'people-outbox-sweep' }],
    pausedTasks: ['opt2-survey-41-launch'],
  },
};

const RESUME_RESULT: ResumeResult = {
  resumed: true,
  restoredPush: ['timesheets.people.person.archived.v1'],
  resumedQueues: [{ service: 'people', queue: 'people-outbox-sweep' }],
  reconcile: [],
  restoredTasks: { siteMonitor: [], surveys: ['opt2-survey-41-launch'] },
  record: { ...EMPTY_RECORD, resumedAt: TO },
};

const SEEK_RESULT: SeekResult = { to: TO, subscriptions: [{ name: 'people.identity.group.changed.v1', sought: true, backlog: 0 }] };

const ctx = { close: vi.fn(async () => undefined) } as unknown as MigrationContext;

/** An io pair recording what `main` writes. */
function capture(): { io: OpsIo; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** The single JSON line `main` wrote to stdout. */
function summaryLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('');
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

/** The stderr lines, each parsed and validated against log-record.v1. */
function logRecords(stderr: string): Record<string, unknown>[] {
  return stderr
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
      return record;
    });
}

beforeEach(() => {
  vi.mocked(createMigrationContext).mockResolvedValue(ctx);
  vi.mocked(drainAndSuspend).mockResolvedValue(SUSPEND_RESULT);
  vi.mocked(resume).mockResolvedValue(RESUME_RESULT);
  vi.mocked(seekSubscriptions).mockResolvedValue(SEEK_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('parseOpsCommand', () => {
  it.each<[string[], OpsCommand]>([
    [['drain-and-suspend'], { kind: 'drain-and-suspend' }],
    [['resume'], { kind: 'resume' }],
    [['seek-subscriptions', '--to', '2026-06-30T00:00:00Z'], { kind: 'seek-subscriptions', to: TO }],
    [['seek-subscriptions', '--to=2026-06-30T05:30:00+05:30'], { kind: 'seek-subscriptions', to: TO }],
    [['--to', '2026-06-30T00:00:00.000Z', 'seek-subscriptions'], { kind: 'seek-subscriptions', to: TO }],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['resume', '--help'], { kind: 'help' }],
  ])('parses %j', (argv, expected) => {
    expect(parseOpsCommand(argv)).toEqual(expected);
  });

  it.each<[string[], RegExp]>([
    [[], /missing command/],
    [['bogus'], /unknown command "bogus"/],
    [['resume', 'now'], /unexpected argument "now"/],
    [['resume', '--force'], /--force/],
    [['seek-subscriptions'], /needs --to/],
    [['seek-subscriptions', '--to'], /--to/],
    [['seek-subscriptions', '--to', 'notadate'], /--to is not a time: "notadate"/],
    [['seek-subscriptions', '--to', ''], /--to is not a time/],
    [['drain-and-suspend', '--to', TO], /--to applies only to seek-subscriptions/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseOpsCommand(argv)).toThrow(OpsUsageError);
    expect(() => parseOpsCommand(argv)).toThrow(message);
  });
});

describe('HELP', () => {
  it('extends the usage with the migration environment, exit codes, documentation and an example', () => {
    expect(HELP.startsWith(USAGE)).toBe(true);
    expect(HELP).toContain(`\n${MIGRATION_ENVIRONMENT_HELP}Exit codes: 0 success, 1 failure (an invalid environment included), 2 usage error.\n`);
    expect(HELP.split('\n').slice(-4)).toEqual([
      'Documentation: migration/README.md, sections "Runtime forms" and "Environment".',
      'Example, from the repository root with the variables above exported:',
      '  node migration/dist/quiesce/cli.js seek-subscriptions --to 2026-06-30T00:00:00Z',
      '',
    ]);
  });
});

describe('main', () => {
  it('prints the help for --help without tracing or a context', async () => {
    const out = capture();
    await expect(main(['--help'], out.io)).resolves.toBe(0);
    expect(out.stdout()).toBe(HELP);
    expect(out.stderr()).toBe('');
    expect(startTracing).not.toHaveBeenCalled();
    expect(createMigrationContext).not.toHaveBeenCalled();
  });

  it('answers a usage error on stderr with exit code 2', async () => {
    const out = capture();
    await expect(main(['bogus'], out.io)).resolves.toBe(2);
    expect(out.stdout()).toBe('');
    expect(out.stderr()).toBe(`opt2-ops: unknown command "bogus"\n${USAGE}`);
    expect(startTracing).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ['drain-and-suspend'], run: drainAndSuspend, args: [ctx], result: SUSPEND_RESULT },
    { argv: ['resume'], run: resume, args: [ctx], result: RESUME_RESULT },
    { argv: ['seek-subscriptions', '--to', '2026-06-30T00:00:00Z'], run: seekSubscriptions, args: [ctx, TO], result: SEEK_RESULT },
  ])('runs $argv.0 and prints one summary line', async ({ argv, run, args, result }) => {
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(0);
    expect(summaryLine(out.stdout())).toEqual(JSON.parse(JSON.stringify({ command: argv[0], ok: true, ...result })));
    expect(out.stderr()).toBe('');
    expect(run).toHaveBeenCalledExactlyOnceWith(...args);
    expect(startTracing).toHaveBeenCalledExactlyOnceWith({ serviceName: 'opt2-ops', version: '1.0.0' });
    expect(vi.mocked(startTracing).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createMigrationContext).mock.invocationCallOrder[0] ?? 0,
    );
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it.each([
    {
      error: new DrainTimeoutError(5000, [
        { counts: { owner: 'people', unpublished: 2, held: 1, pendingReceipts: 0 }, role: { producer: true, consumer: false } },
      ]),
      details: { timeoutMs: 5000, owners: [{ owner: 'people', unpublished: 2, held: 1, pendingReceipts: 0 }] },
    },
    {
      error: new InvocationsRunningError(5000, [{ service: 'reporting', queue: 'reporting-export-run', running: 1 }]),
      details: { timeoutMs: 5000, queues: [{ service: 'reporting', queue: 'reporting-export-run', running: 1 }] },
    },
    {
      error: new OrphanedWritesError([
        { instanceId: 'gateway-dead', route: 'job:/_api/sitemonitor/', side: 'legacy', count: 1, oldestStartedAt: TO, orphaned: true },
      ]),
      details: {
        rows: [{ instanceId: 'gateway-dead', route: 'job:/_api/sitemonitor/', side: 'legacy', count: 1, oldestStartedAt: TO, orphaned: true }],
      },
    },
    { error: new MissingSubscriptionError(['timesheets.people.person.archived.v1']), details: { subscriptions: ['timesheets.people.person.archived.v1'] } },
    {
      error: new ResumeReconcileError([{ queue: 'people-outbox-sweep', service: 'people', ok: false, error: 'Service people unavailable (ECONNREFUSED)' }]),
      details: { failed: [{ queue: 'people-outbox-sweep', service: 'people', ok: false, error: 'Service people unavailable (ECONNREFUSED)' }] },
    },
    { error: new BackgroundCallError('backgroundSuspend', 409, { error: { message: 'busy' } }), details: { operation: 'backgroundSuspend', status: 409 } },
    {
      error: new OwnerCallError('people', 'GET', '/internal/v1/migration/position', 503, { secret: 'body' }),
      details: { owner: 'people', method: 'GET', status: 503 },
    },
    { error: new Error('plain failure'), details: {} },
  ])('reports $error.name by its type, safe message and fields, with exit code 1', async ({ error, details }) => {
    vi.mocked(drainAndSuspend).mockRejectedValueOnce(error);
    const out = capture();
    await expect(main(['drain-and-suspend'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({
      command: 'drain-and-suspend',
      ok: false,
      error: { type: error.name, message: '[REDACTED]', ...details },
    });
    expect(out.stdout()).not.toContain('body');
    const records = logRecords(out.stderr());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ severity: 'ERROR', error: { type: error.name, message: '[REDACTED]' } });
    expect(records[0]?.message).toMatch(/^opt2-ops drain-and-suspend failed/);
    expect(out.stderr()).not.toContain(error.message);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a connection string',
      error: new Error(`connect postgres://migration_app:${SECRET}@127.0.0.1:5432/masa_services failed`),
      summary: { type: 'Error', message: '[REDACTED]' },
      messages: ['opt2-ops drain-and-suspend failed'],
    },
    {
      name: 'a password in an upstream answer',
      error: new BackgroundCallError('backgroundSuspend', 500, { error: { message: `password=${SECRET}` } }),
      summary: { type: 'BackgroundCallError', message: '[REDACTED]', operation: 'backgroundSuspend', status: 500 },
      messages: ['opt2-ops drain-and-suspend failed (status=500 operation=backgroundSuspend)'],
    },
    {
      name: 'a credential in a chain error text',
      error: new ResumeReconcileError([{ queue: 'people-outbox-sweep', service: 'people', ok: false, error: `token ${SECRET} rejected` }]),
      summary: {
        type: 'ResumeReconcileError',
        message: '[REDACTED]',
        failed: [{ queue: 'people-outbox-sweep', service: 'people', ok: false, error: '[REDACTED]' }],
      },
      messages: ['opt2-ops drain-and-suspend failed'],
    },
    {
      name: 'a cause chain ending in node-mssql originalError',
      error: new Error(`login with ${SECRET} failed`, {
        cause: Object.assign(new Error(`socket for ${SECRET} closed`), {
          code: 'ESOCKET',
          originalError: Object.assign(new Error(`read ECONNRESET ${SECRET}`), { code: 'ECONNRESET', syscall: 'read' }),
        }),
      }),
      summary: {
        type: 'Error',
        message: '[REDACTED]',
        causes: [
          { type: 'Error', message: '[REDACTED]', code: 'ESOCKET' },
          { type: 'Error', message: 'read ECONNRESET', code: 'ECONNRESET' },
        ],
      },
      messages: ['opt2-ops drain-and-suspend failed', 'caused by (code=ESOCKET)', 'caused by (code=ECONNRESET)'],
    },
  ])('keeps $name out of stdout and stderr, printing its type and identifiers', async ({ error, summary, messages }) => {
    vi.stubEnv('OPT2_SERVICE_NAME', 'opt2-cli');
    try {
      vi.mocked(drainAndSuspend).mockRejectedValueOnce(error);
      const out = capture();
      await expect(main(['drain-and-suspend'], out.io)).resolves.toBe(1);
      expect(summaryLine(out.stdout())).toEqual({ command: 'drain-and-suspend', ok: false, error: summary });
      const records = logRecords(out.stderr());
      expect(records.map((record) => record.message)).toEqual(messages);
      expect(records[0]).toMatchObject({ severity: 'ERROR', service: 'opt2-cli', version: '1.0.0', error: { type: summary.type } });
      expect(`${out.stdout()}${out.stderr()}`).not.toContain(SECRET);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports a failed seek verification with the non-empty subscriptions', async () => {
    vi.mocked(seekSubscriptions).mockRejectedValueOnce(new SeekVerificationError(['people.identity.group.changed.v1']));
    const out = capture();
    await expect(main(['seek-subscriptions', '--to', TO], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toMatchObject({
      command: 'seek-subscriptions',
      ok: false,
      error: { type: 'SeekVerificationError', nonEmpty: ['people.identity.group.changed.v1'] },
    });
  });

  it('reports a context that cannot be built by the variables it names, with nothing to close', async () => {
    vi.mocked(createMigrationContext).mockRejectedValueOnce(new EnvValidationError(['MURA_DBHOST: is required', 'PG_PORT: Invalid input'], 'migration'));
    const out = capture();
    await expect(main(['resume'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({
      command: 'resume',
      ok: false,
      error: { type: 'EnvValidationError', message: 'migration: invalid environment (MURA_DBHOST: is required; PG_PORT: is invalid)' },
    });
    expect(resume).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it('reports a close failure after a success as the failure', async () => {
    vi.mocked(ctx.close).mockRejectedValueOnce(new Error('pool end failed'));
    const out = capture();
    await expect(main(['resume'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'resume', ok: false, error: { type: 'Error', message: '[REDACTED]' } });
  });

  it('keeps the command error when closing fails too', async () => {
    vi.mocked(resume).mockRejectedValueOnce(new BackgroundCallError('backgroundResume', 503, null));
    vi.mocked(ctx.close).mockRejectedValueOnce(new Error('pool end failed'));
    const out = capture();
    await expect(main(['resume'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toMatchObject({ ok: false, error: { type: 'BackgroundCallError', operation: 'backgroundResume', status: 503 } });
    expect(logRecords(out.stderr()).map((record) => record.message)).toEqual([
      'opt2-ops resume: closing the context failed',
      'opt2-ops resume failed (status=503 operation=backgroundResume)',
    ]);
    expect(out.stderr()).not.toContain('pool end failed');
  });

  it('keeps the exit code when the final span export fails, logging it as a warning', async () => {
    vi.mocked(shutdownTracing).mockRejectedValueOnce(new Error('export to http://127.0.0.1:4318/v1/traces failed'));
    const out = capture();
    await expect(main(['resume'], out.io)).resolves.toBe(0);
    expect(summaryLine(out.stdout())).toMatchObject({ command: 'resume', ok: true });
    const records = logRecords(out.stderr());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ severity: 'WARNING', message: 'opt2-ops: exporting traces failed', error: { type: 'Error', message: '[REDACTED]' } });
    expect(out.stderr()).not.toContain('/v1/traces');
  });

  it.each([
    { where: 'a failure message', code: 1, arrange: () => vi.mocked(drainAndSuspend).mockRejectedValueOnce(new Error(`modifyPushConfig ${PUSH_ENDPOINT} refused`)) },
    {
      where: 'a result field',
      code: 0,
      arrange: () =>
        vi.mocked(drainAndSuspend).mockResolvedValueOnce({
          ...SUSPEND_RESULT,
          record: { ...SUSPEND_RESULT.record, pushConfigs: { 'communications.surveys.survey.scheduled.v1': { pushEndpoint: PUSH_ENDPOINT } } },
        }),
    },
  ])('keeps the local push key of a URL query in $where out of every output', async ({ code, arrange }) => {
    arrange();
    const out = capture();
    await expect(main(['drain-and-suspend'], out.io)).resolves.toBe(code);
    const line = summaryLine(out.stdout());
    if (code === 0) expect(JSON.stringify(line)).toContain(PUSH_ENDPOINT.slice(0, PUSH_ENDPOINT.indexOf('?')));
    else expect(line).toEqual({ command: 'drain-and-suspend', ok: false, error: { type: 'Error', message: '[REDACTED]' } });
    expect(out.stdout()).not.toContain(PUSH_KEY);
    expect(out.stderr()).not.toContain(PUSH_KEY);
  });
});

describe('opt2-ops as a process', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the CLI source through tsx with no MURA_* or PG_* variables, as the entry module at `script`. */
  function runCli(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MURA_|PG_)/.test(key)));
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: PACKAGE_DIR, env, encoding: 'utf8' });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  it.each([
    { args: ['--help'], status: 0 },
    { args: ['bogus'], status: 2 },
    { args: ['seek-subscriptions'], status: 2 },
    { args: ['seek-subscriptions', '--to', 'notadate'], status: 2 },
  ])('exits $status for $args', ({ args, status }) => {
    const child = runCli(CLI_SOURCE, args);
    expect(child.status, child.stderr).toBe(status);
    if (status === 0) expect(child.stdout).toBe(HELP);
    else expect(child.stderr).toContain(USAGE);
  });

  it('runs through a symlinked bin path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opt2-ops-bin-'));
    dirs.push(dir);
    const link = path.join(dir, 'opt2-ops.ts');
    symlinkSync(CLI_SOURCE, link);
    const child = runCli(link, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(HELP);
  });
});
