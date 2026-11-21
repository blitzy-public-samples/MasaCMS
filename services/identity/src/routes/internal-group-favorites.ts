/** Service route people's favorites templates read identity's group favorites through: `lookupGroupFavorites`. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { GroupFavoriteReads } from '../domain/group-favorites.js';
import type { components } from '../generated/openapi.js';

type Schemas = components['schemas'];

/** The database and group favorite reads the route delegates to. */
export interface GroupFavoriteRouteDeps {
  db: TenantDb;
  groupFavorites: GroupFavoriteReads;
}

// people's invocation credential alone: the favorites templates also run for anonymous visitors.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('people')]) });

// GroupFavoriteLookupRequest as the contract declares it; Fastify validates it once, before the handler.
const LOOKUP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['favoriteIds'],
  properties: {
    favoriteIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 35 } },
  },
} as const;

/** Registers `lookupGroupFavorites`. */
export function registerGroupFavoriteRoutes(app: FastifyInstance, deps: GroupFavoriteRouteDeps): void {
  const { db, groupFavorites } = deps;

  app.post<{ Body: Schemas['GroupFavoriteLookupRequest']; Reply: Schemas['GroupFavoriteList'] }>(
    '/internal/v1/group-favorites::lookup',
    { schema: { body: LOOKUP_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({ items: await groupFavorites.lookupGroupFavorites(db, request.body.favoriteIds) }),
  );
}
