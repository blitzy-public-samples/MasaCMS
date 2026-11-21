// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Rc, ScreenContext } from '../../registry';
import {
  block,
  gridTable,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  pagination,
  readPage,
  type GridCell,
  type Label,
  type Opt2Params,
} from '../shared';
import {
  SHEET_SCREEN,
  SHEETS_SCREEN,
  TIMESHEETS,
  asOfOf,
  carriedParams,
  datePart,
  overdueCell,
  readOf,
  sheetStatusBadge,
  type TimesheetsSchemas,
} from './common';

type Timesheet = TimesheetsSchemas['Timesheet'];

/** Sheets per list page. */
export const SHEETS_PER_PAGE = 50;

/** The sheet list's column headers in the session locale of `ctx`. */
function headersOf(ctx: ScreenContext): readonly Label[] {
  return ['Period', 'Person', opt2Label(ctx, 'Due Date'), opt2Label(ctx, 'Status'), 'Overdue'];
}

/** One page of the tenant's sheets as of the request's `asOf`, or the alert of the service's refusal. */
export type SheetsData =
  | { readonly list: TimesheetsSchemas['TimesheetList']; readonly pageIndex: number; readonly alert?: undefined }
  | { readonly list?: undefined; readonly alert: SafeHtml };

/** `rc.pageIndex` when it is a whole number from 1, else the first page. */
function pageIndexOf(rc: Rc): number {
  const requested = Number(rc.pageIndex);
  return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}

/**
 * The requested page of sheets with their status and overdue flag, or the alert of a 400 or 404 answer.
 * @throws GatewayUnavailableError When timesheets is unavailable.
 * @throws GatewayDenialError When timesheets answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadSheets(ctx: ScreenContext): Promise<SheetsData> {
  const { rc } = ctx.req;
  const { answer: response, page: pageIndex } = await readPage(
    pageIndexOf(rc),
    (index) =>
      ctx.gateway.timesheets.call('get', '/v1/timesheets/sheets', {
        query: { asOf: asOfOf(rc), pageIndex: index, itemsPerPage: SHEETS_PER_PAGE },
      }),
    (answer) => (answer.ok ? Math.ceil(answer.body.total / SHEETS_PER_PAGE) : undefined),
  );
  const read = readOf(response, 'listSheets');
  return read.body === undefined ? { alert: read.alert } : { list: read.body, pageIndex };
}

/** The grid row of `sheet`, its period linking to the sheet detail. */
function sheetRow(ctx: ScreenContext, sheet: Timesheet, params: Opt2Params): GridCell[] {
  const href = opt2ScreenUrl(TIMESHEETS, SHEET_SCREEN, { ...params, timesheetid: sheet.timesheetId });
  return [
    html`<a${attr('href', href)}>${datePart(sheet.periodStart)} - ${datePart(sheet.periodEnd)}</a>`,
    sheet.personId,
    datePart(sheet.dueDate),
    sheetStatusBadge(ctx, sheet.status),
    overdueCell(ctx, sheet.overdue),
  ];
}

/** The sheet list body, with `alert` under its header when given; for a refused read, its alert instead of the list. */
export function sheetsBody(ctx: ScreenContext, data: SheetsData, alert?: SafeHtml): SafeHtml {
  const header = pageHeader('Timesheets');
  if (data.list === undefined) return html`${header}${alert}${data.alert}`;
  const params = carriedParams(ctx.req.rc);
  const rows = data.list.items.map((sheet) => sheetRow(ctx, sheet, params));
  const table = gridTable(headersOf(ctx), rows, 'No timesheets.', {
    columnClasses: [undefined, 'hidden-xs hidden-sm', 'hidden-xs'],
  });
  const pager = pagination(ctx, {
    page: data.pageIndex,
    totalRecords: data.list.total,
    recordsPerPage: SHEETS_PER_PAGE,
    href: (pageIndex) => opt2ScreenUrl(TIMESHEETS, SHEETS_SCREEN, { ...params, pageIndex }),
  });
  const content = html`${table}${pager}`;
  return html`${header}${alert}${block(content)}`;
}

/** The sheet list inside the shell. */
export function renderSheets(ctx: ScreenContext, data: SheetsData): ShellView {
  return opt2View(TIMESHEETS, sheetsBody(ctx, data), SHEETS_SCREEN);
}
