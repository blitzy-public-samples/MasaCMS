// Unit tests for `opt2-ops drain-and-suspend`, using the consumers' contracts, in-memory owners, Pub/Sub, background record, scheduler and service client.
import { dlqReplaySubscriptionName, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse } from '@opt2/platform/migration-kit';
import type { Clock, ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, QUEUES } from '@opt2/platform/tasks';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationEnv } from '../../src/env.js';
import type { DataOwner, OwnersClient, PositionParams } from '../../src/owners/index.js';
import { defaultBackgroundRecord, type BackgroundRecord, type BackgroundStateApi } from '../../src/quiesce/background.js';
import { DrainTimeoutError, type DrainResult } from '../../src/quiesce/drain.js';
import { createPubSub, type PubSubLike, type SavedPushConfig, type SubscriptionLike } from '../../src/quiesce/subscriptions.js';
import {
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
  owners: CONFIG.dataOwners.map((owner) => ({ owner, unpublished: 0, held: 0, pendingReceipts: 0 })),
  polls: 1,
  elapsedMs: 0,
};

const pausePath = (queue: string): string => `${QUEUE_CONTROL_PREFIX}/${queue}/pause`;
const pauseRequest = ({ service, queue }: QueueTarget): ServiceRequest => ({
  service,
  method: 'POST',
  path: pausePath(queue),
  json: {},
  userToken: null,
});
const pauseEntry = ({ service, queue }: QueueTarget): string => `${service} ${pausePath(queue)}`;
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
  /** Unpublished outbox rows per owner; owners not named have no outbox. */
  unpublished?: Partial<Record<DataOwner, number>>;
}

/** Every fake one or more runs share, with one log of their calls in order; a DLQ replay and a foreign subscription are in push mode. */
async function world({ unpublished = {} }: WorldOptions = {}) {
  const log: string[] = [];
  const clock = steppingClock();
  const declared = (await Promise.all(CONFIG.dataOwners.map((owner) => declaredSubscriptions(CONFIG, owner)))).flat().map(({ name }) => name);
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

  const position = (owner: DataOwner, params?: PositionParams): Promise<PositionResponse> => {
    log.push(`position ${owner}`);
    const rows = unpublished[owner];
    return Promise.resolve({
      owner,
      position: '4242',
      outbox: rows === undefined ? null : { tenants: [], unpublished: rows, held: 0 },
      inbox: null,
      ...(params?.publishedTopics === undefined ? {} : { published: [] }),
    });
  };
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });

  const settings: { paused: PauseResult; status: (request: ServiceRequest) => number; inFlight: number; maxInFlight: number } = {
    paused: PAUSED,
    status: () => 200,
    inFlight: 0,
    maxInFlight: 0,
  };
  const requests: ServiceRequest[] = [];
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
      return { status: settings.status(request), headers: {}, body: undefined } as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };

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

  const context = (serviceUrls: Record<string, string> = ALL_SERVICES): DrainAndSuspendContext => ({
    env: { GOOGLE_CLOUD_PROJECT: PROJECT, OPT2_SERVICE_URLS: serviceUrls } as MigrationEnv,
    config: CONFIG,
    clock,
    owners,
    client,
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
  return { log, clock, subscription, pubsub, requests, settings, background, scheduler, sleep, context, ports };
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
  it('drains, stores the plan, then pauses and switches to pull', async () => {
    const w = await world();

    const result = await drainAndSuspend(w.context(), w.ports());

    expect(w.log).toStrictEqual([
      ...CONFIG.dataOwners.map((owner) => `position ${owner}`),
      'get',
      'suspend',
      'pauseAll',
      ...ALL_TARGETS.map(pauseEntry),
      `modifyPushConfig ${PEOPLE_GROUP} {}`,
      `modifyPushConfig ${TIMESHEETS_ARCHIVED} {}`,
      'suspend',
    ]);
    expect(w.background.writes).toStrictEqual([PLANNED, { ...PLANNED, pausedTasks: PAUSED_TASKS }]);
    expect(w.requests).toStrictEqual(ALL_TARGETS.map(pauseRequest));
    expect(w.settings.maxInFlight).toBe(1);
    expect(w.scheduler.pauseAll).toHaveBeenCalledTimes(1);
    expect(w.sleep).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      alreadySuspended: false,
      drained: DRAINED,
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

  it('keeps the saved push configs on a second run', async () => {
    const w = await world();
    await drainAndSuspend(w.context(), w.ports({ reason: 'golden capture' }));
    const first = copy(w.background.stored);
    w.clock.advance(60_000);
    w.subscription(TIMESHEETS_ARCHIVED).state.pushConfig = livePush(TIMESHEETS_ARCHIVED, 'rotated-key');
    w.subscription(FINANCE_SITE).state.pushConfig = livePush(FINANCE_SITE);
    w.settings.paused = { siteMonitor: [], surveys: ['opt2-survey-43-launch'] };

    const result = await drainAndSuspend(w.context({ 'programs-sites': 'http://p', timesheets: 'http://t' }), w.ports());

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
      switchedToPull: [FINANCE_SITE, TIMESHEETS_ARCHIVED],
    });
    expect(w.requests.slice(ALL_TARGETS.length)).toStrictEqual(PROGRAMS_SITES_TARGETS.map(pauseRequest));
    expect(w.subscription(PEOPLE_GROUP).modifyPushConfig).toHaveBeenCalledTimes(1);
    expect(w.subscription(TIMESHEETS_ARCHIVED).modifyPushConfig).toHaveBeenLastCalledWith({});
  });

  it('changes nothing when the drain times out', async () => {
    const w = await world({ unpublished: { people: 2 } });

    const failure = await drainAndSuspend(w.context(), w.ports()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      timeoutMs: CONFIG.transition.drainTimeoutMs,
      owners: [{ owner: 'people', unpublished: 2, held: 0, pendingReceipts: 0 }],
    });
    expect(w.log.filter((entry) => !entry.startsWith('position '))).toStrictEqual([`people ${QUEUE_CONTROL_PREFIX}/people-outbox-sweep/ensure`]);
    expect(w.background.writes).toStrictEqual([]);
    expect(w.scheduler.pauseAll).not.toHaveBeenCalled();
  });

  it.each<[string, (w: Awaited<ReturnType<typeof world>>) => void, number, string]>([
    [
      'failed pauseAll',
      (w) => {
        w.scheduler.pauseAll.mockRejectedValueOnce(new Error('ACF pause failed'));
      },
      0,
      'ACF pause failed',
    ],
    [
      'failed queue pause',
      (w) => {
        w.settings.status = (request) => (request.path === pausePath('surveys-launch') ? 500 : 200);
      },
      3,
      'Queue control pause of surveys-launch on communications answered HTTP 500',
    ],
    [
      'failed push switch',
      (w) => {
        w.subscription(PEOPLE_GROUP).modifyPushConfig.mockRejectedValueOnce(new Error('5 NOT_FOUND: Subscription does not exist'));
      },
      ALL_TARGETS.length,
      '5 NOT_FOUND: Subscription does not exist',
    ],
  ])('propagates a %s with the plan stored', async (_label, arrange, pauses, message) => {
    const w = await world();
    arrange(w);

    await expect(drainAndSuspend(w.context(), w.ports())).rejects.toThrow(message);

    expect(w.background.writes).toStrictEqual([PLANNED]);
    expect(w.requests).toStrictEqual(ALL_TARGETS.slice(0, pauses).map(pauseRequest));
    expect(w.subscription(TIMESHEETS_ARCHIVED).modifyPushConfig).not.toHaveBeenCalled();
    expect(w.pubsub.close).not.toHaveBeenCalled();
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
