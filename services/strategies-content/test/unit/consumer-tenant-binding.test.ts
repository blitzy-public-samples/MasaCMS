/** Tenant binding of the group, permission and membership projection consumers over a throwaway `content` schema, directly and through the push route. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeadLetterError, consumeEnvelope, registerConsumers, type ConsumerDefinition, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  contentConsumers,
  groupProjectionConsumer,
  membershipProjectionConsumer,
  permissionProjectionConsumer,
  type GroupChangedPayload,
  type MembershipChangedPayload,
  type PermissionChangedPayload,
} from '../../src/events/consumers.js';
import { OWNER, createContentRepository } from '../../src/repo/repository.js';

type Topic = 'group' | 'permission' | 'membership';
type Payload = GroupChangedPayload | PermissionChangedPayload | MembershipChangedPayload;
type Row = Record<string, unknown>;
type Owner = Pick<TenantFixture, 'siteId' | 'tenantId'>;

const TOPICS: Readonly<Record<Topic, { topic: string; subscription: string; aggregateType: string; table: string; idColumn: string }>> = {
  group: {
    topic: GROUP_CHANGED_TOPIC,
    subscription: GROUP_CHANGED_SUBSCRIPTION,
    aggregateType: 'group',
    table: 'group_projection',
    idColumn: 'group_id',
  },
  permission: {
    topic: PERMISSION_CHANGED_TOPIC,
    subscription: PERMISSION_CHANGED_SUBSCRIPTION,
    aggregateType: 'group',
    table: 'permission_projection',
    idColumn: 'group_id',
  },
  membership: {
    topic: MEMBERSHIP_CHANGED_TOPIC,
    subscription: MEMBERSHIP_CHANGED_SUBSCRIPTION,
    aggregateType: 'user',
    table: 'membership_projection',
    idColumn: 'user_id',
  },
};
const TOPIC_KEYS = Object.keys(TOPICS) as Topic[];

/** One of two distinguishable full states of an aggregate. */
type State = 1 | 2;

const LOGGER = createLogger({ service: OWNER, version: '1.0.0', env: 'local', level: 'silent' });
const UNREGISTERED: Owner = { siteId: 'content-unregistered-site', tenantId: tenantIdForSite('content-unregistered-site') };
const NODE_ID = '00000000000000000000000000000000001';
const STATE_GROUP: Readonly<Record<State, string>> = { 1: 'D0000000-0000-0000-0000000000000001', 2: 'D0000000-0000-0000-0000000000000002' };
const STATE_GRANT: Readonly<Record<State, string>> = { 1: 'Editor', 2: 'Read' };

/** How a payload departs from the one identity publishes for the aggregate's owner. */
interface PayloadVariant {
  state: State;
  siteId?: string;
  poolTenantId?: string;
  rowSiteId?: string;
}

/** How a mismatched delivery departs from the event identity would publish for an applied tenant-a aggregate. */
interface Mismatch extends Omit<PayloadVariant, 'state'> {
  wrongAggregateType?: boolean;
  /** The envelope names another applied aggregate than the payload. */
  otherAggregate?: boolean;
  lowerCaseAggregateId?: boolean;
}

let fixtureIds = 0;

/** The next 35-character CF UUID of a fixed sequence; its leading hex letter makes the lower-case spelling differ. */
function nextId(): string {
  fixtureIds += 1;
  return `C0000000-0000-0000-${String(fixtureIds).padStart(16, '0')}`;
}

function payloadFor(topic: Topic, id: string, owner: Owner, variant: PayloadVariant): Payload {
  const siteId = variant.siteId ?? owner.siteId;
  switch (topic) {
    case 'group':
      return { groupId: id, siteId, groupName: `state ${variant.state}`, type: 1, isPublic: 0, poolTenantId: variant.poolTenantId ?? owner.tenantId, deleted: false };
    case 'permission':
      return { groupId: id, siteId, rows: [{ contentId: NODE_ID, siteId: variant.rowSiteId ?? siteId, type: STATE_GRANT[variant.state] }] };
    case 'membership':
      return { userId: id, siteId, groupIds: [STATE_GROUP[variant.state]] };
  }
}

/** The projection row a legitimate state leaves for aggregate `id`. */
function expectedRow(topic: Topic, id: string, siteId: string, state: State): Row {
  switch (topic) {
    case 'group':
      return { group_id: id, site_id: siteId, group_name: `state ${state}`, is_public: 0, deleted: false };
    case 'permission':
      return { group_id: id, site_id: siteId, content_id: NODE_ID, type: STATE_GRANT[state] };
    case 'membership':
      return { user_id: id, site_id: siteId, group_id: STATE_GROUP[state] };
  }
}

/** Envelope fields a delivery sets; `aggregateType` defaults to the producer's. */
interface EnvelopeFields {
  tenantId: string;
  aggregateId: string;
  aggregateVersion: number;
  aggregateType?: string;
}

function envelopeFor(topic: Topic, payload: Payload, { aggregateType = TOPICS[topic].aggregateType, ...fields }: EnvelopeFields): EventEnvelope<Payload> {
  return testEnvelope({ topic: TOPICS[topic].topic, aggregateType, payload, ...fields });
}

const available = await pgAvailable();

describe.skipIf(!available)('content projection consumer tenant binding', () => {
  let handle: ThrowawaySchema;
  let consumers: Record<Topic, ConsumerDefinition<Payload>>;
  let stateDir: string | undefined;
  let app: FastifyInstance | undefined;
  const publisher = createCapturingPublisher();
  let messages = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: OWNER,
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app);
    const repository = createContentRepository({ schema: handle.schema });
    consumers = {
      group: groupProjectionConsumer(repository),
      permission: permissionProjectionConsumer(repository),
      membership: membershipProjectionConsumer(repository),
    };

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-consumers-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    app = await createService({
      name: OWNER,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: OWNER,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(OWNER),
      pool: db,
      logger: LOGGER,
    });
    registerConsumers(app, { service: OWNER, consumers: contentConsumers(repository), publisher, db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  function consume(topic: Topic, envelope: EventEnvelope<Payload>) {
    messages += 1;
    return consumeEnvelope(handle.app, consumers[topic], envelope, { subscription: TOPICS[topic].subscription, messageId: String(messages), logger: LOGGER });
  }

  /** Applies state 1 of tenant-a aggregate `id` as identity publishes it. */
  async function applyLegitimate(topic: Topic, id: string): Promise<void> {
    await consume(topic, envelopeFor(topic, payloadFor(topic, id, TENANT_A, { state: 1 }), { tenantId: TENANT_A.tenantId, aggregateId: id, aggregateVersion: 1 }));
  }

  function projection(topic: Topic, tenantId: string, ids: readonly string[]): Promise<Row[]> {
    const { table, idColumn } = TOPICS[topic];
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT * FROM ${handle.schema}.${table} WHERE ${idColumn} = ANY($1::text[]) ORDER BY ${idColumn}`, [ids]);
      return rows;
    });
  }

  /** The aggregates' projection rows under every seeded tenant, keyed by tenant id. */
  async function everywhere(topic: Topic, ids: readonly string[]): Promise<Record<string, Row[]>> {
    return Object.fromEntries(await Promise.all(TENANT_LIST.map(async ({ tenantId }) => [tenantId, await projection(topic, tenantId, ids)] as const)));
  }

  async function receipts(tenantId: string, eventId: string): Promise<number> {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.inbox WHERE event_id = $1`, [eventId]);
      return Number(rows[0]?.n);
    });
  }

  it.each(
    (
      [
        ['the site as registered', TENANT_A, TENANT_A.siteId],
        ['the site in another letter case', TENANT_A, 'TENANT-A'],
        ['the site with trailing spaces', TENANT_A, `${TENANT_A.siteId}  `],
        ['an umbrella-pool aggregate', TENANT_UMBRELLA, TENANT_UMBRELLA.siteId],
      ] satisfies Array<[string, TenantFixture, string]>
    ).flatMap(([label, owner, siteId]) => TOPIC_KEYS.map((topic): [Topic, string, TenantFixture, string] => [topic, label, owner, siteId])),
  )('applies a %s state bound to the envelope tenant and aggregate: %s', async (topic, _label, owner, siteId) => {
    const id = nextId();
    const envelope = envelopeFor(topic, payloadFor(topic, id, owner, { state: 1, siteId }), { tenantId: owner.tenantId, aggregateId: id, aggregateVersion: 1 });

    const outcome = await consume(topic, envelope);

    expect(outcome.destinations).toStrictEqual([{ tenantId: owner.tenantId, result: 'applied' }]);
    expect(await projection(topic, owner.tenantId, [id])).toMatchObject([expectedRow(topic, id, siteId, 1)]);
    expect(await receipts(owner.tenantId, envelope.eventId)).toBe(1);
  });

  const COMMON_MISMATCHES: Array<[string, Mismatch]> = [
    ['an aggregate type other than the producer one', { wrongAggregateType: true }],
    ['an envelope aggregate unrelated to the payload id', { otherAggregate: true }],
    ['the aggregate id in another letter case', { lowerCaseAggregateId: true }],
    ['a payload site of another registered tenant', { siteId: TENANT_B.siteId }],
    ['an unregistered payload site', { siteId: UNREGISTERED.siteId }],
    ['the payload site with a leading space', { siteId: ` ${TENANT_A.siteId}` }],
  ];
  const TOPIC_MISMATCHES: Record<Topic, Array<[string, Mismatch]>> = {
    group: [
      ['a pool tenant of another tenant', { poolTenantId: TENANT_B.tenantId }],
      ['the umbrella pool tenant for a tenant-a site', { poolTenantId: TENANT_UMBRELLA.tenantId }],
    ],
    permission: [['a row site other than the payload site', { rowSiteId: TENANT_B.siteId }]],
    membership: [],
  };

  it.each(
    TOPIC_KEYS.flatMap((topic) => [...COMMON_MISMATCHES, ...TOPIC_MISMATCHES[topic]].map(([label, mismatch]): [Topic, string, Mismatch] => [topic, label, mismatch])),
  )('dead-letters a %s state with %s as tenant-mismatch, leaving projections and inbox unchanged', async (topic, _label, mismatch) => {
    const id = nextId();
    const otherId = nextId();
    await applyLegitimate(topic, id);
    await applyLegitimate(topic, otherId);
    const before = await everywhere(topic, [id, otherId]);
    const { wrongAggregateType, otherAggregate, lowerCaseAggregateId, ...variant } = mismatch;
    const aggregateId = otherAggregate === true ? otherId : lowerCaseAggregateId === true ? id.toLowerCase() : id;
    const aggregateType = wrongAggregateType === true ? (TOPICS[topic].aggregateType === 'group' ? 'user' : 'group') : undefined;
    const envelope = envelopeFor(topic, payloadFor(topic, id, TENANT_A, { ...variant, state: 2 }), {
      tenantId: TENANT_A.tenantId,
      aggregateId,
      aggregateVersion: 2,
      aggregateType,
    });

    const failure = await consume(topic, envelope).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason: 'tenant-mismatch' });
    expect(before[TENANT_A.tenantId]).toMatchObject([expectedRow(topic, id, TENANT_A.siteId, 1), expectedRow(topic, otherId, TENANT_A.siteId, 1)]);
    expect(await everywhere(topic, [id, otherId])).toStrictEqual(before);
    expect(await receipts(TENANT_A.tenantId, envelope.eventId)).toBe(0);
  });

  it.each(TOPIC_KEYS)('dead-letters a %s state for an unregistered envelope tenant as invalid-tenant, writing nothing', async (topic) => {
    const id = nextId();
    const envelope = envelopeFor(topic, payloadFor(topic, id, UNREGISTERED, { state: 1 }), { tenantId: UNREGISTERED.tenantId, aggregateId: id, aggregateVersion: 1 });

    const failure = await consume(topic, envelope).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason: 'invalid-tenant' });
    expect(await projection(topic, UNREGISTERED.tenantId, [id])).toStrictEqual([]);
    expect(Object.values(await everywhere(topic, [id]))).toStrictEqual([[], [], []]);
    expect(await receipts(UNREGISTERED.tenantId, envelope.eventId)).toBe(0);
  });

  it.each(TOPIC_KEYS)('acks a bound %s push and dead-letters one naming another tenant site as tenant-mismatch through the push route', async (topic) => {
    const pushed = app;
    if (pushed === undefined) throw new Error('beforeAll built no app');
    const { subscription } = TOPICS[topic];
    publisher.clear();
    const id = nextId();
    const bound = envelopeFor(topic, payloadFor(topic, id, TENANT_A, { state: 1 }), { tenantId: TENANT_A.tenantId, aggregateId: id, aggregateVersion: 1 });

    const applied = await pushTo(pushed, subscription, bound);

    expect(applied.statusCode).toBe(204);
    expect(publisher.deadLetters(subscription)).toStrictEqual([]);
    const before = await everywhere(topic, [id]);
    expect(before[TENANT_A.tenantId]).toMatchObject([expectedRow(topic, id, TENANT_A.siteId, 1)]);

    const mismatched = envelopeFor(topic, payloadFor(topic, id, TENANT_A, { state: 2, siteId: TENANT_B.siteId }), {
      tenantId: TENANT_A.tenantId,
      aggregateId: id,
      aggregateVersion: 2,
    });
    const rejected = await pushTo(pushed, subscription, mismatched);

    expect(rejected.statusCode).toBe(204);
    expect(publisher.deadLetters(subscription)).toMatchObject([{ reason: 'tenant-mismatch' }]);
    expect(await everywhere(topic, [id])).toStrictEqual(before);
    expect(await receipts(TENANT_A.tenantId, mismatched.eventId)).toBe(0);
  });
});
