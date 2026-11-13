/** Outbox runtime registry, the row selection and publishing shared by flush, sweep and replay, and the in-request flush after commit. */
import { untilAborted } from '../auth/deadline.js';
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

/** Longest an in-request flush waits on row locks and publishes before it leaves its rows to the sweep. */
export const FLUSH_DEADLINE_MS = 2_000;

const SET_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";

/**
 * Counts of one publishing pass; `skipped` rows stay unpublished behind a failed, held or unpublished earlier row of their ordering key,
 * or were left unattempted once the pass's deadline passed.
 */
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

/** Rows {@link selectPublishable} locks: the ordering keys of `eventIds` up to their latest named row, or a `limit` page after seq `after`. */
export type SelectPublishableOptions = { eventIds: readonly string[] } | { limit: number; after?: string };

/** Locks the tenant's unpublished, unheld rows in `seq` order: waiting for other lockers with `eventIds`, otherwise skipping locked rows. */
export async function selectPublishable(tx: TenantTx, schema: string, opts: SelectPublishableOptions): Promise<OutboxRow[]> {
  const table = outboxTable(schema);
  if ('eventIds' in opts) {
    const { rows } = await tx.query(
      `SELECT o.* FROM ${table} o JOIN (SELECT ordering_key, max(seq) AS upto FROM ${table}` +
        ' WHERE event_id = ANY($1::uuid[]) AND published_at IS NULL AND NOT held GROUP BY ordering_key) named' +
        ' ON o.ordering_key = named.ordering_key AND o.seq <= named.upto' +
        ' WHERE o.published_at IS NULL AND NOT o.held ORDER BY o.seq FOR UPDATE OF o',
      [opts.eventIds],
    );
    return rows.map(rowFromDb);
  }
  const { limit, after } = opts;
  const paged = after !== undefined;
  const sql =
    `SELECT * FROM ${table} WHERE published_at IS NULL AND NOT held` +
    (paged ? ' AND seq > $1::bigint' : '') +
    ` ORDER BY seq LIMIT $${paged ? 2 : 1} FOR UPDATE SKIP LOCKED`;
  const { rows } = await tx.query(sql, paged ? [after, limit] : [limit]);
  return rows.map(rowFromDb);
}

/** Splits locked `rows` into those publishable now and the count behind an earlier unpublished or held row of their key that `rows` lacks. */
export async function dropBlockedRows(
  tx: TenantTx,
  schema: string,
  rows: readonly OutboxRow[],
): Promise<{ rows: OutboxRow[]; blocked: number }> {
  if (rows.length === 0) {
    return { rows: [], blocked: 0 };
  }
  const seqs = rows.map((row) => row.seq);
  const last = seqs.reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max));
  // `published_at IS NULL` spelled so the unpublished and held partial indexes serve it; held rows are never published.
  const { rows: found } = await tx.query<{ ordering_key: string; seq: string }>(
    `SELECT ordering_key, min(seq)::text AS seq FROM ${outboxTable(schema)}` +
      ' WHERE ((published_at IS NULL AND NOT held) OR held) AND ordering_key = ANY($1::text[])' +
      ' AND seq < $2::bigint AND seq <> ALL($3::bigint[]) GROUP BY ordering_key',
    [[...new Set(rows.map((row) => row.orderingKey))], last, seqs],
  );
  const firstBlocker = new Map(found.map((r) => [r.ordering_key, BigInt(r.seq)]));
  const open = rows.filter((row) => {
    const blocker = firstBlocker.get(row.orderingKey);
    return blocker === undefined || BigInt(row.seq) < blocker;
  });
  return { rows: open, blocked: rows.length - open.length };
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
 * Once `signal` aborts, a publish still pending counts as failed and every row not yet attempted as skipped.
 */
export async function publishLockedRows(
  tx: TenantTx,
  runtime: OutboxRuntime,
  rows: readonly OutboxRow[],
  opts: { stamp?: 'unpublished-only' | 'none'; signal?: AbortSignal } = {},
): Promise<PublishSummary> {
  const failedKeys = new Set<string>();
  const published: string[] = [];
  let failed = 0;
  let skipped = 0;
  for (const row of [...rows].sort(bySeq)) {
    if (failedKeys.has(row.orderingKey) || opts.signal?.aborted) {
      skipped += 1;
      continue;
    }
    try {
      await untilAborted(runtime.publisher.publish(row.topic, row.envelope as unknown as EventEnvelope), opts.signal);
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
 * Commit callback publishing and stamping the rows `eventIds` names after their keys' earlier unpublished rows, in a fresh tenant transaction.
 * Bounded by FLUSH_DEADLINE_MS: rows whose locks or publishes are not confirmed in time are left to the sweep.
 * Never throws: on error nothing is stamped, every id counts as failed and the rows are left to the sweep, as are rows behind a held row.
 */
export async function flushAfterCommit(
  runtime: OutboxRuntime,
  tenantId: string,
  eventIds: readonly string[],
): Promise<PublishSummary> {
  if (eventIds.length === 0) {
    return { published: 0, failed: 0, skipped: 0 };
  }
  const { schema } = runtime.db;
  const signal = AbortSignal.timeout(FLUSH_DEADLINE_MS);
  try {
    return await runtime.db.withTenant(tenantId, async (tx) => {
      await tx.query(SET_LOCK_TIMEOUT_SQL, [`${FLUSH_DEADLINE_MS}ms`]);
      const { rows, blocked } = await dropBlockedRows(tx, schema, await selectPublishable(tx, schema, { eventIds }));
      const summary = await publishLockedRows(tx, runtime, rows, { signal });
      return { ...summary, skipped: summary.skipped + blocked };
    });
  } catch (err) {
    runtime.logger.error(
      { tenantId, error: serializeError(err) },
      `outbox flush failed for events ${eventIds.join(',')}`,
    );
    return { published: 0, failed: eventIds.length, skipped: 0 };
  }
}
