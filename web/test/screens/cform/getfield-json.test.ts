// cform.getField relay against cform.cfc getField(), json.cfm and the strategies-content contract.
import { describe, expect, it } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { getField } from '@/screens/cform/getfield';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const PATH = '/v1/raw/cform/getfield';
const ROUTE = routeKey('POST', 'strategies-content', PATH);
const LEGACY_JSON = 'application/json;charset=utf-8';
const FIELD_ID = '11111111-2222-3333-4444555566667777';
const FORM_ID = 'AAAAAAAA-2222-3333-4444555566667777';
// Legacy's answer for this field: key case and order a re-serialisation would not keep.
const FIELD_JSON =
  `{"fieldid":"${FIELD_ID}","sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
  '"fieldtype":{"fieldtypeid":"25416CAD-C1A2-79C8-9392076545424987","islong":0,"datecreate":"",' +
  '"fieldtype":"textfield","IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"",' +
  '"displaytype":"field","bean":"","isdata":0,"label":""},"relatedid":"","rblabel":"","value":"","config":{},' +
  '"isrequired":0,"label":"New Text Field","type":"COMMON","fieldtypeid":"","datecreate":"","cssstyle":"",' +
  `"datelastupdate":"","validateregex":"","isactive":1,"formid":"${FORM_ID}","name":"","placeholder":"",` +
  '"islocked":0,"validatetype":"","datasetid":"","remoteid":"","tooltip":"","isdeleted":0,"orderno":0,' +
  '"isentrytype":"SINGLE","params":""}';
const FIELD_REPLY: FakeReply = { status: 200, headers: { 'content-type': LEGACY_JSON }, body: FIELD_JSON };

/** A context for `rc` over `gateway`; getField reads only the request and the gateway. */
function contextFor(rc: Fields, gateway: FakeGatewayClient): ScreenContext {
  const ctx: Pick<ScreenContext, 'req' | 'gateway'> = {
    req: adminS2Request({ circuit: 'cform', item: 'getfield', rc }),
    gateway,
  };
  return ctx as ScreenContext;
}

/** The relayed bytes as text. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

describe('getField', () => {
  it.each<[string, Fields, string, Fields]>([
    [
      'all three fields',
      { fieldID: FIELD_ID, formID: FORM_ID, fieldType: 'field-textarea' },
      'default',
      { fieldID: FIELD_ID, formID: FORM_ID, fieldType: 'field-textarea' },
    ],
    [
      'lower-cased names under their legacy names',
      { fieldid: FIELD_ID, formid: FORM_ID, fieldtype: 'field-radio', siteid: 'tenant-b' },
      'tenant-b',
      { fieldID: FIELD_ID, formID: FORM_ID, fieldType: 'field-radio' },
    ],
    ['only formID, leaving both defaults to the service', { formID: FORM_ID }, 'default', { formID: FORM_ID }],
    [
      'an empty fieldType, which legacy keeps',
      { formID: FORM_ID, fieldType: '' },
      'default',
      { formID: FORM_ID, fieldType: '' },
    ],
    ['no field at all', {}, 'default', {}],
  ])('forwards %s with rc.siteid', async (_label, rc, siteid, form) => {
    const gateway = fakeGatewayClient({ [ROUTE]: FIELD_REPLY });

    await getField(contextFor(rc, gateway));

    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: PATH, query: { siteid }, form },
    ]);
  });

  it.each<[string, FakeReply, string]>([
    ['the field JSON', FIELD_REPLY, LEGACY_JSON],
    [
      "legacy's missing-formID error page",
      {
        status: 500,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
        body: '<h2>Element RC.formID is undefined in ARGUMENTS.<br /></h2>',
      },
      'text/html;charset=UTF-8',
    ],
    [
      'a non-denial 4xx',
      { status: 404, headers: { 'content-type': LEGACY_JSON }, body: '{"error":"not_found"}' },
      LEGACY_JSON,
    ],
    ['an answer without a content type, with an empty one', { status: 200, body: FIELD_JSON }, ''],
    [
      'the first of repeated content types',
      // undici reports a repeated header as an array, which the fake's single-valued reply type cannot spell.
      { status: 200, headers: { 'content-type': [LEGACY_JSON, 'text/plain'] } as unknown as Fields, body: FIELD_JSON },
      LEGACY_JSON,
    ],
  ])('relays %s with its status and bytes unchanged', async (_label, reply, contentType) => {
    const gateway = fakeGatewayClient({ [ROUTE]: reply });

    const raw = await getField(contextFor({ fieldID: FIELD_ID, formID: FORM_ID }, gateway));

    expect({ status: raw.status, contentType: raw.contentType, body: bodyText(raw) }).toEqual({
      status: reply.status,
      contentType,
      body: reply.body,
    });
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i instead of relaying it', async (status) => {
    const gateway = fakeGatewayClient({ [ROUTE]: { status, headers: { 'content-type': LEGACY_JSON }, body: '{}' } });

    const error = await getField(contextFor({ formID: FORM_ID }, gateway)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', status, operation: `POST ${PATH}` });
  });

  it.each<[string, (gateway: FakeGatewayClient) => void]>([
    ['an unreachable gateway', (gateway) => gateway.failWith()],
    ['a 503 answer', (gateway) => gateway.setRoute(ROUTE, { status: 503, body: '' })],
  ])('propagates unavailability from %s', async (_label, arrange) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(getField(contextFor({ formID: FORM_ID }, gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
