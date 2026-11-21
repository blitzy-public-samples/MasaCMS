// cArch.search of carch/search.cfm and the carch search() controller: getNextN paging, the strategies-content pages it
// reads, the result rows' action links by verdict and type, and the pager.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacySettings } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { searchNextN, searchScreen, type SearchNextN } from '@/screens/carch/search';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

const screen = searchScreen as Required<typeof searchScreen>;
const SITE = 'default';
const ROOT = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const FOLDER = 'F0000000-0000-0000-0000000000000001';
const SEARCH = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content`);

/** getSite('default') values the rows read. */
const SITE_VALUES = { locking: 'none', webPath: 'http://localhost', scheme: 'http', domain: 'localhost' };

type Row = Record<string, unknown>;

/** getPrivateSearch row `n` under a folder, with the values strategies-content adds; `overrides` replace columns. */
function resultRow(n: number, overrides: Row = {}): Row {
  const contentId = `C0000000-0000-0000-${String(n).padStart(16, '0')}`;
  const type = typeof overrides.type === 'string' ? overrides.type : 'Page';
  return {
    contentid: contentId,
    contenthistid: `H0000000-0000-0000-${String(n).padStart(16, '0')}`,
    type,
    parentid: FOLDER,
    moduleid: SITE_MANAGER,
    menutitle: `Result ${n}`,
    filename: `result-${n}`,
    targetParams: '',
    display: 1,
    approved: 1,
    displaystart: '',
    displaystop: '',
    lastupdate: '2026-11-13 10:30:00',
    islocked: 0,
    crumbdata: [
      { contentid: contentId, siteid: SITE, moduleid: SITE_MANAGER, type, menutitle: `Result ${n}`, restricted: 0 },
      { contentid: ROOT, siteid: SITE, moduleid: SITE_MANAGER, type: 'Page', menutitle: 'Home', restricted: 0 },
    ],
    verdict: 'editor',
    urlStem: `/result-${n}/`,
    ...overrides,
  };
}

/** One 30-row page of `total` matches as strategies-content reports it. */
const searchPage = (rows: readonly Row[], total: number, site: Row = SITE_VALUES): FakeReply => ({
  status: 200,
  body: { rc: { rslist: rows, nextn: { totalrecords: total }, site, copyContentID: '', copySiteID: '' } },
});

/** Pages of `total` generated rows, answered by the requested `page`. */
function pagedSearch(total: number): (request: RecordedRequest) => FakeReply {
  return (request) => {
    const page = Number(request.query.page);
    const first = (page - 1) * 30 + 1;
    const count = Math.max(0, Math.min(30, total - first + 1));
    return searchPage(
      Array.from({ length: count }, (_, i) => resultRow(first + i)),
      total,
    );
  };
}

const searchPartial = (rc: Record<string, string>): AdminRequestPartial => ({ circuit: 'cArch', item: 'search', rc });

/** The S2 admin's search for `rc`. */
const adminSearch = (rc: Record<string, string> = { keywords: 'news' }): AdminRequest =>
  adminS2Request(searchPartial(rc));

/** A screen context answering the search with `route`. */
function searchContext(req: AdminRequest, route: FakeReply | ((request: RecordedRequest) => FakeReply)) {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [SEARCH]: route }) });
}

/** The view body after the controller step, as a cheerio document. */
async function renderSearch(ctx: ScreenContext) {
  expect(await screen.redirect(ctx)).toBeUndefined();
  const data = await screen.load(ctx);
  const view = await screen.render(ctx, data);
  const body = toString(view.body);
  return { data, body, $: cheerio.load(body, null, false), view };
}

/** The `page` values the search read. */
const pagesRead = (ctx: ReturnType<typeof searchContext>): string[] =>
  ctx.gateway.calls.map((call) => String(call.query?.page));

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('searchNextN', () => {
  it.each<[number, string, Partial<SearchNextN>]>([
    [0, '1', { numberOfPages: 0, currentPageNumber: 1, firstPage: 1, lastPage: 0, next: 1, previous: 1, through: 0 }],
    [
      95,
      '31',
      { numberOfPages: 4, currentPageNumber: 2, firstPage: 1, lastPage: 4, next: 61, previous: 1, through: 60 },
    ],
    [400, '211', { numberOfPages: 14, currentPageNumber: 8, firstPage: 3, lastPage: 13, next: 241, previous: 181 }],
    [400, '391', { numberOfPages: 14, currentPageNumber: 14, firstPage: 4, lastPage: 14, next: 1, through: 400 }],
  ])('pages %i records from startrow %s as utility.getNextN does', (total, startRow, expected) => {
    expect(searchNextN(total, startRow)).toMatchObject({
      ...expected,
      totalRecords: total,
      recordsPerPage: 30,
      startRow,
    });
  });
});

describe('carch.search controller', () => {
  it.each<[string, Record<string, string>, string]>([
    ['rc.keywords is undefined', {}, 'Element RC.keywords is undefined in ARGUMENTS.'],
    ['rc.startrow is not numeric', { keywords: 'news', startrow: 'abc' }, 'is not of type numeric'],
    ['an ajax request has no startrow', { keywords: 'news', ajaxrequest: 'true' }, 'Element RC.startrow is undefined'],
  ])('fails as legacy does when %s', async (_case, rc, message) => {
    const ctx = searchContext(adminSearch(rc), searchPage([], 0));
    await expect(screen.load(ctx)).rejects.toThrow(message);
    expect(ctx.gateway.calls).toHaveLength(0);
  });

  it('answers a strategies-content denial with the secure() redirect from the redirect step only', async () => {
    const ctx = searchContext(adminSearch(), { status: 403 });
    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location: './' });
    await expect(screen.load(ctx)).rejects.toThrow('answers its denial from the redirect step');
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it.each<[string, FakeReply, string]>([
    ['another 4xx', { status: 404 }, 'rejected the carch.search read with HTTP 404'],
    ['a 5xx', { status: 500 }, 'listContent answered HTTP 500'],
    ['a model without rslist rows', { status: 200, body: { rc: { nextn: { totalrecords: 1 } } } }, 'no rc.rslist rows'],
    [
      'a model without totalrecords',
      { status: 200, body: { rc: { rslist: [], nextn: {} } } },
      'no rc.nextn.totalrecords',
    ],
  ])('throws for %s', async (_case, reply, message) => {
    await expect(screen.load(searchContext(adminSearch(), reply))).rejects.toThrow(message);
  });

  it('reads page 1 for the keywords and stores session.keywords', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'spring news' }), searchPage([], 0));
    const { data, body, $ } = await renderSearch(ctx);

    expect(ctx.gateway.calls).toEqual([
      expect.objectContaining({ path: `/v1/sites/${SITE}/content`, query: { keywords: 'spring news', page: '1' } }),
    ]);
    expect(ctx.req.session.keywords).toBe('spring news');
    expect(ctx.req.sessionWrites).toMatchObject({ keywords: 'spring news' });
    expect(data).toMatchObject({ recordCount: 0, firstRow: 1, rows: [], copyContentId: '', copySiteId: '' });
    expect($('td.results').text()).toBe('Your search returned no results.');
    expect($('input[name="keywords"]').attr('value')).toBe('spring news');
    expect(body).not.toContain('mura-results-wrapper');
  });

  it('fails at the cfoutput for a start row below 1 when the search matched rows', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'news', startrow: '0' }), searchPage([resultRow(1)], 1));
    const data = await screen.load(ctx);

    expect(data.rows).toEqual([]);
    expect(() => screen.render(ctx, data)).toThrow('Attribute validation error for CFOUTPUT.');
  });
});

describe('carch.search result rows', () => {
  it('links an editable row for the S2 admin, with permissions and a trash delete for a node type', async () => {
    const { $ } = await renderSearch(searchContext(adminSearch(), searchPage([resultRow(1)], 1)));
    const actions = $('td.actions li');

    expect(actions.toArray().map((li) => $(li).attr('class'))).toEqual([
      'edit',
      'preview',
      'version-history',
      'permissions',
      'delete',
    ]);
    expect($('li.edit a').attr('href')).toBe(
      './?muraAction=cArch.edit&contenthistid=H0000000-0000-0000-0000000000000001' +
        `&contentid=C0000000-0000-0000-0000000000000001&type=Page&parentid=${FOLDER}&topid=${ROOT}` +
        `&siteid=${SITE}&moduleid=${SITE_MANAGER}&startrow=1`,
    );
    expect($('li.preview a').attr('href')).toBe('http://localhost/result-1/');
    expect($('li.version-history a').attr('href')).toContain('muraAction=cArch.hist&');
    expect($('li.permissions a').attr('href')).toContain('muraAction=cPerm.main&');
    expect($('li.delete a').attr('href')).toContain('&action=deleteall&');
    expect($('li.delete i.mi-trash')).toHaveLength(1);
    expect($('td.add a').attr('onmouseover')).toBe(
      "showMenu('newContentMenu','editor',this,'C0000000-0000-0000-0000000000000001'," +
        `'C0000000-0000-0000-0000000000000001','${FOLDER}','${SITE}','Page','${SITE_MANAGER}');`,
    );
    expect($('tr').eq(1).find('td').eq(2).text().trim()).toBe('Yes');
    expect($('tr').eq(1).find('td').eq(3).text()).toBe('11/317/2026');
  });

  it.each<[string, Row, string, string, string]>([
    ['a Component deletes without the trash icon', { type: 'Component' }, 'none', 'delete', ''],
    ['a locked row shows the disabled delete', { islocked: 1 }, 'none', 'delete disabled', 'Delete'],
    ['a row under the root deletes when the site locks nothing', { parentid: ROOT }, 'none', 'delete', ''],
    [
      'a row under the root is kept when the site locks the top',
      { parentid: ROOT },
      'top',
      'delete disabled',
      'Delete',
    ],
  ])('%s', async (_case, overrides, locking, deleteClass, deleteText) => {
    const reply = searchPage([resultRow(1, overrides)], 1, { ...SITE_VALUES, locking });
    const { $ } = await renderSearch(searchContext(adminSearch(), reply));
    const li = $('td.actions li').last();

    expect(li.attr('class')).toBe(deleteClass);
    expect(li.text().trim()).toBe(deleteText);
  });

  it('prints no delete item when rc.locking is all and the row is not deletable', async () => {
    const req = adminSearch({ keywords: 'news', locking: 'all' });
    const { $ } = await renderSearch(searchContext(req, searchPage([resultRow(1, { islocked: 1 })], 1)));

    expect(
      $('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['edit', 'preview', 'version-history', 'permissions']);
  });

  it('disables permissions for a user who neither administers the site nor is S2', async () => {
    const req = editorRequest(searchPartial({ keywords: 'news' }));
    const { $ } = await renderSearch(searchContext(req, searchPage([resultRow(1)], 1)));

    expect($('li.permissions').attr('class')).toBe('permissions disabled');
    expect($('li.permissions').text()).toBe('Permissions');
  });

  it('offers read in the add menu for an editor verdict when the site locks all content', async () => {
    const site = { ...SITE_VALUES, locking: 'all' };
    const { $ } = await renderSearch(searchContext(adminSearch(), searchPage([resultRow(1)], 1, site)));

    expect($('td.add a').attr('onmouseover')).toContain("showMenu('newContentMenu','read',this,");
    expect($('li.delete').attr('class')).toBe('delete disabled');
  });

  it.each<[string, Row, string]>([
    [
      'a scheduled display window',
      { display: 2, displaystart: '2026-11-01', displaystop: '2026-11-30' },
      '11/305/2026 - 11/334/2026',
    ],
    ['an unapproved row', { approved: 0 }, 'No'],
    ['a hidden row', { display: 0 }, 'No'],
  ])('prints the Display cell of %s', async (_case, overrides, text) => {
    const { $ } = await renderSearch(searchContext(adminSearch(), searchPage([resultRow(1, overrides)], 1)));

    expect($('tr').eq(1).find('td').eq(2).text().trim()).toBe(text);
  });

  it.each<[string, Row, string | undefined, string | undefined]>([
    ['a Page links the site page', { type: 'Page' }, 'site', undefined],
    [
      'a Link previews its filename',
      { type: 'Link', filename: 'https://example.com', targetParams: 't' },
      '#',
      "return preview('https://example.com','t');",
    ],
    ['a File previews its site URL', { type: 'File', targetParams: 'f' }, '#', 'file'],
    ['a Component has no preview', { type: 'Component' }, undefined, undefined],
  ])('renders a read-only row where %s', async (_case, overrides, href, onclick) => {
    const rows = [resultRow(1, { verdict: 'read', ...overrides })];
    const { $ } = await renderSearch(searchContext(adminSearch(), searchPage(rows, 1)));
    const { serverPort, context } = legacySettings();
    const siteUrl = `http://localhost${serverPort}${context}/result-1/`;

    expect(
      $('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual([
      'edit disabled',
      ...(href === undefined ? [] : ['preview']),
      'version-history disabled',
      'permissions disabled',
      'delete disabled',
    ]);
    expect($('li.preview a').attr('href')).toBe(href === 'site' ? siteUrl : href);
    expect($('li.preview a').attr('onclick')).toBe(onclick === 'file' ? `return preview('${siteUrl}','f');` : onclick);
  });

  it.each<[string, Row, string]>([
    [
      'without moduleid, which getPrivateSearch does not select',
      { moduleid: undefined },
      'Element RSLIST.moduleid is undefined',
    ],
    ['whose crumbdata is not an array', { crumbdata: 'home' }, 'crumbdata that is not an array of crumbs'],
    ['without its verdict', { verdict: undefined }, 'an rc.rslist row without verdict'],
  ])('fails on a row %s', async (_case, overrides, message) => {
    const ctx = searchContext(adminSearch(), searchPage([resultRow(1, overrides)], 1));
    const data = await screen.load(ctx);

    expect(() => screen.render(ctx, data)).toThrow(message);
  });

  it('fails when the site values omit locking', async () => {
    const { locking: _locking, ...site } = SITE_VALUES;
    const ctx = searchContext(adminSearch(), searchPage([resultRow(1)], 1, site));
    const data = await screen.load(ctx);

    expect(() => screen.render(ctx, data)).toThrow('an rc.site without locking');
  });
});

describe('carch.search paging', () => {
  it('reads only the page an aligned start row opens and links its neighbours', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'news', startrow: '31' }), pagedSearch(95));
    const { data, $ } = await renderSearch(ctx);
    const pageUrl = (startRow: number): string =>
      `./?muraAction=cArch.search&siteid=${SITE}&keywords=news&startrow=${startRow}&moduleid=${SITE_MANAGER}`;

    expect(pagesRead(ctx)).toEqual(['2']);
    expect(data.rows.map((row) => row.menutitle)).toEqual(Array.from({ length: 30 }, (_, i) => `Result ${31 + i}`));
    expect($('p.search-showing').text().trim()).toBe('Showing 31-60 of 95 Results');
    expect(
      $('ul.pagination a')
        .toArray()
        .map((a) => [$(a).attr('href'), $(a).text()]),
    ).toEqual([
      [pageUrl(1), ''],
      [pageUrl(1), '1'],
      ['#', '2'],
      [pageUrl(61), '3'],
      [pageUrl(91), '4'],
      [pageUrl(61), ''],
    ]);
    expect($('ul.pagination li.active').text()).toBe('2');
  });

  it('prints the head of the next page after an unaligned start row', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'news', startrow: '15' }), pagedSearch(95));
    const { data, $ } = await renderSearch(ctx);

    expect(pagesRead(ctx)).toEqual(['1', '2']);
    expect(data.firstRow).toBe(15);
    expect(data.rows.map((row) => row.menutitle)).toEqual(Array.from({ length: 30 }, (_, i) => `Result ${15 + i}`));
    expect($('ul.pagination i.mi-angle-left')).toHaveLength(0);
    expect($('ul.pagination i.mi-angle-right')).toHaveLength(1);
  });

  it('keeps to the first page when an unaligned start row reaches no further records', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'news', startrow: '15' }), pagedSearch(20));
    const { data, body } = await renderSearch(ctx);

    expect(pagesRead(ctx)).toEqual(['1']);
    expect(data.rows).toHaveLength(6);
    expect(body).not.toContain('mura-results-wrapper');
  });

  it('answers a denial of the following page with the secure() redirect', async () => {
    const ctx = searchContext(adminSearch({ keywords: 'news', startrow: '15' }), (request) =>
      request.query.page === '2' ? { status: 401 } : pagedSearch(95)(request),
    );

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location: './' });
    expect(pagesRead(ctx)).toEqual(['1', '2']);
  });

  it('carries the copy state of the first page and the Site Manager script', async () => {
    const reply = searchPage([], 0);
    const rc = { ...(reply.body as { rc: Row }).rc, copyContentID: 'COPY-1', copySiteID: SITE };
    const { body, view } = await renderSearch(searchContext(adminSearch(), { status: 200, body: { rc } }));

    expect(body).toContain("siteManager.copyContentID = 'COPY-1';");
    expect(body).toContain(`siteManager.copySiteID = '${SITE}';`);
    expect(view.ajax === undefined ? '' : toString(view.ajax)).toContain('<script');
  });
});
