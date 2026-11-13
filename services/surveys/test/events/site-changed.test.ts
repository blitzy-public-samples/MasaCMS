// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TENANT_UMBRELLA,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_TOPIC, tenantIdForSite, withMetadata, withTenant, type SiteChangedPayload } from '@opt2/platform/tenancy';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';

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

type InboxRow = { event_id: string; subscription: string; status: string };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const UMBRELLA_TENANT = tenantIdForSite(TENANT_UMBRELLA.siteId);
const pgReason = process.env.PG_HOST ? undefined : 'PG_HOST unset: PostgreSQL-backed event suite skipped';

describe.skipIf(!process.env.PG_HOST)(`surveys consumer of ${SITE_CHANGED_TOPIC}${pgReason === undefined ? '' : ` (${pgReason})`}`, () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let publisher!: TestApp['publisher'];

  /** A lower-case site id absent from the seeded registry. */
  function freshSiteId(): string {
    return `survey-evt-${randomBytes(4).toString('hex')}`;
  }

  /** A complete site payload whose public user, category, file and display pools are the umbrella site. */
  function sitePayload(siteId: string, overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
    return {
      siteId,
      publicUserPoolId: TENANT_UMBRELLA.siteId,
      privateUserPoolId: siteId,
      categoryPoolId: TENANT_UMBRELLA.siteId,
      filePoolId: TENANT_UMBRELLA.siteId,
      displayPoolId: TENANT_UMBRELLA.siteId,
      contentPoolIds: [siteId],
      domains: [`${siteId}.example.test`],
      ...overrides,
    };
  }

  /** A contract-valid site envelope of `siteId`, in the site's own tenant. */
  function envelopeFor(siteId: string, aggregateVersion: number, payload: SiteChangedPayload) {
    return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: tenantIdForSite(siteId), aggregateId: siteId, aggregateVersion, payload });
  }

  /** The `tenant_registry` rows of `siteId`. */
  async function registryRows(siteId: string): Promise<RegistryRow[]> {
    const { rows } = await withMetadata(schema.app, (tx) =>
      tx.query<RegistryRow>(
        `SELECT site_id, tenant_id, public_user_pool_id, private_user_pool_id, category_pool_id, file_pool_id, display_pool_id,
                content_pool_ids, public_user_pool_tenant, private_user_pool_tenant, category_pool_tenant, file_pool_tenant,
                display_pool_tenant, content_pool_tenants, domains, aggregate_version::text AS aggregate_version
           FROM "${schema.schema}".tenant_registry WHERE site_id = $1`,
        [siteId],
      ),
    );
    return rows;
  }

  /** Every inbox receipt of `tenantId`, read under its RLS. */
  async function inboxRows(tenantId: string): Promise<InboxRow[]> {
    const { rows } = await withTenant(schema.app, tenantId, (tx) =>
      tx.query<InboxRow>(`SELECT event_id::text AS event_id, subscription, status FROM "${schema.schema}".inbox`),
    );
    return rows;
  }

  /** The ordering progress of site `siteId` on the surveys subscription in `tenantId`. */
  async function aggregateVersionRow(tenantId: string, siteId: string): Promise<{ last_version: string | null }[]> {
    const { rows } = await withTenant(schema.app, tenantId, (tx) =>
      tx.query<{ last_version: string | null }>(
        `SELECT last_version::text AS last_version FROM "${schema.schema}".consumer_aggregate_version
          WHERE subscription = $1 AND aggregate_type = 'site' AND aggregate_id = $2`,
        [SITE_CHANGED_SUBSCRIPTION, siteId],
      ),
    );
    return rows;
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'surveys', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app);
    ({ app, publisher } = await buildTestApp({ db: schema.app, seedRegistry: false }));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await schema?.drop();
    }
  });

  it('records one inbox receipt and one tenant_registry row when the same site.changed envelope is delivered twice', async () => {
    const siteId = freshSiteId();
    const tenantId = tenantIdForSite(siteId);
    const envelope = envelopeFor(siteId, 7, sitePayload(siteId));
    const deadLetters = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).length;

    const responses = await deliverDuplicate(app, SITE_CHANGED_SUBSCRIPTION, envelope, 2);

    expect(responses.map((res) => res.statusCode)).toEqual([204, 204]);
    expect(publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(deadLetters);
    expect(await inboxRows(tenantId)).toEqual([{ event_id: envelope.eventId, subscription: SITE_CHANGED_SUBSCRIPTION, status: 'applied' }]);
    expect(await registryRows(siteId)).toEqual([
      {
        site_id: siteId,
        tenant_id: tenantId,
        public_user_pool_id: TENANT_UMBRELLA.siteId,
        private_user_pool_id: siteId,
        category_pool_id: TENANT_UMBRELLA.siteId,
        file_pool_id: TENANT_UMBRELLA.siteId,
        display_pool_id: TENANT_UMBRELLA.siteId,
        content_pool_ids: [siteId],
        public_user_pool_tenant: UMBRELLA_TENANT,
        private_user_pool_tenant: tenantId,
        category_pool_tenant: UMBRELLA_TENANT,
        file_pool_tenant: UMBRELLA_TENANT,
        display_pool_tenant: UMBRELLA_TENANT,
        content_pool_tenants: [tenantId],
        domains: [`${siteId}.example.test`],
        aggregate_version: '7',
      },
    ]);
  });

  it('acks a stale site.changed version and keeps the latest version in tenant_registry', async () => {
    const siteId = freshSiteId();
    const tenantId = tenantIdForSite(siteId);
    // Version 3 alone moves the display pool to the site itself, so a stale overwrite would show in the registry row.
    const envelopes = versionedSequence(envelopeFor(siteId, 1, sitePayload(siteId)), [1, 2, 3], (version) =>
      sitePayload(siteId, {
        displayPoolId: version === 3 ? siteId : TENANT_UMBRELLA.siteId,
        domains: [`v${version}.${siteId}.example.test`],
      }),
    );
    const v1 = envelopes[0]!;
    const v2 = envelopes[1]!;
    const v3 = envelopes[2]!;
    const deadLetters = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).length;

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, envelopes, [2, 0, 1]);

    expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204]);
    expect(publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(deadLetters);
    expect(await registryRows(siteId)).toEqual([
      expect.objectContaining({
        site_id: siteId,
        tenant_id: tenantId,
        display_pool_id: siteId,
        display_pool_tenant: tenantId,
        domains: [`v3.${siteId}.example.test`],
        aggregate_version: '3',
      }),
    ]);
    expect(await aggregateVersionRow(tenantId, siteId)).toEqual([{ last_version: '3' }]);
    const receipts = await inboxRows(tenantId);
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(
      expect.arrayContaining([
        { event_id: v3.eventId, subscription: SITE_CHANGED_SUBSCRIPTION, status: 'applied' },
        { event_id: v1.eventId, subscription: SITE_CHANGED_SUBSCRIPTION, status: 'stale' },
        { event_id: v2.eventId, subscription: SITE_CHANGED_SUBSCRIPTION, status: 'stale' },
      ]),
    );
  });
});
