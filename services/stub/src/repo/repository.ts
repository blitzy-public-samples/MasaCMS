/** The only data-access path of schema `stub`: the platform repository plus typed note, projection, comment and activity helpers. */
import { createRepository, qualified, type Repository } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { commentCursorOf, type CommentCursor, type NoteActivityRow, type NoteCommentRow } from '../domain/comment.js';
import { NOTE_PAGE_MAX, noteCursorOf, type NoteCursor, type NoteProjectionRow, type NoteRow } from '../domain/note.js';
import { NOTE_ACTIVITY_TABLE, NOTE_COMMENT_TABLE, NOTE_PROJECTION_TABLE, NOTE_TABLE, STUB_TABLES } from './tables.js';

/** Service name the stub write positions carry, as `stub=<xid>`. */
export const STUB_OWNER = 'stub';

/** Schema the stub service owns. */
export const STUB_SCHEMA = 'stub';

/** A note list request: up to `limit` notes after `after`, or from the first note when `after` is null. */
export interface NotePageRequest {
  after: NoteCursor | null;
  limit: number;
}

/** One page of notes; `next` positions the following page and is null after the last one. */
export interface NotePage {
  rows: NoteRow[];
  next: NoteCursor | null;
}

/** The platform repository of schema `stub` plus typed helpers; every helper runs in the caller's open tenant transaction. */
export type StubRepository = Repository & {
  /** The note with `noteId`; null when absent or another tenant's. */
  findNote(tx: TenantTx, noteId: string): Promise<NoteRow | null>;
  /** One page of the transaction tenant's notes, ordered by `created` then `note_id`; RangeError unless `limit` is an integer from 1 to NOTE_PAGE_MAX. */
  listNotes(tx: TenantTx, page: NotePageRequest): Promise<NotePage>;
  /** Deletes the note with `noteId`; false when none matched. */
  deleteNote(tx: TenantTx, noteId: string): Promise<boolean>;
  /** The projection of note `noteId`; null when it is not projected. */
  findProjection(tx: TenantTx, noteId: string): Promise<NoteProjectionRow | null>;
  /** Inserts `row`, or sets its columns on the stored projection with the same `note_id`. */
  upsertProjection(tx: TenantTx, row: NoteProjectionRow): Promise<void>;
  /**
   * Stores `comment` on its note and advances the note's `row_version`, holding the note's row lock until `tx` ends.
   * @returns the note's new `row_version`, the comment event's aggregate version; null when the note is absent or another tenant's.
   */
  addComment(tx: TenantTx, comment: NoteCommentRow): Promise<number | null>;
  /** One page of note `noteId`'s comments, ordered by `created` then `comment_id`; RangeError unless `limit` is an integer from 1 to NOTE_PAGE_MAX. */
  listComments(tx: TenantTx, noteId: string, page: CommentPageRequest): Promise<CommentPage>;
  /** Inserts one `stub.note_activity` row. */
  insertActivity(tx: TenantTx, row: NoteActivityRow): Promise<void>;
};

/** A comment list request: up to `limit` comments after `after`, or from the first when `after` is null. */
export interface CommentPageRequest {
  after: CommentCursor | null;
  limit: number;
}

/** One page of comments; `next` positions the following page and is null after the last one. */
export interface CommentPage {
  rows: NoteCommentRow[];
  next: CommentCursor | null;
}

/** Builds the stub repository over the platform repository of `STUB_TABLES`; `schema` differs from `stub` only for throwaway test schemas. */
export function createStubRepository({ clock, schema = STUB_SCHEMA }: { clock: Clock; schema?: string }): StubRepository {
  const base = createRepository({ owner: STUB_OWNER, schema, tables: STUB_TABLES, clock });
  // The platform repository has no list read, so listNotes runs its one SELECT inside base.read, behind the unit's window phase.
  // COLLATE "C" keeps note_id in plain code-unit order whatever the database collation; note_created_idx has the same order.
  const notes = qualified(schema, NOTE_TABLE.table);
  const noteOrder = 'ORDER BY created, note_id COLLATE "C"';
  const firstNotesSql = `SELECT * FROM ${notes} WHERE tenant_id = $1 ${noteOrder} LIMIT $2`;
  const nextNotesSql = `SELECT * FROM ${notes} WHERE tenant_id = $1 AND (created, note_id COLLATE "C") > ($2::timestamp(3), $3::bpchar) ${noteOrder} LIMIT $4`;

  function findNote(tx: TenantTx, noteId: string): Promise<NoteRow | null> {
    return base.findByKey<NoteRow>(tx, NOTE_TABLE.table, { note_id: noteId });
  }

  async function listNotes(tx: TenantTx, { after, limit }: NotePageRequest): Promise<NotePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_PAGE_MAX) {
      throw new RangeError(`note page limit must be an integer from 1 to ${NOTE_PAGE_MAX}, got ${String(limit)}`);
    }
    // One row past the page shows whether another page follows.
    const rows = await base.read(tx, NOTE_TABLE.unit, async () =>
      after === null
        ? (await tx.query<NoteRow>(firstNotesSql, [tx.tenantId, limit + 1])).rows
        : (await tx.query<NoteRow>(nextNotesSql, [tx.tenantId, after.created, after.noteId, limit + 1])).rows,
    );
    return rows.length > limit ? { rows: rows.slice(0, limit), next: noteCursorOf(rows[limit - 1] as NoteRow) } : { rows, next: null };
  }

  async function deleteNote(tx: TenantTx, noteId: string): Promise<boolean> {
    return (await base.delete(tx, NOTE_TABLE.table, { note_id: noteId })) !== null;
  }

  function findProjection(tx: TenantTx, noteId: string): Promise<NoteProjectionRow | null> {
    return base.findByKey<NoteProjectionRow>(tx, NOTE_PROJECTION_TABLE.table, { note_id: noteId });
  }

  async function upsertProjection(tx: TenantTx, row: NoteProjectionRow): Promise<void> {
    await base.upsert(tx, NOTE_PROJECTION_TABLE.table, row);
  }

  // The note's row lock serialises its comments, so each comment event gets the next row_version.
  const lockNoteSql = `SELECT row_version FROM ${notes} WHERE tenant_id = $1 AND note_id = $2 FOR UPDATE`;
  const comments = qualified(schema, NOTE_COMMENT_TABLE.table);
  const commentOrder = 'ORDER BY created, comment_id COLLATE "C"';
  const firstCommentsSql = `SELECT * FROM ${comments} WHERE tenant_id = $1 AND note_id = $2 ${commentOrder} LIMIT $3`;
  const nextCommentsSql = `SELECT * FROM ${comments} WHERE tenant_id = $1 AND note_id = $2 AND (created, comment_id COLLATE "C") > ($3::timestamp(3), $4::bpchar) ${commentOrder} LIMIT $5`;

  async function addComment(tx: TenantTx, comment: NoteCommentRow): Promise<number | null> {
    const locked = await base.read(
      tx,
      NOTE_TABLE.unit,
      async () => (await tx.query<Pick<NoteRow, 'row_version'>>(lockNoteSql, [tx.tenantId, comment.note_id])).rows[0],
    );
    if (locked === undefined) return null;
    const version = Number(locked.row_version) + 1;
    await base.update(tx, NOTE_TABLE.table, { note_id: comment.note_id }, { row_version: version });
    await base.insert(tx, NOTE_COMMENT_TABLE.table, comment);
    return version;
  }

  async function listComments(tx: TenantTx, noteId: string, { after, limit }: CommentPageRequest): Promise<CommentPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_PAGE_MAX) {
      throw new RangeError(`comment page limit must be an integer from 1 to ${NOTE_PAGE_MAX}, got ${String(limit)}`);
    }
    const rows = await base.read(tx, NOTE_COMMENT_TABLE.unit, async () =>
      after === null
        ? (await tx.query<NoteCommentRow>(firstCommentsSql, [tx.tenantId, noteId, limit + 1])).rows
        : (await tx.query<NoteCommentRow>(nextCommentsSql, [tx.tenantId, noteId, after.created, after.commentId, limit + 1])).rows,
    );
    return rows.length > limit
      ? { rows: rows.slice(0, limit), next: commentCursorOf(rows[limit - 1] as NoteCommentRow) }
      : { rows, next: null };
  }

  async function insertActivity(tx: TenantTx, row: NoteActivityRow): Promise<void> {
    await base.insert(tx, NOTE_ACTIVITY_TABLE.table, row);
  }

  return Object.freeze({
    ...base,
    findNote,
    listNotes,
    deleteNote,
    findProjection,
    upsertProjection,
    addComment,
    listComments,
    insertActivity,
  });
}
