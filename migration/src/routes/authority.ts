/** `unitAuthority`: write authority of the requested units under the gateway's active cut-over version. */
import { Roles, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { CurrentAuthority } from '../cutover/index.js';
import type { components, operations, paths } from '../generated/openapi.js';
import { UnknownUnitError, type UnitCatalog } from '../owners/index.js';

type UnitAuthorityResponse = components['schemas']['UnitAuthorityResponse'];
type UnitAuthorityQuery = operations['unitAuthority']['parameters']['query'];

/** The authority read and the unit catalog the route uses. */
export interface AuthorityRouteDeps {
  /** One read of every unit's authority under the active version. */
  authority: () => Promise<CurrentAuthority>;
  catalog: Pick<UnitCatalog, 'unit'>;
}

const AUTHORITY_PATH = '/internal/v1/authority' satisfies keyof paths;

/** Operations this module registers: contract `path` and Fastify `url`. */
export const AUTHORITY_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'unitAuthority', method: 'GET', path: AUTHORITY_PATH, url: AUTHORITY_PATH } as const),
]);

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('programs-sites'), serviceRole('gateway'), Roles.platformOperator]),
});

// UnitList as the contract declares it: comma-separated `<schema>.<table>` ids.
const UNIT_LIST = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$/;

const querySchema = z.object({ units: z.string().regex(UNIT_LIST) }) satisfies z.ZodType<UnitAuthorityQuery>;

/** Distinct unit ids of the query, each known to the catalog; anything else is the legacy 400. */
function requestedUnits(query: unknown, catalog: AuthorityRouteDeps['catalog']): string[] {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  const units = [...new Set(parsed.data.units.split(','))];
  for (const unit of units) {
    try {
      catalog.unit(unit);
    } catch (error) {
      throw error instanceof UnknownUnitError ? new LegacyApiError('invalidParameters') : error;
    }
  }
  return units;
}

/** Registers `unitAuthority`, which reads authority only after the unit list is valid. */
export function registerAuthorityRoutes(app: FastifyInstance, deps: AuthorityRouteDeps): void {
  app.get<{ Querystring: unknown; Reply: UnitAuthorityResponse }>(
    AUTHORITY_PATH,
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const units = requestedUnits(request.query, deps.catalog);
      const authority = await deps.authority();
      return {
        tableVersion: authority.tableVersion,
        units: Object.fromEntries(units.map((unit) => [unit, authority.units.get(unit) ?? 'legacy'])),
        allTarget: units.every((unit) => authority.isTargetAuthoritative(unit)),
      };
    },
  );
}
