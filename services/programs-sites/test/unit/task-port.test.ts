/** Task port construction, task route registration and start-up chains of programs-sites. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SECRET_FILES, localSecretPath, recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, fixedClock, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  SITEMONITOR_QUEUE,
  TaskPortConfigError,
  outboxSweepQueue,
  slotName,
  slotStartS,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPage,
  type TaskPort,
} from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  createProgramsSitesTaskPort,
  ensureStartupChains,
  registerQueueControlRoutes,
  registerSweep,
  registerTaskInfrastructure,
} from '../../src/tasks/port.js';

const CLOCK = fixedClock('2026-06-30T12:00:30Z');
const SERVICE_URLS = { 'programs-sites': 'http://127.0.0.1:8113' };
const SWEEP_QUEUE = outboxSweepQueue('programs-sites');

/** In-memory task port with Cloud Tasks ALREADY_EXISTS semantics. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local' as const;
  readonly tasks = new Map<string, CreateTaskInput>();

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (this.tasks.has(input.name)) return { name: input.name, created: false };
    this.tasks.set(input.name, input);
    return { name: input.name, created: true };
  }
  async delete(_queue: string, name: string): Promise<DeleteTaskResult> {
    return { name, deleted: this.tasks.delete(name) };
  }
  async list(queue: string): Promise<TaskPage> {
    return {
      tasks: [...this.tasks.values()]
        .filter((task) => task.queue === queue)
        .map((task) => ({ queue, name: task.name, scheduleTime: task.scheduleTime, status: 'pending', attempts: 0 })),
    };
  }
  async get(queue: string, name: string): Promise<TaskInfo | undefined> {
    const task = this.tasks.get(name);
    return task?.queue === queue ? { queue, name, scheduleTime: task.scheduleTime, status: 'pending', attempts: 0 } : undefined;
  }
  async pauseQueue(): Promise<void> {}
  async resumeQueue(): Promise<void> {}
  async queueState(queue: string): Promise<QueueState> {
    return { queue, paused: false };
  }
  async close(): Promise<void> {}
}

/** TenantDb fake for registration-only tests; it runs no SQL. */
function memoryDb(): TenantDb {
  const noSql = (): Promise<never> => Promise.reject(new Error('task port tests run no SQL'));
  return { schema: 'programs_sites', withTenant: noSql, withMetadata: noSql, end: async () => undefined };
}

let stateDir: string;

// createService's local auth reads the verification key and push key from OPT2_STATE_DIR.
beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-task-port-'));
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = {
    [LOCAL_SECRET_FILES.tokenSigningPublicKey]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    [LOCAL_SECRET_FILES.pubsubPushKey]: randomUUID(),
  };
  for (const [file, content] of Object.entries(files)) {
    const target = localSecretPath(stateDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function testEnv(overrides: Record<string, string> = {}): BaseEnv {
  return loadEnv(undefined, {
    PORT: '8113',
    OPT2_SERVICE_NAME: 'programs-sites',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(SERVICE_URLS),
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
    ...overrides,
  });
}

const silentLogger = createLogger({
  service: 'programs-sites',
  version: '1.0.0',
  env: 'local',
  destination: { write: () => undefined },
});
const apps: FastifyInstance[] = [];

/** A service app with a registered outbox runtime, as `app.ts` builds it before the task routes. */
async function serviceApp(): Promise<FastifyInstance> {
  const db = memoryDb();
  const app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: testEnv(),
    clock: CLOCK,
    pool: db,
    logger: silentLogger,
  });
  createOutbox({
    service: 'programs-sites',
    db,
    publisher: { publish: async () => 'id', publishRaw: async () => 'id', close: async () => undefined },
    logger: silentLogger,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

const TASK_ROUTES = [
  { method: 'POST', url: '/internal/v1/outbox/sweep', config: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] } },
  ...['pause', 'resume', 'ensure'].map((op) => ({
    method: 'POST',
    url: `/internal/v1/task-queues/:queue/${op}`,
    config: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
  })),
];

describe('ensureStartupChains', () => {
  it('ensures the current outbox-sweep slot and never the site-monitor chain', async () => {
    const port = new MemoryTaskPort();
    const slot = slotStartS(Math.floor(CLOCK.now().getTime() / 1000), 60);

    const results = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK });

    expect(results).toStrictEqual([{ queue: SWEEP_QUEUE, name: slotName(SWEEP_QUEUE, slot), created: true, reason: 'created-current' }]);
    expect([...port.tasks.values()].map((task) => [task.queue, task.url])).toStrictEqual([
      [SWEEP_QUEUE, 'http://127.0.0.1:8113/internal/v1/outbox/sweep'],
    ]);
    expect((await port.list(SITEMONITOR_QUEUE)).tasks).toStrictEqual([]);
  });

  it('finds a live sweep chain instead of creating another', async () => {
    const port = new MemoryTaskPort();
    await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK });

    const again = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK });

    expect(again.map((result) => result.reason)).toStrictEqual(['live']);
    expect(port.tasks.size).toBe(1);
  });
});

describe('task route registration', () => {
  const taskRoutesOf = (app: FastifyInstance) =>
    recordedRoutes(app).filter((route) => TASK_ROUTES.some((expected) => expected.url === route.url));

  it('registerTaskInfrastructure adds the sweep and the three queue-control routes with platform config', async () => {
    const app = await serviceApp();
    const before = recordedRoutes(app).length;

    await registerTaskInfrastructure(app, { port: new MemoryTaskPort(), serviceUrls: SERVICE_URLS, clock: CLOCK });

    expect(recordedRoutes(app).length - before).toBe(4);
    expect(taskRoutesOf(app)).toStrictEqual(TASK_ROUTES);
  });

  it('registerSweep then registerQueueControlRoutes register the same routes', async () => {
    const app = await serviceApp();
    const opts = { port: new MemoryTaskPort(), serviceUrls: SERVICE_URLS, clock: CLOCK };

    await registerSweep(app, opts);
    await registerQueueControlRoutes(app, opts);

    expect(taskRoutesOf(app)).toStrictEqual(TASK_ROUTES);
  });
});

describe('createProgramsSitesTaskPort', () => {
  it('raises the platform configuration error for an adapter it cannot build', async () => {
    const env = { ...testEnv(), OPT2_TASKS_ADAPTER: 'cloud' } as BaseEnv;

    await expect(
      createProgramsSitesTaskPort(env, { db: memoryDb(), clock: CLOCK, logger: silentLogger }),
    ).rejects.toBeInstanceOf(TaskPortConfigError);
  });
});
