// Unit tests for the cfeed `request.ajax` scripts and the `dsp_categories_import_nest` category assignment tree.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { renderFeedCategoriesImportNest, type CategoryAssignRow } from '@/screens/cfeed/categories-import-nest';
import type { FeedCategoryNode } from '@/screens/cfeed/categories-nest';
import { cfeedAjaxScripts } from '@/screens/cfeed/js';
import { fragmentModel } from '../../helpers/dom-model';

const here = import.meta.dirname ?? __dirname;
const JS_CFM = path.resolve(here, '../../../../admin/core/views/cfeed/js.cfm');

const DATE_KEY_FORMAT = 'MM/DD/YYYY';
const HIST_ID = 'B3000000-0000-0000-0000000000000001';
const OTHER_HIST_ID = 'B3000000-0000-0000-0000000000000002';
const CAT_ID = 'C3000000-0000-0000-0000000000000001';
const CHILD_ID = 'C3000000-0000-0000-0000000000000002';
const CAT_TRIM = 'C3000000000000000000000000000001';
const CHILD_TRIM = 'C3000000000000000000000000000002';
const ONCHANGE =
  `onchange="javascript: this.selectedIndex==3?toggleDisplay2('editDates${CAT_TRIM}',true):` +
  `toggleDisplay2('editDates${CAT_TRIM}',false);"`;

/** Control state when no assignment, or no valid feature date, applies. */
const DEFAULTS = {
  featureStart: '',
  starthour: ['12'],
  startMinute: [],
  startDayPart: [],
  featureStop: '',
  stophour: ['11'],
  stopMinute: ['59'],
  stopDayPart: ['PM'],
};

/** The `request.ajax` block of `cfeed/js.cfm` as legacy outputs it. */
function legacyOutput(): string {
  const source = readFileSync(JS_CFM, 'utf8').replaceAll('\r\n', '\n');
  const body = source.slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'));
  return body.trimStart().replaceAll('#application.coreversion#', CORE_VERSION);
}

/** An open, permitted leaf category; `fields` overrides any column. */
function category(categoryID: string, name: string, fields: Partial<FeedCategoryNode> = {}): FeedCategoryNode {
  return { categoryID, name, isOpen: 1, permitted: true, hasKids: 0, children: [], ...fields };
}

/** An assignment of `categoryID` to the edited version; `fields` overrides any column. */
function assignment(categoryID: string, isFeature: number, fields: Partial<CategoryAssignRow> = {}): CategoryAssignRow {
  return { categoryID, contentHistID: HIST_ID, isFeature, featureStart: null, featureStop: null, ...fields };
}

/** The tag's markup for `nodes` at nest level 1 with the edited version's `assignments`. */
function render(nodes: readonly FeedCategoryNode[], assignments: readonly CategoryAssignRow[] = []): string {
  const markup = renderFeedCategoriesImportNest({
    nodes,
    nestLevel: 1,
    assignments,
    contentHistId: HIST_ID,
    dateKeyFormat: DATE_KEY_FORMAT,
  });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** Each control by its name less `trim`: an input's value, a select's selected values. */
function state(markup: string, trim: string): Record<string, string | string[]> {
  return Object.fromEntries(
    fragmentModel(markup).controls.map((c) => [c.name.replace(trim, ''), c.tag === 'select' ? c.selected : c.value]),
  );
}

/** The `[value, label]` pairs of the select named `name`. */
function options(markup: string, name: string): [string, string][] {
  const select = fragmentModel(markup).controls.find((c) => c.name === name);
  return (select?.options ?? []).map((o): [string, string] => [o.value, o.label]);
}

/** The markup of one `<li>` item of the tree, wrapped as legacy wraps it. */
const item = (li: string): string => `\n<li>\n<ul>\n<li>${li}\n</li>\n</ul>\n</li>\n`;

describe('cfeedAjaxScripts', () => {
  it('matches cfeed/js.cfm', () => {
    const markup = cfeedAjaxScripts();
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(legacyOutput());

    const $ = cheerio.load(toString(markup), null, false);
    const scripts = $('script').toArray().map((el) => [$(el).attr('src'), $(el).attr('type'), $(el).attr('language')]);
    expect(scripts).toEqual([
      [`assets/js/jquery/jquery.collapsibleCheckboxTree.js?coreversion=${CORE_VERSION}`, 'text/javascript', undefined],
      [`assets/js/feed.min.js?coreversion=${CORE_VERSION}`, 'text/javascript', 'javascript1.2'],
      [`assets/js/searchParams.js?coreversion=${CORE_VERSION}`, 'text/javascript', undefined],
    ]);
  });
});

describe('renderFeedCategoriesImportNest', () => {
  it('renders nothing without categories', () => {
    expect(render([])).toBe('');
  });

  it.each<[string, FeedCategoryNode[], string[]]>([
    ['an encoded closed name and a space', [category(CAT_ID, 'News & <b>', { isOpen: 0 })], ['News &amp; &lt;b&gt; ']],
    ['no added space after a name ending in one', [category(CAT_ID, 'Archive ', { isOpen: false })], ['Archive ']],
    [
      'no children without kids',
      [category(CAT_ID, 'Events', { isOpen: 0, hasKids: 0, children: [category(CHILD_ID, 'Hidden')] })],
      ['Events '],
    ],
    [
      'siblings in order',
      [category(CAT_ID, 'First', { isOpen: 0 }), category(CHILD_ID, 'Second', { isOpen: 0 })],
      ['First ', 'Second '],
    ],
  ])('renders %s', (_, nodes, items) => {
    expect(render(nodes)).toBe(`\n<ul>\n${items.map(item).join('')}\n</ul>\n`);
  });

  it.each([1, true])('renders an open category unassigned with isOpen %j', (isOpen) => {
    const markup = render([category(CAT_ID, 'Open', { isOpen })]);
    expect(markup.slice(0, markup.indexOf('\t\t<dt>'))).toBe(
      [
        '\n<ul>\n\n<li>\n<ul>\n<li>Open',
        `<select  name="categoryAssign${CAT_TRIM}"   ${ONCHANGE}>`,
        '<option selected value="">No</option>',
        '<option  value="0">Yes</option>',
        '<option value="1" >Feature</option>',
        '<option value="2" >Feature Per Start/Stop Dates</option>',
        '</select>',
        `\t  <dl id="editDates${CAT_TRIM}" style="display: none;">\n`,
      ].join('\n'),
    );
    expect(markup.slice(markup.lastIndexOf('</dl>'))).toBe('</dl>\n\n</li>\n</ul>\n</li>\n\n</ul>\n');
    expect(state(markup, CAT_TRIM)).toEqual({ categoryAssign: [''], ...DEFAULTS });

    const hours = Array.from({ length: 12 }, (_, i): [string, string] => [String(i + 1), String(i + 1)]);
    const minutes = Array.from({ length: 60 }, (_, i): [string, string] => [String(i), String(i).padStart(2, '0')]);
    expect(options(markup, `starthour${CAT_TRIM}`)).toEqual(hours);
    expect(options(markup, `stophour${CAT_TRIM}`)).toEqual(hours);
    expect(options(markup, `startMinute${CAT_TRIM}`)).toEqual(minutes);
    expect(options(markup, `stopMinute${CAT_TRIM}`)).toEqual(minutes);
    expect(options(markup, `startDayPart${CAT_TRIM}`)).toEqual([['AM', 'AM'], ['PM', 'PM']]);
    expect(options(markup, `stopDayPart${CAT_TRIM}`)).toEqual([['AM', 'AM'], ['PM', 'PM']]);
  });

  it.each<[string, CategoryAssignRow[], string, string | undefined]>([
    ['No for another version', [assignment(CAT_ID, 1, { contentHistID: OTHER_HIST_ID })], '', 'display: none;'],
    ['No for another category', [assignment(CHILD_ID, 1)], '', 'display: none;'],
    ['Yes for isFeature 0', [assignment(CAT_ID, 0)], '0', 'display: none;'],
    ['Feature for isFeature 1', [assignment(CAT_ID, 1)], '1', 'display: none;'],
    ['Feature Per Start/Stop Dates for isFeature 2', [assignment(CAT_ID, 2)], '2', undefined],
    ['the first matching row', [assignment(CAT_ID, 1), assignment(CAT_ID, 0)], '1', 'display: none;'],
  ])('selects %s', (_, rows, value, style) => {
    const markup = render([category(CAT_ID, 'Open')], rows);
    expect(state(markup, CAT_TRIM)).toEqual({ categoryAssign: [value], ...DEFAULTS });
    expect(cheerio.load(markup, null, false)(`#editDates${CAT_TRIM}`).attr('style')).toBe(style);
  });

  it.each<[string, Date | string, Date | string, Record<string, string | string[]>]>([
    [
      'an afternoon ODBC start and an ISO stop past midnight',
      "{ts '2026-03-05 14:07:00'}",
      '2026-03-06 00:30',
      {
        featureStart: '03/64/2026',
        starthour: ['2'],
        startMinute: ['7'],
        startDayPart: ['PM'],
        featureStop: '03/65/2026',
        stophour: ['12'],
        stopMinute: ['30'],
        stopDayPart: [],
      },
    ],
    [
      'a noon start and a stop before midnight',
      new Date(2026, 0, 1, 12, 0),
      new Date(2026, 11, 31, 23, 59),
      {
        featureStart: '01/01/2026',
        starthour: ['12'],
        startMinute: ['0'],
        startDayPart: ['PM'],
        featureStop: '12/365/2026',
        stophour: ['11'],
        stopMinute: ['59'],
        stopDayPart: ['PM'],
      },
    ],
    [
      'a morning start and a stop past the 50-year date-field cutoff',
      '2026-03-05 09:05',
      new Date(2090, 0, 1, 8, 15),
      {
        featureStart: '03/64/2026',
        starthour: ['9'],
        startMinute: ['5'],
        startDayPart: [],
        featureStop: '01/01/2090',
        stophour: ['8'],
        stopMinute: ['15'],
        stopDayPart: [],
      },
    ],
    ['unparsable dates as the defaults', 'not a date', '', DEFAULTS],
  ])('renders %s', (_, featureStart, featureStop, expected) => {
    const markup = render([category(CAT_ID, 'Open')], [assignment(CAT_ID, 2, { featureStart, featureStop })]);
    expect(state(markup, CAT_TRIM)).toEqual({ categoryAssign: ['2'], ...expected });
    expect(markup).toContain(`<dl id="editDates${CAT_TRIM}" >\n`);
    expect(markup).toContain(`name="featureStart${CAT_TRIM}"   value="${String(expected['featureStart'])}" class=`);
    expect(markup).toContain(`name="featureStop${CAT_TRIM}"  value="${String(expected['featureStop'])}" class=`);
  });

  it.each<[boolean, string, string[]]>([
    [true, `<select  name="categoryAssign${CAT_TRIM}"   ${ONCHANGE}>`, []],
    [
      false,
      `<select  name="categoryAssign${CAT_TRIM}" disabled  ${ONCHANGE}>`,
      ['categoryAssign', 'featureStart', 'starthour', 'startMinute', 'featureStop', 'stopMinute', 'stopDayPart'],
    ],
  ])('disables controls as legacy does when permitted is %s', (permitted, select, disabled) => {
    const markup = render([category(CAT_ID, 'Open', { permitted })]);
    expect(markup).toContain(`<li>Open\n${select}\n`);
    const $ = cheerio.load(markup, null, false);
    expect($('[disabled]').toArray().map((el) => ($(el).attr('name') ?? '').replace(CAT_TRIM, ''))).toEqual(disabled);
  });

  it('nests children under a closed parent with its assignments and date format', () => {
    const parent = category(CAT_ID, 'Parent', { isOpen: 0, hasKids: 1, children: [category(CHILD_ID, 'Child')] });
    const markup = render([parent], [assignment(CHILD_ID, 2, { featureStart: '2026-03-05 14:07' })]);
    expect(markup.slice(0, markup.indexOf('\n<select'))).toBe(
      '\n<ul>\n\n<li>\n<ul>\n<li>Parent \n<ul>\n\n<li>\n<ul>\n<li>Child',
    );
    expect(markup.slice(markup.lastIndexOf('</dl>'))).toBe(
      '</dl>\n\n</li>\n</ul>\n</li>\n\n</ul>\n\n</li>\n</ul>\n</li>\n\n</ul>\n',
    );
    expect(state(markup, CHILD_TRIM)).toEqual({
      ...DEFAULTS,
      categoryAssign: ['2'],
      featureStart: '03/64/2026',
      starthour: ['2'],
      startMinute: ['7'],
      startDayPart: ['PM'],
    });
  });

  it('nests children after the controls of an open parent', () => {
    const child = category(CHILD_ID, 'Child', { isOpen: 0 });
    const markup = render([category(CAT_ID, 'Parent', { hasKids: true, children: [child] })]);
    expect(markup).toContain(`<li>Parent\n<select  name="categoryAssign${CAT_TRIM}"`);
    expect(markup.slice(markup.lastIndexOf('</dl>'))).toBe(
      `</dl>\n\n<ul>\n${item('Child ')}\n</ul>\n\n</li>\n</ul>\n</li>\n\n</ul>\n`,
    );
    expect(state(markup, CAT_TRIM)).toEqual({ categoryAssign: [''], ...DEFAULTS });
  });
});
