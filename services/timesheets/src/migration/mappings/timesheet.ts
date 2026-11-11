// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TIMESHEET } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.timesheet` to `timesheets.timesheet`, tenant from the row's `Program_<id>` schema. */
export const timesheetMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'timesheet',
  // Mapping targets are schema-qualified: TIMESHEET.unit, not the repository's bare TIMESHEET.table.
  targetTable: TIMESHEET.unit,
  unit: TIMESHEET.unit,
  columns: [
    { legacy: 'timesheet_id', target: 'timesheet_id', type: 's' },
    { legacy: 'person_id', target: 'person_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'period_start', target: 'period_start', type: 't' },
    { legacy: 'period_end', target: 'period_end', type: 't' },
    { legacy: 'due_date', target: 'due_date', type: 't' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'lastUpdateByID', target: 'lastupdatebyid', type: 's' },
  ],
  key: TIMESHEET.key,
  fold: 'Program',
  // The row's siteID is not the tenant source: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
