// cform.getdialog against cform.cfc (161-163), formBuilderManager.getDialog, html.cfm and the service contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { getDialog } from '@/screens/cform/getdialog';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type Fields = Readonly<Record<string, string>>;

const PATH = '/v1/raw/cform/getfieldtemplate';
const ROUTE = routeKey('POST', 'strategies-content', PATH);
const OPERATION = 'raw_cform_getfieldtemplate_post';
const HTML = 'text/html;charset=UTF-8';
const FORM_ID = '9A1B2C3D-4E5F-4061-8293A4B5C6D7E8F9';
const MISSING = 'formbuilder.missingfieldtemplatefile_missing';

// field-nested.cfm's select as strategies-content relays it: CRLF line breaks, titles unescaped.
const NESTED = [
  '<span>',
  '\t\t\t\t\t\t\t<select name="formid" id="tb-formid">',
  '\t\t\t\t\t\t\t\t\t<option value="2B7E4A10-5C3D-4E8F-9A1B2C3D4E5F6071">R&D <b>Intake</b> #2</option>',
  '\t\t\t\t\t\t\t</select>',
  '\t</span>',
].join('\r\n');

const nestedReply = (body: string): FakeReply => ({ status: 200, headers: { 'content-type': HTML }, body });

const denial = (status: number): Readonly<Record<string, unknown>> => ({
  service: 'strategies-content',
  operation: OPERATION,
  status,
});

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The screen context of an S2 `cform.getdialog` POST carrying `rc`, over `gateway`. */
const contextFor = (rc: Fields, gateway: FakeGatewayClient = fakeGatewayClient()): ScreenContext =>
  makeScreenContext({ req: adminS2Request({ circuit: 'cform', item: 'getdialog', rc }), gateway });

describe('getDialog', () => {
  // Bodies as the legacy oracle answered each templatebuilder dialog request.
  it.each([
    ['message-delete-row', '<span>Delete Row?</span>'],
    ['MESSAGE-DELETE-ROW', '<span>Delete Row?</span>'],
    ['message-dataset-sourcerequired', '<span>You must specify a source</span>'],
    ['message-dataset-new', `${MISSING}: message-dataset-new.cfm`],
  ])('answers dialog %j locally with legacy markup', async (dialog, body) => {
    const gateway = fakeGatewayClient();

    await expect(getDialog(contextFor({ dialog }, gateway))).resolves.toEqual({ status: 200, contentType: HTML, body });
    expect(gateway.calls).toEqual([]);
  });

  it.each<[string, Fields, Fields]>([
    ['with formid', { dialog: 'field-nested', formid: FORM_ID }, { fieldType: 'field-nested', formid: FORM_ID }],
    ['by its raw name, without formid', { Dialog: 'Field-Nested!' }, { fieldType: 'Field-Nested!' }],
  ])('relays field-nested %s from strategies-content for the session site', async (_label, rc, form) => {
    const gateway = fakeGatewayClient({ [ROUTE]: nestedReply(NESTED) });

    const result = await getDialog(contextFor({ ...rc, siteid: 'tenant-b' }, gateway));

    expect(result).toEqual({ status: 200, contentType: HTML, body: NESTED });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: PATH, query: { siteid: 'default' }, form },
    ]);
  });

  it('fails without rc.dialog, as legacy does, calling nothing', async () => {
    const gateway = fakeGatewayClient();

    await expect(getDialog(contextFor({ fieldtype: 'field-nested' }, gateway))).rejects.toThrow(
      new TypeError('Element DIALOG is undefined in RC.'),
    );
    expect(gateway.calls).toEqual([]);
  });

  it.each<[string, FakeReply, abstract new (...args: never[]) => Error, Readonly<Record<string, unknown>>]>([
    ['401', { status: 401, body: '' }, GatewayDenialError, denial(401)],
    ['403', { status: 403, body: '' }, GatewayDenialError, denial(403)],
    [
      '500',
      { ...nestedReply('<h1>500 Error</h1>'), status: 500 },
      Error,
      { message: `${OPERATION} answered HTTP 500` },
    ],
    ['503', { status: 503, body: '' }, GatewayUnavailableError, { service: 'strategies-content', status: 503 }],
  ])('rejects a field-nested answer of HTTP %s', async (_status, reply, type, fields) => {
    const gateway = fakeGatewayClient({ [ROUTE]: reply });

    const error = await getDialog(contextFor({ dialog: 'field-nested' }, gateway)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject(fields);
  });
});
