import { createHash } from 'node:crypto';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { buildUrl } from '@/lib/urls';
import type { CategoryTreeNode } from '@/screens/ccategory/dsp-nest';
import { renderUserCategoriesNest, type InterestCategoryRow } from '@/screens/cusers/dsp_categories_nest';
import {
  editUserScreen,
  loadEditUser,
  renderEditUser,
  type EditUserSources,
} from '@/screens/cusers/edituser';
import type { ScreenContext } from '@/screens/registry';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { ADDRESS_IDS, janeSmithHomeAddress } from '../../fixtures/people/address-edit';
import { NEW_USER_ID, existingUserEditData, newUserEditData } from '../../fixtures/people/user-edit';
import { PERSON_IDS } from '../../fixtures/people/user-list';
import { duplicateUsernameResult, missingEmailResult } from '../../fixtures/people/validation-errors';
import { SITE_LIST_BY_ORDERNO, siteUmbrella } from '../../fixtures/programs-sites/sites';
import { INTEREST_CATEGORY_IDS, interestCategories } from '../../fixtures/strategies-content/categories';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomControl, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeRoute, type FakeRouteTable, type RecordedRequest } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';

type UserEditData = components['schemas']['UserEditData'];
type PersonRecord = components['schemas']['PersonRecord'];
const USER_ID = 'EA000000-0000-0000-0000000000000001';
const BLOCKED_UNTIL = '2026-06-30T12:30:00.000';
const EDIT: UserEditData = {
  user: { UserID: USER_ID, Type: 2, SiteID: 'default', UserName: 'blocked-person', Fname: 'Jo', Lname: 'Doe', isPublic: 1 },
  isNew: false,
  tempIsPublic: 1,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [],
  privateGroups: [],
  publicGroups: [],
  groupIds: [],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  sites: [{ siteID: 'default', site: 'Default' }],
  errors: {},
  retained: false,
};

const JANE = PERSON_IDS.janeSmith;
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const USERS_MODULE_ID = '00000000000000000000000000000000008';

let restoreEnv: () => void;
beforeEach(() => { restoreEnv = useTestEnv(); });
afterEach(() => { restoreEnv(); });

/** Deterministic per-context test token (uppercase MD5 of `context`), so each rendered pair names the context it was issued for. */
const tokenFor = (context: string): string => createHash('md5').update(context).digest('hex').toUpperCase();

/** Issues a deterministic CSRF pair for each form context. */
function issueTokens(request: RecordedRequest) {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  return { status: 200, body: { tokens: contexts.map((context) => ({
    context, [CSRF_FIELD_TOKEN]: tokenFor(context), [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
  })) } };
}

/** The path of strategies-content's interest-group levels under the token site `tokenSite`. */
const interestGroupsPath = (tokenSite: string) => `/v1/sites/${tokenSite}/private-interest-groups` as const;

/** An interest-group level of a pool without interest groups. */
const NO_INTEREST_GROUPS: FakeRoute = { status: 200, body: { items: [] } };

/**
 * The screen's gateway: people's edit read answering `edit`, identity's CSRF pairs, programs-sites' site list by
 * orderno, and strategies-content answering the interest-group levels of the `default` and tenant-a tokens with
 * `interests`.
 */
const routes = (edit: UserEditData, interests: FakeRoute = NO_INTEREST_GROUPS): FakeRouteTable => ({
  [routeKey('GET', 'people', '/v1/users/edit')]: { status: 200, body: edit },
  [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueTokens,
  [routeKey('GET', 'programs-sites', '/v1/sites')]: { status: 200, body: SITE_LIST_BY_ORDERNO },
  [routeKey('GET', 'strategies-content', interestGroupsPath('default'))]: interests,
  [routeKey('GET', 'strategies-content', interestGroupsPath('tenant-a'))]: interests,
});

/** Loads and renders Edit User with the owner's block answer. */
async function render(rc: Record<string, string>, blockedUntil: string | null) {
  const gateway = fakeGatewayClient(routes({ ...EDIT, blockedUntil }));
  const ctx: ScreenContext = {
    req: adminS2Request({ circuit: 'cusers', item: 'edituser', rc: { userid: USER_ID, siteid: 'default', ...rc } }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
  const data = await loadEditUser(ctx);
  const view = await renderEditUser(ctx, data);
  return { gateway, data, body: toString(view.body) };
}

describe('cusers.edituser login block', () => {
  it.each([
    { name: 'removeBlock', value: '' },
    { name: 'REMOVEBLOCK', value: '' },
    { name: 'removeblock', value: 'false' },
    { name: 'ReMoVeBlOcK', value: 'anything' },
  ])('forwards $name=$value and renders the cleared block without an error', async ({ name, value }) => {
    const cleared = await render({ [name]: value }, null);
    expect(cleared.gateway.calls.find((call) => call.service === 'people')?.query).toEqual({
      siteid: 'default', userid: USER_ID, routeid: '', removeBlock: value,
    });
    expect(cleared.data.blockedUntil).toBeNull();
    expect(cleared.body).not.toContain('class="alert alert-error"');
    const unblocked = await render({}, null);
    expect(cleared.body).toBe(unblocked.body);
  });

  it('omits removeBlock when absent and renders the owner expiry and unblock link', async () => {
    const blocked = await render({}, BLOCKED_UNTIL);
    expect(blocked.gateway.calls.find((call) => call.service === 'people')?.query).not.toHaveProperty('removeBlock');
    expect(blocked.data.blockedUntil).toEqual(new Date(2026, 5, 30, 12, 30));
    expect(blocked.body).toContain('class="alert alert-error"');
    expect(blocked.body).toContain('&amp;removeBlock">[');
  });
});

/** `getPrivateInterestGroups` rows of a category tree under the site name `site`, each parent before its children. */
function forestOf(nodes: readonly CategoryTreeNode[], site: string): InterestCategoryRow[] {
  return nodes.flatMap((node) => [
    {
      site,
      categoryID: node.categoryID,
      parentID: node.parentID === '' ? null : node.parentID,
      name: node.name,
      isOpen: Number(node.isOpen),
      hasKids: Number(node.hasKids),
    },
    ...forestOf(node.children, site),
  ]);
}

/** The umbrella pool's interest categories in place of strategies-content's read. */
const POOL_INTERESTS: EditUserSources = {
  interestCategories: () => Promise.resolve(forestOf(interestCategories, siteUmbrella.Site)),
  webServiceTokens: () => Promise.resolve([]),
};

/** The registered screen, its loader reading `sources`. */
const screenWith = (sources: EditUserSources) => ({ ...editUserScreen, load: (ctx: ScreenContext) => loadEditUser(ctx, sources) });

const editUserRc = (userid: string, siteid: string) => ({ circuit: 'cusers', item: 'edituser', rc: { userid, siteid } });

/** The tenant-a site admin editing `userid` on tenant-a. */
const siteAdmin = (userid: string = JANE): AdminRequest => siteAdminRequest('tenant-a', editUserRc(userid, 'tenant-a'));

/** qa_editor granted the Users and Site Manager modules on `default`, who administers no site. */
const usersModuleEditor = (): AdminRequest =>
  editorRequest({
    ...editUserRc(JANE, 'default'),
    user: { roles: [Roles.systemUser, moduleRole(SITE_MANAGER_MODULE_ID), moduleRole(USERS_MODULE_ID)] },
  });

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The page in the shell, with its cheerio document and the DOM model of any part of it. */
async function renderPage(req: AdminRequest, edit: UserEditData, sources: EditUserSources = POOL_INTERESTS) {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(routes(edit)) });
  const page = await renderScreenPage(screenWith(sources), ctx);
  if (page.kind !== 'document') throw new Error(`Redirected to ${page.location}`);
  const $ = cheerio.load(page.html);
  const part = (selector: string): DomModel => fragmentModel($.html($(selector)));
  return { ctx, $, part };
}

/** Values of the controls named `names` (each named once in `model`). */
const valuesOf = (model: DomModel, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(model.controls.filter((c) => names.includes(c.name)).map((c) => [c.name, c.value]));

const named = (model: DomModel, name: string): DomControl[] => model.controls.filter((c) => c.name === name);

const hidden = (name: string, value: string): DomControl =>
  ({ tag: 'input', name, type: 'hidden', value, checked: false, selected: [], options: [] });

const categoryBox = (value: string, checked: boolean): DomControl =>
  ({ tag: 'input', name: 'categoryID', type: 'checkbox', value, checked, selected: [], options: [] });

/** The address cell of `janeSmithHomeAddress` under `name`, as the table shows it. */
const addressCell = (name: string): string =>
  `${name} 100 Example Street Suite 2 Springfield , IL 62701 Phone: 555-0100 Fax: 555-0199 ` +
  'Website: http://www.example.com/jane-smith Email: jane_smith.home@example.com';

const TABS = [
  { id: undefined, className: 'active', href: '#tabBasic', label: 'Basic' },
  { id: undefined, className: undefined, href: '#tabAddressinformation', label: 'Address Information' },
  { id: undefined, className: undefined, href: '#tabGroupmemberships', label: 'Group Memberships' },
  { id: undefined, className: undefined, href: '#tabInterests', label: 'Interests' },
  { id: 'tabExtendedattributesLI', className: 'hide', href: '#tabExtendedattributes', label: 'Extended Attributes' },
  { id: undefined, className: undefined, href: '#tabAdvanced', label: 'Advanced' },
];

describe('cusers.edituser stored user', () => {
  it('heads the form with the maintenance title and a back button', async () => {
    const ctx = makeScreenContext({ req: siteAdmin(), gateway: fakeGatewayClient(routes(existingUserEditData)) });

    const model = await renderScreenModel(editUserScreen, ctx);

    expect(model.headings).toContain('User Maintenance Form');
    expect(model.links).toContainEqual({ href: '#', text: 'Back' });
  });

  it.each<[string, UserEditData, boolean]>([
    ['with user subtypes', existingUserEditData, true],
    ['without user subtypes', { ...existingUserEditData, subTypes: [] }, false],
  ])('lists the tabs and panes of a pool %s', async (_label, edit, extended) => {
    const { $, part } = await renderPage(siteAdmin(), edit);
    const tabs = TABS.filter(({ href }) => extended || href !== '#tabExtendedattributes');

    const strip = $('ul.mura-tabs > li').toArray().map((li) => ({
      id: $(li).attr('id'),
      className: $(li).attr('class'),
      href: $(li).find('a').attr('href'),
      label: collapse($(li).text()),
    }));
    const panes = $('form[name="form1"] div.tab-pane').toArray().map((pane) => `#${$(pane).attr('id')}`);

    expect(strip).toEqual(tabs);
    expect(panes).toEqual(tabs.map(({ href }) => href));
    const subtype = named(part('form[name="form1"]'), 'subtype');
    expect(subtype).toEqual(
      extended
        ? [{
            tag: 'select',
            name: 'subtype',
            type: 'select-one',
            value: 'Default',
            checked: false,
            selected: ['Default'],
            options: [
              { value: 'Default', label: 'Default', selected: true },
              { value: 'Staff', label: 'Staff', selected: false },
            ],
          }]
        : [hidden('subtype', 'Default')],
    );
  });

  it("fills the Basic tab with the person's fields", async () => {
    const { part } = await renderPage(siteAdmin(), existingUserEditData);

    const basic = part('#tabBasic');

    expect(valuesOf(basic, ['fname', 'lname', 'company', 'jobtitle', 'email', 'mobilePhone', 'usernameNoCache', 'passwordNoCache', 'password2']))
      .toEqual({
        fname: 'Jane',
        lname: 'Smith',
        company: 'Example Co, Ltd.',
        jobtitle: 'Program Coordinator',
        email: 'jane_smith@example.com',
        mobilePhone: '555-0101',
        usernameNoCache: 'jane_smith',
        passwordNoCache: '',
        password2: '',
      });
  });

  it('lists the addresses, signing the delete link of the secondary one for its address context', async () => {
    const office = { ...janeSmithHomeAddress, addressID: ADDRESS_IDS.janeSmithNew, addressName: 'Office', isPrimary: 0 };
    const { ctx, $, part } = await renderPage(siteAdmin(), { ...existingUserEditData, addresses: [janeSmithHomeAddress, office] });

    const addresses = part('#tabAddressinformation');
    const deletes = $('#tabAddressinformation li.delete a').toArray().map((a) => $(a).attr('href'));

    expect(addresses.tables).toEqual([{ headers: ['Primary', 'Address', ''], rows: [['', addressCell('Home'), ''], ['', addressCell('Office'), '']] }]);
    expect(named(addresses, 'primaryAddressID').map(({ value, checked }) => ({ value, checked }))).toEqual([
      { value: janeSmithHomeAddress.addressID, checked: true },
      { value: office.addressID, checked: false },
    ]);
    expect(deletes).toEqual([
      `./?muraAction=cUsers.updateAddress&userid=${JANE}&action=delete&siteid=tenant-a&routeID=&addressID=${office.addressID}` +
        `&${CSRF_FIELD_TOKEN}=${tokenFor(`updateaddress${JANE}`)}&${CSRF_FIELD_EXPIRES}=${FIXED_CSRF.expires}`,
    ]);
    const issued = ctx.gateway.calls.filter(({ path }) => path === '/v1/csrf/tokens').map(({ json }) => json);
    expect(issued).toEqual([{ contexts: [JANE, `updateaddress${JANE}`] }]);
  });

  it("checks the person's group memberships among the system and member groups", async () => {
    const { part } = await renderPage(siteAdmin(), existingUserEditData);

    const boxes = named(part('#tabGroupmemberships'), 'groupid');

    expect(boxes.map(({ value }) => value)).toEqual(
      [...existingUserEditData.privateGroups, ...existingUserEditData.publicGroups].map(({ UserID }) => UserID),
    );
    expect(boxes.filter(({ checked }) => checked).map(({ value }) => value)).toEqual([
      GROUP_IDS.teamMember,
      GROUP_IDS.umbrellaMembers,
    ]);
    expect(part('#tabGroupmemberships').labels).toContain('Umbrella - Umbrella Members');
  });

  it("nests the pool's interest categories, checking the person's open ones", async () => {
    const { $, part } = await renderPage(siteAdmin(), existingUserEditData);

    const interests = part('#tabInterests');
    const roots = $('#tabInterests ul.checkboxTree > li');
    const nested = roots.children('ul').children('li').toArray().map((li) => collapse($(li).text()));

    expect(interests.labels).toEqual([siteUmbrella.Site]);
    expect($('#tabInterests ul.checkboxTree')).toHaveLength(1);
    expect(roots).toHaveLength(1);
    expect(roots.children('input')).toHaveLength(0);
    expect(collapse(roots.clone().children('ul').remove().end().text())).toBe('Interests');
    expect(roots.children('ul').attr('class')).toBeUndefined();
    expect(nested).toEqual(['Newsletter', 'Outreach Volunteering', 'Skills Training']);
    expect(interests.controls).toEqual([
      categoryBox(INTEREST_CATEGORY_IDS.newsletter, true),
      categoryBox(INTEREST_CATEGORY_IDS.volunteering, true),
      categoryBox(INTEREST_CATEGORY_IDS.training, false),
    ]);
  });

  it("offers an S2 admin every site in programs-sites' orderno order, selecting the person's site and the session's", async () => {
    const { part } = await renderPage(adminS2Request(editUserRc(JANE, 'tenant-a')), existingUserEditData);

    const advanced = part('#tabAdvanced');
    const selected = ['default', 'tenant-a'];
    const [select] = named(advanced, 'siteid');

    expect(existingUserEditData.sites.map(({ site }) => site)).toEqual(['Default', 'Tenant A', 'Tenant B', 'Umbrella']);
    expect(select?.options.map(({ label }) => label)).toEqual(['Default', 'Umbrella', 'Tenant A', 'Tenant B']);
    expect(named(advanced, 'siteid')).toEqual([{
      tag: 'select',
      name: 'siteid',
      type: 'select-one',
      value: 'default',
      checked: false,
      selected,
      options: SITE_LIST_BY_ORDERNO.map(({ siteid, site }) => ({ value: siteid, label: site, selected: selected.includes(siteid) })),
    }]);
    expect(valuesOf(advanced, ['tags', 'remoteID'])).toEqual({ tags: 'outreach,remote', remoteID: 'HR-0001' });
  });

  it.each<[string, () => AdminRequest, readonly unknown[]]>([
    ['an S2 admin by orderno', () => adminS2Request(editUserRc(JANE, 'tenant-a')), [{ sortBy: 'orderno', sortDirection: 'asc' }]],
    ['a site admin not at all', () => siteAdmin(), []],
    ['a caller who administers no site not at all', usersModuleEditor, []],
  ])("reads programs-sites' site list for %s", async (_label, req, queries) => {
    const { ctx } = await renderPage(req(), existingUserEditData);

    expect(ctx.gateway.calls.filter(({ path }) => path === '/v1/sites').map(({ service, query }) => ({ service, query })))
      .toEqual(queries.map((query) => ({ service: 'programs-sites', query })));
  });

  it('posts the multipart form to cUsers.update with the hidden fields and the CSRF pair of the user id', async () => {
    const { $, part } = await renderPage(siteAdmin(), existingUserEditData);

    const form = $('form[name="form1"]');

    expect({ action: form.attr('action'), method: form.attr('method'), enctype: form.attr('enctype'), name: form.attr('name') })
      .toEqual({ action: `/admin/index.cfm?muraAction=cUsers.update&userid=${JANE}&routeid=`, method: 'post', enctype: 'multipart/form-data', name: 'form1' });
    expect(part('form[name="form1"]').controls.filter(({ type }) => type === 'hidden')).toEqual([
      hidden('siteid', 'tenant-a'),
      hidden('type', '2'),
      hidden('action', 'Update'),
      hidden('contact', '0'),
      hidden('groupid', ''),
      hidden('ContactForm', ''),
      hidden('returnurl', '/admin/index.cfm?muraAction=cUsers.listUsers&ispublic=0'),
      hidden(CSRF_FIELD_TOKEN, tokenFor(JANE)),
      hidden(CSRF_FIELD_EXPIRES, FIXED_CSRF.expires),
    ]);
  });

  it.each<[string, UserEditData, string, readonly string[], string]>([
    ['a stored user', existingUserEditData, JANE, ['Delete', 'Update'], 'Update'],
    ['a locked super user', { ...existingUserEditData, lockedSuper: true }, JANE, ['Update'], 'Update'],
    ['a new user', newUserEditData, '', ['Add'], 'Add'],
  ])('offers %s the legacy actions', async (_label, edit, userid, buttons, action) => {
    const { part } = await renderPage(siteAdmin(userid), edit);

    expect(part('.form-actions').buttons.map(({ text }) => text)).toEqual(buttons);
    expect(named(part('form[name="form1"]'), 'action')).toEqual([hidden('action', action)]);
  });
});

describe('cusers.edituser new user and user type', () => {
  it('adds the new person under the id people generated, with the new address fields', async () => {
    const { $, part } = await renderPage(siteAdmin(''), newUserEditData);

    const form = part('form[name="form1"]');

    expect($('form[name="form1"]').attr('action')).toBe(`/admin/index.cfm?muraAction=cUsers.update&userid=${NEW_USER_ID}&routeid=`);
    expect(valuesOf(form, [CSRF_FIELD_TOKEN, 'isPrimary', 'address1', 'city'])).toEqual({
      [CSRF_FIELD_TOKEN]: tokenFor(NEW_USER_ID),
      isPrimary: '1',
      address1: '',
      city: '',
    });
    expect(form.buttons.map(({ text }) => text)).not.toContain('Delete');
  });

  it.each<[string, UserEditData, string, string]>([
    ['a stored system user', existingUserEditData, JANE, '0'],
    // Known issue reproduced: the new user form defaults to Site Member.
    ['a new user', newUserEditData, '', '1'],
  ])("shows an admin the user-type radios checked for %s", async (_label, edit, userid, checked) => {
    const { $ } = await renderPage(siteAdmin(userid), edit);

    const radios = $('#tabGroupmemberships label.radio').toArray().map((label) => ({
      value: $(label).find('input[name="isPublic"]').attr('value'),
      label: collapse($(label).text()),
      checked: $(label).find('input[name="isPublic"]').is('[checked]'),
    }));

    expect(radios).toEqual([
      { value: '1', label: 'Site Member', checked: checked === '1' },
      { value: '0', label: 'System User', checked: checked === '0' },
    ]);
  });

  it('gives a caller who administers no site only the hidden Site Member type and the member groups', async () => {
    const { part } = await renderPage(usersModuleEditor(), existingUserEditData);

    const groups = part('#tabGroupmemberships');

    expect(named(groups, 'isPublic')).toEqual([hidden('isPublic', '1')]);
    expect(groups.controls.some(({ type }) => type === 'radio')).toBe(false);
    expect(named(groups, 'groupid').map(({ value }) => value)).toEqual([GROUP_IDS.umbrellaMembers]);
  });
});

describe('cusers.edituser failed save', () => {
  it.each<[string, Readonly<Record<string, string>>, PersonRecord]>([
    ['a duplicate username', duplicateUsernameResult.errors, duplicateUsernameResult.userBean!],
    ['a missing email', missingEmailResult.errors, missingEmailResult.userBean!],
    ['both errors', { ...duplicateUsernameResult.errors, ...missingEmailResult.errors }, duplicateUsernameResult.userBean!],
  ])('re-renders %s with the legacy messages unchanged', async (_label, errors, userBean) => {
    const edit: UserEditData = { ...newUserEditData, user: userBean, errors, retained: true };
    const ctx = makeScreenContext({ req: siteAdmin(''), gateway: fakeGatewayClient(routes(edit)) });
    const messages = Object.values(errors);

    const model = await renderScreenModel(editUserScreen, ctx);
    const page = await renderScreenPage(editUserScreen, ctx);

    expect(model.alerts.filter(({ className }) => className === 'alert alert-error')).toEqual([
      { text: messages.join(' '), className: 'alert alert-error' },
    ]);
    if (page.kind !== 'document') throw new Error(`Redirected to ${page.location}`);
    expect(page.html).toContain(`<div class="alert alert-error"><span> ${messages.join(' <br> ')} </span></div>`);
    expect(valuesOf(model, ['usernameNoCache', 'email'])).toEqual({ usernameNoCache: userBean.UserName, email: userBean.Email });
  });

  // Oracle: the follow-up edituser pages of f3/leg-user-{s2-yes,inactive-abc,ispublic-true,multi} on the legacy server.
  it.each<[string, Partial<PersonRecord>, string, Record<string, Array<[string, boolean]>>, string]>([
    ['s2=yes', { S2: 'yes', isPublic: 0 }, 's2', { s2: [['1', true], ['0', false]], isPublic: [['1', false], ['0', true]], InActive: [['0', true], ['1', false]] }, 'ispublic=0'],
    ['InActive=abc', { InActive: 'abc' }, 'inActive', { InActive: [['0', false], ['1', false]], isPublic: [['1', true], ['0', false]] }, 'ispublic=1'],
    ['isPublic=true', { isPublic: 'true' }, 'isPublic', { isPublic: [['1', true], ['0', false]] }, 'ispublic=true'],
    ['isPublic=yes', { isPublic: 'yes', InActive: 'y' }, 'isPublic', { isPublic: [['1', true], ['0', false]], InActive: [['0', false], ['1', false]] }, 'ispublic=yes'],
  ])('re-renders a bean holding the posted flag text %s with the radios CFML `eq` and `cfif` check', async (_label, flags, property, radios, query) => {
    const errors = { [property]: `The property named '${property}' is not valid` };
    const edit: UserEditData = { ...newUserEditData, user: { ...newUserEditData.user, SiteID: 'default', ...flags }, errors, retained: true };
    const ctx = makeScreenContext({
      req: adminS2Request({ circuit: 'cusers', item: 'edituser', rc: { userid: '', siteid: 'default' } }),
      gateway: fakeGatewayClient(routes(edit)),
    });

    const model = await renderScreenModel(editUserScreen, ctx);

    expect(model.alerts.filter(({ className }) => className === 'alert alert-error')).toEqual([{ text: errors[property], className: 'alert alert-error' }]);
    for (const [name, expected] of Object.entries(radios)) {
      expect(named(model, name).filter(({ type }) => type === 'radio').map(({ value, checked }) => [value, checked])).toEqual(expected);
    }
    expect(valuesOf(model, ['returnurl'])).toEqual({ returnurl: buildUrl('cUsers.listUsers', undefined, query) });
  });

  it('fails as the view does on a user type it cannot read as a boolean', async () => {
    const edit: UserEditData = { ...newUserEditData, user: { ...newUserEditData.user, SiteID: 'default', isPublic: 'abc' }, retained: true };
    const ctx = makeScreenContext({
      req: adminS2Request({ circuit: 'cusers', item: 'edituser', rc: { userid: '', siteid: 'default' } }),
      gateway: fakeGatewayClient(routes(edit)),
    });
    await expect(renderScreenModel(editUserScreen, ctx)).rejects.toMatchObject({
      message: 'cannot convert the value "abc" to a boolean',
      type: 'Expression',
    });
  });
});

describe('cusers.edituser interests from strategies-content', () => {
  /** strategies-content's levels of the fixture interest tree by `parentid`, every row of the site `siteID`. */
  const interestLevels = (siteID: string): FakeRoute => ({ query }) => ({
    status: 200,
    body: {
      items: forestOf(interestCategories, '')
        .filter(({ parentID }) => (parentID ?? '') === query['parentid'])
        .map(({ categoryID, name, isOpen, hasKids }) => ({ siteID, categoryID, name, filename: '', urltitle: '', isOpen, hasKids })),
    },
  });

  /** The registered screen's context for the tenant-a site admin, strategies-content answering `interests`. */
  const registeredContext = (interests: FakeRoute) =>
    makeScreenContext({ req: siteAdmin(), gateway: fakeGatewayClient(routes(existingUserEditData, interests)) });

  /** The registered screen's page, with its cheerio document and its interest-group reads. */
  async function registeredPage(interests: FakeRoute) {
    const ctx = registeredContext(interests);
    const page = await renderScreenPage(editUserScreen, ctx);
    if (page.kind !== 'document') throw new Error(`Redirected to ${page.location}`);
    const calls = ctx.gateway.calls
      .filter(({ service, path }) => service === 'strategies-content' && path === interestGroupsPath('tenant-a'))
      .map(({ path, query }) => ({ path, query }));
    return { $: cheerio.load(page.html), calls };
  }

  const level = (parentid: string) => ({ path: interestGroupsPath('tenant-a'), query: { groupsiteid: 'tenant-a', parentid } });

  it.each(['tenant-a', 'TENANT-A'])(
    "nests the tree one level per read under the request site's name, checking the person's interests (rows of %s)",
    async (siteID) => {
      const { $, calls } = await registeredPage(interestLevels(siteID));
      const { $: forest } = await renderPage(siteAdmin(), existingUserEditData, {
        ...POOL_INTERESTS,
        interestCategories: () => Promise.resolve(forestOf(interestCategories, 'Tenant A')),
      });

      const interests = fragmentModel($.html($('#tabInterests')));

      expect($('#tabInterests').html()).toBe(forest('#tabInterests').html());
      expect(interests.labels).toEqual(['Tenant A']);
      expect($('#tabInterests ul.checkboxTree > li > ul > li').toArray().map((li) => collapse($(li).text())))
        .toEqual(['Newsletter', 'Outreach Volunteering', 'Skills Training']);
      expect(interests.controls).toEqual([
        categoryBox(INTEREST_CATEGORY_IDS.newsletter, true),
        categoryBox(INTEREST_CATEGORY_IDS.volunteering, true),
        categoryBox(INTEREST_CATEGORY_IDS.training, false),
      ]);
      expect(calls).toEqual([level(''), level(INTEREST_CATEGORY_IDS.interests)]);
    },
  );

  it("prints user.nointerestcategories for a pool without interest groups, reading only the top level", async () => {
    const { $, calls } = await registeredPage(NO_INTEREST_GROUPS);

    expect($('#mura-list-tree').children().toArray().map((child) => $.html(child))).toEqual([
      '<div class="help-block-empty">There are currently no interest groups.</div>',
    ]);
    expect($('#tabInterests input[name="categoryID"]')).toHaveLength(0);
    expect(calls).toEqual([level('')]);
  });

  it.each<[string, FakeRoute, Record<string, unknown>]>([
    [
      'strategies-content is unavailable or halts a level of several sites',
      { status: 503, body: { error: 'unavailable' } },
      { name: 'GatewayUnavailableError', surface: 'admin', service: 'strategies-content', status: 503 },
    ],
    [
      "the top level is another site's, whose name no owner serves",
      interestLevels('umbrella'),
      { surface: 'admin', reason: 'interest-site-unserved', message: expect.stringContaining('(EX-PROFILE-INTEREST-SITES)') },
    ],
  ])('fails closed when %s', async (_label, interests, fields) => {
    const loaded = editUserScreen.load!(registeredContext(interests));

    await expect(loaded).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(loaded).rejects.toMatchObject(fields);
  });
});

describe('renderUserCategoriesNest', () => {
  const nest = (parentId: string, forest: readonly InterestCategoryRow[]) =>
    renderUserCategoriesNest({
      siteId: 'tenant-a',
      parentId,
      categoryId: '',
      nestLevel: parentId === '' ? 0 : 1,
      userCategoryIds: [],
      loadForest: () => Promise.resolve(forest),
      rb: rbFor('en_US'),
    }).then(toString);

  it.each<[string, string, string]>([
    ['the root', '', '\n<div class="help-block-empty">There are currently no interest groups.</div>\n\t'],
    ['a lower level', INTEREST_CATEGORY_IDS.interests, ''],
  ])('renders an empty answer at %s as legacy does', async (_label, parentId, markup) => {
    expect(await nest(parentId, [])).toBe(markup);
  });

  it('HTML-encodes category names, one space after each, under one blank label for sites the query leaves null', async () => {
    const row = (categoryID: string, name: string): InterestCategoryRow =>
      ({ site: null, categoryID, parentID: null, name, isOpen: 1, hasKids: 0 });

    const markup = await nest('', [row(INTEREST_CATEGORY_IDS.newsletter, 'Fish & <Chips>'), row(INTEREST_CATEGORY_IDS.training, 'Trailing ')]);

    expect(markup).toContain('Fish &amp; &lt;Chips&gt; \n\t\t\t\t</li>');
    expect(markup).toContain('Trailing \n\t\t\t\t</li>');
    expect(markup).not.toContain('<Chips>');
    expect(fragmentModel(markup).labels).toEqual(['']);
  });
});
