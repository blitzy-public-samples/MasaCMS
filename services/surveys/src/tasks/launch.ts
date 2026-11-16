// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `surveys-launch` task route: the target form of the fixture launch callback `surveys/surveys/{id}/launch`. */
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { registerTaskRoute, TaskTenantMismatchError, type TaskContext } from '@opt2/platform/tasks';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { z, type Clock, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { launchSurvey, type LaunchOutcome } from '../domain/launch.js';
import type { components as CommunicationsComponents } from '../generated/clients/communications.js';
import type { components } from '../generated/openapi.js';
import { getSchedule } from '../repo/queries.js';
import type { SurveysRepository } from '../repo/repository.js';
import type { SurveyScheduleRow, SurveyStatus } from '../repo/tables.js';

/** Fixed path of the `surveys-launch` queue target; the survey travels in the task payload. */
export const LAUNCH_TASK_PATH = '/internal/v1/tasks/surveys/launch' as const;

/** The contract's `LaunchPayload`, which communications copies from `surveys.survey.scheduled.v1`. */
export interface LaunchTaskPayload {
  surveyId: string;
  siteId: string;
  scheduleVersion: number;
}

/** The contract's `LaunchResult`: whether this task launched the survey, and the survey's status after it. */
export interface LaunchTaskResult {
  applied: boolean;
  status: SurveyStatus;
}

/** The contract's `TaskIgnoredResult`: a permanently invalid task acknowledged without acting, so no queue retries it. */
export type LaunchTaskIgnored = components['schemas']['TaskIgnoredResult'];

/** Runtime handles of the launch route; `clock` is the service clock the repository stamps `launched_at` with. */
export interface LaunchTaskDeps {
  db: TenantDb;
  repository: SurveysRepository;
  clock: Clock;
}

/** The task's payload and the schedule it names, as visible under the body's tenant. */
interface StoredLaunch {
  payload: LaunchTaskPayload;
  schedule: SurveyScheduleRow;
}

const launchPayloadSchema = z.object({
  surveyId: z.string().min(1),
  siteId: z.string().min(1),
  scheduleVersion: z.number().int().min(1),
});

const APPLIED = { launched: true, 'already-launched': false, superseded: false } as const satisfies Record<LaunchOutcome, boolean>;

/** The payload's stored schedule under the body's tenant; null when the payload is malformed or names no schedule there. */
async function findStoredLaunch(tx: TenantTx, raw: unknown): Promise<StoredLaunch | null> {
  // A payload outside LaunchPayload names no visible schedule, so the platform acknowledges the task as ignored.
  const parsed = launchPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const schedule = await getSchedule(tx, parsed.data.surveyId);
  return schedule === null ? null : { payload: parsed.data, schedule };
}

type SurveyLaunchDoneRequest = CommunicationsComponents['schemas']['SurveyLaunchDoneRequest'];

const COMMUNICATIONS = 'communications';

/** The run launch task a report names: its tenant, survey, queue task name and schedule version. */
interface LaunchDoneReport {
  tenantId: string;
  surveyId: string;
  taskName: string;
  scheduleVersion: number;
}

/** Path of communications' `markSurveyLaunchTaskDone` for a survey. */
export function launchDonePath(surveyId: string): string {
  return `/internal/v1/scheduled-tasks/survey-launches/${surveyId}/done`;
}

/**
 * Reports a run launch task to communications, which records its row `done`. A 404 (no such row) is logged, since a retry
 * finds none either; any other non-2xx answer throws LegacyServiceUnavailableError, so the queue retries the task.
 */
async function reportLaunchDone(app: FastifyInstance, request: FastifyRequest, report: LaunchDoneReport): Promise<void> {
  const { tenantId, surveyId, taskName, scheduleVersion } = report;
  const body = { tenantId, queueTaskName: taskName, scheduleVersion } satisfies SurveyLaunchDoneRequest;
  // A system task acts for no user, and the operation accepts only the invocation credential.
  const res = await app.opt2.client.request({
    service: COMMUNICATIONS,
    method: 'POST',
    path: launchDonePath(surveyId),
    json: body,
    userToken: null,
  });
  if (res.status === 404) {
    request.log.warn({ tenantId }, `Service ${COMMUNICATIONS} holds no launch task ${taskName} of survey ${surveyId} to record done`);
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new LegacyServiceUnavailableError(
      `Service ${COMMUNICATIONS} markSurveyLaunchTaskDone answered HTTP ${String(res.status)}`,
      'auto',
      'service-unavailable',
    );
  }
}

/** Registers POST `LAUNCH_TASK_PATH` on the cloud-tasks transport; the survey turns LAUNCHED once while its schedule version is current. */
export function registerLaunchTaskRoute(app: FastifyInstance, deps: LaunchTaskDeps): void {
  registerTaskRoute<StoredLaunch>(app, LAUNCH_TASK_PATH, {
    scope: 'tenant',
    db: deps.db,
    findStored: findStoredLaunch,
    ignored: (reason): LaunchTaskIgnored => ({ ignored: true, reason }),
    handler: async ({ request, tenantId, taskName, stored }: TaskContext<StoredLaunch>): Promise<LaunchTaskResult> => {
      // The platform passes both on a tenant route; the survey is the payload's, found under the body's tenant.
      if (stored === undefined || tenantId === null) throw new TaskTenantMismatchError(tenantId, taskName);
      const { surveyId, scheduleVersion } = stored.payload;
      // Gated, so a closed survey gate is waited out for the gate budget before the legacy 503 that makes Cloud Tasks retry.
      const { outcome, survey } = await withGatedTenant(deps.db, tenantId, (tx) =>
        launchSurvey(tx, { repository: deps.repository, surveyId, scheduleVersion }),
      );
      // After the commit, so a retry finds the survey launched and reports again; a superseded task's row was closed by the
      // newer schedule, never by this task.
      if (outcome !== 'superseded') {
        await reportLaunchDone(app, request, { tenantId, surveyId, taskName, scheduleVersion });
      }
      // A repeat or superseded delivery writes nothing and reports the stored status.
      return { applied: APPLIED[outcome], status: survey.status };
    },
  });
}
