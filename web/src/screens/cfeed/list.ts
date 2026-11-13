// `cFeed.list`: the Collections list of `admin/core/views/cfeed/list.cfm` over strategies-content (server-only).
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { applyCfeedDefaults, cfeedGate } from './before';
import { cfTruthy, feedApiEndpoint, yesNoFormat, type CfFlag } from './common';
import { renderCfeedSecondaryMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'listFeeds';

/** A query row or the screen model as JSON carries it; keys match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** The `feedManager.getFeeds` columns one list row reads, as CFML outputs them. */
export interface CfeedListRow {
  readonly feedId: string;
  readonly name: string;
  readonly lang: string;
  readonly maxItems: string;
  readonly isFeaturesOnly: CfFlag;
  readonly restricted: CfFlag;
  readonly isActive: CfFlag;
  readonly channelLink: string;
}

/** `rc.rsLocal`, `rc.rsRemote` and the feed API endpoint of the view, rows in the service's name order. */
export interface CfeedListData {
  readonly local: readonly CfeedListRow[];
  readonly remote: readonly CfeedListRow[];
  readonly endpoint: string;
}

/** A struct value by case-insensitive key; undefined when absent. */
function structValue(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple cell value; complex values throw, as CFML output of one does. */
function cellValue(row: Struct, column: string): string | number | boolean | null | undefined {
  const value = structValue(row, column);
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new TypeError(`${OPERATION} returned a feed whose ${column} is not a simple value`);
}

/** A cell as `#query.column#` prints it; SQL NULL prints `''`. */
function cellText(row: Struct, column: string): string {
  const value = cellValue(row, column);
  return value === undefined || value === null ? '' : String(value);
}

/** The list row of one query entry. */
function feedRowOf(entry: unknown, query: string): CfeedListRow {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${OPERATION} returned an rc.${query} row that is not a struct`);
  }
  const row = entry as Struct;
  return {
    feedId: cellText(row, 'feedID'),
    name: cellText(row, 'name'),
    lang: cellText(row, 'lang'),
    maxItems: cellText(row, 'maxItems'),
    isFeaturesOnly: cellValue(row, 'isFeaturesOnly'),
    restricted: cellValue(row, 'restricted'),
    isActive: cellValue(row, 'isActive'),
    channelLink: cellText(row, 'channelLink'),
  };
}

/** The rows of the query `rc[query]`. */
function feedRowsOf(rc: Struct, query: string): CfeedListRow[] {
  const entries = structValue(rc, query);
  if (!Array.isArray(entries)) throw new TypeError(`${OPERATION} returned no rc.${query} array`);
  return entries.map((entry) => feedRowOf(entry, query));
}

/**
 * cfeed `before()` defaults, then the site's Local and Remote collections with their delete tokens prefetched.
 * Gateway unavailability propagates.
 * @throws GatewayDenialError When strategies-content refuses the read (401 or 403).
 * @throws TypeError When the screen model lacks `rsLocal` or `rsRemote` rows.
 */
export async function loadFeedList(ctx: ScreenContext): Promise<CfeedListData> {
  ctx.req = { ...ctx.req, rc: applyCfeedDefaults(ctx.req.rc) };
  const siteid = ctx.req.rc.siteid ?? '';
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/feeds', { params: { siteid } });
  const rc: Struct = okBody(response, SERVICE, OPERATION).rc;
  const local = feedRowsOf(rc, 'rsLocal');
  const remote = feedRowsOf(rc, 'rsRemote');
  // The view reads the endpoint before either table, so it is settled even when no Local row links to it.
  const endpoint = feedApiEndpoint(ctx.req, structValue(rc, 'endpoint'));
  await ctx.csrf.prefetch([...local, ...remote].map((feed) => feed.feedId));
  return { local, remote, endpoint };
}

/** Bundle labels of `session.rb`, unencoded as legacy emits them. */
type Label = (key: string) => SafeHtml;

/** The values every row of both tables repeats. */
interface RowShared {
  readonly ctx: ScreenContext;
  readonly label: Label;
  /** `esapiEncode('url', rc.siteid)`. */
  readonly siteid: SafeHtml;
}

/** The `collections.yes`/`collections.no` label of a flag, keyed by its `yesNoFormat`. */
function flagLabel(label: Label, value: CfFlag): SafeHtml {
  return label(`collections.${yesNoFormat(value).toLowerCase()}`);
}

/** The `<cfif>` icon of a flag cell, with the whitespace both of its branches emit. */
function flagIcon(label: Label, value: CfFlag): SafeHtml {
  const icon = cfTruthy(value) ? 'mi-check' : 'mi-ban';
  return html`
\t\t\t\t\t\t\t\t<i class="${icon}" title="${flagLabel(label, value)}"></i>
\t\t\t\t`;
}

/** A Local flag cell; `indent` is the indentation of its `<cfif>` line. */
function flagCell(label: Label, value: CfFlag, indent: SafeHtml): SafeHtml {
  return html`
\t\t\t<td>
${indent}${flagIcon(label, value)}
\t\t\t\t<span>${flagLabel(label, value)}</span>
\t\t\t</td>`;
}

/** The delete link of a row; legacy interpolates the feed id unencoded and confirms with the JS-encoded label. */
function deleteItem({ ctx, label, siteid }: RowShared, feedId: string, confirmKey: string): SafeHtml {
  const id = raw(feedId);
  const confirm = raw(encodeJs(ctx.rb.rbKey(confirmKey)));
  return html`<li class="delete"><a href="./?muraAction=cFeed.update&action=delete&feedID=${id}&siteid=${siteid}${ctx.csrf.render(feedId, 'url')}" onclick="return confirmDialog('${confirm}',this.href)"><i class="mi-trash"></i>${label('collections.delete')}</a></li>`;
}

/** One Local index row. */
function localRow(shared: RowShared, endpoint: SafeHtml, feed: CfeedListRow): SafeHtml {
  const { label, siteid } = shared;
  const id = raw(feed.feedId);
  const editHref = html`./?muraAction=cFeed.edit&feedID=${id}&siteid=${siteid}&type=Local`;
  const cfifIndent = raw('\t\t\t\t');
  return html`
\t\t<tr>
\t\t\t<td class="actions">
\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t<li class="edit"><a href="${editHref}"><i class="mi-pencil"></i>${label('collections.edit')}</a></li>
\t\t\t\t\t\t<li class="rss"><a href="${endpoint}/?feedID=${id}" target="_blank"><i class="mi-rss"></i>${label('collections.viewrss')}</a></li>
\t\t\t\t\t\t${deleteItem(shared, feed.feedId, 'collections.deletelocalconfirm')}
\t\t\t\t\t</ul>
\t\t\t\t</div>
\t\t\t</td>
\t\t\t<td class="var-width"><a title="Edit" href="${editHref}">${raw(encodeHtml(feed.name))}</a></td>
\t\t\t<td class="hidden-xs">${raw(feed.lang)}</td>
\t\t\t<td class="hidden-xs">${raw(feed.maxItems)}</td>${flagCell(label, feed.isFeaturesOnly, cfifIndent)}${flagCell(label, feed.restricted, cfifIndent)}${flagCell(label, feed.isActive, raw('\t\t\t'))}
\t\t</tr>`;
}

/** One Remote feed row; the URL cell is `left(channelLink, 70)`, the Active cell the bare `yesNoFormat`. */
function remoteRow(shared: RowShared, feed: CfeedListRow): SafeHtml {
  const { label, siteid } = shared;
  const id = raw(feed.feedId);
  const editHref = html`./?muraAction=cFeed.edit&feedID=${id}&siteid=${siteid}&type=Remote`;
  // The import item's line carries three trailing tabs in the view.
  return html`
\t<tr>
\t\t<td class="actions">
\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t<div class="actions-menu hide">
\t\t\t<ul class="actions-list">
\t\t\t\t<li class="edit"><a href="${editHref}"><i class="mi-pencil"></i>${label('collections.edit')}</a></li>
\t\t\t\t<li class="rss"><a href="${raw(feed.channelLink)}" target="_blank"><i class="mi-rss"></i>${label('collections.viewfeed')}</a></li>
\t\t\t\t<li class="import"><a href="./?muraAction=cFeed.import1&feedID=${id}&siteid=${siteid}"><i class="mi-sign-in"></i>${label('collections.import')}</a></li>\t\t\t
\t\t\t\t${deleteItem(shared, feed.feedId, 'collections.deleteremoteconfirm')}
\t\t</ul>
\t\t</div>
\t\t</td>
\t\t<td class="var-width"><a title="${label('collections.edit')}" href="${editHref}">${raw(encodeHtml(feed.name))}</a></td>
\t\t<td class="url var-width">${raw(feed.channelLink.slice(0, 70))}</td>
\t\t<td>${raw(yesNoFormat(feed.isActive))}</td>
\t</tr>`;
}

/** The `<cfelse>` notice of an empty query. */
function emptyNotice(label: Label, key: string): SafeHtml {
  return html`
\t\t<div class="help-block-empty">${label(key)}</div>
\t`;
}

/** The Local indexes panel content: the table, or the empty notice. */
function localPanel(shared: RowShared, data: CfeedListData): SafeHtml {
  const { label } = shared;
  if (data.local.length === 0) return emptyNotice(label, 'collections.nolocalindexes');
  const endpoint = raw(data.endpoint);
  return html`
\t<table class="mura-table-grid">
\t\t<tr>
\t\t<th class="actions"></th>
\t\t<th class="var-width">${label('collections.index')}</th>
\t\t<th class="hidden-xs">${label('collections.language')}</th>
\t\t<th class="hidden-xs">${label('collections.maxitems')}</th>
\t\t<th>${label('collections.featuresonly')}</th>
\t\t<th>${label('collections.restricted')}</th>
\t\t<th>${label('collections.active')}</th>
\t\t</tr>
\t\t${data.local.map((feed) => localRow(shared, endpoint, feed))}
\t</table>
\t`;
}

/** The Remote feeds panel content: the table, or the empty notice. */
function remotePanel(shared: RowShared, data: CfeedListData): SafeHtml {
  const { label } = shared;
  if (data.remote.length === 0) return emptyNotice(label, 'collections.noremotefeeds');
  return html`
\t<table class="mura-table-grid">
\t<tr>
\t<th class="actions"></th>
\t<th class="var-width">${label('collections.feed')}</th>
\t<th class="url var-width">${label('collections.url')}</th>
\t<th>${label('collections.active')}</th>
\t</tr>
\t${data.remote.map((feed) => remoteRow(shared, feed))}
\t</table>
\t`;
}

/** The list view body: the header with the list menu, then the Local and Remote panels. */
export function renderFeedList(ctx: ScreenContext, data: CfeedListData): ShellView {
  const label: Label = (key) => raw(ctx.rb.rbKey(key));
  const shared: RowShared = { ctx, label, siteid: raw(encodeUrl(ctx.req.rc.siteid ?? '')) };
  const menu = renderCfeedSecondaryMenu(ctx.req, ctx.rb, { fuseaction: 'list' });
  // ACF prints the view's tag-free text as written; the leading `<cfset>` line and the final newline print nothing.
  const body = html`
<div class="mura-header">
\t<h1>${label('collections')}</h1>
\t
\t${menu}

</div> <!-- /.mura-header -->



<div class="block block-constrain">
\t\t<div class="block block-bordered">
\t\t  <div class="block-content">
\t<h2>${label('collections.localcontentindexes')}</h2>
\t${localPanel(shared, data)}
\t</div><!-- /.block-content -->

\t\t\t<div class="block-content">
\t<h2>${label('collections.remotecontentfeeds')}</h2>
\t${remotePanel(shared, data)}
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

`;
  return { body };
}

/** `cfeed.list`: the site's collections inside the shell. */
export const cfeedListScreen: PageScreen<CfeedListData> = {
  circuit: 'cfeed',
  action: 'list',
  mode: 'page',
  owner: 'strategies-content',
  gate: cfeedGate,
  secondaryMenu: 'cfeed',
  load: loadFeedList,
  render: renderFeedList,
};
