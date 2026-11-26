import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dlqReplaySubscriptionName, dlqTopicName, subscriptionName, topicName } from '@opt2/platform/events';

import { PACKAGE_NAMES } from '../../src/repro/ports.js';
import {
  applyLocalTopology,
  deriveTopology,
  isTopologySubscriptionName,
  isTopologyTopicName,
  type DeadLetterPolicy,
  type ListedSubscriptionLike,
  type PubSubLike,
  type PushRetryPolicy,
  type PushSubscriptionOptions,
  type SubscriptionHandleLike,
} from '../../src/repro/pubsub-topology.js';

const PROJECT = 'opt2-reconcile-test';
const DELETED_TOPIC = '_deleted-topic_';
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

/** The retry policy, attempt count and ack deadline every push subscription must carry. */
const EXPECTED_RETRY: PushRetryPolicy = { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } };
const EXPECTED_ATTEMPTS = 5;
const EXPECTED_ACK_DEADLINE_SECONDS = 60;

const PORTS: Record<string, number> = Object.fromEntries(PACKAGE_NAMES.map((name, index) => [name, 9100 + index]));
const TOPOLOGY = deriveTopology('local');
const SUBSCRIPTIONS = Object.entries(TOPOLOGY.subscriptions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

type Call =
  | { op: 'createTopic'; name: string }
  | { op: 'createSubscription'; topic: string; name: string; options: PushSubscriptionOptions | undefined }
  | { op: 'modifyPushConfig'; name: string; config: { pushEndpoint: string } }
  | { op: 'setMetadata'; name: string; metadata: { deadLetterPolicy: DeadLetterPolicy; retryPolicy: PushRetryPolicy; ackDeadlineSeconds: number } }
  | { op: 'delete'; name: string }
  | { op: 'deleteTopic'; name: string };

interface FakeSubscription {
  topic: string;
  enableMessageOrdering: boolean;
}

function topicPath(topic: string): string {
  return `projects/${PROJECT}/topics/${topic}`;
}

function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** In-memory emulator surface answering ALREADY_EXISTS and NOT_FOUND as the emulator does; records every call. */
class FakePubSub implements PubSubLike {
  readonly topics = new Set<string>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly calls: Call[] = [];

  async createTopic(name: string): Promise<void> {
    this.calls.push({ op: 'createTopic', name });
    if (this.topics.has(name)) throw grpcError(GRPC_ALREADY_EXISTS, `topic ${name} exists`);
    this.topics.add(name);
  }

  topic(topic: string): ReturnType<PubSubLike['topic']> {
    return {
      createSubscription: async (name: string, options?: PushSubscriptionOptions): Promise<void> => {
        this.calls.push({ op: 'createSubscription', topic, name, options });
        if (!this.topics.has(topic)) throw grpcError(GRPC_NOT_FOUND, `topic ${topic} not found`);
        if (this.subscriptions.has(name)) throw grpcError(GRPC_ALREADY_EXISTS, `subscription ${name} exists`);
        this.subscriptions.set(name, { topic: topicPath(topic), enableMessageOrdering: options?.enableMessageOrdering ?? false });
      },
      delete: async (): Promise<void> => {
        if (!this.topics.delete(topic)) throw grpcError(GRPC_NOT_FOUND, `topic ${topic} not found`);
        this.calls.push({ op: 'deleteTopic', name: topic });
        // Pub/Sub keeps a deleted topic's subscriptions, detached.
        for (const subscription of this.subscriptions.values()) {
          if (subscription.topic === topicPath(topic)) subscription.topic = DELETED_TOPIC;
        }
      },
    };
  }

  async getTopics(): Promise<[{ name: string }[]]> {
    return [[...this.topics].map((topic) => ({ name: topicPath(topic) }))];
  }

  async getSubscriptions(): Promise<[ListedSubscriptionLike[]]> {
    return [[...this.subscriptions].map(([name, { topic }]) => ({ name: `projects/${PROJECT}/subscriptions/${name}`, metadata: { topic } }))];
  }

  subscription(name: string): SubscriptionHandleLike {
    const current = (): FakeSubscription => {
      const found = this.subscriptions.get(name);
      if (found === undefined) throw grpcError(GRPC_NOT_FOUND, `subscription ${name} not found`);
      return found;
    };
    return {
      getMetadata: async () => [{ ...current() }],
      modifyPushConfig: async (config) => {
        current();
        this.calls.push({ op: 'modifyPushConfig', name, config });
      },
      setMetadata: async (metadata) => {
        current();
        this.calls.push({ op: 'setMetadata', name, metadata });
      },
      delete: async () => {
        current();
        this.subscriptions.delete(name);
        this.calls.push({ op: 'delete', name });
      },
    };
  }

  /** Calls of `op` since the last {@link FakePubSub.clearCalls}. */
  callsOf<Op extends Call['op']>(op: Op): Extract<Call, { op: Op }>[] {
    return this.calls.filter((call): call is Extract<Call, { op: Op }> => call.op === op);
  }

  clearCalls(): void {
    this.calls.splice(0);
  }
}

/** Reconciles the local topology onto `pubsub` with a push key generated for this run. */
function reconcile(pubsub: FakePubSub, pushKey: string) {
  return applyLocalTopology(TOPOLOGY, { projectId: PROJECT, pushKey, ports: PORTS, pubsub });
}

/** A fake already holding everything a previous reconcile created, with its call log cleared. */
async function reconciledFake(pushKey: string): Promise<FakePubSub> {
  const pubsub = new FakePubSub();
  await reconcile(pubsub, pushKey);
  pubsub.clearCalls();
  return pubsub;
}

/** A push key generated for one test, never a stored secret. */
function newPushKey(): string {
  return randomBytes(16).toString('hex');
}

describe('local topology reconcile on an injected emulator client', () => {
  it.each([
    { label: 'detached to _deleted-topic_ by a deleted DLQ topic', replayTopic: DELETED_TOPIC, dropDlqTopic: true, recreated: true },
    { label: 'bound to another topic', replayTopic: topicPath('elsewhere.dlq'), dropDlqTopic: false, recreated: true },
    { label: 'already on its DLQ topic', replayTopic: undefined, dropDlqTopic: false, recreated: false },
  ])('reconciles a DLQ replay subscription $label (recreated: $recreated)', async ({ replayTopic, dropDlqTopic, recreated }) => {
    const key = newPushKey();
    const pubsub = await reconciledFake(key);
    const [name, subscription] = SUBSCRIPTIONS[0] as (typeof SUBSCRIPTIONS)[number];
    const replayName = subscription.dlq_replay_subscription;
    if (dropDlqTopic) pubsub.topics.delete(subscription.dead_letter_topic);
    if (replayTopic !== undefined) pubsub.subscriptions.set(replayName, { topic: replayTopic, enableMessageOrdering: false });

    const result = await reconcile(pubsub, key);

    expect(result).toEqual({
      topics: 0,
      dlqTopics: dropDlqTopic ? 1 : 0,
      pushSubscriptions: 0,
      replaySubscriptions: recreated ? 1 : 0,
      updated: SUBSCRIPTIONS.length,
      retiredSubscriptions: 0,
      retiredTopics: 0,
    });
    const create = { op: 'createSubscription', topic: subscription.dead_letter_topic, name: replayName, options: undefined };
    const replayCalls = pubsub.calls.filter((call) => call.op !== 'createTopic' && call.name === replayName);
    expect(replayCalls).toEqual(recreated ? [create, { op: 'delete', name: replayName }, create] : [create]);
    expect(pubsub.callsOf('delete')).toHaveLength(recreated ? 1 : 0);
    expect(pubsub.subscriptions.get(replayName)?.topic).toBe(topicPath(`${name}.dlq`));
    for (const [, other] of SUBSCRIPTIONS.slice(1)) {
      expect(pubsub.subscriptions.get(other.dlq_replay_subscription)?.topic).toBe(topicPath(other.dead_letter_topic));
    }
  });

  it('creates every new push subscription with the retry policy and the 5-attempt dead-letter policy', async () => {
    const key = newPushKey();
    const pubsub = new FakePubSub();

    const result = await reconcile(pubsub, key);

    expect(SUBSCRIPTIONS.length).toBeGreaterThan(0);
    expect(result).toEqual({
      topics: Object.keys(TOPOLOGY.topics).length,
      dlqTopics: SUBSCRIPTIONS.length,
      pushSubscriptions: SUBSCRIPTIONS.length,
      replaySubscriptions: SUBSCRIPTIONS.length,
      updated: 0,
      retiredSubscriptions: 0,
      retiredTopics: 0,
    });
    const pushCreates = pubsub.callsOf('createSubscription').filter((call) => call.options !== undefined);
    expect(pushCreates).toEqual(
      SUBSCRIPTIONS.map(([name, subscription]) => ({
        op: 'createSubscription',
        topic: subscription.topic,
        name,
        options: {
          pushConfig: { pushEndpoint: `http://127.0.0.1:${PORTS[subscription.consumer]}/internal/v1/events/${name}?key=${key}` },
          enableMessageOrdering: true,
          deadLetterPolicy: { deadLetterTopic: topicPath(`${name}.dlq`), maxDeliveryAttempts: EXPECTED_ATTEMPTS },
          retryPolicy: EXPECTED_RETRY,
          ackDeadlineSeconds: EXPECTED_ACK_DEADLINE_SECONDS,
        },
      })),
    );
  });

  it('gives every existing push subscription the retry and dead-letter policies and the ack deadline in one metadata update', async () => {
    const key = newPushKey();
    const pubsub = await reconciledFake(key);

    const result = await reconcile(pubsub, key);

    expect(result).toEqual({
      topics: 0,
      dlqTopics: 0,
      pushSubscriptions: 0,
      replaySubscriptions: 0,
      updated: SUBSCRIPTIONS.length,
      retiredSubscriptions: 0,
      retiredTopics: 0,
    });
    expect(pubsub.callsOf('delete')).toEqual([]);
    expect(pubsub.callsOf('setMetadata')).toEqual(
      SUBSCRIPTIONS.map(([name]) => ({
        op: 'setMetadata',
        name,
        metadata: {
          deadLetterPolicy: { deadLetterTopic: topicPath(`${name}.dlq`), maxDeliveryAttempts: EXPECTED_ATTEMPTS },
          retryPolicy: EXPECTED_RETRY,
          ackDeadlineSeconds: EXPECTED_ACK_DEADLINE_SECONDS,
        },
      })),
    );
  });
});

describe('retirement of undeclared topology resources on a reused emulator project', () => {
  const [, DECLARED] = SUBSCRIPTIONS[0] as (typeof SUBSCRIPTIONS)[number];
  /** A consumer and a producer the topology no longer has. */
  const FORMER_PUSH = subscriptionName('former', DECLARED.topic);
  const FORMER_TOPIC = topicName('former', 'item', 'changed');
  const FORMER_TOPIC_PUSH = subscriptionName('stub', FORMER_TOPIC);
  /** Names a package test suite gives its own resources, with an 8-hex per-run segment. */
  const RUN_TOPIC = topicName('stub', 'loop-1a2b3c4d', 'event');
  const RUN_PUSH = subscriptionName('stub', RUN_TOPIC);
  const RUN_HELPER_PUSH = subscriptionName('stub-5e6f7a8b', topicName('stub', 'run-9c0d1e2f', 'event'));

  interface Extra {
    label: string;
    topics: string[];
    /** Name and short topic of each subscription seeded besides the declared ones. */
    subscriptions: [string, string][];
    retiredSubscriptions: string[];
    retiredTopics: string[];
  }

  const extras: Extra[] = [
    {
      label: "a former consumer's push subscription on a declared topic, its DLQ topic and its DLQ replay subscription",
      topics: [dlqTopicName(FORMER_PUSH)],
      subscriptions: [
        [FORMER_PUSH, DECLARED.topic],
        [dlqReplaySubscriptionName(FORMER_PUSH), dlqTopicName(FORMER_PUSH)],
      ],
      retiredSubscriptions: [FORMER_PUSH, dlqReplaySubscriptionName(FORMER_PUSH)],
      retiredTopics: [dlqTopicName(FORMER_PUSH)],
    },
    {
      label: "a former producer's event topic and a kept consumer's undeclared push subscription on it",
      topics: [FORMER_TOPIC],
      subscriptions: [[FORMER_TOPIC_PUSH, FORMER_TOPIC]],
      retiredSubscriptions: [FORMER_TOPIC_PUSH],
      retiredTopics: [FORMER_TOPIC],
    },
    {
      label: 'names outside the grammar: an ad hoc pull, a fault witness, a DLQ observer and a plain topic',
      topics: ['scratch'],
      subscriptions: [
        ['adhoc-pull', DECLARED.topic],
        [`witness_pubsub-redelivery_r1.${DECLARED.topic}`, DECLARED.topic],
        [`opt2-dlq-check-1a2b3c4d.${DECLARED.dead_letter_topic}`, DECLARED.dead_letter_topic],
      ],
      retiredSubscriptions: [],
      retiredTopics: [],
    },
    {
      label: 'package test resources whose names carry a per-run segment',
      topics: [RUN_TOPIC, dlqTopicName(RUN_PUSH), topicName('stub', 'run-9c0d1e2f', 'event')],
      subscriptions: [
        [RUN_PUSH, RUN_TOPIC],
        [dlqReplaySubscriptionName(RUN_PUSH), dlqTopicName(RUN_PUSH)],
        [RUN_HELPER_PUSH, topicName('stub', 'run-9c0d1e2f', 'event')],
      ],
      retiredSubscriptions: [],
      retiredTopics: [],
    },
    {
      label: 'an undeclared event topic that an unowned subscription still uses',
      topics: [FORMER_TOPIC],
      subscriptions: [['adhoc-pull', FORMER_TOPIC]],
      retiredSubscriptions: [],
      retiredTopics: [],
    },
  ];

  it.each(extras)(
    'retires $retiredSubscriptions.length subscriptions, then $retiredTopics.length topics, given $label',
    async ({ topics, subscriptions, retiredSubscriptions, retiredTopics }) => {
      const key = newPushKey();
      const pubsub = await reconciledFake(key);
      for (const topic of topics) pubsub.topics.add(topic);
      for (const [name, topic] of subscriptions) pubsub.subscriptions.set(name, { topic: topicPath(topic), enableMessageOrdering: false });
      const topicsBefore = [...pubsub.topics].sort();
      const subscriptionsBefore = [...pubsub.subscriptions.keys()].sort();

      const result = await reconcile(pubsub, key);

      expect(result).toEqual({
        topics: 0,
        dlqTopics: 0,
        pushSubscriptions: 0,
        replaySubscriptions: 0,
        updated: SUBSCRIPTIONS.length,
        retiredSubscriptions: retiredSubscriptions.length,
        retiredTopics: retiredTopics.length,
      });
      expect(pubsub.callsOf('delete').map((call) => call.name)).toEqual([...retiredSubscriptions].sort());
      expect(pubsub.callsOf('deleteTopic').map((call) => call.name)).toEqual([...retiredTopics].sort());
      const lastSubscriptionDelete = pubsub.calls.findLastIndex((call) => call.op === 'delete');
      const firstTopicDelete = pubsub.calls.findIndex((call) => call.op === 'deleteTopic');
      if (firstTopicDelete >= 0) expect(lastSubscriptionDelete).toBeLessThan(firstTopicDelete);
      expect([...pubsub.topics].sort()).toEqual(topicsBefore.filter((topic) => !retiredTopics.includes(topic)));
      expect([...pubsub.subscriptions.keys()].sort()).toEqual(subscriptionsBefore.filter((name) => !retiredSubscriptions.includes(name)));
      for (const [name, subscription] of SUBSCRIPTIONS) {
        expect(pubsub.subscriptions.get(name)?.topic, name).toBe(topicPath(subscription.topic));
        expect(pubsub.subscriptions.get(subscription.dlq_replay_subscription)?.topic).toBe(topicPath(subscription.dead_letter_topic));
      }
      for (const [name, topic] of subscriptions.filter(([kept]) => !retiredSubscriptions.includes(kept))) {
        expect(pubsub.subscriptions.get(name)?.topic, name).toBe(topicPath(topic));
      }

      pubsub.clearCalls();
      const again = await reconcile(pubsub, key);

      expect(again).toMatchObject({ retiredSubscriptions: 0, retiredTopics: 0 });
      expect(pubsub.calls.filter((call) => call.op === 'delete' || call.op === 'deleteTopic')).toEqual([]);
    },
  );

  it("recreates a detached declared DLQ replay subscription while retiring a former consumer's resources", async () => {
    const key = newPushKey();
    const pubsub = await reconciledFake(key);
    pubsub.topics.add(dlqTopicName(FORMER_PUSH));
    pubsub.subscriptions.set(FORMER_PUSH, { topic: topicPath(DECLARED.topic), enableMessageOrdering: true });
    pubsub.topics.delete(DECLARED.dead_letter_topic);
    pubsub.subscriptions.set(DECLARED.dlq_replay_subscription, { topic: DELETED_TOPIC, enableMessageOrdering: false });

    const result = await reconcile(pubsub, key);

    expect(result).toEqual({
      topics: 0,
      dlqTopics: 1,
      pushSubscriptions: 0,
      replaySubscriptions: 1,
      updated: SUBSCRIPTIONS.length,
      retiredSubscriptions: 1,
      retiredTopics: 1,
    });
    expect(pubsub.subscriptions.get(DECLARED.dlq_replay_subscription)?.topic).toBe(topicPath(DECLARED.dead_letter_topic));
    expect(pubsub.subscriptions.has(FORMER_PUSH)).toBe(false);
    expect(pubsub.topics.has(dlqTopicName(FORMER_PUSH))).toBe(false);
    expect(pubsub.topics.has(DECLARED.dead_letter_topic)).toBe(true);
  });
});

describe('topology resource naming grammar', () => {
  const PUSH = 'people.identity.group.changed.v1';

  it.each([
    { kind: 'topic', name: 'people.person.changed.v1', owned: true },
    { kind: 'topic', name: dlqTopicName(PUSH), owned: true },
    { kind: 'topic', name: 'people.person.changed.v1.dlq', owned: false },
    { kind: 'topic', name: 'stub.run-1a2b3c4d.event.v1', owned: false },
    { kind: 'topic', name: 'scratch', owned: false },
    { kind: 'subscription', name: PUSH, owned: true },
    { kind: 'subscription', name: dlqReplaySubscriptionName(PUSH), owned: true },
    { kind: 'subscription', name: dlqTopicName(PUSH), owned: false },
    { kind: 'subscription', name: `opt2-dlq-check-1a2b3c4d.${dlqTopicName(PUSH)}`, owned: false },
    { kind: 'subscription', name: `witness_pubsub-redelivery_r1.identity.group.changed.v1`, owned: false },
    { kind: 'subscription', name: 'stub-1a2b3c4d.stub.run-5e6f7a8b.event.v1', owned: false },
    { kind: 'subscription', name: 'adhoc-pull', owned: false },
  ])('treats $kind $name as topology-named: $owned', ({ kind, name, owned }) => {
    expect(kind === 'topic' ? isTopologyTopicName(name) : isTopologySubscriptionName(name)).toBe(owned);
  });
});
