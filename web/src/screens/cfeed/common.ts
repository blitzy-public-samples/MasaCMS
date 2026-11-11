// Helpers the collection (cFeed) screens share: feed API endpoint, `utility.displayErrors`, CFML flags (server-only).
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { join, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest, SiteData } from '@/lib/request-context';

/** A flag as the contracts type it: an integer, a string or a boolean; SQL NULL as `null` or absent. */
export type CfFlag = number | string | boolean | null | undefined;

/** The request values the feed API endpoint depends on. */
export type FeedEndpointRequest = Pick<AdminRequest, 'site' | 'serverName' | 'https'>;

/** CFML truthiness of a flag: `''`, `null` and `undefined` are false, else CFML boolean conversion (throws as CFML). */
export function cfTruthy(value: CfFlag): boolean {
  return value === '' || value === null || value === undefined ? false : cfToBoolean(value);
}

/** CFML `yesNoFormat`. */
export function yesNoFormat(value: CfFlag): 'Yes' | 'No' {
  return cfTruthy(value) ? 'Yes' : 'No';
}

/** `utility.displayErrors`: every message but `siteID`'s, unencoded and in map order, as ACF emits them. */
export function displayErrors(errors: Readonly<Record<string, string>>): SafeHtml {
  const entries = Object.entries(errors);
  return join(
    entries.flatMap(([key, message], index) =>
      // The `<br>` test counts every key, `siteID` included, so a trailing `siteID` leaves a `<br>` after the last
      // message. The single spaces are the tag-body whitespace ACF whitespace management emits.
      key.toLowerCase() === 'siteid' ? [] : [raw(`${message} ${entries.length > index + 1 ? '<br> ' : ''}`)],
    ),
  );
}

/** settingsBean `isValidDomain(domain, mode='complete')`: the site domain or one of its CR/LF-separated aliases. */
function isValidDomain(site: SiteData, domain: string): boolean {
  if (cfEq(domain, site.domain)) return true;
  return (site.record.domainAlias ?? '')
    .split(/[\r\n]/)
    .some((alias) => alias !== '' && cfEq(domain, alias));
}

/** settingsBean `getUseSSL()` of a read row: a stored `useSSL` also sets `extranetSSL`; NULL leaves it as read. */
function siteUseSSL(site: SiteData): boolean {
  const { useSSL, ExtranetSSL } = site.record;
  return useSSL === null || useSSL === undefined ? cfTruthy(ExtranetSSL) : cfTruthy(useSSL);
}

/** settingsBean `getResourcePath(complete=1)` (settingsBean.cfc:1473-1500, through getWebPath 1435-1460). */
function resourcePath(req: FeedEndpointRequest, site: SiteData): string {
  const settings = legacySettings();
  const { record } = site;
  const useSSL = siteUseSSL(site);
  // Numeric settingsBean setters ignore NULL, which leaves the bean defaults (isRemote 0, RemotePort 80, …).
  const isRemote = cfTruthy(record.isremote);
  const resourceDomain = record.resourceDomain ?? '';
  if (isRemote && resourceDomain !== '') {
    const scheme = cfTruthy(record.resourceSSL) || useSSL || req.https ? 'https' : 'http';
    return `${scheme}://${resourceDomain}${settings.serverPort}${settings.context}`;
  }
  // getResourcePath settles the domain before getWebPath runs, so getWebPath's own remote-site fallback, which only
  // runs for an empty domain, yields the same site domain. `request.muraPreviewDomain` is always '' in Masa core.
  const domain =
    req.serverName !== '' && !cfTruthy(record.enforcePrimaryDomain) && isValidDomain(site, req.serverName)
      ? req.serverName
      : site.domain;
  const remotePort = record.remoteport ?? 80;
  const port = !isRemote ? settings.serverPort : remotePort === 80 || remotePort === 443 ? '' : `:${remotePort}`;
  const context = isRemote ? (record.remotecontext ?? '') : settings.context;
  return `${useSSL || req.https ? 'https' : 'http'}://${domain}${port}${context}`;
}

/**
 * `$.siteConfig().getApi('feed','v1').getEndpoint()`: `provided` (the endpoint strategies-content returned) when it
 * is a non-empty string, else `<resourcePath(complete=1)>/_api/feed/v1/<siteid>` from the session site.
 * @throws Error when nothing is provided and programs-sites served no site data for the request.
 */
export function feedApiEndpoint(req: FeedEndpointRequest, provided?: unknown): string {
  if (typeof provided === 'string' && provided !== '') return provided;
  if (req.site === undefined) throw new Error('feedApiEndpoint: no endpoint provided and no site data to build it');
  // feedApiUtility puts configBean.getIndexPath() before `/_api`, not `/index.cfm`. It reads the `indexPath` setting,
  // which no Masa setting defines, so it is '' and `indexFileInURLS`/`indexFileInAPI` leave the endpoint unchanged.
  return `${resourcePath(req, req.site)}/_api/feed/v1/${req.site.siteid}`;
}
