/** Producer of `programs-sites.site.changed.v1`, the full-state site event that feeds every service's tenant registry. */
import type { EventEnvelope } from '@opt2/platform/events';
import { writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import { SITE_CHANGED_TOPIC, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';

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

/** Writes the site's `state` outbox row in `tx`; the envelope tenant is the transaction tenant. */
export function writeSiteChanged(tx: TenantTx, args: SiteChangedArgs): Promise<EventEnvelope<SiteChangedPayload> | null> {
  return writeOutbox(tx, {
    topic: TOPIC,
    kind: 'state',
    aggregateType: 'site',
    aggregateId: args.siteId,
    aggregateVersion: Number(args.rowVersion),
    payload: args.payload,
    origin: args.origin,
  });
}
