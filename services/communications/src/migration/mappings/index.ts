// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { messageTemplateMapping } from './message-template.js';
import { messageMapping } from './message.js';
import { deliveryStatusMapping } from './delivery-status.js';
import { emailMapping, emailStatMapping, emailReturnStatMapping } from './email.js';
import { mailingListMapping, mailingListMemberMapping } from './mailing-list.js';
import { trashMapping } from './trash.js';

export { messageTemplateMapping } from './message-template.js';
export { messageMapping } from './message.js';
export { deliveryStatusMapping } from './delivery-status.js';
export { emailMapping, emailStatMapping, emailReturnStatMapping } from './email.js';
export { mailingListMapping, mailingListMemberMapping } from './mailing-list.js';
export { trashMapping } from './trash.js';

// communications.trash is a unit (this service's objectClass share of ttrash), so it is mapped like every other unit;
// scheduled_task has no legacy table and is never mapped.
/** The communications mappings, parents before children, one per unit in `UNITS` order. */
export const MAPPINGS: readonly Mapping[] = Object.freeze([
  messageTemplateMapping,
  messageMapping,
  deliveryStatusMapping,
  emailMapping,
  emailStatMapping,
  emailReturnStatMapping,
  mailingListMapping,
  mailingListMemberMapping,
  trashMapping,
]);
