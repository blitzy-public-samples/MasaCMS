// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { TIMESHEETS_UNITS } from '../../repo/tables.js';
import { timesheetMapping } from './timesheet.js';
import { timesheetDayMapping } from './timesheet-day.js';
import { approvalActionMapping } from './approval-action.js';
import { blackoutMapping } from './blackout.js';

export { timesheetMapping } from './timesheet.js';
export { timesheetDayMapping } from './timesheet-day.js';
export { approvalActionMapping } from './approval-action.js';
export { blackoutMapping } from './blackout.js';

/** The timesheets mappings, parents before children, one per unit in `TIMESHEETS_UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([
  timesheetMapping,
  timesheetDayMapping,
  approvalActionMapping,
  blackoutMapping,
]);

/** Units of write authority the migration handlers gate, exactly `TIMESHEETS_UNITS` in its order. */
export const units = TIMESHEETS_UNITS;

const PROGRAM_SITE_ROWS = { 1: 'tenant-a', 2: 'tenant-b' } as const;

/** Masa site of each fixture `Program_<id>` schema, keyed by program id, as `synthetic.program_site` holds them. */
export const PROGRAM_SITES: typeof PROGRAM_SITE_ROWS & Readonly<Record<number, string>> = Object.freeze(PROGRAM_SITE_ROWS);
