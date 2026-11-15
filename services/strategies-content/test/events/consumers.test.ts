/** Strategies-content push consumers over a migrated throwaway schema: the site registry and identity's group, permission and membership projections. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSUMER_AGGREGATE_VERSION_TABLE,
  DEAD_LETTER_REASON_ATTRIBUTE,
  INBOX_TABLE,
  buildPushBody,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  pushPath,
  type DeadLetterReason,
  type EventEnvelope,
  type PushBody,
} from '@opt2/platform/events';
import { closeGates, openGates, readGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, withTenant, type SiteChangedPayload, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  assertEventMatches,
  createCapturingPublisher,
  deliverDuplicate,
  deliverOutOfOrder,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
  groupChangedSchema,
  membershipChangedSchema,
  permissionChangedSchema,
  siteChangedSchema,
  type GroupChangedPayload,
  type MembershipChangedPayload,
  type PermissionChangedPayload,
} from '../../src/events/consumers.js';
import { CONTENT_UNITS, GROUP_PROJECTION, MEMBERSHIP_PROJECTION, PERMISSION_PROJECTION, UNIT_OF } from '../../src/repo/tables.js';
import { buildTestApp, openContentGates, withPgSchema, type TestApp } from '../helpers/app.js';
import { newId } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

type Payload = GroupChangedPayload | PermissionChangedPayload | MembershipChangedPayload;
type Row = Record<string, unknown>;
type Grant = readonly [contentId: string, type: string];

/** One identity projection topic: its subscription, aggregate, table and the distinguishable full states `n` of an aggregate. */
interface ProjectionSpec {
  name: 'group' | 'permission' | 'membership';
  topic: string;
  subscription: string;
  aggregateType: 'group' | 'user';
  payloadSchema: object;
  table: string;
  idColumn: string;
  columns: string;
  orderBy: string;
  state(id: string, n: number): Payload;
  rows(id: string, n: number): Row[];
}

const SITE_A = TENANT_A.siteId;
const HOME = '00000000000000000000000000000000001';
const USERS_MODULE = '00000000000000000000000000000000008';
const NODE_PREFIX = 'E1F2A3B4';
const GROUP_PREFIX = 'D1E2F3A4';
const GRANT_TYPES = ['Editor', 'Author', 'Read', 'Deny'] as const;
const SITE_C = 'tenant-c';
const TENANT_C = tenantIdForSite(SITE_C);
const UNREGISTERED_SITE = 'content-unregistered-site';
const UNREGISTERED_TENANT = tenantIdForSite(UNREGISTERED_SITE);
const PROBED_TENANTS = [...TENANT_LIST.map((fixture) => fixture.tenantId), UNREGISTERED_TENANT];
const REJECTED_TYPE = 'opt2-test-reject';
const REJECT_CONSTRAINT = 'opt2_test_reject';
const GATE_HOLDER = 'test-holder';
const REGISTRY_COLUMNS = [
  'site_id',
  'tenant_id',
  'public_user_pool_id',
  'private_user_pool_id',
  'category_pool_id',
  'file_pool_id',
  'display_pool_id',
  'content_pool_ids',
  'public_user_pool_tenant',
  'private_user_pool_tenant',
  'category_pool_tenant',
  'file_pool_tenant',
  'display_pool_tenant',
  'content_pool_tenants',
  'domains',
  'aggregate_version::int AS aggregate_version',
].join(', ');

/** The `n`-th fixed CF UUID under an 8-hex-digit `prefix`. */
function fixedId(prefix: string, n: number): string {
  return `${prefix}-0000-0000-${String(n).padStart(16, '0')}`;
}

/** The legacy grant type of state `n`. */
function grantType(n: number): string {
  return GRANT_TYPES[n % GRANT_TYPES.length] as string;
}

/** A tenant-a private-pool group state as identity publishes it. */
function groupPayload(groupId: string, overrides: Partial<GroupChangedPayload> = {}): GroupChangedPayload {
  return { groupId, siteId: SITE_A, groupName: 'Content Editors', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false, ...overrides };
}

/** A group's full tenant-a permission set of `grants`. */
function permissionPayload(groupId: string, grants: readonly Grant[]): PermissionChangedPayload {
  return { groupId, siteId: SITE_A, rows: grants.map(([contentId, type]) => ({ contentId, siteId: SITE_A, type })) };
}

/** A tenant-a user's full membership set. */
function membershipPayload(userId: string, groupIds: readonly string[]): MembershipChangedPayload {
  return { userId, siteId: SITE_A, groupIds: [...groupIds] };
}

/** The `permission_projection` row of one tenant-a grant. */
function permissionRow(groupId: string, [contentId, type]: Grant): Row {
  return { group_id: groupId, site_id: SITE_A, content_id: contentId, type };
}

/** The `membership_projection` row of one tenant-a membership. */
function membershipRow(userId: string, groupId: string): Row {
  return { user_id: userId, site_id: SITE_A, group_id: groupId };
}

/** The grants of permission state `n`, in projection order. */
function grantsOf(n: number): Grant[] {
  return [
    [HOME, grantType(n)],
    [fixedId(NODE_PREFIX, n), 'Read'],
  ];
}

/** The group ids of membership state `n`, in projection order. */
function groupsOf(n: number): string[] {
  return [fixedId(GROUP_PREFIX, n), fixedId(GROUP_PREFIX, n + 100)];
}

const GROUP: ProjectionSpec = {
  name: 'group',
  topic: GROUP_CHANGED_TOPIC,
  subscription: GROUP_CHANGED_SUBSCRIPTION,
  aggregateType: 'group',
  payloadSchema: groupChangedSchema,
  table: GROUP_PROJECTION.table,
  idColumn: 'group_id',
  columns: 'group_id, site_id, group_name, is_public, deleted',
  orderBy: 'group_id',
  state: (id, n) => groupPayload(id, { groupName: `Content Editors v${String(n)}`, isPublic: n % 2 === 0 ? 1 : 0 }),
  rows: (id, n) => [{ group_id: id, site_id: SITE_A, group_name: `Content Editors v${String(n)}`, is_public: n % 2 === 0 ? 1 : 0, deleted: false }],
};

const PERMISSION: ProjectionSpec = {
  name: 'permission',
  topic: PERMISSION_CHANGED_TOPIC,
  subscription: PERMISSION_CHANGED_SUBSCRIPTION,
  aggregateType: 'group',
  payloadSchema: permissionChangedSchema,
  table: PERMISSION_PROJECTION.table,
  idColumn: 'group_id',
  columns: 'group_id, site_id, content_id, type',
  orderBy: 'content_id, type',
  state: (id, n) => permissionPayload(id, grantsOf(n)),
  rows: (id, n) => grantsOf(n).map((grant) => permissionRow(id, grant)),
};

const MEMBERSHIP: ProjectionSpec = {
  name: 'membership',
  topic: MEMBERSHIP_CHANGED_TOPIC,
  subscription: MEMBERSHIP_CHANGED_SUBSCRIPTION,
  aggregateType: 'user',
  payloadSchema: membershipChangedSchema,
  table: MEMBERSHIP_PROJECTION.table,
  idColumn: 'user_id',
  columns: 'user_id, site_id, group_id',
  orderBy: 'group_id',
  state: (id, n) => membershipPayload(id, groupsOf(n)),
  rows: (id, n) => groupsOf(n).map((groupId) => membershipRow(id, groupId)),
};

const SPECS: readonly ProjectionSpec[] = [GROUP, PERMISSION, MEMBERSHIP];

const UNITS_BY_TABLE: Readonly<Record<string, string | undefined>> = UNIT_OF;
const GATED_SPECS = SPECS.filter((spec) => UNITS_BY_TABLE[spec.table] !== undefined);
const WRITTEN_UNITS = GATED_SPECS.map((spec) => UNITS_BY_TABLE[spec.table] as string);

/** A delivery of `payload` on `spec`'s topic for aggregate `aggregateId`, by default as tenant-a's version 1. */
function deliveryOf<P>(
  spec: Pick<ProjectionSpec, 'topic' | 'aggregateType'>,
  payload: P,
  aggregateId: string,
  aggregateVersion = 1,
  tenantId = TENANT_A.tenantId,
): EventEnvelope<P> {
  return testEnvelope({ topic: spec.topic, tenantId, aggregateType: spec.aggregateType, aggregateId, aggregateVersion, payload });
}

/** Tenant-a's delivery of `spec`'s state `n` for aggregate `id` at `version`, by default `n`. */
function stateEnvelope(spec: ProjectionSpec, id: string, n: number, version = n): EventEnvelope<Payload> {
  return deliveryOf(spec, spec.state(id, n), id, version);
}

/** A site state whose own-site pools are `siteId` and whose shared pools are the umbrella site. */
function sitePayload(siteId: string): SiteChangedPayload {
  return {
    siteId,
    publicUserPoolId: TENANT_UMBRELLA.siteId,
    privateUserPoolId: siteId,
    categoryPoolId: TENANT_UMBRELLA.siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId, TENANT_UMBRELLA.siteId],
    domains: [`${siteId}.opt2.test`],
  };
}

/** A site delivery at `aggregateVersion`, by default under the site's own tenant. */
function siteEnvelope(payload: SiteChangedPayload, aggregateVersion = 1, tenantId = tenantIdForSite(payload.siteId)): EventEnvelope<SiteChangedPayload> {
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: payload.siteId, aggregateVersion, payload });
}

/** The body Pub/Sub would push for `envelope` on `subscription`. */
function pushBodyOf(subscription: string, envelope: EventEnvelope): PushBody {
  return buildPushBody({
    data: encodeEnvelope(envelope),
    attributes: envelopeAttributes(envelope),
    messageId: randomUUID(),
    subscription,
    orderingKey: envelope.aggregateId,
  });
}

const available = await pgAvailable();

describe.skipIf(!available)('strategies-content event consumers', () => {
  let handle: ThrowawaySchema;
  let t: TestApp<TenantDb>;
  const publisher = createCapturingPublisher();

  beforeAll(async () => {
    handle = await withPgSchema();
    await openContentGates(handle);
    await seedRegistry(handle.app, handle.schema);
    t = await buildTestApp({ db: handle.app, publisher });
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    publisher.clear();
  });

  /** `<throwaway schema>.<name>`. */
  function qualified(name: string): string {
    return `${handle.schema}.${name}`;
  }

  /** Rows of `sql` read in a transaction of `tenantId`, under forced row-level security. */
  function rowsIn<R extends Row>(tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
    return withTenant(handle.app, tenantId, async (tx) => (await tx.query<R>(sql, params)).rows);
  }

  /** The `tenant_registry` row of `siteId`, read as tenant metadata. */
  function registryRow(siteId: string): Promise<Row | undefined> {
    return withMetadata(handle.app, async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${REGISTRY_COLUMNS} FROM ${qualified('tenant_registry')} WHERE site_id = $1`, [siteId]);
      return rows[0];
    });
  }

  /** Inbox statuses of `eventId` in `tenantId`. */
  async function inboxRows(tenantId: string, eventId: string): Promise<string[]> {
    const rows = await rowsIn<{ status: string }>(tenantId, `SELECT status FROM ${qualified(INBOX_TABLE)} WHERE event_id = $1`, [eventId]);
    return rows.map((row) => row.status);
  }

  /** The last applied version of `aggregateId` on `subscription` in `tenantId`; undefined without ordering progress. */
  async function lastVersion(tenantId: string, subscription: string, aggregateId: string): Promise<number | null | undefined> {
    const rows = await rowsIn<{ last_version: number | null }>(
      tenantId,
      `SELECT last_version::int AS last_version FROM ${qualified(CONSUMER_AGGREGATE_VERSION_TABLE)} WHERE subscription = $1 AND aggregate_id = $2`,
      [subscription, aggregateId],
    );
    return rows[0]?.last_version;
  }

  /** `spec`'s projection rows of aggregate `id` in `tenantId`. */
  function projection(spec: ProjectionSpec, id: string, tenantId = TENANT_A.tenantId): Promise<Row[]> {
    return rowsIn(tenantId, `SELECT ${spec.columns} FROM ${qualified(spec.table)} WHERE ${spec.idColumn} = $1 ORDER BY ${spec.orderBy}`, [id]);
  }

  /** `spec`'s projection rows of aggregate `id` in every probed tenant except tenant-a. */
  async function elsewhere(spec: ProjectionSpec, id: string): Promise<Row[]> {
    const others = PROBED_TENANTS.filter((tenantId) => tenantId !== TENANT_A.tenantId);
    return (await Promise.all(others.map((tenantId) => projection(spec, id, tenantId)))).flat();
  }

  /** Tenant-a changelog rows of `table` whose key names `id`. */
  async function changelogCount(table: string, id: string): Promise<number> {
    const [row] = await rowsIn<{ n: number }>(
      TENANT_A.tenantId,
      `SELECT count(*)::int AS n FROM ${qualified('changelog')} WHERE "table" = $1 AND strpos(key, $2) > 0`,
      [table, id],
    );
    return row?.n ?? 0;
  }

  /** Inbox receipts, ordering rows and projection rows `envelope` left across every probed tenant. */
  async function traces(spec: ProjectionSpec, envelope: TenantlessEnvelope): Promise<{ inbox: number; versions: number; projected: number }> {
    const counted = { inbox: 0, versions: 0, projected: 0 };
    for (const tenantId of PROBED_TENANTS) {
      const [row] = await rowsIn<typeof counted>(
        tenantId,
        `SELECT (SELECT count(*)::int FROM ${qualified(INBOX_TABLE)} WHERE event_id = $1) AS inbox,
                (SELECT count(*)::int FROM ${qualified(CONSUMER_AGGREGATE_VERSION_TABLE)} WHERE subscription = $2 AND aggregate_id = $3::text) AS versions,
                (SELECT count(*)::int FROM ${qualified(spec.table)} WHERE ${spec.idColumn} = $3::text) AS projected`,
        [envelope.eventId, spec.subscription, envelope.aggregateId],
      );
      counted.inbox += row?.inbox ?? 0;
      counted.versions += row?.versions ?? 0;
      counted.projected += row?.projected ?? 0;
    }
    return counted;
  }

  const NO_TRACES = { inbox: 0, versions: 0, projected: 0 };

  describe('producer contracts', () => {
    it.each(SPECS)('builds $name deliveries that match the envelope and producer payload contracts', (spec) => {
      expect(() => assertEventMatches(undefined, spec.payloadSchema, stateEnvelope(spec, newId(), 1))).not.toThrow();
    });

    it('builds site deliveries that match the envelope and producer payload contracts', () => {
      expect(() => assertEventMatches(undefined, siteChangedSchema, siteEnvelope(sitePayload(SITE_C)))).not.toThrow();
    });
  });

  describe('projections applied', () => {
    it('registers a new site in the tenant registry with every pool resolved to its tenant id', async () => {
      const envelope = siteEnvelope(sitePayload(SITE_C));

      const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope);

      expect(res.statusCode).toBe(204);
      expect(await registryRow(SITE_C)).toEqual({
        site_id: SITE_C,
        tenant_id: TENANT_C,
        public_user_pool_id: TENANT_UMBRELLA.siteId,
        private_user_pool_id: SITE_C,
        category_pool_id: TENANT_UMBRELLA.siteId,
        file_pool_id: SITE_C,
        display_pool_id: SITE_C,
        content_pool_ids: [SITE_C, TENANT_UMBRELLA.siteId],
        public_user_pool_tenant: TENANT_UMBRELLA.tenantId,
        private_user_pool_tenant: TENANT_C,
        category_pool_tenant: TENANT_UMBRELLA.tenantId,
        file_pool_tenant: TENANT_C,
        display_pool_tenant: TENANT_C,
        content_pool_tenants: [TENANT_C, TENANT_UMBRELLA.tenantId],
        domains: [`${SITE_C}.opt2.test`],
        aggregate_version: 1,
      });
      expect(await inboxRows(TENANT_C, envelope.eventId)).toEqual(['applied']);
      expect(await inboxRows(TENANT_B.tenantId, envelope.eventId)).toEqual([]);
      expect(publisher.raw).toEqual([]);
    });

    it('projects a group state, stores a null group name as null and keeps a deleted group as a tombstone row', async () => {
      const groupId = newId();
      const states = [
        groupPayload(groupId),
        groupPayload(groupId, { groupName: null, isPublic: null }),
        groupPayload(groupId, { groupName: null, isPublic: null, deleted: true }),
      ];
      const expected = [
        { group_id: groupId, site_id: SITE_A, group_name: 'Content Editors', is_public: 0, deleted: false },
        { group_id: groupId, site_id: SITE_A, group_name: null, is_public: null, deleted: false },
        { group_id: groupId, site_id: SITE_A, group_name: null, is_public: null, deleted: true },
      ];

      for (const [index, payload] of states.entries()) {
        const envelope = deliveryOf(GROUP, payload, groupId, index + 1);
        expect((await pushTo(t.app, GROUP.subscription, envelope)).statusCode).toBe(204);
        expect(await projection(GROUP, groupId)).toEqual([expected[index]]);
        expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
      }
      expect(await elsewhere(GROUP, groupId)).toEqual([]);
      expect(publisher.raw).toEqual([]);
    });

    it('projects a group’s permission rows on the payload site with their stored grant types verbatim', async () => {
      const groupId = newId();
      const grants: Grant[] = [
        [HOME, 'Editor'],
        [USERS_MODULE, 'module'],
        [fixedId(NODE_PREFIX, 1), 'Author'],
        [fixedId(NODE_PREFIX, 2), 'Read'],
        [fixedId(NODE_PREFIX, 3), 'Deny'],
      ];
      const envelope = deliveryOf(PERMISSION, permissionPayload(groupId, grants), groupId);

      const res = await pushTo(t.app, PERMISSION.subscription, envelope);

      expect(res.statusCode).toBe(204);
      expect(await projection(PERMISSION, groupId)).toEqual(grants.map((grant) => permissionRow(groupId, grant)));
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
      expect(await elsewhere(PERMISSION, groupId)).toEqual([]);
      expect(publisher.raw).toEqual([]);
    });

    it('projects a user’s group memberships', async () => {
      const userId = newId();
      const groupIds = [fixedId(GROUP_PREFIX, 1), fixedId(GROUP_PREFIX, 2)];
      const envelope = deliveryOf(MEMBERSHIP, membershipPayload(userId, groupIds), userId);

      const res = await pushTo(t.app, MEMBERSHIP.subscription, envelope);

      expect(res.statusCode).toBe(204);
      expect(await projection(MEMBERSHIP, userId)).toEqual(groupIds.map((groupId) => membershipRow(userId, groupId)));
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
      expect(await elsewhere(MEMBERSHIP, userId)).toEqual([]);
      expect(publisher.raw).toEqual([]);
    });
  });

  describe('duplicate delivery', () => {
    it.each(SPECS)('applies a $name state delivered three times under one message id once', async (spec) => {
      const id = newId();
      const envelope = stateEnvelope(spec, id, 1);

      const responses = await deliverDuplicate(t.app, spec.subscription, envelope, 3);

      expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204]);
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
      expect(await projection(spec, id)).toEqual(spec.rows(id, 1));
      expect(await changelogCount(spec.table, id)).toBe(spec.rows(id, 1).length);
      expect(await lastVersion(TENANT_A.tenantId, spec.subscription, id)).toBe(1);
      expect(publisher.raw).toEqual([]);
    });
  });

  describe('stale versions', () => {
    it.each(SPECS)('acks $name versions below or equal to the applied one as stale and keeps the applied state', async (spec) => {
      const id = newId();
      const v3 = stateEnvelope(spec, id, 3);
      expect((await pushTo(t.app, spec.subscription, v3)).statusCode).toBe(204);
      const late = versionedSequence(v3, [2, 3], (version) => spec.state(id, version + 10));

      const responses = await deliverOutOfOrder(t.app, spec.subscription, late, [0, 1]);

      expect(responses.map((res) => res.statusCode)).toEqual([204, 204]);
      expect(await projection(spec, id)).toEqual(spec.rows(id, 3));
      expect(await lastVersion(TENANT_A.tenantId, spec.subscription, id)).toBe(3);
      expect(await inboxRows(TENANT_A.tenantId, v3.eventId)).toEqual(['applied']);
      for (const envelope of late) {
        expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['stale']);
      }
      expect(publisher.raw).toEqual([]);
    });
  });

  describe('gaps and out-of-order delivery', () => {
    it.each(SPECS)('applies a later $name full state across a version gap', async (spec) => {
      const id = newId();
      const [v1, v4] = versionedSequence(stateEnvelope(spec, id, 1), [1, 4], (n) => spec.state(id, n)) as [EventEnvelope<Payload>, EventEnvelope<Payload>];
      expect((await pushTo(t.app, spec.subscription, v1)).statusCode).toBe(204);

      const res = await pushTo(t.app, spec.subscription, v4);

      expect(res.statusCode).toBe(204);
      expect(await projection(spec, id)).toEqual(spec.rows(id, 4));
      expect(await lastVersion(TENANT_A.tenantId, spec.subscription, id)).toBe(4);
      expect(await inboxRows(TENANT_A.tenantId, v4.eventId)).toEqual(['applied']);
    });

    it.each(SPECS)('reaches the highest $name version’s state whether versions 1 to 4 arrive as 3, 1, 4, 2 or in order', async (spec) => {
      const shuffledId = newId();
      const orderedId = newId();
      const sequenceOf = (id: string): EventEnvelope<Payload>[] => versionedSequence(stateEnvelope(spec, id, 1), [1, 2, 3, 4], (n) => spec.state(id, n));
      const shuffled = sequenceOf(shuffledId);
      const ordered = sequenceOf(orderedId);

      const shuffledResponses = await deliverOutOfOrder(t.app, spec.subscription, shuffled, [2, 0, 3, 1]);
      const orderedResponses = await deliverOutOfOrder(t.app, spec.subscription, ordered, [0, 1, 2, 3]);

      expect([...shuffledResponses, ...orderedResponses].map((res) => res.statusCode)).toEqual(Array<number>(8).fill(204));
      expect(await projection(spec, shuffledId)).toEqual(spec.rows(shuffledId, 4));
      expect(await projection(spec, orderedId)).toEqual(spec.rows(orderedId, 4));
      expect(await lastVersion(TENANT_A.tenantId, spec.subscription, shuffledId)).toBe(4);
      expect(await lastVersion(TENANT_A.tenantId, spec.subscription, orderedId)).toBe(4);
      const statuses = async (envelopes: readonly EventEnvelope<Payload>[]): Promise<string[][]> =>
        Promise.all(envelopes.map((envelope) => inboxRows(TENANT_A.tenantId, envelope.eventId)));
      expect(await statuses(shuffled)).toEqual([['stale'], ['stale'], ['applied'], ['applied']]);
      expect(await statuses(ordered)).toEqual([['applied'], ['applied'], ['applied'], ['applied']]);
    });
  });

  describe('full row-set replace', () => {
    it('replaces a group’s permission rows with each later set, an empty set clearing them, and leaves other groups untouched', async () => {
      const groupId = newId();
      const otherId = newId();
      const other = deliveryOf(PERMISSION, permissionPayload(otherId, [[HOME, 'Editor']]), otherId);
      expect((await pushTo(t.app, PERMISSION.subscription, other)).statusCode).toBe(204);
      const otherRows = await projection(PERMISSION, otherId);
      expect(otherRows).toEqual([permissionRow(otherId, [HOME, 'Editor'])]);
      const sets: Grant[][] = [
        [
          [fixedId(NODE_PREFIX, 11), 'Editor'],
          [fixedId(NODE_PREFIX, 12), 'Read'],
        ],
        [[fixedId(NODE_PREFIX, 13), 'Author']],
        [],
      ];

      for (const [index, grants] of sets.entries()) {
        const envelope = deliveryOf(PERMISSION, permissionPayload(groupId, grants), groupId, index + 1);
        expect((await pushTo(t.app, PERMISSION.subscription, envelope)).statusCode).toBe(204);
        expect(await projection(PERMISSION, groupId)).toEqual(grants.map((grant) => permissionRow(groupId, grant)));
        expect(await projection(PERMISSION, otherId)).toEqual(otherRows);
      }
    });

    it('replaces a user’s memberships with each later set, an empty set clearing the user, and leaves other users untouched', async () => {
      const userId = newId();
      const otherId = newId();
      const [g1, g2, g3] = [1, 2, 3].map((n) => fixedId(GROUP_PREFIX, n)) as [string, string, string];
      const other = deliveryOf(MEMBERSHIP, membershipPayload(otherId, [g1]), otherId);
      expect((await pushTo(t.app, MEMBERSHIP.subscription, other)).statusCode).toBe(204);
      const otherRows = await projection(MEMBERSHIP, otherId);
      expect(otherRows).toEqual([membershipRow(otherId, g1)]);

      for (const [index, groupIds] of [[g1, g2], [g2, g3], []].entries()) {
        const envelope = deliveryOf(MEMBERSHIP, membershipPayload(userId, groupIds), userId, index + 1);
        expect((await pushTo(t.app, MEMBERSHIP.subscription, envelope)).statusCode).toBe(204);
        expect(await projection(MEMBERSHIP, userId)).toEqual(groupIds.map((groupId) => membershipRow(userId, groupId)));
        expect(await projection(MEMBERSHIP, otherId)).toEqual(otherRows);
      }
    });
  });

  describe('dead letters', () => {
    it.each<[string, DeadLetterReason, () => { spec: ProjectionSpec; envelope: TenantlessEnvelope }]>([
      [
        'a permission row without its grant type',
        'schema-invalid',
        () => {
          const groupId = newId();
          const payload = { groupId, siteId: SITE_A, rows: [{ contentId: HOME, siteId: SITE_A }] };
          return { spec: PERMISSION, envelope: deliveryOf(PERMISSION, payload, groupId) };
        },
      ],
      [
        'a group id that is not a CF UUID',
        'schema-invalid',
        () => ({ spec: GROUP, envelope: deliveryOf(GROUP, groupPayload('not-a-cf-uuid'), 'not-a-cf-uuid') }),
      ],
      ['a group envelope without a tenant', 'missing-tenant', () => ({ spec: GROUP, envelope: withoutTenant(stateEnvelope(GROUP, newId(), 1)) })],
      [
        'a membership envelope without a tenant',
        'missing-tenant',
        () => ({ spec: MEMBERSHIP, envelope: withoutTenant(stateEnvelope(MEMBERSHIP, newId(), 1)) }),
      ],
      [
        'a group envelope whose tenant is a site id rather than a UUID',
        'invalid-tenant',
        () => {
          const groupId = newId();
          return { spec: GROUP, envelope: deliveryOf(GROUP, groupPayload(groupId), groupId, 1, SITE_A) };
        },
      ],
      [
        'a group of a tenant the registry does not hold',
        'invalid-tenant',
        () => {
          const groupId = newId();
          const payload = groupPayload(groupId, { siteId: UNREGISTERED_SITE, poolTenantId: UNREGISTERED_TENANT });
          return { spec: GROUP, envelope: deliveryOf(GROUP, payload, groupId, 1, UNREGISTERED_TENANT) };
        },
      ],
      ...SPECS.map((spec): [string, DeadLetterReason, () => { spec: ProjectionSpec; envelope: TenantlessEnvelope }] => [
        `a tenant-a ${spec.name} state delivered under tenant B`,
        'tenant-mismatch',
        () => {
          const id = newId();
          return { spec, envelope: deliveryOf(spec, spec.state(id, 1), id, 1, TENANT_B.tenantId) };
        },
      ]),
      [
        'a tenant-a group whose pool tenant is tenant B',
        'tenant-mismatch',
        () => {
          const groupId = newId();
          return { spec: GROUP, envelope: deliveryOf(GROUP, groupPayload(groupId, { poolTenantId: TENANT_B.tenantId }), groupId) };
        },
      ],
    ])('dead-letters %s as %s, acks it and writes nothing', async (_label, reason, build) => {
      const { spec, envelope } = build();

      const res = await pushTo(t.app, spec.subscription, envelope);

      expect(res.statusCode).toBe(204);
      expect(publisher.raw).toHaveLength(1);
      expect(publisher.raw[0]?.topic).toBe(dlqTopicName(spec.subscription));
      expect(publisher.raw[0]?.message.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe(reason);
      expect(await traces(spec, envelope)).toEqual(NO_TRACES);
    });

    it('dead-letters a site change whose envelope tenant is not the site’s as tenant-mismatch, leaving the registry unchanged', async () => {
      const before = await registryRow(SITE_A);
      const envelope = siteEnvelope(sitePayload(SITE_A), 5, TENANT_B.tenantId);

      const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope);

      expect(res.statusCode).toBe(204);
      expect(publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).map((letter) => letter.reason)).toEqual(['tenant-mismatch']);
      expect(publisher.raw).toHaveLength(1);
      expect(await registryRow(SITE_A)).toEqual(before);
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual([]);
      expect(await inboxRows(TENANT_B.tenantId, envelope.eventId)).toEqual([]);
    });
  });

  describe('nack paths', () => {
    it('nacks a permission set the database rejects without a receipt or dead letter, and applies its redelivery once', async () => {
      const groupId = newId();
      const grants: Grant[] = [
        [HOME, 'Editor'],
        [fixedId(NODE_PREFIX, 21), REJECTED_TYPE],
      ];
      const envelope = deliveryOf(PERMISSION, permissionPayload(groupId, grants), groupId);
      const permissionTable = qualified(PERMISSION.table);
      await handle.adminPool.query(`ALTER TABLE ${permissionTable} ADD CONSTRAINT ${REJECT_CONSTRAINT} CHECK (type <> '${REJECTED_TYPE}')`);

      const nacked = await pushTo(t.app, PERMISSION.subscription, envelope).finally(() =>
        handle.adminPool.query(`ALTER TABLE ${permissionTable} DROP CONSTRAINT ${REJECT_CONSTRAINT}`),
      );

      expect(nacked.statusCode).toBeGreaterThanOrEqual(500);
      expect(await traces(PERMISSION, envelope)).toEqual(NO_TRACES);
      expect(await changelogCount(PERMISSION.table, groupId)).toBe(0);
      expect(publisher.raw).toEqual([]);

      const redelivered = await pushTo(t.app, PERMISSION.subscription, envelope);

      expect(redelivered.statusCode).toBe(204);
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
      expect(await projection(PERMISSION, groupId)).toEqual(grants.map((grant) => permissionRow(groupId, grant)));
      expect(await changelogCount(PERMISSION.table, groupId)).toBe(grants.length);
      expect(await lastVersion(TENANT_A.tenantId, PERMISSION.subscription, groupId)).toBe(1);
      expect(publisher.raw).toEqual([]);
    });

    it.runIf(GATED_SPECS.length > 0)(
      'nacks a projection delivery while its unit gate is closed and applies the redelivery once after reopening',
      async () => {
        for (const spec of GATED_SPECS) {
          const id = newId();
          const envelope = stateEnvelope(spec, id, 1);
          await closeGates(handle.app, { units: WRITTEN_UNITS, holderId: GATE_HOLDER });

          const nacked = await pushTo(t.app, spec.subscription, envelope).finally(() =>
            openGates(handle.app, { units: WRITTEN_UNITS, holderId: GATE_HOLDER }),
          );

          expect(nacked.statusCode).toBe(503);
          expect(await traces(spec, envelope)).toEqual(NO_TRACES);
          expect((await pushTo(t.app, spec.subscription, envelope)).statusCode).toBe(204);
          expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
          expect(await projection(spec, id)).toEqual(spec.rows(id, 1));
        }
      },
      120_000,
    );

    it.runIf(GATED_SPECS.length === 0)('applies group, permission and membership deliveries while every content unit gate is closed', async () => {
      await closeGates(handle.app, { units: CONTENT_UNITS, holderId: GATE_HOLDER });
      try {
        const gates = await readGates(handle.app, CONTENT_UNITS);
        expect(gates).toHaveLength(CONTENT_UNITS.length);
        expect(gates.every((gate) => gate.state === 'closed' && gate.holderId === GATE_HOLDER)).toBe(true);
        for (const spec of SPECS) {
          const id = newId();
          const envelope = stateEnvelope(spec, id, 1);
          expect((await pushTo(t.app, spec.subscription, envelope)).statusCode).toBe(204);
          expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual(['applied']);
          expect(await projection(spec, id)).toEqual(spec.rows(id, 1));
        }
      } finally {
        await openGates(handle.app, { units: CONTENT_UNITS, holderId: GATE_HOLDER });
      }
    });
  });

  describe('push credential', () => {
    it.each<[string, (subscription: string, envelope: EventEnvelope<Payload>) => Promise<{ statusCode: number }>]>([
      ['without the push key', (subscription, envelope) => t.app.inject({ method: 'POST', url: pushPath(subscription), payload: pushBodyOf(subscription, envelope) })],
      [
        'with a user token instead of the push key',
        async (subscription, envelope) =>
          t.app.inject({
            method: 'POST',
            url: pushPath(subscription),
            headers: await contentHeaders('s2', { site: SITE_A }),
            payload: pushBodyOf(subscription, envelope),
          }),
      ],
      ['with a wrong push key', (subscription, envelope) => pushTo(t.app, subscription, envelope, { key: 'not-the-push-key' })],
    ])('refuses a push %s before the consumer runs', async (_label, send) => {
      for (const spec of SPECS) {
        const id = newId();
        const envelope = stateEnvelope(spec, id, 1);

        const res = await send(spec.subscription, envelope);

        expect([401, 403]).toContain(res.statusCode);
        expect(await traces(spec, envelope)).toEqual(NO_TRACES);
      }
      expect(publisher.raw).toEqual([]);
    });
  });
});
