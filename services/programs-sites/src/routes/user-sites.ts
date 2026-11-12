/** The admin home redirect's and header site selector's site list (settingsManager.getUserSites, contentServer.bindToDomain). */
import { AuthDenial, Roles } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
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

/** Registers `GET /v1/user-sites`; identity is called through the app's service client with the request's user token. */
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
}
