// `cUsers.editGroup`: the controller's `editGroup()` and the group form of `admin/core/views/cusers/editgroup.cfm` (server-only).
import { cfEq, cfListToArray, cfToBoolean, cfUuid } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { SiteData } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, userPoolIdFor, type CusersRc, type CusersRcValue } from './gate';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the text around them joins, and whitespace-only text between two CFML tags or expressions prints one space, or
// nothing after output that already ends in whitespace.

/** A legacy error struct, keyed and ordered as the owning service reports it. */
export type GroupErrors = Readonly<Record<string, string>>;

/** The user bean the form renders: a stored or new group, or a failed save's posted values. */
export interface EditGroupBean {
  readonly userId: string;
  readonly groupName: string;
  readonly email: string;
  /** `getIsPublic()` as CFML prints it. */
  readonly isPublic: string;
  /** `getPerm()` as CFML holds it; evaluated as a CFML boolean where the view tests it. */
  readonly perm: string;
  readonly subType: string;
  readonly tablist: string;
  readonly isNew: boolean;
  readonly errors: GroupErrors;
}

/** An active class extension subtype of type `1` (User Group) in the edited user pool. */
export interface GroupSubType {
  readonly subType: string;
}

/** `classExtensionManager.getSubTypesByType(type=1, siteid, activeOnly=true)`, ordered by type then subtype. */
export type GroupSubTypeLoader = (ctx: ScreenContext, userPoolId: string) => Promise<readonly GroupSubType[]>;

/** Everything the view reads after `editGroup()` and the view's own set-up. */
export interface EditGroupData {
  readonly rc: CusersRc;
  /** `rc.userid` after `editGroup()` copies a non-empty `rc.groupid` over it. */
  readonly userid: string;
  readonly bean: EditGroupBean;
  /** `rc.tempIsPublic`, the group type the radios and the list return URL show. */
  readonly tempIsPublic: string;
  readonly userPoolId: string;
  readonly subTypes: readonly GroupSubType[];
  /** `settingsManager.getSite(rc.siteid).getThemeAssetPath()`. */
  readonly themeAssetPath: string;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<EditGroupData>['render']>>;

type Struct = Readonly<Record<string, unknown>>;

/** rc key under which a failed `cUsers.update{type=1}` preserves identity's `GroupWriteResult` as JSON for this form. */
export const GROUP_BEAN_RC_KEY = 'userBean';

/** `contentManager.getTabList()`; strategies-content's contract exposes no tab list, so the legacy constant is used. */
export const CONTENT_TAB_LIST = 'Basic,SEO,Summary,Image,Publishing,Scheduling,Layout & Objects,Categorization,Tags,Related Content,Extended Attributes,Remote';

// People owns the `tusers` class extensions, but its contract has no read of User Group (type 1) subtypes, so the
// registered screen renders as legacy does for a pool without active group subtypes until such a read exists.
/** The subtype source of the registered screen: none, as no owner contract serves group subtypes. */
export const NO_GROUP_SUBTYPES: GroupSubTypeLoader = () => Promise.resolve([]);

const USER_JS = raw('<script type="text/javascript" src="assets/js/user.js"></script>');

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
function rcText(value: CusersRcValue, name: string): string {
  if (typeof value === 'object') throw new TypeError(`rc.${name} is not a simple value`);
  return String(value);
}

/** A group record as the bean holds it; a NULL flag keeps `userBean.init`'s value, as identity reads it. */
function beanOf(group: Struct, isNew: boolean, errors: GroupErrors): EditGroupBean {
  return {
    userId: text(group, 'UserID'),
    groupName: text(group, 'GroupName'),
    email: text(group, 'Email'),
    isPublic: text(group, 'isPublic', '1'),
    perm: text(group, 'Perm', '0'),
    subType: text(group, 'subType'),
    tablist: text(group, 'tablist'),
    isNew,
    errors,
  };
}

/** `userManager.read('')`: a new bean, whose `getUserID()` makes a CF UUID on first read. */
function newGroupBean(): EditGroupBean {
  return {
    userId: cfUuid(),
    groupName: '',
    email: '',
    isPublic: '1',
    perm: '0',
    subType: 'Default',
    tablist: '',
    isNew: true,
    errors: {},
  };
}

/**
 * identity's group of `groupId`, or its defaulted new group for an unknown id.
 * @throws GatewayDenialError When identity refuses the read (401 or 403).
 */
async function readGroup(ctx: ScreenContext, groupId: string): Promise<{ group: Struct; isNew: boolean }> {
  const response = await ctx.gateway.identity.call('get', '/v1/groups/{groupId}', { params: { groupId } });
  return okBody(response, 'identity', 'getGroup');
}

/** The errors of a preserved write result; an absent struct is the empty one a saved bean holds. */
function errorsOf(result: Struct): GroupErrors {
  const errors = member(result, 'errors');
  if (errors === undefined) return {};
  if (!isStruct(errors)) throw new TypeError('errors is not a struct');
  return Object.fromEntries(Object.keys(errors).map((key) => [key, text(errors, key)]));
}

/**
 * `rc.userBean` when the restored flash context carries a failed save, else the group `userid` names, else a new one.
 * @throws TypeError When the preserved value is not a group write result.
 */
async function groupBean(ctx: ScreenContext, rc: CusersRc, userid: string): Promise<EditGroupBean> {
  const preserved = rc[GROUP_BEAN_RC_KEY];
  if (preserved !== undefined) {
    const result: unknown = JSON.parse(rcText(preserved, GROUP_BEAN_RC_KEY));
    const group = isStruct(result) ? member(result, 'group') : undefined;
    if (!isStruct(result) || !isStruct(group)) throw new TypeError(`rc.${GROUP_BEAN_RC_KEY} is not a group write result`);
    const preservedIsNew = member(result, 'isNew');
    // A save's bean is new unless the group it names is stored, which identity's read of that id answers.
    const isNew =
      typeof preservedIsNew === 'boolean' ? preservedIsNew : (await readGroup(ctx, text(group, 'UserID'))).isNew;
    return beanOf(group, isNew, errorsOf(result));
  }
  if (userid === '') return newGroupBean();
  const { group, isNew } = await readGroup(ctx, userid);
  return beanOf(group, isNew, {});
}

const on = (value: number | null | undefined): boolean => (value ?? 0) !== 0;

// Web cannot read the legacy web root, so the theme is taken to be under `<webroot>/themes`, as the shell prints
// `themepath` (EX-SHELL-THEMEPATH).
/** `getThemeAssetPath()` of `site`: `getResourcePath(complete=0)` followed by `/themes/<theme>`. */
export function themeAssetPath(site: SiteData, https: boolean): string {
  const { context, serverPort } = legacySettings();
  const { record } = site;
  const remote = on(record.isremote);
  const resourceDomain = record.resourceDomain ?? '';
  if (remote && resourceDomain !== '') {
    const useSSL = record.useSSL === null || record.useSSL === undefined ? on(record.ExtranetSSL) : on(record.useSSL);
    const scheme = on(record.resourceSSL) || useSSL || https ? 'https' : 'http';
    return `${scheme}://${resourceDomain}${serverPort}${context}/themes/${record.theme ?? ''}`;
  }
  return `${remote ? (record.remotecontext ?? '') : context}/themes/${record.theme ?? ''}`;
}

/**
 * The view's data: `editGroup()`'s bean and group type, and the view set-up's user pool and subtypes; issues the
 * form's CSRF pair. Gateway unavailability propagates.
 * @throws GatewayDenialError When identity refuses the group read (401 or 403).
 * @throws TypeError When the request carries no site data, or a preserved bean is malformed.
 */
export async function loadEditGroup(
  ctx: ScreenContext,
  loadSubTypes: GroupSubTypeLoader = NO_GROUP_SUBTYPES,
): Promise<EditGroupData> {
  const rc = normaliseCusersRc(ctx.req);
  const { site } = ctx.req;
  if (site === undefined) throw new TypeError('cUsers.editGroup: the request carries no site data');
  const userid = rc.groupid !== '' ? rc.groupid : rc.userid;
  const bean = await groupBean(ctx, rc, userid);
  const setIsPublic = rc.setispublic;
  const userPoolId = userPoolIdFor({ site }, rc);
  const subTypes = await loadSubTypes(ctx, userPoolId);
  await ctx.csrf.prefetch([bean.userId]);
  return {
    rc,
    userid,
    bean,
    tempIsPublic: setIsPublic !== undefined && rc.isAdmin ? rcText(setIsPublic, 'setispublic') : bean.isPublic,
    userPoolId,
    subTypes,
    themeAssetPath: themeAssetPath(site, ctx.req.https),
  };
}

/** Whether `output` ends in whitespace (a char at or below U+0020, as Java trim counts it). */
const endsInWhitespace = (output: string): boolean => output === '' || output.charCodeAt(output.length - 1) <= 0x20;

/**
 * `utility.displayErrors(errors)` after the alert's `<span>`: every message but `siteID`'s, unencoded and in struct
 * order, a `<br>` after each one the struct holds a later key for, spaced as ACF writes the function's whitespace.
 */
export function displayErrors(errors: GroupErrors): SafeHtml {
  const keys = Object.keys(errors);
  let out = ' ';
  keys.forEach((key, index) => {
    if (key.toLowerCase() === 'siteid') return;
    out += errors[key] ?? '';
    if (!endsInWhitespace(out)) out += ' ';
    // The position counts every key, `siteID` included.
    if (keys.length > index + 1) out += '<br> ';
  });
  return raw(out);
}

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\f': '\\f',
  '\b': '\\b',
};

/** CFML `JSStringFormat`: backslash, both quotes and the control escapes; every other character passes unchanged. */
export function jsStringFormat(value: string): string {
  return value.replace(/[\\"'\n\r\t\f\b]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);
}

/** The two `cfhtmlhead` texts, in order: `session.dateKey` and the user script. */
export function editGroupHtmlHead(ctx: ScreenContext): SafeHtml {
  return join([ctx.req.session.dateKey.script, USER_JS]);
}

/** The admin-only script that reloads the form with the clicked group type, and its `frmTemp` form. */
const GROUP_TYPE_RELOAD = raw(`
\t<script>
\t\tjQuery(document).ready(function($){

\t\t\t$('input[name="isPublic"]').click(function(e){
\t\t\t\te.preventDefault();
\t\t\t\tactionModal();
\t\t\t\t$('form#frmTemp input[name="setispublic"]').val($(this).val());
\t\t\t\t$('form#frmTemp').submit();
\t\t\t});

\t\t});
\t</script>
\t<form id="frmTemp" action="" method="post">
\t\t<input type="hidden" name="setispublic" value="1">
\t</form>
`);

const TABS_BLOCK_HEADER = raw(`
\t\t\t\t\t<!-- block header -->
\t\t\t\t\t<div class="block-header">
\t\t\t\t\t\t<h3 class="block-title">Basic Settings</h3>
\t\t\t\t\t</div> <!-- /.block header -->
\t\t\t\t`);

const EXTENDED_ATTRIBUTES_PANE = raw(`
\t\t\t\t\t<div id="tabExtendedattributes" class='tab-pane'>
\t\t\t\t\t\t<div class="block block-bordered">
\t\t\t\t\t\t\t<!-- block header -->
\t\t\t\t\t\t\t<div class="block-header">
\t\t\t\t\t\t\t\t<h3 class="block-title">Extended Attributes</h3>
\t\t\t\t\t\t\t</div> <!-- /.block header -->
\t\t\t\t\t\t\t<div class="block-content">
\t\t\t\t\t\t\t\t<span id="extendSetsDefault"></span>
\t\t\t\t\t\t\t</div> <!-- /.block-content -->
\t\t\t\t\t\t</div> <!-- /.block-bordered -->
\t\t\t\t\t</div> <!-- /.tab-pane -->
\t\t\t\t`);

const SUBTYPE_DEFAULT_FIELD = raw(`
\t\t\t\t\t\t<input type="hidden" name="subtype" value="Default"/>
\t\t\t\t\t`);

/** What the view's markup reads besides the data: labels, URLs and the CSRF fields. */
interface ViewParts {
  readonly data: EditGroupData;
  /** `rbKey(key)`. */
  readonly rb: (key: string) => string;
  /** `rbKey(key)`, unencoded as the view writes it. */
  readonly label: (key: string) => SafeHtml;
  readonly url: (action: string, queryString?: string) => SafeHtml;
  readonly csrf: SafeHtml;
  readonly context: string;
}

/** CFML `listFindNoCase(list, value) > 0` over a comma list. */
const listHasNoCase = (list: string, value: string): boolean =>
  cfListToArray(list).some((item) => item.toLowerCase() === value.toLowerCase());

/** `rsNonDefault`: the subtypes the query of queries keeps by its case-sensitive `subtype <> 'Default'`. */
const nonDefaultSubTypes = (data: EditGroupData): readonly GroupSubType[] =>
  data.subTypes.filter(({ subType }) => subType !== 'Default');

/** The `mura-header` toolbar: back, all groups and, for a stored group, its members. */
function renderHeader({ data, rb, label, url }: ViewParts): SafeHtml {
  const membersLink = data.bean.isNew
    ? ''
    : html`
\t\t\t\t<a class="btn" href="${url('cusers.editgroupmembers', `userid=${data.userid}&siteid=${encodeUrl(data.rc.siteid)}`)}" onclick="actionModal();">
\t\t\t\t\t\t<i class="mi-group"></i>
\t\t\t\t\t${label('user.viewgroupsusers')}
\t\t\t\t</a>
\t\t\t`;
  return html`
\t<div class="mura-header">
\t\t<h1>${label('user.groupform')}</h1>
\t\t<div class="nav-module-specific btn-group">
\t\t\t<a class="btn" href="#" title="${raw(encodeHtml(rb('sitemanager.back')))}" onclick="actionModal();window.history.back(); return false;">
\t\t\t\t\t<i class="mi-arrow-circle-left"></i>
\t\t\t\t${label('sitemanager.back')}
\t\t\t</a>
\t\t\t<a class="btn" href="${url('cusers.list')}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-users"></i>
\t\t\t\t${label('user.viewallgroups')}
\t\t\t</a>
\t\t\t${membersLink}
\t\t</div>
\t</div> <!-- /.mura-header -->`;
}


/** The tab list and the open Basic pane, shown when the pool has a group subtype; plugin tabs run only on legacy. */
function renderTabsOpen(rb: (key: string) => string): SafeHtml {
  return html`
\t\t\t\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">
\t\t\t\t\t
\t\t\t\t\t<li class="active">
\t\t\t\t\t\t<a href="#tabBasic" onclick="return false;"><span>${raw(encodeHtml(rb('user.basic')))}</span></a>
\t\t\t\t\t</li>

\t\t\t\t\t
\t\t\t\t\t
\t\t\t\t\t\t<li id="tabExtendedattributesLI" class="hide">
\t\t\t\t\t\t\t<a href="#tabExtendedattributes" onclick="return false;">
\t\t\t\t\t\t\t\t<span>${raw(encodeHtml(rb('user.extendedattributes')))}</span>
\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t</li>
\t\t\t\t\t
\t\t\t\t</ul>

\t\t\t\t<div class="tab-content block-content">
\t\t\t\t\t<div id="tabBasic" class="tab-pane active">
\t\t\t`;
}


/** Group type radios for an admin on a non-`Perm` group, otherwise the hidden `isPublic`; a new group shows Member. */
function renderGroupType({ data, label }: ViewParts): SafeHtml {
  if (!(data.rc.isAdmin && !cfToBoolean(data.bean.perm))) {
    return html`
\t\t\t\t\t\t<input type="hidden" name="isPublic" value="${raw(data.tempIsPublic)}">
\t\t\t\t\t`;
  }
  const isMember = cfToBoolean(data.tempIsPublic);
  return html`
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t\t${label('user.grouptype')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t\t\t\t<input name="isPublic" type="radio" class="radio inline" value="1" ${raw(isMember ? 'Checked' : '')}>
\t\t\t\t\t\t\t\t${label('user.membergroup')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t\t\t\t<input name="isPublic" type="radio" class="radio inline" value="0" ${raw(isMember ? '' : 'Checked')}>
\t\t\t\t\t\t\t\t\t${label('user.systemgroup')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t`;
}

/** The subtype select when the pool has a non-`Default` group subtype; subtype names are written unencoded. */
function renderSubTypeSelect({ data, label, context }: ViewParts): SafeHtml {
  const options = nonDefaultSubTypes(data);
  if (options.length === 0) return raw('');
  const { bean } = data;
  const selected = (subType: string): SafeHtml => raw(cfEq(bean.subType, subType) ? 'selected' : '');
  const option = ({ subType }: GroupSubType): SafeHtml => html`
\t\t\t\t\t\t\t\t\t<option value="${raw(subType)}" ${selected(subType)}>
\t\t\t\t\t\t\t\t\t\t${raw(subType)}
\t\t\t\t\t\t\t\t\t</option>
\t\t\t\t\t\t\t\t`;
  return html`
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t\t${label('user.type')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t<select name="subtype" onchange="userManager.resetExtendedAttributes('${raw(bean.userId)}','1',this.value,'${raw(data.userPoolId)}','${raw(context)}','${raw(data.themeAssetPath)}');">
\t\t\t\t\t\t\t\t<option value="Default" ${selected('Default')}>
\t\t\t\t\t\t\t\t\t${label('user.default')}
\t\t\t\t\t\t\t\t</option>
\t\t\t\t\t\t\t\t${options.map(option)}
\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t</div>
\t\t\t\t\t`;
}

/** The content tab assignments, absent for a `Perm` group; each tab's label key drops every non-word character. */
function renderTabList({ data, label }: ViewParts): SafeHtml {
  const { tablist } = data.bean;
  const option = (tab: string): SafeHtml => html`
\t\t\t\t\t\t\t\t\t<option value="${raw(tab)}"${raw(listHasNoCase(tablist, tab) ? ' selected' : '')}>
\t\t\t\t\t\t\t\t\t\t${label(`sitemanager.content.tabs.${tab.replace(/[^\\\w]/g, '')}`)}
\t\t\t\t\t\t\t\t\t</option>
\t\t\t\t\t\t\t\t`;
  return html`
\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t\t${label('user.tablist')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t<select name="tablist" multiple="multiple">
\t\t\t\t\t\t\t\t<option value=""${raw(tablist.length === 0 ? ' selected' : '')}>All</option>
\t\t\t\t\t\t\t\t${cfListToArray(CONTENT_TAB_LIST).map(option)}
\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t</div>
\t\t\t\t\t`;
}

/** The Basic pane's block: group type, subtype, name, email and tab assignments. */
function renderBasicBlock(parts: ViewParts, hasTabs: boolean): SafeHtml {
  const { data, rb, label } = parts;
  const { bean } = data;
  const perm = cfToBoolean(bean.perm);
  const attrLabel = (key: string): SafeHtml => raw(encodeHtmlAttr(rb(key)));
  return html`
\t\t\t<div class="block block-bordered">
\t\t\t\t${hasTabs ? TABS_BLOCK_HEADER : ''}
\t\t\t
\t\t\t\t<div class="block-content">
\t\t\t\t\t
\t\t\t\t\t${renderGroupType(parts)}${renderSubTypeSelect(parts)}

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t${label('user.groupname')}
\t\t\t\t\t\t</label>
\t\t\t\t\t\t<input type="text" name="groupname" value="${raw(encodeHtml(bean.groupName))}" required="required" message="${label('user.groupnamerequired')}" ${raw(perm ? 'readonly="readonly"' : '')}>
\t\t\t\t\t</div>

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"
\t\t\t\t\t\t\t  \tdata-content="${attrLabel('user.groupemailmessage')}"
\t\t\t\t\t\t\t  \tdata-original-title="${attrLabel('user.groupemail')}">
\t\t\t\t\t\t\t\t\t${label('user.groupemail')}
\t\t\t\t\t\t\t\t<i class="mi-question-circle"></i>
\t\t\t\t\t\t\t</span>
\t\t\t\t\t\t</label>
\t\t\t\t\t\t<input type="text" name="email" value="${raw(encodeHtml(bean.email))}">
\t\t\t\t\t</div>

\t\t\t\t\t${perm ? '' : renderTabList(parts)}
\t\t\t\t\t<span id="extendSetsBasic"></span>
\t\t\t\t</div> <!-- /.block-content -->`;
}


/** The add, or delete and update, buttons; the tabbed form submits add and update through the global `submitForm`. */
function renderButtons({ data, rb, label }: ViewParts, hasTabs: boolean): SafeHtml {
  const submit = raw(hasTabs ? 'submitForm' : 'userManager.submitForm');
  if (data.userid === '') {
    return html`
\t\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="${submit}(document.forms.form1,'add');"><i class="mi-check-circle"></i>${label('user.add')}</button>
\t\t\t\t\t`;
  }
  return html`
\t\t\t\t\t\t<button type="button" class="btn" onclick="submitForm(document.forms.form1,'delete','${raw(jsStringFormat(rb('user.deletegroupconfirm')))}');"><i class="mi-trash"></i>${label('user.delete')}</button>
\t\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="${submit}(document.forms.form1,'update');"><i class="mi-check-circle"></i>${label('user.update')}</button>
\t\t\t\t\t`;
}

/** The `mura-actions` block: buttons, the hidden write fields and the CSRF pair of the group id. */
function renderActions(parts: ViewParts, hasTabs: boolean): SafeHtml {
  const { data, url, csrf } = parts;
  // The tabbed branch HTML-encodes the site id, the other branch attribute-encodes it.
  const siteid = hasTabs ? encodeHtml(data.rc.siteid) : encodeHtmlAttr(data.rc.siteid);
  return html`
\t\t\t<div class="mura-actions">
\t\t\t\t<div class="form-actions">
\t\t\t\t\t${renderButtons(parts, hasTabs)}
\t\t\t\t\t<input type="hidden" name="action" value="${data.userid === '' ? 'Add' : 'Update'}">
\t\t\t\t\t<input type="hidden" name="type" value="1">
\t\t\t\t\t<input type="hidden" name="contact" value="0">
\t\t\t\t\t<input type="hidden" name="siteid" value="${raw(siteid)}">
\t\t\t\t\t<input type="hidden" name="returnurl" value="${url('cUsers.list', `ispublic=${data.tempIsPublic}`)}">
\t\t\t\t\t${nonDefaultSubTypes(data).length === 0 ? SUBTYPE_DEFAULT_FIELD : ''}${csrf}
\t\t\t\t</div>
\t\t\t</div>`;
}

/** The form's tail after the Basic block: the tab panes with the extended-attribute loader, or the plain actions. */
function renderFormTail(parts: ViewParts, hasTabs: boolean): SafeHtml {
  const { data, context } = parts;
  if (!hasTabs) {
    return html`
\t\t\t <!-- /.block-content -->${renderActions(parts, false)}
\t\t`;
  }
  const { bean } = data;
  return html`
\t\t\t\t</div> <!-- / tabBasic -->\t\t
\t\t\t</div> <!-- /.tab-content block-content -->

\t\t\t\t${EXTENDED_ATTRIBUTES_PANE}

\t\t\t</div> <!-- /.block-content.tab-content -->
\t\t${renderActions(parts, true)}

\t\t\t
\t\t\t\t<script type="text/javascript">
\t\t\t\t\tuserManager.loadExtendedAttributes('${raw(bean.userId)}','1','${raw(bean.subType)}','${raw(data.userPoolId)}','${raw(context)}','${raw(data.themeAssetPath)}');
\t\t\t\t</script>
\t\t\t`;
}

/** The view body inside `#mura-content`, and its `cfhtmlhead` texts. */
export function renderEditGroup(ctx: ScreenContext, data: EditGroupData): ShellView {
  const { bean } = data;
  const rb = (key: string): string => ctx.rb.rbKey(key);
  const ses = { ses: ctx.req.ses };
  const parts: ViewParts = {
    data,
    rb,
    label: (key) => raw(rb(key)),
    url: (action, queryString = '') => raw(buildUrl(action, undefined, queryString, ses)),
    csrf: ctx.csrf.render(bean.userId, 'form'),
    context: legacySettings().context,
  };
  const hasTabs = data.subTypes.length > 0;
  const errors = Object.keys(bean.errors).length === 0
    ? ''
    : html`
\t\t<div class="alert alert-error"><span>${displayErrors(bean.errors)}</span></div>
\t`;
  const body = html`${data.rc.isAdmin ? GROUP_TYPE_RELOAD : ''}${renderHeader(parts)}

\t
\t${errors}

\t<form novalidate="novalidate" action="${parts.url('cUsers.update', `userid=${bean.userId}`)}" enctype="multipart/form-data" method="post" name="form1" onsubmit="return userManager.submitForm(this);">

\t\t<div class="block block-constrain">

\t\t\t${hasTabs ? renderTabsOpen(rb) : ''}
${renderBasicBlock(parts, hasTabs)}

\t\t${renderFormTail(parts, hasTabs)}

\t\t <!-- /.block-bordered -->
\t\t</div> <!-- /.block-constrain -->
\t</form>
\t
`;
  return { body, htmlHead: editGroupHtmlHead(ctx) };
}

/** `cUsers.editGroup`, owned by identity, behind the cUsers `before()` gate. */
export const editGroupScreen: PageScreen<EditGroupData> = Object.freeze({
  circuit: 'cusers',
  action: 'editgroup',
  owner: 'identity',
  mode: 'page',
  gate: cusersGate,
  load: (ctx: ScreenContext) => loadEditGroup(ctx),
  render: renderEditGroup,
});

