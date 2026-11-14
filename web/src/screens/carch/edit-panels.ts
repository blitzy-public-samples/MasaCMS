// The content editor's settings sidebar (`admin/core/views/carch/edit_panels.cfm`), server-only.
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { cfEq, scanCompactDisplay } from '@/lib/cfml';
import { raw, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type RequestContext } from '@/lib/request-context';
import { cfListHas, tabAllowed, type EditFormInput, type EditPageData, type PanelResult } from './form/custom-tags';
import { renderPanelAssocFile } from './form/panel-assocfile';
import { renderPanelBasic } from './form/panel-basic';
import { renderCategoriesPanel } from './form/panel-categories';
import { renderPanelExtendedAttributes } from './form/panel-extended-attributes';
import { renderPanelFormBuilder } from './form/panel-formbuilder';
import { renderLayoutObjectsPanel } from './form/panel-layoutobjects';
import { renderPublishingPanel } from './form/panel-publishing';
import { renderPanelRelatedContent } from './form/panel-related-content';
import { renderPanelRemote } from './form/panel-remote';
import { renderSchedulingPanel } from './form/panel-scheduling';
import { renderPanelSummary } from './form/panel-summary';
import { renderTagsPanel } from './form/panel-tags';
import { renderPanelUsage } from './form/panel-usage';
import {
  CONTENT_MODULE_ID,
  ROOT_CONTENT_ID,
  isS2IsPrivate,
  structOf,
  structText,
  structValue,
  type CarchStruct,
} from './model';

// Besides what each panel reads, the edit model's `rc` supplies, case-insensitively:
// - `categoryCount`: `categoryManager.getCategoryCount(rc.siteID)`, read where the Categorization tab is allowed;
// - `extendSets`: `getSubTypeByName(rc.type, contentBean.subType, rc.siteid).getExtendSets(inherit=true,
//   activeOnly=true)`, of which only the length is read, where the Extended Attributes tab is allowed;
// - `showUsageTabs`: configBean `getValue(property='showUsageTabs', defaultValue=true)`; absent reads as true.
// The markup is the include as ACF 2023 emits it: CFML comments are dropped with the text around them joined, template
// text holding non-whitespace is copied byte for byte, and whitespace-only text between two CFML constructs prints one
// space after output that does not end in whitespace, else nothing. Plugin tabs (`pluginEventMappings`) render
// nothing: the CFML plugin runtime stays on legacy, so no `onContentEdit` or `on<Type>Edit` mapping reaches the target.

const OPERATION = 'strategies-content getContentEditModel';

/** contentManager `ExtendableList`. */
const EXTENDABLE_TYPES = 'Page,Folder,Calendar,Link,File,Gallery,Component,Form';

const CONTROLS_OPEN = `
\t<div class="mura__edit__controls"\x20`;

const PANEL_GROUP_OPEN = `>
\t\t
\t\t<div class="mura__edit__controls__scrollable">

\t\t\t
\t\t\t
\t\t\t<div id="mura__edit__settings__filter">
\t  \t\t<input type="text" class="form-control" id="mura__edit__settings__filter__input" placeholder="Type to Find Settings">
\t\t\t</div>
\t\t\t
\t\t\t<div class="mura__edit__controls__objects">
\t\t\t\t<div id="mura-edit-tabs" class="mura__edit__controls__tabs">

\t\t\t\t\t<div class="mura-panel-group" id="content-panels" role="tablist" aria-multiselectable="true">

\t\t\t\t\t\t
\t\t\t\t\t\t`;

const OMIT_RELATED_CONTENT = `
\t\t\t\t\t\t\t\t\t<input type="hidden" name="ommitRelatedContentTab" value="true">
\t\t\t\t\t\t\t\t`;

const OMIT_REMOTE = `
\t\t\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t\t<input type="hidden" name="ommitRemoteTab" value="true">
\t\t\t\t\t\t\t\t`;

const PANEL_GROUP_CLOSE = `
\t\t\t\t\t\t
\t\t\t\t\t</div>\t

\t\t\t\t</div>
\t\t\t</div>
\t\t</div>
\t</div>

`;

const FILTER_SCRIPT = `

<script type="text/javascript">
$(document).ready(function(){

\t// custom case-insensitive :contains method
    $.expr[":"].contains = $.expr.createPseudo(function (arg) {
        return function (elem) {
            return $(elem).text().toUpperCase().indexOf(arg.toUpperCase()) >= 0;
        };
    });

\t// open tab via url hash
\tif(window.location.hash.substring(1,7) == 'panel-'){
\t\t$('.mura-panel-heading a[href$="' + window.location.hash + '"]').trigger('click');
\t\twindow.location.hash = "";
\t}

\t// filter settings in side panels
\tfilterSettings=function(fstr){

\t\t// minimum string length for action
\t\tif(fstr.length > 2){

\t\t\t// if matching a panel name
\t\t\t$("#content-panels a.collapse:contains('" + fstr + "')").each(function(){
\t\t\t\tif ($(this).parents('.mura-panel.panel').has('.panel-collapse.collapse.in').length == 0){
\t\t\t\t\t$(this).parents('.mura-panel.panel').siblings('.mura-panel.panel').has('.panel-collapse.collapse.in').find('a.collapse').trigger('click');
\t\t\t\t\t$(this).trigger('click');
\t\t\t\t}
\t\t\t});

\t\t\t// also match contents
\t\t\t$("#content-panels .mura-panel label:contains('" + fstr + "')").addClass('control-matched').parents('.mura-control-group').addClass('control-matched');
\t\t\t\tif ($('#content-panels .panel-collapse.collapse.in').length == 0){
\t\t\t\t\t$('.mura-control-group.control-matched').parents('.mura-panel.panel').find('a.collapse').trigger('click');
\t\t\t\t}

\t\t// reset on short length
\t\t} else {
\t\t\t$("#content-panels .panel-collapse.collapse").collapse("hide","fast");
\t\t\t$('#content-panels .mura-panel .control-matched').removeClass('control-matched');
\t\t}
\t}

\t// apply filter by typing, with delay
\t$("#mura__edit__settings__filter__input").keyup(function(){
\t\tvar timeout = null;
\t\tclearTimeout(timeout);
\t    timeout = setTimeout(function () {
\t\t\tvar filterStr = $("#mura__edit__settings__filter__input").val();
\t\t\t\t//\tconsole.log(filterStr);
\t\t\t\t\tfilterSettings(filterStr)\t;
\t    }, 500);
\t});

\t// focus on input filter on page load
\t`;

const FOCUS_FILTER = `
\tsetTimeout(function () {
\t\t$("#mura__edit__settings__filter__input").focus();
\t }, 500);
\t`;

const SCRIPT_CLOSE = `

});
</script>
`;

/** What the include leaves for edit.cfm. */
export interface EditPanelsResult {
  /** The include's output, from the newline before the controls `<div>` through `</script>` and its newline. */
  readonly html: SafeHtml;
  /** edit.cfm `tabList` after the include: the rendered panels' tab ids, comma-separated in include order. */
  readonly tabList: string;
  /** edit.cfm `tabLabelList` after the include, which only plugin tabs extend; `''` while none render. */
  readonly tabLabelList: string;
  /** edit.cfm `bodyContent`, saved by the Basic or form builder panel; empty when neither saves one. */
  readonly bodyContent: SafeHtml;
  /** Markup the panels add with `cfhtmlhead`, in include order; absent when none does. */
  readonly htmlHead?: SafeHtml;
  /** `rc.ptype` after the includes, which the Scheduling panel's display content may change. */
  readonly ptype: string;
}

const NO_BREAK_SPACES: ReadonlySet<string> = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one UTF-16 unit. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/** The include's output buffer under ACF whitespace management. */
class ViewOutput {
  #out = '';

  /** Template text holding non-whitespace, or a value: written verbatim. */
  t(text: string): this {
    this.#out += text;
    return this;
  }

  /** Whitespace-only template text between two CFML constructs: one space after non-whitespace, else nothing. */
  ws(): this {
    if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

const UTF8 = new TextDecoder('utf-8');

/**
 * A cookie value as ACF's cookie scope holds it: `+` as space and `%XX` runs decoded as UTF-8; from the first `%` that
 * two hex digits do not follow, the rest is kept as sent.
 */
function cookieScopeValue(sent: string): string {
  let out = '';
  let i = 0;
  while (i < sent.length) {
    const ch = sent.charAt(i);
    if (ch !== '%') {
      out += ch === '+' ? ' ' : ch;
      i += 1;
      continue;
    }
    const bytes: number[] = [];
    while (sent.charAt(i) === '%' && /^[0-9A-Fa-f]{2}$/.test(sent.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(sent.slice(i + 1, i + 3), 16));
      i += 3;
    }
    if (bytes.length === 0) return out + sent.slice(i);
    out += UTF8.decode(Uint8Array.from(bytes));
  }
  return out;
}

/** Request `rc[name]`; throws when absent, as CFML does for an undefined element. */
function rcText(rc: RequestContext, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** An edit model value the include tests; throws when the model omits it. */
function modelValue(model: CarchStruct, key: string): unknown {
  const value = structValue(model, key);
  if (value === undefined || value === null) throw new TypeError(`${OPERATION} returned no rc.${key}`);
  return value;
}

/** `arrayLen(extendSets)`; throws unless the edit model holds the sets as an array. */
function extendSetCount(model: CarchStruct): number {
  const sets = modelValue(model, 'extendSets');
  if (!Array.isArray(sets)) throw new TypeError(`${OPERATION} returned no rc.extendSets array`);
  return sets.length;
}

/**
 * `url.formType`: the forwarded request target's `formType` (repeated names comma-joined, as the URL scope joins
 * them); without the gateway's header, the request's value unless it was posted, since legacy's edit form posts to a
 * bare `index.cfm`. Undefined when the URL scope holds none.
 */
export function urlFormType(req: Pick<EditFormInput['req'], 'headers' | 'formScope' | 'rc'>): string | undefined {
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return req.formScope.formType === undefined ? req.rc.formType : undefined;
  const query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : '';
  const values = [...new URLSearchParams(query)]
    .filter(([name]) => name.toLowerCase() === 'formtype')
    .map(([, value]) => value);
  return values.length === 0 ? undefined : values.join(',');
}

/**
 * `formBuilderManager.createJSONForm(formID)`: an empty form bean and no datasets, serialized in ACF 2023's key order.
 * Built here, not read from the edit model: it reads no store, and only this request's `url.formType` decides its use.
 */
function createJsonForm(formId: string): string {
  return (
    '{"form":{"datecreate":"","fields":{},"pages":[],"statuscode":0,"datelastupdate":"","formattributes":{},' +
    `"siteid":"","formid":${JSON.stringify(formId)},"isactive":0,"name":"","config":{},"notes":"","remoteid":"",` +
    '"iscurrent":0,"package":"","deletedfields":{},"fieldorder":[]},"datasets":{}}'
  );
}

/** CFML `isJSON`. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** `struct` with `value` under the member CFML resolves for `key`, added when absent. */
function withMember(struct: CarchStruct, key: string, value: unknown): CarchStruct {
  const lower = key.toLowerCase();
  const name = Object.hasOwn(struct, key) ? key : (Object.keys(struct).find((k) => k.toLowerCase() === lower) ?? key);
  return { ...struct, [name]: value };
}

/** The edit model after `rc.contentBean.setBody(body)`. */
function withBody(data: EditPageData, bean: CarchStruct, body: string): EditPageData {
  return { ...data, rc: withMember(data.rc, 'contentBean', withMember(bean, 'body', body)) };
}

/**
 * `edit_panels.cfm`: the settings sidebar edit.cfm includes inside `#mura-content-body-block`, with the panels each
 * content type and the user's tab assignments allow.
 * @throws TypeError When the request, its cookies or the edit model lack a value the include or a panel reads.
 */
export async function renderEditPanels(input: EditFormInput): Promise<EditPanelsResult> {
  const { req, state } = input;
  const type = rcText(req.rc, 'type');
  const moduleId = rcText(req.rc, 'moduleid');
  const bean = structOf(input.data.rc, 'contentBean');
  const isNew = cfToBoolean(structValue(bean, 'isNew'));
  const contentId = structText(bean, 'contentID');
  const tabs = state.tabAssignments;
  const s2IsPrivate = isS2IsPrivate(req);
  const isForm = cfEq(type, 'Form');
  const formType = urlFormType(req);
  // A new Form opened without `formType=editor` gets an empty builder form as its body before any panel reads it.
  const data =
    isForm && isNew && !(formType !== undefined && cfEq(formType, 'editor'))
      ? withBody(input.data, bean, createJsonForm(contentId))
      : input.data;
  const model = data.rc;
  let current: EditFormInput = { ...input, data };

  const o = new ViewOutput();
  const tabList: string[] = [];
  const heads: string[] = [];
  let bodyContent: SafeHtml | undefined;
  // Whitespace-only template text precedes every include and hidden field, as it does each include's own first output.
  const put = (text: string): void => {
    o.ws().t(text);
  };
  const include = (panel: PanelResult | null): void => {
    o.ws();
    if (panel === null) return;
    o.t(panel.html.value);
    tabList.push(panel.tabId);
    if (panel.bodyContent !== undefined) bodyContent = panel.bodyContent;
    if (panel.htmlHead !== undefined) heads.push(panel.htmlHead.value);
  };
  const categoriesAndTags = (): void => {
    if (tabAllowed(tabs, 'Categorization') && cfToBoolean(modelValue(model, 'categoryCount'))) {
      include(renderCategoriesPanel(current));
    }
    if (tabAllowed(tabs, 'Tags')) include(renderTagsPanel(current));
  };
  const relatedContent = (): void => {
    if (cfEq(moduleId, CONTENT_MODULE_ID) && tabAllowed(tabs, 'Related Content')) {
      include(renderPanelRelatedContent(current));
    } else {
      put(OMIT_RELATED_CONTENT);
    }
  };

  o.t(CONTROLS_OPEN);
  if (!cfToBoolean(scanCompactDisplay(state.compactDisplay))) {
    const width = req.cookies.get('ADMINCONTROLWIDTH');
    if (width === undefined) throw new TypeError('Element ADMINCONTROLWIDTH is undefined in COOKIE.');
    o.t(`style="width: ${cookieScopeValue(width)}px"`);
  }
  o.t(PANEL_GROUP_OPEN);

  if (isForm && isJson(structText(structOf(model, 'contentBean'), 'body'))) {
    include(renderPanelFormBuilder(current));
  } else {
    include(await renderPanelBasic(current));
    include(renderPanelSummary(current));
    include(await renderPanelAssocFile(current));
  }

  const publishingAllowed = tabAllowed(tabs, 'Publishing');
  if (publishingAllowed) include(renderPublishingPanel(current));
  let ptype = state.ptype;
  if (publishingAllowed && !cfEq(contentId, ROOT_CONTENT_ID)) {
    const scheduling = renderSchedulingPanel(current);
    include(scheduling);
    ptype = scheduling.ptype;
    current = { ...current, state: { ...current.state, ptype } };
  }

  // `cfswitch` matches its `cfcase` lists without regard to case.
  if (cfListHas('Page,Folder,Calendar,Gallery', type, { noCase: true })) {
    if (cfEq(moduleId, CONTENT_MODULE_ID) && tabAllowed(tabs, 'Layout & Objects') && s2IsPrivate) {
      include(renderLayoutObjectsPanel(current));
    }
    categoriesAndTags();
    relatedContent();
  } else if (cfListHas('Link,File', type, { noCase: true })) {
    categoriesAndTags();
    relatedContent();
  } else if (cfEq(type, 'Variation')) {
    categoriesAndTags();
  } else if (cfEq(type, 'Component') || isForm) {
    categoriesAndTags();
    const showUsageTabs = structValue(model, 'showUsageTabs');
    const usageTabs = showUsageTabs === undefined || showUsageTabs === null || cfToBoolean(showUsageTabs);
    if (usageTabs && tabAllowed(tabs, 'Usage Report') && !isNew) include(renderPanelUsage(current));
  }

  if (
    cfListHas(EXTENDABLE_TYPES, type, { noCase: true }) &&
    tabAllowed(tabs, 'Extended Attributes') &&
    extendSetCount(model) > 0
  ) {
    include(renderPanelExtendedAttributes(current));
  }

  if (!cfEq(type, 'Component') && !isForm && !cfEq(contentId, ROOT_CONTENT_ID) && tabAllowed(tabs, 'Remote')) {
    if (s2IsPrivate) include(renderPanelRemote(current));
    else put(OMIT_REMOTE);
  }

  put(PANEL_GROUP_CLOSE);
  o.t(FILTER_SCRIPT);
  if (!isNew) o.t(FOCUS_FILTER);
  o.t(SCRIPT_CLOSE);

  return {
    html: raw(o.toString()),
    tabList: tabList.join(','),
    tabLabelList: '',
    bodyContent: bodyContent ?? raw(''),
    ...(heads.length === 0 ? {} : { htmlHead: raw(heads.join('')) }),
    ptype,
  };
}
