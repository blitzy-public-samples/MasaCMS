// Unit tests for the cfeed `dsp_tab_usage` Usage Report pane.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderFeedUsageTab, type FeedUsageRequest, type FeedUsageRow } from '@/screens/cfeed/tab-usage';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';

const en = rbFor('en');

/** Answers `<b>key</b>` for every key. */
const marked: RbLookup = {
  locale: 'en_US',
  rbKey: (key) => `<b>${key}</b>`,
  messageFormat: (pattern) => pattern,
};

const ZOOM = '<ul class="navZoom"><li>Home &raquo; News</li></ul>';

const ROW: FeedUsageRow = {
  contentHistID: 'H2000000-0000-0000-0000000000000001',
  contentID: 'C2000000-0000-0000-0000000000000001',
  type: 'Page',
  parentID: '00000000000000000000000000000000001',
  siteID: 'my site&x=1',
  moduleID: '00000000000000000000000000000000000',
  display: 1,
  approved: 1,
  displayStart: null,
  displayStop: null,
  lastUpdate: '2026-01-15 09:30:00',
  zoom: ZOOM,
  verdict: 'editor',
};

const TARGET =
  '&contentid=C2000000-0000-0000-0000000000000001&type=Page&parentid=00000000000000000000000000000000001' +
  '&topid=C2000000-0000-0000-0000000000000001&siteid=my site&x=1&moduleid=00000000000000000000000000000000000';
const EDIT_HREF = `./?muraAction=cArch.edit&contenthistid=H2000000-0000-0000-0000000000000001${TARGET}`;
const HISTORY_HREF = `./?muraAction=cArch.hist${TARGET}`;
/** The linked edit and version-history items; `editSuffix` is the edit link's compactDisplay and homeID query. */
const linkedItems = (editSuffix: string): string =>
  `<li class="edit"><a href="${EDIT_HREF}${editSuffix}"><i class="mi-pencil"></i>Edit</a></li>` +
  `<li class="version-history"><a href="${HISTORY_HREF}"><i class="mi-history"></i>Version History</a></li>`;
const LINKED_ITEMS = linkedItems('&compactDisplay=false&homeID=');
const DISABLED_ITEMS = '<li class="edit disabled">Edit</li><li class="version-history disabled">Version History</li>';

/** An admin request on `cfeed.edit` with `partial` laid over it. */
function request(partial: AdminRequestPartial = {}): FeedUsageRequest {
  return makeAdminRequest({ circuit: 'cfeed', item: 'edit', ...partial }, 'admin');
}

/** The pane markup for `rows` of a `feedType` collection. */
function render(
  rows: readonly FeedUsageRow[],
  { req = request(), rb = en, feedType = 'Local' }: { req?: FeedUsageRequest; rb?: RbLookup; feedType?: string } = {},
): string {
  const tab = renderFeedUsageTab(req, rb, { feedType, rows });
  expect(isSafeHtml(tab.html)).toBe(true);
  return toString(tab.html);
}

/** Inner markup of the actions list of the first row. */
const actionList = (markup: string): string | undefined =>
  /<ul class="actions-list">([^]*?)<\/ul><\/div><\/td>/.exec(markup)?.[1];

/** Inner markup of the display cell of the first row. */
const displayCell = (markup: string): string | undefined => /<td>\n\t{5} {4}([^]*?)<\/td>/.exec(markup)?.[1];

/** Inner markup of the last-update cell of the first row. */
const updateCell = (markup: string): string | undefined => /\t{6}<td>([^]*?)<\/td>\n/.exec(markup)?.[1];

describe('renderFeedUsageTab', () => {
  it('returns the tab id, the bundle label and the literal block title', () => {
    const tab = renderFeedUsageTab(request(), marked, { feedType: 'Local', rows: [] });
    const $ = cheerio.load(toString(tab.html));
    expect(tab.tabId).toBe('tabUsagereport');
    expect(tab.label).toBe('<b>collections.usagereport</b>');
    expect($('div#tabUsagereport.tab-pane')).toHaveLength(1);
    expect($('#tabUsagereport > .block.block-bordered > .block-header > h3.block-title').text()).toBe('Usage Report');
    expect(renderFeedUsageTab(request(), en, { feedType: 'Local', rows: [] }).label).toBe('Usage Report');
  });

  it.each<[string, string]>([
    ['Local', 'This index is currently not being used.'],
    ['local', 'This index is currently not being used.'],
    ['LOCAL', 'This index is currently not being used.'],
    ['Remote', 'This feed is currently not being used.'],
    ['', 'This feed is currently not being used.'],
  ])('renders the empty notice of a %s collection', (feedType, notice) => {
    const $ = cheerio.load(render([], { feedType }));
    expect($('.block-content > .mura-control-group > div.help-block-empty').text()).toBe(notice);
    expect($('table')).toHaveLength(0);
  });

  it('renders the usage label, headers and one row per usage in order', () => {
    const second = { ...ROW, contentID: 'C2000000-0000-0000-0000000000000002', zoom: '<ul class="navZoom"></ul>' };
    const markup = render([ROW, second], { feedType: 'Remote' });
    const $ = cheerio.load(markup);
    expect($('.mura-control-group > .mura-control.justify > label').text()).toBe(
      'This item is used in the following locations:',
    );
    const table = $('.mura-control.justify > table#metadata.mura-table-grid');
    expect(table).toHaveLength(1);
    expect(table.find('tr th').map((_, th) => $(th).text()).get()).toEqual(['', 'Title', 'Display', 'Update']);
    expect(table.find('tr:has(td)')).toHaveLength(2);
    expect($('.help-block-empty')).toHaveLength(0);
    expect(markup.indexOf(`<td class="var-width">${ZOOM}</td>`)).toBeGreaterThan(-1);
    expect(markup.indexOf(`<td class="var-width">${ZOOM}</td>`)).toBeLessThan(
      markup.indexOf('<td class="var-width"><ul class="navZoom"></ul></td>'),
    );
  });

  it('emits bundle labels unencoded', () => {
    const markup = render([{ ...ROW, verdict: 'none' }], { rb: marked });
    expect(markup).toContain('<label><b>collections.usagetext</b>:</label>');
    expect(markup).toContain('<th class="var-width"><b>collections.title</b></th>');
    expect(markup).toContain('<th><b>collections.display</b></th>');
    expect(markup).toContain('<th><b>collections.update</b></th>');
    expect(actionList(markup)).toBe(
      '<li class="edit disabled"><b>collections.edit</b></li>' +
        '<li class="version-history disabled"><b>collections.versionhistory</b></li>',
    );
    expect(render([], { rb: marked, feedType: 'Remote' })).toContain(
      '<div class="help-block-empty"><b>collections.nofeedusage</b></div>',
    );
  });

  it.each<[string, string]>([
    ['editor', LINKED_ITEMS],
    ['author', LINKED_ITEMS],
    ['read', LINKED_ITEMS],
    ['none', DISABLED_ITEMS],
    ['None', DISABLED_ITEMS],
    ['NONE', DISABLED_ITEMS],
  ])('renders the actions of verdict %s', (verdict, items) => {
    expect(actionList(render([{ ...ROW, verdict }]))).toBe(items);
  });

  it.each<[string, AdminRequestPartial['rc'], string]>([
    ['plain values', { compactDisplay: 'true', homeID: 'H1' }, '&compactDisplay=true&homeID=H1'],
    [
      'values needing encoding',
      { compactDisplay: 'a"b', homeid: '<h>&1' },
      '&compactDisplay=a&quot;b&homeID=&lt;h&gt;&amp;1',
    ],
  ])('html-encodes compactDisplay and homeID into the edit link with %s', (_, rc, suffix) => {
    expect(actionList(render([ROW], { req: request({ rc }) }))).toBe(linkedItems(suffix));
  });

  it.each<[string, Pick<FeedUsageRow, 'display' | 'approved' | 'displayStart' | 'displayStop'>, string]>([
    ['displayed and approved', { display: 1, approved: 1, displayStart: null, displayStop: null }, 'Yes'],
    [
      'displayed and approved as strings',
      { display: '1', approved: 'true', displayStart: null, displayStop: null },
      'Yes',
    ],
    ['displayed but unapproved', { display: 1, approved: 0, displayStart: null, displayStop: null }, 'No'],
    ['displayed with a NULL approval', { display: 1, approved: null, displayStart: null, displayStop: null }, 'No'],
    [
      'scheduled and approved',
      { display: 2, approved: true, displayStart: '2026-01-15 00:00:00', displayStop: '2026-10-29 00:00:00' },
      '01/15/2026 - 10/302/2026',
    ],
    [
      'scheduled past the 50-year blanking window',
      { display: 2, approved: 1, displayStart: '2026-02-20 00:00:00', displayStop: '2126-03-01 00:00:00' },
      '02/51/2026 - 03/60/2126',
    ],
    [
      'scheduled without a stop date',
      { display: 2, approved: 1, displayStart: '2026-01-15 00:00:00', displayStop: null },
      '01/15/2026 - ',
    ],
    [
      'scheduled but unapproved',
      { display: 2, approved: 0, displayStart: '2026-01-15 00:00:00', displayStop: '2026-02-20 00:00:00' },
      'No',
    ],
    ['hidden', { display: 0, approved: 1, displayStart: null, displayStop: null }, 'No'],
    ['without a display flag', { display: null, approved: 1, displayStart: null, displayStop: null }, 'No'],
  ])('renders the display cell when %s', (_, fields, expected) => {
    expect(displayCell(render([{ ...ROW, ...fields }]))).toBe(expected);
  });

  it.each<[string, string | null, string]>([
    ['en_US', '2026-01-15 09:30:00', '01/15/2026'],
    ['en_US', '2026-10-29 09:30:00', '10/302/2026'],
    ['en_US', "{ts '2026-12-31 23:59:59'}", '12/365/2026'],
    ['en_GB', '2026-10-29 09:30:00', '302/10/2026'],
    ['en_US', null, ''],
  ])('formats the last update under the %s date mask: %s', (locale, lastUpdate, expected) => {
    expect(updateCell(render([{ ...ROW, lastUpdate }], { req: request({ session: { locale } }) }))).toBe(expected);
  });
});
