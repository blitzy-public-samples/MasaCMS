// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Port of legacy-fixtures/cfml/lib/auth.cfc over the verified user token: site resolution, login, role-group, CSRF and task-token checks. */
import { timingSafeEqual } from 'node:crypto';
import { hasAnyRole, Roles, SYNTHETIC_ROLES, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { csrfPreHandler, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import { FixtureApiError, type FixtureParams } from './fixture-envelope.js';

/** The fixture role group names, in auth.cfc and role-map.json order. */
export const FIXTURE_ROLES: typeof SYNTHETIC_ROLES = SYNTHETIC_ROLES;

/** Site lookup as Masa's settingsManager decides it; routes back it with the tenant_registry. */
export interface FixtureSiteLookup {
  /** The registered site id matching `siteId` ignoring case, as getSite(siteid).getSiteID() returns it; undefined when unknown. */
  registeredSite(siteId: string): Promise<string | undefined>;
}

/** The request's verified user; identity is never read from params, headers or the body. */
function verifiedUser(request: FastifyRequest): UserClaims | undefined {
  return request.opt2Auth.user;
}

/** The verified user of a logged-in session; the anonymous principal (`sub` '') is a guest session, as auth.cfc sees it. */
function loggedInUser(request: FastifyRequest): UserClaims | undefined {
  const user = verifiedUser(request);
  return user !== undefined && user.sub !== '' ? user : undefined;
}

/** The `siteid` param, read ignoring case as a CFML struct key; undefined when absent. */
function siteParam(params: FixtureParams): unknown {
  const key = Object.keys(params).find((name) => name.toLowerCase() === 'siteid');
  return key === undefined ? undefined : params[key];
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
  // legacyParamsOf already holds a url or form siteid as Masa's start-up scan leaves it, trimmed; a JSON-body siteid as sent.
  const supplied = siteParam(params) ?? '';
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

/** Returns the logged-in user's claims; throws authorization (401) for an anonymous caller. Call after resolveSite. */
export function requireLogin(request: FastifyRequest): UserClaims {
  const user = loggedInUser(request);
  if (user === undefined) {
    throw new LegacyApiError('authorization');
  }
  return user;
}

/** The fixture roles the logged-in user holds for the token's site, in FIXTURE_ROLES order; [] when anonymous. */
export function rolesHeld(request: FastifyRequest): string[] {
  const user = loggedInUser(request);
  if (user === undefined) {
    return [];
  }
  return FIXTURE_ROLES.filter((role) => user.roles.includes(role));
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
export function fixtureHttpMethod(request: FastifyRequest): string {
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
  if (method === 'GET' || method === 'HEAD' || loggedInUser(request) === undefined || csrfValidated.has(request)) {
    return;
  }
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
  csrfValidated.add(request);
}

/** Whether the logged-in user is S2 or a member of the site's private-pool Admin group (`site-admin`). */
export function isSiteAdmin(request: FastifyRequest): boolean {
  const user = loggedInUser(request);
  return user !== undefined && (user.s2 || hasAnyRole(user.roles, [Roles.s2, Roles.siteAdmin]));
}

/** Whether the logged-in user is S2, a private-pool user (`system-user`) or a public-pool account (`member`) of the token's site. */
export function isSiteMember(request: FastifyRequest): boolean {
  const user = loggedInUser(request);
  return user !== undefined && (user.s2 || hasAnyRole(user.roles, [Roles.s2, Roles.systemUser, Roles.member]));
}

/** Header in which the gateway relays a fixture request's inbound `Authorization` verbatim. */
export const FIXTURE_AUTHORIZATION_HEADER = 'x-opt2-fixture-authorization';

/** A `Basic` value (scheme in any case) and its base64 credentials, as auth.cfc taskCredential matches them. */
const BASIC_AUTHORIZATION = /^Basic +((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

/**
 * auth.cfc taskCredential over the relayed `Authorization`: the text after the first ':' of the UTF-8 decoded Basic
 * credentials; '' for any other value, no ':' or no header. Query, form and body values are never read.
 */
export function taskTokenOf(request: FastifyRequest): string {
  const value = request.headers[FIXTURE_AUTHORIZATION_HEADER];
  const encoded = typeof value === 'string' ? BASIC_AUTHORIZATION.exec(value)?.[1] : undefined;
  const decoded = encoded === undefined ? '' : Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? '' : decoded.slice(colon + 1);
}

/** auth.cfc checkTaskToken: the lowercase hex SHA-256 of `token`'s UTF-8 bytes equals `storedHash`, compared in constant time. */
export function checkTaskToken(token: string, storedHash: string): boolean {
  const computed = Buffer.from(sha256Hex(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

/** The verified user's Masa UserID; an empty string when anonymous, as auth.cfc returns for a guest session. */
export function userId(request: FastifyRequest): string {
  return verifiedUser(request)?.sub ?? '';
}
