// The content edit form's shared panel types and ports of the Masa custom tags `cf_timeselector`,
// `cf_datetimeselector`, `cf_fileselector` and `cf_filetools` (core/mura/customtags), server-only.
import { cfDateTimeFormat, cfEq, cfHour, cfMinute, cfUuid } from '@opt2/platform/legacy-compat';
import { formatDateField, isMoreThanFiftyYearsAfter, parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, encodeJs, encodeUrl, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cfListToArray } from '@/lib/resource-bundles/properties';
import type { ScreenContext } from '../../registry';
import type { CarchPageData } from '../model';
import { htmlEditFormat } from '../partials/zoom';

// ---- Shared panel types ----

/** One rendered edit panel include. */
export interface PanelResult {
  readonly html: SafeHtml;
  /** The id the include appends to `tabList`, e.g. `tabBasic`. */
  readonly tabId: string;
  /** The panel heading label. */
  readonly tabLabel: string;
  /** The include's `cfsavecontent variable="bodyContent"`, which edit.cfm prints inside `#mura-content-body-render`. */
  readonly bodyContent?: SafeHtml;
  /** Markup the include adds with `cfhtmlhead`. */
  readonly htmlHead?: SafeHtml;
}

/** The strategies-content edit screen model (`getContentEditModel`). */
export type EditPageData = CarchPageData;

/** One `rsSubTypes` row as edit.cfm leaves it after its query-of-queries filter. */
export interface SubTypeRow {
  readonly type: string;
  readonly subtype: string;
  readonly adminonly: number;
}

/** The values edit.cfm computes in its own scope before the panel includes read them. */
export interface EditFormState {
  /** The session user's `getContentTabAssignments()`, a CFML list; empty allows every tab. */
  readonly tabAssignments: string;
  /** CFML list `Page,Folder,Calendar`, plus `Gallery` when editing a Gallery. */
  readonly pageLevelList: string;
  /** CFML list the type selector offers; empty when the type takes no class extensions. */
  readonly baseTypeList: string;
  /** Empty when the type takes no class extensions. */
  readonly subTypes: readonly SubTypeRow[];
  /** The parent's `getClassExtension().getAvailableSubTypes()`, a CFML list of `type/subtype`. */
  readonly subtypeFilter: string;
  readonly isExtended: boolean;
  readonly requiresApproval: boolean;
  readonly showApprovalStatus: boolean;
  readonly hasChangesets: boolean;
  /** `rc.ptype`. */
  readonly ptype: string;
  /** `rc.compactDisplay`. */
  readonly compactDisplay: string;
  /** `rc.preview`. */
  readonly preview: string;
}

/** What every edit panel renderer receives; panels read it and never call the gateway. */
export interface EditFormInput {
  readonly ctx: ScreenContext;
  readonly req: AdminRequest;
  readonly data: EditPageData;
  readonly state: EditFormState;
}

// ---- CFML helpers ----

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
  '\r': '\\r',
  '\n': '\\n',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** ACF `JSStringFormat`: backslash, quotes and the CR, LF, tab, backspace and form-feed controls escaped. */
export function jsStringFormat(s: string): string {
  return s.replace(/[\\'"\r\n\t\b\f]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);
}

/** Options of {@link cfListHas}. */
export interface CfListHasOptions {
  /** `listFindNoCase` instead of `listFind`. */
  readonly noCase?: boolean;
  /** Default `,`; every character delimits. */
  readonly delimiters?: string;
}

/** CFML `listFind(list, value)` (or `listFindNoCase` with `noCase`) as a boolean. */
export function cfListHas(list: string, value: string, opts: CfListHasOptions = {}): boolean {
  const items = cfListToArray(list, opts.delimiters);
  if (!opts.noCase) return items.includes(value);
  const wanted = value.toLowerCase();
  return items.some((item) => item.toLowerCase() === wanted);
}

/** `not len(tabAssignments) or listFindNoCase(tabAssignments, name)`: whether the user may see the edit tab `name`. */
export function tabAllowed(tabAssignments: string, name: string): boolean {
  return tabAssignments.length === 0 || cfListHas(tabAssignments, name, { noCase: true });
}

/**
 * ACF 2023 whitespace-managed output of one custom tag: a whitespace-only static piece between two CFML constructs
 * prints one space after non-whitespace output and nothing otherwise, so a tag's leading gaps never print.
 */
class CfmlOutput {
  #body = '';

  /** A static piece that is not whitespace only, or the output of an expression or nested tag. */
  text(piece: string): this {
    this.#body += piece;
    return this;
  }

  /** A whitespace-only static piece. */
  ws(): this {
    if (this.#body !== '' && !/[ \t\n\r]$/.test(this.#body)) this.#body += ' ';
    return this;
  }

  toString(): string {
    return this.#body;
  }
}

/** CFML `ToString` of a date: `{ts 'yyyy-mm-dd HH:nn:ss'}`. */
const cfDateText = (date: Date): string => `{ts '${cfDateTimeFormat(date, 'yyyy-mm-dd HH:nn:ss')}'}`;

// ---- cf_timeselector and cf_datetimeselector ----

/** The session values and request clock the date and time tags read; a `ScreenContext` satisfies it. */
export interface DateTagContext {
  readonly req: { readonly session: Pick<AdminRequest['session'], 'dateKeyFormat' | 'localeHasDayParts'> };
  readonly now: Date;
}

/** A tag date attribute: a Date, its CFML text (`{ts '…'}` or ISO), or empty. */
export type TagDate = Date | string | null;

/** `cf_timeselector` attributes; each omitted one takes its `cfparam` default. */
export interface TimeSelectorAttrs {
  /** Default `''`. */
  readonly name?: string;
  /** When a date, its hour and minute replace the defaults. */
  readonly time?: TagDate;
  /** Default 0. */
  readonly defaulthour?: number;
  /** Default 0. */
  readonly defaultminute?: number;
  /** Default `<name>Hour`. */
  readonly hourname?: string;
  /** Default `<name>Minute`. */
  readonly minutename?: string;
  /** Default `<name>DayPart`. */
  readonly daypartname?: string;
  /** Default `mura-<hourname>`. */
  readonly hourid?: string;
  /** Default `mura-<minutename>`. */
  readonly minuteid?: string;
  /** Default `mura-<daypartname>`. */
  readonly daypartid?: string;
  /** Default `time`. */
  readonly hourclass?: string;
  /** Default `time`. */
  readonly minuteclass?: string;
  /** Default `time`. */
  readonly daypartclass?: string;
}

/** `<option>`s `from`..`to` as the tag loops them, `selected` on `chosen`. */
function timeOptions(from: number, to: number, chosen: number, label: (n: number) => string): string {
  let out = '';
  for (let n = from; n <= to; n += 1) out += `<option value="${n}" ${n === chosen ? 'selected' : ''}>${label(n)}</option>`;
  return out;
}

function renderTimeSelector(localeHasDayParts: boolean, a: TimeSelectorAttrs): string {
  const name = a.name ?? '';
  const hourname = a.hourname ?? `${name}Hour`;
  const minutename = a.minutename ?? `${name}Minute`;
  const daypartname = a.daypartname ?? `${name}DayPart`;
  const time = parseLegacyDate(a.time ?? null);
  let hour = time === null ? (a.defaulthour ?? 0) : cfHour(time);
  const minute = time === null ? (a.defaultminute ?? 0) : cfMinute(time);
  let pm = false;
  if (localeHasDayParts) {
    if (hour >= 12) {
      if (hour > 12) hour -= 12;
      pm = true;
    } else if (hour === 0) {
      hour = 12;
    }
  }
  const select = (lead: string, id: string, cls: string | undefined, selectName: string): string =>
    `${lead}${encodeHtmlAttr(id)}" class="${encodeHtmlAttr(cls ?? 'time')} mura-datepicker${encodeHtmlAttr(name)}" name="${encodeHtmlAttr(selectName)}">`;
  const o = new CfmlOutput();
  // The non-day-part hour select keeps the two spaces of its source line.
  o.text(select(localeHasDayParts ? '\n\t\t<select id="' : '\n\t\t<select  id="', a.hourid ?? `mura-${hourname}`, a.hourclass, hourname));
  o.text(`${localeHasDayParts ? timeOptions(1, 12, hour, String) : timeOptions(0, 23, hour, String)}</select>\n\t`);
  o.text(select('\n\n\t<select id="', a.minuteid ?? `mura-${minutename}`, a.minuteclass, minutename));
  o.text(`${timeOptions(0, 59, minute, (m) => String(m).padStart(2, '0'))}</select>\n\n\t`);
  if (localeHasDayParts) {
    o.text(select('\n\t\t<select id="', a.daypartid ?? `mura-${daypartname}`, a.daypartclass, daypartname));
    o.text(`<option value="AM">AM</option><option value="PM" ${pm ? 'selected' : ''}>PM</option></select>\n\t`);
  }
  return o.toString();
}

/** `<cf_timeselector>`: the hour, minute and, for locales with day parts, AM/PM selects. */
export function timeSelector(ctx: Pick<DateTagContext, 'req'>, attrs: TimeSelectorAttrs): SafeHtml {
  return raw(renderTimeSelector(ctx.req.session.localeHasDayParts, attrs));
}

/** `cf_datetimeselector` attributes; each omitted one takes its `cfparam` default. */
export interface DatetimeSelectorAttrs {
  readonly name: string;
  /** The stored value; a string prints in the hidden field exactly as given. */
  readonly datetime?: TagDate;
  /** Default 0. */
  readonly defaulthour?: number;
  /** Default 0. */
  readonly defaultminute?: number;
  /** Default `false`. */
  readonly required?: boolean | string;
  /** Default `''`. */
  readonly message?: string;
  /** Default `false`. */
  readonly break?: boolean;
  /** Default `''`. */
  readonly dateclass?: string;
  /** Default `span3`. */
  readonly datespanclass?: string;
  /** Default `false`. */
  readonly timeselectwrapper?: boolean;
}

/**
 * `<cf_datetimeselector>`: the date field, the time selects, the hidden value and its change script. A date more than
 * 50 years ahead prints blank while its time selects keep its time.
 */
export function datetimeSelector(ctx: DateTagContext, attrs: DatetimeSelectorAttrs): SafeHtml {
  const { name, required = false, message = '' } = attrs;
  const original = attrs.datetime ?? '';
  const date = parseLegacyDate(original);
  const datetime = date !== null && isMoreThanFiftyYearsAfter(date, ctx.now) ? '' : original;
  const hidden = datetime instanceof Date ? cfDateText(datetime) : datetime;
  const field = encodeHtmlAttr(name);
  const script = encodeJs(name);
  const o = new CfmlOutput();
  o.text(`\n<input type="text" autocomplete="off" class="datepicker ${encodeHtmlAttr(attrs.dateclass ?? '')}`).ws();
  o.text(`${encodeHtmlAttr(attrs.datespanclass ?? 'span3')} mura-datepicker${field}" value="`);
  o.text(`${formatDateField(datetime, ctx.req.session.dateKeyFormat, ctx.now)}" maxlength="12" id="mura-datepicker-${field}"/>`);
  if (attrs.break) o.text('<br/>');
  o.ws();
  if (attrs.timeselectwrapper) o.text('<div class="mura-timeselectwrapper">');
  o.ws();
  // The tag blanks the select names after deriving the select ids from them, so each select posts as "".
  o.text(
    renderTimeSelector(ctx.req.session.localeHasDayParts, {
      name,
      time: original,
      defaulthour: attrs.defaulthour,
      defaultminute: attrs.defaultminute,
      hourname: '',
      minutename: '',
      daypartname: '',
      hourid: `mura-${name}Hour`,
      minuteid: `mura-${name}Minute`,
      daypartid: `mura-${name}DayPart`,
    }),
  ).ws();
  if (attrs.timeselectwrapper) o.text('</div>');
  // The duplicate data-required attribute, the second holding the message, is legacy's.
  o.text(
    `\n<input type="hidden" id="mura-${field}" name="${field}" value="${encodeHtmlAttr(hidden)}" data-required="${encodeHtmlAttr(String(required))}" data-required="${encodeHtmlAttr(message)}"/>
<script>
\t$(function(){
\t\t$('.mura-datepicker${script}').change(
\t\t\tfunction(){
\t\t\t\tparseDateTimeSelector('${script}');
\t\t\t}
\t\t);
\t});
</script>
`,
  );
  return raw(o.toString());
}

// ---- cf_fileselector and cf_filetools ----

/** `bean.getFileMetaData(property)` as the tags read it. */
export interface FileMetaData {
  readonly isNew: boolean;
  readonly filename: string;
  readonly hasImageFileExt: boolean;
  readonly hasCroppableImageFileExt: boolean;
  readonly contentHistId: string;
  readonly fileId: string;
  /** `$.getURLForImage(fileid=<bean value>, size=<tag size>, siteid, useProtocol=false)`. */
  readonly imageUrl: string;
}

/** The bean values the file tags read, supplied by the owning service's screen model. */
export interface FileSelectorBean {
  /** `getEntityName()`: `content`, `user`, `group` or `site`. */
  readonly entityName: string;
  /** `getType()`, e.g. `File` or `Page`. */
  readonly type: string;
  /** `getContentID()`; `''` for beans without one. */
  readonly contentId: string;
  /** `getContentHistID()`; `''` for beans without one. */
  readonly contentHistId: string;
  readonly siteId: string;
  /** `getUserID()`; `''` for beans without one. */
  readonly userId: string;
  /** `getValue(property)`: the stored file id. */
  readonly propertyValue: string;
  /** `getFileExt()`. */
  readonly fileExt: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly fileMeta: FileMetaData;
}

/** The site's Razuna settings; `''` values when the site has none. */
export interface RazunaSettings {
  readonly hostname: string;
  readonly apiKey: string;
}

/** `cf_filetools` attributes; each omitted one takes its `cfparam` default. */
export interface FileToolsAttrs {
  readonly bean: FileSelectorBean;
  /** Default `fileid`. */
  readonly property?: string;
  /** Default `medium`: the rendition `bean.fileMeta.imageUrl` is resolved at. */
  readonly size?: string;
  /** Default `false`. */
  readonly compactDisplay?: string;
  /** Default `deleteFile`. */
  readonly deleteKey?: string;
  /** CFML boolean; default `false`. */
  readonly locked?: boolean;
}

/** `cf_fileselector` attributes; each omitted one takes its `cfparam` default. */
export interface FileSelectorAttrs extends Omit<FileToolsAttrs, 'deleteKey'> {
  /** Default `newfile`. */
  readonly name?: string;
  /** Accepted as the tag accepts it; its markup never prints it. */
  readonly id?: string;
  /** Default `''`. */
  readonly class?: string;
  /** Default `''`. */
  readonly label?: string;
  /** Default `name`. */
  readonly required?: string;
  /** Default `''`. */
  readonly validation?: string;
  /** Default `''`. */
  readonly regex?: string;
  /** Default `''`. */
  readonly message?: string;
  /** Default `''`, passed on to `cf_filetools`. */
  readonly deleteKey?: string;
  /** Default `property` = `name`. */
  readonly property?: string;
  /** Default `zip`. */
  readonly examplefileext?: string;
  /** Omitted reads as a site without Razuna settings, as every site is while Razuna settings stay on legacy. */
  readonly razuna?: RazunaSettings;
}

/** What the file tags read from the screen: labels and the session's CSRF tokens. */
export interface FileTagInput {
  readonly ctx: Pick<ScreenContext, 'rb' | 'csrf'>;
}

const NO_RAZUNA: RazunaSettings = Object.freeze({ hostname: '', apiKey: '' });

/** The unlock and offline-edit lock scripts of a File node's stored file, with the session's CSRF tokens. */
async function fileLockScript(input: FileTagInput, bean: FileSelectorBean): Promise<string> {
  const { rb, csrf } = input.ctx;
  const unlockContext = `${bean.contentId}unlockfile`;
  const lockContext = `${bean.contentId}lockfile`;
  await csrf.prefetch([unlockContext, lockContext]);
  const unlock = await csrf.tokens(unlockContext);
  const lockTokens = csrf.render(lockContext, 'url').value;
  const unlockConfirm = jsStringFormat(rb.rbKey('sitemanager.content.fields.unlockfileconfirm'));
  const lockConfirm = jsStringFormat(rb.rbKey('sitemanager.content.fields.downloadforofflineeditingconfirm'));
  return `

\t\t<script>
\t\t\t
\t\t\tjQuery(".mura-file-unlock").click(
\t\t\t\tfunction(event){
\t\t\t\t\tevent.preventDefault();
\t\t\t\t\tconfirmDialog(
\t\t\t\t\t\t"${unlockConfirm}",
\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\tjQuery("#msg-file-locked").fadeOut();
\t\t\t\t\t\t\tjQuery(".mura-file-unlock").hide();
\t\t\t\t\t\t\tjQuery("#mura-file-offline-edit").fadeIn();
\t\t\t\t\t\t\tjQuery("#mura-download-unlocked").show();
\t\t\t\t\t\t\tjQuery("#mura-download-locked").hide();
\t\t\t\t\t\t\tjQuery("#msg-file-locked-else").fadeOut();
\t\t\t\t\t\t\tsiteManager.hasFileLock=false;
\t\t\t\t\t\t\tjQuery.post("./",{
\t\t\t\t\t\t\t\tmuraAction:"carch.unlockfile",
\t\t\t\t\t\t\t\tcontentid:"${bean.contentId}",
\t\t\t\t\t\t\t\tsiteid:"${bean.siteId}",
\t\t\t\t\t\t\t\tcsrf_token:'${unlock.token}',
\t\t\t\t\t\t\t\tcsrf_token_expires: '${unlock.expires}'
\t\t\t\t\t\t\t})
\t\t\t\t\t\t}
\t\t\t\t\t);

\t\t\t\t}
\t\t\t);

\t\t\tjQuery("#mura-file-offline-edit").click(
\t\t\t\tfunction(event){
\t\t\t\t\tevent.preventDefault();
\t\t\t\t\tvar a=this;
\t\t\t\t\tconfirmDialog(
\t\t\t\t\t\t"${lockConfirm}",
\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\tjQuery("#msg-file-locked").fadeIn();
\t\t\t\t\t\t\tjQuery(".mura-file-unlock").fadeIn();
\t\t\t\t\t\t\tjQuery("#mura-download-unlocked").hide();
\t\t\t\t\t\t\tjQuery("#mura-download-locked").show();
\t\t\t\t\t\t\tjQuery("#msg-file-locked-else").hide();
\t\t\t\t\t\t\tjQuery(a).fadeOut();
\t\t\t\t\t\t\tsiteManager.hasFileLock=true;
\t\t\t\t\t\t\tdocument.location="./?muraAction=carch.lockfile&contentID=${bean.contentId}&siteID=${bean.siteId}${lockTokens}";
\t\t\t\t\t\t}
\t\t\t\t\t);
\t\t\t\t}
\t\t\t);
\t\t</script>


\t`;
}

/**
 * `<cf_filetools>`: the stored file's name, preview, crop, metadata, download and remove controls; empty when the
 * property holds no stored file. Bean values and labels print unencoded, as legacy prints them.
 */
export async function fileTools(input: FileTagInput, attrs: FileToolsAttrs): Promise<SafeHtml> {
  const { bean } = attrs;
  const meta = bean.fileMeta;
  if (meta.isNew) return raw('');
  const { rb } = input.ctx;
  const property = attrs.property ?? 'fileid';
  const compactDisplay = attrs.compactDisplay ?? 'false';
  const locked = attrs.locked ?? false;
  const isContent = cfEq(bean.entityName, 'content');
  const isFileField = cfEq(bean.type, 'File') && cfEq(property, 'fileid');
  const download = `${legacySettings().context}/index.cfm/_api/render/file/?fileid=${bean.propertyValue}&method=attachment&size=source`;
  const confirmDownload = `return confirmDialog('${rb.rbKey('sitemanager.downloadconfirm')}',function(){location.href='${download}';});`;
  const downloadLabel = rb.rbKey('sitemanager.content.fields.download');
  const o = new CfmlOutput();
  o.text('\n<div class="mura-control justify">\n');
  if (!cfEq(bean.entityName, 'site') && (isFileField || (!meta.hasImageFileExt && !cfEq(property, 'fileid')))) {
    const icon = meta.hasImageFileExt ? 'mi-picture' : 'mi-file-text-o';
    o.text(`\n\t     <div class="mura-file ${bean.fileExt.toLowerCase()}">\n\t     \t\n\t\t \t<i class="${icon} mi-2x"></i> `);
    o.text(htmlEditFormat(meta.filename));
    if (cfEq(property, 'fileid') && bean.majorVersion !== 0) o.text(` (v${bean.majorVersion}.${bean.minorVersion})`);
    o.text('\n\t     </div>\n\n\t');
  }
  o.ws();
  if (meta.hasImageFileExt) {
    o.text(`\n\t\t<img id="assocImage" src="${meta.imageUrl}?cacheID=${cfUuid()}" />\n\t\t<div class="mura-input-set imageToolsButtonGroup">\n\t\t\t`);
    if (meta.hasCroppableImageFileExt && cfListHas('content,user,group', bean.entityName, { noCase: true })) {
      const owner = isContent ? `contenthistid=${bean.contentHistId}` : `userid=${bean.userId}`;
      o.ws().text(
        `\n\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.imagedetails&${owner}&siteid=${bean.siteId}&fileid=${bean.propertyValue}&compactDisplay=${encodeUrl(compactDisplay)}"><i class="mi-crop"></i></a>\n\t\t\t\t`,
      );
      o.ws();
    }
    o.ws();
    if (isContent) {
      o.text(
        `\n\t\t\t\t<a class="btn" href="" onclick="return openFileMetaData('${meta.contentHistId}','${meta.fileId}','${bean.siteId}','${property}');"><i class="mi-info-circle"></i></a>\n\t\t\t`,
      );
    }
    o.ws();
  }
  o.ws();
  if (!isFileField) {
    o.text(`\n\t\t<a class="btn download-file" onclick="${confirmDownload}"><i class="mi-download"></i></a>\n\t`);
  } else if (isContent) {
    o.text('\n\t\t<a id="mura-download-locked" ');
    if (!locked) o.text(' style="display:none"');
    o.text(` class="btn download-file" onclick="${confirmDownload}"><i class="mi-download"></i> ${downloadLabel}</a>\n\t\t<div id="mura-download-unlocked" class="btn-group"`);
    if (locked) o.text(' style="display:none"');
    o.text(`>
\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">
\t\t\t\t<i class="mi-download"></i> <span class="caret"></span>
\t\t\t </a>
\t\t\t<ul class="dropdown-menu">
\t\t\t\t<!-- dropdown menu links -->
\t\t\t\t<li><a href="#" onclick="${confirmDownload}"><i class="mi-download"></i> ${downloadLabel}</a></li>
\t\t\t\t<li><a id="mura-file-offline-edit" href="#"><i class="mi-lock"></i> ${rb.rbKey('sitemanager.content.fields.downloadforofflineediting')}</a></li>
\t\t\t</ul>
\t\t</div>
\t`);
  }
  o.ws();
  if (meta.hasImageFileExt) o.text('\n\t\t</div>\n\t');
  o.ws();
  if (!isFileField) {
    const tooltip = rb.rbKey('sitemanager.content.fields.removeattachedfiletooltip');
    o.text(`
\t<div>
\t\t<label class="checkbox inline" for="deleteFileBox">
\t\t\t<input type="checkbox" name="${attrs.deleteKey ?? 'deleteFile'}" value="1" class="deleteFileBox"/><a href="#" rel="tooltip" title="${tooltip}">${rb.rbKey('sitemanager.content.fields.removeattachedfile')} <i class="mi-question-sign"></i></a>
\t\t</label>
\t</div>
\t`);
  }
  o.ws();
  if (isFileField) o.text(await fileLockScript(input, bean));
  o.ws().text('\n</div>\n');
  return raw(o.toString());
}

/**
 * `<cf_fileselector>`: the upload, URL, existing-file (and Razuna) options of a file property, the File revision
 * radios, then {@link fileTools}. Values print encoded or raw exactly where the tag encodes them.
 */
export async function fileSelector(input: FileTagInput, attrs: FileSelectorAttrs): Promise<SafeHtml> {
  const { bean } = attrs;
  const { rb } = input.ctx;
  const name = attrs.name ?? 'newfile';
  const property = attrs.property ?? name;
  const label = attrs.label ?? '';
  const required = attrs.required ?? name;
  const validation = attrs.validation ?? '';
  const regex = attrs.regex ?? '';
  const message = attrs.message ?? '';
  const razuna = attrs.razuna ?? NO_RAZUNA;
  const filetype = !cfEq(bean.type, 'File') && cfEq(property, 'fileid') ? 'Image' : 'File';
  const nameAttr = encodeHtmlAttr(name);
  const openMeta = (prop: string): string =>
    `onclick="return openFileMetaData('${bean.contentHistId}','','${bean.siteId}','${prop}');"`;
  const editAttrs = (validateName: string): string =>
    `data-label="${htmlEditFormat(label)}" data-label="${htmlEditFormat(required)}" ${validateName}="${htmlEditFormat(validation)}" data-regex="${htmlEditFormat(regex)}" data-message="${htmlEditFormat(message)}"`;
  const o = new CfmlOutput();
  o.text(
    `\n\t<div data-name="${nameAttr}" data-property="${encodeHtmlAttr(property)}" data-fileid="${encodeHtmlAttr(bean.propertyValue)}" data-filetype="${encodeHtmlAttr(filetype)}" data-contentid="${bean.contentId}" data-siteid="${bean.siteId}" class="mura-file-selector ${attrs.class ?? ''}">\t\t\t
\t\t<div class="mura-input-set mura-file-selector-tabs" data-toggle="buttons-radio">
\t\t\t<button type="button" style="display:none">placeholder</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector active" value="Upload"><i class="mi-upload"></i> ${rb.rbKey('sitemanager.fileselector.viaupload')}</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="URL"><i class="mi-download"></i> ${rb.rbKey('sitemanager.fileselector.viaurl')}</button>
\t\t\t<button type="button" class="btn btn-default mura-file-type-selector" value="Existing"><i class="mi-file-picture-o"></i> ${rb.rbKey('sitemanager.fileselector.selectexisting')}</button>
\t\t\t`,
  );
  if (razuna.hostname.length > 0) {
    o.text('\n\t\t\t<button type="button" class="btn btn-default mura-file-type-selector btn-razuna-icon" value="URL-Razuna"><i></i> Razuna</button>\n\t\t\t');
  }
  o.text(`
\t\t</div>

\t\t<div id="mura-file-upload-${nameAttr}" class="mura-file-option mura-file-upload fileTypeOption${nameAttr}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<input name="${nameAttr}" type="file" class="mura-file-selector-${nameAttr}"
\t\t\t\t\t\tdata-label="${encodeHtmlAttr(label)}" data-label="${encodeHtmlAttr(required)}" data-validation="${encodeHtmlAttr(validation)}" data-regex="${encodeHtmlAttr(regex)}" data-message="${encodeHtmlAttr(message)}">
\t\t\t\t\t<a style="display:none;" class="btn btn-default" href="" ${openMeta(encodeJs(property))}><i class="mi-info-circle"></i></a>
\t\t\t</div>

\t\t</div>
\t\t<div id="mura-file-url-${name}" class="mura-file-option mura-file-url fileTypeOption${name}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<input type="text" name="${name}" class="mura-file-selector-${name} span6" type="url" placeholder="http://www.domain.com/yourfile.${attrs.examplefileext ?? 'zip'}"\tvalue=""
\t\t\t\t\t${editAttrs('data-validate')}>
\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" ${openMeta(property)}><i class="mi-info-circle"></i></a>
\t\t\t</div>

\t\t</div>

\t\t<div id="mura-file-existing-${name}" class="mura-file-option mura-file-existing fileTypeOption${name}">

\t\t</div>
\t\t`);
  o.ws();
  if (razuna.apiKey.length > 0) {
    o.text(`
\t\t<div id="mura-file-url-${name}" class="mura-file-option mura-file-url-razuna fileTypeOption${name}">

\t\t\t<div class="mura-control-group">
\t\t\t\t\t<div class="input-append">
\t\t\t\t\t\t<input type="text" name="${name}" class="mura-file-selector-${name} span6 razuna-url" type="url" placeholder="http://${razuna.hostname}" ${editAttrs('data-validate')}>
\t\t\t\t\t\t<a style="display:none;" class="btn btn-default file-meta-open" href="" ${openMeta(property)}><i class="mi-info-circle"></i></a>
\t\t\t\t\t\t<button type="button" onclick="renderRazunaWindow('newfile');" class="btn btn-razuna"><i class="mi-external-link-sign"></i> ${rb.rbKey('sitemanager.content.launchrazuna')}</button>
\t\t\t\t\t</div>
\t\t\t</div>

\t\t</div>
\t\t`);
  }
  o.ws();
  if (cfEq(bean.type, 'File') && cfEq(property, 'fileid') && bean.propertyValue.length > 0) {
    o.text(`

\t\t\t<div style="display:none;" id="mura-revision-type">
\t\t\t\t<label class="radio inline">
\t\t\t\t\t<input type="radio" name="versionType" value="major">${rb.rbKey('sitemanager.content.version.major')}
\t\t\t\t</label>
\t\t\t\t<label class="radio inline">
\t\t\t\t\t<input type="radio" name="versionType" value="minor" checked />${rb.rbKey('sitemanager.content.version.minor')}
\t\t\t\t</label>
\t\t\t</div>
\t\t\t<script>
\t\t\t\tjQuery(".mura-file-selector-newfile").change(function(){
\t\t\t\t\tjQuery("#mura-revision-type").fadeIn();
\t\t\t\t\t});
\t\t\t</script>
\t\t`);
  }
  o.ws().ws();
  const tools = await fileTools(input, {
    bean,
    property,
    deleteKey: attrs.deleteKey ?? '',
    compactDisplay: attrs.compactDisplay ?? 'false',
    size: attrs.size ?? 'medium',
    locked: attrs.locked ?? false,
  });
  o.text(tools.value).ws().text('\n\t</div>\n\n\n');
  return raw(o.toString());
}
