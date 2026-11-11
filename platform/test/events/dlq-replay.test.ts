// Dead-letter classification of the push route, `publishDeadLetter` and `opt2-events replay` against PostgreSQL and the Pub/Sub emulator.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayError, replayDeadLetters, type ReplaySummary } from '../../src/events/cli.js';
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
  topicName,
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
  createThrowawaySchema,
  isAck,
  pgAvailable,
  publishToEmulator,
  pubsubEmulatorAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  withoutTenant,
  type TenantlessEnvelope,
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

/** Cases of the suite, each with its own {@link Fixture}. */
const CASES = ['reasons', 'nack', 'replay', 'apply', 'direct', 'publish-failure'] as const;
type CaseKey = (typeof CASES)[number];

/** One case's push route and dead-letter resources; its original topic exists only once the case calls {@link openTopic}. */
interface Fixture {
  key: CaseKey;
  topic: string;
  subscription: string;
  dlqTopic: string;
  dlqObserver: string;
  failApply: boolean;
}

let handle: ThrowawaySchema;
let pubsub: PubSub;
let publisher: EventPublisher;
let app: FastifyInstance;
const fixtures = new Map<CaseKey, Fixture>();
const cleanups: Array<() => Promise<unknown>> = [];

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

/** A contract-valid envelope on the fixture's topic for its aggregate `name`, whose id carries the case key. */
function envelopeFor(fixture: Fixture, name: string, tenantId = TENANT_A.tenantId, payload?: unknown): EventEnvelope {
  const aggregateId = `${fixture.key}.${name}`;
  return testEnvelope({ topic: fixture.topic, tenantId, aggregateId, payload: payload ?? { value: aggregateId } });
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

/** The process consumer of the fixture's topic: the aggregate must exist under the envelope tenant, and the effect is one row. */
function noteConsumer(fixture: Fixture): ConsumerDefinition<NotePayload> {
  return {
    topic: fixture.topic,
    kind: 'process',
    async checkTenant(tx, envelope) {
      const { rowCount } = await tx.query(`SELECT 1 FROM ${handle.schema}.test_aggregate WHERE aggregate_id = $1`, [
        envelope.aggregateId,
      ]);
      return rowCount === 1;
    },
    async apply(tx, envelope) {
      if (fixture.failApply) throw new Error('effect store unavailable');
      await tx.query(`INSERT INTO ${handle.schema}.test_effect (tenant_id, event_id, aggregate_id) VALUES ($1, $2, $3)`, [
        tx.tenantId,
        envelope.eventId,
        envelope.aggregateId,
      ]);
    },
  };
}

/** Creates case `key`'s DLQ topic with its `.dlq.replay` and observer subscriptions and mounts its push route. */
async function createFixture(key: CaseKey): Promise<Fixture> {
  const topic = topicName(SERVICE, `${key}-${randomBytes(4).toString('hex')}`, 'event', 1);
  const subscription = subscriptionName(SERVICE, topic);
  const dlqTopic = dlqTopicName(subscription);
  const fixture: Fixture = { key, topic, subscription, dlqTopic, dlqObserver: `${dlqTopic}.observer`, failApply: false };
  const [deadLetterTopic] = await pubsub.createTopic(dlqTopic);
  cleanups.push(() => deadLetterTopic.delete());
  for (const name of [dlqReplaySubscriptionName(subscription), fixture.dlqObserver]) {
    const [created] = await deadLetterTopic.createSubscription(name, { enableMessageOrdering: true });
    cleanups.push(() => created.delete());
  }
  registerPushSubscription(app, {
    subscription,
    topic,
    consumer: noteConsumer(fixture),
    payloadSchema: PAYLOAD_SCHEMA,
    publisher,
    db: handle.app,
  });
  return fixture;
}

/** The fixture of case `key`. */
function fixtureOf(key: CaseKey): Fixture {
  const fixture = fixtures.get(key);
  if (fixture === undefined) throw new Error(`The DLQ replay suite has no fixture for case ${key}`);
  return fixture;
}

/** Creates the fixture's original topic with an observer subscription; resolves to the observer's name. */
async function openTopic(fixture: Fixture): Promise<string> {
  const [created] = await pubsub.createTopic(fixture.topic);
  cleanups.push(() => created.delete());
  const observer = subscriptionName('observer', fixture.topic);
  const [subscription] = await created.createSubscription(observer, { enableMessageOrdering: true });
  cleanups.push(() => subscription.delete());
  return observer;
}

/** Runs `opt2-events replay` in-process for the fixture's subscription. */
function replay(fixture: Fixture): Promise<ReplaySummary> {
  return replayDeadLetters({ subscription: fixture.subscription, projectId: PROJECT, ...REPLAY });
}

/** Pushes one envelope per dead-letter reason to the fixture's route, expecting 204 for each; resolves to each reason with its envelope. */
async function pushRejected(fixture: Fixture): Promise<Array<[DeadLetterReason, TenantlessEnvelope]>> {
  const mismatch = envelopeFor(fixture, 'foreign');
  await storeAggregate(TENANT_B.tenantId, mismatch.aggregateId);
  const rejected: Array<[DeadLetterReason, TenantlessEnvelope]> = [
    ['missing-tenant', withoutTenant(envelopeFor(fixture, 'missing'))],
    ['invalid-tenant', { ...envelopeFor(fixture, 'invalid'), tenantId: TENANT_A.siteId }],
    ['schema-invalid', envelopeFor(fixture, 'schema', TENANT_A.tenantId, { value: 'x', unexpected: true })],
    ['tenant-mismatch', mismatch],
  ];
  for (const [, envelope] of rejected) {
    expect((await pushTo(app, fixture.subscription, envelope)).statusCode).toBe(204);
  }
  return rejected;
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
  // Push routes must be mounted before the first inject readies the app, so every case's fixture is created here.
  for (const key of CASES) {
    fixtures.set(key, await createFixture(key));
  }
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
    const fixture = fixtureOf('reasons');
    const cases = await pushRejected(fixture);

    const letters = await pullUntil(fixture.dlqObserver, cases.length);
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
  });

  it('nacks a processing error without dead-lettering', async () => {
    const fixture = fixtureOf('nack');
    const failing = envelopeFor(fixture, 'ok');
    await storeAggregate(TENANT_A.tenantId, failing.aggregateId);
    fixture.failApply = true;
    const response = await pushTo(app, fixture.subscription, failing).finally(() => {
      fixture.failApply = false;
    });
    expect(isAck(response)).toBe(false);
    expect([
      await rowsFor('test_effect', TENANT_A.tenantId, [failing.eventId]),
      await rowsFor('inbox', TENANT_A.tenantId, [failing.eventId]),
    ]).toEqual([0, 0]);

    const sentinel = withoutTenant(envelopeFor(fixture, 'sentinel'));
    expect((await pushTo(app, fixture.subscription, sentinel)).statusCode).toBe(204);
    const letters = await pullUntil(fixture.dlqObserver, 1);
    expect(letters.map((letter) => letter.attributes.eventId)).toEqual([sentinel.eventId]);
  });

  it('replays each dead letter once to the original topic, so a second replay republishes nothing', async () => {
    const fixture = fixtureOf('replay');
    const { subscription } = fixture;
    const observer = await openTopic(fixture);
    const rejected = await pushRejected(fixture);
    const forwarded = envelopeFor(fixture, 'forwarded');
    await pubsub.topic(fixture.dlqTopic).publishMessage({
      data: encodeEnvelope(forwarded),
      attributes: {
        ...sentAttributes(forwarded),
        [DEAD_LETTER_SOURCE_SUBSCRIPTION_ATTRIBUTE]: `projects/${PROJECT}/subscriptions/${subscription}`,
        [DEAD_LETTER_SOURCE_DELIVERY_COUNT_ATTRIBUTE]: '5',
      },
    });
    const deadLetters = await pullUntil(fixture.dlqObserver, rejected.length + 1);
    expect(deadLetters).toHaveLength(rejected.length + 1);

    const summary = await replay(fixture);
    expect(summary).toEqual({
      subscription,
      source: dlqReplaySubscriptionName(subscription),
      topic: topicOfSubscription(subscription),
      replayed: deadLetters.length,
      stoppedBy: 'idle',
    });
    expect(summary.topic).toBe(fixture.topic);

    const copies = await pullUntil(observer, deadLetters.length);
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

    expect(await replay(fixture)).toMatchObject({ replayed: 0, stoppedBy: 'idle' });
    const sentinel = envelopeFor(fixture, 'topic-sentinel');
    await publishToEmulator(fixture.topic, sentinel);
    const received = await pullUntil(observer, 1);
    expect(received.map((message) => message.attributes.eventId)).toEqual([sentinel.eventId]);
  });

  it('withholds the ack when republishing fails, so the next replay republishes the dead letter once', async () => {
    const fixture = fixtureOf('publish-failure');
    const { subscription } = fixture;
    const letter = envelopeFor(fixture, 'unpublished');
    await publishDeadLetter(publisher, {
      subscription,
      data: encodeEnvelope(letter),
      attributes: sentAttributes(letter),
      orderingKey: letter.aggregateId,
      reason: 'tenant-mismatch',
    });

    // The original topic does not exist yet, so the emulator rejects the republication.
    const failure = await replay(fixture).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ReplayError);
    expect(failure).toMatchObject({ replayed: 0 });
    expect((failure as ReplayError).message).toContain(`publish to ${fixture.topic} failed`);

    const observer = await openTopic(fixture);
    expect(await replay(fixture)).toEqual({
      subscription,
      source: dlqReplaySubscriptionName(subscription),
      topic: fixture.topic,
      replayed: 1,
      stoppedBy: 'idle',
    });
    expect(await pullUntil(observer, 1)).toEqual([
      { data: encodeEnvelope(letter), attributes: sentAttributes(letter), orderingKey: letter.aggregateId },
    ]);
    expect(await replay(fixture)).toMatchObject({ replayed: 0, stoppedBy: 'idle' });
  });

  it('applies a replayed message once when its delivery repeats', async () => {
    const fixture = fixtureOf('apply');
    const { subscription } = fixture;
    const observer = await openTopic(fixture);
    const mismatch = envelopeFor(fixture, 'foreign');
    await storeAggregate(TENANT_B.tenantId, mismatch.aggregateId);
    expect((await pushTo(app, subscription, mismatch)).statusCode).toBe(204);
    expect(await replay(fixture)).toMatchObject({ replayed: 1, stoppedBy: 'idle' });
    const copies = await pullUntil(observer, 1);
    expect(copies.map((candidate) => candidate.attributes.eventId)).toEqual([mismatch.eventId]);
    const [copy] = copies as [Received];

    const envelope = decodeEnvelopeData(copy.data) as EventEnvelope<NotePayload>;
    await storeAggregate(TENANT_A.tenantId, envelope.aggregateId);
    const options = { attributes: copy.attributes, orderingKey: copy.orderingKey };

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
    const fixture = fixtureOf('direct');
    const data = Buffer.from('not an envelope', 'utf8');
    const messageId = await publishDeadLetter(publisher, {
      subscription: fixture.subscription,
      data,
      attributes: { origin: 'direct' },
      reason: 'schema-invalid',
    });
    expect(messageId).toEqual(expect.any(String));

    expect(await pullUntil(fixture.dlqObserver, 1)).toEqual([
      { data, attributes: { origin: 'direct', [DEAD_LETTER_REASON_ATTRIBUTE]: 'schema-invalid' } },
    ]);
  });
});
