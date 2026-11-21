/** Dead letters: consumer-published letters on `<subscription>.dlq` and the attributes Pub/Sub adds when it forwards one. */
import { dlqTopicName } from './naming.js';
import type { EventPublisher } from './publisher.js';

/** Reasons a consumer dead-letters a delivery instead of nacking it. */
export const DEAD_LETTER_REASONS = ['missing-tenant', 'invalid-tenant', 'schema-invalid', 'tenant-mismatch'] as const;

/** Reason a consumer dead-letters a delivery. */
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

/** Attribute carrying the {@link DeadLetterReason} on a consumer-published dead letter. */
export const DEAD_LETTER_REASON_ATTRIBUTE = 'reason';

/** Prefix of every attribute Pub/Sub adds when its dead-letter policy forwards a message; reserved. */
export const PUBSUB_DEAD_LETTER_ATTRIBUTE_PREFIX = 'CloudPubSubDeadLetter';

/** Source subscription of a Pub/Sub-forwarded message. */
export const DEAD_LETTER_SOURCE_SUBSCRIPTION_ATTRIBUTE = 'CloudPubSubDeadLetterSourceSubscription';

/** Project of the source subscription of a Pub/Sub-forwarded message. */
export const DEAD_LETTER_SOURCE_SUBSCRIPTION_PROJECT_ATTRIBUTE = 'CloudPubSubDeadLetterSourceSubscriptionProject';

/** Delivery attempts made on the source subscription before Pub/Sub forwarded the message. */
export const DEAD_LETTER_SOURCE_DELIVERY_COUNT_ATTRIBUTE = 'CloudPubSubDeadLetterSourceDeliveryCount';

/** Last delivery error Pub/Sub recorded on the source subscription. */
export const DEAD_LETTER_SOURCE_DELIVERY_ERROR_MESSAGE_ATTRIBUTE = 'CloudPubSubDeadLetterSourceDeliveryErrorMessage';

/** Original publish time of a Pub/Sub-forwarded message. */
export const DEAD_LETTER_SOURCE_TOPIC_PUBLISH_TIME_ATTRIBUTE = 'CloudPubSubDeadLetterSourceTopicPublishTime';

/** Whether `value` is a {@link DeadLetterReason}. */
export function isDeadLetterReason(value: unknown): value is DeadLetterReason {
  return typeof value === 'string' && (DEAD_LETTER_REASONS as readonly string[]).includes(value);
}

/** Raised by consumer code to dead-letter a delivery with `reason`; the push handler publishes it and acks. */
export class DeadLetterError extends Error {
  override readonly name = 'DeadLetterError';
  readonly reason: DeadLetterReason;
  readonly detail?: string;

  constructor(reason: DeadLetterReason, detail?: string) {
    super(detail === undefined ? `Dead letter: ${reason}` : `Dead letter: ${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/** A delivery to dead-letter, exactly as it reached the consumer. */
export interface PublishDeadLetterInput {
  subscription: string;
  /** Original message bytes, forwarded unchanged even when they are not a JSON envelope. */
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey?: string;
  reason: DeadLetterReason;
}

/** Publishes the delivery to `<subscription>.dlq` with a `reason` attribute; a failure propagates so the delivery is nacked. */
export function publishDeadLetter(publisher: EventPublisher, input: PublishDeadLetterInput): Promise<string> {
  const { subscription, data, attributes, orderingKey, reason } = input;
  return publisher.publishRaw(dlqTopicName(subscription), {
    data,
    attributes: { ...attributes, [DEAD_LETTER_REASON_ATTRIBUTE]: reason },
    ...(orderingKey === undefined ? {} : { orderingKey }),
  });
}

/** Who wrote a dead letter: the consumer (`reason` attribute) or Pub/Sub's dead-letter policy. */
export type DeadLetterOrigin = 'consumer' | 'pubsub';

/** What a dead letter's attributes say about it. */
export interface DeadLetterDescription {
  origin: DeadLetterOrigin;
  reason?: DeadLetterReason;
  sourceSubscription?: string;
  deliveryCount?: number;
}

// Pub/Sub documents the source subscription only as its "name"; both the short and the full resource form are accepted.
const SUBSCRIPTION_RESOURCE_PREFIX = /^projects\/[^/]+\/subscriptions\//;
const DELIVERY_COUNT_PATTERN = /^[0-9]+$/;

function isPubSubDeadLetterAttribute(key: string): boolean {
  return key.startsWith(PUBSUB_DEAD_LETTER_ATTRIBUTE_PREFIX);
}

/** Describes a dead letter from its attributes; origin is `pubsub` when any `CloudPubSubDeadLetter*` attribute is present. */
export function describeDeadLetter(attributes: Readonly<Record<string, string>>): DeadLetterDescription {
  const description: DeadLetterDescription = {
    origin: Object.keys(attributes).some(isPubSubDeadLetterAttribute) ? 'pubsub' : 'consumer',
  };
  const reason = attributes[DEAD_LETTER_REASON_ATTRIBUTE];
  if (isDeadLetterReason(reason)) description.reason = reason;
  const source = attributes[DEAD_LETTER_SOURCE_SUBSCRIPTION_ATTRIBUTE];
  if (source) description.sourceSubscription = source.replace(SUBSCRIPTION_RESOURCE_PREFIX, '');
  const count = attributes[DEAD_LETTER_SOURCE_DELIVERY_COUNT_ATTRIBUTE];
  if (count !== undefined && DELIVERY_COUNT_PATTERN.test(count)) description.deliveryCount = Number(count);
  return description;
}

/** The attributes a dead letter was first published with: a copy without `reason` and every `CloudPubSubDeadLetter*` key. */
export function originalAttributes(attributes: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key !== DEAD_LETTER_REASON_ATTRIBUTE && !isPubSubDeadLetterAttribute(key)),
  );
}
