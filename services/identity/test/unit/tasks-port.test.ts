/** Identity's task port, outbox-sweep chain and queue-control wiring over the local tasks adapter in a throwaway `identity` schema, with every route answer checked against the contract. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, recordedRoutes } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { OutboxNotConfiguredError, createOutbox, resetOutboxRuntimes } from '@opt2/platform/outbox';
import { IDENTITY_SERVICE as SERVICE_KIT_IDENTITY, createService, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  TaskPortConfigError,
  outboxSweepQueue,
  queueDefinition,
  queuesCreatedBy,
  recurringQueues,
  slotName,
  slotStartS,
  taskWireBody,
  type TaskPort,
} from '@opt2/platform/tasks';
import { tenantDbFromPool } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { IDENTITY_SERVICE, createIdentityTaskPort, ensureStartupChains, registerQueueControlRoutes, registerSweep } from '../../src/tasks/port.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const SWEEP_QUEUE = 'identity-outbox-sweep';
const CLOCK = businessClock();
const SERVICE_URLS = { identity: 'http://127.0.0.1:8111' };
const CURRENT_SLOT = slotStartS(Math.floor(CLOCK.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S);
const silentLogger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

/** The contract's declaration of the sweep and queue-control routes, in the shape `recordedRoutes` reports them. */
function contractRoutes(): { method: string; url: string; config: { transport: unknown; requires: unknown } }[] {
  const templates = [OUTBOX_SWEEP_PATH, ...['pause', 'resume', 'ensure'].map((op) => `/internal/v1/task-queues/{queue}/${op}`)];
  return templates.flatMap((template) =>
    Object.entries(OPENAPI.paths[template] ?? {})
      .filter(([method]) => method !== 'parameters')
      .map(([method, operation]) => ({
        method: method.toUpperCase(),
        url: template.replace('{queue}', ':queue'),
        config: { transport: operation['x-opt2-transport'], requires: operation['x-opt2-requires'] },
      })),
  );
}

describe('identity task queues', () => {
  it('registers under the service-kit identity name and its outbox-sweep queue', () => {
    expect(IDENTITY_SERVICE).toBe('identity');
    expect(IDENTITY_SERVICE).toBe(SERVICE_KIT_IDENTITY);
    expect(outboxSweepQueue(IDENTITY_SERVICE)).toBe(SWEEP_QUEUE);
  });

  it('creates tasks only on its own recurring sweep queue, which calls its sweep route every 60 s', () => {
    expect(queuesCreatedBy(IDENTITY_SERVICE).map((queue) => queue.name)).toStrictEqual([SWEEP_QUEUE]);
    expect(recurringQueues().filter((queue) => queue.targetService === IDENTITY_SERVICE).map((queue) => queue.name)).toStrictEqual([SWEEP_QUEUE]);
    expect(queueDefinition(SWEEP_QUEUE)).toMatchObject({
      targetService: IDENTITY_SERVICE,
      targetPath: OUTBOX_SWEEP_PATH,
      creators: [IDENTITY_SERVICE],
      recurring: { intervalS: OUTBOX_SWEEP_INTERVAL_S },
    });
  });

  it('declares exactly its own sweep queue as the contract queue parameter', () => {
    const parameter = (OPENAPI as unknown as { components: { parameters: Record<string, { schema: { enum: string[] } }> } }).components.parameters.Queue;

    expect(parameter?.schema.enum).toStrictEqual(queuesCreatedBy(IDENTITY_SERVICE).map((queue) => queue.name));
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('identity task wiring against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let env: BaseEnv;
  let port: TaskPort;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-tasks-port-'));
    await writeTestSecrets(stateDir);
    env = loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: IDENTITY_SERVICE,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify(SERVICE_URLS),
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    });
    port = await createIdentityTaskPort(env, { db: handle.app, clock: CLOCK, logger: silentLogger });
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

  /** An identity service app on its own pool of the throwaway schema, with the outbox runtime created first unless `outbox` is false. */
  async function serviceApp({ outbox = true }: { outbox?: boolean } = {}): Promise<FastifyInstance> {
    const db = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    const app = await createService({ name: IDENTITY_SERVICE, version: '1.0.0', env, verifierOverride: testVerifier(IDENTITY_SERVICE), clock: CLOCK, pool: db, logger: silentLogger });
    apps.push(app);
    resetOutboxRuntimes();
    if (outbox) createOutbox({ service: IDENTITY_SERVICE, db, publisher: createCapturingPublisher(), logger: silentLogger, clock: CLOCK });
    return app;
  }

  /** An app with the sweep and queue-control routes registered over the shared port. */
  async function wiredApp(): Promise<FastifyInstance> {
    const app = await serviceApp();
    const opts = { port, serviceUrls: SERVICE_URLS, clock: CLOCK };
    registerSweep(app, opts);
    registerQueueControlRoutes(app, opts);
    return app;
  }

  /** Injects a POST and checks the answer against the contract. */
  async function send(app: FastifyInstance, url: string, headers: Record<string, string>, payload?: string) {
    const res = await app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  /** Delivers the identity sweep task of `slotS` as the local tasks adapter does. */
  async function injectSweep(app: FastifyInstance, slotS: number) {
    const name = slotName(SWEEP_QUEUE, slotS);
    const headers = {
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: IDENTITY_SERVICE })}`,
      'content-type': 'application/json',
      [CLOUD_TASKS_HEADERS.taskName]: name,
      [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
      [CLOUD_TASKS_HEADERS.retryCount]: '0',
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(slotS),
    };
    const body = taskWireBody({
      queue: SWEEP_QUEUE,
      name,
      scheduleTime: new Date(slotS * 1000),
      url: `${SERVICE_URLS.identity}${OUTBOX_SWEEP_PATH}`,
      deadlineS: 60,
      body: { slotStartS: slotS },
    });
    return send(app, OUTBOX_SWEEP_PATH, headers, JSON.stringify(body));
  }

  /** Headers of a queue-control call by `caller`. */
  async function controlHeaders(caller: string): Promise<Record<string, string>> {
    return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: IDENTITY_SERVICE })}` };
  }

  it.each<[string, Partial<Record<keyof BaseEnv, string | undefined>>]>([
    ['the cloud adapter without a Google Cloud project', { OPT2_TASKS_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: undefined }],
    ['the local adapter without a state directory', { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: undefined }],
  ])('raises the platform configuration error for %s', async (_label, overrides) => {
    await expect(
      createIdentityTaskPort({ ...env, ...overrides } as BaseEnv, { db: handle.app, clock: CLOCK, logger: silentLogger }),
    ).rejects.toBeInstanceOf(TaskPortConfigError);
  });

  it('builds the local adapter OPT2_TASKS_ADAPTER selects in the local environment', () => {
    expect(env.OPT2_TASKS_ADAPTER).toBe('local');
    expect(port.kind).toBe('local');
  });

  it('ensures the current sweep slot once, then finds the chain live', async () => {
    const first = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK });

    expect(first).toStrictEqual([{ queue: SWEEP_QUEUE, name: slotName(SWEEP_QUEUE, CURRENT_SLOT), created: true, reason: 'created-current' }]);
    expect((await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock: CLOCK })).map((result) => result.reason)).toStrictEqual(['live']);
    expect((await port.list(SWEEP_QUEUE)).tasks.map((task) => [task.name, task.status])).toStrictEqual([[slotName(SWEEP_QUEUE, CURRENT_SLOT), 'pending']]);
  });

  it('registers the sweep chain and the three queue-control routes as the contract declares them', async () => {
    const app = await wiredApp();
    const expected = contractRoutes();

    expect(expected).toHaveLength(4);
    expect(recordedRoutes(app).filter((route) => expected.some((entry) => entry.url === route.url))).toStrictEqual(expected);
  });

  it('refuses to register the sweep before the outbox runtime exists', async () => {
    const app = await serviceApp({ outbox: false });

    expect(() => registerSweep(app, { port, serviceUrls: SERVICE_URLS, clock: CLOCK })).toThrow(OutboxNotConfiguredError);
  });

  it('answers a delivered identity sweep after creating its successor slot, with no recovery hooks', async () => {
    const app = await wiredApp();
    const successor = slotName(SWEEP_QUEUE, CURRENT_SLOT + OUTBOX_SWEEP_INTERVAL_S);

    const response = await injectSweep(app, CURRENT_SLOT);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ published: 0, failed: 0, skipped: 0, tenants: 0, hooks: [] });
    expect(await port.get(SWEEP_QUEUE, successor)).toMatchObject({ queue: SWEEP_QUEUE, name: successor, status: 'pending' });
  });

  it.each(['migration', 'operator'])('pauses, resumes and ensures the sweep queue for the %s service identity', async (caller) => {
    const app = await wiredApp();
    const headers = await controlHeaders(caller);
    const control = (op: string) => send(app, `/internal/v1/task-queues/${SWEEP_QUEUE}/${op}`, headers);

    const paused = await control('pause');
    const resumed = await control('resume');
    const ensured = await control('ensure');

    expect([paused.statusCode, paused.json()]).toStrictEqual([200, { queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, paused: true, running: 0 }]);
    expect([resumed.statusCode, resumed.json()]).toStrictEqual([200, { queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, paused: false }]);
    expect(ensured.statusCode).toBe(200);
    expect(ensured.json()).toMatchObject({ queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, ensured: { queue: SWEEP_QUEUE } });
  });

  it('answers queue control on a queue identity does not create with the legacy 400 and refuses other callers', async () => {
    const app = await wiredApp();

    const foreign = await send(app, '/internal/v1/task-queues/people-outbox-sweep/pause', await controlHeaders('migration'));

    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
    expect((await send(app, `/internal/v1/task-queues/${SWEEP_QUEUE}/pause`, await controlHeaders('gateway'))).statusCode).toBe(403);
    expect((await send(app, `/internal/v1/task-queues/${SWEEP_QUEUE}/pause`, {})).statusCode).toBe(401);
    expect((await port.queueState(SWEEP_QUEUE)).paused).toBe(false);
  });
});
