import type { GatewayResponse } from '@/lib/gateway-client';
import type { FragmentScreen, RawBody, ScreenContext } from '@/screens/registry';

const TAG_ARRAY_PATH = '/v1/raw/cchangesets/loadtagarray';

/** The service's `Content-Type`, exactly as sent. */
function contentTypeOf(response: GatewayResponse<Buffer>): string {
  const contentType = [response.headers['content-type'] ?? []].flat()[0];
  if (contentType === undefined) {
    throw new TypeError(`strategies-content answered ${TAG_ARRAY_PATH} without a Content-Type`);
  }
  return contentType;
}

/** `cChangesets.loadtagarray`: the site's tag cloud as legacy's JavaScript array literal, relayed byte for byte. */
export const changesetLoadTagArrayScreen: Omit<FragmentScreen, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'loadtagarray',
  mode: 'fragment',
  owner: 'strategies-content',
  async render(ctx: ScreenContext): Promise<RawBody> {
    // Every rc field, `siteid` included, travels as a url field as the contract's form-exploded params declare.
    const response = await ctx.gateway.strategiesContent.raw('get', TAG_ARRAY_PATH, {
      query: { params: { ...ctx.req.rc } },
    });
    return { status: response.status, contentType: contentTypeOf(response), body: response.body };
  },
});
