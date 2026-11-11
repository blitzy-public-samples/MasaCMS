/** Pub/Sub adapter for quiescence: OPT-2 subscription discovery, push-config save and restore, and a non-acking backlog peek. */
import { PubSub, v1 } from '@google-cloud/pubsub';
import { consumerOfSubscription, InvalidEventNameError, topicOfSubscription } from '@opt2/platform/events';
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

/** The subset of a `PubSub` client used by quiescence; {@link createPubSub} adds `pullOnce`. */
export interface PubSubLike {
  projectId?: string;
  getSubscriptions(): Promise<[SubscriptionLike[], ...unknown[]]>;
  subscription(name: string): SubscriptionLike;
  close(): Promise<void>;
  /** Pulls at most one message from a fully qualified subscription, releases it unacked, and resolves to the number received. */
  pullOnce?(fullName: string): Promise<number>;
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

// `ClientConfig` lacks the index signature of gax `ClientOptions`; the library hands the same object to its own GAPIC clients.
type SubscriberClientOptions = NonNullable<ConstructorParameters<typeof v1.SubscriberClient>[0]>;

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

  return Object.assign(pubsub, { pullOnce });
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

/** `url` without its query string, which may carry the local push key. */
export function redactEndpoint(url: string): string {
  const query = url.indexOf('?');
  return query < 0 ? url : url.slice(0, query);
}
