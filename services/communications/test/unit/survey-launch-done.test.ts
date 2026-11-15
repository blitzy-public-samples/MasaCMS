// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `markSurveyLaunchTaskDone` through `app.inject`: the launch row closed for surveys, no-op rows, re-checks, malformed calls, gates and concurrent writers. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiUnavailableResponse, legacyErrorResponse } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER } from '@opt2/platform/migration-kit';
import type { CreateTaskInput } from '@opt2/platform/tasks';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintUserToken,
  pgAvailable,
  pushTo,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { SCHEDULED_TASK, type ScheduledTaskRow, type ScheduledTaskStatus } from '../../src/repo/tables.js';
import { SCHEDULED_TASKS_PATH } from '../../src/routes/scheduled-tasks.js';
import { SURVEY_LAUNCH_DONE_PATH } from '../../src/routes/survey-launch-done.js';
import { buildTestApp, headersFor, type Row, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const LAUNCH_QUEUE = 'surveys-launch';
const REMINDER_QUEUE = 'communications-reminders';
const SURVEY_ID = SAMPLE_IDS.surveyId;
const OTHER_SURVEY_ID = 'E5F6A7B8-0005-4000-8000000000000005';
// A well-formed tenant the site registry has never heard of.
const UNREGISTERED_TENANT = '0b7e6f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const GATE = SCHEDULED_TASK.unit;
const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE)\b/i;
const LEGACY_UNAVAILABLE = apiUnavailableResponse();
const UNAVAILABLE = { status: LEGACY_UNAVAILABLE.status, body: JSON.parse(LEGACY_UNAVAILABLE.body) as unknown };
const INVALID_PARAMETERS = JSON.parse(legacyErrorResponse('invalidParameters').body) as unknown;

type Body = Record<string, unknown>;

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

/** The first task schedule `version` created on `queue`, as the task port stored it. */
function queuedTask(ctx: TestApp, queue: string, version: 1 | 2 = 1): CreateTaskInput {
  const task = ctx.taskPort.tasks.find((candidate) => candidate.queue === queue && candidate.name.endsWith(`-v${String(version)}`));
  if (task === undefined) throw new TypeError(`schedule version ${String(version)} created no task on ${queue}`);
  return task;
}

/** The committed scheduled-task row of `task`. */
function storedRow(ctx: TestApp, task: CreateTaskInput): Row | undefined {
  return ctx.db.rows(SCHEDULED_TASK.table).find((row) => row.queue === task.queue && row.queue_task_name === task.name);
}

/** Surveys' report that the version-1 launch `task` ran, with `patch` applied. */
function reportOf(task: CreateTaskInput, patch: Body = {}): Body {
  return { tenantId: TENANT_A.tenantId, queueTaskName: task.name, scheduleVersion: 1, ...patch };
}

/** Posts surveys' report under its invocation credential for `surveyId` and checks the answer against the contract. */
async function report(ctx: TestApp<TenantDb>, payload: unknown, surveyId: string = SURVEY_ID) {
  const path = SURVEY_LAUNCH_DONE_PATH.replace(':surveyId', surveyId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: path,
    headers: { ...(await headersFor('service:surveys')), 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  const body: unknown = res.body === '' ? undefined : JSON.parse(res.body);
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path, status: res.statusCode, contentType: res.headers['content-type'], body });
  return { status: res.statusCode, body, position: res.headers[WRITE_POSITION_HEADER.toLowerCase()] };
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

/** Sets the status of a stored tenant-a row directly, outside the communications repository. */
async function setStatus(ctx: TestApp, task: CreateTaskInput, status: ScheduledTaskStatus): Promise<void> {
  await ctx.db.withTenant(TENANT_A.tenantId, (tx) =>
    tx.query(`UPDATE ${ctx.db.schema}.${SCHEDULED_TASK.table} SET status = $1 WHERE queue = $2 AND queue_task_name = $3`, [
      status,
      task.queue,
      task.name,
    ]),
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

describe('markSurveyLaunchTaskDone', () => {
  it("records the launch task done on surveys' behalf in one tenant-a transaction with its audit row", async () => {
    const ctx = await scheduled(1);
    const task = queuedTask(ctx, LAUNCH_QUEUE);
    const mark = ctx.db.transactions.length;

    const { status, body, position } = await report(ctx, reportOf(task));

    expect({ status, body }).toEqual({ status: 200, body: { applied: true } });
    expect(position).toEqual(expect.stringMatching(/^communications=\d+$/));
    expect(storedRow(ctx, task)?.status).toBe('done');
    expect(storedRow(ctx, queuedTask(ctx, REMINDER_QUEUE))?.status).toBe('scheduled');
    const writers = ctx.db.transactions.slice(mark).filter((tx) => tx.statements.some((s) => WRITE_STATEMENT.test(s.text)));
    expect(writers.map((tx) => [tx.tenantId, tx.outcome])).toEqual([[TENANT_A.tenantId, 'commit']]);
    expect(writesSince(ctx, mark)).toEqual([
      expect.stringMatching(new RegExp(`^UPDATE ${tableRef(ctx, SCHEDULED_TASK.table)} SET "?status"? `, 'i')),
      expect.stringMatching(new RegExp(`^INSERT INTO ${tableRef(ctx, 'changelog')} `, 'i')),
    ]);
    expect(ctx.db.rows('changelog').at(-1)).toMatchObject({ table: SCHEDULED_TASK.table, op: 'update', actor_service: 'surveys' });
    expect(ctx.taskPort.deleted).toEqual([]);
  });

  it('lists the run launch task done beside its still scheduled reminder', async () => {
    const ctx = await scheduled(1);
    expect((await report(ctx, reportOf(queuedTask(ctx, LAUNCH_QUEUE)))).status).toBe(200);
    const userToken = await mintUserToken({ sub: SAMPLE_IDS.userId, site: TENANT_A.siteId, roles: ['system-user', 'surveys.manager'] });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `${SCHEDULED_TASKS_PATH}?sourceType=survey&sourceId=${SURVEY_ID}`,
      headers: { ...(await headersFor('service:surveys')), authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: { kind: string; status: string }[] }).items.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'survey-launch', status: 'done' },
      { kind: 'survey-reminder', status: 'scheduled' },
    ]);
  });

  it.each<[string, ScheduledTaskStatus, (ctx: TestApp, task: CreateTaskInput) => Promise<unknown>]>([
    ['already done', 'done', (ctx, task) => report(ctx, reportOf(task))],
    ['superseded by schedule version 2', 'superseded', (ctx) =>
      pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(2)))],
    ['cancelled', 'cancelled', (ctx, task) => setStatus(ctx, task, 'cancelled')],
  ])('answers a launch task %s applied false and writes nothing', async (_case, stored, setup) => {
    const ctx = await scheduled(1);
    const task = queuedTask(ctx, LAUNCH_QUEUE);
    await setup(ctx, task);
    const mark = ctx.db.transactions.length;

    const { status, body, position } = await report(ctx, reportOf(task));

    expect({ status, body, position }).toEqual({ status: 200, body: { applied: false }, position: undefined });
    expect(writesSince(ctx, mark)).toEqual([]);
    expect(storedRow(ctx, task)?.status).toBe(stored);
  });

  it.each<[string, (launch: CreateTaskInput, reminder: CreateTaskInput) => { body: Body; surveyId?: string }]>([
    ["another tenant's body", (launch) => ({ body: reportOf(launch, { tenantId: TENANT_B.tenantId }) })],
    ['a tenant without a registry entry', (launch) => ({ body: reportOf(launch, { tenantId: UNREGISTERED_TENANT }) })],
    ["another survey's path", (launch) => ({ body: reportOf(launch), surveyId: OTHER_SURVEY_ID })],
    ['another schedule version', (launch) => ({ body: reportOf(launch, { scheduleVersion: 2 }) })],
    ['an unknown queue task name', (launch) => ({ body: reportOf(launch, { queueTaskName: `${launch.name}-x` }) })],
    ["the reminder task's queue task name", (launch, reminder) => ({ body: reportOf(launch, { queueTaskName: reminder.name }) })],
  ])('answers the legacy 404 without a write for %s', async (_case, build) => {
    const ctx = await scheduled(1);
    const launch = queuedTask(ctx, LAUNCH_QUEUE);
    const { body: payload, surveyId } = build(launch, queuedTask(ctx, REMINDER_QUEUE));
    const mark = ctx.db.transactions.length;

    const { status, body } = await report(ctx, payload, surveyId);

    expect(status).toBe(404);
    expect(body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(writesSince(ctx, mark)).toEqual([]);
    expect(storedRow(ctx, launch)?.status).toBe('scheduled');
  });

  it.each<[string, (launch: CreateTaskInput) => { body: unknown; surveyId?: string }]>([
    ['no schedule version', (launch) => ({ body: { tenantId: TENANT_A.tenantId, queueTaskName: launch.name } })],
    ['a schedule version of 0', (launch) => ({ body: reportOf(launch, { scheduleVersion: 0 }) })],
    ['an extra property', (launch) => ({ body: reportOf(launch, { siteId: TENANT_A.siteId }) })],
    ['a tenant that is not a UUID', (launch) => ({ body: reportOf(launch, { tenantId: TENANT_A.siteId }) })],
    ['a queue task name outside the task-id charset', (launch) => ({ body: reportOf(launch, { queueTaskName: `queues/${launch.name}` }) })],
    ['a survey id that is not a CF UUID', (launch) => ({ body: reportOf(launch), surveyId: 'not-a-survey' })],
    ['an array body', () => ({ body: [] })],
  ])('rejects %s as invalidParameters before any transaction', async (_case, build) => {
    const ctx = await scheduled(1);
    const launch = queuedTask(ctx, LAUNCH_QUEUE);
    const { body: payload, surveyId } = build(launch);
    const mark = ctx.db.transactions.length;

    const { status, body } = await report(ctx, payload, surveyId);

    expect({ status, body }).toEqual({ status: 400, body: INVALID_PARAMETERS });
    expect(ctx.db.transactions.slice(mark)).toEqual([]);
    expect(storedRow(ctx, launch)?.status).toBe('scheduled');
  });

  it.each<[string, (ctx: TestApp) => void]>([
    ['the row gate stays closed past its budget', (ctx) => ctx.db.setGate(GATE, 'closed')],
    ['the row unit is legacy-authoritative', (ctx) => ctx.db.setGate(GATE, 'legacy')],
    ['a write window executes on the row unit', (ctx) => ctx.db.setGate(GATE, 'closed', 'executing')],
  ])('answers the legacy 503 while %s, then records the task on the retry', async (_case, fail) => {
    const ctx = await scheduled(1);
    const task = queuedTask(ctx, LAUNCH_QUEUE);
    fail(ctx);

    const blocked = await withSteppedClock(() => report(ctx, reportOf(task)));

    expect({ status: blocked.status, body: blocked.body }).toEqual(UNAVAILABLE);
    expect(storedRow(ctx, task)?.status).toBe('scheduled');

    ctx.db.setGate(GATE, 'open');
    const retried = await report(ctx, reportOf(task));

    expect({ status: retried.status, body: retried.body }).toEqual({ status: 200, body: { applied: true } });
    expect(storedRow(ctx, task)?.status).toBe('done');
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('markSurveyLaunchTaskDone against PostgreSQL concurrency', () => {
  let schema!: ThrowawaySchema;
  let ctx!: TestApp<TenantDb>;
  let surveys = 0;

  beforeAll(async () => {
    schema = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    ctx = await buildTestApp({ db: schema.app });
    // The app's start-up ensures every gate as `legacy`; the route's only gated unit must accept target writes.
    const gate = await schema.adminPool.query(
      `UPDATE ${schema.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = $1`,
      [GATE],
    );
    expect(gate.rowCount).toBe(1);
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  /** The committed tenant-a launch row of `surveyId`. */
  async function storedLaunch(surveyId: string): Promise<ScheduledTaskRow | undefined> {
    return withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<ScheduledTaskRow>(
        `SELECT * FROM ${schema.schema}.${SCHEDULED_TASK.table} WHERE source_id = $1 AND kind = 'survey-launch'`,
        [surveyId],
      );
      return rows[0];
    });
  }

  /** Delivers schedule version 1 of a survey of its own; returns the survey id and its launch row. */
  async function scheduledLaunch(): Promise<{ surveyId: string; row: ScheduledTaskRow }> {
    surveys += 1;
    const surveyId = `E5F6A7B8-0006-4000-8000${String(surveys).padStart(12, '0')}`;
    const res = await pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1, { surveyId })));
    expect(res.statusCode, res.body).toBe(204);
    const row = await storedLaunch(surveyId);
    if (row === undefined) throw new TypeError(`schedule version 1 of ${surveyId} stored no launch row`);
    return { surveyId, row };
  }

  /** Surveys' report that the launch task of `row` ran. */
  function reportFor(row: ScheduledTaskRow): Body {
    return { tenantId: TENANT_A.tenantId, queueTaskName: row.queue_task_name, scheduleVersion: row.schedule_version };
  }

  /** Tenant-a changelog rows of the scheduled-task table. */
  async function taskAudits(): Promise<number> {
    return withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM ${schema.schema}.changelog WHERE "table" = $1`,
        [SCHEDULED_TASK.table],
      );
      return rows[0]?.n ?? 0;
    });
  }

  /** Waits until `count` sessions wait on a lock in a statement naming this schema. */
  async function lockWaiters(count: number): Promise<void> {
    await vi.waitFor(
      async () => {
        const { rows } = await schema.adminPool.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND position($1 in query) > 0",
          [schema.schema],
        );
        expect(rows[0]?.n).toBe(count);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  it.each<[string, ScheduledTaskStatus]>([
    ['cancellation', 'cancelled'],
    ['supersede', 'superseded'],
  ])('answers applied false and keeps a %s that commits while the completion waits on the row', async (_case, competing) => {
    const { surveyId, row } = await scheduledLaunch();
    const repository = createCommunicationsRepository({ clock: ctx.clock, schema: schema.schema });
    const audited = await taskAudits();

    const { pending } = await withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      await repository.setScheduledTaskStatus(tx, row.scheduled_task_id, competing, { origin: 'target' });
      const completion = report(ctx, reportFor(row), surveyId);
      await lockWaiters(1);
      return { pending: completion };
    });
    const { status, body, position } = await pending;

    expect({ status, body, position }).toEqual({ status: 200, body: { applied: false }, position: undefined });
    expect((await storedLaunch(surveyId))?.status).toBe(competing);
    expect(await taskAudits()).toBe(audited + 1);
  });

  it('applies one of two concurrent completions and answers the other applied false without a write', async () => {
    const { surveyId, row } = await scheduledLaunch();
    const payload = reportFor(row);
    const audited = await taskAudits();

    // The row stays locked until both completions wait on it, so they contend for it.
    const { pending } = await withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      await tx.query(`SELECT 1 FROM ${schema.schema}.${SCHEDULED_TASK.table} WHERE scheduled_task_id = $1 FOR UPDATE`, [
        row.scheduled_task_id,
      ]);
      const completions = Promise.all([report(ctx, payload, surveyId), report(ctx, payload, surveyId)]);
      await lockWaiters(2);
      return { pending: completions };
    });
    const replies = await pending;

    expect(replies.map(({ status }) => status)).toEqual([200, 200]);
    expect(replies.map(({ body }) => body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { applied: false },
      { applied: true },
    ]);
    expect((await storedLaunch(surveyId))?.status).toBe('done');
    expect(await taskAudits()).toBe(audited + 1);
  });
});
