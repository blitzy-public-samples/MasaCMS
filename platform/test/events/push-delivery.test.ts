import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Subscription } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_USER_TOKEN } from '../../src/auth/index.js';
import {
  buildPushBody,
  createPublisher,
  encodeEnvelope,
  envelopeAttributes,
  eventsSql,
  pushPath,
  registerPushSubscription,
  subscriptionName,
  type ConsumerDefinition,
  type EventEnvelope,
  type EventPublisher,
  type PushBody,
} from '../../src/events/index.js';
import { createLogger } from '../../src/logging/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { rlsSql, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TEST_PUSH_KEY,
  createTestTopic,
  createThrowawaySchema,
  isAck,
  mintUserToken,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushKeyQuery,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
// The emulator helpers create topics in this project, so the publisher must address the same one.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';
const WAIT_MS = 10_000;

interface EffectPayload {
  value: string;
}

const PAYLOAD_SCHEMA = {
  'x-opt2-kind': 'process',
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: { type: 'string' } },
};

const EFFECT_SQL = [
  'CREATE TABLE stub.test_effect (',
  '  tenant_id uuid NOT NULL,',
  '  event_id uuid,',
  '  value text',
  ');',
  rlsSql('stub', 'test_effect'),
].join('\n');

/** One response of the push route, with the delivery's Pub/Sub message id when the body carried one. */
interface PushResponse {
  url: string;
  statusCode: number;
  messageId?: string;
}

/** Throws naming every missing variable or unreachable server the suite needs. */
async function requireBackends(): Promise<void> {
  const problems: string[] = [];
  try {
    if (!(await pgAvailable())) problems.push(`PostgreSQL at ${process.env.PG_HOST}:${process.env.PG_PORT ?? 5432} is unreachable`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const emulator = process.env.PUBSUB_EMULATOR_HOST;
  if (!emulator) problems.push('PUBSUB_EMULATOR_HOST is not set');
  else if (!(await pubsubEmulatorAvailable())) problems.push(`the Pub/Sub emulator at ${emulator} is unreachable`);
  if (problems.length > 0) {
    throw new Error(`Push delivery tests need PostgreSQL 16 and the Pub/Sub emulator: ${problems.join('; ')}`);
  }
}

/** Polls `predicate` every 100 ms until it holds; throws after `deadlineMs`. */
async function waitFor(predicate: () => boolean | Promise<boolean>, deadlineMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${deadlineMs} ms`);
    await sleep(100);
  }
}

describe('push delivery from the Pub/Sub emulator', () => {
  let handle: ThrowawaySchema | undefined;
  let topic: TestTopic | undefined;
  let pushSubscription: Subscription | undefined;
  let publisher: EventPublisher | undefined;
  let app: FastifyInstance | undefined;
  let subscription = '';
  const responses: PushResponse[] = [];
  const attempts: string[] = [];
  let failuresLeft = 0;

  /** The handles beforeAll created; throws when setup did not finish. */
  function ready(): { handle: ThrowawaySchema; topic: TestTopic; publisher: EventPublisher; app: FastifyInstance } {
    if (handle === undefined || topic === undefined || publisher === undefined || app === undefined) {
      throw new Error('push delivery setup did not complete');
    }
    return { handle, topic, publisher, app };
  }

  /** A tenant-A envelope on the test topic with a fresh aggregate. */
  function newEnvelope(value: string): EventEnvelope<EffectPayload> {
    return testEnvelope({ topic: ready().topic.name, tenantId: TENANT_A.tenantId, aggregateId: randomUUID(), payload: { value } });
  }

  /** The push body the emulator would send for `envelope`. */
  function pushBodyOf(envelope: EventEnvelope<EffectPayload>): PushBody {
    return buildPushBody({
      data: encodeEnvelope(envelope),
      attributes: envelopeAttributes(envelope),
      messageId: randomUUID(),
      subscription,
      project: PROJECT,
      orderingKey: envelope.aggregateId,
    });
  }

  /** Effect values stored for `eventId`, read in tenant A. */
  function effectValues(eventId: string): Promise<Array<string | null>> {
    return withTenant(ready().handle.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ value: string | null }>(
        `SELECT value FROM ${tx.schema}.test_effect WHERE event_id = $1`,
        [eventId],
      );
      return rows.map((row) => row.value);
    });
  }

  /** Inbox receipts of `eventId` in tenant A. */
  function inboxCount(eventId: string): Promise<number> {
    return withTenant(ready().handle.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM ${tx.schema}.inbox WHERE event_id = $1`,
        [eventId],
      );
      return Number(rows[0]?.count);
    });
  }

  /** Recorded push responses of the delivery with Pub/Sub message id `messageId`, in arrival order. */
  function deliveriesOf(messageId: string): PushResponse[] {
    return responses.filter((response) => response.messageId === messageId);
  }

  /** How often `apply` ran for `eventId`. */
  function attemptsOf(eventId: string): number {
    return attempts.filter((id) => id === eventId).length;
  }

  beforeAll(async () => {
    await requireBackends();
    handle = await createThrowawaySchema({
      service: SERVICE,
      extraSql: [
        outboxSql(SERVICE),
        eventsSql(SERVICE),
        tenantRegistrySql(SERVICE),
        migrationKitSql(SERVICE),
        scheduledTaskQueueSql(SERVICE),
        EFFECT_SQL,
      ],
    });
    await seedRegistry(handle.app, handle.schema);

    topic = await createTestTopic(SERVICE);
    subscription = subscriptionName(SERVICE, topic.name);
    publisher = createPublisher({ projectId: PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST });

    const consumer: ConsumerDefinition<EffectPayload> = {
      topic: topic.name,
      kind: 'process',
      async apply(tx, envelope) {
        attempts.push(envelope.eventId);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('injected apply failure');
        }
        await tx.query(`INSERT INTO ${tx.schema}.test_effect (tenant_id, event_id, value) VALUES ($1, $2, $3)`, [
          tx.tenantId,
          envelope.eventId,
          envelope.payload.value,
        ]);
      },
    };

    app = await createService({
      name: SERVICE,
      version: 'test',
      env: loadEnv(undefined, {
        PORT: '8199',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
        OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
        OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-push-delivery-unused'),
        TZ: 'UTC',
      }),
      // The callee form supplies every key-backed auth piece, so no secret files under OPT2_STATE_DIR are read.
      verifierOverride: testVerifier(SERVICE),
      logger: createLogger({ service: SERVICE, version: 'test', env: 'local', destination: { write: () => undefined } }),
    });
    const route = pushPath(subscription);
    app.addHook('onResponse', async (request, reply) => {
      if (request.url.split('?', 1)[0] !== route) return;
      const messageId = (request.body as Partial<PushBody> | undefined)?.message?.messageId;
      responses.push({ url: request.url, statusCode: reply.statusCode, ...(messageId === undefined ? {} : { messageId }) });
    });
    registerPushSubscription(app, { subscription, topic: topic.name, consumer, payloadSchema: PAYLOAD_SCHEMA, publisher, db: handle.app });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    // Created directly: createTestSubscription takes no retry policy and suffixes the name the route is mounted under.
    [pushSubscription] = await topic.topic.createSubscription(subscription, {
      enableMessageOrdering: true,
      pushConfig: { pushEndpoint: `http://127.0.0.1:${port}${route}?${pushKeyQuery(TEST_PUSH_KEY)}` },
      retryPolicy: { minimumBackoff: { seconds: 1 }, maximumBackoff: { seconds: 2 } },
    });
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    // Each step runs even when an earlier one fails, so no subscription, topic, listener or schema outlives the suite.
    for (const step of [
      () => pushSubscription?.delete(),
      () => topic?.delete(),
      () => app?.close(),
      () => publisher?.close(),
      () => handle?.drop(),
    ]) {
      try {
        await step();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'push delivery teardown failed');
  });

  it('delivers a published event by push with the push key and acks it with 204 after applying it once', async () => {
    const envelope = newEnvelope('delivered');
    const messageId = await ready().publisher.publish(ready().topic.name, envelope);

    await waitFor(() => deliveriesOf(messageId).some((response) => response.statusCode === 204));
    const [delivery] = deliveriesOf(messageId);
    expect(new URL(delivery?.url ?? '', 'http://127.0.0.1').searchParams.get('key')).toBe(TEST_PUSH_KEY);
    expect(deliveriesOf(messageId).map((response) => response.statusCode)).toContain(204);
    expect(await effectValues(envelope.eventId)).toEqual(['delivered']);
    expect(attemptsOf(envelope.eventId)).toBe(1);
    expect(await inboxCount(envelope.eventId)).toBe(1);
  });

  it('rejects a delivery with a wrong or missing push key with 401 before the route runs', async () => {
    const { app: service } = ready();
    const envelope = newEnvelope('wrong-key');

    const wrong = await pushTo(service, subscription, envelope, { key: 'wrong' });
    const missing = await service.inject({ method: 'POST', url: pushPath(subscription), payload: pushBodyOf(envelope) });

    expect([wrong.statusCode, missing.statusCode]).toEqual([401, 401]);
    expect(attemptsOf(envelope.eventId)).toBe(0);
    expect(await effectValues(envelope.eventId)).toEqual([]);
    expect(await inboxCount(envelope.eventId)).toBe(0);
  });

  it('refuses a user token on the push route with 401 whether the push key is absent, wrong or right', async () => {
    const { app: service } = ready();
    const envelope = newEnvelope('user-token');
    const token = await mintUserToken({ sub: 'push-delivery-user', tid: TENANT_A.tenantId, roles: ['s2'] });
    const route = pushPath(subscription);

    const statuses: number[] = [];
    for (const url of [route, `${route}?${pushKeyQuery('wrong')}`, `${route}?${pushKeyQuery(TEST_PUSH_KEY)}`]) {
      const response = await service.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: pushBodyOf(envelope),
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([401, 401, 401]);
    expect(attemptsOf(envelope.eventId)).toBe(0);
    expect(await effectValues(envelope.eventId)).toEqual([]);
    expect(await inboxCount(envelope.eventId)).toBe(0);
  });

  it('redelivers a delivery nacked by a processing failure and applies it exactly once', async () => {
    const envelope = newEnvelope('redelivered');
    failuresLeft = 1;
    const messageId = await ready().publisher.publish(ready().topic.name, envelope);

    await waitFor(() => deliveriesOf(messageId).some((response) => response.statusCode === 204));
    const deliveries = deliveriesOf(messageId);
    const acked = deliveries.findIndex((response) => response.statusCode === 204);
    expect(acked).toBeGreaterThanOrEqual(1);
    expect(deliveries.slice(0, acked).every((response) => !isAck(response))).toBe(true);
    expect(attemptsOf(envelope.eventId)).toBe(acked + 1);
    expect(await effectValues(envelope.eventId)).toEqual(['redelivered']);
    expect(await inboxCount(envelope.eventId)).toBe(1);
  });
});
