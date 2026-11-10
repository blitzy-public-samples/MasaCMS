import { createHash } from 'node:crypto';

// ACF 2023 hash() with no algorithm argument yields SHA-256, not MD5: legacy ETags and CSRF tokens are 64-hex SHA-256.
const CF_HASH_DEFAULT_ALGORITHM = 'sha256';

/** Uppercase hex of ColdFusion hash(s) over UTF-8 bytes (jsonApiUtility.cfc:1508, sessionUserFacade.cfc:250). */
export function cfHash(s: string): string {
  return createHash(CF_HASH_DEFAULT_ALGORITHM).update(s, 'utf8').digest('hex').toUpperCase();
}

/** ETag value for an exact serialized body; unquoted, never weak (jsonApiUtility.cfc:1506-1508). */
export function etag(body: string): string {
  return cfHash(body);
}

/** Headers legacy adds to every response (onRequestStart_include.cfm:333-344). */
export function legacyHeaders(version = '7.6.1', hstsMaxAge: number = 1200): Record<string, string> {
  const generator = `Masa CMS ${version}`;
  return hstsMaxAge
    ? { 'Strict-Transport-Security': `max-age=${hstsMaxAge}`, Generator: generator }
    : { Generator: generator };
}

// Wire forms: the servlet container rewrites setContentType('...; charset=utf-8') without the space.
/** JSON API content type as legacy sends it (jsonApiUtility.cfc:1473). */
export const LEGACY_JSON_CONTENT_TYPE = 'application/json;charset=utf-8';
/** Shunter layout content type as legacy sends it (jsonApiUtility.cfc:1501). */
export const LEGACY_SHUNTER_CONTENT_TYPE = 'application/x-shunter+json;charset=utf-8';

const ORIGIN_DOMAIN = /^\w+:\/\/([^/:]+)[\w\W]*$/;

function eqNoCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Echoes an Origin whose host equals, or is a sub-domain of, an allowed domain (jsonApiUtility.cfc:382-394). */
export function corsHeaders(
  originHeader: string | undefined,
  allowedDomains: readonly string[],
): Record<string, string> {
  if (originHeader === undefined) return {};
  // reReplace semantics: an origin without a scheme stays whole.
  const originDomain = originHeader.replace(ORIGIN_DOMAIN, '$1');
  const allowed = allowedDomains.some(
    (domain) =>
      eqNoCase(domain, originDomain) ||
      (originDomain.length > domain.length &&
        eqNoCase(originDomain.slice(originDomain.length - domain.length - 1), `.${domain}`)),
  );
  return allowed
    ? { 'Access-Control-Allow-Origin': originHeader, 'Access-Control-Allow-Credentials': 'true' }
    : {};
}

/** Site registry fields that feed the CORS allow-list (settingsBean.cfc:1531-1555). */
export interface AccessControlSite {
  domain: string;
  domainAlias?: string;
  isRemote?: boolean;
  resourceDomain?: string;
}

/** Global config fields that feed the CORS allow-list (settingsBean.cfc:1536-1540). */
export interface AccessControlConfig {
  adminDomain?: string;
  currentAdminDomain?: string;
}

/** CFML listToArray over commas: empty elements dropped. */
function commaElements(list: string): string[] {
  return list.split(',').filter((element) => element !== '');
}

/** Per-site allow-list, deduplicated case-insensitively (settingsBean.cfc:1531-1555). */
function siteOriginDomains(site: AccessControlSite, cfg: AccessControlConfig): string[] {
  const list = commaElements(site.domain);
  const appendNoCase = (value: string): void => {
    if (!list.some((element) => eqNoCase(element, value))) list.push(...commaElements(value));
  };
  if (cfg.adminDomain) appendNoCase(cfg.currentAdminDomain ?? '');
  if (site.isRemote && site.resourceDomain) appendNoCase(site.resourceDomain);
  // listToArray(domainAlias, chr(13)&chr(10)) treats CR and LF each as a delimiter.
  for (const alias of (site.domainAlias ?? '').split(/[\r\n]/)) {
    if (alias !== '') appendNoCase(alias);
  }
  return list;
}

/** Allowed CORS origin domains across sites, deduplicated case-sensitively (settingsManager.cfc:842-888). */
export function accessControlOriginDomains(
  sites: readonly AccessControlSite[],
  cfg: AccessControlConfig,
): string[] {
  // settingsManager.cfc:852 assigns adminDomain to an unused variable, so it is not added here.
  const domains: string[] = [];
  for (const site of sites) {
    for (const origin of siteOriginDomains(site, cfg)) {
      if (!domains.includes(origin)) domains.push(origin);
    }
  }
  return domains;
}

/** WWW-Authenticate values legacy sends (jsonApiUtility.cfc:479-829). */
export const WWW_AUTHENTICATE = {
  basic: 'Basic',
  bearerInvalidAccessToken: 'Bearer error="invalid_access_token"',
  bearer: 'Bearer',
  bearerInvalidClientCredentials: 'Bearer error="invalid_client_credentials"',
  bearerInvalidAuthorizationCode: 'Bearer error="invalid_authorization_code"',
  bearerInvalidClientRefreshToken: 'Bearer error="invalid_client_refresh_token"',
  // Unbalanced quote reproduced from jsonApiUtility.cfc:805.
  bearerInvalidGrantType: 'Bearer error="invalid_grant_type',
} as const;

/** setHeader calls for a missing or wrong-grant access token, in order (jsonApiUtility.cfc:495-496). */
export const INVALID_ACCESS_TOKEN_HEADER_SEQUENCE: readonly string[] = [
  WWW_AUTHENTICATE.bearerInvalidAccessToken,
  WWW_AUTHENTICATE.bearer,
];

// Legacy answers a bogus Bearer token with `WWW-Authenticate: Bearer`; the GS-ID-08 and GS-CO-15 golden capture decides.
/** Header value left by successive setHeader calls, which replace each other. */
export function effectiveWwwAuthenticate(sequence: readonly string[]): string {
  return sequence[sequence.length - 1] ?? '';
}
