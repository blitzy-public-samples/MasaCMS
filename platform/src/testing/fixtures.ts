import { tenantIdForSite, withMetadata } from '../tenancy/index.js';
import type { PoolKind, SiteChangedPayload, TenantDb } from '../tenancy/index.js';

/** One of the three seeded tenants every isolation, event and security suite uses. */
export interface TenantFixture {
  readonly key: 'A' | 'B' | 'umbrella';
  readonly siteId: string;
  readonly tenantId: string;
}

/** An ordered (writer, reader) pair of distinct fixtures. */
export interface CrossTenantPair {
  readonly writer: TenantFixture;
  readonly reader: TenantFixture;
}

function defineFixture(key: TenantFixture['key'], siteId: string): TenantFixture {
  return Object.freeze({ key, siteId, tenantId: tenantIdForSite(siteId) });
}

/** Fixture of site `tenant-a`. */
export const TENANT_A: TenantFixture = defineFixture('A', 'tenant-a');

/** Fixture of site `tenant-b`. */
export const TENANT_B: TenantFixture = defineFixture('B', 'tenant-b');

/** Fixture of the pool site `umbrella`. */
export const TENANT_UMBRELLA: TenantFixture = defineFixture('umbrella', 'umbrella');

/** The fixtures by key. */
export const TENANTS: Readonly<Record<TenantFixture['key'], TenantFixture>> = Object.freeze({
  A: TENANT_A,
  B: TENANT_B,
  umbrella: TENANT_UMBRELLA,
});

/** The fixtures in their fixed order: A, B, umbrella. */
export const TENANT_LIST = Object.freeze([TENANT_A, TENANT_B, TENANT_UMBRELLA] as const);

interface SitePools {
  readonly pools: Readonly<Record<PoolKind, string>>;
  readonly content: readonly string[];
}

const SITE_POOLS: Readonly<Record<TenantFixture['key'], SitePools>> = Object.freeze({
  A: Object.freeze({
    pools: Object.freeze({
      publicUser: TENANT_UMBRELLA.siteId,
      privateUser: TENANT_A.siteId,
      category: TENANT_UMBRELLA.siteId,
      file: TENANT_UMBRELLA.siteId,
      display: TENANT_UMBRELLA.siteId,
    }),
    content: Object.freeze([TENANT_A.siteId]),
  }),
  B: Object.freeze({
    pools: Object.freeze({
      publicUser: TENANT_B.siteId,
      privateUser: TENANT_B.siteId,
      category: TENANT_B.siteId,
      file: TENANT_B.siteId,
      display: TENANT_B.siteId,
    }),
    content: Object.freeze([TENANT_B.siteId]),
  }),
  umbrella: Object.freeze({
    pools: Object.freeze({
      publicUser: TENANT_UMBRELLA.siteId,
      privateUser: TENANT_UMBRELLA.siteId,
      category: TENANT_UMBRELLA.siteId,
      file: TENANT_UMBRELLA.siteId,
      display: TENANT_UMBRELLA.siteId,
    }),
    content: Object.freeze([TENANT_UMBRELLA.siteId]),
  }),
});

/** The fixture of `tenantId`, compared case-insensitively, or undefined. */
export function fixtureForTenant(tenantId: string): TenantFixture | undefined {
  const wanted = tenantId.toLowerCase();
  return TENANT_LIST.find((candidate) => candidate.tenantId === wanted);
}

/** The fixture of a legacy site id, compared case-insensitively, or undefined. */
export function fixtureForSite(siteId: string): TenantFixture | undefined {
  const wanted = siteId.toLowerCase();
  return TENANT_LIST.find((candidate) => candidate.siteId === wanted);
}

/** Every ordered (writer, reader) pair over TENANT_LIST with writer !== reader: six pairs. */
export function crossTenantPairs(): CrossTenantPair[] {
  return TENANT_LIST.flatMap((writer) =>
    TENANT_LIST.filter((reader) => reader !== writer).map((reader) => Object.freeze({ writer, reader })),
  );
}

function domainsOf(siteId: string): string[] {
  return [`${siteId}.opt2.test`];
}

/** One `programs-sites.site.changed.v1` payload per fixture, in TENANT_LIST order; each call returns fresh objects. */
export function registryPayloads(): SiteChangedPayload[] {
  return TENANT_LIST.map((site) => {
    const { pools, content } = SITE_POOLS[site.key];
    return {
      siteId: site.siteId,
      publicUserPoolId: pools.publicUser,
      privateUserPoolId: pools.privateUser,
      categoryPoolId: pools.category,
      filePoolId: pools.file,
      displayPoolId: pools.display,
      contentPoolIds: [...content],
      domains: domainsOf(site.siteId),
    };
  });
}

/** The tenant the seeded registry gives for `fixture`'s `kind` pool. */
export function poolTenantExpectation(fixture: TenantFixture, kind: PoolKind): string {
  return tenantIdForSite(SITE_POOLS[fixture.key].pools[kind]);
}

/** Tenants a `userPool` fan-out from `source` must reach: `source` plus every fixture whose public or private user pool it is. */
export function userPoolFanoutExpectation(source: TenantFixture): ReadonlySet<string> {
  const members = TENANT_LIST.filter(
    (site) =>
      poolTenantExpectation(site, 'publicUser') === source.tenantId ||
      poolTenantExpectation(site, 'privateUser') === source.tenantId,
  );
  return new Set([source.tenantId, ...members.map((site) => site.tenantId)]);
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

// Column order of tenantRegistrySql; updated_at is set by the statement itself.
const REGISTRY_COLUMNS = [
  'site_id',
  'tenant_id',
  'public_user_pool_id',
  'private_user_pool_id',
  'category_pool_id',
  'file_pool_id',
  'display_pool_id',
  'content_pool_ids',
  'public_user_pool_tenant',
  'private_user_pool_tenant',
  'category_pool_tenant',
  'file_pool_tenant',
  'display_pool_tenant',
  'content_pool_tenants',
  'domains',
  'aggregate_version',
] as const;

const POOL_ORDER: readonly PoolKind[] = ['publicUser', 'privateUser', 'category', 'file', 'display'];

function registryValues(site: TenantFixture): unknown[] {
  const { pools, content } = SITE_POOLS[site.key];
  const poolIds = POOL_ORDER.map((kind) => pools[kind]);
  return [
    site.siteId,
    site.tenantId,
    ...poolIds,
    [...content],
    ...poolIds.map((id) => tenantIdForSite(id)),
    content.map((id) => tenantIdForSite(id)),
    domainsOf(site.siteId),
    1,
  ];
}

// Conflicts on tenant_id, as the registry consumer does, so a row stored under another casing of the site id is reset
// rather than rejected; the WHERE clause leaves a row already in fixture state untouched, updated_at included.
function upsertSql(table: string): string {
  const columns = REGISTRY_COLUMNS.join(', ');
  const placeholders = REGISTRY_COLUMNS.map((_, index) => `$${String(index + 1)}`).join(', ');
  const updated = REGISTRY_COLUMNS.filter((column) => column !== 'tenant_id');
  return [
    `INSERT INTO ${table} AS r (${columns}, updated_at)`,
    `VALUES (${placeholders}, LOCALTIMESTAMP(3))`,
    'ON CONFLICT (tenant_id) DO UPDATE SET',
    `  ${[...updated, 'updated_at'].map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`,
    `WHERE (${updated.map((column) => `r.${column}`).join(', ')})`,
    `  IS DISTINCT FROM (${updated.map((column) => `EXCLUDED.${column}`).join(', ')})`,
  ].join('\n');
}

/** Upserts the three fixture sites into `<schema>.tenant_registry` in one metadata transaction; a repeat changes nothing. */
export async function seedRegistry(db: TenantDb, schema: string = db.schema): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) {
    throw new TypeError(`Invalid schema name ${JSON.stringify(schema)}: expected ${String(SCHEMA_NAME)}`);
  }
  const sql = upsertSql(`${schema}.tenant_registry`);
  await withMetadata(db, async (tx) => {
    for (const site of TENANT_LIST) {
      await tx.query(sql, registryValues(site));
    }
  });
}
