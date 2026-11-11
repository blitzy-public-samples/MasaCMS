// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `timesheets`, one per fixture table `Program_<id>.<table>`, as the platform repository declares them. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';

/** PostgreSQL schema owned by the timesheets service. */
export const TIMESHEETS_SCHEMA = 'timesheets' as const;

/** Units of write authority of schema `timesheets`, as `opt2/table-ownership.json` names them, in declaration order. */
export const TIMESHEETS_UNITS = Object.freeze([
  'timesheets.timesheet',
  'timesheets.timesheet_day',
  'timesheets.approval_action',
  'timesheets.blackout',
] as const);

/** One timesheets unit id. */
export type TimesheetsUnit = (typeof TIMESHEETS_UNITS)[number];

/** A timesheets table definition: keyed by its legacy id and gated by its own unit `U`. */
type UnitTable<U extends TimesheetsUnit> = TableDefinition & { key: string[]; unit: U };

// The platform repository requires tenant_id as a declared column; definition keys omit it although each primary key leads with it.
const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };
const LEGACY_PROGRAM_ID: CanonicalColumn = { name: 'legacy_program_id', type: 'i' };

/** Deep-freezes `def` so no consumer can change the shared catalogue. */
function frozen<T extends UnitTable<TimesheetsUnit>>(def: T): Readonly<T> {
  def.columns.forEach((column) => Object.freeze(column));
  Object.freeze(def.columns);
  Object.freeze(def.key);
  return Object.freeze(def);
}

/** `timesheets.timesheet`, from `Program_<id>.timesheet`: one sheet per person and period. */
export const TIMESHEET = frozen<UnitTable<'timesheets.timesheet'>>({
  table: 'timesheet',
  columns: [
    TENANT_ID,
    { name: 'timesheet_id', type: 's' },
    { name: 'person_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'period_start', type: 't' },
    { name: 'period_end', type: 't' },
    { name: 'due_date', type: 't' },
    { name: 'created', type: 't' },
    { name: 'lastupdate', type: 't' },
    { name: 'lastupdatebyid', type: 's' },
    LEGACY_PROGRAM_ID,
  ],
  key: ['timesheet_id'],
  unit: 'timesheets.timesheet',
});

/** `timesheets.timesheet_day`, from `Program_<id>.timesheet_day`: one work day and its lifecycle state. */
export const TIMESHEET_DAY = frozen<UnitTable<'timesheets.timesheet_day'>>({
  table: 'timesheet_day',
  columns: [
    TENANT_ID,
    { name: 'day_id', type: 's' },
    { name: 'timesheet_id', type: 's' },
    { name: 'work_date', type: 't' },
    { name: 'hours', type: 'd', scale: 4 },
    { name: 'state', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'lastupdatebyid', type: 's' },
    LEGACY_PROGRAM_ID,
  ],
  key: ['day_id'],
  unit: 'timesheets.timesheet_day',
});

/** `timesheets.approval_action`, from `Program_<id>.approval_action`: audit row of each applied day transition. */
export const APPROVAL_ACTION = frozen<UnitTable<'timesheets.approval_action'>>({
  table: 'approval_action',
  columns: [
    TENANT_ID,
    { name: 'action_id', type: 's' },
    { name: 'day_id', type: 's' },
    { name: 'action', type: 's' },
    { name: 'role', type: 's' },
    { name: 'from_state', type: 's' },
    { name: 'to_state', type: 's' },
    { name: 'actor_user_id', type: 's' },
    { name: 'comment', type: 's' },
    { name: 'created', type: 't' },
    LEGACY_PROGRAM_ID,
  ],
  key: ['action_id'],
  unit: 'timesheets.approval_action',
});

/** `timesheets.blackout`, from `Program_<id>.blackout`: a timesheet day closed by a person archive. */
export const BLACKOUT = frozen<UnitTable<'timesheets.blackout'>>({
  table: 'blackout',
  columns: [
    TENANT_ID,
    { name: 'blackout_id', type: 's' },
    { name: 'day_id', type: 's' },
    { name: 'person_id', type: 's' },
    { name: 'archive_id', type: 's' },
    { name: 'reason', type: 's' },
    { name: 'created', type: 't' },
    LEGACY_PROGRAM_ID,
  ],
  key: ['blackout_id'],
  unit: 'timesheets.blackout',
});

/** Every owned table, in `TIMESHEETS_UNITS` order; the `tables` of the timesheets repository. */
export const tables = Object.freeze([TIMESHEET, TIMESHEET_DAY, APPROVAL_ACTION, BLACKOUT] as const);

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** A `timesheets.timesheet` row as pg returns it. */
export type TimesheetRow = {
  tenant_id: string;
  timesheet_id: string;
  person_id: string;
  siteid: string;
  period_start: Date;
  period_end: Date;
  due_date: Date;
  created: Date;
  lastupdate: Date | null;
  lastupdatebyid: string | null;
  legacy_program_id: number;
};

/** A `timesheets.timesheet_day` row as pg returns it; `hours` is four-decimal text. */
export type TimesheetDayRow = {
  tenant_id: string;
  day_id: string;
  timesheet_id: string;
  work_date: Date;
  hours: string;
  state: string;
  lastupdate: Date | null;
  lastupdatebyid: string | null;
  legacy_program_id: number;
};

/** A `timesheets.approval_action` row as pg returns it. */
export type ApprovalActionRow = {
  tenant_id: string;
  action_id: string;
  day_id: string;
  action: string;
  role: string;
  from_state: string;
  to_state: string;
  actor_user_id: string;
  comment: string | null;
  created: Date;
  legacy_program_id: number;
};

/** A `timesheets.blackout` row as pg returns it. */
export type BlackoutRow = {
  tenant_id: string;
  blackout_id: string;
  day_id: string;
  person_id: string;
  archive_id: string | null;
  reason: string;
  created: Date;
  legacy_program_id: number;
};
