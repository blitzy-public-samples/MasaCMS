// cCategory.list against ccategory/list.cfm and dsp_nest.cfm: the site's category tree from strategies-content.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDenialError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { renderCategoryAjax } from '@/screens/ccategory/js';
import { loadCcategoryList, renderCcategoryList } from '@/screens/ccategory/list';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { routeKey } from '../../helpers/fake-gateway';
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
