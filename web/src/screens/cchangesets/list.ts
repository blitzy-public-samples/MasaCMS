// `cChangesets.list`: the change-set list of `admin/core/views/cchangesets/list.cfm` over strategies-content.
import {
  cfDateAdd,
  cfDateTimeFormat,
  cfIsDateText,
  cfListToArray,
  cfTimestampParam,
  cfToBoolean,
  cfToNumber,
  type AdminParam,
} from '@opt2/platform/legacy-compat';
import { formatDateTimeShort, lsDateFormatString, parseLegacyDate } from '@/lib/dates';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import { relativeAdminUrl } from '@/lib/urls';
import type { PageScreen, Rc, ScreenContext } from '../registry';
import { renderCategoriesNest, type ChangesetCategoryNode } from './dsp_categories_nest';
import { renderChangesetsMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'listChangesets';

/** The shell view a page screen renders. */
type ShellView = Awaited<ReturnType<PageScreen['render']>>;

/** A struct of the screen model; keys match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** One change set of the page: its bean values and the preview URL strategies-content builds. */
export interface ChangesetListRow {
  readonly changesetId: string;
  readonly siteId: string;
  readonly name: string;
  readonly published: boolean;
  /** `publishDate` as sent; null when the change set is unscheduled. */
  readonly publishDate: string | null;
  /** `lastUpdate` as sent; `''` when empty. */
  readonly lastUpdate: string;
  /** The home page's `getURL(complete=1, queryString='changesetID=<id>')`. */
  readonly previewUrl: string;
}

/** The feed iterator's paging after `setNextN(20)` and `setPage(rc.page)`. */
export interface ChangesetListPaging {
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly firstRecordOnPage: number;
  readonly lastRecordOnPage: number;
}

/** What `cChangesets.list` renders: the page's change sets, the paging, the site's category tree and `rc.stopdate`. */
export interface ChangesetListData {
  readonly rows: readonly ChangesetListRow[];
  readonly paging: ChangesetListPaging;
  /** `categoryManager.getCategoryCount(siteid)`. */
  readonly categoryCount: number;
  /** The site's categories as `cf_dsp_categories_nest` lists them from the top. */
  readonly categories: readonly ChangesetCategoryNode[];
  /** `rc.stopdate` as `list()` leaves it: one day later as CFML date-time text when `isDate` accepts it. */
  readonly stopDate: string;
}

// ---- Screen model reads ----

/** A struct value by case-insensitive key; undefined when absent. */
function field(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function text(struct: Struct, key: string): string {
  const value = field(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${OPERATION} returned a ${key} that is not a simple value`);
}

/** A CFML boolean; absent and SQL NULL read as false. */
function flag(struct: Struct, key: string): boolean {
  const value = field(struct, key);
  return value === undefined || value === null ? false : cfToBoolean(value);
}

/** Whether `value` is a struct (a plain object). */
const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The nested struct under `key`; throws when it is absent or not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = field(struct, key);
  if (!isStruct(value)) throw new TypeError(`${OPERATION} returned no ${key} struct`);
  return value;
}

/** The array of structs under `key`; throws when it is absent or holds anything else. */
function structsOf(struct: Struct, key: string): readonly Struct[] {
  const value = field(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned no ${key} array of structs`);
  }
  return value;
}

/** One `rc.changesets.items` entry. */
function rowOf(item: Struct): ChangesetListRow {
  const publishDate = text(item, 'publishDate');
  return {
    changesetId: text(item, 'changesetID'),
    siteId: text(item, 'siteID'),
    name: text(item, 'name'),
    published: flag(item, 'published'),
    publishDate: publishDate === '' ? null : publishDate,
    lastUpdate: text(item, 'lastUpdate'),
    previewUrl: text(item, 'previewURL'),
  };
}

/** One node of `rc.categories`, children included. */
function categoryOf(node: Struct): ChangesetCategoryNode {
  return {
    categoryId: text(node, 'categoryID'),
    name: text(node, 'name'),
    isOpen: flag(node, 'isOpen'),
    permitted: flag(node, 'permitted'),
    children: structsOf(node, 'children').map(categoryOf),
  };
}

/** `rc.stopdate` after `list()`: `DateAdd("d", 1, stopdate)` printed as a CFML date-time when `isDate` accepts it. */
function effectiveStopDate(stopdate: string): string {
  if (!cfIsDateText(stopdate)) return stopdate;
  // legacy quirk: the To field and the paging links show the day after the date the user entered.
  const next = cfDateAdd('d', 1, cfTimestampParam(stopdate));
  return `{ts '${cfDateTimeFormat(next, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

// The contract types the screen model's `rc` as an open struct, so this screen names the keys strategies-content
// reports, read case-insensitively: `changesets` (the feed iterator: pageIndex, pageCount, recordCount,
// firstRecordOnPageIndex, lastRecordOnPageIndex and `items`, each with changesetID, siteID, name, published,
// publishDate, lastUpdate and previewURL), `categoryCount`, and `categories` (each with categoryID, name, isOpen,
// permitted and children). `rc.stopdate` is derived here from the request, so no CFML date-time crosses the contract.
/** The page data of one screen model and the request's `rc.stopdate`. */
function listData(rc: Struct, stopdate: string): ChangesetListData {
  const changesets = structOf(rc, 'changesets');
  const count = (key: string): number => cfToNumber(field(changesets, key));
  return {
    rows: structsOf(changesets, 'items').map(rowOf),
    paging: {
      pageIndex: count('pageIndex'),
      pageCount: count('pageCount'),
      recordCount: count('recordCount'),
      firstRecordOnPage: count('firstRecordOnPageIndex'),
      lastRecordOnPage: count('lastRecordOnPageIndex'),
    },
    categoryCount: cfToNumber(field(rc, 'categoryCount')),
    categories: structsOf(rc, 'categories').map(categoryOf),
    stopDate: effectiveStopDate(stopdate),
  };
}

/**
 * The change sets of `rc.siteid` for the request's filters and page, with each row's delete token prefetched; the
 * service applies every filter. Gateway unavailability propagates.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 */
export async function loadChangesetList(ctx: ScreenContext): Promise<ChangesetListData> {
  const { rc } = ctx.req;
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/changesets', {
    params: { siteid: rc.siteid ?? '' },
    query: {
      keywords: rc.keywords,
      startrow: rc.startrow,
      page: rc.page,
      startdate: rc.startdate,
      stopdate: rc.stopdate,
      categoryid: rc.categoryid,
      tags: rc.tags,
    },
  });
  const data = listData(okBody(response, SERVICE, OPERATION).rc, rc.stopdate ?? '');
  await ctx.csrf.prefetch(data.rows.map((row) => row.changesetId));
  return data;
}

// ---- Markup ----

/** The rc filter values the view reads, `''` when absent. */
interface Filters {
  readonly siteid: string;
  readonly keywords: string;
  readonly startdate: string;
  readonly stopdate: string;
  readonly categoryid: string;
  readonly tags: string;
}

function filtersOf(rc: Rc): Filters {
  return {
    siteid: rc.siteid ?? '',
    keywords: rc.keywords ?? '',
    startdate: rc.startdate ?? '',
    stopdate: rc.stopdate ?? '',
    categoryid: rc.categoryid ?? '',
    tags: rc.tags ?? '',
  };
}

/** `len(categoryID & tags & keywords & startdate & stopdate)`: whether any filter is set. */
const hasFilters = (f: Filters): boolean => `${f.categoryid}${f.tags}${f.keywords}${f.startdate}${f.stopdate}` !== '';

/** A bundle label, unencoded as legacy writes it. */
const label = (ctx: ScreenContext, key: string): SafeHtml => raw(ctx.rb.rbKey(key));

/** `div#mura-list-tree` with the level-0 category nest checked for `rc.categoryid`; empty without categories. */
function categoryBlock(ctx: ScreenContext, data: ChangesetListData, f: Filters): SafeHtml {
  if (data.categoryCount === 0) return html``;
  const nest = renderCategoriesNest({ nodes: data.categories, categoryIds: f.categoryid, nestLevel: 0 });
  return html`
\t\t\t\t\t<div id="mura-list-tree" class="mura-6 mura-control-group category-select">
\t\t\t\t\t\t<label>${label(ctx, 'sitemanager.categories')}</label>
\t\t\t\t\t\t<div id="category-select-control"></div>\t
\t\t\t\t\t\t<div id="category-select-list">
\t\t\t\t\t\t\t${nest}
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t`;
}

/** One `span.tag` per element of the `rc.tags` comma list. */
function tagSpans(f: Filters): SafeHtml {
  return join(
    cfListToArray(f.tags).map(
      (tag) => html`
\t\t\t\t\t\t\t<span class="tag">
\t\t\t\t\t\t\t${tag} <a><i class="mi-times-circle"></i></a>
\t\t\t\t\t\t\t<input name="tags" type="hidden" value="${raw(encodeHtmlAttr(tag))}">
\t\t\t\t\t\t\t</span>
\t\t\t\t\t\t`,
    ),
  );
}

/** The Remove Filter button, rendered only while a filter is set. */
function removeFilterButton(ctx: ScreenContext, f: Filters): SafeHtml {
  if (!hasFilters(f)) return html``;
  return html`
\t\t\t\t\t  \t\t<button type="button" class="btn" name="removeFilter" onclick="location.href='./?siteID=${raw(encodeUrl(f.siteid))}&muraAction=cChangesets.list'"><i class="mi-times-circle"></i> ${label(ctx, 'sitemanager.removefilter')} </button>
\t\t\t\t\t  \t`;
}

/** `LSDateFormat(value, session.dateKeyFormat)` of an rc date filter in the session locale; throws as legacy does. */
function dateFilterValue(ctx: ScreenContext, value: string): SafeHtml {
  const { dateKeyFormat, locale } = ctx.req.session;
  return raw(lsDateFormatString(value, dateKeyFormat, locale));
}

/** `div#navFilters`: the filter toggle and the search form. */
function navFilters(ctx: ScreenContext, data: ChangesetListData, f: Filters): SafeHtml {
  return html`<div id="navFilters">
\t<div id="navFiltersToggle">${label(ctx, 'sitemanager.filters')}<i class="mi-chevron-down"></i></div>
\t<div id="navFilterControls">
\t\t<form novalidate="novalidate" name="searchFrm" class="form-inline" onsubmit="return validate(this);">

\t\t\t<div class="mura-layout-row">

\t\t\t\t
\t\t\t\t<div class="mura-6 mura-control-group">
\t\t\t\t\t<label>${label(ctx, 'params.keywords')}</label>
\t\t\t  \t<input name="keywords" value="${raw(encodeHtmlAttr(f.keywords))}" type="text" class="text"  maxlength="50" />
\t\t  \t</div>
\t\t\t\t

\t\t\t\t
\t\t\t\t
\t\t\t\t<div class="mura-control-group mura-3">
\t\t\t\t\t<label>${label(ctx, 'params.from')}</label>
\t\t\t\t\t<input type="text" class="datepicker text" name="startDate" value="${dateFilterValue(ctx, f.startdate)}" validate="date" message="The 'From' date is required." />
\t\t\t\t</div>
\t\t\t\t<div class="mura-control-group mura-3">
\t\t\t\t     <label>${label(ctx, 'params.to')}</label>
\t\t\t\t     <input type="text" class="datepicker text" name="stopDate" value="${dateFilterValue(ctx, data.stopDate)}" validate="date" message="The 'To' date is required." />
\t\t\t\t</div>

\t\t\t\t

\t\t\t</div>
\t\t\t<div class="mura-layout-row">

\t\t\t\t
\t\t\t\t${categoryBlock(ctx, data, f)}
\t\t\t\t

\t\t\t\t
\t\t\t\t\t<div id="tags" class="mura-3 mura-control-group mura-filter-tags tagSelector">
\t\t\t\t\t\t<label>${label(ctx, 'sitemanager.tags')}</label>
\t\t\t\t\t\t<input type="text" class="text" name="tags">
\t\t\t\t\t\t${tagSpans(f)}
\t\t\t\t\t</div>
\t\t\t\t


\t\t\t\t
\t\t\t\t<div id="navFilterButtons" class="mura-actions mura-5">
\t\t\t\t\t<div class="form-actions">
\t\t\t\t\t\t${removeFilterButton(ctx, f)}\t
\t\t\t\t\t\t\t<button type="submit" class="btn mura-primary" onclick="submitForm(document.forms.searchFrm);"><i class="mi-filter"></i> ${label(ctx, 'sitemanager.filter')} </button>
\t\t\t\t\t\t\t
\t\t\t\t\t\t\t<input type="hidden" value="${raw(encodeHtmlAttr(f.siteid))}" name="siteID"/>
\t\t\t\t\t\t\t<input type="hidden" name="muraAction" value="cChangesets.list">

\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t

\t\t\t</div> 
\t\t</form>
\t</div>\t
</div>\t`;
}

/** The labels every row repeats, unencoded as legacy writes them, with the confirm text JS-encoded. */
interface RowLabels {
  readonly edit: SafeHtml;
  readonly preview: SafeHtml;
  readonly assignments: SafeHtml;
  readonly remove: SafeHtml;
  readonly deleteConfirm: SafeHtml;
}

/** `LSDateFormat(d, session.dateKeyFormat) LSTimeFormat(d, "short")` under the session locale. */
function dateTimeText(ctx: ScreenContext, value: string | null): SafeHtml {
  const { dateKeyFormat, locale } = ctx.req.session;
  return raw(formatDateTimeShort(value, dateKeyFormat, locale));
}

/** The preview menu item of a change set not yet published. */
function previewItem(row: ChangesetListRow, labels: RowLabels): SafeHtml {
  if (row.published) return html``;
  // Legacy interpolates the home page URL into the onclick without encoding.
  return html`
\t\t\t\t\t\t\t\t\t\t\t<li class="preview"><a title="${labels.preview}" href="#" onclick="return preview('${raw(row.previewUrl)}');"><i class="mi-globe"></i>${labels.preview}</a></li>
\t\t\t\t\t\t\t\t`;
}

/** One change-set row; its menu links carry the row's own site, the name link `rc.siteID`. */
function changesetRow(ctx: ScreenContext, row: ChangesetListRow, f: Filters, labels: RowLabels): SafeHtml {
  // Legacy interpolates the change-set id into every href without encoding.
  const id: AdminParam = ['changesetID', row.changesetId, 'raw'];
  const categoryid: AdminParam = ['categoryid', f.categoryid];
  const tags: AdminParam = ['tags', f.tags];
  const rowSite: AdminParam = ['siteid', row.siteId];
  const editHref = relativeAdminUrl('cChangesets', 'edit', [id, rowSite, categoryid, tags]);
  const assignmentsHref = relativeAdminUrl('cChangesets', 'assignments', [id, rowSite, categoryid]);
  const deleteHref = relativeAdminUrl('cChangesets', 'delete', [id, rowSite, categoryid, tags]);
  const nameHref = relativeAdminUrl('cChangesets', 'assignments', [id, ['siteid', f.siteid], categoryid, tags]);
  const publishDate = parseLegacyDate(row.publishDate) === null ? raw('NA') : dateTimeText(ctx, row.publishDate);
  return html`<tr>
\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t<li class="edit"><a title="${labels.edit}" href="${raw(editHref)}"><i class="mi-pencil"></i>${labels.edit}</a></li>
\t\t\t\t\t\t\t\t${previewItem(row, labels)}
\t\t\t\t\t\t\t\t\t\t<li class="change-sets"><a title="${labels.assignments}" href="${raw(assignmentsHref)}"><i class="mi-reorder"></i>${labels.assignments}</a></li>
\t\t\t\t\t\t\t\t\t\t<li class="delete"><a title="${labels.remove}" href="${raw(deleteHref)}${ctx.csrf.render(row.changesetId, 'url')}" onclick="return confirmDialog('${labels.deleteConfirm}',this.href)"><i class="mi-trash"></i>${labels.remove}</a></li>
\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t</td>
\t\t\t\t\t\t<td class="var-width"><a title="Edit" href="${raw(nameHref)}">${row.name}</a></td>
\t\t\t\t\t\t<td>${publishDate}</td>
\t\t\t\t\t\t<td>${dateTimeText(ctx, row.lastUpdate)}</td>
\t\t\t\t\t</tr>`;
}

/** The change-set table, or the empty notice when the page has no rows. */
function results(ctx: ScreenContext, data: ChangesetListData, f: Filters): SafeHtml {
  if (data.rows.length === 0) {
    return html`
\t\t\t\t\t\t<div class="help-block-empty">${label(ctx, 'changesets.nochangesets')}</div>
\t\t\t\t\t`;
  }
  const labels: RowLabels = {
    edit: label(ctx, 'changesets.edit'),
    preview: label(ctx, 'changesets.preview'),
    assignments: label(ctx, 'changesets.assignments'),
    remove: label(ctx, 'changesets.delete'),
    deleteConfirm: raw(encodeJs(ctx.rb.rbKey('changesets.deleteconfirm'))),
  };
  // ACF writes the rows without the loop's `<cfset>` line and one space after each `</tr>` but the last.
  const rows = join(
    data.rows.map((row) => changesetRow(ctx, row, f, labels)),
    raw(' \n\t\t\t\t\t'),
  );
  return html`
\t\t\t\t\t<table class="mura-table-grid">
\t\t\t\t\t<tr>
\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t<th class="var-width">${label(ctx, 'changesets.name')}</th>
\t\t\t\t\t<th>${label(ctx, 'changesets.datetopublish')}</th>
\t\t\t\t\t<th>${label(ctx, 'changesets.lastupdate')}</th>
\t\t\t\t\t</tr>

\t\t\t\t\t
\t\t\t\t\t${rows}
\t\t\t\t\t</table>
\t\t\t\t\t`;
}

/** `./?muraAction=cChangesets.list&page=<page>&…` with every filter, `rc.stopdate` as `list()` left it. */
function pageHref(page: number, f: Filters, stopDate: string, withTags: boolean): string {
  const params: AdminParam[] = [
    ['page', page, 'raw'],
    ['siteid', f.siteid],
    ['keywords', f.keywords],
    ['startdate', f.startdate],
    ['stopdate', stopDate],
    ['categoryid', f.categoryid],
  ];
  if (withTags) params.push(['tags', f.tags]);
  return relativeAdminUrl('cChangesets', 'list', params);
}

/** One numbered page link; the current page links to `#`. */
function pageItem(page: number, paging: ChangesetListPaging, f: Filters, stopDate: string): SafeHtml {
  if (paging.pageIndex === page) {
    return html`
\t\t\t\t\t\t\t\t\t<li class="active"><a href="#">${page}</a></li>
\t\t\t\t\t\t\t\t`;
  }
  // legacy quirk (list.cfm:231): the href closes before `&tags=`, which follows as stray attribute text.
  return html`
\t\t\t\t\t\t\t\t\t<li>
\t\t\t\t\t\t\t\t\t\t<a href="${raw(pageHref(page, f, stopDate, false))}"&tags=${raw(encodeUrl(f.tags))}>${page}</a>
\t\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t`;
}

/** `div.mura-results-wrapper` with the paging summary and links; empty for a single page. */
function pagination(ctx: ScreenContext, data: ChangesetListData, f: Filters): SafeHtml {
  const { paging, stopDate } = data;
  if (paging.pageCount <= 1) return html``;
  const meta = ctx.rb.messageFormat(ctx.rb.rbKey('sitemanager.paginationmeta'), [
    `${paging.firstRecordOnPage}-${paging.lastRecordOnPage}`,
    paging.recordCount,
  ]);
  const previous =
    paging.pageIndex > 1
      ? html`
\t\t\t\t\t\t\t<li>
\t\t\t\t\t\t\t\t<a href="${raw(pageHref(paging.pageIndex - 1, f, stopDate, true))}"><i class="mi-angle-left"></i></a>
\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t`
      : html``;
  const pages = Array.from({ length: paging.pageCount }, (_, i) => pageItem(i + 1, paging, f, stopDate));
  const next =
    paging.pageIndex < paging.pageCount
      ? html`
\t\t\t\t\t\t\t\t<li>
\t\t\t\t\t\t\t\t\t<a href="${raw(pageHref(paging.pageIndex + 1, f, stopDate, true))}"><i class="mi-angle-right"></i></a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t`
      : html``;
  return html`
\t\t\t\t\t\t<div class="clearfix mura-results-wrapper">
\t\t\t\t\t\t\t<p class="search-showing">
\t\t\t\t\t\t\t\t${raw(meta)}
\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t\t<ul class="pagination moreResults">
\t\t\t\t\t\t\t${previous}${pages}${next}
\t\t\t\t\t\t\t</ul> <!-- /.pagination -->
\t\t\t\t\t\t</div> <!-- /.mura-results-wrapper -->
\t\t\t\t\t`;
}

/** The view's inline script: the tag selector, the category picker and the filter toggle, opened while filtering. */
function listScript(f: Filters): SafeHtml {
  const openFilters = hasFilters(f)
    ? raw("\n\t\t\t\t\t\t\t\ttoggleNavFilters(jQuery('#navFiltersToggle'));\n\t\t\t\t\t\t\t")
    : html``;
  return html` <script>

\t\t\t  \t \t$(function(){
\t\t\t\t\t\t$.get('?muraAction=cchangesets.loadtagarray&siteid=' + siteid).done(
\t\t\t\t\t\t\tfunction(data){
\t\t\t\t\t\t\t\tvar tagArray=eval('(' + data + ')');
\t\t\t\t\t\t\t\t$('#tags').tagSelector(tagArray, 'tags');
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t);
\t\t\t\t\t\t});
\t\t  \t \t\t// changesets advanced filters
\t\t  \t \t  jQuery(document).ready(function(){

\t\t\t\t\t  \tvar serializeCatCheckboxes = function(){
\t\t\t\t\t\t\t\tvar catContainer = jQuery('#category-select-control');
\t\t\t\t\t  \t\tjQuery(catContainer).find('.tag').remove();
\t\t\t\t\t\t\t\tjQuery('#category-select-list input[type=checkbox]:checked').each(function(){
\t\t\t\t\t\t  \t\tvar thisText = $(this).parent('li').clone().children().remove().end().text();
\t\t\t\t\t\t  \t\tvar selCat = '<span class="tag">' + thisText + '</span>';
\t\t\t\t\t\t  \t\tjQuery(selCat).appendTo(catContainer);

\t\t\t\t\t  \t\t});
\t\t\t\t\t  \t}
\t\t\t\t\t  \tjQuery('#category-select-list input[type=checkbox]').click(function(){
\t\t\t\t\t  \t\t\tserializeCatCheckboxes();
\t\t\t\t\t  \t});
\t\t\t\t\t\t\tserializeCatCheckboxes();

\t\t\t\t\t  \tjQuery('#category-select-list').hide();
\t\t\t\t\t  \tjQuery('#category-select-control').click(function(){
\t\t\t\t\t  \t\tjQuery('#category-select-list').slideToggle('fast');
\t\t\t\t\t  \t})

\t\t\t\t\t\t\tjQuery('#navFilterControls').hide();
\t\t\t\t\t\t\tvar toggleNavFilters = function(el){
\t\t\t\t\t\t\t\tjQuery('#navFilterControls').slideToggle('fast');
\t\t\t\t\t\t\t\tjQuery(el).find('i').toggleClass('mi-chevron-down').toggleClass('mi-chevron-up');\t\t\t
\t\t\t\t\t\t\t}

\t\t\t\t\t\t\tjQuery('#navFiltersToggle').click(function(){
\t\t\t\t\t\t\t\ttoggleNavFilters(jQuery(this));
\t\t\t\t\t\t\t})

\t\t\t\t\t\t${openFilters}

\t\t\t\t\t  });
\t\t\t\t\t</script>`;
}

/** The list view body as ACF 2023 writes it: header and menu, filters, change sets, paging and the view's script. */
export function renderChangesetList(ctx: ScreenContext, data: ChangesetListData): SafeHtml {
  const f = filtersOf(ctx.req.rc);
  const menu = renderChangesetsMenu(ctx.req, ctx.rb).html;
  return html`

\t<div class="mura-header">
\t\t<h1>${label(ctx, 'changesets')}</h1>
\t\t
\t${menu}

\t</div> <!-- /.mura-header -->

\t\t<div class="block block-constrain">
\t\t\t\t<div class="block block-bordered">
\t\t\t\t\t<div class="block-content">



${navFilters(ctx, data, f)}



\t\t\t\t\t${results(ctx, data, f)}${pagination(ctx, data, f)}


\t\t\t\t\t${listScript(f)}





\t\t\t<div class="clearfix"></div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

`;
}

/** `cChangesets.list` without its circuit gate and rc defaults, which `./index.ts` adds. */
export const changesetListScreen: Omit<PageScreen<ChangesetListData>, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'list',
  mode: 'page',
  owner: 'strategies-content',
  load: loadChangesetList,
  render: (ctx: ScreenContext, data: ChangesetListData): ShellView => ({ body: renderChangesetList(ctx, data) }),
});
