/**
 * Byte-exact `carch.loadsiteflat`, `carch.siteparents` and `carch.loadnewcontentmenu` fragments as ACF 2023 renders
 * them; the web admin-raw handler relays these bodies. Pure: callers pass prepared rows and persist session effects.
 *
 * ACF whitespace management, observed on 2023.0.26: CFML comments vanish; a whitespace-only text run between CFML
 * tags or expressions prints nothing outside `<cfoutput>`, and inside it (or right after `</cfoutput>`) one space
 * unless the buffer is empty or already ends in whitespace. Text holding anything else prints verbatim.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  adminUrl,
  cfEq,
  cfIsNumeric,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  javaTrim,
  type AdminParam,
} from '@opt2/platform/legacy-compat';
import {
  cfHtmlEditFormat,
  esapiEncode,
  iconClass,
  isS2,
  isSiteAdmin,
  lsDateFormat,
  lsTimeFormat,
  newContentPerm,
  renderCsrfTokensUrl,
  renderZoom,
  yesNoFormat,
  type AdminRenderContext,
  type AdminSessionState,
  type CustomIconLookup,
  type NodePerm,
  type ZoomCrumb,
} from './admin-markup.js';
import { contentImageUrl, contentUrl } from './content-urls.js';
import type { CategoryRow, ContentRow, ContentStatsRow, ExtendSubtypeRow, FileRow } from '../repo/tables.js';

/** The content type ACF sends for a FW/1 view rendered with `request.layout=false`. */
export const SITE_MANAGER_FRAGMENT_CONTENT_TYPE = 'text/html;charset=UTF-8';

/** A rendered Site Manager fragment; `sessionEffects` are the session writes the view makes. */
export interface SiteManagerFragmentResult {
  status: 200;
  contentType: typeof SITE_MANAGER_FRAGMENT_CONTENT_TYPE;
  body: string;
  sessionEffects?: Partial<AdminSessionState>;
  /** Legacy keeps the admin layout around `body` (`rc.frontEndProxyLoc` is set): the caller renders it in the shell. */
  layout?: boolean;
}

/** A crumb of `contentManager.getCrumbList`, leaf first; legacy sets `parentarray` on the first crumb of a full walk. */
export type SiteManagerCrumb = ZoomCrumb & { parentarray?: readonly string[] };

/** `extendManager.getSubTypes(siteid, activeOnly=true)` columns the views read, in its `order by type, subtype` order. */
export type SiteManagerSubtype = Pick<ExtendSubtypeRow, 'type' | 'subtype' | 'adminonly' | 'description'>;

const HOME_ID = LEGACY_ADMIN_SENTINEL_ID;
const SITE_TREE_MODULE = '00000000000000000000000000000000000';
const SPECIAL_MODULES = ['00000000000000000000000000000000003', '00000000000000000000000000000000004', '00000000000000000000000000000000099'];

// Java Character.isWhitespace, which ACF applies to the last character it wrote.
const ENDS_IN_WHITESPACE = /[\t-\r\u001c-\u001f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/;

/** One ACF output buffer under whitespace management. */
class CfOut {
  private body = '';

  /** Literal text with a non-whitespace character, or expression values: printed verbatim. */
  t(...parts: string[]): this {
    for (const part of parts) this.body += part;
    return this;
  }

  /** A whitespace-only text run inside `<cfoutput>` or right after `</cfoutput>`. */
  ws(): this {
    if (this.body !== '' && !ENDS_IN_WHITESPACE.test(this.body)) this.body += ' ';
    return this;
  }

  toString(): string {
    return this.body;
  }
}

/** CFML list items over a set of single-character delimiters; empty items are skipped. */
function listItems(list: string, delimiters = ','): string[] {
  const items: string[] = [];
  let item = '';
  for (const ch of list) {
    if (!delimiters.includes(ch)) {
      item += ch;
      continue;
    }
    if (item !== '') items.push(item);
    item = '';
  }
  if (item !== '') items.push(item);
  return items;
}

/** CFML `listFindNoCase(list, value) > 0`. */
function listFindNoCase(list: string, value: string): boolean {
  return value !== '' && listItems(list).some((item) => item.toLowerCase() === value.toLowerCase());
}

/** A number or NULL column as `#value#` prints it. */
function num(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : cfNumberString(v);
}

/** A text column as `#value#` prints it. */
function str(v: string | number | null | undefined): string {
  return typeof v === 'number' ? cfNumberString(v) : (v ?? '');
}

/** The views' relative admin link `./?muraAction=<circuit>.<item>&…`; `action` is `<circuit>.<item>`. */
function viewAdminUrl(action: `${string}.${string}`, params: AdminParam[]): string {
  const dot = action.indexOf('.');
  return adminUrl({ circuit: action.slice(0, dot), action: action.slice(dot + 1), params, adminDir: '.', context: '' });
}

/** ACF `NumberFormat(n, mask)` for the `9` and `9.99` masks: half-up on the decimal digits ACF prints for `n`. */
function numberFormat(n: number, decimals: 0 | 2): string {
  const [whole = '0', fraction = ''] = cfNumberString(Math.abs(n)).split('.');
  const digits = BigInt(whole + fraction.padEnd(decimals + 1, '0').slice(0, decimals + 1));
  const rounded = (digits + 5n) / 10n;
  const text = rounded.toString().padStart(decimals + 1, '0');
  const sign = n < 0 && rounded !== 0n ? '-' : '';
  return decimals === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}

/** `utility.renderFileSize(size)` (utility.cfc:1536-1545). */
function renderFileSize(size: number): string {
  return size > 1_000_000 ? `${numberFormat(size * 0.000001, 2)}Mb` : `${numberFormat(size * 0.001, 0)}kb`;
}

/** A CF struct read with case-insensitive keys. */
function structGet<T>(struct: Readonly<Record<string, T>>, key: string): T | undefined {
  const lower = key.toLowerCase();
  const found = Object.keys(struct).find((k) => k.toLowerCase() === lower);
  return found === undefined ? undefined : struct[found];
}

/** CF struct assignment: an existing key keeps its spelling, a new key takes the one assigned. */
function structSet<T>(struct: Readonly<Record<string, T>>, entries: ReadonlyArray<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = { ...struct };
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    out[Object.keys(out).find((k) => k.toLowerCase() === lower) ?? key] = value;
  }
  return out;
}

// contentRendererUtility.iconClassByContentType defaults (contentRendererUtility.cfc:175-206), matched as cfswitch does.
const CONTENT_TYPE_ICONS: ReadonlyMap<string, string> = new Map([
  ['folder', 'mi-folder-open-o'],
  ['calendar', 'mi-calendar'],
  ['component', 'mi-align-justify'],
  ['gallery', 'mi-th'],
  ['galleryitem', 'mi-picture'],
  ['link', 'mi-link'],
  ['quick', 'mi-upload'],
  ['file', 'mi-file-text-o'],
  ['form', 'mi-toggle-on'],
]);

/** `$.iconClassByContentType(type, subtype, siteid)` (contentRendererUtility.cfc:163-208). */
function iconClassByContentType(customIcons: CustomIconLookup, type: string, subtype: string, siteId: string): string {
  const custom = siteId === '' ? '' : customIcons(siteId, type, subtype);
  return custom !== '' ? custom : (CONTENT_TYPE_ICONS.get(type.toLowerCase()) ?? 'mi-file');
}

const NO_CUSTOM_ICONS: CustomIconLookup = () => '';

/**
 * `$.dspZoomNoLinks(crumbdata)` (contentRenderer.cfc:2377-2386, contentRendererUtility.cfc:8-63) with no character
 * or level limits: a `navZoom` list, ancestors first; only a restricted ancestor marks later items locked.
 */
function renderZoomNoLinks(crumbs: readonly SiteManagerCrumb[], customIcons: CustomIconLookup): string {
  const current = crumbs[0];
  if (current === undefined) throw new RangeError('dspZoomNoLinks needs at least one crumb');
  const out = new CfOut().t('\n\t\t<ul class="navZoom">\n\t\t');
  let locked = '';
  const item = (crumb: SiteManagerCrumb, indent: string, title: string): void => {
    const icon = iconClass(customIcons, crumb);
    const fileIcon = cfEq(crumb.type ?? '', 'File') && !cfEq(cfListToArray(icon, '-')[0] ?? '', 'mi');
    out.ws().t(`\n${indent}<li class="`, icon).ws().t(locked);
    if (fileIcon) out.t(' file');
    out.t('"');
    if (fileIcon) out.t(' data-filetype="', icon.slice(0, 4), '"');
    out.t('> ', title, '</li>\n\t\t');
  };
  for (let i = crumbs.length - 1; i >= 1; i--) {
    const crumb = crumbs[i] as SiteManagerCrumb;
    if (crumb.restricted === 1) locked = 'locked';
    item(crumb, '\t\t\t', cfHtmlEditFormat(crumb.menutitle ?? ''));
  }
  item(current, '\t\t', `<strong>${cfHtmlEditFormat(current.menutitle ?? '')}</strong>`);
  return `${out.t('</ul>')}`;
}

// --- carch.loadsiteflat ---

/** `$.event(name)` values of the request; names match case-insensitively and a missing name reads as ''. */
export type SiteFlatEvent = Readonly<Record<string, string | number | undefined>>;

function eventValue(event: SiteFlatEvent, name: string): string | number {
  return structGet(event, name) ?? '';
}

function eventText(event: SiteFlatEvent, name: string): string {
  return str(eventValue(event, name));
}

/** loadsiteflat.cfm:87-108: a non-numeric `page` reads 1; an `expiration` or `duedate` sort outside its reports reads `lastupdate`. */
export function normalizeSiteFlatEvent(event: SiteFlatEvent): SiteFlatEvent {
  const report = eventText(event, 'report');
  const sortBy = eventText(event, 'sortby');
  const entries: [string, string | number][] = [];
  if (!cfIsNumeric(eventValue(event, 'page'))) entries.push(['page', 1]);
  if (!listFindNoCase('myexpires,expires', report) && cfEq(sortBy, 'expiration')) entries.push(['sortby', 'lastupdate']);
  else if (!listFindNoCase('mysubmissions,myapprovals', report) && cfEq(sortBy, 'duedate')) entries.push(['sortby', 'lastupdate']);
  return structSet(event, entries);
}

/** Rows per page of the flat view's feed (`feed.setNextN(10)`). */
const FLAT_PAGE_SIZE = 10;

/** The flat view's iterator after `setPage(page)` (queryIterator.cfc:100-115,145-227). */
export interface SiteFlatPage {
  pageIndex: number;
  /** Rows before the page's first row. */
  offset: number;
  /** Rows the page shows. */
  count: number;
  pageCount: number;
  firstRecord: number;
  lastRecord: number;
}

/** The page `iterator.setPage(page)` shows of `totalRecords` rows; a page before the first row fails as legacy does. */
export function siteFlatPage(totalRecords: number, page: number): SiteFlatPage {
  let pageIndex = page;
  let offset = (page - 1) * FLAT_PAGE_SIZE;
  if (offset > totalRecords) {
    offset = 0;
    pageIndex = 1;
  }
  // Legacy's iterator.next() then reads a row index below 1 or between rows and errors.
  if (offset < 0 || !Number.isInteger(offset)) throw new RangeError(`Page ${cfNumberString(page)} has no first row`);
  const first = (pageIndex - 1) * FLAT_PAGE_SIZE;
  return {
    pageIndex,
    offset,
    count: Math.max(0, Math.min(totalRecords, pageIndex * FLAT_PAGE_SIZE) - offset),
    pageCount: Math.ceil(totalRecords / FLAT_PAGE_SIZE),
    firstRecord: first > totalRecords ? 1 : first + 1,
    lastRecord: Math.min(first + FLAT_PAGE_SIZE, totalRecords),
  };
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** One row of the current page: the feed's content row plus the per-row lookups loadsiteflat.cfm:584-747 makes. */
export type SiteFlatRow = Pick<
  ContentRow,
  | 'siteid'
  | 'contentid'
  | 'contenthistid'
  | 'parentid'
  | 'moduleid'
  | 'type'
  | 'subtype'
  | 'menutitle'
  | 'filename'
  | 'fileid'
  | 'sortby'
  | 'sortdirection'
  | 'islocked'
  | 'majorversion'
  | 'minorversion'
  | 'lastupdate'
  | 'lastupdateby'
  | 'created'
  | 'expires'
  | 'tags'
> &
  Nullable<Pick<FileRow, 'fileext' | 'filesize'>> &
  Nullable<Pick<ContentStatsRow, 'lockid' | 'locktype'>> & {
    /** `Pending` on `mysubmissions` and `myapprovals` rows (loadsiteflat.cfm:331). */
    approvalstatus?: string | null;
    /** The latest draft's publish date or display start on those reports (loadsiteflat.cfm:333-337). */
    duedate?: Date | null;
    /** `contentManager.getCrumbList(contentid, siteid)`. */
    crumbs: readonly SiteManagerCrumb[];
    /** `permUtility.getnodePerm(crumbs)`. */
    verdict: NodePerm;
    /** Category names of `item.getCategoriesIterator()`, in its order. */
    categories: readonly string[];
    /** `user.loadBy(lockid)` names; absent when the lock holder is not found. */
    lockedBy?: { fname: string | null; lname: string | null };
  };

/** The `navReports` badge counts (`contentManager.getMyDraftsCount` and siblings). */
export interface SiteFlatReportCounts {
  mydrafts: number;
  mysubmissions: number;
  myapprovals: number;
  myexpires: number;
  mylockedcontent: number;
}

/** A `categoryManager.getCategories(siteid, parentid)` row with its children, whose number is the row's `hasKids`. */
export type SiteFlatCategory = Pick<CategoryRow, 'categoryid' | 'name' | 'isopen'> & { kids: readonly SiteFlatCategory[] };

/** Everything loadsiteflat.cfm reads besides the render context. */
export interface LoadSiteFlatModel {
  /** The request context after carch.before() (`siteid`, `moduleid`, `startrow` and `locking` set). */
  event: SiteFlatEvent;
  /** `$.currentUser().isSuperUser() or $.currentUser().isAdminUser()`. */
  powerUser: boolean;
  /** `siteConfig('customTagGroups')`. */
  customTagGroups: string;
  /** Subtypes of the session's site. */
  subtypes: readonly SiteManagerSubtype[];
  /** Rows the feed returned (at most 500), in the order the view pages them. */
  totalRecords: number;
  /** The rows of {@link siteFlatPage} for the normalized `page`, in order. */
  rows: readonly SiteFlatRow[];
  reportCounts: SiteFlatReportCounts;
  /** `categoryManager.getCategoryCount(siteid)`. */
  categoryCount: number;
  /** The site's category tree from its roots, each level in `getCategories` (name) order. */
  categories: readonly SiteFlatCategory[];
  customIcons?: CustomIconLookup;
}

/** The `flatViewArgs` the view stores for the site (loadsiteflat.cfm:108-136); an existing key keeps its spelling. */
function flatViewArgsEffect(
  event: SiteFlatEvent,
  customTagGroups: string,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const entries: [string, unknown][] = [
    ['moduleid', eventValue(event, 'moduleid')],
    ['sortBy', eventValue(event, 'sortby')],
    ['sortDirection', eventValue(event, 'sortdirection')],
    ['lockid', eventValue(event, 'lockid')],
    ['assignments', eventValue(event, 'assignments')],
    ['categoryid', eventValue(event, 'categoryid')],
    ['tags', eventValue(event, 'tags')],
    ['page', eventValue(event, 'page')],
    ['type', eventValue(event, 'type')],
    ['subtype', eventValue(event, 'subtype')],
    ['report', eventValue(event, 'report')],
    ['keywords', eventValue(event, 'keywords')],
    ['filtered', yesNoFormat(eventValue(event, 'filtered'))],
    ['tab', 1],
  ];
  // The session copy splits tag groups on ',' only; the filters split them on '^' and ','.
  for (const group of listItems(customTagGroups)) entries.push([`${group}tags`, eventValue(event, `${group}tags`)]);
  return structSet(current, entries);
}

/** `<cf_dsp_categories_nest>` (carch/dsp_categories_nest.cfm), writing into the caller's buffer. */
function renderCategoriesNest(
  out: CfOut,
  nodes: readonly SiteFlatCategory[],
  nestLevel: number,
  categoryIds: string,
): void {
  if (nodes.length === 0) return;
  out.t('\n<ul', nestLevel === 0 ? ' id="mura-nodes"' : '', ' class="categories', nestLevel === 0 ? ' checkboxTree' : '', '">\n');
  for (const node of nodes) {
    out.t('\n<li>\n');
    if (node.isopen === 1) {
      out.t('<input type="checkbox" name="categoryID" class="checkbox" ');
      if (cfListToArray(categoryIds).includes(node.categoryid)) out.t('checked');
      out.t(' value="', node.categoryid, '"/> ');
    }
    out.t(esapiEncode('html', node.name)).ws();
    if (node.kids.length > 0) {
      out.ws();
      renderCategoriesNest(out, node.kids, nestLevel + 1, categoryIds);
      out.ws();
    }
    out.t('\n</li>\n');
  }
  out.t('\n</ul>\n');
}

const TYPE_FILTER_TYPES = ['Calendar', 'Component', 'File', 'Folder', 'Form', 'Gallery', 'Link', 'Page'];
const REPORTS_WITH_DUE_DATE = 'mysubmissions,myapprovals';

/** The `navReportsShowing` block: report menu and, when rows show, the sort buttons (loadsiteflat.cfm:417-478). */
function renderReportMenu(out: CfOut, model: LoadSiteFlatModel, ctx: AdminRenderContext, hasNext: boolean): void {
  const { labels } = ctx;
  const report = eventText(model.event, 'report');
  const sortBy = eventText(model.event, 'sortby');
  const counts = model.reportCounts;
  const lockedLabel = labels.key(
    ctx.siteSettings.hasLockableNodes ? 'sitemanager.reports.mylockedcontent' : 'sitemanager.reports.mylockedfiles',
  );
  let showing = labels.key('sitemanager.reports.all');
  if (javaTrim(report) !== '') showing = cfEq(report, 'mylockedcontent') ? lockedLabel : labels.key(`sitemanager.reports.${report}`);
  const active = (name: string): string => (cfEq(report, name) ? ' class="active"' : '');
  const badge = (n: number): string => (n !== 0 ? `<span class="badge badge-important">${num(n)}</span>` : '');
  const item = (name: string, count?: number): string =>
    `<li><a href="" data-report="${name}"${active(name)}>${labels.key(`sitemanager.reports.${name}`)}` +
    `${count === undefined ? '' : badge(count)}</a></li>`;

  out.t('\n\n\n<div id="navReportsShowing">\n\t<div class="btn-group">\n\t').ws();
  out.t('\n\t<span>', labels.key('sitemanager.reports'), ':</span>\n\t<a id="navReportsToggle" class="dropdown-toggle" ');
  out.t('data-toggle="dropdown">', esapiEncode('html', showing), '<i class="mi-chevron-down"></i></a>\n\t\t');
  out.t('<ul id="navReports" class="dropdown-menu">\n\t\t\t<li><a href="" data-report=""', report === '' ? ' class="active"' : '');
  out.t('>', labels.key('sitemanager.reports.all'), '</a></li>\n\t\t\t');
  out.t('\n\t\t\t', item('mydrafts', counts.mydrafts), '\n\t\t\t');
  out.t('\n\t\t\t', item('mysubmissions', counts.mysubmissions), '\n\t\t\t');
  out.t('\n\t\t\t', item('myapprovals', counts.myapprovals), '\n\t\t\t');
  out.t('\n\t\t\t', item('myexpires', counts.myexpires), '\n\t\t\t', item('expires'), '\n\t\t\t');
  out.t('\n\t\t\t<li><a href="" data-report="mylockedcontent"', active('mylockedcontent'), '>\n\t\t\t\t').ws();
  out.t(lockedLabel).ws().ws().t(badge(counts.mylockedcontent), '</a></li>\n\t\t</ul>\n\t</div>\n\n\t');

  if (hasNext) {
    const sortButton = (name: string, label: string): string =>
      `<a href="" data-sortby="${name}" class="btn${cfEq(sortBy, name) ? ' active' : ''}">${labels.key(label)}</a>`;
    out.t('\n\t\t<div class="navSort">\n\t\t\t<span class="hidden-xs hidden-sm">', labels.key('sitemanager.sortby'));
    out.t(':</span>\n\t\t\t<div class="mura-input-set">\n\t\t\t\t', sortButton('lastupdate', 'sitemanager.lastupdated'));
    out.t('\n\t\t\t\t', sortButton('created', 'sitemanager.created'), '\n\t\t\t\t');
    out.t(sortButton('menutitle', 'sitemanager.title'), '\n\t\t\t\t');
    if (listFindNoCase(REPORTS_WITH_DUE_DATE, report)) out.t('\n\t\t\t\t\t', sortButton('duedate', 'sitemanager.duedate'), '\n\t\t\t\t');
    out.ws();
    if (listFindNoCase('myexpires,expires', report)) {
      out.t('\n\t\t\t\t\t', sortButton('expiration', 'sitemanager.expiration'), '\n\t\t\t\t');
    }
    out.t('\n\t\t\t</div>\n\t\t</div> <!-- ./navSort -->\n\t');
  }
}

/** One tag chip of the tag filters (loadsiteflat.cfm:526-531, 540-545); `indent` is the chip's tab depth. */
function tagChip(tag: string, inputName: string, indent: string): string {
  return (
    `\n${indent}<span class="tag">\n${indent}${esapiEncode('html', tag)} <a><i class="mi-times-circle"></i></a>` +
    `\n${indent}<input name="${inputName}" type="hidden" value="${esapiEncode('html_attr', tag)}">\n${indent}</span>` +
    `\n${indent.slice(1)}`
  );
}

/** The `navFilters` block: keywords, type, tags, categories and the filter buttons (loadsiteflat.cfm:481-581). */
function renderFilters(
  out: CfOut,
  model: LoadSiteFlatModel,
  ctx: AdminRenderContext,
  flatArgs: Readonly<Record<string, unknown>>,
): void {
  const { labels } = ctx;
  const { event, customTagGroups } = model;
  const type = eventText(event, 'type');
  const subtype = eventText(event, 'subtype');
  const tagGroups = listItems(customTagGroups, '^,');

  out.t('\n\n</div> \n\n<div id="navFilters">\n\t<div id="navFiltersToggle">', labels.key('sitemanager.filters'));
  out.t('<i class="mi-chevron-down"></i></div>\n\t<div id="navFilterControls">\n\t\t<div class="mura-layout-row">\n\n\t\t\t');
  out.t('\n\t\t\t<div class="mura-6 mura-control-group">\n\t\t\t\t<label>', labels.key('sitemanager.keywords'));
  out.t('</label>\n\t\t    <input class="text" id="contentKeywords" value="');
  out.t(esapiEncode('html_attr', str(structGet(flatArgs, 'keywords') as string | number | undefined)));
  out.t('" type="text">\n\t  \t</div>\n\t\t\t\n\n\t\t\t\n\t\t\t');

  if (!cfEq(eventText(event, 'report'), 'lockedfiles')) {
    out.t('\n\t\t\t\t<div class="mura-3 mura-control-group">\n\t\t\t\t\t<label>', labels.key('sitemanager.type'));
    out.t('</label>\n\t\t\t\t\t<select name="contentTypeFilter" id="contentTypeFilter">\n\t\t\t\t\t\t<option value="">');
    out.t(labels.key('sitemanager.all'), '</option>\n\t\t\t\t\t\t');
    for (const t of TYPE_FILTER_TYPES) {
      out.ws();
      if (t !== 'Gallery') {
        const typeLabel = labels.key(`sitemanager.content.type.${t}`);
        const selected = (sub: string): string => (cfEq(type, t) && cfEq(subtype, sub) ? ' selected' : '');
        out.t('\n\t\t\t\t\t\t\t\t<option value="', t, '^Default"', selected('Default'), '>', typeLabel);
        out.t('</option>\n\t\t\t\t\t\t\t\t').ws();
        // A query of queries: `=` and `!=` on strings are case-sensitive, and a NULL adminonly passes `!= 1`.
        const subtypes = filteredSubtypes(model).filter(
          (row) => (row.type ?? '') === t && (row.subtype ?? '') !== 'Default' && (model.powerUser || row.adminonly !== 1),
        );
        for (const row of subtypes) {
          out.t('\n\t\t\t\t\t\t\t\t\t<option value="', t, '^', str(row.subtype), '"', selected(str(row.subtype)), '>');
          out.t(typeLabel, ' / ', str(row.subtype), '</option>\n\t\t\t\t\t\t\t\t');
        }
        out.ws();
      }
      out.ws();
    }
    out.t('\n\t\t\t\t\t</select>\n\t\t\t\t</div>\n\t\t\t');
  }

  out.t('\n\t\t\t\n\n\t\t\t\n\t\t\t\t<div id="tags" class="mura-3 mura-control-group mura-filter-tags tagSelector">\n\t\t\t\t\t');
  out.t('\n\t\t\t   \t\t<label>', labels.key(customTagGroups === '' ? 'sitemanager.tags' : 'sitemanager.defaulttags'));
  out.t('</label>\n\t\t   \t\t\n\n\t\t\t\t\t<input type="text" name="tags">\n\t\t\t\t\t');
  for (const tag of listItems(eventText(event, 'tags'))) out.t(tagChip(tag, 'tags', '\t\t\t\t\t\t'));
  out.t('\n\t\t\t\t</div>\n\n\t\t\t');
  if (customTagGroups !== '') {
    out.ws();
    for (const group of tagGroups) {
      out.t('\n\t\t\t\t\t<div id="', group, 'tags" class="mura-3 mura-control-group mura-filter-tags tagSelector">\n\t\t\t\t\t\t');
      out.t('<label>', group).ws().t(labels.key('sitemanager.tags'), '</label>\n\t\t\t\t\t\t<input type="text" name="');
      out.t(group, 'tags">\n\t\t\t\t\t\t');
      for (const tag of listItems(eventText(event, `${group}tags`))) out.t(tagChip(tag, `${group}tags`, '\t\t\t\t\t\t\t'));
      out.t('\n\t\t\t\t\t</div>\n\t\t\t\t');
    }
    out.ws();
  }
  out.ws();

  if (model.categoryCount !== 0) {
    out.t('\n\t\t\t\t<div id="mura-list-tree" class="mura-6 mura-control-group category-select">\n\t\t\t\t\t<label>');
    out.t(labels.key('sitemanager.categories'), '</label>\n\t\t\t\t\t<div id="category-select-control"></div>');
    out.t('\n\t\t\t\t\t<div id="category-select-list">\n\t\t\t\t\t\t');
    renderCategoriesNest(out, model.categories, 0, eventText(event, 'categoryid'));
    out.t('\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n\t\t\t');
  }

  const filterButton =
    '\n\t\t\t\t\t\t<button type="submit" class="btn btn-default mura-primary" name="filterList" ' +
    `onclick="siteManager.loadSiteFlatByFilter();"><i class="mi-filter"></i> ${labels.key('sitemanager.filter')}</button>`;
  out.t('\n\t\t\t\n\n\t\t\t\n\t\t\t<div id="navFilterButtons" class="mura-actions mura-5">\n\t\t\t\t<div class="form-actions">');
  out.t('\n\t\t\t\t\t');
  if (cfToBoolean(structGet(flatArgs, 'filtered'))) {
    out.t('\n\t\t\t\t\t\t<button type="submit" class="btn btn-default" name="filterList" onclick="clearFlatviewFilter()">');
    out.t('<i class="mi-times-circle"></i> ', labels.key('sitemanager.removefilter'), '</button>');
  }
  out.t(filterButton, '\n\t\t\t\t\t');
  out.t('\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t\t\n\n\t\t</div> \n\t</div>\t\n</div>\t\n\n\t');
}

/** `rsTypes`: the session site's subtypes, without admin-only ones for users who are not power users (loadsiteflat.cfm:91-102). */
function filteredSubtypes(model: LoadSiteFlatModel): readonly SiteManagerSubtype[] {
  return model.powerUser ? model.subtypes : model.subtypes.filter((row) => row.adminonly !== 1);
}

const IMAGE_FILE_EXTENSIONS = 'png,jpg,jpeg,gif';
const RECURSIVE_DELETE_TYPES = 'Page,Portal,Calendar,Gallery,Link,File';

/** One `<tr>` of the flat list (loadsiteflat.cfm:584-747); the caller has skipped `deny` rows. */
function renderFlatRow(out: CfOut, row: SiteFlatRow, model: LoadSiteFlatModel, ctx: AdminRenderContext, tagLabel: string): void {
  const { labels, session, siteSettings } = ctx;
  const { event } = model;
  const report = eventText(event, 'report');
  const startRow = eventValue(event, 'startrow');
  const siteId = str(row.siteid);
  const contentId = str(row.contentid);
  const histId = str(row.contenthistid);
  const parentId = str(row.parentid);
  const moduleId = str(row.moduleid);
  const type = str(row.type);
  const lockId = str(row.lockid);
  const verdict = row.verdict;
  const isLocked = siteSettings.hasLockableNodes && lockId !== '' && cfEq(str(row.locktype), 'node');
  const isLockedBySomeoneElse = isLocked && !cfEq(lockId, session.userId);
  const newcontent = newContentPerm(undefined, verdict, siteSettings.locking);
  const topId = cfEq(contentId, HOME_ID) ? contentId : parentId;
  const locking = siteSettings.locking;
  const deletable =
    ((!cfEq(parentId, HOME_ID) && !cfEq(locking, 'all')) || (cfEq(parentId, HOME_ID) && cfEq(locking, 'none'))) &&
    verdict === 'editor' &&
    row.islocked !== 1 &&
    !cfEq(contentId, HOME_ID);
  const query: AdminParam[] = [
    ['contentid', contentId, 'raw'],
    ['type', type, 'raw'],
    ['parentid', parentId, 'raw'],
    ['topid', topId],
    ['siteid', siteId],
    ['moduleid', moduleId, 'raw'],
  ];
  const editLink = viewAdminUrl('cArch.edit', [['contenthistid', histId, 'raw'], ...query, ['startrow', str(startRow), 'raw']]);
  const listLink = (action: `${string}.${string}`): string => viewAdminUrl(action, [...query, ['startrow', str(startRow)]]);
  const previewable = cfEq(moduleId, SITE_TREE_MODULE) || (cfEq(moduleId, '00000000000000000000000000000000099') && cfEq(type, 'Variation'));
  const url = (): string => contentUrl(ctx.site, row, { complete: true });

  out.t('\n\n\t\t<tr data-siteid="', siteId, '" data-contentid="', contentId, '" data-contenthistid="', histId);
  out.t('" data-sortby="', str(row.sortby), '" data-sortdirection="', str(row.sortdirection), '" data-moduleid="');
  out.t(esapiEncode('html_attr', moduleId), '" data-type="', type, '" class="mura-node-data">\n\t\t\t<td class="add">');
  out.t(`<a class="add" href="javascript:;"  onclick="siteManager.showMenu('newContentMenu','${newcontent}',this,`);
  out.t(`'${contentId}','${contentId}','${contentId}','${siteId}','${type}','${moduleId}');"><i class="mi-ellipsis-v"></i></a>`);
  out.t('</td>\n\t\t\t<td class="var-width item">\n\n\t\t\t<div class="actions">\n\t\t\t\t<ul class="siteSummary">\n\t\t\t\t\t');

  if (!['none', 'read'].includes(verdict) || cfEq(report, 'mydrafts')) {
    out.t('\n\n\t\t\t\t\t    <li class="edit', isLockedBySomeoneElse ? ' disabled' : '', '"><a title="Edit" ');
    out.t('onclick="draftprompt.call(this,event);return false;" data-siteid="', siteId, '" data-contentid="', contentId);
    out.t('" data-contenthistid="', histId, '" href="" data-href="', editLink, '"><i class="mi-pencil"></i></a></li>\n\t\t\t\t\t\t');
    if (previewable) {
      out.ws().ws();
      if (cfEq(type, 'File')) {
        out.t('\n\t\t\t\t\t\t\t<li class="download"><a title="', labels.key('sitemanager.download'), '" href="');
        out.t(ctx.config.context, '/index.cfm/_api/render/file/?fileID=', str(row.fileid), '&method=attachment" ');
        out.t(`onclick="return confirmDialog('${esapiEncode('javascript', labels.key('sitemanager.downloadconfirm'))}',`);
        out.t('this.href)"><i class="mi-download"></i></a></li>\n\t\t\t\t\t\t\t');
      } else {
        out.t('\n\t\t\t\t\t\t\t<li class="preview"><a title="', labels.key('sitemanager.preview'), '" href="', url());
        out.t('"><i class="mi-globe"></i></a></li>\n\t\t\t\t\t\t\t');
      }
      out.ws().ws();
    }
    out.t('\n\t\t\t\t\t\t <li class="version-history"><a title="Version History" href="', listLink('cArch.hist'));
    out.t('"><i class="mi-history"></i></a></li>\n\n\t\t\t\t\t\t');
    if (cfEq(type, 'Form')) {
      const manageData = viewAdminUrl('cArch.datamanager', [
        ['contentid', contentId],
        ['siteid', siteId],
        ['topid', topId],
        ['moduleid', moduleId],
        ['type', 'Form', 'raw'],
        ['parentid', parentId],
      ]);
      out.t('\n\t\t\t\t \t\t\t<li class="manage-data"><a title="', labels.key('sitemanager.content.managedata'));
      out.t('"  href="', manageData, '"><i class="mi-wrench"></i></a></li>\n\t\t\t\t \t\t');
    }
    out.ws();
    if (isSiteAdmin(session, siteSettings.privateUserPoolId) || isS2(session)) {
      out.t('\n\t\t\t\t\t        <li class="permissions"><a title="', labels.key('sitemanager.permissions'), '" href="');
      out.t(listLink('cPerm.main'), '"><i class="mi-group"></i></a></li>\n\t\t\t\t\t    ');
    } else {
      out.t('\n\t\t\t\t\t\t\t<li class="permissions disabled"><a><i class="mi-group"></i></a></li>\n\t\t\t\t\t\t');
    }
    out.ws();
    if (deletable && !isLockedBySomeoneElse) {
      const menuTitle = str(row.menutitle);
      const confirm = listFindNoCase(RECURSIVE_DELETE_TYPES, type)
        ? labels.messageFormat(labels.key('sitemanager.content.deletecontentrecursiveconfirm'), menuTitle)
        : labels.key('sitemanager.content.deletecontentconfirm');
      const deleteLink = viewAdminUrl('cArch.update', [
        ['contentid', contentId, 'raw'],
        ['type', type, 'raw'],
        ['action', 'deleteall', 'raw'],
        ['topid', topId],
        ['siteid', siteId],
        ['moduleid', moduleId, 'raw'],
        ['parentid', parentId],
        ['startrow', str(startRow)],
      ]);
      out.t('\n\t\t\t\t\t        <li class="delete"><a title="', labels.key('sitemanager.delete'), '" href="', deleteLink);
      out.t(renderCsrfTokensUrl(ctx.csrf(`${contentId}deleteall`)), '"');
      out.t(`onclick="return confirmDialog('${esapiEncode('javascript', confirm)}',this.href)"`);
      out.t('>\n\t\t\t\t\t\t\t<i class="mi-trash"></i></a></li>\n\t\t\t\t\t    ');
    } else if (!cfEq(eventText(event, 'locking'), 'all')) {
      out.t('\n\t\t\t\t\t        <li class="delete disabled"><i class="mi-trash"></i></li>\n\t\t\t\t\t    ');
    }
    out.ws();
  } else {
    out.t('\n\t\t\t\t\t    <li class="edit disabled"><i class="mi-pencil"></i></li>\n\t\t\t\t\t\t');
    if (previewable) out.t('\n\t\t\t\t\t\t<li class="preview"><a title="Preview" href="', url(), '"><i class="mi-globe"></i></a></li>\n\t\t\t\t\t\t');
    out.t('\n\t\t\t\t\t\t<li class="version-history disabled"><a><i class="mi-history"></i></a></li>');
    out.t('\n\t\t\t\t\t\t<li class="permissions disabled"><a><i class="mi-group"></i></a></li>');
    out.t('\n\t\t\t\t\t\t<li class="delete disabled"><a><i class="mi-trash"></i></a></li>\n\t\t\t\t\t');
  }
  out.t('\n\n\t\t\t\t</ul>\n\t\t\t</div>\n\t\t\t');

  if (listFindNoCase(IMAGE_FILE_EXTENSIONS, str(row.fileext))) {
    // `hasCustomImage` tests getMetaData(imageProcessor) for a `getCustomImage` key, which component metadata never has.
    const src = contentImageUrl(ctx.site, row, { size: 'small', useProtocol: false });
    out.t('\n\t\t\t<div class="thumbnail"><a title="Edit" class="draftprompt" href="', editLink, '"><img src="', src);
    out.t('" /></a></div>\n\t\t\t');
  }
  out.ws();
  if (lockId !== '') {
    out.ws().ws();
    const lockedBy = `${esapiEncode('html_attr', row.lockedBy?.fname ?? '')} ${esapiEncode('html', row.lockedBy?.lname ?? '')}`;
    const lockKey = !cfEq(str(row.locktype), 'node')
      ? 'sitemanager.filelockedby'
      : siteSettings.hasLockableNodes
        ? 'sitemanager.nodelockedby'
        : undefined;
    if (lockKey !== undefined) {
      out.t('\n\t\t\t\t\t\t<p class="locked-offline"><i class="mi-lock"></i> ');
      out.t(labels.messageFormat(labels.key(lockKey), lockedBy), '</p>\n\t\t\t\t\t');
    }
    out.ws();
  }

  out.t('\n\n\t\t\t\t<h2>\n\t\t\t\t\t');
  const approvalReport = listFindNoCase('myapprovals,mysubmissions', report);
  if (!['none', 'read'].includes(verdict) || approvalReport) {
    out.t('\n\t\t\t\t\t\t<a class="draftprompt" title="', labels.key('sitemanager.edit'), '" class="draftprompt"  href="');
    out.t(editLink, '">', esapiEncode('html', row.menutitle)).ws();
    if (approvalReport) {
      const status = cfEq(str(row.approvalstatus), 'Pending') ? 'sitemanager.content.pending' : 'sitemanager.content.draft';
      out.t('\n\t\t\t\t\t\t\t\t(', labels.key(status), ')\n\t\t\t\t\t\t\t');
    }
    out.t('\n\n\t\t\t\t\t\t</a>\n\t\t\t\t\t');
  } else {
    out.ws().t(esapiEncode('html', row.menutitle)).ws();
  }
  out.t('\n\t\t\t\t</h2>\n\t\t\t\t');
  if (row.crumbs.length > 0) {
    out.t('\n\t\t\t\t\t<span class="breadcrumb-label">', labels.key('sitemanager.content.fields.location'), ': </span>');
    out.t(renderZoom(row.crumbs, { ajax: true, class: 'breadcrumb', customIcons: model.customIcons ?? NO_CUSTOM_ICONS })).ws();
  }
  out.t('\n\t\t\t\t<ul class="nodeMeta">\n\t\t\t\t\t').ws();
  renderNodeMeta(out, row, ctx, tagLabel);
  out.t('\n\t\t\t\t</ul>\n\t\t\t</tr>\n\t\t');
}

/** The `nodeMeta` items of a row (loadsiteflat.cfm:718-743), quirks included: the stray `</` and `</dd>`. */
function renderNodeMeta(out: CfOut, row: SiteFlatRow, ctx: AdminRenderContext, tagLabel: string): void {
  const { labels, session } = ctx;
  const dateMask = session.dateKeyFormat;
  if (row.majorversion !== null && row.majorversion !== 0) {
    out.t('<li class="version">', labels.key('sitemanager.version'), ': <strong>', num(row.majorversion), '.');
    out.t(num(row.minorversion), '</strong></li>');
  }
  out.ws();
  const dueDate = row.duedate ?? null;
  if (dueDate !== null) {
    out.t('<li class="duedate">', labels.key('sitemanager.duedate'), ': <strong>', lsDateFormat(dueDate, dateMask));
    out.t('</strong></li></');
  } else if (row.expires !== null) {
    out.t('<li class="expiration">', labels.key('sitemanager.expiration'), ': <strong>', lsDateFormat(row.expires, dateMask));
    out.t('</strong></li>');
  }
  out.ws();
  if (row.filesize !== null && row.filesize !== 0) {
    out.t('<li class="size">', labels.key('sitemanager.size'), ': <strong>', renderFileSize(row.filesize), '</strong></li>');
  }
  out.ws().ws();
  if (row.categories.length > 0) {
    out.t('\n\t\t\t\t\t<li class="categories">', labels.key('sitemanager.categories'), ': <strong>\n\t\t\t\t\t\t');
    row.categories.forEach((name, i) => {
      out.ws().ws().t(esapiEncode('html', name));
      if (i < row.categories.length - 1) out.t(', ');
      out.ws();
    });
    out.t('\n\t\t\t\t\t\t</strong>\n\t\t\t\t\t');
  }
  out.t('</dd>\n\t\t\t\t\t');
  const tags = str(row.tags);
  if (tags !== '') out.t('<li class="tags">', tagLabel, ': <strong>', tags, '</strong></li>');
  const updated = [lsDateFormat(row.lastupdate, dateMask), lsTimeFormat(row.lastupdate, 'medium'), str(row.lastupdateby)];
  out.t('\n\t\t\t\t\t<li class="type">', labels.key('sitemanager.type'), ': <strong>', str(row.type), ' (', str(row.subtype));
  out.t(')</strong></li>\n\t\t\t\t\t<li class="updated-short" title="');
  out.t(labels.messageFormat(labels.key('sitemanager.lastupdatedlong'), updated));
  if (row.created !== null) {
    const created = [lsDateFormat(row.created, dateMask), lsTimeFormat(row.created, 'medium')];
    out.t(' / ', labels.messageFormat(labels.key('sitemanager.createdlong'), created));
  }
  out.t(' ">', labels.key('sitemanager.lastupdated'), ': <strong>', lsDateFormat(row.lastupdate, dateMask), '</strong></li>');
}

/** The `pagination` savecontent (loadsiteflat.cfm:391-410). */
function renderFlatPagination(ctx: AdminRenderContext, page: SiteFlatPage, totalRecords: number, eventPage: number): string {
  const out = new CfOut();
  if (page.count === 0) return '';
  const meta = ctx.labels.messageFormat(ctx.labels.key('sitemanager.paginationmeta'), [
    `${num(page.firstRecord)}-${num(page.lastRecord)}`,
    totalRecords,
  ]);
  out.t('\n\n\t\t<div class="mura-results-wrapper">\n\t\t<p class="search-showing">', meta, '</p>\n\t\t');
  if (page.pageCount > 1) {
    out.t('\n\t\t\t<ul class="moreResults pagination">\n\t\t\t\t');
    if (eventPage > 1) out.t('<li class="navPrev"><a href="" data-page="', num(eventPage - 1), '"><i class="mi-angle-left"></i></a></li>');
    out.ws();
    for (let p = Math.max(eventPage - 2, 1); p <= Math.min(eventPage + 2, page.pageCount); p++) {
      const active = eventPage === p ? ' class="active"' : '';
      out.t('\n\t\t\t\t<li', active, '><a href="" data-page="', num(p), '"', active, '>', num(p), '</a></li>\n\t\t\t\t');
    }
    out.ws();
    if (eventPage < page.pageCount) {
      out.t('<li class="navNext"><a href="" data-page="', num(eventPage + 1), '"><i class="mi-angle-right"></i></a></li>');
    }
    out.t('\n\t\t\t</ul>\n\t\t');
  }
  return `${out.t('\n\t\t</div>\n\t').ws().ws()}`;
}

/** The trailing `<script>` with `clearFlatviewFilter` (loadsiteflat.cfm:767-829). */
function renderFlatScript(out: CfOut, model: LoadSiteFlatModel, flatArgs: Readonly<Record<string, unknown>>, sortArgs: Readonly<Record<string, unknown>>): void {
  const js = (v: unknown): string => esapiEncode('javascript', str(v as string | number | undefined));
  out.t(
    '\n\n</div>\n</div>\n\n<script>\n\t// list view advanced filters\n  jQuery(document).ready(function(){\n\n',
    '  \tvar serializeCatCheckboxes = function(){\n\t\t\tvar catContainer = jQuery(\'#category-select-control\');\n',
    '  \t\tjQuery(catContainer).find(\'.tag\').remove();\n',
    '\t\t\tjQuery(\'#category-select-list input[type=checkbox]:checked\').each(function(){\n',
    '\t  \t\tvar thisText = $(this).parent(\'li\').clone().children().remove().end().text();\n',
    '\t  \t\tvar selCat = \'<span class="tag">\' + thisText + \'</span>\';\n\t  \t\tjQuery(selCat).appendTo(catContainer);\n\n',
    '  \t\t});\n  \t}\n  \tjQuery(\'#category-select-list input[type=checkbox]\').click(function(){\n',
    '  \t\t\tserializeCatCheckboxes();\n  \t});\n\t\tserializeCatCheckboxes();\n\n',
    '  \tjQuery(\'#category-select-list\').hide();\n  \tjQuery(\'#category-select-control\').click(function(){\n',
    '  \t\tjQuery(\'#category-select-list\').slideToggle(\'fast\');\n  \t})\n\n',
    '\t\tjQuery(\'#navFilterControls\').hide();\n\t\tvar toggleNavFilters = function(el){\n',
    '\t\t\tjQuery(\'#navFilterControls\').slideToggle(\'fast\');\n',
    '\t\t\tjQuery(el).find(\'i\').toggleClass(\'mi-chevron-down\').toggleClass(\'mi-chevron-up\');\n\t\t}\n\n',
    '\t\tjQuery(\'#navFiltersToggle\').click(function(){\n\t\t\ttoggleNavFilters(jQuery(this));\n\t\t})\n\n\t\t',
  );
  if (cfToBoolean(structGet(flatArgs, 'filtered'))) out.t('\n\t\t\ttoggleNavFilters(jQuery(\'#navFiltersToggle\'));\n\t\t');
  out.t(
    '\n\n\t\tjQuery(\'td.item\').on(\'click\',function(e){\n\t\t\tvar el = e.target;\n\t\t\tvar elType = el.tagName;\n',
    '\t\t\tvar editLink = $(el).find(\'a.draftprompt\');\n',
    '\t\t\tif (elType == \'TD\' || elType == \'UL\' || elType == \'H2\'){\n\t\t\t\t\t$(editLink).trigger(\'click\');\n\t\t\t}\n',
    '\t\t})\n\n  });\n\n\tfunction clearFlatviewFilter(){\n\t\tflatViewArgs=$.extend(\n\t\t\tinitFlatViewArgs(),\n',
    '\t\t\t{\n\t\t\t\t\treport:\'', js(structGet(flatArgs, 'report')), '\',\n\t\t\t\t\tsortby:\'', js(structGet(sortArgs, 'sortby')),
    '\',\n\t\t\t\t\tsortdirection:\'', js(structGet(sortArgs, 'sortdirection')), '\',\n\t\t\t\t\ttag:\'\',\n',
    '\t\t\t\t\ttype:\'\',\n\t\t\t\t\tsubtype:\'\',\n\t\t\t\t\tcategoryid:\'\',\n\t\t\t\t\tkeywords:\'\'\n\t\t\t\t\t,\n',
    '\t\t\t\t\tfiltered:false\n\t\t\t\t\t',
  );
  if (model.customTagGroups !== '') {
    out.ws();
    for (const group of listItems(model.customTagGroups, '^,')) out.t('\n\t\t\t\t\t,"', group, 'tags":\'\'\n\t\t\t\t\t');
    out.ws();
  }
  out.t('\n\n\t\t\t\t\t});\n\n\t\tsiteManager.loadSiteFlat(flatViewArgs);\n\t}\n</script>\n\n').ws();
}

/** `carch.loadsiteflat` (admin/core/views/carch/loadsiteflat.cfm): the Site Manager flat list, with its `flatViewArgs` write. */
export function renderLoadSiteFlat(model: LoadSiteFlatModel, ctx: AdminRenderContext): SiteManagerFragmentResult {
  const event = normalizeSiteFlatEvent(model.event);
  const siteId = eventText(event, 'siteid');
  const flatViewArgs = ctx.session.flatViewArgs;
  const siteArgs = flatViewArgsEffect(event, model.customTagGroups, structGet(flatViewArgs, siteId) ?? {});
  const nextFlatViewArgs = structSet<Readonly<Record<string, unknown>>>(flatViewArgs, [[siteId, siteArgs]]);
  // clearFlatviewFilter reads its sort from the session site's entry, which legacy requires to exist.
  const sortArgs = structGet(nextFlatViewArgs, ctx.session.siteId);
  if (sortArgs === undefined) throw new RangeError(`Element ${ctx.session.siteId} is undefined in SESSION.FLATVIEWARGS`);

  const eventPage = cfToNumber(eventValue(event, 'page'));
  const page = siteFlatPage(model.totalRecords, eventPage);
  if (model.rows.length !== page.count) {
    throw new RangeError(`Page ${num(page.pageIndex)} shows ${num(page.count)} rows; ${num(model.rows.length)} were given`);
  }
  const flatModel = { ...model, event };
  const tagLabel = ctx.labels.key(model.customTagGroups === '' ? 'sitemanager.tags' : 'sitemanager.defaulttags');
  const pagination = renderFlatPagination(ctx, page, model.totalRecords, eventPage);

  const out = new CfOut().t('\n\n<div class="mura-layout-row">\n\t');
  renderReportMenu(out, flatModel, ctx, page.count > 0);
  renderFilters(out, flatModel, ctx, siteArgs);
  if (page.count > 0) {
    out.ws().t(pagination, '\n\n\t<table class="mura-table-grid">\n\t\t').ws();
    for (const row of model.rows) {
      out.ws();
      if (row.verdict !== 'deny') renderFlatRow(out, row, flatModel, ctx, tagLabel);
    }
    out.t('\n\t</table>\n\n\t', pagination).ws();
  } else {
    out.t('\n\t\t<div class="help-block-empty">', ctx.labels.key('sitemanager.noresults'), '</div>\n\t');
  }
  renderFlatScript(out, flatModel, siteArgs, sortArgs);
  return {
    status: 200,
    contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE,
    body: `${out}`,
    sessionEffects: { flatViewArgs: nextFlatViewArgs },
  };
}

// --- carch.siteparents ---

/** A `getPrivateSearch` result row with the lookups siteparents.cfm:121-124 makes for it. */
export interface SiteParentsRow {
  contentid: string;
  /** `contentManager.getCrumbList(contentid, siteid)`. */
  crumbs: readonly SiteManagerCrumb[];
  /** `permUtility.getnodePerm(crumbs)`. */
  verdict: NodePerm;
}

/** Everything siteparents.cfm reads besides the render context. */
export interface SiteParentsModel {
  siteId: string;
  contentId: string;
  parentId: string;
  /** `rc.keywords`, '' when absent. */
  keywords: string;
  /** `rc.isNew` (default true): a new content item shows the search box only. */
  isNew: boolean;
  /** `content.loadBy(contentID=parentid)`: absent when no such content exists, so its module reads as the site tree's. */
  parent?: {
    moduleId: string;
    /** `contentManager.getCrumbList(parentid, siteid)`. */
    crumbs: readonly SiteManagerCrumb[];
  };
  /** `contentGateway.getTop(siteid, topid=<parent module>)` title; read when the parent is in a module tree. */
  moduleTopTitle?: string;
  /** `contentManager.getPrivateSearch(siteid, keywords, moduleid=<parent module>)` rows, in order. */
  rows: readonly SiteParentsRow[];
  customIcons?: CustomIconLookup;
}

const SITE_PARENTS_SCRIPT =
  '\n\n<script type="text/javascript">\n\t$(document).ready(function(){\t\n\t\t$(\'#parentSearch\').on(\'keypress\',function(e){\n' +
  '\t\t\tif(e.which == 13) {\n\t\t\t\tvar pval = $(this).val();\n\t\t\t\t$(\'#parentSearchSubmit\').trigger(\'click\');\n' +
  '\t\t\t\tsetTimeout(function(){\t\t\t\t\t\t\n\t\t\t\t$(\'#parentSearch\').focus();\t\n\t\t\t\t},\'250\')\t\n' +
  '\t\t\t\treturn false;\n\t\t  \t}\n\t\t})\n\t})\n</script>';

/** `carch.siteparents` (admin/core/views/carch/siteparents.cfm): the new-parent search and radio list of the move dialog. */
export function renderSiteParents(model: SiteParentsModel, ctx: AdminRenderContext): SiteManagerFragmentResult {
  const { labels } = ctx;
  const icons = model.customIcons ?? NO_CUSTOM_ICONS;
  const hiddenParent = `<input type="hidden" id="parentid" name="parentid" value="${esapiEncode('html_attr', model.parentId)}" />`;
  const out = new CfOut().t('\n<div class="form-inline">\n<h2>', labels.key('sitemanager.content.fields.searchforcontent'));
  out.t('</h2>\n<div class="mura-input-set">\n\t<input id="parentSearch" name="parentSearch" value="" type="text" class="text" ');
  out.t('maxlength="50" onclick="return false;">\n\t<input id="parentSearchSubmit" type="button" class="btn" ');
  out.t(`onclick="siteManager.loadSiteParents('${model.siteId}','${model.contentId}','${model.parentId}',`);
  out.t(`document.getElementById('parentSearch').value,0);return false;" value="`);
  out.t(labels.key('sitemanager.content.fields.search'), '">\n</div>\n\n</div>\n');

  if (model.isNew) {
    out.t(hiddenParent).ws();
    return { status: 200, contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE, body: `${out.t(SITE_PARENTS_SCRIPT)}` };
  }

  const parent = model.parent;
  const parentModule = parent?.moduleId ?? SITE_TREE_MODULE;
  let counter = 0;
  let hasParentId = false;
  out.t('\n <table class="mura-table-grid">\n  ');
  if (parent !== undefined) {
    out.t('\n\t\t<tr>\n\t\t  <th class="actions"></th>\n\t    <th class="var-width">');
    out.t(labels.key('sitemanager.content.fields.selectnewcontentparent'), '</th>\n    </tr>\n\t');
  }
  if (model.rows.length > 0 || SPECIAL_MODULES.includes(parentModule)) {
    if (parent !== undefined && !SPECIAL_MODULES.includes(model.parentId)) {
      out.t('\n\t\t\t<tr class="alt">\n\t\t\t\t<td class="actions"><input type="radio" name="parentid" value="');
      out.t(esapiEncode('html_attr', model.parentId), '" checked="checked"></td>\n\t\t\t\t <td class="var-width">');
      out.t(renderZoomNoLinks(parent.crumbs, icons), '</td>\n\t\t\t</tr>').ws();
      hasParentId = true;
    }
    const topTitle = model.moduleTopTitle ?? '';
    // reFindNoCase(rc.keywords, title): the keywords are the pattern, and '' matches.
    if (SPECIAL_MODULES.includes(parentModule) && new RegExp(model.keywords, 'i').test(topTitle)) {
      out.t('\n\t\t\t\t<tr class="alt">\n\t\t\t\t\t<td class="actions"><input type="radio" name="parentid" value="');
      out.t(esapiEncode('html_attr', parentModule), '" ', cfEq(model.parentId, parentModule) ? 'checked="checked"' : '');
      out.t('></td>\n\t\t\t\t\t <td class="var-width"><ul class="navZoom"><li class="mi-cog "> ', esapiEncode('html', topTitle));
      out.t('</li></ul></td>\n\t\t\t\t</tr>').ws();
      hasParentId = true;
      counter++;
    }
    for (const row of model.rows.slice(0, 150)) {
      out.ws();
      if (!cfEq(row.contentid, model.parentId)) {
        out.ws().ws().ws();
        const ancestry = row.crumbs[0]?.parentarray;
        if (row.verdict !== 'none' && ancestry !== undefined && !ancestry.includes(model.contentId)) {
          counter++;
          hasParentId = true;
          out.ws().ws().t('\n\t\t\t\t\t\t<tr ', counter % 2 === 0 ? 'class="alt"' : '', '>\n\t\t\t\t\t\t  <td class="actions">');
          out.t('<input type="radio" name="parentid" value="', row.contentid, '"></td>\n\t\t\t        <td class="var-width">');
          out.t(renderZoomNoLinks(row.crumbs, icons), '</td>\n\t\t\t\t\t\t</tr>\n\t\t\t\t \t');
        }
        out.ws();
      }
      out.ws();
    }
    out.ws();
  }
  if (counter === 0) {
    out.t('\n\t\t\t<tr class="alt">\n\t\t\t  <td class="noResults" colspan="2">', labels.key('sitemanager.noresults'));
    out.t('</td>\n\t\t\t</tr>').ws();
  }
  out.t('\n  </table>\n</td></tr></table>\n');
  if (!hasParentId) out.t(hiddenParent).ws();
  return { status: 200, contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE, body: `${out.t(SITE_PARENTS_SCRIPT)}` };
}

// --- carch.loadnewcontentmenu ---

/** Everything loadnewcontentmenu.cfm reads besides the render context; `rc` values are after carch.before(). */
export interface NewContentMenuModel {
  siteId: string;
  /** `rc.contentid`: the node the new content goes under. */
  contentId: string;
  /** `rc.contenthistid`; carch.before() defaults it to a new CF UUID. */
  contentHistId: string;
  topId: string;
  moduleId: string;
  /** `rc.ptype`, default `Page`. */
  ptype: string;
  /** `rc.compactDisplay`, default `false`. */
  compactDisplay: string;
  /** `isDefined('rc.frontEndProxyLoc')`: the front-end toolbar's menu, which legacy renders in the admin layout. */
  frontEndProxyLoc: boolean;
  /** `$.currentUser().isAdminUser() or $.currentUser().isSuperUser()`. */
  powerUser: boolean;
  /** The site renderer's `primaryContentTypes`, '' when unset. */
  primaryContentTypes: string;
  /** The node's subtype `getAvailableSubTypes()` (trimmed), '' when the subtype is undefined. */
  availableSubTypes: string;
  /** Subtypes of `rc.siteID`. */
  subtypes: readonly SiteManagerSubtype[];
  /** configBean `allowSimpleHTMLForms`. */
  allowSimpleHtmlForms: boolean;
  /** configBean `allowmultiupload`, default true. */
  allowMultiUpload: boolean;
  customIcons?: CustomIconLookup;
}

/** How one menu `<li>` is laid out in the template: tab depth, the tab depth after it and the tooltip form. */
interface MenuItemLayout {
  depth: number;
  tail: number;
  /** The tooltip anchor sits on the `<li>` line (subtype items) rather than on its own line. */
  inlineTip: boolean;
}

/** One `<li>` of the add-content menu. */
function menuItem(
  out: CfOut,
  layout: MenuItemLayout,
  item: { liClass: string; description: string; href: string; linkId: string; icon: string; span: string },
): void {
  const indent = '\t'.repeat(layout.depth);
  out.t(`\n${indent}<li class="${item.liClass}">\n${indent}\t`);
  if (item.description !== '') {
    const tip = `<a href="#" rel="tooltip" data-original-title="${esapiEncode('html_attr', item.description)}"><i class="mi-question-circle"></i></a>`;
    out.t(layout.inlineTip ? tip : `\n${indent}\t\t${tip}\n${indent}\t`);
  }
  out.t(`\n${indent}\t<a href="${item.href}" target="_top" id="${item.linkId}"><i class="${item.icon}"></i> <span>${item.span}</span></a>`);
  out.t(`\n${indent}</li>\n${'\t'.repeat(layout.tail)}`);
}

/** Renders loadnewcontentmenu.cfm's menu items for one model. */
class NewContentMenu {
  private readonly icons: CustomIconLookup;

  constructor(
    private readonly out: CfOut,
    private readonly model: NewContentMenuModel,
    private readonly ctx: AdminRenderContext,
  ) {
    this.icons = model.customIcons ?? NO_CUSTOM_ICONS;
  }

  /** `./?muraAction=<action>&contentid=&parentid=…` as the template writes it; `type` and `subType` are not encoded. */
  href(action: `${string}.${string}`, type: string, moduleId: string, subtype?: string, extra: AdminParam[] = []): string {
    const m = this.model;
    return viewAdminUrl(action, [
      ['contentid', '', 'raw'],
      ['parentid', m.contentId],
      ['parenthistid', m.contentHistId],
      ['type', type, 'raw'],
      ...(subtype === undefined ? [] : [['subType', subtype, 'raw'] satisfies AdminParam]),
      ['topid', m.topId],
      ['siteid', m.siteId],
      ['moduleid', moduleId],
      ['ptype', m.ptype],
      ['frontend', m.compactDisplay],
      ...extra,
    ]);
  }

  icon(type: string, subtype: string): string {
    return iconClassByContentType(this.icons, type, subtype, this.model.siteId);
  }

  /** `lower(subtype) = 'default'` rows of `type`, as the QoQ selects them. */
  defaultRows(type: string): readonly SiteManagerSubtype[] {
    return this.model.subtypes.filter((r) => (r.type ?? '').toLowerCase() === type.toLowerCase() && (r.subtype ?? '').toLowerCase() === 'default');
  }

  /** The non-default subtypes of `type` the user may add, admin-only ones for power users only. */
  subtypeRows(type: string): readonly SiteManagerSubtype[] {
    return this.model.subtypes.filter(
      (r) =>
        (r.type ?? '').toLowerCase() === type.toLowerCase() &&
        (r.subtype ?? '').toLowerCase() !== 'default' &&
        (this.model.powerUser || r.adminonly !== 1),
    );
  }

  /** `not len($availableSubTypes) or listFindNoCase($availableSubTypes, entry)`. */
  available(entry: string): boolean {
    return this.model.availableSubTypes === '' || listFindNoCase(this.model.availableSubTypes, entry);
  }

  /** The default-subtype gate: no definition, or one that is not admin-only, or a power user. */
  defaultAllowed(rows: readonly SiteManagerSubtype[]): boolean {
    const first = rows[0];
    return first === undefined || first.adminonly !== 1 || this.model.powerUser;
  }

  /** The `Default` item gate of `type` (loadnewcontentmenu.cfm:110-117 and its copies); `render` prints the item. */
  defaultItem(type: string, render: (description: string | null) => void): void {
    const rows = this.defaultRows(type);
    this.out.ws().ws();
    if (this.defaultAllowed(rows)) {
      this.out.ws();
      if (this.available(`${type}/Default`)) render(rows[0]?.description ?? null);
      this.out.ws();
    }
    this.out.ws();
  }

  typeItem(type: string, description: string | null, href: string, layout: MenuItemLayout, label?: string): void {
    menuItem(this.out, layout, {
      liClass: `new${type}`,
      description: str(description),
      href,
      linkId: `new${type}Link`,
      icon: this.icon(type, 'default'),
      span: label ?? this.ctx.labels.key(`sitemanager.add${type.toLowerCase()}`),
    });
  }

  /** The subtype items of `type` (loadnewcontentmenu.cfm:146-167 and its copies); plugin menu events render nothing. */
  subtypeItems(type: string, moduleId: string, layout: MenuItemLayout): void {
    this.out.ws().ws();
    for (const row of this.subtypeRows(type)) {
      const subtype = str(row.subtype);
      this.out.ws();
      if (this.available(`${type}/${subtype}`)) {
        this.out.ws().ws().ws();
        menuItem(this.out, layout, {
          liClass: `new${type}`,
          description: str(row.description),
          href: this.href('cArch.edit', type, moduleId, subtype),
          linkId: `new${type}Link`,
          icon: this.icon(type, subtype),
          span: ` ${subtype}`,
        });
        this.out.ws();
      }
      this.out.ws();
    }
    this.out.ws();
  }

  /** The multi-file upload item (loadnewcontentmenu.cfm:272-277 and its copies). */
  multiUploadItem(depth: number): void {
    const m = this.model;
    this.out.ws();
    if (!((m.allowMultiUpload && m.availableSubTypes === '') || listFindNoCase(m.availableSubTypes, 'File/Default'))) return;
    const indent = '\t'.repeat(depth);
    const href = this.href('cArch.multiFileUpload', 'File', SITE_TREE_MODULE);
    this.out.t(`\n${indent}<li class="newGalleryItemMulti">\n${indent}\t\n${indent}\t<a href="${href}" target="_top" `);
    this.out.t(`id="newGalleryItemMultiLink"><i class="${this.icon('Quick', 'default')}"></i> <span>`);
    this.out.t(this.ctx.labels.key('sitemanager.addmultiitems'), `</span></a>\n${indent}</li>\n${'\t'.repeat(depth - 1)}`);
  }
}

const FORMS_MODULE = '00000000000000000000000000000000004';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const VARIATIONS_MODULE = '00000000000000000000000000000000099';

/** `carch.loadnewcontentmenu` (admin/core/views/carch/loadnewcontentmenu.cfm): the add-content menu of a node. */
export function renderLoadNewContentMenu(model: NewContentMenuModel, ctx: AdminRenderContext): SiteManagerFragmentResult {
  const { labels } = ctx;
  const out = new CfOut().t('\n<div class="mura">\n\t');
  if (model.frontEndProxyLoc) {
    out.t('\n\t<div class="mura-header">\n\t<h1>', labels.key('sitemanager.selectcontenttype'), '</h1>\n\t</div>\n\t<script>');
    out.t("\n\t\t$(document).ready(function(){setToolTips('.add-content-ui');});\n\t</script>\n\t");
  }
  out.t('\n\t<div class="add-content-ui">\n\t\t<ul>\n\t\t').ws();

  const menu = new NewContentMenu(out, model, ctx);
  const { moduleId } = model;
  const deep = { depth: 7, tail: 6, inlineTip: false };
  const subtypeLayout = { depth: 8, tail: 7, inlineTip: true };
  if (cfEq(model.moduleId, FORMS_MODULE)) {
    for (const type of ['Form', 'Folder']) {
      menu.defaultItem(type, (description) => {
        if (type !== 'Form') return menu.typeItem(type, description, menu.href('cArch.edit', type, moduleId), deep);
        const flat = { depth: 7, tail: 7, inlineTip: false };
        const builder = menu.href('cArch.edit', type, moduleId, undefined, [['formType', 'builder', 'raw']]);
        menu.typeItem(type, description, builder, flat, labels.key('sitemanager.addform'));
        if (!model.allowSimpleHtmlForms) return;
        menuItem(out, flat, {
          liClass: `new${type}simple`,
          description: str(description),
          href: menu.href('cArch.edit', type, moduleId, undefined, [['formType', 'editor', 'raw']]),
          linkId: `new${type}Link`,
          icon: menu.icon(type, 'default'),
          span: labels.key('sitemanager.addformsimple'),
        });
      });
      if (type === 'Form') menu.subtypeItems(type, moduleId, subtypeLayout);
    }
  } else if (cfEq(model.moduleId, COMPONENTS_MODULE)) {
    for (const type of ['Component', 'Folder']) {
      const layout = { depth: 6, tail: 5, inlineTip: false };
      menu.defaultItem(type, (description) => menu.typeItem(type, description, menu.href('cArch.edit', type, moduleId), layout));
      if (type === 'Component') menu.subtypeItems(type, moduleId, subtypeLayout);
    }
  } else if (cfEq(model.moduleId, VARIATIONS_MODULE)) {
    // The view's `Variation` subtype block never runs: its loop list is Folder,File.
    for (const type of ['Folder', 'File']) {
      menu.defaultItem(type, (description) => menu.typeItem(type, description, menu.href('cArch.edit', type, moduleId), deep));
    }
    menu.multiUploadItem(5);
  } else if (!cfEq(model.ptype, 'Gallery')) {
    const typeList = model.primaryContentTypes !== '' ? model.primaryContentTypes : 'Page,Link,File,Folder,Calendar';
    for (const type of listItems(typeList)) {
      const layout = { depth: 6, tail: 5, inlineTip: false };
      menu.defaultItem(type, (description) => menu.typeItem(type, description, menu.href('cArch.edit', type, SITE_TREE_MODULE), layout));
      menu.subtypeItems(type, SITE_TREE_MODULE, { depth: 7, tail: 6, inlineTip: true });
    }
    menu.multiUploadItem(4);
  } else {
    renderGalleryMenu(out, menu, model, ctx);
  }
  out.ws().t('\n\t\t</ul>\n\t</div>\n</div>\n\n').ws().ws();
  return {
    status: 200,
    contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE,
    body: `${out}`,
    ...(model.frontEndProxyLoc ? { layout: true } : {}),
  };
}

/** The Gallery branch (loadnewcontentmenu.cfm:308-344); the gallery item's tooltip is the first File subtype's. */
function renderGalleryMenu(out: CfOut, menu: NewContentMenu, model: NewContentMenuModel, ctx: AdminRenderContext): void {
  const rows = menu.subtypeRows('File');
  const icon = menu.icon('GalleryItem', 'default');
  out.ws().ws();
  if (menu.available('File/Default')) {
    menuItem(out, { depth: 4, tail: 3, inlineTip: true }, {
      liClass: 'newGalleryItem',
      description: str(rows[0]?.description),
      href: menu.href('cArch.edit', 'File', SITE_TREE_MODULE),
      linkId: 'newGalleryItemLink',
      icon,
      span: ctx.labels.key('sitemanager.addgalleryitem'),
    });
  }
  out.ws();
  for (const row of rows) {
    const subtype = str(row.subtype);
    out.ws();
    if (model.availableSubTypes === '' || listFindNoCase(model.availableSubTypes, `File/${subtype}`)) {
      out.ws().ws().ws();
      menuItem(out, { depth: 6, tail: 5, inlineTip: false }, {
        liClass: 'newFile',
        description: str(row.description),
        href: menu.href('cArch.edit', 'File', SITE_TREE_MODULE, subtype),
        linkId: 'newGalleryItem',
        icon,
        span: subtype,
      });
      out.ws();
    }
    out.ws();
  }
  menu.multiUploadItem(4);
}
