/** Programs-sites table definitions against the service migrations, table ownership and the platform repository contract. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, createRepository, type TableDefinition } from '@opt2/platform/migration-kit';
import { OWNED_TABLES, SITE, SITE_MONITOR_STATE, UNITS } from '../../src/repo/tables.js';

interface DdlTable {
  file: string;
  columns: { name: string; type: string }[];
  primaryKey: string[];
}

interface Ownership {
  units: { unit: string; owner: string; schema: string; table: string; tenantOwned: boolean }[];
  tables: { table: string; targets?: { unit: string; owner: string; keyColumns: string[]; ownedColumns: string[] }[] }[];
  newTables: { table: string; owner: string }[];
}

const SCHEMA = 'programs_sites';
const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const KEYLESS_KEY = ['tenant_id', 'legacy_row_hash', 'occurrence'];
const MANAGED = new Set(KEYLESS_KEY);
const TARGET_ONLY: Readonly<Record<string, readonly string[]>> = { site: ['row_version'] };
const DEFINITIONS: readonly TableDefinition[] = [...OWNED_TABLES, SITE_MONITOR_STATE];
const CREATE_TABLE = /^CREATE TABLE (\w+)\.(\w+) \(\n([\s\S]*?)\n\);/gm;
const COLUMN = /^"?([a-z_]+)"? (.+?)(?= COLLATE | NOT NULL| NULL| DEFAULT | PRIMARY KEY| UNIQUE| CHECK | GENERATED |$)/;

/** Every `CREATE TABLE` of the `000*.sql` migrations, keyed `<schema>.<table>`, with its file, columns and primary key. */
function migrationTables(): Map<string, DdlTable> {
  const tables = new Map<string, DdlTable>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => /^000\d_\w+\.sql$/.test(name)).sort()) {
    for (const [, schema, table, body] of readFileSync(new URL(file, MIGRATIONS), 'utf8').matchAll(CREATE_TABLE)) {
      const lines = (body as string).split('\n').map((line) => line.trim().replace(/,$/, ''));
      const columns = lines.flatMap((line) => {
        const m = COLUMN.exec(line);
        return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
      });
      const primaryKey = /^PRIMARY KEY \(([^)]+)\)$/.exec(lines.find((line) => line.startsWith('PRIMARY KEY')) ?? '')?.[1];
      tables.set(`${schema as string}.${table as string}`, {
        file,
        columns,
        primaryKey: primaryKey === undefined ? [] : primaryKey.split(',').map((column) => column.trim()),
      });
    }
  }
  return tables;
}

const DDL = migrationTables();
const ddlOf = (table: string): DdlTable | undefined => DDL.get(`${SCHEMA}.${table}`);
const ownedUnits = OWNERSHIP.units.filter((unit) => unit.owner === 'programs-sites');

describe.each(DEFINITIONS.map((definition) => [definition.table, definition] as const))('programs_sites.%s', (table, definition) => {
  it('is created in schema programs_sites with the definition columns in catalog order and their canonical tags', () => {
    expect(ddlOf(table)?.columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type }))).toEqual(
      definition.columns.map(({ name, type }) => ({ name, type })),
    );
  });

  it('carries tenant_id as a text-tagged column', () => {
    expect(definition.columns).toContainEqual({ name: 'tenant_id', type: 's' });
  });

  it('keys on declared non-tenant columns matching the migration primary key, or is keyless with legacy_row_hash and occurrence', () => {
    const names = definition.columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(definition.key ?? KEYLESS_KEY));
    expect(definition.key ?? []).not.toContain('tenant_id');
    expect(definition.key?.length).not.toBe(0);
    expect(ddlOf(table)?.primaryKey).toEqual(definition.key === null ? KEYLESS_KEY : ['tenant_id', ...definition.key]);
  });
});

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('owned unit programs_sites.%s', (table, definition) => {
  it('is gated by its own programs_sites unit, which table ownership assigns to programs-sites as tenant-owned', () => {
    expect(definition.unit).toBe(`${SCHEMA}.${table}`);
    expect(ownedUnits.find((unit) => unit.unit === definition.unit)).toMatchObject({ schema: SCHEMA, table, tenantOwned: true });
  });

  it('holds exactly the owned legacy columns, lower-cased, and is keyless exactly when legacy has no key', () => {
    const targets = OWNERSHIP.tables.flatMap((entry) => (entry.targets ?? []).filter((target) => target.unit === definition.unit));
    const local = new Set([...MANAGED, ...(TARGET_ONLY[table] ?? [])]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.owner).toBe('programs-sites');
    expect(definition.columns.filter((column) => !local.has(column.name)).map((column) => column.name)).toEqual(
      targets[0]?.ownedColumns.map((column) => column.toLowerCase()),
    );
    expect(definition.key).toEqual(targets[0]?.keyColumns.length === 0 ? null : targets[0]?.keyColumns.map((column) => column.toLowerCase()));
  });
});

describe('programs-sites tables', () => {
  it('declares exactly the programs-sites units of table ownership, with programs_sites.trash last', () => {
    expect([...UNITS].sort()).toEqual(ownedUnits.map((unit) => unit.unit).sort());
    expect(UNITS.at(-1)).toBe('programs_sites.trash');
    expect(OWNED_TABLES.at(-1)?.unit).toBe('programs_sites.trash');
  });

  it('lists one table per unit in UNITS order, which the platform repository accepts with the ungated cursor table', () => {
    const repository = createRepository({ owner: 'programs-sites', schema: SCHEMA, tables: DEFINITIONS });
    expect(OWNED_TABLES.map((definition) => definition.unit)).toEqual([...UNITS]);
    expect(repository.units()).toEqual([...UNITS]);
    expect(repository.definition('site')).toEqual(SITE);
    expect(repository.definition('sitemonitor_state')).toEqual(SITE_MONITOR_STATE);
  });

  it('creates the unit tables in 0002_sites.sql and the new cursor table alone in 0003_sitemonitor_state.sql, all in schema programs_sites', () => {
    const inFile = (file: string): string[] => [...DDL].filter(([, ddl]) => ddl.file === file).map(([name]) => name).sort();
    expect([...DDL.keys()].every((name) => name.startsWith(`${SCHEMA}.`))).toBe(true);
    expect(inFile('0002_sites.sql')).toEqual(OWNED_TABLES.map((definition) => `${SCHEMA}.${definition.table}`).sort());
    expect(inFile('0003_sitemonitor_state.sql')).toEqual([`${SCHEMA}.${SITE_MONITOR_STATE.table}`]);
    expect(OWNERSHIP.newTables).toContainEqual(expect.objectContaining({ table: `${SCHEMA}.sitemonitor_state`, owner: 'programs-sites' }));
    expect(SITE_MONITOR_STATE.unit).toBeUndefined();
  });

  it('keys the site on siteid and ends its columns with the target-only row_version', () => {
    expect(SITE.key).toEqual(['siteid']);
    expect(SITE.columns.at(-1)).toEqual({ name: 'row_version', type: 'i' });
  });
});
