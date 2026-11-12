// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 consumer of `surveys.survey.scheduled.v1`: records each schedule version's tasks, queues them after commit and recovers lost port calls. */
import type { ConsumerDefinition } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { readGates, withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import type { RecoveryHook } from '@opt2/platform/outbox';
import { QUEUES, type TaskPort } from '@opt2/platform/tasks';
import { registeredTenants, siteForTenant, withTenant } from '@opt2/platform/tenancy';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';
import {
  RECOVERY_BATCH_SIZE,
  listScheduledTasksBySource,
  taskCursor,
  unstampedScheduledTasksOlderThan,
  type BatchCursor,
} from '../repo/queries.js';
import { OWNER, type NewScheduledTask } from '../repo/repository.js';
import { SCHEDULED_TASK, type ScheduledTaskOrigin, type ScheduledTaskRow, type ScheduledTaskStatus } from '../repo/tables.js';
import type { DomainDeps } from './delivery.js';
import { planSurveyTasks, taskPayload, taskTarget, type PlannedSurveyTask } from './survey-tasks.js';

/** Age after which a task row whose queue side effect is still unstamped is repaired by the sweep's recovery hook. */
export const SCHEDULED_TASK_RECOVERY_AGE_MS = 30_000;

/** Name of the outbox-sweep recovery hook. */
export const SCHEDULED_TASK_RECOVERY_HOOK = 'communications-scheduled-tasks';

/** `scheduled_task.source_type` of survey tasks. */
export const SURVEY_SOURCE_TYPE = 'survey';

/** Domain dependencies plus the task port and the base URL per service that task targets resolve against. */
export interface SurveyScheduleDeps extends DomainDeps {
  taskPort: TaskPort;
  serviceUrls: Record<string, string>;
}

/** Port side-effect options: the survey's site for launch payloads (default: the tenant's registered site) and the stamps' write context. */
export interface ScheduledTaskPortOptions {
  siteId?: string;
  context?: WriteContext;
}

const EVENT_ORIGIN = 'event' satisfies ScheduledTaskOrigin;
const DEQUEUE_DUE: ReadonlySet<ScheduledTaskStatus> = new Set<ScheduledTaskStatus>(['superseded', 'cancelled']);
// The schedule is surveys' request, so its rows are written on surveys' behalf; queue stamps are communications' own bookkeeping.
const SCHEDULE_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: 'surveys' });
const PORT_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: OWNER });

/** The row of one planned task; its route is resolved from the id the repository assigns, which a reminder's route names. */
function newScheduledTask(task: PlannedSurveyTask, serviceUrls: Record<string, string>): NewScheduledTask {
  return {
    taskName: task.legacyTaskName,
    queue: task.queue,
    queueTaskName: task.portName,
    kind: task.kind,
    sourceType: SURVEY_SOURCE_TYPE,
    sourceId: task.surveyId,
    n: task.n ?? null,
    scheduleTime: task.scheduleTime,
    targetRoute: (scheduledTaskId) => taskTarget({ queue: task.queue, surveyId: task.surveyId, scheduledTaskId }, serviceUrls).route,
    scheduleVersion: task.scheduleVersion,
    origin: EVENT_ORIGIN,
  };
}

/**
 * Effect of the seam 2 consumer in the destination transaction: supersedes the survey's earlier still-scheduled tasks,
 * inserts this version's launch and reminder rows, and creates and deletes their queue tasks once that commits.
 */
export function applySurveyScheduled(deps: SurveyScheduleDeps): ConsumerDefinition<SurveyScheduledPayload>['apply'] {
  return async (tx, envelope) => {
    const { payload } = envelope;
    const current = await listScheduledTasksBySource(tx, { sourceType: SURVEY_SOURCE_TYPE, sourceId: payload.surveyId });
    // The consumer skips aggregate versions at or below the applied one; this covers a replay under a new aggregate
    // version or eventId, and tasks adoption already holds for this schedule version.
    if (current.some((row) => row.schedule_version >= payload.scheduleVersion)) {
      return;
    }
    const plan = planSurveyTasks(payload, { now: deps.clock.now() });
    const superseded: ScheduledTaskRow[] = [];
    for (const row of current) {
      if (row.status !== 'scheduled') {
        continue;
      }
      const updated = await deps.repository.setScheduledTaskStatus(tx, row.scheduled_task_id, 'superseded', SCHEDULE_CONTEXT);
      if (updated !== null) {
        superseded.push(updated);
      }
    }
    const inserted = await deps.repository.insertScheduledTasks(
      tx,
      plan.map((task) => newScheduledTask(task, deps.serviceUrls)),
      SCHEDULE_CONTEXT,
    );
    const { tenantId } = tx;
    // Both calls log and keep each failed row for recovery, so the callback needs no error handler of its own.
    tx.onCommit(async () => {
      await enqueueScheduledTasks(deps, tenantId, inserted, { siteId: payload.siteId });
      await dequeueScheduledTasks(deps, tenantId, superseded);
    });
  };
}

/** The registered site of `tenantId`; throws when the tenant has no registry entry. */
async function registeredSite(deps: SurveyScheduleDeps, tenantId: string): Promise<string> {
  const siteId = await siteForTenant(deps.db, tenantId);
  if (siteId === null) {
    throw new Error(`tenant ${tenantId} has no registered site for its launch payload`);
  }
  return siteId;
}

/**
 * Creates each row's queue task under `tenantId`, then stamps `enqueued_at`; an existing task name counts as created.
 * A failed row is logged and left for `scheduledTaskRecovery`.
 */
export async function enqueueScheduledTasks(
  deps: SurveyScheduleDeps,
  tenantId: string,
  rows: readonly ScheduledTaskRow[],
  opts: ScheduledTaskPortOptions = {},
): Promise<void> {
  let siteId = opts.siteId;
  for (const row of rows) {
    try {
      // A stored row keeps no site, and only a launch payload names it.
      const site = row.kind === 'survey-launch' ? (siteId ??= await registeredSite(deps, tenantId)) : '';
      const source = { kind: row.kind, surveyId: row.source_id, siteId: site, scheduleVersion: row.schedule_version, n: row.reminder_n };
      const target = taskTarget({ queue: row.queue, surveyId: row.source_id, scheduledTaskId: row.scheduled_task_id }, deps.serviceUrls);
      await deps.taskPort.create({
        queue: row.queue,
        name: row.queue_task_name,
        scheduleTime: row.schedule_time,
        url: target.url,
        body: taskPayload(source, row.scheduled_task_id),
        deadlineS: QUEUES[row.queue].deadlineS,
        tenantId,
      });
      await withGatedTenant(deps.db, tenantId, (tx) => deps.repository.stampEnqueued(tx, row.scheduled_task_id, opts.context ?? PORT_CONTEXT));
    } catch (error) {
      deps.logger.error(
        { tenantId, error: serializeError(error) },
        `scheduled task ${row.queue_task_name} on ${row.queue}: enqueue left for recovery`,
      );
    }
  }
}

/**
 * Deletes each row's queue task under `tenantId`, then stamps `dequeued_at`; an absent task counts as deleted.
 * A failed row is logged and left for `scheduledTaskRecovery`.
 */
export async function dequeueScheduledTasks(
  deps: SurveyScheduleDeps,
  tenantId: string,
  rows: readonly ScheduledTaskRow[],
  opts: Pick<ScheduledTaskPortOptions, 'context'> = {},
): Promise<void> {
  for (const row of rows) {
    try {
      await deps.taskPort.delete(row.queue, row.queue_task_name, { tenantId });
      await withGatedTenant(deps.db, tenantId, (tx) => deps.repository.stampDequeued(tx, row.scheduled_task_id, opts.context ?? PORT_CONTEXT));
    } catch (error) {
      deps.logger.error(
        { tenantId, error: serializeError(error) },
        `scheduled task ${row.queue_task_name} on ${row.queue}: dequeue left for recovery`,
      );
    }
  }
}

/** Repairs the tenant's unstamped rows older than `cutoff`, batch by batch: enqueues `scheduled` rows and dequeues superseded or cancelled ones. */
async function recoverTenant(deps: SurveyScheduleDeps, tenantId: string, siteId: string, cutoff: Date): Promise<void> {
  let after: BatchCursor | undefined;
  for (;;) {
    const batchRead = after === undefined ? {} : { after };
    const batch = await withTenant(deps.db, tenantId, (tx) => unstampedScheduledTasksOlderThan(tx, cutoff, batchRead));
    await enqueueScheduledTasks(deps, tenantId, batch.filter((row) => row.status === 'scheduled'), { siteId });
    await dequeueScheduledTasks(deps, tenantId, batch.filter((row) => DEQUEUE_DUE.has(row.status)));
    const last = batch.at(-1);
    if (batch.length < RECOVERY_BATCH_SIZE || last === undefined) {
      return;
    }
    after = taskCursor(last);
  }
}

/** Outbox-sweep hook that finishes every queue side effect left unstamped longer than SCHEDULED_TASK_RECOVERY_AGE_MS. */
export function scheduledTaskRecovery(deps: SurveyScheduleDeps): RecoveryHook {
  return {
    name: SCHEDULED_TASK_RECOVERY_HOOK,
    async run(ctx) {
      // Queue tasks act for the unit, so none is created or deleted while it is not target-authoritative and open.
      const [gate] = await readGates(deps.db, [SCHEDULED_TASK.unit]);
      if (gate?.state !== 'open') {
        return;
      }
      const cutoff = new Date(ctx.clock.now().getTime() - SCHEDULED_TASK_RECOVERY_AGE_MS);
      // Case-folded as withTenant folds them, so one tenant is never recovered twice in a sweep.
      const tenants = new Map((await registeredTenants(deps.db)).map(({ tenantId, siteId }) => [tenantId.toLowerCase(), siteId]));
      for (const [tenantId, siteId] of tenants) {
        try {
          await recoverTenant(deps, tenantId, siteId, cutoff);
        } catch (error) {
          ctx.logger.error({ tenantId, error: serializeError(error) }, 'scheduled-task recovery failed for the tenant in this sweep');
        }
      }
    },
  };
}
