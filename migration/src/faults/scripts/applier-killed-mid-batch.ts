// Scripted fault applier-killed-mid-batch: an opt2-migrate feed or backfill child exits while its Nth apply is in flight, or once the owner acknowledged it, then the same run is repeated in process.
import { z } from '@opt2/platform/service-kit';

import { parseInFlightKill, runBackfill, runFeed, type BackfillResult, type FeedResult, type InFlightKill } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import type { DataOwner, OwnersClient } from '../../owners/index.js';
import { getSnapshot, latestSnapshot, type SnapshotContext, type SnapshotRecord } from '../../snapshot/index.js';
import { migrateCliPath, spawnChild, type ChildOutcome } from '../process-control.js';
import { fail, pass, type FaultAssertion, type FaultResumeOutput, type FaultScript } from './types.js';

const FAULT = 'applier-killed-mid-batch';
const KILLED_MID_RUN = 'killed-mid-run';
const RERUN_IDEMPOTENT = 'rerun-idempotent';
const IN_FLIGHT_RESENT = 'in-flight-batch-resent';
// The status apply/batch.ts exits with at the armed batch.
const KILLED_EXIT_CODE = 137;
const COMMANDS = ['feed', 'backfill'] as const;
const POINTS = ['in-flight', 'acknowledged'] as const;

type Point = (typeof POINTS)[number];

// The OPT2_FAULT entry apply/batch.ts arms for each point.
const HOOKS: Readonly<Record<Point, string>> = { 'in-flight': 'apply:kill-in-flight', acknowledged: 'apply:kill-after' };

const paramsSchema = z
  .object({
    command: z.enum(COMMANDS).default('feed'),
    point: z.enum(POINTS).default('in-flight'),
    batch: z.number().int().min(1).default(1),
    snapshotSeq: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().default(600_000),
  })
  .strict();

/** Parameters of {@link applierKilledMidBatch}: the child exits at `point` of its `batch`-th apply; `snapshotSeq` selects the backfill snapshot and is ignored by `feed`. */
export type ApplierKilledParams = z.output<typeof paramsSchema>;

type Command = ApplierKilledParams['command'];

type RerunResult = Pick<FeedResult | BackfillResult, 'snapshotSeq' | 'exitCode' | 'reconciliation'>;

/** One apply of the re-run, with the owner's `duplicate` answer. */
interface SentBatch {
  owner: DataOwner;
  batchId: string;
  duplicate: boolean;
}

// The run state is written by `run` itself, but arrives untyped through FaultRunOutput.
const runStateSchema = z.object({
  command: z.enum(COMMANDS),
  point: z.enum(POINTS).optional(),
  resumeSeq: z.number().int().min(0).optional(),
  inFlight: z.object({ owner: z.string(), legacyTable: z.string(), batchId: z.string(), batch: z.number().int() }).optional(),
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

/** Whether the child stopped at the armed batch, judged from its outcome and, for `in-flight`, the marker it wrote. */
function killedMidRun(command: Command, point: Point, batch: number, outcome: ChildOutcome, inFlight: InFlightKill | null): FaultAssertion {
  const { exitCode, signal, timedOut, stderrTail } = outcome;
  if (!timedOut && exitCode === KILLED_EXIT_CODE) {
    if (point === 'acknowledged') return pass(KILLED_MID_RUN, { exitCode, point, batch });
    // The marker's `batch` is the ordinal the child counted to, equal to the armed one.
    if (inFlight !== null) return pass(KILLED_MID_RUN, { exitCode, point, ...inFlight });
    return fail(KILLED_MID_RUN, { exitCode, point, batch, stderrTail }, 'the child exited 137 without naming an in-flight apply');
  }
  if (!timedOut && exitCode === 0) {
    // A clean exit means the run sent fewer than `batch` batches, so the fault never fired.
    const reason =
      command === 'feed'
        ? "run the deterministic legacy workload before this fault or pass {command:'backfill'}"
        : 'the backfill sent fewer batches than `batch`; pass a lower batch';
    return fail(KILLED_MID_RUN, { exitCode, point, batch }, reason);
  }
  return fail(KILLED_MID_RUN, { exitCode, signal, timedOut, stderrTail });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `owners` whose `apply` records each batch it sent with the owner's `duplicate` answer. */
function recordingOwners(owners: OwnersClient): { client: OwnersClient; sent: SentBatch[] } {
  const sent: SentBatch[] = [];
  const apply: OwnersClient['apply'] = async (owner, request) => {
    const result = await owners.apply(owner, request);
    sent.push({ owner, batchId: request.batchId, duplicate: result.duplicate });
    return result;
  };
  return { client: { ...owners, apply }, sent };
}

/** `in-flight-batch-resent`: the re-run resent the interrupted batch, or skipped it as a feed whose owner watermark shows it committed. */
async function inFlightResent(
  ctx: MigrationContext,
  command: Command,
  killed: InFlightKill | undefined,
  sent: readonly SentBatch[],
  resumeSeq: number | undefined,
  result: RerunResult | undefined,
): Promise<FaultAssertion> {
  if (killed === undefined) return fail(IN_FLIGHT_RESENT, { command }, 'the killed run named no in-flight apply');
  const { owner, legacyTable, batchId } = killed;
  const resent = sent.find((batch) => batch.owner === owner && batch.batchId === batchId);
  if (resent !== undefined) return pass(IN_FLIGHT_RESENT, { batchId, owner, legacyTable, resent: true, duplicate: resent.duplicate });
  const detail = { batchId, owner, legacyTable, resent: false, applies: sent.length };
  const sameSnapshot = command === 'feed' && resumeSeq !== undefined && result?.snapshotSeq === resumeSeq;
  if (!sameSnapshot || !(ctx.config.dataOwners as readonly string[]).includes(owner)) {
    return fail(IN_FLIGHT_RESENT, detail, 'the re-run never resent the batch the kill interrupted');
  }
  // A feed re-run skips a table whose watermark reached its snapshot; only the interrupted batch can have carried it there.
  try {
    const watermarkSeq = (await ctx.owners.watermark(owner as DataOwner, legacyTable, 'forward'))?.snapshotSeq ?? null;
    if (watermarkSeq !== null && watermarkSeq >= resumeSeq) return pass(IN_FLIGHT_RESENT, { ...detail, watermarkSeq });
    return fail(IN_FLIGHT_RESENT, { ...detail, watermarkSeq }, 'the re-run never resent the batch the kill interrupted');
  } catch (error) {
    return fail(IN_FLIGHT_RESENT, { ...detail, error: messageOf(error) });
  }
}

/** Runs the re-run `apply` and judges it, and with it `resent` when given; `resumeSeq` is the snapshot asked for, undefined when the feed takes a new one. */
async function rerun(
  command: Command,
  resumeSeq: number | undefined,
  apply: () => Promise<RerunResult>,
  resent?: (result: RerunResult | undefined) => Promise<FaultAssertion>,
): Promise<FaultResumeOutput> {
  let assertion: FaultAssertion;
  let result: RerunResult | undefined;
  try {
    result = await apply();
    const detail = { snapshotSeq: result.snapshotSeq, exitCode: result.exitCode };
    assertion =
      result.exitCode === 0 ? pass(RERUN_IDEMPOTENT, detail) : fail(RERUN_IDEMPOTENT, { ...detail, reconciliation: result.reconciliation });
  } catch (err) {
    // Reported rather than rethrown, so runFault still reconciles after the failed re-run.
    assertion = fail(RERUN_IDEMPOTENT, { snapshotSeq: resumeSeq, error: messageOf(err) });
  }
  const assertions = resent === undefined ? [assertion] : [assertion, await resent(result)];
  return { steps: [`rerun-${command}`], assertions, details: { command, resumeSeq } };
}

/** Kills a real `opt2-migrate` applier mid-run through its `OPT2_FAULT` hook, then proves that re-running it converges. */
export const applierKilledMidBatch: FaultScript<ApplierKilledParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,

  async run(env, params) {
    const { command, point, batch } = params;
    const seqBefore = (await latestSnapshot(env.ctx))?.seq;
    const backfill = command === 'backfill';
    const seq = backfill ? (params.snapshotSeq ?? (await earliestSnapshot(env.ctx))?.seq) : undefined;
    const selection = backfill ? { snapshotSeq: seq } : { snapshotSeqIgnored: params.snapshotSeq };
    if (backfill && seq === undefined) {
      return {
        assertions: [fail(KILLED_MID_RUN, 'no snapshot exists', 'take S0 and backfill before this fault')],
        details: { command, point, batch, seqBefore, ...selection },
        state: { command, point },
      };
    }

    // The hook goes to the child only: apply/batch.ts reads OPT2_FAULT once at load, so this process stays unarmed.
    const outcome = await spawnChild(
      process.execPath,
      [migrateCliPath(), command, ...(backfill ? ['--snapshot', String(seq)] : [])],
      { env: { ...process.env, OPT2_FAULT: `${HOOKS[point]}:${String(batch)}` }, timeoutMs: params.timeoutMs },
    );
    const seqAfter = (await latestSnapshot(env.ctx))?.seq;
    // The killed feed took snapshot n+1 before its first batch; resuming on it repeats the batch ids already sent.
    const resumeSeq = backfill ? seq : seqAfter === seqBefore ? undefined : seqAfter;
    const { exitCode, signal, timedOut } = outcome;
    const inFlight = point === 'in-flight' ? parseInFlightKill(outcome.stderrTail) : null;
    const killed = inFlight === null ? {} : { inFlight };
    return {
      assertions: [killedMidRun(command, point, batch, outcome, inFlight)],
      details: { command, point, batch, exitCode, signal, timedOut, seqBefore, seqAfter, ...selection, ...killed },
      state: { command, point, resumeSeq, ...killed },
    };
  },

  async resume(env, params, output) {
    const parsed = runStateSchema.safeParse(output?.state);
    const state = parsed.success ? parsed.data : undefined;
    const command = state?.command ?? params.command;
    const recorded = state?.resumeSeq;
    // Only an in-flight kill leaves a batch whose resend is checked, so only then are the re-run's applies recorded.
    const recording = (state?.point ?? params.point) === 'in-flight' ? recordingOwners(env.ctx.owners) : undefined;
    const ctx: MigrationContext = recording === undefined ? env.ctx : { ...env.ctx, owners: recording.client };
    const resentOn = (seq: number | undefined): ((result: RerunResult | undefined) => Promise<FaultAssertion>) | undefined =>
      recording === undefined ? undefined : (result) => inFlightResent(env.ctx, command, state?.inFlight, recording.sent, seq, result);
    if (command === 'feed') {
      return rerun(command, recorded, () => runFeed(ctx, recorded === undefined ? {} : { snapshotSeq: recorded }), resentOn(recorded));
    }
    const resumeSeq = recorded ?? params.snapshotSeq ?? (await earliestSnapshot(env.ctx))?.seq;
    if (resumeSeq === undefined) {
      const assertion = fail(RERUN_IDEMPOTENT, 'no snapshot exists', 'take S0 and backfill before this fault');
      return { steps: [], assertions: [assertion], details: { command } };
    }
    return rerun(command, resumeSeq, () => runBackfill(ctx, { snapshotSeq: resumeSeq }), resentOn(resumeSeq));
  },
};
