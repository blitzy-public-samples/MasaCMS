import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type CapturingPublisher,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  GateClosedError,
  WRITE_POSITION_HEADER_LC,
  encodeKey,
  encodeRow,
  parseWritePosition,
  type ApplyRequest,
  type GateRequest,
} from '@opt2/platform/migration-kit';
import { buildTestApp, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';
import { TOPIC, writeSiteChanged } from '../../src/events/site-changed.js';
import { SITE_CHANGED_SUBSCRIPTION, siteRegistryConsumerRegistration } from '../../src/events/consumers.js';
import { siteChangedPayload } from '../../src/domain/pools.js';
import { SITE_DEFAULTS } from '../../src/legacy/site-fields.js';
import { SITE, UNITS, type SiteRow } from '../../src/repo/tables.js';
import { tsettingsMapping } from '../../src/migration/mappings/tsettings.js';

type SitePayload = ReturnType<typeof siteChangedPayload>;

type OutboxRow = {
  seq: string;
  event_id: string;
  kind: string;
  envelope: {
    eventId: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    payload: unknown;
  };
  published_at: Date | null;
  xmin: string;
};

type ChangelogRow = { seq: string; xid: string; xid_low: string; op: string; origin: string };

type RegistryRow = {
  site_id: string;
  tenant_id: string;
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

type InboxRow = { tenant_id: string; status: string };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const SERVICE = 'programs-sites';
const SWEEP_QUEUE = 'programs-sites-outbox-sweep';
const SWEEP_INTERVAL_S = 60;
const GATE_HOLDER = 'site-changed-events-suite';
const SEED_BATCH_ID = 'site-changed-events-seed-tenant-a';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
// Seeded rows hold the bean init defaults settingsDAO.create stores for a new site.
const BEAN_DEFAULTS: ReadonlyMap<string, unknown> = new Map(
  Object.entries(SITE_DEFAULTS).map(([name, value]) => [name.toLowerCase(), value]),
);

describe.skipIf(!process.env.PG_HOST)('programs-sites.site.changed.v1', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let publisher!: CapturingPublisher;
  let taskPort!: FakeTaskPort;
  let clock!: TestApp['clock'];

  /** `<throwaway schema>.<name>`. */
  const table = (name: string): string => `${schema.schema}.${name}`;

  /** Rows of `sql` in a tenant transaction of `fixture`, under the RLS the app runs under. */
  async function tenantQuery<R extends Record<string, unknown>>(fixture: TenantFixture, sql: string, params: unknown[] = []): Promise<R[]> {
    return (await schema.app.withTenant(fixture.tenantId, (tx) => tx.query<R>(sql, params))).rows;
  }

  /** Rows of `sql` in a metadata transaction, for the non-tenant registry. */
  async function metadataQuery<R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    return (await schema.app.withMetadata((tx) => tx.query<R>(sql, params))).rows;
  }

  /** The `tenant_registry` row of `siteId`, or undefined. */
  async function registryRow(siteId: string): Promise<RegistryRow | undefined> {
    const [row] = await metadataQuery<RegistryRow>(`SELECT * FROM ${table('tenant_registry')} WHERE site_id = $1`, [siteId]);
    return row;
  }

  /** The stored `site` row of `fixture`, with its row `xmin`. */
  async function storedSite(fixture: TenantFixture): Promise<SiteRow & { xmin: string }> {
    const [row] = await tenantQuery<SiteRow & { xmin: string }>(
      fixture,
      `SELECT *, xmin::text AS xmin FROM ${table('site')} WHERE siteid = $1`,
      [fixture.siteId],
    );
    if (row === undefined) throw new Error(`no stored site ${fixture.siteId}`);
    return row;
  }

  /** The site topic's outbox rows of `fixture`, in `seq` order. */
  function outboxRows(fixture: TenantFixture): Promise<OutboxRow[]> {
    return tenantQuery<OutboxRow>(
      fixture,
      `SELECT seq::text AS seq, event_id::text AS event_id, kind, envelope, published_at, xmin::text AS xmin
         FROM ${table('outbox')} WHERE topic = $1 AND ordering_key = $2 ORDER BY seq`,
      [TOPIC, fixture.siteId],
    );
  }

  /** The changelog rows of `fixture`'s site row, in `seq` order, with the low 32 bits of each xid. */
  function siteChangelog(fixture: TenantFixture): Promise<ChangelogRow[]> {
    return tenantQuery<ChangelogRow>(
      fixture,
      `SELECT seq::text AS seq, xid::text AS xid, (xid::text::numeric % 4294967296)::text AS xid_low, op, origin
         FROM ${table('changelog')} WHERE "table" = $1 AND key = $2 ORDER BY seq`,
      [SITE.table, encodeKey(SITE.columns, SITE.key ?? [], { siteid: fixture.siteId })],
    );
  }

  /** Inbox receipts of `eventId` in every fixture tenant. */
  async function inboxRows(eventId: string): Promise<InboxRow[]> {
    const rows: InboxRow[] = [];
    for (const fixture of TENANT_LIST) {
      rows.push(
        ...(await tenantQuery<InboxRow>(fixture, `SELECT tenant_id::text AS tenant_id, status FROM ${table('inbox')} WHERE event_id = $1`, [
          eventId,
        ])),
      );
    }
    return rows;
  }

  /** Outbox rows a sweep selects (unpublished, not held), summed over every fixture tenant. */
  async function unpublishedOutboxCount(): Promise<number> {
    let count = 0;
    for (const fixture of TENANT_LIST) {
      const [row] = await tenantQuery<{ count: string }>(
        fixture,
        `SELECT count(*)::text AS count FROM ${table('outbox')} WHERE published_at IS NULL AND NOT held`,
      );
      count += Number(row?.count ?? 0);
    }
    return count;
  }

  /** The fixture registry payload of `siteId`. */
  function fixturePayload(siteId: string): SitePayload {
    const payload = registryPayloads().find((candidate) => candidate.siteId === siteId);
    if (payload === undefined) throw new TypeError(`no fixture payload for ${siteId}`);
    return payload;
  }

  /** A contract-valid site envelope of `fixture` at `aggregateVersion`. */
  function siteEnvelope(fixture: TenantFixture, aggregateVersion: number, payload: SitePayload) {
    return testEnvelope({ topic: TOPIC, tenantId: fixture.tenantId, aggregateId: fixture.siteId, aggregateVersion, payload });
  }

  /** A `tsettings` row holding the site bean's init defaults (empty text as NULL), its id, its name and `values`. */
  function tsettingsRow(siteId: string, values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    const row: Record<string, unknown> = Object.fromEntries(
      tsettingsMapping.legacyColumns.map(({ name }) => [name, BEAN_DEFAULTS.get(name.toLowerCase()) || null]),
    );
    for (const [name, value] of Object.entries({ SiteID: siteId, Site: `Site ${siteId}`, ...values })) {
      if (!(name in row)) throw new TypeError(`tsettings maps no column ${name}`);
      row[name] = value;
    }
    return row;
  }

  /** A one-row `tsettings` backfill batch. */
  function tsettingsBatch(batchId: string, row: Readonly<Record<string, unknown>>): ApplyRequest {
    const columns = tsettingsMapping.legacyColumns;
    return {
      batchId,
      origin: 'backfill',
      legacyTable: tsettingsMapping.legacyTable,
      siteId: String(row.SiteID),
      columns: columns.map((column) => ({ ...column })),
      rows: [{ op: 'upsert', row: encodeRow(columns, row) }],
    };
  }

  /** POSTs `body` to `/internal/v1/migration/<route>` as the migration service. */
  async function migrationPost(route: 'apply' | 'gate', body: ApplyRequest | GateRequest) {
    return app.inject({ method: 'POST', url: `/internal/v1/migration/${route}`, headers: await headersFor('service:migration'), payload: body });
  }

  /** POSTs the Sites screen order save of `tenant-a` at `orderno` as an S2 admin with a CSRF token the identity recorder accepts. */
  async function orderTenantA(orderno: number) {
    const form = new URLSearchParams({ orderID: 'tenant-a', orderno: String(orderno), csrf_token: 'T', csrf_token_expires: 'E' });
    return app.inject({
      method: 'POST',
      url: '/v1/sites/order',
      headers: { ...(await headersFor('s2', { site: TENANT_A.siteId })), ...FORM },
      payload: form.toString(),
    });
  }

  /** Name of the sweep chain task of the slot `offset` slots after the clock's current one. */
  function sweepTaskName(offset = 0): string {
    const slotStart = Math.floor(clock.now().getTime() / 1000 / SWEEP_INTERVAL_S) * SWEEP_INTERVAL_S;
    return `${SWEEP_QUEUE}-${slotStart + offset * SWEEP_INTERVAL_S}`;
  }

  /** POSTs the current slot's outbox sweep task as the local Cloud Tasks adapter would. */
  async function sweep() {
    const name = sweepTaskName();
    return app.inject({
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
        'x-cloudtasks-taskname': name,
        'x-cloudtasks-queuename': SWEEP_QUEUE,
      },
      payload: { queue: SWEEP_QUEUE, name, tenantId: null, payload: {} },
    });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    publisher = createCapturingPublisher();
    ({ app, taskPort, clock } = await buildTestApp({ db: schema.app, publisher }));

    const gateRequests: GateRequest[] = [
      { op: 'close', units: [...UNITS], holderId: GATE_HOLDER, allowLegacy: true },
      { op: 'open', units: [...UNITS], holderId: GATE_HOLDER },
    ];
    for (const request of gateRequests) {
      const res = await migrationPost('gate', request);
      expect(res.statusCode).toBe(200);
    }
    const gates = (await migrationPost('gate', { op: 'status', units: [...UNITS] })).json<{ units: { state: string }[] }>();
    expect(gates.units.map((gate) => gate.state)).toEqual(UNITS.map(() => 'open'));

    const seed = fixturePayload(TENANT_A.siteId);
    const seeded = await migrationPost(
      'apply',
      tsettingsBatch(
        SEED_BATCH_ID,
        tsettingsRow(TENANT_A.siteId, {
          Domain: seed.domains?.[0],
          publicUserPoolID: seed.publicUserPoolId,
          privateUserPoolID: seed.privateUserPoolId,
          categoryPoolID: seed.categoryPoolId,
          filePoolID: seed.filePoolId,
          displayPoolID: seed.displayPoolId,
        }),
      ),
    );
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json()).toMatchObject({ duplicate: false, applied: 1 });
    publisher.clear();
  });

  // Registry cases push versions of the same fixture sites, so each starts from the seeded registry with no consumer progress.
  beforeEach(async () => {
    await seedRegistry(schema.app, schema.schema);
    for (const fixture of TENANT_LIST) {
      await tenantQuery(fixture, `DELETE FROM ${table('consumer_aggregate_version')} WHERE subscription = $1`, [SITE_CHANGED_SUBSCRIPTION]);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // An injected publish failure a case did not consume must not fail a later case's publish.
    publisher?.failNext(0);
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('writes one state outbox row carrying the stored site with legacy pool ids, publishes it after commit and audits the write', async () => {
    const before = await outboxRows(TENANT_A);
    const targetLogs = (await siteChangelog(TENANT_A)).filter((log) => log.origin === 'target');

    const res = await orderTenantA(2);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: true });
    const added = (await outboxRows(TENANT_A)).slice(before.length);
    expect(added).toHaveLength(1);
    const [row] = added as [OutboxRow];
    const site = await storedSite(TENANT_A);
    expect(row.kind).toBe('state');
    expect(row.envelope).toMatchObject({
      tenantId: TENANT_A.tenantId,
      aggregateType: 'site',
      aggregateId: TENANT_A.siteId,
      aggregateVersion: Number(site.row_version),
    });
    expect(row.envelope.payload).toEqual(siteChangedPayload(site));
    expect(row.envelope.payload).toEqual({
      siteId: 'tenant-a',
      publicUserPoolId: 'umbrella',
      privateUserPoolId: 'tenant-a',
      categoryPoolId: 'umbrella',
      filePoolId: 'umbrella',
      displayPoolId: 'umbrella',
      contentPoolIds: ['tenant-a'],
      domains: [fixturePayload(TENANT_A.siteId).domains?.[0]],
    });
    expect(row.published_at).toBeInstanceOf(Date);
    expect(publisher.published.filter((event) => event.envelope.eventId === row.event_id)).toEqual([
      expect.objectContaining({ topic: TOPIC }),
    ]);
    const logs = (await siteChangelog(TENANT_A)).filter((log) => log.origin === 'target');
    expect(logs).toHaveLength(targetLogs.length + 1);
  });

  it('commits the outbox row with the site row and its changelog row in one transaction and survives a failed in-request flush', async () => {
    const before = await outboxRows(TENANT_A);
    const logsBefore = await siteChangelog(TENANT_A);
    publisher.failNext();

    const res = await orderTenantA(3);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: true });
    const added = (await outboxRows(TENANT_A)).slice(before.length);
    expect(added).toHaveLength(1);
    const [row] = added as [OutboxRow];
    expect(row.published_at).toBeNull();
    const logs = (await siteChangelog(TENANT_A)).slice(logsBefore.length);
    expect(logs).toHaveLength(1);
    const [log] = logs as [ChangelogRow];
    expect(log.origin).toBe('target');
    const site = await storedSite(TENANT_A);
    expect(row.envelope.aggregateVersion).toBe(Number(site.row_version));
    expect(row.xmin).toBe(site.xmin);
    expect(log.xid_low).toBe(site.xmin);
    const position = parseWritePosition(res.headers[WRITE_POSITION_HEADER_LC] as string | undefined);
    expect(position.get(SERVICE)).toBe(log.xid);
  });

  it('applies a pushed site event to the tenant registry with resolved pool tenants and one applied inbox receipt', async () => {
    const payload: SitePayload = { ...siteChangedPayload(await storedSite(TENANT_A)), domains: ['marker-a.events.test'] };
    const envelope = siteEnvelope(TENANT_A, 100, payload);

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    expect(await registryRow(TENANT_A.siteId)).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      public_user_pool_tenant: TENANT_UMBRELLA.tenantId,
      private_user_pool_tenant: TENANT_A.tenantId,
      category_pool_tenant: TENANT_UMBRELLA.tenantId,
      file_pool_tenant: TENANT_UMBRELLA.tenantId,
      display_pool_tenant: TENANT_UMBRELLA.tenantId,
      content_pool_tenants: [TENANT_A.tenantId],
      domains: ['marker-a.events.test'],
      aggregate_version: '100',
    });
    expect(await inboxRows(envelope.eventId)).toEqual([{ tenant_id: TENANT_A.tenantId, status: 'applied' }]);
  });

  it('applies a redelivered event once, leaving the registry row untouched by every repeat', async () => {
    const envelope = siteEnvelope(TENANT_B, 200, { ...fixturePayload(TENANT_B.siteId), domains: ['once-b.events.test'] });
    const first = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);
    expect(first.statusCode).toBe(204);
    const applied = await registryRow(TENANT_B.siteId);
    expect(applied).toMatchObject({ domains: ['once-b.events.test'], aggregate_version: '200' });

    const repeats = await deliverDuplicate(app, SITE_CHANGED_SUBSCRIPTION, envelope, 3);

    expect(repeats.map(isAck)).toEqual([true, true, true]);
    expect(await registryRow(TENANT_B.siteId)).toEqual(applied);
    expect(await inboxRows(envelope.eventId)).toEqual([{ tenant_id: TENANT_B.tenantId, status: 'applied' }]);
  });

  it('reaches the in-order final state from out-of-order deliveries, applying a version gap and acking a stale version as ignored', async () => {
    const base = siteEnvelope(TENANT_UMBRELLA, 101, fixturePayload(TENANT_UMBRELLA.siteId));
    const envelopes = versionedSequence(base, [101, 102, 103, 105], (version) => ({
      ...fixturePayload(TENANT_UMBRELLA.siteId),
      domains: [`v${version}.umbrella.test`],
    }));
    const v103 = envelopes[2]!;
    const v105 = envelopes[3]!;

    const responses = await deliverOutOfOrder(app, SITE_CHANGED_SUBSCRIPTION, envelopes, [0, 1, 3, 2]);

    expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204, 204]);
    const row = await registryRow(TENANT_UMBRELLA.siteId);
    expect(row).toMatchObject({ tenant_id: TENANT_UMBRELLA.tenantId, domains: v105.payload.domains, aggregate_version: '105' });
    expect(await inboxRows(v105.eventId)).toEqual([{ tenant_id: TENANT_UMBRELLA.tenantId, status: 'applied' }]);
    expect(await inboxRows(v103.eventId)).toEqual([{ tenant_id: TENANT_UMBRELLA.tenantId, status: 'stale' }]);
    const progress = await tenantQuery<{ last_version: string }>(
      TENANT_UMBRELLA,
      `SELECT last_version::text AS last_version FROM ${table('consumer_aggregate_version')}
        WHERE subscription = $1 AND aggregate_type = 'site' AND aggregate_id = $2`,
      [SITE_CHANGED_SUBSCRIPTION, TENANT_UMBRELLA.siteId],
    );
    expect(progress).toEqual([{ last_version: '105' }]);
  });

  it('dead-letters an event without a tenant as missing-tenant and acks it without a receipt', async () => {
    const envelope = withoutTenant(siteEnvelope(TENANT_B, 900, fixturePayload(TENANT_B.siteId)));
    const registered = await registryRow(TENANT_B.siteId);
    const letters = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).length;

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    const added = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).slice(letters);
    expect(added.map((letter) => letter.reason)).toEqual(['missing-tenant']);
    expect(await inboxRows(envelope.eventId)).toEqual([]);
    expect(await registryRow(TENANT_B.siteId)).toEqual(registered);
  });

  it('dead-letters an event whose payload breaks the closed schema as schema-invalid and acks it without a receipt', async () => {
    const { domains: _dropped, ...withoutDomains } = fixturePayload(TENANT_B.siteId);
    const envelope = siteEnvelope(TENANT_B, 901, withoutDomains);
    const registered = await registryRow(TENANT_B.siteId);
    const letters = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).length;

    const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    const added = publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).slice(letters);
    expect(added.map((letter) => letter.reason)).toEqual(['schema-invalid']);
    expect(await inboxRows(envelope.eventId)).toEqual([]);
    expect(await registryRow(TENANT_B.siteId)).toEqual(registered);
  });

  it('nacks a delivery whose apply hits a closed gate, keeping no receipt, and applies its redelivery', async () => {
    const envelope = siteEnvelope(TENANT_B, 300, { ...fixturePayload(TENANT_B.siteId), domains: ['nack-b.events.test'] });
    const registered = await registryRow(TENANT_B.siteId);
    const apply = vi
      .spyOn(siteRegistryConsumerRegistration.consumer, 'apply')
      .mockRejectedValueOnce(new GateClosedError([SITE.unit]));

    const nacked = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(isAck(nacked)).toBe(false);
    expect(nacked.statusCode).toBe(503);
    expect(await inboxRows(envelope.eventId)).toEqual([]);
    expect(await registryRow(TENANT_B.siteId)).toEqual(registered);

    apply.mockRestore();
    const redelivered = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(redelivered.statusCode).toBe(204);
    expect(await registryRow(TENANT_B.siteId)).toMatchObject({ domains: ['nack-b.events.test'], aggregate_version: '300' });
    expect(await inboxRows(envelope.eventId)).toEqual([{ tenant_id: TENANT_B.tenantId, status: 'applied' }]);
  });

  it('emits a backfilled site as a state event with Masa pool defaults, and treats a repeated batch as a no-op', async () => {
    const batch = tsettingsBatch('site-changed-events-backfill-tenant-b', tsettingsRow(TENANT_B.siteId, { Domain: 'tenant-b.opt2.test' }));
    const before = await outboxRows(TENANT_B);

    const res = await migrationPost('apply', batch);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchId: batch.batchId, duplicate: false, applied: 1, skipped: 0 });
    const applied = await outboxRows(TENANT_B);
    const rows = applied.slice(before.length);
    expect(rows).toHaveLength(1);
    const [row] = rows as [OutboxRow];
    const site = await storedSite(TENANT_B);
    expect(row.kind).toBe('state');
    expect(row.envelope).toMatchObject({
      tenantId: TENANT_B.tenantId,
      aggregateType: 'site',
      aggregateId: TENANT_B.siteId,
      aggregateVersion: Number(site.row_version),
    });
    expect(row.envelope.payload).toEqual(fixturePayload(TENANT_B.siteId));
    expect(row.published_at).toBeInstanceOf(Date);
    expect(publisher.published.map((event) => event.envelope.eventId)).toContain(row.event_id);
    const logs = await siteChangelog(TENANT_B);
    expect(logs.length).toBeGreaterThan(0);
    expect(new Set(logs.map((log) => log.origin))).toEqual(new Set(['backfill']));

    const repeated = await migrationPost('apply', batch);

    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ batchId: batch.batchId, duplicate: true, applied: 0, skipped: 0 });
    expect(await outboxRows(TENANT_B)).toEqual(applied);
    expect(await siteChangelog(TENANT_B)).toEqual(logs);
    expect(await storedSite(TENANT_B)).toEqual(site);
    const batches = await tenantQuery<{ batch_id: string }>(TENANT_B, `SELECT batch_id FROM ${table('migration_batch')} WHERE batch_id = $1`, [
      batch.batchId,
    ]);
    expect(batches).toHaveLength(1);
  });

  it('publishes unflushed outbox rows from the sweep task and secures the next slot of the sweep chain', async () => {
    const before = await outboxRows(TENANT_A);
    publisher.failNext();
    const order = await orderTenantA(4);
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ written: true });
    const site = await storedSite(TENANT_A);
    publisher.failNext();
    const envelope = await schema.app.withTenant(TENANT_A.tenantId, (tx) =>
      writeSiteChanged(tx, { siteId: TENANT_A.siteId, rowVersion: BigInt(site.row_version), payload: siteChangedPayload(site) }),
    );
    expect(envelope).not.toBeNull();
    const own = (await outboxRows(TENANT_A)).slice(before.length);
    expect(own).toHaveLength(2);
    expect(own[1]?.event_id).toBe(envelope?.eventId);
    expect(own.map((row) => row.published_at)).toEqual([null, null]);
    const ownIds = own.map((row) => row.event_id);
    const pending = await unpublishedOutboxCount();
    const callsBefore = taskPort.calls.length;

    const res = await sweep();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ published: pending, failed: 0 });
    const published = new Map((await outboxRows(TENANT_A)).map((row) => [row.event_id, row.published_at]));
    expect(ownIds.map((id) => published.get(id))).toEqual([expect.any(Date), expect.any(Date)]);
    expect(publisher.published.map((event) => event.envelope.eventId)).toEqual(expect.arrayContaining(ownIds));
    expect(taskPort.tasks(SWEEP_QUEUE).map((task) => task.input.name)).toContain(sweepTaskName(1));
    expect(taskPort.calls.slice(callsBefore)).toContainEqual({
      op: 'create',
      args: [expect.objectContaining({ queue: SWEEP_QUEUE, name: sweepTaskName(1) })],
    });
  });
});
