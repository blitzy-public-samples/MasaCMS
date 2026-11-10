import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_TABLE,
  CHANGE_OPS,
  CHANGE_ORIGINS,
  GATE_PHASES,
  GATE_STATES,
  MIGRATION_BATCH_TABLE,
  MIGRATION_WATERMARK_TABLE,
  OPEN_OPERATION_TABLE,
  PLATFORM_INFRA_TABLES,
  UNIT_GATE_TABLE,
  WATERMARK_DIRECTIONS,
  changelogSql,
  isPlatformInfraTable,
  migrationBatchSql,
  migrationKitSql,
  migrationWatermarkSql,
  openOperationSql,
  qualified,
  unitGateSql,
} from '../../src/migration-kit/ddl.js';
import { rlsSql } from '../../src/tenancy/rls.js';

const NO_RLS = /POLICY|ROW LEVEL SECURITY/i;
const TIMESTAMP = 'timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)';

const INVALID_IDENTIFIERS: readonly (readonly [string, string])[] = [
  ['upper-case letters', 'People'],
  ['a double quote', 'people"'],
  ['a statement separator', 'people; DROP TABLE people.person; --'],
  ['a schema-qualified name', 'people.person'],
  ['whitespace', 'people person'],
  ['a hyphen', 'programs-sites'],
  ['a leading digit', '1people'],
  ['an empty string', ''],
  ['a non-string value', 42 as unknown as string],
];

const GENERATORS: readonly (readonly [string, (schema: string) => string])[] = [
  ['changelogSql', changelogSql],
  ['unitGateSql', unitGateSql],
  ['openOperationSql', openOperationSql],
  ['migrationBatchSql', migrationBatchSql],
  ['migrationWatermarkSql', migrationWatermarkSql],
  ['migrationKitSql', migrationKitSql],
];

function lines(sql: string): string[] {
  return sql.split('\n');
}

describe('migration-kit table names and value sets', () => {
  it('names the five migration-kit tables', () => {
    expect([CHANGELOG_TABLE, UNIT_GATE_TABLE, OPEN_OPERATION_TABLE, MIGRATION_BATCH_TABLE, MIGRATION_WATERMARK_TABLE]).toEqual([
      'changelog',
      'unit_gate',
      'open_operation',
      'migration_batch',
      'migration_watermark',
    ]);
  });

  it.each<readonly [string, readonly string[], readonly string[]]>([
    ['CHANGE_OPS', CHANGE_OPS, ['insert', 'update', 'delete']],
    ['CHANGE_ORIGINS', CHANGE_ORIGINS, ['target', 'legacy-window', 'migration-feed', 'backfill']],
    ['GATE_STATES', GATE_STATES, ['legacy', 'open', 'closed']],
    ['GATE_PHASES', GATE_PHASES, ['quiet', 'executing', 'importing', 'import-pending']],
    ['WATERMARK_DIRECTIONS', WATERMARK_DIRECTIONS, ['forward', 'reverse']],
  ])('lists %s in order', (_name, values, expected) => {
    expect(values).toEqual(expected);
  });
});

describe('isPlatformInfraTable', () => {
  it('lists the platform-written service tables in a frozen array', () => {
    expect(Object.isFrozen(PLATFORM_INFRA_TABLES)).toBe(true);
    expect(PLATFORM_INFRA_TABLES).toEqual([
      'outbox',
      'inbox',
      'consumer_aggregate_version',
      'changelog',
      'scheduled_task_queue',
      'scheduled_task_queue_state',
      'migration_batch',
      'migration_watermark',
      'unit_gate',
      'open_operation',
      'tenant_registry',
      'tenant_grant',
    ]);
  });

  it.each(PLATFORM_INFRA_TABLES)('accepts %s', (table) => {
    expect(isPlatformInfraTable(table)).toBe(true);
  });

  it.each(['person', 'Outbox', 'people.outbox', ''])('rejects %j', (table) => {
    expect(isPlatformInfraTable(table)).toBe(false);
  });
});

describe('qualified', () => {
  it('double-quotes the schema and the table', () => {
    expect(qualified('people', 'person')).toBe('"people"."person"');
    expect(qualified('programs_sites', '_site2')).toBe('"programs_sites"."_site2"');
  });

  it.each(INVALID_IDENTIFIERS)('throws a TypeError for a schema with %s', (_case, name) => {
    expect(() => qualified(name, 'person')).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(name)}`));
  });

  it.each(INVALID_IDENTIFIERS)('throws a TypeError for a table with %s', (_case, name) => {
    expect(() => qualified('people', name)).toThrow(new TypeError(`Invalid table identifier: ${JSON.stringify(name)}`));
  });
});

describe('changelogSql', () => {
  const sql = changelogSql('people');

  it('creates the tenant-owned changelog keyed by tenant and sequence', () => {
    expect(lines(sql).slice(0, 4)).toEqual([
      'CREATE TABLE people.changelog (',
      '  tenant_id uuid NOT NULL,',
      '  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),',
      '  seq bigserial NOT NULL,',
    ]);
    expect(lines(sql)).toEqual(
      expect.arrayContaining([
        '  "table" text NOT NULL,',
        "  op text NOT NULL CHECK (op IN ('insert','update','delete')),",
        '  key text NOT NULL,',
        "  columns text[] NOT NULL DEFAULT '{}',",
        "  origin text NOT NULL CHECK (origin IN ('target','legacy-window','migration-feed','backfill')),",
        '  actor_user_id text,',
        '  actor_service text,',
        `  at ${TIMESTAMP},`,
        '  request_id text,',
        '  operation_id text,',
        '  PRIMARY KEY (tenant_id, seq),',
      ]),
    );
  });

  it('requires the before and after images each operation carries', () => {
    expect(sql).toContain(
      [
        "  CHECK ((op = 'insert' AND before IS NULL AND after IS NOT NULL)",
        "      OR (op = 'update' AND before IS NOT NULL AND after IS NOT NULL)",
        "      OR (op = 'delete' AND before IS NOT NULL AND after IS NULL))",
        ');',
      ].join('\n'),
    );
  });

  it('indexes the commit-safe cursor and open operations', () => {
    expect(lines(sql)).toEqual(
      expect.arrayContaining([
        'CREATE INDEX changelog_cursor_idx ON people.changelog (tenant_id, xid, seq);',
        'CREATE INDEX changelog_operation_idx ON people.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;',
      ]),
    );
  });

  it('ends with the tenant RLS of people.changelog and a newline', () => {
    expect(sql.endsWith(`\n${rlsSql('people', 'changelog')}\n`)).toBe(true);
  });
});

describe('unitGateSql', () => {
  it('creates the non-tenant gate with legacy and quiet defaults and a holder exactly while closed', () => {
    expect(unitGateSql('people')).toBe(
      [
        'CREATE TABLE people.unit_gate (',
        '  unit text PRIMARY KEY,',
        "  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),",
        '  holder_id text,',
        "  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),",
        `  updated_at ${TIMESTAMP},`,
        "  CHECK ((state = 'closed') = (holder_id IS NOT NULL))",
        ');',
        '',
      ].join('\n'),
    );
  });
});

describe('openOperationSql', () => {
  it('creates the non-tenant operation registry with a GIN index on its units', () => {
    expect(openOperationSql('people')).toBe(
      [
        'CREATE TABLE people.open_operation (',
        '  operation_id text PRIMARY KEY,',
        '  kind text NOT NULL,',
        '  units text[] NOT NULL,',
        `  started_at ${TIMESTAMP}`,
        ');',
        'CREATE INDEX open_operation_units_idx ON people.open_operation USING gin (units);',
        '',
      ].join('\n'),
    );
  });
});

describe('migrationBatchSql', () => {
  const sql = migrationBatchSql('people');

  it('creates the tenant-owned batch record keyed by tenant and batch, for migration origins only', () => {
    expect(lines(sql).slice(0, 9)).toEqual([
      'CREATE TABLE people.migration_batch (',
      '  tenant_id uuid NOT NULL,',
      '  batch_id text NOT NULL,',
      '  legacy_table text NOT NULL,',
      "  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),",
      '  row_count integer NOT NULL,',
      `  applied_at ${TIMESTAMP},`,
      '  PRIMARY KEY (tenant_id, batch_id)',
      ');',
    ]);
  });

  it('ends with the tenant RLS of people.migration_batch and a newline', () => {
    expect(sql).toBe(`${lines(sql).slice(0, 9).join('\n')}\n${rlsSql('people', 'migration_batch')}\n`);
  });
});

describe('migrationWatermarkSql', () => {
  it('creates the non-tenant watermark keyed by legacy table and direction', () => {
    expect(migrationWatermarkSql('people')).toBe(
      [
        'CREATE TABLE people.migration_watermark (',
        '  legacy_table text NOT NULL,',
        "  direction text NOT NULL CHECK (direction IN ('forward','reverse')),",
        '  snapshot_seq bigint,',
        '  backup_lsn numeric(25,0),',
        '  finished_at timestamp(3) without time zone NOT NULL,',
        '  PRIMARY KEY (legacy_table, direction)',
        ');',
        '',
      ].join('\n'),
    );
  });
});

describe.each([
  ['unitGateSql', unitGateSql],
  ['openOperationSql', openOperationSql],
  ['migrationWatermarkSql', migrationWatermarkSql],
] as const)('%s tenancy', (_name, generate) => {
  it('declares no tenant column and no RLS', () => {
    expect(generate('people')).not.toContain('tenant_id');
    expect(generate('people')).not.toMatch(NO_RLS);
  });
});

describe('migrationKitSql', () => {
  const sql = migrationKitSql('people');

  it('joins the five tables in order, separated by blank lines', () => {
    expect(sql).toBe(
      [changelogSql, unitGateSql, openOperationSql, migrationBatchSql, migrationWatermarkSql]
        .map((generate) => generate('people'))
        .join('\n'),
    );
    expect(sql.split('\n\n')).toHaveLength(5);
    expect([...sql.matchAll(/^CREATE TABLE (\S+) \($/gm)].map((match) => match[1])).toEqual([
      'people.changelog',
      'people.unit_gate',
      'people.open_operation',
      'people.migration_batch',
      'people.migration_watermark',
    ]);
  });

  it('applies tenant RLS to changelog and migration_batch only', () => {
    expect(sql).toContain(rlsSql('people', 'changelog'));
    expect(sql).toContain(rlsSql('people', 'migration_batch'));
    expect([...sql.matchAll(/^CREATE POLICY \S+ ON (\S+)$/gm)].map((match) => match[1])).toEqual([
      'people.changelog',
      'people.migration_batch',
    ]);
  });

  it('uses the given schema throughout', () => {
    const other = migrationKitSql('programs_sites');
    expect(other).toBe(sql.replaceAll('people.', 'programs_sites.'));
    expect(other).not.toContain('people');
  });
});

describe.each(GENERATORS)('%s schema identifier', (_name, generate) => {
  it.each(INVALID_IDENTIFIERS)('throws a TypeError for %s', (_case, name) => {
    expect(() => generate(name)).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(name)}`));
  });
});
