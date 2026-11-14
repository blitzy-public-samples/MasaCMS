// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

// ttrash is split by objectClass; communications owns the mailinglist and email rows and the extendObject rows of subtypes
// whose baseTable is a communications table, which no ttrash column holds alone, so each apply row's discriminator is its class-map owner.
/** Masa `ttrash` rows of class-map owner communications ↔ `communications.trash`, keyed by `objectID`; `objectstring` is byte-exact WDDX, tenant from `siteID`. */
export const trashMapping: Mapping = defineMapping({
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
  split: { by: 'objectClass', value: 'communications' },
  tenant: { kind: 'site', column: 'siteID' },
});
