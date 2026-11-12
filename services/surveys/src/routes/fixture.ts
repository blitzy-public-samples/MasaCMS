// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `surveys/surveys…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/surveys.cfc answers them. */
import { Roles, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
import { tenantForRegisteredSite } from '@opt2/platform/tenancy';
import { applyBulkTarget } from '../domain/bulk-target.js';
import { launchSurvey } from '../domain/launch.js';
import { listResponsePage, submitResponse } from '../domain/responses.js';
import { scheduleSurvey } from '../domain/schedule.js';
import { createSurvey, getSurvey, listSurveys, type DomainDeps } from '../domain/surveys.js';
import { listSurveyTasks } from '../domain/tasks-list.js';
import type { components } from '../generated/openapi.js';
import {
  checkTaskToken,
  fixtureHttpMethod,
  isSiteMember,
  requireAny,
  requireCsrf,
  requireLogin,
  resolveSite,
  taskTokenOf,
  userId,
  type FixtureSiteLookup,
} from '../legacy/fixture-auth.js';
import {
  FixtureApiError,
  fixtureHandler,
  fixtureList,
  fixtureMethod,
  fixturePage,
  fixtureSuccess,
  type FixtureContext,
  type FixtureParams,
} from '../legacy/fixture-envelope.js';
import { collated } from '../repo/grants.js';
import { getSchedule, type SurveyDetail, type SurveyReminderView, type SurveyScheduleView, type SurveyTargetView } from '../repo/queries.js';
import type { SurveyResponseRow, SurveyRow } from '../repo/tables.js';

type Schemas = components['schemas'];

/** The domain's database, repository and clock plus the site lookup of `resolveSite`; declared here, so no registry import is needed. */
export type FixtureRouteDeps = DomainDeps & { siteLookup: FixtureSiteLookup };

/** Fastify path of the surveys fixture collection; every fixture path below is built from it. */
export const FIXTURE_BASE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';

// api.cfm resolves the site before surveys.cfc checks login and role, so these routes are public on the platform and
// resolveSite, requireLogin and requireAny decide in the handler. A platform `requires` list would refuse an anonymous
// or role-less caller before the site check, in the JSON API envelope rather than the fixture's.
const FIXTURE_ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

const MANAGER_ROLES: readonly string[] = Object.freeze([Roles.surveysManager]);
const DATE_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** The methods the contract declares on a fixture path; api.cfm dispatches no other. */
type HttpMethod = 'GET' | 'POST';

/** One fixture request after api.cfm's site check. */
interface FixtureCall {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: FixtureContext;
  /** The registered site id `resolveSite` returned. */
  site: string;
  /** The `{id}` path segment as sent; '' on the collection. */
  id: string;
}

type MethodHandler = (call: FixtureCall) => Promise<FastifyReply>;

/** The merged param under `name` ignoring case, as surveys.cfc paramValue reads it; undefined when absent. */
function param(params: FixtureParams, name: string): unknown {
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : params[key];
}

/** The survey id to look up: stored ids are upper-case CF UUIDs, so this reproduces SQL Server's case-insensitive match. */
function storedId(call: FixtureCall): string {
  return call.id.toUpperCase();
}

/** auth.cfc requireAny(surveys.manager): login, the role group, then the write's CSRF token for context `id`. */
async function requireManager(call: FixtureCall): Promise<UserClaims> {
  const user = requireAny(call.request, MANAGER_ROLES);
  await requireCsrf(call.request, call.reply, call.id);
  return user;
}

/** A timestamp as envelope.cfc rows() writes it: local time to the second. */
function fixtureDate(value: Date): string {
  return cfDateTimeFormat(value, DATE_MASK);
}

/** A nullable timestamp; NULL reads as the empty string ACF gives it. */
function fixtureOptionalDate(value: Date | null): string {
  return value === null ? '' : fixtureDate(value);
}

/** A `synthetic.survey` row as `SELECT *` and rows() give it, in DDL column order. */
function fixtureSurvey(row: SurveyRow): Schemas['FixtureSurvey'] {
  return {
    survey_id: row.survey_id,
    siteid: row.siteid,
    title: row.title,
    status: row.status,
    created: fixtureDate(row.created),
    createdbyid: row.createdbyid,
    lastupdate: fixtureOptionalDate(row.lastupdate),
    lastupdatebyid: row.lastupdatebyid ?? '',
    launched_at: fixtureOptionalDate(row.launched_at),
  };
}

function fixtureSchedule(row: SurveyScheduleView): Schemas['FixtureSurveySchedule'] {
  return {
    schedule_id: row.schedule_id,
    survey_id: row.survey_id,
    launch_at: fixtureDate(row.launch_at),
    schedule_version: row.schedule_version,
    task_name: row.task_name,
    created: fixtureDate(row.created),
  };
}

function fixtureReminder(row: SurveyReminderView): Schemas['FixtureSurveyReminder'] {
  return {
    reminder_id: row.reminder_id,
    survey_id: row.survey_id,
    offset_minutes: row.offset_minutes,
    remind_at: fixtureDate(row.remind_at),
    task_name: row.task_name,
    sent_at: fixtureOptionalDate(row.sent_at),
  };
}

function fixtureTarget(row: SurveyTargetView): Schemas['FixtureSurveyTarget'] {
  return {
    target_id: row.target_id,
    survey_id: row.survey_id,
    siteid: row.siteid,
    group_name: row.group_name ?? '',
    created: fixtureDate(row.created),
  };
}

function fixtureResponse(row: SurveyResponseRow): Schemas['FixtureSurveyResponse'] {
  return {
    response_id: row.response_id,
    survey_id: row.survey_id,
    siteid: row.siteid,
    respondentsiteid: row.respondentsiteid,
    respondent_user_id: row.respondent_user_id,
    answers: row.answers,
    created: fixtureDate(row.created),
  };
}

/** surveys.cfc surveyDetail(): the survey row, then its schedule (`{}` when never scheduled), reminders and targets. */
function fixtureDetail({ survey, schedule, reminders, targets }: SurveyDetail): Schemas['FixtureSurveyDetail'] {
  return {
    ...fixtureSurvey(survey),
    schedule: schedule === null ? {} : fixtureSchedule(schedule),
    reminders: reminders.map(fixtureReminder),
    targets: targets.map(fixtureTarget),
  };
}

/**
 * Registers one fixture path for exactly its declared methods. As api.cfm does, the site is checked first, then the
 * effective method (X-HTTP-Method-Override included) picks the handler, and a method the path lacks answers notFound.
 */
function registerPath(
  app: FastifyInstance,
  lookup: FixtureSiteLookup,
  url: string,
  method: string,
  handlers: ReadonlyArray<readonly [HttpMethod, MethodHandler]>,
): void {
  app.route<{ Params: { id?: string } }>({
    method: handlers.map(([httpMethod]) => httpMethod),
    url,
    config: { opt2: FIXTURE_ROUTE_AUTH },
    handler: fixtureHandler(method, async (request, reply, ctx) => {
      const site = await resolveSite(request, ctx.params, lookup);
      const effective = fixtureHttpMethod(request);
      const handler = handlers.find(([httpMethod]) => httpMethod === effective)?.[1];
      if (handler === undefined) {
        throw new FixtureApiError('notFound');
      }
      return handler({ request, reply, ctx, site, id: request.params.id ?? '' });
    }),
  });
}

/** Registers the surveys fixture routes the contract declares; `/{id}/remind` is registered by `./remind.js`. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: FixtureRouteDeps): Promise<void> {
  const register = (url: string, method: string, handlers: ReadonlyArray<readonly [HttpMethod, MethodHandler]>): void =>
    registerPath(app, deps.siteLookup, url, method, handlers);

  const list: MethodHandler = async (call) => {
    const user = await requireManager(call);
    // queryPage validates paging before it counts the site's surveys.
    const { pageIndex, itemsPerPage } = fixturePage(call.ctx.params);
    const { rows, total } = await listSurveys(deps, { tenantId: user.tid, filters: { siteId: call.site, pageIndex, itemsPerPage } });
    return fixtureList(call.reply, {
      ...call.ctx,
      listResult: { list: rows.map(fixtureSurvey), pageIndex, itemsPerPage, totalItems: total },
    });
  };

  const create: MethodHandler = async (call) => {
    const user = await requireManager(call);
    const detail = await createSurvey(deps, {
      tenantId: user.tid,
      siteId: call.site,
      userId: userId(call.request),
      input: { title: param(call.ctx.params, 'title') },
    });
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureDetail(detail) });
  };

  const detail: MethodHandler = async (call) => {
    const user = await requireManager(call);
    const found = await getSurvey(deps, { tenantId: user.tid, surveyId: storedId(call) });
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureDetail(found) });
  };

  const schedule: MethodHandler = async (call) => {
    const user = await requireManager(call);
    // The domain writes the schedule, reminders and the scheduled event in one gated transaction; communications creates the tasks.
    const scheduled = await scheduleSurvey(deps, {
      tenantId: user.tid,
      surveyId: storedId(call),
      input: { launchAt: param(call.ctx.params, 'launchAt'), reminders: param(call.ctx.params, 'reminders') },
    });
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureDetail(scheduled) });
  };

  const bulkTarget: MethodHandler = async (call) => {
    const user = await requireManager(call);
    const { inserted, total } = await applyBulkTarget(deps, {
      tenantId: user.tid,
      surveyId: storedId(call),
      input: param(call.ctx.params, 'targets'),
    });
    return fixtureSuccess(call.reply, { ...call.ctx, data: { inserted, total } satisfies Schemas['FixtureBulkTargetResult'] });
  };

  const responses: MethodHandler = async (call) => {
    const user = await requireManager(call);
    const page = await listResponsePage(deps, { tenantId: user.tid, surveyId: storedId(call), params: call.ctx.params });
    return fixtureList(call.reply, { ...call.ctx, listResult: { ...page, list: page.list.map(fixtureResponse) } });
  };

  const respond: MethodHandler = async (call) => {
    // createResponse needs a site member, not a role group, and checks its CSRF token before it looks for the survey.
    const user = requireLogin(call.request);
    if (!isSiteMember(call.request)) {
      throw new FixtureApiError('forbidden');
    }
    await requireCsrf(call.request, call.reply, call.id);
    const row = await submitResponse(deps, {
      tenantId: user.tid,
      site: call.site,
      userId: userId(call.request),
      surveyId: storedId(call),
      input: { answers: param(call.ctx.params, 'answers') },
    });
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureResponse(row) });
  };

  const tasks: MethodHandler = async (call) => {
    const user = await requireManager(call);
    // envelope.list pages the task items only after they are read.
    const items = await listSurveyTasks(app, { tenantId: user.tid, surveyId: storedId(call) });
    return fixtureList(call.reply, { ...call.ctx, items });
  };

  const launch: MethodHandler = async (call) => {
    // An ACF task run carries no user token; its credential is the task token, checked in the tenant the registry gives
    // the resolved site, as the fixture checks it against the survey of that site.
    const tenantId = await tenantForRegisteredSite(deps.db, call.site);
    if (tenantId === null) {
      throw new LegacyApiError('invalidParameters');
    }
    const token = taskTokenOf(call.request);
    const surveyId = storedId(call);
    const { survey } = await withGatedTenant(deps.db, tenantId, async (tx) => {
      // The survey row is locked before its schedule is read, the order the fixture and every reschedule lock them in.
      const locked = await deps.repository.lockSurvey(tx, surveyId);
      const stored = locked !== null && collated(locked.siteid) === collated(call.site) ? await getSchedule(tx, locked.survey_id) : null;
      if (locked === null || !checkTaskToken(token, stored?.task_token_hash ?? '')) {
        throw new FixtureApiError('forbidden');
      }
      return launchSurvey(tx, { repository: deps.repository, surveyId: locked.survey_id });
    });
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureSurvey(survey) });
  };

  register(FIXTURE_BASE, fixtureMethod('surveys'), [
    ['GET', list],
    ['POST', create],
  ]);
  register(`${FIXTURE_BASE}/:id`, fixtureMethod('surveys'), [['GET', detail]]);
  register(`${FIXTURE_BASE}/:id/schedule`, fixtureMethod('surveys', 'schedule'), [['POST', schedule]]);
  register(`${FIXTURE_BASE}/:id/targets/bulk`, fixtureMethod('surveys', 'targets', 'bulk'), [['POST', bulkTarget]]);
  register(`${FIXTURE_BASE}/:id/responses`, fixtureMethod('surveys', 'responses'), [
    ['GET', responses],
    ['POST', respond],
  ]);
  register(`${FIXTURE_BASE}/:id/tasks`, fixtureMethod('surveys', 'tasks'), [['GET', tasks]]);
  register(`${FIXTURE_BASE}/:id/launch`, fixtureMethod('surveys', 'launch'), [
    ['GET', launch],
    ['POST', launch],
  ]);
}
