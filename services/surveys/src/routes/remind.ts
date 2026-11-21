// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reminder-sent routes: communications' `markReminderSent` callback and the fixture `surveys/surveys/{id}/remind` task callback. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import { recordReminderSent, type ReminderOutcome, type ReminderResult } from '../domain/reminders.js';
import type { components } from '../generated/openapi.js';
import { checkTaskToken, fixtureHttpMethod, resolveSite, taskTokenOf, type FixtureSiteLookup } from '../legacy/fixture-auth.js';
import {
  FixtureApiError,
  fixtureHandler,
  fixtureMethod,
  fixtureSuccess,
  parseCfInteger,
  type FixtureParams,
} from '../legacy/fixture-envelope.js';
import { collated } from '../repo/grants.js';
import * as queries from '../repo/queries.js';
import { reminderTaskName, type SurveysRepository } from '../repo/repository.js';

type ReminderSentRequest = components['schemas']['ReminderSentRequest'];
type ReminderSentResult = components['schemas']['ReminderSentResult'];
type FixtureSurveyReminder = components['schemas']['FixtureSurveyReminder'];

/** The registry's database and repository plus its fixture site lookup; declared here, so no registry import is needed. */
export interface RemindRouteDeps {
  db: TenantDb;
  repository: SurveysRepository;
  siteLookup: FixtureSiteLookup;
}

/** Fastify path of `markReminderSent`. */
export const REMINDER_SENT_PATH = '/internal/v1/surveys/:surveyId/reminders/:n/sent';

/** Fastify path of the fixture reminder task callback (`fixtureRemindCallback` and its POST twin). */
export const FIXTURE_REMIND_PATH = '/legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/remind';

const SENT_ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('communications')]),
});

// api.cfm resolves the site before any login check and an ACF task run carries no session, so the callback is public
// with the site checked by resolveSite.
const FIXTURE_ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

const REMIND_METHOD = fixtureMethod('surveys', 'remind');
const REMIND_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TENANT_ID =
  /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}|00000000-0000-0000-0000-000000000000|[Ff]{8}-[Ff]{4}-[Ff]{4}-[Ff]{4}-[Ff]{12})$/;
const REMINDER_TASK_NAME = /^opt2-survey-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}-reminder-[1-9][0-9]*$/;
const LOCAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/;
const LOCAL_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";
const FIXTURE_DATE_MASK = "yyyy-mm-dd'T'HH:nn:ss";
const ASCII_INTEGER = /^[+-]?[0-9]+$/;

/** A LocalTimestamp that names an existing wall time of the process zone: no rolled-over date and no skipped DST time. */
function isLocalWallTime(text: string): boolean {
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && cfDateTimeFormat(instant, LOCAL_TIMESTAMP_MASK) === text;
}

const sentPathSchema = z.object({
  surveyId: z.string().regex(CF_UUID),
  n: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.number().int()),
});

const sentBodySchema = z.strictObject({
  tenantId: z.string().regex(TENANT_ID),
  siteId: z.string().min(1).max(25),
  taskName: z.string().max(100).regex(REMINDER_TASK_NAME),
  scheduleVersion: z.number().int().min(1),
  sentAt: z.string().regex(LOCAL_TIMESTAMP).refine(isLocalWallTime),
}) satisfies z.ZodType<ReminderSentRequest>;

/** Stamps reminder `n` under the body's tenant; undefined (answered 404) when its task name, tenant or site does not reach it. */
async function recordSent(
  deps: RemindRouteDeps,
  { surveyId, n }: { surveyId: string; n: number },
  body: ReminderSentRequest,
): Promise<ReminderOutcome | undefined> {
  if (body.taskName !== reminderTaskName(surveyId, n)) {
    return undefined;
  }
  try {
    // The body tenant is communications' stored copy, never trusted alone: RLS hides another tenant's survey and the
    // site is compared with the stored survey's.
    return await withGatedTenant(deps.db, body.tenantId, async (tx) => {
      const survey = await queries.findSurvey(tx, surveyId);
      if (survey === null || collated(survey.siteid) !== collated(body.siteId)) {
        return undefined;
      }
      const result = await recordReminderSent(tx, {
        repository: deps.repository,
        surveyId: survey.survey_id,
        n,
        scheduleVersion: body.scheduleVersion,
        sentAt: new Date(body.sentAt),
      });
      return result.outcome;
    });
  } catch (error) {
    if (error instanceof FixtureApiError && error.type === 'notFound') {
      return undefined;
    }
    throw error;
  }
}

/** The value under `name` ignoring case, the last spelling winning; undefined when absent. */
function valueNoCase(values: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(values).findLast((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : values[key];
}

/** The fixture's `reminder` param: a simple value ACF's isValid('integer') accepts, at least 1; else invalidParameters. */
function reminderOrdinal(params: FixtureParams): number {
  const value = valueNoCase(params, 'reminder') ?? '';
  const n = typeof value === 'string' ? parseCfInteger(value) : undefined;
  if (typeof value !== 'string' || n === undefined) {
    throw new LegacyApiError('invalidParameters');
  }
  if (!ASCII_INTEGER.test(value)) {
    // ACF compares non-ASCII digit text with 1 as a string, then its int() rejects it with an Expression error.
    if (value < '1') {
      throw new LegacyApiError('invalidParameters');
    }
    throw new Error('The reminder parameter holds non-ASCII digits');
  }
  if (n < 1) {
    throw new LegacyApiError('invalidParameters');
  }
  return n;
}

/** A reminder row as envelope.cfc rows() selects it: the fixture columns in order, dates to the second, NULL as ''. */
function fixtureReminder(row: ReminderResult['reminder']): FixtureSurveyReminder {
  return {
    reminder_id: row.reminder_id,
    survey_id: row.survey_id,
    offset_minutes: row.offset_minutes,
    remind_at: cfDateTimeFormat(row.remind_at, FIXTURE_DATE_MASK),
    task_name: row.task_name,
    sent_at: row.sent_at === null ? '' : cfDateTimeFormat(row.sent_at, FIXTURE_DATE_MASK),
  };
}

/** Registers `markReminderSent` and the fixture reminder task callback (GET and POST). */
export async function registerRemindRoutes(app: FastifyInstance, deps: RemindRouteDeps): Promise<void> {
  app.post<{ Params: { surveyId: string; n: string } }>(
    REMINDER_SENT_PATH,
    { config: { opt2: SENT_ROUTE_AUTH } },
    async (request, reply) => {
      const path = sentPathSchema.safeParse(request.params);
      const body = sentBodySchema.safeParse(request.body);
      if (!path.success || !body.success) {
        throw new LegacyApiError('invalidParameters');
      }
      const outcome = await recordSent(deps, path.data, body.data);
      if (outcome === undefined) {
        // The service's not-found handler answers the legacy 404 envelope.
        reply.callNotFound();
        return reply;
      }
      // An already-sent reminder and an older schedule version are 2xx no-ops, so communications' task stops retrying.
      return { applied: outcome === 'recorded' } satisfies ReminderSentResult;
    },
  );

  app.route<{ Params: { id: string } }>({
    method: ['GET', 'POST'],
    url: FIXTURE_REMIND_PATH,
    config: { opt2: FIXTURE_ROUTE_AUTH },
    handler: fixtureHandler(REMIND_METHOD, async (request, reply, ctx) => {
      const site = await resolveSite(request, ctx.params, deps.siteLookup);
      // api.cfm answers GET and POST alike and any other overriding method with notFound, after the site check.
      if (!REMIND_HTTP_METHODS.has(fixtureHttpMethod(request))) {
        throw new FixtureApiError('notFound');
      }
      // An ACF task run carries no user token; its credential is the task token, checked in the tenant the registry
      // gives the resolved site, as the fixture checks it against the survey of that site.
      const tenantId = await tenantForRegisteredSite(deps.db, site);
      if (tenantId === null) {
        throw new LegacyApiError('invalidParameters');
      }
      const token = taskTokenOf(request);
      // Stored ids are upper-case CF UUIDs, so upper-casing reproduces SQL Server's case-insensitive id match.
      const surveyId = request.params.id.toUpperCase();
      const result = await withGatedTenant(deps.db, tenantId, async (tx) => {
        // The survey row is locked before its schedule is read, the order the fixture and every reschedule lock them in.
        const survey = await deps.repository.lockSurvey(tx, surveyId);
        const schedule =
          survey !== null && collated(survey.siteid) === collated(site) ? await queries.getSchedule(tx, survey.survey_id) : null;
        if (survey === null || !checkTaskToken(token, schedule?.task_token_hash ?? '')) {
          throw new FixtureApiError('forbidden');
        }
        const n = reminderOrdinal(ctx.params);
        return recordReminderSent(tx, { repository: deps.repository, surveyId: survey.survey_id, n });
      });
      return fixtureSuccess(reply, { ...ctx, data: fixtureReminder(result.reminder) });
    }),
  });
}
