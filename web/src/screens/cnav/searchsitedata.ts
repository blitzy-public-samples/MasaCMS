// cnav.searchsitedata: the admin site-search JSON, relayed from strategies-content (server-only).
import { assertNotDenied } from '@/lib/gateway-client';
import type { RawBody, Rc, ScreenContext } from '../registry';

/** Legacy content type of `cnav.searchsitedata` (`cfcontent type="application/json"`). */
export const CNAV_SEARCHSITEDATA_CONTENT_TYPE = 'application/json';

const PATH = '/v1/raw/cnav/searchsitedata';

/** `rc` value by case-insensitive name, as a CFML scope reads it. */
function rcValue(rc: Rc, name: string): string | undefined {
  const direct = rc[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/**
 * `cnav.searchsitedata`: the service's site-search JSON with its status, content type and `Location`, bytes unchanged.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 * @throws GatewayDenialError When strategies-content refuses the request (401 or 403).
 */
export async function loadSearchSiteData(ctx: ScreenContext): Promise<RawBody> {
  const { rc } = ctx.req;
  const siteid = rcValue(rc, 'siteid');
  // Forwarded only when present, so the service reproduces legacy's failure on a missing searchString.
  const searchString = rcValue(rc, 'searchString');
  const facade = ctx.gateway.strategiesContent;
  // AdminRequest has no method; only a post carries a body, and FW/1 reads the field from either scope.
  const posted = ctx.body !== undefined;
  const response = posted
    ? await facade.raw('post', PATH, { query: { siteid }, form: searchString === undefined ? {} : { searchString } })
    : await facade.raw('get', PATH, {
        query: { siteid, params: searchString === undefined ? undefined : { searchString } },
      });
  // A denial answers with the legacy access-gate redirect, as the other raw relays do, never as a relayed 401 or 403.
  assertNotDenied(response, 'strategies-content', `${posted ? 'POST' : 'GET'} ${PATH}`);
  const contentType = [response.headers['content-type'] ?? []].flat()[0];
  return {
    status: response.status,
    // A service answer without a content type carries the action's legacy one.
    contentType: contentType ?? CNAV_SEARCHSITEDATA_CONTENT_TYPE,
    body: response.body,
    ...(response.location === undefined ? {} : { headers: { location: response.location } }),
  };
}
