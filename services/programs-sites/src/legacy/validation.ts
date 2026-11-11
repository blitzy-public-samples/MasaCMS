/** Port of the site settings bean's validate() and its errors test (core/mura/settings). */
import { getSiteValue, type SiteBean } from './site-fields.js';

/** Legacy message for an empty site id, its `==` typo included. */
export const SITE_ERROR_REQUIRED = "The 'SiteID' variable == required.";

/** Legacy message for a reserved site id, its `==` typo included. */
export const SITE_ERROR_INVALID = "The 'SiteID' variable == invalid.";

/** The bean's errors struct: lower-cased field name to legacy message. */
export type SiteErrors = Record<string, string>;

/** Reserved site ids, lower-cased because CFML `==` compares strings case-insensitively. */
const RESERVED_SITE_IDS: ReadonlySet<string> = new Set(['admin', 'tasks']);

/**
 * The errors settingsBean.validate() leaves on the bean (settingsBean.cfc:293-307); a fresh struct on every call.
 * siteID is read as the bean holds it, already trimmed by set and read.
 */
export function validateSite(bean: SiteBean): SiteErrors {
  const errors: SiteErrors = {};
  const siteId = getSiteValue(bean, 'siteID');
  if (siteId === '') errors.siteid = SITE_ERROR_REQUIRED;
  if (typeof siteId === 'string' && RESERVED_SITE_IDS.has(siteId.toLowerCase())) errors.siteid = SITE_ERROR_INVALID;
  return errors;
}

/** True when validation left an error: the negation of `structIsEmpty(bean.getErrors())` (settingsManager.cfc:265). */
export function hasSiteErrors(errors: SiteErrors): boolean {
  return Object.keys(errors).length > 0;
}
