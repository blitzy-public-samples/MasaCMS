// The legacy admin request context (FW/1 rc, admin session, site data and flags) every screen reads (server-only).
import { isDeepStrictEqual } from 'node:util';
import {
  AuthDenial,
  Roles,
  assertSiteMatches,
  hasAnyRole,
  isCoreModuleId,
  moduleRole,
  type UserClaims,
} from '@opt2/platform/auth';
import {
  LegacyFaultError,
  appendFormScopeValue,
  cfEq,
  cfListToArray,
  cfcookieNeverCookie,
  cookieScopeNeverCookie,
  corsHeaders,
  fallbackSiteId,
  parseCookieHeader,
  portcullisScan,
  type PortcullisInput,
  type PortcullisScope,
} from '@opt2/platform/legacy-compat';
import type { components as IdentityComponents } from '@/generated/clients/identity';
import type { components as ProgramsSitesComponents } from '@/generated/clients/programs-sites';
import type { WebAuth } from './auth';
import { dateKeyFor, localeHasDayParts, type DateKey } from './dates';
import { legacySettings } from './env';
import { okBody, type GatewayClient } from './gateway-client';
import { loadHrefDomains } from './href-domains';
// CF2Java's full locale table lives with the resource bundles; it is reused here rather than duplicated.
import { cf2Java } from './resource-bundles/rb';
import { FW1_HOME_ACTION, type HrefDomains } from './urls';

type SessionUser = IdentityComponents['schemas']['SessionUser'];
type SessionSite = IdentityComponents['schemas']['SessionSites']['sites'][number];
type StoredAdminState = IdentityComponents['schemas']['AdminSessionState'];
type SiteRecord = ProgramsSitesComponents['schemas']['ShellSite'];

/** Request header in which the gateway passes the browser's request target (path and query). */
export const ORIGINAL_URL_HEADER = 'x-opt2-original-url';

/** `session.topID` after a site switch: the site's home content id. */
const HOME_CONTENT_ID = '00000000000000000000000000000000001';

/** Users module, whose access on the token site grants the reverse lookup without asking identity. */
const USERS_MODULE_ID = '00000000000000000000000000000000008';

/** Which web entry point is building the request. */
export type AdminMode = 'page' | 'redirect' | 'raw' | 'opt2';

/** Inputs of {@link buildAdminRequest}, as the route adapters receive them. */
export interface AdminRequestInput {
  readonly params: { readonly circuit?: string; readonly action?: string };
  /** The query web received; the URL scope only without the gateway's original-URL header. */
  readonly searchParams: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Path and query of the request web received; the browser's own on the `/opt2` routes the gateway forwards unchanged. */
  readonly receivedTarget: string;
  readonly headers: Headers;
  /** The parsed request body, the form scope; absent on requests whose body is not read. */
  readonly form?: FormData | URLSearchParams;
  readonly auth: WebAuth;
  readonly gateway: GatewayClient;
  readonly mode: AdminMode;
  /** The request's clock; the current time when absent. */
  readonly now?: Date;
}

/** FW/1 `request.context`: simple values under case-insensitive keys, read-only. */
export type RequestContext = Readonly<Record<string, string>>;

/** Name/value pairs or a record, read as a CFML URL or form scope. */
export type ScopeInput = Iterable<readonly [string, string]> | Readonly<Record<string, string>>;

/** One admin alert of `session.mura.alerts`. */
export interface AdminAlert {
  readonly type: string;
  readonly text: string;
}

/** One criterion of the users advanced search, as `session.paramArray` holds it. */
export interface AdvancedSearchParam {
  readonly Field: string;
  readonly Relationship: string;
  readonly Criteria: string;
  readonly Condition: string;
}

/** The admin session scope after the request set-up, plus the identity-held user struct. */
export interface AdminSessionState {
  readonly siteid: string;
  readonly userFilesPath: string;
  readonly topID: string;
  readonly openSectionList: string;
  readonly moduleid: string;
  readonly keywords: string;
  /** `session.datakeywords` and `session.filterBy`: the form data manager's keyword search. */
  readonly datakeywords: string;
  readonly filterBy: string;
  /** Resource bundle locale of the admin labels. */
  readonly rb: string;
  /** Java locale of dates, from the session site. */
  readonly locale: string;
  readonly dateKey: DateKey;
  readonly dateKeyFormat: string;
  readonly localeHasDayParts: boolean;
  readonly dashboardSpan: number;
  /** Alert maps keyed by site id, then alert id (`session.mura.alerts`, which the layout renders). */
  readonly alerts: Readonly<Record<string, Readonly<Record<string, AdminAlert>>>>;
  readonly paramArray: readonly AdvancedSearchParam[];
  readonly paramCount: number;
  readonly paramCircuit: string;
  readonly paramCategories: string;
  readonly paramGroups: string;
  readonly inActive: string;
  readonly membersOnly: string;
  readonly visitorStatus: string;
  readonly frontEndProxyLoc: string;
  /** Ids of the sites the user may administer (module `…000`), as identity computes them. */
  readonly siteArray: readonly string[];
  readonly s2IsPrivate: boolean;
  /** `session.mura`: the user struct identity holds for the session, with `muraValues` laid over it. */
  readonly mura: SessionUser;
  /** `session.mura` values set since login, under their legacy names. */
  readonly muraValues: Readonly<Record<string, unknown>>;
  /** `isDefined('session.hasdefaultpassword')`, which only identity's login sets. */
  readonly hasDefaultPassword: boolean;
  /** `session['m<moduleid>'].topid` keyed by `m<moduleid>`. */
  readonly moduleTopIds: Readonly<Record<string, string>>;
  /** FW/1 preserved contexts keyed by preserve key (`session['__fw1<key>']`). */
  readonly flash: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** `session.__fw1NextPreserveKey`. */
  readonly nextPreserveKey: number;
}

/** Session values a request changed; derived values and the login-set `hasDefaultPassword` are not persisted. */
export type AdminSessionWrites = Partial<
  Omit<AdminSessionState, 'dateKey' | 'siteArray' | 's2IsPrivate' | 'mura' | 'hasDefaultPassword'>
>;

/** The session site as programs-sites returns it, with the values the admin reads named. */
export interface SiteData {
  readonly siteid: string;
  readonly site: string;
  readonly domain: string;
  readonly siteLocale: string;
  /** settingsBean `getJavaLocale()`. */
  readonly javaLocale: string;
  readonly publicUserPoolID: string;
  readonly privateUserPoolID: string;
  readonly displayPoolID: string;
  readonly contentPoolID: string;
  readonly categoryPoolID: string;
  readonly filePoolID: string;
  readonly hasChangesets: boolean;
  readonly hasComments: boolean;
  readonly hasFeedManager: boolean;
  /** settingsBean `getEmailBroadcaster()`: off while the global broadcaster is off. */
  readonly emailBroadcaster: boolean;
  readonly extranet: boolean;
  readonly cache: boolean;
  readonly enableLockdown: string;
  readonly lastDeployment: string | null;
  /** The `tsettings` values the admin layout reads, for those not named above. */
  readonly record: SiteRecord;
}

/** Where the request set-up moves `session.siteid`. */
export interface SessionSiteChange {
  readonly siteid: string;
  readonly userFilesPath: string;
  readonly topID: string;
  readonly openSectionList: string;
}

/** The path segments, url and form merged as rc merges them, as posted and as the start-up scan left them. */
export interface RelayScopes {
  /** As posted, each scope's `fuseaction` copied to its `muraAction`. */
  readonly posted: RequestContext;
  /** After the start-up scan, before the admin set-up changes rc. */
  readonly scanned: RequestContext;
  /** Path pairs rc holds as sent, no url or form entry replacing them; every owner call names them, as no scan reads them. */
  readonly pathPairs?: RequestContext;
}

/** Everything a shell, gate or screen reads about the current admin request. */
export interface AdminRequest {
  readonly mode: AdminMode;
  /** Circuit and action of the web path the request arrived on. */
  readonly route: AdminRequestInput['params'];
  /** Fully qualified, lower-cased FW/1 action, e.g. `core:cusers.list`. */
  readonly action: string;
  readonly circuit: string;
  readonly item: string;
  readonly rc: RequestContext;
  /** CFML form scope as posted, before the start-up scan: the fields of the request body. */
  readonly formScope: RequestContext;
  /** The request body's fields in order, names and values as posted; a file part reads as its file name. */
  readonly formFields: ReadonlyArray<readonly [string, string]>;
  /** The scopes {@link relayContext} rebuilds an owner relay from. */
  readonly relayScopes: RelayScopes;
  /** `request.generateSES`: the request carried FW/1 path segments. */
  readonly ses: boolean;
  /** `rc.currentURL`: `./` plus the URL scope as `?&name=value…`. */
  readonly currentUrl: string;
  /** The browser's request target, path and query: {@link ORIGINAL_URL_HEADER} when the gateway sent it, else web's own. */
  readonly requestTarget: string;
  readonly session: AdminSessionState;
  readonly sessionWrites: Readonly<AdminSessionWrites>;
  /** Undefined when programs-sites does not let this user read the session site. */
  readonly site?: SiteData;
  /** Sites of `session.siteArray` with their names. */
  readonly adminSites: readonly SessionSite[];
  readonly user?: UserClaims;
  readonly roles: readonly string[];
  readonly isLoggedIn: boolean;
  readonly isS2: boolean;
  readonly isSiteAdmin: boolean;
  readonly isPrivateUser: boolean;
  /** permission `getModulePerm(moduleId, <token site>)`. */
  modulePerm(moduleId: string): boolean;
  /**
   * userManager `getReversePermLookUp(<token site>)`, asked of identity at most once per request.
   * @throws GatewayDenialError When identity answers 401 or 403.
   */
  reversePermLookUp(): Promise<boolean>;
  /** The cookie scope after the set-up's writes; names are case-insensitive, values as sent. */
  readonly cookies: ReadonlyMap<string, string>;
  /** `Set-Cookie` values the response must carry. */
  readonly pendingSetCookies: readonly string[];
  readonly headers: Headers;
  readonly userAgent: string;
  readonly isMSIE: boolean;
  readonly https: boolean;
  /** `cgi.server_name`: the browser's host without its port. */
  readonly serverName: string;
  /** `cgi.http_host`. */
  readonly httpHost: string;
  /** Trusted sanitizeHref domains of the token's site, else the session site; loaded only for anonymous requests. */
  readonly hrefDomains?: HrefDomains;
  /** The set-up's `Access-Control-Allow-*` echo of an allowed `Origin` (admin/Application.cfc:521-533); empty otherwise. */
  readonly accessControlHeaders?: Readonly<Record<string, string>>;
}

/** CFML struct of simple values: case-insensitive keys that keep their first-seen casing, in insertion order. */
class CfStruct {
  readonly #entries = new Map<string, readonly [name: string, value: string]>();

  constructor(entries: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of entries) this.set(name, value);
  }

  get(name: string): string | undefined {
    return this.#entries.get(name.toLowerCase())?.[1];
  }

  has(name: string): boolean {
    return this.#entries.has(name.toLowerCase());
  }

  set(name: string, value: string): void {
    const key = name.toLowerCase();
    this.#entries.set(key, [this.#entries.get(key)?.[0] ?? name, value]);
  }

  entries(): Array<readonly [string, string]> {
    return [...this.#entries.values()];
  }
}

/** A read-only record view over `struct` whose property lookups ignore case. */
function contextView(struct: CfStruct): RequestContext {
  const target: Record<string, string> = Object.create(null) as Record<string, string>;
  return new Proxy(target, {
    get: (_target, name) => (typeof name === 'string' ? struct.get(name) : undefined),
    has: (_target, name) => typeof name === 'string' && struct.has(name),
    ownKeys: () => struct.entries().map(([name]) => name),
    getOwnPropertyDescriptor: (_target, name) => {
      const value = typeof name === 'string' ? struct.get(name) : undefined;
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

function isPairs(input: ScopeInput): input is Iterable<readonly [string, string]> {
  return Symbol.iterator in input;
}

/** A CFML URL scope: repeated names joined with `,` in order, empty values included, unnamed pairs dropped. */
function cfScope(input: ScopeInput): CfStruct {
  const scope = new CfStruct();
  for (const [name, value] of isPairs(input) ? input : Object.entries(input)) {
    if (name === '') continue;
    const previous = scope.get(name);
    scope.set(name, previous === undefined ? value : `${previous},${value}`);
  }
  return scope;
}

/** A CFML form scope, a repeated name joined as ACF joins it; unnamed pairs dropped. */
function cfFormScope(input: ScopeInput): CfStruct {
  const scope = new CfStruct();
  for (const [name, value] of isPairs(input) ? input : Object.entries(input)) {
    if (name !== '') scope.set(name, appendFormScopeValue(scope.get(name), value));
  }
  return scope;
}

// Kept in step with the shared route key, which applies this override; the ACF 2023 oracle was seen ignoring it.
/** `scope.muraAction = scope.fuseaction` when the scope has a `fuseaction`. */
function withFuseaction(scope: CfStruct): CfStruct {
  const fuseaction = scope.get('fuseaction');
  if (fuseaction !== undefined) scope.set('muraAction', fuseaction);
  return scope;
}

/** A scanned scope's entries as a struct. */
const structOf = ({ entries }: PortcullisScope): CfStruct =>
  new CfStruct(entries.map(([name, value]) => [name, String(value)] as const));

/**
 * Admin start-up's Portcullis scan of the URL scope, then the form scope under the same guard, so a URL fault leaves
 * the form as posted (admin/Application.cfc:219-296). Values of the lower-cased `files` names pass unscanned.
 */
function startupScan(url: CfStruct, form: CfStruct, files: ReadonlySet<string>): { url: CfStruct; form: CfStruct } {
  const scannedUrl = portcullisScan(url.entries());
  if (scannedUrl.failed) return { url: structOf(scannedUrl), form };
  const inputs = form.entries().map(([name, value]): PortcullisInput => [name, value, files.has(name.toLowerCase())]);
  return { url: structOf(scannedUrl), form: structOf(portcullisScan(inputs)) };
}

/** The URL scope of the gateway-forwarded request target as posted, its `fuseaction` copied to `muraAction`. */
function forwardedUrl(headers: Headers): CfStruct | undefined {
  const target = headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return undefined;
  const queryAt = target.indexOf('?');
  return withFuseaction(cfScope(new URLSearchParams(queryAt < 0 ? '' : target.slice(queryAt + 1))));
}

/** The URL scope of the gateway-forwarded request target as admin start-up's scan leaves it; undefined without one. */
export function forwardedUrlScope(headers: Headers): RequestContext | undefined {
  const url = forwardedUrl(headers);
  return url === undefined ? undefined : contextView(structOf(portcullisScan(url.entries())));
}

/** The URL scope of the gateway-forwarded request target as posted; undefined without one. */
export function forwardedPostedUrlScope(headers: Headers): RequestContext | undefined {
  const url = forwardedUrl(headers);
  return url === undefined ? undefined : contextView(url);
}

/** A context value by case-insensitive name, for views and plain records alike. */
function contextValue(rc: RequestContext, name: string): string | undefined {
  const direct = rc[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** Java `String.split('/')`: interior empty items kept, trailing ones dropped. */
function javaSplit(text: string, delimiter: string): string[] {
  const items = text.split(delimiter);
  while (items.at(-1) === '') items.pop();
  return items;
}

const listFirst = (list: string, delimiter: string): string => cfListToArray(list, delimiter)[0] ?? '';
const listLast = (list: string, delimiter: string): string => cfListToArray(list, delimiter).at(-1) ?? '';

/** FW/1's path pairs: each segment after the action names the next, or `''` when last; a later pair wins. */
function pathPairsOf(pathInfo: readonly string[]): CfStruct {
  const pairs = new CfStruct();
  for (let index = 2; index < pathInfo.length; index += 2) pairs.set(pathInfo[index] ?? '', pathInfo[index + 1] ?? '');
  return pairs;
}

/** The merged context as a mutable struct; `url` and `form` already carry their `fuseaction` override. */
function mergeScopes(pathInfo: readonly string[], url: CfStruct, form: CfStruct): CfStruct {
  const rc = new CfStruct();
  if (pathInfo.length > 0) rc.set('muraAction', pathInfo[0] ?? '');
  if (pathInfo.length > 1) rc.set('muraAction', `${pathInfo[0] ?? ''}.${pathInfo[1] ?? ''}`);
  for (const [name, value] of pathPairsOf(pathInfo).entries()) rc.set(name, value);
  for (const [name, value] of url.entries()) rc.set(name, value);
  for (const [name, value] of form.entries()) rc.set(name, value);
  return rc;
}

/** FW/1 request context: path segments, then URL, then form, each scope's `fuseaction` overriding its `muraAction`. */
export function mergeFw1Context(pathInfo: readonly string[], url: ScopeInput, form: ScopeInput): RequestContext {
  return contextView(mergeScopes(pathInfo, withFuseaction(cfScope(url)), withFuseaction(cfFormScope(form))));
}

/** FW/1 `getFullyQualifiedAction` with the admin's default subsystem `core`, case kept. */
function fullyQualifiedAction(action: string): string {
  const parts = cfListToArray(action, ':');
  const specifiesSubsystem = parts.length > 1 || action.endsWith(':');
  const subsystem = specifiesSubsystem ? (parts[0] ?? '') : 'core';
  const sectionAndItem = specifiesSubsystem ? (parts.length > 1 ? (parts.at(-1) ?? '') : '') : action;
  const items = cfListToArray(sectionAndItem, '.');
  let qualified: string;
  if (sectionAndItem === '') qualified = 'main.default';
  else if (items.length === 1) qualified = sectionAndItem.startsWith('.') ? `main.${items[0]}` : `${items[0]}.default`;
  else qualified = `${items[0] ?? ''}.${items.at(-1) ?? ''}`;
  return `${subsystem}:${qualified}`;
}

/**
 * The lower-cased FW/1 action of `rc`: `core:home.redirect` without a `muraAction`, otherwise its qualified form.
 * @throws RangeError For an action containing `/` or `\`, which FW/1 rejects.
 */
export function resolveAction(rc: RequestContext): string {
  const requested = contextValue(rc, 'muraAction');
  const action = (requested === undefined ? FW1_HOME_ACTION : fullyQualifiedAction(requested)).toLowerCase();
  if (/[/\\]/.test(action)) throw new RangeError(`Found a slash in the action: '${action}'.`);
  return action;
}

/** {@link restoreFlashContext} applied to `rc` in place. */
function restoreFlashInto(rc: CfStruct, url: CfStruct, flash: AdminSessionState['flash']): void {
  const preserveKey = url.get('fw1pk');
  if (preserveKey === undefined || !Object.hasOwn(flash, preserveKey)) return;
  for (const [name, value] of Object.entries(flash[preserveKey] ?? {})) {
    if (!rc.has(name)) rc.set(name, value);
  }
}

/** FW/1 `restoreFlashContext`: the preserved context named by the URL's `fw1pk`, added without overwriting `rc`. */
export function restoreFlashContext(
  rc: RequestContext,
  url: ScopeInput,
  flash: AdminSessionState['flash'],
): RequestContext {
  const restored = new CfStruct(Object.entries(rc));
  restoreFlashInto(restored, cfScope(url), flash);
  return contextView(restored);
}

// Legacy walks the URL scope in a per-request hash order, so no order is stable; query order is used.
/** `rc.currentURL`: `./`, then `?` and `&name=value` per URL-scope entry with its decoded value. */
function currentUrlOf(url: CfStruct): string {
  const query = url
    .entries()
    .map(([name, value]) => `&${name}=${value}`)
    .join('');
  return query === '' ? './' : `./?${query}`;
}

const RC_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['moduleid', ''],
  ['siteid', ''],
  ['muraAction', ''],
  ['layout', ''],
  ['activetab', '0'],
  ['activepanel', '0'],
  ['rb', ''],
  ['closeCompactDisplay', 'false'],
  ['compactDisplay', 'false'],
  ['param', ''],
  ['inActive', '0'],
  ['categoryID', ''],
  ['groupID', ''],
  ['membersOnly', 'false'],
  ['visitorStatus', 'All'],
];

function fillDefaults(rc: CfStruct): CfStruct {
  for (const [name, value] of RC_DEFAULTS) if (!rc.has(name)) rc.set(name, value);
  return rc;
}

/** `rc` with the admin's `cfparam` defaults added where a key is absent. */
export function applyDefaults(rc: RequestContext): RequestContext {
  return contextView(fillDefaults(new CfStruct(Object.entries(rc))));
}

/** `rc` after CFML assignments of `values`: each replaces the entry of its name in any case, which keeps its casing. */
export function assignContext(rc: RequestContext, values: Readonly<Record<string, string>>): RequestContext {
  return contextView(new CfStruct([...Object.entries(rc), ...Object.entries(values)]));
}

/**
 * `rc` as a relay to an owner sends it, so the owner's own start-up scan is the request's only one: an entry the scan
 * left as `rc` holds it goes as posted, one the set-up or a screen added or changed as `rc` holds it, and a posted
 * name the scan dropped or renamed as posted; a stripped-name copy the scan made is left for the owner's scan. A path
 * pair goes as sent, which the call's `X-Opt2-Path-Pairs` keeps from the owner's scan.
 * @param rc The screen's effective rc; `req.rc` when omitted.
 */
export function relayContext(
  req: Pick<AdminRequest, 'rc' | 'relayScopes'>,
  rc: Readonly<Record<string, string>> = req.rc,
): RequestContext {
  const { posted, scanned } = req.relayScopes;
  const relay = new CfStruct();
  for (const [name, value] of Object.entries(rc)) {
    const sent = contextValue(posted, name);
    if (contextValue(scanned, name) !== value) relay.set(name, value);
    else if (sent !== undefined) relay.set(name, sent);
  }
  for (const [name, value] of Object.entries(posted)) {
    if (contextValue(scanned, name) === undefined && contextValue(rc, name) === undefined) relay.set(name, value);
  }
  return contextView(relay);
}

/** Whether the scan of a posted `source` adds an entry `name` beside it: its `amp;`-free rename or stripped copy. */
function scanAdds(source: string, name: string): boolean {
  const lower = name.toLowerCase();
  return portcullisScan([[source, '']]).entries.some(([key]) => key !== source && key.toLowerCase() === lower);
}

/**
 * `rc[name]` as a named-field relay sends it, by {@link relayContext}'s rules: under `name` as posted where the scan
 * left it as `rc` holds it, else as `rc` holds it; a name only the scan made goes as the posted names it was made from.
 * @param rc The screen's effective rc; `req.rc` when omitted.
 * @returns The entries to send; none when `rc` lacks `name`.
 */
export function relayField(
  req: Pick<AdminRequest, 'rc' | 'relayScopes'>,
  name: string,
  rc: Readonly<Record<string, string>> = req.rc,
): RequestContext {
  const value = contextValue(rc, name);
  if (value === undefined) return {};
  const { posted, scanned } = req.relayScopes;
  if (contextValue(scanned, name) !== value) return Object.fromEntries([[name, value]]);
  const sent = contextValue(posted, name);
  if (sent !== undefined) return Object.fromEntries([[name, sent]]);
  const sources = Object.entries(posted).filter(([source]) => scanAdds(source, name));
  return Object.fromEntries(sources.length === 0 ? [[name, value]] : sources);
}

/** `values`, named as the rc fields they hold, each relayed by {@link relayField}; undefined ones are left out. */
export function relayFields(
  req: Pick<AdminRequest, 'rc' | 'relayScopes'>,
  values: Readonly<Record<string, string | undefined>>,
): RequestContext {
  const defined = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const rc = Object.fromEntries(defined);
  return Object.fromEntries(Object.keys(rc).flatMap((name) => Object.entries(relayField(req, name, rc))));
}

/** `session.dashboardSpan`: 30 days when session history is off or at least 180 days, else the history length. */
export function dashboardSpanFor(sessionHistory: number): number {
  return sessionHistory === 0 || sessionHistory >= 180 ? 30 : sessionHistory;
}

/**
 * The session site after the request names `rcSiteId`: a known, different site is switched to, an empty session
 * falls back to `default`; undefined when the session site stays as it is.
 */
export function nextSessionSite(
  rcSiteId: string,
  sessionSiteId: string,
  siteExists: (siteId: string) => boolean,
  assetPath: string = legacySettings().assetPath,
): SessionSiteChange | undefined {
  const switchTo = (siteid: string): SessionSiteChange => ({
    siteid,
    userFilesPath: `${assetPath}/${siteid}/assets/`,
    topID: HOME_CONTENT_ID,
    openSectionList: '',
  });
  if (rcSiteId !== '' && !cfEq(sessionSiteId, rcSiteId)) return siteExists(rcSiteId) ? switchTo(rcSiteId) : undefined;
  return sessionSiteId === '' ? switchTo('default') : undefined;
}

/** `rc[name]`, failing as CFML does when the element is undefined. */
function required(rc: CfStruct, name: string): string {
  const value = rc.get(name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in a CFML structure.`);
  return value;
}

/** The users advanced-search session state a request with a non-empty `param` list sets. */
function advancedSearchState(rc: CfStruct, circuit: string): AdminSessionWrites | undefined {
  const param = rc.get('param') ?? '';
  if (param === '') return undefined;
  const paramArray: AdvancedSearchParam[] = [];
  for (const n of cfListToArray(param, ',')) {
    const field = required(rc, `paramField${n}`);
    if (cfEq(field, 'Select Field') || field === '' || required(rc, `paramCriteria${n}`) === '') continue;
    paramArray.push({
      Field: field,
      Relationship: required(rc, `paramRelationship${n}`),
      Criteria: required(rc, `paramCriteria${n}`),
      Condition: required(rc, `paramCondition${n}`),
    });
  }
  return {
    paramArray,
    paramCircuit: circuit,
    paramCount: paramArray.length,
    inActive: required(rc, 'inActive'),
    paramCategories: required(rc, 'categoryID'),
    paramGroups: required(rc, 'groupID'),
    membersOnly: required(rc, 'membersOnly'),
    visitorStatus: required(rc, 'visitorStatus'),
  };
}

type Pairs = ReadonlyArray<readonly [string, string]>;

/** Query pairs as web received them, in order. */
function receivedPairs(searchParams: AdminRequestInput['searchParams']): Pairs {
  if (searchParams instanceof URLSearchParams) return [...searchParams];
  return Object.entries(searchParams).flatMap(([name, value]) =>
    value === undefined ? [] : (typeof value === 'string' ? [value] : value).map((item) => [name, item] as const),
  );
}

// A legacy form scope holds a file part's temporary path; its file name keeps the same emptiness.
/** Body fields in order, a file part read as its file name. */
function bodyPairs(form: FormData | URLSearchParams): Pairs {
  const entries: Iterable<readonly [string, FormDataEntryValue]> = form;
  return [...entries].map(([name, value]) => [name, typeof value === 'string' ? value : value.name] as const);
}

/** Lower-cased names of the body's file parts. */
function fileFieldsOf(form: AdminRequestInput['form']): Set<string> {
  if (!(form instanceof FormData)) return new Set();
  return new Set([...form].flatMap(([name, value]) => (typeof value === 'string' ? [] : [name.toLowerCase()])));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `CGI.PATH_INFO` of an admin request path, split as FW/1 splits it. */
function pathInfoOf(path: string): string[] {
  const { context, adminDir } = legacySettings();
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  const script = new RegExp(`^${escapeRegExp(`${context}${adminDir}`)}(?:/index\\.cfm)?(?=/|$)`, 'i').exec(decoded);
  const rest = script === null ? '' : decoded.slice(script[0].length);
  return rest.length > 1 ? javaSplit(rest.slice(1), '/') : [];
}

/** Path info, URL scope and form scope of the legacy request the gateway forwarded. */
export function requestScopes({ headers, searchParams, form }: AdminRequestInput): {
  pathInfo: string[];
  url: Pairs;
  form: Pairs;
} {
  const posted = form === undefined ? [] : bodyPairs(form);
  const target = headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return { pathInfo: [], url: receivedPairs(searchParams), form: posted };
  const queryAt = target.indexOf('?');
  return {
    pathInfo: pathInfoOf(queryAt < 0 ? target : target.slice(0, queryAt)),
    url: [...new URLSearchParams(queryAt < 0 ? '' : target.slice(queryAt + 1))],
    form: posted,
  };
}

/** Host without its port (`cgi.server_name`); a bracketed IPv6 literal is kept whole. */
function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : listFirst(host, ':');
}

const ANONYMOUS_USER: SessionUser = { isLoggedIn: false, userID: '' };

/** Session state identity holds: the user struct, the sites the user may administer and the stored admin values. */
interface IdentitySession {
  readonly mura: SessionUser;
  readonly sites: readonly SessionSite[];
  readonly adminState: StoredAdminState;
}

// Every admin session value lives in identity's session; without a user token there is no session to read. The site
// list is session-wide, read for any logged-in user whatever the token grants [legacy: admin/Application.cfc:432-440].
async function loadIdentitySession(
  gateway: GatewayClient,
  auth: WebAuth,
  isLoggedIn: boolean,
): Promise<IdentitySession> {
  const [current, sites, adminState] = await Promise.all([
    auth.userToken === undefined ? undefined : gateway.identity.currentSession(),
    isLoggedIn ? gateway.identity.sessionSites() : undefined,
    auth.userToken === undefined ? undefined : gateway.identity.adminSessionState(),
  ]);
  return {
    mura: current === undefined ? ANONYMOUS_USER : okBody(current, 'identity', 'getCurrentSession').user,
    sites: sites === undefined ? [] : okBody(sites, 'identity', 'listCurrentSessionSites').sites,
    adminState: adminState === undefined ? {} : okBody(adminState, 'identity', 'getAdminSessionState'),
  };
}

/** A fault legacy raises after setting session values no request a screen holds carries yet, which its session scope keeps. */
export class LegacySessionFaultError extends LegacyFaultError {
  override readonly name: string = 'LegacySessionFaultError';

  constructor(
    fault: LegacyFaultError,
    /** The session values set before the fault. */
    readonly sessionWrites: Readonly<AdminSessionWrites>,
  ) {
    super(fault.message, fault.type, fault);
  }
}

/**
 * Persists the request's session writes, `alerts` excepted (they persist as the `muraValues` entry `alerts`) and
 * `muraValues` sent as identity's `mura`, in one identity call; sends nothing without a user token or a value to store.
 * @param muraBase The `session.mura` values the request read from identity, sent with `mura` as its `muraBase`, so identity
 *   stores only this request's changes and a value a service stored meanwhile stands.
 * @throws GatewayDenialError When identity answers 401 or 403.
 * @throws Error When identity answers any other non-2xx status.
 */
export async function saveSessionWrites(
  gateway: GatewayClient,
  auth: WebAuth,
  writes: Readonly<AdminSessionWrites>,
  muraBase?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { paramArray, muraValues, ...values } = Object.fromEntries(
    Object.entries(writes).filter(([key]) => key !== 'alerts'),
  ) as Omit<AdminSessionWrites, 'alerts'>;
  const state: StoredAdminState = {
    ...values,
    ...(paramArray === undefined ? {} : { paramArray: [...paramArray] }),
    ...(muraValues === undefined ? {} : { mura: { ...muraValues } }),
    ...(muraValues === undefined || muraBase === undefined ? {} : { muraBase: { ...muraBase } }),
  };
  if (auth.userToken === undefined || Object.keys(state).length === 0) return;
  okBody(await gateway.identity.saveAdminSessionState(state), 'identity', 'saveAdminSessionState');
}

const objectEntries = (value: unknown): Array<[string, unknown]> =>
  typeof value === 'object' && value !== null ? Object.entries(value) : [];

/** `struct` with `values` assigned as CFML assigns struct keys: a key equal ignoring case keeps its stored name. */
function assignStruct<T extends Readonly<Record<string, unknown>>>(
  struct: T,
  values: Readonly<Record<string, unknown>>,
): T {
  const assigned: Record<string, unknown> = { ...struct };
  for (const [name, value] of Object.entries(values)) {
    const lower = name.toLowerCase();
    assigned[Object.keys(assigned).find((key) => key.toLowerCase() === lower) ?? name] = value;
  }
  return assigned as T;
}

/** A `session.mura` value by case-insensitive name. */
function sessionMuraValue(mura: SessionUser, name: string): unknown {
  const lower = name.toLowerCase();
  return Object.entries(mura).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** The user struct and post-login values of a session. */
export type SessionMura = Pick<AdminSessionState, 'mura' | 'muraValues'>;

/** `session.mura[name] = value` (`getCurrentUser().setValue`): `session` itself when `mura` already holds `value`. */
export function withSessionMuraValue(session: SessionMura, name: string, value: unknown): SessionMura {
  if (isDeepStrictEqual(sessionMuraValue(session.mura, name), value)) return session;
  return {
    mura: assignStruct(session.mura, { [name]: value }),
    muraValues: assignStruct(session.muraValues, { [name]: value }),
  };
}

/** {@link withSessionMuraValue} on `req.session` in place, queuing the post-login values in `req.sessionWrites`. */
export function setSessionMuraValue(req: AdminRequest, name: string, value: unknown): void {
  const next = withSessionMuraValue(req.session, name, value);
  if (next === req.session) return;
  // Both are typed read-only for screens, but are this request's own objects, which the handler persists from.
  const session = req.session as { -readonly [K in keyof SessionMura]: SessionMura[K] };
  session.mura = next.mura;
  session.muraValues = next.muraValues;
  (req.sessionWrites as SessionWriteLog).muraValues = next.muraValues;
}

/** Whether the full layout's alert block runs (template.cfm:260-261): off the login page, for S2 or a site admin. */
function runsLayoutAlerts(req: Pick<AdminRequest, 'action' | 'isS2' | 'isSiteAdmin' | 'user' | 'session'>): boolean {
  return !cfEq(req.action, 'core:cLogin.main') && administersSessionSite(req);
}

/** `session.mura.alerts` with an empty session-site entry, legacy's entries and `false` dismissals kept as stored. */
function layoutAlertsOf(session: Pick<AdminSessionState, 'siteid' | 'mura'>): Record<string, unknown> {
  return { ...Object.fromEntries(objectEntries(sessionMuraValue(session.mura, 'alerts'))), [session.siteid]: {} };
}

/**
 * The full layout's `session.mura.alerts[session.siteid]={}` (template.cfm:260-265) on `req`, queued for persisting,
 * when its alert block runs and the session site has no entry.
 */
export function setLayoutAlerts(req: AdminRequest): void {
  if (!runsLayoutAlerts(req)) return;
  const site = req.session.siteid.toLowerCase();
  if (objectEntries(sessionMuraValue(req.session.mura, 'alerts')).some(([id]) => id.toLowerCase() === site)) return;
  setSessionMuraValue(req, 'alerts', layoutAlertsOf(req.session));
}

/** `session.mura.alerts` of the user struct, with `type` and `text` read as strings. */
function alertsOf(mura: SessionUser): Record<string, Record<string, AdminAlert>> {
  return Object.fromEntries(
    objectEntries(mura.alerts).map(([siteId, siteAlerts]) => [
      siteId,
      Object.fromEntries(
        objectEntries(siteAlerts).map(([id, alert]) => {
          const { type, text } = (alert ?? {}) as { type?: unknown; text?: unknown };
          return [id, { type: String(type ?? ''), text: String(text ?? '') }];
        }),
      ),
    ]),
  );
}

/** Named view of the served site settings; flags read as CFML truthiness of the served integer. */
export function siteDataOf(record: SiteRecord, defaultLocale: string): SiteData {
  const flag = (value: number | null | undefined): boolean => (value ?? 0) !== 0;
  const text = (value: string | null | undefined): string => value ?? '';
  const pool = (value: string | undefined): string => value ?? record.SiteID;
  const siteLocale = text(record.siteLocale);
  return {
    siteid: record.SiteID,
    site: text(record.Site),
    domain: text(record.Domain),
    siteLocale,
    javaLocale: cf2Java(siteLocale !== '' ? siteLocale : defaultLocale),
    publicUserPoolID: pool(record.publicUserPoolID),
    privateUserPoolID: pool(record.privateUserPoolID),
    displayPoolID: pool(record.displayPoolID),
    contentPoolID: pool(record.contentPoolID),
    categoryPoolID: pool(record.categoryPoolID),
    filePoolID: pool(record.filePoolID),
    hasChangesets: flag(record.hasChangesets),
    hasComments: flag(record.hasComments),
    hasFeedManager: flag(record.feedManager),
    emailBroadcaster: flag(record.EmailBroadcaster),
    extranet: flag(record.Extranet),
    cache: flag(record.Cache),
    enableLockdown: text(record.enableLockdown),
    lastDeployment: record.lastDeployment ?? null,
    record,
  };
}

/** Whether a site exists, with its data when programs-sites served it. */
interface SiteLookup {
  readonly exists: boolean;
  readonly site?: SiteData;
}

/**
 * A site as programs-sites reads it.
 * @throws GatewayDenialError When programs-sites refuses this user the read (401 or 403).
 */
async function readSite(gateway: GatewayClient, siteId: string, defaultLocale: string): Promise<SiteLookup> {
  const response = await gateway.programsSites.getShellSite(siteId);
  // The contract rejects an id longer than a tsettings SiteID, which names no site.
  if (!response.ok && response.status === 400) return { exists: false };
  const { isNew, site } = okBody(response, 'programs-sites', 'getShellSite');
  return isNew === 1 ? { exists: false } : { exists: true, site: siteDataOf(site, defaultLocale) };
}

/** Whether services accept `siteId` under a token of `claims`, by the platform's case-insensitive site check. */
export function tokenServesSite(claims: Pick<UserClaims, 'site'>, siteId: string): boolean {
  try {
    assertSiteMatches(siteId, claims);
    return true;
  } catch (error) {
    if (error instanceof AuthDenial) return false;
    throw error;
  }
}

// identity mints site-admin and m:<NNN> for the token's site, while legacy checks them for getSite(rc.siteid), which
// answers `default` for an empty id; so they count only when the token serves that site.
/** Whether the token's site-scoped roles apply to the site `getSite(rc.siteid)` reads. */
export function servesRequestedSite(req: Pick<AdminRequest, 'user' | 'rc'>): boolean {
  return req.user !== undefined && tokenServesSite(req.user, req.rc['siteid'] || 'default');
}

/** Membership `Admin;<privateUserPoolID of getSite(rc.siteid)>;0` or `S2` (global), read from the verified claims. */
export function administersRequestedSite(req: Pick<AdminRequest, 'isS2' | 'isSiteAdmin' | 'user' | 'rc'>): boolean {
  return req.isS2 || (req.isSiteAdmin && servesRequestedSite(req));
}

/** Whether the token's site-scoped roles apply to the site `getSite(session.siteid)` reads. */
export function servesSessionSite(req: Pick<AdminRequest, 'user' | 'session'>): boolean {
  return req.user !== undefined && tokenServesSite(req.user, req.session.siteid || 'default');
}

/** Membership `Admin;<privateUserPoolID of getSite(session.siteid)>;0` or `S2`, which the layout checks. */
export function administersSessionSite(req: Pick<AdminRequest, 'isS2' | 'isSiteAdmin' | 'user' | 'session'>): boolean {
  return req.isS2 || (req.isSiteAdmin && servesSessionSite(req));
}

/** permission `getModulePerm(moduleId, session.siteid)`: S2, else the token's module grant when it serves that site. */
export function sessionSiteModulePerm(
  req: Pick<AdminRequest, 'isS2' | 'user' | 'session' | 'modulePerm'>,
  moduleId: string,
): boolean {
  return req.isS2 || (servesSessionSite(req) && req.modulePerm(moduleId));
}

// Services serve only the token's site, so any other site is known to exist only through the identity-computed site
// list, and its locale falls back to the default locale.
/** Per-request site lookups, each site read at most once; a denied read rejects with GatewayDenialError. */
function siteLookups(
  gateway: GatewayClient,
  canRead: (siteId: string) => boolean,
  siteArray: readonly string[],
  defaultLocale: string,
): (siteId: string) => Promise<SiteLookup> {
  const lookups = new Map<string, Promise<SiteLookup>>();
  const lookup = async (siteId: string): Promise<SiteLookup> =>
    (canRead(siteId) ? await readSite(gateway, siteId, defaultLocale) : undefined) ?? {
      exists: siteArray.some((id) => id.toLowerCase() === siteId.toLowerCase()),
    };
  return (siteId) => {
    let found = lookups.get(siteId);
    if (found === undefined) {
      found = lookup(siteId);
      lookups.set(siteId, found);
    }
    return found;
  };
}

/** `reversePermLookUp`: false logged out, true with Users module access, else identity's answer, read once. */
function reverseLookup(
  gateway: GatewayClient,
  isLoggedIn: boolean,
  modulePerm: AdminRequest['modulePerm'],
): AdminRequest['reversePermLookUp'] {
  let granted: Promise<boolean> | undefined;
  const lookUp = async (): Promise<boolean> => {
    // A logged-out session has no memberships, which fails every legacy branch.
    if (!isLoggedIn) return false;
    if (modulePerm(USERS_MODULE_ID)) return true;
    return okBody(await gateway.identity.reversePermLookUp(), 'identity', 'getReversePermLookUp').granted;
  };
  return () => {
    granted ??= lookUp();
    return granted;
  };
}

/** CFML `URLEncodedFormat`: every character but ASCII letters and digits as `%XX` of its UTF-8 bytes. */
export function urlEncodedFormat(value: string): string {
  return encodeURIComponent(value).replace(/[-_.!~*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The `Set-Cookie` values the admin set-up writes at `now`, applied to `cookies`, in the order ACF emits them. */
function adminCookies(cookies: Map<string, string>, rcRb: string, now: Date): string[] {
  const { secureCookies, cookieDomain } = legacySettings();
  const pending: string[] = [];
  // ACF writes `cookie.rb` assignments URL-encoded, keeping the case of a `param` default and upper-casing the rest.
  const cookieScope = (name: string, value: string, maintainCase: boolean): void => {
    const encoded = urlEncodedFormat(value);
    pending.push(cookieScopeNeverCookie(maintainCase ? name : name.toUpperCase(), encoded, secureCookies, now));
    cookies.set(name, encoded);
  };
  if (!cookies.has('rb')) cookieScope('rb', '', true);
  if (rcRb !== '') cookieScope('rb', rcRb, false);
  for (const [name, value] of [
    ['ADMINCONTROLWIDTH', '300'],
    ['ADMINSIDEBAR', 'off'],
  ] as const) {
    if (cookies.has(name)) continue;
    pending.push(cfcookieNeverCookie(name, value, secureCookies, now, false, cookieDomain));
    cookies.set(name, value);
  }
  return pending;
}

/** `session.rb` when nothing set it: from the configured default locale (`Server`, `Client` or a locale name). */
function defaultRb(defaultLocale: string, acceptLanguage: string): string {
  if (cfEq(defaultLocale, 'Server')) return cf2Java('Server');
  if (cfEq(defaultLocale, 'Client')) return listFirst(acceptLanguage, ';');
  // Legacy keeps a ColdFusion-supported locale name as written; every configured name is converted here.
  return cf2Java(defaultLocale);
}

type SessionDraft = { -readonly [K in Exclude<keyof AdminSessionState, 'dateKey'>]: AdminSessionState[K] };
type WritableKey = keyof AdminSessionWrites;
type SessionWriteLog = { -readonly [K in WritableKey]?: AdminSessionState[K] };

/** The session scope before this request's set-up: identity's stored values, else the legacy `cfparam` defaults. */
function initialSession(identity: IdentitySession, sessionHistory: number): SessionDraft {
  const stored = identity.adminState;
  const muraValues = stored.mura ?? {};
  const mura = assignStruct(identity.mura, muraValues);
  const memberships = cfListToArray(mura.memberships ?? '', ',');
  return {
    siteid: stored.siteid ?? '',
    userFilesPath: stored.userFilesPath ?? '',
    topID: stored.topID ?? '',
    openSectionList: stored.openSectionList ?? '',
    moduleid: stored.moduleid ?? '',
    keywords: stored.keywords ?? '',
    datakeywords: stored.datakeywords ?? '',
    filterBy: stored.filterBy ?? '',
    rb: stored.rb ?? '',
    locale: stored.locale ?? '',
    dateKeyFormat: stored.dateKeyFormat ?? '',
    localeHasDayParts: stored.localeHasDayParts ?? true,
    dashboardSpan: stored.dashboardSpan ?? dashboardSpanFor(sessionHistory),
    alerts: alertsOf(mura),
    paramArray: stored.paramArray ?? [],
    paramCount: stored.paramCount ?? 0,
    paramCircuit: stored.paramCircuit ?? '',
    paramCategories: stored.paramCategories ?? '',
    paramGroups: stored.paramGroups ?? '',
    inActive: stored.inActive ?? '',
    membersOnly: stored.membersOnly ?? 'false',
    visitorStatus: stored.visitorStatus ?? 'All',
    frontEndProxyLoc: stored.frontEndProxyLoc ?? '',
    siteArray: identity.sites.map(({ siteID }) => siteID),
    s2IsPrivate: memberships.includes('S2IsPrivate'),
    mura,
    muraValues,
    hasDefaultPassword: stored.hasdefaultpassword !== undefined,
    moduleTopIds: stored.moduleTopIds ?? {},
    flash: stored.flash ?? {},
    nextPreserveKey: stored.nextPreserveKey ?? 1,
  };
}

/**
 * The admin request context legacy establishes before a controller or view runs.
 * @throws GatewayDenialError When identity or programs-sites answers 401 or 403.
 */
export async function buildAdminRequest(input: AdminRequestInput): Promise<AdminRequest> {
  const { headers, auth, gateway, mode } = input;
  const settings = legacySettings();
  const user = auth.user;
  const roles = user?.roles ?? [];
  // An anonymous session's token carries an empty `sub`.
  const isLoggedIn = user !== undefined && user.sub !== '';
  const isS2 = user?.s2 === true || roles.includes(Roles.s2);
  const isSiteAdmin = roles.includes(Roles.siteAdmin);

  const identityLoad = loadIdentitySession(gateway, auth, isLoggedIn);
  const scopes = requestScopes(input);
  const postedUrl = withFuseaction(cfScope(scopes.url));
  const posted = withFuseaction(cfFormScope(scopes.form));
  const { url, form } = startupScan(postedUrl, posted, fileFieldsOf(input.form));
  const rc = mergeScopes(scopes.pathInfo, url, form);
  const pathPairs = pathPairsOf(scopes.pathInfo)
    .entries()
    .filter(([name]) => !url.has(name) && !form.has(name));
  const relayScopes: RelayScopes = {
    posted: contextView(mergeScopes(scopes.pathInfo, postedUrl, posted)),
    scanned: contextView(new CfStruct(rc.entries())),
    pathPairs: contextView(new CfStruct(pathPairs)),
  };
  const action = resolveAction(contextView(rc));
  const circuit = listLast(listFirst(action, '.'), ':');
  const identity = await identityLoad;

  const session = initialSession(identity, settings.sessionHistory);
  const sessionWrites: SessionWriteLog = {};
  const write = <K extends WritableKey>(key: K, value: AdminSessionState[K]): void => {
    if (isDeepStrictEqual(session[key], value)) return;
    session[key] = value;
    sessionWrites[key] = value;
  };
  const writeAll = (values: AdminSessionWrites): void => {
    for (const [key, value] of Object.entries(values) as Array<[WritableKey, AdminSessionState[WritableKey]]>) {
      write(key, value);
    }
  };

  restoreFlashInto(rc, url, session.flash);
  rc.set('muraAction', action);
  fillDefaults(rc);

  const cookies = parseCookieHeader(headers.get('cookie') ?? undefined);
  const rcRb = rc.get('rb') ?? '';
  const pendingSetCookies = adminCookies(cookies, rcRb, input.now ?? new Date());
  if (rcRb !== '') write('rb', rcRb);
  write('dashboardSpan', dashboardSpanFor(settings.sessionHistory));

  const lookup = siteLookups(
    gateway,
    (siteId) =>
      isLoggedIn && (isS2 || isSiteAdmin || roles.includes(Roles.systemUser)) && tokenServesSite(user, siteId),
    session.siteArray,
    settings.defaultLocale,
  );
  const rcSiteId = rc.get('siteid') ?? '';
  const requested = rcSiteId !== '' && !cfEq(session.siteid, rcSiteId) ? await lookup(rcSiteId) : undefined;
  const change = nextSessionSite(rcSiteId, session.siteid, () => requested?.exists === true, settings.assetPath);
  if (change !== undefined) writeAll(change);

  const sessionSite = session.siteid === '' ? undefined : await lookup(session.siteid);
  const siteId = fallbackSiteId(session.siteid, () => sessionSite?.exists === true);
  const site = siteId === session.siteid ? sessionSite?.site : (await lookup(siteId)).site;

  const locale = site?.javaLocale ?? cf2Java(settings.defaultLocale);
  const dateKey = dateKeyFor(locale);
  write('locale', locale);
  if (session.rb === '') write('rb', defaultRb(settings.defaultLocale, headers.get('accept-language') ?? ''));
  write('dateKeyFormat', dateKey.dateKeyFormat);
  write('localeHasDayParts', localeHasDayParts(locale));

  const alertSite = session.siteid.toLowerCase();
  const layoutAlerts = runsLayoutAlerts({ action, isS2, isSiteAdmin, user, session: { ...session, dateKey } });
  if (layoutAlerts && !Object.keys(session.alerts).some((id) => id.toLowerCase() === alertSite)) {
    // Request-local; setLayoutAlerts persists it when the answer renders the full layout.
    session.alerts = alertsOf(withSessionMuraValue(session, 'alerts', layoutAlertsOf(session)).mura);
  }
  if (!cfEq(action, 'core:csettings.editSite') && (rc.get('siteid') ?? '') === '' && session.siteid !== '') {
    rc.set('siteid', session.siteid);
  }
  const moduleid = rc.get('moduleid') ?? '';
  if (moduleid !== '') write('moduleid', moduleid);
  writeAll(advancedSearchState(rc, circuit) ?? {});
  const frontEndProxyLoc = rc.get('frontEndProxyLoc') ?? '';
  if (frontEndProxyLoc !== '') write('frontEndProxyLoc', frontEndProxyLoc);

  const forwardedHost = listFirst(headers.get('x-forwarded-host') ?? '', ',').trim();
  const userAgent = headers.get('user-agent') ?? '';
  // programs-sites serves only a presented token's site, and resolves an empty or unknown id to `default` as legacy's
  // getSite does. Without a token, an empty session site means rc.siteid was not switched to, so that id is sent.
  const hrefSiteId = user !== undefined ? user.site : session.siteid === '' ? rcSiteId : session.siteid;
  const hrefDomains = isLoggedIn ? undefined : await loadHrefDomains(gateway, hrefSiteId, forwardedHost);
  // getAccessControlOriginDomainArray is read only for a request carrying an Origin.
  const origin = headers.get('origin') ?? undefined;
  const originDomains =
    origin === undefined ? undefined : (hrefDomains ?? (await loadHrefDomains(gateway, hrefSiteId, forwardedHost)));
  const modulePerm = (moduleId: string): boolean =>
    isS2 || isSiteAdmin || (isCoreModuleId(moduleId) && hasAnyRole(roles, [moduleRole(moduleId)]));
  return {
    mode,
    route: input.params,
    action,
    circuit,
    item: listLast(action, '.'),
    rc: contextView(rc),
    formScope: contextView(posted),
    formFields: scopes.form,
    relayScopes,
    ses: scopes.pathInfo.length > 0,
    currentUrl: currentUrlOf(url),
    requestTarget: headers.get(ORIGINAL_URL_HEADER) ?? input.receivedTarget,
    session: { ...session, dateKey },
    sessionWrites,
    site,
    adminSites: identity.sites,
    user,
    roles,
    isLoggedIn,
    isS2,
    isSiteAdmin,
    isPrivateUser: isS2 || roles.includes(Roles.systemUser),
    modulePerm,
    reversePermLookUp: reverseLookup(gateway, isLoggedIn, modulePerm),
    cookies,
    pendingSetCookies,
    headers,
    userAgent,
    isMSIE: /msie/i.test(userAgent),
    https: listFirst(headers.get('x-forwarded-proto') ?? '', ',').trim().toLowerCase() === 'https',
    serverName: hostName(forwardedHost),
    httpHost: forwardedHost,
    hrefDomains,
    accessControlHeaders: corsHeaders(origin, originDomains?.allowedDomains ?? []),
  };
}

