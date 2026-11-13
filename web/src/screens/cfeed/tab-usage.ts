// Usage Report tab of `cfeed/dsp_tab_usage.cfm`, the last pane of the collection edit screen (server-only).
import { formatDateField, parseLegacyDate } from '@/lib/dates';
import { encodeHtml, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest, AdminSessionState } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { cfTruthy, type CfFlag } from './common';

/** One `contentGateway.getUsage(feedID, session.siteid)` row, with its crumb zoom and node verdict from strategies-content. */
export interface FeedUsageRow {
  readonly contentHistID: string;
  readonly contentID: string;
  readonly type: string;
  readonly parentID: string;
  readonly siteID: string;
  readonly moduleID: string;
  readonly display: CfFlag;
  readonly approved: CfFlag;
  readonly displayStart: string | null;
  readonly displayStop: string | null;
  readonly lastUpdate: string | null;
  /** `$.dspZoom(getCrumbList(contentID, rc.siteid))` markup as strategies-content renders it. */
  readonly zoom: string;
  /** `permUtility.getNodePerm(crumbdata)`; `none` disables the edit and version-history items. */
  readonly verdict: string;
}

/** The request values the tab reads: `rc.compactDisplay`, `rc.homeID` and `session.dateKeyFormat`. */
export type FeedUsageRequest = Pick<AdminRequest, 'rc'> & {
  readonly session: Pick<AdminSessionState, 'dateKeyFormat'>;
};

/** The collection type (`feedBean.getType()`) and its usage rows. */
export interface FeedUsageInput {
  readonly feedType: string;
  readonly rows: readonly FeedUsageRow[];
}

/** The tab pane, with the id and label the edit screen appends to its tab lists. */
export interface FeedUsageTab {
  readonly tabId: 'tabUsagereport';
  readonly label: string;
  readonly html: SafeHtml;
}

/** A `collections.*` label, unencoded as legacy writes it. */
function label(rb: RbLookup, key: string): SafeHtml {
  return raw(rb.rbKey(`collections.${key}`));
}

/** `LSDateFormat(value, session.dateKeyFormat)`, unencoded. */
function lsDate(value: string | null, dateKeyFormat: string): SafeHtml {
  // Plain LSDateFormat has no datetimeselector 50-year blanking, so the value is its own reference date.
  return raw(formatDateField(value, dateKeyFormat, parseLegacyDate(value) ?? undefined));
}

/** Display column: Yes, the display window when scheduled, otherwise No. */
function displayCell(row: FeedUsageRow, dateKeyFormat: string): SafeHtml {
  if (cfTruthy(row.display) && Number(row.display) === 1 && cfTruthy(row.approved)) return html`Yes`;
  if (Number(row.display) === 2 && cfTruthy(row.approved)) {
    return html`${lsDate(row.displayStart, dateKeyFormat)} - ${lsDate(row.displayStop, dateKeyFormat)}`;
  }
  return html`No`;
}

/** Edit and version-history items, as links unless the node verdict is `none`. */
function actionItems(row: FeedUsageRow, req: FeedUsageRequest, rb: RbLookup): SafeHtml {
  const edit = label(rb, 'edit');
  const history = label(rb, 'versionhistory');
  if (row.verdict.toLowerCase() === 'none') {
    return html`<li class="edit disabled">${edit}</li><li class="version-history disabled">${history}</li>`;
  }
  // Row values go into the hrefs unencoded, as legacy writes them; only compactDisplay and homeID are html-encoded.
  const target =
    `&contentid=${row.contentID}&type=${row.type}&parentid=${row.parentID}&topid=${row.contentID}` +
    `&siteid=${row.siteID}&moduleid=${row.moduleID}`;
  const editHref = raw(
    `./?muraAction=cArch.edit&contenthistid=${row.contentHistID}${target}` +
      `&compactDisplay=${encodeHtml(req.rc.compactDisplay)}&homeID=${encodeHtml(req.rc.homeID)}`,
  );
  const historyHref = raw(`./?muraAction=cArch.hist${target}`);
  return html`<li class="edit"><a href="${editHref}"><i class="mi-pencil"></i>${edit}</a></li><li class="version-history"><a href="${historyHref}"><i class="mi-history"></i>${history}</a></li>`;
}

/** One table row: actions, crumb zoom, display and last update. */
function usageRow(row: FeedUsageRow, req: FeedUsageRequest, rb: RbLookup): SafeHtml {
  const { dateKeyFormat } = req.session;
  // The double space is what the CFML comment between href and onclick leaves behind.
  return html`\t\t\t\t        <tr>
\t\t\t\t          <td class="actions"><a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a><div class="actions-menu"><ul class="actions-list">${actionItems(row, req, rb)}</ul></div></td>
\t\t\t\t          <td class="var-width">${raw(row.zoom)}</td>
\t\t\t\t          <td>
\t\t\t\t\t    ${displayCell(row, dateKeyFormat)}</td>
\t\t\t\t\t\t<td>${lsDate(row.lastUpdate, dateKeyFormat)}</td>
\t\t\t\t        </tr>
\t\t\t\t      \x20
`;
}

// The whitespace-only lines are the text ACF prints beside the view's cfif and cfloop tags.
/** The usage label and table of a collection with usage rows. */
function usageTable(rows: readonly FeedUsageRow[], req: FeedUsageRequest, rb: RbLookup): SafeHtml {
  return html`\t\t\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t\t<label>${label(rb, 'usagetext')}:</label>
\t\t\t\t\t\t<table id="metadata" class="mura-table-grid">
\t\t\t\t\t    <tr>
\t\t\t\t\t      <th class="actions"></th>
\t\t\t\t\t      <th class="var-width">${label(rb, 'title')}</th>
\t\t\t\t\t      <th>${label(rb, 'display')}</th>
\t\t\t\t\t      <th>${label(rb, 'update')}</th>
\t\t\t\t\t    </tr>
\t\t\t\t    \x20
${rows.map((row) => usageRow(row, req, rb))}\t\t\t\t   \t\t</table>
\t\t\t\t\t\t</div>
\t\t\t\t    \x20
`;
}

/** The empty-usage notice: the index text for a Local collection, else the feed text. */
function emptyUsage(feedType: string, rb: RbLookup): SafeHtml {
  const key = feedType.toLowerCase() === 'local' ? 'noindexusage' : 'nofeedusage';
  return html`\t\t\t\t      \t<div class="help-block-empty">${label(rb, key)}</div>
\t\t\t\t   \x20
`;
}

/** Renders the Usage Report pane of the collection edit screen and returns it with its tab id and label. */
export function renderFeedUsageTab(req: FeedUsageRequest, rb: RbLookup, input: FeedUsageInput): FeedUsageTab {
  const body = input.rows.length > 0 ? usageTable(input.rows, req, rb) : emptyUsage(input.feedType, rb);
  // The block title is literal text in legacy, not a bundle label.
  const pane = html`<div id="tabUsagereport" class="tab-pane">

\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">Usage Report</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">
\t\t\t<div class="mura-control-group">
\t\t\t\t   \x20
${body}\t\t\t </div>

\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->
`;
  return { tabId: 'tabUsagereport', label: rb.rbKey('collections.usagereport'), html: pane };
}
