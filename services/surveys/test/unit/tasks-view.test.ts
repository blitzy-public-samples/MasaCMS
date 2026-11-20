// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture and `/v1` task views over communications scheduled-task records, and the fixture task list route that serves them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { FIXTURE_ERROR_MAP, fixtureMethod } from '../../src/legacy/fixture-envelope.js';
import {
  FIXTURE_TASK_STATUS,
  compareFixtureTaskKeys,
  compareFixtureTasks,
  toFixtureTask,
  toFixtureTasks,
  toScheduledTaskView,
  type FixtureTaskItem,
  type FixtureTaskListOptions,
  type ScheduledTaskRecord,
} from '../../src/legacy/tasks-view.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, createClientRecorder, defaultScheduledTasks, headersFor, type TestApp } from '../helpers/app.js';
import { referenceFixtureTaskList, referenceFixtureTaskPage, type RecordedSchedule } from '../helpers/fixture-tasks.js';

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
    targetRoute: launch ? '/internal/v1/tasks/surveys/launch' : '/internal/v1/tasks/reminders',
    scheduleTime: '2026-06-30T09:15:00.000',
    status: 'scheduled',
    scheduleVersion: 2,
    queue: launch ? 'surveys-launch' : 'communications-reminders',
    ...over,
  };
}

/** The survey's own schedule rows: launch plus reminders 1 and 2 at 30 and 1440 minutes. */
const recordedRows: RecordedSchedule = {
  surveyId: SURVEY_ID,
  schedule: { task_name: name('launch') },
  reminders: [
    { task_name: name('reminder-1'), offset_minutes: 30 },
    { task_name: name('reminder-2'), offset_minutes: 1440 },
  ],
};

/** The offsets of `rows` as the listing passes them: the launch at 0, each reminder at its own offset. */
function optionsOf(rows: RecordedSchedule): FixtureTaskListOptions {
  const offsets = new Map<string, number>(rows.schedule === null ? [] : [[rows.schedule.task_name, 0]]);
  for (const reminder of rows.reminders) offsets.set(reminder.task_name, reminder.offset_minutes);
  return { surveyId: rows.surveyId, offsets };
}

const recorded = optionsOf(recordedRows);

/** The listed records' fixture items in the fixture's task order. */
function toFixtureTaskList(records: readonly ScheduledTaskRecord[], opts: FixtureTaskListOptions): FixtureTaskItem[] {
  return toFixtureTasks(records, opts).sort(compareFixtureTasks);
}

describe('toFixtureTasks in the fixture task order', () => {
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
    ['expired', 'listed'],
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
    expect(toFixtureTaskList([record(null)], optionsOf({ ...recordedRows, schedule: null }))).toEqual([]);
  });

  it('orders equal offsets by case-sensitive task name', () => {
    const reminders = Array.from({ length: 10 }, (_, i) => ({ task_name: name(`reminder-${i + 1}`), offset_minutes: 0 }));

    const items = toFixtureTaskList([record(2), record(10), record(null)], optionsOf({ ...recordedRows, reminders }));

    expect(items.map((item) => item.taskname)).toEqual([name('launch'), name('reminder-10'), name('reminder-2')]);
  });

  it.each<[string, [number, string], [number, string], number]>([
    ['a lower offset first', [0, name('reminder-9')], [30, name('launch')], -1],
    ['a higher offset last', [1440, name('launch')], [30, name('reminder-1')], 1],
    ['an equal offset by name code unit', [0, name('reminder-10')], [0, name('reminder-2')], -1],
    ['upper case before lower case', [0, name('Reminder-1')], [0, name('reminder-1')], -1],
    ['one key equal to itself', [5, name('launch')], [5, name('launch')], 0],
  ])('orders task keys with %s, as the items they key', (_case, a, b, sign) => {
    const item = ([offsetminutes, taskname]: [number, string]): FixtureTaskItem => ({ taskname, kind: 'reminder', route: '', offsetminutes });

    expect(Math.sign(compareFixtureTaskKeys(a, b))).toBe(sign);
    expect(Math.sign(compareFixtureTasks(item(a), item(b)))).toBe(sign);
  });

  it.each<[string, ScheduledTaskRecord[]]>([
    ['records out of order', [record(2), record(null), record(1)]],
    ['deleted and listed records of one name', [record(1, { status: 'cancelled' }), record(1, { status: 'done' }), record(null, { status: 'superseded' })]],
    ['records of names the survey did not record', [record(3), record(null, { taskName: `opt2-survey-${OTHER_SURVEY_ID}-launch` }), record(2)]],
    ['two listed records of one name', [record(2, { status: 'done' }), record(1), record(2, { scheduleTime: '2026-07-02T09:15:00.000' })]],
  ])('lists %s as the whole-list reference does', (_case, records) => {
    expect(toFixtureTaskList(records, recorded)).toEqual(referenceFixtureTaskList(records, recordedRows));
  });

  it('rejects a reminder record without an ordinal', () => {
    expect(() => toFixtureTaskList([record(1, { n: null })], recorded)).toThrow(RangeError);
  });

  it.each([1, 2, 3, 4])('lists records read in pages split after record %i as it lists them read at once', (split) => {
    const records = [record(2), record(null, { status: 'cancelled' }), record(1), record(null), record(3)];

    const items = [records.slice(0, split), records.slice(split)].flatMap((page) => toFixtureTasks(page, recorded));

    expect(items.sort(compareFixtureTasks)).toEqual(toFixtureTaskList(records, recorded));
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

  /** The scheduled-tasks query of the survey's own task names, in the fixture's task order. */
  function namedQuery(id: string): Record<string, unknown> {
    const taskName = ['launch', 'reminder-2', 'reminder-1'].map((suffix) => `opt2-survey-${id}-${suffix}`);
    return { sourceType: 'survey', sourceId: id, limit: '1000', taskName };
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
    expect(t.client.requests.slice(before)).toEqual([{ ...SCHEDULED_TASKS, query: namedQuery(surveyId) }]);
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
    expect(t.client.requests.slice(before)).toEqual([{ ...SCHEDULED_TASKS, query: namedQuery(surveyId) }]);
    expect((res.json() as { data: { items: FixtureTaskItem[] } }).data.items).toEqual(expectedItems(surveyId));
  });

  it("reads every page of communications' records before ordering and paging the fixture list", async () => {
    const [launch, reminder1, reminder2] = defaultScheduledTasks(surveyId);
    const pages: Record<string, { items: (ScheduledTaskRecord | undefined)[]; next: string | null }> = {
      '': { items: [reminder1], next: 'P2' },
      P2: { items: [reminder2, launch], next: null },
    };
    t.client.respond(SCHEDULED_TASKS.service, SCHEDULED_TASKS.method, SCHEDULED_TASKS.path, (req) => ({
      status: 200,
      headers: {},
      body: { sourceType: 'survey', sourceId: surveyId, scheduleVersion: 1, ...pages[String(req.query?.after ?? '')] },
    }));
    const before = t.client.requests.length;

    const res = await asManager('GET', `${FIXTURE_BASE}/${surveyId}/tasks${SITE_A}&itemsPerPage=2&pageIndex=2`);

    expect(res.statusCode).toBe(200);
    expect(t.client.requests.slice(before).map((req) => req.query)).toEqual([namedQuery(surveyId), { ...namedQuery(surveyId), after: 'P2' }]);
    expect((res.json() as { data: unknown }).data).toEqual({
      items: expectedItems(surveyId).slice(2),
      startindex: 3,
      endindex: 3,
      itemsperpage: 2,
      totalitems: 3,
      totalpages: 2,
      pageindex: 2,
    });
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

describe('fixture GET surveys/{id}/tasks against the whole-list reference', () => {
  const SITE_A = `?siteid=${TENANT_A.siteId}`;
  const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
  const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
  const SCHEDULED_TASKS_PATH = '/internal/v1/scheduled-tasks';
  /** Communications' records of each survey, which the recorder filters by `taskName` and pages as communications does. */
  const recordsBySurvey = new Map<string, ScheduledTaskRecord[]>();
  const client = createClientRecorder({ scheduledTasks: (id) => recordsBySurvey.get(id) ?? [] });
  const SURVEYS: ReadonlyArray<[string, number[]]> = [
    ['twelve reminders, most at equal offsets', [60, 60, 30, 60, 0, 1440, 60, 30, 0, 60, 60, 60]],
    ['250 reminders, three name batches', Array.from({ length: 250 }, (_, i) => ((i * 7) % 5) * 15)],
  ];
  const scheduledSurveys = new Map<string, RecordedSchedule>();
  let t: TestApp;

  /** Injects `url` as the tenant-a surveys manager; a body makes it a JSON write carrying CSRF tokens. */
  async function asManager(method: 'GET' | 'POST', url: string, body?: unknown) {
    const auth = await headersFor(Roles.surveysManager, { site: TENANT_A.siteId });
    return t.app.inject({
      method,
      url,
      headers: body === undefined ? auth : { ...auth, ...CSRF_HEADERS, 'content-type': 'application/json' },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** A new survey scheduled with reminders at `offsets`, as its own schedule rows. */
  async function scheduleSurvey(offsets: readonly number[]): Promise<RecordedSchedule> {
    const created = await asManager('POST', `${FIXTURE_BASE}${SITE_A}`, { title: 'Pulse' });
    const surveyId = (created.json() as { data: { survey_id: string } }).data.survey_id;
    const res = await asManager('POST', `${FIXTURE_BASE}/${surveyId}/schedule${SITE_A}`, {
      launchAt: '2026-07-01T09:00:00',
      reminders: offsets.map((offsetMinutes) => ({ offsetMinutes })),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { schedule, reminders } = (res.json() as { data: Omit<RecordedSchedule, 'surveyId'> }).data;
    return {
      surveyId,
      schedule: schedule === null ? null : { task_name: schedule.task_name },
      reminders: reminders.map(({ task_name, offset_minutes }) => ({ task_name, offset_minutes })),
    };
  }

  /** Communications' records of a schedule: out of order, some missing, deleted, doubled or failed, and one the survey never recorded. */
  function recordsFor({ surveyId, reminders }: RecordedSchedule): ScheduledTaskRecord[] {
    const task = (n: number | null, over: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord => ({
      taskName: `opt2-survey-${surveyId}-${n === null ? 'launch' : `reminder-${n}`}`,
      kind: n === null ? 'survey-launch' : 'survey-reminder',
      n,
      targetRoute: n === null ? '/internal/v1/tasks/surveys/launch' : '/internal/v1/tasks/reminders',
      scheduleTime: '2026-07-01T09:00:00.000',
      status: 'scheduled',
      scheduleVersion: 1,
      queue: n === null ? 'surveys-launch' : 'communications-reminders',
      ...over,
    });
    const records = [task(null, { status: 'done' }), task(reminders.length + 1)];
    for (let n = 1; n <= reminders.length; n += 1) {
      if (n % 13 === 0) continue;
      records.push(task(n, { status: n % 11 === 0 ? 'cancelled' : n % 17 === 0 ? 'superseded' : n % 5 === 0 ? 'done' : 'scheduled' }));
      if (n % 7 === 0) records.push(task(n, { status: 'failed', scheduleTime: '2026-07-02T09:00:00.000' }));
    }
    return records.map((record, i) => ({ record, at: (i * 37) % 101 })).sort((a, b) => a.at - b.at).map(({ record }) => record);
  }

  /** The scheduled-tasks calls made since `before`. */
  const listCallsSince = (before: number) => client.requests.slice(before).filter((req) => req.path === SCHEDULED_TASKS_PATH);

  beforeAll(async () => {
    t = await buildTestApp({ client });
    for (const [label, offsets] of SURVEYS) {
      const rows = await scheduleSurvey(offsets);
      scheduledSurveys.set(label, rows);
      recordsBySurvey.set(rows.surveyId, recordsFor(rows));
    }
  });

  afterAll(async () => {
    await t?.app.close();
  });

  const PAGINGS: ReadonlyArray<[string, (total: number) => string]> = [
    ['the default page', () => ''],
    ['one item a page', () => '&itemsPerPage=1'],
    ['the last one-item page', (total) => `&itemsPerPage=1&pageIndex=${String(total)}`],
    ['the third page of seven', () => '&itemsPerPage=7&pageIndex=3'],
    ['the page past the last default page', (total) => `&pageIndex=${String(Math.ceil(total / 50) + 1)}`],
    ['1000 a page', () => '&itemsPerPage=1000'],
    ['a page far beyond the range', () => '&pageIndex=99999&itemsPerPage=1000'],
  ];

  it.each(SURVEYS.flatMap(([survey]) => PAGINGS.map(([paging, query]) => [survey, paging, query] as const)))(
    'lists %s on %s as the whole-list reference does, at most 100 names a communications call',
    async (survey, _paging, query) => {
      const rows = scheduledSurveys.get(survey) as RecordedSchedule;
      const records = recordsBySurvey.get(rows.surveyId) ?? [];
      const total = referenceFixtureTaskList(records, rows).length;
      const paging = query(total);
      const expected = referenceFixtureTaskPage(records, rows, Object.fromEntries(new URLSearchParams(paging)));
      const before = client.requests.length;

      const res = await asManager('GET', `${FIXTURE_BASE}/${rows.surveyId}/tasks${SITE_A}${paging}`);

      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.stringify((res.json() as { data: unknown }).data)).toBe(JSON.stringify(expected));
      const names = listCallsSince(before).map((req) => [req.query?.taskName ?? []].flat());
      expect(names).toHaveLength(Math.ceil((rows.reminders.length + 1) / 100));
      expect(names.every((batch) => batch.length > 0 && batch.length <= 100)).toBe(true);
      expect(names.flat().sort()).toEqual([rows.schedule?.task_name, ...rows.reminders.map((reminder) => reminder.task_name)].sort());
    },
  );

  it.each(['itemsPerPage=0', 'itemsPerPage=1001', 'pageIndex=abc', 'pageIndex=0', 'pageIndex=1.5'])(
    'answers invalidParameters for %s after the survey check, without calling communications',
    async (paging) => {
      const rows = scheduledSurveys.get(SURVEYS[0]?.[0] ?? '') as RecordedSchedule;
      const before = client.requests.length;

      const res = await asManager('GET', `${FIXTURE_BASE}/${rows.surveyId}/tasks${SITE_A}&${paging}`);
      const unknown = await asManager('GET', `${FIXTURE_BASE}/${UNKNOWN_ID}/tasks${SITE_A}&${paging}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ apiversion: 'v1', method: fixtureMethod('surveys', 'tasks'), error: { code: 'invalid_request' } });
      expect(unknown.statusCode).toBe(FIXTURE_ERROR_MAP.notFound.status);
      expect(listCallsSince(before)).toEqual([]);
    },
  );
});
