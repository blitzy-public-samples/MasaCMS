import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEASE_MARGIN_S,
  LOCAL_TOMBSTONE_RETENTION_S,
  SCHEDULED_TASK_QUEUE_STATE_TABLE,
  SCHEDULED_TASK_QUEUE_TABLE,
  createLocalTaskAdapter,
  scheduledTaskQueueSql,
  type LocalTaskPort,
} from '../../src/tasks/local-adapter.js';
import { MAX_TASK_PAGE_SIZE, createTaskPort, type CreateTaskInput, type TaskLogger } from '../../src/tasks/port.js';
import { RECURRING_RETRY, UnknownQueueError, UnknownTaskTargetError, retryDelayS } from '../../src/tasks/queues.js';
import { SYSTEM_TENANT_ID, rlsSql, tenantRegistrySql, type TenantDb } from '../../src/tenancy/index.js';
import { createLocalCloudTasksTransport } from '../../src/auth/index.js';
import { MemorySpanExporter, SpanKind, shutdownTracing, startSpan, startTracing } from '../../src/tracing/index.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';
import { TENANT_A, TENANT_B, seedRegistry } from '../../src/testing/fixtures.js';
import { testSigningKeys, writeTestSecrets } from '../../src/testing/tokens.js';
import { REDACTED } from '../../src/logging/index.js';

const SERVICE_URLS: Readonly<Record<string, string>> = {
  surveys: 'http://127.0.0.1:8117',
  communications: 'http://127.0.0.1:8115',
  stub: 'http://127.0.0.1:8199',
};

describe('scheduledTaskQueueSql', () => {
  it('returns both tables, the tenant-leading queue indexes and each table RLS block, newline-terminated', () => {
    expect(scheduledTaskQueueSql('stub')).toBe(
      [
        'CREATE TABLE stub.scheduled_task_queue (',
        '  tenant_id uuid NOT NULL,',
        '  queue text NOT NULL,',
        '  name text NOT NULL,',
        '  schedule_time timestamp(3) without time zone NOT NULL,',
        '  url text NOT NULL,',
        '  body jsonb NOT NULL,',
        "  headers jsonb NOT NULL DEFAULT '{}'::jsonb,",
        '  deadline_s integer NOT NULL,',
        "  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','deleted')),",
        '  attempts integer NOT NULL DEFAULT 0,',
        '  lease_until timestamp(3) without time zone,',
        '  last_status integer,',
        '  created_at timestamp(3) without time zone NOT NULL,',
        '  updated_at timestamp(3) without time zone NOT NULL,',
        '  PRIMARY KEY (tenant_id, queue, name)',
        ');',
        "CREATE INDEX scheduled_task_queue_pending_due ON stub.scheduled_task_queue (tenant_id, schedule_time) WHERE status = 'pending';",
        "CREATE INDEX scheduled_task_queue_lease_expiry ON stub.scheduled_task_queue (tenant_id, lease_until) WHERE status = 'running';",
        "CREATE INDEX scheduled_task_queue_live ON stub.scheduled_task_queue (tenant_id, queue, schedule_time, name) WHERE status IN ('pending','running');",
        "CREATE INDEX scheduled_task_queue_tombstone_expiry ON stub.scheduled_task_queue (tenant_id, updated_at) WHERE status IN ('done','failed','deleted');",
        rlsSql('stub', 'scheduled_task_queue'),
        'CREATE TABLE stub.scheduled_task_queue_state (',
        '  tenant_id uuid NOT NULL,',
        '  queue text NOT NULL,',
        '  paused boolean NOT NULL DEFAULT false,',
        '  updated_at timestamp(3) without time zone NOT NULL,',
        '  PRIMARY KEY (tenant_id, queue)',
        ');',
        rlsSql('stub', 'scheduled_task_queue_state'),
        '',
      ].join('\n'),
    );
  });

  it('names the tables and fixes the retention and lease margin', () => {
    expect([SCHEDULED_TASK_QUEUE_TABLE, SCHEDULED_TASK_QUEUE_STATE_TABLE]).toEqual(['scheduled_task_queue', 'scheduled_task_queue_state']);
    expect([LOCAL_TOMBSTONE_RETENTION_S, LEASE_MARGIN_S]).toEqual([3600, 30]);
  });

  it.each(['Stub', 'stub.queue', 'stub; DROP TABLE x', 'programs-sites', '', 42 as unknown as string])('rejects schema %j', (schema) => {
    expect(() => scheduledTaskQueueSql(schema)).toThrow(TypeError);
  });
});

const available = await pgAvailable();

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  headersTimeout: number;
}

describe.skipIf(!available)('local task adapter', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let stateDir: string;
  let port: LocalTaskPort;
  let nowMs = new Date(2026, 5, 30, 12, 0, 0, 0).getTime();
  const clock = { now: () => new Date(nowMs) };
  let calls: Call[] = [];
  let respond: (call: Call) => Promise<number> = async () => 200;
  const warnings: Array<{ obj: object; msg?: string }> = [];
  const errors: Array<{ obj: object; msg?: string }> = [];
  const logger: TaskLogger = {
    info: () => undefined,
    warn: (obj, msg) => warnings.push({ obj, msg }),
    error: (obj, msg) => errors.push({ obj, msg }),
  };

  /** Stands in for undici `request`: records the call and answers with `respond`'s status. */
  const stubRequest = (async (url: string, opts: { headers: Record<string, string>; body: string; headersTimeout: number }) => {
    const call: Call = { url, headers: opts.headers, body: JSON.parse(opts.body), headersTimeout: opts.headersTimeout };
    calls.push(call);
    return { statusCode: await respond(call), body: { dump: async () => undefined } };
  }) as unknown as typeof import('undici').request;

  /** Task input for the surveys launch route, named `name`, due a second ago. */
  function launch(name: string, tenantId: string | undefined, extra: Partial<CreateTaskInput> = {}): CreateTaskInput {
    return {
      queue: 'surveys-launch',
      name,
      scheduleTime: new Date(nowMs - 1000),
      url: `${SERVICE_URLS.surveys}/internal/v1/tasks/surveys/${name}/launch`,
      deadlineS: 60,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...extra,
    };
  }

  /** Number of queue rows named `name` visible under `tenant`. */
  async function visible(tenant: string, name: string): Promise<number> {
    return db.withTenant(tenant, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${handle.schema}.scheduled_task_queue WHERE name = $1`,
        [name],
      );
      return rows[0]?.n ?? 0;
    });
  }

  /** The stored queue row of `name` under `tenant`. */
  async function rowOf(tenant: string, name: string): Promise<Record<string, unknown> | undefined> {
    return db.withTenant(tenant, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM ${handle.schema}.scheduled_task_queue WHERE name = $1`, [name]);
      return rows[0];
    });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'tasks', extraSql: [tenantRegistrySql('tasks'), scheduledTaskQueueSql('tasks')] });
    db = handle.app;
    await seedRegistry(db);
    stateDir = await mkdtemp(join(tmpdir(), 'opt2-local-tasks-'));
    await writeTestSecrets(stateDir);
    port = await createLocalTaskAdapter({ db, stateDir, serviceUrls: SERVICE_URLS, clock, logger, autoStart: false, request: stubRequest });
  });

  afterAll(async () => {
    await port?.close();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    respond = async () => 200;
    nowMs += 10 * 3600 * 1000;
    await port.dispatchDue();
    calls = [];
    warnings.length = 0;
    errors.length = 0;
  });

  it('dispatches tenant A, tenant B and system tasks, each stored under its own tenant only', async () => {
    const created = [
      await port.create(launch('iso-a', TENANT_A.tenantId, { body: { surveyId: 'S1' } })),
      await port.create(launch('iso-b', TENANT_B.tenantId)),
      await port.create({
        queue: 'stub-outbox-sweep',
        name: 'stub-outbox-sweep-1',
        scheduleTime: new Date(nowMs - 1000),
        url: `${SERVICE_URLS.stub}/internal/v1/outbox/sweep`,
        deadlineS: 60,
      }),
    ];
    expect(created.map((result) => result.created)).toEqual([true, true, true]);
    expect([await visible(TENANT_A.tenantId, 'iso-a'), await visible(TENANT_B.tenantId, 'iso-a')]).toEqual([1, 0]);
    expect([await visible(TENANT_B.tenantId, 'iso-b'), await visible(TENANT_A.tenantId, 'iso-b')]).toEqual([1, 0]);
    expect(await visible(SYSTEM_TENANT_ID, 'iso-a')).toBe(0);
    expect((await port.list('surveys-launch')).tasks.map((task) => [task.name, task.tenantId])).toEqual([
      ['iso-a', TENANT_A.tenantId],
      ['iso-b', TENANT_B.tenantId],
    ]);
    const [sweep] = (await port.list('stub-outbox-sweep')).tasks;
    expect(sweep).toMatchObject({ queue: 'stub-outbox-sweep', name: 'stub-outbox-sweep-1', status: 'pending', attempts: 0 });
    expect(sweep).not.toHaveProperty('tenantId');

    expect(await port.dispatchDue()).toBe(3);
    expect(calls.map((call) => call.body)).toEqual(
      expect.arrayContaining([
        { queue: 'surveys-launch', name: 'iso-a', tenantId: TENANT_A.tenantId, payload: { surveyId: 'S1' } },
        { queue: 'surveys-launch', name: 'iso-b', tenantId: TENANT_B.tenantId, payload: null },
        { queue: 'stub-outbox-sweep', name: 'stub-outbox-sweep-1', tenantId: null, payload: null },
      ]),
    );
    expect(await rowOf(TENANT_A.tenantId, 'iso-a')).toMatchObject({ status: 'done', attempts: 1, last_status: 200, lease_until: null });
    expect(await port.list('surveys-launch')).toEqual({ tasks: [] });
  });

  it('leaves no rows visible to a pooled connection reused after a tenant scan', async () => {
    await port.create(launch('reuse-a', TENANT_A.tenantId));
    await port.dispatchDue();
    for (let i = 0; i < 8; i += 1) {
      const { rows } = await handle.appPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.scheduled_task_queue`);
      expect(rows[0]?.n).toBe(0);
    }
  });

  it('sends the Cloud Tasks headers and a token the local cloud-tasks transport accepts for the target service', async () => {
    const scheduleTime = new Date(nowMs - 1500);
    await port.create(launch('hdr-a', TENANT_A.tenantId, { scheduleTime, deadlineS: 45 }));
    expect(await port.dispatchDue()).toBe(1);
    const [call] = calls;
    expect(call?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-cloudtasks-taskname': 'hdr-a',
      'x-cloudtasks-queuename': 'surveys-launch',
      'x-cloudtasks-taskretrycount': '0',
      'x-cloudtasks-taskexecutioncount': '0',
      'x-cloudtasks-tasketa': String(scheduleTime.getTime() / 1000),
    });
    expect(call?.headersTimeout).toBe(45_000);
    const { publicKey } = await testSigningKeys();
    const request = { headers: { authorization: call?.headers.authorization }, path: '/internal/v1/tasks/surveys/hdr-a/launch' };
    const surveys = createLocalCloudTasksTransport({ publicKey, callee: 'surveys' });
    expect((await surveys.authenticate(request, { optional: false })).service?.name).toBe('tasks-invoker');
    const other = createLocalCloudTasksTransport({ publicKey, callee: 'communications' });
    await expect(other.authenticate(request, { optional: false })).rejects.toThrow();
  });

  it('holds a paused queue and dispatches it after resume', async () => {
    const queue = 'communications-reminders';
    await port.create({
      queue,
      name: 'pause-b',
      scheduleTime: new Date(nowMs),
      url: `${SERVICE_URLS.communications}/internal/v1/tasks/reminders/1`,
      deadlineS: 60,
      tenantId: TENANT_B.tenantId,
    });
    expect(await port.queueState(queue)).toEqual({ queue, paused: false });
    await port.pauseQueue(queue);
    expect(await port.queueState(queue)).toEqual({ queue, paused: true });
    expect(await port.dispatchDue()).toBe(0);
    await port.resumeQueue(queue);
    expect(await port.queueState(queue)).toEqual({ queue, paused: false });
    expect(await port.dispatchDue()).toBe(1);
    await expect(port.pauseQueue('no-such-queue')).rejects.toThrow('Unknown task queue');
  });

  it('reschedules a non-2xx answer with backoff and fails the task at maxAttempts', async () => {
    respond = async () => 503;
    await port.create({
      queue: 'stub-outbox-sweep',
      name: 'retry-sys',
      scheduleTime: new Date(nowMs),
      url: `${SERVICE_URLS.stub}/internal/v1/outbox/sweep`,
      deadlineS: 60,
    });
    for (let attempt = 1; attempt <= RECURRING_RETRY.maxAttempts; attempt += 1) {
      expect(await port.dispatchDue()).toBe(1);
      const row = await rowOf(SYSTEM_TENANT_ID, 'retry-sys');
      expect(row).toMatchObject({ attempts: attempt, last_status: 503 });
      if (attempt === RECURRING_RETRY.maxAttempts) {
        expect(row?.status).toBe('failed');
      } else {
        const delayMs = retryDelayS(RECURRING_RETRY, attempt) * 1000;
        expect(row?.status).toBe('pending');
        expect((row?.schedule_time as Date).getTime()).toBe(nowMs + delayMs);
        expect(await port.dispatchDue()).toBe(0);
        nowMs += delayMs;
      }
    }
    expect(await port.dispatchDue()).toBe(0);
    expect(calls.map((call) => call.headers['x-cloudtasks-taskretrycount'])).toEqual(['0', '1', '2', '3', '4']);
    expect(warnings.at(-1)?.obj).toMatchObject({
      queue: 'stub-outbox-sweep',
      name: 'retry-sys',
      tenantId: SYSTEM_TENANT_ID,
      attempts: 5,
      status: 'failed',
      statusCode: 503,
    });
    expect(JSON.stringify(warnings)).not.toMatch(/Bearer|payload/);
  });

  it('logs a failed dispatch with its error serialized, never its raw message', async () => {
    respond = async () => {
      throw new Error('connect failed https://user:pw@h/?X-Goog-Signature=abc');
    };
    await port.create({
      queue: 'stub-outbox-sweep',
      name: 'raw-error-sys',
      scheduleTime: new Date(nowMs),
      url: `${SERVICE_URLS.stub}/internal/v1/outbox/sweep`,
      deadlineS: 60,
    });
    expect(await port.dispatchDue()).toBe(1);
    const logged = warnings.at(-1)?.obj as { error?: Record<string, unknown> } | undefined;
    expect(logged).toMatchObject({ name: 'raw-error-sys', status: 'pending', error: { type: 'Error', message: REDACTED } });
    expect(logged?.error).not.toBeInstanceOf(Error);
    expect(Object.keys(logged?.error ?? {}).every((key) => ['type', 'message', 'stack'].includes(key))).toBe(true);
    expect(JSON.stringify(warnings)).not.toMatch(/connect failed|user:pw|X-Goog-Signature/);
  });

  it('answers created:false for a duplicate name and for a deleted name until its tombstone expires', async () => {
    const input = launch('dup-a', TENANT_A.tenantId, { scheduleTime: new Date(nowMs + 600_000) });
    expect(await port.create(input)).toEqual({ name: 'dup-a', created: true });
    expect(await port.create(input)).toEqual({ name: 'dup-a', created: false });
    expect(await port.delete('surveys-launch', 'dup-a')).toEqual({ name: 'dup-a', deleted: true });
    expect(await port.delete('surveys-launch', 'dup-a')).toEqual({ name: 'dup-a', deleted: false });
    expect(await port.list('surveys-launch')).toEqual({ tasks: [] });
    expect(await port.create(input)).toEqual({ name: 'dup-a', created: false });
    nowMs += (LOCAL_TOMBSTONE_RETENTION_S - 10) * 1000;
    await port.dispatchDue();
    expect(await port.create(input)).toEqual({ name: 'dup-a', created: false });
    nowMs += 120_000;
    await port.dispatchDue();
    const again = { ...input, scheduleTime: new Date(nowMs + 600_000) };
    expect(await port.create(again)).toEqual({ name: 'dup-a', created: true });
    expect(await port.delete('surveys-launch', 'dup-a', { tenantId: TENANT_B.tenantId })).toEqual({ name: 'dup-a', deleted: false });
    expect(await port.delete('surveys-launch', 'dup-a', { tenantId: TENANT_A.tenantId })).toEqual({ name: 'dup-a', deleted: true });
  });

  describe('paged list and get', () => {
    const queue = 'content-scheduled-publish';
    const url = `${SERVICE_URLS.stub}/internal/v1/tasks/content/publish`;
    let seeded = 0;

    /** Creates a task due an hour from now plus `offsetMs`, under `tenantId` or as a system task. */
    async function createAt(name: string, tenantId: string | undefined, offsetMs: number, onQueue = queue): Promise<void> {
      const scheduleTime = new Date(nowMs + 3_600_000 + offsetMs);
      await port.create({ queue: onQueue, name, scheduleTime, url, deadlineS: 60, ...(tenantId === undefined ? {} : { tenantId }) });
    }

    /** Seeds live tasks of the system tenant, tenant A and tenant B, a tombstone and another queue's task; returns the live ones in list order. */
    async function seedPages(): Promise<Array<[string, string | undefined]>> {
      seeded += 1;
      const at = (suffix: string): string => `page${String(seeded)}-${suffix}`;
      for (const [suffix, tenantId, offsetMs] of [
        ['sys-2', undefined, 1_567],
        ['sys-1', undefined, 1_234],
        ['a-3', TENANT_A.tenantId, 3_001],
        ['a-2', TENANT_A.tenantId, 1_234],
        ['a-1', TENANT_A.tenantId, 1_234],
        ['b-1', TENANT_B.tenantId, 5],
      ] as const) {
        await createAt(at(suffix), tenantId, offsetMs);
      }
      await createAt(at('a-dead'), TENANT_A.tenantId, 0);
      await port.delete(queue, at('a-dead'), { tenantId: TENANT_A.tenantId });
      await createAt(at('other'), undefined, 0, 'content-feed-import');
      return [
        [at('sys-1'), undefined],
        [at('sys-2'), undefined],
        [at('a-1'), TENANT_A.tenantId],
        [at('a-2'), TENANT_A.tenantId],
        [at('a-3'), TENANT_A.tenantId],
        [at('b-1'), TENANT_B.tenantId],
      ];
    }

    it.each([1, 2, 4, 5, 6, MAX_TASK_PAGE_SIZE])('pages every live task once, in order, without tombstones, at pageSize %i', async (pageSize) => {
      const expected = await seedPages();
      const seen: Array<[string, string | undefined]> = [];
      const sizes: number[] = [];
      let pageToken: string | undefined;
      do {
        const page = await port.list(queue, { pageSize, ...(pageToken === undefined ? {} : { pageToken }) });
        sizes.push(page.tasks.length);
        seen.push(...page.tasks.map((task): [string, string | undefined] => [task.name, task.tenantId]));
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined && sizes.length <= expected.length + 1);
      expect(seen).toEqual(expected);
      const fullPages = Math.floor(expected.length / pageSize);
      expect(sizes.every((size) => size <= pageSize)).toBe(true);
      expect(sizes.slice(0, fullPages)).toEqual(Array.from({ length: fullPages }, () => pageSize));
      expect(sizes.length).toBeLessThanOrEqual(Math.ceil(expected.length / pageSize) + 1);
    });

    let getCase = 0;
    it.each([
      { label: 'a system task looked up without a tenant', creator: undefined, lookup: undefined, remove: false, found: true },
      { label: 'a tenant task looked up under its tenant', creator: TENANT_A.tenantId, lookup: TENANT_A.tenantId, remove: false, found: true },
      { label: 'a tenant task looked up as a system task', creator: TENANT_A.tenantId, lookup: undefined, remove: false, found: false },
      { label: 'a tenant task looked up under another tenant', creator: TENANT_A.tenantId, lookup: TENANT_B.tenantId, remove: false, found: false },
      { label: 'a system task looked up under a tenant', creator: undefined, lookup: TENANT_B.tenantId, remove: false, found: false },
      { label: 'a deleted task, whose name is a tombstone', creator: TENANT_B.tenantId, lookup: TENANT_B.tenantId, remove: true, found: false },
      { label: 'a name never created', creator: null, lookup: undefined, remove: false, found: false },
    ])('get answers $label', async ({ creator, lookup, remove, found }) => {
      getCase += 1;
      const name = `get-${String(getCase)}`;
      const tenantId = creator ?? undefined;
      if (creator !== null) await createAt(name, tenantId, 7);
      if (remove) await port.delete(queue, name, { tenantId });
      const expected = {
        queue,
        name,
        scheduleTime: new Date(nowMs + 3_600_000 + 7),
        ...(tenantId === undefined ? {} : { tenantId }),
        status: 'pending',
        attempts: 0,
      };
      expect(await port.get(queue, name, lookup === undefined ? undefined : { tenantId: lookup })).toStrictEqual(found ? expected : undefined);
      expect(await port.get('content-feed-import', name, lookup === undefined ? undefined : { tenantId: lookup })).toBeUndefined();
    });

    const token = (cursor: unknown): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');
    it.each([
      { label: 'list of an unknown queue', call: () => port.list('no-such-queue'), error: UnknownQueueError },
      { label: 'get of an unknown queue', call: () => port.get('no-such-queue', 'x'), error: UnknownQueueError },
      ...[0, -1, 1.5, MAX_TASK_PAGE_SIZE + 1, Number.NaN].map((pageSize) => ({
        label: `pageSize ${String(pageSize)}`,
        call: () => port.list(queue, { pageSize }),
        error: RangeError,
      })),
      ...[
        ['a token that is not base64url JSON', 'not-a-token'],
        ['a token of the wrong shape', token({ tenant: SYSTEM_TENANT_ID })],
        ['a token with a malformed schedule time', token({ tenant: SYSTEM_TENANT_ID, scheduleTime: 'yesterday', name: 'x' })],
        [
          'a token of an unregistered tenant',
          token({ tenant: '0b8f6c1e-5b7d-5e8a-9c3f-0d1e2f3a4b5c', scheduleTime: '2026-06-30 12:00:00.000', name: 'x' }),
        ],
      ].map(([label, pageToken]) => ({ label: String(label), call: () => port.list(queue, { pageToken: String(pageToken) }), error: TypeError })),
    ])('rejects $label', async ({ call, error }) => {
      await expect(call()).rejects.toBeInstanceOf(error);
    });
  });


  it('rejects a task URL outside the configured service origins before storing it', async () => {
    await expect(port.create(launch('unknown-a', TENANT_A.tenantId, { url: 'http://127.0.0.1:1/internal/v1/tasks/x' }))).rejects.toBeInstanceOf(
      UnknownTaskTargetError,
    );
    await expect(port.create(launch('bad name', TENANT_A.tenantId))).rejects.toThrow('Invalid task name');
    expect(await visible(TENANT_A.tenantId, 'unknown-a')).toBe(0);
  });

  it('reclaims a lease left running by a dead dispatcher and ignores that attempt late outcome', async () => {
    let release: () => void = () => undefined;
    respond = () =>
      new Promise<number>((resolve) => {
        release = () => resolve(200);
      });
    const dead = await createLocalTaskAdapter({ db, stateDir, serviceUrls: SERVICE_URLS, clock, logger, autoStart: false, request: stubRequest });
    await port.create(launch('lease-b', TENANT_B.tenantId));
    const stale = dead.dispatchDue();
    for (let i = 0; i < 50 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rowOf(TENANT_B.tenantId, 'lease-b')).toMatchObject({ status: 'running', attempts: 1 });
    respond = async () => 200;
    expect(await port.dispatchDue()).toBe(0);
    nowMs += (60 + LEASE_MARGIN_S + 1) * 1000;
    expect(await port.dispatchDue()).toBe(1);
    expect(calls.at(-1)?.headers['x-cloudtasks-taskretrycount']).toBe('1');
    release();
    await stale;
    expect(await rowOf(TENANT_B.tenantId, 'lease-b')).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('polls after start(), logs a failed scan, keeps polling and drains on stop()', async () => {
    let failNext = true;
    const flaky: TenantDb = {
      schema: db.schema,
      withTenant: (tenantId, fn) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('database unavailable'));
        }
        return db.withTenant(tenantId, fn);
      },
      withMetadata: (fn) => db.withMetadata(fn),
      end: () => db.end(),
    };
    const polling = await createLocalTaskAdapter({
      db: flaky,
      stateDir,
      serviceUrls: SERVICE_URLS,
      clock,
      logger,
      pollIntervalMs: 25,
      request: stubRequest,
    });
    polling.start();
    await port.create(launch('poll-a', TENANT_A.tenantId));
    for (let i = 0; i < 200 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    await polling.stop();
    expect(calls.map((call) => call.headers['x-cloudtasks-taskname'])).toEqual(['poll-a']);
    expect(errors[0]?.msg).toBe('Local tasks scan failed');
    expect(errors[0]?.obj).toEqual({ error: expect.objectContaining({ type: 'Error', message: REDACTED }) });
    expect(JSON.stringify(errors)).not.toContain('database unavailable');
    expect(await rowOf(TENANT_A.tenantId, 'poll-a')).toMatchObject({ status: 'done' });
  });

  describe('maxConcurrentDispatches', () => {
    /** Adapter over the shared schema with the stub request and the given dispatch cap. */
    const cappedAdapter = (maxConcurrentDispatches: number): Promise<LocalTaskPort> =>
      createLocalTaskAdapter({ db, stateDir, serviceUrls: SERVICE_URLS, clock, logger, autoStart: false, request: stubRequest, maxConcurrentDispatches });

    it('claims only free slots, leaves the rest pending while saturated and drains them as slots free', async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let active = 0;
      let peak = 0;
      respond = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return 200;
      };
      const capped = await cappedAdapter(3);
      const names = Array.from({ length: 7 }, (_, i) => `cap-a-${String(i)}`);
      for (const name of names) await capped.create(launch(name, TENANT_A.tenantId));
      const first = capped.dispatchDue();
      for (let i = 0; i < 50 && calls.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await capped.dispatchDue()).toBe(0);
      expect(calls).toHaveLength(3);
      const statuses = await Promise.all(names.map(async (name) => (await rowOf(TENANT_A.tenantId, name))?.status));
      expect(statuses.filter((status) => status === 'running')).toHaveLength(3);
      expect(statuses.filter((status) => status === 'pending')).toHaveLength(4);
      open();
      expect(await first).toBe(3);
      expect([await capped.dispatchDue(), await capped.dispatchDue(), await capped.dispatchDue()]).toEqual([3, 1, 0]);
      expect(peak).toBe(3);
      expect(new Set(calls.map((call) => call.headers['x-cloudtasks-taskname']))).toEqual(new Set(names));
      await capped.close();
    });

    it('rotates the starting tenant so a busy tenant cannot hold every slot', async () => {
      const capped = await cappedAdapter(1);
      for (const tenant of [TENANT_A, TENANT_B]) {
        for (const n of [1, 2]) await capped.create(launch(`fair-${tenant.siteId}-${String(n)}`, tenant.tenantId));
      }
      const counts: number[] = [];
      for (let scan = 0; scan < 5; scan += 1) counts.push(await capped.dispatchDue());
      expect(counts).toEqual([1, 1, 1, 1, 0]);
      expect(calls.map((call) => (call.body as { tenantId: string }).tenantId)).toEqual([
        TENANT_A.tenantId,
        TENANT_B.tenantId,
        TENANT_A.tenantId,
        TENANT_B.tenantId,
      ]);
      await capped.close();
    });

    it.each([0, -1, 1.5])('rejects %s with RangeError, directly and through createTaskPort', async (value) => {
      await expect(cappedAdapter(value)).rejects.toBeInstanceOf(RangeError);
      await expect(
        createTaskPort(
          { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: stateDir, OPT2_SERVICE_URLS: { ...SERVICE_URLS } },
          { db, clock, logger, local: { autoStart: false, maxConcurrentDispatches: value } },
        ),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  it('is built by createTaskPort and refuses a state directory without signing keys', async () => {
    const viaFactory = await createTaskPort(
      { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: stateDir, OPT2_SERVICE_URLS: { ...SERVICE_URLS } },
      { db, clock, logger, local: { autoStart: false } },
    );
    expect(viaFactory.kind).toBe('local');
    await viaFactory.close();
    await expect(
      createLocalTaskAdapter({ db, stateDir: join(stateDir, 'missing'), serviceUrls: SERVICE_URLS, logger, autoStart: false }),
    ).rejects.toThrow();
  });

  describe('against an HTTP target', () => {
    let server: Server;
    let hang = true;
    const received: Array<Record<string, string | string[] | undefined>> = [];
    let target: Record<string, string>;
    let real: LocalTaskPort;

    beforeAll(async () => {
      server = createServer((req, res) => {
        received.push(req.headers);
        req.resume();
        if (!hang) res.writeHead(204).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      target = { ...SERVICE_URLS, reporting: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
      real = await createLocalTaskAdapter({ db, stateDir, serviceUrls: target, clock, logger, autoStart: false });
    });

    afterAll(async () => {
      await real?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await shutdownTracing();
    });

    it('cuts a hung target off at the dispatch deadline and retries it', async () => {
      await real.create({
        queue: 'reporting-export-run',
        name: 'hung-a',
        scheduleTime: new Date(nowMs),
        url: `${target.reporting}/internal/v1/tasks/exports/1/run`,
        deadlineS: 15,
        tenantId: TENANT_A.tenantId,
      });
      const startedAt = Date.now();
      expect(await real.dispatchDue()).toBe(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14_500);
      expect(await rowOf(TENANT_A.tenantId, 'hung-a')).toMatchObject({ status: 'pending', attempts: 1, last_status: null });
      expect(warnings.at(-1)?.msg).toContain('got no response');
      hang = false;
      nowMs += 10_000;
      expect(await real.dispatchDue()).toBe(1);
      expect(await rowOf(TENANT_A.tenantId, 'hung-a')).toMatchObject({ status: 'done', attempts: 2, last_status: 204 });
      expect(received.at(-1)?.['x-cloudtasks-taskretrycount']).toBe('1');
    }, 40_000);

    it('carries the creating trace in exactly one traceparent, instrumented or not', async () => {
      await startTracing({ serviceName: 'local-tasks-test', version: '1.0.0', exporter: new MemorySpanExporter() });
      let traceId = '';
      const create = (name: string, url: string): Promise<void> =>
        startSpan('create-task', SpanKind.INTERNAL, async (span) => {
          traceId = span.spanContext().traceId;
          await real.create({ queue: 'reporting-export-run', name, scheduleTime: new Date(nowMs - 1000), url, deadlineS: 30, tenantId: TENANT_B.tenantId });
        });
      await create('trace-b', `${target.reporting}/internal/v1/tasks/exports/2/run`);
      const instrumentedTrace = traceId;
      expect(await real.dispatchDue()).toBe(1);
      const traceparent = received.at(-1)?.traceparent;
      expect(typeof traceparent).toBe('string');
      expect(String(traceparent).split('-')[1]).toBe(instrumentedTrace);

      await create('trace-stub-b', `${target.reporting}/internal/v1/tasks/exports/3/run`);
      const stored = (await rowOf(TENANT_B.tenantId, 'trace-stub-b'))?.headers as { traceparent?: string };
      await shutdownTracing();
      const stubbed = await createLocalTaskAdapter({ db, stateDir, serviceUrls: target, clock, logger, autoStart: false, request: stubRequest });
      expect(await stubbed.dispatchDue()).toBe(1);
      expect(calls.at(-1)?.headers.traceparent).toBe(stored.traceparent);
      expect(String(stored.traceparent).split('-')[1]).toBe(traceId);
    });
  });
});
