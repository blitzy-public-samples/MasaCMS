// Unit tests for the Site Manager content nav shell hook against carch/dsp_content_nav.cfm.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeHtml, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { carchContentNav } from '@/screens/carch/content-nav';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';

const here = import.meta.dirname ?? __dirname;
const NAV_CFM = path.resolve(here, '../../../../admin/core/views/carch/dsp_content_nav.cfm');
const ALERT_STYLE = 'style="float:left; margin:0 7px 20px 0;"';

const ITEMS = [
  { id: 'newZoom', icon: 'mi-search-plus', key: 'sitemanager.zoom' },
  { id: 'newContent', icon: 'mi-plus', key: 'sitemanager.addcontent' },
  { id: 'newCopy', icon: 'mi-copy', key: 'sitemanager.copy' },
  { id: 'newCopyAll', icon: 'mi-sitemap', key: 'sitemanager.copyall' },
  { id: 'newPaste', icon: 'mi-paste', key: 'sitemanager.paste' },
] as const;

const LOCALES = ['en_US', 'de_DE', 'es_ES'] as const;

/** Text a browser shows for label markup `markup`. */
const shownText = (markup: string): string => cheerio.load(markup, null, false).root().text();

/** The view's output from `#newContentMenu` through the line break before `</cfoutput>`, labels looked up in `rb`. */
function legacyNav(rb: RbLookup): string {
  const source = readFileSync(NAV_CFM, 'utf8').replaceAll('\r\n', '\n');
  return source
    .slice(source.indexOf('<div id="newContentMenu"'), source.lastIndexOf('</cfoutput>'))
    .replace(/<!---.*?--->/gs, '')
    .replace(/#application\.rbFactory\.getKeyValue\(session\.rb,"([^"]+)"\)#/g, (_, key: string) => rb.rbKey(key));
}

/** The hook's markup for `req`. */
function render(req: AdminRequest): string {
  const markup = carchContentNav(req);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

const requestIn = (rb: string): AdminRequest => adminS2Request({ session: { rb } });

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('carchContentNav', () => {
  it.each(LOCALES)('matches the legacy view in %s', (locale) => {
    const req = requestIn(locale);
    expect(req.session.rb).toBe(locale);
    expect(render(req)).toBe(legacyNav(rbFor(req.session.rb)));
  });

  it('opens the hidden menu and its option list', () => {
    const out = render(adminS2Request());
    expect(out.startsWith('<div id="newContentMenu" class="addNew hide">\n')).toBe(true);
    expect(out).toContain('<ul id="newContentOptions">');
  });

  it('lists the five options in order with their link ids, icons and empty hrefs', () => {
    const $ = cheerio.load(render(adminS2Request()), null, false);
    const items = $('#newContentMenu > #newContentOptions > li').toArray().map((li) => $(li));
    expect(items.map((li) => li.attr('id'))).toEqual(ITEMS.map((i) => i.id));
    for (const [n, li] of items.entries()) {
      const link = li.children('a');
      expect(link.attr('id')).toBe(`${ITEMS[n]?.id}Link`);
      expect(link.attr('href')).toBe('');
      expect(link.children('i').attr('class')).toBe(ITEMS[n]?.icon);
    }
  });

  it.each(LOCALES)('writes the %s labels unencoded', (locale) => {
    const req = requestIn(locale);
    const rb = rbFor(req.session.rb);
    const out = render(req);
    for (const { id, icon, key } of ITEMS) {
      const link = `<a href="" id="${id}Link"><i class="${icon}"></i>${rb.rbKey(key)}</a>`;
      expect(out).toContain(`<li id="${id}">${link}</li>`);
    }
    expect(fragmentModel(out).links).toEqual(ITEMS.map(({ key }) => ({ href: '', text: shownText(rb.rbKey(key)) })));
  });

  it.each(['de_DE', 'es_ES'])('looks up %s labels that encoding would change', (locale) => {
    const rb = rbFor(requestIn(locale).session.rb);
    expect(ITEMS.some(({ key }) => encodeHtml(rb.rbKey(key)) !== rb.rbKey(key))).toBe(true);
    expect(ITEMS.every(({ key }) => rb.rbKey(key) !== `${key}_missing`)).toBe(true);
  });

  it('renders the new-content dialog with its alert icon and container', () => {
    const out = render(adminS2Request());
    expect(out).toContain('<div id="newContentDialog" title="Add New Content" class="hide">');
    expect(out).toContain(`<span class="ui-icon ui-icon-alert" ${ALERT_STYLE}></span>`);
    expect(out).toContain('<span id="newContentContainer"></span>');
    const $ = cheerio.load(out, null, false);
    const dialog = $('#newContentDialog');
    expect(dialog.attr('title')).toBe('Add New Content');
    expect(dialog.find('p > span.ui-icon.ui-icon-alert').length).toBe(1);
    expect(dialog.find('p > span#newContentContainer').length).toBe(1);
    expect($.root().children().toArray().map((el) => $(el).attr('id'))).toEqual(['newContentMenu', 'newContentDialog']);
  });

  it('ends with a line break after the dialog', () => {
    expect(render(adminS2Request()).endsWith('</div>\n')).toBe(true);
  });
});
