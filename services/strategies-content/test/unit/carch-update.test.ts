/** carch.update, saveQuickEdit and updateObjectParams over a throwaway `content` schema: branches, outcomes and session effects. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import {
  carchUpdate,
  saveContent,
  saveDraft,
  saveQuickEdit,
  updateObjectParams,
  type CarchUpdateInput,
  type CarchUpdateResult,
  type ContentInput,
} from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, SITE_TREE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

describe.skipIf(!(await pgAvailable()))('carch.update', () => {
  let fx: ContentFixture;
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const activeHistId = async (contentId: string): Promise<string> => String((await content('contentid = $1 AND active = 1', [contentId]))[0]?.contenthistid);
  const carch = (rc: ContentInput, extra: Partial<CarchUpdateInput> = {}, actor: Actor = ADMIN): Promise<CarchUpdateResult> =>
    carchUpdate(fx.deps, actor, SITE, { rc: { siteid: SITE_ID, ...rc }, validateCsrf: () => true, session: { openSectionList: '', multiFileUpload: false }, accessControlOriginDomains: 'localhost', ...extra });

  let pageId = '';
  beforeAll(async () => {
    fx = await createContentFixture('carch-update-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
    pageId = (await save({ parentid: HOME, type: 'Page', title: 'Page', approved: 1 })).bean.contentId();
  });

  afterAll(async () => {
    await fx?.drop();
  });

  /** The edit form's post for the active version of `contentId`. */
  const edit = async (contentId: string, rc: ContentInput = {}): Promise<ContentInput> => ({
    contentid: contentId,
    contenthistid: await activeHistId(contentId),
    parentid: HOME,
    type: 'Page',
    action: 'add',
    topid: HOME,
    ...rc,
  });

  it('saves an add, opens the parent section and redirects to cArch.list', async () => {
    const result = await carch({ parentid: HOME, type: 'Page', title: 'Added', action: 'add', approved: 1, topid: HOME, orderno: 'x' });
    expect(result.outcome).toEqual({
      kind: 'redirect',
      action: 'cArch.list',
      append: ['topid', 'siteid', 'startrow', 'moduleid'],
      params: { topid: HOME, siteid: SITE_ID, startrow: '1', moduleid: SITE_TREE },
      path: './',
    });
    expect(result.sessionEffects).toEqual([
      { kind: 'openSectionList', value: HOME },
      { kind: 'editBean', bean: null },
    ]);
    expect(await content('title = $1', ['Added'])).toEqual([expect.objectContaining({ active: 1, approved: 1, orderno: 1 })]);
  });

  it('keeps the section closed when it is already open under the module top', async () => {
    const result = await carch(
      await edit(pageId, { title: 'Page', approved: 1 }),
      { session: { openSectionList: HOME, multiFileUpload: false, topIdsByModule: { [SITE_TREE]: HOME } } },
    );
    expect(result.sessionEffects).toEqual([{ kind: 'editBean', bean: null }]);
  });

  it('re-renders the form with the token error for an invalid add token', async () => {
    const result = await carch(await edit(pageId, { title: '' }), { validateCsrf: (context) => !context.endsWith('add') });
    expect(result.outcome.kind).toBe('rerender');
    if (result.outcome.kind !== 'rerender') return;
    expect(result.outcome.bean.errors).toEqual({ csrf: 'Your request contained invalid tokens' });
    expect(result.outcome.compactDisplay).toBe(false);
    expect(result.sessionEffects.at(-1)).toEqual({ kind: 'editBean', bean: result.outcome.bean });
  });

  it.each([
    ['a preview', { preview: 1 }, 'cArch.edit'],
    ['a return to the history', { return: 'hist' }, 'cArch.hist'],
  ])('redirects %s', async (_label, rc, action) => {
    const result = await carch(await edit(pageId, { title: 'Page', approved: 0, ...rc }));
    expect(result.outcome).toMatchObject({ kind: 'redirect', action });
    if (result.outcome.kind !== 'redirect') return;
    expect(result.outcome.params.contentid).toBe(pageId);
  });

  it('redirects a change-set save back to its assignments', async () => {
    const result = await carch(await edit(pageId, { title: 'Page', approved: 0, return: 'changesets', changesetid: 'other', changesetname: 'Carch Set' }));
    expect(result.outcome).toMatchObject({ kind: 'redirect', action: 'cChangesets.assignments', append: ['changesetID', 'siteid'], params: { changesetID: 'other', siteid: SITE_ID }, path: './' });
  });

  it('sends a front-end save to the item URL and honours a sanitised return URL', async () => {
    const front = await carch(await edit(pageId, { title: 'Page', approved: 1, frontend: true }));
    expect(front.outcome).toEqual({ kind: 'location', url: 'http://localhost/page/' });
    const back = await carch(await edit(pageId, { title: 'Page', approved: 1, returnURL: 'https://evil.example/a//b' }));
    expect(back.outcome).toEqual({ kind: 'location', url: 'https://localhost/a' });
  });

  it('answers the compact-display close and the qqfile literal', async () => {
    const closed = await carch(await edit(pageId, { title: 'Page', approved: 1, closeCompactDisplay: 'true' }));
    expect(closed.outcome.kind).toBe('closeCompactDisplay');
    expect(closed.sessionEffects.at(-1)).toEqual({ kind: 'editBean', bean: null });
    const qq = await carch(await edit(pageId, { title: 'Page', approved: 1, closeCompactDisplay: 'true' }), { qqfile: true });
    expect(qq.outcome).toEqual({ kind: 'text', body: '{success:true}' });
  });

  it('answers ajax saves with the live or preview location, and the errors otherwise', async () => {
    const live = await carch(await edit(pageId, { title: 'Page', approved: 1, ajaxrequest: true }));
    expect(live.outcome).toMatchObject({ kind: 'ajax', location: '/page/' });
    const draft = await carch(await edit(pageId, { title: 'Page', approved: 0, ajaxrequest: true }));
    expect(draft.outcome).toMatchObject({ kind: 'ajax' });
    if (draft.outcome.kind === 'ajax') expect(draft.outcome.location).toMatch(/\?previewid=/);
    const failed = await carch(await edit(pageId, { title: 'Page', template: 'a/b.cfm', ajaxrequest: true }));
    expect(failed.outcome).toMatchObject({ kind: 'ajax', location: null });
  });

  it('runs a delete branch, then fails on rc.contentBean as legacy does unless keep-editing redirects it', async () => {
    const victim = await save({ parentid: HOME, type: 'Page', title: 'Victim', approved: 1 });
    await expect(carch({ contentid: victim.bean.contentId(), action: 'deleteall' })).rejects.toThrow('Element RC.contentBean is undefined in ARGUMENTS.');
    expect(await content('contentid = $1', [victim.bean.contentId()])).toHaveLength(0);

    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: pageId, contenthistid: await activeHistId(pageId), parentid: HOME, type: 'Page', title: 'Gone' });
    const removed = await carch({ contentid: pageId, contenthistid: draft.bean.contentHistId(), action: 'delete', murakeepediting: true });
    expect(removed.outcome).toMatchObject({ kind: 'redirect', action: 'cArch.hist', params: { contentid: pageId } });
    expect(await content('contenthistid = $1', [draft.bean.contentHistId()])).toHaveLength(0);
    const cleared = await carch({ contentid: pageId, action: 'deletehistall', murakeepediting: true, returnURL: '//evil.example/x' });
    expect(cleared.outcome).toEqual({ kind: 'location', url: '/evil.example/x' });
    expect(await carch({ contentid: HOME, action: 'deleteall' })).toEqual({ outcome: { kind: 'abort' }, sessionEffects: [] });
  });

  it('writes nothing for an actor without node permission, and reads a request perm where none is computed', async () => {
    await expect(carch(await edit(pageId, { title: 'Denied' }), {}, NOBODY)).rejects.toThrow('Element RC.contentBean is undefined in ARGUMENTS.');
    expect(await content('title = $1', ['Denied'])).toHaveLength(0);
    await expect(carch({ contentid: cfId('C', 99), action: 'add' }, {}, NOBODY)).rejects.toThrow('Element RC.perm is undefined in ARGUMENTS.');
  });

  it('decodes URL-encoded object params before saving them', async () => {
    const result = await carch(await edit(pageId, { title: 'Page', approved: 1, objectparams: encodeURIComponent('{"x":1}') }));
    expect(result.outcome.kind).toBe('redirect');
    expect((await content('contentid = $1 AND active = 1', [pageId]))[0]?.objectparams).toBe('{"x":1}');
  });

  describe('multi-file upload', () => {
    const upload = { parentid: HOME, action: 'multifileupload', subtype: 'Default', approved: 1 };
    const files = [{ fieldName: 'files', fileName: 'notes.txt', contentType: 'text/plain', bytes: Buffer.from('n') }];

    it('aborts without a part and records the sticky session flag', async () => {
      expect(await carch(upload)).toEqual({ outcome: { kind: 'abort' }, sessionEffects: [{ kind: 'multiFileUpload', value: true }] });
    });

    it('falls through to rc.contentBean without a valid token or session flag', async () => {
      await expect(carch(upload, { validateCsrf: () => false })).rejects.toThrow('Element RC.contentBean is undefined in ARGUMENTS.');
      const viaSession = await carch(upload, { validateCsrf: () => false, session: { openSectionList: '', multiFileUpload: true } });
      expect(viaSession.outcome).toEqual({ kind: 'abort' });
    });

    it('answers the item, legacy partial output for failures it catches, and fails closed on the start-up guard', async () => {
      const item = await carch(upload, { files, extraParams: JSON.stringify({ body: 'notes.txt' }) });
      expect(item.outcome).toMatchObject({ kind: 'multiFileUpload', item: { filename: 'notes.txt', body: 'notes.txt' } });
      expect(await carch(upload, { files, extraParams: '{oops' })).toMatchObject({ outcome: { kind: 'multiFileUpload', item: null } });
      await expect(carch(upload, { files })).rejects.toThrow(/start-up URL conversion predicate/);
      await expect(carch({ parentid: HOME, action: 'multifileupload', approved: 1 }, { files })).rejects.toThrow('Element DATA.subType is undefined in ARGUMENTS.');
    });
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

  describe('updateObjectParams', () => {
    it('keeps a non-JSON change unsaved, saves a JSON one and aborts for an unknown version or a reader', async () => {
      const histId = (await save({ parentid: HOME, type: 'Page', title: 'Objects', approved: 1, objectlist2: 'text~Text~obj1~{}' })).bean.contentHistId();
      const unsaved = await updateObjectParams(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contenthistid: histId, approved: 1, params: 'nope' });
      expect(unsaved?.contentHistId()).toBe(histId);
      const saved = await updateObjectParams(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contenthistid: histId, approved: 0, params: '{"a":1}', regionid: 2, object: 'text', objectid: 'obj1', name: 'Renamed', orderno: 1 });
      expect(saved?.contentHistId()).not.toBe(histId);
      expect(await fx.rows('content_object', 'contenthistid = $1', [saved?.contentHistId()])).toEqual([
        expect.objectContaining({ object: 'text', name: 'Renamed', objectid: 'obj1', params: '{"a":1}', columnid: 2 }),
      ]);
      expect(await updateObjectParams(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contenthistid: cfId('C', 98), params: '{}' })).toBeNull();
      expect(await updateObjectParams(fx.deps, NOBODY, SITE, { siteid: SITE_ID, contenthistid: histId, params: '{}' })).toBeNull();
      await expect(updateObjectParams(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contenthistid: histId, approved: 0, params: '{}' })).rejects.toThrow('Element REGIONID is undefined in ARGUMENTS.');
    });
  });
});
