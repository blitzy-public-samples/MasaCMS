/** Pub/Sub push delivery: the `/internal/v1/events/<subscription>` route, its body codec and dead-letter classification. */
import { validate as validateUuid } from 'uuid';
import { PUBSUB_INVOKER_ROLE } from '../auth/index.js';
import type { Logger } from '../logging/index.js';
// The event-scope module rather than the service-kit barrel, so events never loads the Fastify factory.
import { recordEventScope } from '../service-kit/event-scope.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from '../service-kit/index.js';
import { isTenantId, type TenantDb } from '../tenancy/index.js';
import { consumeEnvelope, type ConsumerDefinition } from './consumer.js';
import { DeadLetterError, publishDeadLetter, type DeadLetterReason } from './dlq.js';
import { decodeEnvelopeData, type EventEnvelope } from './envelope.js';
import { eventTypeOf, parseTopic, pushPath, subscriptionName, topicOfSubscription } from './naming.js';
import type { EventPublisher } from './publisher.js';
import { compileTopicSchema, validateEnvelope, type TopicValidator } from './validation.js';

/** Pub/Sub push request body (the default JSON wrapper of a push subscription). */
export interface PushBody {
  message: {
    /** Base64 message bytes; absent for an empty message. */
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    message_id?: string;
    publishTime?: string;
    publish_time?: string;
    orderingKey?: string;
  };
  /** Pub/Sub's subscription name, usually `projects/<project>/subscriptions/<name>`. */
  subscription: string;
  /** Present only on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number;
}

/** A push delivery with its message bytes decoded. */
export interface DecodedPush {
  data: Buffer;
  attributes: Record<string, string>;
  messageId: string;
  publishTime?: string;
  orderingKey?: string;
  deliveryAttempt?: number;
  subscription: string;
}

/** Input of {@link buildPushBody}. */
export interface PushBodyInput {
  /** Message bytes; a string is taken as UTF-8 text. */
  data: Buffer | Uint8Array | string;
  attributes?: Record<string, string>;
  messageId: string;
  /** Bare subscription name. */
  subscription: string;
  /** When given, the body names the subscription `projects/<project>/subscriptions/<subscription>`. */
  project?: string;
  orderingKey?: string;
  publishTime?: string;
  deliveryAttempt?: number;
}

/** Raised when a request body is not a Pub/Sub push message; the route answers 400, a nack. */
export class PushBodyError extends Error {
  override readonly name = 'PushBodyError';
}

/** Raised at registration, failing start-up, when a subscription's names, payload schema or consumer disagree. */
export class ConsumerRegistrationError extends Error {
  override readonly name = 'ConsumerRegistrationError';
}

/** Options of {@link registerPushSubscription}. */
export interface PushSubscriptionOptions<P> {
  /** `<consumerService>.<topic>`, as `subscriptionName` builds it. */
  subscription: string;
  /** Defaults to the subscription's topic, which it must equal. */
  topic?: string;
  consumer: ConsumerDefinition<P>;
  /** The topic's payload schema, as `readTopicSchema` reads it from the producer's contracts. */
  payloadSchema: object;
  /** Publishes dead letters. */
  publisher: EventPublisher;
  /** Defaults to `app.opt2.db`. */
  db?: TenantDb;
}

/** One consumer of {@link registerConsumers} with its topic's payload schema. */
export interface ConsumerRegistration {
  // `any`, not `unknown`: a list mixes payload types, and consumers such as tenantRegistryConsumer type their envelope narrowly.
  consumer: ConsumerDefinition<any>;
  payloadSchema: object;
}

/** Options of {@link registerConsumers}. */
export interface RegisterConsumersOptions {
  /** Consuming service; each subscription is `<service>.<topic>`. */
  service: string;
  consumers: readonly ConsumerRegistration[];
  publisher: EventPublisher;
  /** Defaults to `app.opt2.db`. */
  db?: TenantDb;
}

/** Why a delivery is dead-lettered instead of consumed. */
interface Rejection {
  reason: DeadLetterReason;
  /** Fixed text naming the failed check; never message content, which stays in the dead letter. */
  detail: string;
  /** Only a UUID. */
  eventId?: string;
}

type Classified<P> = { envelope: EventEnvelope<P> } | { rejection: Rejection };

/** What a subscription's deliveries must match, fixed at registration. */
interface Expectation<P> {
  topic: string;
  eventType: string;
  major: number;
  validator: TopicValidator<P>;
}

// Standard or URL-safe alphabet with optional padding; Buffer.from would silently skip any other character.
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function decodeBase64(value: unknown): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value !== 'string' || !BASE64.test(value) || value.replace(/=+$/, '').length % 4 === 1) {
    throw new PushBodyError('message.data is not base64');
  }
  return Buffer.from(value, 'base64');
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new PushBodyError(`${field} is not an integer`);
  return value;
}

// Pub/Sub always sends the subscription and string attributes, so a body lacking them is malformed like one lacking a messageId.
/** Decodes a Pub/Sub push body; throws {@link PushBodyError} when it is not one. */
export function decodePushBody(body: unknown): DecodedPush {
  if (!isRecord(body) || !isRecord(body.message)) {
    throw new PushBodyError('push body has no message object');
  }
  const { message, subscription } = body;
  const messageId = optionalString(message.messageId) ?? optionalString(message.message_id);
  const attributes = message.attributes ?? {};
  if (messageId === undefined) throw new PushBodyError('message has no messageId');
  if (typeof subscription !== 'string' || subscription === '') throw new PushBodyError('push body has no subscription');
  if (!isStringRecord(attributes)) throw new PushBodyError('message.attributes is not a map of strings');
  const data = decodeBase64(message.data);
  const deliveryAttempt = optionalInteger(body.deliveryAttempt, 'deliveryAttempt');
  const publishTime = optionalString(message.publishTime) ?? optionalString(message.publish_time);
  const orderingKey = optionalString(message.orderingKey);
  return {
    data,
    attributes: { ...attributes },
    messageId,
    ...(publishTime === undefined ? {} : { publishTime }),
    ...(orderingKey === undefined ? {} : { orderingKey }),
    ...(deliveryAttempt === undefined ? {} : { deliveryAttempt }),
    subscription,
  };
}

/** Builds the body Pub/Sub pushes for a message; the inverse of {@link decodePushBody}. */
export function buildPushBody(input: PushBodyInput): PushBody {
  const { messageId, publishTime, orderingKey, project, deliveryAttempt } = input;
  const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : Buffer.from(input.data);
  return {
    message: {
      data: data.toString('base64'),
      attributes: { ...input.attributes },
      messageId,
      message_id: messageId,
      ...(publishTime === undefined ? {} : { publishTime, publish_time: publishTime }),
      ...(orderingKey === undefined ? {} : { orderingKey }),
    },
    subscription: project === undefined ? input.subscription : `projects/${project}/subscriptions/${input.subscription}`,
    ...(deliveryAttempt === undefined ? {} : { deliveryAttempt }),
  };
}

function registrationError(subscription: string, problem: string, cause?: unknown): ConsumerRegistrationError {
  return new ConsumerRegistrationError(
    `Push subscription ${subscription}: ${problem}`,
    cause === undefined ? undefined : { cause },
  );
}

/** Checks a subscription's names, schema declarations and consumer against each other, and resolves its database. */
function prepare<P>(app: FastifyInstance, opts: PushSubscriptionOptions<P>): { expectation: Expectation<P>; db: TenantDb } {
  const { subscription, consumer } = opts;
  let subscribed: string;
  try {
    subscribed = topicOfSubscription(subscription);
  } catch (err) {
    throw registrationError(subscription, 'invalid subscription name', err);
  }
  const topic = opts.topic ?? subscribed;
  if (topic !== subscribed || consumer.topic !== subscribed) {
    throw registrationError(subscription, `topic ${topic} and consumer topic ${consumer.topic} must both be ${subscribed}`);
  }
  let validator: TopicValidator<P>;
  try {
    validator = compileTopicSchema<P>(opts.payloadSchema);
  } catch (err) {
    throw registrationError(subscription, 'payload schema does not compile', err);
  }
  const { meta } = validator;
  if (meta.kind !== consumer.kind) {
    throw registrationError(subscription, `consumer kind ${consumer.kind} differs from the schema's x-opt2-kind ${meta.kind}`);
  }
  if ((meta.fanout ?? undefined) !== (consumer.fanout ?? undefined)) {
    throw registrationError(
      subscription,
      `consumer fanout ${String(consumer.fanout)} differs from the schema's x-opt2-tenant-fanout ${String(meta.fanout)}`,
    );
  }
  if (Boolean(meta.supersedes) !== Boolean(consumer.supersedes)) {
    throw registrationError(subscription, "consumer supersedes differs from the schema's x-opt2-supersedes");
  }
  const db = opts.db ?? app.opt2?.db;
  if (db === undefined) {
    throw registrationError(subscription, 'no database: pass db or create the service with a pool or schema');
  }
  return { expectation: { topic, eventType: eventTypeOf(topic), major: parseTopic(topic).major, validator }, db };
}

function reject(reason: DeadLetterReason, detail: string, eventId?: string): { rejection: Rejection } {
  return { rejection: { reason, detail, ...(eventId === undefined ? {} : { eventId }) } };
}

/** Validates a delivery once, at this boundary: tenant first, then envelope, topic, payload and attribute tenant. */
function classify<P>(push: DecodedPush, expected: Expectation<P>): Classified<P> {
  let decoded: unknown;
  try {
    decoded = decodeEnvelopeData(push.data);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return reject('schema-invalid', 'message data is not JSON');
  }
  // JSON that is not an object is no envelope at all, so it is schema-invalid rather than missing a tenant.
  if (!isRecord(decoded)) return reject('schema-invalid', 'message data is not a JSON object');
  const eventId = typeof decoded.eventId === 'string' && validateUuid(decoded.eventId) ? decoded.eventId : undefined;
  const { tenantId } = decoded;
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    return reject('missing-tenant', 'envelope has no tenantId', eventId);
  }
  if (!isTenantId(tenantId)) return reject('invalid-tenant', 'envelope tenantId is not a UUID', eventId);
  const checked = validateEnvelope(decoded);
  if (!checked.ok) return reject('schema-invalid', `envelope fails ${checked.schemaPaths.join(', ')}`, eventId);
  const envelope = checked.value;
  if (envelope.eventType !== expected.eventType) {
    return reject('schema-invalid', `envelope eventType does not belong to topic ${expected.topic}`, eventId);
  }
  if (Number(envelope.schemaVersion.split('.', 1)[0]) !== expected.major) {
    return reject('schema-invalid', `envelope schemaVersion major does not belong to topic ${expected.topic}`, eventId);
  }
  const payload = expected.validator.validatePayload(envelope.payload);
  if (!payload.ok) return reject('schema-invalid', `payload fails ${payload.schemaPaths.join(', ')}`, eventId);
  const attributeTenant = push.attributes.tenantId;
  // UUIDs compare case-insensitively; the validated envelope tenant is already lower case.
  if (attributeTenant !== undefined && attributeTenant.toLowerCase() !== envelope.tenantId) {
    return reject('tenant-mismatch', 'tenantId attribute differs from the envelope tenantId', eventId);
  }
  return { envelope: envelope as EventEnvelope<P> };
}

// service-kit hands Fastify the OPT-2 logger, so a request logger is that logger's requestId-bound child.
function requestLogger(request: FastifyRequest): Logger {
  return request.log as unknown as Logger;
}

/** Mounts `POST /internal/v1/events/<subscription>`: 204 acks a consumed or dead-lettered delivery, any other status nacks. */
export function registerPushSubscription<P>(app: FastifyInstance, opts: PushSubscriptionOptions<P>): void {
  const { subscription, consumer, publisher } = opts;
  const { expectation, db } = prepare(app, opts);

  const deadLetter = async (push: DecodedPush, rejection: Rejection, logger: Logger): Promise<void> => {
    const { reason, detail, eventId } = rejection;
    const { data, attributes, orderingKey } = push;
    await publishDeadLetter(publisher, { subscription, data, attributes, orderingKey, reason });
    logger.warn(
      eventId === undefined ? {} : { eventId },
      `delivery ${push.messageId} on ${subscription} dead-lettered as ${reason}: ${detail}`,
    );
  };

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const logger = requestLogger(request);
    let push: DecodedPush;
    try {
      push = decodePushBody(request.body);
    } catch (err) {
      if (!(err instanceof PushBodyError)) throw err;
      logger.warn(`malformed push body on ${subscription}: ${err.message}`);
      return reply.code(400).send();
    }
    const classified = classify(push, expectation);
    if ('rejection' in classified) {
      // A rejected envelope's tenant may be missing or invalid, so only its eventId is bound.
      const { eventId } = classified.rejection;
      if (eventId !== undefined) recordEventScope(request, { eventId });
      await deadLetter(push, classified.rejection, logger);
      return reply.code(204).send();
    }
    const { envelope } = classified;
    recordEventScope(request, { eventId: envelope.eventId, tenantId: envelope.tenantId });
    try {
      await consumeEnvelope(db, consumer, envelope, {
        subscription,
        messageId: push.messageId,
        deliveryAttempt: push.deliveryAttempt,
        logger,
      });
    } catch (err) {
      // Only a classified delivery is acked; every other error nacks through the service-kit error handler.
      if (!(err instanceof DeadLetterError)) throw err;
      // The error's detail can carry tenant ids or stored values, so only its reason is logged.
      await deadLetter(push, { reason: err.reason, detail: 'rejected by the consumer', eventId: envelope.eventId }, logger);
    }
    return reply.code(204).send();
  };

  app.post(
    pushPath(subscription),
    { config: { opt2: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] } } },
    handler,
  );
}

/** Mounts one push subscription, `<service>.<topic>`, per consumer. */
export function registerConsumers(app: FastifyInstance, opts: RegisterConsumersOptions): void {
  const { service, publisher, db } = opts;
  for (const { consumer, payloadSchema } of opts.consumers) {
    let subscription: string;
    try {
      subscription = subscriptionName(service, consumer.topic);
    } catch (err) {
      throw new ConsumerRegistrationError(`Consumer of ${consumer.topic} for service ${service}: invalid name`, { cause: err });
    }
    registerPushSubscription(app, { subscription, consumer, payloadSchema, publisher, db });
  }
}
