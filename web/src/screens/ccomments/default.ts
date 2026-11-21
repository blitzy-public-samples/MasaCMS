// `ccomments.default`: the Comments Manager of `admin/core/views/ccomments/default.cfm` over strategies-content (server-only).
import { cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import { CORE_VERSION } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { administersRequestedSite, type AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { PageScreen, ScreenContext } from '../registry';
import { CCOMMENTS_OWNER, COMMENTS_MODULE_ID, ccommentsGate, commentsSiteId } from './shared';

// The contract serves the page data of `ccomments.default` as `listComments`; it has no `/ccomments/default` path.
const OPERATION = 'listComments';

// The page-data contract defines no `purgecomments` field and web reads no Masa setting for it, so the global flag is
// configBean's default, which no settings-template key overrides.
const PURGE_COMMENTS = true;

/** What the Comments Manager view reads: the site, the toolbar permissions and the preserved `rc.processed` outcome. */
export interface CommentsManagerModel {
  readonly siteid: string;
  /** Site admin or S2: the header toolbar renders. */
  readonly canManage: boolean;
  /** `purgecomments` on and an S2 user: the purge button renders. */
  readonly canPurge: boolean;
  /** `rc.processed` when it is a CFML boolean; absent otherwise. */
  readonly processed?: boolean;
}

/** `rc.processed` as the view reads it: its boolean value when `isBoolean`, else undefined. */
function processedOf(req: AdminRequest): boolean | undefined {
  const processed = req.rc['processed'];
  return cfIsBoolean(processed) ? cfToBoolean(processed) : undefined;
}

/**
 * The view model of `rc.siteid` (else the session site), after strategies-content serves the site's comments page.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 * @throws GatewayDenialError When strategies-content refuses the request (401 or 403).
 */
async function loadCommentsManager(ctx: ScreenContext): Promise<CommentsManagerModel> {
  const { req } = ctx;
  const siteid = commentsSiteId(req);
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/comments', { params: { siteid } });
  okBody(response, CCOMMENTS_OWNER, OPERATION);
  const processed = processedOf(req);
  return {
    siteid,
    canManage: administersRequestedSite(req),
    canPurge: PURGE_COMMENTS && req.isS2,
    ...(processed === undefined ? {} : { processed }),
  };
}

// The view's whitespace is reproduced as ACF emits it, as captured from legacy: `<cfset>`-only lines are dropped and
// each `<cfif>` line leaves its indent, so the branches below carry their surrounding tabs and line breaks.

/** The header toolbar: the purge button for `canPurge`, then the comments module's Permissions link. */
function toolbar(model: CommentsManagerModel, rb: (key: string) => SafeHtml): SafeHtml {
  const purge = model.canPurge
    ? html`
\t\t\t\t\t\t\t\t<a id="purge-comments" class="btn btn-default" data-alertmessage="${rb('comments.message.confirm.purge')}"><i class="mi-trash-o"></i> ${rb('comments.purgedeletedcomments')}</a>
\t\t\t\t\t`
    : null;
  const permissionsHref = html`./?muraAction=cPerm.module&contentid=${COMMENTS_MODULE_ID}&siteid=${raw(encodeUrl(model.siteid))}&moduleid=${COMMENTS_MODULE_ID}`;
  return html`
\t\t\t<div class="nav-module-specific btn-group">
\t\t\t\t\t${purge}
\t\t\t\t\t\t\t\t<a class="btn" href="${permissionsHref}"><i class="mi-group"></i> ${rb('sitemanager.permissions')}</a>
\t\t\t</div>
\t\t`;
}

/** The success or error alert of a preserved `rc.processed`. */
function feedback(processed: boolean, rb: (key: string) => SafeHtml): SafeHtml {
  const message = processed ? rb('comments.message.confirmation') : rb('comments.message.error');
  return html`
\t\t<div id="feedback" class="alert alert-${processed ? 'success' : 'error'}"><span>
\t\t\t<button type="button" class="close" data-dismiss="alert"><i class="mi-close"></i></button>
\t\t\t${message}\x20
\t\t</span>
\t\t</div>
\t`;
}

/** The Comments Manager body: `comment.js`, its start-up script, the header and the empty `#commentSearch` target. */
export function renderCommentsManager(model: CommentsManagerModel, rb: RbLookup): SafeHtml {
  // Legacy writes every label unencoded.
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  return html`
<script src="assets/js/comment.js?coreversion=${CORE_VERSION}" type="text/javascript"></script>
<style>
</style>
<script>
\t$(document).ready(function(){
\t\tcommentManager.loadSearch('');
\t});\t
</script>

\t

<div id="commentsManagerWrapper">

\t<div class="mura-header">
\t\t<h1>${label('comments.commentsmanager')}</h1>

\t\t${model.canManage ? toolbar(model, label) : null}

\t</div> <!-- /.mura-header -->
\t
\t
\t
\t${model.processed === undefined ? null : feedback(model.processed, label)}

\t<div class="block block-constrain">
\t\t<div class="block block-bordered">
\t\t\t<div class="block-content">


\t\t\t\t<form id="frmSearch" action="index.cfm">
\t\t\t\t\t<div class="tabs-left mura-ui full">
\t\t\t\t\t\t<div class="tab-content">
\t\t\t\t\t\t\t<div id="commentSearch"></div>
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t</form>

\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.block-constrain -->

</div>
`;
}

/** `ccomments.default`: the Comments Manager page, rendered inside the shell. */
export const ccommentsDefault: PageScreen<CommentsManagerModel> = Object.freeze({
  circuit: 'ccomments',
  action: 'default',
  owner: CCOMMENTS_OWNER,
  mode: 'page',
  gate: ccommentsGate,
  load: loadCommentsManager,
  render: (ctx: ScreenContext, model: CommentsManagerModel) => ({ body: renderCommentsManager(model, ctx.rb) }),
});
