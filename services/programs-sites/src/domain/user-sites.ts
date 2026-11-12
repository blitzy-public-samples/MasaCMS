/** Port of settingsManager.getUserSites and contentServer.bindToDomain(isAdmin=true) over the site registry. */
import { AuthDenial, type UserClaims } from '@opt2/platform/auth';
import { cfEq, cfListToArray, cfToBoolean } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, z, type ServiceClient } from '@opt2/platform/service-kit';
import { registeredTenants, tenantForRegisteredSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { getSiteText, getSiteValue, readBean, sortSites } from '../legacy/site-fields.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';
import type { SiteRow } from '../repo/tables.js';

type UserSite = components['schemas']['UserSite'];
type UserSiteList = components['schemas']['UserSiteList'];

const IDENTITY = 'identity';
const SESSION_SITES_PATH = '/v1/sessions/current/sites';

/** identity `SessionSites`: the session's `siteArray` with the site names. */
const SESSION_SITES = z.object({ sites: z.array(z.object({ siteID: z.string(), site: z.string() })) });

/** Dependencies of `createUserSitesDomain`. */
export interface UserSitesDomainDeps {
  repo: ProgramsSitesRepository;
  /** The service client that calls identity with the request's user token. */
  client: ServiceClient;
  /** configBean `adminDomain`, `''` when unset. */
  adminDomain: string;
}

/** The site list of the admin home redirect and header site selector. */
export interface UserSitesDomain {
  /**
   * getUserSites(session.siteArray, isS2) in site-name order; with `host`, also bindToDomain(isAdmin=true) as `boundSiteId`.
   * @throws AuthDenial When identity refuses the session's sites (401 or 403).
   * @throws ServiceUnavailableError When identity is unreachable or answers otherwise.
   */
  listUserSites(db: TenantDb, claims: UserClaims, host?: string): Promise<UserSiteList>;
}

/** The domain and each line of `ListToArray(domainAlias, chr(13)&chr(10))` of a stored site, as its bean holds them. */
function domainsOf(row: SiteRow): { siteid: string; domain: string; aliases: string[] } {
  const bean = readBean(row);
  const aliases = getSiteText(bean, 'domainAlias').split(/[\r\n]/).filter((alias) => alias !== '');
  return { siteid: row.siteid, domain: getSiteText(bean, 'domain'), aliases };
}

/**
 * contentServer `bindToDomain(isAdmin=true)` over every site by bind order: the first whose domain or an alias equals
 * the host (settingsBean.isValidDomain complete), else the first containing it (partial), else null on the admin
 * domain (`--none--`), else the first site; null when there is none.
 * @param requestHost utility `getRequestHost()`; any port is ignored.
 */
export function bindToAdminDomain(rows: readonly SiteRow[], requestHost: string, adminDomain: string): string | null {
  const checkDomain = cfListToArray(requestHost, ':')[0] ?? '';
  const sites = sortSites(rows, 'orderno', 'asc').map(domainsOf);
  const complete = sites.find(
    (site) => cfEq(checkDomain, site.domain) || site.aliases.some((alias) => cfEq(checkDomain, alias)),
  );
  if (complete !== undefined) return complete.siteid;
  const partial = sites.find(
    (site) => site.domain.includes(checkDomain) || site.aliases.some((alias) => alias.includes(checkDomain)),
  );
  if (partial !== undefined) return partial.siteid;
  if (cfEq(checkDomain, adminDomain)) return null;
  return sites[0]?.siteid ?? null;
}

/** One `getUserSites` row as stored, with settingsBean `getValue('showDashboard', 0)` as 1 or 0. */
function userSite(row: SiteRow): UserSite {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    siteid: row.siteid,
    site: text(row.site),
    orderno: row.orderno,
    domain: text(row.domain),
    domainAlias: text(row.domainalias),
    showDashboard: cfToBoolean(getSiteValue(readBean(row), 'showDashboard')) ? 1 : 0,
  };
}

/** Builds the user-site operations over the injected repository and service client; it holds no state of its own. */
export function createUserSitesDomain({ repo, client, adminDomain }: UserSitesDomainDeps): UserSitesDomain {
  /** identity's `session.siteArray` for the request's user token. */
  async function sessionSiteIds(): Promise<string[]> {
    const response = await client.request({ service: IDENTITY, method: 'GET', path: SESSION_SITES_PATH });
    if (response.status === 401) throw AuthDenial.unauthenticated('invalid-credential');
    if (response.status === 403) throw AuthDenial.forbidden();
    if (response.status < 200 || response.status > 299) {
      const cause = Object.assign(new Error(`${IDENTITY} answered HTTP ${response.status}`), {
        code: `HTTP_${response.status}`,
      });
      throw new ServiceUnavailableError(IDENTITY, cause);
    }
    const parsed = SESSION_SITES.safeParse(response.body);
    if (!parsed.success) throw new ServiceUnavailableError(IDENTITY, parsed.error);
    return parsed.data.sites.map(({ siteID }) => siteID);
  }

  /** The stored sites of each tenant once, one transaction per tenant, in the given order. */
  async function rowsOf(db: TenantDb, tenantIds: Iterable<string>): Promise<SiteRow[]> {
    const rows: SiteRow[] = [];
    for (const tenantId of new Set(tenantIds)) {
      rows.push(...(await withTenant(db, tenantId, (tx) => repo.listSites(tx))));
    }
    return rows;
  }

  /** The tenants of the registered sites `siteIds` name, unregistered ids skipped. */
  async function tenantsOf(db: TenantDb, siteIds: readonly string[]): Promise<string[]> {
    const tenants: string[] = [];
    for (const siteId of siteIds) {
      const tenantId = await tenantForRegisteredSite(db, siteId);
      if (tenantId !== null) tenants.push(tenantId);
    }
    return tenants;
  }

  async function listUserSites(db: TenantDb, claims: UserClaims, host?: string): Promise<UserSiteList> {
    const siteArray = claims.s2 ? undefined : await sessionSiteIds();
    // Binding reads every site, as getList does; otherwise only the listed sites' tenants are read.
    const tenants =
      siteArray === undefined || host !== undefined
        ? (await registeredTenants(db)).map(({ tenantId }) => tenantId)
        : await tenantsOf(db, siteArray);
    const rows = await rowsOf(db, tenants);
    // The QoQ `siteid in (…)` filter compares case-sensitively.
    const listed = siteArray === undefined ? rows : rows.filter((row) => siteArray.includes(row.siteid));
    const sites = sortSites(listed, 'site', 'asc').map(userSite);
    return host === undefined ? { sites } : { sites, boundSiteId: bindToAdminDomain(rows, host, adminDomain) };
  }

  return Object.freeze({ listUserSites });
}
