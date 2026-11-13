// cUsers.listUsers: the user list of `cusers/listusers.cfm` over the `cusers.cfc listUsers()` controller (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/people';
import { cfEq } from '@/lib/cfml';
import { okBody } from '@/lib/gateway-client';
import { encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { legacyPageIndex, type NextN } from './inc/dsp_nextn';
import { renderUsersHeader } from './inc/dsp_users_header';
import { renderUsersList, type UsersListRow } from './inc/dsp_users_list';

// The markup is the view's bytes as ACF 2023 prints them, matched against legacy captures: CFML comments are dropped
// and the text around them joins, and whitespace-only text between two CFML constructs prints one space after output
// that ends in non-whitespace, else nothing.

type UserListRow = components['schemas']['UserListRow'];
type ContractNextN = components['schemas']['NextN'];

/** What the view reads from the context `listUsers()` leaves. */
export interface ListUsersData {
  /** The `before()` context, with `siteid` blanked when the request asked for `all`. */
  readonly rc: CusersRc;
  /** The rows `rc.it` iterates: the page `nextn` selects. */
  readonly rows: readonly UsersListRow[];
  readonly nextn: NextN;
  /** The iterator's page index, from `legacyPageIndex`. */
  readonly pageIndex: number;
  /** `ValueList(rc.rsUnassignedUsers.userid)`. */
  readonly listUnassignedUsers: string;
  readonly noUsersMessage: string;
}

/** CFML `value eq 1` under ACF's loose comparison: boolean words as 1 or 0, and `'1.'` stays text. */
const eqOne = (value: string): boolean => cfEq(value, 1);

/** CFML `value eq 0` under ACF's loose comparison: boolean words as 1 or 0, and `'0.'` stays text. */
const eqZero = (value: string): boolean => cfEq(value, 0);

/** What whitespace-only text prints after `output`: one space after non-whitespace (char > U+0020), else nothing. */
const cfSpace = (output: string): string => (output !== '' && output.charCodeAt(output.length - 1) > 0x20 ? ' ' : '');

/** `rc` whose `siteid`, under any casing, reads as `siteid`, as the controller's assignment leaves the struct. */
function withSiteId(rc: CusersRc, siteid: string): CusersRc {
  const isSiteId = (name: string | symbol): boolean => typeof name === 'string' && name.toLowerCase() === 'siteid';
  return new Proxy(rc, {
    get: (target, name, receiver) => (isSiteId(name) ? siteid : Reflect.get(target, name, receiver)),
  });
}

/** One people row as `rc.it` hands it to the include; NULL columns read as `''`, as a CFML query returns them. */
function rowOf(row: UserListRow): UsersListRow {
  return {
    userid: row.UserID,
    ispublic: row.isPublic ?? '',
    s2: row.S2 ?? '',
    lname: row.Lname ?? '',
    fname: row.Fname ?? '',
    email: row.Email ?? '',
    lastupdate: row.LastUpdate ?? null,
    lastupdateby: row.LastUpdateBy ?? '',
  };
}

/** people's `getNextN` struct under the include's names. */
function nextNOf(nextn: ContractNextN): NextN {
  return {
    totalRecords: nextn.totalrecords,
    recordsPerPage: nextn.recordsperpage,
    numberOfPages: nextn.numberofpages,
    currentPageNumber: nextn.currentpagenumber,
    firstPage: nextn.firstpage,
    lastPage: nextn.lastpage,
    next: nextn.next,
    previous: nextn.previous,
    through: nextn.through,
    startRow: nextn.startrow,
  };
}

/**
 * `listUsers()` over the `before()` context: people's list, the iterator's page and the empty-list message.
 * @throws GatewayDenialError When people refuses the list (401 or 403).
 */
export async function loadListUsers(ctx: ScreenContext): Promise<ListUsersData> {
  const rc = normaliseCusersRc(ctx.req);
  // `siteid=all` is sent as is: people's contract takes `all` for the controller's empty site id (every site) and
  // rejects an empty one, so only the view's `rc.siteid` is blanked below.
  const query = {
    siteid: rc.siteid,
    ispublic: rc.ispublic,
    unassigned: rc.unassigned,
    startrow: String(rc.startRow),
    recordsperpage: String(rc.recordsperpage),
  };
  const page = okBody(await ctx.gateway.people.call('get', '/v2/users', { query }), 'people', 'listUsersV2');
  const nextn = nextNOf(page.nextn);
  const pageIndex = legacyPageIndex(nextn.startRow, nextn.recordsPerPage, nextn.totalRecords);
  const msgArg = eqOne(rc.unassigned) ? `'${ctx.rb.rbKey('user.unassigned')}'` : '';
  return {
    rc: cfEq(rc.siteid, 'all') ? withSiteId(rc, '') : rc,
    // people answers only the people of the page `nextn` selects.
    rows: page.items.map(rowOf),
    nextn,
    pageIndex,
    listUnassignedUsers: page.listUnassignedUsers.join(','),
    noUsersMessage: ctx.rb.messageFormat(ctx.rb.rbKey('user.nousersavailable'), [msgArg]),
  };
}

/** The view's markup: header, member and system tabs for an admin, filters, the download for a non-empty page, the list. */
export async function renderListUsersBody(ctx: ScreenContext, data: ListUsersData): Promise<SafeHtml> {
  const { rc, rows } = data;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(key));
  // The view passes buildURL no path, so links take the script name (not `./`); FW/1 emits them unencoded and the
  // view URL-encodes only the values it interpolates.
  const url = (action: string, queryString: string): SafeHtml =>
    raw(buildUrl(action, undefined, queryString, { ses: ctx.req.ses }));
  const siteQuery = `siteid=${encodeUrl(rc.siteid)}`;
  const ispublic = encodeUrl(rc.ispublic);
  const unassigned = encodeUrl(rc.unassigned);

  const tab = (tabIsPublic: '0' | '1', key: string, active: boolean): SafeHtml =>
    join([
      html`<li${active && raw(' class="active"')}>\n`,
      html`            <a href="${url('cusers.listusers', `${siteQuery}&ispublic=${tabIsPublic}&unassigned=${unassigned}`)}" onclick="actionModal();">\n`,
      html`              ${label(key)}\n            </a>\n          </li>`,
    ]);
  const tabNav = rc.isAdmin
    ? join([
        html`\n\t\t\t\t<ul id="viewTabs" class="mura-tab-links nav-tabs">\n          \n          `,
        tab('1', 'user.sitemembers', eqOne(rc.ispublic)),
        html`\n\n          \n          `,
        tab('0', 'user.systemusers', eqZero(rc.ispublic)),
        html`\n        </ul>\n    `,
      ])
    : html`\n      <h3>${label('user.sitemembers')}</h3>\n    `;

  // The toggle tests the encoded value's truthiness, as the view's `esapiEncode('url', rc.unassigned) ? 0 : 1` does.
  const toggleUrl = url('cusers.listusers', `${siteQuery}&ispublic=${ispublic}&unassigned=${cfToBoolean(unassigned) ? '0' : '1'}`);
  const toggleLabel = ctx.rb.rbKey(eqZero(rc.unassigned) ? 'user.viewunassignedonly' : 'user.viewall');
  const download =
    rows.length > 0
      ? join([
          html`\n  \t\t\t\t<a class="btn" href="${url('cusers.download', `${siteQuery}&ispublic=${ispublic}&unassigned=${unassigned}`)}">\n`,
          html`\t\t\t  \t\t<i class="mi-download"></i>\n  \t\t\t\t\t${label('user.download')}\n  \t\t\t\t</a>\n        `,
        ])
      : html``;

  const list = await renderUsersList(ctx, {
    rows,
    nextn: data.nextn,
    pageIndex: data.pageIndex,
    listUnassignedUsers: data.listUnassignedUsers,
    noUsersMessage: data.noUsersMessage,
    muraAction: ctx.req.action,
    rc,
  });

  return join([
    renderUsersHeader(ctx, rc),
    html`\n\n\t<div class="block block-constrain">\n\n\t\n    `,
    tabNav,
    html`\n  \n\n  <div class="block-content tab-content">\n\n\t\t<!-- start tab -->\n`,
    html`\t\t<div id="tab1" class="tab-pane active">\n\n\t\t\t<div class="block block-bordered">\n`,
    html`\t\t\t\t<!-- block header -->\n\t\t\t\t<div class="block-header">\n`,
    html`\t\t\t\t\t\t<h3 class="block-title">${label('user.users')}</h3>\n`,
    html`\t\t\t\t</div> <!-- /.block header -->\n\t\t\t\t<div class="block-content">\n\n\t\n`,
    html`\t\t<div class="mura-control-group">\n\n\t\t\t\n`,
    html`\t\t\t\t<a class="btn" href="${toggleUrl}" onclick="actionModal();">\n\t\t\t\t\t<i class="mi-filter"></i>\n`,
    html`\t\t\t\t\t${raw(toggleLabel)}${cfSpace(toggleLabel)}\n\t\t\t\t</a>\n\n\t\t\t\n        `,
    download,
    html`\n\n\t\t</div>\n\t\n\n\t\n\t\t`,
    list,
    html`\n\n\t\t\t\t</div> <!-- /.block-content -->\n\t\t\t</div> <!-- /.block-bordered -->\n`,
    html`\t\t</div> <!-- /.tab-pane -->\n\n\n\t</div> <!-- /.block-content.tab-content -->\n`,
    html`</div> <!-- /.block-constrain -->\n`,
  ]);
}

/** `cUsers.listUsers`, owned by people, behind the cUsers `before()` gate. */
export const listUsersScreen: PageScreen<ListUsersData> = Object.freeze({
  circuit: 'cusers',
  action: 'listusers',
  owner: 'people',
  mode: 'page',
  gate: cusersGate,
  load: loadListUsers,
  render: async (ctx: ScreenContext, data: ListUsersData) => ({ body: await renderListUsersBody(ctx, data) }),
});
