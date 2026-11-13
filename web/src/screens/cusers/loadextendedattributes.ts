// The `cUsers.loadExtendedAttributes` fragment with the `extendAttribute.renderAttribute` controls it prints (server-only).
// Text between CFML constructs is emitted as ACF whitespace management leaves it, as captured from the legacy server.
import {
  LEGACY_HTML_CONTENT_TYPE,
  LegacyServiceUnavailableError,
  cfDateAdd,
  cfDateTimeFormat,
  cfEq,
  cfHour,
  cfIsDateText,
  cfIsNumeric,
  cfJavaDateFormat,
  cfListToArray,
  cfLsDateOf,
  cfLsIsDate,
  cfMinute,
  cfNumberString,
  cfTimestampParam,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import { setSessionMuraValue, urlEncodedFormat, type AdminSessionState } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { cusersGate } from './gate';

// ---- Data ----

/** A value the bean holds for an attribute: text, or the date object a stored date or datetime value parses to. */
export type ExtendValue = string | Date;

/** One `tclassextendattributes` row as `extendAttribute.set()` leaves it (trimmed text, `text` typed as `TextBox`). */
export interface ExtendAttributeDefinition {
  readonly attributeID: number;
  readonly name: string;
  /** Stored label; `getLabel()` falls back to the name when it is empty. */
  readonly label: string;
  readonly hint: string;
  readonly type: string;
  readonly adminOnly: number;
  readonly required: string;
  readonly validation: string;
  readonly regex: string;
  readonly message: string;
  readonly defaultValue: string;
  readonly optionList: string;
  readonly optionLabelList: string;
}

/** One extend set of `getExtendSets(inherit=true, container, activeOnly=true)`, with its attributes in order. */
export interface ExtendSetDefinition {
  readonly extendSetID: string;
  readonly categoryID: string;
  readonly name: string;
  readonly attributes: readonly ExtendAttributeDefinition[];
}

/** A stored file's `fileMetaData` as `getFileMetaData(attribute name)` loads it with its `tfiles` columns. */
export interface ExtendFileMetaData {
  readonly filename: string;
  readonly fileExt: string;
  /** `getURLForImage(fileid, size, siteid, useProtocol=false)` of the file. */
  imageUrl(size: string): string;
}

/** The user or group bean the view reads: the subject of `rc.baseID`, or the retained bean of a failed save. */
export interface ExtendSubject {
  readonly userID: string;
  readonly siteID: string;
  /** `getvalue(name, 'useMuraDefault')`: the stored value, else the defined attribute's default, else `useMuraDefault`. */
  valueOf(name: string): ExtendValue;
  /** The file metadata of a File attribute's stored file, or undefined when no metadata row exists for it. */
  fileMetaData(name: string): ExtendFileMetaData | undefined;
}

/** The session values, labels and clock the controls read. */
export interface ExtendRenderContext {
  readonly session: Pick<AdminSessionState, 'dateKeyFormat' | 'locale' | 'localeHasDayParts'>;
  readonly rb: Pick<RbLookup, 'rbKey'>;
  readonly now: Date;
}

/** Arguments of `renderAttribute`. */
export interface RenderExtendAttributeOptions {
  /** `theValue`; `useMuraDefault` renders the attribute's default value. */
  readonly value: ExtendValue;
  readonly context: ExtendRenderContext;
  /** The bean a File attribute's selector reads; without one a File attribute is a plain file input. */
  readonly bean?: ExtendSubject;
  /** Defaults to `false`. */
  readonly compactDisplay?: string;
  /** Defaults to `medium`. */
  readonly size?: string;
  readonly readonly?: boolean;
}

/** Which `cfsavecontent` of the view renders the sets. */
export type ExtendContainer = 'Default' | 'Basic';

/** Options of {@link renderExtendSets}. */
export interface RenderExtendSetsOptions {
  readonly container: ExtendContainer;
  readonly context: ExtendRenderContext;
  /** `rc.compactDisplay`. */
  readonly compactDisplay: string;
  /** `isSuperUser() or isAdminUser()`: admin-only attributes stay editable. */
  readonly privileged: boolean;
}

/** What the fragment renders: the bean and the requested subtype's sets of each container. */
export interface LoadExtendedAttributesData {
  readonly subject: ExtendSubject;
  readonly defaultSets: readonly ExtendSetDefinition[];
  readonly basicSets: readonly ExtendSetDefinition[];
}

/** A value `mura.json` encodes. */
export type LegacyJsonValue = string | number | readonly LegacyJsonValue[] | { readonly [key: string]: LegacyJsonValue };

// ---- CFML output ----

const USE_MURA_DEFAULT = 'useMuraDefault';
const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;
const UNICODE_SEPARATOR = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;
// contentRenderer.setDynamicContent evaluates these tags as CFML (contentRenderer.cfc:2699-2760).
const MURA_TAG = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;

/** Java `Character.isWhitespace`. */
function isJavaWhitespace(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x20)) return true;
  if (cp === 0xa0 || cp === 0x2007 || cp === 0x202f) return false;
  return UNICODE_SEPARATOR.test(ch);
}

/** One output buffer under ACF whitespace management. */
class CfOutput {
  #out = '';

  /** Template text between two CFML constructs; whitespace-only text prints one space after non-whitespace, else nothing. */
  t(text: string): this {
    if (!TEMPLATE_WHITESPACE.test(text)) this.#out += text;
    else if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
    return this;
  }

  /** The output of a `#…#` expression. */
  e(value: string): this {
    this.#out += value;
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

/** CFML `ToString`: a date object as `{ts 'yyyy-mm-dd HH:nn:ss'}`. */
function cfString(value: ExtendValue): string {
  return value instanceof Date ? `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}` : value;
}

const HTML_EDIT_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };

/** ACF 2023 `HTMLEditFormat`: CR dropped, `& " < >` as entities. */
function htmlEditFormat(value: ExtendValue): string {
  return cfString(value)
    .replaceAll('\r', '')
    .replace(/[&"<>]/g, (ch) => HTML_EDIT_ENTITIES[ch] ?? ch);
}

const XML_ENTITIES: Readonly<Record<string, string>> = { ...HTML_EDIT_ENTITIES, "'": '&apos;' };

/** ACF 2023 `XMLFormat`: CR dropped, `& " ' < >` as entities, U+00A0-U+00FF as `&#xhh;`. */
function xmlFormat(text: string): string {
  return text
    .replaceAll('\r', '')
    .replace(/[&"'<>\u00a0-\u00ff]/g, (ch) => XML_ENTITIES[ch] ?? `&#x${ch.charCodeAt(0).toString(16)};`);
}

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** CFML `JSStringFormat`. */
function jsStringFormat(text: string): string {
  return text.replace(/[\\"'\n\r\t\b\f]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);
}

/** `contentRenderer.setDynamicContent`; text holding a `[mura]` tag needs the CFML runtime, so it fails closed. */
function setDynamicContent(text: string): string {
  if (MURA_TAG.test(text)) {
    throw new LegacyServiceUnavailableError('A [mura] tag needs the CFML runtime', 'admin', 'extended-attribute-mura-tag');
  }
  return text;
}

const isUseMuraDefault = (value: ExtendValue): boolean => typeof value === 'string' && cfEq(value, USE_MURA_DEFAULT);

/** `getLabel()`. */
const labelOf = (attr: ExtendAttributeDefinition): string => (attr.label !== '' ? attr.label : attr.name);

/** `listGetAt(list, position + 1, '^')`, failing as ACF does past the end of the list. */
function caretItem(items: readonly string[], position: number, list: string): string {
  const item = items[position];
  if (item === undefined) throw new RangeError(`Invalid list index ${position + 1} of list ${list}`);
  return item;
}

/** `LSDateFormat(value, session.dateKeyFormat)` under the session locale: '' for blank text. */
function lsDateFormat(value: ExtendValue, ctx: ExtendRenderContext): string {
  const date = value instanceof Date ? value : cfLsDateOf(value, ctx.session.locale);
  return date === null ? '' : cfJavaDateFormat(date, ctx.session.dateKeyFormat);
}

/** `bean.getValue(name)` without a default, once the view has read the value: '' where `useMuraDefault` stands. */
function beanValue(bean: ExtendSubject, name: string): string {
  const value = bean.valueOf(name);
  return isUseMuraDefault(value) ? '' : cfString(value);
}

/** The `ExtendRenderContext` of a screen request. */
export function extendRenderContext(ctx: Pick<ScreenContext, 'req' | 'rb' | 'now'>): ExtendRenderContext {
  return { session: ctx.req.session, rb: ctx.rb, now: ctx.now };
}

// ---- Custom tags ----

/** `<option>`s `from`..`to` as `cf_timeselector` loops them, `selected` on `chosen`, each labelled by `text`. */
function timeOptions(o: CfOutput, from: number, to: number, chosen: number, text: (n: number) => string): void {
  for (let n = from; n <= to; n += 1) {
    o.t('<option value="').e(String(n)).t('" ');
    if (n === chosen) o.t('selected');
    o.t('>').e(text(n)).t('</option>');
  }
}

/** One time select of `cf_timeselector`: id `mura-<name><part>`, class `time mura-datepicker<name>`, empty name. */
function openTimeSelect(o: CfOutput, open: string, name: string, part: string): void {
  const field = encodeHtmlAttr(name);
  o.t(open).e(encodeHtmlAttr(`mura-${name}${part}`)).t('" class="').e('time').t(' mura-datepicker').e(field);
  o.t('" name="').e('').t('">');
}

/** `cf_timeselector` with the attributes `cf_datetimeselector` passes it. */
function renderTimeSelector(o: CfOutput, name: string, time: ExtendValue, ctx: ExtendRenderContext): void {
  // hour() and minute() of a value lsIsDate or isDate reads, which throw as ACF's do when its cast fails; else 0 and 0.
  const readable = time instanceof Date || cfLsIsDate(time, ctx.session.locale) || cfIsDateText(time);
  const parsed = readable ? cfTimestampParam(time) : null;
  let hour = parsed === null ? 0 : cfHour(parsed);
  const minute = parsed === null ? 0 : cfMinute(parsed);
  const { localeHasDayParts } = ctx.session;
  o.t('\n').t('\n\t');
  if (localeHasDayParts) {
    const pm = hour >= 12;
    if (hour > 12) hour -= 12;
    else if (hour === 0) hour = 12;
    o.t('\n\t\t');
    openTimeSelect(o, '\n\t\t<select id="', name, 'Hour');
    timeOptions(o, 1, 12, hour, String);
    o.t('</select>\n\t');
    openTimeSelect(o, '\n\n\t<select id="', name, 'Minute');
    timeOptions(o, 0, 59, minute, (n) => String(n).padStart(2, '0'));
    o.t('</select>\n\n\t');
    openTimeSelect(o, '\n\t\t<select id="', name, 'DayPart');
    o.t('<option value="AM">AM</option><option value="PM" ');
    if (pm) o.t('selected');
    o.t('>PM</option></select>\n\t');
  } else {
    openTimeSelect(o, '\n\t\t<select  id="', name, 'Hour');
    timeOptions(o, 0, 23, hour, String);
    o.t('</select>\n\t');
    openTimeSelect(o, '\n\n\t<select id="', name, 'Minute');
    timeOptions(o, 0, 59, minute, (n) => String(n).padStart(2, '0'));
    o.t('</select>\n\n\t');
  }
  o.t('\n\n').t('\n');
}

/** `cf_datetimeselector name datetime required message`: date field, time selects, hidden value and change script. */
function renderDatetimeSelector(o: CfOutput, attr: ExtendAttributeDefinition, datetime: ExtendValue, ctx: ExtendRenderContext): void {
  const { name } = attr;
  // `isDate(datetime) and dateDiff('yyyy', now(), datetime) gt 50` clears the value; the time selects keep the original.
  const isDate = datetime instanceof Date || cfIsDateText(datetime);
  const tooLate = isDate && cfDateAdd('yyyy', 51, ctx.now).getTime() <= cfTimestampParam(datetime).getTime();
  const kept: ExtendValue = tooLate ? '' : datetime;
  const field = encodeHtmlAttr(name);
  o.t('\n\n');
  o.t('\n<input type="text" autocomplete="off" class="datepicker ').e(encodeHtmlAttr('')).t(' ').e(encodeHtmlAttr('span3'));
  o.t(' mura-datepicker').e(field).t('" value="').e(lsDateFormat(kept, ctx)).t('" maxlength="12" id="mura-datepicker-');
  o.e(field).t('"/>');
  o.t('\n').t('\n');
  renderTimeSelector(o, name, datetime, ctx);
  o.t('\n');
  o.t('\n<input type="hidden" id="mura-').e(field).t('" name="').e(field).t('" value="').e(encodeHtmlAttr(cfString(kept)));
  o.t('" data-required="').e(encodeHtmlAttr(attr.required)).t('" data-required="').e(encodeHtmlAttr(attr.message));
  o.t("\"/>\n<script>\n\t$(function(){\n\t\t$('.mura-datepicker").e(encodeJs(name));
  o.t("').change(\n\t\t\tfunction(){\n\t\t\t\tparseDateTimeSelector('").e(encodeJs(name));
  o.t("');\n\t\t\t}\n\t\t);\n\t});\n</script>\n").t('\n');
}

const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif']);
const CROPPABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);

// The bean is a user or group: an entity other than `site` and `content`, whose numeric type is never `File`, so the
// tag's content-only branches (version, metadata, lock, unlock) never render.
/** `cf_filetools bean property deleteKey compactDisplay size` for a user or group bean. */
function renderFileTools(
  o: CfOutput,
  property: string,
  bean: ExtendSubject,
  deleteKey: string,
  compactDisplay: string,
  size: string,
  ctx: ExtendRenderContext,
): void {
  const meta = bean.fileMetaData(property);
  o.t('\n');
  if (meta !== undefined) {
    const fileExt = meta.fileExt.toLowerCase();
    const hasImage = IMAGE_FILE_EXTENSIONS.has(fileExt);
    const fileId = beanValue(bean, property);
    o.t('\n<div class="mura-control justify">\n').t('\n\t');
    if (!hasImage && !cfEq(property, 'fileid')) {
      o.t('\n\t     <div class="mura-file ').e(beanValue(bean, 'fileExt').toLowerCase()).t('">\n\t     \t');
      o.t('\n\t\t \t<i class="').t('mi-file-text-o').t(' mi-2x"></i> ').e(htmlEditFormat(meta.filename));
      o.t('\n\t     </div>\n\n\t');
    }
    o.t('\n\n\t');
    if (hasImage) {
      o.t('\n\t\t<img id="assocImage" src="').e(meta.imageUrl(size)).t('?cacheID=').e(cfUuid());
      o.t('" />\n\t\t<div class="mura-input-set imageToolsButtonGroup">\n\t\t\t');
      if (CROPPABLE_FILE_EXTENSIONS.has(fileExt)) {
        o.t('\n\t\t\t\t');
        o.t('\n\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.imagedetails&userid=').e(bean.userID).t('&siteid=');
        o.e(bean.siteID).t('&fileid=').e(fileId).t('&compactDisplay=').e(urlEncodedFormat(compactDisplay));
        o.t('"><i class="mi-crop"></i></a>\n\t\t\t\t').t('\n\t\t\t');
      }
      o.t('\n\t\t\t').t('\n\t');
    }
    o.t('\n\t');
    o.t("\n\t\t<a class=\"btn download-file\" onclick=\"return confirmDialog('").e(ctx.rb.rbKey('sitemanager.downloadconfirm'));
    o.t("',function(){location.href='").e(legacySettings().context).t('/index.cfm/_api/render/file/?fileid=').e(fileId);
    o.t("&method=attachment&size=source';});\"><i class=\"mi-download\"></i></a>\n\t").t('\n\t');
    if (hasImage) o.t('\n\t\t</div>\n\t');
    o.t('\n\n\t');
    o.t('\n\t<div>\n\t\t<label class="checkbox inline" for="deleteFileBox">\n\t\t\t<input type="checkbox" name="').e(deleteKey);
    o.t('" value="1" class="deleteFileBox"/><a href="#" rel="tooltip" title="');
    o.e(ctx.rb.rbKey('sitemanager.content.fields.removeattachedfiletooltip')).t('">');
    o.e(ctx.rb.rbKey('sitemanager.content.fields.removeattachedfile'));
    o.t(' <i class="mi-question-sign"></i></a>\n\t\t</label>\n\t</div>\n\t').t('\n\n\t').t('\n').t('\n</div>\n');
  }
  o.t('\n');
}

/** `cf_fileselector` as renderAttribute calls it for a File attribute of a user or group bean. */
function renderFileSelector(
  o: CfOutput,
  attr: ExtendAttributeDefinition,
  bean: ExtendSubject,
  compactDisplay: string,
  size: string,
  ctx: ExtendRenderContext,
): void {
  const { name, required, validation, regex, message } = attr;
  const label = labelOf(attr);
  const filetype = cfEq(name, 'fileid') ? 'Image' : 'File';
  const field = encodeHtmlAttr(name);
  o.t('\n');
  o.t('\n\t<div data-name="').e(field).t('" data-property="').e(field).t('" data-fileid="');
  o.e(encodeHtmlAttr(cfString(bean.valueOf(name)))).t('" data-filetype="').e(encodeHtmlAttr(filetype));
  o.t('" data-contentid="').e('').t('" data-siteid="').e(bean.siteID).t('" class="mura-file-selector ').e('');
  o.t('">\t\t\t\n\t\t<div class="mura-input-set mura-file-selector-tabs" data-toggle="buttons-radio">\n\t\t\t');
  o.t('<button type="button" style="display:none">placeholder</button>\n\t\t\t');
  o.t('<button type="button" class="btn btn-default mura-file-type-selector active" value="Upload"><i class="mi-upload"></i> ');
  o.e(ctx.rb.rbKey('sitemanager.fileselector.viaupload')).t('</button>\n\t\t\t');
  o.t('<button type="button" class="btn btn-default mura-file-type-selector" value="URL"><i class="mi-download"></i> ');
  o.e(ctx.rb.rbKey('sitemanager.fileselector.viaurl')).t('</button>\n\t\t\t');
  o.t('<button type="button" class="btn btn-default mura-file-type-selector" value="Existing"><i class="mi-file-picture-o"></i> ');
  o.e(ctx.rb.rbKey('sitemanager.fileselector.selectexisting')).t('</button>\n\t\t\t');
  // No site carries Razuna settings in the target, so the Razuna button and URL field never render.
  o.t('\n\t\t</div>\n\n\t\t<div id="mura-file-upload-').e(field).t('" class="mura-file-option mura-file-upload fileTypeOption');
  o.e(field).t('">\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<input name="').e(field);
  o.t('" type="file" class="mura-file-selector-').e(field).t('"\n\t\t\t\t\t\tdata-label="').e(encodeHtmlAttr(label));
  o.t('" data-label="').e(encodeHtmlAttr(required)).t('" data-validation="').e(encodeHtmlAttr(validation));
  o.t('" data-regex="').e(encodeHtmlAttr(regex)).t('" data-message="').e(encodeHtmlAttr(message));
  o.t('">\n\t\t\t\t\t<a style="display:none;" class="btn btn-default" href="" onclick="return openFileMetaData(\'').e('');
  o.t("','','").e(bean.siteID).t("','").e(encodeJs(name));
  o.t('\');"><i class="mi-info-circle"></i></a>\n\t\t\t</div>\n\n\t\t</div>\n\t\t<div id="mura-file-url-').e(name);
  o.t('" class="mura-file-option mura-file-url fileTypeOption').e(name);
  o.t('">\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<input type="text" name="').e(name);
  o.t('" class="mura-file-selector-').e(name).t(' span6" type="url" placeholder="http://www.domain.com/yourfile.').e('zip');
  o.t('"\tvalue=""\n\t\t\t\t\tdata-label="').e(htmlEditFormat(label)).t('" data-label="').e(htmlEditFormat(required));
  o.t('" data-validate="').e(htmlEditFormat(validation)).t('" data-regex="').e(htmlEditFormat(regex));
  o.t('" data-message="').e(htmlEditFormat(message));
  o.t('">\n\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" onclick="return openFileMetaData(\'');
  o.e('').t("','','").e(bean.siteID).t("','").e(name);
  o.t('\');"><i class="mi-info-circle"></i></a>\n\t\t\t</div>\n\n\t\t</div>\n\n\t\t<div id="mura-file-existing-').e(name);
  o.t('" class="mura-file-option mura-file-existing fileTypeOption').e(name).t('">\n\n\t\t</div>\n\t\t');
  o.t('\n\t\t').t('\n\n\t\t').t('\n\n\t\t').t('\n\t\t\t');
  renderFileTools(o, name, bean, `extDelete${attr.attributeID}`, compactDisplay, size, ctx);
  o.t('\n\t\t').t('\n\t</div>\n\n\n');
}

// ---- renderAttribute ----

/** ` data-message="…"` when the attribute has a message. */
function dataMessage(o: CfOutput, attr: ExtendAttributeDefinition): void {
  if (attr.message !== '') o.t(' data-message="').e(xmlFormat(attr.message)).t('"');
}

/** ` data-validate="…"` when set, then ` data-regex="…"` for Regex validation, both unencoded. */
function dataValidation(o: CfOutput, attr: ExtendAttributeDefinition): void {
  if (attr.validation !== '') o.t(' data-validate="').e(attr.validation).t('"');
  if (cfEq(attr.validation, 'Regex')) o.t(' data-regex="').e(attr.regex).t('"');
}

/** TextBox/Text without datetime validation: a color picker, or a text input that is a date field for date validation. */
function renderTextInput(o: CfOutput, attr: ExtendAttributeDefinition, value: ExtendValue, ctx: ExtendRenderContext): void {
  const isDate = cfEq(attr.validation, 'date');
  const shown = htmlEditFormat(isDate ? lsDateFormat(value, ctx) : value);
  const key = attr.name;
  const label = xmlFormat(labelOf(attr));
  o.t('\n\t\t\t\t\t').t('\n\t\t\t\t\t\t');
  if (cfEq(attr.validation, 'color')) {
    o.t('\n\n\t\t\t\t\t\t\t<div class="input-group mura-colorpicker">\n\t\t\t\t\t\t\t\t<span class="input-group-addon">');
    o.t('<i class="mura-colorpicker-swatch" style="background-color:').e(shown);
    o.t('"></i></span>\n\t\t\t\t\t\t\t\t<input type="text" id="').e(key).t('" name="').e(key);
    o.t('" placeholder="Select Color" autocomplete="off"  value="').e(shown).t('" data-label="').e(label);
    o.t('" data-required="').e(attr.required).t('"');
    dataMessage(o, attr);
    o.t('>\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t');
  } else {
    o.t('\n\n\t\t\t\t\t\t\t<input type="text" name="').e(key).t('" class="text');
    if (isDate) o.t(' datepicker');
    o.t('" id="').e(key).t('" data-label="').e(label).t('" value="').e(shown).t('" data-required="').e(attr.required).t('"');
    dataValidation(o, attr);
    dataMessage(o, attr);
    o.t(' />\n\n\t\t\t\t\t\t');
  }
  o.t('\t\n\n\t\t\t\t\t\t').t('\n\t\t\t\t');
}

/** SelectBox/MultiSelectBox: the multi-select's empty hidden companion, then the select and its `^` options. */
function renderSelect(o: CfOutput, attr: ExtendAttributeDefinition, value: ExtendValue, multiple: boolean): void {
  const optionList = setDynamicContent(attr.optionList);
  const labelList = setDynamicContent(attr.optionLabelList);
  const labels = cfListToArray(labelList, '^');
  const selectedText = cfString(value);
  const key = attr.name;
  if (multiple) o.t('<input type="hidden" name="').e(key).t('" value="" />');
  o.t('<select name="').e(key).t('" id="').e(key).t('" data-label="').e(xmlFormat(labelOf(attr)));
  o.t('" data-required="').e(attr.required).t('"');
  dataMessage(o, attr);
  if (multiple) o.t(' multiple="multiple"');
  o.t('>');
  cfListToArray(optionList, '^').forEach((option, position) => {
    o.t('<option value="').e(xmlFormat(option)).t('"');
    const chosen =
      cfEq(option, selectedText) ||
      cfListToArray(selectedText, '^').includes(option) ||
      cfListToArray(selectedText).includes(option);
    if (chosen) o.t(' selected="selected"');
    o.t('>').e(labelList !== '' ? caretItem(labels, position, labelList) : option).t('</option>');
  });
  o.t('</select>');
}

/** RadioGroup: one inline radio label per `^` option. */
function renderRadioGroup(o: CfOutput, attr: ExtendAttributeDefinition, value: ExtendValue): void {
  const optionList = setDynamicContent(attr.optionList);
  const labelList = setDynamicContent(attr.optionLabelList);
  const labels = cfListToArray(labelList, '^');
  const checkedText = cfString(value);
  const key = attr.name;
  cfListToArray(optionList, '^').forEach((option, position) => {
    o.t('<label class="radio inline"><input type="radio" id="').e(key).t('" name="').e(key).t('" value="');
    o.e(xmlFormat(option)).t('"');
    if (cfEq(option, checkedText)) o.t(' checked="checked"');
    o.t(' /> ').e(labelList !== '' ? caretItem(labels, position, labelList) : option).t('</label> ');
  });
}

/**
 * `extendAttribute.renderAttribute(theValue, bean, compactDisplay, size, readonly)`: the attribute's form control, or
 * its bare value when read-only.
 * @throws LegacyServiceUnavailableError When the default value or an option list holds a `[mura]` tag.
 */
export function renderExtendAttribute(attr: ExtendAttributeDefinition, options: RenderExtendAttributeOptions): SafeHtml {
  const { context: ctx, bean, compactDisplay = 'false', size = 'medium', readonly = false } = options;
  const value = isUseMuraDefault(options.value) ? setDynamicContent(attr.defaultValue) : options.value;
  if (readonly) return raw(cfString(value));
  const o = new CfOutput();
  const key = attr.name;
  const label = xmlFormat(labelOf(attr));
  // ACF's cfswitch Java-trims the expression and matches each case ignoring case.
  switch (javaTrim(attr.type).toLowerCase()) {
    case 'hidden':
      o.t('<input type="hidden" name="').e(key).t('" id="').e(key).t('" data-label="').e(label).t('" value="');
      o.e(htmlEditFormat(value)).t('" />');
      break;
    case 'textbox':
    case 'text':
      if (cfEq(attr.validation, 'datetime')) renderDatetimeSelector(o, attr, value, ctx);
      else renderTextInput(o, attr, value, ctx);
      break;
    case 'textarea':
    case 'htmleditor':
      o.t('<textarea name="').e(key).t('" id="').e(key).t('" data-label="').e(label).t('" data-required="');
      o.e(attr.required).t('"');
      dataMessage(o, attr);
      if (cfEq(attr.type, 'HTMLEditor')) o.t(' class="htmlEditor"');
      dataValidation(o, attr);
      o.t('>').e(htmlEditFormat(value)).t('</textarea>');
      break;
    case 'selectbox':
    case 'multiselectbox':
      renderSelect(o, attr, value, cfEq(attr.type, 'MultiSelectBox'));
      break;
    case 'radiogroup':
      renderRadioGroup(o, attr, value);
      break;
    case 'file':
      if (bean !== undefined) {
        renderFileSelector(o, attr, bean, compactDisplay, size, ctx);
      } else {
        o.t('<input type="file" name="').e(key).t('" id="').e(key).t('" data-label="').e(label);
        o.t('" value="" data-required="').e(attr.required).t('"');
        dataValidation(o, attr);
        dataMessage(o, attr);
        o.t('/>');
      }
      break;
    default:
      break;
  }
  return raw(o.toString());
}

// ---- The view ----

/** The text after an attribute's URL buttons, which differs between the view's two `cfsavecontent` blocks. */
const CONTROL_GROUP_END: Readonly<Record<ExtendContainer, string>> = Object.freeze({
  Default: '\n\t\t\t\t\t\t</div>\n\t\t\t\t\t',
  Basic: '\n\n\t\t\t\t\t\t</div>\n\t\t\t\t\t',
});

/** One attribute's control group; a Hidden attribute is edited as a TextBox. */
function renderControlGroup(
  o: CfOutput,
  attr: ExtendAttributeDefinition,
  subject: ExtendSubject,
  options: RenderExtendSetsOptions,
): void {
  const readonly = attr.adminOnly !== 0 && !options.privileged;
  const isHidden = cfEq(attr.type, 'Hidden');
  const control: ExtendAttributeDefinition = isHidden ? { ...attr, type: 'TextBox' } : attr;
  const label = labelOf(control);
  o.t('\n\t\t\t\t\t\t').t('\n\t\t\t\t\t\t').t('\n\t\t\t\t\t\t').t('\n\n\t\t\t\t\t\t').t('\n\t\t\t\t\t\t');
  if (isHidden) o.t('\n\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t');
  o.t('\n\n\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t');
  if (control.hint !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t<span data-toggle="popover"\n\t\t\t\t\t\t\t\t\t\ttitle=""\n\t\t\t\t\t\t\t\t\t\tdata-placement="right"');
    o.t('\n\t\t\t\t\t\t\t\t\t\tdata-content="').e(encodeHtmlAttr(control.hint));
    o.t('"\n\t\t\t\t\t\t\t\t\t\tdata-original-title="').e(encodeHtmlAttr(label)).t('">\n\t\t\t\t\t\t\t\t\t\t');
    o.e(encodeHtml(label)).t(' <i class="mi-question-circle"></i>\n\t\t\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t').e(encodeHtml(label)).t('\n\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t\t');
  const value = subject.valueOf(attr.name);
  const controlOptions = { value, context: options.context, bean: subject, compactDisplay: options.compactDisplay, readonly };
  o.e(renderExtendAttribute(control, { ...controlOptions, size: 'medium' }).value);
  o.t('\n\n\t\t\t\t\t\t\t');
  if (!readonly && cfEq(control.validation, 'URL')) {
    // No site carries Razuna settings in the target, so only the server asset browser renders.
    o.t('\n\t\t\t\t\t\t\t\t');
    o.t('\n\t\t\t\t\t\t\t\t\t<div class="btn-group">\n\t\t\t\t\t\t\t\t\t\t<button type="button" data-target="');
    o.e(encodeJs(control.name)).t('" data-resourcetype="user" class="btn mura-file-type-selector" title="Select a File from Server">');
    o.t('<i class="mi-folder-open"></i> Browse Assets</button>\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t');
    o.t('\n\t\t\t\t\t\t\t');
  }
  o.t(CONTROL_GROUP_END[options.container]);
}

/**
 * One of the view's `cfsavecontent` blocks, trimmed as the view trims it: per set its `span.extendset` with the hidden
 * set id, the encoded heading and each attribute's control group.
 */
export function renderExtendSets(
  sets: readonly ExtendSetDefinition[],
  subject: ExtendSubject,
  options: RenderExtendSetsOptions,
): SafeHtml {
  const o = new CfOutput();
  o.t('\n\t').t('\n\t\t');
  if (sets.length > 0) {
    o.t('\n\t\t\t');
    for (const set of sets) {
      o.t('\n\t\t\t\t').t('\n\t\t\t\t');
      // extendSet.getStyle() always returns '', which leaves the space before `>`.
      o.t('\n\t\t\t\t<span class="extendset" extendsetid="').e(set.extendSetID).t('" categoryid="').e(set.categoryID);
      o.t('" ').e('').t('>\n\t\t\t\t\t<input name="extendSetID" type="hidden" value="').e(set.extendSetID);
      o.t('" />\n\t\t\t\t\t<h2>').e(encodeHtml(set.name)).t('</h2>\n\t\t\t\t\t').t('\n\t\t\t\t\t');
      for (const attr of set.attributes) renderControlGroup(o, attr, subject, options);
      o.t('\n\t\t\t\t</span>\n\t\t\t');
    }
    o.t('\n\t\t');
  }
  o.t('\n\t').t('\n');
  return raw(javaTrim(o.toString()));
}

/** `mura.json` `encode`: struct keys lower-cased in key order, numeric values bare, other text through `JSStringFormat`. */
export function legacyJsonEncode(value: LegacyJsonValue): string {
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'string') return cfIsNumeric(value) ? value : `"${jsStringFormat(value)}"`;
  if (Array.isArray(value)) return `[${value.map((item: LegacyJsonValue) => legacyJsonEncode(item)).join(',')}]`;
  const entries = Object.entries(value as { readonly [key: string]: LegacyJsonValue });
  if (entries.length === 0) return '{}';
  return `{${entries.map(([key, item]) => `"${key.toLowerCase()}":${legacyJsonEncode(item)}`).join(',')}}`;
}

/** The view's `returnsets` keys in the order ACF 2023's `StructKeyArray` returns them. */
const RETURNSETS_KEY_ORDER = ['extended', 'basic'] as const;

/** `cUsers.loadExtendedAttributes`: the Default and Basic extend sets of the requested user subtype as `mura.json`. */
export const loadExtendedAttributesScreen: FragmentScreen<LoadExtendedAttributesData> = Object.freeze({
  circuit: 'cusers',
  action: 'loadextendedattributes',
  mode: 'fragment',
  owner: 'people',
  gate: cusersGate,
  // People's contract serves the subject's extended-attribute values but not the set and attribute definitions this
  // view renders, so the gateway keeps the action legacy-served in every cut-over version; reached here, it fails
  // closed after the view's `structDelete(session.mura, 'editBean')`, which legacy runs before reading the sets.
  load(ctx: ScreenContext): Promise<LoadExtendedAttributesData> {
    setSessionMuraValue(ctx.req, 'editBean', undefined);
    return Promise.reject(
      new LegacyServiceUnavailableError(
        'People serves no user class-extension definitions',
        'admin',
        'extend-definitions-unserved',
      ),
    );
  },
  render(ctx: ScreenContext, data: LoadExtendedAttributesData): RawBody {
    const options = {
      context: extendRenderContext(ctx),
      compactDisplay: ctx.req.rc['compactDisplay'] ?? 'false',
      // isSuperUser() and isAdminUser() read the session user's own site, not rc.siteid.
      privileged: ctx.req.isS2 || ctx.req.isSiteAdmin,
    };
    const markup: Readonly<Record<(typeof RETURNSETS_KEY_ORDER)[number], string>> = {
      extended: renderExtendSets(data.defaultSets, data.subject, { ...options, container: 'Default' }).value,
      basic: renderExtendSets(data.basicSets, data.subject, { ...options, container: 'Basic' }).value,
    };
    const returnsets = Object.fromEntries(RETURNSETS_KEY_ORDER.map((key) => [key, markup[key]]));
    // The newline after the view's closing `</cfoutput>` prints one space after the JSON.
    return { status: 200, contentType: LEGACY_HTML_CONTENT_TYPE, body: `${legacyJsonEncode(returnsets)} ` };
  },
});

