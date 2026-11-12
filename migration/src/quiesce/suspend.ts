/** `opt2-ops drain-and-suspend`: drains every owner, then pauses ACF tasks and task queues and moves push subscriptions to pull, recording what it paused. */
import { callQueueControl, queuesCreatedBy } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import { createSchedulerService, type SchedulerContext, type SchedulerService } from '../scheduler/index.js';
import { remoteBackgroundState, type BackgroundRecord, type BackgroundStateApi } from './background.js';
import { awaitDrained, type DrainContext, type DrainResult } from './drain.js';
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

/** Reason stored in the background record when neither the caller nor the stored record names one. */
const DEFAULT_SUSPEND_REASON = 'drain-and-suspend';

/** The context members drain-and-suspend uses. */
export type DrainAndSuspendContext = DrainContext & SchedulerContext & Pick<MigrationContext, 'clientAs'>;

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
  /** Pause between drain polls. */
  sleep?: (ms: number) => Promise<void>;
}

/** What one run drained and paused; subscription names only, since a push endpoint may carry the local push key. */
export interface DrainAndSuspendResult {
  /** The record was already suspended when the run began. */
  alreadySuspended: boolean;
  drained: DrainResult;
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

/**
 * Drains every data owner, then pauses the legacy-held ACF tasks and the configured services' queues and switches push subscriptions to pull.
 * @throws DrainTimeoutError before anything is changed; any later failure propagates with the planned record already stored.
 */
export async function drainAndSuspend(
  ctx: DrainAndSuspendContext,
  options: DrainAndSuspendOptions = {},
): Promise<DrainAndSuspendResult> {
  const background = options.background ?? remoteBackgroundState(ctx);
  const scheduler = options.scheduler ?? createSchedulerService(ctx);
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  try {
    // `config.background` holds no drain budget, so the configured drain budget of a transition bounds this drain too.
    const drained = await awaitDrained(ctx, { timeoutMs: ctx.config.transition.drainTimeoutMs, pubsub, sleep: options.sleep });

    const existing = await background.get();
    const targets = queueControlTargets(ctx.env.OPT2_SERVICE_URLS);
    const captured = await captureSubscriptions(pubsub);
    const planned: BackgroundRecord = {
      suspended: true,
      since: existing.since ?? ctx.clock.now().toISOString(),
      reason: options.reason ?? existing.reason ?? DEFAULT_SUSPEND_REASON,
      pushConfigs: mergePushConfigs(existing.pushConfigs, captured),
      pausedQueues: unionTargets(existing.pausedQueues, targets),
      pausedTasks: existing.pausedTasks,
    };
    // Stored before any change, so `opt2-ops resume` can restore from it whichever later step fails.
    await background.suspend(planned);

    const paused = await scheduler.pauseAll();
    const pausedTasks = [...new Set([...paused.siteMonitor, ...paused.surveys])].sort();

    for (const { service, queue } of targets) {
      await callQueueControl(ctx.client, { service, queue, op: 'pause' });
    }

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
      pausedTasks,
      pausedQueues: targets,
      switchedToPull,
      record: redactedRecord(record),
    };
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
