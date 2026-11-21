import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORE_VERSION } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderCategoryAjax } from '@/screens/ccategory/js';
import { useTestEnv } from '../../helpers/env';

const here = import.meta.dirname ?? __dirname;
const JS_CFM = path.resolve(here, '../../../../admin/core/views/ccategory/js.cfm');
const LABEL_KEY = 'categorymanager.addsubcategory';
const LABEL_CALL = `<cfoutput>#application.rbFactory.getKeyValue(session.rb,'${LABEL_KEY}')#</cfoutput>`;
const CUSTOM_LABEL = '<em>Add</em> &amp; review';
const SCRIPT = `script[src="assets/js/category.min.js?coreversion=${CORE_VERSION}"][type="text/javascript"]`;
const ICON = '#newContentMenu > #newCategoryOptions > #newPage > a#newCategoryLink[href=""] > i.mi-plus';

const en = rbFor('en');
const enUS = rbFor('en_US');

/** The en lookup with the add-subcategory label replaced by `label`. */
const customised = (label: string): RbLookup => ({
  locale: en.locale,
  rbKey: (key) => (key === LABEL_KEY ? label : en.rbKey(key)),
  messageFormat: en.messageFormat,
});

/** Answers `X<key>` for every key. */
const keyed: RbLookup = {
  locale: 'en_US',
  rbKey: (key) => `X${key}`,
  messageFormat: (pattern) => pattern,
};

/** The `request.ajax` block of `ccategory/js.cfm` as legacy outputs it with `label`. */
function legacyOutput(label: string): string {
  const source = readFileSync(JS_CFM, 'utf8').replaceAll('\r\n', '\n');
  const body = source.slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'));
  return body
    .trimStart()
    .replace('<!---ontouchstart="this.onclick();"--->', '')
    .replace('#application.coreversion#', CORE_VERSION)
    .replace(LABEL_CALL, label);
}

describe('renderCategoryAjax', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('emits the relative category script, then the add-subcategory menu', () => {
    const markup = toString(renderCategoryAjax(enUS));
    const $ = cheerio.load(markup);

    const script = $('script');
    expect(script).toHaveLength(1);
    expect(script.attr('src')).toBe('assets/js/category.min.js?coreversion=7.6.1');
    expect(script.attr('src')).toBe(`assets/js/category.min.js?coreversion=${CORE_VERSION}`);
    expect(script.attr('type')).toBe('text/javascript');
    expect(script.text().trim()).toBe('');

    const menu = $('div#newContentMenu');
    expect(menu).toHaveLength(1);
    expect(menu.hasClass('addNew')).toBe(true);
    expect(menu.hasClass('hide')).toBe(true);
    const link = menu.find('> ul#newCategoryOptions > li#newPage > a#newCategoryLink');
    expect(link).toHaveLength(1);
    expect(link.attr('href')).toBe('');
    expect(link.children('i.mi-plus')).toHaveLength(1);
    expect(link.text().trim()).toBe('Add Subcategory');

    const fragment = cheerio.load(markup, null, false);
    const topLevel = fragment.root().children().toArray();
    expect(topLevel.map((el) => el.tagName)).toEqual(['script', 'div']);
    expect(fragment(topLevel[1]).attr('id')).toBe('newContentMenu');
  });

  it.each<[string, RbLookup, string, string, string]>([
    ['the en label', en, 'Add Subcategory', 'Add Subcategory', ''],
    ['the en_US label', enUS, 'Add Subcategory', 'Add Subcategory', ''],
    ['the categorymanager.addsubcategory key', keyed, `X${LABEL_KEY}`, `X${LABEL_KEY}`, ''],
    ['a customised markup and entity label verbatim', customised(CUSTOM_LABEL), CUSTOM_LABEL, 'Add & review', 'Add'],
  ])('matches ccategory/js.cfm with %s', (_, lookup, label, linkText, emText) => {
    const markup = renderCategoryAjax(lookup);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(legacyOutput(label));
    expect(toString(markup)).toContain(`<i class="mi-plus"></i> ${label}</a>`);

    const $ = cheerio.load(toString(markup));
    expect($(SCRIPT)).toHaveLength(1);
    expect($('#newContentMenu.addNew.hide')).toHaveLength(1);
    expect($(ICON)).toHaveLength(1);
    const link = $('a#newCategoryLink');
    expect(link.text().trim()).toBe(linkText);
    expect(link.find('em').text()).toBe(emText);
  });
});
