// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets table definitions against the target DDL, the fixture DDL, the ownership file and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository } from '@opt2/platform/migration-kit';
import {
  APPROVAL_ACTION,
  BLACKOUT,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RC_SET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  TIMESHEET,
  TIMESHEET_DAY,
  TIMESHEETS_SCHEMA,
  TIMESHEETS_UNITS,
  TRASH,
  tables,
} from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
}

interface OwnershipTarget {
  unit: string;
  keyColumns: string[];
  ownedColumns: string[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: { table: string; targets?: OwnershipTarget[] }[];
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const TARGET_DDL = [read('../../db/migrations/0001_timesheets.sql'), read('../../db/migrations/0002_extensions.sql')].join('\n');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/timesheets/110_tables.program.sql');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;

/** Columns the target adds to every folded `Program_<id>` table. */
const TARGET_ONLY = ['tenant_id', 'legacy_program_id'];

/** Tables folded from the fixture tables `Program_<id>.<table>`. */
const FOLDED_TABLES = [TIMESHEET, TIMESHEET_DAY, APPROVAL_ACTION, BLACKOUT] as const;

/** Tables of the timesheets share of a Masa `dbo` table, which are not folded. */
const MASA_TABLES = [EXTEND_SUBTYPE, EXTEND_SET, EXTEND_ATTRIBUTE, EXTEND_RC_SET, EXTEND_DATA, TRASH] as const;

/** The table-ownership target of `unit`; throws when the file names none or several. */
function ownershipTarget(unit: string): OwnershipTarget {
  const found = OWNERSHIP.tables.flatMap((entry) => (entry.targets ?? []).filter((target) => target.unit === unit));
  const [target] = found;
  if (found.length !== 1 || target === undefined) throw new Error(`${String(found.length)} ownership targets for ${unit}`);
  return target;
}

/** Trimmed, non-empty body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns and primary key of `timesheets.<table>` in `db/migrations`. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE timesheets.${table} (`, '\n);').map((line) => line.replace(/,$/, ''));
  const columns = body
    .filter((line) => !/^(?:PRIMARY KEY|UNIQUE|CHECK)\b/.test(line))
    .flatMap((line) => {
      const m = /^([a-z_0-9]+) (.+?)(?: (?:NOT NULL|NULL|DEFAULT)\b.*)?$/.exec(line);
      return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
    });
  const declared = /^PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.startsWith('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (declared?.[1] ?? '').split(',').map((column) => column.trim()) };
}

/** Columns (names lower-cased, types with their arguments) and primary key of `[Program_N].[<table>]` in `110_tables.program.sql`. */
function fixtureTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(FIXTURE_DDL, `CREATE TABLE [$(PROGRAM_SCHEMA)].[${table}] (`, ') ON [PRIMARY]');
  const columns = body.flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\](?: \(([^)]*)\))?/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[3] === undefined ? (m[2] as string) : `${m[2]}(${m[3]})` }];
  });
  const primaryKey = /PRIMARY KEY CLUSTERED \(([^)]+)\)/.exec(body.find((line) => line.includes('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (primaryKey?.[1] ?? '').split(',').map((column) => column.trim().replace(/^\[|\]$/g, '').toLowerCase()) };
}

const canonical = ({ name, type, scale }: { name: string; type: string; scale?: number | undefined }) => ({ name, type, scale });

describe.each(tables.map((definition) => [definition.table, definition] as const))('timesheets.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    expect(definition.columns.map(canonical)).toEqual(
      targetTable(table).columns.map((column) => canonical({ name: column.name, ...canonicalTypeForPostgres(column.type) })),
    );
  });

  it('is gated by its own timesheets unit and cannot be changed by a consumer', () => {
    expect(definition.unit).toBe(`${TIMESHEETS_SCHEMA}.${table}`);
    expect(Object.isFrozen(definition) && Object.isFrozen(definition.columns) && Object.isFrozen(definition.key)).toBe(true);
    expect(definition.columns.every((column) => Object.isFrozen(column))).toBe(true);
  });
});

describe.each(FOLDED_TABLES.map((definition) => [definition.table, definition] as const))('timesheets.%s', (table, definition) => {
  it('carries exactly the fixture columns besides tenant_id and legacy_program_id', () => {
    expect(definition.columns.filter((column) => !TARGET_ONLY.includes(column.name)).map(canonical)).toEqual(
      fixtureTable(table).columns.map((column) => canonical({ name: column.name, ...canonicalTypeForSqlServer(column.type) })),
    );
  });

  it('declares tenant_id first and the integer legacy_program_id last', () => {
    expect(definition.columns[0]).toEqual({ name: 'tenant_id', type: 's' });
    expect(definition.columns.at(-1)).toEqual({ name: 'legacy_program_id', type: 'i' });
  });

  it('keys on the fixture primary key, which the target primary key prefixes with tenant_id', () => {
    expect(fixtureTable(table).primaryKey).toEqual(definition.key);
    expect(targetTable(table).primaryKey).toEqual(['tenant_id', ...definition.key]);
  });
});

describe.each(MASA_TABLES.map((definition) => [definition.table, definition] as const))('timesheets.%s', (table, definition) => {
  const target = ownershipTarget(definition.unit);

  it('carries tenant_id, then the lower-cased owned columns of its ownership target in their order, and no legacy_program_id', () => {
    expect(definition.columns.map((column) => column.name)).toEqual(['tenant_id', ...target.ownedColumns.map((name) => name.toLowerCase())]);
  });

  it('keys on the ownership key columns, which the target primary key prefixes with tenant_id', () => {
    expect(definition.key).toEqual(target.keyColumns.map((name) => name.toLowerCase()));
    expect(targetTable(table).primaryKey).toEqual(['tenant_id', ...definition.key]);
  });
});

describe('timesheets tables', () => {
  it('declares one table per ownership-file unit in TIMESHEETS_UNITS order, which the platform repository accepts', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === 'timesheets').map((unit) => unit.unit);
    const repository = createRepository({ owner: 'timesheets', schema: TIMESHEETS_SCHEMA, tables });
    expect(TIMESHEETS_SCHEMA).toBe('timesheets');
    expect([...TIMESHEETS_UNITS]).toEqual([
      'timesheets.timesheet',
      'timesheets.timesheet_day',
      'timesheets.approval_action',
      'timesheets.blackout',
      'timesheets.extend_subtype',
      'timesheets.extend_set',
      'timesheets.extend_attribute',
      'timesheets.extend_rc_set',
      'timesheets.extend_data',
      'timesheets.trash',
    ]);
    expect([...TIMESHEETS_UNITS].sort()).toEqual(owned.sort());
    expect(tables).toEqual([...FOLDED_TABLES, ...MASA_TABLES]);
    expect(tables.map((definition) => definition.unit)).toEqual([...TIMESHEETS_UNITS]);
    expect(repository.units()).toEqual([...TIMESHEETS_UNITS]);
    expect(repository.definition('timesheet_day')).toEqual(TIMESHEET_DAY);
    expect(Object.isFrozen(tables) && Object.isFrozen(TIMESHEETS_UNITS)).toBe(true);
  });

  it('stores day hours as four-decimal numeric', () => {
    expect(TIMESHEET_DAY.columns.find((column) => column.name === 'hours')).toEqual({ name: 'hours', type: 'd', scale: 4 });
  });
});
