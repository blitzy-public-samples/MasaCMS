// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

/** Masa `ttrash` extendObject rows of survey subtypes ↔ `surveys.trash`, keyed by `objectID`; `objectstring` is byte-exact WDDX. */
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
  // The owning baseTable is the subtype's, which no ttrash column holds: the apply row's discriminator is the class-map owner.
  split: { by: 'objectClass', value: 'surveys' },
  tenant: { kind: 'site', column: 'siteID' },
});
