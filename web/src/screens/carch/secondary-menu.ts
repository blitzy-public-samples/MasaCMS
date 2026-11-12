// The carch secondary menu of `carch/dsp_secondary_menu.cfm`, placed by the carch views and the shell's `carch` hook (server-only).
import { cfEq, cfListToArray, javaTrim, type AdminParam } from '@opt2/platform/legacy-compat';
import type { CsrfRenderer } from '@/lib/csrf';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest, RequestContext } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { relativeAdminUrl, type RelativeAdminPrefix, type RelativeAdminUrlOptions } from '@/lib/urls';
import type { ShellHooks } from '@/shell/types';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  NODE_LEVEL_LIST,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
  isS2IsPrivate,
  isSiteAdminOrS2,
  lockState,
  type CarchStats,
  type NodePerm,
} from './model';

/** One `getHasManyPropArray()`/`getHasOnePropArray()` entry of the content entity. */
export interface CarchScaffoldProp {
  /** The related entity's bean name (`i.cfc`). */
  readonly cfc: string;
  readonly scaffold?: boolean;
  /** `pluralizeHasRefName(getEntityDisplayName())` of the related bean. */
  readonly pluralName: string;
  /** `getEntityDisplayName()` of the related bean. */
  readonly displayName: string;
}

/** `rc.contentBean` as the including view loaded it; URLs as strategies-content builds them. */
export interface CarchMenuContent {
  /** `getIsNew()`; the bean's `exists()` is its negation. */
  readonly isNew: boolean;
  readonly type: string;
  readonly subType: string;
  readonly active: number;
  readonly filename: string;
  readonly contentHistId: string;
  readonly parentId: string;
  readonly menuTitle: string;
  readonly remoteUrl: string;
  readonly fileId: string;
  /** `getStats()`. */
  readonly stats: CarchStats;
  /** `getURL()`. */
  readonly url?: string;
  /** `getURL(secure=<request is HTTPS>, complete=1, queryString='previewid=<contentHistID>')`. */
  readonly previewUrl?: string;
  /** `getEditURL(compactDisplay=rc.compactDisplay)`. */
  readonly editUrl?: string;
  /** Defaults to none, as `application.objectMappings` holds none for content. */
  readonly hasManyProps?: readonly CarchScaffoldProp[];
  readonly hasOneProps?: readonly CarchScaffoldProp[];
}

/** What the menu reads besides the request; a value the reached branch needs but lacks throws, as CFML does. */
export interface CarchSecondaryMenuInput {
  /** The view's `rc` after the carch controller ran; defaults to the request's `rc`. */
  readonly rc?: RequestContext;
  /** `rc.contentBean`; absent where the view leaves it undefined. */
  readonly content?: CarchMenuContent;
  /** `rc.perm`, the node verdict strategies-content computed. */
  readonly perm?: NodePerm;
  /** `rc.deletable`, as the including view computed it. */
  readonly deletable?: boolean;
  /** `nodeLevelList`; defaults to the list every including view defines. */
  readonly nodeLevelList?: readonly string[];
  /** `$.siteConfig('hasLockableNodes')`, read with `rc.contentBean`. */
  readonly hasLockableNodes?: boolean;
  /** `rc.$.useLayoutManager()` of the site's content renderer. */
  readonly useLayoutManager?: boolean;
  /** configBean `getPurgeDrafts()`. */
  readonly purgeDrafts?: boolean;
  /** configBean `getValue('allowSimpleHTMLForms')`. */
  readonly allowSimpleHTMLForms?: boolean;
  /** settingsBean `getResourcePath(complete=1)` of `rc.siteid`. */
  readonly resourcePath?: string;
  /** `contentManager.getActiveContent(rc.homeid, rc.siteid).getURL()`, read when `rc.homeid` is non-empty. */
  readonly homeUrl?: string;
}

/** Request, labels and CSRF tokens the menu renders with; a `ScreenContext` satisfies it. */
export interface CarchMenuContext {
  readonly req: AdminRequest;
  readonly rb: RbLookup;
  readonly csrf: Pick<CsrfRenderer, 'render'>;
}

/** The `cfswitch rc.moduleid` case of the Components, Forms and Variations modules. */
const MODULE_CASE = Object.freeze([COMPONENT_MODULE_ID, FORM_MODULE_ID, VARIATION_MODULE_ID]);

/** Content types whose default-case edit menu links the front-end preview. */
const PREVIEW_TYPES = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery', 'Link']);

/** The default-case edit menu's Export and Import links: a bare `?muraAction=` and `&amp;` separators. */
const EXPORT_IMPORT_URL: RelativeAdminUrlOptions = Object.freeze({ html: true, prefix: '?' });

const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one UTF-16 unit. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

// ACF whitespace management writes whitespace-only template text as one space after non-whitespace output and as
// nothing after whitespace. Every such text in this view follows whitespace except after the labels passed here.
/** `value` followed by the space the whitespace-only text after it prints. */
function thenSpace(value: string): string {
  return value !== '' && !isJavaWhitespace(value.slice(-1)) ? `${value} ` : value;
}

/** CFML `value eq 'true'` (`word` 1) or `eq 'false'` (`word` 0): boolean words and numbers compare by truth value. */
function eqBoolean(value: string, word: 0 | 1): boolean {
  const text = javaTrim(value).toLowerCase();
  if (text === 'true' || text === 'yes') return word === 1;
  if (text === 'false' || text === 'no') return word === 0;
  return cfEq(value, String(word));
}

/** CFML `cfcase value="a,b"` (and `listFindNoCase`) match of `value`. */
const matchesAny = (value: string, candidates: readonly string[]): boolean =>
  candidates.some((candidate) => cfEq(value, candidate));

/** `rc[name]` by case-insensitive key, as a CFML scope reads it; undefined when absent. */
function rcValue(rc: RequestContext, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** `rc[name]`; throws as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const value = rcValue(rc, name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** `value`, or the TypeError CFML raises for the undefined `rc.<name>` or the unsupplied value `name` names. */
function defined<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value;
  const element = /^rc\.(\w+)$/.exec(name)?.[1];
  throw new TypeError(
    element === undefined ? `${name} is undefined.` : `Element ${element.toUpperCase()} is undefined in RC.`,
  );
}

/** The CSRF contexts the menu renders url tokens for, to prefetch before the synchronous render. */
export function carchSecondaryMenuCsrfContexts(rc: RequestContext): string[] {
  const contentId = rcText(rc, 'contentid');
  return [`${contentId}deleteall`, `${rcText(rc, 'contenthistid')}delete`, `${contentId}deletehistall`];
}

/** Values and lookups one render reads, resolved as the view's top lines and `rc` reads resolve them. */
interface MenuScope {
  readonly ctx: CarchMenuContext;
  readonly input: CarchSecondaryMenuInput;
  readonly moduleId: string;
  /** `rc.originalfuseaction`: `listLast(request.action, '.')`. */
  readonly fuseaction: string;
  /** `rc.compactDisplay neq 'true'`. */
  readonly notCompact: boolean;
  /** `listFind(memberships, 'Admin;<private pool>;0') or listFind(memberships, 'S2')`. */
  readonly siteAdminOrS2: boolean;
  /** `rc[name]`; throws when undefined. */
  text(name: string): string;
  /** `rc[name]`, undefined when absent. */
  optional(name: string): string | undefined;
  label(key: string): string;
  /** `rc.$.renderCSRFTokens(context=…, format='url')`. */
  csrf(context: string): string;
  content(): CarchMenuContent;
  perm(): NodePerm;
  deletable(): boolean;
  /** `not isLockedBySomeoneElse`. */
  unlocked(): boolean;
}

/** `rc.perm neq 'none' and application.configBean.getPurgeDrafts()`. */
const canPurge = (m: MenuScope): boolean =>
  !cfEq(m.perm(), 'none') && defined(m.input.purgeDrafts, 'application.configBean.getPurgeDrafts()');

/** The back-to-module label of the 003/004/099 edit and history cases. */
function backToModuleLabel(m: MenuScope): string {
  if (cfEq(m.moduleId, COMPONENT_MODULE_ID)) return m.label('sitemanager.backtocomponents');
  if (cfEq(m.moduleId, VARIATION_MODULE_ID)) return m.label('sitemanager.backtovariations');
  return m.label('sitemanager.backtoforms');
}

/** The delete-content confirmation: recursive for node-level types, with the menu title as `{1}`. */
function deleteContentConfirm(m: MenuScope): string {
  const content = m.content();
  const nodeLevelList = m.input.nodeLevelList ?? NODE_LEVEL_LIST;
  const message = matchesAny(content.type, nodeLevelList)
    ? m.ctx.rb.messageFormat(m.label('sitemanager.content.deletecontentrecursiveconfirm'), content.menuTitle)
    : m.label('sitemanager.content.deletecontentconfirm');
  return `onclick="return confirmDialog('${encodeJs(message)}',this.href)"`;
}

/** `[name, rc[name]]` per name in order, URL-encoded by the builder as `esapiEncode('url', rc[name])`. */
const rcParams = (m: MenuScope, ...names: string[]): AdminParam[] => names.map((name) => [name, m.text(name)]);

/** `type`, `parentid`, `topid`, `siteid`, `startrow` and `moduleid`, the node query most items carry after the content id. */
const nodeQuery = (m: MenuScope): AdminParam[] =>
  rcParams(m, 'type', 'parentid', 'topid', 'siteid', 'startrow', 'moduleid');

/** `rc.compactdisplay` as the `compactDisplay` parameter. */
const compactParam = (m: MenuScope): AdminParam => ['compactDisplay', m.text('compactdisplay')];

/** The module's list, the module being its top, parent and module id. */
const moduleListUrl = (m: MenuScope): string =>
  relativeAdminUrl('cArch', 'list', [
    ...rcParams(m, 'siteid'),
    ['topid', m.text('moduleid')],
    ['parentid', m.text('moduleid')],
    ...rcParams(m, 'moduleid'),
  ]);

/** Site Manager's list; `prefix` is the text the item writes before `muraAction=`. */
const siteManagerUrl = (m: MenuScope, prefix: RelativeAdminPrefix = './?'): string =>
  relativeAdminUrl('cArch', 'list', [...rcParams(m, 'siteid'), ['moduleid', CONTENT_MODULE_ID, 'raw']], { prefix });

/** The node's Version History link; `html` separates its parameters with `&amp;`. */
const historyUrl = (m: MenuScope, html = false): string =>
  relativeAdminUrl('cArch', 'hist', [...rcParams(m, 'contentid'), ...nodeQuery(m), compactParam(m)], { html });

/** The Audit Trail link of version `contentHistId`, unencoded as legacy prints it; `html` as in {@link historyUrl}. */
const auditUrl = (m: MenuScope, contentHistId: string, html = false): string =>
  relativeAdminUrl(
    'cArch',
    'audit',
    [...rcParams(m, 'contentid'), ['contenthistid', contentHistId, 'raw'], ...nodeQuery(m), compactParam(m)],
    { html },
  );

/** The Delete Version link and its CSRF tokens, `rc.return` encoded as `returnEncoding`. */
const deleteVersionUrl = (m: MenuScope, returnEncoding: 'url' | 'raw'): string =>
  relativeAdminUrl('cArch', 'update', [
    ...rcParams(m, 'contenthistid'),
    ['action', 'delete'],
    ...rcParams(m, 'contentid'),
    ...nodeQuery(m),
    ['return', m.text('return'), returnEncoding],
  ]) + m.csrf(`${m.text('contenthistid')}delete`);

/** The Delete Content link and its CSRF tokens; `compact` adds `compactDisplay` before the tokens. */
const deleteAllUrl = (m: MenuScope, compact = false): string =>
  relativeAdminUrl('cArch', 'update', [
    ['action', 'deleteall'],
    ...rcParams(m, 'contentid'),
    ...nodeQuery(m),
    ...(compact ? [compactParam(m)] : []),
  ]) + m.csrf(`${m.text('contentid')}deleteall`);

/** The Clear Version History link and its CSRF tokens. */
const clearHistoryUrl = (m: MenuScope): string =>
  relativeAdminUrl('cArch', 'update', [
    ['action', 'deletehistall'],
    ...rcParams(m, 'contentid'),
    ...nodeQuery(m),
    compactParam(m),
  ]) + m.csrf(`${m.text('contentid')}deletehistall`);

/** The Permissions item with the bean's type and parent id, unencoded as legacy prints them, indented by `indent`. */
function beanPermissionsItem(m: MenuScope, indent: string): string {
  const content = m.content();
  const href = relativeAdminUrl('cPerm', 'main', [
    ...rcParams(m, 'contentid'),
    ['type', content.type, 'raw'],
    ['parentid', content.parentId, 'raw'],
    ...rcParams(m, 'topid', 'siteid', 'moduleid', 'startrow'),
  ]);
  return `\n${indent}<li><a href="${href}"><i class="mi-group"></i> ${m.label('sitemanager.content.permissions')}</a></li>\n${indent.slice(1)}`;
}

/** The S2IsPrivate Manage Data link of a Form, as a button (`edit`) or a list item (`hist`), indented by `indent`. */
function manageDataLink(m: MenuScope, indent: string, item: boolean): string {
  const href = relativeAdminUrl('cArch', 'datamanager', [
    ...rcParams(m, 'contentid', 'siteid', 'topid', 'moduleid'),
    ['type', 'Form'],
    ['parentid', m.text('moduleid')],
  ]);
  const label = `<i class="mi-wrench"></i> ${m.label('sitemanager.content.managedata')}</a></li>`;
  // The button form keeps legacy's stray `</li>`.
  return item ? `\n${indent}<li><a href="${href}">${label}\n${indent}` : `\n${indent}<a class="btn" href="${href}">${label}\n${indent}`;
}

/** The Export and Import items of a saved Form or Component, legacy-served actions of `circuit` linked as legacy links them. */
function exportImportItems(m: MenuScope, circuit: string, exportAction: string, importAction: string): string {
  const exportNode = encodeHtml(m.label('sitemanager.content.exportnode'));
  const importNode = encodeHtml(m.label('sitemanager.content.importnode'));
  return `\n\t\t\t\t\t\t\t<li><a href="${relativeAdminUrl(circuit, exportAction, rcParams(m, 'contentid'))}"><i class="mi-save"></i>  ${exportNode}</a></li>\n\t\t\t\t\t\t\t<li><a href="${relativeAdminUrl(circuit, importAction)}"><i class="mi-upload"></i>  ${importNode}</a></li>\n\t\t\t\t\t\t`;
}

/** `cfcase value="list"` of the module case. */
function moduleList(m: MenuScope): string {
  if (cfEq(m.perm(), 'none')) return '';
  const query: AdminParam[] = [
    ['topid', m.text('topid')],
    ['parentid', m.text('topid')],
    ...rcParams(m, 'siteid', 'moduleid'),
  ];
  // The new item's empty `contentid` precedes the query.
  const addUrl = (type: string, ...rest: AdminParam[]): string =>
    relativeAdminUrl('cArch', 'edit', [['type', type], ['contentid', '', 'raw'], ...query, ...rest]);
  let out = '';
  if (cfEq(m.moduleId, COMPONENT_MODULE_ID)) {
    out += `\n\t\t\t\t\t\t\t<a class="btn" href="${addUrl('Component')}"><i class="mi-plus-circle"></i> ${m.label('sitemanager.addcomponent')}</a>\n\t\t\t\t\t\t`;
  } else if (!cfEq(m.moduleId, VARIATION_MODULE_ID)) {
    out += `\n\t\t\t\t\t\t\t<a class="btn" href="${addUrl('Form', ['formType', 'builder'])}"><i class="mi-plus-circle"></i> ${m.label('sitemanager.addformwithbuilder')}</a>\n\t\t\t\t\t\t\t`;
    if (defined(m.input.allowSimpleHTMLForms, "application.configBean.getValue('allowSimpleHTMLForms')")) {
      out += `\n\t\t\t\t\t\t\t<a class="btn" href="${addUrl('Form', ['formType', 'editor'])}"><i class="mi-plus-circle"></i> ${m.label('sitemanager.addformwitheditor')}</a>\n\t\t\t\t\t\t\t`;
    }
  }
  if (m.siteAdminOrS2) {
    const permissions = relativeAdminUrl('cPerm', 'main', [
      ['contentid', m.text('moduleid')],
      ...rcParams(m, 'topid', 'siteid', 'moduleid', 'startrow'),
    ]);
    // Legacy's `active` test compares the fuseaction with `main` inside the `list` case, so only the space remains.
    out += `\n\t\t\t\t\t\t\t<a class="btn " href="${permissions}"><i class="mi-group"></i> Permissions</a>\n\t\t\t\t\t\t`;
  }
  return out;
}

/** `cfcase value="datamanager"` of the module case. */
function moduleDatamanager(m: MenuScope): string {
  const forms = '00000000000000000000000000000000004';
  /** `contentid`, `type=Form`, `action` when given, then the forms module as top, module and parent id. */
  const formQuery = (...action: AdminParam[]): AdminParam[] => [
    ...rcParams(m, 'contentid'),
    ['type', 'Form'],
    ...action,
    ['topid', forms, 'raw'],
    ...rcParams(m, 'siteid'),
    ['moduleid', forms, 'raw'],
    ['parentid', forms, 'raw'],
  ];
  const back = moduleListUrl(m);
  const history = relativeAdminUrl('cArch', 'hist', [
    ...rcParams(m, 'contentid'),
    ['type', 'Form'],
    ['parentid', forms, 'raw'],
    ['topid', forms, 'raw'],
    ...rcParams(m, 'siteid', 'startrow'),
    ['moduleid', forms, 'raw'],
  ]);
  let out = `\n\t\t\t\t<a class="btn" href="${back}"><i class="mi-arrow-circle-left"></i>\n\t\t\t\t\t\t${m.label('sitemanager.backtoforms')}\n\t\t\t\t\t</a>\n\t\t\t\t<a class="btn" href="${history}"><i class="mi-history"></i> ${m.label('sitemanager.content.versionhistory')}</a>\n\t\t\t\t`;
  if (!cfEq(m.text('action'), '')) {
    out += `\n\t\t\t\t<a class="btn" title="${m.label('sitemanager.content.managedate')}" href="${relativeAdminUrl('cArch', 'datamanager', formQuery())}"><i class="mi-wrench"></i> ${m.label('sitemanager.content.managedata')}</a>\n\t\t\t\t`;
  }
  if (cfEq(m.perm(), 'editor') && m.unlocked()) {
    const editDisplay = m.label('sitemanager.content.editdisplay');
    out += `\n\t\t\t\t<a class="btn" title="${editDisplay}" href="${relativeAdminUrl('cArch', 'datamanager', formQuery(['action', 'display']))}"><i class="mi-pencil"></i> ${editDisplay}</a>\n\t\t\t\t<a class="btn" title="${m.label('sitemanager.content.delete')}" href="${relativeAdminUrl('cArch', 'update', formQuery(['action', 'deleteall']))}${m.csrf(`${m.text('contentid')}deleteall`)}" onClick="return confirmDialog('${encodeJs(m.label('sitemanager.content.deleteformconfirm'))}',this.href)"><i class="mi-trash"></i> ${m.label('sitemanager.content.deleteform')}</a>\n\t\t\t\t`;
  }
  if (m.siteAdminOrS2) {
    const permissions = relativeAdminUrl('cPerm', 'main', [
      ...rcParams(m, 'contentid'),
      ['type', 'Form'],
      ['parentid', forms, 'raw'],
      ['topid', forms, 'raw'],
      ...rcParams(m, 'siteid'),
      ['moduleid', forms, 'raw'],
      ...rcParams(m, 'startrow'),
    ]);
    out += `\n\t\t\t\t\t<a class="btn" href="${permissions}"><i class="mi-group"></i> ${m.label('sitemanager.content.permissions')}</a>\n\t\t\t\t`;
  }
  return out;
}

/** `cfcase value="edit,update"` of the module case. */
function moduleEdit(m: MenuScope): string {
  const { req } = m.ctx;
  let started = false;
  let out = '';
  if (m.notCompact) {
    started = true;
    out += `\n\t\t\t\t\t<a class="btn" href="${moduleListUrl(m)}"><i class="mi-arrow-circle-left"></i>\n\t\t\t\t\t${thenSpace(backToModuleLabel(m))}\n\t\t\t\t\t</a>\n\t\t\t\t\t`;
  }
  const content = m.content();
  if (content.isNew) return out;
  if (cfEq(m.text('type'), 'Form') && isS2IsPrivate(req)) {
    started = true;
    out += manageDataLink(m, '\t\t\t\t\t\t\t', false);
  }
  if (started) out += '\n\t\t\t\t\t\t<div class="btn-group">\n\t\t\t\t\t\t';
  out += '\n\t\t\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n\t\t\t\t\t\t\t    <i class="mi-cogs"></i> Actions\n\t\t\t\t\t\t\t    <span class="caret"></span>\n\t\t\t\t\t\t\t  </a>\n\t\t\t\t\t \t <ul class="dropdown-menu">\n\t\t\t\t\t \t ';
  if (cfEq(m.text('type'), 'Variation')) {
    out += `\n\t\t\t\t\t \t \t<li><a href="${encodeUrl(`${content.remoteUrl}?previewid=${content.contentHistId}`)}"><i class="mi-eye"></i> ${m.label('sitemanager.content.viewversion')}</a></li>\n\t\t\t\t\t \t `;
  }
  out += `\n\t\t\t\t\t\t <li><a href="${historyUrl(m)}"><i class="mi-history"></i> ${m.label('sitemanager.content.versionhistory')}</a></li>\n\t\t\t\t\t\t<li><a href="${auditUrl(m, content.contentHistId)}"><i class="mi-sitemap"></i> ${m.label('sitemanager.content.audittrail')}</a></li>\n\t\t\t\t\t\t`;
  // Legacy's `and` binds tighter than `or`: purge permission, super user or admin user, then the lock.
  if (
    m.notCompact &&
    content.active < 1 &&
    (canPurge(m) || req.isS2 || req.isSiteAdmin) &&
    m.unlocked()
  ) {
    out += `\n\t\t\t\t\t\t\t<li><a href="${deleteVersionUrl(m, 'url')}" onclick="return confirmDialog('${encodeJs(m.label('sitemanager.content.deleteversionconfirm'))}',this.href)"><i class="mi-trash"></i> ${m.label('sitemanager.content.deleteversion')}</a></li>\n\t\t\t\t\t\t`;
  }
  if (m.siteAdminOrS2) out += beanPermissionsItem(m, '\t\t\t\t\t\t\t');
  if (m.deletable() && m.unlocked()) {
    out += `\n\t\t\t\t\t\t\t<li><a href="${deleteAllUrl(m)}"\n\t\t\t\t\t\t\t${deleteContentConfirm(m)}><i class="mi-trash"></i>  ${m.label('sitemanager.content.deletecontent')}</a></li>\n\t\t\t\t\t\t`;
  }
  if (cfEq(content.type, 'Form') && !content.isNew) out += exportImportItems(m, 'cForm', 'export', 'importform');
  if (cfEq(content.type, 'Component') && !content.isNew) {
    out += exportImportItems(m, 'cArch', 'exportcomponent', 'importcomponent');
  }
  out += '\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t';
  if (started) out += '\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t';
  return out;
}

/** `cfcase value="hist,audit"` of the module case. */
function moduleHistory(m: MenuScope): string {
  const { req } = m.ctx;
  let out = `\n\t\t\t\t\t<a class="btn" href="${moduleListUrl(m)}"><i class="mi-arrow-circle-left"></i>\n\t\t\t\t\t\t${thenSpace(backToModuleLabel(m))}\n\t\t\t\t\t</a>\n\t\t\t\t\t`;
  if (m.content().isNew) return out;
  out += '\n\t\t\t\t\t<div class="btn-group">\n\t\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n\t\t\t\t\t\t\t<i class="mi-cogs"></i> Actions\n\t\t\t\t\t\t\t<span class="caret"></span>\n\t\t\t\t\t\t  </a>\n\t\t\t\t\t  <ul class="dropdown-menu drop-right">\n\n\n\t\t\t\t\t';
  if (cfEq(m.text('type'), 'Form') && isS2IsPrivate(req)) out += manageDataLink(m, '\t\t\t\t\t\t', true);
  if (cfEq(m.fuseaction, 'hist')) {
    if ((canPurge(m) || m.siteAdminOrS2) && m.unlocked()) {
      out += `\n\t\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t\t<a href="${clearHistoryUrl(m)}" onclick="return confirmDialog('${encodeJs(m.label('sitemanager.content.clearversionhistoryconfirm'))}',this.href)">\n\t\t\t\t\t\t\t\t\t<i class="mi-eraser"></i> ${m.label('sitemanager.content.clearversionhistory')}\n\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t`;
    }
  } else {
    out += `\n\t\t\t\t\t\t<li><a href="${historyUrl(m)}"><i class="mi-history"></i> ${m.label('sitemanager.content.versionhistory')}</a></li>\n\t\t\t\t\t`;
  }
  if (m.deletable() && m.unlocked()) {
    out += `\n\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t<a href="${deleteAllUrl(m)}"\n\t\t\t\t\t\t\t\t${deleteContentConfirm(m)}>\n\t\t\t\t\t\t\t\t<i class="mi-trash"></i> ${m.label('sitemanager.content.deletecontent')}\n\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t</li>\n\t\t\t\t\t`;
  }
  if (m.siteAdminOrS2) out += beanPermissionsItem(m, '\t\t\t\t\t\t');
  return `${out}\n\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\t\t\t\t\t`;
}

/** The scaffolded related-entity items of the content entity; `withName` adds the singular name (`hasOne`). */
function scaffoldItems(m: MenuScope, props: readonly CarchScaffoldProp[], indent: string, withName: boolean): string {
  return props
    .filter((prop) => prop.scaffold === true)
    .map((prop) => {
      const plural = encodeHtml(prop.pluralName);
      // The singular name is printed unencoded, as legacy prints it.
      const name = withName ? `${thenSpace(plural)}${prop.displayName}` : plural;
      const href = relativeAdminUrl('cArch', 'list', [
        ['activeTab', '2'],
        ['entityid', m.text('contentid')],
        ['entityname', 'content'],
        ...rcParams(m, 'siteid'),
        ['relatesto', prop.cfc],
      ]);
      return `\n${indent}<li><a href="${href}"><i class="mi-cube"></i> ${name}</a></li>\n\t\t\t\t\t\t`;
    })
    .join('');
}

/** `cfcase value="edit,update"` of the default case. */
function defaultEdit(m: MenuScope): string {
  if (cfEq(m.text('contentid'), '')) return '';
  const content = m.content();
  const viewVersion = (): string => m.label('sitemanager.content.viewversion');
  let out =
    '\n\t\t\t\t<div class="btn-group">\n\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n\t\t\t\t\t    <i class="mi-cogs"></i> Actions\n\t\t\t\t\t    <span class="caret"></span>\n\t\t\t\t\t  </a>\n\t\t\t\t\t  <ul class="dropdown-menu drop-right">\n\t\t\t\t';
  if (!cfEq(content.filename, '') || cfEq(m.text('contentid'), ROOT_CONTENT_ID)) {
    const type = m.text('type');
    if (matchesAny(type, PREVIEW_TYPES)) {
      out += `\n\t\t\t\t\t\t<li><a href="${defined(content.previewUrl, 'rc.contentBean.getURL(complete=1)')}"><i class="mi-eye"></i> ${viewVersion()}</a></li>\n\t\t\t\t\t`;
    } else if (cfEq(type, 'File')) {
      // Legacy writes the href attribute twice.
      out += `\n\t\t\t\t\t\t<li><a href="#" href="#" onclick="return preview('${defined(m.input.resourcePath, 'getResourcePath(complete=1)')}/index.cfm/_api/render/file/?fileID=${content.fileId}');"><i class="mi-eye"></i> ${viewVersion()}</a></li>\n\t\t\t\t\t`;
    }
  }
  // These items separate their query parameters with `&amp;`; Export and Import (legacy-served) start at `?muraAction=`.
  out += `\n\n\t\t\t\t\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${historyUrl(m, true)}">\n\t\t\t\t\t\t<i class="mi-history"></i> ${m.label('sitemanager.content.versionhistory')}\n\t\t\t\t\t</a>\n\t\t\t\t</li>\n\n\t\t\t\t\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${auditUrl(m, content.contentHistId, true)}">\n\t\t\t\t\t\t<i class="mi-sitemap"></i> ${m.label('sitemanager.content.audittrail')}\n\t\t\t\t\t</a>\n\t\t\t\t</li>\n\n\t\t\t\t\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${relativeAdminUrl('cArch', 'export', rcParams(m, 'siteid', 'contentid'), EXPORT_IMPORT_URL)}">\n\t\t\t\t\t\t<i class="mi-sign-out"></i> ${encodeHtml(m.label('sitemanager.content.exportnode'))}\n\t\t\t\t\t</a>\n\t\t\t\t</li>\n\n\t\t\t\t\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${relativeAdminUrl('cArch', 'import', rcParams(m, 'contentid', 'moduleid', 'siteid'), EXPORT_IMPORT_URL)}">\n\t\t\t\t\t\t<i class="mi-sign-in"></i> ${encodeHtml(m.label('sitemanager.content.importnode'))}\n\t\t\t\t\t</a>\n\t\t\t\t</li>\n\n\t\t\t\t`;
  if (m.notCompact && content.active < 1 && !cfEq(m.perm(), 'none') && m.unlocked()) {
    // `rc.return` is printed unencoded here, as legacy prints it (a pre-existing defect reproduced, not fixed).
    out += `\n\t\t\t\t\t<li><a href="${deleteVersionUrl(m, 'raw')}" onclick="return confirmDialog('${encodeJs(m.label('sitemanager.content.deleteversionconfirm'))}',this.href)"><i class="mi-trash"></i> ${m.label('sitemanager.content.deleteversion')}</a></li>\n\t\t\t\t`;
  }
  if (m.siteAdminOrS2) out += beanPermissionsItem(m, '\t\t\t\t\t');
  if (m.deletable() && m.unlocked()) {
    out += `\n\t\t\t\t\t<li><a href="${deleteAllUrl(m)}"\n\t\t\t\t\t${deleteContentConfirm(m)}><i class="mi-trash"></i> ${m.label('sitemanager.content.deletecontent')}</a></li>\n\t\t\t\t`;
  }
  out += scaffoldItems(m, content.hasManyProps ?? [], '\t\t\t\t\t\t\t\t', false);
  out += scaffoldItems(m, content.hasOneProps ?? [], '\t\t\t\t\t\t\t', true);
  return `${out}\n\t\t\t\t</ul>\n\t\t\t\t</div>\n\n\n\t\t\t`;
}

/** `cfcase value="hist,audit"` of the default case. */
function defaultHistory(m: MenuScope): string {
  let out = `\n\n\t\t\t\t<a class="btn" href="${siteManagerUrl(m)}"><i class="mi-arrow-circle-left"></i> ${m.label('sitemanager.backtositemanager')}</a>\n\t\t\t\t`;
  if (m.content().isNew) return out;
  out +=
    '\n\t\t\t\t<div class="btn-group">\n\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n\t\t\t\t\t\t<i class="mi-cogs"></i> Actions\n\t\t\t\t\t\t<span class="caret"></span>\n\t\t\t\t\t  </a>\n\t\t\t\t  <ul class="dropdown-menu drop-right">\n\t\t\t\t';
  if (cfEq(m.fuseaction, 'hist')) {
    if (!cfEq(m.perm(), 'none') && m.unlocked()) {
      out += `\n\t\t\t\t\t\t<li>\n\t\t\t\t\t\t\t<a href="${clearHistoryUrl(m)}" onclick="return confirmDialog('${encodeJs(m.label('sitemanager.content.clearversionhistoryconfirm'))}',this.href)">\n\t\t\t\t\t\t\t\t<i class="mi-eraser"></i> ${m.label('sitemanager.content.clearversionhistory')}\n\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t</li>\n\t\t\t\t\t`;
    }
  } else {
    out += `\n\t\t\t\t\t<li><a href="${historyUrl(m)}"><i class="mi-history"></i> ${m.label('sitemanager.content.versionhistory')}</a></li>\n\t\t\t\t`;
  }
  if (m.deletable() && m.notCompact && m.unlocked()) {
    out += `\n\t\t\t\t\t<li><a href="${deleteAllUrl(m, true)}"\n\t\t\t\t\t\t${deleteContentConfirm(m)} ><i class="mi-trash"></i> ${m.label('sitemanager.content.deletecontent')}</a></li>\n\t\t\t\t`;
  }
  if (m.siteAdminOrS2) {
    const permissions = relativeAdminUrl(
      'cPerm',
      'main',
      rcParams(m, 'contentid', 'type', 'parentid', 'topid', 'siteid', 'moduleid', 'startrow'),
    );
    out += `\n\t\t\t\t\t<li><a href="${permissions}"><i class="mi-group"></i> ${m.label('sitemanager.content.permissions')}</a></li>\n\t\t\t\t`;
  }
  return `${out}\n\t\t\t\t</ul>\n\t\t\t\t</div>\n\t\t\t\t`;
}

/** `cfcase value="imagedetails,multiFileUpload"` of the default case. */
function defaultFiles(m: MenuScope): string {
  const { req } = m.ctx;
  const { content } = m.input;
  if (content === undefined) {
    if (!eqBoolean(m.text('compactDisplay'), 0)) return '';
    const back = m.label('sitemanager.back');
    return `\n\t\t\t\t\t\n\t\t\t\t\t<a class="btn" href="#" title="${encodeHtmlAttr(back)}" onclick="window.history.back(); return false;"><i class="mi-arrow-circle-left"></i> ${encodeHtml(back)}</a>\n\t\t\t\t`;
  }
  if (m.notCompact) {
    let out = `\n\t\t\t\t\t\t\n\t\t\t\t\t\t<a class="btn" href="${defined(content.editUrl, 'rc.contentBean.getEditURL()')}">\n\t\t\t\t\t\t\t<i class="mi-arrow-circle-left"></i>\n\t\t\t\t\t\t\t${m.label('sitemanager.backtocontent')}\n\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\n\t\t\t\t\t\t`;
    if (isS2IsPrivate(req, m.text('siteid')) || req.isS2) {
      out += `\n\t\t\t\t\t\t\t<a class="btn" href="${siteManagerUrl(m, './?&')}">\n\t\t\t\t\t\t\t\t<i class="mi-list-alt"></i>\n\t\t\t\t\t\t\t\t${m.label('sitemanager.backtositemanager')}\n\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t`;
    }
    return out;
  }
  const viewContentUrl =
    (m.optional('homeid') ?? '') !== ''
      ? defined(m.input.homeUrl, 'application.contentManager.getActiveContent(rc.homeid).getURL()')
      : defined(content.url, 'rc.contentBean.getURL()');
  return `\n\t\t\t\t\t\t<a class="btn" href="#" onclick="frontEndProxy.post({cmd:'setLocation',location:'${encodeJs(viewContentUrl)}'}); return false;">\n\t\t\t\t\t\t\t<i class="mi-globe"></i>\n\t\t\t\t\t\t\t${m.label('sitemanager.viewcontent')}\n\t\t\t\t\t\t</a>\n\t\t\t\t\t`;
}

/** The `cfswitch rc.originalfuseaction` of the Components, Forms and Variations modules. */
function moduleCase(m: MenuScope): string {
  if (cfEq(m.fuseaction, 'list')) return moduleList(m);
  if (cfEq(m.fuseaction, 'datamanager')) return moduleDatamanager(m);
  if (matchesAny(m.fuseaction, ['edit', 'update'])) return moduleEdit(m);
  if (matchesAny(m.fuseaction, ['hist', 'audit'])) return moduleHistory(m);
  return '';
}

/** The `cfswitch rc.originalfuseaction` of every other module. */
function defaultCase(m: MenuScope): string {
  if (matchesAny(m.fuseaction, ['edit', 'update'])) return defaultEdit(m);
  if (matchesAny(m.fuseaction, ['hist', 'audit'])) return defaultHistory(m);
  if (matchesAny(m.fuseaction, ['imagedetails', 'multiFileUpload'])) return defaultFiles(m);
  return '';
}

/**
 * The menu as the view's include emits it after whitespace: from the line break before
 * `<div class="nav-module-specific btn-group">` through the one after its `</div>`.
 * @throws TypeError When the reached branch reads an `rc` element or an input value that is undefined.
 */
export function renderCarchSecondaryMenu(ctx: CarchMenuContext, input: CarchSecondaryMenuInput): SafeHtml {
  const { req, rb } = ctx;
  const rc = input.rc ?? req.rc;
  const text = (name: string): string => rcText(rc, name);
  const { content } = input;
  // The view's top lines derive the lock flags whenever `rc.contentBean` is defined.
  const lock =
    content === undefined
      ? undefined
      : lockState(
          content.stats,
          { hasLockableNodes: defined(input.hasLockableNodes, "$.siteConfig('hasLockableNodes')") },
          req.session.mura.userID,
        );
  const m: MenuScope = {
    ctx,
    input,
    moduleId: text('moduleid'),
    fuseaction: cfListToArray(req.action, '.').at(-1) ?? '',
    notCompact: !eqBoolean(text('compactDisplay'), 1),
    siteAdminOrS2: isSiteAdminOrS2(req),
    text,
    optional: (name) => rcValue(rc, name),
    label: (key) => rb.rbKey(key),
    csrf: (context) => ctx.csrf.render(context, 'url').value,
    content: () => defined(content, 'rc.contentBean'),
    perm: () => defined(input.perm, 'rc.perm'),
    deletable: () => defined(input.deletable, 'rc.deletable'),
    unlocked: () => !defined(lock, 'isLockedBySomeoneElse').isLockedBySomeoneElse,
  };
  let out = '\n<div class="nav-module-specific btn-group">\n\t';
  if (!m.notCompact && !defined(input.useLayoutManager, 'rc.$.useLayoutManager()')) {
    out += `\n\t\t<a class="btn" onclick="history.go(-1);"><i class="mi-arrow-circle-left"></i>  ${m.label('collections.back')}</a>\n\t`;
  }
  out += matchesAny(m.moduleId, MODULE_CASE) ? moduleCase(m) : defaultCase(m);
  // The plugin `on…SecondaryNavRender` events render nothing here, plugins running only on legacy, and the
  // whitespace around them follows whitespace, so it prints nothing either.
  return raw(`${out}\n</div>\n`);
}

/** Views that bound their menu input, so the shell hook renders what their include renders. */
const BOUND_MENUS = new WeakMap<AdminRequest, { readonly ctx: CarchMenuContext; readonly input: CarchSecondaryMenuInput }>();

/** Makes the shell's `carch` hook render `input` for `ctx.req`, exactly as {@link renderCarchSecondaryMenu} does. */
export function bindCarchSecondaryMenu(ctx: CarchMenuContext, input: CarchSecondaryMenuInput): void {
  BOUND_MENUS.set(ctx.req, { ctx, input });
}

/** The CSRF renderer of a request no view bound, for which no tokens were fetched. */
const NO_TOKENS: Pick<CsrfRenderer, 'render'> = {
  render: (context) => {
    throw new Error(`CSRF tokens for context "${context}" have not been fetched`);
  },
};

/** The shell's `carch` hook: the bound view's menu, else the menu of a request whose view loaded no `rc.contentBean`. */
export const carchSecondaryMenu: NonNullable<ShellHooks['secondaryMenus']['carch']> = (req) => {
  const bound = BOUND_MENUS.get(req);
  return bound === undefined
    ? renderCarchSecondaryMenu({ req, rb: rbFor(req.session.rb), csrf: NO_TOKENS }, {})
    : renderCarchSecondaryMenu(bound.ctx, bound.input);
};
