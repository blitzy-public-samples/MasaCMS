// Unit tests for the site path getters against core/mura/settings/settingsBean.cfc and core/mura/configBean.cfc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { siteBeanOf, sitePaths, type PathRequest, type SiteBean, type ThemeLayout } from '@/lib/site-paths';
import { adminS2Request } from '../helpers/admin-request';

/** A local site on `www.example.com` with one alias, its own pools and theme `MyTheme`. */
const SITE: SiteBean = {
  siteId: 'default',
  domain: 'www.example.com',
  domainAliases: ['alias.example.com'],
  enforcePrimaryDomain: false,
  useSSL: false,
  isRemote: false,
  remoteContext: '',
  remotePort: 80,
  resourceSSL: false,
  resourceDomain: '',
  displayPoolID: 'default',
  filePoolID: 'default',
  theme: 'MyTheme',
};

const ON_PRIMARY: PathRequest = { https: false, serverName: 'www.example.com', httpHost: 'www.example.com:8080' };
const ON_ALIAS: PathRequest = { https: false, serverName: 'alias.example.com', httpHost: 'alias.example.com:8080' };
const ON_ADMIN: PathRequest = { https: false, serverName: 'admin.example.com', httpHost: 'admin.example.com' };
const REMOTE: Partial<SiteBean> = { isRemote: true, remotePort: 8443, remoteContext: '/r' };
const RESOURCE: Partial<SiteBean> = { ...REMOTE, resourceDomain: 'static.example.com' };

/** Clears every `MURA_` variable, then sets port 8080 and context `/cms` under `vars`. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ MURA_PORT: '8080', MURA_CONTEXT: '/cms', ...vars })) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

const pathsOf = (site: Partial<SiteBean> = {}, request: PathRequest = ON_PRIMARY) =>
  sitePaths(request, { ...SITE, ...site });

beforeEach(() => useSettings());

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('siteBeanOf', () => {
  it('reads the served row with the bean defaults for NULL columns', () => {
    const site = adminS2Request({
      site: { record: { domainAlias: 'a.test\r\nb.test\nc.test', useSSL: null, ExtranetSSL: 1, remoteport: null } },
    }).site;
    expect(site).toBeDefined();
    if (site === undefined) return;
    expect(siteBeanOf(site)).toEqual({
      ...SITE,
      domain: 'localhost',
      domainAliases: ['a.test', 'b.test', 'c.test'],
      useSSL: true,
      theme: '',
    });
  });
});

describe('themeAssetPath', () => {
  it.each<[ThemeLayout, string, string, string]>([
    ['site', 'default', '/cms/sites/default/themes/MyTheme', 'http://www.example.com:8080/cms/sites/default/themes/MyTheme'],
    ['site', 'umbrella', '/cms/sites/umbrella/themes/MyTheme', 'http://www.example.com:8080/cms/sites/umbrella/themes/MyTheme'],
    ['siteIncludes', 'default', '/cms/sites/default/includes/themes/MyTheme', 'http://www.example.com:8080/cms/sites/default/includes/themes/MyTheme'],
    ['siteIncludes', 'umbrella', '/cms/sites/umbrella/includes/themes/MyTheme', 'http://www.example.com:8080/cms/sites/umbrella/includes/themes/MyTheme'],
    ['webRoot', 'default', '/cms/themes/MyTheme', 'http://www.example.com:8080/cms/themes/MyTheme'],
    ['webRoot', 'umbrella', '/cms/themes/MyTheme', 'http://www.example.com:8080/cms/themes/MyTheme'],
    ['none', 'default', '/cms/sites/default', 'http://www.example.com:8080/cms/sites/default'],
    ['none', 'umbrella', '/cms/sites/umbrella', 'http://www.example.com:8080/cms/sites/umbrella'],
  ])('resolves a %s theme of display pool %s', (layout, displayPoolID, relative, complete) => {
    const paths = pathsOf({ displayPoolID });
    expect(paths.themeAssetPath(layout, false)).toBe(relative);
    expect(paths.themeAssetPath(layout, true)).toBe(complete);
  });

  it('follows the site directory setting and the preview alias', () => {
    useSettings({ MURA_SITEDIR: 'content' });
    expect(pathsOf({}, ON_ALIAS).themeAssetPath('site', true)).toBe(
      'http://alias.example.com:8080/cms/content/default/themes/MyTheme',
    );
  });
});

describe('fileAssetPath', () => {
  it.each<[string, Record<string, string>, boolean, string]>([
    ['the site directory, not complete', {}, false, '/cms/sites/tenant-b'],
    ['the site directory, complete', {}, true, 'http://www.example.com:8080/cms/sites/tenant-b'],
    ['a fileAssetPath override, not complete', { MURA_FILEASSETPATH: '//files.example.com/assets' }, false, '//files.example.com/assets/tenant-b'],
    ['a fileAssetPath override, complete', { MURA_FILEASSETPATH: '//files.example.com/assets' }, true, '//files.example.com/assets/tenant-b'],
  ])('resolves the file pool under %s', (_, vars, complete, expected) => {
    useSettings(vars);
    expect(pathsOf({ filePoolID: 'tenant-b' }).fileAssetPath(complete)).toBe(expected);
  });
});

describe.each([
  ['corePath', 'MURA_COREPATH', '/core'],
  ['pluginsPath', 'MURA_PLUGINSPATH', '/plugins'],
] as const)('%s', (getter, variable, suffix) => {
  const override = `https://cdn.example.com${suffix}`;
  const ADMIN = { MURA_ADMINDOMAIN: 'admin.example.com' };
  it.each<[string, Record<string, string>, Partial<SiteBean>, PathRequest, string]>([
    ['the admin-domain URL on the admin host', ADMIN, {}, ON_ADMIN, `http://admin.example.com:8080/cms${suffix}`],
    ['the override on the admin host', { ...ADMIN, [variable]: override }, {}, ON_ADMIN, override],
    ['the override off the admin host', { ...ADMIN, [variable]: override }, {}, ON_PRIMARY, override],
    ['the site URL without an admin domain', { [variable]: override }, {}, ON_PRIMARY, `http://www.example.com:8080/cms${suffix}`],
    ['the resource domain of a remote site', { ...ADMIN, [variable]: override }, RESOURCE, ON_ADMIN, `http://static.example.com:8080/cms${suffix}`],
  ])('returns %s', (_, vars, site, request, expected) => {
    useSettings(vars);
    expect(pathsOf(site, request)[getter](true)).toBe(expected);
  });

  it('stays context-relative off an admin domain when not complete', () => {
    useSettings({ [variable]: override });
    expect(pathsOf()[getter](false)).toBe(`/cms${suffix}`);
  });
});

describe('webPath', () => {
  it.each<[string, Partial<SiteBean>, PathRequest, string]>([
    ['the primary domain', {}, ON_PRIMARY, 'http://www.example.com:8080/cms'],
    ['a preview alias over enforcePrimaryDomain', { enforcePrimaryDomain: true }, ON_ALIAS, 'http://alias.example.com:8080/cms'],
    ['an unknown host on an enforced primary domain', { enforcePrimaryDomain: true }, { ...ON_ALIAS, httpHost: 'other.example.com' }, 'http://www.example.com:8080/cms'],
    ['the server name when the Host header is empty', {}, { ...ON_ALIAS, httpHost: '' }, 'http://alias.example.com:8080/cms'],
    ['a remote site on a preview alias', REMOTE, ON_ALIAS, 'http://alias.example.com:8443/r'],
    ['a remote site on an unknown host', REMOTE, { ...ON_ALIAS, httpHost: 'other.example.com' }, 'http://www.example.com:8443/r'],
    ['a remote site on port 443', { ...REMOTE, remotePort: 443 }, ON_PRIMARY, 'http://www.example.com/r'],
    ['an SSL site', { useSSL: true }, ON_PRIMARY, 'https://www.example.com:8080/cms'],
    ['an HTTPS request', {}, { ...ON_PRIMARY, https: true }, 'https://www.example.com:8080/cms'],
  ])('uses %s', (_, site, request, expected) => {
    expect(pathsOf(site, request).webPath()).toBe(expected);
  });

  it('keeps an empty remote domain where the resource path takes the server name', () => {
    const paths = pathsOf({ ...REMOTE, domain: '' }, { ...ON_ALIAS, httpHost: 'other.example.com' });
    expect(paths.webPath()).toBe('http://:8443/r');
    expect(paths.rootPath(true)).toBe('http://alias.example.com:8443/r');
  });
});

describe('remote sites', () => {
  it.each<[string, Partial<SiteBean>, PathRequest, string, string]>([
    ['without a resource domain', REMOTE, ON_ALIAS, '/r', 'http://alias.example.com:8443/r'],
    ['with a resource domain', RESOURCE, ON_ALIAS, 'http://static.example.com:8080/cms', 'http://static.example.com:8080/cms'],
    ['with an SSL resource domain', { ...RESOURCE, resourceSSL: true }, ON_ALIAS, 'https://static.example.com:8080/cms', 'https://static.example.com:8080/cms'],
  ])('resolves the root and asset paths %s', (_, site, request, relative, complete) => {
    const paths = pathsOf(site, request);
    expect(paths.rootPath(false)).toBe(relative);
    expect(paths.rootPath(true)).toBe(complete);
    expect(paths.assetPath(true)).toBe(`${complete}/sites/default`);
    expect(paths.themeAssetPath('webRoot', false)).toBe(`${relative}/themes/MyTheme`);
  });
});
