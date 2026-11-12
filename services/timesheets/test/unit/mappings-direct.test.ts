// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The four timesheets migration mappings against table ownership, the table definitions, row round trips and program tenancy. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  LEGACY_PROGRAM_ID_COLUMN,
  MappingError,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  parseProgramTable,
  programTableName,
  resolveTenant,
  type CanonicalColumn,
  type Mapping,
  type TenantLookups,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { approvalActionMapping } from '../../src/migration/mappings/approval-action.js';
import { blackoutMapping } from '../../src/migration/mappings/blackout.js';
import { timesheetDayMapping } from '../../src/migration/mappings/timesheet-day.js';
import { timesheetMapping } from '../../src/migration/mappings/timesheet.js';
import { APPROVAL_ACTION, BLACKOUT, TIMESHEET, TIMESHEET_DAY, TIMESHEETS_UNITS } from '../../src/repo/tables.js';

interface OwnershipTarget {
  unit: string;
  keyColumns: string[];
  columnPolicy: string;
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  columns: string[];
  programFold: boolean;
  rowIdentity: 'key' | 'multiset';
  tenantResolution: string;
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === 'timesheets').map((unit) => unit.unit));
const OWNED = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => OWNED_UNITS.has(target.unit)).map((target) => ({ table, target })),
);

const MAPPINGS = [timesheetMapping, timesheetDayMapping, approvalActionMapping, blackoutMapping] as const;
const DEFINITIONS = [TIMESHEET, TIMESHEET_DAY, APPROVAL_ACTION, BLACKOUT] as const;
const CASES = MAPPINGS.map((mapping, index) => {
  const definition = DEFINITIONS[index];
  if (definition === undefined) throw new Error(`no table definition for ${mapping.legacyTable}`);
  return [mapping.legacyTable, mapping, definition] as const;
});

const SITE_BY_PROGRAM: Readonly<Record<number, string>> = { 1: 'tenant-a', 2: 'tenant-b' };
const LOOKUPS: TenantLookups = { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID, programSiteId: (programId) => SITE_BY_PROGRAM[programId] ?? null };

// The nullable column of each fixture table in 110_tables.program.sql, sampled as NULL.
const NULLABLE: Readonly<Record<string, string>> = {
  timesheet: 'lastUpdateByID',
  timesheet_day: 'lastUpdateByID',
  approval_action: 'comment',
  blackout: 'archive_id',
};

/** `Program_N.<table>` of table ownership as the bare name a folded mapping declares. */
const bareTable = (table: OwnershipTable): string => table.table.replace(/^Program_N\./, '');

/** The ownership entry of `mapping`'s legacy table and unit. */
function ownedEntry(mapping: Mapping): { table: OwnershipTable; target: OwnershipTarget } {
  const found = OWNED.filter(({ table, target }) => bareTable(table) === mapping.legacyTable && target.unit === mapping.unit);
  const [entry] = found;
  if (found.length !== 1 || entry === undefined) throw new Error(`${String(found.length)} ownership entries for ${mapping.legacyTable}`);
  return entry;
}

/** A driver-shaped legacy value for `column`, distinct per column position. */
function sampleValue(column: CanonicalColumn, position: number): unknown {
  switch (column.type) {
    case 'd':
      return (position + 0.25).toFixed(column.scale ?? 0);
    case 't':
      return new Date(2026, 5, 29 + position, 9, 15, position, 997);
    default:
      return `${column.name}:${String(position)}`;
  }
}

/** A sample legacy row of `mapping`, its nullable column NULL. */
function sampleRow(mapping: Mapping): Record<string, unknown> {
  const row = Object.fromEntries(mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, sampleValue(column, position)]));
  const nullable = NULLABLE[mapping.legacyTable];
  if (nullable === undefined || !Object.hasOwn(row, nullable)) throw new Error(`${mapping.legacyTable}: no nullable sample column`);
  row[nullable] = null;
  return row;
}

describe('timesheets mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to timesheets', () => {
    const expected = Object.fromEntries(OWNED.map(({ table, target }) => [bareTable(table), target.ownedColumns]));
    const diff = diffCoverage(expected, mappingCoverage(MAPPINGS));

    expect(OWNED).toHaveLength(MAPPINGS.length);
    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('declares one frozen mapping per timesheets unit, in TIMESHEETS_UNITS order', () => {
    expect(MAPPINGS.map((mapping) => mapping.unit)).toStrictEqual([...TIMESHEETS_UNITS]);
    expect([...OWNED_UNITS].sort()).toStrictEqual([...TIMESHEETS_UNITS].sort());
    expect(MAPPINGS.every((mapping) => Object.isFrozen(mapping) && Object.isFrozen(mapping.columns))).toBe(true);
  });
});

describe.each(CASES)('Program_N.%s mapping', (legacyTable, mapping, definition) => {
  it('targets its schema-qualified unit table, keyed, folded and tenanted as table ownership declares', () => {
    const { table, target } = ownedEntry(mapping);

    expect(mapping.targetTable).toBe(`timesheets.${definition.table}`);
    expect(mapping.unit).toBe(definition.unit);
    expect(mapping.key).toStrictEqual(target.keyColumns);
    expect(mapping.key).toStrictEqual(definition.key);
    expect(mapping.keyless).toBe(table.rowIdentity === 'multiset');
    expect(mapping.fold).toBe('Program');
    expect(table.programFold).toBe(true);
    expect(mapping.tenant).toStrictEqual({ kind: 'program' });
    expect(table.tenantResolution).toBe('program_site');
    expect(target.columnPolicy).toBe('whole-table');
  });

  it('lists the fixture columns in catalog order and the target columns of its table definition after tenant_id', () => {
    expect(mapping.legacyColumns.map((column) => column.name)).toStrictEqual(ownedEntry(mapping).table.columns);
    expect(mapping.targetColumns).toStrictEqual(definition.columns.filter((column) => column.name !== 'tenant_id'));
    expect(mapping.targetColumns.at(-1)).toStrictEqual({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
  });

  it('names the bare table each Program_<id> schema qualifies', () => {
    expect(parseProgramTable(programTableName(2, legacyTable))).toStrictEqual({ programId: 2, table: legacyTable });
    expect(parseProgramTable(`[Program_1].[${legacyTable}]`)?.table).toBe(mapping.legacyTable);
  });

  it('keeps a sample row byte-exact through its target row, NULL included, recording its program', () => {
    const row = sampleRow(mapping);
    const encoding = encodeRow(mapping.legacyColumns, row);
    const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding), { legacyProgramId: 2 });
    const nullable = mapping.columns.find((column) => column.legacy === NULLABLE[legacyTable]);

    expect(Object.keys(target)).toStrictEqual(mapping.targetColumns.map((column) => column.name));
    expect(target[LEGACY_PROGRAM_ID_COLUMN]).toBe('2');
    expect(nullable === undefined ? undefined : target[nullable.target]).toBeNull();
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
  });

  it.each([undefined, -1, 1.5])('rejects a folded row with legacyProgramId %j', (legacyProgramId) => {
    const row = sampleRow(mapping);
    const values = mapping.decodeLegacy(mapping.legacyColumns, encodeRow(mapping.legacyColumns, row));

    expect(() => mapping.toTarget(values, { legacyProgramId })).toThrow(MappingError);
  });

  it.each<[number | undefined, string, boolean]>([
    [1, 'tenant-a', false],
    [2, 'tenant-b', false],
    [3, DEFAULT_UMBRELLA_SITE_ID, true],
    [undefined, DEFAULT_UMBRELLA_SITE_ID, true],
  ])('resolves the tenant of a Program_%s row from synthetic.program_site as %s', (legacyProgramId, siteId, orphan) => {
    const row = { ...sampleRow(mapping), siteID: 'tenant-b' };

    expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS, { legacyProgramId })).toStrictEqual({
      tenantId: tenantIdForSite(siteId),
      siteId,
      orphan,
    });
  });
});

describe('timesheet_day values', () => {
  it('stores hours at scale 4 and datetimes as pg timestamp text', () => {
    const target = timesheetDayMapping.toTarget(
      timesheetDayMapping.decodeLegacy(
        timesheetDayMapping.legacyColumns,
        encodeRow(timesheetDayMapping.legacyColumns, {
          day_id: 'D1',
          timesheet_id: 'S1',
          work_date: new Date(2026, 5, 29),
          hours: '7.5000',
          state: 'DRAFT',
          lastUpdate: new Date(2026, 5, 30, 9, 15, 0, 997),
          lastUpdateByID: null,
        }),
      ),
      { legacyProgramId: 1 },
    );

    expect(target).toStrictEqual({
      day_id: 'D1',
      timesheet_id: 'S1',
      work_date: '2026-06-29 00:00:00.000',
      hours: '7.5000',
      state: 'DRAFT',
      lastupdate: '2026-06-30 09:15:00.997',
      lastupdatebyid: null,
      legacy_program_id: '1',
    });
  });
});
