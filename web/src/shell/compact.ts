// The compact admin layout of `admin/common/layouts/compact.cfm`, chosen when `rc.compactDisplay` is true (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import { renderDialog } from './dialog';
import { renderHtmlFoot } from './html-foot';
import { renderHtmlHead } from './html-head';
import { renderCompactScripts } from './inline-scripts';
import { compactTitleElement } from './module-title';
import { htmlOpener } from './template';
import type { AdminDocument, ShellContext } from './types';

/** `rc.sourceFrame` when the request names none (`compact.cfm` 87). */
const DEFAULT_SOURCE_FRAME = 'modal';

const MODAL_CLOSE = raw(
  `<a id="frontEndToolsModalClose" href="javascript:frontEndProxy.post({cmd:'close'});"><i class="mi-close"></i></a>`,
);

/** `session.frontEndProxyLoc` after `compact.cfm` 85-91: a non-empty `rc.frontEndProxyLoc`, else the stored value. */
export function resolveFrontEndProxyLoc(ctx: AdminRequest): string {
  // The request set-up already recorded a non-empty rc value in `ctx.sessionWrites`, which handlers persist.
  const requested = ctx.rc.frontEndProxyLoc ?? '';
  return requested !== '' ? requested : ctx.session.frontEndProxyLoc;
}

/** Whether the page is shown in the front-end modal (`rc.sourceFrame eq 'modal'`) rather than the configurator. */
function inModal(ctx: AdminRequest): boolean {
  return cfEq(ctx.rc.sourceFrame ?? DEFAULT_SOURCE_FRAME, DEFAULT_SOURCE_FRAME);
}

/** The `<head>` markup of `compact.cfm` 101-307, ending with the view's accumulated `cfhtmlhead` text. */
function compactHead(sc: ShellContext, modal: boolean): SafeHtml {
  const { ctx, view } = sc;
  const { title, windowDocumentDomain } = legacySettings();
  // Legacy prints the configured domain unencoded.
  const documentDomain = windowDocumentDomain
    ? html`
\t\t\t<script type="text/javascript">
\t\t\t\twindow.document.domain = '${raw(windowDocumentDomain)}';
\t\t\t</script>
`
    : '';
  const html5Shim = ctx.isMSIE
    ? html`
\t\t\t<!-- Le HTML5 shim, for IE6-8 support of HTML5 elements -->
\t\t\t<!--[if lt IE 9]>
\t\t\t   <script src="${raw(adminAssetUrl('js/html5.js'))}"></script>
\t\t\t<![endif]-->
`
    : '';
  // html_head.cfm already loaded nice-select; outside the modal legacy loads it a second time.
  const niceSelect = modal
    ? ''
    : html`
\t\t\t<script src="${raw(adminAssetUrl('js/jquery.nice-select.min.js'))}" type="text/javascript"></script>
`;
  const ieStylesheet = ctx.isMSIE
    ? html`
\t\t\t<!--[if lte IE 8]>
\t\t\t<link href="${raw(adminAssetUrl('css/ie.min.css', { coreversion: true }))}" rel="stylesheet" type="text/css" />
\t\t\t<![endif]-->
`
    : '';
  return html`\t\t<meta charset="utf-8">
\t\t<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">
\t\t<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">

\t\t${compactTitleElement(title)}
    \t<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1.0">
\t\t<meta name="author" content="blueriver & We Are North Groep BV">
\t\t<meta name="robots" content="noindex, nofollow, noarchive">
\t\t<meta http-equiv="cache control" content="no-cache, no-store, must-revalidate">
${documentDomain}${html5Shim}${renderHtmlHead(sc)}
\t\t<!-- nice-select: select box replacement (sidebar controls) -->${niceSelect}
\t\t<!-- /nice-select -->

\t\t<!-- Utilities to support iframe communication -->
\t\t<script src="${raw(adminAssetUrl('js/jquery/jquery-resize.min.js', { coreversion: true }))}" type="text/javascript"></script>
\t\t<script src="${raw(adminAssetUrl('js/porthole/porthole.min.js', { coreversion: true }))}" type="text/javascript"></script>

\t\t<link href="${raw(adminAssetUrl('css/admin.min.css'))}" rel="stylesheet" type="text/css" />
\t\t${ctx.session.dateKey.script}
\t\t${renderCompactScripts(sc, resolveFrontEndProxyLoc(ctx))}
\t\t${view.ajax}
${ieStylesheet}${view.htmlHead}`;
}

/** The `<body>` markup of `compact.cfm` 310-320: the modal close link and dialog, the view, and the footer scripts. */
function compactBody(sc: ShellContext, modal: boolean): SafeHtml {
  const modalChrome = modal
    ? html`
\t\t\t${MODAL_CLOSE}
\t\t\t
${renderDialog()}
`
    : '';
  return html`
\t\t<div id="mura-content">
\t\t${modalChrome}

\t\t<div class="main mura-layout-row">${sc.view.body}</div>

\t\t</div> <!-- /mura-content -->

\t\t${renderHtmlFoot()}
`;
}

/** The compact admin layout around `sc.view`: no nav, header, alerts, frame-buster or no-cache headers. */
export function renderCompact(sc: ShellContext): AdminDocument {
  const { ctx } = sc;
  const modal = inModal(ctx);
  const { preamble, htmlAttrs } = htmlOpener(ctx.session.locale, ctx.isMSIE);
  return {
    layout: 'compact',
    title: legacySettings().title,
    htmlAttrs,
    // Records hold the body attribute text as emitted: this layout html_attr-encodes the id, template.cfm does not.
    bodyAttrs: {
      id: encodeHtmlAttr(sc.originalCircuit),
      class: `compact ${modal ? 'modal-wrapper' : 'configurator-wrapper'}`,
    },
    preamble,
    head: compactHead(sc, modal),
    body: compactBody(sc, modal),
    noCache: false,
  };
}
