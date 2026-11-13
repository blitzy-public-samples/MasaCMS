/** The strategies-content mappings against table ownership: column coverage, units, byte-exact round trips, split rules and keyless multisets. */
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
import {
  mappings,
  tclassextendMapping,
  tcontentdisplaytitleapprovalsMapping,
  tcontentpublicsubmissionapprovalsMapping,
  tfilesMapping,
  ttrashMapping,
  units,
} from '../../src/migration/mappings/index.js';
import {
  CONTENT_UNITS,
  FILE_OBJECT,
  GROUP_PROJECTION,
  MEMBERSHIP_PROJECTION,
  OWNED_TABLES,
  PERMISSION_PROJECTION,
} from '../../src/repo/tables.js';

const OWNER = 'strategies-content';
const SITE_ID = 'tenant-a';
const CONTENT_ID = 'A0B1C2D3-E4F5-A6B7-C8D9E0F1A2B3C4D5E';
const KEYLESS_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);
const DOCUMENT = "<wddxPacket version='1.0'><header/><data><struct><var name='a:b'><string>x\r\n\t </string></var></struct></data></wddxPacket>";

interface OwnershipTarget {
  unit: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns?: string[];
}

interface ClassMapEntry {
  classes: string[];
  owner?: string;
  owners?: Record<string, string>;
}

interface OwnershipTable {
  table: string;
  columns: string[];
  siteIdColumn: string | null;
  rowIdentity: 'key' | 'multiset' | null;
  tenantParent?: { table: string };
  serializedDocumentColumns: string[];
  split?: { by: string; baseTableOwners?: Record<string, string>; classMap?: ClassMapEntry[] };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
  newTables: { table: string; owner: string }[];
}

/** A strategies-content target of table ownership with its legacy table and the key `mappingCoverage` files it under. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
  coverageKey: string;
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));

/** The ownership entry of a legacy table. */
function ownershipTable(name: string): OwnershipTable {
  const table = OWNERSHIP.tables.find((entry) => entry.table === name);
  if (table === undefined) throw new Error(`table ownership has no entry for ${name}`);
  return table;
}

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

/** Legacy columns the targets own per coverage key; a whole-table target owns every live column of its table. */
function expectedCoverage(targets: readonly OwnedTarget[]): Record<string, string[]> {
  const expected: Record<string, string[]> = {};
  for (const { table, target, coverageKey } of targets) {
    const owned = target.columnPolicy === 'whole-table' ? table.columns : [...target.keyColumns, ...(target.ownedColumns ?? [])];
    expected[coverageKey] = [...new Set([...(expected[coverageKey] ?? []), ...owned])];
  }
  return expected;
}

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

// Sample rows leave the first column NULL and the second empty. Every NULL column is nullable in the legacy catalog;
// an empty key column stands in where a table has no other text column.
const NULL_AND_EMPTY: Readonly<Record<string, readonly [nullColumn: string, emptyColumn: string]>> = {
  tcontentcategories: ['parentID', 'notes'],
  tcontentcategoryassign: ['featureStop', 'contentID'],
  tcontent: ['ReleaseDate', 'Summary'],
  tcontentrelated: ['orderNo', 'relatedContentSetID'],
  tcontenttags: ['taggroup', 'tag'],
  tcontentassignments: ['type', 'userID'],
  tcontentfilenamearchive: ['contentID', 'filename'],
  tcontentsourcemaps: ['created', 'sourceid'],
  tcontentremotepointer: ['remoteurl', 'remoteid'],
  tcontentvariationtargeting: ['initjs', 'targetingjs'],
  tcontentdisplaytitleapprovals: ['isApproved', 'email'],
  tcontentpublicsubmissionapprovals: ['isApproved', 'email'],
  tcontentobjects: ['ContentID', 'Name'],
  tfiles: ['imageSmall', 'caption'],
  tcontentfilemetadata: ['exif', 'caption'],
  tcontentstats: ['lockID', 'lockType'],
  tcontentratings: ['entered', 'userID'],
  tcontentcomments: ['entered', 'url'],
  tcontentcommentcommenters: ['remoteID', 'name'],
  tcontentfeeds: ['description', 'altname'],
  tcontentfeeditems: ['type', 'itemID'],
  tcontentfeedadvancedparams: ['param', 'criteria'],
  tapprovalchains: ['description', 'lastupdateby'],
  tapprovalmemberships: ['created', 'groupID'],
  tapprovalassignments: ['contentID', 'exemptID'],
  tapprovalrequests: ['groupID', 'status'],
  tapprovalactions: ['parentID', 'comments'],
  tchangesets: ['closeDate', 'description'],
  tchangesetrollback: ['previousHistID', 'changesetHistID'],
  tchangesetcategoryassign: ['categoryid', 'changesetid'],
  tchangesettagassign: ['changesetid', 'tag'],
  tformresponsepackets: ['FormID', 'FieldList'],
  tformresponsequestions: ['pollValue', 'formValue'],
  tclassextend: ['notes', 'iconclass'],
  tclassextendsets: ['categoryID', 'container'],
  tclassextendattributes: ['hint', 'optionLabelList'],
  tclassextendrcsets: ['availableSubTypes', 'entitytype'],
  tclassextenddata: ['attributeValue', 'remoteID'],
  ttrash: ['deleteid', 'deletedBy'],
};

/** Serialized-document columns of each owned legacy table, compared byte-exact and never parsed. */
const DOCUMENT_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map(
  OWNED_TARGETS.map(({ table }) => [table.table, table.serializedDocumentColumns]),
);

/** Parent-row sites for parent-sourced tenants: every parent of a sample row is a `tenant-a` row. */
const LOOKUPS: TenantLookups = { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID, parentSiteId: () => SITE_ID };

/** A driver-shaped legacy value for `column`, distinct per column position. */
function sampleValue(column: CanonicalColumn, position: number): unknown {
  switch (column.type) {
    case 's':
      return `${column.name}:\r\n\u00e9${String(position)} `;
    case 'i':
      return position + 1;
    case 'f':
      return position + 0.1;
    case 'd':
      return (position + 0.5).toFixed(column.scale ?? 0);
    case 't':
      return new Date(2026, 5, 30, 12, 0, position % 60, 3);
    case 'b':
      return Buffer.from([position % 256, 0x00, 0xfe, 0xff]);
  }
}

/** A sample legacy row of site `tenant-a` owned by strategies-content, with its NULL and empty columns. */
function sampleRow(mapping: Mapping): { row: Record<string, unknown>; nullColumn: MappingColumn; emptyColumn: MappingColumn } {
  const row: Record<string, unknown> = Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, sampleValue(column, position)]),
  );
  if (mapping.tenant?.kind === 'site') row[mapping.tenant.column] = SITE_ID;
  if (mapping.split?.column !== undefined) row[mapping.split.column] = ownedValue(mapping.split);
  for (const name of DOCUMENT_COLUMNS.get(mapping.legacyTable) ?? []) row[name] = DOCUMENT;
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

/** Target row of a legacy row, decoded from its canonical encoding as the apply handler receives it. */
function targetOf(mapping: Mapping, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encodeRow(mapping.legacyColumns, row)));
}

describe('strategies-content mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to strategies-content', () => {
    const diff = diffCoverage(expectedCoverage(OWNED_TARGETS), mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.coverageKey, entry] as const))(
    'gives %s a column policy expectedCoverage reads, a whole-table one owning exactly its catalog columns',
    (_coverageKey, { table, target }) => {
      expect(['whole-table', 'explicit']).toContain(target.columnPolicy);
      if (target.columnPolicy === 'whole-table') expect(target.ownedColumns ?? table.columns).toStrictEqual(table.columns);
    },
  );

  it.each(OWNED_TARGETS.map((entry) => [entry.coverageKey, entry] as const))(
    'fails coverage of %s naming a live column added to its catalog but not mapped',
    (coverageKey, entry) => {
      const column = 'opt2_synthetic_unmapped_live_column';
      const table = { ...entry.table, columns: [...entry.table.columns, column] };
      const targets = OWNED_TARGETS.map((owned) => (owned === entry ? { ...owned, table } : owned));
      const diff = diffCoverage(expectedCoverage(targets), mappingCoverage(mappings));

      expect(diff).toStrictEqual({ missing: { [coverageKey]: [column] }, extra: {} });
    },
  );

  it.each(OWNED_TARGETS.map((entry) => [entry.coverageKey, entry.target.unit, entry] as const))(
    'maps %s onto %s in catalog column order, with its key, row identity and tenant source',
    (_coverageKey, _unit, entry) => {
      const mapping = mappingFor(entry);
      const parent = entry.table.tenantParent?.table;

      expect(mapping.targetTable).toBe(entry.target.unit);
      expect(mapping.legacyColumns.map((column) => column.name)).toStrictEqual(entry.table.columns);
      expect(mapping.key ?? []).toStrictEqual(entry.target.keyColumns);
      expect(mapping.keyless).toBe(entry.table.rowIdentity === 'multiset');
      if (parent === undefined) expect(mapping.tenant).toStrictEqual({ kind: 'site', column: entry.table.siteIdColumn });
      else expect(mapping.tenant).toMatchObject({ kind: 'parent', parentLegacyTable: parent });
    },
  );

  it('declares no mapping onto a table outside the units table ownership gives strategies-content', () => {
    expect(mappings.filter((mapping) => !OWNED_UNITS.has(mapping.unit) || mapping.targetTable !== mapping.unit)).toStrictEqual([]);
  });
});

describe('strategies-content units', () => {
  it('exposes CONTENT_UNITS as its units, in order', () => {
    expect(units).toStrictEqual(CONTENT_UNITS);
  });

  it('lists exactly the units table ownership gives strategies-content, in its order', () => {
    expect([...CONTENT_UNITS]).toStrictEqual(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));
  });

  it.each(OWNED_TABLES.filter((definition) => definition.unit !== undefined).map((definition) => [definition.unit, definition] as const))(
    'maps exactly one legacy table onto %s, covering every repository data column',
    (unit, definition) => {
      const found = mappings.filter((mapping) => mapping.unit === unit);

      expect(found).toHaveLength(1);
      expect(found[0]?.targetColumns).toStrictEqual(definition.columns.filter((column) => !KEYLESS_MANAGED.has(column.name)));
    },
  );

  it('leaves file_object, which has no legacy table, and the three projections without a unit or a mapping', () => {
    const unitless = OWNED_TABLES.filter((definition) => definition.unit === undefined);
    const targets = new Set(mappings.map((mapping) => mapping.targetTable));

    expect(unitless).toStrictEqual([FILE_OBJECT, GROUP_PROJECTION, PERMISSION_PROJECTION, MEMBERSHIP_PROJECTION]);
    expect(OWNERSHIP.newTables).toContainEqual(expect.objectContaining({ table: `content.${FILE_OBJECT.table}`, owner: OWNER }));
    expect(unitless.filter((definition) => targets.has(`content.${definition.table}`))).toStrictEqual([]);
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
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS)).toMatchObject({ siteId: SITE_ID, orphan: false });
    },
  );

  const documents = mappings.flatMap((mapping) =>
    (DOCUMENT_COLUMNS.get(mapping.legacyTable) ?? []).map((name) => [`${mapping.legacyTable}.${name}`, name, mapping] as const),
  );

  it('finds the serialized documents of tcontentobjects, tformresponsepackets and ttrash in table ownership', () => {
    expect(documents.map(([qualified]) => qualified).sort()).toStrictEqual(['tcontentobjects.Params', 'tformresponsepackets.Data', 'ttrash.objectstring']);
  });

  it.each(documents)('carries the serialized document %s through its target row unchanged', (_qualified, name, mapping) => {
    const column = mapping.columns.find((candidate) => candidate.legacy === name);
    const target = targetOf(mapping, sampleRow(mapping).row);

    expect(column?.type).toBe('s');
    expect(target[column?.target ?? name]).toBe(DOCUMENT);
    expect(mapping.toLegacy(target)[name]).toBe(DOCUMENT);
  });

  it('keeps the tfiles image, imageSmall and imageMedium bytes as Buffers', () => {
    const row: Record<string, unknown> = { ...sampleRow(tfilesMapping).row, imageSmall: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    const target = targetOf(tfilesMapping, row);

    expect(['image', 'imagesmall', 'imagemedium'].map((name) => target[name])).toStrictEqual([row['image'], row['imageSmall'], row['imageMedium']]);
  });
});

describe('baseTable split of the class-extension tables', () => {
  const splits = mappings.filter((mapping) => mapping.split?.by === 'baseTable');

  it('splits exactly the tables table ownership splits by baseTable, giving tcontent to strategies-content', () => {
    const owned = OWNED_TARGETS.filter(({ table }) => table.split?.by === 'baseTable');

    expect(splits.map((mapping) => mapping.legacyTable).sort()).toStrictEqual(owned.map(({ table }) => table.table).sort());
    expect(owned.map(({ table }) => table.split?.baseTableOwners?.['tcontent'])).toStrictEqual(owned.map(() => OWNER));
    expect(tclassextendMapping.split).toStrictEqual({ by: 'baseTable', value: 'tcontent', column: 'baseTable' });
  });

  it.each(
    splits.flatMap((mapping) =>
      Object.entries(ownershipTable(mapping.legacyTable).split?.baseTableOwners ?? {}).map(
        ([baseTable, owner]) => [mapping.legacyTable, baseTable, owner, mapping] as const,
      ),
    ),
  )('answers whether a %s row of baseTable %s (owner %s) is strategies-content', (_legacyTable, baseTable, owner, mapping) => {
    const { row } = sampleRow(mapping);
    const column = mapping.split?.column;
    const accepted = column === undefined ? mapping.acceptsRow(row, baseTable) : mapping.acceptsRow({ ...row, [column]: baseTable });

    expect(accepted).toBe(owner === OWNER);
  });

  it.each(splits.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'rejects a %s row without a resolvable baseTable',
    (_legacyTable, mapping) => {
      const { row } = sampleRow(mapping);
      const column = mapping.split?.column;

      if (column === undefined) {
        expect([mapping.acceptsRow(row), mapping.acceptsRow(row, null)]).toStrictEqual([false, false]);
      } else {
        expect(mapping.acceptsRow({ ...row, [column]: null }, 'tcontent')).toBe(false);
      }
    },
  );

  it('judges a tclassextend row by its own baseTable column over any apply discriminator', () => {
    expect(tclassextendMapping.acceptsRow({ ...sampleRow(tclassextendMapping).row, baseTable: 'tusers' }, 'tcontent')).toBe(false);
  });
});

describe('objectClass split of ttrash', () => {
  const classMap = ownershipTable('ttrash').split?.classMap ?? [];
  const classOwners = classMap.flatMap((entry) =>
    entry.classes.flatMap((objectClass) =>
      [...new Set([...(entry.owner === undefined ? [] : [entry.owner]), ...Object.values(entry.owners ?? {})])].map(
        (owner) => [objectClass, owner] as const,
      ),
    ),
  );
  const { row } = sampleRow(ttrashMapping);

  it('takes the class-map owner as the apply discriminator, content, feed, category, changeset and extendObject mapping to strategies-content', () => {
    expect(ttrashMapping.split).toStrictEqual({ by: 'objectClass', value: OWNER });
    expect(classOwners.filter(([, owner]) => owner === OWNER).map(([objectClass]) => objectClass)).toStrictEqual([
      'content',
      'feed',
      'category',
      'changeset',
      'extendObject',
    ]);
  });

  it.each(classOwners)('answers whether a ttrash row of objectClass %s owned by %s is strategies-content', (objectClass, owner) => {
    expect(ttrashMapping.acceptsRow({ ...row, objectClass }, owner)).toBe(owner === OWNER);
  });

  it('rejects a ttrash row whose class-map owner is unresolved, whatever its objectClass', () => {
    expect([ttrashMapping.acceptsRow({ ...row, objectClass: 'content' }), ttrashMapping.acceptsRow({ ...row, objectClass: 'content' }, null)]).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe.each([tcontentdisplaytitleapprovalsMapping, tcontentpublicsubmissionapprovalsMapping].map((mapping) => [mapping.legacyTable, mapping] as const))(
  '%s multiset rows',
  (_legacyTable, mapping) => {
    const columns = mapping.legacyColumns;
    const duplicate = { contentid: CONTENT_ID, isApproved: 1, email: '', siteid: SITE_ID };
    const legacyRows = [duplicate, { ...duplicate }, { ...duplicate, email: null }];
    const encodings = legacyRows.map((legacyRow) => encodeRow(columns, legacyRow));
    const targets = encodings.map((encoding) => mapping.toTarget(mapping.decodeLegacy(columns, encoding)));
    const definition = OWNED_TABLES.find((candidate) => candidate.unit === mapping.unit);
    const dataColumns = (definition?.columns ?? []).filter((column) => !KEYLESS_MANAGED.has(column.name));
    const hashes = targets.map((target) => legacyRowHash(dataColumns, target));

    it('is keyless in its mapping and its repository table', () => {
      expect([mapping.keyless, mapping.key, definition?.key]).toStrictEqual([true, null, null]);
    });

    it('maps two identical rows and one differing only by NULL against empty to three target rows', () => {
      expect(targets).toHaveLength(3);
      expect(targets[1]).toStrictEqual(targets[0]);
      expect(targets[2]).not.toStrictEqual(targets[0]);
    });

    it('hashes target rows over the repository data columns as their legacy rows, numbering identical rows 1 and 2', () => {
      expect(dataColumns).toStrictEqual(mapping.targetColumns);
      expect(hashes).toStrictEqual(legacyRows.map((legacyRow) => legacyRowHash(columns, legacyRow)));
      expect(hashes[1]).toBe(hashes[0]);
      expect(hashes[2]).not.toBe(hashes[0]);
      expect(assignOccurrences(targets.map((target) => mapping.encodeLegacy(target)))).toStrictEqual([
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
      expect(multiset(targets.map((target) => encodeRow(columns, mapping.toLegacy(target))))).toStrictEqual(legacy);
    });
  },
);
