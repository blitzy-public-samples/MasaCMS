/** Transactional outbox writes inside the business transaction, the roster-protocol operation hold, and the in-request flush registration. */
import { buildEnvelope, validateEnvelope, type EventEnvelope } from '../events/index.js';
import type { TenantTx } from '../tenancy/index.js';
import { localTimestamp, outboxTable, type OutboxKind } from './ddl.js';
import { flushAfterCommit, outboxRuntimeFor, type OutboxRuntime } from './flush.js';

/** Origin of the write that produced an event, as recorded in the changelog `origin`. */
export type OutboxOrigin = 'target' | 'legacy-window' | 'migration-feed' | 'backfill';

/** One event to write; the envelope tenant is always the transaction tenant. */
export interface OutboxWriteInput<P = unknown> {
  /** Full topic name, `<service>.<entity>.<event>.v<major>`. */
  topic: string;
  kind: OutboxKind;
  aggregateType: string;
  aggregateId: string;
  /** Producer's `row_version`, incremented in the same transaction as the write. */
  aggregateVersion: number;
  payload: P;
  correlationId?: string;
  causationId?: string;
  /** Open multi-participant operation; its rows stay held until `releaseOperation`. */
  operationId?: string;
  /** `backfill` and `migration-feed` suppress `process` events, whose effects legacy already produced. */
  origin?: OutboxOrigin;
}

/** Raised when an event's payload or envelope fails its contract; `errors` are `"<instancePath> <message>"` strings. */
export class OutboxPayloadError extends Error {
  override readonly name = 'OutboxPayloadError';
  readonly topic: string;
  readonly errors: string[];

  constructor(topic: string, errors: string[], subject: 'payload' | 'envelope' = 'payload') {
    super(`Outbox ${subject} rejected for topic ${JSON.stringify(topic)}: ${errors.join('; ')}`);
    this.topic = topic;
    this.errors = errors;
  }
}

/** Raised when outbox work is given a metadata transaction or no tenant transaction. */
export class OutboxTransactionError extends Error {
  override readonly name = 'OutboxTransactionError';

  constructor(kind: unknown) {
    super(`Outbox rows are tenant-owned and need a tenant transaction; got ${kind === undefined ? 'none' : JSON.stringify(kind)}`);
  }
}

const SUPPRESSED_PROCESS_ORIGINS: ReadonlySet<OutboxOrigin> = new Set(['backfill', 'migration-feed']);

// Event ids each open transaction flushes after COMMIT; the commit callback is registered once per transaction.
const pendingFlush = new WeakMap<TenantTx, { ids: string[] }>();

function assertTenantTx(tx: TenantTx): void {
  const kind = (tx as { kind?: unknown } | null | undefined)?.kind;
  if (kind !== 'tenant') {
    throw new OutboxTransactionError(kind);
  }
}

function registerFlush(tx: TenantTx, runtime: OutboxRuntime, ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }
  let entry = pendingFlush.get(tx);
  if (entry === undefined) {
    const created = { ids: [] as string[] };
    tx.onCommit(async () => {
      await flushAfterCommit(runtime, tx.tenantId, created.ids);
    });
    pendingFlush.set(tx, created);
    entry = created;
  }
  entry.ids.push(...ids);
}

/**
 * Writes one outbox row in `tx` and, unless it is held, schedules its publish after COMMIT.
 * `runtime` defaults to the one registered for `tx.schema`, resolved after the transaction check.
 * Returns the stored envelope, or null when `origin` suppresses a `process` event.
 * Throws OutboxTransactionError without a tenant transaction and OutboxPayloadError when the payload or envelope fails its contract.
 */
export async function writeOutbox<P>(
  tx: TenantTx,
  input: OutboxWriteInput<P>,
  runtime?: OutboxRuntime,
): Promise<EventEnvelope<P> | null> {
  assertTenantTx(tx);
  if (input.kind === 'process' && input.origin !== undefined && SUPPRESSED_PROCESS_ORIGINS.has(input.origin)) {
    return null;
  }
  const rt = runtime ?? outboxRuntimeFor(tx.schema);
  const payloadCheck = rt.payloadValidators?.get(input.topic)?.validatePayload(input.payload);
  if (payloadCheck !== undefined && !payloadCheck.ok) {
    throw new OutboxPayloadError(input.topic, payloadCheck.errors);
  }

  const now = rt.clock.now();
  const envelope = buildEnvelope<P>({
    topic: input.topic,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    payload: input.payload,
    tenantId: tx.tenantId,
    producer: rt.service,
    occurredAt: now,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
  });
  // The publisher rejects a non-conforming envelope, so such a row would block its ordering key in every sweep.
  const envelopeCheck = validateEnvelope(envelope);
  if (!envelopeCheck.ok) {
    throw new OutboxPayloadError(input.topic, envelopeCheck.errors, 'envelope');
  }

  const held = input.operationId !== undefined;
  await tx.query(
    `INSERT INTO ${outboxTable(tx.schema)} (tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at)` +
      ' VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)',
    [
      tx.tenantId,
      envelope.eventId,
      input.topic,
      input.kind,
      input.aggregateId,
      JSON.stringify(envelope),
      input.operationId ?? null,
      held,
      localTimestamp(now),
    ],
  );
  if (!held) {
    registerFlush(tx, rt, [envelope.eventId]);
  }
  return envelope;
}

/** Unholds the rows of `operationId` in `tx`, schedules their publish after COMMIT and returns how many were released; `runtime` defaults as in writeOutbox. */
export async function releaseOperation(tx: TenantTx, operationId: string, runtime?: OutboxRuntime): Promise<number> {
  assertTenantTx(tx);
  const rt = runtime ?? outboxRuntimeFor(tx.schema);
  const { rows } = await tx.query<{ event_id: string }>(
    `UPDATE ${outboxTable(tx.schema)} SET held = false WHERE operation_id = $1 AND held RETURNING event_id`,
    [operationId],
  );
  registerFlush(tx, rt, rows.map((row) => row.event_id));
  return rows.length;
}

/** Deletes the held rows of `operationId` in `tx`, so a rolled-back operation never publishes; returns how many were removed. */
export async function discardOperation(tx: TenantTx, operationId: string): Promise<number> {
  assertTenantTx(tx);
  const result = await tx.query(`DELETE FROM ${outboxTable(tx.schema)} WHERE operation_id = $1 AND held`, [operationId]);
  return result.rowCount ?? 0;
}
