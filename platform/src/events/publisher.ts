/** Pub/Sub publisher for event envelopes: ordered topics keyed by `aggregateId`, each publish in an `outbox.publish` producer span. */
import { PubSub, type Topic } from '@google-cloud/pubsub';
import { SpanKind, startSpan, withExtractedContext } from '../tracing/index.js';
import { encodeEnvelope, envelopeAttributes, type EventEnvelope } from './envelope.js';
import { eventTypeOf, isTopicName, schemaVersionOf } from './naming.js';
import { validateEnvelope, type TopicValidator } from './validation.js';

/** Options of {@link createPublisher}; `pubsub` replaces the client, for example with a test fake. */
export interface PublisherOptions {
  projectId: string;
  /** `host:port` of a Pub/Sub emulator, reached over plaintext without credentials; when omitted the client honours `PUBSUB_EMULATOR_HOST`. */
  emulatorHost?: string;
  pubsub?: PubSub;
  /** Payload validators by topic name; topics without one are checked against the envelope contract only. */
  payloadValidators?: ReadonlyMap<string, TopicValidator>;
}

/** A message exactly as handed to Pub/Sub. */
export interface RawMessage {
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey?: string;
}

/** Publishes to Pub/Sub; every publish resolves to the Pub/Sub message id. */
export interface EventPublisher {
  /** Checks `envelope` against the envelope contract, the topic name and the topic's payload validator, then publishes it ordered by `aggregateId`. */
  publish(topic: string, envelope: EventEnvelope): Promise<string>;
  /** Publishes `message` unchanged, without envelope checks. */
  publishRaw(topic: string, message: RawMessage): Promise<string>;
  /** Flushes every topic used so far, then closes the client. */
  close(): Promise<void>;
}

/** Raised before anything is published when an envelope is rejected; `errors` are `"<instancePath> <message>"` strings. */
export class EnvelopePublishError extends Error {
  override readonly name = 'EnvelopePublishError';
  readonly errors: string[];

  constructor(topic: string, errors: string[]) {
    super(`Envelope rejected for topic ${JSON.stringify(topic)}: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

// Payload errors are relative to the payload; rebasing them under /payload keeps one path space with the envelope errors.
function payloadError(error: string): string {
  return error.startsWith('/ ') ? `/payload${error.slice(1)}` : `/payload${error}`;
}

function rejections(topic: string, envelope: EventEnvelope, validator: TopicValidator | undefined): string[] {
  const checked = validateEnvelope(envelope);
  if (!checked.ok) return checked.errors;
  if (!isTopicName(topic)) return [`topic ${JSON.stringify(topic)} is not <service>.<entity>.<event>.v<major>`];
  const errors: string[] = [];
  const eventType = eventTypeOf(topic);
  const schemaVersion = schemaVersionOf(topic);
  if (envelope.eventType !== eventType) errors.push(`/eventType must be ${eventType} on topic ${topic}`);
  if (envelope.schemaVersion !== schemaVersion) errors.push(`/schemaVersion must be ${schemaVersion} on topic ${topic}`);
  const payload = validator?.validatePayload(envelope.payload);
  if (payload !== undefined && !payload.ok) errors.push(...payload.errors.map(payloadError));
  return errors;
}

/** Creates an {@link EventPublisher}; retries are left to the client library, the outbox sweep and Pub/Sub redelivery. */
export function createPublisher(options: PublisherOptions): EventPublisher {
  const { projectId, emulatorHost, payloadValidators } = options;
  const pubsub =
    options.pubsub ??
    new PubSub(emulatorHost === undefined ? { projectId } : { projectId, apiEndpoint: emulatorHost, emulatorMode: true });
  const topics = new Map<string, Topic>();

  function topicFor(name: string): Topic {
    let topic = topics.get(name);
    if (topic === undefined) {
      topic = pubsub.topic(name, { messageOrdering: true });
      topics.set(name, topic);
    }
    return topic;
  }

  async function publishRaw(name: string, message: RawMessage): Promise<string> {
    const topic = topicFor(name);
    const { data, attributes, orderingKey } = message;
    try {
      return await topic.publishMessage(orderingKey ? { data, attributes, orderingKey } : { data, attributes });
    } catch (error) {
      // The client pauses an ordering key after a failed publish; resuming lets the next attempt for that key proceed.
      if (orderingKey) topic.resumePublishing(orderingKey);
      throw error;
    }
  }

  async function publish(name: string, envelope: EventEnvelope): Promise<string> {
    const errors = rejections(name, envelope, payloadValidators?.get(name));
    if (errors.length > 0) throw new EnvelopePublishError(name, errors);
    const message: RawMessage = {
      data: encodeEnvelope(envelope),
      attributes: envelopeAttributes(envelope),
      orderingKey: envelope.aggregateId,
    };
    // The span joins the envelope's trace, so a sweep long after the request still publishes within the producer's trace.
    return withExtractedContext({ traceparent: envelope.traceparent, tracestate: envelope.tracestate }, () =>
      startSpan(
        'outbox.publish',
        SpanKind.PRODUCER,
        async (span) => {
          const messageId = await publishRaw(name, message);
          span.setAttribute('messaging.message.id', messageId);
          return messageId;
        },
        { 'messaging.system': 'gcp_pubsub', 'messaging.destination.name': name },
      ),
    );
  }

  async function close(): Promise<void> {
    const pending = [...topics.values()];
    topics.clear();
    try {
      await Promise.all(pending.map((topic) => topic.flush()));
    } finally {
      await pubsub.close();
    }
  }

  return { publish, publishRaw, close };
}
