// cFeed.loadSite: the collection content-filter search fragment strategies-content renders, relayed (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { cfeedGate } from './before';

const LOADSITE_PATH = '/v1/raw/cfeed/loadsite';
const OPERATION = `GET ${LOADSITE_PATH}`;

/** `cFeed.loadSite` (`request.layout=false`): the service's status, content type and bytes, unchanged. */
export const cfeedLoadSiteScreen: FragmentScreen = Object.freeze({
  circuit: 'cfeed',
  action: 'loadsite',
  mode: 'fragment',
  owner: 'strategies-content',
  gate: cfeedGate,
  async render(ctx: ScreenContext): Promise<RawBody> {
    // Every rc field (siteid, keywords, isNew, contentPoolID, compactDisplay, cacheid among them) travels as a url
    // field under its legacy name; the service applies the view's own defaults.
    const response = await ctx.gateway.strategiesContent.raw('get', LOADSITE_PATH, {
      query: { params: { ...ctx.req.rc } },
    });
    assertNotDenied(response, 'strategies-content', OPERATION);
    const contentType = [response.headers['content-type'] ?? []].flat()[0];
    if (contentType === undefined) {
      throw new TypeError(`strategies-content answered ${OPERATION} without a Content-Type`);
    }
    return { status: response.status, contentType, body: response.body };
  },
});
