// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { getNextN } from '@/screens/cusers/inc/dsp_nextn';

/** A paged list as its pager shows it. */
export interface PageState {
  /** One-based page shown. */
  readonly page: number;
  readonly totalRecords: number;
  readonly recordsPerPage: number;
  /** URL of page `page`, not HTML-encoded. */
  readonly href: (page: number) => string;
}

const PREV_ICON = html`<i class="mi-angle-left" aria-hidden="true"></i>`;
const NEXT_ICON = html`<i class="mi-angle-right" aria-hidden="true"></i>`;

/** A page link of the pager; `label` names an icon-only one. */
function pageLink(href: string, content: SafeHtml | number, label?: string): SafeHtml {
  return html`<li><a${attr('href', href)}${attr('aria-label', label)}>${content}</a></li>`;
}

/** The legacy admin pager: the record range, then the numbered `utility.getNextN` window; null for a single page. */
export function pagination(ctx: { readonly rb: RbLookup }, state: PageState): SafeHtml | null {
  const { page, totalRecords, recordsPerPage, href } = state;
  const nextn = getNextN(totalRecords, recordsPerPage, (page - 1) * recordsPerPage + 1);
  if (nextn.numberOfPages <= 1) return null;
  const range = ctx.rb.messageFormat(ctx.rb.rbKey('sitemanager.paginationmeta'), [
    `${nextn.startRow}-${nextn.through}`,
    totalRecords,
  ]);
  const items: SafeHtml[] = [];
  if (page > 1) items.push(pageLink(href(page - 1), PREV_ICON, ctx.rb.rbKey('sitemanager.prev')));
  for (let pageNumber = nextn.firstPage; pageNumber <= nextn.lastPage; pageNumber += 1) {
    const current = pageNumber === page ? html`<li class="active"><a href="#">${pageNumber}</a></li>` : null;
    items.push(current ?? pageLink(href(pageNumber), pageNumber));
  }
  if (page < nextn.numberOfPages) items.push(pageLink(href(page + 1), NEXT_ICON, ctx.rb.rbKey('sitemanager.next')));
  const meta = html`<p class="clearfix search-showing">${raw(range)}</p>`;
  return html`<div class="mura-layout-row">${meta}<ul class="pagination pull-right">${items}</ul></div>`;
}

/** `read(page)`, then `read(1)` past the answer's last page, as legacy iterators reset; the answer and its page. */
export async function readPage<T>(
  page: number | undefined,
  read: (page: number | undefined) => Promise<T>,
  pagesOf: (answer: T) => number | undefined,
): Promise<{ readonly answer: T; readonly page: number }> {
  const answer = await read(page);
  const pages = pagesOf(answer) ?? 0;
  if (page !== undefined && pages > 0 && page > pages) return { answer: await read(1), page: 1 };
  return { answer, page: page ?? 1 };
}
