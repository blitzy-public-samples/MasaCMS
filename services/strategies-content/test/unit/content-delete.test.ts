/** contentManager.delete, deleteHistAll and deleteAll, and the JSON API content delete, over a throwaway `content` schema. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { deleteAll, deleteContentEntity, deleteHistAll, deleteVersion, publish, saveContent, saveDraft, type ContentInput } from '../../src/domain/content.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

describe.skipIf(!(await pgAvailable()))('domain/content deletes', () => {
  let fx: ContentFixture;
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const versionsOf = async (contentId: string) => (await content('contentid = $1', [contentId])).map((r) => [r.title, r.active, r.approved]);

  beforeAll(async () => {
    fx = await createContentFixture('content-delete-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('deletes one version with its tags and objects', async () => {
    const item = await save({ parentid: HOME, type: 'Page', title: 'Versioned', approved: 1 });
    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: item.bean.contentId(), parentid: HOME, type: 'Page', title: 'Draft', tags: 'x', objectlist1: 'text~Text~obj1' });
    const histId = draft.bean.contentHistId();
    expect(await fx.rows('content_tag', 'contenthistid = $1', [histId])).toHaveLength(1);
    await deleteVersion(fx.deps, ADMIN, SITE, { contentHistId: histId, siteId: SITE_ID });
    expect(await versionsOf(item.bean.contentId())).toEqual([['Versioned', 1, 1]]);
    expect(await fx.rows('content_tag', 'contenthistid = $1', [histId])).toHaveLength(0);
    expect(await fx.rows('content_object', 'contenthistid = $1', [histId])).toHaveLength(0);
  });

  it('clears the history but keeps the active version and drafts in change sets', async () => {
    const item = await save({ parentid: HOME, type: 'Page', title: 'History', approved: 1 });
    const contentId = item.bean.contentId();
    await publish(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: contentId, parentid: HOME, type: 'Page', title: 'History 2' });
    await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: contentId, parentid: HOME, type: 'Page', title: 'Plain Draft' });
    await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: contentId, parentid: HOME, type: 'Page', title: 'Set Draft', changesetid: 'other', changesetname: 'Later' });
    await deleteHistAll(fx.deps, ADMIN, SITE, { contentId, siteId: SITE_ID });
    expect(await versionsOf(contentId)).toEqual([
      ['History 2', 1, 1],
      ['Set Draft', 0, 0],
    ]);
  });

  it('aborts on the home page and trashes a branch child first, one row per item under one delete id', async () => {
    expect(await deleteAll(fx.deps, ADMIN, SITE, { contentId: HOME, siteId: SITE_ID })).toEqual({ aborted: true });
    const folder = await save({ parentid: HOME, type: 'Folder', title: 'Branch', approved: 1 });
    const child = await save({ parentid: folder.bean.contentId(), type: 'Page', title: 'Leaf', approved: 1, tags: 't' });
    const result = await deleteAll(fx.deps, ADMIN, SITE, { contentId: folder.bean.contentId(), siteId: SITE_ID, topId: folder.bean.contentId() });
    expect(result).toEqual({ aborted: false, topId: HOME });
    expect(await content('contentid = $1 OR contentid = $2', [folder.bean.contentId(), child.bean.contentId()])).toHaveLength(0);
    const trash = await fx.rows('trash', 'objectid = $1 OR objectid = $2', [folder.bean.contentId(), child.bean.contentId()], 'objectlabel');
    expect(trash.map((r) => [r.objectlabel, r.objectclass, r.objecttype])).toEqual([
      ['Branch', 'content', 'Folder'],
      ['Leaf', 'content', 'Page'],
    ]);
    expect(new Set(trash.map((r) => r.deleteid)).size).toBe(1);
    expect(await deleteAll(fx.deps, ADMIN, SITE, { contentId: child.bean.contentId(), siteId: SITE_ID })).toEqual({ aborted: false, topId: '' });
  });

  it('keeps a locked item while its unlocked children go', async () => {
    const locked = await save({ parentid: HOME, type: 'Folder', title: 'Locked', approved: 1, islocked: 1 });
    const kid = await save({ parentid: locked.bean.contentId(), type: 'Page', title: 'Unlocked Kid', approved: 1 });
    const result = await deleteAll(fx.deps, ADMIN, SITE, { contentId: locked.bean.contentId(), siteId: SITE_ID });
    expect(result).toEqual({ aborted: false, topId: HOME });
    expect(await versionsOf(locked.bean.contentId())).toEqual([['Locked', 1, 1]]);
    expect(await versionsOf(kid.bean.contentId())).toEqual([]);
  });

  describe('JSON API delete', () => {
    it('deletes an inactive version, never the active one, and an invalid token deletes nothing', async () => {
      const item = await save({ parentid: HOME, type: 'Page', title: 'Api Item', approved: 1 });
      const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: item.bean.contentId(), parentid: HOME, type: 'Page', title: 'Api Draft' });
      const byHist = (contentHistId: string, valid: boolean) =>
        deleteContentEntity(fx.deps, ADMIN, SITE, { event: { siteid: SITE_ID, contenthistid: contentHistId }, validateCsrf: () => valid });
      expect(await byHist(draft.bean.contentHistId(), false)).toEqual({ aborted: false });
      expect(await versionsOf(item.bean.contentId())).toHaveLength(2);
      expect(await byHist(item.bean.contentHistId(), true)).toEqual({ aborted: false });
      expect(await byHist(draft.bean.contentHistId(), true)).toEqual({ aborted: false });
      expect(await versionsOf(item.bean.contentId())).toEqual([['Api Item', 1, 1]]);
      expect(await byHist('C9999999-AAAA-BBBB-CCCCDDDDEEEEFFFF', true)).toEqual({ aborted: false });
    });

    it('deletes an item by id, refusing a bad token and an actor without permission', async () => {
      const item = await save({ parentid: HOME, type: 'Page', title: 'Api Delete', approved: 1 });
      const byId = (valid: boolean, actor = ADMIN) => deleteContentEntity(fx.deps, actor, SITE, { event: { siteid: SITE_ID, id: item.bean.contentId() }, validateCsrf: () => valid });
      await expect(byId(true, NOBODY)).rejects.toMatchObject({ type: 'authorization' });
      await expect(byId(false)).rejects.toMatchObject({ type: 'invalidTokens' });
      expect(await byId(true)).toEqual({ aborted: false });
      expect(await versionsOf(item.bean.contentId())).toEqual([]);
      expect(await byId(true)).toEqual({ aborted: false });
    });

    it('reads the component-scope pk for a posted contentid', async () => {
      const item = await save({ parentid: HOME, type: 'Page', title: 'Pk Item', approved: 1 });
      const event = { siteid: SITE_ID, contentid: item.bean.contentId() };
      await expect(deleteContentEntity(fx.deps, ADMIN, SITE, { event, validateCsrf: () => true })).rejects.toThrow('Variable PK is undefined.');
      expect(await deleteContentEntity(fx.deps, ADMIN, SITE, { event, validateCsrf: () => true, componentPk: 'contentid' })).toEqual({ aborted: false });
      expect(await versionsOf(item.bean.contentId())).toEqual([]);
    });
  });
});
