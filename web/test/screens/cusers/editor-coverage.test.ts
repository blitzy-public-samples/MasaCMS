// cUsers.editUser against cusers.cfc editUser() and cusers/edituser.cfm: the form as the legacy server prints it for a
// new and a stored user, then the access, policy, retained-input, address, subtype, password and photo branches.
import { readFileSync } from 'node:fs';
import {
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION,
  LegacyServiceUnavailableError,
} from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/people';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import {
  editUserScreen,
  loadEditUser,
  renderEditUser,
  UNSERVED_EDIT_USER_SOURCES,
  type EditUserSources,
} from '@/screens/cusers/edituser';
import { USER_BEAN_RC_KEY, updateUserAction } from '@/screens/cusers/update';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, siteAdminRequest, unservedEditorRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

type PersonRecord = components['schemas']['PersonRecord'];
type UserEditData = components['schemas']['UserEditData'];
type AddressRecord = components['schemas']['AddressRecord'];

// Ids of the legacy oracle's pristine data: qa_editor, its primary address and the two system groups of `default`.
const NEW_USER_ID = '5CF995EF-B34B-9CE6-76824A0C4C536543';
const EDITOR_ID = '3BEC10FC-F5B5-5517-7E7F2072657EFB68';
const EDITOR_ADDRESS_ID = '3BEC1DE7-EC80-B66C-BD211EE74290A25E';
const ADMIN_GROUP = { UserID: '3BE10D43-C960-A7E5-0FB807B791D31787', GroupName: 'Admin' };
const EDITOR_GROUP = { UserID: '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D', GroupName: 'Editor' };
const PHOTO_ID = 'BBBBBBBB-1111-2222-3333444455556666';
const NOW = new Date('2026-06-30T12:00:00Z');

const EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/edit');

// The form region (`mura-header` to `</form>`) of the legacy ACF 2023 server's cUsers.editUser for the admin on
// `default`, its CSRF pair replaced by FIXED_CSRF: a new user with address fields in the URL, and qa_editor.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/people/${name}.html`, import.meta.url), 'utf8');

/** qa_editor as people reads it from the pristine database. */
const EDITOR: PersonRecord = {
  UserID: EDITOR_ID,
  Type: 2,
  SiteID: 'default',
  Fname: 'QA',
  Lname: 'Editor',
  Email: 'qa_editor@example.com',
  UserName: 'qa_editor',
  Company: null,
  JobTitle: null,
  mobilePhone: null,
  subType: 'Default',
  isPublic: 0,
  S2: 0,
  InActive: 0,
  Subscribe: 0,
  photoFileID: null,
  tags: null,
  remoteID: null,
};

/** People's edit data of qa_editor: its primary address, the Editor membership and the `default` site. */
const editData = (overrides: Partial<UserEditData> = {}): UserEditData => ({
  user: EDITOR,
  isNew: false,
  tempIsPublic: 0,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [{ addressID: EDITOR_ADDRESS_ID, userID: EDITOR_ID, siteID: 'default', addressName: 'Primary', isPrimary: 1 }],
  privateGroups: [ADMIN_GROUP, EDITOR_GROUP],
  publicGroups: [],
  groupIds: [EDITOR_GROUP.UserID],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  sites: [{ siteID: 'default', site: 'Default' }],
  errors: {},
  retained: false,
  ...overrides,
});

/** People's edit data of a new user: `userBean.init` defaults, its site still unset, under the id people generated. */
const NEW_USER: UserEditData = editData({
  user: { UserID: NEW_USER_ID, Type: 2, SiteID: '', subType: 'Default', isPublic: 1, S2: 0, InActive: 0, Subscribe: 1 },
  isNew: true,
  tempIsPublic: 1,
  addresses: [],
  groupIds: [],
});

let restoreEnv: () => void;

/** Installs `vars` as the only Masa settings. */
function useMuraSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => {
  restoreEnv = useTestEnv();
  useMuraSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  restoreEnv();
});

/** The S2 admin's `cUsers.editUser` with `rc`, `default` the session site unless `partial` says otherwise. */
const editUserRequest = (rc: Readonly<Record<string, string>>, partial: Parameters<typeof adminS2Request>[0] = {}): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item: 'edituser', rc, ...partial });

/** A screen context for `req` over a gateway answering people's edit read with `edit`, or with `reply`. */
function contextFor(req: AdminRequest, edit: UserEditData | FakeReply): ScreenContext & { gateway: FakeGatewayClient } {
  const reply: FakeReply = 'status' in edit ? edit : { status: 200, body: edit };
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [EDIT_ROUTE]: reply }), now: NOW });
}

/** The form body the registered screen loads and renders, optionally with `sources` in place of the unserved ones. */
async function formOf(ctx: ScreenContext, sources?: EditUserSources): Promise<string> {
  const data = sources === undefined ? await editUserScreen.load!(ctx) : await loadEditUser(ctx, sources);
  return toString((await editUserScreen.render(ctx, data)).body);
}

/** The people calls of `gateway`. */
const peopleQueries = (gateway: FakeGatewayClient) =>
  gateway.calls.filter(({ service }) => service === 'people').map(({ path, query }) => ({ path, query }));

/** The CSRF contexts identity was asked for. */
const csrfContexts = (gateway: FakeGatewayClient): unknown[] =>
  gateway.calls.filter(({ path }) => path === '/v1/csrf/tokens').flatMap(({ json }) => (json as { contexts: unknown[] }).contexts);

describe('cUsers.editUser as the legacy server prints it', () => {
  it.each<[string, Readonly<Record<string, string>>, UserEditData, string]>([
    [
      'a new user, its address fields from the request',
      { siteid: 'default', userid: '', address1: '1 Main <St>', city: 'Springfield', zip: '12345', hours: '9-5\nWeekdays' },
      NEW_USER,
      'cusers-edituser-new',
    ],
    ["qa_editor's stored account", { userid: EDITOR_ID, siteid: 'default' }, editData(), 'cusers-edituser-stored'],
  ])('renders %s through the gate, loader and shell', async (_label, rc, edit, fixture) => {
    const ctx = contextFor(editUserRequest(rc), edit);

    const page = await renderScreenPage(editUserScreen, ctx);
    if (page.kind !== 'document') throw new Error(`Redirected to ${page.location}`);
    const start = page.html.indexOf('<div class="mura-header">\n\t<h1>User Maintenance Form');
    const end = page.html.indexOf('</form>', start);

    expect(page.html.slice(start, end)).toBe(legacy(fixture));
    expect(peopleQueries(ctx.gateway)).toEqual([
      { path: '/v1/users/edit', query: { siteid: 'default', userid: rc['userid'], routeid: '' } },
    ]);
  });
});

describe('cUsers.editUser access', () => {
  it("sends qa_editor, without the Users module, back by the cUsers gate before people's read", async () => {
    const ctx = contextFor(editorRequest({ circuit: 'cusers', item: 'edituser', rc: { userid: EDITOR_ID } }), editData());

    await expect(renderScreenPage(editUserScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: './' });
    expect(peopleQueries(ctx.gateway)).toEqual([]);
  });

  it.each<[401 | 403, string]>([
    [401, ADMIN_LOGIN_REDIRECT_ACTION],
    [403, ADMIN_NOACCESS_ACTION],
  ])("answers people's %i with the access gate's redirect", async (status, action) => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), { status, body: { error: { code: 'denied', message: 'No' } } });

    const loaded = editUserScreen.load!(ctx);
    await expect(loaded).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(loaded).rejects.toMatchObject({ service: 'people', operation: 'getUserEdit', status });
    await expect(renderScreenPage(editUserScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: `/admin/?muraAction=${action}` });
  });

  it('reports people as unavailable when the gateway answers 503', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), { status: 503, body: '' });

    await expect(editUserScreen.load!(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('fails before any read for a request without site data', async () => {
    const ctx = contextFor(unservedEditorRequest({ circuit: 'cusers', item: 'edituser', rc: { userid: EDITOR_ID } }), editData());

    await expect(editUserScreen.load!(ctx)).rejects.toThrow(new TypeError('cUsers.editUser: the request carries no site data'));
    expect(peopleQueries(ctx.gateway)).toEqual([]);
  });
});

describe('cUsers.editUser policy branches', () => {
  it('locks the account fields of an S2 person for a site admin, whose lock notice replaces the errors', async () => {
    const s2Person = { ...EDITOR, S2: 1, SiteID: 'tenant-a' };
    const req = siteAdminRequest('tenant-a', { circuit: 'cusers', item: 'edituser', rc: { userid: EDITOR_ID } });
    const ctx = contextFor(req, editData({ user: s2Person, lockedSuper: true, errors: { email: 'Invalid' } }));

    const body = await formOf(ctx);

    expect(body).toContain('<div class="alert alert-info"><span>');
    expect(body).not.toContain('Invalid');
    expect(body).toContain('<input disabled id="email" name="email"');
    expect(body).toContain('<input disabled id="username"  name="usernameNoCache"');
    expect(body).not.toContain('passwordNoCache');
    expect(body).toContain('<input disabled name="isPublic" type="radio" class="radio inline" value="0" Checked>');
    expect(body).toContain('<input disabled name="InActive" type="radio" class="radio inline" value="0"Checked>');
    expect(body).not.toContain('<input name="s2"');
    expect(body).toContain('<input type="hidden" name="siteid" value="tenant-a">');
    expect(body).not.toContain("submitForm(document.forms.form1,'delete'");
    expect(body).toContain("userManager.submitForm(document.forms.form1,'update');");
  });

  it("shows a failed save's errors when the account is not locked", async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData({ errors: { username: 'Taken', email: 'Invalid' } }));

    expect(await formOf(ctx)).toContain('<div class="alert alert-error"><span> Taken <br> Invalid </span></div>');
  });

  it("keeps a member's user type for a caller who is not an admin, forwarding setispublic to people", async () => {
    const req = editorRequest({ circuit: 'cusers', item: 'edituser', rc: { userid: EDITOR_ID, setispublic: '0' } });
    const ctx = contextFor(req, editData({ user: { ...EDITOR, isPublic: 1 } }));

    const body = await formOf(ctx);

    expect(peopleQueries(ctx.gateway)[0]?.query).toMatchObject({ setispublic: '0' });
    expect(body).toContain('<input name="isPublic" type="hidden" value="1">');
    expect(body).not.toContain('privateGroupsList');
    expect(body).not.toContain('name="isPublic" type="radio"');
    expect(body).toContain('muraAction=cUsers.listUsers&ispublic=1"');
  });

  it.each<[string, string, boolean]>([
    ['System User', '0', true],
    ['Site Member', '1', false],
  ])('shows %s for an admin who sets setispublic=%s', async (_label, setispublic, system) => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, setispublic }), editData());

    const body = await formOf(ctx);

    const radio = (value: string): string => `<input name="isPublic" type="radio" class="radio inline" value="${value}" Checked>`;
    expect(body.includes(radio('0'))).toBe(system);
    expect(body.includes(radio('1'))).toBe(!system);
    expect(body.includes('<div id="privateGroupsList" class="mura-control-group">')).toBe(system);
    expect(body).toContain(`muraAction=cUsers.listUsers&ispublic=${setispublic}"`);
  });

  it("checks the groups of the bean's memberships and of the request's groupid list", async () => {
    const memberGroup = { UserID: 'C3000000-0000-0000-0000000000000001', GroupName: 'Members', Site: 'Default' };
    const otherGroup = { UserID: 'C3000000-0000-0000-0000000000000002', GroupName: 'Readers', Site: 'Default' };
    const ctx = contextFor(
      editUserRequest({ userid: EDITOR_ID, groupid: `${ADMIN_GROUP.UserID},${memberGroup.UserID}` }),
      editData({ publicGroups: [memberGroup, otherGroup] }),
    );

    const body = await formOf(ctx);

    for (const [group, checked] of [[ADMIN_GROUP, true], [EDITOR_GROUP, true], [memberGroup, true], [otherGroup, false]] as const) {
      expect(body).toContain(`value="${group.UserID}" ${checked ? 'checked' : ''}>`);
    }
    expect(body).toContain('\t\t\t\t\t\t\t\t\t\t\t\t\tDefault - Readers\n');
    expect(body).not.toContain('<p class="help-block-empty">');
  });

  it("lists the empty private groups notice, an S2 person's super-admin flag and an inactive account", async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData({ user: { ...EDITOR, S2: 1, InActive: 1 }, privateGroups: [] }));

    const body = await formOf(ctx);

    expect(body).toContain('<p class="help-block-empty">');
    expect(body).toContain('<input name="s2" type="radio" class="radio inline" value="1" Checked>');
    expect(body).toContain('<input name="InActive" type="radio" class="radio inline" value="1"Checked>');
  });

  it.each<[string, boolean, readonly string[]]>([
    ["a stored user, selecting its own site and the session's", true, ['default', 'tenant-a']],
    ["a new user, selecting the session's site only", false, ['default']],
  ])('offers the S2 site select for %s', async (_label, stored, selected) => {
    const sites = [{ siteID: 'default', site: 'Default' }, { siteID: 'tenant-a', site: 'Tenant <A>' }];
    const edit = stored
      ? editData({ user: { ...EDITOR, SiteID: 'tenant-a' }, sites })
      : { ...NEW_USER, user: { ...NEW_USER.user, SiteID: 'tenant-a' }, sites };
    const ctx = contextFor(editUserRequest({ userid: stored ? EDITOR_ID : '' }), edit);

    const body = await formOf(ctx);

    for (const site of ['default', 'tenant-a']) {
      expect(body.includes(`<option value="${site}" selected="selected">`)).toBe(selected.includes(site));
    }
    expect(body).toContain('Tenant &lt;A&gt;');
  });

  it.each<[string, number, string]>([
    ['subscribed', 1, '1'],
    ['unsubscribed', 0, '0'],
  ])('offers the subscription radios of an email-broadcasting site for a %s user', async (_label, subscribe, checked) => {
    const req = editUserRequest({ userid: EDITOR_ID }, { site: { emailBroadcaster: true } });
    const ctx = contextFor(req, editData({ user: { ...EDITOR, Subscribe: subscribe } }));

    const body = await formOf(ctx);

    for (const value of ['1', '0']) {
      const state = value === checked ? 'Checked' : '';
      expect(body).toContain(`<input name="subscribe" type="radio" class="radio inline" value="${value}"${state}>`);
    }
  });
});

describe('cUsers.editUser retained failed save', () => {
  const failedPerson = { ...EDITOR, Fname: 'Ada', UserName: 'taken', groupid: ADMIN_GROUP.UserID, categoryid: '' };
  const errors = { username: 'The Username is already in use.', email: 'Please enter a valid email.' };

  it("re-opens with the values and errors cUsers.update preserved, not people's stored ones", async () => {
    const updateCtx = makeScreenContext({
      req: adminS2Request({ circuit: 'cusers', item: 'update', rc: { type: '2', action: 'Update', userid: EDITOR_ID, siteid: 'default', ...FIXED_CSRF } }),
      gateway: fakeGatewayClient({
        [routeKey('POST', 'people', '/v1/users:update')]: { status: 200, body: { written: false, errors, userBean: failedPerson } },
      }),
    });
    const result = await updateUserAction.submit(updateCtx);
    if (result.kind !== 'redirect') throw new Error(`Expected the form redirect, got ${result.kind}`);
    const preserved = result.rc?.[USER_BEAN_RC_KEY];
    if (preserved === undefined) throw new Error('cUsers.update preserved no rc.userBean');

    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, siteid: 'default', [USER_BEAN_RC_KEY]: preserved }), editData());
    const body = await formOf(ctx);

    expect(body).toContain('<input id="fname" name="fname" type="text" value="Ada"');
    expect(body).toContain('name="usernameNoCache" type="text" value="taken"');
    expect(body).toContain('<div class="alert alert-error"><span> The Username is already in use. <br> Please enter a valid email. </span></div>');
    expect(body).toContain(`value="${ADMIN_GROUP.UserID}" checked>`);
    expect(body).toContain(`value="${EDITOR_GROUP.UserID}" >`);
  });

  it("keeps people's memberships and shows no errors when the preserved result carries neither", async () => {
    const preserved = JSON.stringify({ written: false, userBean: { ...EDITOR, Fname: 'Ada' } });
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, [USER_BEAN_RC_KEY]: preserved }), editData());

    const body = await formOf(ctx);

    expect(body).toContain('<input id="fname" name="fname" type="text" value="Ada"');
    expect(body).toContain(`value="${EDITOR_GROUP.UserID}" checked>`);
    expect(body).not.toContain('alert-error');
  });

  it.each<[string, string, Error]>([
    ['text that is not JSON', 'not json', new SyntaxError()],
    ['a result without a person', '{"errors":{}}', new TypeError('rc.userBean is not a person write result')],
    ['a JSON array', '[]', new TypeError('rc.userBean is not a person write result')],
    ['errors that are not a struct', `{"userBean":{"UserID":"${EDITOR_ID}"},"errors":"bad"}`, new TypeError('errors is not a struct')],
    [
      'a person field that is no simple value',
      `{"userBean":{"UserID":"${EDITOR_ID}","Fname":{"a":1}},"errors":{}}`,
      new TypeError('Fname is not a simple value'),
    ],
  ])('fails on a preserved rc.userBean holding %s', async (_label, preserved, error) => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, [USER_BEAN_RC_KEY]: preserved }), editData());

    const loaded = editUserScreen.load!(ctx);

    await expect(loaded).rejects.toBeInstanceOf(error.constructor);
    if (error.message !== '') await expect(loaded).rejects.toThrow(error.message);
  });
});

describe('cUsers.editUser addresses', () => {
  const full: AddressRecord = {
    addressID: 'AD000000-0000-0000-0000000000000001',
    userID: EDITOR_ID,
    addressName: 'Home <main>',
    address1: '1 Main St',
    address2: 'Apt 2',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    phone: '555-0100',
    fax: '555-0101',
    addressURL: 'https://example.com/a?b=1&c=2',
    addressEmail: 'home@example.com',
    isPrimary: 1,
  };
  const office: AddressRecord = {
    addressID: 'AD000000-0000-0000-0000000000000002',
    userID: EDITOR_ID,
    addressName: '',
    state: 'NY',
    zip: '10001',
    isPrimary: 0,
  };

  it('lists each address with its lines, the primary radio and a CSRF-signed delete link for the others', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, routeid: 'R 1' }), editData({ addresses: [full, office] }));

    const body = await formOf(ctx);

    expect(csrfContexts(ctx.gateway)).toEqual([EDITOR_ID, `updateaddress${EDITOR_ID}`]);
    expect(body).toContain(`name="primaryAddressID" value="${full.addressID}" checked>`);
    expect(body).toContain(`name="primaryAddressID" value="${office.addressID}" >`);
    expect(body).toContain(`&amp;routeID=R+1&amp;addressID=${full.addressID}">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tHome <main>\n`);
    expect(body).toContain('1 Main St<br />');
    expect(body).toContain('Apt 2<br />');
    // Whitespace-only template text after output prints one space, so the city, state and zip share a line.
    expect(body).toContain(`Apt 2<br />\n${'\t'.repeat(14)}Springfield , IL 62701 \n${'\t'.repeat(15)}<br/>`);
    expect(body).toContain(': 555-0100<br/>');
    expect(body).toContain(': 555-0101<br/>');
    expect(body).toContain(
      `<a href="https://example.com/a?b=1&c=2" target="_blank">\n${'\t'.repeat(16)}` +
        'https&#x3a;&#x2f;&#x2f;example.com&#x2f;a&#x3f;b&#x3d;1&amp;c&#x3d;2',
    );
    expect(body).toContain('<a href="mailto:home@example.com">\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\thome&#x40;example.com');
    expect(body).toContain(
      `muraAction=cUsers.updateAddress&amp;userid=${EDITOR_ID}&amp;action=delete&amp;siteid=default&amp;routeID=R+1&amp;addressID=${office.addressID}` +
        `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}"`,
    );
    expect(body.match(/<li class="delete"><i class="mi-trash"><\/i><\/li>/g)).toHaveLength(1);
    // The office row has neither name nor city, so its state opens the cell without a comma.
    expect(body).toContain(`<td class="var-width">\n${'\t'.repeat(14)}NY 10001 \n${'\t'.repeat(15)}<br/>`);
  });

  it("checks a stored user's only address though it is not primary", async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData({ addresses: [office] }));

    expect(await formOf(ctx)).toContain(`name="primaryAddressID" value="${office.addressID}" checked>`);
  });

  it('shows the empty notice for a stored user without addresses and signs only the form', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData({ addresses: [] }));

    const body = await formOf(ctx);

    expect(body).toContain('<div class="help-block-empty">');
    expect(body).not.toContain('mura-table-grid');
    expect(csrfContexts(ctx.gateway)).toEqual([EDITOR_ID]);
  });
});

describe('cUsers.editUser subtypes', () => {
  const subTypes = (...names: string[]) => names.map((subType, i) => ({ subTypeID: `5B000000-0000-0000-000000000000000${i}`, subType }));

  // The query of queries drops `Default` case-sensitively, while the view's `eq` selects an option ignoring case.
  it.each<[string, readonly string[]]>([
    ['Gold', ['Gold']],
    ['Default', ['Default', 'default']],
  ])("offers the pool's non-Default subtypes for a %s user", async (subType, selected) => {
    const edit = editData({ user: { ...EDITOR, subType }, subTypes: subTypes('Default', 'default', 'Gold') });
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), edit);
    const site = ctx.req.site!;
    const theme = `/themes/${site.record.theme ?? ''}`;

    const body = await formOf(ctx);

    expect(body).toContain(`userManager.resetExtendedAttributes('${EDITOR_ID}','2',this.value,'${site.privateUserPoolID}','','${theme}');`);
    const state = (option: string): string => (selected.includes(option) ? 'selected' : '');
    expect(body).toContain(`<option value="Default" ${state('Default')}>`);
    expect(body).toContain(`<option value="default" ${state('default')}>\n${'\t'.repeat(13)}default\n`);
    expect(body).toContain(`<option value="Gold" ${state('Gold')}>\n${'\t'.repeat(13)}Gold\n`);
    expect(body).toContain('<li id="tabExtendedattributesLI" class="hide">\n\t\t\t\t\t\t<a href="#tabExtendedattributes"');
    expect(body).toContain(`userManager.loadExtendedAttributes('${EDITOR_ID}','2','${subType}','${site.privateUserPoolID}','${theme}');`);
    expect(body).not.toContain('<input type="hidden" name="subtype" value="Default"/>');
  });

  it('shows the Extended Attributes tab but no select for a pool with only the Default subtype', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData({ subTypes: subTypes('Default') }));

    const body = await formOf(ctx);

    expect(body).toContain('id="tabExtendedattributes"');
    expect(body).not.toContain('name="subtype"  onchange');
    expect(body).toContain('<input type="hidden" name="subtype" value="Default"/>');
  });

  it('fails as listGetAt does when a blank tab label leaves fewer labels than tabs', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData());
    const blanked: RbLookup = { ...ctx.rb, rbKey: (key) => (key === 'user.interests' ? '' : ctx.rb.rbKey(key)) };

    await expect(formOf({ ...ctx, rb: blanked })).rejects.toThrow(new RangeError('listGetAt: tabLabelList has no element 5'));
  });
});

describe('cUsers.editUser passwords', () => {
  /** A failed save's write result as cUsers.update preserves it, with people's verdict when given. */
  const preservedSave = (passwordExpired?: boolean): string =>
    JSON.stringify({ written: false, errors: {}, userBean: EDITOR, ...(passwordExpired === undefined ? {} : { passwordExpired }) });

  it.each<[string, UserEditData, Readonly<Record<string, string>>, boolean]>([
    ['a stored user people reads as expired', editData({ passwordExpired: true }), {}, true],
    ['a stored user people reads as current', editData(), {}, false],
    ['a new user', NEW_USER, {}, false],
    ["a failed save people reads as expired over the stored user's verdict", editData(), { [USER_BEAN_RC_KEY]: preservedSave(true) }, true],
    ["a failed save people reads as current over the stored user's verdict", editData({ passwordExpired: true }), { [USER_BEAN_RC_KEY]: preservedSave(false) }, false],
    ["a failed save without a verdict, keeping the stored user's", editData({ passwordExpired: true }), { [USER_BEAN_RC_KEY]: preservedSave() }, true],
  ])('shows the expiry state of %s when passwords expire after 30 days', async (_label, edit, preserved, expired) => {
    useMuraSettings({ MURA_EXPIREPASSWORDS: '30' });
    const ctx = contextFor(editUserRequest({ userid: edit.isNew ? '' : EDITOR_ID, ...preserved }), edit);

    const body = await formOf(ctx);

    expect(body.includes('<div id="passwordexpired" class="help-block-inline" >')).toBe(expired);
    expect(body.includes('<div id="expirepassword" class="mura-control-group"  style="display:none;">')).toBe(expired);
    expect(body).toContain(`Mura.get('./?muraAction=cusers.expirepassword&userid=${edit.user.UserID}&siteid=${edit.user.SiteID}')`);
  });

  it('adds the strength help when strong passwords are required', async () => {
    useMuraSettings({ MURA_STRONGPASSWORDS: 'true' });
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), editData());

    const body = await formOf(ctx);

    expect(body).toContain(`<div class="help-block-inline">${ctx.rb.rbKey('user.passwordstrengthhelptext')}</div>`);
    expect(body).not.toContain('id="passwordexpired"');
  });
});

describe('cUsers.editUser photo', () => {
  const withPhoto = (photoFileExt: string): UserEditData => editData({ user: { ...EDITOR, photoFileID: PHOTO_ID, photoFileExt } });

  it.each<[string, Readonly<Record<string, string>>, string]>([
    ['the site asset path', {}, `/sites/default/cache/file/${PHOTO_ID}_medium.png`],
    [
      'an asset path that is a URL',
      { MURA_ASSETPATH: 'https://cdn.example.com/assets' },
      `https://cdn.example.com/assets/default/cache/file/${PHOTO_ID}_medium.png`,
    ],
    ['a file asset path', { MURA_FILEASSETPATH: '/files' }, `/files/default/cache/file/${PHOTO_ID}_medium.png`],
  ])("addresses the photo under %s", async (_label, settings, src) => {
    useMuraSettings(settings);
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, compactDisplay: 'true' }), withPhoto('png'));

    const body = await formOf(ctx);

    expect(body).toContain(`<img id="assocImage" src="${src}?cacheID=`);
    expect(body).toContain(`&fileid=${PHOTO_ID}&compactDisplay=true"><i class="mi-crop"></i></a>`);
  });

  // filetools.cfm prints compactDisplay through URLEncodedFormat, which leaves only ASCII letters and digits bare.
  it.each<[string, string]>([
    ['.-*_', '%2E%2D%2A%5F'],
    ['a b&c', 'a%20b%26c'],
  ])('URL-encodes compactDisplay %j on the crop link as URLEncodedFormat does', async (compactDisplay, encoded) => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, compactDisplay }), withPhoto('jpg'));

    const body = await formOf(ctx);

    expect(body).toContain(
      `<a class="btn" href="./?muraAction=cArch.imagedetails&userid=${EDITOR_ID}&siteid=default&fileid=${PHOTO_ID}` +
        `&compactDisplay=${encoded}"><i class="mi-crop"></i></a>`,
    );
  });

  it('addresses an SVG photo without a size suffix or crop link', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), withPhoto('svg'));

    const body = await formOf(ctx);

    expect(body).toContain(`<img id="assocImage" src="/sites/default/cache/file/${PHOTO_ID}.svg?cacheID=`);
    expect(body).not.toContain('mi-crop');
    expect(body).toContain('<input type="checkbox" name="removePhotoFile" value="1" class="deleteFileBox"/>');
  });

  it("fails closed on a photo that is no image, whose file name people's record does not carry", async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID }), withPhoto('pdf'));

    const loaded = editUserScreen.load!(ctx);

    await expect(loaded).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(loaded).rejects.toMatchObject({ reason: 'photo-filename-unserved' });
    expect(ctx.gateway.calls.some(({ service }) => service === 'programs-sites')).toBe(false);
  });
});

describe('cUsers.editUser sources no contract serves yet', () => {
  it("lists a stored user's web-service tokens and reads the interests of the requested site", async () => {
    const tokens = [
      { token: 'T0K3N-1', clientName: 'Mobile <App>' },
      { token: 'T0K3N-2', clientName: 'Reports' },
    ];
    const interestCategories = vi.fn(UNSERVED_EDIT_USER_SOURCES.interestCategories);
    const webServiceTokens = vi.fn(() => Promise.resolve(tokens));
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, siteid: 'default' }), editData());

    const body = await formOf(ctx, { interestCategories, webServiceTokens });

    expect(interestCategories).toHaveBeenCalledWith('default');
    expect(webServiceTokens).toHaveBeenCalledWith(ctx, EDITOR_ID);
    expect(body).toContain(
      '<label for="removeToken1" class="checkbox"><input name="removeToken" id="removeToken1" type="CHECKBOX" ' +
        'value="T0K3N-1" class="checkbox"> Mobile &lt;App&gt;</label>',
    );
    expect(body).toContain('id="removeToken2" type="CHECKBOX" value="T0K3N-2" class="checkbox"> Reports</label>');
    expect(body).not.toContain('This user has not connected through any web services.');
  });

  it('asks for no tokens of a new user and shows no Web Services block', async () => {
    const webServiceTokens = vi.fn(UNSERVED_EDIT_USER_SOURCES.webServiceTokens);
    const ctx = contextFor(editUserRequest({ userid: '' }), NEW_USER);

    const body = await formOf(ctx, { ...UNSERVED_EDIT_USER_SOURCES, webServiceTokens });

    expect(webServiceTokens).not.toHaveBeenCalled();
    expect(body).not.toContain('Web Services');
  });
});

describe('renderEditUser', () => {
  it('names the update action with the bean id and the URL-encoded route id', async () => {
    const ctx = contextFor(editUserRequest({ userid: EDITOR_ID, routeid: 'a b&c' }), editData());

    const view = await renderEditUser(ctx, await loadEditUser(ctx));

    expect(toString(view.body)).toContain(`muraAction=cUsers.update&userid=${EDITOR_ID}&routeid=a+b%26c"`);
    expect(view.htmlHead).toBeDefined();
  });
});
