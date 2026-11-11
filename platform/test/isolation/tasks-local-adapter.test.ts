import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastify, type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  QUEUES,
  SCHEDULED_TASK_QUEUE_STATE_TABLE,
  SCHEDULED_TASK_QUEUE_TABLE,
  createLocalTaskAdapter,
  ensureRecurring,
  outboxSweepQueue,
  parseTaskWireBody,
  recurringSpec,
  retryDelayS,
  scheduledTaskQueueSql,
  slotName,
  slotStartS,
  type CreateTaskInput,
  type LocalTaskPort,
  type TaskLogger,
} from '../../src/tasks/index.js';
import { TASKS_INVOKER_ROLE, createLocalCloudTasksTransport, loadLocalSigningKeys, transportForPath } from '../../src/auth/index.js';
import { SYSTEM_TENANT_ID, TENANT_SETTING, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import { MemorySpanExporter, shutdownTracing, startTracing, withExtractedContext } from '../../src/tracing/index.js';
import type { Clock } from '../../src/service-kit/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  runCleanup,
  seedRegistry,
  testPgConfig,
  writeTestSecrets,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const EXPORT_QUEUE = QUEUES['reporting-export-run'];
const QUEUE = EXPORT_QUEUE.name;
const SWEEP_QUEUE = outboxSweepQueue('stub');
const TASK_PATH = '/internal/v1/tasks/iso';
const KNOWN_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const PROBE_TENANTS = [TENANT_A.tenantId, TENANT_B.tenantId, TENANT_UMBRELLA.tenantId, SYSTEM_TENANT_ID] as const;
const HOUR_MS = 3_600_000;

interface Delivery {
  name: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

type StoredRow = {
  tenant_id: string;
  status: string;
  attempts: number;
  schedule_time: Date;
  headers: { traceparent?: string; tracestate?: string };
  last_status: number | null;
};

describe('local tasks adapter on PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let receiver: FastifyInstance;
  let adapter: LocalTaskPort;
  let base: string;
  let serviceUrls: Record<string, string>;
  let queueTable: string;
  let stateTable: string;

  let nowMs = new Date('2026-06-30T12:00:00').getTime();
  const clock: Clock = { now: () => new Date(nowMs) };
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  const deliveries: Delivery[] = [];
  const statuses = new Map<string, number>();
  const warnings: object[] = [];
  const errors: object[] = [];
  const logger: TaskLogger = {
    info: () => undefined,
    warn: (obj) => warnings.push(obj),
    error: (obj) => errors.push(obj),
  };

  /** Export-queue task due now, addressed to the receiver route of `name`. */
  function exportTask(name: string, tenantId: string | undefined, extra: Partial<CreateTaskInput> = {}): CreateTaskInput {
    return {
      queue: QUEUE,
      name,
      scheduleTime: new Date(nowMs),
      url: `${base}${TASK_PATH}/${name}`,
      deadlineS: EXPORT_QUEUE.deadlineS,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...extra,
    };
  }

  /** Tenant ids of the rows of `relation` matching `column = value`, read through the app role one tenant scope at a time. */
  async function holders(relation: string, column: 'name' | 'queue', value: string): Promise<string[]> {
    const found: string[] = [];
    for (const tenant of PROBE_TENANTS) {
      const client = await handle.appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenant]);
        const { rows } = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${relation} WHERE ${column} = $1`, [value]);
        found.push(...rows.map((row) => row.tenant_id));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    return found;
  }

  /** Rows of `relation` visible to the app role with no tenant set. */
  async function unscopedCount(relation: string): Promise<number> {
    const { rows } = await handle.appPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation}`);
    return rows[0]?.n ?? 0;
  }

  /** The stored queue row named `name` under `tenantId`. */
  async function rowOf(tenantId: string, name: string): Promise<StoredRow | undefined> {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows } = await tx.query<StoredRow>(
        `SELECT tenant_id, status, attempts, schedule_time, headers, last_status FROM ${queueTable} WHERE name = $1`,
        [name],
      );
      return rows[0];
    });
  }

  const deliveredNames = (): string[] => deliveries.map((delivery) => delivery.name);

  beforeAll(async () => {
    const config = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at PG_HOST:PG_PORT (${config.host}:${String(config.port)}) is not reachable`);
    }
    handle = await createThrowawaySchema({
      service: 'isotask',
      extraSql: [tenantRegistrySql('isotask'), scheduledTaskQueueSql('isotask')],
    });
    queueTable = `${handle.schema}.${SCHEDULED_TASK_QUEUE_TABLE}`;
    stateTable = `${handle.schema}.${SCHEDULED_TASK_QUEUE_STATE_TABLE}`;
    await seedRegistry(handle.app);
    stateDir = await mkdtemp(join(tmpdir(), 'opt2-isotask-'));
    await writeTestSecrets(stateDir);

    receiver = fastify();
    receiver.post<{ Params: { name: string } }>(`${TASK_PATH}/:name`, async (req, reply) => {
      deliveries.push({ name: req.params.name, headers: { ...req.headers }, body: req.body });
      return reply.code(statuses.get(req.params.name) ?? 204).send();
    });
    base = await receiver.listen({ host: '127.0.0.1', port: 0 });
    serviceUrls = { [EXPORT_QUEUE.targetService]: base, stub: base };
    adapter = await createLocalTaskAdapter({ db: handle.app, stateDir, serviceUrls, clock, logger, autoStart: false });
  });

  afterAll(async () => {
    await runCleanup('local tasks adapter suite', [
      () => shutdownTracing(),
      () => adapter?.close(),
      () => receiver?.close(),
      () => (stateDir ? rm(stateDir, { recursive: true, force: true }) : undefined),
      () => handle?.drop(),
    ]);
  });

  beforeEach(() => {
    deliveries.length = 0;
    statuses.clear();
    warnings.length = 0;
    errors.length = 0;
  });

  afterEach(() => {
    expect(errors).toEqual([]);
  });

  it('stores a tenant task under its tenant only, lists it with that tenant and hides it from every other scope', async () => {
    const name = 'iso-tenant-a';
    const input = exportTask(name, TENANT_A.tenantId, { scheduleTime: new Date(nowMs + HOUR_MS) });
    expect(await adapter.create(input)).toEqual({ name, created: true });

    expect(await holders(queueTable, 'name', name)).toEqual([TENANT_A.tenantId]);
    expect(await unscopedCount(queueTable)).toBe(0);
    const seenByB = await withTenant(handle.app, TENANT_B.tenantId, async (tx) => {
      const { rows } = await tx.query(`SELECT name FROM ${queueTable}`);
      return rows;
    });
    expect(seenByB).toEqual([]);

    expect((await adapter.list(QUEUE)).tasks).toEqual([
      { queue: QUEUE, name, scheduleTime: input.scheduleTime, tenantId: TENANT_A.tenantId, status: 'pending', attempts: 0 },
    ]);
    expect(await adapter.get(QUEUE, name, { tenantId: TENANT_A.tenantId })).toMatchObject({ name, tenantId: TENANT_A.tenantId });
    expect(await adapter.get(QUEUE, name, { tenantId: TENANT_B.tenantId })).toBeUndefined();
    expect(await adapter.get(QUEUE, name)).toBeUndefined();

    expect(await adapter.dispatchDue()).toBe(0);
    for (let reuse = 0; reuse < 4; reuse += 1) {
      const { rows } = await handle.appPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${queueTable}`);
      expect(rows[0]?.n).toBe(0);
    }
    expect(await adapter.delete(QUEUE, name, { tenantId: TENANT_A.tenantId })).toEqual({ name, deleted: true });
  });

  it('stores a task created without a tenant under the system tenant and lists it without one', async () => {
    const name = 'iso-system';
    expect(await adapter.create(exportTask(name, undefined, { scheduleTime: new Date(nowMs + HOUR_MS) }))).toEqual({ name, created: true });

    expect(await holders(queueTable, 'name', name)).toEqual([SYSTEM_TENANT_ID]);
    const [task, ...rest] = (await adapter.list(QUEUE)).tasks;
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ queue: QUEUE, name, status: 'pending', attempts: 0 });
    expect(task).not.toHaveProperty('tenantId');
    expect(await adapter.get(QUEUE, name)).toMatchObject({ name });
    expect(await adapter.get(QUEUE, name, { tenantId: TENANT_A.tenantId })).toBeUndefined();
    expect(await adapter.delete(QUEUE, name)).toEqual({ name, deleted: true });
  });

  it('answers created:false for a repeated name, deleted:false for a missing task and lists only live tasks', async () => {
    const name = 'iso-dup';
    const input = exportTask(name, TENANT_A.tenantId, { scheduleTime: new Date(nowMs + HOUR_MS) });
    expect(await adapter.create(input)).toEqual({ name, created: true });
    expect(await adapter.create(input)).toEqual({ name, created: false });
    expect(await holders(queueTable, 'name', name)).toEqual([TENANT_A.tenantId]);
    expect((await adapter.list(QUEUE)).tasks.map((task) => task.name)).toEqual([name]);

    expect(await adapter.delete(QUEUE, name, { tenantId: TENANT_B.tenantId })).toEqual({ name, deleted: false });
    expect((await adapter.list(QUEUE)).tasks.map((task) => task.name)).toEqual([name]);
    expect(await adapter.delete(QUEUE, name)).toEqual({ name, deleted: true });
    expect(await adapter.delete(QUEUE, name)).toEqual({ name, deleted: false });
    expect(await adapter.delete(QUEUE, 'iso-never-created')).toEqual({ name: 'iso-never-created', deleted: false });
    expect(await adapter.list(QUEUE)).toEqual({ tasks: [] });

    expect(await adapter.create(input)).toEqual({ name, created: false });
    expect(await rowOf(TENANT_A.tenantId, name)).toMatchObject({ status: 'deleted' });
  });

  it('holds due tasks of a paused queue, still accepts new ones, and dispatches them after resume', async () => {
    const name = 'iso-paused';
    expect(await adapter.queueState(QUEUE)).toEqual({ queue: QUEUE, paused: false });
    await adapter.pauseQueue(QUEUE);
    try {
      expect(await adapter.queueState(QUEUE)).toEqual({ queue: QUEUE, paused: true });
      expect(await holders(stateTable, 'queue', QUEUE)).toEqual([SYSTEM_TENANT_ID]);

      expect(await adapter.create(exportTask(name, TENANT_B.tenantId))).toEqual({ name, created: true });
      expect(await adapter.dispatchDue()).toBe(0);
      advance(60_000);
      expect(await adapter.dispatchDue()).toBe(0);
      expect(deliveries).toEqual([]);

      await adapter.resumeQueue(QUEUE);
      expect(await adapter.queueState(QUEUE)).toEqual({ queue: QUEUE, paused: false });
      expect(await adapter.dispatchDue()).toBe(1);
      expect(deliveredNames()).toEqual([name]);
      expect(await rowOf(TENANT_B.tenantId, name)).toMatchObject({ status: 'done', attempts: 1, last_status: 204 });
    } finally {
      await adapter.delete(QUEUE, name, { tenantId: TENANT_B.tenantId });
      await adapter.resumeQueue(QUEUE);
    }
  });

  it('POSTs a due task once with its wire body, Cloud Tasks headers, stored traceparent and a tasks-invoker token for its target', async () => {
    const name = 'iso-deliver';
    const scheduleTime = new Date(nowMs - 1500);
    const input = exportTask(name, TENANT_A.tenantId, { scheduleTime, body: { exportId: 'EXP-1' } });
    await startTracing({ serviceName: 'isotask-test', version: '1.0.0', exporter: new MemorySpanExporter() });
    try {
      expect(await withExtractedContext({ traceparent: KNOWN_TRACEPARENT }, () => adapter.create(input))).toEqual({ name, created: true });
    } finally {
      await shutdownTracing();
    }
    expect((await rowOf(TENANT_A.tenantId, name))?.headers).toEqual({ traceparent: KNOWN_TRACEPARENT });

    expect(await adapter.dispatchDue()).toBe(1);
    expect(await adapter.dispatchDue()).toBe(0);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(parseTaskWireBody(delivery?.body)).toEqual({ queue: QUEUE, name, tenantId: TENANT_A.tenantId, payload: { exportId: 'EXP-1' } });
    expect(delivery?.headers).toMatchObject({
      'content-type': 'application/json',
      traceparent: KNOWN_TRACEPARENT,
      [CLOUD_TASKS_HEADERS.queueName]: QUEUE,
      [CLOUD_TASKS_HEADERS.taskName]: name,
      [CLOUD_TASKS_HEADERS.retryCount]: '0',
      [CLOUD_TASKS_HEADERS.executionCount]: '0',
      [CLOUD_TASKS_HEADERS.eta]: String(scheduleTime.getTime() / 1000),
    });

    const path = `${TASK_PATH}/${name}`;
    expect(transportForPath(path)).toBe('cloud-tasks');
    const { publicKey } = await loadLocalSigningKeys(stateDir);
    const request = { headers: { authorization: delivery?.headers.authorization }, path };
    const target = createLocalCloudTasksTransport({ publicKey, callee: EXPORT_QUEUE.targetService });
    expect(await target.authenticate(request, { optional: false })).toEqual({
      service: { name: 'tasks-invoker', roles: [TASKS_INVOKER_ROLE] },
    });
    const otherCallee = createLocalCloudTasksTransport({ publicKey, callee: 'stub' });
    await expect(otherCallee.authenticate(request, { optional: false })).rejects.toThrow();
    expect(await rowOf(TENANT_A.tenantId, name)).toMatchObject({ status: 'done', attempts: 1, last_status: 204 });
  });

  it('holds a task scheduled after the clock until the clock reaches its schedule time', async () => {
    const name = 'iso-later';
    await adapter.create(exportTask(name, TENANT_B.tenantId, { scheduleTime: new Date(nowMs + 120_000) }));
    expect(await adapter.dispatchDue()).toBe(0);
    advance(120_000 - 1);
    expect(await adapter.dispatchDue()).toBe(0);
    expect(deliveries).toEqual([]);
    advance(1);
    expect(await adapter.dispatchDue()).toBe(1);
    expect(deliveredNames()).toEqual([name]);
  });

  it('reschedules a failed delivery by the queue backoff and fails the task after maxAttempts', async () => {
    const name = 'iso-retry';
    const policy = EXPORT_QUEUE.retry;
    expect(policy.maxAttempts).toBeGreaterThan(1);
    statuses.set(name, 500);
    await adapter.create(exportTask(name, TENANT_B.tenantId));

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      expect(await adapter.dispatchDue()).toBe(1);
      const row = await rowOf(TENANT_B.tenantId, name);
      expect(row).toMatchObject({ tenant_id: TENANT_B.tenantId, attempts: attempt, last_status: 500 });
      if (attempt === policy.maxAttempts) {
        expect(row?.status).toBe('failed');
      } else {
        const delayMs = retryDelayS(policy, attempt) * 1000;
        expect(row?.status).toBe('pending');
        expect(row?.schedule_time.getTime()).toBe(nowMs + delayMs);
        advance(delayMs - 1);
        expect(await adapter.dispatchDue()).toBe(0);
        advance(1);
      }
    }

    advance(24 * HOUR_MS);
    expect(await adapter.dispatchDue()).toBe(0);
    expect(deliveries.map((delivery) => delivery.headers[CLOUD_TASKS_HEADERS.retryCount])).toEqual(
      Array.from({ length: policy.maxAttempts }, (_, prior) => String(prior)),
    );
    expect(warnings.at(-1)).toMatchObject({
      queue: QUEUE,
      name,
      tenantId: TENANT_B.tenantId,
      attempts: policy.maxAttempts,
      status: 'failed',
      statusCode: 500,
    });
    expect(await adapter.get(QUEUE, name, { tenantId: TENANT_B.tenantId })).toBeUndefined();
  });

  it('delivers each due task exactly once across concurrent scans of two adapters on one schema', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `iso-race-${String(index)}`);
    for (const [index, name] of names.entries()) {
      await adapter.create(exportTask(name, index % 2 === 0 ? TENANT_A.tenantId : TENANT_B.tenantId));
    }
    const second = await createLocalTaskAdapter({ db: handle.app, stateDir, serviceUrls, clock, logger, autoStart: false });
    try {
      const counts = await Promise.all([adapter.dispatchDue(), adapter.dispatchDue(), second.dispatchDue()]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(names.length);
    } finally {
      await second.close();
    }
    expect(deliveredNames().sort()).toEqual([...names].sort());
    expect(await adapter.dispatchDue()).toBe(0);
    expect(deliveries).toHaveLength(names.length);
  });

  it('creates the current sweep slot, reports it live, and re-creates the chain after its task is lost', async () => {
    const spec = recurringSpec(SWEEP_QUEUE, serviceUrls);
    expect(spec).toMatchObject({ queue: SWEEP_QUEUE, intervalS: OUTBOX_SWEEP_INTERVAL_S });
    const current = slotStartS(Math.floor(nowMs / 1000), spec.intervalS);
    const first = slotName(SWEEP_QUEUE, current);

    expect(await ensureRecurring(adapter, { ...spec, clock })).toEqual({
      queue: SWEEP_QUEUE,
      name: first,
      created: true,
      reason: 'created-current',
    });
    expect(await holders(queueTable, 'name', first)).toEqual([SYSTEM_TENANT_ID]);
    expect(await ensureRecurring(adapter, { ...spec, clock })).toEqual({ queue: SWEEP_QUEUE, name: first, created: false, reason: 'live' });

    expect(await adapter.delete(SWEEP_QUEUE, first)).toEqual({ name: first, deleted: true });
    const next = slotName(SWEEP_QUEUE, current + spec.intervalS);
    expect(await ensureRecurring(adapter, { ...spec, clock })).toEqual({
      queue: SWEEP_QUEUE,
      name: next,
      created: true,
      reason: 'created-next',
    });
    expect((await adapter.list(SWEEP_QUEUE)).tasks.map((task) => task.name)).toEqual([next]);
    expect(await adapter.delete(SWEEP_QUEUE, next)).toEqual({ name: next, deleted: true });
  });
});
