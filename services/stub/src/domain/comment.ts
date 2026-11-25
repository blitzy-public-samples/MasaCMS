/** Note comments of the platform-proof stub: grant and comment input, comment list paging, row mapping and the commented-event payload. */
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { localTimestamp } from '@opt2/platform/outbox';
import { z, type Clock } from '@opt2/platform/service-kit';
import { isLocalTimestampText, lowerCaseKeys, pageLimitSchema, timestampText, type BigintValue, type TimestampValue } from './note.js';

/** `tenant_grant` kind that lets the grantee tenant comment on the grantor's note. */
export const NOTE_COMMENT_GRANT = 'note-comment';

/** A note comment; ids are CF UUIDs, `authorSiteId` is the commenter's token site and `created` local `timestamp(3)` text. */
export interface NoteComment {
  commentId: string;
  noteId: string;
  authorSiteId: string;
  body: string;
  created: string;
}

/** A `stub.note_comment` row; reads carry `tenant_id`, the note's tenant; writes leave it to the repository's transaction tenant. */
export type NoteCommentRow = {
  tenant_id?: string;
  comment_id: string;
  note_id: string;
  author_site_id: string;
  body: string;
  created: TimestampValue;
};

/** Payload of `stub.note.commented.v1`, as `contracts/events/stub.note.commented.v1.json` declares it. */
export interface NoteCommentedPayload {
  noteId: string;
  commentId: string;
  body: string;
  created: string;
}

/** A `stub.note_activity` row: one applied `stub.note.commented.v1` delivery. */
export type NoteActivityRow = {
  tenant_id?: string;
  event_id: string;
  note_id: string;
  comment_id: string;
  aggregate_version: BigintValue;
  applied_at: TimestampValue;
};

/** Validates a note grant request: `granteesiteid` is the granted site; parameter names match ignoring case. */
export const noteGrantSchema = z.preprocess(lowerCaseKeys, z.object({ granteesiteid: z.string().min(1) }));

/** Validates a comment request: `grantorsiteid` is the site whose note is commented; parameter names match ignoring case. */
export const commentCreateSchema = z.preprocess(
  lowerCaseKeys,
  z.object({
    grantorsiteid: z.string().min(1),
    body: z.string().min(1).max(10000),
  }),
);

/** A parsed comment request. */
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

/** A new comment on `noteId` by `authorSiteId` with a fresh CF UUID, stamped from `clock`. */
export function newComment(noteId: string, authorSiteId: string, body: string, clock: Clock): NoteComment {
  return { commentId: cfUuid(), noteId, authorSiteId, body, created: localTimestamp(clock.now()) };
}

/** Maps a comment to the `stub.note_comment` row the repository writes. */
export function commentToRow(comment: NoteComment): NoteCommentRow {
  return {
    comment_id: comment.commentId,
    note_id: comment.noteId,
    author_site_id: comment.authorSiteId,
    body: comment.body,
    created: comment.created,
  };
}

/** Maps a stored or written `stub.note_comment` row back to its comment. */
export function commentFromRow(row: NoteCommentRow): NoteComment {
  return {
    commentId: row.comment_id,
    noteId: row.note_id,
    authorSiteId: row.author_site_id,
    body: row.body,
    created: timestampText(row.created),
  };
}

/** Payload of the `stub.note.commented.v1` event of `comment`. */
export function noteCommentedPayload(comment: NoteComment): NoteCommentedPayload {
  return { noteId: comment.noteId, commentId: comment.commentId, body: comment.body, created: comment.created };
}

/** Keyset position after a comment: its `created` local `timestamp(3)` text and its CF UUID `commentId`. */
export interface CommentCursor {
  created: string;
  commentId: string;
}

const commentCursorSchema = z.strictObject({
  created: z.string().refine(isLocalTimestampText),
  commentId: z.string().refine(isCfUuid),
});

/** The cursor positioned after `row`. */
export function commentCursorOf(row: NoteCommentRow): CommentCursor {
  return { created: timestampText(row.created), commentId: row.comment_id };
}

/** Encodes `cursor` as a page's opaque `next` text: base64url of its JSON. */
export function formatCommentCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify({ created: cursor.created, commentId: cursor.commentId }), 'utf8').toString('base64url');
}

/** Decodes a `formatCommentCursor` text; null when it is not base64url JSON of a cursor. */
export function parseCommentCursor(text: string): CommentCursor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = commentCursorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Validates a comment list query as the note list's: `limit` 1 to 1000, default 50, and `after` a comment page cursor. */
export const commentListQuerySchema = z.preprocess(
  lowerCaseKeys,
  z.object({
    limit: pageLimitSchema,
    after: z
      .string()
      .transform((text, ctx) => {
        const cursor = parseCommentCursor(text);
        if (cursor === null) ctx.addIssue({ code: 'custom', message: 'after is not a comment page cursor' });
        return cursor ?? z.NEVER;
      })
      .nullable()
      .default(null),
  }),
);
