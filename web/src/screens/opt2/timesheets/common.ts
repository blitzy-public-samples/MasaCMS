// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/timesheets';
import type { SafeHtml } from '@/lib/html';
import type { Rc, ScreenContext } from '../../registry';
import { opt2Label, type Opt2Params } from '../shared';

export type TimesheetsSchemas = components['schemas'];

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

/** The `YYYY-MM-DD` date part of a contract `LocalDateTime`. */
export function datePart(value: string): string {
  return value.slice(0, 10);
}

/** The bundle's `Yes` or `No` in the session locale of `ctx`, for a flag column. */
export function yesNo(ctx: ScreenContext, flag: boolean): SafeHtml {
  return opt2Label(ctx, flag ? 'Yes' : 'No');
}
