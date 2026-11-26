/** Parity of the suites' fake task port with the local adapter's tenant keying and paging. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_PAGE_SIZE, SITEMONITOR_QUEUE, type CreateTaskInput, type TaskPageRequest, type TaskPort } from '@opt2/platform/tasks';
import { SYSTEM_TENANT_ID, tenantIdForSite } from '@opt2/platform/tenancy';
import { createFakeTaskPort } from '../helpers/app.js';

const QUEUE = SITEMONITOR_QUEUE;
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');

function taskInput(name: string, tenantId?: string): CreateTaskInput {
  return {
    queue: QUEUE,
    name,
    scheduleTime: new Date('2026-06-30T12:00:00.000Z'),
    url: 'http://127.0.0.1:8113/internal/v1/tasks/sitemonitor',
    deadlineS: 60,
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

/** Names of every live task in `QUEUE`, following `nextPageToken`, with the size of each page. */
async function listAll(port: TaskPort, pageSize?: number): Promise<{ names: string[]; sizes: number[] }> {
  const names: string[] = [];
  const sizes: number[] = [];
  let pageToken: string | undefined;
  do {
    const request: TaskPageRequest = {
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(pageToken === undefined ? {} : { pageToken }),
    };
    const page = await port.list(QUEUE, request);
    names.push(...page.tasks.map((task) => task.name));
    sizes.push(page.tasks.length);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return { names, sizes };
}

describe('createFakeTaskPort tenant keying', () => {
  it('answers get only for the creating tenant', async () => {
    const port = createFakeTaskPort();
    await port.create(taskInput('job', TENANT_A));

    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_B })).resolves.toBeUndefined();
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toMatchObject({ name: 'job', tenantId: TENANT_A });
  });

  it('deletes only within the named tenant', async () => {
    const port = createFakeTaskPort();
    await port.create(taskInput('job', TENANT_A));

    await expect(port.delete(QUEUE, 'job', { tenantId: TENANT_B })).resolves.toEqual({ name: 'job', deleted: false });
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toBeDefined();
    await expect(port.delete(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toEqual({ name: 'job', deleted: true });
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toBeUndefined();
  });

  it('answers a get without a tenant from system tasks only, without a tenantId', async () => {
    const port = createFakeTaskPort();
    await port.create(taskInput('system-job'));
    await port.create(taskInput('tenant-job', TENANT_A));

    const system = await port.get(QUEUE, 'system-job');
    expect(system).toMatchObject({ queue: QUEUE, name: 'system-job', status: 'pending', attempts: 0 });
    expect(system).not.toHaveProperty('tenantId');
    await expect(port.get(QUEUE, 'system-job', { tenantId: SYSTEM_TENANT_ID })).resolves.toEqual(system);
    await expect(port.get(QUEUE, 'tenant-job')).resolves.toBeUndefined();

    await port.create(taskInput('explicit-system-job', SYSTEM_TENANT_ID));
    await expect(port.get(QUEUE, 'explicit-system-job')).resolves.not.toHaveProperty('tenantId');
  });

  it('deletes without a tenant from the system tenant first, then any tenant', async () => {
    const port = createFakeTaskPort();
    await port.create(taskInput('job', TENANT_A));
    await port.create(taskInput('job'));

    await expect(port.delete(QUEUE, 'job')).resolves.toEqual({ name: 'job', deleted: true });
    await expect(port.get(QUEUE, 'job')).resolves.toBeUndefined();
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toBeDefined();

    await expect(port.delete(QUEUE, 'job')).resolves.toEqual({ name: 'job', deleted: true });
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toBeUndefined();
    await expect(port.delete(QUEUE, 'job')).resolves.toEqual({ name: 'job', deleted: false });
  });

  it('creates the same name once per tenant', async () => {
    const port = createFakeTaskPort();

    await expect(port.create(taskInput('job', TENANT_A))).resolves.toEqual({ name: 'job', created: true });
    await expect(port.create(taskInput('job', TENANT_B))).resolves.toEqual({ name: 'job', created: true });
    await expect(port.create(taskInput('job'))).resolves.toEqual({ name: 'job', created: true });
    expect(port.tasks(QUEUE).map((task) => task.input.tenantId)).toEqual([TENANT_A, TENANT_B, undefined]);
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_B })).resolves.toMatchObject({ tenantId: TENANT_B });
  });

  it.each([
    { label: 'live system task', first: undefined, repeat: undefined, retire: 'none' },
    { label: 'system task named explicitly', first: undefined, repeat: SYSTEM_TENANT_ID, retire: 'none' },
    { label: 'live tenant task', first: TENANT_A, repeat: TENANT_A, retire: 'none' },
    { label: 'deleted tenant task', first: TENANT_A, repeat: TENANT_A, retire: 'delete' },
    { label: 'done tenant task', first: TENANT_A, repeat: TENANT_A, retire: 'done' },
  ] as const)('answers created: false for a repeated key of a $label', async ({ first, repeat, retire }) => {
    const port = createFakeTaskPort();
    await port.create(taskInput('job', first));
    if (retire === 'delete') await port.delete(QUEUE, 'job', { tenantId: first });
    if (retire === 'done') port.markDone('job', QUEUE, first);

    await expect(port.create(taskInput('job', repeat))).resolves.toEqual({ name: 'job', created: false });
    expect(port.tasks(QUEUE)).toHaveLength(1);
  });

  it('marks done the task of the named tenant only', async () => {
    const port = createFakeTaskPort();
    await port.create(taskInput('job', TENANT_A));
    await port.create(taskInput('job', TENANT_B));

    port.markDone('job', QUEUE, TENANT_B);
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_B })).resolves.toBeUndefined();
    await expect(port.get(QUEUE, 'job', { tenantId: TENANT_A })).resolves.toBeDefined();
    expect(() => {
      port.markDone('job', QUEUE, SYSTEM_TENANT_ID);
    }).toThrow(`fake task port holds no task ${SYSTEM_TENANT_ID}:${QUEUE}/job`);
  });
});

describe('createFakeTaskPort paging', () => {
  const COUNT = 130;
  const NAMES = Array.from({ length: COUNT }, (_, index) => `job-${String(index).padStart(3, '0')}`);

  async function portWithTasks(): Promise<TaskPort> {
    const port = createFakeTaskPort();
    for (const [index, name] of NAMES.entries()) await port.create(taskInput(name, index % 2 === 0 ? undefined : TENANT_A));
    return port;
  }

  it('pages by the default size when the request names none', async () => {
    const port = await portWithTasks();

    const first = await port.list(QUEUE);
    expect(first.tasks.map((task) => task.name)).toEqual(NAMES.slice(0, DEFAULT_TASK_PAGE_SIZE));
    expect(first.nextPageToken).toBeDefined();
    const rest = await port.list(QUEUE, { pageToken: first.nextPageToken });
    expect(rest.tasks.map((task) => task.name)).toEqual(NAMES.slice(DEFAULT_TASK_PAGE_SIZE));
    expect(rest).not.toHaveProperty('nextPageToken');
  });

  it.each([
    { pageSize: 1, sizes: Array.from({ length: COUNT }, () => 1) },
    { pageSize: 50, sizes: [50, 50, 30] },
    { pageSize: COUNT, sizes: [COUNT] },
    { pageSize: 1000, sizes: [COUNT] },
  ])('returns every live task once in pages of $pageSize', async ({ pageSize, sizes }) => {
    const port = await portWithTasks();

    await expect(listAll(port, pageSize)).resolves.toEqual({ names: NAMES, sizes });
  });

  it.each([0, 1001, 1.5])('rejects page size %s with a RangeError', async (pageSize) => {
    const port = await portWithTasks();

    await expect(port.list(QUEUE, { pageSize })).rejects.toThrow(RangeError);
  });
});
