// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TABLE_SPECS,
  emptyFixtureTables,
  fixtureKey,
  fixtureKeys,
  specForKey,
  type FixtureModule,
  type FixtureTableSpec,
} from '../../src/fixture-tables.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const DDL_FILES: Readonly<Record<FixtureModule, string>> = {
  people: 'people/100_person_archive.sql',
};

const EXPECTED_KEYS: readonly string[] = ['synthetic.person_archive'];

interface DdlTable {
  schema: string;
  columns: string[];
  primaryKey: string[];
}

/** `CREATE TABLE` blocks of a fixture DDL file by table name, columns in catalog order. */
function parseDdl(sql: string): Map<string, DdlTable> {
  const tables = new Map<string, DdlTable>();
  for (const match of sql.matchAll(/CREATE TABLE \[([^\]]+)\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
    const [, schema = '', table = '', body = ''] = match;
    const columns: string[] = [];
    const primaryKey: string[] = [];
    for (const line of body.split('\n')) {
      const columnName = /^\s*\[([^\]]+)\] \[/.exec(line)?.[1];
      if (columnName !== undefined) {
        columns.push(columnName);
        if (line.includes('PRIMARY KEY')) primaryKey.push(columnName);
      }
      const tableKey = /CONSTRAINT \[PK_[^\]]+\] PRIMARY KEY CLUSTERED \(([^)]+)\)/.exec(line)?.[1];
      if (tableKey !== undefined) primaryKey.push(...tableKey.split(',').map((name) => name.trim().replace(/^\[|\]$/g, '')));
    }
    tables.set(table, { schema, columns, primaryKey });
  }
  return tables;
}

const ddl = new Map<FixtureModule, Map<string, DdlTable>>();

beforeAll(async () => {
  for (const [module, file] of Object.entries(DDL_FILES) as [FixtureModule, string][]) {
    ddl.set(module, parseDdl(await readFile(`${REPO_ROOT}legacy-fixtures/sql/${file}`, 'utf8')));
  }
});

function ddlTable(entry: FixtureTableSpec): DdlTable {
  const table = ddl.get(entry.module)?.get(entry.table);
  if (table === undefined) throw new Error(`${entry.table} is not in ${DDL_FILES[entry.module]}`);
  return table;
}

describe('FIXTURE_TABLE_SPECS', () => {
  it.each(FIXTURE_TABLE_SPECS.map((entry) => [entry.table, entry] as const))('%s matches its DDL', (_table, entry) => {
    const table = ddlTable(entry);
    expect(table.schema).toBe('synthetic');
    expect(table.primaryKey).toEqual([entry.key]);
    expect(table.columns[0]).toBe(entry.key);
    expect(table.columns).toContain(entry.siteColumn);
  });

  it.each(Object.keys(DDL_FILES) as FixtureModule[])('lists every %s DDL table, in DDL order', (module) => {
    const ddlTables = [...(ddl.get(module)?.keys() ?? [])];
    expect(FIXTURE_TABLE_SPECS.filter((entry) => entry.module === module).map((entry) => entry.table)).toEqual(ddlTables);
  });

  it('owns each module by its service folder', () => {
    for (const entry of FIXTURE_TABLE_SPECS) {
      expect(entry.service).toBe(entry.module);
      expect(existsSync(`${REPO_ROOT}services/${entry.service}`)).toBe(true);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FIXTURE_TABLE_SPECS)).toBe(true);
    for (const entry of FIXTURE_TABLE_SPECS) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('fixtureKey', () => {
  it('builds the synthetic key', () => {
    expect(fixtureKey(specForKey('synthetic.person_archive'))).toBe('synthetic.person_archive');
  });
});

describe('fixtureKeys', () => {
  it('lists the dataset keys in registry order', () => {
    expect(fixtureKeys()).toEqual(EXPECTED_KEYS);
  });
});

describe('specForKey', () => {
  it.each(EXPECTED_KEYS.map((key) => [key]))('round-trips %s', (key) => {
    expect(fixtureKey(specForKey(key))).toBe(key);
  });

  it.each([
    'synthetic.survey',
    'Program_1.timesheet',
    'Program_1.person_archive',
    '[synthetic].[person_archive]',
    'Synthetic.person_archive',
    'synthetic.person_archive ',
    'dbo.person_archive',
    'person_archive',
    'synthetic.',
    '',
  ])('rejects %j', (key) => {
    expect(() => specForKey(key)).toThrow(new RangeError(`Unknown fixture table key ${JSON.stringify(key)}`));
  });
});

describe('emptyFixtureTables', () => {
  it('maps every key, in order, to its own empty list', () => {
    const tables = emptyFixtureTables();
    expect(Object.keys(tables)).toEqual(EXPECTED_KEYS);
    const lists = Object.values(tables);
    expect(lists.every((rows) => rows.length === 0)).toBe(true);
    expect(new Set(lists).size).toBe(lists.length);
  });
});
