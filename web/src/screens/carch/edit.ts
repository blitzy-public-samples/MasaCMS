// The `cArch.edit` page: carch/edit.cfm, the content editor around its settings panels, which `cArch.update` also
// renders after a save fails validation (server-only).
import {
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  isCfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { cfEq, isCompactDisplay } from '@/lib/cfml';
import { lsDateFormatString } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, raw, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, assignContext, type AdminRequest, type RequestContext } from '@/lib/request-context';
import { siteBeanOf, sitePaths } from '@/lib/site-paths';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { renderEditPanels, urlFormType, type EditPanelsResult } from './edit-panels';
import { renderChangesetsDialog } from './form/changesets';
import { cfListHas, type EditFormState, type SubTypeRow } from './form/custom-tags';
import { renderSiteFull } from './form/full';
import {
  COMPONENT_MODULE_ID,
  FORM_MODULE_ID,
  NODE_LEVEL_LIST,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
  extendedList,
  isDeletable,
  pageLevelList,
  permOf,
  structOf,
  structText,
  structValue,
  type CarchStruct,
  type NodePerm,
} from './model';
import { displayErrors } from './partials/display-errors';
import { carchJs } from './partials/js';
import { status, type StatusConflict, type StatusLockUser, type StatusModel } from './partials/status';
import { dspZoom } from './partials/zoom';
import {
  bindCarchSecondaryMenu,
  carchSecondaryMenuCsrfContexts,
  renderCarchSecondaryMenu,
  type CarchMenuContent,
  type CarchSecondaryMenuInput,
} from './secondary-menu';
import { carchPageData, type CarchPageModel } from './service';

// Besides what the panels read (edit-panels.ts), the edit model's `rc` supplies, case-insensitively and only where
// edit.cfm reads it:
// - `contentBean`: `getcontentVersion(rc.contenthistid, rc.siteid)` as the controller leaves it, with `isNew`,
//   `errors` (`getErrors()`) and `stats` (or `rc.stats`); `previewURL` where the menu links the version,
//   `displayIntervalDesc` and `displayConflicts` (`editURL`, `title`, `details` of `href` and `displayStart`) under a
//   Calendar parent. The view's own setters of a new node (title, remote id, type, subtype) run here;
// - `parentBean` (`type`), `crumbData`, `perm`, `site` (`locking`), and `lockedBy` when someone else holds the lock;
// - configBean `purgeDrafts`, `confirmSaveAsDraft`, `showExtensionsInDefault`; site `hasLockableNodes`,
//   `enforceChangesets`, `pageLimit` and `useLayoutManager`; `allowSimpleHTMLForms` and `resourcePath` as the menu
//   reads them;
// - `rsPageCount` (`counter`), `hasDrafts`, `requiresApproval`, `showApprovalStatus`, `approvalRequest` (`isNew`,
//   `status`), `currentChangeset` (`isNew`, `name`) and `pendingChangesets` (`contentHistID`, `changesetName`) on a
//   site with change sets, `draftcheck` (`showdialog`, `historyid`) of a stored node, the subtype's `hasSummary` and
//   `hasBody`, the user's `tabAssignments`, and the parent's `subtypeFilter` with the site's active `rsSubTypes`
//   (`type`, `subtype`, `adminonly`) where the type takes class extensions.
// A value the view reads that the model omits throws, as CFML fails on an undefined one.
// The markup is the view as ACF 2023 emits it: CFML comments are dropped with the text around them joined, template
// text holding non-whitespace is copied byte for byte, and whitespace-only text between two CFML constructs prints one
// space after output that does not end in whitespace, else nothing. The plugin message events print nothing: the CFML
// plugin runtime stays on legacy, so no `on<Type>EditMessageRender` handler reaches the target.

const OPERATION = 'strategies-content getContentEditModel';

/** Content types the closing script loads extended attributes for. */
const EXTENDED_ATTRIBUTE_TYPES = 'Page,Folder,Calendar,Gallery,Link,File,Component,Form';

/** Content types with the Preview action button. */
const PREVIEW_TYPES = 'Page,Folder,Calendar,Gallery';

/** Content types whose type selector offers only their own type. */
const SINGLE_BASE_TYPES = 'Component,File,Link,Form,Variation';

/** Types contentBean `setType` accepts. */
const SETTABLE_TYPES = 'Page,Folder,Calendar,Gallery,File,Link,Form,Component,Variation,Module';

/** Module root contentBean `setType` files a Form, Component or Variation under. */
const TYPE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  form: FORM_MODULE_ID,
  component: COMPONENT_MODULE_ID,
  variation: VARIATION_MODULE_ID,
});

/** `nodeLevelList`. */
const NODE_LEVEL = NODE_LEVEL_LIST.join(',');

/** The theme Masa start-up installs as `<webroot>/themes/default`, which the installed site uses. */
const INSTALLED_THEME = 'default';

/** Lines 139-146: the save-as-draft exit guard up to its prompt. */
const CONFIRM_EXIT_OPEN = `
\t<script>
\tsiteManager.requestedURL="";
\tsiteManager.formSubmitted=false;
\tsiteManager.doConditionalExit=true;
\t
\tfunction setRequestedURL(){
\t\tsiteManager.requestedURL=this.href
\t\treturn conditionalExit("`;

/** Lines 146-183: the anchor hook, the unload handler and conditionalExit up to its default message. */
const CONFIRM_EXIT_BODY = `");
\t}

\t$(document).ready(function(){
\t\tvar anchors=document.getElementsByTagName("A");

\t\tfor(var i=0;i<anchors.length;i++){
\t\t\ttry{
\t\t\t\tif (typeof(anchors[i].onclick) != 'function'
\t\t\t\t\t&& typeof(anchors[i].getAttribute('href')) == 'string'
\t\t\t\t\t&& anchors[i].getAttribute('href').indexOf('#') == -1
\t\t\t\t\t&& anchors[i].getAttribute('href').indexOf('mailto') == -1) {
\t\t\t\t\tif(!$(anchors[i]).hasClass("nav-submenu")){
\t\t\t\t\t   anchors[i].onclick = setRequestedURL;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t} catch(err){}
\t\t}

\t});
\t

\t$(document).on('unload',function(){
\t\tif(!siteManager.formSubmitted && siteManager.requestedURL != '')
\t\t{
\t\t\tconditionalExit();
\t\t}
\t});

\tfunction conditionalExit(msg){

\t\tif(!siteManager.doConditionalExit){
\t\t\treturn true;
\t\t}

\t\tif(siteManager.form_is_modified(document.contentForm)){
\t\tif(msg==null){
\t\t\tmsg="`;

/** Lines 183-190: the draft dialog up to its title. */
const CONFIRM_EXIT_DIALOG = `";
\t\t}

\t\tdocument.contentForm.approved.value=0;
\t\tjQuery("#alertDialog").html(msg);
\t\tjQuery("#alertDialog").dialog({
\t\t\t\tdialogClass: "dialog-info",
\t\t\t\ttitle:"`;

/** Lines 190-225: the dialog buttons and the script close. */
const CONFIRM_EXIT_CLOSE = `",
\t\t\t\twidth: 400,
\t\t\t\tresizable: false,
\t\t\t\tmodal: true,
\t\t\t\tposition: getDialogPosition(),
\t\t\t\tbuttons: {
\t\t\t\t\t'No': function() {
\t\t\t\t\t\tjQuery(this).dialog('close');
\t\t\t\t\t\tlocation.href=siteManager.requestedURL;
\t\t\t\t\t\tsiteManager.requestedURL="";
\t\t\t\t\t},
\t\t\t\t\tYes:
\t\t\t\t\t\t{click: function() {
\t\t\t\t\t\t\tjQuery(this).dialog('close');
\t\t\t\t\t\t\tif(siteManager.ckContent()){
\t\t\t\t\t\t\t\tdocument.getElementById('contentForm').returnURL.value=siteManager.requestedURL;
\t\t\t\t\t\t\t\tsubmitForm(document.contentForm,'add');
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\treturn false;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t, text: 'Yes'
\t\t\t\t\t\t, class: 'mura-primary'
\t\t\t\t\t\t} // /yes
\t\t\t\t}

\t\t\t});

\t\t\treturn false;

\t\t} else {
\t\t\tsiteManager.requestedURL="";
\t\t\treturn true;
\t\t}

\t}
\t</script>
`;

/** Lines 227-241: the compact editor asks the front-end proxy for the standard width. */
const COMPACT_WIDTH_SCRIPT = `
\t<script type="text/javascript">
\tjQuery(document).ready(function(){
\t\tif (top.location != self.location) {
\t\t\tif(jQuery("#ProxyIFrame").length){
\t\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\t\tfunction(){
\t\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t\t}
\t\t\t\t);
\t\t\t} else {
\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t}
\t\t}
\t});
\t</script>
`;

/** Lines 266-299: the BigUI set-up up to its URL trigger. */
const BIGUI_SCRIPT = `



<script type="text/javascript">
\t$(document).ready(function(){

\t\t// create hidden BigUI with button, close link
\t\tvar renderBigUI = function(el){
\t\t\tvar idstr = $(el).attr('id');
\t\t\tvar labelstr = $(el).attr('data-label');
\t\t\t$(el).before('<a class="bigui__launch" data-rel="' + idstr + '" href="#">' + labelstr + '</a>');
\t\t\t
\t\t\t$(el).prepend('<a class="bigui__close">Done <i class="mi-angle-right"></i></a>')
\t\t\t$(el).wrapInner('<div class="bigui__wrapper"></div>');
\t\t\t$(el).detach().appendTo('#mura-content-body-block .tab-content');
\t\t}

\t\t// set up all BigUI elements
\t\t$('.bigui').each(function(){
\t\t\trenderBigUI($(this));
\t\t})

\t\t$('.bigui__launch').on('click',function(){
\t\t\tvar rel = $(this).attr('data-rel');
\t\t\t$('.bigui').hide();
\t\t\t$('#' + rel).show();
\t\t\treturn false;
\t\t});

\t\t$('.bigui__close').on('click',function(){
\t\t\t$(this).parents('.bigui').hide();
\t\t})

\t\t// trigger via URL
\t\t`;

/** Lines 302-303: the timed trigger of the `bigui` panel, up to its name. */
const BIGUI_TRIGGER_OPEN = `
\t\tsetTimeout(function(){
\t\t\tvar panel = '#panel-`;

/** Lines 303-305. */
const BIGUI_TRIGGER_CLICK = `';
\t\t\t$(panel).find('.bigui__launch').trigger('click');
\t\t\t`;

/** Line 306: the schedule panel also shows its dates. */
const BIGUI_SCHEDULE = `
\t\t\t\t$('#editDates').show();
\t\t\t`;

/** Lines 307-309. */
const BIGUI_TRIGGER_CLOSE = `
\t\t}, 500);
\t\t`;

/** Lines 310-314. */
const BIGUI_SCRIPT_CLOSE = `


\t});
</script>
`;

/** Lines 400-404: the action bar up to the Save Draft label. */
const ACTIONS_OPEN = `
\t<div class="mura-actions">
\t\t<div class="form-actions">

\t\t\t <button type="button" class="btn" onclick="return saveDraftPrompt();"><i class="mi-edit"></i> `;

/** Line 407: the Preview button up to its label. */
const PREVIEW_BUTTON = `
\t\t\t<button type="button" class="btn" onclick="document.contentForm.approved.value=0;document.contentForm.preview.value=1;if(siteManager.ckContent(draftremovalnotice)){submitForm(document.contentForm,'add');}"><i class="mi-eye"></i> `;

/** Lines 409-411: the Save to Change Set button up to its class list. */
const CHANGESET_BUTTON_OPEN = `

\t\t\t\t<button type="button" class="btn`;

/** Line 411: its handler up to the change set id. */
const CHANGESET_BUTTON_ONCLICK = `" onclick="document.contentForm.approved.value=0;saveToChangeset('`;

/** Line 421: the Publish button up to its class list. */
const PUBLISH_BUTTON_OPEN = `
\t\t\t\t<button type="button" class="btn`;

/** Line 421: its handler. */
const PUBLISH_BUTTON_ONCLICK = `" onclick="document.contentForm.approved.value=1;if(siteManager.ckContent(draftremovalnotice)){submitForm(document.contentForm,'add');}">
\t\t\t\t\t`;

/** Lines 428-433. */
const ACTIONS_CLOSE = `

\t\t\t</div>
\t\t</div>

\t`;

/** Lines 477-483: the header close and the status container open. */
const HEADER_CLOSE = `

</div> <!-- /.mura-header -->

<div id="dspStatusContainer">

\t`;

/** Lines 534-541: the form and the body block open. */
const FORM_OPEN = `


\t<form novalidate="novalidate" action="index.cfm" method="post" enctype="multipart/form-data" name="contentForm" onsubmit="return ckContent(draftremovalnotice);" id="contentForm">

\t
\t
\t<div class="block block-constrain" id="mura-content-body-block">

\t\t
\t\t`;

/** Lines 541-548: the tab content open up to the edit box id. */
const TAB_CONTENT_OPEN = `

\t\t<!-- tab content -->
\t\t<div class="block-content tab-content">

\t\t\t
\t\t\t
\t\t\t<div id="`;

/** Lines 548-549: the title render area up to its placeholder. */
const TITLE_RENDER_OPEN = `">
\t\t\t\t<div id="mura-content-title-render" data-placeholder="`;

/** Line 551: the Link and File body render area. */
const BODY_RENDER_INNER_OPEN = `
\t\t\t\t\t<div id="mura-content-body-render" style="display:none;"><div id="mura-content-body-inner">`;

/** Line 553: every other body render area. */
const BODY_RENDER_OPEN = `
\t\t\t\t\t<div id="mura-content-body-render" style="display:none;">`;

/** Lines 555-566: the extended attributes container of the edit box. */
const EXTENSIONS_BASIC = `
\t\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-basic">
\t\t\t\t\t\t<div id="bigui__basic" data-label="Manage Extended Attributes">
\t\t\t\t\t\t\t<div class="bigui__controls">
\t\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>
\t\t\t\t\t\t\t\t<span id="extendset-container-basic" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-basic"></span>
\t\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t
\t\t\t\t\t</div>
\t\t\t\t`;

/** Lines 566-575: the edit box close, the tab preloader and the tab content close. */
const PRELOADER = `
\t\t\t</div>


\t\t\t<div class="load-inline tab-preloader"></div>
\t\t\t<script>$('.tab-preloader').spin(spinnerArgs2);</script>


\t\t</div><!-- /block-content tab content -->
\t\t`;

/** Lines 587-591: saveDraftPrompt up to its question. */
const SAVE_DRAFT_PROMPT_OPEN = `

saveDraftPrompt=function(){
\tconfirmDialog(
\t\t'`;

/** Lines 591-631: the prompt handlers and checkForSave up to its keep-editing line. */
const CHECK_FOR_SAVE_OPEN = `',
\t\tfunction(){
\t\t\tif(siteManager.ckContent(draftremovalnotice,true)){
\t\t\t\tdocument.contentForm.approved.value=0;
\t\t\t\tdocument.contentForm.preview.value=0;
\t\t\t\tdocument.contentForm.murakeepediting.value=true;
\t\t\t\tsubmitForm(document.contentForm,'add');
\t\t\t}
\t\t},
\t\tfunction(){
\t\t\tif(siteManager.ckContent(draftremovalnotice,true)){
\t\t\t\tdocument.contentForm.approved.value=0;
\t\t\t\tdocument.contentForm.preview.value=0;
\t\t\t\tdocument.contentForm.murakeepediting.value=false;
\t\t\t\tsubmitForm(document.contentForm,'add');
\t\t\t}
\t\t},
\t\t'','','Yes','No'
\t);
}

\tvar shifted=false;
\tvar lockedbysomeonelse=false;

\tcheckForSave=function(e) {
  \tif (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
    \te.preventDefault();
\t   \tif(!lockedbysomeonelse){
\t   \t\tif(e.altKey){
\t\t\t\tdocument.contentForm.approved.value=1;
\t\t\t} else {
\t\t\t\tdocument.contentForm.approved.value=0;
\t\t\t}

\t\t\tif(e.shiftKey){
\t\t\t\tdocument.contentForm.preview.value=1;
\t\t\t} else {
\t\t\t\tdocument.contentForm.preview.value=0;
\t\t\t}

\t\t\t`;

/** Lines 631-633: outside the compact editor the shortcut keeps editing. */
const KEEP_EDITING = `
\t\t\tdocument.contentForm.murakeepediting.value=true;
\t\t\t`;

/** Lines 633-675: the shortcut submit, the keydown hook and the live title editor up to its stored-node line. */
const TITLE_EDITOR_OPEN = `

\t\t    if(siteManager.ckContent(draftremovalnotice,true)){
\t\t\t\tsubmitForm(document.contentForm,'add');
\t\t\t} else {
\t\t\t\tdocument.contentForm.approved.value=0;
\t\t\t\tdocument.contentForm.murakeepediting.value=false;
\t\t\t\tdocument.contentForm.preview.value=0;
\t\t\t\tdocument.contentForm.approved.value=0;
\t\t\t}

\t\t}
\t}
}

//This will throw an error under crossdomain
try{
\twindow.top.document.addEventListener("keydown", checkForSave , false);
} catch (e){};

// Click to edit live title
var titleBlock = document.getElementById('mura-content-title-render');
var realTitle = document.getElementById('title');
titleBlock.onclick = function(event){

\tif (titleBlock.className != 'editing'){
\t\tvar holder = document.createElement('input');
\t\tholder.style.width = titleBlock.clientWidth + 'px';
\t\tholder.style.height = titleBlock.clientHeight + 'px';
\t\tholder.value = decodeHTMLEntities(titleBlock.innerHTML);
\t\ttitleBlock.innerHTML = '';
\t\ttitleBlock.appendChild(holder);
\t\ttitleBlock.className = 'editing';
\t\tholder.focus();

\t\tholder.onkeyup = function(event){
\t\t\tvar newTitle = decodeHTMLEntities(holder.value);
\t\t\tvar realTitle = document.getElementById('title');
\t\t\trealTitle.value = newTitle;
\t\t\tif (!($('#panel-basic').hasClass('in'))){
\t\t\t\t$('#heading-basic h4 a').trigger('click');
\t\t\t}
\t\t\t`;

/** Lines 677-724: the title editor close, the copy helpers and the first hidden fields. */
const FORM_SCRIPT_CLOSE = `
\t\t}

\t\tholder.onblur = function(event){
\t\t\ttitleBlock.innerHTML = encodeHTMLEntities(holder.value);
\t\t\ttitleBlock.className = '';
\t\t}

\t}
}
// Update live title when editing input
realTitle.onkeyup = function(event){
\ttitleBlock.innerHTML = encodeHTMLEntities(realTitle.value);
\ttitleBlock.className = '';
}

function encodeHTMLEntities(text) {
  var textArea = document.createElement('textarea');
  textArea.innerText = text;
  return textArea.innerHTML;
}

function decodeHTMLEntities(text) {
  var textArea = document.createElement('textarea');
  textArea.innerHTML = text;
  return textArea.value;
}

function copyToClipboard(str){
\tvar holder = '<textarea style="position:absolute; top:500px; left: -8000px;" id="ctc_holder">' + $.trim(str) + '</textarea>';
\t$('#ctc_holder').remove();
\t$(holder).appendTo('body').select();
\tdocument.execCommand('copy');
}

$('.clicktocopy').prepend('<i class="mi-copy" title="Click to copy"></i>');

$('.clicktocopy').click(function(){
\tvar copiedicon = '<i class="mi-check" title="Copied to clipboard"></i>';
\tcopyToClipboard($(this).text());
\t$(this).find('i').remove();
\t$(this).prepend(copiedicon);
})

</script>

\t<input name="approved" type="hidden" value="0">
\t<input name="muraPreviouslyApproved" type="hidden" value="`;

/** Lines 724-729: the change set and preview fields. */
const HIDDEN_CHANGESET_FIELDS = `">
\t<input id="removePreviousChangeset" name="removePreviousChangeset" type="hidden" value="false">
\t<input id="changesetID" name="changesetID" type="hidden" value="">
\t<input id="changesetname" name="changesetname" type="hidden" value="">
\t<input name="preview" type="hidden" value="0">
\t`;

/** Lines 740-742: the action field and the site id field up to its value. */
const HIDDEN_ACTION_FIELDS = `
\t<input name="action" type="hidden" value="add">
\t<input type="hidden" name="siteid" value="`;

/** Lines 754-756: the update action and the start row field up to its value. */
const HIDDEN_UPDATE_FIELDS = `">
\t<input type="hidden" name="muraAction" value="cArch.update">
\t<input type="hidden" name="startrow" value="`;

/** Lines 758-763: the approval, keep-editing, file metadata and unlock fields. */
const HIDDEN_FLAG_FIELDS = `">
\t<input type="hidden" name="cancelpendingapproval" value="false">
\t<input type="hidden" name="murakeepediting" value="false">
\t<input type="hidden" name="filemetadataassign" id="filemetadataassign" value=""/>
\t<input type="hidden" id="unlocknodewithpublish" name="unlocknodewithpublish" value="false" />
\t`;

const NO_BREAK_SPACES: ReadonlySet<string> = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one UTF-16 unit. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/** The view's output buffer under ACF whitespace management. */
class ViewOutput {
  #out = '';

  /** Template text holding non-whitespace, or a value: written verbatim. */
  t(text: string): this {
    this.#out += text;
    return this;
  }

  /** Whitespace-only template text between two CFML constructs: one space after non-whitespace, else nothing. */
  ws(): this {
    if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

// ---- Model reads ----

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A model value the view reads; throws when the model omits it. */
function modelValue(struct: CarchStruct, key: string, owner: string): unknown {
  const value = structValue(struct, key);
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no ${owner}.${key}`);
  return value;
}

/** A CFML boolean the view tests; throws when the model omits it or CFML cannot read it as a boolean. */
const modelFlag = (struct: CarchStruct, key: string, owner = 'rc'): boolean =>
  cfToBoolean(modelValue(struct, key, owner));

/** A simple value the view prints or compares; throws when the model omits it. */
function modelText(struct: CarchStruct, key: string, owner = 'rc'): string {
  modelValue(struct, key, owner);
  return structText(struct, key);
}

/** A nested struct the view reads; throws when the model omits it or holds something else. */
function modelStruct(struct: CarchStruct, key: string, owner = 'rc'): CarchStruct {
  const value = modelValue(struct, key, owner);
  if (!isStruct(value)) throw new TypeError(`${OPERATION} returned ${owner}.${key} that is not a struct`);
  return value;
}

/** Query rows the view loops over; throws unless the model holds an array of structs. */
function modelRows(struct: CarchStruct, key: string, owner = 'rc'): readonly CarchStruct[] {
  const value = modelValue(struct, key, owner);
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned ${owner}.${key} that is not a list of rows`);
  }
  return value;
}

/** A CFML boolean the model may omit, for an input the secondary menu reads only on some branches. */
function optionalFlag(struct: CarchStruct, key: string): boolean | undefined {
  const value = structValue(struct, key);
  return value === undefined || value === null ? undefined : cfToBoolean(value);
}

/** A string the model may omit. */
function optionalText(struct: CarchStruct, key: string): string | undefined {
  const value = structValue(struct, key);
  return typeof value === 'string' ? value : undefined;
}

/** `rc[name]`; throws when absent, as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** `$.event(name)`: the rc value, `''` when absent. */
const eventValue = (rc: RequestContext, name: string): string => rc[name] ?? '';

/** `struct` with `value` under the member CFML resolves for `key`, added when absent. */
function withMember(struct: CarchStruct, key: string, value: unknown): CarchStruct {
  const lower = key.toLowerCase();
  const name = Object.hasOwn(struct, key) ? key : (Object.keys(struct).find((k) => k.toLowerCase() === lower) ?? key);
  return { ...struct, [name]: value };
}

/** CFML `a lt b`: numerically when both are numeric, else as text without regard to case. */
function cfLessThan(a: string, b: string): boolean {
  if (cfIsNumeric(a) && cfIsNumeric(b)) return cfToNumber(a) < cfToNumber(b);
  return a.toLowerCase() < b.toLowerCase();
}

/** CFML `replace(text, find, by)`: the first case-sensitive occurrence replaced. */
function replaceFirst(text: string, find: string, by: string): string {
  const at = find === '' ? -1 : text.indexOf(find);
  return at < 0 ? text : text.slice(0, at) + by + text.slice(at + find.length);
}

// Without the gateway's request-target header the URL scope stands in, as the nav reads it.
/** `cgi.query_string`: the forwarded request target's query, byte for byte. */
function cgiQueryString(req: AdminRequest): string {
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return req.currentUrl.replace(/^\.\/\??&?/, '');
  const queryAt = target.indexOf('?');
  return queryAt < 0 ? '' : target.slice(queryAt + 1);
}

/** `settingsManager.getSite(rc.siteID).getThemeAssetPath()` for the session site, which carch keeps as `rc.siteID`. */
function themeAssetPath(req: AdminRequest): string {
  if (req.site === undefined) return `${legacySettings().context}/themes/${INSTALLED_THEME}`;
  return sitePaths(req, siteBeanOf(req.site)).themeAssetPath('webRoot', false);
}

// ---- The view's setters ----

/** contentBean `setType`: Portal reads as Folder; a listed new type replaces the bean's and files a module type. */
function setType(bean: CarchStruct, requested: string): CarchStruct {
  const type = javaTrim(cfEq(requested, 'Portal') ? 'Folder' : requested);
  if (type === '' || cfEq(structText(bean, 'type'), type) || !cfListHas(SETTABLE_TYPES, type, { noCase: true })) {
    return bean;
  }
  // The bean's cached extended data, which setType purges, is not part of the model.
  const typed = withMember(bean, 'type', type);
  const moduleId = TYPE_MODULES[type.toLowerCase()];
  if (moduleId === undefined) return typed;
  const filed = withMember(typed, 'moduleID', moduleId);
  return isCfUuid(structText(filed, 'parentID')) ? filed : withMember(filed, 'parentID', moduleId);
}

/**
 * Lines 98-111: a new node takes the request's title (`setTitle` keeps a non-blank trimmed one), remote id, type and
 * subtype (trimmed, as bean `setValue` stores them). Line 353 repeats the subtype for the same test, to the same value.
 */
function newNodeBean(bean: CarchStruct, rc: RequestContext): CarchStruct {
  let next = bean;
  const title = javaTrim(rc.title ?? '');
  if (title !== '') next = withMember(next, 'title', title);
  const remoteId = rc.remoteid ?? '';
  if (remoteId !== '') next = withMember(next, 'remoteID', javaTrim(remoteId));
  const type = rc.type ?? '';
  if (type !== '') next = setType(next, type);
  const subType = rc.subtype ?? '';
  if (subType !== '') next = withMember(next, 'subType', javaTrim(subType));
  return next;
}

// ---- View state ----

/** The change sets edit.cfm reads on a site that has them. */
interface ChangesetState {
  /** `changesetManager.read(contentBean.getChangesetID())`. */
  readonly currentIsNew: boolean;
  readonly currentName: string;
  /** `changesetManager.getPendingByContentID(contentID, siteID)`. */
  readonly pending: readonly CarchStruct[];
}

/** What edit.cfm computes before its first output, and the request and model as it leaves them. */
interface EditScope {
  readonly ctx: ScreenContext;
  /** The request with `rc.parentID` as the view defaults it. */
  readonly req: AdminRequest;
  readonly rc: RequestContext;
  /** The edit model with the view's content bean. */
  readonly data: CarchPageModel;
  readonly model: CarchStruct;
  readonly bean: CarchStruct;
  readonly isNew: boolean;
  /** `rc.compactDisplay eq "true"`. */
  readonly compact: boolean;
  /** `rc.type`. */
  readonly type: string;
  readonly stats: CarchStruct;
  readonly perm: NodePerm;
  readonly hasLockableNodes: boolean;
  readonly requiresApproval: boolean;
  readonly showApprovalStatus: boolean;
  /** Present when the site has change sets. */
  readonly changesets: ChangesetState | undefined;
  readonly assignChangesets: boolean;
  readonly deletable: boolean;
  readonly parentBean: CarchStruct;
  readonly state: EditFormState;
  readonly label: (key: string) => string;
}

/** One `rsSubTypes` row as the panels read it. */
function subTypeRow(row: CarchStruct): SubTypeRow {
  const adminOnly = structText(row, 'adminonly');
  return {
    type: structText(row, 'type'),
    subtype: structText(row, 'subtype'),
    adminonly: adminOnly === '' ? 0 : cfToNumber(adminOnly),
  };
}

/**
 * Lines 326-344: the query of queries over the site's active subtypes. Without a parent filter, or for a type outside
 * `nodeLevelList`, every subtype of an extendable type or `Base`; else each filter entry's `type/subtype`. Query of
 * queries compares text with case.
 * @throws Error As the query does, when the filter's entries leave its `OR` list malformed.
 */
function filteredSubTypes(
  rows: readonly CarchStruct[],
  subtypeFilter: string,
  rcType: string,
  extended: string,
): SubTypeRow[] {
  const all = rows.map(subTypeRow);
  if (subtypeFilter === '' || !cfListHas(NODE_LEVEL, rcType)) {
    const types = cfListToArray(extended);
    return all.filter((row) => types.includes(row.type) || row.type === 'Base');
  }
  const entries = cfListToArray(subtypeFilter);
  const [first] = entries;
  // An entry equal to the first one is written without its `OR`, as is every entry of a filter with none.
  if (first === undefined || entries.slice(1).some((entry) => cfEq(entry, first))) {
    throw new Error(
      `Query Of Queries syntax error: the subtype filter '${subtypeFilter}' leaves the WHERE clause malformed`,
    );
  }
  const wanted = entries.map((entry) => {
    const parts = cfListToArray(entry, '/');
    return [parts[0] ?? '', parts.at(-1) ?? ''] as const;
  });
  return all.filter((row) => wanted.some(([type, subtype]) => row.type === type && row.subtype === subtype));
}

/** Lines 315-363: the class-extension state of the panels, empty for a type outside `extendedList`. */
function extensionState(
  model: CarchStruct,
  rcType: string,
  pageLevel: string,
  extended: string,
  subtypeFilter: string,
): Pick<EditFormState, 'baseTypeList' | 'subTypes' | 'isExtended'> {
  if (!cfListHas(extended, rcType, { noCase: true })) return { baseTypeList: '', subTypes: [], isExtended: false };
  const subTypes = filteredSubTypes(modelRows(model, 'rsSubTypes'), subtypeFilter, rcType, extended);
  return {
    baseTypeList: cfListHas(SINGLE_BASE_TYPES, rcType, { noCase: true }) ? rcType : pageLevel,
    subTypes,
    isExtended: subTypes.length > 0,
  };
}

/** The session site's `hasChangesets`; throws when programs-sites served the user no session site. */
function hasChangesetsOf(req: AdminRequest): boolean {
  if (req.site === undefined) throw new TypeError(`programs-sites served no site ${req.session.siteid} for carch.edit`);
  return req.site.hasChangesets;
}

/** Lines 123-126: the version's change set and the node's pending ones. */
function changesetState(model: CarchStruct): ChangesetState {
  const current = modelStruct(model, 'currentChangeset');
  return {
    currentIsNew: modelFlag(current, 'isNew', 'currentChangeset'),
    currentName: structText(current, 'name'),
    pending: modelRows(model, 'pendingChangesets'),
  };
}

/** Lines 76-131: the lists, flags and request values edit.cfm sets before its first output. */
function editScope(ctx: ScreenContext, data: CarchPageModel): EditScope {
  const model = data.rc;
  const served = structOf(model, 'contentBean');
  const isNew = modelFlag(served, 'isNew', 'contentBean');
  // Lines 82-88 test the type the bean was loaded with, before a new node takes the requested one.
  const servedType = structText(served, 'type');
  const pageLevel = pageLevelList(servedType).join(',');
  const extended = extendedList(servedType).join(',');
  const hasChangesets = hasChangesetsOf(ctx.req);
  const stats = isStruct(structValue(model, 'stats'))
    ? modelStruct(model, 'stats')
    : modelStruct(served, 'stats', 'contentBean');
  const perm = permOf(data);
  let { rc } = ctx.req;
  if (cfEq(rcText(rc, 'parentid'), '') && !isNew) rc = assignContext(rc, { parentid: structText(served, 'parentID') });
  const req: AdminRequest = rc === ctx.req.rc ? ctx.req : { ...ctx.req, rc };
  const bean = isNew ? newNodeBean(served, rc) : served;
  const parentBean = modelStruct(model, 'parentBean');
  const subtypeFilter = modelText(model, 'subtypeFilter');
  const requiresApproval = modelFlag(model, 'requiresApproval');
  const showApprovalStatus = modelFlag(model, 'showApprovalStatus');
  const changesets = hasChangesets ? changesetState(model) : undefined;
  const compactDisplay = rcText(rc, 'compactDisplay');
  const compact = isCompactDisplay(compactDisplay);
  const deletable =
    !compact &&
    isDeletable({
      compactDisplay,
      parentId: rcText(rc, 'parentid'),
      contentId: rcText(rc, 'contentid'),
      siteLocking: modelText(modelStruct(model, 'site'), 'locking', 'site'),
      perm,
      isLocked: structText(bean, 'isLocked'),
    });
  const assignChangesets = cfEq(perm, 'editor') && hasChangesets;
  const tabAssignments = modelText(model, 'tabAssignments');
  const type = rcText(rc, 'type');
  const viewModel = withMember(model, 'contentBean', bean);
  return {
    ctx,
    req,
    rc,
    data: { ...data, rc: viewModel },
    model: viewModel,
    bean,
    isNew,
    compact,
    type,
    stats,
    perm,
    hasLockableNodes: modelFlag(model, 'hasLockableNodes'),
    requiresApproval,
    showApprovalStatus,
    changesets,
    assignChangesets,
    deletable,
    parentBean,
    state: {
      tabAssignments,
      pageLevelList: pageLevel,
      ...extensionState(model, type, pageLevel, extended, subtypeFilter),
      subtypeFilter,
      requiresApproval,
      showApprovalStatus,
      hasChangesets,
      ptype: rcText(rc, 'ptype'),
      compactDisplay,
      preview: rcText(rc, 'preview'),
    },
    label: (key) => ctx.rb.rbKey(key),
  };
}

/** `(hasChangesets and (not currentChangeset.getIsNew() or pendingChangesets.recordcount)) or len(changesetID)`. */
function inChangeset(s: EditScope): boolean {
  const { changesets } = s;
  const pendingOrCurrent = changesets !== undefined && (!changesets.currentIsNew || changesets.pending.length > 0);
  return pendingOrCurrent || structText(s.bean, 'changesetID') !== '';
}

// ---- Markup ----

/** Lines 132-136: the draft removal notice and the node lock flags. */
function lockScript(o: ViewOutput, s: EditScope): void {
  const { model, rc, label } = s;
  o.t('\n<script>\n\tvar draftremovalnotice=');
  const notice =
    modelFlag(model, 'purgeDrafts') &&
    !cfEq(eventValue(rc, 'suppressDraftNotice'), 'true') &&
    modelFlag(model, 'hasDrafts') &&
    !s.requiresApproval;
  o.t(notice ? `'${encodeJs(label('sitemanager.content.draftremovalnotice'))}'` : '""');
  o.t(';\n\t\tsiteManager.hasNodeLock=');
  o.t(cfEq(structText(s.stats, 'lockType'), 'node') ? 'true' : 'false');
  o.t(';\n\t\tsiteManager.unlocknodeconfirm="');
  o.t(encodeJs(label('sitemanager.content.fields.unlocknodeconfirm')));
  o.t('";\n</script>\n\n');
}

/** Lines 138-242: the save-as-draft exit guard outside the compact editor, the width request inside it. */
function exitScript(o: ViewOutput, s: EditScope): void {
  if (!s.compact && modelFlag(s.model, 'confirmSaveAsDraft')) {
    const saveAsDraft = encodeJs(s.label('sitemanager.content.saveasdraft'));
    o.t(CONFIRM_EXIT_OPEN).t(saveAsDraft).t(CONFIRM_EXIT_BODY).t(saveAsDraft).t(CONFIRM_EXIT_DIALOG);
    o.t(encodeJs(s.label('sitemanager.content.savedraft'))).t(CONFIRM_EXIT_CLOSE);
  } else if (s.compact) {
    o.t(COMPACT_WIDTH_SCRIPT);
  }
}

/** Lines 244-256: whether the version waits on a pending approval request. */
function approvalScript(o: ViewOutput, s: EditScope): void {
  o.t('\n\n<script>\n\t');
  if (s.requiresApproval || s.showApprovalStatus) {
    o.ws();
    const request = modelStruct(s.model, 'approvalRequest');
    o.ws();
    if (!modelFlag(request, 'isNew', 'approvalRequest') && cfEq(structText(request, 'status'), 'Pending')) {
      o.t('\n\t\t\tvar pendingApproval=true;\n\t\t\tvar cancelPendingApproval=');
      o.t(`'${encodeJs(s.label('approvalchains.cancelPendingApproval'))}'`).t(';\n\t\t');
    } else {
      o.t('\n\t\t\tvar pendingApproval=false;\n\t\t');
    }
    o.ws();
  } else {
    o.t('\n\t\tvar pendingApproval=false;\n\t');
  }
  o.t('\n</script>\n\n');
}

/** Lines 258-314: the subtype's summary and body flags, then the BigUI script and its `rc.bigui` trigger. */
function editorScripts(o: ViewOutput, s: EditScope): void {
  o.ws();
  o.t('\n\t<script type="text/javascript">\n\t\tvar hasSummary=').t(modelText(s.model, 'hasSummary'));
  o.t(';\n\t\tvar hasBody=').t(modelText(s.model, 'hasBody')).t(';\n\t</script>\n');
  o.t(BIGUI_SCRIPT).ws();
  const bigui = eventValue(s.rc, 'bigui');
  if (bigui !== '') {
    // The panel name is printed unencoded into the script, as legacy prints it.
    o.t(BIGUI_TRIGGER_OPEN).t(bigui).t(BIGUI_TRIGGER_CLICK);
    if (cfEq(bigui, 'schedule')) o.t(BIGUI_SCHEDULE);
    o.t(BIGUI_TRIGGER_CLOSE);
  }
  o.ws().t(BIGUI_SCRIPT_CLOSE);
}

/** Lines 399-434: the `actionButtons` the view saves before its page-limit test and prints below the panels. */
function actionButtons(s: EditScope): string {
  const { label, requiresApproval } = s;
  const b = new ViewOutput();
  b.ws().t(ACTIONS_OPEN).t(encodeHtml(label('sitemanager.content.savedraft'))).t('</button>\n\n\t\t\t');
  if (cfListHas(PREVIEW_TYPES, s.type, { noCase: true })) {
    b.t(PREVIEW_BUTTON).t(encodeHtml(label('sitemanager.content.savedraftandpreview'))).t('</button>\n\t\t\t');
  }
  b.ws();
  if (s.assignChangesets) {
    b.t(CHANGESET_BUTTON_OPEN);
    if (inChangeset(s)) b.t(' mura-primary');
    // The change set id is printed unencoded, as legacy prints it.
    b.t(CHANGESET_BUTTON_ONCLICK).t(structText(s.bean, 'changesetID')).t("','").t(encodeHtml(rcText(s.rc, 'siteid')));
    b.t("','');return false;\">\n\t\t\t\t\t").t('\n\t\t\t\t\t\t<i class="mi-list-alt"></i> ');
    const key = requiresApproval ? 'savetochangesetandsendforapproval' : 'savetochangeset';
    b.t(encodeHtml(label(`sitemanager.content.${key}`))).ws().t('\n\t\t\t\t</button>\n\t\t\t');
  }
  b.ws();
  if (cfEq(s.perm, 'editor') && !modelFlag(s.model, 'enforceChangesets')) {
    b.t(PUBLISH_BUTTON_OPEN);
    if (!inChangeset(s)) b.t(' mura-primary');
    b.t(PUBLISH_BUTTON_ONCLICK);
    if (requiresApproval) {
      b.t('\n\t\t\t\t\t\t<i class="mi-share-alt"></i> ').t(encodeHtml(label('sitemanager.content.sendforapproval')));
    } else {
      b.t('\n\t\t\t\t\t\t<i class="mi-check"></i> ').t(encodeHtml(label('sitemanager.content.publish')));
    }
    b.ws().t('\n\t\t\t\t</button>\n\t\t\t');
  }
  return b.t(ACTIONS_CLOSE).ws().toString();
}

/** `rc.contentBean` as the secondary menu reads it. */
function menuContent(s: EditScope): CarchMenuContent {
  const { bean } = s;
  const previewUrl = optionalText(bean, 'previewURL');
  return {
    isNew: s.isNew,
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    active: Number(structText(bean, 'active')),
    filename: structText(bean, 'filename'),
    contentHistId: structText(bean, 'contentHistID'),
    parentId: structText(bean, 'parentID'),
    menuTitle: structText(bean, 'menuTitle'),
    remoteUrl: structText(bean, 'remoteURL'),
    fileId: structText(bean, 'fileID'),
    stats: s.stats,
    ...(previewUrl === undefined ? {} : { previewUrl }),
  };
}

/** The secondary menu's input: the view's rc and bean, its verdicts and the settings the reached branch reads. */
function menuInput(s: EditScope): CarchSecondaryMenuInput {
  const useLayoutManager = optionalFlag(s.model, 'useLayoutManager');
  const purgeDrafts = optionalFlag(s.model, 'purgeDrafts');
  const allowSimpleHTMLForms = optionalFlag(s.model, 'allowSimpleHTMLForms');
  const resourcePath = optionalText(s.model, 'resourcePath');
  return {
    rc: s.rc,
    content: menuContent(s),
    perm: s.perm,
    deletable: s.deletable,
    hasLockableNodes: s.hasLockableNodes,
    ...(useLayoutManager === undefined ? {} : { useLayoutManager }),
    ...(purgeDrafts === undefined ? {} : { purgeDrafts }),
    ...(allowSimpleHTMLForms === undefined ? {} : { allowSimpleHTMLForms }),
    ...(resourcePath === undefined ? {} : { resourcePath }),
  };
}

/** `rc.type eq "Component"`, `"Form"` and `"Variation"`, else content: the heading's label key suffix. */
function headingKind(type: string): string {
  if (cfEq(type, 'Component')) return 'component';
  if (cfEq(type, 'Form')) return 'form';
  if (cfEq(type, 'Variation')) return 'variation';
  return 'content';
}

/** Lines 440-483: the heading per type, the secondary menu and, outside the compact editor, the breadcrumb. */
function header(o: ViewOutput, s: EditScope, showMenu: boolean): void {
  const { ctx } = s;
  o.t('\n\t\n\t<div class="mura-header">\n\t').ws();
  const label = s.label(`sitemanager.content.${s.isNew ? 'create' : 'edit'}${headingKind(s.type)}`);
  o.t('\n\t\t\t<h1>').t(label).t('</h1>\n\t\t').ws().ws();
  if (showMenu) {
    const menu = menuInput(s);
    bindCarchSecondaryMenu(ctx, menu);
    o.ws().t(renderCarchSecondaryMenu(ctx, menu).value).ws();
  }
  o.ws();
  if (!s.compact) {
    const crumbdata = modelRows(s.model, 'crumbData');
    o.ws().t(dspZoom(ctx, { crumbdata, class: 'breadcrumb' }).value).ws();
  }
  o.t(HEADER_CLOSE);
}

/** `getDisplayConflicts()`, which dsp_status.cfm reads under a Calendar parent. */
function displayConflicts(bean: CarchStruct): StatusConflict[] {
  return modelRows(bean, 'displayConflicts', 'contentBean').map((conflict) => ({
    editUrl: modelText(conflict, 'editURL', 'displayConflicts'),
    title: structText(conflict, 'title'),
    details: modelRows(conflict, 'details', 'displayConflicts').map((detail) => ({
      href: modelText(detail, 'href', 'displayConflicts.details'),
      displayStart: modelText(detail, 'displayStart', 'displayConflicts.details'),
    })),
  }));
}

/** `$.getBean('user').loadBy(stats.getLockID())`, when the model carries it. */
function lockedByOf(model: CarchStruct): StatusLockUser | undefined {
  const user = structValue(model, 'lockedBy');
  if (user === undefined || user === null) return undefined;
  if (!isStruct(user)) throw new TypeError(`${OPERATION} returned rc.lockedBy that is not a struct`);
  return { fname: structText(user, 'fname'), lname: structText(user, 'lname'), email: structText(user, 'email') };
}

/** The status include's model; edit always defines `showApprovalStatus`, so the approval block renders. */
function statusModelOf(s: EditScope): StatusModel {
  const { bean } = s;
  const parentType = structText(s.parentBean, 'type');
  const underCalendar = parentType.toLowerCase() === 'calendar';
  const display = Number(structText(bean, 'display'));
  const lockedBy = lockedByOf(s.model);
  return {
    hasLockableNodes: s.hasLockableNodes,
    stats: s.stats,
    ...(lockedBy === undefined ? {} : { lockedBy }),
    content: {
      contentId: structText(bean, 'contentID'),
      siteId: structText(bean, 'siteID'),
      contentHistId: structText(bean, 'contentHistID'),
      approvalStatus: structText(bean, 'approvalStatus'),
      display,
      displayIntervalDesc:
        underCalendar && display === 2 ? modelText(bean, 'displayIntervalDesc', 'contentBean') : '',
      conflicts: underCalendar ? displayConflicts(bean) : [],
    },
    showApprovalStatus: s.showApprovalStatus,
    parentType,
  };
}

/** Lines 485-492: a stored node whose newer draft the draft prompt offers links to it. */
function draftNotice(o: ViewOutput, s: EditScope): void {
  o.ws();
  const draftcheck = modelStruct(s.model, 'draftcheck');
  o.ws();
  const historyId = structText(draftcheck, 'historyid');
  const contentHistId = structText(s.bean, 'contentHistID');
  if (modelFlag(draftcheck, 'showdialog', 'draftcheck') && historyId !== '' && !cfEq(historyId, contentHistId)) {
    o.t('\n\t\t\t<div class="alert alert-info">\n\t\t\t\t<span>').t(s.label('sitemanager.draftprompt.inline'));
    // The request's query is printed unencoded, as legacy prints it.
    o.t(': <strong><a href="./?').t(replaceFirst(cgiQueryString(s.req), contentHistId, historyId)).t('">');
    o.t(s.label('sitemanager.draftprompt.gotolatest')).t('</a></strong></span>\n\t\t\t</div>\n\t\t');
  }
  o.ws();
}

/** Lines 494-505: the pending change sets of the node and the change set of the version. */
function changesetNotice(o: ViewOutput, s: EditScope, changesets: ChangesetState): void {
  const { rc, label } = s;
  o.t('\n\t\t<div class="alert alert-info">\n\t\t\t<span>\n\t\t\t\t');
  if (changesets.pending.length > 0) {
    o.t(label('sitemanager.content.changesetnodenotify')).t(':<br>\n\t\t\t\t<ul class="alert-list">\n\t\t\t\t');
    const query = (name: string): string => encodeUrl(rcText(rc, name));
    for (const row of changesets.pending) {
      o.t(`<li><a href="?muraAction=cArch.edit&moduleID=${query('moduleid')}&siteID=${query('siteid')}`);
      o.t(`&topID=${query('topid')}&contentID=${query('contentid')}&return=${query('return')}`);
      // The version id is printed unencoded, as legacy prints it.
      o.t(`&contentHistID=${structText(row, 'contentHistID')}&parentID=${query('parentid')}`);
      o.t(`&startrow=${query('startrow')}&type=${query('type')}&compactDisplay=${query('compactDisplay')}">`);
      o.t(encodeHtml(structText(row, 'changesetName'))).t('</a></li>');
    }
    o.t('\n\t\t\t\t</ul>\n\t\t\t\t');
  }
  o.ws();
  if (!changesets.currentIsNew) {
    o.t(label('sitemanager.content.changesetversionnotify')).t(': <strong>');
    o.t(encodeHtml(changesets.currentName)).t('</strong>');
  }
  o.t('\n\t\t\t</span>\n\t\t</div>\n\t');
}

/** The bean's `getErrors()` as `displayErrors` lists them, in the model's key order. */
function errorsOf(bean: CarchStruct): Array<readonly [string, string]> {
  const errors = modelStruct(bean, 'errors', 'contentBean');
  return Object.keys(errors).map((key) => [key, structText(errors, key)] as const);
}

/** Lines 483-531: the status include, the draft, change set, notes, global and error notices, the container close. */
async function statusContainer(o: ViewOutput, s: EditScope): Promise<void> {
  const { label, bean } = s;
  o.t((await status(s.ctx, statusModelOf(s))).value).ws();
  if (!s.isNew) draftNotice(o, s);
  o.ws();
  const { changesets } = s;
  if (changesets !== undefined && (!changesets.currentIsNew || changesets.pending.length > 0)) {
    changesetNotice(o, s, changesets);
  }
  o.ws();
  const notes = structText(bean, 'notes');
  if (notes !== '') {
    o.t('\n\t\t<div class="alert alert-info">\n\t\t\t<span>').t(label('sitemanager.content.notes')).t(': ');
    o.t(encodeHtml(notes)).t('</span>\n\t\t</div>\n\t');
  }
  // The three message render events print nothing, and the text between them follows whitespace.
  o.t('\n\n\t\n\t<span id="msg">\n\t').ws().ws().t('\n\t</span>\n\n\t\t');
  if (!s.isNew && s.compact && !cfListHas(`${NODE_LEVEL},Variation`, s.type, { noCase: true })) {
    o.t('\n\t\t\t<div class="alert alert-info">\n\t\t\t\t<span>').t(label('sitemanager.content.globallyappliednotice'));
    o.t('</span>\n\t\t\t</div>\n\t\t');
  }
  o.ws();
  const errors = errorsOf(bean);
  if (errors.length > 0) {
    o.t('\n\t\t\t<div class="alert alert-error"><span>').t(displayErrors(errors).value).t('</span></div>\n\t\t');
  }
  o.t('\n\n\t</div> \n\t');
}

/** Lines 534-576: the form, the settings panels, the title and body render areas and the action buttons. */
function formBody(o: ViewOutput, s: EditScope, panels: EditPanelsResult, buttons: string): void {
  const { bean } = s;
  const showExtensions = cfEq(modelValue(s.model, 'showExtensionsInDefault', 'rc'), true);
  const beanType = structText(bean, 'type');
  o.t(FORM_OPEN).t(panels.html.value).t(TAB_CONTENT_OPEN).t(showExtensions ? 'mura-editbox' : 'mura-editbox-none');
  o.t(TITLE_RENDER_OPEN).t(encodeHtmlAttr(beanType)).t(' Title">').t(encodeHtmlAttr(structText(bean, 'title')));
  o.t('</div>\n\t\t\t\t');
  if (cfListHas('Link,File,', beanType, { noCase: true })) {
    o.t(BODY_RENDER_INNER_OPEN).t(panels.bodyContent.value).t('</div></div>\n\t\t\t\t');
  } else {
    o.t(BODY_RENDER_OPEN).t(panels.bodyContent.value).t('</div>\n\t\t\t\t');
  }
  o.ws();
  if (showExtensions) o.t(EXTENSIONS_BASIC);
  o.t(PRELOADER).t(buttons).t('\n\t</div><!-- /.block-constrain -->\n\n\t');
  if (s.assignChangesets) {
    const changesets = s.changesets;
    if (changesets === undefined) throw new TypeError('carch.edit assigns change sets on a site without them');
    const dialog = renderChangesetsDialog(s.ctx, {
      currentChangesetIsNew: changesets.currentIsNew,
      approved: cfToBoolean(modelValue(bean, 'approved', 'contentBean')),
      changesetId: structText(bean, 'changesetID'),
    });
    o.ws().t(dialog.value).ws();
  }
}

/** Lines 582-721: the tab list and extended attributes, the save prompt, the save shortcut and the live title. */
function formScript(o: ViewOutput, s: EditScope, panels: EditPanelsResult): void {
  const { bean, rc, label } = s;
  o.t('\n\n<script type="text/javascript">\n\n');
  if (cfListHas(EXTENDED_ATTRIBUTE_TYPES, structText(bean, 'type'), { noCase: true })) {
    o.t("\n\tsiteManager.tablist='").t(encodeJs(panels.tabList.toLowerCase()));
    o.t("';\n\tsiteManager.loadExtendedAttributes('");
    // Ids, type, subtype, site and paths are printed unencoded, as legacy prints them.
    const args = [
      structText(bean, 'contentID'),
      structText(bean, 'contentHistID'),
      rcText(rc, 'type'),
      structText(bean, 'subType'),
      rcText(rc, 'siteid'),
      legacySettings().context,
      themeAssetPath(s.req),
    ];
    o.t(args.join("','")).t("');\n");
  }
  o.t(SAVE_DRAFT_PROMPT_OPEN).t(encodeHtml(label('sitemanager.content.keepeditingconfirm'))).t(CHECK_FOR_SAVE_OPEN);
  if (!s.compact) o.t(KEEP_EDITING);
  o.t(TITLE_EDITOR_OPEN);
  if (!s.isNew) {
    o.t("\n\t\t\topenDisplay('editAdditionalTitles','").t(label('sitemanager.content.fields.close')).t("');\n\t\t\t");
  }
  o.t(FORM_SCRIPT_CLOSE);
}

/** Lines 723-776: the fields the update action reads, the CSRF fields of `<contentHistID>add` and the form close. */
function hiddenFields(o: ViewOutput, s: EditScope, ptype: string): void {
  const { bean, rc, req } = s;
  const attr = (name: string): string => encodeHtmlAttr(rcText(rc, name));
  const contentHistId = structText(bean, 'contentHistID');
  // Bean values are printed unencoded, as legacy prints them.
  o.t(structText(bean, 'approved')).t(HIDDEN_CHANGESET_FIELDS);
  if (!cfEq(s.type, 'Link')) {
    o.t('\n\t\t<input name="filename" type="hidden" value="').t(structText(bean, 'filename')).t('">\n\t');
  }
  o.ws();
  if (!s.isNew) {
    const { dateKeyFormat, locale } = req.session;
    const lastUpdate = lsDateFormatString(structText(bean, 'lastUpdate'), dateKeyFormat, locale);
    o.t('\n\t\t<input name="lastupdate" type="hidden" value="').t(lastUpdate).t('">\n\t');
  }
  o.ws();
  if (cfEq(rcText(rc, 'contentid'), ROOT_CONTENT_ID)) o.t('\n\t\t<input name="isNav" type="hidden" value="1">\n\t');
  o.ws();
  if (cfEq(s.type, 'Form')) {
    o.t('\n\t\t<input name="responseDisplayFields" type="hidden" value="');
    o.t(structText(bean, 'responseDisplayFields')).t('">\n\t');
  }
  o.t(HIDDEN_ACTION_FIELDS).t(attr('siteid'));
  o.t('">\n\t<input type="hidden" name="moduleid" value="').t(attr('moduleid'));
  o.t('">\n\t<input type="hidden" name="contenthistid" value="').t(contentHistId);
  o.t('">\n\t<input type="hidden" name="return" value="').t(attr('return'));
  o.t('">\n\t<input type="hidden" name="topid" value="').t(attr('topid'));
  o.t('">\n\t<input type="hidden" name="contentid" value="').t(structText(bean, 'contentID'));
  o.t('">\n\t<input type="hidden" name="ptype" value="').t(encodeHtmlAttr(ptype));
  o.t('">\n\t<input type="hidden" name="type" value="').t(attr('type')).t('">\n\t');
  const formType = urlFormType(req);
  if (formType !== undefined && !cfEq(formType, '')) {
    // `url.formType` is printed unencoded, as legacy prints it.
    o.t('\n\t\t\n\t\t<input type="hidden" name="formType" value="').t(formType).t('">\n\t');
  }
  o.t('\n\t<input type="hidden" name="subtype" value="').t(structText(bean, 'subType'));
  o.t(HIDDEN_UPDATE_FIELDS).t(attr('startrow'));
  o.t('">\n\t<input type="hidden" name="returnURL" id="txtReturnURL" value="').t(encodeUrl(rcText(rc, 'returnURL')));
  o.t('">\n\t<input type="hidden" name="homeID" value="').t(attr('homeID')).t(HIDDEN_FLAG_FIELDS);
  if (!cfListToArray(req.session.mura.memberships ?? '').includes('S2')) {
    o.t('\n\t\t<input type="hidden" name="isLocked" value="').t(structText(bean, 'isLocked')).t('">\n\t');
  }
  const orderNo = structText(bean, 'orderNo');
  o.t('\n\t<input name="OrderNo" type="hidden" value="').t(cfEq(orderNo, '') ? '0' : orderNo);
  o.t('">\n\t<input type="hidden" name="closeCompactDisplay" value="').t(attr('compactDisplay'));
  o.t('" />\n\t<input type="hidden" name="compactDisplay" value="').t(attr('compactDisplay'));
  o.t('" />\n\t<input type="hidden" name="frontend" value="').t(attr('frontend'));
  o.t('" />\n\t<input type="hidden" name="instanceid" value="').t(attr('instanceid'));
  o.t('" />\n\t<input type="hidden" name="parenthistid" value="').t(attr('parenthistid')).t('" />\n\n\t');
  o.t(s.ctx.csrf.render(`${contentHistId}add`, 'form').value).ws().t('\n\t</form>\n\n');
}

/** Line 439: a new node is offered only while the site's page count is under its page limit. */
function withinPageLimit(s: EditScope): boolean {
  const [pageCount] = modelRows(s.model, 'rsPageCount');
  const counter = pageCount === undefined ? '' : structText(pageCount, 'counter');
  return (cfLessThan(counter, modelText(s.model, 'pageLimit')) && s.isNew) || !s.isNew;
}

/**
 * carch/edit.cfm over the edit model, for `ctx.req` as the controller left it: the view's rc changes (`rc.parentID`)
 * stay on `ctx.req`, as they do on legacy's rc. `cArch.update` renders it for a bean that failed validation.
 * @throws TypeError When the request or the edit model lacks a value the view or an include reads.
 */
export async function renderEditView(ctx: ScreenContext, data: CarchPageModel): Promise<ShellView> {
  const s = editScope(ctx, data);
  ctx.req = s.req;
  const o = new ViewOutput();
  lockScript(o, s);
  exitScript(o, s);
  approvalScript(o, s);
  editorScripts(o, s);
  const buttons = actionButtons(s);
  o.ws();
  let htmlHead: SafeHtml | undefined;
  if (withinPageLimit(s)) {
    const showMenu = !s.compact || !cfListHas(NODE_LEVEL, s.type, { noCase: true });
    const contentHistId = structText(s.bean, 'contentHistID');
    await ctx.csrf.prefetch([...(showMenu ? carchSecondaryMenuCsrfContexts(s.rc) : []), `${contentHistId}add`]);
    o.ws();
    header(o, s, showMenu);
    await statusContainer(o, s);
    const panels = await renderEditPanels({ ctx, req: s.req, data: s.data, state: s.state });
    formBody(o, s, panels, buttons);
    formScript(o, s, panels);
    hiddenFields(o, s, panels.ptype);
    htmlHead = panels.htmlHead;
  } else {
    o.t('\n\t<div>\n\t\t\n').t(renderSiteFull().value).t('\n\t</div>\n');
  }
  o.ws();
  const muraAction = cfListToArray(rcText(s.rc, 'muraAction'), '.').at(-1) ?? '';
  return { body: raw(o.toString()), ajax: carchJs(ctx, muraAction), ...(htmlHead === undefined ? {} : { htmlHead }) };
}

// ---- Controller ----

/** Edit models the controller step read, keyed by the request's screen context, for `load` to hand on. */
const PREPARED = new WeakMap<ScreenContext, CarchPageModel>();

/**
 * carch `before()` then `edit()`: the edit model of `rc.contenthistid`, a denial as `secure()`'s redirect, and the
 * redirect to the node's history when a stored node's version does not exist.
 * @throws Error When strategies-content rejects the read with another 4xx, as legacy fails on it.
 */
async function editRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  ctx.req = applyCarchDefaults(ctx.req);
  const { rc } = ctx.req;
  const contentId = rcText(rc, 'contentid');
  // A new node's empty `contentid` loads a new bean, whose id getContentID() mints with createUUID(); the path segment
  // needs a value, so a fresh CF UUID stands in.
  const serviceRc = assignContext(rc, { contentid: contentId === '' ? cfUuid() : contentId });
  const outcome = await carchPageData(ctx, 'edit', serviceRc);
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${OPERATION} rejected carch.edit with HTTP ${String(outcome.status)}`);
  }
  const bean = structOf(outcome.data.rc, 'contentBean');
  if (
    !cfEq(rcText(rc, 'type'), 'Variation') &&
    !cfEq(contentId, '') &&
    !cfEq(rcText(rc, 'contenthistid'), '') &&
    cfEq(modelValue(bean, 'isNew', 'contentBean'), 1) &&
    rcText(rc, 'instanceid') === ''
  ) {
    return {
      kind: 'redirect',
      action: 'cArch.hist',
      append: 'contentid,siteid,startrow,moduleid,parentid,type',
      path: './',
    };
  }
  PREPARED.set(ctx, outcome.data);
  return undefined;
}

/** The `cArch.edit` admin page: the content editor of a version or a new node. */
export const editScreen: PageScreen<CarchPageModel> = Object.freeze({
  circuit: 'carch',
  action: 'edit',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  // The read runs in the redirect step, where a service denial can still answer with secure()'s redirect.
  redirect: editRedirect,
  load(ctx: ScreenContext): Promise<CarchPageModel> {
    const data = PREPARED.get(ctx);
    if (data === undefined) return Promise.reject(new Error('carch.edit loaded before its controller step ran'));
    PREPARED.delete(ctx);
    return Promise.resolve(data);
  },
  render: renderEditView,
});
