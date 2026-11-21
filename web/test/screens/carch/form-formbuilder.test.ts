import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { EditPageData } from '@/screens/carch/form/custom-tags';
import { renderFormBuilder } from '@/screens/carch/form/formbuilder';

// `cArch.edit` of a new builder Form (`formType=builder`) on the default site, captured from the legacy ACF 2023
// server as admin and cut from the include's leading newline through the last `</script>\n`.
const LEGACY = readFileSync(
  new URL('../../fixtures/strategies-content/edit-formbuilder.html', import.meta.url),
  'utf8',
);

const LEGACY_BODY = /<textarea id="mura-formdata" name="body">([^<]*)<\/textarea>/.exec(LEGACY)?.[1] ?? '';

const READY_BLOCK = '\n\t\tjQuery(document).ready(function(){\n\t\t\tshowBodyEditor();\n\t\t});\n\t\t';

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** An edit model whose `rc` holds `contentBean`. */
function model(contentBean: unknown, beanKey = 'contentBean'): EditPageData {
  return { rc: { [beanKey]: contentBean } };
}

function render(data: EditPageData, isExtended = false, rb: RbLookup = rbFor('en')): string {
  const markup = renderFormBuilder({ ctx: { rb }, data, state: { isExtended } });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

beforeEach(() => {
  useSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.edit form builder', () => {
  it('matches the legacy include byte for byte', () => {
    expect(LEGACY_BODY).toMatch(/^\{"form":/);
    expect(render(model({ body: LEGACY_BODY }))).toBe(LEGACY);
  });

  it('omits only the ready block for an extended subtype', () => {
    expect(LEGACY).toContain(`}\n\n\t\t${READY_BLOCK}\n\t</script>\n`);
    expect(render(model({ body: LEGACY_BODY }), true)).toBe(LEGACY.replace(READY_BLOCK, ''));
  });

  it('replaces every &quot; with a backslash and a quote and prints the rest of the body raw', () => {
    const body = '{"label":"Say &quot;hi&quot; &amp; <b>","x":"&quot;"}';
    expect(render(model({ body }))).toContain(
      '<textarea id="mura-formdata" name="body">{"label":"Say \\"hi\\" &amp; <b>","x":"\\""}</textarea>',
    );
  });

  it('prefixes the configured context and admin directory to the builder URL', () => {
    useSettings({ MURA_CONTEXT: '/cms', MURA_ADMINDIR: '/manage' });
    expect(render(model({ body: '' }))).toContain('<div id="mura-templatebuilder" data-url="/cms/manage/">');
  });

  it('prints every label unencoded under its legacy key', () => {
    const keys: string[] = [];
    const rb: RbLookup = {
      locale: 'en',
      rbKey: (key) => {
        keys.push(key);
        return `<${key}> "&"`;
      },
      messageFormat: () => '',
    };
    const markup = render(model({ body: '' }), false, rb);
    const fields = ['textfield', 'textarea', 'hidden', 'radio', 'checkbox', 'dropdown', 'file', 'textblock', 'nested'];
    expect(keys).toEqual([
      ...fields.map((field) => `formbuilder.field.${field}.tooltip`),
      'formbuilder.form.tooltip',
      'formbuilder.form',
      'formbuilder.field.section.tooltip',
      'formbuilder.field.section',
      'formbuilder.fields.empty',
      'formbuilder.field.empty',
    ]);
    expect(markup).toContain(
      'title="<formbuilder.form.tooltip> "&""><span class="ui-button-text"><formbuilder.form> "&"</span>',
    );
    expect(markup).toContain(
      'id="button-radio" data-object="field-radio" title="<formbuilder.field.radio.tooltip> "&"">' +
        '<span class="ui-icon ui-icon-formfield ui-icon-formfield-radiobox"></span>',
    );
    expect(markup).toContain('<div id="mura-tb-field-empty" class="help-block"><formbuilder.field.empty> "&"</div>');
  });

  it.each<[string, EditPageData]>([
    ['a null body', model({ body: null })],
    ['an absent body', model({ title: 'New Form' })],
    ['a body under legacy key casing', model({ Body: '' }, 'contentbean')],
  ])('renders an empty textarea for %s', (_case, data) => {
    expect(render(data)).toContain('<textarea id="mura-formdata" name="body"></textarea>');
  });

  it.each<[string, EditPageData, string]>([
    ['no content bean', { rc: {} }, 'rc.contentBean is not a struct'],
    ['a content bean that is not a struct', model(['body']), 'rc.contentBean is not a struct'],
    ['a body that is not text', model({ body: { form: {} } }), 'rc.contentBean.body is not a string'],
  ])('rejects an edit model with %s', (_case, data, message) => {
    expect(() => render(data)).toThrow(new TypeError(message));
  });
});
