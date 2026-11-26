/** DDL of the tenant-owned transactional outbox and the row shape its flush, sweep and CLI read. */
import { cfDateTimeFormat } from '../legacy-compat/index.js';
import { rlsSql, type QueryResultRow } from '../tenancy/index.js';

/** Outbox table name inside every producing service schema. */
export const OUTBOX_TABLE = 'outbox' as const;

/** Event kinds an outbox row may carry, as a topic schema declares them in `x-opt2-kind`. */
export const OUTBOX_KINDS = ['state', 'process'] as const;

/** Event kind of an outbox row. */
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** Stored event envelope as parsed from `jsonb`. */
export type EventEnvelopeLike = Record<string, unknown>;

/** One outbox row; `seq` is text because pg returns `bigint` as a string, timestamps are local `yyyy-MM-dd HH:mm:ss.SSS`. */
export interface OutboxRow {
  seq: string;
  tenantId: string;
  eventId: string;
  topic: string;
  kind: OutboxKind;
  orderingKey: string;
  envelope: EventEnvelopeLike;
  operationId: string | null;
  held: boolean;
  createdAt: string;
  publishedAt: string | null;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// The schema is interpolated unquoted into DDL, so only lower-case snake identifiers are accepted.
function schemaIdent(schema: string): string {
  if (typeof schema !== 'string' || !IDENTIFIER.test(schema)) {
    throw new TypeError(`Invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  return schema;
}

/** Formats `date` in the process zone as a `timestamp(3) without time zone` literal, e.g. `2026-06-30 14:05:09.123`. */
export function localTimestamp(date: Date): string {
  return cfDateTimeFormat(date, 'yyyy-MM-dd HH:nn:ss.lll');
}

// pg parses `timestamp without time zone` into a Date in the process zone unless the query selects it as text.
function timestampText(value: Date | string): string {
  return value instanceof Date ? localTimestamp(value) : value;
}

/** Maps a snake_case outbox result row to an OutboxRow. */
export function rowFromDb(r: QueryResultRow): OutboxRow {
  return {
    seq: String(r.seq),
    tenantId: r.tenant_id,
    eventId: r.event_id,
    topic: r.topic,
    kind: r.kind,
    orderingKey: r.ordering_key,
    envelope: r.envelope,
    operationId: r.operation_id ?? null,
    held: r.held,
    createdAt: timestampText(r.created_at),
    publishedAt: r.published_at == null ? null : timestampText(r.published_at),
  };
}

/** Returns the schema-qualified outbox identifier `"<schema>".outbox`; throws `TypeError` for an invalid schema. */
export function outboxTable(schema: string): string {
  return `"${schemaIdent(schema)}".${OUTBOX_TABLE}`;
}

/** Returns the table, index and RLS DDL of `<schema>.outbox`, newline-terminated; throws `TypeError` for an invalid schema. */
export function outboxSql(schema: string): string {
  const table = `${schemaIdent(schema)}.${OUTBOX_TABLE}`;
  const kinds = OUTBOX_KINDS.map((kind) => `'${kind}'`).join(',');
  const statements = [
    `CREATE TABLE ${table} (`,
    '  seq bigint GENERATED ALWAYS AS IDENTITY,',
    '  tenant_id uuid NOT NULL,',
    '  event_id uuid PRIMARY KEY,',
    '  topic text NOT NULL,',
    `  kind text NOT NULL CHECK (kind IN (${kinds})),`,
    '  ordering_key text NOT NULL,',
    '  envelope jsonb NOT NULL,',
    '  operation_id text NULL,',
    '  held boolean NOT NULL DEFAULT false,',
    '  created_at timestamp(3) without time zone NOT NULL,',
    '  published_at timestamp(3) without time zone NULL',
    ');',
    `CREATE INDEX outbox_unpublished_idx ON ${table} (tenant_id, seq) WHERE published_at IS NULL AND NOT held;`,
    `CREATE INDEX outbox_held_idx ON ${table} (tenant_id, operation_id) WHERE held;`,
    `CREATE INDEX outbox_created_idx ON ${table} (tenant_id, created_at);`,
    rlsSql(schema, OUTBOX_TABLE),
  ];
  return `${statements.join('\n')}\n`;
}
