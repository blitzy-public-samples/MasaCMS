/** `listPrivateInterestGroups`: one level of a private user pool's interest groups, as Edit Profile reads them. */
import { AuthDenial, Roles, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { listPrivateInterestGroups } from '../../domain/categories.js';
import { actorFromClaims, type DomainDeps } from '../../domain/context.js';
import type { components } from '../../generated/openapi.js';

type PrivateInterestGroupList = components['schemas']['PrivateInterestGroupList'];

/** The domain collaborators the route reads through. */
export interface InterestGroupRouteDeps {
  readonly domain: Pick<DomainDeps, 'db' | 'repository'>;
}

const INTEREST_GROUPS_PATH = '/v1/sites/:siteid/private-interest-groups';

// cEditProfile's before() admits any logged-in user, as people's getProfile does.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.s2, Roles.siteAdmin, Roles.systemUser, Roles.member]),
});

const querySchema = z.object({
  groupsiteid: z.string().min(1).max(25),
  parentid: z.string().max(35).optional(),
});

/** Registers `listPrivateInterestGroups`. */
export async function registerInterestGroupRoutes(app: FastifyInstance, deps: InterestGroupRouteDeps): Promise<void> {
  const { domain } = deps;

  app.get<{ Params: { siteid: string }; Reply: PrivateInterestGroupList }>(
    INTEREST_GROUPS_PATH,
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const claims = request.opt2Auth.user;
      if (claims === undefined) {
        throw AuthDenial.unauthenticated('missing-credential');
      }
      assertSiteMatches(request.params.siteid, claims);
      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        throw new LegacyApiError('invalidParameters');
      }
      const rows = await listPrivateInterestGroups(domain, actorFromClaims(claims, ''), {
        siteId: query.data.groupsiteid,
        parentId: query.data.parentid ?? '',
      });
      if (rows === undefined) {
        throw AuthDenial.forbidden();
      }
      return {
        items: rows.map((row) => ({
          siteID: row.siteid,
          categoryID: row.categoryid,
          name: row.name ?? '',
          filename: row.filename ?? '',
          urltitle: row.urltitle ?? '',
          isOpen: row.isopen,
          hasKids: row.haskids,
        })),
      };
    },
  );
}
