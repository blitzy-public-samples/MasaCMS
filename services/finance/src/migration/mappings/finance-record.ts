// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { FINANCE_RECORD } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.finance_record` to `finance.record`, tenant from the row's `Program_<id>` schema. */
export const financeRecordMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'finance_record',
  // Mapping targets are schema-qualified: FINANCE_RECORD.unit, not the repository's bare FINANCE_RECORD.table.
  targetTable: FINANCE_RECORD.unit,
  unit: FINANCE_RECORD.unit,
  columns: [
    { legacy: 'record_id', target: 'record_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'title', target: 'title', type: 's' },
    { legacy: 'amount', target: 'amount', type: 'd', scale: 4 },
    { legacy: 'period', target: 'period', type: 's' },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'version', target: 'version', type: 'i' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'createdByID', target: 'createdbyid', type: 's' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'lastUpdateByID', target: 'lastupdatebyid', type: 's' },
  ],
  key: FINANCE_RECORD.key,
  fold: 'Program',
  // The row's siteID is not the tenant source: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
