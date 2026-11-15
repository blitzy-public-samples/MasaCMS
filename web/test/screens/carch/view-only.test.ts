// The view-only cArch screens over strategies-content models built from the recorded carch fixtures.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure } from '@/lib/access-gate';
import { encodeHtml, encodeJs, toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { carchScreens } from '@/screens/carch';
import { edittextScreen } from '@/screens/carch/edittext';
import { imagedetailsScreen } from '@/screens/carch/imagedetails';
import { lockcheckScreen } from '@/screens/carch/lockcheck';
import { closeCompactDisplay } from '@/screens/carch/partials/close-compact-display';
import { carchJs } from '@/screens/carch/partials/js';
import { relatedcontentScreen, type RelatedContentData } from '@/screens/carch/relatedcontent';
import { selectfieldsScreen, type SelectFieldsData } from '@/screens/carch/selectfields';
import { selectmediaScreen, type SelectMediaData } from '@/screens/carch/selectmedia';
import type { CarchPageModel, CarchWriteResult } from '@/screens/carch/service';
import { variationtargetingScreen } from '@/screens/carch/variationtargeting';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { USER_IDS } from '../../fixtures/session';
import {
  CONTENT_HIST_IDS,
  CONTENT_IDS,
  FILE_IDS,
  carchEditExistingPage,
  carchEditFile,
  carchHistData,
  carchListData,
} from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'tenant-a';
const WEB_PATH = `http://${SITE}.localhost:8100`;
const SITE_MANAGER = '00000000000000000000000000000000000';
const VARIATIONS = '00000000000000000000000000000000099';
const BANNER_FILE = '5C000000-000C-4000-8000000000000002';
const SESSION_USER = USER_IDS.tenantASiteAdmin;
const URL_CSRF = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;

type Ctx = ScreenContext & { gateway: FakeGatewayClient };
type Struct = Record<string, unknown>;

const sitePath = (path: string): `/v1/${string}` => `/v1/sites/${SITE}${path}`;
const contentRoute = (method: 'GET' | 'POST', path: string): string =>
  routeKey(method, 'strategies-content', sitePath(path));
const summaryPath = (hist: string): string => `/content/versions/${hist}/summary`;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

// ---- Fixture data ----

/** `value` as a struct; throws for anything else. */
function structOf(value: unknown, path: string): Struct {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} is no struct`);
  return value as Struct;
}

/** A deep copy of the struct `rc[name]` of a recorded model. */
const cloned = (model: CarchPageModel, name: string): Struct => structuredClone(structOf(model.rc[name], `rc.${name}`));

/** A deep copy of the rows `rc[name]` of a recorded model. */
function clonedRows(model: CarchPageModel, name: string): Struct[] {
  const rows = model.rc[name];
  if (!Array.isArray(rows)) throw new TypeError(`rc.${name} holds no rows`);
  return rows.map((row: unknown, i) => structuredClone(structOf(row, `rc.${name}[${i}]`)));
}

/** The string `struct[name]`; throws for anything else. */
function textOf(struct: Struct, name: string): string {
  const value = struct[name];
  if (typeof value !== 'string') throw new TypeError(`${name} is no string`);
  return value;
}

const viewModel = (model: CarchPageModel): FakeReply => ({ status: 200, body: model });

const written = (data: CarchWriteResult['data']): FakeReply => ({
  status: 200,
  body: { saved: true, errors: {}, redirect: null, data } satisfies CarchWriteResult,
});

// ---- Requests and views ----

/** The tenant-a site admin's `carch.<item>` request; its session user is the fixtures' USER_IDS entry. */
const adminReq = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest(SITE, { user: { sub: SESSION_USER }, circuit: 'carch', item, rc: { siteid: SITE, ...rc } });

/** `req` as the gateway forwards it with its original request target. */
const forwarded = (req: AdminRequest, target: string): AdminRequest => ({
  ...req,
  headers: new Headers([...req.headers, [ORIGINAL_URL_HEADER, target]]),
});

const contextOf = (req: AdminRequest, routes: Readonly<Record<string, FakeReply>> = {}): Ctx =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

/** The screen's strategies-content calls, without the shell's prompt read. */
const contentCalls = (ctx: Ctx) =>
  ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && !call.path.endsWith('/header-prompts'));

/** The CSRF contexts of each identity token request, in call order. */
const csrfContexts = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity')
    .map((call) => (call.json as { readonly contexts: unknown }).contexts);

/** The controller step, load and render, as the page handler runs them; fails when the step redirects. */
async function viewOf<D>(screen: PageScreen<D>, ctx: Ctx): Promise<ShellView> {
  await expect(Promise.resolve(screen.redirect?.(ctx))).resolves.toBeUndefined();
  const data = screen.load === undefined ? (undefined as D) : await screen.load(ctx);
  return screen.render(ctx, data);
}

const bodyOf = (view: ShellView): string => toString(view.body);
const ajaxOf = (view: ShellView): string | undefined => (view.ajax === undefined ? undefined : toString(view.ajax));
const fragment = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);
const texts = ($: cheerio.CheerioAPI, selector: string): string[] =>
  $(selector)
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim());

const VIEW_ONLY: ReadonlyArray<readonly [string, PageScreen<never>]> = [
  ['imagedetails', imagedetailsScreen as PageScreen<never>],
  ['edittext', edittextScreen as PageScreen<never>],
  ['selectfields', selectfieldsScreen as PageScreen<never>],
  ['selectmedia', selectmediaScreen as PageScreen<never>],
  ['relatedcontent', relatedcontentScreen as PageScreen<never>],
  ['variationtargeting', variationtargetingScreen as PageScreen<never>],
  ['lockcheck', lockcheckScreen as PageScreen<never>],
];

describe.each(VIEW_ONLY)('cArch.%s', (action, screen) => {
  it('is registered among carchScreens', () => {
    expect(screen.action).toBe(action);
    expect(carchScreens).toContain(screen);
  });

  it('sends an anonymous request to the controller secure() redirect before any read', async () => {
    const req = anonymousRequest({ circuit: 'carch', item: action, rc: { siteid: SITE } });
    const ctx = contextOf(req);
    const denied = secure(req);
    await expect(renderScreenPage(screen, ctx)).resolves.toEqual({
      kind: 'redirect',
      location: denied.kind === 'redirect' ? denied.location : '',
    });
    expect(contentCalls(ctx)).toEqual([]);
  });
});

// ---- cArch.imagedetails ----

const IMAGE_DETAILS = contentRoute('GET', '/files/image-details');
const SITE_SIZES = [
  ['Small', '80', '80'],
  ['Medium', '180', '120'],
  ['Large', '600', 'AUTO'],
] as const;
const CUSTOM_SIZES = [{ name: 'Hero', height: '400', width: '1200' }] as const;
const BROCHURE_EDIT_URL =
  `/admin/?muraAction=cArch.edit&contenthistid=${CONTENT_HIST_IDS.brochurePdf}&contentid=${CONTENT_IDS.brochurePdf}` +
  `&type=File&siteid=${SITE}&compactdisplay=false`;

const renditionUrl = (fileId: string, size: string): string =>
  `${WEB_PATH}/sites/${SITE}/cache/file/${fileId}_${size}.jpg`;

/** The image-details model of the brochure's file, its sizes laid over the recorded site config. */
function imageModel(extra: Struct = {}): CarchPageModel {
  const file = cloned(carchEditFile, 'contentBean');
  const fileId = textOf(file, 'fileID');
  const sizes = Object.fromEntries(
    SITE_SIZES.flatMap(([size, width, height]) => [
      [`${size.toLowerCase()}ImageWidth`, width],
      [`${size.toLowerCase()}ImageHeight`, height],
    ]),
  );
  return {
    rc: {
      siteConfig: { ...cloned(carchListData, 'siteConfig'), ...sizes },
      customImageSizes: structuredClone(CUSTOM_SIZES),
      files: [
        {
          fileID: fileId,
          sourceImage: renditionUrl(fileId, 'source'),
          filename: textOf(file, 'assocFilename'),
          sourceImageInfo: { 'Image Height': '1200 pixels', 'Image Width': '1600 pixels' },
          urls: Object.fromEntries(
            SITE_SIZES.map(([size]) => [size.toLowerCase(), renditionUrl(fileId, size.toLowerCase())]),
          ),
        },
      ],
      ...extra,
    },
  };
}

/** The crop and flip requests the view's scripts send, each from its quote to the end of its line. */
const imageActionUrls = (body: string): string[] =>
  Array.from(
    body.matchAll(/(?:\$\.get\(|url:|var url=)'\.\/index\.cfm\?muraAction=carch\.(?:cropimage|flipimage)[^\n]*/g),
    (match) => match[0],
  );

describe('cArch.imagedetails', () => {
  it('lists the page data sizes with Jcrop controls linking to the crop, flip and size actions', async () => {
    const fileId = FILE_IDS.brochurePdf;
    const ctx = contextOf(adminReq('imagedetails', { fileid: fileId, moduleid: SITE_MANAGER }), {
      [IMAGE_DETAILS]: viewModel(imageModel()),
    });
    const view = await viewOf(imagedetailsScreen, ctx);
    const body = bodyOf(view);
    const $ = fragment(body);

    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: sitePath('/files/image-details'),
        query: expect.objectContaining({ fileid: fileId, imagesize: '', compactDisplay: 'false' }),
      }),
    ]);
    const head = view.htmlHead === undefined ? '' : toString(view.htmlHead);
    expect(head).toContain('/admin/assets/js/jquery/jquery.Jcrop.min.js');
    expect(head).toContain('/admin/assets/css/jquery/jquery.Jcrop.min.css');
    expect($('#image-details').length).toBe(1);
    expect(body).toContain("$dialog.find('#crop-target').Jcrop(");
    expect(fragmentModel(body).labels).toEqual([
      ctx.rb.rbKey('sitemanager.adjustimage'),
      ...SITE_SIZES.map(([size, width, height]) => `${size} (${width}x${height})`),
      ...CUSTOM_SIZES.map(({ name, width, height }) => `${name} (${width}x${height})`),
    ]);
    for (const [size] of SITE_SIZES) {
      const lower = size.toLowerCase();
      expect($(`#${lower}${fileId}`).attr('src')?.startsWith(`${renditionUrl(fileId, lower)}?cacheID=`)).toBe(true);
    }
    expect($(`#hero${fileId}`).attr('class')).toBe('mura-custom-image img-responsive');

    const actions = imageActionUrls(body);
    expect(actions.map((url) => /carch\.(\w+)/.exec(url)?.[1])).toEqual([
      'flipimage',
      'cropimage',
      'cropimage',
      'cropimage',
    ]);
    for (const url of actions) expect(url).toContain(`${URL_CSRF}&cacheid=`);
    expect(body).toContain(`$.getJSON('./?muraAction=carch.getImageSizeURL&siteid=${SITE}&fileid='`);
    expect(csrfContexts(ctx)).toEqual([[fileId]]);

    // The imagedetails branch without a content bean: the history Back button.
    const back = $('.nav-module-specific a.btn');
    expect(back.attr('onclick')).toBe('window.history.back(); return false;');
    expect(back.text().trim()).toBe(ctx.rb.rbKey('sitemanager.back'));
    expect(ajaxOf(view)).toBeUndefined();
  });

  it('takes the file and the menu of the version a forwarded contentHistID names', async () => {
    const bean = {
      ...cloned(carchEditFile, 'contentBean'),
      editUrl: BROCHURE_EDIT_URL,
      url: `${WEB_PATH}/program-brochure/`,
      crumbArray: clonedRows(carchEditFile, 'crumbData'),
    };
    const fileId = textOf(bean, 'fileID');
    const target =
      `/admin/?muraAction=cArch.imagedetails&siteid=${SITE}&contentHistID=${CONTENT_HIST_IDS.brochurePdf}&fileid=`;
    const rc = { contenthistid: CONTENT_HIST_IDS.brochurePdf, fileid: '' };
    const req = forwarded(adminReq('imagedetails', rc), target);
    const ctx = contextOf(req, { [IMAGE_DETAILS]: viewModel(imageModel({ fileID: fileId, contentBean: bean })) });
    const $ = fragment(bodyOf(await viewOf(imagedetailsScreen, ctx)));

    expect(contentCalls(ctx)[0]?.query).toMatchObject({ fileid: '', contenthistid: CONTENT_HIST_IDS.brochurePdf });
    expect(csrfContexts(ctx)).toEqual([[fileId]]);
    const back = $('.nav-module-specific a.btn').first();
    expect(back.attr('href')).toBe(BROCHURE_EDIT_URL);
    expect(back.text().trim()).toBe(ctx.rb.rbKey('sitemanager.backtocontent'));
    expect($('ul.breadcrumb').length).toBe(1);
    expect($('a.ui__back').attr('href')).toBe(`${BROCHURE_EDIT_URL}&bigui=assoc#panel-assoc`);
  });
});

// ---- cArch.edittext ----

describe('cArch.edittext', () => {
  it('renders the inline text editor without a data call', async () => {
    const instanceId = CONTENT_IDS.homeBanner;
    const ctx = contextOf(adminReq('edittext', { compactDisplay: 'true', instanceid: instanceId }));
    const view = await viewOf(edittextScreen, ctx);
    const body = bodyOf(view);
    const $ = fragment(body);

    expect(contentCalls(ctx)).toEqual([]);
    expect(texts($, '.mura-header h1')).toEqual(['Edit Text']);
    expect($('textarea#source.htmlEditor').attr('name')).toBe('source');
    expect(texts($, 'button#updateBtn')).toEqual(['Update']);
    expect(body).toContain(`frontEndProxy.post({\n\t\t\tcmd:'setObjectParams',\n\t\t\treinit:true,`);
    expect(body).toContain(`instanceid:'${encodeJs(instanceId)}',`);
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'edittext')));
  });

  it('embeds the editor and its js.cfm script in the compact layout', async () => {
    const ctx = contextOf(adminReq('edittext', { compactDisplay: 'true' }));
    const page = await renderScreenPage(edittextScreen, ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.doc.layout).toBe('compact');
    expect(page.html).toContain('<textarea name="source" id="source" class="htmlEditor" data-width="100%"></textarea>');
    expect(page.html).toContain(toString(carchJs(ctx, 'edittext')));
  });
});

// ---- cArch.selectfields ----

const DISPLAY_FIELDS = contentRoute('GET', '/feeds/display-fields');

/** The feed lists of the recorded About Us bean. */
function recordedLists(): SelectFieldsData {
  const bean = cloned(carchEditExistingPage, 'contentBean');
  return { displayList: textOf(bean, 'displayList'), availableDisplayList: textOf(bean, 'availableDisplayList') };
}

describe('cArch.selectfields', () => {
  it('lists the available fields outside the display list, then the display list, in page-data order', async () => {
    const lists = recordedLists();
    const ctx = contextOf(adminReq('selectfields', { compactDisplay: 'true', instanceid: 'i-1' }), {
      [DISPLAY_FIELDS]: viewModel({ rc: { ...lists } }),
    });
    const view = await viewOf(selectfieldsScreen, ctx);
    const $ = fragment(bodyOf(view));
    const shown = lists.displayList.split(',');

    await expect(selectfieldsScreen.load?.(ctx)).resolves.toEqual(lists);
    expect(contentCalls(ctx).map((call) => [call.method, call.path])).toEqual([
      ['GET', sitePath('/feeds/display-fields')],
    ]);
    expect(texts($, '#availableListSort > li')).toEqual(
      lists.availableDisplayList.split(',').filter((field) => !shown.includes(field)),
    );
    expect(texts($, '#displayListSort > li')).toEqual(shown);
    expect($('input#displayList').attr('value')).toBe(lists.displayList);
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'selectfields')));
  });
});

// ---- cArch.selectmedia ----

const IMAGES = contentRoute('GET', '/content/images');

/** The image rows of the brochure node and a child banner, as `getSelectMediaModel` reports them. */
function mediaImages(): SelectMediaData['images'] {
  const file = cloned(carchEditFile, 'contentBean');
  return [
    {
      fileId: textOf(file, 'fileID'),
      title: textOf(file, 'title'),
      contentId: textOf(file, 'contentID'),
      imageUrl: renditionUrl(textOf(file, 'fileID'), 'small'),
    },
    {
      fileId: BANNER_FILE,
      title: 'Home Banner',
      contentId: CONTENT_IDS.homeBanner,
      imageUrl: renditionUrl(BANNER_FILE, 'small'),
    },
  ];
}

describe('cArch.selectmedia', () => {
  it("shows each image's small rendition, captioning the requested node's own image Current", async () => {
    const images = mediaImages();
    const rows = images.map((image) => ({
      fileid: image.fileId,
      title: image.title,
      contentid: image.contentId,
      imageURL: image.imageUrl,
    }));
    const rc = { compactDisplay: 'true', contentid: CONTENT_IDS.brochurePdf, instanceid: 'i-2' };
    const req = adminReq('selectmedia', rc);
    const ctx = contextOf(req, { [IMAGES]: viewModel({ rc: { rsImages: rows } }) });
    const view = await viewOf(selectmediaScreen, ctx);
    const $ = fragment(bodyOf(view));

    await expect(selectmediaScreen.load?.(ctx)).resolves.toEqual({ images } satisfies SelectMediaData);
    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: sitePath('/content/images'),
        query: expect.objectContaining({ contentid: CONTENT_IDS.brochurePdf }),
      }),
    ]);
    expect(texts($, '.mura-header h1')).toEqual(['Select Image']);
    const options = $('.image-option')
      .toArray()
      .map((el) => [$(el).attr('data-fileid'), $(el).find('img').attr('src'), $(el).find('figcaption').text().trim()]);
    expect(options).toEqual([
      [FILE_IDS.brochurePdf, renditionUrl(FILE_IDS.brochurePdf, 'small'), 'Current'],
      [BANNER_FILE, renditionUrl(BANNER_FILE, 'small'), 'Home Banner'],
    ]);
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'selectmedia')));
  });

  it('says so when the node has no images', async () => {
    const req = adminReq('selectmedia', { compactDisplay: 'true', contentid: CONTENT_IDS.aboutUs });
    const ctx = contextOf(req, { [IMAGES]: viewModel({ rc: { rsImages: [] } }) });
    const $ = fragment(bodyOf(await viewOf(selectmediaScreen, ctx)));
    expect(texts($, '.help-block-empty')).toEqual(['There are currently no related images available.']);
    expect($('.image-option').length).toBe(0);
  });
});

// ---- cArch.relatedcontent ----

const ABOUT_US_SUMMARY = contentRoute('GET', summaryPath(CONTENT_HIST_IDS.aboutUs));

describe('cArch.relatedcontent', () => {
  it.each<[string, Readonly<Record<string, string>>, string, string]>([
    ['no set id', {}, '', 'Select Content'],
    ['the calendar set', { relatedcontentsetid: 'calendar' }, 'calendar', 'Select Additional Calendars'],
  ])('titles the selector for %s and applies the view defaults', async (_case, rc, setId, title) => {
    const req = adminReq('relatedcontent', {
      compactDisplay: 'true',
      contenthistid: CONTENT_HIST_IDS.aboutUs,
      instanceid: 'i-3',
      items: '[]',
      ...rc,
    });
    const ctx = contextOf(req, {
      [ABOUT_US_SUMMARY]: viewModel({ rc: { contentBean: cloned(carchHistData, 'contentBean') } }),
    });
    const view = await viewOf(relatedcontentScreen, ctx);
    const body = bodyOf(view);
    const content: RelatedContentData = {
      contentId: CONTENT_IDS.aboutUs,
      contentHistId: CONTENT_HIST_IDS.aboutUs,
      type: 'Page',
      subType: 'Default',
      siteId: SITE,
    };

    await expect(relatedcontentScreen.load?.(ctx)).resolves.toEqual(content);
    expect(contentCalls(ctx).map((call) => call.path)).toEqual([sitePath(summaryPath(CONTENT_HIST_IDS.aboutUs))]);
    expect(texts(fragment(body), '.mura-header h1')).toEqual([title]);
    expect(ctx.req.rc.relatedcontentsetid).toBe(setId);
    expect(ctx.req.rc.relateditems).toBe('[]');
    expect(body).toContain(`\t\t\t\tsource:'${encodeJs(setId)}',`);
    const args = [content.contentId, content.contentHistId, content.type, content.subType, content.siteId, setId, '[]'];
    const printed = args.map((arg) => `\t\t'${encodeJs(arg)}',\n`).join('');
    expect(body).toContain(`\tsiteManager.loadRelatedContentSets(\n${printed}\t\tfalse\n\t);`);
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'relatedcontent')));
  });
});

// ---- cArch.variationtargeting ----

const TARGETING_READ = contentRoute('GET', '/variation-targeting');
const TARGETING_SAVE = contentRoute('POST', '/variation-targeting');
const INIT_JS = `Mura('.hero').addClass("mxp-editable") && 1<2`;
const TARGETING_RC = {
  compactDisplay: 'true',
  remoteid: 'PA-ABOUT-HERO',
  remoteurl: `${WEB_PATH}/about-us/?a=1&b="2"`,
  title: 'About Us <hero>',
} as const;

/** The About Us bean as the Variation node `rc.remoteid` loads, with its targeting values. */
function variationModel(): CarchPageModel {
  const bean = cloned(carchHistData, 'contentBean');
  const variation = { ...bean, type: 'Variation', moduleID: VARIATIONS, variationTargeting: { initjs: INIT_JS } };
  return { rc: { contentBean: variation } };
}

describe('cArch.variationtargeting', () => {
  it('renders the initialization-JS form with the hidden fields legacy posts', async () => {
    const ctx = contextOf(adminReq('variationtargeting', TARGETING_RC), {
      [TARGETING_READ]: viewModel(variationModel()),
    });
    const view = await viewOf(variationtargetingScreen, ctx);
    const body = bodyOf(view);
    const $ = fragment(body);
    const model = fragmentModel(body);

    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: sitePath('/variation-targeting'),
        query: expect.objectContaining({ remoteid: TARGETING_RC.remoteid }),
      }),
    ]);
    expect(model.headings).toEqual([ctx.rb.rbKey('sitemanager.content.fields.custominitjs')]);
    expect(model.alerts).toEqual([{ text: 'WARNING: For advanced user only.', className: 'alert alert-error' }]);
    expect(model.labels).toEqual(['Initalization JS']);
    expect([$('form').attr('action'), $('form').attr('method')]).toEqual(['./', 'post']);
    expect(body).toContain(`<textarea name="initjs" id="initjs" rows="10">${encodeHtml(INIT_JS)}</textarea>`);
    expect(model.controls.map((c) => [c.name, c.type, c.value])).toEqual([
      ['initjs', 'textarea', INIT_JS],
      ['siteid', 'hidden', SITE],
      ['remoteurl', 'hidden', TARGETING_RC.remoteurl],
      ['remoteid', 'hidden', TARGETING_RC.remoteid],
      ['title', 'hidden', TARGETING_RC.title],
      ['parentid', 'hidden', VARIATIONS],
      ['moduleid', 'hidden', VARIATIONS],
      ['type', 'hidden', 'Variation'],
      ['compactDisplay', 'hidden', 'true'],
      ['contentid', 'hidden', CONTENT_IDS.aboutUs],
      ['muraAction', 'hidden', 'carch.variationTargeting'],
      ['saveTargeting', 'hidden', 'true'],
    ]);
    expect(model.buttons.map((b) => [b.text, b.type])).toEqual([['Update', 'submit']]);
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'variationtargeting')));
  });

  it('posts the saved form unchanged, then answers with the compact-display close document', async () => {
    const posted = {
      ...TARGETING_RC,
      siteid: SITE,
      parentid: VARIATIONS,
      moduleid: VARIATIONS,
      type: 'Variation',
      contentid: CONTENT_IDS.aboutUs,
      saveTargeting: 'true',
      initjs: INIT_JS,
    };
    const saved = { type: 'Variation', contentid: CONTENT_IDS.aboutUs, remoteurl: TARGETING_RC.remoteurl, active: 1 };
    const ctx = contextOf(adminReq('variationtargeting', posted), { [TARGETING_SAVE]: written(saved) });
    const view = await viewOf(variationtargetingScreen, ctx);
    const body = bodyOf(view);
    const calls = contentCalls(ctx);

    expect(calls.map((call) => [call.method, call.path])).toEqual([['POST', sitePath('/variation-targeting')]]);
    expect(calls[0]?.form).toMatchObject(posted);
    expect(view.ajax).toBeUndefined();
    expect(body.startsWith('\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"')).toBe(true);
    expect(body).toContain('frontEndProxy = new Porthole.WindowProxy(');
    expect(body).toContain(`location.href="${encodeJs(TARGETING_RC.remoteurl)}";`);
    expect(body).toBe(
      closeCompactDisplay(ctx, {
        action: '',
        homeId: '',
        homeUrl: '',
        preview: '0',
        parentHistId: '',
        edited: { type: 'Variation', contentId: CONTENT_IDS.aboutUs, remoteUrl: TARGETING_RC.remoteurl, active: true },
        useLayoutManager: false,
      }),
    );
    expect(ctx.req.session.mura.objectInstanceId).toBe('');
  });
});

// ---- cArch.lockcheck ----

const LOCK_HIST = CONTENT_HIST_IDS.aboutUs;
const LOCK_SUMMARY = contentRoute('GET', summaryPath(LOCK_HIST));
const LOCK_QUERY =
  `muraAction=carch.lockcheck&siteid=${SITE}&compactDisplay=true&contenthistid=${LOCK_HIST}` +
  `&contentid=${CONTENT_IDS.aboutUs}&destAction=cArch.edit&homeid=`;
const LOCK_RC = {
  compactDisplay: 'true',
  contenthistid: LOCK_HIST,
  contentid: CONTENT_IDS.aboutUs,
  destAction: 'cArch.edit',
  homeid: '',
} as const;

/** The About Us version with its stats bean locked by `lockId` ('' unlocked). */
function lockModel(lockId: string): CarchPageModel {
  const bean = cloned(carchHistData, 'contentBean');
  const stats = { ...structOf(bean.stats, 'contentBean.stats'), lockID: lockId, lockType: lockId === '' ? '' : 'node' };
  return { rc: { contentBean: bean, stats } };
}

const lockContext = (lockId: string): Ctx =>
  contextOf(forwarded(adminReq('lockcheck', LOCK_RC), `/admin/?${LOCK_QUERY}`), {
    [LOCK_SUMMARY]: viewModel(lockModel(lockId)),
  });

describe('cArch.lockcheck', () => {
  it("sends the session user's own lock on to destAction with the original query", async () => {
    const ctx = lockContext(SESSION_USER);
    expect(ctx.req.session.mura.userID).toBe(SESSION_USER);
    await expect(lockcheckScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: `./?${LOCK_QUERY.replace('carch.lockcheck', LOCK_RC.destAction)}`,
    });
    expect(contentCalls(ctx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: sitePath(summaryPath(LOCK_HIST)) },
    ]);
  });

  it.each<[string, string]>([
    ['another user holds the lock', USER_IDS.qaEditor],
    ['the node is unlocked', ''],
  ])('prompts for the version to edit when %s', async (_case, lockId) => {
    const ctx = lockContext(lockId);
    const view = await viewOf(lockcheckScreen, ctx);
    const body = bodyOf(view);
    const $ = fragment(body);
    const draftPrompt =
      `./index.cfm?muraAction=carch.draftpromptdata&contentid=${encodeJs(CONTENT_IDS.aboutUs)}` +
      `&siteid=${encodeJs(SITE)}&targetversion=true&contenthistid=${encodeJs(LOCK_HIST)}&homeid=${encodeJs('')}`;

    expect($('#configuratorContainer').length).toBe(1);
    expect(texts($, 'h1#configuratorHeader')).toEqual([ctx.rb.rbKey('sitemanager.draftprompt.title')]);
    expect(body).toContain(`url: "${draftPrompt}",`);
    expect(body).toContain(`var href = './?${encodeJs(LOCK_QUERY)}';`);
    expect(body).toContain('actionModal(href);');
    expect(ajaxOf(view)).toBe(toString(carchJs(ctx, 'lockcheck')));
  });
});
