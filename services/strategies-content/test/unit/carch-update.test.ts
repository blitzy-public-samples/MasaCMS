/** carch.saveQuickEdit over a throwaway `content` schema. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { saveContent, saveDraft, saveQuickEdit, type ContentInput } from '../../src/domain/content.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

describe.skipIf(!(await pgAvailable()))('carch.saveQuickEdit', () => {
  let fx: ContentFixture;
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const activeHistId = async (contentId: string): Promise<string> => String((await content('contentid = $1 AND active = 1', [contentId]))[0]?.contenthistid);

  let pageId = '';
  beforeAll(async () => {
    fx = await createContentFixture('carch-update-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
    pageId = (await save({ parentid: HOME, type: 'Page', title: 'Page', approved: 1 })).bean.contentId();
  });

  afterAll(async () => {
    await fx?.drop();
  });

  describe('saveQuickEdit', () => {
    it('saves an editor change approved only without drafts, and nothing for a bad token or attribute', async () => {
      const item = (await save({ parentid: HOME, type: 'Page', title: 'Quick', approved: 1, isnav: 1 })).bean.contentId();
      const quick = (rc: ContentInput, csrfValid = true) => saveQuickEdit(fx.deps, ADMIN, SITE, { rc: { siteid: SITE_ID, contentid: item, ...rc }, csrfValid });
      expect(await quick({ attribute: 'isnav', isnav: 0 }, false)).toBeNull();
      expect(await quick({ attribute: 'bogus' })).toBeNull();
      await expect(quick({ attribute: 'isnav' })).rejects.toThrow('Element RC.isnav is undefined in ARGUMENTS.');
      expect((await quick({ attribute: 'isnav', isnav: 0 }))?.errors).toEqual({});
      expect((await content('contentid = $1 AND active = 1', [item]))[0]).toMatchObject({ isnav: 0, approved: 1 });
      await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: item, contenthistid: await activeHistId(item), parentid: HOME, type: 'Page', title: 'Quick Draft' });
      expect(await quick({ attribute: 'isnav', isnav: 1 })).toBeNull();
      expect(await saveQuickEdit(fx.deps, NOBODY, SITE, { rc: { siteid: SITE_ID, contentid: pageId, attribute: 'isnav', isnav: 0 }, csrfValid: true })).toBeNull();
    });
  });
});
