// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { OWNER, TRASH } from '../../repo/tables.js';

/** Masa `ttrash` rows whose class-map owner is e-signature ↔ `esignature.trash`; `objectstring` is byte-exact WDDX, tenant from `siteID`. */
export const trashMapping: Mapping = defineMapping({
  legacyTable: 'ttrash',
  // defineMapping needs a schema-qualified target; TRASH.table is the repository's unqualified name, the unit the qualified one.
  targetTable: TRASH.unit,
  unit: TRASH.unit,
  columns: [
    { legacy: 'objectID', target: 'objectid', type: 's' },
    { legacy: 'parentID', target: 'parentid', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'objectLabel', target: 'objectlabel', type: 's' },
    { legacy: 'objectClass', target: 'objectclass', type: 's' },
    { legacy: 'objectType', target: 'objecttype', type: 's' },
    { legacy: 'objectSubType', target: 'objectsubtype', type: 's' },
    { legacy: 'objectstring', target: 'objectstring', type: 's' },
    { legacy: 'deletedDate', target: 'deleteddate', type: 't' },
    { legacy: 'deletedBy', target: 'deletedby', type: 's' },
    { legacy: 'deleteid', target: 'deleteid', type: 's' },
    { legacy: 'orderno', target: 'orderno', type: 'i' },
  ],
  key: ['objectID'],
  // The share is the extendObject rows of an e-signature subtype baseTable, which no ttrash column holds, so each
  // apply row's discriminator is its class-map owner, the service name.
  split: { by: 'objectClass', value: OWNER },
  tenant: { kind: 'site', column: 'siteID' },
});
