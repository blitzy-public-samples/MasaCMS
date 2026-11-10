import { queueDefinition, type QueueName } from './queues.js';
import type { TenantDb } from '../tenancy/index.js';
import { z, type Clock, type FastifyReply, type FastifyRequest } from '../service-kit/index.js';

/** Adapter behind a task port. */
export type TaskAdapterKind = 'local' | 'cloud';

/** One task to create; omitting `tenantId` makes a tenant-less system task, as every recurring task is. */
export interface CreateTaskInput {
  queue: QueueName | (string & Record<never, never>);
  /** Deterministic, caller-chosen task id; see `TASK_NAME_PATTERN`. */
  name: string;
  scheduleTime: Date;
  /** Absolute http(s) URL the task POSTs to. */
  url: string;
  /** Sent to the target as the wire body's `payload`. */
  body?: unknown;
  /** Dispatch deadline in seconds, 15–1800. */
  deadlineS: number;
  tenantId?: string;
}

/** Outcome of `create`; `created: false` means ALREADY_EXISTS (live or recently executed or deleted name), not an error. */
export interface CreateTaskResult {
  name: string;
  created: boolean;
}

/** Outcome of `delete`; `deleted: false` means NOT_FOUND, not an error. */
export interface DeleteTaskResult {
  name: string;
  deleted: boolean;
}

/** A live (pending or running) task; tombstones are never listed. */
export interface TaskInfo {
  queue: string;
  name: string;
  scheduleTime: Date;
  /** Absent for system tasks, and wherever the adapter cannot see the body. */
  tenantId?: string;
  status: 'pending' | 'running';
  attempts: number;
}

/** Dispatch state of one queue. */
export interface QueueState {
  queue: string;
  paused: boolean;
}

/** Task scheduling port implemented by the local and Cloud Tasks adapters. */
export interface TaskPort {
  /** Adapter backing this port. */
  readonly kind: TaskAdapterKind;
  /** Creates the named task; resolves `created: false` when the name already exists or is a recent tombstone. */
  create(input: CreateTaskInput): Promise<CreateTaskResult>;
  /** Deletes a live task; `tenantId` narrows the local adapter's search, and the cloud adapter ignores it. */
  delete(queue: string, name: string, opts?: { tenantId?: string }): Promise<DeleteTaskResult>;
  /** Live tasks of the queue. */
  list(queue: string): Promise<TaskInfo[]>;
  /** Stops dispatch from the queue; creation still succeeds. */
  pauseQueue(queue: string): Promise<void>;
  /** Restarts dispatch from the queue. */
  resumeQueue(queue: string): Promise<void>;
  /** Whether the queue is paused. */
  queueState(queue: string): Promise<QueueState>;
  /** Stops the adapter's dispatcher or client and waits for in-flight work. */
  close(): Promise<void>;
}

/** Logger subset the adapters use; pino and Fastify loggers satisfy it. */
export interface TaskLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** JSON body both adapters POST to the task target. */
export interface TaskWireBody {
  queue: string;
  name: string;
  tenantId: string | null;
  payload: unknown;
}

const taskWireBodySchema = z.object({
  queue: z.string().min(1),
  name: z.string().min(1),
  tenantId: z.uuid().nullable(),
  payload: z.unknown().default(null),
});

/** Wire body of a task; a missing tenant or body becomes `null`. */
export function taskWireBody(input: CreateTaskInput): TaskWireBody {
  return { queue: input.queue, name: input.name, tenantId: input.tenantId ?? null, payload: input.body ?? null };
}

/** Parses a received task body; throws the zod error, which handlers answer as legacy `invalidParameters`. */
export function parseTaskWireBody(raw: unknown): TaskWireBody {
  return taskWireBodySchema.parse(raw);
}

/** Lower-cased `X-CloudTasks-*` request header names, which the local adapter sets exactly as Cloud Tasks does. */
export const CLOUD_TASKS_HEADERS = {
  taskName: 'x-cloudtasks-taskname',
  queueName: 'x-cloudtasks-queuename',
  retryCount: 'x-cloudtasks-taskretrycount',
  executionCount: 'x-cloudtasks-taskexecutioncount',
  eta: 'x-cloudtasks-tasketa',
} as const;

/** What a task handler receives; `stored` is the row a tenant task route found under the body's tenant. */
export interface TaskContext<S = unknown> {
  queue: string;
  taskName: string;
  retryCount: number;
  executionCount: number;
  eta?: Date;
  tenantId: string | null;
  payload: unknown;
  stored?: S;
  request: FastifyRequest;
  reply: FastifyReply;
}

/** Task route body; its result is sent as the 200 JSON body, `{ ok: true }` when undefined. */
export type TaskHandler<S = unknown> = (ctx: TaskContext<S>) => Promise<unknown>;

/** Cloud Tasks task-id charset and length. */
export const TASK_NAME_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;

/** Raised for a task name outside `TASK_NAME_PATTERN`. */
export class InvalidTaskNameError extends Error {
  override readonly name = 'InvalidTaskNameError';

  constructor(readonly taskName: string) {
    super(`Invalid task name ${JSON.stringify(taskName)}: expected 1-500 characters from A-Z, a-z, 0-9, _ and -`);
  }
}

/** Raised when the environment or options cannot build the selected adapter. */
export class TaskPortConfigError extends Error {
  override readonly name = 'TaskPortConfigError';
}

/** Throws `InvalidTaskNameError` unless `name` matches `TASK_NAME_PATTERN`. */
export function assertTaskName(name: string): void {
  if (!TASK_NAME_PATTERN.test(name)) throw new InvalidTaskNameError(name);
}

/** Checks a create request once, at the adapter boundary; throws `UnknownQueueError`, `InvalidTaskNameError`, `RangeError` or `TypeError`. */
export function assertCreateInput(input: CreateTaskInput): void {
  queueDefinition(input.queue);
  assertTaskName(input.name);
  if (!Number.isInteger(input.deadlineS) || input.deadlineS < 15 || input.deadlineS > 1800) {
    throw new RangeError(`deadlineS must be an integer from 15 to 1800, got ${String(input.deadlineS)}`);
  }
  if (Number.isNaN(input.scheduleTime.getTime())) throw new TypeError('scheduleTime must be a valid Date');
  const protocol = URL.parse(input.url)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') throw new TypeError(`url must be an absolute http(s) URL: ${input.url}`);
}

/** Variables the task factory reads; a structural subset of the service-kit env. */
export interface TaskEnv {
  OPT2_TASKS_ADAPTER?: TaskAdapterKind;
  /** Base URL per service, as `OPT2_SERVICE_URLS` parses; the local adapter resolves task targets from it. */
  OPT2_SERVICE_URLS?: Record<string, string>;
  OPT2_STATE_DIR?: string;
  GOOGLE_CLOUD_PROJECT?: string;
}

/** `db` is required by the local adapter; `cloud.client` replaces the Cloud Tasks client and `cloud.location` the metadata lookup. */
export interface CreateTaskPortOptions {
  db?: TenantDb;
  clock?: Clock;
  logger?: TaskLogger;
  cloud?: { client?: unknown; location?: string };
  local?: { pollIntervalMs?: number; batchSize?: number; autoStart?: boolean };
}

// Non-literal specifiers keep the port free of a compile-time dependency on its adapters, which import it;
// each adapter module must export the factory shape declared below.
const LOCAL_ADAPTER_MODULE = './local-adapter.js';
const CLOUD_ADAPTER_MODULE = './cloud-adapter.js';

interface LocalAdapterModule {
  createLocalTaskAdapter: (
    opts: { db: TenantDb; stateDir: string; serviceUrls: Record<string, string>; clock?: Clock; logger?: TaskLogger } & NonNullable<
      CreateTaskPortOptions['local']
    >,
  ) => Promise<TaskPort>;
}

interface CloudAdapterModule {
  createCloudTaskAdapter: (opts: { project: string; location?: string; client?: unknown; logger?: TaskLogger }) => Promise<TaskPort>;
}

/** Creates the adapter `OPT2_TASKS_ADAPTER` selects, loading only that adapter's module; callers close the port in Fastify `onClose`. */
export async function createTaskPort(env: TaskEnv, opts: CreateTaskPortOptions = {}): Promise<TaskPort> {
  const { db, clock, logger } = opts;
  switch (env.OPT2_TASKS_ADAPTER) {
    case 'local': {
      if (!db || !env.OPT2_STATE_DIR) throw new TaskPortConfigError('The local tasks adapter requires a TenantDb and OPT2_STATE_DIR');
      const { createLocalTaskAdapter } = (await import(LOCAL_ADAPTER_MODULE)) as LocalAdapterModule;
      // An absent map matches the env loader's '{}' default.
      const serviceUrls = env.OPT2_SERVICE_URLS ?? {};
      return createLocalTaskAdapter({ db, stateDir: env.OPT2_STATE_DIR, serviceUrls, clock, logger, ...opts.local });
    }
    case 'cloud': {
      if (!env.GOOGLE_CLOUD_PROJECT) throw new TaskPortConfigError('GOOGLE_CLOUD_PROJECT is required for the cloud tasks adapter');
      const { createCloudTaskAdapter } = (await import(CLOUD_ADAPTER_MODULE)) as CloudAdapterModule;
      return createCloudTaskAdapter({
        project: env.GOOGLE_CLOUD_PROJECT,
        location: opts.cloud?.location,
        client: opts.cloud?.client,
        logger,
      });
    }
    default:
      throw new TaskPortConfigError(`OPT2_TASKS_ADAPTER must be local or cloud, got ${String(env.OPT2_TASKS_ADAPTER)}`);
  }
}
