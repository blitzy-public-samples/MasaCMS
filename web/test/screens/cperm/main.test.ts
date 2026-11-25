// cperm.main for the tenant-a site admin over the identity and strategies-content fixtures.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyFaultError } from '@opt2/platform/legacy-compat';
import type { components as ContentSchemas } from '@/generated/clients/strategies-content';
import { cpermMain, loadCpermMain, renderCpermMain, type CpermMainModel } from '@/screens/cperm/main';
import { CONTENT_MODULE_ID, TOP_NODE_ID } from '@/screens/cperm/partials';
import { CSRF_BY_CONTEXT, CSRF_CPERM_MAIN } from '../../fixtures/identity/csrf';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import {
  CONTENT_NODE_IDS,
  MODULE_IDS,
  cpermMainAnswer,
  cpermMainChildAnswer,
  cpermMainSystemGroupsAnswer,
} from '../../fixtures/identity/permissions';
import {
  APPROVAL_CHAIN_IDS,
  NEW_APPROVAL_CHAIN_ID,
  cchainListData,
} from '../../fixtures/strategies-content/approval-chains';
import { adminS2Request, editorRequest, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, normaliseAdminUrl, type DomModel } from '../../helpers/dom-model';
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

type ContentPermissions = typeof cpermMainAnswer;
type GroupList = typeof cpermMainSystemGroupsAnswer;
type IssuedCsrfToken = typeof CSRF_CPERM_MAIN;
type AdminView = ContentSchemas['schemas']['AdminViewModel'];
type AdminRequest = ReturnType<typeof siteAdminRequest>;
type Struct = Readonly<Record<string, unknown>>;

const SITE = 'tenant-a';
const ROOT = CONTENT_NODE_IDS.root;
const CHILD = CONTENT_NODE_IDS.child;
const SITE_MANAGER = MODULE_IDS.content;
const COMPONENTS = '00000000000000000000000000000000003';
const END = '00000000000000000000000000000000END';
const VOLUNTEERS_GROUP_ID = '6A000000-0000-0000-0000000000000F01';
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const GROUPS_ROUTE = routeKey('GET', 'identity', '/v1/groups');
const NO_GROUPS = 'There are currently no groups available.';
const ROOT_TITLE = 'Tenant A Home';
const EXEMPT_IDS = [GROUP_IDS.defaultEditor.toLowerCase(), GROUP_IDS.libraryApprover, GROUP_IDS.umbrellaMembers].join(',');
const FULL_HEADERS = ['Approval Chain Exempt', 'Editor', 'Author', 'Read Only', 'Deny', 'Group'];
const CHILD_HEADERS = ['Approval Chain Exempt', 'Editor', 'Author', 'Inherit', 'Read Only', 'Deny', 'Group'];
const PRIVATE_NAMES = ['archive.viewer', 'Editor', 'library.approver', 'records.clerk'];

const nodeText = (title: string): string =>
  `To set permissions for <em>${title}</em>, select the radio button for each user group that should have authoring and/or editing permissions.`;

/** A CSRF pair for `context` with a token ending in `suffix`. */
const csrfPair = (context: string, suffix: string): IssuedCsrfToken => ({
  ...CSRF_CPERM_MAIN,
  context,
  csrf_token: `${'0'.repeat(64 - suffix.length)}${suffix}`,
});

const COMPONENTS_CSRF = csrfPair(COMPONENTS, 'C3');

const CSRF_PAIRS: Readonly<Record<string, IssuedCsrfToken>> = Object.freeze({
  ...CSRF_BY_CONTEXT,
  [CHILD]: csrfPair(CHILD, 'C2'),
  [COMPONENTS]: COMPONENTS_CSRF,
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

/** The tenant-a private pool's system groups: the fixture listing with tenant-a's own Admin group. */
const TENANT_A_SYSTEM_GROUPS: GroupList = {
  ...cpermMainSystemGroupsAnswer,
  items: cpermMainSystemGroupsAnswer.items.map((item) =>
    item.GroupName === 'Admin' ? { ...item, UserID: GROUP_IDS.tenantAAdmin } : item,
  ),
};

/** Identity's `listGroups` of the requested site's private pool. */
const listGroups = (request: RecordedRequest): FakeReply => ({
  status: 200,
  body: request.query.siteid === 'default' ? cpermMainSystemGroupsAnswer : TENANT_A_SYSTEM_GROUPS,
});

/** A `getContentCrumbs` struct; the node crumb also carries its title and chain assignment. */
const crumb = (contentid: string, menutitle: string, values: Struct = {}): Struct => ({
  contentid,
  menutitle,
  title: menutitle,
  siteid: SITE,
  moduleid: SITE_MANAGER,
  type: 'Page',
  restricted: 0,
  iconclass: '',
  ...values,
});

const HOME = crumb(ROOT, 'Home', { title: ROOT_TITLE, chainid: APPROVAL_CHAIN_IDS.standard, exemptid: EXEMPT_IDS });
const PROGRAMS = crumb(CHILD, 'Programs', { title: 'Our Programs' });
const COMPONENTS_CRUMB = crumb(COMPONENTS, 'Components', { type: 'Module', moduleid: COMPONENTS });

const BOARD_CHAIN: Struct = { chainID: NEW_APPROVAL_CHAIN_ID, siteID: SITE, name: 'Board & Legal' };
const CHAINS: readonly Struct[] = [...(cchainListData.rc.chains as readonly Struct[]), BOARD_CHAIN];

interface Answers {
  readonly permissions?: ContentPermissions;
  readonly crumbdata?: readonly Struct[];
  readonly chains?: readonly Struct[];
  readonly site?: string;
}

/** identity's verdicts and groups and strategies-content's crumbs and chains for `contentid`. */
function routesFor(
  contentid: string,
  { permissions = cpermMainAnswer, crumbdata = [HOME], chains = CHAINS, site = SITE }: Answers = {},
): FakeRouteTable {
  const verdicts: ContentPermissions = { ...permissions, contentId: contentid, siteId: site };
  const crumbs: AdminView = { rc: { crumbdata } };
  const chainList: AdminView = { rc: { siteid: site, chains } };
  return {
    [CSRF_ROUTE]: issueCsrf,
    [routeKey('GET', 'identity', `/v1/permissions/content/${contentid}`)]: { status: 200, body: verdicts },
    [routeKey('GET', 'strategies-content', `/v1/sites/${site}/content/${contentid}/crumbs`)]: {
      status: 200,
      body: crumbs,
    },
    [routeKey('GET', 'strategies-content', `/v1/sites/${site}/approval-chains`)]: { status: 200, body: chainList },
    [GROUPS_ROUTE]: listGroups,
  };
}

const mainLink = (rc: Readonly<Record<string, string>>): AdminRequestPartial => ({ circuit: 'cperm', item: 'main', rc });

/** The tenant-a site admin on `cperm.main` with `rc`. */
const siteAdminMain = (rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest(SITE, mainLink({ siteid: SITE, ...rc }));

const ROOT_RC = Object.freeze({ contentid: ROOT, parentid: END, moduleid: SITE_MANAGER });
const CHILD_RC = Object.freeze({ contentid: CHILD, parentid: ROOT, moduleid: SITE_MANAGER });
const COMPONENTS_RC = Object.freeze({ contentid: COMPONENTS, parentid: END, moduleid: COMPONENTS });

interface Rendered {
  readonly markup: string;
  readonly model: DomModel;
  readonly $: CheerioAPI;
  readonly gateway: FakeGatewayClient;
  readonly data: CpermMainModel;
}

/** `req`'s model loaded over the fake gateway, then rendered by the pure renderer. */
async function render(req: AdminRequest, answers: Answers = {}): Promise<Rendered> {
  const gateway = fakeGatewayClient(routesFor(req.rc.contentid ?? '', { site: req.rc.siteid, ...answers }));
  const ctx = makeScreenContext({ req, gateway });
  const data = await loadCpermMain(ctx);
  const markup = String(renderCpermMain(data, ctx).body);
  return { markup, model: domModel(markup), $: cheerio.load(markup), gateway, data };
}

const radioName = (groupId: string): string => `p${groupId.replaceAll('-', '')}`;

/** The radio values of `groupId`'s row, in document order. */
const radioValues = (model: DomModel, groupId: string): string[] =>
  model.controls.filter((c) => c.type === 'radio' && c.name === radioName(groupId)).map((c) => c.value);

/** Each named radio group's checked value, in document order. */
const checkedVerdicts = (model: DomModel): Array<[string, string]> =>
  model.controls.filter((c) => c.type === 'radio' && c.name !== '' && c.checked).map((c) => [c.name, c.value]);

/** `[value, checked, disabled]` of each exempt checkbox, in document order. */
const exemptBoxes = ($: CheerioAPI): Array<[string | undefined, boolean, boolean]> =>
  $('input[name="exemptID"]')
    .toArray()
    .map((el) => [$(el).attr('value'), $(el).is('[checked]'), $(el).is('[disabled]')]);

const hiddenFields = (model: DomModel): Array<[string, string]> =>
  model.controls.filter((c) => c.type === 'hidden').map(({ name, value }) => [name, value]);

const tableClasses = ($: CheerioAPI): Array<string | undefined> =>
  $('table')
    .toArray()
    .map((el) => $(el).attr('class'));

/** A grid row of `cells` input cells and the group name. */
const nameRow = (name: string, cells: number): string[] => [...Array<string>(cells).fill(''), name];

const crumbHref = (contentid: string, moduleid: string = SITE_MANAGER, siteid: string = SITE): string =>
  `/admin/?muraAction=cArch.list&siteid=${siteid}&topid=${contentid}&moduleid=${moduleid}&activeTab=0`;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cperm.main root node with approval chains', () => {
  it('heads Content Permissions with the Back nav and the Site Manager breadcrumb', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC));
    expect(model.headings[0]).toBe('Content Permissions');
    expect($('div.mura-header > h1').text()).toBe('Content Permissions');
    expect($('ul.breadcrumb')).toHaveLength(1);
    expect($('ul.breadcrumb a').attr('href')).toBe(crumbHref(ROOT));
    expect(model.links).toEqual([
      { href: '#', text: 'Back' },
      { href: normaliseAdminUrl(crumbHref(ROOT)), text: 'Home' },
    ]);
  });

  it('posts form1 to cPerm.update under the System, Member and Approval Chain headings', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC));
    const form = $('form');
    expect([form.attr('name'), form.attr('method'), form.attr('action')]).toEqual([
      'form1',
      'post',
      `./?muraAction=cPerm.update&contentid=${ROOT}&parentid=${END}`,
    ]);
    expect(model.headings).toEqual(['Content Permissions', 'System Groups', 'Member Groups', 'Approval Chain']);
    expect(form.children('p').first().html()).toBe(nodeText(ROOT_TITLE));
  });

  it('URL-encodes the action ids and carries the referrer, topid and startrow', async () => {
    const referer = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}&q="x"`;
    const req = siteAdminMain({ ...ROOT_RC, parentid: 'a b&c', topid: ROOT, startrow: '11' });
    const headers = new Headers(req.headers);
    headers.set('referer', referer);
    const { model, $ } = await render({ ...req, headers });
    expect($('form').attr('action')).toBe(`./?muraAction=cPerm.update&contentid=${ROOT}&parentid=a+b%26c`);
    expect(hiddenFields(model).slice(0, 4)).toEqual([
      ['router', referer],
      ['siteid', SITE],
      ['startrow', '11'],
      ['topid', ROOT],
    ]);
  });

  it('lists the system groups after the Admin row without an Inherit column', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC));
    expect(model.tables[0]).toEqual({
      headers: FULL_HEADERS,
      rows: [nameRow('Admin', 5), ...PRIVATE_NAMES.map((name) => nameRow(name, 5))],
    });
    const admin = $('table').first().find('tr').eq(1);
    expect(admin.find('input[name="exemptID"]').attr('value')).toBe(GROUP_IDS.tenantAAdmin);
    expect(
      admin
        .find('input[type="radio"]')
        .toArray()
        .map((el) => [$(el).attr('name'), $(el).is('[checked]'), $(el).is('[disabled]')]),
    ).toEqual([
      [undefined, true, true],
      [undefined, false, true],
      [undefined, false, true],
      [undefined, false, true],
    ]);
    expect(admin.children('td').last().text()).toBe('Admin');
  });

  it('checks each verdict, showing the no-grants group as Read Only on the module root', async () => {
    const { model } = await render(siteAdminMain(ROOT_RC));
    expect(radioValues(model, GROUP_IDS.archiveViewer)).toEqual(['editor', 'author', 'read', 'deny']);
    expect(checkedVerdicts(model)).toEqual([
      [radioName(GROUP_IDS.archiveViewer), 'read'],
      [radioName(GROUP_IDS.defaultEditor), 'editor'],
      [radioName(GROUP_IDS.libraryApprover), 'author'],
      [radioName(GROUP_IDS.recordsClerk), 'deny'],
      [radioName(GROUP_IDS.umbrellaMembers), 'editor'],
    ]);
  });

  it('checks a system exempt box only for an exempt editor and disables it for non-editors', async () => {
    const { $ } = await render(siteAdminMain(ROOT_RC));
    expect(exemptBoxes($).slice(0, 5)).toEqual([
      [GROUP_IDS.tenantAAdmin, true, true],
      [GROUP_IDS.archiveViewer, false, true],
      [GROUP_IDS.defaultEditor, true, false],
      [GROUP_IDS.libraryApprover, false, true],
      [GROUP_IDS.recordsClerk, false, true],
    ]);
  });

  it('never checks or enables a member exempt box, even for an exempt editor', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC));
    expect(model.tables[1]).toEqual({ headers: FULL_HEADERS, rows: [nameRow('Umbrella Members', 5)] });
    expect(exemptBoxes($).at(-1)).toEqual([GROUP_IDS.umbrellaMembers, false, true]);
  });

  it('HTML-encodes group names', async () => {
    const permissions: ContentPermissions = {
      ...cpermMainAnswer,
      groups: cpermMainAnswer.groups.map((group) =>
        group.groupId === GROUP_IDS.defaultEditor ? { ...group, groupName: 'R&D <Editors>' } : group,
      ),
      publicGroups: cpermMainAnswer.publicGroups.map((group) => ({ ...group, groupName: 'Members & Friends' })),
    };
    const { markup, model } = await render(siteAdminMain(ROOT_RC), { permissions });
    expect(markup).toContain('<td nowrap class="var-width">R&amp;D &lt;Editors&gt;</td>');
    expect(markup).toContain('<td nowrap class="var-width">Members &amp; Friends</td>');
    expect(model.tables.map((grid) => grid.rows.map((row) => row.at(-1)))).toEqual([
      ['Admin', 'archive.viewer', 'R&D <Editors>', 'library.approver', 'records.clerk'],
      ['Members & Friends'],
    ]);
  });

  it('adds no-stripe to a grid of fewer than two groups', async () => {
    const editor = cpermMainAnswer.groups.filter((group) => group.groupId === GROUP_IDS.defaultEditor);
    const volunteers = { groupId: VOLUNTEERS_GROUP_ID, groupName: 'Volunteers', perm: 'read' } as const;
    const fixture = await render(siteAdminMain(ROOT_RC));
    const flipped = await render(siteAdminMain(ROOT_RC), {
      permissions: { ...cpermMainAnswer, groups: editor, publicGroups: [...cpermMainAnswer.publicGroups, volunteers] },
    });
    expect(tableClasses(fixture.$)).toEqual(['mura-table-grid', 'mura-table-grid no-stripe']);
    expect(tableClasses(flipped.$)).toEqual(['mura-table-grid no-stripe', 'mura-table-grid']);
    expect(flipped.model.tables[0]?.rows).toEqual([nameRow('Admin', 5), nameRow('Editor', 5)]);
  });

  it('selects the assigned chain among the chains in listing order', async () => {
    const { markup, model, $ } = await render(siteAdminMain(ROOT_RC));
    expect(model.controls.find((c) => c.name === 'chainID')).toMatchObject({
      tag: 'select',
      type: 'select-one',
      value: APPROVAL_CHAIN_IDS.standard,
      options: [
        { value: '', label: 'None', selected: false },
        { value: APPROVAL_CHAIN_IDS.standard, label: 'Standard Publishing', selected: true },
        { value: NEW_APPROVAL_CHAIN_ID, label: 'Board & Legal', selected: false },
      ],
    });
    expect($('select[name="chainID"]').attr('class')).toBe('dropdown');
    expect(model.labels).toEqual(['Select Approval Chain']);
    expect(markup).toContain('>Board &amp; Legal</option>');
  });

  it('carries the rc defaults and the CSRF pair of rc.contentid', async () => {
    const { model, gateway } = await render(siteAdminMain(ROOT_RC));
    expect(hiddenFields(model)).toEqual([
      ['router', ''],
      ['siteid', SITE],
      ['startrow', '1'],
      ['topid', ''],
      ['moduleid', SITE_MANAGER],
      ['csrf_token', CSRF_CPERM_MAIN.csrf_token],
      ['csrf_token_expires', CSRF_CPERM_MAIN.csrf_token_expires],
    ]);
    expect(gateway.calls.filter((call) => call.path === '/v1/csrf/tokens').map((call) => call.json)).toEqual([
      { contexts: [ROOT] },
    ]);
  });

  it('submits with the Update button', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC));
    expect(model.buttons).toEqual([{ text: 'Update', type: 'submit', hasOnclick: true }]);
    expect($('button').attr('class')).toBe('btn mura-primary');
  });
});

describe('cperm.main child node', () => {
  const childPage = (): Promise<Rendered> =>
    render(siteAdminMain(CHILD_RC), { permissions: cpermMainChildAnswer, crumbdata: [PROGRAMS, HOME] });

  it('adds the Inherit column between Author and Read Only', async () => {
    const { model, $ } = await childPage();
    expect(model.tables.map((grid) => grid.headers)).toEqual([CHILD_HEADERS, CHILD_HEADERS]);
    expect(model.tables[0]?.rows[0]).toEqual(nameRow('Admin', 6));
    expect(model.headings[0]).toBe('Content Permissions');
    expect($('ul.breadcrumb strong a').text()).toBe('Programs');
    expect($('form').children('p').first().html()).toBe(nodeText('Our Programs'));
  });

  it('checks each stored verdict, the no-grants group under Inherit', async () => {
    const { model, $ } = await childPage();
    expect(radioValues(model, GROUP_IDS.archiveViewer)).toEqual(['editor', 'author', 'none', 'read', 'deny']);
    expect(checkedVerdicts(model)).toEqual([
      [radioName(GROUP_IDS.archiveViewer), 'none'],
      [radioName(GROUP_IDS.defaultEditor), 'author'],
      [radioName(GROUP_IDS.libraryApprover), 'read'],
      [radioName(GROUP_IDS.recordsClerk), 'editor'],
      [radioName(GROUP_IDS.umbrellaMembers), 'read'],
    ]);
    expect(exemptBoxes($).map(([value, , disabled]) => [value, disabled])).toEqual([
      [GROUP_IDS.tenantAAdmin, true],
      [GROUP_IDS.archiveViewer, true],
      [GROUP_IDS.defaultEditor, true],
      [GROUP_IDS.libraryApprover, true],
      [GROUP_IDS.recordsClerk, false],
      [GROUP_IDS.umbrellaMembers, true],
    ]);
  });
});

describe('cperm.main without chains or groups', () => {
  const NO_VERDICTS: ContentPermissions = { ...cpermMainAnswer, groups: [], publicGroups: [] };

  it('drops the exempt column, Admin row and chain select without chains', async () => {
    const { model, $, gateway, data } = await render(siteAdminMain(ROOT_RC), { chains: [] });
    expect(model.headings).toEqual(['Content Permissions', 'System Groups', 'Member Groups']);
    expect(model.tables).toEqual([
      { headers: FULL_HEADERS.slice(1), rows: PRIVATE_NAMES.map((name) => nameRow(name, 4)) },
      { headers: FULL_HEADERS.slice(1), rows: [nameRow('Umbrella Members', 4)] },
    ]);
    expect(exemptBoxes($)).toEqual([]);
    expect(model.controls.some((c) => c.name === 'chainID')).toBe(false);
    expect(model.labels).toEqual([]);
    expect(model.buttons).toEqual([{ text: 'Update', type: 'submit', hasOnclick: true }]);
    expect(data.adminGroupId).toBe('');
    expect(gateway.calls.some((call) => call.path === '/v1/groups')).toBe(false);
  });

  it('shows both empty notices, the member one after a space, without chains or groups', async () => {
    const { markup, model, $ } = await render(siteAdminMain(ROOT_RC), { chains: [], permissions: NO_VERDICTS });
    expect(markup).toContain(`<div class="help-block-empty">${NO_GROUPS}</div>`);
    expect(markup).toContain(`<div class="help-block-empty"> ${NO_GROUPS}</div>`);
    expect($('div.help-block-empty').toArray().map((el) => $(el).html())).toEqual([NO_GROUPS, ` ${NO_GROUPS}`]);
    expect(model.tables).toEqual([]);
    expect(model.buttons).toEqual([{ text: 'Update', type: 'submit', hasOnclick: true }]);
  });

  it('keeps the system grid for the Admin row when chains exist without groups', async () => {
    const { model, $ } = await render(siteAdminMain(ROOT_RC), { permissions: NO_VERDICTS });
    expect(model.tables).toEqual([{ headers: FULL_HEADERS, rows: [nameRow('Admin', 5)] }]);
    expect(tableClasses($)).toEqual(['mura-table-grid no-stripe']);
    expect($('div.help-block-empty').toArray().map((el) => $(el).html())).toEqual([` ${NO_GROUPS}`]);
    expect(model.headings.at(-1)).toBe('Approval Chain');
  });
});

describe('cperm.main outside Site Manager', () => {
  it('drops Read Only and the breadcrumb, showing unset verdicts as Deny', async () => {
    const { model, $ } = await render(siteAdminMain(COMPONENTS_RC), { crumbdata: [COMPONENTS_CRUMB] });
    const headers = ['Approval Chain Exempt', 'Editor', 'Author', 'Deny', 'Group'];
    expect(model.tables.map((grid) => grid.headers)).toEqual([headers, headers]);
    expect(model.tables[0]?.rows[0]).toEqual(nameRow('Admin', 4));
    expect($('ul.breadcrumb')).toHaveLength(0);
    expect(model.links).toEqual([{ href: '#', text: 'Back' }]);
    expect(radioValues(model, GROUP_IDS.archiveViewer)).toEqual(['editor', 'author', 'deny']);
    expect(checkedVerdicts(model)).toEqual([
      [radioName(GROUP_IDS.archiveViewer), 'deny'],
      [radioName(GROUP_IDS.defaultEditor), 'editor'],
      [radioName(GROUP_IDS.libraryApprover), 'author'],
      [radioName(GROUP_IDS.recordsClerk), 'deny'],
      [radioName(GROUP_IDS.umbrellaMembers), 'editor'],
    ]);
    expect(hiddenFields(model).slice(4)).toEqual([
      ['moduleid', COMPONENTS],
      ['csrf_token', COMPONENTS_CSRF.csrf_token],
      ['csrf_token_expires', COMPONENTS_CSRF.csrf_token_expires],
    ]);
  });

  it.each([
    ['Component', 'Component Permissions'],
    ['form', 'form Permissions'],
  ])('heads rc.type %s as sent', async (type, heading) => {
    const { model } = await render(siteAdminMain({ ...COMPONENTS_RC, type }), { crumbdata: [COMPONENTS_CRUMB] });
    expect(model.headings[0]).toBe(heading);
  });
});

describe('cperm.main gate and data reach', () => {
  const HAND_MODEL: CpermMainModel = {
    title: ROOT_TITLE,
    crumbs: [{ menutitle: 'Home', siteid: 'default', contentid: TOP_NODE_ID, type: 'Page', restricted: 0, icon: 'page' }],
    privateGroups: [{ userid: GROUP_IDS.defaultEditor, groupname: 'Editor', perm: 'none' }],
    publicGroups: [],
    chains: [],
    assignment: { chainID: '', exemptID: '' },
    adminGroupId: '',
  };

  it('sends the editor back before any read; the renderer alone reads only its CSRF pair', async () => {
    const gateway = fakeGatewayClient(routesFor(ROOT, { site: 'default' }));
    const req = editorRequest(mainLink({ siteid: 'default', ...ROOT_RC }));
    const ctx = makeScreenContext({ req, gateway });
    expect(await renderScreenPage(cpermMain, ctx)).toEqual({ kind: 'redirect', location: './' });
    expect(gateway.calls).toEqual([]);

    await ctx.csrf.prefetch([ROOT]);
    const model = domModel(String(renderCpermMain(HAND_MODEL, ctx).body));
    expect(model.tables).toEqual([{ headers: FULL_HEADERS.slice(1), rows: [nameRow('Editor', 4)] }]);
    expect(checkedVerdicts(model)).toEqual([[radioName(GROUP_IDS.defaultEditor), 'read']]);
    expect(gateway.calls.map(({ service, method, path }) => [service, method, path])).toEqual([
      ['identity', 'POST', '/v1/csrf/tokens'],
    ]);
  });

  it('renders the page in the shell for the S2 admin', async () => {
    const crumbdata = [crumb(ROOT, 'Home', { siteid: 'default', chainid: APPROVAL_CHAIN_IDS.standard })];
    const gateway = fakeGatewayClient(routesFor(ROOT, { site: 'default', crumbdata }));
    const ctx = makeScreenContext({ req: adminS2Request(mainLink({ siteid: 'default', ...ROOT_RC })), gateway });
    const page = await renderScreenPage(cpermMain, ctx);
    if (page.kind !== 'document') throw new Error(`cperm.main redirected to ${page.location}`);
    const body = String(renderCpermMain(await loadCpermMain(ctx), ctx).body);
    expect(page.html).toContain(body);
    const $ = cheerio.load(body);
    expect(domModel(body).headings).toEqual(['Content Permissions', 'System Groups', 'Member Groups', 'Approval Chain']);
    expect(exemptBoxes($)[0]).toEqual([GROUP_IDS.defaultAdmin, true, true]);
    expect(hiddenFields(domModel(body))).toContainEqual(['siteid', 'default']);
    expect($('ul.breadcrumb a').attr('href')).toBe(crumbHref(ROOT, CONTENT_MODULE_ID, 'default'));
  });

  it('reads only identity and strategies-content, for the requested site', async () => {
    const gateway = fakeGatewayClient(routesFor(ROOT));
    const ctx = makeScreenContext({ req: siteAdminMain(ROOT_RC), gateway });
    expect(cpermMain.load).toBe(loadCpermMain);
    const data = await loadCpermMain(ctx);
    expect(String((await cpermMain.render(ctx, data)).body)).toBe(String(renderCpermMain(data, ctx).body));
    const calls = gateway.calls.map(({ service, method, path, query, json }) => ({ service, method, path, query, json }));
    expect(new Set(calls.map(({ service }) => service))).toEqual(new Set(['identity', 'strategies-content']));
    expect(calls).toHaveLength(5);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          service: 'identity',
          method: 'GET',
          path: `/v1/permissions/content/${ROOT}`,
          query: { siteid: SITE },
          json: undefined,
        },
        {
          service: 'strategies-content',
          method: 'GET',
          path: `/v1/sites/${SITE}/content/${ROOT}/crumbs`,
          query: undefined,
          json: undefined,
        },
        {
          service: 'strategies-content',
          method: 'GET',
          path: `/v1/sites/${SITE}/approval-chains`,
          query: undefined,
          json: undefined,
        },
        { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', query: undefined, json: { contexts: [ROOT] } },
        {
          service: 'identity',
          method: 'GET',
          path: '/v1/groups',
          query: { siteid: SITE, ispublic: '0', offset: '0' },
          json: undefined,
        },
      ]),
    );
  });
});

describe('cperm.main in Site Manager for an id that names no node', () => {
  /** identity's answer to an id its 35-character `contentId` refuses. */
  const REFUSED: FakeReply = {
    status: 400,
    body: { apiversion: 'v1', method: 'invalid', error: { message: 'Invalid parameters', code: 'invalid_request' } },
  };
  const crumbsPath = (contentid: string): string => `/v1/sites/${SITE}/content/${contentid}/crumbs`;

  it.each<[string, string, boolean, boolean]>([
    ['a short id identity refuses', 'junk', true, true],
    ['a well-formed id of no node', 'ABCDEF01-2345-6789-ABCDEF0123456789', false, true],
    ['an id longer than its column', 'X'.repeat(40), true, false],
    ['an empty id', '', true, false],
  ])("fails as legacy's dspZoom does on its empty crumb list for %s", async (_label, contentid, refused, readsCrumbs) => {
    const gateway = fakeGatewayClient({
      ...routesFor(contentid, { crumbdata: [] }),
      [CSRF_ROUTE]: { status: 200, body: { tokens: [csrfPair(contentid, 'F1')] } },
      ...(refused ? { [routeKey('GET', 'identity', `/v1/permissions/content/${contentid}`)]: REFUSED } : {}),
    });
    const ctx = makeScreenContext({ req: siteAdminMain({ contentid, parentid: END, moduleid: SITE_MANAGER }), gateway });

    const failure = loadCpermMain(ctx);
    await expect(failure).rejects.toBeInstanceOf(LegacyFaultError);
    await expect(failure).rejects.toMatchObject({ message: 'The element at position 1 cannot be found.', type: 'Expression' });
    expect(gateway.calls.some(({ path }) => path === crumbsPath(contentid))).toBe(readsCrumbs);
  });
});
