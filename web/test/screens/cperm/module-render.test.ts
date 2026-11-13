// cperm.module against legacy cperm/module.cfm and the cperm.cfc module() step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import { GatewayDenialError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import { cpermModule, loadCpermModule, renderCpermModule, type CpermModuleModel } from '@/screens/cperm/module';
import { cpermGate } from '@/screens/cperm/partials';
import { CSRF_BY_CONTEXT, CSRF_CONTEXTS, CSRF_CPERM_MODULE } from '../../fixtures/identity/csrf';
import { GROUP_IDS, defaultEditorGroup, groupsById, umbrellaMembersGroup } from '../../fixtures/identity/groups';
import type { AdminRequest } from '@/lib/request-context';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ModulePermissions = IdentitySchemas['schemas']['ModulePermissions'];
type ModuleGroupGrant = IdentitySchemas['schemas']['ModuleGroupGrant'];
type GroupAccount = IdentitySchemas['schemas']['GroupAccount'];
type IssuedCsrfToken = IdentitySchemas['schemas']['CsrfTokenSet']['tokens'][number];

const SITE = 'default';
const USERS_MODULE = CSRF_CONTEXTS.cpermModule;
const CATEGORIES_MODULE = '00000000000000000000000000000000010';
const NO_GROUPS = '<div class="help-block-empty">There are currently no groups available.</div>';
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const CATEGORIES_CSRF: IssuedCsrfToken = {
  ...CSRF_CPERM_MODULE,
  context: CATEGORIES_MODULE,
  csrf_token: CSRF_CPERM_MODULE.csrf_token.replace(/6$/, '8'),
};

const grantsRoute = (moduleId: string): string => routeKey('GET', 'identity', `/v1/permissions/modules/${moduleId}`);
const historyRoute = (contentid: string): string =>
  routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/${contentid}/history`);

const grant = (group: GroupAccount, granted: boolean): ModuleGroupGrant => ({
  groupId: group.UserID,
  groupName: group.GroupName ?? '',
  granted,
});

const grants = (moduleId: string, privateGroups: ModuleGroupGrant[], publicGroups: ModuleGroupGrant[]): FakeReply => ({
  status: 200,
  body: { moduleId, siteId: SITE, privateGroups, publicGroups } satisfies ModulePermissions,
});

const history = (title: unknown): FakeReply => ({ status: 200, body: { rc: { contentBean: { title } } } });

/** Identity issuing the fixture pair of each context, the categories pair for that module. */
function csrfReply(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const byContext: Readonly<Record<string, IssuedCsrfToken>> = {
    ...CSRF_BY_CONTEXT,
    [CATEGORIES_MODULE]: CATEGORIES_CSRF,
  };
  return { status: 200, body: { tokens: contexts.map((context) => byContext[context]) } };
}

/** The users module's answers: Editor not granted and no member groups, as the installed site holds them. */
const siteMembersRoutes = (): Record<string, FakeRoute> => ({
  [CSRF_ROUTE]: csrfReply,
  [grantsRoute(USERS_MODULE)]: grants(USERS_MODULE, [grant(defaultEditorGroup, false)], []),
  [historyRoute(USERS_MODULE)]: history('Site Members'),
});

/** The categories module's answers: Editor granted, a role group not, and the granted umbrella members. */
const categoriesRoutes = (): Record<string, FakeRoute> => ({
  [CSRF_ROUTE]: csrfReply,
  [grantsRoute(CATEGORIES_MODULE)]: grants(
    CATEGORIES_MODULE,
    [grant(defaultEditorGroup, true), grant(groupsById[GROUP_IDS.financeApprover]!, false)],
    [grant(umbrellaMembersGroup, true)],
  ),
  [historyRoute(CATEGORIES_MODULE)]: history('Categories'),
});

/** The S2 admin's request for the permissions of `moduleId`, as the module links send it. */
const moduleRequest = (moduleId: string, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({
    circuit: 'cperm',
    item: 'module',
    ...partial,
    rc: { contentid: moduleId, moduleid: moduleId, ...partial.rc },
  });

/** The view body cpermModule loads and renders for `moduleId`. */
async function markupOf(gateway: FakeGatewayClient, moduleId: string, partial?: AdminRequestPartial): Promise<string> {
  const ctx = makeScreenContext({ req: moduleRequest(moduleId, partial), gateway });
  const view = await cpermModule.render(ctx, await loadCpermModule(ctx));
  expect(isSafeHtml(view.body)).toBe(true);
  return toString(view.body);
}

/** The hidden fields of `markup`, as `[name, value]`. */
const hiddenFields = (markup: string): Array<[string, string]> =>
  fragmentModel(markup)
    .controls.filter((control) => control.type === 'hidden')
    .map((control) => [control.name, control.value]);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cpermModule', () => {
  it('is the identity-owned cperm.module page behind the cperm gate', () => {
    expect([cpermModule.circuit, cpermModule.action, cpermModule.owner, cpermModule.mode]).toEqual([
      'cperm',
      'module',
      'identity',
      'page',
    ]);
    expect(cpermModule.gate).toBe(cpermGate);
    expect(Object.isFrozen(cpermModule)).toBe(true);
  });

  it('renders the Site Members view byte for byte as legacy does', async () => {
    const markup = await markupOf(fakeGatewayClient(siteMembersRoutes()), USERS_MODULE);
    expect(markup).toBe(
      [
        '',
        '<div class="mura-header">',
        '  <h1>Site Members Permissions</h1>',
        '  <div class="nav-module-specific btn-group">',
        '    <a class="btn" href="#" title="Back" onclick="window.history.back(); return false;"><i class="mi-arrow-circle-left"></i> Back</a>',
        '  </div>',
        '</div> <!-- /.mura-header -->',
        '',
        '<div class="block block-constrain">',
        '    <div class="block block-bordered">',
        '      <div class="block-content">',
        '',
        '      <div class="help-block">To set permissions for Site Members, check the box for each user group that should have access.</div>',
        `      <form novalidate="novalidate"  method="post" name="form1" action="./?muraAction=cPerm.updatemodule&contentid=${USERS_MODULE}">`,
        '        <div class="block-content">',
        '        <h2>System Groups</h2>',
        '',
        '      ',
        '          <table class="mura-table-grid">',
        '            <tr>',
        '              <th>Allow</th>',
        '              <th class="var-width">Group</th>',
        '            </tr>',
        '              ',
        '                    <tr>',
        `                      <td><input type="checkbox" name="groupid" value="${GROUP_IDS.defaultEditor}"></td>`,
        '                <td class="var-width" nowrap>Editor</td>',
        '              </tr>',
        '         ',
        '         </table>',
        '    ',
        '',
        '      </div><!-- /.block-content -->',
        '      ',
        '      <div class="block-content">',
        ' <h2>Member Groups</h2>',
        '  <div class="help-block">These permissions can allow site members to edit content on the front-end of the site.<br>Site members will <em>not</em> have access to the back-end administration area.</div>',
        '',
        '  ',
        `        ${NO_GROUPS}`,
        '  ',
        '',
        '',
        '      <div class="mura-actions">',
        '        <div class="form-actions no-offset">',
        '        <button class="btn mura-primary" onclick="submitForm(document.forms.form1);"><i class="mi-check-circle"></i>Update</button>',
        '        </div>',
        '      </div>',
        '',
        '      <input type="hidden" name="router" value="">',
        `      <input type="hidden" name="siteid" value="${SITE}">`,
        '      <input type="hidden" name="topid" value="">',
        `      <input type="hidden" name="moduleid" value="${USERS_MODULE}">`,
        `      <input type="hidden" name="csrf_token" value="${CSRF_CPERM_MODULE.csrf_token}" /><input type="hidden" name="csrf_token_expires" value="${CSRF_CPERM_MODULE.csrf_token_expires}" />`,
        '      </form>',
        '',
        '      </div> <!-- /.block-content -->',
        '    </div> <!-- /.block-bordered -->',
        '  </div> <!-- /.block-constrain -->',
        '',
        '',
      ].join('\n'),
    );
  });

  it('renders the categories grants inside the shell', async () => {
    const gateway = fakeGatewayClient(categoriesRoutes());
    const ctx = makeScreenContext({ req: moduleRequest(CATEGORIES_MODULE), gateway });
    const page = await renderScreenPage(cpermModule, ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const model = domModel(page.html);
    expect(model.title).toBe('Masa CMS - Permissions');
    expect(model.headings).toEqual(
      expect.arrayContaining(['Categories Permissions', 'System Groups', 'Member Groups']),
    );
    expect(model.tables).toEqual([
      { headers: ['Allow', 'Group'], rows: [['', 'Editor'], ['', 'finance.approver']] },
      { headers: ['Allow', 'Group'], rows: [['', 'Umbrella Members']] },
    ]);
    const checkboxes = model.controls.filter((control) => control.name === 'groupid');
    expect(checkboxes.map((control) => [control.type, control.value, control.checked])).toEqual([
      ['checkbox', GROUP_IDS.defaultEditor, true],
      ['checkbox', GROUP_IDS.financeApprover, false],
      ['checkbox', GROUP_IDS.umbrellaMembers, true],
    ]);
    expect(model.buttons).toEqual(expect.arrayContaining([{ text: 'Update', type: 'submit', hasOnclick: true }]));
    expect(page.html).toContain(
      '<div class="help-block">To set permissions for Categories, check the box for each user group that should have access.</div>',
    );
    expect(page.html).toContain(
      `<form novalidate="novalidate"  method="post" name="form1" action="./?muraAction=cPerm.updatemodule&contentid=${CATEGORIES_MODULE}">`,
    );
    expect(hiddenFields(page.html)).toEqual(
      expect.arrayContaining([
        ['siteid', SITE],
        ['topid', ''],
        ['moduleid', CATEGORIES_MODULE],
        ['csrf_token', CATEGORIES_CSRF.csrf_token],
        ['csrf_token_expires', CATEGORIES_CSRF.csrf_token_expires],
      ]),
    );
  });

  it('writes checked straight after the value quote', async () => {
    const markup = await markupOf(fakeGatewayClient(categoriesRoutes()), CATEGORIES_MODULE);
    expect(markup).toContain(`name="groupid" value="${GROUP_IDS.defaultEditor}"checked></td>`);
    expect(markup).toContain(`name="groupid" value="${GROUP_IDS.financeApprover}"></td>`);
    expect(markup).toContain(`name="groupid" value="${GROUP_IDS.umbrellaMembers}"checked></td>`);
  });

  it('shows the empty notice for both lists without groups', async () => {
    const gateway = fakeGatewayClient({
      ...categoriesRoutes(),
      [grantsRoute(CATEGORIES_MODULE)]: grants(CATEGORIES_MODULE, [], []),
    });
    const markup = await markupOf(gateway, CATEGORIES_MODULE);
    expect(markup.split(NO_GROUPS)).toHaveLength(3);
    expect(markup).not.toContain('<table');
    const model = fragmentModel(markup);
    expect(model.tables).toEqual([]);
    expect(model.controls.filter((control) => control.name === 'groupid')).toEqual([]);
    expect(model.headings).toEqual(['Categories Permissions', 'System Groups', 'Member Groups']);
  });

  it('writes system group names unencoded and member group names encoded', async () => {
    const name = '<em>R&D</em> "Team"';
    const gateway = fakeGatewayClient({
      ...categoriesRoutes(),
      [grantsRoute(CATEGORIES_MODULE)]: grants(
        CATEGORIES_MODULE,
        [{ ...grant(defaultEditorGroup, false), groupName: name }],
        [{ ...grant(umbrellaMembersGroup, false), groupName: name }],
      ),
    });
    const markup = await markupOf(gateway, CATEGORIES_MODULE);
    expect(markup).toContain(`<td class="var-width" nowrap>${name}</td>`);
    expect(markup).toContain('<td class="var-width" nowrap>&lt;em&gt;R&amp;D&lt;&#x2f;em&gt; &quot;Team&quot;</td>');
  });

  it.each<[string, string, string]>([
    ['markup', '<b>Tags</b> & More', '<b>Tags</b> & More'],
    ['a list, whose first item fills {1}', 'Tags, Topics', 'Tags'],
  ])('writes a title with %s unencoded into the heading and the help text', async (_case, title, filled) => {
    const gateway = fakeGatewayClient({ ...categoriesRoutes(), [historyRoute(CATEGORIES_MODULE)]: history(title) });
    const markup = await markupOf(gateway, CATEGORIES_MODULE);
    expect(markup).toContain(`<h1>${title} Permissions</h1>`);
    expect(markup).toContain(`<div class="help-block">To set permissions for ${filled}, check the box`);
  });

  it('keys grants and title by contentid and the CSRF pair by moduleid', async () => {
    const gateway = fakeGatewayClient(categoriesRoutes());
    const markup = await markupOf(gateway, CATEGORIES_MODULE, { rc: { moduleid: USERS_MODULE } });
    const calls = gateway.calls.map(({ service, method, path, query, json }) => ({
      service,
      method,
      path,
      query,
      json,
    }));
    expect(calls).toEqual([
      {
        service: 'identity',
        method: 'GET',
        path: `/v1/permissions/modules/${CATEGORIES_MODULE}`,
        query: { siteid: SITE },
        json: undefined,
      },
      {
        service: 'strategies-content',
        method: 'GET',
        path: `/v1/sites/${SITE}/content/${CATEGORIES_MODULE}/history`,
        query: undefined,
        json: undefined,
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/csrf/tokens',
        query: undefined,
        json: { contexts: [USERS_MODULE] },
      },
    ]);
    expect(markup).toContain(`action="./?muraAction=cPerm.updatemodule&contentid=${CATEGORIES_MODULE}"`);
    expect(hiddenFields(markup)).toEqual([
      ['router', ''],
      ['siteid', SITE],
      ['topid', ''],
      ['moduleid', USERS_MODULE],
      ['csrf_token', CSRF_CPERM_MODULE.csrf_token],
      ['csrf_token_expires', CSRF_CPERM_MODULE.csrf_token_expires],
    ]);
  });

  it('carries the referer and rc values attribute-encoded in the hidden fields', async () => {
    const referer = 'http://localhost/admin/?muraAction=cArch.list&siteid=default&x="1"';
    const markup = await markupOf(fakeGatewayClient(siteMembersRoutes()), USERS_MODULE, {
      headers: new Headers({ referer }),
      rc: { topid: '"top"' },
    });
    const html = markup.match(/<input type="hidden" name="(?:router|topid)" value="[^"]*">/g);
    expect(html).toEqual([
      '<input type="hidden" name="router" value="http&#x3a;&#x2f;&#x2f;localhost&#x2f;admin&#x2f;&#x3f;muraAction&#x3d;cArch.list&amp;siteid&#x3d;default&amp;x&#x3d;&quot;1&quot;">',
      '<input type="hidden" name="topid" value="&quot;top&quot;">',
    ]);
    expect(hiddenFields(markup).slice(0, 3)).toEqual([
      ['router', referer],
      ['siteid', SITE],
      ['topid', '"top"'],
    ]);
  });
});

describe('loadCpermModule', () => {
  const load = (gateway: FakeGatewayClient, partial?: AdminRequestPartial): Promise<CpermModuleModel> =>
    loadCpermModule(makeScreenContext({ req: moduleRequest(USERS_MODULE, partial), gateway }));

  it('maps identity grants to the view rows', async () => {
    expect(await load(fakeGatewayClient(siteMembersRoutes()))).toEqual({
      title: 'Site Members',
      privateGroups: [{ userid: GROUP_IDS.defaultEditor, groupname: 'Editor', allowed: false }],
      publicGroups: [],
    });
  });

  it.each<[string, unknown, string]>([
    ['a missing node', undefined, ''],
    ['a NULL title', null, ''],
    ['a numeric title', 42, '42'],
    ['a boolean title', true, 'true'],
  ])('reads %s', async (_case, title, expected) => {
    const routes = siteMembersRoutes();
    routes[historyRoute(USERS_MODULE)] = title === undefined ? { status: 404 } : history(title);
    expect((await load(fakeGatewayClient(routes))).title).toBe(expected);
  });

  it('reads the bean and title keys case-insensitively', async () => {
    const routes = siteMembersRoutes();
    routes[historyRoute(USERS_MODULE)] = { status: 200, body: { rc: { CONTENTBEAN: { Title: 'Members' } } } };
    expect((await load(fakeGatewayClient(routes))).title).toBe('Members');
  });

  it('renders a missing node as legacy renders an empty query', async () => {
    const routes = siteMembersRoutes();
    routes[historyRoute(USERS_MODULE)] = { status: 404 };
    const ctx = makeScreenContext({ req: moduleRequest(USERS_MODULE), gateway: fakeGatewayClient(routes) });
    const markup = toString(renderCpermModule(await loadCpermModule(ctx), ctx));
    expect(markup).toContain('<h1> Permissions</h1>');
    expect(markup).toContain('<div class="help-block">To set permissions for {1}, check the box');
  });

  it.each<[string, unknown]>([
    ['a bean that is not a struct', { rc: { contentBean: 'x' } }],
    ['a null bean', { rc: { contentBean: null } }],
    ['a bean list', { rc: { contentBean: [] } }],
    ['no bean', { rc: {} }],
    ['a title that is not simple', { rc: { contentBean: { title: { text: 'x' } } } }],
  ])('rejects %s', async (_case, body) => {
    const routes = siteMembersRoutes();
    routes[historyRoute(USERS_MODULE)] = { status: 200, body };
    await expect(load(fakeGatewayClient(routes))).rejects.toThrow(TypeError);
  });

  it.each(['siteid', 'contentid'])('throws for an empty rc.%s before calling a service', async (name) => {
    const gateway = fakeGatewayClient(siteMembersRoutes());
    await expect(load(gateway, { rc: { [name]: '' } })).rejects.toThrow(`rc.${name} is empty`);
    expect(gateway.calls).toEqual([]);
  });

  it.each<[string, string, 401 | 403]>([
    ['identity', grantsRoute(USERS_MODULE), 403],
    ['strategies-content', historyRoute(USERS_MODULE), 401],
  ])('raises a %s denial', async (service, route, status) => {
    const routes = siteMembersRoutes();
    routes[route] = { status };
    const error = await load(fakeGatewayClient(routes)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service, status });
  });

  it('fails on another identity error', async () => {
    const routes = siteMembersRoutes();
    routes[grantsRoute(USERS_MODULE)] = { status: 500 };
    await expect(load(fakeGatewayClient(routes))).rejects.toThrow('getModulePermissions answered HTTP 500');
  });
});

describe('cpermModule page', () => {
  it('sends the editor back without reading grants', async () => {
    const gateway = fakeGatewayClient(siteMembersRoutes());
    const rc = { contentid: USERS_MODULE, moduleid: USERS_MODULE };
    const req = editorRequest({ circuit: 'cperm', item: 'module', rc });
    expect(await renderScreenPage(cpermModule, makeScreenContext({ req, gateway }))).toEqual({
      kind: 'redirect',
      location: './',
    });
    expect(gateway.calls).toEqual([]);
  });

  it('answers an identity denial with the no-access redirect', async () => {
    const gateway = fakeGatewayClient({ ...siteMembersRoutes(), [grantsRoute(USERS_MODULE)]: { status: 403 } });
    const ctx = makeScreenContext({ req: moduleRequest(USERS_MODULE), gateway });
    expect(await renderScreenPage(cpermModule, ctx)).toEqual({
      kind: 'redirect',
      location: '/admin/?muraAction=cMessage.noaccess',
    });
  });
});
