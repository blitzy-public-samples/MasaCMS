// cform.getfieldtemplate against cform.cfc, formBuilderManager.getFieldTemplate, html.cfm and the service contract.
import { describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { createResourceBundles } from '@/lib/resource-bundles/rb';
import { getFieldTemplate, loadNestedFormOptions } from '@/screens/cform/getfieldtemplate';
import type { ScreenContext } from '@/screens/registry';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const PATH = '/v1/raw/cform/getfieldtemplate';
const ROUTE = routeKey('POST', 'strategies-content', PATH);
const OPERATION = 'raw_cform_getfieldtemplate_post';
const HTML = 'text/html;charset=UTF-8';
const FORM_ID = '9A1B2C3D-4E5F-4061-8293A4B5C6D7E8F9';
const FORM_A = '2B7E4A10-5C3D-4E8F-9A1B2C3D4E5F6071';
const FORM_B = 'C0FFEE00-1A2B-3C4D-5E6F708192A3B4C5';
const MISSING = 'formbuilder.missingfieldtemplatefile_missing';

// The en.properties values of the two labels these templates print.
const rb = createResourceBundles({
  ...fixtureBundles,
  admin: {
    ...fixtureBundles.admin,
    files: {
      en: {
        entries: [
          ['formbuilder.dataset.rowdeleteconfirm', 'Delete Row?'],
          ['formbuilder.delete', 'Delete'],
        ],
      },
    },
  },
}).rbFor('en_US');

// field-nested.cfm's select as legacy prints it: CRLF line breaks, titles unescaped.
const NESTED = [
  '<span>',
  '\t\t\t\t\t\t\t<select name="formid" id="tb-formid">',
  `\t\t\t\t\t\t\t\t\t<option value="${FORM_A}">Volunteer Intake</option>`,
  `\t\t\t\t\t\t\t\t\t<option value="${FORM_B}">R&D <b>Intake</b> #2</option>`,
  '\t\t\t\t\t\t\t</select>',
  '\t</span>',
].join('\r\n');

// Legacy's trimmed field-block body, as cform.getfieldtemplate answered it.
const LEGACY_FIELD_BLOCK =
  '<li>\r\n\t\t\t<ul class="mura-tb-nav-utility">\r\n' +
  '\t\t\t\t<li><div id="button-trash" title="Delete"></div></li>\r\n' +
  '\t\t\t</ul>\r\n\t\t\t<div class="mura-tb-block">\r\n\t\t\t\t<span></span>\r\n\t\t\t</div>\r\n\t\t</li>';

const nestedReply = (body: string): FakeReply => ({ status: 200, headers: { 'content-type': HTML }, body });

/** The screen context of an S2 `cform.getfieldtemplate` request carrying `rc`, over `gateway`. */
function contextFor(rc: Fields, gateway: FakeGatewayClient): ScreenContext {
  return {
    req: adminS2Request({ circuit: 'cform', item: 'getfieldtemplate', rc }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

describe('getFieldTemplate', () => {
  it.each([
    ['message-delete-row', '<span>Delete Row?</span>'],
    ['MESSAGE-DELETE-ROW', '<span>Delete Row?</span>'],
    ['../message-delete-row', '<span>Delete Row?</span>'],
    // Line breaks as the admin DOM-model comparison reads them.
    ['field-block', LEGACY_FIELD_BLOCK.replaceAll('\r\n', '\n')],
    ['message delete-row', `${MISSING}: messagedelete-row.cfm`],
    ['Message_Delete_Row', `${MISSING}: messagedeleterow.cfm`],
    ['field-bogus', `${MISSING}: field-bogus.cfm`],
    ['constructor', `${MISSING}: constructor.cfm`],
    ['', `${MISSING}: .cfm`],
  ])('answers fieldtype %j locally with legacy markup', async (fieldtype, body) => {
    const gateway = fakeGatewayClient();

    const result = await getFieldTemplate(contextFor({ fieldtype }, gateway));

    expect(result).toEqual({ status: 200, contentType: HTML, body });
    expect(gateway.calls).toEqual([]);
  });

  it.each<[string, Fields, Fields]>([
    ['with formid', { fieldtype: 'field-nested', formid: FORM_ID }, { fieldType: 'field-nested', formid: FORM_ID }],
    ['with an empty FORMID', { fieldType: 'field-nested', FORMID: '' }, { fieldType: 'field-nested', formid: '' }],
    ['by its raw name, without formid', { FieldType: 'Field-Nested!' }, { fieldType: 'Field-Nested!' }],
  ])('relays field-nested %s for the session site', async (_label, rc, form) => {
    const gateway = fakeGatewayClient({ [ROUTE]: nestedReply(NESTED) });

    const result = await getFieldTemplate(contextFor({ ...rc, siteid: 'tenant-b' }, gateway));

    expect(result).toEqual({ status: 200, contentType: HTML, body: NESTED });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: PATH, query: { siteid: 'default' }, form },
    ]);
  });

  it('fails without rc.fieldtype, as legacy does, calling nothing', async () => {
    const gateway = fakeGatewayClient();

    await expect(getFieldTemplate(contextFor({}, gateway))).rejects.toThrow(/fieldtype is undefined/i);
    expect(gateway.calls).toEqual([]);
  });

  it.each<[string, FakeReply, abstract new (...args: never[]) => Error, Readonly<Record<string, unknown>>]>([
    ['401', { status: 401, body: '' }, GatewayDenialError, { operation: OPERATION, status: 401 }],
    ['403', { status: 403, body: '' }, GatewayDenialError, { operation: OPERATION, status: 403 }],
    [
      '500',
      { ...nestedReply('<h1>500 Error</h1>'), status: 500 },
      Error,
      { message: `${OPERATION} answered HTTP 500` },
    ],
    ['503', { status: 503, body: '' }, GatewayUnavailableError, { service: 'strategies-content', status: 503 }],
  ])('rejects a field-nested answer of HTTP %s', async (_status, reply, type, fields) => {
    const gateway = fakeGatewayClient({ [ROUTE]: reply });

    const error = await getFieldTemplate(contextFor({ fieldtype: 'field-nested', formid: FORM_ID }, gateway)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject(fields);
  });
});

describe('loadNestedFormOptions', () => {
  it.each<[string, string, ReadonlyArray<{ contentID: string; title: string }>]>([
    [
      'every option, titles unescaped',
      NESTED,
      [
        { contentID: FORM_A, title: 'Volunteer Intake' },
        { contentID: FORM_B, title: 'R&D <b>Intake</b> #2' },
      ],
    ],
    [
      'a title up to its first </option>',
      `<option value="${FORM_A}">A</option>B</option>`,
      [{ contentID: FORM_A, title: 'A' }],
    ],
    [
      'a title across lines',
      `<option value="${FORM_B}">Line\r\nTwo</option>`,
      [{ contentID: FORM_B, title: 'Line\r\nTwo' }],
    ],
    ['no option of an empty select', '<select name="formid" id="tb-formid">\r\n</select>', []],
  ])('reads %s', async (_label, markup, options) => {
    const gateway = fakeGatewayClient({ [ROUTE]: nestedReply(markup) });

    expect(await loadNestedFormOptions(contextFor({ formid: FORM_ID }, gateway))).toEqual(options);
    expect(gateway.calls).toEqual([
      {
        service: 'strategies-content',
        method: 'POST',
        path: PATH,
        query: { siteid: 'default' },
        form: { fieldType: 'field-nested', formid: FORM_ID },
      },
    ]);
  });
});
