// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listScheduledTasks` over the in-memory app after surveys' schedule versions 1 and 2 arrive through the push route. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyErrorResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, mintServiceToken, pushTo } from '@opt2/platform/testing';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import type { ScheduledTaskRow } from '../../src/repo/tables.js';
import { SCHEDULED_TASKS_PATH } from '../../src/routes/scheduled-tasks.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const SERVICE = 'communications';
const SURVEY_ID = 'E7F8A9B0-0007-4000-8000000000000007';
const UNKNOWN_SURVEY_ID = 'E7F8A9B0-0007-4000-8000000000000099';
const TASK_BASE = `opt2-survey-${SURVEY_ID}-`;
const LIST_QUERY = `sourceType=survey&sourceId=${SURVEY_ID}`;
// The header a service caller's invocation credential travels in, as headersFor presents it.
const INVOCATION_HEADER = Object.keys(await headersFor('service:surveys'))[0] ?? '';

// Version 2 of surveyScheduledPayload: launch 2026-07-02T09:00, reminders 120 and 1440 minutes later.
const V2_TASKS = [
  { taskName: `${TASK_BASE}launch`, kind: 'survey-launch', n: null, scheduleTime: '2026-07-02T09:00:00.000', queue: 'surveys-launch' },
  { taskName: `${TASK_BASE}reminder-1`, kind: 'survey-reminder', n: 1, scheduleTime: '2026-07-02T11:00:00.000', queue: 'communications-reminders' },
  { taskName: `${TASK_BASE}reminder-2`, kind: 'survey-reminder', n: 2, scheduleTime: '2026-07-03T09:00:00.000', queue: 'communications-reminders' },
] as const;

interface ListedTask {
  taskName: string;
  kind: string;
  n: number | null;
  targetRoute: string;
  scheduleTime: string;
  status: string;
  scheduleVersion: number;
  queue: string;
}

interface ListedTasks {
  sourceType: string;
  sourceId: string;
  scheduleVersion: number | null;
  items: ListedTask[];
}

/** Surveys' call: a `surveys.manager` user token of `site` beside an invocation credential of `caller`. */
async function surveysCall(opts: { site?: string; caller?: string; roles?: string[] } = {}): Promise<Record<string, string>> {
  const [user, invocation] = await Promise.all([
    headersFor('surveys.manager', { site: opts.site ?? TENANT_A.siteId }),
    mintServiceToken({ caller: opts.caller ?? 'surveys', audience: SERVICE, roles: opts.roles }),
  ]);
  return { ...user, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

describe('listScheduledTasks after schedule versions 1 and 2', () => {
  let ctx: TestApp;

  /** Lists `query`, checks the answer against the contract and returns it with the transactions it ran. */
  async function list(headers: Record<string, string>, query: string = LIST_QUERY) {
    const before = ctx.db.transactions.length;
    const res = await ctx.app.inject({ method: 'GET', url: `${SCHEDULED_TASKS_PATH}?${query}`, headers });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: SCHEDULED_TASKS_PATH,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return { res, transactions: ctx.db.transactions.slice(before) };
  }

  /** The stored rows of the survey; `version` narrows them to one schedule version. */
  function storedTasks(version?: number): ScheduledTaskRow[] {
    return (ctx.db.rows('scheduled_task') as ScheduledTaskRow[]).filter(
      (row) => row.source_id === SURVEY_ID && (version === undefined || row.schedule_version === version),
    );
  }

  beforeAll(async () => {
    ctx = await buildTestApp();
    for (const version of [1, 2] as const) {
      const envelope = envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(version, { surveyId: SURVEY_ID }));
      const res = await pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelope);
      expect(res.statusCode, `delivering schedule version ${String(version)}: ${res.body}`).toBe(204);
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('stores version 1 superseded beside version 2', () => {
    expect(storedTasks(1).map((row) => row.status)).toEqual(['superseded', 'superseded']);
    expect(storedTasks(2).map((row) => row.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
  });

  it('lists only the version 2 tasks, launch first, as stored', async () => {
    const { res } = await list(await surveysCall());

    expect(res.statusCode).toBe(200);
    const body = res.json() as ListedTasks;
    expect(body).toMatchObject({ sourceType: 'survey', sourceId: SURVEY_ID, scheduleVersion: 2 });
    const stored = storedTasks(2);
    expect(body.items).toStrictEqual(
      V2_TASKS.map((task) => {
        const row = stored.find((candidate) => candidate.task_name === task.taskName);
        expect(row, task.taskName).toBeDefined();
        return {
          ...task,
          targetRoute: row?.target_route,
          status: row?.status,
          scheduleVersion: row?.schedule_version,
        };
      }),
    );
    expect(body.items.map((item) => item.targetRoute)).toEqual([
      `/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
      ...stored.filter((row) => row.kind === 'survey-reminder').map((row) => `/internal/v1/tasks/reminders/${row.scheduled_task_id}`),
    ]);
  });

  it.each([
    ['a source never scheduled', TENANT_A.siteId, UNKNOWN_SURVEY_ID],
    ["a tenant-b token for tenant-a's survey", TENANT_B.siteId, SURVEY_ID],
  ])('answers no items for %s', async (_label, site, sourceId) => {
    const { res } = await list(await surveysCall({ site }), `sourceType=survey&sourceId=${sourceId}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ sourceType: 'survey', sourceId, scheduleVersion: null, items: [] });
  });

  it('reads in the token tenant without writing', async () => {
    const rowsBefore = ctx.db.rows('scheduled_task');
    const { res, transactions } = await list(await surveysCall());

    expect(res.statusCode).toBe(200);
    expect(transactions).toHaveLength(1);
    const [tx] = transactions;
    expect(tx).toMatchObject({ tenantId: TENANT_A.tenantId, outcome: 'commit' });
    // The read gate's savepoint fence wraps its SELECT; nothing else may run.
    for (const statement of tx?.statements ?? []) expect(statement.text).toMatch(/^(SELECT|SAVEPOINT|RELEASE SAVEPOINT)\b/);
    expect(ctx.db.rows('scheduled_task')).toEqual(rowsBefore);
  });

  it.each([
    ['no sourceId', 'sourceType=survey'],
    ['no sourceType', `sourceId=${SURVEY_ID}`],
    ['a sourceType other than survey', `sourceType=message&sourceId=${SURVEY_ID}`],
  ])('rejects %s with the legacy invalidParameters 400', async (_label, query) => {
    const expected = legacyErrorResponse('invalidParameters');
    const { res, transactions } = await list(await surveysCall(), query);

    expect(res.statusCode).toBe(expected.status);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(res.body).toBe(expected.body);
    expect(transactions).toEqual([]);
  });

  it.each([
    ['the people service', 'people', undefined],
    ['a surveys credential without service:surveys', 'surveys', []],
  ])('refuses %s with 403', async (_label, caller, roles) => {
    const { res, transactions } = await list(await surveysCall({ caller, roles }));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(transactions).toEqual([]);
  });
});
