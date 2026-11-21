// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, TenantSource } from '@opt2/platform/migration-kit';
import { SIGNATURE } from '../../repo/tables.js';

// The repository definition declares these target-only columns; neither has a legacy counterpart.
const TARGET_ONLY: ReadonlySet<string> = new Set(['tenant_id', 'row_version']);

// Fixture columns (legacy-fixtures/sql/esignature/100_tables.sql) are spelled exactly as their target columns.
const columns: MappingColumn[] = SIGNATURE.columns
  .filter((column) => !TARGET_ONLY.has(column.name))
  .map((column) => ({ legacy: column.name, target: column.name, type: column.type }));

// The fixture row has no site column, so its tenant is that of the request it signs.
const tenant: TenantSource = {
  kind: 'parent',
  parentLegacyTable: 'synthetic.signature_request',
  columns: { request_id: 'request_id' },
};

/** Mapping of fixture table `synthetic.signature` to `esignature.signature`, tenant from the parent `synthetic.signature_request`. */
export const signatureMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.signature',
  // defineMapping needs a schema-qualified target; SIGNATURE.table is the repository's unqualified name, the unit the qualified one.
  targetTable: SIGNATURE.unit,
  unit: SIGNATURE.unit,
  columns,
  key: SIGNATURE.key,
  tenant,
});
