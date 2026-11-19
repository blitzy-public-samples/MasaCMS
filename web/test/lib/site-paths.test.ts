// Unit tests for the site path getters and content URLs against core/mura/settings/settingsBean.cfc,
// core/mura/configBean.cfc, core/mura/content/contentServer.cfc and core/mura/content/contentRendererUtility.cfc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError } from '@/lib/gateway-client';
import {
  createHref,
  legacySitePath,
  legacySitePaths,
  legacyThemeAssetPath,
  siteBeanOf,
  sitePaths,
  urlStem,
  type PathRequest,
  type SiteBean,
} from '@/lib/site-paths';
import { adminS2Request } from '../helpers/admin-request';
import { LEGACY_SITE_PATHS_KEY, LEGACY_SITE_PATHS_PATH, fakeGatewayClient } from '../helpers/fake-gateway';

/** A local site on `www.example.com` with one alias and its own pools. */
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
    });
  });
});

describe('legacySitePaths', () => {
  const ANSWER = { restEndpoint: 'https://cms.example.test/_api/rest/v1/default', themeAssetPath: '/themes/default' };

  it("reads the named sites' values with the request's host facts, acting for no user", async () => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status: 200, body: ANSWER } }, { userToken: 'user' });
    const req = adminS2Request({
      httpHost: 'cms.example.test:8443',
      headers: new Headers({ 'x-forwarded-proto': 'https', 'front-end-https': 'on' }),
    });

    await expect(legacySitePaths(req, gateway, { apiSite: 'default', themeSite: 'tenant-a' })).resolves.toEqual(ANSWER);
    expect(gateway.calls).toEqual([
      {
        service: 'gateway',
        method: 'GET',
        path: LEGACY_SITE_PATHS_PATH,
        query: {
          sessionSite: 'default',
          host: 'cms.example.test:8443',
          forwardedProto: 'https',
          frontEndHttps: 'on',
          apiSite: 'default',
          themeSite: 'tenant-a',
        },
      },
    ]);
  });

  it('names the default site for an empty session site and sends only the forwarding headers present', async () => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status: 200, body: ANSWER } });
    const req = adminS2Request({ session: { siteid: '' }, headers: new Headers() });

    await legacySitePaths(req, gateway, { initSite: 'default' });
    expect(gateway.calls[0]?.query).toEqual({ sessionSite: 'default', host: 'localhost', initSite: 'default' });
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status } });

    await expect(legacySitePaths(adminS2Request(), gateway, { themeSite: 'default' })).rejects.toEqual(
      new GatewayDenialError('gateway', 'legacySitePaths', status),
    );
  });

  it("reads one site's getThemeAssetPath() and fails on an answer without it", async () => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status: 200, body: ANSWER } });

    await expect(legacyThemeAssetPath(adminS2Request(), gateway, 'tenant-a')).resolves.toBe('/themes/default');
    expect(gateway.calls[0]?.query).toMatchObject({ themeSite: 'tenant-a' });
    expect(legacySitePath(ANSWER, 'restEndpoint')).toBe(ANSWER.restEndpoint);
    expect(() => legacySitePath(ANSWER, 'initThemeAssetPath')).toThrow(
      new TypeError('legacySitePaths answered no initThemeAssetPath'),
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
  });
});

describe('urlStem', () => {
  const SITE_ID_ON = { MURA_SITEIDINURLS: 'true' };
  const LEGACY_LOCATION = { ...SITE_ID_ON, MURA_LEGACYINDEXFILELOCATION: 'true' };
  const BOTH_OFF = { MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false' };
  it.each<[string, Record<string, string>, Partial<SiteBean>, string, string]>([
    ['the template flags, a page', {}, {}, 'about-us', '/index.cfm/about-us/'],
    ['the template flags, the home page', {}, {}, '', '/'],
    ['siteIDInURLS on, a page', SITE_ID_ON, {}, 'about-us', '/index.cfm/default/about-us/'],
    ['siteIDInURLS on, the home page', SITE_ID_ON, {}, '', '/index.cfm/default/'],
    ['siteIDInURLS on and indexFileInURLS off, a page', { ...SITE_ID_ON, MURA_INDEXFILEINURLS: 'false' }, {}, 'news/update', '/default/news/update/'],
    ['siteIDInURLS on and indexFileInURLS off, the home page', { ...SITE_ID_ON, MURA_INDEXFILEINURLS: 'false' }, {}, '', '/default/'],
    ['both flags off, a page with its slashes', BOTH_OFF, {}, '/about-us/', '/about-us/'],
    ['legacyIndexFileLocation, a page', LEGACY_LOCATION, {}, 'about-us', '/sites/default/index.cfm/about-us/'],
    ['legacyIndexFileLocation, the home page', LEGACY_LOCATION, {}, '', '/sites/default/'],
    ['legacyIndexFileLocation under another site directory', { ...LEGACY_LOCATION, MURA_SITEDIR: 'content' }, {}, 'about-us', '/content/default/index.cfm/about-us/'],
    ['hashURLS, a page without a trailing slash', { ...BOTH_OFF, MURA_HASHURLS: 'true' }, {}, 'about-us', '/#/about-us'],
    ['hashURLS with siteIDInURLS and the index file', { ...SITE_ID_ON, MURA_HASHURLS: 'true' }, {}, 'about-us', '/index.cfm/default/#/about-us'],
    ['a remote site, whose renderer turns both flags off', SITE_ID_ON, REMOTE, 'about-us', '/about-us/'],
    ['a remote site, the home page', SITE_ID_ON, REMOTE, '', '/'],
  ])('builds the stem for %s', (_, vars, site, filename, expected) => {
    useSettings(vars);
    expect(urlStem({ ...SITE, ...site }, filename)).toBe(expected);
  });
});

describe('createHref', () => {
  const BOTH_OFF = { MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false' };
  const HASH = { ...BOTH_OFF, MURA_HASHURLS: 'true' };
  const ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
  const PREVIEW = `previewid=${ID}`;
  it.each<[string, Record<string, string>, Partial<SiteBean>, PathRequest, string, string, string]>([
    ['the template flags', {}, {}, ON_PRIMARY, 'about-us', PREVIEW, `http://www.example.com:8080/cms/index.cfm/about-us/?previewid=${ID}`],
    ['the home page on the oracle flags', BOTH_OFF, {}, ON_PRIMARY, '', PREVIEW, `http://www.example.com:8080/cms/?previewid=${ID}`],
    ['siteIDInURLS on', { MURA_SITEIDINURLS: 'true' }, {}, ON_PRIMARY, 'about-us', PREVIEW, `http://www.example.com:8080/cms/index.cfm/default/about-us/?previewid=${ID}`],
    ['a query string already starting with ?', BOTH_OFF, {}, ON_PRIMARY, 'about-us', `?${PREVIEW}`, `http://www.example.com:8080/cms/about-us/?previewid=${ID}`],
    ['no query string', BOTH_OFF, {}, ON_PRIMARY, 'about-us', '', 'http://www.example.com:8080/cms/about-us/'],
    ['hashURLS, a page', HASH, {}, ON_PRIMARY, 'about-us', PREVIEW, `http://www.example.com:8080/cms/#/about-us/_/previewid/${ID}`],
    ['hashURLS, a filename ending in /', HASH, {}, ON_PRIMARY, 'news/', PREVIEW, `http://www.example.com:8080/cms/#/news/_/previewid/${ID}`],
    ['hashURLS, the home page', HASH, {}, ON_PRIMARY, '', PREVIEW, `http://www.example.com:8080/cms/#/_/previewid/${ID}`],
    ['hashURLS, a bare and an encoded name', HASH, {}, ON_PRIMARY, 'about-us', '?a b=1&showMeta', 'http://www.example.com:8080/cms/#/about-us/_/a%20b/1/showMeta/true'],
    ['a remote site on its port and context', { MURA_SITEIDINURLS: 'true' }, REMOTE, ON_PRIMARY, 'about-us', PREVIEW, `http://www.example.com:8443/r/about-us/?previewid=${ID}`],
    ['an SSL site', BOTH_OFF, { useSSL: true }, ON_PRIMARY, 'about-us', PREVIEW, `https://www.example.com:8080/cms/about-us/?previewid=${ID}`],
    ['an HTTPS request', BOTH_OFF, {}, { ...ON_PRIMARY, https: true }, 'about-us', PREVIEW, `https://www.example.com:8080/cms/about-us/?previewid=${ID}`],
    ['the preview alias the request came in on', BOTH_OFF, {}, ON_ALIAS, 'about-us', PREVIEW, `http://alias.example.com:8080/cms/about-us/?previewid=${ID}`],
    ['the site domain for a host the site does not hold', BOTH_OFF, {}, { ...ON_ALIAS, httpHost: 'other.example.com' }, 'about-us', PREVIEW, `http://www.example.com:8080/cms/about-us/?previewid=${ID}`],
    ['HTMLEditFormat over the whole URL', BOTH_OFF, {}, ON_PRIMARY, 'a&b"<c>', 'x=1&y=2', 'http://www.example.com:8080/cms/a&amp;b&quot;&lt;c&gt;/?x=1&amp;y=2'],
  ])('builds the complete URL with %s', (_, vars, site, request, filename, querystring, expected) => {
    useSettings(vars);
    expect(createHref(request, { ...SITE, ...site }, filename, querystring)).toBe(expected);
  });

  it('fails as legacy does on a hash-URL pair without a name', () => {
    useSettings(HASH);
    expect(() => createHref(ON_PRIMARY, SITE, 'about-us', 'a=1&==')).toThrow(
      new RangeError('The element at position 1 of the list "==" cannot be found.'),
    );
  });
});
