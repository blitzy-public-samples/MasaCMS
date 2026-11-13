// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Rc, ScreenContext } from '../../registry';
import { block, gridTable, opt2ScreenUrl, opt2View, pageHeader, type GridCell, type Opt2Params } from '../shared';
import {
  SHEET_SCREEN,
  SHEETS_SCREEN,
  TIMESHEETS,
  asOfOf,
  carriedParams,
  datePart,
  yesNo,
  type TimesheetsSchemas,
} from './common';

type Timesheet = TimesheetsSchemas['Timesheet'];

/** Sheets per list page. */
export const SHEETS_PER_PAGE = 50;

const HEADERS: readonly string[] = ['Period', 'Person', 'Due Date', 'Status', 'Overdue'];

/** One page of the tenant's sheets, as of the request's `asOf`. */
export interface SheetsData {
  readonly list: TimesheetsSchemas['TimesheetList'];
  readonly pageIndex: number;
}

/** `rc.pageIndex` when it is a whole number from 1, else the first page. */
function pageIndexOf(rc: Rc): number {
  const requested = Number(rc.pageIndex);
  return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}

/**
 * The requested page of sheets with their status and overdue flag.
 * @throws GatewayUnavailableError When timesheets is unavailable.
 * @throws GatewayDenialError When timesheets answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadSheets(ctx: ScreenContext): Promise<SheetsData> {
  const { rc } = ctx.req;
  const pageIndex = pageIndexOf(rc);
  const response = await ctx.gateway.timesheets.call('get', '/v1/timesheets/sheets', {
    query: { asOf: asOfOf(rc), pageIndex, itemsPerPage: SHEETS_PER_PAGE },
  });
  return { list: okBody(response, 'timesheets', 'listSheets'), pageIndex };
}

/** The grid row of `sheet`, its period linking to the sheet detail. */
function sheetRow(sheet: Timesheet, params: Opt2Params): GridCell[] {
  const href = opt2ScreenUrl(TIMESHEETS, SHEET_SCREEN, { ...params, timesheetid: sheet.timesheetId });
  return [
    html`<a${attr('href', href)}>${datePart(sheet.periodStart)} - ${datePart(sheet.periodEnd)}</a>`,
    sheet.personId,
    datePart(sheet.dueDate),
    sheet.status,
    yesNo(sheet.overdue),
  ];
}

/** Previous and next page links around the current page; absent when every sheet fits on one page. */
function pager(params: Opt2Params, pageIndex: number, total: number): SafeHtml | null {
  const pages = Math.ceil(total / SHEETS_PER_PAGE);
  if (pages <= 1) return null;
  const link = (index: number, label: string): SafeHtml => {
    const href = opt2ScreenUrl(TIMESHEETS, SHEETS_SCREEN, { ...params, pageIndex: index });
    return html`<li><a${attr('href', href)}>${label}</a></li>`;
  };
  const previous = pageIndex > 1 ? link(pageIndex - 1, 'Previous') : null;
  const current = html`<li class="active"><span>Page ${pageIndex} of ${pages}</span></li>`;
  const next = pageIndex < pages ? link(pageIndex + 1, 'Next') : null;
  return html`<ul class="pagination">${previous}${current}${next}</ul>`;
}

/** The sheet list body, with `alert` under its header when given. */
export function sheetsBody(ctx: ScreenContext, data: SheetsData, alert?: SafeHtml): SafeHtml {
  const params = carriedParams(ctx.req.rc);
  const rows = data.list.items.map((sheet) => sheetRow(sheet, params));
  const content = html`${gridTable(HEADERS, rows, 'No timesheets.')}${pager(params, data.pageIndex, data.list.total)}`;
  return html`${pageHeader('Timesheets')}${alert}${block(content)}`;
}

/** The sheet list inside the shell. */
export function renderSheets(ctx: ScreenContext, data: SheetsData): ShellView {
  return opt2View(TIMESHEETS, sheetsBody(ctx, data));
}
