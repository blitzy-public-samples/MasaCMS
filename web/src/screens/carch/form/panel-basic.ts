// The content editor's Basic panel and body editor (`admin/core/views/carch/form/dsp_panel_basic.cfm`), server-only.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  structOf,
  structText,
  structValue,
  type CarchStruct,
} from '../model';
import { cfListHas, tabAllowed, type EditFormInput, type EditFormState, type PanelResult } from './custom-tags';
import { renderFileSelector } from './file-selector';
import { renderTypeSelector } from './type-selector';

// The edit model's `rc` is an open struct; this panel reads, case-insensitively:
// - `contentBean`: `title`, `menuTitle`, `URLTitle`, `HTMLTitle`, `isNew`, `isLocked`, `parentID`, `moduleAssign`,
//   `responseChart`, `responseMessage`, `responseSendTo`, `body`, `summary` and, while `rc.preview` is 1, `previewURL`
//   (`getURL(secure=<request is HTTPS>, complete=1, queryString='previewid=<contentHistID>')`);
// - `crumbData`: the `contentManager.getCrumbList` rows, of which `menutitle` is read;
// - `site`: settingsBean `locking`, `dataCollection`, `emailBroadcaster` and `razunaSettings.hostname` of the session
//   site, which carch keeps as `rc.siteid`; absent Razuna settings read as none, as every site has while they stay
//   on legacy;
// - `showExtensionsInDefault`: configBean `showextensionsindefault`, which no settings key sets; absent reads as false.
// `htmlEditorType` and `formpolls` come from the legacy settings.
// The markup is the include as ACF 2023 emits it: template text between two CFML constructs is copied byte for byte,
// CFML comments are dropped with the text around them joined, and text that is only whitespace prints one space after
// output that does not already end in whitespace, else nothing (`ViewOutput.t`).

const OPERATION = 'strategies-content getContentEditModel';

/** `cfcase` types with the popover title and the SEO titles. */
const TITLE_TYPES = 'Page,Folder,Calendar,Gallery,File,Link';
/** contentManager `HTMLBodyList`. */
const HTML_BODY_TYPES = 'Form,Gallery,Calendar,Component,Page,Folder';
/** Email Broadcaster module. */
const EMAIL_BROADCASTER_MODULE_ID = '00000000000000000000000000000000005';

const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;

/** One include's or `cfsavecontent` body's output under ACF whitespace management. */
class ViewOutput {
  #out = '';

  /** Template text between two CFML constructs; whitespace-only text prints one space after non-whitespace. */
  t(text: string): this {
    if (!TEMPLATE_WHITESPACE.test(text)) this.#out += text;
    else if (this.#out !== '' && this.#out.charCodeAt(this.#out.length - 1) > 0x20) this.#out += ' ';
    return this;
  }

  /** The output of a `#…#` expression or an included template. */
  e(value: string): this {
    this.#out += value;
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

/** The values the include reads, after edit.cfm's own adjustments. */
interface BasicView {
  readonly rb: (key: string) => string;
  readonly state: EditFormState;
  /** The edit model's `rc`. */
  readonly model: CarchStruct;
  /** `rc.contentBean`. */
  readonly bean: CarchStruct;
  /** `application.settingsManager.getSite(rc.siteid)`. */
  readonly site: CarchStruct;
  readonly isNew: boolean;
  /** Request `rc.type`. */
  readonly type: string;
  readonly siteId: string;
  /** Request `rc.contentid`. */
  readonly contentId: string;
  /** `rc.parentID` as edit.cfm leaves it. */
  readonly parentId: string;
  readonly moduleId: string;
  /** `rc.contentBean.getTitle()` as edit.cfm leaves it. */
  readonly title: string;
  /** `rc.preview eq 1`. */
  readonly preview: boolean;
}

/** `rc[name]` of the case-insensitive request context, failing as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A settingsBean value of `rc.site`; throws when the edit model omits it. */
function siteValue(site: CarchStruct, key: string): unknown {
  const value = structValue(site, key);
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no rc.site.${key}`);
  return value;
}

/** A configBean flag the edit model reports; absent reads as `false`, as `get()` of an unset key compares. */
function configFlag(model: CarchStruct, key: string): boolean {
  const value = structValue(model, key);
  return value === undefined || value === null ? false : cfToBoolean(value);
}

/** `getRazunaSettings().getHostname()`; `''` when the site carries no Razuna settings. */
function razunaHostname(site: CarchStruct): string {
  const settings = structValue(site, 'razunaSettings');
  return isStruct(settings) ? structText(settings, 'hostname') : '';
}

/** `rc.crumbData`; throws unless the edit model holds it as an array of structs. */
function crumbsOf(model: CarchStruct): readonly CarchStruct[] {
  const value = structValue(model, 'crumbData');
  if (!Array.isArray(value) || !value.every(isStruct)) {
    throw new TypeError(`${OPERATION} returned no rc.crumbData rows`);
  }
  return value;
}

/** `rc.contentBean.getURL(…, queryString="previewid=<contentHistID>")` as the edit model built it. */
function previewUrl(bean: CarchStruct): string {
  const value = structValue(bean, 'previewURL');
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no rc.contentBean.previewURL`);
  return structText(bean, 'previewURL');
}

/** The panel's view of the edit form input. */
function readView(input: EditFormInput): BasicView {
  const { ctx, req, data, state } = input;
  const bean = structOf(data.rc, 'contentBean');
  const isNew = cfToBoolean(structValue(bean, 'isNew'));
  const rcParentId = rcText(req.rc, 'parentID');
  const rcTitle = req.rc.title ?? '';
  return {
    rb: (key) => ctx.rb.rbKey(key),
    state,
    model: data.rc,
    bean,
    site: structOf(data.rc, 'site'),
    isNew,
    type: rcText(req.rc, 'type'),
    siteId: rcText(req.rc, 'siteid'),
    contentId: rcText(req.rc, 'contentid'),
    // edit.cfm: a stored node edited without a parentid takes its own parent, and a new node a requested title.
    parentId: rcParentId === '' && !isNew ? structText(bean, 'parentID') : rcParentId,
    moduleId: rcText(req.rc, 'moduleid'),
    title: isNew && rcTitle !== '' ? rcTitle : structText(bean, 'title'),
    preview: cfEq(state.preview, '1'),
  };
}

// ---- Panel ----

const PANEL_HEADING =
  '\n' +
  '<div class="mura-panel panel">\n' +
  '\t<div class="mura-panel-heading" role="tab" id="heading-basic">\n' +
  '\t\t<h4 class="mura-panel-title">\n' +
  '\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" ' +
  'href="#panel-basic" aria-expanded="true" aria-controls="panel-basic">';

const PANEL_BODY_START =
  '</a>\n' +
  '\t\t</h4>\n' +
  '\t</div>\n' +
  '\t<div id="panel-basic" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-basic" ' +
  'aria-expanded="false" style="height: 0px;">\n' +
  '\t\t<div class="mura-panel-body">\n' +
  '\n' +
  '\t\t\t\t<span id="extendset-container-tabbasictop" class="extendset-container"></span>\n' +
  '\n' +
  '\t\t\t\t\n' +
  '\t\t\t\t';

const PAGE_TITLE_START =
  '\n' +
  '\t\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t\t\t<label>\n' +
  '\t\t\t\t\t\t    \t<span data-toggle="popover" title="" data-placement="right"\n' +
  '\t\t\t\t\t\t    \tdata-content="';

/** From the label's text through the `value` attribute of the title input, around the stripped `cfset`. */
const PAGE_TITLE_INPUT =
  ' <i class="mi-question-circle"></i></span>\n' +
  '\t\t\t\t\t\t    </label>\n' +
  '\t\t\t\t\t\t   \t' +
  '\n\t\t\t\t\t\t\t<input type="text" id="title" name="title" value="';

const ADDITIONAL_TITLES_START =
  '\n' +
  '\t\t\t\t\t\t\t\t<div class="help-block" id="editAdditionalTitles" style="display:none;">\n' +
  '\t\t\t\t\t\t\t\t\t<p>';

const ADDITIONAL_TITLES_BUTTON =
  '</p><br />\n' +
  '\t\t\t\t\t\t\t\t\t<button type="button" id="resetTitles" name="resetTitles" class="btn">';

const SEO_FIELD_START =
  '\n' +
  '\t\t\t\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t\t\t\t\t<label>\n' +
  '\t\t\t\t\t\t\t\t  \t<span data-toggle="popover" title="" data-placement="right"\n' +
  '\t\t\t\t\t\t\t\t    \tdata-content="';

const SEO_FIELD_END = '"  maxlength="255">\n\t\t\t\t\t\t\t\t</div>\n';

/** A `#mura-seo-titles` field: rb key suffixes, the bean value and input id, and the source's icon-line indent. */
interface SeoField {
  readonly tooltipKey: string;
  readonly labelKey: string;
  readonly id: string;
  readonly iconIndent: string;
}

const SEO_FIELDS: readonly SeoField[] = [
  { tooltipKey: 'navigationTitle', labelKey: 'menutitle', id: 'menuTitle', iconIndent: '\t'.repeat(9) },
  { tooltipKey: 'urlTitle', labelKey: 'urltitle', id: 'urlTitle', iconIndent: '\t'.repeat(10) },
  { tooltipKey: 'htmlTitle', labelKey: 'htmltitle', id: 'htmlTitle', iconIndent: '\t'.repeat(10) },
];

/** One `#mura-seo-titles` field: its popover label, icon line and text input. */
function seoField(o: ViewOutput, v: BasicView, field: SeoField): void {
  const label = v.rb(`sitemanager.content.fields.${field.labelKey}`);
  o.t(SEO_FIELD_START).e(encodeHtmlAttr(v.rb(`tooltip.${field.tooltipKey}`)));
  o.t('"\n\t\t\t\t\t\t\t\t    \tdata-original-title="').e(encodeHtmlAttr(label));
  o.t('"\n\t\t\t\t\t\t\t\t    \t>\n\t\t\t\t\t\t\t\t    \t\t\t\t').e(label);
  const indent = field.iconIndent;
  o.t(`\n${indent} <i class="mi-question-circle"></i>\n${indent}</span>\n\t\t\t\t\t\t\t\t\t</label>`);
  o.t(`\n\t\t\t\t\t\t\t\t\t<input type="text" id="${field.id}" name="${field.id}" value="`);
  o.e(encodeHtmlAttr(structText(v.bean, field.id))).t(SEO_FIELD_END);
}

/** The popover title, with the additional-titles notice and the SEO titles where the SEO tab applies (lines 96-161). */
function pageTitles(o: ViewOutput, v: BasicView): void {
  const hasSeoTab = cfEq(v.moduleId, CONTENT_MODULE_ID) && tabAllowed(v.state.tabAssignments, 'SEO');
  const label = v.rb('sitemanager.content.fields.title');
  o.t(PAGE_TITLE_START).e(encodeHtmlAttr(v.rb('tooltip.pageTitle')));
  o.t('"\n\t\t\t\t\t\t    \tdata-original-title="').e(encodeHtmlAttr(label));
  o.t('"\n\t\t\t\t\t\t    \t>\n\t\t\t\t\t\t    \t').e(label);
  o.t(PAGE_TITLE_INPUT).e(encodeHtmlAttr(v.title));
  o.t('"  maxlength="255" required="true" message="').e(v.rb('sitemanager.content.fields.titlerequired')).t('" ');
  if (hasSeoTab && !v.isNew) {
    o.t("onkeypress=\"openDisplay('editAdditionalTitles','").e(v.rb('sitemanager.content.fields.close')).t('\');"');
  }
  o.t('>\n\t\t\t\t\t\t\t<div id="alertTitleSuccess" class="help-block" style="display:none;">');
  o.e(v.rb('sitemanager.content.seotitlescleared')).t(' </div>\n\n\t\t\t\t\t\t\t');
  if (hasSeoTab) {
    o.t(ADDITIONAL_TITLES_START).e(v.rb('sitemanager.content.fields.AdditionalTitlesnote'));
    o.t(ADDITIONAL_TITLES_BUTTON).e(v.rb('sitemanager.content.clearseotitles'));
    o.t('</button>\n\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t </div>\n\n\t\t\t\t\t\t');
  if (hasSeoTab) {
    o.t('\n\n\t\t\t\t\t\t\t<div id="mura-seo-titles">');
    for (const field of SEO_FIELDS) seoField(o, v, field);
    o.t('\n\t\t\t\t\t\t\t</div><!-- /mura-seo-titles -->\n\n\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t');
}

const PLAIN_TITLE_START =
  '\n' +
  '\t\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t      \t\t<label>\n' +
  '\t\t\t      \t\t\t\t';

const PLAIN_TITLE_INPUT =
  '\n' +
  '\t\t\t      \t\t\t</label>\n' +
  '\t\t\t\t     \t\t<input type="text" id="title" name="title" value="';

const PLAIN_TITLE_END =
  '>\n' +
  '\t\t\t     \t\t \t<input type="hidden" id="menuTitle" name="menuTitle" value="">\n' +
  '\t\t\t     \t\t</div>\n' +
  '\t\t\t\t\t';

/** The other types' plain title, disabled while the content is locked, and an empty menu title (lines 164-170). */
function plainTitle(o: ViewOutput, v: BasicView): void {
  o.t(PLAIN_TITLE_START).e(v.rb('sitemanager.content.fields.title'));
  o.t(PLAIN_TITLE_INPUT).e(encodeHtmlAttr(v.title));
  o.t('"  maxlength="255" required="true" message="').e(v.rb('sitemanager.content.fields.titlerequired')).t('"');
  if (cfToBoolean(structValue(v.bean, 'isLocked'))) o.t(' disabled="disabled"');
  o.t(PLAIN_TITLE_END);
}

const PARENT_START =
  '\n' +
  '\t\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t      \t\t<label>\n' +
  '\t\t\t\t\t  \t\t\t';

const PARENT_CONTROL =
  '\n' +
  '\t\t\t      \t\t\t</label>\n' +
  '\t\t\t      \t\t\t<div class="mura-control justify">\n' +
  '\t\t\t\t  \t\t\t\t';

const NEW_PARENT_LABEL_START =
  '\n' +
  '\t\t\t\t  \t\t\t\t\t<div id="newparent-label">\n' +
  '\t\t\t\t\t      \t\t\t"<span>';

const NEW_PARENT_LABEL_END =
  '</span>"\n' +
  '\t\t\t\t\t  \t\t\t\t</div>\n' +
  '\t\t\t\t  \t\t\t\t';

const SELECT_PARENT_START =
  '\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\n' +
  '\t\t\t\t\t\t\t\t<div class="bigui" id="bigui__selectparent" data-label="';

const SELECT_PARENT_FIELD =
  '</div>\n' +
  '\t\t\t\t\t\t\t\t\t<div class="bigui__controls">\n' +
  '\t\t\t\t\t\t\t\t\t\t\n' +
  '\t\t\t\t\t\t\t\t    <span id="mover2" style="display:none"><input type="hidden" name="parentid" value="';

const SELECT_PARENT_SCRIPT =
  '"></span>\n' +
  '\t\t\t\t\t\t\t\t\t</div>\n' +
  '\t\t\t\t\t\t\t\t</div> \n' +
  '\n' +
  '\t\t\t\t\t\t\t\t<script>\n' +
  '\t\t\t\t\t\t\t\t\tjQuery(document).ready(function(){\n' +
  '\t\t\t\t\t\t\t\t\t\tsiteManager.loadSiteParents(\n' +
  "\t\t\t\t\t\t\t\t\t\t\t'";

const LOAD_SITE_PARENTS_ARG = "'\n\t\t\t\t\t\t\t\t\t\t\t,'";

const SELECT_PARENT_SCRIPT_END =
  "'\n" +
  "\t\t\t\t\t\t\t\t\t\t\t,''\n" +
  '\t\t\t\t\t\t\t\t\t\t\t,1\n' +
  '\t\t\t\t\t\t\t\t\t\t);\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\t\t// populate current parent text when changed\n' +
  "\t\t\t\t\t\t\t\t\t\tjQuery(document).on('click', '#mover2 input[name=\"parentid\"]',function(){\n" +
  "\t\t\t\t\t\t\t\t\t\t\tvar newparent = jQuery(this).parents('tr').find('ul.navZoom li:last-child').text().trim();\n" +
  "\t\t\t\t\t\t\t\t\t\t\tjQuery('#newparent-label > span').html(newparent);\n" +
  '\t\t\t\t\t\t\t\t\t\t})\n' +
  "\t\t\t\t\t\t\t\t\t\tjQuery(document).on('click', '#mover2 td.var-width',function(){\n" +
  "\t\t\t\t\t\t\t\t\t\t\tvar parentradio = jQuery(this).parents('tr').find('td.actions input[name=\"parentid\"]');\n" +
  "\t\t\t\t\t\t\t\t\t\t\tjQuery(parentradio).trigger('click');\n" +
  '\t\t\t\t\t\t\t\t\t\t})\n' +
  '\t\t\t\t\t\t\t\t\t});\n' +
  '\t\t\t\t\t\t\t\t</script>\n' +
  '\t\t\t\t\t\t\t</div> \n' +
  '\t\t\t\t\t\t</div> \n' +
  '\n' +
  '\t\t\t\t\t';

/** The content parent label, current parent and parent selector with its loader script (lines 181-223). */
function parentSelector(o: ViewOutput, v: BasicView): void {
  o.t(PARENT_START).e(v.rb('sitemanager.content.fields.contentparent')).t(PARENT_CONTROL);
  const crumbs = crumbsOf(v.model);
  if (crumbs.length > 1) {
    const crumb = crumbs[v.isNew ? 0 : 1] as CarchStruct;
    o.t(NEW_PARENT_LABEL_START).e(structText(crumb, 'menutitle')).t(NEW_PARENT_LABEL_END);
  }
  const selectLabel = encodeHtmlAttr(v.rb('sitemanager.content.fields.selectnewparent'));
  o.t(SELECT_PARENT_START).e(selectLabel).t('">\n\t\t\t\t\t\t\t\t\t<div class="bigui__title">').e(selectLabel);
  o.t(SELECT_PARENT_FIELD).e(encodeHtmlAttr(v.parentId)).t(SELECT_PARENT_SCRIPT).e(encodeJs(v.siteId));
  o.t(LOAD_SITE_PARENTS_ARG).e(encodeJs(v.contentId)).t(LOAD_SITE_PARENTS_ARG).e(encodeJs(v.parentId));
  o.t(SELECT_PARENT_SCRIPT_END);
}

/** The parent selector where the site's locking lets the node move, else a hidden `parentid` (lines 176-231). */
function contentParent(o: ViewOutput, v: BasicView): void {
  const locking = String(siteValue(v.site, 'locking'));
  const underRoot = cfEq(v.parentId, ROOT_CONTENT_ID);
  const movable =
    ((!underRoot && !cfEq(locking, 'all')) || (underRoot && cfEq(locking, 'none'))) &&
    !cfEq(v.contentId, ROOT_CONTENT_ID);
  if (movable) {
    // A movable node's site never locks `all`, so the include's inner `locking neq 'all'` test always holds.
    o.t('\n\n\n\n\t\t\t\t\t');
    parentSelector(o, v);
    o.t(' \n\n\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t<input type="hidden" name="parentid" value="').e(encodeHtmlAttr(v.parentId)).t('">\n\t\t\t\t');
  }
  o.t(' \n\n\t\t\t\t\n\t\t\t\t');
}

const COMPONENT_ASSIGN_START =
  '\n' +
  '\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t    <label>\n' +
  '\t\t\t\t      \t\t';

const CONTENT_CHECKBOX =
  '\n' +
  '\t\t\t\t      \t</label>\n' +
  '\t\t\t\t\t\t<label for="m1" class="checkbox inline">\n' +
  '\t\t\t\t\t\t\t<input name="moduleAssign" type="CHECKBOX" id="m1" value="00000000000000000000000000000000000" ';

const COMPONENTS_CHECKBOX =
  '\n' +
  '\t\t\t\t\t\t</label>\n' +
  '\n' +
  '\t\t\t\t\t\t<label for="m2" class="checkbox inline">\n' +
  '\t\t\t\t\t\t\t<input name="moduleAssign" type="CHECKBOX" id="m2" value="00000000000000000000000000000000003" ';

const FORMS_CHECKBOX =
  '\n' +
  '\t\t\t\t\t\t\t<label for="m3" class="checkbox inline">\n' +
  '\t\t\t\t\t\t\t\t<input name="moduleAssign" type="CHECKBOX" id="m3" value="00000000000000000000000000000000004" ';

const EMAIL_CHECKBOX =
  '\n' +
  '\t\t\t\t\t\t\t<label for="m4" class="checkbox inline">\n' +
  '\t\t\t\t\t\t\t\t<input name="moduleAssign" type="CHECKBOX" id="m4"  value="00000000000000000000000000000000005" ';

/** `moduleAssign` lists `moduleId`, matched case-sensitively as `listFind` matches. */
const assigned = (v: BasicView, moduleId: string): boolean => cfListHas(structText(v.bean, 'moduleAssign'), moduleId);

/** The Component's module checkboxes; Forms and Email Broadcaster only where the site has them (lines 394-419). */
function componentModules(o: ViewOutput, v: BasicView): void {
  o.t(COMPONENT_ASSIGN_START).e(v.rb('sitemanager.content.fields.componentassign')).t(CONTENT_CHECKBOX);
  if (assigned(v, CONTENT_MODULE_ID) || v.isNew) o.t('checked ');
  o.t(' class="checkbox"> ').e(v.rb('sitemanager.content.fields.content')).t(COMPONENTS_CHECKBOX);
  if (assigned(v, COMPONENT_MODULE_ID)) o.t('checked ');
  o.t(' class="checkbox"> ').e(v.rb('sitemanager.content.fields.components'));
  o.t('\n\t\t\t\t\t\t</label>\n\n\t\t\t\t\t\t');
  if (cfToBoolean(siteValue(v.site, 'dataCollection'))) {
    o.t(FORMS_CHECKBOX);
    if (assigned(v, FORM_MODULE_ID)) o.t('checked ');
    // The source puts no space before this label.
    o.t(' class="checkbox">').e(v.rb('sitemanager.content.fields.formsmanager'));
    o.t('\n\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t');
  if (cfToBoolean(siteValue(v.site, 'emailBroadcaster'))) {
    o.t(EMAIL_CHECKBOX);
    if (assigned(v, EMAIL_BROADCASTER_MODULE_ID)) o.t('checked ');
    o.t(' class="checkbox"> ').e(v.rb('sitemanager.content.fields.emailbroadcaster'));
    o.t('\n\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t</div>\n\t\t\t\t');
}

const POLL_START = '\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t<label>';

const POLL_CHECKBOX =
  '</label>\n' +
  '\t\t\t\t\t\t<label for="rc" class="checkbox">\n' +
  '\t\t\t\t\t\t\t<input name="responseChart" type="CHECKBOX" value="1" ';

const CONFIRMATION_START =
  '\n' +
  '\t\t\t\t\t<div class="mura-control-group body-container" style="display:none">\n' +
  '\t\t\t\t\t\t<label>\n' +
  '\t\t\t\t\t\t \t';

const CONFIRMATION_TEXTAREA = '\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<textarea name="responseMessage" rows="4">';

const SEND_TO_START =
  '</textarea>\n' +
  '\t\t\t\t\t</div>\n' +
  '\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t\t<label>\n' +
  '\t\t\t\t\t\t\t';

const SEND_TO_INPUT = '\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t<input type="text" name="responseSendTo" value="';

/** `rc.contentBean.getresponseChart() eq 1`; a boolean compares as 1 or 0, as ACF compares it with a number. */
function responseChartIsOne(bean: CarchStruct): boolean {
  const value = structValue(bean, 'responseChart');
  return typeof value === 'boolean' ? value : cfEq(structText(bean, 'responseChart'), '1');
}

/** The Form's poll option, confirmation message and response recipients (lines 422-443). */
function formFields(o: ViewOutput, v: BasicView): void {
  o.t('\n\t\t\t\t\t');
  if (legacySettings().formPolls) {
    o.t(POLL_START).e(v.rb('sitemanager.content.fields.formpresentation')).t(POLL_CHECKBOX);
    if (responseChartIsOne(v.bean)) o.t('checked ');
    o.t(' class="checkbox"> ').e(v.rb('sitemanager.content.fields.ispoll'));
    o.t('\n\t\t\t\t\t\t</label>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t');
  }
  o.t(CONFIRMATION_START).e(v.rb('sitemanager.content.fields.confirmationmessage'));
  o.t(CONFIRMATION_TEXTAREA).e(encodeHtml(structText(v.bean, 'responseMessage')));
  o.t(SEND_TO_START).e(v.rb('sitemanager.content.fields.responsesendto'));
  o.t(SEND_TO_INPUT).e(encodeHtmlAttr(structText(v.bean, 'responseSendTo'))).t('">\n\t\t\t\t\t</div>\n\t\t\t\t');
}

const EXTENDED_ATTRIBUTES =
  '\n' +
  '\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-basic">\n' +
  '\t\t\t\t\t<div class="bigui" id="bigui__basic" data-label="Manage Extended Attributes">\n' +
  '\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>\n' +
  '\t\t\t\t\t\t<div class="bigui__controls">\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-basic" class="extendset-container extendedattributes-body" ' +
  'data-controlparent="extendedattributes-container-basic"></span>\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>\n' +
  '\t\t\t\t\t\t</div>\n' +
  '\t\t\t\t\t</div>\n' +
  '\t\t\t\t\t\n' +
  '\t\t\t\t</div>\n' +
  '\t\t\t\t';

const PANEL_END =
  '\n' +
  '\n' +
  '\n' +
  '\t\t\t\t<span id="extendset-container-tabbasicbottom" class="extendset-container"></span>\n' +
  '\n' +
  '\t\t</div>\n' +
  '\t</div>\n' +
  '</div>\n' +
  '\n' +
  '\t<script>\n' +
  '\t\tjQuery(document).ready(function(){\n' +
  '\n' +
  "\t\t\t$('#showTitles').click(function(e){\n" +
  "\t\t\t\t$(this).parents('div.mura-control').hide();\n" +
  "\t\t\t\t$('#alertTitleSuccess').hide();\n" +
  "\t\t\t\t$('#mura-seo-titles').fadeIn();\n" +
  '\t\t\t})\n' +
  '\n' +
  "\t\t\t$('#resetTitles').click(function(e){\n" +
  '\t\t\t\te.preventDefault();\n' +
  "\t\t\t\t $('#menuTitle,#urlTitle,#htmlTitle').val('');\n" +
  "\t\t\t\t$('#editAdditionalTitles').hide();\n" +
  "\t\t\t\t$('#alertTitleSuccess').fadeIn();\n" +
  '\t\t\t\treturn true;\n' +
  '\t\t\t});\n' +
  '\t\t});\n' +
  '\t</script>\n' +
  '\n';

// ---- Body ----

const BODY_START =
  '\n' +
  '\t\t\t\t\t\t\t<div id="bodyContainer" class="body-container mura-control-group" style="display:none;">\n' +
  '\t\t\t\t\t\t\t<label>\n' +
  '\t\t\t\t\t      \t\t';

const BODY_EDITOR = '\n\t\t\t\t\t      \t</label>\n\t\t\t\t\t\t\t';

const FCKEDITOR_SCRIPT_START =
  '\n' +
  '\t\t\t\t\t\t\t\t\t<script type="text/javascript">\n' +
  '\t\t\t\t\t\t\t\t\tvar loadEditorCount = 0;\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\tfunction FCKeditor_OnComplete( editorInstance ) {\n' +
  '\t\t\t\t\t\t\t\t\t\t';

const FCKEDITOR_ON_COMPLETE =
  '\n' +
  '\t\t\t\t\t\t\t\t\t\thtmlEditorOnComplete(editorInstance);\n' +
  '\t\t\t\t\t\t\t\t\t}\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\t';

const SCRIPT_END = '\n\t\t\t\t\t\t\t\t\t</script>\n\t\t\t\t\t\t\t\t';

/** The FCKeditor branch's script; its preview reads `previewURL`, whose `secure` argument legacy's call omits. */
function fckEditorScript(o: ViewOutput, v: BasicView): void {
  // mura.fckeditor's create() prints nothing (output=false, CreateHtml()'s result dropped), so only the script renders.
  o.t('\n\t\t\t\t\t\t\t\t\t').t(FCKEDITOR_SCRIPT_START);
  if (v.preview) o.t("\n\t\t\t\t\t\t\t\t\t   \tpreview('").e(previewUrl(v.bean)).t("','');\n\t\t\t\t\t\t\t\t\t\t");
  o.t(FCKEDITOR_ON_COMPLETE);
  const summary = structText(v.bean, 'summary');
  if (!cfEq(summary, '') && !cfEq(summary, '<p></p>')) {
    o.t("\n\t\t\t\t\t\t\t\t\ttoggleDisplay('editSummary','").e(v.rb('sitemanager.content.fields.expand'));
    o.t("','").e(v.rb('sitemanager.content.fields.close'));
    o.t("');\n\t\t\t\t\t\t\t\t\teditSummary();\n\t\t\t\t\t\t\t\t\t");
  }
  o.t(SCRIPT_END);
}

const CKEDITOR_SCRIPT_START =
  '</textarea>\n' +
  '\t\t\t\t\t\t\t\t\t<script type="text/javascript">\n' +
  '\t\t\t\t\t\t\t\t\tvar loadEditorCount = 0;\n' +
  '\t\t\t\t\t\t\t\t\t';

const CKEDITOR_TOOLBAR =
  '\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\thideBodyEditor=function(){\n' +
  "\t\t\t\t\t\t\t\t\t\tif(typeof CKEDITOR.instances.body != 'undefined'){\n" +
  '\t\t\t\t\t\t\t\t\t\t\tCKEDITOR.instances.body.updateElement();\n' +
  '\t\t\t\t\t\t\t\t\t\t\tCKEDITOR.instances.body.destroy();\n' +
  '\t\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t\t\tjQuery(".body-container").hide();\n' +
  '\t\t\t\t\t\t\t\t\t}\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\tshowBodyEditor=function(){\n' +
  "\t\t\t\t\t\t\t\t\t\tif(typeof CKEDITOR.instances.body == 'undefined'){\n" +
  '\t\t\t\t\t\t\t\t\t\t\tjQuery(".body-container").show();\n' +
  '\n' +
  "\t\t\t\t\t\t\t\t\t\t\tjQuery('#body').ckeditor(\n" +
  '\t\t\t\t\t\t\t\t\t\t\t{ toolbar:';

const CKEDITOR_ON_COMPLETE =
  ',\n' +
  "\t\t\t\t\t\t\t\t\t\t\theight:'calc(100vh - 380px)',\n" +
  "\t\t\t\t\t\t\t\t\t\t\tcustomConfig : 'config.js.cfm'\n" +
  '\t\t\t\t\t\t\t\t\t\t\t},\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\tfunction(editorInstance){\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t\thtmlEditorOnComplete(editorInstance);\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t\tshowPreview();\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t\t// custom global resize function fits to content window\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t\tresizeBodyEditor();\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t\t';

const SHOW_EXTENSIONS = '\n\t\t\t\t\t\t\t\t\t\t\t\t\t$("#bigui__basic").show();\n\t\t\t\t\t\t\t\t\t\t\t\t\t';

const CKEDITOR_READY =
  '\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t\t\t\t);\n' +
  '\t\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t\t}\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\tjQuery(document).ready(function(){\n' +
  '\t\t\t\t\t\t\t\t\t\t';

const CKEDITOR_PREVIEW =
  '\n' +
  '\t\t\t\t\t\t\t\t\t\tif (!hasSummary && !hasBody){\n' +
  '\t\t\t\t\t\t\t\t\t\t\tsetTimeout(function(){\n' +
  '\t\t\t\t\t\t\t\t\t\t\t\tshowPreview();\n' +
  '\t\t\t\t\t\t\t\t\t\t\t}, 2000);\n' +
  '\t\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t\t});\n' +
  '\n' +
  '\t\t\t\t\t\t\t\t\tfunction showPreview(){\n' +
  '\t\t\t\t\t\t\t\t\t\t';

/** `if(!previewLaunched){` through the line before `preview(`, around the stripped `listFindNoCase("File")` test. */
const PREVIEW_START =
  '\n' +
  '\t\t\t\t\t\t\t\t\t\t\tif(!previewLaunched){\n' +
  '\t\t\t\t\t\t\t\t\t\t' +
  '\n' +
  "\t\t\t\t\t\t\t\t\t\t\tpreview('";

const PREVIEW_END =
  "');\n" +
  '\t\t\t\t\t\t\t\t\t\t' +
  '\n' +
  '\t\t\t\t\t\t\t\t\t\t\tpreviewLaunched=true;\n' +
  '\t\t\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t\t\t';

const CKEDITOR_SCRIPT_END = '\n\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\t</script>\n\t\t\t\t\t\t\t\t';

/** The CKEditor branch: the body textarea, `<p></p>` when empty, and the editor and preview script. */
function ckEditor(o: ViewOutput, v: BasicView): void {
  const body = structText(v.bean, 'body');
  o.t('\n\t\t\t\t\t\t\t\t\t<textarea name="body" id="body">');
  if (body.length > 0) o.e(encodeHtml(body));
  else o.t('<p></p>');
  o.t(CKEDITOR_SCRIPT_START);
  if (v.preview) o.t('var previewLaunched= false;');
  o.t(CKEDITOR_TOOLBAR).t(cfEq(v.type, 'Form') ? "'Form'" : "'Default'").t(CKEDITOR_ON_COMPLETE);
  if (configFlag(v.model, 'showExtensionsInDefault')) o.t(SHOW_EXTENSIONS);
  o.t(CKEDITOR_READY);
  if (!v.state.isExtended) o.t('\n\t\t\t\t\t\t\t\t\t\tshowBodyEditor();\n\t\t\t\t\t\t\t\t\t\t');
  o.t(CKEDITOR_PREVIEW);
  // The include's File and other-type branches print the same preview call.
  if (v.preview) o.t(PREVIEW_START).e(previewUrl(v.bean)).t(PREVIEW_END);
  o.t(CKEDITOR_SCRIPT_END);
}

/** The HTML body editor of `HTMLBodyList` types; `onHTMLEdit` plugin scripts run only on legacy (lines 239-354). */
function htmlBody(v: BasicView): string {
  const o = new ViewOutput();
  o.t(BODY_START).e(v.rb('sitemanager.content.fields.content')).t(BODY_EDITOR).t('\n\t\t\t\t\t\t\t\t');
  const editorType = legacySettings().htmlEditorType;
  if (cfEq(editorType, 'fckeditor')) {
    fckEditorScript(o, v);
  } else if (cfEq(editorType, 'none')) {
    o.t('\n\t\t\t\t\t\t\t\t\t<textarea name="body" id="body">').e(encodeHtml(structText(v.bean, 'body')));
    o.t('</textarea>\n\t\t\t\t\t\t\t\t');
  } else {
    ckEditor(o, v);
  }
  o.t('\n\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t</div>\n\t\t\t\t\t');
  return o.toString();
}

const LINK_START =
  '\n' +
  '\t\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t     <h2>\n' +
  '\t\t\t\t      \t\t';

const LINK_INPUT = '\n\t\t\t\t      \t</h2>\n\t\t\t     \t \t';

const RAZUNA_BROWSE =
  '">\n' +
  '\t\t\t \t \t\t\t<div class="mura-control justify">\n' +
  '\t\t\t \t \t\t\t\t<div class="mura-input-set">\n' +
  '\t\t\t\t \t \t\t\t\t<a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n' +
  '\t\t\t\t     \t \t\t\t\t \t<i class="mi-folder-open"></i> ';

const RAZUNA_LOCAL =
  '\n' +
  '\t\t\t\t \t \t\t\t\t</a>\n' +
  '\t\t\t\t \t \t\t\t\t<ul class="dropdown-menu">\n' +
  '\t\t\t\t \t \t\t\t\t\t<li><a href="#" type="button" data-completepath="false" data-target="body" ' +
  'data-resourcetype="user" class="mura-file-type-selector" title="Select a File from Server">\n' +
  '\t\t\t\t     \t \t\t\t\t\t\t<i class="mi-folder-open"></i> ';

const RAZUNA_END =
  '</a></li>\n' +
  '\t\t\t\t \t \t\t\t\t\t<li><a href="#" type="button" onclick="renderRazunaWindow(\'body\');return false;" ' +
  'class="mura-file-type-selector btn-razuna-icon" value="URL-Razuna" title="Select a File from Razuna"><i></i> ' +
  'Razuna</a></li>\n' +
  '\t\t\t\t \t \t\t\t\t</ul>\n' +
  '\t\t\t\t \t \t\t\t</div>\n' +
  '\t\t\t \t \t\t\t</div>\n' +
  '\t\t\t\t\t\t';

const URL_INPUT =
  '\n' +
  '\t\t\t\t\t\t\t<div class="mura-control justify">\n' +
  '\t\t\t\t\t\t\t\t<div class="mura-input-set">\n' +
  '\t\t\t\t\t\t\t\t\t<input type="text" id="url" name="body" value="';

const URL_INPUT_END =
  '">\n' +
  '\t\t\t\t\t     \t \t</div>\n' +
  '\t\t\t\t     \t \t</div>\n' +
  '\t\t\t\t\t\t';

/** The Link URL field, with the asset browser menu where the site has Razuna settings (lines 359-384). */
function linkBody(v: BasicView): string {
  const o = new ViewOutput();
  const value = encodeHtmlAttr(structText(v.bean, 'body'));
  const required = v.rb('sitemanager.content.fields.urlrequired');
  o.t(LINK_START).e(v.rb('sitemanager.content.fields.url')).t(LINK_INPUT);
  if (razunaHostname(v.site).length > 0) {
    o.t('\n\t\t\t \t \t\t\t<input type="text" id="url" name="body" value="').e(value);
    o.t('" class="text" required="true" message="').e(required);
    o.t(RAZUNA_BROWSE).e(v.rb('sitemanager.content.browseassets'));
    o.t(RAZUNA_LOCAL).e(v.rb('sitemanager.content.local')).t(RAZUNA_END);
  } else {
    o.t(URL_INPUT).e(value).t('" class="text mura-5" required="true" message="').e(required).t(URL_INPUT_END);
  }
  o.t('\n\t\t\t     \t</div>\n\t\t\t     ');
  return o.toString();
}

/** `cfsavecontent variable="bodyContent"`: edit.cfm prints it later in `#mura-content-body-render`, not in `html`. */
async function bodyContent(input: EditFormInput, v: BasicView): Promise<SafeHtml | undefined> {
  if (cfListHas(HTML_BODY_TYPES, v.type, { noCase: true })) return raw(htmlBody(v));
  if (cfEq(v.type, 'Link')) return raw(linkBody(v));
  if (cfEq(v.type, 'File')) return renderFileSelector(input);
  return undefined;
}

/**
 * `form/dsp_panel_basic.cfm`: the Basic panel, from the newline after `<cfoutput>` to the line before `</cfoutput>`.
 * @throws TypeError When the request or the edit model lacks a value the include reads.
 */
export async function renderPanelBasic(input: EditFormInput): Promise<PanelResult> {
  const v = readView(input);
  const tabLabel = v.rb('sitemanager.content.tabs.basic');
  const o = new ViewOutput();
  o.t(PANEL_HEADING).e(tabLabel).t(PANEL_BODY_START);
  o.e(renderTypeSelector(input).value).t('\n\n\t\t\t\t\n\t\t\t\t');
  if (cfListHas(TITLE_TYPES, v.type, { noCase: true })) pageTitles(o, v);
  else plainTitle(o, v);
  o.t('\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t');
  contentParent(o, v);
  const body = await bodyContent(input, v);
  o.t('\n\t\t\t\t\n\n\t\t\t\t\n\t\t\t\t');
  if (cfEq(v.type, 'Component')) componentModules(o, v);
  o.t('\n\n\t\t\t\t\n\t\t\t\t');
  if (cfEq(v.type, 'Form')) formFields(o, v);
  o.t('\n\t\t\t\t');
  if (configFlag(v.model, 'showExtensionsInDefault')) o.t('\n\t\t\t\t\n\t\t\t\t');
  else o.t(EXTENDED_ATTRIBUTES);
  o.t(PANEL_END);
  return { html: raw(o.toString()), tabId: 'tabBasic', tabLabel, bodyContent: body };
}
