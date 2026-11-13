/** Pooled and cross-site reads: pooled entities run in the registry's pool tenant, content-pool reads in one transaction per pool tenant. */
import { withGatedTenant, type GateBudgetOptions } from '@opt2/platform/migration-kit';
import {
  poolTenantFor,
  registeredTenants,
  registryEntryForTenant,
  withTenant,
  type MetadataTx,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';

/** A site pool whose rows all live in one pool tenant (settingsBean `categoryPoolID`, `filePoolID`, `publicUserPoolID`, `privateUserPoolID`). */
export type PoolScope = 'category' | 'file' | 'publicUser' | 'privateUser';

/** A registered site of a content pool and the tenant its rows live in. */
export interface PoolSite {
  siteId: string;
  tenantId: string;
}

// A plain Error, answered with the legacy 500: falling back to the token's own tenant would read or write pooled rows
// in the wrong tenant while the registry has not yet consumed the site's programs-sites.site.changed.v1.
/** Raised when the token's tenant has no `tenant_registry` entry, so its pools cannot be resolved. */
export class UnregisteredTenantError extends Error {
  override readonly name: string = 'UnregisteredTenantError';

  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} has no site registry entry`);
  }
}

/** The tenant holding `tid`'s `kind` pool. */
async function poolTenant(db: TenantDb, tid: string, kind: PoolScope): Promise<string> {
  const tenant = await poolTenantFor(db, tid, kind);
  if (tenant === null) {
    throw new UnregisteredTenantError(tid);
  }
  return tenant;
}

/** Runs `fn` in the tenant the registry gives for `tid`'s `kind` pool; for reads of pooled entities. */
export async function withPoolTenant<T>(
  db: TenantDb,
  tid: string,
  kind: PoolScope,
  fn: (tx: TenantTx, poolTenantId: string) => Promise<T>,
): Promise<T> {
  const tenant = await poolTenant(db, tid, kind);
  return withTenant(db, tenant, (tx) => fn(tx, tenant));
}

/** Runs `fn` in `tid`'s `kind` pool tenant under the unit gates (`withGatedTenant`); for writes of pooled entities. */
export async function withGatedPoolTenant<T>(
  db: TenantDb,
  tid: string,
  kind: PoolScope,
  fn: (tx: TenantTx, poolTenantId: string) => Promise<T>,
  opts: GateBudgetOptions = {},
): Promise<T> {
  const tenant = await poolTenant(db, tid, kind);
  return withGatedTenant(db, tenant, (tx) => fn(tx, tenant), opts);
}

/** The registry entry of `tid`. */
async function ownEntry(tx: MetadataTx, tid: string): Promise<TenantRegistryEntry> {
  const entry = await registryEntryForTenant(tx, tid);
  if (entry === null) {
    throw new UnregisteredTenantError(tid);
  }
  return entry;
}

/** Stored site ids by tenant for `own` and the registered `tenants`; one registry read, made only when `tenants` names another tenant. */
async function siteIndex(tx: MetadataTx, own: TenantRegistryEntry, tenants: readonly string[]): Promise<Map<string, string>> {
  const sites = new Map([[own.tenantId, own.siteId]]);
  const others = new Set(tenants.filter((tenantId) => tenantId !== own.tenantId));
  if (others.size > 0) {
    for (const { tenantId, siteId } of await registeredTenants(tx)) {
      if (others.has(tenantId)) {
        sites.set(tenantId, siteId);
      }
    }
  }
  return sites;
}

/** The registered sites of `tenants` in the given order; an unregistered tenant is left out, as legacy `siteid IN` matches no row for it. */
async function registeredSites(tx: MetadataTx, own: TenantRegistryEntry, tenants: readonly string[]): Promise<PoolSite[]> {
  const sites = await siteIndex(tx, own, tenants);
  return tenants.flatMap((tenantId) => {
    const siteId = sites.get(tenantId);
    return siteId === undefined ? [] : [{ siteId, tenantId }];
  });
}

/** The registered sites of `tid`'s content pool (settingsBean `getContentPoolID`), in stored order. */
export function contentPoolSites(db: TenantDb, tid: string): Promise<PoolSite[]> {
  return db.withMetadata(async (tx) => {
    const own = await ownEntry(tx, tid);
    return registeredSites(tx, own, own.contentPoolTenants);
  });
}

/** The sites a feed reads (feedBean `getContentPoolID`): `''` the own site, `'*'` the content pool, else the listed sites that are the own site or in its content pool, in list order. */
export function feedPoolSites(db: TenantDb, tid: string, feedContentPoolId: string): Promise<PoolSite[]> {
  return db.withMetadata(async (tx) => {
    const own = await ownEntry(tx, tid);
    if (feedContentPoolId === '') {
      return [{ siteId: own.siteId, tenantId: own.tenantId }];
    }
    if (feedContentPoolId === '*') {
      return registeredSites(tx, own, own.contentPoolTenants);
    }
    // The stored list is caller-supplied, so a listed site outside the own site and its registered content pool is
    // left out like an unregistered one: cross-site reads reach only tenants the registry grants (the admin feed form
    // offers no other site).
    const listed = feedContentPoolId
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const ownKey = own.siteId.toLowerCase();
    const granted = await siteIndex(tx, own, listed.some((item) => item.toLowerCase() !== ownKey) ? own.contentPoolTenants : []);
    // Keyed by the lower-cased site id, the folding tenantIdForSite applies, so any spelling of a registered site matches.
    const bySite = new Map([...granted].map(([tenantId, siteId]): [string, PoolSite] => [siteId.toLowerCase(), { siteId, tenantId }]));
    const sites = new Map<string, PoolSite>();
    for (const item of listed) {
      const site = bySite.get(item.toLowerCase());
      if (site !== undefined && !sites.has(site.tenantId)) {
        sites.set(site.tenantId, site);
      }
    }
    return [...sites.values()];
  });
}

/**
 * Runs `fn` once per site, each in its own tenant transaction and one after another, concatenates the rows in `sites`
 * order, then stable-sorts them with `compare` (the legacy statement's ORDER BY) when given.
 */
export async function readAcrossContentPool<R>(
  db: TenantDb,
  sites: readonly PoolSite[],
  fn: (tx: TenantTx, site: PoolSite) => Promise<R[]>,
  compare?: (a: R, b: R) => number,
): Promise<R[]> {
  const rows: R[] = [];
  for (const site of sites) {
    for (const row of await withTenant(db, site.tenantId, (tx) => fn(tx, site))) {
      rows.push(row);
    }
  }
  return compare === undefined ? rows : rows.sort(compare);
}
