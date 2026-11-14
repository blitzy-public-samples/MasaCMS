// cUsers.list: cusers.cfc list() reading people's groups, and cusers/list.cfm with its includes inside the shell.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { TENANT_A } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminRequest } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import { listScreen, loadGroupList, type GroupListRow, type UserGroupsPage } from '@/screens/cusers/list';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { CSRF_BY_CONTEXT, CSRF_EDIT_GROUP } from '../../fixtures/identity/csrf';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import {
  defaultPrivateGroupsPage,
  emptyGroupsPage,
  tenantAPrivateGroupsPage,
  tenantAPublicGroupsPage,
} from '../../fixtures/people/user-groups';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';

// The registry pulls in every circuit's screens; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Ctx = ReturnType<typeof makeScreenContext>;

const GROUPS_PATH = '/v1/users/groups';
const GROUPS_ROUTE = routeKey('GET', 'people', GROUPS_PATH);
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const SITE_MODULE_ID = '00000000000000000000000000000000000';

const HEADERS = ['', 'Group (Total Members)', 'Group Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'];

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** identity `issueCsrfTokens`: the fixture pair of a known context, else {@link FIXED_CSRF}. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map(
    (context) =>
      CSRF_BY_CONTEXT[context] ?? { context, csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires },
  );
  return { status: 200, body: { tokens } };
}

/** The page context of `req`, with people answering `listUserGroups` with `page`. */
function contextFor(req: AdminRequest, page: UserGroupsPage = defaultPrivateGroupsPage): Ctx {
  const gateway = fakeGatewayClient({ [GROUPS_ROUTE]: { status: 200, body: page }, [CSRF_ROUTE]: issueTokens });
  return makeScreenContext({ req, gateway });
}

const LIST = { circuit: 'cusers', item: 'list' } as const;

const adminList = (rc: Readonly<Record<string, string>> = {}): AdminRequest => adminS2Request({ ...LIST, rc });

const siteAdminList = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  siteAdminRequest(SITE_IDS.tenantA, { ...LIST, rc });

/** qa_editor on tenant-a, its token also granting the Users module there, so the cUsers gate allows. */
function usersModuleEditor(rc: Readonly<Record<string, string>> = {}): AdminRequest {
  const partial: AdminRequestPartial = {
    ...LIST,
    rc,
    user: {
      site: TENANT_A.siteId,
      tid: TENANT_A.tenantId,
      roles: [Roles.systemUser, moduleRole(SITE_MODULE_ID), moduleRole(USERS_MODULE_ID)],
    },
    session: { siteid: TENANT_A.siteId },
  };
  return editorRequest(partial);
}

/** The page inside the shell; a redirect fails the test. */
async function render(ctx: Ctx): Promise<CheerioAPI> {
  const page = await renderScreenPage(listScreen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return cheerio.load(page.html);
}

/** The model of the first element matching `selector`. */
const modelOf = ($: CheerioAPI, selector: string): DomModel => fragmentModel($.html($(selector).first()));

/** An admin link of the view, as FW/1 builds it and the model normalises it. */
const adminLink = (action: string, query: string): string => normaliseAdminUrl(buildUrl(action, undefined, query));

/** `[method, path, query]` of every people call `ctx` made. */
const peopleCalls = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'people')
    .map((call) => [call.method.toUpperCase(), call.path, call.query]);

/** The message of a `confirmDialog` onclick, its ESAPI JavaScript escapes decoded. */
function confirmMessage(onclick: string | undefined): string {
  const encoded = /^return confirmDialog\('(.*)',this\.href\)$/.exec(onclick ?? '')?.[1] ?? '';
  return encoded.replace(/\\x([0-9A-F]{2})|\\u([0-9A-F]{4})/gi, (_m, x?: string, u?: string) =>
    String.fromCharCode(Number.parseInt(x ?? u ?? '', 16)),
  );
}

/** The fixture row of `groupId` in `page`. */
function rowOf(page: UserGroupsPage, groupId: string): GroupListRow {
  const row = page.items.find((item) => item.UserID === groupId);
  if (row === undefined) throw new RangeError(`No row ${groupId}`);
  return row;
}

/** `page` with the row of `groupId` replaced by `columns` laid over it. */
const withRow = (page: UserGroupsPage, groupId: string, columns: Partial<GroupListRow>): UserGroupsPage => ({
  ...page,
  items: page.items.map((item) => (item.UserID === groupId ? { ...item, ...columns } : item)),
});

describe('loadGroupList', () => {
  it.each<[string, () => AdminRequest, Record<string, string>]>([
    ['an S2 admin on system groups', () => adminList({ ispublic: '0' }), { siteid: 'default', ispublic: '0' }],
    ['a site admin by default', () => siteAdminList(), { siteid: SITE_IDS.tenantA, ispublic: '1' }],
    ['a non-admin asking for system groups', () => usersModuleEditor({ ispublic: '0' }), { siteid: SITE_IDS.tenantA, ispublic: '1' }],
  ])('asks people for the pool of %s', async (_name, req, expected) => {
    const ctx = contextFor(req());
    const data = await loadGroupList(ctx);
    expect(peopleCalls(ctx)).toEqual([['GET', GROUPS_PATH, { ...expected, startrow: '1', recordsperpage: '25' }]]);
    expect(data.rc.ispublic).toBe(expected.ispublic);
  });

  it('forwards the scrubbed paging', async () => {
    const ctx = contextFor(adminList({ ispublic: '1', startrow: '-3', recordsperpage: '10' }));
    await loadGroupList(ctx);
    expect(peopleCalls(ctx)).toEqual([
      ['GET', GROUPS_PATH, { siteid: 'default', ispublic: '1', startrow: '1', recordsperpage: '10' }],
    ]);
  });
});

describe('cUsers.list header', () => {
  it('renders the title, buttons and search form', async () => {
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    const header = modelOf($, 'div.mura-header');
    expect(header.headings).toEqual(['Users & Groups']);
    expect(header.links).toEqual([
      { href: adminLink('cusers.edituser', 'siteid=default&userid='), text: 'Add User' },
      { href: adminLink('cusers.editgroup', 'siteid=default&userid='), text: 'Add Group' },
      { href: adminLink('cusers.listUsers', 'siteid=default'), text: 'Users' },
    ]);
    expect($('div.mura-header div.mura-item-metadata form.form-inline#siteSearch')).toHaveLength(1);
    expect(modelOf($, '#siteSearch').controls.map(({ name, value }) => [name, value])).toEqual([
      ['search', ''],
      ['siteid', 'default'],
      ['ispublic', '0'],
      ['muraAction', 'cUsers.search'],
    ]);
  });

  it.each<[string, () => AdminRequest, UserGroupsPage, string, boolean]>([
    ['an S2 admin on member groups', () => adminList({ ispublic: '1' }), defaultPrivateGroupsPage, 'default', true],
    ['an S2 admin on system groups', () => adminList({ ispublic: '0' }), defaultPrivateGroupsPage, 'default', false],
    ['a site admin on member groups', () => siteAdminList(), tenantAPublicGroupsPage, SITE_IDS.tenantA, true],
    ['a non-admin', () => usersModuleEditor(), tenantAPublicGroupsPage, SITE_IDS.tenantA, false],
  ])('Permissions button for %s', async (_name, req, page, siteid, shown) => {
    const $ = await render(contextFor(req(), page));
    const permissions = modelOf($, 'div.mura-header').links.filter((link) => link.text === 'Permissions');
    const href = `./?muraAction=cPerm.module&contentid=${USERS_MODULE_ID}&siteid=${siteid}&moduleid=${USERS_MODULE_ID}`;
    expect(permissions).toEqual(shown ? [{ href: normaliseAdminUrl(href), text: 'Permissions' }] : []);
  });
});

describe('cUsers.list tabs', () => {
  it.each<[string, () => AdminRequest, UserGroupsPage, readonly string[]]>([
    ['an S2 admin on member groups', () => adminList({ ispublic: '1' }), defaultPrivateGroupsPage, ['active', '']],
    ['an S2 admin on system groups', () => adminList({ ispublic: '0' }), defaultPrivateGroupsPage, ['', 'active']],
    ['a site admin on system groups', () => siteAdminList({ ispublic: '0' }), tenantAPrivateGroupsPage, ['', 'active']],
  ])('gives %s both pools, the current one active', async (_name, req, page, classes) => {
    const $ = await render(contextFor(req(), page));
    expect(modelOf($, 'ul#viewTabs').links).toEqual([
      { href: adminLink('cusers.list', 'ispublic=1'), text: 'Member Groups' },
      { href: adminLink('cusers.list', 'ispublic=0'), text: 'System Groups' },
    ]);
    expect($('ul#viewTabs > li').map((_i, li) => $(li).attr('class') ?? '').get()).toEqual(classes);
    expect(modelOf($, 'div.block-constrain').headings).toEqual(['Groups']);
  });

  it('gives a non-admin the member heading only', async () => {
    const $ = await render(contextFor(usersModuleEditor(), tenantAPublicGroupsPage));
    expect($('#viewTabs')).toHaveLength(0);
    expect(modelOf($, 'div.block-constrain').headings).toEqual(['Member Groups', 'Member Groups']);
    expect($('h3.block-title').text().trim()).toBe('Member Groups');
  });
});

describe('cUsers.list group table', () => {
  const ADMIN_ID = GROUP_IDS.defaultAdmin;
  const EDITOR_ID = GROUP_IDS.defaultEditor;
  const groupQuery = (id: string): string => `userid=${id}&siteid=default`;

  it('lists each group with its count, email, last update and actions', async () => {
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    expect($('table#temp').hasClass('mura-table-grid')).toBe(true);
    expect(modelOf($, 'table#temp').tables).toEqual([
      {
        headers: HEADERS,
        rows: [
          ['Edit Members', 'Admin (2)', '', '01/05/2026', '9:00 AM', 'System'],
          ['Edit Members Delete', 'Editor (3)', 'editors@example.com', '10/302/2026', '2:20 PM', 'Admin User'],
        ],
      },
    ]);
  });

  it('links a permanent group to edit and members only', async () => {
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    expect(modelOf($, 'table#temp tbody tr:nth-child(1)').links).toEqual([
      { href: 'javascript:;', text: '' },
      { href: adminLink('cusers.editgroup', groupQuery(ADMIN_ID)), text: 'Edit' },
      { href: adminLink('cusers.editgroupmembers', groupQuery(ADMIN_ID)), text: 'Members' },
      { href: adminLink('cusers.editgroup', groupQuery(ADMIN_ID)), text: 'Admin' },
    ]);
  });

  it('links a deletable group to delete with its own CSRF pair and a confirm', async () => {
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    const csrf = `&csrf_token=${CSRF_EDIT_GROUP.csrf_token}&csrf_token_expires=${CSRF_EDIT_GROUP.csrf_token_expires}`;
    const deleteQuery = `action=delete&isPublic=0&userid=${EDITOR_ID}&siteid=default&type=1${csrf}`;
    expect(modelOf($, 'table#temp tbody tr:nth-child(2)').links).toEqual([
      { href: 'javascript:;', text: '' },
      { href: adminLink('cusers.editgroup', groupQuery(EDITOR_ID)), text: 'Edit' },
      { href: adminLink('cusers.editgroupmembers', groupQuery(EDITOR_ID)), text: 'Members' },
      { href: adminLink('cusers.update', deleteQuery), text: 'Delete' },
      { href: adminLink('cusers.editgroup', groupQuery(EDITOR_ID)), text: 'Editor' },
      { href: 'mailto:editors%40example%2Ecom', text: 'editors@example.com' },
    ]);
    const remove = $('table#temp li.delete a');
    expect(remove).toHaveLength(1);
    expect(remove.attr('href')).toBe(buildUrl('cusers.update', undefined, deleteQuery));
    expect(confirmMessage(remove.attr('onclick'))).toBe("Delete the 'Editor' User Group?");
  });

  it('carries a member group\'s isPublic in its delete link', async () => {
    const umbrella = GROUP_IDS.umbrellaMembers;
    const $ = await render(contextFor(siteAdminList({ ispublic: '1' }), tenantAPublicGroupsPage));
    const csrf = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
    const query = `action=delete&isPublic=1&userid=${umbrella}&siteid=${SITE_IDS.tenantA}&type=1${csrf}`;
    const remove = $('table#temp li.delete a');
    expect(remove.attr('href')).toBe(buildUrl('cusers.update', undefined, query));
    expect(confirmMessage(remove.attr('onclick'))).toBe("Delete the 'Umbrella Members' User Group?");
  });

  it('shows (0) for a group without members', async () => {
    const $ = await render(contextFor(siteAdminList({ ispublic: '0' }), tenantAPrivateGroupsPage));
    expect(modelOf($, 'table#temp').tables[0]?.rows.map((row) => row[1])).toEqual([
      'Admin (2)',
      'communications.sender (0)',
      'esignature.auditor (0)',
      'esignature.signer (0)',
      'finance.approver (0)',
      'finance.preparer (0)',
      'reporting.exporter (0)',
      'surveys.manager (0)',
      'timesheets.employee (0)',
      'timesheets.primary-approver (0)',
      'timesheets.secondary-approver (0)',
    ]);
  });

  // Known issue: ACF's `DD` mask prints the day of the year, so 2026-10-29 reads 10/302/2026.
  it('prints the last update date under the session mask as legacy does', async () => {
    const editor = rowOf(defaultPrivateGroupsPage, EDITOR_ID);
    expect(editor.LastUpdate).toBe('2026-10-29T14:20:00.000');
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    expect($('table#temp tbody tr:nth-child(2) > td').eq(3).text().trim()).toBe('10/302/2026');
  });

  it('leaves the date and time empty for a group never updated', async () => {
    const page = withRow(defaultPrivateGroupsPage, EDITOR_ID, { LastUpdate: null });
    const $ = await render(contextFor(adminList({ ispublic: '0' }), page));
    expect(modelOf($, 'table#temp').tables[0]?.rows[1]?.slice(3)).toEqual(['', '', 'Admin User']);
  });

  it('fails as ACF does on a last update it cannot read as a date', async () => {
    const page = withRow(defaultPrivateGroupsPage, EDITOR_ID, { LastUpdate: 'not a date' });
    await expect(renderScreenPage(listScreen, contextFor(adminList({ ispublic: '0' }), page))).rejects.toThrow(RangeError);
  });

  it('encodes the group name', async () => {
    const name = '<b>Bold</b> & Co';
    const page = withRow(defaultPrivateGroupsPage, EDITOR_ID, { GroupName: name });
    const $ = await render(contextFor(adminList({ ispublic: '0' }), page));
    const cell = $('table#temp tbody tr:nth-child(2) > td.var-width');
    expect(cell.find('a').text().trim()).toBe(name);
    expect(cell.find('b')).toHaveLength(0);
    expect(confirmMessage($('table#temp li.delete a').attr('onclick'))).toBe(`Delete the '${name}' User Group?`);
  });

  it('posts the paging form back to cUsers.list', async () => {
    const $ = await render(contextFor(adminList({ ispublic: '0' })));
    expect(modelOf($, 'form#frmNextN').controls.map(({ name, value }) => [name, value])).toEqual([
      ['muraAction', 'core:cusers.list'],
      ['siteid', 'default'],
      ['ispublic', '0'],
      ['unassigned', '0'],
      ['recordsperpage', '25'],
      ['startrow', '1'],
    ]);
  });
});

describe('cUsers.list without groups', () => {
  it('shows the empty message, with no table or paging', async () => {
    const $ = await render(contextFor(siteAdminList({ ispublic: '0' }), emptyGroupsPage));
    expect($('div.help-block-empty').text()).toBe('There are currently no groups available.');
    expect($('table#temp')).toHaveLength(0);
    expect($('#frmNextN')).toHaveLength(0);
  });
});

describe('cUsers.list access', () => {
  it('redirects an anonymous request before reading people', async () => {
    const ctx = contextFor(anonymousRequest(LIST));
    const page = await renderScreenPage(listScreen, ctx);
    const returnUrl = encodeURIComponent('http://localhost/admin/?&muraAction=cusers.list');
    expect(page).toEqual({
      kind: 'redirect',
      location: `./?muraAction=cLogin.main&returnURL=${returnUrl}&compactDisplay=false`,
    });
    expect(peopleCalls(ctx)).toEqual([]);
  });
});
