// cUsers.listUsers in the admin shell over people's user-list fixtures: the people request, header, tabs, filters,
// users table and pager of `cusers/listusers.cfm` with `inc/dsp_users_list.cfm` outside the group-members view.
import { Roles, moduleRole } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listUsersScreen } from '@/screens/cusers/listusers';
import {
  PERSON_IDS,
  emptyUsersPage,
  tenantASystemUsersPage,
  tenantASystemUsersSecondPage,
} from '../../fixtures/people/user-list';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel, normaliseIds, type DomLink, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks, and cUsers has no secondary menu.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Req = ReturnType<typeof siteAdminRequest>;
type UsersPage = typeof tenantASystemUsersPage;
type UserRow = UsersPage['items'][number];
type Ctx = ReturnType<typeof makeScreenContext>;

const SITE = 'tenant-a';
const SITE_MODULE_ID = '00000000000000000000000000000000000';
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const LIST_USERS_ROUTE = routeKey('GET', 'people', '/v2/users');
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const ADMIN_URL = '/admin/index.cfm?muraAction=';

const [TESSA_ADMIN] = tenantASystemUsersPage.items as [UserRow];
const MEMBER: UserRow = {
  ...TESSA_ADMIN,
  UserID: '7C1E0A07-4B2D-4E6F-8A9B0C1D2E3F4A07',
  Fname: 'Mia',
  Lname: 'Member',
  UserName: 'mia_member',
  Email: 'mia_member@example.com',
  isPublic: 1,
};

/** The token identity issues here for `context`: the context without its dashes, so each link names its context. */
const tokenFor = (context: string): string => context.replace(/-/g, '');

/** identity `issueCsrfTokens` answering every context with {@link tokenFor}. */
function issueContextTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: tokenFor(context),
    [CSRF_FIELD_EXPIRES]: '260630150000000',
  }));
  return { status: 200, body: { tokens } };
}

/** A one-page people answer holding `items`. */
function pageOf(items: readonly UserRow[], listUnassignedUsers: readonly string[] = []): UsersPage {
  const total = items.length;
  return {
    items: [...items],
    nextn: { ...tenantASystemUsersPage.nextn, totalrecords: total, through: total },
    listUnassignedUsers: [...listUnassignedUsers],
  };
}

/** The screen context of `req` with people answering `page`. */
function contextFor(req: Req, page: UsersPage = tenantASystemUsersPage): Ctx {
  return makeScreenContext({
    req,
    gateway: fakeGatewayClient({ [LIST_USERS_ROUTE]: { status: 200, body: page }, [CSRF_ROUTE]: issueContextTokens }),
  });
}

/** The tenant-a site admin on `cUsers.listUsers` of its own site's system users, `rc` laid over. */
const siteAdmin = (rc: Readonly<Record<string, string>> = {}): Req =>
  siteAdminRequest(SITE, { circuit: 'cusers', item: 'listusers', rc: { siteid: SITE, ispublic: '0', ...rc } });

/** qa_editor holding the Users and Site Manager modules the cUsers gate requires of a non-admin. */
const usersEditor = (rc: Readonly<Record<string, string>> = {}): Req =>
  editorRequest({
    circuit: 'cusers',
    item: 'listusers',
    rc: { siteid: 'default', ...rc },
    user: { roles: [Roles.systemUser, moduleRole(SITE_MODULE_ID), moduleRole(USERS_MODULE_ID)] },
  });

/** The page markup the screen answers; fails on a redirect. */
async function pageHtml(ctx: Ctx): Promise<string> {
  const page = await renderScreenPage(listUsersScreen, ctx);
  if (page.kind === 'redirect') throw new Error(`The screen redirected to ${page.location}`);
  return page.html;
}

/** The page markup and its masked model, from one render. */
async function renderPage(ctx: Ctx): Promise<{ html: string; model: DomModel }> {
  const html = await pageHtml(ctx);
  return { html, model: normaliseIds(domModel(html)) };
}

/** The masked model of the elements `selector` picks in `html`, ids numbered within them. */
function sectionModel(html: string, selector: string): DomModel {
  const $ = cheerio.load(html);
  return normaliseIds(fragmentModel($.html($(selector))));
}

/** The people calls `ctx` made. */
const peopleCalls = (ctx: Ctx): unknown[] => ctx.gateway.calls.filter((call) => call.service === 'people');

/** Every context `ctx` asked identity to issue CSRF tokens for. */
const csrfContexts = (ctx: Ctx): string[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly string[] }).contexts);

/** The name cell of `row`: `Lname, Fname`. */
const nameOf = (row: UserRow): string => `${row.Lname ?? ''}, ${row.Fname ?? ''}`;

/** The links an editable row of the users table carries, its id masked as `<id:n>`. */
function editableRowLinks(n: number, row: UserRow, siteid: string): DomLink[] {
  const edit = `${ADMIN_URL}cusers.edituser&siteid=${siteid}&userid=<id:${n}>`;
  const remove =
    `${ADMIN_URL}cusers.update&action=delete&csrf_token=<token>&csrf_token_expires=<token>` +
    `&ispublic=${String(row.isPublic)}&siteid=${siteid}&type=1&userid=<id:${n}>`;
  return [
    { href: 'javascript:;', text: '' },
    { href: edit, text: 'Edit' },
    { href: remove, text: 'Delete' },
    { href: edit, text: nameOf(row) },
    { href: `mailto:${(row.Email ?? '').replace('@', '%40')}`, text: row.Email ?? '' },
  ];
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('cUsers.listUsers people request', () => {
  it.each<[string, () => Req, Record<string, string>]>([
    [
      'a site admin, as rc names it',
      () => siteAdmin({ unassigned: '1', startrow: '2', recordsperpage: '2' }),
      { siteid: SITE, ispublic: '0', unassigned: '1', startrow: '2', recordsperpage: '2' },
    ],
    [
      'a non-admin, whose ispublic reads 1 whatever rc claims',
      () => usersEditor({ ispublic: '0', isAdmin: 'true' }),
      { siteid: 'default', ispublic: '1', unassigned: '0', startrow: '1', recordsperpage: '25' },
    ],
  ])('asks people for the page of %s', async (_case, req, query) => {
    const ctx = contextFor(req());
    await pageHtml(ctx);
    expect(peopleCalls(ctx)).toMatchObject([{ method: 'GET', path: '/v2/users', query }]);
  });

  // people's contract takes `all` for every site and rejects an empty siteid, so only the view's site id is blanked.
  it('sends siteid=all as is and links the view with an empty site id', async () => {
    const ctx = contextFor(adminS2Request({ circuit: 'cusers', item: 'listusers', rc: { siteid: 'all', ispublic: '0' } }));
    const html = await pageHtml(ctx);
    expect(peopleCalls(ctx)).toMatchObject([{ query: { siteid: 'all', ispublic: '0', unassigned: '0' } }]);
    expect(sectionModel(html, '.block-content .mura-control-group').links).toEqual([
      { href: `${ADMIN_URL}cusers.listusers&ispublic=0&siteid=&unassigned=1`, text: 'View Unassigned Only' },
      { href: `${ADMIN_URL}cusers.download&ispublic=0&siteid=&unassigned=0`, text: 'Download' },
    ]);
  });
});

describe('cUsers.listUsers header and tabs', () => {
  // buildURL drops FW/1's default item, so `cusers.default` links as `muraAction=cusers`.
  it('links the third header button to the groups, as the listUsers action does', async () => {
    const html = await pageHtml(contextFor(siteAdmin()));
    expect(sectionModel(html, '.mura-header .nav-module-specific').links).toEqual([
      { href: `${ADMIN_URL}cusers.edituser&siteid=${SITE}&userid=`, text: 'Add User' },
      { href: `${ADMIN_URL}cusers.editgroup&siteid=${SITE}&userid=`, text: 'Add Group' },
      { href: `${ADMIN_URL}cusers&siteid=${SITE}`, text: 'Groups' },
    ]);
  });

  it.each([
    ['1', '0', 'Site Members'],
    ['0', '1', 'System Users'],
  ])('tabs an admin on ispublic=%s, unassigned=%s with %s active', async (ispublic, unassigned, active) => {
    const { html, model } = await renderPage(contextFor(siteAdmin({ ispublic, unassigned })));
    const tabUrl = (flag: string): string =>
      `${ADMIN_URL}cusers.listusers&ispublic=${flag}&siteid=${SITE}&unassigned=${unassigned}`;
    expect(sectionModel(html, 'ul#viewTabs').links).toEqual([
      { href: tabUrl('1'), text: 'Site Members' },
      { href: tabUrl('0'), text: 'System Users' },
    ]);
    expect(cheerio.load(html)('ul#viewTabs > li.active').text().trim()).toBe(active);
    expect(model.headings).toEqual(['Users & Groups', 'Users']);
  });

  it('titles a non-admin list Site Members without tabs and links only member rows', async () => {
    const ctx = contextFor(usersEditor(), pageOf([TESSA_ADMIN, MEMBER]));
    const { html, model } = await renderPage(ctx);
    expect(cheerio.load(html)('#viewTabs')).toHaveLength(0);
    expect(model.headings).toEqual(['Users & Groups', 'Site Members', 'Users']);
    const table = sectionModel(html, 'table#tbl-users');
    expect(table.links).toEqual([
      { href: 'javascript:;', text: '' },
      { href: 'mailto:tenant_a_admin%40example.com', text: 'tenant_a_admin@example.com' },
      ...editableRowLinks(1, MEMBER, 'default'),
    ]);
    expect(table.tables[0]?.rows.map((row) => row.slice(0, 3))).toEqual([
      ['', '', 'Admin, Tessa'],
      ['Edit Delete', '', 'Member, Mia'],
    ]);
    expect(csrfContexts(ctx)).toEqual([MEMBER.UserID]);
  });
});

describe('cUsers.listUsers filters', () => {
  it.each<[string, UsersPage, string, string, string, boolean]>([
    ['all users', tenantASystemUsersPage, '0', 'View Unassigned Only', '1', true],
    ['unassigned users', tenantASystemUsersPage, '1', 'View All', '0', true],
    ['no users', emptyUsersPage, '0', 'View Unassigned Only', '1', false],
  ])('toggles the filter over %s and offers the download only for rows', async (_case, page, unassigned, label, toggle, download) => {
    const html = await pageHtml(contextFor(siteAdmin({ unassigned }), page));
    const query = (flag: string): string => `ispublic=0&siteid=${SITE}&unassigned=${flag}`;
    const downloadLink: DomLink = { href: `${ADMIN_URL}cusers.download&${query(unassigned)}`, text: 'Download' };
    expect(sectionModel(html, '.block-content .mura-control-group').links).toEqual([
      { href: `${ADMIN_URL}cusers.listusers&${query(toggle)}`, text: label },
      ...(download ? [downloadLink] : []),
    ]);
  });
});

describe('cUsers.listUsers users table', () => {
  it('lists every row of the page, its dates in the day-of-year mask legacy shows', async () => {
    const model = await renderScreenModel(listUsersScreen, contextFor(siteAdmin()));
    const table = model.tables.find((candidate) => candidate.headers.includes('Last Updated By'));
    expect(table).toEqual({
      headers: ['', '', 'User', 'Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'],
      rows: [
        ['Edit Delete', '', 'Admin, Tessa', 'tenant_a_admin@example.com', '03/61/2026', '11:00 AM', 'Admin User'],
        ['Edit Delete', '', 'Doe, Alex', 'alex_doe@example.com', '04/104/2026', '9:05 AM', 'Tessa Admin'],
        ['Edit Delete', '', 'Lee, Sam', 'sam_lee@example.com', '05/141/2026', '4:40 PM', 'Tessa Admin'],
        ['Edit Delete', '', 'Rivera, Pat', 'pat_rivera@example.com', '06/154/2026', '10:15 AM', 'Admin User'],
        ['Edit Delete', '', 'Smith, Jane', 'jane_smith@example.com', '10/302/2026', '2:20 PM', 'Tessa Admin'],
        ['Edit Delete', '', 'Smith, John', 'john_smith@example.com', '06/169/2026', '8:50 AM', 'Tessa Admin'],
        ['Edit Delete', '', 'Taylor, Casey', 'casey_taylor@example.com', '06/181/2026', '7:45 AM', 'Admin User'],
      ],
    });
  });

  it('links each row to its edit form and its delete, with tokens for the row user and no group removal', async () => {
    const ctx = contextFor(siteAdmin());
    const html = await pageHtml(ctx);
    const rows = tenantASystemUsersPage.items;
    expect(sectionModel(html, 'table#tbl-users').links).toEqual(
      rows.flatMap((row, index) => editableRowLinks(index + 1, row, SITE)),
    );
    const $ = cheerio.load(html);
    const deletes = $('#tbl-users li.delete a').toArray();
    const tokenOf = (href = ''): string | null => new URL(href, 'http://localhost').searchParams.get(CSRF_FIELD_TOKEN);
    expect(deletes.map((a) => tokenOf($(a).attr('href')))).toEqual(rows.map((row) => tokenFor(row.UserID)));
    expect(deletes.map((a) => $(a).attr('onclick'))).toEqual(rows.map(() => "return confirmDialog('Delete User?',this.href)"));
    expect(csrfContexts(ctx)).toEqual(rows.map((row) => row.UserID));
    expect($('#tbl-users li.remove')).toHaveLength(0);
    expect(html).not.toContain('Remove User From Group');
  });

  it('marks unassigned, super, system and member users and leaves NULL columns blank', async () => {
    const superUser: UserRow = { ...TESSA_ADMIN, UserID: USER_IDS.admin, S2: 1, Email: null, LastUpdate: null, LastUpdateBy: null };
    const system: UserRow = { ...TESSA_ADMIN, UserID: PERSON_IDS.patRivera };
    const page = pageOf([superUser, system, MEMBER], [PERSON_IDS.patRivera, MEMBER.UserID.toLowerCase()]);
    const html = await pageHtml(contextFor(siteAdmin(), page));
    const $ = cheerio.load(html);
    const icons = $('#tbl-users tbody tr')
      .toArray()
      .map((tr) => $(tr).find('td:nth-child(2) a[rel="tooltip"]').toArray().map((a) => $(a).attr('title')));
    expect(icons).toEqual([['Super User'], ['Unassigned', 'System User'], ['Unassigned', 'Site Member']]);
    expect(
      $('#tbl-users tbody tr')
        .toArray()
        .map((tr) => $(tr).find('td:nth-child(4) a').attr('href')),
    ).toEqual([undefined, 'mailto:tenant_a_admin%40example.com', 'mailto:mia_member%40example.com']);
    expect(sectionModel(html, 'table#tbl-users').tables[0]?.rows[0]?.slice(2)).toEqual(['Admin, Tessa', '', '', '', '']);
  });

  it('HTML-encodes the names it lists', async () => {
    const odd: UserRow = { ...TESSA_ADMIN, Lname: 'R&D <Ops>', Fname: 'Jo & Co>' };
    const html = await pageHtml(contextFor(siteAdmin(), pageOf([odd])));
    expect(html).toContain('R&amp;D &lt;Ops&gt;, Jo &amp; Co&gt;');
    const $ = cheerio.load(html);
    expect($('#tbl-users ops')).toHaveLength(0);
    expect(sectionModel(html, 'table#tbl-users').tables[0]?.rows[0]?.[2]).toBe('R&D <Ops>, Jo & Co>');
  });
});

describe('cUsers.listUsers pager', () => {
  const resetToFirst: UsersPage = {
    ...tenantASystemUsersSecondPage,
    items: tenantASystemUsersPage.items.slice(0, 2),
    nextn: { ...tenantASystemUsersSecondPage.nextn, startrow: 1, next: 3, through: 2 },
  };

  // setUsersIterator's reset of a start row past the total runs in people: web sends rc.startrow and pages by people's nextn.
  it.each([
    {
      label: 'the second of four pages',
      page: tenantASystemUsersSecondPage,
      rc: { startrow: '2', recordsperpage: '2' },
      form: { recordsperpage: '2', startrow: '2' },
      pages: ['1', '2', '3', '4'],
      active: '2',
      names: ['Lee, Sam', 'Rivera, Pat'],
    },
    {
      label: 'a start row past the total',
      page: resetToFirst,
      rc: { startrow: '9', recordsperpage: '2' },
      form: { recordsperpage: '2', startrow: '1' },
      pages: ['1', '2', '3', '4'],
      active: '1',
      names: ['Admin, Tessa', 'Doe, Alex'],
    },
    {
      label: 'a single page',
      page: tenantASystemUsersPage,
      rc: { startrow: '1', recordsperpage: '25' },
      form: { recordsperpage: '25', startrow: '1' },
      pages: [],
      active: undefined,
      names: tenantASystemUsersPage.items.map(nameOf),
    },
  ])('pages $label', async ({ page, rc, form, pages, active, names }) => {
    const ctx = contextFor(siteAdmin(rc), page);
    const html = await pageHtml(ctx);
    expect(peopleCalls(ctx)).toMatchObject([{ query: rc }]);
    expect(sectionModel(html, 'form#frmNextN').controls.map(({ name, value }) => [name, value])).toEqual([
      ['muraAction', 'core:cusers.listusers'],
      ['siteid', SITE],
      ['ispublic', '0'],
      ['unassigned', '0'],
      ['recordsperpage', form.recordsperpage],
      ['startrow', form.startrow],
    ]);
    const $ = cheerio.load(html);
    const pageLinks = $('ul.pagination > li:not(.pageNo):not(.hidden) > a').toArray();
    expect(pageLinks.map((a) => $(a).attr('data-pageno'))).toEqual(pages);
    expect($('ul.pagination > li.active > a').attr('data-pageno')).toBe(active);
    expect(sectionModel(html, 'table#tbl-users').tables[0]?.rows.map((row) => row[2])).toEqual(names);
  });
});

describe('cUsers.listUsers empty list', () => {
  // The model collapses whitespace, and the message's double space for an empty {1} is legacy's.
  it.each([
    ['0', 'There are currently no  users available.'],
    ['1', "There are currently no 'unassigned' users available."],
  ])('shows the unassigned=%s message without table or pager', async (unassigned, message) => {
    const html = await pageHtml(contextFor(siteAdmin({ unassigned }), emptyUsersPage));
    const $ = cheerio.load(html);
    expect($('div.help-block-empty').text().trim()).toBe(message);
    expect($('#tbl-users')).toHaveLength(0);
    expect($('form#frmNextN')).toHaveLength(0);
  });
});
