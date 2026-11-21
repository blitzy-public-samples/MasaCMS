// cUsers.search in the admin shell over people's search fixtures (`cusers/search.cfm`, cusers.cfc `search()`), and
// the search form of `cusers/inc/dsp_search_form.cfm`.
import { Roles, moduleRole } from '@opt2/platform/auth';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { normaliseCusersRc } from '@/screens/cusers/gate';
import { renderSearchForm } from '@/screens/cusers/inc/dsp_search_form';
import { searchScreen } from '@/screens/cusers/search';
import {
  EMPTY_SEARCH_KEYWORD,
  SEARCH_KEYWORD,
  emptySearchResults,
  smithSearchResults,
} from '../../fixtures/people/search';
import { PERSON_IDS } from '../../fixtures/people/user-list';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks, and cUsers has no secondary menu.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Req = ReturnType<typeof siteAdminRequest>;
type Ctx = ReturnType<typeof makeScreenContext>;
type SearchPage = typeof smithSearchResults;
type Rc = Readonly<Record<string, string>>;

const SITE = 'tenant-a';
const SITE_MODULE_ID = '00000000000000000000000000000000000';
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const SEARCH_ROUTE = routeKey('GET', 'people', '/v2/users/search');
const ADMIN_URL = '/admin/index.cfm?muraAction=';
const MEMBERS = 'Site Members';
const SYSTEM = 'System Users';

/** The installed S2 admin searching its session site `default`, `rc` laid over. */
const s2Admin = (rc: Rc = {}): Req =>
  adminS2Request({ circuit: 'cusers', item: 'search', rc: { search: SEARCH_KEYWORD, ...rc } });

/** The tenant-a site admin searching its own site, `rc` laid over. */
const siteAdmin = (rc: Rc = {}): Req =>
  siteAdminRequest(SITE, { circuit: 'cusers', item: 'search', rc: { siteid: SITE, search: SEARCH_KEYWORD, ...rc } });

/** qa_editor holding the Users and Site Manager modules the cUsers gate requires of a non-admin. */
const usersEditor = (rc: Rc = {}): Req =>
  editorRequest({
    circuit: 'cusers',
    item: 'search',
    rc: { search: SEARCH_KEYWORD, ...rc },
    user: { roles: [Roles.systemUser, moduleRole(SITE_MODULE_ID), moduleRole(USERS_MODULE_ID)] },
  });

/** The screen context of `req` with people answering `page`. */
function contextFor(req: Req, page: SearchPage = smithSearchResults): Ctx {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: page } }) });
}

/** The page markup the screen answers; fails on a redirect. */
async function pageHtml(ctx: Ctx): Promise<string> {
  const page = await renderScreenPage(searchScreen, ctx);
  if (page.kind === 'redirect') throw new Error(`The screen redirected to ${page.location}`);
  return page.html;
}

/** The masked model of the elements `selector` picks in `html`. */
function sectionModel(html: string, selector: string): DomModel {
  const $ = cheerio.load(html);
  return normaliseIds(fragmentModel($.html($(selector))));
}

/** Method, path and query of each people call `ctx` made. */
const peopleCalls = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'people')
    .map(({ method, path, query }) => ({ method, path, query }));

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('cUsers.search people request', () => {
  const query = (fields: Rc): Rc => ({ search: SEARCH_KEYWORD, startrow: '1', recordsperpage: '25', ...fields });

  it.each<[string, () => Req, Rc]>([
    ['the S2 admin on its session site', () => s2Admin(), query({ siteid: 'default', ispublic: '1' })],
    ['a site admin on system users', () => siteAdmin({ ispublic: '0' }), query({ siteid: SITE, ispublic: '0' })],
    [
      'a non-admin, whose ispublic reads 1 whatever rc claims',
      () => usersEditor({ ispublic: '0', isAdmin: 'true' }),
      query({ siteid: 'default', ispublic: '1' }),
    ],
  ])('asks people to search for %s', async (_case, req, expected) => {
    const ctx = contextFor(req());
    await pageHtml(ctx);
    expect(peopleCalls(ctx)).toEqual([{ method: 'GET', path: '/v2/users/search', query: expected }]);
  });

  it('turns away qa_editor without the Users module before asking people', async () => {
    const ctx = contextFor(editorRequest({ circuit: 'cusers', item: 'search', rc: { search: SEARCH_KEYWORD } }));
    expect(await renderScreenPage(searchScreen, ctx)).toMatchObject({ kind: 'redirect' });
    expect(peopleCalls(ctx)).toEqual([]);
  });
});

describe('cUsers.search header', () => {
  it.each<[string, () => Req, string]>([
    ['the S2 admin', () => s2Admin(), 'default'],
    ['a site admin', () => siteAdmin(), SITE],
  ])('titles the results and links the add and list buttons for %s', async (_case, req, site) => {
    const html = await pageHtml(contextFor(req()));
    expect(sectionModel(html, '.mura-header').headings).toEqual(['User Search Results']);
    expect(sectionModel(html, '.mura-header .nav-module-specific').links).toEqual([
      { href: `${ADMIN_URL}cusers.edituser&siteid=${site}&userid=`, text: 'Add User' },
      { href: `${ADMIN_URL}cusers.editgroup&siteid=${site}&userid=`, text: 'Add Group' },
      { href: `${ADMIN_URL}cusers&siteid=${site}`, text: 'Groups' },
      { href: `${ADMIN_URL}cusers.listusers&siteid=${site}`, text: 'Users' },
    ]);
  });

  it('holds the search form with the keyword in its input', async () => {
    const html = await pageHtml(contextFor(siteAdmin({ ispublic: '0' })));
    const form = sectionModel(html, '.mura-header .mura-item-metadata form#siteSearch');
    expect(form.controls.map(({ name, type, value }) => ({ name, type, value }))).toEqual([
      { name: 'search', type: 'text', value: SEARCH_KEYWORD },
      { name: 'siteid', type: 'hidden', value: SITE },
      { name: 'ispublic', type: 'hidden', value: '0' },
      { name: 'muraAction', type: 'hidden', value: 'cUsers.search' },
    ]);
  });
});

describe('cUsers.search tabs', () => {
  it.each([
    ['1', MEMBERS],
    ['0', SYSTEM],
  ])('tabs an admin on ispublic=%s with %s active and titling the block', async (ispublic, active) => {
    const html = await pageHtml(contextFor(siteAdmin({ ispublic })));
    const tabUrl = (flag: string): string =>
      `${ADMIN_URL}cusers.search&ispublic=${flag}&search=${SEARCH_KEYWORD}&siteid=${SITE}`;
    expect(sectionModel(html, 'ul.mura-tab-links').links).toEqual([
      { href: tabUrl('1'), text: MEMBERS },
      { href: tabUrl('0'), text: SYSTEM },
    ]);
    const $ = cheerio.load(html);
    expect($('ul.mura-tab-links > li.active').text().trim()).toBe(active);
    expect(sectionModel(html, '#tab1 .block-header').headings).toEqual([active]);
  });

  it('URL-encodes the keyword in the tab links', async () => {
    const keyword = 'Smith & Co';
    const ctx = contextFor(s2Admin({ search: keyword }));
    const $ = cheerio.load(await pageHtml(ctx));
    expect($('ul.mura-tab-links a').toArray().map((a) => $(a).attr('href'))).toEqual([
      `${ADMIN_URL}cusers.search&siteid=default&ispublic=1&search=Smith+%26+Co`,
      `${ADMIN_URL}cusers.search&siteid=default&ispublic=0&search=Smith+%26+Co`,
    ]);
    expect($('input#search').attr('value')).toBe(keyword);
    expect(peopleCalls(ctx)).toMatchObject([{ query: { search: keyword } }]);
  });

  it('heads a non-admin list Site Members without tabs', async () => {
    const html = await pageHtml(contextFor(usersEditor({ ispublic: '0', isAdmin: 'true' })));
    const $ = cheerio.load(html);
    expect($('ul.mura-tab-links')).toHaveLength(0);
    expect($('h3.block-title')).toHaveLength(0);
    const block = $('.block-constrain > .block-bordered > .block-content');
    expect(block.children().first().is('h3')).toBe(true);
    expect(block.children('h3').text()).toBe(MEMBERS);
    expect(block.children('h3').next().is('table#tbl-users')).toBe(true);
  });
});

describe('cUsers.search results', () => {
  it('lists each match as Lname, Fname in the users table', async () => {
    const html = await pageHtml(contextFor(siteAdmin({ ispublic: '0' })));
    const names = smithSearchResults.items.map((row) => `${row.Lname ?? ''}, ${row.Fname ?? ''}`);
    expect(names).toEqual(['Smith, Jane', 'Smith, John']);
    expect(sectionModel(html, 'table#tbl-users').tables).toEqual([
      {
        headers: ['', '', 'User', 'Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'],
        rows: [
          ['Edit Delete', '', names[0], 'jane_smith@example.com', '10/302/2026', '2:20 PM', 'Tessa Admin'],
          ['Edit Delete', '', names[1], 'john_smith@example.com', '06/169/2026', '8:50 AM', 'Tessa Admin'],
        ],
      },
    ]);
  });

  it('leaves the NULL columns of a match blank and marks it a site member', async () => {
    const [jane] = smithSearchResults.items;
    const blank = { ...jane, UserID: PERSON_IDS.alexDoe, Lname: null, Fname: null, Email: null, S2: null, isPublic: null };
    const page: SearchPage = { ...smithSearchResults, items: [{ ...blank, LastUpdate: null, LastUpdateBy: null }] };
    const html = await pageHtml(contextFor(siteAdmin({ ispublic: '0' }), page));
    expect(sectionModel(html, 'table#tbl-users').tables[0]?.rows).toEqual([['Edit Delete', '', ',', '', '', '', '']]);
    expect(cheerio.load(html)('#tbl-users td:nth-child(2) a[rel="tooltip"]').attr('title')).toBe('Site Member');
  });

  it.each<[string, SearchPage, string[][]]>([
    ['an unassigned id outside the matches', smithSearchResults, [['System User'], ['System User']]],
    [
      'an unassigned match',
      { ...smithSearchResults, listUnassignedUsers: [PERSON_IDS.johnSmith] },
      [['System User'], ['Unassigned', 'System User']],
    ],
  ])('marks only the matches people lists as unassigned, given %s', async (_case, page, icons) => {
    const $ = cheerio.load(await pageHtml(contextFor(siteAdmin({ ispublic: '0' }), page)));
    const titles = $('#tbl-users tbody tr')
      .toArray()
      .map((tr) =>
        $(tr)
          .find('td:nth-child(2) a[rel="tooltip"]')
          .toArray()
          .map((a) => $(a).attr('title')),
      );
    expect(titles).toEqual(icons);
  });

  it.each<[string, () => Req]>([
    ['an admin', () => siteAdmin({ search: EMPTY_SEARCH_KEYWORD })],
    ['a non-admin', () => usersEditor({ search: EMPTY_SEARCH_KEYWORD })],
  ])('tells %s the search returned no results', async (_case, req) => {
    const ctx = contextFor(req(), emptySearchResults);
    const $ = cheerio.load(await pageHtml(ctx));
    expect(peopleCalls(ctx)).toMatchObject([{ query: { search: EMPTY_SEARCH_KEYWORD } }]);
    expect($('div.help-block-empty').text().trim()).toBe('Your search returned no results.');
    expect($('#tbl-users')).toHaveLength(0);
    expect($('form#frmNextN')).toHaveLength(0);
  });
});

describe('renderSearchForm', () => {
  const rb = rbFor('en_US');
  const rc = normaliseCusersRc(siteAdmin({ ispublic: '0' }));
  const render = (search: string = rc.search): string => toString(renderSearchForm({ rc, search, rb }));

  it('renders the GET form1 of the search', () => {
    expect(rc).toMatchObject({ siteid: SITE, isAdmin: true, ispublic: '0' });
    const form = cheerio.load(render(), null, false)('form.form-inline#siteSearch');
    expect(form).toHaveLength(1);
    expect(form.attr()).toMatchObject({ name: 'form1', method: 'get', action: '', novalidate: 'novalidate' });
  });

  it.each([
    [SEARCH_KEYWORD, SEARCH_KEYWORD],
    ['"><script>', '&quot;&gt;&lt;script&gt;'],
  ])('carries the search text %j HTML-encoded in input#search', (search, encoded) => {
    const out = render(search);
    const $ = cheerio.load(out, null, false);
    const input = $('input#search[name="search"][type="text"]');
    expect(input).toHaveLength(1);
    expect(input.attr()).toMatchObject({ placeholder: 'Search for Users', value: search });
    expect(out).toContain(`value="${encoded}"`);
    expect($('script')).toHaveLength(0);
  });

  it('offers the search button and the Advanced button to cUsers.advancedSearch', () => {
    const out = render();
    const $ = cheerio.load(out, null, false);
    expect(fragmentModel(out).buttons).toEqual([
      { text: '', type: 'button', hasOnclick: true },
      { text: 'Advanced', type: 'button', hasOnclick: true },
    ]);
    expect($('span.mura-input-set > button[type="button"]').attr('onclick')).toBe('submitForm(document.forms.form1);');
    const advanced = $('button[value="Advanced"]');
    expect(advanced.text().trim()).toBe('Advanced');
    expect(out).toContain(
      "window.location='./?muraAction=cUsers.advancedSearch&amp;ispublic=0&amp;siteid=tenant-a&amp;newSearch=true'",
    );
    expect(advanced.attr('onclick')).toContain('./?muraAction=cUsers.advancedSearch&ispublic=0&siteid=tenant-a&newSearch=true');
  });

  it('carries siteid, ispublic and the cUsers.search action as hidden fields', () => {
    const hidden = fragmentModel(render()).controls.filter((control) => control.type === 'hidden');
    expect(hidden.map(({ name, value }) => [name, value])).toEqual([
      ['siteid', SITE],
      ['ispublic', '0'],
      ['muraAction', 'cUsers.search'],
    ]);
  });
});
