/** People's push consumers: subscription names, registrations, and the site registry and group-name projection applied through the platform consumer. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileTopicSchema, consumeEnvelope, DeadLetterError, subscriptionName, type ConsumerDefinition, type EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { registeredTenants, tenantIdForSite, tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, registryPayloads, testEnvelope, type ThrowawaySchema } from '@opt2/platform/testing';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, groupNameConsumer, peopleConsumerRegistrations } from '../../src/events/consumers.js';
import { GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC, groupChangedSchema, siteChangedSchema, type GroupChangedPayload } from '../../src/events/topics.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';

const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

describe('people consumer registrations', () => {
  it('names each push subscription as the platform derives it', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('people', SITE_CHANGED_TOPIC));
    expect(GROUP_NAME_SUBSCRIPTION).toBe(subscriptionName('people', GROUP_CHANGED_TOPIC));
  });

  it('registers the site registry consumer first, then the group-name projection, each with its producer schema and kind', () => {
    const repository = createPeopleRepository();

    const registrations = peopleConsumerRegistrations(repository);

    expect(registrations.map(({ consumer, payloadSchema }) => [consumer.topic, payloadSchema])).toStrictEqual([
      [SITE_CHANGED_TOPIC, siteChangedSchema],
      [GROUP_CHANGED_TOPIC, groupChangedSchema],
    ]);
    expect(registrations[0]?.consumer).toBe(tenantRegistryConsumer);
    for (const { consumer, payloadSchema } of registrations) {
      expect(consumer.kind).toBe(compileTopicSchema(payloadSchema).meta.kind);
      expect(consumer.fanout).toBeUndefined();
    }
  });

  it('declares the group topic as full state without a fan-out, with a tenant re-check of its own', () => {
    const consumer = groupNameConsumer(createPeopleRepository());

    expect(consumer).toMatchObject({ topic: GROUP_CHANGED_TOPIC, kind: 'state' });
    expect(consumer.fanout).toBeUndefined();
    expect(consumer.checkTenant).toBeTypeOf('function');
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('people consumers against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;
  let groups: ConsumerDefinition<GroupChangedPayload>;
  let messages = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createPeopleRepository({ schema: handle.schema });
    groups = groupNameConsumer(repo);
    const site = registryPayloads()[0];
    if (site === undefined) throw new Error('no registry fixture');
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: site.siteId, payload: site });
    await consumeEnvelope(handle.app, tenantRegistryConsumer, envelope, delivery(SITE_CHANGED_SUBSCRIPTION));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function delivery(subscription: string): { subscription: string; messageId: string; logger: typeof logger } {
    messages += 1;
    return { subscription, messageId: String(messages), logger };
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenantId = TENANT_A.tenantId): Promise<T> {
    return handle.app.withTenant(tenantId, fn);
  }

  /** A contract-valid group state of `groupId` at `version`. */
  function groupEvent(groupId: string, version: number, overrides: Partial<GroupChangedPayload> = {}, tenantId = TENANT_A.tenantId): EventEnvelope<GroupChangedPayload> {
    const payload: GroupChangedPayload = {
      groupId,
      siteId: TENANT_A.siteId,
      groupName: 'Editors',
      type: 1,
      isPublic: 1,
      poolTenantId: tenantId,
      deleted: false,
      ...overrides,
    };
    expect(compileTopicSchema(groupChangedSchema).validatePayload(payload).ok).toBe(true);
    return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId, aggregateId: groupId, aggregateType: 'group', aggregateVersion: version, payload });
  }

  function consumeGroup(envelope: EventEnvelope<GroupChangedPayload>) {
    return consumeEnvelope(handle.app, groups, envelope, delivery(GROUP_NAME_SUBSCRIPTION));
  }

  it('registers the delivered site in the people tenant registry', async () => {
    expect(await registeredTenants(handle.app)).toContainEqual({ tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId });
  });

  it('projects each group state once, ignores duplicates and stale versions, and removes a deleted group', async () => {
    const groupId = cfUuid();
    const names = async (): Promise<Array<[string | null, number | null, boolean, string]>> =>
      (await inTenant((tx) => repo.listGroupNames(tx, [groupId]))).map((row) => [row.group_name, row.is_public, row.deleted, row.aggregate_version]);

    const first = groupEvent(groupId, 1);
    expect((await consumeGroup(first)).destinations).toStrictEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
    expect(await names()).toStrictEqual([['Editors', 1, false, '1']]);
    expect((await inTenant((tx) => repo.listGroupNames(tx, [groupId])))[0]?.site_id).toBe(TENANT_A.siteId);

    expect((await consumeGroup(first)).destinations).toStrictEqual([{ tenantId: TENANT_A.tenantId, result: 'duplicate' }]);

    expect((await consumeGroup(groupEvent(groupId, 3, { groupName: 'Writers', isPublic: 0 }))).destinations[0]?.result).toBe('applied');
    expect((await consumeGroup(groupEvent(groupId, 2, { groupName: 'Stale' }))).destinations[0]?.result).toBe('stale');
    expect(await names()).toStrictEqual([['Writers', 0, false, '3']]);

    expect((await consumeGroup(groupEvent(groupId, 4, { deleted: true }))).destinations[0]?.result).toBe('applied');
    expect(await names()).toStrictEqual([]);
  });

  it('applies the deletion of a group it never projected without writing a row', async () => {
    const groupId = cfUuid();

    expect((await consumeGroup(groupEvent(groupId, 1, { deleted: true, groupName: null, isPublic: null }))).destinations[0]?.result).toBe('applied');
    expect(await inTenant((tx) => repo.listGroupNames(tx, [groupId]))).toStrictEqual([]);
  });

  it('dead-letters a group state for a tenant the registry does not hold, writing nothing', async () => {
    const tenantId = tenantIdForSite('people-unregistered-site');
    const groupId = cfUuid();

    const failure = await consumeGroup(groupEvent(groupId, 1, {}, tenantId)).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason: 'invalid-tenant' });
    expect(await inTenant((tx) => repo.listGroupNames(tx, [groupId]), tenantId)).toStrictEqual([]);
  });

  const mismatches: Array<[string, Partial<GroupChangedPayload>, Partial<Pick<EventEnvelope, 'aggregateType' | 'aggregateId'>>]> = [
    ['a group state of pool B', { siteId: TENANT_B.siteId, poolTenantId: TENANT_B.tenantId }, {}],
    ['the pool tenant of B with the site of A', { poolTenantId: TENANT_B.tenantId }, {}],
    ['the site of B with the pool tenant of A', { siteId: TENANT_B.siteId }, {}],
    ['the site of A with a leading space', { siteId: ` ${TENANT_A.siteId}` }, {}],
    ['a group id other than the aggregate id', {}, { aggregateId: cfUuid() }],
    ['an aggregate type other than group', {}, { aggregateType: 'user' }],
  ];

  it.each(mismatches.flatMap(([label, payload, envelope]) => [false, true].map((deleted) => ({ label, payload, envelope, deleted }))))(
    'dead-letters $label under tenant A as a tenant mismatch (deleted: $deleted), keeping the projection and no inbox receipt',
    async ({ payload, envelope, deleted }) => {
      const groupId = cfUuid();
      const names = () => inTenant((tx) => repo.listGroupNames(tx, [groupId]));
      if (deleted) {
        expect((await consumeGroup(groupEvent(groupId, 1))).destinations[0]?.result).toBe('applied');
      }
      const before = await names();
      const event = { ...groupEvent(groupId, 2, { ...payload, deleted }), ...envelope };

      const failure = await consumeGroup(event).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DeadLetterError);
      expect(failure).toMatchObject({ reason: 'tenant-mismatch' });
      expect(before).toHaveLength(deleted ? 1 : 0);
      expect(await names()).toStrictEqual(before);
      const receipts = await inTenant(async (tx) => (await tx.query(`SELECT event_id FROM ${handle.schema}.inbox WHERE event_id = $1`, [event.eventId])).rows);
      expect(receipts).toStrictEqual([]);
    },
  );

  it.each([
    ['letter case', TENANT_A.siteId.toUpperCase()],
    ['trailing spaces', `${TENANT_A.siteId}  `],
  ])('applies a group state whose site id differs from the registered site only in %s', async (_case, siteId) => {
    const groupId = cfUuid();

    expect((await consumeGroup(groupEvent(groupId, 1, { siteId }))).destinations).toStrictEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
    expect((await inTenant((tx) => repo.listGroupNames(tx, [groupId])))[0]?.site_id).toBe(siteId);
  });
});
