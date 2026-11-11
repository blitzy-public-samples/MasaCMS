// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture and `/v1` task views over communications scheduled-task records. */
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_TASK_STATUS,
  toFixtureTask,
  toFixtureTaskList,
  toScheduledTaskView,
  type FixtureTaskListOptions,
  type ScheduledTaskRecord,
} from '../../src/legacy/tasks-view.js';

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
