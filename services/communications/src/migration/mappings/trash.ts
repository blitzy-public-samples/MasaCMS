// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

// ttrash is split by objectClass; communications owns the rows Masa's trashManager writes for the `mailinglist` and `email` entities.
/** Masa `ttrash` rows of objectClass `mailinglist` and `email` ↔ `communications.trash`; `objectstring` is byte-exact WDDX, tenant from `siteID`. */
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
  split: { by: 'objectClass', value: ['mailinglist', 'email'], column: 'objectClass' },
  tenant: { kind: 'site', column: 'siteID' },
});
