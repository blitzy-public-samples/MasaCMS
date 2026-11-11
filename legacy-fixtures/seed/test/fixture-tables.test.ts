// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MappingError } from '@opt2/platform/migration-kit';
import { loadConfig, type SeedConfig } from '../src/config.js';
import {
  FIXTURE_TABLE_SPECS,
  emptyFixtureTables,
  fixtureKey,
  fixtureKeys,
  specForKey,
  type FixtureModule,
  type FixtureTableSpec,
} from '../src/fixture-tables.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DDL_FILES: Readonly<Record<FixtureModule, string>> = {
  people: 'people/100_person_archive.sql',
  timesheets: 'timesheets/110_tables.program.sql',
  finance: 'finance/110_tables.program.sql',
  surveys: 'surveys/100_tables.sql',
  reporting: 'reporting/100_tables.sql',
  communications: 'communications/100_tables.sql',
  esignature: 'esignature/100_tables.sql',
};

const EXCLUDED_DDL_TABLES: readonly string[] = ['finance_rollup'];

const EXPECTED_KEYS: readonly string[] = [
  'synthetic.person_archive',
  'Program_1.timesheet',
  'Program_2.timesheet',
  'Program_1.timesheet_day',
  'Program_2.timesheet_day',
  'Program_1.approval_action',
  'Program_2.approval_action',
  'Program_1.blackout',
  'Program_2.blackout',
  'Program_1.finance_record',
  'Program_2.finance_record',
  'Program_1.finance_record_version',
  'Program_2.finance_record_version',
  'Program_1.finance_attachment',
  'Program_2.finance_attachment',
  'synthetic.survey',
  'synthetic.survey_schedule',
  'synthetic.survey_reminder',
  'synthetic.survey_target',
  'synthetic.survey_response',
  'synthetic.export_definition',
  'synthetic.export_job',
  'synthetic.message_template',
  'synthetic.message',
  'synthetic.delivery_status',
  'synthetic.signature_request',
  'synthetic.signature',
  'synthetic.audit_entry',
];

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

let config: SeedConfig;
const ddl = new Map<FixtureModule, Map<string, DdlTable>>();

beforeAll(async () => {
  config = await loadConfig(CONFIG_PATH);
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
    expect(table.schema).toBe(entry.scope === 'program' ? '$(PROGRAM_SCHEMA)' : 'synthetic');
    expect(table.primaryKey).toEqual([entry.key]);
    expect(table.columns[0]).toBe(entry.key);
    if (entry.site.kind === 'column') expect(table.columns).toContain(entry.site.column);
    if (entry.site.kind === 'parent') expect(table.columns).toContain(entry.site.foreignKey);
    expect(entry.site.kind === 'program').toBe(entry.scope === 'program');
  });

  it.each(FIXTURE_TABLE_SPECS.filter((entry) => entry.site.kind === 'parent').map((entry) => [entry.table, entry] as const))(
    '%s resolves its site through an earlier table of its module keyed by the foreign key',
    (_table, entry) => {
      const site = entry.site as Extract<FixtureTableSpec['site'], { kind: 'parent' }>;
      const parentIndex = FIXTURE_TABLE_SPECS.findIndex((other) => other.scope === 'synthetic' && other.table === site.table);
      const parent = FIXTURE_TABLE_SPECS[parentIndex];
      expect(parent?.module).toBe(entry.module);
      expect(parent?.key).toBe(site.foreignKey);
      expect(parentIndex).toBeLessThan(FIXTURE_TABLE_SPECS.indexOf(entry));
    },
  );

  it.each(Object.keys(DDL_FILES) as FixtureModule[])('lists every %s DDL table except the excluded ones, in DDL order', (module) => {
    const ddlTables = [...(ddl.get(module)?.keys() ?? [])].filter((table) => !EXCLUDED_DDL_TABLES.includes(table));
    expect(FIXTURE_TABLE_SPECS.filter((entry) => entry.module === module).map((entry) => entry.table)).toEqual(ddlTables);
  });

  it('owns each module by its service folder', () => {
    for (const entry of FIXTURE_TABLE_SPECS) {
      expect(entry.service).toBe(entry.module === 'esignature' ? 'e-signature' : entry.module);
      expect(existsSync(`${REPO_ROOT}services/${entry.service}`)).toBe(true);
    }
  });

  it('takes survey tenants from the survey site, never from targeted or respondent sites', () => {
    expect(specForKey('synthetic.survey_target').spec.site).toEqual({ kind: 'parent', table: 'survey', foreignKey: 'survey_id' });
    expect(specForKey('synthetic.survey_response').spec.site).toEqual({ kind: 'column', column: 'siteID' });
    expect(FIXTURE_TABLE_SPECS.some((entry) => entry.site.kind === 'column' && entry.site.column === 'respondentSiteID')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FIXTURE_TABLE_SPECS)).toBe(true);
    for (const entry of FIXTURE_TABLE_SPECS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.site)).toBe(true);
    }
  });
});

describe('fixtureKey', () => {
  const synthetic = specForKey('synthetic.survey').spec;
  const programTable = specForKey('Program_1.blackout').spec;

  it('builds synthetic and program keys', () => {
    expect(fixtureKey(synthetic)).toBe('synthetic.survey');
    expect(fixtureKey(programTable, 2)).toBe('Program_2.blackout');
  });

  it('rejects a program id that does not fit the scope', () => {
    expect(() => fixtureKey(programTable)).toThrow(RangeError);
    expect(() => fixtureKey(synthetic, 1)).toThrow(RangeError);
    expect(() => fixtureKey(programTable, -1)).toThrow(MappingError);
  });
});

describe('fixtureKeys', () => {
  it('lists the 28 dataset keys in registry order, Program_1 before Program_2', () => {
    expect(fixtureKeys(config)).toEqual(EXPECTED_KEYS);
  });

  it('expands program tables by ascending program id whatever the site order', () => {
    const swapped: SeedConfig = {
      ...config,
      sites: {
        ...config.sites,
        'tenant-a': { ...config.sites['tenant-a'], programId: 2 },
        'tenant-b': { ...config.sites['tenant-b'], programId: 1 },
      },
    };
    expect(fixtureKeys(swapped)).toEqual(EXPECTED_KEYS);
  });

  it('omits programs no site carries', () => {
    const single: SeedConfig = { ...config, sites: { ...config.sites, 'tenant-b': { ...config.sites['tenant-b'], programId: null } } };
    expect(fixtureKeys(single)).toEqual(EXPECTED_KEYS.filter((key) => !key.startsWith('Program_2.')));
  });
});

describe('specForKey', () => {
  it.each(EXPECTED_KEYS.map((key) => [key]))('round-trips %s', (key) => {
    const { spec, programId } = specForKey(key);
    expect(fixtureKey(spec, programId ?? undefined)).toBe(key);
  });

  it('resolves a program key to its spec and program id', () => {
    const { spec, programId } = specForKey('Program_2.timesheet_day');
    expect(programId).toBe(2);
    expect(spec).toMatchObject({ module: 'timesheets', service: 'timesheets', scope: 'program', table: 'timesheet_day', key: 'day_id' });
    expect(specForKey('synthetic.audit_entry').programId).toBeNull();
  });

  it.each([
    'synthetic.finance_rollup',
    'synthetic.program_site',
    'synthetic.timesheet',
    'Program_1.survey',
    'Program_1.finance_rollup',
    '[Program_1].[timesheet]',
    'program_1.timesheet',
    'Program_01.timesheet',
    'dbo.survey',
    'survey',
    'synthetic.',
    '',
  ])('rejects %j', (key) => {
    expect(() => specForKey(key)).toThrow(new RangeError(`Unknown fixture table key ${JSON.stringify(key)}`));
  });
});

describe('emptyFixtureTables', () => {
  it('maps every key, in order, to its own empty list', () => {
    const tables = emptyFixtureTables(config);
    expect(Object.keys(tables)).toEqual(EXPECTED_KEYS);
    const lists = Object.values(tables);
    expect(lists.every((rows) => rows.length === 0)).toBe(true);
    expect(new Set(lists).size).toBe(lists.length);
  });
});
