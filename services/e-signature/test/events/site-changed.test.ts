// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEAD_LETTER_REASON_ATTRIBUTE,
  buildPushBody,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  pushPath,
  type DeadLetterReason,
  type EventEnvelope,
} from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  TEST_PUSH_KEY,
  createCapturingPublisher,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  mintUserToken,
  pgAvailable,
  pushKeyQuery,
  pushTo,
  testEnvelope,
  withoutTenant,
  type CapturingPublisher,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { buildDbApp, type TestApp } from '../helpers/app.js';

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

type InboxRow = { event_id: string; subscription: string; status: string };

/** A dead-lettered delivery: what is pushed, the reason expected, and the site and tenants that must stay untouched. */
interface DeadLetterCase {
  label: string;
  reason: DeadLetterReason;
  siteId: string;
  tenants: readonly string[];
  envelope: () => TenantlessEnvelope;
}

/** Where a refused push is sent and the `authorization` header it carries, if any. */
type PushCredential = { url: string; authorization?: string };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const FAULT_SITE = 'es-fault-site';
const WRONG_PUSH_KEY = `${TEST_PUSH_KEY.slice(0, -1)}${TEST_PUSH_KEY.endsWith('x') ? 'y' : 'x'}`;

// Rewritten to the throwaway schema and run as its owner after the migrations.
const FAULT_SQL = `
CREATE FUNCTION esignature.reject_fault_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.site_id = '${FAULT_SITE}' THEN
    RAISE EXCEPTION 'injected tenant_registry failure for site %', NEW.site_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reject_fault_site BEFORE INSERT OR UPDATE ON esignature.tenant_registry
  FOR EACH ROW EXECUTE FUNCTION esignature.reject_fault_site();
`;

/** A site.changed payload of `siteId`; every pool defaults to the site itself, as settingsBean.cfc defaults empty pool ids. */
function sitePayload(siteId: string, overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
  return {
    siteId,
    publicUserPoolId: siteId,
    privateUserPoolId: siteId,
    categoryPoolId: siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId],
    domains: [],
    ...overrides,
  };
}

/** A site.changed envelope of `payload`'s site at `aggregateVersion`, under that site's tenant. */
function siteEnvelope(payload: SiteChangedPayload, aggregateVersion = 1): EventEnvelope<SiteChangedPayload> {
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId: tenantIdForSite(payload.siteId),
    aggregateId: payload.siteId,
    aggregateVersion,
    payload,
  });
}

/** Inbox status keyed by event id, independent of receipt order. */
function statusByEvent(rows: readonly InboxRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
}

const DEAD_LETTER_CASES: readonly DeadLetterCase[] = [
  {
    label: 'an envelope without a tenant',
    reason: 'missing-tenant',
    siteId: 'es-dlq-no-tenant',
    tenants: [tenantIdForSite('es-dlq-no-tenant')],
    envelope: () => withoutTenant(siteEnvelope(sitePayload('es-dlq-no-tenant'))),
  },
  {
    label: 'an envelope whose tenant is not a UUID',
    reason: 'invalid-tenant',
    siteId: 'es-dlq-bad-tenant',
    tenants: [tenantIdForSite('es-dlq-bad-tenant')],
    envelope: () => ({ ...siteEnvelope(sitePayload('es-dlq-bad-tenant')), tenantId: 'not-a-uuid' }),
  },
  {
    label: 'a payload without siteId',
    reason: 'schema-invalid',
    siteId: 'es-dlq-no-site',
    tenants: [tenantIdForSite('es-dlq-no-site')],
    envelope: () => {
      const envelope = siteEnvelope(sitePayload('es-dlq-no-site'));
      const { siteId: _omitted, ...payload } = envelope.payload;
      return { ...envelope, payload };
    },
  },
  {
    label: 'a payload with an undeclared property',
    reason: 'schema-invalid',
    siteId: 'es-dlq-extra',
    tenants: [tenantIdForSite('es-dlq-extra')],
    envelope: () => {
      const envelope = siteEnvelope(sitePayload('es-dlq-extra'));
      return { ...envelope, payload: { ...envelope.payload, siteName: 'Extra' } };
    },
  },
  {
    label: "a site under another site's tenant",
    reason: 'tenant-mismatch',
    siteId: 'es-mm-site',
    tenants: [tenantIdForSite('es-mm-site'), tenantIdForSite('es-mm-other')],
    envelope: () => ({ ...siteEnvelope(sitePayload('es-mm-site')), tenantId: tenantIdForSite('es-mm-other') }),
  },
];

describe.skipIf(!(await pgAvailable()))(`e-signature consumer of ${SITE_CHANGED_TOPIC}`, () => {
  let handle: ThrowawaySchema;
  let publisher: CapturingPublisher;
  let app: TestApp['app'];

  const table = (name: string): string => `${handle.schema}.${name}`;

  /** The tenant_registry rows of `siteId`, read without a tenant since the registry is non-tenant metadata. */
  async function registryRows(siteId: string): Promise<RegistryRow[]> {
    const { rows } = await handle.app.withMetadata((tx) =>
      tx.query<RegistryRow>(`SELECT * FROM ${table('tenant_registry')} WHERE site_id = $1`, [siteId]),
    );
    return rows;
  }

  /** Inbox receipts of `tenantId`, read under its forced RLS. */
  async function inboxRows(tenantId: string): Promise<InboxRow[]> {
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<InboxRow>(
        `SELECT event_id::text AS event_id, subscription, status FROM ${table('inbox')} ORDER BY received_at, event_id`,
      ),
    );
    return rows;
  }

  /** Last applied versions of `siteId`'s site aggregate on e-signature's subscription, under `tenantId`. */
  async function lastVersions(tenantId: string, siteId: string): Promise<(number | null)[]> {
    const { rows } = await handle.app.withTenant(tenantId, (tx) =>
      tx.query<{ last_version: string | null }>(
        `SELECT last_version FROM ${table('consumer_aggregate_version')}
          WHERE subscription = $1 AND aggregate_type = 'site' AND aggregate_id = $2`,
        [SITE_CHANGED_SUBSCRIPTION, siteId],
      ),
    );
    return rows.map((row) => (row.last_version === null ? null : Number(row.last_version)));
  }

  /** Every raw publish as topic, `reason` attribute and message data text. */
  function rawPublishes(): Array<{ topic: string; reason: string | undefined; data: string }> {
    return publisher.raw.map(({ topic, message }) => ({
      topic,
      reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE],
      data: message.data.toString('utf8'),
    }));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: MIGRATIONS_DIR,
      extraSql: [FAULT_SQL],
    });
    publisher = createCapturingPublisher();
    ({ app } = await buildDbApp(handle, { publisher }));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await handle?.drop();
    }
  });

  beforeEach(() => {
    publisher.clear();
  });

  it('subscribes as e-signature.programs-sites.site.changed.v1 with its push path and dead-letter topic', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('e-signature.programs-sites.site.changed.v1');
    expect(pushPath(SITE_CHANGED_SUBSCRIPTION)).toBe('/internal/v1/events/e-signature.programs-sites.site.changed.v1');
    expect(dlqTopicName(SITE_CHANGED_SUBSCRIPTION)).toBe('e-signature.programs-sites.site.changed.v1.dlq');
  });

  it('registers a pool site and a member site with every pool resolved to its pool site tenant, publishing nothing', async () => {
    const umbrellaTenant = tenantIdForSite('es-reg-umbrella');
    const memberTenant = tenantIdForSite('es-reg-a');
    const umbrella = sitePayload('es-reg-umbrella');
    const member = sitePayload('es-reg-a', {
      publicUserPoolId: 'es-reg-umbrella',
      categoryPoolId: 'es-reg-umbrella',
      filePoolId: 'es-reg-umbrella',
      displayPoolId: 'es-reg-umbrella',
      contentPoolIds: ['es-reg-a', 'es-reg-umbrella'],
      domains: ['a.es.example.test'],
    });

    const responses = [
      await pushTo(app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(umbrella)),
      await pushTo(app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(member)),
    ];

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const memberRows = await registryRows('es-reg-a');
    expect(memberRows).toMatchObject([
      {
        site_id: 'es-reg-a',
        tenant_id: memberTenant,
        public_user_pool_id: 'es-reg-umbrella',
        private_user_pool_id: 'es-reg-a',
        category_pool_id: 'es-reg-umbrella',
        file_pool_id: 'es-reg-umbrella',
        display_pool_id: 'es-reg-umbrella',
        content_pool_ids: ['es-reg-a', 'es-reg-umbrella'],
        public_user_pool_tenant: umbrellaTenant,
        private_user_pool_tenant: memberTenant,
        category_pool_tenant: umbrellaTenant,
        file_pool_tenant: umbrellaTenant,
        display_pool_tenant: umbrellaTenant,
        content_pool_tenants: [memberTenant, umbrellaTenant],
        domains: ['a.es.example.test'],
      },
    ]);
    expect(memberRows.map((row) => Number(row.aggregate_version))).toStrictEqual([1]);
    expect(await registryRows('es-reg-umbrella')).toMatchObject([
      {
        site_id: 'es-reg-umbrella',
        tenant_id: umbrellaTenant,
        public_user_pool_id: 'es-reg-umbrella',
        private_user_pool_id: 'es-reg-umbrella',
        category_pool_id: 'es-reg-umbrella',
        file_pool_id: 'es-reg-umbrella',
        display_pool_id: 'es-reg-umbrella',
        content_pool_ids: ['es-reg-umbrella'],
        public_user_pool_tenant: umbrellaTenant,
        private_user_pool_tenant: umbrellaTenant,
        category_pool_tenant: umbrellaTenant,
        file_pool_tenant: umbrellaTenant,
        display_pool_tenant: umbrellaTenant,
        content_pool_tenants: [umbrellaTenant],
        domains: [],
      },
    ]);
    expect(publisher.published).toStrictEqual([]);
    expect(rawPublishes()).toStrictEqual([]);
  });

  it('applies a delivery repeated three times once', async () => {
    const tenantId = tenantIdForSite('es-dup-site');
    const envelope = siteEnvelope(sitePayload('es-dup-site'));

    const responses = await deliverDuplicate(app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204, 204]);
    expect((await registryRows('es-dup-site')).map((row) => Number(row.aggregate_version))).toStrictEqual([1]);
    expect(await inboxRows(tenantId)).toStrictEqual([
      { event_id: envelope.eventId, subscription: SITE_CHANGED_SUBSCRIPTION, status: 'applied' },
    ]);
    expect(await lastVersions(tenantId, 'es-dup-site')).toStrictEqual([1]);
  });

  it('acks a version older than the applied one as stale and keeps the newer state', async () => {
    const tenantId = tenantIdForSite('es-stale-site');
    const v2 = siteEnvelope(sitePayload('es-stale-site', { domains: ['v2.es.example.test'] }), 2);
    const v3 = siteEnvelope(sitePayload('es-stale-site', { domains: ['v3.es.example.test'] }), 3);

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, [v2, v3], [1, 0]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const rows = await registryRows('es-stale-site');
    expect(rows.map((row) => [row.domains, Number(row.aggregate_version)])).toStrictEqual([[['v3.es.example.test'], 3]]);
    expect(statusByEvent(await inboxRows(tenantId))).toStrictEqual({ [v3.eventId]: 'applied', [v2.eventId]: 'stale' });
    expect(await lastVersions(tenantId, 'es-stale-site')).toStrictEqual([3]);
  });

  it('applies a version that skips over a missing one', async () => {
    const tenantId = tenantIdForSite('es-gap-site');
    const v1 = siteEnvelope(sitePayload('es-gap-site', { domains: ['v1.es.example.test'] }), 1);
    const v3 = siteEnvelope(sitePayload('es-gap-site', { domains: ['v3.es.example.test'], displayPoolId: 'es-gap-theme' }), 3);

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, [v1, v3], [0, 1]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    const rows = await registryRows('es-gap-site');
    expect(rows).toMatchObject([
      {
        domains: ['v3.es.example.test'],
        display_pool_id: 'es-gap-theme',
        display_pool_tenant: tenantIdForSite('es-gap-theme'),
      },
    ]);
    expect(rows.map((row) => Number(row.aggregate_version))).toStrictEqual([3]);
    expect(statusByEvent(await inboxRows(tenantId))).toStrictEqual({ [v1.eventId]: 'applied', [v3.eventId]: 'applied' });
    expect(await lastVersions(tenantId, 'es-gap-site')).toStrictEqual([3]);
  });

  it.each(DEAD_LETTER_CASES)('dead-letters $label as $reason and acks it', async ({ reason, siteId, tenants, envelope }) => {
    const sent = envelope();

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, sent);

    expect(res.statusCode).toBe(204);
    expect(rawPublishes()).toStrictEqual([
      {
        topic: dlqTopicName(SITE_CHANGED_SUBSCRIPTION),
        reason,
        data: encodeEnvelope(sent as unknown as EventEnvelope).toString('utf8'),
      },
    ]);
    expect(publisher.published).toStrictEqual([]);
    expect(await registryRows(siteId)).toStrictEqual([]);
    for (const tenantId of tenants) {
      expect(await inboxRows(tenantId)).toStrictEqual([]);
      expect(await lastVersions(tenantId, siteId)).toStrictEqual([]);
    }
  });

  it('nacks a delivery whose registry write fails, leaving no receipt, row or dead letter', async () => {
    const tenantId = tenantIdForSite(FAULT_SITE);

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(sitePayload(FAULT_SITE)));

    expect(isAck(res)).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(await inboxRows(tenantId)).toStrictEqual([]);
    expect(await lastVersions(tenantId, FAULT_SITE)).toStrictEqual([]);
    expect(await registryRows(FAULT_SITE)).toStrictEqual([]);
    expect(rawPublishes()).toStrictEqual([]);
  });

  it.each<[string, () => Promise<PushCredential>]>([
    [
      'a user token instead of the push key',
      async () => ({
        url: pushPath(SITE_CHANGED_SUBSCRIPTION),
        authorization: `Bearer ${await mintUserToken({ sub: 'es-test-user', site: 'es-auth-site', roles: ['s2'] })}`,
      }),
    ],
    ['no push key', async () => ({ url: pushPath(SITE_CHANGED_SUBSCRIPTION) })],
    ['a wrong push key of the right length', async () => ({ url: `${pushPath(SITE_CHANGED_SUBSCRIPTION)}?${pushKeyQuery(WRONG_PUSH_KEY)}` })],
  ])('refuses a push carrying %s before the consumer runs', async (_label, credential) => {
    const { url, authorization } = await credential();
    const envelope = siteEnvelope(sitePayload('es-auth-site'));

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
    expect(await inboxRows(envelope.tenantId)).toStrictEqual([]);
    expect(await registryRows('es-auth-site')).toStrictEqual([]);
    expect(rawPublishes()).toStrictEqual([]);
  });
});
