// cChangesets.loadtagarray against cchangesets/loadtagarray.cfm: the owner's tag-array bytes, relayed unchanged.
import { describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { changesetLoadTagArrayScreen } from '@/screens/cchangesets/loadtagarray';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const PATH = '/v1/raw/cchangesets/loadtagarray';
const ROUTE = routeKey('GET', 'strategies-content', PATH);
// The view's default content type, as the ACF 2023 oracle sends it.
const VIEW_TYPE = 'text/html;charset=UTF-8';
// The oracle's answer for `default`, which has no tags.
const NO_TAGS = '[]';
// Two tags as the view writes them, each `esapiEncode('javascript')`-encoded.
const TWO_TAGS =
  "[{id: 'Caf\\xE9', toString: function() { return 'Caf\\xE9'; } }," +
  "{id: 'O\\x27Brien', toString: function() { return 'O\\x27Brien'; } }]";

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const tagRequest = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  adminS2Request({ circuit: 'cChangesets', item: 'loadtagarray', rc });

/** The owner's 200 answer of `body` under the view content type. */
const viewReply = (body: string): FakeReply => ({ status: 200, headers: { 'content-type': VIEW_TYPE }, body });

const render = async (gateway: FakeGatewayClient, req: AdminRequest = tagRequest()): Promise<RawBody> =>
  changesetLoadTagArrayScreen.render(contextFor(req, gateway), undefined);

/** The relayed body as text, which the screen hands over as bytes. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

describe('cChangesets.loadtagarray', () => {
  it.each<{ name: string; rc: Readonly<Record<string, string>> }>([
    { name: 'the session site', rc: {} },
    { name: 'a requested site and extra fields', rc: { siteid: 'tenant-a', keywords: 'a b', tags: 'News' } },
  ])('asks for $name with every rc field as a url field', async ({ rc }) => {
    const gateway = fakeGatewayClient({ [ROUTE]: viewReply(NO_TAGS) });
    const req = tagRequest(rc);

    await render(gateway, req);

    const query = Object.fromEntries(Object.entries(req.rc));
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: PATH, query }]);
    expect(query).toMatchObject({ siteid: rc.siteid ?? 'default', muraAction: 'core:cchangesets.loadtagarray' });
  });

  it.each<{ name: string; reply: FakeReply; text: string }>([
    { name: 'the empty array', reply: viewReply(NO_TAGS), text: NO_TAGS },
    { name: 'encoded tags', reply: viewReply(TWO_TAGS), text: TWO_TAGS },
    {
      name: 'a legacy error envelope',
      reply: { status: 401, headers: { 'content-type': 'application/json;charset=utf-8' }, body: '{"error":"x"}' },
      text: '{"error":"x"}',
    },
  ])('relays $name with its status, content type and bytes unchanged', async ({ reply, text }) => {
    const raw = await render(fakeGatewayClient({ [ROUTE]: reply }));

    expect({ status: raw.status, contentType: raw.contentType, body: bodyText(raw) }).toEqual({
      status: reply.status,
      contentType: reply.headers?.['content-type'],
      body: text,
    });
    expect(raw.headers).toBeUndefined();
  });

  it('fails on an answer without a Content-Type', async () => {
    await expect(render(fakeGatewayClient({ [ROUTE]: { status: 200, body: NO_TAGS } }))).rejects.toThrow(
      `strategies-content answered ${PATH} without a Content-Type`,
    );
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    {
      outage: 'a 503 answer',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(ROUTE, { status: 503, body: {} }),
    },
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(render(gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
