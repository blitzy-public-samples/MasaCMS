// Unit tests for the `opt2-migrate` CLI: argument parsing, dispatch, the summary line, redaction and exit codes, with tracing, the context and every command module stubbed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shutdownTracing, startTracing } from '@opt2/platform/tracing';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { runBackfill, runFeed } from '../../src/apply/index.js';
import {
  DEFAULT_TRANSITION_POLL_MS,
  MigrateUsageError,
  USAGE,
  main,
  parseCommand,
  usageFor,
  type MigrateCommand,
  type MigrateIo,
} from '../../src/cli.js';
import { createMigrationContext, type MigrationContext } from '../../src/context.js';
import { UnsupportedLegacyDatabaseError } from '../../src/env.js';
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
    [['reconcile'], /--point <value> is required/],
    [['reconcile', '--point', 'post-cutover', '--units', 'a.b,,c.d'], /--units must be a comma-separated list without empty items/],
    [['fault'], /fault needs <name>/],
    [['fault', 'a', 'b'], /unexpected argument "b"/],
    [['fault', 'projector-delay', '--params', '{bad'], /--params is not JSON/],
    [['resolve-window'], /resolve-window needs <windowId>/],
    [['resolve-window', ''], /<windowId> must not be empty/],
    [['window', 'open'], /--units <value> is required/],
    [['window', 'open', '--units', 'a.b', '--scope', 'rows'], /--scope is not JSON/],
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

describe('main', () => {
  it('prints the usage for --help without tracing or a context', async () => {
    const out = capture();
    await expect(main(['--help'], out.io)).resolves.toBe(0);
    expect(out.stdout()).toBe(USAGE);
    expect(out.stderr()).toBe('');
    expect(startTracing).not.toHaveBeenCalled();
    expect(createMigrationContext).not.toHaveBeenCalled();
  });

  it('prints a command usage for its --help', async () => {
    const out = capture();
    await expect(main(['window', 'open', '--help'], out.io)).resolves.toBe(0);
    expect(out.stdout()).toBe(usageFor('window open'));
  });

  it.each([
    { argv: ['nope'], stderr: `opt2-migrate: unknown command "nope"\n${USAGE}` },
    { argv: ['transition', '--to', '3'], stderr: `opt2-migrate: --to must name a cut-over version vNNNN, got "3"\n${usageFor('transition')}` },
  ])('answers $argv on stderr with exit code 2', async ({ argv, stderr }) => {
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(2);
    expect(out.stdout()).toBe('');
    expect(out.stderr()).toBe(stderr);
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
    { argv: ['transition', '--to', 'v0002'], fn: requestTransition, result: { ...TRANSITION, state: 'aborted', error: { step: 6, message: 'difference' } } },
  ])('exits 1 with ok false when $argv.0 completes with a failing verdict', async ({ argv, fn, result }) => {
    vi.mocked(fn as unknown as AnyMock).mockResolvedValueOnce(result);
    const out = capture();
    await expect(main(argv, out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual(asJson({ command: parseCommand(argv).kind, ok: false, ...result }));
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
    { error: new RollbackSetMismatchError('R differs from v0003 rollbackRefs', ['g1'], ['g2'], ['g2']), code: 1 },
    { error: new Error('plain failure'), code: 1 },
    { error: new FaultUsageError('nope', 'unknown fault'), code: 2 },
    { error: new ReconcileUsageError('Unknown point nope'), code: 2 },
  ])('reports $error.name with exit code $code', async ({ error, code }) => {
    vi.mocked(computeRollbackSet).mockImplementationOnce(() => {
      throw error;
    });
    const out = capture();
    await expect(main(['rollback-set'], out.io)).resolves.toBe(code);
    expect(summaryLine(out.stdout())).toEqual({ command: 'rollback-set', ok: false, error: { type: error.name, message: error.message } });
    expect(out.stderr()).toContain(error.message);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(shutdownTracing).toHaveBeenCalledOnce();
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
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'string', message: 'boom' } });
  });

  it('exits 1 on a MySQL fallback without running the command or closing a context', async () => {
    const error = new UnsupportedLegacyDatabaseError('mysql');
    vi.mocked(createMigrationContext).mockRejectedValueOnce(error);
    const out = capture();
    await expect(main(['feed'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'feed', ok: false, error: { type: 'UnsupportedLegacyDatabaseError', message: error.message } });
    expect(runFeed).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });

  it('reports a close failure after a success as the failure', async () => {
    vi.mocked(schedulerStatus).mockResolvedValueOnce({} as never);
    vi.mocked(ctx.close).mockRejectedValueOnce(new Error('pool end failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: false, error: { type: 'Error', message: 'pool end failed' } });
  });

  it('keeps the command error when closing fails too', async () => {
    vi.mocked(schedulerStatus).mockRejectedValueOnce(new Error('describe failed'));
    vi.mocked(ctx.close).mockRejectedValueOnce(new Error('pool end failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toMatchObject({ ok: false, error: { message: 'describe failed' } });
    expect(out.stderr()).toContain('pool end failed');
  });

  it('keeps the exit code when the final span export fails', async () => {
    vi.mocked(schedulerStatus).mockResolvedValueOnce({} as never);
    vi.mocked(shutdownTracing).mockRejectedValueOnce(new Error('export to http://127.0.0.1:4318/v1/traces failed'));
    const out = capture();
    await expect(main(['scheduler', 'status'], out.io)).resolves.toBe(0);
    expect(summaryLine(out.stdout())).toEqual({ command: 'scheduler status', ok: true });
    expect(out.stderr()).toContain('opt2-migrate: exporting traces failed');
  });

  it('never writes a secret value or a URL query to either stream', async () => {
    vi.stubEnv('MURA_DBPASSWORD', DB_SECRET);
    vi.stubEnv('OPT2_BRIDGE_HMAC_KEY', BRIDGE_SECRET);
    const taskUrl = 'http://localhost:20100/_api/sitemonitor/?opt2TaskToken=task-token-value';
    vi.mocked(schedulerStatus).mockResolvedValueOnce({ live: { tasks: [{ url: taskUrl }] }, note: `key ${BRIDGE_SECRET}` } as never);
    const ok = capture();
    await expect(main(['scheduler', 'status'], ok.io)).resolves.toBe(0);
    expect(summaryLine(ok.stdout())).toMatchObject({ live: { tasks: [{ url: 'http://localhost:20100/_api/sitemonitor/' }] }, note: 'key [redacted]' });

    vi.mocked(initLegacy).mockRejectedValueOnce(new Error(`Login failed for sa with password ${DB_SECRET} at ${taskUrl}`));
    const failed = capture();
    await expect(main(['init-legacy'], failed.io)).resolves.toBe(1);
    for (const text of [ok.stdout(), failed.stdout(), failed.stderr()]) {
      expect(text).not.toContain(DB_SECRET);
      expect(text).not.toContain(BRIDGE_SECRET);
      expect(text).not.toContain('task-token-value');
    }
    expect(summaryLine(failed.stdout())).toMatchObject({ error: { message: expect.stringContaining('password [redacted]') } });
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

  it('reports a service that fails to start with exit code 1', async () => {
    const error = new UnsupportedLegacyDatabaseError('mysql');
    vi.mocked(startServer).mockRejectedValueOnce(error);
    const out = capture();
    await expect(main(['serve'], out.io)).resolves.toBe(1);
    expect(summaryLine(out.stdout())).toEqual({ command: 'serve', ok: false, error: { type: 'UnsupportedLegacyDatabaseError', message: error.message } });
    expect(out.stderr()).toContain('UnsupportedLegacyDatabaseError');
    expect(shutdownTracing).toHaveBeenCalledOnce();
  });
});

describe('opt2-migrate as a process', () => {
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
    { args: ['nope'], status: 2 },
    { args: ['transition', '--to', '3'], status: 2 },
  ])('exits $status for $args', ({ args, status }) => {
    const child = runCli(CLI_SOURCE, args);
    expect(child.status, child.stderr).toBe(status);
    if (status === 0) expect(child.stdout).toBe(USAGE);
    else expect(child.stderr).toMatch(/^opt2-migrate: /);
  });

  it('runs through a symlinked bin path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opt2-migrate-bin-'));
    dirs.push(dir);
    const link = path.join(dir, 'opt2-migrate.ts');
    symlinkSync(CLI_SOURCE, link);
    const child = runCli(link, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(USAGE);
  });
});
