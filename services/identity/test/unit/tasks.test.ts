/** Identity's outbox-sweep chain, start-up chain, queue-control routes and task-port factory over the fake task port, offline. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_PATH,
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
} from '@opt2/platform/tasks';
import { fixedClock, mintServiceToken, mintTasksInvokerToken } from '@opt2/platform/testing';
import { IDENTITY_SERVICE, createIdentityTaskPort, ensureStartupChains } from '../../src/tasks/port.js';
import { TEST_CLOCK, buildTestApp, createFakeTaskPort, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';

const SWEEP_QUEUE = outboxSweepQueue(IDENTITY_SERVICE);
const SWEEP_INTERVAL_S = 60;
const SWEEP_DEADLINE_S = queueDefinition(SWEEP_QUEUE).deadlineS;
const SERVICE_URLS = Object.freeze({ identity: 'http://127.0.0.1:8111' });
const SWEEP_URL = `${SERVICE_URLS.identity}${OUTBOX_SWEEP_PATH}`;
const CURRENT_SLOT_S = slotStartS(Math.floor(TEST_CLOCK.now().getTime() / 1000), SWEEP_INTERVAL_S);
const NEXT_SLOT_S = CURRENT_SLOT_S + SWEEP_INTERVAL_S;
const CURRENT_TASK = slotName(SWEEP_QUEUE, CURRENT_SLOT_S);
const NEXT_TASK = slotName(SWEEP_QUEUE, NEXT_SLOT_S);

type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

/** Key under which the fake port holds a sweep task. */
const sweepKey = (name: string): string => `${SWEEP_QUEUE}/${name}`;

/** The create input of the sweep chain task of `slotS`, as the chain schedules it. */
function sweepTaskInput(slotS: number): CreateTaskInput {
  return {
    queue: SWEEP_QUEUE,
    name: slotName(SWEEP_QUEUE, slotS),
    scheduleTime: new Date(slotS * 1000),
    url: SWEEP_URL,
    deadlineS: SWEEP_DEADLINE_S,
    body: { slotStartS: slotS },
  };
}

/** A ready identity app over the fakes, whose `events` log each task create and each sweep registry read made after start-up. */
interface ReadyApp extends TestApp {
  events: string[];
}

const opened: TestApp[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

/** Builds identity over a fake task port whose creates are logged, readies it, then starts logging sweep registry reads. */
async function readyApp(): Promise<ReadyApp> {
  const events: string[] = [];
  const fake = createFakeTaskPort();
  const taskPort: FakeTaskPort = {
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
  const testApp = await buildTestApp({ taskPort });
  opened.push(testApp);
  await testApp.app.ready();
  events.length = 0;
  testApp.db.clear();
  testApp.db.respond(/tenant_registry/, () => {
    events.push('registry read');
    return [];
  });
  return { ...testApp, events };
}

/** Delivers the sweep task of `slotS` with the headers and wire body the tasks adapters send; a tasks-invoker token by default. */
async function deliverSweep(
  app: TestApp['app'],
  slotS: number,
  opts: { credentials?: Record<string, string>; retryCount?: number } = {},
): Promise<InjectResponse> {
  const input = sweepTaskInput(slotS);
  const credentials = opts.credentials ?? { authorization: `Bearer ${await mintTasksInvokerToken({ audience: IDENTITY_SERVICE })}` };
  return app.inject({
    method: 'POST',
    url: OUTBOX_SWEEP_PATH,
    headers: {
      ...credentials,
      'content-type': 'application/json',
      [CLOUD_TASKS_HEADERS.taskName]: input.name,
      [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
      [CLOUD_TASKS_HEADERS.retryCount]: String(opts.retryCount ?? 0),
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(slotS),
    },
    payload: JSON.stringify(taskWireBody(input)),
  });
}

/** Posts one queue-control operation on identity's sweep queue. */
function controlSweepQueue(app: TestApp['app'], op: QueueControlOp, headers: Record<string, string>): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/${op}`, headers });
}

describe('identity outbox-sweep chain', () => {
  it('names its sweep queue identity-outbox-sweep, recurring every 60 s on the sweep route', () => {
    expect(outboxSweepQueue('identity')).toBe('identity-outbox-sweep');
    expect(queueDefinition('identity-outbox-sweep')).toMatchObject({
      targetService: IDENTITY_SERVICE,
      targetPath: OUTBOX_SWEEP_PATH,
      creators: [IDENTITY_SERVICE],
      recurring: { intervalS: SWEEP_INTERVAL_S },
    });
  });

  it('creates the next slot task before it sweeps, then answers 200 with the sweep totals', async () => {
    const { app, taskPort, events } = await readyApp();

    const res = await deliverSweep(app, CURRENT_SLOT_S);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ published: 0, failed: 0, skipped: 0, tenants: 0, hooks: [] });
    expect(events).toStrictEqual([`created ${NEXT_TASK}`, 'registry read']);
    expect(taskPort.tasks.get(sweepKey(NEXT_TASK))).toStrictEqual({ input: sweepTaskInput(NEXT_SLOT_S), deleted: false });
  });

  it('answers the legacy 503 and sweeps nothing when the successor cannot be created, then succeeds on the queue retry', async () => {
    const { app, taskPort, db, events } = await readyApp();
    taskPort.failCreate(SWEEP_QUEUE);

    const failed = await deliverSweep(app, CURRENT_SLOT_S);

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: { message: 'Unhandled Exception' } });
    expect(events).toStrictEqual([`failed ${NEXT_TASK}`]);
    expect(db.statements().filter((statement) => statement.sql.includes('tenant_registry'))).toStrictEqual([]);
    expect([...taskPort.tasks.keys()]).toStrictEqual([sweepKey(CURRENT_TASK)]);

    const retried = await deliverSweep(app, CURRENT_SLOT_S, { retryCount: 1 });

    expect(retried.statusCode).toBe(200);
    expect(events).toStrictEqual([`failed ${NEXT_TASK}`, `created ${NEXT_TASK}`, 'registry read']);
    expect([...taskPort.tasks.keys()]).toStrictEqual([sweepKey(CURRENT_TASK), sweepKey(NEXT_TASK)]);
  });

  it('creates no second successor when the same slot is delivered again, and answers it 200 as well', async () => {
    const { app, taskPort, events } = await readyApp();

    const first = await deliverSweep(app, CURRENT_SLOT_S);
    const repeated = await deliverSweep(app, CURRENT_SLOT_S, { retryCount: 1 });

    expect([first.statusCode, repeated.statusCode]).toStrictEqual([200, 200]);
    expect(repeated.json()).toStrictEqual(first.json());
    expect(events).toStrictEqual([`created ${NEXT_TASK}`, 'registry read', `exists ${NEXT_TASK}`, 'registry read']);
    expect([...taskPort.tasks.keys()]).toStrictEqual([sweepKey(CURRENT_TASK), sweepKey(NEXT_TASK)]);
  });

  it.each<[string, () => Promise<Record<string, string>>]>([
    ['no credential', () => Promise.resolve({})],
    ['a user token', () => headersFor('s2')],
    ["the gateway's invocation credential", () => headersFor('service:gateway')],
    ["the migration service's invocation credential", () => headersFor('service:migration')],
    [
      'a gateway service token in Authorization',
      async () => ({ authorization: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: IDENTITY_SERVICE })}` }),
    ],
    [
      'a tasks-invoker token addressed to another service',
      async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'people' })}` }),
    ],
  ])('refuses the sweep presented with %s before any task or sweep work', async (_label, credentials) => {
    const { app, taskPort, events } = await readyApp();

    const res = await deliverSweep(app, CURRENT_SLOT_S, { credentials: await credentials() });

    expect(res.statusCode).toBe(401);
    expect(events).toStrictEqual([]);
    expect([...taskPort.tasks.keys()]).toStrictEqual([sweepKey(CURRENT_TASK)]);
  });
});

describe('identity start-up chain', () => {
  it('holds exactly the current sweep slot task once the app is ready', async () => {
    const { taskPort, env } = await readyApp();

    expect(env.OPT2_SERVICE_URLS.identity).toBe(SERVICE_URLS.identity);
    expect([...taskPort.tasks.entries()]).toStrictEqual([[sweepKey(CURRENT_TASK), { input: sweepTaskInput(CURRENT_SLOT_S), deleted: false }]]);
  });

  it('ensures the current slot from a mid-slot clock once, finds it live on a second call and never touches the site monitor', async () => {
    const port = createFakeTaskPort();
    const clock = fixedClock(TEST_CLOCK.now().getTime() + 42_000);

    const first = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock });
    const second = await ensureStartupChains(port, { serviceUrls: SERVICE_URLS, clock });

    expect(first).toStrictEqual([{ queue: SWEEP_QUEUE, name: CURRENT_TASK, created: true, reason: 'created-current' }]);
    expect(second).toStrictEqual([{ queue: SWEEP_QUEUE, name: CURRENT_TASK, created: false, reason: 'live' }]);
    expect([...port.tasks.keys()]).toStrictEqual([sweepKey(CURRENT_TASK)]);
    expect([...port.tasks.values()].filter((task) => task.input.queue === SITEMONITOR_QUEUE)).toStrictEqual([]);
  });

  it('raises the platform configuration error when the selected adapter cannot be built', async () => {
    const { app, env, db } = await readyApp();

    await expect(
      createIdentityTaskPort(
        { ...env, OPT2_TASKS_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: undefined },
        { db, clock: TEST_CLOCK, logger: app.opt2.logger },
      ),
    ).rejects.toBeInstanceOf(TaskPortConfigError);
  });
});

describe('identity queue control', () => {
  it.each(['service:migration', 'service:operator'])('pauses, resumes and ensures identity-outbox-sweep for %s', async (caller) => {
    const { app, taskPort } = await readyApp();
    const headers = await headersFor(caller);

    const paused = await controlSweepQueue(app, 'pause', headers);
    expect([paused.statusCode, paused.json()]).toStrictEqual([200, { queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, paused: true, running: 0 }]);
    expect(await taskPort.queueState(SWEEP_QUEUE)).toStrictEqual({ queue: SWEEP_QUEUE, paused: true });

    const resumed = await controlSweepQueue(app, 'resume', headers);
    expect([resumed.statusCode, resumed.json()]).toStrictEqual([200, { queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, paused: false }]);
    expect(await taskPort.queueState(SWEEP_QUEUE)).toStrictEqual({ queue: SWEEP_QUEUE, paused: false });

    await taskPort.delete(SWEEP_QUEUE, CURRENT_TASK);
    const ensured = await controlSweepQueue(app, 'ensure', headers);
    expect([ensured.statusCode, ensured.json()]).toStrictEqual([
      200,
      { queue: SWEEP_QUEUE, service: IDENTITY_SERVICE, ensured: { queue: SWEEP_QUEUE, name: NEXT_TASK, created: true, reason: 'created-next' } },
    ]);
    expect(await taskPort.get(SWEEP_QUEUE, NEXT_TASK)).toMatchObject({ queue: SWEEP_QUEUE, name: NEXT_TASK, status: 'pending' });
  });

  it.each(['service:gateway', 's2', 'site-admin'])('refuses pause, resume and ensure to %s with 403 and leaves the queue as it was', async (subject) => {
    const { app, taskPort } = await readyApp();
    const headers = await headersFor(subject);

    expect((await controlSweepQueue(app, 'pause', headers)).statusCode).toBe(403);
    expect((await taskPort.queueState(SWEEP_QUEUE)).paused).toBe(false);

    await taskPort.pauseQueue(SWEEP_QUEUE);
    expect((await controlSweepQueue(app, 'resume', headers)).statusCode).toBe(403);
    expect((await taskPort.queueState(SWEEP_QUEUE)).paused).toBe(true);

    await taskPort.delete(SWEEP_QUEUE, CURRENT_TASK);
    expect((await controlSweepQueue(app, 'ensure', headers)).statusCode).toBe(403);
    expect(await taskPort.list(SWEEP_QUEUE)).toStrictEqual({ tasks: [] });
  });
});
