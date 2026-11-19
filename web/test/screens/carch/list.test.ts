// cArch.list page suite: carch/list.cfm's content-module and LEGACY cases after the carch list() controller, over the
// recorded strategies-content Site Manager tree models.
import * as cheerio from 'cheerio';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { COMPLEX_VALUE_FAULT, LegacyFaultError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { listGate, listScreen } from '@/screens/carch/list';
import { categoriesNest, type CategoryNestNode } from '@/screens/carch/partials/categories-nest';
import { draftPromptJs } from '@/screens/carch/partials/draft-prompt-js';
import { carchJs } from '@/screens/carch/partials/js';
import { scaffold } from '@/screens/carch/partials/scaffold';
import type { CarchPageModel } from '@/screens/carch/service';
import {
  CARCH_PATHS,
  CONTENT_IDS,
  carchListComponentsData,
  carchListData,
  carchListLegacyData,
} from '../../fixtures/strategies-content/carch';
import { CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';

const screen = listScreen as Required<typeof listScreen>;
const LIST = { circuit: 'cArch', item: 'list' } as const;
const TENANT = 'tenant-a';
const SITE_MANAGER = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const SCAFFOLDER = '00000000000000000000000000000000016';
const HOME = '00000000000000000000000000000000001';

type Model = CarchPageModel;
type Req = ReturnType<typeof makeAdminRequest>;
type Ctx = ReturnType<typeof makeScreenContext>;

// cArch.list reads getSiteManagerTree; the strategies-content contract names no `/carch/list` path.
const treeRoute = (siteId: string): string =>
  routeKey('GET', 'strategies-content', siteId === TENANT ? CARCH_PATHS.list : `/v1/sites/${siteId}/content/tree`);

/** `base` with `rc` values laid over a deep copy of its model. */
function variant(base: Model, rc: Readonly<Record<string, unknown>>): Model {
  const copy = structuredClone(base);
  Object.assign(copy.rc, rc);
  return copy;
}

/** A screen context whose tree read on the session site answers `reply`. */
function listContext(req: Req, reply: FakeReply = { status: 200, body: carchListData }): Ctx {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [treeRoute(req.session.siteid)]: reply }) });
}

const ok = (body: Model): FakeReply => ({ status: 200, body });

/** The tree reads the screen sent to strategies-content. */
const treeCalls = (ctx: Ctx) =>
  ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && call.path.endsWith('/content/tree'));

/** The page inside the shell: its masked DOM model, serialized document and cheerio view. */
async function page(ctx: Ctx): Promise<{ model: DomModel; html: string; $: cheerio.CheerioAPI }> {
  const model = await renderScreenModel(listScreen, ctx);
  const rendered = await renderScreenPage(listScreen, ctx);
  if (rendered.kind !== 'document') throw new Error(`redirected to ${rendered.location}`);
  return { model, html: rendered.html, $: cheerio.load(rendered.html) };
}

/** The view after the controller step, as the page handler renders it. */
async function view(ctx: Ctx) {
  expect(await screen.redirect(ctx)).toBeUndefined();
  return screen.render(ctx, await screen.load(ctx));
}

const viewTabs = (model: DomModel) => model.links.filter((link) => link.href.startsWith('#tab'));

/** `[data-moduleid, active]` of each `#arch-mod` button. */
const moduleButtons = ($: cheerio.CheerioAPI): Array<[string | undefined, boolean]> =>
  $('#arch-mod a.site-manager-mod')
    .toArray()
    .map((a) => [$(a).attr('data-moduleid'), $(a).hasClass('active')]);

const templateIds = (body: string): string[] => [...body.matchAll(/<template id="([^"]+)"/g)].map((m) => m[1] ?? '');

/** How many scaffolder permission buttons link to cPerm.module for `siteId`. */
function permissionLinks(body: string, siteId: string): number {
  const href = `href="./?muraAction=cPerm.module&contentid=${SCAFFOLDER}&siteid=${siteId}&moduleid=${SCAFFOLDER}"`;
  return body.split(href).length - 1;
}

/** qa_editor granted the scaffolder module beside Site Manager, but administering no site. */
const scaffolderEditor = (): Req =>
  makeAdminRequest(
    { ...LIST, user: { roles: [Roles.systemUser, moduleRole(SITE_MANAGER), moduleRole(SCAFFOLDER)] } },
    'qaEditor',
  );

const SCAFFOLD_TEMPLATES = [
  'scaffold-crumb-template',
  'scaffold-error-template',
  'scaffold-all-template',
  'scaffold-list-template',
  'scaffold-form-template',
  'scaffold-related-one',
  'scaffold-related-many-one',
  'scaffold-related-many',
  'scaffold-field-text-readonly',
  'scaffold-field-text',
  'scaffold-field-htmleditor',
  'scaffold-field-textarea',
  'scaffold-field-checkbox',
  'scaffold-field-dropdown',
  'scaffold-field-radio',
  'scaffold-field-file',
];

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('cArch.list definition and access', () => {
  it('is the frozen strategies-content Site Manager page with the carch secondary menu', () => {
    expect(listScreen).toMatchObject({
      circuit: 'carch',
      action: 'list',
      owner: 'strategies-content',
      mode: 'page',
      gate: listGate,
      secondaryMenu: 'carch',
    });
    expect(listScreen.owner).toBe(CARCH_OWNER);
    expect(Object.isFrozen(listScreen)).toBe(true);
  });

  it.each<[string, () => Req]>([
    ['an anonymous request', () => anonymousRequest(LIST)],
    ['a tenant-a system user', () => makeAdminRequest({ ...LIST, session: { siteid: TENANT } }, 'systemUser')],
    ['qa_editor with Site Manager', () => editorRequest(LIST)],
    ['the tenant-a site admin on tenant-a', () => siteAdminRequest(TENANT, { ...LIST, rc: { siteid: TENANT } })],
    ['the tenant-a site admin on default', () => siteAdminRequest(TENANT, { ...LIST, rc: { siteid: 'default' } })],
  ])('answers as carchGate for %s, which holds no S2 membership', async (_case, request) => {
    const req = request();
    const helpers = { secure: () => secure(req) };

    expect(req.session.mura.memberships ?? '').not.toMatch(/(^|,)S2(,|$)/);
    expect(await screen.gate(req, helpers)).toEqual(await carchGate(req, helpers));
  });

  it('sends an anonymous request to the login form before any strategies-content read', async () => {
    const ctx = listContext(anonymousRequest(LIST));

    expect(await renderScreenPage(listScreen, ctx)).toEqual({
      kind: 'redirect',
      location:
        './?muraAction=cLogin.main&returnURL=http%3A%2F%2Flocalhost%2Fadmin%2F%3F%26muraAction%3DcArch.list' +
        '&compactDisplay=false',
    });
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([]);
  });

  it('sends a tenant-a system user without Site Manager access back to the referrer without a read', async () => {
    const req = makeAdminRequest({ ...LIST, session: { siteid: TENANT } }, 'systemUser');
    const ctx = listContext(req);

    expect(await renderScreenPage(listScreen, ctx)).toEqual({ kind: 'redirect', location: './' });
    expect(treeCalls(ctx)).toEqual([]);
  });

  it.each<[string, (ctx: Ctx) => void]>([
    ['refuses the connection', (ctx) => ctx.gateway.failWith()],
    ['answers 503', (ctx) => ctx.gateway.setRoute(treeRoute(TENANT), { status: 503 })],
  ])('propagates GatewayUnavailableError when the gateway %s', async (_case, fail) => {
    const ctx = listContext(siteAdminRequest(TENANT, LIST));
    fail(ctx);

    const rendered = renderScreenPage(listScreen, ctx);

    await expect(rendered).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(rendered).rejects.toMatchObject({ service: 'strategies-content' });
    await expect(screen.load(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cArch.list content modules', () => {
  it('renders the Site Manager tabs, module bar and site tree for the tenant-a site admin', async () => {
    const ctx = listContext(siteAdminRequest(TENANT, LIST));
    const { model, html, $ } = await page(ctx);
    const { context, adminDir } = legacySettings();

    expect(model.headings).toEqual(expect.arrayContaining(['Content', 'Tree View', 'List View']));
    expect(viewTabs(model)).toEqual([
      { href: '#tabArchitectural', text: 'Tree View' },
      { href: '#tabFlat', text: 'List View' },
      { href: '#tabEntities', text: 'Custom' },
    ]);
    expect($('#viewTabs a').toArray().map((a) => $(a).attr('href'))).toEqual([
      '#tabArchitectural',
      '#tabFlat',
      '#tabEntities',
    ]);
    expect($('#gridContainer').attr('class')).toBe('site-tree');
    expect(moduleButtons($)).toEqual([
      [SITE_MANAGER, true],
      [COMPONENTS, false],
      [FORMS, false],
    ]);
    expect($('#arch-mod a').toArray().map((a) => $(a).attr('title'))).toEqual(['Site', 'Components', 'Forms']);
    expect($('head script[src*="jquery-pulse.js"]').attr('src')).toBe(
      `${context}${adminDir}/assets/js/jquery/jquery-pulse.js?coreversion=7.6.1`,
    );
    expect(html).toContain('<div id="flatViewContainer">');
    expect(treeCalls(ctx)).toHaveLength(1);
    expect(treeCalls(ctx)[0]?.query).toMatchObject({ topid: HOME, moduleid: SITE_MANAGER });
  });

  it('serves the S2 admin on default from its own site tree, scaffolder permissions included', async () => {
    const ctx = listContext(adminS2Request(LIST));
    const { model, $ } = await page(ctx);
    const body = (await view(ctx)).body.value;

    expect(treeCalls(ctx)[0]?.path).toBe('/v1/sites/default/content/tree');
    expect(viewTabs(model).map((link) => link.text)).toEqual(['Tree View', 'List View', 'Custom']);
    expect($('#gridContainer').attr('class')).toBe('site-tree');
    expect(templateIds(body)).toEqual(SCAFFOLD_TEMPLATES);
    expect(permissionLinks(body, 'default')).toBe(2);
    expect(body).toContain('var IsSuperUser = 3;');
  });

  it('renders the tree and flat tabs alone for qa_editor, without module bar or Custom Entities', async () => {
    const ctx = listContext(editorRequest(LIST));
    const { model, $ } = await page(ctx);

    expect(model.headings).toEqual(expect.arrayContaining(['Content', 'Tree View', 'List View']));
    expect(viewTabs(model)).toEqual([
      { href: '#tabArchitectural', text: 'Tree View' },
      { href: '#tabFlat', text: 'List View' },
    ]);
    expect($('#tabEntities')).toHaveLength(0);
    expect($('#arch-mod')).toHaveLength(0);
    expect($('#gridContainer').attr('class')).toBe('site-tree');
  });

  // Own oracles carch-list-m0-short and carch-list-after-m99-topid.
  it.each<[string, Readonly<Record<string, string>>, Readonly<Record<string, string>>]>([
    ['0', { moduleid: '0' }, {}],
    [
      'the 36-character 099 with a topid',
      { moduleid: '000000000000000000000000000000000099', topid: SITE_MANAGER },
      // before()'s session writes, which the handler keeps through the fault.
      { moduleid: '000000000000000000000000000000000099' },
    ],
  ])(
    "fails module %s, which the view's cfcase matches only numerically, on list()'s nextN struct after the read",
    async (_label, rc, writes) => {
      const ctx = listContext(siteAdminRequest(TENANT, { ...LIST, rc }));
      const error = await screen.load(ctx).catch((caught: unknown) => caught);
      expect(error).toEqual(LegacyFaultError.fromTrace(COMPLEX_VALUE_FAULT));
      expect(error).toMatchObject({ type: 'Expression', detail: COMPLEX_VALUE_FAULT.Detail });
      expect(treeCalls(ctx)).toHaveLength(1);
      expect(ctx.req.sessionWrites).toMatchObject(writes);
    },
  );

  it('opens the Components module without the site-tree class, its button active', async () => {
    const req = siteAdminRequest(TENANT, { ...LIST, rc: { moduleid: COMPONENTS } });
    const ctx = listContext(req, ok(carchListComponentsData));
    const { model, $, html } = await page(ctx);

    expect(treeCalls(ctx)[0]?.query).toMatchObject({ topid: COMPONENTS, moduleid: COMPONENTS });
    expect($('#gridContainer')).toHaveLength(1);
    expect($('#gridContainer').attr('class')).toBeUndefined();
    expect(moduleButtons($)).toEqual([
      [SITE_MANAGER, false],
      [COMPONENTS, true],
      [FORMS, false],
    ]);
    expect(viewTabs(model).map((link) => link.href)).toEqual(['#tabArchitectural', '#tabFlat', '#tabEntities']);
    expect(html).toContain(
      `siteManager.loadSiteManager('tenant\\x2Da', '${COMPONENTS}', '${COMPONENTS}', 'orderno', 'asc', 'Page', '1');`,
    );
    expect(ctx.req.sessionWrites).toMatchObject({ moduleid: COMPONENTS });
  });

  it('leaves out the Custom tab and pane when the page data turns scaffolding off', async () => {
    const siteConfig = { ...(carchListData.rc.siteConfig as object), scaffolding: false };
    const ctx = listContext(siteAdminRequest(TENANT, LIST), ok(variant(carchListData, { siteConfig })));
    const { model, $ } = await page(ctx);
    const body = (await view(ctx)).body.value;

    expect(viewTabs(model).map((link) => link.href)).toEqual(['#tabArchitectural', '#tabFlat']);
    expect($('#tabEntities')).toHaveLength(0);
    expect(templateIds(body)).toEqual([]);
  });

  it.each<[string, () => Req, string, number]>([
    ['the tenant-a site admin', () => siteAdminRequest(TENANT, LIST), TENANT, 2],
    ['qa_editor holding only the scaffolder grant', () => scaffolderEditor(), 'default', 0],
  ])('mounts the Custom Entities pane for %s with gated permission buttons', async (_case, req, siteId, links) => {
    const ctx = listContext(req(), ok(carchListData));
    const body = (await view(ctx)).body.value;

    expect(body).toContain(`<div id="tabEntities" class="tab-pane">`);
    expect(body).toContain(scaffold(ctx, { siteId }).value);
    expect(templateIds(body)).toEqual(SCAFFOLD_TEMPLATES);
    expect(permissionLinks(body, siteId)).toBe(links);
  });

  it.each<[string, AdminRequestPartial, Readonly<Record<string, unknown>>, string]>([
    ['the stored flat-view tab without a URL activetab', {}, { tab: '2' }, 'initSiteManagerTabContent(2);'],
    [
      'rc.activeTab when the URL names activetab',
      { currentUrl: './?muraAction=cArch.list&activetab=1', rc: { activeTab: '1' } },
      { tab: '2' },
      'initSiteManagerTabContent(1);',
    ],
    [
      'the tree tab when the URL names moduleid without activetab',
      { currentUrl: `./?muraAction=cArch.list&moduleid=${SITE_MANAGER}`, rc: { moduleid: SITE_MANAGER } },
      { tab: '2' },
      'initSiteManagerTabContent(0);',
    ],
  ])('opens %s', async (_case, partial, flat, call) => {
    const flatViewArgs = { ...(carchListData.rc.flatViewArgs as object), ...flat };
    const req = siteAdminRequest(TENANT, { ...LIST, ...partial });
    const ctx = listContext(req, ok(variant(carchListData, { flatViewArgs })));
    const body = (await view(ctx)).body.value;

    expect(body).toContain('function initSiteManagerTabContent(index){');
    expect(body).toContain(`jQuery(document).ready(function(){\n\t\t\t\t\t\n\t\t\t\t\t\t${call}\n`);
  });

  it.each<[string, AdminRequestPartial, unknown, string]>([
    ['the stored flat-view tab without a URL activeTab', {}, '1', '1'],
    [
      'the URL activeTab over the stored flat-view tab',
      { currentUrl: './?muraAction=cArch.list&activeTab=0', rc: { activeTab: '0' } },
      '1',
      '0',
    ],
    ['the flat-view tab default when the session stores none', {}, 0, '0'],
  ])('prints %s as the layout head activetab', async (_case, partial, tab, printed) => {
    const flatViewArgs = { ...(carchListData.rc.flatViewArgs as object), tab };
    const req = siteAdminRequest(TENANT, { ...LIST, ...partial });
    const { html } = await page(listContext(req, ok(variant(carchListData, { flatViewArgs }))));

    expect(html).toContain(`\n\tvar activetab=${printed};\n`);
  });

  it('closes the body with the draft prompt script', async () => {
    const ctx = listContext(siteAdminRequest(TENANT, LIST));
    const body = (await view(ctx)).body.value;

    expect(body.endsWith(draftPromptJs(ctx).value)).toBe(true);
    expect(body).toContain('$(function(){\n\tinitDraftPrompt();\n});');
    expect(body).toContain("function initDraftPrompt(){\n\t$('a.draftprompt').click(draftprompt);\n}");
  });

  it('returns the js.cfm ajax block and the jquery-pulse cfhtmlhead', async () => {
    const ctx = listContext(siteAdminRequest(TENANT, LIST));
    const shell = await view(ctx);
    const { context, adminDir } = legacySettings();
    const src = `${context}${adminDir}/assets/js/jquery/jquery-pulse.js?coreversion=7.6.1`;

    expect(shell.ajax?.value).toBe(carchJs(ctx, 'list').value);
    expect(shell.htmlHead?.value).toContain(`<script src="${src}" type="text/javascript"></script>`);
  });

  it('relays the in-view sort fields unchanged in the one tree read, before rendering', async () => {
    const sort = {
      orderperm: 'editor',
      sorted: 'true',
      orderid: `${CONTENT_IDS.aboutUs},${CONTENT_IDS.news}`,
      sortBy: 'orderno',
      sortDirection: 'asc',
    };
    const ctx = listContext(siteAdminRequest(TENANT, { ...LIST, rc: sort }));

    // strategies-content runs the view's sort write inside getSiteManagerTree, so no separate POST exists.
    expect(await screen.redirect(ctx)).toBeUndefined();
    expect(treeCalls(ctx)).toHaveLength(1);
    expect(treeCalls(ctx)[0]).toMatchObject({ method: 'GET', path: CARCH_PATHS.list, query: sort });

    await screen.render(ctx, await screen.load(ctx));
    expect(treeCalls(ctx)).toHaveLength(1);
    const writes = ctx.gateway.calls.filter((call) => call.service === 'strategies-content' && call.method !== 'GET');
    expect(writes).toEqual([]);
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['no crumb', { crumbdata: [] }],
    ['a crumb without a site id', { crumbdata: [{ ...(carchListData.rc.crumbdata as object[])[0], siteid: '' }] }],
  ])('redirects to the Site Manager root when getCrumbList finds %s', async (_case, rc) => {
    const req = siteAdminRequest(TENANT, { ...LIST, rc: { topid: 'MISSING' } });
    const ctx = listContext(req, ok(variant(carchListData, rc)));
    const location = `./?muraAction=cArch.list&siteid=${TENANT}&moduleid=${SITE_MANAGER}&topid=${HOME}`;

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location });
    await expect(renderScreenPage(listScreen, ctx)).rejects.toThrow(`The page redirect step fires (to ${location})`);
  });
});

// ---- LEGACY module ----

const LEGACY_RC = { ajaxrequest: 'true', moduleid: 'LEGACY', startrow: '1', parentid: COMPONENTS, locking: 'false' };

/** The ajax request `make` builds for the LEGACY case, with `rc` laid over its grid values. */
const legacyRequest = (make: (partial: AdminRequestPartial) => Req, rc: Readonly<Record<string, string>> = {}): Req =>
  make({ ...LIST, rc: { ...LEGACY_RC, ...rc } });

const siteAdmin = (partial: AdminRequestPartial): Req => siteAdminRequest(TENANT, partial);

/** The normalised href of a LEGACY column sort link. */
const sortHref = (column: string, direction: string): string =>
  `./?muraAction=carch.list&moduleid=LEGACY&parentid=${COMPONENTS}&siteid=${TENANT}` +
  `&sortBy=${column}&sortDirection=${direction}&topid=${COMPONENTS}`;

/** Class lists of each grid row's action items. */
const actionClasses = ($: cheerio.CheerioAPI): string[][] =>
  $('tbody tr')
    .toArray()
    .map((tr) =>
      $(tr)
        .find('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class') ?? ''),
    );

describe('cArch.list LEGACY module', () => {
  it('lists the recorded rows under the Components title with the js.cfm block and no cfhtmlhead', async () => {
    const ctx = listContext(legacyRequest(siteAdmin), ok(carchListLegacyData));
    const shell = await view(ctx);
    const body = shell.body.value;
    const model = fragmentModel(body);

    expect(treeCalls(ctx)[0]?.query).toMatchObject({ moduleid: 'LEGACY', parentid: COMPONENTS, startrow: '1' });
    expect(model.headings).toEqual(['Components', 'Advanced Filters']);
    expect(model.tables).toEqual([
      {
        headers: ['Title', 'Display', 'Updated', ''],
        rows: [
          ['Home Banner', 'Yes', '10/302/2026 2:05:00 PM', ''],
          ['Contact Us Form', '6/30/26 - 10/29/26', '06/181/2026 9:15:00 AM', ''],
        ],
      },
    ]);
    expect(actionClasses(cheerio.load(body, null, false))).toEqual([
      ['edit', 'version-history', 'permissions', 'delete'],
      ['edit disabled', 'version-history', 'permissions', 'delete disabled'],
    ]);
    expect(shell.ajax?.value).toBe(carchJs(ctx, 'list').value);
    expect(shell.htmlHead).toBeUndefined();
    expect(body).toContain(draftPromptJs(ctx).value);
  });

  it.each<[string, Readonly<Record<string, string>>, Record<string, string>]>([
    ['by menu title', {}, { title: 'asc', display: 'asc', lastUpdate: 'desc' }],
    [
      'by title ascending',
      { sortBy: 'title', sortDirection: 'asc' },
      { title: 'desc', display: 'asc', lastUpdate: 'desc' },
    ],
    [
      'by last update descending',
      { sortBy: 'lastupdate', sortDirection: 'desc' },
      { title: 'asc', display: 'asc', lastUpdate: 'asc' },
    ],
  ])('links each column header to the opposite direction of the grid sorted %s', async (_case, rc, directions) => {
    const ctx = listContext(legacyRequest(siteAdmin, rc), ok(carchListLegacyData));
    const model = fragmentModel((await view(ctx)).body.value);

    expect(model.links.filter((link) => link.href.includes('sortBy='))).toEqual([
      { href: sortHref('title', directions.title ?? ''), text: 'Title' },
      { href: sortHref('display', directions.display ?? ''), text: 'Display' },
      { href: sortHref('lastUpdate', directions.lastUpdate ?? ''), text: 'Updated' },
    ]);
  });

  it('nests the page data category tree at level 0 in the filter, checking rc.categoryid', async () => {
    const categoryId = CATEGORY_IDS.topicsEvents;
    const ctx = listContext(legacyRequest(siteAdmin, { categoryid: categoryId }), ok(carchListLegacyData));
    const body = (await view(ctx)).body.value;
    const $ = cheerio.load(body, null, false);
    const tree = carchListLegacyData.rc.categories as readonly CategoryNestNode[];
    const nest = categoriesNest(ctx, { siteId: TENANT, parentId: '', nestLevel: 0, categoryId, tree }).value;
    const model = fragmentModel(body);

    expect(body).toContain(`<label>Categories</label>\n\t\t\t\t\t\t\t${nest}\n\t\t\t\t\t\t</div>`);
    expect($('#mura-list-tree > ul').attr('id')).toBe('mura-nodes');
    expect($('#mura-list-tree > ul').attr('class')).toBe('categories checkboxTree');
    expect($('#mura-list-tree ul ul').toArray().map((ul) => $(ul).attr('class'))).toEqual(['categories', 'categories']);
    const boxes = model.controls.filter((control) => control.name === 'categoryID');

    expect(boxes.map((control) => [control.value, control.checked])).toEqual([
      [CATEGORY_IDS.topics, false],
      [CATEGORY_IDS.topicsNews, false],
      [CATEGORY_IDS.topicsEvents, true],
      [CATEGORY_IDS.topicsEventsLocal, false],
    ]);
    expect(model.buttons).toEqual([
      { text: 'Filter', type: 'submit', hasOnclick: false },
      { text: 'Remove Filter', type: 'button', hasOnclick: true },
    ]);
  });

  it('prints no permissions items for qa_editor, who neither administers the site nor holds S2', async () => {
    const ctx = listContext(legacyRequest(editorRequest), ok(carchListLegacyData));
    const body = (await view(ctx)).body.value;

    expect(treeCalls(ctx)[0]?.path).toBe('/v1/sites/default/content/tree');
    expect(actionClasses(cheerio.load(body, null, false))).toEqual([
      ['edit', 'version-history', 'delete'],
      ['edit disabled', 'version-history', 'delete disabled'],
    ]);
  });
});

// ---- Unregistered sites ----

describe('cArch.list on a site identity does not register', () => {
  const NO_SITE = 'nosuchsite';
  const VARIATIONS = '00000000000000000000000000000000099';
  const S2_MEMBERSHIPS = 'S2IsPrivate;default,S2IsPrivate,S2';
  const LISTED_SITES = ['default', TENANT];

  /** The admin on `siteid` under the role-less token identity mints for it, its session listing registered sites. */
  const adminOn = (siteid: string, partial: AdminRequestPartial = {}): Req =>
    makeAdminRequest(
      {
        ...LIST,
        ...partial,
        rc: { siteid, ...partial.rc },
        user: { site: siteid, roles: [], s2: false },
        session: { siteArray: LISTED_SITES, mura: { memberships: S2_MEMBERSHIPS }, ...partial.session },
      },
      'admin',
    );

  /** A screen context whose tree read on `siteId` answers `reply`. */
  const siteContext = (req: Req, siteId: string, reply: FakeReply): Ctx =>
    makeScreenContext({ req, gateway: fakeGatewayClient({ [treeRoute(siteId)]: reply }) });

  it.each([
    ['admits', S2_MEMBERSHIPS, true],
    ['refuses', 'S2IsPrivate;default,S2IsPrivate', false],
    ['refuses, matching S2 case-sensitively,', 'S2IsPrivate;default,S2IsPrivate,s2', false],
  ])('%s the role-less token at the list gate by the session memberships %j', async (_verb, memberships, allowed) => {
    const req = adminOn(NO_SITE, { session: { mura: { memberships } } });
    const helpers = { secure: () => secure(req) };

    expect([req.isS2, req.modulePerm(SITE_MANAGER)]).toEqual([false, false]);
    expect(await screen.gate(req, helpers)).toEqual(allowed ? { kind: 'allow' } : secure(req));
    expect(await carchGate(req, helpers)).toEqual(secure(req));
  });

  it.each([
    ['Site Manager', SITE_MANAGER, HOME],
    ['Components', COMPONENTS, COMPONENTS],
    ['Forms', FORMS, FORMS],
    ['Variations', VARIATIONS, VARIATIONS],
  ])('sends an S2 member in the %s module to the root list without a tree read', async (_m, moduleid, top) => {
    const ctx = siteContext(adminOn(NO_SITE, { rc: { moduleid } }), NO_SITE, { status: 403 });
    const location = `./?muraAction=cArch.list&siteid=${NO_SITE}&moduleid=${SITE_MANAGER}&topid=${HOME}`;

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location });
    await expect(renderScreenPage(listScreen, ctx)).rejects.toThrow(`The page redirect step fires (to ${location})`);
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([]);
    expect(ctx.req.sessionWrites.moduleTopIds).toMatchObject({ [moduleid]: top });
  });

  it('records the view session writes of the request carrying nextN and URL keywords before redirecting', async () => {
    const currentUrl = `./?muraAction=cArch.list&siteid=${NO_SITE}&nextN=50&keywords=news`;
    const req = adminOn(NO_SITE, { currentUrl, rc: { nextN: '50', keywords: 'news' } });
    const ctx = siteContext(req, NO_SITE, { status: 403 });

    expect(await screen.redirect(ctx)).toMatchObject({ kind: 'location' });
    expect(ctx.req.sessionWrites).toMatchObject({
      muraValues: { nextN: '50' },
      keywords: 'news',
      moduleTopIds: { [SITE_MANAGER]: HOME, [`m${SITE_MANAGER}`]: HOME },
    });
    expect(ctx.req.session.mura).toMatchObject({ nextN: '50' });
  });

  /** list.cfm 494-573's `session.flatViewArgs[session.siteid]` defaults for a Site Manager request. */
  const FLAT_VIEW_DEFAULTS = Object.freeze({
    moduleid: SITE_MANAGER,
    sortby: 'lastupdate',
    sortdirection: 'desc',
    lockid: '',
    assignments: false,
    categoryid: '',
    tags: '',
    page: 1,
    type: '',
    subtype: '',
    report: '',
    keywords: '',
    tab: 0,
    filtered: false,
  });

  /** The redirected request on `NO_SITE` whose session stores `flatViewArgs`, with URL `keywords` when given. */
  async function flatViewRedirect(flatViewArgs: unknown, keywords?: string, rc: Readonly<Record<string, string>> = {}) {
    const query = keywords === undefined ? '' : `&keywords=${keywords}`;
    const req = adminOn(NO_SITE, {
      currentUrl: `./?muraAction=cArch.list&siteid=${NO_SITE}${query}`,
      rc: { ...rc, ...(keywords === undefined ? {} : { keywords }) },
      session: flatViewArgs === undefined ? {} : { muraValues: { flatViewArgs } },
    });
    const ctx = siteContext(req, NO_SITE, { status: 403 });

    expect(await screen.redirect(ctx)).toMatchObject({ kind: 'location' });
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([]);
    return ctx.req;
  }

  it.each([
    ['resets the page for new URL keywords', 'old', 1],
    ['keeps the page for URL keywords CFML neq finds equal', 'NEWS', 3],
  ])('%s of the session site, keeping its other values', async (_case, stored, page) => {
    const session = { default: { keywords: stored, page: 3, report: 'drafts', filtered: 'yes' } };
    const req = await flatViewRedirect(session, 'news');
    const flatViewArgs = { default: { ...FLAT_VIEW_DEFAULTS, keywords: 'news', page, report: '', filtered: 'yes' } };

    expect(req.session.mura).toMatchObject({ flatViewArgs });
    expect(req.sessionWrites.muraValues).toEqual({ flatViewArgs });
    expect(req.sessionWrites.keywords).toBe('news');
  });

  it('stores the full default struct for the session site of a session without flatViewArgs', async () => {
    const req = await flatViewRedirect(undefined);

    expect(req.sessionWrites.muraValues).toEqual({ flatViewArgs: { default: FLAT_VIEW_DEFAULTS } });
  });

  it('updates the session site entry stored under another case in place, a non-boolean filtered reset', async () => {
    const req = await flatViewRedirect({ Default: { keywords: 'old', page: 3, filtered: 'maybe' } }, 'news');

    expect(req.sessionWrites.muraValues).toEqual({
      flatViewArgs: { Default: { ...FLAT_VIEW_DEFAULTS, keywords: 'news' } },
    });
  });

  it('takes the report and its sort from a refreshFlatview request, and rc values as defaults', async () => {
    const report = { report: 'mydrafts', sortby: 'title', direction: 'asc' };
    const rc = { refreshFlatview: 'true', report: 'mydrafts', reportSortBy: 'title', reportSortDirection: 'asc' };
    const req = await flatViewRedirect(undefined, undefined, { ...rc, tags: 'news', page: '2' });

    expect(req.sessionWrites.muraValues).toEqual({
      flatViewArgs: { default: { ...FLAT_VIEW_DEFAULTS, ...report, tags: 'news', page: '2' } },
    });
  });

  it.each([
    ['without URL keywords', undefined],
    ['with the stored URL keywords', 'news'],
  ])('queues no session.mura write for flatViewArgs it leaves unchanged, %s', async (_case, keywords) => {
    const req = await flatViewRedirect({ default: { ...FLAT_VIEW_DEFAULTS, keywords: 'news', page: 3 } }, keywords);

    expect(req.sessionWrites.muraValues).toBeUndefined();
    expect(req.session.mura).toMatchObject({ flatViewArgs: { default: { keywords: 'news', page: 3 } } });
  });

  it('reads the tree of a listed site that rc.siteid names in another case', async () => {
    const ctx = siteContext(adminOn('Tenant-A'), 'Tenant-A', ok(carchListData));

    expect(await screen.redirect(ctx)).toBeUndefined();
    expect(treeCalls(ctx).map((call) => call.path)).toEqual(['/v1/sites/Tenant-A/content/tree']);
  });

  it.each<[string, AdminRequestPartial]>([
    ['the LEGACY module', { rc: LEGACY_RC }],
    ['the 36-character module id', { rc: { moduleid: '000000000000000000000000000000000099', topid: HOME } }],
    ['a session without the S2 membership', { session: { mura: { memberships: 'S2IsPrivate;default,S2IsPrivate' } } }],
  ])('leaves %s to strategies-content, whose 403 answers secure()', async (_case, partial) => {
    const ctx = siteContext(adminOn(NO_SITE, partial), NO_SITE, { status: 403 });

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location: './' });
    expect(treeCalls(ctx).map((call) => call.path)).toEqual([`/v1/sites/${NO_SITE}/content/tree`]);
  });
});
