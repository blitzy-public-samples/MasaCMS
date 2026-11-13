// cperm.module over the identity fixtures, as the GS-ID-07 DOM model reads it.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import type { components as ContentSchemas } from '@/generated/clients/strategies-content';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cpermModule, loadCpermModule, renderCpermModule } from '@/screens/cperm/module';
import { CSRF_BY_CONTEXT, CSRF_CPERM_MODULE } from '../../fixtures/identity/csrf';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import {
  MODULE_IDS,
  cpermModuleCategoriesAnswer,
  cpermModuleNoGroupsAnswer,
  cpermModuleUsersAnswer,
} from '../../fixtures/identity/permissions';
import { adminS2Request, editorRequest, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ModulePermissions = IdentitySchemas['schemas']['ModulePermissions'];
type IssuedCsrfToken = IdentitySchemas['schemas']['CsrfTokenSet']['tokens'][number];
type AdminView = ContentSchemas['schemas']['AdminViewModel'];

const SITE = 'tenant-a';
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const MEMBER_SCRIPT =
  'These permissions can allow site members to edit content on the front-end of the site.<br>Site members will <em>not</em> have access to the back-end administration area.';
const MEMBER_NODE_SCRIPT = 'These settings override any basic permissions';
const NO_GROUPS = '<div class="help-block-empty">There are currently no groups available.</div>';
const GRID_HEADERS = ['Allow', 'Group'];
const PRIVATE_ROWS = [
  ['', 'communications.sender'],
  ['', 'Editor'],
  ['', 'finance.approver'],
  ['', 'reporting.exporter'],
];
const PUBLIC_ROWS = [['', 'Umbrella Members']];

const moduleText = (title: string): string =>
  `To set permissions for ${title}, check the box for each user group that should have access.`;

const CATEGORIES_CSRF: Readonly<IssuedCsrfToken> = Object.freeze({
  ...CSRF_CPERM_MODULE,
  context: MODULE_IDS.categories,
  csrf_token: `${'0'.repeat(63)}A`,
});

const CSRF_PAIRS: Readonly<Record<string, Readonly<IssuedCsrfToken>>> = Object.freeze({
  ...CSRF_BY_CONTEXT,
  [CATEGORIES_CSRF.context]: CATEGORIES_CSRF,
});

/** Identity's `issueCsrfTokens`: the fixture pair of each requested context. */
function issueCsrf(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => {
    const pair = CSRF_PAIRS[context];
    if (pair === undefined) throw new Error(`No CSRF fixture for context ${context}`);
    return pair;
  });
  return { status: 200, body: { tokens } };
}

interface ModuleCase {
  readonly name: string;
  readonly moduleId: string;
  readonly title: string;
  readonly answer: ModulePermissions;
  readonly csrf: Readonly<IssuedCsrfToken>;
  /** `[groupId, checked]` per grid row, system groups first. */
  readonly grants: ReadonlyArray<readonly [string, boolean]>;
}

const USERS: ModuleCase = {
  name: 'users',
  moduleId: MODULE_IDS.users,
  title: 'Users',
  answer: cpermModuleUsersAnswer,
  csrf: CSRF_CPERM_MODULE,
  grants: [
    [GROUP_IDS.communicationsSender, false],
    [GROUP_IDS.defaultEditor, true],
    [GROUP_IDS.financeApprover, false],
    [GROUP_IDS.reportingExporter, true],
    [GROUP_IDS.umbrellaMembers, false],
  ],
};

const CATEGORIES: ModuleCase = {
  name: 'categories',
  moduleId: MODULE_IDS.categories,
  title: 'Categories',
  answer: cpermModuleCategoriesAnswer,
  csrf: CATEGORIES_CSRF,
  grants: [
    [GROUP_IDS.communicationsSender, false],
    [GROUP_IDS.defaultEditor, false],
    [GROUP_IDS.financeApprover, true],
    [GROUP_IDS.reportingExporter, false],
    [GROUP_IDS.umbrellaMembers, true],
  ],
};

const grantsRoute = (moduleId: string): string => routeKey('GET', 'identity', `/v1/permissions/modules/${moduleId}`);
const titleRoute = (siteid: string, contentid: string): string =>
  routeKey('GET', 'strategies-content', `/v1/sites/${siteid}/content/${contentid}/history`);

/** Identity's grants (as `answer`, for `siteid`), the module node's title and the CSRF pairs of `module`. */
function moduleRoutes(
  module: ModuleCase,
  siteid: string = SITE,
  answer: ModulePermissions = module.answer,
): FakeRouteTable {
  const grants: ModulePermissions = { ...answer, siteId: siteid };
  const history: AdminView = { rc: { contentBean: { title: module.title } } };
  return {
    [CSRF_ROUTE]: issueCsrf,
    [grantsRoute(module.moduleId)]: { status: 200, body: grants },
    [titleRoute(siteid, module.moduleId)]: { status: 200, body: history },
  };
}

/** The partial of a module-permissions link: `contentid` and `moduleid` both name the module. */
const moduleLink = (moduleId: string): AdminRequestPartial => ({
  circuit: 'cperm',
  item: 'module',
  rc: { contentid: moduleId, moduleid: moduleId },
});

interface RenderedPage {
  readonly html: string;
  readonly model: DomModel;
  readonly $: CheerioAPI;
  readonly gateway: FakeGatewayClient;
}

async function renderPage(req: AdminRequest, routes: FakeRouteTable): Promise<RenderedPage> {
  const gateway = fakeGatewayClient(routes);
  const page = await renderScreenPage(cpermModule, makeScreenContext({ req, gateway }));
  if (page.kind !== 'document') throw new Error(`cperm.module redirected to ${page.location}`);
  return { html: page.html, model: domModel(page.html), $: cheerio.load(page.html), gateway };
}

/** The tenant-a site admin's page for `module`, its grants answered by `answer`. */
const siteAdminPage = (module: ModuleCase, answer?: ModulePermissions): Promise<RenderedPage> =>
  renderPage(siteAdminRequest(SITE, moduleLink(module.moduleId)), moduleRoutes(module, SITE, answer));

type Checkbox = Pick<DomModel['controls'][number], 'type' | 'value' | 'checked'>;

const checkboxes = (model: DomModel): Checkbox[] =>
  model.controls
    .filter((control) => control.name === 'groupid')
    .map(({ type, value, checked }) => ({ type, value, checked }));

const expectedCheckboxes = (module: ModuleCase): Checkbox[] =>
  module.grants.map(([value, checked]) => ({ type: 'checkbox', value, checked }));

/** The model of `form1` alone, without the shell's search form. */
const form1Model = ($: CheerioAPI): DomModel => fragmentModel($.html($('form[name="form1"]')));

const hiddenFields = (model: DomModel): Array<[string, string]> =>
  model.controls.filter((control) => control.type === 'hidden').map(({ name, value }) => [name, value]);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cperm.module for the tenant-a site admin', () => {
  it.each([USERS, CATEGORIES])('renders the $name module title, grids and grants', async (module) => {
    const { model, $ } = await siteAdminPage(module);
    expect(model.headings).toEqual([`${module.title} Permissions`, 'System Groups', 'Member Groups']);
    expect($('div.help-block').toArray().map((el) => $(el).html())).toEqual([moduleText(module.title), MEMBER_SCRIPT]);
    expect(model.tables).toEqual([
      { headers: GRID_HEADERS, rows: PRIVATE_ROWS },
      { headers: GRID_HEADERS, rows: PUBLIC_ROWS },
    ]);
    expect(checkboxes(model)).toEqual(expectedCheckboxes(module));
    expect(hiddenFields(form1Model($))).toEqual([
      ['router', ''],
      ['siteid', SITE],
      ['topid', ''],
      ['moduleid', module.moduleId],
      ['csrf_token', module.csrf.csrf_token],
      ['csrf_token_expires', module.csrf.csrf_token_expires],
    ]);
  });

  it('heads the users view with its title and Back button, without a breadcrumb or node script', async () => {
    const { html, model, $ } = await siteAdminPage(USERS);
    expect($('div.mura-header > h1').text()).toBe('Users Permissions');
    const back = $('div.mura-header > div.nav-module-specific.btn-group > a.btn');
    expect(back.attr('title')).toBe('Back');
    expect(model.links).toContainEqual({ href: '#', text: 'Back' });
    expect($('.breadcrumb')).toHaveLength(0);
    expect(html).not.toContain(MEMBER_NODE_SCRIPT);
  });

  it('posts form1 to cPerm.updatemodule with the Update button and the CSRF pair of rc.moduleid', async () => {
    const { model, $, gateway } = await siteAdminPage(USERS);
    const form = $('form[name="form1"]');
    expect([form.attr('method'), form.attr('action'), form.attr('novalidate')]).toEqual([
      'post',
      `./?muraAction=cPerm.updatemodule&contentid=${MODULE_IDS.users}`,
      'novalidate',
    ]);
    expect($('table').toArray().map((el) => $(el).attr('class'))).toEqual(['mura-table-grid', 'mura-table-grid']);
    const formModel = form1Model($);
    expect(formModel.controls.map((control) => control.name)).not.toContain('startrow');
    expect(formModel.buttons).toEqual([{ text: 'Update', type: 'submit', hasOnclick: true }]);
    expect(form.find('button').attr('class')).toBe('btn mura-primary');
    expect(model.buttons).toContainEqual({ text: 'Update', type: 'submit', hasOnclick: true });
    expect(gateway.calls.filter((call) => call.path === '/v1/csrf/tokens').map((call) => call.json)).toEqual([
      { contexts: [MODULE_IDS.users] },
    ]);
  });

  it('checks the categories grid where its grants differ from the users grid', async () => {
    const users = await siteAdminPage(USERS);
    const categories = await siteAdminPage(CATEGORIES);
    const usersChecked = new Map(checkboxes(users.model).map(({ value, checked }) => [value, checked]));
    const changed = checkboxes(categories.model)
      .filter(({ value, checked }) => usersChecked.get(value) !== checked)
      .map(({ value }) => value);
    expect(changed).toEqual([
      GROUP_IDS.defaultEditor,
      GROUP_IDS.financeApprover,
      GROUP_IDS.reportingExporter,
      GROUP_IDS.umbrellaMembers,
    ]);
    expect([users.model.headings[0], categories.model.headings[0]]).toEqual([
      'Users Permissions',
      'Categories Permissions',
    ]);
  });

  it('shows the no-groups notice in both sections and no grid', async () => {
    const { html, model, $ } = await siteAdminPage(USERS, cpermModuleNoGroupsAnswer);
    expect($('div.help-block-empty').toArray().map((el) => $.html(el))).toEqual([NO_GROUPS, NO_GROUPS]);
    expect(html.split(NO_GROUPS)).toHaveLength(3);
    expect(model.tables).toEqual([]);
    expect(checkboxes(model)).toEqual([]);
    expect(model.headings).toEqual(['Users Permissions', 'System Groups', 'Member Groups']);
  });

  it('writes system group names unencoded and member group names encoded', async () => {
    const answer: ModulePermissions = {
      ...cpermModuleUsersAnswer,
      privateGroups: cpermModuleUsersAnswer.privateGroups.map((group) =>
        group.groupId === GROUP_IDS.defaultEditor ? { ...group, groupName: 'R&D Editors' } : group,
      ),
      publicGroups: cpermModuleUsersAnswer.publicGroups.map((group) => ({ ...group, groupName: 'Members & Friends' })),
    };
    const gateway = fakeGatewayClient(moduleRoutes(USERS, SITE, answer));
    const ctx = makeScreenContext({ req: siteAdminRequest(SITE, moduleLink(USERS.moduleId)), gateway });
    const markup = toString(renderCpermModule(await loadCpermModule(ctx), ctx));
    expect(markup).toContain('<td class="var-width" nowrap>R&D Editors</td>');
    expect(markup).toContain('<td class="var-width" nowrap>Members &amp; Friends</td>');
    expect(fragmentModel(markup).tables.map((grid) => grid.rows)).toEqual([
      [['', 'communications.sender'], ['', 'R&D Editors'], ['', 'finance.approver'], ['', 'reporting.exporter']],
      [['', 'Members & Friends']],
    ]);
  });
});

describe('cperm.module gate and data reach', () => {
  it.each<[string, () => AdminRequest, string]>([
    ['the tenant-a site admin', () => siteAdminRequest(SITE, moduleLink(USERS.moduleId)), SITE],
    ['the S2 admin', () => adminS2Request(moduleLink(USERS.moduleId)), 'default'],
  ])('renders for %s', async (_who, request, siteid) => {
    const { model, $ } = await renderPage(request(), moduleRoutes(USERS, siteid));
    expect(model.headings).toEqual(['Users Permissions', 'System Groups', 'Member Groups']);
    expect(checkboxes(model)).toEqual(expectedCheckboxes(USERS));
    expect(hiddenFields(form1Model($))).toContainEqual(['siteid', siteid]);
  });

  it('sends the editor back before any identity cperm read', async () => {
    const gateway = fakeGatewayClient(moduleRoutes(USERS, 'default'));
    const ctx = makeScreenContext({ req: editorRequest(moduleLink(USERS.moduleId)), gateway });
    expect(await renderScreenPage(cpermModule, ctx)).toEqual({ kind: 'redirect', location: './' });
    expect(gateway.calls.filter((call) => call.service === 'identity')).toEqual([]);
  });

  it('reads only identity and strategies-content, for the token site', async () => {
    const gateway = fakeGatewayClient(moduleRoutes(USERS));
    const ctx = makeScreenContext({ req: siteAdminRequest(SITE, moduleLink(USERS.moduleId)), gateway });
    await cpermModule.render(ctx, await loadCpermModule(ctx));
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
        path: `/v1/permissions/modules/${MODULE_IDS.users}`,
        query: { siteid: SITE },
        json: undefined,
      },
      {
        service: 'strategies-content',
        method: 'GET',
        path: `/v1/sites/${SITE}/content/${MODULE_IDS.users}/history`,
        query: undefined,
        json: undefined,
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/csrf/tokens',
        query: undefined,
        json: { contexts: [MODULE_IDS.users] },
      },
    ]);
  });
});
