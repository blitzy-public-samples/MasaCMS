// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `timesheets`, as the platform repository declares them: one per fixture table `Program_<id>.<table>`, and the timesheets share of the Masa class-extension tables and `ttrash`. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';

/** PostgreSQL schema owned by the timesheets service. */
export const TIMESHEETS_SCHEMA = 'timesheets' as const;

/** Units of write authority of schema `timesheets`, as `opt2/table-ownership.json` names them, in declaration order. */
export const TIMESHEETS_UNITS = Object.freeze([
  'timesheets.timesheet',
  'timesheets.timesheet_day',
  'timesheets.approval_action',
  'timesheets.blackout',
  'timesheets.extend_subtype',
  'timesheets.extend_set',
  'timesheets.extend_attribute',
  'timesheets.extend_rc_set',
  'timesheets.extend_data',
  'timesheets.trash',
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

/** `timesheets.extend_subtype`, the Masa `tclassextend` rows whose `baseTable` is a timesheets table. */
export const EXTEND_SUBTYPE = frozen<UnitTable<'timesheets.extend_subtype'>>({
  table: 'extend_subtype',
  columns: [
    TENANT_ID,
    { name: 'subtypeid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'basetable', type: 's' },
    { name: 'basekeyfield', type: 's' },
    { name: 'datatable', type: 's' },
    { name: 'type', type: 's' },
    { name: 'subtype', type: 's' },
    { name: 'isactive', type: 'i' },
    { name: 'notes', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'datecreated', type: 't' },
    { name: 'lastupdateby', type: 's' },
    { name: 'hassummary', type: 'i' },
    { name: 'hasbody', type: 'i' },
    { name: 'description', type: 's' },
    { name: 'availablesubtypes', type: 's' },
    { name: 'iconclass', type: 's' },
    { name: 'hasassocfile', type: 'i' },
    { name: 'hasconfigurator', type: 'i' },
    { name: 'adminonly', type: 'i' },
  ],
  key: ['subtypeid'],
  unit: 'timesheets.extend_subtype',
});

/** `timesheets.extend_set`, the Masa `tclassextendsets` rows of timesheets subtypes. */
export const EXTEND_SET = frozen<UnitTable<'timesheets.extend_set'>>({
  table: 'extend_set',
  columns: [
    TENANT_ID,
    { name: 'extendsetid', type: 's' },
    { name: 'subtypeid', type: 's' },
    { name: 'categoryid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'isactive', type: 'i' },
    { name: 'container', type: 's' },
  ],
  key: ['extendsetid'],
  unit: 'timesheets.extend_set',
});

/** `timesheets.extend_attribute`, the Masa `tclassextendattributes` rows of timesheets extend sets. */
export const EXTEND_ATTRIBUTE = frozen<UnitTable<'timesheets.extend_attribute'>>({
  table: 'extend_attribute',
  columns: [
    TENANT_ID,
    { name: 'attributeid', type: 'i' },
    { name: 'extendsetid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'label', type: 's' },
    { name: 'hint', type: 's' },
    { name: 'type', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'isactive', type: 'i' },
    { name: 'required', type: 's' },
    { name: 'validation', type: 's' },
    { name: 'regex', type: 's' },
    { name: 'message', type: 's' },
    { name: 'defaultvalue', type: 's' },
    { name: 'optionlist', type: 's' },
    { name: 'optionlabellist', type: 's' },
    { name: 'adminonly', type: 'i' },
  ],
  key: ['attributeid'],
  unit: 'timesheets.extend_attribute',
});

/** `timesheets.extend_rc_set`, the Masa `tclassextendrcsets` rows of timesheets subtypes. */
export const EXTEND_RC_SET = frozen<UnitTable<'timesheets.extend_rc_set'>>({
  table: 'extend_rc_set',
  columns: [
    TENANT_ID,
    { name: 'subtypeid', type: 's' },
    { name: 'availablesubtypes', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'entitytype', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'relatedcontentsetid', type: 's' },
  ],
  key: ['relatedcontentsetid'],
  unit: 'timesheets.extend_rc_set',
});

/** `timesheets.extend_data`, the Masa `tclassextenddata` values of timesheets attributes. */
export const EXTEND_DATA = frozen<UnitTable<'timesheets.extend_data'>>({
  table: 'extend_data',
  columns: [
    TENANT_ID,
    { name: 'dataid', type: 'i' },
    { name: 'baseid', type: 's' },
    { name: 'attributeid', type: 'i' },
    { name: 'siteid', type: 's' },
    { name: 'attributevalue', type: 's' },
    { name: 'remoteid', type: 's' },
    { name: 'datetimevalue', type: 't' },
    { name: 'numericvalue', type: 'f' },
    { name: 'stringvalue', type: 's' },
  ],
  key: ['dataid'],
  unit: 'timesheets.extend_data',
});

/** `timesheets.trash`, the Masa `ttrash` rows whose class-map owner is timesheets; `objectstring` is byte-exact WDDX. */
export const TRASH = frozen<UnitTable<'timesheets.trash'>>({
  table: 'trash',
  columns: [
    TENANT_ID,
    { name: 'objectid', type: 's' },
    { name: 'parentid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'objectlabel', type: 's' },
    { name: 'objectclass', type: 's' },
    { name: 'objecttype', type: 's' },
    { name: 'objectsubtype', type: 's' },
    { name: 'objectstring', type: 's' },
    { name: 'deleteddate', type: 't' },
    { name: 'deletedby', type: 's' },
    { name: 'deleteid', type: 's' },
    { name: 'orderno', type: 'i' },
  ],
  key: ['objectid'],
  unit: 'timesheets.trash',
});

/** Every owned table, in `TIMESHEETS_UNITS` order; the `tables` of the timesheets repository. */
export const tables = Object.freeze([
  TIMESHEET,
  TIMESHEET_DAY,
  APPROVAL_ACTION,
  BLACKOUT,
  EXTEND_SUBTYPE,
  EXTEND_SET,
  EXTEND_ATTRIBUTE,
  EXTEND_RC_SET,
  EXTEND_DATA,
  TRASH,
] as const);

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
