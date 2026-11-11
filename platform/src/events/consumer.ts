/** Idempotent event consumer: per-destination inbox receipts, tenant re-check and the `x-opt2-kind` version rules. */
import type { Logger } from '../logging/index.js';
import {
  SITE_CHANGED_TOPIC,
  TenantMismatchError,
  registryEntryForTenant,
  userPoolFanoutTenants,
  withTenant,
  type SiteChangedPayload,
  type TenantDb,
  type TenantTx,
  type tenantRegistryConsumer,
} from '../tenancy/index.js';
import { SpanKind, startSpan, withExtractedContext } from '../tracing/index.js';
import { CONSUMER_AGGREGATE_VERSION_TABLE, INBOX_TABLE } from './ddl.js';
import { DeadLetterError, type DeadLetterReason } from './dlq.js';
import { runWithConsumedEnvelope, type EventEnvelope } from './envelope.js';
import type { EventKind, TenantFanout } from './validation.js';

/** A subscription's consumer: the topic's declarations and the effect applied in each destination tenant. */
export interface ConsumerDefinition<P = unknown> {
  topic: string;
  kind: EventKind;
  fanout?: TenantFanout;
  /** On a `process` topic: a later aggregate version replaces the effect of an earlier one. */
  supersedes?: boolean;
  /** Re-checks the destination tenant against stored data; `false` dead-letters as `tenant-mismatch`. Defaults to a registry lookup. */
  checkTenant?(tx: TenantTx, envelope: EventEnvelope<P>): Promise<boolean | DeadLetterReason> | boolean | DeadLetterReason;
  /** Applies the event in `tx`, the destination tenant's transaction that also holds the inbox receipt. */
  apply(tx: TenantTx, envelope: EventEnvelope<P>, ctx: ConsumeContext): Promise<void> | void;
}

/** Per-destination context passed to `apply`. */
export interface ConsumeContext {
  subscription: string;
  messageId: string;
  destinationTenantId: string;
  /** True when the destination is a fan-out tenant rather than the envelope tenant. */
  isFanout: boolean;
  /** On a superseding topic: the aggregate version whose effect this event replaces, when one was applied. */
  previousEffectVersion?: number;
  deliveryAttempt?: number;
  logger: Logger;
}

/** Delivery details of one consume call. */
export interface ConsumeOptions {
  subscription: string;
  messageId: string;
  deliveryAttempt?: number;
  logger: Logger;
}

/** What one destination tenant did with the event. */
export type DestinationResult = 'applied' | 'duplicate' | 'stale' | 'superseded';

/** Per-destination results of one consume call, in destination order. */
export interface ConsumeOutcome {
  eventId: string;
  destinations: Array<{ tenantId: string; result: DestinationResult }>;
}

// tsc rejects this alias if the registry consumer stops being registrable without a cast.
type RegistryConsumerCheck<T extends ConsumerDefinition<SiteChangedPayload> = typeof tenantRegistryConsumer> = T;

/** The envelope tenant first, then, for a `userPool` fan-out, every registered tenant whose public or private user pool it is, sorted. */
export async function destinationTenants(
  db: TenantDb,
  def: Pick<ConsumerDefinition, 'fanout'>,
  envelope: Pick<EventEnvelope, 'tenantId'>,
): Promise<string[]> {
  const origin = envelope.tenantId.toLowerCase();
  if (def.fanout !== 'userPool') {
    return [origin];
  }
  const members = await userPoolFanoutTenants(db, origin);
  return [origin, ...members.filter((tenantId) => tenantId !== origin).sort()];
}

/**
 * Applies `envelope` once per destination tenant, each in its own transaction with its inbox receipt.
 * Throws DeadLetterError when a destination tenant fails the re-check; every other error propagates so the delivery is nacked.
 */
export function consumeEnvelope<P>(
  db: TenantDb,
  def: ConsumerDefinition<P>,
  envelope: EventEnvelope<P>,
  options: ConsumeOptions,
): Promise<ConsumeOutcome> {
  const { subscription, messageId } = options;
  return withExtractedContext({ traceparent: envelope.traceparent, tracestate: envelope.tracestate }, () =>
    startSpan(
      `events.consume ${subscription}`,
      SpanKind.CONSUMER,
      async (): Promise<ConsumeOutcome> => {
        const origin = envelope.tenantId.toLowerCase();
        const destinations: ConsumeOutcome['destinations'] = [];
        for (const tenantId of await destinationTenants(db, def, envelope)) {
          const result = await runWithConsumedEnvelope(envelope, () =>
            consumeIn(db, def, envelope, options, { tenantId, isFanout: tenantId !== origin }),
          );
          destinations.push({ tenantId, result });
        }
        const summary = destinations.map(({ tenantId, result }) => `${tenantId} ${result}`).join(', ');
        options.logger.info({ eventId: envelope.eventId, tenantId: origin }, `event consumed on ${subscription}: ${summary}`);
        return { eventId: envelope.eventId, destinations };
      },
      {
        'messaging.system': 'gcp_pubsub',
        'messaging.destination.name': def.topic,
        'messaging.message.id': messageId,
      },
    ),
  );
}

interface Destination {
  tenantId: string;
  isFanout: boolean;
}

async function consumeIn<P>(
  db: TenantDb,
  def: ConsumerDefinition<P>,
  envelope: EventEnvelope<P>,
  options: ConsumeOptions,
  destination: Destination,
): Promise<DestinationResult> {
  const ctx: ConsumeContext = {
    subscription: options.subscription,
    messageId: options.messageId,
    destinationTenantId: destination.tenantId,
    isFanout: destination.isFanout,
    ...(options.deliveryAttempt === undefined ? {} : { deliveryAttempt: options.deliveryAttempt }),
    logger: options.logger.child({ eventId: envelope.eventId, tenantId: destination.tenantId }),
  };
  const inbox = `${db.schema}.${INBOX_TABLE}`;
  try {
    return await withTenant(db, destination.tenantId, async (tx): Promise<DestinationResult> => {
      const receipt = await tx.query(
        `INSERT INTO ${inbox} (tenant_id, event_id, subscription, status) VALUES ($1, $2, $3, 'applied')` +
          ' ON CONFLICT (tenant_id, event_id) DO NOTHING',
        [tx.tenantId, envelope.eventId, options.subscription],
      );
      if (receipt.rowCount === 0) {
        return 'duplicate';
      }
      await recheckTenant(tx, def, envelope);
      if (def.kind === 'process' && def.supersedes !== true) {
        await def.apply(tx, envelope, ctx);
        return 'applied';
      }

      const key = [tx.tenantId, options.subscription, envelope.aggregateType, envelope.aggregateId];
      const last = await lockLastVersion(tx, db.schema, key);
      // Only a version at or below the last applied one is skipped; a gap is applied, since each later version supersedes the ones it skips.
      if (last !== null && envelope.aggregateVersion <= last) {
        const status = def.kind === 'state' ? 'stale' : 'superseded';
        await tx.query(`UPDATE ${inbox} SET status = $3 WHERE tenant_id = $1 AND event_id = $2`, [
          tx.tenantId,
          envelope.eventId,
          status,
        ]);
        return status;
      }
      await def.apply(tx, envelope, def.kind === 'process' && last !== null ? { ...ctx, previousEffectVersion: last } : ctx);
      await tx.query(
        `UPDATE ${db.schema}.${CONSUMER_AGGREGATE_VERSION_TABLE} SET last_version = $5, updated_at = LOCALTIMESTAMP(3)` +
          ' WHERE tenant_id = $1 AND subscription = $2 AND aggregate_type = $3 AND aggregate_id = $4',
        [...key, envelope.aggregateVersion],
      );
      return 'applied';
    });
  } catch (err) {
    // A stored aggregate or site belonging to another tenant classifies the delivery instead of failing it.
    if (err instanceof TenantMismatchError) {
      throw new DeadLetterError('tenant-mismatch', err.message);
    }
    throw err;
  }
}

async function recheckTenant<P>(tx: TenantTx, def: ConsumerDefinition<P>, envelope: EventEnvelope<P>): Promise<void> {
  const verdict = def.checkTenant === undefined ? await registeredTenant(tx, def.topic) : await def.checkTenant(tx, envelope);
  if (verdict !== true) {
    throw new DeadLetterError(verdict === false ? 'tenant-mismatch' : verdict, `destination tenant ${tx.tenantId}`);
  }
}

// The site.changed consumer is what registers a tenant, so its deliveries cannot require an existing entry.
async function registeredTenant(tx: TenantTx, topic: string): Promise<true | DeadLetterReason> {
  if (topic === SITE_CHANGED_TOPIC) {
    return true;
  }
  return (await registryEntryForTenant(tx, tx.tenantId)) === null ? 'invalid-tenant' : true;
}

async function lockLastVersion(tx: TenantTx, schema: string, key: readonly string[]): Promise<number | null> {
  const table = `${schema}.${CONSUMER_AGGREGATE_VERSION_TABLE}`;
  await tx.query(
    `INSERT INTO ${table} (tenant_id, subscription, aggregate_type, aggregate_id, last_version)` +
      ' VALUES ($1, $2, $3, $4, NULL) ON CONFLICT DO NOTHING',
    [...key],
  );
  const { rows } = await tx.query<{ last_version: string | null }>(
    `SELECT last_version FROM ${table}` +
      ' WHERE tenant_id = $1 AND subscription = $2 AND aggregate_type = $3 AND aggregate_id = $4 FOR UPDATE',
    [...key],
  );
  const last = rows[0]?.last_version ?? null;
  return last === null ? null : Number(last);
}
