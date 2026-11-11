/** Port of Masa's site settings bean, its DAO read and update rules and the site list order (core/mura/settings). */
import {
  cfEq,
  cfIsBoolean,
  cfIsDate,
  cfIsNumeric,
  cfNumberString,
  cfToBoolean,
  javaTrim,
} from '@opt2/platform/legacy-compat';

/** One live `tsettings` column: its legacy catalog casing and its `programs_sites.site` column. */
export interface SiteColumn {
  readonly legacyName: string;
  readonly targetName: string;
}

// opt2/table-ownership.json programs_sites.site ownedColumns, in catalog order
// (core/setup/db/mssql.sql:370-433, then core/mura/dbUpdates).
const LEGACY_SITE_COLUMNS = [
  'SiteID', 'Site', 'MaxNestLevel', 'PageLimit', 'Locking', 'Domain', 'exportLocation', 'FileDir', 'Contact',
  'MailserverIP', 'MailServerUsername', 'MailServerPassword', 'EmailBroadcaster', 'Extranet', 'ExtranetPublicReg',
  'ExtranetPublicRegNotify', 'ExtranetSSL', 'Cache', 'ViewDepth', 'NextN', 'DataCollection', 'columnCount',
  'columnNames', 'primaryColumn', 'publicSubmission', 'archiveDate', 'contactName', 'contactAddress', 'contactCity',
  'contactState', 'contactZip', 'contactEmail', 'contactPhone', 'privateUserPoolID', 'publicUserPoolID', 'orderNo',
  'emailBroadcasterLimit', 'feedManager', 'displayPoolID', 'galleryMainScaleBy', 'galleryMainScale',
  'gallerySmallScaleBy', 'gallerySmallScale', 'galleryMediumScaleBy', 'galleryMediumScale', 'sendLoginScript',
  'mailingListConfirmScript', 'publicSubmissionApprovalScript', 'reminderScript', 'loginURL', 'editProfileURL',
  'CommentApprovalDefault', 'deploy', 'lastDeployment', 'accountActivationScript', 'googleAPIKey',
  'useDefaultSMTPServer', 'theme', 'mailserverSMTPPort', 'mailserverPOPPort', 'mailserverTLS', 'mailserverSSL',
  'siteLocale', 'domainAlias', 'cacheCapacity', 'cacheFreeMemoryThreshold', 'tagline', 'hasChangesets', 'baseID',
  'enforcePrimaryDomain', 'enforceChangesets', 'smallImageHeight', 'smallImageWidth', 'mediumImageHeight',
  'mediumImageWidth', 'largeImageHeight', 'largeImageWidth', 'contentApprovalScript', 'contentRejectionScript',
  'hasComments', 'hasLockableNodes', 'enableLockdown', 'customTagGroups', 'filePoolID', 'categoryPoolID',
  'contentPoolID', 'sendAuthCodeScript', 'reCAPTCHASiteKey', 'reCAPTCHASecret', 'reCAPTCHALanguage', 'JSONApi',
  'useSSL', 'isremote', 'resourceSSL', 'resourceDomain', 'remoteport', 'remotecontext', 'contentPendingScript',
  'contentCanceledScript', 'showDashboard', 'placeholderImgID', 'placeholderImgExt', 'scaffolding',
] as const;

/** Live `tsettings` columns in catalog order; `targetName` is the lower-cased legacy name. */
export const SITE_COLUMNS: readonly SiteColumn[] = Object.freeze(
  LEGACY_SITE_COLUMNS.map((legacyName) => Object.freeze({ legacyName, targetName: legacyName.toLowerCase() })),
);

const COLUMN_BY_LOWER_NAME: ReadonlyMap<string, SiteColumn> = new Map(SITE_COLUMNS.map((c) => [c.targetName, c]));

/** Target column of a legacy `tsettings` column, case-insensitively; undefined for any other name. */
export function targetNameFor(legacyName: string): string | undefined {
  return COLUMN_BY_LOWER_NAME.get(legacyName.toLowerCase())?.targetName;
}

/** Legacy catalog name of a `programs_sites.site` column, case-insensitively; undefined for any other name. */
export function legacyNameFor(targetName: string): string | undefined {
  return COLUMN_BY_LOWER_NAME.get(targetName.toLowerCase())?.legacyName;
}

/** Columns `settingsDAO.read` selects into the bean, in select order (settingsDAO.cfc:78-87,108). */
export const READ_FIELDS: readonly string[] = Object.freeze([
  'siteid', 'pagelimit', 'domain', 'domainAlias', 'enforcePrimaryDomain', 'contact', 'locking', 'site', 'mailserverip',
  'mailserverusername', 'mailserverpassword', 'emailbroadcaster', 'emailbroadcasterlimit', 'extranet',
  'extranetPublicReg', 'extranetssl', 'cache', 'cacheCapacity', 'cacheFreeMemoryThreshold', 'viewdepth', 'nextn',
  'dataCollection', 'ExportLocation', 'columnCount', 'primaryColumn', 'publicSubmission', 'columnNames', 'contactName',
  'contactAddress', 'contactCity', 'contactState', 'contactZip', 'contactEmail', 'contactPhone', 'publicUserPoolID',
  'PrivateUserPoolID', 'displayPoolID', 'filePoolID', 'categoryPoolID', 'contentPoolID', 'orderno', 'feedManager',
  'largeImageHeight', 'largeImageWidth', 'smallImageHeight', 'smallImageWidth', 'mediumImageHeight',
  'mediumImageWidth', 'sendLoginScript', 'sendAuthCodeScript', 'mailingListConfirmScript',
  'publicSubmissionApprovalScript', 'reminderScript', 'ExtranetPublicRegNotify', 'loginURL', 'editProfileURL',
  'CommentApprovalDefault', 'deploy', 'accountActivationScript', 'googleAPIKey', 'useDefaultSMTPServer', 'siteLocale',
  'mailServerSMTPPort', 'mailServerPOPPort', 'mailserverTLS', 'mailserverSSL', 'theme', 'tagline', 'hasChangesets',
  'baseID', 'enforceChangesets', 'contentPendingScript', 'contentApprovalScript', 'contentRejectionScript',
  'contentCanceledScript', 'enableLockdown', 'customTagGroups', 'hasComments', 'hasLockableNodes', 'reCAPTCHASiteKey',
  'reCAPTCHASecret', 'reCAPTCHALanguage', 'JSONApi', 'useSSL', 'isRemote', 'remotecontext', 'remoteport',
  'resourceSSL', 'resourceDomain', 'showDashboard', 'placeholderImgID', 'placeholderImgExt', 'scaffolding',
  'lastdeployment',
]);

/**
 * How `settingsDAO.update` binds a column: `raw` writes the value as is (unquoted, quoted or a non-null param);
 * `trimNull` is `<cfif v neq ''>trim(v)<cfelse>null`; `blankNull` is `<cfif len(trim(v))>trim(v)<cfelse>null`;
 * `emptyNull` is `null="#v eq ''#"` with the untrimmed value; the rest are the bean's effective getters.
 */
type UpdateRule =
  | 'raw'
  | 'trimNull'
  | 'blankNull'
  | 'emptyNull'
  | 'emailBroadcaster'
  | 'dataCollection'
  | 'useSSL'
  | 'loginURL'
  | 'editProfileURL';

// legacy: core/mura/settings/settingsDAO.cfc:321-416, in SET order.
const UPDATE_RULES: readonly (readonly [string, UpdateRule])[] = [
  ['site', 'raw'],
  ['pagelimit', 'raw'],
  ['domain', 'trimNull'],
  ['domainalias', 'trimNull'],
  ['enforceprimarydomain', 'raw'],
  ['contact', 'trimNull'],
  ['locking', 'raw'],
  ['mailserverip', 'trimNull'],
  ['mailserverusername', 'trimNull'],
  ['mailserverpassword', 'trimNull'],
  ['emailbroadcaster', 'emailBroadcaster'],
  ['emailbroadcasterlimit', 'raw'],
  ['extranet', 'raw'],
  ['extranetpublicreg', 'raw'],
  ['extranetssl', 'raw'],
  ['cache', 'raw'],
  ['cachecapacity', 'raw'],
  ['cachefreememorythreshold', 'raw'],
  ['viewdepth', 'raw'],
  ['nextn', 'raw'],
  ['datacollection', 'dataCollection'],
  ['exportlocation', 'trimNull'],
  ['columncount', 'raw'],
  ['primarycolumn', 'raw'],
  ['publicsubmission', 'raw'],
  ['columnnames', 'trimNull'],
  ['contactname', 'trimNull'],
  ['contactaddress', 'trimNull'],
  ['contactcity', 'trimNull'],
  ['contactstate', 'trimNull'],
  ['contactzip', 'trimNull'],
  ['contactemail', 'trimNull'],
  ['contactphone', 'trimNull'],
  ['publicuserpoolid', 'raw'],
  ['privateuserpoolid', 'raw'],
  ['displaypoolid', 'raw'],
  ['filepoolid', 'raw'],
  ['categorypoolid', 'raw'],
  ['contentpoolid', 'raw'],
  ['feedmanager', 'raw'],
  ['largeimageheight', 'raw'],
  ['largeimagewidth', 'raw'],
  ['smallimageheight', 'raw'],
  ['smallimagewidth', 'raw'],
  ['mediumimageheight', 'raw'],
  ['mediumimagewidth', 'raw'],
  ['sendloginscript', 'emptyNull'],
  ['sendauthcodescript', 'emptyNull'],
  ['mailinglistconfirmscript', 'emptyNull'],
  ['publicsubmissionapprovalscript', 'emptyNull'],
  ['reminderscript', 'emptyNull'],
  ['extranetpublicregnotify', 'emptyNull'],
  ['loginurl', 'loginURL'],
  ['editprofileurl', 'editProfileURL'],
  ['commentapprovaldefault', 'raw'],
  ['accountactivationscript', 'emptyNull'],
  ['googleapikey', 'emptyNull'],
  ['usedefaultsmtpserver', 'raw'],
  ['sitelocale', 'emptyNull'],
  ['mailserversmtpport', 'emptyNull'],
  ['mailserverpopport', 'emptyNull'],
  ['mailservertls', 'emptyNull'],
  ['mailserverssl', 'emptyNull'],
  ['theme', 'trimNull'],
  ['tagline', 'raw'],
  ['haschangesets', 'raw'],
  ['baseid', 'raw'],
  ['enforcechangesets', 'raw'],
  ['contentpendingscript', 'emptyNull'],
  ['contentapprovalscript', 'emptyNull'],
  ['contentrejectionscript', 'emptyNull'],
  ['contentcanceledscript', 'emptyNull'],
  ['enablelockdown', 'raw'],
  ['customtaggroups', 'trimNull'],
  ['hascomments', 'raw'],
  ['haslockablenodes', 'raw'],
  ['recaptchasitekey', 'blankNull'],
  ['recaptchasecret', 'blankNull'],
  ['recaptchalanguage', 'blankNull'],
  ['jsonapi', 'raw'],
  ['usessl', 'useSSL'],
  ['isremote', 'raw'],
  ['resourcessl', 'raw'],
  ['resourcedomain', 'blankNull'],
  ['remotecontext', 'blankNull'],
  ['remoteport', 'raw'],
  ['showdashboard', 'raw'],
  ['placeholderimgid', 'blankNull'],
  ['placeholderimgext', 'blankNull'],
  ['scaffolding', 'raw'],
];

/** Target columns `settingsDAO.update` sets, in SET order; siteid, orderno, deploy, lastdeployment, type are not. */
export const UPDATE_COLUMNS: readonly string[] = Object.freeze(UPDATE_RULES.map(([column]) => column));

/** CF simple value as the bean holds it; numbers and booleans are held in CF string form, e.g. "1", "600". */
export type SiteValue = string | Date;

/** Complex value a caller passed under a key with no setter; legacy stores it as given. */
export type SiteComplexValue = readonly unknown[] | { readonly [key: string]: unknown };

/** Any value a bean field can hold. */
export type SiteStoredValue = SiteValue | SiteComplexValue;

/** Site bean state: fields under lower-cased keys (CFML struct keys are case-insensitive), and the isNew flag. */
export interface SiteBean {
  readonly values: Readonly<Record<string, SiteStoredValue>>;
  readonly isNew: 0 | 1;
}

/** A `programs_sites.site` row keyed by target column names. */
export type SiteRow = Record<string, unknown>;

/** Request data in any key casing, as a CFML form or JSON API scope holds it. */
export type SiteData = Record<string, unknown>;

/** Global settings the site bean's effective getters consult (configBean). */
export interface LegacyGlobalConfig {
  readonly emailBroadcaster: boolean;
  readonly dataCollection: boolean;
  readonly indexFile: string;
}

/** configBean defaults: broadcaster off, data collection on, empty indexFile (configBean.cfc:93,209-210,1623-1629). */
export const LEGACY_GLOBAL_CONFIG_DEFAULTS: LegacyGlobalConfig = Object.freeze({
  emailBroadcaster: false,
  dataCollection: true,
  indexFile: '',
});

/**
 * Bean fields after `init()` (settingsBean.cfc:177-291 over beanExtendable.cfc:88-102 and bean.cfc:89-106), in CF
 * string form. Object holders, lookups and the random instanceID are omitted, and `baseID` comes from newSiteBean's
 * caller. The declared default of `display`, which init never assigns, is omitted too: legacy never copies property
 * defaults into the instance, so its getValue('display') is ''.
 */
export const SITE_DEFAULTS: Readonly<Record<string, SiteValue>> = Object.freeze({
  fromMuraCache: 'false',
  extendSetID: '',
  extendDataTable: 'tclassextenddata',
  extendAutoComplete: 'true',
  SiteID: '',
  Site: '',
  TagLine: '',
  pageLimit: '1000',
  Locking: 'None',
  Domain: '',
  DomainAlias: '',
  enforcePrimaryDomain: '0',
  Contact: '',
  MailServerIP: '',
  MailServerSMTPPort: '25',
  MailServerPOPPort: '110',
  MailServerTLS: 'false',
  MailServerSSL: 'false',
  MailServerUsername: '',
  MailServerUsernameEmail: '',
  MailServerPassword: '',
  useDefaultSMTPServer: '1',
  EmailBroadcaster: '0',
  EmailBroadcasterLimit: '0',
  Extranet: '0',
  ExtranetSSL: '0',
  cache: '0',
  cacheCapacity: '0',
  cacheFreeMemoryThreshold: '60',
  ViewDepth: '1',
  nextN: '20',
  DataCollection: '1',
  ColumnCount: '3',
  ColumnNames: 'Left Column^Main Content^Right Column',
  ExtranetPublicReg: '0',
  PrimaryColumn: '2',
  PublicSubmission: '0',
  ContactName: '',
  ContactAddress: '',
  ContactCity: '',
  ContactState: '',
  ContactZip: '',
  ContactEmail: '',
  ContactPhone: '',
  PublicUserPoolID: '',
  PrivateUserPoolID: '',
  DisplayPoolID: '',
  ContentPoolID: '',
  CategoryPoolID: '',
  FilePoolID: '',
  placeholderImgID: '',
  feedManager: '1',
  largeImageHeight: 'AUTO',
  largeImageWidth: '600',
  smallImageHeight: '80',
  smallImageWidth: '80',
  mediumImageHeight: '180',
  mediumImageWidth: '180',
  sendLoginScript: '',
  sendAuthCodeScript: '',
  mailingListConfirmScript: '',
  publicSubmissionApprovalScript: '',
  reminderScript: '',
  ExtranetPublicRegNotify: '',
  exportLocation: '',
  loginURL: '',
  editProfileURL: '',
  commentApprovalDefault: '1',
  deploy: '1',
  lastDeployment: '',
  accountActivationScript: '',
  googleAPIKey: '',
  siteLocale: '',
  javaLocale: '',
  jsDateKey: '',
  jsDateKeyObjInc: '',
  theme: '',
  hasChangesets: '1',
  type: 'Site',
  subtype: 'Default',
  baseID: '',
  orderno: '0',
  enforceChangesets: '0',
  contentPendingScript: '',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentCanceledScript: '',
  enableLockdown: '',
  customTagGroups: '',
  hasSharedFilePool: '',
  hasComments: '1',
  hasLockableNodes: '0',
  reCAPTCHASiteKey: '',
  reCAPTCHASecret: '',
  reCAPTCHALanguage: 'en',
  JSONApi: '0',
  useSSL: '0',
  isRemote: '0',
  RemoteContext: '',
  RemotePort: '80',
  resourceSSL: '0',
  resourceDomain: '',
  showDashboard: '0',
  scaffolding: '1',
});

type Draft = Record<string, SiteStoredValue>;

const DEFAULT_VALUES: Readonly<Draft> = Object.freeze(
  Object.fromEntries(Object.entries(SITE_DEFAULTS).map(([key, value]) => [key.toLowerCase(), value])),
);

/** Null-prototype copy, so keys such as `__proto__` or `constructor` are plain fields. */
function draftOf(...sources: Readonly<Draft>[]): Draft {
  return Object.assign(Object.create(null) as Draft, ...sources);
}

/** A bean as `getBean('site')` builds it, with `isNew = 1`; `initBaseId` stands in for init's createUUID(). */
export function newSiteBean(initBaseId = ''): SiteBean {
  return { values: draftOf(DEFAULT_VALUES, { baseid: initBaseId }), isNew: 1 };
}

/** A bean field by name, case-insensitively; '' when the bean holds no such field (the getValue fallback). */
export function getSiteValue(bean: SiteBean, name: string): SiteStoredValue {
  const key = name.toLowerCase();
  return Object.hasOwn(bean.values, key) ? (bean.values[key] as SiteStoredValue) : '';
}

/** A bean field as CF text; throws for a Date or complex value. */
export function getSiteText(bean: SiteBean, name: string): string {
  return text(getSiteValue(bean, name));
}

/** The value as a string, where legacy uses it as one; CF cannot coerce a complex value either. */
function text(value: SiteStoredValue): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`A ${value instanceof Date ? 'date' : 'complex'} site value cannot be used as a string.`);
}

/**
 * beanExtendable.setValue's input: simple values trimmed and held as CF strings, NULL as '', complex values as given.
 * Dates stay Date objects instead of CF's `{ts ...}` text: lastDeployment is the only date field, and its setter
 * keeps them.
 */
function normalise(value: unknown): SiteStoredValue {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return javaTrim(value);
  if (typeof value === 'number') return cfNumberString(value);
  if (value instanceof Date) return value;
  if (typeof value === 'object') return value as SiteComplexValue;
  return String(value);
}

const ISO_T_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/;

/** Local-time Date of `yyyy-mm-dd[ HH:MM:SS[.fff]]` text; undefined for other text or an impossible date. */
function canonicalDate(s: string): Date | undefined {
  const match = CANONICAL_DATE.exec(s);
  if (!match) return undefined;
  const [, year = '', month = '', day = '', hour = '0', minute = '0', second = '0', fraction = ''] = match;
  const date = new Date(0);
  date.setFullYear(Number(year), Number(month) - 1, Number(day));
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  date.setHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')));
  return date;
}

/**
 * bean.parseDateArg (bean.cfc:278-301): a valid Date is kept and ISO `T` text reads as a space. Platform cfIsDate
 * accepts Date objects only, so only canonical text parses; locale-formatted text legacy's lsParseDateTime reads
 * becomes ''.
 */
function parseDateArg(value: SiteStoredValue): SiteValue {
  if (value instanceof Date) return cfIsDate(value) ? new Date(value.getTime()) : '';
  let s = text(value);
  if (ISO_T_DATE.test(s)) s = s.replace('T', ' ');
  const date = canonicalDate(s);
  return date !== undefined && cfIsDate(date) ? date : '';
}

/** CFML listRest: the list without its first element, empty elements skipped. */
function listRest(list: string, delimiter: string): string {
  return list.split(delimiter).filter((item) => item !== '').slice(1).join(delimiter);
}

type Setter = (draft: Draft, value: SiteStoredValue) => void;

/** Setter storing the value only when CF isNumeric accepts it. */
const ifNumeric = (field: string): Setter => (draft, value) => {
  if (cfIsNumeric(value)) draft[field] = value;
};

/** Setter storing a numeric, non-zero value (`isNumeric(v) && v`). */
const ifNonZero = (field: string): Setter => (draft, value) => {
  if (cfIsNumeric(value) && cfToBoolean(value)) draft[field] = value;
};

/** Image size setter (settingsBean.cfc:484-524): a non-zero number or AUTO, stored as given. */
const ifImageSize = (field: string): Setter => (draft, value) => {
  if ((cfIsNumeric(value) && cfToBoolean(value)) || (typeof value === 'string' && cfEq(value, 'AUTO'))) {
    draft[field] = value;
  }
};

/** Setter storing the value only when CF isBoolean accepts it. */
const ifBoolean = (field: string): Setter => (draft, value) => {
  if (cfIsBoolean(value)) draft[field] = value;
};

/** CF boolean as the 1 or 0 the bit setters store. */
const bit = (value: SiteStoredValue): string => (cfToBoolean(value) ? '1' : '0');

/** Setter storing a non-empty value that differs from the current one, CF `!=` (beanExtendable.cfc:113-137). */
const ifChanged = (field: string): Setter => (draft, value) => {
  const s = text(value);
  if (s !== '' && !cfEq(text(draft[field] ?? ''), s)) draft[field] = s;
};

// legacy: core/mura/settings/settingsBean.cfc:443-454
function setMailServerUsernameEmail(draft: Draft, value: SiteStoredValue): void {
  const s = text(value);
  if (s.includes('@')) draft.mailserverusernameemail = s;
  else if (s.includes('+')) draft.mailserverusernameemail = s.replace('+', '@');
  else if (s !== '') draft.mailserverusernameemail = `${s}@${listRest(text(draft.mailserverip ?? ''), '.')}`;
  else draft.mailserverusernameemail = draft.contact ?? '';
}

function isPlainObject(value: SiteStoredValue): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Keys naming legacy setters that are not field setters (runtime objects, lookups, bulk loaders); set() drops them.
 * setModuleFilePath counts: its `ublic` typo (settingsBean.cfc:2115) parses as a return type, so it stays public.
 */
export const DROPPED_SETTER_KEYS: readonly string[] = Object.freeze([
  'configBean',
  'rbFactory',
  'allValues',
  'addedObjectValues',
  'validations',
  'contentTypeFilePath',
  'displayObjectFilePath',
  'htmlQueueFilePath',
  'moduleFilePath',
]);

const SETTERS: ReadonlyMap<string, Setter> = new Map<string, Setter>([
  ['siteid', ifChanged('siteid')],
  ['type', ifChanged('type')],
  ['subtype', ifChanged('subtype')],
  ['baseid', (draft, value) => {
    const s = text(value);
    if (s !== '') draft.baseid = s;
  }],
  ...[
    'scaffolding', 'enforceprimarydomain', 'enforcechangesets', 'cachecapacity', 'hascomments', 'usedefaultsmtpserver',
    'mailserversmtpport', 'mailserverpopport', 'haslockablenodes', 'jsonapi', 'isremote', 'resourcessl', 'remoteport',
  ].map((field): [string, Setter] => [field, ifNumeric(field)]),
  ['cachefreememorythreshold', ifNonZero('cachefreememorythreshold')],
  ...[
    'smallimagewidth', 'smallimageheight', 'mediumimagewidth', 'mediumimageheight', 'largeimagewidth',
    'largeimageheight',
  ].map((field): [string, Setter] => [field, ifImageSize(field)]),
  ['theme', (draft, value) => {
    const s = text(value);
    if (!cfEq(s, text(draft.theme ?? ''))) draft.theme = s;
  }],
  ['hasfeedmanager', (draft, value) => {
    draft.feedmanager = value;
  }],
  ['exportlocation', (draft, value) => {
    const s = text(value);
    if (!cfEq(s, 'export1')) draft.exportlocation = s;
  }],
  ['mailserverusernameemail', setMailServerUsernameEmail],
  ['mailserverusername', (draft, value) => {
    setMailServerUsernameEmail(draft, value);
    draft.mailserverusername = text(value);
  }],
  ['mailservertls', ifBoolean('mailservertls')],
  ['mailserverssl', ifBoolean('mailserverssl')],
  ['usessl', (draft, value) => {
    if (!cfIsBoolean(value)) return;
    draft.usessl = bit(value);
    draft.extranetssl = bit(value);
  }],
  ['showdashboard', (draft, value) => {
    if (cfIsBoolean(value)) draft.showdashboard = bit(value);
  }],
  ['lastdeployment', (draft, value) => {
    draft.lastdeployment = parseDateArg(value);
  }],
  ['errors', (draft, value) => {
    if (isPlainObject(value)) draft.errors = value;
  }],
  ['lastupdateby', (draft, value) => {
    draft.lastupdateby = javaTrim(text(value)).slice(0, 50);
  }],
  ...DROPPED_SETTER_KEYS.map((key): [string, Setter] => [key.toLowerCase(), () => undefined]),
]);

/** beanExtendable.setValue (beanExtendable.cfc:236-249): the normalised value goes to the key's setter or is stored. */
function setInto(draft: Draft, key: string, raw: unknown): void {
  const value = normalise(raw);
  const lower = key.toLowerCase();
  const setter = SETTERS.get(lower);
  if (setter) setter(draft, value);
  else draft[lower] = value;
}

const POOL_FIELDS = [
  'privateuserpoolid', 'publicuserpoolid', 'displaypoolid', 'filepoolid', 'categorypoolid', 'contentpoolid',
] as const;

/** The tail of set() (settingsBean.cfc:328-345): an empty pool id becomes the site id. */
function defaultPools(draft: Draft): void {
  for (const field of POOL_FIELDS) {
    if ((draft[field] ?? '') === '') draft[field] = draft.siteid ?? '';
  }
}

/**
 * settingsBean.set(data) (settingsBean.cfc:309-347) on a copy of `bean`: each key through setValue, then the pool
 * defaults. Keys apply in `data` insertion order, which settles the order-dependent pairs useSSL/extranetSSL,
 * mailServerUsername/MailServerIP/contact and hasFeedManager/feedManager.
 */
export function applySet(bean: SiteBean, data: SiteData): SiteBean {
  const draft = draftOf(bean.values);
  for (const [key, value] of Object.entries(data)) setInto(draft, key, value);
  defaultPools(draft);
  return { values: draft, isNew: bean.isNew };
}

/**
 * settingsDAO.read (settingsDAO.cfc:97-118) of a stored row: each READ_FIELDS column through setValue, NULL as '',
 * then the pool defaults, with `isNew = 0`.
 * @param initBaseId baseID kept when the row's is empty, standing in for init's createUUID().
 */
export function readBean(row: SiteRow, initBaseId = ''): SiteBean {
  const draft = draftOf(newSiteBean(initBaseId).values);
  for (const field of READ_FIELDS) setInto(draft, field, row[field.toLowerCase()]);
  defaultPools(draft);
  return { values: draft, isNew: 0 };
}

/** getUseSSL (settingsBean.cfc:396-402): '1' when useSSL or the deprecated extranetSSL is true, as CF booleans. */
export function effectiveUseSSL(bean: SiteBean): '1' | '0' {
  return cfToBoolean(getSiteValue(bean, 'useSSL')) || cfToBoolean(getSiteValue(bean, 'extranetSSL')) ? '1' : '0';
}

/**
 * getEmailBroadcaster (settingsBean.cfc:435-441): the stored flag is not the effective one; legacy resolves it from the
 * global config, '0' while the global broadcaster is off (the monitor's bounce gate in src/jobs/ reads the same).
 */
export function effectiveEmailBroadcaster(
  bean: SiteBean,
  config: LegacyGlobalConfig = LEGACY_GLOBAL_CONFIG_DEFAULTS,
): string {
  return config.emailBroadcaster ? getSiteText(bean, 'EmailBroadcaster') : '0';
}

/**
 * getDataCollection (settingsBean.cfc:427-433): the stored flag is not the effective one; legacy resolves it from the
 * global config, '0' while global data collection is off.
 */
export function effectiveDataCollection(
  bean: SiteBean,
  config: LegacyGlobalConfig = LEGACY_GLOBAL_CONFIG_DEFAULTS,
): string {
  return config.dataCollection ? getSiteText(bean, 'dataCollection') : '0';
}

/** getLoginURL(parseMuraTag=false) (settingsBean.cfc:547-557): the stored URL, else `<indexFile>?display=login`. */
export function effectiveLoginURL(bean: SiteBean, config: LegacyGlobalConfig = LEGACY_GLOBAL_CONFIG_DEFAULTS): string {
  const url = getSiteText(bean, 'loginURL');
  return url !== '' ? url : `${config.indexFile}?display=login`;
}

/**
 * getEditProfileURL(parseMuraTag=false) (settingsBean.cfc:559-569): the stored URL, else
 * `<indexFile>?display=editProfile`.
 */
export function effectiveEditProfileURL(
  bean: SiteBean,
  config: LegacyGlobalConfig = LEGACY_GLOBAL_CONFIG_DEFAULTS,
): string {
  const url = getSiteText(bean, 'editProfileURL');
  return url !== '' ? url : `${config.indexFile}?display=editProfile`;
}

function columnValue(bean: SiteBean, column: string, rule: UpdateRule, config: LegacyGlobalConfig): string | null {
  switch (rule) {
    case 'emailBroadcaster':
      return effectiveEmailBroadcaster(bean, config);
    case 'dataCollection':
      return effectiveDataCollection(bean, config);
    case 'useSSL':
      return effectiveUseSSL(bean);
    // The DAO's null test reads the parsed getter, which falls back to a non-empty URL, so these are never null.
    case 'loginURL':
      return effectiveLoginURL(bean, config);
    case 'editProfileURL':
      return effectiveEditProfileURL(bean, config);
    default:
      break;
  }
  const value = getSiteText(bean, column);
  switch (rule) {
    case 'trimNull':
      return value === '' ? null : javaTrim(value);
    case 'blankNull':
      return javaTrim(value) === '' ? null : javaTrim(value);
    case 'emptyNull':
      return value === '' ? null : value;
    default:
      return value;
  }
}

/** Values `settingsDAO.update` writes for `bean` (settingsDAO.cfc:321-416) by UPDATE_COLUMNS; null is SQL NULL. */
export function updateColumnValues(
  bean: SiteBean,
  config: LegacyGlobalConfig = LEGACY_GLOBAL_CONFIG_DEFAULTS,
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const [column, rule] of UPDATE_RULES) values[column] = columnValue(bean, column, rule, config);
  return values;
}

/** Column the site list sorts by. */
export type SiteSortColumn = 'domain' | 'site' | 'orderno';

/** Normalised site list order with its PostgreSQL clause. */
export interface SiteListOrder {
  readonly column: SiteSortColumn;
  readonly direction: 'ASC' | 'DESC';
  readonly nulls: 'FIRST' | 'LAST';
  /** For example `ORDER BY lower(domain) ASC NULLS FIRST`. */
  readonly sql: string;
}

const SORT_COLUMNS: readonly SiteSortColumn[] = ['domain', 'site', 'orderno'];

/**
 * settingsGateway.getList ordering (settingsGateway.cfc:86-115): `domain|site|orderno`, else orderno; `asc|desc`,
 * else asc; both case-insensitive. Text sorts through lower() as SQL Server's case-insensitive collation does, and
 * NULLs come first ascending and last descending, as SQL Server sorts them lowest.
 */
export function listOrderSql(sortBy = 'orderno', sortDirection = 'asc'): SiteListOrder {
  const column = SORT_COLUMNS.find((c) => c === sortBy.toLowerCase()) ?? 'orderno';
  const direction = sortDirection.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const nulls = direction === 'ASC' ? 'FIRST' : 'LAST';
  const expression = column === 'orderno' ? column : `lower(${column})`;
  return { column, direction, nulls, sql: `ORDER BY ${expression} ${direction} NULLS ${nulls}` };
}

// Emulates SQL_Latin1_General_CP1_CI_AS: case-insensitive, accent-sensitive.
const SITE_COLLATOR = new Intl.Collator('en-US', { sensitivity: 'accent' });

function compareSortValues(column: SiteSortColumn, a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return Number(bNull) - Number(aNull);
  if (column === 'orderno') return Number(a) - Number(b);
  return SITE_COLLATOR.compare(String(a), String(b));
}

/** Site rows in listOrderSql's order, sorted in memory; stable, so ties keep their input order. */
export function sortSites<T extends SiteRow>(rows: readonly T[], sortBy?: string, sortDirection?: string): T[] {
  const { column, direction } = listOrderSql(sortBy, sortDirection);
  const sign = direction === 'ASC' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * compareSortValues(column, a.row[column], b.row[column]) || a.index - b.index)
    .map(({ row }) => row);
}
