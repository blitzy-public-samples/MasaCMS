/** `opt2-ops resume`: undoes `opt2-ops drain-and-suspend` from its background record, then clears the record. */
import {
  QUEUES,
  SITEMONITOR_QUEUE,
  callQueueControl,
  isQueueName,
  reconcileRecurringQueues,
  type ReconcileResult,
} from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import {
  SCHEDULER_KEYS,
  createSchedulerService,
  readSchedulerKey,
  type RestoreResult,
  type SchedulerContext,
  type SchedulerService,
  type SiteMonitorRecord,
} from '../scheduler/index.js';
import { remoteBackgroundState, type BackgroundRecord, type BackgroundStateApi } from './background.js';
import { createPubSub, setPushConfig, type PubSubLike } from './subscriptions.js';
import type { QueueTarget } from './suspend.js';

/** The context members resume uses. */
export type ResumeContext = SchedulerContext & Pick<MigrationContext, 'clientAs'>;

/** Ports of {@link resume}; each absent port is created from the context. */
export interface ResumeOptions {
  /** `remoteBackgroundState(ctx)` when absent; the migration service passes `createBackgroundState(ctx)`. */
  background?: BackgroundStateApi;
  /** `createPubSub(ctx.env)` when absent, closed when the run ends. */
  pubsub?: PubSubLike;
  /** `createSchedulerService(ctx)` when absent. */
  scheduler?: Pick<SchedulerService, 'restoreAll'>;
}

/** What one run restored; subscription names only, since a saved push endpoint may carry the local push key. */
export interface ResumeResult {
  /** The record was suspended, so this run restored it; false means nothing was touched. */
  resumed: boolean;
  /** Subscriptions whose saved push config was applied again. */
  restoredPush: string[];
  /** Queues this run resumed. */
  resumedQueues: QueueTarget[];
  /** One entry per recurring chain and creator, as `opt2-tasks reconcile` reports them. */
  reconcile: ReconcileResult[] | null;
  /** ACF tasks `restoreAll` recreated. */
  restoredTasks: RestoreResult | null;
  /** The background record as finally stored. */
  record: BackgroundRecord;
}

/** A recurring chain could not be ensured; the background record stays suspended, so resume can be run again. */
export class ResumeReconcileError extends Error {
  override readonly name: string = 'ResumeReconcileError';

  constructor(readonly failed: readonly ReconcileResult[]) {
    super(
      `Recurring chains not ensured: ${failed.map(({ queue, service, error }) => `${queue} on ${service}: ${error ?? 'not ensured'}`).join('; ')}`,
    );
  }
}

/** True when the queue exists only in the local stack. */
function isLocalOnly(queue: string): boolean {
  return isQueueName(queue) && QUEUES[queue].localOnly === true;
}

/** The target site-monitor chain runs only once handed off, when a native task existed and no restoration disabled it. */
function siteMonitorChainEnabled(monitor: SiteMonitorRecord | null): boolean {
  return monitor !== null && monitor.nativeExisted && monitor.state === 'target' && !monitor.targetTriggerDisabled;
}

/**
 * Restores the saved push configs, resumes the paused queues, ensures the recurring chains and recreates the ACF tasks, then clears the record.
 * @throws ResumeReconcileError when a chain is not ensured; any failure propagates with the record still suspended.
 */
export async function resume(ctx: ResumeContext, options: ResumeOptions = {}): Promise<ResumeResult> {
  const background = options.background ?? remoteBackgroundState(ctx);
  const record = await background.get();
  if (!record.suspended) {
    return { resumed: false, restoredPush: [], resumedQueues: [], reconcile: null, restoredTasks: null, record };
  }

  const monitor = await readSchedulerKey(ctx.db, SCHEDULER_KEYS.siteMonitor);
  const scheduler = options.scheduler ?? createSchedulerService(ctx);
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  try {
    const restoredPush: string[] = [];
    for (const [name, saved] of Object.entries(record.pushConfigs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      await setPushConfig(pubsub.subscription(name), saved);
      restoredPush.push(name);
    }

    // Suspend pauses every queue, including a site-monitor queue a restoration to legacy had already paused; that one stays paused.
    const resumedQueues = record.pausedQueues.filter(
      ({ queue }) => !(queue === SITEMONITOR_QUEUE && monitor?.targetTriggerDisabled === true),
    );
    for (const { service, queue } of resumedQueues) {
      await callQueueControl(ctx.client, { service, queue, op: 'resume' });
    }

    const reconcile = await reconcileRecurringQueues(ctx.client, {
      serviceUrls: ctx.env.OPT2_SERVICE_URLS,
      withSiteMonitor: siteMonitorChainEnabled(monitor),
      includeLocalOnly: resumedQueues.some(({ queue }) => isLocalOnly(queue)),
    });
    const failed = reconcile.filter((result) => !result.ok);
    if (failed.length > 0) throw new ResumeReconcileError(failed);

    const restoredTasks = await scheduler.restoreAll();

    const cleared = await background.resume();
    return {
      resumed: true,
      restoredPush,
      resumedQueues: resumedQueues.map(({ service, queue }) => ({ service, queue })),
      reconcile,
      restoredTasks,
      record: cleared,
    };
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
