// cUsers.editGroup against cusers/editgroup.cfm, cusers.cfc editGroup() (219-241) and utility.cfc displayErrors (111-124).
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import { isSafeHtml, toString } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import {
  CONTENT_TAB_LIST,
  GROUP_BEAN_RC_KEY,
  NO_GROUP_SUBTYPES,
  displayErrors,
  editGroupScreen,
  loadEditGroup,
  renderEditGroup,
  type EditGroupData,
  type GroupErrors,
  type GroupSubTypeLoader,
} from '@/screens/cusers/editgroup';
import { cusersGate } from '@/screens/cusers/gate';
import { CSRF_BY_CONTEXT, CSRF_CONTEXTS, CSRF_EDIT_GROUP } from '../../fixtures/identity/csrf';
import { GROUP_IDS, defaultAdminGroup, groupsById, newGroup } from '../../fixtures/identity/groups';
import { siteTenantA } from '../../fixtures/programs-sites/sites';
import { tenantASiteAdminSession } from '../../fixtures/session';
import {
  adminS2Request,
  editorRequest,
  siteAdminRequest,
  unservedEditorRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, normaliseIds, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type GroupAccount = IdentitySchemas['schemas']['GroupAccount'];
type GroupDetail = IdentitySchemas['schemas']['GroupDetail'];
type GroupWriteResult = IdentitySchemas['schemas']['GroupWriteResult'];
type IssuedCsrfToken = IdentitySchemas['schemas']['CsrfTokenSet']['tokens'][number];
type AdminRequest = ReturnType<typeof adminS2Request>;

const USERS_MODULE = '00000000000000000000000000000000008';
const SITE_MODULE = '00000000000000000000000000000000000';
const UNKNOWN_GROUP_ID = '6A000000-0000-0000-00000000000000FF';
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const DENIED = Object.freeze({ kind: 'redirect', location: 'secure()' } as const);

const editorGroup = groupsById[GROUP_IDS.defaultEditor]!;
const tenantAGroup = groupsById[GROUP_IDS.financeApprover]!;

const groupRoute = (groupId: string): string => routeKey('GET', 'identity', `/v1/groups/${groupId}`);

const groupReply = (group: GroupAccount, isNew = false): FakeReply => ({
  status: 200,
  body: { group, isNew } satisfies GroupDetail,
});

/** identity issuing the fixture pair of a known context and the fixed pair of any other. */
function csrfReply(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const issued = (context: string): IssuedCsrfToken =>
    CSRF_BY_CONTEXT[context] ?? { context, csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
  return { status: 200, body: { tokens: contexts.map(issued) } };
}

/** `cusers.editgroup` for the S2 admin with `rc`. */
const adminEdit = (rc: Record<string, string> = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item: 'editgroup', ...partial, rc });

/** `cusers.editgroup` for qa_editor holding the Users and Site Manager module roles on its token. */
const grantedEditorEdit = (rc: Record<string, string> = {}): AdminRequest =>
  editorRequest({
    circuit: 'cusers',
    item: 'editgroup',
    rc,
    user: { roles: [Roles.systemUser, moduleRole(SITE_MODULE), moduleRole(USERS_MODULE)] },
  });

/** The tenant-a site admin on its site, pooled as the seeded tenant-a site is. */
const siteAdminEdit = (rc: Record<string, string> = {}): AdminRequest =>
  siteAdminRequest(tenantASiteAdminSession.siteid, {
    circuit: 'cusers',
    item: 'editgroup',
    rc,
    site: { publicUserPoolID: siteTenantA.publicUserPoolID, privateUserPoolID: siteTenantA.privateUserPoolID },
  });

interface Rendered {
  readonly data: EditGroupData;
  readonly gateway: FakeGatewayClient;
  readonly markup: string;
  readonly $: CheerioAPI;
  readonly model: DomModel;
}

/** Loads and renders the view body for `req`, identity answering `routes` and the CSRF route. */
async function render(
  req: AdminRequest,
  routes: FakeRouteTable = {},
  loadSubTypes: GroupSubTypeLoader = NO_GROUP_SUBTYPES,
): Promise<Rendered> {
  const gateway = fakeGatewayClient({ [CSRF_ROUTE]: csrfReply, ...routes });
  const ctx = makeScreenContext({ req, gateway });
  const data = await loadEditGroup(ctx, loadSubTypes);
  const view = await renderEditGroup(ctx, data);
  expect(isSafeHtml(view.body)).toBe(true);
  const markup = toString(view.body);
  return {
    data,
    gateway,
    markup,
    $: cheerio.load(markup, null, false),
    model: fragmentModel(markup),
  };
}

/** `[name, value]` of every hidden input under `scope`. */
const hiddenFields = ($: CheerioAPI, scope: string): Array<[string, string]> =>
  $(scope)
    .find('input[type="hidden"]')
    .toArray()
    .map((el): [string, string] => [$(el).attr('name') ?? '', $(el).attr('value') ?? '']);

/** Name, type, value and checked flag of each control. */
const controlSummary = (model: DomModel): Array<Pick<DomModel['controls'][number], 'name' | 'type' | 'value' | 'checked'>> =>
  model.controls.map(({ name, type, value, checked }) => ({ name, type, value, checked }));

const radios = (model: DomModel): Array<[string, boolean]> =>
  model.controls.filter((c) => c.name === 'isPublic' && c.type === 'radio').map((c) => [c.value, c.checked]);

const callKeys = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.map((call) => `${call.method.toUpperCase()} ${call.service} ${call.path}`);

const csrfContexts = (gateway: FakeGatewayClient): unknown[] =>
  gateway.calls
    .filter((call) => call.path === '/v1/csrf/tokens')
    .map((call) => (call.json as { readonly contexts: readonly string[] }).contexts);

const href = (action: string, queryString?: string): string => normaliseAdminUrl(buildUrl(action, undefined, queryString));

const preservedBean = (result: GroupWriteResult & { readonly isNew?: boolean }): string => JSON.stringify(result);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('editGroupScreen', () => {
  it('is the identity-owned cusers.editgroup page behind the cUsers gate', () => {
    expect([editGroupScreen.circuit, editGroupScreen.action, editGroupScreen.owner, editGroupScreen.mode]).toEqual([
      'cusers',
      'editgroup',
      'identity',
      'page',
    ]);
    expect(editGroupScreen.gate).toBe(cusersGate);
    expect(Object.isFrozen(editGroupScreen)).toBe(true);
  });

  it('admits an editor granted Users and Site Manager from the token, not one holding Site Manager only', async () => {
    const secure = () => DENIED;
    await expect(cusersGate(grantedEditorEdit(), { secure })).resolves.toEqual({ kind: 'allow' });
    const plain = editorRequest({ circuit: 'cusers', item: 'editgroup', rc: { isAdmin: 'true' } });
    await expect(cusersGate(plain, { secure })).resolves.toBe(DENIED);
  });

  it('loads through its own load and renders with the user script in the head', async () => {
    const gateway = fakeGatewayClient({
      [CSRF_ROUTE]: csrfReply,
      [groupRoute(GROUP_IDS.defaultEditor)]: groupReply(editorGroup),
    });
    const ctx = makeScreenContext({ req: adminEdit({ userid: GROUP_IDS.defaultEditor }), gateway });
    const view = await editGroupScreen.render(ctx, await editGroupScreen.load!(ctx));
    expect(toString(view.body)).toContain('name="form1"');
    const head = view.htmlHead === undefined ? '' : toString(view.htmlHead);
    expect(head).toBe(
      `${toString(ctx.req.session.dateKey.script)}<script type="text/javascript" src="assets/js/user.js"></script>`,
    );
  });
});

describe('an existing group', () => {
  const editRoutes = (group: GroupAccount = editorGroup): FakeRouteTable => ({
    [groupRoute(group.UserID)]: groupReply(group),
  });

  it('reads the group from identity, then issues the CSRF pair of its id', async () => {
    const { gateway, data } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(callKeys(gateway)).toEqual([
      `GET identity /v1/groups/${GROUP_IDS.defaultEditor}`,
      'POST identity /v1/csrf/tokens',
    ]);
    expect(csrfContexts(gateway)).toEqual([[CSRF_CONTEXTS.editGroup]]);
    expect(data).toMatchObject({ userid: GROUP_IDS.defaultEditor, tempIsPublic: '0', userPoolId: 'default' });
    expect(data.bean).toMatchObject({ userId: GROUP_IDS.defaultEditor, isNew: false, errors: {} });
  });

  it('takes rc.groupid over rc.userid', async () => {
    const { gateway, data } = await render(
      adminEdit({ groupid: GROUP_IDS.defaultEditor, userid: UNKNOWN_GROUP_ID }),
      editRoutes(),
    );
    expect(data.userid).toBe(GROUP_IDS.defaultEditor);
    expect(callKeys(gateway)[0]).toBe(`GET identity /v1/groups/${GROUP_IDS.defaultEditor}`);
  });

  it('links back, to all groups and to the group members', async () => {
    const { model, $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(model.headings[0]).toBe('Group Maintenance Form');
    expect(model.links).toEqual([
      { href: '#', text: 'Back' },
      { href: href('cusers.list'), text: 'View All Groups' },
      {
        href: href('cusers.editgroupmembers', `userid=${GROUP_IDS.defaultEditor}&siteid=default`),
        text: "View This Group's Users",
      },
    ]);
    expect($('.mura-header a').first().attr('title')).toBe('Back');
  });

  it('posts form1 as multipart to cUsers.update for the group id', async () => {
    const { $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    const form = $('form[name="form1"]');
    expect(form).toHaveLength(1);
    expect([form.attr('method'), form.attr('enctype'), form.attr('novalidate')]).toEqual([
      'post',
      'multipart/form-data',
      'novalidate',
    ]);
    expect(form.attr('action')).toBe(buildUrl('cUsers.update', undefined, `userid=${GROUP_IDS.defaultEditor}`));
  });

  it('carries the update fields and the CSRF pair minted for the group id', async () => {
    const { $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(hiddenFields($, 'form[name="form1"]')).toEqual([
      ['action', 'Update'],
      ['type', '1'],
      ['contact', '0'],
      ['siteid', 'default'],
      ['returnurl', buildUrl('cUsers.list', undefined, 'ispublic=0')],
      ['subtype', 'Default'],
      ['csrf_token', CSRF_EDIT_GROUP.csrf_token],
      ['csrf_token_expires', CSRF_EDIT_GROUP.csrf_token_expires],
    ]);
  });

  it('offers Delete and Update, not Add', async () => {
    const { model, $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(model.buttons.map((b) => b.text)).toEqual(['Delete', 'Update']);
    expect($('button').eq(0).attr('onclick')).toBe(
      "submitForm(document.forms.form1,'delete','Delete User Group?');",
    );
    expect($('button').eq(1).attr('onclick')).toBe("userManager.submitForm(document.forms.form1,'update');");
  });

  it('renders the admin form controls with the stored group type and fields', async () => {
    const { model } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(model.labels).toEqual([
      'Group Type',
      'Member Group',
      'System Group',
      'Group Name',
      'Group Email',
      'Content UI Assignments',
    ]);
    expect(controlSummary(model)).toEqual([
      { name: 'setispublic', type: 'hidden', value: '1', checked: false },
      { name: 'isPublic', type: 'radio', value: '1', checked: false },
      { name: 'isPublic', type: 'radio', value: '0', checked: true },
      { name: 'groupname', type: 'text', value: 'Editor', checked: false },
      { name: 'email', type: 'text', value: 'editors@example.com', checked: false },
      { name: 'tablist', type: 'select-multiple', value: 'Basic', checked: false },
      { name: 'action', type: 'hidden', value: 'Update', checked: false },
      { name: 'type', type: 'hidden', value: '1', checked: false },
      { name: 'contact', type: 'hidden', value: '0', checked: false },
      { name: 'siteid', type: 'hidden', value: 'default', checked: false },
      { name: 'returnurl', type: 'hidden', value: buildUrl('cUsers.list', undefined, 'ispublic=0'), checked: false },
      { name: 'subtype', type: 'hidden', value: 'Default', checked: false },
      { name: 'csrf_token', type: 'hidden', value: CSRF_EDIT_GROUP.csrf_token, checked: false },
      { name: 'csrf_token_expires', type: 'hidden', value: CSRF_EDIT_GROUP.csrf_token_expires, checked: false },
    ]);
  });

  it('selects the stored content tabs among All and the content tab list', async () => {
    const { model } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    const tablist = model.controls.find((c) => c.name === 'tablist');
    expect(tablist?.options.map((o) => o.value)).toEqual(['', ...CONTENT_TAB_LIST.split(',')]);
    expect(tablist?.selected).toEqual(['Basic', 'Publishing', 'Layout & Objects']);
  });

  it('carries the admin frmTemp that reloads with the clicked group type', async () => {
    const { $, markup } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes());
    expect(hiddenFields($, 'form#frmTemp')).toEqual([['setispublic', '1']]);
    expect($('form#frmTemp').attr('method')).toBe('post');
    expect(markup).toContain(`$('form#frmTemp input[name="setispublic"]').val($(this).val());`);
  });

  it.each<[string, string, Array<[string, boolean]>]>([
    ['1', 'ispublic=1', [['1', true], ['0', false]]],
    ['0', 'ispublic=0', [['1', false], ['0', true]]],
  ])('lets an admin rc.setispublic=%s override the stored group type', async (setispublic, query, expected) => {
    const group: GroupAccount = { ...editorGroup, isPublic: setispublic === '1' ? 0 : 1 };
    const { model, $, data } = await render(
      adminEdit({ userid: GROUP_IDS.defaultEditor, setispublic }),
      editRoutes(group),
    );
    expect(data.tempIsPublic).toBe(setispublic);
    expect(radios(model)).toEqual(expected);
    expect($('input[name="returnurl"]').attr('value')).toBe(buildUrl('cUsers.list', undefined, query));
  });

  it('HTML-encodes the stored group name and email', async () => {
    const group: GroupAccount = { ...editorGroup, GroupName: 'R&D <Editors>', Email: 'r&d"team@example.com' };
    const { model, markup } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes(group));
    expect(markup).toContain('name="groupname" value="R&amp;D &lt;Editors&gt;"');
    expect(markup).toContain('name="email" value="r&amp;d&quot;team&#x40;example.com"');
    expect(model.controls.filter((c) => c.type === 'text').map((c) => c.value)).toEqual([
      'R&D <Editors>',
      'r&d"team@example.com',
    ]);
  });

  it('shows a Perm group type as a hidden field, its name read-only and no tab assignments', async () => {
    const { model, $ } = await render(adminEdit({ userid: GROUP_IDS.defaultAdmin }), editRoutes(defaultAdminGroup));
    expect(radios(model)).toEqual([]);
    expect(hiddenFields($, 'form[name="form1"]')[0]).toEqual(['isPublic', '0']);
    expect($('input[name="groupname"]').attr('readonly')).toBe('readonly');
    expect(model.controls.some((c) => c.name === 'tablist')).toBe(false);
    expect(model.controls.find((c) => c.name === 'email')?.value).toBe('');
  });

  it('links the members of a tenant-a group on the site admin site and pools system groups privately', async () => {
    const loadSubTypes = vi.fn<GroupSubTypeLoader>(() => Promise.resolve([]));
    const { model, data } = await render(
      siteAdminEdit({ userid: tenantAGroup.UserID, ispublic: '0' }),
      editRoutes(tenantAGroup),
      loadSubTypes,
    );
    expect(model.links.at(-1)?.href).toBe(
      href('cusers.editgroupmembers', `userid=${tenantAGroup.UserID}&siteid=${siteTenantA.SiteID}`),
    );
    expect(radios(model)).toEqual([
      ['1', false],
      ['0', true],
    ]);
    expect(data.userPoolId).toBe(siteTenantA.privateUserPoolID);
    expect(loadSubTypes).toHaveBeenCalledWith(expect.anything(), siteTenantA.privateUserPoolID);
  });

  it('reads the public pool for member groups', async () => {
    const loadSubTypes = vi.fn<GroupSubTypeLoader>(() => Promise.resolve([]));
    await render(siteAdminEdit({ userid: tenantAGroup.UserID }), editRoutes(tenantAGroup), loadSubTypes);
    expect(loadSubTypes).toHaveBeenCalledWith(expect.anything(), siteTenantA.publicUserPoolID);
  });

  it('propagates an identity refusal of the group read', async () => {
    await expect(
      render(adminEdit({ userid: GROUP_IDS.defaultEditor }), { [groupRoute(GROUP_IDS.defaultEditor)]: { status: 403 } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a request without site data', async () => {
    const gateway = fakeGatewayClient({ [CSRF_ROUTE]: csrfReply });
    const ctx = makeScreenContext({ req: unservedEditorRequest({ circuit: 'cusers', item: 'editgroup' }), gateway });
    await expect(loadEditGroup(ctx)).rejects.toThrow(TypeError);
    expect(gateway.calls).toEqual([]);
  });
});

describe('a new group', () => {
  it('builds a new bean without an identity read and issues the CSRF pair of its new id', async () => {
    const { gateway, data, $ } = await render(adminEdit());
    expect(data.userid).toBe('');
    expect(data.bean).toMatchObject({ isNew: true, groupName: '', email: '', isPublic: '1', subType: 'Default' });
    expect(isCfUuid(data.bean.userId)).toBe(true);
    expect(callKeys(gateway)).toEqual(['POST identity /v1/csrf/tokens']);
    expect(csrfContexts(gateway)).toEqual([[data.bean.userId]]);
    expect($('form[name="form1"]').attr('action')).toBe(buildUrl('cUsers.update', undefined, `userid=${data.bean.userId}`));
    expect($('input[name="csrf_token"]').attr('value')).toBe(FIXED_CSRF.token);
  });

  it('offers Add only, posts action=Add and links no group members', async () => {
    const { model, $ } = await render(adminEdit());
    const normalised = normaliseIds(model);
    expect(normalised.buttons).toEqual([{ text: 'Add', type: 'button', hasOnclick: true }]);
    expect($('button').attr('onclick')).toBe("userManager.submitForm(document.forms.form1,'add');");
    expect(normalised.links.map((l) => l.text)).toEqual(['Back', 'View All Groups']);
    expect(hiddenFields($, 'form[name="form1"]')).toMatchObject([
      ['action', 'Add'],
      ['type', '1'],
      ['contact', '0'],
      ['siteid', 'default'],
      ['returnurl', buildUrl('cUsers.list', undefined, 'ispublic=1')],
      ['subtype', 'Default'],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
  });

  it('defaults the admin group type to Member', async () => {
    const { model } = await render(adminEdit());
    // Known issue reproduced: the group and user forms default to Member.
    expect(radios(model)).toEqual([
      ['1', true],
      ['0', false],
    ]);
  });

  it('keeps Update and Delete for an unknown id identity answers as new, without the members link', async () => {
    const unknown: GroupAccount = { ...newGroup, UserID: UNKNOWN_GROUP_ID };
    const { model, data, $ } = await render(adminEdit({ userid: UNKNOWN_GROUP_ID }), {
      [groupRoute(UNKNOWN_GROUP_ID)]: groupReply(unknown, true),
    });
    expect(data.bean.isNew).toBe(true);
    expect(model.links.map((l) => l.text)).toEqual(['Back', 'View All Groups']);
    expect(model.buttons.map((b) => b.text)).toEqual(['Delete', 'Update']);
    expect($('input[name="action"]').attr('value')).toBe('Update');
  });

  it('gives a non-admin editor a hidden group type, ignoring rc.setispublic', async () => {
    const { model, $, data, markup } = await render(grantedEditorEdit({ setispublic: '0' }));
    expect(data.rc.isAdmin).toBe(false);
    expect(data.tempIsPublic).toBe('1');
    expect(radios(model)).toEqual([]);
    expect(model.labels).not.toContain('Group Type');
    expect(hiddenFields($, 'form[name="form1"]')[0]).toEqual(['isPublic', '1']);
    expect($('form#frmTemp')).toHaveLength(0);
    expect(markup).not.toContain('setispublic');
  });

  it('never takes admin from rc', async () => {
    const { model, data } = await render(grantedEditorEdit({ isAdmin: 'true', ispublic: '0' }));
    expect(data.rc.isAdmin).toBe(false);
    expect(data.rc.ispublic).toBe('1');
    expect(radios(model)).toEqual([]);
  });
});

describe('group subtypes', () => {
  const editRoutes: FakeRouteTable = { [groupRoute(GROUP_IDS.defaultEditor)]: groupReply(editorGroup) };
  const withSubTypes =
    (...subTypes: string[]): GroupSubTypeLoader =>
    () =>
      Promise.resolve(subTypes.map((subType) => ({ subType })));

  it('adds the tabs and a subtype select for a non-Default subtype, without the hidden Default', async () => {
    const { model, $, markup, data } = await render(
      adminEdit({ userid: GROUP_IDS.defaultEditor }),
      editRoutes,
      withSubTypes('Default', 'Department'),
    );
    expect($('ul.mura-tabs li a span').toArray().map((el) => $(el).text().trim())).toEqual([
      'Basic',
      'Extended Attributes',
    ]);
    expect(model.headings).toContain('Basic Settings');
    expect(model.headings).toContain('Extended Attributes');
    const subtype = model.controls.find((c) => c.name === 'subtype');
    expect(subtype).toMatchObject({ tag: 'select', type: 'select-one', selected: ['Default'] });
    expect(subtype?.options.map((o) => [o.value, o.label])).toEqual([
      ['Default', 'Default'],
      ['Department', 'Department'],
    ]);
    expect(hiddenFields($, 'form[name="form1"]').some(([name]) => name === 'subtype')).toBe(false);
    expect($('button').eq(1).attr('onclick')).toBe("submitForm(document.forms.form1,'update');");
    expect(markup).toContain(
      `userManager.loadExtendedAttributes('${GROUP_IDS.defaultEditor}','1','Default','${data.userPoolId}',`,
    );
  });

  it('selects the stored non-Default subtype', async () => {
    const routes: FakeRouteTable = {
      [groupRoute(GROUP_IDS.defaultEditor)]: groupReply({ ...editorGroup, subType: 'Department' }),
    };
    const { model } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), routes, withSubTypes('Department'));
    expect(model.controls.find((c) => c.name === 'subtype')?.selected).toEqual(['Department']);
  });

  it('keeps the hidden Default subtype when the pool has only the Default subtype', async () => {
    const { model, $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor }), editRoutes, withSubTypes('Default'));
    expect($('ul.mura-tabs')).toHaveLength(1);
    expect(model.controls.filter((c) => c.name === 'subtype').map((c) => [c.type, c.value])).toEqual([
      ['hidden', 'Default'],
    ]);
  });

  it.each<[string, AdminRequestPartial['site'], RegExp]>([
    ['a local theme', { record: { theme: 'MasaBootstrap5' } }, /^[^:]*\/themes\/MasaBootstrap5$/],
    ['a remote context', { record: { isremote: 1, remotecontext: '/remote', theme: 'T' } }, /^\/remote\/themes\/T$/],
    [
      'a remote resource domain',
      { record: { isremote: 1, resourceDomain: 'cdn.example.test', resourceSSL: 1, theme: 'T' } },
      /^https:\/\/cdn\.example\.test.*\/themes\/T$/,
    ],
    [
      'a remote resource domain over the site SSL flag',
      { record: { isremote: 1, resourceDomain: 'cdn.example.test', useSSL: null, ExtranetSSL: 0, theme: 'T' } },
      /^http:\/\/cdn\.example\.test.*\/themes\/T$/,
    ],
  ])('passes the theme asset path of %s to the extended-attribute loader', async (_, site, expected) => {
    const { data, markup } = await render(
      adminEdit({ userid: GROUP_IDS.defaultEditor }, { site }),
      editRoutes,
      withSubTypes('Default', 'Department'),
    );
    expect(data.themeAssetPath).toMatch(expected);
    expect(markup).toContain(`'${data.themeAssetPath}');`);
  });

  it('submits Add through the global submitForm in the tabbed form', async () => {
    const { $ } = await render(adminEdit(), {}, withSubTypes('Default'));
    expect($('button').attr('onclick')).toBe("submitForm(document.forms.form1,'add');");
  });
});

describe('a re-rendered group with errors', () => {
  const USERNAME_TAKEN = "The username 'jsmith' is already in use.";
  const errors: GroupErrors = { groupname: "The 'Group Name' field is required.", username: USERNAME_TAKEN, siteID: 'default' };
  const failed = (isNew?: boolean): string =>
    preservedBean({
      written: false,
      group: { ...editorGroup, GroupName: '' },
      errors,
      ...(isNew === undefined ? {} : { isNew }),
    });

  it('shows the alert with the displayErrors output and the posted values', async () => {
    const { $, model, gateway } = await render(
      adminEdit({ userid: GROUP_IDS.defaultEditor, [GROUP_BEAN_RC_KEY]: failed(false) }),
    );
    const alert = $('div.alert.alert-error');
    expect(alert).toHaveLength(1);
    expect(alert.children('span').html()).toBe(toString(displayErrors(errors)));
    expect(alert.html()).toContain(USERNAME_TAKEN);
    expect(model.alerts).toEqual([
      { text: `The 'Group Name' field is required. ${USERNAME_TAKEN}`, className: 'alert alert-error' },
    ]);
    expect(model.controls.find((c) => c.name === 'groupname')?.value).toBe('');
    expect(callKeys(gateway)).toEqual(['POST identity /v1/csrf/tokens']);
  });

  it('asks identity whether the preserved group is stored when the result does not say', async () => {
    const { gateway, data, model } = await render(
      adminEdit({ userid: GROUP_IDS.defaultEditor, [GROUP_BEAN_RC_KEY]: failed() }),
      { [groupRoute(GROUP_IDS.defaultEditor)]: groupReply(newGroup, true) },
    );
    expect(callKeys(gateway)).toEqual([
      `GET identity /v1/groups/${GROUP_IDS.defaultEditor}`,
      'POST identity /v1/csrf/tokens',
    ]);
    expect(data.bean).toMatchObject({ userId: GROUP_IDS.defaultEditor, isNew: true, groupName: '' });
    expect(model.links.map((l) => l.text)).toEqual(['Back', 'View All Groups']);
  });

  it('shows no alert for a saved bean without errors', async () => {
    const saved = preservedBean({ written: true, group: editorGroup, errors: {}, isNew: false });
    const { $ } = await render(adminEdit({ userid: GROUP_IDS.defaultEditor, [GROUP_BEAN_RC_KEY]: saved }));
    expect($('.alert')).toHaveLength(0);
  });

  it.each([
    ['not a write result', '[]'],
    ['without a group', JSON.stringify({ written: false, errors: {} })],
    ['with errors that are not a struct', JSON.stringify({ written: false, group: editorGroup, errors: 'x', isNew: false })],
    [
      'with a complex group column',
      JSON.stringify({ written: false, group: { ...editorGroup, GroupName: { x: 1 } }, errors: {}, isNew: false }),
    ],
  ])('rejects a preserved bean %s', async (_, value) => {
    await expect(render(adminEdit({ [GROUP_BEAN_RC_KEY]: value }))).rejects.toThrow(TypeError);
  });
});

describe('displayErrors', () => {
  it.each<[string, GroupErrors, string, string]>([
    ['two messages', { username: 'A', email: 'B' }, ' A <br> B ', 'A<br>B'],
    ['a leading siteID, counted but skipped', { siteID: 'x', username: 'A' }, ' A ', 'A'],
    ['a trailing siteID, leaving the legacy trailing break', { username: 'A', siteID: 'x' }, ' A <br> ', 'A<br>'],
    ['no errors', {}, ' ', ''],
  ])('renders %s', (_, errors, exact, compact) => {
    const markup = displayErrors(errors);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(exact);
    expect(toString(markup).replace(/\s+/g, '')).toBe(compact);
  });

  it('emits messages unencoded, as CFML outputs them', () => {
    const out = toString(displayErrors({ username: "The username 'jsmith' is already in use.", email: '<b>B</b> & C' }));
    expect(out).toBe(" The username 'jsmith' is already in use. <br> <b>B</b> & C ");
  });
});
