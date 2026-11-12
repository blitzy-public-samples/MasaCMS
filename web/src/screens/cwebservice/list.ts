// `cwebservice.list`: the Web Services list of `admin/core/views/cwebservice/list.cfm` over identity's OAuth clients (server-only).
import { cfEq, cfJavaDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/identity';
import { parseLegacyDate } from '@/lib/dates';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { siteBeanOf } from '@/lib/site-paths';
import { relativeAdminUrl, type BoundAdminParams } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';

/** A `toauthclients` row as identity lists it. */
export type WebServiceClient = components['schemas']['OAuthClient'];

/** What the list view renders: the session site's clients, in the order identity returns them. */
export interface WebServiceListData {
  readonly clients: readonly WebServiceClient[];
}

/** Grant types the list labels as OAuth2; any other stored value reads as Basic. */
const OAUTH2_GRANT_TYPES: readonly string[] = ['client_credentials', 'authorization_code', 'implicit', 'password'];

/** oauthClientBean `getGrantType()`: an empty stored grant type means `client_credentials`. */
export function effectiveGrantType(stored: string | null | undefined): string {
  return stored === null || stored === undefined || stored === '' ? 'client_credentials' : stored;
}

/** The Auth Mode cell text: `OAuth2 (<grant type>)` for an OAuth2 grant (compared as CFML `eq`), else `Basic`. */
export function authModeLabel(grantType: string): string {
  const oauth2 = OAUTH2_GRANT_TYPES.find((known) => cfEq(grantType, known));
  return oauth2 === undefined ? 'Basic' : `OAuth2 (${oauth2})`;
}

/**
 * `LSDateFormat(value, session.dateKeyFormat) LSTimeFormat(value, 'medium')` under the session locale; both parts
 * empty for an empty value.
 * @throws RangeError When the value is not a date, as legacy's formatters fail on it.
 */
function lastUpdateText(value: string | null | undefined, dateKeyFormat: string, javaLocale: string): string {
  if (value === null || value === undefined || value === '') return ' ';
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${value} cannot be converted to a date.`);
  return `${cfJavaDateFormat(date, dateKeyFormat)} ${cfLsTimeFormat(date, 'medium', javaLocale)}`;
}

/**
 * The OAuth clients of `session.siteid` (legacy `getFeed('oauthClient').setSiteID(session.siteid)`); gateway
 * unavailability propagates.
 * @throws GatewayDenialError When identity refuses the list (401 or 403).
 */
export async function loadList(ctx: ScreenContext): Promise<WebServiceListData> {
  const siteid = ctx.req.session.siteid;
  // A feed filtered on an empty site id matches no row; the contract accepts no empty site id.
  if (siteid === '') return { clients: [] };
  const response = await ctx.gateway.identity.call('get', '/v1/oauth-clients', { query: { siteid } });
  return { clients: okBody(response, 'identity', 'listOAuthClients').items };
}

/** One client row; its links carry `rc.siteid` as `siteid`. */
function clientRow(ctx: ScreenContext, client: WebServiceClient, siteid: string): SafeHtml {
  const { clientid } = client;
  const { dateKeyFormat, locale } = ctx.req.session;
  // The client id is HTML-encoded into the links, the site id URL-encoded.
  const params: BoundAdminParams = [['clientid', encodeHtml(clientid), 'raw'], ['siteid', siteid]];
  const editHref = raw(relativeAdminUrl('cwebservice', 'edit', params));
  const deleteHref = raw(relativeAdminUrl('cwebservice', 'delete', params));
  return html`
				<tr>
					<td class="actions">
						<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
						<div class="actions-menu hide">
							<ul class="actions-list">
								<li class="edit">
									<a href="${editHref}"><i class="mi-pencil"></i>Edit</a>
								</li>
								<li class="delete">
									<a href="${deleteHref}${ctx.csrf.render(clientid, 'url')}" onClick="return confirmDialog('Delete Web Service?',this.href)"><i class="mi-trash"></i>Delete</a>
								</li>
							</ul>
						</div>
					</td>
					<td class="var-width">
						<a title="Edit" href="${editHref}">${client.name}</a>
					</td>
					<td>
						${authModeLabel(effectiveGrantType(client.granttype))}
					</td>
					<td>
						${lastUpdateText(client.lastupdate, dateKeyFormat, locale)}
					</td>
				</tr>`;
}

/** The clients table, or the empty-state notice when the site has none. */
async function clientList(ctx: ScreenContext, clients: readonly WebServiceClient[], siteid: string): Promise<SafeHtml> {
  if (clients.length === 0) {
    return html`
			  <div class="help-block-empty">There currently are no web services configured for this site.</div>`;
  }
  await ctx.csrf.prefetch(clients.map((client) => client.clientid));
  return html`
			<table class="mura-table-grid">
			<thead>
				<tr>
					<th class="actions"></th>
					<th class="var-width">Name</th>
					<th class="var-width">Auth Mode</th>
					<th>Last Update</th>
				</tr>
			</thead>
			<tbody class="nest">${clients.map((client) => clientRow(ctx, client, siteid))}
			</tbody>
			</table>`;
}

/** The list view body, with the SSL notice when the session site does not use SSL (`siteConfig('useSSL')`). */
export async function renderList(ctx: ScreenContext, data: WebServiceListData): Promise<ShellView> {
  const siteid = ctx.req.rc.siteid ?? '';
  const useSSL = ctx.req.site !== undefined && siteBeanOf(ctx.req.site).useSSL;
  // Legacy's add link has a stray `&siteid=&`: the URL-encoded site id follows `siteid=` as a bare segment.
  const addHref = raw(
    relativeAdminUrl('cwebservice', 'edit', [['clientid', ''], ['siteid', `&${encodeUrl(siteid)}`, 'raw']]),
  );
  const body = html`
<div class="mura-header">
	<h1>Web Services</h1>

    <div class="nav-module-specific btn-group">
        <a class="btn" href="${addHref}"><i class="mi-plus-circle"></i> Add New Web Service</a>
    </div>
</div> <!-- /.mura-header -->
${
  useSSL
    ? ''
    : html`
   <div class="alert alert-error"><span>When using web services in production, this site should be set to use SSL (HTTPS).</span></div>
`
}
<div class="block block-constrain">
	<div class="block block-bordered">
	  <div class="block-content">
${await clientList(ctx, data.clients, siteid)}
		</div> <!-- /.block-content -->
	</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;
  return { body };
}

/** The page-mode members of the `cwebservice.list` screen. */
export const listScreen: Pick<PageScreen<WebServiceListData>, 'mode' | 'load' | 'render'> = Object.freeze({
  mode: 'page',
  load: loadList,
  render: renderList,
});
