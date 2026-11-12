import type { components } from '@/generated/clients/programs-sites';

type Site = components['schemas']['Site'];
type SiteListItem = components['schemas']['SiteListItem'];

export const SITE_IDS = {
  default: 'default',
  umbrella: 'umbrella',
  tenantA: 'tenant-a',
  tenantB: 'tenant-b',
} as const;

export type FixtureSiteId = (typeof SITE_IDS)[keyof typeof SITE_IDS];

const SITE_SETTINGS_DEFAULTS = {
  PageLimit: 1000,
  Locking: 'none',
  ViewDepth: 1,
  NextN: 20,
  DataCollection: 1,
  EmailBroadcaster: 0,
  Extranet: 0,
  feedManager: 1,
  columnCount: 3,
  columnNames: 'Left Column^Main Content^Right Column',
  primaryColumn: 2,
  CommentApprovalDefault: 1,
} as const;

export const siteDefault = {
  SiteID: SITE_IDS.default,
  Site: 'Default',
  Domain: 'localhost',
  domainAlias: '',
  orderNo: 1,
  ...SITE_SETTINGS_DEFAULTS,
  loginURL: '?display=login',
  editProfileURL: '?display=editProfile',
  deploy: 0,
  lastDeployment: null,
  privateUserPoolID: SITE_IDS.default,
  publicUserPoolID: SITE_IDS.default,
  displayPoolID: SITE_IDS.default,
  contentPoolID: SITE_IDS.default,
  categoryPoolID: SITE_IDS.default,
  filePoolID: SITE_IDS.default,
} as const satisfies Site;

// Seeded sites take Domain, domainAlias and orderNo from the seed generator (legacy-fixtures/seed/src/masa.ts).
export const siteUmbrella = {
  SiteID: SITE_IDS.umbrella,
  Site: 'Umbrella',
  Domain: 'umbrella.localhost',
  domainAlias: 'localhost',
  orderNo: 2,
  ...SITE_SETTINGS_DEFAULTS,
  loginURL: '',
  editProfileURL: '',
  deploy: 0,
  lastDeployment: null,
  privateUserPoolID: SITE_IDS.umbrella,
  publicUserPoolID: SITE_IDS.umbrella,
  displayPoolID: SITE_IDS.umbrella,
  contentPoolID: SITE_IDS.umbrella,
  categoryPoolID: SITE_IDS.umbrella,
  filePoolID: SITE_IDS.umbrella,
} as const satisfies Site;

export const siteTenantA = {
  SiteID: SITE_IDS.tenantA,
  Site: 'Tenant A',
  Domain: 'tenant-a.localhost',
  domainAlias: 'localhost',
  orderNo: 3,
  ...SITE_SETTINGS_DEFAULTS,
  loginURL: '',
  editProfileURL: '',
  deploy: 1,
  lastDeployment: '2026-10-29T10:15:00.000',
  privateUserPoolID: SITE_IDS.tenantA,
  publicUserPoolID: SITE_IDS.umbrella,
  displayPoolID: SITE_IDS.umbrella,
  contentPoolID: SITE_IDS.tenantA,
  categoryPoolID: SITE_IDS.umbrella,
  filePoolID: SITE_IDS.umbrella,
} as const satisfies Site;

export const siteTenantB = {
  SiteID: SITE_IDS.tenantB,
  Site: 'Tenant B',
  Domain: 'tenant-b.localhost',
  domainAlias: 'localhost',
  orderNo: 4,
  ...SITE_SETTINGS_DEFAULTS,
  loginURL: '',
  editProfileURL: '',
  deploy: 0,
  lastDeployment: null,
  privateUserPoolID: SITE_IDS.tenantB,
  publicUserPoolID: SITE_IDS.tenantB,
  displayPoolID: SITE_IDS.tenantB,
  contentPoolID: SITE_IDS.tenantB,
  categoryPoolID: SITE_IDS.tenantB,
  filePoolID: SITE_IDS.tenantB,
} as const satisfies Site;

export const siteById: Record<FixtureSiteId, Site> = {
  [SITE_IDS.default]: siteDefault,
  [SITE_IDS.umbrella]: siteUmbrella,
  [SITE_IDS.tenantA]: siteTenantA,
  [SITE_IDS.tenantB]: siteTenantB,
};

export const siteListItemById: Record<FixtureSiteId, SiteListItem> = {
  [SITE_IDS.default]: {
    siteid: siteDefault.SiteID,
    site: siteDefault.Site,
    domain: siteDefault.Domain,
    orderno: siteDefault.orderNo,
    deploy: siteDefault.deploy,
    lastDeployment: siteDefault.lastDeployment,
  },
  [SITE_IDS.umbrella]: {
    siteid: siteUmbrella.SiteID,
    site: siteUmbrella.Site,
    domain: siteUmbrella.Domain,
    orderno: siteUmbrella.orderNo,
    deploy: siteUmbrella.deploy,
    lastDeployment: siteUmbrella.lastDeployment,
  },
  [SITE_IDS.tenantA]: {
    siteid: siteTenantA.SiteID,
    site: siteTenantA.Site,
    domain: siteTenantA.Domain,
    orderno: siteTenantA.orderNo,
    deploy: siteTenantA.deploy,
    lastDeployment: siteTenantA.lastDeployment,
  },
  [SITE_IDS.tenantB]: {
    siteid: siteTenantB.SiteID,
    site: siteTenantB.Site,
    domain: siteTenantB.Domain,
    orderno: siteTenantB.orderNo,
    deploy: siteTenantB.deploy,
    lastDeployment: siteTenantB.lastDeployment,
  },
};

export const SITE_LIST: SiteListItem[] = [
  siteListItemById[SITE_IDS.default],
  siteListItemById[SITE_IDS.tenantA],
  siteListItemById[SITE_IDS.tenantB],
  siteListItemById[SITE_IDS.umbrella],
];

export const SITE_LIST_BY_ORDERNO: SiteListItem[] = [
  siteListItemById[SITE_IDS.default],
  siteListItemById[SITE_IDS.umbrella],
  siteListItemById[SITE_IDS.tenantA],
  siteListItemById[SITE_IDS.tenantB],
];

export const LONG_SITE_LIST: SiteListItem[] = [
  ...SITE_LIST,
  ...Array.from({ length: 101 }, (_, index): SiteListItem => {
    const number = String(index + 11);
    return {
      siteid: `site-${number}`,
      site: `Site ${number}`,
      domain: `site-${number}.example.test`,
      orderno: index + 5,
      deploy: 0,
      lastDeployment: null,
    };
  }),
];

export const SITE_LIST_10: SiteListItem[] = LONG_SITE_LIST.slice(0, 10);

export const SITE_LIST_11: SiteListItem[] = LONG_SITE_LIST.slice(0, 11);
