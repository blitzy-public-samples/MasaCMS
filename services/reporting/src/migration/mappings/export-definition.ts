// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { EXPORT_DEFINITION } from '../../repo/tables.js';

/** Mapping of fixture table `synthetic.export_definition` to `reporting.export_definition`, tenant from the row's own `siteID`. */
export const exportDefinitionMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.export_definition',
  // A mapping's target table is schema-qualified; EXPORT_DEFINITION.table is the repository's unqualified name, EXPORT_DEFINITION.unit the qualified one.
  targetTable: EXPORT_DEFINITION.unit,
  unit: EXPORT_DEFINITION.unit,
  columns: [
    { legacy: 'definition_id', target: 'definition_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'name', target: 'name', type: 's' },
    { legacy: 'source', target: 'source', type: 's' },
    { legacy: 'columns', target: 'columns', type: 's' },
  ],
  // The spec key names legacy columns; the legacy and target key column share the name definition_id.
  key: EXPORT_DEFINITION.key,
  tenant: { kind: 'site', column: 'siteID' },
});
