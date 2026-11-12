// Unit tests for the compact admin layout against admin/common/layouts/compact.cfm and pages the legacy oracle rendered.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { encodeJs, isSafeHtml, raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderCompact, resolveFrontEndProxyLoc } from '@/shell/compact';
import type { AdminDocument, ShellContext, ShellHooks, ShellView } from '@/shell/types';
import { adminS2Request, buildTestAdminRequest, type AdminRequestPartial } from '../helpers/admin-request';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/shell');
const MSIE_UA = 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)';
const NICE_SELECT = 'jquery.nice-select.min.js';

/**
 * Markers standing for markup other renderers own; the fixtures are oracle pages of `carch.edit` with these regions and
 * the view's `request.ajax` and body replaced: [marker, region start, region end].
 */
const REGIONS: ReadonlyArray<readonly [marker: string, start: string, end: string]> = [
  ['<!--HTML-HEAD-->', '<!-- Favicons -->', `${NICE_SELECT}" type="text/javascript"></script>`],
  ['<!--COMPACT-SCRIPTS-->', '<script type="text/javascript">\n\n\t\t\tvar resizeTabPane', '</script>'],
];

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** Markup with whitespace between tags dropped and other whitespace runs collapsed. */
const squash = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/** `markup` with the first `start`…`end` region replaced by `marker`. */
function replaceRegion(markup: string, marker: string, start: string, end: string): string {
  const from = markup.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
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

/** The compact shell context `document.ts` resolves for `ctx`, with the screen's `view` and the shell `hooks`. */
function shellFor(ctx: AdminRequest, view: Partial<ShellView> = {}, hooks: Partial<ShellHooks> = {}): ShellContext {
  const [circuit = '', item = ''] = (ctx.action.split(':').at(-1) ?? '').split('.');
  return {
    ctx,
    view: { body: raw('<!--VIEW-->'), ajax: raw('<!--AJAX-->'), ...view },
    hooks: { secondaryMenus: {}, ...hooks },
    data: {
      rb: { locale: 'en_US', rbKey: (key) => key, messageFormat: (pattern) => pattern },
      user: { fname: 'Admin', lname: 'User', passwordExpired: false, hasDefaultPassword: false },
      userSites: [],
      prompts: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
      sitePlugins: [],
      server: null,
      updateCoreCsrfQuery: '',
      exportLocationExists: false,
      now: new Date(2026, 5, 30, 12),
    },
    layout: 'compact',
    originalCircuit: view.originalCircuit ?? circuit,
    originalFuseaction: view.originalFuseaction ?? item,
    moduleTitle: view.moduleTitle ?? '',
    bodyclass: '',
    siteId: ctx.rc.siteid || ctx.session.siteid || 'default',
  };
}

/** The layout's document for `sc`, its markup parts asserted to be module-made markup. */
function render(sc: ShellContext): AdminDocument {
  const doc = renderCompact(sc);
  for (const part of [doc.preamble, doc.head, doc.body]) expect(isSafeHtml(part)).toBe(true);
  return doc;
}

const load = (doc: AdminDocument) => cheerio.load(serialize(doc));

/** The S2 admin on `carch.edit` in the compact display, `rc` laid over that. */
const carchEdit = (rc: AdminRequestPartial['rc'] = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cArch', item: 'edit', ...partial, rc: { compactDisplay: 'true', ...rc } });

/** Occurrences of `needle` in `haystack`. */
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

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

describe('renderCompact against the oracle', () => {
  it.each([
    {
      name: 'the default modal source frame',
      ctx: () => carchEdit(),
      file: 'compact-modal-carch-edit.html',
      htmlAttrs: { lang: 'en_US', class: 'mura no-focus' },
      bodyClass: 'compact modal-wrapper',
    },
    {
      name: 'the configurator source frame',
      ctx: () => carchEdit({ sourceFrame: 'configurator' }),
      file: 'compact-configurator-carch-edit.html',
      htmlAttrs: { lang: 'en_US', class: 'mura no-focus' },
      bodyClass: 'compact configurator-wrapper',
    },
    {
      name: 'an MSIE user agent in a mixed-case configurator frame',
      ctx: () => carchEdit({ sourceFrame: 'Configurator' }, { isMSIE: true, userAgent: MSIE_UA }),
      file: 'compact-msie-configurator-carch-edit.html',
      htmlAttrs: { lang: 'en_US', class: 'mura ie' },
      bodyClass: 'compact configurator-wrapper',
    },
  ])('renders carch.edit for $name', ({ ctx, file, htmlAttrs, bodyClass }) => {
    const doc = render(shellFor(ctx()));
    expect(squash(skeleton(doc))).toBe(squash(fixture(file)));
    expect(doc).toEqual({
      layout: 'compact',
      title: 'Masa CMS',
      htmlAttrs,
      bodyAttrs: { id: 'carch', class: bodyClass },
      preamble: doc.preamble,
      head: doc.head,
      body: doc.body,
      noCache: false,
    });
  });
});

describe('renderCompact', () => {
  it.each([
    { sourceFrame: undefined, modal: true },
    { sourceFrame: 'MODAL', modal: true },
    { sourceFrame: 'configurator', modal: false },
    { sourceFrame: '', modal: false },
  ])('keys the modal chrome and the second nice-select on sourceFrame "$sourceFrame"', ({ sourceFrame, modal }) => {
    const doc = render(shellFor(carchEdit({ sourceFrame })));
    const $ = load(doc);
    expect($('body').hasClass(modal ? 'modal-wrapper' : 'configurator-wrapper')).toBe(true);
    expect($('#mura-content > a#frontEndToolsModalClose').length).toBe(modal ? 1 : 0);
    expect($('#mura-content > #alertDialog').length).toBe(modal ? 1 : 0);
    expect($('#mura-content > .main.mura-layout-row').length).toBe(1);
    expect(count(toString(doc.head), NICE_SELECT)).toBe(modal ? 1 : 2);
    expect(toString(doc.head)).toContain(`'targetFrame': '${encodeJs(sourceFrame ?? 'modal')}'`);
  });

  it('renders no nav, header, alerts, frame-buster or content nav', () => {
    const contentNav = vi.fn(() => raw('<!--CONTENT-NAV-->'));
    const doc = render(shellFor(carchEdit({ moduleid: '00000000000000000000000000000000000' }), {}, { contentNav }));
    const $ = load(doc);
    expect($('#sidebar, #header-navbar, #page-container, .alert').length).toBe(0);
    expect(toString(doc.head)).not.toContain('top.location.replace');
    expect(contentNav).not.toHaveBeenCalled();
    expect(doc.noCache).toBe(false);
  });

  it('titles the page with the configured title alone, encoded in the element and decoded in the record', () => {
    vi.stubEnv('MURA_TITLE', 'A & B');
    resetLegacySettingsForTests();
    const doc = render(shellFor(carchEdit(), { moduleTitle: 'Site Content' }));
    expect(doc.title).toBe('A & B');
    expect(toString(doc.head)).toContain('<title>A &amp; B</title>');
    expect(load(doc)('title').text()).toBe('A & B');
  });

  it.each([
    { domain: '', script: false },
    { domain: "example.test';x='", script: true },
  ])('sets window.document.domain unencoded when configured ("$domain")', ({ domain, script }) => {
    vi.stubEnv('MURA_WINDOWDOCUMENTDOMAIN', domain);
    resetLegacySettingsForTests();
    const head = toString(render(shellFor(carchEdit())).head);
    expect(head.includes(`window.document.domain = '${domain}';`)).toBe(script);
    expect(head.includes('window.document.domain')).toBe(script);
  });

  it('html_attr-encodes the original circuit as the emitted body id', () => {
    const doc = render(shellFor(carchEdit(), { originalCircuit: 'c"a<b' }));
    expect(doc.bodyAttrs.id).toBe('c&quot;a&lt;b');
    expect(load(doc)('body').attr('id')).toBe('c"a<b');
  });

  it('places the view head parts in legacy order, ending with the accumulated cfhtmlhead text', () => {
    const ctx = carchEdit({}, { isMSIE: true, userAgent: MSIE_UA });
    const doc = render(shellFor(ctx, { htmlHead: raw('<!--CFHTMLHEAD-->') }));
    const head = toString(doc.head);
    const order = [
      '<title>',
      'html5.js',
      '<!-- Favicons -->',
      '<!-- /nice-select -->',
      'porthole.min.js',
      'admin.min.css',
      'var dtExample=',
      'Mura.init(',
      '<!--AJAX-->',
      'ie.min.css',
      '<!--CFHTMLHEAD-->',
    ];
    const positions = order.map((part) => head.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(head.trimEnd().endsWith('<!--CFHTMLHEAD-->')).toBe(true);
  });

  it('places the view inside the layout row ahead of the footer scripts', () => {
    const body = toString(render(shellFor(carchEdit(), { body: raw('<p id="view">v</p>') })).body);
    expect(body).toContain('<div class="main mura-layout-row"><p id="view">v</p></div>');
    expect(body.indexOf('<!-- /mura-content -->')).toBeLessThan(body.indexOf('bootstrap-slider.min.js'));
  });
});

describe('resolveFrontEndProxyLoc', () => {
  it.each([
    { rc: 'http://rc.test', stored: 'http://stored.test', expected: 'http://rc.test' },
    { rc: '', stored: 'http://stored.test', expected: 'http://stored.test' },
    { rc: undefined, stored: 'http://stored.test', expected: 'http://stored.test' },
    { rc: undefined, stored: '', expected: '' },
  ])('takes rc "$rc" over the stored "$stored"', ({ rc, stored, expected }) => {
    const ctx = carchEdit({ frontEndProxyLoc: rc }, { session: { frontEndProxyLoc: stored } });
    expect(resolveFrontEndProxyLoc(ctx)).toBe(expected);
    const head = toString(render(shellFor(ctx)).head);
    expect(head).toContain(`new Porthole.WindowProxy("${encodeJs(expected)}/admin/assets/js/porthole/proxy.html")`);
  });

  it.each<{ query: Readonly<Record<string, string>>; written: string | undefined }>([
    { query: { frontEndProxyLoc: 'http://localhost:8080' }, written: 'http://localhost:8080' },
    { query: {}, written: undefined },
  ])('reads the proxy location the request set-up records for the session ($written)', async ({ query, written }) => {
    const ctx = await buildTestAdminRequest({
      circuit: 'cArch',
      action: 'edit',
      user: 'admin',
      query: { compactDisplay: 'true', ...query },
    });
    expect(ctx.sessionWrites.frontEndProxyLoc).toBe(written);
    expect(resolveFrontEndProxyLoc(ctx)).toBe(written ?? '');
  });
});
