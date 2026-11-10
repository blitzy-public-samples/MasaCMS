/** Pub/Sub topic, subscription, push-path and dead-letter names for OPT-2 events. */

/** Parts of a `<service>.<entity>.<event>.v<major>` topic. */
export interface TopicParts {
  service: string;
  entity: string;
  event: string;
  major: number;
}

const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOPIC_PATTERN = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.v([1-9][0-9]*)$/;

const SEGMENT_FORM = `a name segment matching ${SEGMENT_PATTERN.source}`;
const TOPIC_FORM = '<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const SUBSCRIPTION_FORM = '<consumer>.<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const MAJOR_FORM = 'a positive integer major version';

/** Thrown when a name segment, topic or subscription does not follow the naming rules. */
export class InvalidEventNameError extends Error {
  constructor(value: string, expected: string) {
    super(`Invalid event name "${value}": expected ${expected}`);
    this.name = 'InvalidEventNameError';
  }
}

function assertSegment(value: string): void {
  if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value)) {
    throw new InvalidEventNameError(String(value), SEGMENT_FORM);
  }
}

function splitSubscription(subscription: string): { consumer: string; topic: string } {
  const dot = subscription.indexOf('.');
  const consumer = subscription.slice(0, dot);
  const topic = subscription.slice(dot + 1);
  if (dot < 0 || !SEGMENT_PATTERN.test(consumer) || !TOPIC_PATTERN.test(topic)) {
    throw new InvalidEventNameError(subscription, SUBSCRIPTION_FORM);
  }
  return { consumer, topic };
}

/** Builds `<service>.<entity>.<event>.v<major>`. */
export function topicName(service: string, entity: string, event: string, major = 1): string {
  assertSegment(service);
  assertSegment(entity);
  assertSegment(event);
  if (!Number.isSafeInteger(major) || major < 1) {
    throw new InvalidEventNameError(String(major), MAJOR_FORM);
  }
  return `${service}.${entity}.${event}.v${major}`;
}

/** Splits a topic name into its parts. */
export function parseTopic(topic: string): TopicParts {
  const [, service, entity, event, major] = TOPIC_PATTERN.exec(topic) ?? [];
  if (service === undefined || entity === undefined || event === undefined || major === undefined) {
    throw new InvalidEventNameError(topic, TOPIC_FORM);
  }
  return { service, entity, event, major: Number(major) };
}

/** Whether `value` is a well-formed topic name. */
export function isTopicName(value: unknown): value is string {
  return typeof value === 'string' && TOPIC_PATTERN.test(value);
}

/** Builds the push subscription name `<consumerService>.<topic>`. */
export function subscriptionName(consumerService: string, topic: string): string {
  assertSegment(consumerService);
  parseTopic(topic);
  return `${consumerService}.${topic}`;
}

/** Consuming service of a subscription: the text before its first dot. */
export function consumerOfSubscription(subscription: string): string {
  return splitSubscription(subscription).consumer;
}

/** Topic of a subscription: the text after its first dot. */
export function topicOfSubscription(subscription: string): string {
  return splitSubscription(subscription).topic;
}

/** Path prefix of every push-delivery route. */
export const PUSH_PATH_PREFIX = '/internal/v1/events/';

/** Consumer route that receives push deliveries for a subscription. */
export function pushPath(subscription: string): string {
  splitSubscription(subscription);
  return `${PUSH_PATH_PREFIX}${subscription}`;
}

/** Dead-letter topic of a subscription. */
export function dlqTopicName(subscription: string): string {
  splitSubscription(subscription);
  return `${subscription}.dlq`;
}

/** Pull subscription on a subscription's dead-letter topic, read by DLQ replay. */
export function dlqReplaySubscriptionName(subscription: string): string {
  return `${dlqTopicName(subscription)}.replay`;
}

/** Envelope `eventType` of a topic: the topic without its `.v<major>` suffix. */
export function eventTypeOf(topic: string): string {
  const { service, entity, event } = parseTopic(topic);
  return `${service}.${entity}.${event}`;
}

/** Envelope `schemaVersion` of a topic: `<major>.0.0`. */
export function schemaVersionOf(topic: string): string {
  return `${parseTopic(topic).major}.0.0`;
}

/** Repository-root-relative path of a topic's payload schema. */
export function topicSchemaRelativePath(topic: string): string {
  return `services/${parseTopic(topic).service}/contracts/events/${topic}.json`;
}
