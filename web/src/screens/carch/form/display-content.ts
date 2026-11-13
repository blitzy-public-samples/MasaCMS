// The display and schedule controls of the content editor's Scheduling panel
// (admin/core/views/carch/form/dsp_displaycontent.cfm), server-only.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { lsDateFormatString, parseLegacyDate } from '@/lib/dates';
import { encodeHtmlAttr, raw, type SafeHtml } from '@/lib/html';
import { cfListGetAt } from '@/lib/resource-bundles/properties';
import { structOf, structText, structValue, type CarchStruct } from '../model';
import { cfListHas, datetimeSelector, type EditFormInput, type TagDate } from './custom-tags';

/** `getDisplayInterval().getAllValues()` as CFML simple values: numbers and booleans as their text. */
export interface DisplayIntervalValues {
  readonly type: string;
  readonly every: string;
  readonly repeats: string;
  readonly allday: string;
  readonly end: string;
  /** The end date as date text (`{ts '…'}`, ISO or a CFML date string), or `''`. */
  readonly endon: string;
  readonly endafter: string;
  readonly daysofweek: string;
  readonly detectconflicts: string;
  readonly detectspan: string;
  readonly timezone: string;
}

/** What the include reads from the edit screen model, the request and the legacy server. */
export interface DisplayContentModel {
  /** `rc.contentBean.getIsNew()`; `exists()` is its negation. */
  readonly isNew: boolean;
  /** `rc.contentBean.getDisplay()` before the include changes it. */
  readonly display: string;
  /** `rc.contentBean.getParent().getType()`. */
  readonly parentType: string;
  /** `rc.parentBean.getType()`. */
  readonly parentBeanType: string;
  /** `rc.type`. */
  readonly type: string;
  /** `$.event('bigui')`. */
  readonly bigui: string;
  readonly interval: DisplayIntervalValues;
  /** `rc.contentBean.getDisplayInterval(serialize=true)`. */
  readonly serializedInterval: string;
  /** `rc.contentBean.getDisplayStart(timezone=interval.timezone)`. */
  readonly displayStart: TagDate;
  /** `rc.contentBean.getDisplayStop(timezone=interval.timezone)`. */
  readonly displayStop: TagDate;
  /** `java.util.TimeZone.getDefault().getID()` of the legacy server. */
  readonly defaultTimeZone: string;
  /** `globalConfig('tzRegex')`. */
  readonly tzRegex: string;
  /** `TimeZone.getAvailableIDs()`; read only with a `tzRegex`. */
  readonly availableTimeZones: readonly string[];
}

/** The values the include derives before printing (dsp_displaycontent.cfm:77-119). */
export interface DisplayContentState {
  /** `rc.ptype` as the include leaves it. */
  readonly ptype: string;
  /** `rc.contentBean.getDisplay()` after the include's `setDisplay(2)`. */
  readonly display: string;
  /** The interval values after the include's `repeats`, `allday` and `endAfter` overrides. */
  readonly interval: DisplayIntervalValues;
}

/** The {@link EditFormInput} members the include reads. */
export type DisplayContentInput = Pick<EditFormInput, 'req' | 'data'> & {
  readonly ctx: Pick<EditFormInput['ctx'], 'rb' | 'now'>;
};

/** The include's markup and the `rc.ptype` it sets for the panels and hidden fields that follow. */
export interface DisplayContentResult {
  readonly html: SafeHtml;
  readonly ptype: string;
}

const REPEAT_TYPES = [
  'daily', 'weekly', 'bi-weekly', 'monthly', 'weekdays', 'weekends', 'week1', 'week2', 'week3', 'week4', 'weeklast',
  'yearly',
] as const;

const EVERY_LABELS: readonly (readonly [id: string, key: string])[] = [
  ['weeks', 'weeks'], ['months', 'months'], ['years', 'years'], ['days', 'days'], ['biweeks', 'bi-weeks'],
];

/** `struct[key]` as CFML text; throws when the model lacks it. */
function requiredText(struct: CarchStruct, key: string): string {
  if (structValue(struct, key) === undefined) throw new TypeError(`The content edit model has no ${key}`);
  return structText(struct, key);
}

/** A date the service sent as text, as the Date the tag reads; empty or unreadable text stays as given. */
function tagDate(text: string): TagDate {
  return parseLegacyDate(text) ?? text;
}

/** The legacy server's default zone id: the model's, else the zone exported to this process as `TZ`. */
function serverTimeZone(rc: CarchStruct): string {
  const zone = structValue(rc, 'defaultTimeZone');
  if (typeof zone === 'string' && zone !== '') return zone;
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The include's inputs. `rc.contentBean` carries `display`, `isNew`, `displayInterval` (serialized) and, by method
 * name, `parent` (`getParent()`), `displayIntervalValues`, `displayStartInTimezone` and `displayStopInTimezone`;
 * `rc.parentBean` carries `type`; `rc.defaultTimeZone`, `rc.tzRegex` and `rc.availableTimeZones` are optional.
 * @throws TypeError When a value the include reads is missing.
 */
export function displayContentModel(input: DisplayContentInput): DisplayContentModel {
  const { rc } = input.data;
  const bean = structOf(rc, 'contentBean');
  const values = structOf(bean, 'displayIntervalValues');
  const value = (key: string): string => requiredText(values, key);
  const interval: DisplayIntervalValues = {
    type: value('type'),
    every: value('every'),
    repeats: value('repeats'),
    allday: value('allday'),
    end: value('end'),
    endon: value('endon'),
    endafter: value('endafter'),
    daysofweek: value('daysofweek'),
    detectconflicts: value('detectconflicts'),
    detectspan: value('detectspan'),
    timezone: value('timezone'),
  };
  const tzRegex = structText(rc, 'tzRegex');
  const zones = structValue(rc, 'availableTimeZones');
  // A tzRegex prints the zone select, as legacy does; its zones only the legacy server knows, so none is an error.
  if (tzRegex !== '' && !Array.isArray(zones)) {
    throw new TypeError('The content edit model has a tzRegex but no availableTimeZones');
  }
  return {
    isNew: cfToBoolean(structValue(bean, 'isNew')),
    display: requiredText(bean, 'display'),
    parentType: requiredText(structOf(bean, 'parent'), 'type'),
    parentBeanType: requiredText(structOf(rc, 'parentBean'), 'type'),
    type: input.req.rc.type ?? '',
    bigui: input.req.rc.bigui ?? '',
    interval,
    serializedInterval: requiredText(bean, 'displayInterval'),
    displayStart: tagDate(requiredText(bean, 'displayStartInTimezone')),
    displayStop: tagDate(requiredText(bean, 'displayStopInTimezone')),
    defaultTimeZone: serverTimeZone(rc),
    tzRegex,
    availableTimeZones: Array.isArray(zones) ? zones.map(String) : [],
  };
}

/** `rc.ptype`, the forced display of a new Calendar child and the interval overrides. */
export function displayContentState(model: DisplayContentModel): DisplayContentState {
  const calendarChild = model.isNew && cfEq(model.parentBeanType, 'Calendar');
  const ptype = calendarChild ? 'Calendar' : model.parentType;
  const isCalendar = cfEq(ptype, 'Calendar');
  let { repeats, allday, endafter } = model.interval;
  if (isCalendar && model.isNew) {
    repeats = '0';
    allday = '1';
  } else if (model.isNew && !isCalendar) {
    repeats = '0';
    allday = '0';
  }
  if (cfEq(endafter, '0')) endafter = '1';
  const display = calendarChild ? '2' : model.display;
  return { ptype, display, interval: { ...model.interval, repeats, allday, endafter } };
}

/**
 * The Ends label: ACF 2023 `ReReplace(text, "\b(\w)", "\u\1", "ALL")`, which prints `\u` as a literal `u` before each
 * ASCII word start rather than upper-casing it (`ends` → `uends`).
 */
export function endsLabel(text: string): string {
  return text.replace(/\b(\w)/g, 'u$1');
}

const selected = (on: boolean): string => (on ? ' selected' : '');
const checked = (on: boolean): string => (on ? ' checked' : '');

/** The time zone select of a site with a `tzRegex`, or the hidden default zone (dsp_displaycontent.cfm:148-171). */
function timeZoneField(
  model: DisplayContentModel,
  interval: DisplayIntervalValues,
  key: (k: string) => string,
): string {
  const defaultTZ = model.defaultTimeZone;
  if (model.tzRegex === '') {
    return `\n\t\t\t\t\t\t<input type="hidden" name="displayIntervalTZ" id="displayIntervalTZ" value="${defaultTZ}">\n\t\t\t\t\t`;
  }
  const pattern = new RegExp(model.tzRegex);
  const zoneSelected = (zone: string): string => (cfEq(zone, interval.timezone) ? ' selected ' : '');
  let options = '';
  for (const zone of [...model.availableTimeZones].sort()) {
    if (!cfEq(zone, defaultTZ) && pattern.test(zone)) {
      options += `\n\t\t\t\t\t\t\t\t\t<option value="${zone}"${zoneSelected(zone)}>${zone}</option>\n\t\t\t\t\t\t\t\t`;
    }
  }
  return `
\t\t\t\t\t<div id="mura-tz-container" class="mura-control-group span4" style="display:none">
\t\t\t\t\t\t<label>${key('sitemanager.content.fields.displayinterval.timezone')}</label>
\t\t\t\t\t\t
\t\t\t\t\t\t<select name="displayIntervalTZ" id="displayIntervalTZ" class="mura-repeat-option">
\t\t\t\t\t\t\t<option value="${defaultTZ}"${zoneSelected(defaultTZ)}>
\t\t\t\t\t\t\t\t${key('sitemanager.content.fields.default')} (${defaultTZ})
\t\t\t\t\t\t\t</option>
\t\t\t\t\t\t\t${options}
\t\t\t\t\t\t</select>
\t\t\t\t\t</div>
\t\t\t\t\t`;
}

/** The all-day checkbox of a Calendar child, else its hidden `0` (dsp_displaycontent.cfm:177-187). */
function allDayField(isCalendar: boolean, interval: DisplayIntervalValues, key: (k: string) => string): string {
  if (!isCalendar) {
    return `
\t\t\t\t\t\t\t<div>
\t\t\t\t\t\t\t\t<input type="hidden" id="displayIntervalAllDay" name="displayIntervalllDay" value="0"/>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t`;
  }
  // The `displayIntervalllDay` name typo is legacy's.
  return `
\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t<label class="checkbox" for="displayIntervalAllDay">
\t\t\t\t\t\t\t\t\t<input type="checkbox" id="displayIntervalAllDay" name="displayIntervalllDay" value="1" ${checked(cfToBoolean(interval.allday))}/>&nbsp;&nbsp;${key('sitemanager.content.fields.displayinterval.allday')}
\t\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t`;
}

/** The repeats radios, the repeat type, interval and units, and the days of week (dsp_displaycontent.cfm:190-233). */
function repeatFields(interval: DisplayIntervalValues, key: (k: string) => string): string {
  const repeats = cfToBoolean(interval.repeats);
  const label = (k: string): string => key(`sitemanager.content.fields.displayinterval.${k}`);
  let types = '';
  for (const type of REPEAT_TYPES) {
    const name = key(`sitemanager.content.fields.displayInterval.${type}`);
    types += `\n\t\t\t\t\t\t\t\t<option value="${type}"${selected(cfEq(interval.type, type))}>${name}</option>\n\t\t\t\t\t\t\t\t`;
  }
  const units = EVERY_LABELS.map(
    ([id, k]) =>
      `\t\t\t\t\t\t\t<span class="mura-interval-every-label" id="mura-interval-every-label-${id}" style="display:none">${label(k)}</span>\n`,
  ).join('');
  const dayLabels = key('calendar.weekdayAbrev');
  let days = '';
  for (let day = 1; day <= 7; day += 1) {
    days += `\t\t\t\t\t\t\t<label class="checkbox inline"><input class="mura-repeat-option" id="dow${day}" name="displayIntervalDays" type="checkbox" value="${day}"${checked(cfListHas(interval.daysofweek, String(day)))}/> ${cfListGetAt(dayLabels, day)}</label>\n`;
  }
  return `
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label style="display:none;" for="displayIntervalRepeats" class="checkbox">
\t\t\t\t\t\t\t<input type="checkbox" class="mura-repeat-option" id="displayIntervalRepeats" value="1" name="displayIntervalRepeats"${checked(repeats)} >
\t\t\t\t\t\t</label>

\t\t\t\t\t\t<label class="radio inline"><input type="radio" id="repeatsRadioYes" name="repeatsRadio" value="yes"${checked(repeats)}>${label('repeats')}</label>
\t\t\t\t\t\t<label class="radio inline"><input type="radio" id="repeatsRadioNo" name="repeatsRadio" value="no"${checked(!repeats)}>Does not repeat</label>
\t\t\t\t\t</div>
\t\t\t\t\t

\t\t\t\t\t
\t\t\t\t\t<div class="mura-repeat-options mura-control-group" style="display:none">
\t\t\t\t\t\t<div class="mura-control-inline">
\t\t\t\t\t\t\t<select id="displayIntervalType" name="displayIntervalType" class="mura-repeat-option">
\t\t\t\t\t\t\t\t${types}
\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t\t<label class="time-repeat">
\t\t\t\t\t\t\t&nbsp;${label('every')}</label>
\t\t\t\t\t\t\t<input type="text" id="displayIntervalEvery" name="displayIntervalEvery" value="${encodeHtmlAttr(interval.every)}" class="mura-repeat-option numeric" maxlength="4">

\t\t\t\t\t\t\t<label class="time-repeat">
${units}\t\t\t\t\t\t</label>
\t\t\t\t\t\t</div>
\t\t\t\t\t</div><!-- /mura-repeat-options -->

\t\t\t\t\t
\t\t\t\t\t
\t\t\t\t\t<div class="mura-daysofweek mura-control-group" style="display:none">
\t\t\t\t\t\t<label class="checkbox inline">${label('ondow')}: </label>
${days}\t\t\t\t\t</div>
\t\t\t\t\t

\t\t\t\t</div>`;
}

/** The conflict detection controls of a Calendar (dsp_displaycontent.cfm:261-279). */
function conflictFields(interval: DisplayIntervalValues, key: (k: string) => string): string {
  const detect = cfToBoolean(interval.detectconflicts);
  const months = key('sitemanager.content.fields.displayinterval.months');
  let spans = '';
  for (let month = 1; month <= 12; month += 1) {
    spans += `\n\t\t\t\t\t\t\t\t<option value="${month}"${selected(cfEq(String(month), interval.detectspan))}>\n\t\t\t\t\t\t\t\t${month}${months}\n\t\t\t\t\t\t\t\t</option>\n\t\t\t\t\t\t\t`;
  }
  // The span container is hidden while detection is on, as legacy prints it.
  return `
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label for="displayIntervalDetectConflicts" class="checkbox">
\t\t\t\t\t\t\t<input type="checkbox" class="mura-repeat-option" id="displayIntervalDetectConflicts" value="1" name="displayIntervalDetectConflicts"${checked(detect)}>&nbsp;&nbsp;${key('sitemanager.content.fields.displayinterval.detectconflicts')}
\t\t\t\t\t\t</label>
\t\t\t\t\t</div>

\t\t\t\t\t<div class="mura-control-group" id="mura-detectspan-container"${detect ? ' style="display:none;"' : ''}>
\t\t\t\t\t\t<label>${key('sitemanager.content.fields.displayinterval.for')}</label>
\t\t\t\t\t\t<select id="mura-detectspan" class="mura-repeat-option">
\t\t\t\t\t\t\t${spans}
\t\t\t\t\t\t</select>
\t\t\t\t\t</div>

\t\t\t\t`;
}

// The include's script text between the values the CFML prints into it, with legacy's `##` escapes as `#`.
const SCRIPT_TO_TIMEZONE = `
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
\t\t\t\trepeats: ($('#displayIntervalRepeats').is(':checked')) ? 1 : 0,
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

\t\t\ttoggleDailyEndTime();
\t\t}

\t\tfunction toggleDailyEndTime(){
\t\t\tvar repeats =  $('#displayIntervalRepeats').is(':checked');
\t\t\tvar type=$('#displayIntervalEnd').val();

\t\t//alert('toggling');

\t\t\tif (!isCalendar){

\t\t\t\tif (repeats){
\t\t\t\t\t$('#displayIntervalToLabel').show();
\t\t\t\t\t$('#mura-interval-end-on .mura-timeselectwrapper').insertAfter('#displayIntervalToLabel');
\t\t\t\t} else if (type='on' || type == 'never'){
\t\t\t\t\t$('#displayIntervalToLabel').hide();
\t\t\t\t\t$('#displayIntervalToLabel + .mura-timeselectwrapper').insertAfter('#mura-datepicker-displayStop');
\t\t\t\t}
\t\t\t}
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

\t\t\t\tif(type=='after'){
\t\t\t\t\t$('#mura-interval-end-after').show();
\t\t\t\t\tif ($('#displayIntervalEndAfter').val() == 0){
\t\t\t\t\t\t$('#displayIntervalEndAfter').val(1);
\t\t\t\t\t}
\t\t\t\t\tpushDisplayStopOut();
\t\t\t\t\tif(!$('#displayIntervalRepeats').is(':checked')){
\t\t\t\t\t\t$('#repeatsRadioYes').trigger('click');
\t\t\t\t\t\ttoggleRepeatCheckbox();
\t\t\t\t\t\ttoggleRepeatOptionsContainer();
\t\t\t\t\t\t$('#displayIntervalEnd').val('after');
\t\t\t\t\t}

\t\t\t\t} else if(type=='on'){
\t\t\t\t\t$('#mura-interval-end-on').show();
\t\t\t\t\t$('#displayIntervalEndAfter').val(0);

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
\t\t\t\t\t$('#displayIntervalEndAfter').val(0);
\t\t\t\t}
\t\t\t} else {
\t\t\t\tvar start=$('#mura-datepicker-displayStart');
\t\t\t\tvar stop=$('#mura-datepicker-displayStop');
\t\t\t\tstop.val(start.val()).trigger('change');
\t\t\t\t$('#displayIntervalEnd').val('on');
\t\t\t\t$('#displayIntervalEndAfter').val(0);
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

const SCRIPT_TO_DAY_PARTS = `');

\t\t\t\t`;

const SCRIPT_DAY_PARTS = `
\t\t\t\t\t$('#mura-displayStartHour').val('12');
\t\t\t\t\t$('#mura-displayStartMinute').val('0');
\t\t\t\t\t$('#mura-displayStartDayPart').val('AM');
\t\t\t\t\t$('#mura-displayStopHour').val('11');
\t\t\t\t\t$('#mura-displayStopMinute').val('59');
\t\t\t\t\t$('#mura-displayStopDayPart').val('PM');
\t\t\t\t`;

const SCRIPT_NO_DAY_PARTS = `
\t\t\t\t\t$('#mura-displayStartHour').val('0');
\t\t\t\t\t$('#mura-displayStartMinute').val('0');
\t\t\t\t\t$('#mura-displayStopHour').val('23');
\t\t\t\t\t$('#mura-displayStopMinute').val('59');
\t\t\t\t`;

const SCRIPT_TO_EVERY = `

\t\t\t} else if(isCalendar) {
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
\t\t\t\t$('#mura-displayStopHour').show();
\t\t\t\t$('#mura-displayStopMinute').show();
\t\t\t\t$('#mura-displayStopDayPart').show();
\t\t\t\t$('#displayIntervalToLabel').show();
\t\t\t\t$('#mura-tz-container').show();
\t\t\t}

\t\t\tupdateDisplayInterval();
\t\t}

\t\tfunction toggleRepeatOptionsContainer(){

\t\t\tif($('#displayIntervalRepeats').is(':checked')){
\t\t\t\t$('.mura-repeat-options').show();
\t\t\t\tsetDaysOfWeekDefault();
\t\t\t} else {
\t\t\t\t$('.mura-repeat-options').hide();
\t\t\t\t$('#displayIntervalType').val('daily');
\t\t\t\t$('#displayIntervalEvery').val(1);
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

\t\tfunction toggleRepeatCheckbox(){
\t\t\tif ($('#repeatsRadioYes').is(':checked')){
\t\t\t\tif (!$('#displayIntervalRepeats').is(':checked')){
\t\t\t\t\t$('#displayIntervalRepeats').trigger('click');
\t\t\t\t}
\t\t\t} else {
\t\t\t\tif ($('#displayIntervalRepeats').is(':checked')){
\t\t\t\t\t$('#displayIntervalRepeats').trigger('click');
\t\t\t\t}
\t\t\t}
\t\t}

\t\tfunction hideDefaultRepeats(){
\t\t\tvar stopHour = $('#mura-displayStopHour').val();
\t\t\tvar stopMin = $('#mura-displayStopMinute').val();
\t\t\tvar stopDaypart = $('#mura-displayStopDayPart').val();
\t\t\tvar intervalType = $('#displayIntervalType').val();
\t\t\tvar intervalEvery = $('#displayIntervalEvery').val();
\t\t\tvar intervalEnds = $('#displayIntervalEnd').val();
\t\t\tvar intervalEndsAfter = $('#displayIntervalEndAfter').val();

\t\t\tif ( (intervalEnds != 'after' || intervalEndsAfter < 2)
\t\t\t\t&& intervalType == 'daily' && intervalEvery == 1
\t\t\t\t&& (stopMin == 59 && (stopHour == 11 && stopDaypart == 'PM' || stopHour == 23))
\t\t\t\t){
\t\t\t\t\t$('#repeatsRadioNo').trigger('click');
\t\t\t\t\ttoggleRepeatCheckbox();
\t\t\t\t}
\t\t}

\t\t$('#mura-datepicker-displayStop').hide();
\t\t$('.mura-repeat-option').on('change',updateDisplayInterval);
\t\t$('#displayIntervalRepeats').click(toggleRepeatOptionsContainer);
\t\t$('#displayIntervalAllDay').click(toggleAllDayOptions);
\t\t$('#displayIntervalDetectConflicts').click(toggleDetectConflicts);
\t\t$('#displayIntervalType').on('change',toggleRepeatOptions);
\t\t$('#displayIntervalEnd').on('change',setEndOption);
\t\t$('#mura-datepicker-displayStart').change(setEndOption);
\t\t$('#repeatsRadioYes,#repeatsRadioNo').click(toggleRepeatCheckbox);

\t\thideDefaultRepeats();
\t\ttoggleRepeatOptionsContainer();
\t\ttoggleRepeatOptions();
\t\ttoggleAllDayOptions();
\t\tsetEndOption();
\t\ttoggleDetectConflicts();

\t})

\t// update selected datetime string

\tfunction showSelectedCS(){
\t\tvar csStr = $('#mura-datepicker-displayStart').val() + ' '
\t\t\t\t\t+ $('#mura-displayStartHour').val() + ':'
\t\t\t\t\t+ $('#mura-displayStartMinute option:selected').html() + ' '
\t\t\t\t\t+ $('#mura-displayStartDayPart option:selected').html() + '<br>';
\t\tif ( $('#displayIntervalRepeats').is(':checked')){
\t\t\tcsStr += 'repeating ';
\t\t\t\tif ($('#displayIntervalType').val() == 'daily'){
\t\t\t\t\tcsStr += '`;

const SCRIPT_TO_DAYS = `&nbsp;' + $('#displayIntervalEvery').val() + '&nbsp;`;

const SCRIPT_END = `';
\t\t\t\t} else {
\t\t\t\t\tcsStr += $('#displayIntervalType option:selected').html();
\t\t\t\t}
\t\t}

\t\tif ( $('#displayIntervalEnd').val() == 'on' && $('#displayIntervalEndOn').val() != ''  && $('#displayIntervalEndOn').val() != $('#mura-datepicker-displayStart').val()){
\t\t\tcsStr += ' until ' + $('#displayIntervalEndOn').val();
\t\t}
\t\telse if ( $('#displayIntervalEnd').val() == 'after'  && $('#displayIntervalEndAfter').val() >= 1){
\t\t\tcsStr += ' x ' + $('#displayIntervalEndAfter').val();
\t\t}

\t\tif ($('#mura-datepicker-displayStart').val() != ''){
\t\t\t$('#displayschedule-label').html(csStr);
\t\t}
\t}

\t$(document).ready(function(){
\t\t// run on page load
\t\tshowSelectedCS();
\t\t// run on change of any schedule element
\t\t$('#displayschedule-selector *, #displayIntervalEnd').on('change',function(){
\t\t\tshowSelectedCS();
\t\t})
\t});

\t</script>
</div>
</div>
`;

/** The include's inline script with the values the CFML prints into it (dsp_displaycontent.cfm:287-668). */
function scheduleScript(
  isCalendar: boolean,
  defaultTZ: string,
  localeHasDayParts: boolean,
  key: (k: string) => string,
): string {
  return (
    `\n\t\t\tvar isCalendar=${isCalendar ? 'true' : 'false'};\n\t\t` +
    SCRIPT_TO_TIMEZONE +
    defaultTZ +
    SCRIPT_TO_DAY_PARTS +
    (localeHasDayParts ? SCRIPT_DAY_PARTS : SCRIPT_NO_DAY_PARTS) +
    SCRIPT_TO_EVERY +
    key('sitemanager.content.fields.displayinterval.every') +
    SCRIPT_TO_DAYS +
    key('sitemanager.content.fields.displayinterval.days') +
    SCRIPT_END
  );
}

/**
 * `form/dsp_displaycontent.cfm`: the display select and the schedule editor, from the newline after `<cfoutput>`
 * through the closing `</div>` and its newline. Labels and values print unencoded except where legacy encodes them.
 * @throws TypeError When the edit model lacks a value the include reads.
 */
export function renderDisplayContent(input: DisplayContentInput): DisplayContentResult {
  const model = displayContentModel(input);
  const { ptype, display, interval } = displayContentState(model);
  const key = (k: string): string => input.ctx.rb.rbKey(k);
  const label = (k: string): string => key(`sitemanager.content.fields.displayinterval.${k}`);
  const isCalendar = cfEq(ptype, 'Calendar');
  const tagContext = { req: input.req, now: input.ctx.now };
  const stop = (): string =>
    datetimeSelector(tagContext, {
      name: 'displayStop',
      datetime: model.displayStop,
      defaulthour: 23,
      defaultminute: 59,
      timeselectwrapper: true,
    }).value;
  const start = datetimeSelector(tagContext, {
    name: 'displayStart',
    datetime: model.displayStart,
    timeselectwrapper: true,
  });
  const endOn = lsDateFormatString(interval.endon, input.req.session.dateKeyFormat, input.req.session.locale);
  const fieldsDisplay = key('sitemanager.content.fields.display');
  // ACF prints no whitespace-only text between two CFML tags here, as the output before each ends in whitespace.
  const html = `
<div class="mura-control-group">
\t<label>
\t\t<span data-toggle="popover" title="" data-placement="right"
\t  \tdata-content="${encodeHtmlAttr(key('tooltip.displayContent'))}"
\t  \tdata-original-title="${encodeHtmlAttr(fieldsDisplay)}">
  \t\t\t${fieldsDisplay}
  \t\t <i class="mi-question-circle"></i></span>
  \t</label>
\t\t<select name="display" id="mura-display" onchange="javascript: this.selectedIndex==2?toggleDisplay2('editDates',true):toggleDisplay2('editDates',false);">
\t\t\t
\t\t\t
\t\t<option value="1"  ${selected(cfEq(display, '1'))}>Always</option>
\t\t<option value="0"  ${selected(cfEq(display, '0'))}>Never</option>
\t\t<option value="2"  ${selected(cfEq(display, '2') || cfEq(model.bigui, 'schedule'))}>
\t\t\t${key('sitemanager.content.fields.perschedule')}
\t\t</option>
\t</select>

<div id="editDates"${cfEq(display, '2') ? '' : ' style="display: none;"'} class="mura-control justify">

\t

\t<div id="displayschedule-label"></div>

\t
\t
\t<div class="bigui" id="bigui__displayschedule" data-label="${encodeHtmlAttr('Manage Schedule')}">
\t\t<div class="bigui__title">${encodeHtmlAttr(label('schedule'))}</div>
\t\t\t<div class="bigui__controls">

\t\t\t\t<div id="displayschedule-selector">

\t\t\t\t\t
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label>Starts</label>
\t\t\t\t\t\t${start.value}

\t\t\t\t\t\t\t<label id="displayIntervalToLabel" class="time"${isCalendar ? '' : ' style=\n\t\t\t\t\t\t\tdisplay:none;"'}>${label('to')}</label>

\t\t\t\t\t\t${isCalendar ? stop() : ''}

\t\t\t\t\t</div>
\t\t\t\t\t

\t\t\t\t\t
\t\t\t\t\t
\t\t\t\t\t${timeZoneField(model, interval, key)}
\t\t\t\t\t<input type="hidden" name="displayInterval" id="displayInterval" value="${encodeHtmlAttr(model.serializedInterval)}">
\t\t\t\t\t<input name="convertDisplayTimeZone" type="hidden" value="true">
\t\t\t\t\t

\t\t\t\t\t
\t\t\t\t\t\t${allDayField(isCalendar, interval, key)}

\t\t\t\t\t${repeatFields(interval, key)}

\t\t\t\t
\t\t\t\t<div class="mura-control-group${isCalendar ? ' mura-repeat-options' : ''}"${isCalendar ? ' style="display:none;"' : ''}>
\t\t\t\t\t<label>${endsLabel(label('ends'))}</label>
\t\t\t\t\t<select id="displayIntervalEnd" name="displayIntervalEnd" class="mura-repeat-option time" style="margin-left: 0;">
\t\t\t\t\t\t<option value="never" ${selected(cfEq(interval.end, 'never'))}>${label('never')}</option>
\t\t\t\t\t\t<option value="on"${selected(cfEq(interval.end, 'on'))}>${label('on')}</option>
\t\t\t\t\t\t<option value="after"${selected(cfEq(interval.end, 'after'))}>${label('after')}</option>
\t\t\t\t\t</select>
\t\t\t\t\t\t<span class="mura-interval-end" id="mura-interval-end-after" style="display:none">
\t\t\t\t\t\t\t<input type="text" id="displayIntervalEndAfter" name="displayIntervalEndAfter" value="${encodeHtmlAttr(interval.endafter)}" class="mura-repeat-option numeric" size="3">
\t\t\t\t\t<label class="time-repeat">
\t\t\t\t\t\t\t${label('occurrences')}
\t\t\t\t\t</label>
\t\t\t\t\t\t</span>
\t\t\t\t\t\t<span class="mura-interval-end" id="mura-interval-end-on" style="display:none">
\t\t\t\t\t\t\t<input type="text" id="displayIntervalEndOn" name="displayIntervalEndOn" class="mura-repeat-option datepicker mura-datepickerdisplayIntervalEndOn" value="${endOn}" maxlength="12"/>
\t\t\t\t\t\t\t${isCalendar ? '' : stop()}
\t\t\t\t\t\t</span>
\t\t\t\t\t</div>
\t\t\t\t\t

\t\t\t\t${cfEq(model.type, 'Calendar') ? conflictFields(interval, key) : ''}

\t\t\t</div> \n\t\t</div>\n\t</div> \n\n<div>

\t<script>
\t$(function(){
\t\t${scheduleScript(isCalendar, model.defaultTimeZone, input.req.session.localeHasDayParts, key)}`;
  return { html: raw(html), ptype };
}
