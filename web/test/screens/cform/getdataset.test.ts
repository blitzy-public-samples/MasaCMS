// Tests of the cform.getdataset relay to strategies-content, against the in-memory gateway client.
import { describe, expect, it } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { getDataset } from '@/screens/cform/getdataset';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeReply, type FakeGatewayClient } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const PATH = '/v1/raw/cform/getdataset';
const ROUTE = routeKey('POST', 'strategies-content', PATH);
const LEGACY_JSON_TYPE = 'application/json; charset=utf-8';
const FIELD_ID = '4F1C2B3A-9D8E-4C7B-A6F5E4D3C2B1A090';
// Spacing and key order a parse and re-serialize would not keep.
const DATASET_JSON =
  '{"datasetid":"7A2B3C4D-5E6F-4A1B-8C9D0E1F2A3B4C5D", "fieldid":"4F1C2B3A-9D8E-4C7B-A6F5E4D3C2B1A090",' +
  '"issortable":0,"model":{"datarecordid":"","DATASETID":"7A2B3C4D-5E6F-4A1B-8C9D0E1F2A3B4C5D"},' +
  '"sourcetype":"entered"}';

/** A context for `rc` over `gateway`; getDataset reads only the request and the gateway. */
function contextFor(rc: Fields, gateway: FakeGatewayClient): ScreenContext {
  const ctx: Pick<ScreenContext, 'req' | 'gateway'> = {
    req: adminS2Request({ circuit: 'cform', item: 'getdataset', rc }),
    gateway,
  };
  return ctx as ScreenContext;
}

/** The text of a relayed body, which the relay hands over as bytes. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

describe('getDataset', () => {
  it.each<{ name: string; rc: Fields; form: Fields }>([
    {
      name: 'an empty datasetID',
      rc: { datasetID: '', fieldID: FIELD_ID },
      form: { datasetID: '', fieldID: FIELD_ID },
    },
    { name: 'no datasetID', rc: { fieldID: FIELD_ID }, form: { fieldID: FIELD_ID } },
    {
      name: 'a stored datasetID in other casing',
      rc: { DATASETID: '7A2B3C4D-5E6F-4A1B-8C9D0E1F2A3B4C5D', fieldid: FIELD_ID },
      form: { datasetID: '7A2B3C4D-5E6F-4A1B-8C9D0E1F2A3B4C5D', fieldID: FIELD_ID },
    },
    { name: 'neither field', rc: {}, form: {} },
  ])('forwards $name as sent, with the siteid', async ({ rc, form }) => {
    const gateway = fakeGatewayClient({
      [ROUTE]: { status: 200, headers: { 'content-type': LEGACY_JSON_TYPE }, body: DATASET_JSON },
    });

    await getDataset(contextFor(rc, gateway));

    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: PATH, query: { siteid: 'default' }, form },
    ]);
  });

  it.each<{ name: string; reply: FakeReply }>([
    {
      name: 'the dataset JSON',
      reply: { status: 200, headers: { 'content-type': LEGACY_JSON_TYPE }, body: DATASET_JSON },
    },
    {
      name: 'a legacy error envelope',
      reply: {
        status: 500,
        headers: { 'content-type': 'application/json;charset=utf-8' },
        body: '{"apiversion":"v1","method":"getdataset","error":{"type":"server_error"}}',
      },
    },
  ])('relays $name with its status, content type and bytes unchanged', async ({ reply }) => {
    const gateway = fakeGatewayClient({ [ROUTE]: reply });

    const raw = await getDataset(contextFor({ datasetID: '', fieldID: FIELD_ID }, gateway));

    expect({ status: raw.status, contentType: raw.contentType, body: bodyText(raw) }).toEqual({
      status: reply.status,
      contentType: reply.headers?.['content-type'],
      body: reply.body,
    });
  });

  it('propagates a 503 from the gateway as GatewayUnavailableError', async () => {
    const gateway = fakeGatewayClient({
      [ROUTE]: { status: 503, headers: { 'content-type': 'application/json;charset=utf-8' }, body: '{}' },
    });

    const error = await getDataset(contextFor({ fieldID: FIELD_ID }, gateway)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'strategies-content', status: 503 });
  });

  it('rejects an answer without a content type rather than inventing one', async () => {
    const gateway = fakeGatewayClient({ [ROUTE]: { status: 200, body: DATASET_JSON } });

    await expect(getDataset(contextFor({ fieldID: FIELD_ID }, gateway))).rejects.toThrow(
      'POST /v1/raw/cform/getdataset answered HTTP 200 without a content type',
    );
  });
});
