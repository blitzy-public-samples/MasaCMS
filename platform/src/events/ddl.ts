/** DDL of the tenant-owned consumer tables: the idempotency inbox and per-aggregate ordering progress. */
import { rlsSql } from '../tenancy/index.js';

/** Inbox of applied deliveries, unique per destination tenant and event. */
export const INBOX_TABLE = 'inbox';

/** Last applied `aggregateVersion` per tenant, subscription and aggregate. */
export const CONSUMER_AGGREGATE_VERSION_TABLE = 'consumer_aggregate_version';

/** Outcomes recorded for an inbox row. */
export const INBOX_STATUSES = ['applied', 'stale', 'superseded'] as const;

/** Outcome recorded for an inbox row. */
export type InboxStatus = (typeof INBOX_STATUSES)[number];

const TIMESTAMP_COLUMN = 'timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3)';

// rlsSql runs first because it validates the schema identifier before the schema is interpolated unquoted.
function tenantTableSql(schema: string, table: string, body: readonly string[]): string {
  const rls = rlsSql(schema, table);
  return [`CREATE TABLE ${schema}.${table} (`, body.join(',\n'), ');', rls].join('\n') + '\n';
}

/** Returns the DDL and RLS policy of `<schema>.inbox`. */
export function inboxSql(schema: string): string {
  const statuses = INBOX_STATUSES.map((status) => `'${status}'`).join(',');
  return tenantTableSql(schema, INBOX_TABLE, [
    '  tenant_id uuid NOT NULL',
    '  event_id uuid NOT NULL',
    '  subscription text NOT NULL',
    `  received_at ${TIMESTAMP_COLUMN}`,
    `  status text NOT NULL CHECK (status IN (${statuses}))`,
    '  PRIMARY KEY (tenant_id, event_id)',
  ]);
}

/** Returns the DDL and RLS policy of `<schema>.consumer_aggregate_version`; a NULL `last_version` means nothing applied yet. */
export function consumerAggregateVersionSql(schema: string): string {
  return tenantTableSql(schema, CONSUMER_AGGREGATE_VERSION_TABLE, [
    '  tenant_id uuid NOT NULL',
    '  subscription text NOT NULL',
    '  aggregate_type text NOT NULL',
    '  aggregate_id text NOT NULL',
    '  last_version bigint NULL',
    `  updated_at ${TIMESTAMP_COLUMN}`,
    '  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)',
  ]);
}

/** Returns the inbox and aggregate-version DDL, separated by a blank line, for a service migration. */
export function eventsSql(schema: string): string {
  return `${inboxSql(schema)}\n${consumerAggregateVersionSql(schema)}`;
}
