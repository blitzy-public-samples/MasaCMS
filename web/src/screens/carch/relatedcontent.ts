// The `cArch.relatedcontent` page: the related-content set selector a display-object configurator opens (server-only).
import { cfEq, cfUuid } from '@opt2/platform/legacy-compat';
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import { assignContext, type AdminRequest } from '@/lib/request-context';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';
const OPERATION = 'getContentVersionModel';

/** The view's `cfparam` defaults, in view order. */
const VIEW_DEFAULTS: ReadonlyArray<readonly [name: string, value: string]> = [
  ['relatedcontentsetid', ''],
  ['relateditems', '[]'],
];

/** The values of `content.loadBy(contenthistid=rc.contenthistid)` the view prints. */
export interface RelatedContentData {
  readonly contentId: string;
  readonly contentHistId: string;
  readonly type: string;
  readonly subType: string;
  readonly siteId: string;
}

type Struct = Readonly<Record<string, unknown>>;

/** A struct member by case-insensitive name, as CFML reads it; undefined when absent. */
function memberOf(struct: Struct, name: string): unknown {
  if (Object.hasOwn(struct, name)) return struct[name];
  const lower = name.toLowerCase();
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : struct[key];
}

/** A bean getter's value as CFML text: SQL NULL reads as `''`; an absent or complex value throws. */
function beanText(bean: Struct, name: string): string {
  const value = memberOf(bean, name);
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${SERVICE} ${OPERATION} returned no simple rc.contentBean.${name} for carch.relatedcontent`);
}

// The contract leaves the version's rc name open; the carch screens read a loaded content bean as `rc.contentBean`.
/** The printed content version fields of the screen model. */
function relatedContentDataOf(model: CarchPageModel): RelatedContentData {
  const bean = memberOf(model.rc, 'contentBean');
  if (typeof bean !== 'object' || bean === null || Array.isArray(bean)) {
    throw new TypeError(`${SERVICE} ${OPERATION} returned no rc.contentBean for carch.relatedcontent`);
  }
  const struct = bean as Struct;
  return {
    contentId: beanText(struct, 'contentID'),
    contentHistId: beanText(struct, 'contentHistID'),
    type: beanText(struct, 'type'),
    subType: beanText(struct, 'subType'),
    siteId: beanText(struct, 'siteID'),
  };
}

/** The request as carch `before()` and the view's `cfparam`s leave it. */
function withViewDefaults(req: AdminRequest): AdminRequest {
  const carch = applyCarchDefaults(req);
  const missing = VIEW_DEFAULTS.filter(([name]) => carch.rc[name] === undefined);
  return missing.length === 0 ? carch : { ...carch, rc: assignContext(carch.rc, Object.fromEntries(missing)) };
}

/** The rc the version read sends: an empty `contenthistid` matches no version, so a fresh id reads the same new bean. */
function readRc(rc: Rc): Rc {
  return (rc.contenthistid ?? '') === '' ? assignContext(rc, { contenthistid: cfUuid() }) : rc;
}

const reads = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** The view's defaults applied to `ctx.req` and its one version read, shared by the redirect and load steps. */
function versionOutcome(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  let outcome = reads.get(ctx);
  if (outcome === undefined) {
    ctx.req = withViewDefaults(ctx.req);
    outcome = carchPageData(ctx, 'relatedcontent', readRc(ctx.req.rc));
    reads.set(ctx, outcome);
  }
  return outcome;
}

/** A strategies-content denial as the controller's `secure()` redirect; no redirect otherwise. */
async function deniedRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await versionOutcome(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

/** The content version fields the view prints; throws for an answer the page cannot render. */
async function loadRelatedContent(ctx: ScreenContext): Promise<RelatedContentData> {
  const outcome = await versionOutcome(ctx);
  if (outcome.kind === 'ok') return relatedContentDataOf(outcome.data);
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected the carch.relatedcontent read with HTTP ${outcome.status}`);
  }
  throw new Error(`${SERVICE} denied the carch.relatedcontent read; its redirect step answers it`);
}

/**
 * The view's bytes as the ACF 2023 oracle serves them: whitespace management keeps the two newlines ahead of the
 * header, and the commented-out back button and ajax-target comment are not emitted.
 * @throws TypeError When `rc.items` is undefined, as the view's last argument fails in legacy.
 */
export function renderRelatedContentBody(rc: Rc, content: RelatedContentData): SafeHtml {
  const items = rc.items;
  if (items === undefined) throw new TypeError('Element ITEMS is undefined in RC.');
  const setId = rc.relatedcontentsetid ?? '';
  const title = cfEq(setId, 'calendar') ? 'Select Additional Calendars' : 'Select Content';
  return raw(`

<div class="mura-header">
\t
\t\t<h1>${title}</h1>
\t
\t
</div> <!-- /.mura-header -->

<div class="block block-constrain">
\t<div class="block block-bordered">
\t\t<div class="block-content">
\t\t\t<div id="selectRelatedContent"></div>
\t\t\t<div id="selectedRelatedContent" class="control-group">
\t\t\t</div>
\t\t\t<input id="relatedContentSetData" type="hidden" name="relatedContentSetData" value="" />
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

\tfunction getItems(){
\t\tvar raw=$('#relatedContentSetData').val();
\t\tif(raw){
\t\t\tvar parsed=JSON.parse(raw);
\t\t\treturn parsed[0].items;
\t\t} else {
\t\t\treturn [];
\t\t}
\t}

\t$('#updateBtn').click(function(){
\t\t//alert(JSON.stringify(getItems()))
\t\t//return;
\t\tfrontEndProxy.post({
\t\t\tcmd:'setObjectParams',
\t\t\treinit:true,
\t\t\tinstanceid:'${encodeJs(rc.instanceid ?? '')}',
\t\t\tparams:{
\t\t\t\tsource:'${encodeJs(setId)}',
\t\t\t\tsourcetype:'relatedcontent',
\t\t\t\titems: JSON.stringify(getItems())
\t\t\t\t}
\t\t\t});
\t});

\tif($("#ProxyIFrame").length){
\t\t$("#ProxyIFrame").load(
\t\t\tfunction(){
\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t}
\t\t);
\t} else {
\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t}


\tsiteManager.loadRelatedContentSets(
\t\t'${encodeJs(content.contentId)}',
\t\t'${encodeJs(content.contentHistId)}',
\t\t'${encodeJs(content.type)}',
\t\t'${encodeJs(content.subType)}',
\t\t'${encodeJs(content.siteId)}',
\t\t'${encodeJs(setId)}',
\t\t'${encodeJs(items)}',
\t\tfalse
\t);

});
</script>
`);
}

/** The page view: the selector inside the request's layout, with the carch `js.cfm` script. */
function renderRelatedContent(ctx: ScreenContext, content: RelatedContentData): ShellView {
  return { body: renderRelatedContentBody(ctx.req.rc, content), ajax: carchJs(ctx, ctx.req.item) };
}

/** The `cArch.relatedcontent` admin page. */
export const relatedcontentScreen: PageScreen<RelatedContentData> = Object.freeze({
  circuit: 'carch',
  action: 'relatedcontent',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: deniedRedirect,
  load: loadRelatedContent,
  render: renderRelatedContent,
});
