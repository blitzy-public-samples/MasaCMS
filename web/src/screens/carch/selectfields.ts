// `cArch.selectfields`: the collection display-field picker of `admin/core/views/carch/selectfields.cfm` (server-only).
import { cfListToArray, javaTrim } from '@opt2/platform/legacy-compat';
import { encodeJs, html, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const OPERATION = 'getSelectFieldsModel';

/** The picker's two CFML lists, as the transient `feed` bean built from the url fields returns them. */
export interface SelectFieldsData {
  /** `feed.getDisplayList()`. */
  readonly displayList: string;
  /** `feed.getAvailableDisplayList()`: the display fields and content attribute names not in `displayList`. */
  readonly availableDisplayList: string;
}

/** The one strategies-content read of each request, shared by the controller step and `load`. */
const READS = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** The request's model read, made once, after carch before() has replaced `ctx.req` with its defaulted request. */
function readModel(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  let read = READS.get(ctx);
  if (read === undefined) {
    ctx.req = applyCarchDefaults(ctx.req);
    read = carchPageData(ctx, 'selectfields');
    READS.set(ctx, read);
  }
  return read;
}

// A page answers a denial only from its controller step, so the read runs there and `load` reuses it.
/** The controller `secure()` redirect when strategies-content denies the read; undefined otherwise. */
async function deniedRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await readModel(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

/** `model.rc[name]` by case-insensitive name; anything but a string throws, naming the operation. */
function listOf(model: CarchPageModel, name: string): string {
  const lower = name.toLowerCase();
  const key = Object.keys(model.rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = key === undefined ? undefined : model.rc[key];
  if (typeof value !== 'string') throw new TypeError(`${OPERATION} returned no rc.${name} list`);
  return value;
}

// The contract leaves the screen model's `rc` open; these are the feed bean getters' names, as cfeed's models use.
/**
 * Reads `rc.displayList` and `rc.availableDisplayList` of the feed strategies-content builds from the url fields.
 * @throws Error When the read was denied or rejected with another 4xx.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
export async function loadSelectFields(ctx: ScreenContext): Promise<SelectFieldsData> {
  const outcome = await readModel(ctx);
  if (outcome.kind === 'redirect') throw new Error(`${OPERATION} was denied; the controller step answers it`);
  if (outcome.kind === 'rejected') throw new Error(`${OPERATION} rejected carch.selectfields with HTTP ${outcome.status}`);
  return {
    displayList: listOf(outcome.data, 'displayList'),
    availableDisplayList: listOf(outcome.data, 'availableDisplayList'),
  };
}

/** `<cfloop list="#availableList#">` items `listFind(displayList, i)` misses, each `trim(i)` unencoded. */
function availableItems({ displayList, availableDisplayList }: SelectFieldsData): SafeHtml {
  const shown = cfListToArray(displayList);
  return raw(
    cfListToArray(availableDisplayList)
      .filter((item) => !shown.includes(item))
      .map((item) => `\n\t\t\t\t\t\t\t\t<li class="ui-state-default">${javaTrim(item)}</li>\n\t\t\t\t\t\t\t`)
      .join(''),
  );
}

/** `<cfloop list="#displayList#">` items, each `trim(i)` unencoded. */
function displayItems(displayList: string): SafeHtml {
  return raw(
    cfListToArray(displayList)
      .map((item) => `\n\t\t\t\t\t\t\t<li class="ui-state-highlight">${javaTrim(item)}</li>\n\t\t\t\t\t\t`)
      .join(''),
  );
}

// Whitespace follows bytes captured from ACF 2023: whitespace-only text between CFML tags emits nothing.
/** The view (`selectfields.cfm` 82-169), with `js.cfm`'s `request.ajax`; the display list is written unencoded. */
export function renderSelectFields(ctx: ScreenContext, data: SelectFieldsData): ShellView {
  const { req } = ctx;
  const instanceId = raw(encodeJs(req.rc.instanceid ?? ''));
  const body = html`

<div class="mura-header">
\t<h1>Select Fields</h1>
</div> <!-- /.mura-header -->
<div class="block block-constrain">
\t<div class="block block-bordered">
\t  <div class="block-content">
\t\t\t<div class="mura-control-group" id="availableFields">
\t\t\t\t<div id="sortableFields" class="mura-control justify">
\t\t\t\t\t<p class="dragMsg">
\t\t\t\t\t\t<span class="dragFrom half">Drag Fields from Here&hellip;</span><span class="half">&hellip;and Drop Them Here.</span>
\t\t\t\t\t</p>

\t\t\t\t\t
\t\t\t\t\t
\t\t\t\t\t<ul id="availableListSort" class="displayListSortOptions">
\t\t\t\t\t\t${availableItems(data)}
\t\t\t\t\t</ul>

\t\t\t\t\t<ul id="displayListSort" class="displayListSortOptions">
\t\t\t\t\t\t${displayItems(data.displayList)}
\t\t\t\t\t</ul>
\t\t\t\t\t<input type="hidden" id="displayList" class="objectParam" value="${raw(data.displayList)}" name="displayList"  data-displayobjectparam="displayList"/>
\t\t\t\t</div>
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
\tif($("#ProxyIFrame").length){
\t\t$("#ProxyIFrame").load(
\t\t\tfunction(){
\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:600});
\t\t\t}
\t\t);
\t} else {
\t\tfrontEndProxy.post({cmd:'setWidth',width:600});
\t}

\t$('#updateBtn').click(function(){
\t\tfrontEndProxy.post({
\t\t\tcmd:'setObjectParams',
\t\t\treinit:true,
\t\t\tinstanceid:'${instanceId}',
\t\t\tparams:{
\t\t\t\tdisplayList:$('#displayList').val()
\t\t\t\t}
\t\t\t});
\t});

\t$("#availableListSort, #displayListSort").sortable({
\t\tconnectWith: ".displayListSortOptions",
\t\tupdate: function(event) {
\t\t\tevent.stopPropagation();
\t\t\t$("#displayList").val("");
\t\t\t$("#displayListSort > li").each(function() {
\t\t\t\tvar current = $("#displayList").val();

\t\t\t\tif(current != '') {
\t\t\t\t\t$("#displayList").val(current + "," + $(this).html());
\t\t\t\t} else {
\t\t\t\t\t$("#displayList").val($(this).html());
\t\t\t\t}

\t\t\t});

\t\t}
\t}).disableSelection();

});
</script>
`;
  return { body, ajax: carchJs(ctx, req.item) };
}

/** `cArch.selectfields`: view-only compact page behind the carch `before()` gate. */
export const selectfieldsScreen: PageScreen<SelectFieldsData> = Object.freeze({
  circuit: 'carch',
  action: 'selectfields',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: deniedRedirect,
  load: loadSelectFields,
  render: renderSelectFields,
});
