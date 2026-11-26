/** Stub push consumers: the note projection over a fake repository, and the registrations the stub passes to `registerConsumers`. */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { parseTopic, subscriptionName, topicMeta, type ConsumeContext, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { tenantIdForSite, tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
import { fixedClock, testEnvelope, type Clock } from '@opt2/platform/testing';
import type { NoteCommentedPayload } from '../../src/domain/comment.js';
import type { NoteProjectionRow } from '../../src/domain/note.js';
import { noteActivityConsumer, noteProjectionConsumer, stubConsumers } from '../../src/events/consumers.js';
import {
  NOTE_COMMENTED_SUBSCRIPTION,
  NOTE_COMMENTED_TOPIC,
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
  noteCommentedSchema,
  noteCreatedSchema,
  siteChangedSchema,
} from '../../src/events/topics.js';
import type { StubNoteCreatedV1Payload } from '../../src/generated/events/stub.note.created.v1.js';
import type { StubRepository } from '../../src/repo/repository.js';

const TENANT_ID = tenantIdForSite('default');
const OTHER_TENANT_ID = tenantIdForSite('tenant-b');
const FANOUT_TENANT_ID = tenantIdForSite('tenant-a');
const NOTE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const OTHER_NOTE_ID = 'B2C3D4E5-F607-1829-3A4B5C6D7E8F9012';
const COMMENT_ID = 'C3D4E5F6-0718-293A-4B5C6D7E8F901234';
const CREATED = '2026-06-30 11:59:00.000';
const EVENT_1 = '11111111-1111-4111-8111-111111111111';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const FIRST_APPLY = new Date(2026, 5, 30, 12, 0, 0);
const SECOND_APPLY = new Date(2026, 5, 30, 12, 0, 1, 250);
const LOGGER = createLogger({ service: 'stub', version: '1.0.0', env: 'local', level: 'silent' });

type RepositoryCall = { method: 'findNote' | 'findProjection' | 'upsertProjection' | 'insertActivity'; tx: TenantTx; arg: unknown };

/** `findNote` over `notes`, the projection methods over an in-memory `note_id` map and `insertActivity`, logging each call in order. */
function fakeRepository(notes: ReadonlyArray<{ tenantId: string; noteId: string }> = []): {
  repository: StubRepository;
  rows: Map<string, NoteProjectionRow>;
  calls: RepositoryCall[];
} {
  const rows = new Map<string, NoteProjectionRow>();
  const calls: RepositoryCall[] = [];
  const projections: Pick<StubRepository, 'findNote' | 'findProjection' | 'upsertProjection' | 'insertActivity'> = {
    findNote(tx, noteId) {
      calls.push({ method: 'findNote', tx, arg: noteId });
      const stored = notes.some((note) => note.tenantId === tx.tenantId && note.noteId === noteId);
      return Promise.resolve(stored ? { note_id: noteId, title: 'Stored', body: '', created: CREATED, row_version: 1 } : null);
    },
    findProjection(tx, noteId) {
      calls.push({ method: 'findProjection', tx, arg: noteId });
      return Promise.resolve(rows.get(noteId) ?? null);
    },
    upsertProjection(tx, row) {
      calls.push({ method: 'upsertProjection', tx, arg: row });
      rows.set(row.note_id, row);
      return Promise.resolve();
    },
    insertActivity(tx, row) {
      calls.push({ method: 'insertActivity', tx, arg: row });
      return Promise.resolve();
    },
  };
  return { repository: projections as StubRepository, rows, calls };
}

/** Tenants holding a registry entry's user pools; each defaults to the entry's own tenant. */
interface UserPools {
  publicUser?: string;
  privateUser?: string;
}

/** An open tenant transaction and its raw `query` mock, which only the registry lookup uses; `registered` answers it with an entry of `pools`. */
function tenantTx(tenantId = TENANT_ID, registered = false, pools: UserPools = {}): { tx: TenantTx; query: Mock } {
  const entry = {
    site_id: 'default',
    tenant_id: tenantId,
    public_user_pool_tenant: pools.publicUser ?? tenantId,
    private_user_pool_tenant: pools.privateUser ?? tenantId,
    aggregate_version: '1',
  };
  const rows = registered ? [entry] : [];
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { tx: { kind: 'tenant', tenantId, schema: 'stub', query, onCommit: vi.fn() }, query };
}

/** A clock returning `instants` in turn, one per read, and its `now` mock. */
function steppingClock(...instants: Date[]): { clock: Clock; now: Mock<() => Date> } {
  const now = vi.fn<() => Date>();
  for (const instant of instants) now.mockReturnValueOnce(instant);
  return { clock: { now }, now };
}

function noteEnvelope(aggregateVersion: number, eventId: string, title: string): EventEnvelope<StubNoteCreatedV1Payload> {
  return testEnvelope({
    topic: NOTE_CREATED_TOPIC,
    tenantId: TENANT_ID,
    aggregateId: NOTE_ID,
    aggregateVersion,
    eventId,
    payload: { noteId: NOTE_ID, title, body: 'Body text', created: CREATED, rowVersion: aggregateVersion },
  });
}

function consumeContext(): ConsumeContext {
  return { subscription: NOTE_CREATED_SUBSCRIPTION, messageId: '1', destinationTenantId: TENANT_ID, isFanout: false, logger: LOGGER };
}

describe('noteProjectionConsumer', () => {
  it('consumes the note topic as a state topic with a user-pool fan-out and without supersedes, with its own tenant check', () => {
    const consumer = noteProjectionConsumer(fakeRepository().repository, fixedClock(FIRST_APPLY));

    expect(consumer).toMatchObject({ topic: NOTE_CREATED_TOPIC, kind: 'state', fanout: 'userPool' });
    expect(Object.keys(consumer).sort()).toEqual(['apply', 'checkTenant', 'fanout', 'kind', 'topic']);
  });

  const valid = noteEnvelope(1, EVENT_1, 'First note');
  it.each([
    { label: 'accepts the stored note of a registered destination', envelope: valid, tenantId: TENANT_ID, registered: true, verdict: true, lookups: 1, found: [NOTE_ID] },
    { label: 'dead-letters as schema-invalid an aggregateId of another note', envelope: { ...valid, aggregateId: OTHER_NOTE_ID }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as schema-invalid an aggregateId differing only in case', envelope: { ...valid, aggregateId: NOTE_ID.toLowerCase() }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as schema-invalid an aggregateVersion other than rowVersion', envelope: { ...valid, aggregateVersion: 2 }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as schema-invalid an aggregateType other than note', envelope: { ...valid, aggregateType: 'site' }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as invalid-tenant an unregistered destination', envelope: valid, tenantId: TENANT_ID, registered: false, verdict: 'invalid-tenant', lookups: 1, found: [] },
    { label: 'dead-letters as tenant-mismatch a note not stored under the destination', envelope: { ...valid, tenantId: OTHER_TENANT_ID }, tenantId: OTHER_TENANT_ID, registered: true, verdict: 'tenant-mismatch', lookups: 1, found: [NOTE_ID] },
  ])('$label', async ({ envelope, tenantId, registered, verdict, lookups, found }) => {
    const { repository, calls } = fakeRepository([{ tenantId: TENANT_ID, noteId: NOTE_ID }]);
    const { tx, query } = tenantTx(tenantId, registered);

    await expect(noteProjectionConsumer(repository, fixedClock(FIRST_APPLY)).checkTenant?.(tx, envelope)).resolves.toBe(verdict);

    expect(query).toHaveBeenCalledTimes(lookups);
    expect(query.mock.calls.map(([, params]) => params)).toEqual(Array(lookups).fill([tenantId]));
    expect(calls).toEqual(found.map((arg) => ({ method: 'findNote', tx, arg })));
  });

  it.each([
    { label: 'accepts a fan-out destination whose public user pool is the envelope tenant', pools: { publicUser: TENANT_ID }, verdict: true },
    { label: 'accepts a fan-out destination whose private user pool is the envelope tenant', pools: { privateUser: TENANT_ID }, verdict: true },
    { label: 'dead-letters as tenant-mismatch a fan-out destination pooling its users elsewhere', pools: {}, verdict: 'tenant-mismatch' },
  ])('$label without reading the note it does not store', async ({ pools, verdict }) => {
    const { repository, calls } = fakeRepository([{ tenantId: TENANT_ID, noteId: NOTE_ID }]);
    const { tx, query } = tenantTx(FANOUT_TENANT_ID, true, pools);

    await expect(noteProjectionConsumer(repository, fixedClock(FIRST_APPLY)).checkTenant?.(tx, valid)).resolves.toBe(verdict);

    expect(query.mock.calls.map(([, params]) => params)).toEqual([[FANOUT_TENANT_ID]]);
    expect(calls).toEqual([]);
  });

  it('projects a first delivery with apply_count 1, the envelope version and event id, stamped from the clock', async () => {
    const { repository, calls } = fakeRepository();
    const { clock, now } = steppingClock(FIRST_APPLY);
    const { tx, query } = tenantTx();

    await noteProjectionConsumer(repository, clock).apply(tx, noteEnvelope(1, EVENT_1, 'First note'), consumeContext());

    expect(calls).toEqual([
      { method: 'findProjection', tx, arg: NOTE_ID },
      {
        method: 'upsertProjection',
        tx,
        arg: {
          note_id: NOTE_ID,
          title: 'First note',
          body: 'Body text',
          created: CREATED,
          aggregate_version: 1,
          apply_count: 1,
          last_event_id: EVENT_1,
          projected_at: '2026-06-30 12:00:00.000',
        },
      },
    ]);
    expect(calls.every((call) => call.tx === tx)).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledOnce();
  });

  it('counts a further application on the stored projection and restamps it at apply time', async () => {
    const { repository, rows } = fakeRepository();
    const { clock, now } = steppingClock(FIRST_APPLY, SECOND_APPLY);
    const consumer = noteProjectionConsumer(repository, clock);

    await consumer.apply(tenantTx().tx, noteEnvelope(1, EVENT_1, 'First note'), consumeContext());
    await consumer.apply(tenantTx().tx, noteEnvelope(2, EVENT_2, 'Renamed note'), consumeContext());

    expect([...rows.values()]).toEqual([
      {
        note_id: NOTE_ID,
        title: 'Renamed note',
        body: 'Body text',
        created: CREATED,
        aggregate_version: 2,
        apply_count: 2,
        last_event_id: EVENT_2,
        projected_at: '2026-06-30 12:00:01.250',
      },
    ]);
    expect(now).toHaveBeenCalledTimes(2);
  });
});

function commentEnvelope(aggregateVersion: number, eventId: string): EventEnvelope<NoteCommentedPayload> {
  return testEnvelope({
    topic: NOTE_COMMENTED_TOPIC,
    tenantId: TENANT_ID,
    aggregateId: NOTE_ID,
    aggregateVersion,
    eventId,
    payload: { noteId: NOTE_ID, commentId: COMMENT_ID, body: 'Comment text', created: CREATED },
  });
}

describe('noteActivityConsumer', () => {
  it('consumes the comment topic as a process topic without fan-out or supersedes, with its own tenant check', () => {
    const consumer = noteActivityConsumer(fakeRepository().repository, fixedClock(FIRST_APPLY));

    expect(consumer).toMatchObject({ topic: NOTE_COMMENTED_TOPIC, kind: 'process' });
    expect(Object.keys(consumer).sort()).toEqual(['apply', 'checkTenant', 'kind', 'topic']);
  });

  const valid = commentEnvelope(2, EVENT_1);
  it.each([
    { label: 'accepts the stored note of a registered destination', envelope: valid, tenantId: TENANT_ID, registered: true, verdict: true, lookups: 1, found: [NOTE_ID] },
    { label: 'dead-letters as schema-invalid an aggregateId of another note', envelope: { ...valid, aggregateId: OTHER_NOTE_ID }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as schema-invalid an aggregateType other than note', envelope: { ...valid, aggregateType: 'comment' }, tenantId: TENANT_ID, registered: true, verdict: 'schema-invalid', lookups: 0, found: [] },
    { label: 'dead-letters as invalid-tenant an unregistered destination', envelope: valid, tenantId: TENANT_ID, registered: false, verdict: 'invalid-tenant', lookups: 1, found: [] },
    { label: 'dead-letters as tenant-mismatch a note not stored under the destination', envelope: { ...valid, tenantId: OTHER_TENANT_ID }, tenantId: OTHER_TENANT_ID, registered: true, verdict: 'tenant-mismatch', lookups: 1, found: [NOTE_ID] },
  ])('$label', async ({ envelope, tenantId, registered, verdict, lookups, found }) => {
    const { repository, calls } = fakeRepository([{ tenantId: TENANT_ID, noteId: NOTE_ID }]);
    const { tx, query } = tenantTx(tenantId, registered);

    await expect(noteActivityConsumer(repository, fixedClock(FIRST_APPLY)).checkTenant?.(tx, envelope)).resolves.toBe(verdict);

    expect(query).toHaveBeenCalledTimes(lookups);
    expect(calls).toEqual(found.map((arg) => ({ method: 'findNote', tx, arg })));
  });

  it('records one activity row with the event id, note, comment and envelope version, stamped from the clock', async () => {
    const { repository, calls } = fakeRepository();
    const { clock, now } = steppingClock(FIRST_APPLY);
    const { tx, query } = tenantTx();

    await noteActivityConsumer(repository, clock).apply(tx, commentEnvelope(2, EVENT_1), consumeContext());

    expect(calls).toEqual([
      {
        method: 'insertActivity',
        tx,
        arg: { event_id: EVENT_1, note_id: NOTE_ID, comment_id: COMMENT_ID, aggregate_version: 2, applied_at: '2026-06-30 12:00:00.000' },
      },
    ]);
    expect(query).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledOnce();
  });
});

describe('stubConsumers', () => {
  const registrations = stubConsumers(fakeRepository().repository, fixedClock(FIRST_APPLY));

  it('registers the note projection, then the platform site registry consumer, each with its topic payload schema', () => {
    expect(registrations).toHaveLength(3);
    const [note, site] = registrations;
    expect(note?.consumer).toMatchObject({ topic: NOTE_CREATED_TOPIC, kind: 'state' });
    expect(note?.payloadSchema).toBe(noteCreatedSchema);
    expect(site?.consumer).toBe(tenantRegistryConsumer);
    expect(site?.payloadSchema).toBe(siteChangedSchema);
  });

  it('registers the note activity consumer last, with the comment payload schema', () => {
    const activity = registrations[2];
    expect(activity?.consumer).toMatchObject({ topic: NOTE_COMMENTED_TOPIC, kind: 'process' });
    expect(activity?.payloadSchema).toBe(noteCommentedSchema);
  });

  it('subscribes the stub as stub.<topic> on its note and site registry subscriptions', () => {
    expect(registrations.map(({ consumer }) => consumer.topic)).toEqual([NOTE_CREATED_TOPIC, SITE_CHANGED_TOPIC, NOTE_COMMENTED_TOPIC]);
    expect(registrations.map(({ consumer }) => subscriptionName('stub', consumer.topic))).toEqual([
      NOTE_CREATED_SUBSCRIPTION,
      SITE_CHANGED_SUBSCRIPTION,
      NOTE_COMMENTED_SUBSCRIPTION,
    ]);
  });

  it.each([
    { topic: NOTE_CREATED_TOPIC, index: 0 },
    { topic: SITE_CHANGED_TOPIC, index: 1 },
    { topic: NOTE_COMMENTED_TOPIC, index: 2 },
  ])('pairs the $topic consumer with its own schema and matching x-opt2 declarations', ({ topic, index }) => {
    const { consumer, payloadSchema } = registrations[index] as (typeof registrations)[number];

    expect((payloadSchema as { $id?: unknown }).$id).toBe(`urn:opt2:${parseTopic(topic).service}:event:${topic}`);
    expect({ kind: consumer.kind, fanout: consumer.fanout, supersedes: consumer.supersedes }).toEqual(topicMeta(payloadSchema));
  });

  it('binds the note projection to the given repository and clock', async () => {
    const { repository, rows, calls } = fakeRepository();
    const [note] = stubConsumers(repository, steppingClock(SECOND_APPLY).clock);

    await note?.consumer.apply(tenantTx().tx, noteEnvelope(1, EVENT_1, 'First note'), consumeContext());

    expect(calls.map(({ method }) => method)).toEqual(['findProjection', 'upsertProjection']);
    expect(rows.get(NOTE_ID)).toMatchObject({ apply_count: 1, last_event_id: EVENT_1, projected_at: '2026-06-30 12:00:01.250' });
  });
});
