// The `cArch.selectmedia` page: the front-end editor's image picker of `carch/selectmedia.cfm` (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import { encodeJs, raw } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';
import { carchPageData, type CarchOutcome, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';
const OPERATION = 'getSelectMediaModel';

/** A query row of the screen model; keys match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** One `rsImages` row: an image file of the node, a child or a grandchild, with its small-rendition URL. */
export interface SelectMediaImage {
  readonly fileId: string;
  readonly title: string;
  readonly contentId: string;
  /** `$.getURLForImage(fileid=fileid, size='small')`, as strategies-content resolved it. */
  readonly imageUrl: string;
}

/** What `cArch.selectmedia` renders. */
export interface SelectMediaData {
  /** In the order strategies-content returned them. */
  readonly images: readonly SelectMediaImage[];
}

/** A struct value by case-insensitive key; undefined when absent. */
function field(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A query column as CFML text: SQL NULL reads as `''`; an absent or complex value throws. */
function column(row: Struct, key: string): string {
  const value = field(row, key);
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${OPERATION} returned an rsImages row without a simple ${key}`);
}

// The view's query takes the site and its file pool from `$.siteConfig()`; strategies-content resolves both from the
// token's site, so web sends only `contentid` and reads `rc.rsImages` rows {fileid, title, contentid, imageURL}.
/** The image rows of one screen model. */
function imagesOf(model: CarchPageModel): SelectMediaImage[] {
  const rows = field(model.rc, 'rsImages');
  if (!Array.isArray(rows)) throw new TypeError(`${OPERATION} returned no rsImages rows`);
  return rows.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new TypeError(`${OPERATION} returned an rsImages row that is not a struct`);
    }
    const struct = row as Struct;
    return {
      fileId: column(struct, 'fileid'),
      title: column(struct, 'title'),
      contentId: column(struct, 'contentid'),
      imageUrl: column(struct, 'imageURL'),
    };
  });
}

/** `rc.contentid`, failing as the view's unguarded read does when an ajax request leaves it undefined. */
function contentIdOf(rc: Rc): string {
  const contentId = rc.contentid;
  if (contentId === undefined) throw new TypeError('Element CONTENTID is undefined in RC.');
  return contentId;
}

// The redirect step and `load` receive the same context, so the before() defaults and the read run once per request.
const OUTCOMES = new WeakMap<ScreenContext, Promise<CarchOutcome<CarchPageModel>>>();

/** The request's screen-model read, after carch before() has replaced `ctx.req` with its defaults. */
function outcomeOf(ctx: ScreenContext): Promise<CarchOutcome<CarchPageModel>> {
  const pending = OUTCOMES.get(ctx);
  if (pending !== undefined) return pending;
  ctx.req = applyCarchDefaults(ctx.req);
  contentIdOf(ctx.req.rc);
  const outcome = carchPageData(ctx, 'selectmedia');
  OUTCOMES.set(ctx, outcome);
  return outcome;
}

/** A strategies-content denial answered with the controller's `secure()` redirect. */
async function redirectSelectMedia(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await outcomeOf(ctx);
  return outcome.kind === 'redirect' ? { kind: 'location', location: outcome.location } : undefined;
}

/**
 * The image files of `rc.contentid`, its children and its grandchildren.
 * @throws Error When strategies-content denied the read (the redirect step answers that) or rejected it.
 */
async function loadSelectMedia(ctx: ScreenContext): Promise<SelectMediaData> {
  const outcome = await outcomeOf(ctx);
  if (outcome.kind === 'redirect') throw new Error(`${SERVICE} denied ${OPERATION}; redirect to ${outcome.location}`);
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected ${OPERATION} with HTTP ${String(outcome.status)}`);
  }
  return { images: imagesOf(outcome.data) };
}

// ---- Markup ----

// The text below is the view as ACF emits it: whitespace-only text between CFML tags is dropped, all other text is kept
// byte for byte. The file id, image URL and title print unencoded, as the view prints them, and its labels are literal
// English text rather than bundle keys.

const HEAD = `
<div class="mura-header">
 <h1>Select Image</h1>

\x20
</div> <!-- /.mura-header -->

<div class="block block-constrain">
 <div class="block block-bordered">
\t\t <div class="block-content">
\t\t <div class="mura-control-group">
\t\t\t <div class="mura-control">
\t\t\t\t `;

const EMPTY = `
\t\t\t\t\t <div class="help-block-empty">There are currently no related images available.</div>
\t\t\t\t `;

const CLOSE = `
\t\t\t </div>
\t\t </div>
\t </div>
 </div>
</div>

`;

/** One `image-option`, captioned `Current` for the requested node's own image. */
function imageOption(image: SelectMediaImage, contentId: string): string {
  const caption = cfEq(contentId, image.contentId) ? 'Current' : image.title;
  return `
\t\t\t\t\t\t <div class="image-option" style="float: left; margin: 0 10px; text-align: center" data-fileid="${image.fileId}">
\t\t\t\t\t\t\t <img src="${image.imageUrl}"/>
\t\t\t\t\t\t\t <figcaption>
\t\t\t\t\t\t\t\t ${caption}
\t\t\t\t\t\t\t </figcaption>
\t\t\t\t\t\t </div>
\t\t\t\t\t `;
}

/** The picker script, posting the chosen file id to the front-end instance `rc.instanceid`. */
function pickerScript(instanceId: string): string {
  return `<script>
$(function(){
 $('.image-option').click(function(){
\t //alert($('input[name="fileid"]').val())
\t //return;
\t frontEndProxy.post({
\t\t cmd:'setObjectParams',
\t\t reinit:true,
\t\t instanceid:'${encodeJs(instanceId)}',
\t\t params:{
\t\t\t fileid:$(this).data('fileid')
\t\t\t }
\t\t });
 });

 if($("#ProxyIFrame").length){
\t $("#ProxyIFrame").load(
\t\t function(){
\t\t\t frontEndProxy.post({cmd:'setWidth',width:600});
\t\t }
\t );
 } else {
\t frontEndProxy.post({cmd:'setWidth',width:600});
 }


});
</script>
`;
}

/** The view inside the shell, with the carch `js.cfm` scripts as `request.ajax`. */
function renderSelectMedia(ctx: ScreenContext, data: SelectMediaData): ShellView {
  const { rc } = ctx.req;
  const contentId = contentIdOf(rc);
  const options =
    data.images.length > 0 ? data.images.map((image) => imageOption(image, contentId)).join('') : EMPTY;
  return {
    body: raw(HEAD + options + CLOSE + pickerScript(rc.instanceid ?? '')),
    ajax: carchJs(ctx, 'selectmedia'),
  };
}

/** The `cArch.selectmedia` admin action. */
export const selectmediaScreen: PageScreen<SelectMediaData> = Object.freeze({
  circuit: 'carch',
  action: 'selectmedia',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: redirectSelectMedia,
  load: loadSelectMedia,
  render: renderSelectMedia,
});
