/** Carried `carch` fragment and JSON responses and `cchangesets.loadtagarray`, byte for byte as ACF 2023 sends them. */
import {
  LEGACY_JSON_CONTENT_TYPE,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfLsDateOf,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import {
  cfHtmlEditFormat,
  esapiEncode,
  isS2,
  isSiteAdmin,
  lsDateFormat,
  lsTimeFormat,
  type AdminRenderContext,
  type NodePerm,
} from './admin-markup.js';
import { acfSerializeJson, muraJsonEncode } from './cfjson.js';
import { contentUrl, imageUrl } from './content-urls.js';
import type {
  ApprovalActionRow,
  ApprovalRequestRow,
  ChangesetRow,
  ContentRow,
  ExtendAttributeRow,
  ExtendSetRow,
  ExtendSubtypeRow,
  FileMetadataRow,
  FileRow,
} from '../repo/tables.js';

// --- Results ---

/** A bare response as legacy sends it. */
export interface PanelRenderResult {
  status: number;
  contentType: string;
  body: string;
  /** `session.mura` changes the view makes, for the route to apply to the admin session state it keeps. */
  muraSessionEffects?: PanelMuraSessionEffects;
}

/** `session.mura` writes of these views. */
export interface PanelMuraSessionEffects {
  /** `structDelete(session.mura, 'editBean')`. */
  clearEditBean?: true;
  /** `session.mura.objectInstanceId`. */
  objectInstanceId?: string;
}

/** A branch served elsewhere: `legacy` for markup only CFML renders, `edit-page` for web's edit form (page mode). */
export interface PanelDelegation {
  delegate: 'legacy' | 'edit-page';
  reason: string;
}

/** A view FW/1 wraps in the admin layout because it leaves `request.layout` on; web's shell wraps `body`. */
export interface PanelLayoutBody {
  layout: true;
  body: string;
}

/** What ACF sends for a FW/1 view that sets no content type. */
const VIEW_CONTENT_TYPE = 'text/html;charset=UTF-8';
/** What ACF sends for `<cfcontent type="application/json">`: the container appends its default charset. */
const BARE_JSON_CONTENT_TYPE = 'application/json; charset=UTF-8';

// --- CFML output ---

const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;
const UNICODE_SEPARATOR = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;

/** Java `Character.isWhitespace`. */
function isJavaWhitespace(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x20)) return true;
  if (cp === 0xa0 || cp === 0x2007 || cp === 0x202f) return false;
  return UNICODE_SEPARATOR.test(ch);
}

/** One output buffer under ACF whitespace management: whitespace-only text prints one space after non-whitespace, else nothing. */
class CfOutput {
  private out = '';

  /** Template text between two tags or expressions. */
  t(text: string): void {
    if (!TEMPLATE_WHITESPACE.test(text)) this.out += text;
    else if (this.out !== '' && !isJavaWhitespace(this.out.slice(-1))) this.out += ' ';
  }

  /** The output of a `#…#` expression. */
  e(value: string): void {
    this.out += value;
  }

  toString(): string {
    return this.out;
  }
}

/** A `request.layout=false` view's response. */
function viewResult(o: CfOutput, muraSessionEffects?: PanelMuraSessionEffects): PanelRenderResult {
  const result: PanelRenderResult = { status: 200, contentType: VIEW_CONTENT_TYPE, body: o.toString() };
  if (muraSessionEffects !== undefined) result.muraSessionEffects = muraSessionEffects;
  return result;
}

/** `LSDateFormat(text, mask)` of a request or bean string: blank prints '', other text formats the date it parses to. */
function lsDateText(text: string, mask: string): string {
  return lsDateFormat(cfLsDateOf(text), mask);
}

/** `<cfif not isNumeric(rc.categoryAssignment)><cfset rc.categoryAssignment=0></cfif>`. */
function numericOrZero(value: string): string {
  return cfIsNumeric(value) ? value : '0';
}

/** CFML `listFindNoCase(list, value)` over a literal lower-case list. */
function inNoCaseList(list: readonly string[], value: string): boolean {
  return list.includes(value.toLowerCase());
}

/** ACF `XMLFormat`: `& < > " '` as entities, U+00A0..U+00FF as `&#xhh;`, carriage returns dropped. */
function xmlFormat(s: string): string {
  let out = '';
  for (const ch of s.replaceAll('\r', '')) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else if (cp >= 0xa0 && cp <= 0xff) out += `&#x${cp.toString(16)};`;
    else out += ch;
  }
  return out;
}

/** `iif(len(m) eq 1, de('0#m#'), de('#m#'))`. */
function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Whole-number loop `<cfloop from to index>`. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// --- Category feature panels ---

/** The `rc` values the category feature views read, as the Site Manager scripts post them. */
export interface CategoryFeatureModel {
  categoryAssignment: string;
  catTrim: string;
  featureStart: string;
  featureStop: string;
  startHour: string;
  startMinute: string;
  startDayPart: string;
  stopHour: string;
  stopMinute: string;
  stopDayPart: string;
}

/** Inputs of {@link renderLoadCategoryAssignment}. */
export interface CategoryAssignmentModel extends CategoryFeatureModel {
  /** `session.localeHasDayParts`. */
  localeHasDayParts: boolean;
}

/** One hour `<option>` of the quick-edit time selects. */
function hourOption(o: CfOutput, h: number, selected: boolean): void {
  o.t('\n\t\t\t\t\t\t\t<option value="');
  o.e(String(h));
  o.t('" ');
  if (selected) o.t('selected');
  o.t('>');
  o.e(String(h));
  o.t('</option>\n\t\t\t\t\t\t');
}

/** One minute `<option>` of the quick-edit time selects. */
function minuteOption(o: CfOutput, m: number, selected: boolean): void {
  o.t('\n\t\t\t\t\t\t<option value="');
  o.e(String(m));
  o.t('" ');
  if (selected) o.t('selected');
  o.t('>\n\t\t\t\t\t\t\t');
  o.e(twoDigits(m));
  o.t('\n\t\t\t\t\t\t</option>\n\t\t\t\t\t');
}

/** Hour, minute and day-part selects of one end of the feature window (loadcategoryassignment.cfm). */
function featureTimeSelects(
  o: CfOutput,
  end: 'start' | 'stop',
  values: { hour: string; minute: string; dayPart: string },
  localeHasDayParts: boolean,
): void {
  const hourNumeric = cfIsNumeric(values.hour);
  const hourIs = (h: number): boolean => hourNumeric && cfToNumber(values.hour) === h;
  const minuteIs = (m: number): boolean => cfIsNumeric(values.minute) && cfToNumber(values.minute) === m;
  if (localeHasDayParts) {
    o.t(`\n\t\t\t\t\t<select id="mura-quickEdit-${end}Hour" class="time">\n\t\t\t\t\t\t`);
    const defaultHour = end === 'start' ? 12 : 11;
    for (const h of range(1, 12)) {
      hourOption(o, h, (hourNumeric && (hourIs(h) || (hourIs(0) && h === 12))) || (!hourNumeric && h === defaultHour));
    }
    o.t('\n\t\t\t\t\t</select>\n\t\t\t\t');
  } else {
    o.t(`\n\t\t\t\t\t<select id="mura-quickEdit-${end}Hour" class="time">\n\t\t\t\t\t\t`);
    for (const h of range(0, 23)) hourOption(o, h, end === 'start' ? hourIs(h) : hourIs(h) || (!hourNumeric && h === 23));
    o.t('\n\t\t\t\t\t</select>\n\t\t\t\t');
  }
  o.t(`\n\n\t\t\t\t<select id="mura-quickEdit-${end}Minute" class="time">\n\t\t\t\t\t`);
  for (const m of range(0, 59)) minuteOption(o, m, end === 'start' ? minuteIs(m) : minuteIs(m) || m === 59);
  o.t('\n\t\t\t\t</select>\n\n\t\t\t\t');
  if (localeHasDayParts) {
    o.t(
      `\n\t\t\t\t\t<select id="mura-quickEdit-${end}DayPart" class="time">\n\t\t\t\t\t\t<option value="AM">AM</option>` +
        '\n\t\t\t\t\t\t<option value="PM" ',
    );
    if (end === 'start' ? cfEq(values.dayPart, 'PM') : !cfEq(values.dayPart, 'AM')) o.t('selected');
    o.t('>PM</option>\n\t\t\t\t\t</select>\n\t\t\t\t');
  }
}

/** `carch.loadcategoryassignment` (loadcategoryassignment.cfm): the quick-edit feature schedule of one category. */
export function renderLoadCategoryAssignment(model: CategoryAssignmentModel, ctx: AdminRenderContext): PanelRenderResult {
  const { labels } = ctx;
  const assignment = numericOrZero(model.categoryAssignment);
  const o = new CfOutput();
  o.t('\n\t<h1>');
  o.e(labels.key('sitemanager.quickedit.feature'));
  o.t('</h1>\n\t<span class="cancel" onclick="siteManager.closeCategoryAssignment();" title="');
  o.e(labels.key('sitemanager.quickedit.cancel'));
  o.t(
    '"><i class="mi-close"></i></span>\n\n\t\t\n\t\t<select id="mura-quickEdit-display" onchange="this.selectedIndex==2?' +
      "toggleDisplay2('mura-quickEdit-displayDates',true):toggleDisplay2('mura-quickEdit-displayDates',false);\">" +
      '\n\t\t<option ',
  );
  if (cfEq(assignment, '0')) o.t('selected');
  o.t(' value="0">');
  o.e(labels.key('sitemanager.no'));
  o.t('</option>\n\t\t<option value="1" ');
  if (cfEq(assignment, '1')) o.t('selected');
  o.t('>');
  o.e(labels.key('sitemanager.yes'));
  o.t('</option>\n\t\t<option value="2" ');
  if (cfEq(assignment, '2')) o.t('selected');
  o.t('>');
  o.e(labels.key('sitemanager.content.fields.scheduledfeature'));
  o.t('</option>\n\t\t</select>\n\n\n\t\t<div id="mura-quickEdit-displayDates"');
  if (!cfEq(assignment, '2')) o.t(' style="display: none;"');
  o.t('>\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<label>');
  o.e(labels.key('sitemanager.content.fields.startdatetime'));
  o.t('</label>\n\t\t\t\t<input type="text" id="mura-quickEdit-featureStart" value="');
  o.e(lsDateText(model.featureStart, ctx.session.dateKeyFormat));
  o.t('" class="textAlt datepicker mura-quickEdit-datepicker"><br />\n\n\t\t\t\t');
  featureTimeSelects(
    o,
    'start',
    { hour: model.startHour, minute: model.startMinute, dayPart: model.startDayPart },
    model.localeHasDayParts,
  );
  o.t(
    '\n\t\t\t</div> <!-- /.mura-control-group -->\n\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<label>',
  );
  o.e(labels.key('sitemanager.content.fields.stopdatetime'));
  o.t('</label>\n\t\t\t\t<input type="text" id="mura-quickEdit-featureStop" value="');
  o.e(lsDateText(model.featureStop, ctx.session.dateKeyFormat));
  o.t('" class="textAlt datepicker mura-quickEdit-datepicker"><br />\n\n\t\t\t\t');
  featureTimeSelects(
    o,
    'stop',
    { hour: model.stopHour, minute: model.stopMinute, dayPart: model.stopDayPart },
    model.localeHasDayParts,
  );
  o.t(
    '\n\t\t\t</div> <!-- /.mura-control-group -->\n\n\t\t</div> <!-- /mura-quickEdit-displayDates -->' +
      '\n\t<input type="hidden" id="mura-quickEdit-cattrim" value="',
  );
  o.e(esapiEncode('html_attr', model.catTrim));
  o.t(
    '">\n\t\t<div class="form-actions">\n\t\t<button class="btn mura-primary" type="button" ' +
      'onclick="siteManager.saveCategoryAssignment();">Submit</button>\n\t</div>\n\t',
  );
  return viewResult(o);
}

/** The schedule fields kept for the category's save (loadcategoryfeaturestartstop.cfm), `[name, value]` in order. */
function hiddenScheduleFields(o: CfOutput, catTrim: string, fields: ReadonlyArray<readonly [string, string]>): void {
  fields.forEach(([name, value], i) => {
    o.t(`${i === 0 ? '' : '">'}\n\t\t\t<input type="hidden" id="${name}`);
    o.e(catTrim);
    o.t(`" name="${name}`);
    o.e(catTrim);
    o.t('" value="');
    o.e(value);
  });
  o.t('">\n\t\t');
}

/** `carch.loadcategoryfeaturestartstop` (loadcategoryfeaturestartstop.cfm): the category's feature cell and fields. */
export function renderLoadCategoryFeatureStartStop(model: CategoryFeatureModel, ctx: AdminRenderContext): PanelRenderResult {
  const { labels } = ctx;
  const { dateKeyFormat } = ctx.session;
  const assignment = numericOrZero(model.categoryAssignment);
  const scheduled = cfEq(assignment, '2');
  const featureWindow = (): string =>
    `${esapiEncode('html_attr', lsDateText(model.featureStart, 'short'))}&nbsp;-&nbsp;${lsDateText(model.featureStop, 'short')}`;
  const o = new CfOutput();
  o.t('\n\t<div class="categoryassignmentcontent');
  if (scheduled) o.t(' scheduled');
  o.t('">\n\t\t<a class="dropdown-toggle mura-quickEditItem"');
  if (scheduled) {
    o.t(' rel="tooltip" title="');
    o.e(featureWindow());
    o.t('"');
  } else {
    o.t('class="mura-quickEditItem"');
  }
  o.t('>\n\t\t\t');
  const icon = (iconClass: string, key: string): void => {
    o.t(`\n\t\t\t\t\t<i class="${iconClass}" title="`);
    o.e(esapiEncode('html_attr', labels.key(key)));
    o.t('"></i><span>');
    o.e(esapiEncode('html', labels.key(key)));
    o.t('</span>\n\t\t\t\t');
  };
  if (assignment === '1') {
    icon('mi-check', 'sitemanager.yes');
  } else if (assignment === '2') {
    o.t('\n\t\t\t\t\t<i class="mi-calendar" title="');
    o.e(featureWindow());
    o.t('"></i> \n\t\t\t\t');
  } else {
    icon('mi-ban', 'sitemanager.no');
  }
  o.t('\n\t\t</a>\n\t\t<input type="hidden" id="categoryAssign');
  o.e(model.catTrim);
  o.t('" name="categoryAssign');
  o.e(model.catTrim);
  o.t('" value="');
  o.e(esapiEncode('html_attr', assignment));
  o.t('"/>\n\t\t');
  if (scheduled) {
    hiddenScheduleFields(o, model.catTrim, [
      ['featureStart', lsDateText(model.featureStart, dateKeyFormat)],
      ['startHour', esapiEncode('html_attr', model.startHour)],
      ['startMinute', esapiEncode('html_attr', model.startMinute)],
      ['startDayPart', esapiEncode('html_attr', model.startDayPart)],
      ['featureStop', lsDateText(model.featureStop, dateKeyFormat)],
      ['stopHour', esapiEncode('html_attr', model.stopHour)],
      ['stopMinute', esapiEncode('html_attr', model.stopMinute)],
      ['stopDayPart', esapiEncode('html_attr', model.stopDayPart)],
    ]);
  }
  o.t('\n\t</div>\n');
  return viewResult(o);
}

// --- Display-object class lists ---

/** A `tsystemobjects` row as `contentManager.getSystemObjects` returns it. */
export interface SystemObjectRow {
  object: string;
  name: string;
}

/** A mailing list as `contentUtility.getMailingLists` returns it. */
export interface MailingListRow {
  mlid: string;
  name: string;
}

/** A `contentManager.getSections` row; `pathString` is `$.dspZoomText` of its crumbs, rows sorted by it. */
export interface ObjectClassSection {
  contentid: string;
  pathString: string;
}

/** A `feedManager.getFeeds` row. */
export interface ObjectClassFeed {
  feedid: string;
  name: string | null;
}

/** The query each class list reads; only the one the class needs is required. */
export interface ObjectClassData {
  /** `contentManager.getComponents('00000000000000000000000000000000000', siteid)`. */
  components?: ReadonlyArray<Pick<ContentRow, 'contentid' | 'menutitle' | 'title'>>;
  /** `contentManager.getComponentType(siteid, 'Form')`. */
  forms?: ReadonlyArray<Pick<ContentRow, 'contentid' | 'menutitle' | 'responsechart'>>;
  /** `contentManager.getSystemObjects(siteid)`, before the views filter it. */
  systemObjects?: readonly SystemObjectRow[];
  /** `feedManager.getFeeds(siteid, 'Local')`, for `localFeed` and `slideshow`. */
  localFeeds?: readonly ObjectClassFeed[];
  /** `feedManager.getFeeds(siteid, 'Remote')`. */
  remoteFeeds?: readonly ObjectClassFeed[];
  /** `contentManager.getSections(siteid, 'Folder' | 'Calendar' | 'Gallery')` for the class. */
  sections?: readonly ObjectClassSection[];
  /** `contentUtility.getMailingLists(siteid)`. */
  mailingLists?: readonly MailingListRow[];
}

/** Inputs of {@link renderLoadClass}: the `rc` values (`contentHistId` as carch's `before()` defaults it) and the data. */
export interface LoadClassModel {
  classid: string;
  subclassid: string;
  layoutManager: boolean;
  siteId: string;
  contentId: string;
  parentId: string;
  contentHistId: string;
  /** settingsBean `getColumnCount()`. */
  columnCount: number;
  /** Whether the site has `includes/display_objects/custom/admin/dsp_objectClass.cfm` in the legacy web root. */
  customObjectClassInclude: boolean;
  data: ObjectClassData;
  /** `createUUID()`; a fresh CF UUID by default. */
  newId?: () => string;
}

/** `contentRendererUtility.renderObjectClassOption(object, objectid, objectname)` (contentRendererUtility.cfc:1901-1912). */
function objectClassOption(object: string, objectId: string, objectName: string): string {
  const icon = esapiEncode('html_attr', 'mi-cog');
  return (
    '<div class="mura-sidebar__objects-list__object-item mura-objectclass" ' +
    `data-object="${esapiEncode('html_attr', object)}" data-objectid="${esapiEncode('html_attr', objectId)}" ` +
    `data-objectname="${esapiEncode('html_attr', objectName)}" data-objecticonclass="${icon}">` +
    `<i class="${icon}"></i> ${esapiEncode('html', objectName)}</div>`
  );
}

/** The `size` of the legacy object multi-selects: `val((columnCount * 6) - 4)`. */
function multiSelectSize(model: LoadClassModel): string {
  return String(model.columnCount * 6 - 4);
}

/** The class's query, which the route must have supplied. */
function classData<T>(rows: T | undefined, name: keyof ObjectClassData): T {
  if (rows === undefined) throw new RangeError(`renderLoadClass needs data.${name}`);
  return rows;
}

/** objectclass/legacy/dsp_components.cfm. */
function componentsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const label = ctx.labels.key('sitemanager.content.type.component');
  const rows = classData(model.data.components, 'components');
  o.t('\n\t');
  if (model.layoutManager) {
    o.t('\n\t\t<div class="mura-layout-row">\n\t\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.e(objectClassOption('component', row.contentid ?? '', `${label} - ${row.menutitle ?? ''}`));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n\t');
  } else {
    o.t(
      '\n\t\t<div class="mura-layout-row">\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<select name="availableObjects" ' +
        'id="availableObjects" class="multiSelect"\n\t\t\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t('">\n\t\t\t\t\t');
    for (const row of rows) {
      // Inside `cfloop query` the unscoped `title` the view sets resolves to the query's own `title` column first.
      const title = row.title ?? '';
      o.t('\n\t\t\t\t\t\t');
      o.t('\n\t\t\t\t\t\t<option title="');
      o.e(esapiEncode('html_attr', title));
      o.t(`" value="{'object':'Component','name':'`);
      o.e(esapiEncode('html_attr', title));
      o.t("','objectid':'");
      o.e(row.contentid ?? '');
      o.t("'}\">\n\t\t\t\t\t\t\t");
      o.e(esapiEncode('html', title));
      o.t('\n\t\t\t\t\t\t</option>\n\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t</select>\n\t\t\t</div>\n\t\t</div>\n\t');
  }
  o.t('\n\n');
}

/** objectclass/legacy/dsp_mailinglists.cfm. */
function mailingListsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext, newId: () => string): void {
  const { labels } = ctx;
  const rows = classData(model.data.mailingLists, 'mailingLists');
  const master = labels.key('sitemanager.content.fields.mastermailinglistsignupform');
  const listLabel = labels.key('sitemanager.content.fields.mailinglist');
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    o.e(objectClassOption('mailing_list_master', newId(), master));
    o.t('\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.e(objectClassOption('mailing_list', row.mlid, `${listLabel} - ${row.name}`));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    o.t(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t<select name="availableObjects" ' +
        'id="availableObjects" class="multiSelect"\n\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t(`">\n\n\t\t\t<option value="{'object':'mailing_list_master','name':'`);
    o.e(esapiEncode('html_attr', master));
    o.t("','objectid':'none'}\">\n\t\t\t\t");
    o.e(master);
    o.t('\n\t\t\t</option>\n\t\t\t');
    for (const row of rows) {
      o.t(`\n\t\t\t\t<option value="{'object':'mailing_list','name':'`);
      o.e(esapiEncode('html_attr', `Mailing List - ${row.name}`));
      o.t("','objectid':'");
      o.e(row.mlid);
      o.t("'}\">\n\t\t\t\t\t");
      o.e(listLabel);
      o.t('\n\t\t\t\t\t-\n\t\t\t\t\t');
      o.e(row.name);
      o.t('\n\t\t\t\t</option>\n\t\t\t');
    }
    o.t('\n\t\t</select>\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
}

/** objectclass/legacy/dsp_system.cfm (`nav` false) and dsp_navigation.cfm (`nav` true). */
function systemObjectsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext, newId: () => string, nav: boolean): void {
  // The views' query of queries: LIKE and != compare case-sensitively; rows keep their order.
  const rows = classData(model.data.systemObjects, 'systemObjects').filter((row) =>
    nav ? row.object.includes('nav') : !row.object.includes('nav') && (ctx.siteSettings.hasComments || row.object !== 'comments'),
  );
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.e(objectClassOption(row.object, newId(), row.name));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    const indent = nav ? '\t\t' : '\t\t\t';
    o.t(
      `\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n${indent}<select name="availableObjects" ` +
        `id="availableObjects" class="multiSelect"\n${indent}        size="`,
    );
    o.e(multiSelectSize(model));
    o.t(`">\n${indent}\t`);
    for (const row of rows) {
      o.t(`\n${indent}\t\t<option title="`);
      o.e(esapiEncode('html_attr', row.name));
      o.t(`" value='{"object":"`);
      o.e(esapiEncode('javascript', row.object));
      o.t('","name":"');
      o.e(esapiEncode('javascript', row.name));
      o.t('","objectid":"');
      o.e(newId());
      o.t(`"}'>\n${indent}\t\t\t`);
      o.e(esapiEncode('html', row.name));
      o.t(`\n${indent}\t\t</option>\n${indent}\t`);
    }
    o.t(`\n${indent}</select>\n\t\t</div>\n\t</div>\n`);
  }
  o.t('\n');
}

/** objectclass/legacy/dsp_forms.cfm. */
function formsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const { labels } = ctx;
  const rows = classData(model.data.forms, 'forms');
  const titleOf = (row: (typeof rows)[number]): string =>
    `${labels.key(row.responsechart === 1 ? 'sitemanager.content.fields.poll' : 'sitemanager.content.fields.datacollector')} - ${row.menutitle ?? ''}`;
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.t('\n\t\t\t');
      o.e(objectClassOption('form', row.contentid ?? '', titleOf(row)));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    o.t(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t\t<select name="availableObjects" ' +
        'id="availableObjects" class="multiSelect"\n\t\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t('">\n\t\t\t\t');
    for (const row of rows) {
      const id = row.contentid ?? '';
      let title = titleOf(row);
      o.t('\n\t\t\t\t\t');
      o.e(
        `\n\t\t\t\t\t<option title="${esapiEncode('html_attr', title)}" value="{object:'form',name:'` +
          `${esapiEncode('html_attr', title)}',objectid:'${id}'}">\n\t\t\t\t\t\t${esapiEncode('html', title)}` +
          '\n\t\t\t\t\t</option>\n\t\t\t\t\t',
      );
      if (row.responsechart !== 1) {
        title = `${labels.key('sitemanager.content.fields.dataresponses')} - ${row.menutitle ?? ''}`;
        o.t('\n\t\t\t\t\t\t');
        o.e(
          `\n\t\t\t\t\t\t<option title="${esapiEncode('html_attr', title)}" value="{'object':'form_responses','name':'` +
            `${esapiEncode('html_attr', title)}','objectid':'${id}'}">\n\t\t\t\t\t\t\t${esapiEncode('html', title)}` +
            '\n\t\t\t\t\t\t</option>\n\t\t\t\t\t',
        );
      }
      o.t('\n\t\t\t\t');
    }
    o.t('\n\t\t\t</select>\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
}

/** objectclass/legacy/dsp_localfeeds.cfm. */
function localFeedsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const label = ctx.labels.key('sitemanager.content.fields.localindex');
  const rows = classData(model.data.localFeeds, 'localFeeds');
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.t('\n\n\t\t\t');
      o.e(objectClassOption('feed', row.feedid, `${row.name ?? ''} - ${label}`));
      o.t('\n\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    o.t(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t<select name="availableObjects"' +
        '\n\t\t\t\tid="availableObjects"\n\t\t        class="multiSelect"\n\t\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t('">\n\t\t\t\n\t\t\t');
    for (const row of rows) {
      const title = `${row.name ?? ''} - ${label}`;
      o.t('\n\n\t\t\t\t');
      o.e(
        `\n\n\t\t\t\t<option title="${esapiEncode('html_attr', title)}" value="{'object':'feed','objectid':'${row.feedid}',` +
          `'name':'${esapiEncode('javascript', title)}'}">\n\t\t\t\t\t${esapiEncode('html', title)}\n\t\t\t\t</option>\n\t\t\t`,
      );
    }
    o.t('\n\t\t</select>\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
}

/** objectclass/legacy/dsp_remotefeeds.cfm. */
function remoteFeedsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const label = ctx.labels.key('sitemanager.content.fields.remotefeed');
  const rows = classData(model.data.remoteFeeds, 'remoteFeeds');
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.t('\n\n\t\t\t');
      o.e(objectClassOption('feed', row.feedid, `${row.name ?? ''} - ${label}`));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    o.t(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t\t<select name="availableObjects" ' +
        'id="availableObjects" class="multiSelect"\n\t\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t('">\n\t\t\t\t');
    for (const row of rows) {
      const title = `${row.name ?? ''} - ${label}`;
      o.t('\n\n\t\t\t\t\t');
      o.e(
        `\n\n\t\t\t\t\t<option title="${esapiEncode('html_attr', title)}" value="{'object':'feed','name':'` +
          `${esapiEncode('javascript', title)}','objectid':'${row.feedid}'}">\n\t\t\t\t\t\t${esapiEncode('html', title)}` +
          '\n\t\t\t\t\t</option>\n\t\t\t\t',
      );
    }
    o.t('\n\t\t\t</select>\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
}

/** objectclass/legacy/dsp_slideshows.cfm. */
function slideshowsClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const label = ctx.labels.key('sitemanager.content.fields.localindexslideshow');
  const rows = classData(model.data.localFeeds, 'localFeeds');
  o.t('\n');
  if (model.layoutManager) {
    o.t('\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t');
    for (const row of rows) {
      o.t('\n\t\t\t');
      o.t('\n\t\t\t');
      o.e(objectClassOption('feed_slideshow', row.feedid, `${row.name ?? ''} - ${label}`));
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  } else {
    o.t(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t\t<select name="availableObjects"' +
        '\n\t\t\t\t\tid="availableObjects"\n\t\t\t        class="multiSelect"\n\t\t\t\t        size="',
    );
    o.e(multiSelectSize(model));
    o.t('">\n\t\t\t\t');
    for (const row of rows) {
      const title = `${row.name ?? ''} - ${label}`;
      o.t('\n\n\t\t\t\t\t');
      o.e(
        `\n\n\t\t\t\t\t<option title="${esapiEncode('html_attr', title)}" value="{'object':'feed_slideshow','objectid':'` +
          `${row.feedid}','name':'${esapiEncode('javascript', title)}'}">\n\t\t\t\t\t\t${esapiEncode('html', title)}` +
          '\n\t\t\t\t\t</option>\n\t\t\t\t',
      );
    }
    o.t('\n\t\t\t</select>\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
}

/** The `subClassSelector` options of the section classes: one per section, the requested one selected. */
function sectionSelectorRows(o: CfOutput, model: LoadClassModel, sections: readonly ObjectClassSection[], indent: string, lead = ''): void {
  for (const section of sections) {
    if (lead !== '') o.t(lead);
    o.t(`\n${indent}<option value="`);
    o.e(section.contentid);
    o.t('" ');
    if (cfEq(section.contentid, model.subclassid)) o.t('selected');
    o.t('>');
    o.e(esapiEncode('html', section.pathString));
    o.t(`</option>\n${indent.slice(1)}`);
  }
}

/** The `loadObjectClass(siteid, class, this.value, contentid, parentid, contenthistid` call of `subClassSelector`. */
function loadObjectClassCall(model: LoadClassModel, fn: 'mura' | 'siteManager', classid: string): string {
  return `${fn}.loadObjectClass('${model.siteId}','${classid}',this.value,'${model.contentId}','${model.parentId}','${model.contentHistId}`;
}

/** `pathString - <label>`, the title of a section's objects. */
function sectionTitle(ctx: AdminRenderContext, section: ObjectClassSection, key: string): string {
  return `${section.pathString} - ${ctx.labels.key(`sitemanager.content.fields.${key}`)}`;
}

/** A section object `<option>` of the legacy multi-selects, from the blank lines before it to the text after `</option>`. */
function sectionOption(
  indent: string,
  attr: 'title' | 'titlie',
  title: string,
  value: string,
  closing: string,
): string {
  return (
    `\n\n${indent}<option ${attr}="${esapiEncode('html_attr', title)}" value="${value}">\n${indent}\t` +
    `${esapiEncode('html', title)}\n${indent}</option>${closing}`
  );
}

/** The `{'object':…,'name':…,'objectid':…}` value of a section object option. */
function sectionObjectValue(object: string, name: string, id: string): string {
  return `{'object':'${object}','name':'${name}','objectid':'${id}'}`;
}

/** objectclass/legacy/dsp_folders.cfm. */
function foldersClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext): void {
  const sections = classData(model.data.sections, 'sections');
  const selectLabel = ctx.labels.key('sitemanager.content.fields.selectFolder');
  const picked = model.subclassid !== '';
  o.t('\n\n');
  if (model.layoutManager) {
    o.e(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t<select name="subClassSelector"\n\t\t        onchange="' +
        `${loadObjectClassCall(model, 'mura', 'Folder')}');">\n\t\t\t<option value="">\n\t\t\t\t${selectLabel}\n\t\t\t</option>\n\t\t\t`,
    );
    sectionSelectorRows(o, model, sections, '\t\t\t\t');
    o.t('\n\t\t</select>\n\n\t\t');
    if (picked) {
      o.t('\n\t\t\t');
      for (const section of sections) {
        o.t('\n\t\t\t\t');
        if (cfEq(section.contentid, model.subclassid)) {
          o.t('\n\t\t\t\t\t');
          const objects = ['category_summary', 'related_section_content', 'calendar_nav', 'archive_nav'] as const;
          const keys = ['categorysummary', 'relatedcontent', 'calendarnavigation', 'archivenavigation'] as const;
          objects.forEach((object, i) => {
            o.t('\n\n\t\t\t\t\t');
            o.e(objectClassOption(object, section.contentid, sectionTitle(ctx, section, keys[i] as string)));
            o.t(i < objects.length - 1 ? '\n\n\t\t\t\t\t' : '\n\t\t\t\t');
          });
        }
        o.t('\n\t\t\t');
      }
      o.t('\n\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n\n');
  } else {
    o.e(
      '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t\t<select name="subClassSelector"' +
        `\n\t\t\t        onchange="${loadObjectClassCall(model, 'siteManager', 'Folder')}',0,0);"\n\t\t\t        class="dropdown">` +
        `\n\t\t\t\t<option value="">\n\t\t\t\t\t${selectLabel}\n\t\t\t\t</option>\n\t\t\t\t`,
    );
    sectionSelectorRows(o, model, sections, '\t\t\t\t\t');
    o.t('\n\t\t\t</select>\n\n\n\t\t');
    if (picked) {
      o.e(
        '\n\t\t\t<div class="mura-control justify">\n\t\t\t<select name="availableObjects" id="availableObjects" class="multiSelect"' +
          `\n\t\t\t        size="${multiSelectSize(model)}"\n\t\t\t        >\n\t\t\t\t`,
      );
      for (const section of sections) {
        o.t('\n\t\t\t\t\t');
        if (cfEq(section.contentid, model.subclassid)) {
          const id = section.contentid;
          const indent = '\t\t\t\t\t\t';
          const summary = sectionTitle(ctx, section, 'categorysummary');
          const related = sectionTitle(ctx, section, 'relatedcontent');
          const calendar = sectionTitle(ctx, section, 'calendarnavigation');
          const archive = sectionTitle(ctx, section, 'archivenavigation');
          o.t('\n\t\t\t\t\t\t');
          o.e(
            sectionOption(indent, 'title', summary, sectionObjectValue('category_summary', esapiEncode('javascript', summary), id), `\n\n${indent}`) +
              sectionOption(indent, 'title', related, sectionObjectValue('related_section_content', esapiEncode('html_attr', related), id), `\n\n${indent}`) +
              sectionOption(indent, 'titlie', calendar, sectionObjectValue('calendar_nav', esapiEncode('html', calendar), id), `\n\n${indent}`) +
              sectionOption(indent, 'title', archive, `archive_nav~${esapiEncode('html', archive)}~${id}`, '\n\t\t\t\t\t'),
          );
        }
        o.t('\n\t\t\t\t');
      }
      o.t('\n\t\t\t</select>\n\t\t\t</div>\n\t\t');
    }
    o.t('\n\t</div>\n</div>\n');
  }
  o.t('\n\n');
}

/** The category summary, related content and calendar navigation objects of the picked section, layout-manager form. */
function sectionObjectClassOptions(o: CfOutput, ctx: AdminRenderContext, section: ObjectClassSection, beforeCalendar: string): void {
  o.t('\n\t\t\t\t\t');
  o.t('\n\n\t\t\t\t\t');
  o.t('\n\n\t\t\t\t\t');
  o.e(objectClassOption('category_summary', section.contentid, sectionTitle(ctx, section, 'categorysummary')));
  o.t('\n\n\t\t\t\t\t');
  o.t('\n\n\t\t\t\t\t');
  o.e(objectClassOption('related_section_content', section.contentid, sectionTitle(ctx, section, 'relatedcontent')));
  o.t('\n\n\t\t\t\t\t');
  o.t(beforeCalendar);
  o.e(objectClassOption('calendar_nav', section.contentid, sectionTitle(ctx, section, 'calendarnavigation')));
  o.t('\n\t\t\t\t');
}

/** objectclass/legacy/dsp_calendars.cfm (`gallery` false) and dsp_galleries.cfm (`gallery` true). */
function calendarsOrGalleriesClass(o: CfOutput, model: LoadClassModel, ctx: AdminRenderContext, gallery: boolean): void {
  const sections = classData(model.data.sections, 'sections');
  const classid = gallery ? 'gallery' : 'calendar';
  const selectLabel = ctx.labels.key(`sitemanager.content.fields.select${classid}`);
  const picked = model.subclassid !== '';
  o.t('\n');
  if (model.layoutManager) {
    o.e(
      gallery
        ? '\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n\t\t<select name="subClassSelector"' +
            `\n\t\t        onchange="${loadObjectClassCall(model, 'mura', classid)}',0,0);"\n\t\t        class="dropdown">`
        : '\n<div class="mura-layout-row">\n\t<div class="mura-control-group">\n\t\t<select name="subClassSelector"' +
            `\n\t\t        onchange="${loadObjectClassCall(model, 'mura', classid)}');">`,
    );
    o.e(`\n\t\t\t<option value="">\n\t\t\t\t${selectLabel}\n\t\t\t</option>\n\t\t\t`);
    sectionSelectorRows(o, model, sections, '\t\t\t\t', '\n\t\t\t\t');
    o.t(gallery ? '\n\t\t</select>\n\n\t\t' : '\n\t\t</select>\n\t\t');
    if (picked) {
      o.t('\n\t\t\t');
      for (const section of sections) {
        o.t('\n\t\t\t\t');
        if (cfEq(section.contentid, model.subclassid)) {
          sectionObjectClassOptions(o, ctx, section, gallery ? '\n\n\t\t\t\t\t' : '\n\n\n\t\t\t\t\t');
        }
        o.t('\n\t\t\t');
      }
      o.t('\n\t\t');
    }
    o.t(gallery ? '\n\t\t</div>\n\t</div>\n' : '\n\t</div>\n<div>\n\n');
  } else {
    const indent = gallery ? '\t\t\t' : '\t\t';
    o.e(
      `\n\t<div class="mura-layout-row">\n\t\t<div class="mura-control-group">\n${indent}<select name="subClassSelector"` +
        `\n${indent}        onchange="${loadObjectClassCall(model, 'siteManager', classid)}',0,0);"\n${indent}        class="dropdown">` +
        `\n${indent}\t<option value="">\n${indent}\t\t${selectLabel}\n${indent}\t</option>\n${indent}\t`,
    );
    sectionSelectorRows(o, model, sections, `${indent}\t\t`, `\n${indent}\t\t`);
    o.t(gallery ? '\n\t\t\t</select>\n\t' : '\n\t\t</select>\n\t\t');
    if (picked) {
      const listIndent = gallery ? '\t\t' : '\t\t\t';
      o.e(
        `\n${listIndent}<div class="mura-control justify">\n${listIndent}<select name="availableObjects" id="availableObjects" ` +
          `class="multiSelect"\n${listIndent}        size="${multiSelectSize(model)}">\n${listIndent}\t`,
      );
      for (const section of sections) {
        o.t(`\n${listIndent}\t\t`);
        if (cfEq(section.contentid, model.subclassid)) {
          const id = section.contentid;
          const optionIndent = `${listIndent}\t\t\t`;
          const summary = sectionTitle(ctx, section, 'categorysummary');
          const related = sectionTitle(ctx, section, 'relatedcontent');
          const calendar = sectionTitle(ctx, section, 'calendarnavigation');
          o.t(`\n${optionIndent}`);
          o.t(`\n\n${optionIndent}`);
          o.e(
            sectionOption(optionIndent, 'title', summary, sectionObjectValue('category_summary', esapiEncode('javascript', summary), id), `\n\n${optionIndent}`) +
              sectionOption(
                optionIndent,
                'title',
                related,
                sectionObjectValue('related_section_content', esapiEncode(gallery ? 'javascript' : 'html_attr', related), id),
                `\n\n${optionIndent}`,
              ),
          );
          if (gallery) {
            o.e(
              sectionOption(optionIndent, 'titlie', calendar, sectionObjectValue('calendar_nav', esapiEncode('html', calendar), id), `\n${listIndent}\t\t`),
            );
          } else {
            // dsp_calendars.cfm indents this option's text one tab less and closes it twice.
            o.e(
              `\n\n${optionIndent}<option title="${esapiEncode('html_attr', calendar)}" value="calendar_nav~${esapiEncode('html', calendar)}~${id}">` +
                `\n${optionIndent}${esapiEncode('html', calendar)}\n${optionIndent}</option>\n${listIndent}\t\t</option>\n${listIndent}\t\t`,
            );
          }
        }
        o.t(`\n${listIndent}\t`);
      }
      o.t(`\n${listIndent}</select>\n${listIndent}</div>\n${gallery ? '\t' : '\t\t'}`);
    }
    o.t(gallery ? '\n\t</div>\n\t</div>\n' : '\n\t\t<div>\n\t</div>\n');
  }
  o.t('\n');
}

/** `carch.loadclass` (loadclass.cfm): the legacy display-object list of `classid`, as its objectclass/legacy include prints it. */
export function renderLoadClass(model: LoadClassModel, ctx: AdminRenderContext): PanelRenderResult | PanelDelegation {
  // cfswitch matches case values without regard to case.
  const classid = model.classid.toLowerCase();
  if (classid === 'plugins' || classid === 'plugin') {
    return { delegate: 'legacy', reason: 'plugin object classes are rendered by the CFML plugin runtime' };
  }
  if (!model.layoutManager && model.customObjectClassInclude) {
    return { delegate: 'legacy', reason: "the site's custom admin dsp_objectClass.cfm is CFML" };
  }
  const newId = model.newId ?? cfUuid;
  const o = new CfOutput();
  const include = (render: () => void): void => {
    o.t('\n\t\t');
    render();
    o.t('\n\t');
  };
  o.t('\n\n');
  switch (classid) {
    case 'component':
      include(() => componentsClass(o, model, ctx));
      break;
    case 'mailinglist':
      include(() => mailingListsClass(o, model, ctx, newId));
      break;
    case 'system':
      include(() => systemObjectsClass(o, model, ctx, newId, false));
      break;
    case 'navigation':
      include(() => systemObjectsClass(o, model, ctx, newId, true));
      break;
    case 'form':
      include(() => formsClass(o, model, ctx));
      break;
    case 'folder':
      include(() => foldersClass(o, model, ctx));
      break;
    case 'calendar':
      include(() => calendarsOrGalleriesClass(o, model, ctx, false));
      break;
    case 'gallery':
      include(() => calendarsOrGalleriesClass(o, model, ctx, true));
      break;
    case 'localfeed':
      include(() => localFeedsClass(o, model, ctx));
      break;
    case 'slideshow':
      include(() => slideshowsClass(o, model, ctx));
      break;
    case 'remotefeed':
      include(() => remoteFeedsClass(o, model, ctx));
      break;
    default:
      break;
  }
  o.t('\n\n');
  if (!model.layoutManager) {
    o.t('\n\t');
    o.t('\n');
  }
  o.t('\n\n');
  return viewResult(o);
}

/** Inputs of {@link renderLoadClassConfigurator}: the `rc` values and the site's display-object registry. */
export interface LoadClassConfiguratorModel {
  classid: string;
  container: string;
  /** configBean `allowopenfeeds`. */
  allowOpenFeeds: boolean;
  /** `$.useLayoutManager()`. */
  useLayoutManager: boolean;
  /** `$.siteConfig().getDisplayObject(classid)`: undefined for an unregistered class, which legacy answers with a 500. */
  displayObject: (classid: string) => { external?: boolean } | undefined;
  /** `$.siteConfig().lookupDisplayObjectFilePath(suffix)`: the configurator CFML a theme, site or module provides, or ''. */
  lookupDisplayObjectFile: (suffix: string) => string;
}

const SYSTEM_OBJECT_CLASSES: readonly string[] = [
  'comments', 'favorites', 'forward_email', 'event_reminder_form', 'rater', 'paypalcart', 'user_tools', 'gotofirstchild',
];
const NAV_OBJECT_CLASSES: readonly string[] = [
  'sub_nav', 'peer_nav', 'standard_nav', 'portal_nav', 'folder_nav', 'multilevel_nav', 'seq_nav', 'top_nav', 'calendar_nav',
  'archive_nav', 'tag_cloud', 'category_summary',
];
const LEGACY_CONFIGURATOR_CLASSES: readonly string[] = ['feed', 'feed_slideshow', 'related_content', 'related_section_content'];

/** `listLast(replace(value, "\", "/", "ALL"), "/")`. */
function lastPathItem(value: string): string {
  return cfListToArray(value.replaceAll('\\', '/'), '/').at(-1) ?? '';
}

/** loadclassconfigurator.cfm's own "not configurable" notice; branches that include configurator CFML stay legacy-served. */
export function renderLoadClassConfigurator(model: LoadClassConfiguratorModel): PanelRenderResult | PanelDelegation {
  let classid = lastPathItem(model.classid);
  const container = lastPathItem(model.container);
  if (cfEq(classid, 'category_summary') && !model.allowOpenFeeds) classid = 'nav';
  if (cfEq(classid, 'form_responses')) classid = 'form';
  else if (cfEq(classid, 'mailing_list_master')) classid = 'mailing_list';
  else if (inNoCaseList(SYSTEM_OBJECT_CLASSES, classid)) classid = 'system';
  else if (inNoCaseList(NAV_OBJECT_CLASSES, classid)) classid = 'nav';
  let suffix = `${classid}/layout/index.cfm`;
  if (!cfEq(container, 'layout')) {
    const objectConfig = model.displayObject(classid);
    if (objectConfig === undefined) return { delegate: 'legacy', reason: `${classid} is not a registered display object` };
    suffix = objectConfig.external === true ? 'external/configurator.cfm' : `${classid}/configurator.cfm`;
  }
  if (model.lookupDisplayObjectFile(suffix) !== '') {
    return { delegate: 'legacy', reason: `the ${suffix} configurator is CFML` };
  }
  if (inNoCaseList(LEGACY_CONFIGURATOR_CLASSES, classid)) {
    return { delegate: 'legacy', reason: `the legacy ${classid} configurator include is CFML` };
  }
  if (model.useLayoutManager) {
    return { delegate: 'legacy', reason: 'cf_objectconfigurator is a CFML custom tag' };
  }
  const o = new CfOutput();
  o.t('\n\t\t\t\t\t<div class="help-block-empty">This display object is not configurable.</div>\n\t\t\t\t');
  return viewResult(o);
}

// --- Extended attributes ---

/** One attribute of an extend set, as its `extendAttribute` bean holds it. */
export type ExtendAttributeModel = Pick<
  ExtendAttributeRow,
  | 'attributeid'
  | 'name'
  | 'label'
  | 'hint'
  | 'type'
  | 'required'
  | 'validation'
  | 'regex'
  | 'message'
  | 'defaultvalue'
  | 'optionlist'
  | 'optionlabellist'
  | 'adminonly'
>;

/** An active extend set with its active attributes, in `getExtendSets` order. */
export interface ExtendSetModel extends Pick<ExtendSetRow, 'extendsetid' | 'categoryid' | 'name'> {
  attributes: readonly ExtendAttributeModel[];
}

/** `rc.tablist` when the request names none (loadextendedattributes.cfm). */
export const DEFAULT_EXTENDED_ATTRIBUTE_TABLIST =
  'tabBasic,tabSEO,tabAdvanced,tabCategorization,tabExtendedAttributes,tabLayoutObjects,tabListDisplayOptions,tabMobile,' +
  'tabPublishing,tabTags,tabUsagereport';

/** Inputs of {@link renderLoadExtendedAttributes}. */
export interface ExtendedAttributesModel {
  /** `subtype.getExtendSets(inherit=true, container, activeOnly=true)` per tab container (`Extended Attributes` as `Default`). */
  setsByContainer: Readonly<Record<string, readonly ExtendSetModel[]>>;
  /** `contentBean.getValue(name)` per attribute name the bean holds: extend data and same-named bean properties (`notes`). */
  values: Readonly<Record<string, string>>;
  /** The subtype's flags; a subtype without a `tclassextend` row has Masa's defaults 1, 1, 1 and 0. */
  subtype: Pick<ExtendSubtypeRow, 'hassummary' | 'hasbody' | 'hasassocfile' | 'hasconfigurator'>;
  /** `rc.tablist`. */
  tablist?: string;
  /** Whether the site's Razuna settings name a hostname. */
  razunaEnabled: boolean;
}

/** `contentManager.getTabList()`. */
const CONTENT_TAB_CONTAINERS: readonly string[] = [
  'Basic', 'SEO', 'Summary', 'Image', 'Publishing', 'Scheduling', 'Layout & Objects', 'Categorization', 'Tags',
  'Related Content', 'Extended Attributes', 'Remote',
];

// contentRenderer.setDynamicContent evaluates these tags as CFML (contentRenderer.cfc:2699-2704).
const MURA_TAG = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;
const USE_MURA_DEFAULT = 'useMuraDefault';

/** Case-insensitive bean value lookup, `useMuraDefault` when the bean holds none. */
function attributeValue(values: Readonly<Record<string, string>>, name: string): string {
  const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? USE_MURA_DEFAULT : (values[key] as string);
}

/** The attribute's type once the view turns Hidden into TextBox, lower-cased as cfswitch matches it. */
function attributeType(attribute: ExtendAttributeModel): string {
  const type = (attribute.type ?? '').toLowerCase();
  return type === 'hidden' ? 'textbox' : type;
}

/** Why only CFML can render the attribute, or undefined when this module can. */
function cfmlOnlyAttribute(attribute: ExtendAttributeModel, value: string, readonly: boolean): string | undefined {
  const type = attributeType(attribute);
  const dynamic = cfEq(value, USE_MURA_DEFAULT) ? [attribute.defaultvalue ?? ''] : [];
  if (!readonly && (type === 'selectbox' || type === 'multiselectbox' || type === 'radiogroup')) {
    dynamic.push(attribute.optionlist ?? '', attribute.optionlabellist ?? '');
  }
  if (dynamic.some((text) => MURA_TAG.test(text))) return `attribute ${attribute.name ?? ''} holds a [mura] tag`;
  if (readonly) return undefined;
  if ((type === 'textbox' || type === 'text') && cfEq(attribute.validation ?? '', 'datetime')) {
    return `attribute ${attribute.name ?? ''} renders through cf_datetimeselector`;
  }
  if (type === 'file') return `attribute ${attribute.name ?? ''} renders through cf_fileselector`;
  return undefined;
}

/** ` data-message="…"` when the attribute has a message. */
function dataMessage(o: CfOutput, attribute: ExtendAttributeModel): void {
  const message = attribute.message ?? '';
  if (message === '') return;
  o.t(' data-message="');
  o.e(xmlFormat(message));
  o.t('"');
}

/** ` data-validate` and ` data-regex` of text inputs and text areas. */
function dataValidation(o: CfOutput, attribute: ExtendAttributeModel): void {
  const validation = attribute.validation ?? '';
  if (validation !== '') {
    o.t(' data-validate="');
    o.e(validation);
    o.t('"');
  }
  if (cfEq(validation, 'Regex')) {
    o.t(' data-regex="');
    o.e(attribute.regex ?? '');
    o.t('"');
  }
}

/** `listGetAt(list, position, '^')`, which throws past the end of the list as ACF does. */
function caretListItem(items: readonly string[], position: number, list: string): string {
  const item = items[position];
  if (item === undefined) throw new RangeError(`Invalid list index ${position + 1} of ${list}`);
  return item;
}

/** extendAttribute.renderAttribute (extendAttribute.cfc:505-582) for the types {@link cfmlOnlyAttribute} accepts. */
function renderAttribute(attribute: ExtendAttributeModel, theValue: string, readonly: boolean, ctx: AdminRenderContext): string {
  const renderValue = cfEq(theValue, USE_MURA_DEFAULT) ? (attribute.defaultvalue ?? '') : theValue;
  if (readonly) return renderValue;
  const key = attribute.name ?? '';
  const label = xmlFormat(attribute.label ?? '');
  const required = attribute.required ?? '';
  const validation = attribute.validation ?? '';
  const o = new CfOutput();
  switch (attributeType(attribute)) {
    case 'textbox':
    case 'text': {
      const value = cfEq(validation, 'date') ? lsDateText(renderValue, ctx.session.dateKeyFormat) : renderValue;
      if (cfEq(validation, 'color')) {
        o.t(
          '\n\n\t\t\t\t\t\t\t<div class="input-group mura-colorpicker">\n\t\t\t\t\t\t\t\t<span class="input-group-addon">' +
            '<i class="mura-colorpicker-swatch" style="background-color:',
        );
        o.e(cfHtmlEditFormat(value));
        o.e(`"></i></span>\n\t\t\t\t\t\t\t\t<input type="text" id="${key}" name="${key}" placeholder="Select Color" autocomplete="off"  value="`);
        o.e(`${cfHtmlEditFormat(value)}" data-label="${label}" data-required="${required}`);
        o.t('"');
        dataMessage(o, attribute);
        o.t('>\n\t\t\t\t\t\t\t</div>\n\n\t\t\t\t\t\t');
      } else {
        o.e(`\n\n\t\t\t\t\t\t\t<input type="text" name="${key}" class="text`);
        if (cfEq(validation, 'date')) o.t(' datepicker');
        o.e(`" id="${key}" data-label="${label}" value="${cfHtmlEditFormat(value)}" data-required="${required}`);
        o.t('"');
        dataValidation(o, attribute);
        dataMessage(o, attribute);
        o.t(' />\n\n\t\t\t\t\t\t');
      }
      o.t('\t\n\n\t\t\t\t\t\t');
      break;
    }
    case 'textarea':
    case 'htmleditor':
      o.e(`<textarea name="${key}" id="${key}" data-label="${label}" data-required="${required}`);
      o.t('"');
      dataMessage(o, attribute);
      if (attributeType(attribute) === 'htmleditor') o.t(' class="htmlEditor"');
      dataValidation(o, attribute);
      o.e(`>${cfHtmlEditFormat(renderValue)}</textarea>`);
      break;
    case 'selectbox':
    case 'multiselectbox': {
      const multiple = attributeType(attribute) === 'multiselectbox';
      const optionList = attribute.optionlist ?? '';
      const options = cfListToArray(optionList, '^');
      const labelList = attribute.optionlabellist ?? '';
      const labels = cfListToArray(labelList, '^');
      if (multiple) o.e(`<input type="hidden" name="${key}" value="" />`);
      o.e(`<select name="${key}" id="${key}" data-label="${label}" data-required="${required}`);
      o.t('"');
      dataMessage(o, attribute);
      if (multiple) o.t(' multiple="multiple"');
      o.t('>');
      options.forEach((option, i) => {
        o.e(`<option value="${xmlFormat(option)}`);
        o.t('"');
        const selected =
          cfEq(option, renderValue) ||
          cfListToArray(renderValue, '^').includes(option) ||
          cfListToArray(renderValue).includes(option);
        if (selected) o.t(' selected="selected"');
        o.t('>');
        o.e(labelList !== '' ? caretListItem(labels, i, labelList) : option);
        o.t('</option>');
      });
      o.t('</select>');
      break;
    }
    case 'radiogroup': {
      const optionList = attribute.optionlist ?? '';
      const labelList = attribute.optionlabellist ?? '';
      const labels = cfListToArray(labelList, '^');
      cfListToArray(optionList, '^').forEach((option, i) => {
        o.e(`<label class="radio inline"><input type="radio" id="${key}" name="${key}" value="${xmlFormat(option)}`);
        o.t('"');
        if (cfEq(option, renderValue)) o.t(' checked="checked"');
        o.t(' /> ');
        o.e(labelList !== '' ? caretListItem(labels, i, labelList) : option);
        o.t('</label> ');
      });
      break;
    }
    default:
      break;
  }
  return o.toString();
}

/** The URL attribute's asset browser buttons (loadextendedattributes.cfm). */
function assetBrowserButtons(o: CfOutput, attribute: ExtendAttributeModel, model: ExtendedAttributesModel, ctx: AdminRenderContext): void {
  const target = esapiEncode('javascript', attribute.name ?? '');
  o.t('\n\t\t\t\t\t\t\t\t\t');
  if (model.razunaEnabled) {
    o.t(
      '\n\t\t\t\t\t\t\t\t\t\t<div class="btn-group">\n\t\t\t\t\t\t\t\t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" ' +
        'href="#">\n\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-folder-open"></i> ',
    );
    o.e(ctx.labels.key('sitemanager.content.browseassets'));
    o.t(
      '\n\t\t\t\t\t\t\t\t\t\t\t</a>\n\t\t\t\t\t\t\t\t\t\t\t<ul class="dropdown-menu">\n\t\t\t\t\t\t\t\t\t\t\t\t<li><a href="#" ' +
        'type="button" data-completepath="false" data-target="',
    );
    o.e(target);
    o.t(
      '" data-resourcetype="user" class="mura-file-type-selector" title="Select a File from Server">' +
        '\n\t\t\t\t\t\t\t\t\t\t\t\t\t<i class="mi-folder-open"></i> ',
    );
    o.e(ctx.labels.key('sitemanager.content.local'));
    o.t("</a></li>\n\t\t\t\t\t\t\t\t\t\t\t\t<li><a href=\"#\" type=\"button\" onclick=\"renderRazunaWindow('");
    o.e(target);
    o.t(
      "');return false;\" class=\"mura-file-type-selector btn-razuna-icon\" value=\"URL-Razuna\" title=\"Select a File from " +
        'Razuna"><i></i> Razuna</a></li>\n\t\t\t\t\t\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t',
    );
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t\t<div class="btn-group">\n\t\t\t\t\t\t\t\t\t\t\t<button type="button" data-target="');
    o.e(target);
    o.t(
      '" data-resourcetype="user" class="btn mura-file-type-selector" title="Select a File from Server"><i class="mi-folder-open">' +
        '</i> Browse Assets</button>\n\t\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t\t',
    );
  }
  o.t('\n\t\t\t\t\t\t\t\t');
}

/** The `cfsavecontent` of one container's extend sets, before the view trims it (loadextendedattributes.cfm). */
function extendSetsMarkup(
  sets: readonly ExtendSetModel[],
  model: ExtendedAttributesModel,
  ctx: AdminRenderContext,
  isReadonly: (attribute: ExtendAttributeModel) => boolean,
): string {
  const o = new CfOutput();
  o.t('\n\t\t\t');
  if (sets.length > 0) {
    o.t('\n\t\t\t\t');
    for (const set of sets) {
      const id = set.extendsetid;
      o.t('\n\t\t\t\t\t');
      o.t('\n\t\t\t\t\t');
      o.e(
        `\n\t\t\t\t\t<span class="extendset" extendsetid="${id}" categoryid="${set.categoryid ?? ''}" >` +
          `\n\t\t\t\t\t\t<input name="extendSetID" type="hidden" value="${id}" />\n\t\t\t\t\t\t<h2>${esapiEncode('html', set.name)}</h2>\n\t\t\t\t\t\t`,
      );
      o.t('\n\t\t\t\t\t\t');
      for (const attribute of set.attributes) {
        const readonly = isReadonly(attribute);
        const label = attribute.label ?? '';
        const hint = attribute.hint ?? '';
        o.t('\n\t\t\t\t\t\t\t');
        o.t('\n\t\t\t\t\t\t\t');
        o.t('\n\t\t\t\t\t\t\t');
        o.t('\n\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t');
        if (cfEq(attribute.type ?? '', 'Hidden')) {
          o.t('\n\t\t\t\t\t\t\t\t');
          o.t('\n\t\t\t\t\t\t\t');
        }
        o.t('\n\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t');
        if (hint !== '') {
          o.e(
            '\n\t\t\t\t\t\t\t\t\t\t<span\n\t\t\t\t\t\t\t\t\t\t\tdata-toggle="popover"\n\t\t\t\t\t\t\t\t\t\t\ttitle=""' +
              `\n\t\t\t\t\t\t\t\t\t\t\tdata-placement="right"\n\t\t\t\t\t\t\t\t\t\t\tdata-content="${esapiEncode('html_attr', hint)}"` +
              `\n\t\t\t\t\t\t\t\t\t\t\tdata-original-title="${esapiEncode('html_attr', label)}">\n\t\t\t\t\t\t\t\t\t\t\t` +
              `${esapiEncode('html', label)} <i class="mi-question-circle"></i>\n\t\t\t\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t\t\t\t`,
          );
        } else {
          o.t('\n\t\t\t\t\t\t\t\t\t\t');
          o.e(esapiEncode('html', label));
          o.t('\n\t\t\t\t\t\t\t\t\t');
        }
        o.t('\n\t\t\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t\t\t');
        o.e(renderAttribute(attribute, attributeValue(model.values, attribute.name ?? ''), readonly, ctx));
        o.t('\n\n\t\t\t\t\t\t\t\t');
        if (!readonly && cfEq(attribute.validation ?? '', 'URL')) assetBrowserButtons(o, attribute, model, ctx);
        o.t('\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t');
      }
      o.t('\n\t\t\t\t\t</span>\n\t\t\t\t');
    }
    o.t('\n\t\t\t');
  }
  o.t('\n\t\t');
  return o.toString();
}

/** loadextendedattributes.cfm; datetime and file selectors and `[mura]` tags render CFML, so those stay legacy-served. */
export function renderLoadExtendedAttributes(model: ExtendedAttributesModel, ctx: AdminRenderContext): PanelRenderResult | PanelDelegation {
  const privileged = isS2(ctx.session) || isSiteAdmin(ctx.session, ctx.siteSettings.privateUserPoolId);
  const isReadonly = (attribute: ExtendAttributeModel): boolean => (attribute.adminonly ?? 0) !== 0 && !privileged;
  for (const sets of Object.values(model.setsByContainer)) {
    for (const attribute of sets.flatMap((set) => set.attributes)) {
      const reason = cfmlOnlyAttribute(attribute, attributeValue(model.values, attribute.name ?? ''), isReadonly(attribute));
      if (reason !== undefined) return { delegate: 'legacy', reason };
    }
  }
  // Keys are lower-case because mura.json lower-cases them. Members keep this order rather than ACF's hash order, which
  // varies with the key set: the response is compared as JSON, whose member order carries no meaning.
  const returnsets: Record<string, unknown> = {};
  for (const tab of CONTENT_TAB_CONTAINERS) {
    const container = tab === 'Extended Attributes' ? 'Default' : tab;
    const containerId = container.replace(/[^\\\w]/g, '').toLowerCase();
    returnsets[containerId] = javaTrim(extendSetsMarkup(model.setsByContainer[container] ?? [], model, ctx, isReadonly));
  }
  for (const tab of cfListToArray(model.tablist ?? DEFAULT_EXTENDED_ATTRIBUTE_TABLIST)) {
    for (const context of ['top', 'bottom']) returnsets[`${tab}${context}`.toLowerCase()] = '';
  }
  returnsets['hassummary'] = model.subtype.hassummary;
  returnsets['hasbody'] = model.subtype.hasbody;
  returnsets['hasassocfile'] = model.subtype.hasassocfile;
  returnsets['hasconfigurator'] = model.subtype.hasconfigurator;
  return {
    status: 200,
    contentType: LEGACY_JSON_CONTENT_TYPE,
    body: muraJsonEncode(returnsets).replace(/[\u0000-\u001f\u007f]/g, ''),
    muraSessionEffects: { clearEditBean: true },
  };
}

// --- Files ---

/** Inputs of {@link renderLoadFileMetadata}. */
export interface FileMetadataModel {
  /** The `fileMetaData` bean of (fileid, contenthistid, siteid): its stored row, or the file's own values on a new bean. */
  meta: Pick<
    FileMetadataRow,
    'fileid' | 'caption' | 'credits' | 'alttext' | 'remoteid' | 'remoteurl' | 'remotesource' | 'remotesourceurl' | 'exif'
  >;
  /** The file's `tfiles.fileExt`. */
  fileExt: FileRow['fileext'];
}

const GPS_EXIF_TAGS: readonly string[] = [
  'GPS Altitude', 'GPS Altitude Ref', 'GPS Latitude', 'GPS Latitude Ref', 'GPS Longitude', 'GPS Longitude Ref',
  'GPS Img Direction', 'GPS Time-Stamp',
];

/** contentFileMetaDataBean `getExifTag(tag)`: the tag of the deserialized `exif` JSON, '' when absent. */
function exifTag(exif: string | null, tag: string): string {
  if (exif === null || exif === '') return '';
  const parsed: unknown = JSON.parse(exif);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('exif is not a JSON object');
  const record = parsed as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === tag.toLowerCase());
  const value = key === undefined ? null : record[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  throw new TypeError(`exif tag ${tag} is not a simple value`);
}

/** One labelled metadata input of the Advanced tab (loadfilemetadata.cfm). */
function metadataInput(o: CfOutput, ctx: AdminRenderContext, labelKey: string, property: string, value: string, extraClass = ''): void {
  o.e(
    `\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t${ctx.labels.key(labelKey)}` +
      `\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<input type="text" data-property="${property}" value="${value}"  maxlength="255" ` +
      `class="filemeta${extraClass}">\n\t\t\t\t\t</div>`,
  );
}

/** `carch.loadfilemetadata` (loadfilemetadata.cfm): the caption, credits, alt text, EXIF and remote fields of a file. */
export function renderLoadFileMetadata(model: FileMetadataModel, ctx: AdminRenderContext): PanelRenderResult {
  const { labels } = ctx;
  const { meta } = model;
  const fileExt = model.fileExt ?? '';
  const o = new CfOutput();
  o.e(
    '\n<div class="block block-constrain">\n\t<ul class="mura-tabs nav-tabs">\n\t\t<li class="active">\n\t\t\t<a href="#tabFileMetaBasic" ' +
      `data-toggle="tab"><span>${labels.key('sitemanager.content.tabs.basic')}</span></a>\n\t\t</li>\n\t\t<li>\n\t\t\t` +
      `<a href="#tabFileMetaExifData" data-toggle="tab"><span>${labels.key('sitemanager.filemetadata.exifdata')}</span></a>` +
      '\n\t\t</li>\n\t\t<li>\n\t\t\t<a href="#tabFileMetaAdvanced" data-toggle="tab"><span>' +
      `${labels.key('sitemanager.content.tabs.advanced')}</span></a>\n\t\t</li>\n\t</ul>\n\t<div class="tab-content block-content">` +
      '\n\t\t<div id="tabFileMetaBasic" class="tab-pane active">\n\t\t\t<!-- block -->\n\t\t  \t<div class="block block-bordered">' +
      '\n\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t<h3 class="block-title">' +
      `${labels.key('sitemanager.content.tabs.basic')}</h3>\n\t\t\t\t\t</div>\n\t\t\t\t<div class="block-content">\n\t\t\t\t \t`,
  );
  if (inNoCaseList(['png', 'jpg', 'jpeg', 'svg', 'gif'], fileExt)) {
    const src = imageUrl(ctx.site, {
      fileId: meta.fileid ?? '',
      fileExt,
      size: 'medium',
      direct: false,
      complete: false,
      height: 'AUTO',
      width: 'AUTO',
      useProtocol: false,
    });
    o.e(
      `\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t${labels.key('sitemanager.filemetadata.image')}` +
        `\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<div class="mura-control justify">\n\t\t\t\t\t\t\t<img src="${src}"/>` +
        '\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t',
    );
  }
  o.e(
    `\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t${labels.key('sitemanager.filemetadata.caption')}` +
      '\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<textarea id="file-caption" data-property="caption" class="filemeta htmlEditor">' +
      `${meta.caption ?? ''}</textarea>\n\t\t\t\t\t</div>\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>` +
      `\n\t\t\t\t\t\t\t${labels.key('sitemanager.filemetadata.credits')}\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t` +
      `<textarea id="file-credits" data-property="credits" class="filemeta htmlEditor">${meta.credits ?? ''}</textarea>` +
      '\n\t\t\t\t\t</div>\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t' +
      `${labels.key('sitemanager.filemetadata.alttext')}\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<input type="text" ` +
      `data-property="alttext" value="${esapiEncode('html_attr', meta.alttext)}"  maxlength="255" class="filemeta">` +
      '\n\t\t\t\t\t</div>\n\t\t\t\t\t<div class="mura-control-group">\n\n\t\t\t\t\t\t<label class="checkbox" ' +
      'for="filemeta-setasdefault">\n\t\t\t\t\t\t\t<input type="checkbox" id="filemeta-setasdefault"> ' +
      `${labels.key('sitemanager.filemetadata.setasdefault')}\n\t\t\t\t\t\t</label>\n\t\t\t\t\t</div>\n\t\t\t\t\t` +
      '\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>\n\t\t<div id="tabFileMetaExifData" class="tab-pane">\n\t\t\t<!-- block -->' +
      '\n\t\t\t  <div class="block block-bordered">\n\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t<h3 class="block-title">' +
      `${labels.key('sitemanager.filemetadata.exifdata')}</h3>\n\t  \t\t\t</div>\n  \t\t\t\t<div class="block-content">\n\t\t\t\t`,
  );
  o.t('\n\t\t\t\t');
  for (const tag of GPS_EXIF_TAGS) {
    o.e(
      `\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t${tag}\n\t\t\t\t\t\t</label>` +
        `\n\t\t\t\t\t\t<input type="text" data-property="${tag}" value="${esapiEncode('html_attr', exifTag(meta.exif, tag))}" ` +
        'class="exif">\n\t\t\t\t\t</div>\n\t\t\t\t',
    );
  }
  o.e(
    '\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>\n\t\t<div id="tabFileMetaAdvanced" class="tab-pane">\n\t\t\t<!-- block -->' +
      '\n\t\t  \t<div class="block block-bordered">\n\t\t\t\t\t<div class="block-header">\n\t\t\t\t\t\t<h3 class="block-title">' +
      `${labels.key('sitemanager.content.tabs.advanced')}</h3>\n\t\t\t\t</div>\n\t\t\t\t<div class="block-content">`,
  );
  metadataInput(o, ctx, 'sitemanager.content.fields.remoteid', 'remoteid', esapiEncode('html_attr', meta.remoteid));
  metadataInput(o, ctx, 'sitemanager.content.fields.remoteurl', 'remoteurl', esapiEncode('html_attr', meta.remoteurl));
  metadataInput(
    o,
    ctx,
    'sitemanager.content.fields.remotepublicationdate',
    'remotepubdate',
    // Legacy defect, reproduced: setRemotePubDate stores outside the bean's instance data, so the field always prints empty.
    '',
    ' datepicker',
  );
  metadataInput(o, ctx, 'sitemanager.content.fields.remotesource', 'remotesource', esapiEncode('html_attr', meta.remotesource));
  metadataInput(o, ctx, 'sitemanager.content.fields.remotesourceurl', 'remotesourceurl', esapiEncode('html_attr', meta.remotesourceurl));
  o.t('\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t</div>\n\t</div>\n</div>\n');
  return viewResult(o);
}

/** A `contentManager.getPrivateSearch` row of the associated-file search, with the node verdict of its crumbs. */
export interface AssocFileRow {
  fileid: string | null;
  contentid: string;
  fileext: string | null;
  assocfilename: string | null;
  /** `permUtility.getNodePerm(getCrumbList(contentid))`. */
  perm: NodePerm;
}

/** Inputs of {@link renderAssocFiles}: the `rc` values and `getPrivateSearch(siteid, keywords, '', '', type)`. */
export interface AssocFilesModel {
  keywords: string;
  type: string;
  property: string;
  rows: readonly AssocFileRow[];
}

const ASSOC_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif'];

/** `carch.assocfiles` (assocfiles.cfm): the file search box and, for keywords, the image and other-file pickers. */
export function renderAssocFiles(model: AssocFilesModel, ctx: AdminRenderContext): PanelRenderResult {
  const { labels } = ctx;
  const property = model.property;
  const isFileType = cfEq(model.type, 'file');
  // The view's queries of queries read a NULL extension as ''.
  const isImage = (row: AssocFileRow): boolean => inNoCaseList(ASSOC_IMAGE_EXTENSIONS, row.fileext ?? '');
  const images = isFileType ? model.rows.filter(isImage) : model.rows;
  const files = isFileType ? model.rows.filter((row) => !isImage(row)) : [];
  // `filtered` is a CF struct keyed by file id: one entry per id, case-insensitively, across both lists.
  const filtered = new Set<string>();
  const o = new CfOutput();
  o.e(
    '\n\n<div class="mura-control-group">\n\t\t<div class="mura-input-set">\n\t\t\t<input class="filesearch mura-3 mura-constrain" ' +
      `value="${esapiEncode('html_attr', model.keywords)}" type="text" maxlength="50" placeholder="` +
      `${esapiEncode('html_attr', labels.key('sitemanager.content.fields.searchforexistingfiles'))}" />` +
      '\n\t\t\t<button type="button" class="btn"><i class="mi-search"></i></button>\n\t\t</div>\n</div>\n',
  );
  o.t('\n\n');
  if (model.keywords !== '') {
    o.t('\n\t');
    o.e(
      `\n\n\t<div class="selectAssocImageResults block" id="selectAssocImageResults-${esapiEncode('html', property)}">` +
        `\n\t\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">\n\t\t\t<li><a href="#mura-assoc-images-${esapiEncode('html', property)}" ` +
        `data-toggle="tab" onclick="return false;"><i class="mi-picture-o"></i> ${labels.key('sitemanager.content.fields.images')}</a></li>\n\t\t\t`,
    );
    if (isFileType) {
      o.e(
        `<li><a href="#mura-assoc-files-${esapiEncode('html', property)}" data-toggle="tab" onclick="return false;">` +
          `<i class="mi-file-text-o"></i> ${labels.key('sitemanager.content.fields.otherfiles')}</a></li>`,
      );
    }
    o.t('\n\t\t</ul>\n\t\t');
    o.t('\n\t\t<div class="tab-content">\n\t\t\t');
    o.e(`\n\t\t\t<div id="mura-assoc-images-${esapiEncode('html', property)}" class="tab-pane mura-assoc-images">`);
    o.t('\n\t\t\t\t<ul>\n\t\t\t\t\t');
    let counter = 0;
    o.t('\n\t\t\t\t    ');
    if (images.length > 0) {
      o.t('\n\t\t\t\t     ');
      for (const row of images.slice(0, 100)) {
        const id = row.fileid ?? '';
        o.t('\n\t\t\t\t\t\t');
        if (!filtered.has(id.toLowerCase())) {
          o.t('\n\t\t\t\t\t\t\t');
          o.t('\n\t\t\t\t\t\t\t');
          if (row.perm !== 'none') {
            filtered.add(id.toLowerCase());
            counter += 1;
            o.t('\n\t\t\t\t\t\t\t\t');
            o.t('\n\t\t\t\t\t\t\t\t');
            o.t('\n\t\t\t\t\t\t        <li>\n\t\t\t\t\t\t        ');
            if (isImage(row)) {
              o.e(
                `\n\t\t\t\t\t\t        <img title="${esapiEncode('html_attr', row.assocfilename)}" src="${ctx.config.context}` +
                  `/index.cfm/_api/render/small/?fileID=${id}"/><br/>\n\t\t\t\t\t\t        `,
              );
            } else {
              o.e(`\n\t\t\t\t\t\t        <i class="mi-file-text-o"></i><br/>${row.assocfilename ?? ''}<br>\n\t\t\t\t\t\t        `);
            }
            o.e(`\n\t\t\t\t\t\t        <input type="radio" name="${esapiEncode('html_attr', property)}" value="${id}"/></li>\n\t\t\t\t\t\t \t`);
          }
          o.t('\n\t\t\t\t\t \t');
        }
        o.t('\n\t\t\t\t      ');
      }
      o.t('\n\t\t\t\t\t ');
    }
    o.t('\n\t\t\t\t\t ');
    if (counter === 0) {
      o.t('\n\t\t\t\t\t\t');
      o.e(`\n\t\t\t\t\t\t<div class="help-block-empty">${labels.key('sitemanager.noresults')}</alert>\n\t\t\t\t\t\t`);
      o.t('\n\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t</ul>\n\t\t\t</div>\n\t\t\t');
    if (isFileType) {
      o.t('\n\t\t\t');
      o.e(`\n\t\t\t<div id="mura-assoc-files-${esapiEncode('html', property)}" class="tab-pane mura-assoc-files">`);
      o.t('\n\t\t\t\t<ul>\n\t\t\t\t\t');
      counter = 0;
      o.t('\n\t\t\t\t\t');
      if (files.length > 0) {
        o.t('\n\t\t\t\t     ');
        for (const row of files.slice(0, 100)) {
          const id = row.fileid ?? '';
          o.t('\n\t\t\t\t\t\t');
          if (!filtered.has(id.toLowerCase())) {
            o.t('\n\t\t\t\t\t\t\t');
            o.t('\n\t\t\t\t\t\t\t');
            if (row.perm !== 'none') {
              filtered.add(id.toLowerCase());
              counter += 1;
              o.t('\n\t\t\t\t\t\t\t\t');
              o.t('\n\t\t\t\t\t\t\t\t');
              o.e(
                `\n\t\t\t\t\t\t        <li><input type="radio" name="${esapiEncode('html_attr', property)}" value="${id}"/>&nbsp;` +
                  `<i class="mi-file-text-o"></i>&nbsp;${esapiEncode('html', row.assocfilename)}</li>\n\t\t\t\t\t\t \t`,
              );
            }
            o.t('\n\t\t\t\t\t \t');
          }
          o.t('\n\t\t\t\t      ');
        }
        o.t('\n\t\t\t\t\t ');
      }
      o.t('\n\t\t\t\t\t ');
      if (counter === 0) {
        o.t('\n\t\t\t\t\t\t');
        o.e(`\n\t\t\t\t\t\t<div class="help-block-empty">${labels.key('sitemanager.noresults')}</div>\n\t\t\t\t\t\t`);
        o.t('\n\t\t\t\t\t');
      }
      o.t('\n\t\t\t\t</ul>\n\t\t\t</div>\n\t\t\t');
    }
    o.t('\n\t\t</div>\n\t</div>\n');
  }
  o.t('\n');
  return viewResult(o);
}

// --- Change sets ---

/** Inputs of {@link renderAvailableChangesets}. */
export interface AvailableChangesetsModel {
  /** `rc.changesetID`. */
  changesetId: string;
  /** Name of `changesetManager.read(rc.changesetID)`, '' when no change set has that id. */
  currentChangesetName: string;
  /** `changesetManager.getIterator(siteID, published=0, publishdate=now(), publishDateOnly=false, openOnly=true)`. */
  changesets: ReadonlyArray<Pick<ChangesetRow, 'changesetid' | 'name'>>;
  /** `permUtility.getModulePerm('00000000000000000000000000000000014', session.siteid)`. */
  hasChangesetModulePerm: boolean;
}

/** `carch.availablechangesets` (availablechangesets.cfm): the change-set picker of the edit form. */
export function renderAvailableChangesets(model: AvailableChangesetsModel, ctx: AdminRenderContext): PanelRenderResult {
  const { labels } = ctx;
  const o = new CfOutput();
  o.e(`\n<table class="mura-table-grid">\n<tr>\n<th>&nbsp;</th>\n<th class="var-width">${labels.key('changesets.name')}</th>\n</tr>\n`);
  if (model.changesets.length > 0 || model.hasChangesetModulePerm) {
    o.t('\n');
    for (const changeset of model.changesets) {
      o.t('\n');
      o.e(
        '\n<tr>\n<td><input name="_changesetID" type="radio" onclick="removeChangesetPrompt(this.value);" ' +
          `value="${changeset.changesetid}"`,
      );
      if (cfEq(changeset.changesetid, model.changesetId)) o.t(' checked="true"');
      o.e(`/></td>\n<td class="var-width">${esapiEncode('html', changeset.name)}</td>\n</tr>\n`);
    }
    o.e(
      '\n<tr>\n<td><input name="_changesetID" id="changesetother" type="radio" onclick="removeChangesetPrompt(this.value);" ' +
        'value="other"/></td>\n<td class="var-width"><input id="_changesetname" onclick="$(\'#changesetother\').trigger(\'click\');" ' +
        `placeholder="${labels.key('changesets.addchangeset')}"/></td>\n</tr>\n<tr>\n<td><input name="_changesetID" type="radio" ` +
        'onclick="removeChangesetPrompt(this.value);" value=""',
    );
    if (model.changesetId === '') o.t(' checked="true"');
    o.e(`/></td>\n<td class="var-width">${esapiEncode('html', labels.key('sitemanager.content.none'))}</td>\n</tr>\n`);
  } else {
    o.e(`\n<tr>\n<td colspan="2">${labels.key('changesets.nochangesets')}</td>\n</tr>\n`);
  }
  const removePrompt = labels.messageFormat(
    labels.key('sitemanager.content.removechangeset'),
    `<em>"${esapiEncode('html_attr', model.currentChangesetName)}"</em>`,
  );
  o.e(
    '\n</table>\n<div style="display:none" id="removeChangesetContainer">\n<input type="checkbox" id="_removePreviousChangeset" ' +
      `value="true"/>&nbsp;${removePrompt}\n</div>\n`,
  );
  return viewResult(o);
}

// --- Status modal ---

/** A user the status modal names: `getIsNew()` and `getFullName()` of its user bean. */
export interface StatusModalUser {
  isNew: boolean;
  fullName: string;
}

/** The pending approval of a version that requires approval (`content.getApprovalRequest()`). */
export interface StatusModalApproval {
  request: Pick<ApprovalRequestRow, 'status' | 'groupid' | 'userid' | 'requestid' | 'siteid'>;
  /** `approvalRequest.getGroup()`: a group (`type` 1) or a user. */
  group: { type: number; groupName: string; fullName: string };
  /** `approvalRequest.getActionsIterator()`, with each action user's full name. */
  actions: ReadonlyArray<Pick<ApprovalActionRow, 'actiontype' | 'comments' | 'created'> & { userFullName: string }>;
}

/** Inputs of {@link renderStatusModal}. */
export interface StatusModalModel {
  /** `rc.mode`. */
  mode: string;
  content: Pick<ContentRow, 'active' | 'approved' | 'lastupdate' | 'changesetid'> & {
    /** `content.getApprovalStatus()`. */
    approvalStatus: string;
  };
  /** `content.getUser()`, replaced by the approval request's user when it is new and an approval applies. */
  user: StatusModalUser;
  /** `content.requiresApproval()`. */
  requiresApproval: boolean;
  /** `content.requiresApproval(applyExemptions=false)`. */
  showApprovalStatus: boolean;
  /** Required when either approval flag is set. */
  approval?: StatusModalApproval;
  /** `content.getStats().getLockType()`. */
  lockType: string;
  /** The user of `content.getStats().getLockID()`; undefined prints the empty bean `loadBy` returns for a missing user. */
  lockedBy?: { fname: string; lname: string; email: string };
  /** `$.siteConfig('hasChangesets')`. */
  hasChangesets: boolean;
  /** Name of the change set of `content.getChangesetID()`, undefined when none exists. */
  changesetName: string | undefined;
  /** `session.mura.membershipids`. */
  membershipIds: string;
  /** `$.siteConfig().getResourcePath(complete=1)`. */
  resourcePath: string;
}

/** The locked-by notice and its mailto link (statusmodal.cfm, draftpromptdata.cfm). */
function nodeLockedByMessage(ctx: AdminRenderContext, lockedBy: { fname: string; lname: string }): string {
  return ctx.labels.messageFormat(
    ctx.labels.key('sitemanager.nodeLockedby'),
    `${esapiEncode('html_attr', lockedBy.fname)} ${esapiEncode('html', lockedBy.lname)}`,
  );
}

/** `mailto:<email>?subject=<unlock request>` of the locked-by notice. */
function nodeUnlockMailto(ctx: AdminRenderContext, email: string): string {
  return `mailto:${esapiEncode('html', email)}?subject=${esapiEncode('html', ctx.labels.key('sitemanager.nodeunlockrequest'))}`;
}

/** The pending status, actions history and action form of statusmodal.cfm, inside `requiresApproval or showApprovalStatus`. */
function statusModalApproval(o: CfOutput, model: StatusModalModel, approval: StatusModalApproval, ctx: AdminRenderContext): void {
  const { labels } = ctx;
  const { request, group } = approval;
  const pending = (model.content.approved ?? 0) === 0 && cfEq(request.status ?? '', 'Pending');
  o.t('\n\t\t\t');
  if (pending) {
    o.t('\n\t\t\t<dl class="approval-status">\n\t\t\t\t<dt>');
    o.e(labels.key('sitemanager.content.approvalstatus'));
    o.t('</dt>\n\t\t\t\t<dd>\n\t\t\t\t\t<i class="mi-clock-o"></i>\n\t\t\t\t\t ');
    if (group.type === 1) {
      o.t('\n\t\t\t\t\t\t<em>');
      o.e(labels.key('approvalchains.waitingforgroup'));
      o.t(':</em>\n\t\t\t\t\t\t<p>');
      o.e(esapiEncode('html', group.groupName));
      o.t('</p>\n\t\t\t\t\t');
    } else {
      o.t('\n\t\t\t\t\t\t<em>');
      o.e(labels.key('approvalchains.waitingforuser'));
      o.t(':</em>\n\t\t\t\t\t\t<p>');
      o.e(esapiEncode('html', group.fullName));
      o.t('</p>\n\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t</dd>\n\t\t\t</dl>\n\t\t\t');
  }
  o.t('\t\n\t\t\n\t\t\t');
  if (approval.actions.length > 0) {
    o.t('\n\t\t\t<dl class="approval-chain-comments">\n\t\t\t\t<dt>');
    o.e(labels.key('sitemanager.content.actions'));
    o.t('</dt>\n\t\t\t\t');
    for (const action of approval.actions) {
      const type = action.actiontype ?? '';
      const rejection = cfEq(type, 'rejection');
      const cancelation = !rejection && cfEq(type, 'cancelation');
      o.t('\n\t\t\t\t');
      o.t('\n\t\t\t\n\t\t\t\t<dd>\n\t\t\t\t\t<strong class="');
      o.t(rejection ? 'rejected' : cancelation ? 'canceled' : 'approved');
      o.t('">\n\t\t\t\t\t');
      if (rejection) {
        o.t('<i class="mi-warning"></i> ');
        o.e(labels.key('approvalchains.rejected'));
      } else if (cancelation) {
        o.t('<i class="mi-ban"></i> ');
        o.e(labels.key('approvalchains.canceled'));
      } else {
        o.t('<i class="mi-check-circle"></i> ');
        o.e(labels.key('approvalchains.approved'));
      }
      o.t('</strong> \n\t\t\t\t\t');
      const comments = action.comments ?? '';
      if (comments !== '') {
        o.t('<p>');
        o.e(esapiEncode('html', comments));
        o.t('</p>');
      }
      o.t('\n\t\t\t\t\t<em>');
      o.e(labels.key('approvalchains.by'));
      o.t(' ');
      o.e(esapiEncode('html', action.userFullName));
      o.t(' ');
      o.e(labels.key('approvalchains.on'));
      o.t(' ');
      o.e(lsDateFormat(action.created, ctx.session.dateKeyFormat));
      o.t(' ');
      o.e(labels.key('approvalchains.at'));
      o.t(' ');
      o.e(lsTimeFormat(action.created, 'short'));
      o.t('</em>\t\t\n\t\t\t\t</dd>\n\t\t\t\n\t\t\t');
    }
    o.t('\n\t\t\t</dl>\n\t\t\t');
  }
  o.t('\n\t\t\n\t\t\t');
  const groupId = (request.groupid ?? '').toLowerCase();
  const isApprover =
    cfListToArray(model.membershipIds).some((id) => id.toLowerCase() === groupId) ||
    isSiteAdmin(ctx.session, ctx.siteSettings.privateUserPoolId) ||
    isS2(ctx.session);
  o.t('\n\t\t\t');
  const isRequester = cfEq(request.userid ?? '', ctx.session.userId);
  o.t('\n\n\t\t\t');
  if (pending && (isApprover || isRequester)) {
    o.t('\n\t\t\t\t<dl class="approval-action-form">\n\t\t\t\t<dt>');
    o.e(labels.key('approvalchains.action'));
    o.t('</dt>\n\t\t\t\t<dd>\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t');
    if (isApprover) {
      // The missing space before `type` on the approve and cancel radios is legacy's markup.
      o.t(
        '\n\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t<input class="approval-action" id="approval-approve" name="approval-action"type="radio" value="Approve" checked/> ',
      );
      o.e(labels.key('approvalchains.approve'));
      o.t(
        ' \n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t<input class="approval-action" id="approval-reject" name="approval-action" type="radio" value="Reject" checked/> ',
      );
      o.e(labels.key('approvalchains.reject'));
      o.t('\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t');
    if (isRequester) {
      o.t(
        '\n\t\t\t\t\t\t<label class="radio inline">\n\t\t\t\t\t\t\t<input class="approval-action" id="approval-cancel" name="approval-action"type="radio" value="Cancel" checked/> ',
      );
      o.e(labels.key('approvalchains.cancel'));
      o.t(' \n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t</div>\t\t\t\t\t\n\t\t\t\t<p>');
    o.e(labels.key('approvalchains.comments'));
    o.t(
      '</p>\n\t\t\t\t<textarea id="approval-comments" rows="4"></textarea>\n\t\t\t\t\t<div class="form-actions">\t\t\t\t\t\n\t\t\t\t\t<input id="mura-approval-apply" type="button" class="btn mura-primary" value="',
    );
    o.e(esapiEncode('html_attr', labels.key('sitemanager.content.apply')));
    o.t(`" onclick="applyApprovalAction('`);
    o.e(request.requestid ?? '');
    o.t(`',$('input:radio[name=approval-action]:checked').val(),$('#approval-comments').val(),'`);
    o.e(esapiEncode('javascript', request.siteid ?? ''));
    o.t(`');"/>\n\t\t\t\t\t</div>\n\t\t\t\t</dd>\n\t\t\t\t</dl>\n\t\t\t`);
  }
  o.t('\n\t\t');
}

/** The approval script of the frontend status modal (statusmodal.cfm). */
function statusModalFrontEndScript(o: CfOutput, model: StatusModalModel, ctx: AdminRenderContext): void {
  o.t("\n\t\t<script>\n\t\tfunction applyApprovalAction(requestid,action,comment,siteid){\n\t\t\t\n\t\t\tif(action == 'Reject' && comment == ''){\n\t\t\t\talertDialog('");
  o.e(esapiEncode('javascript', ctx.labels.key('approvalchains.rejectioncommentrequired')));
  o.t(
    "');\n\t\t\t} else {\n\t\t\t\t$('#mura-approval-apply').attr('disabled','disabled').css('opacity', '.30');\n\t\t\n\t\t\t\tvar pars={\n\t\t\t\t\t\t\tmuraAction:'carch.approvalaction',\n\t\t\t\t\t\t\tsiteid: siteid,\n\t\t\t\t\t\t\trequestid: requestid,\n\t\t\t\t\t\t\tcomment: comment,\n\t\t\t\t\t\t\taction:action\n\t\t\t\t\t\t};\n\n\t\t\t\tactionModal(\n\t\t\t\t\tfunction(){\n\t\t\t\t\t\t$.post('",
  );
  o.e(model.resourcePath);
  o.t(
    "/index.cfm/_api/json/v1/generatecsrftokens/?context=approvalaction&siteid=' + pars.siteid).then(\n\t\t\t\t\t\t\tfunction(data){\n\t\t\t\t\t\t\t\tpars['csrf_token']=data['csrf_token'];\n\t\t\t\t\t\t\t\tpars['csrf_token_expires']=data['csrf_token_expires'];\n\n\t\t\t\t\t\t\t\t$.post('./index.cfm',\n\t\t\t\t\t\t\t\t\tpars,\n\t\t\t\t\t\t\t\t\tfunction(data) {\n\t\t\t\t\t\t\t\t\t\t//$('html').html(data);\n\t\t\t\t\t\t\t\t\t\t//alert(data.previewurl)\n\t\t\t\t\t\t\t\t\t\ttop.location.replace(data.previewurl);\n\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t);\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t);\n\t\t\t\t\t}\n\t\t\t\t);\n\t\t\t}\n\t\t}\n\n\t\t$(document).ready(function(){\n\t\t\tif (top.location != self.location) {\n\t\t\t\tif(jQuery(\"#ProxyIFrame\").length){\n\t\t\t\t\tjQuery(\"#ProxyIFrame\").load(\n\t\t\t\t\t\tfunction(){\n\t\t\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});\n\t\t\t\t\t\t}\n\t\t\t\t\t);\t\n\t\t\t\t} else {\n\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});\n\t\t\t\t}\n\t\t\t}\n\t\t});\n\t\t</script>\n\t",
  );
}

/** statusmodal.cfm: a bare fragment, except `rc.mode=frontend`, which keeps the layout for web's shell to wrap. */
export function renderStatusModal(model: StatusModalModel, ctx: AdminRenderContext): PanelRenderResult | PanelLayoutBody {
  const { labels } = ctx;
  const { content } = model;
  const frontEnd = cfEq(model.mode, 'frontend');
  const showApproval = model.requiresApproval || model.showApprovalStatus;
  if (showApproval && model.approval === undefined) throw new TypeError('statusmodal: approval is required when approval applies.');
  const active = content.active ?? 0;
  const approved = content.approved ?? 0;
  let isLocked = false;
  const o = new CfOutput();
  o.t(' \n');
  o.t('\n');
  o.t('\n');
  if (frontEnd) {
    o.t('\n\t<h1>');
    o.e(labels.key('layout.status'));
    o.t('</h1>\n\t');
    if (ctx.siteSettings.hasLockableNodes) {
      o.t('\n\t\t');
      if (cfEq(model.lockType, 'node')) {
        o.t('\n\t\t');
        isLocked = true;
        o.t('\n\t\t');
        const lockedBy = model.lockedBy ?? { fname: '', lname: '', email: '' };
        o.t('\n\t\t<div class="alert alert-error">\n\t\t\t<span>\n\t\t\t');
        o.e(nodeLockedByMessage(ctx, lockedBy));
        o.t('.\n\t\t\t<br><a tabindex="-1" href="');
        o.e(nodeUnlockMailto(ctx, lockedBy.email));
        o.t('"><i class="mi-envelope"></i> ');
        o.e(labels.key('sitemanager.requestnoderelease'));
        o.t('</a>\n\t\t\t</span>\n\t\t</div>\n\t\t');
      }
      o.t('\n\t');
    }
    o.t('\n<div>\n');
  }
  o.t('\n<div id="status-modal" class="mura-list-grid">\n\t<dl>\n\t\t<dt>');
  o.e(labels.key('sitemanager.content.createdby'));
  o.t('</dt> \n\t\t<dd>\n\t\t\t<i class="mi-user"></i>\n\t\t\t<p>');
  if (!model.user.isNew) {
    o.e(esapiEncode('html', model.user.fullName));
    o.t(' ');
  } else {
    o.t(' ');
    o.e(labels.key('sitemanager.content.na'));
    o.t(' ');
  }
  o.t('</p>\n\t\t</dd>\n\t</dl>\n\t\n\t<dl class="created-on">\n\t\t<dt>');
  o.e(labels.key('sitemanager.content.createdon'));
  o.t('</dt>\n\t\t<dd>\n\t\t\t<i class="mi-calendar"></i>\n\t\t\t<p>');
  o.e(lsDateFormat(content.lastupdate, ctx.session.dateKeyFormat));
  o.t('<br />\n\t\t\t');
  o.e(lsTimeFormat(content.lastupdate, 'short'));
  o.t('</p>\n\t\t</dd>\n\t</dl>\n\t\n\t<dl>\n\t\t<dt>');
  o.e(labels.key('sitemanager.content.status'));
  o.t('</dt>\n\t\t<dd');
  if (isLocked) o.t(' class="status-locked"');
  o.t('>\t\n\t\t\t');
  if (active > 0 && approved > 0) {
    o.t('\n\t\t\t\t<i class="mi-check-circle"></i>\n\t\t\t\t<p>');
    o.e(labels.key('sitemanager.content.published'));
    o.t('</p>\n\t\t\t');
  } else if (content.approvalStatus !== '' && showApproval) {
    o.t('\n\t\t\t\t<i class="mi-clock-o"></i>\n\t\t\t\t<p>');
    o.e(labels.key(`sitemanager.content.${content.approvalStatus}`));
    o.t('</p>\n\t\t\t');
  } else if (approved < 1) {
    o.t('\n\t\t\t\t');
    if ((content.changesetid ?? '') !== '') {
      o.t('\n\t\t\t\t\t<i class="mi-check-circle"></i>\n\t\t\t\t\t<p>');
      o.e(labels.key('sitemanager.content.queued'));
      // `</p` without `>` is legacy's markup.
      o.t('</p\n\t\t\t\t');
    } else {
      o.t('\n\t\t\t\t\t<i class="mi-edit"></i>\n\t\t\t\t\t<p>');
      o.e(labels.key('sitemanager.content.draft'));
      o.t('</p>\n\t\t\t\t');
    }
    o.t('\n\t\t\t');
  } else {
    o.t('\n\t\t\t\t<i class="mi-history"></i>\n\t\t\t\t<p>');
    o.e(labels.key('sitemanager.content.archived'));
    o.t('</p>\n\t\t\t');
  }
  o.t('\n\t\t</dd>\n\t</dl>\n\t\t\n\t\n\t\t');
  if (model.hasChangesets) {
    o.t('\n\t\t');
    o.t('\n\t\t<dl class="change-set">\n\t\t\t<dt>');
    o.e(labels.key('sitemanager.content.changeset'));
    o.t('</dt>\n\t\t\t<dd>\n\t\t\t\t<i class="mi-list-alt"></i>\n\t\t\t\t<p>');
    if (model.changesetName === undefined) o.t('Unassigned');
    else o.e(esapiEncode('html', model.changesetName));
    o.t('</p>\n\t\t\t</dd>\n\t\t</dl>\n\t\t');
  }
  o.t('\n\t\t\t\t\t\n\t\n\t\t');
  if (showApproval && model.approval !== undefined) statusModalApproval(o, model, model.approval, ctx);
  o.t('\n</div>\n\n');
  if (frontEnd) {
    o.t('\n</div>\n\t');
    if (approved === 0 && showApproval) statusModalFrontEndScript(o, model, ctx);
    o.t('\n');
    o.t('\n');
    return { layout: true, body: o.toString() };
  }
  o.t('\n\t');
  o.t('\n');
  o.t('\n');
  o.t('\n');
  return viewResult(o);
}

// --- Draft prompt ---

/** A version the draft prompt lists. */
export type DraftPromptVersion = Pick<ContentRow, 'approved' | 'menutitle' | 'lastupdate' | 'lastupdateby'>;

/** A row of `getDraftPromptData`'s `pendingchangesets` or `yourapprovals` query. */
export interface DraftPromptListRow {
  contenthistid: string;
  /** `menutitle` of `yourapprovals`; `changesetName` of `pendingchangesets`. */
  title: string;
  lastupdate: Date | null;
  lastupdateby: string;
}

/** `contentManager.getDraftPromptData(contentid, siteid)` (contentManager.cfc:2784-2888) without the derived flags. */
export interface DraftPromptData {
  /** `permUtility.getNodePerm(crumbs)`: `editor`, `author`, `read`, `none` or `deny`. */
  verdict: string;
  publishedHistoryId: string;
  hasDraft: boolean;
  hasDraftPending: boolean;
  historyId: string;
  /** `content.getStats()` lock id and type, read on sites with lockable nodes; the lock flags derive from them. */
  lockId: string;
  lockType: string;
  /** The final `pendingchangesets` query, emptied where legacy replaces it with `queryNew("empty")`. */
  pendingChangesets: readonly DraftPromptListRow[];
  yourApprovals: readonly DraftPromptListRow[];
}

/** Inputs of {@link renderDraftPromptData}. */
export interface DraftPromptModel {
  data: DraftPromptData;
  /** `rc.targetversion` as posted (default `false`). */
  targetVersion: string;
  /** The version of `rc.contenthistid` when `targetversion`, else of `publishedHistoryId`. */
  publishedVersion: DraftPromptVersion;
  /** The version of `historyId`; required when `hasDraft`. */
  draftVersion?: DraftPromptVersion;
  /** The user of `lockId`; undefined prints the empty bean `loadBy` returns for a missing user. */
  lockedBy?: { fname: string; lname: string; email: string };
  /** The active version of `rc.contentid`, whose URL links approvals for readers. */
  content: Pick<ContentRow, 'filename'>;
}

/** The lock members of `getDraftPromptData`; `eq` results encode as YES/NO under mura.json, literals as true/false. */
interface DraftPromptLock {
  lockId: string;
  lockType: string;
  isLocked: boolean;
  lockedByYou: boolean | 'YES' | 'NO';
  lockAvailable: boolean;
}

/** contentManager.cfc:2864-2881. */
function draftPromptLock(data: DraftPromptData, ctx: AdminRenderContext): DraftPromptLock {
  if (!ctx.siteSettings.hasLockableNodes) {
    return { lockId: '', lockType: '', isLocked: false, lockedByYou: false, lockAvailable: false };
  }
  const lockedByYou = cfEq(data.lockId, ctx.session.userId) ? 'YES' : 'NO';
  return {
    lockId: data.lockId,
    lockType: data.lockType,
    isLocked: cfEq(data.lockType, 'node') && data.lockId !== '',
    lockedByYou,
    lockAvailable: !(data.lockId !== '' && lockedByYou === 'NO'),
  };
}

/** One version row of the draft prompt tables. */
function draftPromptRow(o: CfOutput, ctx: AdminRenderContext, histId: string, title: string, lastUpdate: Date | null, lastUpdateBy: string, lead: string, optionClass: string): void {
  o.t(`${lead}<td><a href="#" tabindex="-1" class="draft-prompt-option" data-contenthistid="`);
  o.e(histId);
  o.t(`"><i class="mi-pencil"></i></a></td>${lead}<td class="var-width"><a href="#" tabindex="-1" class="${optionClass}" data-contenthistid="`);
  o.e(histId);
  o.t('">');
  o.e(esapiEncode('html', title));
  o.t(`</a></td>${lead}<td>`);
  o.e(lsDateFormat(lastUpdate, ctx.session.dateKeyFormat));
  o.t(' ');
  o.e(lsTimeFormat(lastUpdate, 'medium'));
  o.t(`</td>${lead}<td>`);
  o.e(esapiEncode('html', lastUpdateBy));
  o.t('</td>');
}

/** The `cfsavecontent` dialog markup of draftpromptdata.cfm. */
function draftPromptMessage(model: DraftPromptModel, lock: DraftPromptLock, targetVersion: boolean, hasMultiple: boolean, ctx: AdminRenderContext): string {
  const { data } = model;
  const { labels } = ctx;
  const lockable = ctx.siteSettings.hasLockableNodes;
  const powerUser = isS2(ctx.session) || isSiteAdmin(ctx.session, ctx.siteSettings.privateUserPoolId);
  const editor = inNoCaseList(['author', 'editor'], data.verdict);
  const o = new CfOutput();
  o.t('\n\t');
  o.t('\n\t<div id="draft-prompt">\n\t\t');
  if (lockable && lock.isLocked) {
    o.t('\n\t\t\t');
    const lockedBy = model.lockedBy ?? { fname: '', lname: '', email: '' };
    o.t('\n\t\t\t<div class="help-block">\n\t\t\t\t<p>');
    o.e(nodeLockedByMessage(ctx, lockedBy));
    o.t('.</p>\n\t\t\t\t<p><a tabindex="-1" href="');
    o.e(nodeUnlockMailto(ctx, lockedBy.email));
    o.t('"><i class="mi-envelope"></i> ');
    o.e(labels.key('sitemanager.requestnoderelease'));
    o.t('</a></p>\n\t\t\t</div>\n\t\t');
  }
  o.t('\n\n\t\t');
  if (!lockable || lock.lockAvailable || powerUser || cfEq(ctx.session.userId, lock.lockId)) {
    o.t('\n\n\t\t\t');
    if (hasMultiple && !targetVersion) {
      o.t('\n\t\t\t\t<div class="help-block">');
      o.e(labels.key('sitemanager.draftprompt.dialog'));
      o.t('</div>\n\t\t\t');
    }
    o.t('\n\n\t\t\t');
    if (editor) {
      o.t('\n\n\t\t\t');
      if (lockable && lock.lockAvailable && !cfEq(lock.lockId, ctx.session.userId)) {
        o.t('\n\t\t\t\t<div class="help-block"><input id="locknodetoggle" type="checkbox"/> ');
        o.e(labels.key('sitemanager.draftprompt.locknode'));
        o.t('</div>\n\t\t\t');
      }
      o.t('\n\n\t\t\t');
      o.t('\n\t\t\t\t');
      o.t('\n\t\t\t');
      o.t('\n\t\t\n\t\t\t');
      const published = model.publishedVersion;
      const publishedApproved = (published.approved ?? 0) !== 0;
      if (publishedApproved || !data.hasDraft || targetVersion) {
        o.t('\n\t\t\t\t<table class="mura-table-grid">\n\t\t\t\t\t<thead>\n\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t<th colspan="4">\n\t\t\t\t\t\t\t\t');
        if (!targetVersion) {
          o.t('\n\t\t\t\t\t\t\t\t\t');
          if (publishedApproved) {
            o.t('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-check"></i> ');
            o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.published')));
            o.t('\n\t\t\t\t\t\t\t\t\t');
          } else {
            o.t('\n\t\t\t\t\t\t\t\t\t\t<i class="mi-edit"></i> ');
            o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.latest')));
            o.t('\n\t\t\t\t\t\t\t\t\t');
          }
          o.t('\n\t\t\t\t\t\t\t\t');
        } else {
          o.t('\n\t\t\t\t\t\t\t\t\t<i class="mi-edit"></i> ');
          o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.editversion')));
          o.t('\n\t\t\t\t\t\t\t\t');
        }
        o.t('\n\t\t\t\t\t\t\t</th>\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t</thead>\n\t\t\t\t\t<tbody>');
        // Legacy writes the published row's cells straight into <tbody>, without a <tr>.
        draftPromptRow(o, ctx, data.publishedHistoryId, published.menutitle ?? '', published.lastupdate, published.lastupdateby ?? '', '\n\t\t\t\t\t\t', 'draft-prompt-option var-width');
        o.t('\n\t\t\t\t\t</tbody>\n\t\t\t\t</table>\n\t\t\t');
      }
      o.t('\n\n\t\t\t');
      if (data.hasDraft && !targetVersion) {
        const draft = model.draftVersion;
        if (draft === undefined) throw new TypeError('draftpromptdata: draftVersion is required when hasDraft.');
        o.t('\n\n\t\t\t\t');
        o.t('\n\t\t\t\t<table class="mura-table-grid">\n\t\t\t\t\t<thead>\n\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t<th colspan="4"><i class="mi-edit"></i> ');
        o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.latest')));
        o.t('</th>\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t</thead>\n\t\t\t\t\t<tbody>\n\t\t\t\t\t\t<tr>');
        draftPromptRow(o, ctx, data.historyId, draft.menutitle ?? '', draft.lastupdate, draft.lastupdateby ?? '', '\n\t\t\t\t\t\t\t', 'draft-prompt-option');
        o.t('\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t</tbody>\n\t\t\t\t</table>\n\t\t\t');
      }
      o.t('\n\n\t\t\t');
      if (data.pendingChangesets.length > 0 && !targetVersion) {
        o.t('\n\t\t\t\t<table class="mura-table-grid">\n\t\t\t\t\t<thead>\n\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t<th colspan="4"><i class="mi-clone"></i> ');
        o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.changesets')));
        o.t('</th>\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t</thead>\n\t\t\t\t\t<tbody>\n\t\t\t\t\t\t');
        for (const row of data.pendingChangesets) {
          o.t('\n\t\t\t\t\t\t<tr>');
          draftPromptRow(o, ctx, row.contenthistid, row.title, row.lastupdate, row.lastupdateby, '\n\t\t\t\t\t\t\t', 'draft-prompt-option');
          o.t('\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t');
        }
        o.t('\n\t\t\t\t\t</tbody>\n\t\t\t\t</table>\n\t\t\t');
      }
      o.t('\n\t\t\t');
    }
    o.t('\n\t\t\t');
    if (data.yourApprovals.length > 0 && !targetVersion) {
      o.t('\n\t\t\t\t');
      o.t('\n\t\t\t\t<table class="mura-table-grid">\n\t\t\t\t\t<thead>\n\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t<th colspan="4"><i class="mi-clock-o"></i> ');
      o.e(esapiEncode('html', labels.key('sitemanager.draftprompt.awaitingapproval')));
      o.t('</th>\n\t\t\t\t\t\t</tr>\n\t\t\t\t\t</thead>\n\t\t\t\t\t<tbody>\n\t\t\t\t\t\t');
      for (const row of data.yourApprovals) {
        o.t('\n\t\t\t\t\t\t\t<tr>\n\t\t\t\t\t\t\t\t');
        if (editor) {
          o.t('\n\t\t\t\t\t\t\t\t\t<td><a href="#" data-contenthistid="');
          o.e(row.contenthistid);
          o.t('" tabindex="-1" class="draft-prompt-option"><i class="mi-pencil"></i></a></td>\n\t\t\t\t\t\t\t\t\t<td class="var-width"><a href="#" data-contenthistid="');
          o.e(row.contenthistid);
          o.t('"  tabindex="-1" class="draft-prompt-option">');
          o.e(esapiEncode('html', row.title));
          o.t('</a></td>\n\t\t\t\t\t\t\t\t\t<td>');
          o.e(lsDateFormat(row.lastupdate, ctx.session.dateKeyFormat));
          o.t(' ');
          o.e(lsTimeFormat(row.lastupdate, 'medium'));
          o.t('</td>\n\t\t\t\t\t\t\t\t\t<td>');
          o.e(esapiEncode('html', row.lastupdateby));
          o.t('</td>\n\t\t\t\t\t\t\t\t');
        } else {
          const preview = contentUrl(ctx.site, model.content, { querystring: `previewid=${row.contenthistid}` });
          o.t('\n\t\t\t\t\t\t\t\t\t<td><a href="');
          o.e(preview);
          o.t('" tabindex="-1" class="draft-prompt-approval"><i class="mi-pencil"></i></a></td>\n\t\t\t\t\t\t\t\t\t<td class="var-width"><a href="');
          o.e(preview);
          o.t('" tabindex="-1" class="draft-prompt-approval">');
          o.e(esapiEncode('html', row.title));
          o.t('</a></td>\n\t\t\t\t\t\t\t\t\t<td>');
          o.e(lsDateFormat(row.lastupdate, ctx.session.dateKeyFormat));
          o.t(' ');
          o.e(lsTimeFormat(row.lastupdate, 'medium'));
          o.t('</td>\n\t\t\t\t\t\t\t\t\t<td>');
          o.e(esapiEncode('html', row.lastupdateby));
          o.t('</td>\n\n\t\t\t\t\t\t\t\t');
        }
        o.t('\n\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t');
      }
      o.t('\n\t\t\t\t\t</tbody>\n\t\t\t\t</table>\n\t\t\t');
    }
    o.t('\n\n\t\t');
  }
  o.t('\n\n\t\t</div>\n\t');
  o.t('\n\t');
  return o.toString();
}

/** draftpromptdata.cfm: mura.json of the prompt struct, members in ACF's iteration order of this key set. */
export function renderDraftPromptData(model: DraftPromptModel, ctx: AdminRenderContext): PanelRenderResult {
  const { data } = model;
  const targetVersion = cfIsBoolean(model.targetVersion) ? cfToBoolean(model.targetVersion) : false;
  const pendingCount = data.pendingChangesets.length;
  const approvalCount = data.yourApprovals.length;
  // CFML `or` yields its first true operand as is, else the last one: a boolean or a record count.
  const hasMultiple: boolean | number = data.hasDraft ? true : pendingCount > 0 ? pendingCount : approvalCount;
  const lock = draftPromptLock(data, ctx);
  const showDialog =
    data.hasDraft ||
    pendingCount > 0 ||
    approvalCount > 0 ||
    (ctx.siteSettings.hasLockableNodes && !cfEq(lock.lockId, ctx.session.userId));
  const message = showDialog ? draftPromptMessage(model, lock, targetVersion, hasMultiple !== 0, ctx) : '';
  const json = muraJsonEncode({
    verdict: data.verdict,
    publishedhistoryid: data.publishedHistoryId,
    locktype: lock.lockType,
    hasmultiple: hasMultiple,
    lockedbyyou: lock.lockedByYou,
    lockavailable: lock.lockAvailable,
    lockid: lock.lockId,
    islocked: lock.isLocked,
    message,
    showdialog: showDialog ? 'true' : 'false',
    hasdraft: data.hasDraft,
    hasdraftpending: data.hasDraftPending,
    historyid: data.historyId,
  });
  return { status: 200, contentType: LEGACY_JSON_CONTENT_TYPE, body: `${json} ` };
}

// --- Update responses ---

/** dsp_close_compact_display.cfm inputs, read after a successful non-ajax save. */
export interface CloseCompactDisplayModel {
  /** The location the view computes from the saved version, its parent or the home page. */
  href: string;
  /** `rc.contentBean.getType()`. */
  type: string;
  /** `rc.contentBean.getContentId()`. */
  contentId: string;
  /** `application.coreversion`. */
  coreVersion: string;
  /** `session.frontEndProxyLoc`. */
  frontEndProxyLoc: string;
  /** `session.mura.objectInstanceId`. */
  objectInstanceId: string;
  /** `rc.$.getContentRenderer().useLayoutmanager()`. */
  useLayoutManager: boolean;
}

/** Inputs of {@link renderUpdateResponse}: `carch.update` after the controller saved `rc.contentBean`. */
export interface UpdateResponseModel {
  /** `isDefined("url.qqfile")`. */
  qqfile: boolean;
  /** `rc.ajaxrequest`. */
  ajaxRequest: boolean;
  /** `rc.action`. */
  action: string;
  content: Pick<ContentRow, 'filename' | 'contenthistid' | 'active'> & {
    /** `getIsOnDisplay()`. */
    isOnDisplay: boolean;
  };
  /** `getErrors()`, keyed as ACF prints them: upper case where legacy set the key by dot notation. */
  errors: Readonly<Record<string, unknown>>;
  /** Required for the non-ajax success branch. */
  close?: CloseCompactDisplayModel;
}

/** The setLocation command of dsp_close_compact_display.cfm. */
function setLocationCommand(href: string): string {
  return `var cmd={cmd:'setLocation',location:encodeURIComponent("${esapiEncode('javascript', href)}")};`;
}

/** dsp_close_compact_display.cfm: the page that sends the front-end proxy (or the window) to the saved content. */
function closeCompactDisplay(o: CfOutput, close: CloseCompactDisplayModel, ctx: AdminRenderContext): void {
  const adminPath = `${ctx.config.context}${ctx.config.adminDir}`;
  o.t(
    '\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />\n',
  );
  o.t('\n');
  o.t('\n<script src="');
  o.e(adminPath);
  o.t('/assets/js/jquery/jquery.js?coreversion=');
  o.e(close.coreVersion);
  o.t('" type="text/javascript"></script>\n<script src="');
  o.e(adminPath);
  o.t('/assets/js/porthole/porthole.min.js?coreversion=');
  o.e(close.coreVersion);
  o.t('" type="text/javascript"></script>\n<script>\n\t');
  o.t('\n\t');
  const instanceId = close.objectInstanceId;
  if (close.useLayoutManager && instanceId !== '') {
    o.t('\n\t\t');
    if (cfEq(close.type, 'Form') || cfEq(close.type, 'Component')) {
      o.t("\n\t\t\tvar cmd={cmd:'setObjectParams',reinit:true,instanceid:'");
      o.e(instanceId);
      o.t("',params:{objectid:'");
      o.e(close.contentId);
      o.t("'}};\n\t\t");
    } else {
      o.t("\n\t\t\tvar cmd={cmd:'setObjectParams',reinit:true,instanceid:'");
      o.e(instanceId);
      o.t("',params:{}};\n\t\t");
    }
    o.t('\n\n\t');
  } else {
    o.t(`\n\t\t${setLocationCommand(close.href)}\n\t`);
  }
  o.t('\n\t');
  o.t('\n\tfunction reload(){\n\t\tif (top.location != self.location) {\n\t\t\tfrontEndProxy = new Porthole.WindowProxy("');
  o.e(esapiEncode('javascript', close.frontEndProxyLoc));
  o.e(adminPath);
  o.t(
    '/assets/js/porthole/proxy.html");\n\t\t\tif (jQuery("#ProxyIFrame").length) {\n\t\t\t\tjQuery("#ProxyIFrame").load(function(){\n\t\t\t\t\tfrontEndProxy.post({cmd:\'scrollToTop\'});\n\t\t\t\t\tfrontEndProxy.post(cmd);\n\t\t\t\t});\n\t\t\t}\n\t\t\telse {\n\t\t\t\tfrontEndProxy.post({cmd:\'scrollToTop\'});\n\t\t\t\tfrontEndProxy.post(cmd);\n\t\t\t}\n\n\t\t} else {\n\t\t\tlocation.href="',
  );
  o.e(esapiEncode('javascript', close.href));
  o.t('";\n\t\t}\n\t}\n</script>\n');
  o.t('\n</head>\n<body onload="reload()">\n</body>\n</html>\n');
}

/** update.cfm responses; a failed non-ajax save delegates to web's edit page. */
export function renderUpdateResponse(model: UpdateResponseModel, ctx: AdminRenderContext): PanelRenderResult | PanelDelegation {
  const o = new CfOutput();
  const { content } = model;
  const hasErrors = Object.keys(model.errors).length > 0;
  if (model.qqfile) {
    o.t('{success:true}');
    o.t('\n');
    return viewResult(o);
  }
  if (model.ajaxRequest) {
    if (!hasErrors) {
      const live = (content.active ?? 0) !== 0 && content.isOnDisplay;
      const url = contentUrl(ctx.site, content, live ? {} : { querystring: `previewid=${content.contenthistid ?? ''}` });
      o.t('{success:true,location:');
      o.t("\n\t'");
      o.e(esapiEncode('javascript', url));
      o.t("'\n");
      o.t('}');
      o.t('\n');
      return viewResult(o);
    }
    const tokens = ctx.csrf(`${content.contenthistid ?? ''}add`);
    o.t('{success:false,\n\t\terrors:');
    o.e(acfSerializeJson(model.errors, { preserveKeyCase: true }));
    o.t(",\n\t\tcsrf_token: '");
    o.e(tokens.token);
    o.t("',\n\t\tcsrf_token_expires: '");
    o.e(tokens.expires);
    o.t("'\n}");
    return viewResult(o);
  }
  if (cfEq(model.action, 'multiFileUpload')) {
    o.t('success');
    o.t('\n');
    return viewResult(o);
  }
  if (hasErrors) return { delegate: 'edit-page', reason: 'update.cfm re-renders the edit form with the validation errors' };
  if (model.close === undefined) throw new TypeError('update: close is required after a successful save.');
  closeCompactDisplay(o, model.close, ctx);
  return viewResult(o, { clearEditBean: true, objectInstanceId: '' });
}

// --- JSON responses ---

/** carch/loadtagarray.cfm and cchangesets/loadtagarray.cfm: the tag-cloud tags as a JavaScript array literal. */
function tagArrayLiteral(tags: readonly string[]): string {
  const items = tags.map((tag) => {
    const encoded = esapiEncode('javascript', tag);
    return `{id: '${encoded}', toString: function() { return '${encoded}'; } }`;
  });
  return `[${items.join(',')}]`;
}

/** carch/loadtagarray.cfm (JSON content type, JavaScript-literal body) or cchangesets/loadtagarray.cfm (view default). */
export function renderTagArray(tags: readonly string[], view: 'carch' | 'cchangesets' = 'carch'): PanelRenderResult {
  return { status: 200, contentType: view === 'carch' ? LEGACY_JSON_CONTENT_TYPE : VIEW_CONTENT_TYPE, body: tagArrayLiteral(tags) };
}

/** Inputs of {@link renderApprovalActionJson}: the request's version and the URL legacy previews it at. */
export interface ApprovalActionJsonModel {
  contenthistid: string;
  previewUrl: string;
}

/** approvalaction.cfm; its CSRF test is `true or …`, a reported legacy defect the route reproduces by validating nothing. */
export function renderApprovalActionJson(model: ApprovalActionJsonModel): PanelRenderResult {
  const json = muraJsonEncode({ contenthistid: model.contenthistid, previewurl: model.previewUrl });
  return { status: 200, contentType: BARE_JSON_CONTENT_TYPE, body: `${json} ` };
}

/** `carch.getAuditTrail` (carch.cfc:630-643): the version ids from the requested one back through its sources. */
export function renderAuditTrailJson(histIds: readonly string[]): PanelRenderResult {
  return { status: 200, contentType: LEGACY_JSON_CONTENT_TYPE, body: muraJsonEncode(histIds) };
}

/** `carch.getImageSizeURL` (carch.cfc:645-649): `getURLForImage(fileID, size)`. */
export function renderImageSizeUrlJson(url: string): PanelRenderResult {
  return { status: 200, contentType: LEGACY_JSON_CONTENT_TYPE, body: muraJsonEncode(url) };
}
