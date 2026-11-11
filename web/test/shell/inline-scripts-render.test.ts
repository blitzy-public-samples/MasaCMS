// Unit tests for the layout inline scripts against admin/common/layouts/template.cfm and compact.cfm.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { encodeJs, isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderCompactScripts, renderMuraInit, renderTemplateScripts } from '@/shell/inline-scripts';
import type { ShellContext, ShellLayout } from '@/shell/types';
import { tenantASiteAdminSession } from '../fixtures/session';
import { adminS2Request, editorRequest, siteAdminRequest, type AdminRequestPartial } from '../helpers/admin-request';

const LAYOUTS = fileURLToPath(new URL('../../../admin/common/layouts/', import.meta.url));

/** The `Mura.init` values the settingsBean getters return with `complete=1`, and the two global settings it prints. */
interface InitValues {
  readonly context: string;
  readonly siteid: string;
  readonly themepath: string;
  readonly assetpath: string;
  readonly corepath: string;
  readonly fileassetpath: string;
  readonly adminpath: string;
  readonly pluginspath: string;
  readonly rootpath: string;
  readonly indexfileinapi: 'true' | 'false';
}

/** Values the layout scripts print besides `Mura.init`. */
interface ScriptValues {
  readonly init: InitValues;
  /** `session.siteid`; defaults to the init site. */
  readonly sessionSiteId?: string;
  readonly adminDir?: string;
  /** `session.frontEndProxyLoc` after `compact.cfm` 86-91. */
  readonly frontEndProxyLoc?: string;
  /** `rc.sourceFrame`; defaults to `modal`. */
  readonly sourceFrame?: string;
}

/** `Mura.init` as the legacy oracle (port 8080, `indexfileinurls=false`) printed it for the installed admin. */
const ORACLE_INIT = [
  'Mura.init({',
  '\t\t\t\tinAdmin:true,',
  "\t\t\t\tcontext:'',",
  "\t\t\t\tthemepath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fthemes\\x2Fdefault',",
  "\t\t\t\tsiteid:'default',",
  "\t\t\t\tassetpath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fsites\\x2Fdefault',",
  "\t\t\t\tsitespath:'',",
  "\t\t\t\tcorepath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fcore',",
  "\t\t\t\tfileassetpath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fsites\\x2Fdefault',",
  "\t\t\t\tadminpath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fadmin',",
  "\t\t\t\tthemepath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fthemes\\x2Fdefault',",
  "\t\t\t\tpluginspath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fplugins',",
  "\t\t\t\trootpath:'http\\x3A\\x2F\\x2Flocalhost\\x3A8080',",
  '\t\t\t\tindexfileinapi: false',
  '\t\t\t});',
].join('\n');

const ORACLE_SETTINGS = { MURA_PORT: '8080', MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false' } as const;

/** settingsBean getters `Mura.init` calls, by the name after `get`. */
const GETTERS: Readonly<Record<string, (init: InitValues) => string>> = {
  ThemeAssetPath: (init) => init.themepath,
  SiteID: (init) => init.siteid,
  AssetPath: (init) => init.assetpath,
  // settingsBean has no getSitesPath; its missing-method getter returns ''.
  SitesPath: () => '',
  CorePath: (init) => init.corepath,
  FileAssetPath: (init) => init.fileassetpath,
  AdminPath: (init) => init.adminpath,
  PluginsPath: (init) => init.pluginspath,
  RootPath: (init) => init.rootpath,
};

/** Init values of site `siteid` (default `default`) with every path under `root`: own pools, `/sites`, `/admin`. */
function under(root: string, overrides: Partial<InitValues> = {}): InitValues {
  const siteid = overrides.siteid ?? 'default';
  return {
    context: '',
    siteid,
    themepath: `${root}/themes/default`,
    assetpath: `${root}/sites/${siteid}`,
    corepath: `${root}/core`,
    fileassetpath: `${root}/sites/${siteid}`,
    adminpath: `${root}/admin`,
    pluginspath: `${root}/plugins`,
    rootpath: root,
    indexfileinapi: 'true',
    ...overrides,
  };
}

/** The layout's inline `<script>…</script>` from its CFML source, with the expressions evaluated from `values`. */
function legacyScript(layout: ShellLayout, values: ScriptValues): string {
  const { init } = values;
  const source = readFileSync(path.join(LAYOUTS, `${layout}.cfm`), 'utf8').replaceAll('\r\n', '\n');
  const [anchor, opener] =
    layout === 'template'
      ? ['<cfif request.action neq "core:cLogin.main"', '<script>']
      : ['#session.dateKey#', '<script type="text/javascript">'];
  const start = source.indexOf(opener, source.indexOf(anchor));
  const block = source.slice(start, source.indexOf('</script>', start) + '</script>'.length);
  const evaluated = block
    .replace(/<cfif isDefined\('session\.siteid'\)[\s\S]*?<\/cfif>/, '')
    .replace(/#esapiEncode\("javascript",site\.get(\w+)\((?:complete=1)?\)\)#/g, (_, getter: string) => {
      const value = GETTERS[getter];
      if (value === undefined) throw new Error(`Unmapped getter get${getter}`);
      return encodeJs(value(init));
    })
    .replaceAll(`#esapiEncode("javascript",rc.$.globalConfig('context'))#`, () => encodeJs(init.context))
    .replaceAll("#rc.$.globalConfig('indexfileinapi')#", () => init.indexfileinapi)
    .replaceAll("#esapiEncode('javascript',session.siteid)#", () => encodeJs(values.sessionSiteId ?? init.siteid))
    .replaceAll("#esapiEncode('javascript',session.frontEndProxyLoc)#", () => encodeJs(values.frontEndProxyLoc ?? ''))
    .replaceAll('#application.configBean.getContext()#', () => init.context)
    .replaceAll('#application.configBean.getAdminDir()#', () => values.adminDir ?? '/admin')
    .replaceAll('#esapiEncode("javascript",rc.sourceFrame)#', () => encodeJs(values.sourceFrame ?? 'modal'))
    .replaceAll('##', '#');
  expect(evaluated).not.toMatch(/#[\w$]+[.(]|<\/?cf/);
  return evaluated;
}

/** The legacy `Mura.init({…});` statement for `init`. */
function legacyInit(init: InitValues): string {
  const script = legacyScript('template', { init });
  const start = script.indexOf('Mura.init({');
  return script.slice(start, script.indexOf('});', start) + '});'.length);
}

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** The S2 admin with its `default` site served on theme `default`; `partial.site` members are laid over that. */
function installed(partial: AdminRequestPartial = {}): AdminRequest {
  return adminS2Request({
    ...partial,
    site: { ...partial.site, record: { theme: 'default', ...partial.site?.record } },
  });
}

/** A shell context around `ctx` in `layout`; the scripts read nothing else. */
function shellContext(ctx: AdminRequest, layout: ShellLayout = 'template'): ShellContext {
  return {
    ctx,
    view: { body: raw('') },
    hooks: { secondaryMenus: {} },
    data: {
      rb: { locale: 'en_US', rbKey: (key) => key, messageFormat: (pattern) => pattern },
      user: { fname: '', lname: '', passwordExpired: false, hasDefaultPassword: false },
      userSites: [],
      prompts: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
      sitePlugins: [],
      server: null,
      updateCoreCsrfQuery: '',
      exportLocationExists: false,
      now: new Date(0),
    },
    layout,
    originalCircuit: ctx.circuit,
    originalFuseaction: ctx.item,
    moduleTitle: '',
    bodyclass: '',
    siteId: ctx.session.siteid,
  };
}

/** The markup of a script renderer, which must be SafeHtml. */
function markupOf(rendered: SafeHtml): string {
  expect(isSafeHtml(rendered)).toBe(true);
  return toString(rendered);
}

const templateScripts = (ctx: AdminRequest): string => markupOf(renderTemplateScripts(shellContext(ctx)));

const compactScripts = (ctx: AdminRequest, frontEndProxyLoc?: string): string =>
  markupOf(
    frontEndProxyLoc === undefined
      ? renderCompactScripts(shellContext(ctx, 'compact'))
      : renderCompactScripts(shellContext(ctx, 'compact'), frontEndProxyLoc),
  );

/** One single-quoted `Mura.init` member holding only ESAPI-encoded characters. */
const ENCODED_MEMBER = /^\t{4}\w+:'(?:[\w,.]|\\x[0-9A-F]{2}|\\u[0-9A-F]{4})*',$/;

beforeEach(() => {
  useSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderMuraInit', () => {
  it('prints the statement the legacy oracle printed for the installed admin', () => {
    useSettings(ORACLE_SETTINGS);
    expect(renderMuraInit(shellContext(installed()))).toBe(ORACLE_INIT);
  });

  const ADMIN_DOMAIN = { MURA_PORT: '8080', MURA_ADMINDOMAIN: 'admin.example.com' } as const;
  const onAdminHost = { httpHost: 'admin.example.com', serverName: 'admin.example.com' } as const;
  const aliased = {
    domain: 'www.example.com',
    record: { domainAlias: 'cms.example.com\r\nalias.example.com\nmirror.example.com' },
  } as const;
  const remote = { isremote: 1, remotecontext: '/remote', remoteport: 8443 } as const;
  const resourceSite = { ...remote, resourceDomain: 'static.example.com' } as const;

  it.each<[string, Record<string, string>, () => AdminRequest, InitValues]>([
    ['the installed site on the request host', {}, () => installed(), under('http://localhost')],
    [
      'a served site without a theme',
      {},
      () => adminS2Request(),
      under('http://localhost', { themepath: 'http://localhost/themes/' }),
    ],
    [
      'context, port, admin and site directory settings',
      { MURA_CONTEXT: '/cms', MURA_PORT: '8443', MURA_ADMINDIR: 'manage', MURA_SITEDIR: 'content' },
      () => installed(),
      under('http://localhost:8443/cms', {
        context: '/cms',
        assetpath: 'http://localhost:8443/cms/content/default',
        fileassetpath: 'http://localhost:8443/cms/content/default',
        adminpath: 'http://localhost:8443/cms/manage',
      }),
    ],
    [
      'an empty site directory',
      { MURA_SITEDIR: '' },
      () => installed(),
      under('http://localhost', { assetpath: 'http://localhost/default', fileassetpath: 'http://localhost/default' }),
    ],
    [
      'shared display and file pools',
      {},
      () => installed({ site: { displayPoolID: 'umbrella', filePoolID: 'tenant-b' } }),
      under('http://localhost', {
        assetpath: 'http://localhost/sites/umbrella',
        fileassetpath: 'http://localhost/sites/tenant-b',
      }),
    ],
    ['a site served over SSL', {}, () => installed({ site: { record: { useSSL: 1 } } }), under('https://localhost')],
    [
      'a NULL useSSL read with extranetSSL on',
      {},
      () => installed({ site: { record: { useSSL: null, ExtranetSSL: 1 } } }),
      under('https://localhost'),
    ],
    [
      'useSSL off overriding extranetSSL',
      {},
      () => installed({ site: { record: { useSSL: 0, ExtranetSSL: 1 } } }),
      under('http://localhost'),
    ],
    ['an HTTPS request', {}, () => installed({ https: true }), under('https://localhost')],
    [
      'a request on a domain alias, keeping the Host header case and dropping its port',
      {},
      () => installed({ site: aliased, httpHost: 'Alias.example.com:8080', serverName: 'alias.example.com' }),
      under('http://Alias.example.com'),
    ],
    [
      'a request on a domain alias after a bare line feed',
      {},
      () => installed({ site: aliased, httpHost: 'mirror.example.com', serverName: 'mirror.example.com' }),
      under('http://mirror.example.com'),
    ],
    [
      'a request host outside the site domains',
      {},
      () => installed({ site: aliased, httpHost: 'other.example.com', serverName: 'other.example.com' }),
      under('http://www.example.com'),
    ],
    [
      'a request host outside the site domains on an aliased server name',
      {},
      () => installed({ site: aliased, httpHost: 'other.example.com', serverName: 'cms.example.com' }),
      under('http://www.example.com'),
    ],
    [
      'an empty Host header on an aliased server name',
      {},
      () => installed({ site: aliased, httpHost: '', serverName: 'cms.example.com' }),
      under('http://cms.example.com'),
    ],
    [
      'a site without a domain reached on a server-name alias',
      {},
      () =>
        installed({
          site: { domain: '', record: { domainAlias: 'cms.example.com' } },
          httpHost: 'other.example.com',
          serverName: 'cms.example.com',
        }),
      under('http://cms.example.com'),
    ],
    [
      'a site without a domain that enforces its primary domain',
      {},
      () =>
        installed({
          site: { domain: '', record: { domainAlias: 'cms.example.com', enforcePrimaryDomain: 1 } },
          httpHost: 'other.example.com',
          serverName: 'cms.example.com',
        }),
      under('http://'),
    ],
    [
      'a remote site on its own port and context',
      { MURA_CONTEXT: '/cms' },
      () => installed({ site: { record: remote } }),
      under('http://localhost:8443/remote', { context: '/cms' }),
    ],
    [
      'a remote site on port 443',
      { MURA_CONTEXT: '/cms' },
      () => installed({ site: { record: { ...remote, remoteport: 443 } } }),
      under('http://localhost/remote', { context: '/cms' }),
    ],
    [
      'a remote site with a NULL port',
      {},
      () => installed({ site: { record: { ...remote, remoteport: null } } }),
      under('http://localhost/remote'),
    ],
    [
      'a remote site with an SSL resource domain, which also replaces the admin domain',
      { ...ADMIN_DOMAIN, MURA_CONTEXT: '/cms' },
      () => installed({ site: { record: { ...resourceSite, resourceSSL: 1 } }, ...onAdminHost }),
      under('https://static.example.com:8080/cms', { context: '/cms' }),
    ],
    [
      'a remote site with a plain resource domain',
      {},
      () => installed({ site: { record: resourceSite } }),
      under('http://static.example.com'),
    ],
    [
      'a resource domain on a site that is not remote',
      {},
      () => installed({ site: { record: { resourceDomain: 'static.example.com', resourceSSL: 1 } } }),
      under('http://localhost'),
    ],
    [
      'a plain resource domain on an HTTPS request',
      {},
      () => installed({ site: { record: resourceSite }, https: true }),
      under('https://static.example.com'),
    ],
    [
      'a request on the admin domain',
      ADMIN_DOMAIN,
      () => installed(onAdminHost),
      under('http://localhost:8080', {
        corepath: 'http://admin.example.com:8080/core',
        adminpath: 'http://admin.example.com:8080/admin',
        pluginspath: 'http://admin.example.com:8080/plugins',
      }),
    ],
    [
      'an admin-domain Host header carrying a port, which leaves core and plugins context-relative',
      ADMIN_DOMAIN,
      () => installed({ httpHost: 'admin.example.com:8080', serverName: 'admin.example.com' }),
      under('http://localhost:8080', {
        corepath: '/core',
        adminpath: 'http://admin.example.com:8080/admin',
        pluginspath: '/plugins',
      }),
    ],
    [
      'admin SSL on the admin domain',
      { ...ADMIN_DOMAIN, MURA_ADMINSSL: 'true' },
      () => installed(onAdminHost),
      under('http://localhost:8080', {
        corepath: 'https://admin.example.com:8080/core',
        adminpath: 'https://admin.example.com:8080/admin',
        pluginspath: 'https://admin.example.com:8080/plugins',
      }),
    ],
    [
      'an SSL site on the admin domain, whose admin path ignores the site scheme',
      ADMIN_DOMAIN,
      () => installed({ site: { record: { useSSL: 1 } }, ...onAdminHost }),
      under('https://localhost:8080', {
        corepath: 'https://admin.example.com:8080/core',
        adminpath: 'http://admin.example.com:8080/admin',
        pluginspath: 'https://admin.example.com:8080/plugins',
      }),
    ],
    [
      'a host outside the admin domain list',
      { MURA_PORT: '8080', MURA_ADMINDOMAIN: 'admin.example.com,cms.example.com' },
      () => installed({ httpHost: 'www.example.com', serverName: 'www.example.com' }),
      under('http://localhost:8080', {
        corepath: 'http://www.example.com:8080/core',
        adminpath: 'http://www.example.com:8080/admin',
        pluginspath: 'http://www.example.com:8080/plugins',
      }),
    ],
    [
      'a non-admin Host header carrying a port, which legacy keeps whole',
      { MURA_ADMINDOMAIN: 'admin.example.com' },
      () => installed({ httpHost: 'www.example.com:8080', serverName: 'www.example.com' }),
      under('http://localhost', {
        corepath: 'http://www.example.com:8080/core',
        adminpath: 'http://www.example.com:8080/admin',
        pluginspath: 'http://www.example.com:8080/plugins',
      }),
    ],
    [
      'an HTTPS request on a listed admin domain written in another case',
      { MURA_PORT: '8080', MURA_ADMINDOMAIN: 'admin.example.com,cms.example.com' },
      () => installed({ httpHost: 'CMS.Example.com', serverName: 'CMS.Example.com', https: true }),
      under('https://localhost:8080', {
        corepath: 'https://CMS.Example.com:8080/core',
        adminpath: 'https://CMS.Example.com:8080/admin',
        pluginspath: 'https://CMS.Example.com:8080/plugins',
      }),
    ],
    [
      'an editor whose session site is not served',
      {},
      () => editorRequest(),
      under('http://localhost', { themepath: 'http://localhost/themes/' }),
    ],
    [
      'an unserved session site on another server name',
      { MURA_PORT: '8080' },
      () => editorRequest({ httpHost: 'cms.example.com:8080', serverName: 'cms.example.com' }),
      under('http://cms.example.com:8080', { themepath: 'http://cms.example.com:8080/themes/' }),
    ],
    [
      'the tenant-a site admin',
      {},
      () => siteAdminRequest(tenantASiteAdminSession.siteid),
      under('http://localhost', { siteid: 'tenant-a', themepath: 'http://localhost/themes/' }),
    ],
  ])('matches the legacy getters for %s', (_, settings, request, expected) => {
    useSettings(settings);
    expect(renderMuraInit(shellContext(request()))).toBe(legacyInit(expected));
  });

  it.each<[Record<string, string>, InitValues['indexfileinapi']]>([
    [{}, 'true'],
    [{ MURA_INDEXFILEINURLS: 'true' }, 'true'],
    [{ MURA_INDEXFILEINURLS: 'false' }, 'false'],
    [{ MURA_INDEXFILEINAPI: 'false' }, 'false'],
    [{ MURA_INDEXFILEINURLS: 'false', MURA_INDEXFILEINAPI: 'true' }, 'true'],
    [{ MURA_SITEIDINURLS: 'true' }, 'true'],
    [{ MURA_SITEIDINURLS: 'false', MURA_HTMLEDITORTYPE: 'markitup' }, 'true'],
  ])('prints the URL-flag settings %j as indexfileinapi %s and never in a path', (settings, indexfileinapi) => {
    useSettings(settings);
    const init = renderMuraInit(shellContext(installed()));
    expect(init).toBe(legacyInit(under('http://localhost', { indexfileinapi })));
    expect(init).toContain(`\n\t\t\t\tindexfileinapi: ${indexfileinapi}\n\t\t\t});`);
  });

  it('encodes every untrusted value with the ESAPI JavaScript codec', () => {
    useSettings({ MURA_CONTEXT: "/c'ms" });
    const init = renderMuraInit(
      shellContext(installed({ session: { siteid: 'x"y</script>' }, site: { record: { theme: "it's" } } })),
    );
    expect(init).toContain("\t\t\t\tcontext:'\\x2Fc\\x27ms',\n");
    expect(init).toContain("\t\t\t\tsiteid:'x\\x22y\\x3C\\x2Fscript\\x3E',\n");
    expect(init).toContain("\t\t\t\tthemepath:'http\\x3A\\x2F\\x2Flocalhost\\x2Fc\\x27ms\\x2Fthemes\\x2Fit\\x27s',\n");
    expect(init).toContain(
      "\t\t\t\tassetpath:'http\\x3A\\x2F\\x2Flocalhost\\x2Fc\\x27ms\\x2Fsites\\x2Fx\\x22y\\x3C\\x2Fscript\\x3E',\n",
    );
    const members = init.split('\n').slice(2, -2);
    expect(members).toHaveLength(11);
    for (const member of members) expect(member).toMatch(ENCODED_MEMBER);
  });

  it('encodes a Host header that names no admin domain wherever it reaches a path', () => {
    useSettings({ MURA_ADMINDOMAIN: 'admin.example.com' });
    const init = renderMuraInit(shellContext(installed({ httpHost: "x'.example", serverName: "x'.example" })));
    expect(init).toContain("\t\t\t\tcorepath:'http\\x3A\\x2F\\x2Fx\\x27.example\\x2Fcore',\n");
    expect(init).toContain("\t\t\t\tadminpath:'http\\x3A\\x2F\\x2Fx\\x27.example\\x2Fadmin',\n");
    expect(init).toContain("\t\t\t\trootpath:'http\\x3A\\x2F\\x2Flocalhost',\n");
  });

  it('returns plain text that both layout scripts embed verbatim', () => {
    const ctx = installed();
    const init = renderMuraInit(shellContext(ctx));
    expect(isSafeHtml(init)).toBe(false);
    expect(templateScripts(ctx)).toContain(`\n\t\t\t\n\t\t\t${init}\n\n\t\t\t</script>`);
    expect(compactScripts(ctx)).toContain(`\n\t\t\t\n\t\t\t${init}\n\t\t</script>`);
  });
});

describe('renderTemplateScripts', () => {
  it.each<[string, Record<string, string>, () => AdminRequest, ScriptValues]>([
    [
      'the installed admin on the oracle settings',
      ORACLE_SETTINGS,
      () => installed(),
      { init: under('http://localhost:8080', { indexfileinapi: 'false' }) },
    ],
    [
      'a context and admin directory',
      { MURA_CONTEXT: '/cms', MURA_ADMINDIR: 'manage' },
      () => installed(),
      { init: under('http://localhost/cms', { context: '/cms', adminpath: 'http://localhost/cms/manage' }) },
    ],
    [
      'the tenant-a site admin',
      {},
      () => siteAdminRequest(tenantASiteAdminSession.siteid),
      { init: under('http://localhost', { siteid: 'tenant-a', themepath: 'http://localhost/themes/' }) },
    ],
  ])('matches the legacy template script for %s', (_, settings, request, values) => {
    useSettings(settings);
    expect(templateScripts(request())).toBe(legacyScript('template', values));
  });

  it('dismisses alerts for the session site and opens with the legacy handlers', () => {
    const markup = templateScripts(siteAdminRequest(tenantASiteAdminSession.siteid));
    expect(
      markup.startsWith("<script>\n\t\t\t$(document).on('click', '.selectAssocImageResults ul li', function(e){\n"),
    ).toBe(true);
    expect(markup).toContain(
      "\t\t\t\t\t\t\t\turl:'./',\n\t\t\t\t\t\t\t\tdata:{\n\t\t\t\t\t\t\t\t\tsiteid:'tenant\\x2Da',\n" +
        "\t\t\t\t\t\t\t\t\talertid:$(_alert).attr('data-alertid'),\n" +
        "\t\t\t\t\t\t\t\t\tmuraaction:'cdashboard.dismissAlert'\n",
    );
    expect(markup).toContain("createCookie('ADMINCONTROLWIDTH',acw,5);");
    expect(markup).toContain("createCookie('ADMINSIDEBAR',asb,5);");
  });

  it('sends an empty alert site and initialises the default site when the session holds no site', () => {
    const ctx = editorRequest();
    const blank: AdminRequest = { ...ctx, session: { ...ctx.session, siteid: '' } };
    const markup = templateScripts(blank);
    expect(markup).toBe(
      legacyScript('template', {
        init: under('http://localhost', { themepath: 'http://localhost/themes/' }),
        sessionSiteId: '',
      }),
    );
    expect(markup).toContain("\t\t\t\t\t\t\t\t\tsiteid:'',\n\t\t\t\t\t\t\t\t\talertid:");
    expect(markup).toContain("\t\t\t\tsiteid:'default',\n");
  });

  it('keeps an untrusted session site inside its script strings', () => {
    const markup = templateScripts(installed({ session: { siteid: "a'b</script><script>alert(1)//" } }));
    const encoded = 'a\\x27b\\x3C\\x2Fscript\\x3E\\x3Cscript\\x3Ealert\\x281\\x29\\x2F\\x2F';
    expect(markup).toContain(`\t\t\t\t\t\t\t\t\tsiteid:'${encoded}',\n`);
    expect(markup).toContain(`\t\t\t\tsiteid:'${encoded}',\n`);
    expect(markup.match(/<\/script>/g)).toHaveLength(1);
    expect(markup.endsWith('\n\t\t\t</script>')).toBe(true);
  });
});

describe('renderCompactScripts', () => {
  it.each<[string, Record<string, string>, () => AdminRequest, ScriptValues]>([
    [
      'the installed admin in a modal',
      ORACLE_SETTINGS,
      () => installed(),
      { init: under('http://localhost:8080', { indexfileinapi: 'false' }) },
    ],
    [
      'the tenant-a site admin under a context and admin directory, with its stored proxy location',
      { MURA_CONTEXT: '/cms', MURA_ADMINDIR: 'manage' },
      () =>
        siteAdminRequest(tenantASiteAdminSession.siteid, {
          session: { frontEndProxyLoc: tenantASiteAdminSession.frontEndProxyLoc },
        }),
      {
        init: under('http://localhost/cms', {
          context: '/cms',
          siteid: 'tenant-a',
          themepath: 'http://localhost/cms/themes/',
          adminpath: 'http://localhost/cms/manage',
        }),
        adminDir: '/manage',
        frontEndProxyLoc: 'http://tenant-a.localhost:8100',
      },
    ],
    [
      'a front-end editor frame named by the request',
      {},
      () => installed({ rc: { frontEndProxyLoc: 'http://localhost:8100', sourceFrame: 'frontEndEditor' } }),
      { init: under('http://localhost'), frontEndProxyLoc: 'http://localhost:8100', sourceFrame: 'frontEndEditor' },
    ],
  ])('matches the legacy compact script for %s', (_, settings, request, values) => {
    useSettings(settings);
    expect(compactScripts(request())).toBe(legacyScript('compact', values));
  });

  it.each<[string, string | undefined, string, string]>([
    ['no request value', undefined, 'http://session.example', 'http\\x3A\\x2F\\x2Fsession.example'],
    ['an empty request value', '', 'http://session.example', 'http\\x3A\\x2F\\x2Fsession.example'],
    ['a request value', 'http://rc.example:8100', 'http://session.example', 'http\\x3A\\x2F\\x2Frc.example\\x3A8100'],
    ['neither value', '', '', ''],
  ])('posts to the porthole proxy of the effective proxy location for %s', (_, requested, stored, encoded) => {
    const ctx = installed({ rc: { frontEndProxyLoc: requested }, session: { frontEndProxyLoc: stored } });
    expect(compactScripts(ctx)).toContain(
      `\t\t\t\t\tfrontEndProxy = new Porthole.WindowProxy("${encoded}/admin/assets/js/porthole/proxy.html");\n`,
    );
  });

  it('uses a proxy location passed by the caller over the request and session values', () => {
    const ctx = installed({
      rc: { frontEndProxyLoc: 'http://rc.example' },
      session: { frontEndProxyLoc: 'http://s.example' },
    });
    expect(compactScripts(ctx, 'http://given.example')).toContain(
      'new Porthole.WindowProxy("http\\x3A\\x2F\\x2Fgiven.example/admin/assets/js/porthole/proxy.html");',
    );
  });

  it('keeps an empty requested source frame instead of the modal default', () => {
    const markup = compactScripts(installed({ rc: { sourceFrame: '' } }));
    expect(markup.match(/\t'targetFrame': ''\n/g)).toHaveLength(2);
    expect(markup).not.toContain("'modal'");
  });

  it('keeps an untrusted proxy location and source frame inside their script strings', () => {
    const ctx = installed({ rc: { frontEndProxyLoc: 'http://evil"</script>', sourceFrame: "x'y" } });
    const markup = compactScripts(ctx);
    expect(markup).toContain(
      'new Porthole.WindowProxy("http\\x3A\\x2F\\x2Fevil\\x22\\x3C\\x2Fscript\\x3E/admin/assets/js/porthole/proxy.html");',
    );
    expect(markup.match(/'targetFrame': 'x\\x27y'\n/g)).toHaveLength(2);
    expect(markup.match(/<\/script>/g)).toHaveLength(1);
    expect(
      markup.startsWith('<script type="text/javascript">\n\n\t\t\tvar resizeTabPane = function(offsetVal=17){\n'),
    ).toBe(true);
  });
});
