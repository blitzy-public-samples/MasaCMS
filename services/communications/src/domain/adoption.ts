// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Scheduler hand-off of the fixture's `opt2-survey-*` ACF tasks: adoption as scheduled-task rows and queue tasks, and cancellation on restoration. */
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { requestMigrationAuthority, withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { registeredTenants, tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { RECOVERY_BATCH_SIZE, findScheduledTaskByName, listAdoptedScheduledTasks, taskCursor, type BatchCursor } from '../repo/queries.js';
import { OWNER, type NewAdoptedScheduledTask } from '../repo/repository.js';
import type { ScheduledTaskRow } from '../repo/tables.js';
import { SURVEY_SOURCE_TYPE, dequeueScheduledTasks, enqueueScheduledTasks, type SurveyScheduleDeps } from './survey-schedule.js';
import { SURVEY_TASK_QUEUES, kindOfLegacyTaskName, parseLocalTimestamp, portTaskName, taskTarget } from './survey-tasks.js';

/** Body of `adoptScheduledTasks`: the fixture ACF tasks as captured before their deletion. */
export type AdoptRequest = components['schemas']['AdoptScheduledTasksRequest'];

/** One captured fixture ACF task. */
export type AdoptedTaskInput = AdoptRequest['tasks'][number];

/** Result of `adoptScheduledTasks`: tasks newly adopted, already present by name, and adopted with a past time. */
export type AdoptResult = components['schemas']['AdoptScheduledTasksResult'];

/** Body of `cancelAdoptedScheduledTasks`; every adopted task when `names` is absent. */
export type CancelRequest = components['schemas']['CancelAdoptedTasksRequest'];

/** Result of `cancelAdoptedScheduledTasks`: the number of tasks cancelled. */
export type CancelResult = components['schemas']['CancelAdoptedTasksResult'];

const MIGRATION_ACTOR = 'platform.migration';

/** Write contexts of one hand-off request: the rows the migration hands over, and communications' own queue stamps. */
interface HandOffContexts {
  rows: WriteContext;
  stamps: WriteContext;
}

/** One captured task planned for adoption under the tenant of its site. */
interface PlannedAdoption {
  siteId: string;
  tenantId: string;
  task: NewAdoptedScheduledTask;
  /** The captured run time had passed, so the task is scheduled at `now`. */
  immediate: boolean;
}

/** The captured tasks of one tenant; `siteId` is the first task's site. */
interface TenantGroup {
  siteId: string;
  plans: PlannedAdoption[];
}

/** Counts of one tenant's adoption transaction, and the rows whose queue task is still to be created. */
interface TenantAdoption {
  adopted: number;
  existing: number;
  scheduledImmediately: number;
  toEnqueue: Map<string, ScheduledTaskRow>;
}

/**
 * Contexts carrying a migration authority only when the verified caller holds `platform.migration`: the transition hands
 * the scheduler over before it reopens the gates, so these writes must pass gates it still holds closed.
 */
function handOffContexts(): HandOffContexts {
  const authority = requestMigrationAuthority();
  return {
    // Adopted rows carry the legacy scheduler's state, so they are recorded as a migration apply.
    rows: { origin: 'migration-feed', actorService: MIGRATION_ACTOR, authority },
    stamps: { origin: 'target', actorService: OWNER, authority },
  };
}

/** The local run time of a captured task; throws `LegacyApiError('invalidParameters')` for a time that does not exist locally. */
function localRunTime(text: string): Date {
  try {
    return parseLocalTimestamp(text);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new LegacyApiError('invalidParameters');
    }
    throw error;
  }
}

/** Plans one captured task; throws `LegacyApiError('invalidParameters')` for a name outside `opt2-survey-*` or an empty site. */
function planAdoption(input: AdoptedTaskInput, now: Date, serviceUrls: Record<string, string>): PlannedAdoption {
  const parts = kindOfLegacyTaskName(input.name);
  if (parts === null || input.siteId === '') {
    throw new LegacyApiError('invalidParameters');
  }
  const runAt = localRunTime(input.scheduleTime);
  const queue = SURVEY_TASK_QUEUES[parts.kind];
  const immediate = runAt.getTime() < now.getTime();
  return {
    siteId: input.siteId,
    tenantId: tenantIdForSite(input.siteId),
    immediate,
    task: {
      taskName: input.name,
      queue,
      queueTaskName: portTaskName(input.name, input.scheduleVersion),
      kind: parts.kind,
      sourceType: SURVEY_SOURCE_TYPE,
      sourceId: parts.surveyId,
      n: parts.n ?? null,
      scheduleTime: immediate ? now : runAt,
      targetRoute: (scheduledTaskId) => taskTarget({ queue, surveyId: parts.surveyId, scheduledTaskId }, serviceUrls).route,
      scheduleVersion: input.scheduleVersion,
    },
  };
}

/** Plans grouped by tenant, in first-appearance order. */
function byTenant(plans: readonly PlannedAdoption[]): Map<string, TenantGroup> {
  const groups = new Map<string, TenantGroup>();
  for (const plan of plans) {
    const group = groups.get(plan.tenantId);
    if (group === undefined) {
      groups.set(plan.tenantId, { siteId: plan.siteId, plans: [plan] });
    } else {
      group.plans.push(plan);
    }
  }
  return groups;
}

/** Counts `row` as already present; a still-scheduled row without a queue task is queued again. */
function countExisting(result: TenantAdoption, row: ScheduledTaskRow): void {
  result.existing += 1;
  if (row.status === 'scheduled' && row.enqueued_at === null) {
    result.toEnqueue.set(row.scheduled_task_id, row);
  }
}

/** Adopts one tenant's tasks in `tx`; a queue task name an event-scheduled row already holds counts as present. */
async function adoptInTenant(
  deps: SurveyScheduleDeps,
  tx: TenantTx,
  plans: readonly PlannedAdoption[],
  ctx: WriteContext,
): Promise<TenantAdoption> {
  const result: TenantAdoption = { adopted: 0, existing: 0, scheduledImmediately: 0, toEnqueue: new Map() };
  const candidates: PlannedAdoption[] = [];
  for (const plan of plans) {
    // Adopted rows are matched by task name in the repository; any other row holding the queue task name would break its unique key.
    const held = await findScheduledTaskByName(tx, { queue: plan.task.queue, queueTaskName: plan.task.queueTaskName });
    if (held !== null && held.origin !== 'adopted') {
      countExisting(result, held);
    } else {
      candidates.push(plan);
    }
  }
  const adopted = await deps.repository.adoptScheduledTasks(
    tx,
    candidates.map((plan) => plan.task),
    ctx,
  );
  for (const [i, { row, created }] of adopted.entries()) {
    if (!created) {
      countExisting(result, row);
      continue;
    }
    result.adopted += 1;
    if (candidates[i]?.immediate === true) {
      result.scheduledImmediately += 1;
    }
    result.toEnqueue.set(row.scheduled_task_id, row);
  }
  return result;
}

/**
 * Adopts the captured tasks under `tenantIdForSite(siteId)`, once per task name, one transaction per tenant; a run time
 * that has passed is scheduled at the clock's now. After each tenant commits, its new rows and its present rows without a
 * queue task are queued; a failed queue call is logged and left for `scheduledTaskRecovery`.
 * Throws `LegacyApiError('invalidParameters')` before any write when a task's name, site or run time is invalid.
 */
export async function adoptScheduledTasks(deps: SurveyScheduleDeps, request: AdoptRequest): Promise<AdoptResult> {
  const now = deps.clock.now();
  const groups = byTenant(request.tasks.map((task) => planAdoption(task, now, deps.serviceUrls)));
  const contexts = handOffContexts();
  const result: AdoptResult = { adopted: 0, existing: 0, scheduledImmediately: 0 };
  for (const [tenantId, group] of groups) {
    const done = await withGatedTenant(deps.db, tenantId, (tx) => adoptInTenant(deps, tx, group.plans, contexts.rows));
    result.adopted += done.adopted;
    result.existing += done.existing;
    result.scheduledImmediately += done.scheduledImmediately;
    // Sites of one tenant differ at most in case, which the legacy site comparison ignores.
    await enqueueScheduledTasks(deps, tenantId, [...done.toEnqueue.values()], { siteId: group.siteId, context: contexts.stamps });
  }
  return result;
}

/** Cancels the tenant's still-scheduled adopted tasks named in `names` (every one when absent) in `tx`; returns the cancelled rows. */
async function cancelInTenant(
  deps: SurveyScheduleDeps,
  tx: TenantTx,
  names: readonly string[] | undefined,
  ctx: WriteContext,
): Promise<ScheduledTaskRow[]> {
  const cancelled: ScheduledTaskRow[] = [];
  let after: BatchCursor | undefined;
  for (;;) {
    const batch = await listAdoptedScheduledTasks(tx, names, after === undefined ? {} : { after });
    for (const row of batch) {
      const updated = await deps.repository.setScheduledTaskStatus(tx, row.scheduled_task_id, 'cancelled', ctx);
      if (updated !== null) {
        cancelled.push(updated);
      }
    }
    const last = batch.at(-1);
    if (batch.length < RECOVERY_BATCH_SIZE || last === undefined) {
      return cancelled;
    }
    after = taskCursor(last);
  }
}

/**
 * Cancels the adopted tasks `request` names, or every adopted task, still `scheduled` in each registered tenant, one
 * transaction per tenant, then deletes their queue tasks; a repeated call finds nothing left to cancel.
 * A failed delete is logged and left for `scheduledTaskRecovery`.
 */
export async function cancelAdoptedScheduledTasks(deps: SurveyScheduleDeps, request: CancelRequest): Promise<CancelResult> {
  const contexts = handOffContexts();
  // RLS permits no cross-tenant scan, so every registered tenant is visited; case-folded as withTenant folds them.
  const tenants = new Set((await registeredTenants(deps.db)).map(({ tenantId }) => tenantId.toLowerCase()));
  let cancelled = 0;
  for (const tenantId of tenants) {
    const rows = await withGatedTenant(deps.db, tenantId, (tx) => cancelInTenant(deps, tx, request.names, contexts.rows));
    cancelled += rows.length;
    await dequeueScheduledTasks(deps, tenantId, rows, { context: contexts.stamps });
  }
  return { cancelled };
}
