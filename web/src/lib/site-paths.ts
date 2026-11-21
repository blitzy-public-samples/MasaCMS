// settingsBean and configBean path getters of a site, its content URLs, and the first-touch values legacy's live site
// beans hold, as an admin request sees them (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import type { components as GatewayComponents } from '@/generated/clients/gateway';
import { legacySettings } from './env';
import { okBody, type GatewayClient } from './gateway-client';
import { urlEncodedFormat, type AdminRequest, type SiteData } from './request-context';
import { adminPath } from './urls';

/** settingsBean values the path getters read; NULL columns keep the bean defaults. */
export interface SiteBean {
  readonly siteId: string;
  readonly domain: string;
  readonly domainAliases: readonly string[];
  readonly enforcePrimaryDomain: boolean;
  readonly useSSL: boolean;
  readonly isRemote: boolean;
  readonly remoteContext: string;
  readonly remotePort: number;
  readonly resourceSSL: boolean;
  readonly resourceDomain: string;
  readonly displayPoolID: string;
  readonly filePoolID: string;
}

/** The request values the getters read. */
export type PathRequest = Pick<AdminRequest, 'https' | 'serverName' | 'httpHost'>;

/** settingsBean `get<X>Path(complete)` of one site for one request. */
export interface SitePaths {
  /** `getWebPath(complete=1)`. */
  readonly webPath: () => string;
  readonly rootPath: (complete: boolean) => string;
  readonly assetPath: (complete: boolean) => string;
  readonly fileAssetPath: (complete: boolean) => string;
  readonly corePath: (complete: boolean) => string;
  readonly pluginsPath: (complete: boolean) => string;
  readonly adminPath: (complete: boolean) => string;
}

/** A stored integer flag; SQL NULL reads as the bean default 0. */
const flag = (value: number | null | undefined): boolean => (value ?? 0) !== 0;

/** The bean of a served `tsettings` row; `setUseSSL` also sets `extranetSSL`, which a NULL `useSSL` leaves as read. */
export function siteBeanOf(site: SiteData): SiteBean {
  const { record } = site;
  return {
    siteId: site.siteid,
    domain: site.domain,
    domainAliases: (record.domainAlias ?? '').split(/[\r\n]/).filter((alias) => alias !== ''),
    enforcePrimaryDomain: flag(record.enforcePrimaryDomain),
    useSSL: record.useSSL === null || record.useSSL === undefined ? flag(record.ExtranetSSL) : flag(record.useSSL),
    isRemote: flag(record.isremote),
    remoteContext: record.remotecontext ?? '',
    remotePort: record.remoteport ?? 80,
    resourceSSL: flag(record.resourceSSL),
    resourceDomain: record.resourceDomain ?? '',
    displayPoolID: site.displayPoolID,
    filePoolID: site.filePoolID,
  };
}

/** The sites whose first-touch values legacy evaluates, each only when named. */
export interface LegacySitePathSites {
  /** Site of `getApi('json','v1').getEndpoint(mode='rest')`. */
  readonly apiSite?: string;
  /** Site of `getApi('feed','v1').getEndpoint()`. */
  readonly feedSite?: string;
  /** Site of `getThemeAssetPath()`. */
  readonly themeSite?: string;
  /** Site of `getThemeAssetPath(complete=1)`. */
  readonly initSite?: string;
}

/** Legacy's value of each named site. */
export type LegacySitePaths = GatewayComponents['schemas']['LegacySitePaths'];

/**
 * Legacy's site-bean values for this request's host, read through the gateway; a first touch, so only where printed.
 * @throws GatewayDenialError When the gateway refuses web's call (401 or 403).
 */
export async function legacySitePaths(
  req: Pick<AdminRequest, 'session' | 'httpHost' | 'headers'>,
  gateway: Pick<GatewayClient, 'legacySite'>,
  sites: LegacySitePathSites,
): Promise<LegacySitePaths> {
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const frontEndHttps = req.headers.get('front-end-https');
  const response = await gateway.legacySite.paths({
    sessionSite: req.session.siteid === '' ? 'default' : req.session.siteid,
    host: req.httpHost,
    ...(forwardedProto === null ? {} : { forwardedProto }),
    ...(frontEndHttps === null ? {} : { frontEndHttps }),
    ...sites,
  });
  return okBody(response, 'gateway', 'legacySitePaths');
}

/** `name` of an answer whose request named its site. */
export function legacySitePath(paths: LegacySitePaths, name: keyof LegacySitePaths): string {
  const value = paths[name];
  if (value === undefined) throw new TypeError(`legacySitePaths answered no ${name}`);
  return value;
}

/** `getSite(siteId).getThemeAssetPath()` as legacy's live site bean holds it for this request. */
export async function legacyThemeAssetPath(
  req: Pick<AdminRequest, 'session' | 'httpHost' | 'headers'>,
  gateway: Pick<GatewayClient, 'legacySite'>,
  siteId: string,
): Promise<string> {
  return legacySitePath(await legacySitePaths(req, gateway, { themeSite: siteId }), 'themeAssetPath');
}

/** The getters of `site` for `ctx` (`settingsBean.cfc` 743-849, 1395-1530; `configBean.cfc` 517-528, 1855-1914). */
export function sitePaths(ctx: PathRequest, site: SiteBean): SitePaths {
  const settings = legacySettings();
  const isValidDomain = (domain: string): boolean =>
    cfEq(domain, site.domain) || site.domainAliases.some((alias) => cfEq(domain, alias));
  const hostName = cfListToArray(ctx.httpHost, ':')[0] ?? '';
  // request.muraPreviewDomain, which admin/Application.cfc sets on every admin request, invalid hosts becoming the domain.
  const requestedPreview = hostName !== '' ? hostName : ctx.serverName;
  const previewDomain = isValidDomain(requestedPreview) ? requestedPreview : site.domain;
  const previewOr = (domain: string): string =>
    previewDomain !== '' && isValidDomain(previewDomain) ? previewDomain : domain;
  const serverNameOrDomain = (): string =>
    ctx.serverName !== '' && !site.enforcePrimaryDomain && isValidDomain(ctx.serverName) ? ctx.serverName : site.domain;
  const remoteResource = site.isRemote && site.resourceDomain !== '';
  const remotePort = site.remotePort === 80 || site.remotePort === 443 ? '' : `:${site.remotePort}`;
  const port = site.isRemote ? remotePort : settings.serverPort;
  const context = site.isRemote ? site.remoteContext : settings.context;

  const webPath = (domain = ''): string => {
    let host = previewOr(domain);
    if (host === '') host = site.isRemote ? site.domain : serverNameOrDomain();
    return `${site.useSSL || ctx.https ? 'https' : 'http'}://${host}${port}${context}`;
  };

  const resourcePath = (complete: boolean, domain = ''): string => {
    if (remoteResource) {
      const scheme = site.resourceSSL || site.useSSL || ctx.https ? 'https' : 'http';
      return `${scheme}://${site.resourceDomain}${settings.serverPort}${settings.context}`;
    }
    if (!complete) return context;
    const host = previewOr(domain);
    return webPath(host !== '' ? host : serverNameOrDomain());
  };

  const assetPath = (complete: boolean): string =>
    `${resourcePath(complete, site.domain)}${settings.siteAssetPath}/${site.displayPoolID}`;

  const adminDomains = cfListToArray(settings.adminDomain, ',').map((domain) => domain.toLowerCase());
  const currentAdminDomain = adminDomains.includes(hostName.toLowerCase()) ? hostName : ctx.httpHost;
  const onAdminDomain = !remoteResource && settings.adminDomain !== '';
  // configBean getCorePath/getPluginsPath: a configured override, else the admin-domain URL on that host.
  const adminDomainPath = (override: string, suffix: string): string => {
    if (override !== '') return override;
    if (!cfEq(ctx.httpHost, currentAdminDomain)) return `${settings.context}${suffix}`;
    const scheme = site.useSSL || settings.adminSSL || ctx.https ? 'https' : 'http';
    return `${scheme}://${currentAdminDomain}${settings.serverPort}${settings.context}${suffix}`;
  };
  const corePluginsPath =
    (override: string, suffix: string) =>
    (complete: boolean): string =>
      onAdminDomain ? adminDomainPath(override, suffix) : `${resourcePath(complete || settings.adminSSL)}${suffix}`;
  const siteAdminPath = (complete: boolean): string => {
    if (onAdminDomain) return adminPath({ domain: currentAdminDomain, https: ctx.https, httpHost: ctx.httpHost });
    const domain = settings.adminDomain !== '' ? currentAdminDomain : '';
    return `${resourcePath(complete || settings.adminSSL || settings.adminDomain !== '', domain)}${settings.adminDir}`;
  };

  return {
    webPath: () => webPath(),
    rootPath: (complete) => resourcePath(complete),
    assetPath,
    fileAssetPath: (complete) =>
      settings.fileAssetPath !== ''
        ? `${settings.fileAssetPath}/${site.filePoolID}`
        : `${resourcePath(complete, site.domain)}${settings.siteAssetPath}/${site.filePoolID}`,
    corePath: corePluginsPath(settings.corePath, '/core'),
    pluginsPath: corePluginsPath(settings.pluginsPath, '/plugins'),
    adminPath: siteAdminPath,
  };
}

/** ACF `HTMLEditFormat`: drops CR and escapes `&`, `<`, `>` and `"`. */
function htmlEditFormat(s: string): string {
  return s
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * contentServer `getURLStem(siteid, filename)` (`contentServer.cfc` 946-1001) under the site's renderer, which turns
 * `siteIDInURLS` and `indexFileInURLS` off for a remote site (`contentRenderer.cfc` 684-695).
 */
export function urlStem(site: Pick<SiteBean, 'siteId' | 'isRemote'>, filename: string): string {
  const { siteIDInURLS, indexFileInURLS, hashURLS, legacyIndexFileLocation, siteAssetPath } = legacySettings();
  const remote = site.siteId !== '' && site.isRemote;
  const siteIdInUrls = !remote && siteIDInURLS;
  const indexFileInUrls = !remote && indexFileInURLS;
  let path = filename;
  if (path !== '') {
    if (!path.startsWith('/')) path = `/${path}`;
    if (!hashURLS && !path.endsWith('/')) path = `${path}/`;
  }
  const prefix = hashURLS ? '/#' : '';
  const { siteId } = site;
  if (!siteIdInUrls) {
    if (path === '') return '/';
    return indexFileInUrls ? `/index.cfm${prefix}${path}` : `${prefix}${path}`;
  }
  if (!indexFileInUrls) return path === '' ? `/${siteId}/` : `/${siteId}${prefix}${path}`;
  if (legacyIndexFileLocation) {
    return path === '' ? `${siteAssetPath}/${siteId}/` : `${siteAssetPath}/${siteId}/index.cfm${prefix}${path}`;
  }
  return path === '' ? `/index.cfm/${siteId}/` : `/index.cfm/${siteId}${prefix}${path}`;
}

/** The hash-URL query string `_/<name>/<value>…` (`contentRendererUtility.cfc` 1601-1613). */
function hashQueryString(querystring: string): string {
  let out = '_';
  for (const pair of cfListToArray(cfListToArray(querystring, '?')[0] ?? '', '&')) {
    const parts = cfListToArray(pair, '=');
    const [name] = parts;
    // Legacy reads qq[1] of the empty array, which throws.
    if (name === undefined) throw new RangeError(`The element at position 1 of the list "${pair}" cannot be found.`);
    out += `/${urlEncodedFormat(name)}/${parts.length === 2 ? parts[1] : 'true'}`;
  }
  return out;
}

/**
 * contentRendererUtility `createHREF(filename, querystring, complete=1)` (`contentRendererUtility.cfc` 1563-1660) of
 * a content of `site`, HTML-edit-formatted as legacy returns it; the content type only changes export HTML output.
 */
export function createHref(ctx: PathRequest, site: SiteBean, filename: string, querystring = ''): string {
  const { hashURLS } = legacySettings();
  let query = querystring;
  if (query !== '') {
    if (hashURLS) query = hashQueryString(query);
    else if (!query.startsWith('?')) query = `?${query}`;
  }
  if (hashURLS && query !== '' && !filename.endsWith('/')) query = `/${query}`;
  const begin = sitePaths(ctx, site).webPath();
  return htmlEditFormat(hashURLS ? begin + urlStem(site, filename + query) : begin + urlStem(site, filename) + query);
}
