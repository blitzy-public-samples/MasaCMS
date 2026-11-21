import type { components } from '@/generated/clients/strategies-content';
import type { GatewayResponse } from '@/lib/gateway-client';
import { TENANT_A } from '@opt2/platform/testing';
import { CONTENT_IDS } from './carch';

type AdminViewModel = components['schemas']['AdminViewModel'];
type AdminWriteResult = components['schemas']['AdminWriteResult'];

const SITE = TENANT_A.siteId;
const CONTENT_ORIGIN = `http://${SITE}.localhost`;

export const COMMENT_IDS = Object.freeze({
  pending: '5C000000-0004-4000-8000000000000001',
  approved: '5C000000-0004-4000-8000000000000002',
  spam: '5C000000-0004-4000-8000000000000003',
  withHtml: '5C000000-0004-4000-8000000000000004',
} as const);

export const COMMENT_HTML_TEXT = 'Nice update <b>bold</b> <script>alert("x")</script> & thanks';

// ESAPI encodeForHTML, as strategies-content prints it: '/', '(' and ')' are encoded along with the markup characters.
export const COMMENT_HTML_ESCAPED =
  'Nice update &lt;b&gt;bold&lt;&#x2f;b&gt; &lt;script&gt;alert&#x28;&quot;x&quot;&#x29;&lt;&#x2f;script&gt; &amp; thanks';

// The contract serves ccomments.default as listComments and the two edits as comment writes; it names no
// `/ccomments/<action>` path.
export const CCOMMENTS_PATHS = Object.freeze({
  default: `/v1/sites/${SITE}/comments`,
  bulkEdit: `/v1/sites/${SITE}/comments/bulk`,
  singleEdit: `/v1/sites/${SITE}/comments/${COMMENT_IDS.pending}`,
  ajax: '/v1/raw/ccomments/ajax',
  loadComments: '/v1/raw/ccomments/loadcomments',
  loadCommentsPage: '/v1/raw/ccomments/loadcommentspage',
} as const);

export const ccommentsDefaultData: AdminViewModel = { rc: { siteid: SITE } };

export const commentsBulkEditWritten: AdminWriteResult = {
  saved: true,
  errors: {},
  redirect: null,
  data: { processed: true },
};

export const commentsSingleEditWritten: AdminWriteResult = { saved: true, errors: {}, redirect: null };

// renderLoadComments for the four comments in `entered` order: default filters (the day-of-year date mask included),
// 25 per page, one page.
const LOAD_COMMENTS_BODY = `
<style>
\ttd.actions a:hover {
\t\ttext-decoration: none;
\t}
</style>


\t
\t<div class="mura-control-group">
\t\t<label>Search for Comments</label>
\t\t<div class="mura-input-set">
\t\t\t<input type="text" name="keywords" value="" id="rcSearch" placeholder="Search"/>
\t\t\t<button type="submit" name="btnSearch" id="btnSearch" class="btn"><i class="mi-search"></i></button>
\t\t</div>
\t</div>

\t<div id="advancedSearch">
\t\t<div class="mura-control-group">
\t\t\t\t<label>Comment Status</label>
\t\t\t\t\t<select name="commentStatus" id="commentStatusSelector">
\t\t\t\t\t\t<option value="">All</option>
\t\t\t\t\t\t
\t\t\t\t\t\t\t<option value="Unapproved">Unapproved</option>
\t\t\t\t\t\t
\t\t\t\t\t\t\t<option value="Approved">Approved</option>
\t\t\t\t\t\t
\t\t\t\t\t\t\t<option value="Spam">Spam</option>
\t\t\t\t\t\t
\t\t\t\t\t\t\t<option value="Deleted">Deleted</option>
\t\t\t\t\t\t
\t\t\t\t\t</select>
\t\t\t\t</div>
\t\t\t<div class="mura-control-group">
\t\t\t<div class="date-range-selector">
\t\t\t\t<label>Comment Date Range</label>
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<label class="label-inline">
\t\t\t\t\t\tFrom
\t\t\t\t\t\t<input type="text" name="startDate" id="startDate" class="datepicker mura-custom-datepicker" placeholder="Start Date" value="06&#x2f;174&#x2f;2026" />
\t\t\t\t\t\tTo
\t\t\t\t\t\t<input type="text" name="endDate" id="endDate" class="datepicker mura-custom-datepicker" placeholder="End Date" value="06&#x2f;181&#x2f;2026" />
\t\t\t\t\t</label>
\t\t\t\t</div>
\t\t\t</div>
\t\t\t
\t\t</div>
\t\t<div class="mura-control-group">
\t\t\t<div class="mura-control-justify">
\t\t\t\t<label>Available Categories</label>
\t\t\t\t<div id="mura-list-tree">
\t\t\t\t\t
\t\t\t\t</div>
\t\t\t</div>
\t\t</div>
\t\t<input type="hidden" id="sortBy" name="sortBy" value="entered">
\t\t<input type="hidden" id="sortDirection" name="sortDirection" value="asc">
\t\t<input type="hidden" id="nextN" name="nextN" value="25">
\t\t<input type="hidden" id="pageNo" name="pageNo" value="1">
\t</div>

\t<div class="mura-control-group">
\t\t

\t\t
\t\t\t
\t\t\t<form name="frmUpdate" id="frmUpdate">
\t\t\t\t<input type="hidden" name="bulkedit" id="bulkedit" value="" />
\t\t\t\t
\t\t\t\t<div class="mura-layout-row">
\t\t\t\t\t<div>
\t\t\t\t\t\t<div class="commentform-actions">
\t\t\t\t\t\t\t<div class="btn-group">
\t\t\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">
\t\t\t\t\t\t\t\t\tMark As
\t\t\t\t\t\t\t\t\t<span class="caret"></span>
\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t<ul class="dropdown-menu">
\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to approve the selected comments?" data-action="approve"><i class="mi-check"></i> Approved</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to mark the selected comments as spam?" data-action="spam"><i class="mi-flag"></i> Spam</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to delete the selected comments?" data-action="delete"><i class="mi-trash"></i> Deleted</a></li>
\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<div class="btn-group">
\t\t\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">
\t\t\t\t\t\t\t\t\tComments Per Page
\t\t\t\t\t\t\t\t\t<span class="caret"></span>
\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t<ul class="dropdown-menu">
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10">10</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="25">25</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="50">50</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="100">100</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="250">250</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="500">500</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="1000">1000</a></li>
\t\t\t\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10000">ALL</a></li>
\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t</div>

\t\t\t\t
\t\t\t\t
\t\t\t
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t<br />

\t\t\t\t<table class="mura-table-grid">
\t\t\t\t\t<thead>
\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<a id="checkall" href="#" title="Select All"><i class="mi-check"></i></a>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t</th>
\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t<a class="sort" data-sortby="entered" data-sortdirection="desc" data-nextn="25" title="Sort By Date/Time" href="#">Date</a>
\t\t\t\t\t\t\t</th>
\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t<a class="sort" data-sortby="entered" data-sortdirection="desc" data-nextn="25" title="Sort By Date/Time" href="#">Time</a>
\t\t\t\t\t\t\t</th>
\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t<a class="sort" data-sortby="name" data-sortdirection="desc" data-nextn="25" title="Sort By Name" href="#">User</a>
\t\t\t\t\t\t\t</th>
\t\t\t\t\t\t\t<th class="var-width">Comment</th>
\t\t\t\t\t\t\t<th>Status</th>
\t\t\t\t\t\t\t<th>
\t\t\t\t\t\t\t\t<a class="sort" data-sortby="flagCount" data-sortdirection="desc" href="#">Flag Count</a>
\t\t\t\t\t\t\t</th>
\t\t\t\t\t\t</tr>
\t\t\t\t\t</thead>

\t\t\t\t\t<tbody>
\t\t\t\t\t\t
\t\t\t\t\t\t

\t\t\t\t\t\t\t
\t\t\t\t\t\t\t<div id="comment-${COMMENT_IDS.pending}" data-contentid="${CONTENT_IDS.aboutUs}" data-commentid="${COMMENT_IDS.pending}" class="modal fade" role="dialog">
\t\t\t\t\t\t\t\t<div class="modal-dialog">
\t\t\t\t\t\t\t\t\t<div class="modal-content">
\t\t\t\t\t\t\t\t\t\t<div class="modal-header">
\t\t\t\t\t\t\t\t\t\t\t<button type="button" class="close" data-dismiss="modal" aria-hidden="true" title="Close Comments"><i class="mi-close"></i></button>

\t\t\t\t\t\t\t\t\t\t\t<p>
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><a href="${CONTENT_ORIGIN}/about-us/?#comment-${COMMENT_IDS.pending}" target="_blank"><i class="mi-external-link"></i> About Us</a></h1>
\t\t\t\t\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-body">
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-footer">
\t\t\t\t\t\t\t\t\t\t\t<div class="pull-right">
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.pending}" data-action="delete"><i class="mi-trash"></i> Delete</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.pending}" data-action="spam"><i class="mi-flag"></i> Spam</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.pending}" data-action="approve"><i class="mi-check"></i> Approve</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t

\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t\t<li><a href="#comment-${COMMENT_IDS.pending}" data-toggle="modal"><i class="mi-comments"></i>Comments</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="https&#x3a;&#x2f;&#x2f;avery.example.test" title="https&#x3a;&#x2f;&#x2f;avery.example.test" target="_blank"><i class="mi-link"></i>View</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t<li><a href="mailto:avery.quinn&#x40;example.test"><i class="mi-envelope"></i>Email</a></li>
\t\t\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<input type="checkbox" name="ckUpdate" class="checkall" value="${COMMENT_IDS.pending}" />
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.pending}" data-toggle="modal" title="Commented on: About Us">
\t\t\t\t\t\t\t\t\t\t26/06/29
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.pending}" data-toggle="modal" title="Commented on: About Us">
\t\t\t\t\t\t\t\t\t\t9:15 AM
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.pending}" data-toggle="modal">
\t\t\t\t\t\t\t\t\t\tAvery Quinn
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.pending}" data-toggle="modal">Could the About Us page list the program office hours&#x3f;</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t<i class="mi-ban"></i>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t0
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t

\t\t\t\t\t\t\t
\t\t\t\t\t\t\t<div id="comment-${COMMENT_IDS.approved}" data-contentid="${CONTENT_IDS.newsArticle}" data-commentid="${COMMENT_IDS.approved}" class="modal fade" role="dialog">
\t\t\t\t\t\t\t\t<div class="modal-dialog">
\t\t\t\t\t\t\t\t\t<div class="modal-content">
\t\t\t\t\t\t\t\t\t\t<div class="modal-header">
\t\t\t\t\t\t\t\t\t\t\t<button type="button" class="close" data-dismiss="modal" aria-hidden="true" title="Close Comments"><i class="mi-close"></i></button>

\t\t\t\t\t\t\t\t\t\t\t<p>
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><a href="${CONTENT_ORIGIN}/news/program-update/?#comment-${COMMENT_IDS.approved}" target="_blank"><i class="mi-external-link"></i> Program Update</a></h1>
\t\t\t\t\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-body">
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-footer">
\t\t\t\t\t\t\t\t\t\t\t<div class="pull-right">
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.approved}" data-action="delete"><i class="mi-trash"></i> Delete</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.approved}" data-action="spam"><i class="mi-flag"></i> Spam</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.approved}" data-action="unapprove"><i class="mi-ban"></i> Unapprove</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t

\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t\t<li><a href="#comment-${COMMENT_IDS.approved}" data-toggle="modal"><i class="mi-comments"></i>Comments</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="https&#x3a;&#x2f;&#x2f;jordan.example.test" title="https&#x3a;&#x2f;&#x2f;jordan.example.test" target="_blank"><i class="mi-link"></i>View</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t<li><a href="mailto:jordan.ellis&#x40;example.test"><i class="mi-envelope"></i>Email</a></li>
\t\t\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<input type="checkbox" name="ckUpdate" class="checkall" value="${COMMENT_IDS.approved}" />
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.approved}" data-toggle="modal" title="Commented on: Program Update">
\t\t\t\t\t\t\t\t\t\t26/06/30
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.approved}" data-toggle="modal" title="Commented on: Program Update">
\t\t\t\t\t\t\t\t\t\t8:40 AM
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.approved}" data-toggle="modal">
\t\t\t\t\t\t\t\t\t\tJordan Ellis
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.approved}" data-toggle="modal">Thanks for the clear program update.</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t<i class="mi-check"></i>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t0
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t

\t\t\t\t\t\t\t
\t\t\t\t\t\t\t<div id="comment-${COMMENT_IDS.spam}" data-contentid="${CONTENT_IDS.newsArticle}" data-commentid="${COMMENT_IDS.spam}" class="modal fade" role="dialog">
\t\t\t\t\t\t\t\t<div class="modal-dialog">
\t\t\t\t\t\t\t\t\t<div class="modal-content">
\t\t\t\t\t\t\t\t\t\t<div class="modal-header">
\t\t\t\t\t\t\t\t\t\t\t<button type="button" class="close" data-dismiss="modal" aria-hidden="true" title="Close Comments"><i class="mi-close"></i></button>

\t\t\t\t\t\t\t\t\t\t\t<p>
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><a href="${CONTENT_ORIGIN}/news/program-update/?#comment-${COMMENT_IDS.spam}" target="_blank"><i class="mi-external-link"></i> Program Update</a></h1>
\t\t\t\t\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-body">
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-footer">
\t\t\t\t\t\t\t\t\t\t\t<div class="pull-right">
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.spam}" data-action="delete"><i class="mi-trash"></i> Delete</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.spam}" data-action="unspam"><i class="mi-flag"></i> Unspam</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t

\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t\t<li><a href="#comment-${COMMENT_IDS.spam}" data-toggle="modal"><i class="mi-comments"></i>Comments</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="http&#x3a;&#x2f;&#x2f;promo.example.test" title="http&#x3a;&#x2f;&#x2f;promo.example.test" target="_blank"><i class="mi-link"></i>View</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t<li><a href="mailto:promo.desk&#x40;example.test"><i class="mi-envelope"></i>Email</a></li>
\t\t\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<input type="checkbox" name="ckUpdate" class="checkall" value="${COMMENT_IDS.spam}" />
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.spam}" data-toggle="modal" title="Commented on: Program Update">
\t\t\t\t\t\t\t\t\t\t26/06/30
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.spam}" data-toggle="modal" title="Commented on: Program Update">
\t\t\t\t\t\t\t\t\t\t11:05 AM
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.spam}" data-toggle="modal">
\t\t\t\t\t\t\t\t\t\tPromo Desk
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.spam}" data-toggle="modal">Discount offers every day at promo.example.test</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t<i class="mi-flag"></i>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t3
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t

\t\t\t\t\t\t\t
\t\t\t\t\t\t\t<div id="comment-${COMMENT_IDS.withHtml}" data-contentid="${CONTENT_IDS.aboutUs}" data-commentid="${COMMENT_IDS.withHtml}" class="modal fade" role="dialog">
\t\t\t\t\t\t\t\t<div class="modal-dialog">
\t\t\t\t\t\t\t\t\t<div class="modal-content">
\t\t\t\t\t\t\t\t\t\t<div class="modal-header">
\t\t\t\t\t\t\t\t\t\t\t<button type="button" class="close" data-dismiss="modal" aria-hidden="true" title="Close Comments"><i class="mi-close"></i></button>

\t\t\t\t\t\t\t\t\t\t\t<p>
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<h1><a href="${CONTENT_ORIGIN}/about-us/?#comment-${COMMENT_IDS.withHtml}" target="_blank"><i class="mi-external-link"></i> About Us</a></h1>
\t\t\t\t\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-body">
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="modal-footer">
\t\t\t\t\t\t\t\t\t\t\t<div class="pull-right">
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.withHtml}" data-action="delete"><i class="mi-trash"></i> Delete</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.withHtml}" data-action="spam"><i class="mi-flag"></i> Spam</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<a href="#" class="singleEdit btn" data-commentid="${COMMENT_IDS.withHtml}" data-action="approve"><i class="mi-check"></i> Approve</a>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t\t</div>\t
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t

\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t\t\t\t<li><a href="#comment-${COMMENT_IDS.withHtml}" data-toggle="modal"><i class="mi-comments"></i>Comments</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="https&#x3a;&#x2f;&#x2f;riley.example.test" title="https&#x3a;&#x2f;&#x2f;riley.example.test" target="_blank"><i class="mi-link"></i>View</a></li>
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t\t<li><a href="mailto:riley.morgan&#x40;example.test"><i class="mi-envelope"></i>Email</a></li>
\t\t\t\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<input type="checkbox" name="ckUpdate" class="checkall" value="${COMMENT_IDS.withHtml}" />
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.withHtml}" data-toggle="modal" title="Commented on: About Us">
\t\t\t\t\t\t\t\t\t\t26/06/30
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.withHtml}" data-toggle="modal" title="Commented on: About Us">
\t\t\t\t\t\t\t\t\t\t2:20 PM
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.withHtml}" data-toggle="modal">
\t\t\t\t\t\t\t\t\t\tRiley Morgan
\t\t\t\t\t\t\t\t\t</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t

\t\t\t\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<a href="#comment-${COMMENT_IDS.withHtml}" data-toggle="modal">${COMMENT_HTML_ESCAPED}</a>
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t\t<i class="mi-ban"></i>
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t</td>

\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t0
\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t
\t\t\t\t\t\t
\t\t\t\t\t</tbody>
\t\t\t\t</table>
\t\t\t</form>

\t\t\t
\t\t\t<div class="view-controls mura-layout-row">
\t\t\t\t<div class="btn-group dropup">
\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">
\t\t\t\t\t\tMark As
\t\t\t\t\t\t<span class="caret"></span>
\t\t\t\t\t</a>
\t\t\t\t\t<ul class="dropdown-menu">
\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to approve the selected comments?" data-action="approve"><i class="mi-check"></i> Approved</a></li>
\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to mark the selected comments as spam?" data-action="spam"><i class="mi-flag"></i> Spam</a></li>
\t\t\t\t\t\t<li><a href="#" class="bulkEdit" data-alertmessage="Are you sure you want to delete the selected comments?" data-action="delete"><i class="mi-trash"></i> Deleted</a></li>
\t\t\t\t\t</ul>
\t\t\t\t</div>
\t\t\t\t<div class="btn-group dropup">
\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">
\t\t\t\t\t\tComments Per Page
\t\t\t\t\t\t<span class="caret"></span>
\t\t\t\t\t</a>
\t\t\t\t\t<ul class="dropdown-menu">
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10">10</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="25">25</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="50">50</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="100">100</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="250">250</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="500">500</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="1000">1000</a></li>
\t\t\t\t\t\t<li><a href="#" class="nextN" data-nextn="10000">ALL</a></li>
\t\t\t\t\t</ul>
\t\t\t\t</div>

\t\t\t\t
\t\t\t\t
\t\t\t</div>
\t\t\t
\t\t
\t</div>
`;

// Content types are ACF's wire forms, which strategies-content sends unchanged.
export const loadCommentsRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'text/html;charset=UTF-8' },
  body: LOAD_COMMENTS_BODY,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const ajaxEmptyRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'text/html;charset=utf-8' },
  body: '',
  setCookies: [],
} as const satisfies GatewayResponse<string>;
