import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderCategoryAjax } from '@/screens/ccategory/js';

const here = import.meta.dirname ?? __dirname;
const JS_CFM = path.resolve(here, '../../../../admin/core/views/ccategory/js.cfm');
const LABEL_KEY = 'categorymanager.addsubcategory';
const LABEL_CALL = `<cfoutput>#application.rbFactory.getKeyValue(session.rb,'${LABEL_KEY}')#</cfoutput>`;
const CUSTOM_LABEL = '<em>Add</em> &amp; review';
const SCRIPT = `script[src="assets/js/category.min.js?coreversion=${CORE_VERSION}"][type="text/javascript"]`;
const ICON = '#newContentMenu > #newCategoryOptions > #newPage > a#newCategoryLink[href=""] > i.mi-plus';

const en = rbFor('en');

/** The en lookup with the add-subcategory label replaced by `label`. */
const customised = (label: string): RbLookup => ({
  locale: en.locale,
  rbKey: (key) => (key === LABEL_KEY ? label : en.rbKey(key)),
  messageFormat: en.messageFormat,
});

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
  it.each<[string, RbLookup, string, string, string]>([
    ['the en label', en, 'Add Subcategory', 'Add Subcategory', ''],
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
