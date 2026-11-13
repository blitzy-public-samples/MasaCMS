/** JSON API `user` and `address` entities people owns, served as Masa's `processRequest` serves them [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:368-1402]. */
import { AuthDenial, Roles, assertSiteMatches, moduleRole, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LegacyApiError,
  LegacyServiceUnavailableError,
  PHOTO_CONDITION,
  WWW_AUTHENTICATE,
  accessControlOriginDomains,
  buildEnvelope,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  corsHeaders,
  createApiSerializer,
  esapiUrlEncode,
  isCfUuid,
  isValidVariableName,
  javaTrim,
  legacyErrorResponse,
  paramsWithoutMethod,
  routeKeyForRequest,
  serializeResponse,
  serializeSaveResult,
  type ApiKeyHint,
  type ApiNameContext,
  type LegacyApiErrorType,
  type LegacyJsonSerializer,
  type LegacyQuery,
  type RouteKeyRequest,
  type SerializedLegacyResponse,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  EnvValidationError,
  csrfPreHandler,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  z,
  type Clock,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registryEntries, tenantIdForSite, withTenant, type TenantDb, type TenantRegistryEntry, type TenantTx } from '@opt2/platform/tenancy';
import { listAddresses, saveAddress, type AddressDeps } from '../domain/addresses.js';
import { EXTEND_CONFIG_DEFAULTS, extendSetData, loadSubmittedAttributes, validateExtendedData } from '../domain/extended-data.js';
import { applyUserInput, newUserValues, normaliseParams, resolveUserSite, type UserValues } from '../domain/person.js';
import { PhotoBranchError, observePersons, runRosterOperation, type PersonObserver, type PersonObserverDeps, type RosterDeps } from '../domain/roster-protocol.js';
import { getAdvancedSearch, newAdvancedSearchCriteria, viewerScope, type SearchDeps, type SearchParamEntry } from '../domain/search.js';
import {
  ADDRESS_BEAN_DEFAULTS,
  addressBeanValues,
  addressesQuery,
  expansionTargets,
  filteredEntityValues,
  overlayRequestValues,
  saveResponse,
  userBeanValues,
  withExtendSetData,
  type AddressValues,
  type EntityExtendData,
} from '../domain/user-entity.js';
import { mergeUserErrors, validateAddressValues, validatePersonValues, type LegacyErrors } from '../domain/validation.js';
import type { components } from '../generated/openapi.js';
import type { IdentityClient } from '../legacy/identity-client.js';
import type { PeopleRepository } from '../repo/repository.js';

type Schemas = components['schemas'];
type UserEntity = Schemas['UserEntity'];
type AddressEntity = Schemas['AddressEntity'];
type EntityCollection = Schemas['UserCollection'] | Schemas['AddressCollection'];
type PollStateData = Schemas['PollStateData'];
type EntityMeta = Schemas['JsonApiEntityMeta'];

/** configBean and application settings the endpoint URLs, the route key and the CORS allow-list read. */
export interface LegacyApiSettings {
  /** configBean `adminSSL`. */
  readonly adminSSL: boolean;
  /** configBean `serverPort`, `':8080'` or `''`; undefined takes the request host's port. */
  readonly serverPort?: string;
  /** configBean `context`, e.g. `''` or `'/masa'`. */
  readonly context: string;
  /** `application.appreloadkey`. */
  readonly appReloadKey: string;
  /** configBean `adminDomain`, a comma list of admin host names, or `''`. */
  readonly adminDomain: string;
}

/** The people domain, identity and registry dependencies of the JSON API routes. */
export type LegacyApiRouteDeps = {
  db: TenantDb;
  repository: PeopleRepository;
  identity: IdentityClient;
  clock: Clock;
  roster: RosterDeps;
  search: SearchDeps;
  addresses: AddressDeps;
  /** Defaults to the `MURA_<KEY>` variables of `process.env`. */
  legacy?: LegacyApiSettings;
};

const FAMILIES = ['json', 'ajax', 'rest'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

// Anonymous callers reach `pollState`, `findPermissions` and saves, so every legacy permission rule runs in the handler,
// after the API site fallback; the hooks' site check would refuse an unregistered `siteid` legacy answers itself.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

/** The Users module, the `moduleid` the JSON API registers `user` and `address` with (jsonApiUtility.cfc:86-92). */
const USERS_MODULE_ROLE = moduleRole('00000000000000000000000000000000008');

// Withheld variants, declared as gateway/cutover/variants.json declares them: the first match wins.
const WITHHELD_VARIANTS: readonly VariantDeclaration[] = Object.freeze(
  (['api', 'rest'] as const).flatMap((family): VariantDeclaration[] => [
    { route: `${family}:user.save`, variant: 'photo', when: [PHOTO_CONDITION] },
    { route: `${family}:user.save`, variant: 'extdata', when: [{ param: 'extendSetID', nonEmpty: true }] },
    {
      route: `${family}:address.save`,
      variant: 'extdata',
      when: [{ anyOf: [{ param: 'extendSetID', nonEmpty: true }, { param: 'extendSetID', equals: '' }] }],
    },
  ]),
);

/** Entity deletes the decision list withholds: they span owners or stay on legacy, so people never executes them. */
const WITHHELD_KEYS: ReadonlySet<string> = new Set(['user.delete', 'address.delete']);

/** Route-key error bodies and the exception types processRequest throws for them. */
const RESOLUTION_ERRORS: ReadonlyMap<string, LegacyApiErrorType> = new Map([
  ['!invalidparameters', 'invalidParameters'],
  ['!invalidmethodcall', 'invalidMethodCall'],
  ['!invalidentitycall', 'invalidEntityCall'],
  ['!server_error', 'server_error'],
]);

type PeopleEntity = 'user' | 'address';

type Operation = 'findAll' | 'findMany' | 'findNew' | 'findOne' | 'findPermissions' | 'findProperties' | 'findQuery' | 'save' | 'validate' | 'pollState';

/** A key people serves: its entity and operation. */
interface ServedKey {
  entity: PeopleEntity;
  operation: Operation;
}

const ENTITY_OPERATIONS: readonly Operation[] = ['findAll', 'findMany', 'findNew', 'findOne', 'findPermissions', 'findProperties', 'findQuery', 'save', 'validate'];

/** The keys people serves, by route-key body. */
const OPERATIONS: ReadonlyMap<string, ServedKey> = new Map<string, ServedKey>([
  ...(['user', 'address'] as const).flatMap((entity) =>
    ENTITY_OPERATIONS.map((operation): [string, ServedKey] => [`${entity}.${operation.toLowerCase()}`, { entity, operation }]),
  ),
  ['user.~pollstate', { entity: 'user', operation: 'pollState' }],
]);

/** Primary key of each entity. */
const PRIMARY_KEYS: Readonly<Record<PeopleEntity, 'userid' | 'addressid'>> = { user: 'userid', address: 'addressid' };

/** userBean and addressBean properties whose datatype registerEntity hints, user first as `init` registers it (jsonApiUtility.cfc:69-99, 261-271). */
const ENTITY_HINTS: readonly ApiKeyHint[] = Object.freeze([
  ...['type', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate', 'isnew'].map((key): ApiKeyHint => ({ key, hint: 'integer' })),
  ...['passwordcreated', 'lastlogin', 'lastupdate', 'created'].map((key): ApiKeyHint => ({ key, hint: 'date' })),
  ...['isprimary', 'longitude', 'latitude'].map((key): ApiKeyHint => ({ key, hint: 'float' })),
]);

/** The JSON API serializer with the people entities' hints. */
function entitySerializer(): LegacyJsonSerializer {
  return createApiSerializer(ENTITY_HINTS);
}

/** Masa start-up blanks a `${expr}` or `{{expr}}` value it cannot evaluate here. */
function literal(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const expression = (value.startsWith('${') && value.endsWith('}')) || (value.startsWith('{{') && value.endsWith('}}'));
  return expression ? undefined : value;
}

/** configBean `cleanFilePath`: drops one trailing `/` or `\`. */
function cleanFilePath(path: string): string {
  return /[/\\]$/.test(path) ? path.slice(0, -1) : path;
}

/** configBean `setServerPort`: `:<port>`, or `''` for 80, 443 and a blank port. */
function serverPortSetting(port: string): string {
  return port === '80' || port === '443' || port.trim() === '' ? '' : `:${port}`;
}

const BLANK = /^\s*$/;

/** A `MURA_<KEY>` value that is unset or an expression, as undefined, else text `valid` accepts. */
function literalSetting(valid: (value: string) => boolean, message: string) {
  return z.preprocess((value) => literal(value as string | undefined), z.string().refine(valid, message).optional());
}

const LEGACY_SETTINGS = z
  .object({
    MURA_ADMINSSL: literalSetting((v) => BLANK.test(v) || cfIsBoolean(v), 'must be a CFML boolean'),
    MURA_PORT: literalSetting((v) => BLANK.test(v) || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535), 'must be blank or a TCP port'),
    MURA_CONTEXT: literalSetting((v) => /^(?:\s*|[/\\][^\s?#]*)$/.test(v), 'must be blank or a path from / or \\'),
    MURA_ADMINDOMAIN: literalSetting((v) => /^(?:\s*|[^\s:/\\?#@]+)$/.test(v), 'must be a comma list of host names'),
    MURA_APPRELOADKEY: z
      .string()
      .regex(/^[^\s\p{Cc}]*$/u, 'must not contain whitespace or control characters')
      .optional(),
  })
  .transform(
    (env): LegacyApiSettings => ({
      adminSSL: env.MURA_ADMINSSL !== undefined && !BLANK.test(env.MURA_ADMINSSL) && cfToBoolean(env.MURA_ADMINSSL),
      // The template's port is ${cgi.SERVER_PORT}, which the servlet takes from the request host.
      ...(env.MURA_PORT === undefined ? {} : { serverPort: serverPortSetting(env.MURA_PORT) }),
      context: env.MURA_CONTEXT === undefined || BLANK.test(env.MURA_CONTEXT) ? '' : cleanFilePath(env.MURA_CONTEXT),
      appReloadKey: env.MURA_APPRELOADKEY ?? 'appreload',
      adminDomain: env.MURA_ADMINDOMAIN === undefined || BLANK.test(env.MURA_ADMINDOMAIN) ? '' : env.MURA_ADMINDOMAIN,
    }),
  );

/** The settings from `MURA_<KEY>` variables, else the settings template values; throws EnvValidationError naming each malformed variable. */
export function legacyApiSettings(env: Readonly<Record<string, string | undefined>>): LegacyApiSettings {
  const parsed = LEGACY_SETTINGS.safeParse(env);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new EnvValidationError(issues, 'people');
}

// --- Request facts ---

type Struct = Record<string, unknown>;

function isRecord(value: unknown): value is Struct {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date);
}

/** One url or form value as the CFML scope holds it: multipart fields by value, files by name. */
function scopeText(item: unknown): string {
  if (isRecord(item) && (item.type === 'field' || item.type === 'file')) {
    return String(item.type === 'file' ? item.filename : item.value);
  }
  return String(item);
}

/** Scope names Portcullis refuses before a dot (Portcullis.cfc:604). */
const CF_SCOPE_NAMES: readonly string[] = Object.freeze(['session', 'form', 'url', 'server', 'cgi', 'cookie', 'application', 'local']);

/** Portcullis `isValidCFVariableName` (Portcullis.cfc:597-612). */
function isValidCfVariableName(name: string): boolean {
  if (name === '' || name.includes(' ')) return false;
  if (name.includes('.') && CF_SCOPE_NAMES.includes(cfListFirst(name, '.').toLowerCase())) return false;
  return /^[A-Za-z]/.test(name);
}

/** A parsed query or form body as a route-key scope; `scanned` leaves it as the default `scriptProtect` Portcullis scan does (Portcullis.cfc:113-127). */
function scopeOf(source: unknown, scanned = false): Record<string, string | string[]> {
  const scope = Object.create(null) as Record<string, string | string[]>;
  if (!isRecord(source)) return scope;
  for (const [key, value] of Object.entries(source)) {
    const text = Array.isArray(value) ? value.map(scopeText) : scopeText(value);
    if (!scanned) {
      scope[key] = text;
      continue;
    }
    // A name CFML cannot hold is dropped; the rest lose `&amp;` and `amp;`, their values any NUL character.
    if (!isValidCfVariableName(key)) continue;
    const stripNul = (item: string): string => item.replace(/\0/g, '');
    scope[key.replace(/&amp;/gi, '').replace(/amp;/gi, '')] = Array.isArray(text) ? text.map(stripNul) : stripNul(text);
  }
  return scope;
}

function isJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
}

/** Header `name` matched ignoring case; a repeated field reads as one `, `-joined value, as the servlet container joins it. */
function headerText(headers: FastifyRequest['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.toLowerCase() !== wanted) continue;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** The client's own headers: without the gateway's Bearer user token, which legacy would key as an OAuth access token, and the invocation credential. */
function clientHeadersOf(request: FastifyRequest): FastifyRequest['headers'] {
  const headers: FastifyRequest['headers'] = { ...request.headers };
  const { userToken } = request.opt2Auth;
  if (userToken !== undefined && headerText(headers, 'authorization') === `Bearer ${userToken}`) delete headers.authorization;
  delete headers['x-serverless-authorization'];
  return headers;
}

function pathOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '';
}

/** `cgi.QUERY_STRING`: the raw text after the first `?`. */
function queryStringOf(request: FastifyRequest): string {
  const at = request.url.indexOf('?');
  return at < 0 ? '' : request.url.slice(at + 1);
}

/** The request facts the shared route key is derived from, url, form and JSON body kept apart as legacy reads them. */
function routeKeyRequestOf(request: FastifyRequest, headers: FastifyRequest['headers']): RouteKeyRequest {
  const json = isJsonRequest(request);
  return {
    method: request.method,
    path: pathOf(request),
    query: scopeOf(request.query, true),
    form: json ? {} : scopeOf(request.body, true),
    jsonBody: json ? request.body : undefined,
    headers,
    multipartFileNames: multipartFilesOf(request).map(({ field, filename }) => ({ field, filename })),
  };
}

/** Every `siteid` the request supplies, as the CFML scopes hold them: url, form, then a JSON body. */
function suppliedSiteIds(keyed: RouteKeyRequest): string[] {
  const json = isRecord(keyed.jsonBody) ? scopeOf(keyed.jsonBody) : {};
  const sources: string[] = [];
  for (const scope of [keyed.query, keyed.form ?? {}, json]) {
    for (const [name, value] of Object.entries(scope)) {
      if (name.toLowerCase() === 'siteid') sources.push(Array.isArray(value) ? value.join(',') : value);
    }
  }
  return sources;
}

/** `utility.getRequestProtocol()` (utility.cfc:481-500). */
function requestProtocolOf(request: FastifyRequest): string {
  if (headerText(request.headers, 'x-forwarded-proto')?.toLowerCase() === 'https') return 'https';
  const frontEnd = headerText(request.headers, 'front-end-https');
  if (frontEnd !== undefined && cfIsBoolean(frontEnd) && cfToBoolean(frontEnd)) return 'https';
  return request.protocol;
}

/** The client's host as the gateway forwards it, `X-Forwarded-Host` before the hop's own `Host`. */
function clientHostOf(headers: FastifyRequest['headers']): { name: string; port: string } {
  const forwarded = headerText(headers, 'x-forwarded-host') || headerText(headers, 'host') || '';
  const host = forwarded.split(',')[0]?.trim() ?? '';
  const match = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(host);
  return { name: match?.[1] ?? host, port: match?.[2] ?? '' };
}

/** configBean.getCurrentAdminDomain() (configBean.cfc:517-525): the host's name on an admin domain, else the host. */
function currentAdminDomainOf(headers: FastifyRequest['headers'], adminDomain: string): string {
  const { name, port } = clientHostOf(headers);
  const onAdminDomain = adminDomain.split(',').some((domain) => domain.toLowerCase() === name.toLowerCase());
  return onAdminDomain || port === '' ? name : `${name}:${port}`;
}

/** processRequest's Origin echo over the registry's site domains (jsonApiUtility.cfc:382-394). */
function originEcho(headers: FastifyRequest['headers'], sites: readonly TenantRegistryEntry[], adminDomain: string): Record<string, string> {
  const allowList = sites.map((entry) => ({ domain: entry.domains.join(',') }));
  const cfg = { adminDomain, currentAdminDomain: currentAdminDomainOf(headers, adminDomain) };
  return corsHeaders(headerText(headers, 'origin'), accessControlOriginDomains(allowList, cfg));
}

// --- CFML struct and list semantics ---

/** The struct key equal to `key` ignoring case, as CFML struct keys resolve. */
function keyOf(struct: Readonly<Struct>, key: string): string | undefined {
  if (Object.hasOwn(struct, key)) return key;
  const wanted = key.toLowerCase();
  return Object.keys(struct).find((name) => name.toLowerCase() === wanted);
}

function valueOf(struct: Readonly<Struct>, key: string): unknown {
  const name = keyOf(struct, key);
  return name === undefined ? undefined : struct[name];
}

/** CFML assignment of `struct[key]`: an existing key keeps its spelling. */
function setIn(struct: Struct, key: string, value: unknown): void {
  // Defined, not assigned, so a `__proto__` key stays a data key.
  Object.defineProperty(struct, keyOf(struct, key) ?? key, { value, writable: true, enumerable: true, configurable: true });
}

/** `structDelete` of `key`, ignoring case. */
function deleteIn(struct: Struct, key: string): void {
  const wanted = key.toLowerCase();
  for (const name of Object.keys(struct)) {
    if (name.toLowerCase() === wanted) delete struct[name];
  }
}

/** A simple value as CFML text; undefined for a missing or complex value. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** `listFirst` with `delim`: the first non-empty element, or `''`. */
function cfListFirst(list: string, delim: string): string {
  return list.split(delim).find((item) => item !== '') ?? '';
}

/** `listFindNoCase` over a list of names. */
function listHasNoCase(list: readonly string[], item: string): boolean {
  return list.some((entry) => entry.toLowerCase() === item.toLowerCase());
}

/** CFML `urlDecode`: `+` is a space and `%XX` runs are UTF-8; a `%` that starts no escape, or bytes that are not UTF-8, stay as sent. */
function cfUrlDecode(text: string): string {
  return text.replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The request's own parameter `name`, ignoring case, before legacy resolution rewrites it. */
function requestParam(request: FastifyRequest, name: string): unknown {
  return valueOf(legacyParamsOf(request), name);
}

/** Java's String.hashCode of the upper-cased key, spread as ConcurrentHashMap spreads it (coldfusion.util.Key). */
function structHash(upper: string): number {
  let h = 0;
  for (let i = 0; i < upper.length; i++) h = (Math.imul(31, h) + upper.charCodeAt(i)) | 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

interface StructNode {
  key: string;
  upper: string;
  hash: number;
}

/** ConcurrentHashMap.transfer into a table twice the size: nodes before a bin's last run are prepended. */
function doubleTable(table: StructNode[][]): StructNode[][] {
  const n = table.length;
  const next: StructNode[][] = Array.from({ length: n * 2 }, () => []);
  table.forEach((bin, i) => {
    const head = bin[0];
    if (head === undefined) return;
    let runBit = head.hash & n;
    let lastRun = 0;
    bin.forEach((node, j) => {
      const bit = node.hash & n;
      if (bit !== runBit) {
        runBit = bit;
        lastRun = j;
      }
    });
    const low = runBit === 0 ? bin.slice(lastRun) : [];
    const high = runBit === 0 ? [] : bin.slice(lastRun);
    for (const node of bin.slice(0, lastRun)) ((node.hash & n) === 0 ? low : high).unshift(node);
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/** The order an ACF struct built by setting `keys` in sequence iterates them; a key set again in another casing keeps its first spelling. */
function acfStructKeyOrder(keys: Iterable<string>): string[] {
  let table: StructNode[][] = Array.from({ length: 16 }, () => []);
  let count = 0;
  for (const key of keys) {
    const upper = key.toUpperCase();
    const hash = structHash(upper);
    const bin = table[hash & (table.length - 1)];
    if (bin === undefined || bin.some((node) => node.upper === upper)) continue;
    bin.push({ key, upper, hash });
    count += 1;
    // Not modelled: ConcurrentHashMap treeifies a bin once eight keys collide in it.
    if (count >= table.length - (table.length >>> 2)) table = doubleTable(table);
  }
  return table.flat().map((node) => node.key);
}

// --- Caller, call and beans ---

/** The verified caller as the JSON API's `currentUser()` and `permUtility` checks read it. */
interface Caller {
  user: UserClaims | undefined;
  /** `currentUser().getUserID()`; `''` without a login. */
  userId: string;
  loggedIn: boolean;
  /** `isSuperUser()`: S2. */
  superUser: boolean;
  /** `isAdminUser()`: a member of the site's private-pool `Admin` group. */
  adminUser: boolean;
  /** `isSystemUser()`: S2 or a private-pool user. */
  systemUser: boolean;
  /** `getModulePerm('…008', siteid)`: S2, site Admin, or a Users module grant [legacy: core/mura/permission.cfc:300-350]. */
  usersModule: boolean;
}

function callerOf(user: UserClaims | undefined): Caller {
  const roles = new Set(user?.roles ?? []);
  const superUser = roles.has(Roles.s2) || user?.s2 === true;
  const adminUser = roles.has(Roles.siteAdmin);
  const userId = user?.sub ?? '';
  return {
    user,
    userId,
    loggedIn: userId !== '',
    superUser,
    adminUser,
    systemUser: superUser || roles.has(Roles.systemUser),
    usersModule: superUser || adminUser || roles.has(USERS_MODULE_ROLE),
  };
}

/** One resolved JSON API call: who asks, the addressed site and entity, the mode, and how legacy reports the response. */
interface ApiCall {
  request: FastifyRequest;
  reply: FastifyReply;
  app: FastifyInstance;
  deps: LegacyApiRouteDeps;
  entity: PeopleEntity;
  /** The merged, resolved request params, lower-cased names, simple values. */
  params: Record<string, string>;
  /** The url scope as the request sent it, scanned. */
  url: Struct;
  caller: Caller;
  /** REST mode is sessionless: `request.muraSessionManagement` is false (applicationSettings.cfm:179). */
  restMode: boolean;
  /** The JSON API instance's site: the request's site, else `default` (contentServer.cfc:610-622), as registered. */
  apiSite: string;
  /** `params.siteid`: the site the call addresses. */
  siteId: string;
  /** The request's registry read, by lower-cased site id. */
  registry: ReadonlyMap<string, TenantRegistryEntry>;
  /** Invoked as a direct method, which always answers 200 with the method as requested (jsonApiUtility.cfc:870-898). */
  direct: boolean;
  /** `params.method` as the catch block and the envelope report it; updated as legacy updates it. */
  method: string | undefined;
  methodCtx: ApiNameContext;
  /** `getEndPoint()` (jsonApiUtility.cfc:3337-3364). */
  endpoint: string;
  /** settingsBean `getAdminPath(complete=1)` (settingsBean.cfc:1416-1433). */
  adminPath: string;
}

type PersonRow = NonNullable<Awaited<ReturnType<PeopleRepository['findPerson']>>>;
type AddressRow = NonNullable<Awaited<ReturnType<PeopleRepository['findAddress']>>>;

function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** A feed or argument failure processRequest's `catch (Any e)` answers. */
function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/**
 * REST runs sessionless, so on ACF 2023 a `$` event of a registered site throws building its content renderer: the one a
 * method builds first, or serializeResponse's for a data struct (jsonApiUtility.cfc:1486-1487; contentRenderer.cfc:701).
 */
function assertSitelessEvent(call: ApiCall, siteId: string): void {
  if (call.restMode && call.registry.has(siteId.toLowerCase())) throw serverError();
}

/** `AllowAccess` of a user or address: the Users module of the site (jsonApiUtility.cfc:1686-1738). */
function assertAccess(call: ApiCall): void {
  if (!call.caller.usersModule) throw new LegacyApiError('authorization');
}

/** `AllowAction` of a user or address bean: the Users module, or a bean whose `userid` is the caller's own (jsonApiUtility.cfc:1809-1818). */
function allowsAction(caller: Caller, beanUserId: string): boolean {
  return caller.usersModule || cfEq(beanUserId, caller.userId);
}

/** The registry entry of the token's tenant; an unregistered tenant answers the legacy 503. */
function tokenEntry(call: ApiCall): TenantRegistryEntry {
  const tid = call.caller.user?.tid;
  const entry = tid === undefined ? undefined : [...call.registry.values()].find((candidate) => candidate.tenantId === tid);
  if (entry === undefined) throw unavailable(`Tenant ${tid ?? ''} has no site registry entry`, 'tenant-unregistered');
  return entry;
}

/** `getPublicUserPoolID()` or `getPrivateUserPoolID()` of the site as a tenant; settingsBean reads an empty pool id as the site's own. */
function userPoolTenant(entry: TenantRegistryEntry, isPublic: boolean): string {
  const poolId = isPublic ? entry.publicUserPoolId : entry.privateUserPoolId;
  const siteId = poolId === null || poolId === '' ? entry.siteId : poolId;
  return (isPublic ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId);
}

/** The tenants the token's site reads users and their addresses in: its own, then its public and private user pools. */
function userTenants(entry: TenantRegistryEntry): string[] {
  return [...new Set([entry.tenantId, userPoolTenant(entry, true), userPoolTenant(entry, false)])];
}

/** The tenant holding rows of legacy site `siteId`: its registry entry, else the tenant id rule. */
function tenantOfSite(call: ApiCall, siteId: string): string {
  return call.registry.get(siteId.toLowerCase())?.tenantId ?? tenantIdForSite(siteId);
}

/** A user as `userManager.read(userid)` builds it [legacy: core/mura/user/userDAO.cfc:92-120]. */
interface UserBean {
  values: UserValues;
  exists: boolean;
  /** The tenant holding the person; undefined for a new bean. */
  tenantId?: string;
  addresses: AddressRow[];
  /** `getExtendedData().getAllExtendSetData().data`, as the `extendeddata` field reads it. */
  extendData: EntityExtendData['data'];
}

/** An address as `userManager.readAddress(addressid)` builds it [legacy: core/mura/user/userDAO.cfc:720-747]. */
interface AddressBean {
  values: AddressValues;
  exists: boolean;
  tenantId?: string;
  extendData: EntityExtendData['data'];
}

/** The roster observer collaborators of the call. */
function observerDeps(call: ApiCall): PersonObserverDeps {
  const { db, repository, clock, search } = call.deps;
  return { db, repo: repository, clock, sleep: search.sleep };
}

/** The person `userId` with its interests, addresses and extended data, from the first of `tenants` that holds it, fenced in each. */
async function findPersonRows(call: ApiCall, observer: PersonObserver, tenants: readonly string[], userId: string) {
  const repo = call.deps.repository;
  const read = async (tx: TenantTx) => {
    const person: PersonRow | null = await repo.findPerson(tx, userId);
    if (person === null) return null;
    const categoryIds = (await repo.listInterests(tx, person.userid)).map((row) => row.categoryid);
    const addresses = await listAddresses(repo, tx, person.userid);
    // getAllValues builds the bean's extended data for its site, Type 2 and subtype (beanExtendable.cfc:139-151).
    const extend = await extendSetData(repo, tx, person.userid, { siteId: person.siteid ?? '', type: '2', subtype: person.subtype ?? '' });
    return { person, categoryIds, addresses, extend };
  };
  for (const tenantId of tenants) {
    const found = await observer.read(tenantId, read, (rows) => (rows === null ? [] : [rows.person.userid]), [userId]);
    if (found !== null) return { tenantId, ...found };
  }
  return null;
}

/** `readMembershipIDs` of users: identity's ordered list where it admits the caller, else its owner lookup for people. */
async function membershipsOf(call: ApiCall, userIds: readonly string[]): Promise<Map<string, string[]>> {
  const { identity } = call.deps;
  if (userIds.length === 1 && (call.caller.superUser || call.caller.adminUser)) {
    const [userId] = userIds as [string];
    return new Map([[userId, await identity.membershipGroupIds(userId)]]);
  }
  const looked = await identity.lookupMemberships(userIds);
  const byKey = new Map([...looked].map(([userId, groupIds]) => [userId.trimEnd().toUpperCase(), groupIds]));
  return new Map(userIds.map((userId) => [userId, byKey.get(userId.trimEnd().toUpperCase()) ?? []]));
}

/** `tfiles.fileExt` of photo files through strategies-content's lookup; '' without one. */
async function photoExtensions(call: ApiCall, fileIds: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
  const lookup = call.deps.search.photoFileExts;
  const wanted = fileIds.filter((id): id is string => id !== null && id !== '');
  return lookup === undefined || wanted.length === 0 ? new Map() : lookup(wanted);
}

/** The stored user `userId` in `tenants`: people's rows with identity's account and memberships, observed together; null when none. */
async function readStoredUser(call: ApiCall, tenants: readonly string[], userId: string): Promise<UserBean | null> {
  if (userId === '') return null;
  const read = await observePersons(
    observerDeps(call),
    (observer) => findPersonRows(call, observer, tenants, userId),
    async (stored) => {
      // A person identity does not list (a missing or pending account) has no complete `tusers` row to read.
      const account = stored === null ? undefined : await call.deps.identity.readAccount(stored.person.userid);
      if (stored === null || account === undefined) return null;
      const groupIds = (await membershipsOf(call, [stored.person.userid])).get(stored.person.userid) ?? [];
      return { stored, account, groupIds };
    },
  );
  if (read === null) return null;
  const { stored, account, groupIds } = read;
  const { person } = stored;
  const photoFileExt = (await photoExtensions(call, [person.photofileid])).get(person.photofileid ?? '') ?? '';
  const source = { person, account, groupIds, categoryIds: stored.categoryIds, extend: stored.extend, photoFileExt };
  return { values: userBeanValues(source, call.deps.clock), exists: true, tenantId: stored.tenantId, addresses: stored.addresses, extendData: stored.extend.data };
}

/** A user bean `loadBy` leaves for an unknown id: `$.getBean('user')` seeded with the call's site and its extended defaults (cfobject.cfc:138-149). */
async function newUserBean(call: ApiCall): Promise<UserBean> {
  const values: UserValues = { ...newUserValues(call.deps.clock), userid: cfUuid(), siteid: call.siteId };
  const extend = await siteExtendDefaults(call, values.userid, { type: '2', subtype: String(values.subtype) });
  return { values: withExtendSetData(values, extend), exists: false, addresses: [], extendData: extend.data };
}

/** The extended defaults of the call's site for a new bean; a site no registry entry holds has none people can read. */
async function siteExtendDefaults(call: ApiCall, baseId: string, scope: { type: string; subtype: string }): Promise<EntityExtendData> {
  const entry = call.registry.get(call.siteId.toLowerCase());
  if (entry === undefined) return { data: {}, extendSetId: '' };
  return withTenant(call.deps.db, entry.tenantId, (tx) => extendSetData(call.deps.repository, tx, baseId, { siteId: entry.siteId, ...scope }));
}

/** `loadBy(userid=id)` within the token site's user tenants; an id no person holds leaves a new bean, as userDAO.read does. */
async function loadUser(call: ApiCall, userId: string): Promise<UserBean> {
  const stored = await readStoredUser(call, userTenants(tokenEntry(call)), userId);
  return stored ?? newUserBean(call);
}

/** The address `addressId` with its extended data, from the first of `tenants` that holds it, while its owner is open. */
async function findAddressRows(call: ApiCall, tenants: readonly string[], addressId: string) {
  const repo = call.deps.repository;
  const read = async (tx: TenantTx) => {
    const row = await repo.findAddress(tx, addressId);
    if (row === null) return null;
    const scope = { siteId: row.siteid ?? '', type: ADDRESS_BEAN_DEFAULTS.type, subtype: ADDRESS_BEAN_DEFAULTS.subtype };
    return { row, extend: await extendSetData(repo, tx, row.addressid, scope) };
  };
  const owner = (found: Awaited<ReturnType<typeof read>>): string[] => {
    const userId = found?.row.userid ?? null;
    return userId === null ? [] : [userId];
  };
  return observePersons(
    observerDeps(call),
    async (observer) => {
      for (const tenantId of tenants) {
        const found = await observer.read(tenantId, read, owner);
        if (found !== null) return { tenantId, ...found };
      }
      return null;
    },
    (found) => Promise.resolve(found),
  );
}

/**
 * `loadBy(addressid=id)`: a person's stored address, else a new bean seeded with the call's site. Group addresses are
 * identity's rows, which people cannot read, so a group address id reads as an unknown one.
 */
async function loadAddress(call: ApiCall, addressId: string): Promise<AddressBean> {
  const found = addressId === '' ? null : await findAddressRows(call, userTenants(tokenEntry(call)), addressId);
  if (found !== null) {
    return { values: addressBeanValues({ address: found.row, extend: found.extend }), exists: true, tenantId: found.tenantId, extendData: found.extend.data };
  }
  const values: AddressValues = { ...ADDRESS_BEAN_DEFAULTS, errors: {}, addressid: cfUuid(), siteid: call.siteId };
  const extend = await siteExtendDefaults(call, values.addressid, { type: ADDRESS_BEAN_DEFAULTS.type, subtype: ADDRESS_BEAN_DEFAULTS.subtype });
  return { values: withExtendSetData(values, extend), exists: false, extendData: extend.data };
}

// --- findProperties, findPermissions and pollState ---

/** One `applyPropertyFormat` struct, with its keys in ACF's struct order (jsonApiUtility.cfc:1517-1547). */
type PropertyFormat = Readonly<Record<string, string | boolean>>;

/** `findProperties` of `user`: every persistent property of userBean, as ACF iterates them. */
const USER_PROPERTIES: readonly PropertyFormat[] = Object.freeze<PropertyFormat[]>([
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'mobilephone', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'lname', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'email', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'lastupdate', datatype: 'datetime', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'extenddatatable', datatype: 'varchar', default: 'tclassextenddatauseractivity' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'keepprivate', datatype: 'int', default: '0' },
  { fieldtype: 'id', length: '35', required: false, nullable: true, html: 'false', name: 'userid', datatype: 'char', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'username', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'type', datatype: 'int', default: '2' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'lastupdatebyid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'subtype', datatype: 'varchar', default: 'Default' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'categoryid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'fname', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'company', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'tablist', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'newfile', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'password', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'ispublic', datatype: 'int', default: '1' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'addresses', datatype: 'query', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'imservice', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'lastlogin', datatype: 'datetime', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'website', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'jobtitle', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 's2', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'contactformat', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'notes', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'created', datatype: 'datetime', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'description', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'groupname', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'perm', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'addressid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'imname', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'passwordcreated', datatype: 'datetime', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'photofileid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'interests', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'siteid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'primaryaddressid', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'subscribe', datatype: 'int', default: '1' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'remoteid', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'inactive', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'photofileext', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'lastupdateby', datatype: 'varchar', default: '' },
]);

/** `findProperties` of `address`: every persistent or related property of addressBean, as ACF iterates them. */
const ADDRESS_PROPERTIES: readonly PropertyFormat[] = Object.freeze<PropertyFormat[]>([
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'zip', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'phone', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'longitude', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'state', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'country', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'extenddatatable', datatype: 'varchar', default: 'tclassextenddatauseractivity' },
  { fieldtype: 'id', length: '35', required: false, nullable: true, html: 'false', name: 'addressid', datatype: 'char', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'addressname', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'addressemail', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'address1', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'type', datatype: 'varchar', default: 'Custom' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'address2', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'subtype', datatype: 'varchar', default: 'Default' },
  { fieldtype: 'many-to-one', loadkey: 'siteID', length: '25', required: false, cascade: 'none', nullable: true, html: 'false', fkcolumn: 'siteID', name: 'site', datatype: 'varchar', relatesto: 'site', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'addressurl', datatype: 'varchar', default: '' },
  { fieldtype: 'many-to-one', loadkey: 'userID', length: '35', required: false, cascade: 'none', nullable: true, html: 'false', fkcolumn: 'userID', name: 'user', datatype: 'char', relatesto: 'user', default: '' },
  { fieldtype: '', length: '50', required: 'true', html: 'false', nullable: false, name: 'siteid', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'city', datatype: 'varchar', default: '' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'hours', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'isprimary', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'fax', datatype: 'varchar', default: '' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'latitude', datatype: 'int', default: '0' },
  { fieldtype: '', length: '50', required: false, html: 'false', nullable: true, name: 'addressnotes', datatype: 'varchar', default: '' },
]);

/** `findProperties(entityname, properties)`: the named properties in list order, else all; `table` only for an admin or super user (jsonApiUtility.cfc:1548-1617). */
function findProperties(call: ApiCall): EntityMeta {
  const { entity, endpoint } = call;
  const all = entity === 'user' ? USER_PROPERTIES : ADDRESS_PROPERTIES;
  const requested = cfListToArray(call.params.properties ?? '');
  const properties = requested.map((name) => {
    const property = all.find((candidate) => candidate.name === name.toLowerCase());
    // `props[p]` of a name the bean does not define raises.
    if (property === undefined) throw serverError();
    return property;
  });
  const result: EntityMeta = {
    displayname: entity,
    properties: requested.length > 0 ? properties : all,
    historical: false,
    links: {
      swagger_json: `${endpoint}/swagger?mode=json&entities=${entity}`,
      endpoint: `${endpoint}/${entity}`,
      swagger_rest: `${endpoint}/swagger?mode=rest&entities=${entity}`,
      self: `${endpoint}/${entity}/properties`,
      entities: endpoint,
    },
    dynamic: false,
  };
  if (call.caller.adminUser || call.caller.superUser) result.table = entity === 'user' ? 'tusers' : 'tuseraddresses';
  Object.assign(result, { primarykey: PRIMARY_KEYS[entity], public: false, bundleable: false, orderby: '', entityname: entity, scaffold: false });
  return result;
}

/** `findPermissions(entityName, id)`: the bean's `getPermissions()` as booleans; a 35-character id loads the stored bean (jsonApiUtility.cfc:2240-2266; bean.cfc getPermissions). */
async function findPermissions(call: ApiCall): Promise<EntityMeta> {
  const id = call.params.id ?? '';
  const load = isCfUuid(id) || id.length === 35;
  // A caller without a session token reads no stored rows: legacy's checks then compare against an empty user id.
  const known = load && call.caller.user !== undefined;
  // getBean seeds the bean with the API instance's site, which a stored row replaces.
  let siteId = call.apiSite;
  let beanUserId: string;
  if (call.entity === 'user') {
    const stored = known ? await readStoredUser(call, userTenants(tokenEntry(call)), id) : null;
    if (stored !== null) siteId = String(stored.values.siteid);
    // getValue('userid') of a new bean calls getUserID(), which creates an id.
    beanUserId = stored === null ? cfUuid() : String(stored.values.userid);
  } else {
    const stored = known ? await findAddressRows(call, userTenants(tokenEntry(call)), id) : null;
    if (stored !== null) siteId = stored.row.siteid ?? '';
    beanUserId = stored === null ? '' : (stored.row.userid ?? '').trimEnd();
  }
  if (siteId === '') return { read: false, delete: false, save: false };
  const action = allowsAction(call.caller, beanUserId);
  return { read: call.caller.usersModule, delete: action, save: action };
}

/** The user entity's remote `pollState()`: the session's login flag, read without an access check (userBean.cfc:826-835). */
function pollState(call: ApiCall): PollStateData {
  return { loggedin: call.caller.loggedIn };
}

/** The request's own spelling of the remote function name: the path segment or the `id` that named it. */
function remoteFunctionSpelling(call: ApiCall, name: string): string {
  const segment = pathOf(call.request).split('/').reverse().find((item) => cfEq(item, name));
  return segment ?? call.params.id ?? name;
}

// --- Entity values ---

/** `param url.expanddepth` of getFilteredValues, which leaves a numeric depth in the url scope (jsonApiUtility.cfc:2227-2231). */
function settleExpandDepth(call: ApiCall): void {
  if (!cfIsNumeric(valueOf(call.url, 'expanddepth'))) setIn(call.url, 'expanddepth', '1');
}

/** `if(!isDefined('url.entityname')) url.entityname=arguments.entityname`, as the find methods start. */
function defaultUrlEntityName(call: ApiCall): void {
  if (keyOf(call.url, 'entityname') === undefined) setIn(call.url, 'entityname', call.entity);
}

/** How one getFilteredValues call runs. */
interface FilterOptions {
  expanded: number | boolean;
  editableCheck: boolean;
}

/** Whether the edit or own-record links apply: `editablecheck`, or a `url.id` naming the bean (jsonApiUtility.cfc:2197-2200). */
function editableFor(call: ApiCall, id: string, editableCheck: boolean): boolean {
  const urlId = textOf(valueOf(call.url, 'id'));
  return (urlId !== undefined && cfEq(id, urlId)) || editableCheck;
}

/** `getLinks(user, editablecheck)`; the edit link only for a logged-in system user whom AllowAction admits (jsonApiUtility.cfc:3374-3440; userBean.cfc:818-824). */
function userLinks(call: ApiCall, values: Readonly<UserValues>, editable: boolean): Record<string, string> {
  const base = call.endpoint;
  const userId = String(values.userid);
  const links: Record<string, string> = { entities: base };
  if (editable && call.caller.loggedIn && call.caller.systemUser && allowsAction(call.caller, userId)) {
    const action = Number(values.type) === 1 ? 'cusers.editgroup' : 'cusers.edituser';
    links.edit = `${call.adminPath}/?muraAction=${action}&siteid=${esapiUrlEncode(String(values.siteid))}&userid=${esapiUrlEncode(userId)}`;
  }
  links.all = `${base}/user`;
  links.properties = `${base}/user/properties`;
  links.self = `${base}/user/${userId}`;
  links.permissions = `${base}/user/${userId}/permissions`;
  return links;
}

/** `getLinks(address)`: addressBean has no edit URL; its hasOne `user` link only for a non-empty `userid` (jsonApiUtility.cfc:3374-3457). */
function addressLinks(call: ApiCall, values: Readonly<AddressValues>): Record<string, string> {
  const base = call.endpoint;
  const addressId = String(values.addressid);
  const userId = String(values.userid);
  const links: Record<string, string> = {
    entities: base,
    all: `${base}/address`,
    properties: `${base}/address/properties`,
    self: `${base}/address/${addressId}`,
    permissions: `${base}/address/${addressId}/permissions`,
  };
  if (userId !== '') links.user = `${base}/user/${userId}`;
  links.site = `${base}/site`;
  return links;
}

/** The `url.fields` the call carries. */
function urlFields(call: ApiCall): string | undefined {
  return textOf(valueOf(call.url, 'fields'));
}

/** Whether `url.entityname` is non-empty and names `entity`. */
function urlNamesEntity(call: ApiCall, entity: PeopleEntity): boolean {
  const named = textOf(valueOf(call.url, 'entityname'));
  return named !== undefined && named !== '' && cfEq(named, entity);
}

/** getFilteredValues of a user (jsonApiUtility.cfc:2076-2236); `addresses` is read only when a field names it. */
function userEntity(call: ApiCall, bean: UserBean, opts: FilterOptions): UserEntity {
  const id = String(bean.values.userid);
  const fields = urlFields(call);
  const getters = fields !== undefined && listHasNoCase(cfListToArray(fields), 'addresses') ? { addresses: addressesQuery(bean.addresses) } : undefined;
  const values = filteredEntityValues(bean.values, {
    entityName: 'user',
    pk: 'userid',
    fields,
    expandLinks: call.params.expand ?? '',
    links: userLinks(call, bean.values, editableFor(call, id, opts.editableCheck)),
    isEntityNameMatch: urlNamesEntity(call, 'user'),
    expanded: opts.expanded,
    expandDepth: valueOf(call.url, 'expanddepth'),
    extendSetData: bean.extendData,
    ...(getters === undefined ? {} : { getters }),
  });
  settleExpandDepth(call);
  return values as UserEntity;
}

/** getFilteredValues of an address, whose links never vary with `editablecheck`: its `user` relation expands through the user findOne, `site` is programs-sites' entity. */
async function addressEntity(call: ApiCall, bean: AddressBean, opts: Pick<FilterOptions, 'expanded'>): Promise<AddressEntity> {
  const filter = {
    entityName: 'address' as const,
    pk: 'addressid' as const,
    fields: urlFields(call),
    expandLinks: call.params.expand ?? '',
    isEntityNameMatch: urlNamesEntity(call, 'address'),
    expanded: opts.expanded,
    expandDepth: valueOf(call.url, 'expanddepth'),
    extendSetData: bean.extendData,
  };
  const expansions: Record<string, unknown> = {};
  for (const target of expansionTargets(bean.values, filter)) {
    if (target.name === 'site') throw unavailable('The site relation of an address is programs-sites data', 'address-expand-site');
    expansions.user = await findOneUser(call, target.id, target.expanded);
  }
  const values = filteredEntityValues(bean.values, { ...filter, links: addressLinks(call, bean.values), expansions });
  settleExpandDepth(call);
  return values as AddressEntity;
}

/** `url.ishuman` renders the CFML form-protection include into the result (jsonApiUtility.cfc:2373-2376). */
function assertNoHumanCheck(call: ApiCall): void {
  if (valueOf(call.url, 'ishuman') !== undefined) throw unavailable('The ishuman field renders a CFML display object', 'cfml-render');
}

/** findOne(entityName='user', id): AllowAccess, then the loaded or new bean with its edit link (jsonApiUtility.cfc:2268-2384). */
async function findOneUser(call: ApiCall, id: string, expanded: number): Promise<UserEntity> {
  defaultUrlEntityName(call);
  assertAccess(call);
  const bean = await loadUser(call, id);
  return userEntity(call, bean, { expanded, editableCheck: true });
}

/** findOne(entityName='address', id). */
async function findOneAddress(call: ApiCall, id: string, expanded: number): Promise<AddressEntity> {
  defaultUrlEntityName(call);
  assertAccess(call);
  return addressEntity(call, await loadAddress(call, id), { expanded });
}

/** findOne of the call's entity. */
async function findOne(call: ApiCall): Promise<UserEntity | AddressEntity> {
  const id = call.params.id ?? '';
  const data = call.entity === 'user' ? await findOneUser(call, id, 0) : await findOneAddress(call, id, 0);
  assertNoHumanCheck(call);
  return data;
}

/** findNew(entityName): a bean loaded by a fresh id, then AllowAccess (jsonApiUtility.cfc:2385-2420). */
async function findNew(call: ApiCall): Promise<UserEntity | AddressEntity> {
  assertAccess(call);
  const data = call.entity === 'user' ? userEntity(call, await newUserBean(call), { expanded: true, editableCheck: true }) : await addressEntity(call, await loadAddress(call, ''), { expanded: true });
  assertNoHumanCheck(call);
  return data;
}

// --- Collections: userFeedBean over userGateway.getAdvancedSearch, and address findMany ---

/** Params findQuery never filters on (jsonApiUtility.cfc:2858). */
const QUERY_EXCLUDED: readonly string[] = Object.freeze([
  'expanddepth', 'expand', 'muraPointInTime', 'liveOnly', 'feedid', 'cacheid', '_cacheid', 'distinct', 'fields', 'entityname', 'method',
  'maxItems', 'pageIndex', 'itemsPerPage', 'sortBy', 'sortDirection', 'contentpoolid', 'shownavonly', 'showexcludesearch',
  'includehomepage', 'feedname', 'useCategoryIntersect', 'useDataNamespace',
]);

const GROUPING_NAMES: readonly string[] = Object.freeze(['openGrouping', 'orOpenGrouping', 'andOpenGrouping', 'closeGrouping']);
const AGGREGATE_NAMES: readonly string[] = Object.freeze(['sum', 'avg', 'count', 'max', 'min', 'groupBy']);

/** Feed and bean setters `addParam` calls instead of adding a param that leave the feed's query as it was (beanFeed.cfc:315-318). */
const INERT_SETTERS: readonly string[] = Object.freeze(['advancedparams', 'configbean', 'addedobjectvalues', 'errors', 'propasidcolumn', 'validations', 'value', 'lastupdateby']);

/** Setters `addParam` calls with a simple value they cannot take. */
const FAILING_SETTERS: readonly string[] = Object.freeze(['params', 'allvalues']);

/** userGateway's built-in sort columns an ORDER BY of one `tusers` column matches (userGateway.cfc:181; the misspelt isPubic excluded). */
const SORTABLE_COLUMNS: readonly string[] = Object.freeze(['fname', 'lname', 'username', 'company', 'lastupdate', 'created', 'email']);

/** The SQL type `addParam` gives a `tusers` column passed without one (dbUtility.transformParamType); other names are varchar. */
const USER_PARAM_TYPES: ReadonlyMap<string, string> = new Map([
  ...['ext', 'subscribe', 'keepprivate', 'type', 'admin', 's2', 'perm', 'inactive', 'ispublic'].map((name) => [name, 'integer'] as const),
  ...['lastupdate', 'created', 'passwordcreated', 'lastlogin'].map((name) => [name, 'timestamp'] as const),
]);

/** The user feed's `nextN` (userFeedBean.getIterator) and the address feed's (beanFeed.getIterator). */
const FEED_NEXT_N = 1000;

/** `beanFeed.sanitizedValue` of a param name. */
function sanitizedField(name: string): string {
  return name.replace(/[^0-9A-Za-z._,\-*]/g, '');
}

/** A userFeedBean built from request params: userGateway criteria and the feed properties the target honours. */
interface UserFeedPlan {
  params: SearchParamEntry[];
  isPublic?: unknown;
  groupId?: string;
  sortBy?: string;
  sortDirection?: string;
  maxItems: number;
  nextN: number;
}

function newUserFeed(): UserFeedPlan {
  return { params: [], maxItems: 0, nextN: FEED_NEXT_N };
}

/** `feed.addParam(column, criteria, condition, relationship)` of the user feed: a feed setter, or a criteria row (beanFeed.cfc:301-345). */
function addUserParam(feed: UserFeedPlan, column: string, criteria: string, condition: string, relationship: string): void {
  const field = sanitizedField(column);
  if (field === '') return;
  const setter = field.toLowerCase();
  if (isValidVariableName(field)) {
    if (INERT_SETTERS.includes(setter)) return;
    if (FAILING_SETTERS.includes(setter)) throw serverError();
    if (setter === 'orderby') throw unavailable('A user feed orderby setter has no target ordering', 'user-feed-orderby');
    if (setter === 'nextn') {
      if (cfIsNumeric(criteria)) feed.nextN = cfToNumber(criteria);
      return;
    }
  }
  const type = USER_PARAM_TYPES.get((field.split('.').at(-1) ?? '').toLowerCase()) ?? 'varchar';
  feed.params.push({ field: `${field}^${type}`, relationship, criteria, condition });
}

/** setFeedProps of a user or address feed: `sort`/`orderby` as a built-in user sort, and `limit` (jsonApiUtility.cfc:2953-3135). */
function applyFeedProps(call: ApiCall, feed: UserFeedPlan, props: Readonly<Struct>): void {
  const orderBy = textOf(valueOf(props, 'orderby')) ?? '';
  const sort = textOf(valueOf(props, 'sort')) ?? '';
  const order = sort !== '' ? sort : orderBy;
  if (order !== '') {
    const keys = cfListToArray(order);
    const [key] = keys;
    const descending = key?.startsWith('-') === true;
    const column = key === undefined ? '' : /^[+-]/.test(key) ? key.slice(1) : key;
    if (call.entity !== 'user' || keys.length !== 1 || key === undefined || key.length < 2 || !listHasNoCase(SORTABLE_COLUMNS, column)) {
      throw unavailable(`The ${call.entity} feed order ${order} has no target ordering`, 'feed-orderby');
    }
    feed.sortBy = column.toLowerCase();
    feed.sortDirection = descending ? 'desc' : 'asc';
  }
  const limit = valueOf(props, 'limit');
  if (cfIsNumeric(limit)) {
    const top = cfToNumber(limit);
    // `select top <n>` of a negative or fractional value is an SQL error.
    if (top < 0 || !Number.isInteger(top)) throw serverError();
    feed.maxItems = top;
  }
}

/** setIteratorProps' `offset`, which reads a `feed` no scope defines (jsonApiUtility.cfc:3176-3178). */
function assertNoOffset(call: ApiCall): void {
  if (cfIsNumeric(valueOf(call.url, 'offset'))) throw serverError();
}

/** `countOnly`: the user feed's getAvailableCount reads `.count` of a full query, which has none (userFeedBean.cfc:240-242). */
function assertNoCountOnly(props: Readonly<Struct>): void {
  const countOnly = valueOf(props, 'countonly');
  if (cfIsBoolean(countOnly) && cfToBoolean(countOnly)) throw serverError();
}

/** The user feed's query: getAdvancedSearch of the plan over the token site's pools, `top maxItems` applied (userGateway.cfc:164-592). */
async function userFeedRows(call: ApiCall, feed: UserFeedPlan): Promise<Struct[]> {
  const user = call.caller.user;
  if (user === undefined) throw new LegacyApiError('authorization');
  const criteria = {
    ...newAdvancedSearchCriteria(),
    paramArray: feed.params,
    ...(feed.isPublic === undefined ? {} : { ispublic: feed.isPublic }),
    ...(feed.groupId === undefined ? {} : { groupID: feed.groupId }),
  };
  const query: LegacyQuery = await getAdvancedSearch(call.deps.search, viewerScope(user), criteria, {
    siteid: call.siteId,
    ...(feed.sortBy === undefined ? {} : { sortBy: feed.sortBy, sortDirection: feed.sortDirection }),
  });
  const rows = query.rows.map((row) => ({ ...row }));
  return feed.maxItems > 0 ? rows.slice(0, feed.maxItems) : rows;
}

/** One row of a userGateway query as the userIterator packages it: a new bean set from the row, with its memberships and interests (userIterator.cfc:93-104). */
async function userItemBeans(call: ApiCall, rows: readonly Struct[]): Promise<UserBean[]> {
  const ids = rows.map((row) => textOf(valueOf(row, 'userid')) ?? '');
  const memberships = await membershipsOf(call, ids);
  const beans: UserBean[] = [];
  for (const [index, row] of rows.entries()) {
    const userId = ids[index] ?? '';
    const cells = new Map(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value ?? ''] as const));
    const set = applyUserInput({ ...newUserValues(call.deps.clock), userid: '' }, cells);
    const siteId = String(set.siteid);
    const { categoryIds, extend } = await withTenant(call.deps.db, tenantOfSite(call, siteId), async (tx) => ({
      categoryIds: (await call.deps.repository.listInterests(tx, userId)).map((interest) => interest.categoryid),
      extend: await extendSetData(call.deps.repository, tx, userId, { siteId, type: '2', subtype: String(set.subtype) }),
    }));
    const meta = new Map([
      ['groupid', (memberships.get(userId) ?? []).join(',')],
      ['categoryid', categoryIds.join(',')],
    ]);
    const values = withExtendSetData(applyUserInput(set, meta), extend);
    const wantsAddresses = listHasNoCase(cfListToArray(urlFields(call) ?? ''), 'addresses');
    const addresses = wantsAddresses ? await withTenant(call.deps.db, tenantOfSite(call, siteId), (tx) => listAddresses(call.deps.repository, tx, userId)) : [];
    beans.push({ values, exists: true, addresses, extendData: extend.data });
  }
  return beans;
}

/** A queryIterator's page over `count` rows: `nextN`, then the url's `itemsPerPage`, `pageIndex` and `startIndex` (queryIterator.cfc; jsonApiUtility.cfc:3160-3180). */
interface IteratorPage {
  count: number;
  maxRecordsPerPage: number;
  pageIndex: number;
  /** Zero-based row positions of the page. */
  positions: number[];
}

function iteratorPage(count: number, nextN: number, params: Readonly<Struct>): IteratorPage {
  let max = nextN !== 0 && Number.isFinite(nextN) ? nextN : count;
  let pageIndex = 1;
  let recordIndex = 0;
  const setPage = (page: number): void => {
    pageIndex = page;
    recordIndex = (pageIndex - 1) * max;
    if (recordIndex > count) {
      recordIndex = 0;
      pageIndex = 1;
    }
  };
  const itemsPerPage = valueOf(params, 'itemsperpage');
  if (cfIsNumeric(itemsPerPage)) {
    const n = cfToNumber(itemsPerPage);
    max = n !== 0 ? n : count;
  } else if (itemsPerPage === '*') max = count;
  const page = valueOf(params, 'pageindex');
  if (cfIsNumeric(page)) setPage(cfToNumber(page));
  const start = valueOf(params, 'startindex');
  if (cfIsNumeric(start)) {
    let startRow = cfToNumber(start);
    if (count > 0) {
      setPage(max !== 1 ? Math.ceil(startRow / max) : startRow);
      if (startRow) startRow -= 1;
      if (recordIndex !== startRow && startRow < count) recordIndex = startRow;
    } else {
      recordIndex = 0;
      setPage(1);
    }
  }
  const positions: number[] = [];
  while (recordIndex < count && recordIndex < pageIndex * max) {
    recordIndex += 1;
    if (!Number.isInteger(recordIndex) || recordIndex < 1) throw serverError();
    positions.push(recordIndex - 1);
  }
  return { count, maxRecordsPerPage: max, pageIndex, positions };
}

/** `packageIteratorArray` of a user or address iterator (jsonApiUtility.cfc:287-366). */
function packagePage(call: ApiCall, page: IteratorPage, items: ReadonlyArray<UserEntity | AddressEntity>, baseUrl: string): EntityCollection {
  const { count, maxRecordsPerPage: max, pageIndex } = page;
  const first = (pageIndex - 1) * max;
  const totalPages = count > 0 ? Math.ceil(count / max) : 0;
  const result: Struct =
    count > 0
      ? {
          totalItems: count,
          totalPages,
          pageIndex,
          items,
          startindex: first > count ? 1 : first + 1,
          endindex: Math.min(first + max, count),
          itemsperpage: max,
        }
      : { totalItems: 0, totalPages: 0, pageIndex: 0, items: [], startindex: 0, endindex: 0, itemsperpage: max };
  result.entityname = call.entity;
  const index = count > 0 ? pageIndex : 0;
  const nextIndex = index < totalPages ? index + 1 : 1;
  const prevIndex = index > 1 ? index - 1 : totalPages;
  const links: Record<string, string> = {
    self: `${baseUrl}&pageIndex=${index}`,
    entities: call.endpoint,
    properties: `${call.endpoint}/${call.entity}/properties`,
    permissions: `${call.endpoint}/${call.entity}/permissions`,
  };
  if (index > 1) {
    links.first = `${baseUrl}&pageIndex=1`;
    links.previous = `${baseUrl}&pageIndex=${prevIndex}`;
  }
  if (totalPages > 1) links.last = `${baseUrl}&pageIndex=${totalPages}`;
  if (index < totalPages) links.next = `${baseUrl}&pageIndex=${nextIndex}`;
  result.links = links;
  return result as EntityCollection;
}

/** Whether a direct call's resolution set param `key` after `structAppend(form, params)`: no request scope or `X-` header carries it (jsonApiUtility.cfc:845-891). */
function setAfterFormCopy(call: ApiCall, key: string): boolean {
  if (!call.direct || requestParam(call.request, key) !== undefined) return false;
  const { headers } = call.request;
  return headerText(headers, `x-${key}`) === undefined && headerText(headers, `x-${key.replace(/_/g, '-')}`) === undefined;
}

/** packageIteratorArray's own base URL: url then form values in ACF struct order, `pageIndex` left out, `method` reported as the operation. */
function scopeBaseUrl(call: ApiCall, operation: string): string {
  const merged: Struct = {};
  const order: string[] = [];
  const put = (key: string, value: unknown): void => {
    if (keyOf(merged, key) === undefined) order.push(key);
    setIn(merged, key, value);
  };
  for (const [key, value] of Object.entries(call.url)) put(key, textOf(value) ?? '');
  // structAppend(form, params) left the resolved params in the form scope.
  for (const [key, value] of Object.entries(call.params)) {
    if (!setAfterFormCopy(call, key)) put(key, value);
  }
  const method = textOf(valueOf(merged, 'method'));
  if (method === undefined || method === 'undefined') put('method', operation);
  let url = `${call.endpoint}/?`;
  for (const key of acfStructKeyOrder(order)) {
    if (key.toLowerCase() !== 'pageindex') url += `&${key.toLowerCase()}=${textOf(merged[keyOf(merged, key) ?? key]) ?? ''}`;
  }
  return url;
}

/** The page of `beans` as items of the call's entity. */
async function itemsOf(call: ApiCall, beans: readonly (UserBean | AddressBean)[]): Promise<Array<UserEntity | AddressEntity>> {
  const items: Array<UserEntity | AddressEntity> = [];
  for (const bean of beans) {
    items.push('addresses' in bean ? userEntity(call, bean, { expanded: 0, editableCheck: false }) : await addressEntity(call, bean, { expanded: 0 }));
  }
  return items;
}

/** A user iterator's page and its packaged result. */
async function packagedUsers(call: ApiCall, rows: readonly Struct[], feed: UserFeedPlan, baseUrl: () => string, reorder?: string[]): Promise<EntityCollection> {
  const page = iteratorPage(rows.length, feed.nextN, call.url);
  const pageRows = page.positions.flatMap((position) => (rows[position] === undefined ? [] : [rows[position]]));
  let items = await itemsOf(call, await userItemBeans(call, pageRows));
  if (reorder !== undefined) items = reorderByIds(items, reorder);
  return packagePage(call, page, items, baseUrl());
}

/** findMany's order: for each requested id, the first item whose `id` equals it (jsonApiUtility.cfc:2697-2709). */
function reorderByIds<T extends UserEntity | AddressEntity>(items: readonly T[], ids: readonly string[]): T[] {
  return ids.flatMap((id) => {
    const match = items.find((item) => cfEq(String(item.id ?? ''), id));
    return match === undefined ? [] : [match];
  });
}

/** findAll(entityName='user'): the feed's public users (isPublic 1) of the site (jsonApiUtility.cfc:2542-2610). */
async function findAll(call: ApiCall): Promise<EntityCollection> {
  defaultUrlEntityName(call);
  assertAccess(call);
  if (call.entity === 'address') throw addressFeedRefused();
  const feed = newUserFeed();
  applyFeedProps(call, feed, call.url);
  assertNoCountOnly(call.url);
  assertNoOffset(call);
  return packagedUsers(call, await userFeedRows(call, feed), feed, () => scopeBaseUrl(call, 'findall'));
}

/** Legacy's address feed lists every address of the site, a group's too, and group addresses are identity's rows people cannot read. */
function addressFeedRefused(): LegacyServiceUnavailableError {
  return unavailable('An address feed includes group addresses, which are identity data', 'address-feed-group-rows');
}

/** findMany(entityName, ids): the feed's rows whose primary key is in `ids`, in the order of `ids` unless sorted (jsonApiUtility.cfc:2612-2712). */
async function findMany(call: ApiCall): Promise<EntityCollection> {
  defaultUrlEntityName(call);
  assertAccess(call);
  const idList = call.direct ? call.params.ids : call.params.id;
  if (idList === undefined) throw serverError();
  const ids = cfListToArray(idList);
  const feed = newUserFeed();
  if (call.entity === 'user') feed.params.push({ field: 'userid^varchar', relationship: 'and', criteria: idList, condition: 'in' });
  applyFeedProps(call, feed, call.url);
  assertNoOffset(call);
  const sorted = (textOf(valueOf(call.url, 'sort')) ?? '') !== '';
  const reorder = sorted ? undefined : ids;
  if (call.entity === 'user') return packagedUsers(call, await userFeedRows(call, feed), feed, () => scopeBaseUrl(call, 'findmany'), reorder);

  const tenants = userTenants(tokenEntry(call));
  const beans: AddressBean[] = [];
  for (const id of [...new Set(ids.map((item) => item.toUpperCase()))]) {
    const found = await findAddressRows(call, tenants, id);
    // An id people holds no address for may be a group's, which identity holds.
    if (found === null) throw addressFeedRefused();
    // The feed filters `tuseraddresses.siteID in (<site>)`.
    if (!cfEq(found.row.siteid ?? '', call.siteId)) continue;
    beans.push({ values: addressBeanValues({ address: found.row, extend: found.extend }), exists: true, tenantId: found.tenantId, extendData: found.extend.data });
  }
  // SQL Server reads the clustered primary key in order.
  beans.sort((a, b) => String(a.values.addressid).toUpperCase().localeCompare(String(b.values.addressid).toUpperCase()));
  const limited = feed.maxItems > 0 ? beans.slice(0, feed.maxItems) : beans;
  const page = iteratorPage(limited.length, feed.nextN, call.url);
  const pageBeans = page.positions.flatMap((position) => (limited[position] === undefined ? [] : [limited[position]]));
  let items = await itemsOf(call, pageBeans);
  if (reorder !== undefined) items = reorderByIds(items, reorder);
  return packagePage(call, page, items, scopeBaseUrl(call, 'findmany'));
}

/** One `cgi.QUERY_STRING` item's name as findQuery reads it: url-decoded, before any `=`. */
function queryItemName(item: string): string {
  return cfUrlDecode(cfListFirst(item, '='));
}

/** findQuery(entityName='user'): every url param of the query string as a feed param or property (jsonApiUtility.cfc:2712-2938). */
async function findQuery(call: ApiCall): Promise<EntityCollection> {
  defaultUrlEntityName(call);
  assertAccess(call);
  if (call.entity === 'address') throw addressFeedRefused();
  const feed = newUserFeed();
  const isPublic = valueOf(call.params, 'ispublic');
  feed.isPublic = keyOf(call.url, 'ispublic') !== undefined && cfIsNumeric(isPublic) ? isPublic : 'all';
  let baseUrl = `${call.endpoint}/user/?`;
  let started = false;
  let relationship = 'and';
  const sorts: string[] = [];
  const names = cfListToArray(queryStringOf(call.request), '&').map(queryItemName).filter((name) => !cfEq(name, 'pageIndex'));
  for (const name of names) {
    const propName = name.includes('[') ? cfListFirst(name, '[') : name;
    const value = valueOf(call.url, name);
    if (value === undefined) continue;
    const criteria = textOf(value) ?? '';
    baseUrl += `${started ? '&' : ''}${esapiUrlEncode(name)}${criteria !== '' ? `=${esapiUrlEncode(criteria)}` : ''}`;
    started = true;
    if (listHasNoCase(QUERY_EXCLUDED, propName) || cfEq(propName, 'isPublic')) continue;
    if (cfEq(propName, 'sort')) {
      sorts.push(criteria);
    } else if (cfEq(propName, 'groupid')) {
      feed.groupId = criteria;
    } else if (cfEq(propName, 'or')) {
      relationship = 'or';
    } else if (listHasNoCase(GROUPING_NAMES, propName) || listHasNoCase(AGGREGATE_NAMES, propName) || listHasNoCase(['innerJoin', 'leftJoin'], propName)) {
      throw unavailable(`The user feed's ${propName} param has no target query`, 'user-feed-query');
    } else {
      let condition = 'eq';
      let term = criteria;
      const parts = cfListToArray(criteria, '^');
      if (parts.length > 1) {
        condition = parts[0] ?? '';
        term = parts[1] ?? '';
      } else if (criteria.includes('*')) {
        condition = 'like';
        term = criteria.replaceAll('*', '%');
      }
      addUserParam(feed, cfEq(propName, 'id') ? 'userid' : propName, term, condition, relationship);
      relationship = 'and';
    }
  }
  const props: Struct = { ...call.url };
  if (sorts.length > 0) setIn(props, 'sort', sorts.join(','));
  applyFeedProps(call, feed, props);
  assertNoCountOnly(call.url);
  assertNoOffset(call);
  return packagedUsers(call, await userFeedRows(call, feed), feed, () => baseUrl);
}

// --- validate ---

/** `en` text of `user.usernamevalidate`, which people's site bundles do not carry [legacy: core/mura/resourceBundle/resources/en.properties:1843]. */
const USERNAME_TAKEN_TEXT = "The username '{1}' that you entered is being used by another user.";

/** `urlDecode`, `isJSON` and `deserializeJSON` of a validate argument; `invalidParameters` when it is not JSON (jsonApiUtility.cfc:3705-3721). */
function jsonArgument(text: string): unknown {
  try {
    return JSON.parse(cfUrlDecode(text)) as unknown;
  } catch {
    throw new LegacyApiError('invalidParameters');
  }
}

/** A validate argument CFML reads as a string; a complex one raises. */
function simpleArgument(value: unknown): string {
  const text = value === null ? '' : textOf(value);
  if (text === undefined) throw serverError();
  return text;
}

/** `beanExtendable.setSiteID`: a non-empty trimmed value that differs ignoring case (beanExtendable.cfc:131-137). */
function withSiteId<V extends { siteid: unknown }>(values: V, siteId: string): V {
  const text = siteId.trim();
  return text !== '' && !cfEq(text, String(values.siteid)) ? { ...values, siteid: text } : values;
}

/** The extended-data errors `validateExtendedData(getAllValues())` gives a bean of a non-empty site (extendManager.cfc:362-437). */
async function extendedErrors(call: ApiCall, values: Readonly<Struct>, tenantId: string | undefined): Promise<Record<string, string>> {
  const siteId = String(valueOf(values, 'siteid') ?? '');
  if (siteId === '') return {};
  const { roster, repository, db } = call.deps;
  const data = normaliseParams(values);
  const tenant = tenantId ?? tenantOfSite(call, siteId);
  const attributes = await withTenant(db, tenant, (tx) => loadSubmittedAttributes(repository, tx, String(valueOf(values, 'extendsetid') ?? ''), siteId, { forSave: false }));
  return validateExtendedData(attributes, data, roster.extendConfig ?? EXTEND_CONFIG_DEFAULTS, roster.locale, roster.rb);
}

/** `userBean.validate()`: its extended-data, user-name, email, captcha and spam errors (userBean.cfc:447-522). */
async function validateUserBean(call: ApiCall, bean: UserBean): Promise<LegacyErrors> {
  const { values } = bean;
  const people = validatePersonValues(values, call.deps.roster.rb);
  if (javaTrim(String(values.siteid)) === '') return people;
  const extended = await extendedErrors(call, values, bean.tenantId);
  const identity: LegacyErrors = {};
  if (Number(values.type) === 2) {
    const username = String(values.username ?? '');
    // checkUsername() reads other users' user names, which are identity data.
    if (username !== '') throw unavailable('A user name check reads identity accounts', 'validate-username');
    // messageFormat has no argument for {1} when listToArray of the empty user name is empty.
    identity.username = USERNAME_TAKEN_TEXT;
  }
  return mergeUserErrors({ extended, identity, people }, call.deps.roster.rb);
}

/** validate(data, validations, siteid) of a user or address bean, as `data.entityname` names it (jsonApiUtility.cfc:3703-3812). */
async function validate(call: ApiCall): Promise<EntityMeta> {
  const data = jsonArgument(call.params.data ?? '{}');
  const validations = jsonArgument(call.params.validations ?? '{}');
  if (!isRecord(data) || !isRecord(validations)) return { invalid: 'Invalid validation request' };
  if (keyOf(data, 'fields') === undefined) setIn(data, 'fields', '');
  if (keyOf(data, 'siteid') === undefined) setIn(data, 'siteid', call.siteId);
  const siteId = simpleArgument(valueOf(data, 'siteid'));
  assertSitelessEvent(call, siteId);
  const entityName = valueOf(data, 'entityname');
  if (entityName !== undefined && entityName !== null && !cfEq(simpleArgument(entityName), 'bean')) {
    const named = simpleArgument(entityName);
    if (!cfEq(named, 'user') && !cfEq(named, 'address')) throw unavailable(`A ${named} bean is validated by its owner`, 'validate-foreign-entity');
    const entity: PeopleEntity = cfEq(named, 'user') ? 'user' : 'address';
    const pk = PRIMARY_KEYS[entity];
    if (keyOf(data, pk) === undefined) setIn(data, pk, cfUuid());
    const id = simpleArgument(valueOf(data, pk));
    assertAccess(call);
    if (entity === 'user') {
      const loaded = await loadUser(call, id);
      return validateUserBean(call, { ...loaded, values: { ...withSiteId(loaded.values, siteId), userid: id } });
    }
    const loaded = await loadAddress(call, id);
    const values = { ...withSiteId(loaded.values, siteId), addressid: id };
    return validateAddressValues(await extendedErrors(call, values, loaded.tenantId));
  }
  // Ad-hoc rules and `bean`/`loadby` validations build arbitrary beans, which the people service does not hold.
  if (Object.keys(validations).length > 0) throw unavailable('Ad-hoc validation rules build a generic bean', 'validate-rules');
  const beanName = valueOf(data, 'bean');
  const loadBy = valueOf(data, 'loadby');
  if (beanName !== undefined && beanName !== null && loadBy !== undefined && loadBy !== null && !cfEq(simpleArgument(beanName), 'bean')) {
    if (listHasNoCase(['orderby', 'returnFormat', 'cachedWithin'], simpleArgument(loadBy))) throw new LegacyApiError('invalidParameters');
    throw unavailable('A loadby validation reads a bean by an arbitrary property', 'validate-loadby');
  }
  return {};
}

// --- save ---

/** The id `save` addresses: a posted primary key that is a CF UUID or the admin sentinel, else the `id` argument (jsonApiUtility.cfc:1958-1966). */
function savedId(vals: Readonly<Struct>, pk: string, id: string): string {
  const posted = textOf(valueOf(vals, pk));
  return posted !== undefined && posted !== '' && (isCfUuid(posted) || posted === LEGACY_ADMIN_SENTINEL_ID) ? posted : id;
}

/** `validateCSRFTokens(context=csrfcontext)` of a session-managed save, through identity's single-use arbitration; REST is sessionless. */
async function assertCsrf(call: ApiCall, context: string): Promise<void> {
  if (call.restMode) return;
  await csrfPreHandler({ contextOf: () => context }).call(call.app, call.request, call.reply);
}

/** The save's user values without the keys the caller may not set (jsonApiUtility.cfc:1913-1937). */
function strippedUserValues(call: ApiCall): Struct {
  const { caller } = call;
  const vals: Struct = { ...call.params };
  if (!(caller.adminUser || caller.superUser)) {
    deleteIn(vals, 'isPublic');
    deleteIn(vals, 'type');
    if (!caller.usersModule) deleteIn(vals, 'groupID');
  }
  if (!caller.superUser) deleteIn(vals, 's2');
  const groupName = textOf(valueOf(vals, 'groupname'));
  if (groupName !== undefined && cfEq(groupName, 'admin')) deleteIn(vals, 'groupname');
  const postedId = textOf(valueOf(vals, 'userid'));
  if (postedId !== undefined && !cfEq(postedId, caller.userId)) deleteIn(vals, 'email');
  return vals;
}

/** The verified user claims a write acts for; a call without them reaches no write. */
function writerOf(call: ApiCall): UserClaims {
  const { user } = call.caller;
  if (user === undefined) throw new LegacyApiError('authorization');
  return user;
}

/** The bean's `saveErrors` value: the posted one `set()` copied, else `getValue` of a key the bean does not hold, ''. */
function saveErrorsOf(vals: Readonly<Struct>): unknown {
  return valueOf(vals, 'saveerrors') ?? '';
}

/** save(entityName='user') of a Type=2 user without a photo or extended data, under the roster write protocol (jsonApiUtility.cfc:1903-2074). */
async function saveUser(call: ApiCall): Promise<UserEntity> {
  const { request, caller, deps } = call;
  const csrfContext = call.params.id ?? 'new';
  const vals = strippedUserValues(call);
  let id = savedId(vals, 'userid', csrfContext);
  const isNew = cfEq(id, 'new');
  if (isNew) {
    id = cfUuid();
    setIn(vals, 'id', id);
    setIn(vals, 'userid', id);
  }
  await assertCsrf(call, csrfContext);
  const user = writerOf(call);
  const tenants = userTenants(tokenEntry(call));
  const posted = textOf(valueOf(vals, 'userid'));
  const stored = isNew ? null : await readStoredUser(call, tenants, javaTrim(posted ?? id));
  // set(event) keeps a loaded user's id; an unknown one without a posted userid takes the id getUserID() creates.
  const target = posted !== undefined ? javaTrim(posted) : stored !== null ? String(stored.values.userid) : cfUuid();
  setIn(vals, 'userid', target);
  if (!allowsAction(caller, target)) throw new LegacyApiError('authorization');

  const input = normaliseParams(vals);
  const tenantId =
    stored?.tenantId ?? (await resolveUserSite(deps.db, user.tid, input, applyUserInput(newUserValues(deps.clock), input))).poolTenantId;
  // A logged-in user saving their own record in json mode is logged in again (jsonApiUtility.cfc:2065-2071).
  const relogin = call.methodCtx.restMode === false && caller.loggedIn && cfEq(caller.userId, target) && user.sid !== '';
  const result = await runRosterOperation(deps.roster, {
    kind: 'json-save',
    tenantId,
    claims: user,
    ...(user.sid === '' ? {} : { acting: await deps.identity.actingUser(user.sid) }),
    params: input,
    postedFiles: new Map(multipartFilesOf(request).map((file) => [file.field, file.filename])),
    requestId: request.id,
    ...(relogin ? { sessionReloginId: user.sid } : {}),
  });
  const errors: LegacyErrors = result.ok ? {} : result.errors;
  const saveErrors = saveErrorsOf(vals);
  const reloadId = result.ok ? result.userId : target;
  const reloaded = (await readStoredUser(call, [tenantId, ...tenants], reloadId)) ?? (await newUserBean(call));
  const values = overlayRequestValues(reloaded.values, input, { saveErrors, errors, entityName: 'user' });
  const entity = userEntity(call, { ...reloaded, values }, { expanded: true, editableCheck: false });
  return saveResponse(entity, { saveErrors, errors }) as UserEntity;
}

/** The first of `tenants` holding person `userId`, read without a fence; the address save fences it itself. */
async function personTenant(call: ApiCall, tenants: readonly string[], userId: string): Promise<string | undefined> {
  for (const tenantId of tenants) {
    if ((await withTenant(call.deps.db, tenantId, (tx) => call.deps.repository.findPerson(tx, userId))) !== null) return tenantId;
  }
  return undefined;
}

/** save(entityName='address') without extended data: AllowAction on the bean's user, then addressBean.save (jsonApiUtility.cfc:1903-2074; addressBean.cfc:258-268). */
async function saveAddressEntity(call: ApiCall): Promise<AddressEntity> {
  const { request, caller, deps } = call;
  const csrfContext = call.params.id ?? 'new';
  const vals: Struct = { ...call.params };
  let id = savedId(vals, 'addressid', csrfContext);
  const isNew = cfEq(id, 'new');
  if (isNew) {
    id = cfUuid();
    setIn(vals, 'id', id);
    setIn(vals, 'addressid', id);
  }
  await assertCsrf(call, csrfContext);
  const user = writerOf(call);
  const tenants = userTenants(tokenEntry(call));
  const posted = textOf(valueOf(vals, 'addressid'));
  const stored = isNew ? null : await findAddressRows(call, tenants, javaTrim(posted ?? id));
  const target = posted !== undefined ? javaTrim(posted) : stored !== null ? stored.row.addressid : cfUuid();
  setIn(vals, 'addressid', target);
  const postedUserId = textOf(valueOf(vals, 'userid'));
  const beanUserId = postedUserId !== undefined ? javaTrim(postedUserId) : (stored?.row.userid ?? '').trimEnd();
  if (!allowsAction(caller, beanUserId)) throw new LegacyApiError('authorization');

  const input = normaliseParams(vals);
  const tenantId = stored?.tenantId ?? (beanUserId === '' ? undefined : await personTenant(call, tenants, beanUserId)) ?? tokenEntry(call).tenantId;
  const actor: Parameters<typeof saveAddress>[3] = { tid: user.tid, write: { origin: 'target', actorUserId: user.sub, requestId: request.id } };
  const saved = await saveAddress(deps.addresses, tenantId, input, actor);
  const saveErrors = saveErrorsOf(vals);
  const errors: LegacyErrors = {};
  const reloaded = await loadAddress(call, saved.address === null ? '' : String(saved.values.addressid));
  return saveResponse(await addressEntity(call, reloaded, { expanded: true }), { saveErrors, errors }) as AddressEntity;
}

// --- Dispatch ---

/** A direct method's answer: always 200, the method as requested (jsonApiUtility.cfc:869-900). */
function envelopeAnswer(call: ApiCall, data: unknown): SerializedLegacyResponse {
  if (isRecord(data)) assertSitelessEvent(call, call.apiSite);
  return serializeResponse(buildEnvelope({ method: call.method ?? 'undefined', params: paramsWithoutMethod(call.params), data }), {
    useDataNamespace: call.params.usedatanamespace,
    serializer: entitySerializer(),
  });
}

/** The operation's data. */
async function operationData(call: ApiCall, operation: Operation): Promise<unknown> {
  switch (operation) {
    case 'findAll':
      return findAll(call);
    case 'findMany':
      return findMany(call);
    case 'findNew':
      return findNew(call);
    case 'findOne':
      return findOne(call);
    case 'findPermissions':
      return findPermissions(call);
    case 'findProperties':
      return findProperties(call);
    case 'findQuery':
      return findQuery(call);
    case 'save':
      return call.entity === 'user' ? saveUser(call) : saveAddressEntity(call);
    case 'validate':
      return validate(call);
    case 'pollState':
      return pollState(call);
  }
}

/** A `user` or `address` operation, as a direct method or on the entity route (jsonApiUtility.cfc:1000-1314). */
async function entityAnswer(call: ApiCall, operation: Operation): Promise<SerializedLegacyResponse> {
  // The `<id>/permissions` path answers its own envelope, without params, before the method is set.
  const permissionsPath = !call.direct && operation === 'findPermissions' && !cfEq(call.params.id ?? '', 'permissions');
  if (operation === 'pollState') {
    // invoke() of the remote function reports its name as the request spells it, with `id` deleted.
    call.method = remoteFunctionSpelling(call, 'pollState');
    delete call.params.id;
  } else if (!call.direct && !permissionsPath) {
    call.method = operation;
  }
  // findProperties, pollState and validate build no event of their own before their arguments are read.
  if (operation !== 'findProperties' && operation !== 'validate' && operation !== 'pollState') assertSitelessEvent(call, call.siteId);
  const data = await operationData(call, operation);
  if (call.direct) return envelopeAnswer(call, data);
  assertSitelessEvent(call, call.apiSite);
  const opts = { useDataNamespace: call.params.usedatanamespace, serializer: entitySerializer() };
  if (permissionsPath) return serializeResponse(buildEnvelope({ method: 'findPermissions', data }), opts);
  // The entity route answers 403 when the result carries errors.
  return serializeSaveResult({ method: call.method ?? operation, params: call.params, data }, opts);
}

/** Registers the contract's JSON API routes of every family; each method and path form shares one handler. */
export async function registerLegacyApiRoutes(app: FastifyInstance, deps: LegacyApiRouteDeps): Promise<void> {
  const settings = deps.legacy ?? legacyApiSettings(process.env);
  const snapshots = new WeakMap<FastifyRequest, Promise<TenantRegistryEntry[]>>();

  /** The request's single registry read, which the Origin echo and the route resolution share. */
  function registryOf(request: FastifyRequest): Promise<TenantRegistryEntry[]> {
    let snapshot = snapshots.get(request);
    if (snapshot === undefined) {
      snapshot = registryEntries(deps.db);
      snapshots.set(request, snapshot);
    }
    return snapshot;
  }

  /** processRequest's Origin echo on every answer of the route, auth denials included (jsonApiUtility.cfc:382-394). */
  async function allowOrigin(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
    if (request.headers.origin === undefined) return payload;
    let registry: TenantRegistryEntry[];
    try {
      registry = await registryOf(request);
    } catch {
      // The answer goes out without the echo: a throw from onSend re-enters error handling and sends it again.
      return payload;
    }
    reply.headers(originEcho(request.headers, registry, settings.adminDomain));
    return payload;
  }

  /** getEndPoint() and getAdminPath(complete=1) of this request (jsonApiUtility.cfc:3337-3364; settingsBean.cfc:1416-1462). */
  function urlsOf(request: FastifyRequest, mode: 'json' | 'rest', apiSite: string): { endpoint: string; adminPath: string } {
    const host = clientHostOf(request.headers);
    const port = settings.serverPort ?? serverPortSetting(host.port);
    const protocol = settings.adminSSL ? 'https' : requestProtocolOf(request);
    const hasAdminDomain = settings.adminDomain !== '';
    // configBean.getAdminPath takes getCurrentAdminDomain() as is, so a host off the admin domains keeps its port (configBean.cfc:517-528,1860-1875).
    const domain = hasAdminDomain ? currentAdminDomainOf(request.headers, settings.adminDomain) : host.name;
    const scheme = (hasAdminDomain && settings.adminSSL) || requestProtocolOf(request) === 'https' ? 'https' : 'http';
    return {
      endpoint: `${protocol}://${host.name}${port}${settings.context}/index.cfm/_api/${mode}/v1/${apiSite}`,
      adminPath: `${scheme}://${domain}${port}${settings.context}/admin`,
    };
  }

  /** processRequest's resolution through the shared route key, then the operation people serves. */
  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const registry = new Map((await registryOf(request)).map((entry) => [entry.siteId.toLowerCase(), entry]));
    const lookup = (siteId: string): TenantRegistryEntry | undefined => registry.get(siteId.toLowerCase());
    const headers = clientHeadersOf(request);
    const keyed = routeKeyRequestOf(request, headers);
    const key = routeKeyForRequest(keyed, {
      siteExists: (siteId) => lookup(siteId) !== undefined,
      variants: WITHHELD_VARIANTS,
      context: settings.context,
      appReloadKey: settings.appReloadKey,
      entityRemoteFunctions: { user: ['pollState'] },
      entityRelationships: { address: ['user', 'site'] },
      entityPrimaryKeys: { address: 'addressid' },
    });
    const params = { ...key.params };
    const restMode = key.family === 'rest';
    const methodCtx: ApiNameContext = {
      hasOrigin: request.headers.origin !== undefined,
      restMode,
      hasAuthorization: restMode && headerText(headers, 'authorization') !== undefined,
    };
    // A key people does not own is no route of this service.
    const notFound = (): FastifyReply =>
      sendLegacyResponse(reply, legacyErrorResponse('invalidMethodCall', { method: params.method, params, methodCtx, mura404: true }));
    if (key.family !== 'api' && key.family !== 'rest') return notFound();
    const body = key.baseKey.slice(key.family.length + 1);
    const served = OPERATIONS.get(body);
    const failure = RESOLUTION_ERRORS.get(body);
    if (served === undefined && failure === undefined && !WITHHELD_KEYS.has(body)) return notFound();

    const user = request.opt2Auth.user;
    const apiSiteId = key.siteId ?? 'default';
    if (user !== undefined) {
      assertSiteMatches(apiSiteId, user);
      // An unregistered siteid only selects the `default` fallback; a registered one must be the token's site.
      for (const supplied of suppliedSiteIds(keyed)) {
        if (lookup(supplied) !== undefined) assertSiteMatches(supplied, user);
      }
    }
    const apiSite = lookup(apiSiteId)?.siteId ?? apiSiteId;
    const requested = requestParam(request, 'method');
    // A dotted method (user.<m>) rewrites the path and resolves as the entity route (jsonApiUtility.cfc:953-961).
    const dotted = typeof requested === 'string' && requested.includes('.');
    const call: ApiCall = {
      request,
      reply,
      app,
      deps,
      entity: served?.entity ?? 'user',
      params,
      url: Object.fromEntries(Object.entries(scopeOf(request.query, true)).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value])),
      caller: callerOf(user),
      restMode,
      apiSite,
      siteId: params.siteid ?? apiSite,
      registry,
      direct: served !== undefined && !dotted && params.method !== undefined && cfEq(params.method, served.operation),
      method: params.method,
      methodCtx,
      ...urlsOf(request, restMode ? 'rest' : 'json', apiSite),
    };
    try {
      if (failure !== undefined) throw new LegacyApiError(failure, { method: params.method, methodCtx });
      if (key.variant === 'photo') throw new PhotoBranchError();
      if (key.variant !== undefined || served === undefined) {
        throw unavailable(`The ${key.key} branch is withheld on the decision list and served by legacy`, `${body}-withheld`);
      }
      // A REST request reaches a method only after its credentials were exchanged for a session token.
      if (restMode && user === undefined) {
        throw new LegacyApiError('authorization', { method: 'Not Available', wwwAuthenticate: WWW_AUTHENTICATE.basic });
      }
      return sendLegacyResponse(reply, await entityAnswer(call, served.operation));
    } catch (err) {
      if (err instanceof LegacyApiError) {
        return sendLegacyResponse(
          reply,
          legacyErrorResponse(err.type, {
            method: err.method ?? call.method,
            params: err.params ?? params,
            methodCtx: err.methodCtx ?? methodCtx,
            wwwAuthenticate: err.wwwAuthenticate,
          }),
        );
      }
      if (err instanceof LegacyServiceUnavailableError || err instanceof AuthDenial) throw err;
      request.log.error({ err }, 'unhandled JSON API error');
      // catch (Any e) reports params.method as the failing operation had set it.
      return sendLegacyResponse(reply, legacyErrorResponse('server_error', { method: call.method, params, methodCtx }));
    }
  }

  for (const family of FAMILIES) {
    for (const url of [`/_api/${family}/v1`, `/_api/${family}/v1/*`]) {
      app.route({ method: [...HTTP_METHODS], url, config: { opt2: { ...ROUTE_AUTH } }, onSend: allowOrigin, handler: handle });
    }
  }
}
