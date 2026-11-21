/** Stub table definitions against `0001_stub.sql` and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, createRepository, type MigrationHandlerOptions } from '@opt2/platform/migration-kit';
import { NOTE_PROJECTION_TABLE, NOTE_TABLE, STUB_TABLES, STUB_UNITS } from '../../src/repo/tables.js';

interface DdlTable {
  columns: { name: string; type: string }[];
  primaryKey: string[];
}

const SQL = readFileSync(new URL('../../db/migrations/0001_stub.sql', import.meta.url), 'utf8');
const CREATE_TABLE = /^CREATE TABLE stub\.(\w+) \(\n([\s\S]*?)\n\);/gm;
const COLUMN = /^"?([a-z_]+)"? (.+?)(?= NOT NULL| NULL| DEFAULT | PRIMARY KEY| UNIQUE| CHECK | GENERATED |$)/;
const SEEDED_GATE = /\('stub' \|\| '(\.\w+)', 'open', NULL, 'quiet'\)/g;

/** Every `CREATE TABLE stub.*` of the migration, keyed by table, with its columns in catalog order and its primary key. */
function migrationTables(): Map<string, DdlTable> {
  const tables = new Map<string, DdlTable>();
  for (const [, table, body] of SQL.matchAll(CREATE_TABLE)) {
    const lines = (body as string).split('\n').map((line) => line.trim().replace(/,$/, ''));
    const columns = lines.flatMap((line) => {
      const m = COLUMN.exec(line);
      return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
    });
    const primaryKey = /^PRIMARY KEY \(([^)]+)\)$/.exec(lines.find((line) => line.startsWith('PRIMARY KEY')) ?? '')?.[1];
    tables.set(table as string, {
      columns,
      primaryKey: primaryKey === undefined ? [] : primaryKey.split(',').map((column) => column.trim()),
    });
  }
  return tables;
}

const DDL = migrationTables();

describe.each(STUB_TABLES.map((definition) => [definition.table, definition] as const))('stub.%s', (table, definition) => {
  it('lists the migration columns in catalog order with their canonical tags', () => {
    expect(DDL.get(table)?.columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type }))).toEqual(
      definition.columns.map(({ name, type }) => ({ name, type })),
    );
  });

  it('keys on the migration primary key without tenant_id', () => {
    expect(DDL.get(table)?.primaryKey).toEqual(['tenant_id', ...(definition.key ?? [])]);
  });
});

describe('stub units', () => {
  it('are the gate ids the migration seeds, in table order', () => {
    const seeded = [...SQL.matchAll(SEEDED_GATE)].map((m) => `stub${m[1] as string}`);
    expect(seeded).toEqual([...STUB_UNITS]);
    expect(STUB_TABLES.map((definition) => definition.unit)).toEqual([...STUB_UNITS]);
    expect(STUB_TABLES).toEqual([NOTE_TABLE, NOTE_PROJECTION_TABLE]);
  });

  it('build a platform repository and migration handler units', () => {
    const repository = createRepository({ owner: 'stub', schema: 'stub', tables: STUB_TABLES });
    const options: Pick<MigrationHandlerOptions, 'units'> = { units: STUB_UNITS };
    expect(repository.units()).toEqual(options.units);
    expect(STUB_TABLES.map((definition) => repository.definition(definition.table))).toEqual([...STUB_TABLES]);
  });
});
