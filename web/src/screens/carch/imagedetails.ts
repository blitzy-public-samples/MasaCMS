// The `cArch.imagedetails` page: an image's renditions with their crop, rotate and flip controls (server-only).
import {
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, raw } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { selectLayout, type ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { structOf, structText, structValue, type CarchContentView, type CarchCrumb, type CarchStruct } from './model';
import { dspZoom } from './partials/zoom';
import { renderCarchSecondaryMenu, type CarchMenuContent } from './secondary-menu';
import { carchPageData } from './service';

// Whitespace is what ACF emits for the view: CFML comments drop out and the text around them joins, and whitespace-only
// text between two CFML tags or expressions prints one space after non-whitespace output, else nothing.

const SERVICE = 'strategies-content';
const OPERATION = 'getImageDetailsModel';

/** The site rendition sizes, in the view's loop order. */
const SITE_SIZES = Object.freeze(['Small', 'Medium', 'Large'] as const);
type SiteSize = (typeof SITE_SIZES)[number];

/** A settingsImageSizeBean: its name, and a height and width that are numbers or `AUTO`. */
export interface ImageSize {
  readonly name: string;
  readonly height: string;
  readonly width: string;
}

/** One item of `rc.fileID` with the file reads the view makes for it. */
export interface ImageFile {
  /** The list item, as the view's `f`. */
  readonly fileId: string;
  /** `$.getURLForImage(fileID=f, size='source')`; `''` skips the file. */
  readonly sourceImage: string;
  /** `readMeta(fileID=f).filename`. */
  readonly filename: string;
  /** The `Image Height` and `Image Width` keys of `readSourceImage(f)`, where the source image holds them. */
  readonly imageInfo: CarchStruct;
  /** `$.getURLForImage(fileID=f, size=…, useProtocol=false)` by lower-case size; `custom` for {@link ImageDetailsData.adHocSize}. */
  readonly urls: CarchStruct;
}

/** What the view reads beyond the request. */
export interface ImageDetailsData {
  /** `rc.fileID` once a loaded content bean has filled an empty one. */
  readonly fileId: string;
  /** `rc.contentBean`, loaded when the URL names `contentHistID` and no `userid`. */
  readonly content?: CarchContentView;
  /** The `$.siteConfig()` values the view and its secondary menu read. */
  readonly siteConfig: CarchStruct;
  /** `getCustomImageSizeIterator()` of `rc.siteid`, in iterator order. */
  readonly customSizes: readonly ImageSize[];
  /** The `imageSize` bean a two-part `rc.imagesize` builds (`setName`, then `parseName`). */
  readonly adHocSize?: ImageSize;
  readonly files: readonly ImageFile[];
}

// ---- Screen model ----

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value the model must carry; throws when it is absent. */
function required(struct: CarchStruct, key: string): string {
  if (structValue(struct, key) === undefined) throw new TypeError(`${OPERATION} returned no ${key}`);
  return structText(struct, key);
}

/** The struct under `key`, or an empty one when the model omits it; throws for any other value. */
function structOrEmpty(struct: CarchStruct, key: string): CarchStruct {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return {};
  if (!isStruct(value)) throw new TypeError(`${OPERATION} returned ${key} that is not a struct`);
  return value;
}

/** The rows under `key`; throws unless the model holds an array of structs there. */
function rowsOf(struct: CarchStruct, key: string): readonly CarchStruct[] {
  const value = structValue(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${OPERATION} returned no ${key} rows`);
  return value;
}

const sizeOf = (row: CarchStruct): ImageSize => ({
  name: structText(row, 'name'),
  height: structText(row, 'height'),
  width: structText(row, 'width'),
});

/** The `files` rows, one per non-empty `rc.fileID` item in list order. */
function filesOf(rc: CarchStruct, fileId: string): ImageFile[] {
  const items = cfListToArray(fileId);
  if (items.length === 0) return [];
  const rows = rowsOf(rc, 'files');
  if (rows.length !== items.length) throw new TypeError(`${OPERATION} returned files that do not match rc.fileID`);
  return items.map((item, i) => {
    const row = rows[i] as CarchStruct;
    if (!cfEq(structText(row, 'fileID'), item)) throw new TypeError(`${OPERATION} returned files out of rc.fileID order`);
    return {
      fileId: item,
      sourceImage: required(row, 'sourceImage'),
      filename: structText(row, 'filename'),
      imageInfo: structOrEmpty(row, 'sourceImageInfo'),
      urls: structOrEmpty(row, 'urls'),
    };
  });
}

// strategies-content reports the view's reads under `rc`: `fileID` (the content bean's file attributes and file when
// the request's is empty), `contentBean` (its values plus `editUrl` = getEditURL(compactDisplay), `url` = getURL(),
// `stats` and `crumbArray`), `siteConfig`, `customImageSizes` rows, `customImage` for a two-part `imagesize`, and
// `files` rows of `fileID`, `sourceImage`, `filename`, `sourceImageInfo` and `urls`.
/**
 * The page data of one screen model; `requested` is the request's `rc.fileid`.
 * @throws TypeError When neither the request nor a loaded content bean defines `rc.fileID`, where legacy fails too.
 */
function imageDetailsData(rc: CarchStruct, requested: string | undefined, loadsContent: boolean): ImageDetailsData {
  const content = loadsContent ? structOf(rc, 'contentBean') : undefined;
  let fileId = requested;
  if ((fileId === undefined || fileId === '') && content !== undefined) fileId = required(rc, 'fileID');
  if (fileId === undefined) throw new TypeError('Element FILEID is undefined in RC.');
  const adHoc = structValue(rc, 'customImage');
  return {
    fileId,
    ...(content === undefined ? {} : { content }),
    siteConfig: structOf(rc, 'siteConfig'),
    customSizes: rowsOf(rc, 'customImageSizes').map(sizeOf),
    ...(isStruct(adHoc) ? { adHocSize: sizeOf(adHoc) } : {}),
    files: filesOf(rc, fileId),
  };
}

/** CFML `isDefined('url.<name>')`: the forwarded request target's query, else the pairs of `rc.currentURL`. */
function inUrlScope(req: AdminRequest, name: string): boolean {
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  const names =
    target === null
      ? req.currentUrl
          .replace(/^\.\/\??/, '')
          .split('&')
          .map((pair) => pair.split('=', 1)[0] ?? '')
      : [...new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?') + 1) : '').keys()];
  const lower = name.toLowerCase();
  return names.some((candidate) => candidate.toLowerCase() === lower);
}

/** The operation's query: the view's `rc` reads, `userid` and `contenthistid` only where the URL scope decides them. */
function serviceRc(rc: Rc, urlUserId: boolean, loadsContent: boolean): Rc {
  return {
    siteid: rc.siteid ?? '',
    ...(rc.fileid === undefined ? {} : { fileid: rc.fileid }),
    ...(urlUserId ? { userid: rc.userid ?? '' } : {}),
    ...(loadsContent ? { contenthistid: rc.contenthistid ?? '' } : {}),
    imagesize: rc.imagesize ?? '',
    compactDisplay: rc.compactDisplay ?? '',
  };
}

/**
 * before() and the view's reads: carch defaults, the screen model and the crop links' CSRF tokens; a strategies-content
 * denial answers with the controller's `secure()` redirect.
 * @throws Error When strategies-content rejects the read with another 4xx.
 */
async function fetchImageDetails(ctx: ScreenContext): Promise<ImageDetailsData | PageControllerRedirect> {
  ctx.req = applyCarchDefaults(ctx.req);
  const { req } = ctx;
  const { rc } = req;
  const urlUserId = inUrlScope(req, 'userid');
  const loadsContent = !urlUserId && inUrlScope(req, 'contentHistID');
  const requested = rc.fileid;
  // A non-empty request fileid is the token context as sent, so its tokens are fetched beside the model.
  const known = requested === undefined || requested === '' ? undefined : requested;
  const [outcome] = await Promise.all([
    carchPageData(ctx, 'imagedetails', serviceRc(rc, urlUserId, loadsContent)),
    known === undefined ? undefined : ctx.csrf.prefetch([known]),
  ]);
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected the carch.imagedetails read with HTTP ${outcome.status}`);
  }
  const data = imageDetailsData(outcome.data.rc, requested, loadsContent);
  if (known === undefined && data.fileId !== '') await ctx.csrf.prefetch([data.fileId]);
  return data;
}

const isRedirect = (value: ImageDetailsData | PageControllerRedirect): value is PageControllerRedirect =>
  'kind' in value;

/** Models the redirect step loaded, kept for the same request's load. */
const LOADED = new WeakMap<ScreenContext, ImageDetailsData>();

// ---- Markup ----

/** `$.siteConfig(key)` as CFML text; an unset key reads as `''`. */
const siteValue = (data: ImageDetailsData, key: string): string => structText(data.siteConfig, key);

/** `width/height` as ACF prints it, or `''` unless both are numeric; a zero height fails as ACF division does. */
function ratioOf(width: string, height: string): string {
  if (!cfIsNumeric(height) || !cfIsNumeric(width)) return '';
  const divisor = cfToNumber(height);
  if (divisor === 0) throw new RangeError('Division by zero is not allowed.');
  return cfNumberString(cfToNumber(width) / divisor);
}

/** `rc.<size>ImageRatio` of lines 22-38, which the view computes before any output. */
function siteRatios(data: ImageDetailsData): Readonly<Record<SiteSize, string>> {
  const ratio = (size: SiteSize): string =>
    ratioOf(siteValue(data, `${size}ImageWidth`), siteValue(data, `${size}ImageHeight`));
  return { Small: ratio('Small'), Medium: ratio('Medium'), Large: ratio('Large') };
}

/** One file's render inputs. */
interface FileView {
  readonly ctx: ScreenContext;
  readonly data: ImageDetailsData;
  readonly ratios: Readonly<Record<SiteSize, string>>;
  readonly file: ImageFile;
  /** `rc.imagesize`. */
  readonly imagesize: string;
}

/** A rendition URL of the file; throws when the model omits it. */
function imageUrl(file: ImageFile, size: string): string {
  if (structValue(file.urls, size) === undefined) {
    throw new TypeError(`${OPERATION} returned no ${size} URL for ${file.fileId}`);
  }
  return structText(file.urls, size);
}

/** `?cacheID=<createUUID()>` after a rendition URL. */
const cacheBusted = (url: string): string => `${url}?cacheID=${cfUuid()}`;

/** A bundle label of `session.rb`. */
const label = (ctx: ScreenContext, key: string): string => ctx.rb.rbKey(key);

/** The `fileMap` dimension line of `readSourceImage(f)[key]` (lines 90-95), when its first word is numeric. */
function fileMapLine(file: ImageFile, key: string, property: string): string {
  if (structValue(file.imageInfo, key) === undefined) return '';
  const value = cfListToArray(structText(file.imageInfo, key), ' ')[0] ?? '';
  if (!cfIsNumeric(value)) return '';
  return `\n\t\t\t\t\tfileMap['${encodeJs(file.fileId)}'].${property}=${encodeJs(value)};\n\t\t\t\t\t`;
}

/** The orientation select and Apply button (lines 101-118). */
function orientationBlock(view: FileView): string {
  const { ctx, file } = view;
  const rotate = encodeHtml(label(ctx, 'sitemanager.rotateimage'));
  const flip = encodeHtml(label(ctx, 'sitemanager.flipimage'));
  const option = (value: string, text: string): string =>
    `\n\t\t\t\t\t\t\t\t<option value="${value}"> ${text}</option>`;
  return (
    `\n\t\t\t\t\t<div id="image-orientation" class="mura-control-group">` +
    `\n\t\t\t\t\t\t<label class="mura-control-label">` +
    `\n\t\t\t\t\t\t\t${encodeHtml(label(ctx, 'sitemanager.adjustimage'))}` +
    `\n\t\t\t\t\t\t</label>` +
    `\n\t\t\t\t\t\t\t<select id="image-actions${file.fileId}">` +
    `\n\t\t\t\t\t\t\t\t<option value="">Please Select</option>` +
    option('90', `${rotate} &ndash; 90&deg;`) +
    option('180', `${rotate} &ndash; 180&deg;`) +
    option('270', `${rotate} &ndash; 270&deg;`) +
    option('horizontal', `${flip} &ndash; Horizontal`) +
    option('vertical', `${flip} &ndash; Vertical`) +
    option('diagonal', `${flip} &ndash; Diagonal`) +
    option('antidiagonal', `${flip} &ndash; Anti-Diagonal`) +
    `\n\t\t\t\t\t\t\t</select>` +
    `\n\t\t\t\t\t\t\t<div class="mura-control justify">` +
    `\n\t\t\t\t\t\t\t\t<input type="button" onclick="flipImage('${encodeJs(file.fileId)}');" class="btn" value="${encodeHtmlAttr(label(ctx, 'sitemanager.apply'))}"/>` +
    `\n\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t`
  );
}

/** A site size's controls: the `Small,Medium,Large` loop item (lines 121-133), or the one `rc.imagesize` names (162-174). */
function siteSizeBlock(view: FileView, size: SiteSize, named: boolean): string {
  const { data, file } = view;
  const f = file.fileId;
  const lower = size.toLowerCase();
  const width = siteValue(data, `${size}ImageWidth`);
  const height = siteValue(data, `${size}ImageHeight`);
  const button = named ? '\n\t\t\t\t\t\t\t\t' : '\n\t\t\t\t\t\t\t\t\t';
  const filenameGap = named ? '  ' : ' ';
  const maxWidth = named ? `max-width:${width}px` : `max-width:${width}px;`;
  return (
    `\n\t\t\t\t\t\t<div class="mura-control-group">` +
    `\n\t\t\t\t\t\t\t<label class="mura-control-label">${size} (${width}x${height})</label>\n` +
    `\n\t\t\t\t\t\t\t<div id="${lower}${f}btns" class="btn-group">` +
    `${button}<button type="button" class="btn btn-default btn-small cropper-reset" data-fileid="${f}" data-size="${lower}"><i class="mi-refresh"></i> Reset</button>` +
    `${button}<button type="button" class="btn btn-default btn-small cropper" data-fileid="${f}" data-src="${file.sourceImage}" data-filename="${file.filename}"${filenameGap}data-height="${height}" data-width="${width}" data-ratio="${view.ratios[size]}" data-size="${lower}"><i class="mi-crop"></i> Re-Crop</button>` +
    `\n\t\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t\t\t<div class="mura-control justify">` +
    `\n\t\t\t\t\t\t\t\t<div id="${lower}${f}loader" class="load-inline" style="display:none"></div>` +
    `\n\t\t\t\t\t\t\t\t<img id="${lower}${f}" class="img-responsive" style="${maxWidth}" src="${cacheBusted(imageUrl(file, lower))}"/>` +
    `\n\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t`
  );
}

/** A custom size's controls in the full list (lines 143-155); its image loads through `carch.getImageSizeURL`. */
function customSizeBlock(view: FileView, size: ImageSize): string {
  const { file } = view;
  const f = file.fileId;
  const lower = size.name.toLowerCase();
  return (
    `\n\t\t\t\t\t\t<div class="mura-control-group">` +
    `\n\t\t\t\t\t\t\t<label class="mura-control-label">${encodeHtml(size.name)} (${size.width}x${size.height})</label>\n` +
    `\n\t\t\t\t\t\t\t<div id="${lower}${f}btns" class="btn-group">` +
    `\n\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper-reset" data-fileid="${f}" data-size="${lower}"><i class="mi-refresh"></i> Reset</button>` +
    `\n\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper" data-fileid="${f}" data-src="${file.sourceImage}" data-filename="${file.filename}" data-height="${size.height}"  data-width="${size.width}" data-ratio="${ratioOf(size.width, size.height)}" data-size="${lower}"><i class="mi-crop"></i> Re-Crop</button>` +
    `\n\t\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t\t\t<div class="mura-control justify">` +
    `\n\t\t\t\t\t\t\t\t<div id="${lower}${f}loader" class="load-inline" style="display:none"></div>` +
    `\n\t\t\t\t\t\t\t\t<img class="mura-custom-image img-responsive" data-fileid="${f}" data-size="${lower}" id="${lower}${f}" style="max-width:${size.width}px;" src=""/>` +
    `\n\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t`
  );
}

/** The custom size `rc.imagesize` names (lines 185-197). */
function namedCustomSizeBlock(view: FileView, size: ImageSize): string {
  const { file } = view;
  const f = file.fileId;
  const lower = size.name.toLowerCase();
  return (
    `\n\t\t\t\t\t\t\t\t<div class="mura-control-group">` +
    `\n\t\t\t\t\t\t\t\t\t<label class="mura-control-label">${encodeHtml(size.name)} (${size.width}x${size.height})</label>\n` +
    `\n\t\t\t\t\t\t\t\t\t<div id="${lower}${f}btns" class="btn-group">` +
    `\n\t\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper-reset" data-fileid="${f}" data-size="${lower}"><i class="mi-refresh"></i> Reset</button>` +
    `\n\t\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper" data-fileid="${f}" data-src="${file.sourceImage}" data-filename="${file.filename}" data-height="${size.height}"  data-width="${size.width}" data-ratio="${ratioOf(size.width, size.height)}" data-size="${lower}"><i class="mi-crop"></i> Re-Crop</button>` +
    `\n\t\t\t\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t\t\t\t\t<div class="mura-control justify">` +
    `\n\t\t\t\t\t\t\t\t\t\t<div id="${lower}${f}loader" class="load-inline" style="display:none"></div>` +
    `\n\t\t\t\t\t\t\t\t\t\t<img class="mura-custom-image" data-fileid="${f}" data-size="${lower}" id="${lower}${f}" src=""/>` +
    `\n\t\t\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t\t\t`
  );
}

/** The ad-hoc `W<n>`/`H<n>` size a two-part `rc.imagesize` names (lines 216-232), its rendition loaded directly. */
function adHocSizeBlock(view: FileView, size: ImageSize): string {
  const { file } = view;
  const f = file.fileId;
  const lower = size.name.toLowerCase();
  const sizeAttr = encodeHtmlAttr(view.imagesize).toLowerCase();
  const dims = `data-height="${size.height}"  data-width="${size.width}"`;
  const widthNumeric = cfIsNumeric(size.width);
  // The second width attribute follows the first's closing quote, so the whitespace between them prints one space.
  const sizeAttrs =
    (widthNumeric ? ` width="${size.width}" ` : '') + (cfIsNumeric(size.height) ? ` width="${size.height}"` : '');
  return (
    `\n\t\t\t\t\t\t\t<div class="mura-control-group">` +
    `\n\t\t\t\t\t\t\t\t<label class="mura-control-label">${encodeHtml(size.name)} (${size.width}x${size.height})</label>\n` +
    `\n\t\t\t\t\t\t\t\t<div id="${lower}${f}btns" class="btn-group">` +
    `\n\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper-reset" data-fileid="${f}" data-size="${sizeAttr}" ${dims}><i class="mi-refresh"></i> Reset</button>` +
    `\n\t\t\t\t\t\t\t\t\t<button type="button" class="btn btn-default btn-small cropper" data-fileid="${f}" data-src="${file.sourceImage}" data-filename="${file.filename}" ${dims} data-ratio="${ratioOf(size.width, size.height)}" data-size="${sizeAttr}"><i class="mi-crop"></i> Re-Crop</button>` +
    `\n\t\t\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t\t\t\t<div class="mura-control justify">` +
    `\n\t\t\t\t\t\t\t\t\t<img id="${sizeAttr}${f}"` +
    `\n\t\t\t\t\t\t\t\t\tsrc="${cacheBusted(imageUrl(file, 'custom'))}"` +
    `\n\t\t\t\t\t\t\t\t\t${sizeAttrs}` +
    `\n\t\t\t\t\t\t\t\t\t>` +
    `\n\t\t\t\t\t\t\t\t</div>\n` +
    `\n\t\t\t\t\t\t\t</div>` +
    `\n\t\t\t\t\t\t`
  );
}

/** The controls of a non-empty `rc.imagesize` (lines 158-233): a site size, a custom size or an ad-hoc size. */
function selectedSizeBlock(view: FileView): string {
  const { data, imagesize } = view;
  const siteSize = SITE_SIZES.find((size) => size.toLowerCase() === imagesize.toLowerCase());
  if (siteSize !== undefined) return siteSizeBlock(view, siteSize, true);
  const custom = data.customSizes.find((size) => cfEq(size.name, imagesize));
  if (custom !== undefined) return namedCustomSizeBlock(view, custom);
  if (cfListToArray(imagesize, '_').length !== 2) return '';
  if (data.adHocSize === undefined) throw new TypeError(`${OPERATION} returned no customImage for ${imagesize}`);
  return adHocSizeBlock(view, data.adHocSize);
}

/** One file's script and controls (lines 83-236); nothing for a file without a source image. */
function fileBlock(view: FileView): string {
  const { file } = view;
  if (file.sourceImage === '') return '';
  const controls =
    view.imagesize === ''
      ? orientationBlock(view) +
        SITE_SIZES.map((size) => siteSizeBlock(view, size, false)).join('') +
        view.data.customSizes.map((size) => customSizeBlock(view, size)).join('')
      : selectedSizeBlock(view);
  return (
    `\n\t\t\t\t<script>` +
    `\n\t\t\t\t\tfileMap['${encodeJs(file.fileId)}']={height:0,width:0};\n\t\t\t\t\t` +
    fileMapLine(file, 'Image Height', 'height') +
    fileMapLine(file, 'Image Width', 'width') +
    `\n\t\t\t\t</script>\n\t\t\t\t` +
    `\n\t\t\t\t<h2><i class="mi-picture-o"></i> ${encodeHtml(file.filename)}</h2>\n\n\t\t\t\t` +
    controls
  );
}

/** The crop, flip and size scripts (lines 239-544); `csrf` is the url-format token pair of `rc.fileid`. */
function cropScript(csrf: string, instanceid: string, siteid: string, compact: boolean): string {
  const proxyWidth = compact
    ? `
\t\t\tif (top.location != self.location) {
\t\t\t\tif(jQuery("#ProxyIFrame").length){
\t\t\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t\t\t}
\t\t\t\t\t);
\t\t\t\t} else {
\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'standard'});
\t\t\t\t}
\t\t\t}
\t\t\t`
    : '';
  return (
    `

    <script>
    var currentFileID='';
    var currentCoords='';
\t\tvar currentSize='';
\t\tvar instanceid='${instanceid}';

\t\t$('body').addClass('no-constrain');

\t\tfunction reloadImg(id) {
\t\t   var obj = document.getElementById(id);
\t\t   var src = obj.src;

\t\t   var pos = src.indexOf('?');
\t\t   if (pos >= 0) {
\t\t      src = src.substr(0, pos);
\t\t   }

\t\t   obj.src = src + '?v=' + Math.random();

\t\t   if(instanceid && window.frontEndProxy){
\t\t   \t\tfrontEndProxy.post({cmd:'setImageSrc',instanceid:instanceid,src:obj.src});
\t\t   }

\t\t   return false;
\t\t}

\t\tfunction setImg(id,src) {
\t\t   var obj = document.getElementById(id);

\t\t   var pos = src.indexOf('?');
\t\t   if (pos >= 0) {
\t\t\tobj.src = src + '&v=' + Math.random();
\t\t   } else {
\t\t\tobj.src = src + '?v=' + Math.random();
\t\t   }

\t\t   return false;
\t\t}

\t\tfunction resizeImg(id,w,h) {
\t\t   $('#'+ id).css({'height':h,'width':w});
\t\t   return false;
\t\t}

    function flipImage(fileid){
\t\t\tvar _fileid=fileid;
\t\t\tvar transpose=$('#image-actions' + fileid).val()
    \t//location.href='./index.cfm?muraAction=carch.flipimage&fileid=' + currentFileID + '&siteid=' + siteid;

    \tif(transpose != ''){
    \t\t//alert(transpose);
    \t\tactionModal(
\t    \t\tfunction(){
\t\t\t   \t\t $.get('./index.cfm?muraAction=carch.flipimage&fileid=' + _fileid + '&siteid=' + siteid + '&transpose=' + transpose + '${csrf}&cacheid=' + Math.random(),
\t\t\t\t\t\tfunction(){
\t\t\t\t    \t\t$('#action-modal').remove();
\t\t\t\t\t\t\t\t$(".cropper-reset[data-fileid='" + _fileid + "']").each(function(){
\t\t\t\t\t\t\t\tvar resetFileID=$(this).attr('data-fileid');
\t\t\t\t\t\t\t\tvar resetSize=$(this).attr('data-size');

\t\t\t\t\t\t\t\t$.ajax(
\t\t\t\t\t\t\t    \t{
\t\t\t\t\t\t\t    \t\turl:'./index.cfm?muraAction=carch.cropimage&fileid=' + resetFileID + '&size=' + resetSize + '&siteid=' + siteid + '${csrf}&cacheid=' + Math.random(),
\t\t\t\t\t\t\t\t\t\tsuccess: function(data) {
\t\t\t\t\t\t\t\t\t\t\t\t//alert(JSON.stringify(data));
\t\t\t\t\t\t\t\t\t\t\t\treloadImg(resetSize + resetFileID);
\t\t\t\t\t\t\t\t\t\t\t\tresizeImg(resetSize + resetFileID,data.width,data.height);
\t\t\t\t\t\t\t\t\t\t\t\treturn false;
\t\t\t\t\t\t\t\t\t\t\t}\t,
\t\t\t\t\t\t\t\t\t\tasync:   false
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t);
\t\t\t\t\t\t\t});
\t\t\t\t    \t}
\t\t\t\t\t\t);
\t\t\t   \t}
\t\t\t\t);
\t\t\t}
\t\t\treturn false;
\t  }

\t    function saveCoords(c){currentCoords=c};

\t    function applyCropping(){

\t    \tactionModal(function(){
\t\t\t    //$('#cropper .btn').hide();
\t\t\t \t\t//location.href='./index.cfm?muraAction=carch.cropimage&fileid=' + currentFileID + '&size=' + currentSize + '&x=' + currentCoords.x + '&y=' + currentCoords.y + '&width=' + currentCoords.w + '&height=' + currentCoords.h + '&siteid=' + siteid;
\t\t\t \t\tif(typeof(currentCoords) == 'object'){
\t\t\t    \t$.get('./index.cfm?muraAction=carch.cropimage&fileid=' + currentFileID + '&size=' + currentSize + '&x=' + currentCoords.x + '&y=' + currentCoords.y + '&width=' + currentCoords.w + '&height=' + currentCoords.h + '&siteid=' + siteid + '${csrf}&cacheid=' + Math.random(),
\t\t\t\t\t\t\tfunction(data) {
\t\t\t\t\t\t\t\t//alert(JSON.stringify(data));
\t\t\t\t\t\t\t\treloadImg(currentSize + currentFileID);
\t\t\t\t\t\t\t\tresizeImg(currentSize + currentFileID,data.width,data.height);
\t\t\t\t\t\t\t\t$('#cropper').remove()
\t\t\t\t\t\t\t\t$('#action-modal').remove();
\t\t\t\t\t\t\t}
\t\t\t\t\t\t);
\t\t\t\t\t} else {
\t\t\t\t\t\t$('#cropper').remove();
\t\t\t\t\t\t$('#action-modal').remove();
\t\t\t\t\t}
\t\t\t\t}
\t\t\t);
\t    }

\t    $('.cropper-reset').click(
\t    \tfunction(){
\t    \t\t$('#action-modal').remove();
\t    \t\tvar resetFileID=$(this).attr('data-fileid');
\t\t\t\t\tvar resetSize=$(this).attr('data-size');
\t\t\t\t\t//alert(resetSize + resetFileID);

\t\t    \t\t//location.href='./index.cfm?muraAction=carch.cropimage&fileid=' + resetFileID + '&size=' + resetSize + '&siteid=' + siteid;
\t\t\t\t\tvar url='./index.cfm?muraAction=carch.cropimage&fileid=' + resetFileID + '&size=' + resetSize + '&siteid=' + siteid + '${csrf}&cacheid=' + Math.random();

\t\t\t\t\tif($(this).attr('data-height')){
\t\t\t\t\t\turl= url + '&height=' + $(this).attr('data-height');
\t\t\t\t\t}

\t\t\t\t\tif($(this).attr('data-width')){
\t\t\t\t\t\turl = url + '&width=' + $(this).attr('data-width');
\t\t\t\t\t}

\t\t\t\t\tactionModal(function(){
\t\t\t\t\t    $.ajax(
\t\t\t\t\t    \t{
\t\t\t\t\t    \t\turl:url,
\t\t\t\t\t\t\t\tsuccess: function(data) {
\t\t\t\t\t\t\t\t\t\t\t//alert(JSON.stringify(data));

\t\t\t\t\t\t\t\t\t\t\treloadImg(resetSize + resetFileID);
\t\t\t\t\t\t\t\t\t\t\tresizeImg(resetSize + resetFileID,data.width,data.height);
\t\t\t\t\t\t\t    \t\t\t$('#action-modal').remove();
\t\t\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\tasync:   true
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)}
\t\t\t\t\t);

\t\t    });
\t\t
\t    $('.cropper').click(
\t    \tfunction(){

\t    \tcurrentFileID=$(this).attr('data-fileid');
\t\t\t\tcurrentSize=$(this).attr('data-size');
\t\t\t\tcurrentCoords='';

    \t\tvar jcrop_api;
    \t\tvar $dialogHTML='<div id="cropper"><div class="jc-dialog">';
  \t\t\t$dialogHTML+='<img id="crop-target" src="' + $(this).attr('data-src') + '?cacheid=' + Math.random() +'" /> ';
  \t\t\t$dialogHTML+='<input type="hidden" name="coords" value="" id="coords">';
\t\t\t\t$dialogHTML+='<div class="ui-dialog-buttonpane ui-widget-content ui-helper-clearfix"><div class="ui-dialog-buttonset"><button type="button" class="mura-cancel ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" role="button" onclick="$(this).closest(\\'.ui-dialog-content\\').dialog(\\'close\\');"><span class="ui-button-text">Cancel</span></button><button type="button" class="mura-primary ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" role="button" onclick="applyCropping();"><span class="ui-button-text">Apply Cropping</span></button></div></div>';

\t\t\t\t$dialogHTML+='</div></div>';

        var $dialog = $($dialogHTML);
        var title=$(this).attr('data-filename');
        var scaleby=$(this).attr('data-scaleby');
        var aspectRatio=$(this).attr('data-ratio');
\t\t\t\tvar minSize=[];
\t\t\t\tvar height=$(this).attr('data-height');
\t\t\t\tvar width=$(this).attr('data-width')

\t\t\t\tif(typeof width != 'undefined' && width.toString().toLowerCase() == 'auto'
\t\t\t\t\t|| typeof height != 'undefined' && height.toString().toLowerCase() == 'auto'
\t\t\t\t){
\t\t\t\t\tif(typeof width == 'undefined' || width.toString().toLowerCase() == 'auto'){
\t\t\t\t\t\twidth=0;
\t\t\t\t\t}
\t\t\t\t\tif(typeof height == 'undefined' || height.toString().toLowerCase() == 'auto'){
\t\t\t\t\t\theight=0;
\t\t\t\t\t}
\t\t\t\t\tvar sizeArray=[width,height]
\t\t\t\t} else {
\t\t\t\t\tvar sizeArray=[0,0]
\t\t\t\t}

\t\t\t\tif(sizeArray[0] && sizeArray[0] > fileMap[currentFileID].width ){
\t\t\t\t\tsizeArray[0]=0;
\t\t\t\t}

\t\t\t\tif(sizeArray[1] && sizeArray[10] > fileMap[currentFileID].heigth ){
\t\t\t\t\tsizeArray[1]=0;
\t\t\t\t}

        actionModal(function(){
\t       \t $dialog.find('#crop-target').Jcrop(
\t       \t \t{
\t       \t \t\tboxHeight:600,
\t       \t \t\tboxWidth:600,
\t\t\t\t\t\t\tminSize:sizeArray,
\t       \t \t\taspectRatio:aspectRatio,
\t       \t \t\tonSelect:saveCoords,
\t       \t \t\tonChange:saveCoords
\t       \t \t},
\t       \t \tfunction(){
\t\t\t        jcrop_api = this;
\t\t\t        $dialog.dialog({
\t\t\t            modal: true,
\t\t\t            title: title,
\t\t\t            close: function(){ $dialog.remove(); },
\t\t\t            width: jcrop_api.getWidgetSize()[0]+68,
\t\t\t            resizable: false,
\t\t\t            class: "cropper"
\t\t\t        });
\t\t\t        $('#action-modal').remove();
    \t\t\t});
       \t});
\t    });


\t\t$(document).ready(function(){

\t\t\t$('.load-inline').spin(spinnerArgs2);

\t\t\tvar delay=0;

\t\t\t$('.mura-custom-image').each(
\t\t\t\tfunction(){
\t\t\t\t\tvar self=this;

\t\t\t\t\tsetTimeout(function(){
\t\t\t\t\t\t\t$.getJSON('./?muraAction=carch.getImageSizeURL&siteid=${siteid}&fileid=' + $(self).data('fileid') + '&size=' + $(self).data('size'))
\t\t\t\t\t\t\t.then(function(data){
\t\t\t\t\t\t\t\tvar target=$(self).data('size') + $(self).data('fileid');
\t\t\t\t\t\t\t\tsetImg(target,data);
\t\t\t\t\t\t\t});
\t\t\t\t\t\t},
\t\t\t\t\t\tdelay
\t\t\t\t\t)

\t\t\t\t\tdelay=delay + 5;

\t\t\t\t}
\t\t\t);

\t\t\t` +
    proxyWidth +
    `
\t\t});
\t\t
\t\t</script>

\t    <!-- /Hidden dialog -->
\t</div>
</div>
`
  );
}

/** `rc.contentBean` as the secondary menu reads it; its files branch prints only the edit URL. */
function menuContentOf(bean: CarchContentView): CarchMenuContent {
  const isNew = structText(bean, 'isNew');
  const active = structText(bean, 'active');
  const url = structValue(bean, 'url');
  return {
    isNew: cfIsBoolean(isNew) && cfToBoolean(isNew),
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    active: cfIsNumeric(active) ? cfToNumber(active) : 0,
    filename: structText(bean, 'filename'),
    contentHistId: structText(bean, 'contentHistID'),
    parentId: structText(bean, 'parentID'),
    menuTitle: structText(bean, 'menuTitle'),
    remoteUrl: structText(bean, 'remoteURL'),
    fileId: structText(bean, 'fileID'),
    stats: structOrEmpty(bean, 'stats'),
    editUrl: required(bean, 'editUrl'),
    ...(typeof url === 'string' ? { url } : {}),
  };
}

/** `$.siteConfig('hasLockableNodes')`, which the menu reads with `rc.contentBean`; undefined when unreported. */
function hasLockableNodes(data: ImageDetailsData): boolean | undefined {
  if (structValue(data.siteConfig, 'hasLockableNodes') === undefined) return undefined;
  return cfToBoolean(structText(data.siteConfig, 'hasLockableNodes'));
}

/** The view's header: title, the secondary menu outside compact display and the breadcrumb without `rc.imagesize`. */
function header(ctx: ScreenContext, data: ImageDetailsData, compact: boolean, imagesize: string): string {
  const { content } = data;
  let out = '\n\n\n<div class="mura-header">\n\t<h1>Image Details</h1>\n\n\t';
  if (!compact) {
    const lockable = hasLockableNodes(data);
    out += String(
      renderCarchSecondaryMenu(ctx, {
        rc: ctx.req.rc,
        ...(content === undefined ? {} : { content: menuContentOf(content) }),
        ...(lockable === undefined ? {} : { hasLockableNodes: lockable }),
      }),
    );
  }
  if (imagesize === '' && !compact && content !== undefined) {
    const crumbdata: readonly CarchCrumb[] = rowsOf(content, 'crumbArray');
    // The breadcrumb ends in `</ul>`, so the whitespace before `</cfif>` prints one space.
    out += `${String(dspZoom(ctx, { crumbdata, class: 'breadcrumb' }))} `;
  }
  return `${out}\n\n</div>\n\n\n<div class="block block-constrain">\n<div id="image-details">\n\t<div class="block-content">\n\n\t\n\t`;
}

/** The `cfhtmlhead` text of lines 42-48: the Jcrop script and stylesheet. */
function jcropHead(): string {
  const { context, adminDir } = legacySettings();
  const base = `${context}${adminDir}`;
  return (
    `\n<script src="${base}/assets/js/jquery/jquery.Jcrop.min.js" type="text/javascript"></script>` +
    `\n<link rel="stylesheet" href="${base}/assets/css/jquery/jquery.Jcrop.min.css" type="text/css" />\n`
  );
}

// `#secondarynav#` (lines 549-555) prints nothing: no scope the view resolves defines it, a URL parameter included.
/** The view body and its `cfhtmlhead` text. */
function renderImageDetails(ctx: ScreenContext, data: ImageDetailsData): ShellView {
  const { rc } = ctx.req;
  const compact = selectLayout(rc) === 'compact';
  const imagesize = rc.imagesize ?? '';
  const ratios = siteRatios(data);
  let body = header(ctx, data, compact, imagesize);
  if (data.content !== undefined) {
    body += `\n\t<a class="ui__back" href="${required(data.content, 'editUrl')}&bigui=assoc#panel-assoc">Done <i class="mi-angle-right"></i></a>\n\t`;
  }
  if (data.fileId === '') {
    body += '\n\t<div class="help-block-empty">This content does not have any image attached to it.</div>\n';
  } else {
    const files = data.files.map((file) => fileBlock({ ctx, data, ratios, file, imagesize })).join('');
    const csrf = ctx.csrf.render(data.fileId, 'url').value;
    body +=
      '\n\t\t<script>\n\t\t\tfileMap={};\n\t\t</script>\n\t\t' +
      files +
      cropScript(csrf, encodeJs(rc.instanceid ?? ''), encodeUrl(rc.siteid ?? ''), compact);
  }
  body += '\n\n</div>\n';
  return { body: raw(body), htmlHead: raw(jcropHead()) };
}

/** `cArch.imagedetails`: the image renditions of `rc.fileid` (or the content version's files) with their crop controls. */
export const imagedetailsScreen: PageScreen<ImageDetailsData> = Object.freeze({
  circuit: 'carch',
  action: 'imagedetails',
  mode: 'page',
  owner: CARCH_OWNER,
  gate: carchGate,
  secondaryMenu: 'carch',
  async redirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
    const loaded = await fetchImageDetails(ctx);
    if (isRedirect(loaded)) return loaded;
    LOADED.set(ctx, loaded);
    return undefined;
  },
  async load(ctx: ScreenContext): Promise<ImageDetailsData> {
    const memo = LOADED.get(ctx);
    if (memo !== undefined) return memo;
    const loaded = await fetchImageDetails(ctx);
    if (isRedirect(loaded)) throw new Error(`${SERVICE} denied the carch.imagedetails read`);
    return loaded;
  },
  render: renderImageDetails,
});
