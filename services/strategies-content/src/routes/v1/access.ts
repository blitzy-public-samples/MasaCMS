// The content admin circuits' controller gates, `secure()` denials, FW/1 redirects, session effects and admin CSRF wiring.
import { AuthDenial, Roles, assertSiteMatches, moduleRole, type Opt2RouteConfig, type Role } from '@opt2/platform/auth';
import { cfNumberString } from '@opt2/platform/legacy-compat';
import { csrfPreHandler, legacyParamsOf, type FastifyRequest } from '@opt2/platform/service-kit';
import { chainAccess } from '../../domain/approvals.js';
import { categoryAccess } from '../../domain/categories.js';
import type { Actor } from '../../domain/context.js';
import { feedAccess } from '../../domain/feeds.js';
import { getModulePerm } from '../../domain/permissions.js';
import type { components } from '../../generated/openapi.js';
import type { ContentRouteContext } from '../index.js';

export { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';

/** Admin circuits strategies-content serves. */
export type ContentAdminCircuit = 'carch' | 'cchangesets' | 'ccomments' | 'ccategory' | 'cfeed' | 'cchain' | 'cform' | 'cnav';

/** Circuits with a controller `before()` gate; cnav has none, so the contract declares its operations public. */
export type GatedContentAdminCircuit = Exclude<ContentAdminCircuit, 'cnav'>;

const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const FORMS_MODULE_ID = '00000000000000000000000000000000004';
const CATEGORIES_MODULE_ID = '00000000000000000000000000000000010';
const COLLECTIONS_MODULE_ID = '00000000000000000000000000000000011';
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';
const COMMENTS_MODULE_ID = '00000000000000000000000000000000015';

/** S2, the site Admin role, then `roles`, frozen. */
function adminRolesAnd(...roles: Role[]): readonly Role[] {
  return Object.freeze([Roles.s2, Roles.siteAdmin, ...roles]);
}

/** `config.opt2.requires` of each gated circuit's operations, as the contract's `x-opt2-requires` lists them. */
export const CIRCUIT_ROUTE_REQUIRES: Readonly<Record<GatedContentAdminCircuit, readonly Role[]>> = Object.freeze({
  carch: adminRolesAnd(moduleRole(SITE_MANAGER_MODULE_ID)),
  cchangesets: adminRolesAnd(moduleRole(CHANGESETS_MODULE_ID)),
  ccomments: adminRolesAnd(moduleRole(COMMENTS_MODULE_ID)),
  ccategory: adminRolesAnd(moduleRole(CATEGORIES_MODULE_ID)),
  cfeed: adminRolesAnd(moduleRole(COLLECTIONS_MODULE_ID)),
  cchain: adminRolesAnd(),
  cform: adminRolesAnd(moduleRole(FORMS_MODULE_ID)),
});

/** Where the cfeed gate reads `tsettings.feedManager`: no verified source holds it here, so only the role part is evaluated. */
export const FEED_MANAGER_FLAG_SOURCE: 'verified' | 'unavailable' = 'unavailable';

// `content.tenant_registry` carries no feed-manager flag and no request value may stand in for it, so the gate applies
// legacy's default of 1 (settingsBean.cfc:126); a site set to 0 is the gap FEED_MANAGER_FLAG_SOURCE records.
const FEED_MANAGER_DEFAULT = Object.freeze({ hasFeedManager: true });

// getModulePerm answers true for S2 and the site Admin role, so each "Admin or S2, else both module grants" test of
// cchangesets.cfc:82-85, ccomments.cfc:94-100 and cform.cfc:78-82 is the module pair alone.
/** Each circuit's `before()` admission of the verified actor. */
const CIRCUIT_GATES: Readonly<Record<ContentAdminCircuit, (actor: Actor) => boolean>> = Object.freeze({
  carch: (actor: Actor) => getModulePerm(actor, SITE_MANAGER_MODULE_ID),
  cchangesets: (actor: Actor) => getModulePerm(actor, CHANGESETS_MODULE_ID) && getModulePerm(actor, SITE_MANAGER_MODULE_ID),
  ccomments: (actor: Actor) => getModulePerm(actor, COMMENTS_MODULE_ID) && getModulePerm(actor, SITE_MANAGER_MODULE_ID),
  ccategory: categoryAccess,
  cfeed: (actor: Actor) => feedAccess(actor, FEED_MANAGER_DEFAULT),
  cchain: chainAccess,
  cform: (actor: Actor) => getModulePerm(actor, SITE_MANAGER_MODULE_ID) && getModulePerm(actor, FORMS_MODULE_ID),
  cnav: () => true,
});

/** The route `config` a circuit's operations spread: the contract's roles on the service transport; cnav is public. */
export function circuitRouteConfig(circuit: ContentAdminCircuit): { opt2: Opt2RouteConfig } {
  if (circuit === 'cnav') return { opt2: { public: true, transport: 'service' } };
  return { opt2: { requires: [...CIRCUIT_ROUTE_REQUIRES[circuit]], transport: 'service' } };
}

/**
 * The circuit's `before()` gate over verified identities only: the token's site must be `siteId`, then the actor must pass.
 * @returns The actor the handler runs as.
 * @throws AuthDenial 403 for another site; the {@link adminDenial} status when the gate refuses.
 */
export async function requireCircuitAccess(
  request: FastifyRequest,
  ctx: ContentRouteContext,
  circuit: ContentAdminCircuit,
  siteId: string,
): Promise<Actor> {
  const claims = request.opt2Auth.user;
  if (claims !== undefined) assertSiteMatches(siteId, claims);
  const actor = await ctx.actorFor(request);
  // AuthDenial's private constructor admits no subclass; thrown as itself, service-kit answers it as the auth hooks do.
  if (!CIRCUIT_GATES[circuit](actor)) throw adminDenial(request).auth;
  return actor;
}

/** The contract's admin write outcome: saved flag, legacy errors, FW/1 redirect (null re-renders) and view data. */
export type AdminWriteResult = components['schemas']['AdminWriteResult'];

/** An FW/1 redirect in the contract's shape: circuit, action and `[name, value]` pairs in append order, unencoded. */
export type AdminRedirect = NonNullable<AdminWriteResult['redirect']>;

/** `rc[key]` as text where CFML `structKeyExists` (ignoring case) and `isSimpleValue` both hold. */
function simpleValueNoCase(rc: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const lower = key.toLowerCase();
  const name = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = name === undefined ? undefined : rc[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

// Preserved flash contexts (`preserve`, `fw1pk`) and the redirect path are web's: the contract's redirect carries neither.
/** FW/1 `redirect(action, append)` [framework.cfc:735-781]: each listed key `rc` holds as a simple value, spelled as listed. */
export function adminRedirect(
  action: `${string}.${string}`,
  rc: Readonly<Record<string, unknown>>,
  append: readonly string[],
): AdminRedirect {
  const dot = action.indexOf('.');
  const params = append.flatMap((key): Array<[string, string]> => {
    const value = simpleValueNoCase(rc, key);
    return value === undefined ? [] : [[key, value]];
  });
  return { circuit: action.slice(0, dot), action: action.slice(dot + 1), params };
}

/** Where legacy `secure()` sends the browser [controller.cfc:83-92]. */
export type AdminDenialRedirect = { kind: 'login'; redirect: AdminRedirect } | { kind: 'back'; location: string };

/** A refused circuit gate: the contract's 401 or 403, and where legacy `secure()` redirects instead. */
export class AdminDenial {
  constructor(
    readonly auth: AuthDenial,
    readonly redirect: AdminDenialRedirect,
  ) {}

  /** 401 for an anonymous caller, 403 for a logged-in one. */
  get statusCode(): 401 | 403 {
    return this.auth.statusCode;
  }
}

/** `secure()`: `cLogin.main` with `compactDisplay` when not logged in, else `utility.backUp()` to the referrer or `./`. */
export function adminDenial(request: FastifyRequest): AdminDenial {
  const user = request.opt2Auth.user;
  // The anonymous principal (`sub` '') is not logged in. `returnURL` is the browser's admin URL, which only web holds.
  if (user === undefined || user.sub === '') {
    return new AdminDenial(AuthDenial.unauthenticated('missing-credential'), {
      kind: 'login',
      redirect: adminRedirect('cLogin.main', legacyParamsOf(request), ['compactDisplay']),
    });
  }
  // The referrer is only a redirect target, never authority (utility.cfc:302-310).
  const referer = request.headers.referer;
  return new AdminDenial(AuthDenial.forbidden(), {
    kind: 'back',
    location: referer !== undefined && referer !== '' ? referer : './',
  });
}

/** Response header carrying {@link SessionEffects} as JSON; web applies it to the session it persists. */
export const SESSION_EFFECTS_HEADER = 'x-opt2-session-effects';

/** Admin session values a handler set, by legacy name; a previous value is read only from a verified source keyed by the token's `sid`, never from request input. */
export interface SessionEffects {
  openSectionList?: string;
  /** `session.mura` values by name; null deletes one. */
  mura?: Readonly<Record<string, unknown>>;
}

const csrfRejections = new WeakSet<FastifyRequest>();

/** `validateCSRFTokens` for an admin branch: identity consumes the token; a refused one is recorded and the handler still runs. */
export function adminCsrf(contextOf: (request: FastifyRequest) => string): ReturnType<typeof csrfPreHandler> {
  return csrfPreHandler({
    contextOf,
    // Legacy validation returns false and the action skips only its write, so no 400 is answered.
    onReject: (request) => {
      csrfRejections.add(request);
    },
  });
}

/** Whether {@link adminCsrf} refused the request's token. */
export function csrfRejected(request: FastifyRequest): boolean {
  return csrfRejections.has(request);
}
