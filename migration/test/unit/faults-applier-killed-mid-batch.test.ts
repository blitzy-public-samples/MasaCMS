// Unit tests for the applier-killed-mid-batch fault script over a faked child process, applier and snapshot store.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackfill, runFeed } from '../../src/apply/index.js';
import type { BackfillResult, FeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { migrateCliPath, spawnChild } from '../../src/faults/process-control.js';
import type { ChildOutcome } from '../../src/faults/process-control.js';
import { applierKilledMidBatch, type ApplierKilledParams } from '../../src/faults/scripts/applier-killed-mid-batch.js';
import type { FaultEnv, FaultRunOutput } from '../../src/faults/scripts/types.js';
import { getSnapshot, latestSnapshot } from '../../src/snapshot/index.js';
import type { SnapshotRecord, SnapshotState } from '../../src/snapshot/index.js';

vi.mock('../../src/faults/process-control.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/faults/process-control.js')>()),
  spawnChild: vi.fn(),
  migrateCliPath: vi.fn(() => '/opt2/migration/dist/cli.js'),
}));

vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  runFeed: vi.fn(),
  runBackfill: vi.fn(),
}));

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  latestSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
}));

const CLI = '/opt2/migration/dist/cli.js';
const WORKLOAD_REASON = "run the deterministic legacy workload before this fault or pass {command:'backfill'}";
const ctx = { name: 'migration-context' } as unknown as MigrationContext;
const env = { ctx } as unknown as FaultEnv;

function snapshot(seq: number, state: SnapshotState = 'ready'): SnapshotRecord {
  return { seq, state, kind: 'feed', databaseName: `muradb_opt2_snap_${String(seq)}` } as SnapshotRecord;
}

function outcome(overrides: Partial<ChildOutcome>): ChildOutcome {
  return { exitCode: 0, signal: null, timedOut: false, stdoutTail: '', stderrTail: '', ...overrides };
}

function applied(snapshotSeq: number, exitCode: 0 | 1, point = `after-feed-${String(snapshotSeq)}`): FeedResult & BackfillResult {
  const result = exitCode === 0 ? 'zero-difference' : 'difference';
  return { snapshotSeq, exitCode, reconciliation: { point, result, reportPath: `/reports/${point}.json` } } as FeedResult & BackfillResult;
}

/** `latestSnapshot` answers each sequence in turn (undefined meaning none), then keeps the last answer. */
function latestSequence(...seqs: (number | undefined)[]): void {
  for (const seq of seqs) vi.mocked(latestSnapshot).mockResolvedValueOnce(seq === undefined ? null : snapshot(seq));
  const last = seqs.at(-1);
  vi.mocked(latestSnapshot).mockResolvedValue(last === undefined ? null : snapshot(last));
}

function params(input: Partial<ApplierKilledParams> = {}): ApplierKilledParams {
  return applierKilledMidBatch.paramsSchema.parse(input);
}

beforeEach(() => {
  vi.mocked(spawnChild).mockReset();
  vi.mocked(runFeed).mockReset();
  vi.mocked(runBackfill).mockReset();
  vi.mocked(latestSnapshot).mockReset();
  vi.mocked(getSnapshot).mockReset().mockResolvedValue(null);
});

describe('applier-killed-mid-batch fault script', () => {
  it('is the config fault applier-killed-mid-batch and reconciles afterwards', () => {
    expect(applierKilledMidBatch.name).toBe('applier-killed-mid-batch');
    expect(applierKilledMidBatch.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(applierKilledMidBatch.name);
  });

  it.each([
    [{}, { command: 'feed', killAfter: 1, timeoutMs: 600_000 }],
    [{ command: 'backfill', killAfter: 4, snapshotSeq: 0, timeoutMs: 5000 }, { command: 'backfill', killAfter: 4, snapshotSeq: 0, timeoutMs: 5000 }],
  ])('parses %j as %j', (input, expected) => {
    expect(applierKilledMidBatch.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ killAfter: 0 }, { killAfter: 1.5 }, { command: 'restore' }, { snapshotSeq: -1 }, { timeoutMs: 0 }, { kill: 1 }])('rejects %j', (input) => {
    expect(applierKilledMidBatch.paramsSchema.safeParse(input).success).toBe(false);
  });

  it('arms only the child feed and resumes on the snapshot it took when it exits 137', async () => {
    latestSequence(4, 5);
    vi.mocked(spawnChild).mockResolvedValue(outcome({ exitCode: 137 }));
    const before = process.env.OPT2_FAULT;

    const output = await applierKilledMidBatch.run(env, params({ killAfter: 3, timeoutMs: 9000, snapshotSeq: 2 }));

    expect(process.env.OPT2_FAULT).toBe(before);
    expect(migrateCliPath).toHaveBeenCalled();
    const [command, args, options] = vi.mocked(spawnChild).mock.calls[0] ?? [];
    expect(command).toBe(process.execPath);
    expect(args).toStrictEqual([CLI, 'feed']);
    expect(options).toMatchObject({ timeoutMs: 9000, env: { OPT2_FAULT: 'apply:kill-after:3' } });
    expect(output).toStrictEqual({
      assertions: [{ name: 'killed-mid-run', status: 'pass', detail: { exitCode: 137, killAfter: 3 } }],
      details: { command: 'feed', killAfter: 3, exitCode: 137, signal: null, timedOut: false, seqBefore: 4, seqAfter: 5, snapshotSeqIgnored: 2 },
      state: { command: 'feed', resumeSeq: 5 },
    });
  });

  it('fails a feed that exits 0, since it never reached the armed batch, and leaves no resume snapshot when none was taken', async () => {
    latestSequence(4, 4);
    vi.mocked(spawnChild).mockResolvedValue(outcome({ exitCode: 0 }));

    const output = await applierKilledMidBatch.run(env, params({ killAfter: 2 }));

    expect(output.assertions).toStrictEqual([
      { name: 'killed-mid-run', status: 'fail', detail: { exitCode: 0, killAfter: 2 }, reason: WORKLOAD_REASON },
    ]);
    expect(output.state).toStrictEqual({ command: 'feed', resumeSeq: undefined });
  });

  it.each([
    [{ exitCode: 1, stderrTail: 'FeedAuthorityError: target-authoritative' }],
    [{ exitCode: null, signal: 'SIGTERM', timedOut: true, stderrTail: '' }],
    [{ exitCode: 137, timedOut: true, stderrTail: 'late' }],
  ] as const)('fails a child that ends as %j', async (ended) => {
    latestSequence(undefined, undefined);
    vi.mocked(spawnChild).mockResolvedValue(outcome(ended));

    const output = await applierKilledMidBatch.run(env, params());

    const { exitCode, signal, timedOut, stderrTail } = outcome(ended);
    expect(output.assertions).toStrictEqual([{ name: 'killed-mid-run', status: 'fail', detail: { exitCode, signal, timedOut, stderrTail } }]);
  });

  it('kills a backfill of the requested snapshot and resumes on the same one', async () => {
    latestSequence(6);
    vi.mocked(spawnChild).mockResolvedValue(outcome({ exitCode: 137 }));

    const output = await applierKilledMidBatch.run(env, params({ command: 'backfill', snapshotSeq: 2 }));

    expect(vi.mocked(spawnChild).mock.calls[0]?.[1]).toStrictEqual([CLI, 'backfill', '--snapshot', '2']);
    expect(output.assertions[0]?.status).toBe('pass');
    expect(output.details).toMatchObject({ command: 'backfill', snapshotSeq: 2, seqBefore: 6, seqAfter: 6 });
    expect(output.state).toStrictEqual({ command: 'backfill', resumeSeq: 2 });
  });

  it.each([
    ['the first ready sequence', [snapshot(0, 'dropped'), snapshot(1, 'failed'), snapshot(2)], '2'],
    ['the latest when no earlier one is ready', [null, snapshot(1, 'creating'), null], '3'],
  ])('backfills %s when no snapshot is given', async (_label, records, expected) => {
    latestSequence(3);
    for (const record of records) vi.mocked(getSnapshot).mockResolvedValueOnce(record);
    vi.mocked(spawnChild).mockResolvedValue(outcome({ exitCode: 137 }));

    const output = await applierKilledMidBatch.run(env, params({ command: 'backfill' }));

    expect(vi.mocked(spawnChild).mock.calls[0]?.[1]).toStrictEqual([CLI, 'backfill', '--snapshot', expected]);
    expect(output.state).toStrictEqual({ command: 'backfill', resumeSeq: Number(expected) });
  });

  it('fails a backfill without spawning when no snapshot exists', async () => {
    latestSequence(undefined);

    const output = await applierKilledMidBatch.run(env, params({ command: 'backfill' }));

    expect(spawnChild).not.toHaveBeenCalled();
    expect(output.assertions).toStrictEqual([
      { name: 'killed-mid-run', status: 'fail', detail: 'no snapshot exists', reason: 'take S0 and backfill before this fault' },
    ]);
    expect(output.state).toStrictEqual({ command: 'backfill' });
  });

  it('explains a backfill that exits 0 by its batch count', async () => {
    latestSequence(0);
    vi.mocked(spawnChild).mockResolvedValue(outcome({ exitCode: 0 }));

    const output = await applierKilledMidBatch.run(env, params({ command: 'backfill', killAfter: 50 }));

    expect(output.assertions[0]).toMatchObject({ status: 'fail', reason: 'the backfill sent fewer batches than killAfter; pass a lower killAfter' });
  });

  it.each<[{ command: string; resumeSeq?: number }, Record<string, number>]>([
    [{ command: 'feed', resumeSeq: 5 }, { snapshotSeq: 5 }],
    [{ command: 'feed' }, {}],
  ])('re-runs the feed from state %j with options %j', async (state, options) => {
    vi.mocked(runFeed).mockResolvedValue(applied(5, 0));

    const output = await applierKilledMidBatch.resume(env, params(), { assertions: [], state });

    expect(runFeed).toHaveBeenCalledExactlyOnceWith(ctx, options);
    expect(runBackfill).not.toHaveBeenCalled();
    expect(output).toStrictEqual({
      steps: ['rerun-feed'],
      assertions: [{ name: 'rerun-idempotent', status: 'pass', detail: { snapshotSeq: 5, exitCode: 0 } }],
      details: { command: 'feed', resumeSeq: state.resumeSeq },
    });
  });

  it('fails the re-run with its reconciliation when it leaves a difference', async () => {
    vi.mocked(runBackfill).mockResolvedValue(applied(2, 1, 'after-backfill'));

    const output = await applierKilledMidBatch.resume(env, params({ command: 'backfill' }), { assertions: [], state: { command: 'backfill', resumeSeq: 2 } });

    expect(runBackfill).toHaveBeenCalledExactlyOnceWith(ctx, { snapshotSeq: 2 });
    expect(output.steps).toStrictEqual(['rerun-backfill']);
    expect(output.assertions).toStrictEqual([
      {
        name: 'rerun-idempotent',
        status: 'fail',
        detail: {
          snapshotSeq: 2,
          exitCode: 1,
          reconciliation: { point: 'after-backfill', result: 'difference', reportPath: '/reports/after-backfill.json' },
        },
      },
    ]);
  });

  it.each([new Error('The forward feed cannot restart for target-authoritative units: people.person'), 'socket closed'])(
    'reports a re-run that throws %s instead of rethrowing',
    async (error) => {
      vi.mocked(runFeed).mockRejectedValue(error);

      const output = await applierKilledMidBatch.resume(env, params(), { assertions: [], state: { command: 'feed', resumeSeq: 7 } });

      const message = error instanceof Error ? error.message : error;
      expect(output.steps).toStrictEqual(['rerun-feed']);
      expect(output.assertions).toStrictEqual([{ name: 'rerun-idempotent', status: 'fail', detail: { snapshotSeq: 7, error: message } }]);
    },
  );

  it.each<[string, FaultRunOutput | undefined, Partial<ApplierKilledParams>, number]>([
    ['no run output', undefined, { command: 'backfill', snapshotSeq: 3 }, 3],
    ['an unreadable state', { assertions: [], state: { command: 'restore' } }, { command: 'backfill', snapshotSeq: 1 }, 1],
  ])('falls back to the params with %s', async (_label, output, input, seq) => {
    vi.mocked(runBackfill).mockResolvedValue(applied(seq, 0, 'after-backfill'));

    const resumed = await applierKilledMidBatch.resume(env, params(input), output);

    expect(runBackfill).toHaveBeenCalledExactlyOnceWith(ctx, { snapshotSeq: seq });
    expect(resumed.assertions[0]?.status).toBe('pass');
  });

  it('falls back to the earliest ready snapshot for a backfill re-run', async () => {
    latestSequence(4);
    vi.mocked(getSnapshot).mockResolvedValueOnce(snapshot(0));
    vi.mocked(runBackfill).mockResolvedValue(applied(0, 0, 'after-backfill'));

    await applierKilledMidBatch.resume(env, params({ command: 'backfill' }), { assertions: [], state: { command: 'backfill' } });

    expect(runBackfill).toHaveBeenCalledExactlyOnceWith(ctx, { snapshotSeq: 0 });
  });

  it('fails a backfill re-run without applying when no snapshot exists', async () => {
    latestSequence(undefined);

    const output = await applierKilledMidBatch.resume(env, params({ command: 'backfill' }));

    expect(runBackfill).not.toHaveBeenCalled();
    expect(output).toStrictEqual({
      steps: [],
      assertions: [{ name: 'rerun-idempotent', status: 'fail', detail: 'no snapshot exists', reason: 'take S0 and backfill before this fault' }],
      details: { command: 'backfill' },
    });
  });
});
