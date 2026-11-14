import type { components } from '@/generated/clients/programs-sites';
import { SITE_IDS, siteListItemById } from './sites';

/** A legacy bean's errors: field name to message, as the Sites screen renders them. */
type SiteErrors = Readonly<Record<string, string>>;
type SiteOrderUpdate = components['schemas']['SiteOrderUpdate'];
type SiteOrderResult = components['schemas']['SiteOrderResult'];

export const SITE_ERRORS_SITEID_REQUIRED = {
  siteid: "The 'SiteID' variable == required.",
} as const satisfies SiteErrors;

export const SITE_ERRORS_SITEID_INVALID = {
  siteid: "The 'SiteID' variable == invalid.",
} as const satisfies SiteErrors;

export const SITE_ERRORS_MISSING_NAME = {
  site: 'Synthetic fixture message: the site name is empty.',
} as const satisfies SiteErrors;

export const SITE_ERRORS_DUPLICATE_DOMAIN = {
  domain: 'Synthetic fixture message: the domain is bound to another site.',
} as const satisfies SiteErrors;

export const SITE_ERRORS_MULTI = {
  ...SITE_ERRORS_MISSING_NAME,
  ...SITE_ERRORS_SITEID_REQUIRED,
  ...SITE_ERRORS_DUPLICATE_DOMAIN,
} as const satisfies SiteErrors;

export const SITE_ORDER_UPDATE = {
  orderID: `${SITE_IDS.default},${SITE_IDS.umbrella},${SITE_IDS.tenantA},${SITE_IDS.tenantB}`,
  orderno: '2,4,1,3',
  sortBy: 'orderno',
  sortDirection: 'asc',
} as const satisfies SiteOrderUpdate;

export const SITE_ORDER_RESULT_SUCCESS: SiteOrderResult = {
  written: true,
  sites: [
    { ...siteListItemById[SITE_IDS.tenantA], orderno: 1 },
    { ...siteListItemById[SITE_IDS.default], orderno: 2 },
    { ...siteListItemById[SITE_IDS.tenantB], orderno: 3 },
    { ...siteListItemById[SITE_IDS.umbrella], orderno: 4 },
  ],
};
