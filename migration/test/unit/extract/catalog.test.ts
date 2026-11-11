// Unit tests for the SQL Server catalog reader, using a fake pool that answers each catalog query from a script.
import type { Request } from 'mssql';
import { CanonicalEncodingError } from '@opt2/platform/migration-kit';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CatalogError,
  OPT2_SYNC_SCHEMA,
  PROGRAM_SCHEMA_PATTERN,
  TableNotFoundError,
  UnsupportedColumnTypeError,
  clearCatalogCache,
  findColumn,
  isLegacySchema,
  listLegacyTables,
  parseQualifiedName,
  qualifiedName,
  readTableCatalog,
  type CatalogPool,
  type TableCatalog,
} from '../../../src/extract/catalog.js';

type Row = Record<string, unknown>;

interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
}

interface TableSpec {
  columns: readonly ColumnSpec[];
  primaryKey?: readonly string[];
  identity?: readonly string[];
}

interface QueryCall {
  sql: string;
  inputs: Record<string, { type: unknown; value: unknown }>;
}

/** Mutable script the fake pool answers from; `fail` makes the next query of a kind reject once. */
interface Script {
  updateability: string;
  fingerprint: Row;
  databaseName: string | null;
  tables: Record<string, TableSpec>;
  liveTables: readonly { schema_name: string; table_name: string }[];
  fail?: QueryKind;
}

type QueryKind = 'catalog' | 'updateability' | 'fingerprint' | 'list' | 'name';

function kindOf(text: string): QueryKind {
  if (text.includes('INFORMATION_SCHEMA.COLUMNS')) return 'catalog';
  if (text.includes('DATABASEPROPERTYEX')) return 'updateability';
  if (text.includes('COUNT_BIG')) return 'fingerprint';
  if (text.includes('sys.schemas')) return 'list';
  return 'name';
}

function catalogSets(spec: TableSpec | undefined): Row[][] {
  if (spec === undefined) return [[], [], []];
  const columns = spec.columns.map((column, index) => ({
    COLUMN_NAME: column.name,
    DATA_TYPE: column.type,
    IS_NULLABLE: column.nullable === false ? 'NO' : 'YES',
    CHARACTER_MAXIMUM_LENGTH: column.maxLength ?? null,
    NUMERIC_PRECISION: column.precision ?? null,
    NUMERIC_SCALE: column.scale ?? null,
    ORDINAL_POSITION: index + 1,
  }));
  return [columns, (spec.primaryKey ?? []).map((name) => ({ name })), (spec.identity ?? []).map((name) => ({ name }))];
}

/** `database` null leaves the pool config without a database name. */
function fakePool(script: Script, database: string | null = 'muradb_test') {
  const calls: QueryCall[] = [];
  const pool = {
    ...(database === null ? {} : { config: { database } }),
    request() {
      const inputs: QueryCall['inputs'] = {};
      const request = {
        input(name: string, type: unknown, value: unknown) {
          inputs[name] = { type, value };
          return request;
        },
        async query(text: string) {
          calls.push({ sql: text, inputs: { ...inputs } });
          const kind = kindOf(text);
          if (script.fail === kind) {
            delete script.fail;
            throw new Error(`scripted ${kind} failure`);
          }
          const sets: Row[][] =
            kind === 'catalog'
              ? catalogSets(script.tables[`${String(inputs.schema?.value)}.${String(inputs.table?.value)}`.toLowerCase()])
              : kind === 'updateability'
                ? [[{ updateability: script.updateability }]]
                : kind === 'fingerprint'
                  ? [[script.fingerprint]]
                  : kind === 'list'
                    ? [[...script.liveTables]]
                    : [[{ name: script.databaseName }]];
          return { recordsets: sets, recordset: sets[0] ?? [], rowsAffected: [], output: {} };
        },
      };
      return request as unknown as Request;
    },
  };
  const count = (kind: QueryKind) => calls.filter((call) => kindOf(call.sql) === kind).length;
  return { pool: pool as CatalogPool, calls, count };
}

const TCONTENT: TableSpec = {
  columns: [
    { name: 'tcontent_ID', type: 'int', nullable: false, precision: 10, scale: 0 },
    { name: 'SiteID', type: 'varchar', maxLength: 25 },
    { name: 'ContentID', type: 'char', maxLength: 35 },
    { name: 'Body', type: 'nvarchar', maxLength: -1 },
    { name: 'Summary', type: 'ntext', maxLength: 1073741823 },
    { name: 'LastUpdate', type: 'datetime' },
    { name: 'Display', type: 'TINYINT', precision: 3, scale: 0 },
    { name: 'mobileExclude', type: 'bit' },
    { name: 'majorVersion', type: 'numeric', precision: 18, scale: 0 },
    { name: 'amount', type: 'decimal', precision: 19, scale: 4 },
    { name: 'price', type: 'money', precision: 19, scale: 4 },
    { name: 'ratio', type: 'float', precision: 53 },
    { name: 'image', type: 'varbinary', maxLength: -1 },
  ],
  primaryKey: ['tcontent_ID'],
  identity: ['tcontent_ID'],
};

function newScript(overrides: Partial<Script> = {}): Script {
  return {
    updateability: 'READ_ONLY',
    fingerprint: { table_count: '72', column_count: '1012', last_modified: new Date('2026-06-30T10:00:00.000Z') },
    databaseName: 'muradb_named',
    tables: {
      'dbo.tcontent': TCONTENT,
      'dbo.tcontentassignments': {
        columns: [
          { name: 'contentID', type: 'char', maxLength: 35 },
          { name: 'contentHistID', type: 'char', maxLength: 35 },
          { name: 'siteID', type: 'varchar', maxLength: 25 },
          { name: 'userID', type: 'char', maxLength: 35 },
          { name: 'type', type: 'varchar', maxLength: 50 },
        ],
        primaryKey: ['contentid', 'contentHistID', 'siteID', 'userID'],
      },
      'dbo.tsettings': { columns: [{ name: 'SiteID', type: 'varchar', maxLength: 25 }] },
      'program_1.timesheet': { columns: [{ name: 'timesheetID', type: 'char', maxLength: 35 }], primaryKey: ['timesheetID'] },
      'synthetic.survey': { columns: [{ name: 'surveyID', type: 'char', maxLength: 35 }], primaryKey: ['surveyID'] },
      'dbo.tvariant': { columns: [{ name: 'id', type: 'int' }, { name: 'payload', type: 'sql_variant' }] },
      'dbo.tbroken': { columns: [{ name: 'id', type: 'int' }], primaryKey: ['missing'] },
    },
    liveTables: [
      { schema_name: 'dbo', table_name: 'tusers' },
      { schema_name: 'Program_2', table_name: 'timesheet' },
      { schema_name: OPT2_SYNC_SCHEMA, table_name: 'projector_checkpoint' },
      { schema_name: 'synthetic', table_name: 'survey' },
      { schema_name: 'guest', table_name: 'x' },
      { schema_name: 'dbo', table_name: 'tcontent' },
      { schema_name: 'Program_1', table_name: 'timesheet' },
      { schema_name: 'dbo', table_name: 'fb_contactus' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  clearCatalogCache();
});

describe('table names', () => {
  it.each([
    ['dbo', 'tcontent', 'tcontent'],
    ['DBO', 'tusers', 'tusers'],
    ['synthetic', 'person_archive', 'synthetic.person_archive'],
    ['Program_1', 'timesheet', 'Program_1.timesheet'],
  ])('qualifies %s.%s as %s', (schema, table, expected) => {
    expect(qualifiedName(schema, table)).toBe(expected);
  });

  it.each([
    ['tcontent', { schema: 'dbo', table: 'tcontent' }],
    ['dbo.tcontent', { schema: 'dbo', table: 'tcontent' }],
    ['[Program_1].[timesheet]', { schema: 'Program_1', table: 'timesheet' }],
    ['[tusers]', { schema: 'dbo', table: 'tusers' }],
    ['synthetic.survey.extra', { schema: 'synthetic', table: 'survey.extra' }],
  ])('parses %s', (name, expected) => {
    expect(parseQualifiedName(name)).toEqual(expected);
  });

  it.each([
    ['dbo', true],
    ['Synthetic', true],
    ['Program_1', true],
    ['program_12', true],
    [OPT2_SYNC_SCHEMA, false],
    ['guest', false],
    ['Program_', false],
    ['Program_1x', false],
  ])('classifies schema %s as legacy=%s', (schema, expected) => {
    expect(isLegacySchema(schema)).toBe(expected);
  });

  it('captures the program id of a per-program schema', () => {
    expect(PROGRAM_SCHEMA_PATTERN.exec('Program_2')?.[1]).toBe('2');
  });
});

describe('readTableCatalog', () => {
  it('reads columns in catalog order with canonical types through one parameterised batch', async () => {
    const { pool, calls } = fakePool(newScript());
    const catalog = await readTableCatalog(pool, 'tcontent');

    const batch = calls.find((call) => kindOf(call.sql) === 'catalog');
    expect(batch?.sql).toContain('ORDER BY ORDINAL_POSITION');
    expect(batch?.sql).toContain("OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table))");
    expect(batch?.sql).toContain('ORDER BY ic.key_ordinal');
    expect(batch?.sql).not.toContain('tcontent');
    expect(batch?.inputs.schema?.value).toBe('dbo');
    expect(batch?.inputs.table?.value).toBe('tcontent');

    expect(catalog.columns.map((column) => column.name)).toEqual(TCONTENT.columns.map((column) => column.name));
    expect(catalog.columns.map((column) => column.ordinal)).toEqual(TCONTENT.columns.map((_, index) => index + 1));
    expect(catalog.columns.map((column) => [column.sqlType, column.type, column.scale])).toEqual([
      ['int', 'i', undefined],
      ['varchar', 's', undefined],
      ['char', 's', undefined],
      ['nvarchar', 's', undefined],
      ['ntext', 's', undefined],
      ['datetime', 't', undefined],
      ['tinyint', 'i', undefined],
      ['bit', 'i', undefined],
      ['numeric', 'd', 0],
      ['decimal', 'd', 4],
      ['money', 'd', 4],
      ['float', 'f', undefined],
      ['varbinary', 'b', undefined],
    ]);
    expect(findColumn(catalog, 'Body')).toMatchObject({ maxLength: -1, nullable: true, precision: null, numericScale: null });
    expect(findColumn(catalog, 'tcontent_ID')).toMatchObject({ nullable: false, precision: 10, numericScale: 0 });
    expect('scale' in (findColumn(catalog, 'tcontent_ID') ?? {})).toBe(false);
    expect(catalog).toMatchObject({
      database: 'muradb_test',
      schema: 'dbo',
      table: 'tcontent',
      qualified: 'tcontent',
      primaryKey: ['tcontent_ID'],
      identityColumns: ['tcontent_ID'],
      hasPrimaryKey: true,
    });
  });

  it('freezes the catalog, its lists and its columns', async () => {
    const { pool } = fakePool(newScript());
    const catalog = await readTableCatalog(pool, 'tcontent');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.columns)).toBe(true);
    expect(Object.isFrozen(catalog.primaryKey)).toBe(true);
    expect(Object.isFrozen(catalog.identityColumns)).toBe(true);
    expect(catalog.columns.every((column) => Object.isFrozen(column))).toBe(true);
  });

  it('keeps composite key order and resolves key names to the catalog spelling', async () => {
    const { pool } = fakePool(newScript());
    const catalog = await readTableCatalog(pool, 'dbo.tcontentassignments');
    expect(catalog.primaryKey).toEqual(['contentID', 'contentHistID', 'siteID', 'userID']);
    expect(catalog.identityColumns).toEqual([]);
    expect(catalog.hasPrimaryKey).toBe(true);
  });

  it('reports a table without primary key rows as keyless', async () => {
    const { pool } = fakePool(newScript());
    const catalog = await readTableCatalog(pool, 'tsettings');
    expect(catalog.primaryKey).toEqual([]);
    expect(catalog.hasPrimaryKey).toBe(false);
  });

  it.each([
    [{ schema: 'Program_1', table: 'timesheet', qualified: 'ignored' }, 'Program_1', 'timesheet', 'Program_1.timesheet'],
    ['[synthetic].[survey]', 'synthetic', 'survey', 'synthetic.survey'],
  ])('binds schema and table of %j', async (table, schema, name, qualified) => {
    const { pool, calls } = fakePool(newScript());
    const catalog = await readTableCatalog(pool, table);
    const batch = calls.find((call) => kindOf(call.sql) === 'catalog');
    expect(batch?.inputs.schema?.value).toBe(schema);
    expect(batch?.inputs.table?.value).toBe(name);
    expect(catalog).toMatchObject({ schema, table: name, qualified });
  });

  it('raises TableNotFoundError when the catalog has no columns', async () => {
    const { pool } = fakePool(newScript());
    const error = await readTableCatalog(pool, 'tmissing').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TableNotFoundError);
    expect(error).toBeInstanceOf(CatalogError);
    expect(error).toMatchObject({ database: 'muradb_test', table: 'tmissing', name: 'TableNotFoundError' });
  });

  it('raises UnsupportedColumnTypeError wrapping the migration-kit error', async () => {
    const { pool } = fakePool(newScript());
    const error = await readTableCatalog(pool, 'tvariant').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedColumnTypeError);
    expect(error).toMatchObject({ database: 'muradb_test', table: 'tvariant', column: 'payload', sqlType: 'sql_variant' });
    expect((error as Error).cause).toBeInstanceOf(CanonicalEncodingError);
  });

  it('rejects key names that are not columns of the table', async () => {
    const { pool } = fakePool(newScript());
    await expect(readTableCatalog(pool, 'tbroken')).rejects.toThrow(CatalogError);
  });
});

describe('listLegacyTables', () => {
  it('lists only legacy schemas, sorted by qualified name in code-unit order', async () => {
    const { pool, calls } = fakePool(newScript());
    const tables = await listLegacyTables(pool);
    expect(tables.map((ref) => ref.qualified)).toEqual([
      'Program_1.timesheet',
      'Program_2.timesheet',
      'fb_contactus',
      'synthetic.survey',
      'tcontent',
      'tusers',
    ]);
    expect(tables.find((ref) => ref.qualified === 'tcontent')).toEqual({ schema: 'dbo', table: 'tcontent', qualified: 'tcontent' });
    expect(Object.isFrozen(tables)).toBe(true);
    expect(tables.every((ref) => Object.isFrozen(ref))).toBe(true);
    expect(calls.find((call) => kindOf(call.sql) === 'list')?.sql).toContain('t.is_ms_shipped = 0');
  });
});

describe('memoisation', () => {
  it('serves a READ_ONLY database from memory without further queries', async () => {
    const { pool, count } = fakePool(newScript());
    const first = await readTableCatalog(pool, 'tcontent');
    const again = await readTableCatalog(pool, 'DBO.TCONTENT');
    await listLegacyTables(pool);
    await listLegacyTables(pool);
    expect(again).toBe(first);
    expect([count('catalog'), count('list'), count('updateability'), count('fingerprint'), count('name')]).toEqual([1, 1, 1, 0, 0]);
  });

  it('re-reads a READ_WRITE database only after its fingerprint changes', async () => {
    const script = newScript({ updateability: 'READ_WRITE' });
    const { pool, count } = fakePool(script);
    const first = await readTableCatalog(pool, 'tcontent');
    await listLegacyTables(pool);
    expect(await readTableCatalog(pool, 'tcontent')).toBe(first);
    await listLegacyTables(pool);
    expect([count('catalog'), count('list'), count('fingerprint')]).toEqual([1, 1, 4]);

    script.fingerprint = { ...script.fingerprint, column_count: '1013', last_modified: new Date('2026-06-30T11:00:00.000Z') };
    const reread = await readTableCatalog(pool, 'tcontent');
    await listLegacyTables(pool);
    expect(reread).not.toBe(first);
    expect(reread).toEqual(first);
    expect([count('catalog'), count('list'), count('updateability')]).toEqual([2, 2, 1]);
  });

  it('forces a re-read after clearCatalogCache for that database or for all', async () => {
    const { pool, count } = fakePool(newScript());
    await readTableCatalog(pool, 'tcontent');
    clearCatalogCache('other_db');
    await readTableCatalog(pool, 'tcontent');
    expect(count('catalog')).toBe(1);

    clearCatalogCache('MURADB_TEST');
    await readTableCatalog(pool, 'tcontent');
    expect([count('catalog'), count('updateability')]).toEqual([2, 2]);

    clearCatalogCache();
    await readTableCatalog(pool, 'tcontent');
    expect(count('catalog')).toBe(3);
  });

  it('resolves the database through DB_NAME() once per pool when the pool config names none', async () => {
    const { pool, count } = fakePool(newScript(), null);
    const catalog = await readTableCatalog(pool, 'tcontent');
    await listLegacyTables(pool);
    expect(catalog.database).toBe('muradb_named');
    expect(count('name')).toBe(1);
  });

  it.each(['catalog', 'updateability', 'fingerprint', 'list', 'name'] as const)(
    'does not keep a rejected %s query',
    async (kind) => {
      const script = newScript({ updateability: 'READ_WRITE', fail: kind });
      const { pool } = fakePool(script, kind === 'name' ? null : 'muradb_test');
      const read = kind === 'list' ? () => listLegacyTables(pool) : () => readTableCatalog(pool, 'tcontent');
      await expect(read()).rejects.toThrow(`scripted ${kind} failure`);
      await expect(read()).resolves.toBeDefined();
    },
  );

  it('fails when DB_NAME() returns no name', async () => {
    const { pool, count } = fakePool(newScript({ databaseName: null }), null);
    await expect(readTableCatalog(pool, 'tcontent')).rejects.toThrow('DB_NAME() returned no database');
    await expect(listLegacyTables(pool)).rejects.toThrow('DB_NAME() returned no database');
    expect(count('name')).toBe(2);
  });
});

describe('findColumn', () => {
  const columns = [
    { name: 'siteID', type: 's', sqlType: 'varchar', nullable: true, maxLength: 25, precision: null, numericScale: null, ordinal: 1 },
    { name: 'SiteID', type: 's', sqlType: 'varchar', nullable: true, maxLength: 25, precision: null, numericScale: null, ordinal: 2 },
  ] as const;
  const catalog = { columns } as unknown as TableCatalog;

  it.each([
    ['SiteID', 2],
    ['siteID', 1],
    ['SITEID', 1],
  ])('finds %s on a catalog and on a column list', (name, ordinal) => {
    expect(findColumn(catalog, name)?.ordinal).toBe(ordinal);
    expect(findColumn(columns, name)?.ordinal).toBe(ordinal);
  });

  it('returns undefined for an unknown column', () => {
    expect(findColumn(catalog, 'userid')).toBeUndefined();
  });
});
