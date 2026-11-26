/** Byte-exact ports of carch `loadquickedit.cfm`, `loadrelatedcontent.cfm` and `loadselectedrelatedcontent.cfm`. */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LEGACY_HTML_CONTENT_TYPE,
  cfDateTimeFormat,
  cfEq,
  cfHour,
  cfIsDateText,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfMinute,
  cfParseDateTimeText,
  cfToBoolean,
} from '@opt2/platform/legacy-compat';
import {
  cfHtmlEditFormat,
  esapiEncode,
  iconClass,
  lsDateFormat,
  type AdminRenderContext,
  type CustomIconLookup,
  type NodePerm,
  type ZoomCrumb,
} from './admin-markup.js';
import type { CategoryRow, ContentRow, ExtendRcsetRow, ExtendSubtypeRow } from '../repo/tables.js';

/** A rendered fragment; structurally an `AdminRenderResult` of `./admin-render.ts`. */
export interface AdminFragment {
  status: 200;
  contentType: string;
  body: string;
}

function fragment(out: CfmlOutput): AdminFragment {
  return { status: 200, contentType: LEGACY_HTML_CONTENT_TYPE, body: out.toString() };
}

// --- ACF output ---

const isWhitespace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * ACF 2023 whitespace-managed output: a whitespace-only static piece prints one space after non-whitespace, else
 * nothing. Custom tags and `cfsavecontent` render into a fresh instance appended with {@link CfmlOutput.value}.
 */
class CfmlOutput {
  private body = '';

  /** A static piece that is not whitespace only (text between two tags, expressions or comments). */
  text(piece: string): this {
    this.body += piece;
    return this;
  }

  /** A whitespace-only static piece; its exact characters never reach the output. */
  ws(): this {
    if (this.body !== '' && !isWhitespace(this.body.charCodeAt(this.body.length - 1))) this.body += ' ';
    return this;
  }

  /** The output of a `#expression#` or of a nested custom tag. */
  value(v: string): this {
    this.body += v;
    return this;
  }

  toString(): string {
    return this.body;
  }
}

const html = (s: string | number | null): string => esapiEncode('html', s);
const attr = (s: string | number | null): string => esapiEncode('html_attr', s);
const js = (s: string | number | null): string => esapiEncode('javascript', s);

/** CFML `ToString` of a date-time value: `{ts 'yyyy-mm-dd HH:nn:ss'}`. */
function cfDateString(d: Date): string {
  return `{ts '${cfDateTimeFormat(d, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

/** CFML `dateDiff('yyyy', from, to)`: whole years from `from` to `to`, negative when `to` is earlier. */
function yearsBetween(from: Date, to: Date): number {
  const [early, late, sign] = to >= from ? [from, to, 1] : [to, from, -1];
  let years = late.getFullYear() - early.getFullYear();
  const anniversary = new Date(early.getTime());
  anniversary.setFullYear(early.getFullYear() + years);
  if (anniversary > late) years--;
  return sign * years;
}

/** CFML `listGetAt(list, n)`: throws where ACF reports an invalid list index. */
function listGetAt(list: string, n: number): string {
  const item = cfListToArray(list)[n - 1];
  if (item === undefined) throw new RangeError(`Invalid list index ${n}.`);
  return item;
}

// --- Custom tags ---

/** The `cf_datetimeselector` attributes loadquickedit.cfm passes; every other attribute keeps its default. */
interface DateTimeSelectorAttrs {
  name: string;
  datetime: Date | null;
  defaultHour?: number;
  defaultMinute?: number;
}

/** `core/mura/customtags/timeselector.cfm` as datetimeselector calls it (hour/minute/daypart names blanked). */
function renderTimeSelector(name: string, time: Date | null, defaultHour: number, defaultMinute: number, dayParts: boolean): string {
  let hour = time === null ? defaultHour : cfHour(time);
  const minute = time === null ? defaultMinute : cfMinute(time);
  const o = new CfmlOutput();
  // Each select opens with `id="…" class="time mura-datepicker<name>" name=""`: datetimeselector blanks the names.
  const select = (lead: string, suffix: string): CfmlOutput =>
    o.text(lead).value(attr(`mura-${name}${suffix}`)).text('" class="').value(attr('time')).text(' mura-datepicker')
      .value(attr(name)).text('" name="').value(attr(''));
  let dayPart = '';
  if (dayParts) {
    if (hour >= 12) {
      if (hour > 12) hour -= 12;
      dayPart = 'PM';
    } else {
      if (hour === 0) hour = 12;
      dayPart = 'AM';
    }
  }
  select(dayParts ? '\n\t\t<select id="' : '\n\t\t<select  id="', 'Hour').text('">');
  for (let h = dayParts ? 1 : 0; h <= (dayParts ? 12 : 23); h++) {
    o.text('<option value="').value(String(h)).text('" ');
    if (h === hour) o.text('selected');
    o.text('>').value(String(h)).text('</option>');
  }
  o.text('</select>\n\t');
  select('\n\n\t<select id="', 'Minute').text('">');
  for (let m = 0; m <= 59; m++) {
    o.text('<option value="').value(String(m)).text('" ');
    if (m === minute) o.text('selected');
    o.text('>').value(String(m).padStart(2, '0')).text('</option>');
  }
  o.text('</select>\n\n\t');
  if (dayParts) {
    select('\n\t\t<select id="', 'DayPart').text('"><option value="AM">AM</option><option value="PM" ');
    if (dayPart === 'PM') o.text('selected');
    o.text('>PM</option></select>\n\t');
  }
  return o.ws().ws().toString();
}

/** `core/mura/customtags/datetimeselector.cfm`; a date over 50 years ahead prints blank but keeps its time selects. */
function renderDateTimeSelector(
  a: DateTimeSelectorAttrs,
  dateKeyFormat: string,
  locale: string,
  dayParts: boolean,
  now: Date,
): string {
  const datetime = a.datetime !== null && yearsBetween(now, a.datetime) > 50 ? null : a.datetime;
  const o = new CfmlOutput();
  o.text('\n<input type="text" autocomplete="off" class="datepicker ').value(attr('')).ws().value(attr('span3'));
  o.text(' mura-datepicker').value(attr(a.name)).text('" value="').value(lsDateFormat(datetime, dateKeyFormat, locale));
  o.text('" maxlength="12" id="mura-datepicker-').value(attr(a.name)).text('"/>').ws().ws();
  o.value(renderTimeSelector(a.name, a.datetime, a.defaultHour ?? 0, a.defaultMinute ?? 0, dayParts)).ws();
  o.text('\n<input type="hidden" id="mura-').value(attr(a.name)).text('" name="').value(attr(a.name));
  o.text('" value="').value(attr(datetime === null ? '' : cfDateString(datetime))).text('" data-required="');
  o.value(attr('false')).text('" data-required="').value(attr('')).text("\"/>\n<script>\n\t$(function(){\n\t\t$('.mura-datepicker");
  o.value(js(a.name)).text("').change(\n\t\t\tfunction(){\n\t\t\t\tparseDateTimeSelector('").value(js(a.name));
  o.text("');\n\t\t\t}\n\t\t);\n\t});\n</script>\n");
  return o.ws().toString();
}

/** The default icon of `extendSubType.getDefaultIconClass()`, matched case-insensitively as cfswitch matches. */
const SUBTYPE_DEFAULT_ICONS: ReadonlyMap<string, string> = new Map([
  ['page', 'mi-file'],
  ['folder', 'mi-folder-open-o'],
  ['file', 'mi-file-text-o'],
  ['link', 'mi-link'],
  ['calendar', 'mi-calendar'],
  ['gallery', 'mi-th'],
  ['1', 'mi-group'],
  ['2', 'mi-user'],
]);

/** A `content.extend_subtype` row as the views read it. */
export type SubTypeView = Pick<ExtendSubtypeRow, 'type' | 'subtype' | 'iconclass' | 'adminonly'>;

/** `getSubTypeByName(type, subtype, siteid).getIconClass(includeDefault=true)` over the site's subtype rows. */
function subTypeIconClass(subTypes: readonly SubTypeView[], type: string, subtype: string): string {
  // SQL Server's default collation matches type and subtype case-insensitively; setIconClass trims and maps icon- to mi-.
  const stored = subTypes.find((r) => cfEq(r.type ?? '', type) && cfEq(r.subtype ?? '', subtype))?.iconclass ?? '';
  const icon = stored === '' ? '' : stored.trim().replace('icon-', 'mi-');
  return icon !== '' ? icon : (SUBTYPE_DEFAULT_ICONS.get(type.toLowerCase()) ?? 'mi-cog');
}

/** `$.dspZoomNoLinks(crumbdata)` (contentRendererUtility.cfc:8-60); `crumbs` is leaf first and must not be empty. */
function renderZoomNoLinks(crumbs: readonly ZoomCrumb[], customIcons: CustomIconLookup): string {
  const current = crumbs[0];
  if (current === undefined) throw new RangeError('The element at position 1 cannot be found.');
  const charLimit = 90;
  const minLevels = 2;
  let crumbLen = crumbs.length;
  let charCount = 0;
  for (let i = 1; i <= crumbs.length; i++) {
    charCount += (crumbs[i - 1]?.menutitle ?? '').length + 3;
    if (charCount >= charLimit) {
      crumbLen = i - 1;
      break;
    }
  }
  if (crumbLen < minLevels && minLevels <= crumbs.length) crumbLen = minLevels;
  const o = new CfmlOutput().text('\n\t\t<ul class="navZoom">\n\t\t');
  let locked = '';
  const item = (crumb: ZoomCrumb, indent: string, open: string, close: string): void => {
    const icon = iconClass(customIcons, crumb);
    const isFileIcon = cfEq(crumb.type ?? '', 'File') && !cfEq(cfListToArray(icon, '-')[0] ?? '', 'mi');
    o.text(`\n${indent}<li class="`).value(icon).ws().value(locked);
    if (isFileIcon) o.text(' file');
    o.text('"');
    if (isFileIcon) o.text(' data-filetype="').value(icon.slice(0, 4)).text('"');
    o.text(`> ${open}`).value(cfHtmlEditFormat(crumb.menutitle ?? '')).text(`${close}</li>`);
  };
  for (let i = crumbLen; i >= 2; i--) {
    const crumb = crumbs[i - 1] as ZoomCrumb;
    // Once an ancestor is restricted every later item is marked; the leaf ignores its own flag (lastlocked is unused).
    if (crumb.restricted === 1) locked = 'locked';
    o.ws();
    item(crumb, '\t\t\t', '', '');
    o.text('\n\t\t');
  }
  o.ws();
  item(current, '\t\t', '<strong>', '</strong>');
  return o.text('\n\t\t</ul>').toString();
}

/** A category of the site's category pool with its children, as `categoryManager.getCategories` lists them. */
export type CategoryNode = Pick<CategoryRow, 'categoryid' | 'name' | 'isopen'> & { children: readonly CategoryNode[] };

/** `admin/core/views/carch/dsp_categories_nest.cfm`, recursing into each category that has children. */
function renderCategoriesNest(nodes: readonly CategoryNode[], categoryId: string, nestLevel: number): string {
  const o = new CfmlOutput();
  if (nodes.length > 0) {
    o.text('\n<ul class="categories');
    if (nestLevel === 0) o.text(' checkboxTree');
    o.text('">\n');
    const selected = cfListToArray(categoryId);
    for (const node of nodes) {
      o.text('\n<li>\n');
      if (node.isopen === 1) {
        o.text('<input type="checkbox" name="').value('rcCategoryID').text('" class="checkbox" ');
        if (selected.includes(node.categoryid)) o.text('checked');
        o.text(' value="').value(node.categoryid).text('"/> ');
      }
      o.value(html(node.name)).ws();
      if (node.children.length > 0) o.ws().value(renderCategoriesNest(node.children, categoryId, nestLevel + 1)).ws();
      o.text('\n</li>\n');
    }
    o.text('\n</ul>\n');
  }
  return o.ws().toString();
}

// --- Display interval ---

/** `content.getDisplayInterval().getAllValues()`: the keys loadquickedit.cfm reads. */
export interface DisplayIntervalValues {
  type: string;
  every: string | number;
  repeats: string | number | boolean;
  allday: string | number | boolean;
  end: string;
  /** `setEndOn(parseDateArg(…))`: the end date, or '' when the stored value is no date. */
  endon: Date | '';
  endafter: string | number;
  daysofweek: string;
  timezone: string;
}

const DAYS_OF_WEEK_TYPES: readonly string[] = ['weekly', 'bi-weekly', 'monthly', 'week1', 'week2', 'week3', 'week4', 'weeklast'];

/** A JSON value as CFML prints it; NULL reads as ''. */
function simpleText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** CFML `isJSON(text)` then `deserializeJSON(text)`; undefined when the text is no JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `cfobject.parseDateArg(arg)` (cfobject.cfc:474-497) for a value of the stored interval, under `setLocale(locale)`. */
function parseDateArg(value: unknown, locale: string): Date | '' {
  if (value instanceof Date) return value;
  let text = simpleText(value);
  if (/\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(text)) text = text.replace('T', ' ');
  if (cfLsIsDate(text, locale)) return cfLsParseDateTime(text, locale);
  return cfIsDateText(text) ? cfParseDateTimeText(text) : '';
}

/**
 * `contentIntervalManager.deserializeInterval` (contentIntervalManager.cfc:165-228) over the stored version values;
 * `serverTimeZone` is the legacy server's default zone id; `locale` is `session.locale`, which reads the stored end date.
 */
export function displayIntervalValues(
  interval: string | null,
  displayStart: Date | null,
  displayStop: Date | null,
  serverTimeZone: string,
  locale: string,
): DisplayIntervalValues {
  const raw = interval ?? '';
  const parsed = parseJson(raw);
  // CFML structs are case-insensitive; the stored JSON carries upper-case keys.
  const data = new Map<string, unknown>();
  if (parsed !== undefined) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${raw} is not a struct.`);
    for (const [key, value] of Object.entries(parsed)) data.set(key.toLowerCase(), value);
  } else if (raw !== '') {
    data.set('type', raw);
  }
  const param = (key: string, value: unknown): void => {
    if (!data.has(key)) data.set(key, value);
  };
  param('every', 1);
  param('type', 'daily');
  param('endafter', '1');
  param('endon', '');
  param('allday', '1');
  if (!data.has('end')) {
    const ends = displayStart !== null && displayStop !== null;
    data.set('end', ends ? 'on' : 'never');
    data.set('endon', ends ? displayStop : '');
  }
  if (!data.has('timezone') || simpleText(data.get('timezone')) === '' || cfToBoolean(data.get('allday'))) {
    data.set('timezone', serverTimeZone);
  }
  const type = simpleText(data.get('type'));
  if (!data.has('repeats')) data.set('repeats', cfEq(type, 'daily') && !cfToBoolean(data.get('every')) ? 0 : 1);
  if (!cfToBoolean(data.get('every'))) data.set('every', 1);
  if (!DAYS_OF_WEEK_TYPES.some((t) => cfEq(t, type))) data.set('daysofweek', '');
  else param('daysofweek', displayStart === null ? '' : String(displayStart.getDay() + 1));
  const numberOrText = (v: unknown): string | number => (typeof v === 'number' ? v : simpleText(v));
  const flag = (v: unknown): string | number | boolean => (typeof v === 'boolean' ? v : numberOrText(v));
  return {
    type,
    every: numberOrText(data.get('every')),
    repeats: flag(data.get('repeats')),
    allday: flag(data.get('allday')),
    end: simpleText(data.get('end')),
    endon: parseDateArg(data.get('endon'), locale),
    endafter: numberOrText(data.get('endafter')),
    daysofweek: simpleText(data.get('daysofweek')),
    timezone: simpleText(data.get('timezone')),
  };
}

// --- carch.loadquickedit ---

// The inline script of the display branch (loadquickedit.cfm:255-570), split where the template branches or prints.
const QE_JS_A = `

\t\tfunction pushDisplayStopOut(){
\t\t\t$('#mura-datepicker-displayStop').val($('#mura-datepicker-displayStart').val());
\t\t\t$('#mura-datepicker-displayStop').trigger('change');

\t\t\tvar stopMinute = ($('#mura-displayStopMinute').length) ? $('#mura-displayStopMinute').val() : 0;
\t\t\tvar stopHour=($('#mura-displayStopHour').length) ? $('#mura-displayStopHour').val() : 0;

\t\t\tif($('#mura-displayStopDayPart').length){
\t\t\t\tif($('#mura-displayStopDayPart').val().toLowerCase() == 'pm'){
\t\t\t\t\tstopHour=parseInt(stopHour) + 12;
\t\t\t\t\tif(stopHour==24){
\t\t\t\t\t\tstopHour=12;
\t\t\t\t\t}
\t\t\t\t} else if (parseInt(stopHour) ==12) {
\t\t\t\t\tstopHour=0;
\t\t\t\t}
\t\t\t}

\t\t\tif(stopHour.length==1){
\t\t\t\tstopHour='0' + stopHour;
\t\t\t}

\t\t\tif(stopMinute.length==1){
\t\t\t\tstopMinute='0' + stopMinute;
\t\t\t}

\t\t\t$('#mura-displayStop').val("{ts '2100-01-01 " + stopHour + ":" + stopMinute + ":00'}");
\t\t\t$('#displayIntervalEndOn').val('');
\t\t}

\t\tfunction updateDisplayInterval(){
\t\t\tif($('#displayIntervalEnd').val()=='on'){
\t\t\t\t$('#mura-datepicker-displayStop').val($('#displayIntervalEndOn').val());
\t\t\t\t$('#mura-datepicker-displayStop').trigger('change');
\t\t\t} else {
\t\t\t\tpushDisplayStopOut();
\t\t\t}

\t\t\tvar options={
\t\t\t\trepeats: (!isCalendar || isCalendar && $('#displayIntervalRepeats').is(':checked')) ? 1 : 0,
\t\t\t\tdetectconflicts: $('#displayIntervalDetectConflicts').is(':checked') ? 1 : 0,
\t\t\t\tdetectspan: $('#mura-detectspan').val(),
\t\t\t\tallday:  (isCalendar && $('#displayIntervalAllDay').is(':checked')) ? 1 : 0,
\t\t\t\ttimezone: $('#displayIntervalTZ').val(),
\t\t\t\tevery: $('#displayIntervalEvery').val() || 0,
\t\t\t\ttype: $('#displayIntervalType').val(),
\t\t\t\tend: $('#displayIntervalEnd').val(),
\t\t\t\tendon: $('#displayIntervalEndOn').val(),
\t\t\t\tendafter: $('#displayIntervalEndAfter').val(),
\t\t\t\tdaysofweek: getDaysOfWeek()
\t\t\t};

\t\t\tif(!options.repeats && options.allday){
\t\t\t\t$('#mura-datepicker-displayStop').val($('#mura-datepicker-displayStart').val());
\t\t\t\t$('#mura-datepicker-displayStop').trigger('change');
\t\t\t\toptions.endon=$('#mura-datepicker-displayStop').val();
\t\t\t}

\t\t\t$('#displayInterval').val(JSON.stringify(options));
\t\t}

\t\tfunction getDaysOfWeek(){
\t\t\tvar daysofweek=[];

\t\t\t$('input[name="displayIntervalDays"]').each(function(){
\t\t\t\tvar day=$(this);
\t\t\t\tif(day.is(':checked')){
\t\t\t\t\tdaysofweek.push(day.val());
\t\t\t\t}
\t\t\t});

\t\t\treturn daysofweek.join();
\t\t}

\t\tfunction setDaysOfWeekDefault(){

\t\t\tif(!$('input[name="displayIntervalDays"]:checked').length){
\t\t\t\tvar dateString=$('input[name="displayStart"]').val();

\t\t\t\tif(dateString){
\t\t\t\t\tvar dateObj=new Date(dateString.substring(5,24));

\t\t\t\t\tif(dateObj.getDay() > -1){
\t\t\t\t\t\t$('input[name="displayIntervalDays"]:eq('+ dateObj.getDay() + ')').prop('checked',true);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}

\t\tfunction setEndOption(){

\t\t\tif(!isCalendar || isCalendar && $('#displayIntervalRepeats').is(':checked')){
\t\t\t\tvar type=$('#displayIntervalEnd').val();

\t\t\t\t$('.mura-interval-end').hide();
\t\t\t\t//alert(type)
\t\t\t\tif(type=='after'){
\t\t\t\t\t$('#mura-interval-end-after').show();
\t\t\t\t\tpushDisplayStopOut();
\t\t\t\t} else if(type=='on'){
\t\t\t\t\t$('#mura-interval-end-on').show();

\t\t\t\t\tvar start=$('#mura-datepicker-displayStart');
\t\t\t\t\tvar stop=$('#mura-datepicker-displayStop');
\t\t\t\t\tvar endon=$('#displayIntervalEndOn');

\t\t\t\t\tif(!stop.val() && endon.val()){
\t\t\t\t\t\tstop.val(endon.val()).trigger('change');
\t\t\t\t\t}

\t\t\t\t\tif(!endon.val()){
\t\t\t\t\t\tendon.val(stop.val())
\t\t\t\t\t}

\t\t\t\t\tif(!endon.val()){
\t\t\t\t\t\tendon.val(start.val());
\t\t\t\t\t\tstop.val(start.val()).trigger('change');
\t\t\t\t\t}
\t\t\t\t} else if(type=='never'){
\t\t\t\t\tpushDisplayStopOut();
\t\t\t\t}
\t\t\t} else {
\t\t\t\tvar start=$('#mura-datepicker-displayStart');
\t\t\t\tvar stop=$('#mura-datepicker-displayStop');
\t\t\t\tstop.val(start.val()).trigger('change');
\t\t\t\t$('#displayIntervalEnd').val('on');
\t\t\t\t$('#displayIntervalEndOn').val(start.val());
\t\t\t}

\t\t\tupdateDisplayInterval();

\t\t}

\t\tfunction setIntervalUnitLabel(){
\t\t\tvar type=$('#displayIntervalType').val();
\t\t\t//alert(type)
\t\t\t$('.mura-interval-every-label').hide();

\t\t\tswitch(type){
\t\t\t\tcase 'weekly':
\t\t\t\tcase 'weekends':
\t\t\t\tcase 'weekdays':
\t\t\t\t$('#mura-interval-every-label-weeks').show();
\t\t\t\tbreak;
\t\t\t\tcase 'bi-weekly':
\t\t\t\t$('#mura-interval-every-label-biweeks').show();
\t\t\t\tbreak;
\t\t\t\tcase 'yearly':
\t\t\t\t$('#mura-interval-every-label-years').show();
\t\t\t\tbreak;
\t\t\t\tcase 'daily':
\t\t\t\t$('#mura-interval-every-label-days').show();
\t\t\t\tbreak;
\t\t\t\tdefault:
\t\t\t\t$('#mura-interval-every-label-months').show();
\t\t\t}
\t\t}

\t\tfunction toggleRepeatOptions(){
\t\t\tvar input=$('#displayIntervalType');

\t\t\tif(input.val().toLowerCase().search('week') > -1 && input.val() != 'weekends' && input.val() != 'weekdays'){
\t\t\t\t$('.mura-daysofweek').show();
\t\t\t\tsetDaysOfWeekDefault();

\t\t\t} else {
\t\t\t\t$('.mura-daysofweek').hide();
\t\t\t}

\t\t\tsetIntervalUnitLabel();
\t\t}

\t\tfunction toggleAllDayOptions(){
\t\t\tif(isCalendar && $('#displayIntervalAllDay').is(':checked')){
\t\t\t\t$('#mura-displayStartHour').hide();
\t\t\t\t$('#mura-displayStartMinute').hide();
\t\t\t\t$('#mura-displayStartDayPart').hide();
\t\t\t\t$('#mura-displayStopHour').hide();
\t\t\t\t$('#mura-displayStopMinute').hide();
\t\t\t\t$('#mura-displayStopDayPart').hide();
\t\t\t\t$('#mura-tz-container').hide();
\t\t\t\t$('#displayIntervalToLabel').hide();

\t\t\t\t$('#displayIntervalTZ').val('`;

const QE_JS_A2 = `');

\t\t\t\t`;

const QE_JS_DAYPARTS = `
\t\t\t\t\t$('#mura-displayStartHour').val('12');
\t\t\t\t\t$('#mura-displayStartMinute').val('0');
\t\t\t\t\t$('#mura-displayStartDayPart').val('AM');
\t\t\t\t\t$('#mura-displayStopHour').val('11');
\t\t\t\t\t$('#mura-displayStopMinute').val('59');
\t\t\t\t\t$('#mura-displayStopDayPart').val('PM');
\t\t\t\t`;

const QE_JS_NODAYPARTS = `
\t\t\t\t\t$('#mura-displayStartHour').val('0');
\t\t\t\t\t$('#mura-displayStartMinute').val('0');
\t\t\t\t\t$('#mura-displayStopHour').val('23');
\t\t\t\t\t$('#mura-displayStopMinute').val('59');
\t\t\t\t`;

const QE_JS_B = `

\t\t\t} else if(isCalendar){
\t\t\t\t$('#mura-tz-container').show();
\t\t\t\t$('#mura-displayStartHour').show();
\t\t\t\t$('#mura-displayStartMinute').show();
\t\t\t\t$('#mura-displayStartDayPart').show();
\t\t\t\t$('#mura-displayStopHour').show();
\t\t\t\t$('#mura-displayStopMinute').show();
\t\t\t\t$('#mura-displayStopDayPart').show();
\t\t\t\t$('#displayIntervalToLabel').show();
\t\t\t\t$('#mura-tz-container').show();
\t\t\t} else {
\t\t\t\t$('#mura-tz-container').show();
\t\t\t\t$('#mura-displayStartHour').show();
\t\t\t\t$('#mura-displayStartMinute').show();
\t\t\t\t$('#mura-displayStartDayPart').show();
\t\t\t\t$('#mura-displayStopHour').hide();
\t\t\t\t$('#mura-displayStopMinute').hide();
\t\t\t\t$('#mura-displayStopDayPart').hide();
\t\t\t\t$('#displayIntervalToLabel').show();
\t\t\t\t$('#mura-tz-container').show();
\t\t\t}

\t\t\tupdateDisplayInterval();
\t\t}

\t\tfunction toggleRepeatOptionsContainer(){
\t\t\tvar input=$('input[name="displayIntervalEvery"]');

\t\t\tif(!isCalendar || isCalendar && $('#displayIntervalRepeats').is(':checked')){
\t\t\t\t$('.mura-repeat-options').show();
\t\t\t\tsetDaysOfWeekDefault();

\t\t\t} else {
\t\t\t\t$('.mura-repeat-options').hide();
\t\t\t\t//$('#mura-datepicker-displayStop').show();
\t\t\t\t$('#displayIntervalType').val('daily');

\t\t\t\tif($('#displayIntervalEndOn').val()){
\t\t\t\t\t$('#displayIntervalEnd').val('on');
\t\t\t\t} else {
\t\t\t\t\t$('#displayIntervalEnd').val('never');
\t\t\t\t}

\t\t\t\ttoggleRepeatOptions();
\t\t\t}
\t\t\tsetEndOption();
\t\t\tsetIntervalUnitLabel();
\t\t}

\t\tfunction toggleDetectConflicts(){
\t\t\tif($('#displayIntervalDetectConflicts').is(':checked')){
\t\t\t\t$('#mura-detectspan-container').show();
\t\t\t} else {
\t\t\t\t$('#mura-detectspan-container').hide();
\t\t\t}

\t\t}

\t\t$('#mura-datepicker-displayStop').hide();
\t\t$('.mura-repeat-option').on('change',updateDisplayInterval);
\t\t$('#displayIntervalRepeats').click(toggleRepeatOptionsContainer);
\t\t$('#displayIntervalAllDay').click(toggleAllDayOptions);
\t\t$('#displayIntervalDetectConflicts').click(toggleDetectConflicts);
\t\t$('#displayIntervalType').on('change',toggleRepeatOptions);
\t\t$('#displayIntervalEnd').on('change',setEndOption);
\t\t$('#mura-datepicker-displayStart').change(setEndOption);

\t\tvar repeats=$('input[name="displayIntervalEvery"]').is(':checked');
\t\tif(repeats){
\t\t\t$('#displayIntervalRepeats').attr('checked',true);
\t\t}

\t\ttoggleRepeatOptionsContainer();
\t\ttoggleRepeatOptions();
\t\ttoggleAllDayOptions();
\t\tsetEndOption();
\t\ttoggleDetectConflicts();


\t\tfunction getScheduleURL(el){
\t\t\tvar u = $('#mura-quickEditor').parents('dd.display').parents('dl').find('a.title').attr('href');
\t\t\treturn u;
\t\t}

\t\t$('#btn__quickedit__schedule').click(function(){
\t\t\twindow.location.href=getScheduleURL($(this)) + '&bigui=schedule#panel-schedule';
\t\t\treturn false;
\t\t});

\t\t//toggle quickedit contents for 'per schedule'
\t\t$('#mura-display').change(function(){
\t\t\tif($(this).val() == 2){
\t\t\t\t`;

const QE_JS_SCHED_ON = `
\t\t\t\t\t$('.mura-quickEdit').addClass("large");
\t\t\t\t`;

const QE_JS_SCHED_ON_ELSE = `
\t\t\t\t\t$('#btn__quickedit__save').hide();
\t\t\t\t\t$('#btn__quickedit__schedule').show();
\t\t\t\t`;

const QE_JS_C = `
\t\t\t} else {
\t\t\t\t`;

const QE_JS_SCHED_OFF = `
\t\t\t\t\t$('.mura-quickEdit').removeClass("large")
\t\t\t\t`;

const QE_JS_SCHED_OFF_ELSE = `
\t\t\t\t\t$('#btn__quickedit__save').show();
\t\t\t\t\t$('#btn__quickedit__schedule').hide();
\t\t\t\t`;

const QE_JS_D = `
\t\t\t}
\t\t}).trigger('change');
\t})
\t</script>
\t`;

/** The node data loadquickedit.cfm reads; the node is loaded by `rc.contentid`. */
export interface QuickEditModel {
  /** `rc.attribute`: isnav, inheritObjects, template, display, or any other value (heading and buttons only). */
  attribute: string;
  /** `rc.contentid`. */
  contentId: string;
  /** `content.hasDrafts()`. */
  hasDrafts: boolean;
  /** Columns of the node's active version. */
  content: Pick<ContentRow, 'isnav' | 'inheritobjects' | 'template' | 'childtemplate' | 'display' | 'displayinterval'>;
  /** `content.getDisplayStart(timezone=displayInterval.timezone)`. */
  displayStart: Date | null;
  /** `content.getDisplayStop(timezone=displayInterval.timezone)`. */
  displayStop: Date | null;
  /** {@link displayIntervalValues} over the version's stored interval, start and stop. */
  displayInterval: DisplayIntervalValues;
  /** `content.getParent().getType()`; not read for the home node. */
  parentType: string;
  /** `rc.ptype` after carch `before()` (default `Page`): the home node keeps it, as `rs.ptype=''` sets the wrong scope. */
  requestPtype: string;
  /** `contentUtility.getTemplates(siteid, type)` names in query order (by name), listed from the site's theme directory. */
  templates: readonly string[];
  /** `session.localeHasDayParts`. */
  localeHasDayParts: boolean;
  /** `globalConfig('tzRegex')`; '' prints the default zone as a hidden field. */
  tzRegex: string;
  /** `java.util.TimeZone.getDefault().getID()` of the legacy server. */
  defaultTimeZone: string;
  /** `java.util.TimeZone.getAvailableIDs()`; read only when `tzRegex` is set. */
  availableTimeZones: readonly string[];
  /** `request.quickeditscheduler`: Masa never sets it, so it is false unless a plugin did. */
  quickEditScheduler?: boolean;
  /** `now()` of the request. */
  now: Date;
}

const INTERVAL_TYPES: readonly string[] = [
  'daily', 'weekly', 'bi-weekly', 'monthly', 'weekdays', 'weekends', 'week1', 'week2', 'week3', 'week4', 'weeklast', 'yearly',
];
const INTERVAL_EVERY_LABELS: readonly (readonly [id: string, key: string])[] = [
  ['weeks', 'weeks'], ['months', 'months'], ['years', 'years'], ['days', 'days'], ['biweeks', 'bi-weeks'],
];
const INHERIT_OPTIONS: readonly (readonly [value: string, key: string])[] = [
  ['Inherit', 'inheritcascade'], ['Cascade', 'startnewcascade'], ['Reject', 'donotinheritcascade'],
];

/** The two template selects (loadquickedit.cfm:99-124); only `.cfm` names are listed. */
function quickEditTemplates(o: CfmlOutput, model: QuickEditModel, key: (k: string) => string): void {
  const options = (current: string): void => {
    for (const name of model.templates) {
      o.ws();
      if (cfEq(name.slice(-4), '.cfm')) {
        o.ws().text('\n\t\t\t\t<option value="').value(name).text('" ');
        if (cfEq(current, name)) o.text('selected');
        o.text('>').value(name).text('</option>\n\t\t\t\t').ws();
      }
      o.ws();
    }
  };
  o.ws().text('\n\t\t<select id="mura-quickEdit-template">\n\t\t\t');
  if (!cfEq(model.contentId, LEGACY_ADMIN_SENTINEL_ID)) {
    o.text('\n\t\t\t\t<option value="">').value(key('sitemanager.content.fields.inheritfromparent')).text('</option>\n\t\t\t');
  }
  o.ws();
  options(model.content.template ?? '');
  o.text('\n\t\t</select>\n\t\t<h1>').value(key('sitemanager.quickedit.edit.childtemplate'));
  o.text('</h1>\n\t\t<select id="mura-quickEdit-childtemplate">\n\t\t\t<option value="">').value(key('sitemanager.content.fields.none'));
  o.text('</option>\n\t\t\t');
  options(model.content.childtemplate ?? '');
  o.text('\n\t\t</select>\n\t\t\n\t');
}

/** The schedule controls and their script (loadquickedit.cfm:125-571). */
function quickEditDisplay(o: CfmlOutput, model: QuickEditModel, ctx: AdminRenderContext): void {
  const key = (k: string): string => ctx.labels.key(k);
  const field = (k: string): string => key(`sitemanager.content.fields.${k}`);
  const { dateKeyFormat, locale } = ctx.session;
  const scheduler = model.quickEditScheduler === true;
  const display = simpleText(model.content.display);
  const dateTime = (a: DateTimeSelectorAttrs): string =>
    renderDateTimeSelector(a, dateKeyFormat, locale, model.localeHasDayParts, model.now);

  o.ws().ws().text('\n\t\t<div class="mura-control-group">\n\t\t\t <select name="display" id="mura-display" onchange="javascript: ');
  if (scheduler) o.text("this.selectedIndex==2?toggleDisplay2('editDates',true):");
  o.text("toggleDisplay2('editDates',false);\">\n\t\t\t\t<option value=\"1\"  ");
  if (cfEq(display, '1')) o.text(' selected');
  o.text('>').value(key('sitemanager.yes')).text('</option>\n\t\t\t\t<option value="0"  ');
  if (cfEq(display, '0')) o.text(' selected');
  o.text('>').value(key('sitemanager.no')).text('</option>\n\t\t\t\t<option value="2"  ');
  if (cfEq(display, '2')) o.text(' selected');
  o.text('>\n\t\t\t\t\t').value(field('perschedule')).text('\n\t\t\t\t</option>\n\t\t\t</select>\n\t\t</div>\n\t\t<div id="editDates" ');
  if (scheduler || !cfEq(display, '2')) o.text('style="display: none;"');
  o.text('>\n\t\t\t').ws();

  const ptype = cfEq(model.contentId, LEGACY_ADMIN_SENTINEL_ID) ? model.requestPtype : model.parentType;
  const isCalendar = cfEq(ptype, 'Calendar');
  const interval: DisplayIntervalValues = isCalendar ? model.displayInterval : { ...model.displayInterval, repeats: 1, allday: 0 };
  const defaultTz = model.defaultTimeZone;

  o.text('\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<label>').value(field('displayinterval.schedule')).text('</label>\n\t\t\t\t');
  o.value(dateTime({ name: 'displayStart', datetime: model.displayStart })).ws();
  if (isCalendar) {
    o.text('\n\t\t\t\t<label id="displayIntervalToLabel" class="time">').value(field('displayinterval.to'));
    o.text('</label>\n\t\t\t\t').value(dateTime({ name: 'displayStop', datetime: model.displayStop, defaultHour: 23, defaultMinute: 59 }));
    o.ws();
  }
  o.text('\n\t\t\t</div>\n\t\t\t');
  if (model.tzRegex !== '') {
    // CFML refind takes a Java-style pattern; the zone ids are sorted as arraySort(…, 'text') sorts them.
    const pattern = new RegExp(model.tzRegex);
    o.text('\n\t\t\t<div id="mura-tz-container" class="mura-control-group" style="display:none">\n\t\t\t\t<label>');
    o.value(field('displayinterval.timezone')).text('</label>\n\t\t\t\t').ws();
    o.text('\n\t\t\t\t<select name="displayIntervalTZ" id="displayIntervalTZ" class="mura-repeat-option">\n\t\t\t\t\t<option value="');
    o.value(defaultTz).text('"');
    if (cfEq(defaultTz, interval.timezone)) o.text(' selected ');
    o.text('>\n\t\t\t\t\t\t').value(field('default')).text(' (').value(defaultTz).text(')\n\t\t\t\t\t</option>\n\t\t\t\t\t');
    for (const id of [...model.availableTimeZones].sort()) {
      o.ws();
      if (!cfEq(id, defaultTz) && pattern.test(id)) {
        o.text('\n\t\t\t\t\t\t\t<option value="').value(id).text('"');
        if (cfEq(id, interval.timezone)) o.text(' selected ');
        o.text('>').value(id).text('</option>\n\t\t\t\t\t\t');
      }
      o.ws();
    }
    o.text('\n\t\t\t\t</select>\n\t\t\t</div>\n\t\t\t');
  } else {
    o.ws().text('\n\t\t\t\t<input type="hidden" name="displayIntervalTZ" id="displayIntervalTZ" value="').value(defaultTz);
    o.text('">\n\t\t\t');
  }
  o.text('\n\t\t\t<input type="hidden" name="displayInterval" id="displayInterval" value="').value(attr(model.content.displayinterval));
  o.text('">\n\t\t\t<input name="convertDisplayTimeZone" type="hidden" value="true">\n\n\n\t\t\t');
  if (isCalendar) {
    o.text('\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label class="checkbox" for="displayIntervalAllDay">\n\t\t\t\t\t\t');
    o.text('<input type="checkbox" id="displayIntervalAllDay" name="displayIntervalllDay" value="1" ');
    if (cfToBoolean(interval.allday)) o.text(' checked');
    o.text('/>&nbsp;&nbsp;').value(field('displayinterval.allday'));
    o.text('\n\t\t\t\t\t</label>\n\t\t\t\t\t<label for="displayIntervalRepeats" class="checkbox">\n\t\t\t\t\t\t');
    o.text('<input type="checkbox" class="mura-repeat-option" id="displayIntervalRepeats" value="1" name="displayIntervalRepeats"');
    if (cfToBoolean(interval.repeats)) o.text(' checked');
    o.text('>&nbsp;&nbsp;').value(field('displayinterval.repeats')).text('\n\t\t\t\t\t</label>\n\t\t\t\t</div>\n\t\t\t');
  } else {
    o.text('\n\t\t\t\t<input type="hidden" id="displayIntervalAllDay" name="displayIntervalllDay" value="0"/>');
    o.text('\n\t\t\t\t<input type="hidden" class="mura-repeat-option" id="displayIntervalRepeats" value="1" name="displayIntervalRepeats">\n\t\t\t');
  }
  o.text('\n\n\t\t\t<div class="mura-repeat-options mura-control-group" style="display:none">\n\t\t\t\t<div class="mura-control-inline">');
  o.text('\n\t\t\t\t\t<select id="displayIntervalType" name="displayIntervalType" class="mura-repeat-option">\n\t\t\t\t\t\t');
  for (const type of INTERVAL_TYPES) {
    o.text('\n\t\t\t\t\t\t<option value="').value(type).text('"');
    if (cfEq(interval.type, type)) o.text(' selected');
    o.text('>').value(field(`displayInterval.${type}`)).text('</option>\n\t\t\t\t\t\t');
  }
  o.text('\n\t\t\t\t\t</select>\n\t\t\t\t\t<label class="time-repeat">\n\t\t\t\t\t&nbsp;').value(field('displayinterval.every'));
  o.text('</label>\n\t\t\t\t\t<input type="text" id="displayIntervalEvery" name="displayIntervalEvery" value="').value(attr(interval.every));
  o.text('" class="mura-repeat-option" maxlength="4">\n\n\t\t\t\t\t<label class="time-repeat">');
  for (const [id, label] of INTERVAL_EVERY_LABELS) {
    o.text(`\n\t\t\t\t\t<span class="mura-interval-every-label" id="mura-interval-every-label-${id}" style="display:none">`);
    o.value(field(`displayinterval.${label}`)).text('</span>');
  }
  o.text('\n\t\t\t\t</label>\n\t\t\t\t</div>\n\t\t\t</div><!-- /mura-repeat-options -->\n\n\t\t\t\n\t\t\t').ws();

  const dayLabels = key('calendar.weekdayAbrev');
  const days = cfListToArray(interval.daysofweek);
  o.text('\n\t\t\t<div class="mura-daysofweek mura-control-group" style="display:none">\n\t\t\t\t<label class="checkbox inline">');
  o.value(field('displayinterval.ondow')).text(': </label>');
  for (let day = 1; day <= 7; day++) {
    o.text(`\n\t\t\t\t\t<label class="checkbox inline"><input class="mura-repeat-option" id="dow${day}" name="displayIntervalDays"`);
    o.text(` type="checkbox" value="${day}"`);
    if (days.includes(String(day))) o.text(' checked');
    o.text('/> ').value(listGetAt(dayLabels, day)).text('</label>');
  }
  o.text('\n\t\t\t</div>\n\t\t\t\n\n\t\t\t<div class="mura-repeat-options mura-control-group" style="display:none">\n\t\t\t\t<label class="time-repeat">');
  o.value(field('displayinterval.ends')).text(': </label>\n\t\t\t\t<select id="displayIntervalEnd" name="displayIntervalEnd" class="mura-repeat-option time">');
  o.text('\n\t\t\t\t\t<option value="never" ');
  if (cfEq(interval.end, 'never')) o.text(' selected');
  o.text('>').value(field('displayinterval.never')).text('</option>\n\t\t\t\t\t<option value="after"');
  if (cfEq(interval.end, 'after')) o.text(' selected');
  o.text('>').value(field('displayinterval.after')).text('</option>\n\t\t\t\t\t<option value="on"');
  if (cfEq(interval.end, 'on')) o.text(' selected');
  o.text('>').value(field('displayinterval.on')).text('</option>\n\t\t\t\t</select>');
  o.text('\n\t\t\t\t\t<span class="mura-interval-end" id="mura-interval-end-after" style="display:none">');
  o.text('\n\t\t\t\t\t\t<input type="text" id="displayIntervalEndAfter" name="displayIntervalEndAfter" value="').value(attr(interval.endafter));
  o.text('" class="mura-repeat-option" size="3">\n\t\t\t\t<label class="time-repeat">\n\t\t\t\t\t\t').value(field('displayinterval.occurrences'));
  o.text('\n\t\t\t\t</label>\n\t\t\t\t\t</span>\n\t\t\t\t\t<span class="mura-interval-end" id="mura-interval-end-on" style="display:none">');
  o.text('\n\t\t\t\t\t\t<input type="text" id="displayIntervalEndOn" name="displayIntervalEndOn"');
  o.text(' class="mura-repeat-option datepicker mura-datepickerdisplayIntervalEndOn" value="');
  o.value(lsDateFormat(interval.endon === '' ? null : interval.endon, dateKeyFormat, locale)).text('" maxlength="12"/>\n\t\t\t\t\t\t');
  if (!isCalendar) {
    o.ws().value(dateTime({ name: 'displayStop', datetime: model.displayStop, defaultHour: 23, defaultMinute: 59 })).ws();
  }
  o.text('\n\t\t\t\t\t</span>\n\t\t\t</div>\n\t\t</div>\n\t<script>\n\t$(function(){\n\t\t');
  o.text(isCalendar ? '\n\t\t\tvar isCalendar=true;\n\t\t' : '\n\t\t\tvar isCalendar=false;\n\t\t');
  o.text(QE_JS_A).value(defaultTz).text(QE_JS_A2).text(model.localeHasDayParts ? QE_JS_DAYPARTS : QE_JS_NODAYPARTS);
  o.text(QE_JS_B).text(scheduler ? QE_JS_SCHED_ON : QE_JS_SCHED_ON_ELSE);
  o.text(QE_JS_C).text(scheduler ? QE_JS_SCHED_OFF : QE_JS_SCHED_OFF_ELSE).text(QE_JS_D).ws();
}

/**
 * `carch.loadquickedit` (loadquickedit.cfm). No CSRF fields, as legacy prints none: the `<contentid>quickedit` tokens
 * travel in the Site Manager row's `data-csrf`. The route keeps `template` on legacy when it cannot supply `templates`.
 */
export function renderLoadQuickEdit(model: QuickEditModel, ctx: AdminRenderContext): AdminFragment {
  const key = (k: string): string => ctx.labels.key(k);
  const cancelTitle = key('sitemanager.quickedit.cancel');
  const o = new CfmlOutput().text("\n<script>\n\t$('.mura-quickEdit select').niceSelect();\n</script>\n").ws();
  if (model.hasDrafts) {
    o.text('\n\t<h1>').value(key('sitemanager.quickedit.hasdraftstitle')).text(' </h1>');
    o.text('\n\t<span class="cancel" onclick="siteManager.closeQuickEdit();" title="').value(cancelTitle);
    o.text('"><i class="mi-close"></i></span>\n\t\t<p id="hasDraftsMessage">').value(key('sitemanager.quickedit.hasdraftsmessage'));
    return fragment(o.text('</p>\n\t').ws());
  }
  const attribute = model.attribute;
  o.text('\n\t<h1>').value(key(`sitemanager.quickedit.edit${attribute}`)).text('</h1>');
  o.text('\n\t<span class="cancel" onclick="siteManager.closeQuickEdit();" title="').value(cancelTitle);
  o.text('"><i class="mi-close"></i></span>\n\n\t');
  if (cfEq(attribute, 'isnav')) {
    const isNav = cfToBoolean(model.content.isnav ?? '');
    o.text('\n\t\t<select id="mura-quickEdit-isnav">\n\t\t\t <option value="1"');
    if (isNav) o.text(' selected');
    o.text('>').value(key('sitemanager.true')).text('</option>\n\t\t\t <option value="0"');
    if (!isNav) o.text(' selected');
    o.text('>').value(key('sitemanager.false')).text('</option>\n\t\t</select>\n\t');
  } else if (cfEq(attribute, 'inheritObjects')) {
    o.text('\n\t\t<select id="mura-quickEdit-inheritobjects">');
    for (const [value, label] of INHERIT_OPTIONS) {
      o.text(`\n\t\t\t<option value="${value}"`);
      if (cfEq(model.content.inheritobjects ?? '', value)) o.text(' selected');
      o.text('>').value(key(`sitemanager.content.fields.${label}`)).text('</option>');
    }
    o.text('\n\t\t</select>\n\t');
  } else if (cfEq(attribute, 'template')) {
    quickEditTemplates(o, model, key);
  } else if (cfEq(attribute, 'display')) {
    quickEditDisplay(o, model, ctx);
  }
  const perSchedule = cfEq(attribute, 'display') && cfEq(simpleText(model.content.display), '2');
  o.text('\n\t<div class="form-actions">\n\t\t\n\t\t<button id="btn__quickedit__save"');
  if (perSchedule) o.text(' style="display:none;"');
  o.text(' class="btn mura-primary" onclick="siteManager.saveQuickEdit(this);">Submit</button>\n\t\t<button id="btn__quickedit__schedule"');
  if (!perSchedule) o.text(' style="display:none;"');
  o.text(' type="button" class="btn mura-primary"> Manage Schedule</button>\n\t</div>\n\t');
  return fragment(o.ws());
}

// --- carch.loadrelatedcontent ---

// The inline script of loadrelatedcontent.cfm:108-200, split around its two expressions.
const RC_JS_A = `
\t<script>
\t\tfunction toggleRelatedType(clicked){
\t\t\t$('#mura-rc-quickedit').hide();

\t\t\tif($(clicked).val()=='internal'){
\t\t\t\t$(".mura-related-internal").show();
\t\t\t\t$(".mura-related-external").hide();
\t\t\t} else {
\t\t\t\t$(".mura-related-internal").hide();
\t\t\t\t$(".mura-related-external").show();
\t\t\t}
\t\t}

\t\tfunction createExternalLink(){

\t\t\tif($('#mura-related-title').val()=='' || $('#mura-related-url').val()==''){

\t\t\t\talertDialog("`;

const RC_JS_B = `");

\t\t\t\treturn false;
\t\t\t}

\t\t\tvar newcontentid=Math.random();

\t\t\t$("#draggableContainmentExternal .list-table-items").append(
\t\t\t \t$('<li/>').attr('data-contentid',newcontentid)
\t\t\t \t.attr('data-url',$('#mura-related-url').val())
\t\t\t \t.attr('data-title',$('#mura-related-title').val())
\t\t\t \t.attr('data-content-type','Link/Default')
\t\t\t \t.attr('class','item')
\t\t\t \t.append(
\t\t\t \t\t$('<button class="btn mura-rc-quickoption" type="button" value="'+ newcontentid +'"><i class="mi-plus-circle"></i></button><ul class="navZoom"><li class="mi-link "> ' + $('#mura-related-title').val() + '</li></ul>')
\t\t\t \t)
\t\t\t );

\t\t\tif(!$("#draggableContainmentExternal").is(":visible")){
\t\t\t\t$("#draggableContainmentExternal").fadeIn();
\t\t\t}

\t\t\t$("#draggableContainmentExternal .rcDraggable li.item").draggable({
\t\t\t\tconnectToSortable: '.rcSortable',
\t\t\t\thelper: 'clone',
\t\t\t\trevert: 'invalid',
\t\t\t\tappendTo: 'body',
\t\t\t\tstart: function(event, ui) {
\t\t\t\t\t// bind mouse events to clone
\t\t\t\t\t$('#mura-rc-quickedit').hide();
\t\t\t\t\tsiteManager.bindMouse();
\t\t\t\t},
\t\t\t\tzIndex: 100
\t\t\t}).disableSelection();

\t\t\tsiteManager.setupRCQuikEdit();

\t\t\tsiteManager.bindMouse();

\t\t}

\t\tMura(function(){

\t\t\tfunction getEntityType(){
\t\t\t\tvar entitytype=Mura('input[name="entitytype"]:checked');
\t\t\t\tif(!entitytype.length){
\t\t\t\t\tentitytype=Mura('input[name="entitytype"]');
\t\t\t\t}
\t\t\t\treturn entitytype.val();
\t\t\t}

\t\t\tfunction handleEntityTypeChange(){
\t\t\t\tvar entitytype=getEntityType()
\t\t\t\tMura('.mura-related-ui').hide();
\t\t\t\tMura('.mura-related-ui__' + entitytype).show();
\t\t\t\tif(entitytype=='content' && Mura('#contentlocation2').is(':checked')){
\t\t\t\t\tMura('.mura-related-internal').hide();
\t\t\t\t}
\t\t\t}

\t\t\tMura('input[name="entitytype"]').click(handleEntityTypeChange);

\t\t\thandleEntityTypeChange();

\t\t\tvar relatedcontentsetid='`;

const RC_JS_C = `';

\t\t\tMura('.mura-related-ui_search').click(function(e){
\t\t\t\t\te.preventDefault();
\t\t\t\t\tvar entitytype=getEntityType()
\t\t\t\t\tvar valueSelector = '.mura-related-ui-input__'+ entitytype;
\t\t\t\t\tMura('#mura-rc-quickedit').hide();
\t\t\t\t\tsiteManager.loadRelatedContent(contentid,siteid, 0, $(valueSelector).serialize(), false,true,relatedcontentsetid);
\t\t\t})

\t\t});
\t</script>

\t`;

/** A related content set of a subtype (extendRelatedContentSetBean values), as the related-content views read it. */
export type RelatedContentSetView = Pick<ExtendRcsetRow, 'relatedcontentsetid' | 'name' | 'entitytype' | 'availablesubtypes'> & {
  /** `getDisplayName()`: the entity registry's display name of the set's entity type; read for non-content sets. */
  displayName: string;
};

/** The Default set `extendSubType.getRelatedContentSets()` lists after a subtype's own sets (extendSubType.cfc:580). */
export const DEFAULT_RELATED_CONTENT_SET: Readonly<RelatedContentSetView> = Object.freeze({
  relatedcontentsetid: '00000000000000000000000000000000000',
  name: 'Default',
  entitytype: 'content',
  availablesubtypes: '',
  displayName: '',
});

/** A content row a related-content view prints, with `contentManager.getCrumbList(contentid, siteid)` (leaf first). */
export interface RelatedContentItem {
  contentid: string;
  siteid: string;
  type: string;
  subtype: string;
  crumbs: readonly ZoomCrumb[];
}

/** A related-content search row with the viewer's node verdict (`permUtility.getNodePerm(crumbs)`). */
export interface RelatedSearchItem extends RelatedContentItem {
  verdict: NodePerm;
}

/** An item of a non-content entity: its primary key value, entity name and `getListViewProps()` values as text. */
export interface RelatedEntityItem {
  id: string;
  entityName: string;
  listViewValues: readonly string[];
}

/** The request and data loadrelatedcontent.cfm reads. */
export interface LoadRelatedContentModel {
  /** `rc.siteid`. */
  siteId: string;
  /** `rc.isNew` (default 1): true prints the search form only. */
  isNew: boolean;
  keywords: string;
  searchTypeSelector: string;
  /** `rc.relatedcontentsetid`. */
  relatedContentSetId: string;
  rcStartDate: string;
  rcEndDate: string;
  rcCategoryId: string;
  /** `rc.external` (default true). */
  external: boolean;
  /** `rc.entitytype` (default `content`). */
  entityType: string;
  /** `getRelatedContentSets()` of the `rc.contenthistid` version's subtype (Page/Default when none is sent). */
  relatedContentSets: readonly RelatedContentSetView[];
  /** `classExtensionManager.getSubTypes(siteid, activeOnly=true)`, ordered by type and subtype. */
  subTypes: readonly SubTypeView[];
  /** The site's category pool tree, each level ordered by name. */
  categories: readonly CategoryNode[];
  /** `getSite(siteid).getContentPoolID()`. */
  contentPoolId: string;
  /** `getSite(id).getSite()` of the request site and of each content-pool site. */
  siteNames: Readonly<Record<string, string>>;
  /** Not new, content: the request site's feed rows (at most 100, by lastupdate descending). */
  results?: readonly RelatedSearchItem[];
  /** Not new, content, with keywords: the feed rows of every other content-pool site, keyed by site id. */
  poolResults?: Readonly<Record<string, readonly RelatedSearchItem[]>>;
  /** Not new, other entity type: the feed iterator's record count and items. */
  entityResults?: { recordCount: number; items: readonly RelatedEntityItem[] };
  customIcons: CustomIconLookup;
}

const BASE_TYPES: readonly string[] = ['Page', 'Folder', 'Calendar', 'Gallery', 'File', 'Link'];

/** CFML struct lookup of a site name; an unknown site fails as a missing struct key would. */
function siteNameOf(names: Readonly<Record<string, string>>, siteId: string): string {
  const name = Object.entries(names).find(([id]) => cfEq(id, siteId))?.[1];
  if (name === undefined) throw new RangeError(`No site name for ${siteId}.`);
  return name;
}

/** The result rows of one site (loadrelatedcontent.cfm:422-441, 458-477); `depth` is the cfoutput's tab depth. */
function relatedSearchRows(
  o: CfmlOutput,
  rows: readonly RelatedSearchItem[],
  depth: number,
  model: LoadRelatedContentModel,
  noResults: string,
): void {
  const tabs = (n: number): string => '\t'.repeat(n);
  let started = false;
  for (const row of rows.slice(0, 100)) {
    o.ws().ws();
    if (row.verdict !== 'none') {
      started = true;
      o.text(`\n${tabs(depth + 1)}\n${tabs(depth + 2)}<li class="item" data-content-type="`).value(attr(`${row.type}/${row.subtype}`));
      o.text('" data-contentid="').value(row.contentid).text(`">\n${tabs(depth + 3)}<button class="btn mura-rc-quickoption" type="button" value="`);
      o.value(row.contentid).text('"><i class="mi-plus"></i></button>  ').value(renderZoomNoLinks(row.crumbs, model.customIcons));
      o.text(`\n${tabs(depth + 2)}</li>\n${tabs(depth + 1)}`);
    }
    o.ws();
  }
  o.ws();
  if (!started) o.ws().text(`\n${tabs(depth + 2)}<li class="item">`).value(noResults).text(`</li>\n${tabs(depth + 1)}`).ws();
}

/** `(1-<shown> of <count>)` after the results heading, printed only when the feed returned rows. */
function resultCount(o: CfmlOutput, count: number): void {
  if (count > 0) o.text('(1-').value(String(Math.min(count, 100))).text(' of ').value(String(count)).text(')');
}

/** The search form (loadrelatedcontent.cfm:107-319). */
function relatedContentForm(o: CfmlOutput, model: LoadRelatedContentModel, ctx: AdminRenderContext): void {
  const key = (k: string): string => ctx.labels.key(k);
  const rc = (k: string): string => key(`sitemanager.content.relatedcontent.${k}`);
  const sets = model.relatedContentSets;
  o.text(RC_JS_A).value(js(rc('newcontentvalidation'))).text(RC_JS_B).value(js(model.relatedContentSetId)).text(RC_JS_C);

  // The quirk compares set ids, not entity types, with 'content'; ACF leaves the loop index one past the last set.
  const first = sets.findIndex((s) => !cfEq(s.relatedcontentsetid, 'content'));
  const hasNonstandardContent = first >= 0;
  if (hasNonstandardContent && sets.length > 1) {
    o.text('\n\t\t<div class="mura-control-group">\n\t\t\t<label>Which type of content do you want related?</label>');
    o.text('\n\t\t\t<label class="radio inline"><input type="radio" name="entitytype" value="content"');
    if (cfEq(model.entityType, 'content')) o.text(' checked="true"');
    o.text('/>Site Content</label>\n\t\t\t').ws();
    const found = new Set<string>();
    for (const set of sets) {
      const type = set.entitytype ?? '';
      o.ws();
      if (!cfEq(type, 'content') && !found.has(type.toLowerCase())) {
        found.add(type.toLowerCase());
        o.ws().text('\n\t\t\t\t<label class="radio inline"><input type="radio" name="entitytype" value="').value(attr(type)).text('"');
        if (cfEq(model.entityType, type)) o.text(' checked="true"');
        o.text('/>').value(html(set.displayName)).text('</label>\n\t\t\t\t');
      }
      o.ws();
    }
    o.text('\n\t\t</div>\n\t');
  } else {
    const set = sets[hasNonstandardContent ? first : sets.length];
    if (set === undefined) throw new RangeError(`The element at position ${sets.length + 1} cannot be found.`);
    o.text('\n\t\t<input type="hidden" name="entitytype" value="').value(attr(set.entitytype ?? '')).text('"/>\n\t');
  }
  o.ws().ws();
  const searchable = new Set<string>();
  for (const set of sets) {
    const type = set.entitytype ?? '';
    o.ws();
    if (!cfEq(type, 'content') && !searchable.has(type.toLowerCase())) {
      searchable.add(type.toLowerCase());
      o.ws().text('\n\t\t\t<div class="mura-control-group mura-related-ui mura-related-ui__').value(attr(type));
      o.text('" style="display:none;"">\n\t\t\t\t<label>Keyword Search</label>\n\t\t\t\t<div  class="mura-control justify">');
      o.text('\n\t\t\t\t\t\t<div class="mura-input-set pull-left">\n\t\t\t\t\t\t<input type="text" class="mura-related-ui-input__');
      o.value(attr(type)).text('" name="keywords" value="').value(attr(model.keywords)).text('" placeholder="Keywords"/>');
      o.text('\n\t\t\t\t\t\t<button type="button" class="mura-related-ui_search" name="btnSearch" class="btn"><i class="mi-search"></i></button>');
      o.text('\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t');
    }
    o.ws();
  }
  o.text('\n\n\n\t<div class="mura-related-ui mura-related-ui__content" style="display:none;">\n\t\t');
  if (model.external) {
    const where = rc('whereistherelatedcontent');
    o.text('\n\t\t\t<div class="mura-control-group" >\n\t\t\t\t<label>\n\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"');
    o.text('\n\t  \t\t\tdata-content="').value(attr(key('tooltip.addrelatedcontent'))).text('"\n\t  \t\t\tdata-original-title="');
    o.value(attr(where)).text('">\n\t\t\t  \t').value(where).text(' <i class="mi-question-circle"></i></span>\n\t\t\t\t</label>');
    o.text('\n\t\t\t\t\t<label class="radio inline"><input type="radio" onclick="toggleRelatedType(this)" id="contentlocation1"');
    o.text(' name="contentlocation" value="internal" checked="true"/>').value(rc('inthissite')).text('</label>');
    o.text('\n\t\t\t\t\t<label class="radio inline"><input type="radio" onclick="toggleRelatedType(this)" id="contentlocation2"');
    o.text(' name="contentlocation" value="external"/>').value(rc('onanothersite')).text('</label>\n\t\t\t</div>\n\t\t\t');
  }
  o.text('\n\n\t\t\t<div class="mura-control-group mura-related-internal">\n\t\t\t\t<label>').value(rc('inthissite'));
  o.text('</label>\n\t\t\t\t<div id="internalContent" class="mura-control justify">\n\t\t\t\t\t\t<div class="mura-input-set pull-left">');
  o.text('\n\t\t\t\t\t\t<input type="text" name="keywords" value="').value(attr(model.keywords)).text('" id="rcSearch" placeholder="');
  o.value(key('sitemanager.content.fields.searchforcontent')).text('"/>');
  o.text('\n\t\t\t\t\t\t<button type="button" name="btnSearch" id="rcBtnSearch" class="btn"><i class="mi-search"></i></button>');
  o.text('\n\t\t\t\t\t</div>\n\t\t\t\t\t<a href="#" class="btn pull-left" id="aAdvancedSearch" data-toggle="button">').value(rc('advancedsearch'));
  o.text('</a>\n\t\t\t\t</div>\n\t\t\t</div>\n\n\t\t\t<div class="mura-related-internal">\n\t\t\t\t<div id="rcAdvancedSearch" style="display:none;">');
  o.text('\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t');
  if (!cfEq(model.relatedContentSetId, 'calendar')) {
    o.text('\n\n\t\t\t\t\t\t\t<label>').value(rc('contenttype')).text('</label>\n\t\t\t\t\t\t\t<select name="searchTypeSelector" id="searchTypeSelector">');
    o.text('\n\t\t\t\t\t\t\t\t<option value="">').value(rc('all')).text('</option>\n\t\t\t\t\t\t\t\t');
    for (const type of BASE_TYPES) {
      const label = key(`sitemanager.content.type.${type.toLowerCase()}`);
      // Query of queries compares type case-sensitively; a NULL adminonly passes adminonly!=1.
      const subTypes = model.subTypes.filter(
        (r) => r.type === type && r.subtype !== 'Default' && r.subtype !== 'default' && r.adminonly !== 1,
      );
      o.ws().text('\n\t\t\t\t\t\t\t\t\t<option value="').value(type).text('^Default"');
      if (cfEq(model.searchTypeSelector, `${type}^Default`)) o.text(' selected="selected"');
      o.text('>').value(label).text('</option>\n\t\t\t\t\t\t\t\t\t');
      if (subTypes.length > 0) {
        o.ws();
        for (const row of subTypes) {
          const subtype = row.subtype ?? '';
          o.text('\n\t\t\t\t\t\t\t\t\t\t\t<option value="').value(type).text('^').value(subtype).text('"');
          if (cfEq(model.searchTypeSelector, `${type}^${subtype}`)) o.text(' selected="selected"');
          o.text('>').value(label).text('  / ').value(subtype).text('</option>\n\t\t\t\t\t\t\t\t\t\t');
        }
        o.ws();
      }
      o.ws();
    }
    o.text('\n\t\t\t\t\t\t\t</select>\n\n\t\t\t\t\t\t');
  }
  o.text('\n\t\t\t\t\t</div>\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>').value(rc('releasedaterange'));
  o.text('</label>\n\t\t\t\t\t<div class="mura-control-inline">\n\t\t\t\t\t\t<label>').value(key('params.from')).text('</label>');
  o.text('\n\t\t\t\t\t\t<input type="text" name="rcStartDate" id="rcStartDate" class="datepicker mura-relatedContent-datepicker" placeholder="');
  o.value(attr(rc('startdate'))).text('" value="').value(attr(model.rcStartDate)).text('" />\n\t\t\t\t\t\t<label>').value(key('params.to'));
  o.text('</label>\n\t\t\t\t\t\t <input type="text" name="rcEndDate" id="rcEndDate" class="datepicker mura-relatedContent-datepicker" placeholder="');
  o.value(rc('enddate')).text('" value="').value(attr(model.rcEndDate)).text('" />\n\t\t\t\t\t</div>\n\t\t\t\t</div>');
  o.text('\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<div class="mura-control justify">\n\t\t\t\t\t\t<label>');
  o.value(rc('availablecategories')).text('</label>\n\t\t\t\t\t\t<div id="mura-list-tree">\n\t\t\t\t\t\t\t');
  o.value(renderCategoriesNest(model.categories, model.rcCategoryId, 0));
  o.text('\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>');
  o.text('\n\t\t<div class="mura-control-inline mura-related-external" style="display:none;">\n\t\t\t\t<label>').value(rc('title'));
  o.text('</label>\n\t\t\t\t<input type="text" id="mura-related-title" value="">\n\t\t\t\t<label>').value(rc('url'));
  o.text('</label>\n\t\t\t\t<input type="text" id="mura-related-url" value="" placeholder="http://www.example.com">');
  o.text('\n\t\t\t\t<button type="button" name="btnCreateLink" id="rcBtnCreateLink" class="btn" onclick="createExternalLink();">');
  o.text('<i class="mi-plus-circle"></i></button>\n\t\t</div>\n\n\t\t<div class="mura-related-external" style="display:none;">');
  o.text('\n\t\t\t<div class="draggableContainmentExternal mura-control-group" style="display:none;">\n\t\t\t\t<div class="list-table search-results">');
  o.text('\n\t\t\t\t\t<div class="list-table-content-set">').value(rc('availableurls')).text('</label></div>');
  o.text('\n\t\t\t\t\t<ul class="rcDraggable list-table-items"></ul>\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>\n\t</div>\n');
}

/** The search results (loadrelatedcontent.cfm:322-528). */
function relatedContentResults(o: CfmlOutput, model: LoadRelatedContentModel, ctx: AdminRenderContext): void {
  const key = (k: string): string => ctx.labels.key(k);
  const heading = key('sitemanager.content.relatedcontent.searchresults');
  const noResults = key('sitemanager.noresults');
  o.ws().ws();
  if (cfEq(model.entityType, 'content')) {
    // contentPoolSiteIDs without the first case-sensitive match of the request site.
    const poolIds = cfListToArray(model.contentPoolId);
    const own = poolIds.indexOf(model.siteId);
    if (own >= 0) poolIds.splice(own, 1);
    const hasPool = own >= 0 ? poolIds.length > 0 : model.contentPoolId !== '';
    const rows = model.results ?? [];
    o.text('\n\t\t<div class="mura-control-group mura-related-internal mura-related-ui mura-related-ui__content">\n\t\t\t');
    o.text('\n\t\t\t\t<div class="draggableContainmentInternal list-table search-results">\n\t\t\t\t\t<div class="list-table-content-set">');
    o.text('\n\t\t\t\t\t\t');
    if (hasPool) o.value(siteNameOf(model.siteNames, model.siteId)).text(':');
    o.ws().value(heading).ws();
    resultCount(o, rows.length);
    o.text('\n\t\t\t\t\t</div>\n\t\t\t\t\t<ul class="rcDraggable list-table-items">\n\t\t\t\t\t\t');
    relatedSearchRows(o, rows, 6, model, noResults);
    o.text('\n\t\t\t\t\t</ul>\n\t\t\t</div>\n\n\t\t\t\n\t\t\t');
    for (const poolSiteId of poolIds) {
      o.ws().ws();
      if (!cfEq(poolSiteId, model.siteId) && model.keywords !== '') {
        const poolRows = Object.entries(model.poolResults ?? {}).find(([id]) => cfEq(id, poolSiteId))?.[1];
        if (poolRows === undefined) throw new RangeError(`No related content search results for site ${poolSiteId}.`);
        o.ws().ws().text('\n\n\t\t\t\t\t<div class="draggableContainmentInternal list-table search-results">');
        o.text('\n\t\t\t\t\t\t<div class="list-table-content-set">\n\t\t\t\t\t\t\t').value(siteNameOf(model.siteNames, poolSiteId));
        o.text(':\n\t\t\t\t\t\t\t').value(heading).ws();
        resultCount(o, poolRows.length);
        o.text('\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t<ul class="rcDraggable list-table-items">\n\t\t\t\t\t\t\t');
        relatedSearchRows(o, poolRows, 7, model, noResults);
        o.text('\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\t\t\t\t');
      }
      o.ws();
    }
    o.text('\n\t\t</div>\n\t');
  } else {
    const { recordCount, items } = model.entityResults ?? { recordCount: 0, items: [] };
    o.ws().ws().text('\n\n\t\t<div class="mura-control-group mura-related-ui mura-related-ui__').value(attr(model.entityType));
    o.text('">\n\t\t\t\n\t\t\t\t<div class="draggableContainmentInternal list-table search-results">');
    o.text('\n\t\t\t\t\t<div class="list-table-content-set">\n\t\t\t\t\t\t\t').value(heading).ws();
    resultCount(o, recordCount);
    o.text('\n\t\t\t\t\t</div>\n\t\t\t\t\t<ul class="rcDraggable list-table-items">\n\t\t\t\t\t\t');
    if (items.length > 0) {
      o.ws();
      for (const item of items) {
        o.ws().ws();
        o.text('\n\t\t\t\t\t\t\t\t<li class="item" data-content-type="custom/').value(attr(model.entityType)).text('" data-contentid="');
        o.value(item.id).text('">\n\t\t\t\t\t\t\t\t\t<button class="btn mura-rc-quickoption" type="button" value="').value(item.id);
        o.text('"><i class="mi-plus"></i></button>\n\t\t\t\t\t\t\t\t\t<i class="mi-cog"></i> ');
        item.listViewValues.forEach((value, i) => {
          if (i > 0) o.text(', ');
          o.value(html(value));
        });
        o.text('\n\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t');
      }
      o.ws();
    } else {
      o.text('\n\t\t\t\t\t\t\t\t<li class="item">').value(noResults).text('</li>\n\t\t\t\t\t\t');
    }
    o.text('\n\t\t\t\t\t</ul>\n\t\t\t</div>\n\t\t\t').ws();
  }
  o.ws();
}

/** `carch.loadrelatedcontent` (loadrelatedcontent.cfm): the search form, plus the results when `isNew` is false. */
export function renderLoadRelatedContent(model: LoadRelatedContentModel, ctx: AdminRenderContext): AdminFragment {
  const o = new CfmlOutput();
  relatedContentForm(o, model, ctx);
  o.ws();
  if (!model.isNew) relatedContentResults(o, model, ctx);
  return fragment(o.ws());
}

// --- carch.loadselectedrelatedcontent ---

/** An entry of `rc.relateditems`: a content id the route loads, or a row the client sent (keys lower-cased). */
export type RelatedItemRef = { contentId: string } | { row: Readonly<Record<string, unknown>> };

/** `rc.relateditems` as loadselectedrelatedcontent.cfm:52-59 reads it: a JSON array, else a list of content ids. */
export function relatedItemsOf(raw: string): RelatedItemRef[] {
  const parsed = parseJson(raw);
  let items: readonly unknown[];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed === undefined) items = cfListToArray(raw);
  else if (typeof parsed !== 'object' || parsed === null) items = cfListToArray(simpleText(parsed));
  else throw new TypeError(`${raw} cannot be converted to a list.`);
  return items.map((item): RelatedItemRef => {
    if (item === null || typeof item !== 'object') return { contentId: simpleText(item) };
    return { row: Object.fromEntries(Object.entries(item).map(([k, v]): [string, unknown] => [k.toLowerCase(), v])) };
  });
}

/** The request and data loadselectedrelatedcontent.cfm reads. */
export interface LoadSelectedRelatedContentModel {
  /** `rc.relatedcontentsetid`: '' lists every set, `custom`/`calendar` the ad-hoc set, a matching id that set alone. */
  relatedContentSetId: string;
  /** `getRelatedContentSets()` of the subtype `rc.type`/`rc.subtype`. */
  relatedContentSets: readonly RelatedContentSetView[];
  /** `getContentID()` of the version `rc.contenthistid` loads ('' when none). */
  contentId: string;
  /** `getRelatedContentQuery(contenthistid)` rows of each content set by set id; an absent id has no rows. */
  relatedContent: Readonly<Record<string, readonly RelatedContentItem[]>>;
  /** The ad-hoc set's rows: {@link relatedItemsOf} entries that exist, in order, with their crumbs. */
  relatedItems: readonly RelatedContentItem[];
  /** `getRelatedContentIterator(relatedContentSetID)` items of each non-content set by set id; absent ids have none. */
  relatedEntities: Readonly<Record<string, readonly RelatedEntityItem[]>>;
  /** The content site's subtype rows, for the icons of each set's `availableSubTypes`. */
  subTypes: readonly SubTypeView[];
  customIcons: CustomIconLookup;
}

/** A per-set entry looked up as CFML struct keys are (case-insensitively); absent sets read as empty. */
function bySetId<T>(map: Readonly<Record<string, readonly T[]>>, setId: string): readonly T[] {
  return Object.entries(map).find(([id]) => cfEq(id, setId))?.[1] ?? [];
}

/** `carch.loadselectedrelatedcontent` (loadselectedrelatedcontent.cfm): each set's selected items, sortable. */
export function renderLoadSelectedRelatedContent(model: LoadSelectedRelatedContentModel, ctx: AdminRenderContext): AdminFragment {
  const key = (k: string): string => ctx.labels.key(k);
  const setId = model.relatedContentSetId;
  let sets: readonly RelatedContentSetView[] = model.relatedContentSets;
  const adHoc = cfEq(setId, 'custom') || cfEq(setId, 'calendar');
  if (adHoc) {
    // setName('Custom') is overwritten by setName('rc.entitytype'), so the literal string is the set's name.
    sets = [{ relatedcontentsetid: 'custom', name: 'rc.entitytype', entitytype: 'content', availablesubtypes: '', displayName: '' }];
  } else if (setId !== '') {
    const match = sets.find((s) => cfEq(s.relatedcontentsetid, setId));
    if (match !== undefined) sets = [match];
  }
  const noRelated = key('sitemanager.content.fields.norelatedcontent');
  const restricted = key('sitemanager.content.relatedcontent.restrictedmessage');
  const o = new CfmlOutput().text('\n\t<div id="mura-rc-quickedit" style="display:none;">\n\t\t<h3>');
  o.value(key('sitemanager.content.relatedcontent.relatedcontentsets')).text('</h3>');
  o.text(`\n\t\t<button class="btn" type="button" onclick="$('#mura-rc-quickedit').hide()"><i class="mi-times-circle"></i></button>`);
  o.text('\n\t\t<ul>\n\t\t');
  sets.forEach((set, index) => {
    const label = String(index + 1);
    o.ws().text('\n\t\t\t<li><input id="mura-rc-option-label').value(label).text('" type="checkbox" class="mura-rc-quickassign" value="');
    o.value(set.relatedcontentsetid).text('"/> <label for="mura-rc-option-label').value(label).text('">').value(html(set.name));
    o.text('</label></li>\n\t\t');
  });
  o.text('\n\t\t</ul>\n\t</div>\n\n\t');
  for (const set of sets) {
    const id = set.relatedcontentsetid;
    let emptyClass = 'item empty';
    o.ws().ws();
    if (cfEq(set.entitytype ?? '', 'content')) {
      const rows = adHoc ? model.relatedItems.filter((r) => !cfEq(r.contentid, model.contentId)) : bySetId(model.relatedContent, id);
      const available = set.availablesubtypes ?? '';
      o.ws().ws().ws().text('\n\n\t\t\t\t<div id="rcGroup-').value(id).text('" class="list-table">\n\t\t\t\t\t<div class="list-table-content-set">');
      o.value(html(set.name)).ws();
      if (available.length > 0) {
        o.text('\n\t\t\t\t\t\t\t<span class="content-type">').value(restricted).text(':\n\t\t\t\t\t\t\t\t');
        for (const subType of cfListToArray(available)) {
          const parts = cfListToArray(subType, '/');
          o.ws().text('\n\t\t\t\t\t\t\t\t\t<a href="#" rel="tooltip" data-original-title="').value(subType).text('"><i class="');
          o.value(subTypeIconClass(model.subTypes, parts[0] ?? '', parts.at(-1) ?? '')).text('"></i></a>\n\t\t\t\t\t\t\t\t');
        }
        o.text('\n\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t');
      }
      o.text('\n\t\t\t\t\t</div>\n\t\t\t\t\t<ul id="rcSortable-').value(id).text('" class="list-table-items rcSortable" data-accept="');
      o.value(available).text('" data-relatedcontentsetid="').value(id).text('">\n\t\t\t\t\t\t');
      if (rows.length > 0) {
        emptyClass += ' noShow';
        o.ws().ws();
        for (const row of rows) {
          o.ws().text('\n\t\t\t\t\t\t\t\t<li class="item" data-contentid="').value(row.contentid).text('" data-content-type="');
          o.value(row.type).text('/').value(row.subtype).text('">\n\t\t\t\t\t\t\t\t\t').value(renderZoomNoLinks(row.crumbs, model.customIcons));
          o.text('\n\t\t\t\t\t\t\t\t\t<a class="delete"></a>\n\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t');
        }
        o.ws();
      }
      o.text('\n\t\t\t\t \t\t<li class="').value(emptyClass).text('">\n\t\t\t\t\t\t\t<p>').value(noRelated);
      o.text('</p>\n\t\t\t\t\t\t</li>\n\t\t\t\t\t</ul>\n\t\t\t\t</div>\n\t\t\t');
    } else {
      const items = bySetId(model.relatedEntities, id);
      o.ws().ws().ws().text('\n\t\t\t\t\t<div id="rcGroup-').value(id).text('" class="list-table">\n\t\t\t\t\t\t<div class="list-table-content-set">');
      o.value(html(set.name)).text('\n\t\t\t\t\t\t\t<span class="content-type">').value(restricted);
      o.text(':\n\t\t\t\t\t\t\t\t\t<a href="#" rel="tooltip" data-original-title="').value(attr(set.displayName));
      o.text('"><i class="mi-cog"></i></a>\n\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t<ul id="rcSortable-').value(id);
      o.text('" class="list-table-items rcSortable" data-accept="custom/').value(attr(set.entitytype ?? ''));
      o.text('" data-relatedcontentsetid="').value(id).text('">\n\t\t\t\t\t\t\t');
      if (items.length > 0) {
        emptyClass += ' noShow';
        o.ws().ws();
        for (const item of items) {
          o.ws().ws().text('\n\t\t\t\t\t\t\t\t\t<li class="item" data-contentid="').value(item.id).text('" data-content-type="custom/');
          o.value(item.entityName).text('">\n\t\t\t\t\t\t\t\t\t<i class="mi-cog"></i> ');
          item.listViewValues.forEach((value, i) => {
            if (i > 0) o.text(', ');
            o.value(html(value));
          });
          o.text('\n\t\t\t\t\t\t\t\t\t\t<a class="delete"></a>\n\t\t\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t\t\t');
        }
        o.ws();
      }
      o.text('\n\t\t\t\t\t\t\t<li class="').value(emptyClass).text('">\n\t\t\t\t\t\t\t\t<p>').value(noRelated);
      o.text('</p>\n\t\t\t\t\t\t\t</li>\n\t\t\t\t\t\t</ul>\n\t\t\t\t\t</div>\n\n\t\t\t');
    }
    o.ws();
  }
  return fragment(o.ws());
}
