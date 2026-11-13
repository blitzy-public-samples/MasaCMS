// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `surveys-launch` task route: the target form of the fixture launch callback `surveys/surveys/{id}/launch`. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { registerTaskRoute, TaskTenantMismatchError, type TaskContext } from '@opt2/platform/tasks';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { z, type Clock, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { launchSurvey, type LaunchOutcome } from '../domain/launch.js';
import { getSchedule } from '../repo/queries.js';
import type { SurveysRepository } from '../repo/repository.js';
import type { SurveyScheduleRow, SurveyStatus } from '../repo/tables.js';

/** Fastify path of the `surveys-launch` queue target `/internal/v1/tasks/surveys/{surveyId}/launch`. */
export const LAUNCH_TASK_PATH = '/internal/v1/tasks/surveys/:surveyId/launch' as const;

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
  // A payload outside LaunchPayload names no visible schedule, so the platform answers badRequest and the queue stops retrying.
  const parsed = launchPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const schedule = await getSchedule(tx, parsed.data.surveyId);
  return schedule === null ? null : { payload: parsed.data, schedule };
}

/** The `:surveyId` path parameter Fastify decoded from the task URL. */
function pathSurveyId(request: FastifyRequest): string | undefined {
  return (request.params as { surveyId?: string }).surveyId;
}

/** Registers POST `LAUNCH_TASK_PATH` on the cloud-tasks transport; the survey turns LAUNCHED once while its schedule version is current. */
export function registerLaunchTaskRoute(app: FastifyInstance, deps: LaunchTaskDeps): void {
  registerTaskRoute<StoredLaunch>(app, LAUNCH_TASK_PATH, {
    scope: 'tenant',
    db: deps.db,
    findStored: findStoredLaunch,
    handler: async ({ request, tenantId, taskName, stored }: TaskContext<StoredLaunch>): Promise<LaunchTaskResult> => {
      // The URL and the payload name one survey; a task naming two is refused like one naming another tenant's survey.
      if (stored === undefined || tenantId === null || pathSurveyId(request) !== stored.payload.surveyId) {
        throw new TaskTenantMismatchError(tenantId, taskName);
      }
      const { surveyId, scheduleVersion } = stored.payload;
      // Gated, so a closed survey gate is waited out for the gate budget before the legacy 503 that makes Cloud Tasks retry.
      const { outcome, survey } = await withGatedTenant(deps.db, tenantId, (tx) =>
        launchSurvey(tx, { repository: deps.repository, surveyId, scheduleVersion }),
      );
      // A repeat or superseded delivery writes nothing and reports the stored status.
      return { applied: APPLIED[outcome], status: survey.status };
    },
  });
}
