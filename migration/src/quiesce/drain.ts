/** Drain barrier: waits until the owners' outboxes are published and their consumers hold the asked receipts. */
import { setTimeout as delay } from 'node:timers/promises';

import type { PositionResponse } from '@opt2/platform/migration-kit';
import { OUTBOX_PRODUCERS, callQueueControl, outboxSweepQueue } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import type { DataOwner } from '../owners/index.js';

/** Poll interval used when the caller gives none; the configuration defines no drain interval. */
export const DEFAULT_DRAIN_POLL_MS = 1000;

/** Drain counts of one owner, read from its `GET /internal/v1/migration/position` answer. */
export interface OwnerDrainCounts {
  owner: string;
  /** Outbox rows still to publish, held rows excluded. */
  unpublished: number;
  /** Outbox rows held by open multi-participant operations; still unpublished events. */
  held: number;
  /** Asked event ids that no tenant's inbox holds yet. */
  pendingReceipts: number;
}

/** Roles an owner is checked for: its outbox as a producer, its inbox receipts as a consumer. */
export interface DrainRole {
  producer: boolean;
  consumer: boolean;
}

/** Options of {@link awaitDrained}. */
export interface AwaitDrainedOptions {
  /** Owners checked as producers; every configured data owner when absent. */
  owners?: readonly DataOwner[];
  /** Unit ids whose owners are checked as consumers; when absent the producers are checked as consumers too. */
  consumersWriting?: readonly string[];
  /** Events whose receipts every consumer checked must hold; owners report receipts only for asked ids, so none are required when absent. */
  eventIds?: readonly string[];
  /** Waiting budget; the drain fails once it has passed. */
  timeoutMs: number;
  /** Pause between polls; {@link DEFAULT_DRAIN_POLL_MS} when absent. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
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
export type DrainContext = Pick<MigrationContext, 'config' | 'clock' | 'catalog' | 'owners' | 'client'>;

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

/** `owner(name=value, ...)` with the counts of the owner's roles. */
function describe({ counts, role }: CheckedOwner): string {
  const parts = [
    ...(role.producer ? [`unpublished=${String(counts.unpublished)}`, `held=${String(counts.held)}`] : []),
    ...(role.consumer ? [`pendingReceipts=${String(counts.pendingReceipts)}`] : []),
  ];
  return `${counts.owner}(${parts.join(', ')})`;
}

/** Drain counts of `owner` from its position answer; an owner without an outbox or inbox counts zero there. */
export function ownerDrainCounts(owner: string, position: PositionResponse): OwnerDrainCounts {
  // The position answer has no pending-receipt count: a receipt is pending when an asked event id maps to no tenant.
  const receipts = Object.values(position.inbox?.receipts ?? {});
  return {
    owner,
    unpublished: position.outbox?.unpublished ?? 0,
    held: position.outbox?.held ?? 0,
    pendingReceipts: receipts.filter((tenants) => tenants.length === 0).length,
  };
}

/** True when every count of the given roles is zero. */
export function isDrained(c: OwnerDrainCounts, role: DrainRole): boolean {
  const producerDrained = !role.producer || (c.unpublished === 0 && c.held === 0);
  const consumerDrained = !role.consumer || c.pendingReceipts === 0;
  return producerDrained && consumerDrained;
}

/** Each owner checked, polled once, with its roles; producers first, then consumers in unit order. */
function drainRoles(ctx: DrainContext, options: AwaitDrainedOptions): Map<DataOwner, DrainRole> {
  const producers = options.owners ?? ctx.config.dataOwners;
  const consumers =
    options.consumersWriting === undefined ? producers : options.consumersWriting.map((unit) => ctx.catalog.ownerOf(unit));
  const roles = new Map<DataOwner, DrainRole>();
  for (const owner of producers) roles.set(owner, { producer: true, consumer: false });
  for (const owner of consumers) roles.set(owner, { producer: roles.get(owner)?.producer ?? false, consumer: true });
  return roles;
}

const SWEEP_PRODUCERS: ReadonlySet<string> = new Set(OUTBOX_PRODUCERS);

/**
 * Polls the owners' positions until each is drained for its roles, after ensuring the sweep chain of every producer with outbox rows.
 * @throws DrainTimeoutError once `timeoutMs` has passed with an owner not drained; an owner call failure propagates at once.
 */
export async function awaitDrained(ctx: DrainContext, options: AwaitDrainedOptions): Promise<DrainResult> {
  const { timeoutMs } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DRAIN_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const roles = [...drainRoles(ctx, options)];
  const startedAt = ctx.clock.now().getTime();
  const deadline = startedAt + timeoutMs;

  const poll = (): Promise<CheckedOwner[]> =>
    Promise.all(
      roles.map(async ([owner, role]) => {
        const position = await ctx.owners.position(owner, role.consumer ? options.eventIds : undefined);
        return { counts: ownerDrainCounts(owner, position), role };
      }),
    );

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
}
