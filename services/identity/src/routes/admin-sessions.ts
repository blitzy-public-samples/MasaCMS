/**
 * Admin session routes: the current session, its administrable sites and stored admin values, `clogin.login`, `clogin.logout`,
 * CSRF token issue and the forgot-password mail [legacy: admin/core/controllers/clogin.cfc:82-118, core/mura/login/loginManager.cfc].
 */
import { AuthDenial, Roles, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  accessControlOriginDomains,
  adminUrl,
  cfIsBoolean,
  cfListToArray,
  cfToBoolean,
  deleteCookieLegacy,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { registryEntries, withTenant, type TenantDb, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import { issueTokens, type CsrfDeps } from '../domain/csrf.js';
import { LOGIN_SESSION_KEYS, login, logout, type LoginDeps } from '../domain/login.js';
import { sendLoginByEmail, type LoginMailDeps } from '../domain/login-mail.js';
import { groupListForSite, permittedGroups, type PermissionDeps } from '../domain/permissions.js';
import { ANONYMOUS_USER_STRUCT, moduleGrantHeld, modulePermByRole, roleListHas, userStructOf, type ModuleGroupGrant } from '../domain/roles.js';
import { ANONYMOUS_LOGIN_SNAPSHOT, locateSession, sessionAdminSite, type LocatedSession, type SessionDeps } from '../domain/sessions.js';
import type { components } from '../generated/openapi.js';
import { validateCsrfForRoute } from './internal-csrf.js';

type Schemas = components['schemas'];
type AdminState = Schemas['AdminSessionState'];
type LoginOutcome = Schemas['LoginOutcome'];
type Snapshot = Parameters<typeof userStructOf>[0];
type SessionRow = LocatedSession['row'];
type Rc = Readonly<Record<string, unknown>>;

/** The domain operations the admin session routes delegate to; `db` reads the site registry. */
export type AdminSessionRouteDeps = {
  login: LoginDeps;
  sessions: SessionDeps;
  csrf: CsrfDeps;
  loginMail: LoginMailDeps;
  permissions: PermissionDeps;
  db: TenantDb;
};

/** What `sanitizeHref` checks an absolute URL against; `siteDomain` is `getSite(siteId).getDomain()`. */
export interface HrefContext {
  /** The site named by the caller; `''` uses `sessionSiteId`, as legacy reads `session.siteid`. */
  siteId: string;
  sessionSiteId: string;
  /** settingsManager `getAccessControlOriginDomainList()` entries. */
  allowedDomains: readonly string[];
  siteDomain: (siteId: string) => string;
}

const PUBLIC: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true });

// The saved `siteid` is the session's selected site (`session.siteid`), not a site the request acts on, so it is not
// held to the token's site; the next token the gateway mints for that site carries only the roles it grants.
const ADMIN_STATE_SAVE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

// The site selector is read for private-pool users and S2 users only [legacy: admin/Application.cfc:432-440].
const SITES_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.systemUser, Roles.s2]) });

const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const DEFAULT_SITE_ID = 'default';
const LOGIN_CSRF_CONTEXT = 'login';

/** FW/1 `redirect(path="./")` addresses every admin redirect relative to the admin directory. */
const ADMIN_PATH = '.';

/** Cookies loginManager `logout()` deletes [legacy: core/mura/login/loginManager.cfc:507-508]. */
const REMEMBER_ME_COOKIES = ['userHash', 'userid'] as const;

/** ACF's error for `handleChallengeAttempt` without `session.mfa`, which only an MFA login sets [legacy: core/mura/login/loginManager.cfc:268]. */
const MFA_UNDEFINED = 'Element MFA.USERNAME is undefined in SESSIONDATA.';

const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

const TEXT = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const FORM_SCALAR = ['string', 'number', 'boolean'] as const;

// A repeated form field arrives as an array, which the CFML form scope holds comma-joined.
const LOGIN_BODY = {
  type: 'object',
  additionalProperties: { type: [...FORM_SCALAR, 'array'], items: { type: FORM_SCALAR } },
} as const;

const LOGIN_MAIL_BODY = { type: 'object', required: ['email'], properties: { email: TEXT, siteid: TEXT } } as const;

const CSRF_TOKENS_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['contexts'],
  properties: { contexts: { type: 'array', minItems: 1, items: TEXT } },
} as const;

const PARAM_CRITERION = {
  type: 'object',
  additionalProperties: false,
  required: ['Field', 'Relationship', 'Criteria', 'Condition'],
  properties: { Field: TEXT, Relationship: TEXT, Criteria: TEXT, Condition: TEXT },
} as const;

// The contract's AdminSessionState without the read-only `hasdefaultpassword`, which only login sets.
const ADMIN_STATE_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    siteid: TEXT,
    userFilesPath: TEXT,
    topID: TEXT,
    openSectionList: TEXT,
    moduleid: TEXT,
    keywords: TEXT,
    rb: TEXT,
    locale: TEXT,
    dateKeyFormat: TEXT,
    localeHasDayParts: { type: 'boolean' },
    dashboardSpan: INTEGER,
    paramArray: { type: 'array', items: PARAM_CRITERION },
    paramCount: INTEGER,
    paramCircuit: TEXT,
    paramCategories: TEXT,
    paramGroups: TEXT,
    inActive: TEXT,
    membersOnly: TEXT,
    visitorStatus: TEXT,
    frontEndProxyLoc: TEXT,
    flash: { type: 'object', additionalProperties: { type: 'object', additionalProperties: TEXT } },
    nextPreserveKey: INTEGER,
    moduleTopIds: { type: 'object', additionalProperties: TEXT },
    mura: { type: 'object', additionalProperties: true },
  },
} as const;

/** Every key of the contract's AdminSessionState; other stored values, such as login's `blockLoginUntil`, stay internal. */
const ADMIN_STATE_KEYS = Object.keys({
  siteid: true,
  userFilesPath: true,
  topID: true,
  openSectionList: true,
  moduleid: true,
  keywords: true,
  rb: true,
  locale: true,
  dateKeyFormat: true,
  localeHasDayParts: true,
  dashboardSpan: true,
  paramArray: true,
  paramCount: true,
  paramCircuit: true,
  paramCategories: true,
  paramGroups: true,
  inActive: true,
  membersOnly: true,
  visitorStatus: true,
  frontEndProxyLoc: true,
  flash: true,
  nextPreserveKey: true,
  hasdefaultpassword: true,
  moduleTopIds: true,
  mura: true,
} satisfies Record<keyof AdminState, true>) as ReadonlyArray<keyof AdminState>;

/** CFML `listFirst(s, delim)`: the first non-empty item, or `''`. */
function listFirst(s: string, delim: string): string {
  return cfListToArray(s, delim)[0] ?? '';
}

/** utility `parseDomain`: the host of `scheme://host…`, else the input [legacy: core/mura/utility.cfc:1326-1333]. */
function parseDomain(url: string): string {
  const match = /^\w+:\/\/([^/:]+)[\s\S]*$/.exec(url);
  const parsed = match?.[1] ?? url;
  return parsed.length > 1 && parsed.startsWith('//') ? listFirst(parsed.slice(2), '/') : parsed;
}

/**
 * utility `sanitizeHref`: a scheme-relative href becomes root-relative, `//host` runs are cut from an http(s) path, and an
 * http(s) host outside `allowedDomains` becomes the site's domain; anything else passes trimmed [legacy: core/mura/utility.cfc:1364-1441].
 * @throws RangeError For an http(s) URL whose path starts right after `://`, where ACF's `left(…, 0)` fails.
 */
export function sanitizeHref(href: string, ctx: HrefContext): string {
  let clean = javaTrim(href);
  if (clean === '') return href;
  if (clean.length > 1 && clean.startsWith('//')) {
    if (clean.length === 2) return '/';
    clean = clean.slice(2);
    return clean.startsWith('/') ? clean : `/${clean}`;
  }
  const scheme = listFirst(clean, ':');
  // roleListHas with ignoreCase is CFML listFindNoCase over a comma list.
  if (!roleListHas('http,https', scheme, { ignoreCase: true })) return clean;

  const siteDomain = ctx.siteDomain(ctx.siteId === '' ? ctx.sessionSiteId : ctx.siteId);
  const protocolEnd = clean.indexOf('://');
  if (protocolEnd >= 0) {
    const afterProtocol = clean.slice(protocolEnd + 3);
    const slashAt = afterProtocol.indexOf('/');
    if (slashAt === 0) throw new RangeError(`sanitizeHref: no host before the path of ${clean}`);
    if (slashAt > 0) {
      const pathPart = afterProtocol.slice(slashAt).replace(/\/\/[^/]+/g, '');
      clean = `${scheme}://${afterProtocol.slice(0, slashAt)}${pathPart}`;
    }
  }
  const urlDomain = parseDomain(clean);
  if (urlDomain !== '' && !roleListHas(ctx.allowedDomains.join(','), urlDomain, { ignoreCase: true })) {
    // CFML replace() swaps the first occurrence, case-sensitively, inserting the domain literally.
    clean = clean.replace(urlDomain, () => siteDomain);
  }
  return clean;
}

/** utility `removeLeadingDoubleSlash`: a trimmed `//x` becomes `/x` and exactly `//` becomes `/` [legacy: core/mura/utility.cfc:1443-1468]. */
export function removeLeadingDoubleSlash(url: string): string {
  let clean = javaTrim(url);
  if (clean.length > 1 && clean.startsWith('//')) {
    clean = clean.length > 2 ? clean.slice(2) : '';
    if (!clean.startsWith('/')) clean = `/${clean}`;
  }
  return clean;
}

/** ACF `URLEncodedFormat`: every character but ASCII letters and digits as `%XX` of its UTF-8 bytes; a lone surrogate as `?`. */
function urlEncodedFormat(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    const bytes = cp >= 0xd800 && cp <= 0xdfff ? [0x3f] : [...Buffer.from(ch, 'utf8')];
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** FW/1 `redirect(action, path="./")` without appended values. */
function adminRedirect(circuit: string, action: string): string {
  return adminUrl({ circuit, action, adminDir: ADMIN_PATH });
}

/** `rc[name]`, the name matched ignoring case as a CFML scope matches it. */
function rcValue(rc: Rc, name: string): unknown {
  const wanted = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : rc[key];
}

/** `rc[name]` as CFML text; `fallback` when absent. */
function rcText(rc: Rc, name: string, fallback: string): string {
  const value = rcValue(rc, name);
  return value === undefined || value === null ? fallback : String(value);
}

/** `isDefined('form.<name>')`: the posted body holds the field, its name matched ignoring case. */
function formHas(request: FastifyRequest, name: string): boolean {
  const { body } = request;
  return typeof body === 'object' && body !== null && Object.keys(body).some((key) => key.toLowerCase() === name);
}

/** `cgi.http_host` as the gateway forwards it: `X-Forwarded-Host` before the hop's own `Host`. */
function httpHostOf(request: FastifyRequest): string {
  const header = (name: string): string => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value.join(',') : (value ?? '')).trim();
  };
  return (header('x-forwarded-host') || header('host')).split(',')[0]?.trim() ?? '';
}

/** The verified user; every caller of these routes acts for a session. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** The verified user of a call that must also carry the caller's invocation credential. */
function relayedUserOf(auth: Opt2AuthContext): UserClaims {
  if (auth.service === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return userOf(auth);
}

/** The located session's row while it is active. */
function activeRow(located: LocatedSession | undefined): SessionRow | undefined {
  return located?.row.state === 'active' ? located.row : undefined;
}

/** The login-time snapshot of an active signed-in session. */
function signedInSnapshot(located: LocatedSession | undefined): Snapshot | undefined {
  const row = activeRow(located);
  if (row === undefined || row.user_id === null || row.login_snapshot === null) return undefined;
  return JSON.parse(row.login_snapshot) as Snapshot;
}

/** The session's epoch now; null without a session. */
async function epochOf(sessions: SessionDeps, sessionId: string | undefined): Promise<number | null> {
  if (!sessionId) return null;
  const located = await locateSession(sessions, sessionId);
  return located === undefined ? null : Number(located.row.epoch);
}

/** `session.blockLoginUntil` as login stored it; null when unset or empty [legacy: core/mura/user/userUtility.cfc:205,253]. */
function blockLoginUntilOf(adminState: string | null): string | null {
  if (adminState === null) return null;
  const value = (JSON.parse(adminState) as Record<string, unknown>)[LOGIN_SESSION_KEYS.blockLoginUntil];
  return typeof value === 'string' && LOCAL_TIMESTAMP.test(value) ? value : null;
}

/** `session.mura` as the contract carries it: without the stored password. */
function sessionUser(struct: Readonly<ReturnType<typeof userStructOf>> | typeof ANONYMOUS_USER_STRUCT): Schemas['SessionUser'] {
  return Object.fromEntries(Object.entries(struct).filter(([key]) => key !== 'password')) as Schemas['SessionUser'];
}

/** The user struct, login-time roles and login block of the token's session; anonymous values without one. */
async function currentSession(sessions: SessionDeps, user: UserClaims | undefined): Promise<Schemas['CurrentSession']> {
  const sessionId = user?.sid || null;
  const located = sessionId === null ? undefined : await locateSession(sessions, sessionId);
  const row = activeRow(located);
  const snapshot: Snapshot = row?.login_snapshot == null ? ANONYMOUS_LOGIN_SNAPSHOT : (JSON.parse(row.login_snapshot) as Snapshot);
  const signedIn = row !== undefined && row.user_id !== null;
  return {
    sessionId,
    epoch: located === undefined ? null : Number(located.row.epoch),
    user: sessionUser(signedIn ? userStructOf(snapshot) : ANONYMOUS_USER_STRUCT),
    roles: row === undefined ? [] : cfListToArray(snapshot.roleList),
    // The MFA challenge (session.mfa) is never started: MFA is off, as Masa's default configBean has it.
    mfaPending: false,
    blockLoginUntil: blockLoginUntilOf(row?.admin_state ?? null),
  };
}

/** The contract's admin values of a stored admin state. */
function adminStateOf(stored: Readonly<Record<string, unknown>>): AdminState {
  const state: Record<string, unknown> = {};
  for (const key of ADMIN_STATE_KEYS) if (Object.hasOwn(stored, key)) state[key] = stored[key];
  return state as AdminState;
}

/** `getSite(siteId).getDomain()` over the registry, with getSite's `default` fallback for an empty or unknown id. */
function siteDomainOf(entries: readonly TenantRegistryEntry[]): (siteId: string) => string {
  // getSite reads a ColdFusion struct, whose keys match ignoring case.
  const named = (id: string): TenantRegistryEntry | undefined => entries.find((entry) => entry.siteId.toLowerCase() === id.toLowerCase());
  return (siteId) => {
    const site = (siteId === '' ? undefined : named(siteId)) ?? named(DEFAULT_SITE_ID);
    if (site === undefined) throw new Error(`Neither site '${siteId}' nor the default site is registered`);
    return site.domains[0] ?? '';
  };
}

/** SQL Server equality of two `char(35)` ids: case-insensitive, trailing spaces ignored. */
function idKey(id: string): string {
  return id.replace(/ +$/, '').toLowerCase();
}

/** `getModulePerm` of the Site Manager module on `site` for the login-time role list [legacy: core/mura/permission.cfc:302-349]. */
async function siteManagerAccess(deps: PermissionDeps, snapshot: Snapshot, site: TenantRegistryEntry): Promise<boolean> {
  if (modulePermByRole(snapshot, site)) return true;
  const rows = await permittedGroups(deps, { siteId: site.siteId, contentId: SITE_MANAGER_MODULE });
  if (rows.length === 0) return false;
  const { privateGroups, publicGroups } = await groupListForSite(deps, site.siteId);
  const groups = new Map([...privateGroups, ...publicGroups].map((group) => [idKey(group.userid), group]));
  const grants = rows.flatMap((row): ModuleGroupGrant[] => {
    const group = groups.get(idKey(row.groupid));
    return group === undefined ? [] : [{ moduleId: SITE_MANAGER_MODULE, groupName: group.groupname, isPublic: group.ispublic }];
  });
  return moduleGrantHeld(snapshot, site, SITE_MANAGER_MODULE, grants);
}

/** The login values loginManager `login()` defaults [legacy: core/mura/login/loginManager.cfc:333-339]. */
interface LoginData {
  returnUrl: string;
  rememberMe: string;
  contentid: string;
  linkServID: string;
  isAdminLogin: string;
  compactDisplay: string;
}

/** The login values of `rc`, absent ones defaulted as login() params them. */
function loginDataOf(rc: Rc): LoginData {
  return {
    returnUrl: rcText(rc, 'returnUrl', ''),
    rememberMe: rcText(rc, 'rememberMe', '0'),
    contentid: rcText(rc, 'contentid', ''),
    linkServID: rcText(rc, 'linkServID', ''),
    isAdminLogin: rcText(rc, 'isAdminLogin', 'false'),
    compactDisplay: rcText(rc, 'compactDisplay', 'false'),
  };
}

/** loginManager `handleSuccess` redirect target; S2IsPrivate users get the same target [legacy: core/mura/login/loginManager.cfc:110-156]. */
async function successLocation(db: TenantDb, data: LoginData, sessionSiteId: string): Promise<string> {
  if (data.returnUrl === '') return data.linkServID === '' ? './' : `./?LinkServID=${data.linkServID}`;
  const entries = await registryEntries(db);
  const allowedDomains = accessControlOriginDomains(entries.map((entry) => ({ domain: entry.domains.join(',') })), {});
  return sanitizeHref(data.returnUrl.replaceAll('doaction=logout', ''), { siteId: '', sessionSiteId, allowedDomains, siteDomain: siteDomainOf(entries) });
}

/**
 * loginManager `handleFailure` redirect target of an admin login [legacy: core/mura/login/loginManager.cfc:236-241].
 * @throws Error For a login without `isAdminLogin`, whose target is the site's `loginURL`, a site setting identity does not hold.
 */
function failureLocation(data: LoginData): string {
  if (!cfToBoolean(data.isAdminLogin)) {
    throw new Error('A failed login without isAdminLogin redirects to the site loginURL, which identity does not hold');
  }
  return (
    `./?muraAction=cLogin.main&display=login&status=failed&rememberMe=${data.rememberMe}&contentid=${data.contentid}` +
    `&LinkServID=${data.linkServID}&returnURL=${urlEncodedFormat(data.returnUrl)}&compactDisplay=${urlEncodedFormat(data.compactDisplay)}`
  );
}

/** clogin `login()`: CSRF check under context `login`, then the credential login of the form's username and password [legacy: admin/core/controllers/clogin.cfc:101-113]. */
async function clogin(deps: AdminSessionRouteDeps, request: FastifyRequest): Promise<LoginOutcome> {
  const { sessions } = deps;
  const sessionId = request.opt2Auth.user?.sid;
  if (!sessionId || !(await validateCsrfForRoute({ csrf: deps.csrf }, request, LOGIN_CSRF_CONTEXT))) {
    return { outcome: 'csrf-invalid', location: adminRedirect('clogin', 'main'), epoch: await epochOf(sessions, sessionId) };
  }
  const rc = legacyParamsOf(request);
  const attemptChallenge = rcValue(rc, 'attemptChallenge');
  if (cfIsBoolean(attemptChallenge) && cfToBoolean(attemptChallenge)) throw new TypeError(MFA_UNDEFINED);
  // Without both credentials the controller runs nothing and the login view renders.
  if (!formHas(request, 'username') || !formHas(request, 'password')) {
    return { outcome: 'unattempted', location: '', epoch: await epochOf(sessions, sessionId) };
  }
  const sessionSiteId = await sessionAdminSite(sessions, sessionId);
  // The admin set-up fills an empty rc.siteid from session.siteid, which itself defaults to `default` [legacy: admin/Application.cfc:384-412].
  const siteId = rcText(rc, 'siteid', '') || sessionSiteId || DEFAULT_SITE_ID;
  const data = loginDataOf(rc);
  // The session id is kept across the login, as legacy keeps it (no rotation).
  const result = await login(deps.login, {
    username: rcText(rc, 'username', ''),
    password: rcText(rc, 'password', ''),
    siteId,
    sessionId,
    mode: 'target-primary',
  });
  if (result.ok) return { outcome: 'success', location: await successLocation(deps.db, data, sessionSiteId), epoch: result.session.epoch };
  return {
    outcome: result.reason === 'blocked' ? 'blocked' : 'failed',
    location: failureLocation(data),
    epoch: await epochOf(sessions, sessionId),
  };
}

/** Registers the session, site list, admin state, login, logout, CSRF token and login-mail routes of the admin screens. */
export async function registerAdminSessionRoutes(app: FastifyInstance, deps: AdminSessionRouteDeps): Promise<void> {
  const { sessions } = deps;

  // [legacy: core/mura/user/userUtility.cfc:749-801, admin/core/views/clogin/main.cfm:104-106]
  app.get<{ Reply: Schemas['CurrentSession'] }>('/v1/sessions/current', { config: { opt2: PUBLIC } }, async (request) =>
    currentSession(sessions, request.opt2Auth.user),
  );

  // session.siteArray: the sites whose Site Manager the session may use [legacy: admin/Application.cfc:432-440].
  app.get<{ Reply: Schemas['SessionSites'] }>('/v1/sessions/current/sites', { config: { opt2: SITES_AUTH } }, async (request) => {
    const user = userOf(request.opt2Auth);
    const snapshot = signedInSnapshot(await locateSession(sessions, user.sid));
    if (snapshot === undefined) return { sites: [] };
    const sites: Schemas['SessionSites']['sites'] = [];
    for (const entry of await registryEntries(deps.db)) {
      if (!(await siteManagerAccess(deps.permissions, snapshot, entry))) continue;
      sites.push({ siteID: entry.siteId, site: (await deps.loginMail.settings.site(entry.siteId)).site });
    }
    return { sites };
  });

  app.get<{ Reply: AdminState }>('/v1/sessions/current/admin-state', { config: { opt2: PUBLIC } }, async (request) => {
    const user = relayedUserOf(request.opt2Auth);
    const located = await locateSession(sessions, user.sid);
    if (located === undefined || located.row.state !== 'active') return {};
    const stored = await withTenant(sessions.db, located.tenantId, (tx) => sessions.repo.readSessionAdminState(tx, user.sid));
    return adminStateOf(stored ?? {});
  });

  app.post<{ Body: AdminState; Reply: AdminState }>(
    '/v1/sessions/current/admin-state',
    { schema: { body: ADMIN_STATE_BODY }, config: { opt2: ADMIN_STATE_SAVE_AUTH } },
    async (request) => {
      const user = relayedUserOf(request.opt2Auth);
      const located = await locateSession(sessions, user.sid);
      const merged =
        located === undefined
          ? null
          : await withTenant(sessions.db, located.tenantId, async (tx) => {
              const row = await sessions.repo.lockSession(tx, user.sid, 'update');
              return row?.state === 'active' ? sessions.repo.mergeSessionAdminState(tx, user.sid, request.body) : null;
            });
      // The token names a session that no longer exists or has ended, so there is no session to store into.
      if (merged === null) throw AuthDenial.unauthenticated('invalid-credential');
      return adminStateOf(merged);
    },
  );

  app.post<{ Body: Record<string, unknown>; Reply: LoginOutcome }>(
    '/v1/sessions/login',
    { schema: { body: LOGIN_BODY }, config: { opt2: PUBLIC } },
    async (request) => clogin(deps, request),
  );

  // clogin `logout()` checks no CSRF token [legacy: admin/core/controllers/clogin.cfc:115-118, core/mura/login/loginManager.cfc:476-516].
  app.post<{ Reply: Schemas['LogoutResult'] }>('/v1/sessions/logout', { config: { opt2: PUBLIC } }, async (request, reply) => {
    const sessionId = request.opt2Auth.user?.sid;
    // Ending the session bumps its epoch, on which the gateway ends the legacy session and drops its cookie jar.
    if (sessionId) await logout(deps.login, sessionId);
    const now = sessions.clock.now();
    reply.header('set-cookie', REMEMBER_ME_COOKIES.map((name) => deleteCookieLegacy(name, {}, now)));
    return { redirect: { action: 'home.redirect', params: {} } };
  });

  // renderCSRFTokens: one token per context under the session's secret [legacy: core/mura/user/sessionUserFacade.cfc:237-252].
  app.post<{ Body: Schemas['CsrfTokensRequest']; Reply: Schemas['CsrfTokenSet'] }>(
    '/v1/csrf/tokens',
    { schema: { body: CSRF_TOKENS_BODY }, config: { opt2: PUBLIC } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const row = activeRow(await locateSession(sessions, user.sid));
      if (row === undefined) throw AuthDenial.unauthenticated('invalid-credential');
      const tokens = request.body.contexts.map((context) => {
        const issued = issueTokens({ csrfSecret: row.csrf_secret }, { context, clock: deps.csrf.clock });
        return { context, csrf_token: issued.token, csrf_token_expires: issued.expires };
      });
      return { tokens };
    },
  );

  // The login screen's forgot-password form checks no CSRF token and always shows `login.messagesent` [legacy: admin/core/views/clogin/main.cfm:303-312].
  app.post<{ Body: Schemas['LoginMailRequest']; Reply: Schemas['LoginMailResult'] }>(
    '/v1/login-mail',
    { schema: { body: LOGIN_MAIL_BODY }, config: { opt2: PUBLIC } },
    async (request) => {
      const rc = legacyParamsOf(request);
      await sendLoginByEmail(deps.loginMail, { email: rcText(rc, 'email', ''), siteId: rcText(rc, 'siteid', ''), httpHost: httpHostOf(request) });
      return { status: 'messagesent' };
    },
  );
}
