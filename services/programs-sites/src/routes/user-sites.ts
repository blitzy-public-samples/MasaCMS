/** The admin home redirect's and header site selector's site list (settingsManager.getUserSites, contentServer.bindToDomain). */
import { AuthDenial, Roles } from '@opt2/platform/auth';
import { abandonOnDisconnect, currentRequestContext, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createUserSitesDomain } from '../domain/user-sites.js';
import type { components } from '../generated/openapi.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';
import { jsonApiLegacySettings } from './json-api-site.js';

/** Dependencies of `registerUserSiteRoutes`. */
export interface UserSiteRouteDeps {
  db: TenantDb;
  repository: ProgramsSitesRepository;
  /** configBean `adminDomain`; {@link jsonApiLegacySettings} over `process.env` when omitted. */
  adminDomain?: string;
}

const PRIVATE_ADMIN = [Roles.s2, Roles.siteAdmin, Roles.systemUser] as const;

/** Bounds of the `UserSiteHost` query parameter; a repeated `host` fails them. */
const QUERY_SCHEMA = { type: 'object', properties: { host: { type: 'string' } } } as const;

/** Query of `listUserSitesV2`, `limit` defaulted. */
interface UserSitePageQuery {
  limit: number;
  after?: string;
}

/** Bounds of `ListPageSize` and `SitePageAfter`. */
const PAGE_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
    after: { type: 'string', minLength: 1, maxLength: 25 },
  },
} as const;

/** Registers `GET /v1/user-sites` and `GET /v2/user-sites`; identity is called through the app's service client with the user token. */
export function registerUserSiteRoutes(app: FastifyInstance, deps: UserSiteRouteDeps): void {
  const userSites = createUserSitesDomain({
    repo: deps.repository,
    client: app.opt2.client,
    adminDomain: deps.adminDomain ?? jsonApiLegacySettings().adminDomain,
  });

  app.get<{ Querystring: { host?: string }; Reply: components['schemas']['UserSiteList'] }>(
    '/v1/user-sites',
    { config: { opt2: { transport: 'service', requires: PRIVATE_ADMIN } }, schema: { querystring: QUERY_SCHEMA } },
    async (request) => {
      const { user } = request.opt2Auth;
      if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
      return userSites.listUserSites(deps.db, user, request.query.host);
    },
  );

  /** One page of the user's sites in site-id order, without host binding; a disconnected client abandons it. */
  app.get<{ Querystring: UserSitePageQuery; Reply: components['schemas']['UserSitePage'] }>(
    '/v2/user-sites',
    { config: { opt2: { transport: 'service', requires: PRIVATE_ADMIN } }, schema: { querystring: PAGE_QUERY_SCHEMA } },
    async (request) => {
      const { user } = request.opt2Auth;
      if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
      abandonOnDisconnect(request);
      const { limit, after } = request.query;
      return userSites.listUserSitePage(deps.db, user, { limit, after, signal: currentRequestContext()?.signal });
    },
  );
}
