// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { MAILING_LIST, MAILING_LIST_MEMBER } from '../../repo/tables.js';

/** Masa `tmailinglist` ↔ `communications.mailing_list`; keyless multiset rows, tenant from the row's own `SiteID`. */
export const mailingListMapping: Mapping = defineMapping({
  legacyTable: 'tmailinglist',
  // A communications unit is one table named `communications.<table>`: the schema-qualified form defineMapping needs, which MAILING_LIST.table lacks.
  targetTable: MAILING_LIST.unit,
  unit: MAILING_LIST.unit,
  columns: [
    { legacy: 'MLID', target: 'mlid', type: 's' },
    { legacy: 'SiteID', target: 'siteid', type: 's' },
    { legacy: 'Name', target: 'name', type: 's' },
    { legacy: 'Description', target: 'description', type: 's' },
    { legacy: 'LastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'isPurge', target: 'ispurge', type: 'i' },
    { legacy: 'isPublic', target: 'ispublic', type: 'i' },
  ],
  key: null,
  tenant: { kind: 'site', column: 'SiteID' },
});

/** Masa `tmailinglistmembers` ↔ `communications.mailing_list_member`; keyless multiset rows, tenant from the member row's own `SiteID`. */
export const mailingListMemberMapping: Mapping = defineMapping({
  legacyTable: 'tmailinglistmembers',
  targetTable: MAILING_LIST_MEMBER.unit,
  unit: MAILING_LIST_MEMBER.unit,
  columns: [
    { legacy: 'MLID', target: 'mlid', type: 's' },
    { legacy: 'Email', target: 'email', type: 's' },
    { legacy: 'SiteID', target: 'siteid', type: 's' },
    { legacy: 'fname', target: 'fname', type: 's' },
    { legacy: 'lname', target: 'lname', type: 's' },
    { legacy: 'company', target: 'company', type: 's' },
    { legacy: 'isVerified', target: 'isverified', type: 'i' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: null,
  tenant: { kind: 'site', column: 'SiteID' },
});
