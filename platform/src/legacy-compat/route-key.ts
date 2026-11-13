/**
 * The one OPT-2 route key, shared by the inventory, cut-over groups, gateway dispatcher and golden coverage.
 *
 * Key: `<family>:<body>`, plus `{<variant>}` when a declared variant matched; always lower-case.
 *   api, rest  `<method>` | `<entity>.<op>` | `<entity>.~<segment>` | `<entity>.http-<verb>` | `.<generic>` | `!<errortype>`;
 *              rest also `oauth`, `oauth2`, `tokeninfo`
 *   feed `v1` · render `small|medium|file|!server_error` · trackopen `open` · variation `js` · sitemonitor `run`
 *   widgets `redirect` · asset `upload|render|!server_error`
 *   apiother, cfm, static, opt2, bridge  `<normalised path>`
 *   cfc        `<path>?method=<method>` | `<path>`
 *   admin      `<section>.<item>` (subsystem `core:` dropped) | `<subsystem>:<section>.<item>` | `!actioncontainsslash`
 *   fixture    `<module>/<resource>[/{id}][/<seg>…]@<httpmethod>` | `!notfound@<httpmethod>`
 *   page       `render` | `<doaction>[,<doaction>…]` | `saveform` | `<doaction>[,…]+saveform`
 *   reload     `application`: URL reload key, unless url `method=processAsyncObject` (onRequestStart_include.cfm:114-138)
 */
import {
  CONTENTNAV_ENTITY,
  ENTITY_PRIMARY_KEYS,
  REGISTERED_ENTITIES,
  VARIATION_ENTITY,
  isDefinedApiName,
  isGenericMethod,
  isPublicMethod,
  isValidVariableName,
} from './jsonapi-names.js';
import { isCfUuid, isLegacyFindOneId } from './ids.js';
import { cfEq, cfIsBoolean, cfToBoolean } from './serializer.js';

/** Route families, the first token of every key. */
export const ROUTE_FAMILIES = Object.freeze([
  'api',
  'rest',
  'feed',
  'render',
  'trackopen',
  'variation',
  'sitemonitor',
  'widgets',
  'asset',
  'apiother',
  'cfc',
  'admin',
  'fixture',
  'cfm',
  'static',
  'page',
  'opt2',
  'bridge',
  'reload',
] as const);

/** A route family token. */
export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

/** Request facts a key is derived from; header names are matched case-insensitively. */
export interface RouteKeyRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string | string[]>;
  form?: Record<string, string | string[]>;
  /** Parsed body, when the request had one. */
  jsonBody?: unknown;
  headers: Record<string, string | string[] | undefined>;
  multipartFileNames?: Array<{ field: string; filename: string }>;
}

/** Legacy configuration and runtime registries the key depends on. */
export interface RouteKeyOptions {
  /** settingsManager.siteExists; default: every site exists. */
  siteExists?: (siteId: string) => boolean;
  variants?: readonly VariantDeclaration[];
  /** configBean adminDir; default `/admin`. */
  adminDir?: string;
  /** configBean context; default ''. */
  context?: string;
  /** application.appreloadkey; default `appreload` (onApplicationStart_include.cfm:80). */
  appReloadKey?: string;
  /** configBean `variations`; default false. */
  variationsEnabled?: boolean;
  /** Names serviceFactory.containsBean accepts; default the registered entities plus `entity`. */
  knownEntities?: readonly string[];
  /** application.objectmappings.<entity>.remoteFunctions names. */
  entityRemoteFunctions?: Record<string, readonly string[]>;
  /** application.objectmappings.<entity>.properties names that carry a `cfc`. */
  entityRelationships?: Record<string, readonly string[]>;
  /** Entity primary keys, merged over ENTITY_PRIMARY_KEYS. */
  entityPrimaryKeys?: Record<string, string>;
  /** Plugin method names added through registerMethod. */
  registeredMethods?: readonly string[];
}

/** A computed route key and the request facts it was derived from. */
export interface RouteKeyResult {
  key: string;
  baseKey: string;
  family: RouteFamily;
  variant?: string;
  siteId?: string;
  /** Request method after X-HTTP-Method-Override as the family reads it, upper-case; fixtures ignore an empty override. */
  httpMethod: string;
  /** The family's merged params as legacy merges them, lower-cased keys, simple values only. */
  params: Record<string, string>;
  /** Reload only: the route legacy serves once start-up has re-run (session effects, CSRF claims, 503 surface). */
  afterReload?: RouteKeyResult;
}

/** A request-decidable predicate of a variant declaration. */
export type VariantCondition =
  | { param: string; equals: string }
  | { param: string; in: readonly string[] }
  | { param: string; nonEmpty: true }
  | { param: string; truthy: true }
  | { multipartExtensionIn: readonly string[] }
  | { anyOf: readonly VariantCondition[] }
  | { not: VariantCondition };

/** A variant of a base route key; the first declaration whose conditions all hold wins. */
export interface VariantDeclaration {
  route: string;
  variant: string;
  when: readonly VariantCondition[];
}

// userManager.cfc:499,650 test `removePhotoFile eq "true"`; `truthy` is a superset, so more requests stay withheld.
/** User or group save that sets or removes a photo (userManager.cfc:495-501, 650-651). */
export const PHOTO_CONDITION: VariantCondition = Object.freeze<VariantCondition>({
  anyOf: Object.freeze<VariantCondition[]>([
    Object.freeze<VariantCondition>({ param: 'newFile', nonEmpty: true }),
    Object.freeze<VariantCondition>({ param: 'removePhotoFile', truthy: true }),
  ]),
});

/** Upload whose file Masa writes renditions for (fileDAO.cfc:159-179). */
export const IMAGE_UPLOAD_CONDITION: VariantCondition = Object.freeze<VariantCondition>({
  multipartExtensionIn: Object.freeze(['png', 'gif', 'jpg', 'jpeg', 'flv']),
});

/** Request carrying a form submission (core/modules/v1/form/index.cfm:114). */
export const SAVEFORM_CONDITION: VariantCondition = Object.freeze<VariantCondition>({ param: 'saveform', nonEmpty: true });

/** Gateway-set header naming, comma-separated and in any case, the REST credential params its exchange consumed. */
export const REST_CONSUMED_PARAMS_HEADER = 'X-Opt2-Consumed-Params';

/** Extra request facts any entry point may carry. */
interface EntryPointExtras {
  params?: Record<string, string>;
  multipartFileNames?: Array<{ field: string; filename: string }>;
  headers?: Record<string, string | string[] | undefined>;
}

/** An inventoried entry point, keyed through a canonical synthetic request. */
export type RouteEntryPoint = EntryPointExtras &
  (
    | { kind: 'admin'; action: string }
    | { kind: 'api'; family?: 'api' | 'rest'; method: string; entity?: string; siteId?: string }
    | { kind: 'page'; doaction?: readonly string[]; saveform?: boolean }
    | { kind: 'cfc'; path: string; method: string }
    | { kind: 'fixture'; httpMethod: string; path: string }
    | { kind: 'path'; httpMethod?: string; path: string; query?: Record<string, string> }
    | { kind: 'reload'; admin?: boolean }
  );

type Scope = Readonly<Record<string, string | readonly string[]>>;
/** Case-insensitive CFML struct: lower-cased keys; strings, or complex values from a JSON body. */
type ParamMap = Map<string, unknown>;
type LegacyErrorType = 'invalidparameters' | 'invalidmethodcall' | 'invalidentitycall' | 'server_error';

/** A CFML `throw(type=…)` that processRequest's catch blocks turn into an error response. */
class LegacyThrow extends Error {
  constructor(readonly type: LegacyErrorType) {
    super(type);
  }
}

interface ResolvedOptions {
  siteExists: (siteId: string) => boolean;
  variants: readonly VariantDeclaration[];
  adminSegments: readonly string[];
  context: string;
  appReloadKey: string;
  variationsEnabled: boolean;
  knownEntities: ReadonlySet<string>;
  remoteFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  relationships: ReadonlyMap<string, ReadonlySet<string>>;
  primaryKeys: ReadonlyMap<string, string>;
  registeredMethods: readonly string[];
}

interface NormalisedPath {
  path: string;
  /** Non-empty segments before the removed `index.cfm`; -1 when none was removed. */
  indexAt: number;
  /** `path` as the root front controller reads it: urlDecoded once more (contentServer.cfc:167). */
  rootPath: string;
}

interface BaseRoute {
  family: RouteFamily;
  body: string;
  params: ParamMap;
  siteId?: string;
  /** The family's own effective method, when it reads X-HTTP-Method-Override differently from the JSON API. */
  httpMethod?: string;
}

const GLOB_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['opt2', 'bridge', 'static', 'cfm', 'apiother']);
/** OPT-2 namespaces and the fixture front controller, whose Application.cfc suppresses the reload. */
const NO_RELOAD_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['opt2', 'bridge', 'fixture']);
const RELOAD_KEY = 'reload:application';
const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/';
const BRIDGE_PREFIX = '/gateway/legacy-bridge/';
const RFC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
const PATH_PARAM_CHARS = /[^0-9A-Za-z._,\-*]/g;
const ENTITY_NAME_CHARS = /[^0-9A-Za-z_,\-*]/g;
const REST_HEADER_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ['X-client_id', 'client_id'],
  ['X-client_secret', 'client_secret'],
  ['X-access_token', 'access_token'],
  ['X-client-id', 'client_id'],
  ['X-client-secret', 'client_secret'],
  ['X-access-token', 'access_token'],
];
/** The params legacy's REST credential block deletes; the only names {@link REST_CONSUMED_PARAMS_HEADER} may remove. */
const REST_CREDENTIAL_PARAMS: ReadonlySet<string> = new Set(['client_id', 'client_secret', 'access_token', 'refresh_token']);

// ---- CFML semantics ----

/** CFML listToArray: items between any delimiter character, empty items dropped. */
function listToArray(s: string, delimiters = ','): string[] {
  const items: string[] = [];
  let current = '';
  for (const ch of s) {
    if (delimiters.includes(ch)) {
      if (current !== '') items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') items.push(current);
  return items;
}

function listFirst(s: string, delimiters = ','): string {
  return listToArray(s, delimiters)[0] ?? '';
}

function listLast(s: string, delimiters = ','): string {
  const items = listToArray(s, delimiters);
  return items[items.length - 1] ?? '';
}

function listLen(s: string, delimiters = ','): number {
  return listToArray(s, delimiters).length;
}

/** CFML listFind: case-sensitive. */
function listFind(list: string, value: string): boolean {
  return listToArray(list).includes(value);
}

function startsNoCase(s: string, prefix: string): boolean {
  return s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

// ---- Params ----

function scopeValue(v: string | readonly string[]): string {
  return typeof v === 'string' ? v : v.join(',');
}

function scopeMap(scope: Scope | undefined): ParamMap {
  const map: ParamMap = new Map();
  for (const [k, v] of Object.entries(scope ?? {})) map.set(k.toLowerCase(), scopeValue(v));
  return map;
}

/** CFML structAppend; `overwrite=false` keeps existing keys (servletEvent.cfc:85-86). */
function append(target: ParamMap, source: ParamMap, overwrite = true): ParamMap {
  for (const [k, v] of source) if (overwrite || !target.has(k)) target.set(k, v);
  return target;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** deserializeJSON values: simple values as strings, objects and arrays kept as complex values. */
function jsonMap(body: Record<string, unknown>): ParamMap {
  const map: ParamMap = new Map();
  for (const [k, v] of Object.entries(body)) {
    map.set(k.toLowerCase(), v === null ? '' : typeof v === 'object' ? v : String(v));
  }
  return map;
}

/** A simple value as a string; a complex value throws, as CFML string operations on it do. */
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  throw new LegacyThrow('server_error');
}

function str(map: ParamMap, key: string): string | undefined {
  const v = map.get(key);
  return v === undefined ? undefined : asStr(v);
}

/** CFML 1-based array access; a missing item reads as ''. */
function nth(items: readonly string[], n: number): string {
  return items[n - 1] ?? '';
}

function simpleParams(map: ParamMap): Record<string, string> {
  return Object.fromEntries([...map].filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function header(headers: RouteKeyRequest['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted && v !== undefined) return typeof v === 'string' ? v : v.join(', ');
  }
  return undefined;
}

function lowerSetMap(record: Record<string, readonly string[]> | undefined): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, Set<string>>();
  for (const [k, names] of Object.entries(record ?? {})) map.set(k.toLowerCase(), new Set(names.map((n) => n.toLowerCase())));
  return map;
}

function resolveOptions(opts: RouteKeyOptions): ResolvedOptions {
  const variationsEnabled = opts.variationsEnabled ?? false;
  const known =
    opts.knownEntities ?? [...REGISTERED_ENTITIES, 'entity', ...(variationsEnabled ? [VARIATION_ENTITY] : [])];
  const adminSegments = listToArray(opts.adminDir ?? '/admin', '/');
  return {
    siteExists: opts.siteExists ?? (() => true),
    variants: opts.variants ?? [],
    adminSegments: adminSegments.length ? adminSegments : ['admin'],
    context: opts.context ?? '',
    appReloadKey: (opts.appReloadKey ?? 'appreload').toLowerCase(),
    variationsEnabled,
    knownEntities: new Set(known.map((e) => e.toLowerCase())),
    remoteFunctions: lowerSetMap(opts.entityRemoteFunctions),
    relationships: lowerSetMap(opts.entityRelationships),
    primaryKeys: new Map(
      Object.entries({ ...ENTITY_PRIMARY_KEYS, ...opts.entityPrimaryKeys }).map(([e, pk]) => [e.toLowerCase(), pk]),
    ),
    registeredMethods: opts.registeredMethods ?? [],
  };
}

// ---- Path normalisation ----

/** UTF-8 percent-decoding: `cfml` as urlDecode (`+` to space, malformed escape kept), else as the container (malformed: undefined). */
function percentDecode(s: string, cfml: true): string;
function percentDecode(s: string, cfml: false): string | undefined;
function percentDecode(s: string, cfml: boolean): string | undefined {
  let out = '';
  const bytes: number[] = [];
  const flush = (): void => {
    out += Buffer.from(bytes).toString('utf8');
    bytes.length = 0;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '%' && HEX_PAIR.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    flush();
    if (ch === '%') {
      if (!cfml) return undefined;
      out += s.slice(i, i + 3);
      i += 2;
    } else {
      out += cfml && ch === '+' ? ' ' : ch;
    }
  }
  flush();
  return out;
}

/** URL-decoded path without the context and the first `index.cfm` segment (contentServer.cfc:141-165). */
function normalisePath(rawPath: string, context: string): NormalisedPath {
  const decoded = percentDecode(rawPath, false);
  let path = decoded ?? rawPath;
  if (!path.startsWith('/')) path = `/${path}`;
  const ctx = context && context !== '/' ? `/${listToArray(context, '/').join('/')}` : '';
  if (ctx.length > 1 && (path.toLowerCase() === ctx.toLowerCase() || startsNoCase(path, `${ctx}/`))) {
    path = path.slice(ctx.length) || '/';
  }
  // A path the container rejects never reaches CFML, so it gets no second decode.
  const rootPath = (p: string): string => (decoded === undefined ? p : percentDecode(p, true));
  const parts = path.split('/');
  const at = parts.findIndex((p, i) => i > 0 && p.toLowerCase() === 'index.cfm');
  if (at < 0) return { path, indexAt: -1, rootPath: rootPath(path) };
  const indexAt = parts.slice(0, at).filter((p) => p !== '').length;
  const wasLast = at === parts.length - 1;
  parts.splice(at, 1);
  let stripped = parts.join('/') || '/';
  if (wasLast && !stripped.endsWith('/')) stripped += '/';
  return { path: stripped, indexAt, rootPath: rootPath(stripped) };
}


// ---- JSON API (jsonApiUtility.cfc processRequest) ----

interface RouteContext {
  req: RouteKeyRequest;
  /** Normalised path. */
  path: string;
  segments: string[];
  httpMethod: string;
  opts: ResolvedOptions;
}

function has(registry: ReadonlyMap<string, ReadonlySet<string>>, entity: string, name: string): boolean {
  return registry.get(entity.toLowerCase())?.has(name.toLowerCase()) ?? false;
}

function keyForMethod(method: string, entity: string | undefined): string {
  return isGenericMethod(method) ? `${entity ?? ''}.${method}` : method;
}

/** parseParamsFromPath: odd items name a param, even items give the previous one its value (jsonApiUtility.cfc:1641-1660). */
function parsePathParams(pi: readonly string[], P: ParamMap, start: number): void {
  const items = pi.slice(start - 1);
  items.forEach((item, i) => {
    if (cfEq(item, 'method')) throw new LegacyThrow('invalidmethodcall');
    const name = i % 2 === 0 ? item : nth(items, i);
    P.set(name.replace(PATH_PARAM_CHARS, '').toLowerCase(), i % 2 === 0 ? '' : item);
  });
}

// A name that survives sanitising may still be found in a module model dir at runtime, so it keeps its key.
/** doubleCheckEntityName: an unsanitisable name is an invalid entity call (jsonApiUtility.cfc:1408-1413). */
function doubleCheckEntityName(entity: string): void {
  if (!isValidVariableName(entity.replace(ENTITY_NAME_CHARS, ''))) throw new LegacyThrow('invalidentitycall');
}

/** Content path ids; legacy appends segment 3 to itself unless it is `_path` or `_variation` (jsonApiUtility.cfc:1171-1191). */
function setContentPathId(pi: readonly string[], P: ParamMap): void {
  const first = nth(pi, 3);
  const rendered = cfEq(first, '_path') || cfEq(first, '_variation');
  if (rendered) {
    P.set('render', 'true');
    P.set('variation', cfEq(first, '_variation') ? 'true' : 'false');
  }
  let id = rendered ? '' : first;
  for (let i = rendered ? 4 : 3; i <= pi.length; i++) id = id === '' ? nth(pi, i) : `${id}/${nth(pi, i)}`;
  P.set('id', id);
}

/** REST credential handling before method resolution (jsonApiUtility.cfc:422-835); returns the key when identity serves the request. */
function restCredentials(c: RouteContext, P: ParamMap, url: ParamMap): string | undefined {
  for (const [name, key] of REST_HEADER_PARAMS) {
    const v = header(c.req.headers, name);
    if (v !== undefined) P.set(key, v);
  }
  let basic = false;
  let direct = false;
  const auth = header(c.req.headers, 'Authorization');
  if (auth !== undefined) {
    const value = listLast(auth, ' ');
    if (cfEq(listFirst(auth, ' '), 'Basic')) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const clientId = listFirst(decoded, ':');
      P.set('client_id', clientId);
      P.set('client_secret', listLast(decoded, ':'));
      basic = true;
      direct = clientId !== '' && !isCfUuid(clientId);
    } else if (cfEq(listFirst(auth, ' '), 'Bearer')) {
      P.set('access_token', value);
    }
  }
  const seg = c.segments;
  // Direct Basic credentials log the user in and resolution continues; no OAuth branch runs (jsonApiUtility.cfc:471-480).
  if (basic && direct) {
    P.delete('client_id');
    P.delete('client_secret');
    return undefined;
  }
  if (P.has('access_token')) {
    const tokenInfo =
      url.has('access_token') &&
      url.has('client_id') &&
      ((seg.length === 5 && cfEq(nth(seg, 5), 'tokeninfo')) || (seg.length === 6 && cfEq(nth(seg, 6), 'tokeninfo')));
    if (tokenInfo) return 'tokeninfo';
    P.delete('access_token');
    url.delete('access_token');
    return undefined;
  }
  const oauthAt = (names: string): boolean =>
    (seg.length === 6 && listFind(names, nth(seg, 5))) ||
    (seg.length === 5 && (listFind(names, nth(seg, 4)) || listFind(names, nth(seg, 5))));
  if (oauthAt('oauth,oauth2')) return oauthAt('oauth2') ? 'oauth2' : 'oauth';
  return undefined;
}

/** Deletes the credentials the gateway's exchange consumed from params, never from the URL scope (jsonApiUtility.cfc:474-475,823-824). */
function dropConsumedCredentials(c: RouteContext, P: ParamMap): void {
  for (const name of listToArray(header(c.req.headers, REST_CONSUMED_PARAMS_HEADER) ?? '')) {
    const key = name.trim().toLowerCase();
    if (REST_CREDENTIAL_PARAMS.has(key)) P.delete(key);
  }
}

/** The GET case of the operation switch (jsonApiUtility.cfc:1243-1285). */
function getOperation(entity: string, pi: readonly string[], P: ParamMap, url: ParamMap, opts: ResolvedOptions): string {
  let id = P.get('id');
  if (id === undefined && cfEq(entity, 'content') && P.has('contenthistid')) {
    id = P.get('contenthistid');
    P.set('id', id);
  }
  if (id !== undefined) {
    const s = asStr(id);
    if (cfEq(s, 'new')) return 'findnew';
    if (cfEq(s, 'properties')) return 'findproperties';
    if (cfEq(s, 'permissions')) return 'findpermissions';
    if (listLen(s) > 1) return 'findmany';
    if (isLegacyFindOneId(s)) return 'findone';
    return isValidVariableName(s) && has(opts.remoteFunctions, entity, s) ? `~${s}` : 'findone';
  }
  const third = nth(pi, 3);
  if (pi.length === 3 && !isLegacyFindOneId(third)) {
    if (isValidVariableName(third) && has(opts.remoteFunctions, entity, third)) return `~${third}`;
    throw new LegacyThrow('invalidmethodcall');
  }
  return url.size > 0 ? 'findquery' : 'findall';
}

/** Entity operation from the path and verb (jsonApiUtility.cfc:989-1306). */
function entityOperation(c: RouteContext, pi: readonly string[], P: ParamMap, url: ParamMap): string {
  const { opts } = c;
  const entityNow = (): string => str(P, 'entityname') ?? '';
  let verb = 'GET';
  const named = entityNow();
  if (cfEq(named, 'site')) {
    P.set('id', P.get('siteid'));
    // params.relatedEntity (line 993) is never read: `site/<x>` keeps verb GET and resolves like `site`.
    if (pi.length !== 3) verb = c.httpMethod;
  } else if (pi.length > 2) {
    const third = nth(pi, 3);
    const fourth = nth(pi, 4);
    if (third.length === 35) {
      P.set('id', third);
      if (pi.length === 4 && cfEq(fourth, 'permissions')) return `${named}.findpermissions`;
      if (pi.length >= 4 && cfEq(named, 'content') && cfEq(fourth, 'relatedcontent')) return `${named}.findrelatedcontent`;
      if (pi.length === 4) {
        if (cfEq(named, 'content') && cfEq(fourth, 'history')) return `${named}.findversionhistory`;
        if (listFind('comment,content,category', named) && cfEq(fourth, 'crumbs')) return `${named}.findcrumbarray`;
        const resolved = has(opts.remoteFunctions, named, fourth) || has(opts.relationships, named, fourth);
        if (isValidVariableName(fourth) && resolved) return `${named}.~${fourth}`;
      } else {
        verb = c.httpMethod;
      }
    } else if (listFind('new,properties,permissions', third)) {
      P.set('id', third);
    } else if (isValidVariableName(third) && has(opts.remoteFunctions, named, third)) {
      return `${named}.~${third}`;
    } else if (cfEq(named, 'content')) {
      setContentPathId(pi, P);
    } else {
      parsePathParams(pi, P, 3);
    }
  } else {
    verb = c.httpMethod;
  }

  // Path params may have renamed the entity (jsonApiUtility.cfc:1197-1239).
  const entity = entityNow();
  if (cfEq(entity, 'group')) P.set('type', '1');
  else if (cfEq(entity, 'user')) P.set('type', '2');
  const primaryKey = opts.primaryKeys.get(entity.toLowerCase()) ?? 'undefined';
  const pkValue = P.get(primaryKey.toLowerCase());
  if (c.req.method.toUpperCase() === 'GET' && isValidVariableName(primaryKey) && typeof pkValue === 'string' && pkValue) {
    P.set('id', pkValue);
  }

  switch (verb.toUpperCase()) {
    case 'GET':
      return `${entity}.${getOperation(entity, pi, P, url, opts)}`;
    case 'PUT':
    case 'POST':
      return `${entity}.save`;
    case 'DELETE':
      return `${entity}.delete`;
    default:
      return `${entity}.http-${verb.toLowerCase()}`;
  }
}

/** processRequest's method and entity resolution (jsonApiUtility.cfc:368-1306); legacy error responses throw LegacyThrow. */
function resolveJsonApi(c: RouteContext, restMode: boolean, siteId: string, P: ParamMap): string {
  const { req, opts } = c;
  const url = scopeMap(req.query);
  url.delete(opts.appReloadKey);
  append(P, url);
  append(P, scopeMap(req.form));
  const contentType = header(req.headers, 'Content-Type') ?? '';
  if (contentType.slice(0, 16).toLowerCase() === 'application/json' && req.jsonBody !== undefined) {
    // structAppend of a non-struct body throws into catch(Any) (jsonApiUtility.cfc:408-412).
    if (!isPlainObject(req.jsonBody)) throw new LegacyThrow('server_error');
    append(P, jsonMap(req.jsonBody));
  }
  // parseDateTime reads the unscoped, undefined `muraPointInTime` (jsonApiUtility.cfc:414-419).
  if (P.has('murapointintime')) throw new LegacyThrow('server_error');

  if (restMode) {
    const credentialKey = restCredentials(c, P, url);
    if (credentialKey !== undefined) return credentialKey;
    dropConsumedCredentials(c, P);
  } else {
    for (const name of ['X-csrf_token', 'X-csrf_token_expires']) {
      const v = header(req.headers, name);
      if (v !== undefined) P.set(name.slice(2).toLowerCase(), v);
    }
  }

  const nameContext = {
    hasOrigin: header(req.headers, 'Origin') !== undefined,
    restMode,
    hasAuthorization: restMode && header(req.headers, 'Authorization') !== undefined,
    registeredMethods: opts.registeredMethods,
  };
  const defined = (name: string, entityPhase = false): boolean =>
    isDefinedApiName(name, { ...nameContext, entityPhase });
  const isPublic = (name: string): boolean => isPublicMethod(name, opts.registeredMethods);
  let pi = c.segments.slice(3);
  // structAppend(form, params) at line 845 left params' siteid in the form scope.
  const formSiteId = P.get('siteid');

  // Direct method (jsonApiUtility.cfc:856-901).
  if (!P.has('method') && pi.length > 0 && isValidVariableName(nth(pi, 1))) {
    if (cfEq(nth(pi, 1), siteId)) {
      if (pi.length > 1 && isValidVariableName(nth(pi, 2)) && defined(nth(pi, 2))) {
        P.set('method', nth(pi, 2));
        pi.splice(1, 1);
      }
    } else if (defined(nth(pi, 1))) {
      P.set('method', nth(pi, 1));
    }
  }
  const direct = P.get('method');
  if (typeof direct === 'string' && isValidVariableName(direct) && defined(direct)) {
    // Path pairs may overwrite method; legacy checks and invokes the updated value (jsonApiUtility.cfc:875-891, 930-938).
    if (pi.length > 1) parsePathParams(pi, P, 2);
    const effective = str(P, 'method') ?? '';
    if (!isPublic(effective)) throw new LegacyThrow('invalidmethodcall');
    if (!P.has('siteid')) P.set('siteid', siteId);
    if (!opts.siteExists(str(P, 'siteid') ?? '')) throw new LegacyThrow('invalidparameters');
    // A public name with no function (submitForm) falls through to the entity route.
    if (defined(effective)) return keyForMethod(effective, str(P, 'entityname'));
  }

  // Entity route (jsonApiUtility.cfc:903-979).
  if (!P.has('method')) P.set('method', 'undefined');
  if (pi.length === 0) throw new LegacyThrow('invalidparameters');
  P.set('siteid', nth(pi, 1));
  const urlSiteId = url.get('siteid');
  if (
    !opts.siteExists(nth(pi, 1)) ||
    (urlSiteId !== undefined && !opts.siteExists(asStr(urlSiteId))) ||
    (formSiteId !== undefined && !opts.siteExists(asStr(formSiteId)))
  ) {
    throw new LegacyThrow('invalidparameters');
  }
  if (pi.length > 1) {
    const second = nth(pi, 2);
    if (isValidVariableName(second) && defined(second, true) && !cfEq(second, 'file')) {
      P.set('method', second);
      if (pi.length > 2) parsePathParams(pi, P, 3);
      const effective = str(P, 'method') ?? '';
      if (!isPublic(effective)) throw new LegacyThrow('invalidmethodcall');
      // invoke() of a public name with no function fails.
      if (!defined(effective)) throw new LegacyThrow('server_error');
      return keyForMethod(effective, str(P, 'entityname'));
    }
    P.set('entityname', second);
  }
  // A dotted method rewrites the path and resolution continues: `user.save` ends in doubleCheckEntityMethod.
  const method = str(P, 'method') ?? 'undefined';
  if (method.includes('.')) {
    const entity = listFirst(method, '.');
    const item = listLast(method, '.');
    P.set('entityname', entity);
    P.set('method', item);
    pi = [nth(pi, 1), entity, item];
  }
  const named = P.get('entityname');
  if (named !== undefined && [CONTENTNAV_ENTITY, `${CONTENTNAV_ENTITY}s`].includes(asStr(named).toLowerCase())) {
    P.set('entityname', 'content');
    P.set('entityconfigname', CONTENTNAV_ENTITY);
  }
  if (!P.has('entityname')) {
    P.set('entityname', 'entity');
    P.set('method', 'findall');
  } else {
    const entity = str(P, 'entityname') ?? '';
    if (!(entity.length > 0 && opts.knownEntities.has(entity.toLowerCase()))) {
      const singular = entity.slice(0, -1);
      if (cfEq(entity.slice(-1), 's') && opts.knownEntities.has(singular.toLowerCase())) P.set('entityname', singular);
      else doubleCheckEntityName(entity);
    }
  }
  return entityOperation(c, pi, P, url);
}


// ---- Families ----

function queryThenForm(req: RouteKeyRequest): ParamMap {
  return append(scopeMap(req.query), scopeMap(req.form));
}

/** contentServer's API site: path segment 4, then form, then url `siteid`, else `default` (contentServer.cfc:610-648). */
function apiSiteId(c: RouteContext): string {
  const site = c.segments[3] ?? str(scopeMap(c.req.form), 'siteid') ?? str(scopeMap(c.req.query), 'siteid') ?? 'default';
  return c.opts.siteExists(site) ? site : 'default';
}

function jsonApiRoute(c: RouteContext, family: 'api' | 'rest'): BaseRoute {
  const siteId = apiSiteId(c);
  const params: ParamMap = new Map();
  let body: string;
  try {
    body = resolveJsonApi(c, family === 'rest', siteId, params);
  } catch (e) {
    if (!(e instanceof LegacyThrow)) throw e;
    body = `!${e.type}`;
  }
  return { family, body, params, siteId };
}

/** handleAPIRequest endpoints in legacy order; each test is a case-insensitive prefix (contentServer.cfc:593-777). */
function apiRoute(c: RouteContext): BaseRoute {
  const { req, path, segments } = c;
  const query = scopeMap(req.query);
  const route = (family: RouteFamily, body: string): BaseRoute => ({ family, body, params: queryThenForm(req) });
  if (startsNoCase(path, '/_api/json/v1') || startsNoCase(path, '/_api/ajax/v1')) return jsonApiRoute(c, 'api');
  if (startsNoCase(path, '/_api/rest/v1')) return jsonApiRoute(c, 'rest');
  if (query.has('feedid') && (startsNoCase(path, '/_api/feed/v1') || startsNoCase(path, '/tasks/feed'))) {
    return { ...route('feed', 'v1'), siteId: apiSiteId(c) };
  }
  if (query.has('siteid') && startsNoCase(path, '/_api/resource/variation') && c.opts.variationsEnabled) {
    return route('variation', 'js');
  }
  if (query.has('emailid') && startsNoCase(path, '/_api/email/trackopen')) return route('trackopen', 'open');
  // cfparam evaluates its default eagerly: listGetAt(path,3) throws without a third segment even when url.size
  // or url.action is set (contentServer.cfc:657, 723).
  const third = segments.length >= 3 ? nth(segments, 3) : undefined;
  if (
    query.has('fileid') &&
    segments.length >= 2 &&
    (startsNoCase(path, '/_api/render/') || startsNoCase(path, '/tasks/render/'))
  ) {
    if (third === undefined) return route('render', '!server_error');
    const size = (str(query, 'size') ?? third).toLowerCase();
    return route('render', size === 'small' || size === 'medium' ? size : 'file');
  }
  if (startsNoCase(path, '/_api/sitemonitor')) return route('sitemonitor', 'run');
  if (startsNoCase(path, '/tasks/widgets/')) return route('widgets', 'redirect');
  if (startsNoCase(path, '/_api/asset/')) {
    if (third === undefined) return route('asset', '!server_error');
    return route('asset', (str(query, 'action') ?? third).toLowerCase() === 'upload' ? 'upload' : 'render');
  }
  return route('apiother', path);
}

/** getFullyQualifiedAction with subsystem default `core` (framework.cfc:27-33, 274-359, 1125-1138). */
function qualifyAction(action: string): string {
  const specifies = listLen(action, ':') > 1 || action.endsWith(':');
  const subsystem = specifies ? listFirst(action, ':') : 'core';
  let sectionAndItem = specifies ? (listLen(action, ':') > 1 ? listLast(action, ':') : '') : action;
  if (sectionAndItem.length === 0) sectionAndItem = 'main.default';
  else if (listLen(sectionAndItem, '.') === 1) {
    sectionAndItem = sectionAndItem.startsWith('.')
      ? `main.${listLast(sectionAndItem, '.')}`
      : `${listFirst(sectionAndItem, '.')}.default`;
  } else sectionAndItem = `${listFirst(sectionAndItem, '.')}.${listLast(sectionAndItem, '.')}`;
  return `${subsystem}:${sectionAndItem}`;
}

/** Java String.split: interior empty items kept, trailing empty items dropped. */
function javaSplit(s: string, delimiter: string): string[] {
  const items = s.split(delimiter);
  while (items.length > 0 && items[items.length - 1] === '') items.pop();
  return items;
}

/** FW/1 request context and action (admin/Application.cfc:161-166; framework.cfc:584-626, 1234-1240). */
function adminRoute(c: RouteContext, prefixLength: number): BaseRoute {
  const scope = (s: Scope | undefined): ParamMap => {
    const map = scopeMap(s);
    if (map.has('fuseaction')) map.set('muraaction', map.get('fuseaction'));
    return map;
  };
  const ctx: ParamMap = new Map();
  const pathInfo = c.path.slice(prefixLength);
  const items = pathInfo.length > 1 ? javaSplit(pathInfo.slice(1), '/') : [];
  items.forEach((item, i) => {
    if (i === 0) ctx.set('muraaction', item);
    else if (i === 1) ctx.set('muraaction', `${nth(items, 1)}.${item}`);
    else if (i % 2 === 0) ctx.set(item.toLowerCase(), '');
    else ctx.set(nth(items, i).toLowerCase(), item);
  });
  append(ctx, scope(c.req.query));
  append(ctx, scope(c.req.form));
  const requested = ctx.get('muraaction');
  const action = (requested === undefined ? 'core:home.redirect' : qualifyAction(asStr(requested))).toLowerCase();
  const body = /[/\\]/.test(action) ? '!actioncontainsslash' : action.replace(/^core:/, '');
  const route: BaseRoute = { family: 'admin', body, params: ctx };
  const siteId = ctx.get('siteid');
  if (typeof siteId === 'string') route.siteId = siteId;
  return route;
}

/** Length of the admin-dir prefix when the request is an admin FW/1 request. */
function adminPrefixLength(c: RouteContext, indexAt: number): number | undefined {
  const admin = c.opts.adminSegments;
  const prefix = `/${admin.join('/')}`;
  if (c.path.toLowerCase() !== prefix.toLowerCase() && !startsNoCase(c.path, `${prefix}/`)) return undefined;
  // `<adminDir>/index.cfm/...` is always FW/1; without index.cfm, a file extension means a template or an asset.
  if (indexAt === admin.length || !c.segments.slice(admin.length).some((s) => FILE_EXTENSION.test(s))) {
    return prefix.length;
  }
  return undefined;
}

function isFixtureId(s: string): boolean {
  return isCfUuid(s) || RFC_UUID.test(s) || DIGITS.test(s);
}

/** api.cfm's method: a non-empty X-HTTP-Method-Override, else the request method, upper-cased (api.cfm:16-23). */
function fixtureHttpMethod(req: RouteKeyRequest): string {
  const override = header(req.headers, 'X-HTTP-Method-Override');
  return (override === undefined || override === '' ? req.method : override).toUpperCase();
}

/** Fixture front controller paths `api.cfm/<module>/<resource>[/<id>][/<action>…]`. */
function fixtureRoute(c: RouteContext): BaseRoute {
  const { req } = c;
  const params = append(queryThenForm(req), isPlainObject(req.jsonBody) ? jsonMap(req.jsonBody) : new Map());
  const items = listToArray(c.path.slice(FIXTURE_PREFIX.length), '/');
  const httpMethod = fixtureHttpMethod(req);
  const method = httpMethod.toLowerCase();
  if (items.length < 2) return { family: 'fixture', body: `!notfound@${method}`, params, httpMethod };
  const body = items.map((s, i) => (i < 2 ? s : i === 2 || isFixtureId(s) ? '{id}' : s)).join('/');
  return { family: 'fixture', body: `${body}@${method}`, params, httpMethod };
}

/** Remote CFC proxy call keyed by its method; form `method` wins over the query. */
function cfcRoute(c: RouteContext): BaseRoute {
  const params = queryThenForm(c.req);
  const method = str(params, 'method') ?? '';
  return { family: 'cfc', body: method === '' ? c.path : `${c.path}?method=${method}`, params };
}

/** Front-end page or static file; event params keep URL values over form values (servletEvent.cfc:85-86). */
function pageRoute(c: RouteContext, allowStatic: boolean): BaseRoute {
  const params = append(scopeMap(c.req.query), scopeMap(c.req.form), false);
  const doaction = str(params, 'doaction') ?? '';
  // cfloop list drops empty items; cfcase matches case-insensitively (standardEventsHandler.cfc:527-530).
  const actions = listToArray(doaction).map((a) => a.toLowerCase());
  const saveform = (str(params, 'saveform') ?? '').length > 0;
  const last = nth(c.segments, c.segments.length);
  if (allowStatic && FILE_EXTENSION.test(last) && doaction === '' && !saveform) {
    return { family: 'static', body: c.path, params };
  }
  const listed = actions.join(',');
  const body = listed === '' ? (saveform ? 'saveform' : 'render') : saveform ? `${listed}+saveform` : listed;
  return { family: 'page', body, params };
}

/** OPT-2 namespace request; its site is the merged `siteid`, form over query, as web's request set-up reads it. */
function opt2Route(req: RouteKeyRequest, path: string): BaseRoute {
  const params = queryThenForm(req);
  const route: BaseRoute = { family: 'opt2', body: path, params };
  const siteId = str(params, 'siteid');
  if (siteId !== undefined) route.siteId = siteId;
  return route;
}

/** First matching rule of the shared precedence; `rootPath` is the path the root front controller reads. */
function baseRoute(c: RouteContext, indexAt: number, rootPath: string): BaseRoute {
  const { req, path, segments } = c;
  const first = nth(segments, 1).toLowerCase();
  // The root index.cfm is the front controller, which serves only API and page requests (contentServer.cfc:779-799).
  const frontController = indexAt === 0;
  const root: RouteContext = { ...c, path: rootPath, segments: listToArray(rootPath, '/') };
  const rootFirst = nth(root.segments, 1).toLowerCase();
  const rootApi = rootFirst === '_api' || rootFirst === 'tasks';
  if (!frontController) {
    if (first === 'opt2') return opt2Route(req, path);
    if (startsNoCase(path, BRIDGE_PREFIX)) return { family: 'bridge', body: path, params: queryThenForm(req) };
  }
  if (first === '_api' || first === 'tasks' || (frontController && rootApi)) return apiRoute(root);
  if (frontController) return pageRoute(c, false);
  const adminLength = adminPrefixLength(c, indexAt);
  if (adminLength !== undefined) return adminRoute(c, adminLength);
  const last = nth(segments, segments.length).toLowerCase();
  if (last.endsWith('.cfc')) return cfcRoute(c);
  if (startsNoCase(path, FIXTURE_PREFIX)) return fixtureRoute(c);
  if (last.endsWith('.cfm')) return { family: 'cfm', body: path, params: queryThenForm(req) };
  const page = pageRoute(c, true);
  // A page path is rewritten to the root front controller (CommandBox framework-rewrite).
  return page.family === 'page' && rootApi ? apiRoute(root) : page;
}

/** structKeyExists(url, appReloadKey) outside a URL processAsyncObject call (onRequestStart_include.cfm:114-138). */
function isReloadRequest(req: RouteKeyRequest, family: RouteFamily, opts: ResolvedOptions): boolean {
  if (NO_RELOAD_FAMILIES.has(family) || opts.appReloadKey === '') return false;
  const url = scopeMap(req.query);
  return url.has(opts.appReloadKey) && !cfEq(str(url, 'method') ?? '', 'processAsyncObject');
}

// ---- Variants ----

function paramValue(params: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(params, name) ? params[name] : undefined;
}

/** Evaluates a variant condition over the family's merged params and multipart parts. */
function holds(
  cond: VariantCondition,
  params: Record<string, string>,
  files: ReadonlyArray<{ field: string; filename: string }>,
): boolean {
  if ('anyOf' in cond) return cond.anyOf.some((c) => holds(c, params, files));
  if ('not' in cond) return !holds(cond.not, params, files);
  if ('multipartExtensionIn' in cond) {
    const extensions = new Set(cond.multipartExtensionIn.map((e) => e.toLowerCase()));
    return files.some((f) => {
      const dot = f.filename.lastIndexOf('.');
      return dot >= 0 && extensions.has(f.filename.slice(dot + 1).toLowerCase());
    });
  }
  const name = cond.param.toLowerCase();
  const value = paramValue(params, name);
  if ('equals' in cond) return value !== undefined && cfEq(value, cond.equals);
  if ('in' in cond) return value !== undefined && cond.in.some((v) => cfEq(value, v));
  if ('nonEmpty' in cond) {
    return (value ?? '').length > 0 || files.some((f) => f.field.toLowerCase() === name && f.filename.length > 0);
  }
  return value !== undefined && cfIsBoolean(value) && cfToBoolean(value);
}

function selectVariant(
  baseKey: string,
  params: Record<string, string>,
  files: ReadonlyArray<{ field: string; filename: string }>,
  variants: readonly VariantDeclaration[],
): string | undefined {
  const declared = variants.find(
    (v) => normaliseRouteKey(v.route) === baseKey && v.when.every((w) => holds(w, params, files)),
  );
  return declared === undefined ? undefined : normaliseRouteKey(declared.variant);
}

type KeyFacts = Pick<RouteKeyResult, 'baseKey' | 'family' | 'httpMethod' | 'params' | 'siteId'>;

/** The result for a base key, carrying the first declared variant that holds. */
function keyedResult(facts: KeyFacts, req: RouteKeyRequest, opts: ResolvedOptions): RouteKeyResult {
  const { baseKey, family, httpMethod, params, siteId } = facts;
  const variant = selectVariant(baseKey, params, req.multipartFileNames ?? [], opts.variants);
  const result: RouteKeyResult = {
    key: variant === undefined ? baseKey : `${baseKey}{${variant}}`,
    baseKey,
    family,
    httpMethod,
    params,
  };
  if (variant !== undefined) result.variant = variant;
  if (siteId !== undefined) result.siteId = siteId;
  return result;
}

// ---- Public API ----

/** Trims and lower-cases an authored route key. */
export function normaliseRouteKey(s: string): string {
  return s.trim().toLowerCase();
}

/** Route key of a live request under the shared precedence. */
export function routeKeyForRequest(req: RouteKeyRequest, opts: RouteKeyOptions = {}): RouteKeyResult {
  const resolved = resolveOptions(opts);
  // The JSON API reads a present override even when empty (jsonApiUtility.cfc:995-999, 1157-1161, 1198-1202).
  const apiMethod = (header(req.headers, 'X-HTTP-Method-Override') ?? req.method).toUpperCase();
  const { path, indexAt, rootPath } = normalisePath(req.path, resolved.context);
  const route = baseRoute({ req, path, segments: listToArray(path, '/'), httpMethod: apiMethod, opts: resolved }, indexAt, rootPath);
  const httpMethod = route.httpMethod ?? apiMethod;
  const baseKey = `${route.family}:${route.body}`.toLowerCase();
  const params = simpleParams(route.params);
  const result = keyedResult({ baseKey, family: route.family, httpMethod, params, siteId: route.siteId }, req, resolved);
  if (!isReloadRequest(req, route.family, resolved)) return result;
  const reloadParams = Object.fromEntries(Object.entries(params).filter(([name]) => name !== resolved.appReloadKey));
  const reload = keyedResult(
    { baseKey: RELOAD_KEY, family: 'reload', httpMethod, params: reloadParams, siteId: result.siteId },
    req,
    resolved,
  );
  return { ...reload, afterReload: result };
}

/** The cut-over route a key resolves to; `undefined` means legacy. A variant never falls back to its base. */
export function matchRouteKey(result: RouteKeyResult, routes: Iterable<string>): string | undefined {
  const globbing = result.variant === undefined && GLOB_FAMILIES.has(result.family);
  const familyPrefix = `${result.family}:`;
  const body = result.key.slice(familyPrefix.length);
  let best: { route: string; length: number } | undefined;
  for (const route of routes) {
    const normalised = normaliseRouteKey(route);
    if (normalised === result.key) return route;
    if (!globbing || !normalised.startsWith(familyPrefix) || !normalised.endsWith('/**')) continue;
    const prefix = normalised.slice(familyPrefix.length, -3);
    const matches = body === prefix || body.startsWith(`${prefix}/`);
    if (matches && (best === undefined || prefix.length > best.length)) best = { route, length: prefix.length };
  }
  return best?.route;
}

/** Route key of an inventoried entry point, through a canonical synthetic request. */
export function routeKeyForEntryPoint(entry: RouteEntryPoint, opts: RouteKeyOptions = {}): RouteKeyResult {
  const params = entry.params ?? {};
  const base = { headers: entry.headers ?? {}, multipartFileNames: entry.multipartFileNames ?? [] };
  switch (entry.kind) {
    case 'admin': {
      const adminDir = `/${resolveOptions(opts).adminSegments.join('/')}`;
      return routeKeyForRequest(
        { ...base, method: 'GET', path: `${adminDir}/`, query: { ...params, muraAction: entry.action } },
        opts,
      );
    }
    case 'api': {
      const query: Record<string, string> = { ...params, method: entry.method };
      if (entry.entity !== undefined && isGenericMethod(entry.method)) query.entityname = entry.entity;
      const endpoint = entry.family === 'rest' ? 'rest' : 'json';
      const path = `/_api/${endpoint}/v1/${entry.siteId || 'default'}`;
      return routeKeyForRequest({ ...base, method: 'GET', path, query }, opts);
    }
    case 'page': {
      const query: Record<string, string> = { ...params };
      if (entry.doaction?.length) query.doaction = entry.doaction.join(',');
      if (entry.saveform) query.saveform = '1';
      return routeKeyForRequest({ ...base, method: 'GET', path: '/', query }, opts);
    }
    case 'cfc':
      return routeKeyForRequest(
        { ...base, method: 'POST', path: entry.path, query: {}, form: { ...params, method: entry.method } },
        opts,
      );
    case 'fixture':
      return routeKeyForRequest({ ...base, method: entry.httpMethod, path: entry.path, query: { ...params } }, opts);
    case 'path':
      return routeKeyForRequest(
        { ...base, method: entry.httpMethod ?? 'GET', path: entry.path, query: { ...entry.query, ...params } },
        opts,
      );
    case 'reload': {
      const resolved = resolveOptions(opts);
      const key = resolved.appReloadKey;
      // The Global Config action is `<adminDir>/?<key>&reload=<key>` (nav.cfm:338).
      const request = entry.admin
        ? { path: `/${resolved.adminSegments.join('/')}/`, query: { ...params, [key]: '', reload: key } }
        : { path: '/', query: { [key]: '', ...params } };
      return routeKeyForRequest({ ...base, method: 'GET', ...request }, opts);
    }
  }
}
