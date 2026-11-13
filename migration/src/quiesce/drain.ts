/** Drain barrier: waits until the owners' outboxes are published and every checked consumer received or dead-lettered each event of its declared topics. */
import { setTimeout as delay } from 'node:timers/promises';

import { parseTopic, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse, PublishedEvent } from '@opt2/platform/migration-kit';
import { LOCAL_ONLY_PRODUCERS, OUTBOX_PRODUCERS, callQueueControl, outboxSweepQueue } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import type { DataOwner } from '../owners/index.js';
import { createPubSub, listOpt2Subscriptions, peekDeadLetterEventIds, type PubSubLike } from './subscriptions.js';
import { declaredSubscriptions } from './topology.js';

/** Poll interval used when the caller gives none; the configuration defines no drain interval. */
export const DEFAULT_DRAIN_POLL_MS = 1000;

/** Most event ids asked of a consumer in one position call, which keeps its query string short. */
export const RECEIPT_QUERY_MAX_IDS = 200;

/** Drain counts of one owner: outbox counts from its `GET /internal/v1/migration/position` answer and its unproven deliveries. */
export interface OwnerDrainCounts {
  owner: string;
  /** Outbox rows still to publish, held rows excluded. */
  unpublished: number;
  /** Outbox rows held by open multi-participant operations; still unpublished events. */
  held: number;
  /** Published events of its declared topics without a receipt in their envelope tenant or a dead-letter record. */
  pendingReceipts: number;
}

/** Roles an owner is checked for: its outbox as a producer, its inbox receipts as a consumer. */
export interface DrainRole {
  producer: boolean;
  consumer: boolean;
}

/** Options of {@link awaitDrained}. */
export interface AwaitDrainedOptions {
  /** Owners checked as producers; every {@link drainParticipants} entry when absent. */
  owners?: readonly DataOwner[];
  /** Unit ids whose owners are checked as consumers; when absent the producers are checked as consumers too. */
  consumersWriting?: readonly string[];
  /** Waiting budget; the drain fails once it has passed. */
  timeoutMs: number;
  /** Pause between polls; {@link DEFAULT_DRAIN_POLL_MS} when absent. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Lists the consumers' subscriptions and peeks their dead letters; `createPubSub(ctx.env)` when absent, closed when the drain ends. */
  pubsub?: PubSubLike;
}

/** Outcome of a completed drain: the final counts of every owner checked, all zero for its roles. */
export interface DrainResult {
  owners: OwnerDrainCounts[];
  /** Position rounds taken, the first included. */
  polls: number;
  elapsedMs: number;
}

/** An owner checked by a drain: its latest counts and the roles they are judged for. */
export interface CheckedOwner {
  counts: OwnerDrainCounts;
  role: DrainRole;
}

/** The context members a drain uses. */
export type DrainContext = Pick<MigrationContext, 'env' | 'config' | 'clock' | 'catalog' | 'owners' | 'client'>;

/** Owners were still not drained when the budget ran out; `owners` holds their last counts. */
export class DrainTimeoutError extends Error {
  override readonly name: string = 'DrainTimeoutError';
  readonly timeoutMs: number;
  readonly owners: OwnerDrainCounts[];

  constructor(timeoutMs: number, undrained: readonly CheckedOwner[]) {
    super(`drain timed out after ${String(timeoutMs)} ms: ${undrained.map(describe).join(', ')}`);
    this.timeoutMs = timeoutMs;
    this.owners = undrained.map((entry) => entry.counts);
  }
}

/** Declared subscriptions of checked consumers that Pub/Sub does not hold, so their deliveries cannot be proven. */
export class MissingSubscriptionError extends Error {
  override readonly name: string = 'MissingSubscriptionError';
  readonly subscriptions: string[];

  constructor(subscriptions: readonly string[]) {
    super(`declared subscriptions missing from Pub/Sub: ${subscriptions.join(', ')}`);
    this.subscriptions = [...subscriptions];
  }
}

/** Declared subscriptions of checked consumers whose topic's producer is no drain participant, so no participant lists their events. */
export class UnlistedProducerError extends Error {
  override readonly name: string = 'UnlistedProducerError';
  readonly subscriptions: string[];

  constructor(subscriptions: readonly string[]) {
    super(`declared subscriptions on topics no data owner lists: ${subscriptions.join(', ')}`);
    this.subscriptions = [...subscriptions];
  }
}

/** `owner(name=value, ...)` with the counts of the owner's roles. */
function describe({ counts, role }: CheckedOwner): string {
  const parts = [
    ...(role.producer ? [`unpublished=${String(counts.unpublished)}`, `held=${String(counts.held)}`] : []),
    ...(role.consumer ? [`pendingReceipts=${String(counts.pendingReceipts)}`] : []),
  ];
  return `${counts.owner}(${parts.join(', ')})`;
}

/** Drain counts of `owner`: the outbox counts of its position answer, zero without an outbox, and its `pendingReceipts`. */
export function ownerDrainCounts(owner: string, position: PositionResponse, pendingReceipts: number): OwnerDrainCounts {
  return {
    owner,
    unpublished: position.outbox?.unpublished ?? 0,
    held: position.outbox?.held ?? 0,
    pendingReceipts,
  };
}

/** True when every count of the given roles is zero. */
export function isDrained(c: OwnerDrainCounts, role: DrainRole): boolean {
  const producerDrained = !role.producer || (c.unpublished === 0 && c.held === 0);
  const consumerDrained = !role.consumer || c.pendingReceipts === 0;
  return producerDrained && consumerDrained;
}

/** The configured data owners, then each local-only producer the deployment's `OPT2_SERVICE_URLS` names. */
export function drainParticipants(ctx: Pick<DrainContext, 'config' | 'env'>): DataOwner[] {
  const deployedLocalOnly = LOCAL_ONLY_PRODUCERS.filter((producer) => Object.hasOwn(ctx.env.OPT2_SERVICE_URLS, producer));
  return [...new Set<DataOwner>([...ctx.config.dataOwners, ...deployedLocalOnly])];
}

/** Each owner checked, polled once, with its roles; producers first, then consumers in unit order. */
function drainRoles(ctx: DrainContext, options: AwaitDrainedOptions): Map<DataOwner, DrainRole> {
  const producers = options.owners ?? drainParticipants(ctx);
  const consumers =
    options.consumersWriting === undefined ? producers : options.consumersWriting.map((unit) => ctx.catalog.ownerOf(unit));
  const roles = new Map<DataOwner, DrainRole>();
  for (const owner of producers) roles.set(owner, { producer: true, consumer: false });
  for (const owner of consumers) roles.set(owner, { producer: roles.get(owner)?.producer ?? false, consumer: true });
  return roles;
}

/** Producers that own an outbox sweep queue, deployed and local-only. */
export const SWEEP_PRODUCERS: ReadonlySet<string> = new Set([...OUTBOX_PRODUCERS, ...LOCAL_ONLY_PRODUCERS]);

/** A published event one consumer must receive in the event's envelope tenant or dead-letter; ids are lower case. */
interface Delivery {
  event: PublishedEvent;
  /** The consumer's subscription to the event's topic. */
  subscription: string;
}

/** Topics each publisher lists, the checked consumers subscribed to each topic, and every declared subscription behind them. */
interface Routes {
  publishers: Map<DataOwner, string[]>;
  subscribers: Map<string, DataOwner[]>;
  subscriptions: string[];
}

/**
 * Routes of the subscriptions the checked consumers declare in their contracts.
 * @throws UnlistedProducerError naming each declared subscription whose topic's producer is no drain participant.
 */
async function declaredRoutes(ctx: DrainContext, consumers: readonly DataOwner[]): Promise<Routes> {
  const producerOf = new Map<string, DataOwner>(drainParticipants(ctx).map((owner) => [owner, owner]));
  const declared = await Promise.all(
    consumers.map(async (consumer) => ({ consumer, subscriptions: await declaredSubscriptions(ctx.config, consumer) })),
  );
  const routes: Routes = { publishers: new Map(), subscribers: new Map(), subscriptions: [] };
  const unlisted: string[] = [];
  for (const { consumer, subscriptions } of declared) {
    for (const { name, topic } of subscriptions) {
      const producer = producerOf.get(parseTopic(topic).service);
      if (producer === undefined) {
        unlisted.push(name);
        continue;
      }
      routes.subscriptions.push(name);
      routes.subscribers.set(topic, [...(routes.subscribers.get(topic) ?? []), consumer]);
      const topics = routes.publishers.get(producer) ?? [];
      if (!topics.includes(topic)) routes.publishers.set(producer, [...topics, topic]);
    }
  }
  if (unlisted.length > 0) throw new UnlistedProducerError(unlisted);
  return routes;
}

/** @throws MissingSubscriptionError naming every declared subscription Pub/Sub does not hold; subscriptions not declared are ignored. */
async function requireSubscriptions(pubsub: PubSubLike, declared: readonly string[]): Promise<void> {
  const live = new Set((await listOpt2Subscriptions(pubsub)).map(({ name }) => name));
  const missing = declared.filter((name) => !live.has(name));
  if (missing.length > 0) throw new MissingSubscriptionError(missing);
}

/**
 * Polls until every producer's outbox is published and every event published on a checked consumer's declared topics has that consumer's
 * receipt in the envelope tenant, which a fan-out applies last, or a dead letter; each producer's sweep chain is ensured once.
 * @throws UnlistedProducerError or MissingSubscriptionError before the first poll when a declared delivery cannot be proven.
 * @throws DrainTimeoutError once `timeoutMs` has passed with an owner not drained; an owner, contract or Pub/Sub failure propagates at once.
 */
export async function awaitDrained(ctx: DrainContext, options: AwaitDrainedOptions): Promise<DrainResult> {
  const { timeoutMs } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DRAIN_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const roleOf = drainRoles(ctx, options);
  const startedAt = ctx.clock.now().getTime();
  const deadline = startedAt + timeoutMs;
  const consumers = [...roleOf].flatMap(([owner, role]) => (role.consumer ? [owner] : []));
  const { publishers, subscribers, subscriptions } = await declaredRoutes(ctx, consumers);
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  try {
    await requireSubscriptions(pubsub, subscriptions);
    const polled = [...new Set([...roleOf.keys(), ...publishers.keys()])];
    const known = new Set<string>();
    const pending = new Map<DataOwner, Map<string, Delivery>>(consumers.map((owner) => [owner, new Map()]));

    /** Makes a newly listed event pending at every checked consumer of its topic. */
    const record = (event: PublishedEvent): void => {
      const eventId = event.eventId.toLowerCase();
      if (known.has(eventId)) return;
      known.add(eventId);
      const lowered = { ...event, eventId, tenantId: event.tenantId.toLowerCase() };
      for (const consumer of subscribers.get(event.topic) ?? []) {
        pending.get(consumer)?.set(eventId, { event: lowered, subscription: subscriptionName(consumer, event.topic) });
      }
    };

    /** Removes the deliveries `consumer` proves by a receipt in the envelope tenant or by a dead letter; an absent inbox proves none. */
    const prove = async (consumer: DataOwner, deliveries: Map<string, Delivery>): Promise<void> => {
      const ids = [...deliveries.keys()];
      for (let start = 0; start < ids.length; start += RECEIPT_QUERY_MAX_IDS) {
        const chunk = ids.slice(start, start + RECEIPT_QUERY_MAX_IDS);
        const receipts = (await ctx.owners.position(consumer, { eventIds: chunk })).inbox?.receipts ?? {};
        for (const eventId of chunk) {
          const tenantId = deliveries.get(eventId)?.event.tenantId;
          if (receipts[eventId]?.some((tenant) => tenant.toLowerCase() === tenantId)) deliveries.delete(eventId);
        }
      }
      for (const subscription of new Set([...deliveries.values()].map((delivery) => delivery.subscription))) {
        for (const eventId of await peekDeadLetterEventIds(pubsub, subscription)) deliveries.delete(eventId.toLowerCase());
      }
    };

    // Proofs are read before the listing, so an event published by the effect of a proven one is listed, or counted unpublished, after it.
    const poll = async (): Promise<CheckedOwner[]> => {
      const unproven = [...pending].filter(([, deliveries]) => deliveries.size > 0);
      await Promise.all(unproven.map(([consumer, deliveries]) => prove(consumer, deliveries)));
      const answers = await Promise.all(
        polled.map(async (owner) => ({ owner, position: await ctx.owners.position(owner, { publishedTopics: publishers.get(owner) }) })),
      );
      for (const { owner, position } of answers) {
        if (!publishers.has(owner)) continue;
        if (position.published === undefined) throw new Error(`Owner ${owner} answered position without the asked published events`);
        position.published.forEach(record);
      }
      return answers.flatMap(({ owner, position }) => {
        const role = roleOf.get(owner);
        return role === undefined ? [] : [{ counts: ownerDrainCounts(owner, position, pending.get(owner)?.size ?? 0), role }];
      });
    };

    let checked = await poll();
    let polls = 1;
    // A live sweep chain publishes rows whose process exited before its in-request flush; ensured once per drain.
    for (const { counts, role } of checked) {
      if (role.producer && counts.unpublished + counts.held > 0 && SWEEP_PRODUCERS.has(counts.owner)) {
        await callQueueControl(ctx.client, { service: counts.owner, queue: outboxSweepQueue(counts.owner), op: 'ensure' });
      }
    }

    for (;;) {
      const undrained = checked.filter((entry) => !isDrained(entry.counts, entry.role));
      if (undrained.length === 0) {
        return { owners: checked.map((entry) => entry.counts), polls, elapsedMs: ctx.clock.now().getTime() - startedAt };
      }
      if (ctx.clock.now().getTime() >= deadline) throw new DrainTimeoutError(timeoutMs, undrained);
      await sleep(pollIntervalMs);
      checked = await poll();
      polls += 1;
    }
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
