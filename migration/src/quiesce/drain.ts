/**
 * Drain barrier: waits until the owners' outboxes are published and every checked consumer received each event of its declared
 * topics, or dead-lettered a `state` one.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { parseTopic, subscriptionName } from '@opt2/platform/events';
import type { PositionResponse, PublishedEvent } from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError } from '@opt2/platform/service-kit';
import { LOCAL_ONLY_PRODUCERS, OUTBOX_PRODUCERS, callQueueControl, outboxSweepQueue } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import { OwnerCallError, type DataOwner, type PositionParams } from '../owners/index.js';
import {
  PubSubTimeoutError,
  createPubSub,
  listOpt2Subscriptions,
  peekDeadLetterEventIds,
  type Opt2Subscription,
  type PubSubLike,
} from './subscriptions.js';
import { declaredSubscriptions } from './topology.js';

/** Poll interval used when the caller gives none; the configuration defines no drain interval. */
export const DEFAULT_DRAIN_POLL_MS = 1000;

/** Most event ids asked of a consumer in one position call, which keeps its query string short. */
export const RECEIPT_QUERY_MAX_IDS = 200;

/** Published events asked of a publisher in one position call. */
export const PUBLISHED_PAGE_LIMIT = 500;

/** Most unproven deliveries a drain holds; a publisher's listing resumes once proofs bring the count below it. */
export const MAX_PENDING_DELIVERIES = 5000;

/** Owner answers meaning it cannot answer now, so the drain asks again until its deadline. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Why a call was not made: the drain's budget was spent before it. */
const BUDGET_SPENT = 'drain budget spent before the call';

/** Suffix of the reason of a call that failed once the budget was spent, cut short by its bound. */
const BUDGET_SPENT_DURING = 'drain budget spent during the call';

/** Drain counts of one owner: outbox counts from its `GET /internal/v1/migration/position` answer and its unproven deliveries. */
export interface OwnerDrainCounts {
  owner: string;
  /** Outbox rows still to publish, held rows excluded. */
  unpublished: number;
  /** Outbox rows held by open multi-participant operations; still unpublished events. */
  held: number;
  /** Published events of its declared topics without a receipt in their envelope tenant or a dead-letter record. */
  pendingReceipts: number;
  /** Publishers of its declared topics not yet listed to the end, such as one with an unpublished row of them; absent when none. */
  unlisted?: string[];
  /** Why the owner could not be asked in the last round; absent when it answered every call. */
  unavailable?: string;
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

/**
 * Owners were still not drained when the budget ran out; `owners` holds their last counts, none when it ran out before the first
 * poll, and `unavailable` why owners, or `pubsub` for subscription discovery, could not be asked.
 */
export class DrainTimeoutError extends Error {
  override readonly name: string = 'DrainTimeoutError';
  readonly timeoutMs: number;
  readonly owners: OwnerDrainCounts[];
  readonly unavailable: Record<string, string>;

  constructor(timeoutMs: number, undrained: readonly CheckedOwner[], unavailable: Readonly<Record<string, string>> = {}) {
    const absent = Object.entries(unavailable).map(([owner, reason]) => `${owner} (${reason})`);
    const suffix = absent.length > 0 ? `; unavailable: ${absent.join(', ')}` : '';
    const listed = undrained.length > 0 ? `: ${undrained.map(describe).join(', ')}` : '';
    super(`drain timed out after ${String(timeoutMs)} ms${listed}${suffix}`);
    this.timeoutMs = timeoutMs;
    this.owners = undrained.map((entry) => entry.counts);
    this.unavailable = { ...unavailable };
  }
}

/** A `process` event a checked consumer dead-lettered and never applied. */
export interface DeadLetteredDelivery {
  eventId: string;
  topic: string;
  tenantId: string;
  consumer: DataOwner;
  subscription: string;
}

/** Checked consumers dead-lettered `process` events without a receipt, so their required effects are missing until the DLQs are replayed. */
export class DeadLetteredProcessEventError extends Error {
  override readonly name: string = 'DeadLetteredProcessEventError';
  readonly deliveries: DeadLetteredDelivery[];

  constructor(deliveries: readonly DeadLetteredDelivery[]) {
    const listed = deliveries.map((entry) => `${entry.eventId} (${entry.topic}) on ${entry.subscription}`);
    super(`process events dead-lettered without a receipt: ${listed.join(', ')}`);
    this.deliveries = deliveries.map((entry) => ({ ...entry }));
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

/** `owner(name=value, ...)` with the counts of the owner's roles and, for a consumer, its unlisted publishers. */
function describe({ counts, role }: CheckedOwner): string {
  const unlisted = role.consumer ? (counts.unlisted ?? []) : [];
  const parts = [
    ...(role.producer ? [`unpublished=${String(counts.unpublished)}`, `held=${String(counts.held)}`] : []),
    ...(role.consumer ? [`pendingReceipts=${String(counts.pendingReceipts)}`] : []),
    ...(unlisted.length > 0 ? [`unlisted=${unlisted.join('+')}`] : []),
  ];
  return `${counts.owner}(${parts.join(', ')})`;
}

/** Why an owner call failed for lack of the owner, or undefined for any other failure, which propagates. */
function unavailability(error: unknown): string | undefined {
  if (error instanceof ServiceUnavailableError) return error.message;
  if (error instanceof OwnerCallError && UNAVAILABLE_STATUSES.has(error.status)) return error.message;
  return undefined;
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

/** True when every count of the given roles is zero, a producer answered, and a consumer's publishers listed all their events. */
export function isDrained(c: OwnerDrainCounts, role: DrainRole): boolean {
  const producerDrained = !role.producer || (c.unavailable === undefined && c.unpublished === 0 && c.held === 0);
  const consumerDrained = !role.consumer || (c.pendingReceipts === 0 && (c.unlisted ?? []).length === 0);
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

/** Topics each publisher lists, the checked consumers subscribed to each topic, every declared subscription behind them, and each consumer's publishers. */
interface Routes {
  publishers: Map<DataOwner, string[]>;
  subscribers: Map<string, DataOwner[]>;
  subscriptions: string[];
  sources: Map<DataOwner, DataOwner[]>;
}

/**
 * Where a publisher's listing stands: the cursor, the events listed at or below it, whether a page without a frontier last found
 * every row listed, and the frontier of the pass under way, undefined between passes.
 */
interface Listing {
  after: string;
  listed: number;
  complete: boolean;
  frontier: string | undefined;
}

/** The `published*` members of a paged position answer; `publishedUpTo` only on a complete page. */
type PublishedPage = Required<Pick<PositionResponse, 'published' | 'publishedNext' | 'publishedComplete' | 'publishedFrontier'>> &
  Pick<PositionResponse, 'publishedUpTo'>;

/** The published page of `owner`'s answer. @throws Error when the answer lacks a member the ask requires. */
function publishedPageOf(owner: DataOwner, answer: PositionResponse): PublishedPage {
  const { published, publishedNext, publishedComplete, publishedFrontier, publishedUpTo } = answer;
  if (published === undefined || publishedNext === undefined || publishedComplete === undefined || publishedFrontier === undefined) {
    throw new Error(`Owner ${owner} answered position without the asked published events`);
  }
  return { published, publishedNext, publishedComplete, publishedFrontier, ...(publishedUpTo === undefined ? {} : { publishedUpTo }) };
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
  const routes: Routes = { publishers: new Map(), subscribers: new Map(), subscriptions: [], sources: new Map() };
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
      const sources = routes.sources.get(consumer) ?? [];
      if (!sources.includes(producer)) routes.sources.set(consumer, [...sources, producer]);
    }
  }
  if (unlisted.length > 0) throw new UnlistedProducerError(unlisted);
  return routes;
}

/**
 * Lists the subscriptions within `leftMs` of the drain's `timeoutMs` budget.
 * @throws DrainTimeoutError when no budget is left or the listing outlasts it.
 * @throws MissingSubscriptionError naming every declared subscription Pub/Sub does not hold; subscriptions not declared are ignored.
 */
async function requireSubscriptions(pubsub: PubSubLike, declared: readonly string[], timeoutMs: number, leftMs: number): Promise<void> {
  if (leftMs <= 0) throw new DrainTimeoutError(timeoutMs, [], { pubsub: 'drain budget spent before subscription discovery' });
  let listed: Opt2Subscription[];
  try {
    listed = await listOpt2Subscriptions(pubsub, { timeoutMs: leftMs });
  } catch (error) {
    if (error instanceof PubSubTimeoutError) throw new DrainTimeoutError(timeoutMs, [], { pubsub: error.message });
    throw error;
  }
  const live = new Set(listed.map(({ name }) => name));
  const missing = declared.filter((name) => !live.has(name));
  if (missing.length > 0) throw new MissingSubscriptionError(missing);
}

/**
 * Polls until every producer's outbox is published and each event on a checked consumer's declared topics has that consumer's
 * receipt in the envelope tenant, which a fan-out applies last, or, for a `state` event, a dead letter. Publishers are listed page by
 * page from their own cursors, each pass through a frontier its first page fixes, about {@link MAX_PENDING_DELIVERIES} unproven
 * deliveries are held at most, and every call, discovery
 * and peeks included, is bounded by what is left of the budget; no call starts once it is spent, and a call it skips or cuts short
 * leaves the drain undrained. An unavailable owner is asked again next round. Each publishing owner's sweep chain is ensured once.
 * @throws UnlistedProducerError or MissingSubscriptionError before the first poll when a declared delivery cannot be proven.
 * @throws DeadLetteredProcessEventError when a checked consumer dead-lettered a `process` event it holds no receipt of.
 * @throws DrainTimeoutError once `timeoutMs` has passed with an owner not drained, or during subscription discovery; any other
 * failure propagates at once.
 */
export async function awaitDrained(ctx: DrainContext, options: AwaitDrainedOptions): Promise<DrainResult> {
  const { timeoutMs } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DRAIN_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const roleOf = drainRoles(ctx, options);
  const startedAt = ctx.clock.now().getTime();
  const deadline = startedAt + timeoutMs;
  const remainingMs = (): number => deadline - ctx.clock.now().getTime();
  const consumers = [...roleOf].flatMap(([owner, role]) => (role.consumer ? [owner] : []));
  const { publishers, subscribers, subscriptions, sources } = await declaredRoutes(ctx, consumers);
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  try {
    await requireSubscriptions(pubsub, subscriptions, timeoutMs, remainingMs());
    const polled = [...new Set([...roleOf.keys(), ...publishers.keys()])];
    const pending = new Map<DataOwner, Map<string, Delivery>>(consumers.map((owner) => [owner, new Map()]));
    const listings = new Map<DataOwner, Listing>(
      [...publishers.keys()].map((owner) => [owner, { after: '0', listed: 0, complete: false, frontier: undefined }]),
    );
    const outboxes = new Map<DataOwner, OwnerDrainCounts>();
    const unavailable = new Map<DataOwner, string>();
    const deadLettered: DeadLetteredDelivery[] = [];
    const pendingCount = (): number => [...pending.values()].reduce((sum, deliveries) => sum + deliveries.size, 0);
    /** Bound of the next call: the service-call bound within what is left; undefined once nothing is, which records `owner` unavailable. */
    const callBound = (owner: DataOwner): number | undefined => {
      const left = remainingMs();
      if (left > 0) return Math.min(SERVICE_CALL_TIMEOUT_MS, left);
      if (!unavailable.has(owner)) unavailable.set(owner, BUDGET_SPENT);
      return undefined;
    };
    /** `reason` of a failed call, naming the spent budget when the call ended with it. */
    const failedBecause = (reason: string): string => (remainingMs() > 0 ? reason : `${reason}; ${BUDGET_SPENT_DURING}`);

    /** `owner`'s answer within the remaining budget; undefined when the owner is unavailable or the budget spent, which the round records. */
    const ask = async (owner: DataOwner, params: PositionParams): Promise<PositionResponse | undefined> => {
      const bound = callBound(owner);
      if (bound === undefined) return undefined;
      try {
        return await ctx.owners.position(owner, params, { timeoutMs: bound });
      } catch (error) {
        const reason = unavailability(error);
        if (reason === undefined) throw error;
        unavailable.set(owner, failedBecause(reason));
        return undefined;
      }
    };

    /** Makes a listed event pending at each checked consumer of its topic not already waiting for it. @returns the deliveries added. */
    const record = (event: PublishedEvent): number => {
      const eventId = event.eventId.toLowerCase();
      const lowered = { ...event, eventId, tenantId: event.tenantId.toLowerCase() };
      let added = 0;
      for (const consumer of subscribers.get(event.topic) ?? []) {
        const deliveries = pending.get(consumer);
        if (deliveries === undefined || deliveries.has(eventId)) continue;
        deliveries.set(eventId, { event: lowered, subscription: subscriptionName(consumer, event.topic) });
        added += 1;
      }
      return added;
    };

    /**
     * Removes the deliveries `consumer` proves by a receipt in the envelope tenant or, for a `state` event, by a dead letter, and
     * records a dead-lettered `process` event; only deliveries the consumer answered for without a receipt are sought in its DLQs.
     * Chunks and peeks the spent budget skips leave their deliveries pending.
     */
    const prove = async (consumer: DataOwner, deliveries: Map<string, Delivery>): Promise<void> => {
      const ids = [...deliveries.keys()];
      const unreceived = new Map<string, Delivery[]>();
      for (let start = 0; start < ids.length; start += RECEIPT_QUERY_MAX_IDS) {
        const chunk = ids.slice(start, start + RECEIPT_QUERY_MAX_IDS);
        const answer = await ask(consumer, { eventIds: chunk });
        if (answer === undefined) break;
        const receipts = answer.inbox?.receipts ?? {};
        for (const eventId of chunk) {
          const delivery = deliveries.get(eventId);
          if (delivery === undefined) continue;
          if (receipts[eventId]?.some((tenant) => tenant.toLowerCase() === delivery.event.tenantId) === true) {
            deliveries.delete(eventId);
            continue;
          }
          const waiting = unreceived.get(delivery.subscription) ?? [];
          waiting.push(delivery);
          unreceived.set(delivery.subscription, waiting);
        }
      }
      for (const [subscription, waiting] of unreceived) {
        const left = remainingMs();
        if (left <= 0) break;
        const sought = waiting.map(({ event }) => event.eventId);
        const peeked = await peekDeadLetterEventIds(pubsub, subscription, { eventIds: sought, timeoutMs: left });
        const found = new Set(peeked.map((id) => id.toLowerCase()));
        for (const { event } of waiting.filter((delivery) => found.has(delivery.event.eventId))) {
          const { eventId, topic, tenantId, kind } = event;
          if (kind === 'process') deadLettered.push({ eventId, topic, tenantId, consumer, subscription });
          else deliveries.delete(eventId);
        }
      }
    };

    /**
     * Lists `owner`'s published events from its cursor, page by page while the cursor moves, the budget lasts and pending deliveries
     * leave room; an owner publishing no asked topic, or one listed while there is no room, is read once for its counts. A pass pages
     * through the frontier its first page reports; once it ends, one page without it starts the next pass, which a later call
     * continues, or finds the listing complete.
     * @returns the deliveries added.
     */
    const list = async (owner: DataOwner): Promise<number> => {
      const topics = publishers.get(owner);
      const listing = listings.get(owner);
      if (topics === undefined || listing === undefined || pendingCount() >= MAX_PENDING_DELIVERIES) {
        if (listing !== undefined) listing.complete = false;
        const answer = await ask(owner, {});
        if (answer !== undefined) outboxes.set(owner, ownerDrainCounts(owner, answer, 0));
        return 0;
      }
      let added = 0;
      // Whether this page is the one that follows a pass this call ended.
      let afterPass = false;
      for (let more = true; more; ) {
        const through = listing.frontier;
        const answer = await ask(owner, {
          publishedTopics: topics,
          publishedAfter: listing.after,
          publishedLimit: PUBLISHED_PAGE_LIMIT,
          ...(through === undefined ? {} : { publishedThrough: through }),
        });
        if (answer === undefined) {
          listing.complete = false;
          break;
        }
        outboxes.set(owner, ownerDrainCounts(owner, answer, 0));
        const page = publishedPageOf(owner, answer);
        if (page.publishedUpTo !== undefined && page.publishedUpTo !== listing.listed) {
          if (listing.after === '0') throw new Error(`Owner ${owner} counted ${String(page.publishedUpTo)} published events at or below seq 0`);
          // A row committed behind the cursor after it passed the row's seq, so the listing starts over.
          Object.assign(listing, { after: '0', listed: 0, complete: false, frontier: undefined });
          afterPass = false;
          continue;
        }
        const moved = page.publishedNext !== listing.after;
        const passEnded = page.publishedComplete && through !== undefined;
        Object.assign(listing, {
          after: page.publishedNext,
          listed: listing.listed + page.published.length,
          complete: page.publishedComplete && through === undefined,
          frontier: page.publishedComplete ? undefined : page.publishedFrontier,
        });
        for (const event of page.published) added += record(event);
        more = (passEnded || (moved && !afterPass)) && !listing.complete && remainingMs() > 0 && pendingCount() < MAX_PENDING_DELIVERIES;
        afterPass = passEnded;
      }
      return added;
    };

    /** Counts of a checked owner after a round; a consumer's publishers whose listing is not complete are unlisted. */
    const countsOf = (owner: DataOwner, role: DrainRole): OwnerDrainCounts => {
      const unlisted = role.consumer ? (sources.get(owner) ?? []).filter((source) => listings.get(source)?.complete !== true).sort() : [];
      const reason = unavailable.get(owner);
      return {
        ...(outboxes.get(owner) ?? { owner, unpublished: 0, held: 0 }),
        pendingReceipts: pending.get(owner)?.size ?? 0,
        ...(unlisted.length > 0 ? { unlisted } : {}),
        ...(reason === undefined ? {} : { unavailable: reason }),
      };
    };

    // Proofs are read before each listing, so an event published by the effect of a proven one is listed, or blocks the listing, after it.
    const round = async (): Promise<CheckedOwner[]> => {
      unavailable.clear();
      for (let pass = 0; ; pass += 1) {
        const unproven = [...pending].filter(([, deliveries]) => deliveries.size > 0);
        await Promise.all(unproven.map(([consumer, deliveries]) => prove(consumer, deliveries)));
        if (deadLettered.length > 0) throw new DeadLetteredProcessEventError(deadLettered);
        // A spent budget ends the round once the deliveries its listing added are proven.
        if (pass > 0 && remainingMs() <= 0) break;
        // Newly listed deliveries are proven within the round, so a long history is read without pausing between pages.
        const added = (await Promise.all(polled.map(list))).reduce((sum, count) => sum + count, 0);
        if (added === 0) break;
      }
      return [...roleOf].map(([owner, role]) => ({ counts: countsOf(owner, role), role }));
    };

    /** Ensures `owner`'s sweep chain within the budget; one the budget skips or cuts short is recorded unavailable, other failures propagate. */
    const ensureSweep = async (owner: DataOwner): Promise<void> => {
      const bound = callBound(owner);
      if (bound === undefined) return;
      try {
        await callQueueControl(ctx.client, { service: owner, queue: outboxSweepQueue(owner), op: 'ensure', timeoutMs: bound });
      } catch (error) {
        if (!(error instanceof ServiceUnavailableError) || remainingMs() > 0) throw error;
        unavailable.set(owner, failedBecause(error.message));
      }
    };

    let checked = await round();
    let polls = 1;
    // A live sweep chain publishes rows whose process exited before its in-request flush; ensured once per drain.
    for (const owner of polled) {
      const counts = outboxes.get(owner);
      const publishes = roleOf.get(owner)?.producer === true || publishers.has(owner);
      if (publishes && counts !== undefined && counts.unpublished + counts.held > 0 && SWEEP_PRODUCERS.has(owner)) await ensureSweep(owner);
    }

    for (;;) {
      const undrained = checked.filter((entry) => !isDrained(entry.counts, entry.role));
      if (undrained.length === 0) {
        return { owners: checked.map((entry) => entry.counts), polls, elapsedMs: ctx.clock.now().getTime() - startedAt };
      }
      if (remainingMs() > 0) await sleep(Math.min(pollIntervalMs, remainingMs()));
      // No round starts once the budget is spent, so the last round's verdict stands.
      if (remainingMs() <= 0) {
        throw new DrainTimeoutError(timeoutMs, undrained, Object.fromEntries([...unavailable].sort(([a], [b]) => (a < b ? -1 : 1))));
      }
      checked = await round();
      polls += 1;
    }
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
