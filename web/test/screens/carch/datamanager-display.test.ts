import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { dataDisplayHtmlHead, renderDataDisplay, type DataDisplayInput } from '@/screens/carch/data-manager/display';
import { fragmentModel, type DomControl } from '../../helpers/dom-model';

// `cArch.datamanager&action=display` on Home, captured from the legacy ACF 2023 server and cut from the include's
// leading newline through `</form>\n`: as installed, and with seeded responses and display settings.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}`, import.meta.url), 'utf8');

const SPECIAL = `a<"&'b c`;
const HOME: DataDisplayInput = {
  fieldnames: '',
  responseDisplayFields: '',
  nextN: 10,
  sortBy: 'orderno',
  sortDirection: 'asc',
  contentid: '00000000000000000000000000000000001',
  moduleid: '00000000000000000000000000000000000',
  sessionSiteId: 'default',
};
const SEEDED: Partial<DataDisplayInput> = {
  fieldnames: `${SPECIAL},email,fname,lname`,
  responseDisplayFields: `email~fname^${SPECIAL}^lname`,
  nextN: 20,
  sortBy: 'LNAME',
  sortDirection: 'desc',
};

function render(fields: Partial<DataDisplayInput> = {}): string {
  const markup = renderDataDisplay({ rb: rbFor('en') }, { ...HOME, ...fields });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

function controls(markup: string): Record<string, DomControl> {
  return Object.fromEntries(fragmentModel(markup).controls.map((c) => [c.name, c]));
}

const selectedOf = (markup: string, name: string): string[] => controls(markup)[name]?.selected ?? [];

describe('carch.datamanager display panel', () => {
  it.each<[string, Partial<DataDisplayInput>, string]>([
    ['the installed Home', {}, 'datamanager-display-empty.html'],
    ['seeded responses and settings', SEEDED, 'datamanager-display-populated.html'],
  ])('matches the legacy panel for %s byte for byte', (_case, fields, name) => {
    expect(render(fields)).toBe(fixture(name));
  });

  it('models the labels, controls and buttons in legacy order', () => {
    const model = fragmentModel(render(SEEDED));
    expect(model.labels).toEqual([
      'Available Fields',
      'Summary Display Fields',
      'Detail Display Fields',
      'Records Per Page',
      'Sort By',
    ]);
    expect(model.controls.map((c) => [c.name, c.type, c.value])).toEqual([
      ['availableFields', 'select-one', ''],
      ['summaryList', 'select-one', ''],
      // The unencoded list ends the attribute at the field name's quote, as in legacy.
      ['summaryList2', 'hidden', 'fname^a<'],
      ['detailList', 'select-one', ''],
      ['detailList2', 'hidden', 'email'],
      ['nextN', 'select-one', '20'],
      ['sortBy', 'select-one', 'lname'],
      ['sortDirection', 'select-one', 'desc'],
      ['action', 'hidden', 'setDisplay'],
      ['muraAction', 'hidden', 'cArch.datamanager'],
      ['contentid', 'hidden', HOME.contentid],
      ['siteid', 'hidden', 'default'],
      ['moduleid', 'hidden', HOME.moduleid],
    ]);
    expect(model.buttons.map((b) => [b.text, b.type])).toEqual([
      ...Array.from({ length: 2 }, () => [
        ['>>', 'button'],
        ['<<', 'button'],
        ['Up', 'button'],
        ['Down', 'button'],
      ]).flat(),
      ['Update', 'submit'],
    ]);
  });

  // Observed on the legacy server for each `responseDisplayFields` value.
  it.each<[string, string, string]>([
    ['', '', ''],
    ['email~fname^lname', 'email', 'fname^lname'],
    ['fname^lname', 'fname^lname', 'fname^lname'],
    ['~fname', '', 'fname'],
    ['email~', 'email', ''],
    ['a~m~b', 'a', 'b'],
  ])('splits %j into detail %j and summary %j', (rdf, detail, summary) => {
    const c = controls(render({ responseDisplayFields: rdf }));
    expect([c.detailList2?.value, c.summaryList2?.value]).toEqual([detail, summary]);
  });

  it.each<[DataDisplayInput['nextN'], string[]]>([
    [20, ['20']],
    ['20.0', ['20']],
    [' 20 ', ['20']],
    ['20.', []],
    ['', []],
  ])('selects records per page for nextN %j as CFML eq does', (nextN, expected) => {
    expect(selectedOf(render({ nextN }), 'nextN')).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['ASC', ['asc']],
    ['Desc', ['desc']],
    ['', []],
  ])('selects sort direction %j case-insensitively', (sortDirection, expected) => {
    expect(selectedOf(render({ sortDirection }), 'sortDirection')).toEqual(expected);
  });

  it('drops empty list items and encodes the hidden ids for attributes', () => {
    const markup = render({
      fieldnames: ',a,,b,',
      responseDisplayFields: '^p^^q^~^r^',
      contentid: 'c"1',
      sessionSiteId: 'tenant-a',
    });
    const c = controls(markup);
    expect([c.availableFields, c.detailList, c.summaryList].map((s) => s?.options.map((o) => o.value))).toEqual([
      ['a', 'b'],
      ['p', 'q'],
      ['r'],
    ]);
    expect(markup).toContain('<input type="hidden" name="contentid" value="c&quot;1" />');
    expect(markup).toContain('<input type="hidden" name="siteid" value="tenant-a" />');
  });

  it('writes the manageData script for the head with the core version', () => {
    expect(toString(dataDisplayHtmlHead('7.6.1'))).toBe(
      '<script src="assets/js/manageData.js?coreversion=7.6.1" type="text/javascript"></script>',
    );
  });
});
