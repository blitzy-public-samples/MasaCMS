/** Port of the values Masa's JSON API returns for the `site` entity, before serialization (jsonApiUtility.cfc). */
import { getSiteText, getSiteValue, type SiteBean, type SiteStoredValue } from './site-fields.js';

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:69-73,2097,2126-2128
/** Registered `site` fields plus the appended `isnew`; field selection is off, so a request `fields` is ignored. */
export const JSON_API_SITE_FIELDS = ['links', 'links', 'domain', 'siteid', 'isnew'] as const;

/** `request.muraAPIRequestMode`. */
export type JsonApiMode = 'json' | 'rest' | 'ajax';

/** Request and configBean values getEndPoint reads. */
export interface JsonApiEndpointInput {
  /** `utility.getRequestProtocol()`, without the colon, e.g. `http`. */
  readonly requestProtocol: string;
  /** `configBean.getAdminSSL()`. */
  readonly adminSSL: boolean;
  /** `cgi.server_name`. */
  readonly serverName: string;
  /** `configBean.getServerPort()`, e.g. `''` or `':8080'`. */
  readonly serverPort: string;
  /** `configBean.getContext()`, e.g. `''` or `'/masa'`. */
  readonly context: string;
  readonly mode: JsonApiMode;
  /** The request's site id. */
  readonly siteId: string;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:3337-3364 ("Rigged to always have index.cfm")
/** The JSON API endpoint URL legacy builds for an API request. */
export function jsonApiBaseUrl({
  requestProtocol,
  adminSSL,
  serverName,
  serverPort,
  context,
  mode,
  siteId,
}: JsonApiEndpointInput): string {
  const protocol = adminSSL ? 'https:' : `${requestProtocol}:`;
  return `${protocol}//${serverName}${serverPort}${context}/index.cfm/_api/${mode}/v1/${siteId}`;
}

/** The `links` getLinks builds for a site bean. */
export interface JsonApiSiteLinks {
  readonly entities: string;
  readonly all: string;
  readonly properties: string;
  readonly self: string;
  readonly permissions: string;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:3374-3470
// No `edit` (the site bean has no edit URL) and no has-one/has-many links (site registers none);
// golden capture GS-CO-05/GS-PS is the evidence.
/** Links of the site entity `siteId` under `baseUrl`. */
export function jsonApiSiteLinks(baseUrl: string, siteId: string): JsonApiSiteLinks {
  return {
    entities: baseUrl,
    all: `${baseUrl}/site`,
    properties: `${baseUrl}/site/properties`,
    self: `${baseUrl}/site`,
    permissions: `${baseUrl}/site/${siteId}/permissions`,
  };
}

/** A site's JSON API values; `domain` is the stored value, so it keeps a non-string value as legacy does. */
export interface JsonApiSiteValues {
  readonly links: JsonApiSiteLinks;
  readonly domain: SiteStoredValue;
  readonly siteid: string;
  readonly isnew: 0 | 1;
  readonly id: string;
  readonly entityname: 'site';
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2137-2166,2192-2198,2221
// legacy: core/mura/settings/settingsBean.cfc:376-387 (domain)
/** The values getFilteredValues returns for a site bean: the fixed field list, `id`, `links` and `entityname`. */
export function jsonApiSiteValues(bean: SiteBean, baseUrl: string): JsonApiSiteValues {
  const siteid = getSiteText(bean, 'siteid');
  return {
    links: jsonApiSiteLinks(baseUrl, siteid),
    domain: getSiteValue(bean, 'domain'),
    siteid,
    isnew: bean.isNew,
    id: siteid,
    entityname: 'site',
  };
}

/** Verified user-token claims canWriteSite reads; declared structurally. */
export interface SiteWriteClaims {
  readonly s2?: boolean;
}

// legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1801-1806 (allowAction 'site': isSuperUser)
/** Whether the caller may save or delete a site through the JSON API. */
export function canWriteSite(claims: SiteWriteClaims): boolean {
  return claims.s2 === true;
}
