// The `cArch.multiFileUpload` page of `carch/multifileupload.cfm`: the Quick Upload widget for new Files (server-only).
import { cfToNumber } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import { selectLayout, type ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { renderSiteFull } from './form/full';
import { permOf, structValue, type CarchCrumb, type CarchPageData, type CarchStruct, type NodePerm } from './model';
import { carchJs } from './partials/js';
import { dspZoom } from './partials/zoom';
import { renderCarchSecondaryMenu } from './secondary-menu';
import { carchPageData } from './service';

const OPERATION = 'getMultiFileUploadModel';

/** What the view renders beyond the request: the parent's crumbs and verdict, and its page-limit test's outcome. */
interface MultiFileUploadData {
  /** `rc.crumbdata`: `getCrumbList(rc.parentid)`, the parent first. */
  readonly crumbdata: readonly CarchCrumb[];
  /** `rc.perm`: `getnodePerm(rc.crumbdata)`. */
  readonly perm: NodePerm;
  /** The site is below `getPageLimit()` and no content id is given, or a content id is given. */
  readonly uploadable: boolean;
}

/** The uploader form's hidden values, encoded as the view prints them. */
interface UploaderFields {
  readonly siteid: string;
  readonly moduleid: string;
  readonly topid: string;
  readonly ptype: string;
  readonly parentid: string;
  readonly startrow: string;
  readonly approved: '0' | '1';
}

/** The `cfhtmlhead` script of a compact display, which sizes the front-end modal. */
const COMPACT_HEAD_SCRIPT = `
<script type="text/javascript">
jQuery(document).ready(function(){
    if (top.location != self.location) {
        if(jQuery("#ProxyIFrame").length){
            jQuery("#ProxyIFrame").load(
                function(){
                    frontEndProxy.post({cmd:'setWidth',width:'standard'});
                }
            );
        } else {
            frontEndProxy.post({cmd:'setWidth',width:'standard'});
        }
    }
});
</script>
`;

/** The closing tags of the view's block wrapper, printed after either branch. */
const BLOCK_CLOSE = `
</div> <!-- /.block-content -->
</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;

/** Screen models the controller step fetched, read by `load` for the same request. */
const MODELS = new WeakMap<ScreenContext, CarchPageData>();

/** `rc[name]`, failing as CFML does when the element is undefined. */
function rcText(rc: Rc, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The array of structs under `rc[key]` of the model; throws when it is absent or holds anything else. */
function structsOf(model: CarchPageData, key: string): readonly CarchStruct[] {
  const value = structValue(model.rc, key);
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned no ${key} array of structs`);
  }
  return value;
}

/** settingsBean `getScheme()` of the session site; without readable site data only the request's HTTPS decides. */
function siteScheme(req: AdminRequest): 'http' | 'https' {
  const record = req.site?.record;
  // A NULL useSSL leaves the deprecated extranetSSL as the bean read it.
  const useSSL = (record?.useSSL ?? record?.ExtranetSSL ?? 0) !== 0;
  return useSSL || req.https ? 'https' : 'http';
}

/** The `cfhtmlhead` text: the uploader stylesheet, `session.dateKey` and, in a compact display, the modal script. */
function htmlHead(req: AdminRequest, compact: boolean): SafeHtml {
  const stylesheet = adminAssetUrl('css/jquery/jquery.fileupload-ui.css', { coreversion: true });
  const head = `\n<link href="${stylesheet}" rel="stylesheet" type="text/css">\n${req.session.dateKey.script.value} `;
  return raw(compact ? head + COMPACT_HEAD_SCRIPT : head);
}

/**
 * carch `before()` and `multiFileUpload()`: the rc and session defaults, then the screen model of `rc.parentid`.
 * A strategies-content denial answers with the controller's `secure()` redirect.
 * @throws Error When strategies-content rejects the read otherwise, e.g. an unknown parent (legacy fails there too).
 */
async function runController(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  ctx.req = applyCarchDefaults(ctx.req);
  const outcome = await carchPageData(ctx, 'multifileupload');
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`strategies-content rejected the carch.multifileupload read with HTTP ${String(outcome.status)}`);
  }
  MODELS.set(ctx, outcome.data);
  return undefined;
}

// The model's `rc` is an open struct, so this screen names the keys strategies-content reports, read
// case-insensitively: `crumbdata` (the crumb structs), `perm`, `rsPageCount` (one row with `counter`) and `pageLimit`
// (the site's `getPageLimit()`, which the view reads). `rsCount` and `rsRestrictGroups` are set but never printed.
/**
 * The values the view computes before its markup, and the CSRF pair of the upload form when the uploader renders.
 * @throws Error When the controller step has not run for `ctx`.
 * @throws TypeError When the model lacks a key the view reads.
 */
async function loadView(ctx: ScreenContext): Promise<MultiFileUploadData> {
  const model = MODELS.get(ctx);
  if (model === undefined) throw new Error('carch.multifileupload loaded before its controller step ran');
  const { rc } = ctx.req;
  const contentId = rcText(rc, 'contentid');
  const pageCount = cfToNumber(structValue(structsOf(model, 'rsPageCount')[0] ?? {}, 'counter'));
  const underLimit = pageCount < cfToNumber(structValue(model.rc, 'pageLimit'));
  const uploadable = (underLimit && contentId === '') || contentId !== '';
  if (uploadable) await ctx.csrf.tokens(`${rcText(rc, 'parentid')}multifileupload`);
  return { crumbdata: structsOf(model, 'crumbdata'), perm: permOf(model), uploadable };
}

/** The view inside the shell: the uploader, or the page-limit notice when the site is full. */
function renderView(ctx: ScreenContext, data: MultiFileUploadData): ShellView {
  const { rc } = ctx.req;
  const compact = selectLayout(rc) === 'compact';
  const view = { ajax: carchJs(ctx, ctx.req.item), htmlHead: htmlHead(ctx.req, compact) };
  if (!data.uploadable) return { ...view, body: raw(`\n<div>\n\n${renderSiteFull().value}\n</div>\n${BLOCK_CLOSE}`) };

  // Whitespace-only template text prints as one space after the breadcrumb, as ACF writes it after markup.
  const breadcrumb = (): string => dspZoom(ctx, { crumbdata: data.crumbdata, class: 'breadcrumb' }).value;
  const navigation = compact ? '' : `${renderCarchSecondaryMenu(ctx, {}).value}${breadcrumb()} `;
  const fields: UploaderFields = {
    siteid: encodeHtmlAttr(rcText(rc, 'siteid')),
    moduleid: encodeHtmlAttr(rcText(rc, 'moduleid')),
    topid: encodeHtmlAttr(rcText(rc, 'topid')),
    ptype: encodeHtmlAttr(rcText(rc, 'ptype')),
    parentid: encodeHtmlAttr(rcText(rc, 'parentid')),
    startrow: rcText(rc, 'startrow'),
    approved: data.perm === 'editor' ? '1' : '0',
  };
  const csrfFields = ctx.csrf.render(`${rcText(rc, 'parentid')}multifileupload`, 'form').value;
  const label = ctx.rb.rbKey('sitemanager.content.multifileupload');
  const header = `\n<div class="mura-header">\n    <h1>${label}</h1>\n\n    `;
  return { ...view, body: raw(header + navigation + uploader(fields, csrfFields, siteScheme(ctx.req)) + BLOCK_CLOSE) };
}

/** The `cArch.multiFileUpload` admin page; image uploads are a not-built variant the gateway keeps on legacy. */
export const multifileuploadScreen: PageScreen<MultiFileUploadData> = Object.freeze({
  circuit: 'carch',
  action: 'multifileupload',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  redirect: runController,
  load: loadView,
  render: renderView,
});

// Text from the view's markup, printed as ACF prints the template: CFML comments dropped, `##` written as `#`, and the
// commented-out gallery script's scheme still evaluated.
/** The markup from the end of the mura-header through the uploader's application script. */
function uploader(fields: UploaderFields, csrfFields: string, scheme: string): string {
  const { context, adminDir } = legacySettings();
  const adminRoot = `${context}${adminDir}/`;
  const jqueryAsset = (file: string): string => adminAssetUrl(`js/jquery/${file}`, { coreversion: true });
  return `
</div> <!-- /.mura-header -->


<div class="block block-constrain">
\t<div class="block block-bordered">
\t  <div class="block-content">

    
<div id="multi-file-upload">
    <!-- The file upload form used as target for the file upload widget -->
    <form id="fileupload" action="${adminRoot}" method="POST" enctype="multipart/form-data">
    \t<!-- Creating a visual target for files. Doesn't actually do anything. Pure eye candy. -->
    \t<div id="fileupload-target"><p><i class="mi-plus-circle"></i> Drag and drop files to upload</p></div>
        <!-- The fileupload-buttonbar contains buttons to add/delete files and start/cancel the upload -->
        <div class="fileupload-buttonbar">
            <div class="half">
                <!-- The fileinput-button span is used to style the file input field as button -->
                <span class="btn fileinput-button mura-file-add">
                    <i class="mi-plus"></i>
                    <span>Add files...</span>
                    <input type="file" name="files" multiple>
                </span>
                <button type="submit" class="btn start mura-file-start" style="display: none;">
                    <i class="mi-upload"></i>
                    <span>Upload</span>
                </button>
                <button type="reset" class="btn cancel mura-file-resets" style="display: none;">
                    <i class="mi-ban"></i>
                    <span>Cancel</span>
                </button>
                
            </div>
            <!-- The global progress information -->
            <div class="fileupload-progress fade half">
                <!-- The global progress bar -->
                <div class="progress" id="progress-multi-global" style="display: none;">
                    <div class="progress-bar progress-bar-striped" role="progressbar" aria-valuemin="0" aria-valuemax="100" style="width:0%;"></div>
                </div>
                <!-- The extended global progress information -->
                <div class="progress-extended">&nbsp;</div>
            </div>
        </div>
        <!-- The loading indicator is shown during file processing
        <div class="fileupload-loading"></div>

        <br> -->
        <!-- The table listing the files available for upload/download -->
        <table role="presentation" class="mura-table-grid">
        <tbody class="files" data-toggle="modal-gallery" data-target="#modal-gallery"></tbody></table>
      <input type="hidden" name="muraAction" value="cArch.update"/>
      <input type="hidden" name="action" value="multifileupload"/>
      <input type="hidden" name="siteid" value="${fields.siteid}"/>
      <input type="hidden" name="moduleid" value="${fields.moduleid}"/>
      <input type="hidden" name="topid" value="${fields.topid}"/>
      <input type="hidden" name="ptype" value="${fields.ptype}"/>
      <input type="hidden" name="parentid" value="${fields.parentid}"/>
      <input type="hidden" name="contentid" value=""/>
      <input type="hidden" name="type" value="File"/>
      <input type="hidden" name="subtype" value="Default"/>
      <input type="hidden" name="startrow" value="${fields.startrow}"/>
      <input type="hidden" name="orderno" value="0"/>
      <input type="hidden" name="approved" value="${fields.approved}" />
      ${csrfFields}
    </form>
</div>
</div>

<script id="template-upload" type="text/x-tmpl">
{% for (var i=0, file; file=o.files[i]; i++) {
     var fileext=$(file.name.split(".")).get(-1).toUpperCase();
     var isImageFile=fileext=='JPEG' || fileext=='JPG' || fileext=='GIF' || fileext=='PNG';
    %}
    <tr class="template-upload fade">
        <td class="file-preview">
            <span class="preview">
\t\t\t</span>
        </td>
        <td class="var-width form-horizontal">
        \t<div class="mura-control-group">
\t            <label>File name</label>
        \t\t<div class="name">{%=file.name%}</div>
\t\t\t</div>
\t        <div class="mura-control-group">
\t           \t<label>Title</label>
           \t\t<div class="editable nolinebreaks" data-attribute="title" contenteditable="true">{%=file.name%}</div>
\t        </div>
\t        <div class="mura-control-group">
\t            <label>Summary/Caption</label>
\t\t\t\t<div id="summaryinstance"
                class="editable" data-attribute="summary" contenteditable="true"></div>
\t        </div>
\t        <div class="mura-control-group">
\t        \t<label>Credits</label>
                {% if(isImageFile){  %}
        \t\t <div id="creditsinstance"
                    class="editable htmlEditor" data-attribute="credits" contenteditable="true"></div>
                 {% } else { %}
                 <div id="creditsinstance"
                    class="editable" data-attribute="credits" contenteditable="true"></div>
                {% } %}
\t        </div>
            {% if(isImageFile){  %}
\t        <div class="mura-control-group">
\t        \t<label>Alt Text</label>
        \t\t<div class="editable nolinebreaks" data-attribute="alttext" contenteditable="true"></div>
\t\t\t</div>
            {% } %}
            {% if (file.error) { %}
                <div><span class="label label-important">Error</span> {%=file.error%}</div>
            {% } %}
        </td>
        <td>

            {% if (!o.files.error) { %}
                <div class="progress">
                    <div class="progress-bar progress-bar-striped active" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width:0%;"></div>
                </div>
                <p class="size">{%=o.formatFileSize(file.size)%}</p>
            {% } %}
        </td>
        <td>
        \t<div class="mura-input-set">
            {% if (!o.files.error && !i && !o.options.autoUpload) { %}
                <button class="btn start">
                    <i class="mi-upload"></i><span> Upload</span>
                </button>
            {% } %}
            {% if (!i) { %}
                <button class="btn cancel">
                    <i class="mi-ban"></i><span> Cancel</span>
                </button>
            {% } %}
\t\t\t</div>
        </td>
    </tr>
{% } %}
</script>

<!-- The template to display files available for download -->
<script id="template-download" type="text/x-tmpl">
{% for (var i=0, file; file=o.files[i]; i++) { %}
    <tr class="template-download fade">
        <td class="file-preview">
            <span class="preview">
                {% if (file.thumbnail_url) { %}
                    <a href="{%=file.url%}" title="{%=file.title%}" class="gallery" download="{%=file.filename%}"><img src="{%=file.thumbnail_url%}"></a>
                {% } else { %}
                    <i class="mi-file-text-o"></i>
                {% } %}
                <span class="badge">{%=$(file.filename.split(".")).get(-1).toUpperCase()%}</span>
            </span>
        </td>
        <td class="var-width form-horizontal">
            <div class="mura-control-group">
                <label>File name</label>
                <div class="name">{%=file.filename%}</div>
            </div>
            {% if (file.error) { %}
                <div><span class="label label-important">Error</span> {%=file.error%}</div>
            {% }  else { %}
                <div class="mura-control-group">
                    <label>Title</label>
                    <div data-attribute="title">{%=file.title%}</div>
                </div>
                 {% if (file.summary) { %}
                <div class="mura-control-group">
                    <label>Summary/Caption</label>
                    <div data-attribute="summary">{%#file.summary%}</  div>
                    </div>
                </div>
                {% } %}
                {% if (file.credits) { %}
                <div class="mura-control-group">
                    <label>Credits</label>
                    <div data-attribute="credits">{%#file.credits%}</div>
                </div>
                {% } %}
                {% if (file.thumbnail_url && file.alttext) { %}
                <div class="mura-control-group">
                    <label>Alt Text</label>
                    <div data-attribute="alttext">{%=file.alttext%}</div>
                </div>
                 {% } %}
            {% } %}
        </td>
        <td><div class="progress">
                <div class="progress-bar complete" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width:100%;"></div>
            </div>
            <span class="size complete">{%=o.formatFileSize(file.size)%}</span>
        </td>
        <td>
        {% if (file.edit_url !='') { %}
        <a class="btn mura-edit-file" onclick="confirmDialog('Would you like to edit this file?','{%=file.edit_url%}','','Edit File');"><i class="mi-pencil"></i> Edit</a>
         {% } %}
        
        </td>
    </tr>
{% } %}
</script>
<!-- The Templates plugin is included to render the upload/download listings -->
<script src="${jqueryAsset('tmpl.min.js')}"></script>
<!-- The Load Image plugin is included for the preview images and image resizing functionality -->
<script src="${jqueryAsset('load-image.min.js')}"></script>
<!-- The Canvas to Blob plugin is included for image resizing functionality -->
<script src="${jqueryAsset('canvas-to-blob.min.js')}"></script>

<!-- blueimp Gallery script
<script src="${scheme}://blueimp.github.io/Gallery/js/blueimp-gallery.min.js"></script>
-->
<!-- The Iframe Transport is required for browsers without support for XHR file uploads -->
<script src="${jqueryAsset('jquery.iframe-transport.js')}"></script>
<!-- The basic File Upload plugin -->
<script src="${jqueryAsset('jquery.fileupload.js')}"></script>
<!-- The File Upload processing plugin -->
<script src="${jqueryAsset('jquery.fileupload-process.js')}"></script>
<!-- The File Upload image preview & resize plugin -->
<script src="${jqueryAsset('jquery.fileupload-image.js')}"></script>
<!-- The File Upload audio preview plugin -->
<script src="${jqueryAsset('jquery.fileupload-audio.js')}"></script>
<!-- The File Upload video preview plugin -->
<script src="${jqueryAsset('jquery.fileupload-video.js')}"></script>
<!-- The File Upload validation plugin -->
<script src="${jqueryAsset('jquery.fileupload-validate.js')}"></script>
<!-- The File Upload user interface plugin -->
<script src="${jqueryAsset('jquery.fileupload-ui.js')}"></script>
<!-- The localization script -->
<script src="${jqueryAsset('jquery.fileupload.locale.js')}"></script>

<!-- The main application script -->
<script>

var fileIndex=0;

$(function () {
    'use strict';

    $.blueimp.fileupload.prototype._renderPreviews= function (data) {
            data.context.find('.preview').each(function (index, elm) {
                var fileext=$(data.files[index].name.split(".")).get(-1).toUpperCase();
                if(fileext=='JPEG' || fileext=='JPG' || fileext=='GIF' || fileext=='PNG'){
                    $(elm).append(data.files[index].preview);
                    $(elm).append('<span class="badge">' + fileext + '</span>' )
                } else {
                    $(elm).append('<i class="mi-file-text-o"></i><span class="badge">' + fileext + '</span>' );
                }
            });
        }

    $.blueimp.fileupload.prototype._renderUpload= function (files) {

            var ret= this._renderTemplate(
                this.options.uploadTemplate,
                files
            );

            fileIndex++;

            var id="summaryid" + fileIndex;

            ret.find('div[data-attribute="summary"]').attr("id",id);

            id="creditsid" + fileIndex;

            ret.find('div[data-attribute="credits"]').attr("id",id);

            return ret;
        }

    $.blueimp.fileupload.prototype._renderDownload= function (files) {
            return this._renderTemplate(
                this.options.downloadTemplate,
                files
            ).find('a[download]').each(this._enableDragToDesktop).end();
        }

    // Initialize the jQuery File Upload widget:
    $('#fileupload').fileupload(
        {url:'${adminRoot}',
        getFilesFromResponse: function (data) {
                if (data.result && $.isArray(data.result.files)) {
                    return data.result.files;
                }
                return [];
            },
        limitConcurrentUploads: 4
        }
    ).bind('fileuploadsubmit', function (e, data) {

        var extraParams={};

        data.formData=$('#fileupload').serializeArray();

        $(data.context).find('.editable').each(
            function(){
             extraParams[$(this).attr('data-attribute')]=$(this).html();
            }
        );

        data.formData.push({name:'extraParams',value:JSON.stringify(extraParams)});

        //alert(data.formData.extraParams);
        //return false;

    })
    .bind('fileuploadadded',function(e,data){

        var id="summaryid" + fileIndex;

        $('#progress-multi-global').show();
        $('.fileupload-buttonbar .mura-file-start').show();
        $('.fileupload-buttonbar .mura-file-resets').show();

        if(CKEDITOR.instances[id]){
            CKEDITOR.instances[id].destroy();
        }

        CKEDITOR.inline(
                document.getElementById(id),
                {
                    toolbar: 'Basic',
                    width: "75%",
                    customConfig: 'config.js.cfm'
                }
            );

        id="creditsid" + fileIndex;

        if(CKEDITOR.instances[id]){
            CKEDITOR.instances[id].destroy();
        }

        if($("#" + id).hasClass('htmlEditor')){
            CKEDITOR.inline(
                    document.getElementById(id),
                    {
                        toolbar: 'Basic',
                        width: "75%",
                        customConfig: 'config.js.cfm'
                    }
                );
        }

        $(document).on('click', '.mura-file-resets', function(e){
            $('#progress-multi-global').hide();
            $('.fileupload-buttonbar .mura-file-start').hide();
            $('.fileupload-buttonbar .mura-file-resets').hide();

        })

        $(document).on('keypress', '.editable.nolinebreaks', function(e){

            if(e.which == 13){
                e.preventDefault();
                $(this).next('.editable').focus();
            }
        });
    });

});
</script>
`;
}
