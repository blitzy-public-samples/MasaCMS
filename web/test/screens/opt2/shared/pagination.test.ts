// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import * as cheerio from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { encodeHtmlAttr, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { pagination, readPage } from '@/screens/opt2/shared';

const ctx = { rb: rbFor('en') };
const href = (page: number): string => `/opt2/admin/m/list?siteid=a&b&page=${page}`;

/** The pager's meta text, then each item as `<`/`>` for an arrow, `[n]` for the current page and `n` for a link. */
function itemsOf(markup: string): string[] {
  const $ = cheerio.load(markup, null, false);
  const items = $('ul.pagination.pull-right > li')
    .toArray()
    .map((li) => {
      const $li = $(li);
      const icon = $li.find('i').attr('class');
      if (icon !== undefined) return icon === 'mi-angle-left' ? '<' : '>';
      return $li.hasClass('active') ? `[${$li.text()}]` : $li.text();
    });
  return [$('p.clearfix.search-showing').text(), ...items];
}

describe('pagination', () => {
  it.each([
    { name: 'the first of 3 pages', total: 120, page: 1, items: ['Showing 1-50 of 120 Results', '[1]', '2', '3', '>'] },
    { name: 'a middle page', total: 120, page: 2, items: ['Showing 51-100 of 120 Results', '<', '1', '[2]', '3', '>'] },
    { name: 'the last, partial page', total: 101, page: 3, items: ['Showing 101-101 of 101 Results', '<', '1', '2', '[3]'] },
    { name: 'page 1 of 20, eleven numbers', total: 1000, page: 1, items: ['Showing 1-50 of 1,000 Results', '[1]', ...range(2, 11), '>'] },
    { name: 'page 6 of 20, the window still from 1', total: 1000, page: 6, items: ['Showing 251-300 of 1,000 Results', '<', ...range(1, 5), '[6]', ...range(7, 11), '>'] },
    { name: 'page 7 of 20, the window moved on', total: 1000, page: 7, items: ['Showing 301-350 of 1,000 Results', '<', ...range(2, 6), '[7]', ...range(8, 12), '>'] },
    { name: 'page 16 of 20, the window held at the end', total: 1000, page: 16, items: ['Showing 751-800 of 1,000 Results', '<', ...range(10, 15), '[16]', ...range(17, 20), '>'] },
    { name: 'the last of 20 pages', total: 1000, page: 20, items: ['Showing 951-1000 of 1,000 Results', '<', ...range(10, 19), '[20]'] },
  ])('renders $name as the legacy numbered pager', ({ total, page, items }) => {
    const markup = pagination(ctx, { page, totalRecords: total, recordsPerPage: 50, href });

    expect(markup).not.toBeNull();
    expect(itemsOf(toString(markup!))).toEqual(items);
  });

  it('links the named neighbours and every other number, the current one to #, inside a cleared row', () => {
    const markup = toString(pagination(ctx, { page: 2, totalRecords: 120, recordsPerPage: 50, href })!);
    const link = (page: number, label?: string): string =>
      `<a href="${encodeHtmlAttr(href(page))}"${label === undefined ? '' : ` aria-label="${label}"`}>`;

    expect(markup).toBe(
      '<div class="mura-layout-row"><p class="clearfix search-showing">Showing 51-100 of 120 Results</p>' +
        '<ul class="pagination pull-right">' +
        `<li>${link(1, 'Prev')}<i class="mi-angle-left" aria-hidden="true"></i></a></li>` +
        `<li>${link(1)}1</a></li>` +
        '<li class="active"><a href="#">2</a></li>' +
        `<li>${link(3)}3</a></li>` +
        `<li>${link(3, 'Next')}<i class="mi-angle-right" aria-hidden="true"></i></a></li>` +
        '</ul></div>',
    );
  });

  it.each([
    { locale: 'en', prev: 'Prev', next: 'Next' },
    { locale: 'fr', prev: 'Preç', next: 'Suivant' },
  ])('names the arrows from the $locale bundle', ({ locale, prev, next }) => {
    const markup = toString(pagination({ rb: rbFor(locale) }, { page: 2, totalRecords: 120, recordsPerPage: 50, href })!);
    const $ = cheerio.load(markup, null, false);
    const arrows = $('ul.pagination.pull-right a:has(i)').toArray();

    expect(arrows.map((a) => [$(a).find('i').attr('class'), $(a).attr('aria-label')])).toEqual([
      ['mi-angle-left', prev],
      ['mi-angle-right', next],
    ]);
  });

  it.each([
    { total: 0, perPage: 50 },
    { total: 1, perPage: 50 },
    { total: 50, perPage: 50 },
    { total: 1000, perPage: 1000 },
  ])('renders nothing for $total records at $perPage a page', ({ total, perPage }) => {
    expect(pagination(ctx, { page: 1, totalRecords: total, recordsPerPage: perPage, href })).toBeNull();
  });

  it('words the record range from the session bundle', () => {
    const markup = toString(pagination({ rb: rbFor('fr') }, { page: 1, totalRecords: 60, recordsPerPage: 50, href })!);

    expect(itemsOf(markup)[0]).toBe('Affichage des résultats 1-50 sur 60');
  });
});

describe('readPage', () => {
  /** A reader whose answer for page `n` is `n`, counting `pages` pages. */
  const reader = (pages: number) => {
    const read = vi.fn((page: number | undefined) => Promise.resolve({ page, pages }));
    return { read, pagesOf: (answer: { pages: number }) => answer.pages };
  };

  it.each([
    { name: 'an unnamed page', requested: undefined, pages: 3, reads: [undefined], page: 1 },
    { name: 'page 1', requested: 1, pages: 3, reads: [1], page: 1 },
    { name: 'the last page', requested: 3, pages: 3, reads: [3], page: 3 },
    { name: 'a page past the last', requested: 4, pages: 3, reads: [4, 1], page: 1 },
    { name: 'page 9999 of 20', requested: 9999, pages: 20, reads: [9999, 1], page: 1 },
    { name: 'a page of an empty list', requested: 5, pages: 0, reads: [5], page: 5 },
  ])('reads $name as $reads', async ({ requested, pages, reads, page }) => {
    const { read, pagesOf } = reader(pages);

    const result = await readPage(requested, read, pagesOf);

    expect(read.mock.calls.map(([asked]) => asked)).toEqual(reads);
    expect(result).toEqual({ answer: { page: reads.at(-1), pages }, page });
  });

  it('keeps an answer that is not a page without a second read', async () => {
    const read = vi.fn(() => Promise.resolve({ status: 400 }));

    const result = await readPage(9, read, () => undefined);

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ answer: { status: 400 }, page: 9 });
  });
});

/** The page numbers `from` to `to` as item texts. */
function range(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
}
