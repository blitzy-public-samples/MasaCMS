/** People's push consumers through the platform push route over a migrated throwaway schema: the group-name projection and the tenant registry. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONSUMER_AGGREGATE_VERSION_TABLE,
  INBOX_TABLE,
  compileTopicSchema,
  dlqTopicName,
  type DeadLetterReason,
  type EventEnvelope,
} from '@opt2/platform/events';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  ContractAssertionError,
  assertEventMatches,
  deliverDuplicate,
  deliverOutOfOrder,
  fixtureForSite,
  isAck,
  pushTo,
  registryPayloads,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type CapturedDeadLetter,
  type PushOptions,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC, groupChangedSchema, siteChangedSchema, type GroupChangedPayload } from '../../src/events/topics.js';
import { GROUP_NAME, type GroupNameRow } from '../../src/repo/tables.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/app.js';
import { DEFAULT_SITE, groupNameRow } from '../helpers/fixtures.js';

/** A `programs-sites.site.changed.v1` payload as its contract requires it. */
type SiteChangedPayload = {
  siteId: string;
  publicUserPoolId: string;
  privateUserPoolId: string;
  categoryPoolId: string;
  filePoolId: string;
  displayPoolId: string;
  contentPoolIds: string[];
  domains: string[];
};
type GroupEnvelope = EventEnvelope<GroupChangedPayload>;
type SiteEnvelope = EventEnvelope<SiteChangedPayload>;

type InboxRow = { status: string; subscription: string };

type RegistryRow = {
  site_id: string;
  tenant_id: string;
  public_user_pool_id: string | null;
  private_user_pool_id: string | null;
  category_pool_id: string | null;
  file_pool_id: string | null;
  display_pool_id: string | null;
  content_pool_ids: string[] | null;
  public_user_pool_tenant: string | null;
  private_user_pool_tenant: string | null;
  category_pool_tenant: string | null;
  file_pool_tenant: string | null;
  display_pool_tenant: string | null;
  content_pool_tenants: string[] | null;
  domains: string[] | null;
  aggregate_version: string;
};

/** What one delivery left behind across the probed tenants. */
type Traces = { inbox: number; versions: number; groups: number };

/** A delivery to dead-letter: its subscription, payload contract, envelope, push options and whether the contract accepts it. */
type DeadLetterCase = {
  subscription: string;
  payloadSchema: object;
  envelope: TenantlessEnvelope;
  options?: PushOptions;
  contractValid: boolean;
};

const UNREGISTERED_TENANT = randomUUID();
const PROBED_TENANTS = [...TENANT_LIST.map((fixture) => fixture.tenantId), DEFAULT_SITE.tenantId, UNREGISTERED_TENANT];
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
  'aggregate_version::text AS aggregate_version',
].join(', ');

/** Runs `fn` in {@link withPgApp}, failing instead of passing silently when PostgreSQL became unreachable after the suite gate. */
async function inPgApp(fn: (ctx: PgTestApp) => Promise<void>): Promise<void> {
  const outcome = await withPgApp(async (ctx) => {
    await fn(ctx);
    return true as const;
  });
  if (outcome !== true) throw new Error(outcome.reason);
}

/** `<throwaway schema>.<name>`. */
function table(ctx: PgTestApp, name: string): string {
  return `${ctx.schema.schema}.${name}`;
}

/** Rows of `sql` read through the admin pool under the row-level security of `tenantId`. */
async function tenantRows<R extends Record<string, unknown>>(ctx: PgTestApp, tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
  const client = await ctx.schema.adminPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return (await client.query<R>(sql, params)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Inbox receipts of `eventId` in `tenantId`. */
function inboxRows(ctx: PgTestApp, eventId: string, tenantId = TENANT_A.tenantId): Promise<InboxRow[]> {
  return tenantRows(ctx, tenantId, `SELECT status, subscription FROM ${table(ctx, INBOX_TABLE)} WHERE event_id = $1`, [eventId]);
}

/** The last applied version of `aggregateId` on `subscription` in `tenantId`, or undefined without ordering progress. */
async function lastVersion(ctx: PgTestApp, subscription: string, aggregateId: string, tenantId = TENANT_A.tenantId): Promise<string | null | undefined> {
  const rows = await tenantRows<{ last_version: string | null }>(
    ctx,
    tenantId,
    `SELECT last_version::text AS last_version FROM ${table(ctx, CONSUMER_AGGREGATE_VERSION_TABLE)}
      WHERE subscription = $1 AND aggregate_id = $2`,
    [subscription, aggregateId],
  );
  return rows[0]?.last_version;
}

/** The `group_name` projection rows of `groupId` in `tenantId`. */
function groupNames(ctx: PgTestApp, groupId: string, tenantId = TENANT_A.tenantId): Promise<GroupNameRow[]> {
  return tenantRows<GroupNameRow>(
    ctx,
    tenantId,
    `SELECT tenant_id, group_id, site_id, group_name, is_public, deleted, aggregate_version::text AS aggregate_version
       FROM ${table(ctx, GROUP_NAME.table)} WHERE group_id = $1`,
    [groupId],
  );
}

/** Every `tenant_registry` row by site id; the registry holds tenant metadata, so it has no row-level security. */
async function registryRows(ctx: PgTestApp): Promise<RegistryRow[]> {
  return (await ctx.schema.adminPool.query<RegistryRow>(`SELECT ${REGISTRY_COLUMNS} FROM ${table(ctx, 'tenant_registry')} ORDER BY site_id`)).rows;
}

/** The `tenant_registry` row of `siteId`, if any. */
async function registryRow(ctx: PgTestApp, siteId: string): Promise<RegistryRow | undefined> {
  return (await registryRows(ctx)).find((row) => row.site_id === siteId);
}

/** Inbox, version and projection rows that `envelope` left in every probed tenant. */
async function traces(ctx: PgTestApp, envelope: TenantlessEnvelope): Promise<Traces> {
  const counted: Traces = { inbox: 0, versions: 0, groups: 0 };
  for (const tenantId of PROBED_TENANTS) {
    const [row] = await tenantRows<Traces>(
      ctx,
      tenantId,
      `SELECT (SELECT count(*)::int FROM ${table(ctx, INBOX_TABLE)} WHERE event_id = $1) AS inbox,
              (SELECT count(*)::int FROM ${table(ctx, CONSUMER_AGGREGATE_VERSION_TABLE)} WHERE aggregate_id = $2) AS versions,
              (SELECT count(*)::int FROM ${table(ctx, GROUP_NAME.table)} WHERE group_id = $2) AS groups`,
      [envelope.eventId, envelope.aggregateId],
    );
    counted.inbox += row?.inbox ?? 0;
    counted.versions += row?.versions ?? 0;
    counted.groups += row?.groups ?? 0;
  }
  return counted;
}

/** Asserts that every envelope meets the platform envelope contract and `payloadSchema`. */
function assertContract(payloadSchema: object, envelopes: readonly TenantlessEnvelope[]): void {
  for (const envelope of envelopes) {
    expect(() => assertEventMatches(undefined, payloadSchema, envelope)).not.toThrow();
  }
}

/** Whether `envelope` meets the platform envelope contract and `payloadSchema`. */
function contractAccepts(payloadSchema: object, envelope: TenantlessEnvelope): boolean {
  try {
    assertEventMatches(undefined, payloadSchema, envelope);
    return true;
  } catch (err) {
    if (err instanceof ContractAssertionError) return false;
    throw err;
  }
}

/** A fresh CF-format group id, as the fixture builder generates it. */
function newGroupId(): string {
  return groupNameRow().group_id;
}

/** A full-state payload of private-pool group `groupId` of tenant-a, as identity publishes it. */
function groupPayload(groupId: string, overrides: Partial<GroupChangedPayload> = {}): GroupChangedPayload {
  return {
    groupId,
    siteId: TENANT_A.siteId,
    groupName: 'Editors',
    type: 1,
    isPublic: 0,
    poolTenantId: TENANT_A.tenantId,
    deleted: false,
    ...overrides,
  };
}

/** The group envelope of `payload` at `aggregateVersion` in `tenantId` (tenant-a by default). */
function groupEnvelope(payload: GroupChangedPayload, aggregateVersion = 1, tenantId = TENANT_A.tenantId): GroupEnvelope {
  return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId, aggregateId: payload.groupId, aggregateVersion, payload });
}

/** Group envelopes of `groupId` at each of `versions`, each with its own name and visibility. */
function groupSequence(groupId: string, versions: readonly number[]): GroupEnvelope[] {
  const envelopes = versionedSequence(groupEnvelope(groupPayload(groupId)), versions, (version) =>
    groupPayload(groupId, { groupName: `Editors v${String(version)}`, isPublic: version % 2 === 0 ? 1 : 0 }),
  );
  assertContract(groupChangedSchema, envelopes);
  return envelopes;
}

/** The `group_name` row a stored `payload` at `aggregateVersion` must leave. */
function projectionOf(payload: GroupChangedPayload, aggregateVersion: number): GroupNameRow {
  return groupNameRow({
    group_id: payload.groupId,
    site_id: payload.siteId,
    group_name: payload.groupName,
    is_public: payload.isPublic,
    deleted: false,
    aggregate_version: String(aggregateVersion),
  });
}

/** The tenant of a fixture site or of `default`; throws TypeError for any other site. */
function tenantOfSite(siteId: string): string {
  if (siteId === DEFAULT_SITE.siteId) return DEFAULT_SITE.tenantId;
  const fixture = fixtureForSite(siteId);
  if (fixture === undefined) throw new TypeError(`No tenant fixture for site ${siteId}`);
  return fixture.tenantId;
}

const siteValidator = compileTopicSchema<SiteChangedPayload>(siteChangedSchema);

/** Tenant-a's seeded registry payload, checked against the producer contract, with `overrides`. */
function sitePayload(overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
  const seeded = siteValidator.validatePayload(registryPayloads().find((payload) => payload.siteId === TENANT_A.siteId));
  if (!seeded.ok) throw new TypeError(`The seeded tenant-a site payload fails its contract: ${seeded.errors.join('; ')}`);
  return { ...seeded.value, ...overrides };
}

/** The site envelope of `payload` at `aggregateVersion`, in the tenant of its site. */
function siteEnvelope(payload: SiteChangedPayload, aggregateVersion: number): SiteEnvelope {
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: tenantOfSite(payload.siteId), aggregateId: payload.siteId, aggregateVersion, payload });
}

/** The registry row a stored `payload` at `aggregateVersion` must leave. */
function registryOf(payload: SiteChangedPayload, aggregateVersion: number): RegistryRow {
  return {
    site_id: payload.siteId,
    tenant_id: tenantOfSite(payload.siteId),
    public_user_pool_id: payload.publicUserPoolId,
    private_user_pool_id: payload.privateUserPoolId,
    category_pool_id: payload.categoryPoolId,
    file_pool_id: payload.filePoolId,
    display_pool_id: payload.displayPoolId,
    content_pool_ids: payload.contentPoolIds,
    public_user_pool_tenant: tenantOfSite(payload.publicUserPoolId),
    private_user_pool_tenant: tenantOfSite(payload.privateUserPoolId),
    category_pool_tenant: tenantOfSite(payload.categoryPoolId),
    file_pool_tenant: tenantOfSite(payload.filePoolId),
    display_pool_tenant: tenantOfSite(payload.displayPoolId),
    content_pool_tenants: payload.contentPoolIds.map(tenantOfSite),
    domains: payload.domains,
    aggregate_version: String(aggregateVersion),
  };
}

const APPLIED_GROUP: InboxRow = { status: 'applied', subscription: GROUP_NAME_SUBSCRIPTION };
const STALE_GROUP: InboxRow = { status: 'stale', subscription: GROUP_NAME_SUBSCRIPTION };
const APPLIED_SITE: InboxRow = { status: 'applied', subscription: SITE_CHANGED_SUBSCRIPTION };

describe.skipIf(!PG_AVAILABLE)('people consumers', () => {
  describe(`${GROUP_CHANGED_TOPIC} on ${GROUP_NAME_SUBSCRIPTION}`, () => {
    it('applies a delivery repeated three times once: one inbox receipt, one projection row and version 1', () =>
      inPgApp(async (ctx) => {
        const payload = groupPayload(newGroupId());
        const envelope = groupEnvelope(payload);
        assertContract(groupChangedSchema, [envelope]);

        const responses = await deliverDuplicate(ctx.app, GROUP_NAME_SUBSCRIPTION, envelope, 3);

        expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204]);
        expect(await inboxRows(ctx, envelope.eventId)).toEqual([APPLIED_GROUP]);
        expect(await groupNames(ctx, payload.groupId)).toEqual([projectionOf(payload, 1)]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, payload.groupId)).toBe('1');
        expect(ctx.publisher.raw).toEqual([]);
      }));

    it.each<[number[], string[]]>([
      [[1, 0, 2], ['stale', 'applied', 'applied']],
      [[2, 0, 1], ['stale', 'stale', 'applied']],
      [[0, 2, 1], ['applied', 'stale', 'applied']],
    ])('reaches the version 3 projection from versions 1 to 3 delivered in index order %j, with receipts %j', (order, statuses) =>
      inPgApp(async (ctx) => {
        const groupId = newGroupId();
        const envelopes = groupSequence(groupId, [1, 2, 3]);
        const [, , v3] = envelopes as [GroupEnvelope, GroupEnvelope, GroupEnvelope];

        const responses = await deliverOutOfOrder(ctx.app, GROUP_NAME_SUBSCRIPTION, envelopes, order);

        expect(responses.map(isAck)).toEqual([true, true, true]);
        expect(await groupNames(ctx, groupId)).toEqual([projectionOf(v3.payload, 3)]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, groupId)).toBe('3');
        const receipts = [];
        for (const envelope of envelopes) receipts.push((await inboxRows(ctx, envelope.eventId)).map((row) => row.status));
        expect(receipts).toEqual(statuses.map((status) => [status]));
      }));

    it('acks a state at or below the applied version under a fresh event id as stale, keeping the applied projection', () =>
      inPgApp(async (ctx) => {
        const groupId = newGroupId();
        const [v3] = groupSequence(groupId, [3]) as [GroupEnvelope];
        const late = versionedSequence(v3, [3, 2], (version) => groupPayload(groupId, { groupName: `Late v${String(version)}`, isPublic: 1 }));
        assertContract(groupChangedSchema, late);
        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, v3)).statusCode).toBe(204);

        const responses = await deliverOutOfOrder(ctx.app, GROUP_NAME_SUBSCRIPTION, late, [0, 1]);

        expect(responses.map((res) => res.statusCode)).toEqual([204, 204]);
        expect(await groupNames(ctx, groupId)).toEqual([projectionOf(v3.payload, 3)]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, groupId)).toBe('3');
        for (const envelope of late) expect(await inboxRows(ctx, envelope.eventId)).toEqual([STALE_GROUP]);
        expect(ctx.publisher.raw).toEqual([]);
      }));

    it('applies a later full state across a version gap', () =>
      inPgApp(async (ctx) => {
        const groupId = newGroupId();
        const [v1, v4] = groupSequence(groupId, [1, 4]) as [GroupEnvelope, GroupEnvelope];
        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, v1)).statusCode).toBe(204);

        const res = await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, v4);

        expect(res.statusCode).toBe(204);
        expect(await groupNames(ctx, groupId)).toEqual([projectionOf(v4.payload, 4)]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, groupId)).toBe('4');
        expect(await inboxRows(ctx, v4.eventId)).toEqual([APPLIED_GROUP]);
      }));

    it('removes the projection when a later state marks the group deleted, and a stale state does not restore it', () =>
      inPgApp(async (ctx) => {
        const groupId = newGroupId();
        const [created] = groupSequence(groupId, [1]) as [GroupEnvelope];
        const deleted = groupEnvelope(groupPayload(groupId, { deleted: true }), 2);
        const stale = groupEnvelope(groupPayload(groupId, { groupName: 'Restored' }), 1);
        assertContract(groupChangedSchema, [deleted, stale]);
        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, created)).statusCode).toBe(204);
        expect(await groupNames(ctx, groupId)).toEqual([projectionOf(created.payload, 1)]);

        const removal = await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, deleted);

        expect(removal.statusCode).toBe(204);
        expect(await groupNames(ctx, groupId)).toEqual([]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, groupId)).toBe('2');
        expect(await inboxRows(ctx, deleted.eventId)).toEqual([APPLIED_GROUP]);

        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, stale)).statusCode).toBe(204);
        expect(await groupNames(ctx, groupId)).toEqual([]);
        expect(await inboxRows(ctx, stale.eventId)).toEqual([STALE_GROUP]);
      }));

    it('nacks a delivery whose apply fails at the database, committing no receipt, and applies its redelivery once', () =>
      inPgApp(async (ctx) => {
        const payload = groupPayload(newGroupId());
        const envelope = groupEnvelope(payload);
        assertContract(groupChangedSchema, [envelope]);
        const groupTable = table(ctx, GROUP_NAME.table);
        const appRole = `"${ctx.schema.roles.app}"`;

        // buildApp creates the consumer's repository internally, so the failure is injected through the app role's privileges.
        await ctx.schema.adminPool.query(`REVOKE INSERT, UPDATE ON ${groupTable} FROM ${appRole}`);
        const nacked = await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, envelope).finally(() =>
          ctx.schema.adminPool.query(`GRANT INSERT, UPDATE ON ${groupTable} TO ${appRole}`),
        );

        expect(isAck(nacked)).toBe(false);
        expect(nacked.statusCode).toBe(500);
        expect(await traces(ctx, envelope)).toEqual({ inbox: 0, versions: 0, groups: 0 });
        expect(ctx.publisher.raw).toEqual([]);

        const redelivered = await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, envelope);

        expect(redelivered.statusCode).toBe(204);
        expect(await inboxRows(ctx, envelope.eventId)).toEqual([APPLIED_GROUP]);
        expect(await groupNames(ctx, payload.groupId)).toEqual([projectionOf(payload, 1)]);
        expect(await lastVersion(ctx, GROUP_NAME_SUBSCRIPTION, payload.groupId)).toBe('1');
        expect(ctx.publisher.raw).toEqual([]);
      }));
  });

  describe(`${SITE_CHANGED_TOPIC} on ${SITE_CHANGED_SUBSCRIPTION}`, () => {
    it('applies a site change repeated three times once: one inbox receipt and the changed pool in the registry', () =>
      inPgApp(async (ctx) => {
        const payload = sitePayload({ publicUserPoolId: TENANT_A.siteId, domains: ['a2.opt2.test'] });
        const envelope = siteEnvelope(payload, 2);
        assertContract(siteChangedSchema, [envelope]);

        const responses = await deliverDuplicate(ctx.app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

        expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204]);
        expect(await registryRow(ctx, TENANT_A.siteId)).toEqual(registryOf(payload, 2));
        expect(await inboxRows(ctx, envelope.eventId)).toEqual([APPLIED_SITE]);
        expect(await lastVersion(ctx, SITE_CHANGED_SUBSCRIPTION, TENANT_A.siteId)).toBe('2');
        expect(ctx.publisher.raw).toEqual([]);
      }));

    it('reaches the last registry state from site versions 2 to 4 delivered 4, 2, 3, acking the older ones as stale', () =>
      inPgApp(async (ctx) => {
        const changes: Readonly<Record<number, Partial<SiteChangedPayload>>> = {
          2: { publicUserPoolId: TENANT_A.siteId, domains: ['a2.opt2.test'] },
          3: { filePoolId: TENANT_A.siteId, domains: ['a3.opt2.test'] },
          4: { categoryPoolId: TENANT_A.siteId, contentPoolIds: [TENANT_A.siteId, TENANT_UMBRELLA.siteId], domains: ['a4.opt2.test'] },
        };
        const envelopes = versionedSequence(siteEnvelope(sitePayload(), 2), [2, 3, 4], (version) => sitePayload(changes[version]));
        assertContract(siteChangedSchema, envelopes);
        const [v2, v3, v4] = envelopes as [SiteEnvelope, SiteEnvelope, SiteEnvelope];

        const responses = await deliverOutOfOrder(ctx.app, SITE_CHANGED_SUBSCRIPTION, envelopes, [2, 0, 1]);

        expect(responses.map(isAck)).toEqual([true, true, true]);
        expect(await registryRow(ctx, TENANT_A.siteId)).toEqual(registryOf(v4.payload, 4));
        expect(await lastVersion(ctx, SITE_CHANGED_SUBSCRIPTION, TENANT_A.siteId)).toBe('4');
        expect(await inboxRows(ctx, v4.eventId)).toEqual([APPLIED_SITE]);
        for (const stale of [v2, v3]) {
          expect(await inboxRows(ctx, stale.eventId)).toEqual([{ status: 'stale', subscription: SITE_CHANGED_SUBSCRIPTION }]);
        }
      }));

    it('registers a site the registry lacks without a registry re-check, after which its groups pass the group re-check', () =>
      inPgApp(async (ctx) => {
        const siteId = DEFAULT_SITE.siteId;
        const group = groupPayload(newGroupId(), { siteId, poolTenantId: DEFAULT_SITE.tenantId });
        const groupDelivery = groupEnvelope(group, 1, DEFAULT_SITE.tenantId);
        const site = sitePayload({
          siteId,
          publicUserPoolId: siteId,
          privateUserPoolId: siteId,
          categoryPoolId: siteId,
          filePoolId: siteId,
          displayPoolId: siteId,
          contentPoolIds: [siteId],
          domains: [`${siteId}.opt2.test`],
        });
        const siteDelivery = siteEnvelope(site, 1);
        assertContract(groupChangedSchema, [groupDelivery]);
        assertContract(siteChangedSchema, [siteDelivery]);

        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, groupDelivery)).statusCode).toBe(204);
        expect(ctx.publisher.deadLetters(GROUP_NAME_SUBSCRIPTION).map((letter) => letter.reason)).toEqual(['invalid-tenant']);

        expect((await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, siteDelivery)).statusCode).toBe(204);
        expect(await registryRow(ctx, siteId)).toEqual(registryOf(site, 1));
        expect(await inboxRows(ctx, siteDelivery.eventId, DEFAULT_SITE.tenantId)).toEqual([APPLIED_SITE]);

        expect((await pushTo(ctx.app, GROUP_NAME_SUBSCRIPTION, groupDelivery)).statusCode).toBe(204);
        expect(await groupNames(ctx, group.groupId, DEFAULT_SITE.tenantId)).toEqual([projectionOf(group, 1)]);
        expect(await inboxRows(ctx, groupDelivery.eventId, DEFAULT_SITE.tenantId)).toEqual([APPLIED_GROUP]);
        expect(ctx.publisher.raw).toHaveLength(1);
      }));
  });

  describe('dead letters', () => {
    const group = (envelope: TenantlessEnvelope, contractValid: boolean, options?: PushOptions): DeadLetterCase => ({
      subscription: GROUP_NAME_SUBSCRIPTION,
      payloadSchema: groupChangedSchema,
      envelope,
      contractValid,
      ...(options === undefined ? {} : { options }),
    });
    const site = (envelope: TenantlessEnvelope, contractValid: boolean): DeadLetterCase => ({
      subscription: SITE_CHANGED_SUBSCRIPTION,
      payloadSchema: siteChangedSchema,
      envelope,
      contractValid,
    });
    const changedSite = (): SiteChangedPayload => sitePayload({ publicUserPoolId: TENANT_A.siteId });

    it.each<[string, DeadLetterReason, () => DeadLetterCase]>([
      ['a group envelope without a tenant', 'missing-tenant', () => group(withoutTenant(groupEnvelope(groupPayload(newGroupId()))), false)],
      [
        'a group envelope whose tenant is a site id rather than a UUID',
        'invalid-tenant',
        () => group(groupEnvelope(groupPayload(newGroupId()), 1, TENANT_A.siteId), false),
      ],
      [
        'a group of a tenant the registry does not hold',
        'invalid-tenant',
        () => group(groupEnvelope(groupPayload(newGroupId(), { poolTenantId: UNREGISTERED_TENANT }), 1, UNREGISTERED_TENANT), true),
      ],
      [
        'a group payload without its required groupName',
        'schema-invalid',
        () => {
          const { groupName: _omitted, ...payload } = groupPayload(newGroupId());
          return group(testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: payload.groupId, payload }), false);
        },
      ],
      [
        'a group of pool B delivered under tenant A',
        'tenant-mismatch',
        () => group(groupEnvelope(groupPayload(newGroupId(), { siteId: TENANT_B.siteId, poolTenantId: TENANT_B.tenantId })), true),
      ],
      [
        'a tenantId attribute other than the envelope tenant',
        'tenant-mismatch',
        () => group(groupEnvelope(groupPayload(newGroupId())), true, { attributes: { tenantId: TENANT_B.tenantId } }),
      ],
      ['a site envelope without a tenant', 'missing-tenant', () => site(withoutTenant(siteEnvelope(changedSite(), 2)), false)],
      [
        'a site payload without its required contentPoolIds',
        'schema-invalid',
        () => {
          const { contentPoolIds: _omitted, ...payload } = changedSite();
          return site(testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: payload.siteId, aggregateVersion: 2, payload }), false);
        },
      ],
      [
        'a site change whose aggregate is another site',
        'tenant-mismatch',
        () => site({ ...siteEnvelope(changedSite(), 2), aggregateId: TENANT_B.siteId }, true),
      ],
    ])('dead-letters %s as %s, acks it and applies nothing', (_case, reason, build) =>
      inPgApp(async (ctx) => {
        const { subscription, payloadSchema, envelope, options, contractValid } = build();
        expect(contractAccepts(payloadSchema, envelope)).toBe(contractValid);
        const registry = await registryRows(ctx);

        const res = await pushTo(ctx.app, subscription, envelope, options);

        expect(res.statusCode).toBe(204);
        const letters = ctx.publisher.deadLetters(subscription);
        expect(letters).toHaveLength(1);
        const [letter] = letters as [CapturedDeadLetter];
        expect(letter).toMatchObject({ topic: dlqTopicName(subscription), reason });
        expect(letter.message.attributes).toMatchObject({ reason, eventId: envelope.eventId });
        expect(letter.message.orderingKey).toBe(envelope.aggregateId);
        expect(JSON.parse(letter.message.data.toString('utf8'))).toEqual(envelope);
        expect(ctx.publisher.raw).toHaveLength(1);
        expect(await traces(ctx, envelope)).toEqual({ inbox: 0, versions: 0, groups: 0 });
        expect(await registryRows(ctx)).toEqual(registry);
      }),
    );
  });
});
