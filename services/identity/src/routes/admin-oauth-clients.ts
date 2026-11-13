/** Admin OAuth client routes of the Web Services screens: `cwebservice.list`, `edit`, `save` and `delete` [legacy: admin/core/controllers/cwebservice.cfc:80-124]. */
import { AuthDenial, Roles, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  deleteClient,
  effectiveGrantType,
  listClients,
  saveClient,
  validateClient,
  type OAuthActor,
  type OAuthClient,
  type OAuthClientForm,
  type OAuthDeps,
} from '../domain/oauth.js';
import { locateSession, type SessionDeps } from '../domain/sessions.js';
import type { components } from '../generated/openapi.js';
import type { ListPage } from '../repo/repository.js';
import { validateCsrfForRoute, type CsrfRouteDeps } from './internal-csrf.js';
import { LIST_PAGE_PROPERTIES, continuation } from './list-page.js';

// The contract's write results carry no redirect: web answers `cwebservice.list` with `siteid` appended, as legacy redirects
// after every delete and after a save without errors.

type Schemas = components['schemas'];

/** The OAuth client, session and CSRF operations the routes delegate to. */
export type AdminOAuthClientRouteDeps = { oauth: OAuthDeps; sessions: SessionDeps; csrf: CsrfRouteDeps['csrf'] };

type StoredClient = Awaited<ReturnType<typeof listClients>>['items'][number];

interface ClientParams {
  clientId: string;
}

interface SiteQuery {
  siteid?: string;
}

/** The list's query after the schema applied the page defaults. */
type ListQuery = SiteQuery & ListPage;

/** `before()` param defaults; `clientid` is the path id [legacy: admin/core/controllers/cwebservice.cfc:90-96]. */
const RC_DEFAULTS = Object.freeze({
  clientsecret: '',
  name: '',
  description: '',
  granttype: 'basic',
  redirecturl: '',
  userid: '',
});

/** `rc` as the controller reads it; `siteid` is undefined when the request supplies none. */
type Rc = Record<keyof typeof RC_DEFAULTS, string> & { clientid: string; siteid: string | undefined };

// The cWebService before() gate admits S2 users only [legacy: admin/core/controllers/cwebservice.cfc:82-88].
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.s2]) });

const TEXT = { type: 'string' } as const;

// ClientId, SiteIdQuery and OAuthClientInput as the contract declares them; Fastify validates them once, before the handler.
const CLIENT_PARAMS = {
  type: 'object',
  required: ['clientId'],
  properties: {
    clientId: { type: 'string', minLength: 35, maxLength: 35, pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$' },
  },
} as const;

const SITE_QUERY = { type: 'object', properties: { siteid: { type: 'string', minLength: 1 } } } as const;

const LIST_QUERY = { type: 'object', properties: { ...SITE_QUERY.properties, ...LIST_PAGE_PROPERTIES } } as const;

const SAVE_BODY = {
  type: 'object',
  additionalProperties: { type: ['string', 'number', 'boolean'] },
  properties: {
    siteid: TEXT,
    name: { type: 'string', maxLength: 50 },
    description: TEXT,
    granttype: { type: 'string', enum: ['basic', 'client_credentials', 'authorization_code', 'implicit', 'password'] },
    userid: TEXT,
    redirectURL: TEXT,
    clientsecret: TEXT,
    csrf_token: TEXT,
    csrf_token_expires: TEXT,
  },
} as const;

/** The verified user; the S2 gate is a user gate, so a call without a user token lacks a credential. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** A `timestamp without time zone` value as the contract's `LocalTimestamp`. */
function timestamp(value: Date | null): string | null {
  return value === null ? null : cfDateTimeFormat(value, 'yyyy-MM-dd HH:nn:ss.lll').replace(' ', 'T');
}

/** A client as the views read it through the bean getters [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:73-79]. */
function clientView(client: OAuthClient | StoredClient): Schemas['OAuthClient'] {
  return {
    clientid: client.clientid,
    clientsecret: client.clientsecret,
    siteid: client.siteid,
    userid: client.userid,
    name: client.name,
    description: client.description,
    // Saves admit only the contract's grant types, and getGrantType() reads an empty stored value as client_credentials.
    granttype: effectiveGrantType(client) as Schemas['OAuthGrantType'],
    redirecturl: client.redirecturl,
    created: timestamp(client.created),
    lastupdate: timestamp(client.lastupdate),
    lastupdateby: client.lastupdateby,
    lastupdatebidy: client.lastupdatebidy,
  };
}

/** `rc`: each field the url or form supplies, its name matched ignoring case, else its `param` default. */
function rcOf(request: FastifyRequest, clientId: string): Rc {
  const params = legacyParamsOf(request);
  const supplied = (name: string): string | undefined => {
    const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : String(params[key]);
  };
  const fields = Object.fromEntries(Object.entries(RC_DEFAULTS).map(([name, fallback]) => [name, supplied(name) ?? fallback]));
  return { ...(fields as Record<keyof typeof RC_DEFAULTS, string>), clientid: clientId, siteid: supplied('siteid') };
}

/** The session user a save acts for, from its login-time snapshot; null when the session holds no signed-in user. */
async function actorOf(sessions: SessionDeps, user: UserClaims): Promise<OAuthActor> {
  const row = user.sid === '' ? undefined : (await locateSession(sessions, user.sid))?.row;
  if (row === undefined || row.state !== 'active' || row.user_id === null || row.login_snapshot === null) return null;
  const { fname, lname } = JSON.parse(row.login_snapshot) as NonNullable<OAuthActor>;
  return { fname, lname };
}

/** Registers the Web Services list, edit read, save and delete; the auth hooks answer a `siteid` other than the token's site with 403. */
export async function registerAdminOAuthClientRoutes(app: FastifyInstance, deps: AdminOAuthClientRouteDeps): Promise<void> {
  const { oauth, sessions } = deps;
  const csrfDeps: CsrfRouteDeps = { csrf: deps.csrf };

  // [legacy: admin/core/views/cwebservice/list.cfm:78]
  app.get<{ Querystring: ListQuery; Reply: Schemas['OAuthClientList'] }>(
    '/v1/oauth-clients',
    { schema: { querystring: LIST_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      // The list reads session.siteid, which is the token's site, never rc.siteid.
      const user = userOf(request.opt2Auth);
      const page = { offset: request.query.offset, limit: request.query.limit };
      const { items, total } = await listClients(oauth, user.site, page);
      return { items: items.map((row) => clientView(row)), ...continuation(page, items.length, total) };
    },
  );

  // [legacy: admin/core/views/cwebservice/edit.cfm:5-7]
  app.get<{ Params: ClientParams; Querystring: SiteQuery; Reply: Schemas['OAuthClientDetail'] }>(
    '/v1/oauth-clients/:clientId',
    { schema: { params: CLIENT_PARAMS, querystring: SITE_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const form: OAuthClientForm = { siteid: request.query.siteid ?? user.site, clientid: request.params.clientId };
      // Only the defaulted fields are laid over: a new bean as init leaves it, while a stored client is read as stored.
      const { client, located } = await validateClient(oauth, form, await actorOf(sessions, user));
      return located === null ? { client: clientView(client), exists: false } : { client: clientView(located), exists: true };
    },
  );

  // [legacy: admin/core/controllers/cwebservice.cfc:100-115]
  app.put<{ Params: ClientParams; Body: Schemas['OAuthClientInput']; Reply: Schemas['OAuthClientWriteResult'] }>(
    '/v1/oauth-clients/:clientId',
    { schema: { params: CLIENT_PARAMS, body: SAVE_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const rc = rcOf(request, request.params.clientId);
      const { siteid } = rc;
      // Without rc.siteid legacy sets it to session.siteid and redirects before loading or validating anything.
      if (siteid === undefined) {
        const unsaved: OAuthClient = { ...rc, siteid: user.site, created: null, lastupdate: null, lastupdateby: '', lastupdatebidy: '' };
        return { written: false, client: clientView(unsaved), errors: {} };
      }
      const form: OAuthClientForm = { ...rc, siteid };
      const actor = await actorOf(sessions, user);
      if (await validateCsrfForRoute(csrfDeps, request, rc.clientid)) {
        const saved = await saveClient(oauth, form, actor);
        return { written: saved.stored !== null, client: clientView(saved.client), errors: saved.errors };
      }
      const { client, errors } = await validateClient(oauth, form, actor);
      return { written: false, client: clientView(client), errors };
    },
  );

  // [legacy: admin/core/controllers/cwebservice.cfc:117-124]
  app.delete<{ Params: ClientParams; Querystring: SiteQuery; Reply: Schemas['WriteResult'] }>(
    '/v1/oauth-clients/:clientId',
    { schema: { params: CLIENT_PARAMS, querystring: SITE_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      userOf(request.opt2Auth);
      const { clientId } = request.params;
      const written = (await validateCsrfForRoute(csrfDeps, request, clientId)) && (await deleteClient(oauth, clientId));
      return { written };
    },
  );
}
