/** People's push consumers: subscription names, registrations, and the site registry and group-name projection applied through the platform consumer. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileTopicSchema, consumeEnvelope, DeadLetterError, subscriptionName, type ConsumerDefinition, type EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { registeredTenants, tenantIdForSite, tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, registryPayloads, testEnvelope, type ThrowawaySchema } from '@opt2/platform/testing';
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

  it('declares the group topic as full state without a fan-out or tenant re-check of its own', () => {
    const consumer = groupNameConsumer(createPeopleRepository());

    expect(consumer).toMatchObject({ topic: GROUP_CHANGED_TOPIC, kind: 'state' });
    expect(consumer.fanout).toBeUndefined();
    expect(consumer.checkTenant).toBeUndefined();
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
});
