// Unit tests for the quiescence Pub/Sub adapter, using in-memory subscriptions and a stand-in GAPIC subscriber.
import { PubSub } from '@google-cloud/pubsub';
import { consumerOfSubscription, dlqReplaySubscriptionName, pushPath, subscriptionName } from '@opt2/platform/events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPubSub,
  isPushConfig,
  listOpt2Subscriptions,
  peekBacklog,
  readPushConfig,
  redactEndpoint,
  setPushConfig,
  subscriptionId,
} from '../../src/quiesce/subscriptions.js';
import type { PubSubLike, SavedPushConfig, SubscriptionLike } from '../../src/quiesce/subscriptions.js';

type PullRequest = { subscription: string; maxMessages: number; returnImmediately: boolean };
type PullResponse = { receivedMessages?: { ackId?: string | null }[] | null };
type ModifyAckDeadlineRequest = { subscription: string; ackIds: string[]; ackDeadlineSeconds: number };
type SubscriptionMetadata = Awaited<ReturnType<SubscriptionLike['getMetadata']>>[0];

const subscriber = vi.hoisted(() => ({
  created: [] as unknown[],
  pull: vi.fn<(request: PullRequest) => Promise<[PullResponse]>>(),
  modifyAckDeadline: vi.fn<(request: ModifyAckDeadlineRequest) => Promise<unknown[]>>(() => Promise.resolve([{}])),
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

const fullName = (id: string): string => `projects/${PROJECT}/subscriptions/${id}`;

/** In-memory subscription that serves `metadata` and records push-config changes and seeks. */
function fakeSubscription(name: string, metadata: SubscriptionMetadata = {}) {
  return {
    name,
    getMetadata: vi.fn<() => Promise<[SubscriptionMetadata]>>(() => Promise.resolve([metadata])),
    modifyPushConfig: vi.fn<(config: SavedPushConfig) => Promise<unknown>>(() => Promise.resolve([{}])),
    seek: vi.fn<(time: Date) => Promise<unknown>>(() => Promise.resolve([{}])),
  } satisfies SubscriptionLike;
}

/** In-memory client listing `subscriptions`; `pullOnce` is present only when given. */
function fakePubSub(subscriptions: SubscriptionLike[], pullOnce?: (fullName: string) => Promise<number>): PubSubLike {
  return {
    projectId: PROJECT,
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([subscriptions]),
    subscription: (name) => fakeSubscription(fullName(name)),
    close: () => Promise.resolve(),
    ...(pullOnce === undefined ? {} : { pullOnce }),
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
    subscriber.close.mockClear();
  });

  it('returns a client for GOOGLE_CLOUD_PROJECT exposing getSubscriptions, subscription, close and pullOnce', () => {
    const client: PubSubLike = create({ GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: EMULATOR });

    expect(client.projectId).toBe(PROJECT);
    expect(typeof client.getSubscriptions).toBe('function');
    expect(typeof client.close).toBe('function');
    expect(typeof client.pullOnce).toBe('function');
    expect(client.subscription(TIMESHEETS_ARCHIVED).name).toBe(fullName(TIMESHEETS_ARCHIVED));
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
});
