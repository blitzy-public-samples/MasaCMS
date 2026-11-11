/** Note aggregate of the platform-proof stub: creation input, row mapping and the created-event payload. */
import { z, type Clock } from '@opt2/platform/service-kit';
import { localTimestamp } from '@opt2/platform/outbox';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { StubNoteCreatedV1Payload } from '../generated/events/stub.note.created.v1.js';

// pg reads `timestamp(3) without time zone` as a Date in the process zone; writes pass `localTimestamp` text.
type TimestampValue = Date | string;
// pg reads `bigint` as decimal text.
type BigintValue = number | string;

/** A stub note; `noteId` is a CF UUID and `created` local `timestamp(3)` text, as the event payload carries them. */
export interface Note {
  noteId: string;
  title: string;
  body: string;
  created: string;
  rowVersion: number;
}

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's `Record<string, unknown>` rows.
/** A `stub.note` row; reads carry `tenant_id`, writes leave it to the repository's transaction tenant. */
export type NoteRow = {
  tenant_id?: string;
  note_id: string;
  title: string;
  body: string;
  created: TimestampValue;
  row_version: BigintValue;
};

/** Validates a note create request; parameter names match ignoring case and unknown parameters are dropped. */
export const noteCreateSchema = z.preprocess(
  lowerCaseKeys,
  z.object({
    title: z.string().trim().min(1).max(255),
    body: z.string().max(10000).default(''),
  }),
);

/** A parsed note create request. */
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

/** Creates version 1 of a note with a fresh CF UUID, stamped from `clock`. */
export function newNote(input: NoteCreateInput, clock: Clock): Note {
  return {
    noteId: cfUuid(),
    title: input.title,
    body: input.body,
    created: localTimestamp(clock.now()),
    rowVersion: 1,
  };
}

/** Maps a note to the `stub.note` row the repository writes. */
export function noteToRow(note: Note): NoteRow {
  return {
    note_id: note.noteId,
    title: note.title,
    body: note.body,
    created: note.created,
    row_version: note.rowVersion,
  };
}

/** Maps a stored or written `stub.note` row back to its note. */
export function noteFromRow(row: NoteRow): Note {
  return {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    created: timestampText(row.created),
    rowVersion: Number(row.row_version),
  };
}

/** Payload of the `stub.note.created.v1` event of `note`. */
export function noteCreatedPayload(note: Note): StubNoteCreatedV1Payload {
  return {
    noteId: note.noteId,
    title: note.title,
    body: note.body,
    created: note.created,
    rowVersion: note.rowVersion,
  };
}

/** A note as projected from its created event; `created` and `projectedAt` are local `timestamp(3)` text. */
export interface NoteProjection {
  noteId: string;
  title: string;
  body: string;
  created: string;
  aggregateVersion: number;
  applyCount: number;
  lastEventId: string;
  projectedAt: string;
}

/** A `stub.note_projection` row; reads carry `tenant_id`, writes leave it to the repository's transaction tenant. */
export type NoteProjectionRow = {
  tenant_id?: string;
  note_id: string;
  title: string;
  body: string;
  created: TimestampValue;
  aggregate_version: BigintValue;
  apply_count: number;
  last_event_id: string;
  projected_at: TimestampValue;
};

/** Maps a `stub.note_projection` row to its projection. */
export function projectionFromRow(row: NoteProjectionRow): NoteProjection {
  return {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    created: timestampText(row.created),
    aggregateVersion: Number(row.aggregate_version),
    applyCount: row.apply_count,
    lastEventId: row.last_event_id,
    projectedAt: timestampText(row.projected_at),
  };
}

function timestampText(value: TimestampValue): string {
  return value instanceof Date ? localTimestamp(value) : value;
}

// The NoteCreate contract matches parameter names ignoring case, as legacy request scopes do; legacyParamsOf keeps the caller's spelling.
function lowerCaseKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), entry]));
}
