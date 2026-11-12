import type { AdminSessionState } from '@/lib/request-context';

// The session as JSON: DateKey.script is a SafeHtml, which only web's markup helpers can create, so it is its markup.
type AdminSessionPreset = Omit<AdminSessionState, 'dateKey'> & {
  readonly dateKey: Omit<AdminSessionState['dateKey'], 'script'> & { readonly script: string };
};

export const USER_IDS = Object.freeze({
  admin: '5A000000-0000-0000-0000000000000001',
  qaEditor: '5A000000-0000-0000-0000000000000002',
  tenantASiteAdmin: '5A000000-0000-0000-0000000000000003',
  noSitesUser: '5A000000-0000-0000-0000000000000004',
  s2PrivateMember: '5A000000-0000-0000-0000000000000005',
} as const);

const HOME_TOP_ID = '00000000000000000000000000000000001';
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const USERS_MODULE_ID = '00000000000000000000000000000000008';

// en_US as legacy builds it: dtLocale is the locale with '-', ACF's DD mask is the day of the year, and
// LSTimeFormat(createTime(0,0,0),'medium') contains AM.
const EN_US_DATE = {
  rb: 'en_US',
  locale: 'en_US',
  dateKey: {
    locale: 'en-US',
    dtCh: '/',
    dtFormat: '0,1,2',
    dateKeyFormat: 'MM/DD/YYYY',
    dtExample: '11/315/2024',
    script:
      '<script type="text/javascript">var dtExample="11/315/2024", dtCh="/", dtFormat =[0,1,2], dtLocale="en-US";</script>',
    objInc: 'dtExample:"11/315/2024",\r\ndtCh:"/",\r\ndtFormat:[0,1,2],\r\ndtLocale:"en-US"',
  },
  dateKeyFormat: 'MM/DD/YYYY',
  localeHasDayParts: true,
} as const;

const SESSION_DEFAULTS = {
  topID: HOME_TOP_ID,
  openSectionList: '',
  keywords: '',
  dashboardSpan: 30,
  paramArray: [],
  paramCount: 0,
  paramCircuit: '',
  paramCategories: '',
  paramGroups: '',
  inActive: '',
  membersOnly: 'false',
  visitorStatus: 'All',
  frontEndProxyLoc: '',
  muraValues: {},
  hasDefaultPassword: false,
  moduleTopIds: {},
  flash: {},
  nextPreserveKey: 1,
} as const;

const ADMIN_ERROR_ALERT = { type: '', text: 'The synthetic feed import did not finish.' } as const;
const ADMIN_INFO_ALERT = {
  type: 'info',
  text: 'Maintenance is planned for <strong>July 1</strong>. <a href="./?muraAction=cDashboard.main">Details</a>',
} as const;

// configBean replaces an empty assetPath with '/sites' (siteDir), so userFilesPath is '/sites/<siteid>/assets/'.
export const adminS2Session = {
  ...SESSION_DEFAULTS,
  ...EN_US_DATE,
  siteid: 'default',
  userFilesPath: '/sites/default/assets/',
  moduleid: CONTENT_MODULE_ID,
  keywords: 'home',
  alerts: {
    default: {
      feedimportfailed: ADMIN_ERROR_ALERT,
      maintenanceinfo: ADMIN_INFO_ALERT,
      cachenotice: { type: '', text: '' },
      defaultpasswordnotice: { type: '', text: '' },
    },
  },
  siteArray: ['default', 'umbrella', 'tenant-a', 'tenant-b'],
  s2IsPrivate: true,
  mura: {
    isLoggedIn: true,
    userID: USER_IDS.admin,
    username: 'admin',
    siteID: 'default',
    subtype: 'Default',
    fname: 'Admin',
    lname: 'User',
    email: 'admin@example.com',
    remoteID: '',
    company: '',
    lastlogin: '2026-06-30T08:00:00.000',
    passwordCreated: '2026-01-05T09:30:00.000',
    memberships: 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default',
    alerts: {
      default: {
        feedimportfailed: ADMIN_ERROR_ALERT,
        maintenanceinfo: ADMIN_INFO_ALERT,
        cachenotice: false,
        defaultpasswordnotice: false,
      },
    },
  },
} as const satisfies AdminSessionPreset;

export const qaEditorSession = {
  ...SESSION_DEFAULTS,
  ...EN_US_DATE,
  siteid: 'default',
  userFilesPath: '/sites/default/assets/',
  moduleid: CONTENT_MODULE_ID,
  alerts: { default: {} },
  siteArray: ['default'],
  s2IsPrivate: true,
  mura: {
    isLoggedIn: true,
    userID: USER_IDS.qaEditor,
    username: 'qa_editor',
    siteID: 'default',
    subtype: 'Default',
    fname: 'Quinn',
    lname: 'Editor',
    email: 'qa_editor@example.com',
    remoteID: '',
    company: '',
    lastlogin: '2026-06-30T08:15:00.000',
    passwordCreated: '2026-02-10T10:00:00.000',
    memberships: 'Editor;default;0,S2IsPrivate;default,S2IsPrivate,qa_editor;username;default',
  },
} as const satisfies AdminSessionPreset;

export const tenantASiteAdminSession = {
  ...SESSION_DEFAULTS,
  ...EN_US_DATE,
  siteid: 'tenant-a',
  userFilesPath: '/sites/tenant-a/assets/',
  moduleid: USERS_MODULE_ID,
  frontEndProxyLoc: 'http://tenant-a.localhost:8100',
  alerts: { 'tenant-a': {} },
  siteArray: ['tenant-a'],
  s2IsPrivate: true,
  mura: {
    isLoggedIn: true,
    userID: USER_IDS.tenantASiteAdmin,
    username: 'tenant_a_admin',
    siteID: 'tenant-a',
    subtype: 'Default',
    fname: 'Tessa',
    lname: 'Admin',
    email: 'tenant_a_admin@example.com',
    remoteID: '',
    company: '',
    lastlogin: '2026-06-30T08:30:00.000',
    passwordCreated: '2026-03-02T11:00:00.000',
    memberships: 'Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,tenant_a_admin;username;tenant-a',
  },
} as const satisfies AdminSessionPreset;

// s2IsPrivate false needs a public-pool account: loginByQuery adds S2IsPrivate for every private (system) user.
export const noSitesSession = {
  ...SESSION_DEFAULTS,
  ...EN_US_DATE,
  siteid: 'default',
  userFilesPath: '/sites/default/assets/',
  moduleid: '',
  alerts: { default: {} },
  siteArray: [],
  s2IsPrivate: false,
  mura: {
    isLoggedIn: true,
    userID: USER_IDS.noSitesUser,
    username: 'no_sites_member',
    siteID: 'default',
    subtype: 'Default',
    fname: 'Nadia',
    lname: 'Member',
    email: 'no_sites_member@example.com',
    remoteID: '',
    company: '',
    lastlogin: '2026-06-30T09:00:00.000',
    passwordCreated: '2026-04-20T14:00:00.000',
    memberships: 'S2IsPublic;default,S2IsPublic,no_sites_member;username;default',
  },
} as const satisfies AdminSessionPreset;

export const s2PrivateMemberSession = {
  ...SESSION_DEFAULTS,
  ...EN_US_DATE,
  siteid: 'default',
  userFilesPath: '/sites/default/assets/',
  moduleid: '',
  alerts: { default: {} },
  siteArray: [],
  s2IsPrivate: true,
  mura: {
    isLoggedIn: true,
    userID: USER_IDS.s2PrivateMember,
    username: 's2_private_member',
    siteID: 'default',
    subtype: 'Default',
    fname: 'Sasha',
    lname: 'Private',
    email: 's2_private_member@example.com',
    remoteID: '',
    company: '',
    lastlogin: '2026-06-30T09:15:00.000',
    passwordCreated: '2026-05-11T15:00:00.000',
    memberships: 'S2IsPrivate;default,S2IsPrivate,s2_private_member;username;default',
  },
} as const satisfies AdminSessionPreset;

export const sessionPresets = {
  admin: adminS2Session,
  qaEditor: qaEditorSession,
  tenantASiteAdmin: tenantASiteAdminSession,
  noSites: noSitesSession,
  s2PrivateMember: s2PrivateMemberSession,
} as const satisfies Readonly<Record<string, AdminSessionPreset>>;
