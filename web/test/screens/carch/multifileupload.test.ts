// cArch.multifileupload on tenant-a over the recorded strategies-content model, against carch/multifileupload.cfm.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { renderSiteFull } from '@/screens/carch/form/full';
import { multifileuploadScreen } from '@/screens/carch/multifileupload';
import { carchJs } from '@/screens/carch/partials/js';
import { dspZoom, type ZoomOptions } from '@/screens/carch/partials/zoom';
import { renderCarchSecondaryMenu } from '@/screens/carch/secondary-menu';
import { CARCH_PATHS, CONTENT_IDS, carchMultiFileUploadData } from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'tenant-a';
const PARENT = CONTENT_IDS.news;
const ROOT = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const UPLOAD_CSRF_CONTEXT = `${PARENT}multifileupload`;
const MODEL_ROUTE = routeKey('GET', 'strategies-content', CARCH_PATHS.multiFileUpload);

type Model = typeof carchMultiFileUploadData;
type Ctx = ReturnType<typeof makeScreenContext>;
type View = Awaited<ReturnType<(typeof multifileuploadScreen)['render']>>;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** `<context><adminDir>` of the installed settings. */
const adminRoot = (): string => `${legacySettings().context}${legacySettings().adminDir}`;

/** The site admin's upload request under the News folder, over a gateway serving `model` for it. */
function uploadContext(model: Model = carchMultiFileUploadData): Ctx {
  const req = siteAdminRequest(SITE, { circuit: 'carch', item: 'multifileupload', rc: { parentid: PARENT } });
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [MODEL_ROUTE]: { status: 200, body: model } }) });
}

/** The screen's controller, load and render steps, as the page handler runs them. */
async function uploadView(ctx: Ctx): Promise<View> {
  await expect(multifileuploadScreen.redirect?.(ctx)).resolves.toBeUndefined();
  const data = await multifileuploadScreen.load?.(ctx);
  if (data === undefined) throw new Error('cArch.multifileupload loaded no view data');
  return multifileuploadScreen.render(ctx, data);
}

/** The admin document of the page, parsed; fails the test on a redirect. */
async function uploadPage(ctx: Ctx): Promise<{ html: string; $: cheerio.CheerioAPI }> {
  const page = await renderScreenPage(multifileuploadScreen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { html: page.html, $: cheerio.load(page.html) };
}

/** The CSRF contexts identity was asked for, in call order. */
const csrfContexts = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly unknown[] }).contexts);

/** The screen's own strategies-content reads, beside the shell's header prompts. */
const contentReads = (ctx: Ctx) =>
  ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && !call.path.endsWith('/header-prompts'));

describe('cArch.multifileupload page', () => {
  it('reads the parent model once and posts the upload form to the admin root as multipart', async () => {
    const ctx = uploadContext();
    const { $ } = await uploadPage(ctx);
    expect(contentReads(ctx)).toEqual([expect.objectContaining({ method: 'GET', path: CARCH_PATHS.multiFileUpload })]);
    const form = $('form#fileupload');
    expect(form).toHaveLength(1);
    expect(form.attr()).toEqual({
      id: 'fileupload',
      action: `${adminRoot()}/`,
      method: 'POST',
      enctype: 'multipart/form-data',
    });
  });

  it('carries the new File fields under rc.parentid and the CSRF pair of <parentid>multifileupload', async () => {
    const ctx = uploadContext();
    const view = await uploadView(ctx);
    const $ = cheerio.load(view.body.value, null, false);
    const hidden = Object.fromEntries(
      fragmentModel($.html($('form#fileupload')))
        .controls.filter((control) => control.type === 'hidden')
        .map((control) => [control.name, control.value]),
    );
    expect(hidden).toEqual({
      muraAction: 'cArch.update',
      action: 'multifileupload',
      siteid: SITE,
      moduleid: SITE_MANAGER,
      topid: ROOT,
      ptype: 'Page',
      parentid: PARENT,
      contentid: '',
      type: 'File',
      subtype: 'Default',
      startrow: '1',
      orderno: '0',
      approved: '1',
      csrf_token: FIXED_CSRF.token,
      csrf_token_expires: FIXED_CSRF.expires,
    });
    expect(csrfContexts(ctx)).toEqual([UPLOAD_CSRF_CONTEXT]);
  });

  it('renders the drop target, button bar and progress bar, with the loading indicator commented out', async () => {
    const { $ } = await uploadPage(uploadContext());
    const form = $('form#fileupload');
    for (const selector of ['#fileupload-target', '.fileupload-buttonbar', '.fileupload-progress']) {
      expect(form.find(selector), selector).toHaveLength(1);
    }
    expect(form.find('.fileupload-buttonbar input[type="file"][name="files"][multiple]')).toHaveLength(1);
    expect($('.fileupload-loading')).toHaveLength(0);
    expect($.html(form)).toMatch(/<!--[^>]*?\n\s*<div class="fileupload-loading"><\/div>[^]*?-->/);
  });

  it.each([
    ['template-upload', 'tr.template-upload.fade'],
    ['template-download', 'tr.template-download.fade'],
  ])('ships #%s as an x-tmpl script holding its %s row', async (id, row) => {
    const { $ } = await uploadPage(uploadContext());
    const script = $(`script#${id}`);
    expect(script.attr('type')).toBe('text/x-tmpl');
    // Bare rows parse only inside a table.
    const rows = cheerio.load(`<table>${script.html() ?? ''}</table>`, null, false)(row);
    expect(rows).toHaveLength(1);
  });

  it('links the uploader stylesheet in place from the legacy admin assets', async () => {
    const { $ } = await uploadPage(uploadContext());
    const hrefs = $('head link[rel="stylesheet"]')
      .toArray()
      .map((link) => $(link).attr('href'));
    expect(hrefs).toContain(`${adminRoot()}/assets/css/jquery/jquery.fileupload-ui.css?coreversion=7.6.1`);
  });

  it('prints the Site Manager menu and the parent breadcrumb in the header', async () => {
    const ctx = uploadContext();
    const { html, $ } = await uploadPage(ctx);
    const crumbdata = carchMultiFileUploadData.rc['crumbdata'] as ZoomOptions['crumbdata'];
    expect(html).toContain(renderCarchSecondaryMenu(ctx, {}).value);
    expect(html).toContain(dspZoom(ctx, { crumbdata, class: 'breadcrumb' }).value);

    const header = $('.mura-header').has('.nav-module-specific');
    expect(header.find('h1').text()).toBe('Quick Upload');
    expect(header.find('.nav-module-specific a.btn[title="Back"]')).toHaveLength(1);
    const crumbLink = (topid: string): string =>
      `${adminRoot()}/?muraAction=cArch.list&siteid=${SITE}&topid=${topid}&moduleid=${SITE_MANAGER}&activeTab=0`;
    const crumbs = header
      .find('ul.breadcrumb li a')
      .toArray()
      .map((link) => [$(link).text(), $(link).attr('href'), $(link).parent().is('strong')]);
    expect(crumbs).toEqual([
      ['Home', crumbLink(ROOT), false],
      ['News', crumbLink(PARENT), true],
    ]);
  });

  it('shows the site-full notice instead of the uploader once the page count reaches the limit', async () => {
    const full = structuredClone(carchMultiFileUploadData);
    full.rc['rsPageCount'] = [{ counter: full.rc['pageLimit'] }];
    const ctx = uploadContext(full);
    const { html, $ } = await uploadPage(ctx);
    expect(html).toContain(`\n<div>\n\n${renderSiteFull().value}\n</div>\n`);
    expect($('h1').toArray().map((h1) => $(h1).text())).toContain('Edit Content');
    expect($('.alert.alert-error').text()).toContain("This site has reached it's maximum number of pages allowed.");
    expect($('form#fileupload')).toHaveLength(0);
    expect(csrfContexts(ctx)).not.toContain(UPLOAD_CSRF_CONTEXT);
  });

  it("hands the shell carch js.cfm's architecture script as request.ajax", async () => {
    const ctx = uploadContext();
    const view = await uploadView(ctx);
    // SafeHtml holds its markup in a private field, which toEqual does not compare.
    expect(view.ajax?.value).toBe(carchJs(ctx, 'multifileupload').value);
  });

  it('sends an anonymous user to the login form through secure() before any read', async () => {
    const req = anonymousRequest({ circuit: 'carch', item: 'multifileupload', rc: { siteid: SITE, parentid: PARENT } });
    const ctx = makeScreenContext({
      req,
      gateway: fakeGatewayClient({ [MODEL_ROUTE]: { status: 200, body: carchMultiFileUploadData } }),
    });
    const expected = secure(req);
    expect(expected.kind).toBe('redirect');
    await expect(renderScreenPage(multifileuploadScreen, ctx)).resolves.toEqual(expected);
    expect(contentReads(ctx)).toEqual([]);
  });
});
