// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Port of legacy-fixtures/cfml/lib/auth.cfc over the verified user token: site resolution, login, role-group and CSRF checks. */
import { hasAnyRole, Roles, SYNTHETIC_ROLES, type Opt2AuthContext, type UserClaims } from '@opt2/platform/auth';
import { javaTrim, LegacyApiError } from '@opt2/platform/legacy-compat';
import { csrfPreHandler, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import { FixtureApiError, type FixtureParams } from './fixture-envelope.js';

/** The role group every communications fixture route requires, as auth.cfc and role-map.json name it. */
export const FIXTURE_ROLES = Object.freeze({ sender: Roles.communicationsSender } as const) satisfies {
  readonly sender: 'communications.sender';
};

/** Site lookup as Masa's settingsManager decides it; routes back it with the tenant_registry. */
export interface FixtureSiteLookup {
  /** The registered site id matching `siteId` ignoring case, as getSite(siteid).getSiteID() returns it; undefined when unknown. */
  registeredSite(siteId: string): Promise<string | undefined>;
}

/** The request's verified user; identity is never read from params, headers or the body. */
function verifiedUser(request: FastifyRequest): Opt2AuthContext['user'] {
  return request.opt2Auth.user;
}

/** The `siteid` param, read ignoring case as a CFML struct key; undefined when absent. */
function siteParam(params: FixtureParams): unknown {
  const key = Object.keys(params).find((name) => name.toLowerCase() === 'siteid');
  return key === undefined ? undefined : params[key];
}

/** The `siteid` param: a JSON-body value as sent, a url or form value trimmed as Masa's Portcullis scan trims it. */
function suppliedSite(request: FastifyRequest, params: FixtureParams): unknown {
  const supplied = siteParam(params);
  const body: unknown = request.body;
  const fromJson =
    request.headers['content-type']?.slice(0, 16).toLowerCase() === 'application/json' &&
    typeof body === 'object' &&
    body !== null &&
    siteParam(body as FixtureParams) !== undefined;
  return typeof supplied === 'string' && !fromJson ? javaTrim(supplied) : supplied;
}

/**
 * Returns the registered id of `siteid`, else of the token's site, else of `default`; throws invalidParameters for a
 * non-string or unknown site, then forbidden when the verified user's token is for another site.
 * Fixture routes declare `{ public: true, siteCheck: false }` and call this after the path match, before requireLogin.
 */
export async function resolveSite(
  request: FastifyRequest,
  params: FixtureParams,
  lookup: FixtureSiteLookup,
): Promise<string> {
  const user = verifiedUser(request);
  const supplied = suppliedSite(request, params) ?? '';
  // auth.cfc falls back to the session's site, then to default; the token's site stands for the session's.
  const siteid = supplied === '' ? user?.site || 'default' : supplied;
  const registered = typeof siteid === 'string' ? await lookup.registeredSite(siteid) : undefined;
  if (registered === undefined) {
    throw new LegacyApiError('invalidParameters');
  }
  // Compared with the token's site, never its tenant id; Masa site ids match ignoring case.
  if (user !== undefined && registered.toLowerCase() !== user.site.toLowerCase()) {
    throw new FixtureApiError('forbidden');
  }
  return registered;
}

/** Returns the verified user's claims; throws authorization (401) for an anonymous caller. Call after resolveSite. */
export function requireLogin(request: FastifyRequest): UserClaims {
  const user = verifiedUser(request);
  if (user === undefined) {
    throw new LegacyApiError('authorization');
  }
  return user;
}

/** The fixture roles the verified user holds for the token's site, in auth.cfc's role-name order; [] when anonymous. */
export function rolesHeld(request: FastifyRequest): string[] {
  const user = verifiedUser(request);
  if (user === undefined) {
    return [];
  }
  return SYNTHETIC_ROLES.filter((role) => user.roles.includes(role));
}

/**
 * Returns the verified user's claims; throws authorization when anonymous, or forbidden unless a held fixture role
 * equals one of `roles` ignoring case. Call after resolveSite, then requireCsrf, as auth.cfc's requireAny does.
 */
export function requireAny(request: FastifyRequest, roles: readonly string[]): UserClaims {
  const user = requireLogin(request);
  const held = rolesHeld(request).map((role) => role.toLowerCase());
  // No S2 bypass: auth.cfc grants these routes only through the role groups.
  if (!hasAnyRole(held, roles.map((role) => role.toLowerCase()))) {
    throw new FixtureApiError('forbidden');
  }
  return user;
}

/** Requests whose CSRF token identity has already consumed. */
const csrfValidated = new WeakSet<FastifyRequest>();

/** The method api.cfm dispatches on: a non-empty X-HTTP-Method-Override, else the request method, upper-cased. */
function fixtureHttpMethod(request: FastifyRequest): string {
  const override = request.headers['x-http-method-override'];
  const value = Array.isArray(override) ? override[0] : override;
  return (value === undefined || value === '' ? request.method : value).toUpperCase();
}

/**
 * Has identity validate and consume the CSRF token for `context`, the route id ('' for a collection), once per request;
 * GET, HEAD and anonymous calls skip it. Throws invalidTokens (400). Call after requireAny or the route's own checks.
 */
export async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  const method = fixtureHttpMethod(request);
  if (method === 'GET' || method === 'HEAD' || verifiedUser(request) === undefined || csrfValidated.has(request)) {
    return;
  }
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
  csrfValidated.add(request);
}

/**
 * The verified user's Masa UserID. An anonymous caller gets an empty string rather than a 401, because auth.cfc's
 * userId() returns the guest session's empty UserID; routes reach it only after requireAny.
 */
export function userId(request: FastifyRequest): string {
  return verifiedUser(request)?.sub ?? '';
}
