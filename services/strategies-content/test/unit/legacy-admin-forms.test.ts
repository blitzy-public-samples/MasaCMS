// cform form-builder responses against bodies recorded from Masa 7.6.1 on ACF 2023 (test/fixtures/legacy-cform-recorded.json),
// rendered with the en admin bundle the recording session used.
import { readFileSync, readdirSync } from 'node:fs';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import { createAdminLabels } from '../../src/legacy/admin-markup.js';
import {
  CformRequestError,
  FORMBUILDER_TEMPLATES,
  datasetBeanJson,
  datasetBeanStruct,
  fieldBeanJson,
  fieldBeanStruct,
  fieldTypeBeanJson,
  fieldTypeBeanStruct,
  formBeanJson,
  formBeanStruct,
  formBuilderTemplateFile,
  renderCformResponse,
  renderFormBuilderTemplate,
  templateListsForms,
} from '../../src/legacy/admin-render-forms.js';

interface Recorded {
  contentTypes: { json: string; html: string };
  templates: Record<string, string>;
  missing: Record<string, string>;
  beans: { action: string; input: Record<string, string>; body: string }[];
  errors: { action: string; input: Record<string, string>; message: string }[];
}

const recorded = JSON.parse(
  readFileSync(new URL('../fixtures/legacy-cform-recorded.json', import.meta.url), 'utf8'),
) as Recorded;

const TEMPLATE_DIR = new URL('../../../../admin/core/utilities/formbuilder/templates/', import.meta.url);

/** The core admin bundle (`key=value` lines, no escapes in en.properties). */
function enBundle(): Record<string, string> {
  const source = readFileSync(new URL('../../../../core/mura/resourceBundle/resources/en.properties', import.meta.url), 'utf8');
  const bundle: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (line.startsWith('#') || eq < 0) continue;
    bundle[line.slice(0, eq).trim()] = line.slice(eq + 1).trimStart();
  }
  return bundle;
}

const labels = createAdminLabels(enBundle());
const FORM_ID = '11111111-2222-3333-4444555566667777';
const CF_UUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}/g;

/** The golden normaliser's id rule: CF UUIDs become ordinal placeholders per body. */
function normaliseIds(body: string): string {
  const seen = new Map<string, number>();
  return body.replace(CF_UUID, (id) => {
    if (!seen.has(id)) seen.set(id, seen.size + 1);
    return `<id:${String(seen.get(id))}>`;
  });
}

/** The cform action a recorded request ran. */
function run(action: string, input: Record<string, string>): string {
  switch (action) {
    case 'getForm':
      return formBeanJson(input);
    case 'getField':
      return fieldBeanJson(input, labels);
    case 'getFieldType':
      return fieldTypeBeanJson(input);
    case 'getDataset':
      return datasetBeanJson(input);
    case 'getFieldTemplate':
      return renderFormBuilderTemplate(input.fieldType ?? '', labels);
    default:
      throw new Error(`unrecorded action ${action}`);
  }
}

describe('form-builder templates', () => {
  it('ports every template file', () => {
    const files = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.cfm'));
    expect(Object.keys(FORMBUILDER_TEMPLATES).map((n) => `${n}.cfm`).sort()).toEqual(files.sort());
    expect(Object.keys(recorded.templates).sort()).toEqual(Object.keys(FORMBUILDER_TEMPLATES).sort());
  });

  it.each(Object.entries(recorded.templates))('renders %s byte for byte', (name, body) => {
    expect(renderFormBuilderTemplate(name, labels, name === 'field-nested' ? [] : undefined)).toBe(body);
  });

  it.each(Object.entries(recorded.missing))('answers %j with the missing-template message', (name, body) => {
    expect(renderFormBuilderTemplate(name, labels)).toBe(body);
  });

  it('resolves names as the sanitised lower-case file', () => {
    expect(renderFormBuilderTemplate('FIELD-TEXTFIELD', labels)).toBe(recorded.templates['field-textfield']);
    expect(formBuilderTemplateFile(' Dataset_Grid.cfm ')).toBe('datasetgridcfm.cfm');
    expect(renderFormBuilderTemplate('constructor', labels)).toBe('formbuilder.missingfieldtemplatefile_missing: constructor.cfm');
    expect([templateListsForms('Field-Nested'), templateListsForms('field-textfield')]).toEqual([true, false]);
  });

  it('lists the forms of field-nested as the cfloop prints them', () => {
    const html = renderFormBuilderTemplate('field-nested', labels, [
      { contentid: 'F1', title: 'Contact & <b>Us</b>' },
      { contentid: 'F2', title: null },
    ]);
    const tabs = (n: number): string => '\t'.repeat(n);
    expect(html).toContain(
      `<select name="formid" id="tb-formid">\r\n${tabs(8)}` +
        `\r\n${tabs(9)}<option value="F1">Contact & <b>Us</b></option>\r\n${tabs(8)}` +
        `\r\n${tabs(9)}<option value="F2"></option>\r\n${tabs(8)}` +
        `\r\n${tabs(7)}</select>`,
    );
  });
});

describe('form-builder bean JSON', () => {
  it.each(recorded.beans.map((b) => [b.action, JSON.stringify(b.input), b] as const))(
    '%s %s matches the recorded body',
    (action, _input, bean) => {
      const body = run(action, bean.input);
      expect(normaliseIds(body)).toBe(normaliseIds(bean.body));
      // Ids the request gave print as given wherever legacy printed them.
      for (const id of Object.values(bean.input).filter((v) => isCfUuid(v) && bean.body.includes(v))) {
        expect(body).toContain(`"${id}"`);
      }
    },
  );

  it.each<[string, number, number]>([
    ['field-dropdown', 1, 0],
    ['field-checkbox', 1, 0],
    ['field-radio', 1, 0],
    ['dataset-multientity', 1, 0],
    ['field-textarea', 0, 1],
    ['field-htmleditor', 0, 1],
    ['field-RADIO', 1, 0],
    ['field-textfield', 0, 0],
    ['field-file', 0, 0],
  ])('flags %s as isdata %i, islong %i', (fieldType, isdata, islong) => {
    expect(fieldTypeBeanStruct({ fieldType })).toMatchObject({ isdata, islong });
  });

  it('gives absent ids new CF UUIDs and shares the dataset id with its model', () => {
    const form = formBeanStruct();
    const field = fieldBeanStruct({ formId: FORM_ID }, labels);
    const dataset = datasetBeanStruct({ datasetId: '', fieldId: FORM_ID });
    for (const id of [form.formid, field.fieldid, field.fieldtype.fieldtypeid, dataset.datasetid, dataset.model.datarecordid]) {
      expect(isCfUuid(id)).toBe(true);
    }
    expect(field.fieldtypeid).toBe('');
    expect(dataset.model.datasetid).toBe(dataset.datasetid);
    expect(dataset.model.datarecordid).not.toBe(dataset.datasetid);
    expect(formBeanStruct().formid).not.toBe(form.formid);
  });

  it.each(recorded.errors.map((e) => [e.action, JSON.stringify(e.input), e] as const))(
    '%s %s fails as legacy does',
    (action, _input, error) => {
      expect(() => run(action, error.input)).toThrow(new CformRequestError(error.message));
    },
  );
});

describe('renderCformResponse', () => {
  it.each([
    ['json', recorded.contentTypes.json],
    ['html', recorded.contentTypes.html],
  ] as const)('wraps %s output with the recorded content type', (kind, contentType) => {
    expect(renderCformResponse(kind, '<span>x</span>')).toEqual({ status: 200, contentType, body: '<span>x</span>' });
  });
});
