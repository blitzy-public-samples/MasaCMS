import { randomUUID } from 'node:crypto';
import { PubSub, type PublishOptions, type Topic } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENVELOPE_ATTRIBUTE_KEYS,
  EnvelopePublishError,
  compileTopicSchema,
  createPublisher,
  decodeEnvelopeData,
  envelopeAttributes,
  eventTypeOf,
  eventsSql,
  isTopicName,
  subscriptionName,
  topicName,
  type EventEnvelope,
  type EventPublisher,
  type PublisherOptions,
} from '../../src/events/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { rlsSql, tenantRegistrySql } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  pgAvailable,
  pubsubEmulatorAvailable,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  type PulledMessage,
  type TestSubscription,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

interface Payload {
  value: string;
}

type MessageOptions = Parameters<Topic['publishMessage']>[0];

// Same default as the testing helpers, so the publisher reaches the topics they create.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';
const EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST;
const RECEIVE_MS = 10_000;
const GRPC_NOT_FOUND = 5;
const PG_VARIABLES = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const VERSIONS = Array.from({ length: 10 }, (_, index) => index + 1);
const RUN = randomUUID().slice(0, 8);

const PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'string' } },
  additionalProperties: false,
  'x-opt2-kind': 'state',
};

const TEST_AGGREGATE_SQL = [
  'CREATE TABLE stub.test_aggregate (',
  '  tenant_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL,',
  '  version integer NOT NULL,',
  '  value text NOT NULL,',
  '  PRIMARY KEY (tenant_id, aggregate_id)',
  ');',
].join('\n');

describe('event publisher against the Pub/Sub emulator', () => {
  let handle: ThrowawaySchema | undefined;
  let admin: PubSub | undefined;
  let publisher: EventPublisher;
  const publishers: EventPublisher[] = [];
  const owned: Array<{ delete(): Promise<void> }> = [];

  /** Registers `resource` for deletion in afterAll, latest first, and returns it. */
  function own<T extends { delete(): Promise<void> }>(resource: T): T {
    owned.push(resource);
    return resource;
  }

  /** Creates a publisher on the emulator project, closed in afterAll. */
  function openPublisher(options: Pick<PublisherOptions, 'pubsub' | 'payloadValidators'> = {}): EventPublisher {
    const created = createPublisher({
      projectId: PROJECT,
      ...(EMULATOR_HOST === undefined ? {} : { emulatorHost: EMULATOR_HOST }),
      ...options,
    });
    publishers.push(created);
    return created;
  }

  // The real client discards an ordered queue, and with it the paused state, once a lone failed publish drains,
  // so only a client that keeps the pause can show that the publisher resumes the key.
  /** An emulator client on which a key whose publish failed stays paused until `resumePublishing(key)`; `resumed` lists resumed keys. */
  function pausingClient(): { client: PubSub; resumed: string[] } {
    const real = new PubSub({ projectId: PROJECT, apiEndpoint: EMULATOR_HOST, emulatorMode: true });
    const paused = new Set<string>();
    const resumed: string[] = [];
    const client = {
      topic(name: string, options?: PublishOptions) {
        const topic = real.topic(name, options);
        return {
          async publishMessage(message: MessageOptions): Promise<string> {
            const key = message.orderingKey ?? '';
            if (paused.has(key)) throw new Error(`Ordering key ${key} is paused`);
            try {
              return await topic.publishMessage(message);
            } catch (error) {
              if (key !== '') paused.add(key);
              throw error;
            }
          },
          resumePublishing(key: string): void {
            resumed.push(key);
            paused.delete(key);
            topic.resumePublishing(key);
          },
          flush: () => topic.flush(),
        };
      },
      close: () => real.close(),
    };
    return { client: client as unknown as PubSub, resumed };
  }

  /** A fresh conforming topic with one ordered pull subscription. */
  async function orderedChannel(): Promise<{ topic: TestTopic; subscription: TestSubscription }> {
    const topic = own(await createTestTopic('stub'));
    expect(isTopicName(topic.name)).toBe(true);
    const subscription = own(await createTestSubscription(topic, { consumer: 'stub' }));
    const [consumer = ''] = subscription.name.split('.', 1);
    expect(subscriptionName(consumer, topic.name)).toBe(subscription.name);
    return { topic, subscription };
  }

  /** Receives exactly `count` messages within RECEIVE_MS, failing when fewer arrive. */
  async function receive(subscription: TestSubscription, count: number): Promise<PulledMessage[]> {
    const messages = await subscription.pull(count, RECEIVE_MS);
    expect(messages).toHaveLength(count);
    return messages;
  }

  /** Commits `envelope`'s aggregate version and value to `test_aggregate` in the envelope's tenant. */
  async function commitVersion(envelope: EventEnvelope<Payload>): Promise<void> {
    const db = requireHandle();
    await db.app.withTenant(envelope.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${db.schema}.test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, aggregate_id) DO UPDATE SET version = EXCLUDED.version, value = EXCLUDED.value`,
        [envelope.tenantId, envelope.aggregateId, envelope.aggregateVersion, envelope.payload.value],
      ),
    );
  }

  /** Stored `test_aggregate` versions visible in `tenantId`, by aggregate id. */
  async function storedVersions(tenantId: string): Promise<Record<string, number>> {
    const db = requireHandle();
    const { rows } = await db.app.withTenant(tenantId, (tx) =>
      tx.query<{ aggregate_id: string; version: number }>(
        `SELECT aggregate_id, version FROM ${db.schema}.test_aggregate ORDER BY aggregate_id`,
      ),
    );
    return Object.fromEntries(rows.map((row) => [row.aggregate_id, row.version]));
  }

  function requireHandle(): ThrowawaySchema {
    if (handle === undefined) throw new Error('The throwaway schema was not created');
    return handle;
  }

  beforeAll(async () => {
    const missing = PG_VARIABLES.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`The publisher ordering suite needs ${missing.join(', ')} in the environment`);
    }
    if (!(await pgAvailable())) {
      throw new Error(`The publisher ordering suite cannot reach PostgreSQL at PG_HOST:PG_PORT (${process.env.PG_HOST}:${process.env.PG_PORT})`);
    }
    if (!(await pubsubEmulatorAvailable())) {
      throw new Error(`The publisher ordering suite needs a Pub/Sub emulator at PUBSUB_EMULATOR_HOST (${EMULATOR_HOST ?? 'unset'})`);
    }
    handle = await createThrowawaySchema({
      service: 'stub',
      extraSql: [
        outboxSql('stub'),
        eventsSql('stub'),
        tenantRegistrySql('stub'),
        migrationKitSql('stub'),
        scheduledTaskQueueSql('stub'),
        TEST_AGGREGATE_SQL,
        rlsSql('stub', 'test_aggregate'),
      ],
    });
    await seedRegistry(handle.app, handle.schema);
    admin = new PubSub({ projectId: PROJECT, apiEndpoint: EMULATOR_HOST, emulatorMode: true });
    publisher = openPublisher();
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const created of publishers.splice(0)) await attempt(() => created.close());
    for (const resource of owned.splice(0).reverse()) await attempt(() => resource.delete());
    await attempt(() => admin?.close());
    await attempt(() => handle?.drop());
    if (failures.length > 0) throw new AggregateError(failures, 'Publisher ordering suite cleanup failed');
  });

  it('publishes the envelope as data, ordered by aggregateId, with its six mirrored attributes', async () => {
    const { topic, subscription } = await orderedChannel();
    const envelope = testEnvelope<Payload>({
      topic: topic.name,
      tenantId: TENANT_A.tenantId,
      aggregateId: `note-${RUN}`,
      aggregateVersion: 1,
      payload: { value: 'first' },
    });

    const messageId = await publisher.publish(topic.name, envelope);
    const [message] = (await receive(subscription, 1)) as [PulledMessage];

    expect(messageId).toMatch(/\S/);
    expect(message.orderingKey).toBe(envelope.aggregateId);
    expect(message.attributes).toStrictEqual(
      Object.fromEntries(ENVELOPE_ATTRIBUTE_KEYS.map((key) => [key, String(envelope[key])])),
    );
    expect(message.attributes).toStrictEqual(envelopeAttributes(envelope));
    expect(decodeEnvelopeData(message.data)).toStrictEqual(envelope);
  });

  it('delivers the versions of each aggregate in publish order when two aggregates interleave', async () => {
    const { topic, subscription } = await orderedChannel();
    const sequenceFor = (tenantId: string, aggregateId: string): EventEnvelope<Payload>[] =>
      versionedSequence(
        testEnvelope<Payload>({ topic: topic.name, tenantId, aggregateId, payload: { value: '' } }),
        VERSIONS,
        (version) => ({ value: `${aggregateId}@${version}` }),
      );
    const x = sequenceFor(TENANT_A.tenantId, `note-x-${RUN}`);
    const y = sequenceFor(TENANT_B.tenantId, `note-y-${RUN}`);
    const interleaved = x.flatMap((envelope, index) => [envelope, ...y.slice(index, index + 1)]);

    const messageIds: string[] = [];
    for (const envelope of interleaved) {
      await commitVersion(envelope);
      messageIds.push(await publisher.publish(topic.name, envelope));
    }
    const received = (await receive(subscription, interleaved.length)).map((message) => ({
      orderingKey: message.orderingKey,
      tenantId: message.attributes.tenantId,
      envelope: decodeEnvelopeData(message.data) as EventEnvelope<Payload>,
    }));
    const deliveredFor = (sequence: EventEnvelope<Payload>[]) =>
      received
        .filter((entry) => entry.orderingKey === sequence[0]?.aggregateId)
        .map((entry) => ({ tenantId: entry.tenantId, eventId: entry.envelope.eventId, version: entry.envelope.aggregateVersion }));

    expect(new Set(messageIds).size).toBe(interleaved.length);
    for (const sequence of [x, y]) {
      expect(deliveredFor(sequence)).toStrictEqual(
        sequence.map((envelope) => ({ tenantId: envelope.tenantId, eventId: envelope.eventId, version: envelope.aggregateVersion })),
      );
    }
    await expect(storedVersions(TENANT_A.tenantId)).resolves.toStrictEqual({ [`note-x-${RUN}`]: VERSIONS.length });
    await expect(storedVersions(TENANT_B.tenantId)).resolves.toStrictEqual({ [`note-y-${RUN}`]: VERSIONS.length });
  });

  it('resumes an ordering key whose publish failed, so the next publish on that key is delivered', async () => {
    const pubsub = admin as PubSub;
    const gone = await createTestTopic('stub');
    await gone.delete();
    const name = gone.name;
    const key = `note-k-${RUN}`;
    const onKey = (aggregateVersion: number): EventEnvelope<Payload> =>
      testEnvelope<Payload>({
        topic: name,
        tenantId: TENANT_A.tenantId,
        aggregateId: key,
        aggregateVersion,
        payload: { value: `attempt-${aggregateVersion}` },
      });
    const { client, resumed } = pausingClient();
    const resuming = openPublisher({ pubsub: client });

    await expect(resuming.publish(name, onKey(1))).rejects.toMatchObject({ code: GRPC_NOT_FOUND });
    expect(resumed).toStrictEqual([key]);

    await pubsub.createTopic(name);
    own({
      delete: async () => {
        await pubsub.topic(name).delete();
      },
    });
    const subscription = own(await createTestSubscription({ name }, { consumer: 'stub' }));
    const retried = onKey(2);

    await expect(resuming.publish(name, retried)).resolves.toMatch(/\S/);
    const [message] = (await receive(subscription, 1)) as [PulledMessage];
    expect(message.orderingKey).toBe(retried.aggregateId);
    expect(decodeEnvelopeData(message.data)).toStrictEqual(retried);
  });

  it.each([
    {
      rejection: 'a payload its topic schema rejects',
      envelope: (topic: string, aggregateId: string) =>
        testEnvelope({ topic, tenantId: TENANT_A.tenantId, aggregateId, payload: {} }),
      errors: () => ["/payload must have required property 'value'"],
    },
    {
      rejection: 'an eventType that does not match the topic',
      envelope: (_topic: string, aggregateId: string) =>
        testEnvelope<Payload>({
          topic: topicName('stub', `other-${RUN}`, 'event', 1),
          tenantId: TENANT_A.tenantId,
          aggregateId,
          payload: { value: 'misrouted' },
        }),
      errors: (topic: string) => [`/eventType must be ${eventTypeOf(topic)} on topic ${topic}`],
    },
  ])('rejects $rejection before publishing, so the next envelope on its key is the first delivered', async (row) => {
    const { topic, subscription } = await orderedChannel();
    const validating = openPublisher({ payloadValidators: new Map([[topic.name, compileTopicSchema(PAYLOAD_SCHEMA)]]) });
    const aggregateId = `note-r-${RUN}`;
    const sentinel = testEnvelope<Payload>({
      topic: topic.name,
      tenantId: TENANT_A.tenantId,
      aggregateId,
      aggregateVersion: 2,
      payload: { value: 'sentinel' },
    });

    const rejected = await validating.publish(topic.name, row.envelope(topic.name, aggregateId)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(EnvelopePublishError);
    expect((rejected as EnvelopePublishError).errors).toStrictEqual(row.errors(topic.name));

    await validating.publish(topic.name, sentinel);
    const [message] = (await receive(subscription, 1)) as [PulledMessage];
    expect(decodeEnvelopeData(message.data)).toStrictEqual(sentinel);
  });
});

