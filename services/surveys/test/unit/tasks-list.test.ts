// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey task lists over a stubbed communications client and a throwaway `surveys` schema: fixture pages by name batch, `/v1` views and pages, notFound and the 503. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  fixedClock,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  TASK_NAME_BATCH,
  listSurveyTaskPage,
  listSurveyTaskViewBatches,
  listSurveyTaskViews,
  type SurveyTasksQuery,
} from '../../src/domain/tasks-list.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import type { ScheduledTaskRecord, ScheduledTaskViewItem } from '../../src/legacy/tasks-view.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { referenceFixtureTaskPage } from '../helpers/fixture-tasks.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const HASH = 'b'.repeat(64);

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

/** Every view the batches hold, in order. */
async function collect(batches: AsyncIterable<ScheduledTaskViewItem[]>): Promise<ScheduledTaskViewItem[]> {
  const views: ScheduledTaskViewItem[] = [];
  for await (const batch of batches) views.push(...batch);
  return views;
}

/** The fixture list's first default page of the survey's task items. */
async function fixtureItems(app: FastifyInstance, query: SurveyTasksQuery) {
  return (await listSurveyTaskPage(app, { ...query, params: {} })).list;
}

/** Every `/v1` view of the survey's tasks. */
async function allViews(app: FastifyInstance, query: SurveyTasksQuery): Promise<ScheduledTaskViewItem[]> {
  return collect(await listSurveyTaskViewBatches(app, query));
}

const listers = [
  ['listSurveyTaskPage', fixtureItems],
  ['listSurveyTaskViewBatches', allViews],
] as const;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

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
      targetRoute: launch ? '/internal/v1/tasks/surveys/launch' : '/internal/v1/tasks/reminders',
      scheduleTime: '2026-06-30T10:00:00.000',
      status: 'scheduled',
      scheduleVersion: 1,
      queue: launch ? 'surveys-launch' : 'communications-reminders',
      ...over,
    };
  }

  /** The survey's own task names as seedSurvey records them, in the fixture's task order. */
  function namesOf(surveyId: string): string[] {
    return ['launch', 'reminder-2', 'reminder-1'].map((suffix) => `opt2-survey-${surveyId}-${suffix}`);
  }

  function listBody(surveyId: string, items: ScheduledTaskRecord[], next: string | null = null): unknown {
    return { sourceType: 'survey', sourceId: surveyId, scheduleVersion: items.length > 0 ? 1 : null, items, next };
  }

  /** Answers each scheduled-task call with the page its `after` names in `pages`, keyed '' for the first page. */
  function pagedAnswer(surveyId: string, pages: Record<string, [ScheduledTaskRecord[], string | null]>): (req: ServiceRequest) => Promise<ServiceResponse> {
    return (req) => {
      const [items, next] = pages[String(req.query?.after ?? '')] ?? [[], null];
      return answer(200, listBody(surveyId, items, next))();
    };
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

    const page = await listSurveyTaskPage(appOf(handle.app, client), { tenantId: tenantA, surveyId, params: {} });

    expect(calls).toEqual([
      {
        service: 'communications',
        method: 'GET',
        path: '/internal/v1/scheduled-tasks',
        query: { sourceType: 'survey', sourceId: surveyId, limit: '1000', taskName: namesOf(surveyId) },
      },
    ]);
    expect(page).toMatchObject({ pageIndex: 1, itemsPerPage: 50, totalItems: 3 });
    expect(page.list).toEqual([
      { taskname: `opt2-survey-${surveyId}-launch`, kind: 'launch', route: `${route}/launch`, offsetminutes: 0 },
      { taskname: `opt2-survey-${surveyId}-reminder-2`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 30 },
      { taskname: `opt2-survey-${surveyId}-reminder-1`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 1440 },
    ]);
  });

  it('lists no tasks, asking communications nothing, for a survey that was never scheduled', async () => {
    const surveyId = await seedSurvey(false);
    const { client, calls } = stubClient(answer(200, listBody(surveyId, [])));

    await expect(listSurveyTaskPage(appOf(handle.app, client), { tenantId: tenantA, surveyId, params: {} })).resolves.toEqual({
      list: [],
      pageIndex: 1,
      itemsPerPage: 50,
      totalItems: 0,
    });
    expect(calls).toEqual([]);
  });

  it('gives the /v1 views every record of communications\' current schedule version in communications\' order', async () => {
    const surveyId = await seedSurvey();
    const records = [record(surveyId, null), record(surveyId, 2, { status: 'cancelled' }), record(surveyId, 1, { status: 'failed' })];
    const { client, calls } = stubClient(answer(200, listBody(surveyId, records)));

    const views = await allViews(appOf(handle.app, client), { tenantId: tenantA, surveyId });

    expect(calls.map((call) => call.query)).toEqual([{ sourceType: 'survey', sourceId: surveyId, limit: '1000' }]);
    expect(views).toEqual([
      { taskName: records[0]?.taskName, kind: 'launch', scheduleTime: '2026-06-30T10:00:00.000', status: 'scheduled' },
      { taskName: records[1]?.taskName, kind: 'reminder', scheduleTime: '2026-06-30T10:00:00.000', status: 'cancelled' },
      { taskName: records[2]?.taskName, kind: 'reminder', scheduleTime: '2026-06-30T10:00:00.000', status: 'failed' },
    ]);
  });

  it('reads every page of communications, at most 1000 records a call, before listing the fixture items in fixture order', async () => {
    const surveyId = await seedSurvey();
    const pages: Record<string, [ScheduledTaskRecord[], string | null]> = {
      '': [[record(surveyId, 1)], 'P2'],
      P2: [[record(surveyId, 2), record(surveyId, null, { status: 'cancelled' })], 'P3'],
      P3: [[record(surveyId, null, { scheduleVersion: 1 })], null],
    };
    const { client, calls } = stubClient(pagedAnswer(surveyId, pages));

    const items = await fixtureItems(appOf(handle.app, client), { tenantId: tenantA, surveyId });

    expect(calls.map((call) => call.query)).toEqual(
      ['', 'P2', 'P3'].map((after) => ({
        sourceType: 'survey',
        sourceId: surveyId,
        limit: '1000',
        taskName: namesOf(surveyId),
        ...(after === '' ? {} : { after }),
      })),
    );
    expect(items.map((item) => [item.taskname, item.offsetminutes])).toEqual([
      [`opt2-survey-${surveyId}-launch`, 0],
      [`opt2-survey-${surveyId}-reminder-2`, 30],
      [`opt2-survey-${surveyId}-reminder-1`, 1440],
    ]);
  });

  /** A scheduled survey of tenant A whose reminders 1 to `offsets.length` are written as rows at `offsets`; returns its id. */
  function seedReminders(offsets: readonly number[]): Promise<string> {
    return withGatedTenant(handle.app, tenantA, async (tx) => {
      const survey = await repository.insertSurvey(tx, { siteId: siteA, title: 'Pulse', createdById: USER_ID });
      await repository.upsertSchedule(tx, survey.survey_id, { launchAt: new Date(T0.getTime() + 3_600_000), taskTokenHash: HASH });
      await tx.query(
        `INSERT INTO ${handle.schema}.survey_reminder (tenant_id, reminder_id, survey_id, offset_minutes, remind_at, task_name, task_token_hash)
         SELECT $1, lpad(n::text, 8, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF', $2, ($3::integer[])[n], $4, ($5::text[])[n], $6
         FROM generate_series(1, cardinality($3::integer[])) AS n`,
        [tenantA, survey.survey_id, offsets, T0, offsets.map((_, i) => `opt2-survey-${survey.survey_id}-reminder-${i + 1}`), HASH],
      );
      return survey.survey_id;
    });
  }

  it.each<[string, number[], number[]]>([
    ['after a full batch of earlier reminders', [100, 51], [...Array<number>(100).fill(-10), ...Array<number>(50).fill(20)]],
    ['pushing a reminder out of a full batch', [100, 21], [...Array<number>(99).fill(-1), ...Array<number>(21).fill(5)]],
    ['ahead of a full batch of later reminders', [100, 1], Array<number>(100).fill(30)],
    ['after exactly one full batch of earlier reminders', [100, 1], Array<number>(100).fill(-5)],
    ['among 250 reminders at equal offsets', [100, 100, 51], Array.from({ length: 250 }, (_, i) => (i % 3) * 10 - 10)],
  ])('places the launch %s, naming %j tasks a call, as the whole-list reference lists them', async (_case, batches, offsets) => {
    const surveyId = await seedReminders(offsets);
    const recorded = {
      surveyId,
      schedule: { task_name: `opt2-survey-${surveyId}-launch` },
      reminders: offsets.map((offset_minutes, i) => ({ task_name: `opt2-survey-${surveyId}-reminder-${i + 1}`, offset_minutes })),
    };
    const records = [
      record(surveyId, null, { status: 'done' }),
      ...offsets.flatMap((_, i) => (i % 9 === 8 ? [] : [record(surveyId, i + 1, { status: i % 4 === 3 ? 'cancelled' : 'scheduled' })])),
    ].reverse();
    const { client, calls } = stubClient((req) => {
      const names = [req.query?.taskName ?? []].flat();
      return answer(200, listBody(surveyId, records.filter((item) => names.includes(item.taskName))))();
    });

    for (const params of [{}, { itemsPerPage: '7', pageIndex: '4' }, { itemsPerPage: '1000' }]) {
      const before = calls.length;
      const page = await listSurveyTaskPage(appOf(handle.app, client), { tenantId: tenantA, surveyId, params });
      const expected = referenceFixtureTaskPage(records, recorded, params);

      expect(page.list).toEqual(expected.items);
      expect(page.totalItems).toBe(expected.totalitems);
      const named = calls.slice(before).map((call) => [call.query?.taskName ?? []].flat());
      expect(named.map((names) => names.length)).toEqual(batches);
      expect(named.every((names) => names.length <= TASK_NAME_BATCH)).toBe(true);
      expect(named.flat().sort()).toEqual([recorded.schedule.task_name, ...recorded.reminders.map((reminder) => reminder.task_name)].sort());
    }
  });

  it('gives the /v1 views of every page of communications in its order, fetching a page only when its batch is wanted', async () => {
    const surveyId = await seedSurvey();
    const pages: Record<string, [ScheduledTaskRecord[], string | null]> = {
      '': [[record(surveyId, null), record(surveyId, 1)], 'P2'],
      P2: [[record(surveyId, 2)], null],
    };
    const { client, calls } = stubClient(pagedAnswer(surveyId, pages));

    const batches = await listSurveyTaskViewBatches(appOf(handle.app, client), { tenantId: tenantA, surveyId });
    expect(calls.map((call) => call.query?.after)).toEqual([undefined]);
    const views = await collect(batches);

    expect(calls.map((call) => call.query?.after)).toEqual([undefined, 'P2']);
    expect(views.map((view) => view.taskName)).toEqual([null, 1, 2].map((n) => record(surveyId, n).taskName));
  });

  it.each([
    ['a limit', { limit: 2 }, { limit: '2' }],
    ['an after cursor', { after: 'CURSOR' }, { after: 'CURSOR' }],
    ['a limit and an after cursor', { limit: 5, after: 'CURSOR' }, { limit: '5', after: 'CURSOR' }],
  ])('forwards %s to communications and answers its one page with its next cursor', async (_case, page, sent) => {
    const surveyId = await seedSurvey();
    const { client, calls } = stubClient(answer(200, listBody(surveyId, [record(surveyId, 1)], 'NEXT')));

    const views = await listSurveyTaskViews(appOf(handle.app, client), { tenantId: tenantA, surveyId }, page);

    expect(calls.map((call) => call.query)).toEqual([{ sourceType: 'survey', sourceId: surveyId, ...sent }]);
    expect(views).toEqual({
      items: [{ taskName: record(surveyId, 1).taskName, kind: 'reminder', scheduleTime: '2026-06-30T10:00:00.000', status: 'scheduled' }],
      next: 'NEXT',
    });
  });

  it.each([
    ['answers invalidParameters for an after cursor', { after: 'CURSOR' }, LegacyApiError],
    ['answers the legacy 503 for a page without one', { limit: 2 }, LegacyServiceUnavailableError],
  ])('when communications refuses a page with HTTP 400, %s', async (_case, page, rejection) => {
    const surveyId = await seedSurvey();
    const { client } = stubClient(answer(400, { error: 'x' }));

    const error = await listSurveyTaskViews(appOf(handle.app, client), { tenantId: tenantA, surveyId }, page).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(rejection);
    if (rejection === LegacyApiError) expect(error).toMatchObject({ type: 'invalidParameters' });
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
