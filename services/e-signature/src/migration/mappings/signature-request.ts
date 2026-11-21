// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { SIGNATURE_REQUEST } from '../../repo/tables.js';

// Fixture spelling (legacy-fixtures/sql/esignature/100_tables.sql) of the columns whose target name is lower-cased.
const LEGACY_SPELLING: ReadonlyMap<string, string> = new Map([
  ['siteid', 'siteID'],
  ['createdbyid', 'createdByID'],
]);

// The repository definition declares these target-only columns; neither has a legacy counterpart.
const TARGET_ONLY: ReadonlySet<string> = new Set(['tenant_id', 'row_version']);

const columns: MappingColumn[] = SIGNATURE_REQUEST.columns
  .filter((column) => !TARGET_ONLY.has(column.name))
  .map((column) => ({ legacy: LEGACY_SPELLING.get(column.name) ?? column.name, target: column.name, type: column.type }));

/** Mapping of fixture table `synthetic.signature_request` to `esignature.signature_request`, tenant from the row's own `siteID`. */
export const signatureRequestMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.signature_request',
  // defineMapping needs a schema-qualified target; SIGNATURE_REQUEST.table is the repository's unqualified name, the unit the qualified one.
  targetTable: SIGNATURE_REQUEST.unit,
  unit: SIGNATURE_REQUEST.unit,
  columns,
  key: SIGNATURE_REQUEST.key,
  tenant: { kind: 'site', column: 'siteID' },
});
