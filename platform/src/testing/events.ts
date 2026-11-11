/** Event test helpers of `@opt2/platform/testing`: envelopes, a capturing publisher, push delivery through `app.inject` and Pub/Sub emulator resources. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Message, PubSub, Subscription, Topic } from '@google-cloud/pubsub';
import {
  buildPushBody,
  describeDeadLetter,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  eventTypeOf,
  parseTopic,
  pushPath,
  schemaVersionOf,
  subscriptionName,
  topicName,
  type DeadLetterReason,
  type EventEnvelope,
  type EventPublisher,
  type RawMessage,
} from '../events/index.js';
import type { FastifyInstance } from '../service-kit/index.js';
import { TEST_PUSH_KEY, pushKeyQuery } from './tokens.js';

/** Input of {@link testEnvelope}; omitted fields take test defaults. */
export interface TestEnvelopeInput<P> {
  /** Full topic name, `<service>.<entity>.<event>.v<major>`. */
  topic: string;
  tenantId: string;
  aggregateId: string;
  /** Defaults to 1. */
  aggregateVersion?: number;
  payload: P;
  /** Defaults to the topic's entity. */
  aggregateType?: string;
  eventId?: string;
  occurredAt?: string;
  traceparent?: string;
  correlationId?: string;
  causationId?: string | null;
  /** Defaults to the topic's service. */
  producer?: string;
}

/** An envelope whose `tenantId` may be absent, as {@link withoutTenant} returns. */
export type TenantlessEnvelope<P = unknown> = Omit<EventEnvelope<P>, 'tenantId'> & { tenantId?: string };

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** A random sampled W3C `traceparent`. */
function randomTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** Builds a contract-valid envelope for `input.topic` without a tenant transaction, unlike `buildEnvelope`. */
export function testEnvelope<P>(input: TestEnvelopeInput<P>): EventEnvelope<P> {
  const { service, entity } = parseTopic(input.topic);
  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: eventTypeOf(input.topic),
    schemaVersion: schemaVersionOf(input.topic),
    tenantId: input.tenantId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: input.producer ?? service,
    aggregateType: input.aggregateType ?? entity,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion ?? 1,
    traceparent: input.traceparent ?? randomTraceparent(),
    correlationId: input.correlationId ?? randomUUID(),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payload: input.payload,
  };
}

/** A copy of `envelope` without `tenantId`. */
export function withoutTenant<P>(envelope: EventEnvelope<P>): Omit<EventEnvelope<P>, 'tenantId'> {
  const { tenantId: _omitted, ...rest } = envelope;
  return rest;
}

/** A copy of `envelope` with `tenantId` set to `tenantId`. */
export function withEnvelopeTenant<P>(envelope: TenantlessEnvelope<P>, tenantId: string): EventEnvelope<P> {
  return { ...envelope, tenantId };
}

/** Alias of {@link withEnvelopeTenant}; prefer the longer name where tenancy's `withTenant` is also imported. */
export const withTenant = withEnvelopeTenant;

/** One envelope per entry of `versions`, sharing `base.aggregateId`, each with a fresh `eventId`; `payloadFor` replaces `base.payload`. */
export function versionedSequence<P>(
  base: EventEnvelope<P>,
  versions: readonly number[],
  payloadFor?: (version: number) => P,
): EventEnvelope<P>[] {
  return versions.map((aggregateVersion) => ({
    ...base,
    eventId: randomUUID(),
    aggregateVersion,
    payload: payloadFor === undefined ? base.payload : payloadFor(aggregateVersion),
  }));
}

/** An envelope the capturing publisher accepted through `publish`. */
export interface PublishedEvent {
  topic: string;
  envelope: EventEnvelope;
}

/** A message the capturing publisher accepted through `publishRaw`. */
export interface PublishedRawMessage {
  topic: string;
  message: RawMessage;
}

/** A dead letter on a subscription's `.dlq` topic, with its `reason` attribute when it names a known reason. */
export interface CapturedDeadLetter extends PublishedRawMessage {
  reason?: DeadLetterReason;
}

/** In-memory {@link EventPublisher} that records every publish instead of reaching Pub/Sub. */
export interface CapturingPublisher extends EventPublisher {
  readonly published: PublishedEvent[];
  readonly raw: PublishedRawMessage[];
  /** Empties `published` and `raw`, keeping the array instances. */
  clear(): void;
  /** Makes the next `n` publishes, through either method, reject with {@link InjectedPublishError} and record nothing. */
  failNext(n?: number): void;
  /** Raw messages published to `dlqTopicName(subscription)`, in publish order. */
  deadLetters(subscription: string): CapturedDeadLetter[];
}

/** Rejection of a publish that {@link CapturingPublisher.failNext} scheduled to fail. */
export class InjectedPublishError extends Error {
  override readonly name = 'InjectedPublishError';
}

/** Creates a {@link CapturingPublisher}; message ids are `"1"`, `"2"`, … across both publish methods. */
export function createCapturingPublisher(): CapturingPublisher {
  const published: PublishedEvent[] = [];
  const raw: PublishedRawMessage[] = [];
  let sequence = 0;
  let failures = 0;

  function admit(topic: string): string {
    if (failures > 0) {
      failures -= 1;
      throw new InjectedPublishError(`Injected publish failure on topic ${topic}`);
    }
    sequence += 1;
    return String(sequence);
  }

  const publisher = {
    published,
    raw,
    async publish(topic: string, envelope: EventEnvelope): Promise<string> {
      const messageId = admit(topic);
      published.push({ topic, envelope });
      return messageId;
    },
    async publishRaw(topic: string, message: RawMessage): Promise<string> {
      const messageId = admit(topic);
      raw.push({ topic, message });
      return messageId;
    },
    close: (): Promise<void> => Promise.resolve(),
    clear(): void {
      published.length = 0;
      raw.length = 0;
    },
    failNext(n = 1): void {
      failures = n;
    },
    deadLetters(subscription: string): CapturedDeadLetter[] {
      const dlqTopic = dlqTopicName(subscription);
      return raw
        .filter((entry) => entry.topic === dlqTopic)
        .map((entry) => {
          const { reason } = describeDeadLetter(entry.message.attributes);
          return reason === undefined ? { ...entry } : { ...entry, reason };
        });
    },
  } satisfies CapturingPublisher;
  return publisher;
}

/** Anything `app.inject` can be called on, such as a Fastify app built by `createService`. */
export interface PushTarget {
  inject: FastifyInstance['inject'];
}

/** What `app.inject(options)` resolves to. */
export type InjectResponse = FastifyInstance['inject'] extends {
  (opts: infer _Options, callback: infer _Callback): void;
  (opts: infer _Options): Promise<infer Response>;
  (): infer _Chain;
}
  ? Response
  : never;

/** Options of {@link pushTo}. */
export interface PushOptions {
  /** Sent only when given, as on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number;
  /** Defaults to a fresh id per delivery. */
  messageId?: string;
  /** Defaults to the envelope's `aggregateId`. */
  orderingKey?: string;
  /** Push key in the endpoint URL; defaults to `TEST_PUSH_KEY`. */
  key?: string;
  /** Merged over the attributes mirrored from the envelope. */
  attributes?: Record<string, string>;
}

/** Project of emulator resources and push bodies. */
function emulatorProject(): string {
  return process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';
}

// envelopeAttributes reads tenantId unchecked; dropping absent values keeps a tenantless envelope encodable for DLQ paths.
function attributesOf(envelope: TenantlessEnvelope): Record<string, string> {
  const attributes: Record<string, string | undefined> = envelopeAttributes(envelope as EventEnvelope);
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** POSTs `envelope` to the subscription's push route as Pub/Sub would, with the local push key in the query; resolves to the inject response. */
export function pushTo(
  app: PushTarget,
  subscription: string,
  envelope: TenantlessEnvelope,
  options: PushOptions = {},
): Promise<InjectResponse> {
  const { deliveryAttempt, messageId = randomUUID(), orderingKey = envelope.aggregateId, key = TEST_PUSH_KEY } = options;
  const payload = buildPushBody({
    data: encodeEnvelope(envelope as EventEnvelope),
    attributes: { ...attributesOf(envelope), ...options.attributes },
    messageId,
    subscription,
    project: emulatorProject(),
    orderingKey,
    publishTime: new Date().toISOString(),
    deliveryAttempt,
  });
  return app.inject({ method: 'POST', url: `${pushPath(subscription)}?${pushKeyQuery(key)}`, payload });
}

/** Delivers `envelope` `times` times in sequence under one `messageId`, with `deliveryAttempt` 1, 2, …. */
export async function deliverDuplicate(
  app: PushTarget,
  subscription: string,
  envelope: TenantlessEnvelope,
  times = 2,
): Promise<InjectResponse[]> {
  const messageId = randomUUID();
  const responses: InjectResponse[] = [];
  for (let deliveryAttempt = 1; deliveryAttempt <= times; deliveryAttempt += 1) {
    responses.push(await pushTo(app, subscription, envelope, { messageId, deliveryAttempt }));
  }
  return responses;
}

/** Delivers `envelopes[i]` for each `i` of `order`, in sequence; responses follow `order`. */
export async function deliverOutOfOrder(
  app: PushTarget,
  subscription: string,
  envelopes: readonly TenantlessEnvelope[],
  order: readonly number[],
): Promise<InjectResponse[]> {
  const responses: InjectResponse[] = [];
  for (const index of order) {
    const envelope = envelopes[index];
    if (envelope === undefined) {
      throw new RangeError(`Delivery order index ${index} is outside the ${envelopes.length} envelopes`);
    }
    responses.push(await pushTo(app, subscription, envelope));
  }
  return responses;
}

/** Whether a push response acks the delivery: any 2xx status; every other status nacks. */
export function isAck(response: { statusCode: number }): boolean {
  return response.statusCode >= 200 && response.statusCode < 300;
}

/** gRPC status of a deleted or never-created resource. */
const GRPC_NOT_FOUND = 5;

/** Resolves true only when `PUBSUB_EMULATOR_HOST` is set and the emulator answers `GET /` within 2 s. */
export async function pubsubEmulatorAvailable(): Promise<boolean> {
  const host = process.env.PUBSUB_EMULATOR_HOST;
  if (!host) return false;
  try {
    const response = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

// Imported lazily so this module adds no static dependency on the Pub/Sub client; a client exists only once an emulator helper runs.
async function emulatorClient(): Promise<PubSub> {
  const apiEndpoint = process.env.PUBSUB_EMULATOR_HOST;
  if (!apiEndpoint) {
    throw new Error('PUBSUB_EMULATOR_HOST is not set: the emulator helpers never reach a real Pub/Sub project');
  }
  const { PubSub: Client } = await import('@google-cloud/pubsub');
  return new Client({ projectId: emulatorProject(), apiEndpoint, emulatorMode: true });
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === GRPC_NOT_FOUND;
}

async function deleteIgnoringMissing(resource: { delete(): Promise<unknown> }): Promise<void> {
  try {
    await resource.delete();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** An emulator topic owned by a test; `delete()` removes it and closes its client, and repeats are no-ops. */
export interface TestTopic {
  /** Short topic name, `<prefix>.run-<hex>.event.v1` for {@link createTestTopic}. */
  name: string;
  /** Client topic with message ordering enabled for publishing. */
  topic: Topic;
  delete(): Promise<void>;
}

async function openTopic(name: string): Promise<TestTopic> {
  const pubsub = await emulatorClient();
  try {
    await pubsub.createTopic(name);
  } catch (error) {
    await pubsub.close();
    throw error;
  }
  const topic = pubsub.topic(name, { messageOrdering: true });
  let deletion: Promise<void> | undefined;
  return {
    name,
    topic,
    delete(): Promise<void> {
      deletion ??= deleteIgnoringMissing(topic).finally(() => pubsub.close());
      return deletion;
    },
  };
}

/**
 * Creates a uniquely named emulator topic in `GOOGLE_CLOUD_PROJECT` (default `opt2-local`); throws when `PUBSUB_EMULATOR_HOST` is unset.
 * The random part sits in the entity segment, `<prefix>.run-<8 hex>.event.v1`, because subscription, push-path and DLQ names
 * accept only `<service>.<entity>.<event>.v<major>` topics; `prefix` must be a valid name segment.
 */
export async function createTestTopic(prefix = 'opt2-test'): Promise<TestTopic> {
  return openTopic(topicName(prefix, `run-${randomHex(4)}`, 'event', 1));
}

/** Options of {@link createTestSubscription}. */
export interface TestSubscriptionOptions {
  /** Consumer segment of the name, before its random suffix; defaults to `opt2-test`. */
  consumer?: string;
  /** Plain-HTTP push endpoint; without it the subscription is pull-only. */
  pushEndpoint?: string;
  /** Creates the `.dlq` topic and forwards there after `maxDeliveryAttempts` (5 to 100 in Pub/Sub). */
  deadLetter?: { maxDeliveryAttempts: number };
  ackDeadlineSeconds?: number;
}

/** A message received by {@link TestSubscription.pull}. */
export interface PulledMessage {
  data: Buffer;
  attributes: Record<string, string>;
  /** Absent when the message was published without one. */
  orderingKey?: string;
}

/** An ordered emulator subscription owned by a test; `delete()` also deletes its DLQ topic, and repeats are no-ops. */
export interface TestSubscription {
  /** `<consumer>-<8 hex>.<topic>`, a valid push subscription name. */
  name: string;
  subscription: Subscription;
  dlqTopic?: TestTopic;
  /** Receives up to `max` messages within `timeoutMs`, acking each; messages beyond `max` are nacked. */
  pull(max?: number, timeoutMs?: number): Promise<PulledMessage[]>;
  delete(): Promise<void>;
}

/** Creates an ordered subscription on `topic` with optional push delivery and dead-letter policy; throws when `PUBSUB_EMULATOR_HOST` is unset. */
export async function createTestSubscription(
  topic: Pick<TestTopic, 'name'>,
  options: TestSubscriptionOptions = {},
): Promise<TestSubscription> {
  const { consumer = 'opt2-test', pushEndpoint, deadLetter, ackDeadlineSeconds } = options;
  // A suffix after `.v<major>` would break pushPath and dlqTopicName, so uniqueness goes into the consumer segment.
  const name = subscriptionName(`${consumer}-${randomHex(4)}`, topic.name);
  const pubsub = await emulatorClient();
  let dlqTopic: TestTopic | undefined;
  let subscription: Subscription;
  try {
    dlqTopic = deadLetter === undefined ? undefined : await openTopic(dlqTopicName(name));
    [subscription] = await pubsub.topic(topic.name).createSubscription(name, {
      enableMessageOrdering: true,
      ...(pushEndpoint === undefined ? {} : { pushConfig: { pushEndpoint } }),
      ...(dlqTopic === undefined || deadLetter === undefined
        ? {}
        : {
            deadLetterPolicy: {
              deadLetterTopic: dlqTopic.topic.name,
              maxDeliveryAttempts: deadLetter.maxDeliveryAttempts,
            },
          }),
      ...(ackDeadlineSeconds === undefined ? {} : { ackDeadlineSeconds }),
    });
  } catch (error) {
    await dlqTopic?.delete();
    await pubsub.close();
    throw error;
  }

  async function pull(max = 10, timeoutMs = 5_000): Promise<PulledMessage[]> {
    const receiver = pubsub.subscription(name, {
      flowControl: { maxMessages: max, allowExcessMessages: false },
      closeOptions: { behavior: 'NACK' },
    });
    const received: PulledMessage[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, timeoutMs);
        receiver.on('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        receiver.on('message', (message: Message) => {
          if (received.length >= max) {
            message.nack();
            return;
          }
          received.push({
            data: message.data,
            attributes: { ...message.attributes },
            ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
          });
          message.ack();
          if (received.length >= max) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } finally {
      receiver.removeAllListeners();
      await receiver.close();
    }
    return received;
  }

  let deletion: Promise<void> | undefined;
  return {
    name,
    subscription,
    ...(dlqTopic === undefined ? {} : { dlqTopic }),
    pull,
    delete(): Promise<void> {
      deletion ??= (async () => {
        try {
          await subscription.close();
          await deleteIgnoringMissing(subscription);
          await dlqTopic?.delete();
        } finally {
          await pubsub.close();
        }
      })();
      return deletion;
    },
  };
}

/** Publishes `envelope` to an emulator topic as the platform publisher would: envelope JSON, mirrored attributes, ordered by `aggregateId`. */
export async function publishToEmulator(topic: string, envelope: TenantlessEnvelope): Promise<string> {
  const pubsub = await emulatorClient();
  try {
    return await pubsub.topic(topic, { messageOrdering: true }).publishMessage({
      data: encodeEnvelope(envelope as EventEnvelope),
      attributes: attributesOf(envelope),
      orderingKey: envelope.aggregateId,
    });
  } finally {
    await pubsub.close();
  }
}
