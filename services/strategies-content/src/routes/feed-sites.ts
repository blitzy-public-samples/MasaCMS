/** The site settings rendered feeds print: programs-sites' `getSite` values, configBean's from `MURA_<KEY>`, and the request's host. */
import { cfEq } from '@opt2/platform/legacy-compat';
import type { FastifyRequest } from '@opt2/platform/service-kit';
import type { LegacySiteUrlConfig } from '../legacy/content-urls.js';
import type { RssServerConfig } from '../legacy/rss.js';
import type { SiteFeedSettings, SitesClient } from '../legacy/sites-client.js';
import type { FeedRenderSite, FeedSiteSource } from './feed.js';
import { clientHostOf, requestProtocolOf, serverPortSetting, type JsonApiLegacySettings } from './jsonapi.js';

/** configBean `getServerPort()` and `getContext()`; `getIndexPath()` reads a setting Masa never defines, so ''. */
function serverConfigOf(request: FastifyRequest, settings: JsonApiLegacySettings): RssServerConfig {
  return { serverPort: settings.serverPort ?? serverPortSetting(clientHostOf(request).port), context: settings.context, indexPath: '' };
}

/**
 * settingsBean `getScheme`, `getWebPath`, `getServerPort` and `getContext` of `site` for this request, and the site
 * renderer's URL flags (settingsBean.cfc:1189-1221,1298-1300,1395-1467; contentRenderer.cfc:684-695).
 */
function feedSiteUrlsOf(site: SiteFeedSettings, request: FastifyRequest, settings: JsonApiLegacySettings): LegacySiteUrlConfig {
  const host = clientHostOf(request);
  const { remote } = site;
  const server = serverConfigOf(request, settings);
  // getWebPath's host: a remote site's domain; else cgi.server_name, when the primary domain is not enforced and
  // isValidDomain(mode='complete') finds it among the domain and its aliases; else the domain.
  const onSiteDomain = [site.domain, ...site.domainAliases].some((domain) => cfEq(domain, host.name));
  return {
    siteId: site.siteID,
    scheme: site.useSSL || requestProtocolOf(request) === 'https' ? 'https' : 'http',
    domain: site.domain,
    requestDomain: remote === null && host.name !== '' && !site.enforcePrimaryDomain && onSiteDomain ? host.name : site.domain,
    previewDomain: '',
    serverPort: remote?.serverPort ?? server.serverPort,
    context: remote?.context ?? server.context,
    ...settings.urls,
    ...(remote === null ? {} : { siteIdInUrls: false, indexFileInUrls: false }),
    useSSL: site.useSSL,
    // The RSS writers read no file or asset setting; each keeps the site default or empty value its type documents.
    filePoolId: site.siteID,
    configFileAssetPath: '',
    assetPath: '',
    fileStore: 'fileDir',
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  };
}

/** The feed site source over programs-sites' `lookupSiteFeedSettings` and the configBean `settings`. */
export function createFeedSiteSource(client: SitesClient, settings: JsonApiLegacySettings): FeedSiteSource {
  return {
    server: (request) => serverConfigOf(request, settings),
    async sites(siteIds, request) {
      const seen = new Set<string>();
      const ids = siteIds.filter((siteId) => !seen.has(siteId.toLowerCase()) && Boolean(seen.add(siteId.toLowerCase())));
      const found = await client.feedSettings(ids);
      return new Map(
        ids.map((siteId, at): [string, FeedRenderSite] => {
          const site = found[at];
          if (site === undefined) throw new TypeError(`programs-sites answered no feed settings for site '${siteId}'`);
          return [siteId.toLowerCase(), { urls: feedSiteUrlsOf(site, request, settings), contact: site.contact, javaLocale: site.javaLocale }];
        }),
      );
    },
  };
}
