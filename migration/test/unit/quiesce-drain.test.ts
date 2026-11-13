// Unit tests for the drain barrier, using the consumers' contracts, in-memory owners, Pub/Sub, service client and unit catalog, and a stepping clock.
import { setTimeout as delay } from 'node:timers/promises';

import { dlqReplaySubscriptionName, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse, PublishedEvent } from '@opt2/platform/migration-kit';
import type { Clock, ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, outboxSweepQueue } from '@opt2/platform/tasks';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationEnv } from '../../src/env.js';
import { UnknownUnitError } from '../../src/owners/index.js';
import type { DataOwner, OwnersClient, PositionParams, UnitCatalog } from '../../src/owners/index.js';
import {
  DEFAULT_DRAIN_POLL_MS,
  DrainTimeoutError,
  MissingSubscriptionError,
  RECEIPT_QUERY_MAX_IDS,
  UnlistedProducerError,
  awaitDrained,
  drainParticipants,
  isDrained,
  ownerDrainCounts,
} from '../../src/quiesce/drain.js';
import type { AwaitDrainedOptions, DrainContext, DrainResult, DrainRole, OwnerDrainCounts } from '../../src/quiesce/drain.js';
import { createPubSub, type PubSubLike, type SubscriptionLike } from '../../src/quiesce/subscriptions.js';
import { declaredSubscriptions } from '../../src/quiesce/topology.js';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(() => Promise.resolve()) };
});

vi.mock('../../src/quiesce/subscriptions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/quiesce/subscriptions.js')>();
  return { ...actual, createPubSub: vi.fn() };
});

const CONFIG = loadConfig();
// The drain reads only the deployed services of the environment and hands it to createPubSub, which these tests replace.
const ENV = { GOOGLE_CLOUD_PROJECT: 'opt2-unit', OPT2_SERVICE_URLS: {} } as MigrationEnv;
const STUB_ENV = { ...ENV, OPT2_SERVICE_URLS: { stub: 'http://127.0.0.1:20199', people: 'http://127.0.0.1:20112' } } as MigrationEnv;
const SUBSCRIPTION_PREFIX = 'projects/opt2-unit/subscriptions/';
const UMBRELLA = '5e5c8a41-0f3b-4b8e-9d2a-6a7b8c9d0e1f';
const TENANT_A = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const TENANT_B = '1c1d5a8f-4a8b-4d2f-8b66-2e3c4d5e6f70';
const EVENT_A = 'a0000000-0000-4000-8000-00000000000a';
const EVENT_B = 'b0000000-0000-4000-8000-00000000000b';
const ARCHIVED = 'people.person.archived.v1';
const PERSON_CHANGED = 'people.person.changed.v1';
const GROUP_CHANGED = 'identity.group.changed.v1';
const SITE_CHANGED = 'programs-sites.site.changed.v1';
const TIMESHEETS_ARCHIVED = subscriptionName('timesheets', ARCHIVED);
const PEOPLE_GROUP = subscriptionName('people', GROUP_CHANGED);
// The subscriptions the consumers' contracts under services/ declare.
const TIMESHEETS_SITE = subscriptionName('timesheets', SITE_CHANGED);
const TIMESHEETS_DECLARED = [TIMESHEETS_ARCHIVED, TIMESHEETS_SITE];
const PEOPLE_DECLARED = [PEOPLE_GROUP, subscriptionName('people', SITE_CHANGED)];
const FINANCE_DECLARED = [subscriptionName('finance', SITE_CHANGED)];
const UNIT_OWNERS: Record<string, DataOwner> = {
  'people.person': 'people',
  'timesheets.day': 'timesheets',
  'timesheets.week': 'timesheets',
};

/** What the fake owners and Pub/Sub answer; tests change it between and during polls. */
interface World {
  outbox: Partial<Record<DataOwner, { unpublished: number; held: number }>>;
  published: Partial<Record<DataOwner, PublishedEvent[]>>;
  /** Inbox receipts of each consumer: the tenants holding each event id. */
  receipts: Partial<Record<DataOwner, Record<string, string[]>>>;
  withoutInbox: DataOwner[];
  /** Dead-lettered event ids by consumer subscription. */
  deadLetters: Record<string, string[]>;
}

/** Position call the owners fake received. */
interface PositionCall {
  owner: DataOwner;
  params: PositionParams | undefined;
}

const world = (parts: Partial<World> = {}): World => ({ outbox: {}, published: {}, receipts: {}, withoutInbox: [], deadLetters: {}, ...parts });
const event = (eventId: string, topic: string, tenantId: string): PublishedEvent => ({ eventId, topic, tenantId });
const outbox = (unpublished: number, held = 0): NonNullable<PositionResponse['outbox']> => ({ tenants: [], unpublished, held });
const answer = (owner: string, parts: Partial<Pick<PositionResponse, 'outbox'>> = {}): PositionResponse => ({
  owner,
  position: '4242',
  outbox: null,
  inbox: null,
  ...parts,
});
const counts = (owner: string, unpublished = 0, held = 0, pendingReceipts = 0): OwnerDrainCounts => ({
  owner,
  unpublished,
  held,
  pendingReceipts,
});
const ensureRequest = (service: string): ServiceRequest => ({
  service,
  method: 'POST',
  path: `${QUEUE_CONTROL_PREFIX}/${outboxSweepQueue(service)}/ensure`,
  json: {},
  userToken: null,
});
const producerCall = (owner: DataOwner, publishedTopics?: string[]): PositionCall => ({ owner, params: { publishedTopics } });
const consumerCall = (owner: DataOwner, eventIds: string[]): PositionCall => ({ owner, params: { eventIds } });

/** Clock that stands still at noon of the business date until `advance` moves it. */
function steppingClock(start = businessClock().now().getTime()): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Sleep that moves `clock` on by each pause and then runs `onSleep` with the number of pauses so far. */
function steppingSleep(clock: ReturnType<typeof steppingClock>, onSleep: (pauses: number) => void = () => undefined) {
  let pauses = 0;
  return vi.fn<(ms: number) => Promise<void>>((ms) => {
    clock.advance(ms);
    pauses += 1;
    onSleep(pauses);
    return Promise.resolve();
  });
}

/** Owners client answering `position` from `state` as an owner does; `onCall` runs first and may change `state` or return a failure. */
function fakeOwners(state: World, onCall?: (call: PositionCall) => Error | undefined): { owners: OwnersClient; calls: PositionCall[] } {
  const calls: PositionCall[] = [];
  const position = (owner: DataOwner, params?: PositionParams): Promise<PositionResponse> => {
    const call = { owner, params };
    calls.push(call);
    const failure = onCall?.(call);
    if (failure !== undefined) return Promise.reject(failure);
    const pending = state.outbox[owner];
    const held = state.receipts[owner] ?? {};
    const asked = params?.eventIds;
    const response: PositionResponse = {
      owner,
      position: '4242',
      outbox: pending === undefined ? null : { tenants: [], ...pending },
      inbox: state.withoutInbox.includes(owner)
        ? null
        : { total: 0, bySubscription: {}, ...(asked === undefined ? {} : { receipts: Object.fromEntries(asked.map((id) => [id, held[id] ?? []])) }) },
    };
    const topics = params?.publishedTopics;
    if (topics !== undefined) response.published = (state.published[owner] ?? []).filter((listed) => topics.includes(listed.topic));
    return Promise.resolve(response);
  };
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });
  return { owners, calls };
}

/** Pub/Sub client listing `subscriptions` and peeking the dead letters of `state`; `peeked` records each DLQ replay subscription read. */
function fakePubSub(subscriptions: readonly string[], state: World = world()) {
  const peeked: string[] = [];
  const subscription = (name: string): SubscriptionLike => ({
    name: `${SUBSCRIPTION_PREFIX}${name}`,
    getMetadata: () => Promise.resolve([{}]),
    modifyPushConfig: () => Promise.reject(new Error('modifyPushConfig was called')),
    seek: () => Promise.reject(new Error('seek was called')),
  });
  const pubsub = {
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([subscriptions.map(subscription)]),
    subscription,
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    peekEventIds: (fullName: string): Promise<string[]> => {
      const replay = fullName.slice(SUBSCRIPTION_PREFIX.length);
      peeked.push(replay);
      return Promise.resolve(state.deadLetters[replay.replace(/\.dlq\.replay$/, '')] ?? []);
    },
  } satisfies PubSubLike;
  return { pubsub, peeked };
}

/** Names of the subscriptions the contracts of `consumers` declare. */
async function declaredOf(...consumers: readonly DataOwner[]): Promise<string[]> {
  return (await Promise.all(consumers.map((consumer) => declaredSubscriptions(CONFIG, consumer)))).flat().map(({ name }) => name);
}

/** Service client answering every request with `status` and recording it. */
function fakeClient(status = 200): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      return Promise.resolve({ status, headers: {}, body: undefined } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return { client, calls };
}

// The drain reads only ownerOf, so reading any other member fails the test.
const CATALOG = new Proxy({} as UnitCatalog, {
  get(_target, member) {
    if (member !== 'ownerOf') throw new Error(`catalog.${String(member)} was read`);
    return (unitId: string): DataOwner => {
      const owner = UNIT_OWNERS[unitId];
      if (owner === undefined) throw new UnknownUnitError(unitId);
      return owner;
    };
  },
});

/** Drain context with the real config and the unit-map catalog; client, clock and env default to a 200 client, a stepping clock and no services. */
function context(
  owners: OwnersClient,
  client: ServiceClient = fakeClient().client,
  clock: Clock = steppingClock(),
  env: MigrationEnv = ENV,
): DrainContext {
  return { env, config: CONFIG, clock, catalog: CATALOG, owners, client };
}

afterEach(() => {
  vi.mocked(delay).mockClear();
  vi.mocked(createPubSub).mockReset();
});

describe('ownerDrainCounts', () => {
  it.each([
    ['zero outbox counts for an owner without an outbox', answer('reporting'), 0, counts('reporting')],
    ['the outbox unpublished and held rows', answer('people', { outbox: outbox(3, 2) }), 0, counts('people', 3, 2)],
    ['the pending receipts it is given', answer('timesheets', { outbox: outbox(0, 1) }), 2, counts('timesheets', 0, 1, 2)],
  ])('counts %s', (_label, position, pendingReceipts, expected) => {
    expect(ownerDrainCounts(expected.owner, position, pendingReceipts)).toStrictEqual(expected);
  });

  it('names the owner it was asked for, not the one the answer carries', () => {
    expect(ownerDrainCounts('people', answer('identity'), 0).owner).toBe('people');
  });
});

describe('isDrained', () => {
  const PRODUCER: DrainRole = { producer: true, consumer: false };
  const CONSUMER: DrainRole = { producer: false, consumer: true };
  const BOTH: DrainRole = { producer: true, consumer: true };
  const NEITHER: DrainRole = { producer: false, consumer: false };

  it.each([
    [true, 'a producer', counts('people', 0, 0, 5), PRODUCER],
    [false, 'a producer', counts('people', 1), PRODUCER],
    [false, 'a producer', counts('people', 0, 1), PRODUCER],
    [true, 'a consumer', counts('people', 4, 2, 0), CONSUMER],
    [false, 'a consumer', counts('people', 0, 0, 1), CONSUMER],
    [true, 'a producer and consumer', counts('people'), BOTH],
    [false, 'a producer and consumer', counts('people', 0, 0, 1), BOTH],
    [false, 'a producer and consumer', counts('people', 1), BOTH],
    [false, 'a producer and consumer', counts('people', 0, 1), BOTH],
    [true, 'neither role', counts('people', 1, 1, 1), NEITHER],
  ])('returns %s for %s with counts %j', (expected, _label, drainCounts, role) => {
    expect(isDrained(drainCounts, role)).toBe(expected);
  });
});

describe('drainParticipants', () => {
  it.each<[string, MigrationEnv, DataOwner[]]>([
    ['the data owners alone when the stub is not deployed', ENV, [...CONFIG.dataOwners]],
    ['the data owners, then the deployed stub', STUB_ENV, [...CONFIG.dataOwners, 'stub']],
  ])('lists %s', (_label, env, expected) => {
    expect(drainParticipants({ config: CONFIG, env })).toStrictEqual(expected);
  });
});

describe('awaitDrained', () => {
  it('drains in one round when every data owner, as producer and consumer, has nothing unpublished and nothing published', async () => {
    const { pubsub, peeked } = fakePubSub(await declaredOf(...CONFIG.dataOwners));
    const { owners, calls } = fakeOwners(world());
    const topics: Partial<Record<DataOwner, string[]>> = {
      identity: [GROUP_CHANGED, 'identity.membership.changed.v1', 'identity.permission.changed.v1', 'identity.login-mail.requested.v1'],
      people: [PERSON_CHANGED, ARCHIVED],
      'programs-sites': [SITE_CHANGED],
      surveys: ['surveys.survey.scheduled.v1'],
    };
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const result = await awaitDrained(context(owners), { timeoutMs: 1000, sleep, pubsub });

    expect(result).toStrictEqual<DrainResult>({ owners: CONFIG.dataOwners.map((owner) => counts(owner)), polls: 1, elapsedMs: 0 });
    expect(calls).toEqual(CONFIG.dataOwners.map((owner) => producerCall(owner, topics[owner])));
    expect(sleep).not.toHaveBeenCalled();
    expect(peeked).toStrictEqual([]);
    expect(pubsub.close).not.toHaveBeenCalled();
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it.each<[string, MigrationEnv, boolean, number, ServiceRequest[]]>([
    ['deployed', STUB_ENV, true, 3, [ensureRequest('stub')]],
    ['not deployed', ENV, false, 1, []],
  ])('waits for the stub’s outbox and its projection of its own note only when the stub is %s', async (_label, env, polled, polls, ensured) => {
    const noteCreated = 'stub.note.created.v1';
    const state = world({ outbox: { stub: { unpublished: 1, held: 0 } } });
    const { pubsub } = fakePubSub(await declaredOf(...CONFIG.dataOwners, 'stub'), state);
    const { owners, calls } = fakeOwners(state);
    const { client, calls: requests } = fakeClient();
    const clock = steppingClock();
    // The ensured sweep publishes the note, then its push delivery projects it.
    const sleep = steppingSleep(clock, (pauses) => {
      if (pauses === 1) {
        state.outbox.stub = { unpublished: 0, held: 0 };
        state.published.stub = [event(EVENT_A, noteCreated, TENANT_A)];
      }
      if (pauses === 2) state.receipts.stub = { [EVENT_A]: [TENANT_A] };
    });

    const result = await awaitDrained(context(owners, client, clock, env), { timeoutMs: 10_000, sleep, pubsub });

    expect(result.polls).toBe(polls);
    expect(requests).toStrictEqual(ensured);
    expect(result.owners.some(({ owner }) => owner === 'stub')).toBe(polled);
    expect(calls.filter((call) => call.owner === 'stub')).toEqual(
      polled
        ? [producerCall('stub', [noteCreated]), producerCall('stub', [noteCreated]), consumerCall('stub', [EVENT_A]), producerCall('stub', [noteCreated])]
        : [],
    );
  });

  it('lists only the checked consumers’ declared topics, at their producers, and takes no obligation from a live subscription no contract declares', async () => {
    const { pubsub, peeked } = fakePubSub([
      ...TIMESHEETS_DECLARED,
      subscriptionName('timesheets', PERSON_CHANGED),
      subscriptionName('strategies-content', PERSON_CHANGED),
      subscriptionName('timesheets', 'stub.note.created.v1'),
      dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED),
    ]);
    const { owners, calls } = fakeOwners(world({ published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA)] } }));

    const result = await awaitDrained(context(owners), { owners: ['identity'], consumersWriting: ['timesheets.day'], timeoutMs: 1000, pubsub });

    expect(result).toMatchObject({ owners: [counts('identity'), counts('timesheets')], polls: 1 });
    expect(calls).toEqual([
      producerCall('identity'),
      producerCall('timesheets'),
      producerCall('people', [ARCHIVED]),
      producerCall('programs-sites', [SITE_CHANGED]),
    ]);
    expect(peeked).toStrictEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['no subscription', [], TIMESHEETS_DECLARED],
    ['undeclared and other consumers’ subscriptions beside one declared one', [subscriptionName('timesheets', PERSON_CHANGED), PEOPLE_GROUP, TIMESHEETS_SITE], [TIMESHEETS_ARCHIVED]],
  ])('rejects with MissingSubscriptionError before any position call when Pub/Sub holds %s, and closes the client it created', async (_label, live, missing) => {
    const state = world({ published: { people: [event(EVENT_A, ARCHIVED, UMBRELLA)] } });
    const { owners, calls } = fakeOwners(state);
    const { pubsub } = fakePubSub(live, state);
    vi.mocked(createPubSub).mockReturnValueOnce(pubsub);
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const failure = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['timesheets.day'], timeoutMs: 1000, sleep }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MissingSubscriptionError);
    expect(failure).toMatchObject({
      name: 'MissingSubscriptionError',
      message: `declared subscriptions missing from Pub/Sub: ${missing.join(', ')}`,
      subscriptions: missing,
    });
    expect(calls).toStrictEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(pubsub.close).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (config: DrainContext['config']) => DrainContext['config'], new (...args: never[]) => Error, Record<string, unknown>]>([
    [
      'a declared topic’s producer is no data owner',
      (config) => ({ ...config, dataOwners: config.dataOwners.filter((owner) => owner !== 'people') }),
      UnlistedProducerError,
      {
        name: 'UnlistedProducerError',
        message: `declared subscriptions on topics no data owner lists: ${TIMESHEETS_ARCHIVED}`,
        subscriptions: [TIMESHEETS_ARCHIVED],
      },
    ],
    [
      'a checked consumer’s contract is missing',
      (config) => ({ ...config, owners: { ...config.owners, timesheets: { ...config.owners.timesheets, package: 'services/absent-consumer' } } }),
      Error,
      { code: 'ENOENT' },
    ],
  ])('fails closed before creating a Pub/Sub client or polling when %s', async (_label, configure, errorType, expected) => {
    const { owners, calls } = fakeOwners(world());

    const failure = await awaitDrained(
      { ...context(owners), config: configure(CONFIG) },
      { owners: ['identity'], consumersWriting: ['timesheets.day'], timeoutMs: 1000 },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(errorType);
    expect(failure).toMatchObject(expected);
    expect(calls).toStrictEqual([]);
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<World>]>([
    ['holds no receipt', {}],
    ['holds a receipt only in a fan-out tenant', { receipts: { timesheets: { [EVENT_A]: [TENANT_A] } } }],
    ['has no inbox', { withoutInbox: ['timesheets'] }],
  ])('keeps a published archive pending while timesheets %s, then throws DrainTimeoutError naming it', async (_label, parts) => {
    const state = world({ ...parts, outbox: { people: { unpublished: 0, held: 0 } }, published: { people: [event(EVENT_A, ARCHIVED, UMBRELLA)] } });
    const { pubsub, peeked } = fakePubSub(TIMESHEETS_DECLARED, state);
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock);

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['timesheets.day'],
      timeoutMs: 1000,
      pollIntervalMs: 400,
      sleep,
      pubsub,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      message: 'drain timed out after 1000 ms: timesheets(pendingReceipts=1)',
      owners: [counts('timesheets', 0, 0, 1)],
    });
    expect(sleep.mock.calls).toStrictEqual([[400], [400], [400]]);
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual(Array.from({ length: 3 }, () => consumerCall('timesheets', [EVENT_A])));
    expect(peeked).toStrictEqual(Array.from({ length: 3 }, () => dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED)));
  });

  it('completes a partially applied pooled fan-out only once its envelope tenant holds the receipt, matching ids and tenants in any case', async () => {
    const state = world({
      published: { people: [event(EVENT_A.toUpperCase(), ARCHIVED, UMBRELLA)] },
      receipts: { timesheets: { [EVENT_A]: [TENANT_A] } },
    });
    const { pubsub } = fakePubSub(TIMESHEETS_DECLARED, state);
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock, (pauses) => {
      if (pauses === 2) state.receipts.timesheets = { [EVENT_A]: [TENANT_A, UMBRELLA.toUpperCase()] };
    });

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['timesheets.day'],
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      sleep,
      pubsub,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('timesheets')], polls: 3, elapsedMs: 200 });
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual([consumerCall('timesheets', [EVENT_A]), consumerCall('timesheets', [EVENT_A])]);
  });

  it('proves a dead-lettered event by its dead letter and a received one by its receipt in the same round', async () => {
    const state = world({
      published: { people: [event(EVENT_A, ARCHIVED, UMBRELLA), event(EVENT_B, ARCHIVED, TENANT_B)] },
      receipts: { timesheets: { [EVENT_B]: [TENANT_B] } },
      deadLetters: { [TIMESHEETS_ARCHIVED]: [EVENT_A.toUpperCase()] },
    });
    const { pubsub, peeked } = fakePubSub(TIMESHEETS_DECLARED, state);
    const { owners } = fakeOwners(state);

    const result = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['timesheets.day'], timeoutMs: 1000, pubsub });

    expect(result.polls).toBe(2);
    expect(result.owners).toStrictEqual([counts('people'), counts('timesheets')]);
    expect(peeked).toStrictEqual([dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED)]);
  });

  it('waits for an event the effect of a proven event published while the round ran', async () => {
    const state = world({
      published: { identity: [event(EVENT_A, GROUP_CHANGED, TENANT_A)] },
      receipts: { people: { [EVENT_A]: [TENANT_A] }, timesheets: { [EVENT_B]: [TENANT_A] } },
    });
    const { pubsub } = fakePubSub([...PEOPLE_DECLARED, ...TIMESHEETS_DECLARED], state);
    // People's effect of EVENT_A, committed with its receipt, publishes EVENT_B.
    const { owners, calls } = fakeOwners(state, (call) => {
      if (call.owner === 'people' && call.params?.eventIds?.includes(EVENT_A) === true) {
        state.published.people = [event(EVENT_B, ARCHIVED, TENANT_A)];
      }
      return undefined;
    });

    const result = await awaitDrained(context(owners), {
      owners: ['identity', 'people'],
      consumersWriting: ['people.person', 'timesheets.day'],
      timeoutMs: 1000,
      pubsub,
    });

    const producers = [
      producerCall('identity', [GROUP_CHANGED]),
      producerCall('people', [ARCHIVED]),
      producerCall('timesheets'),
      producerCall('programs-sites', [SITE_CHANGED]),
    ];
    expect(result.polls).toBe(3);
    expect(calls).toEqual([...producers, consumerCall('people', [EVENT_A]), ...producers, consumerCall('timesheets', [EVENT_B]), ...producers]);
  });

  it('asks a consumer for at most RECEIPT_QUERY_MAX_IDS (200) event ids per position call', async () => {
    const ids = Array.from({ length: RECEIPT_QUERY_MAX_IDS + 1 }, (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const state = world({
      published: { people: ids.map((id) => event(id, ARCHIVED, UMBRELLA)) },
      receipts: { timesheets: Object.fromEntries(ids.map((id) => [id, [UMBRELLA]])) },
    });
    const { pubsub, peeked } = fakePubSub(TIMESHEETS_DECLARED, state);
    const { owners, calls } = fakeOwners(state);

    const result = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['timesheets.day'], timeoutMs: 1000, pubsub });

    expect(RECEIPT_QUERY_MAX_IDS).toBe(200);
    expect(result.polls).toBe(2);
    expect(calls.flatMap((call) => (call.params?.eventIds === undefined ? [] : [call.params.eventIds]))).toStrictEqual([ids.slice(0, 200), ids.slice(200)]);
    expect(peeked).toStrictEqual([]);
  });

  it('polls until every owner is drained, sleeping pollIntervalMs between rounds, and reports the rounds and elapsed time', async () => {
    const state = world({ outbox: { people: { unpublished: 2, held: 0 } } });
    const clock = steppingClock();
    const sleep = steppingSleep(clock, (pauses) => {
      state.outbox.people = { unpublished: 2 - pauses, held: 0 };
    });
    const { owners, calls } = fakeOwners(state);
    const { pubsub } = fakePubSub(TIMESHEETS_DECLARED, state);

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['timesheets.day'],
      timeoutMs: 10_000,
      pollIntervalMs: 250,
      sleep,
      pubsub,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('timesheets')], polls: 3, elapsedMs: 500 });
    expect(sleep.mock.calls).toStrictEqual([[250], [250]]);
    expect(calls.map((call) => call.owner)).toStrictEqual(Array.from({ length: 3 }, () => ['people', 'timesheets', 'programs-sites']).flat());
  });

  it('ensures the outbox sweep chain once per drain for each sweep producer with unpublished or held rows', async () => {
    const { client, calls } = fakeClient();
    const state = world({
      outbox: {
        identity: { unpublished: 1, held: 0 },
        people: { unpublished: 0, held: 2 },
        'programs-sites': { unpublished: 0, held: 0 },
        finance: { unpublished: 3, held: 0 },
        timesheets: { unpublished: 5, held: 0 },
      },
    });
    const { owners } = fakeOwners(state);
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => {
      for (const owner of ['identity', 'people', 'finance'] as const) state.outbox[owner] = { unpublished: 0, held: 0 };
      return Promise.resolve();
    });

    const result = await awaitDrained(context(owners, client), {
      owners: ['identity', 'people', 'programs-sites', 'finance'],
      consumersWriting: ['timesheets.day'],
      timeoutMs: 1000,
      sleep,
      pubsub: fakePubSub(TIMESHEETS_DECLARED).pubsub,
    });

    expect(calls).toStrictEqual([ensureRequest('identity'), ensureRequest('people')]);
    expect(result.polls).toBe(2);
    expect(result.owners).toContainEqual(counts('timesheets', 5));
  });

  it('propagates a failed sweep ensure before sleeping or polling again', async () => {
    const { client, calls } = fakeClient(503);
    const { owners, calls: positions } = fakeOwners(world({ outbox: { people: { unpublished: 1, held: 0 } } }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(
      awaitDrained(context(owners, client), { owners: ['people'], timeoutMs: 1000, sleep, pubsub: fakePubSub(PEOPLE_DECLARED).pubsub }),
    ).rejects.toThrow('Queue control ensure of people-outbox-sweep on people answered HTTP 503');
    expect(calls).toStrictEqual([ensureRequest('people')]);
    expect(positions.map((call) => call.owner)).toStrictEqual(['people', 'identity', 'programs-sites']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each<[string, (call: PositionCall) => boolean, number]>([
    ['the producer round', (call) => call.owner === 'people' && call.params?.eventIds === undefined, 0],
    ['the consumer round', (call) => call.params?.eventIds !== undefined, 1],
  ])('propagates an owner position failure in %s at once', async (_label, fails, sleeps) => {
    const failure = new Error('owner answered HTTP 503');
    const state = world({ published: { people: [event(EVENT_A, ARCHIVED, UMBRELLA)] } });
    const { owners } = fakeOwners(state, (call) => (fails(call) ? failure : undefined));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(
      awaitDrained(context(owners), {
        owners: ['people'],
        consumersWriting: ['timesheets.day'],
        timeoutMs: 1000,
        sleep,
        pubsub: fakePubSub(TIMESHEETS_DECLARED, state).pubsub,
      }),
    ).rejects.toBe(failure);
    expect(sleep).toHaveBeenCalledTimes(sleeps);
  });

  it('fails when a publisher answers without the published events it was asked for', async () => {
    const { owners } = fakeOwners(world());
    const unlisted: OwnersClient = { ...owners, position: async (owner, params) => ({ ...(await owners.position(owner, params)), published: undefined }) };

    await expect(
      awaitDrained(context(unlisted), {
        owners: ['people'],
        consumersWriting: ['timesheets.day'],
        timeoutMs: 1000,
        pubsub: fakePubSub(TIMESHEETS_DECLARED).pubsub,
      }),
    ).rejects.toThrow('Owner people answered position without the asked published events');
  });

  it('creates its Pub/Sub client from ctx.env and closes it when the drain ends, drained or failed', async () => {
    const state = world({ outbox: { finance: { unpublished: 1, held: 0 } } });
    const { owners } = fakeOwners(state);
    const created = [fakePubSub(FINANCE_DECLARED).pubsub, fakePubSub(FINANCE_DECLARED).pubsub] as const;
    vi.mocked(createPubSub).mockReturnValueOnce(created[0]).mockReturnValueOnce(created[1]);

    await expect(awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 0 })).rejects.toThrow(DrainTimeoutError);
    state.outbox.finance = { unpublished: 0, held: 0 };
    await expect(awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 0 })).resolves.toMatchObject({ polls: 1 });

    expect(vi.mocked(createPubSub).mock.calls).toStrictEqual([[ENV], [ENV]]);
    for (const pubsub of created) expect(pubsub.close).toHaveBeenCalledTimes(1);
  });

  it('rejects with UnknownUnitError for an unknown consumer unit before creating a Pub/Sub client or polling any owner', async () => {
    const { owners, calls } = fakeOwners(world());

    await expect(awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['people.nothing'], timeoutMs: 1000 })).rejects.toThrow(
      UnknownUnitError,
    );
    expect(calls).toStrictEqual([]);
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it('throws DrainTimeoutError naming each undrained owner with the counts of its roles once timeoutMs has passed', async () => {
    const state = world({
      outbox: {
        people: { unpublished: 2, held: 1 },
        identity: { unpublished: 1, held: 0 },
        communications: { unpublished: 0, held: 0 },
        timesheets: { unpublished: 4, held: 0 },
      },
      published: { identity: [event(EVENT_A, GROUP_CHANGED, TENANT_A)], people: [event(EVENT_B, ARCHIVED, UMBRELLA)] },
    });
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock);
    const options: AwaitDrainedOptions = {
      owners: ['people', 'identity', 'communications'],
      consumersWriting: ['people.person', 'timesheets.day'],
      timeoutMs: 1000,
      pollIntervalMs: 400,
      sleep,
      pubsub: fakePubSub([...PEOPLE_DECLARED, ...TIMESHEETS_DECLARED], state).pubsub,
    };

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), options).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: 'DrainTimeoutError',
      message:
        'drain timed out after 1000 ms: people(unpublished=2, held=1, pendingReceipts=1), identity(unpublished=1, held=0), ' +
        'timesheets(pendingReceipts=1)',
      timeoutMs: 1000,
      owners: [counts('people', 2, 1, 1), counts('identity', 1), counts('timesheets', 4, 0, 1)],
    });
    expect(sleep.mock.calls).toStrictEqual([[400], [400], [400]]);
    expect(calls).toHaveLength(5 + 3 * 7);
  });

  it('throws DrainTimeoutError after the first round without sleeping when timeoutMs is zero', async () => {
    const { owners, calls } = fakeOwners(world({ outbox: { finance: { unpublished: 1, held: 0 } } }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(
      awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 0, sleep, pubsub: fakePubSub(FINANCE_DECLARED).pubsub }),
    ).rejects.toThrow(new DrainTimeoutError(0, [{ counts: counts('finance', 1), role: { producer: true, consumer: true } }]));
    expect(calls.map((call) => call.owner)).toStrictEqual(['finance', 'programs-sites']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps DEFAULT_DRAIN_POLL_MS (1000 ms) on node timers when neither pollIntervalMs nor sleep is given', async () => {
    const state = world({ outbox: { finance: { unpublished: 1, held: 0 } } });
    // The second round finds the row published.
    const { owners, calls } = fakeOwners(state, (call) => {
      if (call.owner === 'finance' && calls.filter((made) => made.owner === 'finance').length === 2) state.outbox.finance = { unpublished: 0, held: 0 };
      return undefined;
    });

    const result = await awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 60_000, pubsub: fakePubSub(FINANCE_DECLARED).pubsub });

    expect(DEFAULT_DRAIN_POLL_MS).toBe(1000);
    expect(delay).toHaveBeenCalledExactlyOnceWith(DEFAULT_DRAIN_POLL_MS);
    expect(result.polls).toBe(2);
  });
});
