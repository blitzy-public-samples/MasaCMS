// Site registration barrier of a window import: consumers dead-letter an event of a tenant their registry lacks, so the
// consumers of a window's later events must register the tenants of the sites it added before those events are sent.
import { setTimeout as delay } from 'node:timers/promises';

import { parseTopic } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite } from '@opt2/platform/tenancy';

import type { MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import type { DataOwner } from '../owners/index.js';
import { declaredSubscriptions } from '../quiesce/topology.js';
import type { TableFingerprint } from './fingerprints.js';

// Bounded: an unbounded wait would hold the window's gates.
/** Longest one import attempt waits for the consumers to register the window's new tenants. */
export const REGISTRATION_WAIT_MS = 10_000;

/** Pause between two reads of the consumers' registered tenants. */
export const REGISTRATION_POLL_MS = 200;

/** A consumer whose registry lacks some of the new tenants, with the failure of its last read when it failed. */
export interface Unregistered {
  readonly owner: DataOwner;
  readonly missing: readonly string[];
  readonly error?: unknown;
}

// Memoised: each read parses an owner's contract.
const topicsByContract = new Map<string, readonly string[]>();

/** Topics `owner`'s contract declares push subscriptions to, read once per owner and package. */
async function subscribedTopics(config: Pick<MigrationConfig, 'owners'>, owner: DataOwner): Promise<readonly string[]> {
  const key = JSON.stringify([owner, config.owners[owner].package]);
  let topics = topicsByContract.get(key);
  if (topics === undefined) {
    topics = (await declaredSubscriptions(config, owner)).map((subscription) => subscription.topic);
    topicsByContract.set(key, topics);
  }
  return topics;
}

/** Tenants of the sites whose key `after` holds and `before` lacks; none unless both are keyed on `siteColumn`. */
export function addedSiteTenants(before: TableFingerprint | undefined, after: TableFingerprint | undefined, siteColumn: string): string[] {
  if (before?.keyed !== true || after?.keyed !== true) return [];
  const index = after.keyColumns.findIndex((column) => column.toLowerCase() === siteColumn.toLowerCase());
  const tenants = new Set<string>();
  for (const [key, row] of after.rows) {
    const site = row.key[index];
    // SQL Server compares site ids without their trailing spaces.
    const siteId = typeof site === 'string' ? site.replace(/ +$/, '') : '';
    if (siteId !== '' && !before.rows.has(key)) tenants.add(tenantIdForSite(siteId));
  }
  return [...tenants].sort();
}

/** Data owners consuming the site topic and another topic one of `producers` publishes, sorted. */
export async function siteEventConsumers(config: Pick<MigrationConfig, 'owners' | 'dataOwners'>, producers: ReadonlySet<string>): Promise<DataOwner[]> {
  const consumers: DataOwner[] = [];
  for (const owner of [...config.dataOwners].sort()) {
    const topics = await subscribedTopics(config, owner);
    const fed = topics.some((topic) => topic !== SITE_CHANGED_TOPIC && producers.has(parseTopic(topic).service));
    if (fed && topics.includes(SITE_CHANGED_TOPIC)) consumers.push(owner);
  }
  return consumers;
}

/** Each topic but the site topic that data owners consuming the site topic declare, with those owners, sorted. */
export async function siteTopicSubscribers(config: Pick<MigrationConfig, 'owners' | 'dataOwners'>): Promise<Map<string, DataOwner[]>> {
  const subscribers = new Map<string, DataOwner[]>();
  for (const owner of [...config.dataOwners].sort()) {
    const topics = await subscribedTopics(config, owner);
    if (!topics.includes(SITE_CHANGED_TOPIC)) continue;
    for (const topic of topics) if (topic !== SITE_CHANGED_TOPIC) subscribers.set(topic, [...(subscribers.get(topic) ?? []), owner]);
  }
  return subscribers;
}

/**
 * Reads `consumers`' registered tenants every {@link REGISTRATION_POLL_MS} until each lists every one of `tenants` or
 * {@link REGISTRATION_WAIT_MS} passed; a failed read counts as not registered yet.
 * @returns the consumers still lacking a tenant, none once all registered them, and the milliseconds waited.
 */
export async function awaitRegistration(
  ctx: Pick<MigrationContext, 'owners' | 'clock'>,
  consumers: readonly DataOwner[],
  tenants: readonly string[],
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
): Promise<{ unregistered: Unregistered[]; waitedMs: number }> {
  const started = ctx.clock.now().getTime();
  let waiting = consumers;
  for (;;) {
    const timeoutMs = Math.max(started + REGISTRATION_WAIT_MS - ctx.clock.now().getTime(), 1);
    const reads = await Promise.all(
      waiting.map(async (owner): Promise<Unregistered[]> => {
        try {
          const { registeredTenants = [] } = await ctx.owners.position(owner, { registeredTenants: true }, { timeoutMs });
          const missing = tenants.filter((tenantId) => !registeredTenants.includes(tenantId));
          return missing.length === 0 ? [] : [{ owner, missing }];
        } catch (error) {
          return [{ owner, missing: tenants, error }];
        }
      }),
    );
    const unregistered = reads.flat();
    const waitedMs = ctx.clock.now().getTime() - started;
    if (unregistered.length === 0 || waitedMs >= REGISTRATION_WAIT_MS) return { unregistered, waitedMs };
    waiting = unregistered.map((entry) => entry.owner);
    await sleep(Math.min(REGISTRATION_POLL_MS, REGISTRATION_WAIT_MS - waitedMs));
  }
}
