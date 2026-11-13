// The users CSV downloads of the cUsers circuit: `cUsers.download` and `cUsers.advancedSearchToCSV`
// [legacy: admin/core/controllers/cusers.cfc:453-496, admin/core/views/cusers/inc/dsp_download.cfm].
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
import { cfDateTimeFormat, cfNumberString, cfToBoolean, legacyQuery, legacyUsersCsv, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, sendLegacyResponse, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  getAdvancedSearch,
  getUnassignedUsers,
  getUsers,
  newAdvancedSearchCriteria,
  type AdvancedSearchCriteria,
  type SearchDeps,
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

/** A datetime cell as ACF renders a `java.sql.Timestamp`: `yyyy-mm-dd HH:nn:ss.f`, trailing fraction zeros dropped. */
function timestampText(value: Date): string {
  // The first fraction digit always stays, so `.000` reads `.0` and `.370` reads `.37`.
  return cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(/0{1,2}$/, '');
}

/**
 * A query cell as ACF renders it in string context; NULL reads as ''.
 * @throws TypeError For a complex value, which ACF cannot convert to a simple value either.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (value instanceof Date) return timestampText(value);
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

/**
 * The query as `setDownloadData` reads it on ACF: `columnList` upper-cased and sorted by code unit, which is also the order
 * the row cells follow, with every cell already rendered as text.
 */
function acfQuery(query: LegacyQuery): LegacyQuery {
  const columns = query.columnList
    .map((name) => ({ name, upper: name.toUpperCase() }))
    .sort((a, b) => (a.upper < b.upper ? -1 : a.upper > b.upper ? 1 : 0));
  const rows = query.rows.map((row) => Object.fromEntries(columns.map(({ name, upper }) => [upper, cellText(row[name])])));
  return legacyQuery(
    columns.map(({ upper }) => upper),
    rows,
  );
}

/** The cUsers `before()` prologue: the admitted caller and its scrubbed request context, or the denial `secure()` answers. */
function cusersPrologue(request: FastifyRequest): { claims: UserClaims; rc: CusersContext } | AdminDenial {
  const claims = requireCusersAccess(request);
  if (claims instanceof AdminDenial) return claims;
  return { claims, rc: normaliseCusersParams(legacyParamsOf(request), claims) };
}

/** Answers `dsp_download.cfm`: the users CSV of `query` with the legacy download headers. */
function sendUsersCsv(reply: FastifyReply, query: LegacyQuery): FastifyReply {
  const { body, headers } = legacyUsersCsv(acfQuery(query));
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
      ? await getUnassignedUsers(deps.search, viewer, args)
      : await getUsers(deps.search, viewer, args);
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
      const users = await getAdvancedSearch(deps.search, viewerScopeFor(claims), criteria, { siteid: rc.siteid, isPublic: rc.ispublic });
      return sendUsersCsv(reply, users);
    },
  );
}
