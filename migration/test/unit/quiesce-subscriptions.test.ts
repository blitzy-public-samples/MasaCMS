// Unit tests for the quiescence Pub/Sub adapter, using in-memory subscriptions and a stand-in GAPIC subscriber.
import { Buffer } from 'node:buffer';

import { PubSub } from '@google-cloud/pubsub';
import { consumerOfSubscription, dlqReplaySubscriptionName, pushPath, subscriptionName } from '@opt2/platform/events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPubSub,
  createWitnessSubscription,
  isPushConfig,
  listOpt2Subscriptions,
  listSubscriptionIds,
  listTopicIds,
  openMessageLease,
  peekBacklog,
  peekDeadLetterEventIds,
  readPushConfig,
  redactEndpoint,
  removeSubscription,
  setPushConfig,
  subscriptionId,
  witnessName,
  witnessPrefix,
} from '../../src/quiesce/subscriptions.js';
import type { MessageLease, PubSubLike, SavedPushConfig, SubscriptionLike } from '../../src/quiesce/subscriptions.js';

type PullRequest = { subscription: string; maxMessages: number; returnImmediately: boolean };
interface PulledMessage {
  messageId?: string | null;
  attributes?: Record<string, string> | null;
  data?: Buffer | string | null;
  publishTime?: { seconds?: number | string | null; nanos?: number | null } | null;
  orderingKey?: string | null;
}
interface PullResponse {
  receivedMessages?: { ackId?: string | null; message?: PulledMessage | null; deliveryAttempt?: number | null }[] | null;
}
type ModifyAckDeadlineRequest = { subscription: string; ackIds: string[]; ackDeadlineSeconds: number };
type AcknowledgeRequest = { subscription: string; ackIds: string[] };
type SubscriptionMetadata = Awaited<ReturnType<SubscriptionLike['getMetadata']>>[0];

const subscriber = vi.hoisted(() => ({
  created: [] as unknown[],
  pull: vi.fn<(request: PullRequest) => Promise<[PullResponse]>>(),
  modifyAckDeadline: vi.fn<(request: ModifyAckDeadlineRequest) => Promise<unknown[]>>(() => Promise.resolve([{}])),
  acknowledge: vi.fn<(request: AcknowledgeRequest) => Promise<unknown[]>>(() => Promise.resolve([{}])),
  close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('@google-cloud/pubsub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google-cloud/pubsub')>();
  /** GAPIC subscriber stand-in that records its options and calls instead of opening a connection. */
  class FakeSubscriberClient {
    constructor(options: unknown) {
      subscriber.created.push(options);
    }
    pull(request: PullRequest): Promise<[PullResponse]> {
      return subscriber.pull(request);
    }
    modifyAckDeadline(request: ModifyAckDeadlineRequest): Promise<unknown[]> {
      return subscriber.modifyAckDeadline(request);
    }
    acknowledge(request: AcknowledgeRequest): Promise<unknown[]> {
      return subscriber.acknowledge(request);
    }
    close(): Promise<void> {
      return subscriber.close();
    }
  }
  return { ...actual, v1: { ...actual.v1, SubscriberClient: FakeSubscriberClient } };
});

vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  return { ...actual, consumerOfSubscription: vi.fn(actual.consumerOfSubscription) };
});

const PROJECT = 'opt2-unit';
const EMULATOR = 'localhost:8085';
const ARCHIVED = 'people.person.archived.v1';
const GROUP_CHANGED = 'identity.group.changed.v1';
const LOGIN_MAIL = 'identity.login-mail.requested.v1';
const TIMESHEETS_ARCHIVED = subscriptionName('timesheets', ARCHIVED);
const PEOPLE_GROUP = subscriptionName('people', GROUP_CHANGED);
const CONTENT_GROUP = subscriptionName('strategies-content', GROUP_CHANGED);
const COMMUNICATIONS_LOGIN_MAIL = subscriptionName('communications', LOGIN_MAIL);
const LOCAL_PUSH_ENDPOINT = `http://127.0.0.1:20118${pushPath(TIMESHEETS_ARCHIVED)}?key=unit-push-key`;
const SAVED_LOCAL_PUSH: SavedPushConfig = {
  pushEndpoint: LOCAL_PUSH_ENDPOINT,
  attributes: {},
  noWrapper: { writeMetadata: false },
  wrapper: 'noWrapper',
};

const DLQ_REPLAY = dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED);
const EVENT_A = 'a0000000-0000-4000-8000-00000000000a';
const EVENT_B = 'b0000000-0000-4000-8000-00000000000b';

const fullName = (id: string): string => `projects/${PROJECT}/subscriptions/${id}`;

/** A pulled dead letter whose event id travels in its `eventId` attribute or only in its envelope data. */
function pulled(ackId: string, messageId: string, eventId: { attribute?: string; data?: string } = {}): { ackId: string; message: PulledMessage } {
  const attributes: Record<string, string> = eventId.attribute === undefined ? {} : { eventId: eventId.attribute, reason: 'invalid-tenant' };
  return { ackId, message: { messageId, attributes, ...(eventId.data === undefined ? {} : { data: Buffer.from(eventId.data, 'utf8') }) } };
}

/** In-memory subscription that serves `metadata` and records push-config changes and seeks. */
function fakeSubscription(name: string, metadata: SubscriptionMetadata = {}) {
  return {
    name,
    getMetadata: vi.fn<() => Promise<[SubscriptionMetadata]>>(() => Promise.resolve([metadata])),
    modifyPushConfig: vi.fn<(config: SavedPushConfig) => Promise<unknown>>(() => Promise.resolve([{}])),
    seek: vi.fn<(time: Date) => Promise<unknown>>(() => Promise.resolve([{}])),
  } satisfies SubscriptionLike;
}

/** In-memory client listing `subscriptions`; `pullOnce`, `peekEventIds` and `leaseMessages` are present only when given, like `extra`'s members. */
function fakePubSub(
  subscriptions: SubscriptionLike[],
  pullOnce?: (fullName: string) => Promise<number>,
  peekEventIds?: (fullName: string) => Promise<string[]>,
  leaseMessages?: (fullName: string) => Promise<MessageLease>,
  extra: Pick<PubSubLike, 'topicIds' | 'createWitness' | 'deleteSubscription'> = {},
): PubSubLike {
  return {
    projectId: PROJECT,
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([subscriptions]),
    subscription: (name) => fakeSubscription(fullName(name)),
    close: () => Promise.resolve(),
    ...(pullOnce === undefined ? {} : { pullOnce }),
    ...(peekEventIds === undefined ? {} : { peekEventIds }),
    ...(leaseMessages === undefined ? {} : { leaseMessages }),
    ...extra,
  };
}

describe('subscriptionId', () => {
  it.each([
    [fullName(TIMESHEETS_ARCHIVED), TIMESHEETS_ARCHIVED],
    [TIMESHEETS_ARCHIVED, TIMESHEETS_ARCHIVED],
  ])('maps %s to the short id %s', (name, expected) => {
    expect(subscriptionId(name)).toBe(expected);
  });
});

describe('listOpt2Subscriptions', () => {
  it('returns only <consumer>.<topic> subscriptions, sorted by name, with consumer, topic and ordering from metadata', async () => {
    const timesheets = fakeSubscription(fullName(TIMESHEETS_ARCHIVED), {
      enableMessageOrdering: true,
      pushConfig: { pushEndpoint: LOCAL_PUSH_ENDPOINT },
    });
    const content = fakeSubscription(fullName(CONTENT_GROUP), { enableMessageOrdering: null });
    const communications = fakeSubscription(COMMUNICATIONS_LOGIN_MAIL, { enableMessageOrdering: false });
    const people = fakeSubscription(fullName(PEOPLE_GROUP));
    const replay = fakeSubscription(fullName(dlqReplaySubscriptionName(TIMESHEETS_ARCHIVED)), { enableMessageOrdering: true });
    const foreign = [
      'legacy-mail-queue',
      'Timesheets.people.person.archived.v1',
      'timesheets.people.person.archived',
      'timesheets.people.person.archived.v0',
      witnessName('pubsub-redelivery', '0badc0de', GROUP_CHANGED),
    ].map((name) => fakeSubscription(fullName(name), { enableMessageOrdering: true }));
    const excluded = [replay, ...foreign];

    const found = await listOpt2Subscriptions(fakePubSub([timesheets, replay, content, ...foreign, communications, people]));

    expect(found).toStrictEqual([
      { name: COMMUNICATIONS_LOGIN_MAIL, consumer: 'communications', topic: LOGIN_MAIL, ordered: false, subscription: communications },
      { name: PEOPLE_GROUP, consumer: 'people', topic: GROUP_CHANGED, ordered: false, subscription: people },
      { name: CONTENT_GROUP, consumer: 'strategies-content', topic: GROUP_CHANGED, ordered: false, subscription: content },
      { name: TIMESHEETS_ARCHIVED, consumer: 'timesheets', topic: ARCHIVED, ordered: true, subscription: timesheets },
    ]);
    for (const subscription of excluded) {
      expect(subscription.getMetadata).not.toHaveBeenCalled();
    }
  });

  it('propagates an error other than InvalidEventNameError raised while classifying a name', async () => {
    const failure = new RangeError('classification failed');
    vi.mocked(consumerOfSubscription).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(listOpt2Subscriptions(fakePubSub([fakeSubscription(fullName(TIMESHEETS_ARCHIVED))]))).rejects.toBe(failure);
  });
});

describe('isPushConfig', () => {
  it.each([
    [true, { pushEndpoint: LOCAL_PUSH_ENDPOINT }],
    [false, { pushEndpoint: '' }],
    [false, { pushEndpoint: null }],
    [false, { pushEndpoint: 8085 }],
    [false, {}],
    [false, null],
    [false, undefined],
    [false, LOCAL_PUSH_ENDPOINT],
  ])('returns %s for %j', (expected, cfg) => {
    expect(isPushConfig(cfg)).toBe(expected);
  });
});

describe('readPushConfig', () => {
  it.each([
    ['an empty pushEndpoint', { pushConfig: { pushEndpoint: '', attributes: {} } }],
    ['a null pushConfig', { pushConfig: null }],
    ['no pushConfig', {}],
  ])('returns null for a pull subscription with %s', async (_label, metadata: SubscriptionMetadata) => {
    expect(await readPushConfig(fakeSubscription(fullName(TIMESHEETS_ARCHIVED), metadata))).toBeNull();
  });

  it('returns a JSON-safe deep copy of a push config without its null oneof members', async () => {
    const pushConfig = {
      pushEndpoint: LOCAL_PUSH_ENDPOINT,
      attributes: {},
      oidcToken: null,
      pubsubWrapper: null,
      noWrapper: { writeMetadata: false },
      wrapper: 'noWrapper',
    };

    const saved = await readPushConfig(fakeSubscription(fullName(TIMESHEETS_ARCHIVED), { pushConfig }));

    expect(saved).toStrictEqual(SAVED_LOCAL_PUSH);
    expect(saved).not.toBe(pushConfig);
    expect(saved?.noWrapper).not.toBe(pushConfig.noWrapper);
    expect(JSON.parse(JSON.stringify(saved))).toStrictEqual(saved);
  });
});

describe('setPushConfig', () => {
  it.each([
    ['a saved push config', SAVED_LOCAL_PUSH],
    ['{} (pull delivery)', {}],
  ])('hands %s to modifyPushConfig byte-identical after a JSON round-trip', async (_label, config: SavedPushConfig) => {
    const stored = JSON.stringify(config);
    const subscription = fakeSubscription(fullName(TIMESHEETS_ARCHIVED));

    await setPushConfig(subscription, JSON.parse(stored) as SavedPushConfig);

    expect(subscription.modifyPushConfig).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(subscription.modifyPushConfig.mock.calls[0]?.[0])).toBe(stored);
  });

  it('propagates a modifyPushConfig failure', async () => {
    const failure = new Error('5 NOT_FOUND: Subscription does not exist');
    const subscription = fakeSubscription(fullName(TIMESHEETS_ARCHIVED));
    subscription.modifyPushConfig.mockRejectedValueOnce(failure);

    await expect(setPushConfig(subscription, {})).rejects.toBe(failure);
  });
});

describe('redactEndpoint', () => {
  it.each([
    ['drops the query string that carries the push key', 'http://h:1/internal/v1/events/x?key=s', 'http://h:1/internal/v1/events/x'],
    ['leaves a URL without a query unchanged', 'http://h:1/internal/v1/events/x', 'http://h:1/internal/v1/events/x'],
  ])('%s', (_title, url, expected) => {
    const redacted = redactEndpoint(url);

    expect(redacted).toBe(expected);
    expect(redacted).not.toContain('key=');
    expect(redacted).toContain('/internal/v1/events/x');
  });
});

describe('peekBacklog with an injected client', () => {
  it.each([0, 1])('resolves to %i, the count pullOnce returns for the fully qualified subscription', async (count) => {
    const pullOnce = vi.fn<(fullName: string) => Promise<number>>(() => Promise.resolve(count));

    expect(await peekBacklog(fakePubSub([], pullOnce), TIMESHEETS_ARCHIVED)).toBe(count);
    expect(pullOnce).toHaveBeenCalledExactlyOnceWith(fullName(TIMESHEETS_ARCHIVED));
  });

  it('rejects with a TypeError when the client has no pullOnce', async () => {
    await expect(peekBacklog(fakePubSub([]), TIMESHEETS_ARCHIVED)).rejects.toThrow(TypeError);
  });
});

describe('peekDeadLetterEventIds with an injected client', () => {
  it('resolves to the event ids peekEventIds reads from the fully qualified DLQ replay subscription', async () => {
    const peekEventIds = vi.fn<(fullName: string) => Promise<string[]>>(() => Promise.resolve([EVENT_A]));

    expect(await peekDeadLetterEventIds(fakePubSub([], undefined, peekEventIds), TIMESHEETS_ARCHIVED)).toStrictEqual([EVENT_A]);
    expect(peekEventIds).toHaveBeenCalledExactlyOnceWith(fullName(DLQ_REPLAY));
  });

  it('rejects with a TypeError when the client has no peekEventIds', async () => {
    await expect(peekDeadLetterEventIds(fakePubSub([]), TIMESHEETS_ARCHIVED)).rejects.toThrow(TypeError);
  });
});

describe('witness names', () => {
  it('names a witness witness_<fault>_<runId>.<topic> under the fault prefix, which no OPT-2 or DLQ replay name matches', () => {
    const name = witnessName('pubsub-redelivery', '0badc0de', GROUP_CHANGED);

    expect(name).toBe(`witness_pubsub-redelivery_0badc0de.${GROUP_CHANGED}`);
    expect(name.startsWith(witnessPrefix('pubsub-redelivery'))).toBe(true);
    expect(name.startsWith(witnessPrefix('pubsub'))).toBe(false);
    expect(() => consumerOfSubscription(name)).toThrow();
    expect(name.endsWith('.dlq.replay')).toBe(false);
  });
});

describe('listSubscriptionIds', () => {
  it('returns the short ids that start with the prefix, sorted, without reading metadata', async () => {
    const names = [
      witnessName('pubsub-redelivery', 'bbbbbbbb', GROUP_CHANGED),
      PEOPLE_GROUP,
      witnessName('pubsub-redelivery', 'aaaaaaaa', ARCHIVED),
      witnessName('duplicate-batch', 'aaaaaaaa', ARCHIVED),
    ];
    const subscriptions = names.map((name) => fakeSubscription(fullName(name)));

    expect(await listSubscriptionIds(fakePubSub(subscriptions), witnessPrefix('pubsub-redelivery'))).toStrictEqual([
      witnessName('pubsub-redelivery', 'aaaaaaaa', ARCHIVED),
      witnessName('pubsub-redelivery', 'bbbbbbbb', GROUP_CHANGED),
    ]);
    for (const subscription of subscriptions) expect(subscription.getMetadata).not.toHaveBeenCalled();
  });
});

describe('witness helpers with an injected client', () => {
  const WITNESS = witnessName('pubsub-redelivery', '0badc0de', GROUP_CHANGED);

  it('lists the topics topicIds returns', async () => {
    const topicIds = vi.fn<() => Promise<string[]>>(() => Promise.resolve([ARCHIVED, GROUP_CHANGED]));

    expect(await listTopicIds(fakePubSub([], undefined, undefined, undefined, { topicIds }))).toStrictEqual([ARCHIVED, GROUP_CHANGED]);
  });

  it('creates the witness with createWitness on the topic and deletes it with deleteSubscription, both by short id', async () => {
    const createWitness = vi.fn<(topic: string, name: string) => Promise<void>>(() => Promise.resolve());
    const deleteSubscription = vi.fn<(name: string) => Promise<void>>(() => Promise.resolve());
    const pubsub = fakePubSub([], undefined, undefined, undefined, { createWitness, deleteSubscription });

    await createWitnessSubscription(pubsub, GROUP_CHANGED, WITNESS);
    await removeSubscription(pubsub, WITNESS);

    expect(createWitness).toHaveBeenCalledExactlyOnceWith(GROUP_CHANGED, WITNESS);
    expect(deleteSubscription).toHaveBeenCalledExactlyOnceWith(WITNESS);
  });

  it.each([
    ['listTopicIds', (pubsub: PubSubLike) => listTopicIds(pubsub)],
    ['createWitnessSubscription', (pubsub: PubSubLike) => createWitnessSubscription(pubsub, GROUP_CHANGED, WITNESS)],
    ['removeSubscription', (pubsub: PubSubLike) => removeSubscription(pubsub, WITNESS)],
  ])('%s rejects with a TypeError when the client lacks its member', async (_name, call) => {
    await expect(call(fakePubSub([]))).rejects.toThrow(TypeError);
  });
});

describe('openMessageLease with an injected client', () => {
  it('resolves to the lease leaseMessages opens on the fully qualified subscription', async () => {
    const lease: MessageLease = { pull: vi.fn(), acknowledge: vi.fn(), release: vi.fn(), close: vi.fn() };
    const leaseMessages = vi.fn<(fullName: string) => Promise<MessageLease>>(() => Promise.resolve(lease));

    expect(await openMessageLease(fakePubSub([], undefined, undefined, leaseMessages), TIMESHEETS_ARCHIVED)).toBe(lease);
    expect(leaseMessages).toHaveBeenCalledExactlyOnceWith(fullName(TIMESHEETS_ARCHIVED));
  });

  it('rejects with a TypeError when the client has no leaseMessages', async () => {
    await expect(openMessageLease(fakePubSub([]), TIMESHEETS_ARCHIVED)).rejects.toThrow(TypeError);
  });
});

describe('createPubSub', () => {
  const clients: PubSubLike[] = [];

  function create(env: Parameters<typeof createPubSub>[0]): PubSub {
    const client = createPubSub(env);
    clients.push(client);
    expect(client).toBeInstanceOf(PubSub);
    return client as PubSub;
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    subscriber.created.length = 0;
    subscriber.pull.mockReset();
    subscriber.modifyAckDeadline.mockClear();
    subscriber.acknowledge.mockClear();
    subscriber.close.mockClear();
  });

  it('returns a client for GOOGLE_CLOUD_PROJECT exposing every PubSubLike member', () => {
    const client: PubSubLike = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });

    expect(client.projectId).toBe(PROJECT);
    expect(typeof client.getSubscriptions).toBe('function');
    expect(typeof client.close).toBe('function');
    expect(typeof client.pullOnce).toBe('function');
    expect(typeof client.peekEventIds).toBe('function');
    expect(typeof client.leaseMessages).toBe('function');
    expect(typeof client.topicIds).toBe('function');
    expect(typeof client.createWitness).toBe('function');
    expect(typeof client.deleteSubscription).toBe('function');
    expect(client.subscription(TIMESHEETS_ARCHIVED).name).toBe(fullName(TIMESHEETS_ARCHIVED));
  });

  it('topicIds lists the project topics as short ids, sorted', async () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    const topics = [ARCHIVED, GROUP_CHANGED].map((topic) => ({ name: `projects/${PROJECT}/topics/${topic}` }));
    const getTopics = vi.spyOn(client, 'getTopics').mockResolvedValue([topics] as unknown as Awaited<ReturnType<PubSub['getTopics']>>);

    expect(await listTopicIds(client)).toStrictEqual([GROUP_CHANGED, ARCHIVED]);
    expect(getTopics).toHaveBeenCalledTimes(1);
  });

  it('createWitness creates a plain pull subscription on the topic', async () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    const name = witnessName('pubsub-redelivery', '0badc0de', GROUP_CHANGED);
    const createSubscription = vi
      .spyOn(client, 'createSubscription')
      .mockResolvedValue([{}, {}] as unknown as Awaited<ReturnType<PubSub['createSubscription']>>);

    await createWitnessSubscription(client, GROUP_CHANGED, name);

    expect(createSubscription).toHaveBeenCalledExactlyOnceWith(GROUP_CHANGED, name);
  });

  it.each([
    ['resolves after deleting the subscription', undefined, undefined],
    ['resolves when the subscription does not exist', Object.assign(new Error('5 NOT_FOUND: Subscription does not exist'), { code: 5 }), undefined],
    ['propagates any other failure', Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }), '7 PERMISSION_DENIED'],
  ])('deleteSubscription %s', async (_title, failure: Error | undefined, rejection: string | undefined) => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    const name = witnessName('pubsub-redelivery', '0badc0de', GROUP_CHANGED);
    const subscription = client.subscription(name);
    const remove = vi.spyOn(subscription, 'delete').mockImplementation(() => (failure === undefined ? Promise.resolve([{}]) : Promise.reject(failure)));
    vi.spyOn(client, 'subscription').mockReturnValue(subscription);

    const deleted = removeSubscription(client, name);

    if (rejection === undefined) await expect(deleted).resolves.toBeUndefined();
    else await expect(deleted).rejects.toThrow(rejection);
    expect(client.subscription).toHaveBeenCalledWith(name);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('targets the emulator with apiEndpoint and emulatorMode when PUBSUB_EMULATOR_HOST is set', () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });

    expect(client.options).toMatchObject({ projectId: PROJECT, apiEndpoint: EMULATOR, emulatorMode: true });
    expect(client.isEmulator).toBe(true);
  });

  it('passes neither apiEndpoint nor emulatorMode when PUBSUB_EMULATOR_HOST is unset', () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT });

    expect(client.options.projectId).toBe(PROJECT);
    expect(client.options).not.toHaveProperty('apiEndpoint');
    expect(client.options).not.toHaveProperty('emulatorMode');
  });

  it.each([
    [1, 'one message', { receivedMessages: [{ ackId: 'ack-1' }] }, ['ack-1']],
    [0, 'no messages', { receivedMessages: [] }, undefined],
    [0, 'unset receivedMessages', { receivedMessages: null }, undefined],
  ])(
    'pullOnce resolves to %i for a pull returning %s and releases any received message unacked',
    async (count, _label, response: PullResponse, releasedAckIds: string[] | undefined) => {
      const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
      subscriber.pull.mockResolvedValueOnce([response]);

      expect(await peekBacklog(client, TIMESHEETS_ARCHIVED)).toBe(count);

      expect(subscriber.created).toStrictEqual([client.options]);
      expect(subscriber.pull).toHaveBeenCalledExactlyOnceWith({
        subscription: fullName(TIMESHEETS_ARCHIVED),
        maxMessages: 1,
        returnImmediately: true,
      });
      if (releasedAckIds === undefined) {
        expect(subscriber.modifyAckDeadline).not.toHaveBeenCalled();
      } else {
        expect(subscriber.modifyAckDeadline).toHaveBeenCalledExactlyOnceWith({
          subscription: fullName(TIMESHEETS_ARCHIVED),
          ackIds: releasedAckIds,
          ackDeadlineSeconds: 0,
        });
      }
      expect(subscriber.close).toHaveBeenCalledTimes(1);
    },
  );

  it('closes the subscriber client and propagates a failed pull', async () => {
    const failure = new Error('14 UNAVAILABLE: No connection established');
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    subscriber.pull.mockRejectedValueOnce(failure);

    await expect(peekBacklog(client, TIMESHEETS_ARCHIVED)).rejects.toBe(failure);
    expect(subscriber.modifyAckDeadline).not.toHaveBeenCalled();
    expect(subscriber.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty pull', { receivedMessages: [] }, [['ack-1', 'ack-2', 'ack-3'], ['ack-4', 'ack-5']]],
    ['a pull of seen messages only', { receivedMessages: [pulled('ack-1b', 'm-1')] }, [['ack-1', 'ack-2', 'ack-3'], ['ack-4', 'ack-5'], ['ack-1b']]],
  ])(
    'peekEventIds pulls until %s, reads attribute or envelope event ids, and releases every lease unacked',
    async (_label, last: PullResponse, released: string[][]) => {
      const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
      subscriber.pull
        .mockResolvedValueOnce([
          {
            receivedMessages: [
              pulled('ack-1', 'm-1', { attribute: EVENT_B }),
              pulled('ack-2', 'm-2', { data: JSON.stringify({ eventId: EVENT_A }) }),
              pulled('ack-3', 'm-3', { data: 'not json' }),
            ],
          },
        ])
        .mockResolvedValueOnce([{ receivedMessages: [pulled('ack-4', 'm-4', { attribute: EVENT_A }), pulled('ack-5', 'm-5', { data: '{}' })] }])
        .mockResolvedValueOnce([last]);

      expect(await peekDeadLetterEventIds(client, TIMESHEETS_ARCHIVED)).toStrictEqual([EVENT_A, EVENT_B]);

      expect(subscriber.pull.mock.calls).toStrictEqual(
        Array.from({ length: 3 }, () => [{ subscription: fullName(DLQ_REPLAY), maxMessages: 1000, returnImmediately: true }]),
      );
      expect(subscriber.modifyAckDeadline.mock.calls).toStrictEqual(
        released.map((ackIds) => [{ subscription: fullName(DLQ_REPLAY), ackIds, ackDeadlineSeconds: 0 }]),
      );
      expect(subscriber.close).toHaveBeenCalledTimes(1);
    },
  );

  it('peekEventIds resolves to no event ids when the DLQ replay subscription does not exist', async () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    subscriber.pull.mockRejectedValueOnce(Object.assign(new Error('5 NOT_FOUND: Subscription does not exist'), { code: 5 }));

    expect(await peekDeadLetterEventIds(client, TIMESHEETS_ARCHIVED)).toStrictEqual([]);
    expect(subscriber.modifyAckDeadline).not.toHaveBeenCalled();
    expect(subscriber.close).toHaveBeenCalledTimes(1);
  });

  it('leaseMessages pulls leased messages with their push fields and acknowledges, releases and closes on the same subscription', async () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    const envelope = JSON.stringify({ eventId: EVENT_A, tenantId: 'tenant' });
    subscriber.pull.mockResolvedValueOnce([
      {
        receivedMessages: [
          {
            ackId: 'ack-1',
            message: {
              messageId: 'm-1',
              data: Buffer.from(envelope, 'utf8'),
              attributes: { eventId: EVENT_B },
              publishTime: { seconds: '1782820800', nanos: 123_456_789 },
              orderingKey: 'person-1',
            },
            deliveryAttempt: 3,
          },
          { ackId: 'ack-2', message: { messageId: 'm-2', data: Buffer.from(envelope, 'utf8').toString('base64'), orderingKey: '' }, deliveryAttempt: 0 },
          { ackId: 'ack-3', message: { messageId: 'm-3', data: null, attributes: null, publishTime: null } },
          { ackId: null, message: { messageId: 'm-4' } },
          { ackId: 'ack-5', message: null },
        ],
      },
    ]);

    const lease = await openMessageLease(client, TIMESHEETS_ARCHIVED);
    const messages = await lease.pull(10);
    await lease.acknowledge(['ack-1']);
    await lease.release(['ack-2', 'ack-3']);
    await lease.close();

    expect(messages).toStrictEqual([
      {
        ackId: 'ack-1',
        messageId: 'm-1',
        data: Buffer.from(envelope, 'utf8'),
        attributes: { eventId: EVENT_B },
        publishTime: '2026-06-30T12:00:00.123Z',
        orderingKey: 'person-1',
        deliveryAttempt: 3,
        eventId: EVENT_B,
      },
      { ackId: 'ack-2', messageId: 'm-2', data: Buffer.from(envelope, 'utf8'), attributes: {}, eventId: EVENT_A },
      { ackId: 'ack-3', messageId: 'm-3', data: Buffer.alloc(0), attributes: {} },
    ]);
    expect(subscriber.created).toStrictEqual([client.options]);
    expect(subscriber.pull).toHaveBeenCalledExactlyOnceWith({ subscription: fullName(TIMESHEETS_ARCHIVED), maxMessages: 10, returnImmediately: true });
    expect(subscriber.acknowledge).toHaveBeenCalledExactlyOnceWith({ subscription: fullName(TIMESHEETS_ARCHIVED), ackIds: ['ack-1'] });
    expect(subscriber.modifyAckDeadline).toHaveBeenCalledExactlyOnceWith({
      subscription: fullName(TIMESHEETS_ARCHIVED),
      ackIds: ['ack-2', 'ack-3'],
      ackDeadlineSeconds: 0,
    });
    expect(subscriber.close).toHaveBeenCalledTimes(1);
  });

  it('leaseMessages resolves an empty pull to no messages and sends no settlement for empty ack lists', async () => {
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    subscriber.pull.mockResolvedValueOnce([{ receivedMessages: null }]);

    const lease = await openMessageLease(client, TIMESHEETS_ARCHIVED);
    expect(await lease.pull(10)).toStrictEqual([]);
    await lease.acknowledge([]);
    await lease.release([]);
    await lease.close();

    expect(subscriber.acknowledge).not.toHaveBeenCalled();
    expect(subscriber.modifyAckDeadline).not.toHaveBeenCalled();
  });

  it('peekEventIds propagates another pull failure after releasing the leases it holds and closing the client', async () => {
    const failure = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    const client = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });
    subscriber.pull.mockResolvedValueOnce([{ receivedMessages: [pulled('ack-1', 'm-1', { attribute: EVENT_A })] }]).mockRejectedValueOnce(failure);

    await expect(peekDeadLetterEventIds(client, TIMESHEETS_ARCHIVED)).rejects.toBe(failure);
    expect(subscriber.modifyAckDeadline).toHaveBeenCalledExactlyOnceWith({
      subscription: fullName(DLQ_REPLAY),
      ackIds: ['ack-1'],
      ackDeadlineSeconds: 0,
    });
    expect(subscriber.close).toHaveBeenCalledTimes(1);
  });
});
