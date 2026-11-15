// cArch.search over the recorded strategies-content search model: the controller's session write and read, the result
// rows, the pager and the page inside the Site Manager shell.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure } from '@/lib/access-gate';
import { lsDateFormatString } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { carchContentNav } from '@/screens/carch/content-nav';
import { carchJs } from '@/screens/carch/partials/js';
import { dspZoom, type ZoomCrumb } from '@/screens/carch/partials/zoom';
import { searchScreen } from '@/screens/carch/search';
import type { ScreenContext } from '@/screens/registry';
import { CARCH_PATHS, carchSearchData } from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRoute } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const screen = searchScreen as Required<typeof searchScreen>;
const SITE = 'tenant-a';
const SITE_MANAGER = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
// strategies-content serves the search as listContent; its contract names no `/carch/search` path.
const SEARCH = routeKey('GET', 'strategies-content', CARCH_PATHS.search);

type Row = Record<string, unknown>;
type Model = typeof carchSearchData;
type Ctx = ScreenContext & { gateway: FakeGatewayClient };

/** A deep copy of the recorded `rc.rslist`. */
const recordedRows = (): Row[] => structuredClone(carchSearchData.rc.rslist) as Row[];

/** Recorded row `index`, deep-copied. */
function recordedRow(index: number): Row {
  const row = recordedRows()[index];
  if (row === undefined) throw new RangeError(`carchSearchData has no row ${index}`);
  return row;
}

/** carchSearchData with `rows` and `total` in place of the recorded rows and count, and `site` over its site values. */
function searchModel(rows: readonly Row[], total: number = rows.length, site: Row = {}): Model {
  const model = structuredClone(carchSearchData);
  const rc = model.rc as Row;
  rc.rslist = rows;
  rc.nextn = { ...(rc.nextn as Row), TotalRecords: total };
  rc.site = { ...(rc.site as Row), ...site };
  return model;
}

/** The recorded Home row as match `n` of a long result list, with its own id and title. */
function numberedRow(n: number): Row {
  const home = recordedRow(0);
  const contentid = `5C000000-00FF-4000-${String(n).padStart(16, '0')}`;
  const [crumb] = home.crumbdata as Row[];
  return { ...home, contentid, menutitle: `Match ${n}`, crumbdata: [{ ...crumb, contentid, menutitle: `Match ${n}` }] };
}

/** Pages of `total` numbered matches, answered by the requested `page`. */
const pagedSearch =
  (total: number): FakeRoute =>
  (request) => {
    const first = (Number(request.query.page) - 1) * 30 + 1;
    const count = Math.max(0, Math.min(30, total - first + 1));
    return { status: 200, body: searchModel(Array.from({ length: count }, (_, i) => numberedRow(first + i)), total) };
  };

/** The tenant-a site admin's cArch.search for `home`, `rc` laid over it. */
const searchRequest = (rc: Record<string, string> = {}): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cArch', item: 'search', rc: { keywords: 'home', ...rc } });

function searchContext(route: FakeRoute = { status: 200, body: carchSearchData }, req = searchRequest()): Ctx {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [SEARCH]: route }) });
}

/** The search reads the screen made. */
const searchCalls = (ctx: Ctx) => ctx.gateway.calls.filter((call) => call.path === CARCH_PATHS.search);

/** The controller step, load and render, as the page handler runs them. */
async function renderSearch(ctx: Ctx) {
  expect(await screen.redirect(ctx)).toBeUndefined();
  const data = await screen.load(ctx);
  const view = await screen.render(ctx, data);
  const body = toString(view.body);
  return { data, view, body, $: cheerio.load(body, null, false) };
}

/** A pager link to `startRow` for the session keywords. */
const pageUrl = (startRow: number): string =>
  `./?muraAction=cArch.search&siteid=${SITE}&keywords=home&startrow=${startRow}&moduleid=${SITE_MANAGER}`;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('cArch.search controller', () => {
  it('stores rc.keywords as session.keywords and reads the first page for them', async () => {
    const ctx = searchContext();
    const { data, $ } = await renderSearch(ctx);

    expect(ctx.req.sessionWrites).toMatchObject({ keywords: 'home' });
    expect(ctx.req.session.keywords).toBe('home');
    expect(searchCalls(ctx)).toEqual([
      expect.objectContaining({ service: 'strategies-content', query: { keywords: 'home', page: '1' } }),
    ]);
    expect(data).toMatchObject({ recordCount: 2, firstRow: 1, copyContentId: '', copySiteId: '' });
    expect($('input[name="keywords"]').attr('value')).toBe('home');
  });
});

describe('cArch.search result rows', () => {
  it('prints each recorded row with its breadcrumb, Display and last update', async () => {
    const { body } = await renderSearch(searchContext());

    expect(fragmentModel(body).tables).toEqual([
      {
        headers: ['', 'Title', 'Display', 'Update', ''],
        rows: [
          ['', 'Home', 'Yes', '10/302/2026', ''],
          ['', 'Components Home Banner', 'Yes', '06/179/2026', ''],
        ],
      },
    ]);
  });

  it('writes the dspZoom breadcrumb of each row, linking its ancestors into the Site Manager', async () => {
    const ctx = searchContext();
    const { body, $ } = await renderSearch(ctx);
    const { context, adminDir } = legacySettings();

    for (const row of recordedRows()) {
      const crumbdata = row.crumbdata as ZoomCrumb[];
      expect(body).toContain(`<td class="title var-width">${toString(dspZoom(ctx, { crumbdata }))}</td>`);
    }
    const banner = $('td.title ul.breadcrumb').eq(1);
    expect(banner.find('a').attr('href')).toBe(
      `${context}${adminDir}/?muraAction=cArch.list&siteid=${SITE}&topid=${COMPONENTS}&moduleid=${COMPONENTS}&activeTab=0`,
    );
    expect(banner.find('strong').text().trim()).toBe('Home Banner');
  });

  it('previews each row at the site web path plus its URL stem', async () => {
    const { $ } = await renderSearch(searchContext());
    const { webPath } = carchSearchData.rc.site as { webPath: string };

    expect(
      $('li.preview a')
        .toArray()
        .map((a) => $(a).attr('href')),
    ).toEqual(recordedRows().map((row) => `${webPath}${String(row.urlStem)}`));
  });

  it('formats Update with LSDateFormat under session.dateKeyFormat', async () => {
    const ctx = searchContext();
    const { $ } = await renderSearch(ctx);
    const { dateKeyFormat, locale } = ctx.req.session;

    expect(
      $('td.title')
        .toArray()
        .map((td) => $(td).nextAll('td').eq(1).text()),
    ).toEqual(recordedRows().map((row) => lsDateFormatString(String(row.lastupdate), dateKeyFormat, locale)));
  });

  it('prints Display for a row always shown, shown on a schedule and never shown', async () => {
    const home = recordedRow(0);
    const rows = [
      home,
      { ...home, display: 2, displaystart: '2026-07-01 00:00:00', displaystop: '2026-12-31 23:59:00' },
      { ...home, display: 0 },
    ];
    const { $ } = await renderSearch(searchContext({ status: 200, body: searchModel(rows) }));

    expect(
      $('td.title')
        .toArray()
        .map((td) => $(td).next('td').text().trim()),
    ).toEqual(['Yes', '07/182/2026 - 12/365/2026', 'No']);
  });

  it('offers no add-menu option and only read-only actions for an unseen row when the site locks all content', async () => {
    const reply = { status: 200, body: searchModel([{ ...recordedRow(0), verdict: 'none' }], 1, { locking: 'all' }) };
    const { $ } = await renderSearch(searchContext(reply));

    expect($('td.add a').attr('onmouseover')).toMatch(/^showMenu\('newContentMenu','none',this,/);
    expect(
      $('td.actions li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['edit disabled', 'preview', 'version-history disabled', 'permissions disabled', 'delete disabled']);
  });

  it('answers a search that matched nothing with the legacy no-results row and no pager', async () => {
    const { body, $ } = await renderSearch(searchContext({ status: 200, body: searchModel([], 0) }));

    expect($('td.results').attr('colspan')).toBe('8');
    expect($('td.results').text()).toBe('Your search returned no results.');
    expect(body).not.toContain('mura-results-wrapper');
  });
});

describe('cArch.search pager', () => {
  it.each<[string, string, number, string, Array<[string | undefined, string]>]>([
    ['1', '1', 30, 'Showing 1-30 of 31 Results', [['#', '1'], [pageUrl(31), '2'], [pageUrl(31), '']]],
    ['31', '2', 1, 'Showing 31-31 of 31 Results', [[pageUrl(1), ''], [pageUrl(1), '1'], ['#', '2']]],
  ])('from startrow %s reads page %s of 31 matches, prints %i rows and links the other page', async (startrow, page, printed, meta, links) => {
    const ctx = searchContext(pagedSearch(31), searchRequest({ startrow }));
    const { data, $ } = await renderSearch(ctx);

    expect(searchCalls(ctx).map((call) => call.query)).toEqual([{ keywords: 'home', page }]);
    expect(data.rows).toHaveLength(printed);
    expect($('td.title')).toHaveLength(printed);
    expect($('p.search-showing').text().trim()).toBe(meta);
    expect(
      $('ul.pagination a')
        .toArray()
        .map((a) => [$(a).attr('href'), $(a).text()]),
    ).toEqual(links);
  });
});

describe('cArch.search page', () => {
  it('renders inside the shell with the Site Manager content nav for the Site Manager module', async () => {
    const ctx = searchContext(undefined, searchRequest({ moduleid: SITE_MANAGER }));
    const page = await renderScreenPage(searchScreen, ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($('h1').text()).toContain('Site Search');
    expect($('#newContentMenu')).toHaveLength(1);
    expect($('#newContentDialog')).toHaveLength(1);
    expect(page.html).toContain(toString(carchContentNav(ctx.req)));
  });

  it('hands the shell the Site Manager script as its ajax block', async () => {
    const ctx = searchContext();
    const { view } = await renderSearch(ctx);

    expect(view.ajax === undefined ? undefined : toString(view.ajax)).toBe(toString(carchJs(ctx, 'search')));
  });

  it('sends an anonymous user through secure() before any search', async () => {
    const req = anonymousRequest({ circuit: 'cArch', item: 'search', rc: { keywords: 'home', siteid: SITE } });
    const ctx = searchContext(undefined, req);
    const denied = secure(req);
    if (denied.kind !== 'redirect') throw new Error('secure() allowed an anonymous user');

    await expect(renderScreenPage(searchScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: denied.location });
    expect(searchCalls(ctx)).toEqual([]);
  });
});
