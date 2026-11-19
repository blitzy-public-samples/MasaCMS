/** GS-CO-20's comment writes over a throwaway `content` schema: moderation of a seeded comment and commenter-keyed JSON API saves. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, pgAvailable } from '@opt2/platform/testing';
import {
  approveComment,
  bulkEdit,
  findCommentValues,
  purgeDeletedComments,
  purgeDeletedCommentsAction,
  saveComment,
  singleEdit,
  unapproveComment,
  type CommentSite,
} from '../../src/domain/comments.js';
import type { Actor } from '../../src/domain/context.js';
import { ADMIN, SITE, SITE_ID, SITE_TREE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const PAGE = cfId('P', 1);
const MEMBER_USER = cfId('U', 7);
const MEMBER_COMMENTER = cfId('M', 1);
const VISITOR_COMMENTER = cfId('M', 2);
const VISITOR_EMAIL = 'maida.greenfelder@seed.opt2.test';
const ROOT = cfId('K', 1);
const REPLY = cfId('K', 2);
const PENDING = cfId('K', 3);
const SEEDED_AT = new Date(2026, 5, 29, 19, 50, 0, 0);
const VIEW = { scheme: 'http' };

const COMMENT_SITE: CommentSite = {
  siteId: SITE_ID,
  site: SITE.site,
  contactEmail: '',
  urls: SITE.urls,
  commentApprovalDefault: 1,
  contentUrl: () => 'http://localhost/page/',
};

const VISITOR: Actor = { userId: '', fullName: '', isLoggedIn: false, s2: false, roles: [], siteId: SITE_ID, tenantId: TENANT_A.tenantId };
const MEMBER: Actor = { ...VISITOR, userId: MEMBER_USER, fullName: 'Liliana Hermiston', isLoggedIn: true };

describe.skipIf(!(await pgAvailable()))('comment writes over a throwaway content schema', () => {
  let fx: ContentFixture;
  const comment = async (commentId: string) => (await fx.rows('comment', 'commentid = $1', [commentId]))[0];
  const commenter = async (commenterId: string) => (await fx.rows('commenter', 'commenterid = $1', [commenterId]))[0];

  beforeAll(async () => {
    fx = await createContentFixture('comments-writes-test');
    await fx.inTenant(async (tx) => {
      await fx.repo.content.insertVersion(tx, {
        contentid: PAGE, contenthistid: cfId('H', 1), siteid: SITE_ID, type: 'Page', subtype: 'Default', moduleid: SITE_TREE,
        active: 1, approved: 1, display: 1, title: 'OPT-2 Seed Contact Page',
      });
      // The seed's commenters: a public-pool member keyed by user id, a visitor keyed by e-mail.
      await fx.repo.comments.upsertCommenter(tx, { commenterid: MEMBER_COMMENTER, remoteid: MEMBER_USER, name: 'Liliana Hermiston', email: 'liliana.hermiston@seed.opt2.test' });
      await fx.repo.comments.upsertCommenter(tx, { commenterid: VISITOR_COMMENTER, remoteid: VISITOR_EMAIL, name: 'Maida Greenfelder', email: VISITOR_EMAIL });
      const seeded = { contentid: PAGE, siteid: SITE_ID, isspam: 0, isdeleted: 0, flagcount: 0, subscribe: 0, ip: '127.0.0.1' };
      await fx.repo.comments.insertComment(tx, { ...seeded, commentid: ROOT, path: ROOT, userid: MEMBER_COMMENTER, name: 'Liliana Hermiston', email: 'liliana.hermiston@seed.opt2.test', comments: 'Root', entered: new Date(2026, 2, 27, 18, 39, 0, 0), isapproved: 1 });
      await fx.repo.comments.insertComment(tx, { ...seeded, commentid: REPLY, parentid: ROOT, path: `${ROOT},${REPLY}`, userid: VISITOR_COMMENTER, name: 'Maida Greenfelder', email: VISITOR_EMAIL, comments: 'Reply', entered: new Date(2026, 5, 26, 3, 28, 0, 0), isapproved: 1 });
      await fx.repo.comments.insertComment(tx, { ...seeded, commentid: PENDING, path: PENDING, userid: MEMBER_COMMENTER, name: 'Liliana Hermiston', email: 'liliana.hermiston@seed.opt2.test', comments: 'Pending', entered: SEEDED_AT, isapproved: 0 });
    });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it.each<[string, (id: string) => Promise<unknown>, (id: string) => Promise<unknown>]>([
    ['cComments.approve, then singleEdit unapprove', (id) => approveComment(fx.deps, ADMIN, id, COMMENT_SITE), (id) => singleEdit(fx.deps, ADMIN, { commentid: id, updateAction: 'unapprove' }, COMMENT_SITE)],
    ['singleEdit approve, then cComments.unapprove', (id) => singleEdit(fx.deps, ADMIN, { commentid: id, updateAction: 'approve' }, COMMENT_SITE), (id) => unapproveComment(fx.deps, ADMIN, id, COMMENT_SITE)],
  ])('approves the seeded unapproved comment and back through %s, leaving its other columns as seeded', async (_label, approve, unapprove) => {
    const seeded = await comment(PENDING);
    await approve(PENDING);
    expect(await comment(PENDING)).toEqual({ ...seeded, isapproved: 1 });
    expect(await findCommentValues(fx.deps, TENANT_A.tenantId, PENDING, VIEW)).toMatchObject({ commentID: PENDING, isApproved: 1, userID: MEMBER_COMMENTER, entered: SEEDED_AT });
    await unapprove(PENDING);
    expect(await comment(PENDING)).toEqual(seeded);
    expect(await commenter(MEMBER_COMMENTER)).toMatchObject({ remoteid: MEMBER_USER, name: 'Liliana Hermiston' });
  });

  it.each<[string, Actor, string, string | undefined]>([
    ['a new visitor e-mail', VISITOR, 'gs-co-20.visitor@seed.opt2.test', undefined],
    ['the e-mail of a seeded visitor commenter', VISITOR, VISITOR_EMAIL, VISITOR_COMMENTER],
    ['the user id of a seeded member commenter', MEMBER, 'liliana.hermiston@seed.opt2.test', MEMBER_COMMENTER],
  ])('keys the commenter of a new comment by %s, renames it with the comment, and keeps it once the comment is purged', async (_label, actor, email, reused) => {
    const created = await saveComment(fx.deps, actor, {
      commentId: '',
      values: { contentid: PAGE, siteid: SITE_ID, name: 'GS-CO-20 Commenter', email, comments: 'GS-CO-20 comment' },
      site: COMMENT_SITE,
      remoteAddr: '127.0.0.1',
    });
    const commentId = created.value.commentID;
    const commenterId = created.value.userID;
    expect([created.errors, created.value.isApproved]).toEqual([{}, 1]);
    if (reused !== undefined) expect(commenterId).toBe(reused);
    const remoteid = actor.isLoggedIn ? actor.userId : email;
    expect(await fx.rows('commenter', 'remoteid = $1', [remoteid])).toEqual([expect.objectContaining({ commenterid: commenterId, name: 'GS-CO-20 Commenter', email })]);

    await saveComment(fx.deps, ADMIN, { commentId, values: { commentid: commentId, siteid: SITE_ID, name: 'GS-CO-20 Commenter Renamed' }, site: COMMENT_SITE, remoteAddr: '127.0.0.1' });
    expect(await findCommentValues(fx.deps, TENANT_A.tenantId, commentId, VIEW)).toMatchObject({ name: 'GS-CO-20 Commenter Renamed', userID: commenterId, comments: 'GS-CO-20 comment' });
    expect(await commenter(commenterId)).toMatchObject({ remoteid, name: 'GS-CO-20 Commenter Renamed', email });

    expect((await bulkEdit(fx.deps, ADMIN, { siteid: SITE_ID, ckupdate: commentId, bulkedit: 'delete' }, COMMENT_SITE)).processed).toBe(true);
    expect(await comment(commentId)).toMatchObject({ isdeleted: 1 });
    expect(await purgeDeletedComments(fx.deps, ADMIN, SITE_ID)).toBe(true);
    expect([await comment(commentId), (await fx.rows('comment', 'contentid = $1', [PAGE])).map((row) => row.commentid).sort()]).toEqual([undefined, [ROOT, REPLY, PENDING].sort()]);
    expect(await commenter(commenterId)).toMatchObject({ name: 'GS-CO-20 Commenter Renamed' });
  });

  it.each<[string, string, string]>([
    ['TENANT-A', cfId('K', 11), cfId('K', 12)],
    ['Tenant-A', cfId('K', 13), cfId('K', 14)],
  ])('cComments.purgeDeletedComments with siteid=%s purges the deleted comments stored under tenant-a only, as SQL Server compares siteid', async (siteid, ownId, otherId) => {
    const deleted = { contentid: cfId('P', 2), isapproved: 1, isspam: 0, isdeleted: 1, name: 'Purge Case', email: VISITOR_EMAIL, comments: 'Deleted', entered: SEEDED_AT };
    await fx.inTenant(async (tx) => {
      await fx.repo.comments.insertComment(tx, { ...deleted, commentid: ownId, path: ownId, siteid: SITE_ID });
      await fx.repo.comments.insertComment(tx, { ...deleted, commentid: otherId, path: otherId, siteid: TENANT_B.siteId });
    });
    expect((await purgeDeletedCommentsAction(fx.deps, ADMIN, { siteid })).processed).toBe(true);
    expect([await comment(ownId), await comment(otherId)]).toEqual([undefined, expect.objectContaining({ siteid: TENANT_B.siteId, isdeleted: 1 })]);
  });
});
