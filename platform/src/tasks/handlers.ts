// Fastify bindings of @opt2/platform/tasks: managed Cloud Tasks routes, queue-control routes and the reconcile client.
import { CLOUD_TASKS_HEADERS, parseTaskWireBody, type TaskHandler, type TaskPort, type TaskWireBody } from './port.js';
import { QUEUES, SITEMONITOR_QUEUE, isQueueName, queueDefinition, recurringQueues, type QueueDefinition } from './queues.js';
import { ensureRecurring, recurringSpec, type EnsureRecurringResult } from './recurring.js';
import { Roles, TASKS_INVOKER_ROLE, transportForPath, type Opt2RouteConfig } from '../auth/index.js';
import { assertTenantId, withTenant, type TenantDb, type TenantTx } from '../tenancy/index.js';
import { LegacyApiError } from '../legacy-compat/index.js';
import {
  currentRequestContext,
  z,
  type Clock,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceClient,
} from '../service-kit/index.js';

/** A task body's tenant is absent, not visible on its stored row, or present on a system task; renders as legacy 400 `badRequest`. */
export class TaskTenantMismatchError extends LegacyApiError {
  override readonly name: string = 'TaskTenantMismatchError';
  declare readonly type: 'badRequest';

  constructor(
    readonly tenantId: string | null,
    readonly taskName: string,
  ) {
    super('badRequest');
  }
}

/** Tenant handling of a task route: `tenant` re-checks the body's tenant against the stored row, `system` refuses any tenant. */
export type TaskRouteOptions<S = unknown> =
  | {
      scope: 'tenant';
      db: TenantDb;
      /** The row the task acts on as visible under the body's tenant, or null when it is not. */
      findStored: (tx: TenantTx, payload: unknown, ctx: { taskName: string; queue: string }) => Promise<S | null>;
      handler: TaskHandler<S>;
    }
  | { scope: 'system'; handler: TaskHandler };

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function countHeader(request: FastifyRequest, name: string): number {
  const count = Number.parseInt(headerOf(request, name) ?? '', 10);
  return Number.isInteger(count) ? count : 0;
}

function etaHeader(request: FastifyRequest): Date | undefined {
  const raw = headerOf(request, CLOUD_TASKS_HEADERS.eta);
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
}

function wireBodyOf(raw: unknown): TaskWireBody {
  try {
    return parseTaskWireBody(raw);
  } catch (err) {
    throw err instanceof z.ZodError ? new LegacyApiError('invalidParameters') : err;
  }
}

/** Registers a POST task route on the `cloud-tasks` transport; throws `TypeError` for a path outside the managed task families. */
export function registerTaskRoute<S>(app: FastifyInstance, path: string, opts: TaskRouteOptions<S>): void {
  if (transportForPath(path) !== 'cloud-tasks') {
    throw new TypeError(
      `Task route ${path} must be under /internal/v1/tasks/ or /internal/v1/jobs/, or be /internal/v1/outbox/sweep`,
    );
  }
  const opt2: Opt2RouteConfig = { transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE] };
  app.post(path, { config: { opt2 } }, async (request, reply) => {
    const body = wireBodyOf(request.body);
    const taskName = headerOf(request, CLOUD_TASKS_HEADERS.taskName) || body.name;
    const queue = headerOf(request, CLOUD_TASKS_HEADERS.queueName) || body.queue;
    const base = {
      queue,
      taskName,
      retryCount: countHeader(request, CLOUD_TASKS_HEADERS.retryCount),
      executionCount: countHeader(request, CLOUD_TASKS_HEADERS.executionCount),
      eta: etaHeader(request),
      payload: body.payload,
      request,
      reply,
    };

    let result: unknown;
    if (opts.scope === 'system') {
      if (body.tenantId !== null) throw new TaskTenantMismatchError(body.tenantId, taskName);
      result = await opts.handler({ ...base, tenantId: null });
    } else {
      if (body.tenantId === null) throw new TaskTenantMismatchError(null, taskName);
      const tenantId = assertTenantId(body.tenantId);
      const stored = await withTenant(opts.db, tenantId, (tx) => opts.findStored(tx, body.payload, { taskName, queue }));
      // Invisible under the body's tenant: the body never chooses a tenant on its own.
      if (stored === null) throw new TaskTenantMismatchError(tenantId, taskName);
      const context = currentRequestContext();
      if (context !== undefined) context.tenantId = tenantId;
      result = await opts.handler({ ...base, tenantId, stored });
    }

    if (reply.sent) return reply;
    return reply.code(200).send(result ?? { ok: true });
  });
}

/** Path prefix of the queue-control routes, outside the cloud-tasks-only `/internal/v1/tasks/` family. */
export const QUEUE_CONTROL_PREFIX = '/internal/v1/task-queues';

/** Operation of a queue-control route. */
export type QueueControlOp = 'pause' | 'resume' | 'ensure';

/** Roles that may call the queue-control routes. */
export const QUEUE_CONTROL_ROLES = [Roles.platformMigration, Roles.platformOperator] as const;

/** Answer of a queue-control route: the queue's paused state, or the chain task `ensure` found or created. */
export interface QueueControlResult {
  queue: string;
  service: string;
  paused?: boolean;
  ensured?: EnsureRecurringResult;
}

/** Registers POST `<QUEUE_CONTROL_PREFIX>/:queue/{pause,resume,ensure}` for queues this service creates; list them in its contracts/openapi.yaml. */
export function registerQueueControl(
  app: FastifyInstance,
  opts: { port: TaskPort; service: string; serviceUrls: Record<string, string>; clock: Clock },
): void {
  const { port, service } = opts;
  const opt2: Opt2RouteConfig = { transport: 'service', requires: [...QUEUE_CONTROL_ROLES] };
  const ownQueue = (queue: string): QueueDefinition => {
    if (!isQueueName(queue) || !queueDefinition(queue).creators.includes(service)) {
      throw new LegacyApiError('invalidParameters');
    }
    return queueDefinition(queue);
  };

  for (const op of ['pause', 'resume'] as const) {
    app.post<{ Params: { queue: string } }>(
      `${QUEUE_CONTROL_PREFIX}/:queue/${op}`,
      { config: { opt2 } },
      async (request): Promise<QueueControlResult> => {
        const { name: queue } = ownQueue(request.params.queue);
        await (op === 'pause' ? port.pauseQueue(queue) : port.resumeQueue(queue));
        return { queue, service, paused: (await port.queueState(queue)).paused };
      },
    );
  }

  app.post<{ Params: { queue: string } }>(
    `${QUEUE_CONTROL_PREFIX}/:queue/ensure`,
    { config: { opt2 } },
    async (request): Promise<QueueControlResult> => {
      const def = ownQueue(request.params.queue);
      if (def.recurring === undefined) throw new LegacyApiError('invalidParameters');
      const ensured = await ensureRecurring(port, { ...recurringSpec(def.name, opts.serviceUrls), clock: opts.clock });
      return { queue: def.name, service, ensured };
    },
  );
}

/** Calls one creator's queue-control route; throws an `Error` naming the service, queue, op and status on a non-2xx answer. */
export async function callQueueControl(
  client: ServiceClient,
  req: { service: string; queue: string; op: QueueControlOp },
): Promise<QueueControlResult> {
  const { service, queue, op } = req;
  const response = await client.request<QueueControlResult>({
    service,
    method: 'POST',
    path: `${QUEUE_CONTROL_PREFIX}/${encodeURIComponent(queue)}/${op}`,
    json: {},
    // Queue control is the calling workload's own action, never one taken for a user.
    userToken: null,
  });
  if (response.status < 200 || response.status > 299) {
    throw new Error(`Queue control ${op} of ${queue} on ${service} answered HTTP ${String(response.status)}`);
  }
  return response.body;
}

/** Outcome of ensuring one queue's chain on one creating service. */
export interface ReconcileResult {
  queue: string;
  service: string;
  ok: boolean;
  ensured?: EnsureRecurringResult;
  error?: string;
  skipped?: string;
}

/** Named queues in registry order; throws `TypeError` for a non-recurring name, or the site monitor without `withSiteMonitor`. */
function namedRecurringQueues(names: readonly string[], withSiteMonitor: boolean): QueueDefinition[] {
  for (const name of names) {
    if (!isQueueName(name) || queueDefinition(name).recurring === undefined) {
      throw new TypeError(`Not a recurring task queue: ${name}`);
    }
    if (name === SITEMONITOR_QUEUE && !withSiteMonitor) {
      throw new TypeError(`${SITEMONITOR_QUEUE} is reconciled only with withSiteMonitor`);
    }
  }
  const requested = new Set(names);
  return Object.values(QUEUES).filter((def) => requested.has(def.name));
}

/** Asks each creator of the selected recurring queues to ensure its chain, sequentially in registry order; failures are reported, not thrown. */
export async function reconcileRecurringQueues(
  client: ServiceClient,
  opts: { serviceUrls: Record<string, string>; queues?: string[]; withSiteMonitor?: boolean; includeLocalOnly?: boolean },
): Promise<ReconcileResult[]> {
  const explicit = opts.queues !== undefined;
  const selected =
    opts.queues === undefined
      ? recurringQueues({ includeLocalOnly: opts.includeLocalOnly, withSiteMonitor: opts.withSiteMonitor })
      : namedRecurringQueues(opts.queues, opts.withSiteMonitor === true);

  const results: ReconcileResult[] = [];
  for (const { name: queue, creators } of selected) {
    for (const service of creators) {
      if (!Object.hasOwn(opts.serviceUrls, service)) {
        results.push(
          explicit
            ? { queue, service, ok: false, error: 'not deployed' }
            : { queue, service, ok: true, skipped: 'not deployed' },
        );
        continue;
      }
      try {
        const { ensured } = await callQueueControl(client, { service, queue, op: 'ensure' });
        results.push({ queue, service, ok: true, ensured });
      } catch (err) {
        results.push({ queue, service, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return results;
}
