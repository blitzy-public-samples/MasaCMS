/** Service routes people reads identity's account, membership, strike and pool-group rows through: `getAccount`, `lookupAccounts`, `lookupAccountsAllSites`, `countAccounts`, `lookupUsernameCandidates`, `lookupMemberships`, `loadLoginBlock` and `listSiteGroups`. */
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

// AccountLookupRequest, AccountCountRequest, UsernameCandidateRequest, MembershipLookupRequest, LoginBlockRequest with its user id
// and the listSiteGroups query as the contract declares them; Fastify validates them once, before the handler.
const ACCOUNT_WHERE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isPublic: { type: 'number' },
    s2: { type: 'number' },
    excludeS2Users: { type: 'boolean' },
    inActive: { type: 'number' },
    siteIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    unassigned: { type: 'boolean' },
  },
} as const;

const LOOKUP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['userIds'],
  properties: { userIds: { type: 'array', minItems: 1, uniqueItems: true, items: CF_UUID }, where: ACCOUNT_WHERE },
} as const;

const COUNT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: { scope: { type: 'string', enum: ['pool', 'tenant', 'all-sites'] }, publicPool: { type: 'boolean' }, where: ACCOUNT_WHERE },
  if: { required: ['scope'], properties: { scope: { const: 'pool' } } },
  then: { required: ['publicPool'], properties: { publicPool: { type: 'boolean' } } },
} as const;

const CANDIDATES_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['publicPool', 'pattern', 'limit'],
  properties: {
    publicPool: { type: 'boolean' },
    pattern: { type: 'string', minLength: 1, maxLength: 2000 },
    where: ACCOUNT_WHERE,
    limit: { type: 'integer', minimum: 1, maximum: 5000 },
  },
} as const;

const MEMBERSHIP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['userIds'],
  properties: { userIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: CF_UUID } },
} as const;

const USER_PARAMS = { type: 'object', required: ['userId'], properties: { userId: CF_UUID } } as const;

const LOGIN_BLOCK_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['removeBlock'],
  properties: { removeBlock: { type: 'boolean' } },
} as const;

const GROUPS_QUERY = {
  type: 'object',
  required: ['ispublic'],
  properties: { siteid: { type: 'string', minLength: 1 }, ispublic: { type: 'string', enum: ['0', '1'] } },
} as const;

/** The verified user claims; every route acts for the token's user, so their absence is a missing credential. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** Refuses a request without a verified user token (401) or whose user is not S2 (the legacy 403). */
function requireS2User(auth: Opt2AuthContext): void {
  if (!userOf(auth).s2) throw AuthDenial.forbidden();
}

/** Registers `getAccount`, `lookupAccounts`, `lookupAccountsAllSites`, `countAccounts`, `lookupUsernameCandidates`, `lookupMemberships`, `loadLoginBlock` and `listSiteGroups`; the auth hooks answer a `siteid` other than the token's site with 403. */
export async function registerAccountReadRoutes(app: FastifyInstance, deps: AccountReadRouteDeps): Promise<void> {
  const { db, accountReads } = deps;

  app.get<{ Params: AccountParams }>('/internal/v1/accounts/:userId', { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const account = await accountReads.getAccount(db, userOf(request.opt2Auth), request.params.userId);
    if (account !== null) return account;
    // The service's not-found handler answers the legacy 404 envelope.
    reply.callNotFound();
    return reply;
  });

  app.post<{ Params: AccountParams; Body: Schemas['LoginBlockRequest']; Reply: Schemas['LoginBlock'] }>(
    '/internal/v1/accounts/:userId/login-block',
    { schema: { params: USER_PARAMS, body: LOGIN_BLOCK_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request, reply) => {
      const input = { removeBlock: request.body.removeBlock, requestId: request.id };
      const block = await accountReads.loadLoginBlock(db, userOf(request.opt2Auth), request.params.userId, input);
      if (block !== null) return block;
      reply.callNotFound();
      return reply;
    },
  );

  app.post<{ Body: Schemas['AccountLookupRequest']; Reply: Schemas['AccountList'] }>(
    '/internal/v1/accounts::lookup',
    { schema: { body: LOOKUP_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({ items: await accountReads.lookupAccounts(db, userOf(request.opt2Auth), request.body.userIds, request.body.where) }),
  );

  app.post<{ Body: Schemas['AccountLookupRequest']; Reply: Schemas['AccountList'] }>(
    '/internal/v1/accounts::lookup-all-sites',
    { schema: { body: LOOKUP_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      requireS2User(request.opt2Auth);
      return { items: await accountReads.lookupAccountsAllSites(db, request.body.userIds, request.body.where) };
    },
  );

  app.post<{ Body: Schemas['AccountCountRequest']; Reply: Schemas['AccountCount'] }>(
    '/internal/v1/accounts::count',
    { schema: { body: COUNT_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const claims = userOf(request.opt2Auth);
      if (request.body.scope === 'all-sites') requireS2User(request.opt2Auth);
      return { count: await accountReads.countAccounts(db, claims, request.body) };
    },
  );

  app.post<{ Body: Schemas['UsernameCandidateRequest']; Reply: Schemas['UsernameCandidateList'] }>(
    '/internal/v1/accounts::username-candidates',
    { schema: { body: CANDIDATES_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => accountReads.lookupUsernameCandidates(db, userOf(request.opt2Auth), request.body),
  );

  app.post<{ Body: Schemas['MembershipLookupRequest']; Reply: Schemas['MembershipList'] }>(
    '/internal/v1/accounts::memberships',
    { schema: { body: MEMBERSHIP_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      userOf(request.opt2Auth);
      return { items: await accountReads.lookupMemberships(db, request.body.userIds) };
    },
  );

  app.get<{ Querystring: GroupsQuery; Reply: Schemas['SiteGroupList'] }>(
    '/internal/v1/groups',
    { schema: { querystring: GROUPS_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({
      items: await accountReads.listSiteGroups(db, userOf(request.opt2Auth), request.query.ispublic === '1' ? 1 : 0),
    }),
  );
}
