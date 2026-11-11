import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PubSub, type Message, type Subscription, type Topic } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INBOX_TABLE,
  consumeEnvelope,
  createPublisher,
  decodeEnvelopeData,
  dlqTopicName,
  eventsSql,
  registerPushSubscription,
  subscriptionName,
  topicOfSubscription,
  type ConsumerDefinition,
  type EventEnvelope,
  type EventKind,
  type EventPublisher,
  type InboxStatus,
} from '../../src/events/index.js';
import {
  GateClosedError,
  acquireWriteGates,
  closeGates,
  ensureUnitGates,
  migrationKitSql,
  openGates,
} from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { rlsSql, tenantRegistrySql, withTenant, type TenantTx } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  createTestTopic,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  versionedSequence,
  type InjectResponse,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
// The testing helpers create emulator topics in this project, so the publisher and the DLQ observer must use it too.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';
const REQUIRED_ENV = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE', 'PUBSUB_EMULATOR_HOST'] as const;
const EFFECT_UNIT = 'test_effect';
const GATE_BUDGET_MS = 250;
const SETUP_HOLDER = 'consumer-idempotency-setup';

interface ValuePayload {
  value: string;
}

type ValueEnvelope = EventEnvelope<ValuePayload>;

interface EffectRow {
  eventId: string;
  version: number;
  value: string;
  superseded: boolean;
}

interface AggregateRow {
  version: number;
  value: string;
}

const TEST_TABLES_SQL = [
  `CREATE TABLE ${SERVICE}.test_aggregate (`,
  '  tenant_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL,',
  '  version integer NOT NULL,',
  '  value text NOT NULL,',
  '  PRIMARY KEY (tenant_id, aggregate_id)',
  ');',
  rlsSql(SERVICE, 'test_aggregate'),
  `CREATE TABLE ${SERVICE}.test_effect (`,
  '  tenant_id uuid NOT NULL,',
  '  event_id uuid NOT NULL,',
  '  aggregate_id text NOT NULL,',
  '  version integer NOT NULL,',
  '  value text NOT NULL,',
  '  superseded boolean NOT NULL DEFAULT false',
  ');',
  rlsSql(SERVICE, 'test_effect'),
].join('\n');

/** Inline draft 2020-12 payload schema declaring `kind` and, when set, `x-opt2-supersedes`. */
function payloadSchema(kind: EventKind, supersedes = false): object {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-opt2-kind': kind,
    ...(supersedes ? { 'x-opt2-supersedes': true } : {}),
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { type: 'string' } },
  };
}

/** Apply calls per event id, across every consumer. */
const applyCalls = new Map<string, number>();
/** Errors the process consumer's apply threw, in order. */
const applyErrors: unknown[] = [];
/** Thrown by the next process apply instead of writing, then cleared. */
let injectedFailure: Error | undefined;

/** Counts one apply call of `envelope`. */
function countCall(envelope: ValueEnvelope): void {
  applyCalls.set(envelope.eventId, (applyCalls.get(envelope.eventId) ?? 0) + 1);
}

/** Records `envelope` as one effect row of the destination tenant. */
async function insertEffect(tx: TenantTx, envelope: ValueEnvelope): Promise<void> {
  await tx.query(
    `INSERT INTO ${tx.schema}.test_effect (tenant_id, event_id, aggregate_id, version, value) VALUES ($1, $2, $3, $4, $5)`,
    [tx.tenantId, envelope.eventId, envelope.aggregateId, envelope.aggregateVersion, envelope.payload.value],
  );
}

let handle: ThrowawaySchema | undefined;
let app: FastifyInstance | undefined;
let publisher: EventPublisher | undefined;
let pubsub: PubSub | undefined;
let dlqTopic: Topic | undefined;
let observer: Subscription | undefined;
const topics: TestTopic[] = [];

let stateConsumer: ConsumerDefinition<ValuePayload>;
let stateSub: string;
let processSub: string;
let supersedesSub: string;
let checkedSub: string;

/** The throwaway schema's tenant database. */
function db(): ThrowawaySchema['app'] {
  if (handle === undefined) throw new Error('beforeAll did not create the throwaway schema');
  return handle.app;
}

/** The app under test. */
function service(): FastifyInstance {
  if (app === undefined) throw new Error('beforeAll did not create the app');
  return app;
}

/** A version-1 envelope on `topic` of a fresh aggregate unless `aggregateId` is given. */
function envelopeOn(topic: string, tenantId = TENANT_A.tenantId, aggregateId = `agg-${randomUUID()}`): ValueEnvelope {
  return testEnvelope({ topic, tenantId, aggregateId, payload: { value: 'v1' } });
}

/** One envelope of `base`'s aggregate per entry of `list`, each carrying the value `v<version>`. */
function versionsOf<const V extends readonly number[]>(base: ValueEnvelope, list: V): { -readonly [K in keyof V]: ValueEnvelope } {
  return versionedSequence(base, list, (version) => ({ value: `v${version}` })) as { -readonly [K in keyof V]: ValueEnvelope };
}

/** Status codes of push responses, in delivery order. */
function statuses(responses: readonly InjectResponse[]): number[] {
  return responses.map((response) => response.statusCode);
}

/** Inbox statuses visible to `tenantId` for `eventIds`, keyed by event id. */
function inboxRows(tenantId: string, eventIds: readonly string[]): Promise<Record<string, InboxStatus>> {
  return withTenant(db(), tenantId, async (tx) => {
    const { rows } = await tx.query<{ event_id: string; status: InboxStatus }>(
      `SELECT event_id, status FROM ${tx.schema}.${INBOX_TABLE} WHERE event_id = ANY($1::uuid[])`,
      [eventIds],
    );
    return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
  });
}

/** Effect rows of `aggregateId` visible to `tenantId`, in version order. */
function effects(tenantId: string, aggregateId: string): Promise<EffectRow[]> {
  return withTenant(db(), tenantId, async (tx) => {
    const { rows } = await tx.query<{ event_id: string; version: number; value: string; superseded: boolean }>(
      `SELECT event_id, version, value, superseded FROM ${tx.schema}.test_effect WHERE aggregate_id = $1 ORDER BY version, event_id`,
      [aggregateId],
    );
    return rows.map((row) => ({ eventId: row.event_id, version: row.version, value: row.value, superseded: row.superseded }));
  });
}

/** Stored state of `aggregateId` visible to `tenantId`, or undefined. */
function aggregate(tenantId: string, aggregateId: string): Promise<AggregateRow | undefined> {
  return withTenant(db(), tenantId, async (tx) => {
    const { rows } = await tx.query<AggregateRow>(
      `SELECT version, value FROM ${tx.schema}.test_aggregate WHERE aggregate_id = $1`,
      [aggregateId],
    );
    return rows[0];
  });
}

/** Pulls and acks messages from emulator subscription `name` until `count` arrive or `deadlineMs` passes. */
async function pullUntil(name: string, count: number, deadlineMs = 10_000): Promise<Message[]> {
  if (pubsub === undefined) throw new Error('beforeAll did not create the Pub/Sub client');
  const receiver = pubsub.subscription(name, { flowControl: { maxMessages: count, allowExcessMessages: false } });
  const received: Message[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, deadlineMs);
      receiver.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      receiver.on('message', (message: Message) => {
        received.push(message);
        message.ack();
        if (received.length >= count) {
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

/** Closes the effect unit's gate for a fresh holder; the returned function reopens it. */
async function closeEffectGate(): Promise<() => Promise<unknown>> {
  const holderId = `window-${randomUUID()}`;
  await closeGates(db(), { units: [EFFECT_UNIT], holderId });
  return () => openGates(db(), { units: [EFFECT_UNIT], holderId });
}

/** Makes the next process apply throw; the returned function is a no-op, since the failure clears itself. */
async function failNextApply(): Promise<() => Promise<unknown>> {
  injectedFailure = new Error('injected apply failure');
  return () => Promise.resolve();
}

/** Runs every cleanup step in order and rethrows their failures together. */
async function cleanUp(steps: ReadonlyArray<() => Promise<unknown> | undefined>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'consumer-idempotency cleanup failed');
}

/** State consumer: upserts the aggregate's full state at the envelope's version. */
function stateConsumerFor(topic: string): ConsumerDefinition<ValuePayload> {
  return {
    topic,
    kind: 'state',
    async apply(tx, envelope) {
      countCall(envelope);
      await tx.query(
        `INSERT INTO ${tx.schema}.test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, $3, $4)` +
          ' ON CONFLICT (tenant_id, aggregate_id) DO UPDATE SET version = EXCLUDED.version, value = EXCLUDED.value',
        [tx.tenantId, envelope.aggregateId, envelope.aggregateVersion, envelope.payload.value],
      );
    },
  };
}

/** Process consumer: takes the effect unit's write gate, then records one effect row. */
function processConsumerFor(topic: string): ConsumerDefinition<ValuePayload> {
  return {
    topic,
    kind: 'process',
    async apply(tx, envelope) {
      countCall(envelope);
      try {
        const failure = injectedFailure;
        injectedFailure = undefined;
        if (failure !== undefined) throw failure;
        await acquireWriteGates(tx, [EFFECT_UNIT], { budgetMs: GATE_BUDGET_MS });
      } catch (error) {
        applyErrors.push(error);
        throw error;
      }
      await insertEffect(tx, envelope);
    },
  };
}

/** Superseding process consumer: marks the replaced version's effect superseded, then records the new one. */
function supersedesConsumerFor(topic: string): ConsumerDefinition<ValuePayload> {
  return {
    topic,
    kind: 'process',
    supersedes: true,
    async apply(tx, envelope, ctx) {
      countCall(envelope);
      if (ctx.previousEffectVersion !== undefined) {
        await tx.query(`UPDATE ${tx.schema}.test_effect SET superseded = true WHERE aggregate_id = $1 AND version = $2`, [
          envelope.aggregateId,
          ctx.previousEffectVersion,
        ]);
      }
      await insertEffect(tx, envelope);
    },
  };
}

/** Process consumer whose tenant re-check requires the aggregate to be stored under the destination tenant. */
function checkedConsumerFor(topic: string): ConsumerDefinition<ValuePayload> {
  return {
    topic,
    kind: 'process',
    async checkTenant(tx, envelope) {
      const { rowCount } = await tx.query(`SELECT 1 FROM ${tx.schema}.test_aggregate WHERE aggregate_id = $1`, [
        envelope.aggregateId,
      ]);
      return rowCount === 1;
    },
    async apply(tx, envelope) {
      countCall(envelope);
      await insertEffect(tx, envelope);
    },
  };
}

describe('event consumer idempotency through push delivery', () => {
  beforeAll(async () => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`consumer-idempotency needs ${missing.join(', ')} in the environment (PostgreSQL 16 and the Pub/Sub emulator)`);
    }
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at PG_HOST=${String(process.env.PG_HOST)} PG_PORT=${String(process.env.PG_PORT)} accepts no connection`);
    }
    if (!(await pubsubEmulatorAvailable())) {
      throw new Error(`The Pub/Sub emulator at PUBSUB_EMULATOR_HOST=${String(process.env.PUBSUB_EMULATOR_HOST)} does not answer`);
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
    await seedRegistry(handle.app, handle.schema);
    await ensureUnitGates(handle.app, [EFFECT_UNIT]);
    await closeGates(handle.app, { units: [EFFECT_UNIT], holderId: SETUP_HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: [EFFECT_UNIT], holderId: SETUP_HOLDER });

    const topicFor = async (prefix: string): Promise<string> => {
      const topic = await createTestTopic(prefix);
      topics.push(topic);
      return topic.name;
    };
    const stateTopic = await topicFor('stub-state');
    const processTopic = await topicFor('stub-process');
    const supersedesTopic = await topicFor('stub-supersedes');
    const checkedTopic = await topicFor('stub-checked');
    stateSub = subscriptionName(SERVICE, stateTopic);
    processSub = subscriptionName(SERVICE, processTopic);
    supersedesSub = subscriptionName(SERVICE, supersedesTopic);
    checkedSub = subscriptionName(SERVICE, checkedTopic);

    pubsub = new PubSub({ projectId: PROJECT, apiEndpoint: process.env.PUBSUB_EMULATOR_HOST, emulatorMode: true });
    [dlqTopic] = await pubsub.createTopic(dlqTopicName(checkedSub));
    [observer] = await dlqTopic.createSubscription(`${dlqTopicName(checkedSub)}.observer`);
    publisher = createPublisher({ projectId: PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST });

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
        OPT2_STATE_DIR: join(tmpdir(), 'opt2-consumer-idempotency-unused'),
        TZ: 'UTC',
      }),
      // The callee form sets every auth piece from the test keys, so no secret file under OPT2_STATE_DIR is read.
      verifierOverride: testVerifier(SERVICE),
    });
    stateConsumer = stateConsumerFor(stateTopic);
    const registrations = [
      { subscription: stateSub, consumer: stateConsumer, payloadSchema: payloadSchema('state') },
      { subscription: processSub, consumer: processConsumerFor(processTopic), payloadSchema: payloadSchema('process') },
      {
        subscription: supersedesSub,
        consumer: supersedesConsumerFor(supersedesTopic),
        payloadSchema: payloadSchema('process', true),
      },
      { subscription: checkedSub, consumer: checkedConsumerFor(checkedTopic), payloadSchema: payloadSchema('process') },
    ];
    for (const registration of registrations) {
      registerPushSubscription(app, { ...registration, publisher, db: handle.app });
    }
    await app.ready();
  });

  afterAll(async () => {
    await cleanUp([
      () => app?.close(),
      () => publisher?.close(),
      () => observer?.delete(),
      () => dlqTopic?.delete(),
      () => pubsub?.close(),
      ...topics.map((topic) => () => topic.delete()),
      () => handle?.drop(),
    ]);
  });

  it('applies a duplicate delivery once, with one inbox receipt', async () => {
    const envelope = envelopeOn(topicOfSubscription(processSub));

    const responses = await deliverDuplicate(service(), processSub, envelope, 3);

    expect(statuses(responses)).toEqual([204, 204, 204]);
    expect(await effects(TENANT_A.tenantId, envelope.aggregateId)).toEqual([
      { eventId: envelope.eventId, version: 1, value: 'v1', superseded: false },
    ]);
    expect(await inboxRows(TENANT_A.tenantId, [envelope.eventId])).toEqual({ [envelope.eventId]: 'applied' });
    expect(applyCalls.get(envelope.eventId)).toBe(1);
  });

  it('ignores state versions at or below the last applied one and applies a gapped one', async () => {
    const [v1, v2, v3, lateV2, sameV3] = versionsOf(envelopeOn(topicOfSubscription(stateSub)), [1, 2, 3, 2, 3]);

    expect(statuses(await deliverOutOfOrder(service(), stateSub, [v1, v3], [0, 1]))).toEqual([204, 204]);
    expect(await aggregate(TENANT_A.tenantId, v1.aggregateId)).toEqual({ version: 3, value: 'v3' });

    expect((await pushTo(service(), stateSub, v2)).statusCode).toBe(204);
    expect(await aggregate(TENANT_A.tenantId, v1.aggregateId)).toEqual({ version: 3, value: 'v3' });
    expect(await inboxRows(TENANT_A.tenantId, [v1.eventId, v2.eventId, v3.eventId])).toEqual({
      [v1.eventId]: 'applied',
      [v2.eventId]: 'stale',
      [v3.eventId]: 'applied',
    });
    expect(applyCalls.get(v2.eventId)).toBeUndefined();

    const options = { subscription: stateSub, messageId: randomUUID(), logger: service().opt2.logger };
    const outcome = (envelope: ValueEnvelope, result: string) => ({
      eventId: envelope.eventId,
      destinations: [{ tenantId: TENANT_A.tenantId, result }],
    });
    const replayedV3 = { ...sameV3, payload: { value: 'v3-replayed' } };
    await expect(consumeEnvelope(db(), stateConsumer, lateV2, options)).resolves.toEqual(outcome(lateV2, 'stale'));
    await expect(consumeEnvelope(db(), stateConsumer, replayedV3, options)).resolves.toEqual(outcome(sameV3, 'stale'));
    await expect(consumeEnvelope(db(), stateConsumer, v2, options)).resolves.toEqual(outcome(v2, 'duplicate'));
    expect(await aggregate(TENANT_A.tenantId, v1.aggregateId)).toEqual({ version: 3, value: 'v3' });
  });

  it('applies every process event once whatever the arrival order', async () => {
    const sequence = versionsOf(envelopeOn(topicOfSubscription(processSub)), [1, 2, 3, 4, 5]);
    const aggregateId = sequence[0].aggregateId;

    expect(statuses(await deliverOutOfOrder(service(), processSub, sequence, [2, 0, 4, 1, 3]))).toEqual([204, 204, 204, 204, 204]);
    const applied = await effects(TENANT_A.tenantId, aggregateId);
    expect(applied.map((effect) => [effect.version, effect.eventId])).toEqual(
      sequence.map((envelope) => [envelope.aggregateVersion, envelope.eventId]),
    );

    expect(statuses(await deliverOutOfOrder(service(), processSub, sequence, [0, 1, 2, 3, 4]))).toEqual([204, 204, 204, 204, 204]);
    expect(await effects(TENANT_A.tenantId, aggregateId)).toEqual(applied);
    expect(sequence.map((envelope) => applyCalls.get(envelope.eventId))).toEqual([1, 1, 1, 1, 1]);
  });

  it.each([
    {
      label: 'v2 before v1',
      order: [1, 0],
      current: [{ version: 2, superseded: false }],
      inbox: ['superseded', 'applied'],
    },
    {
      label: 'v1 before v2',
      order: [0, 1],
      current: [
        { version: 1, superseded: true },
        { version: 2, superseded: false },
      ],
      inbox: ['applied', 'applied'],
    },
  ])('keeps v2 as the current effect when $label arrive on a superseding topic', async ({ order, current, inbox }) => {
    const sequence = versionsOf(envelopeOn(topicOfSubscription(supersedesSub)), [1, 2]);
    const [v1, v2] = sequence;

    expect(statuses(await deliverOutOfOrder(service(), supersedesSub, sequence, order))).toEqual([204, 204]);

    const stored = await effects(TENANT_A.tenantId, v1.aggregateId);
    expect(stored.map(({ version, superseded }) => ({ version, superseded }))).toEqual(current);
    expect(stored.find((effect) => !effect.superseded)).toMatchObject({ eventId: v2.eventId, value: 'v2' });
    expect(await inboxRows(TENANT_A.tenantId, [v1.eventId, v2.eventId])).toEqual({
      [v1.eventId]: inbox[0],
      [v2.eventId]: inbox[1],
    });
  });

  it('reaches the in-order final state when state versions arrive out of order', async () => {
    const shuffled = versionsOf(envelopeOn(topicOfSubscription(stateSub)), [1, 2, 3, 4, 5, 6]);
    const ordered = versionsOf(envelopeOn(topicOfSubscription(stateSub)), [1, 2, 3, 4, 5, 6]);
    const shuffledId = shuffled[0].aggregateId;
    const orderedId = ordered[0].aggregateId;

    expect(statuses(await deliverOutOfOrder(service(), stateSub, shuffled, [5, 1, 3, 0, 4, 2]))).toEqual(Array(6).fill(204));
    expect(statuses(await deliverOutOfOrder(service(), stateSub, ordered, [0, 1, 2, 3, 4, 5]))).toEqual(Array(6).fill(204));

    expect(await aggregate(TENANT_A.tenantId, orderedId)).toEqual({ version: 6, value: 'v6' });
    expect(await aggregate(TENANT_A.tenantId, shuffledId)).toEqual(await aggregate(TENANT_A.tenantId, orderedId));
  });

  it('dead-letters a delivery whose aggregate is not visible under the envelope tenant', async () => {
    const aggregateId = `agg-${randomUUID()}`;
    await withTenant(db(), TENANT_B.tenantId, (tx) =>
      tx.query(`INSERT INTO ${tx.schema}.test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, 1, 'stored')`, [
        tx.tenantId,
        aggregateId,
      ]),
    );
    const foreign = envelopeOn(topicOfSubscription(checkedSub), TENANT_A.tenantId, aggregateId);

    expect((await pushTo(service(), checkedSub, foreign)).statusCode).toBe(204);

    const letters = await pullUntil(`${dlqTopicName(checkedSub)}.observer`, 1);
    expect(letters).toHaveLength(1);
    expect(letters[0]?.attributes).toMatchObject({ reason: 'tenant-mismatch', eventId: foreign.eventId, tenantId: TENANT_A.tenantId });
    expect(decodeEnvelopeData(letters[0]?.data ?? Buffer.alloc(0))).toEqual(foreign);
    for (const tenantId of [TENANT_A.tenantId, TENANT_B.tenantId]) {
      expect(await effects(tenantId, aggregateId)).toEqual([]);
      expect(await inboxRows(tenantId, [foreign.eventId])).toEqual({});
    }
    expect(applyCalls.get(foreign.eventId)).toBeUndefined();

    const owned = envelopeOn(topicOfSubscription(checkedSub), TENANT_B.tenantId, aggregateId);
    expect((await pushTo(service(), checkedSub, owned)).statusCode).toBe(204);
    expect((await effects(TENANT_B.tenantId, aggregateId)).map((effect) => effect.eventId)).toEqual([owned.eventId]);
  });

  it.each([
    {
      cause: 'the unit gate is closed',
      status: 503,
      block: closeEffectGate,
      error: { name: 'GateClosedError', units: [EFFECT_UNIT] },
    },
    {
      cause: 'apply fails',
      status: 500,
      block: failNextApply,
      error: { name: 'Error', message: 'injected apply failure' },
    },
  ])('nacks without a receipt when $cause, then applies the redelivery once', async ({ status, block, error }) => {
    const envelope = envelopeOn(topicOfSubscription(processSub));
    const unblock = await block();
    let first: InjectResponse;
    try {
      first = await pushTo(service(), processSub, envelope);
    } finally {
      await unblock();
    }

    expect(first.statusCode).toBe(status);
    expect(first.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(applyErrors.at(-1)).toMatchObject(error);
    expect(applyErrors.at(-1) instanceof GateClosedError).toBe(error.name === 'GateClosedError');
    expect(await inboxRows(TENANT_A.tenantId, [envelope.eventId])).toEqual({});
    expect(await effects(TENANT_A.tenantId, envelope.aggregateId)).toEqual([]);

    expect((await pushTo(service(), processSub, envelope)).statusCode).toBe(204);
    expect((await effects(TENANT_A.tenantId, envelope.aggregateId)).map((effect) => effect.eventId)).toEqual([envelope.eventId]);
    expect(await inboxRows(TENANT_A.tenantId, [envelope.eventId])).toEqual({ [envelope.eventId]: 'applied' });
  });
});
