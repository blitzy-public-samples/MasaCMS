/** `opt2-ops drain-and-suspend`: drains, stops producers and their running work, drains again, then pauses the sweeps and moves push to pull, recording what it paused. */
import { setTimeout as delay } from 'node:timers/promises';

import { callQueueControl, outboxSweepQueue, queuesCreatedBy } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import { GatewayWaitTimeoutError, type InflightRow } from '../cutover/gateway-client.js';
import { createSchedulerService, type SchedulerContext, type SchedulerService } from '../scheduler/index.js';
import { remoteBackgroundState, type BackgroundRecord, type BackgroundStateApi } from './background.js';
import { DEFAULT_DRAIN_POLL_MS, SWEEP_PRODUCERS, awaitDrained, type DrainContext, type DrainResult } from './drain.js';
import {
  createPubSub,
  isPushConfig,
  listOpt2Subscriptions,
  readPushConfig,
  redactEndpoint,
  setPushConfig,
  type PubSubLike,
  type SavedPushConfig,
  type SubscriptionLike,
} from './subscriptions.js';

/** A task queue paused at one of its creating services through that service's queue-control route. */
export interface QueueTarget {
  service: string;
  queue: string;
}

/** A paused queue that still counted running tasks, with their number. */
export interface RunningQueue extends QueueTarget {
  running: number;
}

/** Paused queues still ran tasks when the barrier's budget ran out; `queues` holds their last counts. */
export class InvocationsRunningError extends Error {
  override readonly name: string = 'InvocationsRunningError';
  readonly timeoutMs: number;
  readonly queues: RunningQueue[];

  constructor(timeoutMs: number, queues: readonly RunningQueue[]) {
    const named = queues.map(({ service, queue, running }) => `${queue} on ${service} (${String(running)})`);
    super(`tasks still running after ${String(timeoutMs)} ms: ${named.join(', ')}`);
    this.timeoutMs = timeoutMs;
    this.queues = queues.map(({ service, queue, running }) => ({ service, queue, running }));
  }
}

/** Dead gateway instances hold in-flight writes that may still commit; `rows` names them. */
export class OrphanedWritesError extends Error {
  override readonly name: string = 'OrphanedWritesError';
  readonly rows: InflightRow[];

  constructor(rows: readonly InflightRow[]) {
    const named = rows.map((row) => `${row.instanceId} ${row.side} ${row.route} (${String(row.count)} since ${row.oldestStartedAt})`);
    super(`In-flight writes of dead gateway instances clear only with legacy-restart or gates-closed evidence: ${named.join(', ')}`);
    this.rows = rows.map(({ instanceId, route, side, count, oldestStartedAt }) => ({ instanceId, route, side, count, oldestStartedAt }));
  }
}

/** Reason stored in the background record when neither the caller nor the stored record names one. */
const DEFAULT_SUSPEND_REASON = 'drain-and-suspend';

/** Outbox sweep queues; they keep publishing until the final drain, then pause last. */
const SWEEP_QUEUES: ReadonlySet<string> = new Set([...SWEEP_PRODUCERS].map((producer) => outboxSweepQueue(producer)));

/** The context members drain-and-suspend uses. */
export type DrainAndSuspendContext = DrainContext & SchedulerContext & Pick<MigrationContext, 'clientAs' | 'gateway'>;

/** Ports and settings of {@link drainAndSuspend}; each absent port is created from the context. */
export interface DrainAndSuspendOptions {
  /** `remoteBackgroundState(ctx)` when absent; the migration service passes `createBackgroundState(ctx)`. */
  background?: BackgroundStateApi;
  /** `createPubSub(ctx.env)` when absent, closed when the run ends. */
  pubsub?: PubSubLike;
  /** `createSchedulerService(ctx)` when absent. */
  scheduler?: Pick<SchedulerService, 'pauseAll'>;
  /** Stored as the record's `reason`; the stored reason, else `drain-and-suspend`, when absent. */
  reason?: string;
  /** Pause between drain and barrier polls; node timers when absent. */
  sleep?: (ms: number) => Promise<void>;
}

/** What one run drained and paused; subscription names only, since a push endpoint may carry the local push key. */
export interface DrainAndSuspendResult {
  /** The record was already suspended when the run began. */
  alreadySuspended: boolean;
  /** Drain before producers were stopped. */
  drained: DrainResult;
  /** Drain after producers stopped and their running work ended, with the sweeps and push delivery still live. */
  finalDrained: DrainResult;
  /** ACF task names this run's `pauseAll` reported paused. */
  pausedTasks: string[];
  /** Queues this run paused. */
  pausedQueues: QueueTarget[];
  /** Subscriptions this run switched from push to pull. */
  switchedToPull: string[];
  /** The background record as finally stored, each saved push endpoint without its query string. */
  record: BackgroundRecord;
}

/** A live OPT-2 subscription and its push config, `null` in pull mode. */
interface CapturedSubscription {
  name: string;
  subscription: SubscriptionLike;
  push: SavedPushConfig | null;
}

function compareTargets(a: QueueTarget, b: QueueTarget): number {
  if (a.service !== b.service) return a.service < b.service ? -1 : 1;
  return a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0;
}

/** De-duplicated targets of every list, sorted by service, then queue. */
function unionTargets(...lists: readonly (readonly QueueTarget[])[]): QueueTarget[] {
  const byKey = new Map<string, QueueTarget>();
  for (const { service, queue } of lists.flat()) byKey.set(JSON.stringify([service, queue]), { service, queue });
  return [...byKey.values()].sort(compareTargets);
}

/** Every queue each service of `serviceUrls` creates, as (service, queue) pairs sorted by service, then queue. */
export function queueControlTargets(serviceUrls: Record<string, string>): QueueTarget[] {
  return unionTargets(
    Object.keys(serviceUrls)
      .sort()
      .flatMap((service) => queuesCreatedBy(service).map(({ name: queue }) => ({ service, queue }))),
  );
}

/** Saved push configs: every saved entry unchanged, plus each subscription now in push mode that has none. */
function mergePushConfigs(
  saved: Readonly<Record<string, SavedPushConfig>>,
  captured: readonly CapturedSubscription[],
): Record<string, SavedPushConfig> {
  const merged: Record<string, SavedPushConfig> = { ...saved };
  for (const { name, push } of captured) {
    if (push !== null && !Object.hasOwn(merged, name)) merged[name] = push;
  }
  return merged;
}

/** `record` for output: the result is printed, and a saved local push endpoint carries the push key in its query string. */
function redactedRecord(record: BackgroundRecord): BackgroundRecord {
  const pushConfigs = Object.fromEntries(
    Object.entries(record.pushConfigs).map(([name, cfg]) => [
      name,
      isPushConfig(cfg) ? { ...cfg, pushEndpoint: redactEndpoint(cfg.pushEndpoint) } : cfg,
    ]),
  );
  return { ...record, pushConfigs };
}

async function captureSubscriptions(pubsub: PubSubLike): Promise<CapturedSubscription[]> {
  const subscriptions = await listOpt2Subscriptions(pubsub);
  return Promise.all(
    subscriptions.map(async ({ name, subscription }) => ({ name, subscription, push: await readPushConfig(subscription) })),
  );
}

/** True for an outbox sweep queue. */
function isSweep({ queue }: QueueTarget): boolean {
  return SWEEP_QUEUES.has(queue);
}

/** A suspended record's re-run: resumes its paused sweeps and re-applies its saved push configs to subscriptions now in pull. */
async function reopenDelivery(
  ctx: DrainAndSuspendContext,
  existing: BackgroundRecord,
  captured: readonly CapturedSubscription[],
): Promise<CapturedSubscription[]> {
  for (const { service, queue } of existing.pausedQueues.filter(isSweep)) {
    await callQueueControl(ctx.client, { service, queue, op: 'resume' });
  }
  const reopened: CapturedSubscription[] = [];
  for (const entry of captured) {
    const saved = existing.pushConfigs[entry.name];
    if (entry.push === null && isPushConfig(saved)) {
      await setPushConfig(entry.subscription, saved);
      reopened.push({ ...entry, push: saved });
    } else {
      reopened.push(entry);
    }
  }
  return reopened;
}

/** Deadline of the barrier that follows the first drain, its budget and the pause between its polls. */
interface Barrier {
  timeoutMs: number;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
}

function remainingMs(ctx: DrainAndSuspendContext, barrier: Barrier): number {
  return Math.max(0, barrier.deadline - ctx.clock.now().getTime());
}

/**
 * Pauses each target in order and returns those whose answer counts running tasks.
 * @throws Error when a pause answer carries no running count.
 */
async function pauseEach(ctx: DrainAndSuspendContext, targets: readonly QueueTarget[]): Promise<RunningQueue[]> {
  const running: RunningQueue[] = [];
  for (const { service, queue } of targets) {
    const { running: count } = await callQueueControl(ctx.client, { service, queue, op: 'pause' });
    if (typeof count !== 'number') throw new Error(`Queue control pause of ${queue} on ${service} answered without its running tasks`);
    if (count > 0) running.push({ service, queue, running: count });
  }
  return running;
}

/** Re-pauses the running queues until none counts a running task. @throws InvocationsRunningError when one still does at the deadline. */
async function awaitStopped(ctx: DrainAndSuspendContext, running: readonly RunningQueue[], barrier: Barrier): Promise<void> {
  let left = running;
  while (left.length > 0) {
    if (ctx.clock.now().getTime() >= barrier.deadline) throw new InvocationsRunningError(barrier.timeoutMs, left);
    await barrier.sleep(DEFAULT_DRAIN_POLL_MS);
    left = await pauseEach(ctx, left);
  }
}

/**
 * The gateway's in-flight rows, all of live instances: native task runs and forwarded writes still executing.
 * @throws OrphanedWritesError when a row's instance is not live.
 */
async function liveInflight(ctx: DrainAndSuspendContext): Promise<InflightRow[]> {
  const status = await ctx.gateway.status();
  const live = new Set(status.instances.filter((instance) => instance.live).map((instance) => instance.instanceId));
  const orphans = status.inflight.filter((row) => !live.has(row.instanceId));
  if (orphans.length > 0) throw new OrphanedWritesError(orphans);
  return status.inflight;
}

/**
 * Waits for the stopped producers' running tasks and the live in-flight writes, then drains with the sweeps and push still live,
 * repeating until a confirming poll finds neither.
 * @throws OrphanedWritesError when a dead instance holds an in-flight row.
 * @throws InvocationsRunningError, GatewayWaitTimeoutError or DrainTimeoutError when that outlasts the barrier's deadline.
 */
async function awaitQuiescent(
  ctx: DrainAndSuspendContext,
  pubsub: PubSubLike,
  producers: readonly QueueTarget[],
  running: readonly RunningQueue[],
  barrier: Barrier,
): Promise<DrainResult> {
  let left = running;
  for (;;) {
    await awaitStopped(ctx, left, barrier);
    const inflight = await liveInflight(ctx);
    if (inflight.length > 0) {
      const routes = [...new Set(inflight.map((row) => row.route))];
      const budget = { timeoutMs: remainingMs(ctx, barrier), intervalMs: DEFAULT_DRAIN_POLL_MS };
      const { orphans } = await ctx.gateway.awaitInflightDrained(routes, budget);
      if (orphans.length > 0) throw new OrphanedWritesError(orphans);
    }
    const drained = await awaitDrained(ctx, { timeoutMs: remainingMs(ctx, barrier), pubsub, sleep: barrier.sleep });
    left = await pauseEach(ctx, producers);
    const pending = await liveInflight(ctx);
    if (left.length === 0 && pending.length === 0) return drained;
    if (ctx.clock.now().getTime() >= barrier.deadline) {
      throw left.length > 0 ? new InvocationsRunningError(barrier.timeoutMs, left) : new GatewayWaitTimeoutError({ kind: 'inflight', pending });
    }
  }
}

/**
 * Drains every participant and stores the plan; stops the ACF tasks and producing queues and waits for their running work and the live
 * in-flight writes; drains again with the sweeps and push live; then pauses the sweeps and switches push subscriptions to pull.
 * A run on a suspended record first resumes its sweeps and push delivery.
 * @throws DrainTimeoutError or OrphanedWritesError from the first drain or the in-flight read after it, before any change on a first run.
 * @throws OrphanedWritesError, InvocationsRunningError, GatewayWaitTimeoutError or DrainTimeoutError from the barrier after it;
 * these and any other later failure propagate with the planned record already stored.
 */
export async function drainAndSuspend(
  ctx: DrainAndSuspendContext,
  options: DrainAndSuspendOptions = {},
): Promise<DrainAndSuspendResult> {
  const background = options.background ?? remoteBackgroundState(ctx);
  const scheduler = options.scheduler ?? createSchedulerService(ctx);
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  // `config.background` holds no drain budget, so the configured drain budget of a transition bounds each drain and the barrier too.
  const { drainTimeoutMs } = ctx.config.transition;
  try {
    const existing = await background.get();
    const targets = queueControlTargets(ctx.env.OPT2_SERVICE_URLS);
    const live = await captureSubscriptions(pubsub);
    const captured = existing.suspended ? await reopenDelivery(ctx, existing, live) : live;

    const drained = await awaitDrained(ctx, { timeoutMs: drainTimeoutMs, pubsub, sleep });
    // Only rejects orphans here; live rows are waited for once producers are stopped.
    await liveInflight(ctx);

    const planned: BackgroundRecord = {
      suspended: true,
      since: existing.since ?? ctx.clock.now().toISOString(),
      reason: options.reason ?? existing.reason ?? DEFAULT_SUSPEND_REASON,
      pushConfigs: mergePushConfigs(existing.pushConfigs, captured),
      pausedQueues: unionTargets(existing.pausedQueues, targets),
      pausedTasks: existing.pausedTasks,
    };
    // Stored before any pause, so `opt2-ops resume` can restore from it whichever later step fails.
    await background.suspend(planned);

    const paused = await scheduler.pauseAll();
    const pausedTasks = [...new Set([...paused.siteMonitor, ...paused.surveys])].sort();

    const producers = targets.filter((target) => !isSweep(target));
    const barrier: Barrier = { timeoutMs: drainTimeoutMs, deadline: ctx.clock.now().getTime() + drainTimeoutMs, sleep };
    const finalDrained = await awaitQuiescent(ctx, pubsub, producers, await pauseEach(ctx, producers), barrier);
    await awaitStopped(ctx, await pauseEach(ctx, targets.filter(isSweep)), barrier);

    const switchedToPull: string[] = [];
    for (const { name, subscription, push } of captured) {
      if (push === null) continue;
      await setPushConfig(subscription, {});
      switchedToPull.push(name);
    }

    const record = await background.suspend({
      ...planned,
      pausedTasks: [...new Set([...existing.pausedTasks, ...pausedTasks])].sort(),
    });
    return {
      alreadySuspended: existing.suspended,
      drained,
      finalDrained,
      pausedTasks,
      pausedQueues: targets,
      switchedToPull,
      record: redactedRecord(record),
    };
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
