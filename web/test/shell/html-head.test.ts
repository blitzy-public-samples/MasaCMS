// Unit tests for the global admin scripts against admin/common/layouts/includes/html_head.cfm.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_VERSION, legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeJs, isSafeHtml, raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderHtmlHead } from '@/shell/html-head';
import type { ShellContext } from '@/shell/types';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteRecordFor,
  type AdminRequestPartial,
} from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';

const here = import.meta.dirname ?? __dirname;
const HEAD_CFM = path.resolve(here, '../../../admin/common/layouts/includes/html_head.cfm');

/** `script[src]` and `link[href]` of the head the legacy server renders for an admin page (context '', `/admin`). */
const LEGACY_ASSETS = [
  '/admin/assets/ico/favicon.ico',
  '/admin/assets/ico/favicon.ico',
  '/admin/assets/ico/apple-touch-icon-144-precomposed.png',
  '/admin/assets/ico/apple-touch-icon-114-precomposed.png',
  '/admin/assets/ico/apple-touch-icon-72-precomposed.png',
  '/admin/assets/ico/apple-touch-icon-57-precomposed.png',
  '/admin/assets/js/spin.min.js',
  '/admin/assets/js/jquery/jquery.min.js?coreversion=7.6.1',
  '/admin/assets/js/oneui.min.js',
  '/admin/assets/js/jquery/jquery-ui.min.js?coreversion=7.6.1',
  '/admin/assets/js/jquery/jquery-ui-i18n.min.js?coreversion=7.6.1',
  '/admin/assets/js/jquery/jquery.collapsibleCheckboxTree.js?coreversion=7.6.1',
  '/admin/assets/js/jquery/jquery.spin.js',
  '/admin/assets/js/mura.js?coreversion=7.6.1',
  '/admin/assets/js/admin.min.js?coreversion=7.6.1',
  '/core/vendor/ckeditor/ckeditor.js',
  '/core/vendor/ckeditor/adapters/jquery.js',
  '/admin/assets/js/filebrowser/filebrowser.js',
  '/admin/assets/js/filebrowser/assets/css/filebrowser.css',
  '/admin/assets/js/json2.js',
  '/core/vendor/colorpicker/js/bootstrap-colorpicker.js?coreversion=7.6.1',
  '/core/vendor/colorpicker/css/bootstrap-colorpicker.min.css?coreversion=7.6.1',
  '/admin/assets/js/jquery.nice-select.min.js',
];

const MALFORMED_STYLESHEET =
  '<link href="/admin/assets/js/filebrowser/assets/css/filebrowser.css" link rel="stylesheet" type="text/css"></script>';

/** The installed admin on `default`, whose site uses the installed `default` theme. */
const installedAdmin = (partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, site: { record: { theme: 'default' } } });

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** A shell context around `ctx`; the head reads nothing else. */
function shellContext(ctx: AdminRequest): ShellContext {
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
    layout: 'template',
    originalCircuit: ctx.circuit,
    originalFuseaction: ctx.item,
    moduleTitle: '',
    bodyclass: '',
    siteId: ctx.session.siteid,
  };
}

/** The port's head markup for `ctx`. */
function portHead(ctx: AdminRequest): string {
  const markup = renderHtmlHead(shellContext(ctx));
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The `<cfoutput>` body of `html_head.cfm` with its expressions evaluated for `ctx` and `themepath`. */
function legacyHead(ctx: AdminRequest, themepath: string): string {
  const { context, adminDir, htmlEditorType, sessionTimeout, webroot, fileDelim } = legacySettings();
  const source = readFileSync(HEAD_CFM, 'utf8').replaceAll('\r\n', '\n');
  const body = source.slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'));
  const evaluated = body
    .replace(/<cfif \$\.currentUser\(\)\.isLoggedIn\(\)>(.*?)<\/cfif>/s, (_, inner: string) =>
      ctx.isLoggedIn ? inner : '',
    )
    .replaceAll('#application.configBean.getContext()#', () => context)
    .replaceAll('#application.configBean.getAdminDir()#', () => adminDir)
    .replaceAll('#application.coreversion#', () => CORE_VERSION)
    .replaceAll('#application.configBean.getValue("htmlEditorType")#', () => htmlEditorType)
    .replaceAll('#application.settingsManager.getSite(rc.siteID).getThemeAssetPath()#', () => themepath)
    .replaceAll("#lcase(esapiEncode('javascript',session.rb))#", () => encodeJs(ctx.session.rb).toLowerCase())
    .replaceAll("#esapiEncode('javascript',session.siteid)#", () => encodeJs(ctx.session.siteid))
    .replaceAll("#val(application.configBean.getValue('sessionTimeout') * 60)#", () => String(sessionTimeout * 60))
    .replaceAll("#esapiEncode('javascript',rc.activepanel)#", () => encodeJs(ctx.rc.activepanel ?? '0'))
    .replaceAll("#esapiEncode('javascript',rc.activetab)#", () => encodeJs(ctx.rc.activetab ?? '0'))
    .replaceAll(
      `#esapiEncode('javascript',left($.globalConfig("webroot"),len($.globalConfig("webroot"))-len($.globalConfig("context"))))#`,
      () => encodeJs(webroot.slice(0, webroot.length - context.length)),
    )
    .replaceAll(`#esapiEncode('javascript',$.globalConfig("fileDelim"))#`, () => encodeJs(fileDelim));
  expect(evaluated).not.toMatch(/#[\w$]+[.(]/);
  return evaluated;
}

/** Ordered `script[src]` and `link[href]` values of `markup`. */
function assetList(markup: string): string[] {
  const $ = cheerio.load(markup);
  return $('script[src], link[href]')
    .toArray()
    .map((element) => $(element).attr('src') ?? $(element).attr('href') ?? '');
}

/** The lines of the inline globals script, tabs dropped. */
function globals(markup: string): string[] {
  const script = /<script type="text\/javascript">\n(.*?)<\/script>/s.exec(markup)?.[1] ?? '';
  return script.split('\n').map((line) => line.replace(/^\t/, ''));
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  useSettings();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderHtmlHead', () => {
  it.each<[string, () => AdminRequest, Record<string, string>]>([
    ['an anonymous request', () => anonymousRequest(), {}],
    ['a logged-in admin', () => installedAdmin(), { MURA_WEBROOT: '/srv/masa' }],
    [
      'an admin under a context and admin directory',
      () => installedAdmin({ rc: { activepanel: '3', activetab: '2' } }),
      { MURA_CONTEXT: '/cms', MURA_ADMINDIR: 'manage', MURA_WEBROOT: '/srv/masa/cms', MURA_HTMLEDITORTYPE: 'ckeditor' },
    ],
  ])('matches the legacy include for %s', (_, request, settings) => {
    useSettings(settings);
    const ctx = request();
    expect(portHead(ctx)).toBe(legacyHead(ctx, `${legacySettings().context}/themes/default`));
  });

  it('emits the legacy-rendered assets in order', () => {
    expect(assetList(portHead(adminS2Request()))).toEqual(LEGACY_ASSETS);
  });

  it('reproduces the malformed filebrowser stylesheet tag verbatim', () => {
    expect(portHead(anonymousRequest())).toContain(`\t${MALFORMED_STYLESHEET}\n`);
  });

  it('prints the legacy globals for the installed admin', () => {
    useSettings({ MURA_WEBROOT: '/srv/masa' });
    expect(globals(portHead(installedAdmin()))).toEqual([
      "var htmlEditorType='';",
      "var context='';",
      "var themepath='/themes/default';",
      "var rb='en_us';",
      "var siteid='default';",
      'var sessionTimeout=10800;',
      'var activepanel=0;',
      'var activetab=0;',
      "var webroot='\\x2Fsrv\\x2Fmasa';",
      "var fileDelim='\\x2F';",
      '',
    ]);
  });

  it('declares webroot only for a logged-in user', () => {
    useSettings({ MURA_WEBROOT: '/srv/masa' });
    expect(portHead(editorRequest())).toContain("\tvar webroot='\\x2Fsrv\\x2Fmasa';\n");
    const anonymous = portHead(anonymousRequest());
    expect(anonymous).not.toContain('webroot');
    expect(anonymous).toContain("var activetab=0;\n\t\n\tvar fileDelim='\\x2F';\n");
  });

  it('declares an empty webroot when the context is longer than it', () => {
    useSettings({ MURA_CONTEXT: '/cms' });
    expect(globals(portHead(adminS2Request()))).toContain("var webroot='';");
  });

  it('lower-cases rb after encoding it', () => {
    const markup = portHead(adminS2Request({ session: { rb: 'pt-BR' } }));
    expect(markup).toContain("var rb='pt\\x2dbr';");
    expect(portHead(adminS2Request({ session: { rb: 'en_US' } }))).toContain("var rb='en_us';");
  });

  it('encodes siteid, activepanel and activetab, leaving the panel values unquoted', () => {
    const ctx = adminS2Request({ session: { siteid: "tenant'a" }, rc: { activepanel: '1;x', activetab: '<2>' } });
    const lines = globals(portHead(ctx));
    expect(lines).toContain("var siteid='tenant\\x27a';");
    expect(lines).toContain('var activepanel=1\\x3Bx;');
    expect(lines).toContain('var activetab=\\x3C2\\x3E;');
  });

  it('defaults activepanel and activetab to 0 when the context lacks them', () => {
    const ctx: AdminRequest = { ...adminS2Request(), rc: { siteid: 'default' } };
    const lines = globals(portHead(ctx));
    expect(lines).toContain('var activepanel=0;');
    expect(lines).toContain('var activetab=0;');
  });

  it.each([
    ['30', 'var sessionTimeout=1800;'],
    ['1.5', 'var sessionTimeout=90;'],
    ['0.25', 'var sessionTimeout=15;'],
  ])('prints sessionTimeout %s minutes as seconds', (minutes, line) => {
    useSettings({ MURA_SESSIONTIMEOUT: minutes });
    expect(globals(portHead(anonymousRequest()))).toContain(line);
  });

  it('prints htmlEditorType, context and the theme path unencoded', () => {
    useSettings({ MURA_HTMLEDITORTYPE: "ck'editor", MURA_CONTEXT: '/c&m' });
    const lines = globals(portHead(adminS2Request({ site: { record: { theme: 'my theme' } } })));
    expect(lines).toContain("var htmlEditorType='ck'editor';");
    expect(lines).toContain("var context='/c&m';");
    expect(lines).toContain("var themepath='/c&m/themes/my theme';");
  });

  it.each<[string, Partial<ReturnType<typeof siteRecordFor>>, boolean, string]>([
    ['a local site', { theme: 'MyTheme' }, false, '/themes/MyTheme'],
    ['a site without a theme', { theme: null }, false, '/themes/'],
    [
      'a remote site without a resource domain',
      { isremote: 1, remotecontext: '/remote', theme: 'x' },
      false,
      '/remote/themes/x',
    ],
    ['a remote site without a remote context', { isremote: 1, theme: 'x' }, false, '/themes/x'],
    [
      'a remote site with an SSL resource domain',
      { isremote: 1, resourceDomain: 'cdn.example.com', resourceSSL: 1, theme: 'x' },
      false,
      'https://cdn.example.com:8443/cms/themes/x',
    ],
    [
      'a remote SSL site with a resource domain',
      { isremote: 1, resourceDomain: 'cdn.example.com', useSSL: 1, theme: 'x' },
      false,
      'https://cdn.example.com:8443/cms/themes/x',
    ],
    [
      'a remote site with a resource domain over HTTP',
      { isremote: 1, resourceDomain: 'cdn.example.com', theme: 'x' },
      false,
      'http://cdn.example.com:8443/cms/themes/x',
    ],
    [
      'a remote site with a resource domain over HTTPS',
      { isremote: 1, resourceDomain: 'cdn.example.com', theme: 'x' },
      true,
      'https://cdn.example.com:8443/cms/themes/x',
    ],
  ])('resolves the theme path of %s', (_, record, https, themepath) => {
    useSettings(record.resourceDomain === undefined ? {} : { MURA_CONTEXT: '/cms', MURA_PORT: '8443' });
    const ctx = adminS2Request({ site: { record }, https });
    expect(globals(portHead(ctx))).toContain(`var themepath='${themepath}';`);
  });

  it('assumes the installed theme when the site data is withheld', () => {
    useSettings({ MURA_CONTEXT: '/cms' });
    const ctx = editorRequest();
    expect(ctx.site).toBeUndefined();
    expect(globals(portHead(ctx))).toContain("var themepath='/cms/themes/default';");
  });
});
