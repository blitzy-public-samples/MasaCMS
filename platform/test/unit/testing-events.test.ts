import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PubSub } from '@google-cloud/pubsub';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { QueryConfig, QueryResultRow } from 'pg';
import type { DestinationStream } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  InvalidEventNameError,
  decodeEnvelopeData,
  decodePushBody,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  eventsSql,
  pushPath,
  registerPushSubscription,
  subscriptionName,
  topicName,
  validateEnvelope,
  type ConsumerDefinition,
  type DecodedPush,
  type EventEnvelope,
  type EventPublisher,
  type RawMessage,
} from '../../src/events/index.js';
import { REDACTED, createLogger, type Logger } from '../../src/logging/index.js';
import { rowFromDb } from '../../src/outbox/ddl.js';
import { createOutbox, flushAfterCommit, publishLockedRows, resetOutboxRuntimes } from '../../src/outbox/flush.js';
import { createService } from '../../src/service-kit/create-service.js';
import { loadEnv } from '../../src/service-kit/env.js';
import { fixedClock } from '../../src/service-kit/index.js';
import type { TenantDb, TenantTx } from '../../src/tenancy/index.js';
import {
  InjectedPublishError,
  createCapturingPublisher,
  createTestSubscription,
  createTestTopic,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  publishToEmulator,
  pubsubEmulatorAvailable,
  pushTo,
  testEnvelope,
  versionedSequence,
  withEnvelopeTenant,
  withTenant,
  withoutTenant,
  type PushTarget,
  type TestTopic,
} from '../../src/testing/events.js';
import { TENANT_A, TENANT_B } from '../../src/testing/fixtures.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';
import { TEST_PUSH_KEY, pushKeyQuery, testVerifier } from '../../src/testing/tokens.js';

const SERVICE = 'stub';
const TOPIC = 'stub.note.created.v1';
const SUBSCRIPTION = subscriptionName(SERVICE, TOPIC);
const PUSH_URL = `/internal/v1/events/${SUBSCRIPTION}?key=${TEST_PUSH_KEY}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const STAMP = '2026-06-30 14:05:09.123';
const NOT_SET = 'PUBSUB_EMULATOR_HOST is not set: the emulator helpers never reach a real Pub/Sub project';

interface NotePayload {
  noteId: string;
  text: string;
}

type LogLine = Record<string, unknown>;

/** A tenant A `stub.note.created.v1` envelope of aggregate `noteId`, at version 1. */
function noteEnvelope(noteId = `note-${randomUUID()}`): EventEnvelope<NotePayload> {
  return testEnvelope({ topic: TOPIC, tenantId: TENANT_A.tenantId, aggregateId: noteId, payload: { noteId, text: 'hello' } });
}

/** A logger writing parsed lines into `lines`. */
function capturingLogger(lines: LogLine[] = []): Logger {
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  return createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination });
}

/** A PushTarget standing in for a Fastify app: inject records each request and answers `statusCode`. */
function recordingTarget(statusCode = 204): { target: PushTarget; requests: InjectOptions[] } {
  const requests: InjectOptions[] = [];
  const inject = (options: InjectOptions) => {
    requests.push(options);
    return Promise.resolve({ statusCode });
  };
  return { target: { inject: inject as unknown as PushTarget['inject'] }, requests };
}

/** The push delivery carried by a recorded request. */
function pushOf(request: InjectOptions | undefined): DecodedPush {
  return decodePushBody(request?.payload);
}

/** The envelope carried by a recorded request. */
function envelopeOf(request: InjectOptions | undefined): unknown {
  return decodeEnvelopeData(pushOf(request).data);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('testEnvelope', () => {
  it('derives type, version, producer and aggregate type from the topic and fills ids, trace and time', () => {
    const before = Date.now();
    const envelope = testEnvelope({ topic: 'people.person.archived.v2', tenantId: TENANT_A.tenantId, aggregateId: 'p-1', payload: { personId: 'p-1' } });

    expect(envelope).toMatchObject({
      eventType: 'people.person.archived',
      schemaVersion: '2.0.0',
      tenantId: TENANT_A.tenantId,
      producer: 'people',
      aggregateType: 'person',
      aggregateId: 'p-1',
      aggregateVersion: 1,
      payload: { personId: 'p-1' },
    });
    expect(envelope.eventId).toMatch(UUID_V4);
    expect(envelope.correlationId).toMatch(UUID_V4);
    expect(envelope.correlationId).not.toBe(envelope.eventId);
    expect(envelope.traceparent).toMatch(TRACEPARENT);
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
    expect(Date.parse(envelope.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(envelope.occurredAt)).toBeLessThanOrEqual(Date.now());
    expect(envelope).not.toHaveProperty('causationId');
    expect(validateEnvelope(envelope)).toEqual({ ok: true, value: envelope });
  });

  it('draws a fresh eventId, correlationId and traceparent on every call', () => {
    const [first, second] = [noteEnvelope('note-1'), noteEnvelope('note-1')];
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(second.traceparent).not.toBe(first.traceparent);
  });

  it('keeps every given field, including a null causationId', () => {
    const input = {
      topic: TOPIC,
      tenantId: TENANT_B.tenantId,
      aggregateId: 'note-9',
      aggregateVersion: 7,
      payload: { noteId: 'note-9', text: 'given' },
      aggregateType: 'memo',
      eventId: '0f7c6a52-0c8e-4d8e-9a43-000000000009',
      occurredAt: '2026-03-04T05:06:07.000Z',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      correlationId: 'corr-9',
      causationId: null,
      producer: 'people',
    };
    const envelope = testEnvelope(input);

    expect(envelope).toStrictEqual({
      eventId: input.eventId,
      eventType: 'stub.note.created',
      schemaVersion: '1.0.0',
      tenantId: TENANT_B.tenantId,
      occurredAt: input.occurredAt,
      producer: 'people',
      aggregateType: 'memo',
      aggregateId: 'note-9',
      aggregateVersion: 7,
      traceparent: input.traceparent,
      correlationId: 'corr-9',
      causationId: null,
      payload: input.payload,
    });
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it.each(['stub.note.created', 'stub.note.created.v0', 'Stub.note.created.v1'])('throws InvalidEventNameError for topic %j', (topic) => {
    expect(() => testEnvelope({ topic, tenantId: TENANT_A.tenantId, aggregateId: 'a', payload: {} })).toThrow(InvalidEventNameError);
  });
});

describe('envelope tenant helpers', () => {
  it('withoutTenant drops only tenantId, leaving the original intact and the copy outside the contract', () => {
    const envelope = noteEnvelope();
    const tenantless = withoutTenant(envelope);

    expect(tenantless).not.toHaveProperty('tenantId');
    expect({ ...tenantless, tenantId: envelope.tenantId }).toStrictEqual(envelope);
    expect(envelope.tenantId).toBe(TENANT_A.tenantId);
    expect(validateEnvelope(tenantless)).toEqual({
      ok: false,
      errors: ["/ must have required property 'tenantId'"],
      schemaPaths: ['#/required'],
    });
  });

  it.each([
    ['withEnvelopeTenant', withEnvelopeTenant],
    ['withTenant', withTenant],
  ])('%s sets tenantId on a copy of a tenant-bearing or tenantless envelope', (_name, setTenant) => {
    const envelope = noteEnvelope();
    const moved = setTenant(envelope, TENANT_B.tenantId);

    expect(moved).toStrictEqual({ ...envelope, tenantId: TENANT_B.tenantId });
    expect(envelope.tenantId).toBe(TENANT_A.tenantId);
    expect(validateEnvelope(moved).ok).toBe(true);
    expect(setTenant(withoutTenant(envelope), TENANT_A.tenantId)).toStrictEqual(envelope);
  });
});

describe('versionedSequence', () => {
  it('emits one envelope per version, in the given order, sharing every base field but a fresh eventId', () => {
    const base = noteEnvelope('note-seq');
    const sequence = versionedSequence(base, [1, 3, 2]);

    expect(sequence.map((envelope) => envelope.aggregateVersion)).toEqual([1, 3, 2]);
    expect(new Set([base.eventId, ...sequence.map((envelope) => envelope.eventId)]).size).toBe(4);
    for (const envelope of sequence) {
      expect(envelope.eventId).toMatch(UUID_V4);
      expect({ ...envelope, eventId: base.eventId, aggregateVersion: base.aggregateVersion }).toStrictEqual(base);
      expect(envelope.payload).toBe(base.payload);
      expect(validateEnvelope(envelope).ok).toBe(true);
    }
  });

  it('takes each payload from payloadFor with its version', () => {
    const payloadFor = vi.fn((version: number): NotePayload => ({ noteId: 'note-seq', text: `v${version}` }));
    const sequence = versionedSequence(noteEnvelope('note-seq'), [2, 5], payloadFor);

    expect(sequence.map((envelope) => envelope.payload)).toEqual([
      { noteId: 'note-seq', text: 'v2' },
      { noteId: 'note-seq', text: 'v5' },
    ]);
    expect(payloadFor.mock.calls).toEqual([[2], [5]]);
  });
});

describe('createCapturingPublisher', () => {
  const raw: RawMessage = { data: Buffer.from('raw bytes'), attributes: { origin: 'test' }, orderingKey: 'note-raw' };

  it('records publish and publishRaw in order, numbering message ids across both, as an EventPublisher', async () => {
    const capturing = createCapturingPublisher();
    const publisher: EventPublisher = capturing;
    const [first, second] = [noteEnvelope(), noteEnvelope()];

    await expect(publisher.publish(TOPIC, first)).resolves.toBe('1');
    await expect(publisher.publishRaw('stub.note.deleted.v1', raw)).resolves.toBe('2');
    await expect(publisher.publish(TOPIC, second)).resolves.toBe('3');

    expect(capturing.published).toStrictEqual([
      { topic: TOPIC, envelope: first },
      { topic: TOPIC, envelope: second },
    ]);
    expect(capturing.published[0]?.envelope).toBe(first);
    expect(capturing.raw).toStrictEqual([{ topic: 'stub.note.deleted.v1', message: raw }]);
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  it('clear empties both logs in place and keeps numbering message ids', async () => {
    const capturing = createCapturingPublisher();
    const { published, raw: rawLog } = capturing;
    await capturing.publish(TOPIC, noteEnvelope());
    await capturing.publishRaw(TOPIC, raw);

    capturing.clear();

    expect(capturing.published).toBe(published);
    expect(capturing.raw).toBe(rawLog);
    expect([published, rawLog]).toEqual([[], []]);
    await expect(capturing.publish(TOPIC, noteEnvelope())).resolves.toBe('3');
    expect(published).toHaveLength(1);
  });

  it.each([
    { n: undefined, failures: 1 },
    { n: 3, failures: 3 },
  ])('failNext($n) rejects the next $failures publishes of either method, recording nothing, then publishes', async ({ n, failures }) => {
    const capturing = createCapturingPublisher();
    const envelope = noteEnvelope();
    capturing.failNext(n);

    for (let attempt = 0; attempt < failures; attempt += 1) {
      const viaRaw = attempt % 2 === 1;
      const topic = viaRaw ? 'stub.note.deleted.v1' : TOPIC;
      const rejection = viaRaw ? capturing.publishRaw(topic, raw) : capturing.publish(topic, envelope);
      await expect(rejection).rejects.toBeInstanceOf(InjectedPublishError);
      await expect(rejection).rejects.toMatchObject({ name: 'InjectedPublishError', message: `Injected publish failure on topic ${topic}` });
    }

    expect([capturing.published, capturing.raw]).toEqual([[], []]);
    await expect(capturing.publish(TOPIC, envelope)).resolves.toBe('1');
    await expect(capturing.publishRaw(TOPIC, raw)).resolves.toBe('2');
  });

  it('deadLetters lists the raw messages on the subscription .dlq topic in order, with reason only when it is a known one', async () => {
    const capturing = createCapturingPublisher();
    const other = subscriptionName('timesheets', TOPIC);
    const letters: RawMessage[] = [
      { data: Buffer.from('a'), attributes: { reason: 'missing-tenant' }, orderingKey: 'k' },
      { data: Buffer.from('b'), attributes: { reason: 'schema-invalid' } },
      { data: Buffer.from('c'), attributes: { reason: 'not-a-reason' } },
      { data: Buffer.from('d'), attributes: {} },
    ];
    await capturing.publishRaw(dlqTopicName(SUBSCRIPTION), letters[0] as RawMessage);
    await capturing.publishRaw(dlqTopicName(other), letters[1] as RawMessage);
    await capturing.publishRaw(dlqTopicName(SUBSCRIPTION), letters[2] as RawMessage);
    await capturing.publishRaw(TOPIC, letters[3] as RawMessage);
    await capturing.publishRaw(dlqTopicName(SUBSCRIPTION), letters[3] as RawMessage);
    await capturing.publish(dlqTopicName(SUBSCRIPTION), noteEnvelope());

    expect(capturing.deadLetters(SUBSCRIPTION)).toStrictEqual([
      { topic: `${SUBSCRIPTION}.dlq`, message: letters[0], reason: 'missing-tenant' },
      { topic: `${SUBSCRIPTION}.dlq`, message: letters[2] },
      { topic: `${SUBSCRIPTION}.dlq`, message: letters[3] },
    ]);
    expect(capturing.deadLetters(other)).toStrictEqual([{ topic: `${other}.dlq`, message: letters[1], reason: 'schema-invalid' }]);
    expect(capturing.deadLetters(subscriptionName('people', TOPIC))).toEqual([]);
  });
});

describe('pushTo', () => {
  it.each([
    { project: 'opt2-push-test', subscription: `projects/opt2-push-test/subscriptions/${SUBSCRIPTION}` },
    { project: undefined, subscription: `projects/opt2-local/subscriptions/${SUBSCRIPTION}` },
  ])('POSTs the envelope as a Pub/Sub push of project $project to the push route with the test key', async ({ project, subscription }) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', project);
    const envelope = noteEnvelope();
    const { target, requests } = recordingTarget();

    const response = await pushTo(target, SUBSCRIPTION, envelope);

    expect(response.statusCode).toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: PUSH_URL });
    expect(PUSH_URL).toBe(`${pushPath(SUBSCRIPTION)}?${pushKeyQuery()}`);
    const push = pushOf(requests[0]);
    expect(push).toMatchObject({ attributes: envelopeAttributes(envelope), orderingKey: envelope.aggregateId, subscription });
    expect(push.messageId).toMatch(UUID_V4);
    expect(push).not.toHaveProperty('deliveryAttempt');
    expect(new Date(push.publishTime ?? '').toISOString()).toBe(push.publishTime);
    expect(envelopeOf(requests[0])).toStrictEqual(envelope);
  });

  it('applies the given key, message id, ordering key, delivery attempt and attribute overrides', async () => {
    const envelope = noteEnvelope();
    const { target, requests } = recordingTarget();

    await pushTo(target, SUBSCRIPTION, envelope, {
      key: 'wrong key&more',
      messageId: 'msg-7',
      orderingKey: 'other-key',
      deliveryAttempt: 3,
      attributes: { tenantId: TENANT_B.tenantId, extra: 'x' },
    });

    expect(requests[0]?.url).toBe(`${pushPath(SUBSCRIPTION)}?key=wrong%20key%26more`);
    expect(pushOf(requests[0])).toMatchObject({
      messageId: 'msg-7',
      orderingKey: 'other-key',
      deliveryAttempt: 3,
      attributes: { ...envelopeAttributes(envelope), tenantId: TENANT_B.tenantId, extra: 'x' },
    });
  });

  it('encodes a tenantless envelope with every mirrored attribute but tenantId', async () => {
    const envelope = noteEnvelope();
    const tenantless = withoutTenant(envelope);
    const { target, requests } = recordingTarget();

    await pushTo(target, SUBSCRIPTION, tenantless);

    const { tenantId: _tenantId, ...expected } = envelopeAttributes(envelope);
    expect(pushOf(requests[0]).attributes).toStrictEqual(expected);
    expect(envelopeOf(requests[0])).toStrictEqual(tenantless);
  });

  it('resolves to the target response whatever its status', async () => {
    const { target } = recordingTarget(503);
    const response = await pushTo(target, SUBSCRIPTION, noteEnvelope());
    expect(response.statusCode).toBe(503);
    expect(isAck(response)).toBe(false);
  });
});

describe('deliverDuplicate', () => {
  it.each([
    { times: undefined, attempts: [1, 2] },
    { times: 3, attempts: [1, 2, 3] },
    { times: 0, attempts: [] },
  ])('delivers the envelope $times times under one message id with delivery attempts $attempts', async ({ times, attempts }) => {
    const envelope = noteEnvelope();
    const { target, requests } = recordingTarget();

    const responses = await deliverDuplicate(target, SUBSCRIPTION, envelope, times);

    expect(responses.map((response) => response.statusCode)).toEqual(attempts.map(() => 204));
    const pushes = requests.map(pushOf);
    expect(pushes.map((push) => push.deliveryAttempt)).toEqual(attempts);
    expect(new Set(pushes.map((push) => push.messageId)).size).toBe(Math.min(attempts.length, 1));
    expect(requests.map(envelopeOf)).toStrictEqual(attempts.map(() => envelope));
    expect(requests.every((request) => request.url === PUSH_URL)).toBe(true);
  });
});

describe('deliverOutOfOrder', () => {
  const sequence = versionedSequence(noteEnvelope('note-order'), [1, 2, 3]);

  it('delivers the envelopes at the given indexes in turn, each under its own message id', async () => {
    const { target, requests } = recordingTarget();

    const responses = await deliverOutOfOrder(target, SUBSCRIPTION, sequence, [2, 0, 1, 2]);

    expect(responses).toHaveLength(4);
    expect(requests.map(envelopeOf)).toStrictEqual([sequence[2], sequence[0], sequence[1], sequence[2]]);
    const pushes = requests.map(pushOf);
    expect(new Set(pushes.map((push) => push.messageId)).size).toBe(4);
    expect(pushes.every((push) => push.deliveryAttempt === undefined && push.orderingKey === 'note-order')).toBe(true);
  });

  it.each([-1, 3])('rejects with RangeError at order index %i, after delivering the indexes before it', async (index) => {
    const { target, requests } = recordingTarget();

    await expect(deliverOutOfOrder(target, SUBSCRIPTION, sequence, [0, index, 1])).rejects.toThrow(
      new RangeError(`Delivery order index ${index} is outside the 3 envelopes`),
    );
    expect(requests.map(envelopeOf)).toStrictEqual([sequence[0]]);
  });
});

describe('isAck', () => {
  it.each([
    [200, true],
    [204, true],
    [299, true],
    [199, false],
    [300, false],
    [400, false],
    [401, false],
    [500, false],
  ])('treats status %i as an ack: %s', (statusCode, ack) => {
    expect(isAck({ statusCode })).toBe(ack);
  });
});

const pgUp = await pgAvailable();

describe.skipIf(!pgUp)('push helpers against a createService push subscription', () => {
  const publisher = createCapturingPublisher();
  const applied: Array<{ tenantId: string; aggregateId: string; version: number; eventId: string }> = [];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;

  const consumer: ConsumerDefinition<NotePayload> = {
    topic: TOPIC,
    kind: 'state',
    checkTenant: () => true,
    apply: (tx, envelope) => {
      applied.push({ tenantId: tx.tenantId, aggregateId: envelope.aggregateId, version: envelope.aggregateVersion, eventId: envelope.eventId });
    },
  };

  /** Inbox receipts of `eventId` visible to tenant A. */
  async function receipts(eventId: string): Promise<number> {
    return handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.inbox WHERE event_id = $1`, [eventId]);
      return rows[0]?.n ?? 0;
    });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'testing-events', schemaName: SERVICE, extraSql: [eventsSql(SERVICE)] });
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '26498',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: join(tmpdir(), 'opt2-testing-events-unused'),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      logger: capturingLogger(),
      pool: handle.app,
    });
    registerPushSubscription(app, {
      subscription: SUBSCRIPTION,
      consumer,
      publisher,
      payloadSchema: {
        'x-opt2-kind': 'state',
        type: 'object',
        required: ['noteId', 'text'],
        additionalProperties: false,
        properties: { noteId: { type: 'string', minLength: 1 }, text: { type: 'string' } },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  it('deliverDuplicate is acked twice and applied once with one inbox receipt', async () => {
    const envelope = noteEnvelope();

    const responses = await deliverDuplicate(app, SUBSCRIPTION, envelope);

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204]);
    expect(responses.every(isAck)).toBe(true);
    expect(applied.filter((effect) => effect.eventId === envelope.eventId)).toEqual([
      { tenantId: TENANT_A.tenantId, aggregateId: envelope.aggregateId, version: 1, eventId: envelope.eventId },
    ]);
    expect(await receipts(envelope.eventId)).toBe(1);
  });

  it('deliverOutOfOrder acks every version and the state consumer skips the stale one', async () => {
    const aggregateId = `note-${randomUUID()}`;
    const sequence = versionedSequence(noteEnvelope(aggregateId), [1, 2, 3]);

    const responses = await deliverOutOfOrder(app, SUBSCRIPTION, sequence, [1, 0, 2]);

    expect(responses.map(isAck)).toEqual([true, true, true]);
    expect(applied.filter((effect) => effect.aggregateId === aggregateId).map((effect) => effect.version)).toEqual([2, 3]);
  });

  it('pushTo of a tenantless envelope is acked and dead-lettered as missing-tenant on the capturing publisher', async () => {
    const envelope = noteEnvelope();
    const tenantless = withoutTenant(envelope);
    publisher.clear();

    const response = await pushTo(app, SUBSCRIPTION, tenantless);

    expect(response.statusCode).toBe(204);
    const { tenantId: _tenantId, ...attributes } = envelopeAttributes(envelope);
    expect(publisher.deadLetters(SUBSCRIPTION)).toStrictEqual([
      {
        topic: dlqTopicName(SUBSCRIPTION),
        message: { data: encodeEnvelope(tenantless as EventEnvelope), attributes: { ...attributes, reason: 'missing-tenant' }, orderingKey: tenantless.aggregateId },
        reason: 'missing-tenant',
      },
    ]);
    expect(applied.some((effect) => effect.eventId === tenantless.eventId)).toBe(false);
  });

  it('pushTo with another push key is refused with 401, a nack', async () => {
    const envelope = noteEnvelope();

    const response = await pushTo(app, SUBSCRIPTION, envelope, { key: 'not-the-test-key' });

    expect(response.statusCode).toBe(401);
    expect(isAck(response)).toBe(false);
    expect(await receipts(envelope.eventId)).toBe(0);
  });
});

describe('capturing publisher behind the outbox flush', () => {
  interface Statement {
    sql: string;
    values: unknown[] | undefined;
  }

  /** A stored outbox row of `envelope` as pg returns it. */
  function storedRow(seq: number, envelope: EventEnvelope): QueryResultRow {
    return {
      seq: String(seq),
      tenant_id: envelope.tenantId,
      event_id: envelope.eventId,
      topic: TOPIC,
      kind: 'state',
      ordering_key: envelope.aggregateId,
      envelope,
      operation_id: null,
      held: false,
      created_at: '2026-06-30 14:00:00.000',
      published_at: null,
    };
  }

  /** A tenant A TenantDb whose locking SELECTs answer `selected` and whose blocker SELECT finds none, recording every statement. */
  function outboxDb(selected: readonly QueryResultRow[] = []): { db: TenantDb; tx: TenantTx; statements: Statement[] } {
    const statements: Statement[] = [];
    const tx: TenantTx = {
      schema: SERVICE,
      kind: 'tenant',
      tenantId: TENANT_A.tenantId,
      onCommit: () => undefined,
      query: ((text: string | QueryConfig, values?: unknown[]) => {
        const sql = typeof text === 'string' ? text : text.text;
        statements.push({ sql, values });
        const rows = sql.startsWith('SELECT') && !sql.startsWith('SELECT ordering_key') ? [...selected] : [];
        return Promise.resolve({ command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows });
      }) as TenantTx['query'],
    };
    const db: TenantDb = {
      schema: SERVICE,
      withTenant: (_tenantId, fn) => fn(tx),
      withMetadata: () => Promise.reject(new Error('the outbox flush opens no metadata transaction')),
      end: () => Promise.resolve(),
    };
    return { db, tx, statements };
  }

  /** The statement stamping `eventIds` as published at NOW. */
  const stamped = (eventIds: string[]) => ({
    sql: expect.stringMatching(/^UPDATE "stub"\.outbox SET published_at = \$1 /),
    values: [STAMP, eventIds],
  });

  afterEach(() => {
    resetOutboxRuntimes();
  });

  it('publishLockedRows hands every stored envelope to the capturing publisher in seq order and stamps them', async () => {
    const [first, second] = [noteEnvelope('note-k'), noteEnvelope('note-l')];
    const { db, tx, statements } = outboxDb();
    const publisher = createCapturingPublisher();
    const runtime = createOutbox({ service: SERVICE, db, publisher, logger: capturingLogger(), clock: fixedClock(NOW) });

    const summary = await publishLockedRows(tx, runtime, [storedRow(2, second), storedRow(1, first)].map(rowFromDb));

    expect(summary).toStrictEqual({ published: 2, failed: 0, skipped: 0 });
    expect(publisher.published).toStrictEqual([
      { topic: TOPIC, envelope: first },
      { topic: TOPIC, envelope: second },
    ]);
    expect(statements).toEqual([stamped([first.eventId, second.eventId])]);
  });

  it('failNext(1) fails the first row, skips its ordering key, logs the InjectedPublishError and stamps only the other key', async () => {
    const failed = noteEnvelope('note-k');
    const [follower] = versionedSequence(failed, [2]);
    const other = noteEnvelope('note-l');
    const { db, tx, statements } = outboxDb();
    const lines: LogLine[] = [];
    const publisher = createCapturingPublisher();
    const runtime = createOutbox({ service: SERVICE, db, publisher, logger: capturingLogger(lines), clock: fixedClock(NOW) });
    publisher.failNext(1);

    const rows = [storedRow(1, failed), storedRow(2, follower as EventEnvelope), storedRow(3, other)].map(rowFromDb);
    const summary = await publishLockedRows(tx, runtime, rows);

    expect(summary).toStrictEqual({ published: 1, failed: 1, skipped: 1 });
    expect(publisher.published).toStrictEqual([{ topic: TOPIC, envelope: other }]);
    expect(statements).toEqual([stamped([other.eventId])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: 'outbox publish failed',
      eventId: failed.eventId,
      tenantId: TENANT_A.tenantId,
      error: { type: 'InjectedPublishError', message: REDACTED },
    });
  });

  it('flushAfterCommit after failNext(1) reports the failure and leaves the row unstamped until the next flush publishes it', async () => {
    const envelope = noteEnvelope();
    const { db, statements } = outboxDb([storedRow(1, envelope)]);
    const publisher = createCapturingPublisher();
    const runtime = createOutbox({ service: SERVICE, db, publisher, logger: capturingLogger(), clock: fixedClock(NOW) });
    publisher.failNext(1);

    await expect(flushAfterCommit(runtime, TENANT_A.tenantId, [envelope.eventId])).resolves.toStrictEqual({ published: 0, failed: 1, skipped: 0 });
    expect(publisher.published).toEqual([]);
    expect(statements.map((statement) => statement.sql.split(' ', 1)[0])).toEqual(['SELECT', 'SELECT', 'SELECT']);

    await expect(flushAfterCommit(runtime, TENANT_A.tenantId, [envelope.eventId])).resolves.toStrictEqual({ published: 1, failed: 0, skipped: 0 });
    expect(publisher.published).toStrictEqual([{ topic: TOPIC, envelope }]);
    expect(statements.slice(3)).toEqual([
      { sql: "SELECT set_config('lock_timeout', $1, true)", values: ['2000ms'] },
      { sql: expect.stringMatching(/^SELECT o\.\* /), values: [[envelope.eventId]] },
      { sql: expect.stringMatching(/^SELECT ordering_key, /), values: [[envelope.aggregateId], '1', ['1']] },
      stamped([envelope.eventId]),
    ]);
  });
});

/** A client of the emulator in the project of `resourceName` (`projects/<project>/…`), independent of the helpers' own clients. */
function observerFor(resourceName: string): PubSub {
  const [, projectId] = resourceName.split('/');
  return new PubSub({ projectId, apiEndpoint: process.env.PUBSUB_EMULATOR_HOST, emulatorMode: true });
}

/** An HTTP server on a free loopback port answering every request with `statusCode`. */
async function answering(statusCode: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const emulatorUp = await pubsubEmulatorAvailable();

describe('pubsubEmulatorAvailable', () => {
  it.each([undefined, ''])('is false when PUBSUB_EMULATOR_HOST is %j', async (host) => {
    vi.stubEnv('PUBSUB_EMULATOR_HOST', host);
    await expect(pubsubEmulatorAvailable()).resolves.toBe(false);
  });

  it('is false when nothing listens at PUBSUB_EMULATOR_HOST', async () => {
    vi.stubEnv('PUBSUB_EMULATOR_HOST', '127.0.0.1:9');
    await expect(pubsubEmulatorAvailable()).resolves.toBe(false);
  });

  it.each([[200, true], [503, false]])('reflects a host answering GET / with %i as %s', async (statusCode, available) => {
    const server = await answering(statusCode);
    try {
      vi.stubEnv('PUBSUB_EMULATOR_HOST', `127.0.0.1:${(server.address() as AddressInfo).port}`);
      await expect(pubsubEmulatorAvailable()).resolves.toBe(available);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.skipIf(!emulatorUp)('is true for the running emulator', async () => {
    await expect(pubsubEmulatorAvailable()).resolves.toBe(true);
  });
});

describe('emulator helpers without PUBSUB_EMULATOR_HOST', () => {
  it.each([
    ['createTestTopic', () => createTestTopic()],
    ['createTestSubscription', () => createTestSubscription({ name: TOPIC })],
    ['publishToEmulator', () => publishToEmulator(TOPIC, noteEnvelope())],
  ])('%s rejects before creating any Pub/Sub client', async (_name, call) => {
    vi.stubEnv('PUBSUB_EMULATOR_HOST', undefined);
    await expect(call()).rejects.toThrow(new Error(NOT_SET));
  });
});

describe.skipIf(!emulatorUp)('Pub/Sub emulator resources', () => {
  const owned: Array<{ delete(): Promise<void> }> = [];

  /** Registers `resource` for deletion after the test and returns it. */
  function own<T extends { delete(): Promise<void> }>(resource: T): T {
    owned.push(resource);
    return resource;
  }

  afterEach(async () => {
    for (const resource of owned.splice(0).reverse()) await resource.delete();
  });

  it('round-trips envelopes through a unique ordered topic and pull subscription, honouring max and timeout', async () => {
    const topic = own(await createTestTopic());
    const sibling = own(await createTestTopic());
    const subscription = own(await createTestSubscription(topic));

    expect(topic.name).toMatch(/^opt2-test\.run-[0-9a-f]{8}\.event\.v1$/);
    expect(sibling.name).not.toBe(topic.name);
    expect(topic.topic.name).toMatch(new RegExp(`^projects/[^/]+/topics/${topic.name.replaceAll('.', '\\.')}$`));
    expect(subscription.name).toMatch(new RegExp(`^opt2-test-[0-9a-f]{8}\\.${topic.name.replaceAll('.', '\\.')}$`));
    expect(subscription).not.toHaveProperty('dlqTopic');

    const make = (aggregateId: string): EventEnvelope<NotePayload> =>
      testEnvelope({ topic: topic.name, tenantId: TENANT_A.tenantId, aggregateId, payload: { noteId: aggregateId, text: 'emulated' } });
    const first = make('note-1');
    const [second] = versionedSequence(first, [2]);
    const tenantless = withoutTenant(second as EventEnvelope<NotePayload>);
    const third = make('note-2');
    for (const envelope of [first, tenantless, third]) {
      await expect(publishToEmulator(topic.name, envelope)).resolves.toMatch(/\S/);
    }

    const batch = await subscription.pull(2, 10_000);
    const rest = await subscription.pull(1, 10_000);
    const late = await subscription.pull(1, 500);

    expect(batch).toHaveLength(2);
    expect(late).toEqual([]);
    const received = [...batch, ...rest];
    const decoded = received.map((message) => decodeEnvelopeData(message.data) as { eventId: string });
    expect(decoded.filter((envelope) => envelope.eventId !== third.eventId)).toStrictEqual([first, tenantless]);
    expect(decoded.filter((envelope) => envelope.eventId === third.eventId)).toStrictEqual([third]);
    const byEvent = new Map(received.map((message, index) => [decoded[index]?.eventId, message]));
    expect(byEvent.get(first.eventId)).toMatchObject({ attributes: envelopeAttributes(first), orderingKey: 'note-1' });
    const { tenantId: _tenantId, ...tenantlessAttributes } = envelopeAttributes(second as EventEnvelope);
    expect(byEvent.get(tenantless.eventId)?.attributes).toStrictEqual(tenantlessAttributes);
    expect(byEvent.get(third.eventId)).toMatchObject({ attributes: envelopeAttributes(third), orderingKey: 'note-2' });
  });

  it('creates a push subscription with a dead-letter policy on its own .dlq topic, and delete removes both once', async () => {
    const topic = own(await createTestTopic('stub'));
    const subscription = await createTestSubscription(topic, {
      consumer: 'stub',
      pushEndpoint: 'http://127.0.0.1:9/never-called',
      deadLetter: { maxDeliveryAttempts: 5 },
      ackDeadlineSeconds: 15,
    });
    const observer = observerFor(subscription.subscription.name);
    try {
      expect(subscription.name).toMatch(/^stub-[0-9a-f]{8}\.stub\.run-[0-9a-f]{8}\.event\.v1$/);
      expect(subscription.dlqTopic?.name).toBe(dlqTopicName(subscription.name));
      const [metadata] = await observer.subscription(subscription.subscription.name).getMetadata();
      expect(metadata).toMatchObject({
        enableMessageOrdering: true,
        ackDeadlineSeconds: 15,
        pushConfig: { pushEndpoint: 'http://127.0.0.1:9/never-called' },
        deadLetterPolicy: { deadLetterTopic: subscription.dlqTopic?.topic.name, maxDeliveryAttempts: 5 },
      });

      const deletion = subscription.delete();
      expect(subscription.delete()).toBe(deletion);
      await deletion;

      const [subscriptionExists] = await observer.subscription(subscription.subscription.name).exists();
      const [dlqExists] = await observer.topic(subscription.dlqTopic?.topic.name ?? '').exists();
      const [topicExists] = await observer.topic(topic.topic.name).exists();
      expect([subscriptionExists, dlqExists, topicExists]).toEqual([false, false, true]);
    } finally {
      await observer.close();
    }
  });

  it('createTestSubscription on a missing topic rejects with NOT_FOUND and deletes the .dlq topic it made', async () => {
    const anchor: TestTopic = own(await createTestTopic('stub'));
    const missing = topicName('stub', `missing-${randomBytes(4).toString('hex')}`, 'event', 1);

    await expect(createTestSubscription({ name: missing }, { consumer: 'stub', deadLetter: { maxDeliveryAttempts: 5 } })).rejects.toMatchObject({ code: 5 });

    const observer = observerFor(anchor.topic.name);
    try {
      const [topics] = await observer.getTopics();
      expect(topics.map((topic) => topic.name).filter((name) => name.endsWith(`.${missing}.dlq`))).toEqual([]);
    } finally {
      await observer.close();
    }
  });

  it('TestTopic.delete tolerates a topic already deleted elsewhere and repeats as a no-op', async () => {
    const topic = await createTestTopic('stub');
    const observer = observerFor(topic.topic.name);
    try {
      await observer.topic(topic.topic.name).delete();

      await expect(topic.delete()).resolves.toBeUndefined();
      await expect(topic.delete()).resolves.toBeUndefined();
      const [exists] = await observer.topic(topic.topic.name).exists();
      expect(exists).toBe(false);
    } finally {
      await observer.close();
    }
  });
});
