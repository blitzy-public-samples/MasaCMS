import { describe, expect, it } from 'vitest';
import { isSafeHtml, raw, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderCategoryUsage, type CategoryUsageRow } from '@/screens/ccategory/dsp-tab-usage';

const rb = rbFor('en');
const DATE_KEY_FORMAT = 'MM/DD/YYYY';

const ROW: CategoryUsageRow = {
  contentID: 'C1000000-0000-0000-0000000000000001',
  contentHistID: 'H1000000-0000-0000-0000000000000001',
  type: 'Page',
  parentID: '00000000000000000000000000000000001',
  siteID: 'my site&x=1',
  moduleID: '00000000000000000000000000000000000',
  display: 1,
  approved: true,
  displayStart: null,
  displayStop: null,
  lastUpdate: '2026-01-15 09:30:00',
  verdict: 'editor',
  zoom: raw('<ul class="navZoom"><li>Home</li></ul>'),
};

const QUERY =
  '&contentid=C1000000-0000-0000-0000000000000001&type=Page&parentid=00000000000000000000000000000000001' +
  '&topid=C1000000-0000-0000-0000000000000001&siteid=my site&x=1&moduleid=00000000000000000000000000000000000';
const EDIT_HREF = `./?muraAction=cArch.edit&contenthistid=H1000000-0000-0000-0000000000000001${QUERY}`;
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
  const markup = renderCategoryUsage({ rows, rb, dateKeyFormat: DATE_KEY_FORMAT });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** Inner markup of the display cell of the only row. */
function displayCell(markup: string): string | undefined {
  return /<td>\n {12}([^]*?)<\/td>/.exec(markup)?.[1];
}

/** Inner markup of the actions list of the only row. */
function actionList(markup: string): string | undefined {
  return /<td class="actions"><ul>([^]*?)<\/ul><\/td><\/tr>/.exec(markup)?.[1];
}

describe('renderCategoryUsage', () => {
  it('renders the no-usage row with its legacy class typo when nothing uses the category', () => {
    const body = ['', '      <tr>', '        <td colspan="7" cl<ass="noResults">This category is currently not being used.</td>', '      </tr>'];
    expect(render([])).toBe(`${HEAD}${body.join('\n')}\n${TAIL}`);
  });

  it('renders a usage row with unencoded relative admin links', () => {
    const row = [
      '',
      '        <tr>',
      '          <td class="var-width"><ul class="navZoom"><li>Home</li></ul></td>',
      '          <td>',
      '            Yes</td>',
      '          <td>01/15/2026</td>',
      `          <td class="actions"><ul>${LINKED_ITEMS}</ul></td></tr>`,
    ];
    expect(render([ROW])).toBe(`${HEAD}${row.join('\n')}\n${TAIL}`);
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
    ['displayed but unapproved', { display: 1, approved: 0, displayStart: null, displayStop: null }, 'No'],
    [
      'scheduled and approved',
      { display: 2, approved: true, displayStart: '2026-01-15 00:00:00', displayStop: '2026-02-20 00:00:00' },
      '01/15/2026 - 02/51/2026',
    ],
    [
      'scheduled without a stop date',
      { display: 2, approved: 1, displayStart: '2026-01-15 00:00:00', displayStop: null },
      '01/15/2026 - ',
    ],
    [
      'scheduled but unapproved',
      { display: 2, approved: false, displayStart: '2026-01-15 00:00:00', displayStop: '2026-02-20 00:00:00' },
      'No',
    ],
    ['hidden', { display: 0, approved: true, displayStart: null, displayStop: null }, 'No'],
  ])('renders the display cell when %s', (_, fields, expected) => {
    expect(displayCell(render([{ ...ROW, ...fields }]))).toBe(expected);
  });
});
