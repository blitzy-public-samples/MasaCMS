// cform's JSON actions against cform.cfc (165-210) and json.cfm: parameters as received, the service's answer as sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayResponse, HttpMethod, ServicePath } from '@/lib/gateway-client';
import { getDataset } from '@/screens/cform/getdataset';
import { getField } from '@/screens/cform/getfield';
import { getFieldType } from '@/screens/cform/getfieldtype';
import { getForm } from '@/screens/cform/getform';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import {
  FORM_DATASET_IDS,
  FORM_FIELD_IDS,
  getDatasetRelay,
  getFormRelay,
} from '../../fixtures/strategies-content/forms';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeCall, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type Fields = Readonly<Record<string, string>>;
type JsonAction = (ctx: ScreenContext) => Promise<RawBody>;

/** A relay reply with one content type and a text body, as forms.ts records them. */
type TextRelay = Pick<GatewayResponse<string>, 'status' | 'body'> & {
  readonly headers: { readonly 'content-type': string };
};

interface CformOperation {
  readonly method: HttpMethod;
  readonly item: string;
  readonly path: ServicePath;
}

const SERVICE = 'strategies-content';
const SITE_ID = 'tenant-a';
const FORM_ID = CONTENT_IDS.contactForm;
const FIELD_ID = FORM_FIELD_IDS.topic;
const DATASET_ID = FORM_DATASET_IDS.topicOptions;
const FIELD_TYPE_ID = '5C000000-000D-4000-80000000000000F4';
// json.cfm's `application/json; charset=utf-8` as ACF sends it, the form the contract and forms.ts declare.
const LEGACY_JSON = 'application/json;charset=utf-8';

// Set-up, browser and stray fields the request carries beside the documented ones; no relay forwards them.
const EXTRAS: Fields = { csrf_token: FIXED_CSRF.token, compactDisplay: 'true', unrelated: 'ignored' };

const operation = (method: HttpMethod, item: string): CformOperation => ({
  method,
  item,
  path: `/v1/raw/cform/${item}`,
});

const GET_FORM = operation('POST', 'getform');
const GET_FIELD = operation('POST', 'getfield');
const GET_FIELD_TYPE = operation('GET', 'getfieldtype');
const GET_DATASET = operation('POST', 'getdataset');

const FIELD_TYPE_JSON =
  `{"fieldtypeid":"${FIELD_TYPE_ID}","islong":0,"datecreate":"","fieldtype":"dropdown","IsMultiSelect":0,` +
  '"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":1,"label":""}';

const getFieldRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': LEGACY_JSON },
  body:
    `{"fieldid":"${FIELD_ID}","sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
    `"fieldtype":${FIELD_TYPE_JSON},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":1,` +
    `"label":"Topic","type":"COMMON","fieldtypeid":"${FIELD_TYPE_ID}","formid":"${FORM_ID}","name":"topic",` +
    `"datasetid":"${DATASET_ID}","orderno":4,"isentrytype":"SINGLE","params":""}`,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

// é and U+2028 as raw UTF-8 and `\/` escapes, none of which a parse and re-serialisation would keep.
const getFieldUnicodeRelay = {
  ...getFieldRelay,
  body:
    `{"fieldid":"${FORM_FIELD_IDS.message}","label":"R\u00e9sum\u00e9\u2028note","tooltip":"<\\/textarea>",` +
    `"formid":"${FORM_ID}","action":"https:\\/\\/localhost\\/forms"}`,
} as const satisfies GatewayResponse<string>;

const getFieldTypeRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': LEGACY_JSON },
  body: FIELD_TYPE_JSON,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

const getFieldTypeErrorRelay = {
  status: 500,
  ok: false,
  headers: { 'content-type': LEGACY_JSON },
  body:
    `{"apiversion":"v1","method":"getFieldType","params":{"siteid":"${SITE_ID}"},` +
    '"error":{"code":"server_error","message":"Unhandled Exception"}}',
  setCookies: [],
} as const satisfies GatewayResponse<string>;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** Runs `action` for an S2 `cform.<item>` request carrying `rc` and {@link EXTRAS}, the service answering `reply`. */
async function relay(
  action: JsonAction,
  op: CformOperation,
  rc: Fields,
  reply: FakeReply,
): Promise<{ readonly raw: RawBody; readonly calls: readonly FakeCall[] }> {
  const gateway = fakeGatewayClient({ [routeKey(op.method, SERVICE, op.path)]: reply });
  const req = adminS2Request({
    circuit: 'cform',
    item: op.item,
    rc: { siteid: SITE_ID, ...rc, muraAction: `cform.${op.item}`, ...EXTRAS },
  });
  const raw = await action(makeScreenContext({ req, gateway }));
  return { raw, calls: gateway.calls };
}

/** The RawBody a byte-exact relay of `reply` answers. */
function relayedAs(reply: TextRelay): RawBody {
  return { status: reply.status, contentType: reply.headers['content-type'], body: Buffer.from(reply.body, 'utf8') };
}

describe('getForm', () => {
  it.each<[string, Fields, Fields]>([
    ['siteid and formID only', { formID: FORM_ID }, { formID: FORM_ID }],
    ['siteid without formID', {}, {}],
  ])('forwards %s', async (_label, rc, form) => {
    const { calls } = await relay(getForm, GET_FORM, rc, getFormRelay);

    expect(calls).toEqual([
      { service: SERVICE, method: 'POST', path: GET_FORM.path, query: { siteid: SITE_ID }, form },
    ]);
  });

  it('relays getFormRelay unchanged', async () => {
    const { raw } = await relay(getForm, GET_FORM, { formID: FORM_ID }, getFormRelay);

    expect(raw).toEqual(relayedAs(getFormRelay));
  });
});

describe('getField', () => {
  it.each<[string, Fields, Fields]>([
    [
      'siteid, fieldID, formID and fieldType only',
      { fieldID: FIELD_ID, formID: FORM_ID, fieldType: 'field-dropdown' },
      { fieldID: FIELD_ID, formID: FORM_ID, fieldType: 'field-dropdown' },
    ],
    ['formID without fieldID or fieldType', { formID: FORM_ID }, { formID: FORM_ID }],
  ])('forwards %s', async (_label, rc, form) => {
    const { calls } = await relay(getField, GET_FIELD, rc, getFieldRelay);

    expect(calls).toEqual([
      { service: SERVICE, method: 'POST', path: GET_FIELD.path, query: { siteid: SITE_ID }, form },
    ]);
  });

  it.each<[string, TextRelay]>([
    ['the field JSON', getFieldRelay],
    ['non-ASCII text and escaped slashes', getFieldUnicodeRelay],
  ])('relays %s unchanged', async (_label, reply) => {
    const { raw } = await relay(getField, GET_FIELD, { fieldID: FIELD_ID, formID: FORM_ID }, reply);

    expect(raw).toEqual(relayedAs(reply));
  });
});

describe('getFieldType', () => {
  it.each<[string, Fields, Fields]>([
    [
      'siteid, fieldTypeID and fieldType only',
      { fieldTypeID: FIELD_TYPE_ID, fieldType: 'field-dropdown' },
      { siteid: SITE_ID, fieldTypeID: FIELD_TYPE_ID, fieldType: 'field-dropdown' },
    ],
    ['siteid without fieldTypeID or fieldType', {}, { siteid: SITE_ID }],
  ])('forwards %s', async (_label, rc, query) => {
    const { calls } = await relay(getFieldType, GET_FIELD_TYPE, rc, getFieldTypeRelay);

    expect(calls).toEqual([{ service: SERVICE, method: 'GET', path: GET_FIELD_TYPE.path, query }]);
  });

  it.each<[string, TextRelay]>([
    ['the field-type JSON', getFieldTypeRelay],
    ['a 500 with its legacy error body', getFieldTypeErrorRelay],
  ])('relays %s unchanged', async (_label, reply) => {
    const { raw } = await relay(getFieldType, GET_FIELD_TYPE, { fieldTypeID: FIELD_TYPE_ID }, reply);

    expect(raw).toEqual(relayedAs(reply));
  });
});

describe('getDataset', () => {
  it.each<[string, Fields, Fields]>([
    [
      'datasetID and fieldID only',
      { datasetID: DATASET_ID, fieldID: FIELD_ID },
      { datasetID: DATASET_ID, fieldID: FIELD_ID },
    ],
    ['empty datasetID', { datasetID: '', fieldID: FIELD_ID }, { datasetID: '', fieldID: FIELD_ID }],
    ['no datasetID', { fieldID: FIELD_ID }, { fieldID: FIELD_ID }],
  ])('forwards %s', async (_label, rc, form) => {
    const { calls } = await relay(getDataset, GET_DATASET, rc, getDatasetRelay);

    expect(calls).toEqual([
      { service: SERVICE, method: 'POST', path: GET_DATASET.path, query: { siteid: SITE_ID }, form },
    ]);
  });

  it('relays getDatasetRelay unchanged', async () => {
    const { raw } = await relay(getDataset, GET_DATASET, { datasetID: DATASET_ID, fieldID: FIELD_ID }, getDatasetRelay);

    expect(raw).toEqual(relayedAs(getDatasetRelay));
  });
});
