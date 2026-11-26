// cCategory.edit against ccategory/edit.cfm and dsp_parents.cfm: the category form over strategies-content.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { GatewayDenialError } from '@/lib/gateway-client';
import { encodeJs, toString } from '@/lib/html';
import { toCategoryTree, type CategoryTreeNode } from '@/screens/ccategory/dsp-nest';
import { renderCategoryParents, renderParentOptions } from '@/screens/ccategory/dsp-parents';
import { categoryEditDataOf, loadCcategoryEdit, renderCcategoryEdit } from '@/screens/ccategory/edit';
import { renderCategoryAjax } from '@/screens/ccategory/js';
import {
  CATEGORY_IDS,
  CCATEGORY_PATHS,
  INTEREST_CATEGORY_IDS,
  NEW_CATEGORY_ID,
  ccategoryEditData,
  ccategoryEditNewData,
  ccategoryListData,
} from '../../fixtures/strategies-content/categories';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { domModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';
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
    { label: 'a restrict group that is not a struct', rc: { ...model(NEW_BEAN).rc, rsRestrictGroups: ['Editor'] } },
  ])('rejects a model with $label', ({ rc }) => {
    expect(() => categoryEditDataOf(rc)).toThrow(TypeError);
  });

  it.each([
    { label: 'absent', bean: Object.fromEntries(Object.entries(NEW_BEAN).filter(([key]) => key !== 'errors')) },
    { label: 'null', bean: { ...NEW_BEAN, errors: null } },
  ])('reads $label bean errors as none', ({ bean }) => {
    expect(categoryEditDataOf(model(bean).rc).errors).toEqual([]);
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

const IDS = { ...CATEGORY_IDS, ...INTEREST_CATEGORY_IDS };

/** `[id, selected, indent pairs, name]` of each `dsp_parents` option in `markup`, entities kept. */
function parentRows(markup: string): Array<[string, boolean, number, string]> {
  return [...markup.matchAll(/<option value="([^"]*)" (selected)?>((?:&nbsp;&nbsp;)*)(.*?)<\/option>/g)].map(
    ([, id = '', selected, indent = '', name = '']) => [id, selected !== undefined, indent.length / 12, name],
  );
}

describe('renderParentOptions', () => {
  const nodes = toCategoryTree(ccategoryListData);
  const options = (input: { categoryId?: string; actualParentId?: string; nestLevel?: number } = {}): string =>
    toString(renderParentOptions({ nodes, categoryId: '', actualParentId: '', ...input }));

  it('lists every category depth-first, one indent pair per level from 1, none selected', () => {
    expect(options()).toBe(options({ nestLevel: 1 }));
    expect(options().startsWith(`\n<option value="${IDS.topics}" >&nbsp;&nbsp;General Topics</option>\n`)).toBe(true);
    expect(parentRows(options())).toEqual([
      [IDS.topics, false, 1, 'General Topics'],
      [IDS.topicsNews, false, 2, 'Agency News'],
      [IDS.topicsEvents, false, 2, 'Events'],
      [IDS.topicsEventsLocal, false, 3, 'Local Events'],
      [IDS.interests, false, 1, 'Interests'],
      [IDS.newsletter, false, 2, 'Newsletter'],
      [IDS.volunteering, false, 2, 'Outreach Volunteering'],
      [IDS.training, false, 2, 'Skills Training'],
      [IDS.inactiveArchive, false, 1, 'Legacy Archive'],
      [IDS.restricted, false, 1, 'Restricted Notices'],
    ]);
  });

  it('indents nothing at nestLevel 0', () => {
    const rows = parentRows(options({ nestLevel: 0 }));
    expect(rows.filter(([, , level]) => level === 0).map(([id]) => id)).toEqual([
      IDS.topics,
      IDS.interests,
      IDS.inactiveArchive,
      IDS.restricted,
    ]);
    expect(rows.find(([id]) => id === IDS.topicsEventsLocal)?.[2]).toBe(2);
  });

  it('selects the actual parent case-insensitively', () => {
    const rows = parentRows(options({ actualParentId: IDS.topicsEvents.toLowerCase() }));
    expect(rows.filter(([, selected]) => selected).map(([id]) => id)).toEqual([IDS.topicsEvents]);
    expect(options({ actualParentId: IDS.topicsEvents.toLowerCase() })).toContain(
      `<option value="${IDS.topicsEvents}" selected>&nbsp;&nbsp;&nbsp;&nbsp;Events</option>`,
    );
  });

  it('skips the edited subtree case-insensitively', () => {
    const ids = parentRows(options({ categoryId: IDS.topicsEvents.toLowerCase() })).map(([id]) => id);
    expect(ids).not.toContain(IDS.topicsEvents);
    expect(ids).not.toContain(IDS.topicsEventsLocal);
    expect(ids).toEqual([
      IDS.topics,
      IDS.topicsNews,
      IDS.interests,
      IDS.newsletter,
      IDS.volunteering,
      IDS.training,
      IDS.inactiveArchive,
      IDS.restricted,
    ]);
  });

  it('encodes names and writes ids as given', () => {
    const [first] = nodes;
    if (first === undefined) throw new Error('the fixture tree is empty');
    const markup = toString(
      renderParentOptions({
        nodes: [{ ...first, name: 'Tom <b>& "Jerry"', children: [] }],
        categoryId: '',
        actualParentId: '',
      }),
    );
    expect(markup).toBe(`\n<option value="${IDS.topics}" >&nbsp;&nbsp;Tom &lt;b&gt;&amp; &quot;Jerry&quot;</option>\n`);
  });

  it('renders flat rows nested by parentID, ignoring case, as the nested tree', () => {
    const flatten = (level: readonly CategoryTreeNode[]): object[] =>
      level.flatMap(({ children, ...row }) => [
        { ...row, parentID: row.parentID.toLowerCase() },
        ...flatten(children),
      ]);
    const flat = toCategoryTree({ rc: { categories: flatten(nodes) } });
    expect(toString(renderParentOptions({ nodes: flat, categoryId: '', actualParentId: '' }))).toBe(options());
  });

  it('renders what renderCategoryParents renders for the same attributes', () => {
    const input = { categoryId: IDS.interests, actualParentId: IDS.topics, nestLevel: 2 };
    expect(options(input)).toBe(
      toString(renderCategoryParents({ nodes, categoryID: IDS.interests, actualParentID: IDS.topics, nestLevel: 2 })),
    );
  });
});

const TENANT = 'tenant-a';

/** The tenant-a site admin requesting `cCategory.edit` with `rc`. */
const tenantEditRequest = (rc: Record<string, string>) =>
  siteAdminRequest(TENANT, { circuit: 'cCategory', item: 'edit', rc });

/** `[name, type, value, checked]` of every form control of `body`. */
const controlsOf = (body: string): Array<[string, string, string, boolean]> =>
  domModel(body).controls.map(({ name, type, value, checked }) => [name, type, value, checked]);

/** The collapsed text of the CategoryID group. */
function categoryIdGroupText($: cheerio.CheerioAPI): string {
  const group = $('.mura-control-group').filter((_, el) => $(el).children('label').first().text() === 'CategoryID');
  return group.text().replace(/\s+/g, ' ').trim();
}

/** The values of each radio group's checked input, in form order. */
const checkedRadios = ($: cheerio.CheerioAPI): string[] =>
  ['isInterestGroup', 'isOpen', 'isfeatureable', 'isActive'].map(
    (name) => $(`input[name=${name}][checked]`).val() as string,
  );

describe('cCategory.edit over the tenant-a fixtures', () => {
  it('renders a saved category with its values, parents, groups, buttons and tokens', async () => {
    const rc = { categoryID: IDS.topicsEvents, parentID: IDS.topics };
    const ctx = makeScreenContext({
      req: tenantEditRequest(rc),
      gateway: fakeGatewayClient({
        [routeKey('GET', 'strategies-content', CCATEGORY_PATHS.edit)]: { status: 200, body: ccategoryEditData },
      }),
    });
    const view = renderCcategoryEdit(ctx, await loadCcategoryEdit(ctx));
    const body = toString(view.body);
    const page = domModel(body);
    const $ = cheerio.load(body);

    expect(ctx.gateway.calls.map(({ service, method, path, json }) => [service, method, path, json])).toEqual([
      ['strategies-content', 'GET', CCATEGORY_PATHS.edit, undefined],
      ['identity', 'POST', '/v1/csrf/tokens', { contexts: [IDS.topicsEvents] }],
    ]);
    expect(page.headings).toEqual(['Edit Content Category']);
    expect(page.links).toEqual([
      { href: `./?muraAction=ccategory.list&categoryID=&parentID=&siteid=${TENANT}`, text: 'Back to Categories' },
    ]);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'CategoryID',
        'Is this an Interest Group?',
        'Allow Content Assignments?',
        'Allow Content Features?',
        'Active?',
      ]),
    );
    expect($('form').attr()).toEqual({
      novalidate: 'novalidate',
      action: `./?muraAction=cCategory.update&siteid=${TENANT}`,
      method: 'post',
      name: 'form1',
      onsubmit: 'return validate(this);',
    });
    expect($('input[name=name]').attr()).toMatchObject({ required: 'true', maxlength: '50' });
    expect($('input[name=name]').attr('message')).toBe("The 'Name' field is required.");
    expect(controlsOf(body)).toEqual([
      ['name', 'text', 'Events', false],
      ['urltitle', 'text', 'events', false],
      ['parentID', 'select-one', IDS.topics, false],
      ['isInterestGroup', 'radio', '1', false],
      ['isInterestGroup', 'radio', '0', true],
      ['isOpen', 'radio', '1', true],
      ['isOpen', 'radio', '0', false],
      ['isfeatureable', 'radio', '1', true],
      ['isfeatureable', 'radio', '0', false],
      ['isActive', 'radio', '1', true],
      ['isActive', 'radio', '0', false],
      ['restrictgroups', 'select-multiple', 'RestrictedReaders', false],
      ['notes', 'textarea', 'Program events and calendar listings.', false],
      ['categoryID', 'hidden', IDS.topicsEvents, false],
      ['action', 'hidden', 'update', false],
      ['csrf_token', 'hidden', FIXED_CSRF.token, false],
      ['csrf_token_expires', 'hidden', FIXED_CSRF.expires, false],
    ]);
    expect(categoryIdGroupText($)).toBe(`CategoryID ${IDS.topicsEvents}`);

    const parents = toString(
      renderParentOptions({
        nodes: toCategoryTree(ccategoryEditData),
        categoryId: rc.categoryID,
        actualParentId: rc.parentID,
        nestLevel: 1,
      }),
    );
    expect(body).toContain(`<option value="">Primary</option>\n     ${parents}\n      </select>`);
    expect(optionsOf($, 'select[name=parentID] option')).toEqual([
      '',
      `${IDS.topics}*`,
      IDS.topicsNews,
      IDS.interests,
      IDS.newsletter,
      IDS.volunteering,
      IDS.training,
      IDS.inactiveArchive,
      IDS.restricted,
    ]);

    expect(
      $('select[name=restrictgroups] optgroup')
        .toArray()
        .map((group) => [$(group).attr('label'), optionsOf($, $(group).find('option'))]),
    ).toEqual([
      ['Global Settings', ['', 'RestrictAll']],
      ['Member Groups', ['Community Members', 'RestrictedReaders*']],
      ['System Groups', ['Content Editors', 'Program Staff']],
    ]);

    expect(page.buttons).toEqual([
      { text: 'Delete', type: 'button', hasOnclick: true },
      { text: 'Update', type: 'submit', hasOnclick: true },
    ]);
    const [deleteButton, updateButton] = $('button').toArray().map((el) => $(el));
    expect(deleteButton?.attr()).toEqual({
      type: 'button',
      class: 'btn',
      onclick: `submitForm(document.forms.form1,'delete','${encodeJs('Delete Category?')}');`,
    });
    expect(deleteButton?.find('i.mi-trash')).toHaveLength(1);
    expect(updateButton?.attr()).toEqual({
      class: 'btn mura-primary',
      onclick: "submitForm(document.forms.form1,'update');",
    });

    expect(page.alerts).toEqual([]);
    expect(view.ajax && toString(view.ajax)).toBe(toString(renderCategoryAjax(ctx.rb)));
  });

  it('renders an id naming no category as the Edit form of the new bean', async () => {
    const ctx = makeScreenContext({
      req: tenantEditRequest({ categoryID: NEW_CATEGORY_ID, parentID: '' }),
      gateway: fakeGatewayClient({
        [routeKey('GET', 'strategies-content', CCATEGORY_PATHS.editNew)]: { status: 200, body: ccategoryEditNewData },
      }),
    });
    const body = toString(renderCcategoryEdit(ctx, await loadCcategoryEdit(ctx)).body);
    const $ = cheerio.load(body);

    expect(ctx.gateway.calls.map(({ path, json }) => [path, json])).toEqual([
      [CCATEGORY_PATHS.editNew, undefined],
      ['/v1/csrf/tokens', { contexts: [''] }],
    ]);
    expect(domModel(body).headings).toEqual(['Edit Content Category']);
    expect(categoryIdGroupText($)).toBe('CategoryID Not Available');
    expect(domModel(body).buttons.map(({ text }) => text)).toEqual(['Delete', 'Update']);
    expect($('input[name=categoryID]').val()).toBe('');
  });

  it('renders the Add form of the new bean with its default flags and no parent selected', async () => {
    const ctx = makeScreenContext({ req: tenantEditRequest({ categoryID: '', parentID: '' }) });
    const data = categoryEditDataOf(ccategoryEditNewData.rc);
    await ctx.csrf.prefetch([data.bean.categoryID]);
    const body = toString(renderCcategoryEdit(ctx, data).body);
    const page = domModel(body);
    const $ = cheerio.load(body);

    expect(ctx.gateway.calls.map(({ path, json }) => [path, json])).toEqual([['/v1/csrf/tokens', { contexts: [''] }]]);
    expect(page.headings).toEqual(['Add Content Category']);
    expect(categoryIdGroupText($)).toBe('CategoryID Not Available');
    expect(page.buttons).toEqual([{ text: 'Add', type: 'button', hasOnclick: true }]);
    expect($('button').attr()).toEqual({
      type: 'button',
      class: 'btn mura-primary',
      onclick: "submitForm(document.forms.form1,'add');",
    });
    expect($('button i.mi-check-circle')).toHaveLength(1);
    expect(controlsOf(body).filter(([, type]) => type === 'hidden')).toEqual([
      ['categoryID', 'hidden', '', false],
      ['action', 'hidden', 'add', false],
      ['csrf_token', 'hidden', FIXED_CSRF.token, false],
      ['csrf_token_expires', 'hidden', FIXED_CSRF.expires, false],
    ]);
    expect(checkedRadios($)).toEqual(['1', '1', '1', '1']);
    expect(optionsOf($, 'select[name=restrictgroups] option').filter((value) => value.endsWith('*'))).toEqual(['*']);
    expect(optionsOf($, 'select[name=parentID] option')).toEqual([
      '',
      ...parentRows(toString(renderParentOptions({ nodes: data.categories, categoryId: '', actualParentId: '' }))).map(
        ([id]) => id,
      ),
    ]);
    expect($('select[name=parentID] option')).toHaveLength(11);
    expect(page.alerts).toEqual([]);
  });

  it("alerts the bean's error in the alert span", async () => {
    const ctx = makeScreenContext({ req: tenantEditRequest({ categoryID: '', parentID: '' }) });
    const { rc } = ccategoryEditNewData;
    const bean = { ...(rc.categoryBean as object), errors: { name: "The 'Name' field is required." } };
    await ctx.csrf.prefetch(['']);
    const body = toString(renderCcategoryEdit(ctx, categoryEditDataOf({ ...rc, categoryBean: bean })).body);

    expect(cheerio.load(body)('div.alert.alert-error > span').text().trim()).toBe("The 'Name' field is required.");
    expect(domModel(body).alerts.map(({ className }) => className)).toEqual(['alert alert-error']);
  });
});
