// Inline layout scripts and html_head globals for hostile request values (template.cfm, compact.cfm, html_head.cfm).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeJs, isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { resolveFrontEndProxyLoc } from '@/shell/compact';
import { renderHtmlHead } from '@/shell/html-head';
import { renderCompactScripts, renderMuraInit, renderTemplateScripts } from '@/shell/inline-scripts';
import type { ShellContext, ShellLayout } from '@/shell/types';
import { SITE_IDS, siteTenantA } from '../fixtures/programs-sites/sites';
import {
  adminS2Request,
  anonymousRequest,
  siteAdminRequest,
  unservedEditorRequest,
  type AdminRequestPartial,
} from '../helpers/admin-request';

const HOSTILE = {
  siteid: `a'b</script>"c`,
  rb: 'EN_US',
  activepanel: '1;alert(1)',
  activetab: `tab'2`,
  sourceFrame: "x'y",
  frontEndProxyLoc: 'https://tenant-a.example',
} as const;

const ENCODED_SITE = encodeJs(HOSTILE.siteid);

const INIT_KEYS = [
  'inAdmin',
  'context',
  'themepath',
  'siteid',
  'assetpath',
  'sitespath',
  'corepath',
  'fileassetpath',
  'adminpath',
  'themepath',
  'pluginspath',
  'rootpath',
  'indexfileinapi',
];

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** The S2 admin with every hostile value in its session and `rc`; its session site is not served. */
function hostileRequest(partial: AdminRequestPartial = {}): AdminRequest {
  return adminS2Request({
    ...partial,
    session: { siteid: HOSTILE.siteid, rb: HOSTILE.rb, frontEndProxyLoc: HOSTILE.frontEndProxyLoc, ...partial.session },
    rc: {
      activepanel: HOSTILE.activepanel,
      activetab: HOSTILE.activetab,
      sourceFrame: HOSTILE.sourceFrame,
      ...partial.rc,
    },
  });
}

/** The tenant-a site admin on its own domain, served the `siteTenantA` row with `theme`. */
function tenantARequest(theme: string | null = null): AdminRequest {
  return siteAdminRequest(SITE_IDS.tenantA, {
    httpHost: siteTenantA.Domain,
    serverName: siteTenantA.Domain,
    site: {
      domain: siteTenantA.Domain,
      displayPoolID: siteTenantA.displayPoolID,
      filePoolID: siteTenantA.filePoolID,
      record: {
        Domain: siteTenantA.Domain,
        domainAlias: siteTenantA.domainAlias,
        displayPoolID: siteTenantA.displayPoolID,
        filePoolID: siteTenantA.filePoolID,
        theme,
      },
    },
  });
}

/** A shell context around `ctx` in `layout`; the scripts and head read nothing else. */
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

function markupOf(rendered: SafeHtml): string {
  expect(isSafeHtml(rendered)).toBe(true);
  return toString(rendered);
}

const templateScripts = (ctx: AdminRequest): string => markupOf(renderTemplateScripts(shellContext(ctx)));

const compactScripts = (ctx: AdminRequest, frontEndProxyLoc?: string): string => {
  const sc = shellContext(ctx, 'compact');
  return markupOf(
    frontEndProxyLoc === undefined ? renderCompactScripts(sc) : renderCompactScripts(sc, frontEndProxyLoc),
  );
};

const headMarkup = (ctx: AdminRequest): string => markupOf(renderHtmlHead(shellContext(ctx)));

/** `key` and value text of each `Mura.init` member, in order. */
function initMembers(script: string): Array<[string, string]> {
  const start = script.indexOf('Mura.init({');
  const body = script.slice(start + 'Mura.init({'.length, script.indexOf('});', start));
  return Array.from(body.matchAll(/^\t*(\w+):\s?(.*?),?$/gm), (m): [string, string] => [m[1] ?? '', m[2] ?? '']);
}

const quoted = (value: string): string => `'${encodeJs(value)}'`;

/** The members legacy prints for site `siteId` served under `root` with display and file pool `pool`, no theme. */
function expectedMembers(siteId: string, root: string, pool: string): Array<[string, string]> {
  const themepath = quoted(`${root}/themes/`);
  return [
    ['inAdmin', 'true'],
    ['context', "''"],
    ['themepath', themepath],
    ['siteid', quoted(siteId)],
    ['assetpath', quoted(`${root}/sites/${pool}`)],
    ['sitespath', "''"],
    ['corepath', quoted(`${root}/core`)],
    ['fileassetpath', quoted(`${root}/sites/${pool}`)],
    ['adminpath', quoted(`${root}/admin`)],
    ['themepath', themepath],
    ['pluginspath', quoted(`${root}/plugins`)],
    ['rootpath', quoted(root)],
    ['indexfileinapi', 'true'],
  ];
}

/** Lines of the head's inline globals script, indentation dropped. */
function globals(markup: string): string[] {
  const script = /<script type="text\/javascript">\n([\s\S]*?)<\/script>/.exec(markup)?.[1] ?? '';
  return script.split('\n').map((line) => line.trim());
}

beforeEach(() => {
  useSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('encodeJs', () => {
  it.each([
    ['tenant-a', 'tenant\\x2Da'],
    ["a'b", 'a\\x27b'],
    [HOSTILE.siteid, 'a\\x27b\\x3C\\x2Fscript\\x3E\\x22c'],
    [HOSTILE.activepanel, '1\\x3Balert\\x281\\x29'],
    ['EN_US', 'EN_US'],
    ['a,b.c', 'a,b.c'],
  ])('encodes %j as the ESAPI JavaScript codec does', (value, encoded) => {
    expect(encodeJs(value)).toBe(encoded);
  });
});

describe('renderTemplateScripts', () => {
  it('dismisses alerts for the encoded session site', () => {
    const markup = templateScripts(hostileRequest());
    expect(markup.replace(/\s+/g, '')).toContain(
      `url:'./',data:{siteid:'${ENCODED_SITE}',alertid:$(_alert).attr('data-alertid'),muraaction:'cdashboard.dismissAlert'}`,
    );
    expect(markup).not.toContain(HOSTILE.siteid);
    expect(markup.match(/<\/script>/g)).toHaveLength(1);
  });

  it.each([
    "createCookie('ADMINCONTROLWIDTH',acw,5)",
    "createCookie('ADMINSIDEBAR',asb,5)",
    "$('#mura-header-search-reveal')",
    "jQuery('#site-list-filter')",
    '.tabdrop(',
    '.niceSelect()',
  ])('keeps the legacy %s call', (fragment) => {
    const markup = templateScripts(hostileRequest());
    expect(markup).toContain(fragment);
    expect(markup).not.toContain('##');
  });

  it('ends with the Mura.init block', () => {
    const ctx = hostileRequest();
    const markup = templateScripts(ctx);
    const tail = markup.slice(markup.indexOf('Mura.init({'));
    expect(tail.replace(/\s*<\/script>$/, '')).toBe(renderMuraInit(shellContext(ctx)));
  });
});

describe('renderMuraInit', () => {
  it('keeps the legacy key order, duplicate themepath included', () => {
    expect(initMembers(renderMuraInit(shellContext(tenantARequest()))).map(([key]) => key)).toEqual(INIT_KEYS);
  });

  it.each<[string, () => AdminRequest, Array<[string, string]>]>([
    [
      'the served tenant-a site',
      () => tenantARequest(),
      expectedMembers(SITE_IDS.tenantA, `http://${siteTenantA.Domain}`, siteTenantA.displayPoolID),
    ],
    [
      'an empty, unserved session site',
      () => {
        const ctx = unservedEditorRequest();
        return { ...ctx, session: { ...ctx.session, siteid: '' } };
      },
      expectedMembers(SITE_IDS.default, 'http://localhost', SITE_IDS.default),
    ],
  ])('prints encoded single-quoted values for %s', (_, request, expected) => {
    expect(initMembers(renderMuraInit(shellContext(request())))).toEqual(expected);
  });

  it('pins the encoded tenant-a site id and the hostile unserved site id', () => {
    expect(renderMuraInit(shellContext(tenantARequest()))).toContain("\tsiteid:'tenant\\x2Da',\n");
    expect(renderMuraInit(shellContext(hostileRequest()))).toContain(
      "\tsiteid:'a\\x27b\\x3C\\x2Fscript\\x3E\\x22c',\n",
    );
  });

  it.each<[Record<string, string>, string]>([
    [{}, 'true'],
    [{ MURA_INDEXFILEINAPI: 'false' }, 'false'],
  ])('prints the settings %j as an unquoted indexfileinapi %s', (settings, flag) => {
    useSettings(settings);
    const init = renderMuraInit(shellContext(tenantARequest()));
    expect(init).toContain(`\tindexfileinapi: ${flag}\n`);
    expect(init).toContain("\tcontext:'',\n");
  });
});

describe('renderCompactScripts', () => {
  it.each<[string, string | undefined, string]>([
    ['the stored location when the request names none', undefined, HOSTILE.frontEndProxyLoc],
    ['the stored location when the request value is empty', '', HOSTILE.frontEndProxyLoc],
    ['a non-empty requested location', 'https://rc.example:8443', 'https://rc.example:8443'],
  ])('posts to the porthole proxy of %s', (_, requested, location) => {
    const ctx = hostileRequest({ rc: { frontEndProxyLoc: requested } });
    expect(resolveFrontEndProxyLoc(ctx)).toBe(location);
    const markup = compactScripts(ctx, resolveFrontEndProxyLoc(ctx));
    expect(markup).toContain(
      `new Porthole.WindowProxy("${encodeJs(location)}/admin/assets/js/porthole/proxy.html");`,
    );
    expect(compactScripts(ctx)).toBe(markup);
  });

  it('encodes the proxy location but not the context and admin directory suffix', () => {
    useSettings({ MURA_CONTEXT: '/c-ms', MURA_ADMINDIR: 'ad-min' });
    expect(compactScripts(hostileRequest())).toContain(
      'new Porthole.WindowProxy("https\\x3A\\x2F\\x2Ftenant\\x2Da.example/c-ms/ad-min/assets/js/porthole/proxy.html");',
    );
  });

  it.each<[string | undefined, string]>([
    [HOSTILE.sourceFrame, 'x\\x27y'],
    [undefined, 'modal'],
  ])('targets source frame %j in both proxy posts', (sourceFrame, encoded) => {
    const markup = compactScripts(hostileRequest({ rc: { sourceFrame } }));
    expect(encodeJs(sourceFrame ?? 'modal')).toBe(encoded);
    expect(markup.match(/'targetFrame'/g)).toHaveLength(2);
    expect(markup.split(`'targetFrame': '${encoded}'`)).toHaveLength(3);
  });

  it('keeps the compact handlers and the template Mura.init, without alert dismissal', () => {
    const ctx = hostileRequest();
    const markup = compactScripts(ctx);
    expect(markup).toContain('Mura(function(){');
    expect(markup).toContain('.niceSelect();');
    expect(markup).toContain('frontEndProxy.addEventListener(siteManager.frontEndProxyListener);');
    expect(markup).toContain(renderMuraInit(shellContext(ctx, 'compact')));
    expect(initMembers(markup)).toEqual(initMembers(templateScripts(ctx)));
    expect(markup).not.toContain('cdashboard.dismissAlert');
    expect(markup).not.toContain('.alert-dismiss');
  });
});

describe('renderHtmlHead globals', () => {
  it('encodes the session and panel values, leaving the panels unquoted', () => {
    const markup = headMarkup(hostileRequest());
    const lines = globals(markup);
    expect(lines).toContain("var rb='en_us';");
    expect(lines).toContain(`var rb='${encodeJs(HOSTILE.rb).toLowerCase()}';`);
    expect(lines).toContain(`var siteid='${ENCODED_SITE}';`);
    expect(lines).toContain(`var activepanel=${encodeJs(HOSTILE.activepanel)};`);
    expect(lines).toContain(`var activetab=${encodeJs(HOSTILE.activetab)};`);
    expect(lines).toContain(`var fileDelim='${encodeJs(legacySettings().fileDelim)}';`);
    expect(markup).not.toContain(HOSTILE.siteid);
  });

  it.each<[string, () => AdminRequest, string]>([
    ['the withheld session site', () => hostileRequest(), '/c-ms/themes/default'],
    ['the served tenant-a site', () => tenantARequest('tenant-a'), '/c-ms/themes/tenant-a'],
  ])('prints htmlEditorType, context and the theme path of %s unencoded', (_, request, themepath) => {
    useSettings({ MURA_HTMLEDITORTYPE: 'ck-editor', MURA_CONTEXT: '/c-ms' });
    const lines = globals(headMarkup(request()));
    expect(lines).toContain("var htmlEditorType='ck-editor';");
    expect(lines).toContain("var context='/c-ms';");
    expect(lines).toContain(`var themepath='${themepath}';`);
  });

  it.each<[Record<string, string>, string]>([
    [{}, 'var sessionTimeout=10800;'],
    [{ MURA_SESSIONTIMEOUT: '45' }, 'var sessionTimeout=2700;'],
  ])('prints the sessionTimeout of %j in seconds', (settings, line) => {
    useSettings(settings);
    expect(globals(headMarkup(hostileRequest()))).toContain(line);
  });

  it('declares webroot without the context only for a logged-in user', () => {
    useSettings({ MURA_WEBROOT: '/srv/masa/c-ms', MURA_CONTEXT: '/c-ms' });
    expect(globals(headMarkup(hostileRequest()))).toContain(`var webroot='${encodeJs('/srv/masa')}';`);
    expect(headMarkup(anonymousRequest())).not.toContain('var webroot=');
  });
});
