// Unit tests for `opt2-ops resume`, run after drain-and-suspend against in-memory owners, Pub/Sub, background record, scheduler state and service client.
import { subscriptionName } from '@opt2/platform/events';
import type { PositionResponse } from '@opt2/platform/migration-kit';
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, SITEMONITOR_QUEUE, reconcileRecurringQueues, type QueueControlOp } from '@opt2/platform/tasks';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationEnv } from '../../src/env.js';
import type { OwnersClient } from '../../src/owners/index.js';
import { defaultBackgroundRecord, type BackgroundRecord, type BackgroundStateApi } from '../../src/quiesce/background.js';
import { ResumeReconcileError, resume, type ResumeContext, type ResumeOptions } from '../../src/quiesce/resume.js';
import {
  createPubSub,
  readPushConfig,
  type PubSubLike,
  type SavedPushConfig,
  type SubscriptionLike,
} from '../../src/quiesce/subscriptions.js';
import { drainAndSuspend, type QueueTarget } from '../../src/quiesce/suspend.js';
import { declaredSubscriptions } from '../../src/quiesce/topology.js';
import type { PauseResult, RestoreResult, SiteMonitorRecord } from '../../src/scheduler/index.js';

vi.mock('@opt2/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tasks')>();
  return { ...actual, reconcileRecurringQueues: vi.fn(actual.reconcileRecurringQueues) };
});

vi.mock('../../src/quiesce/subscriptions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/quiesce/subscriptions.js')>();
  return { ...actual, createPubSub: vi.fn() };
});

const CONFIG = loadConfig();
const PROJECT = 'opt2-unit';
const NOW = businessClock().now().toISOString();
const PEOPLE_GROUP = subscriptionName('people', 'identity.group.changed.v1');
const TIMESHEETS_ARCHIVED = subscriptionName('timesheets', 'people.person.archived.v1');
/** Declared subscriptions in push mode before the suspend; the other declared ones are in pull mode. */
const PUSHED = [TIMESHEETS_ARCHIVED, PEOPLE_GROUP];
const PAUSED: PauseResult = { siteMonitor: [], surveys: ['opt2-survey-41-launch'] };
const RESTORED: RestoreResult = { siteMonitor: [], surveys: ['opt2-survey-41-launch'] };

const ALL_SERVICES: Record<string, string> = {
  timesheets: 'http://127.0.0.1:20118',
  'programs-sites': 'http://127.0.0.1:20113',
  stub: 'http://127.0.0.1:20199',
  identity: 'http://127.0.0.1:20111',
  surveys: 'http://127.0.0.1:20117',
  'strategies-content': 'http://127.0.0.1:20114',
  people: 'http://127.0.0.1:20112',
  reporting: 'http://127.0.0.1:20116',
  communications: 'http://127.0.0.1:20115',
};

const target = (service: string, queue: string): QueueTarget => ({ service, queue });
/** Every creator of every registry queue, sorted by service, then queue, as drain-and-suspend pauses them. */
const ALL_TARGETS = [
  target('communications', 'communications-outbox-sweep'),
  target('communications', 'communications-reminders'),
  target('communications', 'surveys-launch'),
  target('identity', 'identity-outbox-sweep'),
  target('people', 'people-outbox-sweep'),
  target('programs-sites', 'content-feed-import'),
  target('programs-sites', 'content-scheduled-publish'),
  target('programs-sites', 'programs-sites-outbox-sweep'),
  target('programs-sites', SITEMONITOR_QUEUE),
  target('reporting', 'reporting-export-run'),
  target('strategies-content', 'content-scheduled-publish'),
  target('stub', 'stub-outbox-sweep'),
  target('surveys', 'surveys-outbox-sweep'),
];
/** Chains `opt2-tasks reconcile` ensures in registry order without the site monitor; the stub's only with local-only queues. */
const SWEEPS = [
  target('identity', 'identity-outbox-sweep'),
  target('people', 'people-outbox-sweep'),
  target('programs-sites', 'programs-sites-outbox-sweep'),
  target('surveys', 'surveys-outbox-sweep'),
  target('communications', 'communications-outbox-sweep'),
];
const STUB_SWEEP = target('stub', 'stub-outbox-sweep');
const MONITOR_CHAIN = target('programs-sites', SITEMONITOR_QUEUE);

const endpoint = (name: string): string => `http://127.0.0.1:20118/internal/v1/events/${name}?key=unit-push-key`;
/** Push config as Pub/Sub reports it, with null oneof members. */
const livePush = (name: string) => ({
  pushEndpoint: endpoint(name),
  attributes: { 'x-goog-version': 'v1' },
  oidcToken: null,
  noWrapper: { writeMetadata: false },
  wrapper: 'noWrapper',
});
/** `livePush(name)` without its null members, as drain-and-suspend saves it. */
const savedPush = (name: string): SavedPushConfig => ({
  pushEndpoint: endpoint(name),
  attributes: { 'x-goog-version': 'v1' },
  noWrapper: { writeMetadata: false },
  wrapper: 'noWrapper',
});
const PULL = { pushEndpoint: '', attributes: {}, oidcToken: null };

/** A suspended record as drain-and-suspend leaves it. */
const SUSPENDED: BackgroundRecord = {
  suspended: true,
  since: NOW,
  reason: 'drain-and-suspend',
  pushConfigs: { [PEOPLE_GROUP]: savedPush(PEOPLE_GROUP), [TIMESHEETS_ARCHIVED]: savedPush(TIMESHEETS_ARCHIVED) },
  pausedQueues: ALL_TARGETS,
  pausedTasks: PAUSED.surveys,
};
const CLEARED: BackgroundRecord = { ...defaultBackgroundRecord(), resumedAt: NOW };

const controlPath = (queue: string, op: QueueControlOp): string => `${QUEUE_CONTROL_PREFIX}/${queue}/${op}`;
const controlEntry = ({ service, queue }: QueueTarget, op: QueueControlOp): string => `${service} ${controlPath(queue, op)}`;
const ensuredResult = ({ service, queue }: QueueTarget) => ({
  queue,
  service,
  ok: true,
  ensured: { queue, name: `${queue}-1782820800`, created: true, reason: 'created-current' },
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const monitorRecord = (patch: Partial<SiteMonitorRecord>): SiteMonitorRecord => ({
  nativeExisted: true,
  originalPing: true,
  definition: null,
  state: 'target',
  nativePaused: null,
  targetTriggerDisabled: false,
  updatedAt: NOW,
  ...patch,
});

/** Port that fails the test when any member is read. */
function untouched<K extends keyof ResumeContext>(port: K): ResumeContext[K] {
  return new Proxy({} as ResumeContext[K], {
    get(_target, member) {
      throw new Error(`${port}.${String(member)} was read`);
    },
  });
}

/** Database holding only the `sitemonitor` scheduler record, absent when `null`. */
function schedulerDb(monitor: SiteMonitorRecord | null, log: string[]): TenantDb {
  const tx = {
    query: (_sql: string, params: unknown[]) => {
      log.push(`read ${String(params[0])}`);
      return Promise.resolve({ rows: monitor === null ? [] : [{ value: copy(monitor) }] });
    },
  } as unknown as MetadataTx;
  return {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('withTenant was called')),
    withMetadata: <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => fn(tx),
    end: () => Promise.resolve(),
  };
}

/** In-memory subscription whose push config `modifyPushConfig` replaces; each change is logged. */
function fakeSubscription(log: string[], id: string, pushConfig: unknown) {
  const state = { pushConfig };
  return {
    name: `projects/${PROJECT}/subscriptions/${id}`,
    state,
    getMetadata: () => Promise.resolve<[{ pushConfig?: unknown }]>([{ pushConfig: state.pushConfig }]),
    modifyPushConfig: vi.fn<(config: SavedPushConfig) => Promise<unknown>>((config) => {
      log.push(`modifyPushConfig ${id} ${JSON.stringify(config)}`);
      state.pushConfig = copy(config);
      return Promise.resolve([{}]);
    }),
    seek: () => Promise.reject(new Error('seek was called')),
  } satisfies SubscriptionLike & { state: { pushConfig: unknown } };
}

/** Every fake a suspend and a resume share, with one log of their calls in order. */
async function world(monitor: SiteMonitorRecord | null = null) {
  const log: string[] = [];
  const clock = businessClock();
  const declared = (await Promise.all(CONFIG.dataOwners.map((owner) => declaredSubscriptions(CONFIG, owner)))).flat().map(({ name }) => name);
  const subscriptions = new Map(declared.map((id) => [id, fakeSubscription(log, id, PUSHED.includes(id) ? livePush(id) : PULL)]));
  const subscription = (id: string): ReturnType<typeof fakeSubscription> => {
    const found = subscriptions.get(id);
    if (found === undefined) throw new Error(`No subscription ${id}`);
    return found;
  };
  const pubsub = {
    projectId: PROJECT,
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([[...subscriptions.values()]]),
    subscription: vi.fn<(name: string) => SubscriptionLike>(subscription),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  } satisfies PubSubLike;

  const position = (owner: string): Promise<PositionResponse> =>
    Promise.resolve({ owner, position: '4242', outbox: null, inbox: null, published: [] } as PositionResponse);
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });

  const settings: { status: (request: ServiceRequest) => number } = { status: () => 200 };
  const requests: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(request: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(request);
      log.push(`${request.service} ${request.path}`);
      const [, queue = '', op] = /\/([^/]+)\/([^/]+)$/.exec(request.path) ?? [];
      const { service } = request;
      const body = op === 'ensure' ? { queue, service, ensured: ensuredResult({ service, queue }).ensured } : { queue, service, paused: op === 'pause' };
      return Promise.resolve({ status: settings.status(request), headers: {}, body } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };

  const background = { stored: defaultBackgroundRecord() };
  const clear = vi.fn<() => Promise<BackgroundRecord>>(() => {
    log.push('clear');
    background.stored = copy(CLEARED);
    return Promise.resolve(copy(background.stored));
  });
  const backgroundApi: BackgroundStateApi = {
    isSuspended: () => Promise.resolve(background.stored.suspended),
    get: () => {
      log.push('get');
      return Promise.resolve(copy(background.stored));
    },
    suspend: (record) => {
      log.push('suspend');
      background.stored = copy({ ...record, suspended: true, since: record.since ?? NOW });
      return Promise.resolve(copy(background.stored));
    },
    resume: (): Promise<BackgroundRecord> => clear(),
  };
  const scheduler = {
    pauseAll: vi.fn<() => Promise<PauseResult>>(() => Promise.resolve(PAUSED)),
    restoreAll: vi.fn<() => Promise<RestoreResult>>(() => {
      log.push('restoreAll');
      return Promise.resolve(RESTORED);
    }),
  };

  const context = (db: TenantDb = schedulerDb(monitor, log)): ResumeContext & { config: typeof CONFIG } => ({
    env: { GOOGLE_CLOUD_PROJECT: PROJECT, OPT2_SERVICE_URLS: ALL_SERVICES } as MigrationEnv,
    config: CONFIG,
    clock,
    owners,
    client,
    db,
    catalog: untouched('catalog'),
    bridge: untouched('bridge'),
    logger: untouched('logger'),
    clientAs: () => {
      throw new Error('clientAs was called');
    },
  });
  const ports = (extra: ResumeOptions = {}): ResumeOptions => ({ background: backgroundApi, pubsub, scheduler, ...extra });
  const suspend = () => drainAndSuspend(context(), { background: backgroundApi, pubsub, scheduler });
  return { log, subscriptions, subscription, pubsub, requests, settings, background, clear, scheduler, context, ports, suspend };
}

afterEach(() => {
  vi.mocked(reconcileRecurringQueues).mockClear();
  vi.mocked(createPubSub).mockReset();
});

describe('resume', () => {
  it('undoes drain-and-suspend, then clears the record', async () => {
    const w = await world();
    const before = new Map(await Promise.all(PUSHED.map(async (name) => [name, await readPushConfig(w.subscription(name))] as const)));
    await w.suspend();
    w.log.length = 0;
    const requestsBefore = w.requests.length;

    const result = await resume(w.context(), w.ports());

    const restoredPush = [...PUSHED].sort();
    const ensured = [...SWEEPS, STUB_SWEEP];
    expect(w.log).toStrictEqual([
      'get',
      'read sitemonitor',
      ...restoredPush.map((name) => `modifyPushConfig ${name} ${JSON.stringify(savedPush(name))}`),
      ...ALL_TARGETS.map((entry) => controlEntry(entry, 'resume')),
      ...ensured.map((entry) => controlEntry(entry, 'ensure')),
      'restoreAll',
      'clear',
    ]);
    for (const [name, sub] of w.subscriptions) {
      if (PUSHED.includes(name)) {
        expect(sub.modifyPushConfig).toHaveBeenLastCalledWith(before.get(name));
        expect(sub.modifyPushConfig.mock.lastCall?.[0]).toStrictEqual(savedPush(name));
      } else {
        expect(sub.modifyPushConfig).not.toHaveBeenCalled();
      }
    }
    expect(w.requests.slice(requestsBefore)).toStrictEqual([
      ...ALL_TARGETS.map(({ service, queue }) => ({ service, method: 'POST', path: controlPath(queue, 'resume'), json: {}, userToken: null })),
      ...ensured.map(({ service, queue }) => ({ service, method: 'POST', path: controlPath(queue, 'ensure'), json: {}, userToken: null })),
    ]);
    expect(reconcileRecurringQueues).toHaveBeenCalledExactlyOnceWith(w.context().client, {
      serviceUrls: ALL_SERVICES,
      withSiteMonitor: false,
      includeLocalOnly: true,
    });
    expect(w.scheduler.restoreAll).toHaveBeenCalledTimes(1);
    expect(w.pubsub.close).not.toHaveBeenCalled();
    expect(createPubSub).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      resumed: true,
      restoredPush,
      resumedQueues: ALL_TARGETS,
      reconcile: ensured.map(ensuredResult),
      restoredTasks: RESTORED,
      record: CLEARED,
    });
    expect(w.background.stored).toStrictEqual(CLEARED);
  });

  it('touches nothing when the record is not suspended', async () => {
    const w = await world();

    const result = await resume(w.context(untouched('db')), w.ports());

    expect(result).toStrictEqual({
      resumed: false,
      restoredPush: [],
      resumedQueues: [],
      reconcile: null,
      restoredTasks: null,
      record: defaultBackgroundRecord(),
    });
    expect(w.log).toStrictEqual(['get']);
    expect(w.requests).toStrictEqual([]);
    expect(w.pubsub.subscription).not.toHaveBeenCalled();
    expect(reconcileRecurringQueues).not.toHaveBeenCalled();
    expect(w.scheduler.restoreAll).not.toHaveBeenCalled();
    expect(w.clear).not.toHaveBeenCalled();
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it.each<[string, SiteMonitorRecord | null, boolean, boolean]>([
    ['no monitor record', null, false, true],
    ['no native task', monitorRecord({ nativeExisted: false }), false, true],
    ['the monitor still on legacy', monitorRecord({ state: 'legacy' }), false, true],
    ['a target trigger a restoration disabled', monitorRecord({ targetTriggerDisabled: true }), false, false],
    ['the monitor handed off', monitorRecord({}), true, true],
  ])('enables the site-monitor chain per %s', async (_label, monitor, withSiteMonitor, monitorQueueResumed) => {
    const w = await world(monitor);
    w.background.stored = copy(SUSPENDED);

    const result = await resume(w.context(), w.ports());

    const resumedQueues = ALL_TARGETS.filter((entry) => monitorQueueResumed || entry.queue !== SITEMONITOR_QUEUE);
    const ensured = [...(withSiteMonitor ? [MONITOR_CHAIN] : []), ...SWEEPS, STUB_SWEEP];
    expect(reconcileRecurringQueues).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      serviceUrls: ALL_SERVICES,
      withSiteMonitor,
      includeLocalOnly: true,
    });
    expect(result.resumedQueues).toStrictEqual(resumedQueues);
    expect(result.reconcile).toStrictEqual(ensured.map(ensuredResult));
    expect(w.requests.map((request) => `${request.service} ${request.path}`)).toStrictEqual([
      ...resumedQueues.map((entry) => controlEntry(entry, 'resume')),
      ...ensured.map((entry) => controlEntry(entry, 'ensure')),
    ]);
  });

  it('leaves local-only chains out when no local-only queue was paused', async () => {
    const w = await world();
    w.background.stored = { ...copy(SUSPENDED), pausedQueues: ALL_TARGETS.filter((entry) => entry.service !== 'stub') };

    const result = await resume(w.context(), w.ports());

    expect(reconcileRecurringQueues).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      serviceUrls: ALL_SERVICES,
      withSiteMonitor: false,
      includeLocalOnly: false,
    });
    expect(result.reconcile).toStrictEqual(SWEEPS.map(ensuredResult));
  });

  it.each<[string, (w: Awaited<ReturnType<typeof world>>) => void, number, string | typeof ResumeReconcileError]>([
    [
      'failed push restore',
      (w) => {
        w.subscription(PEOPLE_GROUP).modifyPushConfig.mockRejectedValueOnce(new Error('5 NOT_FOUND: Subscription does not exist'));
      },
      0,
      '5 NOT_FOUND: Subscription does not exist',
    ],
    [
      'failed queue resume',
      (w) => {
        w.settings.status = (request) => (request.path === controlPath('surveys-launch', 'resume') ? 500 : 200);
      },
      3,
      'Queue control resume of surveys-launch on communications answered HTTP 500',
    ],
    [
      'chain not ensured',
      (w) => {
        w.settings.status = (request) => (request.path === controlPath('people-outbox-sweep', 'ensure') ? 503 : 200);
      },
      ALL_TARGETS.length + SWEEPS.length + 1,
      ResumeReconcileError,
    ],
    [
      'failed ACF restore',
      (w) => {
        w.scheduler.restoreAll.mockRejectedValueOnce(new Error('scheduler.cfm restore failed'));
      },
      ALL_TARGETS.length + SWEEPS.length + 1,
      'scheduler.cfm restore failed',
    ],
  ])('keeps the record suspended after a %s', async (_label, arrange, requests, failure) => {
    const w = await world();
    w.background.stored = copy(SUSPENDED);
    arrange(w);

    await expect(resume(w.context(), w.ports())).rejects.toThrow(failure);

    expect(w.requests).toHaveLength(requests);
    expect(w.clear).not.toHaveBeenCalled();
    expect(w.background.stored).toStrictEqual(SUSPENDED);
    expect(w.pubsub.close).not.toHaveBeenCalled();
  });

  it('names every chain not ensured', async () => {
    const w = await world();
    w.background.stored = copy(SUSPENDED);
    w.settings.status = (request) => (request.path.endsWith('/ensure') && request.service !== 'identity' ? 503 : 200);

    const failure = await resume(w.context(), w.ports()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ResumeReconcileError);
    expect((failure as ResumeReconcileError).failed.map(({ service, queue }) => ({ service, queue }))).toStrictEqual([
      ...SWEEPS.slice(1),
      STUB_SWEEP,
    ]);
    expect((failure as Error).message).toContain(
      'people-outbox-sweep on people: Queue control ensure of people-outbox-sweep on people answered HTTP 503',
    );
    expect(w.scheduler.restoreAll).not.toHaveBeenCalled();
  });

  it.each<[string, (w: Awaited<ReturnType<typeof world>>) => void, string]>([
    ['a completed run', () => undefined, 'resolved'],
    [
      'a failed run',
      (w) => {
        w.scheduler.restoreAll.mockRejectedValueOnce(new Error('scheduler.cfm restore failed'));
      },
      'Error',
    ],
  ])('closes the Pub/Sub client it created after %s', async (_label, arrange, outcome) => {
    const w = await world();
    w.background.stored = copy(SUSPENDED);
    arrange(w);
    vi.mocked(createPubSub).mockReturnValueOnce(w.pubsub);
    const ctx = w.context();

    const settled = await resume(ctx, w.ports({ pubsub: undefined })).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    );

    expect(settled).toBe(outcome);
    expect(createPubSub).toHaveBeenCalledExactlyOnceWith(ctx.env);
    expect(w.pubsub.close).toHaveBeenCalledTimes(1);
  });
});
