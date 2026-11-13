// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Scheduler hand-off routes through the composed app over the in-memory database and task port: adoption, cancellation, rejection. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateTaskInput } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, assertRequestMatchesOpenApi, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { parseLocalTimestamp, portTaskName } from '../../src/domain/survey-tasks.js';
import { RECOVERY_BATCH_SIZE } from '../../src/repo/queries.js';
import { ADOPT_PATH, CANCEL_ADOPTED_PATH } from '../../src/routes/adoption.js';
import { buildTestApp, createRecordingDb, headersFor, type Row, type TestApp } from '../helpers/app.js';

// Passes through, so a single call can be made to fail with an error that is not a RangeError.
vi.mock(import('../../src/domain/survey-tasks.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, parseLocalTimestamp: vi.fn(actual.parseLocalTimestamp) };
});

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const DOC = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const MIGRATION = 'service:migration';
const SURVEYS = 'service:surveys';
const LAUNCH_QUEUE = 'surveys-launch';
const REMINDER_QUEUE = 'communications-reminders';
const SURVEY_QUEUES: ReadonlySet<string> = new Set([LAUNCH_QUEUE, REMINDER_QUEUE]);
const SURVEY_A = 'AAAAAAAA-0000-0000-0000000000000001';
const SURVEY_B = 'BBBBBBBB-0000-0000-0000000000000002';
const SURVEY_EVENT = 'EEEEEEEE-0000-0000-0000000000000003';
const EVENT_ROW_ID = 'EEEEEEEE-1111-1111-1111111111111111';
const LAUNCH_A = `opt2-survey-${SURVEY_A}-launch`;
const REMINDER_A1 = `opt2-survey-${SURVEY_A}-reminder-1`;
const REMINDER_A2 = `opt2-survey-${SURVEY_A}-reminder-2`;
const LAUNCH_B = `opt2-survey-${SURVEY_B}-launch`;
const LAUNCH_EVENT = `opt2-survey-${SURVEY_EVENT}-launch`;
const EVENT_PORT_NAME = portTaskName(LAUNCH_EVENT, 1);
const SCHEDULED_TASK_INSERT = /^INSERT INTO "communications"\."scheduled_task" /;
// The business clock reads local 2026-06-30T12:00:00, so the first launch has passed and the others have not.
const FUTURE = '2026-07-01T09:00:00.000';

/** One captured fixture ACF task, as `AdoptScheduledTasksRequest` lists it. */
function task(name: string, siteId: string, scheduleTime: string, scheduleVersion = 1) {
  return { name, siteId, scheduleTime, scheduleVersion };
}

const ADOPT_BODY = {
  tasks: [
    task(LAUNCH_A, TENANT_A.siteId, '2026-06-30T09:00:00.000'),
    task(REMINDER_A1, TENANT_A.siteId, FUTURE),
    task(REMINDER_A2, TENANT_A.siteId, '2026-07-02T09:00:00.000'),
    task(LAUNCH_B, TENANT_B.siteId, '2026-07-03T09:00:00.000', 2),
  ],
};

/** The tenant-a launch row a `surveys.survey.scheduled.v1` delivery stores; `enqueuedAt` null when its queue task was never created. */
function eventRow(enqueuedAt: Date | null): Row {
  const created = new Date(2026, 5, 29, 9, 0, 0, 0);
  return {
    tenant_id: TENANT_A.tenantId,
    scheduled_task_id: EVENT_ROW_ID,
    task_name: LAUNCH_EVENT,
    queue: LAUNCH_QUEUE,
    queue_task_name: EVENT_PORT_NAME,
    kind: 'survey-launch',
    source_type: 'survey',
    source_id: SURVEY_EVENT,
    reminder_n: null,
    schedule_time: new Date(2026, 6, 4, 9, 0, 0, 0),
    status: 'scheduled',
    target_route: `/internal/v1/tasks/surveys/${SURVEY_EVENT}/launch`,
    schedule_version: 1,
    origin: 'event',
    enqueued_at: enqueuedAt,
    created_at: created,
    updated_at: created,
  };
}

/** Survey tasks the port created, leaving out the outbox sweep the app schedules at start-up. */
function surveyTasks(t: TestApp): CreateTaskInput[] {
  return t.taskPort.tasks.filter((created) => SURVEY_QUEUES.has(created.queue));
}

/** Live survey tasks of the port. */
function liveSurveyTasks(t: TestApp): CreateTaskInput[] {
  return t.taskPort.live().filter((created) => SURVEY_QUEUES.has(created.queue));
}

/** Scheduled-task rows as `[task_name, origin, status]`, by task name. */
function taskStates(t: TestApp): unknown[][] {
  return t.db
    .rows('scheduled_task')
    .map((row) => [row.task_name, row.origin, row.status])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

/** The stored row of `taskName`. */
function rowNamed(t: TestApp, taskName: string): Row | undefined {
  return t.db.rows('scheduled_task').find((row) => row.task_name === taskName);
}

describe('scheduler hand-off routes', () => {
  let built: TestApp | undefined;

  /** Builds the app over a database holding `seed` scheduled-task rows. */
  async function build(seed: readonly Row[] = []): Promise<TestApp> {
    built = await buildTestApp({ db: createRecordingDb({ scheduled_task: seed }) });
    return built;
  }

  /** Posts `body` as the `as` subject and checks the answer against the contract. */
  async function post(t: TestApp, url: string, body: Record<string, unknown>, as = MIGRATION) {
    const res = await t.app.inject({ method: 'POST', url, headers: await headersFor(as), payload: body });
    const contentType = res.headers['content-type'];
    assertResponseMatchesOpenApi(DOC, { method: 'POST', path: url, status: res.statusCode, contentType, body: res.body });
    return res;
  }

  afterEach(async () => {
    await built?.app.close();
    built = undefined;
  });

  describe('adopt', () => {
    it('adopts each task once in the tenant of its site', async () => {
      const t = await build();
      const request = { method: 'POST', path: ADOPT_PATH, contentType: 'application/json', body: ADOPT_BODY };
      expect(() => assertRequestMatchesOpenApi(DOC, request)).not.toThrow();

      const res = await post(t, ADOPT_PATH, ADOPT_BODY);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ adopted: 4, existing: 0, scheduledImmediately: 1 });
      const rows = t.db.rows('scheduled_task');
      expect(rows.map((row) => [row.task_name, row.tenant_id, row.origin, row.status, row.queue, row.queue_task_name])).toEqual(
        ADOPT_BODY.tasks.map(({ name, siteId, scheduleVersion }) => [
          name,
          tenantIdForSite(siteId),
          'adopted',
          'scheduled',
          name.endsWith('-launch') ? LAUNCH_QUEUE : REMINDER_QUEUE,
          portTaskName(name, scheduleVersion),
        ]),
      );
      const inserts = t.db.transactions
        .filter((tx) => tx.outcome === 'commit')
        .map((tx) => [tx.tenantId, tx.statements.filter(({ text }) => SCHEDULED_TASK_INSERT.test(text)).length])
        .filter(([, count]) => count !== 0);
      expect(inserts).toEqual([
        [TENANT_A.tenantId, 3],
        [TENANT_B.tenantId, 1],
      ]);
    });

    it('queues each adopted task on its queue under its tenant, a passed run time at now', async () => {
      const t = await build();

      await post(t, ADOPT_PATH, ADOPT_BODY);

      const now = t.clock.now().getTime();
      const queued = surveyTasks(t).map(({ queue, name, tenantId, scheduleTime }) => [queue, name, tenantId, scheduleTime.getTime()]);
      expect(queued).toEqual([
        [LAUNCH_QUEUE, portTaskName(LAUNCH_A, 1), TENANT_A.tenantId, now],
        [REMINDER_QUEUE, portTaskName(REMINDER_A1, 1), TENANT_A.tenantId, new Date(2026, 6, 1, 9, 0, 0, 0).getTime()],
        [REMINDER_QUEUE, portTaskName(REMINDER_A2, 1), TENANT_A.tenantId, new Date(2026, 6, 2, 9, 0, 0, 0).getTime()],
        [LAUNCH_QUEUE, portTaskName(LAUNCH_B, 2), TENANT_B.tenantId, new Date(2026, 6, 3, 9, 0, 0, 0).getTime()],
      ]);
      expect((rowNamed(t, LAUNCH_A)?.schedule_time as Date).getTime()).toBe(now);
      expect(t.db.rows('scheduled_task').every((row) => row.enqueued_at instanceof Date)).toBe(true);
    });

    it('answers a repeated adoption as already adopted without a new row or queue task', async () => {
      const t = await build();
      await post(t, ADOPT_PATH, ADOPT_BODY);
      const rows = t.db.rows('scheduled_task');

      const res = await post(t, ADOPT_PATH, ADOPT_BODY);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ adopted: 0, existing: 4, scheduledImmediately: 0 });
      expect(t.db.rows('scheduled_task')).toEqual(rows);
      expect(surveyTasks(t)).toHaveLength(4);
    });

    it('queues an event row holding the task name without a queue task, adopting nothing', async () => {
      const t = await build([eventRow(null)]);

      const res = await post(t, ADOPT_PATH, { tasks: [task(LAUNCH_EVENT, TENANT_A.siteId, FUTURE)] });

      expect(res.json()).toEqual({ adopted: 0, existing: 1, scheduledImmediately: 0 });
      expect(taskStates(t)).toEqual([[LAUNCH_EVENT, 'event', 'scheduled']]);
      expect(rowNamed(t, LAUNCH_EVENT)?.enqueued_at).toBeInstanceOf(Date);
      expect(surveyTasks(t).map(({ queue, name, tenantId }) => [queue, name, tenantId])).toEqual([
        [LAUNCH_QUEUE, EVENT_PORT_NAME, TENANT_A.tenantId],
      ]);
    });
  });

  describe('cancel', () => {
    it('cancels the named adopted tasks, then every one, leaving the event-scheduled task alone', async () => {
      const t = await build([eventRow(new Date(2026, 5, 29, 9, 0, 0, 0))]);
      await t.taskPort.create({
        queue: LAUNCH_QUEUE,
        name: EVENT_PORT_NAME,
        scheduleTime: new Date(2026, 6, 4, 9, 0, 0, 0),
        url: `http://127.0.0.1:8117/internal/v1/tasks/surveys/${SURVEY_EVENT}/launch`,
        body: { surveyId: SURVEY_EVENT, siteId: TENANT_A.siteId, scheduleVersion: 1 },
        deadlineS: 60,
        tenantId: TENANT_A.tenantId,
      });
      await post(t, ADOPT_PATH, ADOPT_BODY);
      // Gone from the queue already, so its delete finds nothing; the cancellation still completes.
      await t.taskPort.delete(LAUNCH_QUEUE, portTaskName(LAUNCH_B, 2));

      const named = await post(t, CANCEL_ADOPTED_PATH, { names: [LAUNCH_B, LAUNCH_EVENT] });

      expect(named.statusCode).toBe(200);
      expect(named.json()).toEqual({ cancelled: 1 });
      expect(rowNamed(t, LAUNCH_B)).toMatchObject({ status: 'cancelled', dequeued_at: expect.any(Date) });

      const all = await post(t, CANCEL_ADOPTED_PATH, {});

      expect(all.json()).toEqual({ cancelled: 3 });
      expect(taskStates(t)).toEqual([
        [LAUNCH_A, 'adopted', 'cancelled'],
        [REMINDER_A1, 'adopted', 'cancelled'],
        [REMINDER_A2, 'adopted', 'cancelled'],
        [LAUNCH_B, 'adopted', 'cancelled'],
        [LAUNCH_EVENT, 'event', 'scheduled'],
      ]);
      expect(t.taskPort.deleted.map(({ name }) => name).sort()).toEqual(
        ADOPT_BODY.tasks.map(({ name, scheduleVersion }) => portTaskName(name, scheduleVersion)).sort(),
      );
      expect(liveSurveyTasks(t).map(({ name }) => name)).toEqual([EVENT_PORT_NAME]);
    });

    it('answers a repeated cancellation as a no-op', async () => {
      const t = await build();
      await post(t, ADOPT_PATH, ADOPT_BODY);
      await post(t, CANCEL_ADOPTED_PATH, {});
      const rows = t.db.rows('scheduled_task');

      const res = await post(t, CANCEL_ADOPTED_PATH, {});

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cancelled: 0 });
      expect(t.db.rows('scheduled_task')).toEqual(rows);
      expect(t.taskPort.deleted).toHaveLength(4);
    });

    it('cancels adopted tasks beyond one batch', async () => {
      const t = await build();
      const reminders = Array.from({ length: RECOVERY_BATCH_SIZE + 1 }, (_, i) =>
        task(`opt2-survey-${SURVEY_A}-reminder-${String(i + 1)}`, TENANT_A.siteId, FUTURE),
      );
      await post(t, ADOPT_PATH, { tasks: reminders });

      const res = await post(t, CANCEL_ADOPTED_PATH, {});

      expect(res.json()).toEqual({ cancelled: RECOVERY_BATCH_SIZE + 1 });
      expect(liveSurveyTasks(t)).toEqual([]);
    });
  });

  describe('rejection', () => {
    /** An adoption body whose valid first task precedes `invalid`, so a rejection shows nothing was written for either. */
    const afterValid = (invalid: Record<string, unknown>) => ({ tasks: [ADOPT_BODY.tasks[0], invalid] });

    it.each([
      ['a task without siteId', ADOPT_PATH, afterValid({ name: LAUNCH_B, scheduleTime: FUTURE, scheduleVersion: 1 })],
      ['a malformed task name', ADOPT_PATH, afterValid(task('opt2-survey-x-launch', TENANT_B.siteId, FUTURE))],
      [
        'a reminder ordinal beyond a safe integer',
        ADOPT_PATH,
        afterValid(task(`opt2-survey-${SURVEY_B}-reminder-${'9'.repeat(20)}`, TENANT_B.siteId, FUTURE)),
      ],
      ['an empty siteId', ADOPT_PATH, afterValid(task(LAUNCH_B, '', FUTURE))],
      ['a run time that does not exist', ADOPT_PATH, afterValid(task(LAUNCH_B, TENANT_B.siteId, '2026-02-30T09:00:00.000'))],
      ['a malformed name to cancel', CANCEL_ADOPTED_PATH, { names: ['opt2-survey-x-launch'] }],
    ])('answers %s with the legacy 400 invalidParameters and no write', async (_label, url, body) => {
      const t = await build();

      const res = await post(t, url, body);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
      expect(t.db.rows('scheduled_task')).toEqual([]);
      expect(surveyTasks(t)).toEqual([]);
      expect(t.taskPort.deleted).toEqual([]);
    });

    it('answers an unexpected run-time failure as a server error, not invalidParameters', async () => {
      const t = await build();
      vi.mocked(parseLocalTimestamp).mockImplementationOnce(() => {
        throw new TypeError('time zone data unavailable');
      });

      const res = await post(t, ADOPT_PATH, ADOPT_BODY);

      expect(res.statusCode).toBe(500);
      expect(t.db.rows('scheduled_task')).toEqual([]);
      expect(surveyTasks(t)).toEqual([]);
    });

    it('refuses a caller with only service:surveys on both routes, writing nothing', async () => {
      const t = await build();
      await post(t, ADOPT_PATH, ADOPT_BODY);
      const rows = t.db.rows('scheduled_task');

      const adopt = await post(t, ADOPT_PATH, { tasks: [task(LAUNCH_EVENT, TENANT_A.siteId, FUTURE)] }, SURVEYS);
      const cancel = await post(t, CANCEL_ADOPTED_PATH, {}, SURVEYS);

      expect([adopt.statusCode, cancel.statusCode]).toEqual([403, 403]);
      expect(t.db.rows('scheduled_task')).toEqual(rows);
      expect(surveyTasks(t)).toHaveLength(4);
      expect(t.taskPort.deleted).toEqual([]);
    });
  });
});
