/** File handling of contentManager.add, contentUtility.copy and multiFileUpload over a throwaway `content` schema and local storage. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
import { copy, multiFileUpload, publish, saveContent, saveDraft, type ContentInput, type SaveContentOptions } from '../../src/domain/content.js';
import type { UploadedFile } from '../../src/domain/files.js';
import { StartupPredicateViolationError } from '../../src/domain/startup-guard.js';
import { ADMIN, END, HOME, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const part = (fileName: string, fieldName = 'newfile', contentType = 'application/pdf'): UploadedFile => ({ fieldName, fileName, contentType, bytes: Buffer.from(`bytes of ${fileName}`) });

describe.skipIf(!(await pgAvailable()))('domain/content files', () => {
  let fx: ContentFixture;
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const save = (input: ContentInput, opts: SaveContentOptions = {}) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input }, opts);

  beforeAll(async () => {
    fx = await createContentFixture('content-files-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  let fileItemId = '';
  it('stores a non-image upload in the file pool, sets the File body to the stored filename and numbers the version', async () => {
    const saved = await save({ parentid: HOME, type: 'File', title: 'Report', approved: 1 }, { files: [part('report.pdf')] });
    expect(saved.errors).toEqual({});
    fileItemId = saved.bean.contentId();
    const [row] = await content('contentid = $1', [fileItemId]);
    expect(row).toMatchObject({ body: 'report.pdf', majorversion: 1, minorversion: 0 });
    const fileId = String(row?.fileid);
    const stored = await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, fileId), TENANT_UMBRELLA.tenantId);
    expect(stored).toMatchObject({ filename: 'report.pdf', contentid: fileItemId, siteid: TENANT_UMBRELLA.siteId });
  });

  it('bumps the minor version, or the major one on request, for a new upload of an existing File', async () => {
    await publish(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: fileItemId, parentid: HOME, type: 'File', title: 'Report' }, { files: [part('report-2.pdf')] });
    expect((await content('contentid = $1 AND active = 1', [fileItemId]))[0]).toMatchObject({ body: 'report-2.pdf', majorversion: 1, minorversion: 1 });
    await publish(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: fileItemId, parentid: HOME, type: 'File', title: 'Report', versiontype: 'major', unlockfilewithnew: true }, { files: [part('report-3.pdf')] });
    expect((await content('contentid = $1 AND active = 1', [fileItemId]))[0]).toMatchObject({ body: 'report-3.pdf', majorversion: 2, minorversion: 0 });
  });

  it('assigns file metadata to the version from fileMetaDataAssign', async () => {
    const [active] = await content('contentid = $1 AND active = 1', [fileItemId]);
    const saved = await publish(fx.deps, ADMIN, SITE, {
      siteid: SITE_ID,
      contentid: fileItemId,
      parentid: HOME,
      type: 'File',
      title: 'Report',
      body: String(active?.body),
      filemetadataassign: JSON.stringify({ fileid: { alttext: 'Alt text', caption: 'Caption', setasdefault: true } }),
    });
    expect(saved.errors).toEqual({});
    // The metadata row takes the pooled file's site, so it is held in the umbrella tenant.
    const metas = await fx.inTenant(
      async (tx) => (await tx.query(`SELECT * FROM ${fx.handle.schema}.file_metadata WHERE contenthistid = $1`, [saved.bean.contentHistId()])).rows,
      TENANT_UMBRELLA.tenantId,
    );
    expect(metas).toEqual([expect.objectContaining({ fileid: active?.fileid, alttext: 'Alt text', caption: 'Caption', siteid: TENANT_UMBRELLA.siteId })]);
  });

  it('reports a new File without a file, and restricted uploads, without writing', async () => {
    const missing = await save({ parentid: HOME, type: 'File', title: 'No File', approved: 1, body: 'x' });
    expect(missing.errors).toEqual({ filemissing: "You must select a file when creating a new 'File' content type." });
    const restricted = await save({ parentid: HOME, type: 'Page', title: 'Restricted', approved: 1 }, { files: [part('run.exe', 'other')] });
    expect(restricted.errors).toEqual({ requestHasRestrictedFiles: 'The posted request contained restricted file types' });
    expect(await content('title = $1 OR title = $2', ['No File', 'Restricted'])).toHaveLength(0);
  });

  it('keeps a Link body, refuses a bodyless Link through the start-up guard and drops a deleted file from a Page', async () => {
    const link = await save({ parentid: HOME, type: 'Link', title: 'Out', approved: 1, body: 'https://example.com/' });
    expect((await content('contentid = $1', [link.bean.contentId()]))[0]).toMatchObject({ body: 'https://example.com/' });
    await expect(save({ parentid: HOME, type: 'Link', title: 'Empty Link', approved: 1 })).rejects.toBeInstanceOf(StartupPredicateViolationError);
    expect(await content('title = $1', ['Empty Link'])).toHaveLength(0);

    const page = await save({ parentid: HOME, type: 'Page', title: 'With Attachment', approved: 1 }, { files: [part('notes.pdf')] });
    expect(String((await content('contentid = $1', [page.bean.contentId()]))[0]?.fileid)).not.toBe('');
    const cleared = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: page.bean.contentId(), parentid: HOME, type: 'Page', title: 'With Attachment', deletefile: 'true' });
    expect((await content('contenthistid = $1', [cleared.bean.contentHistId()]))[0]?.fileid).toBeNull();
  });

  it('copies an item and its children under a parent, the copy titled with the legacy suffix', async () => {
    const folder = await save({ parentid: HOME, type: 'Folder', title: 'Source', approved: 1, tags: 'keep' });
    await save({ parentid: folder.bean.contentId(), type: 'Page', title: 'Source Kid', approved: 1 });
    const copied = await copy(fx.deps, ADMIN, SITE, { siteId: SITE_ID, contentId: folder.bean.contentId(), parentId: HOME, recurse: true, setNotOnDisplay: true });
    expect(copied.contentId()).not.toBe(folder.bean.contentId());
    const [row] = await content('contentid = $1 AND active = 1', [copied.contentId()]);
    expect(row).toMatchObject({ title: 'Source', menutitle: 'Source - Copy', filename: 'source1', display: 0, parentid: HOME });
    const kids = await content('parentid = $1 AND active = 1', [copied.contentId()]);
    expect(kids.map((r) => [r.title, r.menutitle, r.filename])).toEqual([['Source Kid', 'Source Kid', 'source1/source-kid']]);
    expect(await fx.rows('content_tag', 'contenthistid = $1', [row?.contenthistid])).toEqual([expect.objectContaining({ tag: 'keep' })]);
    expect((await copy(fx.deps, ADMIN, SITE, { siteId: SITE_ID, contentId: folder.bean.contentId(), parentId: folder.bean.contentId() })).contentId()).toBe(folder.bean.contentId());
  });

  describe('multiFileUpload', () => {
    const args = { siteId: SITE_ID, parentId: HOME, subType: 'Default', approved: 1 };

    it('answers nothing without a posted `files` part', async () => {
      expect(await multiFileUpload(fx.deps, ADMIN, SITE, { ...args, files: [part('x.pdf')] })).toBeNull();
    });

    it('refuses a File item whose body stays empty before storing anything', async () => {
      await expect(multiFileUpload(fx.deps, ADMIN, SITE, { ...args, files: [part('a.pdf', 'files')] })).rejects.toBeInstanceOf(StartupPredicateViolationError);
    });

    it('adds a File item for the upload and answers its response struct with the extra params', async () => {
      const item = await multiFileUpload(fx.deps, ADMIN, SITE, { ...args, files: [part('brochure.pdf', 'files')], extraParams: JSON.stringify({ body: 'brochure.pdf', summary: '<p></p>', credits: 'Ann' }) });
      // structAppend(returnStr, extraParams) overwrites, so the posted summary replaces the response's.
      expect(item).toMatchObject({ filename: 'brochure.pdf', title: 'brochure.pdf', summary: '<p></p>', size: Buffer.from('bytes of brochure.pdf').length, delete_url: '', delete_type: 'DELETE', body: 'brochure.pdf' });
      expect(String(item?.edit_url)).toMatch(/^\/admin\/\?muraAction=cArch\.edit&contenthistid=/);
      const [row] = await content('title = $1', ['brochure.pdf']);
      expect(row).toMatchObject({ type: 'File', parentid: HOME, approved: 1, body: 'brochure.pdf', credits: 'Ann' });
    });
  });
});
