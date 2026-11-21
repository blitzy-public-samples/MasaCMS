// cEditProfile.edit (GS-PE-04) for the tenant-a system user, over the recorded profile, address and interest fixtures.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { ceditprofileScreens } from '@/screens/ceditprofile';
import {
  ceditprofileGate,
  editProfileRc,
  editProfileScreen,
  loadEditProfileView,
  renderEditProfile,
  type EditProfileRcValue,
  type EditProfileView,
  type ProfileData,
} from '@/screens/ceditprofile/edit';
import { renderUsersJs } from '@/screens/cusers/inc/js';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import { systemUserHomeAddress } from '../../fixtures/people/address-edit';
import { PROFILE_USER_ID, profileData } from '../../fixtures/people/profile';
import { siteTenantA } from '../../fixtures/programs-sites/sites';
import { INTEREST_CATEGORY_IDS, interestCategories } from '../../fixtures/strategies-content/categories';
import { anonymousRequest, makeAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  LEGACY_SITE_PATHS_PATH,
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

// The registry pulls in every circuit's screens; the shell reads only its hooks, and cEditProfile has no secondary menu.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type InterestNode = (typeof interestCategories)[number];

const TENANT_A = siteTenantA.SiteID;
const PROFILE_ROUTE = routeKey('GET', 'people', '/v1/profile');
const INTEREST_GROUPS_PATH = `/v1/sites/${TENANT_A}/private-interest-groups` as const;
const INTEREST_GROUPS_ROUTE = routeKey('GET', 'strategies-content', INTEREST_GROUPS_PATH);
const USER_JS = '<script type="text/javascript" src="assets/js/user.js"></script>';
const ADDRESS_ID = systemUserHomeAddress.addressID;

/** cEditProfile `before()` defaults in its order; `routeID` repeats `routeid` and no view reads `rsGrouplist`. */
const BEFORE_DEFAULTS: ReadonlyArray<readonly [string, EditProfileRcValue]> = [
  ['Type', '0'],
  ['ContactForm', '0'],
  ['isPublic', '0'],
  ['email', ''],
  ['jobtitle', ''],
  ['lastupdate', ''],
  ['lastupdateby', ''],
  ['lastupdatebyid', '0'],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['address', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['phone1', ''],
  ['phone2', ''],
  ['fax', ''],
  ['perm', '0'],
  ['groupid', ''],
  ['routeid', ''],
  ['InActive', '0'],
  ['startrow', '1'],
  ['categoryID', ''],
  ['error', {}],
  ['returnurl', ''],
];

/** Children of the node `parentId` in `nodes` or below them; undefined when no node has that id. */
function childrenOf(nodes: readonly InterestNode[], parentId: string): readonly InterestNode[] | undefined {
  for (const node of nodes) {
    if (node.categoryID === parentId) return node.children;
    const nested = childrenOf(node.children, parentId);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** strategies-content `listPrivateInterestGroups` over the fixture tree: the level `parentid` names, interest groups only. */
const interestGroupsRoute: FakeRoute = ({ query }) => {
  const parentId = typeof query['parentid'] === 'string' ? query['parentid'] : '';
  const level = parentId === '' ? interestCategories : (childrenOf(interestCategories, parentId) ?? []);
  const items = level
    .filter((node) => Number(node.isInterestGroup) === 1)
    .map((node) => ({
      categoryID: node.categoryID,
      name: node.name,
      filename: node.filename,
      urltitle: node.urltitle,
      isOpen: Number(node.isOpen),
      hasKids: Number(node.hasKids),
    }));
  return { status: 200, body: { items } };
};

/** The interest-group reads `ctx` sent, one per tree level. */
const interestCalls = (ctx: ScreenContext & { gateway: FakeGatewayClient }) =>
  ctx.gateway.calls.filter(({ service, path }) => service === 'strategies-content' && path === INTEREST_GROUPS_PATH);

/** GS-PE-04's user: the tenant-a system user, its session on tenant-a, whose pools are siteTenantA's. */
const systemUserRequest = (): AdminRequest =>
  makeAdminRequest(
    {
      circuit: 'ceditprofile',
      item: 'edit',
      session: { siteid: TENANT_A },
      site: {
        publicUserPoolID: siteTenantA.publicUserPoolID,
        privateUserPoolID: siteTenantA.privateUserPoolID,
        record: { publicUserPoolID: siteTenantA.publicUserPoolID, privateUserPoolID: siteTenantA.privateUserPoolID },
      },
    },
    SUBJECTS.systemUser,
  );

/** A context whose people answers `getProfile` with `profile` and strategies-content the fixture interest groups. */
const contextFor = (
  req: AdminRequest,
  profile: ProfileData = profileData,
  interestGroups: FakeRoute = interestGroupsRoute,
): ScreenContext & { gateway: FakeGatewayClient } =>
  makeScreenContext({
    req,
    gateway: fakeGatewayClient({ [PROFILE_ROUTE]: { status: 200, body: profile }, [INTEREST_GROUPS_ROUTE]: interestGroups }),
  });

async function pageHtml(def: PageScreen<EditProfileView>, ctx: ScreenContext): Promise<string> {
  const page = await renderScreenPage(def, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return page.html;
}

const markup = (value: SafeHtml | undefined): string => (value === undefined ? '' : toString(value));

/** Single-quoted arguments of the JS call `fn(...)` in `source`. */
function callArgs(source: string, fn: string): string[] {
  const match = new RegExp(`${fn.replace('.', '\\.')}\\(([^)]*)\\)`).exec(source);
  if (match?.[1] === undefined) throw new Error(`no ${fn} call`);
  return match[1].split(',').map((arg) => arg.replace(/^'|'$/g, ''));
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('cEditProfile before() defaults', () => {
  it.each(BEFORE_DEFAULTS)('defaults %s to %j', (name, value) => {
    expect(editProfileRc({ rc: {} })[name]).toEqual(value);
  });

  it('adds exactly those names, in before() order', () => {
    const rc = editProfileRc({ rc: {} });

    expect(Object.keys(rc)).toEqual(BEFORE_DEFAULTS.map(([name]) => name));
    expect(rc['routeID']).toBe('');
    expect(rc['rsGrouplist']).toBeUndefined();
  });
});

describe('cEditProfile gate', () => {
  it("sends an anonymous request to controller secure()'s login form", async () => {
    const req = anonymousRequest({ circuit: 'ceditprofile', item: 'edit' });

    const decision = await ceditprofileGate(req, { secure: () => secure(req) });

    expect(decision).toEqual(secure(req));
    if (decision.kind !== 'redirect') throw new Error('expected a redirect');
    const [path = '', query = ''] = decision.location.split('?');
    const params = new URLSearchParams(query);
    expect(path).toBe('./');
    expect(params.get('muraAction')).toBe('cLogin.main');
    expect(params.get('returnURL')).toMatch(/muraAction=ceditprofile\.edit$/);
  });

  it('lets the logged-in profile user through', async () => {
    const req = systemUserRequest();

    expect(req.user?.sub).toBe(PROFILE_USER_ID);
    expect(await ceditprofileGate(req, { secure: () => secure(req) })).toEqual({ kind: 'allow' });
  });

  it('answers the anonymous page with the gate redirect without reading people', async () => {
    const req = anonymousRequest({ circuit: 'ceditprofile', item: 'edit' });
    const ctx = contextFor(req);

    const page = await renderScreenPage(editProfileScreen, ctx);

    expect(page).toEqual(secure(req));
    expect(ctx.gateway.calls.filter(({ service }) => service === 'people')).toEqual([]);
  });
});

describe('cEditProfile.edit page of the recorded profile, as registered', () => {
  let ctx: ScreenContext & { gateway: FakeGatewayClient };
  let html: string;
  let model: DomModel;
  let $: cheerio.CheerioAPI;

  beforeEach(async () => {
    ctx = contextFor(systemUserRequest());
    html = await pageHtml(editProfileScreen, ctx);
    model = domModel(html);
    $ = cheerio.load(html);
  });

  /** Model of `form1` alone, without the shell's controls. */
  const formModel = (): DomModel => fragmentModel($.html($('form[name="form1"]')));

  it('is the registered edit page, read from people once and from the request site', () => {
    expect(ceditprofileScreens).toContain(editProfileScreen);
    expect(ctx.gateway.calls.filter(({ service }) => service === 'people')).toEqual([
      { service: 'people', method: 'GET', path: '/v1/profile' },
    ]);
    expect(ctx.gateway.calls.filter(({ path }) => path.endsWith('/shell'))).toEqual([]);
  });

  it('heads the page and every tab pane', () => {
    const titles = ['Edit Profile', 'Basic', 'Address Information', 'Interests', 'Extended Attributes', 'Advanced'];

    expect(model.headings.filter((heading) => titles.includes(heading))).toEqual(titles);
    expect($('.mura-header h1').text()).toBe('Edit Profile');
  });

  it('lists the tabs in edit.cfm order, the first active', () => {
    expect(model.links.filter(({ href }) => href.startsWith('#tab'))).toEqual([
      { href: '#tabBasic', text: 'Basic' },
      { href: '#tabAddressinformation', text: 'Address Information' },
      { href: '#tabInterests', text: 'Interests' },
      { href: '#tabExtendedattributes', text: 'Extended Attributes' },
      { href: '#tabAdvanced', text: 'Advanced' },
    ]);
    expect($('ul.mura-tabs > li').first().attr('class')).toBe('active');
    expect($('ul.mura-tabs > li.active')).toHaveLength(1);
    expect($('#tabBasic').hasClass('active')).toBe(true);
  });

  it('posts form1 as multipart to cEditProfile.update', () => {
    const form = $('form[name="form1"]');

    expect(form).toHaveLength(1);
    expect(form.attr()).toEqual({
      novalidate: 'novalidate',
      action: './?muraAction=cEditProfile.update',
      method: 'post',
      enctype: 'multipart/form-data',
      name: 'form1',
      class: 'columns',
      onsubmit: 'return userManager.submitForm(this);',
    });
  });

  it("fills form1's controls from the profile, then the hidden fields and the default-context CSRF pair", () => {
    const { volunteering, training } = INTEREST_CATEGORY_IDS;

    expect(formModel().controls.map((c) => [c.name, c.type, c.value, c.checked])).toEqual([
      ['subtype', 'select-one', 'Volunteer', false],
      ['fname', 'text', 'Casey', false],
      ['lname', 'text', 'Taylor', false],
      ['company', 'text', 'Riverton Outreach', false],
      ['jobtitle', 'text', 'Volunteer Coordinator', false],
      ['email', 'text', 'casey_taylor@example.com', false],
      ['mobilePhone', 'text', '555-0111', false],
      ['usernameNoCache', 'text', 'casey_taylor', false],
      ['passwordNoCache', 'password', '', false],
      ['password2', 'password', '', false],
      ['newFile', 'file', '', false],
      ['primaryAddressID', 'radio', ADDRESS_ID, true],
      ['categoryID', 'checkbox', INTEREST_CATEGORY_IDS.newsletter, true],
      ['categoryID', 'checkbox', volunteering, false],
      ['categoryID', 'checkbox', training, false],
      ['subscribe', 'radio', '1', true],
      ['subscribe', 'radio', '0', false],
      ['tags', 'text', 'mentoring,outreach', false],
      ['type', 'hidden', '2', false],
      ['action', 'hidden', '', false],
      ['contact', 'hidden', '0', false],
      ['userid', 'hidden', PROFILE_USER_ID, false],
      ['siteid', 'hidden', TENANT_A, false],
      ['csrf_token', 'hidden', FIXED_CSRF.token, false],
      ['csrf_token_expires', 'hidden', FIXED_CSRF.expires, false],
    ]);
    expect($('input[name="removePhotoFile"]')).toHaveLength(0);
    expect(ctx.gateway.calls.filter(({ path }) => path === '/v1/csrf/tokens')[0]).toMatchObject({
      service: 'identity',
      method: 'POST',
      json: { contexts: [''] },
    });
  });

  it("offers the profile's Volunteer subtype and loads its attributes with tenant-a's pools", () => {
    const select = formModel().controls.find(({ name }) => name === 'subtype');

    expect(select?.options).toEqual([
      { value: 'Default', label: 'Default', selected: false },
      { value: 'Volunteer', label: 'Volunteer', selected: true },
    ]);
    const reset = callArgs($('select[name="subtype"]').attr('onchange') ?? '', 'resetExtendedAttributes');
    expect(reset.slice(0, 4)).toEqual([PROFILE_USER_ID, '2', 'this.value', siteTenantA.publicUserPoolID]);
    const load = callArgs($('#tabExtendedattributes script').text(), 'userManager.loadExtendedAttributes');
    expect(load.slice(0, 4)).toEqual([PROFILE_USER_ID, '2', 'Volunteer', siteTenantA.privateUserPoolID]);
    // Both calls print the configured context and legacy's theme asset path of the user's site.
    expect(load.slice(4)).toEqual(reset.slice(4));
    expect(load[5]).toBe('/themes/default');
    const themeReads = ctx.gateway.calls.filter(({ path, query }) => path === LEGACY_SITE_PATHS_PATH && !query?.['initSite']);
    expect(themeReads.map(({ query }) => query?.['themeSite'])).toEqual([TENANT_A]);
  });

  it('lists the home address as primary under the add-address link', () => {
    const addHref = $('#tabAddressinformation .navTask a').attr('href');

    expect(addHref).toBe(
      `./?muraAction=cusers.editAddress&userID=${PROFILE_USER_ID}&siteid=${TENANT_A}&routeID=editprofile&addressID=&returnURL=muraAction%3Dceditprofile.edit`,
    );
    expect(model.links).toContainEqual({ href: expect.stringContaining('muraAction=cusers.editaddress'), text: 'Add New Address' });
    expect(model.tables.find(({ headers }) => headers.includes('Primary'))).toEqual({
      headers: ['Primary', 'Address', ''],
      rows: [['', 'Home 200 Sample Avenue Riverton , OR 97001 Phone: 555-0110 Email: casey_taylor.home@example.com', '']],
    });
    expect($('#tabAddressinformation table').hasClass('mura-table-grid')).toBe(true);
    expect($('#tabAddressinformation li.delete')).toHaveLength(0);
  });

  it("nests strategies-content's interest groups under the tenant-a label, boxes only on open categories", () => {
    const tree = $('div#mura-list-tree');

    expect(interestCalls(ctx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: INTEREST_GROUPS_PATH, query: { groupsiteid: TENANT_A, parentid: '' } },
      {
        service: 'strategies-content',
        method: 'GET',
        path: INTEREST_GROUPS_PATH,
        query: { groupsiteid: TENANT_A, parentid: INTEREST_CATEGORY_IDS.interests },
      },
    ]);
    expect(tree.children('label').toArray().map((label) => $(label).text())).toEqual([siteTenantA.Site]);
    expect(tree.children('ul').attr('class')).toBe('checkboxTree');
    const root = tree.find('ul.checkboxTree > li');
    expect(root).toHaveLength(1);
    expect(root.children('input')).toHaveLength(0);
    expect(root.contents().first().text().trim()).toBe('Interests');
    const nested = root.children('ul');
    expect(nested.attr('class')).toBeUndefined();
    expect(nested.children('li').toArray().map((li) => [$(li).text().trim(), $(li).children('input').is('[checked]')])).toEqual([
      ['Newsletter', true],
      ['Outreach Volunteering', false],
      ['Skills Training', false],
    ]);
  });

  it('ends with the Update button and shows no error alert', () => {
    expect(model.buttons).toContainEqual({ text: 'Update', type: 'button', hasOnclick: true });
    expect(model.alerts.filter(({ className }) => className.split(' ').includes('alert-error'))).toEqual([]);
  });

  it("adds the view's head scripts and cUsers ajax script to the shell", () => {
    expect(html).toContain(toString(ctx.req.session.dateKey.script));
    expect(html).toContain(USER_JS);
    expect(html).toContain(toString(renderUsersJs(ctx)));
  });
});

describe('cEditProfile.edit interest groups as registered', () => {
  const { newsletter, volunteering, training } = INTEREST_CATEGORY_IDS;
  /** `#mura-list-tree` as ACF 2023 writes it: the site label, then the tree `<cf_dsp_categories_nest>` prints. */
  const listTree = (tree: string): string =>
    `<div id="mura-list-tree" class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>${siteTenantA.Site}</label> ${tree}\n\t\t\t\t\t    \t</div>`;
  const box = (id: string, checked: boolean): string =>
    `<input type="checkbox" name="categoryID" class="checkbox" ${checked ? 'checked' : ''} value="${id}"> `;

  it("writes the recorded profile's tree byte for byte: the closed root unboxed, its open children nested and newsletter checked", async () => {
    const ctx = contextFor(systemUserRequest());

    const html = await pageHtml(editProfileScreen, ctx);

    expect(html).toContain(
      listTree(
        '\n<ul class="checkboxTree">\n\n<li>\nInterests \n<ul>\n' +
          `\n<li>\n${box(newsletter, true)}Newsletter \n</li>\n` +
          `\n<li>\n${box(volunteering, false)}Outreach Volunteering \n</li>\n` +
          `\n<li>\n${box(training, false)}Skills Training \n</li>\n` +
          '\n</ul>\n\n</li>\n\n</ul>\n',
      ),
    );
  });

  it("shows user.nointerestcategories for tenant-a's empty pool", async () => {
    const ctx = contextFor(systemUserRequest(), { ...profileData, categoryIds: [] }, { status: 200, body: { items: [] } });

    const html = await pageHtml(editProfileScreen, ctx);

    expect(html).toContain(listTree('<div class="help-block-empty">There are currently no interest groups.</div> '));
    expect(cheerio.load(html)('input[name="categoryID"]')).toHaveLength(0);
    expect(interestCalls(ctx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: INTEREST_GROUPS_PATH, query: { groupsiteid: TENANT_A, parentid: '' } },
    ]);
  });

  it('fails closed when strategies-content cannot serve, or halts, the interest groups', async () => {
    const ctx = contextFor(systemUserRequest(), profileData, { status: 503, body: { error: 'unavailable' } });

    await expect(renderScreenPage(editProfileScreen, ctx)).rejects.toMatchObject({
      name: 'GatewayUnavailableError',
      surface: 'admin',
      service: 'strategies-content',
      status: 503,
    });
  });

  it.each<[401 | 403, string]>([
    [401, '/admin/?muraAction=clogin.logout'],
    [403, './'],
  ])("answers strategies-content's %i with the access gate's redirect", async (status, location) => {
    const reply: FakeReply = { status, body: { error: 'denied' } };
    const ctx = contextFor(systemUserRequest(), profileData, reply);

    expect(await renderScreenPage(editProfileScreen, ctx)).toEqual({ kind: 'redirect', location });
  });
});

describe('cEditProfile.edit ShellView', () => {
  it("carries cusers/inc/js.cfm's script as ajax and the date key and user.js as head", async () => {
    const ctx = contextFor(systemUserRequest());
    const view = await loadEditProfileView(ctx);

    const shell = await renderEditProfile(ctx, view);

    expect(markup(shell.ajax)).toBe(toString(renderUsersJs(ctx)));
    expect(markup(shell.ajax)).toContain('searchParams.js?coreversion=7.6.1');
    expect(markup(shell.htmlHead)).toBe(`${toString(ctx.req.session.dateKey.script)}${USER_JS}`);
  });
});
