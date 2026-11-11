// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Producer side of `communications.message.delivery-status-changed.v1`, the full-state event of one outbound message. */
import { compileTopicSchema, readTopicSchema, type TopicValidator } from '@opt2/platform/events';
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import type { MessageDeliveryStatusChangedPayload } from '../generated/events/communications.message.delivery-status-changed.v1.js';
import type { DeliveryStatusRow, MessageRow } from '../repo/tables.js';

export type { MessageDeliveryStatusChangedPayload as DeliveryStatusChangedPayload } from '../generated/events/communications.message.delivery-status-changed.v1.js';

/** Topic of the delivery-status event. */
export const DELIVERY_STATUS_CHANGED_TOPIC = 'communications.message.delivery-status-changed.v1' as const;

/** Envelope kind of the topic: every event carries the message's full delivery state. */
export const DELIVERY_STATUS_KIND = 'state' as const;

/** Envelope aggregate type; the aggregate id is the message id and its version the message's `row_version`. */
export const DELIVERY_STATUS_AGGREGATE_TYPE = 'message' as const;

// Unquoted `T` is the AM/PM marker in a CF datetime mask, so it is quoted to print the literal separator.
const CHANGED_AT_MASK = "yyyy-MM-dd'T'HH:nn:ss.lll";

/** The topic's payload schema, read once at module load. */
export const deliveryStatusChangedSchema = readTopicSchema(
  new URL('../../contracts/events/communications.message.delivery-status-changed.v1.json', import.meta.url),
);

/** Compiled payload validator; its meta declares a `state` topic. */
export const deliveryStatusChangedValidator: TopicValidator = compileTopicSchema(deliveryStatusChangedSchema);

/** Builds the delivery-status payload from a message and its latest status row. */
export function buildDeliveryStatusPayload(
  message: MessageRow,
  status: DeliveryStatusRow,
): MessageDeliveryStatusChangedPayload {
  return {
    messageId: message.message_id,
    siteId: message.siteid,
    source: message.source,
    state: status.status,
    // `communications.message` stores no Mailpit id; only the status row records it, once the message is found.
    mailpitId: status.mailpit_id,
    statusId: status.status_id,
    changedAt: cfDateTimeFormat(status.recorded_at, CHANGED_AT_MASK),
  };
}
