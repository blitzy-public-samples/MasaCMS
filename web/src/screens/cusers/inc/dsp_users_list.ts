// cUsers `inc/dsp_users_list.cfm`: the users table of the user lists, searches and group members, or its empty message (server-only).
import { cfEq, cfLsDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { encodeHtml, encodeUrl, join, raw, type SafeHtml } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { ScreenContext } from '../../registry';
import { isCusersAdmin, type CusersRc } from '../gate';
import { renderNextN, type NextN } from './dsp_nextn';

// The markup is the include's bytes as ACF 2023 emits them after the caller's indentation, matched against legacy
// captures: CFML comments are dropped and the text around them joins, and whitespace-only text between two CFML
// constructs prints one space after output that ends in non-whitespace, else nothing.

/** One user of `rc.it`, by its `getValue` names. */
export interface UsersListRow {
  userid: string;
  ispublic: number | string;
  s2: number | string;
  lname: string;
  fname: string;
  email: string;
  lastupdate: string | Date | null;
  lastupdateby: string;
}

/** What the include reads from `rc`. */
export interface UsersListInput {
  /** The current page's rows of `rc.it`; absent where legacy leaves `rc.it` undefined. */
  rows?: readonly UsersListRow[];
  /** `rc.nextn`, absent where legacy leaves it undefined. */
  nextn?: NextN;
  /** The iterator's page index, from `legacyPageIndex`. */
  pageIndex: number;
  /** `rc.listUnassignedUsers`: a comma list of user ids. */
  listUnassignedUsers?: string;
  /** `rc.noUsersMessage`; without one the empty list shows `user.nousers`. */
  noUsersMessage?: string;
  /** `rc.muraAction` as FW/1 sets it, e.g. `core:cusers.editgroupmembers`. */
  muraAction: string;
  rc: Pick<CusersRc, 'siteid' | 'userid' | 'ispublic' | 'unassigned' | 'recordsperpage'>;
}

/** The parts of the screen context the include reads. */
export type UsersListContext = Pick<ScreenContext, 'req' | 'csrf' | 'rb'>;

/** A line break followed by `depth` tabs of legacy indentation. */
const nl = (depth: number): string => `\n${'\t'.repeat(depth)}`;

/** What a whitespace-only text run prints after `output`: one space after non-whitespace (char > U+0020), else nothing. */
const cfSpace = (output: string): string => (output === '' || output.charCodeAt(output.length - 1) <= 0x20 ? '' : ' ');

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\f': '\\f',
  '\b': '\\b',
};

/** CFML `JSStringFormat`: backslash, both quotes and the control escapes; every other character passes unchanged. */
function jsStringFormat(value: string): string {
  return value.replace(/[\\"'\n\r\t\f\b]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);
}

/** CFML `listFindNoCase(list, value) > 0` over a comma list, whose empty elements are skipped. */
function listFindNoCase(list: string, value: string): boolean {
  const wanted = value.toLowerCase();
  return list.split(',').some((item) => item !== '' && item.toLowerCase() === wanted);
}

/** CFML `listLast(list, '.')`, whose empty elements are skipped. */
const listLastDot = (list: string): string => list.split('.').filter((item) => item !== '').at(-1) ?? '';

/** `local.canEdit`: an Admin-group member or S2, or any user on a member (`isPublic == 1`) row. */
const canEditRow = (admin: boolean, row: UsersListRow): boolean => admin || cfEq(String(row.ispublic), '1');

/** `lastupdate` as a date: null when empty; ACF's error for a value it cannot read. */
function lastUpdateOf(value: UsersListRow['lastupdate']): Date | null {
  if (value === null || value === '') return null;
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${String(value)} cannot be converted to a date.`);
  return date;
}

/** One `<th>` of the header with its label as written. */
const headerCell = (classes: string, label: string): string =>
  `${nl(6)}<th${classes === '' ? '' : ` class="${classes}"`}>${nl(7)}${label}${nl(6)}</th>`;

/** The table up to the first row, ending with the whitespace the loop's opening tag leaves. */
function renderHead(rbKey: (key: string) => string): string {
  return [
    `${nl(0)}${nl(3)}<table id="tbl-users" class="table table-striped table-condensed table-bordered mura-table-grid">`,
    `${nl(0)}${nl(4)}<thead>${nl(5)}<tr>`,
    `${nl(6)}<th class="actions"></th>${nl(6)}<th class="actions"></th>`,
    headerCell('var-width', rbKey('user.user')),
    headerCell('', rbKey('user.email')),
    headerCell('hidden-xs', rbKey('user.datelastupdate')),
    headerCell('hidden-xs hidden-sm', rbKey('user.timelastupdate')),
    headerCell('hidden-xs', rbKey('user.lastupdatedby')),
    `${nl(5)}</tr>${nl(4)}</thead>${nl(0)}${nl(4)}<tbody>${nl(0)}${nl(5)}${nl(6)}`,
  ].join('');
}

/** The include's row state shared by every row of one render. */
interface RowScope {
  readonly ctx: UsersListContext;
  readonly input: UsersListInput;
  /** `currentUser().isInGroup('Admin') || isSuperUser()`. */
  readonly admin: boolean;
  /** The view is `cusers.editgroupmembers`, which adds the remove-from-group link. */
  readonly removable: boolean;
}

/** The actions menu items of `row`: edit and delete when it is editable, remove on the group members view. */
function renderActionItems({ ctx, input, admin, removable }: RowScope, row: UsersListRow, editUrl: string): string {
  const { rb, req } = ctx;
  const siteid = encodeUrl(input.rc.siteid);
  const ses = { ses: req.ses };
  const canEdit = canEditRow(admin, row);
  let items = '';
  if (canEdit) {
    items += `${nl(14)}<li>${nl(15)}<a href="${editUrl}" rel="tooltip" onclick="actionModal(); window.location=this.href;">`;
    items += `${nl(16)}<i class="mi-pencil"></i>${rb.rbKey('user.edit')}${nl(15)}</a>${nl(14)}</li>${nl(14)}${nl(13)}`;
  }
  if (removable) {
    const groupid = encodeUrl(input.rc.userid);
    const url = buildUrl(
      'cusers.removefromgroup',
      undefined,
      `userid=${row.userid}&routeid=${groupid}&groupid=${groupid}&siteid=${siteid}`,
      ses,
    );
    const label = rb.rbKey('user.removeconfirm');
    items += `${nl(14)}<li class="remove">${nl(15)}<a href="${url}" onclick="return confirmDialog('${jsStringFormat(label)}',this.href)" rel="tooltip">`;
    items += `${nl(16)}<i class="mi-minus-circle"></i>${label}${nl(15)}</a>${nl(14)}</li>${nl(13)}`;
  }
  if (canEdit) {
    // `type=1` is the group type; legacy sends it for users too.
    const csrf = ctx.csrf.render(row.userid, 'url').value;
    const query = `action=delete&ispublic=${String(row.ispublic)}&userid=${row.userid}&siteid=${siteid}&type=1${csrf}`;
    const confirm = jsStringFormat(rb.rbKey('user.deleteuserconfirm'));
    items += `${nl(14)}<li class="delete">${nl(15)}<a href="${buildUrl('cusers.update', undefined, query, ses)}" onclick="return confirmDialog('${confirm}',this.href)" rel="tooltip">`;
    items += `${nl(16)}<i class="mi-trash"></i>${rb.rbKey('user.delete')}${nl(15)}</a>${nl(14)}</li>${nl(14)}${nl(13)}`;
  }
  return items;
}

/** One status icon item: its tooltip title as written and its icon class. */
const iconItem = (title: string, icon: string): string =>
  `${nl(12)}<li>${nl(13)}<a rel="tooltip" title="${title}">${nl(14)}<i class="${icon}"></i>${nl(13)}</a>${nl(12)}</li>${nl(11)}`;

/** The status icons of `row`: unassigned (a literal title in legacy), then super user, system user or site member. */
function renderIcons({ ctx, input }: RowScope, row: UsersListRow): string {
  const { rb } = ctx;
  const unassigned =
    input.listUnassignedUsers !== undefined && listFindNoCase(input.listUnassignedUsers, row.userid)
      ? iconItem('Unassigned', 'mi-exclamation')
      : '';
  if (cfEq(String(row.s2), '1')) return unassigned + iconItem(rb.rbKey('user.superuser'), 'mi-star');
  if (cfEq(String(row.ispublic), '0')) return unassigned + iconItem(rb.rbKey('user.adminuser'), 'mi-user');
  return unassigned + iconItem(rb.rbKey('user.sitemember'), 'mi-user');
}

/** One `<tr>` of the loop, with the whitespace the loop body leaves after it. */
function renderRow(scope: RowScope, row: UsersListRow): string {
  const { req } = scope.ctx;
  const editUrl = buildUrl(
    'cusers.edituser',
    undefined,
    `userid=${row.userid}&siteid=${encodeUrl(scope.input.rc.siteid)}`,
    { ses: req.ses },
  );
  const name = `${encodeHtml(row.lname)}, ${encodeHtml(row.fname)}`;
  const nameCell = canEditRow(scope.admin, row)
    ? `${nl(11)}<a href="${editUrl}" onclick="actionModal();">${nl(12)}${name}${nl(11)}</a>${nl(10)}`
    : name + cfSpace(name);
  const emailCell =
    row.email.length > 0
      ? `${nl(11)}<a href="mailto:${encodeUrl(row.email)}">${nl(12)}${encodeHtml(row.email)}${nl(11)}</a>${nl(10)}`
      : `${nl(11)}&nbsp;${nl(10)}`;
  // Plain LS formats under the session locale (not formatDateField, whose datetimeselector rule blanks far-future
  // dates); session.dateKeyFormat's `DD` prints the day of the year (11/317/2026), as legacy shows it.
  const lastUpdate = lastUpdateOf(row.lastupdate);
  const date = lastUpdate === null ? '' : cfLsDateFormat(lastUpdate, req.session.dateKeyFormat, req.session.locale);
  const time = lastUpdate === null ? '' : cfLsTimeFormat(lastUpdate, 'short', req.session.locale);
  return [
    `${nl(7)}<tr>${nl(0)}${nl(8)}${nl(9)}<td class="actions">`,
    `${nl(10)}<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>`,
    `${nl(10)}<div class="actions-menu hide">${nl(11)}<ul class="actions-list">${nl(0)}${nl(12)}${nl(13)}`,
    renderActionItems(scope, row, editUrl),
    `${nl(0)}${nl(10)}</ul>${nl(10)}</div>${nl(9)}</td>${nl(8)}${nl(0)}${nl(8)}`,
    `${nl(9)}<td class="actions">${nl(10)}<ul>${nl(11)}${renderIcons(scope, row)}${nl(10)}</ul>${nl(9)}</td>${nl(8)}${nl(0)}${nl(8)}`,
    `${nl(9)}<td class="var-width">${nl(10)}${nameCell}${nl(9)}</td>${nl(0)}${nl(8)}`,
    `${nl(9)}<td>${nl(10)}${emailCell}${nl(9)}</td>${nl(0)}${nl(8)}`,
    `${nl(9)}<td class="hidden-xs">${nl(10)}${date}${nl(9)}</td>${nl(0)}${nl(8)}`,
    `${nl(9)}<td class="hidden-xs hidden-sm">${nl(10)}${time}${nl(9)}</td>${nl(0)}${nl(8)}`,
    `${nl(9)}<td class="hidden-xs">${nl(10)}${encodeHtml(row.lastupdateby)}${nl(9)}</td>${nl(0)}${nl(7)}</tr>${nl(6)}`,
  ].join('');
}

/** The empty-list message: `rc.noUsersMessage` HTML-encoded, else `user.nousers` as written. */
function renderEmpty(ctx: UsersListContext, noUsersMessage: string | undefined): string {
  const message = noUsersMessage !== undefined ? encodeHtml(noUsersMessage) : ctx.rb.rbKey('user.nousers');
  return `${nl(0)}${nl(3)}${nl(4)}<div class="help-block-empty">${nl(5)}${message}${cfSpace(message)}${nl(4)}</div>${nl(0)}${nl(2)}`;
}

/**
 * The include's output: nothing without `rows`, the empty-list message for no rows, else the table and `dsp_nextn`.
 * Async because the delete links' CSRF tokens are first fetched from identity; gateway unavailability propagates.
 */
export async function renderUsersList(ctx: UsersListContext, input: UsersListInput): Promise<SafeHtml> {
  const { rows } = input;
  if (rows === undefined) return raw('');
  if (rows.length === 0) return raw(renderEmpty(ctx, input.noUsersMessage));
  // The site-admin role is Admin-group membership in the site's private pool; public-pool Admin groups grant none.
  const admin = isCusersAdmin(ctx.req);
  await ctx.csrf.prefetch(rows.filter((row) => canEditRow(admin, row)).map((row) => row.userid));
  const scope: RowScope = { ctx, input, admin, removable: cfEq(listLastDot(input.muraAction), 'editgroupmembers') };
  const table = `${renderHead((key) => ctx.rb.rbKey(key))}${rows.map((row) => renderRow(scope, row)).join('')}`;
  const { nextn, pageIndex, rc, muraAction } = input;
  return join([
    raw(`${table}${nl(0)}${nl(4)}</tbody>${nl(3)}</table>${nl(0)}${nl(3)}`),
    renderNextN({ nextn, pageIndex, rc, muraAction, rb: ctx.rb }),
  ]);
}
