/** Consumer contracts of strategies-content: the producers' payload schemas its four push consumers read, and what each delivery writes. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, assertProducerConsumerCompatible, pushTo, registryPayloads, testEnvelope, type ConsumerExpectation } from '@opt2/platform/testing';
import {
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_TOPIC,
  contentConsumers,
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

/** A tenant whose site the registry does not hold. */
const UNREGISTERED_TENANT = tenantIdForSite('content-unregistered-site');

const REGISTRATIONS: readonly ConsumerRegistration[] = contentConsumers(createContentRepository());
const siteA = registryPayloads().find((payload) => payload.siteId === SITE_A);

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
    required: ['groupId', 'siteId', 'groupName', 'isPublic', 'deleted'],
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
    expect(insertsInto(writes, 'tenant_registry').map((params) => params.slice(0, 2))).toEqual([[SITE_A, TENANT_A.tenantId]]);
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
