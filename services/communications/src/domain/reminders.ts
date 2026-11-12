// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Effect of a `communications-reminders` task: surveys' reminder-sent callback, then the scheduled-task row closed. */
import { LegacyServiceUnavailableError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import type { ServiceClient } from '@opt2/platform/service-kit';
import { siteForTenant } from '@opt2/platform/tenancy';
import type { components as SurveysComponents } from '../generated/clients/surveys.js';
import type { components } from '../generated/openapi.js';
import { OWNER } from '../repo/repository.js';
import type { ScheduledTaskRow, ScheduledTaskStatus } from '../repo/tables.js';
import type { DomainDeps } from './delivery.js';

type ReminderSentRequest = SurveysComponents['schemas']['ReminderSentRequest'];

// The fixture's surveys/{id}/remind callback only stamps the reminder's sent_at and sends no mail, so no mail port is taken.
/** Domain dependencies plus the client that calls surveys under communications' invocation credential. */
export interface ReminderDeps extends DomainDeps {
  client: Pick<ServiceClient, 'request'>;
}

/** Body of the reminder task's 2xx answer: the contract's `ReminderTaskResult`. */
export type ReminderResult = components['schemas']['ReminderTaskResult'];

/** `sent` after a run, `already-sent` for a `done` row, `superseded` for a `superseded` or `cancelled` row. */
export type ReminderOutcome = ReminderResult['status'];

const SURVEYS = 'surveys';
const LOCAL_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";
const REMINDER_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: OWNER });

// The contract has no `cancelled` outcome: a cancelled task went back to its legacy ACF task, so, like a superseded one,
// it is no longer the target's to run.
const SKIPPED: Readonly<Partial<Record<ScheduledTaskStatus, ReminderOutcome>>> = Object.freeze({
  done: 'already-sent',
  superseded: 'superseded',
  cancelled: 'superseded',
});

/** Path of surveys' `markReminderSent` for reminder `n` of a survey. */
export function reminderSentPath(surveyId: string, n: number): string {
  return `/internal/v1/surveys/${surveyId}/reminders/${String(n)}/sent`;
}

/** The registry's legacy site id of `tenantId`; the legacy 503 while the tenant is unregistered, so the queue retries. */
async function siteOf(deps: ReminderDeps, tenantId: string): Promise<string> {
  const siteId = await siteForTenant(deps.db, tenantId);
  if (siteId === null) {
    throw new LegacyServiceUnavailableError(`Tenant ${tenantId} has no site registry entry`, 'auto', 'tenant-unregistered');
  }
  return siteId;
}

/**
 * Runs a stored reminder task under its row's tenant: a `done`, `superseded` or `cancelled` row changes nothing;
 * otherwise surveys' reminder-sent callback, then the row set `done`. Throws LegacyServiceUnavailableError on a
 * non-2xx surveys answer; client and gate errors propagate.
 */
export async function performReminder(deps: ReminderDeps, row: ScheduledTaskRow): Promise<ReminderResult> {
  const skipped = SKIPPED[row.status];
  if (skipped !== undefined) {
    return { status: skipped };
  }
  const n = row.reminder_n;
  if (n === null) {
    throw new RangeError(`Reminder task ${row.scheduled_task_id} of survey ${row.source_id} has no ordinal`);
  }

  const tenantId = row.tenant_id;
  const body = {
    tenantId,
    siteId: await siteOf(deps, tenantId),
    taskName: row.task_name,
    scheduleVersion: row.schedule_version,
    sentAt: cfDateTimeFormat(deps.clock.now(), LOCAL_TIMESTAMP_MASK),
  } satisfies ReminderSentRequest;
  // A system task acts for no user, and the operation accepts only the invocation credential.
  const res = await deps.client.request({
    service: SURVEYS,
    method: 'POST',
    path: reminderSentPath(row.source_id, n),
    json: body,
    userToken: null,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new LegacyServiceUnavailableError(
      `Service ${SURVEYS} markReminderSent answered HTTP ${String(res.status)}`,
      'auto',
      'service-unavailable',
    );
  }

  await withGatedTenant(deps.db, tenantId, (tx) =>
    deps.repository.setScheduledTaskStatus(tx, row.scheduled_task_id, 'done', REMINDER_CONTEXT),
  );
  return { status: 'sent' };
}
