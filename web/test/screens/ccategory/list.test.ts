// cCategory.list against ccategory/list.cfm and dsp_nest.cfm: the site's category tree from strategies-content.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { encodeJs, toString } from '@/lib/html';
import {
  collectCategoryIds,
  renderCategoryNest,
  toCategoryTree,
  type CategoryNode,
} from '@/screens/ccategory/dsp-nest';
import { renderCategoryAjax } from '@/screens/ccategory/js';
import { loadCcategoryList, renderCcategoryList } from '@/screens/ccategory/list';
import {
  CATEGORY_IDS,
  CCATEGORY_PATHS,
  INTEREST_CATEGORY_IDS,
  ccategoryListData,
} from '../../fixtures/strategies-content/categories';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { domModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';
import {
  ALPHA_ID,
  BETA_ID,
  CSRF_URL,
  GAMMA_ID,
  LIST_ROUTE,
  categoryGateway,
  categoryRow,
  categoryTree,
  contextFor,
  legacyBody,
} from './support';

const DELTA_ID = 'CA000000-0000-0000-0000000000000004';

/** The S2 admin on `default` requesting `cCategory.list`. */
const listRequest = (rc: Record<string, string> = {}) => adminS2Request({ circuit: 'cCategory', item: 'list', rc });

/** A list context whose strategies-content answers `rows` as `rc.categories`. */
function listContext(rows: unknown) {
  const reply = { status: 200, body: { rc: { categories: rows } } };
  return contextFor(listRequest(), categoryGateway({ [LIST_ROUTE]: reply }));
}

async function renderedBody(rows: unknown): Promise<string> {
  const ctx = listContext(rows);
  return toString(renderCcategoryList(ctx, await loadCcategoryList(ctx)).body);
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('loadCcategoryList', () => {
  it("reads rc.siteid's tree once and prefetches every category's delete tokens in tree order", async () => {
    const ctx = listContext(categoryTree());
    const data = await loadCcategoryList(ctx);

    expect(data.categories.map((node) => node.categoryID)).toEqual([ALPHA_ID, DELTA_ID]);
    expect(data.categories[0]?.children[0]?.children[0]).toMatchObject({ categoryID: GAMMA_ID, parentID: BETA_ID });
    expect(ctx.gateway.calls.map(({ service, method, path }) => `${method} ${service} ${path}`)).toEqual([
      'GET strategies-content /v1/sites/default/categories',
      'POST identity /v1/csrf/tokens',
    ]);
    expect(ctx.gateway.calls[1]?.json).toEqual({ contexts: [ALPHA_ID, BETA_ID, GAMMA_ID, DELTA_ID] });
  });

  it('asks identity for no tokens when the site has no categories', async () => {
    const ctx = listContext([]);
    expect(await loadCcategoryList(ctx)).toEqual({ categories: [] });
    expect(ctx.gateway.calls.map(({ path }) => path)).toEqual(['/v1/sites/default/categories']);
  });

  it.each([
    { status: 401 as const },
    { status: 403 as const },
  ])('turns a $status answer into a GatewayDenialError', async ({ status }) => {
    const ctx = contextFor(listRequest(), categoryGateway({ [LIST_ROUTE]: { status } }));
    await expect(loadCcategoryList(ctx)).rejects.toThrow(GatewayDenialError);
  });

  it.each([
    { label: 'no rc.categories', rc: {} },
    { label: 'a row without children', rc: { categories: [{ categoryID: ALPHA_ID, name: 'Alpha' }] } },
    { label: 'a row that is not a struct', rc: { categories: ['Alpha'] } },
  ])('rejects a model with $label', async ({ rc }) => {
    const ctx = contextFor(listRequest(), categoryGateway({ [LIST_ROUTE]: { status: 200, body: { rc } } }));
    await expect(loadCcategoryList(ctx)).rejects.toThrow(TypeError);
  });
});

describe('renderCcategoryList', () => {
  it('renders the empty site byte for byte as the legacy capture, with the js.cfm block as request.ajax', async () => {
    const ctx = listContext([]);
    const view = renderCcategoryList(ctx, await loadCcategoryList(ctx));

    expect(toString(view.body)).toBe(legacyBody('ccategory-list-empty.html'));
    expect(view.ajax && toString(view.ajax)).toBe(toString(renderCategoryAjax(ctx.rb)));
  });

  it('writes a top-level row with the whitespace the tag emits, inside the table it opens', async () => {
    const delta = categoryRow(DELTA_ID, 'Delta', { isOpen: 0, isActive: 0, restrictGroups: 'Editor' });
    const body = await renderedBody([delta]);
    const row = `
<tr>
<td class="add">
 <a href="javascript:;"  onclick="categoryManager.showMenu('newContentMenu',this,'${DELTA_ID}','default');"><i class="mi-ellipsis-v"></i></a></td>
<td class="var-width"><ul class="nestoff"><li class="CategoryLocked"><a title="Edit" href="./?muraAction=cCategory.edit&categoryID=${DELTA_ID}&parentID=&siteid=default">Delta</a></li></ul></td>
<td><i class="mi-ban" title="No"></i>
<span>No</span></td>

<td>
\t
\t\t<i class="mi-check" title="Yes"></i>
\t
\t<span>Yes</span>
</td>

<td>
\t
\t<i class="mi-ban" title="No"></i>
\t
\t<span>No</span>
</td>
<td class="actions hide"><ul><li class="edit"><a title="Edit" href="./?muraAction=cCategory.edit&categoryID=${DELTA_ID}&parentID=&siteid=default"><i class="mi-pencil"></i></a></li><li class="delete"><a title="Delete" href="./?muraAction=cCategory.update&action=delete&categoryID=${DELTA_ID}&siteid=default${CSRF_URL}" onClick="return confirmDialog('Delete\\x20Category\\x3F',this.href)"><i class="mi-trash"></i></a></li></ul></td>
</tr>
`;
    const table = `\t\t\t\t\t\t
\t<table class="mura-table-grid">
\t<thead>
\t<tr>
\t<th class="add"></th>
\t<th class="var-width">Category</th>
\t<th>Assignable</th>
\t<th>Interest Group</th>
\t<th>Active</th>
\t<th class="actions hide"></th>
\t</tr>
\t<thead>
\t<tbody class="nest">
\t${row}
\t</tbody>
\t</table>

\t\t\t\t<div class="clearfix"></div>`;
    expect(body).toContain(table);
  });

  it('flattens the tree into rows whose nest class, lock and flags follow each category', async () => {
    const $ = cheerio.load(await renderedBody(categoryTree()));
    const rows = $('table.mura-table-grid tbody.nest > tr')
      .toArray()
      .map((tr) => {
        const cells = $(tr).children('td');
        return {
          nest: $(cells[1]).find('ul').attr('class'),
          item: $(cells[1]).find('li').attr('class'),
          name: $(cells[1]).find('a').text(),
          edit: $(cells[1]).find('a').attr('href'),
          flags: [2, 3, 4].map((index) =>
            [$(cells[index]).find('i').attr('class'), $(cells[index]).find('span').text()].join(':'),
          ),
        };
      });

    expect(rows).toEqual([
      {
        nest: 'neston',
        item: 'Category',
        name: 'Alpha & Co',
        edit: `./?muraAction=cCategory.edit&categoryID=${ALPHA_ID}&parentID=&siteid=default`,
        flags: ['mi-check:Yes', 'mi-check:Yes', 'mi-check:Yes'],
      },
      {
        nest: 'nest1on',
        item: 'Category',
        name: 'Beta <b>',
        edit: `./?muraAction=cCategory.edit&categoryID=${BETA_ID}&parentID=${ALPHA_ID}&siteid=default`,
        flags: ['mi-check:Yes', 'mi-ban:No', 'mi-check:Yes'],
      },
      {
        nest: 'nest2off',
        item: 'Category',
        name: 'Gamma',
        edit: `./?muraAction=cCategory.edit&categoryID=${GAMMA_ID}&parentID=${BETA_ID}&siteid=default`,
        flags: ['mi-check:Yes', 'mi-check:Yes', 'mi-check:Yes'],
      },
      {
        nest: 'nestoff',
        item: 'CategoryLocked',
        name: 'Delta',
        edit: `./?muraAction=cCategory.edit&categoryID=${DELTA_ID}&parentID=&siteid=default`,
        flags: ['mi-ban:No', 'mi-check:Yes', 'mi-ban:No'],
      },
    ]);
  });

  it('HTML-encodes names and JS-, URL-encodes the site id as the view does', async () => {
    const ctx = contextFor(
      listRequest({ siteid: "o'site&x" }),
      categoryGateway({
        [routeKey('GET', 'strategies-content', `/v1/sites/${encodeURIComponent("o'site&x")}/categories`)]: {
          status: 200,
          body: { rc: { categories: [categoryRow(ALPHA_ID, 'Alpha & <Co>')] } },
        },
      }),
    );
    const body = toString(renderCcategoryList(ctx, await loadCcategoryList(ctx)).body);

    expect(body).toContain(`<a title="Edit" href="./?muraAction=cCategory.edit&categoryID=${ALPHA_ID}&parentID=&siteid=o%27site%26x">Alpha &amp; &lt;Co&gt;</a>`);
    expect(body).toContain(`'${ALPHA_ID}','o\\x27site\\x26x');"`);
    expect(body).toContain(`&categoryID=${ALPHA_ID}&siteid=o%27site%26x${CSRF_URL}"`);
  });

  it.each([
    { label: 'yes', value: 'yes', icon: 'mi-check', text: 'Yes' },
    { label: 'true', value: true, icon: 'mi-check', text: 'Yes' },
    { label: '0', value: '0', icon: 'mi-ban', text: 'No' },
  ])('reads isOpen $label as CFML does', async ({ value, icon, text }) => {
    const body = await renderedBody([categoryRow(ALPHA_ID, 'Alpha', { isOpen: value })]);
    const $ = cheerio.load(body);
    const cell = $('tbody.nest > tr > td').eq(2);
    const parts = [cell.find('i').attr('class'), cell.find('i').attr('title'), cell.find('span').text()];
    expect(parts).toEqual([icon, text, text]);
  });

  it('fails as legacy does on a flag CFML cannot read as a boolean', async () => {
    const ctx = listContext([categoryRow(ALPHA_ID, 'Alpha', { isOpen: null })]);
    const data = await loadCcategoryList(ctx);
    expect(() => renderCcategoryList(ctx, data)).toThrow(TypeError);
  });
});

const SITE = 'tenant-a';
const FIXTURE_ROUTE = routeKey('GET', 'strategies-content', CCATEGORY_PATHS.list);
const BLOCK_CONTENT = 'div.block.block-constrain > div.block.block-bordered > div.block-content';

/** The tenant-a site admin's `cCategory.list` context, strategies-content answering `reply`. */
function fixtureContext(reply: FakeReply = { status: 200, body: ccategoryListData }) {
  const req = siteAdminRequest(SITE, { circuit: 'cCategory', item: 'list' });
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [FIXTURE_ROUTE]: reply }) });
}

/** The fixture list answer with `categories` in place of its tree. */
const listAnswer = (categories: readonly unknown[]): FakeReply => ({
  status: 200,
  body: { ...ccategoryListData, rc: { ...ccategoryListData.rc, categories } },
});

/** The screen of {@link fixtureContext} over `reply`: its context, view and body markup. */
async function renderFixture(reply?: FakeReply) {
  const ctx = fixtureContext(reply);
  const view = renderCcategoryList(ctx, await loadCcategoryList(ctx));
  return { ctx, view, body: toString(view.body) };
}

/** Each node of `nodes` depth-first, with the nest level the tag renders it at. */
function withLevels(nodes: readonly CategoryNode[], level = 0): Array<{ node: CategoryNode; level: number }> {
  return nodes.flatMap((node) => [{ node, level }, ...withLevels(node.children, level + 1)]);
}

/** `nodes` as flat `getCategories` rows, without the `children` and `hasKids` the nesting derives. */
const flatRows = (nodes: readonly CategoryNode[]) =>
  withLevels(nodes).map(({ node: { children: _children, hasKids: _hasKids, ...row } }) => row);

/** The category id a row's add-menu onclick passes to `showMenu`. */
const rowIdOf = (onclick: string | undefined): string | undefined =>
  /showMenu\('newContentMenu',this,'([^']*)'/.exec(onclick ?? '')?.[1];

describe('toCategoryTree', () => {
  it('keeps the service order and nesting of the pooled tree', () => {
    const tree = toCategoryTree(ccategoryListData);

    expect(tree).toEqual(ccategoryListData.rc['categories']);
    expect(withLevels(tree).map(({ node, level }) => [node.name, level])).toEqual([
      ['General Topics', 0],
      ['Agency News', 1],
      ['Events', 1],
      ['Local Events', 2],
      ['Interests', 0],
      ['Newsletter', 1],
      ['Outreach Volunteering', 1],
      ['Skills Training', 1],
      ['Legacy Archive', 0],
      ['Restricted Notices', 0],
    ]);
    for (const { node } of withLevels(tree)) {
      expect(node.children.map((child) => child.parentID)).toEqual(node.children.map(() => node.categoryID));
    }
  });

  it('nests flat rows under their parent ids, ignoring case, and counts their kids', () => {
    const rows = flatRows(toCategoryTree(ccategoryListData));
    expect(toCategoryTree({ rc: { categories: rows } })).toEqual(toCategoryTree(ccategoryListData));

    const lowered = rows.map((row) =>
      row.categoryID === CATEGORY_IDS.topicsEventsLocal ? { ...row, parentID: row.parentID.toLowerCase() } : row,
    );
    const events = toCategoryTree({ rc: { categories: lowered } })[0]?.children[1];
    expect(events?.categoryID).toBe(CATEGORY_IDS.topicsEvents);
    expect(events?.children.map((node) => node.categoryID)).toEqual([CATEGORY_IDS.topicsEventsLocal]);
    expect(events?.hasKids).toBe(1);
  });

  it('rejects a category nested under itself', () => {
    const row = (categoryID: string, parentID: string) => ({
      categoryID,
      parentID,
      name: categoryID,
      isOpen: 1,
      isInterestGroup: 0,
      isActive: 1,
      restrictGroups: '',
    });
    const rows = [row(ALPHA_ID, ''), row(BETA_ID, ALPHA_ID), row(ALPHA_ID, BETA_ID)];
    expect(() => toCategoryTree({ rc: { categories: rows } })).toThrow(TypeError);
  });

  it('rejects a flag that is not a simple value', () => {
    const rows = flatRows(toCategoryTree(ccategoryListData)).map((row) => ({ ...row, isActive: { value: row.isActive } }));
    expect(() => toCategoryTree({ rc: { categories: rows } })).toThrow('isActive is not a simple value');
  });
});

describe('collectCategoryIds', () => {
  it('lists every id depth-first once', () => {
    const ids = collectCategoryIds(toCategoryTree(ccategoryListData));

    expect(ids).toEqual([
      CATEGORY_IDS.topics,
      CATEGORY_IDS.topicsNews,
      CATEGORY_IDS.topicsEvents,
      CATEGORY_IDS.topicsEventsLocal,
      INTEREST_CATEGORY_IDS.interests,
      INTEREST_CATEGORY_IDS.newsletter,
      INTEREST_CATEGORY_IDS.volunteering,
      INTEREST_CATEGORY_IDS.training,
      CATEGORY_IDS.inactiveArchive,
      CATEGORY_IDS.restricted,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('renderCategoryNest', () => {
  it('writes only the no-categories notice for an empty level', () => {
    const ctx = fixtureContext();
    const markup = toString(renderCategoryNest({ nodes: [], siteid: SITE, rb: ctx.rb, csrf: ctx.csrf }));
    const $ = cheerio.load(markup, null, false);

    expect($('div.help-block-empty').text()).toBe('This site currently has no categories.');
    expect($('table')).toHaveLength(0);
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('reads the siteId spelling of the site attribute as siteid', async () => {
    const ctx = fixtureContext();
    const nodes = toCategoryTree(ccategoryListData);
    await ctx.csrf.prefetch(collectCategoryIds(nodes));
    const input = { nodes, rb: ctx.rb, csrf: ctx.csrf };

    expect(toString(renderCategoryNest({ ...input, siteId: SITE }))).toBe(
      toString(renderCategoryNest({ ...input, siteid: SITE })),
    );
  });
});

describe('cCategory.list on the pooled tenant-a tree', () => {
  it("reads tenant-a's tree once without pool parameters, then every category's delete tokens", async () => {
    const { ctx } = await renderFixture();

    expect(ctx.req.action).toBe('core:ccategory.list');
    expect(ctx.gateway.calls.map(({ service, method, path, query }) => ({ service, method, path, query }))).toEqual([
      { service: 'strategies-content', method: 'GET', path: `/v1/sites/${SITE}/categories`, query: undefined },
      { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', query: undefined },
    ]);
    expect(ctx.gateway.calls[1]?.json).toEqual({ contexts: collectCategoryIds(toCategoryTree(ccategoryListData)) });
  });

  it('places the heading, its menu and the nest in the legacy blocks', async () => {
    const { ctx, view, body } = await renderFixture();
    const $ = cheerio.load(body, null, false);
    const header = $('div.mura-header');
    const add = header.find('div.nav-module-specific.btn-group > a.btn').first();
    const content = $(BLOCK_CONTENT);

    expect(header.children('h1').text()).toBe('Categories');
    expect([add.text().trim(), add.attr('href')]).toEqual([
      'Add Category',
      `./?muraAction=cCategory.edit&categoryID=&parentID=&siteid=${SITE}`,
    ]);
    expect(content.children().toArray().map((el) => $(el).attr('class'))).toEqual(['mura-table-grid', 'clearfix']);
    expect(String(view.ajax)).toBe(String(renderCategoryAjax(ctx.rb)));
  });

  it('keeps the malformed thead', async () => {
    const { body } = await renderFixture();
    const $ = cheerio.load(body, null, false);
    const heads = $('table.mura-table-grid > thead');

    expect(body.split('<thead>')).toHaveLength(3);
    expect(body).not.toContain('</thead>');
    expect(body.split('<tbody class="nest">')).toHaveLength(2);
    expect(heads).toHaveLength(2);
    expect(domModel(body).tables[0]?.headers).toEqual(['', 'Category', 'Assignable', 'Interest Group', 'Active', '']);
    expect(heads.first().find('th').toArray().map((th) => $(th).attr('class') ?? '')).toEqual([
      'add',
      'var-width',
      '',
      '',
      '',
      'actions hide',
    ]);
  });

  it('renders depth-first rows with the nest class, lock, links and flags of each category', async () => {
    const { body } = await renderFixture();
    const tree = toCategoryTree(ccategoryListData);
    const $ = cheerio.load(body, null, false);
    const rows = $('table.mura-table-grid > tbody.nest > tr')
      .toArray()
      .map((tr) => $(tr).children('td'));
    const tokens = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;

    expect(rows.map((cells) => rowIdOf(cells.eq(0).children('a').attr('onclick')))).toEqual(collectCategoryIds(tree));

    const expected = withLevels(tree).map(({ node, level }) => {
      const edit = `./?muraAction=cCategory.edit&categoryID=${node.categoryID}&parentID=${node.parentID}&siteid=${SITE}`;
      return {
        cells: ['add', 'var-width', '', '', '', 'actions hide'],
        menu: `categoryManager.showMenu('newContentMenu',this,'${node.categoryID}','${encodeJs(SITE)}');`,
        nest: `nest${level === 0 ? '' : level}${node.hasKids ? 'on' : 'off'}`,
        item: node.restrictGroups === '' ? 'Category' : 'CategoryLocked',
        name: node.name,
        edit: [edit, edit],
        remove: `./?muraAction=cCategory.update&action=delete&categoryID=${node.categoryID}&siteid=${SITE}${tokens}`,
        confirm: `return confirmDialog('${encodeJs('Delete Category?')}',this.href)`,
        icons: ['mi-ellipsis-v', 'mi-pencil', 'mi-trash'],
        flags: [node.isOpen, node.isInterestGroup, node.isActive].map((flag) =>
          flag ? 'mi-check:Yes:Yes' : 'mi-ban:No:No',
        ),
      };
    });
    const actual = rows.map((cells) => {
      const name = cells.eq(1).find('ul > li > a[title="Edit"]');
      const actions = cells.eq(5).children('ul');
      const remove = actions.find('li.delete > a[title="Delete"]');
      return {
        cells: cells.toArray().map((td) => $(td).attr('class') ?? ''),
        menu: cells.eq(0).children('a').attr('onclick'),
        nest: cells.eq(1).children('ul').attr('class'),
        item: cells.eq(1).find('ul > li').attr('class'),
        name: name.text(),
        edit: [name.attr('href'), actions.find('li.edit > a[title="Edit"]').attr('href')],
        remove: remove.attr('href'),
        confirm: remove.attr('onclick'),
        icons: [cells.eq(0).find('i'), actions.find('li.edit i'), remove.find('i')].map((icon) => icon.attr('class')),
        flags: [2, 3, 4].map((index) => {
          const icon = cells.eq(index).children('i');
          return [icon.attr('class'), icon.attr('title'), cells.eq(index).children('span').text()].join(':');
        }),
      };
    });
    expect(actual).toEqual(expected);
  });

  it('asks the CSRF renderer for the url tokens of every category', async () => {
    const ctx = fixtureContext();
    const data = await loadCcategoryList(ctx);
    const render = vi.spyOn(ctx.csrf, 'render');
    renderCcategoryList(ctx, data);

    expect(render.mock.calls).toEqual(collectCategoryIds(data.categories).map((id) => [id, 'url']));
    await expect(ctx.csrf.tokens(CATEGORY_IDS.restricted)).resolves.toEqual(FIXED_CSRF);
  });

  it('html-encodes a name the markup would otherwise read', async () => {
    const name = 'Topics <b>& "Events"</b>';
    const tree = toCategoryTree(ccategoryListData).map((node, index) => (index === 0 ? { ...node, name } : node));
    const { body } = await renderFixture(listAnswer(tree));
    const link = cheerio.load(body, null, false)('td.var-width a').first();

    expect(link.text()).toBe(name);
    expect(body).toContain('>Topics &lt;b&gt;&amp; &quot;Events&quot;&lt;&#x2f;b&gt;</a>');
    expect(body).not.toContain('<b>');
  });

  it('writes the notice before the clearfix when the site has no categories', async () => {
    const { ctx, body } = await renderFixture(listAnswer([]));
    const $ = cheerio.load(body, null, false);
    const content = $(BLOCK_CONTENT);

    expect(content.children().toArray().map((el) => $(el).attr('class'))).toEqual(['help-block-empty', 'clearfix']);
    expect(content.children('div.help-block-empty').text()).toBe('This site currently has no categories.');
    expect($('table')).toHaveLength(0);
    expect(ctx.gateway.calls.map(({ service }) => service)).toEqual(['strategies-content']);
  });
});

describe('cCategory.list when strategies-content is unavailable', () => {
  it.each([
    { label: 'cannot be reached', status: undefined, arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    {
      label: 'answers 503',
      status: 503,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(FIXTURE_ROUTE, { status: 503 }),
    },
  ])('rejects with GatewayUnavailableError when it $label', async ({ status, arrange }) => {
    const ctx = fixtureContext();
    arrange(ctx.gateway);
    const error: unknown = await loadCcategoryList(ctx).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'strategies-content', status });
    expect(ctx.gateway.calls.map(({ service }) => service)).toEqual(['strategies-content']);
  });
});
