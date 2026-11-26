/** Stub note grant and comment routes through `app.inject` on the composed app over the recording database. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { LEGACY_ERROR_MAP, cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER, parseWritePosition } from '@opt2/platform/migration-kit';
import { NOTE_COMMENT_GRANT } from '../../src/domain/comment.js';
import { NOTE_COMMENTED_TOPIC } from '../../src/events/topics.js';
import { FIXED_XID, buildTestApp, createRecordingDb, headersFor, type TestApp } from '../helpers/app.js';

type Payload = Record<string, unknown>;

/** A comment as the legacy serializer emits it. */
interface CommentJson {
  commentid: string;
  noteid: string;
  authorsiteid: string;
  body: string;
  created: string;
}

interface CommentList {
  items: CommentJson[];
  next: string | null;
}

const NOTES_URL = '/opt2/stub/notes';
const POSITION = WRITE_POSITION_HEADER.toLowerCase();
const BUSINESS_TIME = '2026-06-30 12:00:00.000';
const SEEDED = { note_id: cfUuid(), title: 'Seeded', body: 'Seeded body', created: BUSINESS_TIME, row_version: 1 };
const GRANTS_URL = `${NOTES_URL}/${SEEDED.note_id}/grants`;
const COMMENTS_URL = `${NOTES_URL}/${SEEDED.note_id}/comments`;

let ctx: TestApp;

function legacyError(type: keyof typeof LEGACY_ERROR_MAP): { message: string; code: string } {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return { message, code };
}

/** Posts `payload` to `url` as the `ROLE_SET` subject `subject` of `site`, tenant-a by default. */
async function post(url: string, subject: string, payload: Payload, site: string = TENANT_A.siteId) {
  return ctx.app.inject({ method: 'POST', url, headers: await headersFor(subject, { site }), payload });
}

async function list(url: string, subject = 'member', site: string = TENANT_A.siteId) {
  return ctx.app.inject({ method: 'GET', url, headers: await headersFor(subject, { site }) });
}

/** Grants tenant-b `note-comment` on the seeded note as a tenant-a system user. */
async function grantTenantB(): Promise<void> {
  expect((await post(GRANTS_URL, 'system-user', { granteesiteid: TENANT_B.siteId })).statusCode).toBe(200);
}

function commentWrites(): string[] {
  return ctx.db.writes.filter((write) => write.table === 'note_comment' || write.table === 'outbox').map((write) => write.table);
}

beforeEach(async () => {
  ctx = await buildTestApp({ db: createRecordingDb({ notes: [{ tenantId: TENANT_A.tenantId, row: SEEDED }] }) });
});

afterEach(async () => ctx.app.close());

describe('createNoteGrant', () => {
  it('answers the saved grant and stores it from the token tenant to the named site', async () => {
    const res = await post(GRANTS_URL, 'system-user', { granteesiteid: TENANT_B.siteId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', data: { noteid: SEEDED.note_id, granteesiteid: TENANT_B.siteId } });
    expect(ctx.db.rows('tenant_grant')).toEqual([
      expect.objectContaining({
        grantor_tenant: TENANT_A.tenantId,
        grantee_tenant: TENANT_B.tenantId,
        kind: NOTE_COMMENT_GRANT,
        resource_id: SEEDED.note_id,
      }),
    ]);
  });

  it('answers the legacy 404 for another tenant note without granting', async () => {
    const res = await post(GRANTS_URL, 'system-user', { granteesiteid: TENANT_UMBRELLA.siteId }, TENANT_B.siteId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: legacyError('invalidMethodCall') });
    expect(ctx.db.rows('tenant_grant')).toEqual([]);
  });

  it.each([
    ['a missing grantee site', {}],
    ['an unregistered grantee site', { granteesiteid: 'no-such-site' }],
  ])('answers invalidParameters for %s without granting', async (_label, payload) => {
    const res = await post(GRANTS_URL, 'system-user', payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: legacyError('invalidParameters') });
    expect(ctx.db.rows('tenant_grant')).toEqual([]);
  });
});

describe('createNoteComment', () => {
  it('stores an own-site comment, advances the note version and publishes the comment event at it', async () => {
    const res = await post(COMMENTS_URL, 'member', { grantorsiteid: TENANT_A.siteId, body: 'Own comment' });

    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: CommentJson }>();
    expect(data).toEqual({ commentid: data.commentid, noteid: SEEDED.note_id, authorsiteid: TENANT_A.siteId, body: 'Own comment', created: BUSINESS_TIME });
    expect(isCfUuid(data.commentid)).toBe(true);
    expect(parseWritePosition(res.headers[POSITION] as string).get('stub')).toBe(FIXED_XID);
    expect(ctx.db.rows('note', TENANT_A.tenantId)).toEqual([expect.objectContaining({ note_id: SEEDED.note_id, row_version: 2 })]);
    expect(ctx.db.rows('note_comment', TENANT_A.tenantId)).toEqual([
      expect.objectContaining({ comment_id: data.commentid, note_id: SEEDED.note_id, author_site_id: TENANT_A.siteId, body: 'Own comment' }),
    ]);
    const [published] = ctx.publisher.published;
    expect(ctx.publisher.published).toHaveLength(1);
    expect(published?.topic).toBe(NOTE_COMMENTED_TOPIC);
    expect(published?.envelope).toMatchObject({ tenantId: TENANT_A.tenantId, aggregateType: 'note', aggregateId: SEEDED.note_id, aggregateVersion: 2 });
    expect(published?.envelope.payload).toEqual({ noteId: SEEDED.note_id, commentId: data.commentid, body: 'Own comment', created: BUSINESS_TIME });
  });

  it('writes the note version, comment, changelog and outbox rows in one committed transaction', async () => {
    await post(COMMENTS_URL, 'member', { grantorsiteid: TENANT_A.siteId, body: 'Atomic comment' });

    const transaction = ctx.db.writes.find((write) => write.table === 'note_comment')?.tx;
    const writes = ctx.db.writes.filter((write) => write.tx === transaction);
    expect(writes.map((write) => `${write.op} ${write.table}`).sort()).toEqual(
      ['insert changelog', 'insert changelog', 'insert note_comment', 'insert outbox', 'update note'],
    );
    expect(writes.map((write) => [write.tenantId, write.outcome])).toEqual(writes.map(() => [TENANT_A.tenantId, 'committed']));
  });

  it('stores a granted site comment in the grantor tenant under the commenter site', async () => {
    await grantTenantB();

    const res = await post(COMMENTS_URL, 'system-user', { grantorsiteid: TENANT_A.siteId, body: 'Granted comment' }, TENANT_B.siteId);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: CommentJson }>().data).toMatchObject({ noteid: SEEDED.note_id, authorsiteid: TENANT_B.siteId });
    expect(ctx.db.rows('note_comment', TENANT_A.tenantId)).toEqual([expect.objectContaining({ author_site_id: TENANT_B.siteId })]);
    expect(ctx.db.rows('note_comment', TENANT_B.tenantId)).toEqual([]);
    expect(ctx.publisher.published.map(({ envelope }) => envelope.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it.each([
    ['an ungranted site', TENANT_UMBRELLA.siteId, TENANT_A.siteId, SEEDED.note_id],
    ['an unregistered grantor site', TENANT_A.siteId, 'no-such-site', SEEDED.note_id],
    ['a missing note', TENANT_A.siteId, TENANT_A.siteId, cfUuid()],
  ])('answers the legacy 404 and writes nothing for %s', async (_label, site, grantorsiteid, noteId) => {
    await grantTenantB();
    ctx.db.clear();

    const res = await post(`${NOTES_URL}/${noteId}/comments`, 'member', { grantorsiteid, body: 'Refused comment' }, site);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: legacyError('invalidMethodCall') });
    expect(commentWrites()).toEqual([]);
    expect(ctx.db.rows('note_comment')).toEqual([]);
    expect(ctx.publisher.published).toEqual([]);
  });

  it.each([
    ['a missing grantor site', { body: 'No grantor' }],
    ['an empty body', { grantorsiteid: TENANT_A.siteId, body: '' }],
    ['an oversized body', { grantorsiteid: TENANT_A.siteId, body: 'x'.repeat(10001) }],
  ])('answers invalidParameters for %s without writing', async (_label, payload) => {
    const res = await post(COMMENTS_URL, 'member', payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: legacyError('invalidParameters') });
    expect(commentWrites()).toEqual([]);
  });

  it('answers 403 when the body names another site as siteid', async () => {
    const res = await post(COMMENTS_URL, 'member', { grantorsiteid: TENANT_A.siteId, body: 'Mismatch', siteid: TENANT_B.siteId });

    expect(res.statusCode).toBe(403);
    expect(commentWrites()).toEqual([]);
  });
});

describe('listNoteComments', () => {
  it('pages the note comments by limit and the next cursor, ordered by created then comment id', async () => {
    await grantTenantB();
    const own = (await post(COMMENTS_URL, 'member', { grantorsiteid: TENANT_A.siteId, body: 'First' })).json<{ data: CommentJson }>().data;
    const granted = (
      await post(COMMENTS_URL, 'system-user', { grantorsiteid: TENANT_A.siteId, body: 'Second' }, TENANT_B.siteId)
    ).json<{ data: CommentJson }>().data;
    const ordered = [own, granted].sort((a, b) => (a.commentid < b.commentid ? -1 : 1));

    const first = await list(`${COMMENTS_URL}?limit=1`);
    const page = first.json<{ method: string; data: CommentList }>();
    const second = (await list(`${COMMENTS_URL}?limit=1&after=${page.data.next ?? ''}`)).json<{ data: CommentList }>().data;

    expect(first.statusCode).toBe(200);
    expect(page.method).toBe('findMany');
    expect(page.data.items).toEqual(ordered.slice(0, 1));
    expect(page.data.next).toEqual(expect.any(String));
    expect(second).toEqual({ items: ordered.slice(1), next: null });
  });

  it('answers the legacy 404 for another tenant note', async () => {
    const res = await list(COMMENTS_URL, 'member', TENANT_B.siteId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findMany', error: legacyError('invalidMethodCall') });
  });

  it.each(['limit=0', 'after=not-a-cursor'])('answers invalidParameters for %s', async (query) => {
    const res = await list(`${COMMENTS_URL}?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findMany', error: legacyError('invalidParameters') });
  });
});
