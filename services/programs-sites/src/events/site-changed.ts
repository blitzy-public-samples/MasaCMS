/** Producer of `programs-sites.site.changed.v1`, the full-state site event that feeds every service's tenant registry. */
import type { EventEnvelope } from '@opt2/platform/events';
import { outboxTable, writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';

/** Topic of the site state event. */
export const TOPIC = SITE_CHANGED_TOPIC;

/** One committed site write to announce. */
export interface SiteChangedArgs {
  siteId: string;
  /** The site's `row_version` after the write, incremented in the same transaction. */
  rowVersion: bigint | number;
  /** Laxer than the generated contract type (nullable pools); the outbox's topic payload validator enforces the contract. */
  payload: SiteChangedPayload;
  origin?: OutboxOrigin;
}

/** Writes the site's `state` outbox row in `tx` and applies it to this service's own tenant registry there; the envelope tenant is the transaction tenant. */
export async function writeSiteChanged(tx: TenantTx, args: SiteChangedArgs): Promise<EventEnvelope<SiteChangedPayload> | null> {
  const envelope = await writeOutbox(tx, {
    topic: TOPIC,
    kind: 'state',
    aggregateType: 'site',
    aggregateId: args.siteId,
    aggregateVersion: Number(args.rowVersion),
    payload: args.payload,
    origin: args.origin,
  });
  if (envelope !== null) await tenantRegistryConsumer.apply(tx, envelope);
  return envelope;
}

/** Highest `aggregateVersion` announced for `siteId` in any letter case in `tx`'s tenant outbox, deletions included; 0 when none. */
export async function lastAnnouncedVersion(tx: TenantTx, siteId: string): Promise<bigint> {
  const { rows } = await tx.query<{ version: string | null }>(
    `SELECT max((envelope->>'aggregateVersion')::bigint)::text AS version FROM ${outboxTable(tx.schema)}` +
      ' WHERE tenant_id = $1 AND topic = $2 AND lower(ordering_key) = lower($3)',
    [tx.tenantId, TOPIC, siteId],
  );
  return BigInt(rows[0]?.version ?? 0);
}
