// cChangesets.list over the tenant-a strategies-content fixture: load, view, category nest and registered page.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { CCHANGESETS_RC_DEFAULTS, cchangesetsScreens } from '@/screens/cchangesets';
import { renderCategoriesNest, type ChangesetCategoryNode } from '@/screens/cchangesets/dsp_categories_nest';
import {
  changesetListScreen,
  loadChangesetList,
  renderChangesetList,
  type ChangesetListData,
} from '@/screens/cchangesets/list';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest } from '../../helpers/admin-request';
import { domModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { CATEGORY_IDS, INTEREST_CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import { CCHANGESETS_PATHS, CHANGESET_IDS, cchangesetsListData } from '../../fixtures/strategies-content/changesets';

type Filters = Readonly<Record<string, string>>;
type Preset = typeof adminS2Request;

const SITE = 'tenant-a';
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';
const LIST_ROUTE = routeKey('GET', 'strategies-content', CCHANGESETS_PATHS.list);
const CSRF_URL = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The list request on tenant-a, rc over the `before()` defaults. */
const listRequest = (filters: Filters = {}, preset: Preset = adminS2Request): ScreenContext['req'] =>
  preset({ circuit: 'cchangesets', item: 'list', rc: { siteid: SITE, ...CCHANGESETS_RC_DEFAULTS, ...filters } });

/** A context whose strategies-content answers the fixture list. */
const contextFor = (req: ScreenContext['req']) =>
  makeScreenContext({ req, gateway: fakeGatewayClient({ [LIST_ROUTE]: { status: 200, body: cchangesetsListData } }) });

/** The loaded fixture page, `vary` applied, rendered for `filters`. */
async function rendered(
  filters: Filters = {},
  vary: (data: ChangesetListData) => ChangesetListData = (data) => data,
  preset: Preset = adminS2Request,
) {
  const ctx = contextFor(listRequest(filters, preset));
  const data = vary(await loadChangesetList(ctx));
  const markup = toString(renderChangesetList(ctx, data));
  return { ctx, data, markup, model: domModel(markup), $: cheerio.load(markup, null, false) };
}

/** The fixture's category tree as `loadChangesetList` maps it. */
async function fixtureTree(): Promise<readonly ChangesetCategoryNode[]> {
  return (await loadChangesetList(contextFor(listRequest()))).categories;
}

describe('loadChangesetList', () => {
  it('maps the three fixture change sets, paging and category count', async () => {
    const { data } = await rendered();

    expect(data.rows.map((row) => [row.changesetId, row.name, row.published])).toEqual([
      [CHANGESET_IDS.open, 'Summer Refresh', false],
      [CHANGESET_IDS.scheduled, 'Autumn Launch', false],
      [CHANGESET_IDS.published, 'Spring Cleanup', true],
    ]);
    expect(data.paging).toEqual({ pageIndex: 1, pageCount: 1, recordCount: 3, firstRecordOnPage: 1, lastRecordOnPage: 3 });
    expect(data.categoryCount).toBe(10);
  });

  it('relays the rc filters to strategies-content unchanged', async () => {
    const filters = {
      keywords: 'home',
      startdate: '2026-10-29',
      stopdate: '2026-10-29',
      categoryid: CATEGORY_IDS.topicsNews,
      tags: 'news,events',
      page: '2',
    };
    const ctx = contextFor(listRequest(filters));

    const data = await loadChangesetList(ctx);

    expect(ctx.gateway.calls[0]).toEqual({
      service: 'strategies-content',
      method: 'GET',
      path: CCHANGESETS_PATHS.list,
      query: { ...CCHANGESETS_RC_DEFAULTS, ...filters },
    });
    // The view's To date is list()'s rc.stopdate, moved one day on after the query was built (cchangesets.cfc:102).
    expect(data.stopDate).toBe("{ts '2026-10-30 00:00:00'}");
  });

  it('rejects with the gateway unavailability', async () => {
    const ctx = contextFor(listRequest());
    ctx.gateway.failWith();

    await expect(loadChangesetList(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('renderChangesetList', () => {
  const addLink: [string, string] = ['Add Change Set', `./?muraAction=cChangesets.edit&changesetID=&siteid=${SITE}`];
  const permissionsLink: [string, string] = [
    'Permissions',
    `./?muraAction=cPerm.module&contentid=${CHANGESETS_MODULE_ID}&siteid=${SITE}&moduleid=${CHANGESETS_MODULE_ID}`,
  ];

  it.each<[string, Preset, Array<[string, string]>]>([
    ['the S2 admin', adminS2Request, [addLink, permissionsLink]],
    ['qa_editor', editorRequest, [addLink]],
  ])('heads the page with Content Staging and the list menu for %s', async (_who, preset, links) => {
    const { model, $ } = await rendered({}, undefined, preset);

    expect(model.headings[0]).toBe('Content Staging');
    expect($('.mura-header .nav-module-specific a').toArray().map((a) => [$(a).text().trim(), $(a).attr('href')])).toEqual(links);
  });

  it('renders the filter form, its labels and controls', async () => {
    const { model, $ } = await rendered();
    const control = (name: string) => model.controls.filter((c) => c.name === name).map(({ type, value }) => ({ type, value }));

    expect($('#navFiltersToggle').text()).toBe('Advanced Filters');
    expect($('form[name="searchFrm"]')).toHaveLength(1);
    expect(model.labels).toEqual(['Keywords', 'From', 'To', 'Categories', 'Tags']);
    expect(control('keywords')).toEqual([{ type: 'text', value: '' }]);
    expect($('input[name="keywords"]').attr('maxlength')).toBe('50');
    expect(['startDate', 'stopDate'].map((name) => $(`input[name="${name}"]`).attr('class'))).toEqual([
      'datepicker text',
      'datepicker text',
    ]);
    expect(control('tags')).toEqual([{ type: 'text', value: '' }]);
    expect(control('siteID')).toEqual([{ type: 'hidden', value: SITE }]);
    expect(control('muraAction')).toEqual([{ type: 'hidden', value: 'cChangesets.list' }]);
    expect(model.buttons).toEqual([{ text: 'Filter', type: 'submit', hasOnclick: true }]);
    expect($('button[type="submit"]').attr('class')).toBe('btn mura-primary');
  });

  it('reproduces day-of-year mask in the date filters, To one day on as list() leaves it', async () => {
    const { $ } = await rendered({ startdate: '2026-10-29', stopdate: '2026-10-30' });

    expect($('input[name="startDate"]').val()).toBe('10/302/2026');
    // list() moves rc.stopdate one day on before the view formats it, so 2026-10-30 shows as 2026-10-31.
    expect($('input[name="stopDate"]').val()).toBe('10/304/2026');
  });

  it.each<[string, Filters, boolean]>([
    ['no filter', {}, false],
    ['keywords', { keywords: 'home' }, true],
    ['tags', { tags: 'news' }, true],
    ['categoryid', { categoryid: CATEGORY_IDS.topicsNews }, true],
    ['startdate', { startdate: '2026-10-29' }, true],
    ['stopdate', { stopdate: '2026-10-29' }, true],
  ])('offers Remove Filter for %s: %s', async (_case, filters, shown) => {
    const { $ } = await rendered(filters);
    const button = $('button[name="removeFilter"]');

    expect(button).toHaveLength(shown ? 1 : 0);
    if (shown) expect(button.attr('onclick')).toBe(`location.href='./?siteID=${SITE}&muraAction=cChangesets.list'`);
  });

  it('lists each selected tag as a span with its hidden input', async () => {
    const { $ } = await rendered({ tags: 'news,events' });
    const spans = $('#tags span.tag');

    expect(spans.toArray().map((span) => $(span).contents().first().text().trim())).toEqual(['news', 'events']);
    expect($('#tags input[type="hidden"][name="tags"]').toArray().map((input) => $(input).val())).toEqual(['news', 'events']);
  });

  it('nests the categories under the level-0 checkbox tree with the rc selection', async () => {
    const { $ } = await rendered({ categoryid: CATEGORY_IDS.topicsEventsLocal });
    const boxes = (selector: string): string[] =>
      $(`#category-select-list input[name="categoryID"]${selector}`).toArray().map((box) => $(box).attr('value') ?? '');
    const interests = $(`input[value="${INTEREST_CATEGORY_IDS.newsletter}"]`).closest('ul').parent('li');

    expect($('div#mura-list-tree.mura-6.mura-control-group.category-select')).toHaveLength(1);
    expect($('#mura-list-tree > #category-select-control')).toHaveLength(1);
    expect($('#category-select-list > ul.categories.checkboxTree')).toHaveLength(1);
    expect($('#category-select-list ul ul').toArray().map((ul) => $(ul).attr('class'))).toEqual(['categories', 'categories', 'categories']);
    expect(boxes('[checked]')).toEqual([CATEGORY_IDS.topicsEventsLocal]);
    expect(boxes('[disabled]')).toEqual([CATEGORY_IDS.restricted]);
    expect(interests.children('input')).toHaveLength(0);
    expect(interests.clone().children().remove().end().text().trim()).toBe('Interests');
  });

  it('leaves out the category block when the site has no categories', async () => {
    const { model, $ } = await rendered({}, (data) => ({ ...data, categoryCount: 0, categories: [] }));

    expect($('#mura-list-tree')).toHaveLength(0);
    expect(model.labels).toEqual(['Keywords', 'From', 'To', 'Tags']);
  });

  it('tabulates the change sets under the legacy headers', async () => {
    const { model } = await rendered();

    expect(model.tables).toEqual([
      {
        headers: ['', 'Name', 'Date to Publish', 'Last Update'],
        rows: [
          ['Edit Preview Assignments Delete', 'Summer Refresh', 'NA', '06/180/2026 4:20 PM'],
          ['Edit Preview Assignments Delete', 'Autumn Launch', '07/196/2026 9:00 AM', '06/181/2026 10:45 AM'],
          ['Edit Assignments Delete', 'Spring Cleanup', '05/121/2026 8:00 AM', '06/179/2026 2:30 PM'],
        ],
      },
    ]);
  });

  it.each<[string, string, boolean]>([
    ['the unscheduled set', CHANGESET_IDS.open, true],
    ['the scheduled set', CHANGESET_IDS.scheduled, true],
    ['the published set', CHANGESET_IDS.published, false],
  ])('links the actions and name of %s', async (_case, id, previewed) => {
    const cat = CATEGORY_IDS.topicsNews;
    const { $ } = await rendered({ categoryid: cat, tags: 'news' });
    const row = $(`li.edit a[href*="changesetID=${id}&"]`).closest('tr');
    const keys = `changesetID=${id}&siteid=${SITE}&categoryid=${cat}`;

    expect(row.find('li.edit a').attr('href')).toBe(`./?muraAction=cChangesets.edit&${keys}&tags=news`);
    expect(row.find('li.preview a').attr('onclick')).toBe(
      previewed ? `return preview('http://${SITE}.localhost:8100/?changesetID=${id}');` : undefined,
    );
    expect(row.find('li.preview a').attr('href')).toBe(previewed ? '#' : undefined);
    expect(row.find('li.change-sets a').attr('href')).toBe(`./?muraAction=cChangesets.assignments&${keys}`);
    expect(row.find('li.delete a').attr('href')).toBe(`./?muraAction=cChangesets.delete&${keys}&tags=news${CSRF_URL}`);
    // esapiEncode('javascript') escapes the confirm text's spaces and question mark.
    expect(row.find('li.delete a').attr('onclick')).toBe("return confirmDialog('Delete\\x20Change\\x20Set\\x3F',this.href)");
    expect(row.find('td.var-width a').attr('href')).toBe(`./?muraAction=cChangesets.assignments&${keys}&tags=news`);
  });

  it('notes an empty page without table or paging', async () => {
    const { $ } = await rendered({}, (data) => ({ ...data, rows: [] }));

    expect($('.help-block-empty').text()).toBe('There are currently no change sets.');
    expect($('table')).toHaveLength(0);
    expect($('.pagination')).toHaveLength(0);
  });

  it('pages with the summary, both arrows and the unquoted tags of page links', async () => {
    const cat = CATEGORY_IDS.topicsNews;
    const paging = { pageIndex: 2, pageCount: 3, recordCount: 45, firstRecordOnPage: 21, lastRecordOnPage: 40 };
    const { markup, $ } = await rendered({ categoryid: cat, tags: 'news,events' }, (data) => ({ ...data, paging }));
    const page = (n: number): string =>
      `./?muraAction=cChangesets.list&page=${n}&siteid=${SITE}&keywords=&startdate=&stopdate=&categoryid=${cat}`;

    expect($('p.search-showing').text().trim()).toBe('Showing 21-40 of 45 Results');
    expect($('ul.pagination.moreResults')).toHaveLength(1);
    expect($('a:has(i.mi-angle-left)').attr('href')).toBe(`${page(1)}&tags=news%2Cevents`);
    expect($('a:has(i.mi-angle-right)').attr('href')).toBe(`${page(3)}&tags=news%2Cevents`);
    expect($('li.active').text()).toBe('2');
    expect($('li.active a').attr('href')).toBe('#');
    // list.cfm:231 closes the href before `&tags=`, which follows as stray attribute text.
    expect($('ul.pagination li:not(.active) a:not(:has(i))').toArray().map((a) => $(a).attr('href'))).toEqual([page(1), page(3)]);
    expect(markup).toContain(`<a href="${page(1)}"&tags=news%2Cevents>1</a>`);
  });

  it('writes a change-set name as text', async () => {
    const { markup, $ } = await rendered({}, (data) => ({
      ...data,
      rows: data.rows.slice(0, 1).map((row) => ({ ...row, name: 'Fall <b>& Winter' })),
    }));

    expect($('td.var-width a').text()).toBe('Fall <b>& Winter');
    expect($('td.var-width b')).toHaveLength(0);
    expect(markup).toContain('Fall &lt;b&gt;&amp; Winter');
  });
});

describe('renderCategoriesNest', () => {
  const nest = (nodes: readonly ChangesetCategoryNode[], categoryIds: string, nestLevel?: number): cheerio.CheerioAPI =>
    cheerio.load(toString(renderCategoriesNest({ nodes, categoryIds, nestLevel })), null, false);

  it('renders nothing without rows', () => {
    expect(toString(renderCategoriesNest({ nodes: [], categoryIds: CATEGORY_IDS.topics, nestLevel: 0 }))).toBe('');
  });

  it.each<[number, string]>([
    [0, 'categories checkboxTree'],
    [1, 'categories'],
  ])('gives the fixture tree at nest level %i the class "%s", its children plain lists', async (nestLevel, className) => {
    const $ = nest(await fixtureTree(), '', nestLevel);

    expect($.root().children('ul').attr('class')).toBe(className);
    expect(new Set($('ul ul').toArray().map((ul) => $(ul).attr('class')))).toEqual(new Set(['categories']));
  });

  it('checks the listed ids at every level', async () => {
    const $ = nest(await fixtureTree(), `${CATEGORY_IDS.topicsNews},${CATEGORY_IDS.topicsEventsLocal}`, 0);

    expect($('input[checked]').toArray().map((box) => $(box).attr('value'))).toEqual([
      CATEGORY_IDS.topicsNews,
      CATEGORY_IDS.topicsEventsLocal,
    ]);
  });

  it('HTML-encodes the category name', () => {
    const node: ChangesetCategoryNode = {
      categoryId: CATEGORY_IDS.topics,
      name: 'A & <B>',
      isOpen: true,
      permitted: true,
      children: [],
    };
    const markup = toString(renderCategoriesNest({ nodes: [node], categoryIds: '' }));

    expect(markup).toContain('A &amp; &lt;B&gt;');
    expect(cheerio.load(markup, null, false)('li').text().trim()).toBe('A & <B>');
  });
});

describe('changesetListScreen', () => {
  it('declares a strategies-content page', () => {
    expect(changesetListScreen).toMatchObject({
      circuit: 'cchangesets',
      action: 'list',
      mode: 'page',
      owner: 'strategies-content',
    });
  });

  it('loads and renders the registered list inside the shell', async () => {
    const def = cchangesetsScreens.find((screen) => screen.action === 'list');
    if (def === undefined) throw new Error('cchangesets.list is not registered');

    const page = await renderScreenPage(def, contextFor(listRequest()));

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const model = domModel(page.html);
    expect(page.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(model.title).toBe('Masa CMS - Content Staging');
    expect(model.headings).toEqual(['Content Staging']);
    expect(model.tables.at(-1)?.rows.map((row) => row[1])).toEqual(['Summer Refresh', 'Autumn Launch', 'Spring Cleanup']);
  });
});
