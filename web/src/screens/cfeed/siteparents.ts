// cFeed.siteParents: the collection parent-search fragment strategies-content renders, relayed unchanged (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { applyCfeedDefaults, cfeedGate } from './before';

const PATH = '/v1/raw/cfeed/siteparents';
const OPERATION = `GET ${PATH}`;

/** The `feedManager.loadSiteParents` fields forwarded besides `siteid`, which is the contract's own parameter. */
const FORWARDED_FIELDS = ['parentid', 'keywords', 'isNew', 'compactDisplay', 'cacheid'] as const;

/** `cFeed.siteParents`: the new-parent search box and radio list of the collection edit screen, bytes as sent. */
export const cfeedSiteParentsScreen: FragmentScreen = Object.freeze({
  circuit: 'cfeed',
  action: 'siteparents',
  mode: 'fragment',
  owner: 'strategies-content',
  gate: cfeedGate,
  async render(ctx: ScreenContext): Promise<RawBody> {
    // The rc after cfeed `before()`, read case-insensitively; only present fields go, so the service applies the view's
    // own `cfparam` defaults exactly as legacy does.
    const rc = applyCfeedDefaults(ctx.req.rc);
    const params: Record<string, string> = {};
    for (const name of FORWARDED_FIELDS) {
      const value = rc[name];
      if (value !== undefined) params[name] = value;
    }
    const response = await ctx.gateway.strategiesContent.raw('get', PATH, { query: { siteid: rc.siteid, params } });
    assertNotDenied(response, 'strategies-content', OPERATION);
    const contentType = [response.headers['content-type'] ?? []].flat()[0];
    if (contentType === undefined) {
      throw new TypeError(`strategies-content answered ${OPERATION} without a Content-Type`);
    }
    return { status: response.status, contentType, body: response.body };
  },
});
