/** cnav admin routes: site-switcher search data. */
import { AuthDenial, Roles } from '@opt2/platform/auth';
import {
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  legacyParamsOf,
  z,
  type FastifyInstance,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registeredTenants } from '@opt2/platform/tenancy';
import type { Actor } from '../../domain/context.js';
import { searchSiteData, type SiteListRow } from '../../domain/search.js';
import { renderSearchSiteDataJson } from '../../legacy/admin-render-comments.js';
import type { AdminRenderResult } from '../../legacy/admin-render.js';
import type { ContentRouteContext } from '../index.js';

/** Where `session.siteArray` and the site names come from: identity's `listCurrentSessionSites`. */
export const SITE_ARRAY_SOURCE: 'identity' | 'unavailable' = 'identity';

const SESSION_SITES_PATH = '/v1/sessions/current/sites';

/** identity `SessionSites`: the session's `siteArray` with each site's name. */
const SESSION_SITES = z.object({ sites: z.array(z.object({ siteID: z.string(), site: z.string() })) });

type SessionSite = z.infer<typeof SESSION_SITES>['sites'][number];

/** `rc.searchString` as getUserSites' string argument; a missing key fails as CFML reading an undefined element. */
function searchStringOf(request: FastifyRequest): string {
  const rc = legacyParamsOf(request);
  const key = Object.keys(rc).find((name) => name.toLowerCase() === 'searchstring');
  const value = key === undefined ? undefined : rc[key];
  if (value === undefined) throw new Error('Element SEARCHSTRING is undefined in RC.');
  if (typeof value !== 'string') {
    throw new TypeError('The SEARCHSTRING argument passed to the getUserSites function is not of type string.');
  }
  return value;
}

/**
 * The request session's `siteArray` with site names, read from identity with the forwarded user token.
 * @throws AuthDenial When identity refuses the session's sites (401 or 403).
 * @throws ServiceUnavailableError When identity is unreachable or answers otherwise.
 */
async function sessionSites(request: FastifyRequest): Promise<SessionSite[]> {
  const response = await request.server.opt2.client.request({
    service: IDENTITY_SERVICE,
    method: 'GET',
    path: SESSION_SITES_PATH,
  });
  if (response.status === 401) throw AuthDenial.unauthenticated('invalid-credential');
  if (response.status === 403) throw AuthDenial.forbidden();
  if (response.status < 200 || response.status > 299) {
    const cause = Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${response.status}`), {
      code: `HTTP_${response.status}`,
    });
    throw new ServiceUnavailableError(IDENTITY_SERVICE, cause);
  }
  const parsed = SESSION_SITES.safeParse(response.body);
  if (!parsed.success) throw new ServiceUnavailableError(IDENTITY_SERVICE, parsed.error);
  return parsed.data.sites;
}

/** cnav.searchsitedata (cnav.cfc:10-18, searchsitedata.cfm): getUserSites(session.siteArray, isS2, rc.searchString, -1) as legacy JSON. */
async function searchSiteDataAction(
  request: FastifyRequest,
  ctx: ContentRouteContext,
  actor: Actor,
): Promise<AdminRenderResult> {
  const searchString = searchStringOf(request);
  const isS2 = actor.s2 || actor.roles.includes(Roles.s2);
  // A session that is not logged in keeps an empty siteArray (admin/Application.cfc:455-457); identity holds none to read.
  const listed = actor.isLoggedIn && actor.userId !== '' ? await sessionSites(request) : [];
  const names = new Map(listed.map(({ siteID, site }) => [siteID, site]));
  // Only sites both this service's registry and identity hold are listed: no other verified source names a site.
  const sites: SiteListRow[] = [];
  for (const { siteId } of await registeredTenants(ctx.domain.db)) {
    const site = names.get(siteId);
    if (site !== undefined) sites.push({ siteid: siteId, site });
  }
  const userSiteIds = listed.map(({ siteID }) => siteID);
  return renderSearchSiteDataJson(searchSiteData({ sites, userSiteIds, isS2, searchString }));
}

/** The raw cnav actions `./raw.ts` serves; legacy validates no CSRF token here, so none declares a `csrfContext`. */
export const cnavRawActions = Object.freeze({
  searchsitedata: Object.freeze({ run: searchSiteDataAction }),
});

/** cnav admin routes: site-switcher search data. */
export async function registerNavRoutes(_app: FastifyInstance, _ctx: ContentRouteContext): Promise<void> {
  // Every cnav operation the contract lists is a raw one (`/v1/raw/cnav/*`), which `./raw.ts` registers from cnavRawActions.
}
