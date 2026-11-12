/** Migration mapping of Masa `tcontentobjects`, the display-object placements of each content version. */
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { CONTENT_OBJECT } from '../../repo/tables.js';

/** Masa `tcontentobjects` ↔ `content.content_object`; `Params` is a serialized document carried as byte-exact text. */
export const tcontentobjectsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentobjects',
  // defineMapping needs a schema-qualified target; the unit is that name, and CONTENT_OBJECT.table is its unqualified repository form.
  targetTable: CONTENT_OBJECT.unit,
  unit: CONTENT_OBJECT.unit,
  // Live-catalog spelling and order: core/setup/db/mssql.sql:194-203, then Params from core/mura/dbUpdates/5.2.1990.cfm:133.
  columns: [
    { legacy: 'ContentHistID', target: 'contenthistid', type: 's' },
    { legacy: 'ObjectID', target: 'objectid', type: 's' },
    { legacy: 'Object', target: 'object', type: 's' },
    { legacy: 'ContentID', target: 'contentid', type: 's' },
    { legacy: 'Name', target: 'name', type: 's' },
    { legacy: 'OrderNo', target: 'orderno', type: 'i' },
    { legacy: 'SiteID', target: 'siteid', type: 's' },
    { legacy: 'ColumnID', target: 'columnid', type: 'i' },
    { legacy: 'Params', target: 'params', type: 's' },
  ],
  // The SQL Server primary key rebuilt by core/mura/dbUpdates/5.2.1990.cfm:142-150; key names resolve case-insensitively to the legacy columns.
  key: CONTENT_OBJECT.key,
  tenant: { kind: 'site', column: 'SiteID' },
});
