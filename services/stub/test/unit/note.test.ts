/** Note aggregate of the stub: create schema, list paging, row mapping and created-event payload. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { localTimestamp } from '@opt2/platform/outbox';
import { fixedClock } from '@opt2/platform/testing';
import {
  NOTE_PAGE_DEFAULT,
  NOTE_PAGE_MAX,
  formatNoteCursor,
  newNote,
  noteCreateSchema,
  noteCreatedPayload,
  noteCursorOf,
  noteFromRow,
  noteListQuerySchema,
  noteToRow,
  parseNoteCursor,
  projectionFromRow,
  type Note,
  type NoteCursor,
  type NoteProjectionRow,
} from '../../src/domain/note.js';
import { noteCreatedValidator } from '../../src/events/topics.js';

const CLOCK = fixedClock('2024-01-02T03:04:05.678');
const CREATED = '2024-01-02 03:04:05.678';
const CREATED_DATE = new Date(2024, 0, 2, 3, 4, 5, 678);
const PROJECTED = '2024-01-02 03:04:06.001';
const PROJECTED_DATE = new Date(2024, 0, 2, 3, 4, 6, 1);
const NOTE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const TENANT_ID = '5b0c2f4e-1d3a-4c8b-9e7f-2a6d8c4b1e30';
const EVENT_ID = '0f9c3a52-8d4e-4b6a-9e21-5c7d3b1a8f60';

const NOTE_COLUMNS = ['tenant_id', 'note_id', 'title', 'body', 'created', 'row_version'];
const NOTE_PROJECTION_COLUMNS = [
  'tenant_id',
  'note_id',
  'title',
  'body',
  'created',
  'aggregate_version',
  'apply_count',
  'last_event_id',
  'projected_at',
];

function migrationColumns(table: string): string[] {
  const sql = readFileSync(new URL('../../db/migrations/0001_stub.sql', import.meta.url), 'utf8');
  const block = sql.split(`CREATE TABLE stub.${table} (\n`)[1]?.split('\n);')[0] ?? '';
  return block.split('\n').flatMap((line) => /^\s+([a-z_]+)\s/.exec(line)?.slice(1, 2) ?? []);
}

function note(overrides: Partial<Note> = {}): Note {
  return { noteId: NOTE_ID, title: 'First note', body: 'Body text', created: CREATED, rowVersion: 1, ...overrides };
}

describe('noteCreateSchema', () => {
  it('trims the title and defaults the body', () => {
    expect(noteCreateSchema.parse({ title: '  First note  ' })).toEqual({ title: 'First note', body: '' });
  });

  it.each([
    { label: 'lower case', input: { title: 'T', body: 'B' } },
    { label: 'upper case', input: { TITLE: 'T', BODY: 'B' } },
    { label: 'mixed case', input: { Title: 'T', bOdY: 'B' } },
  ])('matches $label parameter names', ({ input }) => {
    expect(noteCreateSchema.parse(input)).toEqual({ title: 'T', body: 'B' });
  });

  it('drops unknown parameters', () => {
    expect(noteCreateSchema.parse({ title: 'T', siteid: 'default', NoteID: NOTE_ID })).toEqual({ title: 'T', body: '' });
  });

  it('accepts a 255-character title and a 10000-character body', () => {
    const input = { title: 't'.repeat(255), body: 'b'.repeat(10000) };
    expect(noteCreateSchema.parse(input)).toEqual(input);
  });

  it.each([
    { label: 'no title', input: { body: 'B' }, path: ['title'], code: 'invalid_type' },
    { label: 'a blank title', input: { title: '   ' }, path: ['title'], code: 'too_small' },
    { label: 'a 256-character title', input: { title: 't'.repeat(256) }, path: ['title'], code: 'too_big' },
    { label: 'a numeric title', input: { title: 1 }, path: ['title'], code: 'invalid_type' },
    { label: 'a 10001-character body', input: { title: 'T', body: 'b'.repeat(10001) }, path: ['body'], code: 'too_big' },
    { label: 'null', input: null, path: [], code: 'invalid_type' },
    { label: 'an array', input: [{ title: 'T' }], path: [], code: 'invalid_type' },
    { label: 'a string', input: 'title=T', path: [], code: 'invalid_type' },
  ])('rejects $label', ({ input, path, code }) => {
    const result = noteCreateSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => ({ path: issue.path, code: issue.code }))).toEqual([{ path, code }]);
  });
});

describe('newNote', () => {
  it('creates version 1 stamped from the clock', () => {
    const { noteId, ...state } = newNote({ title: 'T', body: 'B' }, CLOCK);
    expect(state).toEqual({ title: 'T', body: 'B', created: CREATED, rowVersion: 1 });
    expect(state.created).toBe(localTimestamp(CLOCK.now()));
    expect(isCfUuid(noteId)).toBe(true);
    expect(noteId).toBe(noteId.toUpperCase());
  });

  it('issues a fresh id per note', () => {
    const input = { title: 'T', body: '' };
    expect(newNote(input, CLOCK).noteId).not.toBe(newNote(input, CLOCK).noteId);
  });
});

describe('note rows', () => {
  it('lists the migration columns', () => {
    expect(migrationColumns('note')).toEqual(NOTE_COLUMNS);
    expect(migrationColumns('note_projection')).toEqual(NOTE_PROJECTION_COLUMNS);
  });

  it('noteToRow writes every stub.note column but tenant_id', () => {
    const row = noteToRow(note());
    expect(row).toEqual({ note_id: NOTE_ID, title: 'First note', body: 'Body text', created: CREATED, row_version: 1 });
    expect(Object.keys(row)).toEqual(NOTE_COLUMNS.filter((column) => column !== 'tenant_id'));
  });

  it('noteFromRow inverts noteToRow', () => {
    expect(noteFromRow(noteToRow(note()))).toEqual(note());
  });

  it.each([
    { label: 'pg Date and bigint text', created: CREATED_DATE, rowVersion: '7' },
    { label: 'text and number', created: CREATED, rowVersion: 7 },
  ])('noteFromRow reads $label', ({ created, rowVersion }) => {
    const row = { tenant_id: TENANT_ID, note_id: NOTE_ID, title: 'T', body: '', created, row_version: rowVersion };
    expect(noteFromRow(row)).toEqual({ noteId: NOTE_ID, title: 'T', body: '', created: CREATED, rowVersion: 7 });
  });

  it.each([
    { label: 'pg Dates and bigint text', created: CREATED_DATE, projectedAt: PROJECTED_DATE, version: '3' },
    { label: 'text and number', created: CREATED, projectedAt: PROJECTED, version: 3 },
  ])('projectionFromRow reads $label', ({ created, projectedAt, version }) => {
    const row: NoteProjectionRow = {
      tenant_id: TENANT_ID,
      note_id: NOTE_ID,
      title: 'T',
      body: 'B',
      created,
      aggregate_version: version,
      apply_count: 2,
      last_event_id: EVENT_ID,
      projected_at: projectedAt,
    };
    expect(Object.keys(row)).toEqual(NOTE_PROJECTION_COLUMNS);
    expect(projectionFromRow(row)).toEqual({
      noteId: NOTE_ID,
      title: 'T',
      body: 'B',
      created: CREATED,
      aggregateVersion: 3,
      applyCount: 2,
      lastEventId: EVENT_ID,
      projectedAt: PROJECTED,
    });
  });
});

describe('note list paging', () => {
  const CURSOR: NoteCursor = { created: CREATED, noteId: NOTE_ID };
  const CURSOR_TEXT = formatNoteCursor(CURSOR);

  function encoded(value: unknown): string {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
  }

  // Years a JS Date parses that lie outside the four-digit years 0001-9999.
  const OUT_OF_RANGE_YEARS = [
    { label: 'a created in year 0000', created: '0000-01-01 00:00:00.000' },
    { label: 'a created with a signed expanded year', created: '+012026-01-02 03:04:05.678' },
    { label: 'a created with a negative year', created: '-000001-01-01 00:00:00.000' },
  ];

  it('formatNoteCursor writes base64url JSON that parseNoteCursor reads back', () => {
    expect(CURSOR_TEXT).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(CURSOR_TEXT, 'base64url').toString('utf8'))).toEqual(CURSOR);
    expect(parseNoteCursor(CURSOR_TEXT)).toEqual(CURSOR);
  });

  it.each([
    { label: 'a pg Date', created: CREATED_DATE },
    { label: 'text', created: CREATED },
  ])('noteCursorOf positions after a row whose created is $label', ({ created }) => {
    expect(noteCursorOf({ tenant_id: TENANT_ID, note_id: NOTE_ID, title: 'T', body: '', created, row_version: '1' })).toEqual(CURSOR);
  });

  it.each([
    { label: 'empty text', text: '' },
    { label: 'non-base64url text', text: '!!!' },
    { label: 'base64url of non-JSON', text: encoded('not json') },
    { label: 'JSON null', text: encoded(null) },
    { label: 'a JSON array', text: encoded([CREATED, NOTE_ID]) },
    { label: 'a missing noteId', text: encoded({ created: CREATED }) },
    { label: 'an extra key', text: encoded({ ...CURSOR, tenantId: TENANT_ID }) },
    { label: 'an RFC UUID noteId', text: encoded({ created: CREATED, noteId: TENANT_ID }) },
    { label: 'a numeric created', text: encoded({ created: 1, noteId: NOTE_ID }) },
    { label: 'a created without milliseconds', text: encoded({ created: '2024-01-02 03:04:05', noteId: NOTE_ID }) },
    { label: 'a created with a T separator', text: encoded({ created: '2024-01-02T03:04:05.678', noteId: NOTE_ID }) },
    { label: 'a created on no calendar day', text: encoded({ created: '2024-02-30 03:04:05.678', noteId: NOTE_ID }) },
    { label: 'a created in month 13', text: encoded({ created: '2024-13-02 03:04:05.678', noteId: NOTE_ID }) },
    ...OUT_OF_RANGE_YEARS.map(({ label, created }) => ({ label, text: encoded({ created, noteId: NOTE_ID }) })),
  ])('parseNoteCursor answers null for $label', ({ text }) => {
    expect(parseNoteCursor(text)).toBeNull();
  });

  it.each(['0001-01-01 00:00:00.000', '9999-12-31 23:59:59.999'])('reads a cursor created at %s, a bound of the accepted years', (created) => {
    const cursor: NoteCursor = { created, noteId: NOTE_ID };

    expect(parseNoteCursor(formatNoteCursor(cursor))).toEqual(cursor);
    expect(noteListQuerySchema.parse({ after: formatNoteCursor(cursor) })).toEqual({ limit: NOTE_PAGE_DEFAULT, after: cursor });
  });

  it('noteListQuerySchema reads an absent limit and after as the first page of NOTE_PAGE_DEFAULT notes', () => {
    expect([NOTE_PAGE_DEFAULT, NOTE_PAGE_MAX]).toEqual([50, 1000]);
    expect(noteListQuerySchema.parse({ siteid: 'default' })).toEqual({ limit: NOTE_PAGE_DEFAULT, after: null });
  });

  it.each([
    { label: 'lower case', input: { limit: '1', after: CURSOR_TEXT }, limit: 1 },
    { label: 'upper case', input: { LIMIT: '1000', AFTER: CURSOR_TEXT }, limit: NOTE_PAGE_MAX },
  ])('noteListQuerySchema reads $label limit and after', ({ input, limit }) => {
    expect(noteListQuerySchema.parse(input)).toEqual({ limit, after: CURSOR });
  });

  it.each([
    { label: 'limit 0', input: { limit: '0' }, path: ['limit'] },
    { label: 'limit 1001', input: { limit: '1001' }, path: ['limit'] },
    { label: 'a signed limit', input: { limit: '+5' }, path: ['limit'] },
    { label: 'a fractional limit', input: { limit: '1.5' }, path: ['limit'] },
    { label: 'a repeated limit', input: { limit: ['1', '2'] }, path: ['limit'] },
    { label: 'an empty after', input: { after: '' }, path: ['after'] },
    { label: 'a malformed after', input: { after: 'not-a-cursor' }, path: ['after'] },
    ...OUT_OF_RANGE_YEARS.map(({ label, created }) => ({
      label: `an after with ${label}`,
      input: { after: encoded({ created, noteId: NOTE_ID }) },
      path: ['after'],
    })),
  ])('noteListQuerySchema rejects $label', ({ input, path }) => {
    const result = noteListQuerySchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
  });
});

describe('noteCreatedPayload', () => {
  it('carries the full note state', () => {
    expect(noteCreatedPayload(note({ rowVersion: 4 }))).toEqual({
      noteId: NOTE_ID,
      title: 'First note',
      body: 'Body text',
      created: CREATED,
      rowVersion: 4,
    });
  });

  it('satisfies the event contract for a new note', () => {
    const payload = noteCreatedPayload(newNote(noteCreateSchema.parse({ TITLE: 'T' }), CLOCK));
    expect(noteCreatedValidator.validatePayload(payload)).toEqual({ ok: true, value: payload });
  });
});
