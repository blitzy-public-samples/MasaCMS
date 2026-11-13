import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAMES } from '../../src/repro/ports.js';
import {
  applyLocalTopology,
  deriveTopology,
  type DeadLetterPolicy,
  type PubSubLike,
  type PushRetryPolicy,
  type PushSubscriptionOptions,
  type SubscriptionHandleLike,
} from '../../src/repro/pubsub-topology.js';

const PROJECT = 'opt2-reconcile-test';
const DELETED_TOPIC = '_deleted-topic_';
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

/** The retry policy and attempt count every push subscription must carry. */
const EXPECTED_RETRY: PushRetryPolicy = { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } };
const EXPECTED_ATTEMPTS = 5;

const PORTS: Record<string, number> = Object.fromEntries(PACKAGE_NAMES.map((name, index) => [name, 9100 + index]));
const TOPOLOGY = deriveTopology('local');
const SUBSCRIPTIONS = Object.entries(TOPOLOGY.subscriptions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

type Call =
  | { op: 'createTopic'; name: string }
  | { op: 'createSubscription'; topic: string; name: string; options: PushSubscriptionOptions | undefined }
  | { op: 'modifyPushConfig'; name: string; config: { pushEndpoint: string } }
  | { op: 'setMetadata'; name: string; metadata: { deadLetterPolicy: DeadLetterPolicy; retryPolicy: PushRetryPolicy } }
  | { op: 'delete'; name: string };

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

  topic(topic: string): { createSubscription(name: string, options?: PushSubscriptionOptions): Promise<unknown> } {
    return {
      createSubscription: async (name: string, options?: PushSubscriptionOptions): Promise<void> => {
        this.calls.push({ op: 'createSubscription', topic, name, options });
        if (!this.topics.has(topic)) throw grpcError(GRPC_NOT_FOUND, `topic ${topic} not found`);
        if (this.subscriptions.has(name)) throw grpcError(GRPC_ALREADY_EXISTS, `subscription ${name} exists`);
        this.subscriptions.set(name, { topic: topicPath(topic), enableMessageOrdering: options?.enableMessageOrdering ?? false });
      },
    };
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
        },
      })),
    );
  });

  it('gives every existing push subscription the retry and dead-letter policies in one metadata update', async () => {
    const key = newPushKey();
    const pubsub = await reconciledFake(key);

    const result = await reconcile(pubsub, key);

    expect(result).toEqual({ topics: 0, dlqTopics: 0, pushSubscriptions: 0, replaySubscriptions: 0, updated: SUBSCRIPTIONS.length });
    expect(pubsub.callsOf('delete')).toEqual([]);
    expect(pubsub.callsOf('setMetadata')).toEqual(
      SUBSCRIPTIONS.map(([name]) => ({
        op: 'setMetadata',
        name,
        metadata: {
          deadLetterPolicy: { deadLetterTopic: topicPath(`${name}.dlq`), maxDeliveryAttempts: EXPECTED_ATTEMPTS },
          retryPolicy: EXPECTED_RETRY,
        },
      })),
    );
  });
});
