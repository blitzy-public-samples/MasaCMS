// cform.getForm relay against cform.cfc getForm(), json.cfm and the strategies-content contract.
import { describe, expect, it } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { getForm } from '@/screens/cform/getform';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const PATH = '/v1/raw/cform/getform';
const ROUTE = routeKey('POST', 'strategies-content', PATH);
const LEGACY_JSON = 'application/json;charset=utf-8';
const FORM_ID = '11111111-2222-3333-4444555566667777';
// Legacy's answer for this formID: key order a re-serialisation would not keep.
const FORM_JSON =
  '{"datecreate":"","fields":{},"pages":[],"statuscode":0,"datelastupdate":"","formattributes":{},"siteid":"",' +
  `"formid":"${FORM_ID}","isactive":0,"name":"","config":{},"notes":"","remoteid":"","iscurrent":0,"package":"",` +
  '"deletedfields":{},"fieldorder":[]}';
const FORM_REPLY: FakeReply = { status: 200, headers: { 'content-type': LEGACY_JSON }, body: FORM_JSON };

/** A context for `rc` over `gateway`; getForm reads only the request and the gateway. */
function contextFor(rc: Fields, gateway: FakeGatewayClient): ScreenContext {
  const ctx: Pick<ScreenContext, 'req' | 'gateway'> = {
    req: adminS2Request({ circuit: 'cform', item: 'getform', rc }),
    gateway,
  };
  return ctx as ScreenContext;
}

/** The relayed bytes as text. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

describe('getForm', () => {
  it.each<[string, Fields, string, Fields]>([
    ['formID', { formID: FORM_ID }, 'default', { formID: FORM_ID }],
    [
      'a lower-cased formid under its legacy name',
      { formid: FORM_ID, siteid: 'tenant-b' },
      'tenant-b',
      { formID: FORM_ID },
    ],
    ['an empty formID, which legacy keeps', { formID: '' }, 'default', { formID: '' }],
    ['no formID, leaving createUUID() to the service', {}, 'default', {}],
  ])('forwards %s with rc.siteid', async (_label, rc, siteid, form) => {
    const gateway = fakeGatewayClient({ [ROUTE]: FORM_REPLY });

    await getForm(contextFor(rc, gateway));

    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: PATH, query: { siteid }, form },
    ]);
  });

  it.each<[string, FakeReply, string]>([
    ['the form JSON', FORM_REPLY, LEGACY_JSON],
    [
      'a legacy error page',
      { status: 500, headers: { 'content-type': 'text/html;charset=UTF-8' }, body: '<h1>500 Error</h1>' },
      'text/html;charset=UTF-8',
    ],
    ['a denial', { status: 403, headers: { 'content-type': LEGACY_JSON }, body: '{"error":"forbidden"}' }, LEGACY_JSON],
    ['an answer without a content type, with an empty one', { status: 200, body: FORM_JSON }, ''],
    [
      'the first of repeated content types',
      // undici reports a repeated header as an array, which the fake's single-valued reply type cannot spell.
      { status: 200, headers: { 'content-type': [LEGACY_JSON, 'text/plain'] } as unknown as Fields, body: FORM_JSON },
      LEGACY_JSON,
    ],
  ])('relays %s with its status and bytes unchanged', async (_label, reply, contentType) => {
    const gateway = fakeGatewayClient({ [ROUTE]: reply });

    const raw = await getForm(contextFor({ formID: FORM_ID }, gateway));

    expect({ status: raw.status, contentType: raw.contentType, body: bodyText(raw) }).toEqual({
      status: reply.status,
      contentType,
      body: reply.body,
    });
  });

  it.each<[string, (gateway: FakeGatewayClient) => void]>([
    ['an unreachable gateway', (gateway) => gateway.failWith()],
    ['a 503 answer', (gateway) => gateway.setRoute(ROUTE, { status: 503, body: '' })],
  ])('propagates unavailability from %s', async (_label, arrange) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(getForm(contextFor({}, gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
