/** Stub note routes and health through `app.inject` on the composed app over the recording database. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { LEGACY_ERROR_MAP, cfUuid, isCfUuid, legacyHeaders } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER, parseWritePosition } from '@opt2/platform/migration-kit';
import { NOTE_CREATED_TOPIC } from '../../src/events/topics.js';
import { NOTE_TABLE } from '../../src/repo/tables.js';
import { FIXED_XID, buildTestApp, createRecordingDb, headersFor, type RecordedWrite, type TestApp } from '../helpers/app.js';

type Method = 'GET' | 'POST' | 'DELETE';
type Payload = Record<string, unknown>;

/** A note as the legacy serializer emits it. */
interface NoteJson {
  noteid: string;
  title: string;
  body: string;
  created: string;
  rowversion: string;
}

interface NoteList {
  items: NoteJson[];
  next: string | null;
}

const NOTES_URL = '/opt2/stub/notes';
const POSITION = WRITE_POSITION_HEADER.toLowerCase();
const BUSINESS_TIME = '2026-06-30 12:00:00.000';
const PROJECTED_EVENT_ID = '2f1c6a4e-8b0d-4c3a-9e7f-1a2b3c4d5e6f';
const SEEDED = { note_id: cfUuid(), title: 'Seeded', body: 'Seeded body', created: BUSINESS_TIME, row_version: 1 };

// ReturnType<typeof buildTestApp> widens the publisher to its constraint, which has no `published`.
let ctx: TestApp;

function legacyError(type: keyof typeof LEGACY_ERROR_MAP): { message: string; code: string } {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return { message, code };
}

function send(method: Method, url: string, headers: Record<string, string>, payload?: Payload) {
  return ctx.app.inject({ method, url, headers, payload });
}

async function createNote(payload: Payload, url: string = NOTES_URL) {
  return send('POST', url, await headersFor('system-user'), payload);
}

async function createdNote(title: string): Promise<NoteJson> {
  const res = await createNote({ title, body: `${title} body` });
  expect(res.statusCode).toBe(200);
  return res.json<{ data: NoteJson }>().data;
}

/** The one recorded `op` write on `table`. */
function writeOf(op: RecordedWrite['op'], table: string): RecordedWrite {
  const found = ctx.db.writes.filter((write) => write.op === op && write.table === table);
  expect(found).toHaveLength(1);
  return found[0] as RecordedWrite;
}

function noteWrites(): RecordedWrite[] {
  return ctx.db.writes.filter((write) => write.table === NOTE_TABLE.table);
}

beforeEach(async () => {
  ctx = await buildTestApp({
    db: createRecordingDb({
      notes: [{ tenantId: TENANT_A.tenantId, row: SEEDED }],
      projections: [
        {
          tenantId: TENANT_A.tenantId,
          row: {
            note_id: SEEDED.note_id,
            title: SEEDED.title,
            body: SEEDED.body,
            created: BUSINESS_TIME,
            aggregate_version: 1,
            apply_count: 1,
            last_event_id: PROJECTED_EVENT_ID,
            projected_at: BUSINESS_TIME,
          },
        },
      ],
    }),
  });
});

afterEach(async () => ctx.app.close());

describe('createNote', () => {
  it('answers the saved note in the legacy envelope', async () => {
    const res = await createNote({ title: 'First', body: 'Text' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    const body = res.json<{ data: NoteJson }>();
    expect(body).toEqual({
      apiversion: 'v1',
      method: 'save',
      data: { noteid: body.data.noteid, title: 'First', body: 'Text', created: BUSINESS_TIME, rowversion: '1' },
    });
    expect(isCfUuid(body.data.noteid)).toBe(true);
  });

  it('writes the note, its changelog row and its outbox row in one committed transaction', async () => {
    const { noteid } = (await createNote({ title: 'First', body: 'Text' })).json<{ data: NoteJson }>().data;

    const inserts = [NOTE_TABLE.table, 'changelog', 'outbox'].map((table) => writeOf('insert', table));
    expect(new Set(inserts.map((write) => write.tx)).size).toBe(1);
    expect(inserts.map((write) => [write.tenantId, write.outcome])).toEqual(
      inserts.map(() => [TENANT_A.tenantId, 'committed']),
    );
    expect(ctx.db.rows('note', TENANT_A.tenantId)).toContainEqual(
      expect.objectContaining({ note_id: noteid, title: 'First', body: 'Text', row_version: 1 }),
    );
  });

  it('sends the stub write position and the legacy headers', async () => {
    const res = await createNote({ title: 'First', body: 'Text' });

    const position = res.headers[POSITION];
    expect(position).toMatch(/^stub=\d+$/);
    expect(parseWritePosition(position as string).get('stub')).toBe(FIXED_XID);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it('publishes the created event once the business transaction has committed', async () => {
    const { noteid } = (await createNote({ title: 'First', body: 'Text' })).json<{ data: NoteJson }>().data;

    expect(ctx.publisher.published).toHaveLength(1);
    const [published] = ctx.publisher.published;
    expect(published?.topic).toBe(NOTE_CREATED_TOPIC);
    expect(published?.envelope).toMatchObject({
      eventType: NOTE_CREATED_TOPIC.replace(/\.v\d+$/, ''),
      tenantId: TENANT_A.tenantId,
      aggregateType: 'note',
      aggregateId: noteid,
      aggregateVersion: 1,
    });
    expect(published?.envelope.payload).toEqual({ noteId: noteid, title: 'First', body: 'Text', created: BUSINESS_TIME, rowVersion: 1 });

    const insert = writeOf('insert', 'outbox');
    const stamp = writeOf('update', 'outbox');
    const commit = ctx.db.queries.findIndex((query) => query.tx === insert.tx && /^\s*commit\b/i.test(query.sql));
    const flushStart = ctx.db.queries.findIndex((query) => query.tx === stamp.tx);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(flushStart).toBeGreaterThan(commit);
    expect(ctx.db.rows('outbox', TENANT_A.tenantId)).toEqual([
      expect.objectContaining({ event_id: published?.envelope.eventId, published_at: BUSINESS_TIME }),
    ]);
  });
});

describe('rejections', () => {
  it.each([
    ['a blank title', 'POST', NOTES_URL, { title: '   ' }, 'save'],
    ['a list limit of 0', 'GET', `${NOTES_URL}?limit=0`, undefined, 'findMany'],
  ] as const)('answers invalidParameters for %s without writing', async (_label, method, url, payload, reported) => {
    const res = await send(method, url, await headersFor('system-user'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: legacyError('invalidParameters') });
    expect(noteWrites()).toEqual([]);
    expect(ctx.publisher.published).toEqual([]);
  });

  it.each([
    ['query', `${NOTES_URL}?siteid=${TENANT_B.siteId}`, { title: 'First' }],
    ['body', NOTES_URL, { title: 'First', siteid: TENANT_B.siteId }],
  ])('answers 403 on a site mismatch in the %s', async (_where, url, payload) => {
    const res = await createNote(payload, url);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: legacyError('authorization') });
    expect(noteWrites()).toEqual([]);
    expect(ctx.publisher.published).toEqual([]);
  });
});

describe('reads and delete', () => {
  it('lists the created note with the tenant notes to a member', async () => {
    const created = await createdNote('Listed');

    const res = await send('GET', NOTES_URL, await headersFor('member'));

    expect(res.statusCode).toBe(200);
    const body = res.json<{ method: string; data: NoteList }>();
    expect(body.method).toBe('findMany');
    expect(body.data.items.map((note) => note.noteid)).toEqual([SEEDED.note_id, created.noteid].sort());
    expect(body.data.items).toContainEqual(created);
    expect(body.data.next).toBeNull();
  });

  it('pages the list by limit and the next cursor', async () => {
    const created = await createdNote('Paged');
    const ordered = [SEEDED.note_id, created.noteid].sort();
    const member = await headersFor('member');

    const first = (await send('GET', `${NOTES_URL}?limit=1`, member)).json<{ data: NoteList }>().data;
    const second = (await send('GET', `${NOTES_URL}?limit=1&after=${first.next ?? ''}`, member)).json<{ data: NoteList }>().data;

    expect(first.items.map((note) => note.noteid)).toEqual(ordered.slice(0, 1));
    expect(first.next).toEqual(expect.any(String));
    expect(second.items.map((note) => note.noteid)).toEqual(ordered.slice(1));
    expect(second.next).toBeNull();
  });

  it('reads a created note by id', async () => {
    const created = await createdNote('Read');

    const res = await send('GET', `${NOTES_URL}/${created.noteid}`, await headersFor('member'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findOne', data: created });
    expect(res.headers[POSITION]).toBeUndefined();
  });

  it('reads the stored projection of a note', async () => {
    const res = await send('GET', `${NOTES_URL}/${SEEDED.note_id}/projection`, await headersFor('member'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'findProjection',
      data: {
        noteid: SEEDED.note_id,
        title: SEEDED.title,
        body: SEEDED.body,
        created: BUSINESS_TIME,
        aggregateversion: '1',
        applycount: '1',
        lasteventid: PROJECTED_EVENT_ID,
        projectedat: BUSINESS_TIME,
      },
    });
  });

  it('deletes a note for s2, then answers 404 for it', async () => {
    const created = await createdNote('Doomed');
    const s2 = await headersFor('s2');

    const deleted = await send('DELETE', `${NOTES_URL}/${created.noteid}`, s2);
    const read = await send('GET', `${NOTES_URL}/${created.noteid}`, s2);

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ apiversion: 'v1', method: 'delete', data: { deleted: true } });
    expect(parseWritePosition(deleted.headers[POSITION] as string).get('stub')).toBe(FIXED_XID);
    expect(ctx.db.rows('note', TENANT_A.tenantId).map((row) => row.note_id)).toEqual([SEEDED.note_id]);
    expect(read.statusCode).toBe(404);
  });

  it.each([
    ['GET', '', 'findOne'],
    ['GET', '/projection', 'invalid'],
    ['DELETE', '', 'delete'],
  ] as const)('answers the legacy 404 to %s note%s for an unknown id and for another tenant note', async (method, suffix, reported) => {
    const unknown = await send(method, `${NOTES_URL}/${cfUuid()}${suffix}`, await headersFor('s2'));
    const foreign = await send(method, `${NOTES_URL}/${SEEDED.note_id}${suffix}`, await headersFor('s2', { site: TENANT_B.siteId }));

    for (const res of [unknown, foreign]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: legacyError('invalidMethodCall') });
      expect(res.headers[POSITION]).toBeUndefined();
    }
    expect(ctx.db.rows('note', TENANT_A.tenantId).map((row) => row.note_id)).toEqual([SEEDED.note_id]);
  });
});

describe('healthz', () => {
  it('answers without credentials, with the legacy headers', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    for (const [name, value] of Object.entries(legacyHeaders())) expect(res.headers[name.toLowerCase()]).toBe(value);
  });
});
