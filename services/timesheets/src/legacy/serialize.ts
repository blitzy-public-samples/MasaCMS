// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections: target `timesheets` rows as timesheets.cfc's `envelope.rows()` renders the `Program_<id>` rows and procedure results. */
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import type { DayActionResult } from '../domain/day-action.js';
import type { TimesheetState } from '../domain/lifecycle.transitions.js';
import type { SheetStatus, SheetStatusResult } from '../domain/sheet-status.js';
import type { DayWithBlackout } from '../repo/repository.js';
import type { TimesheetRow } from '../repo/tables.js';

// envelope.cfc rows() renders datetime columns with this dateTimeFormat mask before serialization, not through the serializer's date hint.
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** The legal outcome of `performDayAction`, the only one the fixture answers with day data. */
export type LegalDayActionResult = Extract<DayActionResult, { outcome: 'legal' }>;

// A bare TimesheetDayRow is not accepted: the fixture's findDays query always selects the blackout flag with the day.
/** A day and whether a blackout closes it, the inputs of one fixture day row; `DayWithBlackout` qualifies as is. */
export type FixtureDaySource = Pick<DayWithBlackout, 'day' | 'blackout'>;

/** A `findDays` row: `timesheet_day` columns in select order plus the `isblackout` flag. */
export type FixtureDay = {
  day_id: string;
  timesheet_id: string;
  work_date: string;
  hours: string;
  state: TimesheetState;
  isblackout: boolean;
};

/** A `usp_timesheet_status` row with lower-cased column names; also one item of the sheet list. */
export type FixtureSheetStatus = {
  timesheet_id: string;
  status: SheetStatus;
  overdue: boolean;
  day_count: number;
  blackout_count: number;
  approved_count: number;
};

/** The sheet detail: `timesheet` columns in catalog order with NULL as '', then the status fields, then the days. */
export type FixtureSheet = {
  timesheet_id: string;
  person_id: string;
  siteid: string;
  period_start: string;
  period_end: string;
  due_date: string;
  created: string;
  lastupdate: string;
  lastupdatebyid: string;
  status: SheetStatus;
  overdue: boolean;
  day_count: number;
  blackout_count: number;
  approved_count: number;
  days: FixtureDay[];
};

/** The day a legal day action answers with, as the fixture re-reads it after the transition. */
export type FixtureDayAction = FixtureDay;

/** Fixture text of a stored datetime in the process (legacy server) zone, or '' for NULL. */
function timestamp(value: Date | null): string {
  return value === null ? '' : cfDateTimeFormat(value, FIXTURE_TIMESTAMP_MASK);
}

/** Projects a day and its blackout flag onto the fixture day fields; `hours` keeps the stored four-decimal text. */
export function dayRow({ day, blackout }: FixtureDaySource): FixtureDay {
  return {
    day_id: day.day_id,
    timesheet_id: day.timesheet_id,
    work_date: timestamp(day.work_date),
    hours: day.hours,
    state: day.state as TimesheetState,
    isblackout: blackout,
  };
}

/** Projects a sheet's derived status onto the fixture status row. */
export function statusRow({ sheet, status }: { sheet: Pick<TimesheetRow, 'timesheet_id'>; status: SheetStatusResult }): FixtureSheetStatus {
  return {
    timesheet_id: sheet.timesheet_id,
    status: status.status,
    overdue: status.overdue,
    day_count: status.dayCount,
    blackout_count: status.blackoutCount,
    approved_count: status.approvedCount,
  };
}

// The fixture detail always merges the status row between the sheet columns and the days, so the status is a required input.
/** Projects a sheet, its derived status and its days, in the order given, onto the fixture sheet detail. */
export function sheetRow({
  sheet,
  status,
  days,
}: {
  sheet: TimesheetRow;
  status: SheetStatusResult;
  days: readonly FixtureDaySource[];
}): FixtureSheet {
  const { timesheet_id, ...statusFields } = statusRow({ sheet, status });
  return {
    timesheet_id,
    person_id: sheet.person_id,
    siteid: sheet.siteid,
    period_start: timestamp(sheet.period_start),
    period_end: timestamp(sheet.period_end),
    due_date: timestamp(sheet.due_date),
    created: timestamp(sheet.created),
    lastupdate: timestamp(sheet.lastupdate),
    lastupdatebyid: sheet.lastupdatebyid ?? '',
    ...statusFields,
    days: days.map(dayRow),
  };
}

/** Projects a legal day action onto the fixture's re-read of its day; legal implies no blackout, since the blackout guard rejects the action. */
export function dayActionResult(result: LegalDayActionResult): FixtureDayAction {
  return dayRow({ day: result.day, blackout: false });
}
