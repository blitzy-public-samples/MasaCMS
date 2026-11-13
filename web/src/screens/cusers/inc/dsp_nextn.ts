// cUsers `inc/dsp_nextn.cfm`: the records-per-page menu and page links below the user and group lists (server-only).
import { attr, html, join, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { CusersRc } from '../gate';

/** Paging state as `utility.getNextN` computes it. */
export interface NextN {
  totalRecords: number;
  recordsPerPage: number;
  numberOfPages: number;
  currentPageNumber: number;
  firstPage: number;
  lastPage: number;
  /** First row of the next page; 1 past the last page. */
  next: number;
  /** First row of the previous page. */
  previous: number;
  /** Last row of the current page. */
  through: number;
  startRow: number;
}

/** What {@link renderNextN} reads; `muraAction` is `rc.muraAction` as FW/1 sets it (`core:cusers.listusers`). */
export interface NextNInput {
  /** Absent where legacy leaves `rc.nextn` undefined. */
  nextn?: NextN;
  /** The iterator's page index, from {@link legacyPageIndex}. */
  pageIndex: number;
  rc: Pick<CusersRc, 'siteid' | 'ispublic' | 'unassigned' | 'recordsperpage'>;
  muraAction: string;
  rb: RbLookup;
}

/** `utility.getNextN` over a record count; the cUsers controller passes a `pageBuffer` of 3. */
export function getNextN(totalRecords: number, recordsPerPage: number, startRow: number, pageBuffer = 5): NextN {
  const numberOfPages = Math.ceil(totalRecords / recordsPerPage);
  const currentPageNumber = Math.ceil(startRow / recordsPerPage);
  let firstPage = currentPageNumber > pageBuffer ? currentPageNumber - pageBuffer : 1;
  let lastPage = firstPage + 2 * pageBuffer;
  if (numberOfPages < lastPage) lastPage = numberOfPages;
  if (lastPage - firstPage < 2 * pageBuffer) firstPage = Math.max(1, lastPage - 2 * pageBuffer);
  let next = (currentPageNumber + 1) * recordsPerPage - recordsPerPage + 1;
  const previous = Math.max(currentPageNumber - 1, 1) * recordsPerPage - recordsPerPage + 1;
  const through = totalRecords < next ? totalRecords : next - 1;
  if (next > totalRecords) next = 1;
  return {
    totalRecords,
    recordsPerPage,
    numberOfPages,
    currentPageNumber,
    firstPage,
    lastPage,
    next,
    previous,
    through,
    startRow,
  };
}

/**
 * Iterator page index after `setPage(nextn.startrow)`: the start row itself (page links post page numbers as
 * `startrow`), or 1 past the last record. Callers mark it active and show rows `(p-1)*rpp+1` to `min(p*rpp, total)`.
 */
export function legacyPageIndex(startRow: number, recordsPerPage: number, totalRecords: number): number {
  return (startRow - 1) * recordsPerPage > totalRecords ? 1 : startRow;
}

const RECORDS_PER_PAGE = [5, 10, 25, 50, 100, 250, 500, 1000] as const;
const ALL_RECORDS = 100000;

const NEXTN_SCRIPT = [
  '<script>',
  '\t\tjQuery(document).ready(function($){',
  '',
  "\t\t\t$('a.nextN').click(function(e){",
  '\t\t\t\te.preventDefault();',
  '\t\t\t\tactionModal();',
  `\t\t\t\t$('form#frmNextN input[name="recordsperpage"]').val($(this).attr('data-nextn'));`,
  // The form has no `pageno` field; legacy sets it all the same.
  `\t\t\t\t$('form#frmNextN input[name="pageno"]').val(1);`,
  "\t\t\t\t$('form#frmNextN').submit();",
  '\t\t\t});',
  '',
  "\t\t\t$('a.pageNo').click(function(e){",
  '\t\t\t\te.preventDefault();',
  '\t\t\t\tactionModal();',
  `\t\t\t\t$('form#frmNextN input[name="startrow"]').val($(this).attr('data-pageno'));`,
  "\t\t\t\t$('form#frmNextN').submit();",
  '\t\t\t});',
  '',
  '\t\t});',
  '\t\t</script>',
].join('\n');

const activeClass = (active: boolean): SafeHtml => (active ? html` class="active"` : html``);

/** One records-per-page item; `<li >` keeps the space legacy writes before its optional class. */
function recordsPerPageItem(value: number, label: SafeHtml | number, active: boolean): SafeHtml {
  return html`<li ${activeClass(active)}><a href="#" class="nextN" data-nextn="${value}">${label}</a></li>`;
}

/** One page-number link of the pagination. */
function pageItem(page: number, active: boolean): SafeHtml {
  return join([
    html`\n\t\t\t\t\t\t\t\t<li${activeClass(active)}>\n\t\t\t\t\t\t\t\t\t\n`,
    html`\t\t\t\t\t\t\t\t\t<a href="#" data-pageno="${page}" class="pageNo">\n`,
    html`\t\t\t\t\t\t\t\t\t\t${page}\n\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t`,
  ]);
}

/** The `ul.pagination` block, shown only when there is more than one page. */
function renderPagination(nextn: NextN, pageIndex: number): SafeHtml {
  const onFirst = pageIndex === 1;
  const onLast = pageIndex === nextn.numberOfPages;
  const prevClass = onFirst ? 'hidden' : 'pageNo';
  const nextClass = onLast ? 'hidden' : 'pageNo';
  const pages: SafeHtml[] = [];
  for (let page = nextn.firstPage; page <= nextn.lastPage; page += 1) pages.push(pageItem(page, pageIndex === page));
  return join([
    html`\n\t\t\t\t\n\t\t\t\t\t<ul class="pagination pull-right">\n\n\t\t\t\t\t\t\n\t\t\t\t\t\t\t\n`,
    html`\t\t\t\t\t\t\t<li class="${prevClass}">\n`,
    html`\t\t\t\t\t\t\t\t<a href="#" data-pageno="${onFirst ? '' : pageIndex - 1}" class="${prevClass}">`,
    html`<i class="mi-angle-left"></i></a>\n\t\t\t\t\t\t\t</li>\n\n\t\t\t\t\t\t\n\t\t\t\t\t\t\t`,
    ...pages,
    html`\n\t\t\t\t\t\t\t<li class="${nextClass}">\n`,
    html`\t\t\t\t\t\t\t\t<a href="#"${attr('data-pageno', onLast ? '' : String(pageIndex + 1))} class="${nextClass}">`,
    html`<i class="mi-angle-right"></i></a>\n\t\t\t\t\t\t\t</li>\n\n\t\t\t\t\t</ul>\n\t\t\t\t`,
  ]);
}

/**
 * The legacy include's output byte for byte, or nothing without `nextn`. Its whitespace is what ACF emits for the view,
 * which drops whitespace-only text between CFML tags.
 */
export function renderNextN(input: NextNInput): SafeHtml {
  const { nextn, pageIndex, rc, muraAction, rb } = input;
  if (nextn === undefined) return html``;
  const options = RECORDS_PER_PAGE.map(
    (value) => html`\n\t\t\t\t\t\t\t\t${recordsPerPageItem(value, value, rc.recordsperpage === value)}\n\t\t\t\t\t\t\t`,
  );
  const all = recordsPerPageItem(ALL_RECORDS, raw(rb.rbKey('user.all')), rc.recordsperpage === ALL_RECORDS);
  return join([
    html`\n\n\n\t\t${raw(NEXTN_SCRIPT)}\n\n\t\t<form id="frmNextN" action="" method="post">\n`,
    html`\t\t\t<input type="hidden" name="muraAction"${attr('value', muraAction)}>\n`,
    html`\t\t\t<input type="hidden" name="siteid"${attr('value', rc.siteid)}>\n`,
    html`\t\t\t<input type="hidden" name="ispublic"${attr('value', rc.ispublic)}>\n`,
    html`\t\t\t<input type="hidden" name="unassigned"${attr('value', rc.unassigned)}>\n`,
    html`\t\t\t<input type="hidden" name="recordsperpage" value="${nextn.recordsPerPage}">\n`,
    html`\t\t\t<input type="hidden" name="startrow" value="${nextn.startRow}">\n\t\t</form>\n\n`,
    html`\t\t<div class="container">\n\t\t\t<div class="mura-layout-row">\n\n\t\t\t\t\n`,
    html`\t\t\t\t\t<div class="btn-group">\n`,
    html`\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n`,
    html`\t\t\t\t\t\t\t${raw(rb.rbKey('user.recordsperpage'))}\n\t\t\t\t\t\t\t<span class="caret"></span>\n`,
    html`\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\n\t\t\t\t\t\t<ul class="dropdown-menu next-n pull-right">\n\t\t\t\t\t\t\t`,
    ...options,
    html`\n\t\t\t\t\t\t\t${all}\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\n\t\t\t\t`,
    nextn.numberOfPages > 1 ? renderPagination(nextn, pageIndex) : html``,
    html`\n\t\t\t</div>\n\t\t</div>\n\t`,
  ]);
}
