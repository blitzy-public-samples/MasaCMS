// Stand-in for LEGACY_ORIGIN: ColdFusion sessions, the bridge's session.cfm and site.cfm's paths, Version menu and static-path check behind its assertion guard, and echoed pages.
import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';
import {
  BRIDGE_ASSERTION_HEADER,
  LEGACY_SESSION_COOKIE_NAMES,
  MemoryNonceStore,
  cfDateTimeFormat,
  cfUuid,
  jsessionidForSessionId,
  parseCookieHeader,
  purgeUsedTokens,
  sessionCookieStrings,
  strictLocalInstant,
  verifyBridgeAssertion,
  type BridgeAssertionPayload,
} from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import type {
  CarryResult,
  EndResult,
  ExportResult,
  ExportedValue,
  HydrateResult,
  LegacyPlugin,
  LegacyVersionMenu,
  MarkUsedResult,
  UsedSinceResult,
} from '../../src/session/bridge-client.js';
import type { LegacyDescribe, LegacyDescribeUser, LegacyUsedToken } from '../../src/session/identity-client.js';
import { TEST_BRIDGE_KEY, TEST_CLOCK } from './env.js';
import {
  createInProcessDouble,
  sendBytes,
  sendJson,
  startHttpDouble,
  type DoubleHandler,
  type HttpDouble,
  type InProcessDouble,
  type RecordedRequest,
} from './http-double.js';

/** Path of the bridge's session page. */
export const BRIDGE_SESSION_PATH = '/gateway/legacy-bridge/cfml/session.cfm';

/** Path of the bridge's site page, of which the double serves `op=paths`, `op=versionMenu`, `op=plugins` and `op=static`. */
export const BRIDGE_SITE_PATH = '/gateway/legacy-bridge/cfml/site.cfm';

/** `site.cfm?op=plugins` as legacy answers it with the GS-PS-10 golden plugin deployed. */
export const LEGACY_PLUGINS: LegacyPlugin[] = [
  {
    moduleId: '88C48C97-ADFA-018D-66EAB47267C52ED2',
    name: 'GS-PS-10 Plugin',
    directory: '1',
    category: 'Utility',
    version: '1.0.0',
    provider: 'OPT-2 golden harness',
    providerUrl: 'https://opt2.invalid/golden-plugin',
    pluginId: '1',
  },
];

/** `site.cfm?op=versionMenu` as the ACF 2023 oracle answers it, without `server.java`. */
export const LEGACY_VERSION_MENU: LegacyVersionMenu = {
  appServerProductName: 'ColdFusion Server',
  appServerVersion: '2023,0,26,331018',
  dbProductName: 'Microsoft SQL Server',
  dbProductVersion: 'Microsoft SQL Server 2022 - 16.0.4305.5',
  javaVersion: null,
  osName: 'UNIX',
  osVersion: '6.12.105+',
};

/** Every other path under this prefix answers a bodiless 404. */
const BRIDGE_PREFIX = '/gateway/legacy-bridge/';
const ASSERTION_HEADER = BRIDGE_ASSERTION_HEADER.toLowerCase();

/** The `session.mura` user keys describe reports, in session.cfm's order. */
const USER_KEYS = [
  'userID',
  'username',
  'siteID',
  'subtype',
  'password',
  'fname',
  'lname',
  'email',
  'remoteID',
  'company',
  'lastlogin',
  'passwordCreated',
] as const satisfies readonly (keyof LegacyDescribeUser)[];

/** User keys that hold a datetime, carried as wire times. */
const TIME_KEYS: ReadonlySet<string> = new Set(['lastlogin', 'passwordCreated']);

/** Wire time with a `T` or space separator and 0-3 fraction digits, as Application.cfc's parseLegacyTime accepts it. */
const WIRE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/** One of `CFID`, `CFTOKEN` and `JSESSIONID`. */
export type LegacySessionCookieName = (typeof LEGACY_SESSION_COOKIE_NAMES)[number];

/** One ColdFusion session the double holds. */
export interface LegacySession {
  /** `session.sessionid`: describe's `sessionId` and the assertion's `sid`. */
  legacySessionId: string;
  cfid: string;
  cftoken: string;
  jsessionid: string;
  isLoggedIn: boolean;
  /** `session.mura` user keys; `lastlogin` and `passwordCreated` hold a Date or `""`. */
  user: Record<string, unknown>;
  memberships: string;
  membershipIds: string;
  csrfSecretKey: string;
  /** `session.mura.csrfusedtokens`: token to the time it was used. */
  used: Map<string, Date>;
  /** `session.siteid`. */
  siteId: string;
  /** Set by `op=end`; an ended session's cookies attach nothing. */
  ended: boolean;
  /** Successful `op=hydrate` calls. */
  hydrations: number;
  /** Top-level session keys besides `siteid`, such as `flatViewArgs`; `mura.<key>` shared values live in `user`. */
  values: Record<string, unknown>;
  /** `session.opt2Carried`: the revision and JSON text `op=carry` installed last, by shared name. */
  carried: Map<string, CarriedRecord>;
}

/** One `session.opt2Carried` entry. */
export interface CarriedRecord {
  revision: string;
  json: string;
}

/** A new session with its legacy `Set-Cookie` values and the `Cookie` header that attaches it. */
export interface CreatedSession {
  session: LegacySession;
  setCookies: string[];
  cookieHeader: string;
  /** The session cookies by name, in the shape the bridge client's `LegacyCookies` take. */
  cookies: Record<LegacySessionCookieName, string>;
}

/** One call to `session.cfm`, accepted or refused. */
export interface BridgeCall {
  /** The URL `op`; `""` when absent. */
  op: string;
  /** The verified assertion; absent when the guard refused the call. */
  payload?: BridgeAssertionPayload;
  /** The session the cookies attached, or the one started for the call. */
  legacySessionId?: string;
  status: number;
  /** The JSON answered; undefined for the guard's bodiless 403. */
  body: unknown;
  /** The request as recorded in `requests`, for ordering against page requests. */
  request: RecordedRequest;
}

/** One verified `site.cfm?op=paths` call and its answer. */
export interface SitePathsCall {
  status: number;
  body: unknown;
  request: RecordedRequest;
}

/** One verified `site.cfm?op=static` call: the path it asked about and the answer. */
export interface StaticPathCall {
  path: unknown;
  status: number;
  body: unknown;
  request: RecordedRequest;
}

/** The default answer to a page request: what reached legacy, as legacy received it. */
export interface LegacyEcho {
  method: string;
  path: string;
  url: string;
  query: Record<string, string | string[]>;
  host: string | null;
  forwarded: { for: string | null; proto: string | null; host: string | null };
  authorization: string | null;
  /** The raw `Cookie` header. */
  cookie: string | null;
  /** `Cookie` pairs by lower-cased name. */
  cookies: Record<string, string>;
  contentType: string | null;
  bodyBase64: string;
  bodyText: string;
}

/** A programmed answer to a page request; an omitted field keeps the default echo's. */
export interface LegacyResponseSpec {
  status?: number;
  /** Headers as sent; an array value repeats the header. */
  headers?: Record<string, string | string[]>;
  /** Bytes or text sent unchanged; any other object as JSON. */
  body?: Buffer | string | object;
  /** Extra `Set-Cookie` values, or `'session'` for the attached session's legacy cookies. */
  setCookies?: string[] | 'session';
  /** Milliseconds to wait before answering; `close()` cancels the wait. */
  delayMs?: number;
  /** Headers written after `headers` byte for byte, one latin1 byte per character, bytes Node's validation refuses included. */
  rawHeaders?: Record<string, string>;
}

/** Computes the answer to one page request from the request and the session it attached. */
export type LegacyResponder = (
  req: RecordedRequest,
  session: LegacySession | undefined,
) => LegacyResponseSpec | Promise<LegacyResponseSpec>;

/** Options of {@link startLegacyOrigin} and {@link createInProcessLegacyOrigin}. */
export interface LegacyOriginOptions {
  /** A request attaching no session starts one and sets its cookies, as ColdFusion does; default true. */
  autoCreateSession?: boolean;
  /** Key bridge assertions must verify with; default {@link TEST_BRIDGE_KEY}. */
  bridgeKey?: string;
  /** Clock of assertion checks, ledger times and `serverTime`; default {@link TEST_CLOCK}. */
  clock?: Clock;
}

/** The legacy origin double: an {@link HttpDouble} plus its sessions, bridge calls and programmed answers. */
export type LegacyOrigin = HttpDouble & {
  /** Sessions by `legacySessionId`, ended ones included. */
  sessions: Map<string, LegacySession>;
  bridgeCalls: BridgeCall[];
  /** Creates a session as a first browser visit leaves it; `partial` overrides any field. */
  createSession(partial?: Partial<LegacySession>): CreatedSession;
  /** The `Cookie` header that attaches the session. */
  sessionCookieHeader(session: LegacySession | string): string;
  /** Programs page answers; without an argument the default echo is restored. */
  setResponse(response?: LegacyResponseSpec | LegacyResponder): void;
  /** The session's next page request uses `token` as a validating legacy action would. */
  consumeTokenDuringNextRequest(legacySessionId: string, token: string): void;
  /** The session's used-token ledger in wire form. */
  usedTokens(legacySessionId: string): LegacyUsedToken[];
  /**
   * Verified `site.cfm?op=paths` calls. Each value is `<scheme>://<Host>` based, the scheme `https` when
   * `X-Forwarded-Proto` is `https`, and is kept from its first call per site, as legacy's site beans keep it.
   */
  sitePathsCalls: SitePathsCall[];
  /** Forgets every kept path value, as a rebuild of legacy's site beans does. */
  resetSitePaths(): void;
  /** Makes `op=paths` answer `status` with a `serverError` body; without an argument it answers values again. */
  failSitePaths(status?: number): void;
  /** Programs the answer of `site.cfm?op=versionMenu`; without an argument it answers {@link LEGACY_VERSION_MENU} again. */
  setVersionMenuAnswer(answer?: { status: number; body: object }): void;
  /** Programs the answer of `site.cfm?op=plugins`; without an argument it answers {@link LEGACY_PLUGINS} again. */
  setPluginsAnswer(answer?: { status: number; body: object }): void;
  /** Decoded paths of the regular files the container serves without CFML; `op=static` answers `cfml: false` only for these. */
  staticFiles: Set<string>;
  /** Verified `site.cfm?op=static` calls. */
  staticCalls: StaticPathCall[];
  /** Makes `op=static` answer `status` with a `serverError` body; without an argument it answers again. */
  failStatic(status?: number): void;
};

/** The legacy origin double served in process through its `fetch`, with no socket. */
export type InProcessLegacyOrigin = Omit<LegacyOrigin, 'port'> & Pick<InProcessDouble, 'fetch'>;

/** What the legacy origin double adds to the double that serves it. */
type LegacyOriginMembers = Omit<LegacyOrigin, keyof HttpDouble>;

/** A bridge error answer `{error, message}` with its status, as Application.cfc's raise() throws it. */
class BridgeFail extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

/** Context of one verified session op. */
interface OpContext {
  req: RecordedRequest;
  payload: BridgeAssertionPayload;
  /** The session ColdFusion attached or started; undefined when none could be. */
  session: LegacySession | undefined;
  now: Date;
}

/** Stores `res`'s head, `headers` and then `raw` as given, each `raw` value one latin1 byte per character, which no header validation reads. */
function writeRawHeaders(res: ServerResponse, status: number, headers: Record<string, string | string[]>, raw: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  const lines = Object.entries(raw).map(([name, value], index) => ({ name, value, placeholder: `opt2-raw-${String(index)}` }));
  for (const { name, placeholder } of lines) res.setHeader(name, placeholder);
  res.writeHead(status);
  const stored = res as ServerResponse & { _header: string };
  for (const { name, value, placeholder } of lines) stored._header = stored._header.replace(`${name}: ${placeholder}\r\n`, () => `${name}: ${value}\r\n`);
}

/** Bridge wire time `yyyy-mm-ddTHH:nn:ss.lll` in the process zone, as Application.cfc's formatLegacyTime writes it. */
export function formatWireTime(d: Date): string {
  return `${cfDateTimeFormat(d, 'yyyy-mm-dd')}T${cfDateTimeFormat(d, 'HH:nn:ss.lll')}`;
}

/** Parses a wire time in the process zone; undefined where Application.cfc's parseLegacyTime answers 400. */
export function parseWireTime(text: string): Date | undefined {
  const match = WIRE_TIME.exec(text.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((match[7] ?? '').padEnd(3, '0'));
  const instant = strictLocalInstant({ year, month, day, hour, minute, second, ms });
  return instant === undefined ? undefined : new Date(instant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CFML isSimpleValue for a JSON value. */
function isSimple(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The entry of `key` matched without case, as CFML struct keys match; undefined when absent. */
function structEntry(struct: Readonly<Record<string, unknown>>, key: string): [string, unknown] | undefined {
  const wanted = key.toLowerCase();
  return Object.entries(struct).find(([name]) => name.toLowerCase() === wanted);
}

/** The value of `key` matched without case; undefined when absent. */
function structValue(struct: Readonly<Record<string, unknown>>, key: string): unknown {
  return structEntry(struct, key)?.[1];
}

/** structKeyExists on a used-token ledger, whose CFML keys match without case. */
function hasToken(ledger: ReadonlyMap<string, Date>, token: string): boolean {
  const wanted = token.toLowerCase();
  for (const key of ledger.keys()) if (key.toLowerCase() === wanted) return true;
  return false;
}

/** A URL parameter as the CFML url scope holds it: repeated values as a comma list, `""` when absent. */
function queryValue(req: RecordedRequest, name: string): string {
  if (!Object.hasOwn(req.query, name)) return '';
  const value = req.query[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

/** A request header as one string, or null when absent. */
function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

function badRequest(message: string): BridgeFail {
  return new BridgeFail(400, 'badRequest', message);
}

/** Raises 400 badRequest unless the request uses `method`. */
function requireMethod(req: RecordedRequest, method: 'GET' | 'POST'): void {
  if (req.method !== method) throw badRequest(`method must be ${method}`);
}

/** A wire time parsed, or 400 badRequest. */
function requireTime(text: string): Date {
  const at = parseWireTime(text);
  if (at === undefined) throw badRequest('invalid time');
  return at;
}

/** The session the op runs in; without one the assertion's `sid` cannot name it, so 409 sessionMismatch. */
function attachedSession(ctx: OpContext): LegacySession {
  if (ctx.session === undefined) throw new BridgeFail(409, 'sessionMismatch', 'assertion sid differs from the session');
  return ctx.session;
}

/** The attached session when the assertion's `sid` names it, else 409 sessionMismatch. */
function requireSession(ctx: OpContext): LegacySession {
  const session = attachedSession(ctx);
  if (ctx.payload.sid !== session.legacySessionId) {
    throw new BridgeFail(409, 'sessionMismatch', 'assertion sid differs from the session');
  }
  return session;
}

/** The JSON object body, `{}` when empty; 400 badRequest otherwise. */
function readJsonBody(req: RecordedRequest): Record<string, unknown> {
  const text = req.body.toString('utf8');
  if (text === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('invalid JSON body');
  }
  if (!isRecord(body)) throw badRequest('invalid JSON body');
  return body;
}

/** A token to used-time ledger from `[{token, usedAt}]`; empty tokens are skipped and the first occurrence wins. */
function readLedger(entries: unknown, field: string): Map<string, Date> {
  if (!Array.isArray(entries)) throw badRequest(`${field} must be an array`);
  const ledger = new Map<string, Date>();
  for (const entry of entries as unknown[]) {
    const token = isRecord(entry) ? structValue(entry, 'token') : undefined;
    const usedAt = isRecord(entry) ? structValue(entry, 'usedAt') : undefined;
    if (!isSimple(token) || !isSimple(usedAt)) throw badRequest(`${field} entries need token and usedAt`);
    const key = String(token);
    if (key !== '' && !hasToken(ledger, key)) ledger.set(key, requireTime(String(usedAt)));
  }
  return ledger;
}

/** `[{token, usedAt}]` over the ledger entries used at or after `sinceMs`. */
function ledgerEntries(ledger: ReadonlyMap<string, Date>, sinceMs = Number.NEGATIVE_INFINITY): LegacyUsedToken[] {
  return [...ledger]
    .filter(([, at]) => at.getTime() >= sinceMs)
    .map(([token, at]) => ({ token, usedAt: formatWireTime(at) }));
}

/** The user keys as `setUserStruct()` leaves a logged-out session (userUtility.cfc:785-801). */
function loggedOutUser(): Record<string, unknown> {
  return Object.fromEntries(USER_KEYS.map((key) => [key, key === 'subtype' ? 'Default' : '']));
}

/** A datetime user value as a wire time, `""` when it is none. */
function wireTimeOf(value: unknown): string {
  if (value instanceof Date) return formatWireTime(value);
  const parsed = typeof value === 'string' ? parseWireTime(value) : undefined;
  return parsed === undefined ? '' : formatWireTime(parsed);
}

/** Describe's `user`: absent keys take the logged-out defaults, datetimes become wire times. */
function describeUser(user: Readonly<Record<string, unknown>>): LegacyDescribeUser {
  const field = (key: (typeof USER_KEYS)[number]): string => {
    const value = structValue(user, key);
    if (TIME_KEYS.has(key)) return wireTimeOf(value);
    if (value === undefined) return key === 'subtype' ? 'Default' : '';
    return isSimple(value) ? String(value) : '';
  };
  return Object.fromEntries(USER_KEYS.map((key) => [key, field(key)])) as unknown as LegacyDescribeUser;
}

/** True when the request carries `CFID`, `CFTOKEN` or `JSESSIONID`, whatever their values. */
function hasSessionCookie(req: RecordedRequest): boolean {
  const cookies = parseCookieHeader(req.headers.cookie);
  return LEGACY_SESSION_COOKIE_NAMES.some((name) => cookies.has(name));
}

/** The session cookies by name. */
function sessionCookies(session: LegacySession): Record<LegacySessionCookieName, string> {
  return { CFID: session.cfid, CFTOKEN: session.cftoken, JSESSIONID: session.jsessionid };
}

/** The `Set-Cookie` values legacy's setSessionCookies sends for a new session under Masa's default settings: `expires=never`, `path=/`, `HttpOnly`. */
function setCookiesFor(session: LegacySession, now: Date): string[] {
  return sessionCookieStrings({ CFID: session.cfid, CFTOKEN: session.cftoken, jsessionid: session.jsessionid }, {}, now);
}

/** The `Cookie` request header a browser holding the session's cookies sends. */
function cookieHeaderFor(session: LegacySession): string {
  const cookies = sessionCookies(session);
  return LEGACY_SESSION_COOKIE_NAMES.map((name) => `${name}=${cookies[name]}`).join('; ');
}

/** `op=describe`: the session as Masa's login left it; read-only. */
function describe(ctx: OpContext): LegacyDescribe {
  requireMethod(ctx.req, 'GET');
  const session = attachedSession(ctx);
  return {
    sessionId: session.legacySessionId,
    isLoggedIn: session.isLoggedIn,
    user: describeUser(session.user),
    memberships: session.memberships,
    membershipIds: session.membershipIds,
    csrfSecretKey: session.csrfSecretKey,
    usedTokens: ledgerEntries(session.used),
    siteId: session.siteId,
    serverTime: formatWireTime(ctx.now),
  };
}

/** `op=hydrate`: installs the snapshot, secret and ledger without a login, after session.cfm's checks. */
function hydrate(ctx: OpContext): HydrateResult {
  requireMethod(ctx.req, 'POST');
  // Without session cookies ColdFusion has just started the session, so there is no sid to check.
  const session = hasSessionCookie(ctx.req) ? requireSession(ctx) : attachedSession(ctx);
  const input = readJsonBody(ctx.req);
  const snapshot = structValue(input, 'snapshot');
  const user = isRecord(snapshot) ? structValue(snapshot, 'user') : undefined;
  if (!isRecord(snapshot) || !isRecord(user)) throw badRequest('snapshot.user must be an object');
  for (const key of USER_KEYS) {
    if (!isSimple(structValue(user, key))) throw badRequest(`snapshot.user.${key} is required`);
  }
  const userId = String(structValue(user, 'userID'));
  if (structEntry(user, 'groupID') !== undefined || userId === '') {
    throw badRequest('snapshot.user needs a userID and no groupID');
  }
  const memberships = structValue(snapshot, 'memberships') ?? '';
  const membershipIds = structValue(snapshot, 'membershipIds') ?? '';
  const secret = structValue(input, 'csrfSecretKey') ?? '';
  if (!isSimple(memberships) || !isSimple(membershipIds) || !isSimple(secret) || String(secret) === '') {
    throw badRequest('memberships, membershipIds and csrfSecretKey must be strings, csrfSecretKey non-empty');
  }
  const ledger = readLedger(structValue(input, 'usedTokens') ?? [], 'usedTokens');
  if (userId !== ctx.payload.sub) {
    throw new BridgeFail(409, 'subjectMismatch', 'snapshot.user.userID differs from the assertion sub');
  }
  const installed: Record<string, unknown> = {};
  for (const key of USER_KEYS) {
    const value = structValue(user, key);
    if (!TIME_KEYS.has(key)) installed[key] = value;
    else installed[key] = String(value) === '' ? '' : requireTime(String(value));
  }

  // setUserStruct(user) always marks the struct logged in (userUtility.cfc:765-784); secret and ledger go in after it.
  session.user = installed;
  session.isLoggedIn = true;
  session.memberships = String(memberships);
  session.membershipIds = String(membershipIds);
  session.csrfSecretKey = String(secret);
  session.used.clear();
  for (const [token, at] of ledger) session.used.set(token, at);
  // setUserStruct replaced the session.mura values op=carry installed, so the next carry installs every value again.
  session.carried.clear();
  session.hydrations += 1;
  return { sessionId: session.legacySessionId, hydrated: true, serverTime: formatWireTime(ctx.now) };
}

/** `op=markUsed`: adds unseen tokens to the ledger; a token already present keeps its earlier time. */
function markUsed(ctx: OpContext): MarkUsedResult {
  requireMethod(ctx.req, 'POST');
  const session = requireSession(ctx);
  const incoming = readLedger(structValue(readJsonBody(ctx.req), 'tokens') ?? '', 'tokens');
  let applied = 0;
  for (const [token, at] of incoming) {
    if (!hasToken(session.used, token)) {
      session.used.set(token, at);
      applied += 1;
    }
  }
  return { applied, serverTime: formatWireTime(ctx.now) };
}

/** `op=usedSince`: ledger entries used at or after `since`, compared to the millisecond; the bridge never purges. */
function usedSince(ctx: OpContext): UsedSinceResult {
  requireMethod(ctx.req, 'GET');
  const session = requireSession(ctx);
  const since = queryValue(ctx.req, 'since');
  if (since === '') throw badRequest('since is required');
  return { tokens: ledgerEntries(session.used, requireTime(since).getTime()), serverTime: formatWireTime(ctx.now) };
}

/** session.cfm's `sharedNames`: top-level session keys, and `mura.<key>` for `session.mura` keys. */
export const SHARED_NAMES: readonly string[] = Object.freeze([
  'flatViewArgs',
  'mura.nextN',
  'mura.alerts',
  'siteid',
  'userFilesPath',
  'topID',
  'openSectionList',
  'keywords',
  'datakeywords',
  'filterBy',
  '__fw1NextPreserveKey',
  '__fw1',
  'moduleid',
  'moduleTopIds',
  'mura.objectInstanceId',
  'blockLoginUntil',
]);
const MURA_PREFIX = 'mura.';
/** session.cfm's name for login's strike block, a wire time or `""` on the wire and a Date or `""` in the session. */
const BLOCK_LOGIN_UNTIL = 'blockLoginUntil';
/** session.cfm's name for the FW/1 preserved contexts `session['__fw1<key>']`, which carry installs and export skips. */
const CONTEXTS = '__fw1';
/** session.cfm's name for the module tops `session[<key>].topid`. */
const MODULE_TOPS = 'moduleTopIds';
/** session.cfm's `moduleTopKeys`: `m<moduleid>` and `<moduleid>` over the module ids carch before() accepts. */
const MODULE_TOP_KEYS: readonly string[] = Object.freeze(
  [
    '00000000000000000000000000000000000',
    '00000000000000000000000000000000003',
    '00000000000000000000000000000000004',
    '00000000000000000000000000000000099',
    '000000000000000000000000000000000099',
  ].flatMap((id) => [`m${id}`, id]),
);

/** What session.cfm's failedSaveBean builds from a carried context's userBean: the posted values and the save's errors. */
export interface CarriedUserBean {
  posted: Record<string, unknown>;
  errors: unknown;
}

/** A shared name's value in the session, as session.cfm's readShared finds it; undefined when it holds none. */
export function sharedValue(session: LegacySession, name: string): unknown {
  if (name === MODULE_TOPS) {
    const tops: Record<string, string> = {};
    for (const key of MODULE_TOP_KEYS) {
      const held = structValue(session.values, key);
      const topId = isRecord(held) ? structValue(held, 'topid') : undefined;
      if (topId !== undefined) tops[key] = String(topId);
    }
    return Object.keys(tops).length === 0 ? undefined : tops;
  }
  if (name.startsWith(MURA_PREFIX)) return structValue(session.user, name.slice(MURA_PREFIX.length));
  return name === 'siteid' ? session.siteId : structValue(session.values, name);
}

/** Sets a shared name in the session, as session.cfm's writeShared does: the strike block's wire time as a Date. */
function setSharedValue(session: LegacySession, name: string, value: unknown): void {
  if (name === MODULE_TOPS) {
    const tops = Object.entries(value as Record<string, unknown>).filter(
      ([key, topId]) => MODULE_TOP_KEYS.some((known) => known.toLowerCase() === key.toLowerCase()) && isSimple(topId),
    );
    session.values = mergeStruct(session.values, Object.fromEntries(tops.map(([key, topId]) => [key, { TOPID: topId }])));
  } else if (name.startsWith(MURA_PREFIX)) session.user = mergeStruct(session.user, { [name.slice(MURA_PREFIX.length)]: value });
  else if (name === BLOCK_LOGIN_UNTIL) session.values = mergeStruct(session.values, { [name]: String(value) === '' ? '' : requireTime(String(value)) });
  else if (name === 'siteid') session.siteId = String(value);
  else session.values = mergeStruct(session.values, { [name]: value });
}

/** session.cfm's isContexts: positive integer keys, each a struct of simple values whose userBean, when present, is JSON. */
function isContexts(value: unknown): value is Record<string, Record<string, string | number | boolean>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, context]) => {
    if (!/^\d+$/.test(key) || Number(key) < 1 || !isRecord(context) || !Object.values(context).every(isSimple)) return false;
    const userBean = structValue(context, 'userBean');
    if (userBean === undefined) return true;
    try {
      JSON.parse(String(userBean));
      return true;
    } catch {
      return false;
    }
  });
}

/** session.cfm's installContexts: each changed context as `__fw1<key>`, its userBean as a bean, purging the key ten earlier. */
function installContexts(session: LegacySession, contexts: Record<string, Record<string, unknown>>, previous: Record<string, unknown>): void {
  for (const [key, context] of Object.entries(contexts)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(context)) continue;
    const restored: Record<string, unknown> = { ...context };
    const userBean = structEntry(context, 'userBean');
    if (userBean !== undefined) {
      const posted = Object.fromEntries(Object.entries(context).filter(([name]) => name !== userBean[0]));
      const result = JSON.parse(String(userBean[1])) as unknown;
      restored[userBean[0]] = { posted, errors: isRecord(result) ? (structValue(result, 'errors') ?? {}) : {} } satisfies CarriedUserBean;
    }
    const purged = structEntry(session.values, `${CONTEXTS}${Number(key) - 10}`);
    session.values = mergeStruct(session.values, { [`${CONTEXTS}${key}`]: restored });
    if (purged !== undefined) delete session.values[purged[0]];
  }
}

/** `op=carry`: after checking every entry, sets each value whose revision differs from the one installed last. */
function carry(ctx: OpContext): CarryResult {
  requireMethod(ctx.req, 'POST');
  const session = requireSession(ctx);
  const values = structValue(readJsonBody(ctx.req), 'values') ?? '';
  if (!Array.isArray(values)) throw badRequest('values must be an array');
  const entries = (values as unknown[]).map((entry) => {
    const name = isRecord(entry) ? structValue(entry, 'name') : undefined;
    const value = isRecord(entry) ? structValue(entry, 'value') : undefined;
    const revision = isRecord(entry) ? structValue(entry, 'revision') : undefined;
    if (
      !isSimple(name) || !SHARED_NAMES.includes(String(name)) || value === undefined || value === null || !isSimple(revision) || String(revision) === ''
      || (name === CONTEXTS && !isContexts(value)) || (name === MODULE_TOPS && !isRecord(value)) || (name === BLOCK_LOGIN_UNTIL && !isSimple(value))
    ) {
      throw badRequest('values entries need a shared name, a value and a revision');
    }
    return { name: String(name), value, revision: String(revision) };
  });
  const applied: string[] = [];
  for (const { name, value, revision } of entries) {
    const carried = session.carried.get(name);
    if (carried?.revision === revision) continue;
    if (name === CONTEXTS) {
      const previous = carried === undefined ? {} : (JSON.parse(carried.json) as Record<string, unknown>);
      installContexts(session, value as Record<string, Record<string, unknown>>, previous);
      session.carried.set(name, { revision, json: JSON.stringify(value) });
    } else {
      setSharedValue(session, name, value);
      // The value as op=export reads it back, so an unchanged value is never exported.
      const held = sharedValue(session, name);
      session.carried.set(name, { revision, json: held === undefined ? '' : JSON.stringify(held) });
    }
    applied.push(name);
  }
  return { applied, serverTime: formatWireTime(ctx.now) };
}

/**
 * `op=export`: each shared value but the contexts the session holds whose JSON differs from the one installed last, simple
 * values as strings, the strike block as a wire time or `""`, a struct with the struct installed last as its base.
 */
function exportShared(ctx: OpContext): ExportResult {
  requireMethod(ctx.req, 'GET');
  const session = requireSession(ctx);
  const values: ExportedValue[] = [];
  for (const name of SHARED_NAMES) {
    if (name === CONTEXTS) continue;
    const value = sharedValue(session, name);
    const installed = session.carried.get(name)?.json;
    if (value === undefined || value === null || installed === JSON.stringify(value)) continue;
    if (name === BLOCK_LOGIN_UNTIL) {
      values.push({ name, value: wireTimeOf(value) });
      continue;
    }
    const base: unknown = installed === undefined || installed === '' ? undefined : JSON.parse(installed);
    values.push({
      name,
      value: isSimple(value) ? String(value) : (value as ExportedValue['value']),
      ...(isRecord(value) && isRecord(base) ? { base } : {}),
    });
  }
  return { values, serverTime: formatWireTime(ctx.now) };
}

/** `op=end`: `setUserStruct()` with no user, then `sessionInvalidate()`; no database write. */
function end(ctx: OpContext): EndResult {
  requireMethod(ctx.req, 'POST');
  const session = requireSession(ctx);
  // setUserStruct() replaces session.mura, which mints a fresh secret and an empty ledger (userUtility.cfc:761-763).
  session.user = loggedOutUser();
  session.isLoggedIn = false;
  session.memberships = '';
  session.membershipIds = '';
  session.csrfSecretKey = cfUuid();
  session.used.clear();
  session.ended = true;
  return { ended: true, serverTime: formatWireTime(ctx.now) };
}

/** session.cfm's ops by URL `op`. */
const SESSION_OPS: ReadonlyMap<string, (ctx: OpContext) => object> = new Map<string, (ctx: OpContext) => object>([
  ['describe', describe],
  ['hydrate', hydrate],
  ['markUsed', markUsed],
  ['usedSince', usedSince],
  ['carry', carry],
  ['export', exportShared],
  ['end', end],
]);

/** The default page answer for `req`. */
function echoOf(req: RecordedRequest): LegacyEcho {
  const cookie = headerText(req.headers.cookie);
  return {
    method: req.method,
    path: req.path,
    url: req.url,
    query: req.query,
    host: headerText(req.headers.host),
    forwarded: {
      for: headerText(req.headers['x-forwarded-for']),
      proto: headerText(req.headers['x-forwarded-proto']),
      host: headerText(req.headers['x-forwarded-host']),
    },
    authorization: headerText(req.headers.authorization),
    cookie,
    cookies: Object.fromEntries(parseCookieHeader(cookie ?? undefined)),
    contentType: headerText(req.headers['content-type']),
    bodyBase64: req.body.toString('base64'),
    bodyText: req.body.toString('utf8'),
  };
}

/** `headers` with every `Set-Cookie` value, given ones between `before` and `after`, under one `Set-Cookie` entry. */
function withSetCookies(
  headers: Record<string, string | string[]>,
  before: readonly string[],
  after: readonly string[],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const given: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'set-cookie') given.push(...(Array.isArray(value) ? value : [value]));
    else out[name] = value;
  }
  const cookies = [...before, ...given, ...after];
  if (cookies.length > 0) out['Set-Cookie'] = cookies;
  return out;
}


/** `base` with each `over` entry replacing the base key it matches without case, as a CFML struct assignment does. */
function mergeStruct(base: Readonly<Record<string, unknown>>, over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = structEntry(out, key);
    if (existing !== undefined) delete out[existing[0]];
    out[key] = value;
  }
  return out;
}

/** The `Set-Cookie` values a spec adds; `'session'` re-emits the session's cookies unless ColdFusion just set them. */
function specCookies(spec: LegacyResponseSpec, session: LegacySession | undefined, alreadySet: boolean, now: Date): string[] {
  if (spec.setCookies !== 'session') return spec.setCookies ?? [];
  return session === undefined || alreadySet ? [] : setCookiesFor(session, now);
}

/** The legacy origin's request handler, and the double members it adds over whichever double serves it. */
function legacyOriginCore(opts: LegacyOriginOptions) {
  const autoCreate = opts.autoCreateSession ?? true;
  const bridgeKey = opts.bridgeKey ?? TEST_BRIDGE_KEY;
  const clock = opts.clock ?? TEST_CLOCK;
  const nonces = new MemoryNonceStore();
  const sessions = new Map<string, LegacySession>();
  const bridgeCalls: BridgeCall[] = [];
  const pendingTokens = new Map<string, string[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sitePathsCalls: SitePathsCall[] = [];
  const sitePathValues = new Map<string, string>();
  let sitePathsFailure: number | undefined;
  let responder: LegacyResponseSpec | LegacyResponder = {};
  let versionMenuAnswer: { status: number; body: object } | undefined;
  let pluginsAnswer: { status: number; body: object } | undefined;
  const staticFiles = new Set<string>();
  const staticCalls: StaticPathCall[] = [];
  let staticFailure: number | undefined;
  let created = 0;

  const sessionById = (legacySessionId: string): LegacySession => {
    const session = sessions.get(legacySessionId);
    if (session === undefined) throw new Error(`legacy origin double: no session ${legacySessionId}`);
    return session;
  };

  const createSession = (partial: Partial<LegacySession> = {}): CreatedSession => {
    created += 1;
    const legacySessionId = partial.legacySessionId ?? cfUuid();
    if (sessions.has(legacySessionId)) throw new Error(`legacy origin double: session ${legacySessionId} exists`);
    const user = mergeStruct(loggedOutUser(), partial.user);
    const session: LegacySession = {
      legacySessionId,
      cfid: partial.cfid ?? String(1000 + created),
      cftoken: partial.cftoken ?? String(10_000_000 + created),
      jsessionid: partial.jsessionid ?? jsessionidForSessionId(legacySessionId),
      // A struct given to setUserStruct is logged in; a session started without one is anonymous.
      isLoggedIn: partial.isLoggedIn ?? (partial.user !== undefined && String(structValue(user, 'userID') ?? '') !== ''),
      user,
      memberships: partial.memberships ?? '',
      membershipIds: partial.membershipIds ?? '',
      csrfSecretKey: partial.csrfSecretKey ?? cfUuid(),
      used: partial.used ?? new Map<string, Date>(),
      siteId: partial.siteId ?? 'default',
      ended: partial.ended ?? false,
      hydrations: partial.hydrations ?? 0,
      values: partial.values ?? {},
      carried: partial.carried ?? new Map<string, CarriedRecord>(),
    };
    sessions.set(legacySessionId, session);
    return {
      session,
      setCookies: setCookiesFor(session, clock.now()),
      cookieHeader: cookieHeaderFor(session),
      cookies: sessionCookies(session),
    };
  };

  /** The live session the cookies attach: by `JSESSIONID` when one is sent, else by `CFID` and `CFTOKEN`. */
  const attachedTo = (req: RecordedRequest): LegacySession | undefined => {
    const cookies = parseCookieHeader(req.headers.cookie);
    const jsessionid = cookies.get('JSESSIONID');
    const cfid = cookies.get('CFID');
    const cftoken = cookies.get('CFTOKEN');
    for (const session of sessions.values()) {
      if (session.ended) continue;
      const matches =
        jsessionid !== undefined && jsessionid !== ''
          ? session.jsessionid === jsessionid
          : session.cfid === cfid && session.cftoken === cftoken;
      if (matches) return session;
    }
    return undefined;
  };

  /** The attached session, else with `create` a new one and the cookies ColdFusion sets for it. */
  const attach = (req: RecordedRequest, create: boolean): { session: LegacySession | undefined; setCookies: string[] } => {
    const found = attachedTo(req);
    if (found !== undefined || !create) return { session: found, setCookies: [] };
    const { session, setCookies } = createSession();
    return { session, setCookies };
  };

  /** The bridge guard: the verified payload when it is signed for `session.<op>` and the URL `siteid`, else undefined. */
  const verified = (req: RecordedRequest, op: string): BridgeAssertionPayload | undefined => {
    const header = req.headers[ASSERTION_HEADER];
    if (typeof header !== 'string' || header === '') return undefined;
    const result = verifyBridgeAssertion(header, bridgeKey, nonces, clock.now());
    if (!result.ok) return undefined;
    const { payload } = result;
    return op !== '' && payload.op === `session.${op}` && payload.siteId === queryValue(req, 'siteid') ? payload : undefined;
  };

  /** Answers one `session.cfm` call and records it. */
  const bridge = (req: RecordedRequest, res: ServerResponse): void => {
    const op = queryValue(req, 'op');
    const payload = verified(req, op);
    if (payload === undefined) {
      bridgeCalls.push({ op, legacySessionId: attachedTo(req)?.legacySessionId, status: 403, body: undefined, request: req });
      sendBytes(res, 403, '');
      return;
    }
    // ColdFusion attaches or starts the session before the page runs; describe and a cookie-less hydrate always get one.
    const create = autoCreate || op === 'describe' || (op === 'hydrate' && !hasSessionCookie(req));
    const { session, setCookies } = attach(req, create);
    const now = clock.now();
    let status = 200;
    let body: object;
    try {
      const run = SESSION_OPS.get(op);
      if (run === undefined) throw new BridgeFail(404, 'notFound', 'unknown op');
      body = run({ req, payload, session, now });
    } catch (error) {
      // session.cfm's catch (any e) answers 500 serverError with the exception type only.
      const fail =
        error instanceof BridgeFail
          ? error
          : new BridgeFail(500, 'serverError', error instanceof Error ? error.name : 'Error');
      status = fail.status;
      body = { error: fail.error, message: fail.message, serverTime: formatWireTime(now) };
    }
    bridgeCalls.push({ op, payload, legacySessionId: session?.legacySessionId, status, body, request: req });
    sendJson(res, status, body, withSetCookies({}, setCookies, []));
  };

  /** Answers the GET-only `site.cfm?op=<op>` behind the guard: 403 unless signed for `site.<op>`, 400 unless GET. */
  const siteRead = (req: RecordedRequest, res: ServerResponse, op: string, answer: { status: number; body: object }): void => {
    const header = req.headers[ASSERTION_HEADER];
    const result = typeof header === 'string' && header !== '' ? verifyBridgeAssertion(header, bridgeKey, nonces, clock.now()) : undefined;
    if (result?.ok !== true || result.payload.op !== `site.${op}` || result.payload.siteId !== queryValue(req, 'siteid')) {
      sendBytes(res, 403, '');
      return;
    }
    const serverTime = formatWireTime(clock.now());
    if (req.method !== 'GET') {
      sendJson(res, 400, { error: 'badRequest', message: 'GET required', serverTime });
      return;
    }
    sendJson(res, answer.status, { ...answer.body, serverTime });
  };
  const versionMenu = (req: RecordedRequest, res: ServerResponse): void =>
    siteRead(req, res, 'versionMenu', versionMenuAnswer ?? { status: 200, body: LEGACY_VERSION_MENU });
  const plugins = (req: RecordedRequest, res: ServerResponse): void =>
    siteRead(req, res, 'plugins', pluginsAnswer ?? { status: 200, body: { plugins: LEGACY_PLUGINS } });

  /** Answers `site.cfm?op=static` behind the guard as site.cfm does: 403 unless signed for `site.static`, 400 for a method or path it refuses. */
  const staticPage = (req: RecordedRequest, res: ServerResponse): void => {
    const header = req.headers[ASSERTION_HEADER];
    const result = typeof header === 'string' && header !== '' ? verifyBridgeAssertion(header, bridgeKey, nonces, clock.now()) : undefined;
    if (result?.ok !== true || result.payload.op !== 'site.static' || result.payload.siteId !== queryValue(req, 'siteid')) {
      sendBytes(res, 403, '');
      return;
    }
    let path: unknown;
    let status = 200;
    let body: Record<string, unknown>;
    try {
      path = (JSON.parse(req.body.toString('utf8')) as { path?: unknown } | null)?.path;
    } catch {
      path = undefined;
    }
    if (req.method !== 'POST') {
      status = 400;
      body = { error: 'badRequest', message: 'POST required' };
    } else if (typeof path !== 'string' || !path.startsWith('/') || /[\u0000\\;]|\/\.\.(\/|$)/.test(path)) {
      status = 400;
      body = { error: 'badRequest', message: typeof path === 'string' ? 'invalid path' : 'path is required' };
    } else if (staticFailure !== undefined) {
      status = staticFailure;
      body = { error: 'serverError', message: 'java.io.IOException' };
    } else {
      body = { cfml: !staticFiles.has(path) };
    }
    body.serverTime = formatWireTime(clock.now());
    staticCalls.push({ path, status, body, request: req });
    sendJson(res, status, body);
  };

  /** Records the session's pending tokens as used, as a validating legacy action's validateCSRFTokens does. */
  const consumePending = (session: LegacySession): void => {
    const tokens = pendingTokens.get(session.legacySessionId);
    if (tokens === undefined) return;
    pendingTokens.delete(session.legacySessionId);
    const now = clock.now();
    for (const token of tokens) {
      // Only validation purges entries older than 3 h (sessionUserFacade.cfc:210-215); session.cfm's ops never do.
      const kept = purgeUsedTokens(session.used, now);
      for (const key of [...session.used.keys()]) if (!kept.has(key)) session.used.delete(key);
      if (!hasToken(session.used, token)) session.used.set(token, now);
    }
  };

  /** Resolves after `ms` on an unref'd timer that `close()` clears. */
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timer.unref();
      timers.add(timer);
    });

  /** Answers a page request: the programmed spec, or the echo of what legacy received. */
  const page = async (req: RecordedRequest, res: ServerResponse): Promise<void> => {
    const { session, setCookies } = attach(req, autoCreate);
    if (session !== undefined) consumePending(session);
    const spec = typeof responder === 'function' ? await responder(req, session) : responder;
    if (spec.delayMs !== undefined && spec.delayMs > 0) await delay(spec.delayMs);
    const extra = specCookies(spec, session, setCookies.length > 0, clock.now());
    const headers = withSetCookies({ 'X-Legacy-Double': '1', ...spec.headers }, setCookies, extra);
    const status = spec.status ?? 200;
    const body = spec.body ?? echoOf(req);
    if (spec.rawHeaders !== undefined) {
      writeRawHeaders(res, status, headers, spec.rawHeaders);
      res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    } else if (Buffer.isBuffer(body) || typeof body === 'string') sendBytes(res, status, body, headers);
    else sendJson(res, status, body, headers);
  };

  /** Answers one `site.cfm` call: `op=paths` behind the guard, values kept per site from their first call. */
  const sitePage = (req: RecordedRequest, res: ServerResponse): void => {
    const header = req.headers[ASSERTION_HEADER];
    const result = typeof header === 'string' && header !== '' ? verifyBridgeAssertion(header, bridgeKey, nonces, clock.now()) : undefined;
    const op = queryValue(req, 'op');
    if (result?.ok !== true || result.payload.op !== `site.${op}` || result.payload.siteId !== queryValue(req, 'siteid')) {
      sendBytes(res, 403, '');
      return;
    }
    let status = 200;
    let body: Record<string, unknown>;
    if (op !== 'paths') {
      status = 404;
      body = { error: 'notFound', message: 'unknown op' };
    } else if (sitePathsFailure !== undefined) {
      status = sitePathsFailure;
      body = { error: 'serverError', message: 'coldfusion.runtime.TemplateException' };
    } else {
      const secure = headerText(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https';
      const root = `${secure ? 'https' : 'http'}://${headerText(req.headers.host) ?? ''}`;
      const kept = (site: string, name: string, value: string): string => {
        const key = `${site.toLowerCase()} ${name}`;
        if (!sitePathValues.has(key)) sitePathValues.set(key, value);
        return sitePathValues.get(key) ?? value;
      };
      body = {};
      if (Object.hasOwn(req.query, 'apiSite')) {
        const site = queryValue(req, 'apiSite');
        body.restEndpoint = kept(site, 'restEndpoint', `${root}/_api/rest/v1/${site}`);
      }
      if (Object.hasOwn(req.query, 'feedSite')) {
        const site = queryValue(req, 'feedSite');
        body.feedEndpoint = kept(site, 'feedEndpoint', `${root}/_api/feed/v1/${site}`);
      }
      if (Object.hasOwn(req.query, 'themeSite')) {
        body.themeAssetPath = kept(queryValue(req, 'themeSite'), 'themeAssetPath', '/themes/default');
      }
      if (Object.hasOwn(req.query, 'initSite')) {
        body.initThemeAssetPath = kept(queryValue(req, 'initSite'), 'initThemeAssetPath', `${root}/themes/default`);
      }
    }
    body.serverTime = formatWireTime(clock.now());
    sitePathsCalls.push({ status, body, request: req });
    sendJson(res, status, body);
  };

  const handler: DoubleHandler = async (req, res) => {
    if (req.path === BRIDGE_SESSION_PATH) bridge(req, res);
    else if (req.path === BRIDGE_SITE_PATH && queryValue(req, 'op') === 'versionMenu') versionMenu(req, res);
    else if (req.path === BRIDGE_SITE_PATH && queryValue(req, 'op') === 'plugins') plugins(req, res);
    else if (req.path === BRIDGE_SITE_PATH && queryValue(req, 'op') === 'static') staticPage(req, res);
    else if (req.path === BRIDGE_SITE_PATH) sitePage(req, res);
    else if (req.path.startsWith(BRIDGE_PREFIX)) sendBytes(res, 404, '');
    else await page(req, res);
  };

  const over = <D extends Omit<HttpDouble, 'port'>>(double: D): D & LegacyOriginMembers => ({
    ...double,
    sessions,
    bridgeCalls,
    createSession,
    sessionCookieHeader: (session) => cookieHeaderFor(typeof session === 'string' ? sessionById(session) : session),
    setResponse(response = {}) {
      responder = response;
    },
    consumeTokenDuringNextRequest(legacySessionId, token) {
      sessionById(legacySessionId);
      pendingTokens.set(legacySessionId, [...(pendingTokens.get(legacySessionId) ?? []), token]);
    },
    usedTokens: (legacySessionId) => ledgerEntries(sessionById(legacySessionId).used),
    sitePathsCalls,
    resetSitePaths() {
      sitePathValues.clear();
    },
    failSitePaths(status) {
      sitePathsFailure = status;
    },
    setVersionMenuAnswer(answer) {
      versionMenuAnswer = answer;
    },
    setPluginsAnswer(answer) {
      pluginsAnswer = answer;
    },
    staticFiles,
    staticCalls,
    failStatic(status) {
      staticFailure = status;
    },
    // Bridge calls are recorded requests too, so the records are cleared together.
    clearRequests() {
      double.clearRequests();
      bridgeCalls.length = 0;
      sitePathsCalls.length = 0;
      staticCalls.length = 0;
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return double.close();
    },
  });
  return { handler, over };
}

/** Starts the legacy origin double on an ephemeral loopback port. */
export async function startLegacyOrigin(opts: LegacyOriginOptions = {}): Promise<LegacyOrigin> {
  const { handler, over } = legacyOriginCore(opts);
  return over(await startHttpDouble(handler));
}

/** Creates the legacy origin double served in process at `http://legacy-origin.test`. */
export function createInProcessLegacyOrigin(opts: LegacyOriginOptions = {}): InProcessLegacyOrigin {
  const { handler, over } = legacyOriginCore(opts);
  return over(createInProcessDouble(handler, 'http://legacy-origin.test'));
}

