// `cUsers.editUser`: the controller's `editUser()` and the user form of `admin/core/views/cusers/edituser.cfm` (server-only).
import {
  LegacyServiceUnavailableError,
  cfEq,
  cfListToArray,
  cfLsTimeFormat,
  cfToBoolean,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/people';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, raw } from '@/lib/html';
import { siteDataOf, urlEncodedFormat, type SiteData } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { renderUserCategoriesNest, type InterestCategoryLoader, type InterestCategoryRow } from './dsp_categories_nest';
import { displayErrors, editGroupHtmlHead, jsStringFormat, themeAssetPath } from './editgroup';
import { cusersGate, normaliseCusersRc, userPoolIdFor, type CusersRc, type CusersRcValue } from './gate';

// The markup is written as ACF 2023 emits the view: the template text between two CFML constructs is copied byte for
// byte, CFML comments are dropped with the text around them joined, and text that is only whitespace prints one space
// after output that does not already end in whitespace, else nothing (`CfOutput.t`).

type PeopleSchemas = components['schemas'];

/** A group of the Group Memberships tab, as people returns it from identity. */
export type EditUserGroup = PeopleSchemas['GroupOption'];

/** A site of the S2 site selector. */
export type EditUserSite = PeopleSchemas['SiteOption'];

/** A legacy error struct, keyed and ordered as people reports it. */
export type UserErrors = Readonly<Record<string, string>>;

/** The user bean the form renders: a stored or new person, or a failed save's values, as CFML prints them. */
export interface EditUserBean {
  readonly userId: string;
  readonly fname: string;
  readonly lname: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly email: string;
  readonly mobilePhone: string;
  readonly username: string;
  readonly tags: string;
  readonly remoteID: string;
  readonly siteId: string;
  readonly subType: string;
  readonly type: string;
  readonly s2: string;
  readonly isPublic: string;
  readonly inActive: string;
  readonly subscribe: string;
  readonly photoFileId: string;
  /** `tfiles.fileExt` of the photo; `''` when the photo id has no file row. */
  readonly photoFileExt: string;
  /** `getgroupid()`. */
  readonly groupIds: readonly string[];
  /** `getCategoryID()`. */
  readonly categoryIds: readonly string[];
  readonly errors: UserErrors;
}

/** One `getAddresses()` row, every column as the query prints it (SQL NULL as `''`). */
export interface EditUserAddress {
  readonly addressID: string;
  readonly addressName: string;
  readonly address1: string;
  readonly address2: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly phone: string;
  readonly fax: string;
  readonly addressURL: string;
  readonly addressEmail: string;
  readonly isPrimary: string;
}

/** A `refresh_token` OAuth token of the user, with its client's name. */
export interface WebServiceToken {
  readonly token: string;
  readonly clientName: string;
}

/** `getFeed('oauthtoken')` of the user's `refresh_token` grants, in iterator order. */
export type WebServiceTokenLoader = (ctx: ScreenContext, userId: string) => Promise<readonly WebServiceToken[]>;

/** Reads the view takes from services no contract serves yet. */
export interface EditUserSources {
  readonly interestCategories: InterestCategoryLoader;
  readonly webServiceTokens: WebServiceTokenLoader;
}

// Identity's contract lists OAuth clients but no user's tokens, and strategies-content's contract has no interest
// category read, so the registered screen renders as legacy does for a user without web-service connections in a pool
// without interest categories until such reads exist.
/** The sources of the registered screen: no web-service tokens and no interest categories. */
export const UNSERVED_EDIT_USER_SOURCES: EditUserSources = Object.freeze({
  interestCategories: () => Promise.resolve([]),
  webServiceTokens: () => Promise.resolve([]),
});

/** Everything the view reads after `editUser()` and the view's own set-up. */
export interface EditUserData {
  readonly rc: CusersRc;
  readonly bean: EditUserBean;
  /** `rc.userBean.exists()`. */
  readonly exists: boolean;
  /** `rc.tempIsPublic`, the user type the radios and the list return URL show. */
  readonly tempIsPublic: string;
  /** A stored S2 user edited by a caller who is not S2: account fields are read-only. */
  readonly lockedSuper: boolean;
  /** `strikes.blockedUntil()` while the user's login is blocked, else null. */
  readonly blockedUntil: Date | null;
  /** `rc.userBean.getPasswordExpired()`. */
  readonly passwordExpired: boolean;
  readonly addresses: readonly EditUserAddress[];
  readonly privateGroups: readonly EditUserGroup[];
  readonly publicGroups: readonly EditUserGroup[];
  /** `rsSubTypes`: the active user subtypes of the edited pool. */
  readonly subTypes: readonly string[];
  readonly sites: readonly EditUserSite[];
  readonly userPoolId: string;
  /** `settingsManager.getSite(rc.siteid).getThemeAssetPath()`. */
  readonly themeAssetPath: string;
  /** `getSite(bean.siteid)` of the photo URL; the request's site when there is no photo. */
  readonly photoSite: SiteData;
  readonly interestCategories: readonly InterestCategoryRow[];
  readonly webServiceTokens: readonly WebServiceToken[];
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<EditUserData>['render']>>;

type Struct = Readonly<Record<string, unknown>>;

/** rc key under which a failed `cUsers.update{type=2}` preserves people's `UpdateResult` as JSON for this form. */
const USER_BEAN_RC_KEY = 'userBean';

/** `cf_fileselector` attributes of the photo field: `name`, `property`, `deleteKey`, `examplefileext`. */
const FILE_FIELD = 'newfile';
const PHOTO_PROPERTY = 'photofileid';
const PHOTO_DELETE_KEY = 'removePhotoFile';
const PHOTO_EXAMPLE_EXT = 'JPG';
/** `filetype` of the selector: `File`, as the property is not `fileid`. */
const PHOTO_FILE_TYPE = 'File';
/** `size` the selector passes `cf_filetools`. */
const PHOTO_SIZE = 'medium';

const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif']);
const CROPPABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);

const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;
const UNICODE_SEPARATOR = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;

/** Java `Character.isWhitespace`. */
function isJavaWhitespace(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x20)) return true;
  if (cp === 0xa0 || cp === 0x2007 || cp === 0x202f) return false;
  return UNICODE_SEPARATOR.test(ch);
}

/** One output buffer under ACF whitespace management. */
class CfOutput {
  #out = '';

  /** Template text between two CFML constructs; whitespace-only text prints one space after non-whitespace, else nothing. */
  t(text: string): this {
    if (!TEMPLATE_WHITESPACE.test(text)) this.#out += text;
    else if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
    return this;
  }

  /** The output of a `#…#` expression. */
  e(value: string): this {
    this.#out += value;
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple member as CFML text; absent and SQL NULL read as `fallback`, complex values throw. */
function text(struct: Struct, key: string, fallback = ''): string {
  const value = member(struct, key);
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** A request context value as CFML text; a struct value throws, as CFML cannot convert it. */
function rcText(value: CusersRcValue | undefined, name: string): string {
  if (value === undefined) return '';
  if (typeof value === 'object') throw new TypeError(`rc.${name} is not a simple value`);
  return String(value);
}

/** CFML `listFind(list, value) > 0`: an exact, case-sensitive match of an element; empty elements never match. */
const listFind = (items: readonly string[], value: string): boolean => value !== '' && items.includes(value);

/** A comma list member as its elements, or `fallback` when the struct lacks it. */
function listMember(struct: Struct, key: string, fallback: readonly string[]): readonly string[] {
  return member(struct, key) === undefined ? fallback : cfListToArray(text(struct, key));
}

/** The errors of a struct's `errors` member; an absent struct is the empty one a saved bean holds. */
function errorsOf(struct: Struct): UserErrors {
  const errors = member(struct, 'errors');
  if (errors === undefined) return {};
  if (!isStruct(errors)) throw new TypeError('errors is not a struct');
  return Object.fromEntries(Object.keys(errors).map((key) => [key, text(errors, key)]));
}

/** A person record as the bean holds it; a NULL flag keeps `userBean.init`'s value. */
function beanOf(person: Struct, groupIds: readonly string[], categoryIds: readonly string[], errors: UserErrors): EditUserBean {
  return {
    userId: text(person, 'UserID'),
    fname: text(person, 'Fname'),
    lname: text(person, 'Lname'),
    company: text(person, 'Company'),
    jobTitle: text(person, 'JobTitle'),
    email: text(person, 'Email'),
    mobilePhone: text(person, 'mobilePhone'),
    username: text(person, 'UserName'),
    tags: text(person, 'tags'),
    remoteID: text(person, 'remoteID'),
    siteId: text(person, 'SiteID'),
    subType: text(person, 'subType', 'Default'),
    type: text(person, 'Type', '2'),
    s2: text(person, 'S2', '0'),
    isPublic: text(person, 'isPublic', '1'),
    inActive: text(person, 'InActive', '0'),
    subscribe: text(person, 'Subscribe', '1'),
    photoFileId: text(person, 'photoFileID'),
    photoFileExt: text(person, 'photoFileExt'),
    groupIds,
    categoryIds,
    errors,
  };
}

/** A `tuseraddresses` row as the query prints it. */
function addressOf(row: Struct): EditUserAddress {
  return {
    addressID: text(row, 'addressID'),
    addressName: text(row, 'addressName'),
    address1: text(row, 'address1'),
    address2: text(row, 'address2'),
    city: text(row, 'city'),
    state: text(row, 'state'),
    zip: text(row, 'zip'),
    phone: text(row, 'phone'),
    fax: text(row, 'fax'),
    addressURL: text(row, 'addressURL'),
    addressEmail: text(row, 'addressEmail'),
    isPrimary: text(row, 'isPrimary'),
  };
}

/**
 * `rc.userBean` and its `getPasswordExpired()` when the restored flash context carries a failed save, else the person
 * people read for `userid` with its verdict.
 * @throws TypeError When the preserved value is not a person write result.
 */
function editBean(rc: CusersRc, edit: PeopleSchemas['UserEditData']): { bean: EditUserBean; passwordExpired: boolean } {
  const preserved = rc[USER_BEAN_RC_KEY];
  if (preserved === undefined) {
    return { bean: beanOf(edit.user, edit.groupIds, edit.categoryIds, edit.errors), passwordExpired: edit.passwordExpired };
  }
  const result: unknown = JSON.parse(rcText(preserved, USER_BEAN_RC_KEY));
  const person = isStruct(result) ? member(result, 'userBean') : undefined;
  if (!isStruct(result) || !isStruct(person)) throw new TypeError(`rc.${USER_BEAN_RC_KEY} is not a person write result`);
  const expired = member(result, 'passwordExpired');
  const bean = beanOf(
    person,
    listMember(person, 'groupid', edit.groupIds),
    listMember(person, 'categoryid', edit.categoryIds),
    errorsOf(result),
  );
  return { bean, passwordExpired: typeof expired === 'boolean' ? expired : edit.passwordExpired };
}

/** Whether the photo id has a file row, so `getFileMetaData('photofileid').getIsNew()` is false. */
const hasPhotoFile = (bean: EditUserBean): boolean => bean.photoFileId !== '' && bean.photoFileExt !== '';

/** CSRF context of the address delete links. */
const addressCsrfContext = (rc: CusersRc): string => `updateaddress${rc.userid}`;

/** Whether the address table prints a delete link, which carries the address CSRF pair. */
const hasDeleteLink = (rc: CusersRc, addresses: readonly EditUserAddress[]): boolean =>
  rc.userid !== '' && addresses.some((address) => !cfEq(address.isPrimary, '1'));

/**
 * `getSite(bean.siteid)` of a photo: the request's site, else the user pool site programs-sites serves under that id.
 * @throws GatewayDenialError When programs-sites refuses the read (401 or 403).
 * @throws LegacyServiceUnavailableError When programs-sites serves no user pool site of that id.
 */
async function photoSiteOf(ctx: ScreenContext, site: SiteData, bean: EditUserBean): Promise<SiteData> {
  if (!hasPhotoFile(bean) || cfEq(bean.siteId, site.siteid)) return site;
  const response = await ctx.gateway.programsSites.getUserPoolSites(site.siteid);
  const { sites } = okBody(response, 'programs-sites', 'getUserPoolSites');
  const pool = sites.find((record) => cfEq(record.SiteID, bean.siteId));
  if (pool === undefined) {
    throw new LegacyServiceUnavailableError('programs-sites serves no site of the photo', 'admin', 'photo-site-unserved');
  }
  return siteDataOf(pool, legacySettings().defaultLocale);
}

/**
 * The view's data: `editUser()`'s bean, user type, groups and sites from people, and the view set-up's user pool,
 * subtypes and strike block; issues the form's CSRF pairs. Gateway unavailability propagates.
 * @throws GatewayDenialError When people or programs-sites refuses a read (401 or 403).
 * @throws LegacyServiceUnavailableError When an owner is unavailable, a photo file name is unserved, or a pooled user's photo
 * site is not served by programs-sites.
 * @throws TypeError When the request carries no site data, or a preserved bean is malformed.
 */
export async function loadEditUser(
  ctx: ScreenContext,
  sources: EditUserSources = UNSERVED_EDIT_USER_SOURCES,
): Promise<EditUserData> {
  const rc = normaliseCusersRc(ctx.req);
  const { site } = ctx.req;
  if (site === undefined) throw new TypeError('cUsers.editUser: the request carries no site data');
  const setIsPublic = rc.setispublic;
  const query = {
    siteid: rc.siteid,
    userid: rc.userid,
    routeid: rc.routeid,
    ...(setIsPublic === undefined ? {} : { setispublic: rcText(setIsPublic, 'setispublic') }),
    ...(rc['removeBlock'] === undefined ? {} : { removeBlock: rcText(rc['removeBlock'], 'removeBlock') }),
  };
  const edit = okBody(await ctx.gateway.people.call('get', '/v1/users/edit', { query }), 'people', 'getUserEdit');
  const { bean, passwordExpired } = editBean(rc, edit);
  // `cf_filetools` prints the file name of a non-image file, which people's person record does not carry.
  if (hasPhotoFile(bean) && !IMAGE_FILE_EXTENSIONS.has(bean.photoFileExt.toLowerCase())) {
    throw new LegacyServiceUnavailableError('No contract serves a photo file name', 'admin', 'photo-filename-unserved');
  }
  const photoSite = await photoSiteOf(ctx, site, bean);
  const exists = !edit.isNew;
  const addresses = edit.addresses.map(addressOf);
  const contexts = hasDeleteLink(rc, addresses) ? [bean.userId, addressCsrfContext(rc)] : [bean.userId];
  const [interestCategories, webServiceTokens] = await Promise.all([
    sources.interestCategories(rc.siteid),
    exists ? sources.webServiceTokens(ctx, bean.userId) : Promise.resolve([]),
    ctx.csrf.prefetch(contexts),
  ]);
  return {
    rc,
    bean,
    exists,
    tempIsPublic: setIsPublic !== undefined && rc.isAdmin ? rcText(setIsPublic, 'setispublic') : bean.isPublic,
    lockedSuper: edit.lockedSuper,
    blockedUntil: bean.username === '' ? null : parseLegacyDate(edit.blockedUntil),
    passwordExpired,
    addresses,
    privateGroups: edit.privateGroups,
    publicGroups: edit.publicGroups,
    subTypes: edit.subTypes.map(({ subType }) => subType),
    sites: edit.sites,
    userPoolId: userPoolIdFor({ site }, rc),
    themeAssetPath: themeAssetPath(site, ctx.req.https),
    photoSite,
    interestCategories,
    webServiceTokens,
  };
}

/** What the markup reads besides the data: labels, URLs, CSRF fields and the request's session facts. */
interface View {
  readonly data: EditUserData;
  readonly bean: EditUserBean;
  readonly rc: CusersRc;
  /** `rbKey(key)`, unencoded as the view writes it. */
  readonly rb: (key: string) => string;
  /** View `buildURL(action, querystring)`. */
  readonly url: (action: string, queryString: string) => string;
  readonly csrf: ScreenContext['csrf'];
  /** `application.configBean.getContext()`. */
  readonly context: string;
  /** `session.locale`, the locale of `LSTimeFormat`. */
  readonly locale: string;
  /** `$.currentUser().isSuperUser()`. */
  readonly isS2: boolean;
  readonly sessionSiteId: string;
  /** `YesNoFormat($.siteConfig('EmailBroadcaster'))`. */
  readonly emailBroadcaster: boolean;
  readonly compactDisplay: string;
  /** `getSite(bean.siteid)`, whose file asset path and file pool the photo URL takes. */
  readonly photoSite: SiteData;
  /** `<cf_dsp_categories_nest>` output of the Interests tab. */
  readonly interests: string;
}

/** `rsNonDefault`: the subtypes the query of queries keeps by its case-sensitive `subtype <> 'Default'`. */
const nonDefaultSubTypes = (data: EditUserData): readonly string[] =>
  data.subTypes.filter((subType) => subType !== 'Default');

/** Lines 117-126: the `mura-header` with its back button. */
function renderHeader(o: CfOutput, v: View): void {
  o.t('\n\n<div class="mura-header">\n\t<h1>');
  o.e(v.rb('user.usermaintenanceform'));
  o.t('</h1>\n\t<div class="nav-module-specific btn-group">\n\t\t<a class="btn" href="#" title="');
  o.e(encodeHtml(v.rb('sitemanager.back')));
  o.t('" onclick="actionModal();window.history.back(); return false;">\n\t\t\t\t<i class="mi-arrow-circle-left"></i> ');
  o.e(encodeHtml(v.rb('sitemanager.back')));
  o.t('\n\t\t</a>\n\t</div>\n</div> <!-- /.mura-header -->\n\n');
}

/** Lines 128-143: the strike block alert, then the super-user lock notice or the failed save's errors. */
function renderAlerts(o: CfOutput, v: View): void {
  const { data, bean } = v;
  if (bean.username !== '') {
    o.t('\n\t');
    o.t('\n\t');
    o.t('\n\t');
    if (data.blockedUntil !== null) {
      o.t('\n\t\t<div class="alert alert-error"><span>');
      o.e(v.rb('user.blocked'));
      o.t(': ');
      o.e(cfLsTimeFormat(data.blockedUntil, 'short', v.locale));
      o.t(' <a href="?muraAction=cUsers.edituser&amp;userid=');
      o.e(encodeUrl(v.rc.userid));
      o.t('&amp;type=2&amp;siteid=');
      o.e(encodeUrl(v.rc.siteid));
      o.t('&amp;removeBlock">[');
      o.e(v.rb('user.remove'));
      o.t(']</a></span>\n\t\t</div>\n\t');
    }
    o.t('\n');
  }
  o.t('\n\n');
  if (data.lockedSuper) {
    o.t('\n\t<div class="alert alert-info"><span>');
    o.e(v.rb('user.locksupers'));
    o.t('</span></div>\n');
  } else if (Object.keys(bean.errors).length > 0) {
    o.t('\n\t<div class="alert alert-error"><span>');
    o.e(displayErrors(bean.errors).value);
    o.t('</span></div>\n');
  }
}

/** Lines 166-180: the subtype select, shown when the pool has a non-`Default` subtype; names are written unencoded. */
function renderSubTypeSelect(o: CfOutput, v: View): void {
  const { data, bean } = v;
  const options = nonDefaultSubTypes(data);
  if (options.length === 0) return;
  o.t('\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.type'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t\t<select name="subtype"  onchange="userManager.resetExtendedAttributes(\'');
  o.e(bean.userId);
  o.t('\',\'2\',this.value,\'');
  o.e(data.userPoolId);
  o.t('\',\'');
  o.e(v.context);
  o.t('\',\'');
  o.e(data.themeAssetPath);
  o.t('\');">\n\t\t\t\t\t\t\t\t\t\t\t<option value="Default" ');
  if (cfEq(bean.subType, 'Default')) o.t('selected');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.default'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t\t</option>\n\t\t\t\t\t\t\t\t\t\t\t');
  for (const subType of options) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<option value="');
    o.e(subType);
    o.t('" ');
    if (cfEq(bean.subType, subType)) o.t('selected');
    o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(subType);
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t</option>\n\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t\t</select>\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t');
}

/** Lines 220-260: the expire-password control, strength help and password fields, absent for a locked super user. */
function renderPasswordFields(o: CfOutput, v: View): void {
  const { data, bean } = v;
  if (data.lockedSuper) return;
  const { expirePasswords, strongPasswords } = legacySettings();
  o.t('\n\n\t\t\t\t\t\t\t\t');
  if (expirePasswords !== 0) {
    o.t('\n\t\t\t\t\t\t\t\t\t<div id="passwordexpired" class="help-block-inline" ');
    if (!data.passwordExpired) o.t(' style="display:none;"');
    o.t('>');
    o.e(v.rb('user.passwordexpired'));
    o.t('</div>\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<div id="expirepassword" class="mura-control-group" ');
    if (data.passwordExpired) o.t(' style="display:none;"');
    o.t('>\n\t\t\t\t\t\t\t\t\t\t<button type="button" id="expirepasswordbtn" class="btn">');
    o.e(v.rb('user.expirepassword'));
    o.t('</button>\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t<script>\n\t\t\t\t\t\t\t\t\t\t$(function(){\n\t\t\t\t\t\t\t\t\t\t\t$(\'#expirepasswordbtn\').on(\'click\',function(){\n\t\t\t\t\t\t\t\t\t\t\t\tconfirmDialog(\n\t\t\t\t\t\t\t\t\t\t\t\t\t"');
    o.e(encodeJs(v.rb('user.expirepasswordconfirm')));
    o.t('",\n\t\t\t\t\t\t\t\t\t\t\t\t\tfunction(){\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tMura.get(\'./?muraAction=cusers.expirepassword&userid=');
    o.e(encodeUrl(bean.userId));
    o.t('&siteid=');
    o.e(encodeUrl(bean.siteId));
    o.t('\')\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t.then(function(){\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tMura(\'#expirepassword\').hide();\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tMura(\'#passwordexpired\').show();\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t\t\t\t);\n\t\t\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t\t\t</script>\n\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t');
  if (strongPasswords) {
    o.t('\n\t\t\t\t\t\t\t\t\t<div class="help-block-inline">');
    o.e(v.rb('user.passwordstrengthhelptext'));
    o.t('</div>\n\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label for="passwordNoCache">');
  o.e(v.rb('user.newpassword'));
  o.t('**</label>\n\t\t\t\t\t\t\t\t\t<input id="passwordNoCache" name="passwordNoCache" autocomplete="off" validate="match" matchfield="password2" type="password" value=""  message="');
  o.e(v.rb('user.passwordmatchvalidate'));
  o.t('">\n\t\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label for="password2">');
  o.e(v.rb('user.newpasswordconfirm'));
  o.t('**</label>\n\t\t\t\t\t\t\t\t\t<input id="password2" name="password2" autocomplete="off" type="password" value=""  message="');
  o.e(v.rb('user.passwordconfirm'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t');
}

/** ACF `isValid('url', value)`: the schemes Adobe documents for the URL type. */
const isCfUrl = (value: string): boolean => /^(?:(?:https?|ftp|file):\/\/|mailto:|news:)\S+$/i.test(value);

/** A stored integer flag of a site record; SQL NULL reads as the bean default 0. */
const siteFlag = (value: number | null | undefined): boolean => (value ?? 0) !== 0;

/** `$.getURLForImage(fileid=<photo>, size='medium', siteid=<bean site>, useProtocol=false)` with direct images. */
function photoImageUrl(v: View): string {
  const { bean, photoSite: site } = v;
  const settings = legacySettings();
  const { record } = site;
  const remote = siteFlag(record.isremote);
  const resourceDomain = record.resourceDomain ?? '';
  // settingsBean getResourcePath(complete=0, useProtocol=0) inside getFileAssetPath.
  const resourcePath =
    remote && resourceDomain !== ''
      ? `//${resourceDomain}${settings.serverPort}${settings.context}`
      : remote
        ? (record.remotecontext ?? '')
        : settings.context;
  let begin = `${resourcePath}${settings.siteAssetPath}/${site.filePoolID}`;
  if (isCfUrl(settings.assetPath)) begin = `${settings.assetPath}/${site.filePoolID}`;
  else if (settings.fileAssetPath !== '') begin = `${settings.fileAssetPath}/${site.filePoolID}`;
  const suffix = bean.photoFileExt.toLowerCase() === 'svg' ? '' : `_${PHOTO_SIZE}`;
  return `${begin}/cache/file/${bean.photoFileId}${suffix}.${bean.photoFileExt}`;
}

// A user bean is neither `site` nor `content` and its numeric type is never `File`, so the tag's file-name, version,
// metadata, lock and unlock branches never render; a photo is always an image (the load refuses any other).
/** `<cf_filetools bean property="photofileid" deleteKey="removePhotoFile" size="medium">` for a user bean. */
function renderFileTools(o: CfOutput, v: View): void {
  const { bean } = v;
  o.t('\n');
  if (hasPhotoFile(bean)) renderPhotoTools(o, v);
  o.t('\n');
}

/** The `cf_filetools` body for a photo with a file row: image, crop link, download link and remove checkbox. */
function renderPhotoTools(o: CfOutput, v: View): void {
  const { bean } = v;
  const fileExt = bean.photoFileExt.toLowerCase();
  o.t('\n<div class="mura-control justify">\n');
  o.t('\n\t');
  o.t('\n\n\t');
  o.t('\n\t\t<img id="assocImage" src="');
  o.e(photoImageUrl(v));
  o.t('?cacheID=');
  o.e(cfUuid());
  o.t('" />\n\t\t<div class="mura-input-set imageToolsButtonGroup">\n\t\t\t');
  if (CROPPABLE_FILE_EXTENSIONS.has(fileExt)) {
    o.t('\n\t\t\t\t');
    o.t('\n\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.imagedetails&userid=');
    o.e(bean.userId);
    o.t('&siteid=');
    o.e(bean.siteId);
    o.t('&fileid=');
    o.e(bean.photoFileId);
    o.t('&compactDisplay=');
    o.e(urlEncodedFormat(v.compactDisplay));
    o.t('"><i class="mi-crop"></i></a>\n\t\t\t\t');
    o.t('\n\t\t\t');
  }
  o.t('\n\t\t\t');
  o.t('\n\t');
  o.t('\n\t');
  o.t('\n\t\t<a class="btn download-file" onclick="return confirmDialog(\'');
  o.e(v.rb('sitemanager.downloadconfirm'));
  o.t('\',function(){location.href=\'');
  o.e(v.context);
  o.t('/index.cfm/_api/render/file/?fileid=');
  o.e(bean.photoFileId);
  o.t('&method=attachment&size=source\';});"><i class="mi-download"></i></a>\n\t');
  o.t('\n\t');
  o.t('\n\t\t</div>\n\t');
  o.t('\n\n\t');
  o.t('\n\t<div>\n\t\t<label class="checkbox inline" for="deleteFileBox">\n\t\t\t<input type="checkbox" name="');
  o.e(PHOTO_DELETE_KEY);
  o.t('" value="1" class="deleteFileBox"/><a href="#" rel="tooltip" title="');
  o.e(v.rb('sitemanager.content.fields.removeattachedfiletooltip'));
  o.t('">');
  o.e(v.rb('sitemanager.content.fields.removeattachedfile'));
  o.t(' <i class="mi-question-sign"></i></a>\n\t\t</label>\n\t</div>\n\t');
  o.t('\n\n\t');
  o.t('\n');
  o.t('\n</div>\n');
}

// No site carries Razuna settings in the target, and a user bean's type is never `File`, so the Razuna button, the
// Razuna URL field and the version-type choice never render. The tag's label, validation, regex and message are empty,
// as are the bean's content and content history ids.
/** `<cf_fileselector name="newfile" property="photofileid" bean deleteKey compactDisplay examplefileext="JPG">`. */
function renderFileSelector(o: CfOutput, v: View): void {
  const { bean } = v;
  const field = encodeHtmlAttr(FILE_FIELD);
  o.t('\n');
  o.t('\n\t<div data-name="');
  o.e(field);
  o.t('" data-property="');
  o.e(encodeHtmlAttr(PHOTO_PROPERTY));
  o.t('" data-fileid="');
  o.e(encodeHtmlAttr(bean.photoFileId));
  o.t('" data-filetype="');
  o.e(encodeHtmlAttr(PHOTO_FILE_TYPE));
  o.t('" data-contentid="" data-siteid="');
  o.e(bean.siteId);
  o.t('" class="mura-file-selector ">\t\t\t\n\t\t<div class="mura-input-set mura-file-selector-tabs" data-toggle="buttons-radio">\n\t\t\t<button type="button" style="display:none">placeholder</button>\n\t\t\t<button type="button" class="btn btn-default mura-file-type-selector active" value="Upload"><i class="mi-upload"></i> ');
  o.e(v.rb('sitemanager.fileselector.viaupload'));
  o.t('</button>\n\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="URL"><i class="mi-download"></i> ');
  o.e(v.rb('sitemanager.fileselector.viaurl'));
  o.t('</button>\n\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="Existing"><i class="mi-file-picture-o"></i> ');
  o.e(v.rb('sitemanager.fileselector.selectexisting'));
  o.t('</button>\n\t\t\t');
  o.t('\n\t\t</div>\n\n\t\t<div id="mura-file-upload-');
  o.e(field);
  o.t('" class="mura-file-option mura-file-upload fileTypeOption');
  o.e(field);
  o.t('">\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<input name="');
  o.e(field);
  o.t('" type="file" class="mura-file-selector-');
  o.e(field);
  o.t('"\n\t\t\t\t\t\tdata-label="" data-label="');
  o.e(field);
  o.t('" data-validation="" data-regex="" data-message="">\n\t\t\t\t\t<a style="display:none;" class="btn btn-default" href="" onclick="return openFileMetaData(\'\',\'\',\'');
  o.e(bean.siteId);
  o.t('\',\'');
  o.e(encodeJs(PHOTO_PROPERTY));
  o.t('\');"><i class="mi-info-circle"></i></a>\n\t\t\t</div>\n\n\t\t</div>\n\t\t<div id="mura-file-url-');
  o.e(FILE_FIELD);
  o.t('" class="mura-file-option mura-file-url fileTypeOption');
  o.e(FILE_FIELD);
  o.t('">\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<input type="text" name="');
  o.e(FILE_FIELD);
  o.t('" class="mura-file-selector-');
  o.e(FILE_FIELD);
  o.t(' span6" type="url" placeholder="http://www.domain.com/yourfile.');
  o.e(PHOTO_EXAMPLE_EXT);
  o.t('"\tvalue=""\n\t\t\t\t\tdata-label="" data-label="');
  o.e(FILE_FIELD);
  o.t('" data-validate="" data-regex="" data-message="">\n\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" onclick="return openFileMetaData(\'\',\'\',\'');
  o.e(bean.siteId);
  o.t('\',\'');
  o.e(PHOTO_PROPERTY);
  o.t('\');"><i class="mi-info-circle"></i></a>\n\t\t\t</div>\n\n\t\t</div>\n\n\t\t<div id="mura-file-existing-');
  o.e(FILE_FIELD);
  o.t('" class="mura-file-option mura-file-existing fileTypeOption');
  o.e(FILE_FIELD);
  o.t('">\n\n\t\t</div>\n\t\t');
  o.t('\n\t\t');
  o.t('\n\n\t\t');
  o.t('\n\n\t\t');
  o.t('\n\t\t\t');
  renderFileTools(o, v);
  o.t('\n\t\t');
  o.t('\n\t</div>\n\n\n');
}

/** Lines 155-272: the Basic pane. */
function renderBasicTab(o: CfOutput, v: View): void {
  const { data, bean } = v;
  o.t('\n\n\t\t\t\t\n\t\t\t\t\t<div id="tabBasic" class="tab-pane active">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">Basic Settings</h3>\n\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t<div class="block-content">\n\n\t\t\t\t\t\t\t<div class="help-block-inline">');
  o.e(v.rb('user.requiredtext'));
  o.t('</div>\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t');
  renderSubTypeSelect(o, v);
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label for="fname">');
  o.e(v.rb('user.fname'));
  o.t('*</label>\n\t\t\t\t\t\t\t\t\t<input id="fname" name="fname" type="text" value="');
  o.e(encodeHtml(bean.fname));
  o.t('"  required="true" message="');
  o.e(v.rb('user.fnamerequired'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label for="lname">');
  o.e(v.rb('user.lname'));
  o.t('*</label>\n\t\t\t\t\t\t\t\t\t<input id="lname" name="lname" type="text" value="');
  o.e(encodeHtml(bean.lname));
  o.t('"  required="true" message="');
  o.e(v.rb('user.lnamerequired'));
  o.t('">\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="organization">');
  o.e(v.rb('user.company'));
  o.t('</label>\n\t\t\t\t\t\t\t\t<input id="organization" name="company" type="text" value="');
  o.e(encodeHtml(bean.company));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="jobtitle">');
  o.e(v.rb('user.jobtitle'));
  o.t('</label>\n\t\t\t\t\t\t\t\t<input id="jobtitle" name="jobtitle" type="text" value="');
  o.e(encodeHtml(bean.jobTitle));
  o.t('">\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="email">');
  o.e(v.rb('user.email'));
  o.t('*</label>\n\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled');
  o.t(' id="email" name="email" type="text" value="');
  o.e(encodeHtml(bean.email));
  o.t('" required="true" validate="email" message="');
  o.e(v.rb('user.emailvalidate'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="mobilePhone">');
  o.e(v.rb('user.mobilephone'));
  o.t('</label>\n\t\t\t\t\t\t\t\t<input id="mobilePhone" name="mobilePhone" type="text" value="');
  o.e(encodeHtml(bean.mobilePhone));
  o.t('">\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="username">');
  o.e(v.rb('user.username'));
  o.t('*</label>\n\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled');
  o.t(' id="username"  name="usernameNoCache" type="text" value="');
  o.e(encodeHtml(bean.username));
  o.t('" required="true" message="The \'Username\' field is required" autocomplete="off">\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t');
  renderPasswordFields(o, v);
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label for="newFile">');
  o.e(v.rb('user.image'));
  o.t('</label>\n\t\t\t\t\t\t\t\t');
  renderFileSelector(o, v);
  o.t('\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t<span id="extendSetsBasic"></span>\n\n\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t\t');
}

/** Lines 299-359: a new user's address fields, filled from the request context. */
function renderNewAddressFields(o: CfOutput, v: View): void {
  const value = (name: string): string => encodeHtml(rcText(v.rc[name], name));
  o.t('\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.address1'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="address1" name="address1" type="text" value="');
  o.e(value('address1'));
  o.t('">\n\t\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.address2'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="address2" name="address2" type="text" value="');
  o.e(value('address2'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.city'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="city" name="city" type="text" value="');
  o.e(value('city'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.state'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="state" name="state" type="text" value="');
  o.e(value('state'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.zip'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="zip" name="zip" type="text" value="');
  o.e(value('zip'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.country'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="country" name="country" type="text" value="');
  o.e(value('country'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.phone'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="phone" name="phone" type="text" value="');
  o.e(value('phone'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.fax'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="fax" name="fax" type="text" value="');
  o.e(value('fax'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.website'));
  o.t(' (');
  o.e(v.rb('user.includehttp'));
  o.t(')</label>\n\t\t\t\t\t\t\t\t\t<input id="addressURL" name="addressURL" type="text" value="');
  o.e(value('addressURL'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.email'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<input id="addressEmail" name="addressEmail" validate="email" message="');
  o.e(v.rb('user.emailvalidate'));
  o.t('" type="text" value="');
  o.e(value('addressEmail'));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.hours'));
  o.t('</label>\n\t\t\t\t\t\t\t\t\t<textarea id="hours" name="hours" rows="6">');
  o.e(value('hours'));
  o.t('</textarea>\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<input type="hidden" name="isPrimary" value="1" />\n\n\t\t\t\t\t\t\t');
}

/** Lines 383-460: one address row; the name link and the website and email links are written unencoded. */
function renderAddressRow(o: CfOutput, v: View, address: EditUserAddress, rowCount: number): void {
  o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t\t\t\t\t\t\t<td>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<input type="radio" name="primaryAddressID" value="');
  o.e(address.addressID);
  o.t('" ');
  if (cfEq(address.isPrimary, '1') || rowCount === 1) o.t('checked');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t\t\t\t\t\t\t<td class="var-width">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.addressName !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="');
    o.e(v.rb('user.edit'));
    o.t('" href="./?muraAction=cUsers.editAddress&amp;userid=');
    o.e(encodeUrl(v.rc.userid));
    o.t('&amp;siteid=');
    o.e(encodeUrl(v.rc.siteid));
    o.t('&amp;routeID=');
    o.e(encodeUrl(v.rc.routeid));
    o.t('&amp;addressID=');
    o.e(address.addressID);
    o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(address.addressName);
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a><br />\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.address1 !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.address1));
    o.t('<br />\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.address2 !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.address2));
    o.t('<br />\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.city !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.city));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.state !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    if (address.city !== '') o.t(',');
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.state));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.zip !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.zip));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.city !== '' || address.state !== '' || address.zip !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<br/>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.phone !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.phone'));
    o.t(': ');
    o.e(encodeHtml(address.phone));
    o.t('<br/>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.fax !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.fax'));
    o.t(': ');
    o.e(encodeHtml(address.fax));
    o.t('<br/>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.addressURL !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.website'));
    o.t(':\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="');
    o.e(address.addressURL);
    o.t('" target="_blank">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.addressURL));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a><br/>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (address.addressEmail !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.email'));
    o.t(':\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="mailto:');
    o.e(address.addressEmail);
    o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(address.addressEmail));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t</td>\n\n\t\t\t\t\t\t\t\t\t\t\t\t\t<td nowrap class="actions">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<ul>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="edit">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="');
  o.e(v.rb('user.edit'));
  o.t('" href="./?muraAction=cUsers.editAddress&amp;userid=');
  o.e(encodeUrl(v.rc.userid));
  o.t('&amp;siteid=');
  o.e(encodeUrl(v.rc.siteid));
  o.t('&amp;routeID=');
  o.e(encodeUrl(v.rc.routeid));
  o.t('&amp;addressID=');
  o.e(address.addressID);
  o.t('">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-pencil"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  if (!cfEq(address.isPrimary, '1')) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="delete">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a title="Delete" href="./?muraAction=cUsers.updateAddress&amp;userid=');
    o.e(encodeUrl(v.rc.userid));
    o.t('&amp;action=delete&amp;siteid=');
    o.e(encodeUrl(v.rc.siteid));
    o.t('&amp;routeID=');
    o.e(encodeUrl(v.rc.routeid));
    o.t('&amp;addressID=');
    o.e(address.addressID);
    o.e(v.csrf.render(addressCsrfContext(v.rc), 'url').value);
    o.t('" onclick="return confirmDialog(\'');
    o.e(jsStringFormat(v.rb('user.deleteaddressconfirm')));
    o.t('\',this.href);">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-trash"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<li class="delete"><i class="mi-trash"></i></li>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t\t\t\t\t\t');
}

/** Lines 276-473: the Address Information pane: a new user's fields, or the add link and the address table. */
function renderAddressTab(o: CfOutput, v: View): void {
  const { addresses } = v.data;
  o.t('<div id="tabAddressinformation" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">Address Information</h3>\n\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t<div class="block-content">\n\n\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t\t');
  if (v.rc.userid === '') {
    renderNewAddressFields(o, v);
  } else {
    o.t('\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<ul class="navTask nav nav-pills">\n\t\t\t\t\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t\t\t\t\t<a href="./?muraAction=cUsers.editAddress&amp;userid=');
    o.e(encodeUrl(v.rc.userid));
    o.t('&amp;siteid=');
    o.e(encodeUrl(v.rc.siteid));
    o.t('&amp;routeID=');
    o.e(encodeUrl(v.rc.routeid));
    o.t('&amp;addressID=">\n\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-plus-circle"></i> ');
    o.e(v.rb('user.addnewaddress'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t\t</ul>\n\n\t\t\t\t\t\t\t\t\t');
    o.t('\n\n\t\t\t\t\t\t\t\t\t');
    if (addresses.length > 0) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t<table class="table table-striped table-condensed table-bordered mura-table-grid">\n\t\t\t\t\t\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>');
      o.e(v.rb('user.primary'));
      o.t('</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<th>');
      o.e(v.rb('user.address'));
      o.t('</th>\n\t\t\t\t\t\t\t\t\t\t\t\t<th class="adminstration"></th>\n\t\t\t\t\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t\t\t\t\t\t');
      for (const address of addresses) renderAddressRow(o, v, address, addresses.length);
      o.t('\n\t\t\t\t\t\t\t\t\t\t</table>\n\t\t\t\t\t\t\t\t\t');
    } else {
      o.t('\n\t\t\t\t\t\t\t\t\t\t<div class="help-block-empty">');
      o.e(v.rb('user.noaddressinformation'));
      o.t('</div>\n\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\n\n\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t\t');
}

/** Whether a group checkbox is checked: by the bean's memberships or the request's `groupid` list. */
const isMember = (v: View, groupId: string): boolean =>
  listFind(v.bean.groupIds, groupId) || listFind(cfListToArray(v.rc.groupid), groupId);

/** Lines 488-528: the user-type radios and their toggle script for an admin, otherwise the hidden `isPublic`. */
function renderUserType(o: CfOutput, v: View): void {
  const { data } = v;
  if (!v.rc.isAdmin) {
    o.t('\n\t\t\t\t\t\t\t\t<input name="isPublic" type="hidden" value="1">\n\t\t\t\t\t\t\t');
    return;
  }
  const isPublic = cfToBoolean(data.tempIsPublic);
  o.t('\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.usertype'));
  o.t('\n\t\t\t\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled ');
  o.t('name="isPublic" type="radio" class="radio inline" value="1"');
  if (isPublic) o.t(' Checked');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.sitemember'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled ');
  o.t('name="isPublic" type="radio" class="radio inline" value="0"');
  if (!isPublic) o.t(' Checked');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.adminuser'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t<script>\n\t\t\t\t\t\t\t\t\tjQuery(document).ready(function($){\n\n\t\t\t\t\t\t\t\t\t\t$(\'input[name="isPublic"]\').click(function(e){\n\n\t\t\t\t\t\t\t\t\t\t\tif($(\'input[name="isPublic"]:checked\').val()==1){\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'#privateGroupsList\').hide();\n\t\t\t\t\t\t\t\t\t\t\t} else {\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'#privateGroupsList\').show();\n\t\t\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t\t});\n\n\t\t\t\t\t\t\t\t\t\t$(\'input[name="s2"]\').click(function(e){\n\t\t\t\t\t\t\t\t\t\t\tif($(\'input[name="s2"]:checked\').val()==1){\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'input[name="isPublic"][value="0"]\').attr(\'checked\',true);\n\t\t\t\t\t\t\t\t\t\t\t\t$(\'input[name="isPublic"]\').trigger(\'clicked\');\n\t\t\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t\t});\n\n\t\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t\t</script>\n\t\t\t\t\t\t\t');
}

/** Lines 534-583: an admin's system-group checkboxes, hidden while the user type is Site Member; names unencoded. */
function renderPrivateGroups(o: CfOutput, v: View): void {
  const { data } = v;
  if (!v.rc.isAdmin) return;
  o.t('\n\t\t\t\t\t\t\t\t\t<div id="privateGroupsList" class="mura-control-group"');
  if (cfToBoolean(data.tempIsPublic)) o.t(' style="display:none"');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.admingroups'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\t');
  if (data.privateGroups.length > 0) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t');
    for (const group of data.privateGroups) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<label class="checkbox">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<input name="groupid" type="checkbox" class="checkbox" value="');
      o.e(group.UserID);
      o.t('" ');
      if (isMember(v, group.UserID)) o.t('checked');
      o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
      o.e(group.GroupName ?? '');
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<p class="help-block-empty">\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.nogroups'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t</p>\n\t\t\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t');
}

/** Lines 586-602: the member-group checkboxes, labelled `<site> - <group>` unencoded. */
function renderPublicGroups(o: CfOutput, v: View): void {
  const { data } = v;
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.membergroups'));
  o.t('\n\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t');
  if (data.publicGroups.length > 0) {
    o.t('\n\t\t\t\t\t\t\t\t\t\t');
    for (const group of data.publicGroups) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t<label class="checkbox">\n\t\t\t\t\t\t\t\t\t\t\t\t<input name="groupid" type="checkbox" class="checkbox" value="');
      o.e(group.UserID);
      o.t('" ');
      if (isMember(v, group.UserID)) o.t('checked');
      o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
      o.e(group.Site ?? '');
      o.t(' - ');
      o.e(group.GroupName ?? '');
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t<p class="help-block-empty">\n\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.nogroups'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t</p>\n\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t\t');
}

/** Lines 476-607: the Group Memberships pane. */
function renderGroupsTab(o: CfOutput, v: View): void {
  o.t('<div id="tabGroupmemberships" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">Group Memberships</h3>\n\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t<div class="block-content">\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t');
  renderUserType(o, v);
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t');
  renderPrivateGroups(o, v);
  renderPublicGroups(o, v);
}

/** Lines 610-630: the Interests pane around the `cf_dsp_categories_nest` tree. */
function renderInterestsTab(o: CfOutput, v: View): void {
  o.t('<div id="tabInterests" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">Interests</h3>\n\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t<div class="block-content">\n\t\t\t\t\t\t\t<div id="mura-list-tree" class="mura-control-group">\n\n\t\t\t\t\t\t\t\t');
  o.e(v.interests);
  o.t('\n\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t\t');
}

/** Lines 633-649: the Extended Attributes pane and its loader call, shown when the pool has a user subtype. */
function renderExtendedTab(o: CfOutput, v: View): void {
  const { data, bean } = v;
  if (data.subTypes.length === 0) return;
  // The view passes five arguments; the context argument of `loadExtendedAttributes` is missing, as legacy writes it.
  o.t('\n\t\t\t\t\t\t<div id="tabExtendedattributes" class="tab-pane">\n\t\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t\t<h3 class="block-title">Extended Attributes</h3>\n\t\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t\t<div class="block-content">\n\n\t\t\t\t\t\t\t\t<span id="extendSetsDefault"></span>\n\t\t\t\t\t\t\t\t<script type="text/javascript">\n\t\t\t\t\t\t\t\t\tuserManager.loadExtendedAttributes(\'');
  o.e(bean.userId);
  o.t('\',\'');
  o.e(bean.type);
  o.t('\',\'');
  o.e(bean.subType);
  o.t('\',\'');
  o.e(data.userPoolId);
  o.t('\',\'');
  o.e(data.themeAssetPath);
  o.t('\');\n\t\t\t\t\t\t\t\t</script>\n\t\t\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\t');
}

/** Lines 662-689: the S2 super-admin radios, then the subscription radios when the site broadcasts email. */
function renderAccountFlags(o: CfOutput, v: View): void {
  const { bean } = v;
  if (v.isS2) {
    o.t('\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.superadminaccount'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t\t<label class="radio inline"><input name="s2" type="radio" class="radio inline" value="1" ');
    if (cfEq(bean.s2, '1')) o.t('Checked');
    o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.yes'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t\t<label class="radio inline"><input name="s2" type="radio" class="radio inline" value="0" ');
    if (cfEq(bean.s2, '0')) o.t('Checked');
    o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.no'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t\n\t\t\t\t\t\t');
  if (v.emailBroadcaster) {
    o.t('\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>');
    o.e(v.rb('user.emailbroadcaster'));
    o.t('</label>\n\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t<input name="subscribe" type="radio" class="radio inline" value="1"');
    if (cfEq(bean.subscribe, '1')) o.t('Checked');
    o.t('>\n\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.yes'));
    o.t('\n\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t<input name="subscribe" type="radio" class="radio inline" value="0"');
    if (cfEq(bean.subscribe, '0')) o.t('Checked');
    o.t('>\n\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.no'));
    o.t('\n\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t');
  }
}

/** Lines 692-723: the Active radios, then the S2 site select or the hidden `siteid`. */
function renderActiveAndSite(o: CfOutput, v: View): void {
  const { data, bean } = v;
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.inactive'));
  o.t('\n\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled ');
  o.t('name="InActive" type="radio" class="radio inline" value="0"');
  if (cfEq(bean.inActive, '0')) o.t('Checked');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.yes'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t\t\t\t\t<input ');
  if (data.lockedSuper) o.t('disabled ');
  o.t('name="InActive" type="radio" class="radio inline" value="1"');
  if (cfEq(bean.inActive, '1')) o.t('Checked');
  o.t('>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.e(v.rb('user.no'));
  o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t');
  if (v.isS2) {
    o.t('\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb('user.site'));
    o.t('\n\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t<select name="siteid">\n\t\t\t\t\t\t\t\t\t\t\t');
    for (const site of data.sites) {
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t<option value="');
      o.e(encodeHtmlAttr(site.siteID));
      o.t('" ');
      if ((data.exists && cfEq(bean.siteId, site.siteID)) || cfEq(v.sessionSiteId, site.siteID)) {
        o.t('selected="selected"');
      }
      o.t('>\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
      o.e(encodeHtml(site.site));
      o.t('\n\t\t\t\t\t\t\t\t\t\t\t\t</option>\n\t\t\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t\t\t</select>\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t<input type="hidden" name="siteid" value="');
    o.e(encodeHtmlAttr(v.rc.siteid));
    o.t('">\n\t\t\t\t\t\t\t\t');
  }
}

/** Lines 736-755: a stored user's web-service connections, each removable by its `removeToken` checkbox. */
function renderWebServices(o: CfOutput, v: View): void {
  const { data } = v;
  if (!data.exists) return;
  o.t('\n\t\t\t\t\t\t\t\t');
  o.t('\n\n\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="Check to remove connection to web service." data-original-title="Web Services">\n\t\t\t\t\t\t\t  \t\tWeb Services <i class="mi-question-circle"></i></span>\n\t\t\t\t\t\t\t\t\t');
  if (data.webServiceTokens.length > 0) {
    o.t('\n\t\t\t\t\t\t\t\t\t');
    data.webServiceTokens.forEach((token, index) => {
      o.t('\n\t\t\t\t\t\t\t\t\t\t');
      o.t('\n\t\t\t\t\t\t\t\t\t\t<label for="removeToken');
      o.e(String(index + 1));
      o.t('" class="checkbox"><input name="removeToken" id="removeToken');
      o.e(String(index + 1));
      o.t('" type="CHECKBOX" value="');
      o.e(token.token);
      o.t('" class="checkbox"> ');
      o.e(encodeHtml(token.clientName));
      o.t('</label>\n\t\t\t\t\t\t\t\t\t');
    });
    o.t('\n\t\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t<div class="alert alert-info"><p>This user has not connected through any web services.</p></div>\n\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t');
}

/** Lines 653-760: the Advanced pane. */
function renderAdvancedTab(o: CfOutput, v: View): void {
  const { bean } = v;
  o.t('\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t\t<div id="tabAdvanced" class="tab-pane">\n\t\t\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t\t\t<!-- block header -->\n\t\t\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t\t\t<h3 class="block-title">Advanced</h3>\n\t\t\t\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t\t\t\t<div class="block-content">\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t');
  renderAccountFlags(o, v);
  renderActiveAndSite(o, v);
  o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.tags'));
  o.t('</label>\n\t\t\t\t\t\t\t\t<input id="tags" name="tags" type="text" value="');
  o.e(encodeHtml(bean.tags));
  o.t('">\n\t\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>');
  o.e(v.rb('user.remoteid'));
  o.t('</label>\n\t\t\t\t\t\t\t\t<input id="remoteID" name="remoteID" type="text" value="');
  o.e(encodeHtml(bean.remoteID));
  o.t('">\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t\t');
  renderWebServices(o, v);
  o.t('\n\n\t\t\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t\t\t</div> <!-- /.block-bordered -->\n\t\t\t\t</div> <!-- /.tab-pane -->\n\t\t\t\t\n\t\t\t');
}

/** Lines 104-111: `tabList` with the labels `listGetAt(tabLabelList, t)` pairs with each id. */
function tabsOf(v: View): ReadonlyArray<readonly [id: string, label: string]> {
  const ids = ['tabBasic', 'tabAddressinformation', 'tabGroupmemberships', 'tabInterests'];
  const labels = ['user.basic', 'user.addressinformation', 'user.groupmemberships', 'user.interests'].map(v.rb);
  if (v.data.subTypes.length > 0) {
    ids.push('tabExtendedattributes');
    labels.push(v.rb('user.extendedattributes'));
  }
  ids.push('tabAdvanced');
  labels.push(v.rb('user.advanced'));
  // Labels are list elements, so a label holding a comma shifts the ones after it, as `listGetAt` reads them.
  const labelItems = cfListToArray(labels.join(','));
  return ids.map((id, index) => {
    const label = labelItems[index];
    if (label === undefined) throw new RangeError(`listGetAt: tabLabelList has no element ${index + 1}`);
    return [id, label] as const;
  });
}

/** Lines 790-799: the tab strip; the Extended Attributes tab starts hidden, the first tab active. */
function renderTabs(o: CfOutput, v: View): void {
  o.t('\n\t\t\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">\n\t\t\t\t');
  tabsOf(v).forEach(([id, label], index) => {
    o.t('\n\t\t\t\t\t<li');
    if (id === 'tabExtendedattributes') o.t(' id="tabExtendedattributesLI" class="hide"');
    else if (index === 0) o.t(' class="active"');
    o.t('>\n\t\t\t\t\t\t<a href="#');
    o.e(id);
    o.t('" onclick="return false;">\n\t\t\t\t\t\t\t<span>');
    o.e(label);
    o.t('</span>\n\t\t\t\t\t\t</a>\n\t\t\t\t\t</li>\n\t\t\t\t');
  });
  o.t('\n\t\t\t</ul>\n\n\t\t\t<div class="tab-content block-content">\n\t\t\t\t');
}

/** Lines 151-788: the `tabContent` saved content, a buffer of its own; `onUserEdit` plugin tabs have no target. */
function renderTabContent(v: View): string {
  const o = new CfOutput();
  o.t('\n\t\t\t');
  renderBasicTab(o, v);
  renderAddressTab(o, v);
  renderGroupsTab(o, v);
  renderInterestsTab(o, v);
  renderExtendedTab(o, v);
  renderAdvancedTab(o, v);
  o.t('\n\n\t\t\t');
  o.t('\n\t\t');
  return o.toString();
}

/** Lines 802-833: the preloader, the action buttons and the hidden fields. */
function renderFooter(o: CfOutput, v: View): void {
  const { data, bean } = v;
  const adding = v.rc.userid === '' || !data.exists;
  o.t('\n\t\t\t\t<div class="load-inline tab-preloader"></div>\n\t\t\t\t<script>$(\'.tab-preloader\').spin(spinnerArgs2);</script>\n\n\t\t\t\t<div class="mura-actions">\n\t\t\t\t\t<div class="form-actions">\n\t\t\t\t\t\t');
  if (adding) {
    o.t('\n\t\t\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="userManager.submitForm(document.forms.form1,\'add\');"><i class="mi-check-circle"></i>');
    o.e(v.rb('user.add'));
    o.t('</button>\n\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t');
    if (!data.lockedSuper) {
      o.t('<button type="button" class="btn" onclick="submitForm(document.forms.form1,\'delete\',\'');
      o.e(jsStringFormat(v.rb('user.deleteuserconfirm')));
      o.t('\');"><i class="mi-trash"></i>');
      o.e(v.rb('user.delete'));
      o.t('</button>');
    }
    o.t('\n\t\t\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="userManager.submitForm(document.forms.form1,\'update\');"><i class="mi-check-circle"></i>');
    o.e(v.rb('user.update'));
    o.t('</button>\n\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n\n\t\t\t\t<input type="hidden" name="type" value="2">\n\t\t\t\t');
  o.t('\n\t\t\t\t<input type="hidden" name="action" value="');
  o.e(adding ? 'Add' : 'Update');
  o.t('">\n\t\t\t\t<input type="hidden" name="contact" value="0">\n\t\t\t\t<input type="hidden" name="groupid" value="">\n\t\t\t\t<input type="hidden" name="ContactForm" value="">\n\t\t\t\t<input type="hidden" name="returnurl" value="');
  o.e(v.url('cUsers.listUsers', `ispublic=${data.tempIsPublic}`));
  o.t('">\n\n\t\t\t\t');
  if (nonDefaultSubTypes(data).length === 0) {
    o.t('\n\t\t\t\t\t<input type="hidden" name="subtype" value="Default"/>\n\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t');
  o.e(v.csrf.render(bean.userId, 'form').value);
  o.t('\n\n\n\t\t\t</div> <!-- /.block-content.tab-content -->\n\t\t');
}

/** The view body inside `#mura-content`, and its `cfhtmlhead` texts (the date key, then `user.js`). */
export async function renderEditUser(ctx: ScreenContext, data: EditUserData): Promise<ShellView> {
  const { bean, rc } = data;
  const interests = await renderUserCategoriesNest({
    siteId: rc.siteid,
    parentId: '',
    categoryId: rc.categoryid,
    nestLevel: 0,
    userCategoryIds: bean.categoryIds,
    loadForest: () => Promise.resolve(data.interestCategories),
    rb: ctx.rb,
  });
  const ses = { ses: ctx.req.ses };
  const v: View = {
    data,
    bean,
    rc,
    rb: (key) => ctx.rb.rbKey(key),
    url: (action, queryString) => buildUrl(action, undefined, queryString, ses),
    csrf: ctx.csrf,
    context: legacySettings().context,
    locale: ctx.req.session.locale,
    isS2: ctx.req.isS2,
    sessionSiteId: ctx.req.session.siteid,
    emailBroadcaster: ctx.req.site?.emailBroadcaster === true,
    compactDisplay: ctx.req.rc['compactDisplay'] ?? 'false',
    photoSite: data.photoSite,
    interests: interests.value,
  };
  const o = new CfOutput();
  o.t('\n');
  renderHeader(o, v);
  renderAlerts(o, v);
  o.t('\n\n<form novalidate="novalidate" action="');
  o.e(v.url('cUsers.update', `userid=${bean.userId}&routeid=${encodeUrl(rc.routeid)}`));
  o.t('" method="post" enctype="multipart/form-data" name="form1" onsubmit="return userManager.submitForm(this);;" autocomplete="off">\n\n\t<div class="block block-constrain">\n\n\t\t');
  o.t('\n\n\t\t');
  o.t('\n\n\t\t');
  renderTabs(o, v);
  o.e(renderTabContent(v));
  renderFooter(o, v);
  o.t('\n\n\t</div> <!-- /.block-constrain -->\n</form>\n');
  return { body: raw(o.toString()), htmlHead: editGroupHtmlHead(ctx) };
}

/** `cUsers.editUser`, owned by identity (its strike reset writes `tuserstrikes`), behind the cUsers `before()` gate. */
export const editUserScreen: PageScreen<EditUserData> = Object.freeze({
  circuit: 'cusers',
  action: 'edituser',
  owner: 'identity',
  mode: 'page',
  gate: cusersGate,
  load: (ctx: ScreenContext) => loadEditUser(ctx),
  render: renderEditUser,
});
