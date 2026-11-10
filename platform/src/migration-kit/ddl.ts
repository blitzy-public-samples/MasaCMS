/** DDL and value sets of the migration-kit changelog, unit gates, open operations, applied batches and watermarks. */
import { rlsSql } from '../tenancy/index.js';

/** Tenant-owned audit and reverse-projection feed of every tenant-table write. */
export const CHANGELOG_TABLE = 'changelog';

/** Non-tenant write-authority gate, one row per target-table unit. */
export const UNIT_GATE_TABLE = 'unit_gate';

/** Non-tenant registry of multi-transaction operations in progress. */
export const OPEN_OPERATION_TABLE = 'open_operation';

/** Tenant-owned record of applied migration batches, for idempotent re-delivery. */
export const MIGRATION_BATCH_TABLE = 'migration_batch';

/** Non-tenant per-legacy-table feed watermark. */
export const MIGRATION_WATERMARK_TABLE = 'migration_watermark';

/** Changelog operations. */
export const CHANGE_OPS = ['insert', 'update', 'delete'] as const;

/** One changelog operation. */
export type ChangeOp = (typeof CHANGE_OPS)[number];

/** Origins of a changelog row. */
export const CHANGE_ORIGINS = ['target', 'legacy-window', 'migration-feed', 'backfill'] as const;

/** Origin of a changelog row. */
export type ChangeOrigin = (typeof CHANGE_ORIGINS)[number];

/** Write-authority states of a unit gate. */
export const GATE_STATES = ['legacy', 'open', 'closed'] as const;

/** Write-authority state of a unit gate. */
export type GateState = (typeof GATE_STATES)[number];

/** Window or transition phases of a unit gate. */
export const GATE_PHASES = ['quiet', 'executing', 'importing', 'import-pending'] as const;

/** Window or transition phase of a unit gate. */
export type GatePhase = (typeof GATE_PHASES)[number];

/** Directions of a migration watermark. */
export const WATERMARK_DIRECTIONS = ['forward', 'reverse'] as const;

/** Direction of a migration watermark. */
export type WatermarkDirection = (typeof WATERMARK_DIRECTIONS)[number];

const BATCH_ORIGINS = ['backfill', 'migration-feed', 'legacy-window'] as const satisfies readonly ChangeOrigin[];

/** Service-schema tables written by platform internals, never through the changelog hook. */
export const PLATFORM_INFRA_TABLES = Object.freeze([
  'outbox',
  'inbox',
  'consumer_aggregate_version',
  CHANGELOG_TABLE,
  'scheduled_task_queue',
  'scheduled_task_queue_state',
  MIGRATION_BATCH_TABLE,
  MIGRATION_WATERMARK_TABLE,
  UNIT_GATE_TABLE,
  OPEN_OPERATION_TABLE,
  'tenant_registry',
  'tenant_grant',
] as const);

/** Name of a platform infrastructure table. */
export type PlatformInfraTable = (typeof PLATFORM_INFRA_TABLES)[number];

const platformInfraTables: ReadonlySet<string> = new Set(PLATFORM_INFRA_TABLES);

/** True when `name` is a platform infrastructure table. */
export function isPlatformInfraTable(name: string): name is PlatformInfraTable {
  return platformInfraTables.has(name);
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string, label: string): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new TypeError(`Invalid ${label} identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Returns `"<schema>"."<table>"`; throws `TypeError` unless both are lower-case snake identifiers. */
export function qualified(schema: string, table: string): string {
  return `"${identifier(schema, 'schema')}"."${identifier(table, 'table')}"`;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

function createTable(schema: string, table: string, body: readonly string[]): string[] {
  return [`CREATE TABLE ${identifier(schema, 'schema')}.${table} (`, ...body, ');'];
}

function statements(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** Returns the DDL, indexes and RLS of the tenant-owned `<schema>.changelog`. */
export function changelogSql(schema: string): string {
  const table = `${identifier(schema, 'schema')}.${CHANGELOG_TABLE}`;
  return statements([
    ...createTable(schema, CHANGELOG_TABLE, [
      '  tenant_id uuid NOT NULL,',
      '  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),',
      '  seq bigserial NOT NULL,',
      '  "table" text NOT NULL,',
      `  op text NOT NULL CHECK (op IN (${sqlList(CHANGE_OPS)})),`,
      '  key text NOT NULL,',
      '  before text,',
      '  after text,',
      "  columns text[] NOT NULL DEFAULT '{}',",
      `  origin text NOT NULL CHECK (origin IN (${sqlList(CHANGE_ORIGINS)})),`,
      '  actor_user_id text,',
      '  actor_service text,',
      '  at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),',
      '  request_id text,',
      '  operation_id text,',
      '  PRIMARY KEY (tenant_id, seq),',
      "  CHECK ((op = 'insert' AND before IS NULL AND after IS NOT NULL)",
      "      OR (op = 'update' AND before IS NOT NULL AND after IS NOT NULL)",
      "      OR (op = 'delete' AND before IS NOT NULL AND after IS NULL))",
    ]),
    `CREATE INDEX changelog_cursor_idx ON ${table} (tenant_id, xid, seq);`,
    `CREATE INDEX changelog_operation_idx ON ${table} (tenant_id, operation_id) WHERE operation_id IS NOT NULL;`,
    rlsSql(schema, CHANGELOG_TABLE),
  ]);
}

/** Returns the DDL of the non-tenant `<schema>.unit_gate`. */
export function unitGateSql(schema: string): string {
  return statements(
    createTable(schema, UNIT_GATE_TABLE, [
      '  unit text PRIMARY KEY,',
      `  state text NOT NULL DEFAULT 'legacy' CHECK (state IN (${sqlList(GATE_STATES)})),`,
      '  holder_id text,',
      `  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN (${sqlList(GATE_PHASES)})),`,
      '  updated_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),',
      "  CHECK ((state = 'closed') = (holder_id IS NOT NULL))",
    ]),
  );
}

/** Returns the DDL and units index of the non-tenant `<schema>.open_operation`. */
export function openOperationSql(schema: string): string {
  return statements([
    ...createTable(schema, OPEN_OPERATION_TABLE, [
      '  operation_id text PRIMARY KEY,',
      '  kind text NOT NULL,',
      '  units text[] NOT NULL,',
      '  started_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)',
    ]),
    `CREATE INDEX open_operation_units_idx ON ${identifier(schema, 'schema')}.${OPEN_OPERATION_TABLE} USING gin (units);`,
  ]);
}

/** Returns the DDL and RLS of the tenant-owned `<schema>.migration_batch`. */
export function migrationBatchSql(schema: string): string {
  return statements([
    ...createTable(schema, MIGRATION_BATCH_TABLE, [
      '  tenant_id uuid NOT NULL,',
      '  batch_id text NOT NULL,',
      '  legacy_table text NOT NULL,',
      `  origin text NOT NULL CHECK (origin IN (${sqlList(BATCH_ORIGINS)})),`,
      '  row_count integer NOT NULL,',
      '  applied_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),',
      '  PRIMARY KEY (tenant_id, batch_id)',
    ]),
    rlsSql(schema, MIGRATION_BATCH_TABLE),
  ]);
}

/** Returns the DDL of the non-tenant `<schema>.migration_watermark`; `backup_lsn` holds SQL Server's backup checkpoint LSN. */
export function migrationWatermarkSql(schema: string): string {
  return statements(
    createTable(schema, MIGRATION_WATERMARK_TABLE, [
      '  legacy_table text NOT NULL,',
      `  direction text NOT NULL CHECK (direction IN (${sqlList(WATERMARK_DIRECTIONS)})),`,
      '  snapshot_seq bigint,',
      '  backup_lsn numeric(25,0),',
      '  finished_at timestamp(3) without time zone NOT NULL,',
      '  PRIMARY KEY (legacy_table, direction)',
    ]),
  );
}

/** Returns every migration-kit table of `<schema>`, separated by blank lines. */
export function migrationKitSql(schema: string): string {
  return [changelogSql, unitGateSql, openOperationSql, migrationBatchSql, migrationWatermarkSql]
    .map((generate) => generate(schema))
    .join('\n');
}
