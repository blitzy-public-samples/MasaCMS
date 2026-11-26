/** People's event contract files and the Pub/Sub wire-form assertion shared by the contract and event suites. */
import { expect } from 'vitest';
import {
  ENVELOPE_ATTRIBUTE_KEYS,
  createPublisher,
  decodeEnvelopeData,
  envelopeAttributes,
  readTopicSchema,
  type EventEnvelope,
  type PublisherOptions,
  type RawMessage,
} from '@opt2/platform/events';
import { PERSON_ARCHIVED_TOPIC, PERSON_CHANGED_TOPIC, peoplePayloadValidators, type PeopleTopic } from '../../src/events/topics.js';

export type Schema = Record<string, unknown>;

export const CHANGED: Schema = readTopicSchema(new URL('../../contracts/events/people.person.changed.v1.json', import.meta.url));
export const ARCHIVED: Schema = readTopicSchema(new URL('../../contracts/events/people.person.archived.v1.json', import.meta.url));
export const SCHEMAS: Readonly<Record<PeopleTopic, Schema>> = { [PERSON_CHANGED_TOPIC]: CHANGED, [PERSON_ARCHIVED_TOPIC]: ARCHIVED };

// The capturing publisher keeps outbox publishes as envelopes only, so the Pub/Sub message is taken from the platform publisher.
/** Publishes `envelope` through the platform publisher with people's payload validators and returns the message handed to Pub/Sub. */
async function wireMessage(topic: string, envelope: EventEnvelope): Promise<RawMessage> {
  const sent: RawMessage[] = [];
  const client = {
    topic: () => ({
      publishMessage: (message: RawMessage) => Promise.resolve(String(sent.push(message))),
      resumePublishing: () => undefined,
      flush: () => Promise.resolve(),
    }),
    close: () => Promise.resolve(),
  };
  const publisher = createPublisher({
    projectId: 'opt2-people-contract',
    pubsub: client as unknown as NonNullable<PublisherOptions['pubsub']>,
    payloadValidators: new Map(Object.entries(peoplePayloadValidators)),
  });
  await publisher.publish(topic, envelope);
  await publisher.close();
  const [message, ...rest] = sent;
  expect(rest).toEqual([]);
  if (message === undefined) throw new Error(`Nothing was published for ${topic}`);
  return message;
}

/** Asserts the Pub/Sub form of `envelope`: mirrored attributes, ordering by aggregate and the envelope as data. */
export async function expectWireForm(topic: string, envelope: EventEnvelope): Promise<void> {
  const attributes = envelopeAttributes(envelope);
  expect(Object.keys(attributes).sort()).toEqual([...ENVELOPE_ATTRIBUTE_KEYS].sort());
  expect(attributes).toStrictEqual({
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    tenantId: envelope.tenantId,
    aggregateVersion: String(envelope.aggregateVersion),
    traceparent: envelope.traceparent,
  });
  const message = await wireMessage(topic, envelope);
  expect(message.attributes).toStrictEqual(attributes);
  expect(message.orderingKey).toBe(envelope.aggregateId);
  expect(decodeEnvelopeData(message.data)).toStrictEqual(envelope);
}
