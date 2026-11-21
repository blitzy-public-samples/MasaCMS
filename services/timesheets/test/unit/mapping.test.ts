// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The timesheets mappings barrel against table ownership, the fixture and target DDL, the Program_<id> fold, the canonical encoding and migration applies of the split shares. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  LEGACY_PROGRAM_ID_COLUMN,
  canonicalTypeForPostgres,
  canonicalTypeForSqlServer,
  decodeRow,
  diffCoverage,
  encodeRow,
  encodeValue,
  mappingCoverage,
  parseProgramTable,
  programTableName,
  resolveTenant,
  type ApplyRequest,
  type ApplyResponse,
  type CanonicalColumn,
  type CanonicalValue,
  type Mapping,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, type TenantFixture } from '@opt2/platform/testing';
import {
  PROGRAM_SITES,
  approvalActionMapping,
  blackoutMapping,
  mappings,
  tclassextendMapping,
  tclassextendattributesMapping,
  tclassextenddataMapping,
  tclassextendrcsetsMapping,
  tclassextendsetsMapping,
  timesheetDayMapping,
  timesheetMapping,
  trashMapping,
  units,
} from '../../src/migration/mappings/index.js';
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
  TIMESHEETS_UNITS,
  TRASH,
} from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TableName, type TestApp } from '../helpers/app.js';
import { approvalActionRow, blackoutRow, dayRow, timesheetRow } from '../helpers/days.js';

interface OwnershipTarget {
  unit: string;
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
  rowPredicate?: string;
}

interface OwnershipTable {
  table: string;
  columns?: string[];
  programFold?: boolean | null;
  programSchemas?: string[];
  split?: { by: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: OwnershipTable[];
}

/** A row as the repository returns it, with the tenant and program the fold gave it. */
type TargetRow = Readonly<Record<string, unknown>> & { tenant_id: string; legacy_program_id: number };

/** Contents of a repository file, by its path from the repository root. */
function repoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
}

/** Body lines of each `CREATE TABLE` that `pattern` matches in `sql`, keyed by the table name it captures. */
function createTableBodies(sql: string, pattern: RegExp): Map<string, string[]> {
  return new Map([...sql.matchAll(pattern)].map((match): [string, string[]] => [match[1] ?? '', (match[2] ?? '').split('\n')]));
}

const OWNERSHIP = JSON.parse(repoFile('opt2/table-ownership.json')) as Ownership;
const FIXTURE_DDL = createTableBodies(
  repoFile('legacy-fixtures/sql/timesheets/110_tables.program.sql'),
  /CREATE TABLE \[\$\(PROGRAM_SCHEMA\)\]\.\[(\w+)\] \(\n([\s\S]*?)\n\s*\) ON /g,
);
const TARGET_DDL = createTableBodies(
  ['0001_timesheets.sql', '0002_extensions.sql'].map((file) => repoFile(`services/timesheets/db/migrations/${file}`)).join('\n'),
  /CREATE TABLE (timesheets\.\w+) \(\n([\s\S]*?)\n\);/g,
);
const PROGRAM_SITE_ROWS = Object.fromEntries(
  [...repoFile('legacy-fixtures/sql/010_program_site.sql').matchAll(/\((\d+), N'([^']+)'\)/g)].map((match) => [Number(match[1]), match[2]]),
);

/** The legacy table a folded `Program_N.<table>` ownership entry names without its schema. */
function legacyTableOf(entry: OwnershipTable): string {
  return entry.programFold === true ? entry.table.slice(entry.table.indexOf('.') + 1) : entry.table;
}

const OWNED = OWNERSHIP.tables.flatMap((entry) =>
  (entry.targets ?? []).filter((target) => target.unit.startsWith('timesheets.')).map((target) => ({ entry, target })),
);

/** The values a split target's row predicate selects: a `baseTable in (...)` list, or the owner of `classMap owner = <owner>`. */
function predicateValues(rowPredicate: string | undefined): string[] {
  const list = /^\w+ in \((.*)\)$/.exec(rowPredicate ?? '')?.[1];
  if (list !== undefined) return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
  const owner = /^classMap owner = (\S+)$/.exec(rowPredicate ?? '')?.[1];
  if (owner !== undefined) return [owner];
  throw new Error(`unreadable row predicate ${String(rowPredicate)}`);
}

/** The key `mappingCoverage` files a target under: its legacy table, suffixed `{<by>=<values>}` for a split table. */
function coverageKeyOf(entry: OwnershipTable, target: OwnershipTarget): string {
  if (entry.split === undefined) return legacyTableOf(entry);
  return `${entry.table}{${entry.split.by}=${predicateValues(target.rowPredicate).join(',')}}`;
}

/** Legacy columns table ownership assigns to timesheets, per coverage key, in the shape `diffCoverage` compares. */
const EXPECTED: Record<string, string[]> = {};
for (const { entry, target } of OWNED) {
  const owned = target.columnPolicy === 'whole-table' ? (entry.columns ?? target.ownedColumns) : target.ownedColumns;
  EXPECTED[coverageKeyOf(entry, target)] = [...(EXPECTED[coverageKeyOf(entry, target)] ?? []), ...owned];
}

/** `body` of a `CREATE TABLE` named `table`; throws when the DDL declares no such table. */
function bodyOf(bodies: ReadonlyMap<string, string[]>, table: string): string[] {
  const body = bodies.get(table);
  if (body === undefined) throw new Error(`the DDL declares no table ${table}`);
  return body;
}

/** Columns of fixture table `Program_<id>.<table>` in catalog order, typed as `canonicalTypeForSqlServer` reads them. */
function fixtureColumns(table: string): CanonicalColumn[] {
  return bodyOf(FIXTURE_DDL, table).flatMap((line) => {
    const match = /^\s*\[(\w+)\]\s+(\[\w+\](?:\s*\([^)]*\))?)/.exec(line);
    return match === null ? [] : [{ name: match[1] ?? '', ...canonicalTypeForSqlServer(match[2] ?? '') }];
  });
}

/** Columns of target table `table` in catalog order, typed as `canonicalTypeForPostgres` reads them. */
function targetDdlColumns(table: string): CanonicalColumn[] {
  return bodyOf(TARGET_DDL, table).flatMap((line) => {
    const match = /^\s+(\w+)\s+(.+?)(?:\s+(?:NOT NULL|NULL|DEFAULT)\b.*)?,?$/.exec(line);
    if (match === null || /^(?:PRIMARY|UNIQUE|CONSTRAINT|CHECK)$/.test(match[1] ?? '')) return [];
    return [{ name: match[1] ?? '', ...canonicalTypeForPostgres(match[2] ?? '') }];
  });
}

/** The tenant source `mapping` declares; throws when it declares none. */
function tenantSourceOf(mapping: Mapping): TenantSource {
  if (mapping.tenant === undefined) throw new Error(`${mapping.legacyTable} declares no tenant source`);
  return mapping.tenant;
}

/** Tenant lookups answered from `PROGRAM_SITES`, as `synthetic.program_site` holds them. */
const LOOKUPS: TenantLookups = { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID, programSiteId: (programId) => PROGRAM_SITES[programId] };

const PROGRAMS: readonly (readonly [number, string, TenantFixture])[] = [
  [1, TENANT_A.siteId, TENANT_A],
  [2, TENANT_B.siteId, TENANT_B],
];

const SHEET_ID = 'A1B2C3D4-E5F6-4A0B-8C9D0E1F2A3B4C5D';
const DAY_ID = 'B2C3D4E5-F6A7-4B1C-9D0E1F2A3B4C5D6E';
const PERSON_ID = 'C3D4E5F6-A7B8-4C2D-0E1F2A3B4C5D6E7F';
const APPROVER_ID = 'D4E5F6A7-B8C9-4D3E-1F2A3B4C5D6E7F80';

/** Each mapping with its fixture column count and a legacy row in canonical value form. */
const CASES: readonly { table: string; mapping: Mapping; columnCount: number; row: Readonly<Record<string, CanonicalValue>> }[] = [
  {
    table: 'timesheet',
    mapping: timesheetMapping,
    columnCount: 9,
    row: {
      timesheet_id: SHEET_ID,
      person_id: PERSON_ID,
      siteID: 'tenant-a',
      period_start: '2026-06-08T00:00:00.000',
      period_end: '2026-06-21T00:00:00.000',
      due_date: '2026-06-26T00:00:00.000',
      created: '2026-06-08T09:15:00.997',
      lastUpdate: null,
      lastUpdateByID: null,
    },
  },
  {
    table: 'timesheet_day',
    mapping: timesheetDayMapping,
    columnCount: 7,
    row: {
      day_id: DAY_ID,
      timesheet_id: SHEET_ID,
      work_date: '2026-06-15T00:00:00.000',
      hours: '7.5000',
      state: 'SUBMITTED',
      lastUpdate: '2026-06-15T17:30:00.003',
      lastUpdateByID: PERSON_ID,
    },
  },
  {
    table: 'approval_action',
    mapping: approvalActionMapping,
    columnCount: 9,
    row: {
      action_id: 'E5F6A7B8-C9D0-4E4F-2A3B4C5D6E7F8091',
      day_id: DAY_ID,
      action: 'return',
      role: 'timesheets.primary-approver',
      from_state: 'SUBMITTED',
      to_state: 'RETURNED',
      actor_user_id: APPROVER_ID,
      comment: null,
      created: '2026-06-16T08:00:00.000',
    },
  },
  {
    table: 'blackout',
    mapping: blackoutMapping,
    columnCount: 6,
    row: {
      blackout_id: 'F6A7B8C9-D0E1-4F5A-3B4C5D6E7F8091A2',
      day_id: DAY_ID,
      person_id: PERSON_ID,
      archive_id: null,
      reason: '',
      created: '2026-06-16T08:00:00.000',
    },
  },
];

/** Mappings of the timesheets share of a Masa `dbo` table, in `TIMESHEETS_UNITS` order; none is folded. */
const SHARE_MAPPINGS: readonly Mapping[] = [
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
  trashMapping,
];

/** A driver-shaped value of `column` distinct per column position. */
function shareValue(column: CanonicalColumn, position: number): unknown {
  switch (column.type) {
    case 'i':
      return position;
    case 'f':
      return position + 0.5;
    case 't':
      return new Date(2026, 5, 10 + position, 9, 15, 0, 997);
    default:
      return `${column.name}-${String(position)}`;
  }
}

/** A legacy row of share `mapping` in canonical value form, in site `siteId`, with `overrides` applied. */
function shareRow(mapping: Mapping, siteId: string | null, overrides: Readonly<Record<string, CanonicalValue>> = {}): Record<string, CanonicalValue> {
  const raw = Object.fromEntries(mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, shareValue(column, position)]));
  return { ...decodeRow(mapping.legacyColumns, encodeRow(mapping.legacyColumns, raw)), siteID: siteId, ...overrides };
}

/** The canonical legacy row of `table` in `CASES`; throws for a table it does not list. */
function legacyRowOf(table: string): Readonly<Record<string, CanonicalValue>> {
  const found = CASES.find((entry) => entry.table === table);
  if (found === undefined) throw new Error(`no legacy row for ${table}`);
  return found.row;
}

/** pg-shaped rows of every timesheets table for one sheet of `tenant`, each with the mapping that owns its table. */
function targetRows(tenant: TenantFixture): readonly (readonly [string, Mapping, TargetRow])[] {
  const sheet = timesheetRow({ tenant });
  const day = dayRow(sheet, { workDate: '2026-06-15', hours: 7.5, state: 'SUBMITTED' });
  const action = approvalActionRow(day, {
    action: 'return',
    role: 'timesheets.primary-approver',
    from: 'SUBMITTED',
    to: 'RETURNED',
    actor: APPROVER_ID,
    comment: '',
  });
  const blackout = blackoutRow(day, { archiveId: null, personId: sheet.person_id });
  return [
    ['timesheet', timesheetMapping, sheet],
    ['timesheet_day', timesheetDayMapping, day],
    ['approval_action', approvalActionMapping, action],
    ['blackout', blackoutMapping, blackout],
  ];
}

describe('timesheets mapping coverage', () => {
  it('covers exactly the columns table-ownership assigns to timesheets', () => {
    const diff = diffCoverage(EXPECTED, mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toEqual({ missing: {}, extra: {} });
  });

  it('owns exactly the timesheets units, each recorded in table-ownership units from its legacy table', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === 'timesheets');

    expect(new Set(OWNED.map(({ target }) => target.unit))).toEqual(new Set(TIMESHEETS_UNITS));
    expect(new Set(owned.map((unit) => unit.unit))).toEqual(new Set(TIMESHEETS_UNITS));
    for (const { entry, target } of OWNED) {
      expect(owned.find((unit) => unit.unit === target.unit)?.legacyTables).toEqual([entry.table]);
    }
  });

  it('folds every Program_<id> schema table-ownership lists from a program synthetic.program_site maps', () => {
    const folded = OWNED.filter(({ entry }) => entry.programFold === true);

    expect(folded.map(({ target }) => target.unit).sort()).toStrictEqual([TIMESHEET.unit, TIMESHEET_DAY.unit, APPROVAL_ACTION.unit, BLACKOUT.unit].sort());
    for (const { entry } of folded) {
      const programs = (entry.programSchemas ?? []).map((schema) => parseProgramTable(`${schema}.${legacyTableOf(entry)}`));

      expect(entry.programFold).toBe(true);
      expect(programs).toEqual(Object.keys(PROGRAM_SITES).map((id) => ({ programId: Number(id), table: legacyTableOf(entry) })));
    }
  });
});

describe('timesheets mappings barrel', () => {
  it('exposes TIMESHEETS_UNITS as its units and one mapping per unit in that order', () => {
    const named = [timesheetMapping, timesheetDayMapping, approvalActionMapping, blackoutMapping, ...SHARE_MAPPINGS];
    const definitions = [TIMESHEET, TIMESHEET_DAY, APPROVAL_ACTION, BLACKOUT, EXTEND_SUBTYPE, EXTEND_SET, EXTEND_ATTRIBUTE, EXTEND_RC_SET, EXTEND_DATA, TRASH];

    expect(units).toEqual(TIMESHEETS_UNITS);
    expect(mappings.map((mapping) => named.indexOf(mapping))).toEqual(named.map((_mapping, index) => index));
    expect(mappings.map((mapping) => mapping.unit)).toEqual(definitions.map((definition) => definition.unit));
    expect(mappings.map((mapping) => mapping.targetTable)).toEqual([...TIMESHEETS_UNITS]);
  });

  it('maps each fixture program to the site synthetic.program_site seeds', () => {
    expect(PROGRAM_SITES).toEqual({ 1: 'tenant-a', 2: 'tenant-b' });
    expect(PROGRAM_SITE_ROWS).toEqual(PROGRAM_SITES);
    for (const [programId, siteId, tenant] of PROGRAMS) {
      expect(PROGRAM_SITES[programId]).toBe(siteId);
      expect(tenant.tenantId).toBe(tenantIdForSite(siteId));
    }
  });
});

describe.each(CASES)('Program_N.$table mapping', ({ table, mapping, columnCount, row }) => {
  it(`maps the ${String(columnCount)} fixture DDL columns in catalog order with their canonical types`, () => {
    expect(mapping.legacyTable).toBe(table);
    expect(mapping.legacyColumns).toHaveLength(columnCount);
    expect(mapping.legacyColumns).toStrictEqual(fixtureColumns(table));
  });

  it('adds only tenant_id and legacy_program_id to the mapped columns of its target DDL', () => {
    const ddl = targetDdlColumns(mapping.targetTable);
    const mapped = new Set(mapping.columns.map((column) => column.target));

    expect(ddl.filter((column) => !mapped.has(column.name)).map((column) => column.name)).toEqual(['tenant_id', LEGACY_PROGRAM_ID_COLUMN]);
    expect(ddl.filter((column) => column.name !== 'tenant_id')).toStrictEqual(mapping.targetColumns);
  });

  it.each(PROGRAMS)('folds a Program_%i row into the %s tenant with its legacy program id', (programId, siteId, tenant) => {
    const target = mapping.toTarget(row, { legacyProgramId: programId });

    expect(parseProgramTable(programTableName(programId, table))).toStrictEqual({ programId, table });
    expect(target[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(programId));
    expect(target).not.toHaveProperty('tenant_id');
    expect(resolveTenant(tenantSourceOf(mapping), row, LOOKUPS, { legacyProgramId: programId })).toStrictEqual({
      tenantId: tenant.tenantId,
      siteId,
      orphan: false,
    });
  });

  it('places a row of a program synthetic.program_site does not map under the umbrella tenant as an orphan', () => {
    expect(resolveTenant(tenantSourceOf(mapping), row, LOOKUPS, { legacyProgramId: 3 })).toStrictEqual({
      tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
      siteId: DEFAULT_UMBRELLA_SITE_ID,
      orphan: true,
    });
  });

  it('keeps the legacy row byte-identical through its target row', () => {
    const encoding = encodeRow(mapping.legacyColumns, row);
    const target = mapping.toTarget(row, { legacyProgramId: 1 });

    expect(decodeRow(mapping.legacyColumns, encoding)).toStrictEqual(row);
    expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
    expect(mapping.encodeLegacy(target)).toBe(encoding);
  });
});

describe.each(PROGRAMS)('pg-shaped rows of Program_%i (%s)', (programId, _siteId, tenant) => {
  it.each(targetRows(tenant))('reads a %s row back unchanged through its legacy encoding', (_table, mapping, row) => {
    const encoding = mapping.encodeLegacy(row);
    const back = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding), { legacyProgramId: row.legacy_program_id });

    expect([row.tenant_id, row.legacy_program_id]).toEqual([tenant.tenantId, programId]);
    expect(back[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(programId));
    expect(mapping.encodeLegacy(back)).toBe(encoding);
  });
});

describe('timesheets canonical value forms', () => {
  const dayRowOf = (hours: CanonicalValue): Readonly<Record<string, CanonicalValue>> => ({ ...legacyRowOf('timesheet_day'), hours });

  it('encodes timesheet_day hours as a d value of scale 4', () => {
    const hours = timesheetDayMapping.legacyColumns.find((column) => column.name === 'hours');

    expect(hours).toStrictEqual({ name: 'hours', type: 'd', scale: 4 });
    expect(encodeValue('d', '7.5000', { scale: 4 })).toBe('d6:7.5000');
    expect(encodeValue('d', 7.5, { scale: 4 })).toBe('d6:7.5000');
    expect(encodeRow(timesheetDayMapping.legacyColumns, dayRowOf('7.5000'))).toContain('d6:7.5000');
    expect(timesheetDayMapping.toTarget(dayRowOf('7.5'), { legacyProgramId: 1 })['hours']).toBe('7.5000');
  });

  it('encodes a NULL and an empty string differently', () => {
    const columns = approvalActionMapping.legacyColumns;
    const nullComment = legacyRowOf('approval_action');
    const emptyComment = { ...nullComment, comment: '' };

    expect([encodeValue('s', null), encodeValue('s', '')]).toEqual(['N', 's0:']);
    expect(encodeRow(columns, emptyComment)).not.toBe(encodeRow(columns, nullComment));
    expect(decodeRow(columns, encodeRow(columns, emptyComment))['comment']).toBe('');
    expect(decodeRow(columns, encodeRow(columns, nullComment))['comment']).toBeNull();
  });
});

describe.each(SHARE_MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))('%s share mapping', (_legacyTable, mapping) => {
  it('adds only tenant_id to the mapped columns of its target DDL', () => {
    const ddl = targetDdlColumns(mapping.targetTable);
    const mapped = new Set(mapping.columns.map((column) => column.target));

    expect(ddl.filter((column) => !mapped.has(column.name)).map((column) => column.name)).toEqual(['tenant_id']);
    expect(ddl.filter((column) => column.name !== 'tenant_id')).toStrictEqual(mapping.targetColumns);
  });

  it.each([TENANT_A, TENANT_B])('places a row of site $siteId in its own tenant from siteID, unfolded whatever program id it is given', (tenant) => {
    const row = shareRow(mapping, tenant.siteId);

    expect(mapping.fold).toBeUndefined();
    expect(mapping.toTarget(row, { legacyProgramId: 1 })).toStrictEqual(mapping.toTarget(row));
    expect(mapping.toTarget(row)).not.toHaveProperty(LEGACY_PROGRAM_ID_COLUMN);
    expect(resolveTenant(tenantSourceOf(mapping), row, LOOKUPS, { legacyProgramId: 1 })).toStrictEqual({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      orphan: false,
    });
  });

  it.each([null, ''])('places a row with siteID %j under the umbrella tenant as an orphan', (siteId) => {
    expect(resolveTenant(tenantSourceOf(mapping), shareRow(mapping, siteId), LOOKUPS)).toStrictEqual({
      tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
      siteId: DEFAULT_UMBRELLA_SITE_ID,
      orphan: true,
    });
  });
});

describe('migration applies of the timesheets split shares', () => {
  const APPLY_URL = '/internal/v1/migration/apply';
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** A tenant-a row of `mapping` keyed `key`, carrying `value` in its split column, else as its apply-row discriminator. */
  function splitRow(mapping: Mapping, keyColumn: string, key: string, value: string): ApplyRequest['rows'][number] {
    const column = mapping.split?.column;
    const row = shareRow(mapping, TENANT_A.siteId, column === undefined ? { [keyColumn]: key } : { [keyColumn]: key, [column]: value });
    return { op: 'upsert', row: encodeRow(mapping.legacyColumns, row), ...(column === undefined ? { discriminator: value } : {}) };
  }

  it.each<[string, string, string, Extract<TableName, 'extend_subtype' | 'extend_set' | 'trash'>, Mapping, string]>([
    ['tclassextend', 'Program_1.timesheet', 'custom', 'extend_subtype', tclassextendMapping, 'subTypeID'],
    ['tclassextendsets', 'Program_1.timesheet', 'custom', 'extend_set', tclassextendsetsMapping, 'extendSetID'],
    ['ttrash', 'timesheets', 'people', 'trash', trashMapping, 'objectID'],
  ])('lands the %s row of %s, not that of %s, in timesheets.%s', async (legacyTable, owned, other, table, mapping, keyColumn) => {
    const [ownedKey, otherKey] = [cfUuid(), cfUuid()];
    const body: ApplyRequest = {
      batchId: `share-${legacyTable}`,
      origin: 'backfill',
      legacyTable,
      tenantId: TENANT_A.tenantId,
      columns: mapping.legacyColumns,
      rows: [splitRow(mapping, keyColumn, ownedKey, owned), splitRow(mapping, keyColumn, otherKey, other)],
    };

    const res = await t.app.inject({ method: 'POST', url: APPLY_URL, headers: await headersFor('service:migration', { csrf: false }), payload: body });

    expect([res.statusCode, res.json<ApplyResponse>()]).toStrictEqual([200, { batchId: body.batchId, duplicate: false, applied: 1, skipped: 1 }]);
    expect(t.db.rowsOf(table, TENANT_A.tenantId).map((row) => row[keyColumn.toLowerCase()])).toStrictEqual([ownedKey]);
  });
});
