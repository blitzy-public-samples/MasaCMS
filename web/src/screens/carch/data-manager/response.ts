// Responses panel of `carch/data_manager/dsp_response.cfm`: the download form and the filtered response grid.
// The templates are the legacy markup verbatim, its quirks included. Their whitespace is the template's as ACF emits it:
// CFML tags and comments leave their surrounding whitespace, except that whitespace-only text between two CFML tags is
// dropped.
import type { CsrfRenderer } from '@/lib/csrf';
import { formatDateField, formatDateTimeShort, parseLegacyDate } from '@/lib/dates';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** A date as `@/lib/dates` reads it: a Date or `{ts '…'}`/ISO text, wall-clock time of the legacy server zone. */
export type DataResponseDate = Date | string | null;

/** One `dataCollectionManager.getData` row. */
export interface DataResponseRow {
  readonly responseId: string;
  readonly entered: DataResponseDate;
  /** The deserialised WDDX packet; null when legacy's `wddx2cfml` fails on it. */
  readonly data: Readonly<Record<string, string>> | null;
}

/** The screen context members the panel uses. */
export type DataResponsesCtx = { readonly csrf: CsrfRenderer; readonly rb: RbLookup };

/** The values the template reads, with `rc.date1`, `rc.date2` and `rc.fieldnames` resolved as its preamble does. */
export interface DataResponsesInput {
  /** `rsDataInfo` of `contentManager.getDownloadselect`: `CountEntered`, `firstEntered` and `lastEntered`. */
  readonly countEntered: number;
  readonly firstEntered: DataResponseDate;
  readonly lastEntered: DataResponseDate;
  /** `rc.date1`: the date the From field shows, and its CF string form, which the row links carry. */
  readonly date1: { readonly value: DataResponseDate; readonly raw: string };
  /** `rc.date2`, as `date1`. */
  readonly date2: { readonly value: DataResponseDate; readonly raw: string };
  /** Comma list of the response fields. */
  readonly fieldnames: string;
  readonly sortBy: string;
  readonly sortDirection: string;
  /** `rc.filterBy` and `rc.keywords`, which the row links carry. */
  readonly filterBy: string;
  readonly keywords: string;
  /** `session.filterBy` and `session.datakeywords`, which the search controls show. */
  readonly sessionFilterBy: string;
  readonly sessionDataKeywords: string;
  readonly contentid: string;
  /** `rc.siteid`. */
  readonly siteid: string;
  /** `session.siteid`, which only the hidden `siteid` input carries. */
  readonly sessionSiteId: string;
  readonly moduleid: string;
  /** Raw `rc` values; a defined `minute1` is the template's `isdefined('rc.minute1')`. */
  readonly hour1?: string;
  readonly minute1?: string;
  readonly hour2?: string;
  readonly minute2?: string;
  /** `rc.columns`, `fixed` by default. */
  readonly columns: string;
  /** `$.siteConfig('scheme')`, the site domain, `configBean.getServerPort()` (`:<port>` or `''`) and `getContext()`. */
  readonly siteScheme: string;
  readonly siteDomain: string;
  readonly serverPort: string;
  readonly context: string;
  /** `session.dateKeyFormat`, and `session.locale` (a Java locale) for `LSTimeFormat`. */
  readonly dateKeyFormat: string;
  readonly locale: string;
  /** `getData(rc)` after the bulk delete, if one ran; read only when `minute1` is defined. */
  readonly results?:
    | { readonly kind: 'deleted'; readonly count: number }
    | { readonly kind: 'rows'; readonly rows: readonly DataResponseRow[] };
}

/** The `rc` time values the row links read. */
interface LinkTimes {
  readonly hour1: string;
  readonly minute1: string;
  readonly hour2: string;
  readonly minute2: string;
}

const NOTHING = raw('');
const EMPTY_NOTICE = raw('\n\t<div class="help-block-empty">No data to display for this form</div>\n');
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const CF_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;
// `\S` of ACF's Perl 5 regex engine: anything but space, tab, LF, FF and CR.
const URL_PATTERN = /https?:\/\/[^ \t\n\f\r]+/gi;
const EMAIL_PATTERN = /[\w.]+@[\w.]+\.\w+/gi;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MINUTES = Array.from({ length: 60 }, (_, mn) => mn);

/** Java `String.trim()`, as CFML `trim`: strips leading and trailing chars up to U+0020. */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

/** CFML number text: finite decimal text not ending in `.` (ACF compares `1.` and `1` as strings). */
function isCfNumber(s: string): boolean {
  return NUMBER_TEXT.test(s) && !s.endsWith('.') && Number.isFinite(Number(s));
}

/** CFML `eq` on strings: numeric when both trimmed sides are numbers, else case-insensitive. */
function cfEq(a: string, b: string): boolean {
  const x = javaTrim(a);
  const y = javaTrim(b);
  return isCfNumber(x) && isCfNumber(y) ? Number(x) === Number(y) : a.toLowerCase() === b.toLowerCase();
}

/** The elements of a CFML list loop over `,`, which skips empty elements. */
function listItems(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** `info['#f#']` by case-insensitive key; `''` when absent, as the template's inner cftry gives. */
function fieldValue(info: Readonly<Record<string, string>>, field: string): string {
  const lower = field.toLowerCase();
  const key = Object.hasOwn(info, field) ? field : Object.keys(info).find((name) => name.toLowerCase() === lower);
  return key === undefined ? '' : (info[key] ?? '');
}

/** `iif(len(n) lt 2, de('0#n#'), de('#n#'))`. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The 12-hour label the template prints for hour option `h`. */
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${pad2(h)} AM`;
  if (h === 12) return `${pad2(h)} PM`;
  return `${pad2(h - 12)} PM`;
}

/** An option with already-encoded value and label; unselected options keep the space legacy leaves. */
function option(value: string, isSelected: boolean, label: string): SafeHtml {
  return raw(`<option value="${value}" ${isSelected ? 'selected' : ''}>${label}</option>`);
}

/** The date `hour()` and `minute()` read; a value ACF cannot convert fails as it does there. */
function toDate(value: DataResponseDate): Date {
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${String(value)} cannot be converted to a date.`);
  return date;
}

/** `LSDateFormat(value, session.dateKeyFormat)`. */
function lsDateFormat(value: DataResponseDate, dateKeyFormat: string): SafeHtml {
  // Plain LSDateFormat has no datetimeselector 50-year blanking, so the value is its own reference date.
  return raw(formatDateField(value, dateKeyFormat, parseLegacyDate(value) ?? undefined));
}

/** One `setParagraphs` loop: from `start`, CF `replace` swaps the first occurrence anywhere of each match for its link. */
function linkMatches(input: string, pattern: RegExp, link: (item: string) => string): string {
  let str = input;
  let start = 0;
  for (;;) {
    pattern.lastIndex = start;
    const match = pattern.exec(str);
    if (match === null) return str;
    const anchor = link(javaTrim(match[0]));
    str = str.replace(match[0], () => anchor);
    start = match.index + anchor.length;
  }
}

/** `contentRendererUtility.setParagraphs`: tabs as spaces, URLs and emails as links, lines as paragraphs. */
function setParagraphs(text: string): string {
  let str = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\t', '&nbsp;&nbsp;&nbsp;');
  str = linkMatches(str, URL_PATTERN, (item) => `<a href="${item}" target="_blank">${item}</a>`);
  str = linkMatches(str, EMAIL_PATTERN, (item) => `<a href="mailto:${item}" target="_blank">${item}</a>`);
  return `<p>${str}</p>`.replaceAll('\n', '</p><p>');
}

/** A `sitemanager.content.fields.*` label, unencoded as legacy writes it. */
function label(rb: RbLookup, key: string): string {
  return rb.rbKey(`sitemanager.content.fields.${key}`);
}

/** The 24 hour options, `selected` on the hour of `date`. */
function hourOptions(date: Date): SafeHtml {
  return join(HOURS.map((h) => option(String(h), date.getHours() === h, hourLabel(h))));
}

/** The 60 minute options, `selected` on the minute of `date`. */
function minuteOptions(date: Date): SafeHtml {
  return join(MINUTES.map((mn) => option(String(mn), date.getMinutes() === mn, pad2(mn))));
}

/** The field options of the `sortBy` or `filterBy` select, `selected` where the field is CFML-equal to `current`. */
function fieldOptions(fields: readonly string[], current: string, indent: string): SafeHtml {
  return join(
    fields.map((f) => html`\n${raw(indent)}${option(encodeHtmlAttr(f), cfEq(f, current), encodeHtml(f))}\n${raw(indent)}`),
  );
}

/** The download form: date and time range, sort, keyword search and the action buttons. */
function downloadForm(rb: RbLookup, input: DataResponsesInput, fields: readonly string[]): SafeHtml {
  // As legacy has it: the time selects follow the first and last entries rather than rc.hour1 and the like, and the
  // From field reuses the 'To' validation message.
  const first = toDate(input.firstEntered);
  const last = toDate(input.lastEntered);
  const toValidate = raw(label(rb, 'tovalidate'));
  const deleteButton =
    input.minute1 === undefined
      ? NOTHING
      : raw(
          `<button type="button" class="btn" onclick="return confirmDialog('Delete filtered results?',function(){document.download.delete.value=1;submitForm(document.forms.download);});" /><i class="mi-trash"></i> Delete Results</button>`,
        );
  // Character for character the template's downloadLocationString, double spaces included.
  const downloadLocation = raw(
    `'./?muraAction=cArch.downloaddata&siteid=${encodeUrl(input.siteid)}&contentid=${encodeUrl(input.contentid)}&date1=' + document.download.date1.value + '&hour1=' +document.download.hour1.value + '&minute1=' +document.download.minute1.value + '&date2=' + document.download.date2.value + '&hour2=' + document.download.hour2.value + '&minute2=' + document.download.minute2.value + '&sortBy=' +  document.download.sortBy.value + '&sortDirection=' +  document.download.sortDirection.value + '&filterBy='  + document.download.filterBy.value + '&keywords=' + document.download.keywords.value + '&columns=${encodeUrl(input.columns)}'`,
  );
  return html`
<form novalidate="novalidate" action="index.cfm" method="get" name="download" onsubmit="return validate(this);">

\t<div class="mura-control-group">
  \t<label>${raw(label(rb, 'from'))}</label>
  \t<input type="text" class="datepicker" name="date1"  validate="date" message="${toValidate}" required="true" value="${lsDateFormat(input.date1.value, input.dateKeyFormat)}">
  \t<select name="hour1" class="time">${hourOptions(first)}</select>
    <select name="minute1" class="time">${minuteOptions(first)}</select>
\t</div>

\t<div class="mura-control-group">
  \t<label>${raw(label(rb, 'to'))}</label>
  \t<input type="text" class="datepicker" name="date2" validate="date" message="${toValidate}" required="true" value="${lsDateFormat(input.date2.value, input.dateKeyFormat)}">
  \t<select name="hour2" class="time">${hourOptions(last)}</select>
    <select name="minute2" class="time" >${minuteOptions(last)}
   </select>
\t</div>

<div class="mura-control-group">
  <label>${raw(label(rb, 'sortby'))}</label>
  <select name="sortBy" class="mura-constrain">
${option('Entered', cfEq('Entered', input.sortBy), 'Entered')}
${fieldOptions(fields, input.sortBy, '')}
</select>
<select name="sortDirection" class="mura-constrain">
${option('asc', cfEq(input.sortDirection, 'asc'), label(rb, 'ascending'))}
${option('desc', cfEq(input.sortDirection, 'desc'), label(rb, 'descending'))}
</select>
</div>

\t<div class="mura-control-group">
\t\t<label>${raw(label(rb, 'keywordsearch'))}</label>
\t\t<select name="filterBy" class="mura-constrain">
\t\t\t${fieldOptions(fields, input.sessionFilterBy, '\t\t\t')}
\t\t</select>
\t\t<input type="text" name="keywords" class="mura-constrain" value="${raw(encodeHtmlAttr(input.sessionDataKeywords))}">
\t</div>

<input type="hidden" name="muraAction" value="cArch.datamanager" />
<input type="hidden" name="contentid" value="${raw(encodeHtmlAttr(input.contentid))}" />
<input type="hidden" name="siteid" value="${raw(encodeHtmlAttr(input.sessionSiteId))}" />
<input type="hidden" name="moduleid" value="${raw(encodeHtmlAttr(input.moduleid))}" />
<input type="hidden" name="newSearch" value="1" />
<input type="hidden" name="delete" value="0" />
<div class="mura-actions">
\t<div class="form-actions">
\t\t<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.download);" /><i class="mi-bar-chart"></i> ${raw(label(rb, 'viewdata'))}</button>
\t\t${deleteButton}
\t\t<button type="button" class="btn" onclick="location.href=${downloadLocation};"><i class="mi-download"></i> ${raw(label(rb, 'download'))}</button>
\t</div>
</div>
</form>
`;
}

/** The field cell: the attachment preview link for an attachment field holding a CF UUID, else the value as paragraphs. */
function fieldCell(rb: RbLookup, input: DataResponsesInput, field: string, value: string): SafeHtml {
  if (field.toLowerCase().includes('attachment') && CF_UUID.test(value)) {
    const fileUrl = `${input.siteScheme}://${input.siteDomain}${input.serverPort}${input.context}/index.cfm/_api/render/file/?fileID=${encodeUrl(value)}`;
    return raw(`<a  href="#" onclick="return preview('${fileUrl}');">${label(rb, 'viewattachment')}</a>`);
  }
  return raw(setParagraphs(encodeHtml(value)));
}

/** The cells of a deserialised response: actions menu, entry time and one cell per field. */
function responseCells(
  ctx: DataResponsesCtx,
  input: DataResponsesInput,
  fields: readonly string[],
  row: DataResponseRow,
  info: Readonly<Record<string, string>>,
  times: LinkTimes,
): SafeHtml {
  const { rb } = ctx;
  const head = `./?muraAction=cArch.datamanager&contentid=${encodeUrl(input.contentid)}&siteid=${encodeUrl(input.siteid)}&date1=${encodeUrl(input.date1.raw)}&hour1=${encodeUrl(times.hour1)}&minute1=${encodeUrl(times.minute1)}&date2=${encodeUrl(input.date2.raw)}&hour2=${encodeUrl(times.hour2)}&minute2=${encodeUrl(times.minute2)}&responseid=${row.responseId}`;
  const tail = `&moduleid=${encodeUrl(input.moduleid)}&sortBy=${encodeUrl(input.sortBy)}&sortDirection=${encodeUrl(input.sortDirection)}&filterBy=${encodeUrl(input.filterBy)}&keywords=${encodeUrl(input.keywords)}`;
  const cells = fields.map(
    (f) => html`\n\t\t\t\t\t<td class="mForm-data">${fieldCell(rb, input, f, fieldValue(info, f))}</td>\n\t\t\t\t\t`,
  );
  return html`\n\t\t\t\t\t<td class="actions">
\t\t\t\t\t\t<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>
\t\t\t\t\t\t<div class="actions-menu hide">
\t\t\t\t\t\t\t<ul class="actions-list">
\t\t\t\t\t\t\t\t<li class="edit">
\t\t\t\t\t\t\t\t\t<a href="${raw(`${head}&action=edit${tail}`)}"><i class="mi-pencil"></i>${raw(label(rb, 'edit'))}</a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t\t<li class="delete">
\t\t\t\t\t\t\t\t\t<a href="${raw(`${head}&action=delete${tail}`)}${ctx.csrf.render(row.responseId, 'url')}" onclick="return confirmDialog('${raw(encodeJs(label(rb, 'deleteresponseconfirm')))}',this.href)"><i class="mi-trash"></i>${raw(label(rb, 'deleteresponse'))}</a>
\t\t\t\t\t\t\t\t</li>
\t\t\t\t\t\t\t</ul>
\t\t\t\t\t\t</div>
\t\t\t\t\t</td>
\t\t\t\t\t<td class="dateSubmitted">${raw(formatDateTimeShort(row.entered, input.dateKeyFormat, input.locale))}</td>
\t\t\t\t\t${join(cells)}`;
}

/** An `rc` time value the row links read; legacy's `getData` already fails on a missing one before any row renders. */
function rcValue(value: string | undefined, name: string): string {
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** The response grid, or the deleted count after a bulk delete; nothing when the query matched no rows. */
async function results(
  ctx: DataResponsesCtx,
  input: DataResponsesInput,
  fields: readonly string[],
  minute1: string,
): Promise<SafeHtml> {
  const { results: outcome } = input;
  if (outcome === undefined) return NOTHING;
  if (outcome.kind === 'deleted') {
    return outcome.count === 0
      ? NOTHING
      : html`\n\t\t\t<div class="help-block-empty">${raw(String(outcome.count))} responses were deleted.</div>\n\t\t`;
  }
  if (outcome.rows.length === 0) return NOTHING;
  const times: LinkTimes = {
    hour1: rcValue(input.hour1, 'hour1'),
    minute1,
    hour2: rcValue(input.hour2, 'hour2'),
    minute2: rcValue(input.minute2, 'minute2'),
  };
  await ctx.csrf.prefetch(outcome.rows.filter((row) => row.data !== null).map((row) => row.responseId));
  const rows = outcome.rows.map((row) => {
    const body =
      row.data === null
        ? html`\n\t\t\t\t\t\t<td>Invalid Response: ${raw(row.responseId)}</td>\n\t\t\t\t\t`
        : responseCells(ctx, input, fields, row, row.data, times);
    return html`\n\t\t\t<tr>\n\t\t\t\t${body}\n\t\t\t</tr>\n\t\t\t`;
  });
  const headers = fields.map((f) => html`\n\t\t\t\t<th>${raw(encodeHtml(f))}</th>\n\t\t\t\t`);
  return html`
\t\t\t<div class="mura-grid-container">
\t\t\t<table class="mura-table-grid">
\t\t\t<thead>
\t\t\t<tr>
\t\t\t\t<th class="actions"></th>
\t\t\t\t<th>${raw(label(ctx.rb, 'datetimeentered'))}</th>
\t\t\t\t${join(headers)}
\t\t\t</tr>
\t\t\t</thead>
\t\t\t<tbody>
\t\t\t${join(rows)}
\t\t\t</tbody>
\t\t\t</table>
\t\t\t</div><!-- /.mura-grid-container -->
\t\t`;
}

/** Renders the responses panel: the download form (or the no-data notice) and, once filtered, the response grid. */
export async function renderDataResponses(ctx: DataResponsesCtx, input: DataResponsesInput): Promise<SafeHtml> {
  const fields = listItems(input.fieldnames);
  const form = input.countEntered === 0 ? EMPTY_NOTICE : downloadForm(ctx.rb, input, fields);
  const grid = input.minute1 === undefined ? NOTHING : await results(ctx, input, fields, input.minute1);
  return html`\n\n<div id="manage-data">\n${form}${grid}\n</div>\n`;
}
