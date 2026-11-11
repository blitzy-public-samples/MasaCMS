// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature table definitions against the target DDL, the fixture DDL and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository } from '@opt2/platform/migration-kit';
import { AUDIT_ENTRY, OWNED_TABLES, OWNER, REQUEST_STATES, SCHEMA, SIGNATURE, SIGNATURE_REQUEST, UNITS } from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const TARGET_DDL = read('../../db/migrations/0001_esignature.sql');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/esignature/100_tables.sql');
const TARGET_ONLY = new Set(['tenant_id', 'row_version']);

/** Body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns and primary key of `esignature.<table>` in `0001_esignature.sql`. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE esignature.${table} (`, '\n);');
  const columns = body.flatMap((line) => {
    const m = /^([a-z_0-9]+) (.+?)(?: NOT NULL| NULL)?(?: DEFAULT .+?)?,?$/.exec(line);
    return m === null || line.startsWith('CONSTRAINT ') ? [] : [{ name: m[1] as string, type: m[2] as string }];
  });
  const primaryKey = /PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.includes('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (primaryKey?.[1] ?? '').split(',').map((column) => column.trim()) };
}

/** Columns (names lower-cased) and primary key of `[synthetic].[<table>]` in `100_tables.sql`. */
function fixtureTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(FIXTURE_DDL, `CREATE TABLE [synthetic].[${table}] (`, '\n) ON');
  const columns = body.flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\]/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[2] as string }];
  });
  const primaryKey = /PRIMARY KEY CLUSTERED \(([^)]+)\)/.exec(body.find((line) => line.includes('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (primaryKey?.[1] ?? '').split(',').map((column) => column.trim().replace(/^\[|\]$/g, '').toLowerCase()) };
}

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('esignature.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    expect(definition.columns.map(({ name, type }) => ({ name, type }))).toEqual(
      targetTable(table).columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type })),
    );
  });

  it('carries exactly the fixture columns besides tenant_id and row_version', () => {
    expect(definition.columns.filter((column) => !TARGET_ONLY.has(column.name)).map(({ name, type }) => ({ name, type }))).toEqual(
      fixtureTable(table).columns.map((column) => ({ name: column.name, type: canonicalTypeForSqlServer(column.type).type })),
    );
  });

  it('keys on the target and fixture primary key', () => {
    expect(targetTable(table).primaryKey).toEqual(definition.key);
    expect(fixtureTable(table).primaryKey).toEqual(definition.key);
  });

  it('is gated by its own e-signature unit and cannot be changed by a consumer', () => {
    expect(definition.unit).toBe(`esignature.${table}`);
    expect(Object.isFrozen(definition) && Object.isFrozen(definition.columns) && Object.isFrozen(definition.key)).toBe(true);
    expect(definition.columns.every((column) => Object.isFrozen(column))).toBe(true);
  });
});

describe('e-signature tables', () => {
  it('declares one table per unit, parent request first, which the platform repository accepts', () => {
    const repository = createRepository({ owner: OWNER, schema: SCHEMA, tables: OWNED_TABLES });
    expect([OWNER, SCHEMA]).toEqual(['e-signature', 'esignature']);
    expect(OWNED_TABLES).toEqual([SIGNATURE_REQUEST, SIGNATURE, AUDIT_ENTRY]);
    expect(OWNED_TABLES.map((definition) => definition.unit)).toEqual([...UNITS]);
    expect(repository.units()).toEqual([...UNITS]);
    expect(repository.definition('audit_entry')).toEqual(AUDIT_ENTRY);
  });

  it('starts the request state domain with the fixture default and matches the target check', () => {
    expect(/DEFAULT \(N'(\w+)'\)/.exec(FIXTURE_DDL)?.[1]).toBe(REQUEST_STATES[0]);
    expect(/ck_signature_request_state CHECK \(state IN \(([^)]+)\)\)/.exec(TARGET_DDL)?.[1]?.split(',').map((state) => state.replace(/'/g, ''))).toEqual([
      ...REQUEST_STATES,
    ]);
  });
});
