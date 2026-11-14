/** Consumer contracts of people: the producer payload schemas its two push consumers read, and the push routes they arrive on. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  PUSH_PATH_PREFIX,
  compileTopicSchema,
  pushPath,
  readTopicSchema,
  subscriptionName,
  topicMeta,
  topicOfSubscription,
  type ConsumeContext,
} from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
  type JsonType,
} from '@opt2/platform/testing';
import {
  GROUP_NAME_SUBSCRIPTION,
  SITE_CHANGED_SUBSCRIPTION,
  groupNameConsumer,
  peopleConsumerRegistrations,
} from '../../src/events/consumers.js';
import { GROUP_CHANGED_TOPIC, groupChangedSchema, siteChangedSchema, type GroupChangedPayload } from '../../src/events/topics.js';
import { createPeopleRepository, type GroupNameInput, type PeopleRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK } from '../helpers/app.js';

type Json = Record<string, unknown>;

const SERVICE = 'people';

const groupSchema = readTopicSchema(new URL('../../../identity/contracts/events/identity.group.changed.v1.json', import.meta.url));
const siteSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);
const CONTRACT = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

const GROUP_ID = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const UMBRELLA_GROUP_ID = 'B2C3D4E5-0002-4B6C-9D8E0F1A2B3C4D5E';

const LIVE_GROUP: GroupChangedPayload = {
  groupId: GROUP_ID,
  siteId: TENANT_A.siteId,
  groupName: 'Roster Editors',
  type: 1,
  isPublic: 0,
  poolTenantId: TENANT_A.tenantId,
  deleted: false,
};

const DELETED_GROUP: GroupChangedPayload = {
  groupId: UMBRELLA_GROUP_ID,
  siteId: TENANT_UMBRELLA.siteId,
  groupName: null,
  type: 1,
  isPublic: 1,
  poolTenantId: TENANT_UMBRELLA.tenantId,
  deleted: true,
};

// `required` is the full read set of the tenant re-check and apply, which the probes below pin.
// The compatibility walk cannot type `groupName` (anyOf), `isPublic` (enum) or `poolTenantId` (envelope $ref); their values are checked below.
const GROUP_READS = {
  required: ['groupId', 'siteId', 'groupName', 'isPublic', 'poolTenantId', 'deleted'],
  types: { groupId: 'string', siteId: 'string', deleted: 'boolean' },
  kind: 'state',
  samples: [LIVE_GROUP, DELETED_GROUP],
} satisfies ConsumerExpectation;

const SITE_FIELDS: Record<keyof SiteChangedPayload, true> = {
  siteId: true,
  publicUserPoolId: true,
  privateUserPoolId: true,
  categoryPoolId: true,
  filePoolId: true,
  displayPoolId: true,
  contentPoolIds: true,
  domains: true,
};

const SITE_TYPES = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} satisfies Record<keyof SiteChangedPayload, JsonType>;

const SITE_SAMPLES = registryPayloads().filter((payload) => [TENANT_A.siteId, TENANT_UMBRELLA.siteId].includes(payload.siteId));

const SITE_READS = {
  required: Object.keys(SITE_FIELDS),
  types: SITE_TYPES,
  itemTypes: { contentPoolIds: 'string', domains: 'string' },
  kind: 'state',
  samples: SITE_SAMPLES,
} satisfies ConsumerExpectation;

/** The `required` list at a producer schema's root. */
function requiredOf(schema: object): string[] {
  return [...((schema as Json).required as string[])];
}

/** `target` behind a proxy that adds the name of every property read from it to `reads`. */
function recording<T extends object>(target: T, reads: Set<string>): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string') reads.add(property);
      return Reflect.get(object, property, receiver);
    },
  });
}

/** One projection call the consumer made, with the tenant of the transaction it ran in. */
interface ProjectionCall {
  method: 'upsertGroupName' | 'deleteGroupName';
  tenantId: string;
  argument: GroupNameInput | string;
}

/** A repository that only records the group-name projection calls. */
function recordingRepository(calls: ProjectionCall[]): PeopleRepository {
  const repository = {
    async upsertGroupName(tx: TenantTx, row: GroupNameInput) {
      calls.push({ method: 'upsertGroupName', tenantId: tx.tenantId, argument: row });
      return row;
    },
    async deleteGroupName(tx: TenantTx, groupId: string) {
      calls.push({ method: 'deleteGroupName', tenantId: tx.tenantId, argument: groupId });
      return true;
    },
  };
  return repository as unknown as PeopleRepository;
}

/** A tenant transaction whose every query answers the registry lookup of `siteId` in `tenantId`. */
function stubTx(tenantId: string, siteId: string): TenantTx {
  const tx = {
    kind: 'tenant',
    tenantId,
    schema: SERVICE,
    query: async () => ({ rows: [{ site_id: siteId, tenant_id: tenantId }], rowCount: 1 }),
    onCommit: () => undefined,
  };
  return tx as unknown as TenantTx;
}

/** Re-checks and applies `payload` in its pool tenant, recording the payload fields and context fields the consumer reads. */
async function probeGroupConsumer(payload: GroupChangedPayload) {
  const reads = new Set<string>();
  const contextReads = new Set<string>();
  const calls: ProjectionCall[] = [];
  const consumer = groupNameConsumer(recordingRepository(calls));
  const envelope = testEnvelope({
    topic: GROUP_CHANGED_TOPIC,
    tenantId: payload.poolTenantId,
    aggregateId: payload.groupId,
    aggregateVersion: 1,
    payload: recording(payload, reads),
  });
  const tx = stubTx(payload.poolTenantId, payload.siteId);
  const context = { subscription: GROUP_NAME_SUBSCRIPTION, messageId: '1', destinationTenantId: payload.poolTenantId, isFanout: false };
  const verdict = await consumer.checkTenant?.(tx, envelope);
  await consumer.apply(tx, envelope, recording(context, contextReads) as ConsumeContext);
  return { verdict, reads, contextReads, calls };
}

const PROBES = [
  {
    label: 'live',
    payload: LIVE_GROUP,
    calls: [
      {
        method: 'upsertGroupName',
        tenantId: TENANT_A.tenantId,
        argument: { group_id: GROUP_ID, site_id: TENANT_A.siteId, group_name: 'Roster Editors', is_public: 0, deleted: false, aggregate_version: 1 },
      },
    ],
  },
  {
    label: 'deleted',
    payload: DELETED_GROUP,
    calls: [{ method: 'deleteGroupName', tenantId: TENANT_UMBRELLA.tenantId, argument: UMBRELLA_GROUP_ID }],
  },
] as const satisfies ReadonlyArray<{ label: string; payload: GroupChangedPayload; calls: readonly ProjectionCall[] }>;

/** The ContractAssertionError `run` throws; fails the test when it throws nothing or something else. */
function contractErrorOf(run: () => unknown): ContractAssertionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractAssertionError);
    return error as ContractAssertionError;
  }
  throw new Error('expected a ContractAssertionError, but nothing was thrown');
}

/** The path, method and operation object of `operationId` in people's contract. */
function operationById(operationId: string): { path: string; method: string; operation: Json } {
  for (const [path, item] of Object.entries(CONTRACT.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (typeof operation === 'object' && operation !== null && (operation as Json).operationId === operationId) {
        return { path, method, operation: operation as Json };
      }
    }
  }
  throw new TypeError(`people's contract has no operation ${operationId}`);
}

describe('identity.group.changed.v1 consumed into the group-name projection', () => {
  it("validates deliveries against identity's own payload schema", () => {
    expect(groupChangedSchema).toEqual(groupSchema);
  });

  it('is full state on both sides, and the producer provides every field of the types the consumer reads', () => {
    const consumer = groupNameConsumer(createPeopleRepository({ clock: TEST_CLOCK }));
    expect(consumer.topic).toBe(GROUP_CHANGED_TOPIC);
    expect(consumer.kind).toBe('state');
    expect(topicMeta(groupSchema).kind).toBe('state');
    expect(() => assertProducerConsumerCompatible(groupSchema, GROUP_READS)).not.toThrow();
  });

  it.each([
    { field: 'groupName', value: 'Roster Editors', accepted: true },
    { field: 'groupName', value: null, accepted: true },
    { field: 'groupName', value: 42, accepted: false },
    { field: 'isPublic', value: 0, accepted: true },
    { field: 'isPublic', value: 1, accepted: true },
    { field: 'isPublic', value: null, accepted: true },
    { field: 'isPublic', value: 2, accepted: false },
    { field: 'isPublic', value: true, accepted: false },
    { field: 'poolTenantId', value: TENANT_A.tenantId, accepted: true },
    { field: 'poolTenantId', value: GROUP_ID, accepted: false },
    { field: 'poolTenantId', value: null, accepted: false },
  ])('the producer schema accepts $field = $value: $accepted', ({ field, value, accepted }) => {
    expect(compileTopicSchema(groupSchema).validatePayload({ ...LIVE_GROUP, [field]: value }).ok).toBe(accepted);
  });

  it.each(PROBES)('re-checks and projects a $label group reading only fields the producer requires', async ({ payload, calls }) => {
    const probe = await probeGroupConsumer(payload);
    const producerRequired = requiredOf(groupSchema);
    expect(probe.verdict).toBe(true);
    expect([...probe.reads].filter((field) => !producerRequired.includes(field))).toEqual([]);
    expect([...probe.reads].filter((field) => !GROUP_READS.required.includes(field))).toEqual([]);
    expect([...probe.contextReads]).toEqual([]);
    expect(probe.calls).toEqual(calls);
  });

  it('relies on exactly the fields its expectation names across a live and a deleted group', async () => {
    const probes = await Promise.all(PROBES.map(({ payload }) => probeGroupConsumer(payload)));
    const reads = new Set(probes.flatMap((probe) => [...probe.reads]));
    expect([...reads].sort()).toEqual([...GROUP_READS.required].sort());
  });

  it('rejects an expectation of a field identity does not declare', () => {
    const error = contractErrorOf(() =>
      assertProducerConsumerCompatible(groupSchema, { ...GROUP_READS, required: [...GROUP_READS.required, 'groupDescription'] }),
    );
    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath: '/groupDescription', keyword: 'properties' }));
  });
});

describe('programs-sites.site.changed.v1 consumed into the tenant registry', () => {
  it("validates deliveries against programs-sites' own payload schema", () => {
    expect(siteChangedSchema).toEqual(siteSchema);
  });

  it('expects exactly the SiteChangedPayload fields the producer requires', () => {
    expect([...SITE_READS.required].sort()).toEqual(requiredOf(siteSchema).sort());
  });

  it('samples tenant-a pooled under umbrella except its private users and content, and umbrella owning every pool', () => {
    expect(SITE_SAMPLES).toEqual([
      {
        siteId: TENANT_A.siteId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_A.siteId,
        categoryPoolId: TENANT_UMBRELLA.siteId,
        filePoolId: TENANT_UMBRELLA.siteId,
        displayPoolId: TENANT_UMBRELLA.siteId,
        contentPoolIds: [TENANT_A.siteId],
        domains: expect.any(Array),
      },
      {
        siteId: TENANT_UMBRELLA.siteId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_UMBRELLA.siteId,
        categoryPoolId: TENANT_UMBRELLA.siteId,
        filePoolId: TENANT_UMBRELLA.siteId,
        displayPoolId: TENANT_UMBRELLA.siteId,
        contentPoolIds: [TENANT_UMBRELLA.siteId],
        domains: expect.any(Array),
      },
    ]);
  });

  it('is full state on both sides, and the producer provides every registry field of the types the consumer reads', () => {
    expect(tenantRegistryConsumer.kind).toBe('state');
    expect(tenantRegistryConsumer.topic).toBe(SITE_CHANGED_TOPIC);
    expect(SITE_CHANGED_TOPIC).toBe('programs-sites.site.changed.v1');
    expect(() => assertProducerConsumerCompatible(siteSchema, SITE_READS)).not.toThrow();
  });

  it('takes the registry tenant from the envelope, which must carry one', () => {
    const [siteA] = SITE_SAMPLES;
    const envelope = testEnvelope({
      topic: SITE_CHANGED_TOPIC,
      tenantId: TENANT_A.tenantId,
      aggregateId: TENANT_A.siteId,
      aggregateVersion: 1,
      payload: siteA,
    });
    expect((siteSchema as Json).properties).not.toHaveProperty('tenantId');
    expect(assertEventMatches(undefined, siteSchema, envelope).tenantId).toBe(TENANT_A.tenantId);
    expect(() => assertEventMatches(undefined, siteSchema, withoutTenant(envelope))).toThrow(ContractAssertionError);
  });
});

describe('push subscriptions of people', () => {
  const SUBSCRIPTIONS = [
    { subscription: SITE_CHANGED_SUBSCRIPTION, name: 'people.programs-sites.site.changed.v1', topic: SITE_CHANGED_TOPIC, operationId: 'pushSiteChanged', schema: siteSchema },
    { subscription: GROUP_NAME_SUBSCRIPTION, name: 'people.identity.group.changed.v1', topic: GROUP_CHANGED_TOPIC, operationId: 'pushGroupChanged', schema: groupSchema },
  ];

  it.each(SUBSCRIPTIONS)('names $subscription as the platform derives it from its topic', ({ subscription, name, topic }) => {
    expect(subscription).toBe(name);
    expect(subscriptionName(SERVICE, topic)).toBe(subscription);
  });

  it.each(SUBSCRIPTIONS)('serves $subscription at its push path through $operationId', ({ subscription, operationId }) => {
    const { path, method, operation } = operationById(operationId);
    expect(path).toBe(pushPath(subscription));
    expect(path).toBe(`/internal/v1/events/${subscription}`);
    expect(method).toBe('post');
    expect(operation['x-opt2-transport']).toBe('pubsub-push');
    expect(operation['x-opt2-requires']).toEqual(['service:pubsub-invoker']);
  });

  it("registers exactly the two consumers, each on its subscription's topic with its producer's schema", () => {
    const registrations = peopleConsumerRegistrations(createPeopleRepository({ clock: TEST_CLOCK }));
    expect(registrations.map(({ consumer }) => subscriptionName(SERVICE, consumer.topic))).toEqual(
      SUBSCRIPTIONS.map(({ subscription }) => subscription),
    );
    for (const [index, { subscription, schema }] of SUBSCRIPTIONS.entries()) {
      expect(registrations[index]?.consumer.topic).toBe(topicOfSubscription(subscription));
      expect(registrations[index]?.payloadSchema).toEqual(schema);
    }
  });

  it('declares no other push route', () => {
    const pushRoutes = Object.keys(CONTRACT.paths).filter((path) => path.startsWith(PUSH_PATH_PREFIX));
    expect(pushRoutes.sort()).toEqual(SUBSCRIPTIONS.map(({ subscription }) => pushPath(subscription)).sort());
  });
});
