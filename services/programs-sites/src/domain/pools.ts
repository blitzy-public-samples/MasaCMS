/** Port of Masa's site pool and origin-domain rules (settingsBean.cfc) that build the site registry event payload. */
import type { SiteChangedPayload } from '@opt2/platform/tenancy';
import { getSiteText, readBean, type SiteBean, type SiteRow } from '../legacy/site-fields.js';

// listToArray(value, chr(13)&chr(10)): each character is a delimiter on its own, and empty elements are dropped.
const LINE_BREAKS = /[\r\n]+/;

// CFML truth of a bean flag: true/yes, false/no or a number (the setters store numeric text).
function cfBoolean(value: string): boolean {
  return /^(?:true|yes)$/i.test(value) || (!/^(?:false|no)$/i.test(value) && Number(value) !== 0);
}

/** The `programs-sites.site.changed.v1` payload of a stored site row: legacy site ids after Masa's pool defaults. */
export function siteChangedPayload(row: SiteRow): SiteChangedPayload {
  const bean = readBean(row);
  return {
    siteId: getSiteText(bean, 'siteID'),
    publicUserPoolId: getSiteText(bean, 'publicUserPoolID'),
    privateUserPoolId: getSiteText(bean, 'privateUserPoolID'),
    categoryPoolId: getSiteText(bean, 'categoryPoolID'),
    filePoolId: getSiteText(bean, 'filePoolID'),
    displayPoolId: getSiteText(bean, 'displayPoolID'),
    contentPoolIds: contentPoolIds(bean),
    domains: siteDomains(bean),
  };
}

/** Site ids of the `contentPoolID` list in stored order, trimmed, empties dropped; `[siteID]` when none remain. */
export function contentPoolIds(bean: SiteBean): string[] {
  const ids = getSiteText(bean, 'contentPoolID')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return ids.length > 0 ? ids : [getSiteText(bean, 'siteID')];
}

/**
 * Site-scoped getAccessControlOriginDomainList: domain, resourceDomain of a remote site, then each domainAlias line,
 * de-duplicated case-insensitively with the first casing kept.
 * The admin-domain term (configBean.getAdminDomain()) is global configuration, not site row data, so it is omitted.
 */
export function siteDomains(bean: SiteBean): string[] {
  const candidates = [getSiteText(bean, 'domain')];
  if (cfBoolean(getSiteText(bean, 'isRemote'))) candidates.push(getSiteText(bean, 'resourceDomain'));
  candidates.push(...getSiteText(bean, 'domainAlias').split(LINE_BREAKS));

  const seen = new Set<string>();
  const domains: string[] = [];
  for (const domain of candidates) {
    const key = domain.toLowerCase();
    if (domain === '' || seen.has(key)) continue;
    seen.add(key);
    domains.push(domain);
  }
  return domains;
}
