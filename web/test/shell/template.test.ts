// Unit tests for the full admin layout against admin/common/layouts/template.cfm and pages the legacy oracle rendered.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCookieHeader } from '@opt2/platform/legacy-compat';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { resolveModuleTitle } from '@/shell/module-title';
import { htmlOpener, renderTemplate } from '@/shell/template';
import type { AdminDocument, ShellContext, ShellHooks, ShellView } from '@/shell/types';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  type AdminRequestPartial,
} from '../helpers/admin-request';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/shell');
const Z = '00000000000000000000000000000000';
const MSIE_UA = 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)';

/** The carch list's `request.ajax` and accumulated `cfhtmlhead`, as the oracle printed them. */
const CARCH_AJAX = '<script src="/admin/assets/js/architecture.min.js?coreversion=7.6.1" type="text/javascript" ></script>';
const CARCH_HTML_HEAD = '<script src="/admin/assets/js/jquery/jquery-pulse.js?coreversion=7.6.1" type="text/javascript"></script>';

/**
 * Markers standing for markup other renderers own; the fixtures are oracle pages with these regions replaced, and the
 * same regions are replaced in the rendered page: [marker, region start, region end].
 */
const REGIONS: ReadonlyArray<readonly [marker: string, start: string, end: string]> = [
  ['<!--HTML-HEAD-->', '<!-- Favicons -->', 'jquery.nice-select.min.js" type="text/javascript"></script>'],
  ['<!--NAV-->', '<nav id="sidebar">', '</nav>'],
  ['<!--HEADER-->', '<header id="header-navbar"', '</header>'],
  ['<!--TEMPLATE-SCRIPTS-->', "<script>\n\t\t\t$(document).on('click'", '</script>'],
];

const VIEW_MARK = '<!--VIEW-->';
const CONTENT_NAV_MARK = '<!--CONTENT-NAV-->';

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** Markup with whitespace between tags dropped and other whitespace runs collapsed. */
const squash = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/** `markup` with the first `start`…`end` region replaced by `marker`. */
function replaceRegion(markup: string, marker: string, start: string, end: string): string {
  const from = markup.indexOf(start);
  if (from < 0) return markup;
  const to = markup.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return markup.slice(0, from) + marker + markup.slice(to + end.length);
}

/** The page as a raw response carries it: preamble, head and body, body attributes emitted as recorded. */
function serialize(doc: AdminDocument): string {
  const attrs = Object.entries(doc.bodyAttrs)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return `${toString(doc.preamble)}\n<head>\n${toString(doc.head)}\n</head>\n<body${attrs}>\n${toString(doc.body)}\n</body>\n</html>`;
}

/** The serialized page with the other renderers' regions replaced by their markers. */
const skeleton = (doc: AdminDocument): string =>
  REGIONS.reduce((markup, [marker, start, end]) => replaceRegion(markup, marker, start, end), serialize(doc));

/** The shell context `document.ts` resolves for `ctx`, with the screen's `view` and the shell `hooks`. */
function shellFor(ctx: AdminRequest, view: Partial<ShellView> = {}, hooks: Partial<ShellHooks> = {}): ShellContext {
  const [circuit = '', item = ''] = (ctx.action.split(':').at(-1) ?? '').split('.');
  const originalCircuit = view.originalCircuit ?? circuit;
  const originalFuseaction = view.originalFuseaction ?? item;
  const { moduleTitle, bodyclass } = resolveModuleTitle({
    originalCircuit,
    originalFuseaction,
    moduleId: ctx.rc.moduleid ?? '',
    action: ctx.action,
    override: view.moduleTitle,
    bodyclass: view.bodyclass ?? ctx.rc.bodyclass ?? '',
  });
  return {
    ctx,
    view: { body: raw(VIEW_MARK), ...view },
    hooks: { secondaryMenus: {}, ...hooks },
    data: {
      rb: rbFor('en_US'),
      user: { fname: 'Admin', lname: 'User', passwordExpired: false, hasDefaultPassword: false },
      userSites: [{ siteId: 'default', site: 'Default', showDashboard: false }],
      prompts: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
      sitePlugins: [],
      server: null,
      updateCoreCsrfQuery: '',
      exportLocationExists: false,
      now: new Date(2026, 5, 30, 12),
    },
    layout: 'template',
    originalCircuit,
    originalFuseaction,
    moduleTitle,
    bodyclass,
    siteId: ctx.rc.siteid || ctx.session.siteid || 'default',
  };
}

/** The layout's document for `sc`, its markup parts asserted to be module-made markup. */
function render(sc: ShellContext): AdminDocument {
  const doc = renderTemplate(sc);
  for (const part of [doc.preamble, doc.head, doc.body]) expect(isSafeHtml(part)).toBe(true);
  return doc;
}

const load = (doc: AdminDocument) => cheerio.load(serialize(doc));

/** `ctx` with `cookieHeader` as the cookie scope the admin set-up left. */
const withCookies = (ctx: AdminRequest, cookieHeader: string): AdminRequest => ({
  ...ctx,
  cookies: parseCookieHeader(cookieHeader),
});

const cusersList = (partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cUsers', item: 'list', ...partial });

const contentList = (moduleid: string, item = 'list'): AdminRequest =>
  editorRequest({ circuit: 'cArch', item, rc: { moduleid } });

/** A hook standing for `carch/dsp_content_nav.cfm`. */
const contentNavHook = () => vi.fn((_ctx: AdminRequest): SafeHtml => raw(CONTENT_NAV_MARK));

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

describe('htmlOpener', () => {
  it.each([
    {
      isMSIE: false,
      preamble: [
        '<!DOCTYPE html>',
        '<!--[if IE 9]> <html lang="en_US" class="ie9 mura no-focus"> <![endif]-->',
        '<!--[if gt IE 9]><!--> <html lang="de&quot;x" class="mura no-focus"><!--<![endif]-->',
      ],
      htmlClass: 'mura no-focus',
    },
    {
      isMSIE: true,
      preamble: [
        '<!DOCTYPE html>',
        '<!--[if IE 8 ]><html class="mura ie ie8" lang="de&quot;x"><![endif]-->',
        '<!--[if (gte IE 9)|!(IE)]><!--><html lang="de&quot;x" class="mura ie"><!--<![endif]-->',
      ],
      htmlClass: 'mura ie',
    },
  ])('encodes the locale in the opener and records it decoded (MSIE $isMSIE)', ({ isMSIE, preamble, htmlClass }) => {
    const opener = htmlOpener('de"x', isMSIE);
    expect(isSafeHtml(opener.preamble)).toBe(true);
    expect(toString(opener.preamble)).toBe(preamble.join('\n'));
    expect(opener.htmlAttrs).toEqual({ lang: 'de"x', class: htmlClass });
  });
});

describe('renderTemplate against the oracle', () => {
  it('renders the anonymous login page without chrome, content wrapper, inline scripts or frame-buster', () => {
    const doc = render(shellFor(anonymousRequest({ circuit: 'cLogin', item: 'main' })));
    expect(squash(skeleton(doc))).toBe(squash(fixture('template-login.html')));
    expect(doc).toMatchObject({
      layout: 'template',
      title: 'Masa CMS - Login',
      htmlAttrs: { lang: 'en_US', class: 'mura no-focus' },
      bodyAttrs: { id: 'clogin', class: 'mura-admin header-navbar-fixed no-constrain ' },
      noCache: true,
    });
    const $ = load(doc);
    expect($('title').text()).toBe('Masa CMS - Login');
    expect($('#sidebar, #header-navbar, #mura-content').length).toBe(0);
    expect(toString(doc.head)).not.toContain('top.location');
    expect(toString(doc.body)).not.toContain('Mura.init');
  });

  it('renders the S2 admin on cusers.list with nav, header, cache notice, content wrapper and inline scripts', () => {
    const doc = render(shellFor(cusersList()));
    expect(squash(skeleton(doc))).toBe(squash(fixture('template-admin-cusers-list.html')));
    expect(doc.title).toBe('Masa CMS - Users');
    expect(doc.bodyAttrs).toEqual({ id: 'cusers', class: 'mura-admin header-navbar-fixed no-constrain ' });
    const $ = load(doc);
    expect($('#page-container > #sidebar').length).toBe(1);
    expect($('#page-container > #header-navbar').length).toBe(1);
    expect($('main#main-container.block-constrain > .content > #mura-content').length).toBe(1);
  });

  it('renders the editor on the content list with the content-tab body class and the content nav', () => {
    const contentNav = contentNavHook();
    const ctx = contentList(`${Z}000`);
    const doc = render(shellFor(ctx, { ajax: raw(CARCH_AJAX), htmlHead: raw(CARCH_HTML_HEAD) }, { contentNav }));
    expect(squash(skeleton(doc))).toBe(squash(fixture('template-editor-carch-list.html')));
    expect(contentNav).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(doc.title).toBe('Masa CMS - Site Content');
    expect(load(doc)('body').hasClass('sidebar-tab')).toBe(true);
    expect(toString(doc.head).trimEnd().endsWith(CARCH_HTML_HEAD)).toBe(true);
  });

  it('renders the MSIE opener and the IE stylesheet for an MSIE user agent', () => {
    const ctx = { ...cusersList(), isMSIE: true, userAgent: MSIE_UA };
    const doc = render(shellFor(ctx));
    expect(squash(skeleton(doc))).toBe(squash(fixture('template-msie-admin-cusers-list.html')));
    expect(doc.htmlAttrs).toEqual({ lang: 'en_US', class: 'mura ie' });
  });
});

describe('renderTemplate', () => {
  it.each([
    { cookie: 'ADMINSIDEBAR=off', mini: true },
    { cookie: 'adminsidebar=OFF', mini: true },
    { cookie: 'rb=en_US', mini: true },
    { cookie: 'ADMINSIDEBAR=on', mini: false },
  ])('derives the sidebar mode from the cookie scope ($cookie)', ({ cookie, mini }) => {
    const $ = load(render(shellFor(withCookies(cusersList(), cookie))));
    const pageContainer = $('#page-container');
    expect(pageContainer.hasClass('sidebar-mini')).toBe(mini);
    expect(pageContainer.attr('class')).toBe(
      `sidebar-l sidebar-o ${mini ? ' sidebar-mini' : ''} side-overlay-hover side-scroll header-navbar-fixed`,
    );
  });

  it.each([
    { name: 'a public member', ctx: () => noSitesRequest({ s2IsPrivate: false }, { circuit: 'cEditProfile', item: 'edit' }) },
    { name: 'an S2 admin without a session site', ctx: () => ({ ...cusersList(), session: { ...cusersList().session, siteid: '' } }) },
  ])('omits nav, header and the constrained main for $name', ({ ctx }) => {
    const $ = load(render(shellFor(ctx())));
    expect($('#sidebar, #header-navbar').length).toBe(0);
    expect($('main#main-container').attr('class')).toBe('');
    expect($('#page-container').attr('class')).toBe(' sidebar-o  sidebar-mini side-overlay-hover side-scroll header-navbar-fixed');
    expect($('#mura-content').length).toBe(1);
  });

  it.each([
    { moduleid: `${Z}000`, item: 'list', called: true },
    { moduleid: `${Z}003`, item: 'search', called: true },
    { moduleid: `${Z}004`, item: 'LIST', called: true },
    { moduleid: `${Z}099`, item: 'list', called: true },
    { moduleid: '', item: 'search', called: true },
    { moduleid: `${Z}008`, item: 'list', called: false },
    { moduleid: `${Z}000`, item: 'edit', called: false },
  ])('includes the content nav for carch.$item of module "$moduleid": $called', ({ moduleid, item, called }) => {
    const contentNav = contentNavHook();
    const doc = render(shellFor(contentList(moduleid, item), {}, { contentNav }));
    expect(contentNav).toHaveBeenCalledTimes(called ? 1 : 0);
    expect(toString(doc.body).includes(CONTENT_NAV_MARK)).toBe(called);
  });

  it('includes the content nav only for the content circuit and tolerates a missing hook', () => {
    const contentNav = contentNavHook();
    const doc = render(shellFor(cusersList({ rc: { moduleid: `${Z}000` } }), {}, { contentNav }));
    expect(contentNav).not.toHaveBeenCalled();
    expect(toString(doc.body)).not.toContain(CONTENT_NAV_MARK);
    expect(() => render(shellFor(contentList(`${Z}000`)))).not.toThrow();
  });

  it('keys the frame-buster on the original circuit and the content wrapper on the action', () => {
    const doc = render(shellFor(anonymousRequest({ circuit: 'cLogin', item: 'main' }), { originalCircuit: 'cMessage' }));
    expect(toString(doc.head)).toContain('if (top.location != self.location) {');
    expect(toString(doc.head)).toContain('top.location.replace(self.location)');
    expect(doc.bodyAttrs.id).toBe('cMessage');
    expect(load(doc)('#mura-content').length).toBe(0);
    const logout = render(shellFor(anonymousRequest({ circuit: 'cLogin', item: 'logout' })));
    expect(toString(logout.head)).not.toContain('top.location');
    expect(load(logout)('#mura-content').length).toBe(1);
  });

  it('keeps the body class unencoded and trimmed, and the module title from the view', () => {
    const doc = render(shellFor(cusersList(), { bodyclass: ' \tx"y\n', moduleTitle: 'A & B' }));
    expect(doc.bodyAttrs.class).toBe('mura-admin header-navbar-fixed no-constrain x"y');
    expect(doc.title).toBe('Masa CMS - A & B');
    expect(toString(doc.head)).toContain('<title>Masa CMS - A &amp; B</title>');
  });

  it('places the view, alerts and footer in legacy order', () => {
    const doc = render(shellFor(cusersList(), { body: raw('<p id="view">v</p>') }));
    const body = toString(doc.body);
    const order = [
      '<!-- Page Container -->',
      'class="alert alert-warning"',
      '<p id="view">',
      'Mura.init(',
      'bootstrap-slider.min.js',
      'id="alertDialog"',
      '<!-- /.page-container -->',
    ];
    const positions = order.map((part) => body.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
