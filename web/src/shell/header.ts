// Admin header bar of the full layout: sidebar toggles, site selector, header search and user tools (server-only).
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest, SiteData } from '@/lib/request-context';
import type { ShellContext, UserPrompts } from './types';

const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const HOME_CONTENT_ID = '00000000000000000000000000000000001';

/** `cfloop query=theSiteList startrow=1 endrow=100`. */
const SITE_LIST_LIMIT = 100;

/** Site counts above this show the site list filter. */
const SITE_FILTER_THRESHOLD = 10;

/** The Site Manager report prompts of `header.cfm` 179-217, in order: count, report, sort column and link text. */
const REPORT_PROMPTS: ReadonlyArray<
  readonly [count: Exclude<keyof UserPrompts, 'pendingChangesets'>, report: string, sortBy: string, text: string]
> = [
  ['drafts', 'mydrafts', 'lastupdate', ' Drafts'],
  ['submissions', 'mysubmissions', 'duedate', ' Submissions'],
  ['approvals', 'myapprovals', 'duedate', ' Approvals '],
  ['expires', 'myexpires', 'duedate', ' Expiring'],
];

/** The prompt counts in the order the header renders them. */
const PROMPT_COUNTS: ReadonlyArray<keyof UserPrompts> = [
  'drafts',
  'submissions',
  'approvals',
  'expires',
  'pendingChangesets',
];

/** Sum of the prompt counts that render (each count above zero). */
export function userPromptTally(prompts: UserPrompts): number {
  return PROMPT_COUNTS.reduce((tally, key) => (prompts[key] > 0 ? tally + prompts[key] : tally), 0);
}

type SiteRecord = SiteData['record'];

/** CFML truthiness of a site flag: SQL NULL and `''` read as the bean's 0, else CFML boolean conversion. */
function flag(value: unknown): boolean {
  return value === null || value === undefined || value === '' ? false : cfToBoolean(value);
}

/** ACF `HTMLEditFormat`: drops CR and escapes `&`, `"`, `<` and `>`. */
function htmlEditFormat(s: string): string {
  return s
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** settingsBean `isValidDomain(domain, mode='complete')`: the site domain or one of its CR/LF-separated aliases. */
function isValidDomain(site: SiteData, domain: string): boolean {
  if (cfEq(domain, site.domain)) return true;
  return (site.record.domainAlias ?? '')
    .split(/[\r\n]/)
    .some((alias) => alias !== '' && cfEq(domain, alias));
}

/** settingsBean `getUseSSL()` of a read row: a stored `useSSL` also sets `extranetSSL`; NULL leaves it as read. */
function siteUseSSL(record: SiteRecord): boolean {
  return record.useSSL === null || record.useSSL === undefined ? flag(record.ExtranetSSL) : flag(record.useSSL);
}

/** settingsBean `getWebPath(complete=1)`: scheme, domain, port and context of the site. */
function siteWebPath(ctx: AdminRequest, site: SiteData): string {
  const { serverPort, context } = legacySettings();
  const { record } = site;
  const isRemote = flag(record.isremote);
  const domain =
    !isRemote && ctx.serverName !== '' && !flag(record.enforcePrimaryDomain) && isValidDomain(site, ctx.serverName)
      ? ctx.serverName
      : site.domain;
  const remotePort = record.remoteport ?? 80;
  const port = !isRemote ? serverPort : remotePort === 80 || remotePort === 443 ? '' : `:${remotePort}`;
  const path = isRemote ? (record.remotecontext ?? '') : context;
  return `${siteUseSSL(record) || ctx.https ? 'https' : 'http'}://${domain}${port}${path}`;
}

/** contentServer `getURLStem(siteid, '')`; a non-empty remote event site's renderer turns both URL flags off. */
function homeStem(siteId: string, isRemote: boolean): string {
  const { siteIDInURLS, indexFileInURLS } = legacySettings();
  if ((siteId !== '' && isRemote) || !siteIDInURLS) return '/';
  return indexFileInURLS ? `/index.cfm/${siteId}/` : `/${siteId}/`;
}

/** `rc.$.createHref(filename='', complete=1)`: the complete home URL of the event site, HTML-edit-formatted. */
function siteHomeUrl(ctx: AdminRequest): string {
  const { site } = ctx;
  if (site !== undefined) {
    return htmlEditFormat(siteWebPath(ctx, site) + homeStem(ctx.rc.siteid ?? '', flag(site.record.isremote)));
  }
  // programs-sites served no site data for this request, so the request host stands in for the site domain.
  const { serverPort, context } = legacySettings();
  const webPath = `${ctx.https ? 'https' : 'http'}://${ctx.serverName}${serverPort}${context}`;
  return htmlEditFormat(webPath + homeStem(ctx.rc.siteid ?? '', false));
}

/** `getSite(session.siteid).getSite()`, from the site data, else the session or user site lists. */
function sessionSiteName(sc: ShellContext): string {
  const { site, session, adminSites } = sc.ctx;
  if (site !== undefined) return site.site;
  return (
    adminSites.find((entry) => cfEq(entry.siteID, session.siteid))?.site ??
    sc.data.userSites.find((entry) => cfEq(entry.siteId, session.siteid))?.site ??
    ''
  );
}

/** The site selector `li` of `header.cfm` 120-147. */
function renderSiteSelector(sc: ShellContext, base: string): SafeHtml {
  const { ctx, data } = sc;
  const sites = data.userSites;
  const filter =
    sites.length > SITE_FILTER_THRESHOLD
      ? html`
          <div class="ui-widget">
            <input name="site-list-filter" id="site-list-filter" class="form-control input-sm" type="text" placeholder="${raw(data.rb.rbKey('dashboard.search'))}...">
          </div>`
      : '';
  const items = sites.slice(0, SITE_LIST_LIMIT).map((entry) => {
    const baseUrl =
      entry.showDashboard && ctx.isPrivateUser
        ? `${base}/?muraAction=cDashboard.main`
        : `${base}/?muraAction=cArch.list&amp;moduleID=${CONTENT_MODULE_ID}&amp;topID=${HOME_CONTENT_ID}`;
    return html`
          <li${cfEq(ctx.session.siteid, entry.siteId) ? raw(' class="active"') : ''}>
            <a href="${raw(baseUrl)}&amp;siteID=${raw(entry.siteId)}"><i class="mi-globe"></i> ${entry.site}</a>
          </li>`;
  });
  return html`<li id="site-selector">
      <div class="btn-group">
        <a id="select-site-btn" class="btn btn-default" href="${raw(siteHomeUrl(ctx))}"><i class="mi-globe"></i> ${sessionSiteName(sc)}</a>
        <button type="button" class="btn btn-default dropdown-toggle" id="site-selector-trigger" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
          <span class="caret"></span>
        </button>
        <ul  id="site-selector-list" class="dropdown-menu">${filter}${items}
        </ul>
      </div>
    </li>`;
}

/** The header search `li` of `header.cfm` 161-173. */
function renderHeaderSearch(sc: ShellContext): SafeHtml {
  const placeholder = raw(sc.data.rb.rbKey('dashboard.search'));
  // Legacy's search target (`action="#"`, whose request answers 404) is reproduced, not fixed.
  return html`<li class="js-header-search header-search">
        <form class="form-horizontal" action="#" novalidate="novalidate" id="globalSearch" name="globalSearch" method="get">
          <div class="form-material form-material-primary input-group remove-margin-t remove-margin-b">
              <input class="form-control" type="text" id="mura-search-keywords" name="keywords" value="${raw(encodeHtmlAttr(sc.ctx.session.keywords))}" placeholder="${placeholder}">
              <span onclick="submitForm(document.forms.globalSearch);" class="input-group-addon" id="mura-search-submit"><i class="mi-search"></i></span>
          </div>
          <input type="hidden" name="muraAction" value="cArch.list">
          <input type="hidden" name="activetab" value="1">
          <input type="hidden" name="siteid" value="${raw(encodeHtmlAttr(sc.siteId))}">
          <input type="hidden" name="moduleid" value="${CONTENT_MODULE_ID}">
        </form>
      </li>`;
}

/** The user prompt `li`s of `header.cfm` 176-246, each only when its count is above zero. */
function renderUserPrompts(sc: ShellContext): SafeHtml[] {
  const { prompts } = sc.data;
  const siteId = raw(sc.ctx.session.siteid);
  const items = REPORT_PROMPTS.filter(([count]) => prompts[count] > 0).map(
    ([count, report, sortBy, text]) => html`
          <li>
            <a href="./?muraAction=cArch.list&moduleid=${CONTENT_MODULE_ID}&activeTab=1&report=${report}&siteID=${siteId}&reportSortby=${sortBy}&reportSortDirection=desc&refreshFlatview=true"><span class="badge">${prompts[count]}</span>${text}</a>
          </li>`,
  );
  if (prompts.pendingChangesets > 0) {
    items.push(html`
          <li>
            <a href="./?muraAction=cChangesets.list&siteid=${siteId}"><span class="badge">${prompts.pendingChangesets}</span> Changesets</a>
          </li>`);
  }
  return items;
}

/** The user tools `li` of `header.cfm` 249-275. */
function renderUserTools(sc: ShellContext, base: string): SafeHtml {
  const { rb, user, prompts } = sc.data;
  const tally = userPromptTally(prompts);
  const badge = tally > 0 ? html` <span class="badge">${tally}</span>` : '';
  const promptItems =
    tally > 0
      ? html`${renderUserPrompts(sc)}
          <li class="divider"></li>`
      : '';
  return html`<li id="user-tools-selector">
          <div class="btn-group">

            <a id="user-tools-name" tabindex="-1" class="btn btn-default" href="${raw(base)}/?muraAction=cEditProfile.edit"> <i class="mi-user"></i> ${`${user.fname} ${user.lname}`}</a>

              <button type="button" class="btn btn-default dropdown-toggle" id="site-selector-trigger" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                ${badge}<span class="caret"></span>
              </button>

              <ul class="dropdown-menu dropdown-menu-right mura-user-tools">${promptItems}

                  <li>
                      <a tabindex="-1" href="${raw(base)}/?muraAction=cEditProfile.edit"><i class="mi-cog"></i> ${raw(rb.rbKey('layout.editprofile'))}</a>
                  </li>
                  <li>
                      <a tabindex="-1" href="${raw(base)}/?muraAction=cLogin.logout"><i class="mi-sign-out"></i> ${raw(rb.rbKey('layout.logout'))}</a>
                  </li>

              </ul>
          </div>
      </li>`;
}

/** `header.cfm`: the admin header bar for a logged-in private user with a session site. */
export function renderHeader(sc: ShellContext): SafeHtml {
  const { context, adminDir } = legacySettings();
  const base = `${context}${adminDir}`;
  return html`<header id="header-navbar" class="content-mini content-mini-full">

  <!-- Header Navigation Left -->
  <ul class="nav-header pull-left">
    <!-- toggle sidebar -->
    <li class="hidden-xs hidden-sm">
      <!-- Layout API, functionality initialized in App() -> uiLayoutApi() -->
      <button id="mura-sidebar-toggle" class="btn btn-default" data-toggle="layout" data-action="sidebar_mini_toggle" type="button">
          <i class="mi-navicon"></i>
      </button>

      <button id="mura-sidebar-toggle-open" class="btn btn-default" data-toggle="layout" data-action="sidebar_mini_toggle" type="button">
          <i class="mi-navicon"></i>
      </button>
    </li>

    <li class="hidden-md hidden-lg">
      <!-- Layout API, functionality initialized in App() -> uiLayoutApi() -->
      <button class="btn btn-default" data-toggle="layout" data-action="sidebar_toggle" type="button">
          <i class="mi-navicon"></i>
      </button>
    </li>

    ${renderSiteSelector(sc, base)}

  </ul>
  <!-- END Header Navigation Left -->

  <!-- Header Navigation Right -->
  <ul class="nav-header pull-right">
      <li class="visible-xs">
          <!-- Toggle class helper (for .js-header-search below), functionality initialized in App() -> uiToggleClass() -->
          <button class="btn btn-default" data-toggle="class-toggle" data-target=".js-header-search" data-class="header-search-xs-visible" type="button">
              <i class="mi-search"></i>
          </button>
      </li>

      ${renderHeaderSearch(sc)}

      ${renderUserTools(sc, base)}

  </ul>
  <!-- END Header Navigation Right -->
</header>`;
}
