// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/surveys` routes of the OPT-2 surveys screens: list, detail, schedule, targets, bulk targeting, responses and tasks. */
import { Readable } from 'node:stream';
import { AuthDenial, Roles, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import {
  JSON_CONTENT_TYPE,
  csrfPreHandler,
  jsonListStream,
  legacyParamsOf,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { applyBulkTarget, type BulkTargetInputItem } from '../domain/bulk-target.js';
import { listResponsePage } from '../domain/responses.js';
import { scheduleSurvey } from '../domain/schedule.js';
import { getSurveySummary, listSurveyTargets, type DomainDeps } from '../domain/surveys.js';
import { TASK_PAGE_MAX, listSurveyTaskViewBatches, listSurveyTaskViews } from '../domain/tasks-list.js';
import type { components, operations } from '../generated/openapi.js';
import { FixtureApiError, fixtureErrorResponse, fixtureMethod, fixturePage } from '../legacy/fixture-envelope.js';
import * as queries from '../repo/queries.js';

type SurveyList = operations['listSurveys']['responses'][200]['content']['application/json'];
type SurveyResponseList = operations['listSurveyResponses']['responses'][200]['content']['application/json'];
type SurveyTargetList = operations['listSurveyTargets']['responses'][200]['content']['application/json'];
type Survey = components['schemas']['Survey'];
type SurveySchedule = components['schemas']['SurveySchedule'];
type SurveyReminder = components['schemas']['SurveyReminder'];
type SurveyTarget = components['schemas']['SurveyTarget'];
type SurveyResponse = components['schemas']['SurveyResponse'];
type SurveyTaskList = operations['listSurveyTasks']['responses'][200]['content']['application/json'];
type ScheduleRequest = components['schemas']['ScheduleRequest'];
type BulkTargetRequest = components['schemas']['BulkTargetRequest'];
type BulkTargetResult = components['schemas']['BulkTargetResult'];

type SurveyRow = queries.SurveyDetail['survey'];
type SurveyResponseRow = queries.SurveyResponsePage['rows'][number];

// Declared here rather than imported from the route registry, which imports this module; the registry's deps stay assignable.
/** Dependencies of the `/v1/surveys` routes: the surveys domain's database, repository and clock. */
export type V1RouteDeps = DomainDeps;

interface SiteQuery {
  siteid: string;
}

interface SurveyParams {
  surveyId: string;
}

interface TargetsQuery extends SiteQuery {
  limit?: number;
  after?: string;
}

type ListRequest = FastifyRequest<{ Querystring: SiteQuery }>;
type SurveyRequest = FastifyRequest<{ Params: SurveyParams; Querystring: SiteQuery }>;
type TargetsRequest = FastifyRequest<{ Params: SurveyParams; Querystring: TargetsQuery }>;

interface TasksQuery extends SiteQuery {
  limit?: number;
  after?: string;
}

type TasksRequest = FastifyRequest<{ Params: SurveyParams; Querystring: TasksQuery }>;

const SURVEYS_PATH = '/v1/surveys';
const SURVEY_PATH = `${SURVEYS_PATH}/:surveyId`;

const MANAGER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.surveysManager]),
});

// `SiteIdQuery`: required; a value other than the token's site is refused 403 by the platform site check.
const SITE_QUERY_SCHEMA = {
  type: 'object',
  required: ['siteid'],
  properties: { siteid: { type: 'string', minLength: 1, maxLength: 25 } },
} as const;

// `SurveyId`: a CF UUID.
const SURVEY_PARAMS_SCHEMA = {
  type: 'object',
  required: ['surveyId'],
  properties: { surveyId: { type: 'string', pattern: '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$' } },
} as const;

// `SiteIdQuery` plus `TargetPageLimit` and `TargetPageAfter`, whose cursor `targetKeyOf` reads.
const TARGETS_QUERY_SCHEMA = {
  ...SITE_QUERY_SCHEMA,
  properties: {
    ...SITE_QUERY_SCHEMA.properties,
    limit: { type: 'integer', minimum: 1, maximum: queries.TARGET_PAGE_MAX },
    after: { type: 'string', minLength: 1 },
  },
} as const;

const LIST_OPTIONS = { config: { opt2: MANAGER_AUTH }, schema: { querystring: SITE_QUERY_SCHEMA } };
const SURVEY_OPTIONS = { config: { opt2: MANAGER_AUTH }, schema: { params: SURVEY_PARAMS_SCHEMA, querystring: SITE_QUERY_SCHEMA } };
const TARGETS_OPTIONS = { config: { opt2: MANAGER_AUTH }, schema: { params: SURVEY_PARAMS_SCHEMA, querystring: TARGETS_QUERY_SCHEMA } };

// `SiteIdQuery` plus the page `limit` and opaque `after` cursor the tasks route forwards to communications.
const TASKS_QUERY_SCHEMA = {
  ...SITE_QUERY_SCHEMA,
  properties: {
    ...SITE_QUERY_SCHEMA.properties,
    limit: { type: 'integer', minimum: 1, maximum: TASK_PAGE_MAX },
    after: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const TASKS_OPTIONS = { config: { opt2: MANAGER_AUTH }, schema: { params: SURVEY_PARAMS_SCHEMA, querystring: TASKS_QUERY_SCHEMA } };

// As surveys.cfc requireAny does, identity consumes the write's token for the survey id as sent before the body is read.
const SURVEY_WRITE_OPTIONS = {
  ...SURVEY_OPTIONS,
  preHandler: csrfPreHandler({ contextOf: (request) => (request.params as SurveyParams).surveyId }),
};

// Shapes only; launch time, offsets, site ids and group names are checked by the domain as the fixture checks them.
const scheduleBodySchema = z.strictObject({
  launchAt: z.string(),
  reminders: z.array(z.strictObject({ offsetMinutes: z.int() })).optional(),
}) satisfies z.ZodType<ScheduleRequest>;

const bulkTargetBodySchema = z.strictObject({
  targets: z.array(z.strictObject({ siteId: z.string(), groupName: z.string().nullable().optional() })),
}) satisfies z.ZodType<BulkTargetRequest>;

const targetKeySchema = z.tuple([z.string(), z.boolean(), z.string(), z.string()]) satisfies z.ZodType<queries.TargetKey>;

const SURVEY_METHOD = fixtureMethod('surveys');
const SCHEDULE_METHOD = fixtureMethod('surveys', 'schedule');
const TARGETS_METHOD = fixtureMethod('surveys', 'targets');
const BULK_TARGET_METHOD = fixtureMethod('surveys', 'targets', 'bulk');
const RESPONSES_METHOD = fixtureMethod('surveys', 'responses');
const TASKS_METHOD = fixtureMethod('surveys', 'tasks');

const LOCAL_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";

/** A stored time as the contract's zone-less `LocalTimestamp`. */
function localTimestamp(value: Date): string {
  return cfDateTimeFormat(value, LOCAL_TIMESTAMP_MASK);
}

/** A nullable stored time as a `LocalTimestamp` or null. */
function nullableTimestamp(value: Date | null): string | null {
  return value === null ? null : localTimestamp(value);
}

/** One stored reminder; its ordinal is the suffix of its `…-reminder-<n>` task name. */
function toReminder(row: queries.SurveyReminderView): SurveyReminder {
  return {
    reminderId: row.reminder_id,
    n: Number(row.task_name.slice(row.task_name.lastIndexOf('-') + 1)),
    offsetMinutes: row.offset_minutes,
    remindAt: localTimestamp(row.remind_at),
    taskName: row.task_name,
    sentAt: nullableTimestamp(row.sent_at),
  };
}

/** A stored schedule with its reminders in ordinal order. */
function toSchedule(schedule: queries.SurveyScheduleView, reminders: readonly queries.SurveyReminderView[]): SurveySchedule {
  return {
    surveyId: schedule.survey_id,
    launchAt: localTimestamp(schedule.launch_at),
    scheduleVersion: schedule.schedule_version,
    launchTaskName: schedule.task_name,
    reminders: reminders.map(toReminder),
  };
}

/** A stored survey with its schedule, null when never scheduled. */
function toSurvey(
  survey: SurveyRow,
  schedule: queries.SurveyScheduleView | null,
  reminders: readonly queries.SurveyReminderView[],
): Survey {
  return {
    surveyId: survey.survey_id,
    siteId: survey.siteid,
    title: survey.title,
    status: survey.status,
    created: localTimestamp(survey.created),
    createdById: survey.createdbyid,
    lastUpdate: nullableTimestamp(survey.lastupdate),
    lastUpdateById: survey.lastupdatebyid,
    launchedAt: nullableTimestamp(survey.launched_at),
    schedule: schedule === null ? null : toSchedule(schedule, reminders),
  };
}

/** One stored target. */
function toTarget(row: queries.SurveyTargetView): SurveyTarget {
  return {
    targetId: row.target_id,
    surveyId: row.survey_id,
    siteId: row.siteid,
    groupName: row.group_name,
    created: localTimestamp(row.created),
  };
}

/** One stored response, `answers` exactly as stored. */
function toResponse(row: SurveyResponseRow): SurveyResponse {
  return {
    responseId: row.response_id,
    surveyId: row.survey_id,
    siteId: row.siteid,
    respondentSiteId: row.respondentsiteid,
    respondentUserId: row.respondent_user_id,
    answers: row.answers,
    created: localTimestamp(row.created),
  };
}

/** The verified user claims; every route requires a user role, so a request without them is unauthenticated. */
function userOf(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  return user;
}

/** The request body parsed by `schema`; any other shape answers `invalidParameters`. */
function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  const body = schema.safeParse(request.body);
  if (!body.success) {
    throw new LegacyApiError('invalidParameters');
  }
  return body.data;
}

/** The opaque `next` cursor of a target key: its JSON as base64url. */
function targetCursor(key: queries.TargetKey): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** The target key an `after` cursor carries; any other text answers `invalidParameters`. */
function targetKeyOf(cursor: string): queries.TargetKey {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new LegacyApiError('invalidParameters');
  }
  const key = targetKeySchema.safeParse(value);
  if (!key.success) {
    throw new LegacyApiError('invalidParameters');
  }
  return key.data;
}

/** The target page a query asks for; none when it names neither `limit` nor `after`, which lists every target. */
function targetPageOf({ limit, after }: TargetsQuery): queries.TargetPageRequest | undefined {
  if (limit === undefined && after === undefined) {
    return undefined;
  }
  return { limit: limit ?? queries.TARGET_PAGE_DEFAULT, after: after === undefined ? undefined : targetKeyOf(after) };
}

/** The targets of `first` and of every page after it, each later page read in its own tenant transaction. */
async function* targetBatches(
  deps: V1RouteDeps,
  query: { tenantId: string; surveyId: string },
  first: queries.SurveyTargetPage,
): AsyncGenerator<SurveyTarget[]> {
  let page = first;
  yield page.rows.map(toTarget);
  while (page.next !== null) {
    page = await listSurveyTargets(deps, { ...query, page: { limit: queries.TARGET_PAGE_MAX, after: page.next } });
    yield page.rows.map(toTarget);
  }
}

/** Handler sending `fn`'s result as the body, a stream as a streamed JSON body; a `FixtureApiError` answers in the fixture error envelope of `method`, other errors propagate. */
function v1BodyHandler<R extends FastifyRequest, B>(
  method: string,
  fn: (request: R, user: UserClaims) => Promise<B | Readable>,
): (request: R, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    try {
      const body = await fn(request, userOf(request));
      if (body instanceof Readable) {
        return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
      }
      return reply.code(200).send(body);
    } catch (error) {
      if (!(error instanceof FixtureApiError)) {
        throw error;
      }
      return sendLegacyResponse(reply, fixtureErrorResponse(error, { method, params: legacyParamsOf(request) }));
    }
  };
}

/** Handler sending `fn`'s result as `{data}`, answering errors as {@link v1BodyHandler} does. */
function v1Handler<R extends FastifyRequest, T>(
  method: string,
  fn: (request: R, user: UserClaims) => Promise<T>,
): (request: R, reply: FastifyReply) => Promise<FastifyReply> {
  return v1BodyHandler(method, async (request: R, user) => ({ data: await fn(request, user) }));
}

// The contract's /v1 operations only; surveys are created and answered through the fixture routes, which have no /v1 twin.
/** Registers `listSurveys`, `getSurvey`, `scheduleSurvey`, `listSurveyTargets`, `bulkTargetSurvey`, `listSurveyResponses` and `listSurveyTasks`. */
export async function registerV1Routes(app: FastifyInstance, deps: V1RouteDeps): Promise<void> {
  app.get(
    SURVEYS_PATH,
    LIST_OPTIONS,
    v1BodyHandler(SURVEY_METHOD, async (request: ListRequest, user): Promise<SurveyList> => {
      const { pageIndex, itemsPerPage } = fixturePage(legacyParamsOf(request));
      return deps.db.withTenant(user.tid, async (tx) => {
        const page = await queries.listSurveys(tx, { siteId: user.site, pageIndex, itemsPerPage });
        const schedulings = await queries.listSchedulings(tx, page.rows.map((row) => row.survey_id));
        const data = page.rows.map((row) => {
          const { schedule, reminders } = schedulings.get(row.survey_id) ?? { schedule: null, reminders: [] };
          return toSurvey(row, schedule, reminders);
        });
        return { data, total: page.total };
      });
    }),
  );

  app.get(
    SURVEY_PATH,
    SURVEY_OPTIONS,
    v1Handler(SURVEY_METHOD, async (request: SurveyRequest, user): Promise<Survey> => {
      const { survey, schedule, reminders } = await getSurveySummary(deps, { tenantId: user.tid, surveyId: request.params.surveyId });
      return toSurvey(survey, schedule, reminders);
    }),
  );

  app.post<{ Params: SurveyParams; Querystring: SiteQuery }>(
    `${SURVEY_PATH}/schedule`,
    SURVEY_WRITE_OPTIONS,
    v1Handler(SCHEDULE_METHOD, async (request: SurveyRequest, user): Promise<SurveySchedule> => {
      const { launchAt, reminders } = parseBody(scheduleBodySchema, request);
      const detail = await scheduleSurvey(deps, {
        tenantId: user.tid,
        surveyId: request.params.surveyId,
        input: { launchAt, reminders },
      });
      if (detail.schedule === null) {
        throw new Error(`Survey ${detail.survey.survey_id} has no schedule after scheduling`);
      }
      return toSchedule(detail.schedule, detail.reminders);
    }),
  );

  app.get(
    `${SURVEY_PATH}/targets`,
    TARGETS_OPTIONS,
    v1BodyHandler(TARGETS_METHOD, async (request: TargetsRequest, user): Promise<SurveyTargetList | Readable> => {
      const page = targetPageOf(request.query);
      const query = { tenantId: user.tid, surveyId: request.params.surveyId };
      if (page === undefined) {
        // The first batch, and with it the survey check, is read before the answer starts.
        const first = await listSurveyTargets(deps, { ...query, page: { limit: queries.TARGET_PAGE_MAX } });
        return jsonListStream({}, 'data', targetBatches(deps, query, first), { next: null });
      }
      const { rows, next } = await listSurveyTargets(deps, { ...query, page });
      return { data: rows.map(toTarget), next: next === null ? null : targetCursor(next) };
    }),
  );

  app.post<{ Params: SurveyParams; Querystring: SiteQuery }>(
    `${SURVEY_PATH}/targets/bulk`,
    SURVEY_WRITE_OPTIONS,
    v1Handler(BULK_TARGET_METHOD, async (request: SurveyRequest, user): Promise<BulkTargetResult> => {
      const { targets } = parseBody(bulkTargetBodySchema, request);
      // The domain reads the fixture's `siteID` key exactly, as the fixture's targets array spells it.
      const input: BulkTargetInputItem[] = targets.map(({ siteId, groupName }) => ({ siteID: siteId, groupName: groupName ?? null }));
      const { inserted, total } = await applyBulkTarget(deps, { tenantId: user.tid, surveyId: request.params.surveyId, input });
      return { inserted, total };
    }),
  );

  app.get(
    `${SURVEY_PATH}/responses`,
    SURVEY_OPTIONS,
    v1BodyHandler(RESPONSES_METHOD, async (request: SurveyRequest, user): Promise<SurveyResponseList> => {
      const params = legacyParamsOf(request);
      const page = await listResponsePage(deps, { tenantId: user.tid, surveyId: request.params.surveyId, params });
      return { data: page.list.map(toResponse), total: page.totalItems };
    }),
  );

  app.get(
    `${SURVEY_PATH}/tasks`,
    TASKS_OPTIONS,
    v1BodyHandler(TASKS_METHOD, async (request: TasksRequest, user): Promise<SurveyTaskList | Readable> => {
      const { limit, after } = request.query;
      const query = { tenantId: user.tid, surveyId: request.params.surveyId };
      if (limit === undefined && after === undefined) {
        return jsonListStream({}, 'data', await listSurveyTaskViewBatches(app, query), { next: null });
      }
      const { items, next } = await listSurveyTaskViews(app, query, { limit, after });
      return { data: items, next };
    }),
  );
}
