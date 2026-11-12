// `cform.importform`: the Import Form view and its zip upload, imported by strategies-content (server-only).
import { multipartRelay, okBody } from '@/lib/gateway-client';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { relativeAdminUrl } from '@/lib/urls';
import type { ScreenContext, SubmitResult } from '../registry';

const CSRF_CONTEXT = 'formimport';
const OPERATION = 'importForm';

/** The `importform.cfm` markup; legacy prints both labels unencoded and renders no error or alert. */
export async function renderImportForm(ctx: ScreenContext): Promise<SafeHtml> {
  await ctx.csrf.tokens(CSRF_CONTEXT);
  const title = raw(ctx.rb.rbKey('sitemanager.content.importform'));
  const back = raw(ctx.rb.rbKey('sitemanager.backtositemanager'));
  const siteid = raw(encodeUrl(ctx.req.rc.siteid ?? ''));
  const csrf = ctx.csrf.render(CSRF_CONTEXT, 'form');
  return html`
	<div class="mura-header">
		<h1>${title}</h1>

		<div class="nav-module-specific btn-group">
			<a class="btn" href="./?muraAction=cArch.list&amp;siteid=${siteid}">
				<i class="mi-arrow-circle-left"></i>
				${back}
			</a>
		</div>
	</div> <!-- /.mura-header -->


<form novalidate="novalidate" action="?muraAction=cForm.importform" method="post" enctype="multipart/form-data">
	${csrf}
	<div class="block block-constrain" style="min-height: 1052px;">
		<!-- tab content -->
		<div class="block-content tab-content">

		<div id="tabBasic" class="tab-pane active">

		<!-- block -->
		<div class="block block-bordered">
			<!-- block header -->
			<div class="block-header">
				<h3 class="block-title">Form Builder</h3>
			</div>

			<div class="block-content">
				<span id="extendset-container-tabbasictop" class="extendset-container"></span>

				<div class="mura-control-group">
					<label>
					Title
					</label>
					<input type="text" id="title" name="title" maxlength="255" required="true" message="The 'Title' field is required">
				</div>

				<div class="mura-control-group">
					<label>
					Form To Import (Zip File)
					</label>
					<input type="file" id="formzip" name="formzip" message="The 'Title' field is required">
				</div>
			</div>
		</div>

		<div class="mura-actions">
			<div class="form-actions">
				<button type="submit" class="btn mura-primary">
						<i class="mi-check"></i>Import
				</button>
			</div>
		</div>
	</div><!-- /.block-constrain -->
</form>
`;
}

/**
 * Relays a POSTed `formzip` upload unchanged to strategies-content and follows its redirect; otherwise re-renders.
 * @throws TypeError When the form scope lacks `formzip`, where legacy fails on the undefined element.
 * @throws GatewayDenialError When strategies-content answers 401 or 403; any other non-2xx answer throws `Error`.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
export async function submitImportForm(ctx: ScreenContext): Promise<SubmitResult> {
  const { body, req } = ctx;
  if (body === undefined || body.form.keys().next().done === true) return rerender(ctx);
  const { formzip } = req.rc;
  if (formzip === undefined) throw new TypeError('Element FORMZIP is undefined in FORM.');
  if (formzip === '') return rerender(ctx);
  // Legacy admin reads the token pair from the form scope only, so the body carries it and no CSRF header is added.
  const relay = multipartRelay(body);
  const response = await ctx.gateway.strategiesContent.call('post', '/v1/sites/{siteid}/forms/import', {
    params: { siteid: req.rc.siteid ?? '' },
    body: relay.body,
    headers: relay.headers,
  });
  const { redirect } = okBody(response, 'strategies-content', OPERATION);
  if (redirect === null) return rerender(ctx);
  // The contract hands over legacy's `location()` target as parts; it is relative to `?` with siteid unencoded.
  return {
    kind: 'location',
    location: relativeAdminUrl(redirect.circuit, redirect.action, redirect.params, { prefix: '?', encode: 'raw' }),
  };
}

/** The view re-rendered inside the layout, as the controller falls through to it. */
async function rerender(ctx: ScreenContext): Promise<SubmitResult> {
  return { kind: 'render', view: { body: await renderImportForm(ctx) } };
}
