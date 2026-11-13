/** domain/pools content-pool site resolution over a fake registry: one own-entry read plus at most one registry list read per metadata transaction. */
import { describe, expect, it } from 'vitest';
import { tenantIdForSite, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';
import { UnregisteredTenantError, contentPoolSites, feedPoolSites, type PoolSite } from '../../src/domain/pools.js';

const OWN = 'tenant-a';
const OWN_TENANT = tenantIdForSite(OWN);
const GHOST_TENANT = tenantIdForSite('ghost');
const UPDATED_AT = new Date('2026-01-02T03:04:05.678Z');

type RegistryRow = ReturnType<typeof registryRow>;
type Statement = 'entry' | 'list';
type Resolve = (db: TenantDb) => Promise<PoolSite[]>;

/** A `content.tenant_registry` row whose pools are the site itself, with `contentPool` as its content pool. */
function registryRow(siteId: string, contentPool: readonly string[] = [siteId]) {
  const tenantId = tenantIdForSite(siteId);
  return {
    site_id: siteId,
    tenant_id: tenantId,
    public_user_pool_id: siteId,
    private_user_pool_id: siteId,
    category_pool_id: siteId,
    file_pool_id: siteId,
    display_pool_id: siteId,
    content_pool_ids: [...contentPool],
    public_user_pool_tenant: tenantId,
    private_user_pool_tenant: tenantId,
    category_pool_tenant: tenantId,
    file_pool_tenant: tenantId,
    display_pool_tenant: tenantId,
    content_pool_tenants: contentPool.map((poolSiteId) => tenantIdForSite(poolSiteId)),
    domains: [],
    aggregate_version: '1',
    updated_at: UPDATED_AT,
  };
}

/** The pool site of a stored site id. */
const site = (siteId: string): PoolSite => ({ siteId, tenantId: tenantIdForSite(siteId) });

/** A TenantDb whose metadata transactions answer the registry statements from `rows` and record each one; tenant transactions are refused. */
function fakeRegistry(rows: readonly RegistryRow[]): { db: TenantDb; statements: Statement[]; transactions: () => number } {
  const statements: Statement[] = [];
  let transactions = 0;
  const tx = {
    kind: 'metadata',
    schema: 'content',
    onCommit: () => undefined,
    query: (text: string, values: readonly unknown[] = []) => {
      if (/^SELECT [a-z_, ]+ FROM content\.tenant_registry ORDER BY site_id$/.test(text)) {
        statements.push('list');
        return Promise.resolve({ rows: [...rows].sort((a, b) => a.site_id.localeCompare(b.site_id)) });
      }
      if (/^SELECT [a-z_, ]+ FROM content\.tenant_registry WHERE tenant_id = \$1$/.test(text)) {
        statements.push('entry');
        return Promise.resolve({ rows: rows.filter((row) => row.tenant_id === values[0]) });
      }
      return Promise.reject(new Error(`Unexpected registry statement: ${text}`));
    },
  } as unknown as MetadataTx;
  const db = {
    schema: 'content',
    withTenant: () => Promise.reject(new Error('content-pool resolution opened a tenant transaction')),
    withMetadata: async <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn(tx);
    },
    end: () => Promise.resolve(),
  } as TenantDb;
  return { db, statements, transactions: () => transactions };
}

/** The own site with a `size`-site content pool in non-alphabetical stored order, an unregistered `ghost` among them. */
function poolFixture(size: number): { rows: RegistryRow[]; pool: string[]; expected: PoolSite[] } {
  const others = Array.from({ length: size - 1 }, (_, index) => `Site-${String(size - 1 - index).padStart(2, '0')}`);
  const pool = [...others.slice(0, 1), 'ghost', OWN, ...others.slice(1)];
  return {
    rows: [registryRow(OWN, pool), ...others.map((siteId) => registryRow(siteId))],
    pool,
    expected: pool.filter((siteId) => siteId !== 'ghost').map(site),
  };
}

describe('content-pool registry reads', () => {
  it.each([3, 10])('contentPoolSites resolves a %i-site pool in stored order with the own-entry read and one list read', async (size) => {
    const { rows, expected } = poolFixture(size);
    const fake = fakeRegistry(rows);
    expect(await contentPoolSites(fake.db, OWN_TENANT)).toEqual(expected);
    expect(fake.statements).toEqual(['entry', 'list']);
    expect(fake.transactions()).toBe(1);
  });

  it.each([3, 10])("feedPoolSites '*' equals contentPoolSites for a %i-site pool at the same cost", async (size) => {
    const { rows, expected } = poolFixture(size);
    const fake = fakeRegistry(rows);
    const contentPool = await contentPoolSites(fake.db, OWN_TENANT);
    fake.statements.length = 0;
    expect(await feedPoolSites(fake.db, OWN_TENANT, '*')).toEqual(contentPool);
    expect(contentPool).toEqual(expected);
    expect(fake.statements).toEqual(['entry', 'list']);
    expect(fake.transactions()).toBe(2);
  });

  it.each([3, 10])('feedPoolSites resolves an explicit list naming every site of a %i-site pool with one list read', async (size) => {
    const { rows, pool, expected } = poolFixture(size);
    const fake = fakeRegistry(rows);
    const list = [...pool].reverse().map((siteId) => ` ${siteId.toUpperCase()} `).join(',');
    expect(await feedPoolSites(fake.db, OWN_TENANT, list)).toEqual([...expected].reverse());
    expect(fake.statements).toEqual(['entry', 'list']);
    expect(fake.transactions()).toBe(1);
  });

  it.each<[string, readonly string[], Resolve, PoolSite[]]>([
    ['contentPoolSites, own-only pool', [OWN], (db) => contentPoolSites(db, OWN_TENANT), [site(OWN)]],
    ["feedPoolSites '*', own-only pool", [OWN], (db) => feedPoolSites(db, OWN_TENANT, '*'), [site(OWN)]],
    ["feedPoolSites '', multi-site pool", [OWN, 'tenant-b'], (db) => feedPoolSites(db, OWN_TENANT, ''), [site(OWN)]],
    ['feedPoolSites listing only the own site, multi-site pool', [OWN, 'tenant-b'], (db) => feedPoolSites(db, OWN_TENANT, ' TENANT-A ,tenant-a'), [site(OWN)]],
    ['feedPoolSites with a blank list, multi-site pool', [OWN, 'tenant-b'], (db) => feedPoolSites(db, OWN_TENANT, ' , '), []],
  ])('%s reads only the own registry entry', async (_label, pool, resolve, expected) => {
    const fake = fakeRegistry([registryRow(OWN, pool), registryRow('tenant-b')]);
    expect(await resolve(fake.db)).toEqual(expected);
    expect(fake.statements).toEqual(['entry']);
  });

  it.each<[string, string[]]>([
    [' TENANT-B,ghost,umbrella,tenant-b,tenant-a', ['Tenant-B', OWN]],
    ['tenant-a,Tenant-B', [OWN, 'Tenant-B']],
    ['umbrella,ghost', []],
  ])('feedPoolSites(%j) keeps registered granted sites once, in list order, by stored site id', async (list, siteIds) => {
    const fake = fakeRegistry([registryRow(OWN, [OWN, 'tenant-b']), registryRow('Tenant-B'), registryRow('umbrella')]);
    expect(await feedPoolSites(fake.db, OWN_TENANT, list)).toEqual(siteIds.map(site));
    expect(fake.statements).toEqual(['entry', 'list']);
  });

  it.each<[string, Resolve]>([
    ['contentPoolSites', (db) => contentPoolSites(db, GHOST_TENANT)],
    ["feedPoolSites ''", (db) => feedPoolSites(db, GHOST_TENANT, '')],
    ["feedPoolSites '*'", (db) => feedPoolSites(db, GHOST_TENANT, '*')],
    ['feedPoolSites with a list', (db) => feedPoolSites(db, GHOST_TENANT, 'tenant-b,ghost')],
  ])('%s rejects an unregistered own tenant with UnregisteredTenantError', async (_label, resolve) => {
    const fake = fakeRegistry([registryRow(OWN, [OWN, 'tenant-b']), registryRow('tenant-b')]);
    const pending = resolve(fake.db);
    await expect(pending).rejects.toBeInstanceOf(UnregisteredTenantError);
    await expect(pending).rejects.toMatchObject({ tenantId: GHOST_TENANT });
    expect(fake.statements).toEqual(['entry']);
  });
});
