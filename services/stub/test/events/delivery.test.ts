/** Push delivery of the stub's consumers against PostgreSQL: one effect per event, stale state versions, registry upserts and dead letters. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type EventEnvelope } from '@opt2/platform/events';
import {
  SITE_CHANGED_TOPIC,
  tenantIdForSite,
  withMetadata,
  withTenant,
  type SiteChangedPayload,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  pgAvailable,
  pushTo,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { newNote, noteCreatedPayload, type Note } from '../../src/domain/note.js';
import { NOTE_CREATED_SUBSCRIPTION, NOTE_CREATED_TOPIC, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/topics.js';
import { TEST_CLOCK, buildDbApp, createFakeTaskPort, type TestApp } from '../helpers/app.js';

type NotePayload = ReturnType<typeof noteCreatedPayload>;
type StubApp = TestApp<TenantDb>['app'];
// Type aliases, not interfaces, so they satisfy pg's QueryResultRow index signature.
type ProjectionRow = { title: string; aggregate_version: number; apply_count: number; last_event_id: string };
type InboxRow = { event_id: string; status: string };
type RegistryRow = {
  site_id: string;
  tenant_id: string;
  public_user_pool_tenant: string | null;
  private_user_pool_tenant: string | null;
  category_pool_tenant: string | null;
  file_pool_tenant: string | null;
  display_pool_tenant: string | null;
  content_pool_ids: string[] | null;
  content_pool_tenants: string[] | null;
  domains: string[] | null;
  aggregate_version: number;
};

const NOTE_DLQ = dlqTopicName(NOTE_CREATED_SUBSCRIPTION);
// An unset PG_HOST means no PostgreSQL is configured, so the suites skip; pgAvailable still rejects on bad settings.
const pg = Boolean(process.env.PG_HOST) && (await pgAvailable());
const publisher = createCapturingPublisher();
let schema: ThrowawaySchema | undefined;
let service: TestApp<TenantDb> | undefined;

beforeAll(async () => {
  if (!pg) return;
  // ThrowawaySchemaOptions.migrationsDir is a filesystem path, so the module-relative URL is converted.
  schema = await createThrowawaySchema({
    service: 'stub',
    migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
  });
  await seedRegistry(schema.app, schema.schema);
  service = await buildDbApp(schema, { publisher, taskPort: createFakeTaskPort(), clock: TEST_CLOCK });
});

afterAll(async () => {
  try {
    await service?.app.close();
  } finally {
    await schema?.drop();
  }
});

beforeEach(() => {
  publisher.clear();
});

/** The stub app and throwaway schema the file's `beforeAll` built. */
function built(): { app: StubApp; schema: ThrowawaySchema } {
  if (schema === undefined || service === undefined) throw new Error('beforeAll built no stub app');
  return { app: service.app, schema };
}

/** `name` qualified by the quoted throwaway schema. */
function table(name: string): string {
  return `"${built().schema.schema}".${name}`;
}

/** The note's `note_projection` rows visible under `tenantId`. */
async function projection(tenantId: string, noteId: string): Promise<ProjectionRow[]> {
  const { rows } = await withTenant(built().schema.app, tenantId, (tx) =>
    tx.query<ProjectionRow>(
      'SELECT title, aggregate_version::integer AS aggregate_version, apply_count, last_event_id' +
        ` FROM ${table('note_projection')} WHERE note_id = $1`,
      [noteId],
    ),
  );
  return rows;
}

/** Inbox receipts visible under `tenantId`, only those of `eventId` when given. */
async function inboxRows(tenantId: string, eventId?: string): Promise<InboxRow[]> {
  const { rows } = await withTenant(built().schema.app, tenantId, (tx) =>
    eventId === undefined
      ? tx.query<InboxRow>(`SELECT event_id, status FROM ${table('inbox')} ORDER BY event_id`)
      : tx.query<InboxRow>(`SELECT event_id, status FROM ${table('inbox')} WHERE event_id = $1`, [eventId]),
  );
  return rows;
}

/** The `tenant_registry` row of `siteId`, or undefined. */
async function registryRow(siteId: string): Promise<RegistryRow | undefined> {
  const { rows } = await withMetadata(built().schema.app, (tx) =>
    tx.query<RegistryRow>(
      'SELECT site_id, tenant_id, public_user_pool_tenant, private_user_pool_tenant, category_pool_tenant,' +
        ' file_pool_tenant, display_pool_tenant, content_pool_ids, content_pool_tenants::text[] AS content_pool_tenants,' +
        ` domains, aggregate_version::integer AS aggregate_version FROM ${table('tenant_registry')} WHERE site_id = $1`,
      [siteId],
    ),
  );
  return rows[0];
}

/** A `stub.note.created.v1` envelope of `note` at `version`, shaped as the stub's outbox writes it. */
function noteEnvelope(note: Note, tenantId: string, version = 1): EventEnvelope<NotePayload> {
  return testEnvelope({
    topic: NOTE_CREATED_TOPIC,
    tenantId,
    aggregateType: 'note',
    aggregateId: note.noteId,
    aggregateVersion: version,
    payload: { ...noteCreatedPayload(note), rowVersion: version },
  });
}

/** A `site.changed` payload of `siteId` owning every one of its pools. */
function selfPooledSite(siteId: string): SiteChangedPayload {
  return {
    siteId,
    publicUserPoolId: siteId,
    privateUserPoolId: siteId,
    categoryPoolId: siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId],
    domains: [`${siteId}.example`],
  };
}

/** A `programs-sites.site.changed.v1` envelope of `payload`, keyed as programs-sites emits it. */
function siteEnvelope(payload: SiteChangedPayload, version = 1): EventEnvelope<SiteChangedPayload> {
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId: tenantIdForSite(payload.siteId),
    aggregateType: 'site',
    aggregateId: payload.siteId,
    aggregateVersion: version,
    payload,
  });
}

/** `reason` attributes of the dead letters on the note subscription's DLQ, in publish order. */
function noteDeadLetterReasons(): Array<string | undefined> {
  return publisher.raw
    .filter(({ topic }) => topic === NOTE_DLQ)
    .map(({ message }) => message.attributes[DEAD_LETTER_REASON_ATTRIBUTE]);
}

/** Status codes of push responses, in delivery order. */
function statusCodes(responses: ReadonlyArray<{ statusCode: number }>): number[] {
  return responses.map(({ statusCode }) => statusCode);
}

describe.skipIf(!pg)('outbox-pubsub-idempotent-consumer', () => {
  it('duplicate delivery applies once', async () => {
    const note = newNote({ title: 'duplicate', body: '' }, TEST_CLOCK);
    const env = noteEnvelope(note, TENANT_A.tenantId);

    expect(statusCodes(await deliverDuplicate(built().app, NOTE_CREATED_SUBSCRIPTION, env))).toEqual([204, 204]);

    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([
      { title: 'duplicate', aggregate_version: 1, apply_count: 1, last_event_id: env.eventId },
    ]);
    expect(await inboxRows(TENANT_A.tenantId, env.eventId)).toEqual([{ event_id: env.eventId, status: 'applied' }]);
  });

  it('out-of-order delivery keeps the newest version', async () => {
    const note = newNote({ title: 'out-of-order', body: '' }, TEST_CLOCK);
    const sequence = versionedSequence(noteEnvelope(note, TENANT_A.tenantId), [1, 2, 3], (version) => ({
      ...noteCreatedPayload(note),
      title: `v${String(version)}`,
      rowVersion: version,
    }));

    const responses = await deliverOutOfOrder(built().app, NOTE_CREATED_SUBSCRIPTION, sequence, [2, 0, 1]);

    expect(statusCodes(responses)).toEqual([204, 204, 204]);
    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([
      { title: 'v3', aggregate_version: 3, apply_count: 1, last_event_id: sequence[2]?.eventId },
    ]);
    const receipts: InboxRow[][] = [];
    for (const { eventId } of sequence) receipts.push(await inboxRows(TENANT_A.tenantId, eventId));
    expect(receipts.map((rows) => rows.map(({ status }) => status))).toEqual([['stale'], ['stale'], ['applied']]);
  });

  it('site.changed upserts tenant_registry', async () => {
    const site = 'tenant-c';
    const tenantId = tenantIdForSite(site);

    expect((await pushTo(built().app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(selfPooledSite(site)))).statusCode).toBe(204);
    expect(await registryRow(site)).toEqual({
      site_id: site,
      tenant_id: tenantId,
      public_user_pool_tenant: tenantId,
      private_user_pool_tenant: tenantId,
      category_pool_tenant: tenantId,
      file_pool_tenant: tenantId,
      display_pool_tenant: tenantId,
      content_pool_ids: [site],
      content_pool_tenants: [tenantId],
      domains: [`${site}.example`],
      aggregate_version: 1,
    });

    const seeded = registryPayloads().find((payload) => payload.siteId === TENANT_A.siteId);
    if (seeded === undefined) throw new Error(`registryPayloads has no ${TENANT_A.siteId} entry`);
    const before = await registryRow(TENANT_A.siteId);
    expect(before).toBeDefined();
    const version = (before?.aggregate_version ?? 0) + 1;
    const domains = ['tenant-a.example', 'www.tenant-a.example'];

    const update = siteEnvelope({ ...seeded, domains }, version);
    expect((await pushTo(built().app, SITE_CHANGED_SUBSCRIPTION, update)).statusCode).toBe(204);
    expect(await registryRow(TENANT_A.siteId)).toEqual({ ...before, domains, aggregate_version: version });
  });
});

describe.skipIf(!pg)('dlq-replay', () => {
  it('tenantless envelope is dead-lettered', async () => {
    const note = newNote({ title: 'tenantless', body: '' }, TEST_CLOCK);
    const env = noteEnvelope(note, TENANT_A.tenantId);

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, withoutTenant(env))).statusCode).toBe(204);

    expect(noteDeadLetterReasons()).toEqual(['missing-tenant']);
    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([]);
  });

  it('unregistered tenant is dead-lettered, then replays once', async () => {
    const site = 'tenant-dlq';
    const unknown = tenantIdForSite(site);
    const note = newNote({ title: 'replayed', body: '' }, TEST_CLOCK);
    const env = noteEnvelope(note, unknown);
    const applied = [{ title: 'replayed', aggregate_version: 1, apply_count: 1, last_event_id: env.eventId }];
    const receipt = [{ event_id: env.eventId, status: 'applied' }];

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, env)).statusCode).toBe(204);
    expect(noteDeadLetterReasons()).toEqual(['invalid-tenant']);
    expect(await projection(unknown, note.noteId)).toEqual([]);
    expect(await inboxRows(unknown)).toEqual([]);

    expect((await pushTo(built().app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(selfPooledSite(site)))).statusCode).toBe(204);

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, env)).statusCode).toBe(204);
    expect(await projection(unknown, note.noteId)).toEqual(applied);
    expect(await inboxRows(unknown, env.eventId)).toEqual(receipt);
    expect(noteDeadLetterReasons()).toEqual(['invalid-tenant']);

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, env)).statusCode).toBe(204);
    expect(await projection(unknown, note.noteId)).toEqual(applied);
    expect(await inboxRows(unknown, env.eventId)).toEqual(receipt);
  });
});
