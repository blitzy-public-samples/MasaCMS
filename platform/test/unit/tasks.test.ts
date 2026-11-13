import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, collectRouteMatrix, recordedRoutes, transportForPath } from '../../src/auth/index.js';
import { LegacyApiError } from '../../src/legacy-compat/index.js';
import { createLogger } from '../../src/logging/index.js';
import { ServiceUnavailableError, UnknownServiceError } from '../../src/service-kit/client.js';
import { currentRequestContext } from '../../src/service-kit/context.js';
import { createService } from '../../src/service-kit/create-service.js';
import { loadEnv } from '../../src/service-kit/env.js';
import { z, type ServiceClient, type ServiceRequest, type ServiceResponse } from '../../src/service-kit/index.js';
import type { TenantDb, TenantTx } from '../../src/tenancy/index.js';
import { fixedClock } from '../../src/testing/clock.js';
import { TENANT_A, TENANT_B } from '../../src/testing/fixtures.js';
import { mintServiceToken, mintTasksInvokerToken, mintUserToken, testVerifier } from '../../src/testing/tokens.js';
import {
  QUEUE_CONTROL_PREFIX,
  QUEUE_CONTROL_ROLES,
  TaskTenantMismatchError,
  callQueueControl,
  reconcileRecurringQueues,
  registerQueueControl,
  registerTaskRoute,
  type ReconcileResult,
} from '../../src/tasks/handlers.js';
import {
  CLOUD_TASKS_HEADERS,
  InvalidTaskNameError,
  MAX_TASK_PAGE_SIZE,
  TASK_NAME_PATTERN,
  TaskPortConfigError,
  assertCreateInput,
  assertTaskName,
  createTaskPort,
  parseTaskWireBody,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskPortOptions,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskContext,
  type TaskEnv,
  type TaskInfo,
  type TaskPage,
  type TaskPort,
} from '../../src/tasks/port.js';
import { MAX_SLOT_PROBES, recurringHandler, recurringSpec, slotName } from '../../src/tasks/recurring.js';
import {
  DEFAULT_RETRY,
  QUEUES,
  RECURRING_RETRY,
  SITEMONITOR_DEADLINE_S,
  SITEMONITOR_INTERVAL_S,
  SITEMONITOR_QUEUE,
  UnknownQueueError,
  UnknownTaskTargetError,
  isQueueName,
  outboxSweepQueue,
  queueDefinition,
  queueTopology,
  queuesCreatedBy,
  recurringQueues,
  retryDelayS,
  targetUrl,
  type QueueTopologyEntry,
  type RetryPolicy,
} from '../../src/tasks/queues.js';

const SURVEY_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const SERVICE_URLS: Readonly<Record<string, string>> = {
  surveys: 'http://127.0.0.1:8117',
  people: 'http://127.0.0.1:8112/',
  reporting: 'https://reporting-abc.a.run.app//',
};

const ONE_OFF_RETRY: RetryPolicy = { maxAttempts: 100, minBackoffS: 1, maxBackoffS: 300, maxDoublings: 5 };

const CHAIN_RETRY: RetryPolicy = { maxAttempts: 5, minBackoffS: 1, maxBackoffS: 60, maxDoublings: 4 };

function sweep(service: string): QueueTopologyEntry {
  return {
    name: `${service}-outbox-sweep`,
    targetService: service,
    targetPath: '/internal/v1/outbox/sweep',
    creators: [service],
    intervalS: 60,
    deadlineS: 60,
    retry: CHAIN_RETRY,
  };
}

const CLOUD_TOPOLOGY: readonly QueueTopologyEntry[] = [
  {
    name: 'surveys-launch',
    targetService: 'surveys',
    targetPath: '/internal/v1/tasks/surveys/{surveyId}/launch',
    creators: ['communications'],
    deadlineS: 60,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'communications-reminders',
    targetService: 'communications',
    targetPath: '/internal/v1/tasks/reminders/{scheduledTaskId}',
    creators: ['communications'],
    deadlineS: 60,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'content-scheduled-publish',
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/publish-scheduled-changesets',
    creators: ['programs-sites', 'strategies-content'],
    deadlineS: 300,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'content-feed-import',
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/feed-auto-import',
    creators: ['programs-sites'],
    deadlineS: 600,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'reporting-export-run',
    targetService: 'reporting',
    targetPath: '/internal/v1/tasks/exports/{exportId}/run',
    creators: ['reporting'],
    deadlineS: 1800,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'programs-sites-sitemonitor',
    targetService: 'programs-sites',
    targetPath: '/internal/v1/jobs/sitemonitor',
    creators: ['programs-sites'],
    intervalS: 900,
    deadlineS: 600,
    retry: CHAIN_RETRY,
  },
  sweep('identity'),
  sweep('people'),
  sweep('programs-sites'),
  sweep('surveys'),
  sweep('communications'),
];

const DEPLOYED_SWEEPS = [
  'identity-outbox-sweep',
  'people-outbox-sweep',
  'programs-sites-outbox-sweep',
  'surveys-outbox-sweep',
  'communications-outbox-sweep',
];

/** Returns what `fn` throws, failing the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('retry policies', () => {
  it.each([
    ['one-off tasks', DEFAULT_RETRY, ONE_OFF_RETRY],
    ['recurring chains', RECURRING_RETRY, CHAIN_RETRY],
  ])('fixes and freezes the retry policy of %s', (_label, policy, expected) => {
    expect(policy).toStrictEqual(expected);
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe('outboxSweepQueue', () => {
  it.each(['identity', 'people', 'programs-sites', 'stub'])('names the sweep queue of %s', (service) => {
    expect(outboxSweepQueue(service)).toBe(`${service}-outbox-sweep`);
  });
});

describe('QUEUES', () => {
  it('runs the site monitor every 900 s with a 600 s deadline', () => {
    expect([SITEMONITOR_QUEUE, SITEMONITOR_INTERVAL_S, SITEMONITOR_DEADLINE_S]).toStrictEqual([
      'programs-sites-sitemonitor',
      900,
      600,
    ]);
    expect(QUEUES[SITEMONITOR_QUEUE].recurring).toStrictEqual({ intervalS: 900 });
    expect(QUEUES[SITEMONITOR_QUEUE].deadlineS).toBe(600);
  });

  it('keys every definition by its own name', () => {
    for (const [key, def] of Object.entries(QUEUES)) expect(def.name).toBe(key);
  });

  it('marks only the stub sweep local-only', () => {
    const localOnly = Object.values(QUEUES).filter((def) => def.localOnly === true);
    expect(localOnly.map((def) => def.name)).toStrictEqual(['stub-outbox-sweep']);
  });

  it('freezes the registry, its definitions, creators and cadence', () => {
    expect(Object.isFrozen(QUEUES)).toBe(true);
    for (const def of Object.values(QUEUES)) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.creators)).toBe(true);
      expect(Object.isFrozen(def.retry)).toBe(true);
      if (def.recurring) expect(Object.isFrozen(def.recurring)).toBe(true);
    }
  });

  it('keeps every dispatch deadline within the 15–1800 s HTTP-target range', () => {
    for (const def of Object.values(QUEUES)) {
      expect(def.deadlineS).toBeGreaterThanOrEqual(15);
      expect(def.deadlineS).toBeLessThanOrEqual(1800);
    }
  });

  it('targets only routes on the cloud-tasks transport', () => {
    for (const def of Object.values(QUEUES)) {
      expect(transportForPath(def.targetPath)).toBe('cloud-tasks');
    }
  });

  it('uses the recurring retry policy exactly on recurring queues', () => {
    for (const def of Object.values(QUEUES)) {
      expect(def.retry).toBe(def.recurring ? RECURRING_RETRY : DEFAULT_RETRY);
    }
  });
});

describe('isQueueName', () => {
  it.each(['surveys-launch', 'programs-sites-sitemonitor', 'communications-outbox-sweep', 'stub-outbox-sweep'])(
    'accepts %s',
    (name) => {
      expect(isQueueName(name)).toBe(true);
    },
  );

  it.each(['', 'SURVEYS-LAUNCH', ' surveys-launch', 'finance-outbox-sweep', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects %j',
    (name) => {
      expect(isQueueName(name)).toBe(false);
    },
  );
});

describe('queueDefinition', () => {
  it('returns the registry entry', () => {
    expect(queueDefinition('surveys-launch')).toBe(QUEUES['surveys-launch']);
    expect(queueDefinition('surveys-launch').targetPath).toBe('/internal/v1/tasks/surveys/{surveyId}/launch');
  });

  it.each(['unknown-queue', 'toString', ''])('throws UnknownQueueError for %j', (name) => {
    const error = thrownBy(() => queueDefinition(name));
    expect(error).toBeInstanceOf(UnknownQueueError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'UnknownQueueError', queue: name, message: `Unknown task queue: ${name}` });
  });
});

describe('recurringQueues', () => {
  it.each([
    { label: 'by default', opts: undefined, expected: DEPLOYED_SWEEPS },
    { label: 'with local-only queues', opts: { includeLocalOnly: true }, expected: [...DEPLOYED_SWEEPS, 'stub-outbox-sweep'] },
    { label: 'with the site monitor', opts: { withSiteMonitor: true }, expected: [SITEMONITOR_QUEUE, ...DEPLOYED_SWEEPS] },
    {
      label: 'with both',
      opts: { includeLocalOnly: true, withSiteMonitor: true },
      expected: [SITEMONITOR_QUEUE, ...DEPLOYED_SWEEPS, 'stub-outbox-sweep'],
    },
    {
      label: 'with both options false',
      opts: { includeLocalOnly: false, withSiteMonitor: false },
      expected: DEPLOYED_SWEEPS,
    },
  ])('lists recurring queues in registry order $label', ({ opts, expected }) => {
    expect(recurringQueues(opts).map((def) => def.name)).toStrictEqual(expected);
  });
});

describe('queuesCreatedBy', () => {
  it.each([
    ['communications', ['surveys-launch', 'communications-reminders', 'communications-outbox-sweep']],
    [
      'programs-sites',
      ['content-scheduled-publish', 'content-feed-import', 'programs-sites-sitemonitor', 'programs-sites-outbox-sweep'],
    ],
    ['strategies-content', ['content-scheduled-publish']],
    ['reporting', ['reporting-export-run']],
    ['surveys', ['surveys-outbox-sweep']],
    ['identity', ['identity-outbox-sweep']],
    ['people', ['people-outbox-sweep']],
    ['stub', ['stub-outbox-sweep']],
    ['finance', []],
    ['', []],
  ])('lists the queues %j creates tasks on', (service, expected) => {
    expect(queuesCreatedBy(service).map((def) => def.name)).toStrictEqual(expected);
  });
});

describe('targetUrl', () => {
  it.each([
    [
      'fills the survey launch path parameter',
      'surveys-launch',
      { surveyId: SURVEY_ID },
      `http://127.0.0.1:8117/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
    ],
    [
      'URI-encodes parameter values',
      'surveys-launch',
      { surveyId: 'a/b c?d#é' },
      'http://127.0.0.1:8117/internal/v1/tasks/surveys/a%2Fb%20c%3Fd%23%C3%A9/launch',
    ],
    [
      'strips one trailing slash from the base URL',
      'people-outbox-sweep',
      {},
      'http://127.0.0.1:8112/internal/v1/outbox/sweep',
    ],
    [
      'strips repeated trailing slashes from the base URL',
      'reporting-export-run',
      { exportId: 'E1' },
      'https://reporting-abc.a.run.app/internal/v1/tasks/exports/E1/run',
    ],
    [
      'ignores parameters the route does not name',
      'people-outbox-sweep',
      { surveyId: SURVEY_ID },
      'http://127.0.0.1:8112/internal/v1/outbox/sweep',
    ],
  ])('%s', (_label, queue, params, expected) => {
    expect(targetUrl(queueDefinition(queue), SERVICE_URLS, params)).toBe(expected);
  });

  it.each([
    ['absent', {}],
    ['empty', { surveys: '' }],
  ])('throws UnknownTaskTargetError when the target base URL is %s', (_label, serviceUrls) => {
    const error = thrownBy(() => targetUrl(QUEUES['surveys-launch'], serviceUrls, { surveyId: SURVEY_ID }));
    expect(error).toBeInstanceOf(UnknownTaskTargetError);
    expect(error).toMatchObject({
      name: 'UnknownTaskTargetError',
      service: 'surveys',
      message: 'OPT2_SERVICE_URLS has no URL for task target: surveys',
    });
  });

  it('throws TypeError for a missing path parameter', () => {
    const error = thrownBy(() => targetUrl(QUEUES['surveys-launch'], SERVICE_URLS));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: 'Missing path parameter "surveyId" for queue surveys-launch' });
  });
});

describe('retryDelayS', () => {
  it.each([
    [-3, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 32],
    [7, 64],
    [8, 96],
    [14, 288],
    [15, 300],
    [20, 300],
    [100, 300],
  ])('after one-off attempt %i waits %i s', (attempt, delay) => {
    expect(retryDelayS(DEFAULT_RETRY, attempt)).toBe(delay);
  });

  it.each([
    [
      'the Cloud Tasks documentation example',
      { maxAttempts: -1, minBackoffS: 10, maxBackoffS: 300, maxDoublings: 3 },
      [10, 20, 40, 80, 160, 240, 300, 300],
    ],
    ['recurring chains', RECURRING_RETRY, [1, 2, 4, 8, 16, 32, 48, 60, 60]],
    ['no doublings', { maxAttempts: 10, minBackoffS: 5, maxBackoffS: 20, maxDoublings: 0 }, [5, 10, 15, 20, 20]],
  ] as const)('follows the backoff sequence of %s', (_label, policy, expected) => {
    expect(Array.from({ length: expected.length }, (_, i) => retryDelayS(policy, i + 1))).toStrictEqual(expected);
  });
});

describe('queueTopology', () => {
  it.each([
    ['cloud', 'omits the local-only stub sweep', CLOUD_TOPOLOGY],
    ['local', 'ends with the local-only stub sweep', [...CLOUD_TOPOLOGY, sweep('stub')]],
  ] as const)('lists the %s queues in registry order and %s', (target, _label, expected) => {
    expect(queueTopology({ target })).toStrictEqual(expected);
  });

  it('sets intervalS only on recurring queues', () => {
    for (const entry of queueTopology({ target: 'local' })) {
      expect(Object.hasOwn(entry, 'intervalS')).toBe(queueDefinition(entry.name).recurring !== undefined);
    }
  });

  it('round-trips through JSON unchanged', () => {
    const topology = queueTopology({ target: 'local' });
    expect(JSON.parse(JSON.stringify(topology))).toStrictEqual(topology);
  });

  it('returns copies that leave the registry unchanged when mutated', () => {
    for (const entry of queueTopology({ target: 'cloud' })) {
      entry.creators.push('finance');
      entry.retry.maxAttempts = 0;
    }
    expect(queueTopology({ target: 'cloud' })).toStrictEqual(CLOUD_TOPOLOGY);
    expect(DEFAULT_RETRY.maxAttempts).toBe(100);
    expect(RECURRING_RETRY.maxAttempts).toBe(5);
  });
});

describe('parseTaskWireBody', () => {
  const tenantInput: CreateTaskInput = {
    queue: 'surveys-launch',
    name: 'surveys-launch-A1B2',
    scheduleTime: new Date('2026-06-30T12:00:00Z'),
    url: `http://127.0.0.1:8117/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
    deadlineS: 60,
    body: { surveyId: SURVEY_ID },
    tenantId: TENANT_A.tenantId,
  };
  const { tenantId: _tenantId, body: _body, ...systemInput } = tenantInput;

  it.each([
    [
      'a tenant task',
      tenantInput,
      { queue: 'surveys-launch', name: 'surveys-launch-A1B2', tenantId: TENANT_A.tenantId, payload: { surveyId: SURVEY_ID } },
    ],
    ['a system task without a body', systemInput, { queue: 'surveys-launch', name: 'surveys-launch-A1B2', tenantId: null, payload: null }],
  ])('reads back the wire body the adapters send for %s', (_label, input, expected) => {
    const sent = taskWireBody(input);
    expect(sent).toStrictEqual(expected);
    expect(parseTaskWireBody(JSON.parse(JSON.stringify(sent)))).toStrictEqual(expected);
  });

  it.each([
    ['null', null],
    ['an array', [SURVEY_ID]],
    ['a body without a queue', { name: 'surveys-launch-A1B2', tenantId: null, payload: null }],
    ['a numeric task name', { queue: 'surveys-launch', name: 42, tenantId: null, payload: null }],
    ['a numeric tenantId', { queue: 'surveys-launch', name: 'surveys-launch-A1B2', tenantId: 1, payload: null }],
  ])('throws a ZodError for %s', (_label, raw) => {
    expect(() => parseTaskWireBody(raw)).toThrow(z.ZodError);
  });
});

describe('assertTaskName', () => {
  it.each([
    ['a single character', 'a'],
    ['every allowed character class', 'Az09_-'],
    ['500 characters', 'x'.repeat(500)],
  ])('accepts %s', (_label, name) => {
    expect(TASK_NAME_PATTERN.test(name)).toBe(true);
    expect(() => assertTaskName(name)).not.toThrow();
  });

  it.each([
    ['an empty name', ''],
    ['501 characters', 'x'.repeat(501)],
    ['a space', 'surveys launch'],
    ['a slash', 'surveys-launch/A1B2'],
    ['a dot', 'surveys.launch'],
    ['a non-ASCII letter', 'surveys-lünch'],
    ['a trailing newline', 'surveys-launch\n'],
  ])('throws InvalidTaskNameError for %s', (_label, name) => {
    expect(TASK_NAME_PATTERN.test(name)).toBe(false);
    const error = thrownBy(() => assertTaskName(name));
    expect(error).toBeInstanceOf(InvalidTaskNameError);
    expect(error).toMatchObject({
      name: 'InvalidTaskNameError',
      taskName: name,
      message: `Invalid task name ${JSON.stringify(name)}: expected 1-500 characters from A-Z, a-z, 0-9, _ and -`,
    });
  });

  it('accepts the slot task name of every recurring queue', () => {
    for (const def of recurringQueues({ includeLocalOnly: true, withSiteMonitor: true })) {
      expect(() => assertTaskName(slotName(def.name, 1_782_820_800))).not.toThrow();
    }
  });
});

const TASK_CLOCK = fixedClock('2026-06-30T12:07:30Z');
const SWEEP_SLOT_S = 1_782_821_220;

const TASK_SERVICE_URLS: Readonly<Record<string, string>> = {
  identity: 'http://127.0.0.1:8111',
  people: 'http://127.0.0.1:8112',
  'programs-sites': 'http://127.0.0.1:8113',
  communications: 'http://127.0.0.1:8115',
  surveys: 'http://127.0.0.1:8117',
  stub: 'http://127.0.0.1:8199',
};

const SWEEP_PATH = '/internal/v1/outbox/sweep';
const LAUNCH_ROUTE = '/internal/v1/tasks/surveys/:surveyId/launch';
const LAUNCH_PATH = `/internal/v1/tasks/surveys/${SURVEY_ID}/launch`;

const SWEEP_BODY = taskWireBody({
  queue: 'people-outbox-sweep',
  name: 'people-outbox-sweep-1782821220',
  scheduleTime: new Date(SWEEP_SLOT_S * 1000),
  url: 'http://127.0.0.1:8112/internal/v1/outbox/sweep',
  deadlineS: 60,
  body: { slotStartS: SWEEP_SLOT_S },
});

const INVALID_PARAMETERS = { message: 'Invalid parameters', code: 'invalid_request' };
const BAD_REQUEST = { message: 'Bad Request', code: 'invalid_request' };

/** Wire body of the survey launch task, as the communications consumer creates it. */
function launchBody(tenantId: string | null): unknown {
  return { queue: 'surveys-launch', name: 'surveys-launch-A1B2', tenantId, payload: { surveyId: SURVEY_ID } };
}

/** In-memory task port with Cloud Tasks name semantics: a live or tombstoned name answers `created: false`. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local';
  readonly live = new Map<string, CreateTaskInput>();
  readonly tombstones = new Set<string>();
  readonly paused = new Set<string>();
  createFailure: Error | undefined;
  listFailure: Error | undefined;

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (this.createFailure) throw this.createFailure;
    assertCreateInput(input);
    const key = `${input.queue}/${input.name}`;
    const created = !this.live.has(key) && !this.tombstones.has(key);
    if (created) this.live.set(key, input);
    return { name: input.name, created };
  }

  async delete(queue: string, name: string): Promise<DeleteTaskResult> {
    return { name, deleted: this.live.delete(`${queue}/${name}`) };
  }

  /** The whole queue as one page. */
  async list(queue: string): Promise<TaskPage> {
    if (this.listFailure) throw this.listFailure;
    return {
      tasks: [...this.live.values()]
        .filter((task) => task.queue === queue)
        .map((task) => ({ queue, name: task.name, scheduleTime: task.scheduleTime, status: 'pending' as const, attempts: 0 })),
    };
  }

  async get(queue: string, name: string): Promise<TaskInfo | undefined> {
    const task = this.live.get(`${queue}/${name}`);
    return task && { queue, name, scheduleTime: task.scheduleTime, status: 'pending', attempts: 0 };
  }

  async pauseQueue(queue: string): Promise<void> {
    this.paused.add(queue);
  }

  async resumeQueue(queue: string): Promise<void> {
    this.paused.delete(queue);
  }

  async queueState(queue: string): Promise<QueueState> {
    return { queue, paused: this.paused.has(queue) };
  }

  /** Holds no dispatcher or client, so nothing is released. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface StoredSurvey {
  tenantId: string;
  surveyId: string;
}

const STORED_SURVEYS: readonly StoredSurvey[] = [{ tenantId: TENANT_A.tenantId, surveyId: SURVEY_ID }];

/** The stored survey the payload names, visible only under the tenant that stores it. */
async function findSurvey(tx: TenantTx, payload: unknown): Promise<StoredSurvey | null> {
  const surveyId = (payload as { surveyId?: unknown } | null)?.surveyId;
  return STORED_SURVEYS.find((row) => row.tenantId === tx.tenantId && row.surveyId === surveyId) ?? null;
}

/** TenantDb fake recording the tenant of every transaction it opens; it runs no SQL. */
function memoryTenantDb(): TenantDb & { readonly tenants: string[] } {
  const tenants: string[] = [];
  return {
    schema: 'surveys',
    tenants,
    withTenant: async (tenantId, fn) => {
      tenants.push(tenantId);
      return fn({
        kind: 'tenant',
        tenantId,
        schema: 'surveys',
        query: () => Promise.reject(new Error('task route tests run no SQL')),
        onCommit: () => undefined,
      });
    },
    withMetadata: () => Promise.reject(new Error('task routes open no metadata transaction')),
    end: async () => undefined,
  };
}

const apps: FastifyInstance[] = [];

/** A createService app for `service` with the test signer's auth, the fixed clock and a silent logger. */
async function taskServiceApp(service: string): Promise<FastifyInstance> {
  const app = await createService({
    name: service,
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '26412',
      OPT2_SERVICE_NAME: service,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-tasks-unit-unused'),
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier(service),
    clock: TASK_CLOCK,
    logger: createLogger({ service, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

async function closeApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
}

/** POSTs a task as the local tasks adapter does: a `tasks-invoker` token addressed to the app's service. */
async function postTask(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  const token = await mintTasksInvokerToken({ audience: app.opt2.name });
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as object });
}

/** The `error` member of a legacy error envelope. */
function errorOf(response: { json: () => unknown }): unknown {
  return (response.json() as { error?: unknown }).error;
}

describe('TaskTenantMismatchError', () => {
  it('is the legacy badRequest naming the tenant and the task', () => {
    const error = new TaskTenantMismatchError(TENANT_B.tenantId, 'surveys-launch-A1B2');
    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({
      name: 'TaskTenantMismatchError',
      type: 'badRequest',
      message: 'badRequest: Bad Request',
      tenantId: TENANT_B.tenantId,
      taskName: 'surveys-launch-A1B2',
    });
  });
});

describe('registerTaskRoute', () => {
  afterEach(closeApps);

  it.each([
    '/internal/v1/task-queues/surveys-launch/pause',
    '/internal/v1/events/people-person-archived',
    '/internal/v1/outbox/sweep/now',
    '/tasks/feed',
  ])('refuses %s, which is outside the managed task families', async (route) => {
    const app = await taskServiceApp('people');
    const error = thrownBy(() => registerTaskRoute(app, route, { scope: 'system', handler: vi.fn() }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: `Task route ${route} must be under /internal/v1/tasks/ or /internal/v1/jobs/, or be /internal/v1/outbox/sweep`,
    });
  });

  it('declares the cloud-tasks transport and the tasks-invoker role', async () => {
    const app = await taskServiceApp('people');
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler: vi.fn() });
    await app.ready();
    expect(collectRouteMatrix(app).routes.filter((route) => route.url === SWEEP_PATH)).toStrictEqual([
      { method: 'POST', url: SWEEP_PATH, transport: 'cloud-tasks', requires: ['service:tasks-invoker'], siteCheck: true },
    ]);
  });

  it.each([
    ['no credential', async (): Promise<Record<string, string>> => ({})],
    [
      'a tasks-invoker token addressed to another service',
      async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'surveys' })}` }),
    ],
    [
      'a user token',
      async () => ({ authorization: `Bearer ${await mintUserToken({ sub: 'task-user', site: TENANT_A.siteId, roles: ['s2'] })}` }),
    ],
    [
      'a service invocation credential',
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: 'people' })}` }),
    ],
  ])('answers 401 to %s and never runs the handler', async (_label, headersOf) => {
    const app = await taskServiceApp('people');
    const handler = vi.fn();
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler });
    const response = await app.inject({ method: 'POST', url: SWEEP_PATH, headers: await headersOf(), payload: SWEEP_BODY });
    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs a system task with its Cloud Tasks headers and answers { ok: true }', async () => {
    const app = await taskServiceApp('people');
    const seen: TaskContext[] = [];
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler: async (ctx) => void seen.push(ctx) });
    const response = await postTask(app, SWEEP_PATH, SWEEP_BODY, {
      [CLOUD_TASKS_HEADERS.taskName]: 'people-outbox-sweep-1782821220',
      [CLOUD_TASKS_HEADERS.queueName]: 'people-outbox-sweep',
      [CLOUD_TASKS_HEADERS.retryCount]: '2',
      [CLOUD_TASKS_HEADERS.executionCount]: '1',
      [CLOUD_TASKS_HEADERS.eta]: '1782821220.5',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      queue: 'people-outbox-sweep',
      taskName: 'people-outbox-sweep-1782821220',
      retryCount: 2,
      executionCount: 1,
      eta: new Date(1_782_821_220_500),
      tenantId: null,
      payload: { slotStartS: SWEEP_SLOT_S },
    });
    expect(seen[0]?.stored).toBeUndefined();
    expect(seen[0]?.request.url).toBe(SWEEP_PATH);
  });

  it.each([
    [
      'the headers over the wire body',
      SWEEP_BODY,
      {
        [CLOUD_TASKS_HEADERS.taskName]: 'people-outbox-sweep-1782821280',
        [CLOUD_TASKS_HEADERS.queueName]: 'people-outbox-sweep-renamed',
        [CLOUD_TASKS_HEADERS.retryCount]: '4',
        [CLOUD_TASKS_HEADERS.executionCount]: '3',
        [CLOUD_TASKS_HEADERS.eta]: '1782821280',
      },
      {
        taskName: 'people-outbox-sweep-1782821280',
        queue: 'people-outbox-sweep-renamed',
        retryCount: 4,
        executionCount: 3,
        eta: new Date(1_782_821_280_000),
        payload: { slotStartS: SWEEP_SLOT_S },
      },
    ],
    [
      'the wire body, zero counts and no ETA without headers, and a null payload when the body has none',
      { queue: 'people-outbox-sweep', name: 'people-outbox-sweep-1782821220', tenantId: null },
      {},
      {
        taskName: 'people-outbox-sweep-1782821220',
        queue: 'people-outbox-sweep',
        retryCount: 0,
        executionCount: 0,
        eta: undefined,
        payload: null,
      },
    ],
    [
      'the wire body, zero counts and no ETA for empty headers',
      SWEEP_BODY,
      {
        [CLOUD_TASKS_HEADERS.taskName]: '',
        [CLOUD_TASKS_HEADERS.queueName]: '',
        [CLOUD_TASKS_HEADERS.retryCount]: '',
        [CLOUD_TASKS_HEADERS.executionCount]: '',
        [CLOUD_TASKS_HEADERS.eta]: '',
      },
      {
        taskName: 'people-outbox-sweep-1782821220',
        queue: 'people-outbox-sweep',
        retryCount: 0,
        executionCount: 0,
        eta: undefined,
        payload: { slotStartS: SWEEP_SLOT_S },
      },
    ],
    [
      'zero counts and no ETA for non-numeric headers',
      SWEEP_BODY,
      {
        [CLOUD_TASKS_HEADERS.retryCount]: 'x',
        [CLOUD_TASKS_HEADERS.executionCount]: 'many',
        [CLOUD_TASKS_HEADERS.eta]: 'soon',
      },
      {
        taskName: 'people-outbox-sweep-1782821220',
        queue: 'people-outbox-sweep',
        retryCount: 0,
        executionCount: 0,
        eta: undefined,
        payload: { slotStartS: SWEEP_SLOT_S },
      },
    ],
  ])('takes %s', async (_label, body, headers, expected) => {
    const app = await taskServiceApp('people');
    const seen: TaskContext[] = [];
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler: async (ctx) => void seen.push(ctx) });
    const response = await postTask(app, SWEEP_PATH, body, headers);
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    const { taskName, queue, retryCount, executionCount, eta, payload } = seen[0]!;
    expect({ taskName, queue, retryCount, executionCount, eta, payload }).toStrictEqual(expected);
  });

  it.each([
    ['the handler result as the 200 JSON body', async () => ({ swept: 3 }), 200, { swept: 3 }],
    [
      'the reply the handler sent itself',
      async (ctx: TaskContext) => {
        void ctx.reply.code(202).send({ accepted: true });
        return { ignored: true };
      },
      202,
      { accepted: true },
    ],
  ])('answers with %s', async (_label, handler, status, body) => {
    const app = await taskServiceApp('people');
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler });
    const response = await postTask(app, SWEEP_PATH, SWEEP_BODY);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toStrictEqual(body);
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body without tenantId', { queue: 'people-outbox-sweep', name: 'people-outbox-sweep-1782821220', payload: null }],
    ['an empty queue', { ...SWEEP_BODY, queue: '' }],
    ['an empty task name', { ...SWEEP_BODY, name: '' }],
    ['a tenantId that is not a UUID', { ...SWEEP_BODY, tenantId: TENANT_A.siteId }],
  ])('answers 400 invalidParameters to %s', async (_label, payload) => {
    const app = await taskServiceApp('people');
    const handler = vi.fn();
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler });
    const response = await postTask(app, SWEEP_PATH, payload, { 'content-type': 'application/json' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toStrictEqual(INVALID_PARAMETERS);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 400 badRequest to a system task whose body names a tenant', async () => {
    const app = await taskServiceApp('people');
    const handler = vi.fn();
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler });
    const response = await postTask(app, SWEEP_PATH, { ...SWEEP_BODY, tenantId: TENANT_A.tenantId });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toStrictEqual(BAD_REQUEST);
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-checks a tenant task against its stored row and runs it under that tenant', async () => {
    const app = await taskServiceApp('surveys');
    const db = memoryTenantDb();
    const findStored = vi.fn(findSurvey);
    const seen: Array<{ ctx: TaskContext<StoredSurvey>; contextTenant: string | undefined }> = [];
    registerTaskRoute<StoredSurvey>(app, LAUNCH_ROUTE, {
      scope: 'tenant',
      db,
      findStored,
      handler: async (ctx) => {
        seen.push({ ctx, contextTenant: currentRequestContext()?.tenantId });
        return { launched: ctx.stored?.surveyId };
      },
    });
    const response = await postTask(app, LAUNCH_PATH, launchBody(TENANT_A.tenantId.toUpperCase()), {
      [CLOUD_TASKS_HEADERS.taskName]: 'surveys-launch-A1B2',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ launched: SURVEY_ID });
    expect(db.tenants).toStrictEqual([TENANT_A.tenantId]);
    expect(findStored).toHaveBeenCalledOnce();
    expect(findStored).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tenant', tenantId: TENANT_A.tenantId }),
      { surveyId: SURVEY_ID },
      { taskName: 'surveys-launch-A1B2', queue: 'surveys-launch' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ctx.tenantId).toBe(TENANT_A.tenantId);
    expect(seen[0]?.ctx.stored).toBe(STORED_SURVEYS[0]);
    expect(seen[0]?.contextTenant).toBe(TENANT_A.tenantId);
  });

  it.each([
    ['names no tenant', null, []],
    ['names a tenant that cannot see the stored row', TENANT_B.tenantId, [TENANT_B.tenantId]],
  ])('answers 400 badRequest to a tenant task whose body %s', async (_label, tenantId, tenants) => {
    const app = await taskServiceApp('surveys');
    const db = memoryTenantDb();
    const handler = vi.fn();
    registerTaskRoute<StoredSurvey>(app, LAUNCH_ROUTE, { scope: 'tenant', db, findStored: findSurvey, handler });
    const response = await postTask(app, LAUNCH_PATH, launchBody(tenantId));
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toStrictEqual(BAD_REQUEST);
    expect(db.tenants).toStrictEqual(tenants);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('recurring chain task routes', () => {
  afterEach(closeApps);

  const SUCCESSOR_KEY = 'people-outbox-sweep/people-outbox-sweep-1782821280';

  async function sweepApp(port: MemoryTaskPort, work: () => Promise<unknown>): Promise<FastifyInstance> {
    const app = await taskServiceApp('people');
    const spec = recurringSpec('people-outbox-sweep', { ...TASK_SERVICE_URLS });
    registerTaskRoute(app, SWEEP_PATH, { scope: 'system', handler: recurringHandler({ ...spec, port, clock: TASK_CLOCK }, work) });
    return app;
  }

  it('creates the next slot task before the work runs and only then answers 200', async () => {
    const port = new MemoryTaskPort();
    const successorLiveDuringWork: boolean[] = [];
    const app = await sweepApp(port, async () => void successorLiveDuringWork.push(port.live.has(SUCCESSOR_KEY)));
    const response = await postTask(app, SWEEP_PATH, SWEEP_BODY, {
      [CLOUD_TASKS_HEADERS.taskName]: 'people-outbox-sweep-1782821220',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ ok: true, successor: 'people-outbox-sweep-1782821280' });
    expect(successorLiveDuringWork).toStrictEqual([true]);
    expect(port.live.get(SUCCESSOR_KEY)).toStrictEqual({
      queue: 'people-outbox-sweep',
      name: 'people-outbox-sweep-1782821280',
      scheduleTime: new Date(1_782_821_280_000),
      url: 'http://127.0.0.1:8112/internal/v1/outbox/sweep',
      deadlineS: 60,
      body: { slotStartS: 1_782_821_280 },
    });
  });

  it('answers 503 without running the work when the successor cannot be created', async () => {
    const port = new MemoryTaskPort();
    port.createFailure = new Error('queue unavailable');
    const work = vi.fn(async () => undefined);
    const app = await sweepApp(port, work);
    const response = await postTask(app, SWEEP_PATH, SWEEP_BODY, {
      [CLOUD_TASKS_HEADERS.taskName]: 'people-outbox-sweep-1782821220',
    });
    expect(response.statusCode).toBe(503);
    expect(errorOf(response)).toMatchObject({ code: 'server_error' });
    expect(work).not.toHaveBeenCalled();
    expect(port.live.size).toBe(0);
  });
});

describe('registerQueueControl', () => {
  afterEach(closeApps);

  async function controlApp(service: string): Promise<{ app: FastifyInstance; port: MemoryTaskPort }> {
    const app = await taskServiceApp(service);
    const port = new MemoryTaskPort();
    registerQueueControl(app, { port, service, serviceUrls: { ...TASK_SERVICE_URLS }, clock: TASK_CLOCK });
    return { app, port };
  }

  /** POSTs a queue-control op with `caller`'s invocation credential, or none when `caller` is null. */
  async function postControl(app: FastifyInstance, queue: string, op: string, caller: string | null = 'migration') {
    const headers =
      caller === null
        ? {}
        : { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: app.opt2.name })}` };
    return app.inject({ method: 'POST', url: `${QUEUE_CONTROL_PREFIX}/${queue}/${op}`, headers, payload: {} });
  }

  it('declares pause, resume and ensure on the service transport for migration and the operator', async () => {
    const { app } = await controlApp('communications');
    expect(QUEUE_CONTROL_PREFIX).toBe('/internal/v1/task-queues');
    expect(QUEUE_CONTROL_ROLES).toStrictEqual(['platform.migration', 'platform.operator']);
    expect(recordedRoutes(app).filter((route) => route.url.startsWith(QUEUE_CONTROL_PREFIX))).toStrictEqual(
      ['pause', 'resume', 'ensure'].map((op) => ({
        method: 'POST',
        url: `/internal/v1/task-queues/:queue/${op}`,
        config: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
      })),
    );
  });

  it.each(['migration', 'operator'])('pauses and resumes a queue the service creates for %s', async (caller) => {
    const { app, port } = await controlApp('communications');
    const paused = await postControl(app, 'surveys-launch', 'pause', caller);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toStrictEqual({ queue: 'surveys-launch', service: 'communications', paused: true, running: 0 });
    expect([...port.paused]).toStrictEqual(['surveys-launch']);

    const resumed = await postControl(app, 'surveys-launch', 'resume', caller);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toStrictEqual({ queue: 'surveys-launch', service: 'communications', paused: false });
    expect(port.paused.size).toBe(0);
  });

  it('answers pause with the running tasks of every page of the queue', async () => {
    const { app, port } = await controlApp('communications');
    const task = (name: string, status: TaskInfo['status']): TaskInfo => ({
      queue: 'surveys-launch',
      name,
      scheduleTime: new Date(SWEEP_SLOT_S * 1000),
      status,
      attempts: 1,
    });
    const list = vi
      .spyOn(port, 'list')
      .mockResolvedValueOnce({ tasks: [task('launch-a', 'running'), task('launch-b', 'pending')], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ tasks: [task('launch-c', 'running')] });

    const paused = await postControl(app, 'surveys-launch', 'pause');

    expect(paused.json()).toStrictEqual({ queue: 'surveys-launch', service: 'communications', paused: true, running: 2 });
    expect(list.mock.calls).toStrictEqual([
      ['surveys-launch', { pageSize: MAX_TASK_PAGE_SIZE }],
      ['surveys-launch', { pageSize: MAX_TASK_PAGE_SIZE, pageToken: 'page-2' }],
    ]);
  });

  it.each([
    ['no credential', 401, null],
    ['the gateway', 403, 'gateway'],
    ['a creating service', 403, 'communications'],
  ])('answers %s with %i and leaves the queue running', async (_label, status, caller) => {
    const { app, port } = await controlApp('communications');
    const response = await postControl(app, 'surveys-launch', 'pause', caller);
    expect(response.statusCode).toBe(status);
    expect(port.paused.size).toBe(0);
  });

  it.each([
    ['pause', 'an unknown queue', 'unknown-queue'],
    ['resume', 'a queue another service creates', 'people-outbox-sweep'],
    ['pause', 'a prototype key', 'toString'],
    ['ensure', 'a queue that is not recurring', 'surveys-launch'],
    ['ensure', 'a chain another service creates', 'people-outbox-sweep'],
  ])('answers 400 invalidParameters to %s of %s', async (op, _label, queue) => {
    const { app, port } = await controlApp('communications');
    const response = await postControl(app, queue, op);
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toStrictEqual(INVALID_PARAMETERS);
    expect(port.paused.size).toBe(0);
    expect(port.live.size).toBe(0);
  });

  it('ensures the current slot task of an own chain once, then reports it live', async () => {
    const { app, port } = await controlApp('communications');
    const first = await postControl(app, 'communications-outbox-sweep', 'ensure');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toStrictEqual({
      queue: 'communications-outbox-sweep',
      service: 'communications',
      ensured: {
        queue: 'communications-outbox-sweep',
        name: 'communications-outbox-sweep-1782821220',
        created: true,
        reason: 'created-current',
      },
    });
    expect([...port.live.values()]).toStrictEqual([
      {
        queue: 'communications-outbox-sweep',
        name: 'communications-outbox-sweep-1782821220',
        scheduleTime: new Date(SWEEP_SLOT_S * 1000),
        url: 'http://127.0.0.1:8115/internal/v1/outbox/sweep',
        deadlineS: 60,
        body: { slotStartS: SWEEP_SLOT_S },
      },
    ]);

    const second = await postControl(app, 'communications-outbox-sweep', 'ensure', 'operator');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      ensured: { name: 'communications-outbox-sweep-1782821220', created: false, reason: 'live' },
    });
    expect(port.live.size).toBe(1);
  });

  it('answers 503 to ensure when every probed slot name of the chain is a tombstone', async () => {
    const { app, port } = await controlApp('communications');
    for (let probe = 0; probe < MAX_SLOT_PROBES; probe += 1) {
      port.tombstones.add(`communications-outbox-sweep/communications-outbox-sweep-${String(SWEEP_SLOT_S + probe * 60)}`);
    }
    const response = await postControl(app, 'communications-outbox-sweep', 'ensure');
    expect(response.statusCode).toBe(503);
    expect(errorOf(response)).toMatchObject({ code: 'server_error' });
    expect(port.live.size).toBe(0);
  });
});

/** Client answering every call with `status` and `body`. */
function scriptedClient(status: number, body: unknown = {}): { client: ServiceClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ status, headers: {}, body }));
  return { client: { request, close: async () => undefined } as unknown as ServiceClient, request };
}

describe('callQueueControl', () => {
  it.each([
    ['ensure', 'people-outbox-sweep', '/internal/v1/task-queues/people-outbox-sweep/ensure'],
    ['pause', 'surveys-launch', '/internal/v1/task-queues/surveys-launch/pause'],
    ['resume', 'a/b c', '/internal/v1/task-queues/a%2Fb%20c/resume'],
  ] as const)('POSTs %s of %j as the calling workload, with no user token', async (op, queue, expectedPath) => {
    const answer = { queue, service: 'people', paused: false };
    const { client, request } = scriptedClient(200, answer);
    await expect(callQueueControl(client, { service: 'people', queue, op })).resolves.toBe(answer);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ service: 'people', method: 'POST', path: expectedPath, json: {}, userToken: null });
  });

  it.each([204, 299])('returns the body of an HTTP %i answer', async (status) => {
    const answer = { queue: 'surveys-launch', service: 'communications', paused: true };
    const { client } = scriptedClient(status, answer);
    await expect(callQueueControl(client, { service: 'communications', queue: 'surveys-launch', op: 'pause' })).resolves.toBe(
      answer,
    );
  });

  it.each([199, 300, 403, 503])('throws naming the service, queue, op and status of an HTTP %i answer', async (status) => {
    const { client } = scriptedClient(status);
    await expect(
      callQueueControl(client, { service: 'communications', queue: 'surveys-launch', op: 'pause' }),
    ).rejects.toThrow(new Error(`Queue control pause of surveys-launch on communications answered HTTP ${String(status)}`));
  });
});

describe('reconcileRecurringQueues', () => {
  afterEach(closeApps);

  const CREATORS = ['identity', 'people', 'programs-sites', 'surveys', 'communications', 'stub'];

  /** Every recurring-queue creator's app and task port, behind a client that injects into them as `migration`. */
  async function creatorFleet(): Promise<{ client: ServiceClient; calls: ServiceRequest[]; ports: Map<string, MemoryTaskPort> }> {
    const fleet = new Map<string, FastifyInstance>();
    const ports = new Map<string, MemoryTaskPort>();
    for (const service of CREATORS) {
      const app = await taskServiceApp(service);
      const port = new MemoryTaskPort();
      registerQueueControl(app, { port, service, serviceUrls: { ...TASK_SERVICE_URLS }, clock: TASK_CLOCK });
      fleet.set(service, app);
      ports.set(service, port);
    }
    const calls: ServiceRequest[] = [];
    const client: ServiceClient = {
      async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        calls.push(req);
        const app = fleet.get(req.service);
        if (app === undefined) throw new UnknownServiceError(req.service);
        const token = await mintServiceToken({ caller: 'migration', audience: req.service });
        const response = await app.inject({
          method: req.method,
          url: req.path,
          headers: { [INVOCATION_HEADER]: `Bearer ${token}` },
          payload: req.json as object,
        });
        return { status: response.statusCode, headers: response.headers as Record<string, string>, body: response.json() as T };
      },
      close: async () => undefined,
    };
    return { client, calls, ports };
  }

  /** Result of ensuring `queue` on `service`, whose chain task is `name`. */
  function ensured(queue: string, service: string, name: string, reason: 'created-current' | 'live'): ReconcileResult {
    return { queue, service, ok: true, ensured: { queue, name, created: reason !== 'live', reason } };
  }

  /** The service URLs of a deployment without `service`. */
  function urlsWithout(service: string): Record<string, string> {
    return Object.fromEntries(Object.entries(TASK_SERVICE_URLS).filter(([name]) => name !== service));
  }

  const sweepEnsured = (queue: string, reason: 'created-current' | 'live' = 'created-current'): ReconcileResult =>
    ensured(queue, queue.replace(/-outbox-sweep$/, ''), `${queue}-1782821220`, reason);

  const MONITOR_ENSURED = ensured(
    'programs-sites-sitemonitor',
    'programs-sites',
    'programs-sites-sitemonitor-1782820800',
    'created-current',
  );

  it('ensures every deployed sweep chain on its creator in registry order, with no user token', async () => {
    const { client, calls, ports } = await creatorFleet();
    const results = await reconcileRecurringQueues(client, { serviceUrls: { ...TASK_SERVICE_URLS } });
    expect(results).toStrictEqual(DEPLOYED_SWEEPS.map((queue) => sweepEnsured(queue)));
    expect(calls.map(({ service, path: callPath, userToken }) => ({ service, callPath, userToken }))).toStrictEqual(
      DEPLOYED_SWEEPS.map((queue) => ({
        service: queue.replace(/-outbox-sweep$/, ''),
        callPath: `/internal/v1/task-queues/${queue}/ensure`,
        userToken: null,
      })),
    );
    expect([...ports.get('people')!.live.keys()]).toStrictEqual(['people-outbox-sweep/people-outbox-sweep-1782821220']);
    expect(ports.get('stub')!.live.size).toBe(0);
  });

  it('adds the site monitor and the local-only stub sweep when asked, and reports live chains on a second run', async () => {
    const { client } = await creatorFleet();
    const opts = { serviceUrls: { ...TASK_SERVICE_URLS }, withSiteMonitor: true, includeLocalOnly: true };
    await expect(reconcileRecurringQueues(client, opts)).resolves.toStrictEqual([
      MONITOR_ENSURED,
      ...DEPLOYED_SWEEPS.map((queue) => sweepEnsured(queue)),
      sweepEnsured('stub-outbox-sweep'),
    ]);
    await expect(reconcileRecurringQueues(client, opts)).resolves.toStrictEqual([
      { ...MONITOR_ENSURED, ensured: { ...MONITOR_ENSURED.ensured!, created: false, reason: 'live' } },
      ...DEPLOYED_SWEEPS.map((queue) => sweepEnsured(queue, 'live')),
      sweepEnsured('stub-outbox-sweep', 'live'),
    ]);
  });

  it('skips a creator without a service URL when reconciling every queue', async () => {
    const { client, calls } = await creatorFleet();
    const results = await reconcileRecurringQueues(client, { serviceUrls: urlsWithout('surveys') });
    expect(results).toStrictEqual(
      DEPLOYED_SWEEPS.map((queue) =>
        queue === 'surveys-outbox-sweep'
          ? { queue, service: 'surveys', ok: true, skipped: 'not deployed' }
          : sweepEnsured(queue),
      ),
    );
    expect(calls.map((call) => call.service)).not.toContain('surveys');
  });

  it('reconciles named queues once each in registry order and fails a named creator without a service URL', async () => {
    const { client, calls } = await creatorFleet();
    const results = await reconcileRecurringQueues(client, {
      serviceUrls: urlsWithout('identity'),
      queues: ['stub-outbox-sweep', 'people-outbox-sweep', 'identity-outbox-sweep', 'people-outbox-sweep'],
    });
    expect(results).toStrictEqual([
      { queue: 'identity-outbox-sweep', service: 'identity', ok: false, error: 'not deployed' },
      sweepEnsured('people-outbox-sweep'),
      sweepEnsured('stub-outbox-sweep'),
    ]);
    expect(calls.map((call) => call.service)).toStrictEqual(['people', 'stub']);
  });

  it('reconciles the named site monitor with withSiteMonitor', async () => {
    const { client } = await creatorFleet();
    await expect(
      reconcileRecurringQueues(client, {
        serviceUrls: { ...TASK_SERVICE_URLS },
        queues: ['programs-sites-sitemonitor'],
        withSiteMonitor: true,
      }),
    ).resolves.toStrictEqual([MONITOR_ENSURED]);
  });

  it.each([
    ['a queue that is not recurring', 'surveys-launch', 'Not a recurring task queue: surveys-launch'],
    ['an unknown queue', 'finance-outbox-sweep', 'Not a recurring task queue: finance-outbox-sweep'],
    ['a prototype key', 'constructor', 'Not a recurring task queue: constructor'],
    [
      'the site monitor without withSiteMonitor',
      'programs-sites-sitemonitor',
      'programs-sites-sitemonitor is reconciled only with withSiteMonitor',
    ],
  ])('throws TypeError for %s before calling any service', async (_label, queue, message) => {
    const { client, request } = scriptedClient(200);
    const outcome = reconcileRecurringQueues(client, {
      serviceUrls: { ...TASK_SERVICE_URLS },
      queues: ['people-outbox-sweep', queue],
    });
    await expect(outcome).rejects.toBeInstanceOf(TypeError);
    await expect(outcome).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });

  it('reports each failing creator and still reconciles the rest', async () => {
    const { client: fleetClient, ports } = await creatorFleet();
    ports.get('people')!.listFailure = new Error('list failed');
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8117'), { code: 'ECONNREFUSED' });
    const client: ServiceClient = {
      request: <T>(req: ServiceRequest): Promise<ServiceResponse<T>> => {
        if (req.service === 'identity') return Promise.reject('socket hang up');
        if (req.service === 'surveys') return Promise.reject(new ServiceUnavailableError('surveys', refused));
        return fleetClient.request<T>(req);
      },
      close: fleetClient.close,
    };
    await expect(reconcileRecurringQueues(client, { serviceUrls: { ...TASK_SERVICE_URLS } })).resolves.toStrictEqual([
      { queue: 'identity-outbox-sweep', service: 'identity', ok: false, error: 'socket hang up' },
      {
        queue: 'people-outbox-sweep',
        service: 'people',
        ok: false,
        error: 'Queue control ensure of people-outbox-sweep on people answered HTTP 500',
      },
      sweepEnsured('programs-sites-outbox-sweep'),
      { queue: 'surveys-outbox-sweep', service: 'surveys', ok: false, error: 'Service surveys unavailable (ECONNREFUSED)' },
      sweepEnsured('communications-outbox-sweep'),
    ]);
  });
});

describe('createTaskPort', () => {
  const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  const stateDir = path.join(tmpdir(), 'opt2-tasks-unit-unused');
  const localMessage = 'The local tasks adapter requires a TenantDb, a logger and OPT2_STATE_DIR';
  it.each([
    ['no adapter is selected', {}, {}, 'OPT2_TASKS_ADAPTER must be local or cloud, got undefined'],
    ['an unknown adapter is selected', { OPT2_TASKS_ADAPTER: 'memory' }, {}, 'OPT2_TASKS_ADAPTER must be local or cloud, got memory'],
    ['the local adapter has no TenantDb', { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: stateDir }, { logger }, localMessage],
    ['the local adapter has no logger', { OPT2_TASKS_ADAPTER: 'local', OPT2_STATE_DIR: stateDir }, { db: memoryTenantDb() }, localMessage],
    ['the local adapter has no OPT2_STATE_DIR', { OPT2_TASKS_ADAPTER: 'local' }, { db: memoryTenantDb(), logger }, localMessage],
    ['the cloud adapter has no project', { OPT2_TASKS_ADAPTER: 'cloud' }, {}, 'GOOGLE_CLOUD_PROJECT is required for the cloud tasks adapter'],
  ] satisfies Array<[string, Record<string, unknown>, CreateTaskPortOptions, string]>)(
    'throws TaskPortConfigError when %s',
    async (_label, env, opts, message) => {
      const outcome = createTaskPort(env as TaskEnv, opts);
      await expect(outcome).rejects.toBeInstanceOf(TaskPortConfigError);
      await expect(outcome).rejects.toThrow(message);
    },
  );
});
