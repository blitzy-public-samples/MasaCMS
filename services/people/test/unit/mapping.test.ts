/** People's mappings against table ownership: column coverage, row predicates, the tusers split, table definitions, units and canonical round trips. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeRow,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  type CanonicalColumn,
  type Mapping,
  type SplitRule,
} from '@opt2/platform/migration-kit';
import { PEOPLE_MAPPINGS, personMapping } from '../../src/migration/mappings/index.js';
import { OWNED_TABLES, PEOPLE_UNITS, PERSON, PERSON_COLUMNS, TARGET_ONLY_COLUMNS } from '../../src/repo/tables.js';

const OWNER = 'people';

interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
}

interface ClassMapEntry {
  classes: string[];
  owner?: string;
  ownerBy?: string;
  owners?: Record<string, string>;
}

interface OwnershipSplit {
  by: string;
  typeColumn?: string;
  parent?: { table: string; join: string };
  baseTableOwners?: Record<string, string>;
  classMap?: ClassMapEntry[];
}

interface OwnershipTable {
  table: string;
  columns: string[];
  primaryKey: string[];
  split?: OwnershipSplit | null;
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: OwnershipTable[];
}

/** A people target of table ownership with its legacy table. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;

// The person share of tusers is the one ownership fact this suite states itself; every other expectation is read from the file.
const PERSON_SHARE: readonly string[] = [
  'GroupName', 'Fname', 'Lname', 'Email', 'Company', 'JobTitle', 'mobilePhone', 'Website', 'subType', 'Ext', 'ContactForm',
  'Subscribe', 'notes', 'description', 'interests', 'keepPrivate', 'photoFileID', 'IMName', 'IMService', 'tags', 'created',
  'LastUpdate', 'LastUpdateBy', 'LastUpdateByID',
];

// Target columns the platform repository fills; no legacy column maps onto them.
const PLATFORM_COLUMNS: readonly string[] = ['tenant_id', 'row_version', 'legacy_row_hash', 'occurrence'];

const UNASSIGNED_COLUMN = 'opt2_unassigned_live_column';

const lower = (name: string): string => name.toLowerCase();

/** The split rule a row predicate states; it names the discriminator column only when the legacy row holds it. */
function splitOf(table: OwnershipTable, predicate: string | null): SplitRule | undefined {
  if (predicate === null) return undefined;
  const ownType = /^Type = (\d+)$/.exec(predicate);
  if (ownType !== null) return { by: 'Type', value: Number(ownType[1]), column: table.split?.typeColumn ?? '' };
  const ownerType = /^owner Type = (\d+)$/.exec(predicate);
  if (ownerType !== null) return { by: 'Type', value: Number(ownerType[1]) };
  const baseTables = /^baseTable in \((.+)\)$/.exec(predicate) ?? /^baseTable = ('[^']+')$/.exec(predicate);
  if (baseTables !== null) {
    const listed = (baseTables[1] ?? '').split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1'));
    const value = predicate.includes(' in (') ? listed : (listed[0] ?? '');
    return table.columns.includes('baseTable') ? { by: 'baseTable', value, column: 'baseTable' } : { by: 'baseTable', value };
  }
  const classOwner = /^classMap owner = (\S+)$/.exec(predicate);
  if (classOwner !== null) return { by: 'objectClass', value: classOwner[1] ?? '' };
  throw new Error(`${table.table}: unreadable row predicate ${predicate}`);
}

/** The values a split rule accepts. */
function splitValues(split: SplitRule): ReadonlyArray<string | number> {
  return typeof split.value === 'object' ? split.value : [split.value];
}

/** The split rule of a target that has a row predicate. */
function requiredSplit({ table, target }: OwnedTarget): SplitRule {
  const split = splitOf(table, target.rowPredicate);
  if (split === undefined) throw new Error(`${target.unit} has no row predicate`);
  return split;
}

/** The key `mappingCoverage` files a legacy table's rows under for a split rule. */
function coverageKeyOf(table: string, split: SplitRule | undefined): string {
  return split === undefined ? table : `${table}{${split.by}=${splitValues(split).map(String).join(',')}}`;
}

/** The people targets of an ownership object, in file order. */
function ownedTargets(ownership: Ownership): OwnedTarget[] {
  return ownership.tables.flatMap((table) =>
    (table.targets ?? []).filter((target) => target.unit.startsWith(`${OWNER}.`)).map((target) => ({ table, target })),
  );
}

/** The column list a target's policy reads: every live column for whole-table, else its owned columns. */
function policyColumns({ table, target }: OwnedTarget): string[] {
  return target.columnPolicy === 'whole-table' ? table.columns : target.ownedColumns;
}

/** Legacy columns an ownership object assigns to people, keyed as `mappingCoverage` keys them. */
function expectedCoverage(ownership: Ownership): Record<string, string[]> {
  const expected: Record<string, string[]> = {};
  for (const { table, target } of ownedTargets(ownership)) {
    const key = coverageKeyOf(table.table, splitOf(table, target.rowPredicate));
    const columns = target.columnPolicy === 'whole-table' ? table.columns : [...target.keyColumns, ...target.ownedColumns];
    expected[key] = [...new Set([...(expected[key] ?? []), ...columns])];
  }
  return expected;
}

/** The entry of a people target in another copy of the ownership object. */
function sameTargetIn(ownership: Ownership, { table, target }: OwnedTarget): OwnedTarget {
  const copyTable = ownership.tables.find((candidate) => candidate.table === table.table);
  const copyTarget = copyTable?.targets?.find((candidate) => candidate.unit === target.unit);
  if (copyTable === undefined || copyTarget === undefined) throw new Error(`the ownership copy has no ${table.table} target ${target.unit}`);
  return { table: copyTable, target: copyTarget };
}

/** The ownership entry of a legacy table. */
function tableNamed(name: string): OwnershipTable {
  const table = OWNERSHIP.tables.find((candidate) => candidate.table === name);
  if (table === undefined) throw new Error(`table ownership has no ${name}`);
  return table;
}

/** The target of a legacy table onto a unit. */
function targetNamed(table: OwnershipTable, unit: string): OwnershipTarget {
  const target = table.targets?.find((candidate) => candidate.unit === unit);
  if (target === undefined) throw new Error(`${table.table} has no target ${unit}`);
  return target;
}

/** The one people mapping of a target's legacy table onto its unit. */
function mappingOf({ table, target }: OwnedTarget): Mapping {
  const found = PEOPLE_MAPPINGS.filter((mapping) => mapping.legacyTable === table.table && mapping.unit === target.unit);
  const [mapping] = found;
  if (found.length !== 1 || mapping === undefined) throw new Error(`${String(found.length)} mappings of ${table.table} onto ${target.unit}`);
  return mapping;
}

/** Whether a mapping accepts a row carrying a discriminator value, read from its split column when it names one. */
function acceptsValue(mapping: Mapping, value: string | number): boolean {
  const column = mapping.split?.column;
  return column === undefined ? mapping.acceptsRow({}, value) : mapping.acceptsRow({ [column]: value });
}

/** A legacy value of a column; text alternates between colon-laden and empty strings by `texts`, the text columns seen so far. */
function sampleValue(column: CanonicalColumn, position: number, texts: number): unknown {
  switch (column.type) {
    case 's':
      return texts % 2 === 0 ? `s3:${column.name}:${String(position)}:` : '';
    case 'i':
      return position + 1;
    case 'f':
      return position + 0.25;
    case 't':
      return new Date(2026, 5, 30, 10, position % 60, 30, 123);
    default:
      throw new Error(`${column.name}: no ${column.type} sample, as people maps no such legacy column`);
  }
}

/** A legacy row over a mapping's columns whose last non-key column is NULL; tusersinterests has only key columns. */
function sampleRow(mapping: Mapping): Record<string, unknown> {
  const keys = new Set(mapping.key ?? []);
  const nullColumn = mapping.legacyColumns.filter((column) => !keys.has(column.name)).at(-1)?.name;
  let texts = 0;
  return Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => {
      if (column.name === nullColumn) return [column.name, null];
      const value = sampleValue(column, position, texts);
      if (column.type === 's') texts += 1;
      return [column.name, value];
    }),
  );
}

const OWNED_TARGETS = ownedTargets(OWNERSHIP);
const TARGET_CASES = OWNED_TARGETS.map((owned) => [owned.target.unit, owned] as const);
const SPLIT_CASES = TARGET_CASES.filter(([, owned]) => owned.target.rowPredicate !== null);
const BASE_TABLE_CASES = TARGET_CASES.filter(([, owned]) => owned.table.split?.by === 'baseTable');
const OWNER_TYPE_CASES = TARGET_CASES.filter(([, owned]) => owned.table.split?.by === 'ownerType');
const OBJECT_CLASS_CASES = TARGET_CASES.filter(([, owned]) => owned.table.split?.by === 'objectClass');
const MAPPING_CASES = PEOPLE_MAPPINGS.map((mapping) => [mapping.unit, mapping] as const);
const FILE_UNITS = OWNERSHIP.units.filter((unit) => unit.owner === OWNER);

const TUSERS = tableNamed(personMapping.legacyTable);
const PERSON_TARGET = targetNamed(TUSERS, PERSON.unit);

describe('people mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to people', () => {
    const diff = diffCoverage(expectedCoverage(OWNERSHIP), mappingCoverage(PEOPLE_MAPPINGS));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it.each(TARGET_CASES)('reports a column dropped from %s in the ownership file as mapped but unassigned', (_unit, owned) => {
    const copy = structuredClone(OWNERSHIP);
    const mutated = sameTargetIn(copy, owned);
    const dropped = policyColumns(mutated).pop();
    if (dropped === undefined) throw new Error(`${owned.target.unit} lists no columns`);

    const key = coverageKeyOf(owned.table.table, splitOf(owned.table, owned.target.rowPredicate));
    expect(diffCoverage(expectedCoverage(copy), mappingCoverage(PEOPLE_MAPPINGS)).extra[key]).toContain(dropped);
  });

  it.each(TARGET_CASES)('reports a live column added to %s in the ownership file as assigned but unmapped', (_unit, owned) => {
    const copy = structuredClone(OWNERSHIP);
    policyColumns(sameTargetIn(copy, owned)).push(UNASSIGNED_COLUMN);

    const key = coverageKeyOf(owned.table.table, splitOf(owned.table, owned.target.rowPredicate));
    expect(diffCoverage(expectedCoverage(copy), mappingCoverage(PEOPLE_MAPPINGS)).missing[key]).toContain(UNASSIGNED_COLUMN);
  });
});

describe('people units', () => {
  it('declares exactly the people units of the ownership file, in its order', () => {
    expect([...PEOPLE_UNITS]).toStrictEqual(FILE_UNITS.map((unit) => unit.unit));
  });

  it('maps every people unit of the ownership file and no other unit', () => {
    const fileUnits = FILE_UNITS.map((unit) => unit.unit);

    expect(fileUnits.filter((unit) => !PEOPLE_MAPPINGS.some((mapping) => mapping.unit === unit))).toStrictEqual([]);
    expect(PEOPLE_MAPPINGS.map((mapping) => mapping.unit).filter((unit) => !fileUnits.includes(unit))).toStrictEqual([]);
  });

  it.each(MAPPING_CASES)('maps %s from a legacy table its ownership unit lists', (unit, mapping) => {
    expect(FILE_UNITS.find((candidate) => candidate.unit === unit)?.legacyTables).toContain(mapping.legacyTable);
  });
});

describe('row predicates', () => {
  it.each(TARGET_CASES)('selects the %s rows by the row predicate table ownership gives', (_unit, owned) => {
    expect(mappingOf(owned).split).toStrictEqual(splitOf(owned.table, owned.target.rowPredicate));
  });

  it.each(SPLIT_CASES)('accepts the %s rows its predicate selects and none the ownership file gives other targets', (_unit, owned) => {
    const mapping = mappingOf(owned);
    const selected = splitValues(requiredSplit(owned));
    const own = new Set(selected.map((value) => lower(String(value))));
    const others = (owned.table.targets ?? [])
      .filter((target) => target !== owned.target)
      .flatMap((target) => splitValues(requiredSplit({ table: owned.table, target })))
      .filter((value) => !own.has(lower(String(value))));

    expect(others.length).toBeGreaterThan(0);
    expect(selected.map((value) => acceptsValue(mapping, value))).toStrictEqual(selected.map(() => true));
    expect(others.map((value) => acceptsValue(mapping, value))).toStrictEqual(others.map(() => false));
  });

  it.each(BASE_TABLE_CASES)('accepts for %s exactly the base tables the ownership file gives people', (_unit, owned) => {
    const peopleBaseTables = Object.entries(owned.table.split?.baseTableOwners ?? {})
      .filter(([, owner]) => owner === OWNER)
      .map(([baseTable]) => baseTable);
    const split = mappingOf(owned).split;

    expect(peopleBaseTables.length).toBeGreaterThan(0);
    expect(split === undefined ? [] : splitValues(split).map(String).sort()).toStrictEqual(peopleBaseTables.sort());
  });

  it.each(OWNER_TYPE_CASES)('selects the %s rows by the Type of their owning tusers row, the Type people.person takes', (_unit, owned) => {
    expect(owned.table.split?.parent?.table).toBe(TUSERS.table);
    expect(splitValues(requiredSplit(owned))).toStrictEqual(splitValues(requiredSplit({ table: TUSERS, target: PERSON_TARGET })));
  });

  it.each(OBJECT_CLASS_CASES)('finds an owner for every ttrash objectClass and gives %s at least one class', (_unit, owned) => {
    const classMap = owned.table.split?.classMap ?? [];
    const peopleClasses = classMap
      .filter((entry) => entry.owner === OWNER || Object.values(entry.owners ?? {}).includes(OWNER))
      .flatMap((entry) => entry.classes);

    expect(classMap.filter((entry) => entry.owner === undefined && entry.owners === undefined && entry.ownerBy === undefined)).toStrictEqual([]);
    expect(peopleClasses.length).toBeGreaterThan(0);
    expect(requiredSplit(owned)).toStrictEqual({ by: 'objectClass', value: OWNER });
  });
});

describe('the tusers split', () => {
  it('carries the 24 person columns of Type=2 rows onto people.person, keyed by UserID and SiteID', () => {
    const share = new Set(PERSON_SHARE);
    const legacy = personMapping.columns.map((column) => column.legacy);

    expect(personMapping.unit).toBe(PERSON.unit);
    expect(personMapping.targetTable).toBe(PERSON.unit);
    expect(PERSON_TARGET.ownedColumns).toEqual(expect.arrayContaining([...PERSON_SHARE]));
    expect(personMapping.columns.filter((column) => share.has(column.legacy)).map((column) => column.target)).toStrictEqual([...PERSON_COLUMNS]);
    expect(PERSON_TARGET.keyColumns).toStrictEqual(['UserID', 'SiteID']);
    expect(legacy).toEqual(expect.arrayContaining(PERSON_TARGET.keyColumns));
    // The mapping key is the tusers primary key UserID; SiteID is a target key column the mapping carries but does not key on.
    expect(PERSON_TARGET.keyColumns).toEqual(expect.arrayContaining(personMapping.key ?? ['<keyless>']));
    expect(personMapping.key?.map((name) => personMapping.columns.find((column) => column.legacy === name)?.target)).toStrictEqual(PERSON.key);
  });

  it('assigns each tusers column of a Type=2 row to exactly one of people.person and the targets sharing its predicate, apart from key columns', () => {
    const siblings = (TUSERS.targets ?? []).filter((target) => target !== PERSON_TARGET && target.rowPredicate === PERSON_TARGET.rowPredicate);
    const keys = new Set([PERSON_TARGET, ...siblings].flatMap((target) => target.keyColumns).map(lower));
    const shares = [
      personMapping.columns.map((column) => column.legacy),
      ...siblings.map((target) => [...target.keyColumns, ...target.ownedColumns]),
    ];
    const counts = new Map<string, number>();
    for (const share of shares) for (const column of new Set(share.map(lower))) counts.set(column, (counts.get(column) ?? 0) + 1);

    expect(siblings.length).toBeGreaterThan(0);
    expect([...counts].filter(([column, count]) => count > 1 && !keys.has(column))).toStrictEqual([]);
    expect([...counts.keys()].sort()).toStrictEqual(TUSERS.columns.map(lower).sort());
  });

  it.each(PERSON_TARGET.ownedColumns)('maps the tusers column %s the ownership file assigns to people.person', (name) => {
    expect(personMapping.columns.find((column) => lower(column.legacy) === lower(name))?.target).toBe(lower(name));
  });
});

describe('people table definitions', () => {
  it.each(MAPPING_CASES)('stores %s in exactly the mapped target columns of its table definition, in order', (unit, mapping) => {
    const definitions = OWNED_TABLES.filter((table) => `${OWNER}.${table.table}` === mapping.targetTable);
    const [definition] = definitions;
    if (definitions.length !== 1 || definition === undefined) throw new Error(`${String(definitions.length)} definitions of ${mapping.targetTable}`);
    const platform = new Set([...PLATFORM_COLUMNS, ...(TARGET_ONLY_COLUMNS[definition.table] ?? [])]);

    expect(definition.unit).toBe(unit);
    expect(definition.columns.filter((column) => !platform.has(column.name))).toStrictEqual([...mapping.targetColumns]);
  });
});

describe('canonical round trips', () => {
  it.each(MAPPING_CASES)('keeps a %s row with colons, empty text, a NULL, integers and millisecond timestamps byte-exact through the target row', (_unit, mapping) => {
    const row = sampleRow(mapping);
    const encoding = encodeRow(mapping.legacyColumns, row);
    const target = mapping.toTarget(decodeRow(mapping.legacyColumns, encoding));
    const texts = mapping.columns.filter((column) => column.type === 's');

    expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
    expect(texts.map((column) => target[column.target])).toStrictEqual(texts.map((column) => row[column.legacy]));
  });
});
