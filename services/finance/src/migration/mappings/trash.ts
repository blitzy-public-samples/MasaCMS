// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { OWNER, TRASH } from '../../repo/tables.js';

// Finance's ttrash share is the extendObject rows whose subtype's baseTable is a finance table, which no ttrash column
// holds: as for the identity, people, programs-sites and strategies-content shares, the split takes each apply row's
// class-map owner as its discriminator rather than matching the objectClass column.
/** Masa `ttrash` rows whose class-map owner is finance ↔ `finance.trash`; `objectstring` is byte-exact WDDX, tenant from `siteID`. */
export const ttrashMapping: Mapping = defineMapping({
  legacyTable: 'ttrash',
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
  split: { by: 'objectClass', value: OWNER },
  tenant: { kind: 'site', column: 'siteID' },
});
