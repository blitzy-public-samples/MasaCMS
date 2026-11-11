/** Identity table definitions against the service migrations, table ownership and the platform repository contract. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, createRepository } from '@opt2/platform/migration-kit';
import {
  GROUP_ACCOUNT,
  IDENTITY_UNITS,
  NON_UNIT_TABLE_NAMES,
  OWNED_TABLES,
  SESSION,
  UNIT_TABLES,
  USER_ACCOUNT,
  type SessionRow,
} from '../../src/repo/tables.js';

interface DdlTable {
  file: string;
  columns: { name: string; type: string }[];
  primaryKey: string[];
}

interface Ownership {
  units: { unit: string; owner: string; schema: string; table: string; tenantOwned: boolean }[];
  tables: { table: string; hasPrimaryKey: boolean; targets?: { unit: string; owner: string; keyColumns: string[]; ownedColumns: string[] }[] }[];
  newTables: { table: string; owner: string }[];
}

const SCHEMA = 'identity';
const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const TARGET_ONLY: Readonly<Record<string, readonly string[]>> = { group_account: ['row_version'], user_account: ['opt2_state'] };
const CREATE_TABLE = /^CREATE TABLE (\w+)\.(\w+) \(\n([\s\S]*?)\n\);/gm;
const COLUMN = /^"?([a-z_0-9]+)"? (.+?)(?= COLLATE | NOT NULL| NULL| DEFAULT | PRIMARY KEY| UNIQUE| CHECK | GENERATED |$)/;
const CONSTRAINT = /^(PRIMARY KEY|UNIQUE) /;
const ADD_COLUMN = /^ALTER TABLE (\w+)\.(\w+) ADD COLUMN (.+);$/gm;

/** Canonical tag of a migration column type; xid8 is carried as its decimal text. */
function canonicalTag(type: string): string {
  return type === 'xid8' ? 's' : canonicalTypeForPostgres(type).type;
}

/** Every `CREATE TABLE` of the service-table migrations (0002 onwards), keyed `<schema>.<table>`, with file, columns (later `ADD COLUMN`s appended) and primary key. */
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
        file,
        columns,
        primaryKey: primaryKey === undefined ? [] : primaryKey.split(',').map((column) => column.trim()),
      });
    }
    for (const [, schema, table, definition] of sql.matchAll(ADD_COLUMN)) {
      const m = COLUMN.exec(definition as string);
      if (m !== null) tables.get(`${schema as string}.${table as string}`)?.columns.push({ name: m[1] as string, type: m[2] as string });
    }
  }
  return tables;
}

const DDL = migrationTables();
const ownedUnits = OWNERSHIP.units.filter((unit) => unit.owner === 'identity');

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('identity.%s', (table, definition) => {
  it('is created in schema identity with the definition columns in catalog order and their canonical tags', () => {
    expect(DDL.get(`${SCHEMA}.${table}`)?.columns.map((column) => ({ name: column.name, type: canonicalTag(column.type) }))).toEqual(
      definition.columns.map(({ name, type }) => ({ name, type })),
    );
  });

  it('leads with tenant_id and keys on declared columns matching the migration primary key', () => {
    expect(definition.columns[0]).toEqual({ name: 'tenant_id', type: 's' });
    expect(definition.key).not.toBeNull();
    expect(definition.key).not.toContain('tenant_id');
    expect(DDL.get(`${SCHEMA}.${table}`)?.primaryKey).toEqual(['tenant_id', ...(definition.key ?? [])]);
  });
});

describe.each(UNIT_TABLES.map((definition) => [definition.table, definition] as const))('identity unit table %s', (table, definition) => {
  it('is gated by its own identity unit, which table ownership assigns to identity as tenant-owned', () => {
    expect(definition.unit).toBe(`${SCHEMA}.${table}`);
    expect(ownedUnits.find((unit) => unit.unit === definition.unit)).toMatchObject({ schema: SCHEMA, table, tenantOwned: true });
  });

  it('holds exactly the key and owned legacy columns, lower-cased, plus its target-only columns', () => {
    const entries = OWNERSHIP.tables.filter((entry) => (entry.targets ?? []).some((target) => target.unit === definition.unit));
    const target = entries[0]?.targets?.find((candidate) => candidate.unit === definition.unit);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hasPrimaryKey).toBe(true);
    expect(target?.owner).toBe('identity');
    const owned = (target?.ownedColumns ?? []).map((column) => column.toLowerCase());
    const key = (target?.keyColumns ?? []).map((column) => column.toLowerCase());
    const local = new Set(['tenant_id', ...(TARGET_ONLY[table] ?? [])]);
    expect(definition.columns.filter((column) => !local.has(column.name)).map((column) => column.name)).toEqual([
      ...key.filter((column) => !owned.includes(column)),
      ...owned,
    ]);
    expect(definition.key).toEqual(key);
  });
});

describe('identity tables', () => {
  it('declares exactly the identity units of table ownership, once each, in UNIT_TABLES order', () => {
    expect([...IDENTITY_UNITS].sort()).toEqual(ownedUnits.map((unit) => unit.unit).sort());
    expect(new Set(IDENTITY_UNITS).size).toBe(IDENTITY_UNITS.length);
    expect(UNIT_TABLES.map((definition) => definition.unit)).toEqual([...IDENTITY_UNITS]);
  });

  it('lists the unit tables first, then the ungated new tables, which the platform repository accepts', () => {
    const repository = createRepository({ owner: 'identity', schema: SCHEMA, tables: OWNED_TABLES });
    expect(OWNED_TABLES.slice(0, UNIT_TABLES.length)).toEqual([...UNIT_TABLES]);
    expect(OWNED_TABLES.slice(UNIT_TABLES.length).map((definition) => definition.table)).toEqual([...NON_UNIT_TABLE_NAMES]);
    expect(OWNED_TABLES.slice(UNIT_TABLES.length).every((definition) => definition.unit === undefined)).toBe(true);
    expect(repository.units()).toEqual([...IDENTITY_UNITS]);
    expect(repository.definition('session')).toEqual(SESSION);
  });

  it('declares every service table of the migrations, and the new tables table ownership lists for identity', () => {
    expect(OWNED_TABLES.map((definition) => `${SCHEMA}.${definition.table}`).sort()).toEqual([...DDL.keys()].sort());
    for (const entry of OWNERSHIP.newTables.filter((candidate) => candidate.owner === 'identity')) {
      expect(OWNED_TABLES.map((definition) => `${SCHEMA}.${definition.table}`)).toContain(entry.table);
    }
  });

  it('ends group_account with row_version and user_account with opt2_state', () => {
    expect(GROUP_ACCOUNT.columns.at(-1)).toEqual({ name: 'row_version', type: 'i' });
    expect(USER_ACCOUNT.columns.at(-1)).toEqual({ name: 'opt2_state', type: 's' });
  });

  it('types a session row with exactly the session columns', () => {
    const now = new Date();
    const row: SessionRow = {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      session_id: 'sid',
      user_id: null,
      site_id: null,
      login_snapshot: null,
      epoch: '0',
      csrf_secret: 'secret',
      mode: 'legacy-primary',
      state: 'active',
      jar_ref: null,
      created_at: now,
      updated_at: now,
      ended_at: null,
      admin_state: null,
    };
    expect(Object.keys(row)).toEqual(SESSION.columns.map((column) => column.name));
  });
});
