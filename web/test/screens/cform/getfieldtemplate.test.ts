// cform.getfieldtemplate against cform.cfc (198-201), formBuilderManager.getFieldTemplate (190-215) and getForms
// (349-368), field-nested.cfm and html.cfm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceBundles } from '@/lib/resource-bundles/rb';
import { getFieldTemplate, loadNestedFormOptions, renderNamedTemplate } from '@/screens/cform/getfieldtemplate';
import { renderFormBuilderTemplate, type NestedFormOption, type TemplateInput } from '@/screens/cform/templates';
import type { ScreenContext } from '@/screens/registry';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';
import { CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeCall, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

// Renders pass through unchanged; each keeps the input it received, so the loader handed to templates can be called.
const templateInputs = vi.hoisted((): TemplateInput[] => []);
vi.mock('@/screens/cform/templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/screens/cform/templates')>();
  return {
    ...actual,
    renderFormBuilderTemplate: (raw: string, input: TemplateInput): Promise<string> => {
      templateInputs.push(input);
      return actual.renderFormBuilderTemplate(raw, input);
    },
  };
});

const PATH = '/v1/raw/cform/getfieldtemplate';
const HTML = 'text/html;charset=UTF-8';
const SITE = 'tenant-a';
const FORM_ID = CONTENT_IDS.contactForm;

// getForms' rows for tenant-a without the current form: active forms by title.
const NESTED_FORMS: readonly NestedFormOption[] = [
  { contentID: '5C000000-0001-4000-8000000000000101', title: 'Event RSVP' },
  { contentID: '5C000000-0001-4000-8000000000000102', title: 'Newsletter Signup' },
  { contentID: '5C000000-0001-4000-8000000000000103', title: 'Q&A <Beta> Feedback' },
];

// field-nested.cfm's select as strategies-content answers it: CRLF line breaks, titles unescaped.
const NESTED_MARKUP = [
  '<span>',
  '\t\t\t\t\t\t\t<select name="formid" id="tb-formid">',
  ...NESTED_FORMS.map(({ contentID, title }) => `\t\t\t\t\t\t\t\t\t<option value="${contentID}">${title}</option>`),
  '\t\t\t\t\t\t\t</select>',
  '\t</span>',
].join('\r\n');

// strategies-content applies getForms' type, active and title-order rules itself; web names the site and the form.
const NESTED_CALL: FakeCall = {
  service: 'strategies-content',
  method: 'POST',
  path: PATH,
  query: { siteid: SITE },
  form: { fieldType: 'field-nested', formid: FORM_ID },
};

const rb = createResourceBundles(fixtureBundles).rbFor('en_US');
const loadForms = (): Promise<readonly NestedFormOption[]> => Promise.resolve(NESTED_FORMS);

let restore: () => void;
let gateway: FakeGatewayClient;

beforeEach(() => {
  restore = useTestEnv();
  gateway = fakeGatewayClient({
    [routeKey('POST', 'strategies-content', PATH)]: {
      status: 200,
      headers: { 'content-type': HTML },
      body: NESTED_MARKUP,
    },
  });
  templateInputs.length = 0;
});

afterEach(() => {
  restore();
});

/** A tenant-a site admin's `cform.getfieldtemplate` context carrying `rc`, the current form's `formid` posted. */
const contextFor = (rc: Readonly<Record<string, string>>): ScreenContext =>
  makeScreenContext({
    req: siteAdminRequest(SITE, { circuit: 'cform', item: 'getfieldtemplate', rc: { formid: FORM_ID, ...rc } }),
    gateway,
    rb,
  });

describe('getFieldTemplate', () => {
  it.each([
    ['field-textfield', 'field-textfield'],
    ['Field-Block!', 'field-block'],
  ])('answers fieldtype %j with the trimmed %s template', async (fieldtype, name) => {
    const body = await renderFormBuilderTemplate(name, { rb, loadForms });

    await expect(getFieldTemplate(contextFor({ fieldtype }))).resolves.toEqual({
      status: 200,
      contentType: HTML,
      body,
    });
    expect(gateway.calls).toEqual([]);
  });

  it('answers a missing template with the untrimmed legacy message', async () => {
    await expect(getFieldTemplate(contextFor({ fieldtype: 'nosuch' }))).resolves.toEqual({
      status: 200,
      contentType: HTML,
      body: rb.rbKey('formbuilder.missingfieldtemplatefile') + ': nosuch.cfm',
    });
    expect(gateway.calls).toEqual([]);
  });

  it('relays field-nested for the session site, excluding the posted formid', async () => {
    await expect(getFieldTemplate(contextFor({ fieldtype: 'field-nested' }))).resolves.toEqual({
      status: 200,
      contentType: HTML,
      body: NESTED_MARKUP,
    });
    expect(gateway.calls).toEqual([NESTED_CALL]);
  });

  it('lists the forms of session.siteid, not rc.siteid', async () => {
    const ctx = contextFor({ fieldtype: 'field-nested', siteid: 'tenant-b' });

    expect([ctx.req.session.siteid, ctx.req.rc.siteid]).toEqual([SITE, 'tenant-b']);
    await getFieldTemplate(ctx);
    expect(gateway.calls).toEqual([NESTED_CALL]);
  });
});

describe('renderNamedTemplate', () => {
  it.each(['field-textfield', 'Field-Block!', 'nosuch', 'field-nested'])(
    'renders %j as getFieldTemplate answers it',
    async (name) => {
      const ctx = contextFor({ fieldtype: name });
      const { body } = await getFieldTemplate(ctx);
      const calls = [...gateway.calls];
      gateway.reset();

      await expect(renderNamedTemplate(ctx, name)).resolves.toBe(body);
      expect(gateway.calls).toEqual(calls);
    },
  );

  it('hands local templates the session bundle and the nested-form loader', async () => {
    const ctx = contextFor({ fieldtype: 'field-textfield' });

    await getFieldTemplate(ctx);
    expect(gateway.calls).toEqual([]);
    expect(templateInputs).toHaveLength(1);
    const [input] = templateInputs;
    expect(input?.rb).toBe(ctx.rb);
    await expect(input?.loadForms()).resolves.toEqual(NESTED_FORMS);
    expect(gateway.calls).toEqual([NESTED_CALL]);
  });
});

describe('loadNestedFormOptions', () => {
  it('reads the forms in the order the service lists them', async () => {
    await expect(loadNestedFormOptions(contextFor({}))).resolves.toEqual(NESTED_FORMS);
    expect(gateway.calls).toEqual([NESTED_CALL]);
  });
});
