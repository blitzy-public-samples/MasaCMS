import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managedAudience, serviceAccountEmail } from '../../src/auth/index.js';
import {
  GRPC_ALREADY_EXISTS,
  GRPC_NOT_FOUND,
  METADATA_REGION_URL,
  TASKS_INVOKER_NAME,
  buildCloudTask,
  createCloudTaskAdapter,
  resolveCloudTasksLocation,
  type CloudTaskSummary,
  type CloudTasksClientLike,
} from '../../src/tasks/cloud-adapter.js';
import {
  InvalidTaskNameError,
  TaskPortConfigError,
  createTaskPort,
  type CreateTaskInput,
  type TaskLogger,
} from '../../src/tasks/port.js';
import { UnknownQueueError } from '../../src/tasks/queues.js';
import { MemorySpanExporter, SpanKind, shutdownTracing, startSpan, startTracing } from '../../src/tracing/index.js';

const PROJECT = 'opt2-plan';
const LOCATION = 'europe-west1';
const TENANT = '0b8f6c1e-5b7d-5e8a-9c3f-0d1e2f3a4b5c';
const INVOKER = `opt2-tasks-invoker@${PROJECT}.iam.gserviceaccount.com`;
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const queuePathOf = (queue: string): string => `projects/${PROJECT}/locations/${LOCATION}/queues/${queue}`;

const INPUT: CreateTaskInput = {
  queue: 'surveys-launch',
  name: 'surveys-launch-A1B2',
  scheduleTime: new Date(Date.UTC(2026, 5, 30, 12, 0, 0, 250)),
  url: 'https://surveys-abc.a.run.app/internal/v1/tasks/surveys/A1B2/launch?attempt=1',
  body: { surveyId: 'A1B2' },
  deadlineS: 60,
  tenantId: TENANT,
};

function fakeClient() {
  return {
    queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
    taskPath: vi.fn(
      (project: string, location: string, queue: string, task: string) =>
        `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
    ),
    createTask: vi.fn(async (_req: Parameters<CloudTasksClientLike['createTask']>[0]): Promise<unknown> => [{}]),
    deleteTask: vi.fn(async (_req: { name: string }): Promise<unknown> => [{}]),
    listTasks: vi.fn(async (_req: { parent: string; responseView: 'BASIC' }): Promise<[CloudTaskSummary[], ...unknown[]]> => [[]]),
    getQueue: vi.fn(async (_req: { name: string }): Promise<[{ state?: string | number | null }, ...unknown[]]> => [{ state: 'RUNNING' }]),
    pauseQueue: vi.fn(async (_req: { name: string }): Promise<unknown> => [{}]),
    resumeQueue: vi.fn(async (_req: { name: string }): Promise<unknown> => [{}]),
    close: vi.fn(async (): Promise<void> => undefined),
  } satisfies CloudTasksClientLike;
}

function decodeBody(body: string): unknown {
  return JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
}

function grpcError(code: number): Error {
  return Object.assign(new Error(`grpc ${code}`), { code });
}

describe('buildCloudTask', () => {
  it('builds the HTTP task with the tasks-invoker OIDC token and only trace headers', () => {
    const task = buildCloudTask(INPUT, {
      project: PROJECT,
      location: LOCATION,
      invokerEmail: INVOKER,
      headers: { traceparent: TRACEPARENT, tracestate: 'rojo=00f067aa0ba902b7', authorization: 'Bearer user-token' },
    });
    expect(task).toStrictEqual({
      name: `${queuePathOf('surveys-launch')}/tasks/surveys-launch-A1B2`,
      scheduleTime: { seconds: Math.floor(INPUT.scheduleTime.getTime() / 1000), nanos: 250_000_000 },
      dispatchDeadline: { seconds: 60 },
      httpRequest: {
        httpMethod: 'POST',
        url: INPUT.url,
        headers: { 'Content-Type': 'application/json', traceparent: TRACEPARENT, tracestate: 'rojo=00f067aa0ba902b7' },
        body: expect.any(String),
        oidcToken: {
          serviceAccountEmail: INVOKER,
          audience: managedAudience('https://surveys-abc.a.run.app', '/internal/v1/tasks/surveys/A1B2/launch'),
        },
      },
    });
    expect(task.httpRequest.oidcToken.audience).toBe('https://surveys-abc.a.run.app/internal/v1/tasks/surveys/A1B2/launch');
    expect(decodeBody(task.httpRequest.body)).toStrictEqual({
      queue: 'surveys-launch',
      name: 'surveys-launch-A1B2',
      tenantId: TENANT,
      payload: { surveyId: 'A1B2' },
    });
  });

  it('uses an injected task path and encodes a system task with null tenant and payload', () => {
    const { tenantId: _tenantId, body: _body, ...system } = INPUT;
    const task = buildCloudTask(system, {
      project: PROJECT,
      location: LOCATION,
      invokerEmail: INVOKER,
      taskPath: (queue, name) => `custom/${queue}/${name}`,
      headers: {},
    });
    expect(task.name).toBe('custom/surveys-launch/surveys-launch-A1B2');
    expect(task.httpRequest.headers).toStrictEqual({ 'Content-Type': 'application/json' });
    expect(decodeBody(task.httpRequest.body)).toStrictEqual({
      queue: 'surveys-launch',
      name: 'surveys-launch-A1B2',
      tenantId: null,
      payload: null,
    });
  });

  describe('with the tracing SDK', () => {
    beforeAll(async () => {
      await startTracing({ serviceName: 'tasks-cloud-adapter-test', version: '1.0.0', exporter: new MemorySpanExporter() });
    });

    afterAll(async () => {
      await shutdownTracing();
    });

    it('defaults headers to the active span and omits them outside a span', async () => {
      const ctx = { project: PROJECT, location: LOCATION, invokerEmail: INVOKER };
      expect(buildCloudTask(INPUT, ctx).httpRequest.headers).toStrictEqual({ 'Content-Type': 'application/json' });
      const { headers, ids } = await startSpan('enqueue', SpanKind.PRODUCER, (span) => ({
        headers: buildCloudTask(INPUT, ctx).httpRequest.headers,
        ids: span.spanContext(),
      }));
      expect(headers).toStrictEqual({ 'Content-Type': 'application/json', traceparent: `00-${ids.traceId}-${ids.spanId}-01` });
    });
  });
});

describe('resolveCloudTasksLocation', () => {
  it('returns the region segment of the metadata answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('projects/123456789/regions/europe-west1\n'));
    await expect(resolveCloudTasksLocation(fetchImpl as unknown as typeof fetch)).resolves.toBe('europe-west1');
    expect(fetchImpl).toHaveBeenCalledWith(METADATA_REGION_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  });

  it.each([
    ['a non-200 answer', async () => new Response('not found', { status: 404 })],
    ['an empty answer', async () => new Response('')],
    [
      'an unreachable server',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('throws TaskPortConfigError on %s', async (_case, impl) => {
    await expect(resolveCloudTasksLocation(vi.fn(impl) as unknown as typeof fetch)).rejects.toBeInstanceOf(
      TaskPortConfigError,
    );
  });
});

describe('createCloudTaskAdapter', () => {
  it('creates the task on the queue path and reports ALREADY_EXISTS as created:false', async () => {
    const client = fakeClient();
    const logger: TaskLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client, logger });
    expect(port.kind).toBe('cloud');

    await expect(port.create(INPUT)).resolves.toStrictEqual({ name: INPUT.name, created: true });
    const request = client.createTask.mock.calls[0]![0];
    expect(request.parent).toBe(queuePathOf('surveys-launch'));
    expect(request.task.name).toBe(`${queuePathOf('surveys-launch')}/tasks/surveys-launch-A1B2`);
    expect(request.task.httpRequest.oidcToken.serviceAccountEmail).toBe(serviceAccountEmail(TASKS_INVOKER_NAME, PROJECT));
    expect(request.task.dispatchDeadline.seconds).toBe(INPUT.deadlineS);

    client.createTask.mockRejectedValueOnce(grpcError(GRPC_ALREADY_EXISTS));
    await expect(port.create(INPUT)).resolves.toStrictEqual({ name: INPUT.name, created: false });
    expect(logger.info).toHaveBeenCalledWith({ queue: 'surveys-launch', task: INPUT.name }, 'Cloud task already exists');

    client.createTask.mockRejectedValueOnce(grpcError(7));
    await expect(port.create(INPUT)).rejects.toThrow('grpc 7');
  });

  it.each([
    ['an unknown queue', { queue: 'no-such-queue' }, UnknownQueueError],
    ['an invalid task name', { name: 'bad name' }, InvalidTaskNameError],
    ['a deadline out of range', { deadlineS: 5 }, RangeError],
  ])('rejects %s before calling the client', async (_case, override, error) => {
    const client = fakeClient();
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await expect(port.create({ ...INPUT, ...override })).rejects.toBeInstanceOf(error);
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('deletes by task path, ignores tenantId and reports NOT_FOUND as deleted:false', async () => {
    const client = fakeClient();
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await expect(port.delete('surveys-launch', 'task-1', { tenantId: TENANT })).resolves.toStrictEqual({
      name: 'task-1',
      deleted: true,
    });
    expect(client.deleteTask).toHaveBeenCalledWith({ name: `${queuePathOf('surveys-launch')}/tasks/task-1` });

    client.deleteTask.mockRejectedValueOnce(grpcError(GRPC_NOT_FOUND));
    await expect(port.delete('surveys-launch', 'task-1')).resolves.toStrictEqual({ name: 'task-1', deleted: false });

    client.deleteTask.mockRejectedValueOnce(grpcError(14));
    await expect(port.delete('surveys-launch', 'task-1')).rejects.toThrow('grpc 14');
  });

  it('lists the BASIC view and maps dispatch and response counts to status', async () => {
    const client = fakeClient();
    client.listTasks.mockResolvedValueOnce([
      [
        {
          name: `${queuePathOf('content-feed-import')}/tasks/running`,
          scheduleTime: { seconds: '1782820800', nanos: 500_000_000 },
          dispatchCount: 2,
          responseCount: 1,
        },
        {
          name: `${queuePathOf('content-feed-import')}/tasks/retrying`,
          scheduleTime: { seconds: 1782820801, nanos: 0 },
          dispatchCount: 3,
          responseCount: 3,
        },
        { name: `${queuePathOf('content-feed-import')}/tasks/new`, scheduleTime: { seconds: { toString: () => '10' } } },
      ],
      null,
      {},
    ]);
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await expect(port.list('content-feed-import')).resolves.toStrictEqual([
      { queue: 'content-feed-import', name: 'running', scheduleTime: new Date(1_782_820_800_500), status: 'running', attempts: 2 },
      { queue: 'content-feed-import', name: 'retrying', scheduleTime: new Date(1_782_820_801_000), status: 'pending', attempts: 3 },
      { queue: 'content-feed-import', name: 'new', scheduleTime: new Date(10_000), status: 'pending', attempts: 0 },
    ]);
    expect(client.listTasks).toHaveBeenCalledWith({ parent: queuePathOf('content-feed-import'), responseView: 'BASIC' });
  });

  it.each([
    ['PAUSED', true],
    ['RUNNING', false],
  ])('pauses, resumes and reads queue state %s', async (state, paused) => {
    const client = fakeClient();
    client.getQueue.mockResolvedValueOnce([{ state }]);
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await port.pauseQueue('people-outbox-sweep');
    await port.resumeQueue('people-outbox-sweep');
    expect(client.pauseQueue).toHaveBeenCalledWith({ name: queuePathOf('people-outbox-sweep') });
    expect(client.resumeQueue).toHaveBeenCalledWith({ name: queuePathOf('people-outbox-sweep') });
    await expect(port.queueState('people-outbox-sweep')).resolves.toStrictEqual({ queue: 'people-outbox-sweep', paused });
    expect(client.getQueue).toHaveBeenCalledWith({ name: queuePathOf('people-outbox-sweep') });
  });

  it.each([
    ['delete', (port: Awaited<ReturnType<typeof createCloudTaskAdapter>>) => port.delete('no-such-queue', 'task-1')],
    ['list', (port: Awaited<ReturnType<typeof createCloudTaskAdapter>>) => port.list('no-such-queue')],
    ['pauseQueue', (port: Awaited<ReturnType<typeof createCloudTaskAdapter>>) => port.pauseQueue('no-such-queue')],
    ['resumeQueue', (port: Awaited<ReturnType<typeof createCloudTaskAdapter>>) => port.resumeQueue('no-such-queue')],
    ['queueState', (port: Awaited<ReturnType<typeof createCloudTaskAdapter>>) => port.queueState('no-such-queue')],
  ])('%s rejects an unknown queue locally', async (_method, call) => {
    const client = fakeClient();
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await expect(call(port)).rejects.toBeInstanceOf(UnknownQueueError);
    expect(client.deleteTask).not.toHaveBeenCalled();
    expect(client.listTasks).not.toHaveBeenCalled();
    expect(client.pauseQueue).not.toHaveBeenCalled();
    expect(client.resumeQueue).not.toHaveBeenCalled();
    expect(client.getQueue).not.toHaveBeenCalled();
  });

  it('rejects an invalid task name on delete', async () => {
    const client = fakeClient();
    const port = await createCloudTaskAdapter({ project: PROJECT, location: LOCATION, client });
    await expect(port.delete('surveys-launch', 'bad/name')).rejects.toBeInstanceOf(InvalidTaskNameError);
    expect(client.deleteTask).not.toHaveBeenCalled();
  });

  it('resolves the location from the metadata server and closes the client', async () => {
    const client = fakeClient();
    const metadataFetch = vi.fn(async () => new Response('projects/1/regions/us-central1'));
    const port = await createCloudTaskAdapter({ project: PROJECT, client, metadataFetch: metadataFetch as unknown as typeof fetch });
    await port.pauseQueue('surveys-launch');
    expect(client.queuePath).toHaveBeenCalledWith(PROJECT, 'us-central1', 'surveys-launch');
    await port.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('is selected by createTaskPort with an injected client', async () => {
    const client = fakeClient();
    const port = await createTaskPort(
      { OPT2_TASKS_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: PROJECT },
      { cloud: { client, location: LOCATION } },
    );
    expect(port.kind).toBe('cloud');
    await port.resumeQueue('surveys-launch');
    expect(client.resumeQueue).toHaveBeenCalledWith({ name: queuePathOf('surveys-launch') });
  });
});
