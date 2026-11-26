// The `cArch.variationTargeting` view: a variation's initialization-JS form, or the close document after its save.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { encodeHtml, encodeHtmlAttr, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import {
  closeCompactDisplay,
  type CloseCompactDisplayModel,
  type CloseCompactEdited,
} from './partials/close-compact-display';
import { carchJs } from './partials/js';
import { carchPageData, carchWrite, type CarchOutcome, type CarchPageModel, type CarchWriteResult } from './service';

const SERVICE = 'strategies-content';

/** Admin bundle key of the form heading. */
const HEADING_KEY = 'sitemanager.content.fields.custominitjs';

// Neither strategies-content nor web can read a theme's content renderer, which lives in the legacy web root, so the
// core renderer's `layoutmanager=false` applies, as for the other carch and collection screens.
const USE_LAYOUT_MANAGER = false;

/** A struct the contract leaves open; members match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** What the view renders: the form for the node read, or the close document of the save. */
export type VariationTargetingData =
  | { readonly kind: 'form'; readonly model: CarchPageModel }
  | { readonly kind: 'saved'; readonly result: CarchWriteResult };

/** Data the controller step settled, per request, for `load`. */
const settledData = new WeakMap<ScreenContext, VariationTargetingData>();

/** `struct[name]` by case-insensitive name; undefined when absent. */
function memberOf(struct: Struct, name: string): unknown {
  if (Object.hasOwn(struct, name)) return struct[name];
  const lower = name.toLowerCase();
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : struct[key];
}

/** The nested struct `<path>.<name>`; throws when strategies-content left it out. */
function structOf(struct: Struct, name: string, path: string): Struct {
  const value = memberOf(struct, name);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${SERVICE} returned no ${path}.${name} struct for carch.variationtargeting`);
  }
  return value as Struct;
}

/** The simple member `<path>.<name>` as CFML text, SQL NULL as `''`; throws when it is absent or complex. */
function textOf(struct: Struct, name: string, path: string): string {
  const value = memberOf(struct, name);
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${SERVICE} returned no simple ${path}.${name} for carch.variationtargeting`);
}

/** `rc[name]`, failing with ACF's message when the view reads an undefined element. */
function rcText(rc: Rc, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** Keeps a settled call's data for `load`; a denial answers with its `secure()` redirect instead. */
function keep<T>(
  ctx: ScreenContext,
  outcome: CarchOutcome<T>,
  toData: (data: T) => VariationTargetingData,
): PageControllerRedirect | undefined {
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected carch.variationtargeting with HTTP ${String(outcome.status)}`);
  }
  settledData.set(ctx, toData(outcome.data));
  return undefined;
}

// The view's service calls run in the page's redirect step, the only one that can answer a denial with a redirect.
/** carch before(), then the targeting save when `rc.saveTargeting` is defined, else the node read by `rc.remoteid`. */
async function controllerStep(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  ctx.req = applyCarchDefaults(ctx.req);
  if (ctx.req.rc.saveTargeting !== undefined) {
    return keep(ctx, await carchWrite(ctx, 'variationtargeting'), (result) => ({ kind: 'saved', result }));
  }
  return keep(ctx, await carchPageData(ctx, 'variationtargeting'), (model) => ({ kind: 'form', model }));
}

/** The data {@link controllerStep} settled for this request. */
function loadSettled(ctx: ScreenContext): Promise<VariationTargetingData> {
  const data = settledData.get(ctx);
  if (data !== undefined) return Promise.resolve(data);
  return Promise.reject(new Error('carch.variationtargeting loads only after its controller step'));
}

// The model holds the node as `rc.contentBean`, its `getVariationTargeting()` values as `.variationTargeting`.
/** Lines 13-71 of variationtargeting.cfm, inside its `<cfoutput>` and through its `</script>`. */
function renderForm(ctx: ScreenContext, model: CarchPageModel): SafeHtml {
  const { rc } = ctx.req;
  const bean = structOf(model.rc, 'contentBean', 'rc');
  const targeting = structOf(bean, 'variationTargeting', 'rc.contentBean');
  const initJs = textOf(targeting, 'initjs', 'rc.contentBean.variationTargeting');
  // The heading label is written unencoded, as legacy writes it.
  return raw(`

<div class="mura-header">
\t<h1>${ctx.rb.rbKey(HEADING_KEY)}</h1>
</div> <!-- /.mura-header -->

<div class="alert alert-error">
    WARNING: For advanced user only.
</div>

<form action="./" method="post">
<div class="block block-constrain">
\t<div class="block block-bordered">
\t\t<div class="block-content">
            <div class="mura-control-group">
    \t\t\t<label>
    \t\t\t\tInitalization JS
    \t\t\t</label>
    \t\t\t<textarea name="initjs" id="initjs" rows="10">${encodeHtml(initJs)}</textarea>
    \t\t</div>
    \t\t<div class="form-actions">
    \t\t\t<button class="btn" id="updateBtn"><i class="mi-check-circle"></i>Update</button>
            </div>
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
\t<div class="">
\t\t<p>Example:</p>
\t\t<pre>Mura('SELECTOR').addClass('mxp-editable')</pre>
\t</div><br/>
</div> <!-- /.block-constrain -->
<input type="hidden" name="siteid" value="${encodeHtmlAttr(rcText(rc, 'siteid'))}">
<input type="hidden" name="remoteurl" value="${encodeHtmlAttr(rcText(rc, 'remoteurl'))}">
<input type="hidden" name="remoteid" value="${encodeHtmlAttr(rcText(rc, 'remoteid'))}">
<input type="hidden" name="title" value="${encodeHtmlAttr(rcText(rc, 'title'))}">
<input type="hidden" name="parentid" value="00000000000000000000000000000000099">
<input type="hidden" name="moduleid" value="00000000000000000000000000000000099">
<input type="hidden" name="type" value="Variation">
<input type="hidden" name="compactDisplay" value="true">
<input type="hidden" name="contentid" value="${encodeHtmlAttr(textOf(bean, 'contentid', 'rc.contentBean'))}">
<input type="hidden" name="muraAction" value="carch.variationTargeting">
<input type="hidden" name="saveTargeting" value="true">
</form>

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
`);
}

// Legacy includes the close document whatever the save's errors, so only the saved node is read from the result.
/** `rc.contentBean` after the save: `type`, `contentid`, `remoteurl` and `active` of the result's `data`. */
function savedNode(result: CarchWriteResult): CloseCompactEdited {
  if (result.data === undefined) throw new TypeError(`${SERVICE} saveVariationTargeting returned no node data`);
  const node: Struct = result.data;
  return {
    type: textOf(node, 'type', 'data'),
    contentId: textOf(node, 'contentid', 'data'),
    remoteUrl: textOf(node, 'remoteurl', 'data'),
    active: cfToBoolean(textOf(node, 'active', 'data')),
  };
}

// The contract's write result carries only the node, which is enough for the Variation href (its remote URL). The other
// href branches need active-content URLs it does not carry, so a node of another type fails rather than misdirects.
/** The close document's inputs for the saved node and the request. */
function closeModel(rc: Rc, edited: CloseCompactEdited): CloseCompactDisplayModel {
  if (!cfEq(edited.type, 'Variation')) {
    throw new TypeError(`${SERVICE} saved a ${edited.type} node; carch.variationtargeting closes only Variation nodes`);
  }
  return {
    action: rc.action ?? '',
    homeId: rc.homeID ?? '',
    // Unread: a Variation's href is its remote URL.
    homeUrl: '',
    preview: rc.preview ?? '',
    parentHistId: rc.parenthistid ?? '',
    edited,
    useLayoutManager: USE_LAYOUT_MANAGER,
  };
}

/** The view inside the layout: the close document after a save, else the form with `js.cfm` as `request.ajax`. */
function renderView(ctx: ScreenContext, data: VariationTargetingData): ShellView {
  if (data.kind === 'saved') {
    return { body: raw(closeCompactDisplay(ctx, closeModel(ctx.req.rc, savedNode(data.result)))) };
  }
  return { body: renderForm(ctx, data.model), ajax: carchJs(ctx, ctx.req.item) };
}

/** The `cArch.variationTargeting` admin action. */
export const variationtargetingScreen: PageScreen<VariationTargetingData> = Object.freeze({
  circuit: 'carch',
  action: 'variationtargeting',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: controllerStep,
  load: loadSettled,
  render: renderView,
});
