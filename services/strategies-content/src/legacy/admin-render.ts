/**
 * Content admin renderers: the entry point, and the Site Manager tree, section, diff, notify and lock-check views.
 * web's app/admin-raw/[circuit]/[action]/route.ts relays these bodies for the carch, ccomments, cform and cnav fragment
 * and json actions and never re-renders them. Pure: callers pass rows and persist the returned session effects.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LegacyJsonSerializer,
  cfEq,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfParseDateTimeText,
  cfToBoolean,
  cfToNumber,
} from '@opt2/platform/legacy-compat';
import {
  esapiEncode,
  getNextN,
  isFileIcon,
  isS2,
  isSiteAdmin,
  lsDateFormat,
  lsTimeFormat,
  newContentPerm,
  nodeIconClass,
  renderCsrfTokensUrl,
  renderZoom,
  yesNoFormat,
  type AdminRenderContext,
  type AdminSessionState,
  type CustomIconLookup,
  type NodePerm,
  type ZoomCrumb,
} from './admin-markup.js';
import { cfToString, muraJsonEncode, type CfSimpleValue } from './cfjson.js';
import { getUrlStem, getWebPath, imageUrl } from './content-urls.js';
import { computeDiff } from './diff-match-patch.js';
import type { ContentRow, ContentStatsRow, FileRow } from '../repo/tables.js';

export * from './admin-render-sitemanager.js';
export * from './admin-render-edit.js';
export * from './admin-render-panels.js';
export * from './admin-render-comments.js';
export * from './admin-render-forms.js';
export type { AdminLabels, AdminSession, AdminRenderContext } from './admin-markup.js';
export { createAdminLabels } from './admin-markup.js';

/** What ACF sends for a FW/1 view that sets no content type, and after a bare `abort`. */
export const ADMIN_VIEW_CONTENT_TYPE = 'text/html;charset=UTF-8';
/** What ACF sends for `<cfcontent type="application/json; charset=utf-8">`. */
export const ADMIN_JSON_CONTENT_TYPE = 'application/json;charset=utf-8';

/** A legacy admin response; `sessionEffects` are the session writes the view makes. */
export interface AdminRenderResult {
  status: number;
  contentType: string;
  /** Markup or JSON text; bytes only for a binary download (cform.export's zip). */
  body: string | Buffer;
  /** Headers the view sets besides the content type, such as a download's `Content-disposition`. */
  headers?: Readonly<Record<string, string>>;
  sessionEffects?: Partial<AdminSessionState>;
  /** `cflocation` target; `status` is 302 and `body` empty. */
  redirect?: string;
  /** Page mode: legacy wraps `body` in the admin layout, so web's shell does. */
  layout?: true;
  /** `request.ajax`, the view's `js.cfm` output the layout prints in `<head>`. */
  ajax?: string;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** The columns of a Site Manager row the views read: the content version with its file and stats joins. */
export type SiteManagerRow = Pick<
  ContentRow,
  | 'siteid'
  | 'contentid'
  | 'contenthistid'
  | 'parentid'
  | 'moduleid'
  | 'type'
  | 'subtype'
  | 'title'
  | 'menutitle'
  | 'filename'
  | 'fileid'
  | 'display'
  | 'displaystart'
  | 'displaystop'
  | 'approved'
  | 'isnav'
  | 'inheritobjects'
  | 'template'
  | 'childtemplate'
  | 'lastupdate'
  | 'targetparams'
  | 'remoteurl'
  | 'sortby'
  | 'sortdirection'
> &
  Nullable<Pick<FileRow, 'fileext'>> & {
    /** The joined file's name (`tfiles.filename`). */
    assocfilename: FileRow['filename'];
    lockid: ContentStatsRow['lockid'];
  };

/** A `contentManager.getNest` row with the lookups dsp_nest.cfm makes for it. */
export type NestNode = SiteManagerRow &
  Pick<ContentRow, 'restricted' | 'islocked'> & {
    /** `permUtility.getPerm(contentid, siteid)`. */
    verdict: NodePerm;
    /** `contentManager.getKidsCount(contentid, siteid, false)`. */
    kidsCount: number;
    /** `getNest(contentid, session.siteid, sortby, sortdirection)` rows; read only for an open section. */
    kids?: readonly NestNode[];
  };

/** A `classExtensionManager.getExtendedAttributeList(siteid)` row. */
export interface ExtendAttributeListRow {
  type: string;
  subtype: string;
  attribute: string;
}

/** Everything loadsitemanager.cfm reads besides the render context. */
export interface SiteManagerModel {
  /** `rc.siteid`, `rc.topid` and `rc.moduleid` after carch.loadsitemanager. */
  siteId: string;
  topId: string;
  moduleId: string;
  /** `rc.type`: carch.before() defaults it to `Page`. */
  type: string;
  /** `rc.ptype`, the type argument of the pager links. */
  ptype: string;
  /** `rc.sortby` and `rc.sortdirection` as requested, '' when absent. */
  sortBy: string;
  sortDirection: string;
  /** `rc.startrow` as requested. */
  startRow: string | number;
  /** `contentManager.getlist(rc)` row. */
  rsTop: SiteManagerRow;
  /** `getCrumbList(topid, siteid)`, leaf first. */
  crumbs: readonly ZoomCrumb[];
  /** `permUtility.getnodePerm(crumbs)`. */
  perm: NodePerm;
  /** `permUtility.setRestriction(crumbs).restrict`. */
  restricted: boolean;
  /** `getKidsCount(rsTop.contentid, rsTop.siteid, false)`. */
  hasKids: number;
  /** The session user's `getContentTabAssignments()`. */
  tabAssignments: string;
  extendAttributes: readonly ExtendAttributeListRow[];
  /** `containsBean('marketingManager')`: only the MXP plugin, which runs on legacy alone, registers it. */
  hasMarketingManager: boolean;
  /** `getNest(topid, session.siteid, sortBy, sortDirection)` rows, sorted as requested or as rsTop sorts. */
  nest: readonly NestNode[];
  customIcons?: CustomIconLookup;
}

/** Everything loadsitesection.cfm and refreshsitesection.cfm read besides the render context. */
export interface SiteSectionModel {
  siteId: string;
  /** `rc.contentid`: the section. */
  sectionId: string;
  moduleId: string;
  /** `rc.sortby` and `rc.sortdirection`; legacy reads an undefined `rc.rstop` when either is empty. */
  sortBy: string;
  sortDirection: string;
  startRow: string | number;
  /** `permUtility.getnodePerm(getCrumbList(section))`. */
  perm: NodePerm;
  /** `permUtility.setRestriction(getCrumbList(section)).restrict`. */
  restricted: boolean;
  tabAssignments: string;
  /** `getNest(section, session.siteid, sortBy, sortDirection)` rows. */
  nest: readonly NestNode[];
  customIcons?: CustomIconLookup;
}

/** A `contentUtility.getNotify(crumbs)` row, in its `order by lname, fname` order. */
export interface NotifyRow {
  userid: string;
  fname: string | null;
  lname: string | null;
  /** `Editor` or `Author`. */
  type: string;
}

/** Everything loadnotify.cfm reads besides the render context. */
export interface LoadNotifyModel {
  /** `permUtility.getnodePerm(rc.crumbdata)`. */
  perm: NodePerm;
  rows: readonly NotifyRow[];
}

/** Everything loadexpirenotify.cfm reads besides the render context. */
export interface LoadExpireNotifyModel {
  rows: readonly NotifyRow[];
  /** `valueList(contentDAO.getExpireAssignments(contenthistid).userID)`. */
  assigned: string;
}

/** Everything lockcheck.cfm reads besides the render context. */
export interface LockCheckModel {
  /** `content.loadBy(contenthistid).getStats().getLockID()`. */
  lockId: string;
  /** `cgi.query_string`. */
  queryString: string;
  /** `$.event(…)` values, '' when absent. */
  destAction: string;
  contentId: string;
  siteId: string;
  contentHistId: string;
  homeId: string;
  /** `application.coreversion`. */
  coreVersion: string;
}

/** A content version as bean.compare reads it. */
export interface DiffVersion {
  /** `getLastUpdate()`. */
  lastUpdate: Date;
  /**
   * `StructKeyArray(getAllValues())` members, in that ACF iteration order ({@link acfStructKeyOrder} of the order the
   * instance received them), each with `getValue(name)`: a string, number, boolean or Date (as the date setters parse
   * it) is simple, a NULL column reads '', anything else is complex and never compared.
   */
  values: ReadonlyArray<readonly [name: string, value: unknown]>;
}

/** Properties contentBean and its bases declare `comparable="false"` (contentBean.cfc, beanExtendable.cfc, bean.cfc). */
export const CONTENT_COMPARABLE_EXCLUDED: readonly string[] = Object.freeze([
  'contentHistID',
  'contentID',
  'preserveID',
  'active',
  'approved',
  'orderno',
  'lastUpdate',
  'lastUpdateByID',
  'changesetID',
  'requestID',
  'approvalGroupID',
  'approvalChainOverride',
  'extendData',
  'extendSetID',
  'extendDataTable',
  'extendAutoComplete',
  'errors',
  'fromMuraCache',
  'instanceID',
]);

// --- CFML output and values ---

// Java Character.isWhitespace, which ACF applies to the last character it wrote.
const ENDS_IN_WHITESPACE = /[\t-\r\u001c-\u001f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/;

/**
 * One ACF 2023 output buffer under whitespace management: CFML comments vanish before text segments form; a
 * whitespace-only segment between tags or expressions prints one space unless the buffer is empty or ends in
 * whitespace; text inside `<cfswitch>` outside a case never prints.
 */
class CfOut {
  private body = '';

  /** Text holding a non-whitespace character, or expression values: printed verbatim. */
  t(...parts: string[]): this {
    for (const part of parts) this.body += part;
    return this;
  }

  /** A whitespace-only text segment. */
  ws(): this {
    if (this.body !== '' && !ENDS_IN_WHITESPACE.test(this.body)) this.body += ' ';
    return this;
  }

  toString(): string {
    return this.body;
  }
}

/** A column or request value as `#value#` prints it; NULL prints ''. */
function str(v: string | number | null | undefined): string {
  return typeof v === 'number' ? cfNumberString(v) : (v ?? '');
}

/** A column in a CFML boolean context; a NULL reads '', which legacy cannot convert either. */
function truthy(v: string | number | null): boolean {
  return cfToBoolean(v ?? '');
}

/** CFML `listFindNoCase(list, value) > 0` over a comma list. */
function listFindNoCase(list: string, value: string): boolean {
  return cfListToArray(list).some((item) => item.toLowerCase() === value.toLowerCase());
}

/** CFML `listFind(list, value)`: the 1-based position of a case-sensitive match, 0 when absent. */
function listFind(list: string, value: string): number {
  return cfListToArray(list).indexOf(value) + 1;
}

const url = (v: string | number | null): string => esapiEncode('url', v);
const attr = (v: string | number | null): string => esapiEncode('html_attr', v);
const html = (v: string | number | null): string => esapiEncode('html', v);
const js = (v: string | number | null): string => esapiEncode('javascript', v);

/** Java String.hashCode. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

type Bin = Array<readonly [key: string, hash: number]>;

/** ConcurrentHashMap.transfer for one thread: each bin splits into its low and high halves. */
function transfer(bins: readonly Bin[], n: number): Bin[] {
  const next: Bin[] = Array.from({ length: n * 2 }, () => []);
  bins.forEach((bin, i) => {
    const first = bin[0];
    if (first === undefined) return;
    // The trailing run of nodes bound for one half moves as is; the nodes before it are prepended in turn.
    let runBit = first[1] & n;
    let lastRun = 0;
    bin.forEach(([, hash], p) => {
      if ((hash & n) !== runBit) {
        runBit = hash & n;
        lastRun = p;
      }
    });
    let low: Bin = runBit === 0 ? bin.slice(lastRun) : [];
    let high: Bin = runBit === 0 ? [] : bin.slice(lastRun);
    for (const node of bin.slice(0, lastRun)) {
      if ((node[1] & n) === 0) low = [node, ...low];
      else high = [node, ...high];
    }
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/**
 * Iteration order of an ACF 2023 struct whose keys were assigned in `keys` order: a java.util.concurrent
 * ConcurrentHashMap over the upper-cased names, 16 bins grown when the count reaches three quarters of the table.
 * A repeated key keeps its first position.
 */
export function acfStructKeyOrder(keys: readonly string[]): string[] {
  let size = 16;
  let bins: Bin[] = Array.from({ length: size }, () => []);
  const seen = new Set<string>();
  for (const key of keys) {
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const h = javaHash(upper);
    const hash = (h ^ (h >>> 16)) & 0x7fffffff;
    (bins[hash & (size - 1)] as Bin).push([key, hash]);
    if (seen.size >= size - (size >>> 2)) {
      bins = transfer(bins, size);
      size *= 2;
    }
  }
  return bins.flat().map(([key]) => key);
}

/** A CF struct built by assigning `entries` in order, as a plain object whose key order is ACF's iteration order. */
function acfStruct(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const values = new Map(entries.map(([key, value]) => [key.toUpperCase(), value]));
  return Object.fromEntries(
    acfStructKeyOrder(entries.map(([key]) => key)).map((key) => [key, values.get(key.toUpperCase())]),
  );
}

/** `session.flatViewArgs[siteId].tab = tab`: a missing site entry is created, an existing `tab` keeps its spelling. */
function flatViewTab(
  flatViewArgs: AdminSessionState['flatViewArgs'],
  siteId: string,
  tab: unknown,
): AdminSessionState['flatViewArgs'] {
  const siteKey = Object.keys(flatViewArgs).find((k) => k.toLowerCase() === siteId.toLowerCase()) ?? siteId;
  const site = flatViewArgs[siteKey] ?? {};
  const tabKey = Object.keys(site).find((k) => k.toLowerCase() === 'tab') ?? 'tab';
  return { ...flatViewArgs, [siteKey]: { ...site, [tabKey]: tab } };
}

// --- Site Manager rows ---

const SITE_TREE_MODULE = '00000000000000000000000000000000000';
const VARIATIONS_MODULE = '00000000000000000000000000000000099';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';
const PREVIEW_IMAGE_EXTENSIONS = 'jpg,jpeg,png,gif';
const NO_CUSTOM_ICONS: CustomIconLookup = () => '';
// Both callers of dsp_nest pass viewdepth="1", so only open sections nest.
const VIEW_DEPTH = 1;

/** `request.hasPublishingTab` and `request.hasLayoutObjectsTab` of the user's content tab assignments. */
interface TabAccess {
  publishing: boolean;
  layoutObjects: boolean;
}

function tabAccess(tabAssignments: string): TabAccess {
  return {
    publishing: tabAssignments === '' || listFindNoCase(tabAssignments, 'Publishing'),
    layoutObjects: tabAssignments === '' || listFindNoCase(tabAssignments, 'Layout & Objects'),
  };
}

/** The view's preview href: the site's complete web path and the content's URL stem. */
function previewHref(ctx: AdminRenderContext, siteId: string, filename: string | null): string {
  return getWebPath(ctx.site, { complete: true }) + getUrlStem(ctx.site, siteId, filename ?? '');
}

/** The listed type of a row: `rc.rstop.type` and `rsnest.type` read '' for a NULL column. */
const typeOf = (row: SiteManagerRow): string => str(row.type);

/** `rsnest.Display eq <n> and rsnest.approved`. */
function displays(row: SiteManagerRow, n: 1 | 2): boolean {
  return cfEq(str(row.display), String(n)) && truthy(row.approved);
}

/** The `<a … title>` tooltip of an image row: the small rendition (`$.getURLForImage`). */
function imagePreview(ctx: AdminRenderContext, row: SiteManagerRow, perm: NodePerm, size: string): string | undefined {
  const extension = cfListToArray(str(row.assocfilename), '.').at(-1) ?? '';
  if (perm === 'none' || !listFindNoCase(PREVIEW_IMAGE_EXTENSIONS, extension)) return undefined;
  const src = imageUrl(ctx.site, {
    fileId: str(row.fileid),
    fileExt: str(row.fileext),
    size: 'small',
    useProtocol: false,
    height: 'AUTO',
    width: 'AUTO',
  });
  return `<img class='image-preview'${size} src='${src}'>`;
}

/** The `cf_dsp_nest` attributes (dsp_nest.cfm), as the calling view passes them. */
export interface NestAttributes {
  topId: string;
  parentId: string;
  locking: string;
  nestLevel: number;
  perm: NodePerm;
  siteId: string;
  restricted: boolean;
  nextN: number;
  /** As printed in the row links; the window starts at it on level 1 only. */
  startRow: string;
  sortBy: string;
  isSectionRequest: boolean;
}

/** Inputs every level of the nest shares. */
interface NestScope {
  ctx: AdminRenderContext;
  tabs: TabAccess;
  customIcons: CustomIconLookup;
}

/** The objects, display and template cells of a site tree row (dsp_nest.cfm:219-265). */
function nestTreeCells(out: CfOut, row: NestNode, verdict: NodePerm, scope: NestScope): void {
  const { labels } = scope.ctx;
  const editor = verdict === 'editor';
  const inherit = str(row.inheritobjects);
  out.t('\n\t<dd class="objects">\n\t\t');
  if (editor && scope.tabs.layoutObjects) out.t('\n\t\t<a class="mura-quickEditItem" data-attribute="inheritObjects">\n\t\t');
  out.ws();
  if (cfEq(inherit, 'cascade')) out.t('\n\t\t\t\t<i class="mi-arrow-down" title="', inherit, '"></i>\n\t\t\t\t');
  else if (cfEq(inherit, 'reject')) out.t('\n\t\t\t\t\t<i class="mi-ban" title="', inherit, '"></i>\n\t\t\t\t');
  else out.t('\n\t\t\t\t\t<span class="bullet" title="', inherit, '">&bull;</span>\n\t\t\t');
  out.t('\n\t\t\t <span>', inherit, '</span>\n\t\t');
  if (editor && scope.tabs.layoutObjects) out.t('</a>');
  out.t('\n\t</dd>\n\n\t');
  nestDisplayCell(out, row, verdict, scope);
  out.t('\n\t<dd class="template">\n\t  \t');
  const template = str(row.template);
  if (editor && scope.tabs.layoutObjects) {
    const set = template !== '' || str(row.childtemplate) !== '' ? ' template-set' : '';
    out.t('<a class="mura-quickEditItem', set, '" data-attribute="template">');
  }
  out.ws();
  // dsp_nest.cfm:257 tests the template twice, so a child template alone still prints the inherit bullet.
  if (template !== '') {
    out.t('\n\t\t\t <i class="mi-list-alt" title="', template, '"></i><span>', template, '</span>\n\t\t');
  } else {
    const label = labels.key('sitemanager.inherit');
    out.t('\n\t\t\t<span class="bullet" title="', label, '">&bull;</span>\n           \t<span>', label, '</span>\n          ');
  }
  out.ws();
  if (editor && scope.tabs.layoutObjects) out.t('</a>');
  out.t('\n\t</dd>\n');
}

/** A nest row's `<dd class="display">` (dsp_nest.cfm:235-253 and 274-292, which are identical). */
function nestDisplayCell(out: CfOut, row: NestNode, verdict: NodePerm, scope: NestScope): void {
  const { labels, session } = scope.ctx;
  const quickEdit = verdict === 'editor' && scope.tabs.publishing;
  out.t('<dd class="display', displays(row, 2) ? ' scheduled' : '', '">\n\t\t');
  if (quickEdit) out.t('\n\t\t<a class="mura-quickEditItem" data-attribute="display">\n\t\t');
  out.ws();
  if (displays(row, 1)) {
    const yes = labels.key('sitemanager.yes');
    out.t('\n\t\t <i class="mi-check" title="', yes, '"></i><span>', yes, '</span>\n\n\t\t');
  } else if (displays(row, 2)) {
    out.ws();
    if (!quickEdit) {
      const start = lsDateFormat(row.displaystart, 'short', session.locale);
      const stop = lsDateFormat(row.displaystop, 'short', session.locale);
      out.t('\n\t\t\t\t<a href="#" rel="tooltip" title="', attr(start), '&nbsp;-&nbsp;', stop, '">\n\t\t\t');
    }
    out.t('\n\t\t\t<i class="mi-calendar"></i>\n\t\t\t');
    if (!quickEdit) out.t('</a>');
    out.ws();
  } else {
    const no = labels.key('sitemanager.no');
    out.t('\n\t\t<i class="mi-ban" title="', no, '"></i><span>', no, '</span>\n\t\t');
  }
  out.ws();
  if (quickEdit) out.t('</a>');
  out.t('\n\t</dd>\n');
}

/** A nest row's preview `<li>` (dsp_nest.cfm:306-321 and 338-353); `editable` picks the editor branch's indentation. */
function nestPreview(out: CfOut, row: NestNode, scope: NestScope, editable: boolean, siteId: string): void {
  const { labels } = scope.ctx;
  const moduleId = str(row.moduleid);
  const type = typeOf(row);
  if (!cfEq(moduleId, SITE_TREE_MODULE) && !(cfEq(moduleId, VARIATIONS_MODULE) && cfEq(type, 'Variation'))) return;
  const [lead, tail] = editable ? ['\n\t\t   \t\t', '\n\t\t   '] : ['\n\t\t\t\t', '\n\t\t\t'];
  const view = labels.key('sitemanager.view');
  out.ws();
  if (listFindNoCase('Page,Folder,Calendar,Gallery', type)) {
    out.t(lead, '<li class="preview"><a title="', view, '" href="', previewHref(scope.ctx, siteId, row.filename));
    out.t('"><i class="mi-globe"></i></a></li>', tail);
  } else if (listFindNoCase('File,Link', type)) {
    out.t(lead, '<li class="preview"><a title="', view, '" href="#" onclick="return preview(\'');
    out.t(previewHref(scope.ctx, siteId, row.filename), "','", js(row.targetparams), '\');"><i class="mi-globe"></i></a></li>', tail);
  } else if (cfEq(type, 'Variation')) {
    // The editable branch prints the remote URL raw, the read-only branch URL-encodes it.
    const remote = editable ? str(row.remoteurl) : url(row.remoteurl);
    out.t(lead, '<li class="preview"><a title="', view, '" href="', remote, '"><i class="mi-globe"></i></a></li>', tail);
  } else {
    out.t(lead, '<li class="preview disabled"><a><i class="mi-globe"></i></a></li>', tail);
  }
  out.ws();
}

/** The actions `<ul>` of a nest row (dsp_nest.cfm:302-368). */
function nestActions(out: CfOut, row: NestNode, verdict: NodePerm, attrs: NestAttributes, scope: NestScope, lockedElse: boolean): void {
  const { ctx } = scope;
  const { labels, session, siteSettings } = ctx;
  const { siteId, topId, startRow, locking } = attrs;
  const contentId = str(row.contentid);
  const histId = str(row.contenthistid);
  const parentId = str(row.parentid);
  const moduleId = str(row.moduleid);
  const type = typeOf(row);
  out.t('\n\t   \n    <dd class="actions">\n    <ul>\n    \t');
  if (!listFindNoCase('none,read', verdict)) {
    const home = cfEq(attrs.parentId, LEGACY_ADMIN_SENTINEL_ID);
    const deletable =
      ((!home && !cfEq(locking, 'all')) || (home && cfEq(locking, 'none'))) && verdict === 'editor' && !cfEq(str(row.islocked), '1');
    const query = `&topid=${url(topId)}&siteid=${url(siteId)}&moduleid=${url(moduleId)}&startrow=${url(startRow)}`;
    out.t('\n       <li class="edit', lockedElse ? ' disabled' : '', '"><a onclick="draftprompt.call(this,event);return false;" ');
    out.t('data-siteid="', siteId, '" data-contentid="', contentId, '" data-contenthistid="', histId, '" title="');
    out.t(labels.key('sitemanager.edit'), '" href="" data-href="./?muraAction=cArch.edit&contenthistid=', histId);
    out.t('&contentid=', contentId, '&type=', type, '&parentid=', parentId, query, '"><i class="mi-pencil"></i></a></li>\n\t   ');
    nestPreview(out, row, scope, true, siteId);
    out.t('\n\t   <li class="version-history"><a title="', labels.key('sitemanager.versionhistory'), '" href="./?muraAction=cArch.hist');
    out.t('&contentid=', contentId, '&type=', type, '&parentid=', parentId, query, '"><i class="mi-history"></i></a></li>\n\t    ');
    if (cfEq(type, 'Form')) {
      out.t('\n\t\t\t<li class="manage-data"><a title="', labels.key('sitemanager.content.managedata'), '"  href="./?muraAction=');
      out.t('cArch.datamanager&contentid=', url(contentId), '&siteid=', url(row.siteid), '&topid=', url(topId), '&moduleid=');
      out.t(url(moduleId), '&type=Form&parentid=', url(parentId), '"><i class="mi-wrench"></i></a></li>\n\t\t');
    }
    out.ws();
    if (isSiteAdmin(session, siteSettings.privateUserPoolId) || isS2(session)) {
      out.t('\n          <li class="permissions"><a title="', labels.key('sitemanager.permissions'), '" href="./?muraAction=cPerm.main');
      out.t('&contentid=', contentId, '&type=', type, '&parentid=', parentId, query, '"><i class="mi-group"></i></a></li>\n        ');
    } else {
      out.t('\n\t\t  <li class="permissions disabled"><a><i class="mi-group"></i></a></li>\n\t\t');
    }
    out.ws();
    if (deletable && !lockedElse) {
      const confirmKey = cfEq(type, 'Variation')
        ? 'sitemanager.content.deletevariationconfirm'
        : 'sitemanager.content.deletecontentrecursiveconfirm';
      const confirm = labels.messageFormat(labels.key(confirmKey), str(row.menutitle));
      out.t('\n          <li class="delete"><a title="', labels.key('sitemanager.delete'), '" href="./?muraAction=cArch.update');
      out.t('&contentid=', contentId, '&type=', type, '&action=deleteall&topid=', url(topId), '&siteid=', url(siteId), '&moduleid=');
      out.t(url(moduleId), '&parentid=', url(attrs.parentId), '&startrow=', url(startRow));
      out.t(renderCsrfTokensUrl(ctx.csrf(`${contentId}deleteall`)), '" onclick="return confirmDialog(\'', js(confirm));
      out.t('\',this.href)"><i class="mi-trash"></i></a></li>\n          ');
    } else if (!cfEq(locking, 'all')) {
      out.t('\n          <li class="delete disabled"><a><i class="mi-trash"></i></a></li>\n        ');
    }
    out.ws();
  } else {
    out.t('\n        <li class="edit disabled"><a><i class="mi-pencil"></i></a></li>\n\t\t');
    nestPreview(out, row, scope, false, siteId);
    out.t('\n\t\t<li class="version-history disabled"><a><i class="mi-history"></i></a></li>');
    out.t('\n\t\t<li class="permissions disabled"><a><i class="mi-group"></i></a></li>');
    out.t('\n\t\t<li class="delete disabled"><a><i class="mi-trash"></i></a></li>\n      ');
  }
  // The onContentList, on<Type>List and on<Type><Subtype>List plugin scripts render nothing: plugins run on legacy only.
  out.ws().t('\n\t</ul>\n\t</dd>\n</dl>\n   ');
}

/** One listed row of the nest (dsp_nest.cfm:184-394); `verdict` is the row's resolved permission. */
function nestRow(out: CfOut, row: NestNode, verdict: NodePerm, restricted: boolean, attrs: NestAttributes, scope: NestScope): void {
  const { ctx } = scope;
  const { labels, session, siteSettings } = ctx;
  const contentId = str(row.contentid);
  const type = typeOf(row);
  const hasKids = row.kidsCount;
  const lockId = str(row.lockid);
  const lockedElse = siteSettings.hasLockableNodes && lockId !== '' && !cfEq(lockId, session.userId);
  const isOpenSection = listFind(session.openSectionList, contentId) > 0;
  const icon = nodeIconClass(row, { customIconClass: scope.customIcons(str(row.siteid), type, str(row.subtype)), restricted });
  const fileIcon = isFileIcon(row, icon);
  const atitle = imagePreview(ctx, row, verdict, " height='86' width='86'");
  const fileType = cfEq(type, 'File') ? ` data-filetype="${str(row.fileext).slice(0, 4).toLowerCase()}"` : '';

  out.t('\n\n<li data-siteid="', attr(row.siteid), '" data-contentid="', contentId, '" data-contenthistid="', str(row.contenthistid));
  out.t('" data-sortby=', str(row.sortby) !== '' ? `"${attr(row.sortby)}"` : '"orderno"', ' data-sortdirection="', attr(row.sortdirection));
  out.t('" data-moduleid="', attr(row.moduleid), '" data-type="', attr(type), '" class="', attr(type.toLowerCase()), ' mura-node-data');
  out.t(restricted ? ' restricted' : '', '" data-csrf="', renderCsrfTokensUrl(ctx.csrf(`${contentId}quickedit`)), '">\n');
  if (restricted) out.t('<div class="marker"></div>');
  out.t('\n<dl>\n<dt>\n\t\n\n\n\t<a class="add" href="javascript:;"  onclick="siteManager.showMenu(\'newContentMenu\',\'');
  out.t(js(newContentPerm(undefined, verdict, attrs.locking)), "',this,'", contentId, "','", js(attrs.topId), "','", str(row.parentid));
  out.t("','", js(attrs.siteId), "','", type, "','", js(row.moduleid), '\');"><i class="mi-ellipsis-v"></i></a>\n\n\t');
  if (hasKids !== 0) {
    out.t('\n\t\t<span ', isOpenSection ? 'class="hasChildren open"' : 'class="hasChildren closed"');
    out.t(' onclick="return siteManager.loadSiteSection( jQuery(this).closest(\'li\') , 1 , true);"></span>\n\t');
  }
  out.ws().ws();
  if (!listFindNoCase('none,read', verdict)) {
    out.t('\n\t\t<a class="', fileIcon ? 'file ' : '', 'title draftprompt" title="', atitle ?? '', '" href="./?muraAction=cArch.edit');
    out.t('&contenthistid=', str(row.contenthistid), '&contentid=', contentId, '&type=', type, '&parentid=', str(row.parentid));
    out.t('&topid=', url(attrs.topId), '&siteid=', url(attrs.siteId), '&moduleid=', str(row.moduleid), '&startrow=', url(attrs.startRow));
    out.t('"', fileType).ws().t(atitle !== undefined ? 'rel="tooltip" data-html="true"' : '', '>\n\t');
  } else {
    out.t('\n\t\t<a class="', cfEq(type, 'File') ? 'file ' : '', 'title"', fileType).ws();
    out.t(atitle !== undefined ? `rel="tooltip" data-html="true" title="${atitle}"` : '', '>\n\t');
  }
  out.ws();
  if (!fileIcon) out.t('<i class="', icon.toLowerCase(), '"></i> ');
  out.t(html(row.menutitle)).ws();
  if (hasKids > attrs.nextN) out.t('<span class="hasMore">&nbsp;(', labels.key('sitemanager.more'), ')</span>');
  out.t('</a>\n\t\n</dt>\n\n');
  if (cfEq(str(row.moduleid), SITE_TREE_MODULE) && !cfEq(attrs.locking, 'all')) nestTreeCells(out, row, verdict, scope);
  out.ws();
  if (cfEq(str(row.moduleid), SITE_TREE_MODULE)) {
    const quickEdit = verdict === 'editor' && scope.tabs.publishing;
    const navLabel = labels.key(`sitemanager.${yesNoFormat(row.isnav)}`);
    out.t('\n\t<dd class="nav">\n\t\t ');
    if (quickEdit) out.t('<a class="mura-quickEditItem" data-attribute="isnav">');
    out.ws().t(truthy(row.isnav) ? '<i class="mi-check" title="' : '<i class="mi-ban" title="', navLabel, '"></i>');
    out.t('\n\t\t\t <span>', navLabel, '</span>\n\t\t');
    if (quickEdit) out.t('</a>');
    out.t('\n\t</dd>\n');
  } else {
    out.t('\n\t');
    nestDisplayCell(out, row, verdict, scope);
  }
  out.ws();
  if (row.lastupdate !== null) {
    const date = lsDateFormat(row.lastupdate, session.dateKeyFormat, session.locale);
    out.t('\n\t   <dd class="updated" title="', date, ' ', lsTimeFormat(row.lastupdate, 'short', session.locale), '">', date);
    out.t('</dd>\n\t ');
  } else {
    out.t('\n\t\t <dd class="updated"></dd>\n\t ');
  }
  nestActions(out, row, verdict, attrs, scope, lockedElse);
  const kids = row.kids;
  if (hasKids !== 0 && ((hasKids !== 0 && attrs.nestLevel < VIEW_DEPTH) || isOpenSection)) {
    if (kids === undefined) throw new RangeError(`Open section ${contentId} has no nest rows`);
    out.ws();
    const nested: NestAttributes = {
      ...attrs,
      parentId: contentId,
      nestLevel: attrs.nestLevel + 1,
      perm: verdict,
      restricted,
      sortBy: str(row.sortby),
      isSectionRequest: false,
    };
    writeNest(out, kids, nested, scope);
    out.ws();
  }
  out.ws().ws();
  if (isSortable(attrs)) out.t('\n   \t\t<input type="hidden" name="orderid" value="', contentId, '"/>\n   ');
  out.t('\n   \n   </li>\n   ');
}

/** dsp_nest.cfm:103: level 1 of the site tree sorted manually, outside a section request. */
function isSortable(attrs: NestAttributes): boolean {
  return !attrs.isSectionRequest && attrs.nestLevel === 1 && cfEq(attrs.sortBy, 'orderno');
}

/** `<cf_dsp_nest>` (dsp_nest.cfm), writing into the caller's buffer; `nodes` is the parent's full getNest result. */
function writeNest(out: CfOut, nodes: readonly NestNode[], attrs: NestAttributes, scope: NestScope): void {
  const startRow = attrs.nestLevel === 1 ? cfToNumber(attrs.startRow) : 1;
  if (!Number.isInteger(startRow) || startRow < 1) throw new RangeError(`cfoutput startrow ${attrs.startRow} is not a row`);
  out.t('\n\n<ul', isSortable(attrs) ? " id='sortableKids'" : '', ' class="mura-section">\n');
  for (const row of nodes.slice(startRow - 1, startRow - 1 + attrs.nextN)) {
    out.ws().ws();
    const restricted = attrs.restricted || truthy(row.restricted);
    let verdict: NodePerm = row.verdict;
    if (verdict === 'none') verdict = attrs.perm;
    else if (verdict === 'deny') {
      if (restricted) {
        out.ws();
        continue;
      }
      verdict = 'none';
    }
    nestRow(out, row, verdict, restricted, attrs, scope);
    out.ws();
  }
  out.t('\n   \n   </ul>\n');
}

/** Options of {@link renderNest}. */
export interface NestRenderOptions {
  /** The session user's `getContentTabAssignments()`. */
  tabAssignments: string;
  customIcons?: CustomIconLookup;
}

/** `<cf_dsp_nest>` (admin/core/views/carch/dsp_nest.cfm): the `mura-section` list of `nodes`, open sections nested. */
export function renderNest(
  nodes: readonly NestNode[],
  attrs: NestAttributes,
  ctx: AdminRenderContext,
  opts: NestRenderOptions,
): string {
  const out = new CfOut();
  writeNest(out, nodes, attrs, { ctx, tabs: tabAccess(opts.tabAssignments), customIcons: opts.customIcons ?? NO_CUSTOM_ICONS });
  return `${out}`;
}

/** Inputs of {@link renderNextN}: the request values the pager links carry. */
export interface NextNPager {
  siteId: string;
  topId: string;
  moduleId: string;
  ptype: string;
  startRow: string | number;
  /** `hasKids`: the top node's kids count. */
  totalRecords: number;
}

/** dsp_nextN.cfm's `pagelist` savecontent: the Site Manager pager under the tree. */
export function renderNextN(pager: NextNPager, ctx: AdminRenderContext): string {
  const { labels, session } = ctx;
  const next = getNextN(pager.totalRecords, session.nextN, cfToNumber(pager.startRow), 2);
  const call = `return siteManager.loadSiteManager('${js(pager.siteId)}','${js(pager.topId)}','${js(pager.moduleId)}','',''`;
  const link = (startRow: number): string => `${call},'${js(pager.ptype)}',${cfNumberString(startRow)});`;
  const meta = labels.messageFormat(labels.key('sitemanager.paginationmeta'), [
    `${str(pager.startRow)}-${cfNumberString(next.through)}`,
    next.totalRecords,
  ]);
  const out = new CfOut().ws().ws().ws();
  out.t('\n\t\t<div class="clearfix mura-results-wrapper">\n\t\t<p class="search-showing">\n\t\t\t', meta);
  out.t('\n\t\t</p>\n\t\t\t <ul class="pagination">\n\t\t\t  ');
  if (next.currentPageNumber > 1) {
    out.t('\n\t\t\t  \t<li>\n\t\t\t  \t<a href="" onclick="', link(next.previous), '"><i class="mi-angle-left"></i></a>\n\t\t\t  \t</li>\n\t\t\t  ');
  }
  out.ws();
  for (let i = next.firstPage; i <= next.lastPage; i++) {
    out.ws();
    if (next.currentPageNumber === i) {
      out.t('\n\t\t\t  \t\t<li class="active"><a href="#">', cfNumberString(i), '</a></li>\n\t\t\t  ');
    } else {
      out.t('\n\t\t\t  \t\t<li>\n\t\t\t  \t\t\t<a href="" onclick="', link(i * next.recordsPerPage - next.recordsPerPage + 1), '">');
      out.t(cfNumberString(i), '</a>\n\t\t\t  \t\t</li>\n\t\t\t  \t');
    }
    out.ws();
  }
  out.ws();
  if (next.currentPageNumber < next.numberOfPages) {
    out.t('\n\t\t\t \t<li>\n\t\t\t \t\t<a href="" onclick="', link(next.next), '"><i class="mi-angle-right"></i></a> \n\t\t\t \t</li>\n\t\t\t ');
  }
  return `${out.t('\n\t\t\t</ul>\n\t\t</div>\n').ws()}`;
}


// --- carch.loadsitemanager ---

/** The sort selects of the modify-view dropdown (loadsitemanager.cfm:180-227). */
function sortControls(out: CfOut, model: SiteManagerModel, sortBy: string, sortDirection: string, ctx: AdminRenderContext): void {
  const { labels, siteSettings } = ctx;
  const option = (value: string, label: string, lead: string, tail: string): void => {
    out.t(lead, '<option value="', value, '" ', cfEq(sortBy, value) ? 'selected' : '', '>', label, '</option>', tail);
  };
  const extendOption = (row: ExtendAttributeListRow, lead: string, tail: string): void => {
    out.t(lead, '<option value="', attr(row.attribute), '" ', cfEq(sortBy, row.attribute) ? 'selected' : '', '>');
    out.t(html(row.type), '/', html(row.subtype), ' - ', html(row.attribute), '</option>', tail);
  };
  out.t('\n\t\t\t\t</div>\n\t\t\t\t<div>\n\n\t\t\t\t<label>', labels.key('sitemanager.sortnavigation'), ':&nbsp;</label>');
  out.t('\n\t\t\t\t<select name="sortBy"  onchange="siteManager.setAsSorted();">\n\t\t\t\t\t');
  if (cfEq(model.moduleId, SITE_TREE_MODULE)) {
    const lead = '\n\t\t\t\t\t\t';
    option('orderno', labels.key('sitemanager.sort.manual'), '\n\t\t\t\t\t \t', '');
    option('releaseDate', labels.key('sitemanager.sort.releasedate'), lead, '');
    option('lastUpdate', labels.key('sitemanager.sort.updatedate'), lead, '');
    option('created', labels.key('sitemanager.sort.created'), lead, '');
    option('menuTitle', labels.key('sitemanager.sort.menutitle'), lead, '');
    option('title', labels.key('sitemanager.sort.longtitle'), lead, '');
    option('rating', labels.key('sitemanager.sort.rating'), lead, '\n                        ');
    const indent = '\n                            ';
    if (model.hasMarketingManager) option('mxpRelevance', labels.key('params.mxpRelevance'), indent, '\n                        ');
    out.ws();
    if (siteSettings.hasComments) option('comments', labels.key('sitemanager.sort.comments'), indent, '\n                        ');
    out.ws();
    for (const row of model.extendAttributes) {
      out.ws();
      if (listFindNoCase('Base,Page,Folder,Link,File,Gallery,Calendar', row.type)) extendOption(row, '\n\t\t\t\t\t\t\t', '\n\t\t\t\t\t\t\t');
      out.ws();
    }
    out.ws();
  } else {
    const lead = '\n\t\t\t\t\t\t';
    option('orderno', labels.key('sitemanager.sort.manual'), lead, '');
    option('lastUpdate', labels.key('sitemanager.sort.updatedate'), lead, '');
    option('created', labels.key('sitemanager.sort.created'), lead, '');
    option('title', labels.key('sitemanager.sort.longtitle'), lead, '\n\t\t\t\t\t\t');
    const typeFilter = cfEq(model.moduleId, COMPONENTS_MODULE)
      ? 'Component'
      : cfEq(model.moduleId, FORMS_MODULE)
        ? 'Form'
        : cfEq(model.moduleId, VARIATIONS_MODULE)
          ? 'Variation'
          : 'undefined';
    out.ws();
    for (const row of model.extendAttributes) {
      out.ws();
      if (cfEq(row.type, typeFilter)) extendOption(row, '\n\t\t\t\t\t\t      ', '\n\t\t\t\t\t\t  ');
      out.ws();
    }
    out.ws();
  }
  out.t('\n\t\t\t </select>\n\t\t\t <select name="sortDirection"  onchange="siteManager.setAsSorted();">\n\t\t\t   ');
  out.t('<option value="asc" ', cfEq(sortDirection, 'asc') ? 'selected' : '', '>', labels.key('sitemanager.sort.ascending'));
  out.t('</option>\n\t\t\t   <option value="desc" ', cfEq(sortDirection, 'desc') ? 'selected' : '', '>');
  out.t(labels.key('sitemanager.sort.descending'), '</option>\n\t\t\t </select>\n\t\t\t <input type="hidden" name="saveSort" value="true">\n\t\t ');
}

/** The preview `<li>` of the top node (loadsitemanager.cfm:383-398 and 413-428). */
function topPreview(out: CfOut, model: SiteManagerModel, ctx: AdminRenderContext, indent: string): void {
  const top = model.rsTop;
  const type = typeOf(top);
  const moduleId = str(top.moduleid);
  if (!cfEq(moduleId, SITE_TREE_MODULE) && !(cfEq(moduleId, VARIATIONS_MODULE) && cfEq(type, 'Variation'))) return;
  const view = ctx.labels.key('sitemanager.view');
  const lead = `\n    \t${indent}<li class="preview`;
  const tail = `\n    \t${indent}`;
  out.ws();
  if (listFindNoCase('Page,Folder,Calendar,Gallery', type)) {
    out.t(lead, '"><a title="', view, '" href="', previewHref(ctx, model.siteId, top.filename), '"><i class="mi-globe"></i></a></li>', tail);
  } else if (listFindNoCase('File,Link', type)) {
    out.t(lead, '"><a title="', view, '" href="#" onclick="return preview(\'', previewHref(ctx, model.siteId, top.filename));
    out.t("','", js(top.targetparams), '\');"><i class="mi-globe"></i></a></li>', tail);
  } else if (cfEq(type, 'Variation')) {
    out.t(lead, '"><a title="', view, '" href="', url(top.remoteurl), '"><i class="mi-globe"></i></a></li>', tail);
  } else {
    out.t(lead, ' disabled"><a><i class="mi-globe"></i></a></li>', tail);
  }
  out.ws();
}

/** The `<cfsavecontent variable="data.html">` body of loadsitemanager.cfm:158-463. */
function siteManagerHtml(model: SiteManagerModel, sortBy: string, sortDirection: string, ctx: AdminRenderContext): string {
  const { labels, session, siteSettings, config } = ctx;
  const top = model.rsTop;
  const { siteId, topId, moduleId, perm } = model;
  const type = typeOf(top);
  const topModuleId = str(top.moduleid);
  const contentId = str(top.contentid);
  const histId = str(top.contenthistid);
  const parentId = str(top.parentid);
  const locking = siteSettings.locking;
  const restricted = model.restricted;
  const hasKids = model.hasKids;
  const tabs = tabAccess(model.tabAssignments);
  const customIcons = model.customIcons ?? NO_CUSTOM_ICONS;
  const editor = perm === 'editor';
  const isHome = cfEq(topId, LEGACY_ADMIN_SENTINEL_ID);
  const icon = nodeIconClass(top, { customIconClass: customIcons(str(top.siteid), type, str(top.subtype)), restricted });
  const fileIcon = isFileIcon(top, icon);
  const scheduled = displays(top, 2) ? ' scheduled' : '';
  const out = new CfOut();

  out.t('\n <form novalidate="novalidate" class="viewUpdate clearfix" name="viewUpdate" method="post" action="./index.cfm?');
  out.t('muraAction=cArch.list&siteid=', url(siteId), '&moduleid=', url(moduleId), '&topid=', url(topId), '">\n\n \t\n\t');
  out.t('<div class="btn-group" id="sm-modify-view">\n   <a class="btn dropdown-toggle" data-toggle="dropdown" href="">\n\t ');
  out.t(labels.key('sitemanager.modifyview'), '\n\t <span class="caret"></span>\n   </a>\n   <div class="dropdown-menu">\n\t   \n\t   ');
  out.t('<div>\n\t   <label>', labels.key('sitemanager.rowsdisplayed'), ':&nbsp;</label>\n\t   ');
  if (!isHome && (cfEq(perm, 'Editor') || (cfEq(perm, 'Author') && cfEq(config.sortPermission, 'author')))) {
    out.t('\n \t\t\t\t<input name="nextN" value="', cfNumberString(session.nextN), '" type="text" class="text" size="6" maxlength="4" />');
    sortControls(out, model, sortBy, sortDirection, ctx);
  } else {
    out.t('\n\t\t   <input name="nextN" value="', attr(session.nextN), '" type="text" class="text" size="6" maxlength="4" />\n\t\t ');
  }
  out.t('\n\t\t </div>\n\t\t \n\t\t<div class="center">\n\t\t <input type="button" class="btn" onclick="submitForm(document.forms');
  out.t('.viewUpdate);" value="', labels.key('sitemanager.update'), '" />\n\t\t</div>\n\t   <input type="hidden" name="startrow" value="');
  out.t(attr(str(model.startRow)), '">\n\t   <input type="hidden" name="orderperm" value="', perm, '">\n\t   ');
  out.t('<input type="hidden" id="sorted" name="sorted" value="false">\n   </div>\n </div>\n\n');
  if (!cfEq(model.type, 'Component') && !cfEq(model.type, 'Creative') && !cfEq(model.type, 'Form')) {
    out.ws().t(renderZoom(model.crumbs, { ajax: true, class: 'breadcrumb', customIcons })).ws();
  }
  out.t('\n <script>\n   $(document).ready(function(){\n\t $(\'#sm-modify-view .dropdown-menu\').click(function(e) {\n\t   ');
  out.t('e.stopPropagation();\n\t })\n   })\n </script>\n\n ');
  if (cfEq(sortBy, 'orderno')) {
    out.t('\n   <div class="help-block" id="sitemgr-reorder" style="display:none">\n   <i class="mi-warning"></i> Click "Update" ');
    out.t('to save content order: <input type="button" class="submit btn pulse" id="submitSort" onclick="submitForm(document.forms');
    out.t('.viewUpdate);" value="', labels.key('sitemanager.update'), '" />\n   </div>\n ');
  }
  out.t('\n\n   <!-- Begin Grid Header -->\n   <div class="clear-both"></div>\n   <div class="overflow-wrap">\n   ');
  out.t('<div class="mura-grid stripe', cfEq(sortBy, 'orderno') ? '' : ' no-manual-sort', '">\n\t <dl class="mura-grid-hdr">\n\t   ');
  out.t('<dt>\n\t\t   <span class="add"></span>\n\t\t\t', labels.key('sitemanager.title'), '\n\t   </dt>\n\t   ');
  const treeCells = cfEq(topModuleId, SITE_TREE_MODULE) && !cfEq(locking, 'all');
  if (treeCells) {
    out.t('\n\t\t <dd class="objects">', labels.key('sitemanager.objects'), '</dd>\n\t\t <dd class="display">');
    out.t(labels.key('sitemanager.display'), '</dd>\n\t\t <dd class="template">', labels.key('sitemanager.template'), '</dd>\n\t   ');
  }
  out.ws();
  if (cfEq(topModuleId, SITE_TREE_MODULE)) out.t('\n\t\t <dd class="nav">', labels.key('sitemanager.nav'), '</dd>\n\t   ');
  else out.t('\n\t\t  <dd class="display">', labels.key('sitemanager.display'), '</dd>\n\t   ');
  out.t('\n\t   <dd class="updated">', labels.key('sitemanager.updated'), '</dd>\n\t   <dd class="actions">&nbsp;</dd>\n\t </dl>');
  const gallery = model.crumbs.length > 1 && cfEq(model.crumbs[1]?.type ?? '', 'Gallery');
  out.t('\n\t <ul id="mura-nodes"', gallery ? ' class="gallery"' : '', '>\n\t <!-- Begin List of Nodes -->\n\t ');
  out.t('<li data-siteid="', attr(siteId), '" data-contentid="', contentId, '" data-contenthistid="', histId, '" data-moduleid="');
  out.t(attr(moduleId), '" data-sortby=', str(top.sortby) !== '' ? `"${attr(top.sortby)}"` : '"orderno"', ' data-sortdirection="');
  out.t(attr(top.sortdirection), '" class="', attr(type.toLowerCase()), ' mura-node-data', restricted ? ' restricted' : '');
  out.t('" data-csrf="', renderCsrfTokensUrl(ctx.csrf(`${contentId}quickedit`)), '">\n\t  ');
  if (restricted) out.t('<div class="marker"></div>');
  out.t('\n\t   <dl id="top-node">\n\t   <dt>\n\n\t\t<a class="add" href="javascript:;" onclick="siteManager.showMenu(\'');
  out.t('newContentMenu\',\'', newContentPerm(topId, perm, locking), "',this,'", contentId, "','", topId, "','", parentId);
  out.t("','", siteId, "','", type, "','", topModuleId, '\');"><i class="mi-ellipsis-v"></i></a>\n\n\t\t ');
  if (hasKids !== 0) {
    out.t('\n\t\t <span class="hasChildren open" onclick="siteManager.loadSiteManager(\'', js(siteId), "','", js(topId), "','");
    out.t(js(moduleId), "','", js(sortBy), "','", js(sortDirection), "','", js(type), '\',1);"></span>\n\t ');
  }
  out.ws().ws();
  const atitle = imagePreview(ctx, top, perm, '');
  if (!listFindNoCase('none,read', perm) && !cfEq(type, 'module')) {
    out.t('\n\t\t   <a class="', fileIcon ? 'file ' : '', 'title draftprompt" title="', atitle ?? labels.key('sitemanager.edit'));
    out.t('" href="./?muraAction=cArch.edit&contenthistid=', histId, '&siteid=', url(siteId), '&contentid=', topId, '&topid=');
    out.t(url(topId), '&type=', type, '&parentid=', parentId, '&moduleid=', topModuleId, '"');
    if (cfEq(type, 'File')) out.t(' data-filetype="', str(top.fileext).slice(0, 4).toLowerCase(), '"');
    out.ws().t(atitle !== undefined ? 'rel="tooltip" data-html="true" data-placement="bottom"' : '', '>\n\t\t ');
  } else {
    out.t('\n\t\t   <a class="title" ');
    if (cfEq(type, 'File')) out.t(' data-filetype="', str(top.fileext).slice(0, 4).toLowerCase(), '"');
    out.ws().t(atitle !== undefined ? `rel="tooltip" data-html="true" title="${atitle}"` : '', '>\n\t\t ');
  }
  out.ws();
  if (!fileIcon) out.t('<i class="', icon.toLowerCase(), '"></i> ');
  out.t(str(top.menutitle) !== '' ? html(top.menutitle) : html(top.title), '\n\t\t   </a>\n\t   </dt>\n\t  ');
  if (treeCells) {
    const inherit = str(top.inheritobjects);
    const template = str(top.template);
    const quickEdit = editor && tabs.layoutObjects;
    out.t('\n\t   <dd class="objects">\n\t\t   ');
    if (quickEdit) out.t('\n\t\t\t <a class="mura-quickEditItem', scheduled, '" data-attribute="inheritObjects">\n\t\t   ');
    out.ws();
    if (cfEq(inherit, 'cascade')) out.t('\n\t\t <i class="mi-arrow-down" title="', inherit, '"></i>\n\t\t ');
    else if (cfEq(inherit, 'reject')) out.t('\n\t\t   <i class="mi-ban" title="', inherit, '"></i>\n\t\t ');
    else out.t('\n\t\t   <span class="bullet" title="', inherit, '">&bull;</span>\n\t   ');
    out.t('\n\t\t<span>', inherit, '</span>\n\n\t\t   ');
    if (quickEdit) out.t('</a>');
    const yes = labels.key('sitemanager.true');
    out.t('\n\t   </dd>\n\n\t\t<dd class="display', scheduled, '">\n\t\t\t<i class="mi-check" title="', yes, '"></i><span>', yes);
    out.t('</span>\n\t\t</dd>\n\n\t\t<dd class="template">\n\t\t ');
    const templateSet = template !== '' || str(top.childtemplate) !== '';
    if (quickEdit) out.t('<a class="mura-quickEditItem', templateSet ? ' template-set' : '', '" data-attribute="template">');
    out.ws();
    if (templateSet) {
      out.t('\n\t\t   <i class="mi-list-alt" title="', template, '"></i><span>', template, '</span>\n\t   ');
    } else {
      const inheritLabel = labels.key('sitemanager.inherit');
      out.t('\n\t\t <span class="bullet" title="', inheritLabel, '">&bull;</span>\n\t\t\t   <span>', inheritLabel, '</span>\n\t\t\t');
    }
    out.ws();
    if (quickEdit) out.t('</a>');
    out.t('\n\t </dd>\n\t  ');
  }
  out.ws();
  const publishing = editor && tabs.publishing;
  if (cfEq(topModuleId, SITE_TREE_MODULE)) {
    const navLabel = labels.key(`sitemanager.${yesNoFormat(top.isnav)}`);
    out.t('\n\t\t <dd class="nav">\n\t\t ');
    if (publishing) out.t('<a class="mura-quickEditItem" data-attribute="isnav">');
    out.ws().t(truthy(top.isnav) ? '<i class="mi-check" title="' : '<i class="mi-ban" title="', navLabel, '"></i>');
    out.t('       <span>', navLabel, '</span>\n\t\t ');
    if (publishing) out.t('</a>');
    out.t('\n\t   </dd>\n\t   ');
  } else {
    out.t('\n\t\t <dd class="display', scheduled, '">\n\n\t\t');
    if (!cfEq(type, 'Module') && publishing) {
      out.t('\n\t\t   <a class="mura-quickEditItem', scheduled === '' ? '' : ' tooltip', '" data-attribute="display">');
    }
    out.ws();
    if (displays(top, 1)) {
      const yes = labels.key('sitemanager.true');
      out.t('\n\t\t\t   <i class="mi-check" title="', yes, '"></i><span>', yes, '</span>\n\t\t\t ');
    } else if (displays(top, 2)) {
      out.ws();
      if (!publishing) {
        const start = lsDateFormat(top.displaystart, 'short', session.locale);
        const stop = lsDateFormat(top.displaystop, 'short', session.locale);
        out.t('\n\t\t\t\t <a href="#" rel="tooltip" title="', attr(`${start}&nbsp;-&nbsp;${stop}`), '"></a>\n\t\t\t\t');
      }
      out.t('\n\t\t\t\t<i class="mi-calendar"></i>\n\t\t\t\t');
      if (!publishing) out.t('</a>');
      out.ws();
    } else {
      const no = labels.key('sitemanager.false');
      out.t('\n\t\t\t\t<i class="mi-ban" title="', no, '"></i><span>', no, '</span>\n\t\t\t   ');
    }
    out.ws();
    // loadsitemanager.cfm:368 closes the anchor for any editor, Module rows included, which never open one.
    if (publishing) out.t('</a>');
    out.t('\n\t </dd>\n\t  ');
  }
  out.ws();
  if (top.lastupdate !== null) {
    const date = lsDateFormat(top.lastupdate, session.dateKeyFormat, session.locale);
    out.t('\n\t\t   <dd class="updated" title="', date).ws().t(lsTimeFormat(top.lastupdate, 'short', session.locale), '">', date);
    out.t('</dd>\n\t   ');
  } else {
    out.t('\n\t\t\t <dd class="updated"></dd>\n\t   ');
  }
  out.t('\n\t   \n\t  <dd class="actions">\n\t\t<ul>\n\t\t');
  const admin = isSiteAdmin(session, siteSettings.privateUserPoolId) || isS2(session);
  const permQuery = `&parentid=&topid=${url(topId)}&siteid=${url(siteId)}&moduleid=${topModuleId}&type=${type}`;
  const permHref = `./?muraAction=cPerm.main&contentid=${topId}${permQuery}`;
  if (!cfEq(type, 'Module') && !listFindNoCase('none,read', perm)) {
    const lockId = str(top.lockid);
    const lockedElse = siteSettings.hasLockableNodes && lockId !== '' && !cfEq(lockId, session.userId);
    out.ws();
    out.t('\n      <li class="edit', lockedElse ? ' disabled' : '', '"><a onclick="draftprompt.call(this,event);return false;" ');
    out.t('data-siteid="', siteId, '" data-contentid="', contentId, '" data-contenthistid="', histId, '" title="');
    out.t(labels.key('sitemanager.edit'), '" href=""data-href="./?muraAction=cArch.edit&contenthistid=', histId, '&siteid=');
    out.t(url(siteId), '&contentid=', topId, '&topid=', url(topId), '&type=', type, '&parentid=', parentId, '&moduleid=');
    out.t(topModuleId, '"><i class="mi-pencil"></i></a></li>\n      ');
    topPreview(out, model, ctx, '\t ');
    out.t('\n    \t<li class="version-history"><a title="', labels.key('sitemanager.versionhistory'), '" href="./?muraAction=');
    out.t('cArch.hist&contentid=', contentId, '&type=', type, '&parentid=', parentId, '&topid=', url(topId), '&siteid=');
    out.t(url(siteId), '&moduleid=', topModuleId, '"><i class="mi-history"></i></a></li>\n      ');
    if (cfEq(type, 'Form')) {
      out.t('\n    \t\t<li class="manage-data"><a title="', labels.key('sitemanager.content.managedata'), '"  href="./?muraAction=');
      out.t('cArch.datamanager&contentid=', url(contentId), '&siteid=', url(top.siteid), '&topid=', url(topId), '&moduleid=');
      out.t(url(topModuleId), '&type=Form&parentid=', url(parentId), '"><i class="mi-wrench"></i></a></li>\n    \t');
    }
    out.ws();
    if (admin) {
      out.t('\n    \t\t<li class="permissions"><a title="', labels.key('sitemanager.permissions'), '" href="', permHref);
      out.t('"><i class="mi-group"></i></a></li>\n    \t');
    } else {
      out.t('\n    \t\t<li class="permissions disabled"><a><i class="mi-group"></i></a></li>\n    \t');
    }
    out.ws();
    if (!cfEq(locking, 'all')) out.t('\n    \t\t<li class="delete disabled"><a><i class="mi-trash"></i></a></li>\n    \t');
    out.ws();
  } else {
    out.t('\n  \t\t<li class="edit disabled"><a><i class="mi-pencil"></i></a></li>\n      ');
    topPreview(out, model, ctx, '   ');
    out.ws();
    const importLabel = labels.key('sitemanager.content.importnode');
    if (cfEq(topModuleId, FORMS_MODULE)) {
      out.t('\n        <li class="import"><a title="', importLabel, '"  href="./?muraAction=cForm.importform&siteid=', url(siteId));
      out.t('"><i class="mi-upload"></i></a></li>\n      ');
    } else if (cfEq(topModuleId, COMPONENTS_MODULE)) {
      out.t('\n          <li class="import"><a title="', importLabel, '"  href="./?muraAction=cArch.importcomponent&siteid=');
      out.t(url(siteId), '"><i class="mi-upload"></i></a></li>\n      ');
    }
    out.t('\n\t\t  <li class="version-history disabled"><a><i class="mi-history"></i></a></li>\n  \t\t');
    if (admin) {
      out.t('\n  \t\t  <li class="permissions"><a title="', labels.key('sitemanager.permissions'), '" href="', permHref);
      out.t('"><i class="mi-group"></i></a></li>\n  \t\t');
    } else {
      out.t('\n  \t\t  <li class="permissions disabled"><a><i class="mi-group"></i></a></li>\n  \t\t');
    }
    out.t('\n  \t\t<li class="delete disabled"><a><i class="mi-trash"></i></a></li>\n\t\t');
  }
  // The onContentList, on<Type>List and on<Type><Subtype>List plugin scripts render nothing: plugins run on legacy only.
  out.ws().ws().ws();
  out.t('\n\t\t </ul></dd>\n\t   </dl>\n\n\t   ');
  if (hasKids !== 0) {
    out.ws();
    const attrs: NestAttributes = {
      topId,
      parentId: topId,
      locking,
      nestLevel: 1,
      perm,
      siteId,
      restricted,
      nextN: session.nextN,
      startRow: str(model.startRow),
      sortBy,
      isSectionRequest: false,
    };
    writeNest(out, model.nest, attrs, { ctx, tabs, customIcons });
    out.ws();
  }
  out.t('\n\t   </li>\n\t   </ul>\n\t </div>\n\t </div> <!-- /.overflow-wrap -->\n\t <div class="clear=both"></div>\n </form>\n ');
  if (hasKids > session.nextN) {
    const pager = { siteId, topId, moduleId, ptype: model.ptype, startRow: model.startRow, totalRecords: hasKids };
    out.ws().t(renderNextN(pager, ctx)).ws();
  }
  return `${out.ws()}`;
}

/** carch.loadsitemanager (loadsitemanager.cfm:80-466): the tree under `topId` as `{html, perm, sortby}`. */
export function renderSiteManagerJson(model: SiteManagerModel, ctx: AdminRenderContext): AdminRenderResult {
  const sortBy = model.sortBy !== '' ? model.sortBy : str(model.rsTop.sortby) || 'orderno';
  const sortDirection = model.sortDirection !== '' ? model.sortDirection : str(model.rsTop.sortdirection);
  const data = acfStruct([
    ['html', siteManagerHtml(model, sortBy, sortDirection, ctx)],
    ['perm', model.perm],
    ['sortBy', sortBy],
  ]);
  return {
    status: 200,
    contentType: ADMIN_JSON_CONTENT_TYPE,
    body: muraJsonEncode(data),
    sessionEffects: { flatViewArgs: flatViewTab(ctx.session.flatViewArgs, model.siteId, 0) },
  };
}

// --- carch.loadsitesection, carch.refreshsitesection, carch.siteManagerTab ---

/** CFML `listDeleteAt(list, position)` over a comma list. */
function listDeleteAt(list: string, position: number): string {
  const items = cfListToArray(list);
  items.splice(position - 1, 1);
  return items.join(',');
}

/** The section's sort: neither view defines `rc.rstop`, so legacy fails when the request leaves either empty. */
function sectionSort(model: SiteSectionModel): { sortBy: string; sortDirection: string } {
  if (model.sortBy === '' || model.sortDirection === '') throw new RangeError('Element RSTOP is undefined in RC.');
  return { sortBy: model.sortBy, sortDirection: model.sortDirection };
}

/** The `<cf_dsp_nest isSectionRequest="true">` buffer of a section view; `encode` is the attribute encoding it applies. */
function sectionNest(
  model: SiteSectionModel,
  ctx: AdminRenderContext,
  encode: (v: string) => string,
): string {
  const { sortBy } = sectionSort(model);
  const attrs: NestAttributes = {
    topId: encode(model.sectionId),
    parentId: encode(model.sectionId),
    locking: ctx.siteSettings.locking,
    nestLevel: 1,
    perm: model.perm,
    siteId: model.siteId,
    restricted: model.restricted,
    nextN: ctx.session.nextN,
    startRow: encode(str(model.startRow)),
    sortBy: encode(sortBy),
    isSectionRequest: true,
  };
  return renderNest(model.nest, attrs, ctx, { tabAssignments: model.tabAssignments, customIcons: model.customIcons });
}

/**
 * carch.loadsitesection (loadsitesection.cfm:76-119): opens a closed section, returning its rows as `{html}`, or closes
 * an open one with an empty body.
 */
export function renderLoadSiteSection(model: SiteSectionModel, ctx: AdminRenderContext): AdminRenderResult {
  const openSections = ctx.session.openSectionList;
  const found = listFind(openSections, model.sectionId);
  if (found > 0) {
    const openSectionList = listDeleteAt(openSections, found);
    return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', sessionEffects: { openSectionList } };
  }
  const openSectionList = cfListAppend(openSections, model.sectionId);
  const opened: AdminRenderContext = { ...ctx, session: { ...ctx.session, openSectionList } };
  const body = new LegacyJsonSerializer().serialize({ html: sectionNest(model, opened, attr) });
  return { status: 200, contentType: ADMIN_JSON_CONTENT_TYPE, body, sessionEffects: { openSectionList } };
}

/** carch.refreshsitesection (refreshsitesection.cfm:76-109): a section's rows as mura.json `{html}`. */
export function renderRefreshSiteSection(model: SiteSectionModel, ctx: AdminRenderContext): AdminRenderResult {
  const data = acfStruct([['html', sectionNest(model, ctx, (v) => v)]]);
  // The template's trailing line breaks print one space after the JSON.
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: `${new CfOut().t(muraJsonEncode(data)).ws()}` };
}

/** carch.siteManagerTab (carch.cfc:516-523): records the Site Manager tab of the session's site, then aborts. */
export function renderSiteManagerTab(tab: string, ctx: Pick<AdminRenderContext, 'session'>): AdminRenderResult {
  const flatViewArgs = flatViewTab(ctx.session.flatViewArgs, ctx.session.siteId, tab);
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', sessionEffects: { flatViewArgs } };
}

// --- carch.loaddiff ---

/** A value CFML `isSimpleValue` accepts. */
function isCfSimple(v: unknown): v is CfSimpleValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;
}

/** The second a simple value names as a CFML date: a Date, or text CFML reads as a date; undefined otherwise. */
function cfDateSecond(v: CfSimpleValue): number | undefined {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'string' && cfIsDateText(v)) return Math.floor(cfParseDateTimeText(v).getTime() / 1000);
  return undefined;
}

/** CFML comparison of two simple values: numbers, then dates to the second, then booleans, then case-insensitive text. */
function cfCompare(a: CfSimpleValue, b: CfSimpleValue): number {
  const sign = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);
  if (cfIsNumeric(a) && cfIsNumeric(b)) return sign(cfToNumber(a), cfToNumber(b));
  const da = cfDateSecond(a);
  const db = cfDateSecond(b);
  if (da !== undefined && db !== undefined) return sign(da, db);
  if (cfIsBoolean(a) && cfIsBoolean(b)) return sign(Number(cfToBoolean(a)), Number(cfToBoolean(b)));
  const x = cfToString(a).toLowerCase();
  const y = cfToString(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `bean.compare(other)` (bean.cfc:1286-1317): each differing comparable simple property's diff, in ACF struct order. */
function compareVersions(base: DiffVersion, other: DiffVersion): Array<readonly [string, string]> {
  const excluded = new Set(CONTENT_COMPARABLE_EXCLUDED.map((p) => p.toLowerCase()));
  const lookup = (version: DiffVersion): Map<string, unknown> =>
    new Map(version.values.map(([name, value]) => [name.toLowerCase(), value]));
  const baseValues = lookup(base);
  const otherValues = lookup(other);
  const differing = new Map<string, string>();
  for (const [property] of base.values) {
    const lower = property.toLowerCase();
    if (excluded.has(lower)) continue;
    const a = baseValues.get(lower);
    // getValue of a property the other version lacks reads its extended attribute: ''.
    const b = otherValues.has(lower) ? otherValues.get(lower) : '';
    if (!isCfSimple(a) || !isCfSimple(b) || cfCompare(a, b) === 0) continue;
    differing.set(property, computeDiff(cfToString(a), cfToString(b)).html);
  }
  return acfStructKeyOrder([...differing.keys()]).map((property) => [property, differing.get(property) ?? '']);
}

/** carch.loaddiff (loaddiff.cfm): the older version diffed against the newer, one `<h3>` per differing property. */
export function renderLoadDiff(v1: DiffVersion, v2: DiffVersion, ctx: Pick<AdminRenderContext, 'labels'>): AdminRenderResult {
  const diff = cfCompare(v1.lastUpdate, v2.lastUpdate) < 0 ? compareVersions(v1, v2) : compareVersions(v2, v1);
  const body =
    diff.length > 0
      ? diff.map(([property, diffHtml]) => `<h3>${property.toUpperCase()}</h3>${diffHtml}`).join('')
      : ctx.labels.key('sitemanager.content.codediffnodifference');
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body };
}

// --- carch.loadnotify, carch.loadexpirenotify, carch.lockcheck ---

/** A notify option's label: `lname, fname (<type label>)`, names printed as stored. */
function notifyLabel(row: NotifyRow, ctx: Pick<AdminRenderContext, 'labels'>): string {
  return `${str(row.lname)}, ${str(row.fname)} (${ctx.labels.key(`sitemanager.permissions.${row.type}`)})`;
}

/** carch.loadnotify (loadnotify.cfm:76-94): the send-to select and message of the content notify panel. */
export function renderLoadNotify(model: LoadNotifyModel, ctx: Pick<AdminRenderContext, 'labels'>): AdminRenderResult {
  const { labels } = ctx;
  const out = new CfOut();
  out.t('\n<div class="mura-control-group">\n<label>', labels.key('sitemanager.content.fields.sendto'), '</label>');
  out.t('\n\t<select id="notifyEditor" name="notify" multiple="multiple" ');
  if (cfEq(model.perm, 'editor')) {
    out.t(' onChange="javascript: this.selectedIndex==0?document.contentForm.approved.checked=true:document.contentForm.');
    out.t('approved.checked=false;"');
  }
  out.t('>\n\t<option value="" selected>None</option>\n\t');
  for (const row of model.rows) out.t('\n\t<option value="', row.userid, '">', notifyLabel(row, ctx), '</option>\n\t');
  out.t('\n\t</select>\n</div>\n<div class="mura-control-group">\n\t<label>', labels.key('sitemanager.content.fields.message'));
  out.t('</label>\n\t<textarea name="message" rows="5" id="messageEditor">', labels.key('sitemanager.content.fields.messagetext'));
  out.t('\n\t</textarea>\n</div>\n');
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: `${out.ws()}` };
}

/** carch.loadexpirenotify (loadexpirenotify.cfm:76-99): the expiration notify select, assigned users selected. */
export function renderLoadExpireNotify(
  model: LoadExpireNotifyModel,
  ctx: Pick<AdminRenderContext, 'labels'>,
): AdminRenderResult {
  const out = new CfOut();
  out.t('\n\t<label>', ctx.labels.key('sitemanager.content.fields.expiresnotifyselect'), '</label>\n\t');
  out.t('<select id="expiresnotify" name="expiresnotify" size="6" multiple class="multiSelect">\n\t<option value="">None</option>\n\t');
  for (const row of model.rows) {
    const selected = listFind(model.assigned, row.userid) > 0 ? ' selected' : '';
    out.t('\n\t<option value="', row.userid, '"', selected, '>', notifyLabel(row, ctx), '</option>\n\t');
  }
  out.t('\n\t</select>\n');
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: `${out}` };
}

/**
 * carch.lockcheck (lockcheck.cfm): forwards the lock holder to `destAction`, else the draft prompt page, which the
 * compact layout wraps.
 */
export function renderLockCheck(
  model: LockCheckModel,
  ctx: Pick<AdminRenderContext, 'labels' | 'session' | 'config'>,
): AdminRenderResult {
  const { labels, config } = ctx;
  if (cfEq(model.lockId, ctx.session.userId)) {
    // CFML replace() swaps the first case-sensitive occurrence.
    const redirect = `./?${model.queryString.replace('carch.lockcheck', () => model.destAction)}`;
    return { status: 302, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', redirect };
  }
  const dest = js(model.destAction);
  const script = config.context + config.adminDir;
  const ajax = `\n\t<script src="${script}/assets/js/architecture.min.js?coreversion=${model.coreVersion}" type="text/javascript" ></script>\n`;
  const body = [
    '\n<div id="configuratorContainer">\n\t<h1 id="configuratorHeader">',
    labels.key('sitemanager.draftprompt.title'),
    '</h1>\n\t<div id="configurator">\n\t<div class="load-inline"></div>\n\t</div>\n</div>\n<script type="text/javascript">\n',
    '$(function(){\n\n\tif (top.location != self.location) {\n\t\tif(jQuery("#ProxyIFrame").length){\n\t\t\t',
    'jQuery("#ProxyIFrame").load(\n\t\t\t\tfunction(){\n\t\t\t\t\tfrontEndProxy.post({cmd:\'setWidth\',width:\'configurator\'});',
    '\n\t\t\t\t}\n\t\t\t);\t\n\t\t} else {\n\t\t\tfrontEndProxy.post({cmd:\'setWidth\',width:\'configurator\'});\n\t\t}\n\t}',
    "\n\n\t$('#configuratorContainer .load-inline').spin(spinnerArgs2);\n\n\tvar href = './?",
    js(model.queryString),
    "';\n\tvar locknode=false;\n\n\t$.ajax({\n\t\t  url: \"./index.cfm?muraAction=carch.draftpromptdata&contentid=",
    js(model.contentId),
    '&siteid=',
    js(model.siteId),
    '&targetversion=true&contenthistid=',
    js(model.contentHistId),
    '&homeid=',
    js(model.homeId),
    '",\n\t\t  context: this,\n\t\t  success: function(resp){\n\n\t\t\t  if (resp.showdialog !== undefined && ',
    'resp.showdialog === "true"){\n\t\t\t\t\n\t\t\t\t$(\'#configurator\').html(resp.message);\n\n\t\t\t\t',
    '$(".draft-prompt-option").click(function(e){\n\t\t\t\t\te.preventDefault();\n\t\t\t\t\t',
    "href = href.replace('carch.lockcheck','",
    dest,
    "&locknode=' + locknode );\n\t\t\t\t\tactionModal(href);\n\t\t\t\t});\n\n\t\t\t\t",
    '$("#locknodetoggle").on("change",function(){\n\t\t\t\t\tlocknode=$(this).is(":checked");\n\t\t\t\t});\n\n\t\t\t} else {',
    "\n\t\t\t\thref = href.replace('carch.lockcheck','",
    dest,
    "&locknode=' + locknode );\n\t\t\t\tactionModal(href);\n\t\t\t}\n\t\t}\n\t});\n});\n</script>\n",
  ].join('');
  return { status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body, layout: true, ajax };
}
