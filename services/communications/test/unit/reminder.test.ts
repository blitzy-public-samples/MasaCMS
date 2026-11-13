// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `communications-reminders` task route through `app.inject`: the surveys callback, the row closed, no-op rows, rejections and failures. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUnavailableResponse, legacyErrorResponse } from '@opt2/platform/legacy-compat';
import { CLOUD_TASKS_HEADERS, TaskTenantMismatchError, taskWireBody, type CreateTaskInput, type TaskWireBody } from '@opt2/platform/tasks';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, mintTasksInvokerToken, pushTo } from '@opt2/platform/testing';
import { reminderSentPath } from '../../src/domain/reminders.js';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { SCHEDULED_TASK, type ScheduledTaskRow, type ScheduledTaskStatus } from '../../src/repo/tables.js';
import { REMINDER_TASK_PATH } from '../../src/tasks/reminder.js';
import { REMINDER_SENT_MATCH, buildTestApp, createRecordingDb, type Row, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const SERVICE = 'communications';
const REMINDER_QUEUE = 'communications-reminders';
const SURVEY_ID = SAMPLE_IDS.surveyId;
const OTHER_SURVEY_ID = 'E5F6A7B8-0005-4000-8000000000000005';
const UNKNOWN_TASK_ID = 'FFFFFFFF-FFFF-4FFF-8FFFFFFFFFFFFFFF';
// A well-formed tenant the site registry has never heard of.
const UNREGISTERED_TENANT = '0b7e6f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const SENT_AT = '2026-06-30T12:00:00.000';
const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE)\b/i;
const LEGACY_UNAVAILABLE = apiUnavailableResponse();
const UNAVAILABLE = { status: LEGACY_UNAVAILABLE.status, body: JSON.parse(LEGACY_UNAVAILABLE.body) as unknown };

let t: TestApp | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await t?.app.close();
  t = undefined;
});

/** Builds the app and delivers the sample survey's schedule `versions` in order. */
async function scheduled(...versions: (1 | 2)[]): Promise<TestApp> {
  const ctx = await buildTestApp();
  t = ctx;
  for (const version of versions) {
    const res = await pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(version)));
    expect(res.statusCode, res.body).toBe(204);
  }
  return ctx;
}

/** The first reminder task the schedule created for `version`, as the task port stored it. */
function reminderTask(ctx: TestApp, version: 1 | 2 = 1): CreateTaskInput {
  const task = ctx.taskPort.tasks.find((candidate) => candidate.queue === REMINDER_QUEUE && candidate.name.endsWith(`-v${String(version)}`));
  if (task === undefined) throw new TypeError(`schedule version ${String(version)} created no reminder task`);
  return task;
}

/** The scheduled-task id a reminder task's URL names. */
function taskIdOf(task: CreateTaskInput): string {
  return new URL(task.url).pathname.split('/').at(-1) ?? '';
}

/** The committed scheduled-task row with `id`. */
function storedRow(ctx: TestApp, id: string): Row | undefined {
  return ctx.db.rows(SCHEDULED_TASK.table).find((row) => row.scheduled_task_id === id);
}

/** Delivers `task` as the local Cloud Tasks adapter does, optionally to another path or with another wire body. */
async function deliver(ctx: TestApp, task: CreateTaskInput, opts: { path?: string; body?: TaskWireBody } = {}) {
  const path = opts.path ?? new URL(task.url).pathname;
  const res = await ctx.app.inject({
    method: 'POST',
    url: path,
    headers: {
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
      'content-type': 'application/json',
      [CLOUD_TASKS_HEADERS.taskName]: task.name,
      [CLOUD_TASKS_HEADERS.queueName]: task.queue,
      [CLOUD_TASKS_HEADERS.retryCount]: '0',
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(task.scheduleTime.getTime() / 1000),
    },
    payload: { ...(opts.body ?? taskWireBody(task)) },
  });
  const body: unknown = res.body === '' ? undefined : JSON.parse(res.body);
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body,
  });
  return { status: res.statusCode, body };
}

/** Write statements the database ran after transaction `mark`. */
function writesSince(ctx: TestApp, mark: number): string[] {
  return ctx.db.transactions
    .slice(mark)
    .flatMap((tx) => tx.statements)
    .map((statement) => statement.text)
    .filter((text) => WRITE_STATEMENT.test(text));
}

/** A pattern matching `table` of the app's schema as SQL text names it, quoted or not. */
function tableRef(ctx: TestApp, table: string): string {
  return `"?${ctx.db.schema}"?\\."?${table}"?`;
}

/** Sets one column of a stored tenant-a row directly, outside the communications repository. */
async function updateRow(ctx: TestApp, id: string, column: 'status' | 'reminder_n', value: ScheduledTaskStatus | null): Promise<void> {
  await ctx.db.withTenant(TENANT_A.tenantId, (tx) =>
    tx.query(`UPDATE ${ctx.db.schema}.${SCHEDULED_TASK.table} SET ${column} = $1 WHERE scheduled_task_id = $2`, [value, id]),
  );
}

/** Awaits `work`, started with only Date faked and stepped a second per real 25 ms, so gate budgets elapse quickly. */
async function withSteppedClock<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    let settled = false;
    const pending = work().finally(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      vi.setSystemTime(Date.now() + 1_000);
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** The legacy JSON API body of `type`, as the service renders a LegacyApiError. */
function legacyErrorBody(type: string): unknown {
  return JSON.parse(legacyErrorResponse(type).body) as unknown;
}

describe('reminder task', () => {
  it('reports the reminder sent to surveys, then closes its row', async () => {
    const ctx = await scheduled(1);
    const task = reminderTask(ctx);
    const id = taskIdOf(task);
    expect(new URL(task.url).pathname).toBe(REMINDER_TASK_PATH.replace(':scheduledTaskId', id));
    const mark = ctx.db.transactions.length;

    await expect(deliver(ctx, task)).resolves.toEqual({ status: 200, body: { status: 'sent' } });

    expect(ctx.client.requestsTo('surveys')).toEqual([
      {
        service: 'surveys',
        method: 'POST',
        path: reminderSentPath(SURVEY_ID, 1),
        json: {
          tenantId: TENANT_A.tenantId,
          siteId: TENANT_A.siteId,
          taskName: `opt2-survey-${SURVEY_ID}-reminder-1`,
          scheduleVersion: 1,
          sentAt: SENT_AT,
        },
        userToken: null,
      },
    ]);
    expect(storedRow(ctx, id)?.status).toBe('done');
    const writers = ctx.db.transactions.slice(mark).filter((tx) => tx.statements.some((s) => WRITE_STATEMENT.test(s.text)));
    expect(writers.map((tx) => [tx.tenantId, tx.outcome])).toEqual([[TENANT_A.tenantId, 'commit']]);
    // The row update and its audit row, in one tenant transaction.
    expect(writesSince(ctx, mark)).toEqual([
      expect.stringMatching(new RegExp(`^UPDATE ${tableRef(ctx, SCHEDULED_TASK.table)} SET "?status"? `, 'i')),
      expect.stringMatching(new RegExp(`^INSERT INTO ${tableRef(ctx, 'changelog')} `, 'i')),
    ]);
    // The fixture's remind callback only stamps sent_at, so the reminder sends no mail.
    expect(ctx.mail.sent).toEqual([]);
    expect(ctx.deliveryStatus.calls).toEqual([]);
  });

  it.each<[string, 'already-sent' | 'superseded', ScheduledTaskStatus, (ctx: TestApp, task: CreateTaskInput) => Promise<unknown>]>([
    ['repeated after its run', 'already-sent', 'done', (ctx, task) => deliver(ctx, task)],
    ['superseded by schedule version 2', 'superseded', 'superseded', (ctx) =>
      pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(2)))],
    ['cancelled', 'superseded', 'cancelled', (ctx, task) => updateRow(ctx, taskIdOf(task), 'status', 'cancelled')],
  ])('answers a task %s with %s and changes nothing', async (_case, outcome, status, setup) => {
    const ctx = await scheduled(1);
    const task = reminderTask(ctx);
    await setup(ctx, task);
    ctx.client.clear();
    const mark = ctx.db.transactions.length;

    await expect(deliver(ctx, task)).resolves.toEqual({ status: 200, body: { status: outcome } });

    expect(ctx.client.requests).toEqual([]);
    expect(writesSince(ctx, mark)).toEqual([]);
    expect(storedRow(ctx, taskIdOf(task))?.status).toBe(status);
    expect(ctx.mail.sent).toEqual([]);
  });
});

describe('reminder task rejection', () => {
  type Mutation = (body: TaskWireBody, launchId: string) => { body?: TaskWireBody; path?: string };
  const withPayload = (body: TaskWireBody, patch: Record<string, unknown>): TaskWireBody => ({
    ...body,
    payload: { ...(body.payload as Record<string, unknown>), ...patch },
  });

  it.each<[string, Mutation]>([
    ["another tenant's body", (body) => ({ body: { ...body, tenantId: TENANT_B.tenantId } })],
    ['a body without a tenant', (body) => ({ body: { ...body, tenantId: null } })],
    ['an unknown scheduled task', (body) => ({ body: withPayload(body, { scheduledTaskId: UNKNOWN_TASK_ID }) })],
    ["another survey's id", (body) => ({ body: withPayload(body, { surveyId: OTHER_SURVEY_ID }) })],
    ["the launch task's row", (body, launchId) => ({ body: withPayload(body, { scheduledTaskId: launchId }) })],
    ['a malformed payload', (body) => ({ body: withPayload(body, { n: 0 }) })],
    ['a path naming another task', (_body, launchId) => ({ path: REMINDER_TASK_PATH.replace(':scheduledTaskId', launchId) })],
  ])('refuses %s as badRequest, with no surveys call or write', async (_case, mutate) => {
    const ctx = await scheduled(1);
    const task = reminderTask(ctx);
    const launch = ctx.db.rows(SCHEDULED_TASK.table).find((row) => row.kind === 'survey-launch');
    if (launch === undefined) throw new TypeError('the schedule stored no launch row');
    const mark = ctx.db.transactions.length;

    const { status, body } = await deliver(ctx, task, mutate(taskWireBody(task), String(launch.scheduled_task_id)));

    expect(status).toBe(400);
    expect(body).toEqual(legacyErrorBody(new TaskTenantMismatchError(TENANT_A.tenantId, task.name).type));
    expect(ctx.client.requestsTo('surveys')).toEqual([]);
    expect(writesSince(ctx, mark)).toEqual([]);
    expect(storedRow(ctx, taskIdOf(task))?.status).toBe('scheduled');
  });
});

describe('reminder task failure', () => {
  const GATE = SCHEDULED_TASK.unit;
  const surveysAnswersAgain = (ctx: TestApp): void => ctx.client.respond(REMINDER_SENT_MATCH, 200, { applied: true });
  const gateReopened = (ctx: TestApp): void => ctx.db.setGate(GATE, 'open');

  // The write gate guards only the row's closing write, so a closed or legacy gate still lets the surveys call through;
  // only a window's executing phase also blocks the row read, before the call.
  it.each<[string, number, (ctx: TestApp) => void, (ctx: TestApp) => void]>([
    ['surveys answers the legacy 503', 1, (ctx) => ctx.client.unavailable(REMINDER_SENT_MATCH), surveysAnswersAgain],
    ['surveys answers 404', 1, (ctx) => ctx.client.respond(REMINDER_SENT_MATCH, 404, {}), surveysAnswersAgain],
    ['surveys is unreachable', 1, (ctx) => ctx.client.fail(REMINDER_SENT_MATCH), surveysAnswersAgain],
    ['the row gate stays closed past its budget', 1, (ctx) => ctx.db.setGate(GATE, 'closed'), gateReopened],
    ['the row unit is legacy-authoritative', 1, (ctx) => ctx.db.setGate(GATE, 'legacy'), gateReopened],
    ['a write window executes on the row unit', 0, (ctx) => ctx.db.setGate(GATE, 'closed', 'executing'), gateReopened],
  ])('answers the legacy 503 while %s, then sends on the retry', async (_case, callsBeforeRetry, fail, restore) => {
    const ctx = await scheduled(1);
    const task = reminderTask(ctx);
    const id = taskIdOf(task);
    fail(ctx);

    await expect(withSteppedClock(() => deliver(ctx, task))).resolves.toEqual(UNAVAILABLE);
    expect(ctx.client.requestsTo('surveys')).toHaveLength(callsBeforeRetry);
    expect(storedRow(ctx, id)?.status).toBe('scheduled');

    restore(ctx);
    await expect(deliver(ctx, task)).resolves.toEqual({ status: 200, body: { status: 'sent' } });
    expect(ctx.client.requestsTo('surveys')).toHaveLength(callsBeforeRetry + 1);
    expect(storedRow(ctx, id)?.status).toBe('done');
    expect(ctx.mail.sent).toEqual([]);
  });

  it('answers the legacy 503 for a tenant without a registry entry, before calling surveys', async () => {
    const id = '0000000A-AAAA-4AAA-8AAAAAAAAAAAAAAA';
    const row: ScheduledTaskRow = {
      tenant_id: UNREGISTERED_TENANT,
      scheduled_task_id: id,
      task_name: `opt2-survey-${SURVEY_ID}-reminder-1`,
      queue: REMINDER_QUEUE,
      queue_task_name: `opt2-survey-${SURVEY_ID}-reminder-1-v1`,
      kind: 'survey-reminder',
      source_type: 'survey',
      source_id: SURVEY_ID,
      reminder_n: 1,
      schedule_time: new Date(2026, 6, 1, 10, 0, 0),
      status: 'scheduled',
      target_route: REMINDER_TASK_PATH.replace(':scheduledTaskId', id),
      schedule_version: 1,
      origin: 'event',
      enqueued_at: new Date(2026, 5, 30, 12, 0, 0),
      dequeued_at: null,
      created_at: new Date(2026, 5, 30, 12, 0, 0),
      updated_at: new Date(2026, 5, 30, 12, 0, 0),
    };
    const ctx = await buildTestApp({ db: createRecordingDb({ [SCHEDULED_TASK.table]: [row] }) });
    t = ctx;
    const task: CreateTaskInput = {
      queue: REMINDER_QUEUE,
      name: row.queue_task_name,
      scheduleTime: row.schedule_time,
      url: `http://127.0.0.1:8115${row.target_route}`,
      body: { scheduledTaskId: id, surveyId: SURVEY_ID, n: 1, scheduleVersion: 1 },
      deadlineS: 600,
      tenantId: UNREGISTERED_TENANT,
    };

    await expect(deliver(ctx, task)).resolves.toEqual(UNAVAILABLE);
    expect(ctx.client.requests).toEqual([]);
    expect(storedRow(ctx, id)?.status).toBe('scheduled');
  });

  it('answers the legacy 500 for a stored reminder without its ordinal', async () => {
    const ctx = await scheduled(1);
    const task = reminderTask(ctx);
    await updateRow(ctx, taskIdOf(task), 'reminder_n', null);

    await expect(deliver(ctx, task)).resolves.toEqual({ status: 500, body: legacyErrorBody('server_error') });
    expect(ctx.client.requests).toEqual([]);
    expect(storedRow(ctx, taskIdOf(task))?.status).toBe('scheduled');
  });
});
