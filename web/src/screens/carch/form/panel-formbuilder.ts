// A builder Form's Basic panel (`admin/core/views/carch/form/dsp_panel_formbuilder.cfm`), server-only.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, raw } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import type { EditFormInput, PanelResult } from './custom-tags';
import { renderFormBuilder } from './formbuilder';
import { headFormBuilder } from './head-formbuilder';

// The markup is written line by line as ACF 2023 emits the include: template text between CFML tags is copied byte for
// byte, the whitespace-only text between this include's tags prints nothing (output before it always ends in
// whitespace), and the `parentid placeholder` CFML comment is dropped with the text around it joined.

/** The {@link EditFormInput} members the panel reads; an `EditFormInput` satisfies it. */
export type PanelFormBuilderInput = Pick<EditFormInput, 'req' | 'data' | 'state'> & {
  readonly ctx: Pick<ScreenContext, 'rb'>;
};

// Struct readers stay local, as in ./formbuilder.ts, so the panel depends only on the form modules and web/lib.
type Struct = Readonly<Record<string, unknown>>;

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** `rc.contentBean` of the edit model; throws unless it is a struct. */
function contentBean(input: PanelFormBuilderInput): Struct {
  const bean = member(input.data.rc, 'contentBean');
  if (typeof bean !== 'object' || bean === null || Array.isArray(bean)) {
    throw new TypeError('rc.contentBean is not a struct');
  }
  return bean as Struct;
}

/** A bean getter's value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function beanText(bean: Struct, key: string): string {
  const value = member(bean, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`rc.contentBean.${key} is not a simple value`);
}

/** Request `rc[name]` after the carch defaults; throws when absent, as CFML does for an undefined `rc` key. */
function rcText(input: PanelFormBuilderInput, name: string): string {
  const value = input.req.rc[name];
  if (value === undefined) throw new TypeError(`rc.${name} is undefined for carch.edit`);
  return value;
}

/** `rc.parentID` as edit.cfm leaves it: a stored node opened without one takes the bean's parent. */
function parentIdOf(input: PanelFormBuilderInput, bean: Struct): string {
  const parentId = rcText(input, 'parentid');
  return parentId === '' && !cfToBoolean(beanText(bean, 'isNew')) ? beanText(bean, 'parentID') : parentId;
}

/** The summary field (lines 100-112), which the include prints for types other than Form and Component. */
function summaryField(rb: (key: string) => string, bean: Struct): string {
  const summary = beanText(bean, 'summary');
  const expand = rb('sitemanager.content.fields.expand');
  const editor =
    !cfEq(legacySettings().htmlEditorType, 'none') || summary.length > 0 ? encodeHtml(summary) : '<p></p>';
  // Labels print unencoded inside the onclick script, as legacy prints them.
  return [
    '',
    '\t\t\t\t<div class="mura-control-group">',
    '\t\t\t\t\t<label>',
    `\t\t\t\t<a href="#" rel="tooltip" title="${encodeHtmlAttr(rb('tooltip.contentSummary'))}">`,
    `\t\t\t\t\t${rb('sitemanager.content.fields.summary')}`,
    '\t\t\t\t\t\t <i class="mi-question-circle"></i></a>',
    `\t\t\t\t<a href="#" id="editSummaryLink" onclick="javascript: toggleDisplay('editSummary','${expand}','${rb('sitemanager.content.fields.close')}'); editSummary();return false">`,
    `\t\t\t\t\t[${expand}]`,
    '\t\t\t\t</a>',
    '\t\t\t</label>',
    '\t\t\t\t\t<div class="mura-control justify" id="editSummary" style="display:none;">',
    `\t\t\t\t<textarea name="summary" id="summary" cols="96" rows="10">${editor}</textarea>`,
    '\t\t\t</div>',
    '\t\t</div>',
    '\t\t\t',
  ].join('\n');
}

/** The Form fields (lines 129-146): the poll checkbox when `formpolls` is set, the confirmation message and send-to. */
function formFields(rb: (key: string) => string, bean: Struct): string {
  const checked = cfEq(beanText(bean, 'responseChart'), '1') ? 'checked ' : '';
  // The poll input keeps legacy's spacing: `value="1" checked  class` or `value="1"  class`.
  const poll = legacySettings().formPolls
    ? [
        '',
        '\t\t\t\t<div class="mura-control-group">',
        `\t\t\t\t\t<label>${rb('sitemanager.content.fields.formpresentation')}</label>`,
        '\t\t\t\t\t<label for="rc" class="checkbox">',
        `\t\t\t\t\t\t<input name="responseChart" type="CHECKBOX" value="1" ${checked} class="checkbox"> ${rb('sitemanager.content.fields.ispoll')}`,
        '\t\t\t\t\t</label>',
        '\t\t\t\t\t</div>',
        '\t\t\t\t',
      ].join('\n')
    : '';
  return (
    poll +
    [
      '',
      '\t\t\t\t<div class="mura-control-group">',
      '\t\t\t\t\t<label>',
      `\t\t\t\t\t\t${rb('sitemanager.content.fields.confirmationmessage')}`,
      '\t\t\t\t\t</label>',
      `\t\t\t\t\t<textarea name="responseMessage" rows="4">${encodeHtml(beanText(bean, 'responseMessage'))}</textarea>`,
      '\t\t\t\t</div>',
      '\t\t\t\t<div class="mura-control-group">',
      `\t\t\t\t\t<label>${rb('sitemanager.content.fields.responsesendto')}</label>`,
      `\t\t\t\t\t<input type="text" name="responseSendTo" value="${encodeHtmlAttr(beanText(bean, 'responseSendTo'))}">`,
      '\t\t\t\t</div>',
      '\t\t\t',
    ].join('\n')
  );
}

/** The panel from the newline after `<cfoutput>` (tab `tabBasic`), its form builder `bodyContent` and `htmlHead`. */
export function renderPanelFormBuilder(input: PanelFormBuilderInput): PanelResult {
  const rb = (key: string): string => input.ctx.rb.rbKey(key);
  const bean = contentBean(input);
  const type = rcText(input, 'type');
  const tabLabel = rb('sitemanager.content.tabs.basic');
  const summary = !cfEq(type, 'Form') && !cfEq(type, 'Component') ? summaryField(rb, bean) : '';
  // The cfsavecontent body, which edit.cfm prints inside `#mura-content-body-render`, never in the panel.
  const bodyContent = [
    '',
    '\t\t\t\t<div class="mura-control-group">',
    '\t\t\t\t\t<div id="bodyContainer" class="mura-control justify">',
    `\t\t\t\t\t\t${renderFormBuilder(input).value}`,
    '\t\t\t\t\t</div>',
    '\t\t\t\t</div>',
    '\t\t\t',
  ].join('\n');
  const parentId = parentIdOf(input, bean);
  const form = cfEq(type, 'Form') ? formFields(rb, bean) : '';
  // Legacy markup verbatim (no redesign); labels print unencoded, as legacy prints them.
  const html = [
    '',
    '\t<div class="mura-panel panel">',
    '\t\t<div class="mura-panel-heading" role="tab" id="heading-basic">',
    '\t\t\t<h4 class="mura-panel-title">',
    `\t\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-basic" aria-expanded="true" aria-controls="panel-basic">${tabLabel}</a>`,
    '\t\t\t</h4>',
    '\t\t</div>',
    '\t\t<div id="panel-basic" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-basic" aria-expanded="false" style="height: 0px;">',
    '\t\t\t<div class="mura-panel-body">',
    '',
    '\t\t\t<span id="extendset-container-tabbasictop" class="extendset-container"></span>',
    '',
    '\t\t\t<input type="hidden" id="menuTitle" name="menuTitle" value="">',
    '\t\t\t\t<div class="mura-control-group">',
    '\t\t\t\t\t<label>',
    `\t\t\t\t${rb('sitemanager.content.fields.title')}`,
    '\t\t\t</label>',
    `\t\t\t\t<input type="text" id="title" name="title" value="${encodeHtmlAttr(beanText(bean, 'title'))}"  maxlength="255" required="true" message="${rb('sitemanager.content.fields.titlerequired')}">`,
    '\t\t\t</div>',
    '',
    `\t\t\t${summary}`,
    '',
    '\t\t\t<span id="extendSetsBasic"></span>',
    '',
    '\t\t\t',
    `\t\t\t<input type="hidden" name="parentid" value="${encodeHtmlAttr(parentId)}">`,
    '',
    `\t\t\t${form}`,
    '',
    '\t\t\t<span id="extendset-container-basic" class="extendset-container"></span>',
    '\t\t\t<span id="extendset-container-tabbasicbottom" class="extendset-container"></span>',
    '',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</div>',
    '',
  ].join('\n');
  return { html: raw(html), tabId: 'tabBasic', tabLabel, bodyContent: raw(bodyContent), htmlHead: headFormBuilder() };
}
