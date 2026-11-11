import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { SYSTEM_OBJECT } from '../../repo/tables.js';

/** Masa `tsystemobjects` ↔ `programs_sites.system_object`; keyless multiset rows, tenant from the row's own `SiteID`. */
export const tsystemobjectsMapping: Mapping = defineMapping({
  legacyTable: 'tsystemobjects',
  // defineMapping needs a schema-qualified target; the unit is that name, and SYSTEM_OBJECT.table is its unqualified repository form.
  targetTable: SYSTEM_OBJECT.unit,
  unit: SYSTEM_OBJECT.unit,
  columns: [
    { legacy: 'Object', target: 'object', type: 's' },
    { legacy: 'SiteID', target: 'siteid', type: 's' },
    { legacy: 'Name', target: 'name', type: 's' },
    { legacy: 'OrderNo', target: 'orderno', type: 'i' },
  ],
  key: null,
  tenant: { kind: 'site', column: 'SiteID' },
});
