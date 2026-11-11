// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey task lists over a stubbed communications client and a throwaway `surveys` schema: fixture items, `/v1` views, notFound and the 503. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  fixedClock,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { listSurveyTaskViews, listSurveyTasks } from '../../src/domain/tasks-list.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import type { ScheduledTaskRecord } from '../../src/legacy/tasks-view.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const HASH = 'b'.repeat(64);
const REMINDER_TASK_ID = 'AAAAAAAA-BBBB-CCCC-DDDDDDDDDDDDDDDD';

/** A stubbed service client recording every call and answering each with `answer`. */
function stubClient(answer: (req: ServiceRequest) => Promise<ServiceResponse>): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      return answer(req) as Promise<ServiceResponse<T>>;
    },
    close: () => Promise.resolve(),
  };
  return { client, calls };
}

/** The `app.opt2` surface the task lists read: the tenant database and the service client. */
function appOf(db: TenantDb | undefined, client: ServiceClient): FastifyInstance {
  return { opt2: { db, client } } as unknown as FastifyInstance;
}

function answer(status: number, body: unknown): () => Promise<ServiceResponse> {
  return () => Promise.resolve({ status, headers: { 'content-type': 'application/json' }, body });
}

const listers = [
  ['listSurveyTasks', listSurveyTasks],
  ['listSurveyTaskViews', listSurveyTaskViews],
] as const;

const available = await pgAvailable();

describe.skipIf(!available)('survey task lists against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;
  let tenants = 0;
  let siteA: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    repository = createSurveysRepository({ clock: fixedClock(T0), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    tenants += 1;
    siteA = `surveys-tasks-a-${tenants}`;
    tenantA = tenantIdForSite(siteA);
    tenantB = tenantIdForSite(`surveys-tasks-b-${tenants}`);
  });

  /** A survey of tenant A, scheduled at T0 + 1 h with reminders at 1440 and 30 minutes unless `scheduled` is false; returns its id. */
  function seedSurvey(scheduled = true): Promise<string> {
    return withGatedTenant(handle.app, tenantA, async (tx) => {
      const survey = await repository.insertSurvey(tx, { siteId: siteA, title: 'Pulse', createdById: USER_ID });
      if (scheduled) {
        const launchAt = new Date(T0.getTime() + 3_600_000);
        await repository.upsertSchedule(tx, survey.survey_id, { launchAt, taskTokenHash: HASH });
        await repository.replaceReminders(
          tx,
          survey.survey_id,
          [1440, 30].map((offsetMinutes) => ({
            offsetMinutes,
            remindAt: new Date(launchAt.getTime() + offsetMinutes * 60_000),
            taskTokenHash: HASH,
          })),
        );
      }
      return survey.survey_id;
    });
  }

  /** Communications' record of the survey's launch task, or of its reminder `n`. */
  function record(surveyId: string, n: number | null, over: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
    const launch = n === null;
    return {
      taskName: `opt2-survey-${surveyId}-${launch ? 'launch' : `reminder-${n}`}`,
      kind: launch ? 'survey-launch' : 'survey-reminder',
      n,
      targetRoute: launch ? `/internal/v1/tasks/surveys/${surveyId}/launch` : `/internal/v1/tasks/reminders/${REMINDER_TASK_ID}`,
      scheduleTime: '2026-06-30T10:00:00.000',
      status: 'scheduled',
      scheduleVersion: 1,
      queue: launch ? 'surveys-launch' : 'communications-reminders',
      ...over,
    };
  }

  function listBody(surveyId: string, items: ScheduledTaskRecord[]): unknown {
    return { sourceType: 'survey', sourceId: surveyId, scheduleVersion: items.length > 0 ? 1 : null, items };
  }

  it('asks communications for the survey\'s tasks and lists them as the fixture does, by recorded offset then name', async () => {
    const surveyId = await seedSurvey();
    const records = [
      record(surveyId, 1, { scheduleTime: '2026-07-01T10:00:00.000' }),
      record(surveyId, null),
      record(surveyId, 2, { scheduleTime: '2026-06-30T10:30:00.000', status: 'done' }),
      record(surveyId, null, { status: 'superseded', scheduleVersion: 1 }),
    ];
    const { client, calls } = stubClient(answer(200, listBody(surveyId, records)));
    const route = `/legacy-fixtures/cfml/api.cfm/surveys/surveys/${surveyId}`;

    const items = await listSurveyTasks(appOf(handle.app, client), { tenantId: tenantA, surveyId });

    expect(calls).toEqual([
      {
        service: 'communications',
        method: 'GET',
        path: '/internal/v1/scheduled-tasks',
        query: { sourceType: 'survey', sourceId: surveyId },
      },
    ]);
    expect(items).toEqual([
      { taskname: `opt2-survey-${surveyId}-launch`, kind: 'launch', route: `${route}/launch`, offsetminutes: 0 },
      { taskname: `opt2-survey-${surveyId}-reminder-2`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 30 },
      { taskname: `opt2-survey-${surveyId}-reminder-1`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 1440 },
    ]);
  });

  it('lists no tasks for a survey that was never scheduled', async () => {
    const surveyId = await seedSurvey(false);
    const { client } = stubClient(answer(200, listBody(surveyId, [])));

    await expect(listSurveyTasks(appOf(handle.app, client), { tenantId: tenantA, surveyId })).resolves.toEqual([]);
  });

  it('gives the /v1 views every record of communications\' current schedule version in communications\' order', async () => {
    const surveyId = await seedSurvey();
    const records = [record(surveyId, null), record(surveyId, 2, { status: 'cancelled' }), record(surveyId, 1, { status: 'failed' })];
    const { client, calls } = stubClient(answer(200, listBody(surveyId, records)));

    const views = await listSurveyTaskViews(appOf(handle.app, client), { tenantId: tenantA, surveyId });

    expect(calls.map((call) => call.query)).toEqual([{ sourceType: 'survey', sourceId: surveyId }]);
    expect(views).toEqual([
      { taskName: records[0]?.taskName, kind: 'launch', scheduleTime: '2026-06-30T10:00:00.000', status: 'scheduled' },
      { taskName: records[1]?.taskName, kind: 'reminder', scheduleTime: '2026-06-30T10:00:00.000', status: 'cancelled' },
      { taskName: records[2]?.taskName, kind: 'reminder', scheduleTime: '2026-06-30T10:00:00.000', status: 'failed' },
    ]);
  });

  describe.each(listers)('%s', (_name, list) => {
    it('answers the fixture notFound for an unknown id and another tenant\'s survey without calling communications', async () => {
      const surveyId = await seedSurvey();
      const { client, calls } = stubClient(answer(200, listBody(surveyId, [])));

      for (const [tenantId, id] of [
        [tenantA, UNKNOWN_ID],
        [tenantB, surveyId],
      ] as const) {
        const error = await list(appOf(handle.app, client), { tenantId, surveyId: id }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FixtureApiError);
        expect(error).toMatchObject({ type: 'notFound' });
      }
      expect(calls).toEqual([]);
    });

    it.each([400, 401, 403, 404, 500, 503])('answers the legacy 503 when communications answers HTTP %i', async (status) => {
      const surveyId = await seedSurvey();
      const { client } = stubClient(answer(status, { error: 'x' }));

      const error = await list(appOf(handle.app, client), { tenantId: tenantA, surveyId }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(error).not.toBeInstanceOf(ServiceUnavailableError);
      expect(error).toMatchObject({ surface: 'auto', message: `Service communications listScheduledTasks answered HTTP ${status}` });
    });

    it('lets the client\'s ServiceUnavailableError propagate unchanged', async () => {
      const surveyId = await seedSurvey();
      const refused = new ServiceUnavailableError('communications', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      const { client } = stubClient(() => Promise.reject(refused));

      await expect(list(appOf(handle.app, client), { tenantId: tenantA, surveyId })).rejects.toBe(refused);
    });
  });
});

describe('survey task lists without a database', () => {
  it.each(listers)('%s rejects with a TypeError before calling communications', async (_name, list) => {
    const { client, calls } = stubClient(answer(200, {}));

    await expect(list(appOf(undefined, client), { tenantId: tenantIdForSite('tenant-a'), surveyId: UNKNOWN_ID })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(calls).toEqual([]);
  });
});
