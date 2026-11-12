// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 task plan: names, queues, run times, targets and payloads of one survey schedule version. */
import { describe, expect, it } from 'vitest';
import { InvalidTaskNameError, QUEUES, TASK_NAME_PATTERN, UnknownTaskTargetError, targetUrl } from '@opt2/platform/tasks';
import { TENANT_A, businessClock } from '@opt2/platform/testing';
import {
  SURVEY_TASK_QUEUES,
  kindOfLegacyTaskName,
  legacyRunTime,
  parseLocalTimestamp,
  planSurveyTasks,
  portTaskName,
  taskPayload,
  taskTarget,
  type SurveyTaskPayloadSource,
} from '../../src/domain/survey-tasks.js';
import type { SurveyScheduledPayload } from '../../src/generated/events/surveys.survey.scheduled.v1.js';

const SURVEY_ID = '5A1F0C3E-7B2D-4E69-8C4A1B2D3E4F5A6B';
const ROW_ID = '9E8D7C6B-5A49-3827-1605F4E3D2C1B0A9';
const SERVICE_URLS = { surveys: 'http://127.0.0.1:8117', communications: 'http://127.0.0.1:8115' };

const launchName = (surveyId = SURVEY_ID): string => `opt2-survey-${surveyId}-launch`;
const reminderName = (n: number, surveyId = SURVEY_ID): string => `opt2-survey-${surveyId}-reminder-${String(n)}`;

/** A first-version `surveys.survey.scheduled.v1` payload with one reminder per offset, numbered from 1. */
function scheduled(launchAt: string, offsets: readonly number[]): SurveyScheduledPayload {
  return {
    surveyId: SURVEY_ID,
    siteId: TENANT_A.siteId,
    scheduleVersion: 1,
    launchAt,
    launchTaskName: launchName(),
    reminders: offsets.map((offsetMinutes, i) => ({ n: i + 1, offsetMinutes, taskName: reminderName(i + 1) })),
    targets: [{ siteId: TENANT_A.siteId, groupName: null }],
  };
}

/** Runs `run` with the process time zone set to `tz`, then restores the previous one. */
function inTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('SURVEY_TASK_QUEUES', () => {
  it('maps each kind to a communications-created queue', () => {
    expect(SURVEY_TASK_QUEUES).toStrictEqual({
      'survey-launch': 'surveys-launch',
      'survey-reminder': 'communications-reminders',
    });
    expect(Object.isFrozen(SURVEY_TASK_QUEUES)).toBe(true);
    for (const queue of Object.values(SURVEY_TASK_QUEUES)) {
      expect(QUEUES[queue].creators).toContain('communications');
    }
  });
});

describe('portTaskName', () => {
  it.each([
    [launchName(), 1],
    [reminderName(3), 1],
    [launchName(), 2],
    [reminderName(3), 12],
  ])('suffixes %s with version %i', (name, version) => {
    const portName = portTaskName(name, version);
    expect(portName).toBe(`${name}-v${String(version)}`);
    expect(portName).toMatch(TASK_NAME_PATTERN);
  });

  it.each([
    ['a dot', 'opt2-survey.launch'],
    ['a space', 'opt2 survey launch'],
    ['501 characters', 'x'.repeat(498)],
  ])('rejects a name with %s', (_label, name) => {
    expect(() => portTaskName(name, 1)).toThrow(InvalidTaskNameError);
  });
});

describe('parseLocalTimestamp', () => {
  it.each([
    ['UTC', '2026-07-01T09:30:15.250Z'],
    ['America/New_York', '2026-07-01T13:30:15.250Z'],
    ['Asia/Kolkata', '2026-07-01T04:00:15.250Z'],
  ])('reads wall-clock time in %s', (tz, instant) => {
    inTimeZone(tz, () => {
      const date = parseLocalTimestamp('2026-07-01T09:30:15.250');
      expect([
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      ]).toStrictEqual([2026, 6, 1, 9, 30, 15, 250]);
      expect(date.toISOString()).toBe(instant);
    });
  });

  it.each([
    '',
    '2026-07-01T09:30:15',
    '2026-07-01 09:30:15.250',
    '2026-07-01T09:30:15.250Z',
    '2026-07-01T09:30:15.250+02:00',
    ' 2026-07-01T09:30:15.250',
  ])('rejects the format of %j', (text) => {
    expect(() => parseLocalTimestamp(text)).toThrow(/expected yyyy-MM-ddTHH:mm:ss\.SSS/);
  });

  it.each([
    '2026-02-29T00:00:00.000',
    '2026-00-10T00:00:00.000',
    '2026-13-01T00:00:00.000',
    '2026-07-01T24:00:00.000',
    '2026-07-01T09:60:00.000',
    '2026-07-01T09:30:60.000',
    '0000-07-01T09:30:15.250',
  ])('rejects the nonexistent time %s', (text) => {
    inTimeZone('UTC', () => {
      expect(() => parseLocalTimestamp(text)).toThrow(RangeError);
      expect(() => parseLocalTimestamp(text)).toThrow(/no such local time/);
    });
  });

  it('rejects a time skipped by daylight saving', () => {
    inTimeZone('America/New_York', () => {
      expect(() => parseLocalTimestamp('2026-03-08T02:30:00.000')).toThrow(/no such local time/);
      expect(parseLocalTimestamp('2026-03-08T03:30:00.000').getHours()).toBe(3);
    });
  });

  it.each([
    ['America/New_York', '2026-11-01T01:30:00.000', '2026-11-01T06:30:00.000Z'],
    ['Europe/London', '2026-10-25T01:30:00.000', '2026-10-25T01:30:00.000Z'],
    ['Australia/Sydney', '2026-04-05T02:30:00.000', '2026-04-04T16:30:00.000Z'],
  ])('resolves a time repeated by daylight saving in %s to its later offset', (tz, text, instant) => {
    inTimeZone(tz, () => {
      expect(parseLocalTimestamp(text).toISOString()).toBe(instant);
    });
  });
});

describe('legacyRunTime', () => {
  it.each([
    ['the earlier reading of a repeated time', 'America/New_York', '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    ['the later reading of a repeated time', 'America/New_York', '2026-11-01T06:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    ['an unambiguous time', 'America/New_York', '2026-07-01T13:30:15.250Z', '2026-07-01T13:30:15.250Z'],
    ['a time in UTC', 'UTC', '2026-11-01T05:30:00.000Z', '2026-11-01T05:30:00.000Z'],
    ['a year before 1, which has no legacy wall time', 'UTC', '0000-06-01T00:00:00.000Z', '0000-06-01T00:00:00.000Z'],
  ])('runs %s in %s at its legacy instant', (_label, tz, at, instant) => {
    inTimeZone(tz, () => {
      expect(legacyRunTime(new Date(at)).toISOString()).toBe(instant);
    });
  });
});

describe('planSurveyTasks', () => {
  it('plans the launch, then one task per reminder', () => {
    const tasks = planSurveyTasks(scheduled('2026-07-01T09:00:00.000', [60, 1440]), { now: businessClock().now() });
    const common = { surveyId: SURVEY_ID, siteId: TENANT_A.siteId, scheduleVersion: 1 };
    expect(tasks).toStrictEqual([
      {
        kind: 'survey-launch',
        queue: 'surveys-launch',
        legacyTaskName: launchName(),
        portName: `${launchName()}-v1`,
        scheduleTime: new Date(2026, 6, 1, 9, 0, 0, 0),
        deadlineS: QUEUES['surveys-launch'].deadlineS,
        ...common,
      },
      {
        kind: 'survey-reminder',
        queue: 'communications-reminders',
        legacyTaskName: reminderName(1),
        portName: `${reminderName(1)}-v1`,
        scheduleTime: new Date(2026, 6, 1, 10, 0, 0, 0),
        deadlineS: QUEUES['communications-reminders'].deadlineS,
        ...common,
        n: 1,
      },
      {
        kind: 'survey-reminder',
        queue: 'communications-reminders',
        legacyTaskName: reminderName(2),
        portName: `${reminderName(2)}-v1`,
        scheduleTime: new Date(2026, 6, 2, 9, 0, 0, 0),
        deadlineS: QUEUES['communications-reminders'].deadlineS,
        ...common,
        n: 2,
      },
    ]);
    expect(tasks[0]).not.toHaveProperty('n');
  });

  it('plans only the launch without reminders', () => {
    const tasks = planSurveyTasks(scheduled('2026-07-01T09:00:00.000', []), { now: businessClock().now() });
    expect(tasks.map((task) => task.kind)).toStrictEqual(['survey-launch']);
  });

  it('moves past run times to now and keeps future ones', () => {
    const now = businessClock('12:00:00').now();
    const tasks = planSurveyTasks(scheduled('2026-06-30T09:00:00.000', [60, 180, 240]), { now });
    expect(tasks.map((task) => task.scheduleTime)).toStrictEqual([now, now, now, new Date(2026, 5, 30, 13, 0, 0, 0)]);
  });

  it.each([
    ['a launch at a repeated local time', '2026-11-01T01:30:00.000', ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']],
    ['a reminder at a repeated local time', '2026-11-01T00:30:00.000', ['2026-11-01T04:30:00.000Z', '2026-11-01T06:30:00.000Z']],
  ])('runs %s at its later offset in America/New_York', (_label, launchAt, instants) => {
    inTimeZone('America/New_York', () => {
      const tasks = planSurveyTasks(scheduled(launchAt, [60]), { now: businessClock().now() });
      expect(tasks.map((task) => task.scheduleTime.toISOString())).toStrictEqual(instants);
    });
  });

  it('gives version 2 names of its own', () => {
    const payload = scheduled('2026-07-01T09:00:00.000', [60]);
    const now = businessClock().now();
    const v1 = planSurveyTasks(payload, { now });
    const v2 = planSurveyTasks({ ...payload, scheduleVersion: 2 }, { now });
    expect(v2.map((task) => task.portName)).toStrictEqual([`${launchName()}-v2`, `${reminderName(1)}-v2`]);
    expect(v2.map((task) => task.legacyTaskName)).toStrictEqual(v1.map((task) => task.legacyTaskName));
    expect(v2.every((task) => task.scheduleVersion === 2 && TASK_NAME_PATTERN.test(task.portName))).toBe(true);
    expect(v2.some((task) => v1.some((old) => old.portName === task.portName))).toBe(false);
  });

  it('rejects an invalid launchAt', () => {
    const payload = scheduled('2026-07-01T09:00:00Z', [60]);
    expect(() => planSurveyTasks(payload, { now: businessClock().now() })).toThrow(RangeError);
  });

  it('round-trips legacy task names', () => {
    const tasks = planSurveyTasks(scheduled('2026-07-01T09:00:00.000', [60, 120]), { now: businessClock().now() });
    expect(tasks.map((task) => kindOfLegacyTaskName(task.legacyTaskName))).toStrictEqual(
      tasks.map((task) => ({ surveyId: task.surveyId, kind: task.kind, ...(task.n === undefined ? {} : { n: task.n }) })),
    );
  });
});

describe('taskTarget', () => {
  it('targets the surveys launch route', () => {
    expect(taskTarget({ queue: 'surveys-launch', surveyId: SURVEY_ID }, SERVICE_URLS)).toStrictEqual({
      url: targetUrl(QUEUES['surveys-launch'], SERVICE_URLS, { surveyId: SURVEY_ID }),
      route: `/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
    });
  });

  it('targets the reminder route of its row', () => {
    const ref = { queue: 'communications-reminders', surveyId: SURVEY_ID, scheduledTaskId: ROW_ID } as const;
    expect(taskTarget(ref, SERVICE_URLS)).toStrictEqual({
      url: targetUrl(QUEUES['communications-reminders'], SERVICE_URLS, { scheduledTaskId: ROW_ID }),
      route: `/internal/v1/tasks/reminders/${ROW_ID}`,
    });
  });

  it('targets each planned task on its own service', () => {
    const tasks = planSurveyTasks(scheduled('2026-07-01T09:00:00.000', [60]), { now: businessClock().now() });
    const urls = tasks.map((task) => taskTarget({ ...task, scheduledTaskId: ROW_ID }, SERVICE_URLS).url);
    expect(urls).toStrictEqual([
      `${SERVICE_URLS.surveys}/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
      `${SERVICE_URLS.communications}/internal/v1/tasks/reminders/${ROW_ID}`,
    ]);
  });

  it('rejects a reminder without its row id', () => {
    expect(() => taskTarget({ queue: 'communications-reminders', surveyId: SURVEY_ID }, SERVICE_URLS)).toThrow(TypeError);
  });

  it('rejects a target service without a URL', () => {
    expect(() =>
      taskTarget({ queue: 'surveys-launch', surveyId: SURVEY_ID }, { communications: SERVICE_URLS.communications }),
    ).toThrow(UnknownTaskTargetError);
  });
});

describe('taskPayload', () => {
  const base = { surveyId: SURVEY_ID, siteId: TENANT_A.siteId, scheduleVersion: 2 };

  it.each<SurveyTaskPayloadSource>([
    { ...base, kind: 'survey-launch' },
    { ...base, kind: 'survey-launch', n: null },
  ])('builds the launch payload from %j', (source) => {
    expect(taskPayload(source, ROW_ID)).toStrictEqual({ surveyId: SURVEY_ID, siteId: TENANT_A.siteId, scheduleVersion: 2 });
  });

  it('builds the reminder payload', () => {
    expect(taskPayload({ ...base, kind: 'survey-reminder', n: 3 }, ROW_ID)).toStrictEqual({
      scheduledTaskId: ROW_ID,
      surveyId: SURVEY_ID,
      n: 3,
      scheduleVersion: 2,
    });
  });

  it.each([undefined, null])('rejects a reminder whose ordinal is %s', (n) => {
    expect(() => taskPayload({ ...base, kind: 'survey-reminder', n }, ROW_ID)).toThrow(RangeError);
  });
});

describe('kindOfLegacyTaskName', () => {
  it.each([
    [launchName(), { surveyId: SURVEY_ID, kind: 'survey-launch' }],
    [reminderName(1), { surveyId: SURVEY_ID, kind: 'survey-reminder', n: 1 }],
    [reminderName(12), { surveyId: SURVEY_ID, kind: 'survey-reminder', n: 12 }],
  ])('parses %s', (name, parts) => {
    expect(kindOfLegacyTaskName(name)).toStrictEqual(parts);
  });

  it.each([
    '',
    launchName(SURVEY_ID.toLowerCase()),
    launchName('5A1F0C3E-7B2D-4E69-8C4A-1B2D3E4F5A6B'),
    `${launchName()}-v1`,
    reminderName(0),
    `opt2-survey-${SURVEY_ID}-reminder-01`,
    `opt2-survey-${SURVEY_ID}-reminder-9007199254740993`,
  ])('rejects %j', (name) => {
    expect(kindOfLegacyTaskName(name)).toBeNull();
  });
});
