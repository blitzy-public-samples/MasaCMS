/** Stub composition root: start-up chain, ownership of the publisher and task port on close, and fail-fast without a database. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublisher, type EventPublisher } from '@opt2/platform/events';
import { loadEnv, type BaseEnv } from '@opt2/platform/service-kit';
import { OUTBOX_SWEEP_PATH, createTaskPort, type CreateTaskInput, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';

// Records the order in which the instances buildApp creates itself are closed.
const closed: string[] = [];

vi.mock('@opt2/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tasks')>();
  return {
    ...actual,
    createTaskPort: vi.fn(async (...args: Parameters<typeof actual.createTaskPort>) => {
      const port = await actual.createTaskPort(...args);
      return { ...port, close: async () => (closed.push('taskPort'), port.close()) };
    }),
  };
});

vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  return {
    ...actual,
    createPublisher: vi.fn((...args: Parameters<typeof actual.createPublisher>) => {
      const publisher = actual.createPublisher(...args);
      return { ...publisher, close: async () => (closed.push('publisher'), publisher.close()) };
    }),
  };
});

const SERVICE_URL = 'http://127.0.0.1:8199';
const clock = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

let stateDir: string;
let handle: ThrowawaySchema | undefined;
let db: TenantDb;

function envFor(extra: Record<string, string> = {}): BaseEnv {
  return loadEnv(undefined, {
    PORT: '8199',
    OPT2_SERVICE_NAME: 'stub',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    OPT2_SERVICE_URLS: JSON.stringify({ stub: SERVICE_URL }),
    TZ: 'UTC',
    ...extra,
  });
}

/** In-memory task port keeping created tasks; `close` is a spy. */
function fakeTaskPort(): TaskPort & { tasks: CreateTaskInput[] } {
  const tasks: CreateTaskInput[] = [];
  const paused = new Set<string>();
  return {
    kind: 'local',
    tasks,
    create: async (input) => {
      if (tasks.some((task) => task.queue === input.queue && task.name === input.name)) return { name: input.name, created: false };
      tasks.push(input);
      return { name: input.name, created: true };
    },
    delete: async (_queue, name) => ({ name, deleted: false }),
    list: async (queue) => ({
      tasks: tasks
        .filter((task) => task.queue === queue)
        .map((task) => ({ queue, name: task.name, scheduleTime: task.scheduleTime, status: 'pending' as const, attempts: 0 })),
    }),
    get: async () => undefined,
    pauseQueue: async (queue) => void paused.add(queue),
    resumeQueue: async (queue) => void paused.delete(queue),
    queueState: async (queue) => ({ queue, paused: paused.has(queue) }),
    close: vi.fn(async () => undefined),
  };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-stub-app-'));
  await writeTestSecrets(stateDir);
  if (available) {
    handle = await createThrowawaySchema({
      service: 'stub',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    // The service's shutdown ends its pool; drop() ends the throwaway pools itself.
    db = { ...handle.app, end: () => Promise.resolve() };
  }
});

afterAll(async () => {
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  closed.length = 0;
  vi.mocked(createPublisher).mockClear();
});

describe.skipIf(!available)('buildApp against PostgreSQL', () => {
  it('creates the stub outbox sweep chain task on ready and leaves injected instances open on close', async () => {
    const taskPort = fakeTaskPort();
    const publisher: EventPublisher = createCapturingPublisher();
    const publisherClose = vi.spyOn(publisher, 'close');
    const app = await buildApp({ env: envFor(), db, publisher, taskPort, verifierOverride: testVerifier('stub'), clock });
    await app.ready();

    expect(taskPort.tasks).toEqual([
      expect.objectContaining({ queue: 'stub-outbox-sweep', url: `${SERVICE_URL}${OUTBOX_SWEEP_PATH}` }),
    ]);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    await app.opt2.shutdown();
    expect(taskPort.close).not.toHaveBeenCalled();
    expect(publisherClose).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
  });

  it('closes the task port it created, then the publisher it created', async () => {
    const app = await buildApp({
      env: envFor({ OPT2_TASKS_ADAPTER: 'local', PUBSUB_EMULATOR_HOST: '127.0.0.1:9' }),
      db,
      verifierOverride: testVerifier('stub'),
      clock,
    });
    await app.ready();
    await app.opt2.shutdown();
    expect(closed).toEqual(['taskPort', 'publisher']);
  });
});

describe('buildApp without a database', () => {
  it.each([
    ['no emulator host for its own publisher', {}, undefined, 'stub: invalid environment\n  PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local'],
    ['an emulator host but no database', { PUBSUB_EMULATOR_HOST: '127.0.0.1:9' }, undefined, 'Schema stub needs OPT2_DB_AUTH and PG_DATABASE'],
    ['an injected publisher but no database', {}, createCapturingPublisher(), 'Schema stub needs OPT2_DB_AUTH and PG_DATABASE'],
  ])('fails start-up with %s', async (_case, extra, publisher, message) => {
    const sigterm = process.listenerCount('SIGTERM');
    await expect(buildApp({ env: envFor(extra), publisher, verifierOverride: testVerifier('stub'), clock })).rejects.toThrow(message);
    expect(createPublisher).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });
});

describe('buildApp when its task port fails', () => {
  it.each([
    ['closes the publisher it created', false, false, ['publisher']],
    ['closes the publisher it created even when that close fails', false, true, ['publisher']],
    ['leaves an injected publisher open', true, false, []],
  ])('%s, keeps the injected pool, removes its SIGTERM listener and rethrows the failure', async (_case, inject, closeFails, expectedClosed) => {
    const failure = new Error('task port construction failed');
    vi.mocked(createTaskPort).mockRejectedValueOnce(failure);
    if (closeFails) {
      vi.mocked(createPublisher).mockImplementationOnce(() => ({
        ...createCapturingPublisher(),
        close: () => (closed.push('publisher'), Promise.reject(new Error('publisher close failed'))),
      }));
    }
    // Offline pool: the failure comes before any query, and `end` shows whether buildApp ended the injected pool.
    const end = vi.fn(() => Promise.resolve());
    const pool: TenantDb = { schema: 'stub', withTenant: vi.fn(), withMetadata: vi.fn(), end };
    const injectable = createCapturingPublisher();
    const injectableClose = vi.spyOn(injectable, 'close');
    const sigterm = process.listenerCount('SIGTERM');

    await expect(
      buildApp({
        env: envFor({ PUBSUB_EMULATOR_HOST: '127.0.0.1:9' }),
        db: pool,
        publisher: inject ? injectable : undefined,
        verifierOverride: testVerifier('stub'),
        clock,
      }),
    ).rejects.toBe(failure);
    expect(closed).toEqual(expectedClosed);
    expect(injectableClose).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });
});
