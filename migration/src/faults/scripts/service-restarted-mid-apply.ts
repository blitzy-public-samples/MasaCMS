// Scripted fault service-restarted-mid-apply: restarts an owning service while a feed or backfill is sending it batches.
import { z } from '@opt2/platform/service-kit';

import { runBackfill, runFeed, type BackfillResult, type FeedResult } from '../../apply/index.js';
import { createMigrationContext, type MigrationContext } from '../../context.js';
import type { ApplyResult, DataOwner, OwnersClient } from '../../owners/index.js';
import { getSnapshot, latestSnapshot } from '../../snapshot/index.js';
import type { ProcessRestartResult } from '../process-control.js';
import { fail, pass, skipped, type FaultAssertion, type FaultEnv, type FaultRunOutput, type FaultScript } from './types.js';

const FAULT = 'service-restarted-mid-apply';
const INTERRUPTED = 'apply-interrupted';
const HEALTHY = 'owner-healthy';
const RERUN = 'rerun-idempotent';
const WORKLOAD_REASON = "run the deterministic legacy workload before this fault or pass {command:'backfill'}";
const NO_APPLY_REASON = 'no apply reached the restarting owner';
const NO_SNAPSHOT_REASON = 'no ready snapshot to backfill from';

const commandSchema = z.enum(['feed', 'backfill']);

const paramsSchema = z
  .object({
    owner: z.string().default('people'),
    afterBatches: z.number().int().min(1).default(1),
    command: commandSchema.default('feed'),
    snapshotSeq: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

/** Parameters of {@link serviceRestartedMidApply}. */
export type ServiceRestartParams = z.output<typeof paramsSchema>;

/** What `run` hands to `resume`: the interrupted command and the snapshot whose batch ids a re-run repeats. */
const stateSchema = z.object({ command: commandSchema, resumeSeq: z.number().int().min(0).optional() }).strict();

type Command = z.output<typeof commandSchema>;

/** A command with its snapshot: a feed resumes on `snapshotSeq` when set, a backfill always loads it. */
type Plan = { command: 'feed'; snapshotSeq: number | undefined } | { command: 'backfill'; snapshotSeq: number };

type RunOutcome = { ok: true; result: FeedResult | BackfillResult } | { ok: false; error: unknown };

type RestartOutcome = { ok: true; result: ProcessRestartResult } | { ok: false; error: string };

/** Batches the restarting owner acknowledged, whether its restart started, and the first apply to it that failed afterwards. */
interface RestartStats {
  acknowledged: number;
  restartStarted: boolean;
  failedAfterRestart?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDataOwner(owners: readonly DataOwner[], name: string): name is DataOwner {
  return (owners as readonly string[]).includes(name);
}

/** Why `owner` cannot be restarted from up.json, or undefined when its entry records the port the restart checks health on. */
function entryProblem(processControl: FaultEnv['processControl'], owner: DataOwner): string | undefined {
  try {
    return processControl.entry(owner).port === undefined ? `the up.json entry of ${owner} records no port` : undefined;
  } catch (error) {
    return messageOf(error);
  }
}

/** `owners` whose `apply` counts `owner`'s acknowledged batches and calls `startRestart` once, after the `afterBatches`-th. */
function wrapOwners(
  owners: OwnersClient,
  owner: DataOwner,
  afterBatches: number,
  startRestart: () => void,
): { client: OwnersClient; stats: RestartStats } {
  const stats: RestartStats = { acknowledged: 0, restartStarted: false };
  const apply: OwnersClient['apply'] = async (target, request) => {
    let result: ApplyResult;
    try {
      result = await owners.apply(target, request);
    } catch (error) {
      if (target === owner && stats.restartStarted) stats.failedAfterRestart ??= messageOf(error);
      throw error;
    }
    if (target === owner) {
      stats.acknowledged += 1;
      if (stats.acknowledged >= afterBatches && !stats.restartStarted) {
        stats.restartStarted = true;
        startRestart();
      }
    }
    return result;
  };
  return { client: { ...owners, apply }, stats };
}

/** Sequence of the ready snapshot with the lowest sequence, or undefined when none is ready. */
async function earliestSnapshot(ctx: Pick<MigrationContext, 'db'>): Promise<number | undefined> {
  const latest = await latestSnapshot(ctx);
  if (latest === null) return undefined;
  for (let seq = 0; seq < latest.seq; seq += 1) {
    if ((await getSnapshot(ctx, seq))?.state === 'ready') return seq;
  }
  return latest.seq;
}

/** The plan for `command`; a backfill without `snapshotSeq` loads the earliest ready snapshot, and null means there is none. */
async function planFor(ctx: MigrationContext, command: Command, snapshotSeq: number | undefined): Promise<Plan | null> {
  if (command === 'feed') return { command, snapshotSeq };
  const seq = snapshotSeq ?? (await earliestSnapshot(ctx));
  return seq === undefined ? null : { command, snapshotSeq: seq };
}

function runPlan(ctx: MigrationContext, plan: Plan): Promise<FeedResult | BackfillResult> {
  if (plan.command === 'backfill') return runBackfill(ctx, { snapshotSeq: plan.snapshotSeq });
  return runFeed(ctx, plan.snapshotSeq === undefined ? {} : { snapshotSeq: plan.snapshotSeq });
}

/** `apply-interrupted`: passes only when an apply to the owner failed after its restart started and the run did not succeed. */
function interruptedAssertion(stats: RestartStats, afterBatches: number, outcome: RunOutcome): FaultAssertion {
  const { acknowledged, restartStarted, failedAfterRestart } = stats;
  const ended = outcome.ok ? { exitCode: outcome.result.exitCode } : { error: messageOf(outcome.error) };
  if (!restartStarted) {
    return outcome.ok
      ? fail(INTERRUPTED, { acknowledged, afterBatches, ...ended }, WORKLOAD_REASON)
      : fail(INTERRUPTED, { acknowledged, afterBatches, ...ended });
  }
  if (failedAfterRestart === undefined) return fail(INTERRUPTED, { acknowledged, ...ended }, NO_APPLY_REASON);
  if (!outcome.ok || outcome.result.exitCode !== 0) return pass(INTERRUPTED, { acknowledged, failedAfterRestart });
  return fail(INTERRUPTED, { acknowledged, failedAfterRestart, ...ended }, 'the run succeeded although an apply to the restarting owner failed');
}

/** `owner-healthy` once the started restart settled: `/healthz` answers 200 and up.json names the new pid. */
async function healthyAssertion(
  env: FaultEnv,
  owner: DataOwner,
  restart: Promise<RestartOutcome>,
  timeoutMs: number,
): Promise<FaultAssertion> {
  const outcome = await restart;
  if (!outcome.ok) return fail(HEALTHY, { error: outcome.error });
  const { oldPid, newPid } = outcome.result;
  try {
    const healthyMs = await env.processControl.waitHealthy(owner, { timeoutMs });
    return pass(HEALTHY, { oldPid, pid: env.processControl.entry(owner).pid, healthyMs });
  } catch (error) {
    return fail(HEALTHY, { oldPid, newPid, error: messageOf(error) });
  }
}

/** Restarts an owner mid-apply, asserts the run failed and the owner came back healthy, then re-runs the command to convergence. */
export const serviceRestartedMidApply: FaultScript<ServiceRestartParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,

  async run(env, params) {
    const { ctx, processControl } = env;
    const { owner, afterBatches, command, timeoutMs } = params;
    const details: Record<string, unknown> = { owner, command, afterBatches };
    // No `state`: resume then knows nothing ran and leaves the owner's data as it was.
    const refused = (reason: string): FaultRunOutput => ({ assertions: [fail(INTERRUPTED, { owner, command }, reason)], details });

    if (!isDataOwner(ctx.config.dataOwners, owner)) {
      return refused(`${owner} is not a data owner; known: ${ctx.config.dataOwners.join(', ')}`);
    }
    const problem = entryProblem(processControl, owner);
    if (problem !== undefined) return refused(problem);
    const plan = await planFor(ctx, command, params.snapshotSeq);
    if (plan === null) return refused(NO_SNAPSHOT_REASON);

    const seqBefore = (await latestSnapshot(ctx))?.seq;
    const restart: { pending?: Promise<RestartOutcome> } = {};
    const wrapped = wrapOwners(ctx.owners, owner, afterBatches, () => {
      env.logger.warn(`fault ${FAULT} restarting ${owner} after ${String(afterBatches)} acknowledged batches`);
      // Not awaited, so the run keeps sending batches while the owner goes down.
      restart.pending = processControl.restart(owner, { timeoutMs }).then(
        (result): RestartOutcome => ({ ok: true, result }),
        (error: unknown): RestartOutcome => ({ ok: false, error: messageOf(error) }),
      );
    });
    // Every port is ctx's own, so this context owns nothing and is never closed.
    const wrappedCtx = await createMigrationContext({
      env: ctx.env,
      clock: ctx.clock,
      logger: ctx.logger,
      db: ctx.db,
      legacy: ctx.legacy,
      bridge: ctx.bridge,
      catalog: ctx.catalog,
      gateway: ctx.gateway,
      client: ctx.client,
      owners: wrapped.client,
    });

    let outcome: RunOutcome;
    try {
      outcome = { ok: true, result: await runPlan(wrappedCtx, plan) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const assertions = [interruptedAssertion(wrapped.stats, afterBatches, outcome)];
    assertions.push(
      restart.pending === undefined
        ? skipped(HEALTHY, 'restart not triggered')
        : await healthyAssertion(env, owner, restart.pending, timeoutMs),
    );

    const seqAfter = (await latestSnapshot(ctx))?.seq;
    // A feed re-run repeats batch ids only on the feed snapshot the interrupted run took.
    const resumeSeq =
      plan.command === 'feed' ? (plan.snapshotSeq ?? (seqAfter !== seqBefore ? seqAfter : undefined)) : plan.snapshotSeq;
    const { acknowledged, failedAfterRestart } = wrapped.stats;
    return {
      assertions,
      details: { ...details, acknowledged, failedAfterRestart, seqBefore, seqAfter },
      state: { command, resumeSeq },
    };
  },

  async resume(env, params, output) {
    if (output !== undefined && output.state === undefined) {
      return { steps: [], assertions: [skipped(RERUN, 'the fault was refused before any batch was sent')] };
    }
    // Without output the run threw part-way, so the command is re-run as the parameters ask.
    const { command, resumeSeq } =
      output?.state === undefined ? { command: params.command, resumeSeq: params.snapshotSeq } : stateSchema.parse(output.state);
    const step = `rerun-${command}`;
    try {
      const plan = await planFor(env.ctx, command, resumeSeq);
      if (plan === null) return { steps: [], assertions: [fail(RERUN, { command }, NO_SNAPSHOT_REASON)] };
      const result = await runPlan(env.ctx, plan);
      const summary = {
        command,
        snapshotSeq: result.snapshotSeq,
        exitCode: result.exitCode,
        reconciliation: result.reconciliation.result,
        reportPath: result.reconciliation.reportPath,
      };
      return { steps: [step], assertions: [result.exitCode === 0 ? pass(RERUN, summary) : fail(RERUN, summary)], details: summary };
    } catch (error) {
      return { steps: [step], assertions: [fail(RERUN, { command, snapshotSeq: resumeSeq, error: messageOf(error) })] };
    }
  },
};
