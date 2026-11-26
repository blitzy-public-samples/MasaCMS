// The domains an anonymous admin request's login return URL is sanitized against (server-only).
import { cfListToArray } from '@opt2/platform/legacy-compat';
import { legacySettings } from './env';
import { okBody, type GatewayClient } from './gateway-client';
import type { HrefDomains } from './urls';

/**
 * settingsManager getAccessControlOriginDomainList and getSite(siteId).getDomain(), as programs-sites serves them,
 * plus settingsBean's configBean.getCurrentAdminDomain() term when an admin domain is configured.
 * @param siteId The site `getSite` reads, the token's site when one is presented; programs-sites resolves an empty or
 * unknown id to `default`.
 * @param httpHost `cgi.http_host` of the browser request.
 * @throws GatewayDenialError When programs-sites answers 401 or 403.
 */
export async function loadHrefDomains(gateway: GatewayClient, siteId: string, httpHost: string): Promise<HrefDomains> {
  const { allowedDomains, siteDomain } = okBody(
    await gateway.programsSites.hrefDomains(siteId),
    'programs-sites',
    'getHrefDomains',
  );
  const hostName = cfListToArray(httpHost, ':')[0] ?? '';
  const sameName = (domain: string): boolean => domain.toLowerCase() === hostName.toLowerCase();
  // With an admin domain set, only a request on one reaches the gate (admin/Application.cfc:428), so the term is that
  // configured name; getCurrentAdminDomain's fallback to the raw Host is never taken, and the Host is never trusted.
  const onAdminDomain = cfListToArray(legacySettings().adminDomain, ',').some(sameName);
  if (!onAdminDomain || allowedDomains.some(sameName)) return { allowedDomains, siteDomain };
  return { allowedDomains: [...allowedDomains, hostName], siteDomain };
}
