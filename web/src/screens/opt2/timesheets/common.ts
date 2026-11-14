// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/timesheets';
import { okBody, type GatewayResponse } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { Rc, ScreenContext } from '../../registry';
import { alertBox, errorMessage, opt2Label, type Opt2Params } from '../shared';

export type TimesheetsSchemas = components['schemas'];

/** A read's 2xx body, or the alert its refusal renders in place of the screen content. */
export type Read<T> =
  | { readonly body: T; readonly alert?: undefined }
  | { readonly body?: undefined; readonly alert: SafeHtml };

/** Day lifecycle action as the timesheets contract names it. */
export type DayAction = TimesheetsSchemas['DayAction'];

/** The module slug, which is also the owning service's name. */
export const TIMESHEETS = 'timesheets';

export const SHEETS_SCREEN = 'sheets';
export const SHEET_SCREEN = 'sheet';
export const DAY_ACTION = 'day-action';

/** Roles that reach the timesheets screens; which day actions each may take is the service's answer. */
export const TIMESHEETS_ROLES: readonly Role[] = Object.freeze([
  Roles.timesheetsEmployee,
  Roles.timesheetsPrimaryApprover,
  Roles.timesheetsSecondaryApprover,
]);

/** `rc.asOf` for the service's `asOf` query; absent or empty means the service's today. */
export function asOfOf(rc: Rc): string | undefined {
  return rc.asOf || undefined;
}

/** The site and `asOf` a timesheets screen carries into its links, forms and redirects; empty values are left out. */
export function carriedParams(rc: Rc): Opt2Params {
  return { siteid: rc.siteid || undefined, asOf: asOfOf(rc) };
}

/**
 * The 2xx body of timesheets `operation`, or its envelope error as an alert when the service answers 400 or 404.
 * @throws GatewayDenialError For 401 or 403; any other status throws `Error`.
 */
export function readOf<T>(
  response: { readonly ok: true; readonly body: T } | (GatewayResponse & { readonly ok: false }),
  operation: string,
): Read<T> {
  if (!response.ok && (response.status === 400 || response.status === 404)) {
    return { alert: alertBox(errorMessage(response)) };
  }
  return { body: okBody(response, TIMESHEETS, operation) };
}

/** The `YYYY-MM-DD` date part of a contract `LocalDateTime`. */
export function datePart(value: string): string {
  return value.slice(0, 10);
}

/** The bundle's `Yes` or `No` in the session locale of `ctx`, for a flag column. */
export function yesNo(ctx: ScreenContext, flag: boolean): SafeHtml {
  return opt2Label(ctx, flag ? 'Yes' : 'No');
}
