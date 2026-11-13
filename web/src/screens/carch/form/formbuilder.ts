// Form builder of the content editor's basic panel (`admin/core/views/carch/form/dsp_formbuilder.cfm`).
import { legacySettings } from '@/lib/env';
import { raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import type { EditFormState, EditPageData } from './custom-tags';

/** What the include reads; an `EditFormInput` satisfies it. */
export interface FormBuilderInput {
  readonly ctx: Pick<ScreenContext, 'rb'>;
  /** The edit model; `rc.contentBean` body is the form JSON (strategies-content's `createJSONForm` for a new form). */
  readonly data: EditPageData;
  readonly state: Pick<EditFormState, 'isExtended'>;
}

/** Toolbar field buttons in legacy order: field type and its icon class suffix. */
const FIELD_BUTTONS: ReadonlyArray<readonly [field: string, icon: string]> = Object.freeze([
  ['textfield', 'textfield'],
  ['textarea', 'textarea'],
  ['hidden', 'hidden'],
  ['radio', 'radiobox'],
  ['checkbox', 'checkbox'],
  ['dropdown', 'select'],
  ['file', 'file'],
  ['textblock', 'textblock'],
  ['nested', 'nested'],
] as const);

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Readonly<Record<string, unknown>>, key: string): unknown {
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** `rc.contentBean.getBody()`; an absent or SQL NULL body reads as `''`. */
function contentBody(data: EditPageData): string {
  const bean = member(data.rc, 'contentBean');
  if (typeof bean !== 'object' || bean === null || Array.isArray(bean)) {
    throw new TypeError('rc.contentBean is not a struct');
  }
  const body = member(bean as Readonly<Record<string, unknown>>, 'body');
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw new TypeError('rc.contentBean.body is not a string');
  return body;
}

/** The include's output, from the newline after `<cfoutput>` through the last `</script>` and its newline. */
export function renderFormBuilder(input: FormBuilderInput): SafeHtml {
  const { rb } = input.ctx;
  const { context, adminDir } = legacySettings();
  const fieldButtons = FIELD_BUTTONS.map(
    ([field, icon]) =>
      `\t\t\t<li><div class="ui-button button-field" id="button-${field}" data-object="field-${field}" title="${rb.rbKey(`formbuilder.field.${field}.tooltip`)}"><span class="ui-icon ui-icon-formfield ui-icon-formfield-${icon}"></span></div></li>\n`,
  ).join('');
  // CFML `replace(body, "&quot;", "\""", "all")`: the replacement literal `"\"""` is a backslash and a quote.
  const body = contentBody(input.data).replaceAll('&quot;', '\\"');
  // The `cfif not isExtended` tags print nothing; the whitespace around them stays in either branch.
  const showOnReady = input.state.isExtended
    ? ''
    : '\n\t\tjQuery(document).ready(function(){\n\t\t\tshowBodyEditor();\n\t\t});\n\t\t';
  // Legacy markup verbatim (no redesign: div buttons and the inline style stay); settings, labels and body print
  // unencoded, as legacy prints them.
  return raw(`
<script>
	isFormBuilder = true;

	jQuery(document).ready(function() {
		jQuery("#mura-templatebuilder").templatebuilder();
	});
</script>

	<div id="mura-templatebuilder" data-url="${context}${adminDir}/">
		<div class="mura-tb-menu">
			<ul class="mura-tb-form-menu">
			<li><div class="ui-button button-field" id="button-form" data-object="section-form" title="${rb.rbKey('formbuilder.form.tooltip')}"><span class="ui-button-text">${rb.rbKey('formbuilder.form')}</span></div></li>
			<li class="spacer"></li>
			</ul>
			<ul class="mura-tb-field-menu">
			<li><div class="ui-button button-field" id="button-section" data-object="section-section" title="${rb.rbKey('formbuilder.field.section.tooltip')}"><span class="ui-button-text ui-icon-formfield-section">${rb.rbKey('formbuilder.field.section')}</span></div></li>
			<li class="spacer"></li>
${fieldButtons}			</ul>
		</div>
		<div id="mura-tb-form">
			<div id="mura-tb-form-pages">
					Page
				<ul id="mura-form-pages">
				</ul>
				<div id="mura-form-addpage">+</div>
			</div>
			<div id="mura-tb-form-fields">
				<div id="mura-tb-fields-empty" class="help-block">${rb.rbKey('formbuilder.fields.empty')}</div>
				<ul id="mura-tb-fields">
				</ul>
			</div>
			<div id="mura-tb-fields-settings">
				<div id="mura-tb-field-form" class="mura-tb-data-form">
					<div id="mura-tb-field-empty" class="help-block">${rb.rbKey('formbuilder.field.empty')}</div>
					<div id="mura-tb-field">
					</div>
				</div>
				<div id="mura-tb-dataset-form" class="mura-tb-data-form">
				</div>
				<div id="mura-tb-grid">
				</div>
			</div>
			<div style="clear:both;"></div>
		</div>

	</div>
	<textarea id="mura-formdata" name="body">${body}</textarea>

	<script>
		hideBodyEditor=function(){
			jQuery("#mura-templatebuilder").hide();
		}

		showBodyEditor=function(){
			jQuery("#mura-templatebuilder").show();
		}

		${showOnReady}
	</script>
`);
}
