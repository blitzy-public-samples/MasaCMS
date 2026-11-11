// Sidebar nav of admin/common/layouts/includes/nav.cfm against legacy-rendered markup and its visibility rules.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, SYNTHETIC_ROLES, moduleRole } from '@opt2/platform/auth';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, raw, toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { APP_RELOAD_KEY, FILE_DIR, JAVA_ENABLED, MODULE_IDS, OPT2_NAV_MODULES, renderNav } from '@/shell/nav';
import type { LegacyServerInfo, ShellContext, ShellData, ShellView } from '@/shell/types';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  noSitesRequest,
  opt2RoleRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../helpers/admin-request';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/shell');
const Z = '00000000000000000000000000000000';

/** Runtime facts of the ACF 2023 oracle the fixtures were captured from; ACF exposes no `server.java.version`. */
const ORACLE_SERVER: LegacyServerInfo = {
  appServerProductName: 'ColdFusion Server',
  appServerVersion: '2023,0,26,331018',
  dbProductName: 'Microsoft SQL Server',
  dbProductVersion: 'Microsoft SQL Server 2022 - 16.0.4305.5',
  javaVersion: '',
  osName: 'UNIX',
  osVersion: '6.12.105+',
};

/** The captures' CSRF query, with the token values replaced. */
const CSRF_QUERY = '&csrf_token=TOKEN&csrf_token_expires=EXP';

/** Flags of the installed `default` site: change sets, comments and collections on. */
const DEFAULT_SITE_FLAGS = { hasChangesets: true, hasComments: true, hasFeedManager: true } as const;

/** Legacy-rendered nav, as captured with the reload key and CSRF tokens replaced. */
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** Marks of the active Content entry and the open Site Settings menu on `default`. */
const CONTENT_MARK = 'a#navContentAdmin.active cArch.list&siteid=default';
const SITE_CONFIG_MARKS = ['li#admin-nav-site-config.open', 'a.nav-submenu.active /admin/'];

/** Markup with whitespace between tags dropped and other whitespace runs collapsed. */
const squash = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/** The shell context the layout hands the nav for `ctx`. */
function shell(
  ctx: AdminRequest,
  data: Partial<ShellData> = {},
  view: Partial<ShellView> = {},
): ShellContext {
  const [circuit = '', item = ''] = (ctx.action.split(':').at(-1) ?? '').split('.');
  return {
    ctx,
    view: { body: raw(''), ...view },
    hooks: { secondaryMenus: {} },
    data: {
      rb: rbFor('en_US'),
      user: { fname: 'Admin', lname: 'User', passwordExpired: false, hasDefaultPassword: false },
      userSites: [],
      prompts: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
      sitePlugins: [],
      server: ORACLE_SERVER,
      updateCoreCsrfQuery: CSRF_QUERY,
      exportLocationExists: false,
      now: new Date(2026, 5, 30, 12),
      ...data,
    },
    layout: 'template',
    originalCircuit: circuit,
    originalFuseaction: item,
    moduleTitle: '',
    bodyclass: '',
    siteId: ctx.rc.siteid || ctx.session.siteid || 'default',
  };
}

/** The nav markup for `sc`, asserted to be module-made markup. */
function render(sc: ShellContext): string {
  const markup = renderNav(sc);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** An S2 admin request on `default` whose URL scope holds `query`. */
const adminOn = (partial: AdminRequestPartial, query = ''): AdminRequest =>
  adminS2Request({ site: DEFAULT_SITE_FLAGS, currentUrl: `./?&muraAction=x${query}`, ...partial });

/** `tag#id.classes [href]` of every element marked `active` or `open`, in document order. */
function marks(markup: string): string[] {
  const $ = cheerio.load(markup, null, false);
  return $('[class]')
    .toArray()
    .filter((el) => /(^|\s)(active|open)(\s|$)/.test($(el).attr('class') ?? ''))
    .map((el) => {
      const node = $(el);
      const id = node.attr('id') === undefined ? '' : `#${node.attr('id')}`;
      const classes = (node.attr('class') ?? '').trim().split(/\s+/).join('.');
      const href = el.tagName === 'a' ? ` ${(node.attr('href') ?? '').replace('/admin/?muraAction=', '')}` : '';
      return `${el.tagName}${id}.${classes}${href}`;
    });
}

/** The links of the nav as `text -> href`. */
function links(markup: string): string[] {
  const $ = cheerio.load(markup, null, false);
  return $('a[href]')
    .toArray()
    .map((el) => `${$(el).text().replace(/\s+/g, ' ').trim()} -> ${$(el).attr('href') ?? ''}`);
}

/** Whether the nav links `action` (the start of its `muraAction` query). */
const linksTo = (markup: string, action: string): boolean => markup.includes(`?muraAction=${action}`);

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  vi.stubEnv('MURA_DBTYPE', 'mssql');
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('exports', () => {
  it('names the 35-character core module ids', () => {
    expect(Object.values(MODULE_IDS).every((id) => /^0{32}\d{3}$/.test(id))).toBe(true);
    expect(MODULE_IDS).toMatchObject({
      content: `${Z}000`,
      components: `${Z}003`,
      forms: `${Z}004`,
      email: `${Z}005`,
      users: `${Z}008`,
      mailingLists: `${Z}009`,
      categories: `${Z}010`,
      collections: `${Z}011`,
      changesets: `${Z}014`,
      comments: `${Z}015`,
      m016: `${Z}016`,
      m099: `${Z}099`,
    });
    expect(Object.isFrozen(MODULE_IDS)).toBe(true);
  });

  it('keeps the legacy defaults of the settings web does not carry', () => {
    expect([APP_RELOAD_KEY, JAVA_ENABLED, FILE_DIR]).toEqual(['appreload', true, '']);
  });

  it('lists the OPT-2 screens in nav order, one per synthetic module, covering every synthetic role', () => {
    expect(OPT2_NAV_MODULES.map((entry) => `${entry.module}/${entry.screen}`)).toEqual([
      'timesheets/sheets',
      'finance/records',
      'e-signature/requests',
      'reporting/exports',
      'surveys/surveys',
      'communications/templates',
    ]);
    expect(OPT2_NAV_MODULES.flatMap((entry) => entry.roles).sort()).toEqual([...SYNTHETIC_ROLES].sort());
    expect(Object.isFrozen(OPT2_NAV_MODULES)).toBe(true);
  });
});

describe('legacy-rendered markup', () => {
  it('matches the S2 admin nav on cArch.list', () => {
    const ctx = adminOn({ circuit: 'cArch', item: 'list' }, '&siteid=default');
    expect(squash(render(shell(ctx)))).toBe(squash(fixture('nav-admin-carch.html')));
  });

  it('matches the qa_editor nav on cArch.list', () => {
    const ctx = editorRequest({ circuit: 'cArch', item: 'list', currentUrl: './?&muraAction=cArch.list' });
    expect(squash(render(shell(ctx)))).toBe(squash(fixture('nav-editor-carch.html')));
  });

  it('matches the S2 nav of a site with the dashboard, extranet and an export directory, and no change sets or comments', () => {
    const ctx = adminS2Request({
      circuit: 'cDashboard',
      item: 'main',
      currentUrl: './?&muraAction=cDashboard.main&siteid=default&span=30',
      site: {
        hasChangesets: false,
        hasComments: false,
        hasFeedManager: true,
        extranet: true,
        record: { showDashboard: 1, exportLocation: '/tmp' },
      },
    });
    expect(squash(render(shell(ctx, { exportLocationExists: true })))).toBe(squash(fixture('nav-admin-dashboard.html')));
  });
});

describe('active and open states', () => {
  const usersOpen = ['li#admin-nav-users.open', 'a.nav-submenu.active #'];
  // Expectations are the marks of the legacy capture of the same request where one was taken, else nav.cfm's conditions.
  it.each<[string, AdminRequestPartial, string, string[]]>([
    ['cArch.list', { circuit: 'cArch', item: 'list' }, '', [CONTENT_MARK]],
    ['cArch.imagedetails with url.userID', { circuit: 'cArch', item: 'imagedetails' }, '&userID=abc', [CONTENT_MARK, 'a.nav-submenu.active #']],
    ['cUsers.listUsers?ispublic=1', { circuit: 'cUsers', item: 'listUsers', rc: { ispublic: '1' } }, '&ispublic=1', [...usersOpen, 'a.active cUsers.listUsers&siteid=default']],
    ['cUsers.listUsers with a userid', { circuit: 'cUsers', item: 'listUsers', rc: { ispublic: '1', userid: 'X' } }, '', usersOpen],
    ['cUsers.list?ispublic=0', { circuit: 'cUsers', item: 'list', rc: { ispublic: '0' } }, '', usersOpen],
    ['cUsers.list?ispublic=1', { circuit: 'cUsers', item: 'list', rc: { ispublic: '1' } }, '', [...usersOpen, 'a.active cUsers.list&siteid=default']],
    ['cUsers.edituser without a userid', { circuit: 'cUsers', item: 'edituser', rc: { userid: '' } }, '', [...usersOpen, 'a.active cUsers.edituser&siteid=default&userid=']],
    ['cUsers.editUser with a userid', { circuit: 'cUsers', item: 'editUser', rc: { userid: 'U1', ispublic: '1' } }, '', usersOpen],
    ['cUsers.editgroup without a userid', { circuit: 'cUsers', item: 'editgroup' }, '', [...usersOpen, 'a.active cUsers.editgroup&siteid=default&userid=']],
    ['cPerm.module 000', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}000` } }, '', [CONTENT_MARK, ...SITE_CONFIG_MARKS, `a.active cPerm.module&contentid=${Z}000&siteid=default&moduleid=${Z}000`]],
    ['cPerm.module 008', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}008` } }, '', ['li#admin-nav-users.open', 'a.active cUsers.listUsers&siteid=default']],
    ['cPerm.module 010', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}010` } }, '', ['a.active cCategory.list&siteid=default']],
    ['cPerm.module 011', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}011` } }, '', ['a.active cFeed.list&siteid=default']],
    ['cPerm.module 014', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}014` } }, '', ['a.active cChangesets.list&siteid=default']],
    ['cPerm.module 015', { circuit: 'cPerm', item: 'module', rc: { moduleid: `${Z}015` } }, '', ['a.active cComments.default&siteid=default']],
    ['cPerm.main 016', { circuit: 'cPerm', item: 'main', rc: { moduleid: `${Z}016` } }, '', [CONTENT_MARK]],
    ['cCategory.list', { circuit: 'cCategory', item: 'list' }, '', ['a.active cCategory.list&siteid=default']],
    ['cFeed.list', { circuit: 'cFeed', item: 'list' }, '', ['a.active cFeed.list&siteid=default']],
    ['cChangesets.list', { circuit: 'cChangesets', item: 'list' }, '', ['a.active cChangesets.list&siteid=default']],
    ['cComments.default', { circuit: 'cComments', item: 'default' }, '', ['a.active cComments.default&siteid=default']],
    ['cFilemanager.default', { circuit: 'cFilemanager', item: 'default' }, '', ['a.active cFilemanager.default&siteid=default']],
    ['cSettings.list', { circuit: 'cSettings', item: 'list' }, '', ['a.active cSettings.list']],
    ['cSettings.list?plugins', { circuit: 'cSettings', item: 'list' }, '&plugins=', ['a.active cSettings.list&plugins#tabPlugins']],
    ['cSettings.editSite', { circuit: 'cSettings', item: 'editSite', rc: { siteid: 'default' } }, '', [...SITE_CONFIG_MARKS, 'a.active cSettings.editSite&siteid=default']],
    ['cSettings.editSite?addsite', { circuit: 'cSettings', item: 'editSite', rc: { siteid: '' } }, '&siteid=&addsite=', ['a.active cSettings.editSite&siteid=&addsite']],
    ['cSettings.editSite?deployBundle', { circuit: 'cSettings', item: 'editSite', rc: { siteid: 'default' } }, '&deployBundle=', [...SITE_CONFIG_MARKS, 'a.active cSettings.editSite&siteid=default&deployBundle#tabBundles']],
    ['cSettings.editSite action=updateFiles', { circuit: 'cSettings', item: 'editSite', rc: { action: 'updateFiles' } }, '', SITE_CONFIG_MARKS],
    ['cSettings.sitecopyselect', { circuit: 'cSettings', item: 'sitecopyselect' }, '', ['a.nav-submenu.active /admin/', 'a.active cSettings.sitecopyselect']],
    ['cSettings.sitecopy', { circuit: 'cSettings', item: 'sitecopy' }, '', []],
    ['cSettings.selectBundleOptions', { circuit: 'cSettings', item: 'selectBundleOptions' }, '', [...SITE_CONFIG_MARKS, 'a.active cSettings.selectBundleOptions&siteID=default']],
    ['cSettings.editPlugin', { circuit: 'cSettings', item: 'editPlugin' }, '', []],
    ['cSettings.list action=updateCore', { circuit: 'cSettings', item: 'list', rc: { action: 'updateCore' } }, '', ['a.active cSettings.list', 'a.active #', 'a.active #']],
    ['cChain.list', { circuit: 'cChain', item: 'list' }, '', [...SITE_CONFIG_MARKS, 'a.active cChain.list&siteid=default']],
    ['cExtend.listSubTypes', { circuit: 'cExtend', item: 'listSubTypes' }, '', [...SITE_CONFIG_MARKS, 'li.open', 'a.active cExtend.listSubTypes&siteid=default']],
    ['cExtend.editSubType', { circuit: 'cExtend', item: 'editSubType' }, '', [...SITE_CONFIG_MARKS, 'li.open', 'a.active cExtend.editSubType&subTypeID=&siteid=default']],
    ['cExtend.importSubTypes', { circuit: 'cExtend', item: 'importSubTypes' }, '', [...SITE_CONFIG_MARKS, 'li.open', 'a.active cExtend.importSubTypes&siteid=default']],
    ['cExtend.exportSubType', { circuit: 'cExtend', item: 'exportSubType' }, '', [...SITE_CONFIG_MARKS, 'li.open', 'a.active cExtend.exportSubType&siteid=default']],
    ['cwebservice.list', { circuit: 'cwebservice', item: 'list' }, '', [...SITE_CONFIG_MARKS, 'a.active cwebservice.list&siteid=default']],
    ['cTrash.list', { circuit: 'cTrash', item: 'list' }, '', [...SITE_CONFIG_MARKS, 'a.active cTrash.list&siteID=default']],
    ['cPlugins.list', { circuit: 'cPlugins', item: 'list' }, '', ['li#admin-plugin-manager.open', 'a.nav-submenu.active cPlugins.list&siteid=default', 'a.active cPlugins.list&siteid=default']],
    ['cDashboard.main', { circuit: 'cDashboard', item: 'main' }, '', []],
    ['cform.default', { circuit: 'cform', item: 'default' }, '', [CONTENT_MARK]],
    ['scaffold.default', { circuit: 'scaffold', item: 'default' }, '', [CONTENT_MARK]],
  ])('marks %s as legacy does', (_, partial, query, expected) => {
    expect(marks(render(shell(adminOn(partial, query))))).toEqual(expected);
  });

  it('compares module ids as CFML numbers', () => {
    const ctx = adminOn({ circuit: 'cPerm', item: 'module', rc: { moduleid: '10' } });
    expect(marks(render(shell(ctx)))).toEqual(['a.active cCategory.list&siteid=default']);
  });

  it('reads URL-scope names from the forwarded request target rather than decoded values', () => {
    const forwarded = (target: string): AdminRequest =>
      adminS2Request({
        circuit: 'cSettings',
        item: 'editSite',
        rc: { siteid: '' },
        currentUrl: './?&muraAction=cSettings.editSite&q=a&addsite',
        headers: new Headers({ [ORIGINAL_URL_HEADER]: target }),
      });
    const addSite = 'a.active cSettings.editSite&siteid=&addsite';
    expect(marks(render(shell(forwarded('/admin/?muraAction=cSettings.editSite&siteid=&addsite'))))).toContain(addSite);
    expect(marks(render(shell(forwarded('/admin/?muraAction=cSettings.editSite&q=a%26addsite'))))).not.toContain(addSite);
    expect(marks(render(shell(forwarded('/admin/index.cfm'))))).toEqual([
      'li#admin-nav-site-config.open',
      'a.nav-submenu.active /admin/',
      'a.active cSettings.editSite&siteid=default',
    ]);
  });
});

describe('visibility', () => {
  const sidebarOnly = (markup: string): boolean =>
    !markup.includes('<div class="side-content">') && !markup.includes('nav-main');

  it.each<[string, () => AdminRequest]>([
    ['an anonymous visitor', () => anonymousRequest()],
    ['a public member', () => noSitesRequest({ s2IsPrivate: false })],
    ['a session without a site', () => adminS2Request({ session: { siteid: '' } })],
  ])('renders only the brand header for %s', (_, request) => {
    const markup = render(shell(request()));
    expect(sidebarOnly(markup)).toBe(true);
    expect(markup).toContain('id="brand-logo-lg"');
    expect(markup.trimEnd().endsWith('<!-- END Sidebar Scroll Container -->\n</nav>')).toBe(true);
  });

  it('gives a system user without module grants Content, File Browser, Help and About only', () => {
    const markup = render(shell(noSitesRequest({ s2IsPrivate: true }, { session: { siteid: 'tenant-a' } })));
    expect(links(markup).map((link) => link.split(' -> ')[0])).toEqual([
      'Content',
      'File Browser',
      'Help',
      'Documentation',
      'Editor/File Manager',
      'Professional Support',
      'Community Support',
      'About',
      'Core Version 7.6.1',
      'App Server ColdFusion (2023,0,26,331018)',
      'DB Server Microsoft SQL Server (Microsoft SQL Server 2022 - 16.0.4305.5)',
      'OS Version UNIX (6.12.105+)',
      'Mura CMS © 2026 blueriver Licensed under GNU General Public License Version 2.0 with exceptions',
      'Masa CMS © 2026 We Are North Groep BV Licensed under GNU General Public License Version 2.0 with exceptions',
    ]);
  });

  it('gates change sets, comments, categories and collections on the site flag and module grant', () => {
    const editorWith = (roles: string[], site: AdminRequestPartial['site']): string =>
      render(
        shell(
          makeAdminRequest({ circuit: 'cArch', item: 'list', user: { roles: [Roles.systemUser, ...roles] }, site }, 'qaEditor'),
        ),
      );
    const grants = [MODULE_IDS.changesets, MODULE_IDS.comments, MODULE_IDS.categories, MODULE_IDS.collections].map(
      moduleRole,
    );
    const allOn = editorWith(grants, DEFAULT_SITE_FLAGS);
    expect(['cChangesets.list', 'cComments.default', 'cCategory.list', 'cFeed.list'].map((a) => linksTo(allOn, a))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const flagsOff = editorWith(grants, { hasChangesets: false, hasComments: false, hasFeedManager: false });
    expect(['cChangesets.list', 'cComments.default', 'cCategory.list', 'cFeed.list'].map((a) => linksTo(flagsOff, a))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    const noGrants = editorWith([], DEFAULT_SITE_FLAGS);
    expect(['cChangesets.list', 'cComments.default', 'cCategory.list', 'cFeed.list'].some((a) => linksTo(noGrants, a))).toBe(
      false,
    );
  });

  it('shows the email entries only for an email-broadcasting site with module grants', () => {
    const on = adminOn({ circuit: 'cEmail', item: 'list', site: { emailBroadcaster: true } });
    expect(marks(render(shell(on)))).toEqual(['a.active cEmail.list&siteid=default']);
    expect(links(render(shell(on)))).toEqual(
      expect.arrayContaining([
        'Email Broadcaster -> /admin/?muraAction=cEmail.list&siteid=default',
        'Mailing Lists -> /admin/?muraAction=cMailingList.list&siteid=default',
      ]),
    );
    const lists = adminOn({ circuit: 'cMailingList', item: 'list', site: { emailBroadcaster: true } });
    expect(marks(render(shell(lists)))).toEqual(['a.active cMailingList.list&siteid=default']);
    const perm = adminOn({ circuit: 'cPerm', item: 'module', rc: { moduleid: MODULE_IDS.email }, site: { emailBroadcaster: true } });
    expect(marks(render(shell(perm)))).toEqual(['a.active cEmail.list&siteid=default']);
    const off = render(shell(adminOn({ circuit: 'cArch', item: 'list' })));
    expect(linksTo(off, 'cEmail.list') || linksTo(off, 'cMailingList.list')).toBe(false);
  });

  it('shows Users to an extranet user manager and hides it without the extranet or the grant', () => {
    const manager = (extranet: boolean, roles: string[]): string =>
      render(
        shell(
          makeAdminRequest(
            { circuit: 'cArch', item: 'list', user: { roles: [Roles.systemUser, ...roles] }, site: { extranet } },
            'qaEditor',
          ),
        ),
      );
    expect(manager(true, [moduleRole(MODULE_IDS.users)])).toContain('id="admin-nav-users"');
    expect(manager(false, [moduleRole(MODULE_IDS.users)])).not.toContain('id="admin-nav-users"');
    expect(manager(true, [])).not.toContain('id="admin-nav-users"');
  });

  it('gives a site admin Users and Site Settings without the S2-only entries', () => {
    const markup = render(shell(siteAdminRequest('tenant-a', { circuit: 'cArch', item: 'list' })));
    expect(markup).toContain('id="admin-nav-users"');
    expect(markup).toContain('id="admin-nav-site-config"');
    for (const s2Only of ['id="admin-nav-global"', 'id="admin-plugin-manager"', 'cwebservice.list', '_api/json/v1', 'cTrash.list']) {
      expect(markup).not.toContain(s2Only);
    }
    expect(markup.match(/updateCore/g)).toBeNull();
  });

  it('lists site plugins for any private user, with Add Plugin for S2 users only', () => {
    const sitePlugins = [
      { moduleId: 'P1', directory: 'alpha', name: 'Alpha & <Beta>' },
      { moduleId: 'P2', directory: 'gamma', name: 'Gamma' },
    ];
    const admin = render(shell(siteAdminRequest('tenant-a', { circuit: 'cArch', item: 'list', rc: { moduleid: 'P2' } }), { sitePlugins }));
    expect(admin).toContain('<a href="/plugins/alpha/"><i class="mi-plug"></i>Alpha &amp; &lt;Beta&gt;</a>');
    expect(marks(admin)).toEqual(['a#navContentAdmin.active cArch.list&siteid=tenant-a', 'a.active /plugins/gamma/']);
    expect(admin).not.toContain('cSettings.list&plugins#tabPlugins');
    const s2 = render(shell(adminOn({ circuit: 'cArch', item: 'list' }), { sitePlugins }));
    expect(squash(s2)).toContain(
      'Gamma</a></li><li class="divider"></li><li><a href="/admin/?muraAction=cSettings.list&plugins#tabPlugins">',
    );
    const s2Empty = squash(render(shell(adminOn({ circuit: 'cArch', item: 'list' }))));
    expect(s2Empty).toContain('Site Plugins</span></a></li><li><a href="/admin/?muraAction=cSettings.list&plugins#tabPlugins">');
  });

  it('hides File Browser and both Update Core entries when the settings disable them', () => {
    vi.stubEnv('MURA_FILEMANAGERENABLED', 'false');
    vi.stubEnv('MURA_ALLOWAUTOUPDATES', 'false');
    const markup = render(shell(adminOn({ circuit: 'cArch', item: 'list' })));
    expect(linksTo(markup, 'cFilemanager.default')).toBe(false);
    expect(markup).not.toContain('updateCore');
  });

  it('drops the MSSQL sentence from the Update Core warning on other databases', () => {
    vi.stubEnv('MURA_DBTYPE', 'mysql');
    const markup = render(shell(adminOn({ circuit: 'cArch', item: 'list' })));
    expect(markup.match(/install\.',function\(\)\{actionModal\('\/admin\/\?muraAction=cSettings\.list&action=updateCore&csrf_token=TOKEN/g)).toHaveLength(2);
    expect(markup).not.toContain('MSSQL');
  });

  it('shows Export HTML only for a non-empty export location that exists', () => {
    const exportItem = (exportLocation: string | null, exists: boolean): boolean =>
      render(shell(adminOn({ circuit: 'cArch', item: 'list', site: { record: { exportLocation } } }), { exportLocationExists: exists })).includes(
        'csettings.exportHTML',
      );
    expect(exportItem('/srv/export', true)).toBe(true);
    expect(exportItem('/srv/export', false)).toBe(false);
    expect(exportItem('', true)).toBe(false);
    expect(exportItem(null, true)).toBe(false);
    expect(exportItem('EXPORT1', true)).toBe(false);
  });

  it('marks Export HTML active on csettings.exportHtml', () => {
    const ctx = adminOn({ circuit: 'cSettings', item: 'exportHtml', site: { record: { exportLocation: '/tmp' } } });
    expect(marks(render(shell(ctx, { exportLocationExists: true })))).toEqual([...SITE_CONFIG_MARKS, 'a.active #']);
  });
});

describe('OPT-2 group', () => {
  it('is absent without a synthetic-module role', () => {
    expect(render(shell(adminOn({ circuit: 'cArch', item: 'list' })))).not.toContain('admin-nav-opt2');
  });

  it.each(OPT2_NAV_MODULES.flatMap((entry) => entry.roles.map((role) => [role, entry] as const)))(
    'gives %s one item, before Help',
    (role, entry) => {
      const markup = render(shell(opt2RoleRequest(role)));
      const $ = cheerio.load(markup, null, false);
      const items = $('#admin-nav-opt2 > ul > li > a');
      expect(items.toArray().map((el) => $(el).attr('href'))).toEqual([`/opt2/admin/${entry.module}/${entry.screen}?siteid=tenant-a`]);
      expect(items.find('i').attr('class')).toBe(entry.icon);
      expect(items.text()).toBe(entry.label);
      expect($('#admin-nav-opt2').next().attr('id')).toBe('admin-nav-help');
      expect(marks(markup)).toEqual([]);
    },
  );

  it('lists every reachable module in nav order and marks the current one', () => {
    const ctx = opt2RoleRequest(Roles.financeApprover, {
      user: { roles: [Roles.systemUser, Roles.surveysManager, Roles.financeApprover, Roles.timesheetsEmployee] },
      session: { siteid: 'tenant a&b' },
    });
    const markup = render(shell(ctx, {}, { opt2Module: 'finance' }));
    const $ = cheerio.load(markup, null, false);
    expect($('#admin-nav-opt2 > ul > li > a').toArray().map((el) => $(el).attr('href'))).toEqual([
      '/opt2/admin/timesheets/sheets?siteid=tenant+a%26b',
      '/opt2/admin/finance/records?siteid=tenant+a%26b',
      '/opt2/admin/surveys/surveys?siteid=tenant+a%26b',
    ]);
    expect(marks(markup)).toEqual([
      'li#admin-nav-opt2.open',
      'a.nav-submenu.active #',
      'a.active /opt2/admin/finance/records?siteid=tenant+a%26b',
    ]);
    expect(marks(render(shell(ctx, {}, { opt2Module: '' })))).toEqual([]);
  });
});

describe('version box', () => {
  const versionLinks = (sc: ShellContext): string[] =>
    links(render(sc)).filter((link) => link.endsWith(' -> #')).map((link) => link.replace(/ -> #$/, ''));

  it('omits the runtime rows when no legacy runtime facts are loaded', () => {
    expect(versionLinks(shell(editorRequest(), { server: null }))).toEqual(['Core Version 7.6.1']);
  });

  it('shows the Java row when the server reports a Java version, and no OS row without an OS name', () => {
    const server = { ...ORACLE_SERVER, javaVersion: '17.0.21', osName: '' };
    expect(versionLinks(shell(editorRequest(), { server }))).toEqual([
      'Core Version 7.6.1',
      'App Server ColdFusion (2023,0,26,331018)',
      'DB Server Microsoft SQL Server (Microsoft SQL Server 2022 - 16.0.4305.5)',
      'Java Version 17.0.21',
    ]);
  });

  it.each<[string, string | null, string]>([
    // The session mask MM/DD/YYYY prints the day of the year, the known legacy date-mask defect.
    ['a deployment time', '2026-06-29T14:05:00', 'Last Deployment 06/180/2026 2:05 PM'],
    ['no deployment', null, 'Last Deployment'],
    ['an unparsable value', 'yesterday', 'Last Deployment Never'],
  ])('shows the Last Deployment row of a staging install with %s', (_, lastDeployment, expected) => {
    vi.stubEnv('MURA_MODE', 'Staging');
    const ctx = adminOn({ circuit: 'cArch', item: 'list', site: { lastDeployment } });
    expect(versionLinks(shell(ctx))).toContain(expected);
  });

  it('omits Last Deployment outside staging', () => {
    expect(render(shell(adminOn({ circuit: 'cArch', item: 'list' })))).not.toContain('Last Deployment');
  });
});

describe('links and encoding', () => {
  it('builds every href from the configured context and admin directory', () => {
    vi.stubEnv('MURA_CONTEXT', '/masa');
    vi.stubEnv('MURA_ADMINDIR', '/manage');
    const markup = render(shell(adminOn({ circuit: 'cArch', item: 'list' })));
    expect(markup).toContain('<img src="/masa/manage/assets/images/masa-logo-admin@2x.png" class="mura-logo">');
    expect(markup).toContain('href="/masa/index.cfm/_api/json/v1/default"');
    expect(markup).toContain('href="/masa/manage/?appreload&amp;reload=appreload"');
    const hrefs = links(markup).map((link) => link.split(' -> ')[1] ?? '');
    expect(hrefs.filter((href) => href.includes('muraAction=')).every((href) => href.startsWith('/masa/manage/?muraAction='))).toBe(
      true,
    );
  });

  it('encodes the session site id exactly where legacy does', () => {
    const ctx = adminOn({
      circuit: 'cArch',
      item: 'list',
      session: { siteid: 'a b&c' },
      site: { ...DEFAULT_SITE_FLAGS, siteid: 'a b&c' },
    });
    const markup = render(shell(ctx));
    for (const encoded of ['cArch.list&amp;siteid=a+b%26c', 'cUsers.listUsers&amp;siteid=a+b%26c', 'cSettings.editSite&amp;siteid=a+b%26c', 'cTrash.list&amp;siteID=a+b%26c', '_api/json/v1/a+b%26c', 'selectBundleOptions&amp;siteID=a+b%26c', 'importSubTypes&amp;siteid=a+b%26c']) {
      expect(markup).toContain(encoded);
    }
    for (const unencoded of ['cChangesets.list&amp;siteid=a b&c"', 'cComments.default&amp;siteid=a b&c"', 'cCategory.list&amp;siteid=a b&c"', 'cFeed.list&amp;siteid=a b&c"', 'cFilemanager.default&amp;siteid=a b&c"', 'cPlugins.list&amp;siteid=a b&c"']) {
      expect(markup).toContain(unencoded);
    }
  });

  it('emits labels unencoded and JavaScript-encodes the export location', () => {
    const rb: RbLookup = { locale: 'en_US', rbKey: (key) => `<b>${key}</b>`, messageFormat: (pattern) => pattern };
    const ctx = adminOn({ circuit: 'cArch', item: 'list', site: { record: { exportLocation: "/srv/o'neil" } } });
    const markup = render(shell(ctx, { rb, exportLocationExists: true }));
    expect(markup).toContain('<span class="sidebar-mini-hide"><b>layout.contentmanager</b></span>');
    expect(markup).toContain(
      `onclick="confirmDialog('Export static HTML files to \\x27\\x2Fsrv\\x2Fo\\x27neil\\x27.',function(){actionModal('/admin/?muraAction=csettings.exportHTML&amp;siteID=default')},'','<b>layout.exportstatichtml</b>','','','','dialog-confirm');return false;"`,
    );
  });

  it('looks up labels only for the entries it shows', () => {
    const keys: string[] = [];
    const rb: RbLookup = { locale: 'en_US', rbKey: (key) => (keys.push(key), key), messageFormat: (pattern) => pattern };
    render(shell(editorRequest({ circuit: 'cArch', item: 'list' }), { rb, server: null }));
    expect(keys).toEqual([
      'layout.contentmanager',
      'layout.filemanager',
      'layout.help',
      'layout.developers',
      'layout.editordocumentation',
      'layout.support',
      'layout.supportforum',
      'layout.version',
      'version.core',
    ]);
  });
});
