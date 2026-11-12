// The `home.redirect` action, the admin's FW/1 home: sends each user to their landing screen (server-only).
import { cfEq, cfIsBoolean, cfListToArray, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { okBody, type GatewayClient } from '@/lib/gateway-client';
import { encodeUrl } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';

/** A `tsettings` row as the home redirect reads it. */
export interface HomeSite {
  readonly siteid: string;
  /** Site name. */
  readonly site: string;
  /** Bind order; null sorts first, as SQL Server sorts NULL. */
  readonly orderno: number | null;
  readonly domain: string;
  /** Domain aliases, one per CR/LF-separated line. */
  readonly domainAlias: string;
  /** The stored `showDashboard` setting; undefined when programs-sites did not serve it. */
  readonly showDashboard?: unknown;
}

type SiteRecord = NonNullable<AdminRequest['site']>['record'];

/** contentServer `bindToDomain(isAdmin=true)` result for a request on the admin domain itself. */
const ADMIN_DOMAIN_ONLY = '--none--';

/** Site Manager module and its root node, which the content landing page opens. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const HOME_TOP_ID = '00000000000000000000000000000000001';

/** SQL Server `SQL_Latin1_General_CP1_CI_AS` order of `getList(sortby="site")`: case-insensitive, accent-sensitive. */
const SITE_ORDER = new Intl.Collator('en-US', { sensitivity: 'accent' });

/** `getList(sortby="orderno")` order, NULL first; equal values keep their input order. */
function compareOrderno(a: HomeSite, b: HomeSite): number {
  if (a.orderno === b.orderno) return 0;
  if (a.orderno === null) return -1;
  if (b.orderno === null) return 1;
  return a.orderno - b.orderno;
}

/** CFML `ListToArray(domainAlias, chr(13)&chr(10))`: split on either character, empty lines dropped. */
const aliasesOf = (site: HomeSite): string[] => site.domainAlias.split(/[\r\n]/).filter((alias) => alias !== '');

/**
 * settingsManager `getUserSites(siteArray, isS2)`: every site for S2 users, else the sites whose id is in `siteArray`
 * (matched exactly) and none for an empty one, in site-name order.
 */
export function userSites(sites: readonly HomeSite[], siteArray: readonly string[], isS2: boolean): HomeSite[] {
  const byName = sites.toSorted((a, b) => SITE_ORDER.compare(a.site, b.site));
  return isS2 ? byName : byName.filter((site) => siteArray.includes(site.siteid));
}

/**
 * contentServer `bindToDomain(isAdmin=true)`: the first site by bind order whose domain or an alias equals the host,
 * else the first containing it, else `--none--` on the admin domain, else the first site ('' when there is none).
 * @param requestHost utility `getRequestHost()`; any port is ignored.
 */
export function bindToAdminDomain(sites: readonly HomeSite[], requestHost: string, adminDomain: string): string {
  const checkDomain = cfListToArray(requestHost, ':')[0] ?? '';
  const ordered = sites.toSorted(compareOrderno);
  const complete = ordered.find(
    (site) => cfEq(checkDomain, site.domain) || aliasesOf(site).some((alias) => cfEq(checkDomain, alias)),
  );
  if (complete !== undefined) return complete.siteid;
  const partial = ordered.find(
    (site) => site.domain.includes(checkDomain) || aliasesOf(site).some((alias) => alias.includes(checkDomain)),
  );
  if (partial !== undefined) return partial.siteid;
  if (cfEq(checkDomain, adminDomain)) return ADMIN_DOMAIN_ONLY;
  return ordered[0]?.siteid ?? '';
}

/** utility `getRequestHost()`: a non-empty `X-Forwarded-Host`, else `cgi.http_host`, else `cgi.server_name`. */
const requestHostOf = (req: AdminRequest): string =>
  req.headers.get('x-forwarded-host') || req.httpHost || req.serverName;

/** The site settings the request set-up read, when they are `siteId`'s. */
function servedRecord(req: AdminRequest, siteId: string): SiteRecord | undefined {
  return req.site !== undefined && req.site.siteid.toLowerCase() === siteId.toLowerCase() ? req.site.record : undefined;
}

/** A site known only by id and name, with the served settings when they are its own; bind order unknown. */
function unlistedSite(req: AdminRequest, siteid: string, site: string): HomeSite {
  const served = servedRecord(req, siteid);
  return {
    siteid,
    site,
    orderno: null,
    domain: served?.Domain ?? '',
    domainAlias: served?.domainAlias ?? '',
    showDashboard: served?.showDashboard,
  };
}

// programs-sites lists every site to S2 users only and serves site settings only for the token's site, so another
// user's sites are identity's session sites plus the served site, bound by the domains those settings give.
/**
 * Every site the user's token can see, with the served settings filling what the list omits.
 * @throws GatewayDenialError When programs-sites refuses the site list (401 or 403).
 */
async function loadHomeSites(req: AdminRequest, gateway: GatewayClient): Promise<HomeSite[]> {
  if (!req.isS2) {
    const sites = req.adminSites.map(({ siteID, site }) => unlistedSite(req, siteID, site));
    const served = req.site;
    if (served !== undefined && !sites.some((site) => site.siteid.toLowerCase() === served.siteid.toLowerCase())) {
      sites.push(unlistedSite(req, served.siteid, served.site));
    }
    return sites;
  }
  const response = await gateway.programsSites.listSites({ sortBy: 'site', sortDirection: 'asc' });
  return okBody(response, 'programs-sites', 'listSites').map((item) => {
    const served = servedRecord(req, item.siteid);
    const listedAlias = item['domainAlias'];
    return {
      siteid: item.siteid,
      site: item.site ?? '',
      orderno: item.orderno,
      domain: item.domain ?? '',
      domainAlias: typeof listedAlias === 'string' ? listedAlias : (served?.domainAlias ?? ''),
      showDashboard: item['showDashboard'] ?? served?.showDashboard,
    };
  });
}

/** settingsBean `getValue('showDashboard', 0)`: its setter keeps 0 for any non-boolean value. */
const showsDashboard = (site: HomeSite): boolean => cfIsBoolean(site.showDashboard) && cfToBoolean(site.showDashboard);

// A `redirect` result's `append` names rc keys, and rc cannot hold the chosen site, so the target is built here.
/** FW/1 `redirect(action, append, path="./")`: each appended value `esapiEncode('url')`-encoded, in order. */
function redirectTo(
  req: AdminRequest,
  action: string,
  append: ReadonlyArray<readonly [key: string, value: string]> = [],
): SubmitResult {
  const queryString = append.map(([key, value]) => `${key}=${encodeUrl(value)}`).join('&');
  return { kind: 'location', location: buildUrl(action, './', queryString, { ses: req.ses }) };
}

/** home `redirect()`: the bound or first administered site's dashboard or Site Manager, else login or no-access. */
async function redirectHome({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  if (!req.isLoggedIn) return redirectTo(req, 'clogin.main');
  const sites = await loadHomeSites(req, gateway);
  const rsList = userSites(sites, req.session.siteArray, req.isS2);
  const siteID = bindToAdminDomain(sites, requestHostOf(req), legacySettings().adminDomain);
  const bound = siteID === ADMIN_DOMAIN_ONLY ? undefined : rsList.find((site) => site.siteid === siteID);
  const chosen = bound ?? rsList.toSorted(compareOrderno)[0];
  if (chosen !== undefined) {
    if (showsDashboard(chosen) && req.session.s2IsPrivate) {
      return redirectTo(req, 'cDashboard.main', [['siteid', chosen.siteid]]);
    }
    return redirectTo(req, 'cArch.list', [
      ['siteid', chosen.siteid],
      ['moduleid', CONTENT_MODULE_ID],
      ['topid', HOME_TOP_ID],
    ]);
  }
  return redirectTo(req, req.session.s2IsPrivate ? 'cMessage.noAccess' : 'clogin.main');
}

// The home controller defines no `before()`, so only the application gate guards it.
const NO_SCREEN_GATE: RedirectScreen['gate'] = () => ({ kind: 'allow' });

/** The `home.redirect` admin action. */
export const homeRedirectScreen: RedirectScreen = Object.freeze({
  circuit: 'home',
  action: 'redirect',
  owner: 'identity',
  mode: 'redirect',
  gate: NO_SCREEN_GATE,
  submit: redirectHome,
});
