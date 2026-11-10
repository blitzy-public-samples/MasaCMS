import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createResourceBundles, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  FORMBUILDER_TEMPLATES,
  fieldTemplateName,
  renderFormBuilderTemplate,
  type NestedFormOption,
  type TemplateInput,
} from '@/screens/cform/templates';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';

const here = import.meta.dirname ?? __dirname;
const LEGACY_DIR = path.resolve(here, '../../../../admin/core/utilities/formbuilder/templates');

const FORM_A: NestedFormOption = { contentID: '2B7E4A10-5C3D-4E8F-9A1B2C3D4E5F6071', title: 'Volunteer Intake' };
const FORM_B: NestedFormOption = { contentID: 'C0FFEE00-1A2B-3C4D-5E6F708192A3B4C5', title: 'R&D <Intake> #2' };
const FORMS: readonly NestedFormOption[] = [FORM_A, FORM_B];

const rb = createResourceBundles(fixtureBundles).rbFor('en');
const labelled = createResourceBundles({
  ...fixtureBundles,
  admin: {
    ...fixtureBundles.admin,
    files: {
      de: { entries: [['formbuilder.dataset.rowdeleteconfirm', 'Zeile l&ouml;schen?']] },
      en: {
        entries: [
          ['formbuilder.dataset.rowdeleteconfirm', 'Delete Row?'],
          ['formbuilder.missingfieldtemplatefile', 'Missing template'],
        ],
      },
    },
  },
});

const PLUGIN_EVENT =
  "application.serviceFactory.getBean('$').init(session.siteid).renderEvent('onFormElementBasicTabRender')";
const RB_EXPRESSION = /^mmRBF\.getKeyValue\(session\.rb,'([^']+)'\)$/;
const FORM_LOOP = /<cfloop query="rsFormList">([\s\S]*?)<\/cfloop>/;

const inputOf = (lookup: RbLookup, forms: readonly NestedFormOption[] = FORMS): TemplateInput => ({
  rb: lookup,
  loadForms: async () => forms,
});

/** Wraps `base` to record every requested key in call order. */
function recording(base: RbLookup): { rb: RbLookup; keys: string[] } {
  const keys: string[] = [];
  const rbKey = (key: string): string => {
    keys.push(key);
    return base.rbKey(key);
  };
  return { keys, rb: { locale: base.locale, rbKey, messageFormat: base.messageFormat } };
}

/** Trimmed `<cfoutput>` of a legacy template as ColdFusion evaluates it with no plugin handlers, in LF line endings. */
function legacyOutput(name: string, lookup: RbLookup, forms: readonly NestedFormOption[]): string {
  const source = readFileSync(path.join(LEGACY_DIR, `${name}.cfm`), 'utf8')
    .replaceAll('\r\n', '\n')
    .replace(/<!---[\s\S]*?--->/g, '');
  const body = source.slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'));
  const evaluate = (text: string, row?: NestedFormOption): string =>
    text.replace(/##|#([^#]*)#/g, (token: string, expression: string | undefined) => {
      if (expression === undefined) return '#';
      const key = RB_EXPRESSION.exec(expression)?.[1];
      if (key !== undefined) return lookup.rbKey(key);
      if (expression === PLUGIN_EVENT) return '';
      if (row !== undefined && expression === 'rsFormList.contentID') return row.contentID;
      if (row !== undefined && expression === 'rsFormList.title') return row.title;
      throw new Error(`Unhandled CFML expression in ${name}.cfm: ${token}`);
    });
  const loop = FORM_LOOP.exec(body);
  if (loop === null) return evaluate(body).trim();
  const [tag, rowBody = ''] = loop;
  return (
    evaluate(body.slice(0, loop.index)) +
    forms.map((row) => evaluate(rowBody, row)).join('') +
    evaluate(body.slice(loop.index + tag.length))
  ).trim();
}

const TEMPLATE_CASES: [string, string][] = [
  ['dataset-create', '<span>'],
  ['dataset-form', '<div class="ui-tabs">'],
  ['dataset-grid', '<span>'],
  ['dataset-nested', '<div id="dataset-row">'],
  ['dataset-row', '<div id="dataset-row">'],
  ['dataset-sourced', '<div id="mura-tb-grid" class="mura-tb-form">'],
  ['field-block', '<li>'],
  ['field-checkbox', '<span>'],
  ['field-dropdown', '<span>'],
  ['field-file', '<span>'],
  ['field-hidden', '<span>'],
  ['field-nested', '<span>'],
  ['field-radio', '<span>'],
  ['field-section', '<span>'],
  ['field-textarea', '<span>'],
  ['field-textblock', '<span>'],
  ['field-textfield', '<span>'],
  ['form-form', '<span>'],
  ['message-dataset-sourcerequired', '<span>formbuilder.dataset.sourcerequired_missing</span>'],
  ['message-delete-row', '<span>formbuilder.dataset.rowdeleteconfirm_missing</span>'],
];

const tabs = (count: number): string => '\t'.repeat(count);
const optionMarkup = (form: NestedFormOption): string =>
  `\n${tabs(9)}<option value="${form.contentID}">${form.title}</option>\n${tabs(8)}`;
const selectMarkup = (forms: readonly NestedFormOption[]): string =>
  `<select name="formid" id="tb-formid">\n${tabs(8)}${forms.map(optionMarkup).join('')}\n${tabs(7)}</select>`;

describe('FORMBUILDER_TEMPLATES', () => {
  it('holds one frozen renderer per legacy template file', () => {
    const legacyNames = readdirSync(LEGACY_DIR)
      .filter((file) => file.endsWith('.cfm'))
      .map((file) => file.slice(0, -'.cfm'.length))
      .sort();
    expect(Object.keys(FORMBUILDER_TEMPLATES).sort()).toEqual(legacyNames);
    expect(TEMPLATE_CASES.map(([name]) => name).sort()).toEqual(legacyNames);
    expect(Object.isFrozen(FORMBUILDER_TEMPLATES)).toBe(true);
  });
});

describe('fieldTemplateName', () => {
  it.each([
    ['field-textfield', 'field-textfield'],
    ['FIELD-TextArea', 'field-textarea'],
    ['../message-delete-row', 'message-delete-row'],
    ['field_text field.cfm', 'fieldtextfieldcfm'],
    ['a|b-C9', 'a|b-c9'],
    ['field-tëxtfield', 'field-txtfield'],
    ['__proto__', 'proto'],
    ['!!', ''],
    ['', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(fieldTemplateName(raw)).toBe(expected);
  });
});

describe('renderFormBuilderTemplate', () => {
  it.each(TEMPLATE_CASES)('%s matches the legacy template', async (name, firstLine) => {
    const target = recording(rb);
    const legacy = recording(rb);
    const html = await renderFormBuilderTemplate(name, inputOf(target.rb));
    const expected = legacyOutput(name, legacy.rb, FORMS);
    expect(html.split('\n')[0]).toBe(firstLine);
    expect(html).toBe(expected);
    expect(target.keys).toEqual(legacy.keys);
    expect((await FORMBUILDER_TEMPLATES[name]?.(inputOf(rb)))?.trim()).toBe(html);
  });

  it.each([
    ['FIELD-TEXTAREA', 'field-textarea'],
    ['../message-delete-row', 'message-delete-row'],
    [' form-form\n', 'form-form'],
  ])('resolves %j to %s', async (raw, name) => {
    expect(await renderFormBuilderTemplate(raw, inputOf(rb))).toBe(await renderFormBuilderTemplate(name, inputOf(rb)));
  });

  it.each([
    ['field-unknown', 'field-unknown.cfm'],
    ['field|textfield', 'field|textfield.cfm'],
    ['field-tëxtfield', 'field-txtfield.cfm'],
    ['constructor', 'constructor.cfm'],
    ['toString', 'tostring.cfm'],
    ['__proto__', 'proto.cfm'],
    ['!!', '.cfm'],
  ])('reports %j as missing', async (raw, file) => {
    const loadForms = vi.fn(async () => FORMS);
    expect(await renderFormBuilderTemplate(raw, { rb, loadForms })).toBe(
      `formbuilder.missingfieldtemplatefile_missing: ${file}`,
    );
    expect(loadForms.mock.calls.length).toBe(0);
  });

  it('labels each render from its own session bundle', async () => {
    const render = (lookup: RbLookup): Promise<string> =>
      renderFormBuilderTemplate('message-delete-row', inputOf(lookup));
    expect(await render(labelled.rbFor('en'))).toBe('<span>Delete Row?</span>');
    expect(await render(labelled.rbFor('de'))).toBe('<span>Zeile l&ouml;schen?</span>');
    expect(await render(rb)).toBe('<span>formbuilder.dataset.rowdeleteconfirm_missing</span>');
    expect(await renderFormBuilderTemplate('field-unknown', inputOf(labelled.rbFor('en')))).toBe(
      'Missing template: field-unknown.cfm',
    );
  });

  it('loads forms only for field-nested', async () => {
    const loadForms = vi.fn(async () => FORMS);
    for (const name of Object.keys(FORMBUILDER_TEMPLATES)) {
      await renderFormBuilderTemplate(name, { rb, loadForms });
    }
    expect(loadForms.mock.calls.length).toBe(1);
  });

  it('rejects with the loadForms error', async () => {
    const failure = new Error('forms unavailable');
    const loadForms = vi.fn(async (): Promise<readonly NestedFormOption[]> => {
      throw failure;
    });
    await expect(renderFormBuilderTemplate('field-nested', { rb, loadForms })).rejects.toBe(failure);
  });
});

describe('field-nested', () => {
  it.each([
    ['no forms', []],
    ['one form', [FORM_A]],
    ['two forms', [FORM_A, FORM_B]],
  ] as [string, NestedFormOption[]][])('lists %s as unescaped formid options', async (_label, forms) => {
    const html = await renderFormBuilderTemplate('field-nested', inputOf(rb, forms));
    expect(/<select name="formid"[\s\S]*?<\/select>/.exec(html)?.[0]).toBe(selectMarkup(forms));
    expect(html).toBe(legacyOutput('field-nested', rb, forms));
  });
});
