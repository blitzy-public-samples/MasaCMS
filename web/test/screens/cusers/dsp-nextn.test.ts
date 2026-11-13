// Unit tests for the cUsers paging model and the records-per-page and pagination partial of `cusers/inc/dsp_nextn.cfm`.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { normaliseCusersRc, type CusersRc } from '@/screens/cusers/gate';
import {
  getNextN,
  legacyPageIndex,
  renderNextN,
  type NextN,
  type NextNInput,
} from '@/screens/cusers/inc/dsp_nextn';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';

type NextNRc = NextNInput['rc'];

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** Include output cut from legacy ACF 2023 `cUsers.listusers` and `cUsers.list` pages (admin, siteid=default). */
const fixture = (path: string): string => readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8');

const RC: NextNRc = { siteid: 'default', ispublic: '0', unassigned: '0', recordsperpage: 25 };
const LIST_USERS = 'core:cusers.listusers';

/** Renders as the cUsers controller pages `total` records: start row reset past the end, page buffer 3. */
function render(total: number, rc: Partial<NextNRc>, startRow: number, muraAction = LIST_USERS): string {
  const ctx = { ...RC, ...rc };
  const start = startRow > total ? 1 : startRow;
  const markup = renderNextN({
    nextn: getNextN(total, ctx.recordsperpage, start, 3),
    pageIndex: legacyPageIndex(start, ctx.recordsperpage, total),
    rc: ctx,
    muraAction,
    rb: rbFor('en'),
  });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** Field values in `NextN` declaration order. */
type NextNRow = [number, number, number, number, number, number, number, number, number, number];

function nextn([total, rpp, pages, current, first, last, next, previous, through, startRow]: NextNRow): NextN {
  return {
    totalRecords: total,
    recordsPerPage: rpp,
    numberOfPages: pages,
    currentPageNumber: current,
    firstPage: first,
    lastPage: last,
    next,
    previous,
    through,
    startRow,
  };
}

describe('getNextN', () => {
  it.each<[string, [number, number, number, number?], NextNRow]>([
    ['no records', [0, 25, 1, 3], [0, 25, 0, 1, 1, 0, 1, 1, 0, 1]],
    ['the first of four pages', [100, 25, 1, 3], [100, 25, 4, 1, 1, 4, 26, 1, 25, 1]],
    ['a start row inside the first page', [100, 25, 3], [100, 25, 4, 1, 1, 4, 26, 1, 25, 3]],
    ['an unaligned start row', [30, 25, 2, 3], [30, 25, 2, 1, 1, 2, 26, 1, 25, 2]],
    ['page 6 of 10', [100, 10, 51, 3], [100, 10, 10, 6, 3, 9, 61, 41, 60, 51]],
    ['the last of ten pages', [95, 10, 91, 3], [95, 10, 10, 10, 4, 10, 1, 81, 95, 91]],
    ['the default buffer of 5', [200, 10, 101], [200, 10, 20, 11, 6, 16, 111, 91, 110, 101]],
    ['a middle page with buffer 3', [1000, 10, 50, 3], [1000, 10, 100, 5, 2, 8, 51, 31, 50, 50]],
    ['a short last page', [7, 5, 2], [7, 5, 2, 1, 1, 2, 6, 1, 5, 2]],
    ['the last page, next reset to 1 and through at the total', [30, 25, 26, 3], [30, 25, 2, 2, 1, 2, 1, 1, 30, 26]],
    [
      'the end of a long list, window widened backwards',
      [1000, 10, 995, 3],
      [1000, 10, 100, 100, 94, 100, 1, 981, 1000, 995],
    ],
  ])('computes %s as CFML does', (_case, [total, rpp, start, buffer], expected) => {
    expect(getNextN(total, rpp, start, buffer)).toEqual(nextn(expected));
  });
});

describe('legacyPageIndex', () => {
  it.each<[number, number, number, number]>([
    [3, 10, 15, 1],
    [2, 10, 15, 2],
    [3, 10, 20, 3],
    [1, 25, 0, 1],
    [1, 25, 100, 1],
    [3, 25, 100, 3],
    // queryIterator.cfc 222: a record index equal to the total is not past it.
    [5, 25, 100, 5],
    [6, 25, 100, 1],
    [2, 25, 0, 1],
  ])('start row %d, %d per page, %d records gives page %d', (startRow, rpp, total, page) => {
    expect(legacyPageIndex(startRow, rpp, total)).toBe(page);
  });
});

describe('renderNextN', () => {
  it.each<[string, string, Partial<NextNRc>, number, string]>([
    ['the first of two pages', 'people/cusers-listusers-nextn-first.html', { recordsperpage: 1 }, 1, LIST_USERS],
    ['the last of two pages', 'people/cusers-listusers-nextn-last.html', { recordsperpage: 1 }, 2, LIST_USERS],
    ['all records on one page', 'people/cusers-listusers-nextn-all.html', { recordsperpage: 100000 }, 1, LIST_USERS],
    ['the group list on one page', 'identity/cusers-list-nextn-single.html', {}, 1, 'core:cusers.list'],
  ])('matches the legacy include byte for byte on %s', (_case, path, rc, startRow, muraAction) => {
    expect(render(2, rc, startRow, muraAction)).toBe(fixture(path));
  });

  it('renders nothing without a nextn', () => {
    const markup = renderNextN({ pageIndex: 1, rc: RC, muraAction: 'core:cusers.list', rb: rbFor('en') });
    expect(toString(markup)).toBe('');
  });

  it('pages by start row as page number, keeping the window of the start row', () => {
    const $ = cheerio.load(render(100, { recordsperpage: 10 }, 5), null, false);
    const links = $('ul.pagination a')
      .toArray()
      .map((a) => [$(a).attr('data-pageno'), $(a).attr('class'), $(a).text().trim()]);
    expect(links).toEqual([
      ['4', 'pageNo', ''],
      ['1', 'pageNo', '1'],
      ['2', 'pageNo', '2'],
      ['3', 'pageNo', '3'],
      ['4', 'pageNo', '4'],
      ['5', 'pageNo', '5'],
      ['6', 'pageNo', '6'],
      ['7', 'pageNo', '7'],
      ['6', 'pageNo', ''],
    ]);
    expect($('ul.pagination li.active').text().trim()).toBe('5');
    expect($('ul.pagination li.hidden')).toHaveLength(0);
    expect($('ul.next-n li.active').text()).toBe('10');
    expect($('input[name="startrow"]').attr('value')).toBe('5');
  });

  it('shows no pagination for one page and resets a start row past the end', () => {
    const $ = cheerio.load(render(3, {}, 40), null, false);
    expect($('ul.pagination')).toHaveLength(0);
    expect($('input[name="startrow"]').attr('value')).toBe('1');
    expect($('ul.next-n li.active a').attr('data-nextn')).toBe('25');
  });

  it('attribute-encodes the action and context fields and keeps the bundle labels as written', () => {
    const rb = { locale: 'en', rbKey: (key: string) => `<b>${key}</b>`, messageFormat: () => '' };
    const markup = toString(
      renderNextN({
        nextn: getNextN(10, 25, 1, 3),
        pageIndex: 1,
        rc: { siteid: 'a b&"c', ispublic: '1', unassigned: 'true', recordsperpage: 7 },
        muraAction: LIST_USERS,
        rb,
      }),
    );
    expect(markup).toContain('name="muraAction" value="core&#x3a;cusers.listusers"');
    expect(markup).toContain('name="siteid" value="a&#x20;b&amp;&quot;c"');
    const $ = cheerio.load(markup, null, false);
    const hidden = $('input[type="hidden"]')
      .toArray()
      .map((input) => [$(input).attr('name'), $(input).attr('value')]);
    expect(hidden).toEqual([
      ['muraAction', LIST_USERS],
      ['siteid', 'a b&"c'],
      ['ispublic', '1'],
      ['unassigned', 'true'],
      ['recordsperpage', '25'],
      ['startrow', '1'],
    ]);
    expect($('a.dropdown-toggle b').text()).toBe('user.recordsperpage');
    expect($('a[data-nextn="100000"] b').text()).toBe('user.all');
    expect($('ul.next-n li.active')).toHaveLength(0);
  });
});

/** The context `before()` leaves for a tenant-a admin on system users at 10 per page. */
function listUsersRc(rc: Readonly<Record<string, string>> = {}): CusersRc {
  return normaliseCusersRc(
    siteAdminRequest('tenant-a', {
      circuit: 'cusers',
      item: 'listusers',
      rc: { ispublic: '0', unassigned: '0', recordsperpage: '10', ...rc },
    }),
  );
}

function renderPage(nextn: NextN, pageIndex: number, rc: CusersRc = listUsersRc()): string {
  const markup = renderNextN({ nextn, pageIndex, rc, muraAction: 'cUsers.listusers', rb: rbFor('en') });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** `[li class, data-pageno, link class, link text]` of each pagination item. */
function paginationItems(out: string): string[][] {
  const $ = cheerio.load(out, null, false);
  return $('ul.pagination.pull-right > li')
    .toArray()
    .map((li) => {
      const a = $(li).children('a');
      return [$(li).attr('class') ?? '', a.attr('data-pageno') ?? '<none>', a.attr('class') ?? '', a.text().trim()];
    });
}

describe('renderNextN on cUsers.listusers', () => {
  const page6 = (): string => renderPage(getNextN(100, 10, 51, 3), 6);

  it('posts the paging form with the context fields in order', () => {
    const out = page6();
    const $ = cheerio.load(out, null, false);
    expect($('form#frmNextN')[0]?.attribs).toEqual({ id: 'frmNextN', action: '', method: 'post' });
    expect(fragmentModel(out).controls.map(({ tag, name, type, value }) => ({ tag, name, type, value }))).toEqual([
      { tag: 'input', name: 'muraAction', type: 'hidden', value: 'cUsers.listusers' },
      { tag: 'input', name: 'siteid', type: 'hidden', value: 'tenant-a' },
      { tag: 'input', name: 'ispublic', type: 'hidden', value: '0' },
      { tag: 'input', name: 'unassigned', type: 'hidden', value: '0' },
      { tag: 'input', name: 'recordsperpage', type: 'hidden', value: '10' },
      { tag: 'input', name: 'startrow', type: 'hidden', value: '51' },
    ]);
  });

  it('binds the size and page links to the form with a single #', () => {
    const $ = cheerio.load(page6(), null, false);
    expect($('script')).toHaveLength(1);
    const script = $('script').text();
    expect([...script.matchAll(/\$\('([^']*)'\)/g)].map((m) => m[1])).toEqual([
      'a.nextN',
      'form#frmNextN input[name="recordsperpage"]',
      'form#frmNextN input[name="pageno"]',
      'form#frmNextN',
      'a.pageNo',
      'form#frmNextN input[name="startrow"]',
      'form#frmNextN',
    ]);
    expect(script).not.toContain('##');
  });

  it('offers the page sizes with the current one active', () => {
    const $ = cheerio.load(page6(), null, false);
    expect($('a.dropdown-toggle').text().trim()).toBe('Records Per Page');
    const items = $('ul.dropdown-menu.next-n.pull-right > li')
      .toArray()
      .map((li) => {
        const a = $(li).children('a.nextN');
        return [$(li).attr('class') ?? '', a.attr('data-nextn'), a.text()];
      });
    expect(items).toEqual([
      ['', '5', '5'],
      ['active', '10', '10'],
      ['', '25', '25'],
      ['', '50', '50'],
      ['', '100', '100'],
      ['', '250', '250'],
      ['', '500', '500'],
      ['', '1000', '1000'],
      ['', '100000', 'All'],
    ]);
  });

  it('links pages 3 to 9 around page 6', () => {
    const out = page6();
    expect(paginationItems(out)).toEqual([
      ['pageNo', '5', 'pageNo', ''],
      ['', '3', 'pageNo', '3'],
      ['', '4', 'pageNo', '4'],
      ['', '5', 'pageNo', '5'],
      ['active', '6', 'pageNo', '6'],
      ['', '7', 'pageNo', '7'],
      ['', '8', 'pageNo', '8'],
      ['', '9', 'pageNo', '9'],
      ['pageNo', '7', 'pageNo', ''],
    ]);
    expect(fragmentModel(out).links).toEqual(
      ['Records Per Page', '5', '10', '25', '50', '100', '250', '500', '1000', 'All', '']
        .concat(['3', '4', '5', '6', '7', '8', '9', ''])
        .map((text) => ({ href: '#', text })),
    );
  });

  it('hides the previous link on page 1', () => {
    const items = paginationItems(renderPage(getNextN(100, 10, 1, 3), 1));
    expect(items[0]).toEqual(['hidden', '', 'hidden', '']);
    expect(items[1]).toEqual(['active', '1', 'pageNo', '1']);
    expect(items.at(-1)).toEqual(['pageNo', '2', 'pageNo', '']);
  });

  it('hides the next link on the last page', () => {
    const items = paginationItems(renderPage(getNextN(100, 10, 91, 3), 10));
    expect(items[0]).toEqual(['pageNo', '9', 'pageNo', '']);
    expect(items.slice(1, -1).map(([cls, page]) => [cls, page])).toEqual([
      ['', '4'],
      ['', '5'],
      ['', '6'],
      ['', '7'],
      ['', '8'],
      ['', '9'],
      ['active', '10'],
    ]);
    expect(items.at(-1)).toEqual(['hidden', '', 'hidden', '']);
  });

  it('renders the form and sizes but no pagination for one page', () => {
    const $ = cheerio.load(renderPage(getNextN(10, 25, 1, 3), 1), null, false);
    expect($('ul.pagination')).toHaveLength(0);
    expect($('form#frmNextN > input[type="hidden"]')).toHaveLength(6);
    expect($('ul.dropdown-menu.next-n a.nextN')).toHaveLength(9);
  });

  it('attribute-encodes the site id', () => {
    const out = renderPage(getNextN(100, 10, 51, 3), 6, listUsersRc({ siteid: 'a"b<c' }));
    expect(out).toContain('<input type="hidden" name="siteid" value="a&quot;b&lt;c">');
    expect(fragmentModel(out).controls.find((c) => c.name === 'siteid')).toMatchObject({ value: 'a"b<c' });
  });
});

