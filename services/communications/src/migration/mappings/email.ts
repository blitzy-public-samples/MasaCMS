// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { EMAIL, EMAIL_RETURN_STAT, EMAIL_STAT } from '../../repo/tables.js';

// A mapping's target table is schema-qualified; each definition's `table` is the repository's unqualified name, its `unit` the qualified one.

/** Masa `temails` ↔ `communications.email`; tenant from the row's `siteid`, the umbrella tenant when it names no site. */
export const emailMapping: Mapping = defineMapping({
  legacyTable: 'temails',
  targetTable: EMAIL.unit,
  unit: EMAIL.unit,
  columns: [
    { legacy: 'EmailID', target: 'emailid', type: 's' },
    { legacy: 'siteid', target: 'siteid', type: 's' },
    { legacy: 'Subject', target: 'subject', type: 's' },
    { legacy: 'BodyText', target: 'bodytext', type: 's' },
    { legacy: 'BodyHtml', target: 'bodyhtml', type: 's' },
    { legacy: 'CreatedDate', target: 'createddate', type: 't' },
    { legacy: 'DeliveryDate', target: 'deliverydate', type: 't' },
    { legacy: 'status', target: 'status', type: 'i' },
    { legacy: 'GroupList', target: 'grouplist', type: 's' },
    { legacy: 'LastUpdateBy', target: 'lastupdateby', type: 's' },
    { legacy: 'LastUpdateByID', target: 'lastupdatebyid', type: 's' },
    { legacy: 'NumberSent', target: 'numbersent', type: 'i' },
    { legacy: 'ReplyTo', target: 'replyto', type: 's' },
    { legacy: 'format', target: 'format', type: 's' },
    { legacy: 'fromLabel', target: 'fromlabel', type: 's' },
    { legacy: 'isDeleted', target: 'isdeleted', type: 'i' },
    { legacy: 'template', target: 'template', type: 's' },
  ],
  key: ['EmailID'],
  tenant: { kind: 'site', column: 'siteid' },
});

/** Masa `temailstats` ↔ `communications.email_stat`, keyless; rows take the tenant of their parent `temails` row. */
export const emailStatMapping: Mapping = defineMapping({
  legacyTable: 'temailstats',
  targetTable: EMAIL_STAT.unit,
  unit: EMAIL_STAT.unit,
  columns: [
    { legacy: 'EmailID', target: 'emailid', type: 's' },
    { legacy: 'Email', target: 'email', type: 's' },
    { legacy: 'emailOpen', target: 'emailopen', type: 'i' },
    { legacy: 'returnClick', target: 'returnclick', type: 'i' },
    { legacy: 'bounce', target: 'bounce', type: 'i' },
    { legacy: 'sent', target: 'sent', type: 'i' },
    { legacy: 'Created', target: 'created', type: 't' },
  ],
  key: null,
  tenant: { kind: 'parent', parentLegacyTable: 'temails', columns: { EmailID: 'EmailID' } },
});

/** Masa `temailreturnstats` ↔ `communications.email_return_stat`, keyless; rows take the tenant of their parent `temails` row. */
export const emailReturnStatMapping: Mapping = defineMapping({
  legacyTable: 'temailreturnstats',
  targetTable: EMAIL_RETURN_STAT.unit,
  unit: EMAIL_RETURN_STAT.unit,
  columns: [
    { legacy: 'emailID', target: 'emailid', type: 's' },
    { legacy: 'email', target: 'email', type: 's' },
    { legacy: 'url', target: 'url', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: null,
  tenant: { kind: 'parent', parentLegacyTable: 'temails', columns: { emailID: 'EmailID' } },
});
