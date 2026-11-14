// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { html, join, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  actionButton,
  alertBox,
  block,
  gridTable,
  opt2ActionUrl,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  type Label,
} from '../shared';
import {
  DAY_ACTION,
  SHEETS_SCREEN,
  TIMESHEETS,
  asOfOf,
  carriedParams,
  datePart,
  readOf,
  yesNo,
  type DayAction,
  type TimesheetsSchemas,
} from './common';

type TimesheetDetail = TimesheetsSchemas['TimesheetDetail'];
type TimesheetDay = TimesheetsSchemas['TimesheetDay'];

/** A sheet with its days and the day actions the service allows the caller, or the alert that stands in for it. */
export type SheetData =
  | { readonly sheet: TimesheetDetail; readonly alert?: undefined }
  | { readonly sheet?: undefined; readonly alert: SafeHtml };

/** The sheet detail reached without a sheet id. */
const NO_SHEET_ID: SheetData = Object.freeze({ alert: alertBox('Timesheet not found.') });

/** Button label of each day action in the session locale of `ctx`, in the Title Case of legacy admin buttons. */
export const DAY_ACTION_LABELS: Readonly<Record<DayAction, (ctx: ScreenContext) => Label>> = Object.freeze({
  submit: (ctx) => opt2Label(ctx, 'Submit'),
  'primary-approve': () => 'Primary Approve',
  'secondary-approve': () => 'Secondary Approve',
  return: () => 'Return',
  resubmit: () => 'Resubmit',
});

/** The summary grid's column headers in the session locale of `ctx`. */
function summaryHeadersOf(ctx: ScreenContext): readonly Label[] {
  return ['Person', 'Period', opt2Label(ctx, 'Due Date'), opt2Label(ctx, 'Status'), 'Overdue'];
}

/** The day grid's column headers in the session locale of `ctx`. */
function dayHeadersOf(ctx: ScreenContext): readonly Label[] {
  return ['Work Date', opt2Label(ctx, 'Hours'), opt2Label(ctx, 'State'), 'Blackout', opt2Label(ctx, 'Actions')];
}

/**
 * The sheet `rc.timesheetid` as of `rc.asOf`, with the CSRF pair of every day that has an allowed action fetched;
 * the alert of a 400 or 404 answer, or a not-found alert asking nothing without a sheet id.
 * @throws GatewayUnavailableError When timesheets or identity is unavailable.
 * @throws GatewayDenialError When timesheets answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadSheet(ctx: ScreenContext): Promise<SheetData> {
  const { rc } = ctx.req;
  const id = rc.timesheetid ?? '';
  // The service routes `/sheets/` as `/sheets`, so an empty id would read the sheet list instead of a sheet.
  if (id === '') return NO_SHEET_ID;
  const response = await ctx.gateway.timesheets.call('get', '/v1/timesheets/sheets/{id}', {
    params: { id },
    query: { asOf: asOfOf(rc) },
  });
  const read = readOf(response, 'getSheet');
  if (read.body === undefined) return { alert: read.alert };
  const sheet = read.body;
  // Each day form carries the pair of its own day id, the context a day action's token belongs to.
  await ctx.csrf.prefetch(sheet.days.filter((day) => day.allowedActions.length > 0).map((day) => day.dayId));
  return { sheet };
}

/** One post form per action the service allows on `day`, in the service's order. */
function dayActions(ctx: ScreenContext, sheet: TimesheetDetail, day: TimesheetDay, actionUrl: string): SafeHtml {
  return join(
    day.allowedActions.map((action) =>
      actionButton(
        DAY_ACTION_LABELS[action](ctx),
        actionUrl,
        { timesheetid: sheet.timesheetId, dayid: day.dayId, dayaction: action },
        ctx.csrf.render(day.dayId),
      ),
    ),
    ' ',
  );
}

/** The sheet detail body, with `alert` under its header when given; without a sheet, the alert standing in for it. */
export function sheetBody(ctx: ScreenContext, data: SheetData, alert?: SafeHtml): SafeHtml {
  const params = carriedParams(ctx.req.rc);
  const listLink = { label: 'Timesheets', href: opt2ScreenUrl(TIMESHEETS, SHEETS_SCREEN, params) };
  const header = pageHeader('Timesheet', [listLink]);
  if (data.sheet === undefined) return html`${header}${alert}${data.alert}`;
  const { sheet } = data;
  const actionUrl = opt2ActionUrl(TIMESHEETS, DAY_ACTION, params);
  const period = `${datePart(sheet.periodStart)} - ${datePart(sheet.periodEnd)}`;
  const summary = gridTable(
    summaryHeadersOf(ctx),
    [[sheet.personId, period, datePart(sheet.dueDate), sheet.status, yesNo(ctx, sheet.overdue)]],
    '',
  );
  const days = gridTable(
    dayHeadersOf(ctx),
    sheet.days.map((day) => [
      datePart(day.workDate),
      day.hours,
      day.state,
      yesNo(ctx, day.blackout),
      dayActions(ctx, sheet, day, actionUrl),
    ]),
    'This timesheet has no days.',
  );
  return html`${header}${alert}${block(html`${summary}${days}`)}`;
}

/** The sheet detail inside the shell. */
export function renderSheet(ctx: ScreenContext, data: SheetData): ShellView {
  return opt2View(TIMESHEETS, sheetBody(ctx, data));
}
