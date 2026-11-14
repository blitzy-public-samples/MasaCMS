// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Surveys table definitions against the target DDL, the fixture DDL, table ownership and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository } from '@opt2/platform/migration-kit';
import {
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RC_SET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  OWNED_TABLES,
  SURVEY,
  SURVEY_RESPONSE,
  SURVEY_STATUSES,
  TARGET_ONLY_COLUMNS,
  TRASH,
  UNITS,
  type SurveyTableDefinition,
} from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
}

interface Ownership {
  units: { unit: string; owner: string; schema: string; table: string; legacyTables: string[]; tenantOwned: boolean }[];
  tables: { table: string; targets?: { unit: string; owner: string; keyColumns: string[]; ownedColumns: string[] }[] }[];
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const FIXTURE_MIGRATION = '0002_surveys.sql';
const SHARE_MIGRATION = '0003_extensions.sql';
const MIGRATION_DDL: ReadonlyMap<string, string> = new Map(
  [FIXTURE_MIGRATION, SHARE_MIGRATION].map((file) => [file, read(`../../db/migrations/${file}`)]),
);
const TARGET_DDL = [...MIGRATION_DDL.values()].join('\n');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/surveys/100_tables.sql');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;
/** The surveys shares of Masa tables; every other owned table copies a `synthetic.survey*` fixture table. */
const SHARE_TABLES: readonly SurveyTableDefinition[] = [EXTEND_SUBTYPE, EXTEND_SET, EXTEND_ATTRIBUTE, EXTEND_RC_SET, EXTEND_DATA, TRASH];
const FIXTURE_TABLES = OWNED_TABLES.filter((definition) => !SHARE_TABLES.includes(definition));

/** Body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns and primary key of `surveys.<table>` in the surveys migrations. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE surveys.${table} (`, '\n);');
  const columns = body.flatMap((line) => {
    const m = /^([a-z_]+) (.+?) (?:NOT NULL|NULL)\b/.exec(line);
    return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
  });
  const primaryKey = /^PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.startsWith('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (primaryKey?.[1] ?? '').split(',').map((column) => column.trim()) };
}

/** Columns of `[synthetic].[<table>]` in `100_tables.sql`, names lower-cased. */
function fixtureTable(table: string): DdlColumn[] {
  return tableBody(FIXTURE_DDL, `CREATE TABLE [synthetic].[${table}] (`, '\n) ON').flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\]/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[2] as string }];
  });
}

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('surveys.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    const { columns } = targetTable(table);
    expect(definition.columns.map(({ name, type }) => ({ name, type }))).toEqual(
      columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type })),
    );
  });

  it('keys on the target primary key without tenant_id', () => {
    expect(targetTable(table).primaryKey).toEqual(['tenant_id', ...definition.key]);
  });

  it('is gated by its own surveys unit', () => {
    expect(definition.unit).toBe(`surveys.${table}`);
  });
});

describe.each(FIXTURE_TABLES.map((definition) => [definition.table, definition] as const))('fixture table surveys.%s', (table, definition) => {
  it('carries exactly the fixture columns besides tenant_id and its target-only columns', () => {
    const local = new Set(['tenant_id', ...(TARGET_ONLY_COLUMNS[table] ?? [])]);
    expect(definition.columns.filter((column) => !local.has(column.name)).map(({ name, type }) => ({ name, type }))).toEqual(
      fixtureTable(table).map((column) => ({ name: column.name, type: canonicalTypeForSqlServer(column.type).type })),
    );
  });
});

describe.each(SHARE_TABLES.map((definition) => [definition.table, definition] as const))('share table surveys.%s', (table, definition) => {
  it('holds exactly the owned legacy columns of its table ownership target, lower-cased, keyed on its key columns', () => {
    const targets = OWNERSHIP.tables.flatMap((entry) => (entry.targets ?? []).filter((target) => target.unit === definition.unit));
    const [target] = targets;

    expect(targets).toHaveLength(1);
    expect(target?.owner).toBe('surveys');
    expect(definition.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name)).toEqual(
      target?.ownedColumns.map((column) => column.toLowerCase()),
    );
    expect(definition.key).toEqual(target?.keyColumns.map((column) => column.toLowerCase()));
    expect(TARGET_ONLY_COLUMNS[table]).toBeUndefined();
  });

  it('is a tenant-owned surveys unit of table ownership', () => {
    expect(OWNERSHIP.units.find((unit) => unit.unit === definition.unit)).toMatchObject({ owner: 'surveys', schema: 'surveys', table, tenantOwned: true });
  });
});

describe('surveys tables', () => {
  it('declares one table per unit in UNITS order, which the platform repository accepts', () => {
    const repository = createRepository({ owner: 'surveys', schema: 'surveys', tables: OWNED_TABLES });
    expect(OWNED_TABLES.map((definition) => definition.unit)).toEqual([...UNITS]);
    expect(repository.units()).toEqual([...UNITS]);
    expect(repository.definition('survey')).toEqual(SURVEY);
  });

  it('creates the fixture tables in 0002_surveys.sql and the Masa table shares in 0003_extensions.sql', () => {
    const filesCreating = (table: string): string[] =>
      [...MIGRATION_DDL].filter(([, ddl]) => ddl.includes(`CREATE TABLE surveys.${table} (`)).map(([file]) => file);

    expect(FIXTURE_TABLES.map((definition) => filesCreating(definition.table))).toEqual(FIXTURE_TABLES.map(() => [FIXTURE_MIGRATION]));
    expect(SHARE_TABLES.map((definition) => filesCreating(definition.table))).toEqual(SHARE_TABLES.map(() => [SHARE_MIGRATION]));
    expect(OWNED_TABLES.slice(FIXTURE_TABLES.length)).toEqual(SHARE_TABLES);
  });

  it('keeps row_version of survey_schedule as its only target-only column', () => {
    expect(TARGET_ONLY_COLUMNS).toEqual({ survey_schedule: ['row_version'] });
  });

  it('stores answers as byte-exact text', () => {
    expect(SURVEY_RESPONSE.columns.find((column) => column.name === 'answers')).toEqual({ name: 'answers', type: 's' });
  });

  it('starts the status domain with the fixture default', () => {
    expect(/DEFAULT \(N'(\w+)'\)/.exec(FIXTURE_DDL)?.[1]).toBe(SURVEY_STATUSES[0]);
    expect(SURVEY_STATUSES).toEqual(['DRAFT', 'SCHEDULED', 'LAUNCHED', 'CLOSED']);
  });
});
