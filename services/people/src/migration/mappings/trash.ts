import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

/** ttrash rows whose class-map owner is people → people.trash; `objectstring` is byte-exact WDDX [5.2.1.2893.cfm:7-18, 5.7.cfm:104-107]. */
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
  // The people share (`user` stored as Type=2, `address` of a Type=2 owner, `extendObject` of a user base table) depends on
  // a Type or baseTable no ttrash column holds, so each apply row's discriminator is its class-map owner, as for identity.
  split: { by: 'objectClass', value: 'people' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Every people ttrash mapping, for the mappings barrel. */
export const TRASH_MAPPINGS: readonly Mapping[] = [trashMapping];
