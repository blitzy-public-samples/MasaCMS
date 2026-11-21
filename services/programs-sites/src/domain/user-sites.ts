/** Port of settingsManager.getUserSites and contentServer.bindToDomain(isAdmin=true) over the site registry, plus its keyset page. */
import { AuthDenial, type UserClaims } from '@opt2/platform/auth';
import { cfEq, cfListToArray, cfToBoolean } from '@opt2/platform/legacy-compat';
import { awaitReadable } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, z, type ServiceClient } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  tenantForRegisteredSite,
  withMetadata,
  withTenant,
  type MetadataTx,
  type TenantDb,
} from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { getSiteText, getSiteValue, readBean, sortSites } from '../legacy/site-fields.js';
import type { KeysetPage, ProgramsSitesRepository, SiteSelectorRow } from '../repo/repository.js';
import { SITE } from '../repo/tables.js';

type UserSite = components['schemas']['UserSite'];
type UserSiteList = components['schemas']['UserSiteList'];
type UserSitePage = components['schemas']['UserSitePage'];

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
  /**
   * One page of `listUserSites`' sites, unbound, in site-id order: the registry's page for an S2 token, else identity's
   * session sites in code-point order. Only the page's tenants are read, at most PAGE_CONCURRENCY at once; an abort of
   * `options.signal` rejects with its reason.
   * @throws AuthDenial When identity refuses the session's sites (401 or 403).
   * @throws ServiceUnavailableError When identity is unreachable or answers otherwise.
   */
  listUserSitePage(db: TenantDb, claims: UserClaims, options: UserSitePageOptions): Promise<UserSitePage>;
}

/** One page of the site selector: at most `limit` sites after the site id `after`. */
export interface UserSitePageOptions {
  after?: string;
  limit: number;
  /** Ends the page's reads when it aborts, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

/** One site id of a page and its registered tenant, null when unregistered. */
interface PageEntry {
  siteId: string;
  tenantId: string | null;
}

/** Most transactions one page holds at once: below pg's default pool of 10, so one page never takes the pool. */
const PAGE_CONCURRENCY = 4;

/** The C-collation order of the registry's `ORDER BY site_id`: UTF-8 bytes, i.e. Unicode code points. */
function bySiteIdCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The distinct `siteIds` after `page.after` in code-point order, at most `page.limit` of them. */
function sessionKeyset(siteIds: readonly string[], { after, limit }: KeysetPage): string[] {
  return [...new Set(siteIds)]
    .filter((siteId) => after === null || bySiteIdCodePoints(siteId, after) > 0)
    .sort(bySiteIdCodePoints)
    .slice(0, limit);
}

/**
 * `read` of each item, at most PAGE_CONCURRENCY at a time, in item order. No read starts once `signal` has aborted or a
 * read has failed; the first failure is rethrown once the running reads settle.
 */
async function readEachBounded<I, T>(items: readonly I[], signal: AbortSignal | undefined, read: (item: I) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  const failures: unknown[] = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      if (failures.length > 0) return;
      try {
        signal?.throwIfAborted();
        results[index] = await read(item);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}

/** The domain and each line of `ListToArray(domainAlias, chr(13)&chr(10))` of a stored site, as its bean holds them. */
function domainsOf(row: SiteSelectorRow): { siteid: string; domain: string; aliases: string[] } {
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
export function bindToAdminDomain(rows: readonly SiteSelectorRow[], requestHost: string, adminDomain: string): string | null {
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
function userSite(row: SiteSelectorRow): UserSite {
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
  async function rowsOf(db: TenantDb, tenantIds: Iterable<string>): Promise<SiteSelectorRow[]> {
    const rows: SiteSelectorRow[] = [];
    for (const tenantId of new Set(tenantIds)) {
      rows.push(...(await withTenant(db, tenantId, (tx) => repo.listSiteSelectorRows(tx))));
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

  /** The page after `after` and whether another follows: the registry's when `siteArray` is undefined (S2), else the session's. */
  async function pageOf(
    tx: MetadataTx,
    siteArray: readonly string[] | undefined,
    { after, limit }: KeysetPage,
  ): Promise<{ page: PageEntry[]; more: boolean }> {
    await awaitReadable(tx, [SITE.unit]);
    // One entry past the page tells whether another page follows.
    const keyset = { after, limit: limit + 1 };
    if (siteArray === undefined) {
      const entries = await repo.listRegisteredSitePage(tx, keyset);
      return { page: entries.slice(0, limit), more: entries.length > limit };
    }
    const siteIds = sessionKeyset(siteArray, keyset);
    const page: PageEntry[] = [];
    for (const siteId of siteIds.slice(0, limit)) page.push({ siteId, tenantId: await tenantForRegisteredSite(tx, siteId) });
    return { page, more: siteIds.length > limit };
  }

  async function listUserSitePage(db: TenantDb, claims: UserClaims, options: UserSitePageOptions): Promise<UserSitePage> {
    const { limit, signal } = options;
    const call = signal === undefined ? undefined : { signal };
    const siteArray = claims.s2 ? undefined : await sessionSiteIds();
    const { page, more } = await withMetadata(db, (tx) => pageOf(tx, siteArray, { after: options.after ?? null, limit }), call);
    const tenants = [...new Set(page.flatMap(({ tenantId }) => (tenantId === null ? [] : [tenantId])))];
    const rows = (
      await readEachBounded(tenants, signal, (tenantId) => withTenant(db, tenantId, (tx) => repo.listSiteSelectorRows(tx), call))
    ).flat();
    // The QoQ `siteid in (…)` filter compares case-sensitively, here over the page's session sites.
    const listed = siteArray === undefined ? rows : rows.filter((row) => page.some(({ siteId }) => siteId === row.siteid));
    return { items: listed.map(userSite), next: more ? (page.at(-1)?.siteId ?? null) : null };
  }

  return Object.freeze({ listUserSites, listUserSitePage });
}
