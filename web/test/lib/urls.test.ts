import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import {
  adminAssetUrl,
  adminPath,
  adminScriptName,
  assetUrl,
  boundAdminUrl,
  buildUrl,
  FW1_HOME_ACTION,
  fw1RedirectTarget,
  sanitizeHref,
} from '@/lib/urls';

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => useSettings());

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('boundAdminUrl', () => {
  it('builds with the configured context and admin directory, keeping parameter order', () => {
    useSettings({ MURA_CONTEXT: '/cms', MURA_ADMINDIR: '/manage' });
    expect(
      boundAdminUrl('cUsers', 'editUser', [
        ['siteid', 'tenant a'],
        ['userid', ''],
      ]),
    ).toBe('/cms/manage/?muraAction=cUsers.editUser&siteid=tenant+a&userid=');
  });

  it('accepts a record, raw encoding and HTML separators', () => {
    expect(boundAdminUrl('cDashboard', 'main', { siteid: 'a b', span: 30 }, { html: true, encode: 'raw' })).toBe(
      '/admin/?muraAction=cDashboard.main&amp;siteid=a b&amp;span=30',
    );
  });

  it('lets a parameter name its own encoding and defaults to none', () => {
    expect(boundAdminUrl('cArch', 'list')).toBe('/admin/?muraAction=cArch.list');
    expect(boundAdminUrl('cArch', 'list', [['siteid', 'a&b'], ['x', 'a&b', 'raw']])).toBe(
      '/admin/?muraAction=cArch.list&siteid=a%26b&x=a&b',
    );
  });
});

describe('buildUrl', () => {
  it('names the home action', () => {
    expect(FW1_HOME_ACTION).toBe('core:home.redirect');
  });

  // Expected values were captured from FW/1 buildURL on the legacy ACF 2023 instance with the admin configuration.
  it.each([
    ['cLogin.main', './', '', './?muraAction=cLogin.main'],
    ['core:home.redirect', './', '', './'],
    ['home.redirect', './', '', './'],
    ['CORE:Home.Redirect', './', '', './'],
    ['cusers', './', '', './?muraAction=cusers'],
    ['cusers.default', './', '', './?muraAction=cusers'],
    ['cusers.Default', './', '', './?muraAction=cusers'],
    ['cusers.', './', '', './?muraAction=cusers'],
    ['core:cusers', './', '', './?muraAction=cusers'],
    ['a.b?x=1', './', '', './?muraAction=a.b&x=1'],
    ['a.b?x=1&y=2#top', './', '', './?muraAction=a.b&x=1&y=2#top'],
    ['a.b?', './', '', './?muraAction=a.b'],
    ['a.b??x=1', './', '', './?muraAction=a.b&x=1'],
    ['a.b?#top', './', '', './?muraAction=a.b&top'],
    ['a.b?x=1', './', 'y=2', './?muraAction=a.b?x=1&y=2'],
    ['a.b#frag', './', '', './?muraAction=a.b#frag'],
    ['cusers.edit', './', 'userid=1&siteid=default', './?muraAction=cusers.edit&userid=1&siteid=default'],
    ['cusers.edit', './', 'userid=1?z=2#anc', './?muraAction=cusers.edit&userid=1&z=2#anc#anc'],
    ['cusers.list', './', '#top', './?muraAction=cusers.list&top'],
    ['cusers.list', './', 'x=1#a#b', './?muraAction=cusers.list&x=1#a#b'],
    ['cusers.list', './', '?x=1&y=2', './?muraAction=cusers.list&x=1&y=2'],
    ['cusers.list', './', 'a=1??b=2', './?muraAction=cusers.list&a=1&b=2'],
    ['cusers.list', './', 'x=1?', './?muraAction=cusers.list&x=1'],
    ['home.redirect', './', 'x=1', './?x=1'],
    ['home.redirect', './', '?x=1', './?x=1'],
    ['home.redirect', './', '?x=1?y=2', './?x=1&y=2'],
    ['home.redirect', './', '#top', './?top'],
    ['home.redirect', './?a=1', 'x=1', './?a=1?x=1'],
    ['cusers.edit', './?a=1', '', './?a=1&muraAction=cusers.edit'],
    ['cusers.edit', './?', 'x=1', './?muraAction=cusers.edit&x=1'],
    ['cusers.edit', './?a=1&', 'x=1', './?a=1&muraAction=cusers.edit&x=1'],
    ['other:cusers.list', './', '', './?muraAction=other:cusers.list'],
    ['a:b:c', './', '', './?muraAction=a:c'],
    [':cusers.list', './', '', './?muraAction=cusers.list'],
    ['Core:cUsers.List', './', '', './?muraAction=cUsers.List'],
    ['', './', '', './?muraAction=main'],
    ['core:', './', '', './?muraAction=main'],
    ['.foo', './', '', './?muraAction=main.foo'],
    ['a.b.c', './', '', './?muraAction=a.c'],
    ['a..b', './', '', './?muraAction=a.b'],
    ['cusers.list', '', 'x=1', '?muraAction=cusers.list&x=1'],
    ['cusers.list', '/admin/index.cfm', 'x=1', '/admin/index.cfm?muraAction=cusers.list&x=1'],
  ])('buildUrl(%j, %j, %j) is %j', (action, path, queryString, expected) => {
    expect(buildUrl(action, path, queryString)).toBe(expected);
  });

  it('defaults the path to the admin script name', () => {
    expect(adminScriptName()).toBe('/admin/index.cfm');
    expect(buildUrl('cusers.list')).toBe('/admin/index.cfm?muraAction=cusers.list');
    useSettings({ MURA_CONTEXT: '/cms' });
    expect(buildUrl('cusers.edituser', undefined, 'siteid=default&userid=')).toBe(
      '/cms/admin/index.cfm?muraAction=cusers.edituser&siteid=default&userid=',
    );
  });

  // Path-info admin requests (request.generateSES) emit these, observed on /admin/index.cfm/cusers/list.
  it.each([
    ['cusers.edituser', undefined, 'siteid=default&userid=', '/admin/index.cfm/cusers/edituser/siteid/default/userid'],
    ['cusers.list', undefined, 'ispublic=1', '/admin/index.cfm/cusers/list/ispublic/1'],
    ['cusers.default', undefined, '', '/admin/index.cfm/cusers'],
    ['cusers.default', undefined, 'x=1', '/admin/index.cfm/cusers/default/x/1'],
    ['home.redirect', undefined, '', '/admin/index.cfm'],
    ['home.redirect', undefined, 'x=1', '/admin/index.cfm/home/redirect/x/1'],
    ['cusers.list', './', 'x=1?y=2#top', './/cusers/list/x/1?y=2#top#top'],
    ['cusers.list', './?a=1', 'x=1', './?a=1&muraAction=cusers.list&x=1'],
  ])('SES buildUrl(%j, %j, %j) is %j', (action, path, queryString, expected) => {
    expect(buildUrl(action, path, queryString, { ses: true })).toBe(expected);
  });
});

describe('fw1RedirectTarget', () => {
  const returnURL = 'http://localhost:22080/admin/?&muraAction=cusers.list';

  // Expected values were captured from the Location of FW/1 redirect() on the legacy instance.
  it.each([
    [
      { action: 'cLogin.main', path: './', append: [['returnURL', returnURL], ['compactDisplay', 'false']] as const },
      './?muraAction=cLogin.main&returnURL=http%3A%2F%2Flocalhost%3A22080%2Fadmin%2F%3F%26muraAction%3Dcusers.list&compactDisplay=false',
    ],
    [
      {
        action: 'cLogin.main',
        path: './',
        append: [['returnURL', 'a bé*~'], ['compactDisplay', 'false'], ['empty', '']] as const,
        queryString: '#top',
      },
      './?muraAction=cLogin.main&returnURL=a+b%C3%A9*%7E&compactDisplay=false&empty=#top',
    ],
    [
      { action: 'cusers.list', path: './', append: [['compactDisplay', 'false']] as const, queryString: '?x=1' },
      './?muraAction=cusers.list&compactDisplay=false&x=1',
    ],
    [
      { action: 'cusers.list', path: './', append: [['compactDisplay', 'false']] as const, queryString: '#anc?z' },
      './?muraAction=cusers.list&compactDisplay=false&z#anc?z',
    ],
    [
      {
        action: 'cusers.list',
        path: './',
        append: [['compactDisplay', 'false']] as const,
        queryString: 'x=1#anc',
        preserveKey: 1,
      },
      './?muraAction=cusers.list&compactDisplay=false&x=1&fw1pk=1#anc',
    ],
    [{ action: 'home.redirect', path: './', preserveKey: '1' }, './?fw1pk=1'],
    [{ action: 'home.redirect', path: './', queryString: '#anc', preserveKey: 1 }, './?anc&fw1pk=1'],
    [{ action: 'cusers.list', path: './', queryString: 'x=1' }, './?muraAction=cusers.list&x=1'],
    [{ action: 'home.redirect', path: './', preserveKey: '' }, './'],
    [
      { action: 'cusers.list', append: [['compactDisplay', 'false']] as const },
      '/admin/index.cfm?muraAction=cusers.list&compactDisplay=false',
    ],
    [{ action: 'cusers.list', ses: true, queryString: 'x=1' }, '/admin/index.cfm/cusers/list/x/1'],
  ])('fw1RedirectTarget(%j) is %j', (options, expected) => {
    expect(fw1RedirectTarget(options)).toBe(expected);
  });
});

describe('adminPath', () => {
  it.each([
    [{}, { domain: 'example.com', https: false }, 'http://example.com/admin'],
    [{}, { domain: 'example.com', https: false, useProtocol: false }, '//example.com/admin'],
    [{}, { domain: 'example.com', https: true }, 'https://example.com/admin'],
    [{ MURA_PORT: '8080' }, { domain: 'example.com', https: false }, 'http://example.com:8080/admin'],
    [{ MURA_PORT: '80' }, { domain: 'example.com', https: false }, 'http://example.com/admin'],
    [{ MURA_ADMINSSL: 'true' }, { domain: 'example.com', https: false }, 'https://example.com/admin'],
    [{ MURA_ADMINSSL: 'true' }, { domain: 'example.com', https: false, useProtocol: false }, '//example.com/admin'],
    [{ MURA_CONTEXT: '/cms', MURA_PORT: '22080' }, { domain: '', https: true }, '/cms/admin'],
    [{}, { https: false }, '/admin'],
    [{ MURA_ADMINDOMAIN: 'admin.example.com' }, { https: false }, 'http://admin.example.com/admin'],
    [
      { MURA_ADMINDOMAIN: 'a.example.com,b.example.com', MURA_PORT: '8080' },
      { https: false, httpHost: 'B.example.com:8080' },
      'http://B.example.com:8080/admin',
    ],
    [
      { MURA_ADMINDOMAIN: 'a.example.com,b.example.com' },
      { https: false, httpHost: 'other.example.com:9000' },
      'http://other.example.com:9000/admin',
    ],
    [{ MURA_ADMINDOMAIN: 'admin.example.com' }, { domain: 'ADMIN.example.com', https: false }, 'http://ADMIN.example.com/admin'],
  ])('with %j, adminPath(%j) is %j', (settings, options, expected) => {
    useSettings(settings);
    expect(adminPath(options)).toBe(expected);
  });
});

describe('sanitizeHref', () => {
  const domains = { allowedDomains: ['localhost'], siteDomain: 'localhost' };

  // Expected values were captured from utility.sanitizeHref(href, 'default') on the legacy instance,
  // whose access-control domain list and default site domain are both 'localhost'.
  it.each([
    ['/feedback/', '/feedback/'],
    ['//evil.com/p', '/evil.com/p'],
    ['//', '/'],
    ['///x', '/x'],
    ['//x', '/x'],
    ['http://localhost/page', 'http://localhost/page'],
    ['http://evil.com/page', 'http://localhost/page'],
    ['HTTP://evil.com/page', 'HTTP://localhost/page'],
    ['http://localhost//evil.com/x', 'http://localhost/x'],
    ['http://evil.com', 'http://localhost'],
    ['http:foo', 'localhost'],
    [':http://evil.com/x', 'http://localhost/x'],
    ['  http://evil.com/x  ', 'http://localhost/x'],
    ['\u0001http://evil.com/x', 'http://localhost/x'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['ftp://evil.com/x', 'ftp://evil.com/x'],
    ['x', 'x'],
    ['   ', '   '],
    ['', ''],
    ['https://localhost:8080/x', 'https://localhost:8080/x'],
    ['http://evil.com:8080/a', 'http://localhost:8080/a'],
    ['http://user@evil.com/x', 'http://localhost/x'],
    ['http://evil.com/a//b.com/c//d', 'http://localhost/a/c'],
    ['http://localhost/evil.com', 'http://localhost/evil.com'],
    ['http://ht/x', 'localhosttp://ht/x'],
    ['http://LOCALHOST/x', 'http://LOCALHOST/x'],
    ['http://evil.com?q=1', 'http://localhost'],
    ['http://a$&b/x', 'http://localhost/x'],
    ['https://evil.com/a/b//', 'https://localhost/a/b//'],
  ])('sanitizeHref(%j) is %j', (href, expected) => {
    expect(sanitizeHref(href, domains)).toBe(expected);
  });

  it('fails where legacy fails on a path right after the scheme', () => {
    expect(() => sanitizeHref('http:///path', domains)).toThrow(RangeError);
  });

  it('matches allowed domains as a case-insensitive comma list and inserts the site domain literally', () => {
    const site = { allowedDomains: ['www.example.com,Alias.example.com', ''], siteDomain: '$&.example.com' };
    expect(sanitizeHref('https://alias.EXAMPLE.com/a', site)).toBe('https://alias.EXAMPLE.com/a');
    expect(sanitizeHref('https://evil.com/a', site)).toBe('https://$&.example.com/a');
  });
});

describe('assetUrl', () => {
  it.each([
    [{}, '/core/vendor/ckeditor/ckeditor.js', {}, '/core/vendor/ckeditor/ckeditor.js'],
    [
      {},
      '/core/vendor/colorpicker/js/bootstrap-colorpicker.js',
      { coreversion: true },
      '/core/vendor/colorpicker/js/bootstrap-colorpicker.js?coreversion=7.6.1',
    ],
    [{ MURA_CONTEXT: '/cms' }, '/core/vendor/ckeditor/ckeditor.js', undefined, '/cms/core/vendor/ckeditor/ckeditor.js'],
  ])('with %j, assetUrl(%j, %j) is %j', (settings, path, options, expected) => {
    useSettings(settings);
    expect(assetUrl(path, options)).toBe(expected);
  });

  it('places admin assets under the configured admin directory', () => {
    useSettings({ MURA_CONTEXT: '/cms', MURA_ADMINDIR: 'manage' });
    expect(adminAssetUrl('js/admin.min.js', { coreversion: true })).toBe('/cms/manage/assets/js/admin.min.js?coreversion=7.6.1');
    expect(adminAssetUrl('ico/favicon.ico')).toBe('/cms/manage/assets/ico/favicon.ico');
  });
});
