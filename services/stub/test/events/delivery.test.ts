/** Push delivery of the stub's consumers against PostgreSQL: one effect per event and destination, stale state versions, registry upserts, the note re-check and dead letters. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type EventEnvelope } from '@opt2/platform/events';
import { GATE_WAIT_MS, closeGates, decodeRow, openGates, type ExportResponse } from '@opt2/platform/migration-kit';
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
  TENANT_B,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  mintServiceToken,
  pgAvailable,
  pushTo,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { newComment, noteCommentedPayload, type NoteCommentedPayload } from '../../src/domain/comment.js';
import { newNote, noteCreatedPayload, noteToRow, type Note } from '../../src/domain/note.js';
import {
  NOTE_COMMENTED_SUBSCRIPTION,
  NOTE_COMMENTED_TOPIC,
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
} from '../../src/events/topics.js';
import { createStubRepository, type StubRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildDbApp, createFakeTaskPort, type TestApp } from '../helpers/app.js';

type NotePayload = ReturnType<typeof noteCreatedPayload>;
type StubApp = TestApp<TenantDb>['app'];
// Type aliases, not interfaces, so they satisfy pg's QueryResultRow index signature.
type ProjectionRow = { title: string; aggregate_version: number; apply_count: number; last_event_id: string };
type InboxRow = { event_id: string; status: string };
type ActivityRow = { event_id: string; comment_id: string; aggregate_version: number };
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
const pg = await pgAvailable();
const publisher = createCapturingPublisher();
let schema: ThrowawaySchema | undefined;
let service: TestApp<TenantDb> | undefined;
let repository: StubRepository | undefined;

beforeAll(async () => {
  if (!pg) return;
  // ThrowawaySchemaOptions.migrationsDir is a filesystem path, so the module-relative URL is converted.
  schema = await createThrowawaySchema({
    service: 'stub',
    migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
  });
  await seedRegistry(schema.app, schema.schema);
  repository = createStubRepository({ clock: TEST_CLOCK, schema: schema.schema });
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

/** The stub app, throwaway schema and repository the file's `beforeAll` built. */
function built(): { app: StubApp; schema: ThrowawaySchema; repository: StubRepository } {
  if (schema === undefined || service === undefined || repository === undefined) throw new Error('beforeAll built no stub app');
  return { app: service.app, schema, repository };
}

/** A new note titled `title`, stored under `tenantId` through the stub repository as the create route stores it. */
async function storedNote(tenantId: string, title: string): Promise<Note> {
  const note = newNote({ title, body: '' }, TEST_CLOCK);
  const { schema: db, repository: stub } = built();
  await withTenant(db.app, tenantId, (tx) => stub.insert(tx, 'note', noteToRow(note)));
  return note;
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

/** A `stub.note.commented.v1` envelope of a new comment on `note` at `version`, shaped as the stub's outbox writes it. */
function commentEnvelope(note: Note, tenantId: string, version: number): EventEnvelope<NoteCommentedPayload> {
  return testEnvelope({
    topic: NOTE_COMMENTED_TOPIC,
    tenantId,
    aggregateType: 'note',
    aggregateId: note.noteId,
    aggregateVersion: version,
    payload: noteCommentedPayload(newComment(note.noteId, TENANT_A.siteId, 'Delivered comment', TEST_CLOCK)),
  });
}

/** The note's `note_activity` rows visible under `tenantId`, by event id. */
async function activity(tenantId: string, noteId: string): Promise<ActivityRow[]> {
  const { rows } = await withTenant(built().schema.app, tenantId, (tx) =>
    tx.query<ActivityRow>(
      'SELECT event_id, comment_id, aggregate_version::integer AS aggregate_version' +
        ` FROM ${table('note_activity')} WHERE note_id = $1 ORDER BY event_id`,
      [noteId],
    ),
  );
  return rows;
}

/** Tenant-a rows of `unit` for `noteId` from the stub's migration export, decoded with each value as text. */
async function exportedRows(unit: string, noteId: string): Promise<Record<string, string | null>[]> {
  const token = await mintServiceToken({ caller: 'migration', audience: 'stub', roles: [Roles.platformMigration] });
  const res = await built().app.inject({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=${unit}&tenantId=${TENANT_A.tenantId}`,
    headers: { [INVOCATION_HEADER]: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const page = res.json<ExportResponse>();
  expect(page.next).toBeNull();
  return page.tables
    .filter((exported) => exported.unit === unit)
    .flatMap((exported) => exported.rows.map((entry) => decodeRow(exported.columns, entry.row)))
    .map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value === null ? null : String(value)])))
    .filter((row) => row.note_id === noteId);
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
    const note = await storedNote(TENANT_A.tenantId, 'duplicate');
    const env = noteEnvelope(note, TENANT_A.tenantId);

    expect(statusCodes(await deliverDuplicate(built().app, NOTE_CREATED_SUBSCRIPTION, env))).toEqual([204, 204]);

    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([
      { title: 'duplicate', aggregate_version: 1, apply_count: 1, last_event_id: env.eventId },
    ]);
    expect(await inboxRows(TENANT_A.tenantId, env.eventId)).toEqual([{ event_id: env.eventId, status: 'applied' }]);
  });

  it('out-of-order delivery keeps the newest version', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'out-of-order');
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

  it('duplicate comment delivery records one activity', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'duplicate comment');
    const env = commentEnvelope(note, TENANT_A.tenantId, 2);

    expect(statusCodes(await deliverDuplicate(built().app, NOTE_COMMENTED_SUBSCRIPTION, env))).toEqual([204, 204]);

    expect(await activity(TENANT_A.tenantId, note.noteId)).toEqual([{ event_id: env.eventId, comment_id: env.payload.commentId, aggregate_version: 2 }]);
    expect(await inboxRows(TENANT_A.tenantId, env.eventId)).toEqual([{ event_id: env.eventId, status: 'applied' }]);
  });

  it('out-of-order comment versions each record their activity once', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'out-of-order comments');
    const sequence = versionedSequence(commentEnvelope(note, TENANT_A.tenantId, 2), [2, 3, 4], () =>
      noteCommentedPayload(newComment(note.noteId, TENANT_A.siteId, 'Late or early', TEST_CLOCK)),
    );

    expect(statusCodes(await deliverOutOfOrder(built().app, NOTE_COMMENTED_SUBSCRIPTION, sequence, [2, 0, 1]))).toEqual([204, 204, 204]);

    const expected = sequence
      .map(({ eventId, aggregateVersion, payload }) => ({ event_id: eventId, comment_id: payload.commentId, aggregate_version: aggregateVersion }))
      .sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
    expect(await activity(TENANT_A.tenantId, note.noteId)).toEqual(expected);
    for (const { eventId } of sequence) expect(await inboxRows(TENANT_A.tenantId, eventId)).toEqual([{ event_id: eventId, status: 'applied' }]);
  });

  it('exports the applied comment activity and note projection over their own columns', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'exported');
    const created = noteEnvelope(note, TENANT_A.tenantId);
    const commented = commentEnvelope(note, TENANT_A.tenantId, 2);
    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, created)).statusCode).toBe(204);
    expect((await pushTo(built().app, NOTE_COMMENTED_SUBSCRIPTION, commented)).statusCode).toBe(204);

    const activityRows = await exportedRows('stub.note_activity', note.noteId);
    const projectionRows = await exportedRows('stub.note_projection', note.noteId);

    expect(activityRows).toEqual([
      expect.objectContaining({ event_id: commented.eventId, comment_id: commented.payload.commentId, aggregate_version: '2' }),
    ]);
    expect(projectionRows).toEqual([expect.objectContaining({ last_event_id: created.eventId, apply_count: '1', aggregate_version: '1' })]);
  });

  it('comment on a note not stored under the envelope tenant is dead-lettered tenant-mismatch', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'foreign comment');
    const env = commentEnvelope(note, TENANT_B.tenantId, 2);

    expect((await pushTo(built().app, NOTE_COMMENTED_SUBSCRIPTION, env)).statusCode).toBe(204);

    expect(publisher.deadLetters(NOTE_COMMENTED_SUBSCRIPTION).map(({ reason }) => reason)).toEqual(['tenant-mismatch']);
    expect(await activity(TENANT_B.tenantId, note.noteId)).toEqual([]);
    expect(await activity(TENANT_A.tenantId, note.noteId)).toEqual([]);
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

describe.skipIf(!pg)('user-pool fan-out', () => {
  it('a fan-out interrupted after tenant A applied while umbrella note reads were blocked is redelivered and applies once per destination [events:fanoutRedelivery]', async () => {
    const { app, schema: db } = built();
    const note = await storedNote(TENANT_UMBRELLA.tenantId, 'pooled');
    const env = noteEnvelope(note, TENANT_UMBRELLA.tenantId);
    const applied = [{ title: 'pooled', aggregate_version: 1, apply_count: 1, last_event_id: env.eventId }];
    const receipt = [{ event_id: env.eventId, status: 'applied' }];
    const holderId = `delivery-test-${env.eventId}`;
    // A legacy write window's executing phase blocks reads of stub.note, which only the envelope tenant's re-check makes.
    await closeGates(db.app, { units: ['stub.note'], holderId, phase: 'executing' });
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    let first: { statusCode: number };
    try {
      const delivery = pushTo(app, NOTE_CREATED_SUBSCRIPTION, env);
      await vi.waitFor(async () => expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual(applied), { timeout: 10_000, interval: 50 });
      expect(await projection(TENANT_UMBRELLA.tenantId, note.noteId)).toEqual([]);
      // Moves the clock past the delivery's gate budget, so the blocked read gives up instead of waiting it out.
      skewMs = GATE_WAIT_MS;
      first = await delivery;
    } finally {
      clock.mockRestore();
      await openGates(db.app, { units: ['stub.note'], holderId });
    }
    expect(isAck(first)).toBe(false);
    expect(await inboxRows(TENANT_A.tenantId, env.eventId)).toEqual(receipt);
    expect(await inboxRows(TENANT_UMBRELLA.tenantId, env.eventId)).toEqual([]);

    expect(statusCodes(await deliverDuplicate(app, NOTE_CREATED_SUBSCRIPTION, env))).toEqual([204, 204]);

    for (const tenant of [TENANT_A, TENANT_UMBRELLA]) {
      expect(await projection(tenant.tenantId, note.noteId), tenant.siteId).toEqual(applied);
      expect(await inboxRows(tenant.tenantId, env.eventId), tenant.siteId).toEqual(receipt);
    }
    expect(await projection(TENANT_B.tenantId, note.noteId)).toEqual([]);
    expect(await inboxRows(TENANT_B.tenantId, env.eventId)).toEqual([]);
    expect(noteDeadLetterReasons()).toEqual([]);
  });
});

describe.skipIf(!pg)('dlq-replay', () => {
  it('tenantless envelope is dead-lettered', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'tenantless');
    const env = noteEnvelope(note, TENANT_A.tenantId);

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, withoutTenant(env))).statusCode).toBe(204);

    expect(noteDeadLetterReasons()).toEqual(['missing-tenant']);
    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([]);
  });

  it('unregistered tenant is dead-lettered, then replays once', async () => {
    const site = 'tenant-dlq';
    const unknown = tenantIdForSite(site);
    const note = await storedNote(unknown, 'replayed');
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

  it.each([
    { label: 'the aggregateId of another note', aggregate: 'other', aggregateVersion: 2, rowVersion: 2 },
    { label: 'an aggregateVersion other than its rowVersion', aggregate: 'own', aggregateVersion: 3, rowVersion: 1 },
  ])('note envelope with $label is dead-lettered schema-invalid, leaving both notes', async ({ aggregate, aggregateVersion, rowVersion }) => {
    const noteA = await storedNote(TENANT_A.tenantId, 'bound A');
    const noteB = await storedNote(TENANT_A.tenantId, 'bound B');
    for (const env of [noteEnvelope(noteA, TENANT_A.tenantId, 2), noteEnvelope(noteB, TENANT_A.tenantId)]) {
      expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, env)).statusCode).toBe(204);
    }
    const before = [await projection(TENANT_A.tenantId, noteA.noteId), await projection(TENANT_A.tenantId, noteB.noteId)];
    expect(before.map((rows) => rows.map(({ title, aggregate_version }) => [title, aggregate_version]))).toEqual([
      [['bound A', 2]],
      [['bound B', 1]],
    ]);
    const receipts = await inboxRows(TENANT_A.tenantId);
    // Unchecked, either envelope passes the version rule and overwrites note A's projection with a stale title.
    const mismatched = testEnvelope({
      topic: NOTE_CREATED_TOPIC,
      tenantId: TENANT_A.tenantId,
      aggregateType: 'note',
      aggregateId: aggregate === 'other' ? noteB.noteId : noteA.noteId,
      aggregateVersion,
      payload: { ...noteCreatedPayload(noteA), title: 'stale A', rowVersion },
    });

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, mismatched)).statusCode).toBe(204);

    expect(noteDeadLetterReasons()).toEqual(['schema-invalid']);
    expect([await projection(TENANT_A.tenantId, noteA.noteId), await projection(TENANT_A.tenantId, noteB.noteId)]).toEqual(before);
    expect(await inboxRows(TENANT_A.tenantId)).toEqual(receipts);
  });

  it('note envelope re-tenanted to another registered tenant is dead-lettered tenant-mismatch', async () => {
    const note = await storedNote(TENANT_A.tenantId, 'tenant A only');
    const env = noteEnvelope(note, TENANT_B.tenantId);

    expect((await pushTo(built().app, NOTE_CREATED_SUBSCRIPTION, env)).statusCode).toBe(204);

    expect(noteDeadLetterReasons()).toEqual(['tenant-mismatch']);
    expect(await projection(TENANT_B.tenantId, note.noteId)).toEqual([]);
    expect(await inboxRows(TENANT_B.tenantId, env.eventId)).toEqual([]);
    expect(await projection(TENANT_A.tenantId, note.noteId)).toEqual([]);
  });
});
