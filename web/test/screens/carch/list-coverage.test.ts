// cArch.list of carch/list.cfm and the carch list() controller: the strategies-content tree read and its outcomes, the
// content modules' session writes and tab script, and the LEGACY module grid with its pager and filter sidebar.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { listScreen } from '@/screens/carch/list';
import { COMPONENT_MODULE_ID, CONTENT_MODULE_ID, FORM_MODULE_ID, ROOT_CONTENT_ID } from '@/screens/carch/model';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const screen = listScreen as Required<typeof listScreen>;
const SITE = 'default';
const TREE = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/tree`);
const LIST = { circuit: 'cArch', item: 'list' } as const;
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const LEGACY_TOP = '00000000000000000000000000000000003';
const OTHER_USER = 'B0000000-0000-0000-0000000000000002';

type Struct = Record<string, unknown>;

const FLAT_VIEW_ARGS = {
  tab: '0',
  sortby: 'lastupdate',
  sortdirection: 'desc',
  page: '1',
  tags: '',
  categoryid: '',
  lockid: '',
  type: '',
  subtype: '',
  report: '',
  keywords: '',
  filtered: 'false',
};

/** The getSiteManagerTree model of the Site Manager root; `rc` replaces its values. */
const treeModel = (rc: Struct = {}): Struct => ({
  rc: {
    topid: ROOT_CONTENT_ID,
    rsTop: [],
    siteConfig: { customTagGroups: '', scaffolding: false, dataCollection: true, hasLockableNodes: false },
    sortBy: 'orderno',
    sortDirection: 'asc',
    crumbdata: [{ siteid: SITE, contentid: ROOT_CONTENT_ID }],
    copyContentID: '',
    copySiteID: '',
    copyAll: 'false',
    flatViewArgs: FLAT_VIEW_ARGS,
    modulePerms: { [COMPONENT_MODULE_ID]: 'editor', [FORM_MODULE_ID]: 'editor' },
    variations: false,
    ...rc,
  },
});

/** A screen context whose tree read answers `reply`. */
function listContext(
  req: AdminRequest,
  reply: FakeReply,
): ScreenContext & { gateway: ReturnType<typeof fakeGatewayClient> } {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [TREE]: reply }) });
}

const ok = (body: Struct): FakeReply => ({ status: 200, body });

/** The S2 admin's `cArch.list` with `partial` laid over it. */
const adminList = (partial: AdminRequestPartial = {}): AdminRequest => adminS2Request({ ...LIST, ...partial });

/** The rendered body after the controller step. */
async function renderBody(ctx: ScreenContext): Promise<string> {
  expect(await screen.redirect(ctx)).toBeUndefined();
  const view = await screen.render(ctx, await screen.load(ctx));
  return toString(view.body);
}

/** The query fields the tree read carried to strategies-content. */
const sentQuery = (ctx: ReturnType<typeof listContext>): Readonly<Record<string, string | string[]>> =>
  ctx.gateway.calls[0]?.query ?? {};

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('carch.list controller', () => {
  it('answers a strategies-content denial with the secure() redirect from the redirect step only', async () => {
    const ctx = listContext(adminList(), { status: 403 });

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location: './' });
    await expect(screen.load(ctx)).rejects.toThrow('carch.list redirects to ./; it has no view data');
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it('throws when strategies-content rejects the read with another 4xx', async () => {
    await expect(screen.load(listContext(adminList(), { status: 404 }))).rejects.toThrow(
      'strategies-content rejected the carch.list read with HTTP 404',
    );
  });

  it.each<[string, Struct]>([
    ['finds no crumb', { crumbdata: [] }],
    ['finds a crumb without a site id', { crumbdata: [{ siteid: '', contentid: ROOT_CONTENT_ID }] }],
  ])('sends the view to the Site Manager root when getCrumbList %s', async (_case, rc) => {
    const ctx = listContext(adminList({ rc: { topid: 'MISSING' } }), ok(treeModel(rc)));

    expect(await screen.redirect(ctx)).toEqual({
      kind: 'location',
      location: `./?muraAction=cArch.list&siteid=${SITE}&moduleid=${CONTENT_MODULE_ID}&topid=${ROOT_CONTENT_ID}`,
    });
  });

  it.each<[string, string, boolean]>([
    ['a positive nextN', '25', true],
    ['a nextN text that compares above 0', 'abc', true],
    ['a zero nextN', '0', false],
  ])('stores session.mura.nextN and restarts the tree at row 1 only above 0, here %s', async (_case, nextN, reset) => {
    const ctx = listContext(adminList({ rc: { nextN, startrow: '31' } }), ok(treeModel()));
    const body = await renderBody(ctx);

    expect(ctx.req.session.muraValues.nextN).toBe(reset ? nextN : undefined);
    expect(body).toContain(`', '${reset ? '1' : '31'}');\n\t\t\t\t\t\t\tarchViewLoaded = true;`);
  });

  it('sends only the URL-scope keywords of the forwarded request target and stores them in the session', async () => {
    const headers = new Headers({
      [ORIGINAL_URL_HEADER]: '/admin/?muraAction=cArch.list&keywords=spring&Keywords=news&=x',
    });
    const ctx = listContext(adminList({ headers, rc: { keywords: 'posted' } }), ok(treeModel()));
    await renderBody(ctx);

    expect(sentQuery(ctx).keywords).toBe('spring,news');
    expect(ctx.req.session.keywords).toBe('spring,news');
  });

  it('sends no keywords when neither the forwarded target nor rc.currentURL names them', async () => {
    const headers = new Headers({ [ORIGINAL_URL_HEADER]: '/admin/' });
    const ctx = listContext(adminList({ headers, rc: { keywords: 'posted' } }), ok(treeModel()));
    await renderBody(ctx);

    expect(Object.keys(sentQuery(ctx)).some((name) => name.toLowerCase() === 'keywords')).toBe(false);
    expect(ctx.req.session.keywords).toBe('');
  });

  it('sets session.moduleid from rc.moduleid in an ajax request that left it unset', async () => {
    const req = adminList({
      rc: { ajaxrequest: 'true', moduleid: CONTENT_MODULE_ID, startrow: '1', ptype: 'Page' },
      session: { moduleid: '', moduleTopIds: { [`m${CONTENT_MODULE_ID}`]: ROOT_CONTENT_ID } },
    });
    const ctx = listContext(req, ok(treeModel()));
    await renderBody(ctx);

    expect(ctx.req.session.moduleid).toBe(CONTENT_MODULE_ID);
    expect(ctx.req.sessionWrites).toMatchObject({ moduleid: CONTENT_MODULE_ID });
  });

  it('fails as ACF does when the session holds no top for the module of an ajax request', async () => {
    const req = adminList({ rc: { ajaxrequest: 'true', moduleid: CONTENT_MODULE_ID, startrow: '1', ptype: 'Page' } });
    const ctx = listContext(req, ok(treeModel()));
    const data = await screen.load(ctx);

    await expect(screen.render(ctx, data)).rejects.toThrow(`Element M${CONTENT_MODULE_ID} is undefined`);
  });

  it('renders an empty body for an ajax request on a module outside both cases', async () => {
    const ctx = listContext(adminList({ rc: { ajaxrequest: 'true', moduleid: USERS_MODULE_ID } }), ok(treeModel()));
    const view = await screen.render(ctx, await screen.load(ctx));

    expect(toString(view.body)).toBe('');
    expect(view.htmlHead).toBeUndefined();
    expect(view.ajax).toBeDefined();
  });
});

describe('carch.list content modules', () => {
  it('carries the copied node of this site, with its module, into the Site Manager script', async () => {
    const rc = { copyContentID: 'COPY-1', copySiteID: SITE, copyModuleID: CONTENT_MODULE_ID, copyAll: 'true' };
    const body = await renderBody(listContext(adminList(), ok(treeModel(rc))));

    expect(body).toContain(
      "siteManager.copyContentID = 'COPY\\x2D1';\n\t\t\t\tsiteManager.copySiteID = 'default';" +
        `\n\t\t\t\tsiteManager.copymoduleid = '${CONTENT_MODULE_ID}';\n\t\t\t\tsiteManager.copyAll = 'true';`,
    );
  });

  it('lists the custom tag groups as JSON and in the flat view arguments', async () => {
    const siteConfig = {
      customTagGroups: 'Region^Say "hi"\u0001',
      scaffolding: false,
      dataCollection: true,
      hasLockableNodes: false,
    };
    const flatViewArgs = { ...FLAT_VIEW_ARGS, Regiontags: 'north', 'Say "hi"\u0001tags': '' };
    const body = await renderBody(listContext(adminList(), ok(treeModel({ siteConfig, flatViewArgs }))));

    expect(body).toContain('var customtaggroups=["Region","Say \\"hi\\"\\u0001"];');
    expect(body).toContain(`\n\t\t\t\t\t\t\t\t,"Regiontags":'north'\n\t\t\t\t\t\t\t`);
  });

  it.each<[string, AdminRequestPartial, string]>([
    ['the flat-view tab when the URL names neither moduleid nor activetab', {}, 'initSiteManagerTabContent(2);'],
    [
      'rc.activeTab when the URL names it',
      { currentUrl: './?muraAction=cArch.list&activetab=1', rc: { activeTab: '1' } },
      'initSiteManagerTabContent(1);',
    ],
    [
      'the tree tab when the URL names moduleid without activetab',
      { currentUrl: `./?muraAction=cArch.list&moduleid=${CONTENT_MODULE_ID}`, rc: { moduleid: CONTENT_MODULE_ID } },
      'initSiteManagerTabContent(0);',
    ],
  ])('opens %s', async (_case, partial, call) => {
    const flatViewArgs = { ...FLAT_VIEW_ARGS, tab: '2' };
    const ctx = listContext(adminList(partial), ok(treeModel({ flatViewArgs })));
    const body = await renderBody(ctx);
    const opened = body.match(/jQuery\(document\)\.ready\(function\(\)\{\s*(initSiteManagerTabContent\([^)]*\);)/)?.[1];

    expect(opened).toBe(call);
  });
});

// ---- LEGACY module ----

/** An `rc.rsTop` row of the LEGACY grid; `overrides` replace columns. */
function legacyRow(n: number, overrides: Struct = {}): Struct {
  return {
    contentid: `L0000000-0000-0000-${String(n).padStart(16, '0')}`,
    contenthistid: `M0000000-0000-0000-${String(n).padStart(16, '0')}`,
    type: 'Component',
    parentID: LEGACY_TOP,
    menutitle: `Legacy ${n}`,
    Display: 1,
    approved: 1,
    displaystart: '',
    displaystop: '',
    lastupdate: '2026-11-13 10:30:00',
    lockid: '',
    perm: 'none',
    isLocked: 0,
    remoteurl: '',
    ...overrides,
  };
}

/** The getNextN struct of `total` LEGACY rows from `startRow`, ten per page. */
function legacyNextN(total: number, startRow: number): Struct {
  const pages = Math.ceil(total / 10);
  const current = Math.ceil(startRow / 10);
  return {
    recordsperpage: '10',
    startrow: String(startRow),
    through: String(Math.min(total, current * 10)),
    totalrecords: total,
    currentpagenumber: String(current),
    firstPage: '1',
    lastPage: String(pages),
    NumberOfPages: String(pages),
    numberofpages: String(pages),
    previous: String(Math.max(1, current - 1) * 10 - 9),
    next: String(current * 10 + 1),
  };
}

/** The LEGACY model of `rows` with an editor module verdict; `rc` replaces its values. */
const legacyModel = (rows: readonly Struct[], rc: Struct = {}): Struct => ({
  rc: {
    topid: LEGACY_TOP,
    perm: 'editor',
    rsTop: rows,
    nextN: legacyNextN(rows.length, 1),
    siteConfig: { customTagGroups: '', hasLockableNodes: false },
    categoryCount: 0,
    categories: [],
    ...rc,
  },
});

/** The ajax request that reaches the LEGACY case, with the rc values its grid reads. */
const legacyRequest = (rc: Record<string, string> = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminList({
    ...partial,
    rc: { ajaxrequest: 'true', moduleid: 'LEGACY', startrow: '1', parentid: LEGACY_TOP, locking: 'false', ...rc },
  });

/** The LEGACY body of `req` over `model`, as a cheerio document. */
async function renderLegacy(req: AdminRequest, model: Struct) {
  const ctx = listContext(req, ok(model));
  const body = await renderBody(ctx);
  return { ctx, body, $: cheerio.load(body, null, false) };
}

describe('carch.list LEGACY grid', () => {
  it('lists editor rows with their edit, history, permissions and token-bearing delete links', async () => {
    const rows = [legacyRow(1), legacyRow(2, { type: 'Variation', remoteurl: 'https://remote.example/a b' })];
    const { ctx, $, body } = await renderLegacy(legacyRequest(), legacyModel(rows));
    const first = $('tbody tr').eq(0);

    expect($('h1').first().text()).toBe('Components');
    expect(first.find('td.var-width a.draftprompt').attr('href')).toBe(
      './?muraAction=cArch.edit&contenthistid=M0000000-0000-0000-0000000000000001' +
        `&contentid=L0000000-0000-0000-0000000000000001&type=Component&parentid=${LEGACY_TOP}&topid=${LEGACY_TOP}` +
        `&siteid=${SITE}&moduleid=LEGACY`,
    );
    expect(first.find('td.var-width a').text().trim()).toBe('Legacy 1');
    expect(first.find('td').eq(1).find('span').text()).toBe('Yes');
    expect(first.find('td').eq(2).text().trim()).toBe('11/317/2026 10:30:00 AM');
    expect(
      first
        .find('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['edit', 'version-history', 'permissions', 'delete']);
    expect(first.find('li.delete a').attr('href')).toContain(`&csrf_token=${FIXED_CSRF.token}`);
    expect(first.find('li.delete a').attr('onclick')).toContain("return confirmDialog('");
    expect($('tbody tr').eq(1).find('li.preview a').attr('href')).toBe('https%3A%2F%2Fremote.example%2Fa+b');
    expect(
      ctx.gateway.calls.filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens'),
    ).toHaveLength(1);
    expect(body).toContain('initDraftPrompt();');
  });

  it.each<[string, Struct, string]>([
    [
      'a scheduled display window',
      { Display: 2, displaystart: '2026-11-01', displaystop: '2026-11-30' },
      '11/1/26 - 11/30/26',
    ],
    ['an unapproved row', { approved: 0 }, 'No'],
  ])('prints the Display cell of %s', async (_case, overrides, text) => {
    const { $ } = await renderLegacy(legacyRequest(), legacyModel([legacyRow(1, overrides)]));

    expect($('tbody tr td').eq(1).text().trim().replace(/\s+/g, ' ')).toBe(text);
  });

  it('derives each row verdict from its own permission when the module verdict is not editor', async () => {
    const rows = [legacyRow(1, { perm: 'deny' }), legacyRow(2, { perm: 'none' }), legacyRow(3, { perm: 'editor' })];
    const { $ } = await renderLegacy(legacyRequest(), legacyModel(rows, { perm: 'read' }));
    const classes = (i: number): string[] =>
      $('tbody tr')
        .eq(i)
        .find('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class') ?? '');

    expect($('tbody tr').eq(0).find('td.var-width a')).toHaveLength(0);
    expect($('tbody tr').eq(0).find('td.var-width').text().trim()).toBe('Legacy 1');
    expect(classes(0)).toEqual([
      'edit disabled',
      'version-history disabled',
      'permissions disabled',
      'delete disabled',
    ]);
    expect(classes(1)).toEqual(['edit', 'version-history', 'permissions', 'delete disabled']);
    expect(classes(2)).toEqual(['edit', 'version-history', 'permissions', 'delete']);
  });

  it.each<[string, Struct, Record<string, string>, string[]]>([
    [
      'a row someone else locked',
      { lockid: OTHER_USER },
      {},
      ['edit disabled', 'version-history', 'permissions', 'delete disabled'],
    ],
    ['a locked row', { isLocked: 1 }, {}, ['edit', 'version-history', 'permissions', 'delete disabled']],
    [
      'a locked row when rc.locking is all',
      { isLocked: 1 },
      { locking: 'all' },
      ['edit', 'version-history', 'permissions'],
    ],
    [
      'a top-level row when rc.locking is none',
      {},
      { locking: 'none', parentid: LEGACY_TOP },
      ['edit', 'version-history', 'permissions', 'delete'],
    ],
  ])('keeps the delete item of %s as legacy does', async (_case, overrides, rc, classes) => {
    const siteConfig = { customTagGroups: '', hasLockableNodes: true };
    const { $ } = await renderLegacy(legacyRequest(rc), legacyModel([legacyRow(1, overrides)], { siteConfig }));

    expect(
      $('tbody td.actions li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(classes);
  });

  it('disables permissions for qa_editor and prints the empty section notice without rows', async () => {
    const req = editorRequest({
      ...LIST,
      rc: { ajaxrequest: 'true', moduleid: 'LEGACY', startrow: '1', parentid: LEGACY_TOP, locking: 'false' },
    });
    const withRows = await renderLegacy(req, legacyModel([legacyRow(1)]));
    const empty = await renderLegacy(legacyRequest(), legacyModel([]));

    expect(withRows.$('td.actions li.permissions')).toHaveLength(0);
    expect(empty.$('table.mura-table-grid')).toHaveLength(0);
    expect(empty.$('div.help-block-empty').text().trim()).toBe('There are no items in this section.');
  });

  it('prints from rc.startrow at most recordsperpage rows', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => legacyRow(i + 1));
    const { $ } = await renderLegacy(
      legacyRequest({ startrow: '11' }),
      legacyModel(rows, { nextN: legacyNextN(25, 11) }),
    );

    expect(
      $('tbody td.var-width a')
        .toArray()
        .map((a) => $(a).text().trim()),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `Legacy ${11 + i}`));
  });

  it.each<[string, string, Record<string, string>]>([
    ['title', 'asc', { title: 'desc', display: 'asc', lastUpdate: 'desc' }],
    ['display', 'asc', { title: 'asc', display: 'desc', lastUpdate: 'desc' }],
    ['lastupdate', 'desc', { title: 'asc', display: 'asc', lastUpdate: 'asc' }],
    ['menutitle', 'desc', { title: 'asc', display: 'asc', lastUpdate: 'desc' }],
  ])('links the opposite direction of the sorted column for sortBy=%s %s', async (sortBy, sortDirection, expected) => {
    const req = legacyRequest({ sortBy, sortDirection });
    const { $ } = await renderLegacy(req, legacyModel([legacyRow(1)]));
    const directions = Object.fromEntries(
      $('thead th a')
        .toArray()
        .map((a) => new URLSearchParams(($(a).attr('href') ?? '').slice(2)))
        .map((query) => [query.get('sortBy'), query.get('sortDirection')]),
    );

    expect(directions).toEqual(expected);
  });

  it('pages the grid with previous, numbered and next links carrying the sort and search', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => legacyRow(i + 1));
    const nextN = { ...legacyNextN(25, 11), totalrecords: '25' };
    const req = legacyRequest({ startrow: '11', sortBy: 'title', sortDirection: 'asc', searchString: 'x' });
    const { $ } = await renderLegacy(req, legacyModel(rows, { nextN }));
    const page = (startRow: number): string =>
      `./?muraAction=cArch.list&siteid=${SITE}&moduleid=LEGACY&topid=${LEGACY_TOP}&startrow=${startRow}` +
      '&sortBy=title&sortDirection=asc&searchString=x';

    expect($('p.search-showing').text().trim()).toBe('Showing 11-20 of 25 Results');
    expect(
      $('ul.pagination a')
        .toArray()
        .map((a) => [$(a).attr('href'), $(a).text().trim()]),
    ).toEqual([
      [page(1), ''],
      [page(1), '1'],
      ['#', '2'],
      [page(21), '3'],
      [page(21), ''],
    ]);
  });

  it('prints the filter sidebar with tags, tag groups, categories and the remove filter button', async () => {
    const siteConfig = { customTagGroups: 'Region', hasLockableNodes: false };
    const categories = [
      {
        categoryID: 'CAT-1',
        name: 'News',
        isOpen: 1,
        hasKids: 1,
        children: [{ categoryID: 'CAT-2', name: 'Local', isOpen: '1', hasKids: 0 }],
      },
    ];
    const req = legacyRequest({ tags: 'alpha,<b>', Regiontags: 'north', categoryid: 'CAT-2', searchString: 'q"' });
    const { $, body } = await renderLegacy(
      req,
      legacyModel([legacyRow(1)], { siteConfig, categoryCount: 1, categories, useLayoutManager: 'true' }),
    );

    expect(
      $('#tags input[name="tags"]')
        .toArray()
        .map((input) => $(input).attr('value')),
    ).toEqual(['alpha', '<b>']);
    expect($('#Regiontags input[name="Regiontags"]').attr('value')).toBe('north');
    expect($('#searchString').attr('value')).toBe('q"');
    expect($('#mura-list-tree label').text()).toBe('Categories');
    expect($('#mura-list-tree').text()).toContain('Local');
    expect($('#removeFilter').attr('value')).toBe('Remove Filter');
    expect(body).toContain('var customtaggroups=["Region"];');
    expect(body).toContain(`$("input[name='Regiontags']").val('');`);
  });

  it('prints no remove filter button without a category, tag or search filter', async () => {
    const { $ } = await renderLegacy(legacyRequest(), legacyModel([legacyRow(1)]));

    expect($('#removeFilter')).toHaveLength(0);
    expect($('#mura-list-tree')).toHaveLength(0);
  });

  it.each<[string, Record<string, string>, Struct, string]>([
    ['rc.rsTop is not a query', {}, { rsTop: 'none' }, 'rsTop is not a query'],
    ['rc.nextN is not a struct', {}, { nextN: [] }, 'nextN is not a struct'],
    ['the model has no perm', {}, { perm: undefined }, 'Element PERM is undefined in RC.'],
    [
      'rc.startrow is not an integer',
      { startrow: 'x' },
      {},
      'The value of the startrow attribute, x, is not an integer.',
    ],
    [
      'a row date is not a date',
      {},
      { rsTop: [legacyRow(1, { lastupdate: 'soon' })] },
      'The value soon cannot be converted to a date.',
    ],
    ['the categories are not an array', {}, { categoryCount: 1, categories: {} }, 'categories is not an array'],
    ['a category is not a struct', {}, { categoryCount: 1, categories: ['News'] }, 'A category is not a struct'],
  ])('fails as legacy does when %s', async (_case, rc, model, message) => {
    const ctx = listContext(legacyRequest(rc), ok(legacyModel([legacyRow(1)], model)));
    const data = await screen.load(ctx);

    await expect(screen.render(ctx, data)).rejects.toThrow(message);
  });
});
