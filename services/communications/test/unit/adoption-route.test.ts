// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Scheduler hand-off routes over a throwaway `communications` schema and an in-memory task port: contract, adoption, cancellation, denials. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { GateClosedError, ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { CreateTaskInput, CreateTaskResult, DeleteTaskResult, TaskPort } from '@opt2/platform/tasks';
import { withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { portTaskName } from '../../src/domain/survey-tasks.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import {
  ADOPT_PATH,
  CANCEL_ADOPTED_PATH,
  adoptRequestSchema,
  cancelRequestSchema,
  registerAdoptionRoutes,
  type AdoptionRouteDeps,
} from '../../src/routes/adoption.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const SERVICE = 'communications';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const SERVICE_URLS = { surveys: 'http://127.0.0.1:20017', communications: 'http://127.0.0.1:20015' };
const SURVEY_A = 'AAAAAAAA-BBBB-CCCC-DDDD000000000001';
const SURVEY_B = 'AAAAAAAA-BBBB-CCCC-DDDD000000000002';
const SURVEY_EVENT = 'AAAAAAAA-BBBB-CCCC-DDDD000000000003';
const EVENT_TASK_ID = 'EEEEEEEE-0000-0000-0000000000000001';

const LAUNCH_A = `opt2-survey-${SURVEY_A}-launch`;
const REMINDER_A1 = `opt2-survey-${SURVEY_A}-reminder-1`;
const REMINDER_A2 = `opt2-survey-${SURVEY_A}-reminder-2`;
const LAUNCH_B = `opt2-survey-${SURVEY_B}-launch`;
const LAUNCH_EVENT = `opt2-survey-${SURVEY_EVENT}-launch`;

/** In-memory task port: creates are idempotent by queue and name, deletes of absent tasks report `deleted: false`. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local' as const;
  readonly live = new Map<string, CreateTaskInput>();
  readonly creates: CreateTaskInput[] = [];
  readonly deletes: Array<{ queue: string; name: string }> = [];

  create(input: CreateTaskInput): Promise<CreateTaskResult> {
    this.creates.push(input);
    const key = `${input.queue}/${input.name}`;
    const created = !this.live.has(key);
    this.live.set(key, input);
    return Promise.resolve({ name: input.name, created });
  }

  delete(queue: string, name: string): Promise<DeleteTaskResult> {
    this.deletes.push({ queue, name });
    return Promise.resolve({ name, deleted: this.live.delete(`${queue}/${name}`) });
  }

  list(): ReturnType<TaskPort['list']> {
    return Promise.resolve({ tasks: [] });
  }

  get(): ReturnType<TaskPort['get']> {
    return Promise.resolve(undefined);
  }

  pauseQueue(): Promise<void> {
    return Promise.resolve();
  }

  resumeQueue(): Promise<void> {
    return Promise.resolve();
  }

  queueState(queue: string): ReturnType<TaskPort['queueState']> {
    return Promise.resolve({ queue, paused: false });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** One captured ACF task of the adoption body. */
function task(name: string, siteId: string, scheduleTime: string, scheduleVersion = 1) {
  return { name, siteId, scheduleTime, scheduleVersion };
}

describe('adoption request schemas', () => {
  const launch = task(LAUNCH_A, 'tenant-a', '2026-06-30T09:15:00.000');

  it.each([
    ['a launch task', { tasks: [launch] }, true],
    ['a reminder task', { tasks: [{ ...launch, name: REMINDER_A2 }] }, true],
    ['an empty task list', { tasks: [] }, true],
    ['no tasks', {}, false],
    ['a body tenant', { tasks: [launch], tenantId: TENANT_A.tenantId }, false],
    ['a task tenant', { tasks: [{ ...launch, tenantId: TENANT_A.tenantId }] }, false],
    ['a lower-case survey id', { tasks: [{ ...launch, name: LAUNCH_A.toLowerCase() }] }, false],
    ['no siteId', { tasks: [{ name: LAUNCH_A, scheduleTime: launch.scheduleTime, scheduleVersion: 1 }] }, false],
    ['no scheduleVersion', { tasks: [{ name: LAUNCH_A, siteId: 'tenant-a', scheduleTime: launch.scheduleTime }] }, false],
    ['schedule version 0', { tasks: [{ ...launch, scheduleVersion: 0 }] }, false],
    ['a fractional schedule version', { tasks: [{ ...launch, scheduleVersion: 1.5 }] }, false],
    ['a timestamp with an offset', { tasks: [{ ...launch, scheduleTime: '2026-06-30T09:15:00.000Z' }] }, false],
    ['a site id over 25 characters', { tasks: [{ ...launch, siteId: 'x'.repeat(26) }] }, false],
  ])('adopt body with %s: accepted %s', (_label, body, accepted) => {
    expect(adoptRequestSchema.safeParse(body).success).toBe(accepted);
  });

  it.each([
    ['no names', {}, true],
    ['names', { names: [LAUNCH_A, REMINDER_A1] }, true],
    ['a name outside opt2-survey-*', { names: ['siteMonitor'] }, false],
    ['an undeclared key', { all: true }, false],
    ['no body', undefined, false],
  ])('cancel body with %s: accepted %s', (_label, body, accepted) => {
    expect(cancelRequestSchema.safeParse(body).success).toBe(accepted);
  });
});

describe.skipIf(!(await pgAvailable()))('scheduler hand-off routes', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let app: FastifyInstance;
  let port: MemoryTaskPort;
  let ctx: AdoptionRouteDeps;

  /** The invocation credential of `caller`, as the migration service's client sends it without a user token. */
  async function callerHeaders(caller: string): Promise<Record<string, string>> {
    return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}` };
  }

  /** Posts `body` and checks the answer against the contract. */
  async function post(url: string, body: unknown, headers?: Record<string, string>) {
    const res = await app.inject({
      method: 'POST',
      url,
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      headers: headers ?? (await callerHeaders('migration')),
    });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'POST',
      path: url,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  /** The tenant's scheduled-task rows by task name. */
  async function rows(tenantId: string) {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows: found } = await tx.query<{
        task_name: string;
        status: string;
        origin: string;
        schedule_time: Date;
        tenant_id: string;
      }>(`SELECT task_name, status, origin, schedule_time, tenant_id FROM ${handle.schema}.scheduled_task ORDER BY task_name`);
      return found;
    });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: SERVICE,
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    // An event-scheduled launch whose queue task was never created.
    await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.scheduled_task (tenant_id, scheduled_task_id, task_name, queue, queue_task_name, kind, source_type,
           source_id, reminder_n, schedule_time, status, target_route, schedule_version, origin, enqueued_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'surveys-launch', $4, 'survey-launch', 'survey', $5, NULL, $6, 'scheduled', $7, 1, 'event', NULL, $6, $6)`,
        [tx.tenantId, EVENT_TASK_ID, LAUNCH_EVENT, portTaskName(LAUNCH_EVENT, 1), SURVEY_EVENT, NOW, `/internal/v1/tasks/surveys/${SURVEY_EVENT}/launch`],
      ),
    );

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-communications-adoption-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    const clock = fixedClock(NOW);
    const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    port = new MemoryTaskPort();
    ctx = {
      scheduleDeps: {
        db,
        repository: createCommunicationsRepository({ clock, schema: handle.schema }),
        clock,
        logger,
        taskPort: port,
        serviceUrls: SERVICE_URLS,
      },
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
        TZ: process.env.TZ ?? 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger,
    });
    await registerAdoptionRoutes(app, ctx);
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    port.creates.length = 0;
    port.deletes.length = 0;
  });

  it.each([ADOPT_PATH, CANCEL_ADOPTED_PATH])('declares the contract operation %s', (url) => {
    const operation = OPENAPI.paths[url]?.post ?? {};
    expect(collectRouteMatrix(app).routes.filter((route) => route.url === url)).toEqual([
      expect.objectContaining({
        method: 'POST',
        url,
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      }),
    ]);
  });

  it('adopts each task once in its site tenant, scheduling a passed run time at now', async () => {
    const body = {
      tasks: [
        task(LAUNCH_A, TENANT_A.siteId, '2026-06-30T09:00:00.000'),
        task(REMINDER_A1, TENANT_A.siteId, '2026-07-01T09:00:00.000'),
        task(REMINDER_A2, TENANT_A.siteId, '2026-07-02T09:00:00.000'),
        task(LAUNCH_B, TENANT_B.siteId, '2026-07-03T09:00:00.000', 3),
        task(LAUNCH_EVENT, TENANT_A.siteId, '2026-07-04T09:00:00.000'),
      ],
    };

    const first = await post(ADOPT_PATH, body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ adopted: 4, existing: 1, scheduledImmediately: 1 });
    expect(port.creates.map(({ queue, name, tenantId }) => [queue, name, tenantId]).sort()).toEqual(
      [
        ['communications-reminders', portTaskName(REMINDER_A1, 1), TENANT_A.tenantId],
        ['communications-reminders', portTaskName(REMINDER_A2, 1), TENANT_A.tenantId],
        ['surveys-launch', portTaskName(LAUNCH_A, 1), TENANT_A.tenantId],
        ['surveys-launch', portTaskName(LAUNCH_B, 3), TENANT_B.tenantId],
        // The event row held the queue task name without a queue task, so adoption queued it.
        ['surveys-launch', portTaskName(LAUNCH_EVENT, 1), TENANT_A.tenantId],
      ].sort(),
    );
    const tenantA = await rows(TENANT_A.tenantId);
    expect(tenantA.map((row) => [row.task_name, row.origin, row.status])).toEqual([
      [LAUNCH_A, 'adopted', 'scheduled'],
      [REMINDER_A1, 'adopted', 'scheduled'],
      [REMINDER_A2, 'adopted', 'scheduled'],
      [LAUNCH_EVENT, 'event', 'scheduled'],
    ]);
    expect(tenantA[0]?.schedule_time.getTime()).toBe(NOW.getTime());
    expect(tenantA[1]?.schedule_time.getTime()).toBe(new Date(2026, 6, 1, 9, 0, 0, 0).getTime());
    expect((await rows(TENANT_B.tenantId)).map((row) => [row.task_name, row.tenant_id])).toEqual([[LAUNCH_B, TENANT_B.tenantId]]);

    const repeated = await post(ADOPT_PATH, body);

    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ adopted: 0, existing: 5, scheduledImmediately: 0 });
    expect(port.creates).toHaveLength(5);
    expect(port.live.size).toBe(5);
    expect(await rows(TENANT_A.tenantId)).toHaveLength(4);
  });

  it('cancels the named adopted tasks, then every one, leaving event rows and deleting only adopted queue tasks', async () => {
    const named = await post(CANCEL_ADOPTED_PATH, { names: [LAUNCH_B, LAUNCH_EVENT] });

    expect(named.statusCode).toBe(200);
    expect(named.json()).toEqual({ cancelled: 1 });
    expect((await rows(TENANT_B.tenantId)).map((row) => row.status)).toEqual(['cancelled']);

    const all = await post(CANCEL_ADOPTED_PATH, {});

    expect(all.json()).toEqual({ cancelled: 3 });
    expect((await rows(TENANT_A.tenantId)).map((row) => [row.task_name, row.status])).toEqual([
      [LAUNCH_A, 'cancelled'],
      [REMINDER_A1, 'cancelled'],
      [REMINDER_A2, 'cancelled'],
      [LAUNCH_EVENT, 'scheduled'],
    ]);
    expect([...port.live.keys()]).toEqual([`surveys-launch/${portTaskName(LAUNCH_EVENT, 1)}`]);

    expect((await post(CANCEL_ADOPTED_PATH, {})).json()).toEqual({ cancelled: 0 });
  });

  it.each([
    ['no body', ADOPT_PATH, undefined],
    ['a body tenant', ADOPT_PATH, { tasks: [], tenantId: TENANT_A.tenantId }],
    ['an empty site', ADOPT_PATH, { tasks: [task(`opt2-survey-${SURVEY_A}-reminder-9`, '', '2026-07-01T09:00:00.000')] }],
    ['a run time that does not exist', ADOPT_PATH, { tasks: [task(`opt2-survey-${SURVEY_A}-reminder-9`, TENANT_A.siteId, '2026-02-30T09:00:00.000')] }],
    ['a malformed task name', CANCEL_ADOPTED_PATH, { names: ['opt2-survey-x-launch'] }],
  ])('answers 400 invalidParameters without a write for %s', async (_label, url, body) => {
    const res = await post(url, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(port.creates).toHaveLength(0);
    expect(port.deletes).toHaveLength(0);
  });

  it('answers the legacy 503 when a tenant transaction cannot pass its gates', async () => {
    const { db } = ctx.scheduleDeps;
    const original = db.withTenant;
    db.withTenant = () => Promise.reject(new GateClosedError(['communications.scheduled_task']));
    try {
      const adopt = await post(ADOPT_PATH, { tasks: [task(`opt2-survey-${SURVEY_A}-reminder-9`, TENANT_A.siteId, '2026-07-01T09:00:00.000')] });
      const cancel = await post(CANCEL_ADOPTED_PATH, {});

      expect([adopt.statusCode, cancel.statusCode]).toEqual([503, 503]);
    } finally {
      db.withTenant = original;
    }
  });

  it.each([
    ['the surveys service', () => callerHeaders('surveys'), 403],
    ['the operator', () => callerHeaders('operator'), 403],
    ['no credential', () => Promise.resolve({}), 401],
    [
      'a user token alone',
      async () => ({ authorization: `Bearer ${await mintUserToken({ sub: 'U', site: TENANT_A.siteId, roles: [Roles.s2] })}` }),
      401,
    ],
  ])('refuses %s', async (_label, headers, status) => {
    for (const url of [ADOPT_PATH, CANCEL_ADOPTED_PATH]) {
      const res = await post(url, { tasks: [] }, await headers());

      expect(res.statusCode).toBe(status);
    }
    expect(port.creates).toHaveLength(0);
  });
});
