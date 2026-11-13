// Unit tests for `opt2-ops drain-and-suspend`, using the consumers' contracts, in-memory owners, Pub/Sub, background record, scheduler and service client.
import { dlqReplaySubscriptionName, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse, PublishedEvent } from '@opt2/platform/migration-kit';
import type { Clock, ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, QUEUES, type QueueControlResult } from '@opt2/platform/tasks';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { GatewayWaitTimeoutError, type CutoverStatus, type GatewayClient, type InflightRow } from '../../src/cutover/gateway-client.js';
import type { MigrationEnv } from '../../src/env.js';
import type { DataOwner, OwnersClient, PositionParams } from '../../src/owners/index.js';
import { defaultBackgroundRecord, type BackgroundRecord, type BackgroundStateApi } from '../../src/quiesce/background.js';
import { DEFAULT_DRAIN_POLL_MS, DrainTimeoutError, type DrainResult } from '../../src/quiesce/drain.js';
import { createPubSub, type PubSubLike, type SavedPushConfig, type SubscriptionLike } from '../../src/quiesce/subscriptions.js';
import {
  InvocationsRunningError,
  OrphanedWritesError,
  drainAndSuspend,
  queueControlTargets,
  type DrainAndSuspendContext,
  type DrainAndSuspendOptions,
  type QueueTarget,
} from '../../src/quiesce/suspend.js';
import { declaredSubscriptions } from '../../src/quiesce/topology.js';
import type { PauseResult } from '../../src/scheduler/index.js';

vi.mock('../../src/quiesce/subscriptions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/quiesce/subscriptions.js')>();
  return { ...actual, createPubSub: vi.fn() };
});

const CONFIG = loadConfig();
const PROJECT = 'opt2-unit';
const SUBSCRIPTION_PREFIX = `projects/${PROJECT}/subscriptions/`;
const START = businessClock().now().getTime();
const NOW = new Date(START).toISOString();
const PEOPLE_GROUP = subscriptionName('people', 'identity.group.changed.v1');
const TIMESHEETS_ARCHIVED = subscriptionName('timesheets', 'people.person.archived.v1');
const FINANCE_SITE = subscriptionName('finance', 'programs-sites.site.changed.v1');
const DLQ_REPLAY = dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED);
const FOREIGN = 'legacy-mail-queue';
/** Declared subscriptions in push mode; the other declared ones are in pull mode. */
const PUSHED = [PEOPLE_GROUP, TIMESHEETS_ARCHIVED];
const MONITOR_TASK = '/var/www/index.cfm/_api/sitemonitor/';
const PAUSED: PauseResult = {
  siteMonitor: [MONITOR_TASK],
  surveys: ['opt2-survey-42-reminder-1', 'opt2-survey-41-launch', 'opt2-survey-41-launch'],
};
const PAUSED_TASKS = [MONITOR_TASK, 'opt2-survey-41-launch', 'opt2-survey-42-reminder-1'];

/** Callee URLs of every target service, in no particular order. */
const ALL_SERVICES: Record<string, string> = {
  timesheets: 'http://127.0.0.1:20118',
  'programs-sites': 'http://127.0.0.1:20113',
  stub: 'http://127.0.0.1:20199',
  identity: 'http://127.0.0.1:20111',
  surveys: 'http://127.0.0.1:20117',
  'strategies-content': 'http://127.0.0.1:20114',
  people: 'http://127.0.0.1:20112',
  finance: 'http://127.0.0.1:20119',
  reporting: 'http://127.0.0.1:20116',
  communications: 'http://127.0.0.1:20115',
  'e-signature': 'http://127.0.0.1:20120',
};

const target = (service: string, queue: string): QueueTarget => ({ service, queue });
const PROGRAMS_SITES_TARGETS = [
  target('programs-sites', 'content-feed-import'),
  target('programs-sites', 'content-scheduled-publish'),
  target('programs-sites', 'programs-sites-outbox-sweep'),
  target('programs-sites', 'programs-sites-sitemonitor'),
];
/** Every creator of every registry queue, sorted by service, then queue. */
const ALL_TARGETS = [
  target('communications', 'communications-outbox-sweep'),
  target('communications', 'communications-reminders'),
  target('communications', 'surveys-launch'),
  target('identity', 'identity-outbox-sweep'),
  target('people', 'people-outbox-sweep'),
  ...PROGRAMS_SITES_TARGETS,
  target('reporting', 'reporting-export-run'),
  target('strategies-content', 'content-scheduled-publish'),
  target('stub', 'stub-outbox-sweep'),
  target('surveys', 'surveys-outbox-sweep'),
];
const isSweepTarget = ({ queue }: QueueTarget): boolean => queue.endsWith('-outbox-sweep');
/** Queues paused first, while the sweeps keep publishing. */
const PRODUCER_TARGETS = ALL_TARGETS.filter((entry) => !isSweepTarget(entry));
/** Sweep queues, paused once the final drain is done. */
const SWEEP_TARGETS = ALL_TARGETS.filter(isSweepTarget);
/** Drained owners when every service is deployed: the data owners, then the stub. */
const PARTICIPANTS: DataOwner[] = [...CONFIG.dataOwners, 'stub'];
const NOTE_CREATED = 'stub.note.created.v1';
const NOTE_EVENT = 'd0000000-0000-4000-8000-00000000000d';
const TENANT = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const LIVE_GATEWAY = 'gateway-live';
const DEAD_GATEWAY = 'gateway-dead';
const MONITOR_ROUTE = 'job:/_api/sitemonitor/';
const inflightRow = (instanceId: string, route: string): InflightRow => ({ instanceId, route, side: 'legacy', count: 1, oldestStartedAt: NOW });
/** Gateway status with one live and one dead instance and the given in-flight rows. */
const cutoverStatus = (inflight: InflightRow[]): CutoverStatus => ({
  tableVersion: 'v0001',
  previous: null,
  epoch: 1,
  groupAuthority: {},
  frozen: [],
  instances: [
    { instanceId: LIVE_GATEWAY, seenEpoch: 1, heartbeatAt: NOW, live: true },
    { instanceId: DEAD_GATEWAY, seenEpoch: 1, heartbeatAt: NOW, live: false },
  ],
  acknowledgedEpoch: 1,
  inflight,
  sessionMode: 'legacy-primary',
});

const endpoint = (name: string): string => `http://127.0.0.1:20118/internal/v1/events/${name}`;
/** Push config as Pub/Sub reports it: the local endpoint with its push key, and null oneof members. */
const livePush = (name: string, key = 'unit-push-key') => ({
  pushEndpoint: `${endpoint(name)}?key=${key}`,
  attributes: { 'x-goog-version': 'v1' },
  oidcToken: null,
  noWrapper: { writeMetadata: false },
  wrapper: 'noWrapper',
});
/** What drain-and-suspend saves of `livePush(name)`. */
const savedPush = (name: string): SavedPushConfig => ({
  pushEndpoint: `${endpoint(name)}?key=unit-push-key`,
  attributes: { 'x-goog-version': 'v1' },
  noWrapper: { writeMetadata: false },
  wrapper: 'noWrapper',
});
const PULL = { pushEndpoint: '', attributes: {}, oidcToken: null };

/** The record the first run stores before it changes anything. */
const PLANNED: BackgroundRecord = {
  suspended: true,
  since: NOW,
  reason: 'drain-and-suspend',
  pushConfigs: { [PEOPLE_GROUP]: savedPush(PEOPLE_GROUP), [TIMESHEETS_ARCHIVED]: savedPush(TIMESHEETS_ARCHIVED) },
  pausedQueues: ALL_TARGETS,
  pausedTasks: [],
};
const DRAINED: DrainResult = {
  owners: PARTICIPANTS.map((owner) => ({ owner, unpublished: 0, held: 0, pendingReceipts: 0 })),
  polls: 1,
  elapsedMs: 0,
};
const DRAIN_LOG = PARTICIPANTS.map((owner) => `position ${owner}`);

const pausePath = (queue: string): string => `${QUEUE_CONTROL_PREFIX}/${queue}/pause`;
const pauseRequest = ({ service, queue }: QueueTarget): ServiceRequest => ({
  service,
  method: 'POST',
  path: pausePath(queue),
  json: {},
  userToken: null,
});
const pauseEntry = ({ service, queue }: QueueTarget): string => `${service} ${pausePath(queue)}`;
const controlEntry = ({ service, queue }: QueueTarget, op: string): string => `${service} ${QUEUE_CONTROL_PREFIX}/${queue}/${op}`;
/** Log of the barrier with nothing running or in flight: producer pauses, gateway read, final drain, confirmation, sweep pauses. */
const quietBarrierLog = (producers: readonly QueueTarget[], sweeps: readonly QueueTarget[], drain: readonly string[] = DRAIN_LOG): string[] => [
  ...producers.map(pauseEntry),
  'gateway status',
  ...drain,
  ...producers.map(pauseEntry),
  'gateway status',
  ...sweeps.map(pauseEntry),
];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Port that fails the test when any member is read; drain-and-suspend reaches it only through defaults these tests replace. */
function untouched<K extends 'catalog' | 'db' | 'bridge' | 'logger'>(port: K): DrainAndSuspendContext[K] {
  return new Proxy({} as DrainAndSuspendContext[K], {
    get(_target, member) {
      throw new Error(`${port}.${String(member)} was read`);
    },
  });
}

/** Clock that stands still at noon of the business date until `advance` moves it. */
function steppingClock(start = START): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** In-memory subscription whose push config `modifyPushConfig` replaces; each change is logged. */
function fakeSubscription(log: string[], id: string, pushConfig: unknown) {
  const state = { pushConfig };
  return {
    name: `${SUBSCRIPTION_PREFIX}${id}`,
    state,
    getMetadata: () => Promise.resolve<[{ pushConfig?: unknown }]>([{ pushConfig: state.pushConfig }]),
    modifyPushConfig: vi.fn<(config: SavedPushConfig) => Promise<unknown>>((config) => {
      log.push(`modifyPushConfig ${id} ${JSON.stringify(config)}`);
      state.pushConfig = config;
      return Promise.resolve([{}]);
    }),
    seek: () => Promise.reject(new Error('seek was called')),
  } satisfies SubscriptionLike & { state: { pushConfig: unknown } };
}

interface WorldOptions {
  /** Unpublished outbox rows per owner; owners not named have no outbox. Tests may change it during a run. */
  unpublished?: Partial<Record<DataOwner, number>>;
}

/** Every fake one or more runs share, with one log of their calls in order; a DLQ replay and a foreign subscription are in push mode. */
async function world({ unpublished = {} }: WorldOptions = {}) {
  const log: string[] = [];
  const clock = steppingClock();
  const declared = (await Promise.all(PARTICIPANTS.map((owner) => declaredSubscriptions(CONFIG, owner)))).flat().map(({ name }) => name);
  const subscriptions = new Map(
    [...declared, DLQ_REPLAY, FOREIGN].map((id) => [id, fakeSubscription(log, id, declared.includes(id) && !PUSHED.includes(id) ? PULL : livePush(id))]),
  );
  const subscription = (id: string): ReturnType<typeof fakeSubscription> => {
    const found = subscriptions.get(id);
    if (found === undefined) throw new Error(`No subscription ${id}`);
    return found;
  };
  const pubsub = {
    projectId: PROJECT,
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([[...subscriptions.values()]]),
    subscription: (name: string): SubscriptionLike => {
      throw new Error(`subscription(${name}) was called`);
    },
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  } satisfies PubSubLike;

  /** Events each owner lists as published and the inbox receipts of each consumer by event id; tests change them during a run. */
  const events = {
    published: {} as Partial<Record<DataOwner, PublishedEvent[]>>,
    receipts: {} as Partial<Record<DataOwner, Record<string, string[]>>>,
  };
  const position = (owner: DataOwner, params?: PositionParams): Promise<PositionResponse> => {
    log.push(params?.eventIds === undefined ? `position ${owner}` : `receipts ${owner} ${params.eventIds.join(' ')}`);
    const rows = unpublished[owner];
    const topics = params?.publishedTopics;
    const asked = params?.eventIds;
    return Promise.resolve({
      owner,
      position: '4242',
      outbox: rows === undefined ? null : { tenants: [], unpublished: rows, held: 0 },
      inbox:
        asked === undefined
          ? null
          : { total: 0, bySubscription: {}, receipts: Object.fromEntries(asked.map((id) => [id, events.receipts[owner]?.[id] ?? []])) },
      ...(topics === undefined ? {} : { published: (events.published[owner] ?? []).filter(({ topic }) => topics.includes(topic)) }),
    });
  };
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });

  const settings: {
    paused: PauseResult;
    status: (request: ServiceRequest) => number;
    /** Running tasks a pause of the target answers, its call count included; undefined leaves the count out. */
    running: (target: QueueTarget, calls: number) => number | undefined;
    /** Runs on each queue-control request before it is answered. */
    onRequest: (request: ServiceRequest) => void;
    inFlight: number;
    maxInFlight: number;
  } = {
    paused: PAUSED,
    status: () => 200,
    running: () => 0,
    onRequest: () => undefined,
    inFlight: 0,
    maxInFlight: 0,
  };
  const requests: ServiceRequest[] = [];
  const pauses = new Map<string, number>();
  /** The queue-control answer the creating service gives. */
  const answer = (request: ServiceRequest): QueueControlResult => {
    const [, queue = '', op = ''] = /\/([^/]+)\/([^/]+)$/.exec(request.path) ?? [];
    const { service } = request;
    if (op === 'ensure') return { queue, service, ensured: { queue, name: `${queue}-1782820800`, created: false, reason: 'live' } };
    if (op === 'resume') return { queue, service, paused: false };
    const key = `${service} ${queue}`;
    pauses.set(key, (pauses.get(key) ?? 0) + 1);
    const running = settings.running({ service, queue }, pauses.get(key) ?? 0);
    return { queue, service, paused: true, ...(running === undefined ? {} : { running }) };
  };
  const client: ServiceClient = {
    async request<T>(request: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(request);
      log.push(`${request.service} ${request.path}`);
      settings.inFlight += 1;
      settings.maxInFlight = Math.max(settings.maxInFlight, settings.inFlight);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      settings.inFlight -= 1;
      settings.onRequest(request);
      return { status: settings.status(request), headers: {}, body: answer(request) } as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };

  /** Status the gateway answers; `settle` runs when a wait for in-flight writes is asked, which then answers the awaited routes' dead-instance rows. */
  const gatewayState = { status: cutoverStatus([]), settle: (): void => undefined };
  const awaitInflightDrained = vi.fn<GatewayClient['awaitInflightDrained']>((routes) => {
    log.push(`gateway awaitInflightDrained ${routes.join(' ')}`);
    gatewayState.settle();
    const { instances, inflight } = copy(gatewayState.status);
    const live = new Set(instances.filter((instance) => instance.live).map((instance) => instance.instanceId));
    return Promise.resolve({ orphans: inflight.filter((row) => routes.includes(row.route) && !live.has(row.instanceId)) });
  });
  const gatewayStatus = (): Promise<CutoverStatus> => {
    log.push('gateway status');
    return Promise.resolve(copy(gatewayState.status));
  };
  const gateway = new Proxy({} as GatewayClient, {
    get(_target, member) {
      if (member === 'status') return gatewayStatus;
      if (member === 'awaitInflightDrained') return awaitInflightDrained;
      throw new Error(`gateway.${String(member)} was read`);
    },
  });

  /** Stored record and every write, each a JSON copy as jsonb keeps it. */
  const background = { stored: defaultBackgroundRecord(), writes: [] as BackgroundRecord[] };
  const backgroundApi: BackgroundStateApi = {
    isSuspended: () => Promise.resolve(background.stored.suspended),
    get: () => {
      log.push('get');
      return Promise.resolve(copy(background.stored));
    },
    suspend: (record) => {
      log.push('suspend');
      background.stored = copy({ ...record, suspended: true, since: record.since ?? clock.now().toISOString() });
      background.writes.push(copy(background.stored));
      return Promise.resolve(copy(background.stored));
    },
    resume: () => Promise.reject(new Error('resume was called')),
  };
  const scheduler = {
    pauseAll: vi.fn<() => Promise<PauseResult>>(() => {
      log.push('pauseAll');
      return Promise.resolve(settings.paused);
    }),
  };
  // One pause moves the clock past the drain budget.
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => {
    clock.advance(CONFIG.transition.drainTimeoutMs);
    return Promise.resolve();
  });
  // Each pause moves the clock by the time asked.
  const shortSleep = vi.fn<(ms: number) => Promise<void>>((ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });

  const context = (serviceUrls: Record<string, string> = ALL_SERVICES): DrainAndSuspendContext => ({
    env: { GOOGLE_CLOUD_PROJECT: PROJECT, OPT2_SERVICE_URLS: serviceUrls } as MigrationEnv,
    config: CONFIG,
    clock,
    owners,
    client,
    gateway,
    catalog: untouched('catalog'),
    db: untouched('db'),
    bridge: untouched('bridge'),
    logger: untouched('logger'),
    clientAs: () => {
      throw new Error('clientAs was called');
    },
  });
  const ports = (extra: DrainAndSuspendOptions = {}): DrainAndSuspendOptions => ({
    background: backgroundApi,
    pubsub,
    scheduler,
    sleep,
    ...extra,
  });
  return {
    log,
    clock,
    subscription,
    pubsub,
    events,
    unpublished,
    requests,
    settings,
    gatewayState,
    awaitInflightDrained,
    background,
    scheduler,
    sleep,
    shortSleep,
    context,
    ports,
  };
}

afterEach(() => {
  vi.mocked(createPubSub).mockReset();
});

describe('queueControlTargets', () => {
  it.each<[string, Record<string, string>, QueueTarget[]]>([
    ['every creator', ALL_SERVICES, ALL_TARGETS],
    [
      'present creators only',
      { timesheets: 'http://t', reporting: 'http://r', 'programs-sites': 'http://p' },
      [...PROGRAMS_SITES_TARGETS, target('reporting', 'reporting-export-run')],
    ],
    ['no creator', { timesheets: 'http://t', finance: 'http://f' }, []],
  ])('targets %s', (_label, serviceUrls, expected) => {
    expect(queueControlTargets(serviceUrls)).toStrictEqual(expected);
  });

  it('covers each registry queue once per creator', () => {
    const targets = queueControlTargets(ALL_SERVICES);

    expect(new Set(targets.map(({ queue }) => queue))).toStrictEqual(new Set(Object.keys(QUEUES)));
    expect(new Set(targets.map((entry) => JSON.stringify(entry))).size).toBe(targets.length);
    expect(targets).toHaveLength(Object.values(QUEUES).reduce((sum, def) => sum + def.creators.length, 0));
  });
});

describe('drainAndSuspend', () => {
  it('drains, stores the plan, stops producers, drains again, then pauses the sweeps and switches to pull', async () => {
    const w = await world();

    const result = await drainAndSuspend(w.context(), w.ports());

    expect(w.log).toStrictEqual([
      'get',
      ...DRAIN_LOG,
      'gateway status',
      'suspend',
      'pauseAll',
      ...quietBarrierLog(PRODUCER_TARGETS, SWEEP_TARGETS),
      `modifyPushConfig ${PEOPLE_GROUP} {}`,
      `modifyPushConfig ${TIMESHEETS_ARCHIVED} {}`,
      'suspend',
    ]);
    expect(w.background.writes).toStrictEqual([PLANNED, { ...PLANNED, pausedTasks: PAUSED_TASKS }]);
    expect(w.requests).toStrictEqual([...PRODUCER_TARGETS, ...PRODUCER_TARGETS, ...SWEEP_TARGETS].map(pauseRequest));
    expect(w.settings.maxInFlight).toBe(1);
    expect(w.scheduler.pauseAll).toHaveBeenCalledTimes(1);
    expect(w.sleep).not.toHaveBeenCalled();
    expect(w.awaitInflightDrained).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      alreadySuspended: false,
      drained: DRAINED,
      finalDrained: DRAINED,
      pausedTasks: PAUSED_TASKS,
      pausedQueues: ALL_TARGETS,
      switchedToPull: [PEOPLE_GROUP, TIMESHEETS_ARCHIVED],
      record: {
        ...PLANNED,
        pausedTasks: PAUSED_TASKS,
        pushConfigs: {
          [PEOPLE_GROUP]: { ...savedPush(PEOPLE_GROUP), pushEndpoint: endpoint(PEOPLE_GROUP) },
          [TIMESHEETS_ARCHIVED]: { ...savedPush(TIMESHEETS_ARCHIVED), pushEndpoint: endpoint(TIMESHEETS_ARCHIVED) },
        },
      },
    });
    expect(w.pubsub.close).not.toHaveBeenCalled();
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it('reopens the sweeps and saved push delivery of a suspended record before draining, keeps the saved configs and suspends again', async () => {
    const w = await world();
    await drainAndSuspend(w.context(), w.ports({ reason: 'golden capture' }));
    const first = copy(w.background.stored);
    w.clock.advance(60_000);
    w.subscription(TIMESHEETS_ARCHIVED).state.pushConfig = livePush(TIMESHEETS_ARCHIVED, 'rotated-key');
    w.subscription(FINANCE_SITE).state.pushConfig = livePush(FINANCE_SITE);
    w.settings.paused = { siteMonitor: [], surveys: ['opt2-survey-43-launch'] };
    w.log.length = 0;
    const requestsBefore = w.requests.length;

    const result = await drainAndSuspend(w.context({ 'programs-sites': 'http://p', timesheets: 'http://t' }), w.ports());

    const drainLog = CONFIG.dataOwners.map((owner) => `position ${owner}`);
    expect(w.log).toStrictEqual([
      'get',
      ...SWEEP_TARGETS.map((entry) => controlEntry(entry, 'resume')),
      `modifyPushConfig ${PEOPLE_GROUP} ${JSON.stringify(savedPush(PEOPLE_GROUP))}`,
      ...drainLog,
      'gateway status',
      'suspend',
      'pauseAll',
      ...quietBarrierLog(
        PROGRAMS_SITES_TARGETS.filter((entry) => !isSweepTarget(entry)),
        PROGRAMS_SITES_TARGETS.filter(isSweepTarget),
        drainLog,
      ),
      `modifyPushConfig ${FINANCE_SITE} {}`,
      `modifyPushConfig ${PEOPLE_GROUP} {}`,
      `modifyPushConfig ${TIMESHEETS_ARCHIVED} {}`,
      'suspend',
    ]);
    expect(w.requests.slice(requestsBefore).filter((request) => request.path.endsWith('/resume'))).toHaveLength(SWEEP_TARGETS.length);

    const planned: BackgroundRecord = {
      ...PLANNED,
      reason: 'golden capture',
      pushConfigs: { ...PLANNED.pushConfigs, [FINANCE_SITE]: savedPush(FINANCE_SITE) },
      pausedTasks: PAUSED_TASKS,
    };
    expect(w.background.writes.slice(2)).toStrictEqual([planned, { ...planned, pausedTasks: [...PAUSED_TASKS, 'opt2-survey-43-launch'] }]);
    for (const write of w.background.writes.slice(2)) {
      for (const name of [PEOPLE_GROUP, TIMESHEETS_ARCHIVED]) {
        expect(JSON.stringify(write.pushConfigs[name])).toBe(JSON.stringify(first.pushConfigs[name]));
      }
    }
    expect(result).toMatchObject({
      alreadySuspended: true,
      pausedTasks: ['opt2-survey-43-launch'],
      pausedQueues: PROGRAMS_SITES_TARGETS,
      switchedToPull: [FINANCE_SITE, PEOPLE_GROUP, TIMESHEETS_ARCHIVED],
    });
    expect(w.subscription(PEOPLE_GROUP).modifyPushConfig.mock.calls).toStrictEqual([[{}], [savedPush(PEOPLE_GROUP)], [{}]]);
    expect(w.subscription(TIMESHEETS_ARCHIVED).modifyPushConfig).toHaveBeenLastCalledWith({});
  });

  it('changes nothing when the first drain of a first run times out', async () => {
    const w = await world({ unpublished: { people: 2 } });

    const failure = await drainAndSuspend(w.context(), w.ports()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      timeoutMs: CONFIG.transition.drainTimeoutMs,
      owners: [{ owner: 'people', unpublished: 2, held: 0, pendingReceipts: 0 }],
    });
    expect(w.log.filter((entry) => !entry.startsWith('position '))).toStrictEqual(['get', `people ${QUEUE_CONTROL_PREFIX}/people-outbox-sweep/ensure`]);
    expect(w.background.writes).toStrictEqual([]);
    expect(w.scheduler.pauseAll).not.toHaveBeenCalled();
  });

  it('re-pauses a queue still running tasks until it reports none, then drains again', async () => {
    const w = await world();
    const reporting = target('reporting', 'reporting-export-run');
    w.settings.running = ({ queue }, calls) => (queue === reporting.queue && calls === 1 ? 2 : 0);

    const result = await drainAndSuspend(w.context(), w.ports({ sleep: w.shortSleep }));

    const pausedAll = w.log.indexOf('pauseAll');
    expect(w.log.slice(pausedAll + 1, w.log.indexOf('gateway status', pausedAll))).toStrictEqual([
      ...PRODUCER_TARGETS.map(pauseEntry),
      pauseEntry(reporting),
    ]);
    expect(w.shortSleep.mock.calls).toStrictEqual([[DEFAULT_DRAIN_POLL_MS]]);
    expect(result.finalDrained).toStrictEqual(DRAINED);
    expect(w.background.stored.pausedTasks).toStrictEqual(PAUSED_TASKS);
  });

  it('waits for a producer commit that lands after the first drain: its sweep publishes it and its consumer applies it before push stops', async () => {
    const w = await world({ unpublished: {} });
    // The held stub note commits once its ACF and queue producers are stopped; no in-request flush publishes it.
    w.scheduler.pauseAll.mockImplementationOnce(() => {
      w.log.push('pauseAll');
      w.unpublished.stub = 1;
      return Promise.resolve(PAUSED);
    });
    w.settings.onRequest = (request) => {
      if (request.path !== `${QUEUE_CONTROL_PREFIX}/stub-outbox-sweep/ensure`) return;
      w.unpublished.stub = 0;
      w.events.published.stub = [{ eventId: NOTE_EVENT, topic: NOTE_CREATED, tenantId: TENANT }];
      w.events.receipts.stub = { [NOTE_EVENT]: [TENANT] };
    };

    const result = await drainAndSuspend(w.context(), w.ports({ sleep: w.shortSleep }));

    const at = (entry: string): number => w.log.indexOf(entry);
    const ensure = controlEntry(target('stub', 'stub-outbox-sweep'), 'ensure');
    expect(at('pauseAll')).toBeLessThan(at(ensure));
    expect(at(ensure)).toBeLessThan(at(`receipts stub ${NOTE_EVENT}`));
    expect(at(`receipts stub ${NOTE_EVENT}`)).toBeLessThan(at(pauseEntry(target('stub', 'stub-outbox-sweep'))));
    expect(at(pauseEntry(target('stub', 'stub-outbox-sweep')))).toBeLessThan(at(`modifyPushConfig ${PEOPLE_GROUP} {}`));
    expect(result.drained).toStrictEqual(DRAINED);
    expect(result.finalDrained).toMatchObject({ owners: DRAINED.owners, polls: 3 });
    expect(w.shortSleep.mock.calls).toStrictEqual([[DEFAULT_DRAIN_POLL_MS], [DEFAULT_DRAIN_POLL_MS]]);
  });

  it('waits for the live in-flight writes of the gateway before the final drain', async () => {
    const w = await world();
    w.gatewayState.status = cutoverStatus([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE)]);
    w.gatewayState.settle = () => {
      w.gatewayState.status = cutoverStatus([]);
    };

    const result = await drainAndSuspend(w.context(), w.ports());

    expect(w.awaitInflightDrained).toHaveBeenCalledExactlyOnceWith([MONITOR_ROUTE], {
      timeoutMs: CONFIG.transition.drainTimeoutMs,
      intervalMs: DEFAULT_DRAIN_POLL_MS,
    });
    const waited = w.log.indexOf(`gateway awaitInflightDrained ${MONITOR_ROUTE}`);
    expect(w.log.slice(waited + 1, waited + 1 + DRAIN_LOG.length)).toStrictEqual(DRAIN_LOG);
    expect(waited).toBeLessThan(w.log.indexOf(`modifyPushConfig ${PEOPLE_GROUP} {}`));
    expect(result.switchedToPull).toStrictEqual(PUSHED);
  });

  it.each<[string, InflightRow]>([
    ['legacy-bound native task run', inflightRow(DEAD_GATEWAY, MONITOR_ROUTE)],
    ['target-bound write', { ...inflightRow(DEAD_GATEWAY, 'admin:carch.update'), side: 'target', count: 2 }],
  ])('changes nothing on a first run when a dead instance holds a %s after the first drain', async (_label, orphan) => {
    const w = await world();
    w.gatewayState.status = cutoverStatus([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE), orphan]);

    const failure = await drainAndSuspend(w.context(), w.ports()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OrphanedWritesError);
    expect(failure).toMatchObject({
      name: 'OrphanedWritesError',
      message: `In-flight writes of dead gateway instances clear only with legacy-restart or gates-closed evidence: ${DEAD_GATEWAY} ${orphan.side} ${orphan.route} (${String(orphan.count)} since ${NOW})`,
      rows: [orphan],
    });
    expect(w.log).toStrictEqual(['get', ...DRAIN_LOG, 'gateway status']);
    expect(w.background.writes).toStrictEqual([]);
    expect(w.scheduler.pauseAll).not.toHaveBeenCalled();
    expect(w.requests).toStrictEqual([]);
    expect(w.awaitInflightDrained).not.toHaveBeenCalled();
  });

  it.each<[string, (w: Awaited<ReturnType<typeof world>>) => void, QueueTarget[], string | Error | (new (...args: never[]) => Error)]>([
    [
      'failed pauseAll',
      (w) => {
        w.scheduler.pauseAll.mockRejectedValueOnce(new Error('ACF pause failed'));
      },
      [],
      'ACF pause failed',
    ],
    [
      'failed queue pause',
      (w) => {
        w.settings.status = (request) => (request.path === pausePath('surveys-launch') ? 500 : 200);
      },
      PRODUCER_TARGETS.slice(0, 2),
      'Queue control pause of surveys-launch on communications answered HTTP 500',
    ],
    [
      'pause answer without a running count',
      (w) => {
        w.settings.running = ({ queue }) => (queue === 'content-feed-import' ? undefined : 0);
      },
      PRODUCER_TARGETS.slice(0, 3),
      'Queue control pause of content-feed-import on programs-sites answered without its running tasks',
    ],
    [
      'queue running tasks past the barrier budget',
      (w) => {
        w.settings.running = ({ queue }) => (queue === 'reporting-export-run' ? 1 : 0);
      },
      [...PRODUCER_TARGETS, target('reporting', 'reporting-export-run')],
      InvocationsRunningError,
    ],
    [
      'live in-flight write left at the barrier deadline',
      (w) => {
        w.gatewayState.status = cutoverStatus([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE)]);
        // Each wait outlasts the budget, and another write starts before the confirming read.
        w.gatewayState.settle = () => {
          w.clock.advance(CONFIG.transition.drainTimeoutMs);
        };
      },
      [...PRODUCER_TARGETS, ...PRODUCER_TARGETS],
      GatewayWaitTimeoutError,
    ],
    [
      'dead instance’s in-flight write found before the final drain',
      (w) => {
        w.scheduler.pauseAll.mockImplementationOnce(() => {
          w.gatewayState.status = cutoverStatus([inflightRow(DEAD_GATEWAY, MONITOR_ROUTE)]);
          return Promise.resolve(PAUSED);
        });
      },
      PRODUCER_TARGETS,
      new OrphanedWritesError([inflightRow(DEAD_GATEWAY, MONITOR_ROUTE)]),
    ],
    [
      'live in-flight write whose instance dies during the wait',
      (w) => {
        w.gatewayState.status = cutoverStatus([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE)]);
        w.gatewayState.settle = () => {
          w.gatewayState.status.instances = w.gatewayState.status.instances.map((instance) => ({ ...instance, live: false }));
        };
      },
      PRODUCER_TARGETS,
      new OrphanedWritesError([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE)]),
    ],
    [
      'dead instance’s in-flight write found by the confirming read',
      (w) => {
        w.gatewayState.status = cutoverStatus([inflightRow(LIVE_GATEWAY, MONITOR_ROUTE)]);
        w.gatewayState.settle = () => {
          w.gatewayState.status = cutoverStatus([inflightRow(DEAD_GATEWAY, 'admin:carch.update')]);
        };
      },
      [...PRODUCER_TARGETS, ...PRODUCER_TARGETS],
      new OrphanedWritesError([inflightRow(DEAD_GATEWAY, 'admin:carch.update')]),
    ],
    [
      'failed push switch',
      (w) => {
        w.subscription(PEOPLE_GROUP).modifyPushConfig.mockRejectedValueOnce(new Error('5 NOT_FOUND: Subscription does not exist'));
      },
      [...PRODUCER_TARGETS, ...PRODUCER_TARGETS, ...SWEEP_TARGETS],
      '5 NOT_FOUND: Subscription does not exist',
    ],
  ])('propagates a %s with the plan stored and push delivery untouched', async (_label, arrange, pauses, failure) => {
    const w = await world();
    arrange(w);

    await expect(drainAndSuspend(w.context(), w.ports())).rejects.toThrow(failure);

    expect(w.background.writes).toStrictEqual([PLANNED]);
    expect(w.requests).toStrictEqual(pauses.map(pauseRequest));
    expect(w.subscription(TIMESHEETS_ARCHIVED).modifyPushConfig).not.toHaveBeenCalled();
    expect(w.pubsub.close).not.toHaveBeenCalled();
  });

  it('names each queue still running tasks and the budget in InvocationsRunningError', async () => {
    const w = await world();
    w.settings.running = ({ queue }) => (queue === 'reporting-export-run' || queue === 'surveys-launch' ? 3 : 0);

    const failure = await drainAndSuspend(w.context(), w.ports()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvocationsRunningError);
    expect(failure).toMatchObject({
      name: 'InvocationsRunningError',
      message: `tasks still running after ${String(CONFIG.transition.drainTimeoutMs)} ms: surveys-launch on communications (3), reporting-export-run on reporting (3)`,
      timeoutMs: CONFIG.transition.drainTimeoutMs,
      queues: [
        { service: 'communications', queue: 'surveys-launch', running: 3 },
        { service: 'reporting', queue: 'reporting-export-run', running: 3 },
      ],
    });
    expect(w.sleep).toHaveBeenCalledExactlyOnceWith(DEFAULT_DRAIN_POLL_MS);
  });

  it.each<[string, WorldOptions, string]>([
    ['a completed run', {}, 'resolved'],
    ['a drain timeout', { unpublished: { people: 1 } }, 'DrainTimeoutError'],
  ])('closes the Pub/Sub client it created after %s', async (_label, options, outcome) => {
    const w = await world(options);
    vi.mocked(createPubSub).mockReturnValueOnce(w.pubsub);
    const ctx = w.context();

    const settled = await drainAndSuspend(ctx, w.ports({ pubsub: undefined })).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    );

    expect(settled).toBe(outcome);
    expect(createPubSub).toHaveBeenCalledExactlyOnceWith(ctx.env);
    expect(w.pubsub.close).toHaveBeenCalledTimes(1);
  });
});
