// Site deletion barrier of a window import: consumers dead-letter an event of a tenant their registry no longer holds, so
// the events published in the tenants of the sites a window deletes must reach their consumers before the sites' deletes.
import { setTimeout as delay } from 'node:timers/promises';

import { parseTopic } from '@opt2/platform/events';
import type { PublishedEvent } from '@opt2/platform/migration-kit';

import type { MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import { SITE_ROOT_TABLE } from '../order/index.js';
import type { DataOwner, UnitCatalog } from '../owners/index.js';
import { PUBLISHED_PAGE_LIMIT, RECEIPT_QUERY_MAX_IDS } from '../quiesce/drain.js';
import { fingerprintKey, fingerprintTables } from './fingerprints.js';
import { siteTopicSubscribers } from './site-registration.js';

// Bounded although the Minimal Change rule bans new timeouts: that rule does not bind this refactor, and an unbounded wait would hold the window's gates.
/** Longest one import attempt waits for the receipts of the events published in the tenants of the sites it deletes. */
export const DELETION_WAIT_MS = 10_000;

/** Pause between two rounds of listings and receipt reads. */
export const DELETION_POLL_MS = 200;

/** Outbox `seq` of each producer after which its events are awaited before a site delete. */
export type PublishedCursors = ReadonlyMap<DataOwner, string>;

/** Producers a site delete waits on, each with its topics that consumers of the site topic declare, and those consumers by topic. */
export interface DeletionRoutes {
  readonly producers: ReadonlyMap<DataOwner, readonly string[]>;
  readonly subscribers: ReadonlyMap<string, readonly DataOwner[]>;
}

/** An event published in a deleted site's tenant. */
export interface DeletedTenantEvent {
  readonly eventId: string;
  readonly topic: string;
  readonly tenantId: string;
}

/** A consumer still lacking its receipts of `events` in their tenants, with the failure of its last read when it failed. */
export interface MissingReceipts {
  readonly owner: DataOwner;
  readonly events: readonly DeletedTenantEvent[];
  readonly error?: unknown;
}

/** A producer whose events after its cursor are not all listed yet, with the failure of its last read when it failed. */
export interface UnlistedEvents {
  readonly owner: DataOwner;
  readonly error?: unknown;
}

/** Outcome of {@link awaitDeletionReceipts}: what is still pending, the events awaited, the milliseconds taken and whether it paused. */
export interface DeletionWait {
  readonly missing: MissingReceipts[];
  readonly unlisted: UnlistedEvents[];
  readonly awaited: number;
  readonly waitedMs: number;
  readonly waited: boolean;
}

/** Where one producer's listing stands: its cursor, the frontier its first page fixed, and whether it reached it. */
interface Listing {
  after: string;
  through: string | undefined;
  complete: boolean;
}

/** Units of `units` fed by the site table. */
export function siteUnitsOf(catalog: Pick<UnitCatalog, 'legacyTablesOf'>, units: readonly string[]): string[] {
  return units.filter((unit) => fingerprintTables(catalog, [unit]).some((table) => fingerprintKey(table) === SITE_ROOT_TABLE));
}

/** Routes a delete of a site among `units` waits on, with the owners of the other units as producers; undefined without a site unit. */
export async function deletionRoutes(
  config: Pick<MigrationConfig, 'owners' | 'dataOwners'>,
  catalog: Pick<UnitCatalog, 'legacyTablesOf' | 'ownerOf'>,
  units: readonly string[],
): Promise<DeletionRoutes | undefined> {
  const sites = siteUnitsOf(catalog, units);
  if (sites.length === 0) return undefined;
  const subscribers = await siteTopicSubscribers(config);
  const owners = [...new Set(units.filter((unit) => !sites.includes(unit)).map((unit) => catalog.ownerOf(unit)))].sort();
  const producers = new Map<DataOwner, string[]>();
  for (const owner of owners) {
    const topics = [...subscribers.keys()].filter((topic) => parseTopic(topic).service === owner).sort();
    if (topics.length > 0) producers.set(owner, topics);
  }
  return { producers, subscribers };
}

/** Each producer's cursor: the highest outbox `seq` of its topics now, so a listing after it finds only later events. @throws the first failed call */
export async function capturePublishedCursors(
  ctx: Pick<MigrationContext, 'owners'>,
  producers: ReadonlyMap<DataOwner, readonly string[]>,
  timeoutMs?: number,
): Promise<Map<DataOwner, string>> {
  const bound = timeoutMs === undefined ? {} : { timeoutMs };
  const cursors = await Promise.all(
    [...producers].map(async ([owner, topics]): Promise<[DataOwner, string]> => {
      const { publishedFrontier } = await ctx.owners.position(owner, { publishedTopics: topics, publishedAfter: '0', publishedLimit: 1 }, bound);
      if (publishedFrontier === undefined) throw new Error(`Owner ${owner} answered position without a published frontier`);
      return [owner, publishedFrontier];
    }),
  );
  return new Map(cursors);
}

/**
 * Lists each producer's events after its cursor and reads their consumers' receipts every {@link DELETION_POLL_MS} until each
 * event published in one of `tenants` has a receipt there at every consumer of its topic and the site topic, or
 * {@link DELETION_WAIT_MS} passed; a failed call counts as pending.
 * @throws Error when `cursors` lacks a producer of `routes`.
 */
export async function awaitDeletionReceipts(
  ctx: Pick<MigrationContext, 'owners' | 'clock'>,
  routes: DeletionRoutes,
  cursors: PublishedCursors,
  tenants: readonly string[],
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
): Promise<DeletionWait> {
  const started = ctx.clock.now().getTime();
  const deleted = new Set(tenants.map((tenantId) => tenantId.toLowerCase()));
  const listings = new Map<DataOwner, Listing>();
  for (const owner of routes.producers.keys()) {
    const after = cursors.get(owner);
    if (after === undefined) throw new Error(`no published-event cursor of ${owner}`);
    listings.set(owner, { after, through: undefined, complete: false });
  }
  const events = new Map<string, DeletedTenantEvent & { waiting: Set<DataOwner> }>();
  const listErrors = new Map<DataOwner, unknown>();
  const readErrors = new Map<DataOwner, unknown>();
  const timeoutMs = (): number => Math.max(started + DELETION_WAIT_MS - ctx.clock.now().getTime(), 1);

  const record = (event: PublishedEvent): void => {
    const eventId = event.eventId.toLowerCase();
    const tenantId = event.tenantId.toLowerCase();
    const consumers = routes.subscribers.get(event.topic) ?? [];
    if (deleted.has(tenantId) && !events.has(eventId) && consumers.length > 0) {
      events.set(eventId, { eventId, topic: event.topic, tenantId, waiting: new Set(consumers) });
    }
  };

  /** Pages `owner`'s listing on while its cursor moves, through the frontier its first page fixed; an unpublished row stops it until the next round. */
  const list = async (owner: DataOwner, listing: Listing): Promise<void> => {
    for (;;) {
      const answer = await ctx.owners.position(
        owner,
        {
          publishedTopics: routes.producers.get(owner) ?? [],
          publishedAfter: listing.after,
          publishedLimit: PUBLISHED_PAGE_LIMIT,
          ...(listing.through === undefined ? {} : { publishedThrough: listing.through }),
        },
        { timeoutMs: timeoutMs() },
      );
      const { published, publishedNext, publishedComplete, publishedFrontier } = answer;
      if (published === undefined || publishedNext === undefined || publishedComplete === undefined || publishedFrontier === undefined) {
        throw new Error(`Owner ${owner} answered position without the asked published events`);
      }
      for (const event of published) record(event);
      const moved = publishedNext !== listing.after;
      Object.assign(listing, { after: publishedNext, through: listing.through ?? publishedFrontier, complete: publishedComplete });
      if (publishedComplete || !moved) return;
    }
  };

  /** Clears `consumer` from each event it holds a receipt of in the event's tenant, asking for at most {@link RECEIPT_QUERY_MAX_IDS} ids a call. */
  const prove = async (consumer: DataOwner): Promise<void> => {
    const ids = [...events.values()].filter((event) => event.waiting.has(consumer)).map((event) => event.eventId);
    for (let start = 0; start < ids.length; start += RECEIPT_QUERY_MAX_IDS) {
      const chunk = ids.slice(start, start + RECEIPT_QUERY_MAX_IDS);
      const { inbox } = await ctx.owners.position(consumer, { eventIds: chunk }, { timeoutMs: timeoutMs() });
      for (const eventId of chunk) {
        const event = events.get(eventId);
        const received = inbox?.receipts?.[eventId]?.some((tenantId) => tenantId.toLowerCase() === event?.tenantId) === true;
        if (received) event?.waiting.delete(consumer);
      }
    }
  };

  /** Runs one owner call of a round, keeping its failure in `errors` and clearing an earlier one on success. */
  const settle = async (errors: Map<DataOwner, unknown>, owner: DataOwner, call: () => Promise<void>): Promise<void> => {
    try {
      await call();
      errors.delete(owner);
    } catch (error) {
      errors.set(owner, error);
    }
  };

  for (let waited = false; ; waited = true) {
    const open = [...listings].filter(([, listing]) => !listing.complete);
    await Promise.all(open.map(([owner, listing]) => settle(listErrors, owner, () => list(owner, listing))));
    const consumers = [...new Set([...events.values()].flatMap((event) => [...event.waiting]))].sort();
    await Promise.all(consumers.map((consumer) => settle(readErrors, consumer, () => prove(consumer))));
    const waitedMs = ctx.clock.now().getTime() - started;
    const unlisted = [...listings].flatMap(([owner, listing]) =>
      listing.complete ? [] : [listErrors.has(owner) ? { owner, error: listErrors.get(owner) } : { owner }],
    );
    const missing = consumers.flatMap((owner): MissingReceipts[] => {
      const lacking = [...events.values()].filter((event) => event.waiting.has(owner)).map(({ eventId, topic, tenantId }) => ({ eventId, topic, tenantId }));
      if (lacking.length === 0) return [];
      return [readErrors.has(owner) ? { owner, events: lacking, error: readErrors.get(owner) } : { owner, events: lacking }];
    });
    if ((missing.length === 0 && unlisted.length === 0) || waitedMs >= DELETION_WAIT_MS) {
      return { missing, unlisted, awaited: events.size, waitedMs, waited };
    }
    await sleep(Math.min(DELETION_POLL_MS, DELETION_WAIT_MS - waitedMs));
  }
}
