/** Pub/Sub adapter for quiescence: OPT-2 subscription discovery, push-config save and restore, non-acking backlog and DLQ peeks, leased pulls and witness subscriptions. */
import { PubSub, v1, type protos } from '@google-cloud/pubsub';
import {
  consumerOfSubscription,
  decodeEnvelopeData,
  dlqReplaySubscriptionName,
  InvalidEventNameError,
  topicOfSubscription,
} from '@opt2/platform/events';
import type { MigrationEnv } from '../env.js';

/** JSON-safe copy of a subscription's push config; `{}` means pull delivery. */
export type SavedPushConfig = Record<string, unknown>;

/** The subset of a Pub/Sub `Subscription` used by quiescence. */
export interface SubscriptionLike {
  name: string;
  getMetadata(): Promise<[{ pushConfig?: unknown | null; enableMessageOrdering?: boolean | null }, ...unknown[]]>;
  modifyPushConfig(config: SavedPushConfig): Promise<unknown>;
  seek(snapshotOrTime: Date): Promise<unknown>;
}

/** A pulled message, leased until it is acknowledged or released. */
export interface LeasedMessage {
  ackId: string;
  messageId: string;
  data: Buffer;
  attributes: Record<string, string>;
  /** RFC 3339 publish time. */
  publishTime?: string;
  orderingKey?: string;
  /** Present only when Pub/Sub counts attempts, on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number;
  /** The `eventId` attribute, else the JSON envelope's `eventId`. */
  eventId?: string;
}

/** Leasing pull access to one subscription. */
export interface MessageLease {
  /** Messages the subscription holds now, at most `maxMessages`; [] when it holds none. */
  pull(maxMessages: number): Promise<LeasedMessage[]>;
  acknowledge(ackIds: readonly string[]): Promise<void>;
  /** Ends the leases unacked, so Pub/Sub redelivers the messages. */
  release(ackIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/** The subset of a `PubSub` client used by quiescence; {@link createPubSub} adds the optional members. */
export interface PubSubLike {
  projectId?: string;
  getSubscriptions(): Promise<[SubscriptionLike[], ...unknown[]]>;
  subscription(name: string): SubscriptionLike;
  close(): Promise<void>;
  /** Pulls at most one message from a fully qualified subscription, releases it unacked, and resolves to the number received. */
  pullOnce?(fullName: string): Promise<number>;
  /** Event ids of every message a fully qualified subscription holds, all released unacked, sorted; [] when it does not exist. */
  peekEventIds?(fullName: string): Promise<string[]>;
  /** Opens a lease client on a fully qualified subscription. */
  leaseMessages?(fullName: string): Promise<MessageLease>;
  /** Short ids of the project's topics, sorted. */
  topicIds?(): Promise<string[]>;
  /** Creates the pull subscription `name` on `topic`, both short ids. */
  createWitness?(topic: string, name: string): Promise<void>;
  /** Deletes the subscription with short id `name`; resolves when it does not exist. */
  deleteSubscription?(name: string): Promise<void>;
}

/** An OPT-2 consumer subscription `<consumer>.<topic>`; `name` is the short id. */
export interface Opt2Subscription {
  name: string;
  consumer: string;
  topic: string;
  ordered: boolean;
  subscription: SubscriptionLike;
}

const FULL_NAME_PREFIX = /^projects\/[^/]+\/subscriptions\//;
const TOPIC_NAME_PREFIX = /^projects\/[^/]+\/topics\//;
const GRPC_NOT_FOUND = 5;
/** Largest pull of a dead-letter peek; Pub/Sub returns at most 1000 messages per pull. */
const PEEK_PULL_MAX = 1000;

// `ClientConfig` lacks the index signature of gax `ClientOptions`; the library hands the same object to its own GAPIC clients.
type SubscriberClientOptions = NonNullable<ConstructorParameters<typeof v1.SubscriberClient>[0]>;

/** The message's `eventId` attribute, else its JSON envelope's `eventId`; undefined when neither holds one. */
function eventIdOf(message: protos.google.pubsub.v1.IPubsubMessage | null | undefined): string | undefined {
  const attribute = message?.attributes?.eventId;
  if (attribute) return attribute;
  if (message?.data == null) return undefined;
  try {
    const envelope = decodeEnvelopeData(message.data) as { eventId?: unknown } | null;
    return typeof envelope?.eventId === 'string' ? envelope.eventId : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** RFC 3339 form of a protobuf timestamp; undefined when it is unset. */
function rfc3339(timestamp: protos.google.protobuf.ITimestamp | null | undefined): string | undefined {
  if (timestamp?.seconds == null) return undefined;
  return new Date(Number(timestamp.seconds.toString()) * 1000 + Math.trunc((timestamp.nanos ?? 0) / 1e6)).toISOString();
}

/** A received message as a {@link LeasedMessage}; undefined without an ack id or message id, which cannot be settled or pushed. */
function leasedMessage(received: protos.google.pubsub.v1.IReceivedMessage): LeasedMessage | undefined {
  const { ackId, message, deliveryAttempt } = received;
  if (!ackId || !message?.messageId) return undefined;
  const data = typeof message.data === 'string' ? Buffer.from(message.data, 'base64') : Buffer.from(message.data ?? []);
  const publishTime = rfc3339(message.publishTime);
  const eventId = eventIdOf({ attributes: message.attributes, data });
  return {
    ackId,
    messageId: message.messageId,
    data,
    attributes: { ...message.attributes },
    ...(publishTime === undefined ? {} : { publishTime }),
    ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
    ...(deliveryAttempt ? { deliveryAttempt } : {}),
    ...(eventId === undefined ? {} : { eventId }),
  };
}

/** Creates a Pub/Sub client for `GOOGLE_CLOUD_PROJECT`, on the emulator when `PUBSUB_EMULATOR_HOST` is set. */
export function createPubSub(env: Pick<MigrationEnv, 'GOOGLE_CLOUD_PROJECT' | 'PUBSUB_EMULATOR_HOST'>): PubSubLike {
  const pubsub = new PubSub({
    projectId: env.GOOGLE_CLOUD_PROJECT,
    ...(env.PUBSUB_EMULATOR_HOST ? { apiEndpoint: env.PUBSUB_EMULATOR_HOST, emulatorMode: true } : {}),
  });

  async function pullOnce(fullName: string): Promise<number> {
    const client = new v1.SubscriberClient((await pubsub.getClientConfig()) as SubscriberClientOptions);
    try {
      const [response] = await client.pull({ subscription: fullName, maxMessages: 1, returnImmediately: true });
      const received = response.receivedMessages ?? [];
      const ackIds = received.flatMap((message) => (message.ackId ? [message.ackId] : []));
      if (ackIds.length > 0) {
        await client.modifyAckDeadline({ subscription: fullName, ackIds, ackDeadlineSeconds: 0 });
      }
      return received.length;
    } finally {
      await client.close();
    }
  }

  async function peekEventIds(fullName: string): Promise<string[]> {
    const client = new v1.SubscriberClient((await pubsub.getClientConfig()) as SubscriberClientOptions);
    const leases: string[][] = [];
    const seen = new Set<string>();
    const eventIds = new Set<string>();
    try {
      // Every lease is held until the end, so a pull that brings no unseen message has read the whole backlog.
      for (;;) {
        const [response] = await client.pull({ subscription: fullName, maxMessages: PEEK_PULL_MAX, returnImmediately: true });
        const received = response.receivedMessages ?? [];
        leases.push(received.flatMap((message) => (message.ackId ? [message.ackId] : [])));
        const unseen = received.filter((message) => {
          const key = message.message?.messageId ?? message.ackId ?? '';
          const isNew = !seen.has(key);
          seen.add(key);
          return isNew;
        });
        if (unseen.length === 0) break;
        for (const message of unseen) {
          const eventId = eventIdOf(message.message);
          if (eventId !== undefined) eventIds.add(eventId);
        }
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== GRPC_NOT_FOUND) throw error;
    } finally {
      try {
        for (const ackIds of leases.filter((batch) => batch.length > 0)) {
          await client.modifyAckDeadline({ subscription: fullName, ackIds, ackDeadlineSeconds: 0 });
        }
      } finally {
        await client.close();
      }
    }
    return [...eventIds].sort();
  }

  async function leaseMessages(fullName: string): Promise<MessageLease> {
    const client = new v1.SubscriberClient((await pubsub.getClientConfig()) as SubscriberClientOptions);
    return {
      async pull(maxMessages) {
        const [response] = await client.pull({ subscription: fullName, maxMessages, returnImmediately: true });
        return (response.receivedMessages ?? []).flatMap((received) => leasedMessage(received) ?? []);
      },
      async acknowledge(ackIds) {
        if (ackIds.length > 0) await client.acknowledge({ subscription: fullName, ackIds: [...ackIds] });
      },
      async release(ackIds) {
        if (ackIds.length > 0) await client.modifyAckDeadline({ subscription: fullName, ackIds: [...ackIds], ackDeadlineSeconds: 0 });
      },
      close: () => client.close(),
    };
  }

  async function topicIds(): Promise<string[]> {
    const [topics] = await pubsub.getTopics();
    return topics.map((topic) => topic.name.replace(TOPIC_NAME_PREFIX, '')).sort();
  }

  async function createWitness(topic: string, name: string): Promise<void> {
    await pubsub.createSubscription(topic, name);
  }

  async function deleteSubscription(name: string): Promise<void> {
    try {
      await pubsub.subscription(name).delete();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== GRPC_NOT_FOUND) throw error;
    }
  }

  return Object.assign(pubsub, { pullOnce, peekEventIds, leaseMessages, topicIds, createWitness, deleteSubscription });
}

/** Short subscription id: `fullName` without its `projects/<project>/subscriptions/` prefix. */
export function subscriptionId(fullName: string): string {
  return fullName.replace(FULL_NAME_PREFIX, '');
}

// topicOfSubscription accepts only well-formed topics, so a separate isTopicName check would be redundant.
function consumerAndTopic(name: string): { consumer: string; topic: string } | undefined {
  try {
    return { consumer: consumerOfSubscription(name), topic: topicOfSubscription(name) };
  } catch (error) {
    if (error instanceof InvalidEventNameError) return undefined;
    throw error;
  }
}

/** OPT-2 consumer subscriptions of the project, sorted by name; DLQ replay and foreign subscriptions are left out. */
export async function listOpt2Subscriptions(pubsub: PubSubLike): Promise<Opt2Subscription[]> {
  const [subscriptions] = await pubsub.getSubscriptions();
  const found = await Promise.all(
    subscriptions.map(async (subscription): Promise<Opt2Subscription | undefined> => {
      const name = subscriptionId(subscription.name);
      const parts = consumerAndTopic(name);
      if (parts === undefined) return undefined;
      const [metadata] = await subscription.getMetadata();
      return { name, ...parts, ordered: metadata.enableMessageOrdering === true, subscription };
    }),
  );
  return found
    .filter((entry): entry is Opt2Subscription => entry !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether `cfg` is a push config: its `pushEndpoint` is a non-empty string. */
export function isPushConfig(cfg: unknown): cfg is { pushEndpoint: string } {
  if (typeof cfg !== 'object' || cfg === null) return false;
  const endpoint = (cfg as { pushEndpoint?: unknown }).pushEndpoint;
  return typeof endpoint === 'string' && endpoint !== '';
}

/** JSON-safe copy of the subscription's push config without null (unset) members, or `null` when it is in pull mode. */
export async function readPushConfig(sub: SubscriptionLike): Promise<SavedPushConfig | null> {
  const [{ pushConfig }] = await sub.getMetadata();
  if (!isPushConfig(pushConfig)) return null;
  return JSON.parse(JSON.stringify(pushConfig, (_key, value: unknown) => (value === null ? undefined : value))) as SavedPushConfig;
}

/** Applies `cfg` as the subscription's push config; `{}` switches it to pull. */
export async function setPushConfig(sub: SubscriptionLike, cfg: SavedPushConfig): Promise<void> {
  await sub.modifyPushConfig(cfg);
}

/** Number of messages (0 or 1) a non-acking pull receives from the subscription named `name`. */
export async function peekBacklog(pubsub: PubSubLike, name: string): Promise<number> {
  if (pubsub.pullOnce === undefined) {
    throw new TypeError('peekBacklog needs a Pub/Sub client with pullOnce, as created by createPubSub');
  }
  return pubsub.pullOnce(pubsub.subscription(name).name);
}

/** Event ids of the dead letters on the DLQ replay subscription of `subscription`, read without acking; [] when it does not exist. */
export async function peekDeadLetterEventIds(pubsub: PubSubLike, subscription: string): Promise<string[]> {
  if (pubsub.peekEventIds === undefined) {
    throw new TypeError('peekDeadLetterEventIds needs a Pub/Sub client with peekEventIds, as created by createPubSub');
  }
  return pubsub.peekEventIds(pubsub.subscription(dlqReplaySubscriptionName(subscription)).name);
}

/** Opens a lease client on the subscription named `name`. */
export async function openMessageLease(pubsub: PubSubLike, name: string): Promise<MessageLease> {
  if (pubsub.leaseMessages === undefined) {
    throw new TypeError('openMessageLease needs a Pub/Sub client with leaseMessages, as created by createPubSub');
  }
  return pubsub.leaseMessages(pubsub.subscription(name).name);
}

/** Name prefix of the witness subscriptions of `fault`; its `_` keeps them out of {@link listOpt2Subscriptions}. */
export function witnessPrefix(fault: string): string {
  return `witness_${fault}_`;
}

/** Witness subscription name `witness_<fault>_<runId>.<topic>`. */
export function witnessName(fault: string, runId: string, topic: string): string {
  return `${witnessPrefix(fault)}${runId}.${topic}`;
}

/** Short ids of the project's topics, sorted. */
export async function listTopicIds(pubsub: PubSubLike): Promise<string[]> {
  if (pubsub.topicIds === undefined) {
    throw new TypeError('listTopicIds needs a Pub/Sub client with topicIds, as created by createPubSub');
  }
  return pubsub.topicIds();
}

/** Short ids of the project's subscriptions that start with `prefix`, sorted. */
export async function listSubscriptionIds(pubsub: PubSubLike, prefix: string): Promise<string[]> {
  const [subscriptions] = await pubsub.getSubscriptions();
  return subscriptions
    .map((subscription) => subscriptionId(subscription.name))
    .filter((name) => name.startsWith(prefix))
    .sort();
}

/** Creates the pull subscription `name` on `topic`, which receives every message published to `topic` from then on. */
export async function createWitnessSubscription(pubsub: PubSubLike, topic: string, name: string): Promise<void> {
  if (pubsub.createWitness === undefined) {
    throw new TypeError('createWitnessSubscription needs a Pub/Sub client with createWitness, as created by createPubSub');
  }
  await pubsub.createWitness(topic, name);
}

/** Deletes the subscription named `name`; one that does not exist counts as deleted. */
export async function removeSubscription(pubsub: PubSubLike, name: string): Promise<void> {
  if (pubsub.deleteSubscription === undefined) {
    throw new TypeError('removeSubscription needs a Pub/Sub client with deleteSubscription, as created by createPubSub');
  }
  await pubsub.deleteSubscription(name);
}

/** `url` without its query string, which may carry the local push key. */
export function redactEndpoint(url: string): string {
  const query = url.indexOf('?');
  return query < 0 ? url : url.slice(0, query);
}
