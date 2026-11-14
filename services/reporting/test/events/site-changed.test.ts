// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type EventEnvelope } from '@opt2/platform/events';
import {
  SITE_CHANGED_TOPIC,
  poolTenantFor,
  registryEntries,
  registryEntryForTenant,
  tenantForRegisteredSite,
  withTenant,
  type PoolKind,
  type SiteChangedPayload,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_UMBRELLA,
  deliverDuplicate,
  deliverOutOfOrder,
  pgAvailable,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type TenantFixture,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

type InboxRow = { event_id: string; status: string };

const POOL_KINDS: readonly PoolKind[] = ['publicUser', 'privateUser', 'category', 'file', 'display'];

// An unset PG_HOST skips the suite without probing the server.
const pgReady = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** A site.changed envelope of `fixture`'s site at `version`, carrying its fixture registry payload with `overrides` applied. */
function siteEnvelope(fixture: TenantFixture, version: number, overrides: Partial<SiteChangedPayload> = {}): EventEnvelope<SiteChangedPayload> {
  const base = registryPayloads().find((payload) => payload.siteId === fixture.siteId);
  if (base === undefined) throw new TypeError(`registryPayloads has no ${fixture.siteId} payload`);
  const payload = { ...base, ...overrides };
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: fixture.tenantId, aggregateId: fixture.siteId, aggregateVersion: version, payload });
}

/** Inbox receipts of `tenantId` on reporting's subscription, read under the tenant's forced RLS. */
async function inboxRows(db: TenantDb, tenantId: string): Promise<InboxRow[]> {
  const { rows } = await withTenant(db, tenantId, (tx) =>
    tx.query<InboxRow>(`SELECT event_id::text AS event_id, status FROM ${tx.schema}.inbox WHERE subscription = $1 ORDER BY received_at, event_id`, [
      SITE_CHANGED_SUBSCRIPTION,
    ]),
  );
  return rows;
}

/** Inbox status keyed by event id, independent of receipt order. */
function statusByEvent(rows: readonly InboxRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
}

/** The tenant each pool of `tenantId` resolves to in the registry. */
async function poolTenants(db: TenantDb, tenantId: string): Promise<Record<PoolKind, string | null>> {
  const tenants = await Promise.all(POOL_KINDS.map((kind) => poolTenantFor(db, tenantId, kind)));
  return Object.fromEntries(POOL_KINDS.map((kind, index) => [kind, tenants[index] ?? null])) as Record<PoolKind, string | null>;
}

describe.skipIf(!pgReady)(`reporting consumer of ${SITE_CHANGED_TOPIC}`, () => {
  let t: TestApp<TenantDb>;

  beforeEach(async () => {
    t = await buildTestApp({ db: 'pg', registry: false });
  });

  afterEach(async () => {
    await t?.close();
  });

  it('registers the site, its tenant and resolved pool tenants', async () => {
    const envelope = siteEnvelope(TENANT_A, 1);

    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    expect(await registryEntryForTenant(t.db, TENANT_A.tenantId)).toMatchObject({
      siteId: TENANT_A.siteId,
      tenantId: TENANT_A.tenantId,
      publicUserPoolId: TENANT_UMBRELLA.siteId,
      privateUserPoolId: TENANT_A.siteId,
      categoryPoolId: TENANT_UMBRELLA.siteId,
      filePoolId: TENANT_UMBRELLA.siteId,
      displayPoolId: TENANT_UMBRELLA.siteId,
      contentPoolIds: [TENANT_A.siteId],
      contentPoolTenants: [TENANT_A.tenantId],
      domains: envelope.payload.domains,
      aggregateVersion: 1,
    });
    expect(await tenantForRegisteredSite(t.db, TENANT_A.siteId)).toBe(TENANT_A.tenantId);
    expect(await poolTenants(t.db, TENANT_A.tenantId)).toStrictEqual({
      publicUser: TENANT_UMBRELLA.tenantId,
      privateUser: TENANT_A.tenantId,
      category: TENANT_UMBRELLA.tenantId,
      file: TENANT_UMBRELLA.tenantId,
      display: TENANT_UMBRELLA.tenantId,
    });
    expect(await inboxRows(t.db, TENANT_A.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
    expect(t.publisher.published).toStrictEqual([]);
    expect(t.publisher.raw).toStrictEqual([]);
  });

  it('applies a duplicate delivery once', async () => {
    const envelope = siteEnvelope(TENANT_A, 1);

    const responses = await deliverDuplicate(t.app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204, 204]);
    const entries = await registryEntries(t.db);
    expect(entries.map((entry) => [entry.siteId, entry.aggregateVersion])).toStrictEqual([[TENANT_A.siteId, 1]]);
    expect(await inboxRows(t.db, TENANT_A.tenantId)).toStrictEqual([{ event_id: envelope.eventId, status: 'applied' }]);
  });

  it('ignores a stale aggregateVersion', async () => {
    const v1 = siteEnvelope(TENANT_A, 1);
    const v2 = siteEnvelope(TENANT_A, 2, { publicUserPoolId: TENANT_A.siteId });

    const responses = await deliverOutOfOrder(t.app, SITE_CHANGED_SUBSCRIPTION, [v1, v2], [1, 0]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    expect(await poolTenantFor(t.db, TENANT_A.tenantId, 'publicUser')).toBe(TENANT_A.tenantId);
    expect(await registryEntryForTenant(t.db, TENANT_A.tenantId)).toMatchObject({ publicUserPoolId: TENANT_A.siteId, aggregateVersion: 2 });
    expect(statusByEvent(await inboxRows(t.db, TENANT_A.tenantId))).toStrictEqual({ [v2.eventId]: 'applied', [v1.eventId]: 'stale' });
  });

  it('applies a newer aggregateVersion across a gap in the sequence', async () => {
    const v1 = siteEnvelope(TENANT_A, 1);
    const v3 = siteEnvelope(TENANT_A, 3, { categoryPoolId: TENANT_A.siteId });

    const responses = await deliverOutOfOrder(t.app, SITE_CHANGED_SUBSCRIPTION, [v1, v3], [0, 1]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    expect(await poolTenantFor(t.db, TENANT_A.tenantId, 'category')).toBe(TENANT_A.tenantId);
    expect(await registryEntryForTenant(t.db, TENANT_A.tenantId)).toMatchObject({ categoryPoolId: TENANT_A.siteId, aggregateVersion: 3 });
    expect(statusByEvent(await inboxRows(t.db, TENANT_A.tenantId))).toStrictEqual({ [v1.eventId]: 'applied', [v3.eventId]: 'applied' });
  });

  it('dead-letters an envelope without a tenant and acks it', async () => {
    const envelope = siteEnvelope(TENANT_A, 1);

    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, withoutTenant(envelope));

    expect(res.statusCode).toBe(204);
    const dlqTopic = dlqTopicName(SITE_CHANGED_SUBSCRIPTION);
    expect(dlqTopic).toBe('reporting.programs-sites.site.changed.v1.dlq');
    const raw = t.publisher.raw.map(({ topic, message }) => ({
      topic,
      reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE],
      eventId: (JSON.parse(message.data.toString('utf8')) as { eventId?: unknown }).eventId,
    }));
    expect(raw).toStrictEqual([{ topic: dlqTopic, reason: 'missing-tenant', eventId: envelope.eventId }]);
    expect(t.publisher.published).toStrictEqual([]);
    expect(await tenantForRegisteredSite(t.db, TENANT_A.siteId)).toBeNull();
    expect(await registryEntries(t.db)).toStrictEqual([]);
    expect(await inboxRows(t.db, TENANT_A.tenantId)).toStrictEqual([]);
  });
});
