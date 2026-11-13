// carch edit form custom tags (core/mura/customtags) and dsp_file_selector.cfm: file selector, file tools, time selects.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  datetimeSelector,
  fileSelector,
  fileTools,
  jsStringFormat,
  timeSelector,
  type EditFormInput,
  type EditFormState,
  type FileMetaData,
  type FileSelectorAttrs,
  type FileSelectorBean,
  type FileTagInput,
} from '@/screens/carch/form/custom-tags';
import { renderFileSelector } from '@/screens/carch/form/file-selector';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const { CACHE_ID } = vi.hoisted(() => ({ CACHE_ID: 'E961B0FC-DE2F-13E7-2E602E773170A1C4' }));

// Legacy `createUUID()` names the preview image's cacheID; the captures hold the one it minted.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(() => CACHE_ID) };
});

// `cf_fileselector` around `cf_filetools` for the Placeholder Image of site `default`, captured from the legacy ACF 2023
// Site Settings editor (csettings/editsite.cfm line 1020), the same tags the content editor includes.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/programs-sites/file-selector/${name}.html`, import.meta.url), 'utf8');

const IMAGE_ID = 'E96179A4-AA08-3B1B-655CF7A6091215CE';
const FILE_ID = 'E966A553-A0A6-6C3D-6BD02262257365D5';
const RAZUNA = { hostname: 'dam.example.com', apiKey: 'KEY123' };
const CONTENT_ID = 'D1000000-0000-0000-0000000000000002';
const HIST_ID = 'D2000000-0000-0000-0000000000000002';
const META_HIST_ID = 'D2000000-0000-0000-0000000000000001';
const USER_ID = 'U1000000-0000-0000-0000000000000001';
const OTHER_USER_ID = 'U1000000-0000-0000-0000000000000099';
const STORED_FILE_ID = 'F1000000-0000-0000-0000000000000001';

const NEW_META: FileMetaData = Object.freeze({
  isNew: true,
  filename: '',
  hasImageFileExt: false,
  hasCroppableImageFileExt: false,
  contentHistId: '',
  fileId: '',
  imageUrl: '',
});

/** A stored file's metadata; `values` replace members. */
const storedMeta = (values: Partial<FileMetaData> = {}): FileMetaData => ({
  ...NEW_META,
  isNew: false,
  filename: 'guide.pdf',
  contentHistId: META_HIST_ID,
  fileId: STORED_FILE_ID,
  ...values,
});

const PNG_META = storedMeta({
  filename: 'placeholder.png',
  hasImageFileExt: true,
  hasCroppableImageFileExt: true,
  imageUrl: `/sites/default/cache/file/${IMAGE_ID}_medium.png`,
});

/** The settingsBean of `default` as the tags read it, holding `fileId` under its placeholder property. */
const siteBean = (fileId: string, fileMeta: FileMetaData): FileSelectorBean => ({
  entityName: 'site',
  type: '',
  contentId: '',
  contentHistId: '',
  siteId: 'default',
  userId: '',
  propertyValue: fileId,
  fileExt: '',
  majorVersion: 0,
  minorVersion: 0,
  fileMeta,
});

/** A stored content version of `type` holding `fileMeta` under `fileid`; `values` replace members. */
const contentBean = (type: string, fileMeta: FileMetaData, values: Partial<FileSelectorBean> = {}): FileSelectorBean => ({
  entityName: 'content',
  type,
  contentId: CONTENT_ID,
  contentHistId: HIST_ID,
  siteId: 'default',
  userId: '',
  propertyValue: STORED_FILE_ID,
  fileExt: 'PDF',
  majorVersion: 2,
  minorVersion: 3,
  fileMeta,
  ...values,
});

/** The tag input of the S2 admin's request, with identity's fixed CSRF pair. */
const tagInput = (req: AdminRequest = adminS2Request({ circuit: 'cArch', item: 'edit' })): FileTagInput => ({
  ctx: makeScreenContext({ req }),
});

/** The placeholder image selector as editsite.cfm calls the tag; `attrs` replace attributes. */
const placeholder = (bean: FileSelectorBean, attrs: Partial<FileSelectorAttrs> = {}): FileSelectorAttrs => ({
  bean,
  name: 'newPlaceholderImg',
  property: 'placeholderImgID',
  deleteKey: 'deletePlaceholderImg',
  compactDisplay: 'false',
  locked: false,
  examplefileext: '',
  ...attrs,
});

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('cf_fileselector against legacy captures', () => {
  it.each<[string, FileSelectorAttrs]>([
    ['none', placeholder(siteBean('', NEW_META))],
    ['image', placeholder(siteBean(IMAGE_ID, PNG_META))],
    ['file', placeholder(siteBean(FILE_ID, storedMeta()))],
    ['razuna', placeholder(siteBean(FILE_ID, storedMeta()), { razuna: RAZUNA })],
    [
      'encoded',
      placeholder(siteBean(FILE_ID, storedMeta()), {
        name: 'nImg',
        deleteKey: 'delKey',
        class: 'x&quot;y',
        label: "a<b>&amp;&quot;c' é:/#\tt",
        required: "r'q",
        validation: 'v/w',
        regex: '^[a-z]+$',
        message: 'm:é',
        examplefileext: 'p&quot;ng',
        razuna: RAZUNA,
      }),
    ],
  ])('renders the %s placeholder exactly as legacy', async (fixture, attrs) => {
    const out = await fileSelector(tagInput(), attrs);
    expect(isSafeHtml(out)).toBe(true);
    expect(toString(out)).toBe(legacy(fixture));
  });

  it('offers the Razuna tab and URL field only for the settings the site has', async () => {
    const hostOnly = toString(await fileSelector(tagInput(), placeholder(siteBean('', NEW_META), { razuna: { hostname: 'dam', apiKey: '' } })));
    expect(hostOnly).toContain('value="URL-Razuna"');
    expect(hostOnly).not.toContain('mura-file-url-razuna');
    const keyOnly = toString(await fileSelector(tagInput(), placeholder(siteBean('', NEW_META), { razuna: { hostname: '', apiKey: 'K' } })));
    expect(keyOnly).not.toContain('value="URL-Razuna"');
    expect(keyOnly).toContain('placeholder="http://" data-label=""');
  });
});

describe('cf_filetools of a stored content file', () => {
  const download = (fileId: string): string =>
    `return confirmDialog('Download File?',function(){location.href='/index.cfm/_api/render/file/?fileid=${fileId}&method=attachment&size=source';});`;

  it.each<[string, boolean, string, string]>([
    ['unlocked', false, '  style="display:none" class', '"btn-group">'],
    ['locked', true, '  class', '"btn-group" style="display:none">'],
  ])('offers a File node %s the version, lock dropdown and lock scripts', async (_case, locked, lockedLink, unlockedGroup) => {
    const meta = storedMeta({ filename: 'Annual "Report" & <Plan>.pdf' });
    const out = toString(
      await fileSelector(tagInput(), {
        bean: contentBean('File', meta),
        name: 'newfile',
        property: 'fileid',
        deleteKey: 'deleteFile',
        locked,
      }),
    );
    expect(out).toContain('data-filetype="File"');
    expect(out).toContain('<input type="radio" name="versionType" value="major">Major Revision');
    expect(out).toContain('<input type="radio" name="versionType" value="minor" checked />Minor Revision');
    expect(out).toContain(
      '<div class="mura-file pdf">\n\t     \t\n\t\t \t<i class="mi-file-text-o mi-2x"></i> Annual &quot;Report&quot; &amp; &lt;Plan&gt;.pdf (v2.3)\n',
    );
    expect(out).toContain(`<a id="mura-download-locked"${lockedLink}="btn download-file" onclick="${download(STORED_FILE_ID)}">`);
    expect(out).toContain(`<div id="mura-download-unlocked" class=${unlockedGroup}`);
    expect(out).toContain('<li><a id="mura-file-offline-edit" href="#"><i class="mi-lock"></i> Download & Lock for Offline Editing</a></li>');
    expect(out).not.toContain('class="deleteFileBox"');
    expect(out).toContain(`\t\t\t\t\t\t"Unlock this File?",\n`);
    expect(out).toContain(`\t\t\t\t\t\t\t\tcontentid:"${CONTENT_ID}",\n\t\t\t\t\t\t\t\tsiteid:"default",\n`);
    expect(out).toContain(`csrf_token:'${FIXED_CSRF.token}',\n\t\t\t\t\t\t\t\tcsrf_token_expires: '${FIXED_CSRF.expires}'\n`);
    expect(out).toContain(
      `document.location="./?muraAction=carch.lockfile&contentID=${CONTENT_ID}&siteID=default&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}";`,
    );
  });

  it('asks identity once for both lock contexts of the File node', async () => {
    const input = tagInput();
    await fileTools(input, { bean: contentBean('File', storedMeta()) });
    const ctx = input.ctx as ReturnType<typeof makeScreenContext>;
    const issued = ctx.gateway.calls.filter((call) => call.path === '/v1/csrf/tokens');
    expect(issued.map((call) => call.json)).toEqual([{ contexts: [`${CONTENT_ID}unlockfile`, `${CONTENT_ID}lockfile`] }]);
  });

  it('omits the version suffix of a File node at version 0', async () => {
    const out = toString(await fileTools(tagInput(), { bean: contentBean('File', storedMeta(), { majorVersion: 0 }) }));
    expect(out).toContain('<i class="mi-file-text-o mi-2x"></i> guide.pdf\n');
  });

  it('offers a content image its crop, metadata, download and remove controls', async () => {
    const meta = storedMeta({
      filename: 'hero.jpg',
      hasImageFileExt: true,
      hasCroppableImageFileExt: true,
      imageUrl: `/sites/default/cache/file/${STORED_FILE_ID}_medium.jpg`,
    });
    const out = toString(await fileTools(tagInput(), { bean: contentBean('Page', meta), compactDisplay: 'true' }));
    expect(out).toContain(`<img id="assocImage" src="/sites/default/cache/file/${STORED_FILE_ID}_medium.jpg?cacheID=${CACHE_ID}" />`);
    expect(out).toContain(
      `<a class="btn" href="./?muraAction=cArch.imagedetails&contenthistid=${HIST_ID}&siteid=default&fileid=${STORED_FILE_ID}&compactDisplay=true"><i class="mi-crop"></i></a>`,
    );
    expect(out).toContain(
      `<a class="btn" href="" onclick="return openFileMetaData('${META_HIST_ID}','${STORED_FILE_ID}','default','fileid');"><i class="mi-info-circle"></i></a>`,
    );
    expect(out).toContain(`<a class="btn download-file" onclick="${download(STORED_FILE_ID)}"><i class="mi-download"></i></a>`);
    expect(out).toContain('<input type="checkbox" name="deleteFile" value="1" class="deleteFileBox"/>');
    expect(out).not.toContain('class="mura-file ');
    expect(out).not.toContain('carch.lockfile');
  });

  it('crops a user image by user id with a URL-encoded compactDisplay and offers no metadata button', async () => {
    const meta = storedMeta({ hasImageFileExt: true, hasCroppableImageFileExt: true, imageUrl: '/u.png' });
    const bean = contentBean('', meta, { entityName: 'user', userId: USER_ID, contentId: '', contentHistId: '' });
    const out = toString(await fileTools(tagInput(), { bean, property: 'photoFileID', compactDisplay: 'a b&c' }));
    expect(out).toContain(
      `href="./?muraAction=cArch.imagedetails&userid=${USER_ID}&siteid=default&fileid=${STORED_FILE_ID}&compactDisplay=a%20b%26c"`,
    );
    expect(out).not.toContain('openFileMetaData');
    expect(out).not.toContain('class="mura-file ');
  });

  it.each<[string, Partial<FileSelectorBean>, Partial<FileMetaData>]>([
    ['an image that cannot be cropped', { entityName: 'content' }, { hasCroppableImageFileExt: false }],
    ['a croppable image of a site', { entityName: 'site' }, { hasCroppableImageFileExt: true }],
  ])('offers no crop link for %s', async (_case, values, metaValues) => {
    const meta = storedMeta({ hasImageFileExt: true, imageUrl: '/i.gif', ...metaValues });
    expect(toString(await fileTools(tagInput(), { bean: contentBean('Page', meta, values) }))).not.toContain('mi-crop');
  });

  it('names a non-image file of another property without its version', async () => {
    const bean = contentBean('Page', storedMeta({ filename: 'a<b>.zip' }), { fileExt: 'ZIP' });
    const out = toString(await fileTools(tagInput(), { bean, property: 'attachmentID', deleteKey: 'deleteAttachment' }));
    expect(out).toContain('<div class="mura-file zip">\n\t     \t\n\t\t \t<i class="mi-file-text-o mi-2x"></i> a&lt;b&gt;.zip\n');
    expect(out).toContain('name="deleteAttachment"');
  });

  it('renders nothing for a property without a stored file', async () => {
    expect(toString(await fileTools(tagInput(), { bean: contentBean('File', NEW_META) }))).toBe('');
  });
});

describe('cf_timeselector and cf_datetimeselector', () => {
  const ctxFor = (locale: string): Pick<EditFormInput['ctx'], 'req'> => ({ req: adminS2Request({ session: { locale } }) });

  it.each<[string, string | null, number, string, string]>([
    ['13:05 as 1 PM', "{ts '2026-07-01 13:05:00'}", 0, '1', 'PM'],
    ['midnight as 12 AM', "{ts '2026-07-01 00:30:00'}", 0, '12', 'AM'],
    ['noon as 12 PM', "{ts '2026-07-01 12:00:00'}", 0, '12', 'PM'],
    ['no time at the default hour 0 as 12 AM', null, 0, '12', 'AM'],
    ['no time at the default hour 23 as 11 PM', null, 23, '11', 'PM'],
  ])('selects %s in a locale with day parts', (_case, time, defaulthour, hour, daypart) => {
    const out = toString(timeSelector(ctxFor('en_US'), { name: 'start', time, defaulthour }));
    expect(out).toContain('<select id="mura-startHour" class="time mura-datepickerstart" name="startHour">');
    const [hours, minutes, dayparts] = fragmentModel(out).controls;
    expect(hours?.options.map((o) => o.value)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(hours?.selected).toEqual([hour]);
    expect(minutes?.name).toBe('startMinute');
    expect(dayparts).toMatchObject({ name: 'startDayPart', selected: daypart === 'PM' ? ['PM'] : [] });
  });

  it('selects the 24-hour time without day parts, minutes zero-padded, in a 24-hour locale', () => {
    const out = toString(timeSelector(ctxFor('de_DE'), { name: 'start', time: "{ts '2026-07-01 13:05:00'}" }));
    expect(out).toContain('<select  id="mura-startHour" class="time mura-datepickerstart" name="startHour">');
    const controls = fragmentModel(out).controls;
    expect(controls.map((c) => c.name)).toEqual(['startHour', 'startMinute']);
    expect(controls[0]?.options).toHaveLength(24);
    expect(controls[0]?.selected).toEqual(['13']);
    expect(controls[1]?.options[5]).toEqual({ value: '5', label: '05', selected: true });
  });

  it('attribute-encodes the select names, ids and classes it is given', () => {
    const out = toString(
      timeSelector(ctxFor('de_DE'), {
        name: 'x"y',
        hourname: 'h<n>',
        hourid: 'h"id',
        hourclass: 'c d',
        minutename: 'mn',
        minuteid: 'mid',
        minuteclass: 'mc',
      }),
    );
    expect(out).toContain(
      `<select  id="${encodeHtmlAttr('h"id')}" class="${encodeHtmlAttr('c d')} mura-datepicker${encodeHtmlAttr('x"y')}" name="${encodeHtmlAttr('h<n>')}">`,
    );
    expect(out).toContain(`<select id="mid" class="mc mura-datepicker${encodeHtmlAttr('x"y')}" name="mn">`);
  });

  it('breaks after the date field and carries the required flag and message', () => {
    const ctx = { ...ctxFor('en_US'), now: new Date('2026-11-13T04:22:00Z') };
    const out = toString(
      datetimeSelector(ctx, { name: 'due', datetime: '', break: true, required: true, message: 'Pick a date', dateclass: 'wide' }),
    );
    expect(out).toContain('class="datepicker wide span3 mura-datepickerdue" value="" maxlength="12" id="mura-datepicker-due"/><br/>');
    expect(out).toContain(
      `<input type="hidden" id="mura-due" name="due" value="" data-required="true" data-required="${encodeHtmlAttr('Pick a date')}"/>`,
    );
  });
});

describe('ACF JSStringFormat', () => {
  it.each<[string, string, string]>([
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['quotes', `it's "x"`, `it\\'s \\"x\\"`],
    ['line breaks and tabs', 'a\r\nb\tc', 'a\\r\\nb\\tc'],
    ['backspace and form feed', 'a\bb\fc', 'a\\bb\\fc'],
    ['markup, which it keeps', '<b>&</b>', '<b>&</b>'],
  ])('escapes %s', (_case, input, expected) => {
    expect(jsStringFormat(input)).toBe(expected);
  });
});

describe('carch.edit file selector include', () => {
  const STATE: EditFormState = Object.freeze({
    tabAssignments: '',
    pageLevelList: 'Page,Folder,Calendar',
    baseTypeList: 'Page,Folder,Calendar,Gallery,Link,File',
    subTypes: [],
    subtypeFilter: '',
    isExtended: false,
    requiresApproval: false,
    showApprovalStatus: false,
    hasChangesets: false,
    ptype: 'Page',
    compactDisplay: 'false',
    preview: '0',
  });

  /** A stored `type` version with a stored PDF and the given lock. */
  function storedBean(type: string, stats: Readonly<Record<string, string>>, meta?: Readonly<Record<string, unknown>>) {
    return {
      contentID: CONTENT_ID,
      contentHistID: HIST_ID,
      isNew: 0,
      type,
      siteID: 'default',
      fileID: STORED_FILE_ID,
      fileExt: 'pdf',
      majorVersion: 1,
      minorVersion: 0,
      stats,
      fileMetaData: meta ?? {
        isNew: 0,
        filename: 'guide.pdf',
        hasImageFileExt: 0,
        hasCroppableImageFileExt: 0,
        contentHistID: META_HIST_ID,
        fileID: STORED_FILE_ID,
        imageURL: '',
      },
    };
  }

  interface Include {
    readonly type?: string;
    /** Default the session user's file lock-free stats. */
    readonly stats?: (userId: string) => Readonly<Record<string, string>>;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly lockedBy?: Readonly<Record<string, string>>;
    readonly req?: AdminRequest;
    readonly ptype?: string;
  }

  async function include(c: Include = {}): Promise<string> {
    const type = c.type ?? 'File';
    const req = c.req ?? adminS2Request({ circuit: 'cArch', item: 'edit', rc: { type } });
    const stats = (c.stats ?? (() => ({ lockID: '', lockType: '' })))(req.session.mura.userID ?? '');
    const rc: Record<string, unknown> = { contentBean: storedBean(type, stats, c.meta) };
    if (c.lockedBy !== undefined) rc.lockedBy = c.lockedBy;
    const ctx = makeScreenContext({ req });
    const out = await renderFileSelector({ ctx, req, data: { rc }, state: { ...STATE, ptype: c.ptype ?? 'Page' } });
    expect(isSafeHtml(out)).toBe(true);
    return toString(out);
  }

  const OTHERS_LOCK = (): Readonly<Record<string, string>> => ({ lockID: OTHER_USER_ID, lockType: 'file' });
  const ANN = { fname: 'Ann "A"', lname: 'O<Neil>', email: 'ann&o@example.com' };

  it('offers a stored File its selector with the hidden own-lock notice and its stored file', async () => {
    const out = await include();
    expect(out).toContain('<h2>Select File</h2>');
    expect(out).not.toContain('assocImagePreviewContainer');
    expect(out).toContain('<p id="msg-file-locked" class="help-block" style="display:none;">');
    expect(out).toContain('<a class="mura-file-unlock" href="#" style="display:none;">');
    expect(out).toContain('<div id="assocFileSelectorContainer" style="clear:none;float:none;">');
    expect(out).toContain('<i class="mi-file-text-o mi-2x"></i> guide.pdf (v1.0)');
    expect(out).toContain('siteManager.hasFileLock=false;');
  });

  it('shows the own-lock notice, the locked download and the lock flag to the user holding the file lock', async () => {
    const out = await include({ stats: (userId) => ({ lockID: userId, lockType: 'file' }) });
    expect(out).toContain(
      "<p id=\"msg-file-locked\" class=\"help-block\">You've locked this file for offline editing. <a class=\"mura-file-unlock\" href=\"#\"><i class=\"mi-unlock\"></i> Unlock this File</a>",
    );
    expect(out).toContain('<a id="mura-download-locked"  class="btn download-file"');
    expect(out).toContain('siteManager.hasFileLock=true;');
  });

  it('treats a node lock held by the user as no file lock, yet as locked for the download', async () => {
    const out = await include({ stats: (userId) => ({ lockID: userId, lockType: 'node' }) });
    expect(out).toContain('<p id="msg-file-locked" class="help-block" style="display:none;">');
    expect(out).toContain('<a id="mura-download-locked"  class="btn download-file"');
    expect(out).toContain('siteManager.hasFileLock=false;');
  });

  it.each<[string, AdminRequest, boolean]>([
    ['the S2 admin', adminS2Request({ circuit: 'cArch', item: 'edit', rc: { type: 'File' } }), true],
    ['a site admin', siteAdminRequest(undefined, { circuit: 'cArch', item: 'edit', rc: { type: 'File' } }), true],
    ['qa_editor', editorRequest({ circuit: 'cArch', item: 'edit', rc: { type: 'File' } }), false],
  ])('names the holder of another user lock to %s, with the unlock link only for super and admin users', async (_case, req, unlock) => {
    const out = await include({ req, stats: OTHERS_LOCK, lockedBy: ANN });
    const holder = `${encodeHtmlAttr(ANN.fname)} ${encodeHtml(ANN.lname)}`;
    expect(out).toContain(
      `<p id="msg-file-locked-else" class="help-block">The associated file is locked for offline editing by ${holder}.<br>`,
    );
    expect(out).toContain(
      `<a href="mailto:${encodeHtml(ANN.email)}?subject=${encodeHtml('File Unlock Request')}"><i class="mi-envelope"></i> Request File Lock Release via Email</a>`,
    );
    expect(out.includes('&nbsp; &nbsp;<a class="mura-file-unlock" href="#"><i class="mi-unlock"></i> Unlock this File</a>')).toBe(unlock);
    expect(out).toContain('<p id="msg-file-locked" class="help-block" style="display:none;">');
    expect(out).toContain('<div class="mura-file-selector">');
    expect(out).not.toContain('mura-file-selector-tabs');
    expect(out).toContain('<a id="mura-download-locked"  class="btn download-file"');
    expect(out).toContain('siteManager.hasFileLock=false;');
  });

  it('names a blank holder when the model carries no lock holder', async () => {
    const out = await include({ stats: OTHERS_LOCK });
    expect(out).toContain('<p id="msg-file-locked-else" class="help-block">The associated file is locked for offline editing by  .<br>');
    expect(out).toContain('<a href="mailto:?subject=');
  });

  it('previews a stored image of a Page inside the select image flyout', async () => {
    const meta = {
      isNew: 0,
      filename: 'hero.png',
      hasImageFileExt: 1,
      hasCroppableImageFileExt: 1,
      contentHistID: META_HIST_ID,
      fileID: STORED_FILE_ID,
      imageURL: '/sites/default/cache/file/hero_medium.png',
    };
    const out = await include({ type: 'Page', meta });
    expect(out).toContain('<div id="assocImagePreviewContainer">');
    expect(out).toContain('<div class="bigui" id="bigui__associmg" data-label="Select Image">');
    expect(out).toContain(`<img id="assocImage" src="/sites/default/cache/file/hero_medium.png?cacheID=${CACHE_ID}" />`);
    expect(out).toContain(`muraAction=cArch.imagedetails&contenthistid=${HIST_ID}&siteid=default&fileid=${STORED_FILE_ID}`);
    expect(out).toContain('placeholder="http://www.domain.com/yourfile.png"');
  });

  it('heads a File of a Gallery with the image label but shows no image preview', async () => {
    const out = await include({ ptype: 'Gallery' });
    expect(out).toContain(`data-original-title="${encodeHtmlAttr('Associated Image')}">`);
    expect(out).not.toContain('<h2>');
    expect(out).not.toContain('assocImagePreviewContainer');
    expect(out).toContain('<div id="assocFileSelectorContainer"');
  });
});
