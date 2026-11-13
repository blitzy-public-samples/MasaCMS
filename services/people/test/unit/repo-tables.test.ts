/** People table definitions against the service migrations, table ownership and the platform repository contract. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, createRepository } from '@opt2/platform/migration-kit';
import {
  NON_UNIT_TABLE_NAMES,
  OPEN_ROSTER_STATES,
  OWNED_TABLES,
  PEOPLE_UNITS,
  PERSON,
  PERSON_COLUMNS,
  PERSON_INSERT_COLUMNS,
  PERSON_UPDATE_COLUMNS,
  RECOVERABLE_ROSTER_STATES,
  ROSTER_OPERATION,
  ROSTER_STATES,
  TARGET_ONLY_COLUMNS,
  UNIT_TABLES,
  type PeopleTableName,
  type RosterOperationRow,
} from '../../src/repo/tables.js';

interface DdlTable {
  columns: { name: string; type: string }[];
  primaryKey: string[];
}

interface Ownership {
  units: { unit: string; owner: string; schema: string; table: string; tenantOwned: boolean }[];
  tables: { table: string; hasPrimaryKey: boolean; targets?: { unit: string; owner: string; keyColumns: string[]; ownedColumns: string[] }[] }[];
  newTables: { table: string; owner: string }[];
}

const SCHEMA = 'people';
const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const ROSTER_SQL = readFileSync(new URL('0004_roster_archive.sql', MIGRATIONS), 'utf8');
const LOOKUP_SQL = readFileSync(new URL('0007_person_lookup_indexes.sql', MIGRATIONS), 'utf8');
const CREATE_TABLE = /^CREATE TABLE (\w+)\.(\w+) \(\n([\s\S]*?)\n\);/gm;
const COLUMN = /^"?([a-z_0-9]+)"? (.+?)(?= NOT NULL| NULL| DEFAULT | PRIMARY KEY| UNIQUE| CHECK | GENERATED |$)/;
const CONSTRAINT = /^(PRIMARY KEY|UNIQUE) /;
const ADD_COLUMN = /^ALTER TABLE (\w+)\.(\w+) ADD COLUMN (\w+) (.+?)(?= NOT NULL| NULL| DEFAULT |;)/gm;

/** Every `CREATE TABLE` of the service-table migrations (0002 onwards) with the columns later migrations add, keyed `<schema>.<table>`. */
function migrationTables(): Map<string, DdlTable> {
  const tables = new Map<string, DdlTable>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => /^\d{4}_\w+\.sql$/.test(name) && !name.startsWith('0001_')).sort()) {
    const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
    for (const [, schema, table, body] of sql.matchAll(CREATE_TABLE)) {
      const lines = (body as string)
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter((line) => !line.startsWith('--'));
      const columns = lines.flatMap((line) => {
        const m = CONSTRAINT.test(line) ? null : COLUMN.exec(line);
        return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
      });
      const primaryKey = /^PRIMARY KEY \(([^)]+)\)$/.exec(lines.find((line) => line.startsWith('PRIMARY KEY')) ?? '')?.[1];
      tables.set(`${schema as string}.${table as string}`, {
        columns,
        primaryKey: primaryKey === undefined ? [] : primaryKey.split(',').map((column) => column.trim()),
      });
    }
    for (const [, schema, table, name, type] of sql.matchAll(ADD_COLUMN)) {
      tables.get(`${schema as string}.${table as string}`)?.columns.push({ name: name as string, type: type as string });
    }
  }
  return tables;
}

/** The quoted values of an `IN (...)` list matched by `pattern` in `sql`. */
function inList(pattern: RegExp, sql = ROSTER_SQL): string[] {
  return (pattern.exec(sql)?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

const DDL = migrationTables();
const ownedUnits = OWNERSHIP.units.filter((unit) => unit.owner === SCHEMA);
const lower = (columns: readonly string[]): string[] => columns.map((column) => column.toLowerCase());

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('people.%s', (table, definition) => {
  it('is created in schema people with the definition columns in catalog order and their canonical tags', () => {
    expect(DDL.get(`${SCHEMA}.${table}`)?.columns.map((column) => ({ name: column.name, type: canonicalTypeForPostgres(column.type).type }))).toEqual(
      definition.columns.map(({ name, type }) => ({ name, type })),
    );
  });

  it('leads with tenant_id and keys on the migration primary key without tenant_id', () => {
    expect(definition.columns[0]).toEqual({ name: 'tenant_id', type: 's' });
    expect(definition.key).not.toContain('tenant_id');
    expect(DDL.get(`${SCHEMA}.${table}`)?.primaryKey).toEqual(['tenant_id', ...(definition.key ?? [])]);
  });
});

describe.each(UNIT_TABLES.map((definition) => [definition.table, definition] as const))('people unit table %s', (table, definition) => {
  const entries = OWNERSHIP.tables.filter((entry) => (entry.targets ?? []).some((target) => target.unit === definition.unit));
  const target = entries[0]?.targets?.find((candidate) => candidate.unit === definition.unit);

  it('is gated by its own people unit, which table ownership assigns to people as tenant-owned', () => {
    expect(definition.unit).toBe(`${SCHEMA}.${table}`);
    expect(ownedUnits.find((unit) => unit.unit === definition.unit)).toMatchObject({ schema: SCHEMA, table, tenantOwned: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hasPrimaryKey).toBe(true);
    expect(target?.owner).toBe(SCHEMA);
  });

  it('holds exactly the key and owned legacy columns, lower-cased and in owned order, plus its target-only columns', () => {
    const owned = lower(target?.ownedColumns ?? []);
    const key = lower(target?.keyColumns ?? []);
    const local = new Set(['tenant_id', ...(TARGET_ONLY_COLUMNS[table] ?? [])]);
    const names = definition.columns.filter((column) => !local.has(column.name)).map((column) => column.name);
    expect([...names].sort()).toEqual([...new Set([...key, ...owned])].sort());
    expect(names.filter((name) => owned.includes(name))).toEqual(owned);
    expect(key).toEqual(expect.arrayContaining(definition.key ?? []));
  });
});

describe('people tables', () => {
  it('declares the people units of table ownership in its order, each by exactly one unit table', () => {
    expect([...PEOPLE_UNITS]).toEqual(ownedUnits.map((unit) => unit.unit));
    expect(UNIT_TABLES.map((definition) => definition.unit)).toEqual([...PEOPLE_UNITS]);
  });

  it('declares every service table of the migrations, which the platform repository accepts', () => {
    const repository = createRepository({ owner: SCHEMA, schema: SCHEMA, tables: OWNED_TABLES });
    expect(OWNED_TABLES.map((definition) => `${SCHEMA}.${definition.table}`)).toEqual([...DDL.keys()]);
    expect([...repository.units()].sort()).toEqual([...PEOPLE_UNITS].sort());
    expect(OWNED_TABLES.filter((definition) => definition.unit === undefined).map((definition) => definition.table)).toEqual([
      ...NON_UNIT_TABLE_NAMES,
    ]);
    for (const entry of OWNERSHIP.newTables.filter((candidate) => candidate.owner === SCHEMA)) {
      expect(OWNED_TABLES.map((definition) => `${SCHEMA}.${definition.table}`)).toContain(entry.table);
    }
  });

  it('marks only declared columns as target-only', () => {
    for (const [table, columns] of Object.entries(TARGET_ONLY_COLUMNS) as [PeopleTableName, readonly string[]][]) {
      const names = OWNED_TABLES.find((definition) => definition.table === table)?.columns.map((column) => column.name) ?? [];
      expect(names).toEqual(expect.arrayContaining([...columns]));
    }
  });

  it('lists the 24 owned person columns and the people columns userDAO.create and userDAO.update write', () => {
    const personTarget = OWNERSHIP.tables.find((entry) => entry.table === 'tusers')?.targets?.find((t) => t.unit === PERSON.unit);
    const catalog = PERSON.columns.map((column) => column.name);
    const legacy = new Set<string>(['userid', 'siteid', ...PERSON_COLUMNS]);
    expect([...PERSON_COLUMNS]).toEqual(lower(personTarget?.ownedColumns ?? []));
    expect(PERSON_COLUMNS).toHaveLength(24);
    expect([...PERSON_INSERT_COLUMNS]).toEqual(catalog.filter((name) => legacy.has(name) && name !== 'ext'));
    expect([...PERSON_UPDATE_COLUMNS]).toEqual(catalog.filter((name) => legacy.has(name) && !['ext', 'created', 'userid'].includes(name)));
  });

  it('matches the roster_operation state CHECK and the open-operation partial unique index', () => {
    expect([...ROSTER_STATES]).toEqual(inList(/state text NOT NULL CHECK \(state IN \(([^)]*)\)\)/));
    expect([...OPEN_ROSTER_STATES]).toEqual(inList(/ON people\.roster_operation \(user_id\)\s+WHERE state IN \(([^)]*)\)/));
    // 0007 replaces the 0004 index with its case-insensitive form under the same name.
    expect(LOOKUP_SQL).toContain('DROP INDEX people.roster_operation_open_user_uidx;');
    expect([...OPEN_ROSTER_STATES]).toEqual(
      inList(/INDEX roster_operation_open_user_uidx ON people\.roster_operation \(user_id COLLATE people\.legacy_char_ci\)\s+WHERE state IN \(([^)]*)\)/, LOOKUP_SQL),
    );
    expect(RECOVERABLE_ROSTER_STATES.every((state) => (OPEN_ROSTER_STATES as readonly string[]).includes(state))).toBe(true);
    expect(RECOVERABLE_ROSTER_STATES).not.toContain('halted');
  });

  it('types a roster_operation row with exactly the roster_operation columns', () => {
    const now = new Date();
    const row: RosterOperationRow = {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      operation_id: 'operation',
      kind: 'update',
      user_id: 'user',
      payload: '{}',
      before_image: null,
      identity_xid: null,
      state: 'started',
      error: null,
      started_at: now,
      updated_at: now,
      identity_unreachable_since: null,
      claimed_by: null,
    };
    expect(Object.keys(row)).toEqual(ROSTER_OPERATION.columns.map((column) => column.name));
  });
});
