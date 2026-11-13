// `cUsers.search`: the controller's `search()` and the results view of `admin/core/views/cusers/search.cfm` (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import {
  okBody,
  type GatewayClient,
  type OperationOf,
  type QueryOf,
  type ServiceFacade,
  type SuccessBodyOf,
} from '@/lib/gateway-client';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { renderSearchForm } from './inc/dsp_search_form';
import { renderUsersList, type UsersListInput, type UsersListRow } from './inc/dsp_users_list';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the text around them joins. `\x20` is a trailing space legacy leaves at a line end.

type PeoplePaths = GatewayClient['people'] extends ServiceFacade<infer Paths> ? Paths : never;
type SearchUsersOperation = OperationOf<PeoplePaths['/v1/users/search'], 'get'>;

/** Query of people `searchUsers`. */
export type SearchUsersQuery = QueryOf<SearchUsersOperation>;

/** People's `searchUsers` answer: every match, the paging state and the unassigned ids. */
export type SearchUsersPage = SuccessBodyOf<SearchUsersOperation>;

type SearchUserRow = SearchUsersPage['items'][number];

type NextN = NonNullable<UsersListInput['nextn']>;

/** Everything the view reads after `search()`. */
export interface SearchData {
  readonly rc: CusersRc;
  /** The rows `rc.it` iterates on its current page. */
  readonly rows: readonly UsersListRow[];
  readonly nextn: NextN;
  /** The iterator's page index after `setPage(rc.nextn.startrow)`. */
  readonly pageIndex: number;
  /** `rc.listUnassignedUsers`: `ValueList` of the unassigned user ids. */
  readonly listUnassignedUsers: string;
  /** `rc.noUsersMessage`. */
  readonly noUsersMessage: string;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<SearchData>['render']>>;

/** `rc.nextn` in the camel case the cUsers includes read. */
function nextNOf(nextn: SearchUsersPage['nextn']): NextN {
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

// dsp_nextn's `legacyPageIndex` computes the same index; this screen keeps to its declared dependencies.
/**
 * The userIterator page after `setNextN(rpp)`, `setStartRow(startrow)` and `setPage(startrow)`: page `startrow`, or 1
 * when its first row lies past the last record; its rows are those from `(page-1)*rpp` up to the page's end.
 */
function iteratorPage<T>(items: readonly T[], nextn: NextN): { pageIndex: number; rows: readonly T[] } {
  const { startRow, recordsPerPage } = nextn;
  const pageIndex = (startRow - 1) * recordsPerPage > items.length ? 1 : startRow;
  const first = (pageIndex - 1) * recordsPerPage;
  return { pageIndex, rows: items.slice(first, first + recordsPerPage) };
}

/** One person row as `rc.it` hands it to the users list; a null column reads as CFML's empty string. */
function usersListRow(row: SearchUserRow): UsersListRow {
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

/**
 * `search()`: people's `getSearch` page with its unassigned ids, and the no-results message.
 * @throws GatewayUnavailableError When people is unavailable; the handler answers the legacy 503.
 * @throws GatewayDenialError When people answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadSearch(ctx: ScreenContext): Promise<SearchData> {
  const rc = normaliseCusersRc(ctx.req);
  const query: SearchUsersQuery = {
    siteid: rc.siteid,
    ispublic: rc.ispublic,
    search: rc.search,
    startrow: String(rc.startRow),
    recordsperpage: String(rc.recordsperpage),
  };
  const page = okBody(await ctx.gateway.people.call('get', '/v1/users/search', { query }), 'people', 'searchUsers');
  const nextn = nextNOf(page.nextn);
  const { pageIndex, rows } = iteratorPage(page.items, nextn);
  return {
    rc,
    rows: rows.map(usersListRow),
    nextn,
    pageIndex,
    listUnassignedUsers: page.listUnassignedUsers.join(','),
    noUsersMessage: ctx.rb.rbKey('user.nosearchresults'),
  };
}

/** One view link: FW/1 `buildURL` with its default path, since the view passes none, emitted unencoded. */
type UrlBuilder = (action: string, queryString: string) => SafeHtml;

/** A label as the view prints it, unencoded. */
type LabelOf = (key: string) => SafeHtml;

/** The `mura-header`: title, the add and list buttons (without the users header's `actionModal`), and the search form. */
function renderHeader(ctx: ScreenContext, rc: CusersRc, label: LabelOf, url: UrlBuilder): SafeHtml {
  const siteQuery = `siteid=${encodeUrl(rc.siteid)}`;
  return html`


\t
<div class="mura-header">
\t<h1>${label('user.usersearchresults')}</h1>

\t
\t\t<div class="nav-module-specific btn-group">

\t\t\t
\t\t\t\t<a class="btn" href="${url('cusers.edituser', `${siteQuery}&userid=`)}">
\t\t\t\t\t<i class="mi-plus-circle"></i>\x20
\t\t\t\t\t${label('user.adduser')}
\t\t\t\t</a>

\t\t \x20
\t\t\t\t<a class="btn" href="${url('cusers.editgroup', `${siteQuery}&userid=`)}">
\t\t\t\t\t<i class="mi-plus-circle"></i>\x20
\t\t\t\t\t${label('user.addgroup')}
\t\t\t\t</a>

\t\t\t
\t\t\t\t<a class="btn" href="${url('cusers.default', siteQuery)}">
\t\t\t\t\t<i class="mi-users"></i>
\t\t\t\t\t${label('user.viewgroups')}
\t\t\t\t</a>

\t\t\t
\t\t\t\t<a class="btn" href="${url('cusers.listUsers', siteQuery)}">
\t\t\t\t\t<i class="mi-user"></i>
\t\t\t\t\t${label('user.viewusers')}
\t\t\t\t</a>

\t\t</div>
\t

\t<div class="mura-item-metadata">

\t
\t${renderSearchForm({ rc, search: rc.search, rb: ctx.rb })}

\t</div><!-- /.mura-item-metadata -->
</div> <!-- /.mura-header -->

<div class="block block-constrain">


 \x20`;
}

const activeClass = (active: boolean): SafeHtml => (active ? html` class="active"` : html``);

/** Admin and S2 view: the Site Members and System Users tabs, then the list in a bordered block titled by `ispublic`. */
function renderTabbed(rc: CusersRc, label: LabelOf, url: UrlBuilder, list: SafeHtml): SafeHtml {
  const tabQuery = (ispublic: string): string =>
    `siteid=${encodeUrl(rc.siteid)}&ispublic=${ispublic}&search=${encodeUrl(rc.search)}`;
  const members = cfEq(rc.ispublic, '1');
  return html`

      <ul class="mura-tab-links nav-tabs">

       \x20
          <li${activeClass(members)}>
            <a href="${url('cusers.search', tabQuery('1'))}">
              ${label('user.sitemembers')}
            </a>
          </li>

       \x20
          <li${activeClass(cfEq(rc.ispublic, '0'))}>
            <a href="${url('cusers.search', tabQuery('0'))}">
              ${label('user.systemusers')}
            </a>
          </li>

      </ul>
\t\t\t<div class="block-content tab-content">

\t\t\t<!-- start tab -->
\t\t\t<div id="tab1" class="tab-pane active">
\t\t\t\t<div class="block block-bordered">
\t\t\t\t\t<!-- block header -->\t\t\t\t\t
\t\t\t\t\t<div class="block-header">
\t\t\t\t\t\t<h3 class="block-title">${label(members ? 'user.sitemembers' : 'user.systemusers')}</h3>
\t\t\t\t\t</div> <!-- /.block header -->\t\t\t\t\t\t
\t\t\t\t\t<div class="block-content">
\t\t\t\t\t\t \x20\t
\t\t\t\t\t\t${list}

\t\t\t\t\t</div> <!-- /.block-content -->
\t\t\t\t</div> <!-- /.block-bordered -->
\t\t\t</div> <!-- /.tab-pane -->

\t\t</div> <!-- /.block-content.tab-content -->
 \x20`;
}

/** Other users' view: the list in a bordered block headed Site Members. */
function renderUntabbed(label: LabelOf, list: SafeHtml): SafeHtml {
  return html`
\t\t<div class="block block-bordered">
\t\t  <div class="block-content">
\t\t    <h3>${label('user.sitemembers')}</h3>
\t\t\t\t${list}
\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
 \x20`;
}

/**
 * The view body inside `#mura-content`.
 * Async because the users list first fetches its delete links' CSRF tokens from identity; unavailability propagates.
 */
export async function renderSearch(ctx: ScreenContext, data: SearchData): Promise<ShellView> {
  const { rc } = data;
  const label: LabelOf = (key) => raw(ctx.rb.rbKey(key));
  const url: UrlBuilder = (action, queryString) =>
    raw(buildUrl(action, undefined, queryString, { ses: ctx.req.ses }));
  const list = await renderUsersList(ctx, {
    rows: data.rows,
    nextn: data.nextn,
    pageIndex: data.pageIndex,
    listUnassignedUsers: data.listUnassignedUsers,
    noUsersMessage: data.noUsersMessage,
    muraAction: ctx.req.action,
    rc,
  });
  const results = rc.isAdmin ? renderTabbed(rc, label, url, list) : renderUntabbed(label, list);
  const body = html`${renderHeader(ctx, rc, label, url)}${results}



</div> <!-- /.block-constrain -->
`;
  return { body };
}

/** `cUsers.search`, owned by people, behind the cUsers `before()` gate. */
export const searchScreen: PageScreen<SearchData> = Object.freeze({
  circuit: 'cusers',
  action: 'search',
  owner: 'people',
  mode: 'page',
  gate: cusersGate,
  load: loadSearch,
  render: renderSearch,
});
