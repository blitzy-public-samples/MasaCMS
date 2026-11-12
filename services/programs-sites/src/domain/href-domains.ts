/** Port of the settingsManager reads utility.sanitizeHref makes: the origin-domain list and the site's domain. */
import { accessControlOriginDomains, cfToBoolean, type AccessControlSite } from '@opt2/platform/legacy-compat';
import { registeredTenants, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { getSiteText, readBean, type SiteBean } from '../legacy/site-fields.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';

type HrefDomains = components['schemas']['HrefDomains'];

/** settingsManager `getSite`'s fallback for an empty or unknown site id. */
const DEFAULT_SITE_ID = 'default';

/** Reads the sanitizeHref domains; `siteId` is the session site legacy passes to `getSite`. */
export type HrefDomainsReader = (db: TenantDb, siteId: string) => Promise<HrefDomains>;

/** Every registered site as its bean, one transaction per tenant, in registry (site id) order. */
async function siteBeans(db: TenantDb, repo: ProgramsSitesRepository): Promise<SiteBean[]> {
  const tenants = [...new Set((await registeredTenants(db)).map(({ tenantId }) => tenantId))];
  const beans: SiteBean[] = [];
  for (const tenantId of tenants) {
    const rows = await withTenant(db, tenantId, (tx) => repo.listSites(tx));
    beans.push(...rows.map((row) => readBean(row)));
  }
  return beans;
}

/** The bean fields settingsBean getAccessControlOriginDomainList reads (settingsBean.cfc:1531-1555). */
function accessControlSite(bean: SiteBean): AccessControlSite {
  return {
    domain: getSiteText(bean, 'domain'),
    domainAlias: getSiteText(bean, 'domainAlias'),
    isRemote: cfToBoolean(getSiteText(bean, 'isRemote')),
    resourceDomain: getSiteText(bean, 'resourceDomain'),
  };
}

/**
 * settingsManager getAccessControlOriginDomainList (settingsManager.cfc:842-875) without the configured admin-domain
 * term, and getSite(siteId).getDomain() with getSite's `default` fallback (settingsManager.cfc:537-567).
 * @throws Error when neither the named site nor `default` is registered, where legacy's getSite fails.
 */
export function createHrefDomainsReader(repo: ProgramsSitesRepository): HrefDomainsReader {
  return async (db, siteId) => {
    const beans = await siteBeans(db, repo);
    const allowedDomains = accessControlOriginDomains(beans.map(accessControlSite), {});
    // getSite reads a ColdFusion struct, whose keys match ignoring case.
    const named = (id: string): SiteBean | undefined =>
      beans.find((bean) => getSiteText(bean, 'siteID').toLowerCase() === id.toLowerCase());
    const site = (siteId === '' ? undefined : named(siteId)) ?? named(DEFAULT_SITE_ID);
    if (site === undefined) throw new Error(`Neither site '${siteId}' nor the default site is registered`);
    return { allowedDomains, siteDomain: getSiteText(site, 'domain') };
  };
}
