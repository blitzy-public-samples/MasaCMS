// `cUsers.list`: the controller's `list()` and the group list of `admin/core/views/cusers/list.cfm` (server-only).
import { cfLsDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/people';
import { cfEq } from '@/lib/cfml';
import { parseLegacyDate } from '@/lib/dates';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeJs, encodeUrl, join, raw } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, isCusersAdmin, normaliseCusersRc, type CusersRc } from './gate';
import { renderUsersHeader } from './inc/dsp_users_header';
import { legacyPageIndex, renderNextN, type NextN } from './inc/dsp_nextn';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the text around them joins, and whitespace-only text between two CFML constructs prints one space after output that
// ends in non-whitespace, else nothing.

/** One group of people's `listUserGroups` answer, in `getUserGroups` column casing. */
export type GroupListRow = components['schemas']['GroupListRow'];

/** People's `listUserGroups` answer: every group of the pool, and the `getNextN` paging of the request. */
export type UserGroupsPage = components['schemas']['UserGroupsPage'];

/** Everything the view reads after `list()` and `setUsersIterator()`. */
export interface GroupListData {
  readonly rc: CusersRc;
  /** The rows `rc.it` iterates: the groups of its current page. */
  readonly rows: readonly GroupListRow[];
  /** `rc.nextn`. */
  readonly nextn: NextN;
  /** The iterator's page index, as `setPage(nextn.startrow)` leaves it. */
  readonly pageIndex: number;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<GroupListData>['render']>>;

/** A line break followed by `depth` tabs of legacy indentation. */
const nl = (depth: number): string => `\n${'\t'.repeat(depth)}`;

/** What a whitespace-only text run prints after `output`: one space after non-whitespace (char > U+0020), else nothing. */
const cfSpace = (output: string): string => (output === '' || output.charCodeAt(output.length - 1) <= 0x20 ? '' : ' ');

/** CFML `URLEncodedFormat`: every character but ASCII letters and digits as `%XX` of its UTF-8 bytes. */
const urlEncodedFormat = (value: string): string =>
  encodeURIComponent(value).replace(/[-_.!~*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** `rc.ispublic eq n` under ACF's loose comparison (`'1.'` stays text, so it equals neither 1 nor 0). */
const isPublicEq = (ispublic: string, n: 0 | 1): boolean => cfEq(ispublic, n);

/** `local.item.getValue('perm') eq 0`: only such groups get a delete link; a NULL `Perm` reads as '' and gets none. */
const isDeletable = (row: GroupListRow): boolean => row.Perm === 0;

/** People's `NextN`, in the field casing of `utility.getNextN` the include reads. */
function nextNOf(page: UserGroupsPage['nextn']): NextN {
  return {
    totalRecords: page.totalrecords,
    recordsPerPage: page.recordsperpage,
    numberOfPages: page.numberofpages,
    currentPageNumber: page.currentpagenumber,
    firstPage: page.firstpage,
    lastPage: page.lastpage,
    next: page.next,
    previous: page.previous,
    through: page.through,
    startRow: page.startrow,
  };
}

/**
 * The view's data: people's groups of the site's member or system pool, paged as the controller's iterator pages them.
 * Gateway unavailability propagates.
 * @throws GatewayDenialError When people refuses the read (401 or 403).
 */
export async function loadGroupList(ctx: ScreenContext): Promise<GroupListData> {
  const rc = normaliseCusersRc(ctx.req);
  const response = await ctx.gateway.people.call('get', '/v1/users/groups', {
    query: {
      siteid: rc.siteid,
      ispublic: rc.ispublic,
      startrow: String(rc.startRow),
      recordsperpage: String(rc.recordsperpage),
    },
  });
  const page = okBody(response, 'people', 'listUserGroups');
  const nextn = nextNOf(page.nextn);
  const pageIndex = legacyPageIndex(nextn.startRow, nextn.recordsPerPage, page.items.length);
  const first = (pageIndex - 1) * nextn.recordsPerPage;
  return { rc, rows: page.items.slice(first, first + nextn.recordsPerPage), nextn, pageIndex };
}

/**
 * `LSDateFormat`/`LSTimeFormat` input: null for an empty value.
 * @throws RangeError As ACF does for a value it cannot read as a date.
 */
function lastUpdateOf(value: GroupListRow['LastUpdate']): Date | null {
  if (value === null || value === undefined) return null;
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${value} cannot be converted to a date.`);
  return date;
}

/** The parts of the screen context the rows read, with the label lookup bound. */
interface RowScope {
  readonly ctx: ScreenContext;
  readonly rc: CusersRc;
  readonly label: (key: string) => string;
  readonly url: (action: string, queryString: string) => string;
}

/** The delete item of a deletable group: `cusers.update` with the group's CSRF pair, behind a confirm dialog. */
function renderDeleteItem({ ctx, rc, label, url }: RowScope, row: GroupListRow): string {
  const csrf = ctx.csrf.render(row.UserID, 'url').value;
  const query = `action=delete&isPublic=${String(row.isPublic ?? '')}&userid=${row.UserID}&siteid=${encodeUrl(rc.siteid)}&type=1${csrf}`;
  const confirm = encodeJs(ctx.rb.messageFormat(label('user.deleteusergroupconfim'), [row.GroupName ?? '']));
  return [
    `${nl(0)}${nl(13)}<li class="delete">`,
    `${nl(14)}<a href="${url('cusers.update', query)}" onclick="return confirmDialog('${confirm}',this.href)" rel="tooltip">`,
    `${nl(15)}<i class="mi-trash"></i>${label('user.delete')}${nl(14)}</a>${nl(13)}</li>${nl(0)}${nl(12)}`,
  ].join('');
}

/** One `<tr>` of the loop, with the whitespace the loop body leaves after it. */
function renderRow(scope: RowScope, row: GroupListRow): string {
  const { ctx, rc, label, url } = scope;
  const groupQuery = `userid=${row.UserID}&siteid=${encodeUrl(rc.siteid)}`;
  const editUrl = url('cusers.editgroup', groupQuery);
  const email = row.Email ?? '';
  const emailCell =
    email.length > 0
      ? `${nl(10)}<a href="mailto:${urlEncodedFormat(email)}">${nl(11)}${encodeHtml(email)}${nl(10)}</a>${nl(9)}`
      : `${nl(10)}&nbsp;${nl(9)}`;
  const lastUpdate = lastUpdateOf(row.LastUpdate);
  // Plain LSDateFormat under the session mask, whose `DD` prints the day of the year (10/302/2026).
  const date = lastUpdate === null ? '' : cfLsDateFormat(lastUpdate, ctx.req.session.dateKeyFormat, ctx.req.session.locale);
  const time = lastUpdate === null ? '' : cfLsTimeFormat(lastUpdate, 'short', ctx.req.session.locale);
  const action = (item: string, icon: string, href: string, text: string): string =>
    `${nl(12)}<li class="${item}">${nl(13)}<a href="${href}" rel="tooltip" onclick="actionModal(); window.location=this.href;">` +
    `${nl(14)}<i class="${icon}"></i>${text}${nl(13)}</a>${nl(12)}</li>${nl(0)}${nl(11)}`;
  const cell = (content: string): string => `${nl(8)}<td>${nl(9)}${content}${nl(8)}</td>${nl(0)}${nl(7)}`;
  return [
    `${nl(6)}<tr>${nl(7)}${nl(8)}<td class="actions">`,
    `${nl(9)}<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>`,
    `${nl(9)}<div class="actions-menu hide">${nl(10)}<ul class="actions-list">${nl(0)}${nl(11)}`,
    action('edit', 'mi-pencil', editUrl, label('user.edit')),
    action('members', 'mi-users', url('cusers.editgroupmembers', groupQuery), label('user.members')),
    `${nl(12)}`,
    isDeletable(row) ? renderDeleteItem(scope, row) : '',
    `${nl(0)}${nl(10)}</ul>${nl(9)}</div>${nl(8)}</td>${nl(7)}${nl(0)}${nl(7)}`,
    `${nl(8)}<td class="var-width">${nl(9)}<a href="${editUrl}" onclick="actionModal();">`,
    `${nl(10)}${encodeHtml(row.GroupName)}</a>${nl(9)}(${String(row.Counter ?? 0)})${nl(8)}</td>${nl(0)}${nl(7)}`,
    `${nl(8)}<td>${nl(9)}${emailCell}${nl(8)}</td>${nl(0)}${nl(7)}`,
    cell(date),
    cell(time),
    `${nl(8)}<td>${nl(9)}${encodeHtml(row.LastUpdateBy)}${nl(8)}</td>${nl(0)}${nl(0)}${nl(6)}</tr>${nl(5)}`,
  ].join('');
}

/** The group table with its header row, every row of the page, and the trailing whitespace before `dsp_nextn`. */
function renderTable(scope: RowScope, rows: readonly GroupListRow[]): string {
  const { label } = scope;
  const headerCell = (classes: string, key: string): string =>
    `${nl(6)}<th${classes === '' ? '' : ` class="${classes}"`}>${nl(7)}${label(key)}${nl(6)}</th>`;
  return [
    `${nl(3)}<table id="temp" class="table table-striped table-condensed table-bordered mura-table-grid">`,
    `${nl(0)}${nl(4)}<thead>${nl(5)}<tr>${nl(6)}<th class="actions"></th>`,
    headerCell('var-width', 'user.grouptotalmembers'),
    headerCell('', 'user.groupemail'),
    headerCell('', 'user.datelastupdate'),
    headerCell('', 'user.timelastupdate'),
    headerCell('', 'user.lastupdatedby'),
    `${nl(5)}</tr>${nl(4)}</thead>${nl(0)}${nl(4)}<tbody>${nl(5)}`,
    ...rows.map((row) => renderRow(scope, row)),
    `${nl(4)}</tbody>${nl(0)}${nl(3)}</table>${nl(0)}${nl(3)}`,
  ].join('');
}

/** The member and system group tabs of an admin; `rc.ispublic` marks the active one. */
function renderTabs({ rc, label, url }: RowScope): string {
  const tab = (ispublic: 0 | 1, key: string): string =>
    `${nl(6)}<li${isPublicEq(rc.ispublic, ispublic) ? ' class="active"' : ''}>` +
    `${nl(7)}<a href="${url('cusers.list', `ispublic=${ispublic}`)}" onclick="actionModal();">` +
    `${nl(8)}${label(key)}${nl(7)}</a>${nl(6)}</li>${nl(0)}`;
  return [
    `${nl(0)}${nl(4)}<ul id="viewTabs" class="mura-tab-links nav-tabs">${nl(0)}${nl(5)}`,
    tab(1, 'user.membergroups'),
    `${nl(5)}`,
    tab(0, 'user.adminusergroups'),
    `${nl(4)}</ul>${nl(0)}${nl(2)}`,
  ].join('');
}

/** The view body: the Users & Groups header, the tabs or heading, and the group table with paging or the empty message. */
export async function renderGroupList(ctx: ScreenContext, data: GroupListData): Promise<ShellView> {
  const { rc, rows, nextn, pageIndex } = data;
  const ses = { ses: ctx.req.ses };
  const scope: RowScope = {
    ctx,
    rc,
    label: (key) => ctx.rb.rbKey(key),
    // FW/1 emits buildURL results unencoded; only the values the view encodes are encoded.
    url: (action, queryString) => buildUrl(action, undefined, queryString, ses),
  };
  const { label } = scope;
  const admin = isCusersAdmin(ctx.req);
  // The delete links' CSRF pairs come from identity before the synchronous render.
  await ctx.csrf.prefetch(rows.filter(isDeletable).map((row) => row.UserID));

  const title = label(admin ? 'user.groups' : 'user.membergroups');
  const listing =
    rows.length === 0
      ? `${nl(0)}${nl(3)}${nl(3)}<div class="help-block-empty">${label('user.nogroups')}</div>${nl(0)}${nl(2)}`
      : renderTable(scope, rows) + renderNextN({ nextn, pageIndex, rc, muraAction: ctx.req.action, rb: ctx.rb }).value;
  const view = [
    `${nl(0)}${nl(0)}<div class="block block-constrain">${nl(0)}${nl(1)}${nl(2)}`,
    admin ? renderTabs(scope) : `${nl(3)}<h3>${label('user.membergroups')}</h3>${nl(2)}`,
    `${nl(1)}${nl(0)}${nl(1)}<div class="block-content tab-content">`,
    `${nl(0)}${nl(2)}<!-- start tab -->${nl(2)}<div class="tab-pane active">`,
    `${nl(0)}${nl(3)}<div class="block block-bordered">${nl(4)}<!-- block header -->${nl(4)}<div class="block-header">`,
    `${nl(5)}<h3 class="block-title">${nl(6)}${title}${cfSpace(title)}${nl(5)}</h3>`,
    `${nl(4)}</div> <!-- /.block header -->${nl(4)}<div class="block-content">${nl(0)}${nl(1)}${nl(2)}`,
    listing,
    `${nl(0)}${nl(5)}</div> <!-- /.block-content -->${nl(4)}</div> <!-- /.block-bordered -->`,
    `${nl(3)}</div> <!-- /.tab-pane -->${nl(0)}${nl(1)}</div> <!-- /.block-content.tab-content -->`,
    `${nl(0)}</div> <!-- /.block-constrain -->${nl(0)}${nl(0)}`,
  ].join('');
  return { body: join([renderUsersHeader(ctx, rc), raw(view)]) };
}

/** `cUsers.list`, owned by people, behind the cUsers `before()` gate. */
export const listScreen: PageScreen<GroupListData> = Object.freeze({
  circuit: 'cusers',
  action: 'list',
  owner: 'people',
  mode: 'page',
  gate: cusersGate,
  load: loadGroupList,
  render: renderGroupList,
});
