// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type DeadLetterReason, type EventEnvelope } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  deliverDuplicate,
  deliverOutOfOrder,
  pushTo,
  registryPayloads,
  testEnvelope,
  versionedSequence,
  withEnvelopeTenant,
  withoutTenant,
  type CapturingPublisher,
  type TenantFixture,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { buildTestApp, createTimesheetsSchema, describeWithPg, type TestApp } from '../helpers/app.js';

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

type SiteEnvelope = EventEnvelope<SiteChangedPayload>;

const DLQ_TOPIC = 'timesheets.programs-sites.site.changed.v1.dlq';

/** The fixture registry payload of `fixture`'s site with `overrides` applied. */
function sitePayload(fixture: TenantFixture, overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
  const base = registryPayloads().find((payload) => payload.siteId === fixture.siteId);
  if (base === undefined) throw new TypeError(`registryPayloads has no ${fixture.siteId} payload`);
  return { ...base, ...overrides };
}

/** A site.changed envelope of `payload`'s site at `version`, under that site's tenant. */
function siteEnvelope(payload: SiteChangedPayload, version = 1): SiteEnvelope {
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId: tenantIdForSite(payload.siteId),
    aggregateId: payload.siteId,
    aggregateVersion: version,
    payload,
  });
}

/** The registry row of a site that owns every one of its pools. */
function selfPooledRow(fixture: TenantFixture): Partial<RegistryRow> {
  const own = fixture.siteId;
  const tenant = tenantIdForSite(own);
  return {
    site_id: own,
    tenant_id: tenant,
    public_user_pool_id: own,
    private_user_pool_id: own,
    category_pool_id: own,
    file_pool_id: own,
    display_pool_id: own,
    content_pool_ids: [own],
    public_user_pool_tenant: tenant,
    private_user_pool_tenant: tenant,
    category_pool_tenant: tenant,
    file_pool_tenant: tenant,
    display_pool_tenant: tenant,
    content_pool_tenants: [tenant],
    domains: [`${own}.opt2.test`],
  };
}

/** Inbox status keyed by event id, independent of receipt order. */
function statusByEvent(rows: readonly InboxRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
}

/** tenant-a's payload at `version`: v1 keeps its public user pool in umbrella; later versions own it and change domains. */
function tenantAPayloadAt(version: number): SiteChangedPayload {
  const domains = [`v${String(version)}.tenant-a.opt2.test`];
  return sitePayload(TENANT_A, version === 1 ? { domains } : { domains, publicUserPoolId: TENANT_A.siteId });
}

describeWithPg('timesheets site.changed consumer', () => {
  let handle: ThrowawaySchema;
  let publisher: CapturingPublisher;
  let app: TestApp['app'];

  const table = (name: string): string => `${handle.schema}.${name}`;

  /** Every tenant_registry row ordered by site id; the registry is non-tenant metadata, read without a tenant. */
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

  /** Last applied versions of `siteId`'s aggregate on the timesheets subscription, read under `tenantId`. */
  async function lastVersions(tenantId: string, siteId: string): Promise<(number | null)[]> {
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<{ last_version: string | null }>(
        `SELECT last_version FROM ${table('consumer_aggregate_version')} WHERE subscription = $1 AND aggregate_id = $2`,
        [SITE_CHANGED_SUBSCRIPTION, siteId],
      ),
    );
    return rows.map((row) => (row.last_version === null ? null : Number(row.last_version)));
  }

  /** Raw publishes as topic, `reason` attribute and the event id inside the forwarded message bytes. */
  function rawPublishes(): Array<{ topic: string; reason: string | undefined; eventId: unknown }> {
    return publisher.raw.map(({ topic, message }) => ({
      topic,
      reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE],
      eventId: (JSON.parse(message.data.toString('utf8')) as { eventId?: unknown }).eventId,
    }));
  }

  beforeAll(async () => {
    handle = await createTimesheetsSchema({ registry: false });
    publisher = createCapturingPublisher();
    ({ app } = await buildTestApp({ db: handle.app, publisher }));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await handle?.drop();
    }
  });

  beforeEach(async () => {
    publisher.clear();
    await handle.adminPool.query(`TRUNCATE ${table('tenant_registry')}, ${table('inbox')}, ${table('consumer_aggregate_version')}`);
  });

  it('registers every pushed site under its own tenant with each pool resolved to its tenant, publishing nothing', async () => {
    const envelopes = registryPayloads().map((payload) => siteEnvelope(payload));

    const statuses: number[] = [];
    for (const envelope of envelopes) statuses.push((await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope)).statusCode);

    expect(statuses).toStrictEqual([204, 204, 204]);
    const rows = await registryRows();
    expect(rows).toMatchObject([
      {
        site_id: TENANT_A.siteId,
        tenant_id: tenantIdForSite(TENANT_A.siteId),
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
        domains: [`${TENANT_A.siteId}.opt2.test`],
      },
      selfPooledRow(TENANT_B),
      selfPooledRow(TENANT_UMBRELLA),
    ]);
    expect(rows.map((row) => Number(row.aggregate_version))).toStrictEqual([1, 1, 1]);
    for (const envelope of envelopes) {
      expect(await inboxRows(envelope.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
    }
    expect(publisher.published).toStrictEqual([]);
    expect(publisher.raw).toStrictEqual([]);
  });

  it('applies a delivery repeated three times once', async () => {
    const envelope = siteEnvelope(sitePayload(TENANT_A));

    const responses = await deliverDuplicate(app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204, 204]);
    const rows = await registryRows();
    expect(rows.map((row) => [row.site_id, Number(row.aggregate_version)])).toStrictEqual([[TENANT_A.siteId, 1]]);
    expect(await inboxRows(TENANT_A.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
    expect(await lastVersions(TENANT_A.tenantId, TENANT_A.siteId)).toStrictEqual([1]);
  });

  it.each<{ name: string; versions: [number, number]; order: [number, number]; final: number; outcomes: [string, string] }>([
    {
      name: 'acks an older version delivered after a newer one as stale and keeps the newer state',
      versions: [1, 2],
      order: [1, 0],
      final: 2,
      outcomes: ['stale', 'applied'],
    },
    {
      name: 'applies a version that skips over a missing one',
      versions: [1, 3],
      order: [0, 1],
      final: 3,
      outcomes: ['applied', 'applied'],
    },
  ])('$name', async ({ versions, order, final, outcomes }) => {
    const envelopes = versionedSequence(siteEnvelope(tenantAPayloadAt(1)), versions, tenantAPayloadAt);

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, envelopes, order);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const [row, ...others] = await registryRows();
    expect(others).toStrictEqual([]);
    expect(row).toMatchObject({
      site_id: TENANT_A.siteId,
      domains: [`v${String(final)}.tenant-a.opt2.test`],
      public_user_pool_id: TENANT_A.siteId,
      public_user_pool_tenant: TENANT_A.tenantId,
    });
    expect(Number(row?.aggregate_version)).toBe(final);
    expect(await lastVersions(TENANT_A.tenantId, TENANT_A.siteId)).toStrictEqual([final]);
    expect(statusByEvent(await inboxRows(TENANT_A.tenantId))).toStrictEqual(
      Object.fromEntries(envelopes.map((envelope, index) => [envelope.eventId, outcomes[index]])),
    );
  });

  it.each<{ name: string; reason: DeadLetterReason; send: (envelope: SiteEnvelope) => TenantlessEnvelope<SiteChangedPayload> }>([
    {
      name: 'dead-letters an envelope without a tenant as missing-tenant and acks it',
      reason: 'missing-tenant',
      send: (envelope) => withoutTenant(envelope),
    },
    {
      name: "dead-letters a site sent under another site's tenant as tenant-mismatch, rolling back its receipt",
      reason: 'tenant-mismatch',
      send: (envelope) => withEnvelopeTenant(envelope, TENANT_B.tenantId),
    },
  ])('$name', async ({ reason, send }) => {
    const envelope = siteEnvelope(sitePayload(TENANT_A));

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, send(envelope));

    expect(res.statusCode).toBe(204);
    expect(dlqTopicName(SITE_CHANGED_SUBSCRIPTION)).toBe(DLQ_TOPIC);
    expect(rawPublishes()).toStrictEqual([{ topic: DLQ_TOPIC, reason, eventId: envelope.eventId }]);
    expect(publisher.published).toStrictEqual([]);
    expect(await registryRows()).toStrictEqual([]);
    for (const fixture of TENANT_LIST) {
      expect(await inboxRows(fixture.tenantId)).toStrictEqual([]);
      expect(await lastVersions(fixture.tenantId, TENANT_A.siteId)).toStrictEqual([]);
    }
  });
});
