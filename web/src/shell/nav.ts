// Admin sidebar of `admin/common/layouts/includes/nav.cfm`: brand header, main menu and version box (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { formatDateTimeShort } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import type { ShellContext } from './types';

/** Core module ids the nav checks permissions and active states against. */
export const MODULE_IDS = Object.freeze({
  content: '00000000000000000000000000000000000',
  components: '00000000000000000000000000000000003',
  forms: '00000000000000000000000000000000004',
  email: '00000000000000000000000000000000005',
  users: '00000000000000000000000000000000008',
  mailingLists: '00000000000000000000000000000000009',
  categories: '00000000000000000000000000000000010',
  collections: '00000000000000000000000000000000011',
  changesets: '00000000000000000000000000000000014',
  comments: '00000000000000000000000000000000015',
  m016: '00000000000000000000000000000000016',
  m099: '00000000000000000000000000000000099',
});

/** One entry of the OPT-2 nav group: a synthetic module's landing screen and the roles that see it. */
export interface Opt2NavModule {
  readonly module: string;
  readonly screen: string;
  readonly label: string;
  readonly icon: string;
  readonly roles: readonly string[];
}

/** Synthetic-module screens of the OPT-2 nav group, in nav order. */
export const OPT2_NAV_MODULES: readonly Opt2NavModule[] = Object.freeze([
  {
    module: 'timesheets',
    screen: 'sheets',
    label: 'Timesheets',
    icon: 'mi-clock-o',
    roles: ['timesheets.employee', 'timesheets.primary-approver', 'timesheets.secondary-approver'],
  },
  { module: 'finance', screen: 'records', label: 'Finance', icon: 'mi-money', roles: ['finance.preparer', 'finance.approver'] },
  {
    module: 'e-signature',
    screen: 'requests',
    label: 'E-Signature',
    icon: 'mi-pencil',
    roles: ['esignature.signer', 'esignature.auditor'],
  },
  { module: 'reporting', screen: 'exports', label: 'Reporting', icon: 'mi-bar-chart', roles: ['reporting.exporter'] },
  { module: 'surveys', screen: 'surveys', label: 'Surveys', icon: 'mi-check-square-o', roles: ['surveys.manager'] },
  {
    module: 'communications',
    screen: 'templates',
    label: 'Communications',
    icon: 'mi-envelope',
    roles: ['communications.sender'],
  },
]);

const MSSQL_UPDATE_WARNING =
  '\\n\\nIf you are using MSSQL you must uncheck Maintain Connections in your CF administrator datasource settings ' +
  'before proceeding. You may turn it back on after the update is complete.';

const ACTIVE = raw(' class="active"');
const OPEN = raw(' class="open"');
const ACTIVE_CLASS = raw(' active');
const PLUGIN_DIVIDER = raw(`
                                <li class="divider"></li>`);

/** Values every nav rule reads, resolved once per render. */
interface NavState {
  readonly sc: ShellContext;
  readonly ctx: AdminRequest;
  /** `<context><adminDir>`. */
  readonly base: string;
  readonly context: string;
  /** `session.siteid`. */
  readonly sid: string;
  /** `esapiEncode('url', session.siteid)`. */
  readonly sidUrl: string;
  /** `rc.originalcircuit`. */
  readonly oc: string;
  /** `rc.originalfuseaction`. */
  readonly of: string;
  /** `rc.moduleid`. */
  readonly mid: string;
  /** `request.action`. */
  readonly action: string;
  /** `rc.action` after the nav's `cfparam`. */
  readonly rcAction: string;
  /** `rc.userid` after the nav's `cfparam`. */
  readonly rcUserId: string;
  /** Lower-cased names of the URL scope, for `isDefined('url.<name>')`. */
  readonly urlNames: ReadonlySet<string>;
}

/** CFML `eq`. */
const is = cfEq;

/** CFML `listFindNoCase(list, value) > 0`. */
const listFindNoCase = (list: string, value: string): boolean =>
  cfListToArray(list).some((item) => item.toLowerCase() === value.toLowerCase());

/** The constant attribute fragment `markup` when `flag` holds, else nothing. */
const when = (flag: boolean, markup: SafeHtml): SafeHtml | null => (flag ? markup : null);

/** URL-scope names: the forwarded request target's query, else the pairs of `rc.currentURL`. */
export function urlScopeNames(ctx: AdminRequest): ReadonlySet<string> {
  const target = ctx.headers.get(ORIGINAL_URL_HEADER);
  const names =
    target === null
      ? ctx.currentUrl
          .replace(/^\.\/\??/, '')
          .split('&')
          .map((pair) => pair.split('=', 1)[0] ?? '')
      : [...new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?') + 1) : '').keys()];
  return new Set(names.filter((name) => name !== '').map((name) => name.toLowerCase()));
}

/** Resolves the request values the nav rules compare (`nav.cfm` 67-84). */
function navState(sc: ShellContext): NavState {
  const { ctx } = sc;
  const { context, adminDir } = legacySettings();
  const sid = ctx.session.siteid;
  return {
    sc,
    ctx,
    base: `${context}${adminDir}`,
    context,
    sid,
    sidUrl: encodeUrl(sid),
    oc: sc.originalCircuit,
    of: sc.originalFuseaction,
    mid: ctx.rc.moduleid ?? '',
    action: ctx.action,
    rcAction: ctx.rc.action ?? '',
    rcUserId: ctx.rc.userid ?? '',
    urlNames: urlScopeNames(ctx),
  };
}

/** `isDefined('url.<name>')`. */
const hasUrl = (n: NavState, name: string): boolean => n.urlNames.has(name.toLowerCase());

/** `rc.$.rbKey(key)`, emitted unencoded as legacy does. */
const label = (n: NavState, key: string): SafeHtml => raw(n.sc.data.rb.rbKey(key));

/** `<context><adminDir>/?muraAction=<query>`, with the query as legacy writes it. */
const adminHref = (n: NavState, query: string): SafeHtml => raw(`${n.base}/?muraAction=${query}`);

/** One menu entry: icon and label inside an optionally active link. */
function menuItem(active: boolean, href: SafeHtml, icon: string, text: SafeHtml): SafeHtml {
  return html`
                    <li>
                        <a${when(active, ACTIVE)} href="${href}"><i class="${icon}"></i><span class="sidebar-mini-hide">${text}</span></a>
                    </li>`;
}

/** Brand header with the mobile close button (`nav.cfm` 92-111). */
function sideHeader(): SafeHtml {
  const image = (file: string): SafeHtml => raw(adminAssetUrl(`images/${file}`));
  return html`<!-- Side Header -->
            <div class="side-header side-content">
                <!-- Layout API, functionality initialized in App() -> uiLayoutApi() -->
                <button id="sidebar-mobile-close" class="btn btn-link text-gray pull-right hidden-md hidden-lg" type="button" data-toggle="layout" data-action="sidebar_close">
                    <i class="mi-close"></i>
                </button>
                <!-- Themes functionality initialized in App() -> uiHandleTheme() -->
                <div class="btn-group">
                    <span id="brand-logo-lg" class="brand" target="_blank">
                        <img src="${image('masa-logo-admin@2x.png')}" class="mura-logo">
                    </span>
                    <span id="brand-logo-min" class="brand" target="_blank">
                        <img src="${image('masa-icon@2x.png')}" class="mura-logo">
                        <span class="sidebar-mini-hide">
                            <img src="${image('masa-logo-text@2x.png')}" class="mura-logo-text">
                        </span>
                    </span>
                </div>
            </div>
            <!-- END Side Header -->`;
}

/** Dashboard entry for system users of a site that shows it (`nav.cfm` 119-123). */
function dashboard(n: NavState): SafeHtml | null {
  const showDashboard = (n.ctx.site?.record.showDashboard ?? 0) !== 0;
  if (!(showDashboard && n.ctx.isPrivateUser)) return null;
  return html`
                    <li id="admin-nav-dashboard">
                        <a${when(is(n.oc, 'cDashboard'), ACTIVE)} href="${adminHref(n, `cDashboard.main&amp;siteid=${n.sidUrl}&amp;span=${n.ctx.session.dashboardSpan}`)}"><i class="mi-dashboard"></i><span class="sidebar-mini-hide">${label(n, 'layout.dashboard')}</span></a>
                    </li>`;
}

/** Content entry; plugin `onAdminNavMainRender` output is empty in the target (`nav.cfm` 125-130). */
function content(n: NavState): SafeHtml {
  const active =
    is(n.oc, 'carch') ||
    is(n.oc, 'scaffold') ||
    is(n.oc, 'cform') ||
    (is(n.oc, 'cperm') && (is(n.of, 'main') || is(n.mid, MODULE_IDS.m016) || is(n.mid, MODULE_IDS.content)));
  return html`
                    <li>
                      <a id="navContentAdmin" ${when(active, ACTIVE)} href="${adminHref(n, `cArch.list&amp;siteid=${n.sidUrl}`)}"><i class="mi-edit"></i><span class="sidebar-mini-hide">${label(n, 'layout.contentmanager')}</span></a>
                    </li>`;
}

/** One flag- and permission-gated entry of the main menu. */
interface ModuleEntry {
  readonly shown: boolean;
  readonly active: boolean;
  readonly action: string;
  readonly icon: string;
  readonly rbKey: string;
}

/** Change Sets through Mailing Lists, each gated by its site flag and module permission (`nav.cfm` 132-182). */
function moduleEntries(n: NavState): SafeHtml[] {
  const site = n.ctx.site;
  const perm = (id: string): boolean => n.ctx.modulePerm(id);
  const inPerm = (id: string): boolean => is(n.oc, 'cPerm') && is(n.mid, id);
  // Without site data (programs-sites serves it to private admin users only) the flag-gated entries stay hidden.
  const emailBroadcaster = site?.emailBroadcaster === true;
  const entries: readonly ModuleEntry[] = [
    {
      shown: site?.hasChangesets === true && perm(MODULE_IDS.changesets),
      active: is(n.oc, 'cChangesets') || inPerm(MODULE_IDS.changesets),
      action: 'cChangesets.list',
      icon: 'mi-clone',
      rbKey: 'layout.changesets',
    },
    {
      shown: site?.hasComments === true && perm(MODULE_IDS.comments),
      active: is(n.oc, 'cComments') || inPerm(MODULE_IDS.comments),
      action: 'cComments.default',
      icon: 'mi-comments',
      rbKey: 'layout.comments',
    },
    {
      shown: perm(MODULE_IDS.categories),
      active: inPerm(MODULE_IDS.categories) || is(n.oc, 'cCategory'),
      action: 'cCategory.list',
      icon: 'mi-th',
      rbKey: 'layout.categories',
    },
    {
      shown: site?.hasFeedManager === true && perm(MODULE_IDS.collections),
      active: is(n.oc, 'cFeed') || inPerm(MODULE_IDS.collections),
      action: 'cFeed.list',
      icon: 'mi-list',
      rbKey: 'layout.contentcollections',
    },
    {
      shown: legacySettings().fileManagerEnabled,
      active: is(n.oc, 'cFilemanager'),
      action: 'cFilemanager.default',
      icon: 'mi-folder-open',
      rbKey: 'layout.filemanager',
    },
    {
      shown: emailBroadcaster && perm(MODULE_IDS.email),
      active: is(n.oc, 'cEmail') || inPerm(MODULE_IDS.email),
      action: 'cEmail.list',
      icon: 'mi-cog',
      rbKey: 'layout.emailbroadcaster',
    },
    {
      shown: emailBroadcaster && perm(MODULE_IDS.mailingLists),
      active: is(n.oc, 'cMailingList') || inPerm(MODULE_IDS.mailingLists),
      action: 'cMailingList.list',
      icon: 'mi-cog',
      rbKey: 'layout.mailinglists',
    },
  ];
  // These links carry the session site id unencoded, as legacy writes them.
  return entries
    .filter((entry) => entry.shown)
    .map((entry) =>
      menuItem(entry.active, adminHref(n, `${entry.action}&amp;siteid=${n.sid}`), entry.icon, label(n, entry.rbKey)),
    );
}

/** Users menu for site admins, S2 users and extranet user managers (`nav.cfm` 184-207). */
function users(n: NavState): SafeHtml | null {
  const site = n.ctx.site;
  if (!(n.ctx.isSiteAdmin || n.ctx.isS2 || (site?.extranet === true && n.ctx.modulePerm(MODULE_IDS.users)))) return null;
  const inPermUsers = is(n.oc, 'cPerm') && is(n.mid, MODULE_IDS.users);
  const open = is(n.oc, 'cusers') || (is(n.oc, 'cperm') && is(n.mid, MODULE_IDS.users));
  const submenuActive =
    listFindNoCase('cUsers,cPrivateUsers,cPublicUsers', n.oc) || (is(n.of, 'imagedetails') && hasUrl(n, 'userID'));
  const noUserId = n.rcUserId.length === 0;
  const ispublic = n.ctx.rc.ispublic;
  const isPublic = ispublic !== undefined && is(ispublic, '1');
  const inUsersWithId = is(n.oc, 'cusers') && n.rcUserId.length > 0;
  const viewUsers =
    (noUserId && isPublic && (is(n.action, 'core:cusers.listusers') || inUsersWithId)) || inPermUsers;
  const viewGroups = noUserId && isPublic && (is(n.action, 'core:cusers.list') || inPermUsers || inUsersWithId);
  const siteHref = (action: string): SafeHtml => adminHref(n, `${action}&amp;siteid=${n.sidUrl}`);
  return html`
                        <li id="admin-nav-users"${when(open, OPEN)}>
                            <a class="nav-submenu${when(submenuActive, ACTIVE_CLASS)}" data-toggle="nav-submenu" href="#"><i class="mi-users"></i><span class="sidebar-mini-hide">${label(n, 'layout.users')}</span></a>
                            <ul>
                                <li>
                                    <a${when(viewUsers, ACTIVE)} href="${siteHref('cUsers.listUsers')}"><i class="mi-user"></i><span class="sidebar-mini-hide">${label(n, 'user.viewusers')}</span></a>
                                </li>
                                <li>
                                    <a${when(viewGroups, ACTIVE)} href="${siteHref('cUsers.list')}"><i class="mi-users"></i><span class="sidebar-mini-hide">${label(n, 'user.viewgroups')}</span></a>
                                </li>
                                <li class="divider"></li>
                                <li>
                                    <a${when(is(n.action, 'core:cusers.edituser') && noUserId, ACTIVE)} href="${siteHref('cUsers.edituser')}&amp;userid="><i class="mi-user-plus"></i><span class="sidebar-mini-hide">${label(n, 'user.adduser')}</span></a>
                                </li>
                                <li>
                                    <a${when(is(n.action, 'core:cusers.editgroup') && noUserId, ACTIVE)} href="${siteHref('cUsers.editgroup')}&amp;userid="><i class="mi-user-plus"></i><span class="sidebar-mini-hide">${label(n, 'user.addgroup')}</span></a>
                                </li>
                            </ul>
                        </li>`;
}

/** Plugins menu for sites with plugins and for S2 users; the target holds no plugins (`nav.cfm` 209-235). */
function plugins(n: NavState): SafeHtml | null {
  const { sitePlugins } = n.sc.data;
  if (sitePlugins.length === 0 && !n.ctx.isS2) return null;
  const inPlugins = is(n.oc, 'cPlugins');
  const siteHref = adminHref(n, `cPlugins.list&amp;siteid=${n.sid}`);
  const pluginItems = sitePlugins.map(
    (plugin) => html`
                               <li>
                                <a${when(is(n.mid, plugin.moduleId), ACTIVE)} href="${raw(`${n.context}/plugins/${plugin.directory}/`)}"><i class="mi-plug"></i>${plugin.name}</a>
                              </li>`,
  );
  const addPlugin = (): SafeHtml => html`${sitePlugins.length > 0 ? PLUGIN_DIVIDER : null}
                              <li>
                                <a href="${adminHref(n, 'cSettings.list&plugins#tabPlugins')}"><i class="mi-plus-circle"></i><span class="sidebar-mini-hide">${label(n, 'layout.addplugin')}</span></a>
                              </li>`;
  return html`
                        <li class="divider"></li>
                        <li  id="admin-plugin-manager"${when(inPlugins, OPEN)}>
                          <a class="nav-submenu${when(inPlugins, ACTIVE_CLASS)}" data-toggle="nav-submenu" href="${siteHref}"><i class="mi-plug"></i><span class="sidebar-mini-hide">${label(n, 'layout.plugins')}</span></a>
                          <ul>
                            <li>
                              <a class="${when(is(n.oc, 'cplugins') && is(n.of, 'list'), ACTIVE_CLASS)}" href="${siteHref}"><i class="mi-plug"></i><span class="sidebar-mini-hide">Site Plugins</span></a>
                            </li>${pluginItems}${n.ctx.isS2 ? addPlugin() : null}
                          </ul>
                        </li>`;
}

/** settingsBean `getExportLocation()`: its setter ignores the value `export1`. */
function exportLocationOf(n: NavState): string {
  const location = n.ctx.site?.record.exportLocation ?? '';
  return is(location, 'export1') ? '' : location;
}

/** Export static HTML entry when the site's export directory exists (`nav.cfm` 287-291). */
function exportHtml(n: NavState, siteBeanId: string): SafeHtml | null {
  const location = exportLocationOf(n);
  if (!(location.length > 0 && n.sc.data.exportLocationExists)) return null;
  const title = n.sc.data.rb.rbKey('layout.exportstatichtml');
  const onclick =
    `confirmDialog('Export static HTML files to ${encodeJs(`'${location}'`)}.',` +
    `function(){actionModal('${n.base}/?muraAction=csettings.exportHTML&amp;siteID=${siteBeanId}')},` +
    `'','${title}','','','','dialog-confirm');return false;`;
  return html`
                                    <li>
                                        <a${when(is(n.oc, 'cSettings') && is(n.of, 'exportHtml'), ACTIVE)} href="#" onclick="${raw(onclick)}"><i class="mi-cog"></i><span class="sidebar-mini-hide">${raw(title)}</span></a>
                                    </li>`;
}

/** Class Extensions submenu (`nav.cfm` 256-276). */
function classExtensions(n: NavState): SafeHtml {
  const inExtend = (fuseaction: string): boolean => is(n.oc, 'cExtend') && is(n.of, fuseaction);
  // `rc.siteid` as the layout's defaulting leaves it (`template.cfm` 109-115).
  const rcSiteUrl = encodeUrl(n.sc.siteId);
  return html`
                                <li${when(is(n.oc, 'cextend'), OPEN)}>
                                    <a class="nav-submenu" data-toggle="nav-submenu" href="#"><i class="mi-wrench"></i>Class Extensions</a>
                                    <ul>
                                        <li>
                                            <a${when(inExtend('listSubTypes'), ACTIVE)} href="${adminHref(n, `cExtend.listSubTypes&amp;siteid=${n.sidUrl}`)}"><i class="mi-cog"></i><span class="sidebar-mini-hide">${label(n, 'layout.classextensionmanager')}</span></a>
                                        </li>
                                        <li>
                                            <a${when(inExtend('editSubType'), ACTIVE)} href="${adminHref(n, `cExtend.editSubType&amp;subTypeID=&amp;siteid=${n.sidUrl}`)}"><i class="mi-plus-circle"></i><span class="sidebar-mini-hide">${label(n, 'layout.addclassextension')}</span></a>
                                        </li>
                                        <li>
                                            <a${when(inExtend('importSubTypes'), ACTIVE)} href="${adminHref(n, `cExtend.importSubTypes&amp;siteid=${rcSiteUrl}`)}"><i class="mi-sign-in"></i><span class="sidebar-mini-hide">${label(n, 'layout.importclassextensions')}</span></a>
                                        </li>
                                        <li>
                                            <a${when(inExtend('exportSubType'), ACTIVE)} href="${adminHref(n, `cExtend.exportSubType&amp;siteid=${rcSiteUrl}`)}"><i class="mi-sign-out"></i><span class="sidebar-mini-hide">${label(n, 'layout.exportclassextensions')}</span></a>
                                        </li>
                                    </ul>
                                </li>`;
}

/** S2-only Web Services, JSON API and Trash Bin entries (`nav.cfm` 292-303). */
function s2SiteEntries(n: NavState): SafeHtml {
  return html`
                                    <li>
                                        <a${when(is(n.oc, 'cwebservice'), ACTIVE)} href="${adminHref(n, `cwebservice.list&amp;siteid=${n.sidUrl}`)}"><i class="mi-exchange"></i><span class="sidebar-mini-hide">Web Services (REST)</span></a>
                                    </li>
                                    <li>
                                        <a target="_blank" href="${raw(`${n.context}/index.cfm/_api/json/v1/${n.sidUrl}`)}"><i class="mi-exchange"></i><span class="sidebar-mini-hide">JSON API</span></a>
                                    </li>
                                    <li>
                                        <a${when(is(n.oc, 'cTrash'), ACTIVE)} href="${adminHref(n, `cTrash.list&amp;siteID=${n.sidUrl}`)}"><i class="mi-trash"></i><span class="sidebar-mini-hide">${label(n, 'layout.trashbin')}</span></a>
                                    </li>`;
}

/** Site Settings menu for site admins and S2 users (`nav.cfm` 238-306). */
function siteSettings(n: NavState): SafeHtml | null {
  if (!(n.ctx.isSiteAdmin || n.ctx.isS2)) return null;
  const isSiteConfig =
    (is(n.oc, 'cPerm') && is(n.of, 'module') && is(n.mid, MODULE_IDS.content)) ||
    (listFindNoCase('csettings,cextend,ctrash,cchain,cwebservice', n.oc) &&
      !(is(n.action, 'core:csettings.list') || is(n.action, 'core:csettings.sitecopy') || hasUrl(n, 'addsite')));
  const pluginEdit = is(n.of, 'editPlugin') || is(n.of, 'updatePluginVersion');
  const editSiteActive =
    is(n.oc, 'cSettings') &&
    is(n.of, 'editSite') &&
    !is(n.rcAction, 'updateFiles') &&
    !hasUrl(n, 'addsite') &&
    !hasUrl(n, 'deploybundle');
  const permissionsActive = is(n.oc, 'cPerm') && is(n.of, 'module') && is(n.mid, MODULE_IDS.content);
  const siteBeanId = n.ctx.site?.siteid ?? n.sid;
  return html`
                        <li id="admin-nav-site-config"${when(isSiteConfig && !pluginEdit && !is(n.of, 'siteCopySelect'), OPEN)}>
                            <a class="nav-submenu${when(isSiteConfig && !pluginEdit, ACTIVE_CLASS)}" data-toggle="nav-submenu" href="${raw(`${n.base}/`)}"><i class="mi-sliders"></i><span class="sidebar-mini-hide">${label(n, 'layout.sitesettings')}</span></a>
                            <ul>
                                <li>
                                    <a${when(editSiteActive, ACTIVE)} href="${adminHref(n, `cSettings.editSite&amp;siteid=${n.sidUrl}`)}"><i class="mi-edit"></i><span class="sidebar-mini-hide">${label(n, 'layout.editcurrentsite')}</span></a>
                                </li>
                                <li>
                                    <a${when(permissionsActive, ACTIVE)} href="${adminHref(n, `cPerm.module&amp;contentid=${MODULE_IDS.content}&amp;siteid=${n.sidUrl}&amp;moduleid=${MODULE_IDS.content}`)}"><i class="mi-users"></i>Permissions</a>
                                </li>
                                <li>
                                    <a${when(is(n.oc, 'cChain'), ACTIVE)} href="${adminHref(n, `cChain.list&amp;siteid=${n.sidUrl}`)}"><i class="mi-check"></i><span class="sidebar-mini-hide">${label(n, 'layout.approvalchains')}</span></a>
                                </li>${classExtensions(n)}
                                <li>
                                    <a${when(is(n.oc, 'cSettings') && is(n.of, 'selectBundleOptions'), ACTIVE)} href="${adminHref(n, `cSettings.selectBundleOptions&amp;siteID=${encodeUrl(siteBeanId)}`)}"><i class="mi-gift"></i><span class="sidebar-mini-hide">${label(n, 'layout.createsitebundle')}</span></a>
                                </li>
                                <li>
                                    <a${when(hasUrl(n, 'deployBundle'), ACTIVE)} href="${adminHref(n, `cSettings.editSite&amp;siteid=${n.sidUrl}&amp;deployBundle#tabBundles`)}"><i class="mi-download"></i><span class="sidebar-mini-hide">${label(n, 'layout.deploysitebundle')}</span></a>
                                </li>${exportHtml(n, siteBeanId)}${n.ctx.isS2 ? s2SiteEntries(n) : null}
                            </ul>
                        </li>`;
}

/** Update Core entry shared by Global Settings and the version box (`nav.cfm` 331-335, 377-381). */
function updateCore(n: NavState): SafeHtml {
  const title = n.sc.data.rb.rbKey('layout.updatemuracore');
  const warning = is(legacySettings().dbType, 'mssql') ? MSSQL_UPDATE_WARNING : '';
  const onclick =
    `confirmDialog('WARNING: Do not update your core files unless you have backed up your current Masa CMS install.${warning}',` +
    `function(){actionModal('${n.base}/?muraAction=cSettings.list&action=updateCore${n.sc.data.updateCoreCsrfQuery}')},` +
    `'','${title}','','','','dialog-warning');return false;`;
  return html`
                                    <li>
                                        <a${when(is(n.oc, 'cSettings') && is(n.rcAction, 'updateCore'), ACTIVE)} href="#" onclick="${raw(onclick)}"><i class="mi-cloud-download"></i><span class="sidebar-mini-hide">${raw(title)}</span></a>
                                    </li>`;
}

/** configBean `allowAutoUpdates`; the CSRF-renderer check of the legacy condition always holds. */
const allowsCoreUpdates = (): boolean => legacySettings().allowAutoUpdates;

/** ACF `expandPath`: roots every path at the web root, an `s3://` URL included (`s3://b` gives `<webroot>/s3:/b`). */
const expandPath = (path: string): string => `${legacySettings().webroot}/${path}`.replace(/[/\\]+/g, '/');

/** Global Settings menu for S2 users (`nav.cfm` 308-342). */
function globalSettings(n: NavState): SafeHtml | null {
  if (!n.ctx.isS2) return null;
  const inSettingsList = is(n.oc, 'cSettings') && is(n.of, 'list');
  const { appReloadKey, fileDir } = legacySettings();
  const reloadKey = encodeUrl(appReloadKey);
  const s3FileDir = is(cfListToArray(expandPath(fileDir), ':')[0] ?? '', 's3');
  const copySite = (): SafeHtml => html`
	                                <li>
	                                    <a${when(is(n.oc, 'cSettings') && is(n.of, 'siteCopySelect'), ACTIVE)} href="${adminHref(n, 'cSettings.sitecopyselect')}"><i class="mi-copy"></i><span class="sidebar-mini-hide">${label(n, 'layout.sitecopytool')}</span></a>
	                                </li>`;
  return html`
                        <li id="admin-nav-global">
                            <a class="nav-submenu" data-toggle="nav-submenu" href="${raw(`${n.base}/`)}"><i class="mi-cogs"></i><span class="sidebar-mini-hide">${label(n, 'layout.globalconfig')}</span></a>
                            <ul>
                                <li>
                                    <a${when(inSettingsList && !hasUrl(n, 'plugins'), ACTIVE)} href="${adminHref(n, 'cSettings.list')}"><i class="mi-cogs"></i><span class="sidebar-mini-hide">${label(n, 'layout.globalsettings-sites')}</span></a>
                                </li>
                                <li>
                                    <a${when(hasUrl(n, 'addsite'), ACTIVE)} href="${adminHref(n, 'cSettings.editSite&amp;siteid=&amp;addsite')}"><i class="mi-plus-circle"></i><span class="sidebar-mini-hide">${label(n, 'layout.addsite')}</span></a>
                                </li>${s3FileDir ? null : copySite()}
                                <li>
                                    <a${when(inSettingsList && hasUrl(n, 'plugins'), ACTIVE)} href="${adminHref(n, 'cSettings.list&plugins#tabPlugins')}"><i class="mi-plug"></i><span class="sidebar-mini-hide">${label(n, 'layout.globalsettings-plugins')}</span></a>
                                </li>${allowsCoreUpdates() ? updateCore(n) : null}
                                <li>
                                    <a href="${raw(`${n.base}/?${reloadKey}&amp;reload=${reloadKey}`)}" onclick="return actionModal(this.href);"><i class="mi-refresh"></i><span class="sidebar-mini-hide">${label(n, 'layout.reloadapplication')}</span></a>
                                </li>
                            </ul>
                        </li>`;
}

/** OPT-2 group linking the synthetic-module screens the user's roles reach; absent when none does. */
function opt2Group(n: NavState): SafeHtml | null {
  const visible = OPT2_NAV_MODULES.filter((entry) => entry.roles.some((role) => n.ctx.roles.includes(role)));
  if (visible.length === 0) return null;
  const current = n.sc.view.opt2Module;
  const inOpt2 = current !== undefined && current !== '';
  const items = visible.map(
    (entry) => html`
                            <li>
                                <a${when(current === entry.module, ACTIVE)} href="${raw(`/opt2/admin/${entry.module}/${entry.screen}?siteid=${n.sidUrl}`)}"><i class="${entry.icon}"></i><span class="sidebar-mini-hide">${entry.label}</span></a>
                            </li>`,
  );
  return html`
                    <li id="admin-nav-opt2"${when(inOpt2, OPEN)}>
                        <a class="nav-submenu${when(inOpt2, ACTIVE_CLASS)}" data-toggle="nav-submenu" href="#"><i class="mi-cubes"></i><span class="sidebar-mini-hide">OPT-2</span></a>
                        <ul>${items}
                        </ul>
                    </li>`;
}

/** Help menu of documentation and support links (`nav.cfm` 344-364). */
function help(n: NavState): SafeHtml {
  return html`
                    <li id="admin-nav-help">
                        <a class="nav-submenu" data-toggle="nav-submenu" href="${raw(`${n.base}/`)}"><i class="mi-question-circle"></i><span class="sidebar-mini-hide">${label(n, 'layout.help')}</span></a>
                        <ul>
                            <li>
                                <a id="navCSS-API" href="https://www.masacms.com/documentation" target="_blank"><i class="mi-bookmark"></i><span class="sidebar-mini-hide">${label(n, 'layout.developers')}</span></a>
                            </li>
                            <li>
                                <a id="navFckEditorDocs" href="http://docs.cksource.com/" target="_blank"><i class="mi-bookmark"></i><span class="sidebar-mini-hide">${label(n, 'layout.editordocumentation')}</span></a>
                            </li>
                            <li>
                                <a id="navHelpDocs" href="https://www.wearenorth.eu/" target="_blank"><i class="mi-group"></i><span class="sidebar-mini-hide">${label(n, 'layout.support')}</span></a>
                            </li>
                            <li>
                                <a id="navHelpForums" href="https://www.masacms.com/" target="_blank"><i class="mi-bullhorn"></i><span class="sidebar-mini-hide">${label(n, 'layout.supportforum')}</span></a>
                            </li>
                        </ul>
                    </li>`;
}

/** App server, database, Java and OS rows; omitted when no legacy runtime facts are loaded (`nav.cfm` 383-407). */
function serverRows(n: NavState): SafeHtml | null {
  const { server } = n.sc.data;
  if (server === null) return null;
  const appServer = cfListToArray(server.appServerProductName, ' ')[0] ?? '';
  // An empty Java or OS value stands for the server-scope key legacy's structKeyExists finds absent.
  const java = (): SafeHtml => html`
                                <li>
                                    <a class="no-link" href="#"> <strong>${label(n, 'version.java')}</strong> ${raw(server.javaVersion)}</a>
                                </li>`;
  const database = (): SafeHtml => html`
                            <li>
                                <a class="no-link" href="#"> <span><strong>${label(n, 'version.dbserver')}</strong> ${raw(server.dbProductName)} (${raw(server.dbProductVersion)})</span></a>
                            </li>${server.javaVersion === '' ? null : java()}`;
  const os = (): SafeHtml => html`
                                <li>
                                    <a class="no-link" href="#"> <span><strong>${label(n, 'version.os')}</strong> ${raw(server.osName)} (${raw(server.osVersion)})</span></a>
                                </li>`;
  return html`
                            <li>
                                <a class="no-link" href="#"> <span><strong>${label(n, 'version.appserver')}</strong> ${raw(appServer)} (${raw(server.appServerVersion)})</span></a>
                            </li>${legacySettings().javaEnabled ? database() : null}${server.osName === '' ? null : os()}`;
}

/** Last Deployment row of a staging install; `Never` where legacy's date formatting fails (`nav.cfm` 409-420). */
function lastDeployment(n: NavState): SafeHtml | null {
  if (!(is(legacySettings().mode, 'Staging') && n.sid !== '' && n.ctx.isLoggedIn)) return null;
  // An unset deployment prints blank, as LSDateFormat('') does; only an unparsable value reaches the catch.
  let deployed: string;
  try {
    deployed = formatDateTimeShort(n.ctx.site?.lastDeployment, n.ctx.session.dateKeyFormat, n.ctx.session.locale);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    deployed = 'Never';
  }
  return html`
                                <li>
                                     <a class="no-link" href="#"> <span><strong>Last Deployment</strong>
                                            ${raw(deployed)}
                                     </span></a>
                                </li>`;
}

/** Version box: core version, Update Core for S2, runtime rows, deployment and copyright (`nav.cfm` 366-429). */
function version(n: NavState): SafeHtml {
  const year = n.sc.data.now.getFullYear();
  return html`
                    <li>
                        <a class="nav-submenu" data-toggle="nav-submenu" href="${raw(`${n.base}/`)}"><i class="mi-info-circle"></i><span class="sidebar-mini-hide">${label(n, 'layout.version')}</span></a>
                        <ul class="version">
                            <li class="divider"></li>
                            <li>
                                <a class="no-link" href="#">
                                 <span><strong>${label(n, 'version.core')}</strong> ${raw(legacySettings().version)}</span>
                                 </a>
                             </li>${n.ctx.isS2 && allowsCoreUpdates() ? updateCore(n) : null}
                            <li class="divider"></li>${serverRows(n)}${lastDeployment(n)}
                             <li>
                                <a href="https://github.com/blueriver/MuraCMS/blob/develop/license.txt" target="_blank"><span><strong>Mura CMS</strong> &copy; ${year} blueriver <em>Licensed under GNU General Public License Version 2.0 with exceptions</em></span></a>
                            </li>
                             <li>
                                <a href="https://github.com/MasaCMS/MasaCMS/blob/main/license.txt" target="_blank"><span><strong>Masa CMS</strong> &copy; ${year} We Are North Groep BV <em>Licensed under GNU General Public License Version 2.0 with exceptions</em></span></a>
                            </li>
                        </ul>
                    </li>`;
}

/** Main menu of a logged-in private user on a site (`nav.cfm` 113-433). */
function mainMenu(n: NavState): SafeHtml {
  const entries = [
    dashboard(n),
    content(n),
    ...moduleEntries(n),
    users(n),
    plugins(n),
    siteSettings(n),
    globalSettings(n),
    opt2Group(n),
    help(n),
    version(n),
  ];
  return html`
            <div class="side-content">
                <ul class="nav-main">${entries}
                </ul>
            </div>
            <!-- END Side Content -->`;
}

/** The `<nav id="sidebar">` markup `template.cfm` includes for the session's user and site. */
export function renderNav(sc: ShellContext): SafeHtml {
  const n = navState(sc);
  const showMenu = n.sid !== '' && sc.ctx.isLoggedIn && sc.ctx.isPrivateUser;
  return html`<nav id="sidebar">
    <!-- Sidebar Scroll Container -->
    <div id="sidebar-scroll">
        <!-- Sidebar Content -->
        <!-- Adding .sidebar-mini-hide to an element will hide it when the sidebar is in mini mode -->
        <div class="sidebar-content">
            ${sideHeader()}${showMenu ? mainMenu(n) : null}
        </div>
        <!-- Sidebar Content -->
    </div>
    <!-- END Sidebar Scroll Container -->
</nav>`;
}
