// cArch.list page suite: carch/list.cfm's content-module and LEGACY cases after the carch list() controller, over the
// recorded strategies-content Site Manager tree models.
import * as cheerio from 'cheerio';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacySettings } from '@/lib/env';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { listScreen } from '@/screens/carch/list';
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
      gate: carchGate,
      secondaryMenu: 'carch',
    });
    expect(listScreen.owner).toBe(CARCH_OWNER);
    expect(Object.isFrozen(listScreen)).toBe(true);
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
