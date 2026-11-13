// `cArch.editText`: the front-end inline text editor modal of `admin/core/views/carch/edittext.cfm` (server-only).
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';

// The view's `muraScope` init is never read, so the page loads nothing.
/** The view markup as ACF emits it, with `rc.instanceid` JavaScript-encoded where the script posts it. */
function edittextBody(instanceid: string | undefined): SafeHtml {
  const instanceId = encodeJs(instanceid);
  return raw(`
<div class="mura-header">
\t<h1>Edit Text</h1>
</div> <!-- /.mura-header -->

<div class="block block-constrain">
\t<div class="block block-bordered">
\t  \t<div class="block-content">
\t\t  \t<div class="mura-control-group">
\t\t\t\t<textarea name="source" id="source" class="htmlEditor" data-width="100%"></textarea>
\t\t\t</div>
\t\t\t<div class="mura-actions">
\t\t\t\t<div class="form-actions">
\t\t\t\t\t<button class="btn mura-primary" id="updateBtn"><i class="mi-check-circle"></i>Update</button>
\t\t\t\t</div>
\t\t\t</div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

<script>
$(function(){
\t$('#updateBtn').click(function(){

\t\tfrontEndProxy.post({
\t\t\tcmd:'setObjectParams',
\t\t\treinit:true,
\t\t\tinstanceid:'${instanceId}',
\t\t\tparams:{
\t\t\t\tsource:CKEDITOR.instances['source'].getData(),
\t\t\t\trender:'client',
\t\t\t\tasync:false,
\t\t\t\tsourcetype:'custom'
\t\t\t\t}
\t\t\t});
\t});

\tfunction initConfiguratorProxy(){

\t\tfunction onFrontEndMessage(messageEvent){

\t\t\tvar parameters=messageEvent.data;

\t\t\tif (parameters["cmd"] == "setObjectParams") {

\t\t\t\tif(parameters["params"]){
\t\t\t\t\toriginParams=parameters["params"];
\t\t\t\t}

\t\t\t\t//console.log(parameters)

\t\t\t\tif(parameters["params"].sourcetype == 'custom'){}
\t\t\t\t\t$('#source').val(parameters["params"].source);
\t\t\t\t\tif(typeof CKEDITOR.instances['source'] != 'undefined'){
\t\t\t\t\t\tCKEDITOR.instances['source'].setData(parameters["params"].source);
\t\t\t\t\t}
\t\t\t\t}

\t\t}

\t\tfrontEndProxy.addEventListener(onFrontEndMessage);
\t\tfrontEndProxy.post({cmd:'setWidth',width:800});
\t\tfrontEndProxy.post({
\t\t\tcmd:'requestObjectParams',
\t\t\tinstanceid:'${instanceId}',
\t\t\ttargetFrame:'modal'
\t\t\t}
\t\t);


\t}

\tif($("#ProxyIFrame").length){
\t\t$("#ProxyIFrame").load(initConfiguratorProxy);
\t} else {
\t\tinitConfiguratorProxy();
\t}

});
</script>
`);
}

/** carch before() defaults, then the editor view with the Site Manager `js.cfm` script. */
function renderEdittext(ctx: ScreenContext): ShellView {
  ctx.req = applyCarchDefaults(ctx.req);
  return { body: edittextBody(ctx.req.rc.instanceid), ajax: carchJs(ctx, 'edittext') };
}

/** `cArch.editText`: view-only page behind the carch `before()` gate. */
export const edittextScreen: PageScreen<undefined> = Object.freeze({
  circuit: 'carch',
  action: 'edittext',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  render: renderEdittext,
});
