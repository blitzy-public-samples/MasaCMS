// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, TenantSource } from '@opt2/platform/migration-kit';
import { AUDIT_ENTRY } from '../../repo/tables.js';

// The repository definition declares these target-only columns; neither has a legacy counterpart.
const TARGET_ONLY: ReadonlySet<string> = new Set(['tenant_id', 'row_version']);

// Fixture and target spell every audit_entry column alike (legacy-fixtures/sql/esignature/100_tables.sql).
const columns: MappingColumn[] = AUDIT_ENTRY.columns
  .filter((column) => !TARGET_ONLY.has(column.name))
  .map((column) => ({ legacy: column.name, target: column.name, type: column.type }));

const tenant: TenantSource = {
  kind: 'parent',
  parentLegacyTable: 'synthetic.signature_request',
  columns: { request_id: 'request_id' },
};

/** Mapping of fixture table `synthetic.audit_entry` to `esignature.audit_entry`, hashes as stored, tenant from the parent request. */
export const auditEntryMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.audit_entry',
  // defineMapping needs a schema-qualified target; AUDIT_ENTRY.table is the repository's unqualified name, the unit the qualified one.
  targetTable: AUDIT_ENTRY.unit,
  unit: AUDIT_ENTRY.unit,
  columns,
  key: AUDIT_ENTRY.key,
  tenant,
});
