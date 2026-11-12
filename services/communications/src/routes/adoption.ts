// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Scheduler hand-off routes: migration adopts the fixture's `opt2-survey-*` ACF tasks, and cancels them on restoration. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  adoptScheduledTasks,
  cancelAdoptedScheduledTasks,
  type AdoptRequest,
  type AdoptResult,
  type AdoptedTaskInput,
  type CancelRequest,
  type CancelResult,
} from '../domain/adoption.js';
import type { SurveyScheduleDeps } from '../domain/survey-schedule.js';

// Declared here rather than imported from ./index.js, which is generated after this file and imports it; the registry's
// RouteContext is a structural superset, so it is passed unchanged.
/** The schedule dependencies the hand-off domain receives. */
export type AdoptionRouteDeps = { scheduleDeps: SurveyScheduleDeps };

/** Fastify path of `adoptScheduledTasks`. */
export const ADOPT_PATH = '/internal/v1/migration/adopt-scheduled-tasks';

/** Fastify path of `cancelAdoptedScheduledTasks`. */
export const CANCEL_ADOPTED_PATH = '/internal/v1/migration/cancel-adopted-scheduled-tasks';

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformMigration]),
});

// The contract's ScheduledTaskName, SiteId and LocalTimestamp.
const taskNameSchema = z
  .string()
  .max(100)
  .regex(/^opt2-survey-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}-(launch|reminder-[1-9][0-9]*)$/);
const siteIdSchema = z.string().max(25);
const localTimestampSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/);

const adoptedTaskSchema = z.strictObject({
  name: taskNameSchema,
  siteId: siteIdSchema,
  scheduleTime: localTimestampSchema,
  scheduleVersion: z.number().int().min(1),
}) satisfies z.ZodType<AdoptedTaskInput>;

/** Body of `adoptScheduledTasks` as the contract's `AdoptScheduledTasksRequest`; it names no tenant, which the domain derives per site. */
export const adoptRequestSchema = z.strictObject({
  tasks: z.array(adoptedTaskSchema),
}) satisfies z.ZodType<AdoptRequest>;

/** Body of `cancelAdoptedScheduledTasks` as the contract's `CancelAdoptedTasksRequest`; every adopted task when `names` is absent. */
export const cancelRequestSchema = z.strictObject({
  names: z.array(taskNameSchema).optional(),
}) satisfies z.ZodType<CancelRequest>;

/** `body` parsed by `schema`; throws `LegacyApiError('invalidParameters')` when it does not match. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new LegacyApiError('invalidParameters');
  }
  return parsed.data;
}

/** Registers `adoptScheduledTasks` and `cancelAdoptedScheduledTasks`, callable only with the `platform.migration` service identity. */
export async function registerAdoptionRoutes(app: FastifyInstance, ctx: AdoptionRouteDeps): Promise<void> {
  const { scheduleDeps } = ctx;

  app.post<{ Reply: AdoptResult }>(ADOPT_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) =>
    adoptScheduledTasks(scheduleDeps, parseBody(adoptRequestSchema, request.body)),
  );

  app.post<{ Reply: CancelResult }>(CANCEL_ADOPTED_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) =>
    cancelAdoptedScheduledTasks(scheduleDeps, parseBody(cancelRequestSchema, request.body)),
  );
}
