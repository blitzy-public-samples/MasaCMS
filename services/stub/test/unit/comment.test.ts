/** Note comments of the stub: grant and comment schemas, list paging, row mapping and the commented-event payload. */
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import {
  commentCreateSchema,
  commentCursorOf,
  commentFromRow,
  commentListQuerySchema,
  commentToRow,
  formatCommentCursor,
  newComment,
  noteCommentedPayload,
  noteGrantSchema,
  parseCommentCursor,
  type CommentCursor,
} from '../../src/domain/comment.js';
import { NOTE_PAGE_DEFAULT } from '../../src/domain/note.js';
import { NOTE_COMMENT_TABLE } from '../../src/repo/tables.js';
import { TEST_CLOCK } from '../helpers/app.js';

const CREATED = '2024-01-02 03:04:05.678';
const CREATED_DATE = new Date(2024, 0, 2, 3, 4, 5, 678);
const NOTE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const COMMENT_ID = 'B2C3D4E5-F607-1829-3A4B5C6D7E8F9012';
const CURSOR: CommentCursor = { created: CREATED, commentId: COMMENT_ID };

/** base64url of the JSON of `value`, as a page cursor carries it. */
function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('grant and comment schemas', () => {
  it.each([
    { label: 'lower case', input: { granteesiteid: 'tenant-b' } },
    { label: 'mixed case', input: { GranteeSiteID: 'tenant-b', siteid: 'default' } },
  ])('read the $label grantee site and drop other parameters', ({ input }) => {
    expect(noteGrantSchema.parse(input)).toEqual({ granteesiteid: 'tenant-b' });
  });

  it('keeps the comment body as sent and reads the grantor site ignoring case', () => {
    expect(commentCreateSchema.parse({ GrantorSiteID: 'default', Body: '  spaced  ', title: 'ignored' })).toEqual({
      grantorsiteid: 'default',
      body: '  spaced  ',
    });
  });
});

describe('comment rows and payload', () => {
  it('creates a comment with a fresh CF UUID stamped from the clock', () => {
    const comment = newComment(NOTE_ID, 'tenant-b', 'Text', TEST_CLOCK);

    expect(isCfUuid(comment.commentId)).toBe(true);
    expect(comment).toEqual({ commentId: comment.commentId, noteId: NOTE_ID, authorSiteId: 'tenant-b', body: 'Text', created: '2026-06-30 12:00:00.000' });
  });

  it('maps a comment to its row in table column names and back, a read Date as local timestamp text', () => {
    const comment = { commentId: COMMENT_ID, noteId: NOTE_ID, authorSiteId: 'default', body: 'Text', created: CREATED };
    const row = commentToRow(comment);

    expect(Object.keys(row)).toEqual(NOTE_COMMENT_TABLE.columns.map((column) => column.name).filter((name) => name !== 'tenant_id'));
    expect(commentFromRow({ ...row, tenant_id: 'ignored', created: CREATED_DATE })).toEqual(comment);
    expect(noteCommentedPayload(comment)).toEqual({ noteId: NOTE_ID, commentId: COMMENT_ID, body: 'Text', created: CREATED });
  });
});

describe('comment page cursors', () => {
  it('round-trips a cursor and positions it after a stored row', () => {
    expect(parseCommentCursor(formatCommentCursor(CURSOR))).toEqual(CURSOR);
    expect(commentCursorOf({ comment_id: COMMENT_ID, note_id: NOTE_ID, author_site_id: 'default', body: 'b', created: CREATED_DATE })).toEqual(CURSOR);
  });

  it.each([
    { label: 'text that is not JSON', text: 'not-a-cursor' },
    { label: 'a note cursor', text: encoded({ created: CREATED, noteId: NOTE_ID }) },
    { label: 'an ISO created', text: encoded({ created: '2024-01-02T03:04:05.678Z', commentId: COMMENT_ID }) },
    { label: 'an RFC 4122 comment id', text: encoded({ created: CREATED, commentId: '0f9c3a52-8d4e-4b6a-9e21-5c7d3b1a8f60' }) },
  ])('reads $label as no cursor', ({ text }) => {
    expect(parseCommentCursor(text)).toBeNull();
    expect(commentListQuerySchema.safeParse({ after: text }).success).toBe(false);
  });

  it('defaults the page and decodes after, matching parameter names ignoring case', () => {
    expect(commentListQuerySchema.parse({})).toEqual({ limit: NOTE_PAGE_DEFAULT, after: null });
    expect(commentListQuerySchema.parse({ LIMIT: '7', After: formatCommentCursor(CURSOR) })).toEqual({ limit: 7, after: CURSOR });
  });
});
