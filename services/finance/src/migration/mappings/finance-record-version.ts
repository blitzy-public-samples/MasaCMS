// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { FINANCE_RECORD_VERSION } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.finance_record_version` to `finance.record_version`, tenant from its `Program_<id>` schema. */
export const financeRecordVersionMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'finance_record_version',
  // Mapping targets are schema-qualified: FINANCE_RECORD_VERSION.unit, not the repository's bare FINANCE_RECORD_VERSION.table.
  targetTable: FINANCE_RECORD_VERSION.unit,
  unit: FINANCE_RECORD_VERSION.unit,
  columns: [
    { legacy: 'version_id', target: 'version_id', type: 's' },
    { legacy: 'record_id', target: 'record_id', type: 's' },
    { legacy: 'version', target: 'version', type: 'i' },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'title', target: 'title', type: 's' },
    { legacy: 'amount', target: 'amount', type: 'd', scale: 4 },
    { legacy: 'period', target: 'period', type: 's' },
    { legacy: 'action', target: 'action', type: 's' },
    { legacy: 'actor_user_id', target: 'actor_user_id', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: FINANCE_RECORD_VERSION.key,
  fold: 'Program',
  // The fixture table has no siteID: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
