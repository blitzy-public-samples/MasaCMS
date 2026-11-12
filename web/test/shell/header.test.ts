// Unit tests for the admin header bar against admin/common/layouts/includes/header.cfm.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessClock } from '@opt2/platform/testing';
import { resetLegacySettingsForTests } from '@/lib/env';
import { html, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderHeader, userPromptTally } from '@/shell/header';
import type { ShellContext, ShellData, ShellSite, UserPrompts } from '@/shell/types';
import { PROMPT_TALLY_NONZERO, promptCountsNonZero as NON_ZERO, promptCountsZero as ZERO } from '../fixtures/strategies-content/prompts';
import { adminS2Request, makeAdminRequest, unservedEditorRequest, type AdminRequestPartial } from '../helpers/admin-request';
import { fragmentModel } from '../helpers/dom-model';

const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const HOME_ID = '00000000000000000000000000000000001';
const rb = rbFor('en_US');

const DEFAULT_SITE: ShellSite = { siteId: 'default', site: 'Default', showDashboard: false };

/** `n` sites named in list order. */
const siteList = (n: number): ShellSite[] =>
  Array.from({ length: n }, (_, i) => ({ siteId: `site${i}`, site: `Site ${i}`, showDashboard: false }));

/** The header's shell context over `ctx`, with `data` members replacing the defaults. */
function shellFor(ctx: AdminRequest, data: Partial<ShellData> = {}): ShellContext {
  return {
    ctx,
    view: { body: html`` },
    hooks: { secondaryMenus: {} },
    data: {
      rb,
      user: { fname: 'Admin', lname: 'User', passwordExpired: false, hasDefaultPassword: false },
      userSites: [DEFAULT_SITE],
      prompts: ZERO,
      sitePlugins: [],
      server: null,
      updateCoreCsrfQuery: '',
      exportLocationExists: false,
      now: businessClock().now(),
      ...data,
    },
    layout: 'template',
    originalCircuit: 'carch',
    originalFuseaction: 'list',
    moduleTitle: '',
    bodyclass: '',
    siteId: ctx.rc.siteid || ctx.session.siteid || 'default',
  };
}

function render(sc: ShellContext): string {
  const markup = renderHeader(sc);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

const load = (markup: string) => cheerio.load(markup, null, false);

/** Installs `vars` as the only `MURA_` variables, on the oracle's port and URL settings by default. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  const merged = { MURA_PORT: '8080', MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false', ...vars };
  for (const [key, value] of Object.entries(merged)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => useSettings());

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderHeader', () => {
  it('renders the legacy header bar for the S2 admin', () => {
    const markup = render(shellFor(adminS2Request({ circuit: 'cArch', item: 'list' })));
    const $ = load(markup);
    expect($('header#header-navbar').attr('class')).toBe('content-mini content-mini-full');
    expect($('[id]').toArray().map((el) => $(el).attr('id'))).toEqual([
      'header-navbar',
      'mura-sidebar-toggle',
      'mura-sidebar-toggle-open',
      'site-selector',
      'select-site-btn',
      'site-selector-trigger',
      'site-selector-list',
      'globalSearch',
      'mura-search-keywords',
      'mura-search-submit',
      'user-tools-selector',
      'user-tools-name',
      'site-selector-trigger',
    ]);
    expect($('[data-toggle="layout"]').toArray().map((el) => $(el).attr('data-action'))).toEqual([
      'sidebar_mini_toggle',
      'sidebar_mini_toggle',
      'sidebar_toggle',
    ]);
    expect(markup.match(/<!--[\s\S]*?-->/g)).toEqual([
      '<!-- Header Navigation Left -->',
      '<!-- toggle sidebar -->',
      '<!-- Layout API, functionality initialized in App() -> uiLayoutApi() -->',
      '<!-- Layout API, functionality initialized in App() -> uiLayoutApi() -->',
      '<!-- END Header Navigation Left -->',
      '<!-- Header Navigation Right -->',
      '<!-- Toggle class helper (for .js-header-search below), functionality initialized in App() -> uiToggleClass() -->',
      '<!-- END Header Navigation Right -->',
    ]);
    const model = fragmentModel(markup);
    expect(model.links).toEqual([
      { href: 'http://localhost:8080/', text: 'Default' },
      {
        href: `/admin/?muraAction=carch.list&moduleID=${CONTENT_MODULE_ID}&siteID=default&topID=${HOME_ID}`,
        text: 'Default',
      },
      { href: '/admin/?muraAction=ceditprofile.edit', text: 'Admin User' },
      { href: '/admin/?muraAction=ceditprofile.edit', text: 'Edit Profile' },
      { href: '/admin/?muraAction=clogin.logout', text: 'Log out' },
    ]);
    expect(model.buttons).toEqual(Array.from({ length: 6 }, () => ({ text: '', type: 'button', hasOnclick: false })));
    expect(model.controls.map(({ name, type, value }) => [name, type, value])).toEqual([
      ['keywords', 'text', ''],
      ['muraAction', 'hidden', 'cArch.list'],
      ['activetab', 'hidden', '1'],
      ['siteid', 'hidden', 'default'],
      ['moduleid', 'hidden', CONTENT_MODULE_ID],
    ]);
  });

  it('names the session site HTML-encoded', () => {
    const markup = render(shellFor(adminS2Request({ site: { site: 'A & <B>' } })));
    expect(markup).toContain('<i class="mi-globe"></i> A &amp; &lt;B&gt;</a>');
  });

  it.each<[string, AdminRequestPartial, ShellSite[], string]>([
    ['the session site list', {}, [], ' Default'],
    ['the user site list', { adminSites: [] }, [{ siteId: 'DEFAULT', site: 'Listed', showDashboard: false }], ' Listed'],
    ['nothing', { adminSites: [] }, [], ' '],
  ])('names a site served without site data from %s', (_, partial, userSites, text) => {
    const ctx = unservedEditorRequest(partial);
    expect(ctx.site).toBeUndefined();
    expect(load(render(shellFor(ctx, { userSites })))('#select-site-btn').text()).toBe(text);
  });
});

describe('site selector', () => {
  it.each([
    [10, 0, 10],
    [11, 1, 11],
    [105, 1, 100],
  ])('lists %i sites with %i filter inputs and %i rows', (count, filters, rows) => {
    const userSites = siteList(count);
    const $ = load(render(shellFor(adminS2Request(), { userSites })));
    const filter = $('input#site-list-filter[name="site-list-filter"]');
    expect(filter.length).toBe(filters);
    if (filters > 0) expect(filter.attr('placeholder')).toBe('Search...');
    const items = $('ul#site-selector-list > li');
    expect(items.length).toBe(rows);
    expect(items.toArray().map((el) => $(el).text().trim())).toEqual(userSites.slice(0, rows).map((s) => s.site));
  });

  it('marks the session site active and links each site to its landing action', () => {
    const userSites: ShellSite[] = [
      { siteId: 'DEFAULT', site: 'Default', showDashboard: true },
      { siteId: 'tenant-a', site: 'Tenant A', showDashboard: false },
    ];
    const markup = render(shellFor(adminS2Request(), { userSites }));
    const $ = load(markup);
    expect($('ul#site-selector-list > li').toArray().map((el) => $(el).attr('class'))).toEqual(['active', undefined]);
    expect(markup).toContain('<a href="/admin/?muraAction=cDashboard.main&amp;siteID=DEFAULT">');
    expect(markup).toContain(
      `<a href="/admin/?muraAction=cArch.list&amp;moduleID=${CONTENT_MODULE_ID}&amp;topID=${HOME_ID}&amp;siteID=tenant-a">`,
    );
  });

  it('links a dashboard site to Site Manager for a user who is not a system user', () => {
    const member = makeAdminRequest({}, 'member');
    expect(member.isPrivateUser).toBe(false);
    const userSites: ShellSite[] = [{ siteId: 'default', site: 'Default', showDashboard: true }];
    expect(render(shellFor(member, { userSites }))).not.toContain('cDashboard.main');
  });

  it('renders no rows for an empty site list', () => {
    expect(load(render(shellFor(adminS2Request(), { userSites: [] })))('ul#site-selector-list > li').length).toBe(0);
  });
});

describe('site home link', () => {
  it.each<[string, Record<string, string>, AdminRequestPartial, string]>([
    ['siteid and index file in URLs', { MURA_SITEIDINURLS: 'true', MURA_INDEXFILEINURLS: 'true' }, {}, 'http://localhost:8080/index.cfm/default/'],
    ['siteid in URLs', { MURA_SITEIDINURLS: 'true' }, {}, 'http://localhost:8080/default/'],
    ['a context on port 80', { MURA_SITEIDINURLS: 'true', MURA_CONTEXT: '/ctx', MURA_PORT: '80' }, {}, 'http://localhost/ctx/default/'],
    ['an empty event site', { MURA_SITEIDINURLS: 'true', MURA_INDEXFILEINURLS: 'true' }, { rc: { siteid: '' } }, 'http://localhost:8080/index.cfm//'],
    ['a host that is no site domain', {}, { serverName: 'other.test' }, 'http://localhost:8080/'],
    ['a domain alias host', {}, { httpHost: 'ALIAS.test:8080', serverName: 'ALIAS.test', site: { record: { domainAlias: 'x.test\r\nalias.test' } } }, 'http://ALIAS.test:8080/'],
    ['an enforced primary domain', {}, { serverName: 'alias.test', site: { record: { domainAlias: 'alias.test', enforcePrimaryDomain: 1 } } }, 'http://localhost:8080/'],
    ['a preview alias over an enforced primary domain', {}, { httpHost: 'alias.test:8080', serverName: 'alias.test', site: { record: { domainAlias: 'alias.test', enforcePrimaryDomain: 1 } } }, 'http://alias.test:8080/'],
    ['a site without a domain on an alias server name', {}, { httpHost: 'other.test', serverName: 'alias.test', site: { domain: '', record: { domainAlias: 'alias.test' } } }, 'http://alias.test:8080/'],
    ['a site without a domain that enforces it', {}, { httpHost: 'other.test', serverName: 'alias.test', site: { domain: '', record: { domainAlias: 'alias.test', enforcePrimaryDomain: 1 } } }, 'http://:8080/'],
    ['a remote site on a preview alias', { MURA_SITEIDINURLS: 'true' }, { httpHost: 'alias.test:8443', serverName: 'alias.test', site: { domain: 'remote.test', record: { isremote: 1, remoteport: 8443, remotecontext: '/r', domainAlias: 'alias.test' } } }, 'http://alias.test:8443/r/'],
    ['an empty host', {}, { serverName: '' }, 'http://localhost:8080/'],
    ['an SSL site', {}, { site: { record: { useSSL: 1 } } }, 'https://localhost:8080/'],
    ['an extranet SSL site', {}, { site: { record: { useSSL: null, ExtranetSSL: 1 } } }, 'https://localhost:8080/'],
    ['a stored non-SSL site', {}, { site: { record: { useSSL: 0, ExtranetSSL: 1 } } }, 'http://localhost:8080/'],
    ['an HTTPS request', {}, { https: true }, 'https://localhost:8080/'],
    ['a remote site', { MURA_SITEIDINURLS: 'true' }, { site: { domain: 'remote.test', record: { isremote: 1, remoteport: 8443, remotecontext: '/r' } } }, 'http://remote.test:8443/r/'],
    ['a remote site on 443', {}, { site: { domain: 'remote.test', record: { isremote: 1, remoteport: 443 } } }, 'http://remote.test/'],
    ['a remote site without a port', {}, { site: { domain: 'remote.test', record: { isremote: 1 } } }, 'http://remote.test/'],
  ])('links the home page for %s', (_, vars, partial, href) => {
    useSettings(vars);
    expect(load(render(shellFor(adminS2Request(partial))))('#select-site-btn').attr('href')).toBe(href);
  });

  it.each<[string, string, string, string, string]>([
    ['false', 'false', 'false', '', '/'],
    ['false', 'false', 'true', '', '/'],
    ['false', 'true', 'false', '', '/'],
    ['false', 'true', 'true', '', '/'],
    ['true', 'false', 'false', '', '/default/'],
    ['true', 'false', 'true', '', '/default/'],
    ['true', 'true', 'false', '', '/index.cfm/default/'],
    ['true', 'true', 'true', '', '/sites/default/'],
    ['true', 'true', 'true', 'content', '/content/default/'],
    ['true', 'true', 'false', 'content', '/index.cfm/default/'],
  ])(
    'stems siteIDInURLS=%s indexFileInURLS=%s legacyIndexFileLocation=%s siteDir=%j as %s',
    (siteIDInURLS, indexFileInURLS, legacyIndexFileLocation, siteDir, stem) => {
      useSettings({
        MURA_SITEIDINURLS: siteIDInURLS,
        MURA_INDEXFILEINURLS: indexFileInURLS,
        MURA_LEGACYINDEXFILELOCATION: legacyIndexFileLocation,
        ...(siteDir === '' ? {} : { MURA_SITEDIR: siteDir }),
      });
      expect(load(render(shellFor(adminS2Request())))('#select-site-btn').attr('href')).toBe(`http://localhost:8080${stem}`);
    },
  );

  // Captured from a legacy instance on port 22380 whose default site enforces its domain and has one alias.
  it.each([
    ['localhost:22380', 'http://localhost:22380/sites/default/'],
    ['alias.c23.test:22380', 'http://alias.c23.test:22380/sites/default/'],
  ])('links the home page as the legacy oracle did on host %s', (httpHost, href) => {
    useSettings({
      MURA_PORT: '22380',
      MURA_SITEIDINURLS: 'true',
      MURA_INDEXFILEINURLS: 'true',
      MURA_LEGACYINDEXFILELOCATION: 'true',
    });
    const ctx = adminS2Request({
      httpHost,
      serverName: httpHost.split(':')[0],
      site: { record: { domainAlias: 'alias.c23.test', enforcePrimaryDomain: 1 } },
    });
    expect(load(render(shellFor(ctx)))('#select-site-btn').attr('href')).toBe(href);
  });

  it('HTML-edit-formats the link', () => {
    const markup = render(shellFor(adminS2Request({ site: { domain: 'a&b' }, serverName: 'z' })));
    expect(markup).toContain('id="select-site-btn" class="btn btn-default" href="http://a&amp;b:8080/"');
  });

  it('links the request host without site data', () => {
    const ctx = unservedEditorRequest({ https: true, serverName: 'admin.test' });
    expect(load(render(shellFor(ctx)))('#select-site-btn').attr('href')).toBe('https://admin.test:8080/');
  });
});

describe('header search', () => {
  it('keeps the legacy search form that posts to #', () => {
    const ctx = adminS2Request({ session: { keywords: 'a "b" <c>' }, rc: { siteid: 'x"y' } });
    const markup = render(shellFor(ctx));
    const $ = load(markup);
    const form = $('form#globalSearch[name="globalSearch"]');
    expect([form.attr('action'), form.attr('method'), form.attr('novalidate'), form.attr('class')]).toEqual([
      '#',
      'get',
      'novalidate',
      'form-horizontal',
    ]);
    expect(
      form
        .find('input')
        .toArray()
        .map((el) => [$(el).attr('name'), $(el).attr('type'), $(el).attr('value')]),
    ).toEqual([
      ['keywords', 'text', 'a "b" <c>'],
      ['muraAction', 'hidden', 'cArch.list'],
      ['activetab', 'hidden', '1'],
      ['siteid', 'hidden', 'x"y'],
      ['moduleid', 'hidden', CONTENT_MODULE_ID],
    ]);
    expect(markup).toContain('value="a&#x20;&quot;b&quot;&#x20;&lt;c&gt;" placeholder="Search"');
    expect(markup).toContain('<input type="hidden" name="siteid" value="x&quot;y">');
    expect($('span#mura-search-submit').attr('onclick')).toBe('submitForm(document.forms.globalSearch);');
  });
});

describe('user tools', () => {
  it('lists the non-zero prompts, the tally badge and the divider', () => {
    const markup = render(shellFor(adminS2Request(), { prompts: NON_ZERO }));
    const $ = load(markup);
    expect($('#user-tools-selector button .badge').text()).toBe(String(PROMPT_TALLY_NONZERO));
    const items = $('ul.mura-user-tools > li');
    expect(items.toArray().map((el) => $(el).text().trim())).toEqual([
      '3 Drafts',
      '2 Submissions',
      '1 Approvals',
      '4 Expiring',
      '2 Changesets',
      '',
      'Edit Profile',
      'Log out',
    ]);
    expect(items.eq(5).attr('class')).toBe('divider');
    const report = (name: string, sortBy: string): string =>
      `./?muraAction=cArch.list&moduleid=${CONTENT_MODULE_ID}&activeTab=1&report=${name}&siteID=default&reportSortby=${sortBy}&reportSortDirection=desc&refreshFlatview=true`;
    expect(markup).toContain(`<a href="${report('mydrafts', 'lastupdate')}"><span class="badge">3</span> Drafts</a>`);
    expect(markup).toContain(`<a href="${report('mysubmissions', 'duedate')}"><span class="badge">2</span> Submissions</a>`);
    expect(markup).toContain(`<a href="${report('myapprovals', 'duedate')}"><span class="badge">1</span> Approvals </a>`);
    expect(markup).toContain(`<a href="${report('myexpires', 'duedate')}"><span class="badge">4</span> Expiring</a>`);
    expect(markup).toContain('<a href="./?muraAction=cChangesets.list&siteid=default"><span class="badge">2</span> Changesets</a>');
  });

  it('lists only the prompts above zero', () => {
    const $ = load(render(shellFor(adminS2Request(), { prompts: { ...ZERO, approvals: 5 } })));
    expect($('ul.mura-user-tools > li').toArray().map((el) => $(el).text().trim())).toEqual([
      '5 Approvals',
      '',
      'Edit Profile',
      'Log out',
    ]);
  });

  it('shows no badge, prompt or divider when every prompt is zero', () => {
    const $ = load(render(shellFor(adminS2Request())));
    expect($('.badge').length).toBe(0);
    expect($('li.divider').length).toBe(0);
    expect($('ul.mura-user-tools > li').length).toBe(2);
  });

  it('links the user name and profile actions', () => {
    const user = { fname: '<b>', lname: 'O&Brien', passwordExpired: false, hasDefaultPassword: false };
    const markup = render(shellFor(adminS2Request(), { user }));
    const $ = load(markup);
    expect(markup).toContain('<i class="mi-user"></i> &lt;b&gt; O&amp;Brien</a>');
    expect($('a#user-tools-name').attr('href')).toBe('/admin/?muraAction=cEditProfile.edit');
    expect(
      $('ul.mura-user-tools a')
        .toArray()
        .map((el) => [$(el).attr('tabindex'), $(el).attr('href')]),
    ).toEqual([
      ['-1', '/admin/?muraAction=cEditProfile.edit'],
      ['-1', '/admin/?muraAction=cLogin.logout'],
    ]);
  });
});

describe('userPromptTally', () => {
  it.each<[UserPrompts, number]>([
    [NON_ZERO, PROMPT_TALLY_NONZERO],
    [ZERO, 0],
    [{ ...ZERO, drafts: 2, pendingChangesets: 5 }, 7],
  ])('sums %j to %i', (prompts, tally) => {
    expect(userPromptTally(prompts)).toBe(tally);
  });
});
