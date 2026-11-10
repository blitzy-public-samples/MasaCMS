// Category usage tab of `ccategory/dsp_tab_usage.cfm`; no legacy ccategory view includes it, so no screen renders it.
import { formatDateField, parseLegacyDate } from '@/lib/dates';
import { html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** One `contentGateway.getUsage` row, with its crumb zoom and node verdict computed by strategies-content. */
export type CategoryUsageRow = {
  readonly contentID: string;
  readonly contentHistID: string;
  readonly type: string;
  readonly parentID: string;
  readonly siteID: string;
  readonly moduleID: string;
  readonly display: number;
  readonly approved: boolean | number;
  readonly displayStart: string | null;
  readonly displayStop: string | null;
  readonly lastUpdate: string | null;
  readonly verdict: string;
  readonly zoom: SafeHtml;
};

// Legacy markup typos, emitted verbatim.
const NO_RESULTS_CLASS = raw('cl<ass="noResults"');
const STRAY_CLOSE = raw('</td></tr></table>');

/** A `categorymanager.*` label, unencoded as legacy writes it. */
function label(rb: RbLookup, key: string): SafeHtml {
  return raw(rb.rbKey(`categorymanager.${key}`));
}

/** `LSDateFormat(value, session.dateKeyFormat)`, unencoded. */
function lsDate(value: string | null, dateKeyFormat: string): SafeHtml {
  // Plain LSDateFormat has no datetimeselector 50-year blanking, so the value is its own reference date.
  return raw(formatDateField(value, dateKeyFormat, parseLegacyDate(value) ?? undefined));
}

/** Display column: Yes, the display window when scheduled, otherwise No. */
function displayCell(row: CategoryUsageRow, rb: RbLookup, dateKeyFormat: string): SafeHtml {
  const approved = Boolean(row.approved);
  if (row.display === 1 && approved) return label(rb, 'yes');
  if (row.display === 2 && approved) {
    return html`${lsDate(row.displayStart, dateKeyFormat)} - ${lsDate(row.displayStop, dateKeyFormat)}`;
  }
  return label(rb, 'no');
}

/** Edit and version-history items, as links unless the node verdict is `none`. */
function actionItems(row: CategoryUsageRow, rb: RbLookup): SafeHtml {
  const edit = label(rb, 'edit');
  const history = label(rb, 'versionhistory');
  if (row.verdict.toLowerCase() === 'none') {
    return html`<li class="edit disabled">${edit}</li><li class="version-history disabled">${history}</li>`;
  }
  const query = `&contentid=${row.contentID}&type=${row.type}&parentid=${row.parentID}&topid=${row.contentID}&siteid=${row.siteID}&moduleid=${row.moduleID}`;
  const editHref = raw(`./?muraAction=cArch.edit&contenthistid=${row.contentHistID}${query}`);
  const historyHref = raw(`./?muraAction=cArch.hist${query}`);
  return html`<li class="edit"><a title="${edit}" href="${editHref}"><i class="mi-pencil"></i></a></li><li class="version-history"><a title="${history}" href="${historyHref}"><i class="mi-history"></i></a></li>`;
}

/** One table row: zoom, display, last update and actions. */
function usageRow(row: CategoryUsageRow, rb: RbLookup, dateKeyFormat: string): SafeHtml {
  return html`
        <tr>
          <td class="var-width">${row.zoom}</td>
          <td>
            ${displayCell(row, rb, dateKeyFormat)}</td>
          <td>${lsDate(row.lastUpdate, dateKeyFormat)}</td>
          <td class="actions"><ul>${actionItems(row, rb)}</ul></td></tr>`;
}

/** Renders the category usage table for `rows`, or the no-usage row when there are none. */
export function renderCategoryUsage(input: {
  readonly rows: readonly CategoryUsageRow[];
  readonly rb: RbLookup;
  readonly dateKeyFormat: string;
}): SafeHtml {
  const { rows, rb, dateKeyFormat } = input;
  const body =
    rows.length > 0
      ? rows.map((row) => usageRow(row, rb, dateKeyFormat))
      : html`
      <tr>
        <td colspan="7" ${NO_RESULTS_CLASS}>${label(rb, 'nousage')}</td>
      </tr>`;
  return html`<div class="page_aTab">
<dl class="oneColumn">
<dt class="first">${label(rb, 'usagetext')}:</dt>
 <table class="mura-table-grid">
    <tr>
      <th class="var-width">${label(rb, 'title')}</th>
      <th>${label(rb, 'display')}</th>
      <th>${label(rb, 'update')}</th>
      <th class="actions">&nbsp;</th>
    </tr>${body}
  </table>
${STRAY_CLOSE}
</dl>
</div>`;
}
