/** Local Cloud Tasks stand-in: a tenant-scoped queue table under forced RLS and an in-process dispatcher. */
import { channel } from 'node:diagnostics_channel';
import { request as undiciRequest } from 'undici';
import {
  CLOUD_TASKS_HEADERS,
  assertCreateInput,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskLogger,
  type TaskPort,
} from './port.js';
import { UnknownTaskTargetError, queueDefinition, retryDelayS, type RetryPolicy } from './queues.js';
import { SYSTEM_TENANT_ID, registeredTenants, rlsSql, withTenant, type TenantDb, type TenantTx } from '../tenancy/index.js';
import { loadLocalSigningKeys, signLocalServiceToken, type MANAGED_INVOKER_NAMES } from '../auth/index.js';
import { taskHeaders, withExtractedContext, type TraceCarrier } from '../tracing/index.js';
import { systemClock, type Clock } from '../service-kit/index.js';

/** Table holding the local adapter's tasks in each creating service's schema. */
export const SCHEDULED_TASK_QUEUE_TABLE = 'scheduled_task_queue';

/** Table holding the local adapter's per-queue pause state. */
export const SCHEDULED_TASK_QUEUE_STATE_TABLE = 'scheduled_task_queue_state';

/** Seconds a done, failed or deleted task name stays reserved, as Cloud Tasks keeps tombstones about an hour. */
export const LOCAL_TOMBSTONE_RETENTION_S = 3600;

/** Seconds past a task's dispatch deadline after which its `running` lease may be reclaimed. */
export const LEASE_MARGIN_S = 30;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const PURGE_INTERVAL_MS = 60_000;
const TASKS_INVOKER: (typeof MANAGED_INVOKER_NAMES)[number] = 'tasks-invoker';

// The OTel undici instrumentation subscribes here and injects a child of the active context into every request.
const undiciRequestCreated = channel('undici:request:create');

// Tenant tasks are stored under their tenant; tenant-less recurring tasks and all queue pause state under SYSTEM_TENANT_ID.
/** Newline-terminated DDL of both local-tasks tables with their RLS; throws `TypeError` for an invalid schema. */
export function scheduledTaskQueueSql(schema: string): string {
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema)) {
    throw new TypeError(`Invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const queue = `${schema}.${SCHEDULED_TASK_QUEUE_TABLE}`;
  const state = `${schema}.${SCHEDULED_TASK_QUEUE_STATE_TABLE}`;
  const statements = [
    `CREATE TABLE ${queue} (`,
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
    `CREATE INDEX scheduled_task_queue_due ON ${queue} (status, schedule_time);`,
    rlsSql(schema, SCHEDULED_TASK_QUEUE_TABLE),
    `CREATE TABLE ${state} (`,
    '  tenant_id uuid NOT NULL,',
    '  queue text NOT NULL,',
    '  paused boolean NOT NULL DEFAULT false,',
    '  updated_at timestamp(3) without time zone NOT NULL,',
    '  PRIMARY KEY (tenant_id, queue)',
    ');',
    rlsSql(schema, SCHEDULED_TASK_QUEUE_STATE_TABLE),
  ];
  return `${statements.join('\n')}\n`;
}

/** Settings of `createLocalTaskAdapter`; `signer` replaces the `tasks-invoker` token signer built from `stateDir`. */
export interface LocalTaskAdapterOptions {
  db: TenantDb;
  stateDir: string;
  /** Base URL per service; a task URL's origin must match one of them. */
  serviceUrls: Record<string, string>;
  clock?: Clock;
  logger?: TaskLogger;
  /** Default 1000. */
  pollIntervalMs?: number;
  /** Rows claimed per tenant per scan; default 20. */
  batchSize?: number;
  /** Default true. */
  autoStart?: boolean;
  request?: typeof import('undici').request;
  signer?: (audience: string) => Promise<string>;
}

/** Local task port with control over its dispatcher. */
export interface LocalTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Starts the polling dispatcher; repeated calls are no-ops. */
  start(): void;
  /** Stops polling and waits for in-flight dispatches. */
  stop(): Promise<void>;
  /** Runs one scan, awaits its dispatches and returns how many were dispatched. */
  dispatchDue(): Promise<number>;
}

interface QueueRow {
  tenant_id: string;
  queue: string;
  name: string;
  schedule_time: Date | string;
  url: string;
  body: unknown;
  headers: Partial<TraceCarrier>;
  deadline_s: number;
  attempts: number;
}

interface ListRow {
  name: string;
  schedule_time: Date | string;
  status: 'pending' | 'running';
  attempts: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD HH:mm:ss.SSS` in the process zone, the form `timestamp(3) without time zone` stores. */
function toLocalTimestamp(date: Date): string {
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${day} ${time}`;
}

/** Instant of a stored local timestamp; pg already yields a process-zone Date unless the pool parses it as text. */
function fromLocalTimestamp(value: Date | string): Date {
  if (value instanceof Date) return value;
  const match = LOCAL_TIMESTAMP.exec(value);
  if (match === null) throw new TypeError(`Invalid local timestamp: ${JSON.stringify(value)}`);
  const [, year, month, day, hours, minutes, seconds, millis = '0'] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
    Number(millis.padEnd(3, '0')),
  );
}

async function localTasksInvokerSigner(stateDir: string): Promise<(audience: string) => Promise<string>> {
  const keys = await loadLocalSigningKeys(stateDir, { requirePrivate: true });
  return (audience) => signLocalServiceToken({ keys, caller: TASKS_INVOKER, audience });
}

/** Maps a task URL to the service whose base URL shares its origin; throws `UnknownTaskTargetError` for any other origin. */
function targetResolver(serviceUrls: Record<string, string>): (url: string, queue: string) => string {
  const originOf = new Map<string, string>();
  const serviceAt = new Map<string, string>();
  for (const [service, base] of Object.entries(serviceUrls)) {
    const origin = new URL(base).origin;
    originOf.set(service, origin);
    if (!serviceAt.has(origin)) serviceAt.set(origin, service);
  }
  return (url, queue) => {
    const origin = new URL(url).origin;
    // Services sharing one origin are told apart by the queue's registered target.
    const preferred = queueDefinition(queue).targetService;
    if (originOf.get(preferred) === origin) return preferred;
    const service = serviceAt.get(origin);
    if (service === undefined) throw new UnknownTaskTargetError(origin);
    return service;
  };
}

function isExhausted(policy: RetryPolicy, attempts: number): boolean {
  return policy.maxAttempts !== -1 && attempts >= policy.maxAttempts;
}

function byScheduleThenName(a: TaskInfo, b: TaskInfo): number {
  const diff = a.scheduleTime.getTime() - b.scheduleTime.getTime();
  if (diff !== 0) return diff;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Creates the local task adapter over the service's own schema; it starts dispatching unless `autoStart` is false. */
export async function createLocalTaskAdapter(opts: LocalTaskAdapterOptions): Promise<LocalTaskPort> {
  const { db } = opts;
  const clock = opts.clock ?? systemClock;
  const logger: TaskLogger = opts.logger ?? console;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const batchSize = opts.batchSize ?? 20;
  const send = opts.request ?? undiciRequest;
  const signer = opts.signer ?? (await localTasksInvokerSigner(opts.stateDir));
  const resolveTarget = targetResolver(opts.serviceUrls);
  const table = `${db.schema}.${SCHEDULED_TASK_QUEUE_TABLE}`;
  const stateTable = `${db.schema}.${SCHEDULED_TASK_QUEUE_STATE_TABLE}`;
  const claimSql = `UPDATE ${table} t SET status = 'running', attempts = t.attempts + 1,
  lease_until = $1::timestamp(3) + make_interval(secs => t.deadline_s + $2), updated_at = $1::timestamp(3)
WHERE (t.tenant_id, t.queue, t.name) IN (
  SELECT tenant_id, queue, name FROM ${table}
  WHERE NOT (queue = ANY($3::text[]))
    AND ((status = 'pending' AND schedule_time <= $1::timestamp(3)) OR (status = 'running' AND lease_until < $1::timestamp(3)))
  ORDER BY schedule_time LIMIT $4 FOR UPDATE SKIP LOCKED)
RETURNING t.*`;

  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(db, tenantId, fn);
  const nowText = (): string => toLocalTimestamp(clock.now());
  const scanTenants = async (): Promise<string[]> => [
    ...new Set([SYSTEM_TENANT_ID, ...(await registeredTenants(db)).map((entry) => entry.tenantId)]),
  ];

  async function create(input: CreateTaskInput): Promise<CreateTaskResult> {
    assertCreateInput(input);
    resolveTarget(input.url, input.queue);
    const body = JSON.stringify(taskWireBody(input));
    const headers = JSON.stringify(taskHeaders());
    const now = nowText();
    const { rows } = await inTenant(input.tenantId ?? SYSTEM_TENANT_ID, (tx) =>
      tx.query(
        `INSERT INTO ${table} (tenant_id, queue, name, schedule_time, url, body, headers, deadline_s, status, attempts, created_at, updated_at)
VALUES ($1, $2, $3, $4::timestamp(3), $5, $6::jsonb, $7::jsonb, $8, 'pending', 0, $9::timestamp(3), $9::timestamp(3))
ON CONFLICT (tenant_id, queue, name) DO NOTHING RETURNING name`,
        [tx.tenantId, input.queue, input.name, toLocalTimestamp(input.scheduleTime), input.url, body, headers, input.deadlineS, now],
      ),
    );
    return { name: input.name, created: rows.length > 0 };
  }

  async function deleteTask(queue: string, name: string, deleteOpts?: { tenantId?: string }): Promise<DeleteTaskResult> {
    const tenants = deleteOpts?.tenantId === undefined ? await scanTenants() : [deleteOpts.tenantId];
    for (const tenant of tenants) {
      const { rowCount } = await inTenant(tenant, (tx) =>
        tx.query(
          `UPDATE ${table} SET status = 'deleted', updated_at = $4::timestamp(3)
WHERE tenant_id = $1 AND queue = $2 AND name = $3 AND status IN ('pending', 'running')`,
          [tx.tenantId, queue, name, nowText()],
        ),
      );
      if ((rowCount ?? 0) > 0) return { name, deleted: true };
    }
    return { name, deleted: false };
  }

  async function list(queue: string): Promise<TaskInfo[]> {
    const tasks: TaskInfo[] = [];
    for (const tenant of await scanTenants()) {
      const { rows } = await inTenant(tenant, (tx) =>
        tx.query<ListRow>(
          `SELECT name, schedule_time, status, attempts FROM ${table}
WHERE tenant_id = $1 AND queue = $2 AND status IN ('pending', 'running') ORDER BY schedule_time, name`,
          [tx.tenantId, queue],
        ),
      );
      for (const row of rows) {
        tasks.push({
          queue,
          name: row.name,
          scheduleTime: fromLocalTimestamp(row.schedule_time),
          ...(tenant === SYSTEM_TENANT_ID ? {} : { tenantId: tenant }),
          status: row.status,
          attempts: row.attempts,
        });
      }
    }
    return tasks.sort(byScheduleThenName);
  }

  async function setPaused(queue: string, paused: boolean): Promise<void> {
    queueDefinition(queue);
    await inTenant(SYSTEM_TENANT_ID, (tx) =>
      tx.query(
        `INSERT INTO ${stateTable} (tenant_id, queue, paused, updated_at) VALUES ($1, $2, $3, $4::timestamp(3))
ON CONFLICT (tenant_id, queue) DO UPDATE SET paused = EXCLUDED.paused, updated_at = EXCLUDED.updated_at`,
        [tx.tenantId, queue, paused, nowText()],
      ),
    );
  }

  async function queueState(queue: string): Promise<QueueState> {
    const { rows } = await inTenant(SYSTEM_TENANT_ID, (tx) =>
      tx.query<{ paused: boolean }>(`SELECT paused FROM ${stateTable} WHERE tenant_id = $1 AND queue = $2`, [tx.tenantId, queue]),
    );
    return { queue, paused: rows[0]?.paused ?? false };
  }

  async function settle(row: QueueRow, statusCode: number | null, failure: unknown): Promise<void> {
    const guard = 'WHERE tenant_id = $1 AND queue = $2 AND name = $3 AND status = $4 AND attempts = $5';
    const keys = [row.tenant_id, row.queue, row.name, 'running', row.attempts];
    const now = clock.now();
    if (failure === undefined && statusCode !== null && statusCode >= 200 && statusCode < 300) {
      await inTenant(row.tenant_id, (tx) =>
        tx.query(
          `UPDATE ${table} SET status = 'done', lease_until = NULL, last_status = $6, updated_at = $7::timestamp(3) ${guard}`,
          [...keys, statusCode, toLocalTimestamp(now)],
        ),
      );
      return;
    }
    const policy = queueDefinition(row.queue).retry;
    const exhausted = isExhausted(policy, row.attempts);
    const delayS = retryDelayS(policy, row.attempts);
    const retryAt = exhausted ? null : toLocalTimestamp(new Date(now.getTime() + delayS * 1000));
    const status = exhausted ? 'failed' : 'pending';
    await inTenant(row.tenant_id, (tx) =>
      tx.query(
        `UPDATE ${table} SET status = $6, schedule_time = COALESCE($7::timestamp(3), schedule_time), lease_until = NULL,
  last_status = $8, updated_at = $9::timestamp(3) ${guard}`,
        [...keys, status, retryAt, statusCode, toLocalTimestamp(now)],
      ),
    );
    const outcome = statusCode === null ? 'got no response' : `answered HTTP ${String(statusCode)}`;
    const next = exhausted ? 'task failed' : `retry in ${String(delayS)} s`;
    logger.warn(
      {
        queue: row.queue,
        name: row.name,
        tenantId: row.tenant_id,
        attempts: row.attempts,
        status,
        ...(statusCode === null ? {} : { statusCode }),
        ...(failure === undefined ? {} : { error: failure }),
      },
      `Local task ${row.queue}/${row.name} attempt ${String(row.attempts)} ${outcome}; ${next}`,
    );
  }

  async function dispatch(row: QueueRow): Promise<void> {
    let statusCode: number | null = null;
    let failure: unknown;
    try {
      const audience = resolveTarget(row.url, row.queue);
      const prior = String(row.attempts - 1);
      // With the instrumentation subscribed, the stored context is made active instead, so traceparent is sent once.
      const trace = undiciRequestCreated.hasSubscribers ? {} : row.headers;
      const headers: Record<string, string> = {
        ...trace,
        'content-type': 'application/json',
        authorization: `Bearer ${await signer(audience)}`,
        [CLOUD_TASKS_HEADERS.taskName]: row.name,
        [CLOUD_TASKS_HEADERS.queueName]: row.queue,
        [CLOUD_TASKS_HEADERS.retryCount]: prior,
        [CLOUD_TASKS_HEADERS.executionCount]: prior,
        [CLOUD_TASKS_HEADERS.eta]: String(fromLocalTimestamp(row.schedule_time).getTime() / 1000),
      };
      const deadlineMs = row.deadline_s * 1000;
      const response = await withExtractedContext(row.headers, () =>
        send(row.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(row.body),
          headersTimeout: deadlineMs,
          bodyTimeout: deadlineMs,
          // undici's parser timers fire up to ~500 ms late, so the signal holds the whole attempt to the deadline.
          signal: AbortSignal.timeout(deadlineMs),
        }),
      );
      statusCode = response.statusCode;
      await response.body.dump();
    } catch (err) {
      failure = err;
    }
    await settle(row, statusCode, failure);
  }

  const inflight = new Set<Promise<void>>();

  function track(work: Promise<void>): Promise<void> {
    const tracked = work
      .catch((err: unknown) => {
        logger.error({ error: err }, 'Local task dispatch could not record its outcome');
      })
      .finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    return tracked;
  }

  let lastPurgeMs: number | undefined;

  async function purgeTombstones(tenants: readonly string[], now: Date): Promise<void> {
    if (lastPurgeMs !== undefined && now.getTime() - lastPurgeMs < PURGE_INTERVAL_MS) return;
    lastPurgeMs = now.getTime();
    const cutoff = toLocalTimestamp(new Date(now.getTime() - LOCAL_TOMBSTONE_RETENTION_S * 1000));
    for (const tenant of tenants) {
      await inTenant(tenant, (tx) =>
        tx.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND status IN ('done', 'failed', 'deleted') AND updated_at < $2::timestamp(3)`,
          [tx.tenantId, cutoff],
        ),
      );
    }
  }

  /** Claims due rows tenant by tenant and starts their dispatches; resolves after the claims, not the dispatches. */
  async function scan(): Promise<Promise<void>[]> {
    const now = clock.now();
    const nowTs = toLocalTimestamp(now);
    const paused = await inTenant(SYSTEM_TENANT_ID, async (tx) => {
      const { rows } = await tx.query<{ queue: string }>(`SELECT queue FROM ${stateTable} WHERE tenant_id = $1 AND paused`, [
        tx.tenantId,
      ]);
      return rows.map((row) => row.queue);
    });
    const tenants = await scanTenants();
    const dispatches: Promise<void>[] = [];
    for (const tenant of tenants) {
      const { rows } = await inTenant(tenant, (tx) => tx.query<QueueRow>(claimSql, [nowTs, LEASE_MARGIN_S, paused, batchSize]));
      for (const row of rows) dispatches.push(track(dispatch(row)));
    }
    await purgeTombstones(tenants, now);
    return dispatches;
  }

  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | undefined;

  function schedule(): void {
    timer = setTimeout(() => {
      timer = undefined;
      ticking = scan()
        .then(
          () => undefined,
          (err: unknown) => {
            logger.error({ error: err }, 'Local tasks scan failed');
          },
        )
        .finally(() => {
          ticking = undefined;
          if (started && timer === undefined) schedule();
        });
    }, pollIntervalMs);
    timer.unref();
  }

  function start(): void {
    if (started) return;
    started = true;
    if (timer === undefined && ticking === undefined) schedule();
  }

  async function stop(): Promise<void> {
    started = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await ticking;
    while (inflight.size > 0) await Promise.all(inflight);
  }

  const port: LocalTaskPort = {
    kind: 'local',
    create,
    delete: deleteTask,
    list,
    pauseQueue: (queue) => setPaused(queue, true),
    resumeQueue: (queue) => setPaused(queue, false),
    queueState,
    close: stop,
    start,
    stop,
    async dispatchDue() {
      const dispatches = await scan();
      await Promise.all(dispatches);
      return dispatches.length;
    },
  };
  if (opts.autoStart ?? true) port.start();
  return port;
}
