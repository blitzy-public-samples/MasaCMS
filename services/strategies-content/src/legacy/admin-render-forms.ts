/**
 * cform form-builder responses (cform.cfc:161-210): the templates getDialog and getFieldTemplate print, and the bean
 * JSON getForm, getField, getFieldType and getDataset print, byte for byte as ACF 2023 sends them.
 */
import {
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_JSON_CONTENT_TYPE,
  cfUuid,
  isCfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import type { AdminLabels } from './admin-markup.js';
import { acfSerializeJson } from './cfjson.js';

const CRLF = '\r\n';
const LF = '\n';

/** A request legacy fails with a ColdFusion exception (a 500 error page); `message` is the exception message. */
export class CformRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CformRequestError';
  }
}

// --- Templates (formBuilderManager.cfc:190-242, admin/core/utilities/formbuilder/templates/*.cfm) ---

/** A row of `formBuilderManager.getForms($, session.siteid, form.formid)`: the session site's active forms by title. */
export interface NestedFormRow {
  contentid: string;
  /** A NULL title prints as ''. */
  title: string | null;
}

/** What a template renders from. */
export interface FormBuilderTemplateInput {
  /** `session.rb` labels. */
  labels: AdminLabels;
  /** field-nested.cfm only: the forms listed for the POST's `form.formid`; undefined when the form scope has none. */
  nestedForms?: readonly NestedFormRow[];
}

/** One template's markup before the trim legacy applies. */
export type FormBuilderTemplate = (input: FormBuilderTemplateInput) => string;

// `onFormElementBasicTabRender` handlers run only in the legacy CFML runtime (plugins are on the decision list), so
// `$.renderEvent` prints what it prints with no handler registered.
const PLUGIN_EVENT_OUTPUT = '';

/** The `<cfloop query="rsFormList">` options of field-nested.cfm; legacy fails reading `form.formid` without one. */
function formOptions(forms: readonly NestedFormRow[] | undefined): string {
  if (forms === undefined) throw new CformRequestError('Element FORMID is undefined in FORM.');
  const option = (f: NestedFormRow): string => `<option value="${f.contentid}">${f.title ?? ''}</option>`;
  return forms.map((f) => `${CRLF}\t\t\t\t\t\t\t\t\t${option(f)}${CRLF}\t\t\t\t\t\t\t\t`).join('');
}

/** `dataset-create.cfm`. */
function datasetCreate({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div id="dataset-create" class="mura-template-form">',
    `\t\t\t<h2>${labels.key('formbuilder.dataset.form')}: <span id="mura-template-form-label"></span></h2>`,
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="datasetid">',
    `\t\t\t\t\t\t\t\t<option value="">${labels.key('formbuilder.dataset.chooseone')}</option>`,
    '\t\t\t\t\t\t\t\t<option value="4FA62B2D-3A29-44B1-8603FB892C60014B">Big Long Honking Name Shirt Sizes</option>',
    '\t\t\t\t\t\t\t\t<option value="77917A42-28F4-4BA4-B88732109F9A05C5">Colors</option>',
    '\t\t\t\t\t\t\t</select>',
    `\t\t\t\t\t\t\t<input type="button" class="button ui-icon ui-icon-check" name="set-dataset" value="${labels.key('formbuilder.dataset.set')}" />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="filter">${labels.key('formbuilder.dataset.filter')}</label>`,
    '\t\t\t\t\t\t\t<input class="text medium" type="text" name="filter" id="dataset-filter" value="" maxlength="50" />',
    '\t\t\t\t\t\t\t<input type="button" class="button ui-icon ui-icon-check" name="set-filter" value="" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t\t<div class="btn-wrap">',
    `\t\t\t\t\t<input type="button" class="btn" name="new-datasource" value="${labels.key('formbuilder.dataset.createnew')}" />`,
    '\t\t\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(LF);
}

/** `dataset-form.cfm`. */
function datasetForm({ labels }: FormBuilderTemplateInput): string {
  return [
    '\t<div class="ui-tabs">',
    '\t\t<ul class="ui-tabs-nav">',
    `\t\t\t<li title="${labels.key('formbuilder.dataset.edit')}" class="ui-state-active ui-corner-top ui-tabs-selected"><a href="javascript:void(null);"><span>Source</span></a></li>`,
    '\t\t\t<li id="button-grid-grid" class="ui-state-default ui-corner-top"><a href="javascript:void(null);"><span>List</span></a></li>',
    '\t\t</ul>',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-source">',
    '\t\t\t<div id="mura-tb-dataset" class="mura-tb-form">',
    '',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li class="mura-tb-grp-sourcetype">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.sourcetype')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="sourcetype" id="mura-tb-dataset-sourcetype">',
    `\t\t\t\t\t\t\t\t<option value="entered">${labels.key('formbuilder.dataset.sourcetype.entered')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="dsp">${labels.key('formbuilder.dataset.sourcetype.dsp')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="object">${labels.key('formbuilder.dataset.sourcetype.object')}</option>`,
    '\t\t\t\t\t\t\t\t',
    `\t\t\t\t\t\t\t\t<option value="remote">${labels.key('formbuilder.dataset.sourcetype.remote')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '',
    '\t\t\t\t\t\t<li class="mura-tb-dsi mura-tb-grp-entered" style="display: none">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.issorted')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="issorted" id="mura-tb-dataset-issorted">',
    `\t\t\t\t\t\t\t\t<option value="0">${labels.key('formbuilder.dataset.issorted.manual')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="1">${labels.key('formbuilder.dataset.issorted.sorted')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.sorttype')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="sorttype" id="mura-tb-dataset-sorttype">',
    `\t\t\t\t\t\t\t\t<option value="string">${labels.key('formbuilder.dataset.sorttype.string')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="numeric">${labels.key('formbuilder.dataset.sorttype.numeric')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="date">${labels.key('formbuilder.dataset.sorttype.date')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.sortcolumn')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="sortcolumn" id="mura-tb-dataset-sortcolumn">',
    `\t\t\t\t\t\t\t\t<option value="label">${labels.key('formbuilder.dataset.sortcolumn.label')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="value">${labels.key('formbuilder.dataset.sortcolumn.value')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.sortdirection')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="sortdirection" id="mura-tb-dataset-sortdirection">',
    `\t\t\t\t\t\t\t\t<option value="asc">${labels.key('formbuilder.dataset.sortdirection.asc')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="desc">${labels.key('formbuilder.dataset.sortdirection.desc')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="mura-tb-dsi mura-tb-grp-source" style="display: none">',
    `\t\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.dataset.source')}</label>`,
    '\t\t\t\t\t\t\t<input class="text tb-source" id="mura-tb-dataset-source" type="text" name="source" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t\t<div class="btn-wrap">',
    `\t\t\t\t\t\t<input type="button" class="btn" name="save-dataset" id="mura-tb-save-dataset" value="${labels.key('formbuilder.dataset.update')}" />`,
    '\t\t\t\t\t</div>',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '',
    '\t\t</div>',
  ].join(CRLF);
}

/** `dataset-grid.cfm`. */
function datasetGrid({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '<div class="ui-tabs">',
    '\t\t\t<ul class="ui-tabs-nav">',
    `\t\t\t\t<li id="button-grid-edit" title="${labels.key('formbuilder.dataset.edit')}" class="ui-state-default ui-corner-top"><a href="javascript:void(null);"><span>Source</span></a></li>`,
    '\t\t\t\t<li class="ui-state-default ui-state-active ui-corner-top ui-tabs-selected"><a href="javascript:void(null);"><span>List</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-list">',
    '\t\t\t\t<div id="dataset-grid" class="mura-tb-form template-form">',
    `\t\t\t\t<div id="mura-tb-grid-message" style="display: none">${labels.key('formbuilder.dataset.mastermode')}</div>`,
    '\t\t\t\t<div id="mura-tb-grid">',
    '\t\t\t\t\t<ul id="mura-tb-grid-table-header">',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t\t<ul id="mura-tb-grid-table">',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    `\t\t\t<div class="ui-button" id="button-grid-add" title="${labels.key('formbuilder.dataset.add')}">${labels.key('formbuilder.dataset.add')}</div>`,
    '\t\t</div>',
    '\t\t</div>',
    '\t</div>',
    '</span>',
  ].join(LF);
}

/** `dataset-nested.cfm`. */
function datasetNested({ labels }: FormBuilderTemplateInput): string {
  return [
    '<div id="dataset-row">',
    '\t<div id="element-row">',
    '\t\t<li></li>',
    '\t</div>',
    '\t<div id="element-button-delete">',
    `\t\t<div class="button-grid-row-delete" title="${labels.key('formbuilder.dataset.delete')}"></div>`,
    '\t</div>',
    '\t<div id="element-labels">',
    `\t\t<label id="label">${labels.key('formbuilder.dataset.label')}</label>`,
    `\t\t<label id="value">${labels.key('formbuilder.dataset.value')}</label>`,
    '\t</div>',
    '\t<div id="element-cell">',
    `\t\t<span class='mura-tb-cell'></span>`,
    '\t</div>',
    '\t<div id="element-display">',
    '\t\t<div class="mura-tb-grid-display"></div>',
    '\t</div>',
    '\t<div id="element-input">',
    '\t\t<input type="text" class="mura-tb-grid-input" />',
    '\t</div>',
    '\t<div id="element-checkbox">',
    `\t\t<input type="checkbox" title="${labels.key('formbuilder.isselected')}" class="checkbox mura-tb-grid-checkbox" data-id="" value="1" />`,
    '\t</div>',
    '\t<div id="element-radio">',
    `\t\t<input type="radio" name="isdefault" title="${labels.key('formbuilder.default')}" class="radio mura-tb-grid-radio" data-id="" />`,
    '\t</div>',
    '\t<div id="element-handle">',
    '\t\t<span class="mura-tb-grid-handle"></span>',
    '\t</div>',
    '</div>',
  ].join(CRLF);
}

/** `dataset-row.cfm`. */
function datasetRow({ labels }: FormBuilderTemplateInput): string {
  return [
    '<div id="dataset-row">',
    '\t<div id="element-row">',
    '\t\t<li></li>',
    '\t</div>',
    '\t<div id="element-button-delete">',
    `\t\t<div class="button-grid-row-delete" title="${labels.key('formbuilder.dataset.delete')}"></div>`,
    '\t</div>',
    '\t<div id="element-labels">',
    `\t\t<label id="label">${labels.key('formbuilder.dataset.label')}</label>`,
    `\t\t<label id="value">${labels.key('formbuilder.dataset.value')}</label>`,
    '\t</div>',
    '\t<div id="element-cell">',
    `\t\t<span class='mura-tb-cell'></span>`,
    '\t</div>',
    '\t<div id="element-display">',
    '\t\t<div class="mura-tb-grid-display"></div>',
    '\t</div>',
    '\t<div id="element-input">',
    '\t\t<input type="text" class="mura-tb-grid-input" />',
    '\t</div>',
    '\t<div id="element-checkbox">',
    `\t\t<input type="checkbox" title="${labels.key('formbuilder.isselected')}" class="checkbox mura-tb-grid-checkbox" data-id="" value="1" />`,
    '\t</div>',
    '\t<div id="element-radio">',
    `\t\t<input type="radio" name="isdefault" title="${labels.key('formbuilder.default')}" class="radio mura-tb-grid-radio" data-id="" />`,
    '\t</div>',
    '\t<div id="element-handle">',
    '\t\t<span class="mura-tb-grid-handle"></span>',
    '\t</div>',
    '</div>',
  ].join(CRLF);
}

/** `dataset-sourced.cfm`. */
function datasetSourced({ labels }: FormBuilderTemplateInput): string {
  return [
    '\t<div id="mura-tb-grid" class="mura-tb-form">',
    '\t\t<div id="dataset-sourced" class="mura-tb-header">',
    `\t\t\t<h2>${labels.key('formbuilder.source')}</h2>`,
    '\t\t\t<ul class="right">',
    `\t\t\t\t<li><div class="ui-button" id="button-grid-edit" title="${labels.key('formbuilder.dataset.edit')}"><span class="ui-icon ui-icon-pencil"></span></div></li>`,
    '\t\t\t</ul>',
    '\t\t</div>',
    '\t\t<div class="columns">',
    '\t\t\t<div class="col2">',
    '\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t<li>',
    `\t\t\t\t\t\t<label for="dataset">${labels.key('formbuilder.source')}</label>`,
    '\t\t\t\t\t\t<input id="tb-source" class="text medium disabled" name="source" type="text" value="" maxlength="150" disabled="true" />',
    '\t\t\t\t\t</li>',
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</div>',
  ].join(CRLF);
}

/** `field-block.cfm`. */
function fieldBlock({ labels }: FormBuilderTemplateInput): string {
  return [
    '\t\t<li>',
    '\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t</ul>',
    '\t\t\t<div class="mura-tb-block">',
    '\t\t\t\t<span></span>',
    '\t\t\t</div>',
    '\t\t</li>',
  ].join(CRLF);
}

/** `field-checkbox.cfm`. */
function fieldCheckbox({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form" id="formblock-${fieldid}">',
    '\t\t\t<div class="mura-tb-header checkbox">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '',
    '\t\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>',
    '\t\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t\t</ul>',
    '',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' data-label="true" />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="size">${labels.key('formbuilder.field.size')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="size" value="" maxlength="250" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssid">${labels.key('formbuilder.field.cssid')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssid" value="" maxlength="250" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssclass">${labels.key('formbuilder.field.cssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssclass" value="" maxlength="250" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="wrappercssclass">${labels.key('formbuilder.field.wrappercssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="tooltip">${labels.key('formbuilder.field.tooltip')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="tooltip" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t<li>',
    `\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t</li>',
    '\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t<input type="checkbox" type="text" name="isrequired" value="1">',
    '\t\t\t\t\t</li>',
    '\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(LF);
}

/** `field-dropdown.cfm`. */
function fieldDropdown({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form" id="formblock-${fieldid}">',
    '\t\t\t<div class="mura-tb-header dropdown">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text  tb-label" type="text" name="label" value="" maxlength="50" data-required='true' data-label="true" />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text  disabled" name="name" type="text" value="" maxlength="50" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="size">${labels.key('formbuilder.field.size')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="size" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssid">${labels.key('formbuilder.field.cssid')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssid" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssclass">${labels.key('formbuilder.field.cssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="wrappercssclass">${labels.key('formbuilder.field.wrappercssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="tooltip">${labels.key('formbuilder.field.tooltip')}</label>`,
    '\t\t\t\t\t\t\t<textarea name="tooltip" value="" maxlength="250" ></textarea>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t\t</div>',
    '\t\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t\t<input type="checkbox" type="text" name="isrequired" value="1">',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t\t</div>',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `field-file.cfm`. */
function fieldFile({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header fileuploadfield">',
    '\t\t\t\t<h2><span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t</ul>',
    '',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="placeholder">${labels.key('formbuilder.field.placeholder')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="placeholder" value="" maxlength="255" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatetype">${labels.key('formbuilder.field.validatetype')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="validatetype">',
    `\t\t\t\t\t\t\t\t<option value="">${labels.key('formbuilder.field.validate.none')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="regex">${labels.key('formbuilder.field.validate.regex')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validateregex">${labels.key('formbuilder.field.validateregex')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validateregex" value="" maxlength="350" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t\t<input type="checkbox" name="isrequired" value="1">',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `field-hidden.cfm`. */
function fieldHidden({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header hiddenfield">',
    '\t\t\t\t<h2><span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="value">${labels.key('formbuilder.field.value')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="value" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>\t\t',
    '\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `field-nested.cfm`. */
function fieldNested({ labels, nestedForms }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header nestedform">',
    '\t\t\t\t<h2><span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="prefix">${labels.key('formbuilder.field.prefix')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="value">${labels.key('formbuilder.form')}</label>`,
    '\t\t\t\t\t\t\t<select name="formid" id="tb-formid">',
    `\t\t\t\t\t\t\t\t${formOptions(nestedForms)}`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t',
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>\t\t',
    '\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `field-radio.cfm`. */
function fieldRadio({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form" id="formblock-${fieldid}">',
    '\t\t\t<div class="mura-tb-header radio">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text long tb-label" type="text" name="label" value="" maxlength="50" data-required='true' data-label="true" />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text long disabled" name="name" type="text" value="" maxlength="50" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="size">${labels.key('formbuilder.field.size')}</label>`,
    `\t\t\t\t\t\t\t<input class="text short" type="text" name="size" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssid">${labels.key('formbuilder.field.cssid')}</label>`,
    `\t\t\t\t\t\t\t<input class="text long" type="text" name="cssid" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssclass">${labels.key('formbuilder.field.cssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text long" type="text" name="cssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="wrappercssclass">${labels.key('formbuilder.field.wrappercssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="tooltip">${labels.key('formbuilder.field.tooltip')}</label>`,
    '\t\t\t\t\t\t\t<textarea name="tooltip" value="" maxlength="250" ></textarea>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div> ',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t<li>',
    `\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t</li>',
    '\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t<input type="checkbox" type="text" name="isrequired" value="1">',
    '\t\t\t\t\t</li>',
    '\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t',
    '\t\t\t\t',
    '\t\t\t</div> ',
    '\t\t</div> ',
    '\t</span>',
  ].join(LF);
}

/** `field-section.cfm`. */
function fieldSection({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form" id="formblock-${fieldid}">',
    '\t\t\t<div class="mura-tb-header">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t<li>',
    `\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    '\t\t\t\t\t\t<input class="text  tb-label" type="text" name="label" value="" data-label="true">',
    '\t\t\t\t\t</li>',
    '\t\t\t\t\t<li>',
    `\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t<input id="tb-name" class="text" name="name" type="text" value="" maxlength="50" disabled="true" />',
    '\t\t\t\t\t</li>',
    '\t\t\t\t\t<li>',
    '\t\t\t\t\t\t<label for="fieldsetopen">As Fieldset?',
    '\t\t\t\t\t\t</label>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;',
    '\t\t\t\t\t\t\t<select class="select" name="fieldsetopen">',
    '\t\t\t\t\t\t\t\t<option value="0">No</option>',
    '\t\t\t\t\t\t\t\t<option value="1">Yes</option>',
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t\t(label will not appear)',
    '\t\t\t\t\t</li>',
    '\t\t\t\t\t<li>',
    '\t\t\t\t\t<label for="fieldsetid">Fieldset ID</label>',
    '\t\t\t\t\t\t<input class="text" type="text" name="fieldsetid" value="" data-label="true">',
    '\t\t\t\t\t</li>',
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t</div>',
    '',
    '\t</span>',
  ].join(CRLF);
}

/** `field-textarea.cfm`. */
function fieldTextarea({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header textarea">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text  tb-label" type="text" name="label" value="" maxlength="50" data-required='true' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text  disabled" name="name" type="text" value="" maxlength="50" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="value">${labels.key('formbuilder.field.value')}</label>`,
    '\t\t\t\t\t\t\t<textarea class="textarea" name="value"></textarea>',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="size">${labels.key('formbuilder.field.size')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="size" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssid">${labels.key('formbuilder.field.cssid')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssid" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssclass">${labels.key('formbuilder.field.cssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="wrappercssclass">${labels.key('formbuilder.field.wrappercssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="placeholder">${labels.key('formbuilder.field.placeholder')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="placeholder" value="" maxlength="255" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="tooltip">${labels.key('formbuilder.field.tooltip')}</label>`,
    '\t\t\t\t\t\t\t<textarea name="tooltip" value="" maxlength="250" ></textarea>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t\t<input type="checkbox" type="text" name="isrequired" value="1">',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `field-textblock.cfm`. */
function fieldTextblock({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header textblock">',
    '\t\t\t\t<h2> <span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic" style="position: relative">\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text  tb-label" type="text" name="label" value="" maxlength="50" data-required='true' />`,
    `\t\t\t\t\t\t\t<textarea id='field_textblock' class="textarea" name="value"></textarea>`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(LF);
}

/** `field-textfield.cfm`. */
function fieldTextfield({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form">',
    '\t\t\t<div class="mura-tb-header textfield">',
    '\t\t\t\t<h2><span id="mura-tb-form-label"></span></h2>',
    '\t\t\t\t<ul class="mura-tb-nav-utility">',
    `\t\t\t\t\t<li><div id="button-trash" title="${labels.key('formbuilder.delete')}"></div></li>`,
    '\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs" id="ui-tabs">',
    '\t\t\t',
    '\t\t\t<ul class="ui-tabs-nav">',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>',
    '\t\t\t\t<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>',
    '\t\t\t</ul>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">',
    '\t\t\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="label">${labels.key('formbuilder.field.label')}</label>`,
    `\t\t\t\t\t\t\t<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="name">${labels.key('formbuilder.field.name')}</label>`,
    '\t\t\t\t\t\t\t<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="value">${labels.key('formbuilder.field.value')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="value" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    `\t\t\t\t\t\t${PLUGIN_EVENT_OUTPUT}`,
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">\t',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="size">${labels.key('formbuilder.field.size')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="size" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssid">${labels.key('formbuilder.field.cssid')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssid" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="cssclass">${labels.key('formbuilder.field.cssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="cssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="wrappercssclass">${labels.key('formbuilder.field.wrappercssclass')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="placeholder">${labels.key('formbuilder.field.placeholder')}</label>`,
    `\t\t\t\t\t\t\t<input class="text " type="text" name="placeholder" value="" maxlength="255" data-required='false' />`,
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="tooltip">${labels.key('formbuilder.field.tooltip')}</label>`,
    '\t\t\t\t\t\t\t<textarea name="tooltip" value="" maxlength="250" ></textarea>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t</div>',
    '\t\t\t',
    '\t\t\t<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">',
    '\t\t\t\t\t<ul class="template-form">',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatetype">${labels.key('formbuilder.field.validatetype')}</label>`,
    '\t\t\t\t\t\t\t<select class="select" name="validatetype">',
    `\t\t\t\t\t\t\t\t<option value="">${labels.key('formbuilder.field.validate.none')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="numeric">${labels.key('formbuilder.field.validate.numeric')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="date">${labels.key('formbuilder.field.validate.date')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="email">${labels.key('formbuilder.field.validate.email')}</option>`,
    `\t\t\t\t\t\t\t\t<option value="regex">${labels.key('formbuilder.field.validate.regex')}</option>`,
    '\t\t\t\t\t\t\t</select>',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validateregex">${labels.key('formbuilder.field.validateregex')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validateregex" value="" maxlength="350" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li>',
    `\t\t\t\t\t\t\t<label for="validatemessage">${labels.key('formbuilder.field.validatemessage')}</label>`,
    '\t\t\t\t\t\t\t<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t\t<li class="checkbox">',
    '\t\t\t\t\t\t\t<label for="isrequired">',
    `\t\t\t\t\t\t\t${labels.key('formbuilder.field.isrequired')}</label>`,
    '\t\t\t\t\t\t\t<input type="checkbox" name="isrequired" value="1">',
    '\t\t\t\t\t\t</li>',
    '\t\t\t\t\t</ul>',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `form-form.cfm`. */
function formForm({ labels }: FormBuilderTemplateInput): string {
  return [
    '<span>',
    '\t\t<div class="mura-tb-form" id="formblock-${fieldid}">',
    '\t\t\t<div class="mura-tb-header">',
    `\t\t\t\t<h2><span id="mura-tb-form-label">${labels.key('formbuilder.form')}</span></h2>`,
    '\t\t\t</div>',
    '\t\t\t<ul class="template-form">',
    '\t\t\t\t<li>',
    `\t\t\t\t\t<label for="label">${labels.key('formbuilder.form.emailsubject')}</label>`,
    '\t\t\t\t\t<input class="text tb-emailsubject" type="text" name="emailsubject" value="" data-label="true">',
    '\t\t\t\t</li>',
    '\t\t\t\t<li>',
    `\t\t\t\t\t<label for="name">${labels.key('formbuilder.form.replyto')}</label>`,
    '\t\t\t\t\t<input class="text tb-replyto" type="text" name="replyto" value="" data-label="true">',
    '\t\t\t\t</li>',
    '\t\t\t\t<li>',
    `\t\t\t\t\t<label for="name">${labels.key('formbuilder.form.submitlabel')}</label>`,
    '\t\t\t\t\t<input class="text tb-submitlabel" type="text" name="submitlabel" value="" data-label="true">',
    '\t\t\t\t</li>',
    '\t\t\t\t<li>',
    `\t\t\t\t\t<label for="name">${labels.key('formbuilder.form.class')}</label>`,
    '\t\t\t\t\t<input class="text tb-class" type="text" name="class" value="" data-label="true">',
    '\t\t\t\t</li>',
    '\t\t\t\t<li>',
    `\t\t\t\t\t<label for="name-restricted">${labels.key('formbuilder.form.nameunrestricted')}</label>`,
    '\t\t\t\t\t<input id="tb-name-restricted" class="text tb-class" type="checkbox" name="name-unrestricted" value="1" data-label="true"> *',
    '\t\t\t\t</li>',
    '\t\t\t\t',
    '\t\t\t\t<input id="tb-muraormentities" class="text tb-class" type="hidden" name="muraormentities" value="0" data-label="true">',
    '',
    '\t\t\t\t<li>',
    '\t\t\t\t\t<div>',
    `\t\t\t\t\t*${labels.key('formbuilder.form.nameunrestrictedtip')}`,
    '\t\t\t\t\t</div>',
    '\t\t\t\t\t',
    '\t\t\t\t</li>',
    '',
    '',
    '',
    '\t\t\t</ul>',
    '\t\t</div>',
    '\t</span>',
  ].join(CRLF);
}

/** `message-dataset-sourcerequired.cfm`. */
function messageDatasetSourcerequired({ labels }: FormBuilderTemplateInput): string {
  return `<span>${labels.key('formbuilder.dataset.sourcerequired')}</span>`;
}

/** `message-delete-row.cfm`. */
function messageDeleteRow({ labels }: FormBuilderTemplateInput): string {
  return `<span>${labels.key('formbuilder.dataset.rowdeleteconfirm')}</span>`;
}

/** File names of admin/core/utilities/formbuilder/templates/ without `.cfm`. */
export type FormBuilderTemplateName =
  | 'dataset-create'
  | 'dataset-form'
  | 'dataset-grid'
  | 'dataset-nested'
  | 'dataset-row'
  | 'dataset-sourced'
  | 'field-block'
  | 'field-checkbox'
  | 'field-dropdown'
  | 'field-file'
  | 'field-hidden'
  | 'field-nested'
  | 'field-radio'
  | 'field-section'
  | 'field-textarea'
  | 'field-textblock'
  | 'field-textfield'
  | 'form-form'
  | 'message-dataset-sourcerequired'
  | 'message-delete-row';

/** The form-builder templates by file name without `.cfm`. */
export const FORMBUILDER_TEMPLATES: Readonly<Record<FormBuilderTemplateName, FormBuilderTemplate>> = Object.freeze({
  'dataset-create': datasetCreate,
  'dataset-form': datasetForm,
  'dataset-grid': datasetGrid,
  'dataset-nested': datasetNested,
  'dataset-row': datasetRow,
  'dataset-sourced': datasetSourced,
  'field-block': fieldBlock,
  'field-checkbox': fieldCheckbox,
  'field-dropdown': fieldDropdown,
  'field-file': fieldFile,
  'field-hidden': fieldHidden,
  'field-nested': fieldNested,
  'field-radio': fieldRadio,
  'field-section': fieldSection,
  'field-textarea': fieldTextarea,
  'field-textblock': fieldTextblock,
  'field-textfield': fieldTextfield,
  'form-form': formForm,
  'message-dataset-sourcerequired': messageDatasetSourcerequired,
  'message-delete-row': messageDeleteRow,
});

/** The file a raw template name resolves to: `lcase(rereplace(name, "[^[:alnum:]|-]", "", "all") & ".cfm")`. */
export function formBuilderTemplateFile(name: string): string {
  // ACF's [:alnum:] class is ASCII only.
  return `${name.replace(/[^A-Za-z0-9|-]/g, '')}.cfm`.toLowerCase();
}

/** Whether `name` resolves to field-nested.cfm, the one template whose caller must pass `nestedForms`. */
export function templateListsForms(name: string): boolean {
  return formBuilderTemplateFile(name) === 'field-nested.cfm';
}

/**
 * formBuilderManager getDialog and getFieldTemplate (cform `rc.dialog` / `rc.fieldtype`): the trimmed template, or
 * the missing-template message. Legacy's per-locale cache stores under the raw name but looks up the file name, so it
 * never hits and every call renders afresh.
 */
export function renderFormBuilderTemplate(
  name: string,
  labels: AdminLabels,
  nestedForms?: readonly NestedFormRow[],
): string {
  const file = formBuilderTemplateFile(name);
  const stem = file.slice(0, -'.cfm'.length);
  if (!Object.hasOwn(FORMBUILDER_TEMPLATES, stem)) {
    return `${labels.key('formbuilder.missingfieldtemplatefile')}: ${file}`;
  }
  return javaTrim(FORMBUILDER_TEMPLATES[stem as FormBuilderTemplateName]({ labels, nestedForms }));
}

// --- Bean JSON (cfobject.cfc:198-236: getAsJSON = serializeJSON(getAsStruct())) ---
// The beans keep `variables.instance` in an unordered ACF struct; each literal below lists the keys in the order
// serializeJSON prints them. getAsStruct replaces nested beans by their structs and JSON-looking values by their
// deserialized value (`"0"` becomes 0, `"{}"` becomes {}).

/** A simple value getAsStruct leaves after `deserializeJSON`. */
export type CfDeserializedValue = string | number | boolean | null;

/** formBean.getAsStruct() of a new bean (formBean.cfc:99-144). */
export interface FormBeanStruct {
  datecreate: string;
  fields: Record<string, never>;
  pages: [];
  statuscode: number;
  datelastupdate: string;
  formattributes: Record<string, never>;
  siteid: string;
  formid: string;
  isactive: number;
  name: string;
  config: Record<string, never>;
  notes: string;
  remoteid: string;
  iscurrent: number;
  package: string;
  deletedfields: Record<string, never>;
  fieldorder: [];
}

/** fieldtypeBean.getAsStruct() as formBuilderManager.getFieldTypeBean leaves it (fieldtypeBean.cfc:92-122). */
export interface FieldTypeBeanStruct {
  fieldtypeid: string;
  islong: number;
  datecreate: string;
  fieldtype: CfDeserializedValue;
  IsMultiSelect: number;
  moduleid: string;
  datelastupdate: string;
  rblabel: string;
  displaytype: CfDeserializedValue;
  bean: string;
  isdata: number;
  label: string;
}

/** fieldBean.getAsStruct() as formBuilderManager.getFieldBean leaves it (fieldBean.cfc:112-184). */
export interface FieldBeanStruct {
  fieldid: string;
  sectionid: string;
  validatemessage: string;
  fieldtype: FieldTypeBeanStruct;
  relatedid: string;
  rblabel: string;
  value: string;
  config: Record<string, never>;
  isrequired: number;
  label: string;
  type: string;
  fieldtypeid: string;
  datecreate: string;
  cssstyle: string;
  datelastupdate: string;
  validateregex: string;
  isactive: number;
  formid: string;
  name: string;
  placeholder: string;
  islocked: number;
  validatetype: string;
  datasetid: string;
  remoteid: string;
  tooltip: string;
  isdeleted: number;
  orderno: number;
  isentrytype: string;
  params: string;
}

/** datarecordBean.getAsStruct() of the model getDatasetBean creates (datarecordBean.cfc:90-116). */
export interface DataRecordBeanStruct {
  datasetid: string;
  datecreate: string;
  remoteid: string;
  orderno: number;
  datelastupdate: string;
  isselected: number;
  label: string;
  datarecordid: string;
  value: string;
}

/** datasetBean.getAsStruct() as formBuilderManager.getDatasetBean leaves it (datasetBean.cfc:104-157). */
export interface DatasetBeanStruct {
  datarecords: Record<string, never>;
  deletedrecords: Record<string, never>;
  datecreate: string;
  issortchanged: number;
  datelastupdate: string;
  model: DataRecordBeanStruct;
  sourcetype: string;
  siteid: string;
  isactive: number;
  name: string;
  islocked: number;
  datasetid: string;
  remoteid: string;
  parentid: string;
  source: string;
  sorttype: string;
  issorted: number;
  isglobal: number;
  sortdirection: string;
  sortcolumn: string;
  datarecordorder: [];
}

/** cform.getForm request values; an absent id is a new CF UUID. */
export interface FormBeanInput {
  formId?: string;
}

/** cform.getField request values; `formId` is required, `fieldType` defaults to `field-textfield`. */
export interface FieldBeanInput {
  formId?: string;
  fieldId?: string;
  fieldType?: string;
}

/** cform.getFieldType request values; `fieldType` defaults to `field-textfield`. */
export interface FieldTypeBeanInput {
  fieldTypeId?: string;
  fieldType?: string;
}

/** cform.getDataset request values; an absent or empty `datasetId` is a new CF UUID, `fieldId` is required. */
export interface DatasetBeanInput {
  datasetId?: string;
  fieldId?: string;
}

const DEFAULT_FIELD_TYPE = 'field-textfield';

/** A controller read of `arguments.rc.<key>` for a key the request lacks. */
function rcValue(value: string | undefined, key: string): string {
  if (value === undefined) throw new CformRequestError(`Element RC.${key} is undefined in ARGUMENTS.`);
  return value;
}

/** A CFML `type="uuid"` argument check. */
function uuidArgument(value: string, argument: string, fn: string): string {
  if (!isCfUuid(value)) {
    throw new CformRequestError(`The ${argument} argument passed to the ${fn} function is not of type uuid.`);
  }
  return value;
}

/** getAsStruct's `isJSON` and `deserializeJSON` of a field-type segment, which holds only `[a-z0-9|]`. */
function deserializedSegment(segment: string): CfDeserializedValue {
  if (segment === 'true') return true;
  if (segment === 'false') return false;
  if (segment === 'null') return null;
  // ACF's parser takes leading zeros ('007' prints 7) and reads exponent literals as Doubles ('1e5' prints 100000.0);
  // acfSerializeJson prints integral numbers as integers, the int/double limit cfjson.ts documents.
  return /^[0-9]+(e[0-9]+)?$/.test(segment) ? Number(segment) : segment;
}

/** `ListToArray(rereplace(fieldType, "[^[:alnum:]|-]", "", "all"), "-")`, lower-cased, as display and type names. */
function fieldTypeNames(fieldType: string): [display: string, type: string] {
  const names = fieldType.replace(/[^A-Za-z0-9|-]/g, '').split('-').filter((s) => s !== '');
  const [display, type] = names;
  if (display === undefined || type === undefined) {
    throw new CformRequestError(
      `The element at position ${String(names.length + 1)} of dimension 1,${' '.repeat(18)}of array variable ` +
        '"AFIELDTEMPLATE," cannot be found.',
    );
  }
  return [display.toLowerCase(), type.toLowerCase()];
}

/** cform.getForm: `formBuilderManager.getFormBean(formID).getAsStruct()`. */
export function formBeanStruct(input: FormBeanInput = {}): FormBeanStruct {
  const formid = uuidArgument(input.formId ?? cfUuid(), 'FORMID', 'getFormBean');
  return {
    datecreate: '',
    fields: {},
    pages: [],
    statuscode: 0,
    datelastupdate: '',
    formattributes: {},
    siteid: '',
    formid,
    isactive: 0,
    name: '',
    config: {},
    notes: '',
    remoteid: '',
    iscurrent: 0,
    package: '',
    deletedfields: {},
    fieldorder: [],
  };
}

/** cform.getFieldType: `formBuilderManager.getFieldTypeBean(fieldTypeID, fieldType).getAsStruct()`. */
export function fieldTypeBeanStruct(input: FieldTypeBeanInput = {}): FieldTypeBeanStruct {
  const fieldtypeid = uuidArgument(input.fieldTypeId ?? cfUuid(), 'FIELDTYPEID', 'getFieldTypeBean');
  const [display, type] = fieldTypeNames(input.fieldType ?? DEFAULT_FIELD_TYPE);
  return {
    fieldtypeid,
    islong: type === 'textarea' || type === 'htmleditor' ? 1 : 0,
    datecreate: '',
    fieldtype: deserializedSegment(type),
    IsMultiSelect: 0,
    moduleid: '',
    datelastupdate: '',
    rblabel: '',
    displaytype: deserializedSegment(display),
    bean: '',
    isdata: ['dropdown', 'checkbox', 'radio', 'multientity'].includes(type) ? 1 : 0,
    label: '',
  };
}

/** cform.getField: `formBuilderManager.getFieldBean(formID, fieldID, fieldType).getAsStruct()`. */
export function fieldBeanStruct(input: FieldBeanInput, labels: AdminLabels): FieldBeanStruct {
  const formid = uuidArgument(rcValue(input.formId, 'formID'), 'FORMID', 'getFieldBean');
  const fieldid = uuidArgument(input.fieldId ?? cfUuid(), 'FIELDID', 'getFieldBean');
  const fieldType = input.fieldType ?? DEFAULT_FIELD_TYPE;
  const fieldtype = fieldTypeBeanStruct({ fieldType });
  // `rereplace(fieldType, ".[^\-]*-", "")` on the raw value: only the first match goes.
  const typeLabel = labels.key(`formbuilder.field.${fieldType.replace(/[^\n][^-]*-/, '')}`);
  return {
    fieldid,
    sectionid: '00000000-0000-0000-0000000000000000',
    validatemessage: '',
    fieldtype,
    relatedid: '',
    rblabel: '',
    value: '',
    config: {},
    isrequired: 0,
    label: `${labels.key('formbuilder.new')} ${typeLabel}`,
    type: 'COMMON',
    fieldtypeid: '',
    datecreate: '',
    cssstyle: '',
    datelastupdate: '',
    validateregex: '',
    isactive: 1,
    formid,
    name: '',
    placeholder: '',
    islocked: 0,
    validatetype: '',
    datasetid: '',
    remoteid: '',
    tooltip: '',
    isdeleted: 0,
    orderno: 0,
    isentrytype: 'SINGLE',
    params: '',
  };
}

/** cform.getDataset: `formBuilderManager.getDatasetBean(datasetID, fieldID).getAsStruct()` with its new model record. */
export function datasetBeanStruct(input: DatasetBeanInput): DatasetBeanStruct {
  const datasetid = uuidArgument(
    input.datasetId === undefined || input.datasetId === '' ? cfUuid() : input.datasetId,
    'DATASETID',
    'getDatasetBean',
  );
  // getDatasetBean checks fieldID, then hands it to datasetBean.init, which declares no such argument.
  uuidArgument(rcValue(input.fieldId, 'fieldID'), 'FIELDID', 'getDatasetBean');
  return {
    datarecords: {},
    deletedrecords: {},
    datecreate: '',
    issortchanged: 0,
    datelastupdate: '',
    model: {
      datasetid,
      datecreate: '',
      remoteid: '',
      orderno: 0,
      datelastupdate: '',
      isselected: 0,
      label: '',
      datarecordid: cfUuid(),
      value: '',
    },
    sourcetype: '',
    siteid: '',
    isactive: 1,
    name: '',
    islocked: 0,
    datasetid,
    remoteid: '',
    parentid: '',
    source: '',
    sorttype: '',
    issorted: 0,
    isglobal: 0,
    sortdirection: 'asc',
    sortcolumn: 'orderby',
    datarecordorder: [],
  };
}

/** ACF serializeJSON of a bean struct; the keys keep the case the beans set them with. */
function beanJson(struct: object): string {
  return acfSerializeJson(struct, { preserveKeyCase: true });
}

/** cform.getForm `rc.return`: `formBean.getAsJSON()`. */
export function formBeanJson(input: FormBeanInput = {}): string {
  return beanJson(formBeanStruct(input));
}

/** cform.getField `rc.return`: `fieldBean.getAsJSON()`. */
export function fieldBeanJson(input: FieldBeanInput, labels: AdminLabels): string {
  return beanJson(fieldBeanStruct(input, labels));
}

/** cform.getFieldType `rc.return`: `fieldTypeBean.getAsJSON()`. */
export function fieldTypeBeanJson(input: FieldTypeBeanInput = {}): string {
  return beanJson(fieldTypeBeanStruct(input));
}

/** cform.getDataset `rc.return`: `datasetBean.getAsJSON()`. */
export function datasetBeanJson(input: DatasetBeanInput): string {
  return beanJson(datasetBeanStruct(input));
}

// --- Views (cform/json.cfm, cform/html.cfm) ---

/** A cform view response. */
export interface CformResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * The view printing `rc.return` and aborting: json.cfm (getForm, getField, getFieldType, getDataset) behind its
 * `cfcontent` type, or html.cfm (getDialog, getFieldTemplate) as page output.
 */
export function renderCformResponse(kind: 'json' | 'html', body: string): CformResponse {
  // The wire forms: the servlet container drops the space json.cfm writes before `charset`.
  return { status: 200, contentType: kind === 'json' ? LEGACY_JSON_CONTENT_TYPE : LEGACY_HTML_CONTENT_TYPE, body };
}

