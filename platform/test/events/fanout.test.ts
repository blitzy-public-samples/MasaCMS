import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumeEnvelope,
  createPublisher,
  destinationTenants,
  eventsSql,
  registerPushSubscription,
  type ConsumerDefinition,
  type EventEnvelope,
  type EventPublisher,
} from '../../src/events/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import { outboxSql } from '../../src/outbox/index.js';
import { createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import {
  registryEntryForTenant,
  rlsSql,
  tenantRegistrySql,
  userPoolFanoutTenants,
  withTenant,
} from '../../src/tenancy/index.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
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
  type TestSubscription,
  type TestTopic,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
const REQUIRED_ENV = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE', 'PUBSUB_EMULATOR_HOST'] as const;
const FIXTURES = [TENANT_A, TENANT_B, TENANT_UMBRELLA] as const;
const UMBRELLA_AND_A = [TENANT_UMBRELLA.tenantId, TENANT_A.tenantId].sort();

interface ArchivedPayload {
  personId: string;
  destinationTenantId?: string;
}

interface AppliedEffect {
  eventId: string;
  tenantId: string;
  isFanout: boolean;
}

const PAYLOAD_SCHEMA = {
  'x-opt2-kind': 'process',
  'x-opt2-tenant-fanout': 'userPool',
  type: 'object',
  required: ['personId'],
  additionalProperties: false,
  properties: {
    personId: { type: 'string', minLength: 1 },
    destinationTenantId: { type: 'string', format: 'uuid' },
  },
};

/** DDL of the tenant-owned effect table the test consumer writes. */
function effectSql(schema: string): string {
  return [
    `CREATE TABLE ${schema}.test_effect (`,
    '  tenant_id uuid NOT NULL,',
    '  event_id uuid,',
    '  aggregate_id text,',
    '  value text',
    ');',
    rlsSql(schema, 'test_effect'),
  ].join('\n');
}

describe('userPool fan-out against PostgreSQL and the Pub/Sub emulator', () => {
  const applied: AppliedEffect[] = [];
  let failFor: string | undefined;
  let handle: ThrowawaySchema;
  let topic: TestTopic;
  let subscription: TestSubscription;
  let publisher: EventPublisher;
  let app: FastifyInstance;
  let fanoutConsumer: ConsumerDefinition<ArchivedPayload>;

  /** A `process` consumer of the test topic writing one effect row per destination; it throws in the `failFor` tenant. */
  function consumerOf(fanout: boolean): ConsumerDefinition<ArchivedPayload> {
    return {
      topic: topic.name,
      kind: 'process',
      ...(fanout ? { fanout: 'userPool' as const } : {}),
      async apply(tx, envelope, ctx) {
        if (ctx.destinationTenantId === failFor) {
          throw new Error(`injected failure in destination ${ctx.destinationTenantId}`);
        }
        await tx.query(
          `INSERT INTO ${tx.schema}.test_effect (tenant_id, event_id, aggregate_id, value) VALUES ($1, $2, $3, $4)`,
          [tx.tenantId, envelope.eventId, envelope.aggregateId, envelope.payload.personId],
        );
        applied.push({ eventId: envelope.eventId, tenantId: ctx.destinationTenantId, isFanout: ctx.isFanout });
      },
    };
  }

  /** A fresh archive envelope of `tenantId` on the test topic. */
  function archived(tenantId: string, extra: Partial<ArchivedPayload> = {}): EventEnvelope<ArchivedPayload> {
    const personId = `person-${randomUUID()}`;
    return testEnvelope({ topic: topic.name, tenantId, aggregateType: 'person', aggregateId: personId, payload: { personId, ...extra } });
  }

  /** Tenant of every `table` row holding `eventId`, read under each fixture tenant, sorted. */
  async function rowTenants(table: 'inbox' | 'test_effect', eventId: string): Promise<string[]> {
    const tenants: string[] = [];
    for (const fixture of FIXTURES) {
      const rows = await withTenant(handle.app, fixture.tenantId, async (tx) => {
        const result = await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${tx.schema}.${table} WHERE event_id = $1`, [eventId]);
        return result.rows;
      });
      tenants.push(...rows.map((row) => row.tenant_id));
    }
    return tenants.sort();
  }

  /** Tenants holding an effect of `eventId`, one entry per effect row. */
  function effectTenants(eventId: string): Promise<string[]> {
    return rowTenants('test_effect', eventId);
  }

  /** Tenants holding an inbox receipt of `eventId`. */
  function receiptTenants(eventId: string): Promise<string[]> {
    return rowTenants('inbox', eventId);
  }

  /** Destinations that applied `eventId`, in apply order. */
  function appliedFor(eventId: string): Array<Omit<AppliedEffect, 'eventId'>> {
    return applied.filter((effect) => effect.eventId === eventId).map(({ tenantId, isFanout }) => ({ tenantId, isFanout }));
  }

  beforeAll(async () => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`The fan-out suite needs ${missing.join(', ')} in the environment`);
    }
    if (!(await pgAvailable())) {
      throw new Error('The fan-out suite cannot reach PostgreSQL at PG_HOST and PG_PORT');
    }
    if (!(await pubsubEmulatorAvailable())) {
      throw new Error('The fan-out suite cannot reach the Pub/Sub emulator at PUBSUB_EMULATOR_HOST');
    }

    handle = await createThrowawaySchema({
      service: SERVICE,
      extraSql: [
        outboxSql(SERVICE),
        eventsSql(SERVICE),
        tenantRegistrySql(SERVICE),
        migrationKitSql(SERVICE),
        scheduledTaskQueueSql(SERVICE),
        effectSql(SERVICE),
      ],
    });
    await seedRegistry(handle.app, handle.schema);
    await expect(registryEntryForTenant(handle.app, TENANT_A.tenantId)).resolves.toMatchObject({
      publicUserPoolTenant: TENANT_UMBRELLA.tenantId,
      privateUserPoolTenant: TENANT_A.tenantId,
    });
    await expect(registryEntryForTenant(handle.app, TENANT_B.tenantId)).resolves.toMatchObject({
      publicUserPoolTenant: TENANT_B.tenantId,
      privateUserPoolTenant: TENANT_B.tenantId,
    });

    topic = await createTestTopic(SERVICE);
    subscription = await createTestSubscription(topic, { consumer: SERVICE });
    publisher = createPublisher({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local',
      emulatorHost: process.env.PUBSUB_EMULATOR_HOST,
    });
    fanoutConsumer = consumerOf(true);

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
        OPT2_STATE_DIR: join(tmpdir(), 'opt2-fanout-unused'),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
    });
    registerPushSubscription(app, {
      subscription: subscription.name,
      consumer: fanoutConsumer,
      payloadSchema: PAYLOAD_SCHEMA,
      publisher,
      db: handle.app,
    });
  });

  afterAll(async () => {
    await app?.close();
    await publisher?.close();
    await subscription?.delete();
    await topic?.delete();
    await handle?.drop();
  });

  it('resolves user-pool fan-out tenants from the registry', async () => {
    const members = await userPoolFanoutTenants(handle.app, TENANT_UMBRELLA.tenantId);

    expect(members).toContain(TENANT_A.tenantId);
    expect(members).not.toContain(TENANT_B.tenantId);
    await expect(userPoolFanoutTenants(handle.app, TENANT_B.tenantId)).resolves.toEqual([TENANT_B.tenantId]);
  });

  it.each([
    { source: TENANT_UMBRELLA, expected: [TENANT_UMBRELLA.tenantId, TENANT_A.tenantId] },
    { source: TENANT_A, expected: [TENANT_A.tenantId] },
    { source: TENANT_B, expected: [TENANT_B.tenantId] },
  ])('derives the destinations of a $source.siteId event from the registry, envelope tenant first', async ({ source, expected }) => {
    await expect(destinationTenants(handle.app, fanoutConsumer, archived(source.tenantId))).resolves.toEqual(expected);
  });

  it('applies an umbrella event in umbrella and tenant-a only', async () => {
    const envelope = archived(TENANT_UMBRELLA.tenantId);

    const response = await pushTo(app, subscription.name, envelope);

    expect(response.statusCode).toBe(204);
    expect(await effectTenants(envelope.eventId)).toEqual(UMBRELLA_AND_A);
    expect(await receiptTenants(envelope.eventId)).toEqual(UMBRELLA_AND_A);
    expect(appliedFor(envelope.eventId)).toEqual([
      { tenantId: TENANT_UMBRELLA.tenantId, isFanout: false },
      { tenantId: TENANT_A.tenantId, isFanout: true },
    ]);
  });

  it('ignores a destination named in the payload', async () => {
    const envelope = archived(TENANT_UMBRELLA.tenantId, { destinationTenantId: TENANT_B.tenantId });

    const response = await pushTo(app, subscription.name, envelope);

    expect(response.statusCode).toBe(204);
    expect(await effectTenants(envelope.eventId)).toEqual(UMBRELLA_AND_A);
    expect(await receiptTenants(envelope.eventId)).toEqual(UMBRELLA_AND_A);
  });

  it('applies an interrupted fan-out only where no receipt exists', async () => {
    const envelope = archived(TENANT_UMBRELLA.tenantId);
    const destinations = await destinationTenants(handle.app, fanoutConsumer, envelope);
    expect(destinations).toHaveLength(2);
    const [first, second] = destinations as [string, string];

    failFor = second;
    try {
      expect(isAck(await pushTo(app, subscription.name, envelope))).toBe(false);
    } finally {
      failFor = undefined;
    }
    expect(await effectTenants(envelope.eventId)).toEqual([first]);
    expect(await receiptTenants(envelope.eventId)).toEqual([first]);

    const redelivered = await pushTo(app, subscription.name, envelope);

    expect(redelivered.statusCode).toBe(204);
    expect(appliedFor(envelope.eventId).map((effect) => effect.tenantId)).toEqual([first, second]);
    expect(await effectTenants(envelope.eventId)).toEqual([first, second].sort());
    expect(await receiptTenants(envelope.eventId)).toEqual([first, second].sort());
  });

  it('does not fan out without the declaration', async () => {
    const envelope = archived(TENANT_UMBRELLA.tenantId);

    const outcome = await consumeEnvelope(handle.app, consumerOf(false), envelope, {
      subscription: subscription.name,
      messageId: randomUUID(),
      logger: app.opt2.logger,
    });

    expect(outcome).toEqual({ eventId: envelope.eventId, destinations: [{ tenantId: TENANT_UMBRELLA.tenantId, result: 'applied' }] });
    expect(await effectTenants(envelope.eventId)).toEqual([TENANT_UMBRELLA.tenantId]);
  });
});
