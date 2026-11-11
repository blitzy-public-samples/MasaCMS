// AdminRequest builders for gate, shell and screen tests: legacy post-set-up defaults, presets and the real builder path.
import {
  LOCAL_USER_TOKEN,
  Roles,
  hasAnyRole,
  isCoreModuleId,
  moduleRole,
  rolesForService,
  type Role,
  type UserClaims,
} from '@opt2/platform/auth';
import { businessClock } from '@opt2/platform/testing';
import { GATEWAY_CALLER, type WebAuth } from '@/lib/auth';
import { dateKeyFor, localeHasDayParts } from '@/lib/dates';
import {
  applyDefaults,
  buildAdminRequest,
  dashboardSpanFor,
  mergeFw1Context,
  nextSessionSite,
  requestScopes,
  resolveAction,
  type AdminMode,
  type AdminRequest,
  type AdminRequestInput,
  type AdminSessionState,
  type SiteData,
} from '@/lib/request-context';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from './fake-gateway';
import { SUBJECTS, syntheticSubject, userTokenFor, type WebTestSubject, type WebTestSubjectKey } from './tokens';

type SessionUser = AdminSessionState['mura'];
type SiteRecord = SiteData['record'];
type SessionSite = AdminRequest['adminSites'][number];

/** Values a partial replaces whole instead of merging member by member. */
type Whole =
  | string
  | number
  | boolean
  | null
  | undefined
  | Headers
  | ReadonlyMap<unknown, unknown>
  | readonly unknown[]
  | ((...args: never[]) => unknown);

/** `T` with every nested member optional; arrays, maps, headers and functions are replaced whole. */
export type DeepPartial<T> = unknown extends T
  ? T
  : T extends Whole
    ? T
    : { readonly [K in keyof T]?: DeepPartial<T[K]> };

/** Members `buildAdminRequest` computes from the claims and the action. */
type ComputedKey = 'action' | 'roles' | 'isLoggedIn' | 'isS2' | 'isSiteAdmin' | 'isPrivateUser' | 'modulePerm';

/** Session members `buildAdminRequest` computes from the locale and identity's memberships list. */
type ComputedSessionKey = 'dateKey' | 'dateKeyFormat' | 'localeHasDayParts' | 's2IsPrivate';

// Claim-derived flags and locale-derived date keys are not overridable, so they always come from verified claims
// and the real date code (the legacy date mask included); tests change the claims, `session.locale` or memberships.
/** Overrides of {@link makeAdminRequest}: `circuit`/`item` name the action, `user` overrides the subject's claims. */
export type AdminRequestPartial = DeepPartial<Omit<AdminRequest, ComputedKey | 'session'>> & {
  readonly session?: DeepPartial<Omit<AdminSessionState, ComputedSessionKey>>;
};

/** Locale `cf2Java` gives for the settings template's `Server` locale. */
const DEFAULT_LOCALE = 'en_US';

/** settings.template.cfm `sessionhistory`. */
const TEMPLATE_SESSION_HISTORY = 0;

/** Site Manager's `session.moduleid` default (carch `before()`), which the admin landing page sets. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

const EDIT_SITE_ACTION = 'core:csettings.editsite';
const SERVER_NAME = 'localhost';
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/** Cookies the admin set-up writes when absent, so every request after the first carries them. */
const SET_UP_COOKIES: ReadonlyArray<readonly [string, string]> = [
  ['rb', ''],
  ['ADMINCONTROLWIDTH', '300'],
  ['ADMINSIDEBAR', 'off'],
];

const SITE_NAMES: Readonly<Record<string, string>> = {
  default: 'Default',
  'tenant-a': 'Tenant A',
  'tenant-b': 'Tenant B',
  umbrella: 'Umbrella',
};

/** `iat` of every test user's claims: noon of the seed's business date. */
const TOKEN_IAT = Math.floor(businessClock().now().getTime() / 1000);

const CURRENT_SESSION_ROUTE = routeKey('GET', 'identity', '/v1/sessions/current');
const SESSION_SITES_ROUTE = routeKey('GET', 'identity', '/v1/sessions/current/sites');
const ADMIN_STATE_ROUTE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
const SAVE_ADMIN_STATE_ROUTE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
const shellSiteRoute = (siteId: string): string => routeKey('GET', 'programs-sites', `/v1/sites/${siteId}/shell`);

/** Cookie scope with lower-cased names and case-insensitive lookup, as the platform's parsed Cookie header holds it. */
class CookieScope extends Map<string, string> {
  override get(name: string): string | undefined {
    return super.get(name.toLowerCase());
  }

  override has(name: string): boolean {
    return super.has(name.toLowerCase());
  }

  override set(name: string, value: string): this {
    return super.set(name.toLowerCase(), value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeValue(base: unknown, partial: unknown): unknown {
  if (partial === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(partial)) return partial;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) merged[key] = mergeValue(merged[key], value);
  }
  return merged;
}

/** `base` with the defined members of `partial` laid over it, plain objects merged member by member. */
function deepMerge<T>(base: T, partial: DeepPartial<T> | undefined): T {
  return mergeValue(base, partial) as T;
}

const resolveSubject = (subject: WebTestSubject | WebTestSubjectKey): WebTestSubject =>
  typeof subject === 'string' ? SUBJECTS[subject] : subject;

const siteNameOf = (siteId: string): string => SITE_NAMES[siteId] ?? siteId;

const sessionSiteOf = (siteID: string): SessionSite => ({ siteID, site: siteNameOf(siteID) });

/**
 * The verified claims of `subject`'s local user token with `overrides` applied; undefined for `anonymous`.
 * @throws TypeError When `overrides` are given for `anonymous`, which has no token.
 */
export function subjectClaims(
  subject: WebTestSubject | WebTestSubjectKey,
  overrides?: DeepPartial<UserClaims>,
): UserClaims | undefined {
  const resolved = resolveSubject(subject);
  if (resolved.anonymous === true) {
    if (overrides !== undefined) throw new TypeError('The anonymous subject has no token claims to override');
    return undefined;
  }
  return deepMerge<UserClaims>(
    {
      iss: LOCAL_USER_TOKEN.issuer,
      aud: LOCAL_USER_TOKEN.audience,
      sub: resolved.sub,
      sid: resolved.sid,
      tid: resolved.tid,
      site: resolved.site,
      roles: [...resolved.roles],
      s2: resolved.s2,
      epoch: 0,
      iat: TOKEN_IAT,
      exp: TOKEN_IAT + LOCAL_USER_TOKEN.lifetimeSeconds,
    },
    overrides,
  );
}

type ClaimFlags = Pick<AdminRequest, Exclude<ComputedKey, 'action'>>;

// buildAdminRequest does not export its derivation; buildTestAdminRequest runs the real one for comparison.
/** Roles, flags and module permission derived from `user` exactly as `buildAdminRequest` derives them. */
function claimFlags(user: UserClaims | undefined): ClaimFlags {
  const roles = user?.roles ?? [];
  const isS2 = user?.s2 === true || roles.includes(Roles.s2);
  const isSiteAdmin = roles.includes(Roles.siteAdmin);
  return {
    roles,
    isLoggedIn: user !== undefined && user.sub !== '',
    isS2,
    isSiteAdmin,
    isPrivateUser: isS2 || roles.includes(Roles.systemUser),
    modulePerm: (moduleId) =>
      isS2 || isSiteAdmin || (isCoreModuleId(moduleId) && hasAnyRole(roles, [moduleRole(moduleId)])),
  };
}

/** Whether identity lists the sites a user administers (`listCurrentSessionSites` requires these roles). */
const listsSites = (flags: ClaimFlags): boolean =>
  flags.isLoggedIn && hasAnyRole(flags.roles, [Roles.systemUser, Roles.s2]);

/** Whether programs-sites serves `siteId` to the user, so the request carries its site data. */
const readsSite = (user: UserClaims | undefined, flags: ClaimFlags, siteId: string): boolean =>
  flags.isLoggedIn && (flags.isPrivateUser || flags.isSiteAdmin) && user?.site === siteId;

/** `session.mura` identity holds for `user`: the anonymous struct, or the user with loginByQuery's pool markers. */
function sessionUserOf(user: UserClaims | undefined, flags: ClaimFlags): SessionUser {
  if (user === undefined || !flags.isLoggedIn) return { isLoggedIn: false, userID: '' };
  const pool = flags.isPrivateUser ? 'S2IsPrivate' : 'S2IsPublic';
  const memberships = `${pool};${user.site},${pool}${flags.isS2 ? ',S2' : ''}`;
  return { isLoggedIn: true, userID: user.sub, siteID: user.site, memberships };
}

/** The `tsettings` row served for `siteId`: own pools, every flag off, no site locale. */
export function siteRecordFor(siteId: string): SiteRecord {
  return {
    SiteID: siteId,
    Site: siteNameOf(siteId),
    Domain: SERVER_NAME,
    siteLocale: '',
    publicUserPoolID: siteId,
    privateUserPoolID: siteId,
    displayPoolID: siteId,
    contentPoolID: siteId,
    categoryPoolID: siteId,
    filePoolID: siteId,
    hasChangesets: 0,
    hasComments: 0,
    feedManager: 0,
    EmailBroadcaster: 0,
    Extranet: 0,
    Cache: 0,
    enforcePrimaryDomain: 0,
    enableLockdown: '',
    lastDeployment: null,
  };
}

/** The site data `buildAdminRequest` reads from {@link siteRecordFor}`(siteId)` under the default locale. */
function siteDataFor(siteId: string): SiteData {
  return {
    siteid: siteId,
    site: siteNameOf(siteId),
    domain: SERVER_NAME,
    siteLocale: '',
    javaLocale: DEFAULT_LOCALE,
    publicUserPoolID: siteId,
    privateUserPoolID: siteId,
    displayPoolID: siteId,
    contentPoolID: siteId,
    categoryPoolID: siteId,
    filePoolID: siteId,
    hasChangesets: false,
    hasComments: false,
    hasFeedManager: false,
    emailBroadcaster: false,
    extranet: false,
    cache: false,
    enableLockdown: '',
    lastDeployment: null,
    record: siteRecordFor(siteId),
  };
}

/** Headers of a browser request the gateway forwarded over HTTP for `localhost`, carrying the set-up cookies. */
function requestHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers({
    'user-agent': CHROME_UA,
    'x-forwarded-host': SERVER_NAME,
    'x-forwarded-proto': 'http',
    cookie: SET_UP_COOKIES.map(([name, value]) => `${name}=${value}`).join('; '),
  });
  for (const [name, value] of new Headers(extra)) headers.set(name, value);
  return headers;
}

/** The `rc` overrides that carry a value, as name/value pairs. */
const definedPairs = (record: Readonly<Record<string, string | undefined>> = {}): Array<[string, string]> =>
  Object.entries(record).filter((entry): entry is [string, string] => entry[1] !== undefined);

/**
 * A complete request as the admin set-up leaves it for `subject` (default `anonymous`) on `<circuit>.<item>` (default
 * `home.redirect`), in a session that already holds its site, alerts and cookies; `partial` members replace the defaults.
 */
export function makeAdminRequest(
  partial: AdminRequestPartial = {},
  subject: WebTestSubject | WebTestSubjectKey = 'anonymous',
): AdminRequest {
  const {
    user: claimOverrides,
    session: sessionOverrides,
    site: siteOverrides,
    rc: rcOverrides,
    circuit: requestedCircuit = 'home',
    item: requestedItem = 'redirect',
    ...overrides
  } = partial;
  const user = subjectClaims(subject, claimOverrides);
  const flags = claimFlags(user);
  const muraAction = `${requestedCircuit}.${requestedItem}`;
  const action = resolveAction(mergeFw1Context([], { muraAction }, {}));
  const [circuit = '', item = ''] = (action.split(':').at(-1) ?? '').split('.');

  const requestedSite = sessionOverrides?.siteid ?? 'default';
  const change = nextSessionSite(requestedSite, '', () => true);
  if (change === undefined) throw new RangeError(`No session site for '${requestedSite}'`);
  const site =
    siteOverrides !== undefined || readsSite(user, flags, change.siteid)
      ? deepMerge<SiteData>(siteDataFor(change.siteid), siteOverrides)
      : undefined;
  const stored = deepMerge<Omit<AdminSessionState, ComputedSessionKey>>(
    {
      ...change,
      moduleid: CONTENT_MODULE_ID,
      keywords: '',
      rb: DEFAULT_LOCALE,
      locale: site?.javaLocale ?? DEFAULT_LOCALE,
      dashboardSpan: dashboardSpanFor(TEMPLATE_SESSION_HISTORY),
      // The set-up adds the session site's alert map on every request (admin/Application.cfc 405-406).
      alerts: { [change.siteid]: {} },
      paramArray: [],
      paramCount: 0,
      paramCircuit: '',
      paramCategories: '',
      paramGroups: '',
      inActive: '',
      membersOnly: 'false',
      visitorStatus: 'All',
      frontEndProxyLoc: '',
      siteArray: listsSites(flags) ? [change.siteid] : [],
      mura: sessionUserOf(user, flags),
      flash: {},
      nextPreserveKey: 1,
    },
    sessionOverrides,
  );
  const dateKey = dateKeyFor(stored.locale);
  const session: AdminSessionState = {
    ...stored,
    dateKey,
    dateKeyFormat: dateKey.dateKeyFormat,
    localeHasDayParts: localeHasDayParts(stored.locale),
    s2IsPrivate: (stored.mura.memberships ?? '').split(',').includes('S2IsPrivate'),
  };

  // FW/1 replaces rc.muraAction with the qualified action before the admin set-up runs (admin/framework.cfc 626-630).
  const rcBase: Record<string, string> =
    action === EDIT_SITE_ACTION ? { muraAction: action } : { muraAction: action, siteid: session.siteid };
  const base: AdminRequest = {
    mode: 'page',
    route: { circuit: requestedCircuit, action: requestedItem },
    action,
    circuit,
    item,
    rc: applyDefaults(mergeFw1Context([], rcBase, definedPairs(rcOverrides))),
    ses: false,
    currentUrl: `./?&muraAction=${muraAction}`,
    session,
    sessionWrites: {},
    site,
    adminSites: session.siteArray.map(sessionSiteOf),
    user,
    ...flags,
    cookies: new CookieScope(SET_UP_COOKIES),
    pendingSetCookies: [],
    headers: requestHeaders(),
    userAgent: CHROME_UA,
    isMSIE: false,
    https: false,
    serverName: SERVER_NAME,
    httpHost: SERVER_NAME,
  };
  return deepMerge<AdminRequest>(base, overrides);
}

/** An anonymous request: no user and no administered site. */
export function anonymousRequest(partial?: AdminRequestPartial): AdminRequest {
  return makeAdminRequest(partial, SUBJECTS.anonymous);
}

/** The installed S2 admin on `default`. */
export function adminS2Request(partial?: AdminRequestPartial): AdminRequest {
  return makeAdminRequest(partial, SUBJECTS.admin);
}

/** qa_editor on `default`: a system user with Site Manager module access only. */
export function editorRequest(partial?: AdminRequestPartial): AdminRequest {
  return makeAdminRequest(partial, SUBJECTS.qaEditor);
}

/** qa_editor on `default` under a token for tenant-a, so programs-sites serves no data for the session site. */
export function unservedEditorRequest(partial: AdminRequestPartial = {}): AdminRequest {
  const { site, tid } = SUBJECTS.siteAdmin;
  return makeAdminRequest({ ...partial, user: { ...partial.user, site, tid } }, SUBJECTS.qaEditor);
}

/** The tenant-a site admin, with `session.siteid` set to `siteId`. */
export function siteAdminRequest(siteId: string = SUBJECTS.siteAdmin.site, partial: AdminRequestPartial = {}): AdminRequest {
  return makeAdminRequest({ ...partial, session: { ...partial.session, siteid: siteId } }, SUBJECTS.siteAdmin);
}

/** A logged-in user administering no site: a private system user when `s2IsPrivate`, else a public member. */
export function noSitesRequest(
  { s2IsPrivate }: { readonly s2IsPrivate: boolean },
  partial: AdminRequestPartial = {},
): AdminRequest {
  const subject = s2IsPrivate ? SUBJECTS.systemUser : SUBJECTS.member;
  return makeAdminRequest({ ...partial, session: { ...partial.session, siteArray: [] } }, subject);
}

/** The tenant-a subject holding synthetic-module `role`, with `session.siteid` on its site. */
export function opt2RoleRequest(role: Role, partial: AdminRequestPartial = {}): AdminRequest {
  const subject = syntheticSubject(role);
  return makeAdminRequest({ ...partial, session: { siteid: subject.site, ...partial.session } }, subject);
}

/** Inputs of {@link buildTestAdminRequest}. */
export interface TestAdminRequestInput {
  /** Circuit of the web path; the URL scope's `muraAction` is `<circuit>.<action>`. */
  readonly circuit: string;
  readonly action: string;
  /** Further URL-scope fields; a `muraAction` here replaces the default one. */
  readonly query?: Readonly<Record<string, string>>;
  /** Body fields, sent as a redirect-mode request unless `mode` is given. */
  readonly form?: Readonly<Record<string, string>>;
  /** Defaults to `anonymous`. */
  readonly user?: WebTestSubjectKey;
  /** Gateway to seed; routes it already holds are kept. */
  readonly gateway?: FakeGatewayClient;
  /** Identity's session state: user-struct fields and the administered site ids. */
  readonly sessionState?: { readonly mura?: Partial<SessionUser>; readonly siteArray?: readonly string[] };
  /** Columns laid over the `tsettings` row of the requested site. */
  readonly site?: Partial<SiteRecord>;
  /** Headers laid over the default browser headers. */
  readonly headers?: HeadersInit;
  readonly mode?: AdminMode;
}

/**
 * The real `buildAdminRequest` for `input.user`'s verified claims, over a fake gateway seeded with identity's session
 * state and programs-sites' site rows built from the {@link makeAdminRequest} defaults.
 */
export async function buildTestAdminRequest(input: TestAdminRequestInput): Promise<AdminRequest> {
  const subject = input.user ?? 'anonymous';
  const user = subjectClaims(subject);
  const flags = claimFlags(user);
  const userToken = user === undefined ? undefined : await userTokenFor(subject, user);
  const gateway = input.gateway ?? fakeGatewayClient({}, { userToken });
  const searchParams = new URLSearchParams({ muraAction: `${input.circuit}.${input.action}` });
  for (const [name, value] of Object.entries(input.query ?? {})) searchParams.set(name, value);
  const form = input.form === undefined ? undefined : new URLSearchParams(input.form);
  const auth: WebAuth = { caller: { name: GATEWAY_CALLER, roles: rolesForService(GATEWAY_CALLER) }, user, userToken };
  const request: AdminRequestInput = {
    params: { circuit: input.circuit, action: input.action },
    searchParams,
    headers: requestHeaders(input.headers),
    form,
    auth,
    gateway,
    mode: input.mode ?? (form === undefined ? 'page' : 'redirect'),
  };
  // The requested site as the builder's merged context reads it; without one, the subject's own site.
  const scopes = requestScopes(request);
  const rcSiteId = mergeFw1Context(scopes.pathInfo, scopes.url, scopes.form)['siteid'] ?? '';
  const siteId = rcSiteId !== '' ? rcSiteId : (user?.site ?? 'default');
  const siteArray = input.sessionState?.siteArray ?? (listsSites(flags) ? [siteId] : []);
  const replies: Record<string, FakeReply> = {
    [CURRENT_SESSION_ROUTE]: {
      status: 200,
      body: {
        sessionId: user?.sid ?? null,
        epoch: user?.epoch ?? 0,
        user: { ...sessionUserOf(user, flags), ...input.sessionState?.mura },
        roles: flags.roles,
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [SESSION_SITES_ROUTE]: { status: 200, body: { sites: siteArray.map(sessionSiteOf) } },
    [ADMIN_STATE_ROUTE]: { status: 200, body: {} },
  };
  for (const id of new Set([siteId, user?.site ?? 'default', 'default'])) {
    const site = { ...siteRecordFor(id), ...(id === siteId ? input.site : {}) };
    replies[shellSiteRoute(id)] = { status: 200, body: { site, isNew: 0 } };
  }
  for (const [key, reply] of Object.entries(replies)) {
    if (!gateway.hasRoute(key)) gateway.setRoute(key, reply);
  }
  // Over a session that stored nothing, a save answers exactly the values it was given.
  if (!gateway.hasRoute(SAVE_ADMIN_STATE_ROUTE)) {
    gateway.setRoute(SAVE_ADMIN_STATE_ROUTE, (request) => ({ status: 200, body: request.json ?? {} }));
  }

  return buildAdminRequest(request);
}
