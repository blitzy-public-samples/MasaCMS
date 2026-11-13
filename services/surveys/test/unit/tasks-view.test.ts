// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture and `/v1` task views over communications scheduled-task records, and the fixture task list route that serves them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { FIXTURE_ERROR_MAP, fixtureMethod } from '../../src/legacy/fixture-envelope.js';
import {
  FIXTURE_TASK_STATUS,
  toFixtureTask,
  toFixtureTaskList,
  toScheduledTaskView,
  type FixtureTaskItem,
  type FixtureTaskListOptions,
  type ScheduledTaskRecord,
} from '../../src/legacy/tasks-view.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, defaultScheduledTasks, headersFor, type TestApp } from '../helpers/app.js';

const SURVEY_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const OTHER_SURVEY_ID = 'AAAAAAAA-BBBB-CCCC-DDDDDDDDDDDDDDDD';
const ROUTE_BASE = `/legacy-fixtures/cfml/api.cfm/surveys/surveys/${SURVEY_ID}`;
const name = (suffix: string): string => `opt2-survey-${SURVEY_ID}-${suffix}`;

/** A communications record of the survey's launch task, or of its n-th reminder when `n` is given. */
function record(n: number | null, over: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  const launch = n === null;
  return {
    taskName: launch ? name('launch') : name(`reminder-${n}`),
    kind: launch ? 'survey-launch' : 'survey-reminder',
    n,
    targetRoute: launch ? `/internal/v1/tasks/surveys/${SURVEY_ID}/launch` : `/internal/v1/tasks/reminders/${OTHER_SURVEY_ID}`,
    scheduleTime: '2026-06-30T09:15:00.000',
    status: 'scheduled',
    scheduleVersion: 2,
    queue: launch ? 'surveys-launch' : 'communications-reminders',
    ...over,
  };
}

/** The survey's own schedule rows: launch plus reminders 1 and 2 at 30 and 1440 minutes. */
const recorded: FixtureTaskListOptions = {
  surveyId: SURVEY_ID,
  schedule: { task_name: name('launch') },
  reminders: [
    { task_name: name('reminder-1'), offset_minutes: 30 },
    { task_name: name('reminder-2'), offset_minutes: 1440 },
  ],
};

describe('toFixtureTaskList', () => {
  it('lists launch and reminders with fixture names, routes and recorded offsets, by offset', () => {
    const records = [
      record(2, { scheduleTime: '2026-07-01T09:15:00.000' }),
      record(null),
      record(1, { scheduleTime: '2026-06-30T09:45:00.000' }),
    ];

    const items = toFixtureTaskList(records, recorded);

    expect(items).toEqual([
      { taskname: name('launch'), kind: 'launch', route: `${ROUTE_BASE}/launch`, offsetminutes: 0 },
      { taskname: name('reminder-1'), kind: 'reminder', route: `${ROUTE_BASE}/remind`, offsetminutes: 30 },
      { taskname: name('reminder-2'), kind: 'reminder', route: `${ROUTE_BASE}/remind`, offsetminutes: 1440 },
    ]);
    for (const item of items) expect(Object.keys(item)).toEqual(['taskname', 'kind', 'route', 'offsetminutes']);
  });

  it('takes offsets from the recorded rows even when communications moved a past schedule time to now', () => {
    const now = '2026-11-11T13:00:00.000';
    const items = toFixtureTaskList([record(null, { scheduleTime: now }), record(2, { scheduleTime: now })], recorded);

    expect(items.map((item) => item.offsetminutes)).toEqual([0, 1440]);
  });

  it.each([
    ['scheduled', 'listed'],
    ['done', 'listed'],
    ['failed', 'listed'],
    ['cancelled', 'deleted'],
    ['superseded', 'deleted'],
  ] as const)('treats a %s task as %s in ACF', (status, state) => {
    expect(FIXTURE_TASK_STATUS[status]).toBe(state);
    expect(toFixtureTaskList([record(null, { status })], recorded)).toHaveLength(state === 'listed' ? 1 : 0);
  });

  it('omits tasks the survey did not record, other surveys and non-fixture task names', () => {
    const records = [
      record(3),
      record(null, { taskName: `opt2-survey-${OTHER_SURVEY_ID}-launch` }),
      record(1, { taskName: `projects/p/locations/l/queues/communications-reminders/tasks/${name('reminder-1')}` }),
    ];

    expect(toFixtureTaskList(records, recorded)).toEqual([]);
    expect(toFixtureTaskList([record(null)], { ...recorded, schedule: null })).toEqual([]);
  });

  it('orders equal offsets by case-sensitive task name', () => {
    const reminders = Array.from({ length: 10 }, (_, i) => ({ task_name: name(`reminder-${i + 1}`), offset_minutes: 0 }));

    const items = toFixtureTaskList([record(2), record(10), record(null)], { ...recorded, reminders });

    expect(items.map((item) => item.taskname)).toEqual([name('launch'), name('reminder-10'), name('reminder-2')]);
  });

  it('rejects a reminder record without an ordinal', () => {
    expect(() => toFixtureTaskList([record(1, { n: null })], recorded)).toThrow(RangeError);
  });
});

describe('toFixtureTask', () => {
  it('encodes the survey id in the route as encodeForURL does', () => {
    expect(toFixtureTask(record(null), { surveyId: 'a b/c', offsetMinutes: 0 }).route).toBe(
      '/legacy-fixtures/cfml/api.cfm/surveys/surveys/a+b%2Fc/launch',
    );
  });
});

describe('toScheduledTaskView', () => {
  it('maps kind and keeps name, local schedule time and status unchanged', () => {
    expect(toScheduledTaskView(record(1, { status: 'superseded' }))).toEqual({
      taskName: name('reminder-1'),
      kind: 'reminder',
      scheduleTime: '2026-06-30T09:15:00.000',
      status: 'superseded',
    });
    expect(toScheduledTaskView(record(null)).kind).toBe('launch');
  });
});

describe('fixture GET surveys/{id}/tasks', () => {
  const SITE_A = `?siteid=${TENANT_A.siteId}`;
  const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
  const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
  const SCHEDULED_TASKS = { service: 'communications', method: 'GET', path: '/internal/v1/scheduled-tasks' } as const;
  const LEGACY_503: unknown = JSON.parse(apiUnavailableResponse().body);

  let t: TestApp;
  let surveyId: string;

  /** Injects `url` as the surveys manager of `site`; a body makes it a JSON write carrying CSRF tokens. */
  async function asManager(method: 'GET' | 'POST', url: string, body?: unknown, site: string = TENANT_A.siteId) {
    const auth = await headersFor(Roles.surveysManager, { site });
    return t.app.inject({
      method,
      url,
      headers: body === undefined ? auth : { ...auth, ...CSRF_HEADERS, 'content-type': 'application/json' },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Answers communications' scheduled-tasks list with `items` and `status`. */
  function communicationsAnswers(items: ScheduledTaskRecord[], status = 200): void {
    t.client.respond(SCHEDULED_TASKS.service, SCHEDULED_TASKS.method, SCHEDULED_TASKS.path, {
      status,
      headers: {},
      body: { sourceType: 'survey', sourceId: surveyId, scheduleVersion: 1, items },
    });
  }

  /** The fixture items of the survey's launch at offset 0, reminder 2 at 30 and reminder 1 at 1440 minutes. */
  function expectedItems(id: string): FixtureTaskItem[] {
    const route = `${FIXTURE_BASE}/${id}`;
    return [
      { taskname: `opt2-survey-${id}-launch`, kind: 'launch', route: `${route}/launch`, offsetminutes: 0 },
      { taskname: `opt2-survey-${id}-reminder-2`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 30 },
      { taskname: `opt2-survey-${id}-reminder-1`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 1440 },
    ];
  }

  beforeAll(async () => {
    t = await buildTestApp();
    const created = await asManager('POST', `${FIXTURE_BASE}${SITE_A}`, { title: 'Pulse' });
    expect(created.statusCode).toBe(200);
    surveyId = (created.json() as { data: { survey_id: string } }).data.survey_id;
    const scheduled = await asManager('POST', `${FIXTURE_BASE}/${surveyId}/schedule${SITE_A}`, {
      launchAt: '2026-07-01T09:00:00',
      reminders: [{ offsetMinutes: 1440 }, { offsetMinutes: 30 }],
    });
    expect(scheduled.statusCode).toBe(200);
  });

  afterAll(async () => {
    await t?.app.close();
  });

  beforeEach(() => {
    t.client.reset();
  });

  it('lists communications\' records as the fixture items in a paged fixture list after one scheduled-tasks call', async () => {
    const current = defaultScheduledTasks(surveyId);
    const records = [...current.toReversed(), ...current.map((task) => ({ ...task, status: 'superseded' as const }))];
    communicationsAnswers(records);
    const before = t.client.requests.length;

    const res = await asManager('GET', `${FIXTURE_BASE}/${surveyId}/tasks${SITE_A}`);

    expect(res.statusCode).toBe(200);
    expect(t.client.requests.slice(before)).toEqual([{ ...SCHEDULED_TASKS, query: { sourceType: 'survey', sourceId: surveyId } }]);
    const body = res.json() as { data: { items: FixtureTaskItem[] } };
    expect(body).toEqual({
      apiversion: 'v1',
      method: fixtureMethod('surveys', 'tasks'),
      data: { items: expectedItems(surveyId), startindex: 1, endindex: 3, itemsperpage: 50, totalitems: 3, totalpages: 1, pageindex: 1 },
    });
    for (const item of body.data.items) expect(Object.keys(item)).toEqual(['taskname', 'kind', 'route', 'offsetminutes']);
  });

  it('matches the survey id ignoring case and asks communications with the stored id', async () => {
    const before = t.client.requests.length;

    const res = await asManager('GET', `${FIXTURE_BASE}/${surveyId.toLowerCase()}/tasks${SITE_A}`);

    expect(res.statusCode).toBe(200);
    expect(t.client.requests.slice(before)).toEqual([{ ...SCHEDULED_TASKS, query: { sourceType: 'survey', sourceId: surveyId } }]);
    expect((res.json() as { data: { items: FixtureTaskItem[] } }).data.items).toEqual(expectedItems(surveyId));
  });

  it.each([400, 404, 500, 503])('answers the legacy 503 when communications answers HTTP %i', async (status) => {
    communicationsAnswers([], status);

    const res = await asManager('GET', `${FIXTURE_BASE}/${surveyId}/tasks${SITE_A}`);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(LEGACY_503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });

  it('answers the legacy 503 when communications is unreachable', async () => {
    t.client.unavailable();

    const res = await asManager('GET', `${FIXTURE_BASE}/${surveyId}/tasks${SITE_A}`);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(LEGACY_503);
  });

  it.each([
    ['an unknown survey id', TENANT_A.siteId, () => UNKNOWN_ID],
    ['another tenant\'s survey', TENANT_B.siteId, () => surveyId],
  ])('answers the fixture notFound for %s without calling communications', async (_case, site, id) => {
    const before = t.client.requests.length;

    const res = await asManager('GET', `${FIXTURE_BASE}/${id()}/tasks?siteid=${site}`, undefined, site);

    expect(res.statusCode).toBe(FIXTURE_ERROR_MAP.notFound.status);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: fixtureMethod('surveys', 'tasks'),
      error: { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message },
    });
    expect(t.client.requests.slice(before)).toEqual([]);
  });
});
