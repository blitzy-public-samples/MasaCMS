// settingsBean and configBean path getters of a site, as an admin request sees them (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { legacySettings } from './env';
import type { AdminRequest, SiteData } from './request-context';
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
  readonly theme: string;
}

/**
 * The first theme directory `getThemeAssetPath` finds: `<siteDir>/<displayPoolID>/themes/<theme>` (`site`),
 * `<siteDir>/<displayPoolID>/includes/themes/<theme>` (`siteIncludes`), `<webroot>/themes/<theme>` (`webRoot`), or none.
 */
export type ThemeLayout = 'site' | 'siteIncludes' | 'webRoot' | 'none';

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
  /** `getThemeAssetPath()` for the site theme (`request.altTheme` is '' on admin requests) found at `layout`. */
  readonly themeAssetPath: (layout: ThemeLayout, complete: boolean) => string;
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
    theme: record.theme ?? '',
  };
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

  const themeDirectory: Readonly<Record<ThemeLayout, (complete: boolean) => string>> = {
    site: (complete) => `${assetPath(complete)}/themes/${site.theme}`,
    siteIncludes: (complete) => `${assetPath(complete)}/includes/themes/${site.theme}`,
    webRoot: (complete) => `${resourcePath(complete, site.domain)}/themes/${site.theme}`,
    none: assetPath,
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
    themeAssetPath: (layout, complete) => themeDirectory[layout](complete),
  };
}
