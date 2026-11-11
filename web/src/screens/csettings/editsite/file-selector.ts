// `cf_fileselector` and `cf_filetools` (core/mura/customtags) as they render for a site (settingsBean) bean.
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, encodeJs, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { PlaceholderFileMeta } from './model';

/** `cf_fileselector` attributes for a site bean, plus the bean values and lookups the two tags read. */
export interface FileSelectorOptions {
  readonly name: string;
  readonly property: string;
  /** `bean.getValue(property)`. */
  readonly fileId: string;
  /** `bean.getSiteID()`. */
  readonly siteId: string;
  readonly deleteKey: string;
  // Taken as the tag takes them; a site bean gets no crop or lock control, so neither changes the markup.
  readonly compactDisplay: string;
  readonly locked: string;
  /** Default `medium`, the size `fileMeta.imageUrl` is resolved at. */
  readonly size?: string;
  /** Default `zip`. */
  readonly exampleFileExt?: string;
  /** The tag's `class` attribute; default `''`. */
  readonly className?: string;
  readonly label?: string;
  /** Default `name`. */
  readonly required?: string;
  readonly validation?: string;
  readonly regex?: string;
  readonly message?: string;
  /** `null` when `bean.getFileMetaData(property).getIsNew()`. */
  readonly fileMeta: PlaceholderFileMeta | null;
  readonly rb: RbLookup;
  /** Legacy `createUUID()` for the preview image's `cacheID`. */
  readonly newCacheId: () => string;
  /** The site's Razuna settings; omitted means hostname and API key are both `''`. */
  readonly razuna?: { readonly hostname: string; readonly apiKey: string };
}

const NO_RAZUNA = { hostname: '', apiKey: '' } as const;

/** `contentFileMetaDataBean.hasImageFileExt()`. */
const IMAGE_FILE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif']);

/** `esapiEncode('html_attr', s)`. */
const attrEncoded = (s: string): SafeHtml => raw(encodeHtmlAttr(s));

const EDIT_FORMAT_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/**
 * ACF 2023 `HTMLEditFormat(s)`: drops CR and encodes only `&`, `<`, `>` and `"`, as observed on the legacy server.
 * ESAPI `encodeHtml` also encodes `'`, `:`, `/`, `#` and non-ASCII, which would change the legacy markup.
 */
const editFormat = (s: string): SafeHtml =>
  raw(s.replace(/\r/g, '').replace(/[&<>"]/g, (ch) => EDIT_FORMAT_ENTITIES[ch] ?? ch));

/** A label as legacy echoes `rbFactory.getKeyValue`, unencoded. */
const label = (rb: RbLookup, key: string): SafeHtml => raw(rb.rbKey(key));

/**
 * `cf_filetools` for a site bean: the preview, download and remove controls of a stored file, or nothing without one.
 * Whitespace follows ACF whitespace management, which drops whitespace-only text between two CFML tags.
 */
export function renderFileTools(opts: FileSelectorOptions): SafeHtml {
  const meta = opts.fileMeta;
  if (meta === null) return raw('');
  const isImage = IMAGE_FILE_EXTS.has(meta.fileExt.toLowerCase());
  const preview = isImage
    ? html`
\t\t<img id="assocImage" src="${raw(meta.imageUrl)}?cacheID=${raw(opts.newCacheId())}" />
\t\t<div class="mura-input-set imageToolsButtonGroup">
\t\t\t`
    : null;
  const download = html`
\t\t<a class="btn download-file" onclick="return confirmDialog('${label(opts.rb, 'sitemanager.downloadconfirm')}',function(){location.href='${raw(legacySettings().context)}/index.cfm/_api/render/file/?fileid=${raw(opts.fileId)}&method=attachment&size=source';});"><i class="mi-download"></i></a>
\t`;
  const previewClose = isImage
    ? html`
\t\t</div>
\t`
    : null;
  const remove = html`
\t<div>
\t\t<label class="checkbox inline" for="deleteFileBox">
\t\t\t<input type="checkbox" name="${raw(opts.deleteKey)}" value="1" class="deleteFileBox"/><a href="#" rel="tooltip" title="${label(opts.rb, 'sitemanager.content.fields.removeattachedfiletooltip')}">${label(opts.rb, 'sitemanager.content.fields.removeattachedfile')} <i class="mi-question-sign"></i></a>
\t\t</label>
\t</div>
\t`;
  return html`
<div class="mura-control justify">
${preview}${download}${previewClose}${remove}
</div>
`;
}

/** `cf_fileselector` for a site bean: upload, URL and existing-file tabs, then {@link renderFileTools}. */
export function renderFileSelector(opts: FileSelectorOptions): SafeHtml {
  const { name, property, siteId, rb } = opts;
  const fieldLabel = opts.label ?? '';
  const required = opts.required ?? name;
  const validation = opts.validation ?? '';
  const regex = opts.regex ?? '';
  const message = opts.message ?? '';
  const razuna = opts.razuna ?? NO_RAZUNA;
  // CFML `eq` compares case-insensitively; a site bean's type is never `File`.
  const fileType = property.toLowerCase() === 'fileid' ? 'Image' : 'File';

  const razunaButton =
    razuna.hostname === ''
      ? null
      : html`
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector btn-razuna-icon" value="URL-Razuna"><i></i> Razuna</button>
\t\t\t`;
  const razunaUrl =
    razuna.apiKey === ''
      ? null
      : html`
\t\t<div id="mura-file-url-${raw(name)}" class="mura-file-option mura-file-url-razuna fileTypeOption${raw(name)}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<div class="input-append">
\t\t\t\t\t\t<input type="text" name="${raw(name)}" class="mura-file-selector-${raw(name)} span6 razuna-url" type="url" placeholder="http://${raw(razuna.hostname)}" data-label="${editFormat(fieldLabel)}" data-label="${editFormat(required)}" data-validate="${editFormat(validation)}" data-regex="${editFormat(regex)}" data-message="${editFormat(message)}">
\t\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" onclick="return openFileMetaData('','','${raw(siteId)}','${raw(property)}');"><i class="mi-info-circle"></i></a>
\t\t\t\t\t\t<button type="button" onclick="renderRazunaWindow('newfile');" class="btn btn-razuna"><i class="mi-external-link-sign"></i> ${label(rb, 'sitemanager.content.launchrazuna')}</button>
\t\t\t\t\t</div>
\t\t\t</div>

\t\t</div>
\t\t`;

  return html`
\t<div data-name="${attrEncoded(name)}" data-property="${attrEncoded(property)}" data-fileid="${attrEncoded(opts.fileId)}" data-filetype="${attrEncoded(fileType)}" data-contentid="" data-siteid="${raw(siteId)}" class="mura-file-selector ${raw(opts.className ?? '')}">\t\t\t
\t\t<div class="mura-input-set mura-file-selector-tabs" data-toggle="buttons-radio">
\t\t\t<button type="button" style="display:none">placeholder</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector active" value="Upload"><i class="mi-upload"></i> ${label(rb, 'sitemanager.fileselector.viaupload')}</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="URL"><i class="mi-download"></i> ${label(rb, 'sitemanager.fileselector.viaurl')}</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="Existing"><i class="mi-file-picture-o"></i> ${label(rb, 'sitemanager.fileselector.selectexisting')}</button>
\t\t\t${razunaButton}
\t\t</div>

\t\t<div id="mura-file-upload-${attrEncoded(name)}" class="mura-file-option mura-file-upload fileTypeOption${attrEncoded(name)}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<input name="${attrEncoded(name)}" type="file" class="mura-file-selector-${attrEncoded(name)}"
\t\t\t\t\t\tdata-label="${attrEncoded(fieldLabel)}" data-label="${attrEncoded(required)}" data-validation="${attrEncoded(validation)}" data-regex="${attrEncoded(regex)}" data-message="${attrEncoded(message)}">
\t\t\t\t\t<a style="display:none;" class="btn btn-default" href="" onclick="return openFileMetaData('','','${raw(siteId)}','${raw(encodeJs(property))}');"><i class="mi-info-circle"></i></a>
\t\t\t</div>

\t\t</div>
\t\t<div id="mura-file-url-${raw(name)}" class="mura-file-option mura-file-url fileTypeOption${raw(name)}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<input type="text" name="${raw(name)}" class="mura-file-selector-${raw(name)} span6" type="url" placeholder="http://www.domain.com/yourfile.${raw(opts.exampleFileExt ?? 'zip')}"\tvalue=""
\t\t\t\t\tdata-label="${editFormat(fieldLabel)}" data-label="${editFormat(required)}" data-validate="${editFormat(validation)}" data-regex="${editFormat(regex)}" data-message="${editFormat(message)}">
\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" onclick="return openFileMetaData('','','${raw(siteId)}','${raw(property)}');"><i class="mi-info-circle"></i></a>
\t\t\t</div>

\t\t</div>

\t\t<div id="mura-file-existing-${raw(name)}" class="mura-file-option mura-file-existing fileTypeOption${raw(name)}">

\t\t</div>
\t\t${razunaUrl}${renderFileTools(opts)}
\t</div>


`;
}
