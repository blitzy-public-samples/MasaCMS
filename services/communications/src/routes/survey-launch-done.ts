// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `markSurveyLaunchTaskDone`: surveys' report that a `surveys-launch` task ran, which closes its scheduled-task row. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { TASK_NAME_PATTERN } from '@opt2/platform/tasks';
import { isTenantId, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { lockScheduledTaskByName } from '../repo/queries.js';
import type { CommunicationsRepository } from '../repo/repository.js';
import type { ScheduledTaskQueue } from '../repo/tables.js';

type SurveyLaunchDoneRequest = components['schemas']['SurveyLaunchDoneRequest'];
type SurveyLaunchDoneResult = components['schemas']['SurveyLaunchDoneResult'];

// Declared here rather than imported from the route registry, which imports this module; the registry's context stays assignable.
/** The database and repository the route writes through. */
export interface SurveyLaunchDoneRouteDeps {
  db: TenantDb;
  repository: CommunicationsRepository;
}

/** Fastify path of `markSurveyLaunchTaskDone`. */
export const SURVEY_LAUNCH_DONE_PATH = '/internal/v1/scheduled-tasks/survey-launches/:surveyId/done';

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('surveys')]),
});

const LAUNCH_QUEUE = 'surveys-launch' satisfies ScheduledTaskQueue;
// The launch ran in surveys, so its row is closed on surveys' behalf, as its schedule rows are written.
const DONE_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: 'surveys' });
const CF_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;

const pathSchema = z.object({ surveyId: z.string().regex(CF_UUID) });

const bodySchema = z.strictObject({
  tenantId: z.string().refine(isTenantId),
  queueTaskName: z.string().regex(TASK_NAME_PATTERN),
  scheduleVersion: z.number().int().min(1),
}) satisfies z.ZodType<SurveyLaunchDoneRequest>;

/**
 * Sets the launch row of `body.queueTaskName` `done` under the body's tenant while it is still `scheduled`; returns whether it
 * wrote, or undefined (answered 404) when no launch row of that survey and schedule version is visible there.
 */
async function closeLaunchTask(
  deps: SurveyLaunchDoneRouteDeps,
  surveyId: string,
  body: SurveyLaunchDoneRequest,
): Promise<boolean | undefined> {
  // The body tenant is surveys' copy of the task's, never trusted alone: RLS hides another tenant's row, and the row must
  // be this survey's launch at this schedule version.
  return withGatedTenant(deps.db, body.tenantId, async (tx) => {
    // Checked on the locked row, so a concurrent cancel, supersede or completion of it is seen once it commits, never overwritten.
    const row = await lockScheduledTaskByName(tx, { queue: LAUNCH_QUEUE, queueTaskName: body.queueTaskName });
    if (row?.kind !== 'survey-launch' || row.source_id !== surveyId || row.schedule_version !== body.scheduleVersion) {
      return undefined;
    }
    if (row.status !== 'scheduled') {
      return false;
    }
    await deps.repository.setScheduledTaskStatus(tx, row.scheduled_task_id, 'done', DONE_CONTEXT);
    return true;
  });
}

/** Registers `markSurveyLaunchTaskDone`, callable only by surveys with its invocation credential. */
export async function registerSurveyLaunchDoneRoute(app: FastifyInstance, deps: SurveyLaunchDoneRouteDeps): Promise<void> {
  app.post<{ Params: { surveyId: string } }>(SURVEY_LAUNCH_DONE_PATH, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const path = pathSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!path.success || !body.success) {
      throw new LegacyApiError('invalidParameters');
    }
    const applied = await closeLaunchTask(deps, path.data.surveyId, body.data);
    if (applied === undefined) {
      // The service's not-found handler answers the legacy 404 envelope.
      reply.callNotFound();
      return reply;
    }
    // A task already done, superseded or cancelled is a 2xx no-op, so surveys' launch task stops retrying.
    return { applied } satisfies SurveyLaunchDoneResult;
  });
}
