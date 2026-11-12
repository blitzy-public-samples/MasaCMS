// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { BLACKOUT } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.blackout` to `timesheets.blackout`, tenant from the row's `Program_<id>` schema. */
export const blackoutMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'blackout',
  // Mapping targets are schema-qualified: BLACKOUT.unit, not the repository's bare BLACKOUT.table.
  targetTable: BLACKOUT.unit,
  unit: BLACKOUT.unit,
  columns: [
    { legacy: 'blackout_id', target: 'blackout_id', type: 's' },
    { legacy: 'day_id', target: 'day_id', type: 's' },
    { legacy: 'person_id', target: 'person_id', type: 's' },
    { legacy: 'archive_id', target: 'archive_id', type: 's' },
    { legacy: 'reason', target: 'reason', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: BLACKOUT.key,
  fold: 'Program',
  // The archived person's user pool never decides the tenant: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
