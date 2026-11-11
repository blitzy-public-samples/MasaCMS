// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { TimesheetState } from './lifecycle.transitions.js';
import type { TimesheetRow } from '../repo/tables.js';

/** Sheet status derived from the sheet's non-blackout days. */
export type SheetStatus = 'RETURNED' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'SUBMITTED' | 'DRAFT';

/** One day of a sheet: its lifecycle state and whether a blackout closes it. */
export interface SheetStatusDay {
  state: TimesheetState;
  blackout: boolean;
}

/** The sheet's due date as the repository reads it, and the request's `yyyy-mm-dd` business date. */
export interface SheetStatusOptions {
  dueDate: TimesheetRow['due_date'];
  asOf: string;
}

/**
 * A sheet's status row: `dayCount` counts every day, blackouts included; `blackoutCount` the blacked-out days;
 * `approvedCount` the non-blackout APPROVED days.
 */
export interface SheetStatusResult {
  status: SheetStatus;
  overdue: boolean;
  dayCount: number;
  blackoutCount: number;
  approvedCount: number;
}

const SUBMITTED_OR_LATER: readonly TimesheetState[] = ['SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'APPROVED'];

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** `yyyy-mm-dd` wall-clock date of a `timestamp without time zone` value as pg returns it (a local `Date`). */
function calendarDate(value: Date): string {
  return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1, 2)}-${pad(value.getDate(), 2)}`;
}

/** Status, overdue flag and day counts of one sheet as of `asOf`; mirrors `tvf_timesheet_status`. */
export function deriveSheetStatus(days: readonly SheetStatusDay[], options: SheetStatusOptions): SheetStatusResult {
  let blackoutCount = 0;
  let open = 0;
  let returned = 0;
  let approved = 0;
  let submittedOrLater = 0;
  let draft = 0;
  for (const day of days) {
    if (day.blackout) {
      blackoutCount += 1;
      continue;
    }
    open += 1;
    if (day.state === 'RETURNED') returned += 1;
    if (day.state === 'APPROVED') approved += 1;
    if (day.state === 'DRAFT') draft += 1;
    if (SUBMITTED_OR_LATER.includes(day.state)) submittedOrLater += 1;
  }

  const status: SheetStatus =
    open === 0
      ? 'DRAFT'
      : returned > 0
        ? 'RETURNED'
        : approved === open
          ? 'APPROVED'
          : approved > 0
            ? 'PARTIALLY_APPROVED'
            : submittedOrLater === open
              ? 'SUBMITTED'
              : 'DRAFT';

  // The fixture binds @asOf as a cf_sql_date (midnight), so `due_date < @asOf` holds exactly when the due date's
  // calendar day precedes asOf; comparing the date texts keeps the result independent of the process TZ.
  const pastDue = calendarDate(options.dueDate) < options.asOf;

  return {
    status,
    overdue: pastDue && draft > 0,
    dayCount: days.length,
    blackoutCount,
    approvedCount: approved,
  };
}
