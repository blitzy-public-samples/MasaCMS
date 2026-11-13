import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '../../src/auth/index.js';
import {
  createPublisher,
  decodeEnvelopeData,
  eventsSql,
  registerPushSubscription,
  subscriptionName,
  type ConsumerDefinition,
  type EventEnvelope,
  type EventPublisher,
} from '../../src/events/index.js';
import { createLogger } from '../../src/logging/index.js';
import { parseArgs, runReplay, type ReplayOptions } from '../../src/outbox/cli.js';
import {
  createOutbox,
  outboxDrainCounts,
  outboxSql,
  outboxTable,
  registerOutboxSweep,
  resetOutboxRuntimes,
  sweepOutbox,
  writeOutbox,
  type OutboxDrainCounts,
  type OutboxRuntime,
  type OutboxWriteInput,
  type RecoveryContext,
  type RecoveryHook,
  type SweepResult,
} from '../../src/outbox/index.js';
import { createService, loadEnv, type Clock, type FastifyInstance } from '../../src/service-kit/index.js';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  UnknownTaskTargetError,
  createLocalTaskAdapter,
  outboxSweepQueue,
  scheduledTaskQueueSql,
  slotName,
  slotStartS,
  successorSlotS,
  taskWireBody,
  type LocalTaskPort,
  type TaskPort,
} from '../../src/tasks/index.js';
import { rlsSql, tenantDbFromPool, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  businessClock,
  createCapturingPublisher,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushTo,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type TestSubscription,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
const QUEUE = outboxSweepQueue(SERVICE);
const SERVICE_URLS = { stub: 'http://127.0.0.1:8199' } as const;
const WAIT_MS = 10_000;
const CLOCK = businessClock();
const REQUIRED_ENV = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE', 'PUBSUB_EMULATOR_HOST'] as const;

const silentLogger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });

/** Tenant-owned aggregate table the note consumer projects into. */
const AGGREGATE_SQL = [
  'CREATE TABLE stub.test_aggregate (',
  '  tenant_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL,',
  '  version integer NOT NULL,',
  '  value text NOT NULL,',
  '  PRIMARY KEY (tenant_id, aggregate_id)',
  ');',
  rlsSql(SERVICE, 'test_aggregate'),
].join('\n');

/** Payload schema of the note topic: a `state` event carrying the aggregate's value. */
const NOTE_SCHEMA = {
  'x-opt2-kind': 'state',
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'string' } },
  additionalProperties: false,
};

interface NotePayload {
  value: string;
}

interface NoteRow {
  aggregate_id: string;
  version: number;
  value: string;
}

/** Inbox row count and projected notes of one tenant. */
interface ConsumerState {
  inbox: number;
  aggregates: NoteRow[];
}

/** Resources of one suite: schema with seeded registry, emulator topic, its observer, a publisher and a state directory. */
interface Fixture {
  handle: ThrowawaySchema;
  topic: TestTopic;
  observer: TestSubscription;
  publisher: EventPublisher;
  stateDir: string;
}

/** Cleanup steps run in reverse registration order; every step runs and failures are rethrown together. */
function cleanupStack() {
  const steps: Array<() => Promise<unknown> | unknown> = [];
  return {
    add(step: () => Promise<unknown> | unknown): void {
      steps.push(step);
    },
    async run(): Promise<void> {
      const failures: unknown[] = [];
      for (const step of steps.splice(0).reverse()) {
        try {
          await step();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'outbox sweep suite cleanup failed');
    },
  };
}

type CleanupStack = ReturnType<typeof cleanupStack>;

/** Throws naming each unset variable the suite needs, or the service that does not answer. */
async function requireServices(): Promise<void> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`The outbox sweep suite needs PostgreSQL 16 and the Pub/Sub emulator; set ${missing.join(', ')}`);
  }
  if (!(await pgAvailable())) {
    throw new Error(`PostgreSQL at PG_HOST=${process.env.PG_HOST} PG_PORT=${process.env.PG_PORT ?? '5432'} refuses connections`);
  }
  if (!(await pubsubEmulatorAvailable())) {
    throw new Error(`The Pub/Sub emulator at PUBSUB_EMULATOR_HOST=${process.env.PUBSUB_EMULATOR_HOST} does not answer`);
  }
}

/** Creates the suite's resources, registering the cleanup of each as soon as it exists. */
async function openFixture(cleanup: CleanupStack): Promise<Fixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'opt2-outbox-sweep-'));
  cleanup.add(() => rm(stateDir, { recursive: true, force: true }));
  await writeTestSecrets(stateDir);
  const handle = await createThrowawaySchema({
    service: SERVICE,
    extraSql: [outboxSql(SERVICE), eventsSql(SERVICE), tenantRegistrySql(SERVICE), scheduledTaskQueueSql(SERVICE), AGGREGATE_SQL],
  });
  cleanup.add(() => handle.drop());
  await seedRegistry(handle.app);
  const topic = await createTestTopic(SERVICE);
  cleanup.add(() => topic.delete());
  const observer = await createTestSubscription(topic, { consumer: 'observer' });
  cleanup.add(() => observer.delete());
  const publisher = createPublisher({ projectId: topic.topic.pubsub.projectId, emulatorHost: process.env.PUBSUB_EMULATOR_HOST });
  cleanup.add(() => publisher.close());
  return { handle, topic, observer, publisher, stateDir };
}

/** A publisher whose every publish rejects, as in a process that cannot reach Pub/Sub. */
function failingPublisher(): EventPublisher {
  const unavailable = (): Promise<string> => Promise.reject(new Error('Pub/Sub unavailable'));
  return { publish: unavailable, publishRaw: unavailable, close: () => Promise.resolve() };
}

/** Registers and returns the fixture schema's outbox runtime publishing through `publisher`. */
function runtimeOf(fx: Fixture, publisher: EventPublisher, clock: Clock = CLOCK): OutboxRuntime {
  return createOutbox({ service: SERVICE, db: fx.handle.app, publisher, logger: silentLogger, clock });
}

/** A version-1 state event of a fresh note aggregate on the fixture topic, with `extra` overriding its fields. */
function note(fx: Fixture, extra: Partial<OutboxWriteInput<NotePayload>> = {}): OutboxWriteInput<NotePayload> {
  const aggregateId = `note-${randomUUID()}`;
  return {
    topic: fx.topic.name,
    kind: 'state',
    aggregateType: 'note',
    aggregateId,
    aggregateVersion: 1,
    payload: { value: aggregateId },
    ...extra,
  };
}

/** Writes `inputs` in one transaction of `tenantId` through `runtime`, or the registered one; resolves after its commit flush. */
async function write(
  fx: Fixture,
  tenantId: string,
  inputs: readonly OutboxWriteInput<NotePayload>[],
  runtime?: OutboxRuntime,
): Promise<EventEnvelope<NotePayload>[]> {
  return withTenant(fx.handle.app, tenantId, async (tx) => {
    const envelopes: EventEnvelope<NotePayload>[] = [];
    for (const input of inputs) {
      const envelope = await writeOutbox(tx, input, runtime);
      if (envelope === null) throw new Error(`The state event on ${input.topic} was suppressed`);
      envelopes.push(envelope);
    }
    return envelopes;
  });
}

function ids(envelopes: readonly EventEnvelope[]): string[] {
  return envelopes.map((envelope) => envelope.eventId);
}

/** Writes `count` fresh notes under `tenantId` through a runtime that cannot publish; returns their event ids. */
async function seedUnpublished(fx: Fixture, tenantId: string, count: number): Promise<string[]> {
  const failing = runtimeOf(fx, failingPublisher());
  return ids(await write(fx, tenantId, Array.from({ length: count }, () => note(fx)), failing));
}

/** Event ids of `tenantId`'s unpublished, unheld outbox rows in `seq` order. */
async function unpublished(fx: Fixture, tenantId: string): Promise<string[]> {
  return withTenant(fx.handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ event_id: string }>(
      `SELECT event_id FROM ${outboxTable(fx.handle.schema)} WHERE published_at IS NULL AND NOT held ORDER BY seq`,
    );
    return rows.map((row) => row.event_id);
  });
}

/** Stored `published_at` text, or null, of each of `eventIds` visible under `tenantId`. */
async function publishedAt(fx: Fixture, tenantId: string, eventIds: readonly string[]): Promise<Record<string, string | null>> {
  return withTenant(fx.handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ event_id: string; published_at: string | null }>(
      `SELECT event_id, published_at::text AS published_at FROM ${outboxTable(fx.handle.schema)} WHERE event_id = ANY($1::uuid[])`,
      [eventIds],
    );
    return Object.fromEntries(rows.map((row) => [row.event_id, row.published_at]));
  });
}

/** Pulls from `subscription` until every id in `wanted` has arrived, failing after `deadlineMs`; returns every envelope pulled. */
async function pullUntil(subscription: TestSubscription, wanted: readonly string[], deadlineMs = WAIT_MS): Promise<EventEnvelope[]> {
  const deadline = Date.now() + deadlineMs;
  const pending = new Set(wanted);
  const pulled: EventEnvelope[] = [];
  while (pending.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${deadlineMs} ms waiting for events ${[...pending].join(', ')}`);
    for (const message of await subscription.pull(pending.size, Math.min(left, 5_000))) {
      const envelope = decodeEnvelopeData(message.data) as EventEnvelope;
      pulled.push(envelope);
      pending.delete(envelope.eventId);
    }
  }
  return pulled;
}

/** A stub service over the test keys, closed with the suite; `overrides` replace its environment variables. */
async function stubService(fx: Fixture, cleanup: CleanupStack, overrides: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const env = loadEnv(undefined, {
    PORT: '8199',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(SERVICE_URLS),
    OPT2_STATE_DIR: fx.stateDir,
    TZ: 'UTC',
    ...overrides,
  });
  const app = await createService({
    name: SERVICE,
    version: '1.0.0',
    env,
    verifierOverride: testVerifier(SERVICE),
    clock: CLOCK,
    logger: silentLogger,
  });
  cleanup.add(() => app.close());
  return app;
}

/** A stub service whose sweep route runs `runtime` behind `port`. */
async function sweepApp(
  fx: Fixture,
  cleanup: CleanupStack,
  opts: { port: TaskPort; runtime: OutboxRuntime; recoveryHooks?: readonly RecoveryHook[] },
): Promise<FastifyInstance> {
  const app = await stubService(fx, cleanup);
  registerOutboxSweep(app, { service: SERVICE, serviceUrls: { ...SERVICE_URLS }, clock: CLOCK, ...opts });
  return app;
}

/** Delivers the sweep chain task of slot `slotS` as the local tasks adapter does, with `credential` replacing its tasks-invoker token. */
async function injectSweep(app: FastifyInstance, slotS: number, credential?: Record<string, string>) {
  const name = slotName(QUEUE, slotS);
  const payload = taskWireBody({
    queue: QUEUE,
    name,
    scheduleTime: new Date(slotS * 1000),
    url: `${SERVICE_URLS.stub}${OUTBOX_SWEEP_PATH}`,
    deadlineS: 60,
    body: { slotStartS: slotS },
  });
  const auth = credential ?? { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
  return app.inject({
    method: 'POST',
    url: OUTBOX_SWEEP_PATH,
    headers: {
      ...auth,
      [CLOUD_TASKS_HEADERS.taskName]: name,
      [CLOUD_TASKS_HEADERS.queueName]: QUEUE,
      [CLOUD_TASKS_HEADERS.retryCount]: '0',
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(slotS),
    },
    payload,
  });
}

/** `counts` with `added` unpublished and held rows per tenant id, totals included. */
function shifted(counts: OutboxDrainCounts, added: Record<string, { unpublished: number; held: number }>): OutboxDrainCounts {
  const tenants = counts.tenants.map(({ tenantId, unpublished: pending, held }) => ({
    tenantId,
    unpublished: pending + (added[tenantId]?.unpublished ?? 0),
    held: held + (added[tenantId]?.held ?? 0),
  }));
  return {
    tenants,
    unpublished: tenants.reduce((sum, tenant) => sum + tenant.unpublished, 0),
    held: tenants.reduce((sum, tenant) => sum + tenant.held, 0),
  };
}

const epochSeconds = (clock: Clock): number => Math.floor(clock.now().getTime() / 1000);

describe('outbox sweep, drain counts and replay', () => {
  const cleanup = cleanupStack();
  let fx: Fixture;
  let taskPort: LocalTaskPort;
  const nowS = epochSeconds(CLOCK);
  const currentSlot = slotStartS(nowS, OUTBOX_SWEEP_INTERVAL_S);

  beforeAll(async () => {
    await requireServices();
    fx = await openFixture(cleanup);
    taskPort = await createLocalTaskAdapter({
      db: fx.handle.app,
      stateDir: fx.stateDir,
      serviceUrls: { ...SERVICE_URLS },
      clock: CLOCK,
      logger: silentLogger,
      autoStart: false,
    });
    cleanup.add(() => taskPort.close());
  });

  afterEach(() => resetOutboxRuntimes());

  afterAll(() => cleanup.run());

  /** Names of the live tasks on the sweep queue, sorted. */
  async function liveSweepTasks(): Promise<string[]> {
    return (await taskPort.list(QUEUE)).tasks.map((task) => task.name).sort();
  }

  it('publishes a committed row whose in-request flush failed on the next sweep', async () => {
    createOutbox({ service: SERVICE, db: fx.handle.app, publisher: failingPublisher(), logger: silentLogger, clock: CLOCK });
    const [written] = await write(fx, TENANT_A.tenantId, [note(fx)]);
    const eventId = (written as EventEnvelope).eventId;
    expect(await unpublished(fx, TENANT_A.tenantId)).toContain(eventId);

    resetOutboxRuntimes();
    const restarted = runtimeOf(fx, fx.publisher);
    const result = await sweepOutbox(restarted, { service: SERVICE, clock: CLOCK });

    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(result).toMatchObject({ failed: 0, tenants: TENANT_LIST.length, hooks: [] });
    expect((await publishedAt(fx, TENANT_A.tenantId, [eventId]))[eventId]).not.toBeNull();
    const pulled = await pullUntil(fx.observer, [eventId]);
    expect(pulled.find((envelope) => envelope.eventId === eventId)).toEqual(written);
  });

  it('publishes a committed row left behind when its runtime was torn down before the flush', async () => {
    const pool = fx.handle.connect('app', { max: 1 });
    const dying = runtimeOf(fx, fx.publisher);
    const tornDown: OutboxRuntime = { ...dying, db: tenantDbFromPool(pool, { schema: fx.handle.schema }) };
    const [written] = await withTenant(fx.handle.app, TENANT_B.tenantId, async (tx) => {
      const envelope = await writeOutbox(tx, note(fx), tornDown);
      // Ending the runtime's own pool before COMMIT leaves its flush unable to run, as when the process dies after committing.
      await pool.end();
      return [envelope];
    });
    const eventId = (written as EventEnvelope).eventId;
    expect(await unpublished(fx, TENANT_B.tenantId)).toContain(eventId);

    resetOutboxRuntimes();
    const result = await sweepOutbox(runtimeOf(fx, fx.publisher), { service: SERVICE, clock: CLOCK });

    expect(result.failed).toBe(0);
    expect(await unpublished(fx, TENANT_B.tenantId)).not.toContain(eventId);
    expect(ids(await pullUntil(fx.observer, [eventId]))).toContain(eventId);
  });

  it('publishes each row exactly once when two sweeps run concurrently as the RLS-bound app role', async () => {
    // Earlier tests leave unpublished rows in the shared schema, so totals are measured from this baseline.
    const before = await outboxDrainCounts(fx.handle.app);
    const seeded = [
      ...(await seedUnpublished(fx, TENANT_A.tenantId, 12)),
      ...(await seedUnpublished(fx, TENANT_B.tenantId, 8)),
    ];
    const capture = createCapturingPublisher();
    const runtime = runtimeOf(fx, capture);
    const opts = { service: SERVICE, clock: CLOCK, batchSize: 4 };

    const results = await Promise.all([sweepOutbox(runtime, opts), sweepOutbox(runtime, opts)]);

    const captured = capture.published.map(({ envelope }) => envelope.eventId);
    expect(new Set(captured).size).toBe(captured.length);
    expect(captured).toEqual(expect.arrayContaining(seeded));
    expect(results.reduce((sum, result) => sum + result.published, 0)).toBe(before.unpublished + seeded.length);
    expect(results.map((result) => result.failed)).toEqual([0, 0]);
    expect((await outboxDrainCounts(fx.handle.app)).unpublished).toBe(0);

    const sweeper = await withTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ role: string }>('SELECT current_user AS role');
      return rows[0]?.role;
    });
    expect(sweeper).toBe(fx.handle.roles.app);
    const { rows: roles } = await fx.handle.adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [sweeper],
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const { rows: tables } = await fx.handle.adminPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass',
      [outboxTable(fx.handle.schema)],
    );
    expect(tables).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('creates the successor chain task before sweeping and answers with the sweep result', async () => {
    const seeded = await seedUnpublished(fx, TENANT_A.tenantId, 2);
    const capture = createCapturingPublisher();
    const successor = slotName(QUEUE, successorSlotS(currentSlot, nowS, OUTBOX_SWEEP_INTERVAL_S));
    const successorLiveDuringSweep: boolean[] = [];
    const probe: RecoveryHook = {
      name: 'probe',
      run: async () => {
        successorLiveDuringSweep.push((await taskPort.get(QUEUE, successor)) !== undefined);
      },
    };
    const app = await sweepApp(fx, cleanup, { port: taskPort, runtime: runtimeOf(fx, capture), recoveryHooks: [probe] });

    const response = await injectSweep(app, currentSlot);

    expect(response.statusCode).toBe(200);
    const result = response.json<SweepResult>();
    expect(result).toMatchObject({ failed: 0, tenants: TENANT_LIST.length, hooks: [{ name: 'probe', ok: true }] });
    expect(result.published).toBe(capture.published.length);
    expect(successor).toBe(`stub-outbox-sweep-${String(currentSlot + OUTBOX_SWEEP_INTERVAL_S)}`);
    expect(await liveSweepTasks()).toContain(successor);
    expect(successorLiveDuringSweep).toEqual([true]);
    expect(capture.published.map(({ envelope }) => envelope.eventId)).toEqual(expect.arrayContaining(seeded));
    expect(Object.values(await publishedAt(fx, TENANT_A.tenantId, seeded))).not.toContain(null);
  });

  it.each([
    { label: 'unset', urls: undefined },
    { label: 'without its own entry', urls: JSON.stringify({ gateway: 'http://127.0.0.1:8100' }) },
  ])('fails registration naming OPT2_SERVICE_URLS when it is $label', async ({ urls }) => {
    const app = await stubService(fx, cleanup, { OPT2_SERVICE_URLS: urls });
    const register = () =>
      registerOutboxSweep(app, { service: SERVICE, port: taskPort, runtime: runtimeOf(fx, createCapturingPublisher()), clock: CLOCK });

    expect(register).toThrow(UnknownTaskTargetError);
    expect(register).toThrow('OPT2_SERVICE_URLS has no URL for task target: stub');
  });

  it('answers the legacy 503 and sweeps nothing when the successor task cannot be created', async () => {
    const seeded = await seedUnpublished(fx, TENANT_A.tenantId, 1);
    const capture = createCapturingPublisher();
    // The real adapter with only `create` failing, so the route's successor step is the single thing that differs.
    const unreachable: TaskPort = { ...taskPort, create: () => Promise.reject(new Error('Cloud Tasks unavailable')) };
    let hookRuns = 0;
    const probe: RecoveryHook = {
      name: 'probe',
      run: async () => {
        hookRuns += 1;
      },
    };
    const app = await sweepApp(fx, cleanup, { port: unreachable, runtime: runtimeOf(fx, capture), recoveryHooks: [probe] });

    const response = await injectSweep(app, currentSlot);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(capture.published).toEqual([]);
    expect(hookRuns).toBe(0);
    expect(await unpublished(fx, TENANT_A.tenantId)).toEqual(expect.arrayContaining(seeded));
  });

  it.each([
    { presented: 'no credential', credential: async () => ({}) },
    {
      presented: 'a user token',
      credential: async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: 'sweep-caller', site: TENANT_A.siteId, roles: ['s2'] })}`,
      }),
    },
    {
      presented: 'a gateway call on behalf of a user',
      credential: async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: 'sweep-caller', site: TENANT_A.siteId, roles: ['s2'] })}`,
        [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
      }),
    },
    {
      presented: 'a gateway service token',
      credential: async () => ({ authorization: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` }),
    },
    {
      presented: 'a tasks-invoker token for another service',
      credential: async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'people' })}` }),
    },
  ])('refuses a sweep task presenting $presented without sweeping or rescheduling', async ({ credential }) => {
    const seeded = await seedUnpublished(fx, TENANT_B.tenantId, 1);
    const capture = createCapturingPublisher();
    const app = await sweepApp(fx, cleanup, { port: taskPort, runtime: runtimeOf(fx, capture) });
    const tasksBefore = await liveSweepTasks();

    const response = await injectSweep(app, currentSlot + OUTBOX_SWEEP_INTERVAL_S, await credential());

    expect(response.statusCode).toBe(401);
    expect(capture.published).toEqual([]);
    expect(await unpublished(fx, TENANT_B.tenantId)).toEqual(expect.arrayContaining(seeded));
    expect(await liveSweepTasks()).toEqual(tasksBefore);
  });

  it('runs recovery hooks after publishing and reports each outcome in order', async () => {
    const seeded = await seedUnpublished(fx, TENANT_A.tenantId, 1);
    const runtime = runtimeOf(fx, createCapturingPublisher());
    const contexts: RecoveryContext[] = [];
    const pendingWhenRun: string[][] = [];
    const hooks: RecoveryHook[] = [
      {
        name: 'probe',
        run: async (ctx) => {
          contexts.push(ctx);
          pendingWhenRun.push(await unpublished(fx, TENANT_A.tenantId));
        },
      },
      { name: 'broken', run: () => Promise.reject(new Error('recovery failed')) },
    ];

    const result = await sweepOutbox(runtime, { service: SERVICE, clock: CLOCK, recoveryHooks: hooks });

    expect(result.hooks).toEqual([
      { name: 'probe', ok: true },
      { name: 'broken', ok: false },
    ]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.service).toBe(SERVICE);
    expect(contexts[0]?.runtime).toBe(runtime);
    expect(contexts[0]?.clock).toBe(CLOCK);
    expect(pendingWhenRun).toEqual([[]]);
    expect(Object.values(await publishedAt(fx, TENANT_A.tenantId, seeded))).not.toContain(null);
  });

  it('counts unpublished and held rows per registry tenant, and a sweep leaves only the held ones', async () => {
    const before = await outboxDrainCounts(fx.handle.app);
    await seedUnpublished(fx, TENANT_A.tenantId, 2);
    await write(fx, TENANT_A.tenantId, [note(fx, { operationId: `roster-${randomUUID()}` })], runtimeOf(fx, failingPublisher()));
    await seedUnpublished(fx, TENANT_B.tenantId, 1);

    const counts = await outboxDrainCounts(fx.handle.app);

    expect(counts).toEqual(
      shifted(before, {
        [TENANT_A.tenantId]: { unpublished: 2, held: 1 },
        [TENANT_B.tenantId]: { unpublished: 1, held: 0 },
      }),
    );
    expect(counts.tenants.map((tenant) => tenant.tenantId)).toEqual(TENANT_LIST.map((tenant) => tenant.tenantId).sort());

    await sweepOutbox(runtimeOf(fx, createCapturingPublisher()), { service: SERVICE, clock: CLOCK });

    const after = await outboxDrainCounts(fx.handle.app);
    expect(after).toEqual({
      tenants: counts.tenants.map(({ tenantId, held }) => ({ tenantId, unpublished: 0, held })),
      unpublished: 0,
      held: counts.held,
    });
  });

  it('replays unheld rows created since the given time with their original event ids and unchanged published_at', async () => {
    const later = fixedClock(new Date(2026, 6, 1, 9, 0, 0));
    const older = await write(fx, TENANT_A.tenantId, [note(fx)], runtimeOf(fx, fx.publisher));
    const live = runtimeOf(fx, fx.publisher, later);
    const recent = [
      ...(await write(fx, TENANT_A.tenantId, [note(fx), note(fx)], live)),
      ...(await write(fx, TENANT_B.tenantId, [note(fx)], live)),
    ];
    const held = await write(fx, TENANT_A.tenantId, [note(fx, { operationId: `roster-${randomUUID()}` })], live);
    await pullUntil(fx.observer, ids([...older, ...recent]));
    const stamps = async () => ({
      ...(await publishedAt(fx, TENANT_A.tenantId, ids([...older, ...recent]))),
      ...(await publishedAt(fx, TENANT_B.tenantId, ids(recent))),
    });
    const stampedBefore = await stamps();
    expect(Object.values(stampedBefore)).not.toContain(null);

    const { since } = parseArgs(['replay', '--since', new Date(2026, 6, 1).toISOString()]) as ReplayOptions;
    const summary = await runReplay({ runtime: live, since });

    expect(summary).toEqual({ replayed: recent.length, failed: 0, skipped: 0, tenants: TENANT_LIST.length });
    const replayed = await pullUntil(fx.observer, ids(recent));
    for (const original of recent) {
      expect(replayed.find((envelope) => envelope.eventId === original.eventId)).toEqual(original);
    }
    const trailing = (await fx.observer.pull(10, 1_000)).map((message) => (decodeEnvelopeData(message.data) as EventEnvelope).eventId);
    const received = [...ids(replayed), ...trailing];
    expect(received).not.toContain((older[0] as EventEnvelope).eventId);
    expect(received).not.toContain((held[0] as EventEnvelope).eventId);
    expect(await stamps()).toEqual(stampedBefore);
  });
});

// Its own schema and topic, so the full outbox it replays holds only events this suite's consumer has already applied.
describe('outbox replay of the full outbox', () => {
  const cleanup = cleanupStack();
  let fx: Fixture;
  let app: FastifyInstance;
  let subscription: string;
  const deadLetters = createCapturingPublisher();

  /** State consumer upserting each note into the fixture's `test_aggregate`. */
  function noteConsumer(topic: string, schema: string): ConsumerDefinition<NotePayload> {
    return {
      topic,
      kind: 'state',
      async apply(tx, envelope) {
        await tx.query(
          `INSERT INTO ${schema}.test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, $3, $4)` +
            ' ON CONFLICT (tenant_id, aggregate_id) DO UPDATE SET version = EXCLUDED.version, value = EXCLUDED.value',
          [tx.tenantId, envelope.aggregateId, envelope.aggregateVersion, envelope.payload.value],
        );
      },
    };
  }

  /** Inbox row count and projected notes of every fixture tenant, keyed by fixture. */
  async function consumerState(): Promise<Record<string, ConsumerState>> {
    const state: Record<string, ConsumerState> = {};
    for (const tenant of TENANT_LIST) {
      state[tenant.key] = await withTenant(fx.handle.app, tenant.tenantId, async (tx) => {
        const inbox = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${fx.handle.schema}.inbox`);
        const aggregates = await tx.query<NoteRow>(
          `SELECT aggregate_id, version, value FROM ${fx.handle.schema}.test_aggregate ORDER BY aggregate_id`,
        );
        return { inbox: inbox.rows[0]?.n ?? 0, aggregates: aggregates.rows };
      });
    }
    return state;
  }

  /** Pushes each envelope to the consumer route in order, expecting every delivery acked. */
  async function deliverAll(envelopes: readonly EventEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      const response = await pushTo(app, subscription, envelope);
      expect(response.statusCode, `delivery of ${envelope.eventId}`).toBe(204);
    }
  }

  beforeAll(async () => {
    await requireServices();
    fx = await openFixture(cleanup);
    subscription = subscriptionName(SERVICE, fx.topic.name);
    app = await stubService(fx, cleanup);
    registerPushSubscription(app, {
      subscription,
      consumer: noteConsumer(fx.topic.name, fx.handle.schema),
      payloadSchema: NOTE_SCHEMA,
      publisher: deadLetters,
      db: fx.handle.app,
    });
  });

  afterEach(() => resetOutboxRuntimes());

  afterAll(() => cleanup.run());

  it('leaves inbox counts and aggregate state unchanged when every replayed event is redelivered', async () => {
    const runtime = runtimeOf(fx, fx.publisher);
    const revised = `note-${randomUUID()}`;
    const written = [
      ...(await write(fx, TENANT_A.tenantId, [note(fx, { aggregateId: revised, payload: { value: 'first' } }), note(fx)], runtime)),
      ...(await write(fx, TENANT_A.tenantId, [note(fx, { aggregateId: revised, aggregateVersion: 2, payload: { value: 'second' } })], runtime)),
      ...(await write(fx, TENANT_B.tenantId, [note(fx), note(fx)], runtime)),
    ];
    await deliverAll(await pullUntil(fx.observer, ids(written)));
    const consumed = await consumerState();
    expect(consumed).toMatchObject({ A: { inbox: 3 }, B: { inbox: 2 }, umbrella: { inbox: 0, aggregates: [] } });
    expect(consumed.A?.aggregates).toContainEqual({ aggregate_id: revised, version: 2, value: 'second' });

    const summary = await runReplay({ runtime, since: new Date(0) });

    expect(summary).toEqual({ replayed: written.length, failed: 0, skipped: 0, tenants: TENANT_LIST.length });
    await deliverAll(await pullUntil(fx.observer, ids(written)));
    expect(await consumerState()).toEqual(consumed);
    expect(deadLetters.raw).toEqual([]);
  });
});
