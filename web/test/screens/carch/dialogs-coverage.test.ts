// cArch.lockcheck, cArch.relatedcontent, cArch.variationtargeting and cArch.edittext, the front-end editor dialogs,
// against their carch views (bytes captured from the ACF 2023 oracle) and the strategies-content contract.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { edittextScreen } from '@/screens/carch/edittext';
import { lockcheckScreen } from '@/screens/carch/lockcheck';
import { relatedcontentScreen, renderRelatedContentBody } from '@/screens/carch/relatedcontent';
import type { CarchPageModel, CarchWriteResult } from '@/screens/carch/service';
import { variationtargetingScreen } from '@/screens/carch/variationtargeting';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { adminS2Request, editorRequest, noSitesRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'default';
const HOME = '00000000000000000000000000000000001';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NEW_VARIATION = '5CBE6708-F623-C406-EEFD82718DA7E9A6';
const OTHER_USER = '9F8E7D6C-5B4A-4392-8170FEDCBA987654';
const CF_UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}';
const ARCHITECTURE_SCRIPT =
  '\t<script src="/admin/assets/js/architecture.min.js?coreversion=7.6.1" type="text/javascript" ></script>';

const SUMMARY_PATH = (hist: string): `/v1/${string}` => `/v1/sites/${SITE}/content/versions/${hist}/summary`;
const SUMMARY = routeKey('GET', 'strategies-content', SUMMARY_PATH(HOME_HIST));
const TARGETING_PATH = `/v1/sites/${SITE}/variation-targeting` as const;
const TARGETING_READ = routeKey('GET', 'strategies-content', TARGETING_PATH);
const TARGETING_SAVE = routeKey('POST', 'strategies-content', TARGETING_PATH);

/** `rc.contentBean` of Home as `getAllValues()` reports it, with the fields the dialogs print. */
const HOME_BEAN = { contentID: HOME, contentHistID: HOME_HIST, type: 'Page', subType: 'Default', siteID: SITE };

type Ctx = ScreenContext & { gateway: FakeGatewayClient };
type AnyScreen = PageScreen<never>;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** A 200 AdminViewModel answer with `rc`. */
const viewModel = (rc: CarchPageModel['rc']): FakeReply => ({ status: 200, body: { rc } satisfies CarchPageModel });

/** A 200 AdminWriteResult answer of a saved node. */
const written = (data: CarchWriteResult['data']): FakeReply => ({
  status: 200,
  body: { saved: true, errors: {}, redirect: null, ...(data === undefined ? {} : { data }) } satisfies CarchWriteResult,
});

/** The S2 admin's compact `carch.<item>` request, as a front-end modal opens it. */
const s2 = (item: string, rc: Record<string, string>, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'carch', item, rc: { siteid: SITE, compactDisplay: 'true', ...rc } });

/** `req` as the gateway forwards it with its original request target. */
const forwarded = (req: AdminRequest, target: string): AdminRequest => ({
  ...req,
  headers: new Headers([...req.headers, [ORIGINAL_URL_HEADER, target]]),
});

const contextOf = (req: AdminRequest, routes: Record<string, FakeReply> = {}): Ctx =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

/** The calls the screen made to strategies-content, beside the shell's own prompt read. */
const contentCalls = (ctx: Ctx) =>
  ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && !call.path.endsWith('/header-prompts'));

/** The controller step, load and render, as the page handler runs them; throws when the step redirects. */
async function viewOf(screen: AnyScreen, ctx: Ctx): Promise<ShellView> {
  await expect(screen.redirect?.(ctx)).resolves.toBeUndefined();
  const data = screen.load === undefined ? (undefined as never) : await screen.load(ctx);
  return screen.render(ctx, data);
}

const bodyOf = async (screen: AnyScreen, ctx: Ctx): Promise<string> => toString((await viewOf(screen, ctx)).body);

/** The full admin document of a page answer; fails the test on a redirect. */
async function documentOf(screen: AnyScreen, ctx: Ctx): Promise<{ html: string; layout: string }> {
  const page = await renderScreenPage(screen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { html: page.html, layout: page.doc.layout };
}

const secureLocation = (req: AdminRequest): string => {
  const decision = secure(req);
  return decision.kind === 'redirect' ? decision.location : '';
};

describe.each<[string, AnyScreen]>([
  ['lockcheck', lockcheckScreen as AnyScreen],
  ['relatedcontent', relatedcontentScreen as AnyScreen],
  ['variationtargeting', variationtargetingScreen as AnyScreen],
  ['edittext', edittextScreen as AnyScreen],
])('cArch.%s definition and access', (action, screen) => {
  it('is a frozen strategies-content page behind the carch gate', () => {
    expect(screen).toMatchObject({ circuit: 'carch', action, mode: 'page', owner: CARCH_OWNER, gate: carchGate });
    expect(Object.isFrozen(screen)).toBe(true);
  });

  it('lets qa_editor through on Site Manager access and sends a public member away before any read', async () => {
    await expect(runGate(editorRequest({ circuit: 'carch', item: action }), screen.gate)).resolves.toEqual({
      kind: 'allow',
    });
    const member = noSitesRequest({ s2IsPrivate: false }, { circuit: 'carch', item: action, rc: { siteid: SITE } });
    const ctx = contextOf(member);
    await expect(renderScreenPage(screen, ctx)).resolves.toMatchObject({ kind: 'redirect' });
    expect(contentCalls(ctx)).toEqual([]);
  });
});

// ---- cArch.lockcheck ----

const LOCK_TARGET =
  `/admin/?muraAction=cArch.lockcheck&siteid=${SITE}&compactDisplay=true&contenthistid=${HOME_HIST}` +
  `&contentid=${HOME}&destAction=cArch.edit&homeid=`;
const LOCK_RC = { contenthistid: HOME_HIST, contentid: HOME, destAction: 'cArch.edit', homeid: '' };

const lockModel = (stats: unknown): FakeReply => viewModel({ contentBean: HOME_BEAN, stats });

function lockContext(stats: unknown, target: string | null = LOCK_TARGET, rc: Record<string, string> = LOCK_RC): Ctx {
  const req = s2('lockcheck', rc);
  return contextOf(target === null ? req : forwarded(req, target), { [SUMMARY]: lockModel(stats) });
}

describe('cArch.lockcheck', () => {
  it('prompts anyone but the lock holder for the version to edit, as legacy prints the prompt', async () => {
    const ctx = lockContext({ lockID: null, lockType: null });
    const { html, layout } = await documentOf(lockcheckScreen as AnyScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(LEGACY_LOCKCHECK);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(contentCalls(ctx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: SUMMARY_PATH(HOME_HIST) },
    ]);
  });

  it.each<[string, unknown]>([
    ['another user holds the lock', { lockID: OTHER_USER }],
    ['the node is unlocked', { lockID: '' }],
    ['the stats carry no lock id', {}],
  ])('lets the prompt render when %s', async (_case, stats) => {
    await expect(lockcheckScreen.redirect?.(lockContext(stats))).resolves.toBeUndefined();
  });

  it.each<[string, string | null, string, string]>([
    [
      'the forwarded query with carch.lockcheck replaced by destAction',
      `/admin/?muraAction=carch.lockcheck&siteid=${SITE}&contenthistid=${HOME_HIST}&destAction=cArch.edit`,
      'cArch.edit',
      `./?muraAction=cArch.edit&siteid=${SITE}&contenthistid=${HOME_HIST}&destAction=cArch.edit`,
    ],
    [
      'the query unchanged where carch.lockcheck differs in case, as CFML replace() is case-sensitive',
      `/admin/?muraAction=cArch.lockCheck&contenthistid=${HOME_HIST}`,
      'cArch.edit',
      `./?muraAction=cArch.lockCheck&contenthistid=${HOME_HIST}`,
    ],
    [
      'a destAction holding $ patterns literally',
      '/admin/?muraAction=carch.lockcheck',
      "cArch.edit&x=$&$'",
      "./?muraAction=cArch.edit&x=$&$'",
    ],
    ['an empty query when the forwarded target has none', '/admin/', 'cArch.edit', './?'],
    ['the current URL when no target is forwarded', null, 'cArch.edit', './?muraAction=cArch.edit'],
  ])('sends the lock holder on to %s', async (_case, target, destAction, location) => {
    const req = s2('lockcheck', { ...LOCK_RC, destAction }, { currentUrl: './?&muraAction=carch.lockcheck' });
    // The stats bean reports the lock holder's id in its own case; CFML compares it case-insensitively.
    const holder = req.session.mura.userID.toLowerCase();
    const ctx = contextOf(target === null ? req : forwarded(req, target), {
      [SUMMARY]: viewModel({ STATS: { LOCKID: holder } }),
    });
    await expect(lockcheckScreen.redirect?.(ctx)).resolves.toEqual({ kind: 'location', location });
  });

  it('JavaScript-encodes the request values the prompt script carries', async () => {
    const rc = { ...LOCK_RC, destAction: "cArch.edit'x", homeid: '</script>' };
    const target = `/admin/?muraAction=carch.lockcheck&title=a'b`;
    const body = await bodyOf(lockcheckScreen as AnyScreen, lockContext({ lockID: '' }, target, rc));
    expect(body).toContain("\tvar href = './?muraAction\\x3Dcarch.lockcheck\\x26title\\x3Da\\x27b';");
    expect(body).toContain('&homeid=\\x3C\\x2Fscript\\x3E",');
    expect(body).toContain("href = href.replace('carch.lockcheck','cArch.edit\\x27x&locknode=' + locknode );");
  });

  it.each([401, 403])('answers a %i read with the controller secure() redirect', async (status) => {
    const req = forwarded(s2('lockcheck', LOCK_RC), LOCK_TARGET);
    const ctx = contextOf(req, { [SUMMARY]: { status, body: {} } });
    await expect(lockcheckScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: secureLocation(ctx.req),
    });
  });

  it('fails the page on any other 4xx', async () => {
    const ctx = contextOf(s2('lockcheck', LOCK_RC), { [SUMMARY]: { status: 400, body: {} } });
    await expect(lockcheckScreen.redirect?.(ctx)).rejects.toThrow(
      'strategies-content rejected the carch.lockcheck read with HTTP 400',
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'no stats',
      { contentBean: HOME_BEAN },
      'strategies-content getContentVersionModel returned no rc.stats for carch.lockcheck',
    ],
    ['a numeric lock id', { stats: { lockid: 7 } }, 'strategies-content returned a non-string rc.stats.lockid'],
  ])('throws a TypeError for a model with %s', async (_case, rc, message) => {
    const ctx = contextOf(s2('lockcheck', LOCK_RC), { [SUMMARY]: viewModel(rc) });
    await expect(lockcheckScreen.redirect?.(ctx)).rejects.toThrow(new TypeError(message));
  });
});

// ---- cArch.relatedcontent ----

const NO_RELATED_BEAN = 'strategies-content getContentVersionModel returned no rc.contentBean for carch.relatedcontent';
const RELATED_RC = { contenthistid: HOME_HIST, instanceid: 'i1', relatedcontentsetid: 'calendar', items: '[{"x":1}]' };

const relatedContext = (rc: Record<string, string>, reply: FakeReply = viewModel({ contentBean: HOME_BEAN })): Ctx =>
  contextOf(s2('relatedcontent', rc), { [SUMMARY]: reply });

/** `gateway` answering `reply` for whichever version path the call names. */
function everyVersion(gateway: FakeGatewayClient, reply: FakeReply): FakeGatewayClient {
  const facade = gateway.strategiesContent;
  const forward = facade.call as (...args: readonly unknown[]) => ReturnType<typeof facade.call>;
  const call = (...args: readonly unknown[]): ReturnType<typeof facade.call> => {
    const input = args[2] as { readonly params?: { readonly contenthistid?: string } } | undefined;
    const hist = input?.params?.contenthistid;
    if (hist !== undefined) gateway.setRoute(routeKey('GET', 'strategies-content', SUMMARY_PATH(hist)), reply);
    return forward(...args);
  };
  return { ...gateway, strategiesContent: { ...facade, call: call as unknown as typeof facade.call } };
}

describe('cArch.relatedcontent', () => {
  it('prints the additional-calendars selector of the version as legacy does', async () => {
    const ctx = relatedContext(RELATED_RC);
    const { html, layout } = await documentOf(relatedcontentScreen as AnyScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(LEGACY_RELATED_CALENDARS);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(contentCalls(ctx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: SUMMARY_PATH(HOME_HIST) },
    ]);
  });

  it("applies the view's defaults and titles any other set Select Content", async () => {
    const ctx = relatedContext({ contenthistid: HOME_HIST, items: '' });
    const body = await bodyOf(relatedcontentScreen as AnyScreen, ctx);
    expect(ctx.req.rc.relatedcontentsetid).toBe('');
    expect(ctx.req.rc.relateditems).toBe('[]');
    expect(body).toContain('\t\t<h1>Select Content</h1>');
    expect(body).toContain("\t\t\tinstanceid:'',\n\t\t\tparams:{\n\t\t\t\tsource:'',");
    expect(body).toContain(
      "\t\t'Page',\n\t\t'Default',\n\t\t'default',\n\t\t'',\n\t\t'',\n\t\tfalse\n\t);",
    );
  });

  it('keeps a set id and item list it is given over the view defaults', async () => {
    const ctx = relatedContext({ ...RELATED_RC, relatedcontentsetid: 'Calendar', relateditems: '["a"]' });
    const body = await bodyOf(relatedcontentScreen as AnyScreen, ctx);
    expect(ctx.req.rc.relateditems).toBe('["a"]');
    expect(body).toContain('<h1>Select Additional Calendars</h1>');
  });

  it('reads a fresh version id for an empty contenthistid, as an unknown version loads a new bean', async () => {
    const newBean = { contentID: '', contentHistID: '', type: 'Page', subType: 'Default', siteID: SITE };
    const gateway = everyVersion(fakeGatewayClient(), viewModel({ contentBean: newBean }));
    const ctx = makeScreenContext({ req: s2('relatedcontent', { ...RELATED_RC, contenthistid: '' }), gateway });
    const body = await bodyOf(relatedcontentScreen as AnyScreen, ctx);
    expect(contentCalls(ctx)[0]?.path).toMatch(new RegExp(`^/v1/sites/${SITE}/content/versions/${CF_UUID}/summary$`));
    expect(ctx.req.rc.contenthistid).toBe('');
    expect(body).toContain("\tsiteManager.loadRelatedContentSets(\n\t\t'',\n\t\t'',\n\t\t'Page',");
  });

  it('reads the version once for the controller step and load', async () => {
    const ctx = relatedContext(RELATED_RC);
    await relatedcontentScreen.redirect?.(ctx);
    await relatedcontentScreen.load?.(ctx);
    await relatedcontentScreen.load?.(ctx);
    expect(contentCalls(ctx)).toHaveLength(1);
  });

  it('prints bean values by case-insensitive name, NULL as empty and numbers as text', async () => {
    const bean = { CONTENTID: 42, contenthistid: null, Type: 'Folder', SUBTYPE: true, siteid: SITE };
    const ctx = relatedContext(RELATED_RC, viewModel({ contentBean: bean }));
    await expect(relatedcontentScreen.load?.(ctx)).resolves.toEqual({
      contentId: '42',
      contentHistId: '',
      type: 'Folder',
      subType: 'true',
      siteId: SITE,
    });
  });

  it('fails as the view does when rc.items is undefined', () => {
    const content = { contentId: HOME, contentHistId: HOME_HIST, type: 'Page', subType: 'Default', siteId: SITE };
    expect(() => renderRelatedContentBody({ siteid: SITE }, content)).toThrow(
      new TypeError('Element ITEMS is undefined in RC.'),
    );
  });

  it.each([401, 403])('answers a %i read with the controller secure() redirect and refuses to load', async (status) => {
    const ctx = relatedContext(RELATED_RC, { status, body: {} });
    await expect(relatedcontentScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: secureLocation(ctx.req),
    });
    await expect(relatedcontentScreen.load?.(ctx)).rejects.toThrow(
      'strategies-content denied the carch.relatedcontent read; its redirect step answers it',
    );
  });

  it('fails the load on any other 4xx', async () => {
    const ctx = relatedContext(RELATED_RC, { status: 400, body: {} });
    await expect(relatedcontentScreen.redirect?.(ctx)).resolves.toBeUndefined();
    await expect(relatedcontentScreen.load?.(ctx)).rejects.toThrow(
      'strategies-content rejected the carch.relatedcontent read with HTTP 400',
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no contentBean', {}, NO_RELATED_BEAN],
    ['a contentBean array', { contentBean: [HOME_BEAN] }, NO_RELATED_BEAN],
    [
      'a complex bean value',
      { contentBean: { ...HOME_BEAN, type: { name: 'Page' } } },
      'strategies-content getContentVersionModel returned no simple rc.contentBean.type for carch.relatedcontent',
    ],
  ])('throws a TypeError for a model with %s', async (_case, rc, message) => {
    await expect(relatedcontentScreen.load?.(relatedContext(RELATED_RC, viewModel(rc)))).rejects.toThrow(
      new TypeError(message),
    );
  });
});

// ---- cArch.variationtargeting ----

const TARGETING_RC = { remoteid: 'opt2-capture-unknown', remoteurl: 'http://localhost/x?a=1&b="2"', title: 'T <1>' };

const targetingModel = (initjs: unknown, contentid: unknown = NEW_VARIATION): FakeReply =>
  viewModel({ contentBean: { contentid, variationTargeting: { initjs } } });

const targetingContext = (rc: Record<string, string>, routes: Record<string, FakeReply>): Ctx =>
  contextOf(s2('variationtargeting', rc), routes);

describe('cArch.variationtargeting', () => {
  it("prints a new variation's initialization-JS form as legacy does", async () => {
    const ctx = targetingContext(TARGETING_RC, { [TARGETING_READ]: targetingModel('') });
    const { html, layout } = await documentOf(variationtargetingScreen as AnyScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(LEGACY_VARIATION_FORM);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(contentCalls(ctx)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: TARGETING_PATH,
        query: expect.objectContaining({ remoteid: TARGETING_RC.remoteid }),
      }),
    ]);
  });

  it.each<[string, unknown, string]>([
    ['HTML-encoded', 'a<b && "c"', 'a&lt;b &amp;&amp; &quot;c&quot;'],
    ['empty for NULL', null, ''],
    ['as text for a number', 42, '42'],
  ])('prints the saved initialization JS %s', async (_case, initjs, printed) => {
    const ctx = targetingContext(TARGETING_RC, { [TARGETING_READ]: targetingModel(initjs) });
    expect(await bodyOf(variationtargetingScreen as AnyScreen, ctx)).toContain(
      `<textarea name="initjs" id="initjs" rows="10">${printed}</textarea>`,
    );
  });

  it('saves the targeting and closes the modal on the saved variation', async () => {
    const rc = { ...TARGETING_RC, instanceid: 'inst-1', initjs: 'mura.init();', saveTargeting: 'true' };
    const saved = { type: 'Variation', contentid: NEW_VARIATION, remoteurl: TARGETING_RC.remoteurl, active: 1 };
    const ctx = targetingContext(rc, { [TARGETING_SAVE]: written(saved) });
    const view = await viewOf(variationtargetingScreen as AnyScreen, ctx);
    const calls = contentCalls(ctx);
    expect(calls.map((call) => [call.method, call.path])).toEqual([['POST', TARGETING_PATH]]);
    expect(calls[0]?.form).toMatchObject({
      initjs: 'mura.init();',
      saveTargeting: 'true',
      remoteid: TARGETING_RC.remoteid,
    });
    expect(view.ajax).toBeUndefined();
    const body = toString(view.body);
    const href = 'http\\x3A\\x2F\\x2Flocalhost\\x2Fx\\x3Fa\\x3D1\\x26b\\x3D\\x222\\x22';
    // A Variation closes on its remote URL; without the layout manager the instance id is not posted back.
    expect(body).toContain(`\n\t\tvar cmd={cmd:'setLocation',location:encodeURIComponent("${href}")};\n\t`);
    expect(body).toContain(`\t\t\tlocation.href="${href}";`);
    expect(body).toContain('<body onload="reload()">');
    expect(ctx.req.session.mura.objectInstanceId).toBe('');
  });

  it.each<[string, FakeReply, Error]>([
    [
      'no node data',
      written(undefined),
      new TypeError('strategies-content saveVariationTargeting returned no node data'),
    ],
    [
      'a node of another type',
      written({ type: 'Page', contentid: HOME, remoteurl: '', active: 1 }),
      new TypeError('strategies-content saved a Page node; carch.variationtargeting closes only Variation nodes'),
    ],
    [
      'a node without a remote URL',
      written({ type: 'Variation', contentid: NEW_VARIATION, active: 1 }),
      new TypeError('strategies-content returned no simple data.remoteurl for carch.variationtargeting'),
    ],
  ])('fails the close document of a save with %s', async (_case, reply, error) => {
    const ctx = targetingContext({ ...TARGETING_RC, saveTargeting: 'true' }, { [TARGETING_SAVE]: reply });
    await expect(variationtargetingScreen.redirect?.(ctx)).resolves.toBeUndefined();
    const data = await variationtargetingScreen.load?.(ctx);
    expect(() => variationtargetingScreen.render(ctx, data as never)).toThrow(error);
  });

  it.each<[string, string, Record<string, FakeReply>, Record<string, string>]>([
    ['read', 'GET', { [TARGETING_READ]: { status: 403, body: {} } }, {}],
    ['save', 'POST', { [TARGETING_SAVE]: { status: 401, body: {} } }, { saveTargeting: 'true' }],
  ])('answers a denied %s with the controller secure() redirect', async (_case, method, routes, extra) => {
    const ctx = targetingContext({ ...TARGETING_RC, ...extra }, routes);
    await expect(variationtargetingScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: secureLocation(ctx.req),
    });
    expect(contentCalls(ctx).map((call) => call.method)).toEqual([method]);
    await expect(variationtargetingScreen.load?.(ctx)).rejects.toThrow(
      'carch.variationtargeting loads only after its controller step',
    );
  });

  it('fails the page on a rejected read', async () => {
    const ctx = targetingContext(TARGETING_RC, { [TARGETING_READ]: { status: 400, body: { error: 'bad' } } });
    await expect(variationtargetingScreen.redirect?.(ctx)).rejects.toThrow(
      'strategies-content rejected carch.variationtargeting with HTTP 400',
    );
  });

  it.each<[string, Record<string, string>, FakeReply, string]>([
    [
      'an undefined rc.remoteurl',
      { remoteid: 'r1', title: 'T' },
      targetingModel(''),
      'Element REMOTEURL is undefined in RC.',
    ],
    [
      'a node without its targeting',
      TARGETING_RC,
      viewModel({ contentBean: { contentid: NEW_VARIATION } }),
      'strategies-content returned no rc.contentBean.variationTargeting struct for carch.variationtargeting',
    ],
    [
      'no node',
      TARGETING_RC,
      viewModel({}),
      'strategies-content returned no rc.contentBean struct for carch.variationtargeting',
    ],
    [
      'a complex initialization JS',
      TARGETING_RC,
      targetingModel(['x']),
      'strategies-content returned no simple rc.contentBean.variationTargeting.initjs for carch.variationtargeting',
    ],
  ])('fails the form render for %s', async (_case, rc, reply, message) => {
    const ctx = targetingContext(rc, { [TARGETING_READ]: reply });
    await expect(variationtargetingScreen.redirect?.(ctx)).resolves.toBeUndefined();
    const data = await variationtargetingScreen.load?.(ctx);
    expect(() => variationtargetingScreen.render(ctx, data as never)).toThrow(new TypeError(message));
  });
});

// ---- cArch.edittext ----

describe('cArch.edittext', () => {
  it('prints the inline text editor with the JavaScript-encoded instance id, as legacy does', async () => {
    const ctx = contextOf(s2('edittext', { instanceid: "a'b<c" }));
    const { html, layout } = await documentOf(edittextScreen as AnyScreen, ctx);
    expect(layout).toBe('compact');
    expect(html).toContain(LEGACY_EDITTEXT);
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(contentCalls(ctx)).toEqual([]);
  });

  it('posts an empty instance id when the request names none, as before() params it', async () => {
    const ctx = contextOf(s2('edittext', {}));
    const view = await edittextScreen.render(ctx, undefined);
    const body = toString(view.body);
    expect(body.match(/instanceid:'',/g)).toHaveLength(2);
    expect(ctx.req.rc.instanceid).toBe('');
    expect(ctx.req.rc.startrow).toBe('1');
    expect(view.ajax === undefined ? undefined : toString(view.ajax)).toBe(`\n${ARCHITECTURE_SCRIPT}\n`);
  });
});

// ---- Legacy view bytes ----

// Each view as the ACF 2023 oracle served it to the S2 admin in the compact layout, from the layout's
// `<div class="main mura-layout-row">` through the view's last `</script>`.
const LEGACY_EDITTEXT = `<div class="main mura-layout-row">
<div class="mura-header">
\t<h1>Edit Text</h1>
</div> <!-- /.mura-header -->

<div class="block block-constrain">
\t<div class="block block-bordered">
\t  \t<div class="block-content">
\t\t  \t<div class="mura-control-group">
\t\t\t\t<textarea name="source" id="source" class="htmlEditor" data-width="100%"></textarea>
\t\t\t</div>
\t\t\t<div class="mura-actions">
\t\t\t\t<div class="form-actions">
\t\t\t\t\t<button class="btn mura-primary" id="updateBtn"><i class="mi-check-circle"></i>Update</button>
\t\t\t\t</div>
\t\t\t</div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

<script>
$(function(){
\t$('#updateBtn').click(function(){

\t\tfrontEndProxy.post({
\t\t\tcmd:'setObjectParams',
\t\t\treinit:true,
\t\t\tinstanceid:'a\\x27b\\x3Cc',
\t\t\tparams:{
\t\t\t\tsource:CKEDITOR.instances['source'].getData(),
\t\t\t\trender:'client',
\t\t\t\tasync:false,
\t\t\t\tsourcetype:'custom'
\t\t\t\t}
\t\t\t});
\t});

\tfunction initConfiguratorProxy(){

\t\tfunction onFrontEndMessage(messageEvent){

\t\t\tvar parameters=messageEvent.data;

\t\t\tif (parameters["cmd"] == "setObjectParams") {

\t\t\t\tif(parameters["params"]){
\t\t\t\t\toriginParams=parameters["params"];
\t\t\t\t}

\t\t\t\t//console.log(parameters)

\t\t\t\tif(parameters["params"].sourcetype == 'custom'){}
\t\t\t\t\t$('#source').val(parameters["params"].source);
\t\t\t\t\tif(typeof CKEDITOR.instances['source'] != 'undefined'){
\t\t\t\t\t\tCKEDITOR.instances['source'].setData(parameters["params"].source);
\t\t\t\t\t}
\t\t\t\t}

\t\t}

\t\tfrontEndProxy.addEventListener(onFrontEndMessage);
\t\tfrontEndProxy.post({cmd:'setWidth',width:800});
\t\tfrontEndProxy.post({
\t\t\tcmd:'requestObjectParams',
\t\t\tinstanceid:'a\\x27b\\x3Cc',
\t\t\ttargetFrame:'modal'
\t\t\t}
\t\t);


\t}

\tif($("#ProxyIFrame").length){
\t\t$("#ProxyIFrame").load(initConfiguratorProxy);
\t} else {
\t\tinitConfiguratorProxy();
\t}

});
</script>
`;

const LEGACY_LOCKCHECK = `<div class="main mura-layout-row">
<div id="configuratorContainer">
\t<h1 id="configuratorHeader">Select Version to Edit</h1>
\t<div id="configurator">
\t<div class="load-inline"></div>
\t</div>
</div>
<script type="text/javascript">
$(function(){

\tif (top.location != self.location) {
\t\tif(jQuery("#ProxyIFrame").length){
\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\tfunction(){
\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});
\t\t\t\t}
\t\t\t);\t
\t\t} else {
\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});
\t\t}
\t}

\t$('#configuratorContainer .load-inline').spin(spinnerArgs2);

\tvar href = './?muraAction\\x3DcArch.lockcheck\\x26siteid\\x3Ddefault\\x26compactDisplay\\x3Dtrue\\x26contenthistid\\x3D6300ED69\\x2D1320\\x2D5CC3\\x2DF922E3012E2C6BAE\\x26contentid\\x3D00000000000000000000000000000000001\\x26destAction\\x3DcArch.edit\\x26homeid\\x3D';
\tvar locknode=false;

\t$.ajax({
\t\t  url: "./index.cfm?muraAction=carch.draftpromptdata&contentid=00000000000000000000000000000000001&siteid=default&targetversion=true&contenthistid=6300ED69\\x2D1320\\x2D5CC3\\x2DF922E3012E2C6BAE&homeid=",
\t\t  context: this,
\t\t  success: function(resp){

\t\t\t  if (resp.showdialog !== undefined && resp.showdialog === "true"){
\t\t\t\t
\t\t\t\t$('#configurator').html(resp.message);

\t\t\t\t$(".draft-prompt-option").click(function(e){
\t\t\t\t\te.preventDefault();
\t\t\t\t\thref = href.replace('carch.lockcheck','cArch.edit&locknode=' + locknode );
\t\t\t\t\tactionModal(href);
\t\t\t\t});

\t\t\t\t$("#locknodetoggle").on("change",function(){
\t\t\t\t\tlocknode=$(this).is(":checked");
\t\t\t\t});

\t\t\t} else {
\t\t\t\thref = href.replace('carch.lockcheck','cArch.edit&locknode=' + locknode );
\t\t\t\tactionModal(href);
\t\t\t}
\t\t}
\t});
});
</script>
`;

const LEGACY_RELATED_CALENDARS = `<div class="main mura-layout-row">

<div class="mura-header">
\t
\t\t<h1>Select Additional Calendars</h1>
\t
\t
</div> <!-- /.mura-header -->

<div class="block block-constrain">
\t<div class="block block-bordered">
\t\t<div class="block-content">
\t\t\t<div id="selectRelatedContent"></div>
\t\t\t<div id="selectedRelatedContent" class="control-group">
\t\t\t</div>
\t\t\t<input id="relatedContentSetData" type="hidden" name="relatedContentSetData" value="" />
\t\t\t<div class="mura-actions">
\t\t\t\t<div class="form-actions">
\t\t\t\t\t<button class="btn mura-primary" id="updateBtn"><i class="mi-check-circle"></i>Update</button>
\t\t\t\t</div>
\t\t\t</div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

<script>
$(function(){

\tfunction getItems(){
\t\tvar raw=$('#relatedContentSetData').val();
\t\tif(raw){
\t\t\tvar parsed=JSON.parse(raw);
\t\t\treturn parsed[0].items;
\t\t} else {
\t\t\treturn [];
\t\t}
\t}

\t$('#updateBtn').click(function(){
\t\t//alert(JSON.stringify(getItems()))
\t\t//return;
\t\tfrontEndProxy.post({
\t\t\tcmd:'setObjectParams',
\t\t\treinit:true,
\t\t\tinstanceid:'i1',
\t\t\tparams:{
\t\t\t\tsource:'calendar',
\t\t\t\tsourcetype:'relatedcontent',
\t\t\t\titems: JSON.stringify(getItems())
\t\t\t\t}
\t\t\t});
\t});

\tif($("#ProxyIFrame").length){
\t\t$("#ProxyIFrame").load(
\t\t\tfunction(){
\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t}
\t\t);
\t} else {
\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t}


\tsiteManager.loadRelatedContentSets(
\t\t'00000000000000000000000000000000001',
\t\t'6300ED69\\x2D1320\\x2D5CC3\\x2DF922E3012E2C6BAE',
\t\t'Page',
\t\t'Default',
\t\t'default',
\t\t'calendar',
\t\t'\\x5B\\x7B\\x22x\\x22\\x3A1\\x7D\\x5D',
\t\tfalse
\t);

});
</script>
`;

const LEGACY_VARIATION_FORM = `<div class="main mura-layout-row">

<div class="mura-header">
\t<h1>Custom Intialization Javascript</h1>
</div> <!-- /.mura-header -->

<div class="alert alert-error">
    WARNING: For advanced user only.
</div>

<form action="./" method="post">
<div class="block block-constrain">
\t<div class="block block-bordered">
\t\t<div class="block-content">
            <div class="mura-control-group">
    \t\t\t<label>
    \t\t\t\tInitalization JS
    \t\t\t</label>
    \t\t\t<textarea name="initjs" id="initjs" rows="10"></textarea>
    \t\t</div>
    \t\t<div class="form-actions">
    \t\t\t<button class="btn" id="updateBtn"><i class="mi-check-circle"></i>Update</button>
            </div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
\t<div class="">
\t\t<p>Example:</p>
\t\t<pre>Mura('SELECTOR').addClass('mxp-editable')</pre>
\t</div><br/>
</div> <!-- /.block-constrain -->
<input type="hidden" name="siteid" value="default">
<input type="hidden" name="remoteurl" value="http&#x3a;&#x2f;&#x2f;localhost&#x2f;x&#x3f;a&#x3d;1&amp;b&#x3d;&quot;2&quot;">
<input type="hidden" name="remoteid" value="opt2-capture-unknown">
<input type="hidden" name="title" value="T&#x20;&lt;1&gt;">
<input type="hidden" name="parentid" value="00000000000000000000000000000000099">
<input type="hidden" name="moduleid" value="00000000000000000000000000000000099">
<input type="hidden" name="type" value="Variation">
<input type="hidden" name="compactDisplay" value="true">
<input type="hidden" name="contentid" value="5CBE6708-F623-C406-EEFD82718DA7E9A6">
<input type="hidden" name="muraAction" value="carch.variationTargeting">
<input type="hidden" name="saveTargeting" value="true">
</form>

<script type="text/javascript">
jQuery(document).ready(function(){
    if (top.location != self.location) {
        if(jQuery("#ProxyIFrame").length){
            jQuery("#ProxyIFrame").load(
                function(){
                    frontEndProxy.post({cmd:'setWidth',width:'standard'});
                }
            );
        } else {
            frontEndProxy.post({cmd:'setWidth',width:'standard'});
        }
    }
});
</script>
`;
