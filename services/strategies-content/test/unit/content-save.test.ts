/** contentManager.add through `domain/content` over a throwaway `content` schema: versions, moves, change sets, approvals, extended data, assignments and the JSON API save. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
import {
  ContentSaveDataError,
  LegacyContentBean,
  REMINDER_UPDATES_UNBUILT,
  approveVersion,
  publish,
  saveContent,
  saveContentEntity,
  saveContentInTx,
  saveDraft,
  type ContentInput,
} from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { ADMIN, END, HOME, NOBODY, NOW, NOW_SECOND, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

describe('LegacyContentBean', () => {
  it('starts from the contentBean init defaults with the session user as last updater', () => {
    const bean = LegacyContentBean.init(ADMIN, NOW);
    expect(bean.isNew).toBe(1);
    expect(bean.text('lastupdateby')).toBe('Admin User');
    expect(bean.text('lastupdatebyid')).toBe(ADMIN.userId);
    expect(bean.text('type')).toBe('Page');
    expect(LegacyContentBean.init({ ...ADMIN, isLoggedIn: false }, NOW).text('lastupdateby')).toBe('');
  });

  it('applies the setters: trimmed non-empty titles, numeric-only numbers and the derived getters', () => {
    const bean = LegacyContentBean.init(ADMIN, NOW);
    bean.setValue('title', '  Kept  ');
    bean.setValue('title', '   ');
    bean.setValue('nextn', 'abc');
    bean.setValue('orderno', 'abc');
    bean.setValue('menutitle', 'Menu');
    bean.setValue('parentid', END);
    bean.setValue('path', `${HOME}`);
    expect(bean.text('title')).toBe('Kept');
    // setNextN keeps numeric values only; orderno has no setter, so the text is stored and fails at the insert.
    expect(bean.number('nextn')).toBe(10);
    expect(bean.text('orderno')).toBe('abc');
    expect(bean.text('htmltitle')).toBe('Menu');
    expect(bean.get('ishome')).toBe(true);
    expect(bean.get('depth')).toBe(0);
    bean.setValue('imagesize', 'Custom');
    expect(bean.text('imagesize')).toBe('small');
    expect(bean.text('imageheight')).toBe('AUTO');
    expect(bean.contentId()).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
  });

  it('lists the reminder writes it does not run', () => {
    expect(REMINDER_UPDATES_UNBUILT).toEqual(['reminderManager.updateReminders', 'reminderManager.deleteReminders']);
  });
});

describe.skipIf(!(await pgAvailable()))('domain/content saves', () => {
  let fx: ContentFixture;
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const save = (input: ContentInput, actor: Actor = ADMIN) => saveContent(fx.deps, actor, SITE, { siteid: SITE_ID, ...input });

  beforeAll(async () => {
    fx = await createContentFixture('content-save-test');
    expect((await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 })).errors).toEqual({});
  });

  afterAll(async () => {
    await fx?.drop();
  });

  let aboutId = '';
  it('creates an active, approved item at the top of its parent with its filename, path and audit columns', async () => {
    const first = await save({ parentid: HOME, type: 'Page', title: 'First', approved: 1 });
    const about = await save({ parentid: HOME, type: 'Page', title: 'About', approved: 1, body: '<p>x</p>' });
    expect(about.errors).toEqual({});
    aboutId = about.bean.contentId();
    const [row] = await content('contentid = $1', [aboutId]);
    expect(row).toMatchObject({
      active: 1,
      approved: 1,
      title: 'About',
      filename: 'about',
      urltitle: 'about',
      orderno: 1,
      parentid: HOME,
      path: `${HOME},${aboutId}`,
      lastupdateby: 'Admin User',
      lastupdatebyid: ADMIN.userId,
      created: NOW_SECOND,
    });
    expect((await content('contentid = $1', [first.bean.contentId()]))[0]).toMatchObject({ orderno: 2 });
  });

  it('places a bottom item after its siblings', async () => {
    const last = await save({ parentid: HOME, type: 'Page', title: 'Last', approved: 1, toporbottom: 'bottom' });
    expect((await content('contentid = $1', [last.bean.contentId()]))[0]).toMatchObject({ orderno: 3 });
  });

  it('saves a draft beside the active version, then publishes it, archiving the old version and purging drafts', async () => {
    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About Draft' });
    expect(draft.errors).toEqual({});
    expect((await content('contentid = $1', [aboutId])).map((r) => [r.title, r.active, r.approved])).toEqual([
      ['About', 1, 1],
      ['About Draft', 0, 0],
    ]);
    const published = await publish(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About Us' });
    expect(published.errors).toEqual({});
    expect((await content('contentid = $1', [aboutId])).map((r) => [r.title, r.active, r.approved])).toEqual([
      ['About', 0, 1],
      ['About Us', 1, 1],
    ]);
    const [map] = await fx.rows('source_map', 'contenthistid = $1', [published.bean.contentHistId()]);
    expect(map).toMatchObject({ contentid: aboutId, siteid: SITE_ID });
  });

  let folderId = '';
  it('moves an item: its filename and path follow the new parent and every version takes the parent id', async () => {
    const folder = await save({ parentid: HOME, type: 'Folder', title: 'Company', approved: 1 });
    folderId = folder.bean.contentId();
    const moved = await publish(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: folderId, type: 'Page', title: 'About Us' });
    expect(moved.errors).toEqual({});
    const rows = await content('contentid = $1', [aboutId]);
    expect(rows.find((r) => r.active === 1)).toMatchObject({ filename: 'company/about', path: `${HOME},${folderId},${aboutId}`, orderno: 1 });
    expect(rows.every((r) => r.parentid === folderId)).toBe(true);
    const archived = await fx.rows('filename_archive', 'contentid = $1', [aboutId], 'filename');
    expect(archived.map((r) => [r.filename, r.siteid])).toEqual([
      ['about', SITE_ID],
      ['company/about', SITE_ID],
    ]);
  });

  it('creates the change set named for `changesetid=other` and files the draft under it', async () => {
    const saved = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: folderId, type: 'Page', title: 'In Summer', changesetid: 'other', changesetname: 'Summer' });
    expect(saved.errors).toEqual({});
    const sets = await fx.rows('changeset', 'name = $1', ['Summer']);
    expect(sets).toHaveLength(1);
    expect((await content('title = $1', ['In Summer']))[0]?.changesetid).toBe(sets[0]?.changesetid);
  });

  it('raises the legacy required-data errors before reading anything', async () => {
    await expect(save({ parentid: HOME, type: 'Page' })).rejects.toThrow(new ContentSaveDataError("The attribute 'TITLE' is required when saving content."));
    await expect(save({ parentid: '', type: 'Page', title: 'x' })).rejects.toThrow("The attribute 'PARENTID' is required when saving content.");
    await expect(save({ parentid: HOME, type: 'Portal', title: 'x' })).rejects.toThrow("A valid 'TYPE' is required when saving content.");
    await expect(saveContent(fx.deps, ADMIN, SITE, { parentid: HOME, type: 'Page', title: 'x' })).rejects.toThrow("The attribute 'SITEID' is required when saving content.");
  });

  it('returns validation errors without writing: an invalid template and a Component title in use', async () => {
    const invalid = await save({ parentid: HOME, type: 'Page', title: 'Templated', template: 'a/b.cfm', approved: 1 });
    expect(invalid.errors).toEqual({ template: 'invalid template' });
    expect(await content('title = $1', ['Templated'])).toHaveLength(0);
    const component = await save({ parentid: '00000000000000000000000000000000003', type: 'Component', title: 'Promo', approved: 1 });
    expect(component.errors).toEqual({});
    expect((await content('contentid = $1', [component.bean.contentId()]))[0]).toMatchObject({ moduleid: '00000000000000000000000000000000003', menutitle: 'Promo' });
    const duplicate = await save({ parentid: '00000000000000000000000000000000003', type: 'Component', title: 'Promo', approved: 1 });
    expect(duplicate.errors).toEqual({ titleconflict: "The 'Title' that you entered is already in use." });
  });

  it.each(['import', 'IMPORT', 'Import'])('refuses an import (mode=%s) of an unknown remote item whose posted date matches the empty one', async (mode) => {
    const refused = await save({ parentid: HOME, type: 'Page', title: 'Imported', mode, remoteid: 'R-1', remotepubdate: '' });
    expect(refused.refused).toBe(true);
    expect(await content('title = $1', ['Imported'])).toHaveLength(0);
  });

  it.each([
    ['import', 'R-2'],
    ['IMPORT', 'R-3'],
    ['Import', 'R-4'],
  ])('saves an import (mode=%s) of stored remote item %s as its next version', async (mode, remoteid) => {
    const stored = await save({ parentid: HOME, type: 'Page', title: `Remote ${remoteid}`, approved: 1, remoteid });
    const imported = await save({ parentid: HOME, type: 'Page', title: `Reimported ${remoteid}`, approved: 1, mode, remoteid, remotepubdate: '' });
    expect(imported).toMatchObject({ errors: {}, refused: false });
    expect(imported.bean.contentId()).toBe(stored.bean.contentId());
    expect((await fx.rows('source_map', 'contenthistid = $1', [imported.bean.contentHistId()]))[0]).toMatchObject({ sourceid: stored.bean.contentHistId() });
    expect((await content('remoteid = $1', [remoteid])).map((r) => [r.contentid, r.title, r.active])).toEqual([
      [stored.bean.contentId(), `Remote ${remoteid}`, 0],
      [stored.bean.contentId(), `Reimported ${remoteid}`, 1],
    ]);
  });

  it('writes tags, region objects, related content and category assignments, and carries them to later versions', async () => {
    const categoryId = cfId('K', 1);
    await fx.inTenant((tx) => fx.repo.categories.insertCategory(tx, { categoryid: categoryId, siteid: TENANT_UMBRELLA.siteId, name: 'News', isactive: 1, filename: 'news', path: `'${categoryId}'` }), TENANT_UMBRELLA.tenantId);
    const target = await save({ parentid: HOME, type: 'Page', title: 'Related Target', approved: 1 });
    const saved = await save({
      parentid: HOME,
      type: 'Page',
      title: 'Tagged',
      approved: 1,
      tags: 'alpha,beta',
      objectlist2: JSON.stringify([['text', 'Text', '', '{"a":1}']]),
      relatedcontentsetdata: JSON.stringify([{ relatedcontentsetid: '00000000000000000000000000000000000', items: [target.bean.contentId()] }]),
      categoryid: categoryId,
      [`categoryassign${categoryId.replaceAll('-', '')}`]: 1,
    });
    expect(saved.errors).toEqual({});
    const histId = saved.bean.contentHistId();
    expect((await fx.rows('content_tag', 'contenthistid = $1', [histId], 'tag')).map((r) => r.tag)).toEqual(['alpha', 'beta']);
    expect(await fx.rows('content_object', 'contenthistid = $1', [histId])).toEqual([expect.objectContaining({ object: 'text', name: 'Text', columnid: 2, orderno: 1, params: '{"a":1}' })]);
    expect(await fx.rows('content_related', 'contenthistid = $1', [histId])).toEqual([expect.objectContaining({ relatedid: target.bean.contentId(), orderno: 1 })]);
    expect(await fx.rows('content_category_assign', 'contenthistid = $1', [histId])).toEqual([expect.objectContaining({ categoryid: categoryId, isfeature: 1 })]);

    const next = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: saved.bean.contentId(), parentid: HOME, type: 'Page', title: 'Tagged Draft' });
    const nextHist = next.bean.contentHistId();
    expect(await fx.rows('content_object', 'contenthistid = $1', [nextHist])).toHaveLength(1);
    expect(await fx.rows('content_related', 'contenthistid = $1', [nextHist])).toHaveLength(1);
    expect(await fx.rows('content_category_assign', 'contenthistid = $1', [nextHist])).toHaveLength(1);
  });

  it('saves submitted extend-set values, reports invalid ones and preserves unsubmitted ones on the next version', async () => {
    const subtypeId = cfId('T', 1);
    const setId = cfId('S', 1);
    await fx.inTenant(async (tx) => {
      await tx.query(`INSERT INTO ${fx.handle.schema}.extend_subtype (tenant_id, subtypeid, siteid, basetable, type, subtype, isactive) VALUES ($1, $2, $3, 'tcontent', 'Page', 'Default', 1)`, [tx.tenantId, subtypeId, SITE_ID]);
      await tx.query(`INSERT INTO ${fx.handle.schema}.extend_set (tenant_id, extendsetid, subtypeid, siteid, name, orderno, isactive) VALUES ($1, $2, $3, $4, 'Main', 1, 1)`, [tx.tenantId, setId, subtypeId, SITE_ID]);
      await tx.query(
        `INSERT INTO ${fx.handle.schema}.extend_attribute (tenant_id, attributeid, extendsetid, siteid, name, type, validation, orderno, isactive, defaultvalue)` +
          ` VALUES ($1, 9001, $2, $3, 'color', 'TextBox', '', 1, 1, 'blue'), ($1, 9002, $2, $3, 'size', 'TextBox', 'Numeric', 2, 1, '')`,
        [tx.tenantId, setId, SITE_ID],
      );
    });
    const invalid = await save({ parentid: HOME, type: 'Page', title: 'Sized', approved: 1, extendsetid: setId, color: 'red', size: 'big' });
    expect(invalid.errors).toEqual({ size: 'SIZE must be numeric.' });

    const saved = await save({ parentid: HOME, type: 'Page', title: 'Sized', approved: 1, extendsetid: setId, color: 'red', size: '3' });
    expect(saved.errors).toEqual({});
    const values = await fx.rows('extend_data', 'baseid = $1', [saved.bean.contentHistId()], 'attributeid');
    expect(values.map((r) => [r.attributeid, r.attributevalue, r.numericvalue])).toEqual([
      [9001, 'red', null],
      [9002, '3', 3],
    ]);

    // A struct save autocompletes under the new version id, so an unsubmitted attribute takes its default, as in legacy.
    const next = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: saved.bean.contentId(), parentid: HOME, type: 'Page', title: 'Sized Draft', extendsetid: setId, size: '4' });
    expect(next.errors).toEqual({});
    const defaulted = await fx.rows('extend_data', 'baseid = $1', [next.bean.contentHistId()], 'attributeid');
    expect(defaulted.map((r) => [r.attributeid, r.attributevalue])).toEqual([
      [9001, 'blue'],
      [9002, '4'],
    ]);
    // A bean save autocompletes under its loaded version, so the stored value is kept.
    const viaBean = await saveContentEntity(fx.deps, ADMIN, SITE, { event: { siteid: SITE_ID, contentid: saved.bean.contentId(), type: 'Page', extendsetid: setId, size: '5' } });
    expect(viaBean.errors).toEqual({});
    const kept = await fx.rows('extend_data', 'baseid = $1', [viaBean.bean.contentHistId()], 'attributeid');
    expect(kept.map((r) => [r.attributeid, r.attributevalue])).toEqual([
      [9001, 'red'],
      [9002, '5'],
    ]);
  });

  it('records the review notices and draft assignments of a `notify` save', async () => {
    const recipient = cfId('U', 9);
    const saved = await saveContent(
      fx.deps,
      ADMIN,
      SITE,
      { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Notified', approved: 0, notify: recipient, message: 'Please review', topid: HOME, moduleid: '00000000000000000000000000000000000', ptype: 'Page' },
      { notify: { recipients: [{ userId: recipient, email: 'reviewer@example.com' }], sender: { fname: 'Admin', lname: 'User', email: 'admin@example.com' }, host: 'localhost', withVersionLink: true } },
    );
    expect(saved.errors).toEqual({});
    expect(saved.notices).toEqual([expect.objectContaining({ kind: 'content-notify', to: 'reviewer@example.com', subject: 'Site Content Review for LOCALHOST' })]);
    expect(saved.notices[0]?.body).toContain('Please review');
    expect(await fx.rows('content_assignment', 'contenthistid = $1', [saved.bean.contentHistId()])).toEqual([expect.objectContaining({ userid: recipient, type: 'draft' })]);
  });

  it('saves a scheduled item without a start date as on display', async () => {
    const saved = await save({ parentid: HOME, type: 'Page', title: 'Scheduled', approved: 1, display: 2 });
    expect((await content('contentid = $1', [saved.bean.contentId()]))[0]).toMatchObject({ display: 1 });
  });

  it('activates a version for an approval chain or a change-set publish', async () => {
    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: folderId, type: 'Page', title: 'Chain Approved' });
    const approved = await withGatedTenant(fx.deps.db, ADMIN.tenantId, (tx) =>
      approveVersion(tx, fx.deps, ADMIN, SITE, draft.bean.contentHistId(), { approvalChainOverride: true, approvingChainRequest: true }),
    );
    expect(approved.errors).toEqual({});
    expect((await content('contentid = $1 AND active = 1', [aboutId]))[0]).toMatchObject({ title: 'Chain Approved', approved: 1 });
  });

  it('saves in a caller transaction', async () => {
    const saved = await withGatedTenant(fx.deps.db, ADMIN.tenantId, (tx) => saveContentInTx(tx, fx.deps, ADMIN, SITE, new Map<string, unknown>([['siteid', SITE_ID], ['parentid', HOME], ['type', 'Page'], ['title', 'In Tx'], ['approved', 1]])));
    expect(saved.written.some((row) => row.title === 'In Tx')).toBe(true);
  });

  it('raises a pending approval request for a non-exempt editor and saves unapproved', async () => {
    const chained = await save({ parentid: HOME, type: 'Folder', title: 'Chained', approved: 1 });
    const editors = cfId('G', 4);
    const chainId = cfId('H', 1);
    const editor: Actor = { ...NOBODY, userId: cfId('U', 4), roles: ['system-user', 'm:000'] };
    await fx.inTenant(async (tx) => {
      await fx.repo.projections.upsertGroupProjection(tx, { groupId: editors, siteId: SITE_ID, groupName: 'Editors', isPublic: 0, deleted: false });
      await fx.repo.projections.replaceUserMemberships(tx, editor.userId, SITE_ID, [editors]);
      await fx.repo.projections.replaceGroupPermissions(tx, editors, SITE_ID, [{ contentId: HOME, siteId: SITE_ID, type: 'editor' }]);
      await fx.repo.approvals.insertChain(tx, { chainid: chainId, siteid: SITE_ID, name: 'Chain' });
      await fx.repo.approvals.upsertAssignment(tx, { contentid: chained.bean.contentId(), siteid: SITE_ID, chainid: chainId });
    });
    const saved = await save({ parentid: chained.bean.contentId(), type: 'Page', title: 'Needs Approval', approved: 1 }, editor);
    expect(saved.errors).toEqual({});
    const [row] = await content('title = $1', ['Needs Approval']);
    expect(row).toMatchObject({ approved: 0, lastupdatebyid: editor.userId });
    expect(await fx.rows('approval_request', 'contenthistid = $1', [row?.contenthistid])).toEqual([expect.objectContaining({ chainid: chainId, status: 'Pending' })]);
  });

  describe('JSON API save', () => {
    it('denies an actor without node permission', async () => {
      await expect(saveContentEntity(fx.deps, NOBODY, SITE, { event: { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Nope' } })).rejects.toMatchObject({ type: 'authorization' });
      expect(await content('title = $1', ['Nope'])).toHaveLength(0);
    });

    it('saves an editor save, reloads it and keys it by contenthistid', async () => {
      const saved = await saveContentEntity(fx.deps, ADMIN, SITE, { event: { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Api Page', approved: 1 } });
      expect(saved).toMatchObject({ errors: {}, pk: 'contenthistid' });
      expect(saved.bean.isNew).toBe(0);
      expect(saved.bean.text('title')).toBe('Api Page');
    });

    it('keeps the event values on the reloaded bean of a save with errors', async () => {
      const saved = await saveContentEntity(fx.deps, ADMIN, SITE, { event: { siteid: SITE_ID, contentid: aboutId, parentid: folderId, type: 'Page', title: 'Bad', template: 'x/y.cfm' } });
      expect(saved.pk).toBe('contentid');
      expect(saved.errors).toEqual({ template: 'invalid template' });
      expect(saved.bean.text('title')).toBe('Bad');
    });

    it('saves an author save unapproved and removes categories on request', async () => {
      const authors = cfId('G', 2);
      const author: Actor = { ...NOBODY, userId: cfId('U', 3), roles: ['system-user', 'm:000'] };
      await fx.inTenant(async (tx) => {
        await fx.repo.projections.upsertGroupProjection(tx, { groupId: authors, siteId: SITE_ID, groupName: 'Authors', isPublic: 0, deleted: false });
        await fx.repo.projections.replaceUserMemberships(tx, author.userId, SITE_ID, [authors]);
        await fx.repo.projections.replaceGroupPermissions(tx, authors, SITE_ID, [{ contentId: HOME, siteId: SITE_ID, type: 'author' }]);
      });
      const saved = await saveContentEntity(fx.deps, author, SITE, { event: { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Authored', approved: 1, removecategories: true } });
      expect(saved.errors).toEqual({});
      expect((await content('title = $1', ['Authored']))[0]).toMatchObject({ approved: 0, lastupdatebyid: author.userId });
    });

    it('saves a new Variation in a change set as an approved empty default, then the draft', async () => {
      const changeset = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: folderId, type: 'Page', title: 'For Variation', changesetid: 'other', changesetname: 'Variations' });
      const changesetId = changeset.bean.text('changesetid');
      const variations = '00000000000000000000000000000000099';
      await fx.inTenant((tx) =>
        fx.repo.content.insertVersion(tx, { contentid: variations, siteid: SITE_ID, parentid: END, type: 'Module', subtype: 'Default', moduleid: variations, active: 1, approved: 1, path: variations }),
      );
      const saved = await saveContentEntity(fx.deps, ADMIN, SITE, {
        event: { siteid: SITE_ID, parentid: '00000000000000000000000000000000099', type: 'Variation', title: 'Hero', body: encodeURIComponent('[{"a":1}]'), changesetid: changesetId },
      });
      expect(saved.errors).toEqual({});
      const versions = await content('contentid = $1', [saved.bean.contentId()]);
      expect(versions.map((r) => [r.body, r.changesetid, r.approved])).toEqual([
        ['[]', null, 1],
        ['[{"a":1}]', changesetId, 0],
      ]);
    });
  });
});
