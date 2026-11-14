/** People's outbox-sweep chain, queue-control routes, start-up chain and task-port factory through the app over the fake task port, offline. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOutbox, type RecoveryContext, type RecoveryHook, type SweepResult } from '@opt2/platform/outbox';
import { createService, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  QUEUE_CONTROL_PREFIX,
  SITEMONITOR_QUEUE,
  TaskPortConfigError,
  outboxSweepQueue,
  queueDefinition,
  slotName,
  slotStartS,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type QueueControlOp,
  type QueueControlResult,
} from '@opt2/platform/tasks';
import {
  createCapturingPublisher,
  fixedClock,
  mintServiceToken,
  mintTasksInvokerToken,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import {
  PEOPLE_SERVICE,
  PEOPLE_SWEEP_QUEUE,
  createPeopleTaskPort,
  ensureStartupChains,
  registerQueueControlRoutes,
  registerSweep,
} from '../../src/tasks/port.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  createRecordingDb,
  headersFor,
  testEnv,
  userHeaders,
  type FakeTaskPort,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';

const SERVICE_URLS = Object.freeze({ people: 'http://127.0.0.1:8112' });
const SWEEP_URL = `${SERVICE_URLS.people}${OUTBOX_SWEEP_PATH}`;
const SWEEP_DEADLINE_S = queueDefinition(PEOPLE_SWEEP_QUEUE).deadlineS;
const CURRENT_SLOT_S = slotStartS(Math.floor(TEST_CLOCK.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S);
const NEXT_SLOT_S = CURRENT_SLOT_S + OUTBOX_SWEEP_INTERVAL_S;
const CURRENT_TASK = slotName(PEOPLE_SWEEP_QUEUE, CURRENT_SLOT_S);
const NEXT_TASK = slotName(PEOPLE_SWEEP_QUEUE, NEXT_SLOT_S);
const EMPTY_SWEEP: Omit<SweepResult, 'hooks'> = { published: 0, failed: 0, skipped: 0, tenants: 0 };

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
type Credentials = () => Promise<Record<string, string>>;

/** The create input of the sweep chain task of `slotS`, as the chain schedules it. */
function sweepTaskInput(slotS: number): CreateTaskInput {
  return {
    queue: PEOPLE_SWEEP_QUEUE,
    name: slotName(PEOPLE_SWEEP_QUEUE, slotS),
    scheduleTime: new Date(slotS * 1000),
    url: SWEEP_URL,
    deadlineS: SWEEP_DEADLINE_S,
    body: { slotStartS: slotS },
  };
}

/** Names of the tasks the fake port holds, tombstones included, in creation order. */
const taskNames = (port: FakeTaskPort): string[] => port.tasks.map((task) => task.input.name);

let stateDir: string;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-tasks-'));
  await writeTestSecrets(stateDir);
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A fake task port that logs each create's outcome in `events`. */
function loggingTaskPort(events: string[]): FakeTaskPort {
  const fake = createFakeTaskPort();
  return {
    ...fake,
    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      try {
        const result = await fake.create(input);
        events.push(`${result.created ? 'created' : 'exists'} ${input.name}`);
        return result;
      } catch (err) {
        events.push(`failed ${input.name}`);
        throw err;
      }
    },
  };
}

/** A ready people app whose `events` log each task create and each tenant-registry read made after start-up. */
interface ReadyApp extends TestApp {
  events: string[];
}

async function readyApp(): Promise<ReadyApp> {
  const events: string[] = [];
  const testApp = await buildTestApp({ taskPort: loggingTaskPort(events) });
  closers.push(testApp.close);
  events.length = 0;
  testApp.db.clear();
  testApp.db.respond(/tenant_registry/, () => {
    events.push('registry read');
    return [];
  });
  return { ...testApp, events };
}

/** People built from the port's registrars alone over a recording database; separate, as buildTestApp's ready app already holds the sweep route. */
async function registrarApp(recoveryHooks: readonly RecoveryHook[]): Promise<{ app: FastifyInstance; db: RecordingDb; taskPort: FakeTaskPort }> {
  const db = createRecordingDb();
  const app = await createService({
    name: PEOPLE_SERVICE,
    version: '1.0.0',
    env: testEnv({}, stateDir),
    verifierOverride: testVerifier(PEOPLE_SERVICE),
    clock: TEST_CLOCK,
    pool: db,
  });
  closers.push(() => app.opt2.shutdown());
  createOutbox({ service: PEOPLE_SERVICE, db, publisher: createCapturingPublisher(), logger: app.opt2.logger, clock: TEST_CLOCK });
  const taskPort = createFakeTaskPort();
  const wiring = { port: taskPort, serviceUrls: SERVICE_URLS, clock: TEST_CLOCK };
  registerSweep(app, { ...wiring, recoveryHooks });
  registerQueueControlRoutes(app, wiring);
  await app.ready();
  return { app, db, taskPort };
}

/** Delivers the sweep task of `slotS` with the headers and wire body the tasks adapters send; a tasks-invoker token by default. */
async function deliverSweep(
  app: FastifyInstance,
  slotS: number,
  opts: { credentials?: Record<string, string>; retryCount?: number } = {},
): Promise<InjectResponse> {
  const input = sweepTaskInput(slotS);
  const credentials = opts.credentials ?? { authorization: `Bearer ${await mintTasksInvokerToken({ audience: PEOPLE_SERVICE })}` };
  return app.inject({
    method: 'POST',
    url: OUTBOX_SWEEP_PATH,
    headers: {
      ...credentials,
      'content-type': 'application/json',
      [CLOUD_TASKS_HEADERS.taskName]: input.name,
      [CLOUD_TASKS_HEADERS.queueName]: PEOPLE_SWEEP_QUEUE,
      [CLOUD_TASKS_HEADERS.retryCount]: String(opts.retryCount ?? 0),
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(slotS),
    },
    payload: JSON.stringify(taskWireBody(input)),
  });
}

/** Posts one queue-control operation on `queue`, people's sweep queue by default. */
function controlQueue(app: FastifyInstance, op: QueueControlOp, headers: Record<string, string>, queue: string = PEOPLE_SWEEP_QUEUE): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url: `${QUEUE_CONTROL_PREFIX}/${queue}/${op}`, headers });
}

describe('people outbox-sweep chain', () => {
  it('names its sweep queue people-outbox-sweep, recurring every 60 s on the sweep route the app registers', async () => {
    const { app } = await readyApp();

    expect(outboxSweepQueue('people')).toBe('people-outbox-sweep');
    expect(PEOPLE_SWEEP_QUEUE).toBe('people-outbox-sweep');
    expect(queueDefinition(PEOPLE_SWEEP_QUEUE)).toMatchObject({
      targetService: PEOPLE_SERVICE,
      targetPath: OUTBOX_SWEEP_PATH,
      creators: [PEOPLE_SERVICE],
      recurring: { intervalS: OUTBOX_SWEEP_INTERVAL_S },
    });
    expect(app.hasRoute({ method: 'POST', url: OUTBOX_SWEEP_PATH })).toBe(true);
  });

  it('creates the next slot task before it sweeps, then answers 200 with the sweep totals and the roster-operations hook', async () => {
    const { app, taskPort, events } = await readyApp();

    const res = await deliverSweep(app, CURRENT_SLOT_S);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ ...EMPTY_SWEEP, hooks: [{ name: 'roster-operations', ok: true }] });
    // One registry read by the sweep, one by the roster-operations hook.
    expect(events).toStrictEqual([`created ${NEXT_TASK}`, 'registry read', 'registry read']);
    expect(taskPort.tasks.at(-1)).toStrictEqual({ input: sweepTaskInput(NEXT_SLOT_S), deleted: false });
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK, NEXT_TASK]);
  });

  it('answers the legacy 503 and sweeps nothing when the successor cannot be created, then succeeds on the queue retry', async () => {
    const { app, taskPort, db, events } = await readyApp();
    taskPort.failCreate(1, PEOPLE_SWEEP_QUEUE);

    const failed = await deliverSweep(app, CURRENT_SLOT_S);

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: { message: 'Unhandled Exception' } });
    expect(events).toStrictEqual([`failed ${NEXT_TASK}`]);
    expect(db.statements().filter((statement) => statement.text.includes('tenant_registry'))).toStrictEqual([]);
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK]);

    const retried = await deliverSweep(app, CURRENT_SLOT_S, { retryCount: 1 });

    expect(retried.statusCode).toBe(200);
    expect(events).toStrictEqual([`failed ${NEXT_TASK}`, `created ${NEXT_TASK}`, 'registry read', 'registry read']);
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK, NEXT_TASK]);
  });

  it('creates no second successor when the same slot is delivered again, and answers it 200 as well', async () => {
    const { app, taskPort, events } = await readyApp();

    const first = await deliverSweep(app, CURRENT_SLOT_S);
    const repeated = await deliverSweep(app, CURRENT_SLOT_S, { retryCount: 1 });

    expect([first.statusCode, repeated.statusCode]).toStrictEqual([200, 200]);
    expect(repeated.json()).toStrictEqual(first.json());
    expect(events).toStrictEqual([`created ${NEXT_TASK}`, 'registry read', 'registry read', `exists ${NEXT_TASK}`, 'registry read', 'registry read']);
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK, NEXT_TASK]);
  });

  it.each<[string, Credentials]>([
    ['no credential', () => Promise.resolve({})],
    ['a user token arriving through the gateway', () => userHeaders({ sub: 'test-s2', site: 'tenant-a', roles: ['system-user', 's2'], s2: true })],
    ["the gateway's invocation credential", () => headersFor('service:gateway')],
    ["the migration service's invocation credential", () => headersFor('service:migration')],
    [
      'a gateway service token in Authorization',
      async () => ({ authorization: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: PEOPLE_SERVICE })}` }),
    ],
    [
      'a tasks-invoker token addressed to another service',
      async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'identity' })}` }),
    ],
  ])('refuses the sweep presented with %s before any task or sweep work', async (_label, credentials) => {
    const { app, taskPort, events } = await readyApp();

    const res = await deliverSweep(app, CURRENT_SLOT_S, { credentials: await credentials() });

    expect(res.statusCode).toBe(401);
    expect(events).toStrictEqual([]);
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK]);
  });

  it('runs the recovery hooks given to registerSweep once per sweep with the sweep context, after the successor exists', async () => {
    const tasksAtRun: string[][] = [];
    const run = vi.fn<(ctx: RecoveryContext) => Promise<void>>();
    const { app, db, taskPort } = await registrarApp([{ name: 'spy', run }]);
    run.mockImplementation(async () => {
      tasksAtRun.push(taskNames(taskPort));
    });

    const res = await deliverSweep(app, CURRENT_SLOT_S);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ ...EMPTY_SWEEP, hooks: [{ name: 'spy', ok: true }] });
    expect(run).toHaveBeenCalledOnce();
    expect(tasksAtRun).toStrictEqual([[NEXT_TASK]]);
    expect(run).toHaveBeenCalledWith({
      service: PEOPLE_SERVICE,
      runtime: expect.objectContaining({ service: PEOPLE_SERVICE, db }),
      clock: TEST_CLOCK,
      logger: expect.anything(),
    });
  });

  it('does not run the recovery hooks when the successor cannot be created', async () => {
    const run = vi.fn<(ctx: RecoveryContext) => Promise<void>>();
    const { app, taskPort } = await registrarApp([{ name: 'spy', run }]);
    taskPort.failCreate();

    const res = await deliverSweep(app, CURRENT_SLOT_S);

    expect(res.statusCode).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('people queue control', () => {
  it('registers pause, resume and ensure for its queues on the registrar app', async () => {
    const { app } = await registrarApp([]);

    for (const op of ['pause', 'resume', 'ensure'] satisfies QueueControlOp[]) {
      expect(app.hasRoute({ method: 'POST', url: `${QUEUE_CONTROL_PREFIX}/:queue/${op}` })).toBe(true);
    }
  });

  it.each(['service:migration', 'service:operator'])('pauses, resumes and ensures people-outbox-sweep for %s', async (caller) => {
    const { app, taskPort } = await readyApp();
    const headers = await headersFor(caller);

    const paused = await controlQueue(app, 'pause', headers);
    expect([paused.statusCode, paused.json()]).toStrictEqual([
      200,
      { queue: PEOPLE_SWEEP_QUEUE, service: PEOPLE_SERVICE, paused: true, running: 0 } satisfies QueueControlResult,
    ]);
    expect(await taskPort.queueState(PEOPLE_SWEEP_QUEUE)).toStrictEqual({ queue: PEOPLE_SWEEP_QUEUE, paused: true });

    const resumed = await controlQueue(app, 'resume', headers);
    expect([resumed.statusCode, resumed.json()]).toStrictEqual([
      200,
      { queue: PEOPLE_SWEEP_QUEUE, service: PEOPLE_SERVICE, paused: false } satisfies QueueControlResult,
    ]);
    expect(await taskPort.queueState(PEOPLE_SWEEP_QUEUE)).toStrictEqual({ queue: PEOPLE_SWEEP_QUEUE, paused: false });

    await taskPort.delete(PEOPLE_SWEEP_QUEUE, CURRENT_TASK);
    const ensured = await controlQueue(app, 'ensure', headers);
    expect([ensured.statusCode, ensured.json()]).toStrictEqual([
      200,
      {
        queue: PEOPLE_SWEEP_QUEUE,
        service: PEOPLE_SERVICE,
        ensured: { queue: PEOPLE_SWEEP_QUEUE, name: NEXT_TASK, created: true, reason: 'created-next' },
      } satisfies QueueControlResult,
    ]);
    expect(await taskPort.get(PEOPLE_SWEEP_QUEUE, NEXT_TASK)).toMatchObject({ queue: PEOPLE_SWEEP_QUEUE, name: NEXT_TASK, status: 'pending' });
  });

  it.each<[string, Credentials, number]>([
    ['no credential', () => Promise.resolve({}), 401],
    ['a tasks-invoker token', async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: PEOPLE_SERVICE })}` }), 401],
    ["the gateway's invocation credential", () => headersFor('service:gateway'), 403],
    ["identity's invocation credential", () => headersFor('service:identity'), 403],
    ['an s2 user', () => headersFor('s2'), 403],
    ['a site admin', () => headersFor('site-admin'), 403],
  ])('refuses pause, resume and ensure to %s and leaves the queue as it was', async (_label, credentials, status) => {
    const { app, taskPort } = await readyApp();
    const headers = await credentials();

    expect((await controlQueue(app, 'pause', headers)).statusCode).toBe(status);
    expect((await taskPort.queueState(PEOPLE_SWEEP_QUEUE)).paused).toBe(false);

    await taskPort.pauseQueue(PEOPLE_SWEEP_QUEUE);
    expect((await controlQueue(app, 'resume', headers)).statusCode).toBe(status);
    expect((await taskPort.queueState(PEOPLE_SWEEP_QUEUE)).paused).toBe(true);

    await taskPort.delete(PEOPLE_SWEEP_QUEUE, CURRENT_TASK);
    expect((await controlQueue(app, 'ensure', headers)).statusCode).toBe(status);
    expect(await taskPort.list(PEOPLE_SWEEP_QUEUE)).toStrictEqual({ tasks: [] });
  });

  it.each([outboxSweepQueue('identity'), SITEMONITOR_QUEUE, 'no-such-queue'])('answers 400 for %s, a queue people does not create', async (queue) => {
    const { app, taskPort } = await readyApp();
    const headers = await headersFor('service:operator');

    for (const op of ['pause', 'resume', 'ensure'] satisfies QueueControlOp[]) {
      expect((await controlQueue(app, op, headers, queue)).statusCode).toBe(400);
    }
    expect(await taskPort.queueState(queue)).toStrictEqual({ queue, paused: false });
    expect(taskNames(taskPort)).toStrictEqual([CURRENT_TASK]);
  });
});

describe('people start-up chain and task port', () => {
  it('holds exactly the current sweep slot task once the app is ready', async () => {
    const { taskPort, env } = await readyApp();

    expect(env.OPT2_SERVICE_URLS.people).toBe(SERVICE_URLS.people);
    expect(taskPort.tasks).toStrictEqual([{ input: sweepTaskInput(CURRENT_SLOT_S), deleted: false }]);
  });

  it('ensures the current slot from a mid-slot clock once, finds it live on a second call and never creates a site-monitor chain', async () => {
    const port = createFakeTaskPort();
    const clock = fixedClock(TEST_CLOCK.now().getTime() + 42_000);

    const first = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock });
    const second = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock });

    expect(first).toStrictEqual([{ queue: PEOPLE_SWEEP_QUEUE, name: CURRENT_TASK, created: true, reason: 'created-current' }]);
    expect(second).toStrictEqual([{ queue: PEOPLE_SWEEP_QUEUE, name: CURRENT_TASK, created: false, reason: 'live' }]);
    expect(port.tasks).toStrictEqual([{ input: sweepTaskInput(CURRENT_SLOT_S), deleted: false }]);
    expect(port.tasks.filter((task) => task.input.queue === SITEMONITOR_QUEUE)).toStrictEqual([]);
  });

  it('builds the local adapter over the injected database, which answers from people.scheduled_task_queue without dispatching', async () => {
    const { app } = await readyApp();
    const db = createRecordingDb();

    const port = await createPeopleTaskPort(testEnv({ OPT2_TASKS_ADAPTER: 'local' }, stateDir), { db, clock: TEST_CLOCK, logger: app.opt2.logger });
    closers.push(() => port.close());

    expect(port.kind).toBe('local');
    expect(await port.list(PEOPLE_SWEEP_QUEUE)).toStrictEqual({ tasks: [] });
    expect(db.statements().some((statement) => statement.text.includes('people.scheduled_task_queue'))).toBe(true);
    expect(db.writes()).toStrictEqual([]);
  });

  it('raises the platform configuration error when the selected cloud adapter has no project', async () => {
    const { app, env, db } = await readyApp();

    await expect(
      createPeopleTaskPort({ ...env, OPT2_TASKS_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: undefined }, { db, clock: TEST_CLOCK, logger: app.opt2.logger }),
    ).rejects.toBeInstanceOf(TaskPortConfigError);
  });
});
