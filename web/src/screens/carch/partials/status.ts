// The node lock notice and approval status of `carch/dsp_status.cfm`, included by edit, hist and audit (server-only).
import { isCompactDisplay } from '@/lib/cfml';
import type { CsrfRenderer } from '@/lib/csrf';
import { formatDateField, parseLegacyDate } from '@/lib/dates';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '../../registry';
import { isSuperOrAdminUser, lockState, type CarchStats } from '../model';

/** One conflicting date of a scheduling conflict (a `getConfictDetailIterator()` item). */
export interface StatusConflictDetail {
  /** `createHREF(filename='<calendar>/_/date/<y>/<m>/<d>', complete=true)`, as strategies-content builds it. */
  readonly href: string;
  /** `getDisplayStart()`. */
  readonly displayStart: string | Date;
}

/** One `getDisplayConflicts()` item. */
export interface StatusConflict {
  /** `getEditURL()`. */
  readonly editUrl: string;
  readonly title: string;
  readonly details: readonly StatusConflictDetail[];
}

/** The `rc.contentBean` values the status view reads. */
export interface StatusContent {
  readonly contentId: string;
  readonly siteId: string;
  readonly contentHistId: string;
  readonly approvalStatus: string;
  /** `getDisplay()`; 2 is a scheduled display window. */
  readonly display: number;
  /** `getDisplayIntervalDesc(showTitle=false)`, as strategies-content renders it. */
  readonly displayIntervalDesc: string;
  /** `getDisplayConflicts()`, read only under a Calendar parent. */
  readonly conflicts: readonly StatusConflict[];
}

/** The user bean `stats.getLockID()` loads. */
export interface StatusLockUser {
  readonly fname: string;
  readonly lname: string;
  readonly email: string;
}

/** What the status view reads besides the request. */
export interface StatusModel {
  /** `$.siteConfig('hasLockableNodes')`. */
  readonly hasLockableNodes: boolean;
  /** `rc.contentBean.getStats()`, read for `lockType` and `lockID`. */
  readonly stats: CarchStats;
  /** The lock holder when someone else holds the lock; absent is the empty bean `loadBy` gives for an unknown id. */
  readonly lockedBy?: StatusLockUser;
  readonly content: StatusContent;
  /** The including view's `showApprovalStatus`; undefined where the view defines none, omitting the approval block. */
  readonly showApprovalStatus?: boolean;
  /** `rc.parentBean.getType()`. */
  readonly parentType: string;
}

/** Request, labels and CSRF tokens the status view renders with; a `ScreenContext` satisfies it. */
export type StatusContext = Pick<ScreenContext, 'req' | 'rb'> & { readonly csrf: Pick<CsrfRenderer, 'tokens'> };

const EMPTY_USER: StatusLockUser = Object.freeze({ fname: '', lname: '', email: '' });

const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one character. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/**
 * View output as ACF whitespace management writes it: template text holding any non-whitespace prints verbatim, and
 * whitespace-only text prints one space after non-whitespace output and nothing after whitespace. Every including view
 * ends its own output with whitespace before the include, so the view starts as if after whitespace.
 */
class CfOutput {
  #out = '';

  /** One run of template text between two tags or expressions. */
  text(run: string): void {
    if (![...run].every(isJavaWhitespace)) this.#out += run;
    else if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
  }

  /** An expression's output, verbatim. */
  value(output: string): void {
    this.#out += output;
  }

  get markup(): string {
    return this.#out;
  }
}

/** `LSDateFormat(value, mask)`, which has no date-input 50-year blanking, so the value is its own reference date. */
function lsDate(value: string | Date, mask: string): string {
  return formatDateField(value, mask, parseLegacyDate(value) ?? undefined);
}

/** `nodeLockedBySomeElse`: the lock holder's notice, with the unlock link for super and admin users. */
function lockedElseNotice(ctx: StatusContext, user: StatusLockUser, out: CfOutput): void {
  const { rb } = ctx;
  out.text('\n\t\t\t');
  out.text('\n\t\t\t<p id="msg-node-locked-else" class="alert alert-error">\n\t\t\t\t<span>\n\t\t\t\t\t');
  const holder = `${encodeHtmlAttr(user.fname)} ${encodeHtml(user.lname)}`;
  out.value(rb.messageFormat(rb.rbKey('sitemanager.nodeLockedby'), holder));
  out.text('.<br>\n\t\t\t\t<a href="mailto:');
  out.value(encodeHtml(user.email));
  out.text('?subject=');
  out.value(encodeHtml(rb.rbKey('sitemanager.nodeunlockrequest')));
  out.text('"><i class="mi-envelope"></i> ');
  out.value(rb.rbKey('sitemanager.requestnoderelease'));
  out.text('</a>\n\t\t\t\t\t');
  if (isSuperOrAdminUser(ctx.req)) {
    out.text(' &nbsp; &nbsp;<a class="mura-node-unlock" href="#"><i class="mi-unlock"></i> ');
    out.value(rb.rbKey('sitemanager.content.fields.unlocknode'));
    out.text('</a>\n\t\t\t\t\t');
  }
  out.text('\n\t\t\t\t</span>\n\t\t\t</p>\n\n\t\t');
}

/** `dsp_status.cfm` lines 77-140: the node lock notice and the script posting `carch.unlockNode`. */
async function lockNotice(ctx: StatusContext, model: StatusModel, out: CfOutput): Promise<void> {
  const { rb, req } = ctx;
  const { contentId, siteId } = model.content;
  const { nodeLockedByYou, nodeLockedBySomeoneElse } = lockState(model.stats, model, req.session.mura.userID);
  out.text('\n\t');
  if (nodeLockedByYou || nodeLockedBySomeoneElse) {
    out.text('\n\n\t\t');
    if (!nodeLockedBySomeoneElse) {
      const hidden = nodeLockedByYou ? '' : ' style="display:none;"';
      out.text(`\n\t\t\t<p id="msg-node-locked" class="alert alert-error"${hidden}>\n\t\t\t\t<span>\n`);
      out.value(rb.rbKey('sitemanager.content.fields.youvelockednode'));
      out.text(` <a class="mura-node-unlock" href="#"${hidden}><i class="mi-unlock"></i> `);
      out.value(rb.rbKey('sitemanager.content.fields.unlocknode'));
      out.text('</a>\n\t\t\t\t</span>\n\t\t\t</p>\n\t\t');
    } else {
      lockedElseNotice(ctx, model.lockedBy ?? EMPTY_USER, out);
    }
    const tokens = await ctx.csrf.tokens(`${contentId}unlocknode`);
    out.text(`
\t\t<script>
\t\t\t$(function(){
\t\t\t\tjQuery(".mura-node-unlock").click(
\t\t\t\t\tfunction(event){
\t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t\tconfirmDialog(
\t\t\t\t\t\t\t"`);
    out.value(encodeJs(rb.rbKey('sitemanager.content.fields.unlocknodeconfirm')));
    out.text(`",
\t\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\t\tjQuery("#msg-node-locked").fadeOut();
\t\t\t\t\t\t\t\tjQuery(".mura-node-unlock").hide();
\t\t\t\t\t\t\t\tif(lockedbysomeonelse){
\t\t\t\t\t\t\t\t\tjQuery("#msg-node-locked-else").fadeOut();
\t\t\t\t\t\t\t\t\tlockedbysomeonelse=false;
\t\t\t\t\t\t\t\t\tsiteManager.doConditionalExit=true;
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\tsiteManager.hasNodeLock=false;
\t\t\t\t\t\t\t\t$('.form-actions').fadeIn();
\t\t\t\t\t\t\t\t`);
    out.text(`
\t\t\t\t\t\t\t\tjQuery.post("./",{
\t\t\t\t\t\t\t\t\tmuraAction:"carch.unlockNode",
\t\t\t\t\t\t\t\t\tcontentid:"`);
    out.value(contentId);
    out.text(`",
\t\t\t\t\t\t\t\t\tsiteid:"`);
    out.value(siteId);
    out.text(`",
\t\t\t\t\t\t\t\t\tcsrf_token:'`);
    out.value(tokens.token);
    out.text(`',
\t\t\t\t\t\t\t\t\tcsrf_token_expires: '`);
    out.value(tokens.expires);
    out.text(`'
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t}
\t\t\t\t\t\t);
\t\t\t\t\t}
\t\t\t\t);

\t\t\t\t`);
    if (nodeLockedBySomeoneElse) {
      out.text(`
\t\t\t\t$('.form-actions').hide();
\t\t\t\tlockedbysomeonelse=true;
\t\t\t\tsiteManager.doConditionalExit=false;
\t\t\t\t`);
    }
    out.text(`
\t\t\t});
\t\t\t</script>
\t`);
  }
  out.text('\n');
}

/** `dsp_status.cfm` lines 145-158: the pending or rejected approval notice, linking the status modal. */
function approvalNotice(rb: RbLookup, content: StatusContent, out: CfOutput): void {
  out.text('\n\t<div class="alert alert-error">\n\t\t<span>\n\t\t');
  out.text('\n\t\t\t');
  // Legacy's `Cancelled` branch is omitted: only Pending and Rejected pass the test before it.
  const rejected = content.approvalStatus.toLowerCase() === 'rejected';
  out.value(rb.rbKey(rejected ? 'sitemanager.content.rejectedmessage' : 'sitemanager.content.pendingmessage'));
  out.text(':\n\t\t');
  out.text(`\n\t\t<strong><a href="#" onclick="return viewStatusInfo('`);
  out.value(encodeJs(content.contentHistId));
  out.text(`','`);
  out.value(encodeJs(content.siteId));
  out.text(`');">`);
  out.value(rb.rbKey('sitemanager.content.viewdetails'));
  out.text('</a></strong>\n\t\t</span>\n\t</div>\n');
}

/** `dsp_status.cfm` lines 160-190: the display window and scheduling conflicts of an item under a Calendar. */
function calendarNotices(ctx: StatusContext, content: StatusContent, out: CfOutput): void {
  const { rb, req } = ctx;
  out.text('\n\t');
  if (content.display === 2) {
    out.text('\n\t\t<div class="alert alert-info" >\n\t\t\t<span>\n\t\t\t\t<strong>');
    out.value(rb.rbKey('sitemanager.content.fields.display'));
    out.text(':</strong> ');
    out.value(content.displayIntervalDesc);
    out.text('\n\t\t\t</span>\n\t\t</div>\n\t');
  }
  out.text('\n\n\t');
  if (content.conflicts.length > 0) {
    const target = isCompactDisplay(req.rc.compactDisplay) ? 'target="_top"' : 'target="_blank"';
    out.text('\n\t\t');
    out.text('\n\t\t<div class="alert alert-error">\n\t\t\t<span>\n\t\t\t<h3>');
    out.value(rb.rbKey('sitemanager.content.fields.displayinterval.schedulingconflicts'));
    out.text(':</h3>\n\t\t\t\t');
    for (const conflict of content.conflicts) {
      out.text('\n\t\t\t\t\t');
      out.text('\n\t\t\t\t\t<p><strong><a href="');
      out.value(conflict.editUrl);
      out.text('">');
      out.value(encodeHtml(conflict.title));
      // `</strong></a>` closes out of order, as legacy writes it.
      out.text(':</strong></a>\n\t\t\t\t\t\t');
      out.text('\n\t\t\t\t\t\t');
      conflict.details.forEach((detail, index) => {
        out.text('\n\t\t\t\t\t\t\t');
        out.text('\n\t\t\t\t\t\t\t<a href="');
        out.value(detail.href);
        out.text(`" ${target}>`);
        out.value(lsDate(detail.displayStart, req.session.dateKeyFormat));
        out.text('</a>\n\t\t\t\t\t\t\t');
        if (index < conflict.details.length - 1) out.text(', ');
        out.text('\n\t\t\t\t\t\t');
      });
      out.text('\n\t\t\t\t\t</p>\n\t\t\t\t');
    }
    out.text('\n\t\t\t</span>\n\t\t</div>\n\t');
  }
  out.text('\n');
}

/** `dsp_status.cfm` lines 141-259: the status modal container, approval and calendar notices, approval scripts. */
async function approvalStatus(ctx: StatusContext, model: StatusModel, show: boolean, out: CfOutput): Promise<void> {
  const { rb } = ctx;
  const { content } = model;
  out.text('\n\n<div style="display:none;" title="');
  out.value(encodeHtmlAttr(rb.rbKey('layout.status')));
  out.text('" id="approvalModalContainer"></div>\n\n');
  const approval = content.approvalStatus.toLowerCase();
  if (show && (approval === 'pending' || approval === 'rejected')) approvalNotice(rb, content, out);
  out.text('\n\n');
  if (model.parentType.toLowerCase() === 'calendar') calendarNotices(ctx, content, out);
  // The token is rendered although `carch.approvalaction` short-circuits its CSRF check.
  const tokens = await ctx.csrf.tokens('approvalaction');
  out.text(`
<script>
function viewStatusInfo(contenthistid,siteid){

\tvar url = 'index.cfm';
\tvar pars = 'muraAction=cArch.statusmodal&compactDisplay=true&siteid=' + siteid  + '&contenthistid=' + contenthistid +'&cacheid=' + Math.random();
\tvar d = jQuery('#approvalModalContainer');
\td.html('<div class="load-inline"></div>');
\t//$('#approvalModalContainer .load-inline').spin(spinnerArgs2);
\t$.get(url + "?" + pars,
\t\tfunction(data) {
\t\t\tif(data.indexOf('mura-primary-login-token') != -1) {
\t\t\t\tlocation.href = './';
\t\t\t}
\t\t\t$('#approvalModalContainer .load-inline').spin(false);
\t\t\tjQuery('#approvalModalContainer').html(data);
\t\t\tstripe('stripe');
\t\t});

\t\t$("#approvalModalContainer").dialog({
\t\t\tresizable: false,
\t\t\tmodal: true,
\t\t\twidth: 600,
\t\t\tposition: { my: "center", at: "top+180", of: window, collision: "fit" }
\t\t});


\treturn false;
}

function applyApprovalAction(requestid,action,comment,siteid){

\tif(action == 'Reject' && comment == ''){
\t\talertDialog('`);
  out.value(encodeJs(rb.rbKey('approvalchains.rejectioncommentrequired')));
  out.text(`');
\t} else {
\t\t$('#mura-approval-apply').attr('disabled','disabled').css('opacity', '.30');

\t\t`);
  out.text(`
\t\tvar pars={
\t\t\t\t\tmuraAction:'carch.approvalaction',
\t\t\t\t\tsiteid: siteid,
\t\t\t\t\trequestid: requestid,
\t\t\t\t\tcomment: comment,
\t\t\t\t\taction:action,
\t\t\t\t\tcsrf_token:'`);
  out.value(tokens.token);
  out.text(`',
\t\t\t\t\tcsrf_token_expires: '`);
  out.value(tokens.expires);
  out.text(`'
\t\t\t\t};

\t\tactionModal(
\t\t\tfunction(){
\t\t\t\t$.post('index.cfm',
\t\t\t\t\tpars,
\t\t\t\t\tfunction(data) {
\t\t\t\t\t\tif(typeof(data) == 'string'){
\t\t\t\t\t\t\t$('html').html(data);
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tvar href = window.location.href.replace('`);
  out.value(content.contentHistId);
  out.text(`',data.contenthistid);
\t\t\t\t\t\t\t//alert(href)
\t\t\t\t\t\t\twindow.location = href;
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t).fail(function(data){
\t\t\t\t\t$('html').html(data);
\t\t\t\t});
\t\t\t}
\t\t);
\t}
}
</script>
`);
}

/** `carch/dsp_status.cfm`: the node lock notice and, when `showApprovalStatus` is defined, the approval status. */
export async function status(ctx: StatusContext, model: StatusModel): Promise<SafeHtml> {
  const out = new CfOutput();
  out.text('\n');
  if (model.hasLockableNodes) await lockNotice(ctx, model, out);
  out.text('\n');
  if (model.showApprovalStatus !== undefined) await approvalStatus(ctx, model, model.showApprovalStatus, out);
  out.text('\n');
  return raw(out.markup);
}
