// Unit tests for the service-restarted-mid-apply fault script: a fake owners client and process control around mocked commands.
import { REDACTED, type Logger } from '@opt2/platform/logging';
import type { ApplyRequest } from '@opt2/platform/migration-kit';
import type { ServiceClient } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackfill, runFeed, type BackfillResult, type FeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import { createMigrationContext, type MigrationContext } from '../../src/context.js';
import type { GatewayClient } from '../../src/cutover/gateway-client.js';
import type { MigrationEnv } from '../../src/env.js';
import {
  ProcessControlError,
  ProcessEntryError,
  type ProcessControl,
  type ProcessRestartResult,
} from '../../src/faults/process-control.js';
import { serviceRestartedMidApply, type ServiceRestartParams } from '../../src/faults/scripts/service-restarted-mid-apply.js';
import type { FaultEnv, FaultRunOutput } from '../../src/faults/scripts/types.js';
import type { BridgeClient } from '../../src/legacy/bridge.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import type { ApplyResult, DataOwner, OwnersClient, UnitCatalog } from '../../src/owners/index.js';
import { getSnapshot, latestSnapshot, type SnapshotRecord, type SnapshotState } from '../../src/snapshot/index.js';

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

const PARAMS: ServiceRestartParams = { owner: 'people', afterBatches: 1, command: 'feed', timeoutMs: 5000 };
const OLD_PID = 4100;
const NEW_PID = 4200;
const DOWN = 'Service people unavailable (ECONNREFUSED)';
const HEALTHY_RESTART = { triggered: true, healthy: true, oldPid: OLD_PID, newPid: NEW_PID };
const STALE = 'pid 4100 does not own port 23212; the up.json record is stale';
const NO_START = 'cannot run the start command';
const NO_HEALTH = 'http://127.0.0.1:23212/healthz did not answer 200 within 5000 ms';
const RESTORE_STEP = 'restore-owner';

const snapshot = (seq: number, state: SnapshotState = 'ready'): SnapshotRecord => ({ seq, state }) as SnapshotRecord;

/** A command result with `exitCode`, as runFeed and runBackfill return it. */
function commandResult(snapshotSeq: number, exitCode: 0 | 1): FeedResult & BackfillResult {
  const result = exitCode === 0 ? 'zero-difference' : 'difference';
  return { snapshotSeq, exitCode, reconciliation: { point: 'after-x', result, reportPath: '/reports/x.json' } } as unknown as FeedResult &
    BackfillResult;
}

/** A command that sends one batch per entry of `sends` through the context's owners, stopping at the first failure. */
function sending(sends: readonly DataOwner[], exitCode: 0 | 1 = 0) {
  return async (ctx: Pick<MigrationContext, 'owners'>): Promise<FeedResult & BackfillResult> => {
    for (const [index, owner] of sends.entries()) {
      await ctx.owners.apply(owner, { batchId: `batch-${String(index)}` } as unknown as ApplyRequest);
    }
    return commandResult(9, exitCode);
  };
}

/** The test's ports: owners answering every apply except those `failing` lists, process control whose restart waits for `release`, and `recordPid` to set its entry's pid. */
async function harness(opts: { failing?: (owner: DataOwner, call: number) => boolean; holdRestart?: boolean } = {}) {
  let releaseRestart: () => void = () => undefined;
  const restartGate = opts.holdRestart === true ? new Promise<void>((resolve) => (releaseRestart = resolve)) : Promise.resolve();
  let pid = OLD_PID;
  const processControl = {
    entry: vi.fn<ProcessControl['entry']>(() => ({ pid, port: 23212, cwd: '/srv/people', command: ['node', 'dist/main.js'] })),
    envOf: vi.fn<ProcessControl['envOf']>(),
    restart: vi.fn<ProcessControl['restart']>(async (name) => {
      await restartGate;
      pid = NEW_PID;
      return { name, oldPid: OLD_PID, newPid: NEW_PID, stoppedMs: 3, healthyMs: 4 } satisfies ProcessRestartResult;
    }),
    waitHealthy: vi.fn<ProcessControl['waitHealthy']>(() => Promise.resolve(12)),
  };
  let calls = 0;
  const owners = {
    apply: vi.fn<OwnersClient['apply']>(async (owner) => {
      calls += 1;
      if (opts.failing?.(owner, calls) === true) throw new Error(DOWN);
      return { duplicate: false } as unknown as ApplyResult;
    }),
    watermark: vi.fn<OwnersClient['watermark']>(),
    putWatermark: vi.fn<OwnersClient['putWatermark']>(),
  } as unknown as OwnersClient;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const ctx = await createMigrationContext({
    env: { OPT2_ENV: 'local', OPT2_STATE_DIR: '/state' } as unknown as MigrationEnv,
    logger,
    db: { schema: 'migration' } as TenantDb,
    legacy: {} as LegacyDb,
    bridge: {} as BridgeClient,
    catalog: {} as UnitCatalog,
    owners,
    gateway: {} as GatewayClient,
    client: {} as ServiceClient,
  });
  const env = { ctx, processControl, logger, clock: ctx.clock } as unknown as FaultEnv;
  return {
    env,
    ctx,
    owners,
    processControl,
    logger: vi.mocked(logger),
    release: () => releaseRestart(),
    recordPid: (next: number) => (pid = next),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Names of `mocks` in the order their calls were made, one entry per call. */
function callOrder(mocks: Record<string, { mock: { invocationCallOrder: number[] } }>): string[] {
  return Object.entries(mocks)
    .flatMap(([name, { mock }]) => mock.invocationCallOrder.map((at) => ({ at, name })))
    .sort((a, b) => a.at - b.at)
    .map(({ name }) => name);
}

beforeEach(() => {
  vi.mocked(runFeed).mockReset();
  vi.mocked(runBackfill).mockReset();
  vi.mocked(latestSnapshot).mockReset().mockResolvedValue(snapshot(3));
  vi.mocked(getSnapshot).mockReset().mockResolvedValue(null);
});

describe('service-restarted-mid-apply fault script', () => {
  it('is the config fault service-restarted-mid-apply and reconciles', () => {
    expect(serviceRestartedMidApply.name).toBe('service-restarted-mid-apply');
    expect(serviceRestartedMidApply.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(serviceRestartedMidApply.name);
  });

  it.each([
    [{}, { owner: 'people', afterBatches: 1, command: 'feed', timeoutMs: 120_000 }],
    [
      { owner: 'identity', afterBatches: 3, command: 'backfill', snapshotSeq: 0, timeoutMs: 10 },
      { owner: 'identity', afterBatches: 3, command: 'backfill', snapshotSeq: 0, timeoutMs: 10 },
    ],
  ])('parses %j as %j', (input, expected) => {
    expect(serviceRestartedMidApply.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ afterBatches: 0 }, { afterBatches: 1.5 }, { command: 'restart' }, { snapshotSeq: -1 }, { timeoutMs: 0 }, { extra: true }])(
    'rejects %j',
    (input) => {
      expect(serviceRestartedMidApply.paramsSchema.safeParse(input).success).toBe(false);
    },
  );

  it('starts the restart once after the n-th acknowledged batch to the owner, without awaiting it, and passes when a later apply fails', async () => {
    const h = await harness({ holdRestart: true, failing: (owner, call) => owner === 'people' && call === 5 });
    vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
    let restartPendingAtFailure = false;
    vi.mocked(runFeed).mockImplementation(async (ctx) => {
      const apply = (owner: DataOwner) => ctx.owners.apply(owner, {} as ApplyRequest);
      await apply('people');
      await apply('identity');
      await apply('people');
      expect(h.processControl.restart).toHaveBeenCalledExactlyOnceWith('people', { timeoutMs: 5000 });
      await apply('people');
      restartPendingAtFailure = h.processControl.entry('people').pid === OLD_PID;
      h.release();
      await apply('people');
      return commandResult(4, 0);
    });

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, afterBatches: 2 });

    expect(restartPendingAtFailure).toBe(true);
    expect(h.processControl.restart).toHaveBeenCalledOnce();
    const [wrappedCtx, options] = vi.mocked(runFeed).mock.calls[0] ?? [];
    expect(options).toStrictEqual({});
    expect(wrappedCtx).not.toBe(h.ctx);
    expect(wrappedCtx?.owners).not.toBe(h.ctx.owners);
    expect(wrappedCtx?.owners.watermark).toBe(h.ctx.owners.watermark);
    expect(wrappedCtx?.db).toBe(h.ctx.db);
    expect(output).toStrictEqual({
      assertions: [
        { name: 'apply-interrupted', status: 'pass', detail: { acknowledged: 3, failedAfterRestart: DOWN } },
        { name: 'owner-healthy', status: 'pass', detail: { oldPid: OLD_PID, pid: NEW_PID, healthyMs: 12 } },
      ],
      details: { owner: 'people', command: 'feed', afterBatches: 2, acknowledged: 3, failedAfterRestart: DOWN, seqBefore: 3, seqAfter: 4 },
      state: { command: 'feed', resumeSeq: 4, restart: HEALTHY_RESTART },
    });
    expect(h.processControl.waitHealthy).toHaveBeenCalledExactlyOnceWith('people', { timeoutMs: 5000 });
    expect(h.processControl.restart.mock.invocationCallOrder[0]).toBeLessThan(
      h.processControl.waitHealthy.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('passes when the run reports a non-zero exit after an apply to the restarting owner failed', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(runFeed).mockImplementation(async (ctx) => {
      await ctx.owners.apply('people', {} as ApplyRequest);
      await ctx.owners.apply('people', {} as ApplyRequest).catch(() => undefined);
      return commandResult(3, 1);
    });

    const output = await serviceRestartedMidApply.run(h.env, PARAMS);

    expect(output.assertions[0]).toStrictEqual({ name: 'apply-interrupted', status: 'pass', detail: { acknowledged: 1, failedAfterRestart: DOWN } });
    expect(output.state).toStrictEqual({ command: 'feed', resumeSeq: undefined, restart: HEALTHY_RESTART });
  });

  it.each([
    [
      'fewer batches than afterBatches reached the owner',
      sending(['people', 'identity']),
      { acknowledged: 1, afterBatches: 2, exitCode: 0 },
      "run the deterministic legacy workload before this fault or pass {command:'backfill'}",
    ],
    [
      'the run failed for another reason before the threshold',
      async () => Promise.reject(new Error('FeedBaselineMissingError: run backfill first')),
      { acknowledged: 0, afterBatches: 2, error: 'FeedBaselineMissingError: run backfill first' },
      undefined,
    ],
  ] as const)('fails apply-interrupted and skips owner-healthy when %s', async (_case, command, detail, reason) => {
    const h = await harness();
    vi.mocked(runFeed).mockImplementation(command);

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, afterBatches: 2 });

    const failed = reason === undefined ? { name: 'apply-interrupted', status: 'fail', detail } : { name: 'apply-interrupted', status: 'fail', detail, reason };
    expect(output.assertions).toStrictEqual([failed, { name: 'owner-healthy', status: 'skipped', reason: 'restart not triggered' }]);
    expect(output.state?.['restart']).toStrictEqual({ triggered: false, healthy: false });
    expect(h.processControl.restart).not.toHaveBeenCalled();
  });

  it.each([
    ['the run sent no further batch to the owner', sending(['people', 'identity']), { acknowledged: 1, exitCode: 0 }],
    [
      'the run failed elsewhere',
      async (ctx: Pick<MigrationContext, 'owners'>) => {
        await ctx.owners.apply('people', {} as ApplyRequest);
        throw new Error('legacy read failed');
      },
      { acknowledged: 1, error: 'legacy read failed' },
    ],
  ] as const)('fails apply-interrupted with "no apply reached the restarting owner" when %s', async (_case, command, detail) => {
    const h = await harness();
    vi.mocked(runFeed).mockImplementation(command);

    const output = await serviceRestartedMidApply.run(h.env, PARAMS);

    expect(output.assertions[0]).toStrictEqual({ name: 'apply-interrupted', status: 'fail', detail, reason: 'no apply reached the restarting owner' });
    expect(output.assertions[1]?.status).toBe('pass');
  });

  it('fails apply-interrupted when the run succeeded although an apply to the restarting owner failed', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(runFeed).mockImplementation(async (ctx) => {
      await ctx.owners.apply('people', {} as ApplyRequest);
      await ctx.owners.apply('people', {} as ApplyRequest).catch(() => undefined);
      return commandResult(3, 0);
    });

    const output = await serviceRestartedMidApply.run(h.env, PARAMS);

    expect(output.assertions[0]).toMatchObject({ status: 'fail', detail: { acknowledged: 1, failedAfterRestart: DOWN, exitCode: 0 } });
  });

  it('counts only the owner it restarts and leaves failures before the restart unrecorded', async () => {
    const h = await harness({ failing: (owner) => owner === 'identity' });
    vi.mocked(runFeed).mockImplementation(sending(['identity']));

    const output = await serviceRestartedMidApply.run(h.env, PARAMS);

    expect(output.assertions[0]).toStrictEqual({ name: 'apply-interrupted', status: 'fail', detail: { acknowledged: 0, afterBatches: 1, error: DOWN } });
    expect(output.details).toMatchObject({ acknowledged: 0, failedAfterRestart: undefined });
  });

  it.each<[string, (h: Harness) => void, Record<string, unknown>]>([
    [
      'the restart cannot verify the owner before stopping it',
      (h) => h.processControl.restart.mockRejectedValueOnce(new ProcessControlError('people', 'stop', STALE)),
      { step: 'stop', oldPid: OLD_PID, newPid: undefined, error: `people stop: ${STALE}` },
    ],
    [
      'the start fails after the stop',
      (h) => h.processControl.restart.mockRejectedValueOnce(new ProcessControlError('people', 'start', NO_START)),
      { step: 'start', oldPid: OLD_PID, newPid: undefined, error: `people start: ${NO_START}` },
    ],
    [
      'the recorded replacement never turns healthy',
      (h) =>
        h.processControl.restart.mockImplementationOnce(async () => {
          h.recordPid(NEW_PID);
          throw new ProcessControlError('people', 'health', NO_HEALTH);
        }),
      { step: 'health', oldPid: OLD_PID, newPid: NEW_PID, error: `people health: ${NO_HEALTH}` },
    ],
    [
      'the restart rejects without naming a step',
      (h) => h.processControl.restart.mockRejectedValueOnce(new Error('Invalid /state/up.json')),
      { step: undefined, oldPid: OLD_PID, newPid: undefined, error: 'Invalid /state/up.json' },
    ],
    [
      'the health wait after the restart rejects',
      (h) => h.processControl.waitHealthy.mockRejectedValueOnce(new ProcessControlError('people', 'health', NO_HEALTH)),
      { step: 'health', oldPid: OLD_PID, newPid: NEW_PID, error: `people health: ${NO_HEALTH}` },
    ],
  ])('fails owner-healthy with the failed step and records the restart as unhealthy when %s', async (_case, arrange, detail) => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    arrange(h);
    vi.mocked(runFeed).mockImplementation(sending(['people', 'people']));

    const output = await serviceRestartedMidApply.run(h.env, PARAMS);

    expect(output.assertions).toStrictEqual([
      { name: 'apply-interrupted', status: 'pass', detail: { acknowledged: 1, failedAfterRestart: DOWN } },
      { name: 'owner-healthy', status: 'fail', detail },
    ]);
    const { error: _error, ...progress } = detail;
    expect(output.state?.['restart']).toStrictEqual({ triggered: true, healthy: false, ...progress });
  });

  it.each<[string, string, (pc: FaultEnv['processControl']) => void, RegExp]>([
    ['the owner is not a data owner', 'gateway', () => undefined, /^gateway is not a data owner; known: identity, people/],
    [
      'up.json has no entry for it',
      'people',
      (pc) => {
        vi.mocked(pc.entry).mockImplementation(() => {
          throw new ProcessEntryError('people', '/state/up.json');
        });
      },
      /^No process "people" in \/state\/up\.json$/,
    ],
    [
      'its entry records no port',
      'people',
      (pc) => {
        vi.mocked(pc.entry).mockReturnValue({ pid: 1, cwd: '/srv', command: 'node' });
      },
      /^the up\.json entry of people records no port$/,
    ],
  ])('refuses without running anything when %s', async (_case, owner, arrange, reason) => {
    const h = await harness();
    arrange(h.env.processControl);

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, owner });

    expect(output.state).toBeUndefined();
    expect(output.assertions).toHaveLength(1);
    expect(output.assertions[0]).toMatchObject({ name: 'apply-interrupted', status: 'fail', detail: { owner, command: 'feed' } });
    expect(output.assertions[0]?.reason).toMatch(reason);
    expect(runFeed).not.toHaveBeenCalled();
    expect(h.processControl.restart).not.toHaveBeenCalled();
  });

  it('resumes a feed on the snapshot the parameters name', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(runFeed).mockImplementation(sending(['people', 'people']));

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, snapshotSeq: 7 });

    expect(vi.mocked(runFeed).mock.calls[0]?.[1]).toStrictEqual({ snapshotSeq: 7 });
    expect(output.state).toStrictEqual({ command: 'feed', resumeSeq: 7, restart: HEALTHY_RESTART });
  });

  it('backfills the snapshot the parameters name', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(runBackfill).mockImplementation(sending(['people', 'people']));

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, command: 'backfill', snapshotSeq: 1 });

    expect(vi.mocked(runBackfill).mock.calls[0]?.[1]).toStrictEqual({ snapshotSeq: 1 });
    expect(runFeed).not.toHaveBeenCalled();
    expect(output.assertions.map((assertion) => assertion.status)).toStrictEqual(['pass', 'pass']);
    expect(output.state).toStrictEqual({ command: 'backfill', resumeSeq: 1, restart: HEALTHY_RESTART });
  });

  it('backfills the earliest ready snapshot when none is named', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(getSnapshot).mockImplementation(async (_ctx, seq) => (seq === 0 ? null : snapshot(seq, seq === 1 ? 'failed' : 'ready')));
    vi.mocked(runBackfill).mockImplementation(sending(['people', 'people']));

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, command: 'backfill' });

    expect(vi.mocked(getSnapshot).mock.calls.map(([, seq]) => seq)).toStrictEqual([0, 1, 2]);
    expect(vi.mocked(runBackfill).mock.calls[0]?.[1]).toStrictEqual({ snapshotSeq: 2 });
    expect(output.state).toStrictEqual({ command: 'backfill', resumeSeq: 2, restart: HEALTHY_RESTART });
  });

  it('backfills the latest snapshot when it is the only ready one', async () => {
    const h = await harness({ failing: (_owner, call) => call === 2 });
    vi.mocked(runBackfill).mockImplementation(sending(['people', 'people']));

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, command: 'backfill' });

    expect(vi.mocked(runBackfill).mock.calls[0]?.[1]).toStrictEqual({ snapshotSeq: 3 });
    expect(output.state).toStrictEqual({ command: 'backfill', resumeSeq: 3, restart: HEALTHY_RESTART });
  });

  it('refuses a backfill when no snapshot is ready', async () => {
    const h = await harness();
    vi.mocked(latestSnapshot).mockResolvedValue(null);

    const output = await serviceRestartedMidApply.run(h.env, { ...PARAMS, command: 'backfill' });

    expect(output.assertions).toStrictEqual([
      { name: 'apply-interrupted', status: 'fail', detail: { owner: 'people', command: 'backfill' }, reason: 'no ready snapshot to backfill from' },
    ]);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  describe('resume', () => {
    const output = (state?: Record<string, unknown>): FaultRunOutput => (state === undefined ? { assertions: [] } : { assertions: [], state });

    it.each([
      ['a feed on its recorded snapshot', output({ command: 'feed', resumeSeq: 4, restart: HEALTHY_RESTART }), 'rerun-feed', { snapshotSeq: 4 }],
      ['a feed that took no snapshot', output({ command: 'feed', restart: HEALTHY_RESTART }), 'rerun-feed', {}],
      ['a backfill on its snapshot', output({ command: 'backfill', resumeSeq: 2, restart: HEALTHY_RESTART }), 'rerun-backfill', { snapshotSeq: 2 }],
      [
        'a feed whose restart never triggered',
        output({ command: 'feed', resumeSeq: 4, restart: { triggered: false, healthy: false } }),
        'rerun-feed',
        { snapshotSeq: 4 },
      ],
    ])('re-runs %s on the normal context without restoring the owner and passes on exit 0', async (_case, runOutput, step, options) => {
      const h = await harness();
      const command = step === 'rerun-feed' ? vi.mocked(runFeed) : vi.mocked(runBackfill);
      command.mockResolvedValue(commandResult(4, 0));

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, runOutput);

      expect(command).toHaveBeenCalledExactlyOnceWith(h.ctx, options);
      const summary = { command: step.slice('rerun-'.length), snapshotSeq: 4, exitCode: 0, reconciliation: 'zero-difference', reportPath: '/reports/x.json' };
      expect(resumed).toStrictEqual({ steps: [step], assertions: [{ name: 'rerun-idempotent', status: 'pass', detail: summary }], details: summary });
      expect(h.processControl.waitHealthy).not.toHaveBeenCalled();
      expect(h.processControl.restart).not.toHaveBeenCalled();
    });

    it('fails rerun-idempotent when the re-run reports a difference', async () => {
      const h = await harness();
      vi.mocked(runFeed).mockResolvedValue(commandResult(4, 1));

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, output({ command: 'feed', resumeSeq: 4, restart: HEALTHY_RESTART }));

      expect(resumed.steps).toStrictEqual(['rerun-feed']);
      expect(resumed.assertions).toStrictEqual([
        { name: 'rerun-idempotent', status: 'fail', detail: { command: 'feed', snapshotSeq: 4, exitCode: 1, reconciliation: 'difference', reportPath: '/reports/x.json' } },
      ]);
    });

    it('fails rerun-idempotent without rethrowing when the re-run throws', async () => {
      const h = await harness();
      vi.mocked(runBackfill).mockRejectedValue(new Error('owner people answered HTTP 503'));

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, output({ command: 'backfill', resumeSeq: 2, restart: HEALTHY_RESTART }));

      expect(resumed).toStrictEqual({
        steps: ['rerun-backfill'],
        assertions: [{ name: 'rerun-idempotent', status: 'fail', detail: { command: 'backfill', snapshotSeq: 2, error: 'owner people answered HTTP 503' } }],
      });
    });

    it('skips the re-run when run refused before sending any batch', async () => {
      const h = await harness();

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, output());

      expect(resumed).toStrictEqual({
        steps: [],
        assertions: [{ name: 'rerun-idempotent', status: 'skipped', reason: 'the fault was refused before any batch was sent' }],
      });
      expect(runFeed).not.toHaveBeenCalled();
    });

    it("checks the owner's health before re-running the parameters' command when run threw", async () => {
      const h = await harness();
      vi.mocked(runBackfill).mockResolvedValue(commandResult(3, 0));

      const resumed = await serviceRestartedMidApply.resume(h.env, { ...PARAMS, command: 'backfill' });

      expect(callOrder({ waitHealthy: h.processControl.waitHealthy, restart: h.processControl.restart, runBackfill: vi.mocked(runBackfill) })).toStrictEqual([
        'waitHealthy',
        'runBackfill',
      ]);
      expect(h.processControl.waitHealthy).toHaveBeenCalledExactlyOnceWith('people', { timeoutMs: 5000 });
      expect(runBackfill).toHaveBeenCalledExactlyOnceWith(h.ctx, { snapshotSeq: 3 });
      expect(resumed.steps).toStrictEqual([RESTORE_STEP, 'rerun-backfill']);
      expect(resumed.assertions[0]).toStrictEqual({ name: 'owner-restored', status: 'pass', detail: { pid: OLD_PID, healthyMs: 12, action: 'health-check' } });
      expect(resumed.assertions[1]?.status).toBe('pass');
    });

    it.each<[string, string, (pc: FaultEnv['processControl']) => void]>([
      ['the owner is not a data owner', 'gateway', () => undefined],
      [
        'up.json has no entry for it',
        'people',
        (pc) => {
          vi.mocked(pc.entry).mockImplementation(() => {
            throw new ProcessEntryError('people', '/state/up.json');
          });
        },
      ],
      [
        'its entry records no port',
        'people',
        (pc) => {
          vi.mocked(pc.entry).mockReturnValue({ pid: 1, cwd: '/srv', command: 'node' });
        },
      ],
    ])('re-runs without restoring the owner when run threw and %s', async (_case, owner, arrange) => {
      const h = await harness();
      arrange(h.env.processControl);
      vi.mocked(runFeed).mockResolvedValue(commandResult(4, 0));

      const resumed = await serviceRestartedMidApply.resume(h.env, { ...PARAMS, owner });

      expect(resumed.steps).toStrictEqual(['rerun-feed']);
      expect(resumed.assertions.map((assertion) => assertion.name)).toStrictEqual(['rerun-idempotent']);
      expect(h.processControl.waitHealthy).not.toHaveBeenCalled();
      expect(h.processControl.restart).not.toHaveBeenCalled();
    });

    it('fails a backfill re-run when no snapshot is ready', async () => {
      const h = await harness();
      vi.mocked(latestSnapshot).mockResolvedValue(null);

      const resumed = await serviceRestartedMidApply.resume(h.env, { ...PARAMS, command: 'backfill' });

      expect(resumed).toStrictEqual({
        steps: [RESTORE_STEP],
        assertions: [
          { name: 'owner-restored', status: 'pass', detail: { pid: OLD_PID, healthyMs: 12, action: 'health-check' } },
          { name: 'rerun-idempotent', status: 'fail', detail: { command: 'backfill' }, reason: 'no ready snapshot to backfill from' },
        ],
      });
    });

    it.each<[string, (h: Harness) => void, (h: Harness) => void, Record<string, unknown>, Record<string, unknown>, string[]]>([
      [
        'its start failed after the stop: the health check fails and the owner is restarted',
        (h) => h.processControl.restart.mockRejectedValueOnce(new ProcessControlError('people', 'start', NO_START)),
        (h) => h.processControl.waitHealthy.mockRejectedValueOnce(new ProcessControlError('people', 'health', NO_HEALTH)),
        { triggered: true, healthy: false, step: 'start', oldPid: OLD_PID, newPid: undefined },
        { pid: NEW_PID, healthyMs: 4, action: 'restart' },
        ['waitHealthy', 'restart', 'runFeed'],
      ],
      [
        'its replacement turned healthy only after the restart gave up: the health check passes without a restart',
        (h) =>
          h.processControl.restart.mockImplementationOnce(async () => {
            h.recordPid(NEW_PID);
            throw new ProcessControlError('people', 'health', NO_HEALTH);
          }),
        () => undefined,
        { triggered: true, healthy: false, step: 'health', oldPid: OLD_PID, newPid: NEW_PID },
        { pid: NEW_PID, healthyMs: 12, action: 'health-check' },
        ['waitHealthy', 'runFeed'],
      ],
    ])('restores the owner before the re-run when %s', async (_case, arrangeRun, arrangeResume, progress, restored, order) => {
      const h = await harness({ failing: (_owner, call) => call === 2 });
      arrangeRun(h);
      vi.mocked(runFeed).mockImplementation(sending(['people', 'people']));
      const runOutput = await serviceRestartedMidApply.run(h.env, PARAMS);
      expect(runOutput.state?.['restart']).toStrictEqual(progress);
      h.processControl.restart.mockClear();
      h.processControl.waitHealthy.mockClear();
      vi.mocked(runFeed).mockReset().mockResolvedValue(commandResult(4, 0));
      arrangeResume(h);

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, runOutput);

      expect(callOrder({ waitHealthy: h.processControl.waitHealthy, restart: h.processControl.restart, runFeed: vi.mocked(runFeed) })).toStrictEqual(order);
      expect(h.processControl.waitHealthy).toHaveBeenCalledExactlyOnceWith('people', { timeoutMs: 5000 });
      expect(runFeed).toHaveBeenCalledExactlyOnceWith(h.ctx, {});
      expect(resumed.steps).toStrictEqual([RESTORE_STEP, 'rerun-feed']);
      expect(resumed.assertions).toStrictEqual([
        { name: 'owner-restored', status: 'pass', detail: restored },
        expect.objectContaining({ name: 'rerun-idempotent', status: 'pass' }),
      ]);
    });

    it('fails owner-restored and does not re-run the apply when the owner cannot be restored', async () => {
      const h = await harness();
      h.processControl.waitHealthy.mockRejectedValueOnce(new ProcessControlError('people', 'health', NO_HEALTH));
      h.processControl.restart.mockRejectedValueOnce(new ProcessControlError('people', 'stop', STALE));
      const restart = { triggered: true, healthy: false, step: 'start', oldPid: OLD_PID };

      const resumed = await serviceRestartedMidApply.resume(h.env, PARAMS, output({ command: 'feed', resumeSeq: 4, restart }));

      expect(resumed).toStrictEqual({
        steps: [RESTORE_STEP],
        assertions: [
          { name: 'owner-restored', status: 'fail', detail: { step: 'stop', error: `people stop: ${STALE}` } },
          {
            name: 'rerun-idempotent',
            status: 'fail',
            detail: { command: 'feed', owner: 'people' },
            reason: 'the owner was not restored, so the apply was not re-run',
          },
        ],
      });
      expect(runFeed).not.toHaveBeenCalled();
      expect(h.processControl.restart).toHaveBeenCalledExactlyOnceWith('people', { timeoutMs: 5000 });
      expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
        { error: expect.objectContaining({ type: 'ProcessControlError', message: REDACTED }) },
        'fault service-restarted-mid-apply: people is not healthy before the re-run; restarting it',
      );
      expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
        { error: expect.objectContaining({ type: 'ProcessControlError', message: REDACTED }) },
        'fault service-restarted-mid-apply: restoring people failed; the apply is not re-run',
      );
    });
  });
});
