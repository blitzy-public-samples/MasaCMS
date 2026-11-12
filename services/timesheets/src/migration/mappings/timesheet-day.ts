// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TIMESHEET_DAY } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.timesheet_day` to `timesheets.timesheet_day`, tenant from the row's `Program_<id>` schema. */
export const timesheetDayMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'timesheet_day',
  // Mapping targets are schema-qualified: TIMESHEET_DAY.unit, not the repository's bare TIMESHEET_DAY.table.
  targetTable: TIMESHEET_DAY.unit,
  unit: TIMESHEET_DAY.unit,
  columns: [
    { legacy: 'day_id', target: 'day_id', type: 's' },
    { legacy: 'timesheet_id', target: 'timesheet_id', type: 's' },
    { legacy: 'work_date', target: 'work_date', type: 't' },
    { legacy: 'hours', target: 'hours', type: 'd', scale: 4 },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'lastUpdateByID', target: 'lastupdatebyid', type: 's' },
  ],
  key: TIMESHEET_DAY.key,
  fold: 'Program',
  // The table has no siteID: synthetic.program_site maps the row's Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
