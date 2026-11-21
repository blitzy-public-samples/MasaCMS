// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

/** Masa `ttrash` rows whose class-map owner is timesheets ↔ `timesheets.trash`, keyed by `objectID`; `objectstring` is byte-exact WDDX, tenant from `siteID`. */
export const trashMapping: Mapping = defineMapping({
  legacyTable: 'ttrash',
  // Mapping targets are schema-qualified: TRASH.unit, not the repository's bare TRASH.table.
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
  // The timesheets share is the extendObject rows of a timesheets base table, which no ttrash column holds: each apply
  // row's discriminator is its class-map owner, as for the other owners' shares.
  split: { by: 'objectClass', value: 'timesheets' },
  tenant: { kind: 'site', column: 'siteID' },
});
