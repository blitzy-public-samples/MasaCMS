// The cUsers and cEditProfile controller gates of the people admin routes: role checks, `before()` defaults and scrubbing, denials.
import {
  AuthDenial,
  Roles,
  assertSiteMatches,
  hasAnyRole,
  moduleRole,
  renderAuthDenial,
  type UserClaims,
} from '@opt2/platform/auth';
import { cfEq, cfIsBoolean, cfIsNumeric, cfNumberString, cfToBoolean, javaTrim } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, sendLegacyResponse, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import { viewerScope, type ViewerScope } from '../domain/search.js';
import type { components } from '../generated/openapi.js';

export { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';

/** Merged request params as `legacyParamsOf` returns them; names match ignoring case. */
export type LegacyParams = Readonly<Record<string, unknown>>;

/** Where a refused gate sends the browser, in the contract's redirect shape. */
export type AdminDenialRedirect = components['schemas']['RouteRedirect'];

/** Users module role, which cUsers actions need on the site [legacy: admin/core/controllers/cusers.cfc:113-120]. */
const USERS_MODULE_ROLE = moduleRole('00000000000000000000000000000000008');

/** Site Manager module role, the site access paired with the Users module. */
const SITE_MANAGER_MODULE_ROLE = moduleRole('00000000000000000000000000000000000');

/** `config.opt2.requires` of every cUsers operation, as the contract's `x-opt2-requires` lists it. */
export const CUSERS_ROUTE_REQUIRES: readonly string[] = Object.freeze([Roles.s2, Roles.siteAdmin, USERS_MODULE_ROLE]);

/** `config.opt2.requires` of the edit-profile operations, as the contract's `x-opt2-requires` lists it. */
export const PROFILE_ROUTE_REQUIRES: readonly string[] = Object.freeze([
  Roles.systemUser,
  Roles.member,
  Roles.s2,
  Roles.siteAdmin,
]);

/** Legacy `rc.isAdmin`: member of the site's private-pool `Admin` group, or S2. */
export function isAdminViewer(claims: Pick<UserClaims, 'roles'>): boolean {
  return hasAnyRole(claims.roles, [Roles.siteAdmin, Roles.s2]);
}

/** Legacy `isSuperUser()`: S2. */
export function isSuperViewer(claims: Pick<UserClaims, 'roles'>): boolean {
  return hasAnyRole(claims.roles, [Roles.s2]);
}

// The gate's `cUsers.loadExtendedAttributes` exemption has no counterpart here: people serves no such operation.
/** The cUsers `before()` check: admin, or both the Users and Site Manager module grants on the site. */
export function cusersAccess(claims: Pick<UserClaims, 'roles'>): boolean {
  return (
    isAdminViewer(claims) ||
    (hasAnyRole(claims.roles, [USERS_MODULE_ROLE]) && hasAnyRole(claims.roles, [SITE_MANAGER_MODULE_ROLE]))
  );
}

/** The viewer the domain reads run as, from verified claims only. */
export function viewerScopeFor(claims: UserClaims): ViewerScope {
  return viewerScope(claims);
}

/** A simple CFML value as text; `''` for a complex or missing one. */
function simpleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** A JSON boolean literal; the scan re-serializes a padded one as `"YES"` or `"NO"`, which is no boolean. */
const JSON_BOOLEAN = /^(?:true|false)$/;

/**
 * A request value as admin start-up's Portcullis scan leaves it, when CFML `isBoolean` then accepts it; else undefined
 * [legacy: admin/Application.cfc:246-265, core/mura/Portcullis.cfc:113-192,373-400]. The scan drops NUL, keeps a
 * numeric or boolean value, re-serializes other JSON (ACF reads every char <= U+0020 as JSON whitespace) and trims the rest.
 */
function scannedBoolean(value: string): string | undefined {
  const text = value.replace(/\0/g, '');
  const trimmed = javaTrim(text);
  if (cfIsBoolean(text) || cfIsNumeric(text)) return trimmed;
  return !JSON_BOOLEAN.test(trimmed) && cfIsBoolean(trimmed) ? trimmed : undefined;
}

/** CFML `Val`: the number the text starts with, else 0. */
function cfmlVal(value: unknown): number {
  const number = Number.parseFloat(simpleText(value));
  return Number.isFinite(number) ? number : 0;
}

/** A CFML struct over request params: names match ignoring case and keep the spelling they first arrived with. */
class Scope {
  private readonly entries = new Map<string, [name: string, value: unknown]>();

  constructor(params: LegacyParams) {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) this.set(name, value);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  get(name: string): unknown {
    return this.entries.get(name.toLowerCase())?.[1];
  }

  text(name: string): string {
    return simpleText(this.get(name));
  }

  set(name: string, value: unknown): void {
    const key = name.toLowerCase();
    this.entries.set(key, [this.entries.get(key)?.[0] ?? name, value]);
  }

  delete(name: string): void {
    this.entries.delete(name.toLowerCase());
  }

  /** CFML `param`: the default only for an undefined name, in the order given. */
  param(defaults: ReadonlyArray<readonly [name: string, value: unknown]>): void {
    for (const [name, value] of defaults) {
      if (!this.has(name)) this.set(name, value);
    }
  }

  toRecord(): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    for (const [name, value] of this.entries.values()) {
      // Defined, not assigned, so a posted `__proto__` stays a data key.
      Object.defineProperty(record, name, { value, writable: true, enumerable: true, configurable: true });
    }
    return record;
  }
}

/** The `param` defaults of cUsers `before()`, in its order and spelling [legacy: admin/core/controllers/cusers.cfc:127-160]. */
const CUSERS_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = Object.freeze([
  ['error', {}],
  ['startrow', '1'],
  ['recordsperpage', '25'],
  ['userid', ''],
  ['routeid', ''],
  ['categoryid', ''],
  ['Type', '0'],
  ['ContactForm', '0'],
  ['isPublic', '1'],
  ['email', ''],
  ['jobtitle', ''],
  ['lastupdate', ''],
  ['lastupdateby', ''],
  ['lastupdatebyid', '0'],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['address', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['phone1', ''],
  ['phone2', ''],
  ['fax', ''],
  ['perm', '0'],
  ['groupid', ''],
  ['InActive', '0'],
  ['returnurl', ''],
  ['search', ''],
  ['newsearch', false],
  ['unassigned', '0'],
]);

// The view's group-query placeholder `rsGrouplist.recordcount` is left out: it is no request value and no save reads it.
/** The `param` defaults of cEditProfile `before()`, in its order and spelling [legacy: admin/core/controllers/ceditprofile.cfc:83-112]. */
const PROFILE_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = Object.freeze([
  ['Type', 0],
  ['ContactForm', 0],
  ['isPublic', 0],
  ['email', ''],
  ['jobtitle', ''],
  ['lastupdate', ''],
  ['lastupdateby', ''],
  ['lastupdatebyid', 0],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['address', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['phone1', ''],
  ['phone2', ''],
  ['fax', ''],
  ['perm', 0],
  ['groupid', ''],
  ['routeid', ''],
  ['InActive', 0],
  ['startrow', 1],
  ['categoryID', ''],
  ['error', {}],
  ['returnurl', ''],
]);

/** The cUsers request context after `before()`; `params` holds every request value with the defaults and scrubbed values. */
export interface CusersContext {
  readonly params: Readonly<Record<string, unknown>>;
  readonly siteid: string;
  readonly isAdmin: boolean;
  /** A CFML boolean; `1` unless an admin sent one. */
  readonly ispublic: string;
  /** A CFML boolean; `0` unless one was sent. */
  readonly unassigned: string;
  /** `1` when `unassigned` is false, else `0`. */
  readonly unassignedlink: 0 | 1;
  readonly startrow: number;
  readonly recordsperpage: number;
  readonly userid: string;
  readonly routeid: string;
  readonly categoryid: string;
  readonly groupid: string;
  readonly type: string;
  readonly returnurl: string;
  readonly search: string;
  readonly newsearch: string;
}

/** Options of {@link normaliseCusersParams}. */
export interface CusersParamsOptions {
  /** `listUsers` takes `siteid=all` from an S2 caller. */
  allowAllSites?: boolean;
}

/**
 * cUsers `before()` over the merged params: site fallback, `isAdmin`, `s2` kept for S2 only, defaults and scrubbing
 * [legacy: admin/core/controllers/cusers.cfc:90-170].
 * @throws AuthDenial 403 when a supplied `siteid` is not the token's site.
 */
export function normaliseCusersParams(
  params: LegacyParams,
  claims: UserClaims,
  { allowAllSites = false }: CusersParamsOptions = {},
): CusersContext {
  const rc = new Scope(params);
  const supplied = rc.text('siteid');
  if (supplied === '') {
    rc.set('siteid', claims.site !== '' ? claims.site : 'default');
  } else if (!(allowAllSites && cfEq(supplied, 'all') && isSuperViewer(claims))) {
    // Legacy lets any admin list `siteid=all`; every caller but S2 is held to the token's site. Routes declaring
    // `siteCheck: false` rely on this check.
    assertSiteMatches(supplied, claims);
  }

  const isAdmin = isAdminViewer(claims);
  rc.set('isAdmin', isAdmin);
  if (!isSuperViewer(claims)) rc.delete('s2');
  rc.param(CUSERS_DEFAULTS);

  rc.set('ispublic', (isAdmin ? scannedBoolean(rc.text('ispublic')) : undefined) ?? '1');
  rc.set('unassigned', scannedBoolean(rc.text('unassigned')) ?? '0');
  const unassignedlink = cfToBoolean(rc.get('unassigned')) ? 0 : 1;
  rc.set('unassignedlink', unassignedlink);
  const startrowVal = cfmlVal(rc.get('startrow'));
  const startrow = startrowVal < 1 ? 1 : startrowVal;
  rc.set('startRow', startrow);
  const recordsperpageVal = cfmlVal(rc.get('recordsperpage'));
  const recordsperpage = recordsperpageVal < 1 ? 25 : recordsperpageVal;
  rc.set('recordsperpage', recordsperpage);

  return {
    params: rc.toRecord(),
    siteid: rc.text('siteid'),
    isAdmin,
    ispublic: rc.text('ispublic'),
    unassigned: rc.text('unassigned'),
    unassignedlink,
    startrow,
    recordsperpage,
    userid: rc.text('userid'),
    routeid: rc.text('routeid'),
    categoryid: rc.text('categoryid'),
    groupid: rc.text('groupid'),
    type: rc.text('type'),
    returnurl: rc.text('returnurl'),
    search: rc.text('search'),
    newsearch: rc.text('newsearch'),
  };
}

/** cEditProfile `before()` defaults over the merged params; the request's own values win. */
export function normaliseProfileParams(params: LegacyParams): Record<string, unknown> {
  const rc = new Scope(params);
  rc.param(PROFILE_DEFAULTS);
  return rc.toRecord();
}

/** A refused controller gate: the contract's 401 or 403, and where legacy `secure()` redirects instead. */
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

/** The verified user of a logged-in session; the anonymous principal (`sub` '') is not logged in. */
function loggedInUser(request: FastifyRequest): UserClaims | undefined {
  const user = request.opt2Auth?.user;
  return user !== undefined && user.sub !== '' ? user : undefined;
}

/** `secure()` for an anonymous caller: `cLogin.main`, appending `compactDisplay` when it is a simple value. */
function loginDenial(request: FastifyRequest): AdminDenial {
  // `returnURL` is the browser's admin URL, which only web holds, so web appends it.
  const compactDisplay = new Scope(legacyParamsOf(request)).get('compactDisplay');
  const simple = ['string', 'number', 'boolean'].includes(typeof compactDisplay);
  return new AdminDenial(AuthDenial.unauthenticated('missing-credential'), {
    action: 'cLogin.main',
    params: simple ? { compactDisplay: simpleText(compactDisplay) } : {},
  });
}

/** `secure()` for a logged-in caller, `utility.backUp()`: the referrer, else `./` [legacy: core/mura/utility.cfc:302-310]. */
function backUpDenial(request: FastifyRequest): AdminDenial {
  const referer = request.headers.referer;
  return new AdminDenial(AuthDenial.forbidden(), { url: referer !== undefined && referer !== '' ? referer : './' });
}

/** The caller's claims when the cUsers gate admits them, else the denial `secure()` answers with. */
export function requireCusersAccess(request: FastifyRequest): UserClaims | AdminDenial {
  const user = loggedInUser(request);
  if (user === undefined) return loginDenial(request);
  return cusersAccess(user) ? user : backUpDenial(request);
}

/** The caller's claims when logged in, as cEditProfile `before()` requires, else the `secure()` login denial. */
export function requireLoggedIn(request: FastifyRequest): UserClaims | AdminDenial {
  return loggedInUser(request) ?? loginDenial(request);
}

/** Answers a denial as the auth hooks answer one: the route's `renderDenial`, else the legacy JSON API error. */
export async function sendAdminDenial(reply: FastifyReply, denial: AdminDenial): Promise<FastifyReply> {
  const { request } = reply;
  const render = request.routeOptions.config.opt2?.renderDenial ?? renderAuthDenial;
  return sendLegacyResponse(reply, await render(denial.auth, request));
}
