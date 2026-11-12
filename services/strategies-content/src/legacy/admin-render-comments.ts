/**
 * Byte-exact ports of the carried `ccomments` fragment views (loadcomments, loadcommentspage, ajax) and the
 * `cnav.searchsitedata` JSON as ACF 2023 sends them. Pure: the route supplies the rows, and the web admin-raw
 * handler relays these bodies unchanged.
 */
import {
  cfDateFormat,
  cfEq,
  cfHash,
  cfListToArray,
  cfNumberString,
  cfTimeFormat,
  isCfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { esapiEncode, lsDateFormat, lsTimeFormat, type AdminRenderContext } from './admin-markup.js';
import { muraJsonEncode } from './cfjson.js';
import { contentUrl, imageUrl, isCfUrl, type LegacySiteUrlConfig } from './content-urls.js';
import type { CategoryRow, CommentRow, ContentRow } from '../repo/tables.js';

/** A rendered comments response: status, the content type exactly as legacy sends it, and the body. */
export interface CommentsRenderResult {
  status: 200;
  contentType: string;
  body: string;
}

/** Wire content type of the `request.layout=false` views. */
export const COMMENTS_FRAGMENT_CONTENT_TYPE = 'text/html;charset=UTF-8';
/** Wire content type of ccomments/ajax.cfm (`cfcontent type="text/html; charset=utf-8"`). */
export const COMMENTS_AJAX_CONTENT_TYPE = 'text/html;charset=utf-8';
/** Wire content type of cnav/searchsitedata.cfm (`cfcontent type="application/json"`). */
export const SEARCH_SITE_DATA_CONTENT_TYPE = 'application/json; charset=UTF-8';

// Java Character.isWhitespace over ASCII: the test ACF applies to the last character already written.
const CF_WHITESPACE = '\t\n\u000b\f\r\u001c\u001d\u001e\u001f ';

/**
 * A view's output buffer under ACF whitespace management: text nodes print as written, while a text node holding only
 * whitespace prints one space after non-whitespace output and nothing otherwise (observed on ACF 2023.0.26).
 */
class CfmlOutput {
  private readonly parts: string[] = [];
  private last = '';

  /** A text node with non-whitespace content, or an expression's value. */
  text(s: string): this {
    if (s !== '') {
      this.parts.push(s);
      this.last = s.charAt(s.length - 1);
    }
    return this;
  }

  /** A whitespace-only text node between two tags or expressions. */
  ws(): this {
    return this.last !== '' && !CF_WHITESPACE.includes(this.last) ? this.text(' ') : this;
  }

  toString(): string {
    return this.parts.join('');
  }
}

// --- Comment bean ---

/** The `content.comment` columns the comment views read. */
export type CommentsViewComment = Pick<
  CommentRow,
  'commentid' | 'contentid' | 'parentid' | 'url' | 'name' | 'comments' | 'entered' | 'email' | 'isapproved' | 'isspam' | 'isdeleted' | 'flagcount'
>;

/** A comment's values as the contentCommentBean getters return them. */
interface CommentBean {
  commentId: string;
  contentId: string;
  parentId: string;
  url: string;
  name: string;
  comments: string;
  email: string;
  entered: Date;
  isApproved: number;
  isSpam: number;
  isDeleted: number;
  flagCount: number;
}

/** bean.cfc setValue (417-440): a NULL cell arrives as '' and every simple value is trimmed. */
function beanString(value: string | null): string {
  return javaTrim(value ?? '');
}

/**
 * contentCommentBean filled by `set(queryRowToStruct(row))`: strings trimmed, setURL (163-170) prefixing
 * `<scheme>://` to a URL whose first `/`-list item is not `http:` or `https:`, and the numeric and date setters
 * (179-212) leaving NULL cells at the init defaults, `now()` for `entered`.
 */
function commentBean(row: CommentsViewComment, scheme: string, now: Date): CommentBean {
  let url = beanString(row.url);
  const first = (cfListToArray(url, '/')[0] ?? '').toLowerCase();
  if (url !== '' && first !== 'http:' && first !== 'https:') url = `${scheme}://${url}`;
  return {
    commentId: beanString(row.commentid),
    contentId: beanString(row.contentid),
    parentId: beanString(row.parentid),
    url,
    name: beanString(row.name),
    comments: beanString(row.comments),
    email: beanString(row.email),
    entered: row.entered ?? now,
    isApproved: row.isapproved ?? 0,
    isSpam: row.isspam ?? 0,
    isDeleted: row.isdeleted ?? 0,
    flagCount: row.flagcount ?? 0,
  };
}

// --- Category tree ---

/** One `tcontentcategories` row of the site's category pool with its children, each level in name order. */
export type CommentsCategoryNode = Pick<CategoryRow, 'categoryid' | 'name' | 'isopen'> & {
  children: readonly CommentsCategoryNode[];
};

/** contentCommentManager.dspCategoriesNestSelect (contentCommentManager.cfc:350-388). */
function categoriesNestSelect(
  nodes: readonly CommentsCategoryNode[],
  categoryId: string,
  nestLevel: number,
  useId: boolean,
  elementName: string,
): string {
  if (nodes.length === 0) return '';
  const selected = cfListToArray(categoryId);
  const elemId = useId ? ' id="mura-nodes"' : '';
  const classList = nestLevel === 0 ? 'categories checkboxTree' : 'categories';
  let o = `<ul${elemId} class="${classList}">`;
  for (const node of nodes) {
    o += '<li>';
    if (node.isopen === 1) {
      const checked = selected.includes(node.categoryid) ? ' checked' : '';
      o +=
        `<input type="checkbox" name="${esapiEncode('html_attr', elementName)}" class="checkbox" ` +
        `value="${esapiEncode('html_attr', node.categoryid)}"${checked}/> `;
    }
    o += esapiEncode('html', node.name);
    if (node.children.length > 0) o += categoriesNestSelect(node.children, categoryId, nestLevel + 1, false, elementName);
    o += '</li>';
  }
  return `${o}</ul>`;
}

// --- ccomments.loadcomments ---

/** One comment of the current page with the content `loadBy(contentID, siteID)` finds for it (null when missing). */
export interface CommentsListRow {
  comment: CommentsViewComment;
  content: Pick<ContentRow, 'menutitle' | 'filename'> | null;
}

/**
 * The `rc` and `$.event` values loadcomments.cfm reads, after the ccomments.cfc:204-282 defaults and paging, plus the
 * rows of the current page in query order and the category tree of the session site's category pool.
 */
export interface LoadCommentsModel {
  keywords: string;
  commentStatus: string;
  startDate: string;
  endDate: string;
  categoryId: string;
  categories: readonly CommentsCategoryNode[];
  sortBy: string;
  sortDirection: string;
  sortDirLink: string;
  /** `rc.nextn` after `Val` and the fallback to 25. */
  nextN: number;
  /** `rc.pageno` after `Val` and the clamp to the page range. */
  pageNo: number;
  totalPages: number;
  startPage: number;
  endPage: number;
  /** `itComments.getRecordCount()`: every matched comment, not just this page. */
  recordCount: number;
  rows: readonly CommentsListRow[];
  /** Request time: the `entered` a NULL cell leaves on the comment bean. */
  now: Date;
}

const COMMENT_STATUSES: readonly string[] = ['Unapproved', 'Approved', 'Spam', 'Deleted'];
const COMMENT_PREVIEW_LENGTH = 210;
const PREVIEW_ENDINGS: readonly string[] = ['.', '!', '?'];

/** loadcomments.cfm:287-295: at most 210 characters, with ` ...` unless the cut ends in `.`, `!` or `?`. */
function commentPreview(comments: string): string {
  if (comments.length <= COMMENT_PREVIEW_LENGTH) return comments;
  const cut = javaTrim(comments).slice(0, COMMENT_PREVIEW_LENGTH);
  return PREVIEW_ENDINGS.includes(cut.slice(-1)) ? cut : `${cut} ...`;
}

/** One pagination list of loadcomments.cfm (105-148 and 352-395); the two copies differ only in their arrows. */
function renderPagination(o: CfmlOutput, model: LoadCommentsModel, previousArrow: string, nextArrow: string): void {
  const { pageNo, totalPages, startPage, endPage } = model;
  const [prevClass, prevNo] = pageNo === 1 ? ['disabled', ''] : ['pageNo', cfNumberString(pageNo - 1)];
  o.text('\n\t\t\t\t\t<div class="pull-right">\n\t\t\t\t\t\t<ul class="pagination">\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t');
  // `hre` is legacy's own typo, kept for parity.
  o.text('\n\t\t\t\t\t\t\t<li class="').text(prevClass).text('">\n\t\t\t\t\t\t\t\t<a hre="#" data-pageno="').text(prevNo);
  o.text(`">${previousArrow}</a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t`);
  for (let p = startPage; p <= endPage; p++) {
    o.text('\n\t\t\t\t\t\t\t\t<li');
    if (pageNo === p) o.text(' class="disabled"');
    o.text('>\n\t\t\t\t\t\t\t\t\t').ws();
    if (pageNo === p) o.ws().ws();
    // listAppend("lClass", ...) appends to the literal string "lClass", not the variable.
    const lClass = pageNo === p ? 'lClass active' : 'pageNo';
    o.text('\n\t\t\t\t\t\t\t\t\t<a href="#" data-pageno="').text(cfNumberString(p)).text('" class="').text(lClass);
    o.text('">\n\t\t\t\t\t\t\t\t\t\t').text(cfNumberString(p)).text('\n\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t');
  }
  o.ws();
  const [nextClass, nextNo] = pageNo === totalPages ? ['disabled', ''] : ['pageNo', cfNumberString(pageNo + 1)];
  o.text('\n\t\t\t\t\t\t\t<li class="').text(nextClass).text('">\n\t\t\t\t\t\t\t\t<a href="#" data-pageno="');
  o.text(esapiEncode('html_attr', nextNo));
  o.text(`">${nextArrow}</a>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\t\t\t\t`);
}

/** The `rc.itComments.hasNext()` branch of loadcomments.cfm (67-397). */
function renderCommentsGrid(o: CfmlOutput, model: LoadCommentsModel, ctx: AdminRenderContext): void {
  const { labels, site } = ctx;
  const sortLink = (sortBy: string, title: string, text: string): string =>
    `<a class="sort" data-sortby="${sortBy}" data-sortdirection="${model.sortDirLink}" data-nextn="${cfNumberString(model.nextN)}" ` +
    `title="${labels.key(title)}" href="#">${text}</a>`;
  o.text(
    '\n\t\t\t\n\t\t\t<form name="frmUpdate" id="frmUpdate">\n' +
      '\t\t\t\t<input type="hidden" name="bulkedit" id="bulkedit" value="" />\n' +
      '\t\t\t\t\n\t\t\t\t<div class="mura-layout-row">\n' +
      '\t\t\t\t\t<div>\n\t\t\t\t\t\t<div class="commentform-actions">\n' +
      '\t\t\t\t\t\t\t<div class="btn-group">\n' +
      '\t\t\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n' +
      '\t\t\t\t\t\t\t\t\tMark As\n\t\t\t\t\t\t\t\t\t<span class="caret"></span>\n' +
      '\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t<ul class="dropdown-menu">\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="'
  );
  o.text(labels.key('comments.message.confirm.approve'));
  o.text(
    '" data-action="approve"><i class="mi-check"></i> Approved</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to mark the selected comments as spam?" data-action="spam"><i class="mi-flag"></i> Spam</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="'
  );
  o.text(labels.key('comments.message.confirm.delete'));
  o.text(
    '" data-action="delete"><i class="mi-trash"></i> Deleted</a></li>\n' +
      '\t\t\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t\t</div>\n' +
      '\t\t\t\t\t\t\t<div class="btn-group">\n' +
      '\t\t\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n' +
      '\t\t\t\t\t\t\t\t\tComments Per Page\n' +
      '\t\t\t\t\t\t\t\t\t<span class="caret"></span>\n' +
      '\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t<ul class="dropdown-menu">\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10">10</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="25">25</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="50">50</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="100">100</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="250">250</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="500">500</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="1000">1000</a></li>\n' +
      '\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10000">'
  );
  o.text(labels.key('comments.all'));
  o.text('</a></li>\n\t\t\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t</div>\n\n\t\t\t\t\n\t\t\t\t');
  if (model.totalPages > 1) renderPagination(o, model, '<i class="mi-angle-left"></i>', '<i class="mi-angle-right"></i>');
  o.text(
    '\n\t\t\t\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n' +
      '\t\t\t\t<br />\n\n\t\t\t\t<table class="mura-table-grid">\n' +
      '\t\t\t\t\t<thead>\n\t\t\t\t\t\t<tr>\n' +
      '\t\t\t\t\t\t\t<th class="actions"></th>\n' +
      '\t\t\t\t\t\t\t<th>\n\t\t\t\t\t\t\t\t'
  );
  if (model.recordCount <= 100 || model.nextN <= 100) {
    o.text('\n\t\t\t\t\t\t\t\t\t<a id="checkall" href="#" title="').text(labels.key('comments.selectall')).text('"><i class="mi-check"></i></a>\n\t\t\t\t\t\t\t\t');
  }
  o.text('\n\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t\t<th>\n\t\t\t\t\t\t\t\t').text(sortLink('entered', 'comments.sortbydatetime', 'Date'));
  o.text('\n\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t\t<th>\n\t\t\t\t\t\t\t\t').text(sortLink('entered', 'comments.sortbydatetime', 'Time'));
  o.text('\n\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t\t<th>\n\t\t\t\t\t\t\t\t').text(sortLink('name', 'comments.sortbyname', 'User'));
  o.text(
    '\n\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t\t<th class="var-width">Comment</th>\n\t\t\t\t\t\t\t<th>Status</th>\n' +
      '\t\t\t\t\t\t\t<th>\n\t\t\t\t\t\t\t\t<a class="sort" data-sortby="flagCount" data-sortdirection="',
  );
  o.text(model.sortDirLink);
  o.text(
    '" href="#">Flag Count</a>\n' +
      '\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t</tr>\n' +
      '\t\t\t\t\t</thead>\n\n\t\t\t\t\t<tbody>\n' +
      '\t\t\t\t\t\t\n\t\t\t\t\t\t'
  );
  for (const row of model.rows) {
    o.ws();
    const item = commentBean(row.comment, site.scheme, model.now);
    const menuTitle = esapiEncode('html', javaTrim(row.content?.menutitle ?? ''));
    o.text('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<div id="comment-').text(item.commentId).text('" data-contentid="').text(item.contentId).text('" data-commentid="').text(item.commentId);
    o.text(
      '" class="modal fade" role="dialog">\n' +
        '\t\t\t\t\t\t\t\t<div class="modal-dialog">\n' +
        '\t\t\t\t\t\t\t\t\t<div class="modal-content">\n' +
        '\t\t\t\t\t\t\t\t\t\t<div class="modal-header">\n' +
        '\t\t\t\t\t\t\t\t\t\t\t<button type="button" class="close" data-dismiss="modal" aria-hidden="true" title="Close Comments"><i class="mi-close"></i></button>\n' +
        '\n\t\t\t\t\t\t\t\t\t\t\t<p>\n\t\t\t\t\t\t\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t\t\t\t\t\t\t'
    );
    if (row.content === null) {
      o.text(
        '\n' +
          '\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><i class="mi-external-link"></i> Content Missing</h1>\n' +
          '\t\t\t\t\t\t\t\t\t\t\t\t'
      );
    } else {
      const href = contentUrl(site, { filename: javaTrim(row.content.filename ?? '') }, {
        querystring: `#comment-${item.commentId}`,
        complete: true,
      });
      o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><a href="').text(href).text('" target="_blank"><i class="mi-external-link"></i> ').text(menuTitle).text('</a></h1>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    }
    o.text(
      '\n\n\t\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\t</p>\n' +
        '\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t\t<div class="modal-body">\n' +
        '\t\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t</div>\n' +
        '\t\t\t\t\t\t\t\t\t\t<div class="modal-footer">\n' +
        '\t\t\t\t\t\t\t\t\t\t\t<div class="pull-right">\n' +
        '\t\t\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\t\t'
    );
    if (item.isDeleted !== 0) {
      o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="undelete"><i class="mi-trash"></i> Undelete</a>\n\t\t\t\t\t\t\t\t\t\t\t\t');
    } else {
      o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="delete"><i class="mi-trash"></i> ').text(labels.key('comments.delete')).text('</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
      if (item.isSpam !== 0) {
        o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="unspam"><i class="mi-flag"></i> Unspam</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t');
      } else {
        o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="spam"><i class="mi-flag"></i> Spam</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
        if (item.isApproved !== 0) {
          o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="unapprove"><i class="mi-ban"></i> ').text(labels.key('comments.unapprove')).text('</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
        } else {
          o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="').text(item.commentId).text('" data-action="approve"><i class="mi-check"></i> ').text(labels.key('comments.approve')).text('</a>\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t');
        }
        o.ws();
      }
      o.ws();
    }
    o.text(
      '\n\t\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t\t</div>\n' +
        '\t\t\t\t\t\t\t\t\t</div>\t\n\t\t\t\t\t\t\t\t</div>\t\n' +
        '\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\n' +
        '\n\t\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t\t\t<td class="actions">\n' +
        '\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>\n' +
        '\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">\n' +
        '\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">\n' +
        '\t\t\t\t\t\t\t\t\t\t\t<li><a href="#comment-'
    );
    o.text(item.commentId).text('" data-toggle="modal"><i class="mi-comments"></i>Comments</a></li>\n\t\t\t\t\t\t\t\t\t\t\t');
    if (isCfUrl(item.url)) {
      const url = esapiEncode('html_attr', item.url);
      o.text('\n\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="').text(url).text('" title="').text(url).text('" target="_blank"><i class="mi-link"></i>View</a></li>\n\t\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\t\t');
    }
    o.text('\n\t\t\t\t\t\t\t\t\t\t\t<li><a href="mailto:').text(esapiEncode('html', item.email)).text('"><i class="mi-envelope"></i>').text(labels.key('user.email'));
    o.text(
      '</a></li>\n\t\t\t\t\t\t\t\t\t\t</ul>\n' +
        '\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t</td>\n' +
        '\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<td>\n' +
        '\t\t\t\t\t\t\t\t\t<input type="checkbox" name="ckUpdate" class="checkall" value="'
    );
    o.text(item.commentId);
    o.text(
      '" />\n\t\t\t\t\t\t\t\t</td>\n\n' +
        '\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<td>\n' +
        '\t\t\t\t\t\t\t\t\t<a href="#comment-'
    );
    o.text(item.commentId).text('" data-toggle="modal" title="Commented on: ').text(menuTitle).text('">\n\t\t\t\t\t\t\t\t\t\t').text(cfDateFormat(item.entered, 'yy/mm/dd'));
    o.text(
      '\n\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t</td>\n' +
        '\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<td>\n' +
        '\t\t\t\t\t\t\t\t\t<a href="#comment-'
    );
    o.text(item.commentId).text('" data-toggle="modal" title="Commented on: ').text(menuTitle).text('">\n\t\t\t\t\t\t\t\t\t\t').text(cfTimeFormat(item.entered, 'h:mm tt'));
    o.text(
      '\n\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t</td>\n' +
        '\n\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t<td>\n' +
        '\t\t\t\t\t\t\t\t\t<a href="#comment-'
    );
    o.text(item.commentId).text('" data-toggle="modal">\n\t\t\t\t\t\t\t\t\t\t').text(esapiEncode('html', item.name));
    o.text(
      '\n\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t</td>\n' +
        '\n\t\t\t\t\t\t\t\t\n\n\t\t\t\t\t\t\t\t<td class="var-width">\n' +
        '\t\t\t\t\t\t\t\t\t'
    );
    o.text('\n\t\t\t\t\t\t\t\t\t<a href="#comment-').text(item.commentId).text('" data-toggle="modal">').text(esapiEncode('html', commentPreview(item.comments)));
    o.text(
      '</a>\n\t\t\t\t\t\t\t\t</td>\n\n' +
        '\t\t\t\t\t\t\t\t<td>\n\t\t\t\t\t\t\t\t\t'
    );
    if (item.isDeleted !== 0) o.text('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-trash"></i>\n\t\t\t\t\t\t\t\t\t');
    else if (item.isSpam !== 0) o.text('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-flag"></i>\n\t\t\t\t\t\t\t\t\t');
    else if (item.isApproved !== 0) o.text('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-check"></i>\n\t\t\t\t\t\t\t\t\t');
    else o.text('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-ban"></i>\n\t\t\t\t\t\t\t\t\t');
    o.text(
      '\n\t\t\t\t\t\t\t\t</td>\n\n\t\t\t\t\t\t\t\t<td>\n' +
        '\t\t\t\t\t\t\t\t\t'
    );
    o.text(esapiEncode('html', item.flagCount));
    o.text(
      '\n\t\t\t\t\t\t\t\t</td>\n\t\t\t\t\t\t\t</tr>\n' +
        '\t\t\t\t\t\t'
    );
  }
  o.text(
    '\n\t\t\t\t\t\t\n\t\t\t\t\t</tbody>\n' +
      '\t\t\t\t</table>\n\t\t\t</form>\n' +
      '\n\t\t\t\n\t\t\t<div class="view-controls mura-layout-row">\n' +
      '\t\t\t\t<div class="btn-group dropup">\n' +
      '\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n' +
      '\t\t\t\t\t\tMark As\n\t\t\t\t\t\t<span class="caret"></span>\n' +
      '\t\t\t\t\t</a>\n\t\t\t\t\t<ul class="dropdown-menu">\n' +
      '\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="'
  );
  o.text(labels.key('comments.message.confirm.approve'));
  o.text(
    '" data-action="approve"><i class="mi-check"></i> Approved</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to mark the selected comments as spam?" data-action="spam"><i class="mi-flag"></i> Spam</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="'
  );
  o.text(labels.key('comments.message.confirm.delete'));
  o.text(
    '" data-action="delete"><i class="mi-trash"></i> Deleted</a></li>\n' +
      '\t\t\t\t\t</ul>\n\t\t\t\t</div>\n' +
      '\t\t\t\t<div class="btn-group dropup">\n' +
      '\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n' +
      '\t\t\t\t\t\tComments Per Page\n' +
      '\t\t\t\t\t\t<span class="caret"></span>\n' +
      '\t\t\t\t\t</a>\n\t\t\t\t\t<ul class="dropdown-menu">\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10">10</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="25">25</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="50">50</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="100">100</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="250">250</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="500">500</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="1000">1000</a></li>\n' +
      '\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10000">'
  );
  o.text(labels.key('comments.all'));
  o.text('</a></li>\n\t\t\t\t\t</ul>\n\t\t\t\t</div>\n\n\t\t\t\t\n\t\t\t\t');
  if (model.totalPages > 1) renderPagination(o, model, '&laquo;', '&raquo;');
  o.text('\n\t\t\t</div>\n\t\t\t\n\t\t');
}

/** ccomments.loadcomments (loadcomments.cfm): search filters, the comment grid with its modals, bulk actions and paging. */
export function renderLoadComments(model: LoadCommentsModel, ctx: AdminRenderContext): CommentsRenderResult {
  const { labels } = ctx;
  const o = new CfmlOutput();
  o.text(
    '\n<style>\n\ttd.actions a:hover {\n' +
      '\t\ttext-decoration: none;\n' +
      '\t}\n</style>\n'
  );
  o.text(
    '\n\n\t\n\t<div class="mura-control-group">\n' +
      '\t\t<label>Search for Comments</label>\n' +
      '\t\t<div class="mura-input-set">\n' +
      '\t\t\t<input type="text" name="keywords" value="'
  );
  o.text(esapiEncode('html_attr', model.keywords)).text('" id="rcSearch" placeholder="').text(labels.key('sitemanager.search'));
  o.text(
    '"/>\n' +
      '\t\t\t<button type="submit" name="btnSearch" id="btnSearch" class="btn"><i class="mi-search"></i></button>\n' +
      '\t\t</div>\n\t</div>\n\n\t<div id="advancedSearch">\n' +
      '\t\t<div class="mura-control-group">\n' +
      '\t\t\t\t<label>Comment Status</label>\n' +
      '\t\t\t\t\t<select name="commentStatus" id="commentStatusSelector">\n' +
      '\t\t\t\t\t\t<option value="">All</option>\n' +
      '\t\t\t\t\t\t'
  );
  for (const status of COMMENT_STATUSES) {
    o.text('\n\t\t\t\t\t\t\t<option value="').text(status).text('"');
    if (cfEq(model.commentStatus, status)) o.text(' selected="selected"');
    o.text('>').text(status).text('</option>\n\t\t\t\t\t\t');
  }
  o.text(
    '\n\t\t\t\t\t</select>\n\t\t\t\t</div>\n' +
      '\t\t\t<div class="mura-control-group">\n' +
      '\t\t\t<div class="date-range-selector">\n' +
      '\t\t\t\t<label>Comment Date Range</label>\n' +
      '\t\t\t\t<div class="mura-control justify">\n' +
      '\t\t\t\t\t<label class="label-inline">\n' +
      '\t\t\t\t\t\t'
  );
  o.text(labels.key('params.from'));
  o.text(
    '\n' +
      '\t\t\t\t\t\t<input type="text" name="startDate" id="startDate" class="datepicker mura-custom-datepicker" placeholder="Start Date" value="'
  );
  o.text(esapiEncode('html_attr', model.startDate)).text('" />\n\t\t\t\t\t\t').text(labels.key('params.to'));
  o.text(
    '\n' +
      '\t\t\t\t\t\t<input type="text" name="endDate" id="endDate" class="datepicker mura-custom-datepicker" placeholder="End Date" value="'
  );
  o.text(esapiEncode('html_attr', model.endDate));
  o.text(
    '" />\n\t\t\t\t\t</label>\n\t\t\t\t</div>\n' +
      '\t\t\t</div>\n\t\t\t\n\t\t</div>\n' +
      '\t\t<div class="mura-control-group">\n' +
      '\t\t\t<div class="mura-control-justify">\n' +
      '\t\t\t\t<label>Available Categories</label>\n' +
      '\t\t\t\t<div id="mura-list-tree">\n' +
      '\t\t\t\t\t'
  );
  o.text(categoriesNestSelect(model.categories, model.categoryId, 0, false, 'categoryID'));
  o.text(
    '\n\t\t\t\t</div>\n\t\t\t</div>\n' +
      '\t\t</div>\n' +
      '\t\t<input type="hidden" id="sortBy" name="sortBy" value="'
  );
  o.text(esapiEncode('html_attr', model.sortBy));
  o.text('">\n\t\t<input type="hidden" id="sortDirection" name="sortDirection" value="').text(esapiEncode('html_attr', model.sortDirection));
  o.text('">\n\t\t<input type="hidden" id="nextN" name="nextN" value="').text(esapiEncode('html_attr', model.nextN));
  o.text('">\n\t\t<input type="hidden" id="pageNo" name="pageNo" value="').text(esapiEncode('html_attr', model.pageNo));
  o.text('">\n\t</div>\n');
  o.ws();
  o.text('\n\t<div class="mura-control-group">\n\t\t\n\n\t\t');
  if (model.rows.length > 0) {
    renderCommentsGrid(o, model, ctx);
  } else {
    o.text(
      '\n\t\t\t<div class="mura-layout-row">\n' +
        '\t\t\t\t<div>\n\t\t\t\t\t<div class="help-block-empty">No '
    );
    // Printed unencoded, as loadcomments.cfm:401 does: a pre-existing defect kept for parity.
    o.text(model.commentStatus);
    o.text(
      ' comments found.</div>\n' +
        '\t\t\t\t</div>\n\t\t\t</div>\n' +
        '\t\t'
    );
  }
  o.text('\n\t</div>\n');
  o.ws();
  return { status: 200, contentType: COMMENTS_FRAGMENT_CONTENT_TYPE, body: o.toString() };
}

// --- ccomments.loadcommentspage ---

/** One comment of the content with what loadcommentspage.cfm loads for it. */
export interface CommentsPageRow {
  comment: CommentsViewComment;
  /** `getCommenter().getRemoteID()`: remoteID of the commenter `comment.userid` names, '' when there is none. */
  commenterRemoteId: string;
  /** The user `loadBy(userID=commenterRemoteId)` finds, with the URL settings of that user's site; null when none. */
  remoteUser: { photoFileId: string | null; site: LegacySiteUrlConfig } | null;
  /** `getParent().getName()`: the parent comment's name, null when no comment has that id. */
  parentName: string | null;
}

/** The `rc` values loadcommentspage.cfm reads and every comment of the content in `getComments` order. */
export interface LoadCommentsPageModel {
  commentId: string;
  upperId: string;
  lowerId: string;
  rows: readonly CommentsPageRow[];
  /** Request time: the `entered` a NULL cell leaves on the comment bean. */
  now: Date;
}

/** 1-based position of `id` in the rows (CF `==`), or 0. */
function rowPosition(rows: readonly CommentsPageRow[], id: string): number {
  return rows.findIndex((row) => cfEq(row.comment.commentid, id)) + 1;
}

/** The `rc.p` start and end rows of ccomments.cfc:303-351: the requested comment, or the window above or below a neighbour. */
function commentsPageWindow(model: LoadCommentsPageModel): { startRow: number; endRow: number } {
  let startRow = 1;
  let endRow = 1;
  const commentPos = rowPosition(model.rows, model.commentId);
  if (commentPos > 0) {
    startRow = commentPos;
    endRow = commentPos;
  }
  if (model.upperId !== '') {
    const upperPos = rowPosition(model.rows, model.upperId);
    if (upperPos > 0) {
      startRow = Math.max(upperPos - 2, 1);
      endRow = upperPos;
    }
  }
  if (model.lowerId !== '') {
    const lowerPos = rowPosition(model.rows, model.lowerId);
    if (lowerPos > 0) {
      startRow = lowerPos;
      endRow = lowerPos + 2;
    }
    if (endRow > model.rows.length) endRow = model.rows.length;
  }
  return { startRow, endRow };
}

/** The avatar src of loadcommentspage.cfm:13-25: the remote user's medium photo, else the Gravatar of the e-mail. */
function commentAvatar(row: CommentsPageRow, email: string, ctx: AdminRenderContext): string {
  const photoFileId = beanString(row.remoteUser?.photoFileId ?? null);
  if (isCfUuid(row.commenterRemoteId) && row.remoteUser !== null && photoFileId !== '') {
    const avatar = imageUrl(row.remoteUser.site, { fileId: photoFileId, fileExt: 'jpg', size: 'medium', direct: ctx.site.directImages });
    if (avatar !== '') return `<img src="${esapiEncode('html_attr', avatar)}">`;
  }
  // ACF 2023 hash() defaults to SHA-256.
  const hash = cfHash(esapiEncode('html_attr', email).toLowerCase()).toLowerCase();
  return `<img src="${ctx.site.scheme}://www.gravatar.com/avatar/${hash}" />`;
}

/** ccomments.loadcommentspage (loadcommentspage.cfm): the comment thread window shown in a comment's modal. */
export function renderLoadCommentsPage(model: LoadCommentsPageModel, ctx: AdminRenderContext): CommentsRenderResult {
  const { labels } = ctx;
  const { rows } = model;
  const { startRow, endRow } = commentsPageWindow(model);
  const o = new CfmlOutput();
  o.ws();
  o.text('\n\t<div id="commentsPage">\n\t\t\n\t\t');
  const above = rows[startRow - 2];
  if (startRow > 1 && above !== undefined && (model.commentId !== '' || model.upperId !== '')) {
    o.text('\n\t\t\t<div id="moreCommentsUpContainer"><a id="moreCommentsUp" class="btn btn-small" href="#" data-upperid="');
    o.text(above.comment.commentid).text('"><i class="mi-arrow-up"></i> ').text(labels.key('comments.morecomments'));
    o.text('</a></div>\n\t\t');
  }
  o.ws();
  for (const row of rows.slice(startRow - 1, Math.max(endRow, 0))) {
    const comment = commentBean(row.comment, ctx.site.scheme, model.now);
    o.ws().ws().ws().ws();
    if (isCfUuid(row.commenterRemoteId)) {
      o.ws().ws();
      if (row.remoteUser !== null && beanString(row.remoteUser.photoFileId) !== '') o.ws().ws();
      o.ws();
    }
    o.text('\n\t\t\t<dl id="detail-').text(comment.commentId).text('">\n\t\t\t\t');
    o.text('\n\t\t\t\t\t<dd class="gravatar">').text(commentAvatar(row, comment.email, ctx)).text('</dd>\n\t\t\t\t');
    o.text('\n\t\t\t\t<dt>\n\t\t\t\t\t').text(esapiEncode('html', comment.name));
    o.ws();
    if (comment.parentId !== '') {
      o.text('\n\t\t\t\t\t\t<em>(').text(labels.key('comments.inreplyto'));
      o.text(': <a href="#" class="inReplyTo" data-parentid="').text(comment.parentId);
      o.text('" data-contentid="').text(comment.contentId).text('">');
      o.text(esapiEncode('html', beanString(row.parentName))).text('</a>)</em>\n\t\t\t\t\t');
    }
    // setParagraphs only wraps in <p>: esapiEncode('html') already turned tabs, line breaks, ':', '/' and '@' into entities.
    o.text('\n\t\t\t\t</dt>\n\t\t\t\t<dd class="comment">\n\t\t\t\t\t').text(`<p>${esapiEncode('html', comment.comments)}</p>`);
    o.text('\n\t\t\t\t</dd>\n\t\t\t\t<dd class="date-time">\n\t\t\t\t\t').text(lsDateFormat(comment.entered, 'long'));
    o.text(', ').text(lsTimeFormat(comment.entered, 'short')).text('\n\t\t\t\t</dd>\n\t\t\t</dl>\n\t\t');
  }
  o.ws();
  const below = rows[endRow];
  if (endRow < rows.length && below !== undefined && (model.commentId !== '' || model.lowerId !== '')) {
    o.text('\n\t\t\t<div id="moreCommentsDownContainer"><a id="moreCommentsDown" class="btn btn-small" href="#" data-lowerid="');
    o.text(below.comment.commentid).text('"><i class="mi-arrow-down"></i> ').text(labels.key('comments.morecomments'));
    o.text('</a></div>\n\t\t');
  }
  o.text('\n\t</div>\n');
  o.ws();
  return { status: 200, contentType: COMMENTS_FRAGMENT_CONTENT_TYPE, body: o.toString() };
}

// --- ccomments.ajax and cnav.searchsitedata ---

/** ccomments.ajax (ajax.cfm), the view of bulkEdit and singleEdit too: `cfcontent reset` leaves an empty body. */
export function renderCommentsAjax(): CommentsRenderResult {
  return { status: 200, contentType: COMMENTS_AJAX_CONTENT_TYPE, body: '' };
}

/** A `settingsManager.getUserSites` row (settingsManager.cfc:593-634), in the order and filtering it returns. */
export interface SearchSiteDataRow {
  siteid: string;
  site: string | null;
}

/** cnav.searchsitedata (searchsitedata.cfm): `mura.json` encode of `[{id, value}]`, then the space before `cfabort`. */
export function renderSearchSiteDataJson(sites: readonly SearchSiteDataRow[]): CommentsRenderResult {
  const data = sites.map((row) => ({ id: row.siteid, value: row.site }));
  const o = new CfmlOutput().text(muraJsonEncode(data)).ws();
  return { status: 200, contentType: SEARCH_SITE_DATA_CONTENT_TYPE, body: o.toString() };
}
