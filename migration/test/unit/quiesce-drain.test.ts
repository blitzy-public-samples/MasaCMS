// Unit tests for the drain barrier, using the consumers' contracts, in-memory owners, Pub/Sub, service client and unit catalog, and a stepping clock.
import { setTimeout as delay } from 'node:timers/promises';

import { dlqReplaySubscriptionName, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse, PublishedEvent } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type Clock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, outboxSweepQueue } from '@opt2/platform/tasks';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationEnv } from '../../src/env.js';
import { OwnerCallError, UnknownUnitError } from '../../src/owners/index.js';
import type { DataOwner, OwnersClient, PositionParams, UnitCatalog } from '../../src/owners/index.js';
import {
  DEFAULT_DRAIN_POLL_MS,
  DeadLetteredProcessEventError,
  DrainTimeoutError,
  MAX_PENDING_DELIVERIES,
  MissingSubscriptionError,
  PUBLISHED_PAGE_LIMIT,
  RECEIPT_QUERY_MAX_IDS,
  UnlistedProducerError,
  awaitDrained,
  drainParticipants,
  isDrained,
  ownerDrainCounts,
} from '../../src/quiesce/drain.js';
import type { AwaitDrainedOptions, DrainContext, DrainResult, DrainRole, OwnerDrainCounts } from '../../src/quiesce/drain.js';
import { createPubSub, type PeekOptions, type PubSubLike, type SubscriptionLike } from '../../src/quiesce/subscriptions.js';
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
const PERSON_CHANGED = 'people.person.changed.v1';
const GROUP_CHANGED = 'identity.group.changed.v1';
const SITE_CHANGED = 'programs-sites.site.changed.v1';
const IDENTITY_PERSON = subscriptionName('identity', PERSON_CHANGED);
const PEOPLE_GROUP = subscriptionName('people', GROUP_CHANGED);
// The subscriptions the consumers' contracts under services/ declare.
const IDENTITY_SITE = subscriptionName('identity', SITE_CHANGED);
const IDENTITY_DECLARED = [IDENTITY_PERSON, IDENTITY_SITE];
const PEOPLE_DECLARED = [PEOPLE_GROUP, subscriptionName('people', SITE_CHANGED)];
const PROGRAMS_SITES_DECLARED = [subscriptionName('programs-sites', SITE_CHANGED)];
const UNIT_OWNERS: Record<string, DataOwner> = {
  'people.person': 'people',
  'identity.user_account': 'identity',
};

/** A published event of the fakes; one without `seq` takes its 1-based position in its owner's list. */
type ListedEvent = Omit<PublishedEvent, 'seq'> & { seq?: string };

/** What the fake owners and Pub/Sub answer; tests change it between and during polls. */
interface World {
  outbox: Partial<Record<DataOwner, { unpublished: number; held: number }>>;
  published: Partial<Record<DataOwner, ListedEvent[]>>;
  /** Seq of an unpublished row of the asked topics each publisher's listing stops below. */
  blocked: Partial<Record<DataOwner, string>>;
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

const world = (parts: Partial<World> = {}): World => ({
  outbox: {},
  published: {},
  blocked: {},
  receipts: {},
  withoutInbox: [],
  deadLetters: {},
  ...parts,
});
const event = (eventId: string, topic: string, tenantId: string, kind: PublishedEvent['kind'] = 'state'): ListedEvent => ({ eventId, topic, tenantId, kind });
const bySeq = (a: PublishedEvent, b: PublishedEvent): number => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);

/**
 * One page of `owner`'s published events of the asked topics after the cursor and through the asked frontier, stopping below its
 * blocked row, as an owner pages; the count behind the cursor only on a complete page.
 */
function publishedPage(state: World, owner: DataOwner, params: PositionParams): Partial<PositionResponse> {
  const topics = params.publishedTopics ?? [];
  const after = BigInt(params.publishedAfter ?? '0');
  const through = params.publishedThrough === undefined ? undefined : BigInt(params.publishedThrough);
  const within = (seq: bigint): boolean => through === undefined || seq <= through;
  const all = (state.published[owner] ?? [])
    .map((listed, index): PublishedEvent => ({ ...listed, seq: listed.seq ?? String(index + 1) }))
    .filter((listed) => topics.includes(listed.topic) && within(BigInt(listed.seq)))
    .sort(bySeq);
  const blockedSeq = state.blocked[owner] === undefined ? undefined : BigInt(state.blocked[owner]);
  const blocked = blockedSeq !== undefined && within(blockedSeq) ? blockedSeq : undefined;
  const later = all.filter((listed) => BigInt(listed.seq) > after && (blocked === undefined || BigInt(listed.seq) < blocked));
  const published = later.slice(0, params.publishedLimit ?? 1000);
  const truncated = published.length < later.length;
  const next = truncated || blocked === undefined ? (published.at(-1)?.seq ?? String(after)) : String(blocked - 1n > after ? blocked - 1n : after);
  const complete = !truncated && blocked === undefined;
  const seqs = [...all.map((listed) => BigInt(listed.seq)), ...(blocked === undefined ? [] : [blocked])];
  const highest = seqs.length === 0 ? after : seqs.reduce((a, b) => (b > a ? b : a));
  return {
    published,
    publishedNext: next,
    publishedComplete: complete,
    publishedFrontier: params.publishedThrough ?? String(highest),
    ...(complete ? { publishedUpTo: all.filter((listed) => BigInt(listed.seq) <= after).length } : {}),
  };
}
const outbox = (unpublished: number, held = 0): NonNullable<PositionResponse['outbox']> => ({ tenants: [], unpublished, held });
const answer = (owner: string, parts: Partial<Pick<PositionResponse, 'outbox'>> = {}): PositionResponse => ({
  owner,
  position: '4242',
  outbox: null,
  inbox: null,
  ...parts,
});
const counts = (owner: string, unpublished = 0, held = 0, pendingReceipts = 0, extra: Partial<OwnerDrainCounts> = {}): OwnerDrainCounts => ({
  owner,
  unpublished,
  held,
  pendingReceipts,
  ...extra,
});
const ensureRequest = (service: string, timeoutMs: number): ServiceRequest => ({
  service,
  method: 'POST',
  path: `${QUEUE_CONTROL_PREFIX}/${outboxSweepQueue(service)}/ensure`,
  json: {},
  userToken: null,
  timeoutMs,
});
/** A publisher's listing call for one page from `after`, through `through` when a pass is under way. */
const listCall = (owner: DataOwner, publishedTopics: string[], after = '0', through?: string): PositionCall => ({
  owner,
  params: { publishedTopics, publishedAfter: after, publishedLimit: PUBLISHED_PAGE_LIMIT, ...(through === undefined ? {} : { publishedThrough: through }) },
});
/** The counts read of an owner publishing no asked topic. */
const plainCall = (owner: DataOwner): PositionCall => ({ owner, params: {} });
const consumerCall = (owner: DataOwner, eventIds: string[]): PositionCall => ({ owner, params: { eventIds } });
const refused = (service: string): ServiceUnavailableError => new ServiceUnavailableError(service, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
/** Waits `ms` on the real timers, which the node:timers/promises mock leaves alone. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type SubscriptionMetadata = Awaited<ReturnType<SubscriptionLike['getMetadata']>>;
const timedOut = (service: string): ServiceUnavailableError =>
  new ServiceUnavailableError(service, Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError' }));

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

/**
 * Owners client answering `position` from `state` as an owner does; `onCall` runs first and may change `state` or return a failure.
 * `timeouts` holds the call bound of each call.
 */
function fakeOwners(
  state: World,
  onCall?: (call: PositionCall) => Error | undefined,
): { owners: OwnersClient; calls: PositionCall[]; timeouts: (number | undefined)[] } {
  const calls: PositionCall[] = [];
  const timeouts: (number | undefined)[] = [];
  const position = (owner: DataOwner, params?: PositionParams, options?: { timeoutMs?: number }): Promise<PositionResponse> => {
    const call = { owner, params };
    calls.push(call);
    timeouts.push(options?.timeoutMs);
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
    if (params?.publishedTopics !== undefined) Object.assign(response, publishedPage(state, owner, params));
    return Promise.resolve(response);
  };
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });
  return { owners, calls, timeouts };
}

/**
 * Pub/Sub client listing `subscriptions` and peeking the dead letters of `state`, every one whatever is sought; `peeked` records each
 * DLQ replay subscription read and `peekOptions` the bounds it was read with.
 */
function fakePubSub(subscriptions: readonly string[], state: World = world()) {
  const peeked: string[] = [];
  const peekOptions: (PeekOptions | undefined)[] = [];
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
    peekEventIds: (fullName: string, options?: PeekOptions): Promise<string[]> => {
      const replay = fullName.slice(SUBSCRIPTION_PREFIX.length);
      peeked.push(replay);
      peekOptions.push(options === undefined ? undefined : { ...options, eventIds: [...(options.eventIds ?? [])] });
      return Promise.resolve(state.deadLetters[replay.replace(/\.dlq\.replay$/, '')] ?? []);
    },
  } satisfies PubSubLike;
  return { pubsub, peeked, peekOptions };
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
    ['zero outbox counts for an owner without an outbox', answer('strategies-content'), 0, counts('strategies-content')],
    ['the outbox unpublished and held rows', answer('people', { outbox: outbox(3, 2) }), 0, counts('people', 3, 2)],
    ['the pending receipts it is given', answer('identity', { outbox: outbox(0, 1) }), 2, counts('identity', 0, 1, 2)],
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
    [false, 'a producer', counts('people', 0, 0, 0, { unavailable: 'Service people unavailable (ECONNREFUSED)' }), PRODUCER],
    [true, 'a consumer', counts('people', 0, 0, 0, { unavailable: 'Service people unavailable (ECONNREFUSED)' }), CONSUMER],
    [false, 'a consumer', counts('people', 0, 0, 0, { unlisted: ['identity'] }), CONSUMER],
    [true, 'a producer', counts('people', 0, 0, 0, { unlisted: ['identity'] }), PRODUCER],
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
    const { owners, calls, timeouts } = fakeOwners(world());
    const topics: Partial<Record<DataOwner, string[]>> = {
      identity: [GROUP_CHANGED, 'identity.membership.changed.v1', 'identity.permission.changed.v1'],
      people: [PERSON_CHANGED],
      'programs-sites': [SITE_CHANGED],
    };
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const result = await awaitDrained(context(owners), { timeoutMs: 1000, sleep, pubsub });

    expect(result).toStrictEqual<DrainResult>({ owners: CONFIG.dataOwners.map((owner) => counts(owner)), polls: 1, elapsedMs: 0 });
    expect(calls).toEqual(CONFIG.dataOwners.map((owner) => (topics[owner] === undefined ? plainCall(owner) : listCall(owner, topics[owner]))));
    // Each call is bounded by the remaining budget, here below the service-call bound.
    expect(timeouts).toStrictEqual(calls.map(() => 1000));
    expect(sleep).not.toHaveBeenCalled();
    expect(peeked).toStrictEqual([]);
    expect(pubsub.close).not.toHaveBeenCalled();
    expect(createPubSub).not.toHaveBeenCalled();
  });

  it.each<[string, MigrationEnv, boolean, number, ServiceRequest[]]>([
    ['deployed', STUB_ENV, true, 3, [ensureRequest('stub', 10_000)]],
    ['not deployed', ENV, false, 1, []],
  ])('waits for the stub’s outbox and its projection of its own note only when the stub is %s', async (_label, env, polled, polls, ensured) => {
    const noteCreated = 'stub.note.created.v1';
    // The stub consumes both its topics, listed in its contract's subscription-name order.
    const stubTopics = ['stub.note.commented.v1', noteCreated];
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
    // The round that lists the note proves it at once, then lists from the note's seq on.
    expect(calls.filter((call) => call.owner === 'stub')).toEqual(
      polled
        ? [
            listCall('stub', stubTopics),
            listCall('stub', stubTopics),
            consumerCall('stub', [EVENT_A]),
            listCall('stub', stubTopics, '1'),
            consumerCall('stub', [EVENT_A]),
            listCall('stub', stubTopics, '1'),
          ]
        : [],
    );
  });

  it('lists only the checked consumers’ declared topics, at their producers, and takes no obligation from a live subscription no contract declares', async () => {
    const { pubsub, peeked } = fakePubSub([
      ...IDENTITY_DECLARED,
      subscriptionName('identity', 'people.person.archived.v1'),
      subscriptionName('strategies-content', PERSON_CHANGED),
      subscriptionName('identity', 'stub.note.created.v1'),
      dlqReplaySubscriptionName(IDENTITY_PERSON),
    ]);
    const { owners, calls } = fakeOwners(world({ published: { people: [event(EVENT_A, 'people.person.archived.v1', UMBRELLA)] } }));

    const result = await awaitDrained(context(owners), { owners: ['strategies-content'], consumersWriting: ['identity.user_account'], timeoutMs: 1000, pubsub });

    expect(result).toMatchObject({ owners: [counts('strategies-content'), counts('identity')], polls: 1 });
    expect(calls).toEqual([plainCall('strategies-content'), plainCall('identity'), listCall('people', [PERSON_CHANGED]), listCall('programs-sites', [SITE_CHANGED])]);
    expect(peeked).toStrictEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['no subscription', [], IDENTITY_DECLARED],
    ['undeclared and other consumers’ subscriptions beside one declared one', [subscriptionName('identity', GROUP_CHANGED), PEOPLE_GROUP, IDENTITY_SITE], [IDENTITY_PERSON]],
  ])('rejects with MissingSubscriptionError before any position call when Pub/Sub holds %s, and closes the client it created', async (_label, live, missing) => {
    const state = world({ published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA)] } });
    const { owners, calls } = fakeOwners(state);
    const { pubsub } = fakePubSub(live, state);
    vi.mocked(createPubSub).mockReturnValueOnce(pubsub);
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const failure = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['identity.user_account'], timeoutMs: 1000, sleep }).then(
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
        message: `declared subscriptions on topics no data owner lists: ${IDENTITY_PERSON}`,
        subscriptions: [IDENTITY_PERSON],
      },
    ],
    [
      'a checked consumer’s contract is missing',
      (config) => ({ ...config, owners: { ...config.owners, identity: { ...config.owners.identity, package: 'services/absent-consumer' } } }),
      Error,
      { code: 'ENOENT' },
    ],
  ])('fails closed before creating a Pub/Sub client or polling when %s', async (_label, configure, errorType, expected) => {
    const { owners, calls } = fakeOwners(world());

    const failure = await awaitDrained(
      { ...context(owners), config: configure(CONFIG) },
      { owners: ['strategies-content'], consumersWriting: ['identity.user_account'], timeoutMs: 1000 },
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
    ['holds a receipt only in a fan-out tenant', { receipts: { identity: { [EVENT_A]: [TENANT_A] } } }],
    ['has no inbox', { withoutInbox: ['identity'] }],
  ])('keeps a published change pending while identity %s, then throws DrainTimeoutError naming it', async (_label, parts) => {
    const state = world({ ...parts, outbox: { people: { unpublished: 0, held: 0 } }, published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process')] } });
    const { pubsub, peeked, peekOptions } = fakePubSub(IDENTITY_DECLARED, state);
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock);

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
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
      message: 'drain timed out after 1000 ms: identity(pendingReceipts=1)',
      owners: [counts('identity', 0, 0, 1)],
    });
    // The last pause ends at the deadline, so no round starts past it.
    expect(sleep.mock.calls).toStrictEqual([[400], [400], [200]]);
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual(Array.from({ length: 3 }, () => consumerCall('identity', [EVENT_A])));
    expect(peeked).toStrictEqual(Array.from({ length: 3 }, () => dlqReplaySubscriptionName(IDENTITY_PERSON)));
    // Each peek seeks only the unreceived event, within what is left of the budget.
    expect(peekOptions).toStrictEqual([1000, 600, 200].map((timeoutMs) => ({ eventIds: [EVENT_A], timeoutMs })));
  });

  it('completes a partially applied pooled fan-out only once its envelope tenant holds the receipt, matching ids and tenants in any case', async () => {
    const state = world({
      published: { people: [event(EVENT_A.toUpperCase(), PERSON_CHANGED, UMBRELLA)] },
      receipts: { identity: { [EVENT_A]: [TENANT_A] } },
    });
    const { pubsub } = fakePubSub(IDENTITY_DECLARED, state);
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock, (pauses) => {
      if (pauses === 2) state.receipts.identity = { [EVENT_A]: [TENANT_A, UMBRELLA.toUpperCase()] };
    });

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      sleep,
      pubsub,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('identity')], polls: 3, elapsedMs: 200 });
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual(Array.from({ length: 3 }, () => consumerCall('identity', [EVENT_A])));
  });

  it('proves a dead-lettered state event by its dead letter and a received process event by its receipt in the round that lists them', async () => {
    const state = world({
      published: { 'programs-sites': [event(EVENT_A, SITE_CHANGED, UMBRELLA)], people: [event(EVENT_B, PERSON_CHANGED, TENANT_B, 'process')] },
      receipts: { identity: { [EVENT_B]: [TENANT_B] } },
      deadLetters: { [IDENTITY_SITE]: [EVENT_A.toUpperCase()] },
    });
    const { pubsub, peeked, peekOptions } = fakePubSub(IDENTITY_DECLARED, state);
    const { owners, timeouts } = fakeOwners(state);

    const result = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['identity.user_account'], timeoutMs: 1000, pubsub });

    expect(result.polls).toBe(1);
    expect(result.owners).toStrictEqual([counts('people'), counts('identity')]);
    expect(peeked).toStrictEqual([dlqReplaySubscriptionName(IDENTITY_SITE)]);
    expect(peekOptions).toStrictEqual([{ eventIds: [EVENT_A], timeoutMs: 1000 }]);
    expect(new Set(timeouts)).toStrictEqual(new Set([1000]));
  });

  it('rejects with DeadLetteredProcessEventError naming a dead-lettered process event its consumer holds no receipt of, without waiting', async () => {
    const state = world({
      published: { people: [event(EVENT_A.toUpperCase(), PERSON_CHANGED, UMBRELLA.toUpperCase(), 'process'), event(EVENT_B, PERSON_CHANGED, TENANT_B, 'process')] },
      // EVENT_B was dead-lettered and then replayed, so its receipt proves it.
      receipts: { identity: { [EVENT_B]: [TENANT_B] } },
      deadLetters: { [IDENTITY_PERSON]: [EVENT_A, EVENT_B] },
    });
    const { pubsub } = fakePubSub(IDENTITY_DECLARED, state);
    const { owners } = fakeOwners(state);
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const failure = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['identity.user_account'], timeoutMs: 300_000, sleep, pubsub }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DeadLetteredProcessEventError);
    expect(failure).toMatchObject({
      name: 'DeadLetteredProcessEventError',
      message: `process events dead-lettered without a receipt: ${EVENT_A} (${PERSON_CHANGED}) on ${IDENTITY_PERSON}`,
      deliveries: [{ eventId: EVENT_A, topic: PERSON_CHANGED, tenantId: UMBRELLA, consumer: 'identity', subscription: IDENTITY_PERSON }],
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for an event the effect of a proven event published while the round ran', async () => {
    const state = world({
      published: { identity: [event(EVENT_A, GROUP_CHANGED, TENANT_A)] },
      receipts: { people: { [EVENT_A]: [TENANT_A] }, identity: { [EVENT_B]: [TENANT_A] } },
    });
    const { pubsub } = fakePubSub([...PEOPLE_DECLARED, ...IDENTITY_DECLARED], state);
    // People's effect of EVENT_A, committed with its receipt, publishes EVENT_B.
    const { owners, calls } = fakeOwners(state, (call) => {
      if (call.owner === 'people' && call.params?.eventIds?.includes(EVENT_A) === true) {
        state.published.people = [event(EVENT_B, PERSON_CHANGED, TENANT_A, 'process')];
      }
      return undefined;
    });

    const result = await awaitDrained(context(owners), {
      owners: ['identity', 'people'],
      consumersWriting: ['people.person', 'identity.user_account'],
      timeoutMs: 1000,
      pubsub,
    });

    const listings = (identityAfter: string, peopleAfter: string): PositionCall[] => [
      listCall('identity', [GROUP_CHANGED], identityAfter),
      listCall('people', [PERSON_CHANGED], peopleAfter),
      listCall('programs-sites', [SITE_CHANGED]),
    ];
    expect(result.polls).toBe(1);
    expect(calls).toEqual([
      ...listings('0', '0'),
      consumerCall('people', [EVENT_A]),
      ...listings('1', '0'),
      consumerCall('identity', [EVENT_B]),
      ...listings('1', '1'),
    ]);
  });

  it('asks a consumer for at most RECEIPT_QUERY_MAX_IDS (200) event ids per position call', async () => {
    const ids = Array.from({ length: RECEIPT_QUERY_MAX_IDS + 1 }, (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const state = world({
      published: { people: ids.map((id) => event(id, PERSON_CHANGED, UMBRELLA)) },
      receipts: { identity: Object.fromEntries(ids.map((id) => [id, [UMBRELLA]])) },
    });
    const { pubsub, peeked } = fakePubSub(IDENTITY_DECLARED, state);
    const { owners, calls } = fakeOwners(state);

    const result = await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['identity.user_account'], timeoutMs: 1000, pubsub });

    expect(RECEIPT_QUERY_MAX_IDS).toBe(200);
    expect(result.polls).toBe(1);
    expect(calls.flatMap((call) => (call.params?.eventIds === undefined ? [] : [call.params.eventIds]))).toStrictEqual([ids.slice(0, 200), ids.slice(200)]);
    expect(peeked).toStrictEqual([]);
  });

  it('lists a long history page by page from each cursor, holding at most MAX_PENDING_DELIVERIES unproven deliveries', async () => {
    const total = MAX_PENDING_DELIVERIES + PUBLISHED_PAGE_LIMIT + 100;
    const ids = Array.from({ length: total }, (_, i) => `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const state = world({
      published: { people: ids.map((id) => event(id, PERSON_CHANGED, UMBRELLA)) },
      receipts: { identity: Object.fromEntries(ids.map((id) => [id, [UMBRELLA]])) },
    });
    const { owners, calls } = fakeOwners(state);

    const result = await awaitDrained(context(owners), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    });

    expect([MAX_PENDING_DELIVERIES, PUBLISHED_PAGE_LIMIT]).toStrictEqual([5000, 500]);
    expect(result).toMatchObject({ polls: 1, owners: [counts('people'), counts('identity')] });
    const people = calls.flatMap((call, index) => (call.owner === 'people' ? [{ index, after: call.params?.publishedAfter, through: call.params?.publishedThrough }] : []));
    const pageStarts = Array.from({ length: MAX_PENDING_DELIVERIES / PUBLISHED_PAGE_LIMIT }, (_, page) => String(page * PUBLISHED_PAGE_LIMIT));
    // The first page reports the frontier the pass pages through; a page without one follows the pass and each later proof.
    expect(people.map((call) => [call.after, call.through])).toStrictEqual([
      ['0', undefined],
      ...[...pageStarts.slice(1), '5000', '5500'].map((after) => [after, String(total)]),
      ['5600', undefined],
      ['5600', undefined],
    ]);
    // The pages beyond the bound are asked for only once the receipts of the first 5000 events have been read.
    const receiptCalls = calls.flatMap((call, index) => (call.params?.eventIds === undefined ? [] : [{ index, ids: call.params.eventIds }]));
    const resumed = people.find((call) => call.after === '5000')?.index ?? -1;
    expect(receiptCalls.filter((call) => call.index < resumed).flatMap((call) => call.ids)).toStrictEqual(ids.slice(0, MAX_PENDING_DELIVERIES));
    expect(receiptCalls.flatMap((call) => call.ids)).toStrictEqual(ids);
  });

  it('pages one pass through the frontier its first page reports while rows appear, then starts the next with a page without it', async () => {
    const ids = Array.from({ length: PUBLISHED_PAGE_LIMIT + 100 }, (_, i) => `e0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const late = Array.from({ length: PUBLISHED_PAGE_LIMIT + 100 }, (_, i) => `e1000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const state = world({
      published: { people: ids.map((id) => event(id, PERSON_CHANGED, UMBRELLA)) },
      receipts: { identity: Object.fromEntries([...ids, ...late].map((id) => [id, [UMBRELLA]])) },
    });
    /** People's pages as `page:<after>/<through>` and identity's receipt reads, in call order. */
    const log: string[] = [];
    // More than a page of rows is published while the pass's second page is read.
    const { owners } = fakeOwners(state, (call) => {
      if (call.owner === 'identity' && call.params?.eventIds !== undefined) log.push('receipts');
      if (call.owner !== 'people') return undefined;
      log.push(`page:${call.params?.publishedAfter ?? ''}/${call.params?.publishedThrough ?? ''}`);
      if (call.params?.publishedThrough !== undefined && (state.published.people?.length ?? 0) === ids.length) {
        state.published.people = [...(state.published.people ?? []), ...late.map((id) => event(id, PERSON_CHANGED, UMBRELLA))];
      }
      return undefined;
    });
    const answers: PositionResponse[] = [];
    const observed = {
      position: async (owner: DataOwner, params?: PositionParams, options?: { timeoutMs?: number }) => {
        const answer = await owners.position(owner, params, options);
        if (owner === 'people') answers.push(answer);
        return answer;
      },
    } as OwnersClient;

    const result = await awaitDrained(context(observed), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    });

    expect(result).toMatchObject({ polls: 1, owners: [counts('people'), counts('identity')] });
    const pages = answers.map((answer) => ({
      listed: answer.published?.length,
      last: answer.published?.at(-1)?.seq,
      frontier: answer.publishedFrontier,
      complete: answer.publishedComplete,
      upTo: answer.publishedUpTo,
    }));
    expect(pages).toStrictEqual([
      { listed: 500, last: '500', frontier: '600', complete: false, upTo: undefined },
      { listed: 100, last: '600', frontier: '600', complete: true, upTo: 500 },
      { listed: 500, last: '1100', frontier: '1200', complete: false, upTo: undefined },
      { listed: 100, last: '1200', frontier: '1200', complete: true, upTo: 1100 },
      { listed: 0, last: undefined, frontier: '1200', complete: true, upTo: 1200 },
      { listed: 0, last: undefined, frontier: '1200', complete: true, upTo: 1200 },
    ]);
    // The page that starts the next pass ends its call; the pass continues after the receipts of what was listed are read.
    expect(log.filter((entry) => entry !== 'receipts')).toStrictEqual(['page:0/', 'page:500/600', 'page:600/', 'page:1100/1200', 'page:1200/', 'page:1200/']);
    const started = log.indexOf('page:600/');
    expect(log.slice(started + 1, log.indexOf('page:1100/1200'))).toStrictEqual(Array.from({ length: 6 }, () => 'receipts'));
  });

  it('checks the count behind the cursor only on the page that completes a pass, starting the listing over on a mismatch', async () => {
    // Even seqs, so a row can commit behind the cursor at an odd one.
    const ids = Array.from({ length: 2 * PUBLISHED_PAGE_LIMIT + 100 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const behind = `f0000000-0000-4000-8000-${'e'.repeat(12)}`;
    const state = world({
      published: { people: ids.map((id, i) => ({ ...event(id, PERSON_CHANGED, UMBRELLA), seq: String(2 * (i + 1)) })) },
      receipts: { identity: Object.fromEntries([...ids, behind].map((id) => [id, [UMBRELLA]])) },
    });
    const { owners, calls } = fakeOwners(state, (call) => {
      if (call.owner === 'people' && call.params?.publishedAfter === '1000' && call.params.publishedThrough !== undefined) {
        state.published.people = [...(state.published.people ?? []), { ...event(behind, PERSON_CHANGED, UMBRELLA), seq: '501' }];
      }
      return undefined;
    });

    const result = await awaitDrained(context(owners), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    });

    expect(result).toMatchObject({ polls: 1, owners: [counts('people'), counts('identity')] });
    const people = calls.filter((call) => call.owner === 'people').map((call) => [call.params?.publishedAfter, call.params?.publishedThrough]);
    // The second page, incomplete, carries no count; the third completes the pass and finds the row behind the cursor.
    expect(people.slice(0, 4)).toStrictEqual([
      ['0', undefined],
      ['1000', '2200'],
      ['2000', '2200'],
      ['0', undefined],
    ]);
    expect(new Set(calls.flatMap((call) => call.params?.eventIds ?? []))).toStrictEqual(new Set([...ids, behind]));
  });

  it('starts a publisher’s listing over when an event committed behind its cursor appears there', async () => {
    const state = world({
      published: { people: [{ ...event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process'), seq: '2' }] },
      receipts: { identity: { [EVENT_A]: [UMBRELLA], [EVENT_B]: [UMBRELLA] } },
    });
    // EVENT_B's seq was assigned before EVENT_A's, but it commits only after the cursor passed it.
    const { owners, calls } = fakeOwners(state, (call) => {
      const listed = state.published.people ?? [];
      if (call.owner === 'identity' && !listed.some((entry) => entry.eventId === EVENT_B)) {
        state.published.people = [{ ...event(EVENT_B, PERSON_CHANGED, UMBRELLA, 'process'), seq: '1' }, ...listed];
      }
      return undefined;
    });

    const result = await awaitDrained(context(owners), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    });

    expect(result).toMatchObject({ polls: 1, owners: [counts('people'), counts('identity')] });
    expect(calls.filter((call) => call.owner === 'people').map((call) => call.params?.publishedAfter)).toStrictEqual(['0', '2', '0', '2']);
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual([consumerCall('identity', [EVENT_A]), consumerCall('identity', [EVENT_B, EVENT_A])]);
  });

  it('waits while an unpublished row blocks a publisher’s listing, then throws DrainTimeoutError naming the consumer’s unlisted publisher', async () => {
    const state = world({ published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process')] }, blocked: { people: '1' } });
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['strategies-content'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pollIntervalMs: 500,
      sleep: steppingSleep(clock),
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      message: 'drain timed out after 1000 ms: identity(pendingReceipts=0, unlisted=people)',
      owners: [counts('identity', 0, 0, 0, { unlisted: ['people'] })],
      unavailable: {},
    });
    // The second round continues the pass through the frontier the first page reported, which the blocked row's seq sets.
    expect(calls.filter((call) => call.owner === 'people')).toEqual([listCall('people', [PERSON_CHANGED]), listCall('people', [PERSON_CHANGED], '0', '1')]);
  });

  it('polls until every owner is drained, sleeping pollIntervalMs between rounds, and reports the rounds and elapsed time', async () => {
    const state = world({ outbox: { people: { unpublished: 2, held: 0 } } });
    const clock = steppingClock();
    const sleep = steppingSleep(clock, (pauses) => {
      state.outbox.people = { unpublished: 2 - pauses, held: 0 };
    });
    const { owners, calls, timeouts } = fakeOwners(state);
    const { pubsub } = fakePubSub(IDENTITY_DECLARED, state);

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 10_000,
      pollIntervalMs: 250,
      sleep,
      pubsub,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('identity')], polls: 3, elapsedMs: 500 });
    expect(sleep.mock.calls).toStrictEqual([[250], [250]]);
    expect(calls.map((call) => call.owner)).toStrictEqual(Array.from({ length: 3 }, () => ['people', 'identity', 'programs-sites']).flat());
    // Bounded by the service-call bound, then by what is left of the budget.
    expect(timeouts).toStrictEqual([10_000, 9750, 9500].flatMap((timeoutMs) => [timeoutMs, timeoutMs, timeoutMs]));
  });

  it('ensures the outbox sweep chain once per drain for each sweep producer with unpublished or held rows', async () => {
    const { client, calls } = fakeClient();
    const state = world({
      outbox: {
        identity: { unpublished: 1, held: 0 },
        people: { unpublished: 0, held: 2 },
        'programs-sites': { unpublished: 0, held: 0 },
        'strategies-content': { unpublished: 3, held: 0 },
      },
    });
    const { owners } = fakeOwners(state);
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => {
      for (const owner of ['identity', 'people', 'strategies-content'] as const) state.outbox[owner] = { unpublished: 0, held: 0 };
      return Promise.resolve();
    });

    const result = await awaitDrained(context(owners, client), {
      owners: ['identity', 'people', 'programs-sites', 'strategies-content'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      sleep,
      pubsub: fakePubSub(IDENTITY_DECLARED).pubsub,
    });

    expect(calls).toStrictEqual([ensureRequest('identity', 1000), ensureRequest('people', 1000)]);
    expect(result.polls).toBe(2);
    expect(result.owners).toContainEqual(counts('strategies-content'));
  });

  it('propagates a failed sweep ensure before sleeping or polling again', async () => {
    const { client, calls } = fakeClient(503);
    const { owners, calls: positions } = fakeOwners(world({ outbox: { people: { unpublished: 1, held: 0 } } }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(
      awaitDrained(context(owners, client), { owners: ['people'], timeoutMs: 1000, sleep, pubsub: fakePubSub(PEOPLE_DECLARED).pubsub }),
    ).rejects.toThrow('Queue control ensure of people-outbox-sweep on people answered HTTP 503');
    expect(calls).toStrictEqual([ensureRequest('people', 1000)]);
    expect(positions.map((call) => call.owner)).toStrictEqual(['people', 'identity', 'programs-sites']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each<[string, ServiceUnavailableError, number, boolean]>([
    ['refused while budget is left, propagating it', refused('people'), 0, false],
    ['cut short at the deadline, counting the producer unavailable and timing out', timedOut('people'), 700, true],
  ])('bounds the sweep ensure by what is left of the budget, an ensure %s', async (_label, failure, tookMs, timesOut) => {
    const clock = steppingClock();
    const requests: ServiceRequest[] = [];
    const client: ServiceClient = {
      request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        requests.push(req);
        clock.advance(tookMs);
        return Promise.reject(failure);
      },
      close: () => Promise.resolve(),
    };
    const { owners } = fakeOwners(world({ outbox: { people: { unpublished: 1, held: 0 } } }), () => {
      clock.advance(100);
      return undefined;
    });

    const outcome = await awaitDrained(context(owners, client, clock), {
      owners: ['people'],
      timeoutMs: 1000,
      sleep: steppingSleep(clock),
      pubsub: fakePubSub(PEOPLE_DECLARED).pubsub,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Three position calls of 100 ms each precede the ensure.
    expect(requests).toStrictEqual([ensureRequest('people', 700)]);
    if (timesOut) {
      expect(outcome).toBeInstanceOf(DrainTimeoutError);
      expect(outcome).toMatchObject({ owners: [counts('people', 1)], unavailable: { people: `${failure.message}; drain budget spent during the call` } });
    } else {
      expect(outcome).toBe(failure);
    }
  });

  it.each<[string, (call: PositionCall) => boolean, Error]>([
    ['the listing', (call) => call.owner === 'people' && call.params?.eventIds === undefined, new Error('Service people answered with invalid JSON')],
    ['the receipt check', (call) => call.params?.eventIds !== undefined, new OwnerCallError('identity', 'GET', '/internal/v1/migration/position', 500, {})],
  ])('propagates an owner failure other than unavailability in %s at once', async (_label, fails, failure) => {
    const state = world({ published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA)] } });
    const { owners } = fakeOwners(state, (call) => (fails(call) ? failure : undefined));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(
      awaitDrained(context(owners), {
        owners: ['people'],
        consumersWriting: ['identity.user_account'],
        timeoutMs: 1000,
        sleep,
        pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
      }),
    ).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each<[string, () => Error]>([
    ['refuses the connection', () => refused('identity')],
    ['answers HTTP 503', () => new OwnerCallError('identity', 'GET', '/internal/v1/migration/position', 503, { error: 'unavailable' })],
  ])('asks a consumer that %s again in the next rounds, and drains once it answers with the receipt', async (_label, failure) => {
    const state = world({
      outbox: { people: { unpublished: 0, held: 0 } },
      published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process')] },
      receipts: { identity: { [EVENT_A]: [UMBRELLA] } },
    });
    const clock = steppingClock();
    let down = true;
    const sleep = steppingSleep(clock, (pauses) => {
      if (pauses === 2) down = false;
    });
    const { owners, calls } = fakeOwners(state, (call) => (down && call.owner === 'identity' ? failure() : undefined));
    const { pubsub, peeked } = fakePubSub(IDENTITY_DECLARED, state);

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 300_000,
      pollIntervalMs: 1000,
      sleep,
      pubsub,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('identity')], polls: 3, elapsedMs: 2000 });
    expect(calls.filter((call) => call.params?.eventIds !== undefined)).toEqual(Array.from({ length: 3 }, () => consumerCall('identity', [EVENT_A])));
    // No dead letter is sought for a delivery its consumer could not be asked about.
    expect(peeked).toStrictEqual([]);
  });

  it('throws DrainTimeoutError naming every owner still unavailable at the deadline, a producer with unknown counts included', async () => {
    const state = world({ outbox: { people: { unpublished: 0, held: 0 } }, published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process')] } });
    const { owners } = fakeOwners(state, (call) => {
      if (call.owner === 'identity') return refused('identity');
      return call.owner === 'strategies-content' ? refused('strategies-content') : undefined;
    });
    const clock = steppingClock();

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people', 'strategies-content'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      sleep: steppingSleep(clock),
      pubsub: fakePubSub(IDENTITY_DECLARED, state).pubsub,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const contentDown = 'Service strategies-content unavailable (ECONNREFUSED)';
    const identityDown = 'Service identity unavailable (ECONNREFUSED)';
    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      message:
        'drain timed out after 1000 ms: strategies-content(unpublished=0, held=0), identity(pendingReceipts=1); ' +
        `unavailable: identity (${identityDown}), strategies-content (${contentDown})`,
      owners: [counts('strategies-content', 0, 0, 0, { unavailable: contentDown }), counts('identity', 0, 0, 1, { unavailable: identityDown })],
      unavailable: { identity: identityDown, 'strategies-content': contentDown },
    });
  });

  it('fails when a publisher answers without the published events it was asked for', async () => {
    const { owners } = fakeOwners(world());
    const unlisted: OwnersClient = { ...owners, position: async (owner, params) => ({ ...(await owners.position(owner, params)), published: undefined }) };

    await expect(
      awaitDrained(context(unlisted), {
        owners: ['people'],
        consumersWriting: ['identity.user_account'],
        timeoutMs: 1000,
        pubsub: fakePubSub(IDENTITY_DECLARED).pubsub,
      }),
    ).rejects.toThrow('Owner people answered position without the asked published events');
  });

  it('creates its Pub/Sub client from ctx.env and closes it when the drain ends, drained or failed', async () => {
    const state = world({ outbox: { 'programs-sites': { unpublished: 1, held: 0 } } });
    const { owners } = fakeOwners(state);
    const created = [fakePubSub(PROGRAMS_SITES_DECLARED).pubsub, fakePubSub(PROGRAMS_SITES_DECLARED).pubsub] as const;
    vi.mocked(createPubSub).mockReturnValueOnce(created[0]).mockReturnValueOnce(created[1]);

    await expect(awaitDrained(context(owners), { owners: ['programs-sites'], timeoutMs: 0 })).rejects.toThrow(DrainTimeoutError);
    state.outbox['programs-sites'] = { unpublished: 0, held: 0 };
    await expect(awaitDrained(context(owners), { owners: ['programs-sites'], timeoutMs: 1000 })).resolves.toMatchObject({ polls: 1 });

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
        'strategies-content': { unpublished: 0, held: 0 },
      },
      published: { identity: [event(EVENT_A, GROUP_CHANGED, TENANT_A)], people: [event(EVENT_B, PERSON_CHANGED, UMBRELLA)] },
    });
    const { owners, calls } = fakeOwners(state);
    const clock = steppingClock();
    const sleep = steppingSleep(clock);
    const options: AwaitDrainedOptions = {
      owners: ['people', 'identity', 'strategies-content'],
      consumersWriting: ['people.person', 'identity.user_account'],
      timeoutMs: 1000,
      pollIntervalMs: 400,
      sleep,
      pubsub: fakePubSub([...PEOPLE_DECLARED, ...IDENTITY_DECLARED], state).pubsub,
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
        'drain timed out after 1000 ms: people(unpublished=2, held=1, pendingReceipts=1), identity(unpublished=1, held=0, pendingReceipts=1)',
      timeoutMs: 1000,
      owners: [counts('people', 2, 1, 1), counts('identity', 1, 0, 1)],
    });
    expect(sleep.mock.calls).toStrictEqual([[400], [400], [200]]);
    // The first round lists, proves what it listed and lists again; each later round proves then lists, and none starts past the deadline.
    expect(calls).toHaveLength(4 + 2 + 4 + 2 * (2 + 4));
  });

  it('throws DrainTimeoutError before subscription discovery or any position call when timeoutMs is zero', async () => {
    const { owners, calls } = fakeOwners(world({ outbox: { 'programs-sites': { unpublished: 1, held: 0 } } }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const { pubsub } = fakePubSub(PROGRAMS_SITES_DECLARED);
    const listed = vi.spyOn(pubsub, 'getSubscriptions');

    await expect(awaitDrained(context(owners), { owners: ['programs-sites'], timeoutMs: 0, sleep, pubsub })).rejects.toThrow(
      new DrainTimeoutError(0, [], { pubsub: 'drain budget spent before subscription discovery' }),
    );
    expect(listed).not.toHaveBeenCalled();
    expect(calls).toStrictEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each<[string, (listed: MockInstance<PubSubLike['getSubscriptions']>, pubsub: PubSubLike) => void]>([
    ['the subscription listing outlasts', (listed) => listed.mockImplementation(() => wait(30).then((): [SubscriptionLike[]] => [[]]))],
    [
      'the listing ends at its gax timeout within',
      (listed) => listed.mockRejectedValue(Object.assign(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'), { code: 4 })),
    ],
    [
      'a subscription’s metadata read outlasts',
      (listed, pubsub) => {
        const live = pubsub.subscription(PROGRAMS_SITES_DECLARED[0] ?? '');
        vi.spyOn(live, 'getMetadata').mockImplementation(() => wait(30).then((): SubscriptionMetadata => [{}]));
        listed.mockResolvedValue([[live]]);
      },
    ],
  ])('throws DrainTimeoutError before any position call when %s the remaining budget', async (_label, slow) => {
    const { owners, calls } = fakeOwners(world());
    const pubsub: PubSubLike = fakePubSub(PROGRAMS_SITES_DECLARED).pubsub;
    const listed = vi.spyOn(pubsub, 'getSubscriptions');
    slow(listed, pubsub);

    const failure = await awaitDrained(context(owners), { owners: ['programs-sites'], timeoutMs: 10, pubsub }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toMatchObject({
      message: 'drain timed out after 10 ms; unavailable: pubsub (Pub/Sub subscription listing exceeded its 10 ms budget)',
      owners: [],
    });
    const listings = listed.mock.calls;
    expect(listings).toHaveLength(1);
    expect(listings[0]?.[0]?.gaxOpts?.timeout).toBeGreaterThan(0);
    expect(listings[0]?.[0]?.gaxOpts?.timeout).toBeLessThanOrEqual(10);
    expect(calls).toStrictEqual([]);
  });

  it('makes no call once the budget is spent and bounds every call by what is left of it, peeks and the sweep ensure included', async () => {
    const clock = steppingClock();
    const started = clock.now().getTime();
    const state = world({ outbox: { people: { unpublished: 1, held: 0 } }, published: { people: [event(EVENT_A, PERSON_CHANGED, UMBRELLA, 'process')] } });
    /** Every call made: when, relative to the start, and its bound. */
    const made: { kind: string; atMs: number; boundMs: number | undefined }[] = [];
    const cutShort = timedOut('identity');
    // A position call takes 500 ms, or fails at its bound when that is shorter.
    const { owners, timeouts } = fakeOwners(state, (call) => {
      const bound = timeouts.at(-1) ?? 0;
      made.push({ kind: `position:${call.owner}`, atMs: clock.now().getTime() - started, boundMs: bound });
      clock.advance(Math.min(500, bound));
      return bound < 500 ? cutShort : undefined;
    });
    const fake = fakePubSub(IDENTITY_DECLARED, state);
    const pubsub: PubSubLike = {
      ...fake.pubsub,
      peekEventIds: (fullName, options) => {
        made.push({ kind: 'peek', atMs: clock.now().getTime() - started, boundMs: options?.timeoutMs });
        clock.advance(300);
        return fake.pubsub.peekEventIds(fullName, options);
      },
    };
    const client: ServiceClient = {
      request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        made.push({ kind: `ensure:${req.service}`, atMs: clock.now().getTime() - started, boundMs: req.timeoutMs });
        return Promise.resolve({ status: 200, headers: {}, body: undefined } as ServiceResponse<T>);
      },
      close: () => Promise.resolve(),
    };

    const failure = await awaitDrained(context(owners, client, clock), {
      owners: ['people'],
      consumersWriting: ['identity.user_account'],
      timeoutMs: 3000,
      sleep: steppingSleep(clock),
      pubsub,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(made).toStrictEqual([
      { kind: 'position:people', atMs: 0, boundMs: 3000 },
      { kind: 'position:identity', atMs: 500, boundMs: 2500 },
      { kind: 'position:programs-sites', atMs: 1000, boundMs: 2000 },
      { kind: 'position:identity', atMs: 1500, boundMs: 1500 },
      { kind: 'peek', atMs: 2000, boundMs: 1000 },
      { kind: 'position:people', atMs: 2300, boundMs: 700 },
      { kind: 'position:identity', atMs: 2800, boundMs: 200 },
    ]);
    expect(failure).toBeInstanceOf(DrainTimeoutError);
    const identityCutShort = `${cutShort.message}; drain budget spent during the call`;
    expect(failure).toMatchObject({
      owners: [counts('people', 1), counts('identity', 0, 0, 1, { unlisted: ['programs-sites'], unavailable: identityCutShort })],
      unavailable: { 'programs-sites': 'drain budget spent before the call', people: 'drain budget spent before the call', identity: identityCutShort },
    });
  });

  it('sleeps DEFAULT_DRAIN_POLL_MS (1000 ms) on node timers when neither pollIntervalMs nor sleep is given', async () => {
    const state = world({ outbox: { 'programs-sites': { unpublished: 1, held: 0 } } });
    // The second round finds the row published.
    const { owners, calls, timeouts } = fakeOwners(state, (call) => {
      if (call.owner === 'programs-sites' && calls.filter((made) => made.owner === 'programs-sites').length === 2) state.outbox['programs-sites'] = { unpublished: 0, held: 0 };
      return undefined;
    });

    const result = await awaitDrained(context(owners), { owners: ['programs-sites'], timeoutMs: 60_000, pubsub: fakePubSub(PROGRAMS_SITES_DECLARED).pubsub });

    expect(DEFAULT_DRAIN_POLL_MS).toBe(1000);
    expect(delay).toHaveBeenCalledExactlyOnceWith(DEFAULT_DRAIN_POLL_MS);
    expect(result.polls).toBe(2);
    // A budget beyond the service-call bound leaves each call at that bound.
    expect(timeouts).toStrictEqual(calls.map(() => 10_000));
  });
});
