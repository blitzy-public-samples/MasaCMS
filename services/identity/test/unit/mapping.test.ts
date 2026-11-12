/** Identity's mappings against table ownership: column coverage, the tusers Type split, units, legacy types, canonical round trips and row tenants. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  canonicalTypeForSqlServer,
  decodeRow,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  resolveTenant,
  type CanonicalColumn,
  type CanonicalValue,
  type Mapping,
  type MappingColumn,
  type SplitRule,
  type TenantLookups,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  mappings,
  tclassextenddatauseractivityGroupMapping,
  toauthclientsMapping,
  toauthtokensMapping,
  tpermissionsMapping,
  tredirectsMapping,
  ttrashGroupMapping,
  tuseraddressesGroupMapping,
  tuserdeviceMapping,
  tuserremotesessionsMapping,
  tusersCredentialMapping,
  tusersfavoritesGroupMapping,
  tusersGroupAccountMapping,
  tusersinterestsGroupMapping,
  tusersLoginStateMapping,
  tusersmembMapping,
  tuserstagsGroupMapping,
  tuserstrikesMapping,
  tusersUserAccountMapping,
} from '../../src/migration/mappings/index.js';
import { IDENTITY_UNITS, OWNED_TABLES, UNIT_TABLES } from '../../src/repo/tables.js';

const OWNER = 'identity';
const SITE_ID = 'tenant-a';
const PARENT_SITE_ID = 'tenant-b';
const REPO_ROOT = new URL('../../../../', import.meta.url);

interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  origin: string;
  source: { path: string; lines: [number, number] };
  columns: string[];
  siteIdColumn: string | null;
  serializedDocumentColumns: string[];
  split?: { by: string; parent?: { table: string; join: string } };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

/** An identity target of table ownership with its legacy table and the key `mappingCoverage` files it under. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
  coverageKey: string;
}

/** One column of a legacy CREATE TABLE statement: name, lower-cased base type and declared length. */
interface DdlColumn {
  name: string;
  type: string;
  length: number | null;
}

/** A driver-shaped legacy sample row, the canonical values it decodes to, and its NULL and empty-string columns. */
interface SampleRow {
  row: Record<string, unknown>;
  canonical: Record<string, CanonicalValue>;
  nulls: MappingColumn[];
  empties: MappingColumn[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const TABLES: ReadonlyMap<string, OwnershipTable> = new Map(OWNERSHIP.tables.map((table) => [table.table, table]));

// Ownership names the tusers split `Type+column` and the group-child splits `ownerType`; both select rows by a tusers Type.
const SPLIT_BY: Readonly<Record<string, SplitRule['by']>> = { 'Type+column': 'Type', ownerType: 'Type', objectClass: 'objectClass' };

/** The ownership entry of a legacy table. */
function tableNamed(name: string): OwnershipTable {
  const table = TABLES.get(name);
  if (table === undefined) throw new Error(`table ownership has no ${name}`);
  return table;
}

/** `<table>`, or `<table>{<by>=<value>}` for a split target, the value taken from its row predicate. */
function coverageKeyOf(table: OwnershipTable, target: OwnershipTarget): string {
  if (target.rowPredicate === null) return table.table;
  const by = SPLIT_BY[table.split?.by ?? ''];
  const value = /=\s*(\S+)$/.exec(target.rowPredicate)?.[1];
  if (by === undefined || value === undefined) throw new Error(`${table.table}: unreadable split of ${target.unit}`);
  return `${table.table}{${by}=${value}}`;
}

const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? [])
    .filter((target) => target.unit.startsWith(`${OWNER}.`))
    .map((target) => ({ table, target, coverageKey: coverageKeyOf(table, target) })),
);

/** Legacy columns table ownership assigns to identity per coverage key; a whole-table target owns every live column. */
function expectedCoverage(): Record<string, string[]> {
  const expected: Record<string, string[]> = {};
  for (const { table, target, coverageKey } of OWNED_TARGETS) {
    const owned = target.columnPolicy === 'whole-table' ? table.columns : [...target.keyColumns, ...target.ownedColumns];
    expected[coverageKey] = [...new Set([...(expected[coverageKey] ?? []), ...owned])];
  }
  return expected;
}

const DDL_COLUMN = /^\s*\[(\w+)\]\s*\[(\w+)\]\s*(?:\(\s*(\d+|max)\s*\))?/i;
const DDL_CACHE = new Map<string, DdlColumn[]>();

/** Columns of the CREATE TABLE at a bootstrap or migration table's ownership source; ORM-only tables have none. */
function ddlColumns(table: OwnershipTable): DdlColumn[] {
  if (table.origin !== 'bootstrap' && table.origin !== 'migration') return [];
  const cached = DDL_CACHE.get(table.table);
  if (cached !== undefined) return cached;
  const [first, last] = table.source.lines;
  const lines = readFileSync(new URL(table.source.path, REPO_ROOT), 'utf8').split(/\r?\n/).slice(first - 1, last);
  const columns = lines.flatMap((line): DdlColumn[] => {
    const match = DDL_COLUMN.exec(line);
    if (match === null) return [];
    const [, name = '', type = '', length] = match;
    return [{ name, type: type.toLowerCase(), length: length === undefined || length.toLowerCase() === 'max' ? null : Number(length) }];
  });
  DDL_CACHE.set(table.table, columns);
  return columns;
}

// CF-format ids, 35 characters as their char(35) columns hold them, of the tusers and toauthclients rows samples reference.
const GROUP_ID = '4D2B9E10-3A6C-4B7D-9E8F0A1B2C3D4E5F';
const USER_ID = '7E3C1A20-5B4D-4F6E-8A9B0C1D2E3F4A5B';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const CLIENT_ID = 'C0FFEE00-1A2B-4C3D-8E9F0A1B2C3D4E5F';
const USERNAME = 'qa_editor';

const TUSERS_TYPES: ReadonlyMap<string, number> = new Map([
  [GROUP_ID, 1],
  [USER_ID, 2],
]);

// Parent rows by `<table>.<column>` value, every one of them in PARENT_SITE_ID; PARENT_VALUE is the one a sample child references.
const PARENT_ROWS: Readonly<Record<string, readonly string[]>> = {
  'tusers.UserID': [GROUP_ID, USER_ID],
  'tusers.UserName': [USERNAME],
  'toauthclients.clientid': [CLIENT_ID],
};
const PARENT_VALUE: Readonly<Record<string, string>> = {
  'tusers.UserID': USER_ID,
  'tusers.UserName': USERNAME,
  'toauthclients.clientid': CLIENT_ID,
};

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
  parentSiteId: (parentLegacyTable, parentKey) =>
    Object.entries(parentKey).every(([column, value]) => PARENT_ROWS[`${parentLegacyTable}.${column}`]?.includes(String(value)) === true)
      ? PARENT_SITE_ID
      : null,
};

/** The child column joining a group-child table to its owning tusers row, read from the ownership split. */
function ownerColumn(table: OwnershipTable): string {
  const column = /^\w+\.(\w+) = tusers\.UserID$/.exec(table.split?.parent?.join ?? '')?.[1];
  if (table.split?.by !== 'ownerType' || column === undefined) throw new Error(`${table.table}: no owner join`);
  return column;
}

/** The Type of the tusers row owning a child row, as the orchestrator sends it; null when no owner row exists. */
function ownerTypeOf(column: string, row: Readonly<Record<string, unknown>>): number | null {
  return TUSERS_TYPES.get(String(row[column])) ?? null;
}

/** The value a split rule accepts. */
function ownedValue(split: SplitRule): string | number | undefined {
  return typeof split.value === 'object' ? split.value[0] : split.value;
}

/** The apply-row discriminator of a split mapping without a discriminator column: its owner's Type, else its split value. */
function discriminatorOf(mapping: Mapping, row: Readonly<Record<string, unknown>>): string | number | null | undefined {
  const split = mapping.split;
  if (split === undefined || split.column !== undefined) return undefined;
  const table = tableNamed(mapping.legacyTable);
  return table.split?.by === 'ownerType' ? ownerTypeOf(ownerColumn(table), row) : ownedValue(split);
}

// NULL and empty-string columns of each unit's sample; every NULL column is nullable in the legacy catalog.
const NULL_AND_EMPTY: Readonly<Record<string, readonly [nulls: readonly string[], empties: readonly string[]]>> = {
  'identity.group_account': [['Fname'], ['Lname']],
  'identity.user_account': [['remoteID'], ['tablist']],
  'identity.credential': [['PasswordCreated'], ['Password']],
  'identity.login_state': [['LastLogin'], []],
  'identity.membership': [[], []],
  'identity.permission': [[], []],
  'identity.user_address': [['address2'], ['addressName']],
  'identity.user_interest': [[], []],
  'identity.user_tag': [['tag'], []],
  'identity.user_favorite': [['columnNumber'], ['favoriteName']],
  'identity.extend_data_user_activity': [['remoteID'], ['attributeValue']],
  'identity.user_strike': [['lastAttempt'], []],
  'identity.remote_session': [[], []],
  'identity.user_device': [['lastLogin'], []],
  'identity.redirect': [['userid'], ['URL']],
  'identity.oauth_client': [['description'], ['redirecturl']],
  'identity.oauth_token': [['accessCode'], []],
  'identity.trash': [['deleteid'], ['deletedBy']],
};

const SESSION_DOCUMENT = readFileSync(new URL('../fixtures/legacy/oauth-token-data.json', import.meta.url), 'utf8');
const TRASH_DOCUMENT =
  "<wddxPacket version='1.0'><header/><data><struct type='coldfusion.runtime.Struct'>" +
  `<var name='USERID'><string>${GROUP_ID}</string></var><var name='GROUPNAME'><string>Editors: QA</string></var>` +
  '</struct></data></wddxPacket>';

// Serialized documents held byte-exact; tuserremotesessions.data holds session JSON though ownership does not list it.
const DOCUMENTS: Readonly<Record<string, string>> = {
  'toauthtokens.data': SESSION_DOCUMENT,
  'tuserremotesessions.data': SESSION_DOCUMENT,
  'ttrash.objectstring': TRASH_DOCUMENT,
};

// 23:59:59.999 rounds up past midnight and the month end to SQL Server's next 1/300 s tick.
const BOUNDARY_TIMESTAMP: readonly [Date, string] = [new Date(2026, 5, 30, 23, 59, 59, 999), '2026-07-01T00:00:00.000'];

/** Fixed values of a sample's split, site, parent and owner columns, mapped or not. */
function linkValues(mapping: Mapping, table: OwnershipTable): Record<string, string | number> {
  const links: Record<string, string | number> = {};
  const splitValue = mapping.split === undefined ? undefined : ownedValue(mapping.split);
  if (mapping.split?.column !== undefined && splitValue !== undefined) links[mapping.split.column] = splitValue;
  if (mapping.tenant?.kind === 'site') links[mapping.tenant.column] = SITE_ID;
  if (mapping.tenant?.kind === 'parent') {
    for (const [child, parent] of Object.entries(mapping.tenant.columns)) {
      links[child] = PARENT_VALUE[`${mapping.tenant.parentLegacyTable}.${parent}`] ?? UNKNOWN_ID;
    }
  }
  if (table.split?.by === 'ownerType') links[ownerColumn(table)] = GROUP_ID;
  return links;
}

/** Raw and canonical sample of a column without a fixed value; `timestamp` 0 marks the row's first timestamp, which takes the tick boundary. */
function freeSample(column: CanonicalColumn, position: number, ddl: DdlColumn | undefined, timestamp: number): [unknown, CanonicalValue] {
  switch (column.type) {
    case 's': {
      // Text carries ':', a control character, CRLF, non-ASCII and a trailing space; char(n) text is space-padded ASCII.
      const text = ddl?.type === 'char' && ddl.length !== null
        ? `${column.name}:\u0001${String(position)}`.padEnd(ddl.length, ' ')
        : `${column.name}:\u0001ü\r\n${String(position)} `;
      return [text, text];
    }
    case 'i':
      return [position + 1, String(position + 1)];
    case 'f':
      return [-(position + 0.1), String(-(position + 0.1))];
    case 't': {
      if (timestamp === 0) return [BOUNDARY_TIMESTAMP[0], BOUNDARY_TIMESTAMP[1]];
      const minute = String(position % 60).padStart(2, '0');
      return [new Date(2026, 5, 30, 10, position % 60, 30, 2), `2026-06-30T10:${minute}:30.003`];
    }
    default:
      throw new Error(`no ${column.type} sample: identity maps no such legacy column`);
  }
}

/** The mapped columns named in `names`. */
function columnsNamed(mapping: Mapping, names: readonly string[]): MappingColumn[] {
  return names.map((name) => {
    const column = mapping.columns.find((candidate) => candidate.legacy === name);
    if (column === undefined) throw new Error(`${mapping.unit} maps no ${name}`);
    return column;
  });
}

/** A legacy row of a mapping with every mapped column set, in site tenant-a or owned by a PARENT_SITE_ID parent. */
function sampleRow(mapping: Mapping): SampleRow {
  const table = tableNamed(mapping.legacyTable);
  const ddl = new Map(ddlColumns(table).map((column) => [column.name.toLowerCase(), column]));
  const declared = NULL_AND_EMPTY[mapping.unit];
  if (declared === undefined) throw new Error(`${mapping.unit}: no NULL and empty sample columns declared`);
  const [nullNames, emptyNames] = declared;
  const links = linkValues(mapping, table);
  const row: Record<string, unknown> = {};
  const canonical: Record<string, CanonicalValue> = {};
  let timestamps = 0;
  mapping.legacyColumns.forEach((column, position) => {
    const link = links[column.name];
    const document = DOCUMENTS[`${table.table}.${column.name}`];
    if (table.serializedDocumentColumns.includes(column.name) && document === undefined) {
      throw new Error(`${table.table}.${column.name}: no serialized document sample`);
    }
    let sample: [unknown, CanonicalValue];
    if (nullNames.includes(column.name)) sample = [null, null];
    else if (emptyNames.includes(column.name)) sample = ['', ''];
    else if (link !== undefined) sample = [link, String(link)];
    else if (document !== undefined) sample = [document, document];
    else sample = freeSample(column, position, ddl.get(column.name.toLowerCase()), column.type === 't' ? timestamps++ : -1);
    [row[column.name], canonical[column.name]] = sample;
  });
  for (const [name, value] of Object.entries(links)) if (!(name in row)) row[name] = value;
  return { row, canonical, nulls: columnsNamed(mapping, nullNames), empties: columnsNamed(mapping, emptyNames) };
}

const CASES = mappings.map((mapping) => [mapping.unit, mapping] as const);

const SINGLE_MAPPINGS: ReadonlyArray<readonly [string, Mapping]> = [
  ['tusersmemb', tusersmembMapping],
  ['tpermissions', tpermissionsMapping],
  ['tuserstrikes', tuserstrikesMapping],
  ['tuserremotesessions', tuserremotesessionsMapping],
  ['tuserdevice', tuserdeviceMapping],
  ['tredirects', tredirectsMapping],
  ['toauthclients', toauthclientsMapping],
  ['toauthtokens', toauthtokensMapping],
  ['ttrash', ttrashGroupMapping],
];

const GROUP_CHILD_MAPPINGS: ReadonlyArray<readonly [string, Mapping]> = [
  ['tuseraddresses', tuseraddressesGroupMapping],
  ['tusersinterests', tusersinterestsGroupMapping],
  ['tuserstags', tuserstagsGroupMapping],
  ['tusersfavorites', tusersfavoritesGroupMapping],
  ['tclassextenddatauseractivity', tclassextenddatauseractivityGroupMapping],
];

const TYPE2_COLUMNS: ReadonlyArray<readonly [string, Mapping, readonly string[]]> = [
  [
    tusersUserAccountMapping.unit,
    tusersUserAccountMapping,
    ['UserID', 'SiteID', 'Type', 'UserName', 'Admin', 'S2', 'Perm', 'InActive', 'isPublic', 'remoteID', 'tablist'],
  ],
  [tusersCredentialMapping.unit, tusersCredentialMapping, ['UserID', 'Password', 'PasswordCreated']],
  [tusersLoginStateMapping.unit, tusersLoginStateMapping, ['UserID', 'LastLogin']],
];

describe('identity mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to identity', () => {
    const diff = diffCoverage(expectedCoverage(), mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('maps all 37 bootstrap tusers columns and the live tablist onto identity.group_account for Type=1 rows', () => {
    const bootstrap = ddlColumns(tableNamed('tusers')).map((column) => column.name);

    expect(bootstrap).toHaveLength(37);
    expect(tusersGroupAccountMapping.columns.map((column) => column.legacy)).toStrictEqual([...bootstrap, 'tablist']);
    expect(tusersGroupAccountMapping.split).toStrictEqual({ by: 'Type', value: 1, column: 'Type' });
  });

  it.each(TYPE2_COLUMNS)('maps only the account columns of Type=2 tusers rows onto %s', (_unit, mapping, columns) => {
    expect(mapping.columns.map((column) => column.legacy).sort()).toStrictEqual([...columns].sort());
    expect(mapping.split).toStrictEqual({ by: 'Type', value: 2, column: 'Type' });
  });

  it('assigns each live tusers column of a Type=2 row to exactly one of identity and people.person', () => {
    const tusers = tableNamed('tusers');
    const identity = mappingCoverage(mappings)['tusers{Type=2}'] ?? [];
    const person = tusers.targets?.find((target) => target.unit === 'people.person')?.ownedColumns ?? [];

    expect(person).toEqual(expect.arrayContaining(['Fname', 'Lname', 'Email', 'Company']));
    expect(identity.filter((column) => person.includes(column))).toStrictEqual([]);
    expect([...identity, ...person].sort()).toStrictEqual([...tusers.columns].sort());
  });

  it.each([...SINGLE_MAPPINGS, ...GROUP_CHILD_MAPPINGS])('maps %s through exactly one identity mapping', (legacyTable, mapping) => {
    const found = mappings.filter((candidate) => candidate.legacyTable === legacyTable);

    expect(found).toHaveLength(1);
    expect(found[0]).toBe(mapping);
  });

  it('treats as group children exactly the tables ownership splits by owner Type', () => {
    const splitByOwner = OWNED_TARGETS.filter(({ table }) => table.split?.by === 'ownerType').map(({ table }) => table.table);

    expect(splitByOwner.sort()).toStrictEqual(GROUP_CHILD_MAPPINGS.map(([legacyTable]) => legacyTable).sort());
  });

  it.each(GROUP_CHILD_MAPPINGS)('accepts a %s row only when its owning tusers row has Type=1', (legacyTable, mapping) => {
    const column = ownerColumn(tableNamed(legacyTable));
    const answers = [GROUP_ID, USER_ID, UNKNOWN_ID].map((owner) => {
      const row = { ...sampleRow(mapping).row, [column]: owner };
      return mapping.acceptsRow(row, ownerTypeOf(column, row));
    });

    expect(answers).toStrictEqual([true, false, false]);
  });
});

describe('identity units', () => {
  it('declares exactly the units table ownership gives identity', () => {
    const owned = OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit);

    expect([...IDENTITY_UNITS].sort()).toStrictEqual(owned.sort());
  });

  it('maps onto identity units only, one mapping per unit table', () => {
    const units: readonly string[] = IDENTITY_UNITS;

    expect(mappings.map((mapping) => mapping.unit).filter((unit) => !units.includes(unit))).toStrictEqual([]);
    expect(OWNED_TABLES.filter((table) => table.unit !== undefined)).toStrictEqual([...UNIT_TABLES]);
    expect(UNIT_TABLES.map((table) => mappings.filter((mapping) => mapping.unit === table.unit && mapping.targetTable === `${OWNER}.${table.table}`).length))
      .toStrictEqual(UNIT_TABLES.map(() => 1));
  });

  it('maps none of the identity tables without a unit', () => {
    const nonUnit = OWNED_TABLES.filter((table) => table.unit === undefined).map((table) => `${OWNER}.${table.table}`);

    expect(nonUnit).toStrictEqual(['identity.session', 'identity.csrf_claim', 'identity.account_operation', 'identity.person_contact', 'identity.aggregate_version']);
    expect(mappings.filter((mapping) => nonUnit.includes(mapping.targetTable) || nonUnit.includes(mapping.unit))).toStrictEqual([]);
  });
});

describe('legacy column types', () => {
  const withDdl = CASES.filter(([, mapping]) => ddlColumns(tableNamed(mapping.legacyTable)).length > 0);

  it.each(withDdl)('declares each %s column found in the legacy DDL with the canonical type of its SQL Server type', (_unit, mapping) => {
    const ddl = new Map(ddlColumns(tableNamed(mapping.legacyTable)).map((column) => [column.name.toLowerCase(), column]));
    const typed = mapping.legacyColumns.filter((column) => ddl.has(column.name.toLowerCase()));

    expect(typed.length).toBeGreaterThan(0);
    expect(typed.map((column) => [column.name, column.type])).toStrictEqual(
      typed.map((column) => [column.name, canonicalTypeForSqlServer(ddl.get(column.name.toLowerCase())?.type ?? '').type]),
    );
  });
});

describe('canonical row round trips', () => {
  it.each(CASES)('keeps a stressed %s row byte-exact from its legacy encoding through the target row and back', (_unit, mapping) => {
    const { row, canonical, nulls, empties } = sampleRow(mapping);
    const encoding = encodeRow(mapping.legacyColumns, row);
    const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

    expect(mapping.acceptsRow(row, discriminatorOf(mapping, row))).toBe(true);
    expect(decodeRow(mapping.legacyColumns, encoding)).toStrictEqual(canonical);
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
    expect([...nulls, ...empties].map((column) => target[column.target])).toStrictEqual([...nulls.map(() => null), ...empties.map(() => '')]);
  });

  it('rounds a tusers timestamp at the last 1/300 s tick of June into July on both sides', () => {
    const { row } = sampleRow(tusersGroupAccountMapping);
    const target = tusersGroupAccountMapping.toTarget(
      tusersGroupAccountMapping.decodeLegacy(tusersGroupAccountMapping.legacyColumns, encodeRow(tusersGroupAccountMapping.legacyColumns, row)),
    );

    expect(target.passwordcreated).toBe('2026-07-01 00:00:00.000');
  });
});

describe('row tenants', () => {
  const siteSourced = CASES.filter(([, mapping]) => mapping.tenant?.kind === 'site');
  const parentSourced = CASES.filter(([, mapping]) => mapping.tenant?.kind === 'parent');

  it('takes every mapping tenant from the row site column or its parent row', () => {
    expect(siteSourced.length + parentSourced.length).toBe(mappings.length);
  });

  it.each(siteSourced)('places an %s row of site tenant-a in the tenant-a tenant', (_unit, mapping) => {
    expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, sampleRow(mapping).row, LOOKUPS)).toStrictEqual({
      tenantId: tenantIdForSite(SITE_ID),
      siteId: SITE_ID,
      orphan: false,
    });
  });

  it.each(parentSourced)('places an %s row, whose table has no site column, in its parent row tenant', (_unit, mapping) => {
    expect(tableNamed(mapping.legacyTable).siteIdColumn).toBeNull();
    expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, sampleRow(mapping).row, LOOKUPS)).toStrictEqual({
      tenantId: tenantIdForSite(PARENT_SITE_ID),
      siteId: PARENT_SITE_ID,
      orphan: false,
    });
  });
});
