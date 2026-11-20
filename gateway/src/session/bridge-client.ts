// Signed clients of the legacy bridge: session.cfm (describe, hydrate, CSRF ledger, shared values, end) and site.cfm's site list, path values, Version menu facts and static-path check.
import { BRIDGE_ASSERTION_HEADER, isLegacySessionCookie, signBridgeAssertion } from '@opt2/platform/legacy-compat';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, type Clock, type Dispatcher } from '@opt2/platform/service-kit';
import type { LegacyDescribe, LegacyDescribeUser, LegacyUsedToken } from './identity-client.js';

export type { LegacyDescribe, LegacyDescribeUser, LegacyUsedToken } from './identity-client.js';

const BRIDGE_DIR = '/gateway/legacy-bridge/cfml';
const BRIDGE_SERVICE = 'legacy-bridge';
// A call without session cookies gets a throwaway session, which Masa keeps for 2 s only for a bot-like agent.
const BOT_USER_AGENT = 'opt2-legacy-bridge-bot';
// The bridge refuses assertions expiring within 60 s of its JVM start, so a shorter TTL fails right after a legacy restart.
const ASSERTION_TTL_SECONDS = 60;

/** One legacy cookie: its value, or a jar entry carrying `value` and optionally the observed `name`. */
export type LegacyCookieValue = string | { readonly name?: string; readonly value: string };

/** Cookies by name; only `CFID`, `CFTOKEN` and `JSESSIONID` with a non-empty value reach the bridge. */
export type LegacyCookies = Readonly<Record<string, LegacyCookieValue>>;

/** Per-call facts about the browser session the cookies belong to. */
export interface BridgeCallOptions {
  /** ColdFusion `session.sessionid` of the cookies (describe's `sessionId`, kept in the jar); signed as `sid`. */
  legacySessionId?: string;
  /** The browser's `User-Agent`, forwarded because Masa cuts the session to 2 s for an empty or bot-like agent. */
  userAgent?: string;
}

// The bridge answers 409 sessionMismatch unless `sid` equals session.sessionid, which the cookies alone do not reveal.
/** Options of the ops the bridge checks against the attached session, so the legacy session id is required. */
export interface BridgeSessionCall extends BridgeCallOptions {
  legacySessionId: string;
}

/** `op=hydrate` body: identity's login snapshot, CSRF secret and used-token ledger for the session. */
export interface HydrateBody {
  snapshot: {
    /** The describe `user` keys; never a `groupID`, which would override `membershipIds`. */
    user: LegacyDescribeUser;
    /** `loginByQuery` role list, comma-delimited. */
    memberships: string;
    /** Group ids plus the user id, comma-delimited. */
    membershipIds: string;
  };
  csrfSecretKey: string;
  usedTokens: LegacyUsedToken[];
}

/** `op=hydrate` answer: the hydrated session's id. */
export interface HydrateResult {
  sessionId: string;
  hydrated: true;
  serverTime: string;
}

/** `op=markUsed` answer: the number of tokens newly added to the ledger. */
export interface MarkUsedResult {
  applied: number;
  serverTime: string;
}

/** `op=usedSince` answer: ledger entries used at or after `since`, under the bridge's key `tokens`. */
export interface UsedSinceResult {
  tokens: LegacyUsedToken[];
  serverTime: string;
}

/** A JSON value other than `null`, as a shared session value travels. */
export type SharedJsonValue = string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>>;

/** One `op=carry` entry: a shared value's wire name, its value and a revision that changes whenever the value does. */
export interface CarriedValue {
  name: string;
  value: SharedJsonValue;
  revision: string;
}

/** `op=carry` answer: the names installed, those whose revision differed from the one installed last. */
export interface CarryResult {
  applied: string[];
  serverTime: string;
}

/** One `op=export` entry: a shared value's wire name and the value legacy holds; simple values arrive as strings. */
export interface ExportedValue {
  name: string;
  value: SharedJsonValue;
  /** For a struct value, the struct `op=carry` installed last; absent when it installed none. */
  base?: Readonly<Record<string, unknown>>;
}

/** `op=export` answer: the shared values legacy changed since `op=carry` installed them, or that it never installed. */
export interface ExportResult {
  values: ExportedValue[];
  serverTime: string;
}

/** `op=end` answer. */
export interface EndResult {
  ended: true;
  serverTime: string;
}

/** A bridge answer with the raw `Set-Cookie` values ColdFusion sent, for example a new session's cookies. */
export interface BridgeResult<T> {
  body: T;
  setCookies: string[];
}

/** The gateway's calls into the legacy session through `session.cfm`. */
export interface BridgeClient {
  /** `op=describe`: the attached session as Masa's login left it; creates a session when the cookies attach none. */
  describe(cookies: LegacyCookies, call?: BridgeCallOptions): Promise<BridgeResult<LegacyDescribe>>;
  /** `op=hydrate`: installs the snapshot without a login; `legacySessionId` is required when cookies are sent. */
  hydrate(cookies: LegacyCookies, body: HydrateBody, call?: BridgeCallOptions): Promise<BridgeResult<HydrateResult>>;
  /** `op=markUsed`: adds tokens to the session's used-token ledger. */
  markUsed(
    cookies: LegacyCookies,
    tokens: LegacyUsedToken[],
    call: BridgeSessionCall,
  ): Promise<BridgeResult<MarkUsedResult>>;
  /** `op=usedSince`: ledger entries used at or after `since`, a legacy wire time. */
  usedSince(cookies: LegacyCookies, since: string, call: BridgeSessionCall): Promise<BridgeResult<UsedSinceResult>>;
  /** `op=carry`: sets each shared value in the legacy session unless its revision is the one installed last. */
  carry(cookies: LegacyCookies, values: CarriedValue[], call: BridgeSessionCall): Promise<BridgeResult<CarryResult>>;
  /** `op=export`: the shared values the legacy session holds that differ from those `op=carry` installed. */
  export(cookies: LegacyCookies, call: BridgeSessionCall): Promise<BridgeResult<ExportResult>>;
  /** `op=end`: logs the session out without a database write and invalidates it. */
  end(cookies: LegacyCookies, call: BridgeSessionCall): Promise<BridgeResult<EndResult>>;
}

/** Construction options of {@link createBridgeClient}, {@link createSiteListClient}, {@link createVersionMenuClient} and {@link createStaticFileClient}. */
export interface BridgeClientOptions {
  /** `LEGACY_ORIGIN`, addressed directly. */
  legacyOrigin: string;
  /** `OPT2_BRIDGE_HMAC_KEY`. */
  hmacKey: string;
  clock: Clock;
  fetch?: typeof fetch;
}

/** One `getList(sortBy="orderno")` row as `contentServer.bindToDomain` reads it: its site's domain and alias lines. */
export interface SiteBinding {
  siteId: string;
  domain: string;
  aliases: string[];
}

/** `op=list` answer: the registered site ids and what `contentServer.bindToDomain` binds a request host with. */
export interface SiteListing {
  /** The site ids `settingsManager.siteExists` accepts. */
  sites: string[];
  /** In bind order. */
  bindings: SiteBinding[];
  /** `configBean.getAdminDomain()`. */
  adminDomain: string;
}

/** The gateway's read of the legacy site registry through `site.cfm`. */
export interface SiteListClient {
  /** `op=list`: the registered site ids and their domain bindings. */
  listSites(): Promise<SiteListing>;
}

/** What legacy's path getters read of a browser request: `cgi.http_host`, `cgi.server_name` and `utility.isHTTPS()`. */
export interface LegacyRequestFacts {
  /** The `Host` the request would carry to legacy. */
  host: string;
  /** Its `X-Forwarded-Proto`, when it carries one. */
  forwardedProto?: string;
  /** Its `Front-End-Https`, when it carries one. */
  frontEndHttps?: string;
}

/** The sites whose first-touch values `op=paths` evaluates; each value is evaluated only when its site is named. */
export interface SitePathsQuery {
  /** `session.siteid`, whose domains decide `request.muraPreviewDomain`. */
  sessionSite: string;
  /** Site of `getApi('json','v1').getEndpoint(mode='rest')`. */
  apiSite?: string;
  /** Site of `getApi('feed','v1').getEndpoint()`. */
  feedSite?: string;
  /** Site of `getThemeAssetPath()`. */
  themeSite?: string;
  /** Site of `getThemeAssetPath(complete=1)`. */
  initSite?: string;
}

/** `op=paths` answer: the value of each named site. */
export interface SitePaths {
  restEndpoint?: string;
  feedEndpoint?: string;
  themeAssetPath?: string;
  initThemeAssetPath?: string;
}

/** The gateway's read of legacy's live site-bean values through `site.cfm?op=paths`. */
export interface SitePathsClient {
  /** `op=paths`: the values legacy's site beans give a request with `facts`, which their caches may keep from an earlier one. */
  paths(query: SitePathsQuery, facts: LegacyRequestFacts): Promise<SitePaths>;
}

/** Construction options of {@link createSitePathsClient}. */
export interface SitePathsClientOptions extends Omit<BridgeClientOptions, 'fetch'> {
  /** Sends the request; undici, unlike fetch, sends the given `Host`. */
  dispatcher: Dispatcher;
}

/** `op=versionMenu` answer: what the admin Version menu prints (`nav.cfm` 383-407); null where legacy finds the server key absent. */
export interface LegacyVersionMenu {
  /** `server.coldfusion.productname`. */
  appServerProductName: string;
  /** `server.coldfusion.productversion`. */
  appServerVersion: string;
  /** `dbUtility.version().database_productname`. */
  dbProductName: string;
  /** `dbUtility.version().database_version`. */
  dbProductVersion: string;
  /** `server.java.version`. */
  javaVersion: string | null;
  /** `server.os.name`. */
  osName: string | null;
  /** `server.os.version`. */
  osVersion: string | null;
}

/** The gateway's read of the legacy server facts through `site.cfm`. */
export interface VersionMenuClient {
  /** `op=versionMenu`: the app server, database, Java and OS values of the admin Version menu. */
  versionMenu(): Promise<LegacyVersionMenu>;
}

/** One `op=plugins` row: the `tplugins` columns `csettings/list.cfm` 312-350 prints, a NULL column as empty text. */
export interface LegacyPlugin {
  moduleId: string;
  name: string;
  directory: string;
  category: string;
  version: string;
  provider: string;
  providerUrl: string;
  pluginId: string;
}

/** The gateway's read of the installed plugins through `site.cfm`. */
export interface PluginListClient {
  /** `op=plugins`: `pluginManager.getAllPlugins()`, ordered by name. */
  plugins(): Promise<LegacyPlugin[]>;
}

type SessionOp = 'describe' | 'hydrate' | 'markUsed' | 'usedSince' | 'carry' | 'export' | 'end';

interface OpSpec {
  method: 'GET' | 'POST';
  sub?: string;
  query?: Record<string, string>;
  json?: unknown;
}

/** `Cookie` header of the legacy session cookies, or undefined when there are none. */
function legacyCookieHeader(cookies: LegacyCookies): string | undefined {
  const pairs: string[] = [];
  for (const [key, cookie] of Object.entries(cookies)) {
    const name = typeof cookie === 'string' ? key : (cookie.name ?? key);
    const value = typeof cookie === 'string' ? cookie : cookie.value;
    // An empty value is a legacy deletion, which a browser would not send back either.
    if (isLegacySessionCookie(name) && value !== '') pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/** The bridge's `error` token from an error body, or undefined for the guard's bodiless answers. */
function errorToken(text: string): string | undefined {
  try {
    const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

/** The legacy-shaped 503 for a non-2xx bridge answer to `<page>.<op>`. */
function httpFailure(pageOp: string, status: number, error: string | undefined): ServiceUnavailableError {
  const detail = error === undefined ? '' : ` ${error}`;
  const cause = Object.assign(new Error(`legacy bridge ${pageOp} answered HTTP ${String(status)}${detail}`), {
    code: `HTTP_${String(status)}`,
    status,
    error,
  });
  return new ServiceUnavailableError(BRIDGE_SERVICE, cause);
}

/** True when `error` is the bridge's 409 `sessionMismatch`: the cookies no longer attach the named legacy session. */
export function isBridgeSessionMismatch(error: unknown): boolean {
  if (!(error instanceof ServiceUnavailableError) || error.service !== BRIDGE_SERVICE) return false;
  const cause = error.cause as { status?: unknown; error?: unknown } | null | undefined;
  return cause?.status === 409 && cause.error === 'sessionMismatch';
}

/** Sender of one bridge page's ops; every call carries a freshly signed single-use assertion for `<page>.<op>`. */
function bridgeSender<Op extends string>(opts: BridgeClientOptions, page: 'session' | 'site') {
  const origin = opts.legacyOrigin.replace(/\/+$/, '');
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return async function send<T>(
    op: Op,
    spec: OpSpec,
    cookies: LegacyCookies,
    call: BridgeCallOptions = {},
  ): Promise<BridgeResult<T>> {
    let target = `${origin}${BRIDGE_DIR}/${page}.cfm?op=${op}`;
    for (const [name, value] of Object.entries(spec.query ?? {})) target += `&${name}=${encodeURIComponent(value)}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = legacyCookieHeader(cookies);
    if (cookie !== undefined) headers.Cookie = cookie;
    if (call.userAgent !== undefined) headers['User-Agent'] = call.userAgent;
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }
    // Signed last, right before sending, so no assertion outlives its one request.
    headers[BRIDGE_ASSERTION_HEADER] = signBridgeAssertion(
      {
        op: `${page}.${op}`,
        sid: call.legacySessionId,
        sub: spec.sub,
        ttlSeconds: ASSERTION_TTL_SECONDS,
        now: opts.clock.now(),
      },
      opts.hmacKey,
    );

    let response: Response;
    let text: string;
    try {
      response = await doFetch(target, {
        method: spec.method,
        headers,
        body,
        // A followed redirect would replay the single-use assertion; the bridge answers none.
        redirect: 'manual',
        signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (err) {
      throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
    }
    if (!response.ok) throw httpFailure(`${page}.${op}`, response.status, errorToken(text));

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (err) {
      throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
    }
    return { body: parsed, setCookies: response.headers.getSetCookie() };
  };
}

/** Creates the bridge session client; every call carries a freshly signed single-use assertion. */
export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const send = bridgeSender<SessionOp>(opts, 'session');

  return {
    describe: (cookies, call) => send<LegacyDescribe>('describe', { method: 'GET' }, cookies, call),

    hydrate: (cookies, body, call) =>
      send<HydrateResult>('hydrate', { method: 'POST', sub: body.snapshot.user.userID, json: body }, cookies, call),

    markUsed: (cookies, tokens, call) =>
      send<MarkUsedResult>('markUsed', { method: 'POST', json: { tokens } }, cookies, call),

    usedSince: (cookies, since, call) =>
      send<UsedSinceResult>('usedSince', { method: 'GET', query: { since } }, cookies, call),

    carry: (cookies, values, call) => send<CarryResult>('carry', { method: 'POST', json: { values } }, cookies, call),

    export: (cookies, call) => send<ExportResult>('export', { method: 'GET' }, cookies, call),

    end: (cookies, call) => send<EndResult>('end', { method: 'POST' }, cookies, call),
  };
}

/** A JSON text serializeJSON may have written as a number, as text; undefined for any other value. */
function wireText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** An array of {@link wireText} values as text; undefined for anything else. */
function wireTexts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value.map(wireText);
  return texts.every((text): text is string => text !== undefined) ? texts : undefined;
}

/** One `bindings` entry; undefined unless it holds a site id, a domain and an alias array. */
function siteBindingOf(value: unknown): SiteBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { siteId, domain, aliases } = value as Record<string, unknown>;
  const [id, host, names] = [wireText(siteId), wireText(domain), wireTexts(aliases)];
  return id === undefined || host === undefined || names === undefined ? undefined : { siteId: id, domain: host, aliases: names };
}

/** An `op=list` body; undefined unless `sites`, `bindings` and `adminDomain` all have their shape. */
function siteListingOf(body: unknown): SiteListing | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { sites, bindings, adminDomain } = body as Record<string, unknown>;
  const [ids, admin] = [wireTexts(sites), wireText(adminDomain)];
  if (ids === undefined || admin === undefined || !Array.isArray(bindings)) return undefined;
  const bound = bindings.map(siteBindingOf);
  if (!bound.every((binding): binding is SiteBinding => binding !== undefined)) return undefined;
  return { sites: ids, bindings: bound, adminDomain: admin };
}

/** Creates the signed `site.cfm?op=list` client; a body without the site ids, bindings and admin domain fails closed. */
export function createSiteListClient(opts: BridgeClientOptions): SiteListClient {
  const send = bridgeSender<'list'>(opts, 'site');

  return {
    async listSites() {
      const { body } = await send<unknown>('list', { method: 'GET' }, {}, { userAgent: BOT_USER_AGENT });
      const listing = siteListingOf(body);
      if (listing === undefined) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, new Error('legacy bridge site.list answered no list of sites and bindings'));
      }
      return listing;
    },
  };
}

/** Each `op=paths` site parameter with the answer key of the value it names, in the bridge's evaluation order. */
const SITE_PATH_VALUES = [
  ['apiSite', 'restEndpoint'],
  ['feedSite', 'feedEndpoint'],
  ['themeSite', 'themeAssetPath'],
  ['initSite', 'initThemeAssetPath'],
] as const satisfies ReadonlyArray<readonly [keyof SitePathsQuery, keyof SitePaths]>;

/** The value of each site `query` names from an `op=paths` body; undefined when one is missing or not text. */
function sitePathsOf(body: unknown, query: SitePathsQuery): SitePaths | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const values: SitePaths = {};
  for (const [param, key] of SITE_PATH_VALUES) {
    if (query[param] === undefined) continue;
    const value = wireText((body as Record<string, unknown>)[key]);
    if (value === undefined) return undefined;
    values[key] = value;
  }
  return values;
}

/** Creates the signed `site.cfm?op=paths` client; it sends the browser's host facts, and a body lacking a named value fails closed. */
export function createSitePathsClient(opts: SitePathsClientOptions): SitePathsClient {
  const base = new URL(opts.legacyOrigin);
  const prefix = base.pathname.replace(/\/+$/, '');

  return {
    async paths(query, facts) {
      let path = `${prefix}${BRIDGE_DIR}/site.cfm?op=paths&siteid=${encodeURIComponent(query.sessionSite)}`;
      for (const [param] of SITE_PATH_VALUES) {
        const site = query[param];
        if (site !== undefined) path += `&${param}=${encodeURIComponent(site)}`;
      }
      const headers: Record<string, string> = { accept: 'application/json', host: facts.host, 'user-agent': BOT_USER_AGENT };
      if (facts.forwardedProto !== undefined) headers['x-forwarded-proto'] = facts.forwardedProto;
      if (facts.frontEndHttps !== undefined) headers['front-end-https'] = facts.frontEndHttps;
      headers[BRIDGE_ASSERTION_HEADER] = signBridgeAssertion(
        { op: 'site.paths', siteId: query.sessionSite, ttlSeconds: ASSERTION_TTL_SECONDS, now: opts.clock.now() },
        opts.hmacKey,
      );

      let status: number;
      let text: string;
      try {
        // undici follows no redirect, so the single-use assertion is never replayed.
        const response = await opts.dispatcher.request({
          origin: base.origin,
          path,
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
        });
        status = response.statusCode;
        text = await response.body.text();
      } catch (err) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
      }
      if (status < 200 || status > 299) throw httpFailure('site.paths', status, errorToken(text));

      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch (err) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
      }
      const values = sitePathsOf(body, query);
      if (values === undefined) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, new Error('legacy bridge site.paths answered without a requested value'));
      }
      return values;
    },
  };
}

/** A {@link wireText} value as text, null for JSON null, undefined for anything else. */
function wireTextOrNull(value: unknown): string | null | undefined {
  return value === null ? null : wireText(value);
}

/** An `op=versionMenu` body; undefined unless the four menu texts are present and Java and OS are text or null. */
function versionMenuOf(body: unknown): LegacyVersionMenu | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const fields = body as Record<string, unknown>;
  const menu = {
    appServerProductName: wireText(fields.appServerProductName),
    appServerVersion: wireText(fields.appServerVersion),
    dbProductName: wireText(fields.dbProductName),
    dbProductVersion: wireText(fields.dbProductVersion),
    javaVersion: wireTextOrNull(fields.javaVersion),
    osName: wireTextOrNull(fields.osName),
    osVersion: wireTextOrNull(fields.osVersion),
  };
  return Object.values(menu).includes(undefined) ? undefined : (menu as LegacyVersionMenu);
}

/** The gateway's read, through `site.cfm?op=static`, of whether legacy runs CFML for a static-family request. */
export interface StaticFileClient {
  /** `op=static` for a percent-decoded request path: false only when legacy answers it with a file and no CFML; true on any failure. */
  isCfml(path: string): Promise<boolean>;
}

/** Creates the signed `site.cfm?op=static` client; it never throws. */
export function createStaticFileClient(opts: BridgeClientOptions): StaticFileClient {
  const send = bridgeSender<'static'>(opts, 'site');

  return {
    async isCfml(path) {
      try {
        const { body } = await send<unknown>('static', { method: 'POST', json: { path } }, {}, { userAgent: BOT_USER_AGENT });
        const cfml = (body as { cfml?: unknown } | null)?.cfml;
        return typeof cfml === 'boolean' ? cfml : true;
      } catch {
        // Without the bridge's answer the request may run Masa's request start, so it counts as one that does.
        return true;
      }
    },
  };
}

/** Creates the signed `site.cfm?op=versionMenu` client; a body without the menu's values fails closed. */
export function createVersionMenuClient(opts: BridgeClientOptions): VersionMenuClient {
  const send = bridgeSender<'versionMenu'>(opts, 'site');

  return {
    async versionMenu() {
      const { body } = await send<unknown>('versionMenu', { method: 'GET' }, {}, { userAgent: BOT_USER_AGENT });
      const menu = versionMenuOf(body);
      if (menu === undefined) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, new Error('legacy bridge site.versionMenu answered no Version menu values'));
      }
      return menu;
    },
  };
}

/** One `op=plugins` row; undefined unless every column is text. */
function pluginOf(value: unknown): LegacyPlugin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const plugin = {
    moduleId: wireText(fields.moduleId),
    name: wireText(fields.name),
    directory: wireText(fields.directory),
    category: wireText(fields.category),
    version: wireText(fields.version),
    provider: wireText(fields.provider),
    providerUrl: wireText(fields.providerUrl),
    pluginId: wireText(fields.pluginId),
  };
  return Object.values(plugin).includes(undefined) ? undefined : (plugin as LegacyPlugin);
}

/** Creates the signed `site.cfm?op=plugins` client; a body without a list of plugin rows fails closed. */
export function createPluginListClient(opts: BridgeClientOptions): PluginListClient {
  const send = bridgeSender<'plugins'>(opts, 'site');

  return {
    async plugins() {
      const { body } = await send<unknown>('plugins', { method: 'GET' }, {}, { userAgent: BOT_USER_AGENT });
      const rows = typeof body === 'object' && body !== null ? (body as { plugins?: unknown }).plugins : undefined;
      const plugins = Array.isArray(rows) ? rows.map(pluginOf) : undefined;
      if (plugins === undefined || plugins.includes(undefined)) {
        throw new ServiceUnavailableError(BRIDGE_SERVICE, new Error('legacy bridge site.plugins answered no plugin list'));
      }
      return plugins as LegacyPlugin[];
    },
  };
}
