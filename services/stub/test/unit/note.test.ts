/** Note aggregate of the stub: create schema, row mapping and created-event payload. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { localTimestamp } from '@opt2/platform/outbox';
import { fixedClock } from '@opt2/platform/testing';
import {
  newNote,
  noteCreateSchema,
  noteCreatedPayload,
  noteFromRow,
  noteToRow,
  projectionFromRow,
  type Note,
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
