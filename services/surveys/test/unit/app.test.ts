// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of surveys against a throwaway schema: start-up, declared routes, the sweep chain and shutdown. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCAL_USER_TOKEN, collectRouteMatrix } from '@opt2/platform/auth';
import { baseEnvSchema, loadEnv, type BaseEnv } from '@opt2/platform/service-kit';
import type { CreateTaskInput, TaskInfo, TaskPort } from '@opt2/platform/tasks';
import { SYSTEM_TENANT_ID } from '@opt2/platform/tenancy';
import {
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  mintTasksInvokerToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { UNITS } from '../../src/repo/tables.js';

const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

const NOW = new Date(2026, 5, 30, 12, 0, 0);
const SWEEP_QUEUE = 'surveys-outbox-sweep';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

type Operation = Record<string, unknown>;
type OpenApiDoc = { paths: Record<string, Record<string, Operation>> };

/** One route as the auth matrix and the contract both describe it, comparable by deep equality. */
interface DeclaredRoute {
  method: string;
  url: string;
  transport: unknown;
  requires?: string[];
  public?: true;
  siteCheck: boolean;
}

function byRoute(a: DeclaredRoute, b: DeclaredRoute): number {
  return a.url.localeCompare(b.url, 'en') || a.method.localeCompare(b.method, 'en');
}

/** Every operation of `contracts/openapi.yaml`, with its path template in Fastify form. */
function contractRoutes(): DeclaredRoute[] {
  const doc = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
  return Object.entries(doc.paths)
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => HTTP_METHODS.includes(method))
        .map(([method, op]): DeclaredRoute => {
          const requires = op['x-opt2-requires'] as string[] | undefined;
          return {
            method: method.toUpperCase(),
            url: path.replace(/\{([^}]+)\}/g, ':$1'),
            transport: op['x-opt2-transport'],
            ...(requires === undefined ? { public: true as const } : { requires: [...requires].sort() }),
            siteCheck: op['x-opt2-site-check'] !== false,
          };
        }),
    )
    .sort(byRoute);
}

/** In-memory task port whose `created` lists the tasks it accepted, in order. */
function fakeTaskPort(): TaskPort & { created: CreateTaskInput[] } {
  const live = new Map<string, CreateTaskInput>();
  const paused = new Set<string>();
  const info = (task: CreateTaskInput): TaskInfo => ({
    queue: task.queue,
    name: task.name,
    scheduleTime: task.scheduleTime,
    status: 'pending',
    attempts: 0,
  });
  const created: CreateTaskInput[] = [];
  return {
    kind: 'local',
    created,
    async create(input) {
      const key = `${input.queue}/${input.name}`;
      if (live.has(key)) return { name: input.name, created: false };
      live.set(key, input);
      created.push(input);
      return { name: input.name, created: true };
    },
    async delete(queue, name) {
      return { name, deleted: live.delete(`${queue}/${name}`) };
    },
    async list(queue) {
      return { tasks: [...live.values()].filter((task) => task.queue === queue).map(info) };
    },
    async get(queue, name) {
      const task = live.get(`${queue}/${name}`);
      return task === undefined ? undefined : info(task);
    },
    async pauseQueue(queue) {
      paused.add(queue);
    },
    async resumeQueue(queue) {
      paused.delete(queue);
    },
    async queueState(queue) {
      return { queue, paused: paused.has(queue) };
    },
    async close() {},
  };
}

/** Local env over `stateDir`; service URLs name port 9 (discard), so a chain task the local adapter dispatches reaches nothing. */
function testEnv(stateDir: string, overrides: Record<string, string> = {}): BaseEnv {
  return loadEnv(baseEnvSchema, {
    PORT: '8117',
    OPT2_SERVICE_NAME: 'surveys',
    OPT2_ENV: 'local',
    PUBSUB_EMULATOR_HOST: 'localhost:8085',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_SERVICE_URLS: JSON.stringify({ surveys: 'http://127.0.0.1:9', communications: 'http://127.0.0.1:9' }),
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
    ...overrides,
  });
}

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe('surveys buildApp without a database', () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'opt2-surveys-app-'));
    await writeTestSecrets(stateDir);
  });

  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each([
    ['no emulator host for its own publisher', undefined, 'surveys: invalid environment\n  PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local'],
    ['an injected publisher and no emulator host', createCapturingPublisher(), 'Schema surveys needs OPT2_DB_AUTH and PG_DATABASE'],
  ])('fails start-up with %s before acquiring anything', async (_case, publisher, message) => {
    const sigterm = process.listenerCount('SIGTERM');
    const env = testEnv(stateDir, { PUBSUB_EMULATOR_HOST: '' });

    await expect(buildApp({ env, publisher, clock: fixedClock(NOW), verifierOverride: testVerifier('surveys') })).rejects.toThrow(message);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });
});

describe.skipIf(!available)('surveys buildApp against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stateDir: string | undefined;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'opt2-surveys-app-'));
    await writeTestSecrets(stateDir);
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
  });

  function build(options: Partial<BuildAppOptions> = {}, env: Record<string, string> = {}) {
    return buildApp({
      env: testEnv(stateDir as string, env),
      clock: fixedClock(NOW),
      verifierOverride: testVerifier('surveys'),
      db: handle.app,
      ...options,
    });
  }

  it('starts on the injected pool with its unit gates, the sweep chain and exactly the contract routes', async () => {
    const taskPort = fakeTaskPort();
    const app = await build({ publisher: createCapturingPublisher(), taskPort });
    try {
      await app.ready();
      expect(app.opt2).toMatchObject({ name: 'surveys', version: '1.0.0' });
      expect(app.opt2.db).toBe(handle.app);
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect(taskPort.created.map((task) => task.queue)).toEqual([SWEEP_QUEUE]);

      const gates = await handle.adminPool.query<{ unit: string }>(`SELECT unit FROM ${handle.schema}.unit_gate`);
      expect(gates.rows.map((row) => row.unit).sort()).toEqual([...UNITS].sort());

      const matrix = collectRouteMatrix(app).routes.map(
        ({ method, url, transport, requires, public: isPublic, siteCheck }): DeclaredRoute => ({
          method,
          url,
          transport,
          ...(isPublic === true ? { public: true as const } : { requires: [...(requires ?? [])].sort() }),
          siteCheck,
        }),
      );
      expect(matrix.sort(byRoute)).toEqual(contractRoutes());
    } finally {
      await app.close();
    }
  });

  it('routes a fixture path in any module and resource case as its lower-case path', async () => {
    const app = await build({ publisher: createCapturingPublisher(), taskPort: fakeTaskPort() });
    try {
      await app.ready();
      const lower = await app.inject({ method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/surveys/surveys?siteid=tenant-a' });
      const cased = await app.inject({ method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/Surveys/SURVEYS?siteid=tenant-a' });
      expect(cased.json()).toMatchObject({ method: 'surveys.surveys' });
      expect([cased.statusCode, cased.json()]).toEqual([lower.statusCode, lower.json()]);
    } finally {
      await app.close();
    }
  });

  it('sweeps the injected schema through its outbox runtime and chains the successor slot', async () => {
    const taskPort = fakeTaskPort();
    const app = await build({ publisher: createCapturingPublisher(), taskPort });
    try {
      await app.ready();
      const [chain] = taskPort.created;
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/outbox/sweep',
        headers: {
          authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'surveys' })}`,
          'x-cloudtasks-taskname': chain?.name ?? '',
          'x-cloudtasks-queuename': SWEEP_QUEUE,
        },
        payload: { queue: SWEEP_QUEUE, name: chain?.name, tenantId: null, payload: null },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ published: 0, failed: 0, tenants: 0 });
      expect(taskPort.created.map((task) => task.queue)).toEqual([SWEEP_QUEUE, SWEEP_QUEUE]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['closes', undefined],
    ['fails to close', new Error('task port close failed')],
  ])('closes the publisher once when the task port %s', async (_case, closeError) => {
    const publisher = createCapturingPublisher();
    const taskPort = fakeTaskPort();
    const publisherClose = vi.spyOn(publisher, 'close');
    const portClose = vi.spyOn(taskPort, 'close');
    if (closeError !== undefined) portClose.mockRejectedValue(closeError);
    const app = await build({ publisher, taskPort });
    await app.ready();

    await (closeError === undefined ? expect(app.close()).resolves.toBeUndefined() : expect(app.close()).rejects.toBe(closeError));
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(publisherClose).toHaveBeenCalledTimes(1);
  });

  it('builds its own local task port and publisher, defaulting the Pub/Sub project', async () => {
    const app = await build({}, { GOOGLE_CLOUD_PROJECT: '' });
    try {
      await app.ready();
      const { rows } = await handle.app.withTenant(SYSTEM_TENANT_ID, (tx) =>
        tx.query<{ queue: string }>(`SELECT queue FROM ${handle.schema}.scheduled_task_queue`),
      );
      expect(rows.map((row) => row.queue)).toEqual([SWEEP_QUEUE]);
    } finally {
      await app.close();
    }
  });
});
