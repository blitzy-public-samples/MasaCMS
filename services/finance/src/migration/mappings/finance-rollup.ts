// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { LEGACY_PROGRAM_ID_COLUMN, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { FINANCE_ROLLUP } from '../../repo/tables.js';

/** Mapping of fixture table `Program_<id>.finance_rollup` to `finance.rollup`, tenant from the row's `Program_<id>` schema. */
export const financeRollupMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'finance_rollup',
  // Mapping targets are schema-qualified: FINANCE_ROLLUP.unit, not the repository's bare FINANCE_ROLLUP.table.
  targetTable: FINANCE_ROLLUP.unit,
  unit: FINANCE_ROLLUP.unit,
  columns: [
    { legacy: 'period', target: 'period', type: 's' },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'record_count', target: 'record_count', type: 'i' },
    { legacy: 'total_amount', target: 'total_amount', type: 'd', scale: 4 },
    { legacy: 'computed_at', target: 'computed_at', type: 't' },
  ],
  // The legacy key is PK_finance_rollup (period, state): the target key without the fold's legacy_program_id, which
  // defineMapping reserves and so cannot be a mapped key column.
  key: FINANCE_ROLLUP.key.filter((column) => column !== LEGACY_PROGRAM_ID_COLUMN),
  fold: 'Program',
  // Rollups carry no siteID: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});
