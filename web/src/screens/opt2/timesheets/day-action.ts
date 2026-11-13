// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { ScreenContext, SubmitResult } from '../../registry';
import { submitToService, type Opt2Write } from '../shared';
import { SHEET_SCREEN, SHEETS_SCREEN, TIMESHEETS, carriedParams, type DayAction } from './common';
import { loadSheet, sheetBody } from './sheet';
import { loadSheets, sheetsBody } from './sheets';

/**
 * Applies `rc.dayaction` to day `rc.dayid` through timesheets with the posted CSRF pair, then redirects to sheet
 * `rc.timesheetid`, or re-renders it with the service's error; without a sheet id the sheet list stands in for it.
 * @throws GatewayUnavailableError When timesheets is unavailable.
 * @throws GatewayDenialError When timesheets answers 401, or the re-render's reads are denied.
 */
export async function submitDayAction(ctx: ScreenContext): Promise<SubmitResult> {
  const { rc } = ctx.req;
  const params = carriedParams(rc);
  const timesheetid = rc.timesheetid ?? '';
  const write: Opt2Write = {
    service: TIMESHEETS,
    call: (gateway, csrfHeaders) =>
      gateway.timesheets.call('post', '/v1/timesheets/days/{id}/{action}', {
        // The service names the legal actions and answers 404 for any other value, so the posted one goes as is.
        params: { id: rc.dayid ?? '', action: (rc.dayaction ?? '') as DayAction },
        headers: csrfHeaders,
      }),
  };
  if (timesheetid === '') {
    return submitToService(ctx, write, { module: TIMESHEETS, screen: SHEETS_SCREEN, params }, async (alert) =>
      sheetsBody(ctx, await loadSheets(ctx), alert),
    );
  }
  return submitToService(
    ctx,
    write,
    { module: TIMESHEETS, screen: SHEET_SCREEN, params: { ...params, timesheetid } },
    async (alert) => sheetBody(ctx, await loadSheet(ctx), alert),
  );
}
