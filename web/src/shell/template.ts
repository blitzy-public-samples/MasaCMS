// The full admin layout of `admin/common/layouts/template.cfm`, chosen without `compactDisplay` (server-only).
import { cfEq, javaTrim } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import { adminAssetUrl } from '@/lib/urls';
import { renderAlerts } from './alerts';
import { renderDialog } from './dialog';
import { renderHeader } from './header';
import { renderHtmlFoot } from './html-foot';
import { renderHtmlHead } from './html-head';
import { renderTemplateScripts } from './inline-scripts';
import { CONTENT_MODULE_IDS, templateTitleElement, templateTitleText } from './module-title';
import { renderNav } from './nav';
import type { AdminDocument, ShellContext } from './types';

const LOGIN_ACTION = 'core:cLogin.main';

const FRAME_BUSTER = raw(`\t\t<script>
\t\tif (top.location != self.location) {
\t\t    \ttop.location.replace(self.location)
\t\t\t}
\t\t</script>
`);

const MURA_CONTENT_OPEN = raw('\t\t \t\t\t<div id="mura-content">\n\t\t \t\t');
const MURA_CONTENT_CLOSE = raw('\n\t\t \t\t\t</div> <!-- /#mura-content -->\n\t\t \t\t');

/** `<!DOCTYPE html>` and the `<html>` opener of both layouts, with the attributes a non-IE browser applies. */
export interface HtmlOpener {
  preamble: SafeHtml;
  htmlAttrs: Record<string, string>;
}

/** The doctype and IE-conditional `<html>` opener for `locale` (`template.cfm` 77-95, `compact.cfm` 93-99). */
export function htmlOpener(locale: string, isMSIE: boolean): HtmlOpener {
  const lang = raw(encodeHtmlAttr(locale));
  if (isMSIE) {
    return {
      preamble: html`<!DOCTYPE html>
<!--[if IE 8 ]><html class="mura ie ie8" lang="${lang}"><![endif]-->
<!--[if (gte IE 9)|!(IE)]><!--><html lang="${lang}" class="mura ie"><!--<![endif]-->`,
      htmlAttrs: { lang: locale, class: 'mura ie' },
    };
  }
  // The IE9 branch keeps legacy's hard-coded `en_US`.
  return {
    preamble: html`<!DOCTYPE html>
<!--[if IE 9]> <html lang="en_US" class="ie9 mura no-focus"> <![endif]-->
<!--[if gt IE 9]><!--> <html lang="${lang}" class="mura no-focus"><!--<![endif]-->`,
    htmlAttrs: { lang: locale, class: 'mura no-focus' },
  };
}

/** The `<head>` markup: metas, title, admin stylesheet, global scripts, date key, view head and frame-buster. */
function templateHead(sc: ShellContext): SafeHtml {
  const { ctx, view } = sc;
  const ieStylesheet = ctx.isMSIE
    ? html`
\t\t<!--[if lte IE 8]>
\t\t<link href="${raw(adminAssetUrl('css/ie.min.css', { coreversion: true }))}" rel="stylesheet" type="text/css" />
\t\t<![endif]-->
`
    : '';
  return html`\t<meta charset="utf-8">
\t<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">
\t<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
\t

\t${templateTitleElement(legacySettings().title, sc.moduleTitle)}
\t<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1.0">
\t<meta name="author" content="blueriver & We Are North Groep BV">
\t<meta name="robots" content="noindex, nofollow, noarchive">
\t<meta http-equiv="cache control" content="no-cache, no-store, must-revalidate">

\t<!-- Admin CSS -->
\t<link href="${raw(adminAssetUrl('css/admin.min.css'))}" rel="stylesheet" type="text/css" />
${renderHtmlHead(sc)}${ieStylesheet}\t${ctx.session.dateKey.script}
\t${view.ajax}
${cfEq(sc.originalCircuit, 'cLogin') ? '' : FRAME_BUSTER}\t${view.htmlHead}`;
}

/** Whether `carch/dsp_content_nav.cfm` follows the footer scripts: Site Manager list or search of a content module. */
function showsContentNav(sc: ShellContext): boolean {
  const moduleId = sc.ctx.rc.moduleid ?? '';
  return (
    cfEq(sc.originalCircuit, 'cArch') &&
    (cfEq(sc.originalFuseaction, 'list') || cfEq(sc.originalFuseaction, 'search')) &&
    (CONTENT_MODULE_IDS.includes(moduleId) || cfEq(moduleId, ''))
  );
}

/** The `<body>` markup: page container with nav, header, alerts, the view, inline and footer scripts and dialogs. */
function templateBody(sc: ShellContext): SafeHtml {
  const { ctx } = sc;
  const chrome = ctx.session.siteid !== '' && ctx.isLoggedIn && ctx.isPrivateUser;
  const adminSidebar = ctx.cookies.get('ADMINSIDEBAR');
  // The admin set-up writes ADMINSIDEBAR=off when the browser sent none, so absence reads as off.
  const sidebarMini = adminSidebar === undefined || cfEq(adminSidebar, 'off');
  const loginMain = cfEq(ctx.action, LOGIN_ACTION);
  const pageContainerClass =
    `${chrome ? 'sidebar-l' : ''} sidebar-o ${sidebarMini ? ' sidebar-mini' : ''} ` +
    'side-overlay-hover side-scroll header-navbar-fixed';
  return html`
\t<!-- Page Container -->
\t<div id="page-container" class="${pageContainerClass}">

\t\t${chrome ? [renderNav(sc), renderHeader(sc)] : ''}

\t\t<!-- Main Container -->
\t\t<main id="main-container" class="${chrome ? 'block-constrain' : ''}">

\t\t    <!-- Page Content -->
\t\t    <div class="content">

\t\t     \t${renderAlerts(sc)}${loginMain ? '' : MURA_CONTENT_OPEN}${sc.view.body}${loginMain ? '' : MURA_CONTENT_CLOSE}

\t\t\t</div>  <!-- /.content -->

\t\t</main>

\t\t${loginMain ? '' : renderTemplateScripts(sc)}

\t\t${renderHtmlFoot()}
${showsContentNav(sc) ? sc.hooks.contentNav?.(ctx) : ''}
${renderDialog()}


\t</div><!-- /.page-container -->
`;
}

/** The full admin layout around `sc.view`; body `id` and `class` hold the text legacy emits unencoded. */
export function renderTemplate(sc: ShellContext): AdminDocument {
  const { preamble, htmlAttrs } = htmlOpener(sc.ctx.session.locale, sc.ctx.isMSIE);
  return {
    layout: 'template',
    title: templateTitleText(legacySettings().title, sc.moduleTitle),
    htmlAttrs,
    bodyAttrs: {
      id: sc.originalCircuit,
      class: `mura-admin header-navbar-fixed no-constrain ${javaTrim(sc.bodyclass)}`,
    },
    preamble,
    head: templateHead(sc),
    body: templateBody(sc),
    noCache: true,
  };
}
