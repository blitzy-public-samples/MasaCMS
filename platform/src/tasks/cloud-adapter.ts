// Cloud Tasks adapter of @opt2/platform/tasks: HTTP tasks dispatched with the tasks-invoker OIDC token.
import { managedAudience, serviceAccountEmail } from '../auth/index.js';
import { taskHeaders } from '../tracing/index.js';
import {
  TaskPortConfigError,
  assertCreateInput,
  assertTaskName,
  resolvePageSize,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskLogger,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from './port.js';
import { queueDefinition } from './queues.js';

/** Service account whose OIDC token Cloud Tasks attaches to every dispatch. */
export const TASKS_INVOKER_NAME = 'tasks-invoker';

/** gRPC status of a create whose task name exists or was used recently. */
export const GRPC_ALREADY_EXISTS = 6;

/** gRPC status of a get or delete whose task does not exist, a tombstone included. */
export const GRPC_NOT_FOUND = 5;

/** Metadata-server path that answers `projects/<number>/regions/<region>` on Cloud Run. */
export const METADATA_REGION_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/region';

/** Deadline of the metadata region lookup, covering the request and its body. */
export const METADATA_TIMEOUT_MS = 5000;

/** Protobuf timestamp as the client returns it; int64 `seconds` arrives as a string, number or Long. */
export interface CloudTimestampLike {
  seconds?: number | string | { toString(): string } | null;
  nanos?: number | null;
}

/** Fields `list` and `get` read from a BASIC-view task. */
export interface CloudTaskSummary {
  name?: string | null;
  scheduleTime?: CloudTimestampLike | null;
  dispatchCount?: number | null;
  responseCount?: number | null;
  firstAttempt?: unknown;
  lastAttempt?: unknown;
}

/** Task resource sent to `createTask`; Cloud Tasks adds `Authorization` from `oidcToken` at dispatch. */
export interface CloudTaskRequest {
  name: string;
  scheduleTime: { seconds: number; nanos: number };
  dispatchDeadline: { seconds: number };
  httpRequest: {
    httpMethod: 'POST';
    url: string;
    headers: Record<string, string>;
    /** Base64 of the JSON `TaskWireBody`. */
    body: string;
    oidcToken: { serviceAccountEmail: string; audience: string };
  };
}

/** Subset of `CloudTasksClient` the adapter calls; `@google-cloud/tasks` satisfies it and tests mock it. */
export interface CloudTasksClientLike {
  queuePath(project: string, location: string, queue: string): string;
  taskPath(project: string, location: string, queue: string, task: string): string;
  createTask(req: { parent: string; task: CloudTaskRequest }): Promise<unknown>;
  deleteTask(req: { name: string }): Promise<unknown>;
  /** With `autoPaginate: false` it answers one page; the third element is the raw response carrying `nextPageToken`. */
  listTasks(
    req: { parent: string; responseView: 'BASIC'; pageSize: number; pageToken?: string },
    options: { autoPaginate: false },
  ): Promise<[CloudTaskSummary[], unknown, { nextPageToken?: string | null } | null | undefined, ...unknown[]]>;
  getTask(req: { name: string; responseView: 'BASIC' }): Promise<[CloudTaskSummary, ...unknown[]]>;
  getQueue(req: { name: string }): Promise<[{ state?: string | number | null }, ...unknown[]]>;
  pauseQueue(req: { name: string }): Promise<unknown>;
  resumeQueue(req: { name: string }): Promise<unknown>;
  close(): Promise<void>;
}

/** `client` replaces the library client, `location` the metadata lookup, and `metadataFetch` that lookup's fetch. */
export interface CloudTaskAdapterOptions {
  project: string;
  location?: string;
  client?: CloudTasksClientLike;
  logger?: TaskLogger;
  metadataFetch?: typeof fetch;
}

/** Context `buildCloudTask` needs; `taskPath` defaults to the Cloud Tasks resource name and `headers` to the active trace context. */
export interface CloudTaskBuildContext {
  project: string;
  location: string;
  invokerEmail: string;
  taskPath?: (queue: string, task: string) => string;
  headers?: Record<string, string>;
}

/** Cloud Tasks HTTP task for `input`, carrying only `traceparent`/`tracestate` and the tasks-invoker OIDC token. */
export function buildCloudTask(input: CreateTaskInput, ctx: CloudTaskBuildContext): CloudTaskRequest {
  // The client's own `taskPath` format, spelt out so the pure builder never loads the library.
  const taskPath =
    ctx.taskPath ??
    ((queue: string, task: string) => `projects/${ctx.project}/locations/${ctx.location}/queues/${queue}/tasks/${task}`);
  const trace = ctx.headers ?? taskHeaders();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (trace.traceparent) headers.traceparent = trace.traceparent;
  if (trace.tracestate) headers.tracestate = trace.tracestate;
  const epochMs = input.scheduleTime.getTime();
  const seconds = Math.floor(epochMs / 1000);
  const target = new URL(input.url);
  return {
    name: taskPath(input.queue, input.name),
    scheduleTime: { seconds, nanos: (epochMs - seconds * 1000) * 1e6 },
    dispatchDeadline: { seconds: input.deadlineS },
    httpRequest: {
      httpMethod: 'POST',
      url: input.url,
      headers,
      body: Buffer.from(JSON.stringify(taskWireBody(input))).toString('base64'),
      // Same derivation as the cloud-tasks transport verifier, so creator and verifier agree on `aud`.
      oidcToken: { serviceAccountEmail: ctx.invokerEmail, audience: managedAudience(target.origin, target.pathname) },
    },
  };
}

/** Region of the running Cloud Run instance; throws `TaskPortConfigError` when the metadata server is unreachable, answers non-200 or misses `timeoutMs`. */
export async function resolveCloudTasksLocation(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<string> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let status: number;
  let body = '';
  try {
    const response = await fetchImpl(METADATA_REGION_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: deadline });
    status = response.status;
    if (status === 200) body = await response.text();
  } catch (err) {
    throw new TaskPortConfigError(
      deadline.aborted
        ? `Cloud Tasks location unavailable: the metadata server did not answer within ${timeoutMs} ms`
        : 'Cloud Tasks location unavailable: the metadata server is unreachable',
      { cause: err },
    );
  }
  if (status !== 200) {
    throw new TaskPortConfigError(`Cloud Tasks location unavailable: the metadata server answered ${status}`);
  }
  const region = body.trim().split('/').pop();
  if (!region) throw new TaskPortConfigError('Cloud Tasks location unavailable: the metadata server returned no region');
  return region;
}

function grpcCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function timestampToDate(timestamp: CloudTimestampLike | null | undefined): Date {
  const seconds = Number(String(timestamp?.seconds ?? 0));
  return new Date(seconds * 1000 + Math.floor((timestamp?.nanos ?? 0) / 1e6));
}

function toTaskInfo(queue: string, task: CloudTaskSummary): TaskInfo {
  const dispatchCount = task.dispatchCount ?? 0;
  return {
    queue,
    name: lastSegment(task.name ?? ''),
    scheduleTime: timestampToDate(task.scheduleTime),
    // An attempt dispatched without a response yet is still executing.
    status: dispatchCount > (task.responseCount ?? 0) ? 'running' : 'pending',
    attempts: dispatchCount,
  };
}

/** Creates the Cloud Tasks `TaskPort`, loading `@google-cloud/tasks` only without an injected `client`; ALREADY_EXISTS resolves as `created: false`, NOT_FOUND as `deleted: false` or an undefined `get`. */
export async function createCloudTaskAdapter(opts: CloudTaskAdapterOptions): Promise<TaskPort & { kind: 'cloud' }> {
  const { project, logger } = opts;
  // Resolved before the client is built, so a failed lookup leaves no client to close.
  const location = opts.location ?? (await resolveCloudTasksLocation(opts.metadataFetch));
  const client: CloudTasksClientLike = opts.client ?? new (await import('@google-cloud/tasks')).CloudTasksClient();
  const invokerEmail = serviceAccountEmail(TASKS_INVOKER_NAME, project);

  const queuePath = (queue: string): string => {
    queueDefinition(queue);
    return client.queuePath(project, location, queue);
  };
  const taskPath = (queue: string, task: string): string => client.taskPath(project, location, queue, task);

  return {
    kind: 'cloud',

    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      assertCreateInput(input);
      const task = buildCloudTask(input, { project, location, invokerEmail, taskPath });
      try {
        await client.createTask({ parent: client.queuePath(project, location, input.queue), task });
      } catch (err) {
        if (grpcCode(err) !== GRPC_ALREADY_EXISTS) throw err;
        logger?.info({ queue: input.queue, task: input.name }, 'Cloud task already exists');
        return { name: input.name, created: false };
      }
      return { name: input.name, created: true };
    },

    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      queueDefinition(queue);
      assertTaskName(name);
      try {
        await client.deleteTask({ name: taskPath(queue, name) });
      } catch (err) {
        if (grpcCode(err) !== GRPC_NOT_FOUND) throw err;
        return { name, deleted: false };
      }
      return { name, deleted: true };
    },

    async list(queue: string, page: TaskPageRequest = {}): Promise<TaskPage> {
      const parent = queuePath(queue);
      const pageSize = resolvePageSize(page.pageSize);
      const [tasks, , response] = await client.listTasks(
        { parent, responseView: 'BASIC', pageSize, ...(page.pageToken === undefined ? {} : { pageToken: page.pageToken }) },
        { autoPaginate: false },
      );
      const nextPageToken = response?.nextPageToken;
      return { tasks: tasks.map((task) => toTaskInfo(queue, task)), ...(nextPageToken ? { nextPageToken } : {}) };
    },

    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      queueDefinition(queue);
      assertTaskName(name);
      let task: CloudTaskSummary;
      try {
        [task] = await client.getTask({ name: taskPath(queue, name), responseView: 'BASIC' });
      } catch (err) {
        if (grpcCode(err) !== GRPC_NOT_FOUND) throw err;
        return undefined;
      }
      return toTaskInfo(queue, task);
    },

    async pauseQueue(queue: string): Promise<void> {
      await client.pauseQueue({ name: queuePath(queue) });
    },

    async resumeQueue(queue: string): Promise<void> {
      await client.resumeQueue({ name: queuePath(queue) });
    },

    async queueState(queue: string): Promise<QueueState> {
      const [resource] = await client.getQueue({ name: queuePath(queue) });
      return { queue, paused: resource.state === 'PAUSED' };
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
