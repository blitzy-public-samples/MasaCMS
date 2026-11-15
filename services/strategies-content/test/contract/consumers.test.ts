/** Consumer contracts of strategies-content: the producers' payload schemas its four push consumers read, and what each delivery writes. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readTopicSchema, subscriptionName, topicMeta, topicOfSubscription, type ConsumerRegistration } from '@opt2/platform/events';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
} from '@opt2/platform/testing';
import {
  CONTENT_SUBSCRIPTIONS,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
  contentConsumers,
  groupChangedSchema,
  membershipChangedSchema,
  permissionChangedSchema,
  siteChangedSchema,
} from '../../src/events/consumers.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { SERVICE, buildContentApp, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;

const OPENAPI_URL = new URL('../../contracts/openapi.yaml', import.meta.url);
const OPENAPI = parse(readFileSync(OPENAPI_URL, 'utf8')) as { paths: Record<string, { post?: Json }> };
const SITE_A = TENANT_A.siteId;
const GROUP_ID = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const OTHER_GROUP = 'A1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const HOME = '00000000000000000000000000000000001';
const NODE = 'E1F2A3B4-0001-4A5B-8C7D9E0F1A2B3C4D';
const OTHER_NODE = 'E1F2A3B4-0002-4A5B-8C7D9E0F1A2B3C4D';
/** Module grants are stored on digit-string ids; the content module's is all zeros. */
const CONTENT_MODULE = '00000000000000000000000000000000000';
const USERS_MODULE = '00000000000000000000000000000000008';

/** A tenant whose site the registry does not hold. */
const UNREGISTERED_TENANT = tenantIdForSite('content-unregistered-site');

const REGISTRATIONS: readonly ConsumerRegistration[] = contentConsumers(createContentRepository());
const siteA = registryPayloads().find((payload) => payload.siteId === SITE_A);

/** Each consumed topic's published producer file and the payload schema strategies-content exports for it. */
const PRODUCERS = [
  {
    topic: SITE_CHANGED_TOPIC,
    producerUrl: new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
    consumerSchema: siteChangedSchema,
  },
  {
    topic: GROUP_CHANGED_TOPIC,
    producerUrl: new URL('../../../identity/contracts/events/identity.group.changed.v1.json', import.meta.url),
    consumerSchema: groupChangedSchema,
  },
  {
    topic: PERMISSION_CHANGED_TOPIC,
    producerUrl: new URL('../../../identity/contracts/events/identity.permission.changed.v1.json', import.meta.url),
    consumerSchema: permissionChangedSchema,
  },
  {
    topic: MEMBERSHIP_CHANGED_TOPIC,
    producerUrl: new URL('../../../identity/contracts/events/identity.membership.changed.v1.json', import.meta.url),
    consumerSchema: membershipChangedSchema,
  },
] as const;

/** Payloads per topic as identity and programs-sites may send them: ids in either case, as the producers' CF UUID pattern allows. */
const SAMPLES: Readonly<Record<string, readonly Json[]>> = {
  [SITE_CHANGED_TOPIC]: [{ ...siteA }],
  [GROUP_CHANGED_TOPIC]: [
    { groupId: GROUP_ID, siteId: SITE_A, groupName: 'Content Editors', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false },
    { groupId: GROUP_ID.toLowerCase(), siteId: SITE_A, groupName: null, type: 1, isPublic: null, poolTenantId: TENANT_A.tenantId, deleted: true },
  ],
  [PERMISSION_CHANGED_TOPIC]: [
    {
      groupId: GROUP_ID.toLowerCase(),
      siteId: SITE_A,
      rows: [
        { contentId: HOME, siteId: SITE_A, type: 'Editor' },
        { contentId: NODE.toLowerCase(), siteId: SITE_A, type: 'deny' },
      ],
    },
    { groupId: GROUP_ID, siteId: SITE_A, rows: [] },
    {
      groupId: GROUP_ID,
      siteId: SITE_A,
      rows: [
        { contentId: HOME, siteId: SITE_A, type: 'Author' },
        { contentId: NODE, siteId: SITE_A, type: 'Read' },
        { contentId: OTHER_NODE, siteId: SITE_A, type: 'Deny' },
        { contentId: CONTENT_MODULE, siteId: SITE_A, type: 'module' },
        { contentId: USERS_MODULE, siteId: SITE_A, type: 'Module' },
      ],
    },
  ],
  [MEMBERSHIP_CHANGED_TOPIC]: [
    { userId: USER_ID.toLowerCase(), siteId: SITE_A, groupIds: [GROUP_ID, OTHER_GROUP.toLowerCase()] },
    { userId: USER_ID, siteId: SITE_A, groupIds: [] },
  ],
};

/** What each consumer reads from its producer's payload. */
const READS: Readonly<Record<string, Omit<ConsumerExpectation, 'samples' | 'kind'>>> = {
  [SITE_CHANGED_TOPIC]: {
    required: ['siteId', 'publicUserPoolId', 'privateUserPoolId', 'categoryPoolId', 'filePoolId', 'displayPoolId', 'contentPoolIds', 'domains'],
    types: { siteId: 'string', contentPoolIds: 'array', domains: 'array' },
    itemTypes: { contentPoolIds: 'string', domains: 'string' },
  },
  [GROUP_CHANGED_TOPIC]: {
    // poolTenantId is not projected, but the tenant re-check compares it with the delivery tenant.
    required: ['groupId', 'siteId', 'groupName', 'isPublic', 'poolTenantId', 'deleted'],
    types: { groupId: 'string', siteId: 'string', deleted: 'boolean' },
  },
  [PERMISSION_CHANGED_TOPIC]: {
    required: ['groupId', 'siteId', 'rows'],
    types: { groupId: 'string', siteId: 'string', rows: 'array' },
    itemTypes: { rows: 'object' },
  },
  [MEMBERSHIP_CHANGED_TOPIC]: {
    required: ['userId', 'siteId', 'groupIds'],
    types: { userId: 'string', siteId: 'string', groupIds: 'array' },
    itemTypes: { groupIds: 'string' },
  },
};

const TOPICS = REGISTRATIONS.map((registration) => registration.consumer.topic);

function registrationOf(topic: string): ConsumerRegistration {
  const registration = REGISTRATIONS.find((candidate) => candidate.consumer.topic === topic);
  if (registration === undefined) throw new TypeError(`No consumer of ${topic}`);
  return registration;
}

function samplesOf(topic: string): readonly Json[] {
  const samples = SAMPLES[topic];
  if (samples === undefined) throw new TypeError(`No samples of ${topic}`);
  return samples;
}

/** The contract's push operation of `topic`'s subscription. */
function pushOperation(topic: string): Json {
  const operation = OPENAPI.paths[`/internal/v1/events/${subscriptionName(SERVICE, topic)}`]?.post;
  if (operation === undefined) throw new TypeError(`The contract has no push operation for ${topic}`);
  return operation;
}

/** The envelope aggregate the producer names for `payload`: a site, a group's state or grants, or a user's memberships. */
function aggregateOf(topic: string, payload: Json): { aggregateType: string; aggregateId: string } {
  switch (topic) {
    case SITE_CHANGED_TOPIC:
      return { aggregateType: 'site', aggregateId: String(payload.siteId) };
    case GROUP_CHANGED_TOPIC:
    case PERMISSION_CHANGED_TOPIC:
      return { aggregateType: 'group', aggregateId: String(payload.groupId) };
    case MEMBERSHIP_CHANGED_TOPIC:
      return { aggregateType: 'user', aggregateId: String(payload.userId) };
    default:
      throw new TypeError(`No aggregate of ${topic}`);
  }
}

/** The producer's published payload schema of `topic`, read from its file. */
function producerSchemaOf(topic: string): object {
  const producer = PRODUCERS.find((candidate) => candidate.topic === topic);
  if (producer === undefined) throw new TypeError(`No producer of ${topic}`);
  return readTopicSchema(producer.producerUrl);
}

/** `payload` on `topic` in a tenant-a envelope at aggregate version 1. */
function envelopeOf(topic: string, payload: Json) {
  return testEnvelope({ topic, tenantId: TENANT_A.tenantId, ...aggregateOf(topic, payload), aggregateVersion: 1, payload });
}

describe('producer schemas', () => {
  it('consumes exactly the four topics the contract declares push operations for', () => {
    const declared = Object.values(OPENAPI.paths).flatMap((item) => (typeof item.post?.['x-opt2-topic'] === 'string' ? [item.post['x-opt2-topic']] : []));
    expect([...TOPICS].sort()).toEqual([...declared].sort());
  });

  it.each(TOPICS)('%s: the consumer validates against the producer schema the contract names', (topic) => {
    const location = pushOperation(topic)['x-opt2-topic-schema'];
    expect(typeof location).toBe('string');
    expect(registrationOf(topic).payloadSchema).toEqual(readTopicSchema(new URL(String(location), OPENAPI_URL)));
  });

  it.each(TOPICS)('%s: the producer provides every field the consumer reads, of the kind it applies', (topic) => {
    const reads = READS[topic];
    if (reads === undefined) throw new TypeError(`No reads of ${topic}`);
    const { payloadSchema, consumer } = registrationOf(topic);
    expect(() => assertProducerConsumerCompatible(payloadSchema, { ...reads, kind: consumer.kind, samples: [...samplesOf(topic)] })).not.toThrow();
  });

  it.each(PRODUCERS)('$topic: the exported payload schema is the producer’s published file', ({ topic, producerUrl, consumerSchema }) => {
    expect(consumerSchema).toEqual(JSON.parse(readFileSync(producerUrl, 'utf8')));
    expect(registrationOf(topic).payloadSchema).toBe(consumerSchema);
  });

  it.each(TOPICS)('%s: full-state events applied in the envelope tenant only, on both sides', (topic) => {
    expect(topicMeta(producerSchemaOf(topic))).toEqual({ kind: 'state' });
    const { consumer } = registrationOf(topic);
    expect(consumer.kind).toBe('state');
    expect(consumer.fanout).toBeUndefined();
  });

  it.each(TOPICS.flatMap((topic) => samplesOf(topic).map((payload, index) => [topic, index, payload] as const)))(
    '%s sample %i: a tenant-a delivery matches the envelope and producer payload contracts',
    (topic, _index, payload) => {
      expect(() => assertEventMatches(undefined, producerSchemaOf(topic), envelopeOf(topic, payload))).not.toThrow();
    },
  );
});

describe('contract checks', () => {
  const liveGroup = samplesOf(GROUP_CHANGED_TOPIC)[0] ?? {};
  const { deleted: _deleted, ...groupWithoutDeleted } = liveGroup;

  it.each([
    ['a delivery envelope without a tenant', () => assertEventMatches(undefined, producerSchemaOf(GROUP_CHANGED_TOPIC), withoutTenant(envelopeOf(GROUP_CHANGED_TOPIC, liveGroup))), /tenantId/],
    ['a group state without deleted', () => assertEventMatches(undefined, producerSchemaOf(GROUP_CHANGED_TOPIC), envelopeOf(GROUP_CHANGED_TOPIC, groupWithoutDeleted)), /deleted/],
    ['a read of a field identity does not publish', () => assertProducerConsumerCompatible(producerSchemaOf(GROUP_CHANGED_TOPIC), { required: ['groupNameLower'] }), /\/groupNameLower is not declared by the producer/],
  ] as const)('rejects %s', (_label, check, finding) => {
    expect(check).toThrow(ContractAssertionError);
    expect(check).toThrow(finding);
  });
});

describe('subscriptions', () => {
  it('subscribes once per consumed topic as strategies-content.<topic>', () => {
    expect(CONTENT_SUBSCRIPTIONS).toEqual(PRODUCERS.map(({ topic }) => subscriptionName('strategies-content', topic)));
    expect(CONTENT_SUBSCRIPTIONS.map((subscription) => topicOfSubscription(subscription))).toEqual(TOPICS);
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('strategies-content', SITE_CHANGED_TOPIC));
  });
});

describe('deliveries', () => {
  let t: ContentTestApp;

  beforeAll(async () => {
    t = await buildContentApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    t.db.reset();
    t.publisher.clear();
  });

  /** Delivers `payload` on `topic` in tenant-a and returns the status and the writes the delivery made outside the platform tables. */
  async function deliver(topic: string, payload: Json, tenantId = TENANT_A.tenantId) {
    const envelope = testEnvelope({ topic, tenantId, ...aggregateOf(topic, payload), payload });
    const res = await pushTo(t.app, subscriptionName(SERVICE, topic), envelope);
    const writes = t.db.statements.filter(
      (statement) => /^(INSERT|UPDATE|DELETE)\b/i.test(statement.sql) && !/\b(inbox|consumer_aggregate_version|changelog)\b/i.test(statement.sql),
    );
    return { status: res.statusCode, writes, envelope };
  }

  /** The INSERT parameters into `table`. */
  const insertsInto = (writes: ReadonlyArray<{ sql: string; params: readonly unknown[] }>, table: string): unknown[][] =>
    writes.filter((write) => new RegExp(`^INSERT INTO "?content"?\\."?${table}"?`, 'i').test(write.sql)).map((write) => [...write.params]);

  it('stores the site in the tenant registry with its pool tenants', async () => {
    const { status, writes } = await deliver(SITE_CHANGED_TOPIC, { ...siteA });
    expect(status).toBe(204);
    const umbrella = TENANT_UMBRELLA.tenantId;
    // Columns: site, tenant, then the public-user, private-user, category, file and display pool tenants.
    expect(insertsInto(writes, 'tenant_registry').map((params) => [...params.slice(0, 2), ...params.slice(8, 13)])).toEqual([
      [SITE_A, TENANT_A.tenantId, umbrella, TENANT_A.tenantId, umbrella, umbrella, umbrella],
    ]);
  });

  it.each(samplesOf(GROUP_CHANGED_TOPIC).map((payload) => [String(payload.groupId), payload] as const))(
    'stores group %s in the group projection as identity spells it',
    async (_id, payload) => {
      const { status, writes } = await deliver(GROUP_CHANGED_TOPIC, payload);
      expect(status).toBe(204);
      expect(insertsInto(writes, 'group_projection')).toEqual([
        [TENANT_A.tenantId, payload.groupId, payload.siteId, payload.groupName, payload.isPublic, payload.deleted],
      ]);
    },
  );

  it('replaces a group’s stored grants, whatever their spelling, with the delivered rows', async () => {
    const stored = { tenant_id: TENANT_A.tenantId, group_id: GROUP_ID, site_id: 'TENANT-A', content_id: NODE, type: 'Read' };
    t.db.respond(/^SELECT \* FROM "content"\."permission_projection" WHERE tenant_id = \$1 AND .* FOR UPDATE$/, (params) =>
      params[1] === GROUP_ID.toLowerCase() ? [stored] : [],
    );
    const [payload] = samplesOf(PERMISSION_CHANGED_TOPIC);
    const { status, writes } = await deliver(PERMISSION_CHANGED_TOPIC, payload ?? {});
    expect(status).toBe(204);
    const selection = t.db.statements.find((statement) => /^SELECT \* FROM "content"\."permission_projection" WHERE tenant_id = \$1 AND/.test(statement.sql));
    // Identity may spell the group and site ids in any case, so the replaced rows are found by SQL Server's case-insensitive equality.
    expect(selection?.sql).toMatch(/\(\(group_id::bpchar\) COLLATE "content"\."legacy_char_ci"\) = \$2::bpchar AND \(\(site_id::bpchar\) COLLATE "content"\."legacy_ci"\) = \$3::bpchar/);
    expect(writes.filter((write) => /^DELETE FROM "content"\."permission_projection"/.test(write.sql)).map((write) => write.params)).toEqual([
      expect.arrayContaining([GROUP_ID, 'TENANT-A', NODE, 'Read']),
    ]);
    expect(insertsInto(writes, 'permission_projection')).toEqual([
      [TENANT_A.tenantId, GROUP_ID.toLowerCase(), SITE_A, HOME, 'Editor'],
      [TENANT_A.tenantId, GROUP_ID.toLowerCase(), SITE_A, NODE.toLowerCase(), 'deny'],
    ]);
  });

  it('permission rows keep the stored type verbatim', async () => {
    const { status, writes } = await deliver(PERMISSION_CHANGED_TOPIC, samplesOf(PERMISSION_CHANGED_TOPIC)[2] ?? {});
    expect(status).toBe(204);
    expect(insertsInto(writes, 'permission_projection')).toEqual([
      [TENANT_A.tenantId, GROUP_ID, SITE_A, HOME, 'Author'],
      [TENANT_A.tenantId, GROUP_ID, SITE_A, NODE, 'Read'],
      [TENANT_A.tenantId, GROUP_ID, SITE_A, OTHER_NODE, 'Deny'],
      [TENANT_A.tenantId, GROUP_ID, SITE_A, CONTENT_MODULE, 'module'],
      [TENANT_A.tenantId, GROUP_ID, SITE_A, USERS_MODULE, 'Module'],
    ]);
  });

  it('replaces a user’s stored memberships, whatever their spelling, with the delivered groups', async () => {
    const stored = { tenant_id: TENANT_A.tenantId, user_id: USER_ID, site_id: SITE_A, group_id: OTHER_GROUP };
    t.db.respond(/^SELECT \* FROM "content"\."membership_projection" WHERE tenant_id = \$1 AND .* FOR UPDATE$/, (params) =>
      params[1] === USER_ID.toLowerCase() ? [stored] : [],
    );
    const [payload] = samplesOf(MEMBERSHIP_CHANGED_TOPIC);
    const { status, writes } = await deliver(MEMBERSHIP_CHANGED_TOPIC, payload ?? {});
    expect(status).toBe(204);
    const selection = t.db.statements.find((statement) => /^SELECT \* FROM "content"\."membership_projection" WHERE tenant_id = \$1 AND/.test(statement.sql));
    expect(selection?.sql).toMatch(/\(\(user_id::bpchar\) COLLATE "content"\."legacy_char_ci"\) = \$2::bpchar/);
    expect(writes.filter((write) => /^DELETE FROM "content"\."membership_projection"/.test(write.sql)).map((write) => write.params)).toEqual([
      expect.arrayContaining([USER_ID, OTHER_GROUP]),
    ]);
    expect(insertsInto(writes, 'membership_projection')).toEqual([
      [TENANT_A.tenantId, USER_ID.toLowerCase(), SITE_A, GROUP_ID],
      [TENANT_A.tenantId, USER_ID.toLowerCase(), SITE_A, OTHER_GROUP.toLowerCase()],
    ]);
  });

  it.each([
    [PERMISSION_CHANGED_TOPIC, 'permission_projection'],
    [MEMBERSHIP_CHANGED_TOPIC, 'membership_projection'],
  ])('clears the stored rows for an empty %s list', async (topic, table) => {
    const payload = samplesOf(topic)[1] ?? {};
    const { status, writes } = await deliver(topic, payload);
    expect(status).toBe(204);
    expect(insertsInto(writes, table)).toEqual([]);
    expect(t.db.statements.some((statement) => new RegExp(`^SELECT \\* FROM "content"\\."${table}" WHERE tenant_id = \\$1 AND .* FOR UPDATE$`).test(statement.sql))).toBe(true);
  });

  it.each([GROUP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC])(
    'dead-letters a %s delivery from a tenant the registry does not hold, writing nothing',
    async (topic) => {
      const { status, writes } = await deliver(topic, samplesOf(topic)[0] ?? {}, UNREGISTERED_TENANT);
      expect(status).toBe(204);
      expect(writes).toEqual([]);
      expect(t.publisher.deadLetters(subscriptionName(SERVICE, topic)).map((letter) => letter.reason)).toEqual(['invalid-tenant']);
    },
  );

  it('dead-letters a site delivery whose envelope tenant is not the site’s, writing nothing', async () => {
    const { status, writes } = await deliver(SITE_CHANGED_TOPIC, { ...siteA }, UNREGISTERED_TENANT);
    expect(status).toBe(204);
    expect(writes).toEqual([]);
    expect(t.publisher.deadLetters(subscriptionName(SERVICE, SITE_CHANGED_TOPIC)).map((letter) => letter.reason)).toEqual(['tenant-mismatch']);
  });
});
