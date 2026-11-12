// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listScheduledTasks` over a throwaway `communications` schema: contract shape, tenant isolation, caller denials, query validation and read gates. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { SCHEDULED_TASKS_PATH, registerScheduledTaskRoutes, toScheduledTask } from '../../src/routes/scheduled-tasks.js';
import { UNITS, type ScheduledTaskRow } from '../../src/repo/tables.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const SERVICE = 'communications';
const TASK_UNIT = 'communications.scheduled_task';
const USER_ID = '7D3E1F20-4B5A-4C6D-8E9F0A1B2C3D4E5F';
const SURVEY_ID = '11111111-2222-3333-4444555566667777';
const OTHER_SURVEY_ID = '99999999-2222-3333-4444555566667777';
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
      kind === 'survey-launch' ? `/internal/v1/tasks/surveys/${sourceId}/launch` : `/internal/v1/tasks/reminders/${cfId(seed.id)}`,
      seed.version,
      T0,
    ],
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!(await pgAvailable()))('listScheduledTasks', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let app: FastifyInstance;

  /** The surveys invocation credential plus a user token of `site`, as surveys' service client sends them. */
  async function surveysHeaders(site: string = TENANT_A.siteId, caller = 'surveys'): Promise<Record<string, string>> {
    const [user, invocation] = await Promise.all([
      mintUserToken({ sub: USER_ID, site, roles: [Roles.surveysManager] }),
      mintServiceToken({ caller, audience: SERVICE }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
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

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-communications-scheduled-tasks-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
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
          targetRoute: `/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
          scheduleTime: '2026-06-30T10:00:00.000',
          status: 'done',
          scheduleVersion: 2,
          queue: 'surveys-launch',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-1`,
          kind: 'survey-reminder',
          n: 1,
          targetRoute: `/internal/v1/tasks/reminders/${cfId(12)}`,
          scheduleTime: '2026-06-30T10:10:00.000',
          status: 'done',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-2`,
          kind: 'survey-reminder',
          n: 2,
          targetRoute: `/internal/v1/tasks/reminders/${cfId(13)}`,
          scheduleTime: '2026-06-30T10:20:00.000',
          status: 'scheduled',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
        {
          taskName: `opt2-survey-${SURVEY_ID}-reminder-3`,
          kind: 'survey-reminder',
          n: 3,
          targetRoute: `/internal/v1/tasks/reminders/${cfId(14)}`,
          scheduleTime: '2026-06-30T10:30:00.000',
          status: 'cancelled',
          scheduleVersion: 2,
          queue: 'communications-reminders',
        },
      ],
    });
  });

  it.each([
    ['reads only tenant-b rows for a tenant-b token', TENANT_B.siteId, SURVEY_ID, 5, [`opt2-survey-${SURVEY_ID}-launch`]],
    ['answers a null version and no items for a source never scheduled', TENANT_A.siteId, cfId(99), null, []],
    ['answers no item for a source of another tenant', TENANT_B.siteId, OTHER_SURVEY_ID, null, []],
  ])('%s', async (_label, site, sourceId, scheduleVersion, taskNames) => {
    const res = await list(await surveysHeaders(site), `sourceType=survey&sourceId=${sourceId}`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { sourceId: string; scheduleVersion: number | null; items: Array<{ taskName: string }> };
    expect(body).toMatchObject({ sourceId, scheduleVersion });
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
      target_route: `/internal/v1/tasks/reminders/${cfId(7)}`,
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
      targetRoute: `/internal/v1/tasks/reminders/${cfId(7)}`,
      scheduleTime: '2026-07-01T08:05:09.042',
      status: 'scheduled',
      scheduleVersion: 3,
      queue: 'communications-reminders',
    });
  });
});
