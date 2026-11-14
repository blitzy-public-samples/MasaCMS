// Scripted fault applier-killed-mid-batch: an opt2-migrate feed or backfill child exits after its Nth acknowledged batch, then the same run is repeated in process.
import { z } from '@opt2/platform/service-kit';

import { runBackfill, runFeed, type BackfillResult, type FeedResult } from '../../apply/index.js';
import { getSnapshot, latestSnapshot, type SnapshotContext, type SnapshotRecord } from '../../snapshot/index.js';
import { migrateCliPath, spawnChild, type ChildOutcome } from '../process-control.js';
import { fail, pass, type FaultAssertion, type FaultResumeOutput, type FaultScript } from './types.js';

const FAULT = 'applier-killed-mid-batch';
const KILLED_MID_RUN = 'killed-mid-run';
const RERUN_IDEMPOTENT = 'rerun-idempotent';
// The status apply/batch.ts exits with once the armed batch has been acknowledged.
const KILLED_EXIT_CODE = 137;
const COMMANDS = ['feed', 'backfill'] as const;

const paramsSchema = z
  .object({
    command: z.enum(COMMANDS).default('feed'),
    killAfter: z.number().int().min(1).default(1),
    snapshotSeq: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().default(600_000),
  })
  .strict();

/** Parameters of {@link applierKilledMidBatch}; `snapshotSeq` selects the backfill snapshot and is ignored by `feed`. */
export type ApplierKilledParams = z.output<typeof paramsSchema>;

type Command = ApplierKilledParams['command'];

type RerunResult = Pick<FeedResult | BackfillResult, 'snapshotSeq' | 'exitCode' | 'reconciliation'>;

// The run state is written by `run` itself, but arrives untyped through FaultRunOutput.
const runStateSchema = z.object({
  command: z.enum(COMMANDS),
  resumeSeq: z.number().int().min(0).optional(),
});

/** The ready snapshot with the lowest sequence, or undefined when none is ready. */
async function earliestSnapshot(ctx: Pick<SnapshotContext, 'db'>): Promise<SnapshotRecord | undefined> {
  const latest = await latestSnapshot(ctx);
  if (latest === null) return undefined;
  // runBackfill refuses a snapshot that is not ready, so failed and dropped sequences are passed over.
  for (let seq = 0; seq < latest.seq; seq += 1) {
    const snapshot = await getSnapshot(ctx, seq);
    if (snapshot?.state === 'ready') return snapshot;
  }
  return latest;
}

/** Whether the child stopped at the armed batch, judged from its outcome. */
function killedMidRun(command: Command, killAfter: number, outcome: ChildOutcome): FaultAssertion {
  const { exitCode, signal, timedOut, stderrTail } = outcome;
  if (!timedOut && exitCode === KILLED_EXIT_CODE) return pass(KILLED_MID_RUN, { exitCode, killAfter });
  if (!timedOut && exitCode === 0) {
    // A clean exit means the run sent fewer than killAfter batches, so the fault never fired.
    const reason =
      command === 'feed'
        ? "run the deterministic legacy workload before this fault or pass {command:'backfill'}"
        : 'the backfill sent fewer batches than killAfter; pass a lower killAfter';
    return fail(KILLED_MID_RUN, { exitCode, killAfter }, reason);
  }
  return fail(KILLED_MID_RUN, { exitCode, signal, timedOut, stderrTail });
}

/** Runs the re-run `apply` and judges it; `resumeSeq` is the snapshot asked for, undefined when the feed takes a new one. */
async function rerun(command: Command, resumeSeq: number | undefined, apply: () => Promise<RerunResult>): Promise<FaultResumeOutput> {
  let assertion: FaultAssertion;
  try {
    const result = await apply();
    const detail = { snapshotSeq: result.snapshotSeq, exitCode: result.exitCode };
    assertion =
      result.exitCode === 0 ? pass(RERUN_IDEMPOTENT, detail) : fail(RERUN_IDEMPOTENT, { ...detail, reconciliation: result.reconciliation });
  } catch (err) {
    // Reported rather than rethrown, so runFault still reconciles after the failed re-run.
    assertion = fail(RERUN_IDEMPOTENT, { snapshotSeq: resumeSeq, error: err instanceof Error ? err.message : String(err) });
  }
  return { steps: [`rerun-${command}`], assertions: [assertion], details: { command, resumeSeq } };
}

/** Kills a real `opt2-migrate` applier mid-run through its `OPT2_FAULT` hook, then proves that re-running it converges. */
export const applierKilledMidBatch: FaultScript<ApplierKilledParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,

  async run(env, params) {
    const { command, killAfter } = params;
    const seqBefore = (await latestSnapshot(env.ctx))?.seq;
    const backfill = command === 'backfill';
    const seq = backfill ? (params.snapshotSeq ?? (await earliestSnapshot(env.ctx))?.seq) : undefined;
    const selection = backfill ? { snapshotSeq: seq } : { snapshotSeqIgnored: params.snapshotSeq };
    if (backfill && seq === undefined) {
      return {
        assertions: [fail(KILLED_MID_RUN, 'no snapshot exists', 'take S0 and backfill before this fault')],
        details: { command, killAfter, seqBefore, ...selection },
        state: { command },
      };
    }

    // The hook goes to the child only: apply/batch.ts reads OPT2_FAULT once at load, so this process stays unarmed.
    const outcome = await spawnChild(
      process.execPath,
      [migrateCliPath(), command, ...(backfill ? ['--snapshot', String(seq)] : [])],
      { env: { ...process.env, OPT2_FAULT: `apply:kill-after:${String(killAfter)}` }, timeoutMs: params.timeoutMs },
    );
    const seqAfter = (await latestSnapshot(env.ctx))?.seq;
    // The killed feed took snapshot n+1 before its first batch; resuming on it repeats the batch ids already acknowledged.
    const resumeSeq = backfill ? seq : seqAfter === seqBefore ? undefined : seqAfter;
    const { exitCode, signal, timedOut } = outcome;
    return {
      assertions: [killedMidRun(command, killAfter, outcome)],
      details: { command, killAfter, exitCode, signal, timedOut, seqBefore, seqAfter, ...selection },
      state: { command, resumeSeq },
    };
  },

  async resume(env, params, output) {
    const parsed = runStateSchema.safeParse(output?.state);
    const command = parsed.success ? parsed.data.command : params.command;
    const recorded = parsed.success ? parsed.data.resumeSeq : undefined;
    if (command === 'feed') {
      return rerun(command, recorded, () => runFeed(env.ctx, recorded === undefined ? {} : { snapshotSeq: recorded }));
    }
    const resumeSeq = recorded ?? params.snapshotSeq ?? (await earliestSnapshot(env.ctx))?.seq;
    if (resumeSeq === undefined) {
      const assertion = fail(RERUN_IDEMPOTENT, 'no snapshot exists', 'take S0 and backfill before this fault');
      return { steps: [], assertions: [assertion], details: { command } };
    }
    return rerun(command, resumeSeq, () => runBackfill(env.ctx, { snapshotSeq: resumeSeq }));
  },
};
