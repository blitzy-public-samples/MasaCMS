/** Service routes people reads identity's account and pool-group rows through: `getAccount`, `lookupAccounts` and `listSiteGroups`. */
import { AuthDenial, serviceRole, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { AccountReads } from '../domain/account-reads.js';
import type { components } from '../generated/openapi.js';

type Schemas = components['schemas'];

/** The database and account reads the routes delegate to. */
export interface AccountReadRouteDeps {
  db: TenantDb;
  accountReads: AccountReads;
}

interface AccountParams {
  userId: string;
}

interface GroupsQuery {
  siteid?: string;
  ispublic: '0' | '1';
}

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('people')]) });

const CF_UUID = {
  type: 'string',
  minLength: 35,
  maxLength: 35,
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$',
} as const;

// AccountLookupRequest and the listSiteGroups query as the contract declares them; Fastify validates them once, before the handler.
const LOOKUP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['userIds'],
  properties: { userIds: { type: 'array', minItems: 1, uniqueItems: true, items: CF_UUID } },
} as const;

const GROUPS_QUERY = {
  type: 'object',
  required: ['ispublic'],
  properties: { siteid: { type: 'string', minLength: 1 }, ispublic: { type: 'string', enum: ['0', '1'] } },
} as const;

/** The verified user claims; every route reads the token site's pools, so their absence is a missing credential. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** Registers `getAccount`, `lookupAccounts` and `listSiteGroups`; the auth hooks answer a `siteid` other than the token's site with 403. */
export async function registerAccountReadRoutes(app: FastifyInstance, deps: AccountReadRouteDeps): Promise<void> {
  const { db, accountReads } = deps;

  app.get<{ Params: AccountParams }>('/internal/v1/accounts/:userId', { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const account = await accountReads.getAccount(db, userOf(request.opt2Auth), request.params.userId);
    if (account !== null) return account;
    // The service's not-found handler answers the legacy 404 envelope.
    reply.callNotFound();
    return reply;
  });

  app.post<{ Body: Schemas['AccountLookupRequest']; Reply: Schemas['AccountList'] }>(
    '/internal/v1/accounts::lookup',
    { schema: { body: LOOKUP_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({ items: await accountReads.lookupAccounts(db, userOf(request.opt2Auth), request.body.userIds) }),
  );

  app.get<{ Querystring: GroupsQuery; Reply: Schemas['SiteGroupList'] }>(
    '/internal/v1/groups',
    { schema: { querystring: GROUPS_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({
      items: await accountReads.listSiteGroups(db, userOf(request.opt2Auth), request.query.ispublic === '1' ? 1 : 0),
    }),
  );
}
