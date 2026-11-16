// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `communications-reminders` task route: runs one stored survey reminder through `performReminder`. */
import type { Logger } from '@opt2/platform/logging';
import { z, type Clock, type FastifyInstance, type ServiceClient } from '@opt2/platform/service-kit';
import { QUEUES, TaskTenantMismatchError, registerTaskRoute, type TaskContext } from '@opt2/platform/tasks';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { performReminder, type ReminderDeps, type ReminderResult } from '../domain/reminders.js';
import type { ReminderTaskPayload } from '../domain/survey-tasks.js';
import type { components } from '../generated/openapi.js';
import { findScheduledTask } from '../repo/queries.js';
import type { CommunicationsRepository } from '../repo/repository.js';
import type { ScheduledTaskRow } from '../repo/tables.js';

/** The queue's fixed target path, `/internal/v1/tasks/reminders`; the payload names the scheduled-task row. */
export const REMINDER_TASK_PATH = QUEUES['communications-reminders'].targetPath;

/** The contract's `TaskIgnoredResult`: a permanently invalid task acknowledged without acting, so no queue retries it. */
export type ReminderTaskIgnored = components['schemas']['TaskIgnoredResult'];

// Reminders send no mail (the fixture's remind callback only stamps sent_at), so the route takes no mail ports.
/** Runtime handles of the reminder route; `logger` and `client` default to the service's own. */
export interface ReminderTaskRouteOptions {
  db: TenantDb;
  repository: CommunicationsRepository;
  clock: Clock;
  logger?: Logger;
  client?: ServiceClient;
}

const reminderPayloadSchema = z.object({
  scheduledTaskId: z.string().min(1),
  surveyId: z.string().min(1),
  n: z.number().int().min(1),
  scheduleVersion: z.number().int().min(1),
}) satisfies z.ZodType<ReminderTaskPayload>;

/** The payload's reminder row under the body's tenant; null when the payload is malformed or names no reminder of its survey there. */
async function findStoredReminder(tx: TenantTx, raw: unknown): Promise<ScheduledTaskRow | null> {
  const payload = reminderPayloadSchema.safeParse(raw);
  if (!payload.success) return null;
  const row = await findScheduledTask(tx, payload.data.scheduledTaskId);
  return row?.kind === 'survey-reminder' && row.source_id === payload.data.surveyId ? row : null;
}

/** Registers POST `REMINDER_TASK_PATH` on the cloud-tasks transport; answers the contract's `ReminderTaskResult`, or `TaskIgnoredResult`. */
export function registerReminderTaskRoute(app: FastifyInstance, options: ReminderTaskRouteOptions): void {
  const deps: ReminderDeps = {
    db: options.db,
    repository: options.repository,
    clock: options.clock,
    logger: options.logger ?? app.opt2.logger,
    client: options.client ?? app.opt2.client,
  };
  registerTaskRoute<ScheduledTaskRow>(app, REMINDER_TASK_PATH, {
    scope: 'tenant',
    db: options.db,
    findStored: findStoredReminder,
    ignored: (reason): ReminderTaskIgnored => ({ ignored: true, reason }),
    handler: async ({ tenantId, taskName, stored }: TaskContext<ScheduledTaskRow>): Promise<ReminderResult> => {
      // A tenant-scoped route always passes the row `findStoredReminder` found; without one, the task is refused.
      if (stored === undefined) throw new TaskTenantMismatchError(tenantId, taskName);
      return performReminder(deps, stored);
    },
  });
}
