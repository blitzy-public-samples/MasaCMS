// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { APPROVAL_ACTION } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.approval_action` to `timesheets.approval_action`, tenant from its `Program_<id>` schema. */
export const approvalActionMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'approval_action',
  // Mapping targets are schema-qualified: APPROVAL_ACTION.unit, not the repository's bare APPROVAL_ACTION.table.
  targetTable: APPROVAL_ACTION.unit,
  unit: APPROVAL_ACTION.unit,
  columns: [
    { legacy: 'action_id', target: 'action_id', type: 's' },
    { legacy: 'day_id', target: 'day_id', type: 's' },
    { legacy: 'action', target: 'action', type: 's' },
    { legacy: 'role', target: 'role', type: 's' },
    { legacy: 'from_state', target: 'from_state', type: 's' },
    { legacy: 'to_state', target: 'to_state', type: 's' },
    { legacy: 'actor_user_id', target: 'actor_user_id', type: 's' },
    { legacy: 'comment', target: 'comment', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: APPROVAL_ACTION.key,
  fold: 'Program',
  // The fixture table has no siteID: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
