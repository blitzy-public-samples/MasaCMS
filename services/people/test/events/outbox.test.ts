/** People's outbox producers over PostgreSQL: person and archive events, in-request flush, the sweep and migration applies. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPublisher, type EventEnvelope, type EventPublisher, type PublisherOptions, type RawMessage } from '@opt2/platform/events';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { CLOUD_TASKS_HEADERS, OUTBOX_SWEEP_INTERVAL_S, slotName, slotStartS, type TaskWireBody } from '@opt2/platform/tasks';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertEventMatches,
  createCapturingPublisher,
  createTestSubscription,
  createTestTopic,
  mintTasksInvokerToken,
  pubsubEmulatorAvailable,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import {
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  peoplePayloadValidators,
  personArchivedSchema,
  personChangedSchema,
} from '../../src/events/topics.js';
import { personArchiveMapping, personMapping } from '../../src/migration/mappings/index.js';
import { PERSON, PERSON_ARCHIVE } from '../../src/repo/tables.js';
import { PEOPLE_SWEEP_QUEUE } from '../../src/tasks/port.js';
import { PG_AVAILABLE, headersFor, userHeaders, withPgApp, type FakeTaskPort, type PgTestApp } from '../helpers/app.js';
import {
  ARCHIVE_EFFECTIVE_FROM,
  ARCHIVE_PERSON,
  DEFAULT_PEOPLE_SEED,
  MEMBER_B_PERSON,
  MODULE_USER_A_PERSON,
  OTHER_TENANT,
  SITE_ADMIN_A,
  SYSTEM_USER_A_PERSON,
  accountsForSeed,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

/** A capturing publisher whose publishes reject, recording nothing, while `failing` is set. */
interface GatedPublisher extends EventPublisher {
  readonly captured: CapturingPublisher;
  failing: boolean;
}

type PeopleCtx<E extends EventPublisher = GatedPublisher> = PgTestApp<FakeTaskPort, E>;

type OutboxRow = {
  seq: string;
  event_id: string;
  topic: string;
  kind: string;
  ordering_key: string;
  envelope: EventEnvelope;
  operation_id: string | null;
  held: boolean;
  published_at: Date | null;
  xmin: string;
};

type ArchiveRow = {
  archive_id: string;
  person_id: string;
  siteid: string;
  effective_from: string;
  archived_at: string;
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
/** A `yyMMddHHnnsslll` expiry after the suite clock; the identity double does not check the token formula. */
const CSRF_EXPIRES = '260630130000000';
const STATE_KIND = 'state';
const EMULATOR_READY = PG_AVAILABLE && (await pubsubEmulatorAvailable());

/** Creates a {@link GatedPublisher} over a fresh capturing publisher. */
function createGatedPublisher(): GatedPublisher {
  const captured = createCapturingPublisher();
  const refuse = (topic: string): Promise<never> => Promise.reject(new Error(`gated publisher refused a publish on ${topic}`));
  const gated: GatedPublisher = {
    captured,
    failing: false,
    publish: (topic: string, envelope: EventEnvelope) => (gated.failing ? refuse(topic) : captured.publish(topic, envelope)),
    publishRaw: (topic: string, message: RawMessage) => (gated.failing ? refuse(topic) : captured.publishRaw(topic, message)),
    close: () => captured.close(),
  };
  return gated;
}

/** Runs `fn` against people over a throwaway schema holding the default seed, with identity holding its accounts. */
async function withPeople<E extends EventPublisher>(publisher: E, fn: (ctx: PeopleCtx<E>) => Promise<void>): Promise<void> {
  const outcome = await withPgApp<'ran', FakeTaskPort, E>(
    async (ctx) => {
      await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
      ctx.identity.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
      await fn(ctx);
      return 'ran';
    },
    { publisher },
  );
  expect(outcome).toBe('ran');
}

/** Rows of `sql` read through the bootstrap pool in a read-only transaction of `tenantId`, as forced RLS requires. */
async function adminRows<R>(schema: ThrowawaySchema, tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
  const client = await schema.adminPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    client.release();
    return rows as R[];
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/** Outbox rows of `tenantId` on `topic` keyed by `orderingKey`, in `seq` order. */
function outboxRows(schema: ThrowawaySchema, tenantId: string, topic: string, orderingKey: string): Promise<OutboxRow[]> {
  return adminRows<OutboxRow>(
    schema,
    tenantId,
    `SELECT seq::text AS seq, event_id::text AS event_id, topic, kind, ordering_key, envelope, operation_id, held, published_at,
            xmin::text AS xmin
       FROM ${schema.schema}.outbox WHERE topic = $1 AND ordering_key = $2 ORDER BY seq`,
    [topic, orderingKey],
  );
}

/** Row count of people table `table` in `tenantId`. */
async function countRows(schema: ThrowawaySchema, tenantId: string, table: string): Promise<number> {
  const [row] = await adminRows<{ count: number }>(schema, tenantId, `SELECT count(*)::int AS count FROM ${schema.schema}."${table}"`);
  return row?.count ?? 0;
}

/** The stored `people.person.row_version` of `userId` in `tenantId`. */
async function rowVersion(schema: ThrowawaySchema, tenantId: string, userId: string): Promise<number> {
  const [row] = await adminRows<{ row_version: string }>(
    schema,
    tenantId,
    `SELECT row_version::text AS row_version FROM ${schema.schema}.${PERSON.table} WHERE userid = $1`,
    [userId],
  );
  if (row === undefined) throw new Error(`No person ${userId} in tenant ${tenantId}`);
  return Number(row.row_version);
}

/** Envelopes `publisher` captured on `topic` for aggregate `aggregateId`, in publish order. */
function publishedFor(publisher: CapturingPublisher, topic: string, aggregateId: string): EventEnvelope[] {
  return publisher.published.filter((event) => event.topic === topic && event.envelope.aggregateId === aggregateId).map((event) => event.envelope);
}

/** POSTs a Type=2 `cUsers.update` of `form.userid` as `actor` with a fresh CSRF token identity accepts for that context. */
async function updateUser(ctx: PeopleCtx<EventPublisher>, actor: TestActor, form: Readonly<Record<string, string>> & { userid: string }) {
  ctx.identity.csrf.accept(form.userid);
  const fields = { type: '2', siteid: TENANT_A.siteId, isPublic: '0', ...form, csrf_token: randomUUID(), csrf_token_expires: CSRF_EXPIRES };
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/users:update',
    headers: { ...(await userHeaders(actor)), ...FORM },
    payload: new URLSearchParams(fields).toString(),
  });
}

/** POSTs the fixture archive of `userId` as `actor` from `effectiveFrom`, with a fresh CSRF token identity accepts for that context. */
async function archivePerson(ctx: PeopleCtx<EventPublisher>, actor: TestActor, userId: string, effectiveFrom = ARCHIVE_EFFECTIVE_FROM) {
  ctx.identity.csrf.accept(userId);
  const fields = { effectiveFrom, csrf_token: randomUUID(), csrf_token_expires: CSRF_EXPIRES };
  return ctx.app.inject({
    method: 'POST',
    url: `/legacy-fixtures/cfml/api.cfm/people/persons/${userId}/archive`,
    headers: { ...(await userHeaders(actor)), ...FORM },
    payload: new URLSearchParams(fields).toString(),
  });
}

/** POSTs the current slot's outbox-sweep task with the local tasks-invoker credential. */
async function sweep(ctx: PeopleCtx<EventPublisher>) {
  const slot = slotStartS(Math.floor(ctx.clock.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S);
  const body: TaskWireBody = { queue: PEOPLE_SWEEP_QUEUE, name: slotName(PEOPLE_SWEEP_QUEUE, slot), tenantId: null, payload: {} };
  return ctx.app.inject({
    method: 'POST',
    url: '/internal/v1/outbox/sweep',
    headers: {
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}`,
      [CLOUD_TASKS_HEADERS.taskName]: body.name,
      [CLOUD_TASKS_HEADERS.queueName]: body.queue,
    },
    payload: body,
  });
}

/** A tenant-a backfill batch of one upserted row encoded over `columns`, every column NULL unless `values` sets it. */
function backfillBatch(legacyTable: string, columns: readonly CanonicalColumn[], values: Readonly<Record<string, unknown>>): ApplyRequest {
  const row = { ...Object.fromEntries(columns.map((column) => [column.name, null])), ...values };
  return {
    batchId: `people-outbox-${randomUUID()}`,
    origin: 'backfill',
    legacyTable,
    siteId: TENANT_A.siteId,
    columns: columns.map((column) => ({ ...column })),
    rows: [{ op: 'upsert', row: encodeRow(columns, row) }],
  };
}

/** The posted name and email columns of a seeded person, which an update re-submits unchanged. */
function namesOf(person: { userid: string; fname: string | null; lname: string | null; email: string | null }) {
  return { userid: person.userid, fname: person.fname ?? '', lname: person.lname ?? '', email: person.email ?? '' };
}

describe.skipIf(!PG_AVAILABLE)('people outbox', () => {
  it('Person writes emit people.person.changed.v1 with strictly increasing aggregateVersion equal to people.person.row_version, ordered by user id', async () => {
    const publisher = createGatedPublisher();
    await withPeople(publisher, async (ctx) => {
      const userid = cfUuid();
      const handle = `roster_${userid.slice(0, 8).toLowerCase()}`;
      const person = { userid, fname: 'Riley', lname: 'Roster', email: `${handle}@tenant-a.opt2.test` };
      const writes = [
        { action: 'Add', ...person, username: handle },
        { action: 'Update', ...person, company: 'First Company', jobtitle: 'Analyst' },
        { action: 'Update', ...person, company: 'Second Company', jobtitle: 'Lead Analyst' },
      ];

      const versions: number[] = [];
      for (const form of writes) {
        const res = await updateUser(ctx, SITE_ADMIN_A, form);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ written: true, errors: {} });
        versions.push(await rowVersion(ctx.schema, TENANT_A.tenantId, userid));
      }

      const envelopes = publishedFor(publisher.captured, PERSON_CHANGED_TOPIC, userid);
      expect(envelopes).toHaveLength(writes.length);
      expect(envelopes.map((envelope) => envelope.aggregateVersion)).toEqual(versions);
      for (let i = 1; i < versions.length; i += 1) expect(versions[i]).toBeGreaterThan(versions[i - 1] ?? Infinity);
      envelopes.forEach((envelope, i) => {
        assertEventMatches(undefined, personChangedSchema, envelope);
        const { company, jobtitle } = writes[i] as { company?: string; jobtitle?: string };
        expect(envelope).toMatchObject({
          aggregateType: 'person',
          aggregateId: userid,
          tenantId: TENANT_A.tenantId,
          producer: SERVICE_NAME,
          payload: {
            userId: userid,
            siteId: TENANT_A.siteId,
            deleted: false,
            fname: person.fname,
            lname: person.lname,
            email: person.email,
            ...(company === undefined ? {} : { company, jobTitle: jobtitle }),
          },
        });
      });
      const rows = await outboxRows(ctx.schema, TENANT_A.tenantId, PERSON_CHANGED_TOPIC, userid);
      expect(rows.map((row) => row.event_id)).toEqual(envelopes.map((envelope) => envelope.eventId));
      for (const row of rows) {
        expect(row).toMatchObject({ kind: STATE_KIND, ordering_key: userid, held: false });
        expect(row.published_at).toBeInstanceOf(Date);
      }
    });
  });

  it.skipIf(!EMULATOR_READY)('Ordering key on the wire is the user id, with the envelope fields mirrored as attributes', async () => {
    const topic = await createTestTopic(SERVICE_NAME);
    const subscription = await createTestSubscription(topic);
    // Every publish goes to the run's own topic, while the publisher still checks the contract of the real topic name.
    const client = { topic: () => topic.topic, close: () => Promise.resolve() } as unknown as NonNullable<PublisherOptions['pubsub']>;
    const publisher = createPublisher({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local',
      pubsub: client,
      payloadValidators: new Map(Object.entries(peoplePayloadValidators)),
    });
    try {
      await withPeople(publisher, async (ctx) => {
        const { userid } = MODULE_USER_A_PERSON;
        const res = await updateUser(ctx, SITE_ADMIN_A, { action: 'Update', ...namesOf(MODULE_USER_A_PERSON), company: 'Wire Company' });
        expect(res.statusCode).toBe(200);

        const [row] = await outboxRows(ctx.schema, TENANT_A.tenantId, PERSON_CHANGED_TOPIC, userid);
        expect(row?.published_at).toBeInstanceOf(Date);
        const messages = await subscription.pull(1, 10_000);
        expect(messages).toHaveLength(1);
        const [message] = messages;
        const { envelope } = row as OutboxRow;
        expect(message?.orderingKey).toBe(userid);
        expect(message?.attributes).toMatchObject({
          eventId: row?.event_id,
          eventType: envelope.eventType,
          schemaVersion: envelope.schemaVersion,
          tenantId: TENANT_A.tenantId,
          aggregateVersion: String(await rowVersion(ctx.schema, TENANT_A.tenantId, userid)),
          traceparent: envelope.traceparent,
        });
        const sent: unknown = JSON.parse(message?.data.toString('utf8') ?? 'null');
        assertEventMatches(undefined, personChangedSchema, sent);
        expect(sent).toEqual(envelope);
      });
    } finally {
      await publisher.close();
      await subscription.delete();
      await topic.delete();
    }
  });

  const ARCHIVE_CASES = [
    { label: 'pooled person stored under umbrella', actor: SITE_ADMIN_A, person: ARCHIVE_PERSON, tenantId: TENANT_UMBRELLA.tenantId },
    { label: 'tenant-b person', actor: OTHER_TENANT, person: MEMBER_B_PERSON, tenantId: TENANT_B.tenantId },
  ];

  it.each(ARCHIVE_CASES)("An archive emits people.person.archived.v1 exactly once, in the person's tenant: $label", async ({ actor, person, tenantId }) => {
    const publisher = createGatedPublisher();
    await withPeople(publisher, async (ctx) => {
      const userId = person.userid;
      // An unflushed row keeps the xmin of the transaction that wrote it, which the changelog's xid names.
      publisher.failing = true;
      const res = await archivePerson(ctx, actor, userId);
      publisher.failing = false;
      expect(res.statusCode).toBe(200);

      const written = await outboxRows(ctx.schema, tenantId, PERSON_ARCHIVED_TOPIC, userId);
      expect(written).toHaveLength(1);
      const [row] = written as [OutboxRow];
      expect(row).toMatchObject({ kind: 'process', ordering_key: userId, held: false, operation_id: null, published_at: null });
      const logs = await adminRows<{ xid_low: string }>(
        ctx.schema,
        tenantId,
        `SELECT (xid::text::numeric % 4294967296)::text AS xid_low FROM ${ctx.schema.schema}.changelog
          WHERE "table" = $1 AND op = 'insert' AND origin = 'target'`,
        [PERSON_ARCHIVE.table],
      );
      expect(logs.map((log) => log.xid_low)).toEqual([row.xmin]);

      expect((await sweep(ctx)).statusCode).toBe(200);

      const [published] = await outboxRows(ctx.schema, tenantId, PERSON_ARCHIVED_TOPIC, userId);
      expect(published?.published_at).toBeInstanceOf(Date);
      const envelopes = publishedFor(publisher.captured, PERSON_ARCHIVED_TOPIC, userId);
      expect(envelopes).toHaveLength(1);
      const [envelope] = envelopes as [EventEnvelope];
      assertEventMatches(undefined, personArchivedSchema, envelope);
      expect(envelope).toMatchObject({
        eventId: row.event_id,
        tenantId,
        aggregateType: 'person',
        aggregateId: userId,
        aggregateVersion: await rowVersion(ctx.schema, tenantId, userId),
      });
      const archives = await adminRows<ArchiveRow>(
        ctx.schema,
        tenantId,
        `SELECT archive_id, person_id, siteid, to_char(effective_from, 'YYYY-MM-DD HH24:MI:SS.MS') AS effective_from,
                to_char(archived_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS archived_at
           FROM ${ctx.schema.schema}.${PERSON_ARCHIVE.table} WHERE person_id = $1`,
        [userId],
      );
      expect(archives).toHaveLength(1);
      const [archive] = archives as [ArchiveRow];
      expect(Object.keys(envelope.payload as object).sort()).toEqual(['archiveId', 'archivedAt', 'effectiveFrom', 'personId', 'siteId']);
      expect(envelope.payload).toEqual({
        personId: archive.person_id,
        archiveId: archive.archive_id,
        siteId: archive.siteid,
        effectiveFrom: archive.effective_from,
        archivedAt: archive.archived_at,
      });
      expect(archive.siteid).toBe(person.siteid);

      const outboxBefore = await countRows(ctx.schema, tenantId, 'outbox');
      const repeated = await archivePerson(ctx, actor, userId);
      const { status, code, message } = LEGACY_ERROR_MAP.badRequest;
      expect(repeated.statusCode).toBe(status);
      expect(repeated.json()).toMatchObject({ method: 'people.persons.archive', error: { code, message } });
      expect(await countRows(ctx.schema, tenantId, 'outbox')).toBe(outboxBefore);
      expect((await sweep(ctx)).json()).toMatchObject({ published: 0, failed: 0 });
      expect(publishedFor(publisher.captured, PERSON_ARCHIVED_TOPIC, userId)).toHaveLength(1);
    });
  });

  it('A committed but unflushed outbox row is published by the next sweep', async () => {
    const publisher = createGatedPublisher();
    await withPeople(publisher, async (ctx) => {
      const { userid } = SYSTEM_USER_A_PERSON;
      publisher.failing = true;
      const res = await updateUser(ctx, SITE_ADMIN_A, { action: 'Update', ...namesOf(SYSTEM_USER_A_PERSON), company: 'Swept Company' });
      publisher.failing = false;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ written: true, errors: {} });

      const unflushed = await outboxRows(ctx.schema, TENANT_A.tenantId, PERSON_CHANGED_TOPIC, userid);
      expect(unflushed).toHaveLength(1);
      const [row] = unflushed as [OutboxRow];
      expect(row).toMatchObject({ held: false, published_at: null });
      expect(publisher.captured.published).toEqual([]);

      const first = await sweep(ctx);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ published: 1, failed: 0 });
      const [swept] = await outboxRows(ctx.schema, TENANT_A.tenantId, PERSON_CHANGED_TOPIC, userid);
      expect(swept?.published_at).toBeInstanceOf(Date);
      const envelopes = publisher.captured.published.map((event) => event.envelope);
      expect(envelopes).toEqual([row.envelope]);
      assertEventMatches(undefined, personChangedSchema, envelopes[0]);
      expect(envelopes[0]?.eventId).toBe(row.event_id);

      const second = await sweep(ctx);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ published: 0, failed: 0 });
      expect(publisher.captured.published).toHaveLength(1);
    });
  });

  it('Migration applies emit only state events and a repeated batchId is a no-op', async () => {
    const publisher = createGatedPublisher();
    await withPeople(publisher, async (ctx) => {
      const tenantId = TENANT_A.tenantId;
      const userId = cfUuid();
      const tusersColumns: CanonicalColumn[] = [...personMapping.legacyColumns, { name: 'Type', type: 'i' }];
      const batches = [
        backfillBatch(personMapping.legacyTable, tusersColumns, {
          UserID: userId,
          SiteID: TENANT_A.siteId,
          Type: 2,
          Fname: 'Bea',
          Lname: 'Backfill',
          Email: `backfill_${userId.slice(0, 8).toLowerCase()}@tenant-a.opt2.test`,
          subType: 'Default',
        }),
        backfillBatch(personArchiveMapping.legacyTable, personArchiveMapping.legacyColumns, {
          archive_id: cfUuid(),
          person_id: userId,
          siteID: TENANT_A.siteId,
          effective_from: `${ARCHIVE_EFFECTIVE_FROM} 00:00:00`,
          archived_at: '2026-06-30 12:00:00',
        }),
      ];
      const headers = await headersFor('service:migration');
      const apply = (body: ApplyRequest) => ctx.app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers, payload: body });

      for (const body of batches) {
        const res = await apply(body);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ batchId: body.batchId, duplicate: false, applied: 1, skipped: 0 });
      }

      const changed = publishedFor(publisher.captured, PERSON_CHANGED_TOPIC, userId);
      expect(changed).toHaveLength(1);
      const [envelope] = changed as [EventEnvelope];
      assertEventMatches(undefined, personChangedSchema, envelope);
      expect(envelope).toMatchObject({
        tenantId,
        aggregateId: userId,
        aggregateVersion: await rowVersion(ctx.schema, tenantId, userId),
        payload: { userId, siteId: TENANT_A.siteId, deleted: false, fname: 'Bea', lname: 'Backfill' },
      });
      const [stateRow] = await outboxRows(ctx.schema, tenantId, PERSON_CHANGED_TOPIC, userId);
      expect(stateRow).toMatchObject({ kind: STATE_KIND, event_id: envelope.eventId });
      expect(stateRow?.published_at).toBeInstanceOf(Date);
      expect(publisher.captured.published.filter((event) => event.topic === PERSON_ARCHIVED_TOPIC)).toEqual([]);
      expect(await outboxRows(ctx.schema, tenantId, PERSON_ARCHIVED_TOPIC, userId)).toEqual([]);
      const archives = await adminRows(ctx.schema, tenantId, `SELECT 1 FROM ${ctx.schema.schema}.${PERSON_ARCHIVE.table} WHERE person_id = $1`, [userId]);
      expect(archives).toHaveLength(1);

      const batchIds = batches.map((body) => body.batchId).sort();
      const recorded = await adminRows<{ batch_id: string; count: number }>(
        ctx.schema,
        tenantId,
        `SELECT batch_id, count(*)::int AS count FROM ${ctx.schema.schema}.migration_batch
          WHERE batch_id = ANY($1::text[]) GROUP BY batch_id ORDER BY batch_id`,
        [batchIds],
      );
      expect(recorded).toEqual(batchIds.map((batch_id) => ({ batch_id, count: 1 })));
      const origins = await adminRows<{ origin: string }>(
        ctx.schema,
        tenantId,
        `SELECT DISTINCT origin FROM ${ctx.schema.schema}.changelog WHERE request_id = ANY($1::text[])`,
        [batchIds],
      );
      expect(origins).toEqual([{ origin: 'backfill' }]);

      const counts = () => Promise.all([PERSON.table, PERSON_ARCHIVE.table, 'changelog', 'outbox'].map((table) => countRows(ctx.schema, tenantId, table)));
      const before = await counts();
      const publishedBefore = publisher.captured.published.length;
      for (const body of batches) {
        const res = await apply(body);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 });
      }
      expect(await counts()).toEqual(before);
      expect(publisher.captured.published).toHaveLength(publishedBefore);
    });
  });
});
