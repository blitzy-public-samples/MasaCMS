// Unit tests for the admin shell entry point: default.cfm's layout choice, shell data loading and document output.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCsrfFields } from '@opt2/platform/legacy-compat';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { encodeHtmlAttr, isSafeHtml, raw, toString } from '@/lib/html';
import { mergeFw1Context, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  OPT2_NAV_MODULES,
  attributeBootstrapScript,
  loadShellData,
  renderAdminDocument,
  selectLayout,
  serializeAdminDocument,
  type AdminDocument,
  type ShellData,
  type ShellHooks,
  type ShellView,
} from '@/shell/document';
import { OPT2_NAV_MODULES as NAV_MODULES } from '@/shell/nav';
import { CSRF_UPDATECORE } from '../fixtures/identity/csrf';
import { adminS2Request, anonymousRequest, editorRequest, noSitesRequest } from '../helpers/admin-request';
import { domModel } from '../helpers/dom-model';
import { fakeGatewayClient, routeKey, type FakeCall, type FakeGatewayClient } from '../helpers/fake-gateway';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/shell');
const Z = '00000000000000000000000000000000';
const NOW = new Date(2026, 5, 30, 12);
const RB = rbFor('en_US');
const HOOKS: ShellHooks = { secondaryMenus: {} };
const VIEW_MARK = '<!--VIEW-->';

const LIST_SITES = routeKey('GET', 'programs-sites', '/v1/sites');
const ISSUE_TOKENS = routeKey('POST', 'identity', '/v1/csrf/tokens');
const LIST_SITES_CALL: FakeCall = {
  service: 'programs-sites',
  method: 'GET',
  path: '/v1/sites',
  query: { sortBy: 'site', sortDirection: 'asc' },
};
const UPDATE_CORE_CALL: FakeCall = {
  service: 'identity',
  method: 'POST',
  path: '/v1/csrf/tokens',
  json: { contexts: ['updatecore'] },
};
const UPDATE_CORE_QUERY = renderCsrfFields(
  { token: CSRF_UPDATECORE.csrf_token, expires: CSRF_UPDATECORE.csrf_token_expires },
  'url',
);

/** Regions other renderers own, replaced by markers in the oracle fixtures: [marker, region start, region end]. */
type Regions = ReadonlyArray<readonly [marker: string, start: string, end: string]>;

const TEMPLATE_REGIONS: Regions = [
  ['<!--HTML-HEAD-->', '<!-- Favicons -->', 'jquery.nice-select.min.js" type="text/javascript"></script>'],
  ['<!--NAV-->', '<nav id="sidebar">', '</nav>'],
  ['<!--HEADER-->', '<header id="header-navbar"', '</header>'],
  ['<!--TEMPLATE-SCRIPTS-->', "<script>\n\t\t\t$(document).on('click'", '</script>'],
];

const COMPACT_REGIONS: Regions = [
  ['<!--HTML-HEAD-->', '<!-- Favicons -->', 'jquery.nice-select.min.js" type="text/javascript"></script>'],
  ['<!--COMPACT-SCRIPTS-->', '<script type="text/javascript">\n\n\t\t\tvar resizeTabPane', '</script>'],
];

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** Markup with whitespace between tags dropped and other whitespace runs collapsed. */
const squash = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/** `markup` with each region present replaced by its marker. */
const skeleton = (markup: string, regions: Regions): string =>
  regions.reduce((page, [marker, start, end]) => {
    const from = page.indexOf(start);
    if (from < 0) return page;
    const to = page.indexOf(end, from);
    expect(to).toBeGreaterThan(from);
    return page.slice(0, from) + marker + page.slice(to + end.length);
  }, markup);

/** One row of programs-sites' site list. */
const listed = (siteid: string, site: string | null, extra: Record<string, unknown> = {}) => ({
  siteid,
  site,
  domain: 'localhost',
  orderno: 1,
  deploy: 0,
  lastDeployment: null,
  ...extra,
});

const DEFAULT_SITES = [listed('default', 'Default')];

/** An in-memory gateway answering the site list with `sites` and identity's Update Core token pair. */
function shellGateway(sites: readonly unknown[] = DEFAULT_SITES): FakeGatewayClient {
  return fakeGatewayClient({
    [LIST_SITES]: { status: 200, body: sites },
    [ISSUE_TOKENS]: { status: 200, body: { tokens: [CSRF_UPDATECORE] } },
  });
}

/** The shell data of `ctx` over `gateway`, at {@link NOW}. */
const load = (ctx: AdminRequest, gateway: FakeGatewayClient = shellGateway()): Promise<ShellData> =>
  loadShellData(ctx, { gateway, csrf: createCsrfRenderer(gateway), rb: RB, now: NOW });

/** The document of `ctx` around `view`, its shell data loaded first. */
async function documentFor(ctx: AdminRequest, view: Partial<ShellView> = {}): Promise<AdminDocument> {
  const doc = renderAdminDocument(ctx, { body: raw(VIEW_MARK), ...view }, HOOKS, await load(ctx));
  for (const part of [doc.preamble, doc.head, doc.body]) expect(isSafeHtml(part)).toBe(true);
  return doc;
}

const $of = (doc: AdminDocument) => cheerio.load(serializeAdminDocument(doc));

/** `ctx` with the session site emptied, as before the set-up switched to one. */
const withoutSessionSite = (ctx: AdminRequest): AdminRequest => ({ ...ctx, session: { ...ctx.session, siteid: '' } });

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  vi.stubEnv('MURA_PORT', '8080');
  vi.stubEnv('MURA_SITEIDINURLS', 'false');
  vi.stubEnv('MURA_INDEXFILEINURLS', 'false');
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('selectLayout', () => {
  it.each([
    { compactDisplay: 'true', layout: 'compact' },
    { compactDisplay: 'TRUE', layout: 'compact' },
    { compactDisplay: 'True', layout: 'compact' },
    { compactDisplay: 'false', layout: 'template' },
    { compactDisplay: '', layout: 'template' },
    { compactDisplay: undefined, layout: 'template' },
  ])('chooses $layout for compactDisplay "$compactDisplay"', ({ compactDisplay, layout }) => {
    const url: Record<string, string> = compactDisplay === undefined ? {} : { compactDisplay };
    expect(selectLayout(mergeFw1Context([], url, {}))).toBe(layout);
  });

  it('re-exports the OPT-2 nav modules of the nav', () => {
    expect(OPT2_NAV_MODULES).toBe(NAV_MODULES);
  });
});

describe('loadShellData', () => {
  it.each([
    { name: 'an anonymous request', ctx: () => anonymousRequest({ circuit: 'cLogin', item: 'main' }) },
    { name: 'a compact request', ctx: () => adminS2Request({ circuit: 'cArch', item: 'edit', rc: { compactDisplay: 'true' } }) },
    { name: 'a session without a site', ctx: () => withoutSessionSite(adminS2Request({ circuit: 'cUsers', item: 'list' })) },
    { name: 'a public member', ctx: () => noSitesRequest({ s2IsPrivate: false }, { circuit: 'cEditProfile', item: 'edit' }) },
  ])('loads no site list or tokens for $name', async ({ ctx }) => {
    const gateway = shellGateway();
    const data = await load(ctx(), gateway);
    expect(gateway.calls).toEqual([]);
    expect(data.userSites).toEqual([]);
    expect(data.updateCoreCsrfQuery).toBe('');
  });

  it('lists every site by name for S2 users and renders the Update Core tokens', async () => {
    const gateway = shellGateway([
      listed('default', 'Default'),
      listed('tenant-a', 'Tenant A', { showDashboard: 1 }),
      listed('tenant-b', null, { showDashboard: 0 }),
    ]);
    const ctx = adminS2Request({ circuit: 'cUsers', item: 'list', site: { record: { showDashboard: 1 } } });
    const data = await load(ctx, gateway);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls).toEqual(expect.arrayContaining([LIST_SITES_CALL, UPDATE_CORE_CALL]));
    expect(data.userSites).toEqual([
      { siteId: 'default', site: 'Default', showDashboard: true },
      { siteId: 'tenant-a', site: 'Tenant A', showDashboard: true },
      { siteId: 'tenant-b', site: '', showDashboard: false },
    ]);
    expect(data.updateCoreCsrfQuery).toBe(UPDATE_CORE_QUERY);
  });

  it.each(['false', 'no', '0'])('renders no Update Core tokens when allowAutoUpdates is "%s"', async (value) => {
    vi.stubEnv('MURA_ALLOWAUTOUPDATES', value);
    resetLegacySettingsForTests();
    const gateway = shellGateway();
    const data = await load(adminS2Request({ circuit: 'cUsers', item: 'list' }), gateway);
    expect(gateway.calls).toEqual([LIST_SITES_CALL]);
    expect(data.updateCoreCsrfQuery).toBe('');
  });

  it('orders the administered sites of other private users by name, without the S2-only site list', async () => {
    const ctx = editorRequest({
      circuit: 'cArch',
      item: 'list',
      adminSites: [
        { siteID: 'zeta', site: 'Zeta' },
        { siteID: 'b', site: 'beta' },
        { siteID: 'default', site: 'Default' },
        { siteID: 'a', site: 'Alpha' },
      ],
      site: { record: { showDashboard: 1 } },
    });
    const gateway = shellGateway();
    const data = await load(ctx, gateway);
    expect(gateway.calls).toEqual([]);
    expect(data.userSites).toEqual([
      { siteId: 'a', site: 'Alpha', showDashboard: false },
      { siteId: 'b', site: 'beta', showDashboard: false },
      { siteId: 'default', site: 'Default', showDashboard: true },
      { siteId: 'zeta', site: 'Zeta', showDashboard: false },
    ]);
    expect(data.updateCoreCsrfQuery).toBe('');
  });

  it('lists no site for a private user administering none', async () => {
    const gateway = shellGateway();
    const data = await load(noSitesRequest({ s2IsPrivate: true }, { circuit: 'cArch', item: 'list' }), gateway);
    expect(gateway.calls).toEqual([]);
    expect(data.userSites).toEqual([]);
  });

  it('rejects when programs-sites refuses the site list', async () => {
    const gateway = fakeGatewayClient({
      [LIST_SITES]: { status: 403, body: {} },
      [ISSUE_TOKENS]: { status: 200, body: { tokens: [CSRF_UPDATECORE] } },
    });
    await expect(load(adminS2Request({ circuit: 'cUsers', item: 'list' }), gateway)).rejects.toBeInstanceOf(
      GatewayDenialError,
    );
  });

  it('lets gateway unavailability propagate', async () => {
    const gateway = shellGateway();
    gateway.failWith();
    await expect(load(adminS2Request({ circuit: 'cUsers', item: 'list' }), gateway)).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });

  it('passes the labels and clock through and holds no prompts, plugins, server facts or export directory', async () => {
    const data = await load(adminS2Request({ circuit: 'cUsers', item: 'list' }));
    expect(data.rb).toBe(RB);
    expect(data.now).toBe(NOW);
    expect(data.prompts).toEqual({ drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 });
    expect(data.sitePlugins).toEqual([]);
    expect(data.server).toBeNull();
    expect(data.exportLocationExists).toBe(false);
  });

  it('defaults the clock to the current time', async () => {
    const gateway = shellGateway();
    const before = Date.now();
    const data = await loadShellData(anonymousRequest(), { gateway, csrf: createCsrfRenderer(gateway), rb: RB });
    expect(data.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reads the user names from the session struct and leaves them empty when anonymous', async () => {
    const admin = await load(adminS2Request({ session: { mura: { fname: 'Ada', lname: 'Admin' } } }));
    expect(admin.user).toEqual({ fname: 'Ada', lname: 'Admin', passwordExpired: false, hasDefaultPassword: false });
    const anonymous = await load(anonymousRequest());
    expect(anonymous.user).toEqual({ fname: '', lname: '', passwordExpired: false, hasDefaultPassword: false });
  });

  it.each([
    { name: 'passwords never expire', expire: undefined, created: '2020-01-01T00:00:00.000', expired: false },
    { name: 'the password is younger than the limit', expire: '30', created: '2026-06-15T12:00:00.000', expired: false },
    { name: 'the password is older than the limit', expire: '30', created: '2026-05-01T12:00:00.000', expired: true },
    { name: 'the creation date is not a date', expire: '30', created: '', expired: true },
    { name: 'the struct cached an expiry', expire: '30', created: '2026-06-15T12:00:00.000', cached: 'yes', expired: true },
    { name: 'the struct cached no expiry', expire: '30', created: '2026-05-01T12:00:00.000', cached: false, expired: false },
  ])('derives passwordExpired when $name', async ({ expire, created, cached, expired }) => {
    if (expire !== undefined) vi.stubEnv('MURA_EXPIREPASSWORDS', expire);
    resetLegacySettingsForTests();
    const mura = cached === undefined ? { passwordCreated: created } : { passwordCreated: created, PASSWORDEXPIRED: cached };
    const data = await load(adminS2Request({ circuit: 'cUsers', item: 'list', session: { mura } }));
    expect(data.user.passwordExpired).toBe(expired);
  });

  it('never reports an expired password for an anonymous session', async () => {
    vi.stubEnv('MURA_EXPIREPASSWORDS', '30');
    resetLegacySettingsForTests();
    expect((await load(anonymousRequest())).user.passwordExpired).toBe(false);
  });
});

describe('renderAdminDocument against the oracle', () => {
  it.each([
    {
      name: 'the anonymous login page',
      ctx: () => anonymousRequest({ circuit: 'cLogin', item: 'main' }),
      view: {},
      file: 'template-login.html',
      regions: TEMPLATE_REGIONS,
      layout: 'template',
    },
    {
      name: 'the S2 users list',
      ctx: () => adminS2Request({ circuit: 'cUsers', item: 'list' }),
      view: {},
      file: 'template-admin-cusers-list.html',
      regions: TEMPLATE_REGIONS,
      layout: 'template',
    },
    {
      name: 'the compact content edit',
      ctx: () => adminS2Request({ circuit: 'cArch', item: 'edit', rc: { compactDisplay: 'true' } }),
      view: { ajax: raw('<!--AJAX-->') },
      file: 'compact-modal-carch-edit.html',
      regions: COMPACT_REGIONS,
      layout: 'compact',
    },
  ])('serializes $name as the oracle rendered it', async ({ ctx, view, file, regions, layout }) => {
    const doc = await documentFor(ctx(), view);
    expect(doc.layout).toBe(layout);
    const page = skeleton(serializeAdminDocument(doc), regions);
    expect(squash(page)).toBe(squash(fixture(file)));
    expect(domModel(page)).toEqual(domModel(fixture(file)));
  });
});

describe('renderAdminDocument', () => {
  it('dispatches to the compact layout for a case-insensitive compactDisplay', async () => {
    const doc = await documentFor(adminS2Request({ circuit: 'cUsers', item: 'list', rc: { compactDisplay: 'TRUE' } }));
    expect(doc).toMatchObject({ layout: 'compact', title: 'Masa CMS', noCache: false });
    expect(doc.bodyAttrs).toEqual({ id: 'cusers', class: 'compact modal-wrapper' });
  });

  it('derives the original circuit and fuseaction from the action unless the view overrides them', async () => {
    const ctx = adminS2Request({ circuit: 'cArch', item: 'imageDetails', rc: { moduleid: '' } });
    const derived = await documentFor(ctx);
    expect(derived.bodyAttrs.id).toBe('carch');
    expect(derived.title).toBe('Masa CMS - Image Details');
    const overridden = await documentFor(ctx, { originalCircuit: 'cArch', originalFuseaction: 'list' });
    expect(overridden.bodyAttrs.id).toBe('cArch');
    expect(overridden.title).toBe('Masa CMS - Drafts');
  });

  it('takes the module title and body class from the view, else from the switch and rc', async () => {
    const content = await documentFor(editorRequest({ circuit: 'cArch', item: 'list', rc: { moduleid: `${Z}000` } }));
    expect(content.title).toBe('Masa CMS - Site Content');
    expect(content.bodyAttrs.class).toBe('mura-admin header-navbar-fixed no-constrain sidebar-tab');
    const ctx = adminS2Request({ circuit: 'cUsers', item: 'list', rc: { bodyclass: 'from-rc' } });
    expect((await documentFor(ctx)).bodyAttrs.class).toBe('mura-admin header-navbar-fixed no-constrain from-rc');
    const viewed = await documentFor(ctx, { moduleTitle: 'Custom', bodyclass: 'from-view' });
    expect(viewed.title).toBe('Masa CMS - Custom');
    expect(viewed.bodyAttrs.class).toBe('mura-admin header-navbar-fixed no-constrain from-view');
  });

  it('feeds the loaded sites, Update Core tokens and user into the header, nav and notices', async () => {
    vi.stubEnv('MURA_EXPIREPASSWORDS', '30');
    resetLegacySettingsForTests();
    const ctx = adminS2Request({
      circuit: 'cUsers',
      item: 'list',
      session: { mura: { fname: 'Ada', lname: 'Admin', passwordCreated: '2026-05-01T12:00:00.000' } },
    });
    const doc = await documentFor(ctx);
    const $ = $of(doc);
    expect($('#site-selector-list li a').text().trim()).toBe('Default');
    expect($('#user-tools-name').text().trim()).toBe('Ada Admin');
    expect($('[data-alertid="passwordexpirednotice"]').length).toBe(1);
    expect(toString(doc.body)).toContain(`action=updateCore${UPDATE_CORE_QUERY}`);
  });

  it.each([
    { name: 'the request names one', rc: { siteid: 'tenant-b' }, action: 'cUsers.list', expected: 'tenant-b' },
    { name: 'the request names none', rc: undefined, action: 'cUsers.list', expected: 'tenant-a' },
    { name: 'the request holds an empty one', rc: { siteid: '' }, action: 'cSettings.editSite', expected: 'default' },
  ])('resolves the layout site id when $name', async ({ rc, action, expected }) => {
    const base = adminS2Request({ session: { siteid: 'tenant-a' } });
    const request = mergeFw1Context([], { muraAction: action, ...rc }, {});
    const ctx: AdminRequest = { ...base, rc: request, action: `core:${action.toLowerCase()}` };
    const $ = $of(await documentFor(ctx));
    expect($('#globalSearch input[name="siteid"]').val()).toBe(expected);
  });
});

describe('serializeAdminDocument', () => {
  const doc: AdminDocument = {
    layout: 'template',
    title: 'T',
    htmlAttrs: { lang: 'en_US', class: 'mura no-focus' },
    bodyAttrs: { id: 'carch', class: 'mura-admin x&amp;y' },
    preamble: raw('<!DOCTYPE html>\n<html lang="en_US">'),
    head: raw('\t<title>T</title>'),
    body: raw('<p>x</p>'),
    noCache: true,
  };

  it('joins preamble, head and body with the body attributes in record order, as recorded', () => {
    expect(serializeAdminDocument(doc)).toBe(
      '<!DOCTYPE html>\n<html lang="en_US">\n<head>\n\t<title>T</title>\n</head>\n' +
        '<body id="carch" class="mura-admin x&amp;y">\n<p>x</p>\n</body>\n</html>',
    );
  });

  it('emits a bare body tag without attributes', () => {
    expect(serializeAdminDocument({ ...doc, bodyAttrs: {} })).toContain('\n</head>\n<body>\n<p>x</p>\n</body>\n</html>');
  });
});

/** Attributes the stub DOM received. */
interface AppliedAttributes {
  html: Record<string, string>;
  body: Record<string, string>;
  templates: number;
}

/** Runs the bootstrap `script` against a stub DOM whose templates parse markup with cheerio. */
function runBootstrap(script: string): AppliedAttributes {
  const applied: AppliedAttributes = { html: {}, body: {}, templates: 0 };
  const code = /^<script>([\s\S]*)<\/script>$/.exec(script)?.[1];
  if (code === undefined) throw new TypeError(`Not one inline script: ${script}`);
  const element = (target: Record<string, string>) => ({
    setAttribute: (name: string, value: string) => {
      target[name] = value;
    },
  });
  const document = {
    documentElement: element(applied.html),
    body: element(applied.body),
    createElement(tag: string) {
      expect(tag).toBe('template');
      applied.templates += 1;
      const content = { firstChild: { attributes: [] as Array<{ name: string; value: string }> } };
      return {
        content,
        set innerHTML(markup: string) {
          const attrs = cheerio.load(markup, null, false)('i').attr() ?? {};
          content.firstChild.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
        },
      };
    },
  };
  (new Function('document', code) as (dom: typeof document) => void)(document);
  return applied;
}

describe('attributeBootstrapScript', () => {
  it('applies the full layout html and body attributes', async () => {
    const doc = await documentFor(adminS2Request({ circuit: 'cUsers', item: 'list' }));
    const script = attributeBootstrapScript(doc);
    expect(isSafeHtml(script)).toBe(true);
    expect(runBootstrap(toString(script))).toEqual({
      html: { lang: 'en_US', class: 'mura no-focus' },
      body: { id: 'cusers', class: 'mura-admin header-navbar-fixed no-constrain ' },
      templates: 1,
    });
  });

  it('applies the encoded compact body id as the browser decodes it', async () => {
    const ctx = adminS2Request({ circuit: 'cArch', item: 'edit', rc: { compactDisplay: 'true' } });
    const doc = await documentFor(ctx, { originalCircuit: 'a&b<c"d' });
    expect(doc.bodyAttrs.id).toBe(encodeHtmlAttr('a&b<c"d'));
    expect(runBootstrap(toString(attributeBootstrapScript(doc))).body).toEqual({
      id: 'a&b<c"d',
      class: 'compact modal-wrapper',
    });
  });

  it('keeps hostile attribute text inside its string literals and parses it as the serialized page would', () => {
    const hostile = '"></i></script><script>alert(1)</script>';
    const doc: AdminDocument = {
      layout: 'template',
      title: '',
      htmlAttrs: { lang: hostile },
      bodyAttrs: { id: 'x', class: `a${hostile}` },
      preamble: raw(''),
      head: raw(''),
      body: raw(''),
      noCache: true,
    };
    const script = toString(attributeBootstrapScript(doc));
    const code = script.slice('<script>'.length, -'</script>'.length);
    expect(code).not.toMatch(/<\/|<!--|<script/i);
    expect(runBootstrap(script)).toEqual({ html: { lang: hostile }, body: { id: 'x', class: 'a' }, templates: 1 });
  });

  it('sets nothing for a document without attributes', () => {
    const doc: AdminDocument = {
      layout: 'compact',
      title: '',
      htmlAttrs: {},
      bodyAttrs: {},
      preamble: raw(''),
      head: raw(''),
      body: raw(''),
      noCache: false,
    };
    expect(runBootstrap(toString(attributeBootstrapScript(doc)))).toEqual({ html: {}, body: {}, templates: 0 });
  });
});
