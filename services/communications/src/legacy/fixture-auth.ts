// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Port of legacy-fixtures/cfml/lib/auth.cfc over the verified user token: site resolution, login and role-group checks. */
import { hasAnyRole, Roles, SYNTHETIC_ROLES, type Opt2AuthContext, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { FastifyRequest } from '@opt2/platform/service-kit';
import { FixtureApiError, type FixtureParams } from './fixture-envelope.js';

/** The role group every communications fixture route requires, as auth.cfc and role-map.json name it. */
export const FIXTURE_ROLES = Object.freeze({ sender: Roles.communicationsSender } as const) satisfies {
  readonly sender: 'communications.sender';
};

/** Site existence as Masa's settingsManager.siteExists decides it, ignoring case; routes back it with the tenant_registry. */
export interface FixtureSiteLookup {
  siteExists(siteId: string): Promise<boolean>;
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

/**
 * Returns `siteid` as supplied, or the token's site when it is absent or empty; throws invalidParameters for a missing
 * or unknown site, then forbidden when the verified user's token is for another site.
 * Fixture routes declare `{ public: true, siteCheck: false }` and call this after the path match, before requireLogin.
 */
export async function resolveSite(
  request: FastifyRequest,
  params: FixtureParams,
  lookup: FixtureSiteLookup,
): Promise<string> {
  const user = verifiedUser(request);
  const supplied = siteParam(params) ?? '';
  // auth.cfc falls back to the session's site; the token's site stands for it, and a guest session has none.
  const siteid = supplied === '' ? (user?.site ?? '') : supplied;
  if (typeof siteid !== 'string' || siteid === '' || !(await lookup.siteExists(siteid))) {
    throw new LegacyApiError('invalidParameters');
  }
  // Compared with the token's site, never its tenant id; Masa site ids match ignoring case.
  if (user !== undefined && siteid.toLowerCase() !== user.site.toLowerCase()) {
    throw new FixtureApiError('forbidden');
  }
  return siteid;
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
 * equals one of `roles` ignoring case. Call after resolveSite.
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

/**
 * The verified user's Masa UserID. An anonymous caller gets an empty string rather than a 401, because auth.cfc's
 * userId() returns the guest session's empty UserID; routes reach it only after requireAny.
 */
export function userId(request: FastifyRequest): string {
  return verifiedUser(request)?.sub ?? '';
}
