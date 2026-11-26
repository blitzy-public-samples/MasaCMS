// `cUsers.editGroupMembers`: the controller's `editGroup()` and the members view of `admin/core/views/cusers/editgroupmembers.cfm` (server-only).
import { isCfUuid } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/identity';
import { okBody } from '@/lib/gateway-client';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { getNextN, legacyPageIndex, type NextN } from './inc/dsp_nextn';
import { renderUsersList, type UsersListRow } from './inc/dsp_users_list';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the whitespace around them is kept.

/** `utility.getNextN` page buffer the cUsers controller passes. */
const PAGE_BUFFER = 3;

/** Most members one identity `listGroupMembers` call answers. */
const MEMBER_PAGE_LIMIT = 1000;

/** One identity `listGroupMembers` window with the listing's total and the next window's offset. */
type GroupMembersPage = components['schemas']['GroupMembers'];

/** Everything the view reads after `editGroup()` and `setUsersIterator()`. */
export interface EditGroupMembersData {
  readonly rc: CusersRc;
  /** `rc.userid` after `editGroup()` copies a non-empty `rc.groupid` over it. */
  readonly userid: string;
  /** `rc.userBean.getGroupName()`; empty for an id that names no stored group. */
  readonly groupName: string;
  /** The current page's members of `rc.it`. */
  readonly rows: readonly UsersListRow[];
  readonly nextn: NextN;
  /** The iterator's page index after `setPage(nextn.startrow)`. */
  readonly pageIndex: number;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<EditGroupMembersData>['render']>>;

/** One identity `GroupMember`: the `readGroupMemberships` columns under their query names. */
type GroupMemberColumns = { readonly userID: string } & Readonly<Record<string, unknown>>;

/** A query cell as CFML prints it: SQL NULL and an absent column read as `''`; complex values throw. */
function cell(value: unknown, column: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${column} is not a simple value`);
}

/** The `rc.it` row of one member, by the names the users list reads. */
function memberRow(member: GroupMemberColumns): UsersListRow {
  return {
    userid: member.userID,
    ispublic: cell(member.IsPublic, 'IsPublic'),
    s2: cell(member.S2, 'S2'),
    lname: cell(member.Lname, 'Lname'),
    fname: cell(member.Fname, 'Fname'),
    email: cell(member.Email, 'Email'),
    lastupdate: cell(member.LastUpdate, 'LastUpdate'),
    lastupdateby: cell(member.LastUpdateBy, 'LastUpdateBy'),
  };
}

/**
 * `userManager.read(groupId).getGroupName()`; identity answers an unknown id with its defaulted new group.
 * @throws GatewayDenialError When identity refuses the read (401 or 403).
 */
async function readGroupName(ctx: ScreenContext, groupId: string): Promise<string> {
  const response = await ctx.gateway.identity.call('get', '/v1/groups/{groupId}', { params: { groupId } });
  return okBody(response, 'identity', 'getGroup').group.GroupName ?? '';
}

/**
 * The `limit` members at `offset` of `userManager.readGroupMemberships(groupId)`, by last name, with their total;
 * identity lists S2 members to an S2 caller only.
 * @throws GatewayDenialError When identity refuses the read (401 or 403).
 */
async function readMembers(ctx: ScreenContext, groupId: string, offset: number, limit: number): Promise<GroupMembersPage> {
  const response = await ctx.gateway.identity.call('get', '/v1/groups/{groupId}/members', {
    params: { groupId },
    query: { offset, limit },
  });
  return okBody(response, 'identity', 'listGroupMembers');
}

/** The rows of `page` and of the windows after it up to row `end`, each further call reading at most 1000 rows. */
async function membersThrough(ctx: ScreenContext, groupId: string, page: GroupMembersPage, end: number): Promise<UsersListRow[]> {
  const rows = page.items.map(memberRow);
  for (let next = page.nextOffset; next !== null && next < end; ) {
    const more: GroupMembersPage = await readMembers(ctx, groupId, next, Math.min(MEMBER_PAGE_LIMIT, end - next));
    rows.push(...more.items.map(memberRow));
    next = more.nextOffset;
  }
  return rows;
}

/**
 * The view's data: `editGroup()`'s group name and members, paged as `setUsersIterator()` pages them, reading only the
 * page's members besides the total. Gateway unavailability propagates.
 * @throws GatewayDenialError When identity refuses a read (401 or 403).
 */
export async function loadEditGroupMembers(ctx: ScreenContext): Promise<EditGroupMembersData> {
  const rc = normaliseCusersRc(ctx.req);
  const userid = rc.groupid !== '' ? rc.groupid : rc.userid;
  // Start row 1 always lands on page 1, which the first read, needed for the total, then covers; any other start row
  // needs the total before its page is known.
  const firstLimit = rc.startRow === 1 ? Math.min(MEMBER_PAGE_LIMIT, Math.trunc(rc.recordsperpage)) : 1;
  // An id that is no CF UUID, `before()`'s empty default included, matches no `tusers` row: legacy shows a new bean's
  // empty name and no members, where identity would refuse the id.
  const [groupName, probe]: readonly [string, GroupMembersPage | null] = isCfUuid(userid)
    ? await Promise.all([readGroupName(ctx, userid), readMembers(ctx, userid, 0, firstLimit)])
    : ['', null];
  const total = probe?.total ?? 0;
  const startRow = rc.startRow > total ? 1 : rc.startRow;
  const nextn = getNextN(total, rc.recordsperpage, startRow, PAGE_BUFFER);
  const pageIndex = legacyPageIndex(nextn.startRow, nextn.recordsPerPage, total);
  const first = (pageIndex - 1) * nextn.recordsPerPage;
  // The iterator's rows `first` to `first + recordsPerPage`, fractional bounds truncated as Array#slice truncates them.
  const start = Math.trunc(first);
  const end = Math.trunc(first + nextn.recordsPerPage);
  if (probe === null || start >= total) return { rc, userid, groupName, rows: [], nextn, pageIndex };
  const page = rc.startRow === 1 ? probe : await readMembers(ctx, userid, start, Math.min(MEMBER_PAGE_LIMIT, end - start));
  return { rc, userid, groupName, rows: await membersThrough(ctx, userid, page, end), nextn, pageIndex };
}

/** The view body inside `#mura-content`; the download link shows only when the page lists members. */
export async function renderEditGroupMembers(ctx: ScreenContext, data: EditGroupMembersData): Promise<ShellView> {
  const { rc, userid } = data;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(key));
  // The view's `buildURL` calls pass no path, so links take FW/1's default script name, not `./`.
  const url = (action: string, queryString = ''): SafeHtml =>
    raw(buildUrl(action, undefined, queryString, { ses: ctx.req.ses }));
  const back = ctx.rb.rbKey('sitemanager.back');
  const download =
    data.rows.length === 0
      ? ''
      : html`
\t\t\t\t<a class="btn" href="${url('cusers.downloadgroupmembers', `userid=${encodeUrl(userid)}`)}">
\t\t\t\t\t\t\t<i class="mi-download"></i>\x20
\t\t\t\t\t${label('user.download')}
\t\t\t\t</a>
\t    `;
  const list = await renderUsersList(ctx, {
    rows: data.rows,
    nextn: data.nextn,
    pageIndex: data.pageIndex,
    noUsersMessage: ctx.rb.rbKey('user.nogroupmembers'),
    muraAction: ctx.req.action,
    rc: { siteid: rc.siteid, userid, ispublic: rc.ispublic, unassigned: rc.unassigned, recordsperpage: rc.recordsperpage },
  });
  const body = html`
<div class="mura-header">
\t<h1>${label('user.groupform')}</h1>
\t
\t<div class="nav-module-specific btn-group">
\t\t
\t\t<a class="btn" href="#" title="${back}" onclick="actionModal();window.history.back(); return false;">
\t\t\t\t\t<i class="mi-arrow-circle-left"></i>\x20
\t\t\t${back}
\t\t</a>
\t\t
\t\t<a class="btn" href="${url('cusers.list')}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-users"></i>
\t\t\t${label('user.viewallgroups')}
\t\t</a>
\t\t
\t\t<a class="btn" href="${url('cusers.editgroup', `userid=${encodeUrl(userid)}&siteid=${encodeUrl(rc.siteid)}`)}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-pencil"></i>
\t\t\t${label('user.editgroupsettings')}
\t\t</a>
\t\t
\t    ${download}
\t</div>

</div> <!-- /.mura-header -->

<div class="block block-constrain">
\t\t<div class="block block-bordered">
\t\t  <div class="block-content">

\t<h2>
\t\t<strong>${data.groupName}</strong> ${label('user.users')}
\t</h2>

\t${list}

\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;
  return { body };
}

/** `cUsers.editGroupMembers`, owned by identity, behind the cUsers `before()` gate. */
export const editGroupMembersScreen: PageScreen<EditGroupMembersData> = Object.freeze({
  circuit: 'cusers',
  action: 'editgroupmembers',
  owner: 'identity',
  mode: 'page',
  gate: cusersGate,
  load: loadEditGroupMembers,
  render: renderEditGroupMembers,
});
