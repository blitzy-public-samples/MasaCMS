// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 task plans of the fixture schedules as task-port inputs, and their creation once per task name. */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
// createLogger and createCommunicationsRepository are the real ones, which no test helper provides, so the stamps checked are production's.
import { createLogger } from '@opt2/platform/logging';
import { QUEUES, TASK_NAME_PATTERN, targetUrl, type CreateTaskInput, type CreateTaskResult, type TaskPort } from '@opt2/platform/tasks';
import { TENANT_A, businessClock, pushTo } from '@opt2/platform/testing';
import { enqueueScheduledTasks, type SurveyScheduleDeps } from '../../src/domain/survey-schedule.js';
import { planSurveyTasks, taskPayload, taskTarget } from '../../src/domain/survey-tasks.js';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import type { ScheduledTaskRow } from '../../src/repo/tables.js';
import { buildTestApp, removeTestStateDir, testEnv, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

type Version = 1 | 2;

const SURVEY_ID = SAMPLE_IDS.surveyId;
const SITE_ID = TENANT_A.siteId;
const TENANT_ID = TENANT_A.tenantId;
const VERSIONS: readonly Version[] = [1, 2];

// Local run times of the fixture schedules: the launch, then launchAt plus each reminder offset.
const RUN_TIMES: Readonly<Record<Version, readonly Date[]>> = {
  1: [new Date(2026, 6, 1, 9, 0, 0, 0), new Date(2026, 6, 1, 10, 0, 0, 0)],
  2: [new Date(2026, 6, 2, 9, 0, 0, 0), new Date(2026, 6, 2, 11, 0, 0, 0), new Date(2026, 6, 3, 9, 0, 0, 0)],
};

const env = await testEnv();
const serviceUrls = env.OPT2_SERVICE_URLS;

afterAll(() => {
  removeTestStateDir(env.OPT2_STATE_DIR);
});

/** CF-format id standing in for the stored row of the plan's task at `index`. */
function rowId(index: number): string {
  return `E5F6A7B8-0005-4000-${String(index).padStart(16, '0')}`;
}

/** The port inputs of schedule `version` as `enqueueScheduledTasks` builds them, the task at `index` with row id `idOf(index)`. */
function portInputs(version: Version, idOf: (index: number) => string = rowId): CreateTaskInput[] {
  return planSurveyTasks(surveyScheduledPayload(version), { now: businessClock().now() }).map((task, index) => ({
    queue: task.queue,
    name: task.portName,
    scheduleTime: task.scheduleTime,
    url: taskTarget({ queue: task.queue, surveyId: task.surveyId, scheduledTaskId: idOf(index) }, serviceUrls).url,
    body: taskPayload(task, idOf(index)),
    deadlineS: task.deadlineS,
    tenantId: TENANT_ID,
  }));
}

describe('fixture schedules as port inputs', () => {
  it.each(VERSIONS)('version %i: the launch on surveys-launch, then each reminder on communications-reminders', (version) => {
    const [launchAt, ...reminderTimes] = RUN_TIMES[version];
    const launch = QUEUES['surveys-launch'];
    const reminders = QUEUES['communications-reminders'];

    expect(portInputs(version)).toStrictEqual([
      {
        queue: launch.name,
        name: `opt2-survey-${SURVEY_ID}-launch-v${String(version)}`,
        scheduleTime: launchAt,
        url: targetUrl(launch, serviceUrls, { surveyId: SURVEY_ID }),
        body: { surveyId: SURVEY_ID, siteId: SITE_ID, scheduleVersion: version },
        deadlineS: launch.deadlineS,
        tenantId: TENANT_ID,
      },
      ...reminderTimes.map((scheduleTime, i) => ({
        queue: reminders.name,
        name: `opt2-survey-${SURVEY_ID}-reminder-${String(i + 1)}-v${String(version)}`,
        scheduleTime,
        url: targetUrl(reminders, serviceUrls, { scheduledTaskId: rowId(i + 1) }),
        body: { scheduledTaskId: rowId(i + 1), surveyId: SURVEY_ID, n: i + 1, scheduleVersion: version },
        deadlineS: reminders.deadlineS,
        tenantId: TENANT_ID,
      })),
    ]);
  });

  it.each(VERSIONS)('version %i: calls the task routes with valid queue task names', (version) => {
    const inputs = portInputs(version);

    expect(inputs.map(({ url }) => new URL(url).pathname)).toStrictEqual([
      `/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
      ...inputs.slice(1).map((_, i) => `/internal/v1/tasks/reminders/${rowId(i + 1)}`),
    ]);
    expect(inputs.every(({ name }) => TASK_NAME_PATTERN.test(name))).toBe(true);
  });
});

describe('enqueueScheduledTasks', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  it.each(VERSIONS)('version %i: creates each stored task once by name as its row repeats, counting a repeat as created', async (version) => {
    const built = await buildTestApp();
    t = built;
    const payload = surveyScheduledPayload(version);
    const taskCount = 1 + payload.reminders.length;
    // Failed creates leave every row of the delivered schedule unstamped, as recovery would find them.
    built.taskPort.failCreate(taskCount);
    const delivered = await pushTo(built.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, payload));
    expect(delivered.statusCode, delivered.body).toBe(204);

    const rows = built.db.rows('scheduled_task') as unknown as ScheduledTaskRow[];
    const stamps = (): Record<string, unknown> =>
      Object.fromEntries(built.db.rows('scheduled_task').map((row) => [String(row.queue_task_name), row.enqueued_at]));
    const surveyTasks = (): CreateTaskInput[] => ['surveys-launch', 'communications-reminders'].flatMap((queue) => built.taskPort.byQueue(queue));
    expect(rows.map(({ queue_task_name }) => queue_task_name)).toStrictEqual(portInputs(version).map(({ name }) => name));
    expect(Object.values(stamps())).toStrictEqual(rows.map(() => null));
    expect(surveyTasks()).toStrictEqual([]);

    const results: CreateTaskResult[] = [];
    const errors: unknown[] = [];
    const taskPort: TaskPort = {
      ...built.taskPort,
      create: async (input) => {
        const result = await built.taskPort.create(input);
        results.push(result);
        return result;
      },
    };
    const logger = createLogger({
      service: 'communications',
      version: '1.0.0',
      env: 'local',
      destination: {
        write: (line: string) => {
          const record = JSON.parse(line) as { severity?: string };
          if (record.severity === 'ERROR') errors.push(record);
        },
      },
    });
    const deps: SurveyScheduleDeps = {
      db: built.db,
      repository: createCommunicationsRepository({ clock: built.clock }),
      clock: built.clock,
      logger,
      taskPort,
      serviceUrls: built.env.OPT2_SERVICE_URLS,
    };

    // Each row twice in one call, then every row again in a second call.
    await enqueueScheduledTasks(deps, TENANT_ID, rows.flatMap((row) => [row, row]), { siteId: SITE_ID });
    const first = stamps();
    await enqueueScheduledTasks(deps, TENANT_ID, rows, { siteId: SITE_ID });

    expect(results).toStrictEqual([
      ...rows.flatMap(({ queue_task_name: name }) => [{ name, created: true }, { name, created: false }]),
      ...rows.map(({ queue_task_name: name }) => ({ name, created: false })),
    ]);
    expect(surveyTasks()).toStrictEqual(
      portInputs(version, (index) => {
        const row = rows[index];
        if (row === undefined) throw new TypeError(`no stored row for planned task ${String(index)}`);
        return row.scheduled_task_id;
      }),
    );
    expect(first).toStrictEqual(Object.fromEntries(rows.map((row) => [row.queue_task_name, built.clock.now()])));
    expect(stamps()).toStrictEqual(first);
    expect(errors).toStrictEqual([]);
  });
});
