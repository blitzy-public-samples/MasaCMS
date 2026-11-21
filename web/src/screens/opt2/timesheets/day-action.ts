// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { SafeHtml } from '@/lib/html';
import type { ScreenContext, SubmitResult } from '../../registry';
import {
  alertBox,
  invalidParametersAlert,
  isMalformedId,
  opt2View,
  submitToService,
  type Opt2Back,
  type Opt2Write,
} from '../shared';
import { SHEET_SCREEN, SHEETS_SCREEN, TIMESHEETS, carriedParams, type DayAction } from './common';
import { DAY_ACTION_LABELS, loadSheet, sheetBody } from './sheet';
import { loadSheets, sheetsBody } from './sheets';

/** The 404 `notFound` alert timesheets answers a day action its contract does not name with. */
const UNKNOWN_ACTION_ALERT = alertBox('Not Found');

/** Whether `action` is a day action of the timesheets contract, the only path segment the post may name. */
const isDayAction = (action: string): action is DayAction => Object.hasOwn(DAY_ACTION_LABELS, action);

/**
 * Applies `rc.dayaction` to day `rc.dayid` through timesheets with the posted CSRF pair, then redirects to sheet
 * `rc.timesheetid`, or re-renders it with the service's error or, writing nothing, a bad id's or action's alert;
 * without a sheet id the sheet list stands in for it.
 * @throws GatewayUnavailableError When timesheets is unavailable.
 * @throws GatewayDenialError When timesheets answers 401, or the re-render's reads are denied.
 */
export async function submitDayAction(ctx: ScreenContext): Promise<SubmitResult> {
  const { rc } = ctx.req;
  const params = carriedParams(rc);
  const timesheetid = rc.timesheetid ?? '';
  const dayid = rc.dayid ?? '';
  const action = rc.dayaction ?? '';
  const back: Opt2Back =
    timesheetid === ''
      ? { module: TIMESHEETS, screen: SHEETS_SCREEN, params }
      : { module: TIMESHEETS, screen: SHEET_SCREEN, params: { ...params, timesheetid } };
  const rerender = async (alert?: SafeHtml): Promise<SafeHtml> =>
    timesheetid === '' ? sheetsBody(ctx, await loadSheets(ctx), alert) : sheetBody(ctx, await loadSheet(ctx), alert);
  const refused = async (alert?: SafeHtml): Promise<SubmitResult> => ({
    kind: 'render',
    view: opt2View(TIMESHEETS, await rerender(alert), back.screen),
  });
  // The sheet read refuses a malformed sheet id itself, so that answer carries its alert once.
  if (isMalformedId(timesheetid)) return refused();
  if (isMalformedId(dayid)) return refused(invalidParametersAlert());
  if (!isDayAction(action)) return refused(UNKNOWN_ACTION_ALERT);
  const write: Opt2Write = {
    service: TIMESHEETS,
    call: (gateway, csrfHeaders) =>
      gateway.timesheets.call('post', '/v1/timesheets/days/{id}/{action}', {
        params: { id: dayid, action },
        headers: csrfHeaders,
      }),
  };
  return submitToService(ctx, write, back, rerender);
}
