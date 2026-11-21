// Unit tests for the cUsers users table partial of `cusers/inc/dsp_users_list.cfm`, against legacy ACF 2023 captures.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer, type CsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { getNextN } from '@/screens/cusers/inc/dsp_nextn';
import {
  renderUsersList,
  type UsersListContext,
  type UsersListInput,
  type UsersListRow,
} from '@/screens/cusers/inc/dsp_users_list';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type RecordedRequest } from '../../helpers/fake-gateway';

/** Include output cut from legacy ACF 2023 pages (admin, siteid=default), CSRF pairs replaced by the test pair. */
const fixture = (path: string): string => readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8');

const QA_EDITOR = '3BEC10FC-F5B5-5517-7E7F2072657EFB68';
const ADMIN = '3BE10CC9-9421-80A7-719F9D4816FA78E5';
const EDITOR_GROUP = '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D';
const LIST_USERS = 'core:cusers.listusers';
const GROUP_MEMBERS = 'core:cusers.editgroupmembers';

/** The installed users as the legacy capture lists them. */
const QA_EDITOR_ROW: UsersListRow = {
  userid: QA_EDITOR,
  ispublic: 0,
  s2: 0,
  lname: 'Editor',
  fname: 'QA',
  email: 'qa_editor@example.com',
  lastupdate: '2026-11-13T02:44:17',
  lastupdateby: 'Admin User',
};
const ADMIN_ROW: UsersListRow = {
  userid: ADMIN,
  ispublic: 0,
  s2: 1,
  lname: 'User',
  fname: 'Admin',
  email: 'admin@example.com',
  lastupdate: '2026-11-13T02:43:05',
  lastupdateby: 'System',
};

const RC: UsersListInput['rc'] = { siteid: 'default', userid: '', ispublic: '0', unassigned: '0', recordsperpage: 25 };

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** Input of a one-page list of `rows` on `muraAction`. */
function listInput(rows: readonly UsersListRow[] | undefined, extra: Partial<UsersListInput> = {}): UsersListInput {
  return {
    rows,
    nextn: rows === undefined ? undefined : getNextN(rows.length, 25, 1, 3),
    pageIndex: 1,
    muraAction: LIST_USERS,
    rc: RC,
    ...extra,
  };
}

/** identity `issueCsrfTokens`: the pair the fixtures carry for every requested context. */
function issueFixtureTokens(request: RecordedRequest): { status: number; body: unknown } {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: 'TESTCSRFTOKEN0000000000000000000',
    [CSRF_FIELD_EXPIRES]: '260630150000000',
  }));
  return { status: 200, body: { tokens } };
}

/** The include's markup for `req`, with the real CSRF renderer and bundles over the fake gateway. */
async function render(input: UsersListInput, req: AdminRequest = adminS2Request()): Promise<string> {
  const gateway = fakeGatewayClient({ [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueFixtureTokens });
  return toString(await renderUsersList({ req, csrf: createCsrfRenderer(gateway), rb: rbFor(req.session.rb) }, input));
}

/** A CSRF renderer recording what it was asked to fetch, rendering `&csrf_token=T-<context>&csrf_token_expires=E`. */
function recordingCsrf(): CsrfRenderer & { readonly prefetched: string[][] } {
  const prefetched: string[][] = [];
  return {
    prefetched,
    tokens: () => Promise.reject(new Error('tokens is not used by the include')),
    prefetch: (contexts) => {
      prefetched.push([...contexts]);
      return Promise.resolve();
    },
    render: (context) => raw(`&csrf_token=T-${context}&csrf_token_expires=E`),
  };
}

/** A bundle lookup answering `labels[key]`, else `[key]`. */
function stubRb(labels: Readonly<Record<string, string>> = {}): RbLookup {
  return { locale: 'en', rbKey: (key) => labels[key] ?? `[${key}]`, messageFormat: () => '' };
}

/** The include's markup under stub CSRF and bundles. */
async function renderStub(
  input: UsersListInput,
  { req = adminS2Request(), csrf = recordingCsrf(), rb = stubRb() }: Partial<UsersListContext> = {},
): Promise<string> {
  return toString(await renderUsersList({ req, csrf, rb }, input));
}

describe('renderUsersList against legacy captures', () => {
  it('matches cUsers.listUsers (system users, one unassigned S2) byte for byte', async () => {
    const markup = await render(listInput([QA_EDITOR_ROW, ADMIN_ROW], { listUnassignedUsers: ADMIN }));
    expect(markup).toBe(fixture('people/cusers-listusers-users-list.html'));
  });

  it('matches cUsers.editGroupMembers with its remove-from-group links byte for byte', async () => {
    const markup = await render(
      listInput([QA_EDITOR_ROW], { muraAction: GROUP_MEMBERS, rc: { ...RC, userid: EDITOR_GROUP, ispublic: '1' } }),
    );
    expect(markup).toBe(fixture('identity/cusers-editgroupmembers-users-list.html'));
  });

  it.each([
    ['cUsers.listUsers', 'There are currently no  users available.', 'people/cusers-listusers-users-empty.html'],
    ['cUsers.editGroupMembers', 'This group has no members.', 'identity/cusers-editgroupmembers-users-empty.html'],
  ])('matches the empty %s message byte for byte', async (_view, noUsersMessage, path) => {
    expect(await render(listInput([], { noUsersMessage }))).toBe(fixture(path));
  });
});

describe('renderUsersList', () => {
  it('renders nothing without rows, as legacy does without rc.it', async () => {
    expect(await renderStub(listInput(undefined))).toBe('');
  });

  it.each<[string, string | undefined, string]>([
    ['the bundle label as written', undefined, '<b>none</b> '],
    ['the message HTML-encoded', 'a<b> & "c"', 'a&lt;b&gt; &amp; &quot;c&quot; '],
    ['an empty message without the trailing space', '', ''],
  ])('shows %s for no rows', async (_case, noUsersMessage, text) => {
    const markup = await renderStub(listInput([], { noUsersMessage }), { rb: stubRb({ 'user.nousers': '<b>none</b>' }) });
    expect(markup).toBe(`\n\n\t\t\t\n\t\t\t\t<div class="help-block-empty">\n\t\t\t\t\t${text}\n\t\t\t\t</div>\n\n\t\t`);
  });

  it('labels the headers raw from the bundle', async () => {
    const $ = cheerio.load(await renderStub(listInput([QA_EDITOR_ROW])), null, false);
    const headers = $('#tbl-users thead th')
      .toArray()
      .map((th) => [$(th).attr('class'), $(th).text().trim()]);
    expect(headers).toEqual([
      ['actions', ''],
      ['actions', ''],
      ['var-width', '[user.user]'],
      [undefined, '[user.email]'],
      ['hidden-xs', '[user.datelastupdate]'],
      ['hidden-xs hidden-sm', '[user.timelastupdate]'],
      ['hidden-xs', '[user.lastupdatedby]'],
    ]);
  });

  it.each<[string, Partial<UsersListRow>, string | undefined, string[]]>([
    ['an unassigned super user', { s2: 1 }, `x,,${QA_EDITOR.toLowerCase()}`, ['Unassigned:mi-exclamation', '[user.superuser]:mi-star']],
    ['a system user', { s2: 0, ispublic: '0' }, undefined, ['[user.adminuser]:mi-user']],
    ['a site member', { s2: '', ispublic: 1 }, `${ADMIN},`, ['[user.sitemember]:mi-user']],
    ['a non-numeric S2 as not equal to 1', { s2: 'x', ispublic: '' }, '', ['[user.sitemember]:mi-user']],
  ])('marks %s', async (_case, row, listUnassignedUsers, icons) => {
    const input = listInput([{ ...QA_EDITOR_ROW, ...row }], { listUnassignedUsers });
    const $ = cheerio.load(await renderStub(input), null, false);
    const shown = $('#tbl-users tbody td:nth-child(2) li a')
      .toArray()
      .map((a) => `${$(a).attr('title')}:${$(a).find('i').attr('class')}`);
    expect(shown).toEqual(icons);
  });

  it('offers edit and delete links only on rows the user may edit, and fetches tokens for those alone', async () => {
    const csrf = recordingCsrf();
    const member: UsersListRow = { ...QA_EDITOR_ROW, userid: 'MEMBER-ID', ispublic: '1', lname: 'Doe', fname: '' };
    const markup = await renderStub(listInput([QA_EDITOR_ROW, member]), { req: editorRequest(), csrf });
    expect(csrf.prefetched).toEqual([['MEMBER-ID']]);
    const $ = cheerio.load(markup, null, false);
    const [system, editable] = $('#tbl-users tbody tr').toArray();
    expect($(system).find('ul.actions-list li')).toHaveLength(0);
    expect($(system).find('td.var-width a')).toHaveLength(0);
    // Without the link, the name is followed by the space whitespace management prints after it.
    expect(markup).toContain('<td class="var-width">\n\t\t\t\t\t\t\t\t\t\tEditor, QA \n\t\t\t\t\t\t\t\t\t</td>');
    expect($(editable).find('ul.actions-list li').toArray().map((li) => $(li).attr('class'))).toEqual([
      undefined,
      'delete',
    ]);
    expect($(editable).find('td.var-width a').text().trim()).toBe('Doe,');
  });

  it('lets a site admin edit system users', async () => {
    const csrf = recordingCsrf();
    await renderStub(listInput([QA_EDITOR_ROW]), { req: siteAdminRequest('default'), csrf });
    expect(csrf.prefetched).toEqual([[QA_EDITOR]]);
  });

  it('builds the delete link with the group type, raw ids and the row CSRF query', async () => {
    const input = listInput([{ ...QA_EDITOR_ROW, userid: 'U&1' }], { rc: { ...RC, siteid: 'a b' } });
    const $ = cheerio.load(await renderStub(input), null, false);
    expect($('li.delete a').attr('href')).toBe(
      '/admin/index.cfm?muraAction=cusers.update&action=delete&ispublic=0&userid=U&1&siteid=a+b&type=1&csrf_token=T-U&1&csrf_token_expires=E',
    );
    expect($('li a[rel="tooltip"][onclick^="actionModal"]').attr('href')).toBe(
      '/admin/index.cfm?muraAction=cusers.edituser&userid=U&1&siteid=a+b',
    );
  });

  it.each([
    ['the qualified action in another case', 'core:cUsers.EditGroupMembers', 1],
    ['the user list', LIST_USERS, 0],
  ])('adds remove-from-group links for %s', async (_case, muraAction, count) => {
    const input = listInput([QA_EDITOR_ROW], { muraAction, rc: { ...RC, userid: 'G 1' } });
    const $ = cheerio.load(await renderStub(input), null, false);
    expect($('li.remove')).toHaveLength(count);
    if (count === 1) {
      expect($('li.remove a').attr('href')).toBe(
        `/admin/index.cfm?muraAction=cusers.removefromgroup&userid=${QA_EDITOR}&routeid=G+1&groupid=G+1&siteid=default`,
      );
    }
  });

  it('escapes the confirmation texts with JSStringFormat and keeps them raw in the onclick attribute', async () => {
    const rb = stubRb({ 'user.deleteuserconfirm': `It's "gone" \\ \n\r\t\b\f<`, 'user.removeconfirm': "Don't" });
    const markup = await renderStub(listInput([QA_EDITOR_ROW], { muraAction: GROUP_MEMBERS }), { rb });
    expect(markup).toContain(`onclick="return confirmDialog('It\\'s \\"gone\\" \\\\ \\n\\r\\t\\b\\f<',this.href)"`);
    expect(markup).toContain(`onclick="return confirmDialog('Don\\'t',this.href)"`);
  });

  it.each([
    ['URL-encodes the mailto address', 'a@b.com', 'mailto:a%40b.com', 'a&#x40;b.com'],
    ['writes a non-breaking space without an email', '', undefined, '&nbsp;'],
  ])('%s', async (_case, email, href, cell) => {
    const markup = await renderStub(listInput([{ ...QA_EDITOR_ROW, email }]));
    const $ = cheerio.load(markup, null, false);
    expect($('#tbl-users tbody td:nth-child(4) a').attr('href')).toBe(href);
    expect(markup).toContain(cell);
  });

  it.each<[string, string, string, string]>([
    ['en_US with its day-of-year mask', 'en_US', '11/317/2026', '2:44 AM'],
    ['en_GB', 'en_GB', '317/11/2026', '02:44'],
  ])('formats the last update under the session locale, %s', async (_case, locale, date, time) => {
    const req = adminS2Request({ session: { locale } });
    const $ = cheerio.load(await renderStub(listInput([QA_EDITOR_ROW]), { req }), null, false);
    const cells = $('#tbl-users tbody td')
      .toArray()
      .slice(4)
      .map((td) => $(td).text().trim());
    expect(cells).toEqual([date, time, 'Admin User']);
  });

  it('leaves both update cells empty without a last update, and HTML-encodes the updater', async () => {
    const row: UsersListRow = { ...QA_EDITOR_ROW, lastupdate: null, lastupdateby: '<i>x</i>' };
    const markup = await renderStub(listInput([row]));
    expect(markup).toContain('<td class="hidden-xs">\n\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t</td>');
    expect(markup).toContain('&lt;i&gt;x&lt;&#x2f;i&gt;');
  });

  it('fails as ACF does on a last update it cannot read', async () => {
    await expect(renderStub(listInput([{ ...QA_EDITOR_ROW, lastupdate: 'soon' }]))).rejects.toThrow(RangeError);
  });

  it('lets gateway unavailability from the CSRF fetch propagate', async () => {
    const unavailable = new GatewayUnavailableError('identity', 503);
    const csrf: CsrfRenderer = { ...recordingCsrf(), prefetch: () => Promise.reject(unavailable) };
    await expect(renderStub(listInput([QA_EDITOR_ROW]), { csrf })).rejects.toBe(unavailable);
  });
});
