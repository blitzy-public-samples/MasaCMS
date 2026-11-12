/** People's migration mappings against table ownership and the people table definitions: columns, keys, splits, tenant sources, row round trips and drifted definitions. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeKey,
  encodeRow,
  mappingCoverage,
  resolveTenant,
  type CanonicalColumn,
  type Mapping,
  type SplitRule,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { addressMapping } from '../../src/migration/mappings/address.js';
import { extendAttributeMapping } from '../../src/migration/mappings/extend-attribute.js';
import { extendDataMapping } from '../../src/migration/mappings/extend-data.js';
import { EXTEND_RCSET_MAPPINGS, extendRcsetMapping } from '../../src/migration/mappings/extend-rcset.js';
import { extendSetMapping } from '../../src/migration/mappings/extend-set.js';
import { extendSubtypeMapping } from '../../src/migration/mappings/extend-subtype.js';
import { favoriteMapping } from '../../src/migration/mappings/favorite.js';
import { interestMapping } from '../../src/migration/mappings/interest.js';
import { personArchiveMapping } from '../../src/migration/mappings/person-archive.js';
import { personMapping } from '../../src/migration/mappings/person.js';
import { tagMapping } from '../../src/migration/mappings/tag.js';
import { TRASH_MAPPINGS, trashMapping } from '../../src/migration/mappings/trash.js';
import { TARGET_ONLY_COLUMNS, UNIT_TABLES, type PeopleTableName } from '../../src/repo/tables.js';

interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  primaryKey: string[];
  columns: string[];
  siteIdColumn: string | null;
  tenantResolution: string;
  tenantParent?: { table: string; join: string };
  split?: { typeColumn?: string } | null;
  targets: OwnershipTarget[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as {
  tables: OwnershipTable[];
};

const MAPPINGS: readonly Mapping[] = [
  personMapping,
  addressMapping,
  interestMapping,
  tagMapping,
  favoriteMapping,
  trashMapping,
  extendSubtypeMapping,
  extendSetMapping,
  extendAttributeMapping,
  extendRcsetMapping,
  extendDataMapping,
  personArchiveMapping,
];

const CASES = MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const);

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function ownershipOf(mapping: Mapping): { table: OwnershipTable; target: OwnershipTarget } {
  const table = OWNERSHIP.tables.find((entry) => entry.table === mapping.legacyTable);
  const target = table?.targets.find((entry) => entry.unit === mapping.unit);
  if (table === undefined || target === undefined) throw new Error(`table ownership has no ${mapping.legacyTable} target ${mapping.unit}`);
  return { table, target };
}

/** The split rule a table-ownership `rowPredicate` describes; the discriminator column is named only when the legacy row holds it. */
function expectedSplit(table: OwnershipTable, predicate: string | null): SplitRule | undefined {
  if (predicate === null) return undefined;
  const baseTables = /^baseTable in \((.+)\)$/.exec(predicate);
  if (baseTables !== null) {
    const value = (baseTables[1] ?? '').split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
    return table.columns.includes('baseTable') ? { by: 'baseTable', value, column: 'baseTable' } : { by: 'baseTable', value };
  }
  const ownerType = /^owner Type = (\d+)$/.exec(predicate);
  if (ownerType !== null) return { by: 'Type', value: Number(ownerType[1]) };
  const ownType = /^Type = (\d+)$/.exec(predicate);
  if (ownType !== null) return { by: 'Type', value: Number(ownType[1]), column: table.split?.typeColumn ?? '' };
  const classOwner = /^classMap owner = (\S+)$/.exec(predicate);
  if (classOwner !== null) return { by: 'objectClass', value: classOwner[1] ?? '' };
  throw new Error(`unrecognised row predicate ${predicate}`);
}

/** The tenant source table ownership's `tenantResolution` and `tenantParent.join` describe for `table`. */
function expectedTenant(table: OwnershipTable): TenantSource {
  if (table.tenantResolution === 'siteID' || table.tenantResolution === 'siteID-or-umbrella') {
    return { kind: 'site', column: table.siteIdColumn ?? '' };
  }
  const [child = '', parent = ''] = (table.tenantParent?.join ?? '').split(' = ').map((side) => side.split('.')[1] ?? '');
  return { kind: 'parent', parentLegacyTable: table.tenantParent?.table ?? '', columns: { [child]: parent } };
}

describe('people mappings against table ownership', () => {
  it.each(CASES)('maps %s onto exactly the key and owned columns of its people unit, in catalog order', (_legacyTable, mapping) => {
    const { table, target } = ownershipOf(mapping);
    const assigned = new Set([...target.keyColumns, ...target.ownedColumns]);

    expect(target.owner).toBe('people');
    expect(mapping.targetTable).toBe(target.unit);
    expect(mapping.columns.map((column) => column.legacy)).toStrictEqual(table.columns.filter((column) => assigned.has(column)));
    expect(mapping.key).toStrictEqual(table.primaryKey);
    expect(mapping.keyless).toBe(false);
    expect(mapping.fold).toBeUndefined();
  });

  it.each(CASES)('selects the people rows of %s by the row predicate table ownership gives', (_legacyTable, mapping) => {
    const { table, target } = ownershipOf(mapping);

    expect(mapping.split).toStrictEqual(expectedSplit(table, target.rowPredicate));
  });

  it.each(CASES)('takes the tenant of %s from the site column or parent row its tenantResolution names', (_legacyTable, mapping) => {
    expect(mapping.tenant).toStrictEqual(expectedTenant(ownershipOf(mapping).table));
  });

  it('covers each legacy table once under its split key, and exports the rcset and trash lists', () => {
    expect(Object.keys(mappingCoverage(MAPPINGS))).toStrictEqual([
      'tusers{Type=2}',
      'tuseraddresses{Type=2}',
      'tusersinterests{Type=2}',
      'tuserstags{Type=2}',
      'tusersfavorites{Type=2}',
      'ttrash{objectClass=people}',
      'tclassextend{baseTable=tusers,tusersaddresses}',
      'tclassextendsets{baseTable=tusers,tusersaddresses}',
      'tclassextendattributes{baseTable=tusers,tusersaddresses}',
      'tclassextendrcsets{baseTable=tusers,tusersaddresses}',
      'tclassextenddatauseractivity{Type=2}',
      'synthetic.person_archive',
    ]);
    expect(EXTEND_RCSET_MAPPINGS).toStrictEqual([extendRcsetMapping]);
    expect(TRASH_MAPPINGS).toStrictEqual([trashMapping]);
  });
});

describe('people mappings against the people table definitions', () => {
  it.each(CASES)('maps %s onto every stored column of its table except tenant_id and target-only columns', (_legacyTable, mapping) => {
    const definition = UNIT_TABLES.find((table) => table.unit === mapping.unit);
    const targetOnly = new Set(['tenant_id', ...(TARGET_ONLY_COLUMNS[definition?.table as PeopleTableName] ?? [])]);
    const targetKey = mapping.key?.map((legacy) => mapping.columns.find((column) => column.legacy === legacy)?.target);

    expect(definition).toBeDefined();
    expect([...mapping.targetColumns].sort(byName)).toStrictEqual(
      [...(definition?.columns ?? [])].filter((column) => !targetOnly.has(column.name)).sort(byName),
    );
    expect(targetKey).toStrictEqual(definition?.key);
  });

  it('leaves the person row_version to the target', () => {
    expect(TARGET_ONLY_COLUMNS.person).toStrictEqual(['row_version']);
    expect(personMapping.targetColumns.map((column) => column.name)).not.toContain('row_version');
  });
});

describe('split discriminators', () => {
  it.each<[string, Mapping, Record<string, unknown>, string | number | null | undefined, boolean]>([
    ['a Type=2 person by its own Type column', personMapping, { Type: 2 }, undefined, true],
    ['a group row by its own Type, whatever the discriminator', personMapping, { Type: 1 }, 2, false],
    ['a person whose Type arrives as padded text', personMapping, { type: '2 ' }, undefined, true],
    ['an address of a Type=2 owner', addressMapping, { userID: 'U-A' }, 2, true],
    ['an address of a group owner', addressMapping, { userID: 'G-A' }, 1, false],
    ['an address without an owner', addressMapping, { userID: 'X' }, null, false],
    ['an interest of a Type=2 owner given as text', interestMapping, { userID: 'U-A' }, '2', true],
    ['a tag without its owner discriminator', tagMapping, { userID: 'U-A' }, undefined, false],
    ['a favorite of a Type=2 owner', favoriteMapping, { userID: 'U-A' }, 2, true],
    ['a trash row whose class-map owner is people', trashMapping, { objectClass: 'userBean' }, 'people', true],
    ['a trash row whose class-map owner is identity', trashMapping, { objectClass: 'people' }, 'identity', false],
    ['an address subtype by its own baseTable, ignoring case and padding', extendSubtypeMapping, { baseTable: 'TUSERSADDRESSES ' }, undefined, true],
    ['a content subtype by its own baseTable', extendSubtypeMapping, { baseTable: 'tcontent' }, 'tusers', false],
    ['a set of a user subtype', extendSetMapping, { subTypeID: 'S1' }, 'tusers', true],
    ['an attribute of a site subtype', extendAttributeMapping, { extendSetID: 'SET1' }, 'tsettings', false],
    ['a related-content set of an address subtype', extendRcsetMapping, { subTypeID: 'S2' }, 'tusersaddresses', true],
    ['an extended value of a Type=2 user', extendDataMapping, { baseID: 'U-A' }, 2, true],
    ['an extended value of a group', extendDataMapping, { baseID: 'G-A' }, 1, false],
    ['an extended value of a Type=2 user\'s address, by its owner\'s Type as text', extendDataMapping, { baseID: 'ADDR-A' }, '2 ', true],
    ['an extended value whose owner does not resolve', extendDataMapping, { baseID: 'X' }, null, false],
    ['an archive row, which has no split', personArchiveMapping, {}, undefined, true],
  ])('answers %s', (_label, mapping, row, discriminator, accepted) => {
    expect(mapping.acceptsRow(row, discriminator)).toBe(accepted);
  });
});

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: TENANT_UMBRELLA.siteId,
  parentSiteId: (parentLegacyTable, parentKey) => (parentLegacyTable === 'tusers' && parentKey.UserID === 'U-B' ? TENANT_B.siteId : null),
};

/** The legacy site column a site-sourced mapping reads. */
function siteColumnOf(mapping: Mapping): string {
  if (mapping.tenant?.kind !== 'site') throw new Error(`${mapping.legacyTable} is not site-sourced`);
  return mapping.tenant.column;
}

describe('tenant resolution of people rows', () => {
  const siteSourced = CASES.filter(([, mapping]) => mapping.tenant?.kind === 'site');

  it.each(siteSourced)('resolves a %s row to the tenant of its space-padded site', (_legacyTable, mapping) => {
    const row = { [siteColumnOf(mapping)]: `${TENANT_A.siteId}   ` };

    expect(resolveTenant(mapping.tenant as TenantSource, row, LOOKUPS)).toStrictEqual({ tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, orphan: false });
  });

  it.each(siteSourced)('loads a %s row without a site under the umbrella as an orphan', (_legacyTable, mapping) => {
    for (const site of [null, '', '  ']) {
      expect(resolveTenant(mapping.tenant as TenantSource, { [siteColumnOf(mapping)]: site }, LOOKUPS)).toStrictEqual({
        tenantId: TENANT_UMBRELLA.tenantId,
        siteId: TENANT_UMBRELLA.siteId,
        orphan: true,
      });
    }
  });

  it.each<[string, Record<string, unknown>, string, boolean]>([
    ['an interest to the tenant of its owning user', { userID: 'U-B', categoryID: 'C1' }, TENANT_B.siteId, false],
    ['an interest whose owner is unknown to the umbrella as an orphan', { userID: 'U-X', categoryID: 'C1' }, TENANT_UMBRELLA.siteId, true],
    ['an interest without an owner id to the umbrella as an orphan', { userID: null, categoryID: 'C1' }, TENANT_UMBRELLA.siteId, true],
  ])('resolves %s', (_label, row, siteId, orphan) => {
    expect(resolveTenant(interestMapping.tenant as TenantSource, row, LOOKUPS)).toStrictEqual({ tenantId: tenantIdForSite(siteId), siteId, orphan });
  });
});

/** A sample legacy value of `column`'s canonical type, distinct per column name. */
function sampleValue(column: CanonicalColumn, index: number): unknown {
  switch (column.type) {
    case 'i':
      return index + 1;
    case 'f':
      return index + 0.25;
    case 't':
      return new Date(2026, 5, 30, 10, index % 60, 5, 123);
    default:
      return `${column.name}-${String(index)}`;
  }
}

describe('row round trips', () => {
  it.each(CASES)('carries every %s column from its canonical encoding to the target row and back byte-exact', (_legacyTable, mapping) => {
    const legacy = Object.fromEntries(mapping.legacyColumns.map((column, index) => [column.name, sampleValue(column, index)]));
    const encoding = encodeRow(mapping.legacyColumns, legacy);

    const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

    expect(Object.keys(target)).toStrictEqual(mapping.columns.map((column) => column.target));
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(mapping.encodeLegacyKey(target)).toBe(encodeKey(mapping.legacyColumns, mapping.key ?? [], legacy));
    expect(Object.keys(mapping.toLegacy(target))).toStrictEqual(mapping.columns.map((column) => column.legacy));
  });

  it('keeps nulls and the byte-exact WDDX of a trash row', () => {
    const wddx = '<wddxPacket version=\'1.0\'><header/><data><struct><var name=\'FNAME\'><string>Pat</string></var></struct></data></wddxPacket>\r\n';
    const legacy = Object.fromEntries(trashMapping.legacyColumns.map((column) => [column.name, null]));
    const target = trashMapping.toTarget({ ...legacy, objectID: 'U-A', objectstring: wddx, siteID: TENANT_A.siteId });

    expect(target).toMatchObject({ objectid: 'U-A', objectstring: wddx, siteid: TENANT_A.siteId, deleteddate: null, orderno: null });
  });
});

describe('mapping construction against a drifted table definition', () => {
  afterEach(() => {
    vi.doUnmock('../../src/repo/tables.js');
    vi.resetModules();
  });

  type Definition = 'PERSON' | 'ADDRESS' | 'INTEREST' | 'TAG' | 'FAVORITE' | 'EXTEND_SET' | 'EXTEND_ATTRIBUTE' | 'EXTEND_RCSET' | 'EXTEND_DATA';

  it.each<{ legacyTable: string; definition: Definition; dropped: string; message: string; load: () => Promise<unknown> }>([
    { legacyTable: 'tusers', definition: 'PERSON', dropped: 'IMService', message: 'people.person has no column imservice', load: () => import('../../src/migration/mappings/person.js') },
    { legacyTable: 'tuseraddresses', definition: 'ADDRESS', dropped: 'addressURL', message: 'people.user_address has no column addressurl', load: () => import('../../src/migration/mappings/address.js') },
    { legacyTable: 'tusersinterests', definition: 'INTEREST', dropped: 'categoryID', message: 'people.user_interest has no column categoryid', load: () => import('../../src/migration/mappings/interest.js') },
    { legacyTable: 'tuserstags', definition: 'TAG', dropped: 'tag', message: 'people.user_tag has no column tag', load: () => import('../../src/migration/mappings/tag.js') },
    { legacyTable: 'tusersfavorites', definition: 'FAVORITE', dropped: 'maxRSSItems', message: 'people.user_favorite has no column maxrssitems', load: () => import('../../src/migration/mappings/favorite.js') },
    { legacyTable: 'tclassextendsets', definition: 'EXTEND_SET', dropped: 'isActive', message: 'people.extend_set declares no column for isActive', load: () => import('../../src/migration/mappings/extend-set.js') },
    { legacyTable: 'tclassextendattributes', definition: 'EXTEND_ATTRIBUTE', dropped: 'defaultValue', message: 'people.extend_attribute declares no column for defaultValue', load: () => import('../../src/migration/mappings/extend-attribute.js') },
    { legacyTable: 'tclassextendrcsets', definition: 'EXTEND_RCSET', dropped: 'orderNo', message: 'people.extend_rc_set declares no column for orderNo', load: () => import('../../src/migration/mappings/extend-rcset.js') },
    { legacyTable: 'tclassextenddatauseractivity', definition: 'EXTEND_DATA', dropped: 'numericvalue', message: 'people.extend_data_user_activity declares no column for numericvalue', load: () => import('../../src/migration/mappings/extend-data.js') },
  ])('refuses to build $legacyTable when its target lacks the column for $dropped', async ({ legacyTable, definition, dropped, message, load }) => {
    vi.resetModules();
    vi.doMock('../../src/repo/tables.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/repo/tables.js')>();
      const columns = actual[definition].columns.filter((column) => column.name !== dropped.toLowerCase());
      return { ...actual, [definition]: { ...actual[definition], columns } };
    });

    const failure: unknown = await load().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ name: 'MappingError', table: legacyTable });
    expect((failure as Error).message).toBe(`${legacyTable}: ${message}`);
  });
});
