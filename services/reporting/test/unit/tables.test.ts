// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting table definitions and mapping coverage against the target DDL, the fixture DDL, the ownership file and the platform repository contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalTypeForPostgres, canonicalTypeForSqlServer, createRepository, diffCoverage, mappingCoverage } from '@opt2/platform/migration-kit';
import { BUCKETS, InvalidObjectKeyError } from '@opt2/platform/storage';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { mappings } from '../../src/migration/mappings/index.js';
import {
  EXPORT_BUCKET,
  EXPORT_DEFINITION,
  EXPORT_JOB,
  EXPORT_OUTPUT_FIELD,
  OUTPUT_SLOTS,
  OWNED_TABLES,
  OWNER,
  SCHEMA,
  TSESSIONTRACKING,
  UNITS,
  exportObjectKey,
  type ExportFormat,
  type OutputSlot,
} from '../../src/repo/tables.js';

interface DdlColumn {
  name: string;
  type: string;
}

interface OwnershipTarget {
  unit: string;
  table: string;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
  /** Object-backed column → bucket of its bytes. */
  objectColumns?: Record<string, string>;
}

interface OwnershipTable {
  table: string;
  columns: string[];
  targets: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; table: string }[];
  tables: OwnershipTable[];
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const TARGET_DDL = read('../../db/migrations/0002_reporting.sql');
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/reporting/100_tables.sql');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;

/** Columns the target adds to the fixture tables. */
const TARGET_ONLY = ['tenant_id', 'object_key', 'row_version'];

/** Trimmed, non-empty body lines of the first `CREATE TABLE` block that `head` opens and `tail` closes. */
function tableBody(ddl: string, head: string, tail: string): string[] {
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`no table ${head}`);
  const from = start + head.length;
  return ddl.slice(from, ddl.indexOf(tail, from)).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Columns and primary key of `reporting.<table>` in `0002_reporting.sql`. */
function targetTable(table: string): { columns: DdlColumn[]; primaryKey: string[] } {
  const body = tableBody(TARGET_DDL, `CREATE TABLE reporting.${table} (`, '\n);').map((line) => line.replace(/,$/, ''));
  const columns = body
    .filter((line) => !line.startsWith('PRIMARY KEY'))
    .flatMap((line) => {
      const m = /^([a-z_0-9]+) (.+?)(?: (?:NOT NULL|NULL|DEFAULT)\b.*)?$/.exec(line);
      return m === null ? [] : [{ name: m[1] as string, type: m[2] as string }];
    });
  const declared = /^PRIMARY KEY \(([^)]+)\)/.exec(body.find((line) => line.startsWith('PRIMARY KEY')) ?? '');
  return { columns, primaryKey: (declared?.[1] ?? '').split(',').map((column) => column.trim()) };
}

/** Columns of `[synthetic].[<table>]` in `100_tables.sql`, names lower-cased, types with their arguments. */
function fixtureTable(table: string): DdlColumn[] {
  return tableBody(FIXTURE_DDL, `CREATE TABLE [synthetic].[${table}] (`, ') ON [PRIMARY]').flatMap((line) => {
    const m = /^\[(\w+)\] \[(\w+)\](?: \(([^)]*)\))?/.exec(line);
    return m === null ? [] : [{ name: (m[1] as string).toLowerCase(), type: m[3] === undefined ? (m[2] as string) : `${m[2]}(${m[3]})` }];
  });
}

/** The ownership-file target of `unit`. */
function ownershipTarget(unit: string): OwnershipTarget {
  const target = OWNERSHIP.tables.flatMap((table) => table.targets).find((candidate) => candidate.unit === unit);
  if (target === undefined) throw new Error(`no ownership target ${unit}`);
  return target;
}

const canonical = ({ name, type, scale }: { name: string; type: string; scale?: number | undefined }) => ({ name, type, scale });
const lower = (names: readonly string[]): string[] => names.map((name) => name.toLowerCase());

describe.each(OWNED_TABLES.map((definition) => [definition.table, definition] as const))('reporting.%s', (table, definition) => {
  it('lists the target DDL columns in catalog order with their canonical tags', () => {
    expect(definition.columns.map(canonical)).toEqual(
      targetTable(table).columns.map((column) => canonical({ name: column.name, ...canonicalTypeForPostgres(column.type) })),
    );
  });

  it('keys on the target primary key without tenant_id', () => {
    expect(targetTable(table).primaryKey).toEqual(['tenant_id', ...definition.key]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(definition) && Object.isFrozen(definition.columns) && Object.isFrozen(definition.key)).toBe(true);
    expect(definition.columns.every((column) => Object.isFrozen(column))).toBe(true);
  });

  it('is gated by the ownership-file unit of its table, with the owned columns and key', () => {
    expect(definition.unit).toBe(`reporting.${table}`);
    const target = ownershipTarget(definition.unit);
    expect(target.table).toBe(table);
    expect(lower(target.keyColumns)).toEqual(definition.key);
    const objects = lower(Object.keys(target.objectColumns ?? {}));
    const owned = lower(target.ownedColumns).filter((column) => !objects.includes(column));
    expect(definition.columns.map((column) => column.name).filter((column) => !TARGET_ONLY.includes(column))).toEqual(owned);
  });
});

describe.each([EXPORT_DEFINITION, EXPORT_JOB].map((definition) => [definition.table, definition] as const))('synthetic.%s', (table, definition) => {
  it('carries exactly the fixture columns besides the target-only ones, never the output bytes', () => {
    const fixture = fixtureTable(table).filter((column) => column.name !== EXPORT_OUTPUT_FIELD);
    expect(definition.columns.filter((column) => !TARGET_ONLY.includes(column.name)).map(canonical)).toEqual(
      fixture.map((column) => canonical({ name: column.name, ...canonicalTypeForSqlServer(column.type) })),
    );
  });
});

describe('reporting tables', () => {
  it('declares one table per ownership-file unit in UNITS order, which the platform repository accepts', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === 'reporting').map((unit) => unit.unit);
    expect([...UNITS].sort()).toEqual(owned.sort());
    expect(OWNED_TABLES.map((definition) => definition.unit)).toEqual([...UNITS]);
    expect(createRepository({ owner: OWNER, schema: SCHEMA, tables: OWNED_TABLES }).units()).toEqual([...UNITS]);
    expect(Object.isFrozen(OWNED_TABLES) && Object.isFrozen(UNITS)).toBe(true);
  });

  it('stores export bytes in a platform bucket, keyed in the fixture output position', () => {
    expect(BUCKETS).toContain(EXPORT_BUCKET);
    expect(ownershipTarget(EXPORT_JOB.unit).objectColumns).toEqual({ [EXPORT_OUTPUT_FIELD]: EXPORT_BUCKET });
    const names = EXPORT_JOB.columns.map((column) => column.name);
    expect(names).not.toContain(EXPORT_OUTPUT_FIELD);
    const outputPosition = fixtureTable('export_job').findIndex((column) => column.name === EXPORT_OUTPUT_FIELD);
    expect(names.indexOf('object_key')).toBe(outputPosition + 1);
  });

  it('catalogues all twenty tsessiontracking columns', () => {
    expect(TSESSIONTRACKING.columns.filter((column) => column.name !== 'tenant_id')).toHaveLength(20);
  });
});

/** A reporting target of the ownership file with its legacy table. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  table.targets.filter((target) => OWNED_UNITS.has(target.unit)).map((target) => ({ table, target })),
);

/** Legacy columns ownership assigns to a target: the catalog's columns when whole-table, else its key and owned columns. */
function assignedColumns({ table, target }: OwnedTarget): string[] {
  return target.columnPolicy === 'whole-table' ? table.columns : [...new Set([...target.keyColumns, ...target.ownedColumns])];
}

/** Assigned columns outside the target's object columns, which the row mappings cover. */
function canonicalColumns(entry: OwnedTarget): string[] {
  const objects = lower(Object.keys(entry.target.objectColumns ?? {}));
  return assignedColumns(entry).filter((column) => !objects.includes(column.toLowerCase()));
}

describe('reporting mapping coverage', () => {
  it('maps exactly the legacy columns ownership assigns to reporting, besides its object columns', () => {
    expect(OWNED_TARGETS.map(({ target }) => target.unit).sort()).toEqual([...UNITS].sort());
    const expected: Record<string, string[]> = {};
    for (const entry of OWNED_TARGETS) (expected[entry.table.table] ??= []).push(...canonicalColumns(entry));
    const diff = diffCoverage(expected, mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('splits the assigned columns into canonical and object columns without overlap, output the one object column', () => {
    const split = OWNED_TARGETS.map((entry) => ({
      assigned: lower(assignedColumns(entry)),
      canonical: lower(canonicalColumns(entry)),
      objects: lower(Object.keys(entry.target.objectColumns ?? {})),
    }));
    for (const { assigned, canonical, objects } of split) {
      expect(objects.filter((column) => !assigned.includes(column))).toEqual([]);
      expect([...canonical, ...objects].sort()).toEqual([...assigned].sort());
    }
    const total = (key: keyof (typeof split)[number]): number => split.reduce((sum, columns) => sum + columns[key].length, 0);
    expect([total('assigned'), total('canonical'), total('objects')]).toEqual([39, 38, 1]);
    const objectColumns = OWNED_TARGETS.flatMap(({ table, target }) =>
      Object.entries(target.objectColumns ?? {}).map(([column, bucket]) => [table.table, column, bucket]),
    );
    expect(objectColumns).toEqual([['synthetic.export_job', EXPORT_OUTPUT_FIELD, EXPORT_BUCKET]]);
  });
});

describe('exportObjectKey', () => {
  const tenantId = '0b0e9c1c-6a3b-5d8e-9f10-112233445566';
  const jobId = cfUuid();

  it.each<[ExportFormat, OutputSlot | undefined, string]>([
    ['xlsx', undefined, 'xlsx'],
    ['csv', undefined, 'csv'],
    ['pdf', undefined, 'pdf'],
    ['xlsx', 'a', 'a.xlsx'],
    ['csv', 'a', 'a.csv'],
    ['pdf', 'b', 'b.pdf'],
  ])('keys a %s export in slot %s as <tenantId>/<jobId>.%s', (format, slot, name) => {
    expect(exportObjectKey(tenantId, jobId, format, slot)).toBe(`${tenantId}/${jobId}.${name}`);
  });

  it('declares exactly the output slots a and b', () => {
    expect(OUTPUT_SLOTS).toEqual(['a', 'b']);
    expect(Object.isFrozen(OUTPUT_SLOTS)).toBe(true);
  });

  it.each([undefined, ...OUTPUT_SLOTS])('rejects a job id that is not a CF UUID in slot %s', (slot) => {
    expect(() => exportObjectKey(tenantId, 'JOB', 'csv', slot)).toThrow(InvalidObjectKeyError);
  });
});
