// The content editor's Publishing panel, after `admin/core/views/carch/form/dsp_panel_publishing.cfm` (server-only).
import { cfEq, cfToBoolean, javaTrim } from '@opt2/platform/legacy-compat';
import { encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext, SiteData } from '@/lib/request-context';
import { ROOT_CONTENT_ID, structOf, structText, structValue, type CarchStruct } from '../model';
import { cfListHas, datetimeSelector, type DateTagContext, type EditFormInput, type PanelResult } from './custom-tags';

const OPERATION = 'strategies-content getContentEditModel';

/** `listFindNoCase` types with the release date, navigation, search, access and mobile options. */
const NODE_TYPES = 'Page,Folder,Calendar,Gallery,File,Link';
/** `listFindNoCase` types without the featured and force-SSL options. */
const NON_PAGE_TYPES = 'Component,Form,Variation';
/** `listFind` types with an expiration: case-sensitive, with the source's duplicate `Link`. */
const EXPIRES_TYPES = 'Page,Folder,Calendar,Gallery,Link,File,Link';

// ---- ACF output ----

const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one character. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/** ACF whitespace-managed output: a whitespace-only run prints one space after non-whitespace output, else nothing. */
class CfOutput {
  #out = '';

  /** One run of template text between two CFML tags or expressions. */
  text(run: string): void {
    if ([...run].every(isJavaWhitespace)) this.gap();
    else this.#out += run;
  }

  /** A whitespace-only run, or several in a row. */
  gap(): void {
    if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
  }

  /** An expression's or custom tag's output, verbatim. */
  value(output: string | SafeHtml): void {
    this.#out += String(output);
  }

  get markup(): string {
    return this.#out;
  }
}

// ---- Inputs ----

/** What one render reads: the include's `rc` values, `rc.contentBean`, the edit model and the session site. */
interface Scope {
  readonly input: EditFormInput;
  readonly dates: DateTagContext;
  /** The edit model's `rc`. */
  readonly model: CarchStruct;
  readonly bean: CarchStruct;
  readonly site: SiteData;
  readonly type: string;
  readonly contentId: string;
  readonly siteId: string;
  readonly contentHistId: string;
  readonly parentId: string;
  label(key: string): string;
}

/** `rc[name]` by case-insensitive name; throws when absent, as CFML does for an undefined `rc` key. */
function rcText(rc: RequestContext, name: string): string {
  const lower = name.toLowerCase();
  const key = Object.hasOwn(rc, name) ? name : Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = key === undefined ? undefined : rc[key];
  if (value === undefined) throw new TypeError(`rc.${name} is undefined for carch.edit`);
  return value;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The query rows the edit model holds under `key`; throws unless they are an array of structs. */
function rowsAt(model: CarchStruct, key: string): readonly CarchStruct[] {
  const value = structValue(model, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${OPERATION} returned no rc.${key} rows`);
  return value;
}

/** `application.contentUtility.getNotify(rc.crumbdata).recordCount`, which the edit model holds as `notifyCount`. */
function notifyCountOf(model: CarchStruct): number {
  const value = structValue(model, 'notifyCount');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${OPERATION} returned no rc.notifyCount record count`);
  }
  return value;
}

/** `rc.$.siteConfig().getContentRenderer().useLayoutManager()`, which the edit model holds as `useLayoutManager`. */
function useLayoutManagerOf(model: CarchStruct): boolean {
  const value = structValue(model, 'useLayoutManager');
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no rc.useLayoutManager`);
  return cfToBoolean(value);
}

const BOOLEAN_WORDS: ReadonlyMap<string, string> = new Map([
  ['true', '1'],
  ['yes', '1'],
  ['false', '0'],
  ['no', '0'],
]);

/** CFML `struct[key] eq other`, reading the boolean words as 1 and 0 as ACF compares them with numbers. */
function textEq(struct: CarchStruct, key: string, other: string): boolean {
  const value = structText(struct, key);
  return cfEq(BOOLEAN_WORDS.get(javaTrim(value).toLowerCase()) ?? value, other);
}

/** A CFML boolean bean value; throws for a value CFML cannot read as one. */
const beanFlag = (bean: CarchStruct, key: string): boolean => cfToBoolean(structText(bean, key));

const LOCAL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;

/** `#rc.contentBean.get<key>()#` in a tag attribute: a stored date-time as CFML prints it, other values as stored. */
function beanDateText(bean: CarchStruct, key: string): string {
  const value = structText(bean, key);
  const match = LOCAL_TIMESTAMP.exec(value);
  return match === null ? value : `{ts '${match[1] ?? ''} ${match[2] ?? ''}'}`;
}

/** `$.siteConfig('useSSL')`: `setUseSSL` also sets `extranetSSL`, which a NULL `useSSL` leaves as read. */
function siteUsesSsl(site: SiteData): boolean {
  const { useSSL, ExtranetSSL } = site.record;
  return (useSSL ?? ExtranetSSL ?? 0) !== 0;
}

/** The three `esapiEncode('javascript', …)` arguments of a notify loader call, joined by `','`. */
const jsArgs = (...values: readonly string[]): string => values.map(encodeJs).join("','");

// ---- Featured ----

/** Lines 120-163: the schedule controls' closing tags and the `showSelectedFeat` script. */
const FEATURE_SCHEDULE_END =
  `\n` +
  `\t\t\t\t\t\t\t\t\t</div>\n` +
  `\n` +
  `\t\t\t\t\t\t\t\t</div>\n` +
  `\t\t\t\t\t\t\t</div>\n` +
  `\t\t\t\t\t\t</div> \n` +
  `\n` +
  `\t\t\t\t\t</div>\n` +
  `\t\t\t\t</div> \n` +
  `\t\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t<script type="text/javascript">\n` +
  `\t\t\t\t\tfunction showSelectedFeat(){\n` +
  `\t\t\t\t\t\tvar featStr = '';\n` +
  `\t\t\t\t\t\tvar startDate = $('#mura-datepicker-featureStart').val();\n` +
  `\t\t\t\t\t\tvar stopDate = $('#mura-datepicker-featureStop').val();\n` +
  `\t\t\t\t\t\tif (startDate != ''){\n` +
  `\t\t\t\t\t\t\tvar featStr = startDate \n` +
  `\t\t\t\t\t\t\t+ ' ' + $('#mura-featureStartHour option:selected').html()\n` +
  `\t\t\t\t\t\t\t+ ':' + $('#mura-featureStartMinute option:selected').html()\n` +
  `\t\t\t\t\t\t\t+ ' ' + $('#mura-featureStartDayPart option:selected').html();\n` +
  `\t\n` +
  `\t\t\t\t\t\t\tif (stopDate != ''){\n` +
  `\t\t\t\t\t\t\t\tvar featStr = featStr +  ' to ' + stopDate \n` +
  `\t\t\t\t\t\t\t\t+ ' ' + $('#mura-featureStopHour option:selected').html()\n` +
  `\t\t\t\t\t\t\t\t+ ':' + $('#mura-featureStopMinute option:selected').html()\n` +
  `\t\t\t\t\t\t\t\t+ ' ' + $('#mura-featureStopDayPart option:selected').html();\n` +
  `\t\t\t\t\t\t\t}\n` +
  `\t\n` +
  `\t\t\t\t\t\t}\n` +
  `\n` +
  `\t\t\t\t\t\t$('#featureschedule-label').html(featStr);\n` +
  `\t\t\t\t\t}\n` +
  `\n` +
  `\t\t\t\t\t$(document).ready(function(){\n` +
  `\t\t\t\t\t\t// run on page load\n` +
  `\t\t\t\t\t\tsetTimeout(function(){\n` +
  `\t\t\t\t\t\t\tshowSelectedFeat();\n` +
  `\t\t\t\t\t\t}, 300);\n` +
  `\t\t\t\t\t\t// run on change of any schedule element\n` +
  `\t\t\t\t\t\t$('#featureschedule-selector *').on('change',function(){\n` +
  `\t\t\t\t\t\t\tshowSelectedFeat();\n` +
  `\t\t\t\t\t\t})\n` +
  `\t\t\t\t\t});\t\t\t\t\n` +
  `\t\t\t\t</script>\n` +
  `\n` +
  `\t\t\t`;

/** Featured options of `isFeature`, in source order. */
const FEATURE_OPTIONS: ReadonlyArray<readonly [value: string, labelKey: string]> = [
  ['0', 'sitemanager.no'],
  ['1', 'sitemanager.yes'],
  ['2', 'sitemanager.content.fields.perschedule'],
];

/** Lines 91-163: the featured select with its schedule flyout; `#editFeatureDates` shows only for "Per Schedule". */
function featured(o: CfOutput, m: Scope): void {
  const { bean, label } = m;
  o.text('\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t <label>\n\t\t\t\t\t     \t');
  o.value(label('sitemanager.content.fields.isfeature'));
  o.text(
    `\n\t\t\t\t\t</label>\n\t\t\t    \t<select name="isFeature" onchange="javascript: this.selectedIndex==2?toggleDisplay2('editFeatureDates',true):toggleDisplay2('editFeatureDates',false);">`,
  );
  FEATURE_OPTIONS.forEach(([value, key], index) => {
    o.text(`${index === 0 ? '' : '</option>'}\n\t\t\t\t\t\t<option value="${value}"  `);
    if (textEq(bean, 'isFeature', value)) o.text(' selected');
    o.text('>');
    o.value(label(key));
  });
  o.text('</option>\n\t\t\t\t\t</select>\n\n\t\t\t\t\t<div id="editFeatureDates" ');
  if (!textEq(bean, 'isFeature', '2')) o.text('style="display: none;"');
  o.text(
    '>\n\n\t\t\t\t\t\t<div id="featureschedule-label"></div>\n\t\t\t\t\t\t\n\t\t\t\t\t\t\n\t\t\t\t\t\t<div class="bigui" id="bigui__featureschedule" data-label="',
  );
  o.value(encodeHtmlAttr('Manage Schedule'));
  o.text('">\n\t\t\t\t\t\t\t<div class="bigui__title">');
  o.value(encodeHtmlAttr(label('sitemanager.content.fields.displayinterval.schedule')));
  o.text(
    '</div>\n\t\t\t\t\t\t\t<div class="bigui__controls">\n\n\t\t\t\t\t\t\t\t<div id="featureschedule-selector">\n\t\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t\t<label class="date-span">',
  );
  o.value(label('sitemanager.content.fields.displayinterval.from'));
  o.text('</label>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.value(
    datetimeSelector(m.dates, { name: 'featureStart', datespanclass: 'time', datetime: beanDateText(bean, 'featureStart') }),
  );
  o.text(
    '\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t\t\t\t<label class="date-span">\n\t\t\t\t\t\t\t\t\t\t\t',
  );
  o.value(label('sitemanager.content.fields.displayinterval.to'));
  o.text('\n\t\t\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.value(
    datetimeSelector(m.dates, {
      name: 'featureStop',
      datespanclass: 'time',
      datetime: beanDateText(bean, 'featureStop'),
      defaulthour: 23,
      defaultminute: 59,
    }),
  );
  o.text(FEATURE_SCHEDULE_END);
}

/** The popover `data-content` and `data-original-title` pair of a label, attribute-encoded. */
function popover(o: CfOutput, m: Scope, tooltipKey: string, titleKey: string, between: string): void {
  o.value(encodeHtmlAttr(m.label(tooltipKey)));
  o.text(between);
  o.value(encodeHtmlAttr(m.label(titleKey)));
}

// ---- Release date, navigation and lock ----

/** Lines 169-180: the release date selector. */
function releaseDate(o: CfOutput, m: Scope): void {
  o.text(
    '\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t    <label>\n\t\t\t\t    \t<span data-toggle="popover" title="" data-placement="right"\n\t\t\t\t\t    \tdata-content="',
  );
  popover(o, m, 'tooltip.contentReleaseDate', 'sitemanager.content.fields.releasedate', '"\n\t\t\t\t\t    \tdata-original-title="');
  o.text('"\n\t\t\t\t\t    \t>\n\t\t\t      \t\t');
  o.value(m.label('sitemanager.content.fields.releasedate'));
  o.text('\n\t\t\t\t      \t <i class="mi-question-circle"></i>\n\t\t\t\t      </span>\n\t\t\t      </label>\n\t\t\t      ');
  o.value(
    datetimeSelector(m.dates, { name: 'releaseDate', datetime: beanDateText(m.bean, 'releaseDate'), timeselectwrapper: true }),
  );
  o.text('\n\t\t\t\t</div> \n\t\t\t');
}

/** `<cfif v eq "">checked <cfelseif v eq 1>checked</cfif>`: a blank value checks the box with a trailing space. */
function checkedBlankOrOne(o: CfOutput, bean: CarchStruct, key: string): void {
  if (textEq(bean, key, '')) o.text('checked ');
  else if (textEq(bean, key, '1')) o.text('checked');
}

/** Lines 186-211: the site navigation, new window and search exclusion checkboxes. */
function navigation(o: CfOutput, m: Scope): void {
  const { bean, label } = m;
  o.text(
    '\n\n \t\t\t\t\n\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t      \t<label for="isNav" class="checkbox">\n\t\t\t      \t\t<input name="isnav" id="isNav" type="checkbox" value="1" ',
  );
  if (textEq(bean, 'isNav', '1') || textEq(bean, 'isNew', '1')) o.text('checked');
  o.text(' class="checkbox">\n\t\t\t\t    \t<span data-toggle="popover" title="" data-placement="right" data-content="');
  popover(o, m, 'tooltip.includeSiteNav', 'sitemanager.content.fields.isnav', '" data-original-title="');
  o.text('">\n\t\t\t\t\t\t      ');
  o.value(label('sitemanager.content.fields.isnav'));
  o.text(
    '\n\t\t\t\t    \t\t <i class="mi-question-circle"></i>\n\t\t\t    \t\t</span> \n\t\t\t      \t</label>\n\t\t\t\t</div> \n\n\t\t\t\t\n\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t     \t<label for="Target" class="checkbox">\n\t\t\t     \t<input  name="target" id="Target" type="checkbox" value="_blank" ',
  );
  if (textEq(bean, 'target', '_blank')) o.text('checked');
  o.text(' class="checkbox" >\n\t\t\t    \t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
  popover(o, m, 'tooltip.openNewWindow', 'sitemanager.content.fields.newWindow', '" data-original-title="');
  o.text('">\n\t\t\t\t\t     \t\t');
  o.value(label('sitemanager.content.fields.newwindow'));
  o.text(
    '\n\t\t\t\t\t\t\t<i class="mi-question-circle"></i>\n\t\t\t\t     \t</span>\t \n\t\t\t     \t</label>\n\t\t\t\t</div> \n\n\t\t\t\t\n\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t\t\t <label for="searchExclude" class="checkbox"><input name="searchExclude" id="searchExclude" type="checkbox" value="1" ',
  );
  checkedBlankOrOne(o, bean, 'searchExclude');
  o.text(' class="checkbox"> ');
  o.value(label('sitemanager.content.fields.searchexclude'));
  o.text('</label>\n\t\t\t\t</div> \n\n\t\t\t');
}

/** Lines 217-220: the S2-only node lock checkbox. */
function lockNode(o: CfOutput, m: Scope): void {
  o.text(
    '\n\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t  \n\t\t\t\t\t<label for="islocked" class="checkbox"><input name="isLocked" id="islocked" type="checkbox" value="1" ',
  );
  checkedBlankOrOne(o, m.bean, 'isLocked');
  o.text(' class="checkbox"> ');
  o.value(m.label('sitemanager.content.fields.locknode'));
  o.text('</label>\n\t\t\t    </div>\n\t\t\t');
}

// ---- Restrict access ----

/** Optgroups of `rsRestrictGroups` by `isPublic`, member groups first, as the view's query-of-queries split them. */
const GROUP_OPTGROUPS: ReadonlyArray<readonly [isPublic: string, labelKey: string]> = [
  ['1', 'user.membergroups'],
  ['0', 'user.adminusergroups'],
];

/** Lines 228-258: the restrict checkbox and `#rg` group select, groups matched by name or id and printed raw. */
function restrictAccess(o: CfOutput, m: Scope): void {
  const { bean, label } = m;
  const restricted = textEq(bean, 'restricted', '1');
  const restrictGroups = structText(bean, 'restrictGroups');
  o.text(
    `\n\t\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t\t      \t<label for="Restricted" class="checkbox"><input name="restricted" id="Restricted" type="checkbox" value="1"  onclick="javascript: this.checked?toggleDisplay2('rg',true):toggleDisplay2('rg',false);" `,
  );
  if (restricted) o.text('checked ');
  o.text(' class="checkbox">\n\t\t\t\t\t\t');
  o.value(label('sitemanager.content.fields.restrictaccess'));
  o.text('\n\t\t\t\t\t\t</label>\n\t\t\t\t\t</div>\n\t\t\t      \t<div class="mura-control=group" id="rg"');
  if (!restricted) o.text(' style="display:none;"');
  o.text(
    '>\n\t\t\t      \t\t<div class="mura-control justify">\n\t\t\t\t\t\t\t<select name="restrictgroups" size="8" multiple="multiple" class="multiSelect" id="restrictGroups">\n\t\t\t\t\t\t\t<optgroup label="',
  );
  o.value(encodeHtmlAttr(label('sitemanager.content.fields.globalsettings')));
  o.text('">\n\t\t\t\t\t\t\t<option value="" ');
  if (textEq(bean, 'restrictGroups', '')) o.text('selected');
  o.text('>');
  o.value(label('sitemanager.content.fields.allowall'));
  o.text('</option>\n\t\t\t\t\t\t\t<option value="RestrictAll" ');
  if (textEq(bean, 'restrictGroups', 'RestrictAll')) o.text('selected');
  o.text('>');
  o.value(label('sitemanager.content.fields.restrictall'));
  o.text('</option>\n\t\t\t\t\t\t\t</optgroup>\n\t\t\t\t\t\t\t');
  const rows = rowsAt(m.model, 'rsRestrictGroups');
  for (const [isPublic, key] of GROUP_OPTGROUPS) {
    o.gap();
    const groups = rows.filter((row) => textEq(row, 'isPublic', isPublic));
    if (groups.length === 0) continue;
    o.text('\n\t\t\t\t\t\t\t\t<optgroup label="');
    o.value(encodeHtmlAttr(label(key)));
    o.text('">\n\t\t\t\t\t\t\t\t');
    for (const group of groups) {
      const userId = structText(group, 'userid');
      const groupName = structText(group, 'groupname');
      o.text('\n\t\t\t\t\t\t\t\t\t<option value="');
      o.value(userId);
      o.text('" ');
      if (cfListHas(restrictGroups, groupName) || cfListHas(restrictGroups, userId)) o.text('Selected');
      o.text('>');
      o.value(groupName);
      o.text('</option>\n\t\t\t\t\t\t\t\t');
    }
    o.text('\n\t\t\t\t\t\t\t\t</optgroup>\n\t\t\t\t\t\t\t');
  }
  o.text('\n\t\t\t\t\t\t\t</select>\n\t\t\t\t\t\t</div> \t\n\t\t\t\t\t</div> \n\t\t\t    ');
}

// ---- Cache, template and SSL ----

/** Lines 266-271: the exclude-from-cache checkbox, which posts `doCache=0` when checked. */
function doCache(o: CfOutput, m: Scope): void {
  o.text(
    '\n\t\t\t\t<div class="mura-control-group boolean">\n\n\t\t      \t\t<label for="cacheItem" class="checkbox">\n\t\t      \t\t\t<input name="doCache" id="doCache" type="checkbox" value="0"',
  );
  if (textEq(m.bean, 'doCache', '0')) o.text(' checked');
  o.text(' class="checkbox"> ');
  o.value(m.label('sitemanager.content.fields.docache'));
  o.text('\n\t\t      \t\t</label>\n\t\t       </div>\n\t\t\t');
}

/** Lines 276-295: the Component layout template select over the site's `.cfm` templates; names print unencoded. */
function layoutTemplate(o: CfOutput, m: Scope): void {
  const { label } = m;
  const template = structText(m.bean, 'template');
  o.text('\n\t\t\t\t<div class="mura-control-group">\n\t\t\t      \t<label>\n\t\t\t      \t\t');
  o.text('\n\t\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"\n\t\t\t\t\t\t  \tdata-content="');
  popover(o, m, 'tooltip.layoutTemplate', 'sitemanager.content.fields.layouttemplate', '"\n\t\t\t\t\t\t  \tdata-original-title="');
  o.text('"\n\t\t\t\t\t\t  \t>\n\t\t\t\t\t\t\t\t');
  o.value(label('sitemanager.content.fields.layouttemplate'));
  o.text(' <i class="mi-question-circle"></i></span>\n\t\t\t\t\t\t\t');
  o.text('\n\t\t\t      \t</label>\n\t\t\t  \t\t<select name="template" class="dropdown">\n\t\t\t\t\t\t<option value="">');
  o.value(label('sitemanager.content.fields.none'));
  o.text('</option>\n\t\t\t\t\t\t');
  for (const row of rowsAt(m.model, 'rsTemplates')) {
    const name = structText(row, 'name');
    o.gap();
    if (!cfEq(name.slice(-4), '.cfm')) continue;
    o.text('\n\t\t\t\t\t\t<option value="');
    o.value(name);
    o.text('" ');
    if (cfEq(template, name)) o.text('selected');
    o.text('>');
    o.value(name);
    o.text('</option>\n\t\t\t\t\t\t');
    o.gap();
  }
  o.text('\n\t\t\t\t\t</select>\n\t\t\t\t</div>\n\t\t\t');
}

/** Lines 299-310: the force-SSL checkbox of a page whose site does not already use SSL. */
function forceSsl(o: CfOutput, m: Scope): void {
  const { label } = m;
  o.text('\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t    <label>');
  o.value(label('sitemanager.content.fields.forcessllabel'));
  o.text(
    '</label>\n\t\t\t      \t<label for="forceSSL" class="checkbox">\n\t\t\t      \t<input name="forceSSL" id="forceSSL" type="checkbox" value="1" ',
  );
  checkedBlankOrOne(o, m.bean, 'forceSSL');
  o.text(
    ' class="checkbox">\n\t\t\t\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"\n\t\t\t\t\t\t\t\t  \tdata-content="',
  );
  popover(o, m, 'tooltip.makePageSecure', 'sitemanager.content.fields.forcessllabel', '"\n\t\t\t\t\t\t\t\t  \tdata-original-title="');
  o.text('">\n\t\t\t\t\t\t\t\t  \t');
  const typeLabel = label(`sitemanager.content.type.${m.type}`);
  o.value(m.input.ctx.rb.messageFormat(label('sitemanager.content.fields.forcessltext'), typeLabel));
  o.text(
    '\n\t\t\t\t\t      \t <i class="mi-question-circle"></i>\n\t\t\t\t\t      \t</span>\n\t\t\t  \t\t</label>\n\t\t\t      </div>\n\t\t\t',
  );
}

/** Lines 315-328: a Form's force-SSL and display-title checkboxes when the site renders without the layout manager. */
function formOptions(o: CfOutput, m: Scope): void {
  const { bean, label } = m;
  o.gap();
  if (beanFlag(bean, 'forceSSL') && !siteUsesSsl(m.site)) {
    o.text(
      '\n\t\t\t\t\t<div class="mura-control-group boolean">\n\t\t\t\t\t\t\n\t\t\t     \t\t<label for="forceSSL" class="checkbox">\n\t\t\t     \t\t\t<input name="forceSSL" id="forceSSL" type="checkbox" value="1" ',
    );
    checkedBlankOrOne(o, bean, 'forceSSL');
    o.text(' class="checkbox"> ');
    o.value(label('sitemanager.content.fields.forcessl'));
    o.text('\n\t\t\t     \t\t</label>\n\t\t\t\t    </div>\n\t\t\t   \t');
  }
  o.text(
    '\n\n\t\t\t    <div class="mura-control-group boolean">\n\t\t      \t\t<label for="displayTitle" class="checkbox">\n\t\t      \t\t\t<input name="displayTitle" id="displayTitle" type="checkbox" value="1" ',
  );
  checkedBlankOrOne(o, bean, 'displayTitle');
  o.text(' class="checkbox"> ');
  o.value(label('sitemanager.content.fields.displaytitlelabel'));
  o.text('\n\t\t      \t\t</label>\n\t\t        </div>\n\t\t\t');
}

// ---- Notify, expiration and mobile ----

/** Lines 332-343: the notify-for-review checkbox, which loads its recipient list on click. */
function notifyForReview(o: CfOutput, m: Scope): void {
  o.text(
    '\n\n\t\t\t\n\t\t\t<div class="mura-control-group boolean">\n\t\t\t\t\t<label for="dspnotify" class="checkbox">\n\t\t\t  \t\t<input type="checkbox" name="dspNotify"  id="dspnotify" onclick="siteManager.loadNotify(\'',
  );
  o.value(jsArgs(m.siteId, m.contentId, m.parentId));
  o.text(
    '\');"  class="checkbox">\n\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"\n\t\t\t\t\t\tdata-content="',
  );
  popover(o, m, 'tooltip.notifyReview', 'sitemanager.content.fields.notifyforreview', '"\n\t\t\t\t\t\tdata-original-title="');
  o.text('">\n\t\t\t\t\t\t');
  o.value(m.label('sitemanager.content.fields.notifyforreview'));
  o.text(
    '\n\t\t\t      \t\t <i class="mi-question-circle"></i>\n\t\t\t\t\t </span>\n\t\t\t  \t</label>\n\t\t\t\t<div id="selectNotify" class="mura-control justify" style="display: none;"></div>\n\t\t\t</div> \n\t\t\t\n\t\t\t\n\t\t\t',
  );
}

/** Lines 368-395: the expiration controls' closing tags and the head of the `showSelectedExp` script. */
const EXPIRES_SCRIPT_HEAD =
  `></div>\n` +
  `\t\t\t\t\t\t\t</div> \n` +
  `\t\t\t\t\t\t</div>\n` +
  `\t\t\t\t\t</div> \n` +
  `\n` +
  `\t\t\t\t\t</div>\n` +
  `\t\t\t\t</div>\t\n` +
  `\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t<script type="text/javascript">\n` +
  `\t\t\t\t\tfunction showSelectedExp(){\n` +
  `\t\t\t\t\t\tvar expStr = 'Never';\n` +
  `\t\t\t\t\t\tvar notifyCt = $('#expiresnotify option:selected[value!=""]').not(':empty').length;\n` +
  `\t\t\t\t\t\tif ($('#mura-datepicker-expires').val() != ''){\n` +
  `\t\t\t\t\t\t\texpStr = $('#mura-datepicker-expires').val() + ' ' \n` +
  `\t\t\t\t\t\t\t\t\t\t\t+ $('#mura-expiresHour').val() + ':' \n` +
  `\t\t\t\t\t\t\t\t\t\t\t+ $('#mura-expiresMinute option:selected').html() + ' '\n` +
  `\t\t\t\t\t\t\t\t\t\t\t+ $('#mura-expiresDayPart option:selected').html();\t\t\t\t\t\n` +
  `\t\t\t\t\t\t}\n` +
  `\t\t\t\t\t\t if ($('#dspexpiresnotify').is(':checked') && notifyCt > 0){\n` +
  `\t\t\t\t\t\t \texpStr += '<br>Notifying: ' + notifyCt;\n` +
  `\t\t\t\t\t\t }\n` +
  `\t\t\t\t\t\t$('#expire-label').html('Expires: ' + expStr);\n` +
  `\t\t\t\t\t}\n` +
  `\n` +
  `\t\t\t\t\t$(document).ready(function(){\n` +
  `\t\t\t\t\t\t// load notification list if previously selected\n` +
  `\t\t\t\t\t\t`;

/** Lines 397-407: the tail of the `showSelectedExp` script. */
const EXPIRES_SCRIPT_TAIL =
  `\n` +
  `\t\t\t\t\t\t// run on page load\n` +
  `\t\t\t\t\t\tsetTimeout(function(){\n` +
  `\t\t\t\t\t\t\tshowSelectedExp();\n` +
  `\t\t\t\t\t\t}, 300);\n` +
  `\t\t\t\t\t\t// run on change of any schedule element\n` +
  `\t\t\t\t\t\t$('#expireschedule-selector *').on('change',function(){\n` +
  `\t\t\t\t\t\t\tshowSelectedExp();\n` +
  `\t\t\t\t\t\t})\n` +
  `\t\t\t\t\t});\t\t\t\t\n` +
  `\t\t\t\t</script>\n` +
  `\t\t  \t\t\n` +
  `\t\t\t`;

/** Lines 348-407: the expiration selector and its notify checkbox, preloaded when the node has recipients. */
function expiration(o: CfOutput, m: Scope): void {
  const { label } = m;
  const notifyCount = notifyCountOf(m.model);
  const expiresLabel = encodeHtmlAttr(label('sitemanager.content.fields.expires'));
  const loaderArgs = jsArgs(m.siteId, m.contentHistId, m.parentId);
  o.text('\n\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>');
  o.value(expiresLabel);
  o.text(
    '</label>\n\t\t\t\t\t<div class="mura-control justify">\n\t\t\t\t\t\t<div id="expire-label">Expires: never</div>\n\n\t\t\t\t\t\n\t\t\t\t\t\n\t\t\t\t\t<div class="bigui" id="bigui__expireschedule" data-label="',
  );
  o.value(encodeHtmlAttr('Manage Expiration'));
  o.text('">\n\t\t\t\t\t\t<div class="bigui__title">');
  o.value(expiresLabel);
  o.text(
    '</div>\n\t\t\t\t\t\t<div class="bigui__controls">\n\n\t\t\t\t\t\t\t<div class="mura-control-group" id="expireschedule-selector">\n\t\t\t\t\t\t\t\t<label></label>\n\t\t\t\t\t\t     \t',
  );
  o.value(
    datetimeSelector(m.dates, {
      name: 'expires',
      datetime: beanDateText(m.bean, 'expires'),
      defaulthour: 23,
      defaultminute: 59,
    }),
  );
  o.text(
    '\n\t\t\t\t\t\t\t\t<div class="mura-control justify" id="expires-notify">\n\t\t\t\t\t\t\t\t\t<label for="dspexpiresnotify" class="checkbox">\n\t\t\t\t\t\t\t\t\t\t<input type="checkbox" name="dspExpiresNotify" id="dspexpiresnotify" onclick="siteManager.loadExpiresNotify(\'',
  );
  o.value(loaderArgs);
  o.text('\');"  class="checkbox"');
  if (notifyCount !== 0) o.text(' checked');
  o.text('>\n\t\t\t\t\t\t\t\t\t\t\t');
  o.value(label('sitemanager.content.fields.expiresnotify'));
  o.text(
    '\n\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t<div class="mura-control-group" id="selectExpiresNotify"',
  );
  if (notifyCount === 0) o.text(' style="display: none;"');
  o.text(EXPIRES_SCRIPT_HEAD);
  if (notifyCount !== 0) {
    o.text("\n\t\t\t\t\t\t\tsiteManager.loadExpiresNotify('");
    o.value(loaderArgs);
    o.text("');\t\t\t\t\t\t\n\t\t\t\t\t\t");
  }
  o.text(EXPIRES_SCRIPT_TAIL);
}

/** Lines 415-427: a hidden `mobileExclude` of 0 for new nodes and those not excluded, else the deprecated radios. */
function mobileExclude(o: CfOutput, m: Scope): void {
  const { bean, label } = m;
  o.gap();
  if (textEq(bean, 'mobileExclude', '0') || beanFlag(bean, 'isNew')) {
    o.text('\n\t\t\t  \t\t<input type="hidden" name="mobileExclude" value="0">\n\t\t\t  \t');
  } else {
    o.text('\t\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>');
    o.value(label('sitemanager.content.fields.mobileexclude'));
    o.text(
      '</label>\n\t\t\t\t\t\t<div class="radio-group">\n\t\t\t\t\t\t\t<label class="radio"><input type="radio" name="mobileExclude" value="0" checked>',
    );
    o.value(label('sitemanager.content.fields.mobileexclude.always'));
    o.text('</label>\n\t\t\t\t\t\t\t<label class="radio"><input type="radio" name="mobileExclude" value="2"');
    if (textEq(bean, 'mobileExclude', '2')) o.text(' checked');
    o.text('>');
    o.value(label('sitemanager.content.fields.mobileexclude.mobile'));
    o.text('</label>\n\t\t\t\t\t\t\t<label class="radio"><input type="radio" name="mobileExclude" value="1"');
    if (textEq(bean, 'mobileExclude', '1')) o.text(' checked');
    o.text('>');
    o.value(label('sitemanager.content.fields.mobileexclude.standard'));
    o.text('</label>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t');
  }
  o.gap();
}

/** Lines 430-447: the extended attributes flyout, the bottom extend-set container and the panel's closing tags. */
const PANEL_END =
  ` \n` +
  `\n` +
  `\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-publishing">\n` +
  `\t\t\t\t<div class="bigui" id="bigui__publishing" data-label="Manage Extended Attributes">\n` +
  `\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>\n` +
  `\t\t\t\t\t<div class="bigui__controls">\n` +
  `\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>\n` +
  `\t\t\t\t\t\t<span id="extendset-container-publishing" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-publishing"></span>\n` +
  `\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>\n` +
  `\t\t\t\t\t</div>\n` +
  `\t\t\t\t</div>\n` +
  `\t\t\t\t\n` +
  `\t\t\t</div>\n` +
  `\n` +
  `\n` +
  `\t\t   <span id="extendset-container-tabpublishingbottom" class="extendset-container"></span>\n` +
  `\t\t\t\t\n` +
  `\t\t</div>\n` +
  `\t</div>\n` +
  `</div> \n` +
  `\n`;

// ---- Panel ----

/**
 * The Publishing panel include, from its first markup line through `</div> ` and the blank line after it.
 * @throws TypeError When the request has no session site or the edit model lacks a value a shown block reads.
 */
export function renderPublishingPanel(input: EditFormInput): PanelResult {
  const { ctx, req, data } = input;
  const { site } = req;
  if (site === undefined) throw new TypeError(`programs-sites served no site ${req.session.siteid} for carch.edit`);
  const bean = structOf(data.rc, 'contentBean');
  const rcParentId = rcText(req.rc, 'parentid');
  const m: Scope = {
    input,
    dates: { req, now: ctx.now },
    model: data.rc,
    bean,
    site,
    type: rcText(req.rc, 'type'),
    contentId: rcText(req.rc, 'contentid'),
    siteId: rcText(req.rc, 'siteid'),
    contentHistId: rcText(req.rc, 'contenthistid'),
    // edit.cfm fills a blank rc.parentID from a stored node before the panels read it.
    parentId: rcParentId === '' && !beanFlag(bean, 'isNew') ? structText(bean, 'parentID') : rcParentId,
    label: (key) => ctx.rb.rbKey(key),
  };
  const { type } = m;
  const tabLabel = m.label('sitemanager.content.tabs.publishing');
  const isNode = cfListHas(NODE_TYPES, type, { noCase: true });
  const isPageLike = !cfListHas(NON_PAGE_TYPES, type, { noCase: true });
  const isRoot = cfEq(m.contentId, ROOT_CONTENT_ID);
  const o = new CfOutput();
  o.text(
    '\n<div class="mura-panel panel">\n\t<div class="mura-panel-heading" role="tab" id="heading-publishing">\n\t\t<h4 class="mura-panel-title">\n\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-publishing" aria-expanded="false" aria-controls="panel-publishing">',
  );
  o.value(tabLabel);
  o.text(
    '</a>\n\t\t</h4>\n\t</div>\n\t\t<div id="panel-publishing" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-publishing" aria-expanded="false" style="height: 0px;">\n\t\t\t<div class="mura-panel-body">\n\n\t\t\t<span id="extendset-container-tabpublishingtop" class="extendset-container"></span>\n\n\t\t\t\n\t\t\t',
  );
  if (isPageLike && !isRoot) featured(o, m);
  o.gap();
  if (isNode) releaseDate(o, m);
  o.gap();
  if (isNode) navigation(o, m);
  o.gap();
  if (!isRoot && req.isS2) lockNode(o, m);
  o.gap();
  if (isNode && site.extranet) restrictAccess(o, m);
  o.gap();
  if ((site.cache && cfEq(type, 'Component')) || cfEq(type, 'Form')) doCache(o, m);
  o.gap();
  if (cfEq(type, 'Component')) layoutTemplate(o, m);
  o.gap();
  if (isPageLike && beanFlag(bean, 'forceSSL') && !siteUsesSsl(site)) forceSsl(o, m);
  o.gap();
  // Only a Form reads the flag, so other types render without the edit model carrying it.
  if (cfEq(type, 'Form') && !useLayoutManagerOf(m.model)) formOptions(o, m);
  notifyForReview(o, m);
  if (cfListHas(EXPIRES_TYPES, type)) expiration(o, m);
  o.gap();
  if (isNode) mobileExclude(o, m);
  o.text(PANEL_END);
  return { html: raw(o.markup), tabId: 'tabPublishing', tabLabel };
}
