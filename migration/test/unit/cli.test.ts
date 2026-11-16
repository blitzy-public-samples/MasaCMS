// Unit tests for the `opt2-migrate` CLI: argument parsing, dispatch, the summary line, redaction, exit codes and the entry check, with tracing,
// the context and every command module stubbed. opt2-ops and opt2-db have their own suites, quiesce-cli.test.ts and db-bootstrap-cli.test.ts.
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateLogRecord } from '@opt2/platform/logging';
import { shutdownTracing, startTracing } from '@opt2/platform/tracing';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { runBackfill, runFeed } from '../../src/apply/index.js';
import {
  DEFAULT_TRANSITION_POLL_MS,
  HELP,
  MigrateUsageError,
  USAGE,
  helpFor,
  main,
  parseCommand,
  usageFor,
  type MigrateCommand,
  type MigrateIo,
} from '../../src/cli.js';
import { createMigrationContext, type MigrationContext } from '../../src/context.js';
import { UnsupportedLegacyDatabaseError, migrationEnvSchema } from '../../src/env.js';
import { ExtractError } from '../../src/extract/stream.js';
import { FaultUsageError, runFault } from '../../src/faults/index.js';
import { buildFileManifest, transferFiles } from '../../src/files/index.js';
import { initLegacy } from '../../src/legacy/init-legacy.js';
import { ReconcileUsageError, runReconcile } from '../../src/reconcile/index.js';
import { RollbackSetMismatchError, computeRollbackSet, rebaselineRollbackSet, writeRollbackReport } from '../../src/rollback/index.js';
import { importSchedulerState, schedulerStatus } from '../../src/scheduler/index.js';
import { startServer } from '../../src/server.js';
import { SNAPSHOT_KINDS, dropSnapshot, restoreLiveFromSnapshot, takeSnapshot } from '../../src/snapshot/index.js';
import { requestTransition } from '../../src/transition/index.js';
import { completeWindowViaService, openWindowViaService, resolveWindowViaService } from '../../src/windows/index.js';

vi.mock('@opt2/platform/tracing', () => ({
  startTracing: vi.fn(async () => undefined),
  shutdownTracing: vi.fn(async () => undefined),
}));
vi.mock('../../src/context.js', () => ({ createMigrationContext: vi.fn() }));
vi.mock('../../src/server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server.js')>()),
  startServer: vi.fn(),
}));
vi.mock('../../src/legacy/init-legacy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/legacy/init-legacy.js')>()),
  initLegacy: vi.fn(),
}));
vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  takeSnapshot: vi.fn(),
  restoreLiveFromSnapshot: vi.fn(),
  dropSnapshot: vi.fn(),
}));
vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  runBackfill: vi.fn(),
  runFeed: vi.fn(),
}));
vi.mock('../../src/transition/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transition/index.js')>()),
  requestTransition: vi.fn(),
}));
vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  runReconcile: vi.fn(),
}));
vi.mock('../../src/rollback/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/rollback/index.js')>()),
  computeRollbackSet: vi.fn(),
  writeRollbackReport: vi.fn(),
  rebaselineRollbackSet: vi.fn(),
}));
vi.mock('../../src/faults/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/faults/index.js')>()),
  runFault: vi.fn(),
}));
vi.mock('../../src/windows/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/index.js')>()),
  openWindowViaService: vi.fn(),
  completeWindowViaService: vi.fn(),
  resolveWindowViaService: vi.fn(),
}));
vi.mock('../../src/scheduler/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/scheduler/index.js')>()),
  importSchedulerState: vi.fn(),
  schedulerStatus: vi.fn(),
}));
vi.mock('../../src/files/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/files/index.js')>()),
  buildFileManifest: vi.fn(),
  transferFiles: vi.fn(),
}));

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_SOURCE = path.join(PACKAGE_DIR, 'src/cli.ts');
const WINDOW_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const DB_SECRET = 'cli-test-db-password-value';
const BRIDGE_SECRET = 'cli-test-bridge-key-value';

const ctx = { close: vi.fn(async () => undefined) } as unknown as MigrationContext;

/** An io pair recording what `main` writes. */
function capture(): { io: MigrateIo; stdout: () => string; stderr: () => string } {
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

/** `value` as JSON round-trips it, for comparison with a printed line. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The lines of `text`, each parsed and asserted to be a valid log-record.v1 record. */
function logRecords(text: string): Record<string, unknown>[] {
  const lines = text.split('\n');
  expect(lines.at(-1)).toBe('');
  return lines.slice(0, -1).map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
    return record;
  });
}

/** An Error named `name` with `props` assigned, like a driver error. */
function driverError(name: string, message: string, props: Record<string, unknown>, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = name;
  return Object.assign(error, props);
}

// Secret-shaped test values, assembled at run time so no credential-like literal is committed.
const TOKEN_VALUE = ['abc', 'SECRET', '123'].join('');
const USER_PASSWORD = ['pw', 'Origin', '42'].join('-');

type AnyMock = Mock<(...args: unknown[]) => unknown>;

const TRANSITION = {
  transitionId: WINDOW_ID,
  fromVersion: 'v0001',
  toVersion: 'v0002',
  state: 'completed',
  step: 8,
  units: ['people.person'],
  frozenRoutes: [],
  startedAt: '2026-06-30T00:00:00.000Z',
  finishedAt: '2026-06-30T00:05:00.000Z',
};

beforeEach(() => {
  vi.mocked(createMigrationContext).mockResolvedValue(ctx);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('parseCommand', () => {
  it.each<[string[], MigrateCommand]>([
    [['serve'], { kind: 'serve' }],
    [['init-legacy'], { kind: 'init-legacy' }],
    [['snapshot', '--kind=workload'], { kind: 'snapshot', snapshotKind: 'workload' }],
    [['snapshot', 'restore', '--seq', '0'], { kind: 'snapshot restore', seq: 0 }],
    [['snapshot', 'drop', '--seq', '12'], { kind: 'snapshot drop', seq: 12 }],
    [['backfill', '--snapshot', '0'], { kind: 'backfill', snapshotSeq: 0 }],
    [['feed'], { kind: 'feed' }],
    [['feed', '--snapshot', '3'], { kind: 'feed', snapshotSeq: 3 }],
    [['transition', '--to', 'v0002'], { kind: 'transition', to: 'v0002', pollMs: DEFAULT_TRANSITION_POLL_MS }],
    [['transition', '--poll-ms', '250', '--to', 'v0003'], { kind: 'transition', to: 'v0003', pollMs: 250 }],
    [['transition', '--to', 'v0002', '--poll-ms', '2147483647'], { kind: 'transition', to: 'v0002', pollMs: 2_147_483_647 }],
    [['reconcile', '--point', 'after-backfill'], { kind: 'reconcile', point: 'after-backfill' }],
    [
      ['reconcile', '--point', 'post-cutover', '--units', 'people.person, identity.user_account'],
      { kind: 'reconcile', point: 'post-cutover', units: ['people.person', 'identity.user_account'] },
    ],
    [['rollback-set'], { kind: 'rollback-set' }],
    [['rollback', 'report'], { kind: 'rollback report' }],
    [['rollback', 'rebaseline'], { kind: 'rollback rebaseline' }],
    [['fault', 'projector-delay'], { kind: 'fault', name: 'projector-delay' }],
    [['fault', '--params', '{"delayMs":3000}', 'projector-delay'], { kind: 'fault', name: 'projector-delay', params: { delayMs: 3000 } }],
    [['resolve-window', WINDOW_ID], { kind: 'resolve-window', windowId: WINDOW_ID }],
    [['window', 'open', '--units', 'content.content'], { kind: 'window open', units: ['content.content'] }],
    [
      ['window', 'open', '--units', 'content.content,content.file', '--route', 'startup:legacy-start', '--scope', 'table'],
      { kind: 'window open', units: ['content.content', 'content.file'], routeKey: 'startup:legacy-start', scope: { table: true } },
    ],
    [['window', 'open', '--units', 'a.b', '--scope', '{"table":true}'], { kind: 'window open', units: ['a.b'], scope: { table: true } }],
    [
      ['window', 'open', '--units', 'a.b', '--scope', '{"keys":{"siteid":"tenant-a"}}'],
      { kind: 'window open', units: ['a.b'], scope: { keys: { siteid: 'tenant-a' } } },
    ],
    [['window', 'complete', WINDOW_ID, '--forwarded'], { kind: 'window complete', windowId: WINDOW_ID, forwarded: true }],
    [['window', 'complete', WINDOW_ID], { kind: 'window complete', windowId: WINDOW_ID, forwarded: false }],
    [['scheduler', 'import', '--file', '/state/native-tasks.json'], { kind: 'scheduler import', file: '/state/native-tasks.json' }],
    [['scheduler', 'status'], { kind: 'scheduler status' }],
    [['files', 'manifest', '--snapshot', '2'], { kind: 'files manifest', snapshotSeq: 2 }],
    [['files', 'transfer', '--snapshot', '2'], { kind: 'files transfer', snapshotSeq: 2 }],
    [['--help'], { kind: 'help', topic: null }],
    [['-h'], { kind: 'help', topic: null }],
    [['transition', '--help'], { kind: 'help', topic: 'transition' }],
    [['fault', '--help'], { kind: 'help', topic: 'fault' }],
    [['snapshot', 'restore', '-h'], { kind: 'help', topic: 'snapshot restore' }],
    [['window', '--help'], { kind: 'help', topic: 'window' }],
  ])('parses %j', (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });

  it.each(SNAPSHOT_KINDS)('accepts every snapshot kind of the snapshot module: %s', (kind) => {
    expect(parseCommand(['snapshot', '--kind', kind])).toEqual({ kind: 'snapshot', snapshotKind: kind });
  });

  it.each<[string[], RegExp]>([
    [[], /missing command/],
    [['nope'], /unknown command "nope"/],
    [['-x'], /unknown command "-x"/],
    [['rollback'], /rollback needs a subcommand/],
    [['files', '--snapshot', '1'], /files needs a subcommand/],
    [['rollback', 'bogus'], /unknown command "rollback bogus"/],
    [['serve', '--port', '1'], /--port/],
    [['init-legacy', 'extra'], /unexpected argument "extra"/],
    [['snapshot'], /--kind <value> is required/],
    [['snapshot', '--kind', 'manual'], /--kind must be one of seed, workload, transition, rebaseline, checkpoint, feed/],
    [['snapshot', '--kind'], /--kind/],
    [['snapshot', 'restore'], /--seq <value> is required/],
    [['snapshot', 'drop', '--seq=-1'], /--seq must be a non-negative integer, got "-1"/],
    [['backfill'], /--snapshot <value> is required/],
    [['backfill', '--snapshot', '1.5'], /--snapshot must be a non-negative integer/],
    [['backfill', '--snapshot', '99999999999999999999'], /--snapshot must be a non-negative integer/],
    [['feed', '--snapshot', 'x'], /--snapshot must be a non-negative integer/],
    [['feed', '--snapshot='], /--snapshot must not be empty/],
    [['transition'], /--to <value> is required/],
    [['transition', '--to', '3'], /--to must name a cut-over version vNNNN, got "3"/],
    [['transition', '--to', 'v0002', '--poll-ms', '0'], /--poll-ms must be a positive integer/],
    [['transition', '--to', 'v0002', '--poll-ms', '2147483648'], /--poll-ms must be a positive integer up to 2147483647, got "2147483648"/],
    [['reconcile'], /--point <value> is required/],
    [['reconcile', '--point', 'post-cutover', '--units', 'a.b,,c.d'], /--units must be a comma-separated list without empty items/],
    [['fault'], /fault needs <name>/],
    [['fault', 'a', 'b'], /unexpected argument "b"/],
    [['fault', 'projector-delay', '--params', '{bad'], /^--params is not valid JSON$/],
    [['resolve-window'], /resolve-window needs <windowId>/],
    [['resolve-window', ''], /<windowId> must not be empty/],
    [['window', 'open'], /--units <value> is required/],
    [['window', 'open', '--units', 'a.b', '--scope', 'rows'], /^--scope is not valid JSON$/],
    [['window', 'open', '--units', 'a.b', '--scope', '{"keys":{}}'], /--scope must be table/],
    [['window', 'open', '--units', 'a.b', '--scope', '{"keys":{"siteid":1}}'], /--scope must be table/],
    [['window', 'open', '--units', 'a.b', '--scope', '{"table":true,"keys":{"a":"b"}}'], /--scope must be table/],
    [['window', 'open', '--units', 'a.b', '--scope', 'null'], /--scope must be table/],
    [['window', 'complete'], /window complete needs <windowId>/],
    [['window', 'complete', WINDOW_ID, '--forwarded=yes'], /--forwarded/],
    [['scheduler', 'import'], /--file <value> is required/],
    [['files', 'manifest'], /--snapshot <value> is required/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(MigrateUsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });

  it('attaches the usage of the command or group to its usage error', () => {
    const usageOf = (argv: string[]): string | undefined => {
      try {
        parseCommand(argv);
      } catch (error) {
        return (error as MigrateUsageError).usage;
      }
      return undefined;
    };
    expect(usageOf(['transition', '--to', '3'])).toBe('opt2-migrate transition --to <vNNNN> [--poll-ms <ms>]\n');
    expect(usageOf(['window'])).toBe(usageFor('window'));
    expect(usageOf(['nope'])).toBe(USAGE);
  });
});

describe('usageFor', () => {
  it('lists every command once in the top-level usage', () => {
    const commands = USAGE.split('\n').filter((line) => line.startsWith('opt2-migrate '));
    // Twenty commands plus the help line.
    expect(commands).toHaveLength(21);
    expect(new Set(commands).size).toBe(commands.length);
    expect(USAGE).toContain('opt2-migrate snapshot --kind <seed|workload|transition|rebaseline|checkpoint|feed>');
  });

  it.each([
    { topic: 'window', lines: ['opt2-migrate window open --units <unit,...> [--route <key>] [--scope <table|json>]', 'opt2-migrate window complete <windowId> [--forwarded]'] },
    { topic: 'rollback', lines: ['opt2-migrate rollback report', 'opt2-migrate rollback rebaseline'] },
    { topic: 'rollback-set', lines: ['opt2-migrate rollback-set'] },
    { topic: 'snapshot', lines: [expect.stringMatching(/^opt2-migrate snapshot --kind/), 'opt2-migrate snapshot restore --seq <n>', 'opt2-migrate snapshot drop --seq <n>'] },
  ])('narrows to $topic', ({ topic, lines }) => {
    expect(usageFor(topic).split('\n').slice(0, -1)).toEqual(lines);
  });

  it('falls back to the whole usage for an unknown topic', () => {
    expect(usageFor('nope')).toBe(USAGE);
    expect(usageFor(null)).toBe(USAGE);
  });
});

describe('helpFor', () => {
  const exitCodes = USAGE.split('\n').find((line) => line.startsWith('Exit codes: '));
  const documentation = 'Documentation: migration/README.md, sections "Runtime forms" and "Environment".';

  it('opens the whole help with every command usage and closes it with exit codes, documentation and an example', () => {
    expect(helpFor(null)).toBe(HELP);
    expect(helpFor('nope')).toBe(HELP);
    expect(HELP.startsWith(USAGE.slice(0, USAGE.indexOf('\n\n') + 1))).toBe(true);
    expect(HELP.split('\n').slice(-5)).toEqual([
      exitCodes,
      documentation,
      'Example, from the repository root with the variables above exported:',
      '  node migration/dist/cli.js scheduler status',
      '',
    ]);
  });

  it('lists every variable of migrationEnvSchema in its Environment block', () => {
    const listed = HELP.split('\n').flatMap((line) => /^ {2}([A-Z][A-Z0-9_]*) /.exec(line)?.[1] ?? []);
    expect([...listed].sort()).toEqual(Object.keys(migrationEnvSchema.shape).sort());
  });

  it('names README sections that exist', () => {
    const headings = readFileSync(path.join(PACKAGE_DIR, 'README.md'), 'utf8')
      .split('\n')
      .flatMap((line) => /^#+ (.+)$/.exec(line)?.[1] ?? []);
    const sections = [...documentation.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(sections).toEqual(['Runtime forms', 'Environment']);
    for (const section of sections) expect(headings).toContain(section);
  });

  it.each(['window', 'snapshot restore', 'serve'])('extends the %s usage with the environment pointer, exit codes and documentation', (topic) => {
    const help = helpFor(topic);
    expect(help.startsWith(usageFor(topic))).toBe(true);
    expect(help.slice(usageFor(topic).length).split('\n')).toEqual([
      '',
      'Environment: the variables opt2-migrate --help lists, read before the command connects.',
      exitCodes,
      documentation,
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

  it('prints a command help for its --help', async () => {
    const out = capture();
    await expect(main(['window', 'open', '--help'], out.io)).resolves.toBe(0);
    expect(out.stdout()).toBe(helpFor('window open'));
  });

  it.each([
    { argv: ['nope'], stderr: `opt2-migrate: unknown command "nope"\n${USAGE}` },
    { argv: ['transition', '--to', '3'], stderr: `opt2-migrate: --to must name a cut-over version vNNNN, got "3"\n${usageFor('transition')}` },
    { argv: ['fault', 'x', '--params', `{"token": ${TOKEN_VALUE}}`], stderr: `opt2-migrate: --params is not valid JSON\n${usageFor('fault')}` },
    {
      argv: ['window', 'open', '--units', 'content.content', '--scope', `{"keys":{"userid": ${TOKEN_VALUE}}}`],
      stderr: `opt2-migrate: --scope is not valid JSON\n${usageFor('window open')}`,
    },
    { argv: ['init-legacy', `password=${TOKEN_VALUE}`], stderr: `opt2-migrate: unexpected argument "password=[REDACTED]"\n${usageFor('init-legacy')}` },
  ])('answers $argv on stderr with exit code 2', async ({ argv, stderr }) => {
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(2);
    expect(out.stdout()).toBe('');
    expect(out.stderr()).toBe(stderr);
    expect(out.stderr()).not.toContain(TOKEN_VALUE);
    expect(startTracing).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ['init-legacy'], fn: initLegacy, args: [ctx], result: { schema: 'opt2_sync', table: 'opt2_sync.projector_checkpoint' } },
    {
      argv: ['snapshot', '--kind', 'seed'],
      fn: takeSnapshot,
      args: [ctx, { kind: 'seed' }],
      result: { seq: 0, kind: 'seed', state: 'ready', takenAt: new Date('2026-06-30T00:00:00Z'), checkpointLsn: '42000000012300001' },
    },
    { argv: ['snapshot', 'restore', '--seq', '4'], fn: restoreLiveFromSnapshot, args: [ctx, 4], result: { seq: 4, database: 'muradb', durationMs: 10 } },
    { argv: ['snapshot', 'drop', '--seq', '4'], fn: dropSnapshot, args: [ctx, 4], result: { seq: 4, databaseDropped: true, backupDeleted: true, manifestRowsDeleted: 3 } },
    { argv: ['backfill', '--snapshot', '0'], fn: runBackfill, args: [ctx, { snapshotSeq: 0 }], result: { snapshotSeq: 0, tables: [], exitCode: 0 } },
    { argv: ['feed'], fn: runFeed, args: [ctx, {}], result: { snapshotSeq: 1, tables: [], exitCode: 0 } },
    { argv: ['feed', '--snapshot', '2'], fn: runFeed, args: [ctx, { snapshotSeq: 2 }], result: { snapshotSeq: 2, tables: [], exitCode: 0 } },
    { argv: ['transition', '--to', 'v0002', '--poll-ms', '5'], fn: requestTransition, args: [ctx, { to: 'v0002', pollMs: 5 }], result: TRANSITION },
    {
      argv: ['reconcile', '--point', 'post-cutover'],
      fn: runReconcile,
      args: [ctx, { point: 'post-cutover' }],
      result: { point: 'post-cutover', result: 'zero-difference', reportPath: '/r/post-cutover.json', exitCode: 0 },
    },
    {
      argv: ['reconcile', '--point', 'post-cutover', '--units', 'people.person'],
      fn: runReconcile,
      args: [ctx, { point: 'post-cutover', units: ['people.person'] }],
      result: { point: 'post-cutover', result: 'zero-difference', reportPath: '/r/post-cutover.json', exitCode: 0 },
    },
    { argv: ['rollback-set'], fn: computeRollbackSet, args: [ctx], result: { groups: ['g1'], units: ['people.person'] }, sync: true },
    { argv: ['rollback', 'report'], fn: writeRollbackReport, args: [ctx], result: { reportPath: '/r/rollback-rehearsal.md', result: 'pass', exitCode: 0 } },
    { argv: ['rollback', 'rebaseline'], fn: rebaselineRollbackSet, args: [ctx], result: { snapshotSeq: 9, units: ['people.person'] } },
    {
      argv: ['fault', 'duplicate-batch', '--params', '{"batch":2}'],
      fn: runFault,
      args: [ctx, 'duplicate-batch', { batch: 2 }],
      result: { name: 'duplicate-batch', outcome: 'passed', assertions: [], exitCode: 0 },
    },
    { argv: ['fault', 'forced-reinit'], fn: runFault, args: [ctx, 'forced-reinit', undefined], result: { name: 'forced-reinit', outcome: 'passed', exitCode: 0 } },
    { argv: ['resolve-window', WINDOW_ID], fn: resolveWindowViaService, args: [ctx, WINDOW_ID], result: { windowId: WINDOW_ID, state: 'closed', outcome: 'resolved' } },
    {
      argv: ['window', 'open', '--units', 'content.content'],
      fn: openWindowViaService,
      args: [ctx, { units: ['content.content'], routeKey: undefined, scope: undefined }],
      result: { windowId: WINDOW_ID, state: 'open', phase: 'executing' },
    },
    {
      argv: ['window', 'open', '--units', 'content.content', '--route', 'startup:legacy-start', '--scope', '{"keys":{"siteid":"default"}}'],
      fn: openWindowViaService,
      args: [ctx, { units: ['content.content'], routeKey: 'startup:legacy-start', scope: { keys: { siteid: 'default' } } }],
      result: { windowId: WINDOW_ID, state: 'open', phase: 'executing' },
    },
    { argv: ['window', 'complete', WINDOW_ID, '--forwarded'], fn: completeWindowViaService, args: [ctx, WINDOW_ID, { forwarded: true }], result: { state: 'closed' } },
    { argv: ['window', 'complete', WINDOW_ID], fn: completeWindowViaService, args: [ctx, WINDOW_ID, { forwarded: false }], result: { state: 'closed' } },
    { argv: ['window', 'complete', WINDOW_ID, '--forwarded'], fn: completeWindowViaService, args: [ctx, WINDOW_ID, { forwarded: true }], result: { state: 'import-pending' } },
    {
      argv: ['scheduler', 'import', '--file', '/state/native-tasks.json'],
      fn: importSchedulerState,
      args: [ctx, '/state/native-tasks.json'],
      result: { imported: true, reason: 'imported', nativeExisted: false, taskCount: 0 },
    },
    { argv: ['scheduler', 'status'], fn: schedulerStatus, args: [ctx], result: { stored: { nativeTasks: null }, live: { ping: false, tasks: [] } } },
    { argv: ['files', 'manifest', '--snapshot', '3'], fn: buildFileManifest, args: [ctx, 3], result: { snapshotSeq: 3, entries: 12, orphans: 1 } },
    { argv: ['files', 'transfer', '--snapshot', '3'], fn: transferFiles, args: [ctx, 3], result: { snapshotSeq: 3, transferred: 12, unchanged: 0 } },
  ])('runs $argv and prints one summary line', async ({ argv, fn, args, result, sync }) => {
    const mock = vi.mocked(fn) as unknown as AnyMock;
    if (sync === true) mock.mockReturnValueOnce(result);
    else mock.mockResolvedValueOnce(result);
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(0);
    const command = parseCommand(argv).kind;
    expect(summaryLine(out.stdout())).toEqual(asJson({ command, ok: true, ...result }));
    expect(out.stderr()).toBe('');
    expect(mock).toHaveBeenCalledExactlyOnceWith(...args);
    expect(startTracing).toHaveBeenCalledExactlyOnceWith({ serviceName: 'migration', version: '1.0.0' });
    expect(vi.mocked(startTracing).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createMigrationContext).mock.invocationCallOrder[0] ?? 0);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it.each([
    { argv: ['backfill', '--snapshot', '0'], fn: runBackfill, result: { snapshotSeq: 0, exitCode: 1 } },
    { argv: ['feed'], fn: runFeed, result: { snapshotSeq: 1, exitCode: 1 } },
    { argv: ['reconcile', '--point', 'after-backfill'], fn: runReconcile, result: { point: 'after-backfill', result: 'difference', exitCode: 1 } },
    { argv: ['fault', 'sql'], fn: runFault, result: { name: 'mssql-dropped-mid-extract', outcome: 'failed', exitCode: 1 } },
    { argv: ['rollback', 'report'], fn: writeRollbackReport, result: { result: 'fail', exitCode: 1 } },
    { argv: ['transition', '--to', 'v0002'], fn: requestTransition, result: { ...TRANSITION, state: 'aborted', step: 6 } },
    { argv: ['window', 'complete', WINDOW_ID], fn: completeWindowViaService, result: { state: 'unknown' } },
  ])('exits 1 with ok false when $argv.0 completes with a failing verdict', async ({ argv, fn, result }) => {
    vi.mocked(fn as unknown as AnyMock).mockResolvedValueOnce(result);
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual(asJson({ command: parseCommand(argv).kind, ok: false, ...result }));
  });

  const ROW_TEXT = 'row {"userid":"U-7Q9Z","fname":"Ada","lname":"Lovelace"} does not apply';
  const FAULT_RECONCILIATION = { point: 'after-fault-x', result: 'difference', reportPath: '/r/after-fault-x.json' };
  it.each([
    {
      name: 'an aborted transition',
      argv: ['transition', '--to', 'v0002'],
      fn: requestTransition,
      code: 1,
      result: { ...TRANSITION, state: 'aborted', step: 3, error: { step: 3, message: ROW_TEXT } },
      expected: { ...TRANSITION, state: 'aborted', step: 3, error: { step: 3, message: '[REDACTED]' } },
    },
    {
      name: 'a failed fault with a run error and an assertion error text',
      argv: ['fault', 'window-import-interrupted'],
      fn: runFault,
      code: 1,
      result: {
        name: 'window-import-interrupted',
        outcome: 'failed',
        assertions: [
          { name: 'import-pending', status: 'fail', detail: { windowId: WINDOW_ID, error: ROW_TEXT }, reason: 'the window could not be read' },
          { name: 'read-not-superseded', status: 'skipped', reason: 'reads route to legacy' },
        ],
        error: { phase: 'run', message: `RequestError: ${ROW_TEXT}` },
        reconciliation: FAULT_RECONCILIATION,
        exitCode: 1,
      },
      expected: {
        name: 'window-import-interrupted',
        outcome: 'failed',
        assertions: [
          { name: 'import-pending', status: 'fail', detail: { windowId: WINDOW_ID, error: '[REDACTED]' }, reason: 'the window could not be read' },
          { name: 'read-not-superseded', status: 'skipped', reason: 'reads route to legacy' },
        ],
        error: { phase: 'run', message: '[REDACTED]' },
        reconciliation: FAULT_RECONCILIATION,
        exitCode: 1,
      },
    },
    {
      name: 'a failed fault with error objects, Error-suffixed keys, failedAfterRestart and stderrTail',
      argv: ['fault', 'service-restarted-mid-apply'],
      fn: runFault,
      code: 1,
      result: {
        name: 'service-restarted-mid-apply',
        outcome: 'failed',
        assertions: [
          {
            name: 'guard-triggered',
            status: 'fail',
            detail: { outcome: null, error: { name: 'RequestError', message: ROW_TEXT, stack: `RequestError: ${ROW_TEXT}\n    at run (frame-file.js:1:1)`, number: 2627, ratio: 0.5, retried: false, rows: [ROW_TEXT], note: ROW_TEXT } },
          },
          { name: 'interrupted', status: 'pass', detail: { acknowledged: 2, failedAfterRestart: ROW_TEXT, completeError: ROW_TEXT } },
          { name: 'killed-mid-run', status: 'fail', detail: { exitCode: 1, signal: null, stderrTail: `${ROW_TEXT}\n` } },
        ],
        exitCode: 1,
      },
      expected: {
        name: 'service-restarted-mid-apply',
        outcome: 'failed',
        assertions: [
          { name: 'guard-triggered', status: 'fail', detail: { outcome: null, error: { name: 'RequestError', message: '[REDACTED]', number: 2627, ratio: 0.5, retried: false } } },
          { name: 'interrupted', status: 'pass', detail: { acknowledged: 2, failedAfterRestart: '[REDACTED]', completeError: '[REDACTED]' } },
          { name: 'killed-mid-run', status: 'fail', detail: { exitCode: 1, signal: null, stderrTail: '[REDACTED]' } },
        ],
        exitCode: 1,
      },
    },
    {
      name: 'a failed fault whose errors are fixed safe texts',
      argv: ['fault', 'projector-delay'],
      fn: runFault,
      code: 1,
      result: {
        name: 'projector-delay',
        outcome: 'failed',
        assertions: [{ name: 'toggled', status: 'fail', detail: { action: 'set', error: 'Service people unavailable (ECONNREFUSED)', status: 503 } }],
        error: { phase: 'resume', message: 'connect ECONNREFUSED' },
        exitCode: 1,
      },
      expected: {
        name: 'projector-delay',
        outcome: 'failed',
        assertions: [{ name: 'toggled', status: 'fail', detail: { action: 'set', error: 'Service people unavailable (ECONNREFUSED)', status: 503 } }],
        error: { phase: 'resume', message: 'connect ECONNREFUSED' },
        exitCode: 1,
      },
    },
    {
      name: 'a passed fault whose passing assertion carries the caught error',
      argv: ['fault', 'mssql-dropped-mid-extract'],
      fn: runFault,
      code: 0,
      result: {
        name: 'mssql-dropped-mid-extract',
        outcome: 'passed',
        assertions: [{ name: 'dropped-mid-extract', status: 'pass', detail: { rowsSeen: 40, droppedDatabase: 'muradb_opt2_snap_3', error: ROW_TEXT } }],
        reconciliation: { ...FAULT_RECONCILIATION, result: 'zero-difference' },
        exitCode: 0,
      },
      expected: {
        name: 'mssql-dropped-mid-extract',
        outcome: 'passed',
        assertions: [{ name: 'dropped-mid-extract', status: 'pass', detail: { rowsSeen: 40, droppedDatabase: 'muradb_opt2_snap_3', error: '[REDACTED]' } }],
        reconciliation: { ...FAULT_RECONCILIATION, result: 'zero-difference' },
        exitCode: 0,
      },
    },
    {
      name: 'a snapshot with the fields the harness reads',
      argv: ['snapshot', '--kind', 'feed'],
      fn: takeSnapshot,
      code: 0,
      result: { seq: 5, kind: 'feed', state: 'ready', manifestComplete: true, fileStore: { status: 'ok', objects: 12 } },
      expected: { seq: 5, kind: 'feed', state: 'ready', manifestComplete: true, fileStore: { status: 'ok', objects: 12 } },
    },
    {
      name: 'a backfill whose file units halted',
      argv: ['backfill', '--snapshot', '0'],
      fn: runBackfill,
      code: 0,
      result: { snapshotSeq: 0, files: { status: 'halted', reason: 'Legacy file store "s3" of site default is not fileDir' }, reconciliation: { point: 'after-backfill', result: 'zero-difference', reportPath: '/r/after-backfill.json' }, exitCode: 0 },
      expected: { snapshotSeq: 0, files: { status: 'halted', reason: 'Legacy file store "s3" of site default is not fileDir' }, reconciliation: { point: 'after-backfill', result: 'zero-difference', reportPath: '/r/after-backfill.json' }, exitCode: 0 },
    },
  ])('prints $name with error payloads only as safe metadata', async ({ argv, fn, code, result, expected }) => {
    vi.mocked(fn as unknown as AnyMock).mockResolvedValueOnce(result);
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(code);
    expect(summaryLine(out.stdout())).toEqual(asJson({ command: parseCommand(argv).kind, ok: code === 0, ...expected }));
    expect(out.stderr()).toBe('');
    for (const part of ['Lovelace', 'U-7Q9Z', 'Ada', 'userid', 'frame-file']) expect(out.stdout()).not.toContain(part);
  });

  it('keeps command and ok first and unchanged when the result has fields of those names', async () => {
    vi.mocked(runBackfill).mockResolvedValueOnce({ command: 'other', ok: true, exitCode: 1 } as never);
    const out = capture();
    await expect(main(['backfill', '--snapshot', '0'], out.io)).resolves.toBe(1);
    const [line = ''] = out.stdout().split('\n');
    expect(line).toBe('{"command":"backfill","ok":false,"exitCode":1}');
  });

  it('prints bigint values as decimal strings', async () => {
    vi.mocked(dropSnapshot).mockResolvedValueOnce({ seq: 1, lsn: 12345678901234567890n } as never);
    const out = capture();
    await expect(main(['snapshot', 'drop', '--seq', '1'], out.io)).resolves.toBe(0);
    expect(summaryLine(out.stdout())).toMatchObject({ lsn: '12345678901234567890' });
  });

  it.each([
    { error: new RollbackSetMismatchError('R differs from v0003 rollbackRefs', ['g1'], ['g2'], ['g2']), code: 1, message: '[REDACTED]' },
    { error: new Error('plain failure'), code: 1, message: '[REDACTED]' },
    { error: new FaultUsageError('nope', 'unknown fault'), code: 2, message: 'Fault "nope": unknown fault' },
    { error: new ReconcileUsageError('Unknown point nope'), code: 2, message: 'Unknown point nope' },
  ])('reports $error.name with exit code $code', async ({ error, code, message }) => {
    vi.mocked(computeRollbackSet).mockImplementationOnce(() => {
      throw error;
    });
    const out = capture();
    await expect(main(['rollback-set'], out.io)).resolves.toBe(code);
    expect(summaryLine(out.stdout())).toEqual({ command: 'rollback-set', ok: false, error: { type: error.name, message } });
    const [record, ...others] = logRecords(out.stderr());
    expect(others).toEqual([]);
    expect(record).toMatchObject({ severity: 'ERROR', message: 'opt2-migrate rollback-set failed', error: { type: error.name, message: '[REDACTED]' } });
    expect(out.stderr()).not.toContain(error.message);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'a database password', text: `Login failed for user 'sa' with password ${DB_SECRET}`, hidden: [DB_SECRET, 'Login failed'] },
    { name: 'URL userinfo', text: `fetch http://operator:${USER_PASSWORD}@127.0.0.1:1/_api/ failed`, hidden: [USER_PASSWORD, 'operator:'] },
    { name: 'an email address', text: 'duplicate key for ops.lead@example.com', hidden: ['ops.lead@example.com', 'duplicate key'] },
    { name: 'a row excerpt', text: 'row {"userid":"A1B2","fname":"Ada","lname":"Lovelace"} does not apply', hidden: ['Lovelace', 'userid'] },
    { name: 'a CSRF token', text: `csrf_token=${TOKEN_VALUE} was refused`, hidden: [TOKEN_VALUE, 'refused'] },
  ])('prints none of a failure text holding $name', async ({ text, hidden }) => {
    vi.stubEnv('MURA_DBPASSWORD', DB_SECRET);
    vi.mocked(initLegacy).mockRejectedValueOnce(new Error(text, { cause: new Error(text) }));
    const out = capture();
    await expect(main(['init-legacy'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({
      command: 'init-legacy',
      ok: false,
      error: { type: 'Error', message: '[REDACTED]', causes: [{ type: 'Error', message: '[REDACTED]' }] },
    });
    expect(logRecords(out.stderr()).map((record) => record.message)).toEqual(['opt2-migrate init-legacy failed', 'caused by']);
    for (const part of hidden) {
      expect(out.stdout()).not.toContain(part);
      expect(out.stderr()).not.toContain(part);
    }
  });

  it('reports the cause chain and identifiers of a dropped SQL Server connection', async () => {
    const reset = driverError('Error', 'read ECONNRESET', { code: 'ECONNRESET', syscall: 'read', errno: -104 });
    const socket = driverError('ConnectionError', 'Connection lost - read ECONNRESET', { code: 'ESOCKET' }, reset);
    // node-mssql keeps the tedious error as an enumerable `originalError`, not as `cause`.
    const pool = driverError('ConnectionError', 'Connection lost - read ECONNRESET', { code: 'ESOCKET', originalError: socket });
    const error = new ExtractError('cannot read the catalog of tcontent', { database: 'muradb_opt2_snap_3', table: 'tcontent', cause: pool });
    vi.mocked(runFeed).mockRejectedValueOnce(error);
    const out = capture();
    await expect(main(['feed'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({
      command: 'feed',
      ok: false,
      error: {
        type: 'ExtractError',
        message: '[REDACTED]',
        database: 'muradb_opt2_snap_3',
        table: 'tcontent',
        causes: [
          { type: 'ConnectionError', message: '[REDACTED]', code: 'ESOCKET' },
          { type: 'ConnectionError', message: 'read ECONNRESET', code: 'ESOCKET' },
          { type: 'Error', message: 'read ECONNRESET', code: 'ECONNRESET' },
        ],
      },
    });
    const records = logRecords(out.stderr());
    expect(records.map((record) => record.message)).toEqual([
      'opt2-migrate feed failed (database=muradb_opt2_snap_3 table=tcontent)',
      'caused by (code=ESOCKET)',
      'caused by (code=ESOCKET)',
      'caused by (code=ECONNRESET)',
    ]);
    expect(records.map((record) => (record.error as { type: string }).type)).toEqual(['ExtractError', 'ConnectionError', 'ConnectionError', 'Error']);
    expect(out.stderr()).not.toContain('cannot read the catalog');
    expect(out.stderr()).not.toContain('Connection lost');
  });

  it.each([
    { name: 'a cyclic chain once', length: 2, cyclic: true, causes: 1 },
    { name: 'at most eight causes', length: 12, cyclic: false, causes: 8 },
  ])('follows $name', async ({ length, cyclic, causes }) => {
    const chain = Array.from({ length }, (_item, index) => driverError('Error', `link ${String(index)}`, { code: `E${String(index)}` }));
    chain.forEach((link, index) => Object.assign(link, { cause: chain[index + 1] ?? (cyclic ? chain[0] : undefined) }));
    vi.mocked(schedulerStatus).mockRejectedValueOnce(chain[0]);
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect((summaryLine(out.stdout()).error as { causes: unknown[] }).causes).toHaveLength(causes);
    expect(logRecords(out.stderr())).toHaveLength(causes + 1);
  });

  it.each([
    { name: 'HTTP status and operation', props: { operation: 'windowComplete', status: 409, body: { rows: ['Lovelace'] } }, kept: { operation: 'windowComplete', status: 409 } },
    { name: 'SQL Server error number', props: { code: 'EREQUEST', number: 3701, lineNumber: 1 }, kept: { code: 'EREQUEST', number: 3701 } },
    {
      name: 'only identifier-shaped values',
      props: { database: 'db name', table: `token=${TOKEN_VALUE}`, owner: 'people', method: 'POST', path: '/internal/v1/x?y=1', status: 1.5 },
      kept: { owner: 'people', method: 'POST' },
    },
  ])('keeps $name of an error', async ({ props, kept }) => {
    vi.mocked(schedulerStatus).mockRejectedValueOnce(driverError('OwnerCallError', 'Owner answered', props));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'OwnerCallError', message: '[REDACTED]', ...kept } });
    expect(out.stdout()).not.toContain('Lovelace');
    expect(out.stdout()).not.toContain(TOKEN_VALUE);
  });

  it.each([
    { name: 'OPT2_SERVICE_NAME', env: { OPT2_SERVICE_NAME: 'opt2-cli' }, fields: { service: 'opt2-cli', env: 'local' } },
    { name: 'a cloud environment', env: { OPT2_SERVICE_NAME: '', OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, fields: { service: 'migration', env: 'cloud' } },
    { name: 'a cloud environment without a project', env: { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: '' }, fields: { env: 'local' } },
  ])('logs failures under $name', async ({ env, fields }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.mocked(schedulerStatus).mockRejectedValueOnce(new Error('describe failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(logRecords(out.stderr())).toEqual([expect.objectContaining({ version: '1.0.0', ...fields })]);
  });

  it('maps a module usage error of an asynchronous command to exit code 2', async () => {
    vi.mocked(runFault).mockRejectedValueOnce(new FaultUsageError('nope', 'unknown fault; known: duplicate-batch'));
    const out = capture();
    await expect(main(['fault', 'nope'], out.io)).resolves.toBe(2);
    expect(summaryLine(out.stdout())).toMatchObject({ command: 'fault', ok: false, error: { type: 'FaultUsageError' } });
  });

  it('reports a thrown non-Error by its type', async () => {
    vi.mocked(schedulerStatus).mockRejectedValueOnce('boom');
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'string', message: '[REDACTED]' } });
    expect(out.stderr()).not.toContain('boom');
  });

  it('exits 1 on a MySQL fallback without running the command or closing a context', async () => {
    const error = new UnsupportedLegacyDatabaseError('mysql');
    vi.mocked(createMigrationContext).mockRejectedValueOnce(error);
    const out = capture();
    await expect(main(['feed'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'feed', ok: false, error: { type: 'UnsupportedLegacyDatabaseError', message: '[REDACTED]' } });
    expect(runFeed).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it('reports a close failure after a success as the failure', async () => {
    vi.mocked(schedulerStatus).mockResolvedValueOnce({} as never);
    vi.mocked(ctx.close).mockRejectedValueOnce(new Error('pool end failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'Error', message: '[REDACTED]' } });
  });

  it('keeps the command error when closing fails too, and logs the close failure first', async () => {
    vi.mocked(schedulerStatus).mockRejectedValueOnce(driverError('Error', 'describe failed', { code: 'ECONNCLOSED' }));
    vi.mocked(ctx.close).mockRejectedValueOnce(driverError('Error', 'pool end failed', { code: 'ENOTOPEN' }));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'Error', message: '[REDACTED]', code: 'ECONNCLOSED' } });
    expect(logRecords(out.stderr()).map((record) => record.message)).toEqual([
      'opt2-migrate scheduler status: closing the context failed (code=ENOTOPEN)',
      'opt2-migrate scheduler status failed (code=ECONNCLOSED)',
    ]);
    expect(out.stderr()).not.toContain('pool end failed');
  });

  it('keeps the exit code when the final span export fails, and logs it without its text', async () => {
    vi.mocked(schedulerStatus).mockResolvedValueOnce({} as never);
    vi.mocked(shutdownTracing).mockRejectedValueOnce(new Error('export to http://127.0.0.1:4318/v1/traces failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(0);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: true });
    expect(logRecords(out.stderr())).toEqual([
      expect.objectContaining({ severity: 'WARNING', message: 'opt2-migrate: exporting traces failed', error: expect.objectContaining({ message: '[REDACTED]' }) }),
    ]);
    expect(out.stderr()).not.toContain('4318');
  });

  it('never writes a secret value or a URL query to either stream', async () => {
    vi.stubEnv('MURA_DBPASSWORD', DB_SECRET);
    vi.stubEnv('OPT2_BRIDGE_HMAC_KEY', BRIDGE_SECRET);
    const taskUrl = 'http://localhost:20100/_api/sitemonitor/?opt2TaskToken=task-token-value';
    const origin = `http://operator:${USER_PASSWORD}@127.0.0.1:1/`;
    vi.mocked(schedulerStatus).mockResolvedValueOnce({ live: { tasks: [{ url: taskUrl }] }, note: `key ${BRIDGE_SECRET}`, origin } as never);
    const ok = capture();
    await expect(main(['scheduler', 'status'], ok.io)).resolves.toBe(0);
    expect(summaryLine(ok.stdout())).toMatchObject({
      live: { tasks: [{ url: 'http://localhost:20100/_api/sitemonitor/' }] },
      note: 'key [redacted]',
      origin: 'http://[REDACTED]@127.0.0.1:1/',
    });

    vi.mocked(initLegacy).mockRejectedValueOnce(new Error(`Login failed for sa with password ${DB_SECRET} at ${taskUrl}`));
    const failed = capture();
    await expect(main(['init-legacy'], failed.io)).resolves.toBe(1);
    for (const text of [ok.stdout(), failed.stdout(), failed.stderr()]) {
      expect(text).not.toContain(DB_SECRET);
      expect(text).not.toContain(BRIDGE_SECRET);
      expect(text).not.toContain(USER_PASSWORD);
      expect(text).not.toContain('task-token-value');
    }
    expect(summaryLine(failed.stdout())).toEqual({ command: 'init-legacy', ok: false, error: { type: 'Error', message: '[REDACTED]' } });
  });

  it('starts the service after tracing, without a context or a summary line', async () => {
    vi.mocked(startServer).mockResolvedValueOnce({} as never);
    const out = capture();
    await expect(main(['serve'], out.io)).resolves.toBe(0);
    expect(startServer).toHaveBeenCalledOnce();
    expect(vi.mocked(startTracing).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startServer).mock.invocationCallOrder[0] ?? 0);
    expect(createMigrationContext).not.toHaveBeenCalled();
    expect(shutdownTracing).not.toHaveBeenCalled();
    expect(out.stdout()).toBe('');
  });

  it('logs a service that fails to start as one start-up line on stdout, with exit code 1 and no summary line', async () => {
    vi.mocked(startServer).mockRejectedValueOnce(new UnsupportedLegacyDatabaseError('mysql'));
    const out = capture();
    await expect(main(['serve'], out.io)).resolves.toBe(1);
    expect(logRecords(out.stdout())).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        service: 'migration',
        version: '1.0.0',
        message: 'start-up failed',
        error: expect.objectContaining({ type: 'UnsupportedLegacyDatabaseError', message: '[REDACTED]' }),
      }),
    ]);
    expect(out.stdout()).not.toContain('MURA_DBTYPE');
    expect(out.stderr()).toBe('');
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });
});

describe('opt2-migrate as the entry module', () => {
  const dirs: string[] = [];
  const exitCodeBefore = process.exitCode;
  let loads = 0;

  afterEach(() => {
    process.exitCode = exitCodeBefore;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Loads a fresh instance of the CLI with `process.argv` as Node sets it for `script`, and returns what it wrote and set. */
  async function loadAs(script: string, args: string[]): Promise<{ exitCode: typeof process.exitCode; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const argv = process.argv;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => out.push(String(chunk)) > 0);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => err.push(String(chunk)) > 0);
    process.argv = [argv[0] ?? process.execPath, script, ...args];
    try {
      loads += 1;
      // The query makes a module instance of its own, so the entry check runs again while every import stays mocked.
      const instance = `${pathToFileURL(CLI_SOURCE).href}?entry=${loads}`;
      await import(/* @vite-ignore */ instance);
      // main resolves in microtasks for help and usage errors; setImmediate runs after all of them.
      await new Promise((resolve) => setImmediate(resolve));
      return { exitCode: process.exitCode, stdout: out.join(''), stderr: err.join('') };
    } finally {
      process.argv = argv;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  it.each([
    { args: ['--help'], exitCode: 0, stdout: HELP, stderr: '' },
    { args: ['nope'], exitCode: 2, stdout: '', stderr: `opt2-migrate: unknown command "nope"\n${USAGE}` },
    { args: ['transition', '--to', '3'], exitCode: 2, stdout: '', stderr: `opt2-migrate: --to must name a cut-over version vNNNN, got "3"\n${usageFor('transition')}` },
  ])('sets exit code $exitCode for $args', async ({ args, ...expected }) => {
    await expect(loadAs(CLI_SOURCE, args)).resolves.toEqual(expected);
    expect(createMigrationContext).not.toHaveBeenCalled();
  });

  it('runs through a symlinked bin path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opt2-migrate-bin-'));
    dirs.push(dir);
    const link = path.join(dir, 'opt2-migrate');
    symlinkSync(CLI_SOURCE, link);
    await expect(loadAs(link, ['--help'])).resolves.toEqual({ exitCode: 0, stdout: HELP, stderr: '' });
  });

  it('runs nothing when another module is the entry', async () => {
    await expect(loadAs(fileURLToPath(import.meta.url), ['--help'])).resolves.toEqual({ exitCode: exitCodeBefore, stdout: '', stderr: '' });
  });
});
