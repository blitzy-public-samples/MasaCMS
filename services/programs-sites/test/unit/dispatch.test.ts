/** Per-step routing of the site monitor: target tasks, legacy steps through migration, names, queues and deadlines. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  UnknownServiceError,
  createServiceClient,
  fixedClock,
  type Clock,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  SITEMONITOR_QUEUE,
  InvalidTaskNameError,
  queueDefinition,
  queuesCreatedBy,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from '@opt2/platform/tasks';
import {
  LEGACY_TIME_MASK,
  SiteMonitorDeadlineError,
  createMigrationJobsPort,
  createStepDispatcher,
  formatLegacyTime,
  resolveStepQueue,
  stepTaskName,
  type LegacyStepRequest,
  type MigrationJobsPort,
  type StepInvocation,
} from '../../src/jobs/dispatch.js';
import { stepNamed, type SiteMonitorStepName } from '../../src/jobs/steps.js';

const RUN_AT = new Date(2026, 5, 30, 9, 15, 0, 0);
const LAST_MONITORED = new Date(2026, 5, 30, 9, 0, 0, 125);
const DEADLINE_AT = new Date(RUN_AT.getTime() + 600_000);
const SERVICE_URLS = { 'strategies-content': 'http://127.0.0.1:8114/', 'programs-sites': 'http://127.0.0.1:8113' };
const PUBLISH_PATH = '/internal/v1/jobs/publish-scheduled-changesets';
const FEED_PATH = '/internal/v1/jobs/feed-auto-import';
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

/** In-memory task port with ALREADY_EXISTS semantics; a task stays listed for `pollsLive` list calls, on page two when `paged`. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local' as const;
  readonly created: CreateTaskInput[] = [];
  readonly listCalls: Array<{ queue: string; page?: TaskPageRequest }> = [];
  private readonly live = new Map<string, { input: CreateTaskInput; polls: number }>();

  constructor(
    private readonly pollsLive = 0,
    private readonly paged = false,
  ) {}

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (this.created.some((task) => task.name === input.name)) return { name: input.name, created: false };
    this.created.push(input);
    this.live.set(input.name, { input, polls: this.pollsLive });
    return { name: input.name, created: true };
  }
  async delete(_queue: string, name: string): Promise<DeleteTaskResult> {
    return { name, deleted: this.live.delete(name) };
  }
  async list(queue: string, page?: TaskPageRequest): Promise<TaskPage> {
    this.listCalls.push({ queue, page });
    if (this.paged && page?.pageToken === undefined) return { tasks: [], nextPageToken: 'p2' };
    const tasks: TaskInfo[] = [];
    for (const [name, entry] of this.live) {
      if (entry.input.queue !== queue) continue;
      if (entry.polls <= 0) {
        this.live.delete(name);
        continue;
      }
      entry.polls -= 1;
      tasks.push({ queue, name, scheduleTime: entry.input.scheduleTime, status: 'pending', attempts: 0 });
    }
    return { tasks };
  }
  async get(): Promise<TaskInfo | undefined> {
    return undefined;
  }
  async pauseQueue(): Promise<void> {}
  async resumeQueue(): Promise<void> {}
  async queueState(queue: string): Promise<QueueState> {
    return { queue, paused: false };
  }
  async close(): Promise<void> {}
}

/** Migration port fake answering one fixed authority and recording every call. */
function fakeMigration(targetAuthoritative: boolean): MigrationJobsPort & {
  authorityCalls: Array<readonly string[]>;
  legacyCalls: Array<{ req: LegacyStepRequest; deadlineAt: Date }>;
} {
  const authorityCalls: Array<readonly string[]> = [];
  const legacyCalls: Array<{ req: LegacyStepRequest; deadlineAt: Date }> = [];
  return {
    authorityCalls,
    legacyCalls,
    async unitsTargetAuthoritative(units) {
      authorityCalls.push(units);
      return targetAuthoritative;
    },
    async runLegacyStep(req, deadlineAt) {
      legacyCalls.push({ req, deadlineAt });
    },
  };
}

function invocation(name: SiteMonitorStepName, siteId?: string, theTime: Date = RUN_AT): StepInvocation {
  return { step: stepNamed(name), ...(siteId === undefined ? {} : { siteId }), theTime, lastMonitored: LAST_MONITORED, runAt: RUN_AT, deadlineAt: DEADLINE_AT };
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

function setup(opts: { authority: boolean; pollsLive?: number; paged?: boolean; clock?: Clock }) {
  const port = new MemoryTaskPort(opts.pollsLive ?? 0, opts.paged ?? false);
  const migration = fakeMigration(opts.authority);
  const { sleep, waits } = recordingSleep();
  const clock = opts.clock ?? fixedClock(RUN_AT);
  const dispatcher = createStepDispatcher({ port, migration, serviceUrls: SERVICE_URLS, clock, sleep, pollIntervalMs: 250 });
  return { port, migration, waits, dispatcher, clock };
}

describe('legacy time format', () => {
  it('formats the legacy wall-clock time with milliseconds', () => {
    expect(LEGACY_TIME_MASK).toBe('yyyy-MM-dd HH:nn:ss.lll');
    expect(formatLegacyTime(new Date(2026, 5, 30, 9, 5, 7, 42))).toBe('2026-06-30 09:05:07.042');
  });
});

describe('resolveStepQueue', () => {
  it.each([
    [PUBLISH_PATH, 'content-scheduled-publish'],
    [FEED_PATH, 'content-feed-import'],
    ['/internal/v1/jobs/unknown', SITEMONITOR_QUEUE],
  ])('%s resolves to %s', (path, queue) => {
    expect(resolveStepQueue(path)).toBe(queue);
  });

  it('takes the strategies-content queues from the registry programs-sites creates on', () => {
    for (const path of [PUBLISH_PATH, FEED_PATH]) {
      const def = queuesCreatedBy('programs-sites').find((q) => q.targetPath === path);
      expect(def?.targetService).toBe('strategies-content');
      expect(resolveStepQueue(path)).toBe(def?.name);
    }
  });
});

describe('stepTaskName', () => {
  const epochS = Math.floor(RUN_AT.getTime() / 1000);

  it('is the queue slot name plus the kebab step', () => {
    expect(stepTaskName({ queue: 'content-scheduled-publish', runAt: RUN_AT, step: 'publishScheduledChangesets' })).toBe(
      `content-scheduled-publish-${String(epochS)}-publish-scheduled-changesets`,
    );
  });

  it('appends the site slug and a digest that keeps slug-equal site ids apart', () => {
    const a = stepTaskName({ queue: 'content-feed-import', runAt: RUN_AT, step: 'feedAutoImport', siteId: 'Site.A' });
    const b = stepTaskName({ queue: 'content-feed-import', runAt: RUN_AT, step: 'feedAutoImport', siteId: 'site_a' });
    expect(a).toMatch(new RegExp(`^content-feed-import-${String(epochS)}-feed-auto-import-site_a-[0-9a-f]{8}$`));
    expect(b).toMatch(/-site_a-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('is deterministic per run, step and site', () => {
    const args = { queue: 'content-feed-import', runAt: RUN_AT, step: 'feedAutoImport', siteId: 'tenant-a' } as const;
    expect(stepTaskName(args)).toBe(stepTaskName({ ...args, runAt: new Date(RUN_AT.getTime()) }));
    expect(stepTaskName(args)).not.toBe(stepTaskName({ ...args, runAt: new Date(RUN_AT.getTime() + 1000) }));
    expect(stepTaskName(args)).not.toBe(stepTaskName({ ...args, siteId: 'tenant-b' }));
  });

  it('rejects a name beyond the Cloud Tasks length', () => {
    expect(() => stepTaskName({ queue: 'content-feed-import', runAt: RUN_AT, step: 'feedAutoImport', siteId: 'x'.repeat(500) })).toThrow(
      InvalidTaskNameError,
    );
  });
});

describe('createStepDispatcher', () => {
  it('creates a tenant-less strategies-content task when every unit is target-authoritative', async () => {
    const { port, migration, dispatcher } = setup({ authority: true });
    const outcome = await dispatcher.dispatch(invocation('publishScheduledChangesets'));

    expect(migration.authorityCalls).toEqual([stepNamed('publishScheduledChangesets').units]);
    expect(migration.legacyCalls).toEqual([]);
    const [task] = port.created;
    expect(port.created).toHaveLength(1);
    expect(task).toEqual({
      queue: 'content-scheduled-publish',
      name: stepTaskName({ queue: 'content-scheduled-publish', runAt: RUN_AT, step: 'publishScheduledChangesets' }),
      scheduleTime: RUN_AT,
      url: `http://127.0.0.1:8114${PUBLISH_PATH}`,
      body: { step: 'publishScheduledChangesets', theTime: '2026-06-30T09:15:00.000', lastMonitored: '2026-06-30T09:00:00.125' },
      deadlineS: queueDefinition('content-scheduled-publish').deadlineS,
    });
    expect(task).not.toHaveProperty('tenantId');
    expect(outcome).toEqual({
      step: 'publishScheduledChangesets',
      route: 'target',
      theTime: RUN_AT,
      task: { queue: 'content-scheduled-publish', name: task?.name, created: true },
    });
    expect(outcome).not.toHaveProperty('siteId');
  });

  it('carries ?siteid= and the payload siteId for feedAutoImport', async () => {
    const { port, dispatcher } = setup({ authority: true });
    const outcome = await dispatcher.dispatch(invocation('feedAutoImport', 'tenant a&b'));

    expect(port.created[0]?.url).toBe(`http://127.0.0.1:8114${FEED_PATH}?siteid=tenant%20a%26b`);
    expect(port.created[0]?.queue).toBe('content-feed-import');
    expect(port.created[0]?.body).toMatchObject({ step: 'feedAutoImport', siteId: 'tenant a&b' });
    expect((port.created[0]?.body as { theTime: string }).theTime).toMatch(LOCAL_TIMESTAMP);
    expect(outcome).toMatchObject({ step: 'feedAutoImport', siteId: 'tenant a&b', route: 'target' });
  });

  it('treats a repeated create of the same run, step and site as success', async () => {
    const { port, dispatcher } = setup({ authority: true });
    const first = await dispatcher.dispatch(invocation('feedAutoImport', 'tenant-a'));
    const second = await dispatcher.dispatch(invocation('feedAutoImport', 'tenant-a'));

    expect(port.created).toHaveLength(1);
    expect(second.task).toEqual({ ...first.task, created: false });
  });

  it('runs on legacy through migration when one unit is not target-authoritative', async () => {
    const { port, migration, dispatcher } = setup({ authority: false });
    const outcome = await dispatcher.dispatch(invocation('feedAutoImport', 'tenant-a'));

    expect(migration.authorityCalls).toHaveLength(1);
    expect(port.created).toEqual([]);
    expect(migration.legacyCalls).toEqual([
      {
        req: {
          job: 'feedAutoImport',
          theTime: '2026-06-30 09:15:00.000',
          lastMonitored: '2026-06-30 09:00:00.125',
          siteId: 'tenant-a',
          units: stepNamed('feedAutoImport').units,
        },
        deadlineAt: DEADLINE_AT,
      },
    ]);
    expect(outcome).toEqual({ step: 'feedAutoImport', siteId: 'tenant-a', route: 'legacy', theTime: RUN_AT });
  });

  it.each<SiteMonitorStepName>(['sendReminders', 'emailSend', 'purgeDisplayWindow', 'clearOldCommands', 'onGlobalMonitor', 'setCursor'])(
    '%s has no target route and never asks for authority',
    async (name) => {
      const { migration, dispatcher } = setup({ authority: true });
      const outcome = await dispatcher.dispatch(invocation(name));

      expect(migration.authorityCalls).toEqual([]);
      expect(migration.legacyCalls.map((call) => call.req.job)).toEqual([name]);
      expect(outcome.route).toBe('legacy');
    },
  );

  it('passes the catch-up reminder time in the legacy mask', async () => {
    const { migration, dispatcher } = setup({ authority: false });
    await dispatcher.dispatch(invocation('sendReminders', undefined, new Date(RUN_AT.getTime() - 30 * 60_000)));

    expect(migration.legacyCalls[0]?.req.theTime).toBe(formatLegacyTime(new Date(2026, 5, 30, 8, 45, 0, 0)));
    expect(migration.legacyCalls[0]?.req).not.toHaveProperty('siteId');
  });

  it('waits until the task has left every page of port.list', async () => {
    const { port, waits, dispatcher } = setup({ authority: true, pollsLive: 3, paged: true });
    await dispatcher.dispatch(invocation('publishScheduledChangesets'));

    expect(waits).toEqual([250, 250, 250]);
    expect(port.listCalls.filter((call) => call.page?.pageToken === 'p2')).toHaveLength(4);
    expect(port.listCalls.every((call) => call.queue === 'content-scheduled-publish')).toBe(true);
  });

  it('throws SiteMonitorDeadlineError when the deadline passes while the task is live', async () => {
    const { port, waits, dispatcher } = setup({ authority: true, pollsLive: 10, clock: fixedClock(DEADLINE_AT) });
    const failure = dispatcher.dispatch(invocation('feedAutoImport', 'tenant-a'));

    await expect(failure).rejects.toBeInstanceOf(SiteMonitorDeadlineError);
    await expect(failure).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({ step: 'feedAutoImport', siteId: 'tenant-a', reason: 'sitemonitor-deadline' });
    expect(port.created).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('waits with the default timer when no sleep is injected', async () => {
    const port = new MemoryTaskPort(1);
    const dispatcher = createStepDispatcher({
      port,
      migration: fakeMigration(true),
      serviceUrls: SERVICE_URLS,
      clock: fixedClock(RUN_AT),
      pollIntervalMs: 1,
    });

    await expect(dispatcher.dispatch(invocation('publishScheduledChangesets'))).resolves.toMatchObject({ route: 'target' });
    expect(port.listCalls).toHaveLength(2);
  });

  it.each([
    ['feedAutoImport', undefined],
    ['emailSend', 'tenant-a'],
  ] as const)('rejects %s with siteId %s', async (name, siteId) => {
    const { migration, dispatcher } = setup({ authority: true });
    await expect(dispatcher.dispatch(invocation(name, siteId))).rejects.toBeInstanceOf(TypeError);
    expect(migration.authorityCalls).toEqual([]);
  });
});

/** Service client fake answering from `answer` and recording every request. */
function fakeClient(answer: (req: ServiceRequest) => ServiceResponse | Error) {
  const requests: ServiceRequest[] = [];
  return {
    requests,
    client: {
      async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        requests.push(req);
        const res = answer(req);
        if (res instanceof Error) throw res;
        return res as ServiceResponse<T>;
      },
    },
  };
}

function authority(units: Record<string, 'legacy' | 'target'>, allTarget: boolean): ServiceResponse {
  return { status: 200, headers: {}, body: { tableVersion: 'v0002', units, allTarget } };
}

describe('createMigrationJobsPort.unitsTargetAuthoritative', () => {
  it('asks unitAuthority with the file store folded into its tfiles unit', async () => {
    const { client, requests } = fakeClient(() => authority({ 'content.content': 'target', 'content.file': 'target' }, true));
    const port = createMigrationJobsPort({ client });

    await expect(port.unitsTargetAuthoritative(['content.content', 'content.file', 'file-store'])).resolves.toBe(true);
    expect(requests).toEqual([
      { service: 'migration', method: 'GET', path: '/internal/v1/authority', query: { units: 'content.content,content.file' }, userToken: null },
    ]);
  });

  it('answers false without a call when a unit is a decision-list table', async () => {
    const { client, requests } = fakeClient(() => authority({}, true));
    const port = createMigrationJobsPort({ client });

    await expect(port.unitsTargetAuthoritative(stepNamed('publishScheduledChangesets').units)).resolves.toBe(false);
    expect(requests).toEqual([]);
  });

  it.each([
    ['one unit legacy', authority({ 'content.content': 'target', 'content.changeset': 'legacy' }, false)],
    ['a requested unit unreported', authority({ 'content.content': 'target' }, true)],
    ['allTarget false', authority({ 'content.content': 'target', 'content.changeset': 'target' }, false)],
  ])('answers false with %s', async (_case, response) => {
    const { client } = fakeClient(() => response);
    await expect(createMigrationJobsPort({ client }).unitsTargetAuthoritative(['content.content', 'content.changeset'])).resolves.toBe(false);
  });

  it('fails closed on a 503 and throws on any other status', async () => {
    const unavailable = fakeClient(() => ({ status: 503, headers: {}, body: {} }));
    await expect(createMigrationJobsPort(unavailable).unitsTargetAuthoritative(['content.content'])).rejects.toBeInstanceOf(
      LegacyServiceUnavailableError,
    );
    const rejected = fakeClient(() => ({ status: 400, headers: {}, body: {} }));
    const failure = createMigrationJobsPort(rejected).unitsTargetAuthoritative(['content.content']);
    await expect(failure).rejects.toThrow('Migration unitAuthority answered 400');
    await expect(failure).rejects.not.toBeInstanceOf(LegacyServiceUnavailableError);
  });
});

describe('createMigrationJobsPort.runLegacyStep', () => {
  const req: LegacyStepRequest = {
    job: 'trackBounces',
    theTime: '2026-06-30 09:15:00.000',
    lastMonitored: '2026-06-30 09:00:00.125',
    siteId: 'tenant-a',
    units: ['communications.email_stat'],
  };

  const atRun = fixedClock(RUN_AT);
  const completed: ServiceResponse = {
    status: 200,
    headers: {},
    body: { step: 'trackBounces', completed: true, serverTime: '2026-06-30T09:15:01.000Z', siteId: 'tenant-a' },
  };

  /** Fake client failing with `error`, and a clock reading RUN_AT until the call and `endsAt` once it failed. */
  function failingCall(error: Error, endsAt: Date): { client: Pick<ServiceClient, 'request'>; clock: Clock } {
    let now = RUN_AT;
    const { client } = fakeClient(() => {
      now = endsAt;
      return error;
    });
    return { client, clock: { now: () => now } };
  }

  it('posts the contract body without units and as no user', async () => {
    const { client, requests } = fakeClient(() => completed);
    await createMigrationJobsPort({ client, clock: atRun }).runLegacyStep(req, DEADLINE_AT);

    expect(requests).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: '/internal/v1/legacy-steps',
        json: {
          step: 'trackBounces',
          theTime: req.theTime,
          lastMonitored: req.lastMonitored,
          deadlineAt: DEADLINE_AT.toISOString(),
          siteId: 'tenant-a',
        },
        userToken: null,
        timeoutMs: DEADLINE_AT.getTime() - RUN_AT.getTime(),
      },
    ]);
  });

  it.each([
    [450_000, 150_000],
    [599_999, 1],
  ])('bounds the call %i ms into the run by the remaining %i ms', async (elapsedMs, timeoutMs) => {
    const { client, requests } = fakeClient(() => completed);
    await createMigrationJobsPort({ client, clock: fixedClock(RUN_AT.getTime() + elapsedMs) }).runLegacyStep(req, DEADLINE_AT);
    expect(requests[0]?.timeoutMs).toBe(timeoutMs);
  });

  it.each([0, 1])('throws SiteMonitorDeadlineError without a call %i ms past the deadline', async (pastMs) => {
    const { client, requests } = fakeClient(() => completed);
    const failure = createMigrationJobsPort({ client, clock: fixedClock(DEADLINE_AT.getTime() + pastMs) }).runLegacyStep(req, DEADLINE_AT);
    await expect(failure).rejects.toBeInstanceOf(SiteMonitorDeadlineError);
    await expect(failure).rejects.toMatchObject({ step: 'trackBounces', siteId: 'tenant-a', reason: 'sitemonitor-deadline', cause: undefined });
    expect(requests).toEqual([]);
  });

  it.each([
    ['its own TimeoutError before the deadline', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new Date(DEADLINE_AT.getTime() - 1)],
    [
      'its own HeadersTimeoutError before the deadline',
      Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' }),
      new Date(DEADLINE_AT.getTime() - 1),
    ],
    [
      'its own BodyTimeoutError before the deadline',
      Object.assign(new Error('Body Timeout Error'), { name: 'BodyTimeoutError', code: 'UND_ERR_BODY_TIMEOUT' }),
      new Date(DEADLINE_AT.getTime() - 1),
    ],
    ['ECONNRESET at the deadline', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), DEADLINE_AT],
  ])('turns the client ServiceUnavailableError from %s into SiteMonitorDeadlineError caused by it', async (_case, cause, endsAt) => {
    const unavailable = new ServiceUnavailableError('migration', cause);
    const { client, clock } = failingCall(unavailable, endsAt);
    const err: unknown = await createMigrationJobsPort({ client, clock })
      .runLegacyStep(req, DEADLINE_AT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiteMonitorDeadlineError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ step: 'trackBounces', siteId: 'tenant-a', reason: 'sitemonitor-deadline' });
    expect((err as SiteMonitorDeadlineError).cause).toBe(unavailable);
  });

  it.each([
    ['an ECONNREFUSED ServiceUnavailableError before the deadline', new ServiceUnavailableError('migration', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), new Date(DEADLINE_AT.getTime() - 1)],
    [
      'a ConnectTimeoutError ServiceUnavailableError before the deadline',
      new ServiceUnavailableError('migration', Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })),
      new Date(DEADLINE_AT.getTime() - 1),
    ],
    ['any other client error at the deadline', new UnknownServiceError('migration'), DEADLINE_AT],
  ])('rethrows %s unchanged', async (_case, error, endsAt) => {
    const { client, clock } = failingCall(error, endsAt);
    await expect(createMigrationJobsPort({ client, clock }).runLegacyStep(req, DEADLINE_AT)).rejects.toBe(error);
  });

  it('omits siteId for a run-wide step', async () => {
    const { client, requests } = fakeClient(() => ({ status: 200, headers: {}, body: {} }));
    await createMigrationJobsPort({ client, clock: atRun }).runLegacyStep({ job: 'setCursor', theTime: req.theTime, lastMonitored: req.lastMonitored, units: [] }, DEADLINE_AT);
    expect(requests[0]?.json).not.toHaveProperty('siteId');
  });

  it('maps 504 to SiteMonitorDeadlineError', async () => {
    const { client } = fakeClient(() => ({ status: 504, headers: {}, body: {} }));
    await expect(createMigrationJobsPort({ client, clock: atRun }).runLegacyStep(req, DEADLINE_AT)).rejects.toMatchObject({
      name: 'SiteMonitorDeadlineError',
      step: 'trackBounces',
      siteId: 'tenant-a',
    });
  });

  it.each([
    [503, LegacyServiceUnavailableError],
    [500, Error],
  ] as const)('rejects on status %i', async (status, type) => {
    const { client } = fakeClient(() => ({ status, headers: {}, body: {} }));
    const failure = createMigrationJobsPort({ client, clock: atRun }).runLegacyStep(req, DEADLINE_AT);
    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toThrow(`legacyStepRun(trackBounces)`);
  });

  describe('over the platform service client', () => {
    const STEP_MS = 1_000;
    const received: Array<{ method?: string; url?: string; body: unknown }> = [];
    let server: Server;
    let client: ServiceClient;

    beforeAll(async () => {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          const timer = setTimeout(() => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(completed.body));
          }, STEP_MS);
          response.on('close', () => clearTimeout(timer));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      client = createServiceClient({
        serviceUrls: { migration: `http://127.0.0.1:${String(port)}` },
        self: 'programs-sites',
        credentials: { headersFor: async () => ({}) },
        timeoutMs: 200,
      });
    });

    afterAll(async () => {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
    });

    it('completes a step that outlasts the client timeout but not the run budget', async () => {
      const started = Date.now();
      await createMigrationJobsPort({ client }).runLegacyStep(req, new Date(started + 5_000));

      expect(Date.now() - started).toBeGreaterThanOrEqual(STEP_MS);
      expect(received).toEqual([{ method: 'POST', url: '/internal/v1/legacy-steps', body: expect.objectContaining({ step: 'trackBounces', siteId: 'tenant-a' }) }]);
    });

    it('throws SiteMonitorDeadlineError when the run budget ends before the step answers', async () => {
      const started = Date.now();
      const err: unknown = await createMigrationJobsPort({ client })
        .runLegacyStep(req, new Date(started + 300))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SiteMonitorDeadlineError);
      expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
      expect((err as SiteMonitorDeadlineError).cause).toBeInstanceOf(ServiceUnavailableError);
      expect(Date.now() - started).toBeLessThan(STEP_MS);
    });
  });
});
