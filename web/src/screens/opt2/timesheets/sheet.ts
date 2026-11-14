// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, join, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  actionButton,
  alertBox,
  block,
  gridTable,
  opt2ActionUrl,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
} from '../shared';
import {
  DAY_ACTION,
  SHEETS_SCREEN,
  TIMESHEETS,
  asOfOf,
  carriedParams,
  datePart,
  yesNo,
  type DayAction,
  type TimesheetsSchemas,
} from './common';

type TimesheetDetail = TimesheetsSchemas['TimesheetDetail'];
type TimesheetDay = TimesheetsSchemas['TimesheetDay'];

/** A sheet with its days and the day actions the service allows the caller; `null` when no sheet id was given. */
export type SheetData = TimesheetDetail | null;

/** Button label of each day action, in the Title Case of legacy admin buttons. */
export const DAY_ACTION_LABELS: Readonly<Record<DayAction, string>> = Object.freeze({
  submit: 'Submit',
  'primary-approve': 'Primary Approve',
  'secondary-approve': 'Secondary Approve',
  return: 'Return',
  resubmit: 'Resubmit',
});

const SUMMARY_HEADERS: readonly string[] = ['Person', 'Period', 'Due Date', 'Status', 'Overdue'];
const DAY_HEADERS: readonly string[] = ['Work Date', 'Hours', 'State', 'Blackout', 'Actions'];

/**
 * The sheet `rc.timesheetid` as of `rc.asOf`, with the CSRF pair of every day that has an allowed action fetched;
 * `null`, asking nothing, without a sheet id.
 * @throws GatewayUnavailableError When timesheets or identity is unavailable.
 * @throws GatewayDenialError When timesheets answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadSheet(ctx: ScreenContext): Promise<SheetData> {
  const { rc } = ctx.req;
  const id = rc.timesheetid ?? '';
  // The service routes `/sheets/` as `/sheets`, so an empty id would read the sheet list instead of a sheet.
  if (id === '') return null;
  const response = await ctx.gateway.timesheets.call('get', '/v1/timesheets/sheets/{id}', {
    params: { id },
    query: { asOf: asOfOf(rc) },
  });
  const sheet = okBody(response, 'timesheets', 'getSheet');
  // Each day form carries the pair of its own day id, the context a day action's token belongs to.
  await ctx.csrf.prefetch(sheet.days.filter((day) => day.allowedActions.length > 0).map((day) => day.dayId));
  return sheet;
}

/** One post form per action the service allows on `day`, in the service's order. */
function dayActions(ctx: ScreenContext, sheet: TimesheetDetail, day: TimesheetDay, actionUrl: string): SafeHtml {
  return join(
    day.allowedActions.map((action) =>
      actionButton(
        DAY_ACTION_LABELS[action],
        actionUrl,
        { timesheetid: sheet.timesheetId, dayid: day.dayId, dayaction: action },
        ctx.csrf.render(day.dayId),
      ),
    ),
    ' ',
  );
}

/** The sheet detail body, with `alert` under its header when given; without a sheet, a not-found alert. */
export function sheetBody(ctx: ScreenContext, sheet: SheetData, alert?: SafeHtml): SafeHtml {
  const params = carriedParams(ctx.req.rc);
  const listLink = { label: 'Timesheets', href: opt2ScreenUrl(TIMESHEETS, SHEETS_SCREEN, params) };
  const header = pageHeader('Timesheet', [listLink]);
  if (sheet === null) return html`${header}${alert}${alertBox('Timesheet not found.')}`;
  const actionUrl = opt2ActionUrl(TIMESHEETS, DAY_ACTION, params);
  const period = `${datePart(sheet.periodStart)} - ${datePart(sheet.periodEnd)}`;
  const summary = gridTable(
    SUMMARY_HEADERS,
    [[sheet.personId, period, datePart(sheet.dueDate), sheet.status, yesNo(sheet.overdue)]],
    '',
  );
  const days = gridTable(
    DAY_HEADERS,
    sheet.days.map((day) => [
      datePart(day.workDate),
      day.hours,
      day.state,
      yesNo(day.blackout),
      dayActions(ctx, sheet, day, actionUrl),
    ]),
    'This timesheet has no days.',
  );
  return html`${header}${alert}${block(html`${summary}${days}`)}`;
}

/** The sheet detail inside the shell. */
export function renderSheet(ctx: ScreenContext, sheet: SheetData): ShellView {
  return opt2View(TIMESHEETS, sheetBody(ctx, sheet));
}
