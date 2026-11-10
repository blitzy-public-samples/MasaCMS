import type { RbLookup } from '@/lib/resource-bundles/rb';
import { datasetCreate } from './dataset-create';
import { datasetForm } from './dataset-form';
import { datasetGrid } from './dataset-grid';
import { datasetNested } from './dataset-nested';
import { datasetRow } from './dataset-row';
import { datasetSourced } from './dataset-sourced';
import { fieldBlock } from './field-block';
import { fieldCheckbox } from './field-checkbox';
import { fieldDropdown } from './field-dropdown';
import { fieldFile } from './field-file';
import { fieldHidden } from './field-hidden';
import { fieldNested } from './field-nested';
import { fieldRadio } from './field-radio';
import { fieldSection } from './field-section';
import { fieldTextarea } from './field-textarea';
import { fieldTextblock } from './field-textblock';
import { fieldTextfield } from './field-textfield';
import { formForm } from './form-form';
import { messageDeleteRow } from './message-delete-row';
import { messageDatasetSourcerequired } from './message-dataset-sourcerequired';

/** A form offered by the `field-nested` template's `formid` select. */
export interface NestedFormOption {
  readonly contentID: string;
  readonly title: string;
}

/** What a form-builder template renders from: the session admin bundle and the nested-form loader. */
export interface TemplateInput {
  readonly rb: RbLookup;
  readonly loadForms: () => Promise<readonly NestedFormOption[]>;
}

/** Renders one form-builder template to its untrimmed markup. */
export type TemplateRenderer = (input: TemplateInput) => string | Promise<string>;

/** Form-builder templates keyed by legacy file name without `.cfm`. */
export const FORMBUILDER_TEMPLATES: Readonly<Record<string, TemplateRenderer>> = Object.freeze({
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
  'message-delete-row': messageDeleteRow,
  'message-dataset-sourcerequired': messageDatasetSourcerequired,
});

/** Legacy template name rule `lcase(rereplace(raw, "[^[:alnum:]|-]", "", "all"))`: keeps ASCII alphanumerics, `|` and `-`. */
export function fieldTemplateName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9|-]/g, '').toLowerCase();
}

/** CF `trim`: strips leading and trailing characters up to U+0020, scanning char codes as Java `String.trim()` does. */
function cfTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/**
 * Renders the template a `cform.getfieldtemplate` or `cform.getdialog` request names, or legacy's missing-template
 * message. Renders afresh on every call: legacy's per-locale cache stores under the raw name but checks the
 * sanitised `.cfm` name, so it never hits.
 */
export async function renderFormBuilderTemplate(raw: string, input: TemplateInput): Promise<string> {
  const name = fieldTemplateName(raw);
  const renderer = Object.hasOwn(FORMBUILDER_TEMPLATES, name) ? FORMBUILDER_TEMPLATES[name] : undefined;
  if (renderer === undefined) {
    return input.rb.rbKey('formbuilder.missingfieldtemplatefile') + ': ' + name + '.cfm';
  }
  return cfTrim(await renderer(input));
}
