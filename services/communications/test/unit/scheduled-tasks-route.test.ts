// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listScheduledTasks` over a throwaway `communications` schema: contract shape, the streamed whole list, paging, name filter, tenant isolation, caller denials, query validation and read gates. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { GATE_WAIT_MS, closeGates, ensureUnitGates, openGates, setGatePhase } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { listScheduledTaskPage, type ScheduledTaskPageKey, type ScheduledTaskViewRow } from '../../src/repo/queries.js';
import {
  MAX_SCHEDULED_TASK_PAGE_SIZE,
  MAX_TASK_NAMES,
  SCHEDULED_TASKS_PATH,
  encodePageKey,
  registerScheduledTaskRoutes,
  toScheduledTask,
  toScheduledTaskList,
} from '../../src/routes/scheduled-tasks.js';
import { UNITS, type ScheduledTaskRow } from '../../src/repo/tables.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const SERVICE = 'communications';
const TASK_UNIT = 'communications.scheduled_task';
const USER_ID = '7D3E1F20-4B5A-4C6D-8E9F0A1B2C3D4E5F';
const SURVEY_ID = '11111111-2222-3333-4444555566667777';
const OTHER_SURVEY_ID = '99999999-2222-3333-4444555566667777';
/** A source with more tasks than two batches of the unpaged list hold. */
const CROWDED_SURVEY_ID = '22222222-2222-3333-4444555566667777';
const CROWDED_TASKS = 2 * MAX_SCHEDULED_TASK_PAGE_SIZE + 1;
const T0 = new Date(2026, 5, 30, 9, 0, 0);

interface TaskSeed {
  id: number;
  kind?: 'survey-launch' | 'survey-reminder';
  n?: number;
  version: number;
  status?: string;
  minutes: number;
  sourceId?: string;
}

/** CF-format id whose sort order follows `n`. */
function cfId(n: number): string {
  return `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
}

/** Local time `minutes` after T0. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** Inserts one scheduled-task row in the transaction's tenant. */
async function insertTask(handle: ThrowawaySchema, tx: TenantTx, seed: TaskSeed): Promise<void> {
  const kind = seed.kind ?? 'survey-reminder';
  const sourceId = seed.sourceId ?? SURVEY_ID;
  const name = kind === 'survey-launch' ? 'launch' : `reminder-${seed.n ?? 1}`;
  await tx.query(
    `INSERT INTO ${handle.schema}.scheduled_task (tenant_id, scheduled_task_id, task_name, queue, queue_task_name, kind, source_type,
       source_id, reminder_n, schedule_time, status, target_route, schedule_version, origin, enqueued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'survey', $7, $8, $9, $10, $11, $12, 'event', $13, $13, $13)`,
    [
      tx.tenantId,
      cfId(seed.id),
      `opt2-survey-${sourceId}-${name}`,
      kind === 'survey-launch' ? 'surveys-launch' : 'communications-reminders',
      `opt2-survey-${sourceId}-${name}-v${seed.version}`,
      kind,
      sourceId,
      kind === 'survey-launch' ? null : (seed.n ?? 1),
      at(seed.minutes),
      seed.status ?? 'scheduled',
      kind === 'survey-launch' ? '/internal/v1/tasks/surveys/launch' : '/internal/v1/tasks/reminders',
      seed.version,
      T0,
    ],
  );
}

/** One `listScheduledTasks` answer. */
interface ListedTasks {
  sourceId: string;
  scheduleVersion: number | null;
  items: Array<{ taskName: string }>;
  next: string | null;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Task name `suffix` of the survey. */
function taskName(suffix: string, sourceId: string = SURVEY_ID): string {
  return `opt2-survey-${sourceId}-${suffix}`;
}

/** The `taskName` query parameters of `names`, one per name. */
function taskNameQuery(names: readonly string[]): string {
  return names.map((name) => `&taskName=${name}`).join('');
}

/** The `after` cursor of the version-2 launch's page key, with `over` replacing its JSON properties. */
function tamperedKey(over: Record<string, unknown>): string {
  return base64url(JSON.stringify({ version: 2, at: at(60).getTime(), kind: 'survey-launch', n: null, id: cfId(11), ...over }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!(await pgAvailable()))('listScheduledTasks', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let app: FastifyInstance;
  let transactions = 0;
  let failingTransaction = 0;

  /** The surveys invocation credential plus a user token of `site`, as surveys' service client sends them. */
  async function surveysHeaders(site: string = TENANT_A.siteId, caller = 'surveys'): Promise<Record<string, string>> {
    const [user, invocation] = await Promise.all([
      mintUserToken({ sub: USER_ID, site, roles: [Roles.surveysManager] }),
      mintServiceToken({ caller, audience: SERVICE }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
  }

  /** The body the list answered while it read every batch in one transaction and sent the whole object. */
  async function bufferedBody(sourceId: string, taskNames?: readonly string[], tenantId: string = TENANT_A.tenantId): Promise<string> {
    const source = { sourceType: 'survey' as const, sourceId };
    const rows = await handle.app.withTenant(tenantId, async (tx) => {
      const read: ScheduledTaskViewRow[] = [];
      let after: ScheduledTaskPageKey | undefined;
      do {
        const page = await listScheduledTaskPage(tx, source, { limit: MAX_SCHEDULED_TASK_PAGE_SIZE, after, taskNames });
        read.push(...page.rows);
        after = page.next ?? undefined;
      } while (after !== undefined);
      return read;
    });
    return JSON.stringify(toScheduledTaskList(source, rows, null));
  }

  /** Every page of `query` at `limit`, following each page's `next`. */
  async function walk(query: string, limit: number): Promise<ListedTasks[]> {
    const headers = await surveysHeaders();
    const pages: ListedTasks[] = [];
    let after = '';
    do {
      const res = await list(headers, `${query}&limit=${limit}${after === '' ? '' : `&after=${after}`}`);
      expect(res.statusCode, res.body).toBe(200);
      pages.push(res.json() as ListedTasks);
      after = pages.at(-1)?.next ?? '';
    } while (after !== '' && pages.length < 10);
    return pages;
  }

  /** Lists `query` and checks the answer against the contract. */
  async function list(headers: Record<string, string>, query: string = `sourceType=survey&sourceId=${SURVEY_ID}`) {
    const res = await app.inject({ method: 'GET', url: `${SCHEDULED_TASKS_PATH}?${query}`, headers });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: SCHEDULED_TASKS_PATH,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await insertTask(handle, tx, { id: 1, kind: 'survey-launch', version: 1, status: 'superseded', minutes: 30 });
      await insertTask(handle, tx, { id: 2, n: 1, version: 1, status: 'superseded', minutes: 40 });
      await insertTask(handle, tx, { id: 13, n: 2, version: 2, minutes: 80 });
      await insertTask(handle, tx, { id: 12, n: 1, version: 2, status: 'done', minutes: 70 });
      await insertTask(handle, tx, { id: 11, kind: 'survey-launch', version: 2, status: 'done', minutes: 60 });
      await insertTask(handle, tx, { id: 14, n: 3, version: 2, status: 'cancelled', minutes: 90 });
      await insertTask(handle, tx, { id: 20, kind: 'survey-launch', version: 1, minutes: 60, sourceId: OTHER_SURVEY_ID });
    });
    await handle.app.withTenant(TENANT_B.tenantId, (tx) =>
      insertTask(handle, tx, { id: 31, kind: 'survey-launch', version: 5, minutes: 120 }),
    );
    // Reminders 1 to CROWDED_TASKS at seven distinct times, every fifth one done and every eleventh one superseded.
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.scheduled_task (tenant_id, scheduled_task_id, task_name, queue, queue_task_name, kind, source_type,
           source_id, reminder_n, schedule_time, status, target_route, schedule_version, origin, enqueued_at, created_at, updated_at)
         SELECT $1, lpad(n::text, 8, '0') || '-CCCC-BBBB-CCCCDDDDEEEEFFFF', 'opt2-survey-' || $2 || '-reminder-' || n,
           'communications-reminders', 'opt2-survey-' || $2 || '-reminder-' || n || '-v1', 'survey-reminder', 'survey', $2, n,
           $3::timestamp + (n % 7) * interval '1 minute', CASE WHEN n % 11 = 0 THEN 'superseded' WHEN n % 5 = 0 THEN 'done' ELSE 'scheduled' END,
           '/internal/v1/tasks/reminders', 1, 'event', $3, $3, $3
         FROM generate_series(1, $4::integer) AS n`,
        [tx.tenantId, CROWDED_SURVEY_ID, T0, CROWDED_TASKS + Math.floor(CROWDED_TASKS / 10)],
      ),
    );

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-communications-scheduled-tasks-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => {
        transactions += 1;
        if (transactions === failingTransaction) return Promise.reject(new Error('batch read failed'));
        return handle.app.withTenant(tenantId, fn);
      },
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerScheduledTaskRoutes(app, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('declares the contract operation', () => {
    const operation = OPENAPI.paths[SCHEDULED_TASKS_PATH]?.get ?? {};
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === SCHEDULED_TASKS_PATH);
    expect(declared).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: SCHEDULED_TASKS_PATH,
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it("lists the current schedule version of the token tenant's source, superseded rows and other sources excluded", async () => {
    const res = await list(await surveysHeaders());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sourceType: 'survey',
      sourceId: SURVEY_ID,
      scheduleVersion: 2,
      items: [
        {
          taskName: `opt2-survey-${SURVEY_ID}-launch`,
          kind: 'survey-launch',
          n: null,
          targetRoute: '/internal/v1/tasks/surveys/launch',
          scheduleTime: '2026-06-30T10:00:00.000',
          status: 'done',
          scheduleVersion: 2,
          queue: 'surveys-launch',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-1`,
          kind: 'survey-reminder',
          n: 1,
          targetRoute: '/internal/v1/tasks/reminders',
          scheduleTime: '2026-06-30T10:10:00.000',
          status: 'done',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-2`,
          kind: 'survey-reminder',
          n: 2,
          targetRoute: '/internal/v1/tasks/reminders',
          scheduleTime: '2026-06-30T10:20:00.000',
          status: 'scheduled',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-3`,
          kind: 'survey-reminder',
          n: 3,
          targetRoute: '/internal/v1/tasks/reminders',
          scheduleTime: '2026-06-30T10:30:00.000',
          status: 'cancelled',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
      ],
      next: null,
    });
  });

  it.each<[string, string, string[] | undefined, number, number]>([
    ['a source never scheduled', cfId(99), undefined, 0, 1],
    ['one batch', SURVEY_ID, undefined, 4, 1],
    [`${CROWDED_TASKS} tasks, three batches`, CROWDED_SURVEY_ID, undefined, CROWDED_TASKS, 3],
    ['two named tasks', SURVEY_ID, [taskName('reminder-3'), taskName('launch')], 2, 1],
    ['a name no task has', SURVEY_ID, [taskName('reminder-9')], 0, 1],
  ])('streams the unpaged list of %s byte for byte as the buffered answer, one transaction a batch', async (_case, sourceId, names, count, batches) => {
    const expected = await bufferedBody(sourceId, names);
    const headers = await surveysHeaders();
    transactions = 0;

    const res = await list(headers, `sourceType=survey&sourceId=${sourceId}${taskNameQuery(names ?? [])}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.rawPayload.equals(Buffer.from(expected, 'utf8'))).toBe(true);
    expect((res.json() as ListedTasks).items).toHaveLength(count);
    expect(transactions).toBe(batches);
  });

  it.each<[string, number, string[]]>([
    ['the launch', 1, ['launch']],
    ['two reminders', 1, ['reminder-1', 'reminder-3']],
    ['a launch and two reminders, unordered', 2, ['reminder-3', 'launch', 'reminder-2']],
    [`${MAX_TASK_NAMES} names`, 2, Array.from({ length: MAX_TASK_NAMES }, (_, i) => `reminder-${i + 1}`)],
  ])('pages through only %s at limit %i, as the unpaged list holds them', async (_case, limit, suffixes) => {
    const names = suffixes.map((suffix) => taskName(suffix));
    const whole = (await list(await surveysHeaders())).json() as ListedTasks;

    const pages = await walk(`sourceType=survey&sourceId=${SURVEY_ID}${taskNameQuery(names)}`, limit);

    expect(pages.flatMap((page) => page.items)).toEqual(whole.items.filter((item) => names.includes(item.taskName)));
    expect(pages.every((page) => page.scheduleVersion === 2 && page.items.length <= limit)).toBe(true);
    expect(pages.at(-1)?.next).toBeNull();
  });

  it('breaks off the streamed list when a later batch fails, rather than ending it as complete JSON', async () => {
    const headers = await surveysHeaders();
    transactions = 0;
    failingTransaction = 2;
    try {
      const answer = app.inject({ method: 'GET', url: `${SCHEDULED_TASKS_PATH}?sourceType=survey&sourceId=${CROWDED_SURVEY_ID}`, headers });

      await expect(answer).rejects.toThrow(/destroyed before completion/);
      expect(transactions).toBe(2);
    } finally {
      failingTransaction = 0;
    }
  });

  it.each([1, 2, 3, 4])('pages through the unpaged list in its order with limit %i', async (limit) => {
    const headers = await surveysHeaders();
    const unpaged = (await list(headers)).json() as ListedTasks;
    const pages: ListedTasks[] = [];
    let after = '';
    do {
      const res = await list(headers, `sourceType=survey&sourceId=${SURVEY_ID}&limit=${limit}${after === '' ? '' : `&after=${after}`}`);
      expect(res.statusCode).toBe(200);
      pages.push(res.json() as ListedTasks);
      after = pages.at(-1)?.next ?? '';
    } while (after !== '' && pages.length < 10);

    expect(pages.flatMap((page) => page.items)).toEqual(unpaged.items);
    expect(pages.map((page) => page.items.length)).toEqual(Array.from({ length: Math.ceil(4 / limit) }, (_, i) => Math.min(limit, 4 - i * limit)));
    expect(pages.every((page) => page.scheduleVersion === 2 && page.sourceId === SURVEY_ID)).toBe(true);
    expect(pages.slice(0, -1).every((page) => typeof page.next === 'string' && /^[A-Za-z0-9_-]+$/.test(page.next))).toBe(true);
    expect(pages.at(-1)?.next).toBeNull();
  });

  it('pages 100 tasks when only after is sent', async () => {
    const headers = await surveysHeaders();
    const first = (await list(headers, `sourceType=survey&sourceId=${SURVEY_ID}&limit=1`)).json() as ListedTasks;

    const rest = (await list(headers, `sourceType=survey&sourceId=${SURVEY_ID}&after=${first.next ?? ''}`)).json() as ListedTasks;

    expect(rest.items.map((item) => item.taskName)).toEqual([1, 2, 3].map((n) => `opt2-survey-${SURVEY_ID}-reminder-${n}`));
    expect(rest.next).toBeNull();
  });

  it("keeps the key's schedule version on a page past the last task", async () => {
    const after = encodePageKey({ version: 2, at: at(90), kind: 'survey-reminder', n: 3, id: cfId(14) });

    const res = await list(await surveysHeaders(), `sourceType=survey&sourceId=${SURVEY_ID}&after=${after}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sourceType: 'survey', sourceId: SURVEY_ID, scheduleVersion: 2, items: [], next: null });
  });

  it.each([
    ['reads only tenant-b rows for a tenant-b token', TENANT_B.siteId, SURVEY_ID, 5, [`opt2-survey-${SURVEY_ID}-launch`]],
    ['answers a null version and no items for a source never scheduled', TENANT_A.siteId, cfId(99), null, []],
    ['answers no item for a source of another tenant', TENANT_B.siteId, OTHER_SURVEY_ID, null, []],
  ])('%s', async (_label, site, sourceId, scheduleVersion, taskNames) => {
    const res = await list(await surveysHeaders(site), `sourceType=survey&sourceId=${sourceId}`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as ListedTasks;
    expect(body).toMatchObject({ sourceId, scheduleVersion, next: null });
    expect(body.items.map((item) => item.taskName)).toEqual(taskNames);
  });

  it.each([
    ['no user token', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'surveys', audience: SERVICE })}` }), 401],
    ['no invocation credential', async () => ({ authorization: (await surveysHeaders()).authorization ?? '' }), 401],
    ['the people service', () => surveysHeaders(TENANT_A.siteId, 'people'), 403],
    ['the migration service', () => surveysHeaders(TENANT_A.siteId, 'migration'), 403],
    ['the gateway', () => surveysHeaders(TENANT_A.siteId, 'gateway'), 403],
    ['a managed Cloud Tasks credential', async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` }), 401],
    ['the tasks invoker as invocation credential', () => surveysHeaders(TENANT_A.siteId, 'tasks-invoker'), 401],
  ])('denies a call with %s', async (_label, headers, status) => {
    const res = await list(await headers());

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each([
    ['an unknown sourceType', `sourceType=message&sourceId=${SURVEY_ID}`],
    ['no sourceType', `sourceId=${SURVEY_ID}`],
    ['no sourceId', 'sourceType=survey'],
    ['a sourceId that is not a CF UUID', 'sourceType=survey&sourceId=not-a-survey'],
    ['a repeated sourceId', `sourceType=survey&sourceId=${SURVEY_ID}&sourceId=${SURVEY_ID}`],
    ...[
      ['a zero limit', 'limit=0'],
      ['a limit above 1000', 'limit=1001'],
      ['a limit with a leading zero', 'limit=01'],
      ['a non-numeric limit', 'limit=ten'],
      ['an empty limit', 'limit='],
      ['a repeated limit', 'limit=2&limit=3'],
      ['an after outside base64url', 'after=a%2Bb'],
      ['an after that is not JSON', `after=${base64url('not json')}`],
      ['an after of another shape', `after=${base64url(JSON.stringify({ offset: 2 }))}`],
      ['an after with an extra property', `after=${tamperedKey({ extra: true })}`],
      ['an after with a fractional time', `after=${tamperedKey({ at: 1.5 })}`],
      ['an after before any PostgreSQL timestamp', `after=${tamperedKey({ at: -210_866_803_200_001 })}`],
      ['an after past any JavaScript date', `after=${tamperedKey({ at: 8_640_000_000_000_001 })}`],
      ['an after with ordinal 0', `after=${tamperedKey({ n: 0 })}`],
      ['an after with an unknown kind', `after=${tamperedKey({ kind: 'survey-close' })}`],
      ['an after with an id that is not a CF UUID', `after=${tamperedKey({ id: 'nope' })}`],
      ['a taskName outside ScheduledTaskName', 'taskName=launch'],
      ['a taskName with reminder ordinal 0', `taskName=${taskName('reminder-0')}`],
      ['a taskName with a lower-case id', `taskName=${taskName('launch', 'aaaaaaaa-2222-3333-4444555566667777')}`],
      ['an empty taskName', 'taskName='],
      ['a taskName over 100 characters', `taskName=${taskName(`reminder-${'1'.repeat(60)}`)}`],
      [
        `more than ${MAX_TASK_NAMES} taskName values`,
        taskNameQuery(Array.from({ length: MAX_TASK_NAMES + 1 }, (_, i) => taskName(`reminder-${i + 1}`))).slice(1),
      ],
    ].map(([label, page]) => [label, `sourceType=survey&sourceId=${SURVEY_ID}&${page}`]),
  ])('rejects %s with the legacy 400', async (_label, query) => {
    const res = await list(await surveysHeaders(), query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  it('answers once a window on scheduled_task leaves its executing phase', async () => {
    const headers = await surveysHeaders();
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: [TASK_UNIT], holderId, phase: 'executing', allowLegacy: true });
    try {
      const started = Date.now();
      const pending = list(headers);
      await sleep(300);
      await setGatePhase(handle.app, { units: [TASK_UNIT], holderId, phase: 'quiet' });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      await openGates(handle.app, { units: [TASK_UNIT], holderId, state: 'legacy' });
    }
  });

  it('answers the legacy 503 when a window import holds scheduled_task past the gate budget', async () => {
    const headers = await surveysHeaders();
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: [TASK_UNIT], holderId, phase: 'importing', allowLegacy: true });
    // Only Date is faked, so the gate's 30 s budget elapses in steps while its polls and the database run in real time.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const started = Date.now();
      let settled = false;
      const pending = list(headers).finally(() => {
        settled = true;
      });
      while (!settled) {
        await sleep(25);
        vi.setSystemTime(Date.now() + 1_000);
      }
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(Date.now() - started).toBeGreaterThanOrEqual(GATE_WAIT_MS);
    } finally {
      vi.useRealTimers();
      await openGates(handle.app, { units: [TASK_UNIT], holderId, state: 'legacy' });
    }
  });
});

describe('toScheduledTask', () => {
  it('exposes only the contract properties of a row', () => {
    const row: ScheduledTaskRow = {
      tenant_id: TENANT_A.tenantId,
      scheduled_task_id: cfId(7),
      task_name: `opt2-survey-${SURVEY_ID}-reminder-4`,
      queue: 'communications-reminders',
      queue_task_name: `opt2-survey-${SURVEY_ID}-reminder-4-v3`,
      kind: 'survey-reminder',
      source_type: 'survey',
      source_id: SURVEY_ID,
      reminder_n: 4,
      schedule_time: new Date(2026, 6, 1, 8, 5, 9, 42),
      status: 'scheduled',
      target_route: '/internal/v1/tasks/reminders',
      schedule_version: 3,
      origin: 'adopted',
      enqueued_at: null,
      dequeued_at: null,
      created_at: T0,
      updated_at: T0,
    };

    expect(toScheduledTask(row)).toStrictEqual({
      taskName: `opt2-survey-${SURVEY_ID}-reminder-4`,
      kind: 'survey-reminder',
      n: 4,
      targetRoute: '/internal/v1/tasks/reminders',
      scheduleTime: '2026-07-01T08:05:09.042',
      status: 'scheduled',
      scheduleVersion: 3,
      queue: 'communications-reminders',
    });
  });
});
