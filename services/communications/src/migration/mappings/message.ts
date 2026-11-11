// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { MESSAGE } from '../../repo/tables.js';

// Target-only source, event_id and row_version stay unmapped and take their 0002 defaults on apply.
// MappingSpec offers no target-row predicate, so login-mail rows are not filtered here; table-ownership records rowPredicate null.
/** Mapping of fixture table `synthetic.message` to `communications.message`, tenant from the row's own `siteID`. */
export const messageMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.message',
  targetTable: MESSAGE.unit,
  unit: MESSAGE.unit,
  columns: [
    { legacy: 'message_id', target: 'message_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'template_id', target: 'template_id', type: 's' },
    { legacy: 'to_address', target: 'to_address', type: 's' },
    { legacy: 'from_address', target: 'from_address', type: 's' },
    { legacy: 'subject', target: 'subject', type: 's' },
    { legacy: 'body_text', target: 'body_text', type: 's' },
    { legacy: 'body_html', target: 'body_html', type: 's' },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'sent_at', target: 'sent_at', type: 't' },
  ],
  key: ['message_id'],
  tenant: { kind: 'site', column: 'siteID' },
});
