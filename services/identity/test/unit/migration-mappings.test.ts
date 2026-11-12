/** Identity's tusers and group-child mappings and the mapping barrel against table ownership and the identity table definitions: columns, keys, splits, tenant sources, row round trips and drifted definitions. */
import { Buffer } from 'node:buffer';
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
import * as authRecords from '../../src/migration/mappings/auth-records.js';
import * as groupChildren from '../../src/migration/mappings/group-children.js';
import * as barrel from '../../src/migration/mappings/index.js';
import * as memberships from '../../src/migration/mappings/memberships.js';
import * as tusers from '../../src/migration/mappings/tusers.js';
import { IDENTITY_UNITS, UNIT_TABLES } from '../../src/repo/tables.js';

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

const {
  tusersGroupAccountMapping,
  tusersUserAccountMapping,
  tusersCredentialMapping,
  tusersLoginStateMapping,
  tuseraddressesGroupMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
  tusersfavoritesGroupMapping,
  tclassextenddatauseractivityGroupMapping,
} = barrel;

const MAPPINGS: readonly Mapping[] = [
  tusersGroupAccountMapping,
  tusersUserAccountMapping,
  tusersCredentialMapping,
  tusersLoginStateMapping,
  tuseraddressesGroupMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
  tusersfavoritesGroupMapping,
  tclassextenddatauseractivityGroupMapping,
];

const CASES = MAPPINGS.map((mapping) => [mapping.unit, mapping] as const);

// The target-only columns tables.ts documents on the two account tables; no legacy column feeds them.
const TARGET_ONLY: Readonly<Record<string, readonly string[]>> = {
  'identity.group_account': ['row_version'],
  'identity.user_account': ['opt2_state'],
};

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
  const ownerType = /^owner Type = (\d+)$/.exec(predicate);
  if (ownerType !== null) return { by: 'Type', value: Number(ownerType[1]) };
  const ownType = /^Type = (\d+)$/.exec(predicate);
  if (ownType !== null) return { by: 'Type', value: Number(ownType[1]), column: table.split?.typeColumn ?? '' };
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

/** Owned legacy columns of every identity target of `legacyTable` selected by `predicate`, in mappingCoverage's sorted order. */
function identityColumnsFor(legacyTable: string, predicate: string): string[] {
  const table = OWNERSHIP.tables.find((entry) => entry.table === legacyTable);
  const owned = new Set(
    (table?.targets ?? [])
      .filter((target) => target.owner === 'identity' && target.rowPredicate === predicate)
      .flatMap((target) => [...target.keyColumns, ...target.ownedColumns]),
  );
  return [...owned].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

describe('tusers and group-child mappings against table ownership', () => {
  it.each(CASES)('maps %s onto exactly the key and owned columns table ownership assigns, in catalog order', (_unit, mapping) => {
    const { table, target } = ownershipOf(mapping);
    const assigned = new Set([...target.keyColumns, ...target.ownedColumns]);

    expect(target.owner).toBe('identity');
    expect(mapping.targetTable).toBe(target.unit);
    expect(mapping.columns.map((column) => column.legacy)).toStrictEqual(table.columns.filter((column) => assigned.has(column)));
    expect(mapping.key).toStrictEqual(table.primaryKey);
    expect(mapping.key).toStrictEqual(target.keyColumns);
    expect(mapping.keyless).toBe(false);
    expect(mapping.fold).toBeUndefined();
  });

  it.each(CASES)('selects the rows of %s by the row predicate table ownership gives', (_unit, mapping) => {
    const { table, target } = ownershipOf(mapping);

    expect(mapping.split).toStrictEqual(expectedSplit(table, target.rowPredicate));
  });

  it.each(CASES)('takes the tenant of %s from the site column or parent row its tenantResolution names', (_unit, mapping) => {
    expect(mapping.tenant).toStrictEqual(expectedTenant(ownershipOf(mapping).table));
  });

  it('covers every tusers column for groups, the identity share for users, and each group-child table once', () => {
    const coverage = mappingCoverage(MAPPINGS);

    expect(Object.keys(coverage)).toStrictEqual([
      'tusers{Type=1}',
      'tusers{Type=2}',
      'tuseraddresses{Type=1}',
      'tusersinterests{Type=1}',
      'tuserstags{Type=1}',
      'tusersfavorites{Type=1}',
      'tclassextenddatauseractivity{Type=1}',
    ]);
    expect(coverage['tusers{Type=1}']).toHaveLength(OWNERSHIP.tables.find((entry) => entry.table === 'tusers')?.columns.length ?? -1);
    expect(coverage['tusers{Type=1}']).toStrictEqual(identityColumnsFor('tusers', 'Type = 1'));
    expect(coverage['tusers{Type=2}']).toStrictEqual(identityColumnsFor('tusers', 'Type = 2'));
  });
});

describe('tusers and group-child mappings against the identity table definitions', () => {
  it.each(CASES)('maps %s onto every stored column of its table except tenant_id and target-only columns', (_unit, mapping) => {
    const definition = UNIT_TABLES.find((table) => table.unit === mapping.unit);
    const skipped = new Set(['tenant_id', ...(TARGET_ONLY[mapping.unit] ?? [])]);
    const targetKey = mapping.key?.map((legacy) => mapping.columns.find((column) => column.legacy === legacy)?.target);

    expect(definition).toBeDefined();
    expect([...mapping.targetColumns].sort(byName)).toStrictEqual(
      [...(definition?.columns ?? [])].filter((column) => !skipped.has(column.name)).sort(byName),
    );
    expect(targetKey).toStrictEqual(definition?.key);
  });

  it('leaves row_version and opt2_state to the target', () => {
    for (const [unit, columns] of Object.entries(TARGET_ONLY)) {
      const definition = UNIT_TABLES.find((table) => table.unit === unit);
      const mapping = MAPPINGS.find((candidate) => candidate.unit === unit);
      expect(definition?.columns.map((column) => column.name)).toEqual(expect.arrayContaining([...columns]));
      expect(mapping?.targetColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([...columns]));
    }
  });
});

describe('mapping barrel', () => {
  it('lists one mapping per identity unit in IDENTITY_UNITS order, frozen', () => {
    expect(barrel.mappings.map((mapping) => mapping.unit)).toStrictEqual([...IDENTITY_UNITS]);
    expect(Object.isFrozen(barrel.mappings)).toBe(true);
  });

  it('re-exports every mapping of the four mapping modules unchanged and lists each of them', () => {
    const modules: Record<string, Mapping> = { ...tusers, ...memberships, ...groupChildren, ...authRecords };
    const exported: Record<string, unknown> = { ...barrel };

    expect(Object.keys(exported).filter((name) => name !== 'mappings').sort()).toStrictEqual(Object.keys(modules).sort());
    expect(barrel.mappings).toHaveLength(Object.keys(modules).length);
    for (const [name, mapping] of Object.entries(modules)) {
      expect(exported[name]).toBe(mapping);
      expect(barrel.mappings).toContain(mapping);
    }
  });
});

describe('split discriminators', () => {
  it.each<[string, Mapping, Record<string, unknown>, string | number | null | undefined, boolean]>([
    ['a group by its own Type column', tusersGroupAccountMapping, { Type: 1 }, undefined, true],
    ['a group whose Type arrives as padded text', tusersGroupAccountMapping, { type: '1 ' }, undefined, true],
    ['a user row as a group, whatever the discriminator', tusersGroupAccountMapping, { Type: 2 }, 1, false],
    ['a user account by its own Type column', tusersUserAccountMapping, { Type: 2 }, undefined, true],
    ['a group row as a credential', tusersCredentialMapping, { Type: 1 }, undefined, false],
    ['a login state whose Type arrives as text', tusersLoginStateMapping, { Type: '2' }, undefined, true],
    ['a tusers row without its Type column or a discriminator', tusersUserAccountMapping, { UserID: 'U-A' }, undefined, false],
    ['an address of a group owner', tuseraddressesGroupMapping, { userID: 'G-A' }, 1, true],
    ['an address of a Type=2 owner', tuseraddressesGroupMapping, { userID: 'U-A' }, 2, false],
    ['an address without an owner', tuseraddressesGroupMapping, { userID: 'X' }, null, false],
    ['an interest of a group owner given as text', tusersinterestsGroupMapping, { userID: 'G-A' }, '1', true],
    ['a tag without its owner discriminator', tuserstagsGroupMapping, { userID: 'G-A' }, undefined, false],
    ['a favorite of a group owner, ignoring its own type column', tusersfavoritesGroupMapping, { type: 'Link' }, 1, true],
    ['a favorite whose own type column reads 1, owned by a user', tusersfavoritesGroupMapping, { type: '1' }, 2, false],
    ['extended data of a group owner', tclassextenddatauseractivityGroupMapping, { baseID: 'G-A' }, 1, true],
  ])('answers %s', (_label, mapping, row, discriminator, accepted) => {
    expect(mapping.acceptsRow(row, discriminator)).toBe(accepted);
  });
});

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: TENANT_UMBRELLA.siteId,
  parentSiteId: (parentLegacyTable, parentKey) => {
    const sites: Record<string, string> = { 'G-A': TENANT_A.siteId, 'G-B': TENANT_B.siteId };
    return parentLegacyTable === 'tusers' ? (sites[String(parentKey.UserID)] ?? null) : null;
  },
};

/** The legacy site column a site-sourced mapping reads. */
function siteColumnOf(mapping: Mapping): string {
  if (mapping.tenant?.kind !== 'site') throw new Error(`${mapping.legacyTable} is not site-sourced`);
  return mapping.tenant.column;
}

describe('tenant resolution of identity rows', () => {
  const siteSourced = CASES.filter(([, mapping]) => mapping.tenant?.kind === 'site');

  it('sources every mapping but tusersinterests from its own site column', () => {
    expect(siteSourced.map(([unit]) => unit)).toStrictEqual(CASES.map(([unit]) => unit).filter((unit) => unit !== 'identity.user_interest'));
  });

  it.each(siteSourced)('resolves %s rows to the tenant of their space-padded site', (_unit, mapping) => {
    const row = { [siteColumnOf(mapping)]: `${TENANT_A.siteId}   ` };

    expect(resolveTenant(mapping.tenant as TenantSource, row, LOOKUPS)).toStrictEqual({ tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, orphan: false });
  });

  it.each(siteSourced)('loads %s rows without a site under the umbrella as orphans', (_unit, mapping) => {
    for (const site of [null, '', '  ']) {
      expect(resolveTenant(mapping.tenant as TenantSource, { [siteColumnOf(mapping)]: site }, LOOKUPS)).toStrictEqual({
        tenantId: TENANT_UMBRELLA.tenantId,
        siteId: TENANT_UMBRELLA.siteId,
        orphan: true,
      });
    }
  });

  it.each<[string, Mapping, Record<string, unknown>, string, boolean]>([
    ['an interest to the tenant of its owning group', tusersinterestsGroupMapping, { userID: 'G-B', categoryID: 'C1' }, TENANT_B.siteId, false],
    ['an interest whose owner is unknown to the umbrella as an orphan', tusersinterestsGroupMapping, { userID: 'G-X', categoryID: 'C1' }, TENANT_UMBRELLA.siteId, true],
    ['an interest without an owner id to the umbrella as an orphan', tusersinterestsGroupMapping, { userID: null, categoryID: 'C1' }, TENANT_UMBRELLA.siteId, true],
    ['an address to its own site, not its owning group\'s', tuseraddressesGroupMapping, { userID: 'G-A', siteID: TENANT_B.siteId }, TENANT_B.siteId, false],
    ['a tag to the tenant of its lower-case siteid column', tuserstagsGroupMapping, { userID: 'G-A', siteid: TENANT_B.siteId }, TENANT_B.siteId, false],
  ])('resolves %s', (_label, mapping, row, siteId, orphan) => {
    expect(resolveTenant(mapping.tenant as TenantSource, row, LOOKUPS)).toStrictEqual({ tenantId: tenantIdForSite(siteId), siteId, orphan });
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
  it.each(CASES)('carries every %s column from its canonical encoding to the target row and back byte-exact', (_unit, mapping) => {
    const legacy = Object.fromEntries(mapping.legacyColumns.map((column, index) => [column.name, sampleValue(column, index)]));
    const encoding = encodeRow(mapping.legacyColumns, legacy);

    const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

    expect(Object.keys(target)).toStrictEqual(mapping.columns.map((column) => column.target));
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(mapping.encodeLegacyKey(target)).toBe(encodeKey(mapping.legacyColumns, mapping.key ?? [], legacy));
    expect(Object.keys(mapping.toLegacy(target))).toStrictEqual(mapping.columns.map((column) => column.legacy));
  });

  it('keeps NULL apart from the empty string and a stored hash byte-exact in a group row', () => {
    const hash = '$2a$10$abc:def/ghi  ';
    const legacy = Object.fromEntries(tusersGroupAccountMapping.legacyColumns.map((column) => [column.name, null]));
    const row = { ...legacy, UserID: 'G-A', Type: '1', Password: hash, Email: '', SiteID: TENANT_A.siteId };
    const encoding = encodeRow(tusersGroupAccountMapping.legacyColumns, row);

    const target = tusersGroupAccountMapping.toTarget(row);

    expect(target).toMatchObject({ userid: 'G-A', type: '1', password: hash, email: '', fname: null, lastlogin: null });
    expect(tusersGroupAccountMapping.encodeLegacy(target)).toBe(encoding);
    expect(encoding).toContain(`s${String(Buffer.byteLength(hash))}:${hash}`);
    expect(encoding).toContain('s0:');
  });

  it.each<[string, Mapping, number, boolean]>([
    ['the credential of a user row', tusersCredentialMapping, 2, true],
    ['the credential of a group row', tusersCredentialMapping, 1, false],
    ['the login state of a user row', tusersLoginStateMapping, 2, true],
    ['the account of a group row', tusersUserAccountMapping, 1, false],
  ])('decodes %s from a whole tusers row with the Type the split reads', (_label, mapping, type, accepted) => {
    const whole = tusersGroupAccountMapping.legacyColumns;
    const legacy = Object.fromEntries(whole.map((column, index) => [column.name, column.name === 'Type' ? type : sampleValue(column, index)]));

    const decoded = mapping.decodeLegacy(whole, encodeRow(whole, legacy));

    expect(Object.keys(decoded).sort()).toStrictEqual([...new Set([...mapping.columns.map((column) => column.legacy), 'Type'])].sort());
    expect(decoded.Type).toBe(String(type));
    expect(mapping.acceptsRow(decoded)).toBe(accepted);
  });
});

describe('mapping construction against a drifted table definition', () => {
  afterEach(() => {
    vi.doUnmock('../../src/repo/tables.js');
    vi.resetModules();
  });

  type Definition = 'GROUP_ACCOUNT' | 'USER_ACCOUNT' | 'CREDENTIAL' | 'LOGIN_STATE' | 'GROUP_ADDRESS' | 'GROUP_INTEREST' | 'GROUP_TAG' | 'GROUP_FAVORITE' | 'GROUP_EXTEND_DATA';

  it.each<{ legacyTable: string; definition: Definition; unit: string; dropped: string; load: () => Promise<unknown> }>([
    { legacyTable: 'tusers', definition: 'GROUP_ACCOUNT', unit: 'identity.group_account', dropped: 'IMService', load: () => import('../../src/migration/mappings/tusers.js') },
    { legacyTable: 'tusers', definition: 'USER_ACCOUNT', unit: 'identity.user_account', dropped: 'tablist', load: () => import('../../src/migration/mappings/tusers.js') },
    { legacyTable: 'tusers', definition: 'CREDENTIAL', unit: 'identity.credential', dropped: 'PasswordCreated', load: () => import('../../src/migration/mappings/tusers.js') },
    { legacyTable: 'tusers', definition: 'LOGIN_STATE', unit: 'identity.login_state', dropped: 'LastLogin', load: () => import('../../src/migration/mappings/tusers.js') },
    { legacyTable: 'tuseraddresses', definition: 'GROUP_ADDRESS', unit: 'identity.user_address', dropped: 'addressURL', load: () => import('../../src/migration/mappings/group-children.js') },
    { legacyTable: 'tusersinterests', definition: 'GROUP_INTEREST', unit: 'identity.user_interest', dropped: 'categoryID', load: () => import('../../src/migration/mappings/group-children.js') },
    { legacyTable: 'tuserstags', definition: 'GROUP_TAG', unit: 'identity.user_tag', dropped: 'tag', load: () => import('../../src/migration/mappings/group-children.js') },
    { legacyTable: 'tusersfavorites', definition: 'GROUP_FAVORITE', unit: 'identity.user_favorite', dropped: 'maxRSSItems', load: () => import('../../src/migration/mappings/group-children.js') },
    { legacyTable: 'tclassextenddatauseractivity', definition: 'GROUP_EXTEND_DATA', unit: 'identity.extend_data_user_activity', dropped: 'stringvalue', load: () => import('../../src/migration/mappings/group-children.js') },
  ])('refuses to build $unit when its table lacks the column for $dropped', async ({ legacyTable, definition, unit, dropped, load }) => {
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
    expect((failure as Error).message).toBe(`${legacyTable}: ${unit} has no column ${dropped.toLowerCase()}`);
  });
});
