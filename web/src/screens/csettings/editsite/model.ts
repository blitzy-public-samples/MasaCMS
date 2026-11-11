// View model of the Site Settings editor (`admin/core/views/csettings/editsite.cfm`); each tab partial renders from it.
import { raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

type NumberOrString = number | string;

/**
 * `rc.siteBean` values as its getters return them, SQL NULL read as `''`. Keys are the settingsBean property names the
 * partials share; the composer maps them from the column-cased keys of `SiteDetail.site` (`SiteID`, `MailserverIP`, …).
 */
export interface EditSiteBean {
  readonly siteID: string;
  readonly site: string;
  readonly tagline: string;
  readonly domain: string;
  readonly domainAlias: string;
  readonly enforcePrimaryDomain: NumberOrString;
  /** `getUseSSL()`: 1 when `useSSL` or the deprecated `extranetSSL` is truthy, else 0. */
  readonly useSSL: 0 | 1;
  readonly siteLocale: string;
  readonly theme: string;
  readonly pageLimit: NumberOrString;
  readonly nextN: NumberOrString;
  readonly cache: NumberOrString;
  readonly cacheFreeMemoryThreshold: NumberOrString;
  readonly locking: string;
  readonly commentApprovalDefault: NumberOrString;
  readonly exportLocation: string;
  readonly customTagGroups: string;
  readonly enableLockdown: string;
  readonly hasLockableNodes: NumberOrString;
  readonly isRemote: NumberOrString;
  readonly remoteContext: string;
  readonly remotePort: NumberOrString;
  readonly resourceDomain: string;
  readonly resourceSSL: NumberOrString;
  readonly reCAPTCHASiteKey: string;
  readonly reCAPTCHASecret: string;
  readonly reCAPTCHALanguage: string;

  readonly contactName: string;
  readonly contactAddress: string;
  readonly contactCity: string;
  readonly contactState: string;
  readonly contactZip: string;
  readonly contactPhone: string;
  readonly contactEmail: string;

  // Pools: an empty stored id reads as the site's own id (`settingsBean.set()`); `contentPoolID` is a comma list.
  readonly publicUserPoolID: string;
  readonly privateUserPoolID: string;
  readonly displayPoolID: string;
  readonly filePoolID: string;
  readonly categoryPoolID: string;
  readonly contentPoolID: string;

  readonly extranet: NumberOrString;
  /** `getHasFeedManager()`: the stored `feedManager`. */
  readonly hasFeedManager: NumberOrString;
  /** `getDataCollection()`: 0 when the global flag is off. */
  readonly dataCollection: NumberOrString;
  readonly hasComments: NumberOrString;
  readonly JSONApi: NumberOrString;
  /** `getEmailBroadcaster()`: 0 when the global flag is off. */
  readonly emailBroadcaster: NumberOrString;
  readonly emailBroadcasterLimit: NumberOrString;
  readonly hasChangesets: NumberOrString;
  readonly enforceChangesets: NumberOrString;
  readonly showDashboard: NumberOrString;
  readonly scaffolding: NumberOrString;

  readonly contact: string;
  readonly mailServerIP: string;
  readonly mailServerSMTPPort: string;
  readonly mailServerPOPPort: string;
  /** `getMailServerUsername(forLogin=false)`: the stored value even without a password. */
  readonly mailServerUsername: string;
  readonly mailServerPassword: string;
  /** Stored string, normally `true` or `false`. */
  readonly mailServerTLS: string;
  /** Stored string, normally `true` or `false`. */
  readonly mailServerSSL: string;
  readonly useDefaultSMTPServer: NumberOrString;
  readonly contentPendingScript: string;
  readonly contentApprovalScript: string;
  readonly contentRejectionScript: string;
  readonly contentCanceledScript: string;
  readonly sendAuthCodeScript: string;
  readonly sendLoginScript: string;
  readonly mailingListConfirmScript: string;
  readonly accountActivationScript: string;
  readonly reminderScript: string;

  readonly smallImageHeight: string;
  readonly smallImageWidth: string;
  readonly mediumImageHeight: string;
  readonly mediumImageWidth: string;
  readonly largeImageHeight: string;
  readonly largeImageWidth: string;
  readonly placeholderImgID: string;

  readonly extranetPublicReg: NumberOrString;
  /** `getLoginURL(parseMuraTag=false)`: the stored value, else `<indexFile>?display=login`. */
  readonly loginURL: string;
  /** `getEditProfileURL(parseMuraTag=false)`: the stored value, else `<indexFile>?display=editProfile`. */
  readonly editProfileURL: string;
  readonly extranetPublicRegNotify: string;

  readonly columnCount: NumberOrString;
  readonly primaryColumn: NumberOrString;
  readonly columnNames: string;
}

/** One `settingsManager.getList()` row, in legacy order. */
export interface SiteOption {
  readonly siteid: string;
  readonly site: string;
}

/** Control types `extendAttribute.renderAttribute` switches on. */
export type ExtendAttributeType =
  | 'TextBox'
  | 'Text'
  | 'TextArea'
  | 'HTMLEditor'
  | 'SelectBox'
  | 'MultiSelectBox'
  | 'RadioGroup'
  | 'File'
  | 'Hidden';

/** One extended attribute of a site extend set, with the site's value. */
export interface ExtendAttributeView {
  readonly attributeID: NumberOrString;
  readonly name: string;
  /** `getLabel()`: the label, else the name. */
  readonly label: string;
  readonly hint: string;
  /** `setType()` already turned `text` into `TextBox`. */
  readonly type: ExtendAttributeType;
  readonly validation: string;
  readonly regex: string;
  readonly message: string;
  readonly required: string;
  /** After `contentRenderer.setDynamicContent`. */
  readonly defaultValue: string;
  /** `^` list after `contentRenderer.setDynamicContent`. */
  readonly optionList: string;
  /** `^` list after `contentRenderer.setDynamicContent`. */
  readonly optionLabelList: string;
  /** `siteBean.getValue(name,'useMuraDefault')`: the literal `useMuraDefault` when nothing is stored. */
  readonly value: string;
  /** `fileManager.readMeta(value).fileExt` for a File attribute with a value, else `''`. */
  readonly fileExt: string;
}

/** One active `Site`/`Default` extend set, inherited, container `Default`. */
export interface ExtendSetView {
  readonly extendSetID: string;
  readonly categoryID: string;
  readonly name: string;
  /** Raw attribute markup emitted verbatim in the set's `span`. */
  readonly style: string;
  readonly attributes: readonly ExtendAttributeView[];
}

/** One `onSiteEdit` plugin tab; the composer emits its pane id as `tab` + `cssId`. */
export interface PluginScriptTab {
  readonly name: string;
  /** `$.createCSSID(name)`. */
  readonly cssId: string;
  readonly html: SafeHtml;
}

/** Metadata of the stored placeholder image. */
export interface PlaceholderFileMeta {
  readonly fileId: string;
  readonly fileExt: string;
  /** `$.getURLForImage(fileid, size='medium', siteid, useProtocol=false)`. */
  readonly imageUrl: string;
}

/** Global configuration flags the view branches on. */
export interface EditSiteConfig {
  readonly javaEnabled: boolean;
  readonly lockableNodes: boolean;
  readonly dataCollection: boolean;
  readonly emailBroadcaster: boolean;
  readonly postBundles: boolean;
  /** `globalConfig().getValue('razuna', false)`. */
  readonly razuna: boolean;
  /** The site content renderer's `useLayoutManager()`. */
  readonly useLayoutManager: boolean;
}

/** One `utility.getReCAPTCHALanguages()` entry: struct key as label, language code as value. */
export interface ReCaptchaLanguage {
  readonly label: string;
  readonly value: string;
}

/** Everything the Edit Site composer and its tab partials render from. */
export interface EditSiteModel {
  readonly bean: EditSiteBean;
  readonly config: EditSiteConfig;
  readonly rb: RbLookup;
  readonly isSupportedLocale: (locale: string) => boolean;
  /** `listFind(session.mura.memberships,'S2')`. */
  readonly isS2: boolean;
  /** `rc.siteid` (`$.event('siteid')`) after the FW/1 merge; `''` on Add Site. */
  readonly requestSiteId: string;
  /** `rc.action`, default `''`. */
  readonly rcAction: string;
  readonly compactDisplay: string;
  /** `url.addsite` is defined. */
  readonly addSite: boolean;
  /** `settingsManager.getSite(session.siteid).getEmailBroadcaster()`, the session site rather than the edited one. */
  readonly sessionSiteEmailBroadcaster: boolean;
  /** `directoryExists(exportLocation)`. */
  readonly exportLocationExists: boolean;
  readonly sites: readonly SiteOption[];
  /** `rsThemes` names in query order. */
  readonly themes: readonly string[];
  readonly hasNonThemeTemplates: boolean;
  /** `server.coldfusion.supportedLocales`, unsorted. */
  readonly supportedLocales: readonly string[];
  /** Unsorted. */
  readonly recaptchaLanguages: readonly ReCaptchaLanguage[];
  readonly extendSets: readonly ExtendSetView[];
  readonly pluginScriptTabs: readonly PluginScriptTab[];
  /** `null` when `getFileMetaData('placeholderImgID').getIsNew()`. */
  readonly placeholderFile: PlaceholderFileMeta | null;
  /** `session.dateKeyFormat`. */
  readonly dateKeyFormat: string;
  /** `session.localeHasDayParts`. */
  readonly localeHasDayParts: boolean;
  /** Clock for the datetime selector's 50-year rule. */
  readonly now: Date;
  /** Legacy `createUUID()` for `cacheID` query values. */
  readonly newCacheId: () => string;
}

const CHECKED = raw(' checked');
const SELECTED = raw(' selected');
const NOTHING = raw('');

/** ` checked` when `cond`, else nothing. */
export function checked(cond: boolean): SafeHtml {
  return cond ? CHECKED : NOTHING;
}

/** ` selected` when `cond`, else nothing. */
export function selected(cond: boolean): SafeHtml {
  return cond ? SELECTED : NOTHING;
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_WORD = /^(?:true|false|yes|no)$/i;

/** Java `String.trim()`, which ACF applies before numeric parsing: strips every char <= U+0020. */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

/** The operand's numeric value when CFML `eq` compares it as a number. */
function numericOperand(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = javaTrim(v);
  // ACF compares '1.' eq '1' as text (false), so a trailing dot keeps the operand textual.
  if (!DECIMAL.test(t) || t.endsWith('.')) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 1 or 0 for a boolean or a Java-trimmed `true|false|yes|no` word, else undefined. */
function booleanOperand(v: unknown): number | undefined {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return undefined;
  const word = javaTrim(v).toLowerCase();
  if (!BOOLEAN_WORD.test(word)) return undefined;
  return word === 'true' || word === 'yes' ? 1 : 0;
}

/**
 * CFML loose `eq`: when each side is numeric or a boolean word, their values as numbers with booleans as 1/0
 * (ACF: `'yes' eq 'true'`, `' no' eq '0'`); otherwise case-insensitive text.
 */
export function cfEq(a: unknown, b: unknown): boolean {
  const x = numericOperand(a) ?? booleanOperand(a);
  const y = numericOperand(b) ?? booleanOperand(b);
  if (x !== undefined && y !== undefined) return x === y;
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** CFML `listFind` as a predicate: case-sensitive, every character of `delim` delimits, empty elements skipped. */
export function cfListFind(list: string, value: string, delim = ','): boolean {
  const delimiters = new Set(delim);
  let start = 0;
  for (let i = 0; i <= list.length; i += 1) {
    if (i === list.length || delimiters.has(list.charAt(i))) {
      if (i > start && list.slice(start, i) === value) return true;
      start = i + 1;
    }
  }
  return false;
}
