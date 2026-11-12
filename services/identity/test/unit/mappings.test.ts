/** Identity's auth-record and membership mappings against table ownership: columns, keys, tenant sources, the ttrash share, row round trips and drifted definitions. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mappingCoverage, resolveTenant, type Mapping, type TenantLookups, type TenantSource } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import {
  toauthclientsMapping,
  toauthtokensMapping,
  tredirectsMapping,
  ttrashGroupMapping,
  tuserdeviceMapping,
  tuserremotesessionsMapping,
  tuserstrikesMapping,
} from '../../src/migration/mappings/auth-records.js';
import { tpermissionsMapping, tusersmembMapping } from '../../src/migration/mappings/memberships.js';
import { UNIT_TABLES } from '../../src/repo/tables.js';

interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  siteIdColumn: string | null;
  tenantResolution: string;
  tenantParent?: { table: string; join: string };
  split?: { by: string; classMap: Array<{ classes: string[]; owner?: string; owners?: Record<string, string> }> };
  targets: OwnershipTarget[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as {
  tables: OwnershipTable[];
};

const MAPPINGS: readonly Mapping[] = [
  tuserstrikesMapping,
  tuserremotesessionsMapping,
  tuserdeviceMapping,
  tredirectsMapping,
  toauthclientsMapping,
  toauthtokensMapping,
  ttrashGroupMapping,
  tusersmembMapping,
  tpermissionsMapping,
];

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function ownershipOf(mapping: Mapping): { table: OwnershipTable; target: OwnershipTarget } {
  const table = OWNERSHIP.tables.find((entry) => entry.table === mapping.legacyTable);
  const target = table?.targets.find((entry) => entry.unit === mapping.unit);
  if (table === undefined || target === undefined) throw new Error(`table ownership has no ${mapping.legacyTable} target ${mapping.unit}`);
  return { table, target };
}

/** The tenant source table ownership's `tenantResolution` and `tenantParent.join` describe for `table`. */
function expectedTenant(table: OwnershipTable): TenantSource {
  if (table.tenantResolution === 'siteID' || table.tenantResolution === 'siteID-or-umbrella') {
    return { kind: 'site', column: table.siteIdColumn ?? '' };
  }
  const [child = '', parent = ''] = (table.tenantParent?.join ?? '').split(' = ').map((side) => side.split('.')[1] ?? '');
  return { kind: 'parent', parentLegacyTable: table.tenantParent?.table ?? '', columns: { [child]: parent } };
}

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: TENANT_UMBRELLA.siteId,
  parentSiteId: (parentLegacyTable, parentKey) => {
    const sites: Record<string, Record<string, string>> = {
      tusers: { 'U-A': TENANT_A.siteId, admin: TENANT_A.siteId },
      toauthclients: { 'C-B': TENANT_B.siteId },
    };
    return sites[parentLegacyTable]?.[String(Object.values(parentKey)[0])] ?? null;
  },
};

describe('identity auth-record and membership mappings', () => {
  it.each(MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'maps %s onto exactly the columns and key table ownership assigns to its identity unit',
    (_legacyTable, mapping) => {
      const { target } = ownershipOf(mapping);

      expect(target.owner).toBe('identity');
      expect(mapping.targetTable).toBe(target.unit);
      expect(mapping.columns.map((column) => column.legacy)).toStrictEqual(target.ownedColumns);
      expect(mapping.key).toStrictEqual(target.keyColumns);
      expect(mapping.keyless).toBe(false);
    },
  );

  it.each(MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'maps %s onto every non-tenant column of its identity table, with its canonical types and key',
    (_legacyTable, mapping) => {
      const definition = UNIT_TABLES.find((table) => table.unit === mapping.unit);
      const targetKey = mapping.key?.map((legacy) => mapping.columns.find((column) => column.legacy === legacy)?.target);

      expect([...mapping.targetColumns].sort(byName)).toStrictEqual(
        [...(definition?.columns ?? [])].filter((column) => column.name !== 'tenant_id').sort(byName),
      );
      expect(targetKey).toStrictEqual(definition?.key);
    },
  );

  it.each(MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'takes the tenant of %s from the site column or parent row its table-ownership tenantResolution names',
    (_legacyTable, mapping) => {
      expect(mapping.tenant).toStrictEqual(expectedTenant(ownershipOf(mapping).table));
    },
  );

  it('covers each legacy table once, and ttrash only as the identity objectClass share', () => {
    expect(Object.keys(mappingCoverage(MAPPINGS))).toStrictEqual([
      'tuserstrikes',
      'tuserremotesessions',
      'tuserdevice',
      'tredirects',
      'toauthclients',
      'toauthtokens',
      'ttrash{objectClass=identity}',
      'tusersmemb',
      'tpermissions',
    ]);
  });
});

describe('tenant resolution of identity rows', () => {
  it.each<[string, Mapping, Record<string, unknown>, string, boolean]>([
    ['a strike row to the tenant of the account with its username', tuserstrikesMapping, { username: 'admin' }, TENANT_A.siteId, false],
    ['a strike row without an account to the umbrella as an orphan', tuserstrikesMapping, { username: 'nobody' }, TENANT_UMBRELLA.siteId, true],
    ['a remote session to the tenant of its user', tuserremotesessionsMapping, { userID: 'U-A' }, TENANT_A.siteId, false],
    ['a device to the tenant of its own site', tuserdeviceMapping, { siteID: `${TENANT_B.siteId}  ` }, TENANT_B.siteId, false],
    ['a redirect without a site to the umbrella as an orphan', tredirectsMapping, { siteid: null }, TENANT_UMBRELLA.siteId, true],
    ['an OAuth token to the tenant of its client', toauthtokensMapping, { clientid: 'C-B' }, TENANT_B.siteId, false],
    ['a membership to the tenant of its member', tusersmembMapping, { UserID: 'U-A', GroupID: 'G-B' }, TENANT_A.siteId, false],
    ['a membership without its member row to the umbrella as an orphan', tusersmembMapping, { UserID: 'U-X', GroupID: 'G-B' }, TENANT_UMBRELLA.siteId, true],
    ['a permission to the tenant of its own site', tpermissionsMapping, { SiteID: TENANT_A.siteId }, TENANT_A.siteId, false],
  ])('resolves %s', (_label, mapping, row, siteId, orphan) => {
    expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS)).toStrictEqual({ tenantId: tenantIdForSite(siteId), siteId, orphan });
  });
});

describe('ttrash identity share', () => {
  it('splits ttrash by objectClass on the class-map owner each apply row carries', () => {
    const { table, target } = ownershipOf(ttrashGroupMapping);
    const identityClasses = (table.split?.classMap ?? []).filter(
      (entry) => entry.owner === 'identity' || Object.values(entry.owners ?? {}).includes('identity'),
    );

    expect(target.rowPredicate).toBe('classMap owner = identity');
    expect(identityClasses.flatMap((entry) => entry.classes)).toStrictEqual(['group', 'user', 'address']);
    expect(ttrashGroupMapping.split).toStrictEqual({ by: 'objectClass', value: 'identity' });
  });

  it.each<[boolean, string, Record<string, unknown>, string | undefined]>([
    [true, 'a row whose discriminator is identity', { objectClass: 'group' }, 'identity'],
    [true, 'a discriminator differing in case and trailing padding', { objectClass: 'user' }, 'IDENTITY  '],
    [false, 'a row whose discriminator is people', { objectClass: 'user' }, 'people'],
    [false, 'a group row without a discriminator', { objectClass: 'group' }, undefined],
  ])('answers %s for %s', (accepted, _label, row, discriminator) => {
    expect(ttrashGroupMapping.acceptsRow(row, discriminator)).toBe(accepted);
  });
});

describe('row round trips', () => {
  it.each<[string, Mapping, Record<string, string | null>, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a strike row with its count and attempt time',
      tuserstrikesMapping,
      { username: 'admin', strikes: '3', lastAttempt: '2026-06-30T11:58:59.123' },
      { username: 'admin', strikes: '3', lastattempt: '2026-06-30 11:58:59.123' },
      { username: 'admin', strikes: '3', lastAttempt: '2026-06-30 11:58:59.123' },
    ],
    [
      'an OAuth token with its serialized data byte-exact',
      toauthtokensMapping,
      { granttype: 'client_credentials', userid: 'U-A', clientid: 'C-B', accessCode: null, data: '{"SCOPE":"read" }\r\n', expires: '2026-06-30T13:00:00.000', token: 'T-1' },
      { granttype: 'client_credentials', userid: 'U-A', clientid: 'C-B', accesscode: null, data: '{"SCOPE":"read" }\r\n', expires: '2026-06-30 13:00:00.000', token: 'T-1' },
      { granttype: 'client_credentials', userid: 'U-A', clientid: 'C-B', accessCode: null, data: '{"SCOPE":"read" }\r\n', expires: '2026-06-30 13:00:00.000', token: 'T-1' },
    ],
    [
      'a membership',
      tusersmembMapping,
      { UserID: 'U-A', GroupID: 'G-B' },
      { userid: 'U-A', groupid: 'G-B' },
      { UserID: 'U-A', GroupID: 'G-B' },
    ],
    [
      'a permission, matching legacy column names case-insensitively',
      tpermissionsMapping,
      { contentid: '00000000000000000000000000000000001', GROUPID: 'G-B', SiteID: TENANT_A.siteId, Type: 'editor' },
      { contentid: '00000000000000000000000000000000001', groupid: 'G-B', siteid: TENANT_A.siteId, type: 'editor' },
      { ContentID: '00000000000000000000000000000000001', GroupID: 'G-B', SiteID: TENANT_A.siteId, Type: 'editor' },
    ],
  ])('maps %s onto its target row and back', (_label, mapping, legacy, target, back) => {
    const row = mapping.toTarget(legacy);

    expect(row).toStrictEqual(target);
    expect(mapping.toLegacy(row)).toStrictEqual(back);
  });
});

describe('mapping construction against a drifted table definition', () => {
  afterEach(() => {
    vi.doUnmock('../../src/repo/tables.js');
    vi.resetModules();
  });

  it.each<{ legacyTable: string; definition: 'USER_STRIKE' | 'OAUTH_TOKEN' | 'MEMBERSHIP'; unit: string; dropped: string; load: () => Promise<unknown> }>([
    { legacyTable: 'tuserstrikes', definition: 'USER_STRIKE', unit: 'identity.user_strike', dropped: 'lastAttempt', load: () => import('../../src/migration/mappings/auth-records.js') },
    { legacyTable: 'toauthtokens', definition: 'OAUTH_TOKEN', unit: 'identity.oauth_token', dropped: 'accessCode', load: () => import('../../src/migration/mappings/auth-records.js') },
    { legacyTable: 'tusersmemb', definition: 'MEMBERSHIP', unit: 'identity.membership', dropped: 'GroupID', load: () => import('../../src/migration/mappings/memberships.js') },
  ])('refuses to build $legacyTable when its target lacks the column for $dropped', async ({ legacyTable, definition, unit, dropped, load }) => {
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
