import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dateKeyFor, formatDateField } from '@/lib/dates';
import { isSafeHtml, raw, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderCategoryUsage, type CategoryUsageRow } from '@/screens/ccategory/dsp-tab-usage';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';

const rb = rbFor('en_US');
const { dateKeyFormat } = dateKeyFor('en_US');

const ZOOM = '<ul class="navZoom"><li>Home &raquo;</li><li><strong>News &amp; Events</strong></li></ul>';
const SCHEDULE = Object.freeze({ start: '2026-10-29 00:00:00', stop: '2026-10-30 00:00:00' });

const ROW: CategoryUsageRow = {
  contentID: 'C1000000-0000-0000-0000000000000001',
  contentHistID: 'C2000000-0000-0000-0000000000000001',
  type: 'Page',
  parentID: '00000000000000000000000000000000001',
  siteID: 'tenant-a',
  moduleID: '00000000000000000000000000000000000',
  display: 1,
  approved: true,
  displayStart: null,
  displayStop: null,
  lastUpdate: '2026-10-29 09:30:00',
  verdict: 'editor',
  zoom: raw(ZOOM),
};

const QUERY =
  '&contentid=C1000000-0000-0000-0000000000000001&type=Page&parentid=00000000000000000000000000000000001' +
  '&topid=C1000000-0000-0000-0000000000000001&siteid=tenant-a&moduleid=00000000000000000000000000000000000';
const EDIT_HREF = `./?muraAction=cArch.edit&contenthistid=C2000000-0000-0000-0000000000000001${QUERY}`;
const HISTORY_HREF = `./?muraAction=cArch.hist${QUERY}`;
const LINKED_ITEMS =
  `<li class="edit"><a title="Edit" href="${EDIT_HREF}"><i class="mi-pencil"></i></a></li>` +
  `<li class="version-history"><a title="Version History" href="${HISTORY_HREF}"><i class="mi-history"></i></a></li>`;
const DISABLED_ITEMS = '<li class="edit disabled">Edit</li><li class="version-history disabled">Version History</li>';

const HEAD = [
  '<div class="page_aTab">',
  '<dl class="oneColumn">',
  '<dt class="first">This item is used in the following locations:</dt>',
  ' <table class="mura-table-grid">',
  '    <tr>',
  '      <th class="var-width">Title</th>',
  '      <th>Display</th>',
  '      <th>Update</th>',
  '      <th class="actions">&nbsp;</th>',
  '    </tr>',
].join('\n');
const TAIL = ['  </table>', '</td></tr></table>', '</dl>', '</div>'].join('\n');

/** Rendered markup of the usage tab for `rows`. */
function render(rows: readonly CategoryUsageRow[]): string {
  const markup = renderCategoryUsage({ rows, rb, dateKeyFormat });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** Cell texts of the only usage row. */
function rowCells(row: CategoryUsageRow): readonly string[] | undefined {
  return fragmentModel(render([row])).tables[0]?.rows[0];
}

/** Inner markup of the display cell of the only row. */
function displayCell(markup: string): string | undefined {
  return /<td>\n {12}([^]*?)<\/td>/.exec(markup)?.[1];
}

/** Inner markup of the actions list of the only row. */
function actionList(markup: string): string | undefined {
  return /<td class="actions"><ul>([^]*?)<\/ul><\/td><\/tr>/.exec(markup)?.[1];
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('renderCategoryUsage', () => {
  it('renders the no-usage row with its legacy class typo when nothing uses the category', () => {
    const body = ['', '      <tr>', '        <td colspan="7" cl<ass="noResults">This category is currently not being used.</td>', '      </tr>'];
    expect(render([])).toBe(`${HEAD}${body.join('\n')}\n${TAIL}`);
  });

  it('renders a usage row with relative admin links', () => {
    const row = [
      '',
      '        <tr>',
      `          <td class="var-width">${ZOOM}</td>`,
      '          <td>',
      '            Yes</td>',
      '          <td>10/302/2026</td>',
      `          <td class="actions"><ul>${LINKED_ITEMS}</ul></td></tr>`,
    ];
    expect(render([ROW])).toBe(`${HEAD}${row.join('\n')}\n${TAIL}`);
  });

  it('renders the tab frame and header row', () => {
    const markup = render([ROW]);
    const $ = cheerio.load(markup, null, false);
    expect($('div.page_aTab > dl.oneColumn > dt.first').text()).toBe('This item is used in the following locations:');
    expect($('div.page_aTab > dl.oneColumn > table.mura-table-grid')).toHaveLength(1);
    expect($('th').toArray().map((th) => $(th).attr('class') ?? '')).toEqual(['var-width', '', '', 'actions']);
    expect(fragmentModel(markup).tables[0]?.headers).toEqual(['Title', 'Display', 'Update', '']);
  });

  it('emits row parameters unencoded in both action links', () => {
    const markup = render([{ ...ROW, siteID: 'my site&x=1' }]);
    expect(markup.split('&siteid=my site&x=1&moduleid=')).toHaveLength(3);
  });

  it('formats dates with the session mask, day-of-year included', () => {
    const cells = rowCells({ ...ROW, display: 2, displayStart: SCHEDULE.start, displayStop: SCHEDULE.stop });
    const displayWindow = `${formatDateField(SCHEDULE.start, dateKeyFormat)} - ${formatDateField(SCHEDULE.stop, dateKeyFormat)}`;
    expect(cells?.[1]).toBe(displayWindow);
    expect(cells?.[1]).toContain('10/302/2026');
    expect(cells?.[2]).toBe(formatDateField(ROW.lastUpdate, dateKeyFormat));
    expect(cells?.[2]).toBe('10/302/2026');
  });

  it('leaves the update cell empty without a last update', () => {
    expect(rowCells({ ...ROW, lastUpdate: null })?.[2]).toBe('');
  });

  it.each<[string, string]>([
    ['editor', LINKED_ITEMS],
    ['author', LINKED_ITEMS],
    ['read', LINKED_ITEMS],
    ['none', DISABLED_ITEMS],
    ['None', DISABLED_ITEMS],
    ['NONE', DISABLED_ITEMS],
  ])('renders the actions of verdict %s', (verdict, expected) => {
    expect(actionList(render([{ ...ROW, verdict }]))).toBe(expected);
  });

  it.each<[string, Pick<CategoryUsageRow, 'display' | 'approved' | 'displayStart' | 'displayStop'>, string]>([
    ['displayed and approved', { display: 1, approved: true, displayStart: null, displayStop: null }, 'Yes'],
    ['displayed and approved as 1', { display: 1, approved: 1, displayStart: null, displayStop: null }, 'Yes'],
    ['displayed but unapproved', { display: 1, approved: false, displayStart: null, displayStop: null }, 'No'],
    ['displayed but unapproved as 0', { display: 1, approved: 0, displayStart: null, displayStop: null }, 'No'],
    [
      'scheduled and approved',
      { display: 2, approved: true, displayStart: SCHEDULE.start, displayStop: SCHEDULE.stop },
      '10/302/2026 - 10/303/2026',
    ],
    [
      'scheduled without a stop date',
      { display: 2, approved: 1, displayStart: '2026-01-15 00:00:00', displayStop: null },
      '01/15/2026 - ',
    ],
    [
      'scheduled but unapproved',
      { display: 2, approved: false, displayStart: SCHEDULE.start, displayStop: SCHEDULE.stop },
      'No',
    ],
    ['hidden', { display: 0, approved: true, displayStart: null, displayStop: null }, 'No'],
  ])('renders the display cell when %s', (_, fields, expected) => {
    expect(displayCell(render([{ ...ROW, ...fields }]))).toBe(expected);
  });
});
