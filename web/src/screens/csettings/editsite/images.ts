// Images tab of the Site Settings editor (`admin/core/views/csettings/editsite.cfm` lines 822-1026).
import { encodeHtmlAttr, encodeJs, html, raw, type SafeHtml } from '@/lib/html';
import { renderFileSelector } from './file-selector';
import type { EditSiteModel } from './model';

/** `esapiEncode('html_attr', value)` as attribute markup. */
function attrValue(value: string): SafeHtml {
  return raw(encodeHtmlAttr(value));
}

// `editsite.cfm` lines 862-1006 as ColdFusion emits them (`##` as `#`), split at the line-1001 site id.
const SCRIPT_HEAD = raw(`\t\t\t\t<script>
\t\t\tfunction openCustomImageSize(sizeid,siteid){

\t\t\t\t\tjQuery("#custom-image-dialog").remove();
\t\t\t\t\tjQuery("body").append('<div id="custom-image-dialog" rel="tooltip" title="Loading..." style="display:none"><div id="newContentMenu"><div class="load-inline"></div></div></div>');

\t\t\t\t\tvar editTitle = "Add Custom Image Size";

\t\t\t\t\tvar dialogoptions= {};

\t\t\t\t\t\tdialogoptions.Cancel=function() {
\t\t\t\t\t\t jQuery( this ).dialog( "close" );
\t\t\t\t\t\t};

\t\t\t\t\t\tif(sizeid != ''){
\t\t\t\t\t\t\tdialogoptions.Delete=function(){
\t\t\t\t\t\t\t\tdeleteCustomImageSize();
\t\t\t\t\t\t\t\tjQuery( this ).dialog( "close" );
\t\t\t\t\t\t\t};
\t\t\t\t\t\t\tvar editTitle = "Edit Custom Image Size";
\t\t\t\t\t\t}

\t\t\t\t\t\tdialogoptions.Save={click: function() {
\t\t\t\t\t\t\t\tsaveCustomImageSize();
\t\t\t\t\t\t\t\tjQuery(this).dialog('close');
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t, text: 'Save'
\t\t\t\t\t\t\t, class: 'mura-primary'
\t\t\t\t\t\t} // /Save

\t\t\t\t\tjQuery("#custom-image-dialog").dialog({
\t\t\t\t\t\tresizable: false,
\t\t\t\t\t\tmodal: true,
\t\t\t\t\t\twidth: 400,
\t\t\t\t\t\tposition: getDialogPosition(),
\t\t\t\t\t\tbuttons:
\t\t\t\t\t\tdialogoptions,
\t\t\t\t\t\topen: function(){
\t\t\t\t\t\t\tjQuery("#custom-image-dialog").html('<div class="ui-dialog-content ui-widget-content"><div class="load-inline"></div></div>');
\t\t\t\t\t\t\tvar url = 'index.cfm';
\t\t\t\t\t\t\tvar pars = 'muraAction=cSettings.loadcustomimage&siteid=' + siteid +'&sizeid=' + sizeid  +'&cacheid=' + Math.random();
\t\t\t\t\t\t\tjQuery.get(url + "?" + pars,
\t\t\t\t\t\t\t\t\tfunction(data) {
\t\t\t\t\t\t\t\t\tjQuery("#custom-image-dialog").closest(".ui-dialog").find(".ui-dialog-title").html(editTitle);
\t\t\t\t\t\t\t\t\tjQuery('#custom-image-dialog').html(data);
\t\t\t\t\t\t\t\t\t$("#custom-image-dialog").dialog("option", "position", "center");
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t);
\t\t\t\t\t\t},
\t\t\t\t\t\tclose: function(){
\t\t\t\t\t\t\tjQuery(this).dialog("destroy");
\t\t\t\t\t\t\tjQuery("#custom-image-dialog").remove();
\t\t\t\t\t\t}
\t\t\t\t});

\t\t\t\treturn false;
\t\t }

\t\tfunction saveCustomImageSize(){
\t\t\tloadCustomImages(
\t\t\t\t{
\t\t\t\t\tsizeid:$('#custom-image-form').attr('data-sizeid'),
\t\t\t\t\tsiteid:siteid,
\t\t\t\t\tname:$('#custom-image-name').val(),
\t\t\t\t\theight:$('#custom-image-height').val(),
\t\t\t\t\twidth:$('#custom-image-width').val(),
\t\t\t\t\timageaction:'save'
\t\t\t\t}
\t\t\t);
\t\t }

\t\tfunction deleteCustomImageSize(){
\t\t\tif(confirm('Delete custom image size?')){
\t\t\t\tloadCustomImages(
\t\t\t\t\t{
\t\t\t\t\t\tsizeid:$('#custom-image-form').attr('data-sizeid'),
\t\t\t\t\t\tsiteid:siteid,
\t\t\t\t\t\tname:'',
\t\t\t\t\t\theight:'',
\t\t\t\t\t\twidth:'',
\t\t\t\t\t\timageaction:'delete'
\t\t\t\t\t}
\t\t\t\t);
\t\t\t}
\t\t }

\t\t function loadCustomImages(imageoptions){
\t\t\t\tvar merged=$.extend(
\t\t\t\t\t\t{
\t\t\t\t\t\t\tsizeid:'',
\t\t\t\t\t\t\tsiteid:'',
\t\t\t\t\t\t\tname:'',
\t\t\t\t\t\t\theight:'',
\t\t\t\t\t\t\twidth:'',
\t\t\t\t\t\t\timageaction:''
\t\t\t\t\t\t},
\t\t\t\t\t\timageoptions
\t\t\t\t\t);
\t\t\t\tvar url = 'index.cfm';
\t\t\t\tvar pars = 'muraAction=cSettings.loadcustomimages&siteid=' + merged.siteid + '&cacheid=' + Math.random();;

\t\t\t\tjQuery.post(url + "?" + pars,
\t\t\t\t\tmerged,
\t\t\t\t\tfunction(data) {
\t\t\t\t\t\tjQuery('#custom-images-container').html(data);
\t\t\t\t\t\t}
\t\t\t\t);
\t\t }


\t\tfunction attachHandlers(){

\t\t\t$("input[type='radio'][name='useDefaultSMTPServer']").each(function(){
\t\t\t\t$(this).click(function() {

\t\t\t\t\tif( jQuery('input[name=useDefaultSMTPServer]:checked').val() == 1 ){
\t\t\t\t\t\tjQuery('#testEmailSettings').prop( 'disabled', true );
\t\t\t\t\t} else {
\t\t\t\t\t\tjQuery('#testEmailSettings').prop( 'disabled', false );
\t\t\t\t\t}

\t\t\t\t});

\t\t\t\t$('ul[data-toggle="tabs"]').on('shown.bs.tab', function(e){
\t\t\t\t       var currentTab = $(e.target).text();

\t\t\t\t    \tif( currentTab == 'Email' && jQuery('input[name=useDefaultSMTPServer]:checked').val() == 0 ){
\t\t\t\t    \t\tjQuery('#testEmailSettings').prop( 'disabled', false );
\t\t\t\t    \t} else {
\t\t\t\t    \t\tjQuery('#testEmailSettings').prop( 'disabled', true );
\t\t\t\t    \t}

\t\t\t\t   });

\t\t\t});

\t\t}

\t\t$(document).ready(function(){
\t\t \tloadCustomImages({siteid:'`);
const SCRIPT_TAIL = raw(`'});
\t\t \tattachHandlers();
\t\t \tjQuery('#testEmailSettings').prop( 'disabled', true );
\t\t});

\t\t\t</script>
`);

/** The `tabImages` pane without surrounding newlines: image sizes, a saved site's custom sizes, placeholder image. */
export function renderImagesTab(m: EditSiteModel): SafeHtml {
  const b = m.bean;
  const siteId = raw(encodeJs(b.siteID));
  // From the `<cfif>` line break to the `</cfif>` indent, emitted only for a saved site (`len(getSiteID())`).
  const customImages =
    b.siteID.length > 0
      ? html`
${SCRIPT_HEAD}${siteId}${SCRIPT_TAIL}\t\t\t<div class="mura-control-group">
\t\t\t\t<label>Custom Images</label>
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<a href="#" onclick="return openCustomImageSize('','${siteId}')" class="btn"><i class="mi-plus-circle"></i> Add Custom Image Size</a>
\t\t\t\t</div>
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<div id="custom-images-container"></div>
\t\t\t\t</div>
\t\t\t</div>
\t\t\t`
      : null;
  const placeholder = renderFileSelector({
    name: 'newPlaceholderImg',
    property: 'placeholderImgID',
    fileId: b.placeholderImgID,
    siteId: b.siteID,
    deleteKey: 'deletePlaceholderImg',
    compactDisplay: m.compactDisplay,
    locked: '0',
    exampleFileExt: '',
    fileMeta: m.placeholderFile,
    rb: m.rb,
    newCacheId: m.newCacheId,
  });
  // Stripped CFML comments leave the space after each closing `</div>`.
  return html`\t\t<div id="tabImages" class="tab-pane">
\t\t\t<div class="block block-bordered">
\t\t\t\t<!-- block header -->
\t\t\t  <div class="block-header">
\t\t\t\t\t<h3 class="block-title">Image Galleries</h3>
\t\t\t\t</div>
\t\t\t  <!-- /block header -->

\t\t  <div class="block-content">
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>Small (Thumbnail) Image</label>
\t\t\t\t<div class="mura-control-inline">
\t\t\t\t\t<label>Height</label>
\t\t\t\t\t<input name="smallImageHeight" type="text" value="${attrValue(b.smallImageHeight)}" />
\t\t\t\t\t<label>Width</label>
\t\t\t\t\t<input name="smallImageWidth" type="text" value="${attrValue(b.smallImageWidth)}" />
\t\t\t\t</div>
\t\t\t</div>

\t\t\t<div class="mura-control-group">
\t\t\t\t<label>Medium Image</label>
\t\t\t\t<div class="mura-control-inline">
\t\t\t\t\t<label>Height</label>
\t\t\t\t\t<input name="mediumImageHeight" type="text" value="${attrValue(b.mediumImageHeight)}" />
\t\t\t\t\t<label>Width</label>
\t\t\t\t\t<input name="mediumImageWidth" type="text" value="${attrValue(b.mediumImageWidth)}" />
\t\t\t\t</div>
\t\t\t</div>

\t\t\t<div class="mura-control-group">
\t\t\t\t<label>Large Image</label>
\t\t\t\t<div class="mura-control-inline">
\t\t\t\t\t<label>Height</label>
\t\t\t\t\t<input name="largeImageHeight" type="text" value="${attrValue(b.largeImageHeight)}" />
\t\t\t\t\t<label>Width</label>
\t\t\t\t\t<input name="largeImageWidth" type="text" value="${attrValue(b.largeImageWidth)}" />
\t\t\t\t</div>
\t\t\t</div>

\t\t\t\t${customImages}
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>Placeholder Image</label>
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t${placeholder}
\t\t\t\t</div>
\t\t\t</div>

\t\t\t</div>\x20
\t\t</div>\x20
\t</div>\x20`;
}
