// Unit tests for the user search form of `cusers/inc/dsp_search_form.cfm`.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderSearchForm, type SearchFormArgs } from '@/screens/cusers/inc/dsp_search_form';
import { fragmentModel, normaliseIds } from '../../helpers/dom-model';

// The include's output in `cUsers.search` (search=a"<b) and `cUsers.listUsers` (ispublic=0) as admin on site
// `default`, cut from the legacy ACF 2023 server's responses between the include's first and last byte.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/people/cusers-search-form-${name}.html`, import.meta.url), 'utf8');

/** A lookup answering `[key]` with markup in it, to show labels are emitted unencoded. */
const STUB_RB: RbLookup = {
  locale: 'en',
  rbKey: (key) => `<b>[${key}]</b>`,
  messageFormat: () => {
    throw new Error('unused');
  },
};

function render(args: SearchFormArgs): string {
  const markup = renderSearchForm(args);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

describe('renderSearchForm', () => {
  it.each<[string, SearchFormArgs]>([
    ['search', { rc: { siteid: 'default', ispublic: '1' }, search: 'a"<b', rb: rbFor('en') }],
    ['listusers', { rc: { siteid: 'default', ispublic: '0' }, search: '', rb: rbFor('en') }],
  ])('reproduces the legacy %s capture byte for byte', (name, args) => {
    const out = render(args);
    expect(out).toBe(legacy(name));
    expect(normaliseIds(fragmentModel(out))).toEqual(normaliseIds(fragmentModel(legacy(name))));
  });

  it('encodes request values as legacy does and keeps labels raw', () => {
    const out = render({ rc: { siteid: "tenant a&b'c", ispublic: 'true' }, search: 'x & "y"', rb: STUB_RB });
    const $ = cheerio.load(out, null, false);

    const form = $('form');
    expect(form.length).toBe(1);
    expect(form[0]?.attribs).toEqual({
      class: 'form-inline',
      novalidate: 'novalidate',
      action: '',
      method: 'get',
      name: 'form1',
      id: 'siteSearch',
    });
    expect(Object.keys(form[0]?.attribs ?? {})).toEqual(['class', 'novalidate', 'action', 'method', 'name', 'id']);

    expect(out).toContain('value="x &amp; &quot;y&quot;" placeholder="<b>[user.searchforusers]</b>" />');
    expect($('#search').attr('value')).toBe('x & "y"');

    const advanced = $('div.mura-search > button.btn');
    expect(advanced.attr('onclick')).toBe(
      "actionModal();window.location='./?muraAction=cUsers.advancedSearch&ispublic=true&siteid=tenant+a%26b%27c&newSearch=true'",
    );
    expect(out).toContain('&amp;ispublic=true&amp;siteid=tenant+a%26b%27c&amp;newSearch=true\'" value="<b>[user.advanced]</b>">');
    expect(advanced.find('b').text()).toBe('[user.advanced]');
    expect($('span.mura-input-set > button.btn').attr('onclick')).toBe('submitForm(document.forms.form1);');

    const hidden = $('input[type="hidden"]')
      .toArray()
      .map((el) => [el.attribs.name, el.attribs.value]);
    expect(hidden).toEqual([
      ['siteid', "tenant a&b'c"],
      ['ispublic', 'true'],
      ['muraAction', 'cUsers.search'],
    ]);
    expect(out).toContain('name="siteid" value="tenant a&amp;b&#x27;c" />');
  });
});
