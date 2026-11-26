// cArch.imagedetails, cArch.multifileupload and cArch.selectmedia against their carch views and the strategies-content
// AdminViewModel contract, over the fake gateway.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { imagedetailsScreen } from '@/screens/carch/imagedetails';
import { multifileuploadScreen } from '@/screens/carch/multifileupload';
import { selectmediaScreen } from '@/screens/carch/selectmedia';
import type { CarchPageModel } from '@/screens/carch/service';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { adminS2Request, editorRequest, noSitesRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'default';
const SITE_MANAGER = '00000000000000000000000000000000000';
const HOME = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NODE = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const FILE_A = '5D4C3B2A-1F0E-4D9C-8B7A695847362514';
const FILE_B = '6E5D4C3B-2A1F-4E0D-9C8B7A6958473625';
// ESAPI encodeForJavaScript writes every non-alphanumeric character as `\xHH`.
const FILE_A_JS = FILE_A.replaceAll('-', '\\x2D');
const CF_UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}';
const URL_CSRF = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const FORM_CSRF =
  `<input type="hidden" name="csrf_token" value="${FIXED_CSRF.token}" />` +
  `<input type="hidden" name="csrf_token_expires" value="${FIXED_CSRF.expires}" />`;
const ARCHITECTURE_SCRIPT = '<script src="/admin/assets/js/architecture.min.js?coreversion=';
const HOME_EDIT_URL =
  `/admin/?muraAction=cArch.edit&contenthistid=${HOME_HIST}&contentid=${HOME}&type=Page&siteid=${SITE}` +
  `&topid=${HOME}&parentid=${END}&moduleid=${SITE_MANAGER}&compactdisplay=false`;
const SITE_MANAGER_URL = `./?&muraAction=cArch.list&siteid=${SITE}&moduleid=${SITE_MANAGER}`;

const IMAGE_DETAILS = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/files/image-details`);
const SELECT_MEDIA = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/images`);
const MULTI_UPLOAD = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/${HOME}/multi-file-upload`);

/** The `getCrumbList` entry of the site root, as strategies-content reports crumbs. */
const HOME_CRUMB = {
  siteid: SITE,
  contentid: HOME,
  moduleid: SITE_MANAGER,
  type: 'Page',
  menutitle: 'Home',
  restricted: 0,
  iconclass: 'mi-file',
  parentid: END,
};

type Ctx = ScreenContext & { gateway: FakeGatewayClient };

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** A 200 AdminViewModel answer with `rc`. */
const viewModel = (rc: CarchPageModel['rc']): FakeReply => ({ status: 200, body: { rc } satisfies CarchPageModel });

/** The S2 admin's `carch.<item>` request with `rc` and `partial` laid over it. */
const s2 = (item: string, rc: Record<string, string>, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'carch', item, rc: { siteid: SITE, ...rc } });

/** `req` as the gateway forwards it with its original request target. */
const forwarded = (req: AdminRequest, target: string): AdminRequest => ({
  ...req,
  headers: new Headers([...req.headers, [ORIGINAL_URL_HEADER, target]]),
});

function screenContext(req: AdminRequest, route: string, reply: FakeReply): Ctx {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [route]: reply }) });
}

/** The calls the screen made to strategies-content, beside the shell's own prompt read. */
const contentCalls = (ctx: Ctx) =>
  ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && !call.path.endsWith('/header-prompts'));

/** The CSRF contexts of each identity token request, in call order. */
const csrfRequests = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity')
    .map((call) => (call.json as { contexts: unknown }).contexts);

/** The controller step, load and render, as the page handler runs them; throws when the step redirects. */
async function viewOf<D>(screen: PageScreen<D>, ctx: Ctx): Promise<ShellView> {
  await expect(screen.redirect?.(ctx)).resolves.toBeUndefined();
  const data = screen.load === undefined ? (undefined as D) : await screen.load(ctx);
  return screen.render(ctx, data);
}

/** The full admin document of a page answer; fails the test on a redirect. */
async function documentOf(screen: PageScreen<unknown>, ctx: Ctx): Promise<{ html: string; layout: string }> {
  const page = await renderScreenPage(screen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { html: page.html, layout: page.doc.layout };
}

const secureLocation = (req: AdminRequest): string => {
  const decision = secure(req);
  return decision.kind === 'redirect' ? decision.location : '';
};

describe.each<[string, PageScreen<never>, boolean]>([
  ['imagedetails', imagedetailsScreen as PageScreen<never>, true],
  ['multifileupload', multifileuploadScreen as PageScreen<never>, true],
  ['selectmedia', selectmediaScreen as PageScreen<never>, false],
])('cArch.%s definition and access', (action, screen, menu) => {
  it('is a frozen strategies-content page behind the carch gate', () => {
    expect(screen).toMatchObject({ circuit: 'carch', action, mode: 'page', owner: CARCH_OWNER, gate: carchGate });
    expect('secondaryMenu' in screen && screen.secondaryMenu === 'carch').toBe(menu);
    expect(Object.isFrozen(screen)).toBe(true);
  });

  it('lets qa_editor through on Site Manager access and sends a public member away before any read', async () => {
    await expect(runGate(editorRequest({ circuit: 'carch', item: action }), screen.gate)).resolves.toEqual({
      kind: 'allow',
    });
    const member = noSitesRequest({ s2IsPrivate: false }, { circuit: 'carch', item: action, rc: { siteid: SITE } });
    const ctx = makeScreenContext({ req: member, gateway: fakeGatewayClient() });
    await expect(renderScreenPage(screen, ctx)).resolves.toMatchObject({ kind: 'redirect' });
    expect(contentCalls(ctx)).toEqual([]);
  });
});

// ---- cArch.imagedetails ----

const SITE_CONFIG = {
  smallImageWidth: '80',
  smallImageHeight: '80',
  mediumImageWidth: '180',
  mediumImageHeight: '120',
  largeImageWidth: '600',
  largeImageHeight: 'AUTO',
  hasLockableNodes: 0,
};
const CUSTOM_SIZES = [
  { name: 'Hero', height: '400', width: '1200' },
  { name: 'Thumb', height: 'AUTO', width: '150' },
];

const cacheUrl = (fileId: string, size: string): string => `/${SITE}/cache/file/${fileId}_${size}.jpg`;

/** One `files` row: the source image, its meta filename, its image info and the rendition URLs by size. */
const fileRow = (fileID: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  fileID,
  sourceImage: cacheUrl(fileID, 'source'),
  filename: 'beach & sun.jpg',
  sourceImageInfo: { 'Image Height': '1200 pixels', 'Image Width': '1600 pixels' },
  urls: { small: cacheUrl(fileID, 'small'), medium: cacheUrl(fileID, 'medium'), large: cacheUrl(fileID, 'large') },
  ...overrides,
});

/** `rc.contentBean` of Home with the reads the view and its menu make. */
const HOME_BEAN = {
  contentID: HOME,
  contentHistID: HOME_HIST,
  type: 'Page',
  subType: 'Default',
  active: 1,
  isNew: 0,
  filename: '',
  parentID: END,
  menuTitle: 'Home',
  remoteURL: '',
  fileID: FILE_A,
  stats: { lockID: '', lockType: '' },
  editUrl: HOME_EDIT_URL,
  url: 'http://localhost/',
  crumbArray: [HOME_CRUMB],
};

const imageModel = (rc: Record<string, unknown> = {}): FakeReply =>
  viewModel({ siteConfig: SITE_CONFIG, customImageSizes: CUSTOM_SIZES, files: [fileRow(FILE_A)], ...rc });

/** The S2 admin's imagedetails request for `rc`, forwarded with the request target `query` when given. */
function imageContext(rc: Record<string, string>, reply: FakeReply, query?: string): Ctx {
  const req = s2('imagedetails', { moduleid: SITE_MANAGER, ...rc });
  return screenContext(query === undefined ? req : forwarded(req, `/admin/?${query}`), IMAGE_DETAILS, reply);
}

/** The view body of the screen's steps for `ctx`, with a cheerio fragment of it. */
async function imageView(ctx: Ctx): Promise<{ body: string; $: cheerio.CheerioAPI }> {
  const body = toString((await viewOf(imagedetailsScreen, ctx)).body);
  return { body, $: cheerio.load(body, null, false) };
}

describe('cArch.imagedetails', () => {
  const versionTarget = `muraAction=cArch.imagedetails&contenthistid=${HOME_HIST}`;

  it('renders every rendition of rc.fileid with its crop, rotate and flip controls in the full layout', async () => {
    const ctx = imageContext({ fileid: FILE_A }, imageModel());
    const { html, layout } = await documentOf(imagedetailsScreen, ctx);
    expect(layout).not.toBe('compact');
    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: `/v1/sites/${SITE}/files/image-details`,
        query: { fileid: FILE_A, imagesize: '', compactDisplay: 'false' },
      }),
    ]);
    expect(csrfRequests(ctx)).toContainEqual([FILE_A]);
    expect(html).toContain('<script src="/admin/assets/js/jquery/jquery.Jcrop.min.js" type="text/javascript"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/admin/assets/css/jquery/jquery.Jcrop.min.css" type="text/css" />');

    const { body, $ } = await imageView(imageContext({ fileid: FILE_A }, imageModel()));
    expect(body).toContain(`fileMap['${FILE_A_JS}']={height:0,width:0};`);
    expect(body).toContain(`fileMap['${FILE_A_JS}'].height=1200;`);
    expect(body).toContain(`fileMap['${FILE_A_JS}'].width=1600;`);
    expect(body).toContain('<h2><i class="mi-picture-o"></i> beach &amp; sun.jpg</h2>');
    const model = fragmentModel(body);
    expect(model.headings).toEqual(['Image Details', 'beach & sun.jpg']);
    expect(model.labels).toEqual([
      'Adjust Image Orientation',
      'Small (80x80)',
      'Medium (180x120)',
      'Large (600xAUTO)',
      'Hero (1200x400)',
      'Thumb (150xAUTO)',
    ]);
    expect(model.controls[0]?.options.map((o) => [o.value, o.label])).toEqual([
      ['', 'Please Select'],
      ['90', 'Rotate Image – 90°'],
      ['180', 'Rotate Image – 180°'],
      ['270', 'Rotate Image – 270°'],
      ['horizontal', 'Flip Image – Horizontal'],
      ['vertical', 'Flip Image – Vertical'],
      ['diagonal', 'Flip Image – Diagonal'],
      ['antidiagonal', 'Flip Image – Anti-Diagonal'],
    ]);
    expect($(`#image-actions${FILE_A}`).length).toBe(1);
    expect($('input[type="button"]').attr('onclick')).toBe(`flipImage('${FILE_A_JS}');`);
    // data-ratio is width/height where both are numeric, as the view divides them.
    const ratios = $('button.cropper')
      .toArray()
      .map((el) => [$(el).attr('data-size'), $(el).attr('data-ratio'), $(el).attr('data-filename')]);
    expect(ratios).toEqual([
      ['small', '1', 'beach & sun.jpg'],
      ['medium', '1.5', 'beach & sun.jpg'],
      ['large', '', 'beach & sun.jpg'],
      ['hero', '3', 'beach & sun.jpg'],
      ['thumb', '', 'beach & sun.jpg'],
    ]);
    expect($(`#small${FILE_A}`).attr('src')).toMatch(new RegExp(`^${cacheUrl(FILE_A, 'small')}\\?cacheID=${CF_UUID}$`));
    expect($(`#small${FILE_A}`).attr('style')).toBe('max-width:80px;');
    // Custom sizes load through carch.getImageSizeURL once the page is ready.
    expect($(`#hero${FILE_A}`).attr('class')).toBe('mura-custom-image img-responsive');
    expect($(`#hero${FILE_A}`).attr('src')).toBe('');
    expect(body).toContain(`'&transpose=' + transpose + '${URL_CSRF}&cacheid='`);
    expect(body).toContain(`$.getJSON('./?muraAction=carch.getImageSizeURL&siteid=${SITE}&fileid='`);
    expect(body).toContain("var instanceid='';");
    expect(body).not.toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'})");
    expect(body).not.toContain('ui__back');
    expect(body).not.toContain('class="breadcrumb"');
    // No content bean in a full layout: the menu's Back button.
    expect(model.links).toEqual([{ href: '#', text: 'Back' }]);
  });

  it('loads the version a forwarded contentHistID names, filling an empty fileid from it', async () => {
    const reply = imageModel({ fileID: FILE_A, contentBean: HOME_BEAN, customImageSizes: [] });
    const target = `muraAction=cArch.imagedetails&siteid=${SITE}&contentHistID=${HOME_HIST}&fileid=`;
    const ctx = imageContext({ contenthistid: HOME_HIST, fileid: '' }, reply, target);
    const { body, $ } = await imageView(ctx);
    expect(contentCalls(ctx)[0]?.query).toEqual({
      fileid: '',
      contenthistid: HOME_HIST,
      imagesize: '',
      compactDisplay: 'false',
    });
    // The tokens' context is the filled fileID, so they are fetched only after the read.
    expect(ctx.gateway.calls.map((call) => call.service)).toEqual(['strategies-content', 'identity']);
    expect(csrfRequests(ctx)).toEqual([[FILE_A]]);
    expect(body).toContain(URL_CSRF);
    const links = $('a')
      .toArray()
      .map((el) => [$(el).attr('href'), $(el).text().replace(/\s+/g, ' ').trim()]);
    expect(links).toEqual([
      [HOME_EDIT_URL, 'Back to Content Form'],
      [SITE_MANAGER_URL, 'Return to Content Manager'],
      [`/admin/?muraAction=cArch.list&siteid=${SITE}&topid=${HOME}&moduleid=${SITE_MANAGER}&activeTab=0`, 'Home'],
      [`${HOME_EDIT_URL}&bigui=assoc#panel-assoc`, 'Done'],
    ]);
    expect($('ul.breadcrumb').length).toBe(1);
  });

  it.each<[string, string | null]>([
    ['the current URL', null],
    [
      'the forwarded target',
      `/admin/?muraAction=cArch.imagedetails&UserID=U1&contentHistID=${HOME_HIST}&fileid=${FILE_A}`,
    ],
  ])('reads a user file, not the version, when %s names userid', async (_case, target) => {
    const req = s2(
      'imagedetails',
      { moduleid: SITE_MANAGER, userid: 'U1', contenthistid: HOME_HIST, fileid: FILE_A },
      { currentUrl: `./?&muraAction=cArch.imagedetails&userid=U1&contentHistID=${HOME_HIST}&fileid=${FILE_A}` },
    );
    const ctx = screenContext(target === null ? req : forwarded(req, target), IMAGE_DETAILS, imageModel());
    const { body } = await imageView(ctx);
    expect(contentCalls(ctx)[0]?.query).toEqual({
      fileid: FILE_A,
      userid: 'U1',
      imagesize: '',
      compactDisplay: 'false',
    });
    expect(body).not.toContain('ui__back');
  });

  it('reads neither userid nor the version when the forwarded target carries no query', async () => {
    const req = s2('imagedetails', { moduleid: SITE_MANAGER, userid: 'U1', contenthistid: HOME_HIST, fileid: FILE_A });
    const ctx = screenContext(forwarded(req, '/admin/'), IMAGE_DETAILS, imageModel());
    await imageView(ctx);
    expect(contentCalls(ctx)[0]?.query).toEqual({ fileid: FILE_A, imagesize: '', compactDisplay: 'false' });
  });

  it('drops the menu and breadcrumb in a compact display and sizes the front-end modal', async () => {
    const reply = imageModel({ fileID: FILE_A, contentBean: HOME_BEAN });
    const target = `muraAction=cArch.imagedetails&contenthistid=${HOME_HIST}&compactDisplay=true`;
    const rc = { contenthistid: HOME_HIST, compactDisplay: 'true', instanceid: "x'1" };
    const page = await documentOf(imagedetailsScreen, imageContext(rc, reply, target));
    expect(page.layout).toBe('compact');
    const { body } = await imageView(imageContext(rc, reply, target));
    expect(body).not.toContain('nav-module-specific');
    expect(body).not.toContain('class="breadcrumb"');
    expect(body).toContain(`<a class="ui__back" href="${HOME_EDIT_URL}&bigui=assoc#panel-assoc">Done`);
    expect(body).toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'});");
    expect(body).toContain("var instanceid='x\\x271';");
  });

  it('prints only the site size rc.imagesize names, without the orientation controls', async () => {
    const { body, $ } = await imageView(imageContext({ fileid: FILE_A, imagesize: 'MEDIUM' }, imageModel()));
    expect(fragmentModel(body).labels).toEqual(['Medium (180x120)']);
    expect($(`#medium${FILE_A}`).attr('style')).toBe('max-width:180px');
    expect(body).toContain('data-filename="beach & sun.jpg"  data-height="120" data-width="180" data-ratio="1.5"');
    expect(body).not.toContain('image-orientation');
  });

  it('prints the custom size rc.imagesize names, its image loaded by size', async () => {
    const { body, $ } = await imageView(imageContext({ fileid: FILE_A, imagesize: 'hero' }, imageModel()));
    expect(fragmentModel(body).labels).toEqual(['Hero (1200x400)']);
    expect($(`#hero${FILE_A}`).attr('class')).toBe('mura-custom-image');
    expect($('button.cropper').attr('data-ratio')).toBe('3');
  });

  it.each<[string, { name: string; height: string; width: string }, string, string]>([
    ['both dimensions', { name: 'w300_h200', height: '200', width: '300' }, '1.5', ' width="300"  width="200"'],
    ['an AUTO height', { name: 'W300_HAUTO', height: 'AUTO', width: '300' }, '', ' width="300" \n'],
  ])('prints an ad-hoc size of a two-part rc.imagesize with %s', async (_case, customImage, ratio, sizeAttrs) => {
    const urls = { custom: `${cacheUrl(FILE_A, customImage.name)}` };
    const reply = imageModel({ customImage, files: [fileRow(FILE_A, { urls })] });
    const { body, $ } = await imageView(imageContext({ fileid: FILE_A, imagesize: customImage.name }, reply));
    const size = customImage.name.toLowerCase();
    expect(fragmentModel(body).labels).toEqual([`${customImage.name} (${customImage.width}x${customImage.height})`]);
    expect($('button.cropper-reset').attr('data-size')).toBe(size);
    expect($('button.cropper').attr('data-ratio')).toBe(ratio);
    expect($(`#${size}${FILE_A}`).attr('src')).toMatch(new RegExp(`^${urls.custom}\\?cacheID=${CF_UUID}$`));
    expect(body).toContain(sizeAttrs);
  });

  it('prints no size controls for an rc.imagesize that names no size', async () => {
    const { body, $ } = await imageView(imageContext({ fileid: FILE_A, imagesize: 'icon' }, imageModel()));
    expect(body).toContain('<h2><i class="mi-picture-o"></i> beach &amp; sun.jpg</h2>');
    expect($('button, select, img, .mura-control-group').length).toBe(0);
  });

  it('skips a file without a source image and a fileMap dimension that is not numeric', async () => {
    const files = [
      fileRow(FILE_A, { sourceImageInfo: { 'Image Height': 'n/a', 'Image Width': '1600 pixels' } }),
      fileRow(FILE_B, { sourceImage: '' }),
    ];
    const ctx = imageContext({ fileid: `${FILE_A},${FILE_B}` }, imageModel({ files }));
    const { body } = await imageView(ctx);
    // The token context is rc.fileid as sent, the whole list.
    expect(csrfRequests(ctx)).toEqual([[`${FILE_A},${FILE_B}`]]);
    expect(body).not.toContain(`fileMap['${FILE_A_JS}'].height`);
    expect(body).toContain(`fileMap['${FILE_A_JS}'].width=1600;`);
    expect(body).not.toContain(FILE_B);
    expect(body).not.toContain(FILE_B.replaceAll('-', '\\x2D'));
    expect(fragmentModel(body).headings).toEqual(['Image Details', 'beach & sun.jpg']);
  });

  it('says so when the loaded version has no image', async () => {
    const reply = imageModel({ fileID: '', contentBean: { ...HOME_BEAN, fileID: '' }, files: [] });
    const ctx = imageContext({ contenthistid: HOME_HIST }, reply, versionTarget);
    const { body } = await imageView(ctx);
    expect(body).toContain('<div class="help-block-empty">This content does not have any image attached to it.</div>');
    expect(body).not.toContain('fileMap');
    expect(csrfRequests(ctx)).toEqual([]);
  });

  it.each([401, 403])('answers a %i read with the controller secure() redirect', async (status) => {
    const ctx = imageContext({ fileid: FILE_A }, { status, body: {} });
    await expect(imagedetailsScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: secureLocation(ctx.req),
    });
    const loading = imageContext({ fileid: FILE_A }, { status, body: {} });
    await expect(imagedetailsScreen.load?.(loading)).rejects.toThrow(
      'strategies-content denied the carch.imagedetails read',
    );
  });

  it('fails the page on any other 4xx', async () => {
    const ctx = imageContext({ fileid: FILE_A }, { status: 404, body: { error: 'not found' } });
    await expect(imagedetailsScreen.redirect?.(ctx)).rejects.toThrow(
      'strategies-content rejected the carch.imagedetails read with HTTP 404',
    );
  });

  it('reads once when load follows the controller step, and reads itself when it runs alone', async () => {
    const ctx = imageContext({ fileid: FILE_A }, imageModel());
    await imagedetailsScreen.redirect?.(ctx);
    const first = await imagedetailsScreen.load?.(ctx);
    await expect(imagedetailsScreen.load?.(ctx)).resolves.toBe(first);
    expect(contentCalls(ctx)).toHaveLength(1);
    const alone = imageContext({ fileid: FILE_A }, imageModel());
    await expect(imagedetailsScreen.load?.(alone)).resolves.toMatchObject({
      fileId: FILE_A,
      customSizes: CUSTOM_SIZES,
    });
    expect(contentCalls(alone)).toHaveLength(1);
  });

  it.each<[string, Record<string, string>, Record<string, unknown>, string | undefined, string]>([
    ['no files rows', { fileid: FILE_A }, { files: undefined }, undefined, 'getImageDetailsModel returned no files rows'],
    [
      'fewer files than rc.fileid items',
      { fileid: `${FILE_A},${FILE_B}` },
      {},
      undefined,
      'getImageDetailsModel returned files that do not match rc.fileID',
    ],
    [
      'files out of rc.fileid order',
      { fileid: `${FILE_A},${FILE_B}` },
      { files: [fileRow(FILE_B), fileRow(FILE_A)] },
      undefined,
      'getImageDetailsModel returned files out of rc.fileID order',
    ],
    [
      'a file without sourceImage',
      { fileid: FILE_A },
      { files: [fileRow(FILE_A, { sourceImage: undefined })] },
      undefined,
      'getImageDetailsModel returned no sourceImage',
    ],
    [
      'image info that is not a struct',
      { fileid: FILE_A },
      { files: [fileRow(FILE_A, { sourceImageInfo: '1200x1600' })] },
      undefined,
      'getImageDetailsModel returned sourceImageInfo that is not a struct',
    ],
    [
      'no customImageSizes rows',
      { fileid: FILE_A },
      { customImageSizes: undefined },
      undefined,
      'getImageDetailsModel returned no customImageSizes rows',
    ],
    ['no rc.fileid and no version', {}, {}, undefined, 'Element FILEID is undefined in RC.'],
    [
      'a loaded version without fileID',
      { contenthistid: HOME_HIST },
      { contentBean: HOME_BEAN },
      versionTarget,
      'getImageDetailsModel returned no fileID',
    ],
  ])('throws a TypeError for a model with %s', async (_case, rc, model, target, message) => {
    const ctx = imageContext(rc, imageModel(model), target);
    await expect(imagedetailsScreen.load?.(ctx)).rejects.toThrow(new TypeError(message));
  });

  it.each<[string, Record<string, string>, Record<string, unknown>, string | undefined, Error]>([
    [
      'a rendition URL the model omits',
      { fileid: FILE_A },
      { files: [fileRow(FILE_A, { urls: { medium: 'm', large: 'l' } })] },
      undefined,
      new TypeError(`getImageDetailsModel returned no small URL for ${FILE_A}`),
    ],
    [
      'a zero site image height',
      { fileid: FILE_A },
      { siteConfig: { ...SITE_CONFIG, smallImageHeight: '0' } },
      undefined,
      new RangeError('Division by zero is not allowed.'),
    ],
    [
      'a two-part imagesize without customImage',
      { fileid: FILE_A, imagesize: 'w300_h200' },
      {},
      undefined,
      new TypeError('getImageDetailsModel returned no customImage for w300_h200'),
    ],
    [
      'a version without editUrl',
      { contenthistid: HOME_HIST, compactDisplay: 'true' },
      { fileID: FILE_A, contentBean: { ...HOME_BEAN, editUrl: undefined } },
      versionTarget,
      new TypeError('getImageDetailsModel returned no editUrl'),
    ],
  ])('fails the render for %s', async (_case, rc, model, target, error) => {
    const ctx = imageContext(rc, imageModel(model), target);
    await imagedetailsScreen.redirect?.(ctx);
    const data = await imagedetailsScreen.load?.(ctx);
    expect(() => imagedetailsScreen.render(ctx, data as never)).toThrow(error);
  });

  it('fails the menu of a loaded version when siteConfig omits hasLockableNodes, which the lock flags read', async () => {
    const siteConfig = { ...SITE_CONFIG, hasLockableNodes: undefined };
    const reply = imageModel({ fileID: FILE_A, contentBean: HOME_BEAN, siteConfig });
    const ctx = imageContext({ contenthistid: HOME_HIST }, reply, versionTarget);
    await imagedetailsScreen.redirect?.(ctx);
    const data = await imagedetailsScreen.load?.(ctx);
    expect(() => imagedetailsScreen.render(ctx, data as never)).toThrow("$.siteConfig('hasLockableNodes')");
  });
});

// ---- cArch.multifileupload ----

const UPLOAD_RC = { parentid: HOME, topid: HOME, moduleid: SITE_MANAGER, ptype: 'Page' };

const uploadModel = (rc: Record<string, unknown> = {}): FakeReply =>
  viewModel({ crumbdata: [HOME_CRUMB], perm: 'editor', rsPageCount: [{ counter: 4 }], pageLimit: 1000, ...rc });

const uploadContext = (rc: Record<string, string>, reply: FakeReply, partial: AdminRequestPartial = {}): Ctx =>
  screenContext(s2('multifileupload', { ...UPLOAD_RC, ...rc }, partial), MULTI_UPLOAD, reply);

// From the ACF 2023 oracle's cArch.multifileupload of Home in the full layout, a non-compact request.
const LEGACY_UPLOAD_HEADER = `
<div class="mura-header">
    <h1>Quick Upload</h1>

    
<div class="nav-module-specific btn-group">
\t
\t\t\t\t\t
\t\t\t\t\t<a class="btn" href="#" title="Back" onclick="window.history.back(); return false;"><i class="mi-arrow-circle-left"></i> Back</a>
\t\t\t\t
</div>
<ul class="breadcrumb">
\t\t
\t\t<li class=""><strong>
\t\t<a 
\t\t\thref="/admin/?muraAction=cArch.list&siteid=default&topid=00000000000000000000000000000000001&moduleid=00000000000000000000000000000000000&activeTab=0"
\t\t><i class="mi-file"></i>Home</a></strong></li>
\t\t</ul> 
</div> <!-- /.mura-header -->
`;

const legacyUploadFields = (approved: string): string => `
      <input type="hidden" name="muraAction" value="cArch.update"/>
      <input type="hidden" name="action" value="multifileupload"/>
      <input type="hidden" name="siteid" value="default"/>
      <input type="hidden" name="moduleid" value="00000000000000000000000000000000000"/>
      <input type="hidden" name="topid" value="00000000000000000000000000000000001"/>
      <input type="hidden" name="ptype" value="Page"/>
      <input type="hidden" name="parentid" value="00000000000000000000000000000000001"/>
      <input type="hidden" name="contentid" value=""/>
      <input type="hidden" name="type" value="File"/>
      <input type="hidden" name="subtype" value="Default"/>
      <input type="hidden" name="startrow" value="1"/>
      <input type="hidden" name="orderno" value="0"/>
      <input type="hidden" name="approved" value="${approved}" />
      ${FORM_CSRF}
    </form>`;

describe('cArch.multifileupload', () => {
  it('renders the Quick Upload form for new Files under rc.parentid as the full layout prints it', async () => {
    const ctx = uploadContext({}, uploadModel());
    const { html, layout } = await documentOf(multifileuploadScreen, ctx);
    expect(layout).not.toBe('compact');
    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({ method: 'GET', path: `/v1/sites/${SITE}/content/${HOME}/multi-file-upload` }),
    ]);
    expect(contentCalls(ctx)[0]?.query).toBeUndefined();
    expect(csrfRequests(ctx)).toContainEqual([`${HOME}multifileupload`]);
    expect(html).toContain(LEGACY_UPLOAD_HEADER);
    expect(html).toContain(legacyUploadFields('1'));
    expect(html).toContain('<form id="fileupload" action="/admin/" method="POST" enctype="multipart/form-data">');
    expect(html).toContain('<script src="http://blueimp.github.io/Gallery/js/blueimp-gallery.min.js"></script>');
    expect(html).toContain(
      '<link href="/admin/assets/css/jquery/jquery.fileupload-ui.css?coreversion=7.6.1" rel="stylesheet" type="text/css">',
    );
    expect(html).toContain(ctx.req.session.dateKey.script.value);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(html).not.toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'});");
  });

  it('leaves out the menu and breadcrumb and sizes the modal in a compact display', async () => {
    const ctx = uploadContext({ compactDisplay: 'true' }, uploadModel());
    const { html, layout } = await documentOf(multifileuploadScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(
      '<div class="mura-header">\n    <h1>Quick Upload</h1>\n\n    \n</div> <!-- /.mura-header -->\n\n\n<div class="block block-constrain">',
    );
    expect(html).not.toContain('nav-module-specific');
    expect(html).toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'});");
  });

  it.each([
    ['editor', '1'],
    ['Editor', '1'],
    ['author', '0'],
    ['module', '0'],
  ])('approves uploads under the %s verdict as %s', async (perm, approved) => {
    const view = await viewOf(multifileuploadScreen, uploadContext({}, uploadModel({ perm })));
    expect(toString(view.body)).toContain(`<input type="hidden" name="approved" value="${approved}" />`);
  });

  it.each<[string, number, number, string, boolean]>([
    ['offers the uploader below the page limit', 999, 1000, '', true],
    ['prints the site-full notice at the page limit', 1000, 1000, '', false],
    ['offers the uploader at the page limit for a given content id', 1000, 1000, NODE, true],
  ])('%s', async (_case, counter, pageLimit, contentid, uploadable) => {
    const ctx = uploadContext({ contentid }, uploadModel({ rsPageCount: [{ COUNTER: counter }], pageLimit }));
    const body = toString((await viewOf(multifileuploadScreen, ctx)).body);
    expect(body.includes('<form id="fileupload"')).toBe(uploadable);
    expect(body.includes("This site has reached it's maximum number of pages allowed.")).toBe(!uploadable);
    expect(csrfRequests(ctx)).toEqual(uploadable ? [[`${HOME}multifileupload`]] : []);
  });

  it('prints the site-full notice inside the block wrapper', async () => {
    const full = uploadModel({ rsPageCount: [{ counter: 5 }], pageLimit: 5 });
    const view = await viewOf(multifileuploadScreen, uploadContext({}, full));
    expect(toString(view.body)).toBe(
      '\n<div>\n\n<div class="mura-header">\n<h1>Edit Content</h1>\n</div>\n<div class="alert alert-error">\n' +
        "This site has reached it's maximum number of pages allowed. If you are a Super Admin, this can be changed in Site Settings.</div> \n" +
        '\n</div>\n\n</div> <!-- /.block-content -->\n</div> <!-- /.block-bordered -->\n</div> <!-- /.block-constrain -->\n',
    );
  });

  it.each<[string, AdminRequestPartial]>([
    ['a site that uses SSL', { site: { record: { useSSL: 1 } } }],
    ['a NULL useSSL over extranet SSL', { site: { record: { useSSL: null, ExtranetSSL: 1 } } }],
    ['an HTTPS request', { https: true }],
  ])('loads the gallery script over https for %s', async (_case, partial) => {
    const view = await viewOf(multifileuploadScreen, uploadContext({}, uploadModel(), partial));
    expect(toString(view.body)).toContain(
      '<script src="https://blueimp.github.io/Gallery/js/blueimp-gallery.min.js"></script>',
    );
  });

  it.each([401, 403])('answers a %i read with the controller secure() redirect', async (status) => {
    const ctx = uploadContext({}, { status, body: {} });
    await expect(multifileuploadScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: secureLocation(ctx.req),
    });
  });

  it('fails the page when strategies-content rejects the parent', async () => {
    const ctx = uploadContext({}, { status: 404, body: {} });
    await expect(multifileuploadScreen.redirect?.(ctx)).rejects.toThrow(
      'strategies-content rejected the carch.multifileupload read with HTTP 404',
    );
  });

  it('fails before any read without a parent, and refuses to load before its controller step', async () => {
    const ctx = uploadContext({ parentid: '' }, uploadModel());
    await expect(multifileuploadScreen.redirect?.(ctx)).rejects.toThrow(
      new TypeError('rc.parentid is empty; the strategies-content path needs a value'),
    );
    expect(contentCalls(ctx)).toEqual([]);
    await expect(multifileuploadScreen.load?.(uploadContext({}, uploadModel()))).rejects.toThrow(
      'carch.multifileupload loaded before its controller step ran',
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no crumbdata', { crumbdata: undefined }, 'getMultiFileUploadModel returned no crumbdata array of structs'],
    [
      'an rsPageCount that is not rows',
      { rsPageCount: { counter: 4 } },
      'getMultiFileUploadModel returned no rsPageCount array of structs',
    ],
    ['an rc.perm that is no node verdict', { perm: 'owner' }, "rc.perm is not a node verdict: 'owner'"],
  ])('throws a TypeError for a model with %s', async (_case, rc, message) => {
    const ctx = uploadContext({}, uploadModel(rc));
    await multifileuploadScreen.redirect?.(ctx);
    await expect(multifileuploadScreen.load?.(ctx)).rejects.toThrow(new TypeError(message));
  });
});

// ---- cArch.selectmedia ----

const IMAGE_ROWS = [
  { fileid: FILE_A, title: 'Home', contentid: HOME, imageURL: cacheUrl(FILE_A, 'small') },
  { fileid: FILE_B, title: 'Beach <b>', contentid: NODE, imageURL: cacheUrl(FILE_B, 'small') },
];

const mediaContext = (rc: Record<string, string>, reply: FakeReply): Ctx =>
  screenContext(s2('selectmedia', { compactDisplay: 'true', ...rc }), SELECT_MEDIA, reply);

/** One `image-option` as the view's query loop prints it. */
const legacyOption = (fileId: string, url: string, caption: string): string => `
\t\t\t\t\t\t <div class="image-option" style="float: left; margin: 0 10px; text-align: center" data-fileid="${fileId}">
\t\t\t\t\t\t\t <img src="${url}"/>
\t\t\t\t\t\t\t <figcaption>
\t\t\t\t\t\t\t\t ${caption}
\t\t\t\t\t\t\t </figcaption>
\t\t\t\t\t\t </div>
\t\t\t\t\t `;

// From the ACF 2023 oracle's compact cArch.selectmedia of Home, which has no image files.
const LEGACY_NO_IMAGES = `<div class="main mura-layout-row">
<div class="mura-header">
 <h1>Select Image</h1>

 
</div> <!-- /.mura-header -->

<div class="block block-constrain">
 <div class="block block-bordered">
\t\t <div class="block-content">
\t\t <div class="mura-control-group">
\t\t\t <div class="mura-control">
\t\t\t\t 
\t\t\t\t\t <div class="help-block-empty">There are currently no related images available.</div>
\t\t\t\t 
\t\t\t </div>
\t\t </div>
\t </div>
 </div>
</div>

<script>
$(function(){
 $('.image-option').click(function(){
\t //alert($('input[name="fileid"]').val())
\t //return;
\t frontEndProxy.post({
\t\t cmd:'setObjectParams',
\t\t reinit:true,
\t\t instanceid:'i1',`;

describe('cArch.selectmedia', () => {
  it('prints the no-images notice and the picker script as legacy does', async () => {
    const ctx = mediaContext({ contentid: HOME, instanceid: 'i1' }, viewModel({ rsImages: [] }));
    const { html, layout } = await documentOf(selectmediaScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(LEGACY_NO_IMAGES);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({ method: 'GET', path: `/v1/sites/${SITE}/content/images`, query: { contentid: HOME } }),
    ]);
  });

  it("captions the node's own image Current and every other by its unencoded title", async () => {
    const ctx = mediaContext({ contentid: HOME.toLowerCase(), instanceid: "i'1" }, viewModel({ rsImages: IMAGE_ROWS }));
    const body = toString((await viewOf(selectmediaScreen, ctx)).body);
    expect(body).toContain(
      legacyOption(FILE_A, cacheUrl(FILE_A, 'small'), 'Current') +
        legacyOption(FILE_B, cacheUrl(FILE_B, 'small'), 'Beach <b>'),
    );
    expect(body).toContain("instanceid:'i\\x271',");
    expect(body).not.toContain('help-block-empty');
    expect(contentCalls(ctx)).toHaveLength(1);
  });

  it('reads the image columns by case-insensitive name, NULL as empty and numbers as text', async () => {
    const rows = [{ FILEID: FILE_A, Title: null, ContentID: 42, IMAGEURL: '/i.png' }];
    const ctx = mediaContext({ contentid: HOME }, viewModel({ rsImages: rows }));
    await expect(selectmediaScreen.load?.(ctx)).resolves.toEqual({
      images: [{ fileId: FILE_A, title: '', contentId: '42', imageUrl: '/i.png' }],
    });
  });

  it.each([401, 403])('answers a %i read with the controller secure() redirect and refuses to load', async (status) => {
    const ctx = mediaContext({ contentid: HOME }, { status, body: {} });
    const location = secureLocation(ctx.req);
    await expect(selectmediaScreen.redirect?.(ctx)).resolves.toEqual({ kind: 'location', location });
    await expect(selectmediaScreen.load?.(ctx)).rejects.toThrow(
      `strategies-content denied getSelectMediaModel; redirect to ${location}`,
    );
    expect(contentCalls(ctx)).toHaveLength(1);
  });

  it('fails the load on any other 4xx', async () => {
    const ctx = mediaContext({ contentid: HOME }, { status: 400, body: {} });
    await expect(selectmediaScreen.redirect?.(ctx)).resolves.toBeUndefined();
    await expect(selectmediaScreen.load?.(ctx)).rejects.toThrow(
      'strategies-content rejected getSelectMediaModel with HTTP 400',
    );
  });

  it('fails as the view does when an ajax request leaves rc.contentid undefined', async () => {
    const ctx = mediaContext({ ajaxrequest: 'true' }, viewModel({ rsImages: [] }));
    await expect(selectmediaScreen.redirect?.(ctx)).rejects.toThrow(new TypeError('Element CONTENTID is undefined in RC.'));
    expect(contentCalls(ctx)).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ['no rsImages rows', { rows: [] }, 'getSelectMediaModel returned no rsImages rows'],
    ['a row that is not a struct', [[FILE_A]], 'getSelectMediaModel returned an rsImages row that is not a struct'],
    [
      'a complex column',
      [{ ...IMAGE_ROWS[0], title: ['Home'] }],
      'getSelectMediaModel returned an rsImages row without a simple title',
    ],
    [
      'an absent column',
      [{ fileid: FILE_A, title: 'Home', contentid: HOME }],
      'getSelectMediaModel returned an rsImages row without a simple imageURL',
    ],
  ])('throws a TypeError for a model with %s', async (_case, rsImages, message) => {
    const ctx = mediaContext({ contentid: HOME }, viewModel({ rsImages }));
    await expect(selectmediaScreen.load?.(ctx)).rejects.toThrow(new TypeError(message));
  });
});
