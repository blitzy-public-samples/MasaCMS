/** Redelivery barrier: holds the replayed topics' subscriptions in pull, observes the replayed copies on witness subscriptions, and pushes them to the saved push endpoints until each is answered 2xx. */
import { buildPushBody, isTopicName, parseTopic } from '@opt2/platform/events';
import type { Clock } from '@opt2/platform/service-kit';

import {
  createWitnessSubscription,
  isPushConfig,
  listOpt2Subscriptions,
  listTopicIds,
  openMessageLease,
  readPushConfig,
  redactEndpoint,
  removeSubscription,
  setPushConfig,
  type LeasedMessage,
  type MessageLease,
  type Opt2Subscription,
  type PubSubLike,
  type SavedPushConfig,
} from '../quiesce/index.js';

/** Most messages one delivery pull leases; all are answered before the next pull. */
const DELIVERY_PULL_MAX = 10;
/** Most messages one witness pull takes; Pub/Sub returns at most 1000 per pull. */
const WITNESS_PULL_MAX = 1000;

const FULL_NAME_PROJECT = /^projects\/([^/]+)\/subscriptions\//;

/** A consumer subscription switched to pull, with the push config it returns to; `push` carries the push key and stays in memory. */
export interface HeldSubscription {
  /** Short id `<consumer>.<topic>`. */
  name: string;
  consumer: string;
  topic: string;
  ordered: boolean;
  subscription: Opt2Subscription['subscription'];
  push: SavedPushConfig & { pushEndpoint: string };
}

/** Outcome of {@link holdPushDelivery}: the held subscriptions, or those already in pull mode, in which case none was switched. */
export type HoldResult = { held: HeldSubscription[] } | { inPullMode: string[] };

/** Polling budget of {@link observeReplay} and {@link deliverHeld}. */
export interface PollOptions {
  /** Epoch milliseconds after which polling ends. */
  deadline: number;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** Pause after a pull round that brought nothing or had a failed push. */
  pollIntervalMs: number;
}

/** Options of {@link deliverHeld}; no push starts after `deadline`. */
export interface DeliverOptions extends PollOptions {
  fetch: typeof fetch;
}

/** How one held subscription's queue was pushed. */
export interface DeliveryReport {
  subscription: string;
  /** The saved push endpoint without its query string. */
  endpoint: string;
  /** Distinct replayed event ids of its topic, as the witness observed them. */
  expected: number;
  /** Pushes answered 2xx, each then acknowledged. */
  delivered: number;
  /** Push answers by HTTP status, `timeout` or `network`. */
  statuses: Record<string, number>;
  /** Expected event ids not answered 2xx, lower case and sorted. */
  unproven: string[];
  /** Whether every expected event id was answered 2xx and a last pull then found the queue empty. */
  complete: boolean;
}

/** A pull subscription on one topic of a replayed producer, created before the replay so it receives every copy published to that topic. */
export interface Witness {
  producer: string;
  topic: string;
  /** Short subscription id. */
  name: string;
}

/** What one producer's witnesses received after its replay. */
export interface ReplayObservation {
  producer: string;
  /** Rows the replay reported published. */
  replayed: number;
  /** Distinct event ids received per topic, lower case and sorted. */
  eventIds: Record<string, string[]>;
  /** Received messages without an event id, which no replay publishes. */
  unidentified: number;
  /** `complete`: exactly `replayed` distinct ids; `short`: fewer by the deadline; `surplus`: more, or an unidentified message. */
  outcome: 'complete' | 'short' | 'surplus';
}

/** Witness subscriptions that could not be deleted. */
export class WitnessCleanupError extends Error {
  override readonly name: string = 'WitnessCleanupError';
  readonly subscriptions: string[];

  constructor(subscriptions: readonly string[], problems: readonly string[]) {
    super(`witness subscriptions not deleted: ${subscriptions.join(', ')}: ${problems.join('; ')}`);
    this.subscriptions = [...subscriptions];
  }
}

/** Push configs that could not be re-applied; their subscriptions stay in pull mode. */
export class PushRestoreError extends Error {
  override readonly name: string = 'PushRestoreError';
  readonly subscriptions: string[];

  constructor(subscriptions: readonly string[], problems: readonly string[]) {
    super(`push config not restored on ${subscriptions.join(', ')}: ${problems.join('; ')}`);
    this.subscriptions = [...subscriptions];
  }
}

/** `error`'s text with `endpoint` and its query string, which carries the push key, redacted. */
function redactedProblem(error: unknown, endpoint: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const query = endpoint.slice(redactEndpoint(endpoint).length + 1);
  const withoutEndpoint = text.replaceAll(endpoint, redactEndpoint(endpoint));
  return query === '' ? withoutEndpoint : withoutEndpoint.replaceAll(query, '<redacted>');
}

/** Awaits every promise, then rethrows the first rejection; resolves to the values in order. */
async function settleAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  return settled.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}

/** Live OPT-2 subscriptions on a topic of `producers`, each with its push config, `null` in pull mode. */
async function replayedSubscriptions(
  pubsub: PubSubLike,
  producers: readonly string[],
): Promise<{ entry: Opt2Subscription; push: SavedPushConfig | null }[]> {
  const replayed = new Set(producers);
  const subscriptions = (await listOpt2Subscriptions(pubsub)).filter(({ topic }) => replayed.has(parseTopic(topic).service));
  return Promise.all(subscriptions.map(async (entry) => ({ entry, push: await readPushConfig(entry.subscription) })));
}

/** Names of the subscriptions on a topic of `producers` that are in pull mode, sorted. */
export async function pullModeSubscriptions(pubsub: PubSubLike, producers: readonly string[]): Promise<string[]> {
  return (await replayedSubscriptions(pubsub, producers)).flatMap(({ entry, push }) => (push === null ? [entry.name] : []));
}

/** Re-applies each held subscription's saved push config, trying every one. @throws PushRestoreError naming those not restored. */
export async function restorePushDelivery(held: readonly HeldSubscription[]): Promise<void> {
  const failed: string[] = [];
  const problems: string[] = [];
  for (const entry of held) {
    try {
      await setPushConfig(entry.subscription, entry.push);
    } catch (error) {
      failed.push(entry.name);
      problems.push(redactedProblem(error, entry.push.pushEndpoint));
    }
  }
  if (failed.length > 0) throw new PushRestoreError(failed, problems);
}

/** Runs `cleanup`, then rethrows `error`; a failed cleanup is raised together with it. */
async function cleanUpAndRethrow(cleanup: () => Promise<void>, error: unknown): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    const problem = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new AggregateError([error, cleanupError], `redelivery failed and ${problem}`);
  }
  throw error;
}

/** Restores `held`, then rethrows `error`; a failed restore is raised together with it. */
async function restoreAndRethrow(held: readonly HeldSubscription[], error: unknown): Promise<never> {
  return cleanUpAndRethrow(() => restorePushDelivery(held), error);
}

/**
 * Switches every push subscription on a topic of `producers` to pull, so replayed copies wait in Pub/Sub; switches none when one already pulls.
 * A failed switch restores the subscriptions switched before it, then propagates.
 */
export async function holdPushDelivery(pubsub: PubSubLike, producers: readonly string[]): Promise<HoldResult> {
  const captured = await replayedSubscriptions(pubsub, producers);
  const inPullMode = captured.flatMap(({ entry, push }) => (isPushConfig(push) ? [] : [entry.name]));
  if (inPullMode.length > 0) return { inPullMode };
  const held: HeldSubscription[] = [];
  try {
    for (const { entry, push } of captured) {
      if (!isPushConfig(push)) continue;
      // Held before the switch, so a switch that fails half-way is restored too.
      held.push({ name: entry.name, consumer: entry.consumer, topic: entry.topic, ordered: entry.ordered, subscription: entry.subscription, push });
      await setPushConfig(entry.subscription, {});
    }
  } catch (error) {
    return restoreAndRethrow(held, error);
  }
  return { held };
}

/** Runs `fn`, then restores every held push config, also when `fn` throws. @throws PushRestoreError when a restore fails. */
export async function whileHeld<T>(held: readonly HeldSubscription[], fn: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    return restoreAndRethrow(held, error);
  }
  await restorePushDelivery(held);
  return result;
}

/** Deletes every named witness, trying each. @throws WitnessCleanupError naming those left. */
export async function deleteWitnesses(pubsub: PubSubLike, names: readonly string[]): Promise<void> {
  const failed: string[] = [];
  const problems: string[] = [];
  for (const name of names) {
    try {
      await removeSubscription(pubsub, name);
    } catch (error) {
      failed.push(name);
      problems.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  if (failed.length > 0) throw new WitnessCleanupError(failed, problems);
}

/** Runs `fn` with a witness `nameOf(topic)` on every project topic of `producers`, deleting them afterwards, also when `fn` or a creation throws. @throws WitnessCleanupError when a deletion fails. */
export async function whileWitnessed<T>(
  pubsub: PubSubLike,
  producers: readonly string[],
  nameOf: (topic: string) => string,
  fn: (witnesses: readonly Witness[]) => Promise<T>,
): Promise<T> {
  const replayed = new Set(producers);
  const topics = (await listTopicIds(pubsub)).filter((topic) => isTopicName(topic) && replayed.has(parseTopic(topic).service));
  const witnesses: Witness[] = [];
  const cleanup = (): Promise<void> => deleteWitnesses(pubsub, witnesses.map(({ name }) => name));
  let result: T;
  try {
    for (const topic of topics) {
      const witness: Witness = { producer: parseTopic(topic).service, topic, name: nameOf(topic) };
      // Listed before the creation, so a creation that fails after taking effect is deleted too.
      witnesses.push(witness);
      await createWitnessSubscription(pubsub, topic, witness.name);
    }
    result = await fn(witnesses);
  } catch (error) {
    return cleanUpAndRethrow(cleanup, error);
  }
  await cleanup();
  return result;
}

/** Pulls and acknowledges `witnesses` until they hold `replayed` distinct event ids, more, or the deadline passes. */
export async function observeReplay(
  pubsub: PubSubLike,
  producer: string,
  witnesses: readonly Witness[],
  replayed: number,
  options: PollOptions,
): Promise<ReplayObservation> {
  const received = new Map(witnesses.map(({ topic }) => [topic, new Set<string>()]));
  const leases: { topic: string; lease: MessageLease }[] = [];
  const remainingMs = (): number => options.deadline - options.clock.now().getTime();
  let unidentified = 0;
  let outcome: ReplayObservation['outcome'];
  try {
    for (const { topic, name } of witnesses) leases.push({ topic, lease: await openMessageLease(pubsub, name) });
    for (;;) {
      let pulled = 0;
      for (const { topic, lease } of leases) {
        const messages = await lease.pull(WITNESS_PULL_MAX);
        pulled += messages.length;
        for (const message of messages) {
          if (message.eventId === undefined) unidentified += 1;
          else received.get(topic)?.add(message.eventId.toLowerCase());
        }
        await lease.acknowledge(messages.map(({ ackId }) => ackId));
      }
      const total = [...received.values()].reduce((sum, ids) => sum + ids.size, 0);
      if (unidentified > 0 || total > replayed) {
        outcome = 'surplus';
        break;
      }
      if (total === replayed) {
        outcome = 'complete';
        break;
      }
      if (remainingMs() <= 0) {
        outcome = 'short';
        break;
      }
      // Pub/Sub may answer a pull with fewer messages than it holds, so an empty pull only waits.
      if (pulled === 0) await options.sleep(Math.max(0, Math.min(options.pollIntervalMs, remainingMs())));
    }
  } finally {
    await settleAll(leases.map(({ lease }) => lease.close()));
  }
  const eventIds = Object.fromEntries([...received].map(([topic, ids]) => [topic, [...ids].sort()]));
  return { producer, replayed, eventIds, unidentified, outcome };
}

/** POSTs `body` as JSON within `timeoutMs`: whether the answer was 2xx, and its status, or `timeout` or `network` when none came. */
async function postPush(fetchImpl: typeof fetch, endpoint: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; label: string }> {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return { ok: response.ok, label: String(response.status) };
  } catch (error) {
    // Pub/Sub nacks any failed push; the error text can carry the endpoint and its push key, so only the kind is kept.
    return { ok: false, label: (error as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/** Messages per ordering key in pull order, keyless messages as one chain. */
function orderingChains(messages: readonly LeasedMessage[]): LeasedMessage[][] {
  const chains = new Map<string, LeasedMessage[]>();
  for (const message of messages) {
    const key = message.orderingKey ?? '';
    chains.set(key, [...(chains.get(key) ?? []), message]);
  }
  return [...chains.values()];
}

/** Pushes `entry`'s queue until every id of `expected` is answered 2xx and a pull then finds it empty, or the deadline passes; an empty pull while ids are pending only waits. */
async function deliverSubscription(
  pubsub: PubSubLike,
  entry: HeldSubscription,
  expected: readonly string[],
  options: DeliverOptions,
): Promise<DeliveryReport> {
  const pending = new Set(expected.map((eventId) => eventId.toLowerCase()));
  const expectedCount = pending.size;
  const statuses: Record<string, number> = {};
  const project = FULL_NAME_PROJECT.exec(entry.subscription.name)?.[1] ?? pubsub.projectId;
  const remainingMs = (): number => options.deadline - options.clock.now().getTime();
  let delivered = 0;
  let complete = false;

  /** Pushes one message, acknowledging it on 2xx and releasing it otherwise; resolves to whether it was answered 2xx. */
  const push = async (lease: MessageLease, message: LeasedMessage): Promise<boolean> => {
    const budget = remainingMs();
    if (budget <= 0) {
      await lease.release([message.ackId]);
      return false;
    }
    const body = buildPushBody({
      data: message.data,
      attributes: message.attributes,
      messageId: message.messageId,
      subscription: entry.name,
      project,
      publishTime: message.publishTime,
      orderingKey: message.orderingKey,
      deliveryAttempt: message.deliveryAttempt,
    });
    const answer = await postPush(options.fetch, entry.push.pushEndpoint, body, budget);
    statuses[answer.label] = (statuses[answer.label] ?? 0) + 1;
    if (!answer.ok) {
      await lease.release([message.ackId]);
      return false;
    }
    await lease.acknowledge([message.ackId]);
    delivered += 1;
    if (message.eventId !== undefined) pending.delete(message.eventId.toLowerCase());
    return true;
  };

  /** Pushes one pull's messages, an ordered subscription's in order per key, releasing a chain's rest after a failure; whether all were answered 2xx. */
  const pushBatch = async (lease: MessageLease, messages: readonly LeasedMessage[]): Promise<boolean> => {
    const chains = entry.ordered ? orderingChains(messages) : messages.map((message) => [message]);
    const answered = await settleAll(
      chains.map(async (chain) => {
        for (const [index, message] of chain.entries()) {
          if (await push(lease, message)) continue;
          await lease.release(chain.slice(index + 1).map(({ ackId }) => ackId));
          return false;
        }
        return true;
      }),
    );
    return answered.every(Boolean);
  };

  const lease = await openMessageLease(pubsub, entry.name);
  try {
    while (remainingMs() > 0) {
      const messages = await lease.pull(DELIVERY_PULL_MAX);
      if (messages.length === 0 && pending.size === 0) {
        complete = true;
        break;
      }
      const progressed = messages.length > 0 && (await pushBatch(lease, messages));
      if (!progressed) await options.sleep(Math.max(0, Math.min(options.pollIntervalMs, remainingMs())));
    }
  } finally {
    await lease.close();
  }
  return {
    subscription: entry.name,
    endpoint: redactEndpoint(entry.push.pushEndpoint),
    expected: expectedCount,
    delivered,
    statuses,
    unproven: [...pending].sort(),
    complete,
  };
}

/**
 * Pushes each held subscription's queue to its saved push endpoint, subscriptions concurrently; a 2xx answer acknowledges a copy, any other outcome releases it.
 * @param expected Event ids each subscription must have answered 2xx, by subscription name.
 */
export async function deliverHeld(
  pubsub: PubSubLike,
  held: readonly HeldSubscription[],
  expected: ReadonlyMap<string, readonly string[]>,
  options: DeliverOptions,
): Promise<DeliveryReport[]> {
  return settleAll(held.map((entry) => deliverSubscription(pubsub, entry, expected.get(entry.name) ?? [], options)));
}
