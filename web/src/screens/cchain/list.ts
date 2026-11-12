// `cchain.list`: the Approval Chains list of `admin/core/views/cchain/list.cfm` over strategies-content (server-only).
import { cfLsDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminSessionState } from '@/lib/request-context';
import type { ShellView } from '@/shell/types';
import type { ScreenContext } from '../registry';
import { renderCchainSecondaryMenu } from './dsp_secondary_menu';
import { renderCchainJs } from './js';

const SERVICE = 'strategies-content';
const OPERATION = 'listApprovalChains';

/** A bean's `getAllValues()` struct as the screen model carries it; keys match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** One approval chain of the list, from its `chainID`, `name`, `siteID` and `lastupdate` bean values. */
export interface CchainListItem {
  readonly chainId: string;
  readonly name: string;
  readonly siteId: string;
  /** `lastupdate` as strategies-content sent it; null when empty. */
  readonly lastUpdate: string | null;
}

/** The site's approval chains (`rc.chains` of the screen model), in the service's name order. */
export interface CchainListData {
  readonly chains: readonly CchainListItem[];
}

/** The labels every chain row repeats, unencoded as legacy emits them, with the confirm text JS-encoded. */
interface RowLabels {
  readonly edit: SafeHtml;
  readonly pendingRequests: SafeHtml;
  readonly remove: SafeHtml;
  readonly deleteConfirm: SafeHtml;
}

/** A struct value by case-insensitive key; undefined when absent. */
function structValue(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple struct value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function structText(struct: Struct, key: string): string {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${OPERATION} returned a chain whose ${key} is not a simple value`);
}

/** The list item of one `rc.chains` entry. */
function chainOf(entry: unknown): CchainListItem {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${OPERATION} returned an rc.chains entry that is not a struct`);
  }
  const chain = entry as Struct;
  const lastUpdate = structText(chain, 'lastupdate');
  return {
    chainId: structText(chain, 'chainID'),
    name: structText(chain, 'name'),
    siteId: structText(chain, 'siteID'),
    lastUpdate: lastUpdate === '' ? null : lastUpdate,
  };
}

/** The chains of `rc.siteid` in name order with their delete tokens prefetched; a 401/403 throws GatewayDenialError. */
export async function loadCchainList(ctx: ScreenContext): Promise<CchainListData> {
  const siteid = ctx.req.rc.siteid ?? '';
  // Legacy's feed drops its site filter for an empty site id; no site-scoped contract call can list every site.
  if (siteid === '') throw new TypeError(`rc.siteid is empty; ${OPERATION} lists the chains of one site`);
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/approval-chains', {
    params: { siteid },
  });
  const entries = structValue(okBody(response, SERVICE, OPERATION).rc, 'chains');
  if (!Array.isArray(entries)) throw new TypeError(`${OPERATION} returned no rc.chains array`);
  const chains = entries.map(chainOf);
  await ctx.csrf.prefetch(chains.map((chain) => chain.chainId));
  return { chains };
}

/** `LSDateFormat(value, session.dateKeyFormat) LSTimeFormat(value, 'medium')` under the session locale, if a date. */
function lastUpdateText(
  lastUpdate: string | null,
  session: Pick<AdminSessionState, 'dateKeyFormat' | 'locale'>,
): SafeHtml | null {
  const date = parseLegacyDate(lastUpdate);
  if (date === null) return null;
  const { dateKeyFormat, locale } = session;
  // ACF emits this branch without its source line breaks and with one trailing space, as captured from legacy.
  return raw(`${cfLsDateFormat(date, dateKeyFormat, locale)} ${cfLsTimeFormat(date, 'medium', locale)} `);
}

/** One chain row; the pending menu link carries the chain's own site, every other link `rc.siteid`. */
function chainRow(ctx: ScreenContext, chain: CchainListItem, siteid: SafeHtml, labels: RowLabels): SafeHtml {
  // Legacy interpolates the chain id into every href without encoding.
  const chainId = raw(chain.chainId);
  const chainSiteId = raw(encodeUrl(chain.siteId));
  return html`
\t\t\t\t<tr>
\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t<li class="edit">
\t\t\t\t\t\t\t\t\t<a href="./?muraAction=cchain.edit&chainID=${chainId}&siteid=${siteid}"><i class="mi-pencil"></i>${labels.edit}</a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t<li class="change-sets">
\t\t\t\t\t\t\t\t\t<a href="./?muraAction=cchain.pending&chainID=${chainId}&siteid=${chainSiteId}"><i class="mi-reorder"></i>${labels.pendingRequests}</a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t<li class="delete">
\t\t\t\t\t\t\t\t\t<a href="./?muraAction=cchain.delete&chainID=${chainId}&siteid=${siteid}${ctx.csrf.render(chain.chainId, 'url')}" onClick="return confirmDialog('${labels.deleteConfirm}',this.href)"><i class="mi-trash"></i>${labels.remove}</a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t</div>
\t\t\t\t\t</td>
\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t<a title="${labels.edit}" href="./?muraAction=cchain.pending&chainID=${chainId}&siteid=${siteid}">${raw(encodeHtml(chain.name))}</a>
\t\t\t\t\t</td>
\t\t\t\t\t<td>
\t\t\t\t\t\t${lastUpdateText(chain.lastUpdate, ctx.req.session)}
\t\t\t\t\t</td>
\t\t\t\t</tr>
\t\t\t\t`;
}

/** The chains table, rows in the order loaded. */
function chainTable(ctx: ScreenContext, chains: readonly CchainListItem[], rb: (key: string) => SafeHtml): SafeHtml {
  const siteid = raw(encodeUrl(ctx.req.rc.siteid ?? ''));
  const labels: RowLabels = {
    edit: rb('approvalchains.edit'),
    pendingRequests: rb('approvalchains.pendingrequests'),
    remove: rb('categorymanager.delete'),
    deleteConfirm: raw(encodeJs(ctx.rb.rbKey('approvalchains.deleteconfirm'))),
  };
  return html`
\t\t\t<table class="mura-table-grid">
\t\t\t<thead>
\t\t\t\t<tr>
\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t<th class="var-width">${rb('approvalchains.name')}</th>
\t\t\t\t\t<th>${rb('approvalchains.lastupdate')}</th>
\t\t\t\t</tr>
\t\t\t</thead>
\t\t\t<tbody class="nest">
\t\t\t\t${chains.map((chain) => chainRow(ctx, chain, siteid, labels))}
\t\t\t</tbody>
\t\t\t</table>
\t\t\t`;
}

/** The list view body: the approval-chain script, the header with its menu, then the table or the empty notice. */
export function renderCchainList(ctx: ScreenContext, data: CchainListData): ShellView {
  const rb = (key: string): SafeHtml => raw(ctx.rb.rbKey(key));
  const content =
    data.chains.length === 0
      ? html`
\t\t\t  <div class="help-block-empty">${rb('approvalchains.noapprovalchains')}</div>
\t\t  `
      : chainTable(ctx, data.chains, rb);
  // ACF drops the view's `<cfset>`- and `<cfoutput>`-only lines (the loop's included), as captured from legacy.
  const body = html`
${renderCchainJs()}

<div class="mura-header">
\t<h1>${rb('approvalchains')}</h1>

\t${renderCchainSecondaryMenu(ctx.req, ctx.rb)}

</div> <!-- /.mura-header -->
<div class="block block-constrain">
\t<div class="block block-bordered">
\t  <div class="block-content">
\t\t  ${content}
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;
  return { body };
}
