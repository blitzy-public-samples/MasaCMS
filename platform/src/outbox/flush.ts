/** Outbox runtime registry, the row selection and publishing shared by flush, sweep and replay, and the in-request flush after commit. */
import type { EventEnvelope, EventPublisher, TopicValidator } from '../events/index.js';
import { serializeError, type Logger } from '../logging/index.js';
import { systemClock, type Clock } from '../service-kit/index.js';
import type { TenantDb, TenantTx } from '../tenancy/index.js';
import { localTimestamp, outboxTable, rowFromDb, type OutboxRow } from './ddl.js';

/** What the outbox needs to write and publish rows of one service schema. */
export interface OutboxRuntime {
  service: string;
  db: TenantDb;
  publisher: EventPublisher;
  logger: Logger;
  clock: Clock;
  /** Payload validators by topic name, checked when a row is written. */
  payloadValidators?: ReadonlyMap<string, TopicValidator>;
}

/** Options of {@link createOutbox}; `clock` defaults to the system clock. */
export interface CreateOutboxOptions {
  service: string;
  db: TenantDb;
  publisher: EventPublisher;
  logger: Logger;
  clock?: Clock;
  payloadValidators?: Record<string, TopicValidator> | Map<string, TopicValidator>;
}

/** Counts of one publishing pass; `skipped` rows follow a failed row with the same ordering key and stay unpublished. */
export interface PublishSummary {
  published: number;
  failed: number;
  skipped: number;
}

/** Raised when no outbox runtime is registered for a schema. */
export class OutboxNotConfiguredError extends Error {
  override readonly name = 'OutboxNotConfiguredError';
  readonly schema: string;

  constructor(schema: string) {
    super(`No outbox runtime is registered for schema ${JSON.stringify(schema)}; call createOutbox at start-up`);
    this.schema = schema;
  }
}

const runtimes = new Map<string, OutboxRuntime>();

/** Builds the runtime of `opts.db.schema` and registers it, replacing an earlier registration for that schema. */
export function createOutbox(opts: CreateOutboxOptions): OutboxRuntime {
  const { payloadValidators } = opts;
  const runtime: OutboxRuntime = {
    service: opts.service,
    db: opts.db,
    publisher: opts.publisher,
    logger: opts.logger,
    clock: opts.clock ?? systemClock,
    payloadValidators:
      payloadValidators === undefined || payloadValidators instanceof Map
        ? payloadValidators
        : new Map(Object.entries(payloadValidators)),
  };
  runtimes.set(opts.db.schema, runtime);
  return runtime;
}

/** The runtime registered for `schema`; throws OutboxNotConfiguredError when there is none. */
export function outboxRuntimeFor(schema: string): OutboxRuntime {
  const runtime = runtimes.get(schema);
  if (runtime === undefined) {
    throw new OutboxNotConfiguredError(schema);
  }
  return runtime;
}

/** Forgets every registered runtime. */
export function resetOutboxRuntimes(): void {
  runtimes.clear();
}

/** Locks up to `limit` unpublished, unheld rows of the transaction tenant in `seq` order, skipping rows another transaction holds. */
export async function selectPublishable(
  tx: TenantTx,
  schema: string,
  opts: { eventIds?: readonly string[]; limit: number },
): Promise<OutboxRow[]> {
  const { eventIds, limit } = opts;
  const byId = eventIds !== undefined;
  const sql =
    `SELECT * FROM ${outboxTable(schema)} WHERE published_at IS NULL AND NOT held` +
    (byId ? ' AND event_id = ANY($1::uuid[])' : '') +
    ` ORDER BY seq LIMIT $${byId ? 2 : 1} FOR UPDATE SKIP LOCKED`;
  const { rows } = await tx.query(sql, byId ? [eventIds, limit] : [limit]);
  return rows.map(rowFromDb);
}

function bySeq(a: OutboxRow, b: OutboxRow): number {
  const x = BigInt(a.seq);
  const y = BigInt(b.seq);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Publishes `rows` one at a time in `seq` order with their stored envelopes, then stamps the published ones in `tx`.
 * After a failed publish, later rows with the same ordering key are skipped, so a key's events never leave out of order.
 * `stamp: 'unpublished-only'` (default) sets `published_at` only where it is null; `'none'` stamps nothing.
 */
export async function publishLockedRows(
  tx: TenantTx,
  runtime: OutboxRuntime,
  rows: readonly OutboxRow[],
  opts: { stamp?: 'unpublished-only' | 'none' } = {},
): Promise<PublishSummary> {
  const failedKeys = new Set<string>();
  const published: string[] = [];
  let failed = 0;
  let skipped = 0;
  for (const row of [...rows].sort(bySeq)) {
    if (failedKeys.has(row.orderingKey)) {
      skipped += 1;
      continue;
    }
    try {
      await runtime.publisher.publish(row.topic, row.envelope as unknown as EventEnvelope);
      published.push(row.eventId);
    } catch (err) {
      failed += 1;
      failedKeys.add(row.orderingKey);
      runtime.logger.error(
        { eventId: row.eventId, tenantId: row.tenantId, error: serializeError(err) },
        'outbox publish failed',
      );
    }
  }
  if (published.length > 0 && (opts.stamp ?? 'unpublished-only') === 'unpublished-only') {
    await tx.query(
      `UPDATE ${outboxTable(tx.schema)} SET published_at = $1 WHERE event_id = ANY($2::uuid[]) AND published_at IS NULL`,
      [localTimestamp(runtime.clock.now()), published],
    );
  }
  return { published: published.length, failed, skipped };
}

/**
 * Publishes and stamps the rows `eventIds` names in a fresh tenant transaction; registered as a commit callback, so the
 * committing request answers only after it. Never throws: on error nothing is stamped, every id counts as failed and
 * the rows are left to the sweep, as are rows a concurrent sweep has locked.
 */
export async function flushAfterCommit(
  runtime: OutboxRuntime,
  tenantId: string,
  eventIds: readonly string[],
): Promise<PublishSummary> {
  if (eventIds.length === 0) {
    return { published: 0, failed: 0, skipped: 0 };
  }
  try {
    return await runtime.db.withTenant(tenantId, async (tx) => {
      const rows = await selectPublishable(tx, runtime.db.schema, { eventIds, limit: eventIds.length });
      return publishLockedRows(tx, runtime, rows);
    });
  } catch (err) {
    runtime.logger.error(
      { tenantId, error: serializeError(err) },
      `outbox flush failed for events ${eventIds.join(',')}`,
    );
    return { published: 0, failed: eventIds.length, skipped: 0 };
  }
}
