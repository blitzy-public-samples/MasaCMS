// `cwebservice.edit`: the Web Service form of `admin/core/views/cwebservice/edit.cfm`, which `save` re-renders (server-only).
import { cfEq, cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import type { components as IdentityComponents } from '@/generated/clients/identity';
import type { components as PeopleComponents } from '@/generated/clients/people';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { attr, encodeHtml, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
// site-paths holds the settingsBean path getters the shell's `Mura.init` uses; the endpoint must match that root path.
import { siteBeanOf, sitePaths } from '@/lib/site-paths';
import { relativeAdminUrl } from '@/lib/urls';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { effectiveGrantType, type WebServiceClient } from './list';

/** Field name to legacy validation message, in the order identity reports them. */
export type WebServiceErrors = IdentityComponents['schemas']['LegacyErrors'];

/** A system user of the site's private pool, as people lists it. */
type ConnectedAccount = PeopleComponents['schemas']['UserListRow'];

/** The oauthClient bean the form renders. */
export interface WebServiceEditState {
  readonly clientid: string;
  readonly clientsecret: string;
  readonly siteid: string;
  readonly name: string;
  readonly description: string;
  readonly granttype: string;
  readonly userid: string;
  readonly redirecturl: string;
  readonly exists: boolean;
  readonly errors?: WebServiceErrors;
}

/** Authorization Mode options in legacy order; legacy writes a space before the `basic` option's condition only. */
const GRANT_TYPE_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly gap: string }> = [
  { value: 'basic', label: 'Basic', gap: ' ' },
  { value: 'client_credentials', label: 'OAuth2 (client_credentials)', gap: '' },
  { value: 'authorization_code', label: 'OAuth2 (authorization_code)', gap: '' },
  { value: 'implicit', label: 'OAuth2 (implicit)', gap: '' },
  { value: 'password', label: 'OAuth2 (password)', gap: '' },
];

// The unbalanced `</p><p>` is legacy's own text.
const GENERATE_TOKEN_SCRIPT = raw(`<script>
        function generateToken(){
            actionModal(function(){
                $('#action-modal').remove();
                mura.generateOAuthToken('client_credentials',$('#clientid').val(),$('#clientsecret').val()).then(function(data){
                    $('#token-container').html('<div class="alert alert-info"><span><strong>access_token:</strong> ' + data['access_token'] +'</p><p><strong>expires_in:</strong> ' + data['expires_in'] + '</span></div>');
                });
            });
        }
    </script>`);

const CONDITIONAL_SCRIPT = raw(`<script>
      $(function(){
          $('select[name="granttype"]').change(function(){
              $(".conditional").hide();
              $("." + $(this).val()).show();
          }).trigger('change');
      })
</script>`);

/** The bean `loadBy` leaves for an id no stored client of the site has: id and site set, `granttype` defaulted. */
function newClientState(clientid: string, siteid: string): WebServiceEditState {
  return {
    clientid,
    clientsecret: '',
    siteid,
    name: '',
    description: '',
    granttype: 'basic',
    userid: '',
    redirecturl: '',
    exists: false,
  };
}

/** The bean of a stored client. */
function storedClientState(client: WebServiceClient): WebServiceEditState {
  return {
    clientid: client.clientid,
    clientsecret: client.clientsecret ?? '',
    siteid: client.siteid,
    name: client.name ?? '',
    description: client.description ?? '',
    granttype: effectiveGrantType(client.granttype),
    userid: client.userid ?? '',
    redirecturl: client.redirecturl ?? '',
    exists: true,
  };
}

/**
 * `rc.clientid` (a new CF UUID when empty) loaded through identity by client id and `rc.siteid`; gateway
 * unavailability propagates.
 * @throws GatewayDenialError When identity refuses the read (401 or 403).
 */
export async function loadEditState(ctx: ScreenContext): Promise<WebServiceEditState> {
  const siteid = ctx.req.rc.siteid ?? '';
  const clientid = ctx.req.rc.clientid || cfUuid();
  const response = await ctx.gateway.identity.call('get', '/v1/oauth-clients/{clientId}', {
    params: { clientId: clientid },
    // An empty siteid names no site; omitted, identity takes the token's site.
    query: { siteid: siteid || undefined },
  });
  // The contract rejects a client id that is not a CF UUID, which therefore names no stored client.
  if (!response.ok && (response.status === 400 || response.status === 404)) return newClientState(clientid, siteid);
  const { client, exists } = okBody(response, 'identity', 'getOAuthClient');
  return exists ? storedClientState(client) : newClientState(clientid, siteid);
}

/**
 * The Connected Account choices: `userFeed` of `rc.siteid` with `isPublic=0`, by last name.
 * @throws GatewayDenialError When people refuses the list (401 or 403).
 */
async function loadAccounts(ctx: ScreenContext): Promise<readonly ConnectedAccount[]> {
  const siteid = ctx.req.rc.siteid ?? '';
  const response = await ctx.gateway.people.call('get', '/v1/users', {
    query: { siteid: siteid || undefined, ispublic: '0' },
  });
  return okBody(response, 'people', 'listUsers').items;
}

/** `settingsBean.getResourcePath(complete=1)` of the request's site, else of the request host as the shell takes it. */
function completeResourcePath(req: AdminRequest): string {
  if (req.site !== undefined) return sitePaths(req, siteBeanOf(req.site)).rootPath(true);
  const { serverPort, context } = legacySettings();
  return `${req.https ? 'https' : 'http'}://${req.serverName}${serverPort}${context}`;
}

/** `siteConfig().getApi('json','v1').getEndpoint(mode='rest')` on an admin request. */
function restEndpoint(req: AdminRequest): string {
  const siteid = req.site?.siteid ?? req.rc.siteid ?? '';
  const indexFile = legacySettings().indexFileInAPI ? '/index.cfm' : '';
  // CFML `replace` swaps only the first `/json/`.
  return `${completeResourcePath(req)}${indexFile}/_api/json/v1/${siteid}`.replace('/json/', '/rest/');
}

/** userBean `getFullName()` of a person: trimmed first and last name. */
function fullName(account: ConnectedAccount): string {
  return javaTrim(`${account.Fname ?? ''} ${account.Lname ?? ''}`);
}

// Messages are HTML-encoded, where legacy prints them raw: they are service-supplied text, and plain text renders alike.
/** `utility.displayErrors`: every message but `siteID`'s, in map order; the `<br>` test counts every key. */
function displayErrors(errors: WebServiceErrors): SafeHtml {
  const entries = Object.entries(errors);
  return join(
    entries.flatMap(([key, message], index) =>
      // The single spaces, like the one the alert puts before the messages, are the tag-body whitespace ACF emits.
      key.toLowerCase() === 'siteid' ? [] : [html`${message} ${entries.length > index + 1 ? raw('<br> ') : ''}`],
    ),
  );
}

/** The Authorization Mode options, `granttype` selected as CFML `eq` compares. */
function grantTypeOptions(granttype: string): SafeHtml {
  return join(
    GRANT_TYPE_OPTIONS.map(({ value, label, gap }) =>
      raw(`
                  <option value="${value}"${gap}${cfEq(granttype, value) ? ' selected' : ''}>${label}</option>`),
    ),
  );
}

/** One Connected Account option per person, the bean's `userid` selected as CFML `eq` compares. */
function accountOptions(accounts: readonly ConnectedAccount[], userid: string): SafeHtml {
  return join(
    accounts.map(
      (account) => html`
                      <option value="${account.UserID}"${cfEq(account.UserID, userid) ? ' selected' : ''}>${fullName(account)}</option>`,
    ),
  );
}

/** The Endpoint through Example Usage groups of a stored client. */
function endpointGroups(req: AdminRequest, { clientid, clientsecret }: WebServiceEditState): SafeHtml {
  const endpoint = restEndpoint(req);
  const basicHeader = Buffer.from(`${clientid}:${clientsecret}`, 'utf8').toString('base64');
  return html`
            <div class="mura-control-group">
                <label>Endpoint</label>
                <div>
                    <a href="${endpoint}" target="_blank">${endpoint}</a>
                </div>
            </div>
            <div class="mura-control-group conditional client_credentials authorization_code implicit password">
                <label>OAuth Endpoint</label>
                <div>
                    <a href="${endpoint}/oauth2" target="_blank">${endpoint}/oauth2</a>
                </div>
            </div>
            <div class="mura-control-group conditional basic">
                <label>Username</label>
                <div>
                    ${clientid}
                </div>
            </div>
            <div class="mura-control-group conditional basic">
                <label>Password</label>
                <div>
                    ${clientsecret}
                </div>
            </div>
            <div class="mura-control-group conditional basic">
                <label>Basic Authentication Header</label>
                <div>
                    Authorization: Basic ${basicHeader}
                </div>
            </div>
            <div class="mura-control-group conditional client_credentials authorization_code implicit password">
                <label>client_id</label>
                <div>
                    ${clientid}
                </div>
            </div>
            <div class="mura-control-group conditional client_credentials password authorization_code implicit">
                <label>client_secret</label>
                <div>
                    ${clientsecret}
                </div>
            </div>
            <div class="mura-control-group conditional client_credentials">
                <label>Example Usage of</label>
                <div>
                    <a href="${endpoint}/oauth2?grant_type=client_credentials&client_id=${clientid}&client_secret=${clientsecret}" target="_blank">${endpoint}/oauth2?grant_type=client_credentials&client_id=${clientid}&client_secret${clientsecret}</a>
                </div>
            </div>
`;
}

/** Add for a new client; Delete (with URL CSRF tokens) and Update for a stored one. */
function actionButtons(ctx: ScreenContext, { clientid, siteid, exists }: WebServiceEditState): SafeHtml {
  if (!exists) {
    return html`
            <button class="btn mura-primary" type="button" onclick="submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i> Add</button>`;
  }
  // The client id is HTML-encoded into the URL, the site id URL-encoded.
  const deleteHref = raw(
    relativeAdminUrl('cwebservice', 'delete', [['clientid', encodeHtml(clientid), 'raw'], ['siteid', siteid]]),
  );
  return html`
            <button class="btn" type="button" onclick="confirmDialog('Delete Web Service?','${deleteHref}${ctx.csrf.render(clientid, 'url')}');"><i class="mi-trash"></i> Delete</button>
            <button class="btn mura-primary" type="button" onclick="submitForm(document.forms.form1,'save');"><i class="mi-check-circle"></i> Update</button>`;
}

/** The edit view body for `state`, with the Connected Account choices and the client id's CSRF tokens it fetches. */
export async function renderEditView(ctx: ScreenContext, state: WebServiceEditState): Promise<ShellView> {
  const [accounts] = await Promise.all([loadAccounts(ctx), ctx.csrf.prefetch([state.clientid])]);
  const { clientid, exists, granttype } = state;
  const useSSL = ctx.req.site !== undefined && siteBeanOf(ctx.req.site).useSSL;
  // Legacy's back link has a stray `&siteid=&`: the URL-encoded `rc.siteid` follows `siteid=` as a bare segment.
  const backHref = raw(
    relativeAdminUrl('cwebservice', 'list', [['siteid', `&${encodeUrl(ctx.req.rc.siteid ?? '')}`, 'raw']]),
  );
  const generateTokenLink =
    exists && cfEq(granttype, 'client_credentials')
      ? html`<a class="btn conditional client_credentials" href="#" onclick="generateToken();return false;"><i class="mi-key"></i> Generate Access Token</a>`
      : '';
  const errors = state.errors ?? {};
  const errorAlert =
    Object.keys(errors).length > 0
      ? html`
  <div class="alert alert-error"><span> ${displayErrors(errors)}</span></div>
`
      : '';
  const sslAlert = useSSL
    ? ''
    : html`
      <div class="alert alert-error"><span>IMPORTANT: When using web services in production this site should be set to use SSL (HTTPS).</span></div>
`;
  const body = html`
<div class="mura-header">
  ${exists ? html`<h1>Edit Web Service</h1>` : html`<h1>Add Web Service</h1>`}
  ${GENERATE_TOKEN_SCRIPT}
  <div class="nav-module-specific btn-group">
      <a class="btn" href="${backHref}"><i class="mi-arrow-circle-left"></i>  Back to Web Services</a>
      ${generateTokenLink}
  </div>
</div> <!-- /.mura-header -->
${errorAlert}${sslAlert}
<form novalidate="novalidate" action="./?muraAction=cwebservice.save" method="post" name="form1" onsubmit="return validateForm(this);">
<div class="block block-constrain">
    <div class="block block-bordered">
      <div class="block-content">

        <span id="token-container"></span>
      <div class="mura-control-group">
          <label>Name</label>
          <input name="name" type="text" required="true" message="The Name attribute is required."${attr('value', state.name)} maxlength="50">
      </div>
      <div class="mura-control-group">
          <label>Description</label>
          <textarea name="description" rows="6">${state.description}</textarea>
      </div>

      <div class="mura-control-group">
          <label>Authorization Mode</label>
              <select name="granttype">${grantTypeOptions(granttype)}
              </select>
      </div>

      <div class="mura-control-group conditional basic client_credentials">
          <label>Connected Account</label>
              <select name="userid">
                  <option value="">-- Select Account --</option>${accountOptions(accounts, state.userid)}
              </select>
      </div>

      <div class="mura-control-group conditional authorization_code implicit" style="block:none">
          <label>Redirect_URI</label>
          <textarea name="redirectURL" rows="5">${state.redirecturl}</textarea>
      </div>
${exists ? endpointGroups(ctx.req, state) : ''}
      <div class="mura-actions">
        <div class="form-actions">${actionButtons(ctx, state)}
          <input type="hidden" id="siteid" name="siteid" value="${state.siteid}">
          <input type=hidden id="clientid" name="clientid" value="${clientid}">
          <input type=hidden id="clientsecret" name="clientsecret" value="${state.clientsecret}">
          ${ctx.csrf.render(clientid, 'form')}
        </div>
      </div>


    </div> <!-- /.block-content -->
  </div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
</form>

${CONDITIONAL_SCRIPT}
`;
  return { body };
}

/** The page-mode members of the `cwebservice.edit` screen. */
export const editScreen: Pick<PageScreen<WebServiceEditState>, 'mode' | 'load' | 'render'> = Object.freeze({
  mode: 'page',
  load: loadEditState,
  render: renderEditView,
});
