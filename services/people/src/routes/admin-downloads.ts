// The users CSV downloads of the cUsers circuit: `cUsers.download` and `cUsers.advancedSearchToCSV`
// [legacy: admin/core/controllers/cusers.cfc:453-496, admin/core/views/cusers/inc/dsp_download.cfm].
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
import { cfToBoolean, legacyUsersCsvStream } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, sendLegacyResponse, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  getAdvancedSearchStream,
  getUnassignedUsersStream,
  getUsersStream,
  newAdvancedSearchCriteria,
  type AdvancedSearchCriteria,
  type SearchDeps,
  type StreamedQuery,
} from '../domain/search.js';
import type { operations } from '../generated/openapi.js';
import {
  AdminDenial,
  CUSERS_ROUTE_REQUIRES,
  normaliseCusersParams,
  requireCusersAccess,
  sendAdminDenial,
  viewerScopeFor,
  type CusersContext,
} from './access.js';

/** The verified session whose stored advanced-search criteria a download runs. */
export type SearchCriteriaSession = Pick<UserClaims, 'sid' | 'tid'>;

/** Reads the advanced-search criteria `setAdvancedSearch` stored for a session; `undefined` before any were stored. */
export interface SearchCriteriaReader {
  read(session: SearchCriteriaSession): Promise<AdvancedSearchCriteria | undefined>;
}

/** Collaborators of the download routes: the user reads, and the session's stored advanced-search criteria. */
export type AdminDownloadRouteDeps = { search: SearchDeps; searchCriteria: SearchCriteriaReader };

type DownloadUsersQuery = NonNullable<operations['downloadUsersCsv']['parameters']['query']>;
type DownloadAdvancedSearchQuery = NonNullable<operations['downloadAdvancedSearchCsv']['parameters']['query']>;

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: CUSERS_ROUTE_REQUIRES });

/** The cUsers `before()` prologue: the admitted caller and its scrubbed request context, or the denial `secure()` answers. */
function cusersPrologue(request: FastifyRequest): { claims: UserClaims; rc: CusersContext } | AdminDenial {
  const claims = requireCusersAccess(request);
  if (claims instanceof AdminDenial) return claims;
  return { claims, rc: normaliseCusersParams(legacyParamsOf(request), claims) };
}

/**
 * Answers `dsp_download.cfm`: the users CSV of `query` as ACF reads it, its rows read batch by batch as the body is sent.
 * A row failing in the first batch answers the error response; a later one aborts the body already being sent.
 */
async function sendUsersCsv(reply: FastifyReply, query: StreamedQuery): Promise<FastifyReply> {
  const { body, headers } = await legacyUsersCsvStream(query.columnList, query.rows);
  return sendLegacyResponse(reply, { status: 200, headers, body });
}

/** Registers `downloadUsersCsv` and `downloadAdvancedSearchCsv` as the people contract declares them. */
export async function registerAdminDownloadRoutes(app: FastifyInstance, deps: AdminDownloadRouteDeps): Promise<void> {
  // `cUsers.download` without preserved records: the site's users, or those without a membership [legacy: cusers.cfc:460-470].
  app.get<{ Querystring: DownloadUsersQuery }>('/v1/users/download', { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const admitted = cusersPrologue(request);
    if (admitted instanceof AdminDenial) return sendAdminDenial(reply, admitted);
    const { claims, rc } = admitted;
    const viewer = viewerScopeFor(claims);
    const args = { siteid: rc.siteid, ispublic: rc.ispublic };
    const users = cfToBoolean(rc.unassigned)
      ? await getUnassignedUsersStream(deps.search, viewer, args)
      : await getUsersStream(deps.search, viewer, args);
    return sendUsersCsv(reply, users);
  });

  // `cUsers.advancedSearchToCSV`, then the `cUsers.download` its redirect preserves the rows for [legacy: cusers.cfc:453-457].
  app.get<{ Querystring: DownloadAdvancedSearchQuery }>(
    '/v1/users/advanced-search.csv',
    { config: { opt2: ROUTE_AUTH } },
    async (request, reply) => {
      const admitted = cusersPrologue(request);
      if (admitted instanceof AdminDenial) return sendAdminDenial(reply, admitted);
      const { claims, rc } = admitted;
      // Legacy runs `getAdvancedSearch(session, …)`: the criteria are the session's as `setAdvancedSearch` stored them, never
      // this request's fields, and a session that stored none holds admin start-up's defaults.
      const criteria = (await deps.searchCriteria.read(claims)) ?? newAdvancedSearchCriteria();
      const users = await getAdvancedSearchStream(deps.search, viewerScopeFor(claims), criteria, { siteid: rc.siteid, isPublic: rc.ispublic });
      return sendUsersCsv(reply, users);
    },
  );
}
