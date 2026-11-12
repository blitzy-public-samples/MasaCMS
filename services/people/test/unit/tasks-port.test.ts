/** People's task port, outbox-sweep chain and queue-control wiring over the local tasks adapter in a throwaway `people` schema. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { OutboxNotConfiguredError, createOutbox, resetOutboxRuntimes, type RecoveryContext, type RecoveryHook } from '@opt2/platform/outbox';
import { createService, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  TaskPortConfigError,
  outboxSweepQueue,
  slotName,
  slotStartS,
  taskWireBody,
  type TaskPort,
} from '@opt2/platform/tasks';
import { tenantDbFromPool } from '@opt2/platform/tenancy';
import {
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintTasksInvokerToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  PEOPLE_SERVICE,
  PEOPLE_SWEEP_QUEUE,
  createPeopleTaskPort,
  ensureStartupChains,
  registerQueueControlRoutes,
  registerSweep,
} from '../../src/tasks/port.js';

const CLOCK = businessClock();
const SERVICE_URLS = { people: 'http://127.0.0.1:8112' };
const CURRENT_SLOT = slotStartS(Math.floor(CLOCK.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S);
const silentLogger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

const TASK_ROUTES = [
  { method: 'POST', url: OUTBOX_SWEEP_PATH, config: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] } },
  ...['pause', 'resume', 'ensure'].map((op) => ({
    method: 'POST',
    url: `/internal/v1/task-queues/:queue/${op}`,
    config: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
  })),
];

describe('people task queues', () => {
  it('registers under the people service and its outbox-sweep queue', () => {
    expect(PEOPLE_SERVICE).toBe('people');
    expect(PEOPLE_SWEEP_QUEUE).toBe('people-outbox-sweep');
    expect(PEOPLE_SWEEP_QUEUE).toBe(outboxSweepQueue('people'));
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('people task wiring against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let env: BaseEnv;
  let port: TaskPort;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-tasks-port-'));
    await writeTestSecrets(stateDir);
    env = loadEnv(undefined, {
      PORT: '8112',
      OPT2_SERVICE_NAME: PEOPLE_SERVICE,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify(SERVICE_URLS),
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    });
    port = await createPeopleTaskPort(env, { db: handle.app, clock: CLOCK, logger: silentLogger });
    // The dispatcher is stopped so due tasks stay pending for inspection and nothing is sent to SERVICE_URLS.
    await port.close();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  /** A people service app on its own pool of the throwaway schema, with the outbox runtime `app.ts` creates first unless `outbox` is false. */
  async function serviceApp({ outbox = true }: { outbox?: boolean } = {}): Promise<FastifyInstance> {
    const db = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    const app = await createService({ name: PEOPLE_SERVICE, version: '1.0.0', env, verifierOverride: testVerifier(PEOPLE_SERVICE), clock: CLOCK, pool: db, logger: silentLogger });
    apps.push(app);
    resetOutboxRuntimes();
    if (outbox) createOutbox({ service: PEOPLE_SERVICE, db, publisher: createCapturingPublisher(), logger: silentLogger, clock: CLOCK });
    return app;
  }

  /** Delivers the people sweep task of `slotS` as the local tasks adapter does. */
  async function injectSweep(app: FastifyInstance, slotS: number) {
    const name = slotName(PEOPLE_SWEEP_QUEUE, slotS);
    return app.inject({
      method: 'POST',
      url: OUTBOX_SWEEP_PATH,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: PEOPLE_SERVICE })}`,
        [CLOUD_TASKS_HEADERS.taskName]: name,
        [CLOUD_TASKS_HEADERS.queueName]: PEOPLE_SWEEP_QUEUE,
        [CLOUD_TASKS_HEADERS.retryCount]: '0',
        [CLOUD_TASKS_HEADERS.executionCount]: '0',
        [CLOUD_TASKS_HEADERS.eta]: String(slotS),
      },
      payload: taskWireBody({
        queue: PEOPLE_SWEEP_QUEUE,
        name,
        scheduleTime: new Date(slotS * 1000),
        url: `${SERVICE_URLS.people}${OUTBOX_SWEEP_PATH}`,
        deadlineS: 60,
        body: { slotStartS: slotS },
      }),
    });
  }

  it.each<[string, Partial<Record<keyof BaseEnv, string | undefined>>]>([
    ['the cloud adapter without a Google Cloud project', { OPT2_TASKS_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: undefined }],
    ['the local adapter without a state directory', { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: undefined }],
  ])('raises the platform configuration error for %s', async (_label, overrides) => {
    await expect(createPeopleTaskPort({ ...env, ...overrides } as BaseEnv, { db: handle.app, clock: CLOCK, logger: silentLogger })).rejects.toBeInstanceOf(
      TaskPortConfigError,
    );
  });

  it('builds the local adapter OPT2_TASKS_ADAPTER selects in the local environment', () => {
    expect(env.OPT2_TASKS_ADAPTER).toBe('local');
    expect(port.kind).toBe('local');
  });

  it('ensures the current sweep slot once, then finds the chain live', async () => {
    const first = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK });

    expect(first).toStrictEqual([{ queue: PEOPLE_SWEEP_QUEUE, name: slotName(PEOPLE_SWEEP_QUEUE, CURRENT_SLOT), created: true, reason: 'created-current' }]);
    expect((await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK })).map((result) => result.reason)).toStrictEqual(['live']);
    expect((await port.list(PEOPLE_SWEEP_QUEUE)).tasks.map((task) => [task.name, task.status])).toStrictEqual([
      [slotName(PEOPLE_SWEEP_QUEUE, CURRENT_SLOT), 'pending'],
    ]);
  });

  it('registers the sweep chain and the three queue-control routes with their platform route config', async () => {
    const app = await serviceApp();
    const opts = { port, serviceUrls: SERVICE_URLS, clock: CLOCK };

    registerSweep(app, { ...opts, recoveryHooks: [] });
    registerQueueControlRoutes(app, opts);

    expect(recordedRoutes(app).filter((route) => TASK_ROUTES.some((expected) => expected.url === route.url))).toStrictEqual(TASK_ROUTES);
  });

  it('refuses to register the sweep before the outbox runtime exists', async () => {
    const app = await serviceApp({ outbox: false });

    expect(() => registerSweep(app, { port, serviceUrls: SERVICE_URLS, clock: CLOCK, recoveryHooks: [] })).toThrow(OutboxNotConfiguredError);
  });

  it('answers a delivered people sweep after creating its successor slot and running the recovery hooks in order', async () => {
    const app = await serviceApp();
    const runs: string[] = [];
    const contexts: RecoveryContext[] = [];
    const hooks: RecoveryHook[] = ['first', 'second'].map((name) => ({
      name,
      run: async (ctx: RecoveryContext) => {
        runs.push(name);
        contexts.push(ctx);
      },
    }));
    registerSweep(app, { port, serviceUrls: SERVICE_URLS, clock: CLOCK, recoveryHooks: hooks });
    const successor = slotName(PEOPLE_SWEEP_QUEUE, CURRENT_SLOT + OUTBOX_SWEEP_INTERVAL_S);

    const response = await injectSweep(app, CURRENT_SLOT);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ published: 0, failed: 0, hooks: [{ name: 'first', ok: true }, { name: 'second', ok: true }] });
    expect(runs).toStrictEqual(['first', 'second']);
    expect(contexts).toHaveLength(2);
    expect(await port.get(PEOPLE_SWEEP_QUEUE, successor)).toMatchObject({ queue: PEOPLE_SWEEP_QUEUE, name: successor, status: 'pending' });
  });
});
