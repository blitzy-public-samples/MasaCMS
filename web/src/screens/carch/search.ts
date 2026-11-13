// `cArch.search` of `carch/search.cfm`: the Site Manager keyword search, its results table and pager (server-only).
import { cfEq, cfIsNumeric, cfToBoolean, cfToNumber, type AdminParam } from '@opt2/platform/legacy-compat';
import { lsDateFormatString } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import {
  NODE_LEVEL_LIST,
  ROOT_CONTENT_ID,
  isSiteAdminOrS2,
  structOf,
  structText,
  structValue,
  type CarchCrumb,
  type CarchStruct,
} from './model';
import { carchJs } from './partials/js';
import { dspZoom } from './partials/zoom';
import { applySessionEffects, carchPageData, type CarchPageModel } from './service';

const OPERATION = 'strategies-content listContent';

/** `getNextN(rsList, 30, startrow)` in carch `search()`. */
const RECORDS_PER_PAGE = 30;

/** utility `getNextN` default `pageBuffer`. */
const PAGE_BUFFER = 5;

/** Types whose read-only preview links the site page (`cfcase value="Page,Folder,Calendar,Gallery"`). */
const PAGE_PREVIEW_TYPES = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery']);

/** `utility.getNextN` of the search, with `startRow` kept as the rc text legacy prints. */
export interface SearchNextN {
  readonly totalRecords: number;
  readonly recordsPerPage: number;
  readonly numberOfPages: number;
  readonly currentPageNumber: number;
  readonly firstPage: number;
  readonly lastPage: number;
  readonly next: number;
  readonly previous: number;
  readonly through: number;
  readonly startRow: string;
}

/** What the search view renders, as the controller leaves `rc` and the session. */
export interface SearchData {
  /** `rc.rslist.recordcount`. */
  readonly recordCount: number;
  readonly nextn: SearchNextN;
  /** `int(rc.startrow)`, the first row `cfoutput` prints. */
  readonly firstRow: number;
  /** The rows `cfoutput query` prints: from `firstRow`, at most `recordsPerPage`. */
  readonly rows: readonly CarchStruct[];
  /** The screen model of the page holding `firstRow`, whose site values the rows read. */
  readonly model: CarchPageModel;
  /** `session.copyContentID`, `''` by its `cfparam` default. */
  readonly copyContentId: string;
  /** `session.copySiteID`, `''` by its `cfparam` default. */
  readonly copySiteId: string;
}

/** The controller `secure()` redirect a strategies-content denial maps to. */
type SearchDenied = Extract<PageControllerRedirect, { kind: 'location' }>;

/** The controller's answer: its data, or the denial's redirect. */
type SearchOutcome = { readonly kind: 'ok'; readonly data: SearchData } | SearchDenied;

/** The site values the result rows read from `rc.site`. */
interface SearchSite {
  /** settingsBean `getLocking()`. */
  readonly locking: string;
  /** settingsBean `getWebPath(complete=1)`. */
  readonly webPath: string;
  /** settingsBean `getScheme()`. */
  readonly scheme: string;
  /** settingsBean `getDomain()`. */
  readonly domain: string;
}

// ---- Controller ----

/** `rc[name]`, failing as CFML does when the element is undefined. */
function rcText(rc: RequestContext, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** `utility.getNextN(data, recordsPerPage=30, startRow)` over a record count. */
export function searchNextN(totalRecords: number, startRow: string): SearchNextN {
  const start = cfToNumber(startRow);
  const numberOfPages = Math.ceil(totalRecords / RECORDS_PER_PAGE);
  const currentPageNumber = Math.ceil(start / RECORDS_PER_PAGE);
  let firstPage = currentPageNumber > PAGE_BUFFER ? currentPageNumber - PAGE_BUFFER : 1;
  let lastPage = firstPage + 2 * PAGE_BUFFER;
  if (numberOfPages < lastPage) lastPage = numberOfPages;
  if (lastPage - firstPage < 2 * PAGE_BUFFER) firstPage = Math.max(1, lastPage - 2 * PAGE_BUFFER);
  let next = (currentPageNumber + 1) * RECORDS_PER_PAGE - RECORDS_PER_PAGE + 1;
  const previous = Math.max(currentPageNumber - 1, 1) * RECORDS_PER_PAGE - RECORDS_PER_PAGE + 1;
  const through = totalRecords < next ? totalRecords : next - 1;
  if (next > totalRecords) next = 1;
  return {
    totalRecords,
    recordsPerPage: RECORDS_PER_PAGE,
    numberOfPages,
    currentPageNumber,
    firstPage,
    lastPage,
    next,
    previous,
    through,
    startRow,
  };
}

/** Whether `value` is a struct (a plain object). */
const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The contract types the screen model's `rc` as an open struct, so this screen names the keys strategies-content
// reports for one 30-row `page` of `contentManager.getPrivateSearch(siteid, keywords)`, read case-insensitively:
// `rslist` (that page's rows with getPrivateSearch's columns, each with `crumbdata` (`getCrumbList(contentid,
// siteid)`), `verdict` (`permUtility.getNodePerm(crumbdata)`) and `urlStem` (`$.getURLStem(siteid, filename)`)),
// `nextn` (its `getNextN` struct, of which `totalrecords` is read), `site` (`locking`, `webPath`, `scheme`, `domain`;
// read only for a printed row) and the session's `copyContentID` and `copySiteID`. Paging is recomputed from `startrow`.
/** `rc.rslist` rows of one screen model. */
function pageRows(model: CarchPageModel): readonly CarchStruct[] {
  const rows = structValue(model.rc, 'rslist');
  if (!Array.isArray(rows) || !rows.every(isStruct)) throw new TypeError(`${OPERATION} returned no rc.rslist rows`);
  return rows;
}

/** `rc.nextn.totalrecords` of one screen model. */
function totalRecordsOf(model: CarchPageModel): number {
  const total = structValue(structOf(model.rc, 'nextn'), 'totalrecords');
  if (!cfIsNumeric(total)) throw new TypeError(`${OPERATION} returned no rc.nextn.totalrecords`);
  return cfToNumber(total);
}

/** One 30-row page of the search; no `moduleid` is sent, since `search()` searches getPrivateSearch's default modules. */
async function searchPage(
  ctx: ScreenContext,
  siteid: string,
  keywords: string,
  page: number,
): Promise<{ readonly kind: 'ok'; readonly model: CarchPageModel } | SearchDenied> {
  const outcome = await carchPageData(ctx, 'search', { siteid, keywords, page: String(page) });
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`strategies-content rejected the carch.search read with HTTP ${String(outcome.status)}`);
  }
  return { kind: 'ok', model: outcome.data };
}

/**
 * carch `before()` and `search()`: the private search for `rc.keywords`, `session.keywords=rc.keywords` and the paging
 * from `rc.startrow`. A denial leaves the request untouched, as the controller's `secure()` does.
 * @throws TypeError Where legacy fails: `rc.keywords` or `rc.startrow` undefined, or `rc.startrow` not numeric.
 */
async function runSearch(ctx: ScreenContext): Promise<SearchOutcome> {
  const req = applyCarchDefaults(ctx.req);
  const { rc } = req;
  const keywords = rc.keywords;
  if (keywords === undefined) throw new TypeError('Element RC.keywords is undefined in ARGUMENTS.');
  const startRow = rc.startrow;
  if (startRow === undefined) throw new TypeError('Element RC.startrow is undefined in ARGUMENTS.');
  if (!cfIsNumeric(startRow)) {
    throw new TypeError('The STARTROW argument passed to the getNextN function is not of type numeric.');
  }
  // `cfoutput startrow` truncates its value toward zero.
  const firstRow = Math.trunc(cfToNumber(startRow));
  const page = Math.max(1, Math.ceil(firstRow / RECORDS_PER_PAGE));
  const siteid = rcText(rc, 'siteid');
  const first = await searchPage(ctx, siteid, keywords, page);
  if (first.kind === 'location') return first;

  const recordCount = totalRecordsOf(first.model);
  const offset = firstRow - ((page - 1) * RECORDS_PER_PAGE + 1);
  let rows: readonly CarchStruct[] = firstRow < 1 ? [] : pageRows(first.model).slice(offset);
  // An unaligned start row prints the head of the following page too.
  if (firstRow >= 1 && offset > 0 && recordCount > page * RECORDS_PER_PAGE) {
    const second = await searchPage(ctx, siteid, keywords, page + 1);
    if (second.kind === 'location') return second;
    rows = [...rows, ...pageRows(second.model)];
  }

  ctx.req = req;
  applySessionEffects(ctx.req, { keywords });
  return {
    kind: 'ok',
    data: {
      recordCount,
      nextn: searchNextN(recordCount, startRow),
      firstRow,
      rows: rows.slice(0, RECORDS_PER_PAGE),
      model: first.model,
      copyContentId: structText(first.model.rc, 'copyContentID'),
      copySiteId: structText(first.model.rc, 'copySiteID'),
    },
  };
}

/** The controller run of each request, shared by the screen's redirect step and its load. */
const controllerRuns = new WeakMap<ScreenContext, Promise<SearchOutcome>>();

/** {@link runSearch} once per request context. */
function controllerRun(ctx: ScreenContext): Promise<SearchOutcome> {
  let run = controllerRuns.get(ctx);
  if (run === undefined) {
    run = runSearch(ctx);
    controllerRuns.set(ctx, run);
  }
  return run;
}

// ---- View ----

// The markup below is search.cfm as ACF emits it: whitespace-only text between CFML tags is dropped, every other text
// is kept byte for byte. Values are written unencoded wherever the view writes them without `esapiEncode`.

/** `rc.rslist.<name>` of the current row; an absent column fails as ACF reports it. */
function column(row: CarchStruct, name: string): string {
  if (structValue(row, name) === undefined) throw new TypeError(`Element RSLIST.${name} is undefined in RC.`);
  return structText(row, name);
}

/** A value strategies-content computes for a row (`crumbdata`, `verdict`, `urlStem`); throws when it is absent. */
function rowValue(row: CarchStruct, key: string): unknown {
  const value = structValue(row, key);
  if (value === undefined) throw new TypeError(`${OPERATION} returned an rc.rslist row without ${key}`);
  return value;
}

/** {@link rowValue} as CFML text. */
function rowText(row: CarchStruct, key: string): string {
  rowValue(row, key);
  return structText(row, key);
}

/** The row's `getCrumbList(contentid, siteid)`, node first. */
function crumbsOf(row: CarchStruct): readonly CarchCrumb[] {
  const crumbs = rowValue(row, 'crumbdata');
  if (!Array.isArray(crumbs) || !crumbs.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned a crumbdata that is not an array of crumbs`);
  }
  return crumbs;
}

/** `settingsManager.getSite(rc.siteid)` values of the model's `rc.site`. */
function siteOf(model: CarchPageModel): SearchSite {
  const site = structOf(model.rc, 'site');
  const text = (key: string): string => {
    if (structValue(site, key) === undefined) throw new TypeError(`${OPERATION} returned an rc.site without ${key}`);
    return structText(site, key);
  };
  return { locking: text('locking'), webPath: text('webPath'), scheme: text('scheme'), domain: text('domain') };
}

/** `LSDateFormat(value, session.dateKeyFormat)` under the session locale. */
function lsDate(ctx: ScreenContext, value: string): string {
  const { dateKeyFormat, locale } = ctx.req.session;
  return lsDateFormatString(value, dateKeyFormat, locale);
}

/** The Display cell's text: `Yes`, the display window, or `No`, with CFML's short-circuit boolean reads. */
function displayText(ctx: ScreenContext, row: CarchStruct): string {
  const display = column(row, 'Display');
  const approved = (): boolean => cfToBoolean(column(row, 'approved')) && cfToBoolean(column(row, 'approved'));
  if (cfToBoolean(display) && cfEq(column(row, 'Display'), '1') && approved()) return 'Yes';
  if (cfEq(column(row, 'Display'), '2') && approved()) {
    return `${lsDate(ctx, column(row, 'displaystart'))} - ${lsDate(ctx, column(row, 'displaystop'))}`;
  }
  return 'No';
}

/** A view-relative admin link: values `raw` unless marked `url` (`esapiEncode('url', …)`). */
const viewUrl = (circuit: string, action: string, params: AdminParam[]): string =>
  relativeAdminUrl(circuit, action, params, { encode: 'raw' });

/** `site.getScheme()://site.getDomain()` plus configBean `getServerPort()`, `getContext()` and the URL stem. */
function siteUrl(site: SearchSite, urlStem: string): string {
  const { serverPort, context } = legacySettings();
  return `${site.scheme}://${site.domain}${serverPort}${context}${urlStem}`;
}

/** The action links of a row whose verdict is neither `none` nor `read`. */
function editableActions(ctx: ScreenContext, row: CarchStruct, site: SearchSite, deletable: boolean): string {
  const { rc } = ctx.req;
  const edit = viewUrl('cArch', 'edit', [
    ['contenthistid', column(row, 'ContentHistID')],
    ['contentid', column(row, 'ContentID')],
    ['type', column(row, 'type')],
    ['parentid', column(row, 'parentID')],
    ['topid', rcText(rc, 'topid'), 'url'],
    ['siteid', rcText(rc, 'siteid'), 'url'],
    ['moduleid', rcText(rc, 'moduleid'), 'url'],
    ['startrow', rcText(rc, 'startrow')],
  ]);
  const preview = site.webPath + rowText(row, 'urlStem');
  // Version history and permissions link the row as its own `topid`.
  const nodeParams = (): AdminParam[] => [
    ['contentid', column(row, 'ContentID')],
    ['type', column(row, 'type')],
    ['parentid', column(row, 'parentID')],
    ['topid', column(row, 'contentID')],
    ['siteid', rcText(rc, 'siteid'), 'url'],
    ['moduleid', rcText(rc, 'moduleid'), 'url'],
    ['startrow', rcText(rc, 'startrow')],
  ];
  const hist = viewUrl('cArch', 'hist', nodeParams());
  let out =
    `\n       <li class="edit"><a title="Edit" href="${edit}"><i class="mi-pencil"></i></a></li>` +
    `\n\t\t<li class="preview"><a title="Preview" href="${preview}"><i class="mi-globe"></i></a></li>` +
    `\n\t   <li class="version-history"><a title="Version History" href="${hist}"><i class="mi-history"></i></a></li>\n        `;
  out += isSiteAdminOrS2(ctx.req)
    ? `\n          <li class="permissions"><a title="Permissions" href="${viewUrl('cPerm', 'main', nodeParams())}"><i class="mi-group"></i></a></li>\n        `
    : '\n\t\t  <li class="permissions disabled"><a>Permissions</a></li>\n\t\t';
  if (deletable) {
    const remove = viewUrl('cArch', 'update', [
      ['contentid', column(row, 'ContentID')],
      ['type', column(row, 'type')],
      ['action', 'deleteall'],
      ['topid', column(row, 'contentID')],
      ['siteid', rcText(rc, 'siteid'), 'url'],
      ['moduleid', rcText(rc, 'moduleid'), 'url'],
      ['parentid', rcText(rc, 'parentid'), 'url'],
      ['startrow', rcText(rc, 'startrow')],
    ]);
    const type = column(row, 'type');
    const trash = NODE_LEVEL_LIST.some((nodeType) => nodeType.toLowerCase() === type.toLowerCase())
      ? '\n\t\t\t\t\t<i class="mi-trash"></i>\n\t\t\t\t'
      : '';
    out += `\n          <li class="delete">\n\t\t\t<a title="Delete" href="${remove}">\n\t\t\t\t${trash}\n\t\t\t</a>\n\t\t  </li>\n\t\t`;
  } else if (!cfEq(rcText(rc, 'locking'), 'all')) {
    out += '\n          <li class="delete disabled">Delete<i class="mi-trash"></i></li>\n        ';
  }
  return out;
}

/** The action links of a row the user may only read: the type's preview, the rest disabled. */
function readOnlyActions(row: CarchStruct, site: SearchSite): string {
  const type = column(row, 'type');
  // cfswitch matches its cases case-insensitively.
  const is = (candidate: string): boolean => candidate.toLowerCase() === type.toLowerCase();
  let preview = '';
  if (PAGE_PREVIEW_TYPES.some(is)) {
    preview = `\n\t\t<li class="preview"><a title="Preview" href="${siteUrl(site, rowText(row, 'urlStem'))}"><i class="mi-globe"></i></a></li>\n\t\t`;
  } else if (is('Link')) {
    preview = `\n\t\t<li class="preview"><a title="Preview" href="#" onclick="return preview('${column(row, 'filename')}','${column(row, 'targetParams')}');"><i class="mi-globe"></i></a></li>\n\t\t`;
  } else if (is('File')) {
    const url = siteUrl(site, rowText(row, 'urlStem'));
    preview = `\n\t\t<li class="preview"><a title="Preview" href="#" onclick="return preview('${url}','${column(row, 'targetParams')}');"><i class="mi-globe"></i></a></li>\n\t\t`;
  }
  return (
    `\n        <li class="edit disabled">&nbsp;</li>\n\t\t${preview}` +
    '\n\t\t<li class="version-history disabled"><a>Version History</a></li>' +
    '\n\t\t<li class="permissions disabled"><a>Permissions</a></li>' +
    '\n\t\t<li class="delete disabled"><a>Delete</a></li>\n      '
  );
}

/** One `cfoutput query` iteration: the `cfsilent` derivations in legacy order, then the row markup (no `</tr>`). */
function resultRow(ctx: ScreenContext, data: SearchData, row: CarchStruct): string {
  const { rc } = ctx.req;
  const crumbdata = crumbsOf(row);
  const verdict = rowText(row, 'verdict');
  const site = siteOf(data.model);
  const unlocked = !cfEq(site.locking, 'all');
  const newcontent = unlocked ? verdict : !cfEq(verdict, 'none') ? 'read' : 'none';
  const underRoot = cfEq(column(row, 'parentid'), ROOT_CONTENT_ID);
  const deletable =
    ((!underRoot && unlocked) || (underRoot && cfEq(site.locking, 'none'))) &&
    cfEq(verdict, 'editor') &&
    !cfEq(column(row, 'IsLocked'), '1');

  // getPrivateSearch selects no `moduleid`, so on legacy (ACF 2023) every printed row fails here with HTTP 500. The
  // strict read keeps that failure; defaulting the column would serve a page legacy never renders.
  const nodeArgs = [
    column(row, 'contentid'),
    column(row, 'contentid'),
    column(row, 'parentid'),
    rcText(rc, 'siteid'),
    column(row, 'type'),
    column(row, 'moduleid'),
  ];
  const showMenu = `showMenu('newContentMenu','${newcontent}',this,${nodeArgs.map((arg) => `'${arg}'`).join(',')});`;
  return (
    '\n        <tr>\n\t\t\t     <td class="add">\n     ' +
    `\n\t\t<a href="javascript:;" ontouchstart="this.onmouseover();" onmouseover="${showMenu}">&nbsp;</a>\n\t</td>` +
    `\n          <td class="title var-width">${String(dspZoom(ctx, { crumbdata }))}</td>` +
    `\n\t\t\t   <td>\n\t    ${displayText(ctx, row)}</td>` +
    `\n\t\t<td>${lsDate(ctx, column(row, 'lastupdate'))}</td>` +
    '\n\n <td class="actions"><ul class="siteSummary five">' +
    (['none', 'read'].includes(verdict.toLowerCase())
      ? readOnlyActions(row, site)
      : editableActions(ctx, row, site, deletable)) +
    '</ul></td>\n\n       '
  );
}

const NO_RESULTS =
  '\n      <tr>\n        <td colspan="8" class="results">Your search returned no results.</td>\n      </tr>\n    ';

/** The table rows: the printed results, or the no-results row when the search matched nothing. */
function resultRows(ctx: ScreenContext, data: SearchData): string {
  if (data.recordCount === 0) return NO_RESULTS;
  if (data.firstRow < 1) throw new RangeError('Attribute validation error for CFOUTPUT.');
  return data.rows.map((row) => resultRow(ctx, data, row)).join('');
}

/** A pager link to `startRow`; the session keywords are written unencoded, as the view writes them. */
function pagerUrl(ctx: ScreenContext, startRow: number): string {
  const { rc, session } = ctx.req;
  return viewUrl('cArch', 'search', [
    ['siteid', rcText(rc, 'siteid'), 'url'],
    ['keywords', session.keywords],
    ['startrow', startRow],
    ['moduleid', rcText(rc, 'moduleid'), 'url'],
  ]);
}

/** `div.mura-results-wrapper`, shown when the results span more than one page. */
function pager(ctx: ScreenContext, { nextn }: SearchData): string {
  if (nextn.numberOfPages <= 1) return '';
  const meta = ctx.rb.messageFormat(ctx.rb.rbKey('sitemanager.paginationmeta'), [
    `${nextn.startRow}-${String(nextn.through)}`,
    nextn.totalRecords,
  ]);
  let out =
    '\n\t\t<div class="mura-results-wrapper">\n\t\t\t<p class="clearfix search-showing">' +
    `\n\t\t\t\t${meta}\n\t\t\t</p>\n\t\t\t<ul class="pagination">\n\t\t\t`;
  if (nextn.currentPageNumber > 1) {
    out += `\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${pagerUrl(ctx, nextn.previous)}"><i class="mi-angle-left"></i></a>\n\t\t\t\t</li>\n\t\t\t`;
  }
  for (let i = nextn.firstPage; i <= nextn.lastPage; i += 1) {
    out +=
      nextn.currentPageNumber === i
        ? `\n\t\t\t\t\t<li class="active"><a href="#">${String(i)}</a></li>\n\t\t\t\t`
        : `\n\t\t\t\t\t<li><a href="${pagerUrl(ctx, i * nextn.recordsPerPage - nextn.recordsPerPage + 1)}">${String(i)}</a></li>\n\t\t\t\t`;
  }
  if (nextn.currentPageNumber < nextn.numberOfPages) {
    out += `\n\t\t\t\t<li>\n\t\t\t\t\t<a href="${pagerUrl(ctx, nextn.next)}"><i class="mi-angle-right"></i></a>\n\t\t\t\t</li>\n\t\t\t`;
  }
  return `${out}\n\t\t\t</ul>\n\t\t</div>\n\t`;
}

/** The view's markup, which FW/1 hands the layout as `body`. */
function searchBody(ctx: ScreenContext, data: SearchData): SafeHtml {
  const { rc, session } = ctx.req;
  return html`
<h1>Site Search</h1>

<h2>Keyword Search</h2>
<form class="form-inline" novalidate="novalidate" id="siteSearch" name="siteSearch" method="get">
\t<input name="keywords" value="${raw(encodeHtmlAttr(session.keywords))}" type="text" class="text" maxlength="50" /><input type="button" class="btn" onclick="submitForm(document.forms.siteSearch);" value="Search" />
\t<input type="hidden" name="muraAction" value="cArch.search">
\t<input type="hidden" name="siteid" value="${raw(encodeHtmlAttr(rcText(rc, 'siteid')))}">
\t<input type="hidden" name="moduleid" value="${raw(encodeUrl(rcText(rc, 'moduleid')))}">
</form>
<script>
siteManager.copyContentID = '${raw(data.copyContentId)}';
siteManager.copySiteID = '${raw(data.copySiteId)}';
</script>

 <table class="mura-table-grid">
    <tr>
\t  <th>&nbsp;</th>
      <th class="var-width">Title</th>
      <th>Display</th>
      <th>Update</th>
      <th class="actions">&nbsp;</th>
    </tr>
    ${raw(resultRows(ctx, data))}
\t</td></tr></table>
    ${raw(pager(ctx, data))}
</table>
`;
}

/** The `cArch.search` page: the carch `before()` gate, the controller's search, then the view inside the layout. */
export const searchScreen: PageScreen<SearchData> = Object.freeze({
  circuit: 'carch',
  action: 'search',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  async redirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
    const outcome = await controllerRun(ctx);
    return outcome.kind === 'location' ? outcome : undefined;
  },
  async load(ctx: ScreenContext): Promise<SearchData> {
    const outcome = await controllerRun(ctx);
    if (outcome.kind === 'location') throw new Error('carch.search answers its denial from the redirect step');
    return outcome.data;
  },
  render(ctx: ScreenContext, data: SearchData): ShellView {
    return { body: searchBody(ctx, data), ajax: carchJs(ctx, ctx.req.item) };
  },
});

