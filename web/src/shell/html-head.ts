// Global admin scripts of `admin/common/layouts/includes/html_head.cfm`, which both layouts include (server-only).
import { legacySettings } from '@/lib/env';
import { encodeJs, html, raw, type SafeHtml } from '@/lib/html';
import { legacySitePath } from '@/lib/site-paths';
import { adminAssetUrl, assetUrl, type AssetUrlOptions } from '@/lib/urls';
import type { ShellContext } from './types';

const COREVERSION: AssetUrlOptions = { coreversion: true };

/** The `html_head.cfm` output: favicons, admin and vendor script tags, and the admin JavaScript globals. */
export function renderHtmlHead({ ctx, data }: ShellContext): SafeHtml {
  const { context, htmlEditorType, sessionTimeout, webroot, fileDelim } = legacySettings();
  const admin = (rel: string, options?: AssetUrlOptions): SafeHtml => raw(adminAssetUrl(rel, options));
  const vendor = (rel: string, options?: AssetUrlOptions): SafeHtml => raw(assetUrl(`/core/vendor/${rel}`, options));
  const js = (value: string): SafeHtml => raw(encodeJs(value));
  // ACF's left() fails on a non-positive length; legacy's webroot is never that short, web's unset one gives ''.
  const webrootVar = ctx.isLoggedIn
    ? html`var webroot='${js(webroot.slice(0, Math.max(0, webroot.length - context.length)))}';`
    : undefined;
  // Kept as legacy emits them: the malformed filebrowser stylesheet tag, and the unencoded editor type, context and
  // theme path.
  return html`

<!-- Favicons -->
	<link rel="icon" href="${admin('ico/favicon.ico')}" type="image/x-icon" />
	<link rel="shortcut icon" href="${admin('ico/favicon.ico')}" type="image/x-icon" />
	<link rel="apple-touch-icon-precomposed" sizes="144x144" href="${admin('ico/apple-touch-icon-144-precomposed.png')}">
	<link rel="apple-touch-icon-precomposed" sizes="114x114" href="${admin('ico/apple-touch-icon-114-precomposed.png')}">
	<link rel="apple-touch-icon-precomposed" sizes="72x72" href="${admin('ico/apple-touch-icon-72-precomposed.png')}">
	<link rel="apple-touch-icon-precomposed" href="${admin('ico/apple-touch-icon-57-precomposed.png')}">

	<!-- Spinner JS -->
	<script src="${admin('js/spin.min.js')}" type="text/javascript"></script>

	<!-- jQuery -->
	<script src="${admin('js/jquery/jquery.min.js', COREVERSION)}" type="text/javascript"></script>

	<!-- OneUI Core JS: Bootstrap, slimScroll, scrollLock, Appear, CountTo, Placeholder, Cookie and App.js -->
	<script src="${admin('js/oneui.min.js')}"></script>

	<!-- jQuery UI components -->
	<script src="${admin('js/jquery/jquery-ui.min.js', COREVERSION)}" type="text/javascript"></script>
	<script src="${admin('js/jquery/jquery-ui-i18n.min.js', COREVERSION)}" type="text/javascript"></script>
	<script src="${admin('js/jquery/jquery.collapsibleCheckboxTree.js', COREVERSION)}" type="text/javascript"></script>
	<script src="${admin('js/jquery/jquery.spin.js')}" type="text/javascript"></script>

	<!-- Masa js -->
	<script src="${admin('js/mura.js', COREVERSION)}" type="text/javascript"></script>

	<!-- Masa Admin JS -->
	<script src="${admin('js/admin.min.js', COREVERSION)}" type="text/javascript"></script>

	<!-- CK Editor -->
	<script type="text/javascript" src="${vendor('ckeditor/ckeditor.js')}"></script>
	<script type="text/javascript" src="${vendor('ckeditor/adapters/jquery.js')}"></script>

	<script src="${admin('js/filebrowser/filebrowser.js')}"></script>
	<link href="${admin('js/filebrowser/assets/css/filebrowser.css')}" link rel="stylesheet" type="text/css"></script>

	<!-- JSON -->
	<script src="${admin('js/json2.js')}" type="text/javascript"></script>

	<!-- Color Picker -->
	<script type="text/javascript" src="${vendor('colorpicker/js/bootstrap-colorpicker.js', COREVERSION)}"></script>
	<link href="${vendor('colorpicker/css/bootstrap-colorpicker.min.css', COREVERSION)}" rel="stylesheet" type="text/css" />

	<script type="text/javascript">
	var htmlEditorType='${raw(htmlEditorType)}';
	var context='${raw(context)}';
	var themepath='${raw(legacySitePath(data.legacyPaths, 'themeAssetPath'))}';
	var rb='${raw(encodeJs(ctx.session.rb).toLowerCase())}';
	var siteid='${js(ctx.session.siteid)}';
	var sessionTimeout=${raw(String(sessionTimeout * 60))};
	var activepanel=${js(ctx.rc.activepanel ?? '0')};
	var activetab=${js(ctx.rc.activetab ?? '0')};
	${webrootVar}
	var fileDelim='${js(fileDelim)}';
	</script>

	<!-- nice-select: select box replacement (sidebar controls) -->
	<script src="${admin('js/jquery.nice-select.min.js')}" type="text/javascript"></script>

`;
}
