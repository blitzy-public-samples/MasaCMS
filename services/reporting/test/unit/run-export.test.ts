// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * Export-run enqueuer and probe over a fake task port; the export runner over the memory database, local storage and stub sources; and
 * the run task of a `/v1` create delivered through the whole reporting app over the memory database.
 */
import { describe, expect, it } from 'vitest';
import {
  QUEUES,
  UnknownTaskTargetError,
  parseTaskWireBody,
  targetUrl,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type TaskInfo,
  type TaskPort,
} from '@opt2/platform/tasks';
import { fixedClock } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { createExportRunEnqueuer, createExportRunProbe, exportRunTaskName } from '../../src/tasks/enqueue.js';
import { defineExportRunTaskCases, defineExportRunnerCases } from '../helpers/run-export-cases.js';

const QUEUE = QUEUES['reporting-export-run'];
const JOB_ID = '6F0A2C1E-5B7D-4E8A-9C3F0D1E2F3A4B5C';
const PAYLOAD = { jobId: JOB_ID, asOf: '2026-06-30' };
const CLOCK = fixedClock('2026-06-30T10:00:00.000Z');
const SERVICE_URLS = { reporting: 'http://127.0.0.1:8116/' };

/** Task port recording `create` inputs and answering `get` with `get`; every other method is unused by the enqueuer and probe and throws. */
function fakeTasks(
  create: (input: CreateTaskInput) => Promise<CreateTaskResult>,
  get: TaskPort['get'] = () => {
    throw new Error('not called by the export-run enqueuer');
  },
): { port: TaskPort; calls: CreateTaskInput[] } {
  const calls: CreateTaskInput[] = [];
  const unused = (): never => {
    throw new Error('not called by the export-run enqueuer or probe');
  };
  const port: TaskPort = {
    kind: 'local',
    create: async (input) => {
      calls.push(input);
      return create(input);
    },
    delete: unused,
    list: unused,
    get,
    pauseQueue: unused,
    resumeQueue: unused,
    queueState: unused,
    close: unused,
  };
  return { port, calls };
}

const enqueueWith = (port: TaskPort, serviceUrls: Record<string, string> = SERVICE_URLS) =>
  createExportRunEnqueuer({ tasks: port, serviceUrls, clock: CLOCK });

const run = (enqueue: ReturnType<typeof enqueueWith>) => enqueue({ tenantId: TENANT_A.tenantId, jobId: JOB_ID, payload: PAYLOAD });

describe('export-run enqueuer', () => {
  it('names the task after the job, verbatim', () => {
    expect(exportRunTaskName(JOB_ID)).toBe(`reporting-export-run-${JOB_ID}`);
  });

  it.each([true, false])('creates one task due now on the export-run queue and resolves when created is %s', async (created) => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created }));

    await expect(run(enqueueWith(port))).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const [call] = calls as [CreateTaskInput];
    expect(call).toMatchObject({
      queue: 'reporting-export-run',
      name: exportRunTaskName(JOB_ID),
      url: targetUrl(QUEUE, SERVICE_URLS, { exportId: JOB_ID }),
      deadlineS: QUEUE.deadlineS,
      tenantId: TENANT_A.tenantId,
    });
    expect(call.url).toBe(`http://127.0.0.1:8116/internal/v1/tasks/exports/${JOB_ID}/run`);
    expect(call.scheduleTime).toEqual(CLOCK.now());
    expect(parseTaskWireBody(taskWireBody(call))).toEqual({
      queue: 'reporting-export-run',
      name: exportRunTaskName(JOB_ID),
      tenantId: TENANT_A.tenantId,
      payload: PAYLOAD,
    });
  });

  it('gives repeated enqueues of one job the same task name', async () => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created: calls.length === 1 }));
    const enqueue = enqueueWith(port);

    await run(enqueue);
    await run(enqueue);

    expect(calls.map((call) => call.name)).toEqual([exportRunTaskName(JOB_ID), exportRunTaskName(JOB_ID)]);
  });

  it('raises the legacy 503 with the original error as cause when create rejects', async () => {
    const original = new Error('ECONNREFUSED');
    const { port } = fakeTasks(() => Promise.reject(original));

    const err: unknown = await run(enqueueWith(port)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ reason: 'tasks-unavailable', cause: original });
  });

  it('rethrows a legacy 503 from create unchanged', async () => {
    const original = new LegacyServiceUnavailableError('Unit gate closed', 'auto', 'gate-closed');
    const { port } = fakeTasks(() => Promise.reject(original));

    await expect(run(enqueueWith(port))).rejects.toBe(original);
  });

  it('fails with the configuration error and creates nothing when no reporting URL is configured', async () => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created: true }));

    await expect(run(enqueueWith(port, {}))).rejects.toBeInstanceOf(UnknownTaskTargetError);
    expect(calls).toHaveLength(0);
  });
});

describe('export-run probe', () => {
  const noCreate = (): Promise<CreateTaskResult> => Promise.reject(new Error('not called by the export-run probe'));
  const probe = (get: TaskPort['get']) =>
    createExportRunProbe({ tasks: fakeTasks(noCreate, get).port })({ tenantId: TENANT_A.tenantId, jobId: JOB_ID });
  const live: TaskInfo = {
    queue: QUEUE.name,
    name: exportRunTaskName(JOB_ID),
    scheduleTime: CLOCK.now(),
    tenantId: TENANT_A.tenantId,
    status: 'running',
    attempts: 2,
  };

  it.each<[string, TaskInfo | undefined, boolean]>([
    ['a live task', live, true],
    ['no live task', undefined, false],
  ])("looks up the job's task under its tenant and answers %s as %s", async (_case, task, scheduled) => {
    const gets: Parameters<TaskPort['get']>[] = [];

    await expect(
      probe((...args) => {
        gets.push(args);
        return Promise.resolve(task);
      }),
    ).resolves.toBe(scheduled);

    expect(gets).toStrictEqual([[QUEUE.name, exportRunTaskName(JOB_ID), { tenantId: TENANT_A.tenantId }]]);
  });

  it('raises the legacy 503 with the original error as cause when the lookup rejects', async () => {
    const original = new Error('ECONNREFUSED');

    const err: unknown = await probe(() => Promise.reject(original)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ message: `Task queue ${QUEUE.name} unavailable`, reason: 'tasks-unavailable', cause: original });
  });

  it('rethrows a legacy 503 from the lookup unchanged', async () => {
    const original = new LegacyServiceUnavailableError('Unit gate closed', 'auto', 'gate-closed');

    await expect(probe(() => Promise.reject(original))).rejects.toBe(original);
  });
});

describe('export runner', () => {
  defineExportRunnerCases('recording');
});

describe('export-run task of a /v1 create through the reporting app', () => {
  defineExportRunTaskCases('recording');
});
