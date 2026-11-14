// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPushBody, encodeEnvelope, envelopeAttributes, pushPath, type EventEnvelope } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantDbFromPool, type SiteChangedPayload, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  TEST_PUSH_KEY,
  createCapturingPublisher,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  mintUserToken,
  pgAvailable,
  pushKeyQuery,
  pushTo,
  testEnvelope,
  withoutTenant,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

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
  updated_at: Date;
};

type InboxRow = { event_id: string; status: string };

/** Where a refused push is sent and the `authorization` header it carries, if any. */
type PushCredential = { url: string; authorization?: string };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const DLQ_TOPIC = 'finance.programs-sites.site.changed.v1.dlq';
const WRONG_PUSH_KEY = `${TEST_PUSH_KEY.slice(0, -1)}${TEST_PUSH_KEY.endsWith('x') ? 'y' : 'x'}`;

// An unset PG_HOST skips the suite without probing the server.
const pgReady = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** The tenant-a site as the fixture registry holds it: public user, category, file and display pools in umbrella, the rest its own. */
function sitePayload(overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
  return {
    siteId: TENANT_A.siteId,
    publicUserPoolId: TENANT_UMBRELLA.siteId,
    privateUserPoolId: TENANT_A.siteId,
    categoryPoolId: TENANT_UMBRELLA.siteId,
    filePoolId: TENANT_UMBRELLA.siteId,
    displayPoolId: TENANT_UMBRELLA.siteId,
    contentPoolIds: [TENANT_A.siteId],
    domains: ['tenant-a.opt2.local'],
    ...overrides,
  };
}

/** A site.changed envelope of the tenant-a site at `version`, under `tenantId`. */
function siteEnvelope(
  version: number,
  payload: SiteChangedPayload = sitePayload(),
  tenantId: string = TENANT_A.tenantId,
): EventEnvelope<SiteChangedPayload> {
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: TENANT_A.siteId, aggregateVersion: version, payload });
}

/** Inbox status keyed by event id; event ids are unique per tenant. */
function statusByEvent(rows: readonly InboxRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
}

describe.skipIf(!pgReady)('finance consumes programs-sites.site.changed.v1', () => {
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let publisher: CapturingPublisher;
  let app: TestApp['app'];

  const table = (name: string): string => `${handle.schema}.${name}`;

  /** Every tenant_registry row; the registry is non-tenant metadata, read without a tenant. */
  async function registryRows(): Promise<RegistryRow[]> {
    const { rows } = await handle.app.withMetadata((tx) =>
      tx.query<RegistryRow>(`SELECT * FROM ${table('tenant_registry')} ORDER BY site_id`),
    );
    return rows;
  }

  /** Inbox receipts of `tenantId`, read under its forced RLS. */
  async function inboxRows(tenantId: string): Promise<InboxRow[]> {
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<InboxRow>(`SELECT event_id::text AS event_id, status FROM ${table('inbox')} ORDER BY received_at, event_id`),
    );
    return rows;
  }

  /** Last applied versions of the tenant-a site aggregate on finance's subscription, under `tenantId`. */
  async function lastVersions(tenantId: string): Promise<(number | null)[]> {
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<{ last_version: string | null }>(
        `SELECT last_version FROM ${table('consumer_aggregate_version')} WHERE subscription = $1 AND aggregate_id = $2`,
        [SITE_CHANGED_SUBSCRIPTION, TENANT_A.siteId],
      ),
    );
    return rows.map((row) => (row.last_version === null ? null : Number(row.last_version)));
  }

  /** Raw publishes as topic, `reason` attribute and the event id of the forwarded message bytes. */
  function rawPublishes(): Array<{ topic: string; reason: string | undefined; eventId: unknown }> {
    return publisher.raw.map(({ topic, message }) => ({
      topic,
      reason: message.attributes.reason,
      eventId: (JSON.parse(message.data.toString('utf8')) as { eventId?: unknown }).eventId,
    }));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: MIGRATIONS_DIR });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    publisher = createCapturingPublisher();
    ({ app } = await buildTestApp({ db: handle.app, stagingDb, publisher }));
  });

  afterAll(async () => {
    await app?.close();
    await stagingDb?.end();
    await handle?.drop();
  });

  beforeEach(async () => {
    publisher.clear();
    const client = await handle.migratorPool.connect();
    try {
      await client.query(`SET ROLE ${handle.roles.owner}`);
      await client.query(`TRUNCATE ${table('inbox')}, ${table('consumer_aggregate_version')}, ${table('tenant_registry')}`);
      await client.query('RESET ROLE');
      client.release();
    } catch (err) {
      // Destroys the connection, so a session still holding the owner role never returns to the pool.
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  });

  it('subscribes as finance.programs-sites.site.changed.v1 on its push path', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('finance.programs-sites.site.changed.v1');
    expect(pushPath(SITE_CHANGED_SUBSCRIPTION)).toBe('/internal/v1/events/finance.programs-sites.site.changed.v1');
  });

  it('applies a pushed site into tenant_registry with every pool resolved to its tenant, publishing nothing', async () => {
    const envelope = siteEnvelope(1);

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    const [row, ...others] = await registryRows();
    expect(others).toStrictEqual([]);
    expect(row).toMatchObject({
      site_id: TENANT_A.siteId,
      tenant_id: TENANT_A.tenantId,
      public_user_pool_id: TENANT_UMBRELLA.siteId,
      private_user_pool_id: TENANT_A.siteId,
      category_pool_id: TENANT_UMBRELLA.siteId,
      file_pool_id: TENANT_UMBRELLA.siteId,
      display_pool_id: TENANT_UMBRELLA.siteId,
      content_pool_ids: [TENANT_A.siteId],
      public_user_pool_tenant: TENANT_UMBRELLA.tenantId,
      private_user_pool_tenant: TENANT_A.tenantId,
      category_pool_tenant: TENANT_UMBRELLA.tenantId,
      file_pool_tenant: TENANT_UMBRELLA.tenantId,
      display_pool_tenant: TENANT_UMBRELLA.tenantId,
      content_pool_tenants: [TENANT_A.tenantId],
      domains: ['tenant-a.opt2.local'],
    });
    expect(Number(row?.aggregate_version)).toBe(1);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
    expect(publisher.published).toStrictEqual([]);
    expect(publisher.raw).toStrictEqual([]);
  });

  it('applies a delivery repeated three times once', async () => {
    const envelope = siteEnvelope(1);

    const responses = await deliverDuplicate(app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204, 204]);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
    const rows = await registryRows();
    expect(rows.map((row) => [row.site_id, Number(row.aggregate_version)])).toStrictEqual([[TENANT_A.siteId, 1]]);
    expect(await lastVersions(TENANT_A.tenantId)).toStrictEqual([1]);
  });

  it('acks a version older than the applied one as stale and keeps the newer state', async () => {
    const v1 = siteEnvelope(1, sitePayload({ domains: ['v1.tenant-a.opt2.local'] }));
    const v2 = siteEnvelope(2, sitePayload({ domains: ['v2.tenant-a.opt2.local'] }));

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, [v1, v2], [1, 0]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const rows = await registryRows();
    expect(rows.map((row) => [row.domains, Number(row.aggregate_version)])).toStrictEqual([[['v2.tenant-a.opt2.local'], 2]]);
    expect(statusByEvent(await inboxRows(TENANT_A.tenantId))).toStrictEqual({ [v2.eventId]: 'applied', [v1.eventId]: 'stale' });
    expect(await lastVersions(TENANT_A.tenantId)).toStrictEqual([2]);
  });

  it('applies a version that skips over a missing one', async () => {
    const v1 = siteEnvelope(1, sitePayload({ domains: ['v1.tenant-a.opt2.local'] }));
    const v3 = siteEnvelope(3, sitePayload({ domains: ['v3.tenant-a.opt2.local'], displayPoolId: TENANT_A.siteId }));

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, [v1, v3], [0, 1]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const [row, ...others] = await registryRows();
    expect(others).toStrictEqual([]);
    expect(row).toMatchObject({
      domains: ['v3.tenant-a.opt2.local'],
      display_pool_id: TENANT_A.siteId,
      display_pool_tenant: TENANT_A.tenantId,
    });
    expect(Number(row?.aggregate_version)).toBe(3);
    expect(statusByEvent(await inboxRows(TENANT_A.tenantId))).toStrictEqual({ [v1.eventId]: 'applied', [v3.eventId]: 'applied' });
    expect(await lastVersions(TENANT_A.tenantId)).toStrictEqual([3]);
  });

  it('dead-letters an envelope without a tenant as missing-tenant and acks it', async () => {
    const envelope = siteEnvelope(1);

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, withoutTenant(envelope));

    expect(res.statusCode).toBe(204);
    expect(rawPublishes()).toStrictEqual([{ topic: DLQ_TOPIC, reason: 'missing-tenant', eventId: envelope.eventId }]);
    expect(publisher.published).toStrictEqual([]);
    expect(await registryRows()).toStrictEqual([]);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([]);
  });

  it('dead-letters a site whose envelope tenant is another tenant as tenant-mismatch, rolling back its receipt', async () => {
    const envelope = siteEnvelope(1, sitePayload(), TENANT_B.tenantId);

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    expect(rawPublishes()).toStrictEqual([{ topic: DLQ_TOPIC, reason: 'tenant-mismatch', eventId: envelope.eventId }]);
    expect(publisher.published).toStrictEqual([]);
    expect(await registryRows()).toStrictEqual([]);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([]);
    expect(await inboxRows(TENANT_B.tenantId)).toStrictEqual([]);
    expect(await lastVersions(TENANT_B.tenantId)).toStrictEqual([]);
  });

  it.each<[string, () => Promise<PushCredential>]>([
    [
      'a user token instead of the push key',
      async () => ({
        url: pushPath(SITE_CHANGED_SUBSCRIPTION),
        authorization: `Bearer ${await mintUserToken({ sub: 'opt2-test-user', site: TENANT_A.siteId, roles: ['s2'], s2: true })}`,
      }),
    ],
    ['no push key', async () => ({ url: pushPath(SITE_CHANGED_SUBSCRIPTION) })],
    ['a wrong push key of the right length', async () => ({ url: `${pushPath(SITE_CHANGED_SUBSCRIPTION)}?${pushKeyQuery(WRONG_PUSH_KEY)}` })],
  ])('refuses a push carrying %s before the consumer runs', async (_label, credential) => {
    const { url, authorization } = await credential();
    const envelope = siteEnvelope(1);

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) },
      payload: buildPushBody({
        data: encodeEnvelope(envelope),
        attributes: envelopeAttributes(envelope),
        messageId: '1',
        subscription: SITE_CHANGED_SUBSCRIPTION,
      }),
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([]);
    expect(await registryRows()).toStrictEqual([]);
    expect(publisher.raw).toStrictEqual([]);
  });
});
