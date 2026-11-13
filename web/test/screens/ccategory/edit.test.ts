// cCategory.edit against ccategory/edit.cfm and dsp_parents.cfm: the category form over strategies-content.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { GatewayDenialError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { categoryEditDataOf, loadCcategoryEdit, renderCcategoryEdit } from '@/screens/ccategory/edit';
import { renderCategoryAjax } from '@/screens/ccategory/js';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import type { FakeReply } from '../../helpers/fake-gateway';
import {
  ALPHA_ID,
  BETA_ID,
  CSRF_PAIR,
  GAMMA_ID,
  categoryGateway,
  categoryRoute,
  categoryTree,
  contextFor,
  legacyBody,
} from './support';

const DELTA_ID = 'CA000000-0000-0000-0000000000000004';
const EDITOR_GROUP = { userID: '6A000000-0000-0000-0000000000000002', groupName: 'Editor', isPublic: 0 };
const FRIENDS_GROUP = { userID: '6A000000-0000-0000-0000000000000003', groupName: 'Friends', isPublic: 1 };

/** `categoryManager.read` of an id that matches no category: the new bean's defaults. */
const NEW_BEAN = Object.freeze({
  categoryID: '',
  siteID: 'default',
  name: '',
  URLTitle: '',
  isInterestGroup: 1,
  isOpen: 1,
  isfeatureable: 1,
  isActive: 1,
  restrictGroups: '',
  notes: '',
  errors: {},
});

/** A saved Beta below Alpha, every flag off, restricted to the member group Friends and to Editor. */
const SAVED_BEAN = Object.freeze({
  ...NEW_BEAN,
  categoryID: BETA_ID,
  parentID: ALPHA_ID,
  name: 'Beta "quoted" & <b>',
  URLTitle: 'beta-<b>',
  isInterestGroup: 0,
  isOpen: 0,
  isfeatureable: 0,
  isActive: 0,
  restrictGroups: 'friends,Editor',
  notes: 'Line <1> & 2',
});

/** A `getCategory` screen model. */
const model = (categoryBean: object, fields: Record<string, unknown> = {}) => ({
  rc: { categoryBean, rsRestrictGroups: [EDITOR_GROUP], categories: [], ...fields },
});

/** The S2 admin on `default` requesting `cCategory.edit` with `rc`. */
const editRequest = (rc: Record<string, string>) => adminS2Request({ circuit: 'cCategory', item: 'edit', rc });

/** The form rendered for `rc` over the loaded `getCategory` answer for `categoryid`. */
async function loadAndRender(rc: Record<string, string>, categoryid: string, reply: FakeReply): Promise<string> {
  const ctx = contextFor(editRequest(rc), categoryGateway({ [categoryRoute(categoryid)]: reply }));
  return toString(renderCcategoryEdit(ctx, await loadCcategoryEdit(ctx)).body);
}

/** The form rendered for `rc` over `screenModel`, with the bean's tokens fetched as the loader fetches them. */
async function renderModel(rc: Record<string, string>, screenModel: { rc: Record<string, unknown> }): Promise<string> {
  const ctx = contextFor(editRequest(rc), categoryGateway());
  const data = categoryEditDataOf(screenModel.rc);
  await ctx.csrf.prefetch([data.bean.categoryID]);
  return toString(renderCcategoryEdit(ctx, data).body);
}

/** Values of the options `options` selects, `*` marking the selected ones. */
function optionsOf($: cheerio.CheerioAPI, options: string | ReturnType<cheerio.CheerioAPI>): string[] {
  return (typeof options === 'string' ? $(options) : options)
    .toArray()
    .map((option) => `${$(option).attr('value') ?? ''}${$(option).attr('selected') === undefined ? '' : '*'}`);
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('loadCcategoryEdit', () => {
  it.each([
    { label: 'an empty id', categoryID: '' },
    { label: 'an id longer than a category id', categoryID: 'X'.repeat(36) },
  ])('reads a fresh CF UUID for $label, which names no category', async ({ categoryID }) => {
    const ctx = contextFor(editRequest({ categoryID, parentID: '' }), categoryGateway());
    await expect(loadCcategoryEdit(ctx)).rejects.toThrow('getCategory answered HTTP 404');
    const path = ctx.gateway.calls[0]?.path ?? '';
    expect(path.startsWith('/v1/sites/default/categories/')).toBe(true);
    expect(isCfUuid(decodeURIComponent(path.slice('/v1/sites/default/categories/'.length)))).toBe(true);
  });

  it("reads rc.categoryID as given and prefetches the bean id's tokens", async () => {
    const ctx = contextFor(
      editRequest({ categoryID: 'ABCDEF', parentID: 'XYZ' }),
      categoryGateway({ [categoryRoute('ABCDEF')]: { status: 200, body: model(NEW_BEAN) } }),
    );
    const data = await loadCcategoryEdit(ctx);

    expect(data.bean.categoryID).toBe('');
    expect(data.restrictGroups).toEqual([{ groupName: 'Editor', isPublic: 0 }]);
    expect(ctx.gateway.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/sites/default/categories/ABCDEF',
      'POST /v1/csrf/tokens',
    ]);
    expect(ctx.gateway.calls[1]?.json).toEqual({ contexts: [''] });
  });

  it.each([{ status: 401 as const }, { status: 403 as const }])(
    'turns a $status answer into a GatewayDenialError',
    async ({ status }) => {
      const ctx = contextFor(
        editRequest({ categoryID: BETA_ID, parentID: '' }),
        categoryGateway({ [categoryRoute(BETA_ID)]: { status } }),
      );
      await expect(loadCcategoryEdit(ctx)).rejects.toThrow(GatewayDenialError);
    },
  );

  it.each([
    { label: 'no categoryBean', rc: { rsRestrictGroups: [], categories: [] } },
    { label: 'no rsRestrictGroups', rc: { categoryBean: NEW_BEAN, categories: [] } },
    { label: 'no categories', rc: { categoryBean: NEW_BEAN, rsRestrictGroups: [] } },
    { label: 'a complex flag', rc: model({ ...NEW_BEAN, isOpen: {} }).rc },
    { label: 'an errors list', rc: model({ ...NEW_BEAN, errors: ['name'] }).rc },
  ])('rejects a model with $label', ({ rc }) => {
    expect(() => categoryEditDataOf(rc)).toThrow(TypeError);
  });
});

describe('renderCcategoryEdit', () => {
  it('renders the Add form byte for byte as the legacy capture, with the js.cfm block as request.ajax', async () => {
    const ctx = contextFor(editRequest({ categoryID: '', parentID: '' }), categoryGateway());
    await ctx.csrf.prefetch(['']);
    const view = renderCcategoryEdit(ctx, categoryEditDataOf(model(NEW_BEAN).rc));

    expect(toString(view.body)).toBe(legacyBody('ccategory-edit-new.html'));
    expect(view.ajax && toString(view.ajax)).toBe(toString(renderCategoryAjax(ctx.rb)));
  });

  it('renders an unknown id as the Edit form of the new bean, byte for byte as the legacy capture', async () => {
    const body = await loadAndRender({ categoryID: 'ABCDEF', parentID: 'XYZ' }, 'ABCDEF', {
      status: 200,
      body: model(NEW_BEAN),
    });
    expect(body).toBe(legacyBody('ccategory-edit-unknown.html'));
  });

  it("fills a saved category's values encoded as the view encodes them, its flags unchecked", async () => {
    const body = await loadAndRender({ categoryID: BETA_ID, parentID: ALPHA_ID }, BETA_ID, {
      status: 200,
      body: model(SAVED_BEAN, { rsRestrictGroups: [FRIENDS_GROUP, EDITOR_GROUP] }),
    });
    const $ = cheerio.load(body);

    expect($('h1').text()).toBe('Edit Content Category');
    expect(body).toContain('value="Beta&#x20;&quot;quoted&quot;&#x20;&amp;&#x20;&lt;b&gt;" maxlength="50">');
    expect(body).toContain('<input type="text" name="urltitle" value="beta-&lt;b&gt;" maxlength="255">');
    expect(body).toContain('<textarea name="notes" rows="8">Line &lt;1&gt; &amp; 2</textarea>');
    expect(body).toContain(`<label>CategoryID</label>\n    ${BETA_ID} \n  </div>`);
    const checked = ['isInterestGroup', 'isOpen', 'isfeatureable', 'isActive'].map((name) =>
      $(`input[name=${name}][checked]`).val(),
    );
    expect(checked).toEqual(['0', '0', '0', '0']);
    expect(
      $('select[name=restrictgroups] optgroup')
        .toArray()
        .map((group) => [$(group).attr('label'), optionsOf($, $(group).find('option'))]),
    ).toEqual([
      ['Global Settings', ['', 'RestrictAll']],
      ['Member Groups', ['Friends*']],
      ['System Groups', ['Editor*']],
    ]);
    expect(body).toContain(`\t       </optgroup>
\t       
      \t<optgroup label="Member&#x20;Groups">
      \t
      \t<option value="Friends" Selected>Friends</option>
      \t
      \t</optgroup>
      \t
      \t<optgroup label="System&#x20;Groups">`);
    expect(body).toContain(
      `<button type="button" class="btn" onclick="submitForm(document.forms.form1,'delete','Delete\\x20Category\\x3F');"><i class="mi-trash"></i>Delete</button>`,
    );
    expect(body).toContain(
      `<input type=hidden name="categoryID" value="${BETA_ID}">\n          <input type="hidden" name="action" value="update">\n        <input type="hidden" name="csrf_token" value="${CSRF_PAIR.token}" />`,
    );
  });

  it.each([
    { restrictGroups: 'RestrictAll', selected: ['RestrictAll'] },
    { restrictGroups: 'restrictall', selected: ['RestrictAll'] },
    { restrictGroups: '', selected: [''] },
    { restrictGroups: 'editor,,', selected: ['Editor'] },
  ])('selects $selected for restrictGroups "$restrictGroups"', async ({ restrictGroups, selected }) => {
    const body = await renderModel({ categoryID: BETA_ID, parentID: '' }, model({ ...SAVED_BEAN, restrictGroups }));
    const $ = cheerio.load(body);
    expect(optionsOf($, 'select[name=restrictgroups] option').filter((value) => value.endsWith('*'))).toEqual(
      selected.map((value) => `${value}*`),
    );
  });

  it('lists every category as a parent of a new one, indented by level, the requested parent selected', async () => {
    const body = await renderModel(
      { categoryID: '', parentID: BETA_ID },
      model(NEW_BEAN, { categories: categoryTree() }),
    );
    expect(body).toContain(`      <option value="">Primary</option>
     
<option value="${ALPHA_ID}" >&nbsp;&nbsp;Alpha &amp; Co</option>

<option value="${BETA_ID}" selected>&nbsp;&nbsp;&nbsp;&nbsp;Beta &lt;b&gt;</option>

<option value="${GAMMA_ID}" >&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Gamma</option>

<option value="${DELTA_ID}" >&nbsp;&nbsp;Delta</option>

      </select>`);
  });

  it('leaves the edited category and its descendants out of the parents, matching ids as CFML does', async () => {
    const body = await renderModel(
      { categoryID: BETA_ID.toLowerCase(), parentID: ALPHA_ID.toLowerCase() },
      model(SAVED_BEAN, { categories: categoryTree() }),
    );
    expect(optionsOf(cheerio.load(body), 'select[name=parentID] option')).toEqual(['', `${ALPHA_ID}*`, DELTA_ID]);
  });

  it("alerts the bean's errors, all but siteID's, in struct order", async () => {
    const errors = { name: "The 'Name' field is required.", siteID: 'site', urltitle: 'Taken' };
    const body = await renderModel({ categoryID: '', parentID: '' }, model({ ...NEW_BEAN, errors }));
    expect(body).toContain(
      `</div> <!-- /.mura-header -->\n\n\n  <div class="alert alert-error"><span>The 'Name' field is required. <br> Taken </span></div>\n\n\n<div class="block block-constrain">`,
    );
  });

  it('fails as legacy does when rc.parentID is undefined', async () => {
    const rendering = renderModel({ categoryID: '' }, model(NEW_BEAN));
    await expect(rendering).rejects.toThrow('Element PARENTID is undefined in RC.');
  });
});
