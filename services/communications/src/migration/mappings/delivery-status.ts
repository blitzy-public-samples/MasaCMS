// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { DELIVERY_STATUS } from '../../repo/tables.js';

// Target-only source stays unmapped and takes its 0002 default 'send' on apply.
// MappingSpec offers no target-row predicate, so login-mail rows are not filtered here; table-ownership records rowPredicate null.
/** Mapping of fixture table `synthetic.delivery_status` to `communications.delivery_status`, tenant from the parent `synthetic.message`. */
export const deliveryStatusMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.delivery_status',
  targetTable: DELIVERY_STATUS.unit,
  unit: DELIVERY_STATUS.unit,
  columns: [
    { legacy: 'status_id', target: 'status_id', type: 's' },
    { legacy: 'message_id', target: 'message_id', type: 's' },
    { legacy: 'status', target: 'status', type: 's' },
    { legacy: 'detail', target: 'detail', type: 's' },
    { legacy: 'mailpit_id', target: 'mailpit_id', type: 's' },
    { legacy: 'recorded_at', target: 'recorded_at', type: 't' },
  ],
  key: ['status_id'],
  tenant: { kind: 'parent', parentLegacyTable: 'synthetic.message', columns: { message_id: 'message_id' } },
});
