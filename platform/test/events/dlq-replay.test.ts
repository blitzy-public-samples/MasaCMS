// Dead-letter classification of the push route, `publishDeadLetter` and `opt2-events replay` against PostgreSQL and the Pub/Sub emulator.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayDeadLetters } from '../../src/events/cli.js';
import {
  DEAD_LETTER_REASONS,
  DEAD_LETTER_REASON_ATTRIBUTE,
  DEAD_LETTER_SOURCE_DELIVERY_COUNT_ATTRIBUTE,
  DEAD_LETTER_SOURCE_SUBSCRIPTION_ATTRIBUTE,
  createPublisher,
  decodeEnvelopeData,
  dlqReplaySubscriptionName,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  eventsSql,
  originalAttributes,
  publishDeadLetter,
  registerPushSubscription,
  subscriptionName,
  topicOfSubscription,
  type ConsumerDefinition,
  type DeadLetterReason,
  type EventEnvelope,
  type EventPublisher,
} from '../../src/events/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { rlsSql, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  isAck,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  withoutTenant,
  type TenantlessEnvelope,
  type TestSubscription,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
// Same default as the testing helpers, so topics they create and messages published here share one emulator project.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';
const REQUIRED_VARIABLES = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE', 'PUBSUB_EMULATOR_HOST'] as const;
const SETTLE_MS = 500;
const REPLAY = { max: 100, idleSeconds: 2 } as const;

interface NotePayload {
  value: string;
}

const PAYLOAD_SCHEMA = {
  'x-opt2-kind': 'process',
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: { type: 'string' } },
};

const TEST_TABLES_SQL = [
  'CREATE TABLE stub.test_aggregate (',
  '  tenant_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL,',
  '  version integer NOT NULL,',
  '  value text NOT NULL,',
  '  PRIMARY KEY (tenant_id, aggregate_id)',
  ');',
  rlsSql(SERVICE, 'test_aggregate'),
  'CREATE TABLE stub.test_effect (',
  '  tenant_id uuid NOT NULL,',
  '  event_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL',
  ');',
  rlsSql(SERVICE, 'test_effect'),
].join('\n');

/** A message as a subscription received it. */
interface Received {
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey?: string;
}

let handle: ThrowawaySchema;
let pubsub: PubSub;
let publisher: EventPublisher;
let app: FastifyInstance;
let topic: TestTopic;
let topicObserver: TestSubscription;
let subscription: string;
let dlqTopic: string;
let dlqObserver: string;
let failApply = false;
let mismatchEventId: string;
const cleanups: Array<() => Promise<unknown>> = [];
const deadLetters: Received[] = [];
const replayedCopies: Received[] = [];

/** Receives from `name` until `count` messages arrived and SETTLE_MS passed without another, or `deadlineMs` elapsed; acks each. */
async function pullUntil(name: string, count: number, deadlineMs = 10_000): Promise<Received[]> {
  const receiver = pubsub.subscription(name, { flowControl: { maxMessages: 100, allowExcessMessages: false } });
  const received: Received[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let settle: NodeJS.Timeout | undefined;
      const deadline = setTimeout(resolve, deadlineMs);
      const done = (err?: Error): void => {
        clearTimeout(deadline);
        clearTimeout(settle);
        if (err === undefined) resolve();
        else reject(err);
      };
      receiver.on('error', done);
      receiver.on('message', (message: Message) => {
        received.push({
          data: Buffer.from(message.data),
          attributes: { ...message.attributes },
          ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
        });
        message.ack();
        if (received.length >= count) {
          clearTimeout(settle);
          settle = setTimeout(() => done(), SETTLE_MS);
        }
      });
    });
  } finally {
    receiver.removeAllListeners();
    await receiver.close();
  }
  return received;
}

/** A contract-valid envelope on the test topic for `aggregateId`. */
function envelopeFor(aggregateId: string, tenantId = TENANT_A.tenantId, payload: unknown = { value: aggregateId }): EventEnvelope {
  return testEnvelope({ topic: topic.name, tenantId, aggregateId, payload });
}

/** The attributes pushTo mirrors from `envelope`, without absent ones. */
function sentAttributes(envelope: TenantlessEnvelope): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envelopeAttributes(envelope as EventEnvelope)).filter(([, value]) => value !== undefined),
  );
}

/** Stores aggregate `aggregateId` under `tenantId`. */
function storeAggregate(tenantId: string, aggregateId: string): Promise<unknown> {
  return withTenant(handle.app, tenantId, (tx) =>
    tx.query(
      `INSERT INTO ${handle.schema}.test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, 1, $2)`,
      [tenantId, aggregateId],
    ),
  );
}

/** Rows of `table` visible under `tenantId` whose `event_id` is one of `eventIds`. */
function rowsFor(table: 'test_effect' | 'inbox', tenantId: string, eventIds: readonly string[]): Promise<number> {
  return withTenant(handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${handle.schema}.${table} WHERE event_id = ANY($1::uuid[])`,
      [eventIds],
    );
    return rows[0]?.n ?? 0;
  });
}

/** The process consumer of the test topic: the aggregate must exist under the envelope tenant, and the effect is one row. */
function noteConsumer(topicName: string): ConsumerDefinition<NotePayload> {
  return {
    topic: topicName,
    kind: 'process',
    async checkTenant(tx, envelope) {
      const { rowCount } = await tx.query(`SELECT 1 FROM ${handle.schema}.test_aggregate WHERE aggregate_id = $1`, [
        envelope.aggregateId,
      ]);
      return rowCount === 1;
    },
    async apply(tx, envelope) {
      if (failApply) throw new Error('effect store unavailable');
      await tx.query(`INSERT INTO ${handle.schema}.test_effect (tenant_id, event_id, aggregate_id) VALUES ($1, $2, $3)`, [
        tx.tenantId,
        envelope.eventId,
        envelope.aggregateId,
      ]);
    },
  };
}

beforeAll(async () => {
  const missing = REQUIRED_VARIABLES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`The DLQ replay suite needs ${missing.join(', ')} in the environment`);
  }
  if (!(await pgAvailable())) {
    throw new Error(`PostgreSQL at PG_HOST=${process.env.PG_HOST} PG_PORT=${process.env.PG_PORT ?? '5432'} is unreachable`);
  }
  if (!(await pubsubEmulatorAvailable())) {
    throw new Error(`The Pub/Sub emulator at PUBSUB_EMULATOR_HOST=${process.env.PUBSUB_EMULATOR_HOST} is unreachable`);
  }

  handle = await createThrowawaySchema({
    service: SERVICE,
    extraSql: [
      outboxSql(SERVICE),
      eventsSql(SERVICE),
      tenantRegistrySql(SERVICE),
      migrationKitSql(SERVICE),
      scheduledTaskQueueSql(SERVICE),
      TEST_TABLES_SQL,
    ],
  });
  cleanups.push(() => handle.drop());
  await seedRegistry(handle.app, handle.schema);

  pubsub = new PubSub({ projectId: PROJECT, apiEndpoint: process.env.PUBSUB_EMULATOR_HOST, emulatorMode: true });
  cleanups.push(() => pubsub.close());
  topic = await createTestTopic(SERVICE);
  cleanups.push(() => topic.delete());
  subscription = subscriptionName(SERVICE, topic.name);
  dlqTopic = dlqTopicName(subscription);
  dlqObserver = `${dlqTopic}.observer`;
  const [deadLetterTopic] = await pubsub.createTopic(dlqTopic);
  cleanups.push(() => deadLetterTopic.delete());
  for (const name of [dlqReplaySubscriptionName(subscription), dlqObserver]) {
    const [created] = await deadLetterTopic.createSubscription(name, { enableMessageOrdering: true });
    cleanups.push(() => created.delete());
  }
  topicObserver = await createTestSubscription(topic, { consumer: 'observer' });
  cleanups.push(() => topicObserver.delete());

  publisher = createPublisher({ projectId: PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST });
  cleanups.push(() => publisher.close());
  app = await createService({
    name: SERVICE,
    version: 'test',
    env: loadEnv(undefined, {
      PORT: '8199',
      OPT2_SERVICE_NAME: SERVICE,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-dlq-replay-unused'),
      TZ: 'UTC',
    }),
    // A callee-bound verifier sets every key-backed piece, so no secret file is read from OPT2_STATE_DIR.
    verifierOverride: testVerifier(SERVICE),
  });
  cleanups.push(() => app.opt2.shutdown());
  registerPushSubscription(app, {
    subscription,
    topic: topic.name,
    consumer: noteConsumer(topic.name),
    payloadSchema: PAYLOAD_SCHEMA,
    publisher,
    db: handle.app,
  });
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'DLQ replay suite cleanup failed');
});

describe('dead letters and opt2-events replay against the Pub/Sub emulator', () => {
  it('dead-letters each tenant and schema failure with its reason and acks', async () => {
    await storeAggregate(TENANT_B.tenantId, 'agg-foreign');
    const mismatch = envelopeFor('agg-foreign');
    mismatchEventId = mismatch.eventId;
    const cases: Array<[DeadLetterReason, TenantlessEnvelope]> = [
      ['missing-tenant', withoutTenant(envelopeFor('agg-missing'))],
      ['invalid-tenant', { ...envelopeFor('agg-invalid'), tenantId: TENANT_A.siteId }],
      ['schema-invalid', envelopeFor('agg-schema', TENANT_A.tenantId, { value: 'x', unexpected: true })],
      ['tenant-mismatch', mismatch],
    ];
    for (const [, envelope] of cases) {
      expect((await pushTo(app, subscription, envelope)).statusCode).toBe(204);
    }

    const letters = await pullUntil(dlqObserver, cases.length);
    expect(letters).toHaveLength(cases.length);
    for (const [reason, envelope] of cases) {
      const letter = letters.find((candidate) => candidate.attributes.eventId === envelope.eventId);
      expect(letter?.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe(reason);
      expect(letter?.data).toEqual(encodeEnvelope(envelope as EventEnvelope));
      expect(originalAttributes(letter?.attributes ?? {})).toEqual(sentAttributes(envelope));
      expect(letter?.orderingKey).toBe(envelope.aggregateId);
    }
    expect(letters.map((letter) => letter.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).sort()).toEqual(
      [...DEAD_LETTER_REASONS].sort(),
    );

    const eventIds = cases.map(([, envelope]) => envelope.eventId);
    const stored = await Promise.all(
      [TENANT_A, TENANT_B].flatMap((tenant) =>
        (['test_effect', 'inbox'] as const).map((table) => rowsFor(table, tenant.tenantId, eventIds)),
      ),
    );
    expect(stored).toEqual([0, 0, 0, 0]);
    deadLetters.push(...letters);
  });

  it('nacks a processing error without dead-lettering', async () => {
    await storeAggregate(TENANT_A.tenantId, 'agg-ok');
    const failing = envelopeFor('agg-ok');
    failApply = true;
    const response = await pushTo(app, subscription, failing).finally(() => {
      failApply = false;
    });
    expect(isAck(response)).toBe(false);
    expect([
      await rowsFor('test_effect', TENANT_A.tenantId, [failing.eventId]),
      await rowsFor('inbox', TENANT_A.tenantId, [failing.eventId]),
    ]).toEqual([0, 0]);

    const sentinel = withoutTenant(envelopeFor('agg-sentinel'));
    expect((await pushTo(app, subscription, sentinel)).statusCode).toBe(204);
    const letters = await pullUntil(dlqObserver, 1);
    expect(letters.map((letter) => letter.attributes.eventId)).toEqual([sentinel.eventId]);
    deadLetters.push(...letters);
  });

  it('replays each dead letter once to the original topic', async () => {
    const forwarded = envelopeFor('agg-forwarded');
    await pubsub.topic(dlqTopic).publishMessage({
      data: encodeEnvelope(forwarded),
      attributes: {
        ...sentAttributes(forwarded),
        [DEAD_LETTER_SOURCE_SUBSCRIPTION_ATTRIBUTE]: `projects/${PROJECT}/subscriptions/${subscription}`,
        [DEAD_LETTER_SOURCE_DELIVERY_COUNT_ATTRIBUTE]: '5',
      },
    });
    deadLetters.push(...(await pullUntil(dlqObserver, 1)));
    expect(deadLetters).toHaveLength(6);

    const summary = await replayDeadLetters({ subscription, projectId: PROJECT, ...REPLAY });
    expect(summary).toEqual({
      subscription,
      source: dlqReplaySubscriptionName(subscription),
      topic: topicOfSubscription(subscription),
      replayed: deadLetters.length,
      stoppedBy: 'idle',
    });
    expect(summary.topic).toBe(topic.name);

    const copies = await pullUntil(topicObserver.name, deadLetters.length);
    expect(copies).toHaveLength(deadLetters.length);
    for (const letter of deadLetters) {
      const matching = copies.filter((copy) => copy.data.equals(letter.data));
      expect(matching).toHaveLength(1);
      const envelope = decodeEnvelopeData(letter.data) as EventEnvelope;
      expect(matching[0]?.attributes).toEqual(originalAttributes(letter.attributes));
      expect(matching[0]?.orderingKey).toBe(letter.orderingKey ?? envelope.aggregateId);
    }
    expect(copies.find((copy) => copy.attributes.eventId === forwarded.eventId)).toEqual({
      data: encodeEnvelope(forwarded),
      attributes: sentAttributes(forwarded),
      orderingKey: forwarded.aggregateId,
    });
    replayedCopies.push(...copies);
  });

  it('acks each dead letter only after republishing it, so a second replay republishes nothing', async () => {
    const summary = await replayDeadLetters({ subscription, projectId: PROJECT, ...REPLAY });
    expect(summary).toMatchObject({ replayed: 0, stoppedBy: 'idle' });

    const sentinel = envelopeFor('agg-topic-sentinel');
    await topic.topic.publishMessage({
      data: encodeEnvelope(sentinel),
      attributes: sentAttributes(sentinel),
      orderingKey: sentinel.aggregateId,
    });
    const received = await pullUntil(topicObserver.name, 1);
    expect(received.map((message) => message.attributes.eventId)).toEqual([sentinel.eventId]);
  });

  it('applies a replayed message once when its delivery repeats', async () => {
    const copy = replayedCopies.find((candidate) => candidate.attributes.eventId === mismatchEventId);
    expect(copy).toBeDefined();
    const envelope = decodeEnvelopeData(copy?.data ?? '') as EventEnvelope<NotePayload>;
    await storeAggregate(TENANT_A.tenantId, envelope.aggregateId);
    const options = { attributes: copy?.attributes ?? {}, orderingKey: copy?.orderingKey };

    expect((await pushTo(app, subscription, envelope, options)).statusCode).toBe(204);
    expect(await rowsFor('test_effect', TENANT_A.tenantId, [envelope.eventId])).toBe(1);
    expect((await pushTo(app, subscription, envelope, options)).statusCode).toBe(204);
    expect([
      await rowsFor('test_effect', TENANT_A.tenantId, [envelope.eventId]),
      await rowsFor('inbox', TENANT_A.tenantId, [envelope.eventId]),
      await rowsFor('test_effect', TENANT_B.tenantId, [envelope.eventId]),
    ]).toEqual([1, 1, 0]);
  });

  it('publishes a direct dead letter unchanged to the subscription DLQ topic with its reason', async () => {
    const data = Buffer.from('not an envelope', 'utf8');
    const messageId = await publishDeadLetter(publisher, {
      subscription,
      data,
      attributes: { origin: 'direct' },
      reason: 'schema-invalid',
    });
    expect(messageId).toEqual(expect.any(String));

    expect(await pullUntil(dlqObserver, 1)).toEqual([
      { data, attributes: { origin: 'direct', [DEAD_LETTER_REASON_ATTRIBUTE]: 'schema-invalid' } },
    ]);
  });
});
