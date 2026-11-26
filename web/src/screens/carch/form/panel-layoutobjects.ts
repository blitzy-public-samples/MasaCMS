// Port of carch/form/dsp_panel_layoutobjects.cfm: the edit form's Layout & Objects panel with its configurator script.
import { cfEq, cfToBoolean, cfToNumber } from '@opt2/platform/legacy-compat';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw } from '@/lib/html';
import { cfListGetAt, cfListLen, cfListToArray } from '@/lib/resource-bundles/properties';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { Rc } from '../../registry';
import { CONTENT_MODULE_ID, ROOT_CONTENT_ID, structOf, structText, structValue, type CarchStruct } from '../model';
import { configuratorJs, type ConfiguratorDisplayObject } from '../partials/configurator-js';
import { cfListHas, tabAllowed, type EditFormInput, type PanelResult } from './custom-tags';

// The edit model's `rc` is an open struct; this panel reads, case-insensitively:
// - `contentBean`: `contentID`, `contentHistID`, `parentID`, `isNew`, `template`, `childTemplate`, `inheritObjects`,
//   `targetParams`, `nextN`, and the getter results `imageSize`, `imageWidth`, `imageHeight`, `displayList` and
//   `availableDisplayList`, plus `urlStem` (`$.getURLStem(siteid, filename)`);
// - `rsTemplates`: `contentUtility.getTemplates(siteid, type)` rows, of which `name` is read;
// - `useLayoutManager` and `templateArray`: the content renderer's `useLayoutManager()` and `this.templateArray`
//   (absent reads as the base renderer's `[]`; any other non-array value as a theme's non-array);
// - `site`: settingsBean `columnCount`, `columnNames`, `emailBroadcaster`, `dataCollection`, `hasFeedManager`,
//   `webPath` (`getWebPath(complete=1)`), `templateList`, `customTagGroups`, `assetPath`, `customImageSizes`
//   (`getCustomImageSizeIterator()` rows with `name`, in iterator order) and `displayObjectLookup` (the non-plugin
//   `getDisplayObjectLookup()` entries with `objectid`, `configuratorInit` and `configuratorJS`, in struct order);
// - `rsContentObjects<r>`: `setRequestRegionObjects` rows of region `r` with `object`, `name`, `objectid`, `params`;
//   an absent region reads as the view's empty `cfparam` default;
// - `inheritedObjects`: the node `request.inheritedObjects` names, with `contentID`, `menuTitle`, `editURL`
//   (`getEditURL(compactDisplay=yesNoFormat(rc.compactdisplay), tab='tabLayoutObjects')`) and `perm`
//   (`getNodePerm(getCrumbArray())`); absent when legacy leaves `request.inheritedObjects` empty;
// - `allowOpenFeeds`: configBean `allowopenfeeds`; absent reads as its `false` default.

const NO_BREAK_SPACES: ReadonlySet<string> = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one UTF-16 unit. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/**
 * What ACF whitespace management prints for whitespace-only template text after `output`: one space when `output`
 * ends in non-whitespace, else nothing. Every other whitespace-only run of this view follows whitespace.
 */
function spaceAfter(output: string): string {
  return output !== '' && !isJavaWhitespace(output.slice(-1)) ? ' ' : '';
}

/** Java `String.trim`, as CFML `trim` applies it: code units up to U+0020 stripped from both ends. */
function javaTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}

/** One region object row (`request.rsContentObjects<r>`). */
interface RegionObject {
  readonly object: string;
  readonly name: string;
  readonly objectId: string;
  readonly params: string;
}

/** The node whose cascade this version inherits. */
interface InheritedObjects {
  readonly contentId: string;
  readonly menuTitle: string;
  readonly editUrl: string;
  readonly perm: string;
}

/** The `rc.contentBean` values the panel prints or compares. */
interface LayoutContent {
  readonly contentId: string;
  readonly contentHistId: string;
  readonly template: string;
  readonly childTemplate: string;
  readonly inheritObjects: string;
  readonly targetParams: string;
  readonly urlStem: string;
}

/** Everything the panel reads; site and list-display values are read only where their branch renders. */
interface LayoutObjectsModel {
  /** `rc.contentid`. */
  readonly rcContentId: string;
  /** `rc.contenthistid`, which the configurator script never prints while a content bean is loaded. */
  readonly rcContentHistId: string;
  /** `rc.parentID` as edit.cfm leaves it: the bean's parent when the request names none for a stored node. */
  readonly parentId: string;
  readonly siteId: string;
  readonly moduleId: string;
  readonly type: string;
  readonly tabAssignments: string;
  readonly bean: CarchStruct;
  readonly content: LayoutContent;
  readonly templateNames: readonly string[];
  readonly useLayoutManager: boolean;
  /** `renderer.templateArray`; null when the renderer defines a non-array. */
  readonly rendererTemplates: readonly string[] | null;
  readonly site: CarchStruct;
  readonly rc: CarchStruct;
  readonly inherited: InheritedObjects | undefined;
  readonly allowOpenFeeds: string | boolean | undefined;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A request value by case-insensitive name; undefined when absent. */
function rcValue(rc: Rc, name: string): string | undefined {
  const direct = rc[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** A request value, failing as CFML does when the element is undefined. */
function rcText(rc: Rc, name: string): string {
  const value = rcValue(rc, name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** A simple value as CFML prints it; complex values throw. */
function simpleText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${label} is not a simple value`);
}

/** The rows of a query-valued member; undefined when absent, throws when it is not an array of rows. */
function rowsAt(struct: CarchStruct, key: string, label: string): readonly CarchStruct[] | undefined {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${label} is not an array of rows`);
  return value;
}

/** The rows of a query-valued member the view loops over; throws when absent, as CFML does. */
function requiredRows(struct: CarchStruct, key: string, label: string): readonly CarchStruct[] {
  const rows = rowsAt(struct, key, label);
  if (rows === undefined) throw new TypeError(`${label} is undefined`);
  return rows;
}

/** A CFML boolean member; throws when it is absent or not a boolean. */
function flagAt(struct: CarchStruct, key: string, label: string): boolean {
  const value = structValue(struct, key);
  if (value === undefined || value === null) throw new TypeError(`${label} is undefined`);
  return cfToBoolean(value);
}

/** `renderer.templateArray`: the base renderer's `[]` when unreported, null for a non-array. */
function rendererTemplatesOf(rc: CarchStruct): readonly string[] | null {
  const value = structValue(rc, 'templateArray');
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.map((item: unknown, index) => simpleText(item, `rc.templateArray[${index + 1}]`));
}

/** `request.inheritedObjects` resolved to its node; undefined when legacy sets none. */
function inheritedOf(rc: CarchStruct): InheritedObjects | undefined {
  const value = structValue(rc, 'inheritedObjects');
  if (value === undefined || value === null || value === '') return undefined;
  if (!isStruct(value)) throw new TypeError('rc.inheritedObjects is not a struct');
  return {
    contentId: structText(value, 'contentID'),
    menuTitle: structText(value, 'menuTitle'),
    editUrl: structText(value, 'editURL'),
    perm: structText(value, 'perm'),
  };
}

/** configBean `getValue('allowopenfeeds', false)` as reported. */
function allowOpenFeedsOf(rc: CarchStruct): string | boolean | undefined {
  const value = structValue(rc, 'allowOpenFeeds');
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  return simpleText(value, 'rc.allowOpenFeeds');
}

/** The panel's model from the edit form input. */
function readModel(input: EditFormInput): LayoutObjectsModel {
  const { rc } = input.data;
  const req = input.req.rc;
  const bean = structOf(rc, 'contentBean');
  const text = (key: string): string => structText(bean, key);
  const rcParentId = rcText(req, 'parentID');
  // edit.cfm: a stored node edited without a parentid takes its own parent.
  const parentId = rcParentId === '' && !cfToBoolean(structValue(bean, 'isNew') ?? 0) ? text('parentID') : rcParentId;
  return {
    rcContentId: rcText(req, 'contentid'),
    rcContentHistId: rcValue(req, 'contenthistid') ?? '',
    parentId,
    siteId: rcText(req, 'siteid'),
    moduleId: rcText(req, 'moduleid'),
    type: rcText(req, 'type'),
    tabAssignments: input.state.tabAssignments,
    bean,
    content: {
      contentId: text('contentID'),
      contentHistId: text('contentHistID'),
      template: text('template'),
      childTemplate: text('childTemplate'),
      inheritObjects: text('inheritObjects'),
      targetParams: text('targetParams'),
      urlStem: text('urlStem'),
    },
    templateNames: requiredRows(rc, 'rsTemplates', 'rc.rsTemplates').map((row) => structText(row, 'name')),
    useLayoutManager: flagAt(rc, 'useLayoutManager', 'rc.useLayoutManager'),
    rendererTemplates: rendererTemplatesOf(rc),
    site: structOf(rc, 'site'),
    rc,
    inherited: inheritedOf(rc),
    allowOpenFeeds: allowOpenFeedsOf(rc),
  };
}

/** CFML `listLast(name, '.')`: the last non-empty element, or `''`. */
const listLastDot = (name: string): string => cfListToArray(name, '.').at(-1) ?? '';

/** `rc.rsTemplates` names the layout selects offer: `cfm`, `html`, `htm` and `hbs` files. */
const layoutFiles = (names: readonly string[]): readonly string[] =>
  names.filter((name) => cfListHas('cfm,html,htm,hbs', listLastDot(name), { noCase: true }));

/** A popover label's `<span>` from its tag through `</span>`; `pad` indents its attribute and text lines. */
function popoverLabel(rb: RbLookup, pad: string, tooltipKey: string, labelKey: string): string {
  const label = rb.rbKey(labelKey);
  return (
    `<span data-toggle="popover" title="" data-placement="right"\n${pad}data-content="` +
    `${encodeHtmlAttr(rb.rbKey(tooltipKey))}"\n${pad}data-original-title="${encodeHtmlAttr(label)}">\n` +
    `${pad}  ${label}\n${pad} <i class="mi-question-circle"></i></span>`
  );
}

/** One template `<option>` between its source line's leading and trailing whitespace; the name prints unencoded. */
function templateOption(lead: string, name: string, chosen: string, tail: string): string {
  return `${lead}<option value="${name}" ${cfEq(chosen, name) ? 'selected' : ''}>${name}</option>${tail}`;
}

/** The panel opening and the layout template select (lines 82-127). */
function templateSelect(rb: RbLookup, m: LayoutObjectsModel): string {
  let out =
    '\n  <div class="mura-panel panel">\n    <div class="mura-panel-heading" role="tab" id="heading-layout">\n      <h4 class="mura-panel-title">\n        <a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-layout" aria-expanded="false" aria-controls="panel-layout">' +
    rb.rbKey('sitemanager.content.tabs.layoutobjects') +
    '</a>\n      </h4>\n    </div>\n      <div id="panel-layout" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-layout" aria-expanded="false" style="height: 0px;">\n        <div class="mura-panel-body">\n\n      \t\t\t<span id="extendset-container-tablayoutobjectstop" class="extendset-container"></span>\n            <div class="mura-control-group">\n\n                    <div class="mura-control-group">\n                      <label>\n                          ' +
    popoverLabel(rb, ' '.repeat(26), 'tooltip.layoutTemplate', 'sitemanager.content.fields.layouttemplate') +
    '\n                \t\t\t</label>\n    \t\t              <select name="template" class="dropdown">\n    \t\t\t            ';
  if (!cfEq(m.rcContentId, ROOT_CONTENT_ID)) {
    out += `\n    \t\t\t              <option value="">${rb.rbKey('sitemanager.content.fields.inheritfromparent')}</option>\n    \t\t\t            `;
  }
  const templateArray = m.rendererTemplates ?? cfListToArray(structText(m.site, 'templateList'), '^');
  if (cfEq(m.moduleId, CONTENT_MODULE_ID) && templateArray.length > 0) {
    // Legacy bounds this loop by renderer.templateArray, which fails when the renderer's value is not an array.
    if (m.rendererTemplates === null) throw new TypeError('renderer.templateArray is not an array');
    for (const name of templateArray) {
      out += templateOption('\n    \t\t\t                  ', name, m.content.template, '\n    \t\t\t                ');
    }
  } else {
    for (const name of layoutFiles(m.templateNames)) {
      out += templateOption('\n    \t\t\t\t                ', name, m.content.template, '\n    \t\t\t\t              ');
    }
  }
  return `${out}\n    \t\t          \t\t</select>\n            \t\t\t</div>\n`;
}

/** The child template select (lines 129-157). */
function childTemplateSelect(rb: RbLookup, m: LayoutObjectsModel): string {
  let out =
    '\n                  <div class="mura-control-group">\n                  <label>\n                    ' +
    popoverLabel(rb, ' '.repeat(20), 'tooltip.childTemplate', 'sitemanager.content.fields.childtemplate') +
    '\n                  </label>\n                  <select name="childTemplate" class="dropdown">\n    \t            <option value="">' +
    rb.rbKey('sitemanager.content.fields.none') +
    '</option>\n    \t\t\t\t\t\t\t';
  const templateArray = cfListToArray(structText(m.site, 'templateList'), '^');
  if (cfEq(m.moduleId, CONTENT_MODULE_ID) && templateArray.length > 0) {
    for (const name of templateArray) {
      out += templateOption('\n    \t                  ', name, m.content.childTemplate, '\n    \t                ');
    }
  } else {
    for (const name of layoutFiles(m.templateNames)) {
      out += templateOption('\n    \t\t                  ', name, m.content.childTemplate, '\n    \t\t                ');
    }
  }
  return `${out}\n    \t          </select>\n            </div>\n          </div>\n`;
}

/** The inheritance rules: label, current inheritance and the three cascade radios (lines 159-190). */
function inheritanceRules(rb: RbLookup, m: LayoutObjectsModel): string {
  let out =
    '          \n          <div class="mura-control-group">\n            <label>\n              ' +
    popoverLabel(rb, ' '.repeat(14), 'tooltip.inheritancerules', 'sitemanager.content.fields.inheritancerules') +
    '\n            </label>\n             ';
  const inherited = m.inherited;
  if (inherited !== undefined && !cfEq(inherited.contentId, m.content.contentId)) {
    const title = encodeHtml(inherited.menuTitle);
    out += `\n                <div class="help-block">${rb.rbKey('sitemanager.content.currentinheritance')}:\n                `;
    // The edit URL prints unencoded, as legacy prints it.
    out += cfListHas('author,editor', inherited.perm, { noCase: true })
      ? `\n                  <a href='${inherited.editUrl}'>${title}</a>\n                `
      : title + spaceAfter(title);
    out += '\n                </div>\n                ';
  }
  const rule = m.content.inheritObjects;
  const checked = (on: boolean): string => (on ? 'checked' : '');
  return (
    out +
    `\n            <label for="ioi" class="radio inline">\n            <input type="radio" name="inheritObjects" id="ioi" value="Inherit" ${checked(cfEq(rule, 'inherit') || cfEq(rule, ''))}>` +
    rb.rbKey('sitemanager.content.fields.inheritcascade') +
    `\n            </label>\n            <label for="ioc" class="radio inline">\n            <input type="radio" name="inheritObjects" id="ioc" value="Cascade" ${checked(cfEq(rule, 'cascade'))}>\n            ` +
    rb.rbKey('sitemanager.content.fields.startnewcascade') +
    `\n            </label>\n            <label for="ior" class="radio inline">\n            <input type="radio" name="inheritObjects" id="ior" value="Reject" ${checked(cfEq(rule, 'reject'))}>\n            ` +
    rb.rbKey('sitemanager.content.fields.donotinheritcascade') +
    '\n            </label>\n          </div>\n\n            '
  );
}

/** The inline-edit notice a layout-manager renderer shows instead of the region editor (lines 192-198). */
function layoutManagerNotice(rb: RbLookup, m: LayoutObjectsModel): string {
  const { content } = m;
  // The web path, URL stem and history id print unencoded, as legacy prints them.
  return (
    '\n              <div class="mura-control-group">\n                <label>' +
    rb.rbKey('sitemanager.content.fields.contentobjects') +
    '</label>\n                <div class="help-block">\n                  <p>To manage content objects, <a href="#" onclick="return preview(\'' +
    `${structText(m.site, 'webPath')}${content.urlStem}?previewid=${content.contentHistId}','${encodeJs(content.targetParams)}');` +
    '">preview this content node</a> and select the "Inline Edit" option.</p>\n                </div>\n              </div>\n\n            '
  );
}

/**
 * The object class selector's options (lines 219-241). A site's custom `dsp_objectClassLabel.cfm` include is CFML only
 * legacy can run, and no served site has one, so nothing prints in its place.
 */
function objectClassOptions(rb: RbLookup, site: CarchStruct): string {
  const pad = '\n                              ';
  const option = (value: string, key: string, lead = pad): string =>
    `${lead}<option value="${value}">${rb.rbKey(`sitemanager.content.fields.${key}`)}</option>`;
  let out = option('', 'selectobjecttype', '') + option('system', 'system') + option('navigation', 'navigation') + pad;
  if (flagAt(site, 'emailBroadcaster', 'rc.site.emailBroadcaster')) out += option('mailingList', 'mailinglists') + pad;
  out +=
    '                              \n                              ' +
    option('folder', 'Folders') +
    option('calendar', 'calendars') +
    option('gallery', 'galleries') +
    option('component', 'components') +
    pad;
  if (flagAt(site, 'dataCollection', 'rc.site.dataCollection')) {
    out += option('form', 'forms', '\n                                ') + pad;
  }
  if (flagAt(site, 'hasFeedManager', 'rc.site.hasFeedManager')) {
    out += option('localFeed', 'localindexes') + option('slideshow', 'localindexslideshows');
    out += option('remoteFeed', 'remotefeeds') + pad;
  }
  return `${out}${pad}<option value="plugins">${rb.rbKey('layout.plugins')}</option>`;
}

/** `request.rsContentObjects<r>` rows; an unreported region is the view's empty `cfparam` default. */
function regionObjects(rc: CarchStruct, region: number): readonly RegionObject[] {
  const key = `rsContentObjects${region}`;
  const rows = rowsAt(rc, key, `rc.${key}`) ?? [];
  return rows.map((row) => ({
    object: structText(row, 'object'),
    name: structText(row, 'name'),
    objectId: structText(row, 'objectid'),
    params: structText(row, 'params'),
  }));
}

/** One display region: its move buttons, heading, object list and hidden `objectList<r>` (lines 249-275). */
function displayRegion(rb: RbLookup, m: LayoutObjectsModel, r: number, columnNames: string): string {
  let out =
    '\n                        <div class="region">\n                                <div class="btn-group btn-group-vertical"> <a class="objectNav btn" onclick="siteManager.addDisplayObject(\'availableObjects\' + availableObjectSuffix,' +
    `${r},true);"> <i class="mi-caret-right"></i></a> <a class="objectNav btn" onclick="siteManager.deleteDisplayObject(${r});"> <i class="mi-caret-left"></i></a> </div>\n                          `;
  // A named region opens a `<dl>`; legacy's `Region <r>` fallback opens only its `<dt>`.
  if (cfListLen(columnNames, '^') >= r) {
    const name = cfListGetAt(columnNames, r, '^');
    out += `\n                            <dl>\n                            <dt>${name}${spaceAfter(name)}`;
  } else {
    out += `\n                            <dt>\n                            Region ${r} `;
  }
  out +=
    rb.rbKey('sitemanager.content.fields.contentobjects') +
    `\n                          </dt>\n                          \n                          <dd>\n                            <select name="selectedObjects${r}" id="selectedObjects${r}" class="multiSelect displayRegions" multiple="multiple" size="4" data-regionid="${r}">\n                              `;
  // Object type and id print unencoded beside the encoded name and params, as legacy builds each value.
  const values: string[] = [];
  for (const row of regionObjects(m.rc, r)) {
    const value = `${row.object}~${encodeHtml(row.name)}~${row.objectId}~${encodeHtml(row.params)}`;
    values.push(value);
    out += `\n                                <option  value="${value}">\n                                ${row.name}\n\n                                </option>\n                                `;
  }
  return (
    out +
    `\n                            </select>\n                            <input type="hidden" name="objectList${r}" id="objectList${r}" value="${values.join('^')}">\n                          </dd>\n                          </dl>\n                                <div class="btn-group btn-group-vertical"> <a class="objectNav btn" value="` +
    `${rb.rbKey('sitemanager.content.fields.up')}" onclick="siteManager.moveDisplayObjectUp(${r});"> <i class="mi-caret-up"></i></a> <a class="objectNav btn" value="` +
    `${rb.rbKey('sitemanager.content.fields.down')}" onclick="siteManager.moveDisplayObjectDown(${r});"> <i class="mi-caret-down"></i></a> </div>\n                        </div> \n                      `
  );
}

/** The `#bigui__layoutobjects` region editor of a renderer without the layout manager (lines 200-283). */
function regionEditor(rb: RbLookup, m: LayoutObjectsModel): string {
  const contentObjects = rb.rbKey('sitemanager.content.fields.contentobjects');
  const { site } = m;
  let out =
    `\n              <div class="mura-control-group">\n                <label>${contentObjects}</label>\n                \n                \n                <div class="bigui" id="bigui__layoutobjects" data-label="${encodeHtmlAttr('Manage Objects')}">\n                  <div class="bigui__title">${encodeHtmlAttr(contentObjects)}</div>\n                  \n                  <div class="bigui__controls">\n\n                        <div id="editObjects">\n                        <script>\n                         var availableObjectSuffix='';\n                        </script>\n                        <div id="availableObjectsContainer">\n                        <dl>\n                          <dt>` +
    rb.rbKey('sitemanager.content.fields.availablecontentobjects') +
    // The content and history ids print unencoded, as legacy prints them.
    `</dt>\n                          <dd>\n                            <select name="classSelector" onchange="siteManager.loadObjectClass('${encodeJs(m.siteId)}',this.value,'','${m.content.contentId}','${encodeJs(m.parentId)}','${m.content.contentHistId}',0);"  id="dragme">\n                              ` +
    objectClassOptions(rb, site) +
    '\n                            </select>\n                          </dd>\n                        </dl>\n                        <div id="classList"></div>\n                    </div>\n                    <div id="availableRegions">\n                      ';
  const columnCount = cfToNumber(structValue(site, 'columnCount'));
  const columnNames = structText(site, 'columnNames');
  for (let r = 1; r <= columnCount; r += 1) out += displayRegion(rb, m, r, columnNames);
  return (
    out +
    '\n                    </div> \n                  </div> \n\n                  </div>\n                </div> \n\n              </div> \n        '
  );
}

/** The image size, field list and records-per-page controls (lines 287-355). */
function listDisplayOptions(rb: RbLookup, m: LayoutObjectsModel): string {
  const text = (key: string): string => structText(m.bean, key);
  const imageSize = text('imageSize');
  const displayList = text('displayList');
  const selected = (on: boolean): string => (on ? ' selected' : '');
  let out =
    '\n          \n          <div class="mura-control-group">\n              <label>' +
    rb.rbKey('collections.imagesize') +
    `</label>\n            <select name="imageSize" data-displayobjectparam="imageSize" onchange="if(this.value=='custom'){jQuery('#feedCustomImageOptions').fadeIn('fast')}else{jQuery('#feedCustomImageOptions').hide();jQuery('#feedCustomImageOptions').find(':input').val('AUTO');}">\n              `;
  for (const size of ['Small', 'Medium', 'Large']) {
    out += `\n                <option value="${size.toLowerCase()}"${selected(cfEq(size, imageSize))}>${size}</option>\n              `;
  }
  const customSizes = requiredRows(m.site, 'customImageSizes', 'rc.site.customImageSizes');
  for (const name of customSizes.map((row) => structText(row, 'name'))) {
    out += `\n                <option value="${name.toLowerCase()}"${selected(cfEq(name, imageSize))}>${encodeHtml(name)}</option>\n              `;
  }
  out +=
    `\n              <option value="custom"${selected(cfEq('custom', imageSize))}>Custom</option>\n            </select>\n          </div>\n\n          <div id="feedCustomImageOptions" class="mura-control-group"${cfEq(imageSize, 'custom') ? '' : ' style="display:none"'}>\n            <span class="half">\n              <label>` +
    rb.rbKey('collections.imagewidth') +
    `</label>\n              <input name="imageWidth" data-displayobjectparam="imageWidth" type="text" value="${text('imageWidth')}" />\n            </span>\n            <span class="half">\n              <label>` +
    rb.rbKey('collections.imageheight') +
    `</label>\n              <input name="imageHeight" data-displayobjectparam="imageHeight" type="text" value="${text('imageHeight')}" />\n            </span>\n          </div>\n      \n          <div class="mura-control-group" id="availableFields">\n            <label>\n              <span class="half">Available Fields</span> <span class="half">Selected Fields</span>\n            </label>\n          \n            <div id="sortableFields">\n              <p class="dragMsg">\n                <span class="dragFrom half">Drag Fields from Here&hellip;</span><span class="half">&hellip;and Drop Them Here.</span>\n              </p>              \n            \n              <ul id="contentAvailableListSort" class="contentDisplayListSortOptions">\n                `;
  for (const field of cfListToArray(text('availableDisplayList'))) {
    out += `\n                  <li class="ui-state-default">${javaTrim(field)}</li>\n                `;
  }
  out += '\n              </ul>\n              <ul id="contentDisplayListSort" class="contentDisplayListSortOptions">\n                ';
  for (const field of cfListToArray(displayList)) {
    out += `\n                  <li class="ui-state-highlight">${javaTrim(field)}</li>\n                `;
  }
  out +=
    `\n              </ul>\n              <input type="hidden" id="contentDisplayList" value="${displayList}" name="displayList"/>     \n              <script>\n                //Removed from jQuery(document).ready() because it would not fire in ie7 frontend editing.\n                siteManager.setContentDisplayListSort();\n              </script>\n            </div>\n            </div>\n\n          <div class="mura-control-group">\n            <label>` +
    rb.rbKey('sitemanager.content.fields.recordsperpage') +
    '</label> \n            <select name="nextN" class="dropdown">\n              ';
  const nextN = text('nextN');
  for (const count of RECORDS_PER_PAGE) {
    out += `\n                <option value="${count}" ${cfEq(count, nextN) ? 'selected' : ''}>${count}</option>\n              `;
  }
  return `${out}\n            </select>\n          </div>\n\n        `;
}

/** The view's `nextN` choices. */
const RECORDS_PER_PAGE: readonly string[] = Object.freeze(
  '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,25,50,100'.split(','),
);

/** The extended attributes container and the panel's closing tags (lines 358-374). */
const PANEL_CLOSE =
  '\n        \n\n\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-layoutobjects">\n\t\t\t\t\t<div class="bigui" id="bigui__layoutobjects" data-label="Manage Extended Attributes">\n\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>\n\t\t\t\t\t\t<div class="bigui__controls">\n\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>\n\t\t\t\t\t\t\t<span id="extendset-container-layoutobjects" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-layoutobjects"></span>\n\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t\n\t\t\t\t</div>\n\n      <span id="extendset-container-tablayoutobjectsbottom" class="extendset-container"></span>\n\n    </div>\n  </div>\n</div> \n  ';

/** The non-plugin display objects `dsp_configuratorJS.cfm` registers configurators for. */
function displayObjectsOf(site: CarchStruct): ConfiguratorDisplayObject[] {
  return requiredRows(site, 'displayObjectLookup', 'rc.site.displayObjectLookup').map((row) => ({
    objectid: structText(row, 'objectid'),
    configuratorInit: structText(row, 'configuratorInit'),
    configuratorJS: structText(row, 'configuratorJS'),
  }));
}

/**
 * `form/dsp_panel_layoutobjects.cfm`: the Layout & Objects panel, from the include's first output through the
 * configurator script of `dsp_configuratorJS.cfm`. The caller decides whether the panel is included.
 */
export function renderLayoutObjectsPanel(input: EditFormInput): PanelResult {
  const { rb } = input.ctx;
  const m = readModel(input);
  let out = templateSelect(rb, m) + childTemplateSelect(rb, m) + inheritanceRules(rb, m);
  out += m.useLayoutManager ? layoutManagerNotice(rb, m) : regionEditor(rb, m);
  // Legacy's `Calender` misspelling keeps Calendar nodes from the list display options.
  const listDisplay =
    cfEq(m.moduleId, CONTENT_MODULE_ID) &&
    !m.useLayoutManager &&
    cfListHas('Page,Folder,Gallery,Calender', m.type, { noCase: true }) &&
    tabAllowed(m.tabAssignments, 'List Display Options');
  if (listDisplay) out += listDisplayOptions(rb, m);
  out += PANEL_CLOSE;
  const configurator = configuratorJs(input.ctx, {
    contentId: m.rcContentId,
    parentId: m.parentId,
    contentHistId: m.rcContentHistId,
    contentBeanHistId: m.content.contentHistId,
    customTagGroups: structText(m.site, 'customTagGroups'),
    ...(m.allowOpenFeeds === undefined ? {} : { allowOpenFeeds: m.allowOpenFeeds }),
    displayObjects: displayObjectsOf(m.site),
    useLayoutManager: m.useLayoutManager,
    siteAssetPath: structText(m.site, 'assetPath'),
  });
  return {
    html: raw(out + configurator.value),
    tabId: 'tabLayoutObjects',
    tabLabel: rb.rbKey('sitemanager.content.tabs.layoutobjects'),
  };
}
