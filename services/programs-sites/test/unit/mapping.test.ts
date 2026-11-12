/** The programs-sites mappings against table ownership: column coverage, units, site columns, byte-exact round trips and keyless multisets. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  assignOccurrences,
  diffCoverage,
  encodeRow,
  legacyRowHash,
  mappingCoverage,
  multiset,
  resolveTenant,
  type CanonicalColumn,
  type Mapping,
  type MappingColumn,
  type SplitRule,
  type TenantLookups,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { mappings, tclassextendMapping, tsettingsMapping, tsystemobjectsMapping, units } from '../../src/migration/mappings/index.js';
import { SYSTEM_OBJECT, UNITS } from '../../src/repo/tables.js';
import { SITE_COLUMNS } from '../../src/legacy/site-fields.js';

const OWNER = 'programs-sites';
const SITE_ID = 'tenant-a';
const LOOKUPS: TenantLookups = { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID };
const KEYLESS_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);

interface OwnershipTarget {
  unit: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns?: string[];
}

interface OwnershipTable {
  table: string;
  siteIdColumn: string | null;
  rowIdentity: 'key' | 'multiset';
  split?: { by: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

/** A programs-sites target of table ownership with its legacy table and the key `mappingCoverage` files it under. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
  coverageKey: string;
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));

/** `<table>`, or `<table>{<by>=<value>}` for a split table, the value taken from the target's row predicate. */
function coverageKeyOf(table: OwnershipTable, target: OwnershipTarget): string {
  if (table.split === undefined) return table.table;
  const value = /=\s*'?([^']+?)'?$/.exec(target.rowPredicate ?? '')?.[1];
  if (value === undefined) throw new Error(`${table.table}: split target ${target.unit} has no row predicate value`);
  return `${table.table}{${table.split.by}=${value}}`;
}

const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? [])
    .filter((target) => OWNED_UNITS.has(target.unit))
    .map((target) => ({ table, target, coverageKey: coverageKeyOf(table, target) })),
);

/** The one mapping of the target's legacy table onto its unit. */
function mappingFor({ table, target }: OwnedTarget): Mapping {
  const found = mappings.filter((mapping) => mapping.legacyTable === table.table && mapping.unit === target.unit);
  const [mapping] = found;
  if (found.length !== 1 || mapping === undefined) throw new Error(`${String(found.length)} mappings of ${table.table} onto ${target.unit}`);
  return mapping;
}

/** The value a split rule accepts; the owned discriminator of every sample row. */
function ownedValue(split: SplitRule): string | number | undefined {
  return typeof split.value === 'object' ? split.value[0] : split.value;
}

// Sample rows leave the first column NULL and the second empty; every NULL column here is nullable in the legacy catalog.
const NULL_AND_EMPTY: Readonly<Record<string, readonly [nullColumn: string, emptyColumn: string]>> = {
  tsettings: ['placeholderImgID', 'placeholderImgExt'],
  timagesizes: ['height', 'width'],
  tdirectories: ['subdir', 'editfilename'],
  tsystemobjects: ['Object', 'Name'],
  tclassextend: ['notes', 'iconclass'],
  tclassextendsets: ['categoryID', 'container'],
  tclassextendattributes: ['hint', 'optionLabelList'],
  tclassextendrcsets: ['availableSubTypes', 'entitytype'],
  tclassextenddata: ['attributeValue', 'remoteID'],
  ttrash: ['deleteid', 'deletedBy'],
};

/** A driver-shaped legacy value for `column`, distinct per column position. */
function sampleValue(column: CanonicalColumn, position: number): unknown {
  switch (column.type) {
    case 's':
      return `${column.name}:\r\n${String(position)} `;
    case 'i':
      return position + 1;
    case 'f':
      return position + 0.25;
    case 'd':
      return (position + 0.5).toFixed(column.scale ?? 0);
    case 't':
      return new Date(2026, 5, 30, 12, 0, position % 60, 3);
    case 'b':
      return Buffer.from([position % 256, 0x00, 0xfe, 0xff]);
  }
}

/** A sample legacy row of site `tenant-a` owned by programs-sites, with its NULL and empty columns. */
function sampleRow(mapping: Mapping): { row: Record<string, unknown>; nullColumn: MappingColumn; emptyColumn: MappingColumn } {
  const row: Record<string, unknown> = Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, sampleValue(column, position)]),
  );
  if (mapping.tenant?.kind === 'site') row[mapping.tenant.column] = SITE_ID;
  if (mapping.split?.column !== undefined) row[mapping.split.column] = ownedValue(mapping.split);
  const [nullName, emptyName] = NULL_AND_EMPTY[mapping.legacyTable] ?? [];
  const nullColumn = mapping.columns.find((column) => column.legacy === nullName);
  const emptyColumn = mapping.columns.find((column) => column.legacy === emptyName);
  if (nullColumn === undefined || emptyColumn === undefined) throw new Error(`${mapping.legacyTable}: no mapped NULL and empty sample columns`);
  row[nullColumn.legacy] = null;
  row[emptyColumn.legacy] = '';
  return { row, nullColumn, emptyColumn };
}

/** The apply-row discriminator of a split mapping without a discriminator column. */
function discriminatorOf(mapping: Mapping): string | number | undefined {
  return mapping.split !== undefined && mapping.split.column === undefined ? ownedValue(mapping.split) : undefined;
}

describe('programs-sites mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to programs-sites', () => {
    const actual = mappingCoverage(mappings);
    // A whole-table target may omit ownedColumns; it is then checked for its table and unit only.
    const expected = Object.fromEntries(
      OWNED_TARGETS.map(({ target, coverageKey }) => [coverageKey, target.ownedColumns ?? actual[coverageKey] ?? []]),
    );
    const diff = diffCoverage(expected, actual);

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.coverageKey, entry.target.unit, entry] as const))(
    'maps %s onto %s with a non-empty column list, its key, row identity and site tenant',
    (_coverageKey, _unit, entry) => {
      const mapping = mappingFor(entry);

      expect(mapping.targetTable).toBe(entry.target.unit);
      expect(mapping.legacyColumns.length).toBeGreaterThan(0);
      expect(mapping.key ?? []).toStrictEqual(entry.target.keyColumns);
      expect(mapping.keyless).toBe(entry.table.rowIdentity === 'multiset');
      expect(mapping.tenant).toStrictEqual({ kind: 'site', column: entry.table.siteIdColumn });
    },
  );

  it('declares no mapping onto a unit table ownership gives another owner', () => {
    expect(mappings.map((mapping) => mapping.unit).filter((unit) => !OWNED_UNITS.has(unit))).toStrictEqual([]);
  });

  it('exposes the units of UNITS in their order', () => {
    expect(units).toStrictEqual(UNITS);
  });

  it('lists each tsettings owned column once as a site column, paired as the tsettings mapping pairs it', () => {
    const names = SITE_COLUMNS.map((column) => column.legacyName);
    const owned = OWNED_TARGETS.find((entry) => entry.table.table === 'tsettings')?.target.ownedColumns ?? [];

    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect([...names].sort()).toStrictEqual([...owned].sort());
    expect(SITE_COLUMNS.map(({ legacyName, targetName }) => [legacyName, targetName])).toStrictEqual(
      tsettingsMapping.columns.map(({ legacy, target }) => [legacy, target]),
    );
  });
});

describe('row round trips', () => {
  it.each(mappings.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'accepts a sample %s row and keeps it byte-exact through its target row',
    (_legacyTable, mapping) => {
      const { row, nullColumn, emptyColumn } = sampleRow(mapping);
      const encoding = encodeRow(mapping.legacyColumns, row);
      const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

      expect(mapping.acceptsRow(row, discriminatorOf(mapping))).toBe(true);
      expect([target[nullColumn.target], target[emptyColumn.target]]).toStrictEqual([null, '']);
      expect(mapping.encodeLegacy(target)).toBe(encoding);
      expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS)).toStrictEqual({
        tenantId: tenantIdForSite(SITE_ID),
        siteId: SITE_ID,
        orphan: false,
      });
    },
  );
});

describe('split ownership', () => {
  it('rejects a tclassextend row whose own baseTable is tcontent', () => {
    expect(tclassextendMapping.acceptsRow({ ...sampleRow(tclassextendMapping).row, baseTable: 'tcontent' })).toBe(false);
  });

  const chained = mappings.filter((mapping) => mapping.split?.by === 'baseTable' && mapping.split.column === undefined);

  it.each(chained.flatMap((mapping) => [[mapping.legacyTable, 'tcontent', mapping] as const, [mapping.legacyTable, null, mapping] as const]))(
    'rejects a %s row whose subtype baseTable is %s',
    (_legacyTable, discriminator, mapping) => {
      expect(mapping.acceptsRow(sampleRow(mapping).row, discriminator)).toBe(false);
    },
  );
});

describe('tsystemobjects multiset rows', () => {
  const columns = tsystemobjectsMapping.legacyColumns;
  const duplicate = { Object: 'nav:\r\nprimary ', SiteID: SITE_ID, Name: '', OrderNo: 1 };
  const legacyRows = [duplicate, { ...duplicate }, { ...duplicate, Name: null }];
  const encodings = legacyRows.map((row) => encodeRow(columns, row));
  const targets = encodings.map((encoding) => tsystemobjectsMapping.toTarget(tsystemobjectsMapping.decodeLegacy(columns, encoding)));
  const dataColumns = SYSTEM_OBJECT.columns.filter((column) => !KEYLESS_MANAGED.has(column.name));
  const hashes = targets.map((target) => legacyRowHash(dataColumns, target));

  it('maps two identical rows and one differing only by NULL against empty to three target rows', () => {
    expect(tsystemobjectsMapping.keyless).toBe(true);
    expect(targets).toHaveLength(3);
    expect(targets[1]).toStrictEqual(targets[0]);
    expect(targets[2]).not.toStrictEqual(targets[0]);
  });

  it('hashes target rows over the repository data columns as their legacy rows, numbering identical rows 1 and 2', () => {
    expect(dataColumns).toStrictEqual(tsystemobjectsMapping.targetColumns);
    expect(hashes).toStrictEqual(legacyRows.map((row) => legacyRowHash(columns, row)));
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(assignOccurrences(targets.map((target) => tsystemobjectsMapping.encodeLegacy(target)))).toStrictEqual([
      { encoding: encodings[0], hash: hashes[0], occurrence: 1 },
      { encoding: encodings[1], hash: hashes[1], occurrence: 2 },
      { encoding: encodings[2], hash: hashes[2], occurrence: 1 },
    ]);
  });

  it('counts the duplicate twice in the legacy multiset and maps the target rows back to the same multiset', () => {
    const legacy = multiset(encodings);

    expect([...legacy.values()]).toStrictEqual([
      { encoding: encodings[0], count: 2 },
      { encoding: encodings[2], count: 1 },
    ]);
    expect(multiset(targets.map((target) => encodeRow(columns, tsystemobjectsMapping.toLegacy(target))))).toStrictEqual(legacy);
  });
});
