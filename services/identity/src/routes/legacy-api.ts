/** JSON API methods and the `group` entity identity owns, served as Masa's `processRequest` serves them [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:368-1402]. */
import { AuthDenial, Roles, assertSiteMatches, moduleRole, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LEGACY_JSON_CONTENT_TYPE,
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
  deleteCookieLegacy,
  esapiUrlEncode,
  isCfUuid,
  isValidVariableName,
  legacyErrorResponse,
  paramsWithoutMethod,
  routeKeyForRequest,
  serializeResponse,
  serializeSaveResult,
  type ApiKeyHint,
  type ApiNameContext,
  type LegacyApiErrorType,
  type LegacyJsonSerializer,
  type RouteKeyRequest,
  type SerializedLegacyResponse,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  EnvValidationError,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  withMetadata,
  withTenant,
  type TenantDb,
  type TenantRegistryEntry,
} from '@opt2/platform/tenancy';
import { issueTokens } from '../domain/csrf.js';
import {
  createGroup,
  findGroupForSite,
  groupSaveInputFrom,
  listGroups,
  newGroupRecord,
  updateGroup,
  type GroupActor,
  type GroupDeps,
  type GroupRecord,
  type GroupSaveInput,
} from '../domain/groups.js';
import { login, logout, type LoginDeps } from '../domain/login.js';
import { snapshotIsS2 } from '../domain/roles.js';
import { locateSession, sessionSnapshot, type SessionDeps } from '../domain/sessions.js';
import { validateCsrfForRoute, type CsrfRouteDeps } from './internal-csrf.js';
import { authenticateRestRequest, type OAuthRouteDeps, type RestAuthInput } from './oauth.js';

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

/** The identity domain, CSRF, REST credential, service-call and registry dependencies of the JSON API routes. */
export type LegacyApiRouteDeps = {
  groups: GroupDeps;
  login: LoginDeps;
  sessions: SessionDeps;
  csrf: CsrfRouteDeps['csrf'];
  rest: OAuthRouteDeps;
  client: ServiceClient;
  db: TenantDb;
  /** Defaults to the `MURA_<KEY>` variables of `process.env`. */
  legacy?: LegacyApiSettings;
  /** `validateEmail`'s outbound `cfhttp`; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
};

const FAMILIES = ['json', 'ajax', 'rest'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

// `login` and `generateCSRFTokens` answer anonymous callers, so every legacy permission rule runs in the handler, after
// the API site fallback; the hooks' site check would refuse an unregistered `siteid` legacy answers as `invalidParameters`.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

/** The Users module, the `moduleid` the JSON API registers `user` and `group` with (jsonApiUtility.cfc:86-91). */
const USERS_MODULE_ROLE = moduleRole('00000000000000000000000000000000008');

// Withheld variants, declared as gateway/cutover/variants.json declares them: photo first, the first match wins.
const GROUP_SAVE_VARIANTS: readonly VariantDeclaration[] = Object.freeze(
  (['api', 'rest'] as const).flatMap((family): VariantDeclaration[] => [
    { route: `${family}:group.save`, variant: 'photo', when: [PHOTO_CONDITION] },
    { route: `${family}:group.save`, variant: 'extdata', when: [{ param: 'extendSetID', nonEmpty: true }] },
  ]),
);

/** Route-key error bodies and the exception types processRequest throws for them. */
const RESOLUTION_ERRORS: ReadonlyMap<string, LegacyApiErrorType> = new Map([
  ['!invalidparameters', 'invalidParameters'],
  ['!invalidmethodcall', 'invalidMethodCall'],
  ['!invalidentitycall', 'invalidEntityCall'],
  ['!server_error', 'server_error'],
]);

type NamedMethod = 'login' | 'logout' | 'generatecsrftokens' | 'findcurrentuser' | 'validateemail';

const NAMED_METHODS: ReadonlySet<string> = new Set<NamedMethod>([
  'login',
  'logout',
  'generatecsrftokens',
  'findcurrentuser',
  'validateemail',
]);

type GroupOperation =
  | 'findAll'
  | 'findMany'
  | 'findNew'
  | 'findOne'
  | 'findPermissions'
  | 'findProperties'
  | 'findQuery'
  | 'save'
  | 'validate';

/** The `group` keys identity serves; `group.delete` and the photo and extended-data saves stay on legacy. */
const GROUP_OPERATIONS: ReadonlyMap<string, GroupOperation> = new Map<string, GroupOperation>([
  ['group.findall', 'findAll'],
  ['group.findmany', 'findMany'],
  ['group.findnew', 'findNew'],
  ['group.findone', 'findOne'],
  ['group.findpermissions', 'findPermissions'],
  ['group.findproperties', 'findProperties'],
  ['group.findquery', 'findQuery'],
  ['group.save', 'save'],
  ['group.validate', 'validate'],
]);

/** REST credential endpoints whose answer is the credential block's own [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:422-835]. */
const OAUTH_KEYS: ReadonlySet<string> = new Set(['oauth', 'oauth2', 'tokeninfo']);

/** `registerEntity('group', {fields})` (jsonApiUtility.cfc:87-91). */
const GROUP_CONFIG_FIELDS: readonly string[] = Object.freeze(['links', 'userid', 'groupname', 'ispublic', 'siteid', 'type', 'subtype', 'remoteid']);

/** userBean properties whose datatype registerEntity hints (jsonApiUtility.cfc:261-271; userBean.cfc:78-123). */
const USER_ENTITY_HINTS: readonly ApiKeyHint[] = Object.freeze([
  ...['type', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate', 'isnew'].map((key): ApiKeyHint => ({ key, hint: 'integer' })),
  ...['passwordcreated', 'lastlogin', 'lastupdate', 'created'].map((key): ApiKeyHint => ({ key, hint: 'date' })),
]);

/** The JSON API serializer with the user entity's hints, which group values share. */
function groupSerializer(): LegacyJsonSerializer {
  return createApiSerializer(USER_ENTITY_HINTS);
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
    MURA_PORT: literalSetting(
      (v) => BLANK.test(v) || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535),
      'must be blank or a TCP port',
    ),
    MURA_CONTEXT: literalSetting((v) => /^(?:\s*|[/\\][^\s?#]*)$/.test(v), 'must be blank or a path from / or \\'),
    MURA_ADMINDOMAIN: literalSetting((v) => /^(?:\s*|[^\s:/\\?#@]+)$/.test(v), 'must be a comma list of host names'),
    MURA_APPRELOADKEY: z
      .string()
      .regex(/^[^\s\p{Cc}]*$/u, 'must not contain whitespace or control characters')
      .optional(),
  })
  .transform((env): LegacyApiSettings => ({
    adminSSL: env.MURA_ADMINSSL !== undefined && !BLANK.test(env.MURA_ADMINSSL) && cfToBoolean(env.MURA_ADMINSSL),
    // The template's port is ${cgi.SERVER_PORT}, which the servlet takes from the request host.
    ...(env.MURA_PORT === undefined ? {} : { serverPort: serverPortSetting(env.MURA_PORT) }),
    context: env.MURA_CONTEXT === undefined || BLANK.test(env.MURA_CONTEXT) ? '' : cleanFilePath(env.MURA_CONTEXT),
    appReloadKey: env.MURA_APPRELOADKEY ?? 'appreload',
    adminDomain: env.MURA_ADMINDOMAIN === undefined || BLANK.test(env.MURA_ADMINDOMAIN) ? '' : env.MURA_ADMINDOMAIN,
  }));

/** The settings from `MURA_<KEY>` variables, else the settings template values; throws EnvValidationError naming each malformed variable. */
function legacyApiSettings(env: Readonly<Record<string, string | undefined>>): LegacyApiSettings {
  const parsed = LEGACY_SETTINGS.safeParse(env);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new EnvValidationError(issues, 'identity');
}

// --- Request facts ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
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

/** A parsed query or form body as a route-key scope, else an empty one; `scanned` leaves it as the default `scriptProtect` Portcullis scan does (Portcullis.cfc:113-127). */
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

/** The first value of header `name`. */
function headerValue(headers: FastifyRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The client's own headers: without the gateway's Bearer user token, which legacy would key as an OAuth access token, and the invocation credential. */
function clientHeadersOf(request: FastifyRequest): FastifyRequest['headers'] {
  const headers: FastifyRequest['headers'] = { ...request.headers };
  const { userToken } = request.opt2Auth;
  if (userToken !== undefined && headerValue(headers, 'authorization') === `Bearer ${userToken}`) delete headers.authorization;
  delete headers['x-serverless-authorization'];
  return headers;
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

function pathOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '';
}

/** `cgi.QUERY_STRING`: the raw text after the first `?`. */
function queryStringOf(request: FastifyRequest): string {
  const at = request.url.indexOf('?');
  return at < 0 ? '' : request.url.slice(at + 1);
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
  if (headerValue(request.headers, 'x-forwarded-proto')?.toLowerCase() === 'https') return 'https';
  const frontEnd = headerValue(request.headers, 'front-end-https');
  if (frontEnd !== undefined && cfIsBoolean(frontEnd) && cfToBoolean(frontEnd)) return 'https';
  return request.protocol;
}

/** The client's host as the gateway forwards it, `X-Forwarded-Host` before the hop's own `Host`. */
function clientHostOf(request: FastifyRequest): { name: string; port: string } {
  const forwarded = headerValue(request.headers, 'x-forwarded-host') || headerValue(request.headers, 'host') || '';
  const host = forwarded.split(',')[0]?.trim() ?? '';
  const match = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(host);
  return { name: match?.[1] ?? host, port: match?.[2] ?? '' };
}

/** configBean.getCurrentAdminDomain() (configBean.cfc:517-525): the host's name on an admin domain, else the host. */
function currentAdminDomainOf(request: FastifyRequest, adminDomain: string): string {
  const { name, port } = clientHostOf(request);
  const onAdminDomain = adminDomain.split(',').some((domain) => domain.toLowerCase() === name.toLowerCase());
  return onAdminDomain || port === '' ? name : `${name}:${port}`;
}

/** Every registry entry, origin domains included, read in one metadata transaction. */
function registryEntries(db: TenantDb): Promise<TenantRegistryEntry[]> {
  return withMetadata(db, async (tx) => {
    const entries: TenantRegistryEntry[] = [];
    for (const { tenantId } of await registeredTenants(tx)) {
      const entry = await registryEntryForTenant(tx, tenantId);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  });
}

// --- CFML struct and list semantics ---

type Struct = Record<string, unknown>;

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
  struct[keyOf(struct, key) ?? key] = value;
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

/** `listLast` with `delim`: the last non-empty element, or `''`. */
function cfListLast(list: string, delim: string): string {
  return list.split(delim).filter((item) => item !== '').at(-1) ?? '';
}

/** CFML `listFindNoCase` over a comma list. */
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

/** Java String.hashCode. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

type Bin = Array<readonly [key: string, hash: number]>;

/** ConcurrentHashMap.transfer for one thread: each bin splits into its low and high halves. */
function transfer(bins: readonly Bin[], n: number): Bin[] {
  const next: Bin[] = Array.from({ length: n * 2 }, () => []);
  bins.forEach((bin, i) => {
    const first = bin[0];
    if (first === undefined) return;
    // The trailing run of nodes bound for one half moves as is; the nodes before it are prepended in turn.
    let runBit = first[1] & n;
    let lastRun = 0;
    bin.forEach(([, hash], p) => {
      if ((hash & n) !== runBit) {
        runBit = hash & n;
        lastRun = p;
      }
    });
    let low: Bin = runBit === 0 ? bin.slice(lastRun) : [];
    let high: Bin = runBit === 0 ? [] : bin.slice(lastRun);
    for (const node of bin.slice(0, lastRun)) {
      if ((node[1] & n) === 0) low = [node, ...low];
      else high = [node, ...high];
    }
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/** ACF 2023 struct iteration order for keys assigned in `keys` order (ConcurrentHashMap of upper-cased names, 16 bins, 0.75 load). */
function acfStructKeyOrder(keys: readonly string[]): string[] {
  let size = 16;
  let bins: Bin[] = Array.from({ length: size }, () => []);
  const seen = new Set<string>();
  for (const key of keys) {
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const h = javaHash(upper);
    const hash = (h ^ (h >>> 16)) & 0x7fffffff;
    (bins[hash & (size - 1)] as Bin).push([key, hash]);
    if (seen.size >= size - (size >>> 2)) {
      bins = transfer(bins, size);
      size *= 2;
    }
  }
  return bins.flat().map(([key]) => key);
}

// --- Caller, beans and their serialized values ---

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

/** A site of identity's registry. */
interface RegisteredSite {
  tenantId: string;
  siteId: string;
}

/** One resolved JSON API call: who asks, the addressed site, the mode, and how legacy reports the response. */
interface ApiCall {
  request: FastifyRequest;
  reply: FastifyReply;
  deps: LegacyApiRouteDeps;
  /** The merged, resolved request params, lower-cased names, simple values. */
  params: Record<string, string>;
  /** The url scope as the request sent it. */
  url: Struct;
  caller: Caller;
  /** REST mode is sessionless: `request.muraSessionManagement` is false (applicationSettings.cfm:179). */
  restMode: boolean;
  /** The JSON API instance's site: the request's site, else `default` (contentServer.cfc:610-648), as registered. */
  apiSite: string;
  /** `params.siteid`: the site the call addresses, as the request spells it. */
  siteId: string;
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

/** A userBean as `loadBy` leaves it: its `tusers` values and `isNew`. */
interface UserBean {
  values: GroupRecord;
  isNew: 0 | 1;
  /** The `tfiles` extension of the photo, when the load selected none; undefined for a full userDAO read. */
  photoFileExt?: string;
}

/** userBean `getEntityName()`: `group` for type 1, else `user` (userBean.cfc:799-811). */
function entityNameOf(bean: UserBean): 'group' | 'user' {
  return bean.values.type === 1 ? 'group' : 'user';
}

/** `getAllValues()` keys of a userBean, as the JSON API leaves them after its deletions (jsonApiUtility.cfc:2167-2190). */
const BEAN_VALUE_KEYS: readonly string[] = Object.freeze([
  'mobilephone', 'lname', 'email', 'contactform', 'lastupdate', 'keepprivate', 'userid', 'username', 'lastupdatebyid', 'type',
  'subtype', 'categoryid', 'fname', 'company', 'tablist', 'newfile', 'ispublic', 'imservice', 'isnew', 'jobtitle', 'website',
  'lastlogin', 'tags', 's2', 'notes', 'created', 'groupname', 'perm', 'description', 'addressid', 'imname', 'passwordcreated',
  'photofileid', 'interests', 'siteid', 'primaryaddressid', 'subscribe', 'remoteid', 'groupid', 'inactive', 'photofileext',
  'lastupdateby',
]);

/** userBean values no `tusers` column of userDAO's field list backs, at their init values (userBean.cfc:78-123). */
const BEAN_ONLY_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['categoryid', ''],
  ['newfile', ''],
  ['addressid', ''],
  ['primaryaddressid', ''],
  ['groupid', ''],
]);

/** The `tusers` columns userDAO's field list loads onto the bean (userDAO.cfc:78). */
const BEAN_COLUMNS: ReadonlySet<string> = new Set(
  BEAN_VALUE_KEYS.filter((key) => !BEAN_ONLY_DEFAULTS.has(key) && key !== 'isnew' && key !== 'photofileext'),
);

function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** `getValue(name)`: a column value (NULL as `''`), a bean-only value, or `''` for a name the bean does not hold. */
function beanValue(bean: UserBean, name: string): unknown {
  const key = name.toLowerCase();
  if (key === 'isnew') return bean.isNew;
  if (key === 'photofileext') {
    if (bean.photoFileExt !== undefined) return bean.photoFileExt;
    // userDAO joins tfiles for the photo's extension; tfiles rows are strategies-content data.
    if ((bean.values.photofileid ?? '') !== '') throw unavailable('A group photo extension is strategies-content data', 'group-photo-ext');
    return '';
  }
  const fixed = BEAN_ONLY_DEFAULTS.get(key);
  if (fixed !== undefined) return fixed;
  if (!BEAN_COLUMNS.has(key)) return '';
  const value = bean.values[key as keyof GroupRecord];
  return value === null ? '' : value;
}

/** A loaded group, or a new bean of `type` with a fresh id as `loadBy` leaves an unknown id. */
function beanOf(call: ApiCall, record: GroupRecord | null, type: 1 | 2): UserBean {
  if (record !== null) return { values: record, isNew: 0 };
  // cfobject.getBean seeds the new bean with the scope's site id (cfobject.cfc:138-149).
  const fresh = newGroupRecord(call.deps.groups.clock, cfUuid());
  return { values: { ...fresh, type, siteid: call.siteId }, isNew: 1, photoFileExt: '' };
}

/** `AllowAction` of a user or group bean: the Users module, or the caller's own record (jsonApiUtility.cfc:1809-1818). */
function allowsAction(caller: Caller, userId: string): boolean {
  return caller.usersModule || (caller.userId !== '' && cfEq(userId, caller.userId));
}

/** `getLinks(entity, editablecheck)` of a user or group bean (jsonApiUtility.cfc:3374-3440). */
function linksOf(call: ApiCall, bean: UserBean, editableCheck: boolean): Struct {
  const base = call.endpoint;
  const entity = entityNameOf(bean);
  const userId = String(beanValue(bean, 'userid'));
  const links: Struct = { entities: base };
  if (editableCheck && call.caller.loggedIn && call.caller.systemUser && allowsAction(call.caller, userId)) {
    const action = bean.values.type === 1 ? 'cusers.editgroup' : 'cusers.edituser';
    const siteId = String(beanValue(bean, 'siteid'));
    links.edit = `${call.adminPath}/?muraAction=${action}&siteid=${esapiUrlEncode(siteId)}&userid=${esapiUrlEncode(userId)}`;
  }
  links.all = `${base}/${entity}`;
  links.properties = `${base}/${entity}/properties`;
  links.self = `${base}/${entity}/${userId}`;
  links.permissions = `${base}/${entity}/${userId}/permissions`;
  return links;
}

/** How one `getFilteredValues` call picks its fields. */
interface FilterOptions {
  /** `entityConfigName`, which the output reports as `entityname`. */
  configName: string;
  editableCheck: boolean;
  /** Whether `url.fields` applies: `!expanded` or a `url.entityname` naming the entity (jsonApiUtility.cfc:2088-2095). */
  urlFields: boolean;
}

/** `getFilteredValues` of a user or group bean (jsonApiUtility.cfc:2076-2239). */
function filteredValues(call: ApiCall, bean: UserBean, opts: FilterOptions): Struct {
  let fields: string[] = [];
  const requested = textOf(valueOf(call.url, 'fields'));
  if (opts.urlFields && requested !== undefined && requested !== '') {
    fields = cfListToArray(requested);
    if (!listHasNoCase(fields, 'userid')) fields.push('userid');
    if (!listHasNoCase(fields, 'siteid')) fields.push('siteid');
  } else if (opts.configName === 'group') {
    fields = [...GROUP_CONFIG_FIELDS];
  }
  if (fields.length > 0 && !listHasNoCase(fields, 'isnew')) fields.push('isnew');
  // arrayFind compares case-sensitively.
  const allFields = fields.length === 0 || fields.includes('*') || fields.includes('all');
  const vals: Struct = {};
  if (allFields) {
    for (const key of BEAN_VALUE_KEYS) vals[key] = beanValue(bean, key);
  } else {
    for (const field of fields) {
      // The extended attribute values of a group are class-extension data identity holds no definitions for.
      if (cfEq(field, 'extendeddata')) throw unavailable('Group extended data is not readable here', 'group-extended-data');
      setIn(vals, field, beanValue(bean, cfListLast(field, '.')));
    }
    deleteIn(vals, 'password');
  }
  const id = String(beanValue(bean, 'userid'));
  setIn(vals, 'id', id);
  if (allFields || fields.includes('links')) {
    const urlId = textOf(valueOf(call.url, 'id'));
    const editable = (urlId !== undefined && cfEq(id, urlId)) || opts.editableCheck;
    setIn(vals, 'links', linksOf(call, bean, editable));
  }
  setIn(vals, 'type', bean.values.type === 1 ? 'group' : 'user');
  setIn(vals, 'entityname', opts.configName);
  return vals;
}

/** `url.ishuman` renders the CFML form-protection include into the result (jsonApiUtility.cfc:2373-2376). */
function assertNoHumanCheck(call: ApiCall): void {
  if (valueOf(call.url, 'ishuman') !== undefined) throw unavailable('The ishuman field renders a CFML display object', 'cfml-render');
}

// --- Group feeds: userFeedBean over userGateway.getAdvancedSearch [legacy: core/mura/user/userGateway.cfc:164-592] ---

type ColumnType = 'varchar' | 'numeric' | 'timestamp';

/** `tusers` columns and the param datatype `transformParamType` gives each (mssql.sql:467-505; dbUtility.cfc:1509-1541). */
const TUSERS_COLUMNS: ReadonlyMap<string, ColumnType> = new Map<string, ColumnType>([
  ...['userid', 'groupname', 'fname', 'lname', 'username', 'password', 'email', 'company', 'jobtitle', 'mobilephone', 'website',
    'subtype', 'contactform', 'lastupdateby', 'lastupdatebyid', 'siteid', 'notes', 'description', 'interests', 'photofileid',
    'imname', 'imservice', 'remoteid', 'tags', 'tablist'].map((name): [string, ColumnType] => [name, 'varchar']),
  ...['type', 'ext', 'admin', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate'].map((name): [string, ColumnType] => [name, 'numeric']),
  ...['passwordcreated', 'lastlogin', 'lastupdate', 'created'].map((name): [string, ColumnType] => [name, 'timestamp']),
]);

/** `sortOptions` of getAdvancedSearch, typo included: any other `sortBy` is an extended-attribute sort. */
const SORT_OPTIONS: readonly string[] = Object.freeze(['fname', 'lname', 'username', 'company', 'lastupdate', 'created', 'isPubic', 'email']);

/** Names findQuery never turns into a feed param (jsonApiUtility.cfc:2840). */
const QUERY_EXCLUDED: readonly string[] = Object.freeze([
  'expanddepth', 'expand', 'muraPointInTime', 'liveOnly', 'feedid', 'cacheid', '_cacheid', 'distinct', 'fields', 'entityname',
  'method', 'maxItems', 'pageIndex', 'itemsPerPage', 'sortBy', 'sortDirection', 'contentpoolid', 'shownavonly', 'showexcludesearch',
  'includehomepage', 'feedname', 'useCategoryIntersect', 'useDataNamespace',
]);

const GROUPING_NAMES: readonly string[] = Object.freeze(['openGrouping', 'orOpenGrouping', 'andOpenGrouping', 'closeGrouping']);
const AGGREGATE_NAMES: readonly string[] = Object.freeze(['sum', 'avg', 'count', 'max', 'min', 'groupBy']);

/** Feed and bean setters `addParam` calls instead of adding a param, whose effect identity cannot reproduce. */
const UNSUPPORTED_SETTERS: readonly string[] = Object.freeze([
  'params', 'advancedparams', 'configbean', 'addedobjectvalues', 'allvalues', 'errors', 'propasidcolumn', 'validations', 'value',
]);

/** One valid `queryParam`, joined to the previous one by `relationship`. */
interface FeedParam {
  relationship: 'and' | 'or';
  test: (row: GroupRecord) => boolean;
}

/** The userFeedBean state a group query builds. */
interface GroupFeed {
  /** `isPublic`: 1 by default; 0 and 1 select a user pool, any other value both. */
  isPublic: string;
  /** `inActive`, applied when numeric. */
  inactive?: number;
  type: string;
  sortBy: string;
  sortDirection: string;
  orderBy: string;
  maxItems: number;
  nextN: number;
  /** Selected columns; empty selects userDAO's whole field list. */
  fields: string[];
  params: FeedParam[];
}

function newGroupFeed(): GroupFeed {
  return { isPublic: '1', type: '1', sortBy: 'lname', sortDirection: 'asc', orderBy: '', maxItems: 0, nextN: 1000, fields: [], params: [] };
}

/** A feed or SQL failure processRequest's `catch (Any e)` answers. */
function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/** SQL Server's case-insensitive, trailing-space-insensitive text comparison under its default collation. */
function compareText(a: string, b: string): number {
  return a.replace(/ +$/, '').localeCompare(b.replace(/ +$/, ''), 'en', { sensitivity: 'accent' });
}

/** A criteria date as `lsIsDate`/`isDate` read it: ISO or US `m/d/yyyy`, with an optional time; undefined when not a date. */
function criteriaDate(text: string): Date | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  const parts = iso
    ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6], iso[7]]
    : us
      ? [us[3], us[1], us[2], us[4], us[5], us[6], undefined]
      : undefined;
  if (parts === undefined) return undefined;
  const [y, m, d, h, n, s, ms] = parts.map((part) => (part === undefined ? 0 : Number(part)));
  const date = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, h ?? 0, n ?? 0, s ?? 0, ms ?? 0);
  return date.getMonth() === (m ?? 1) - 1 && date.getDate() === d ? date : undefined;
}

/** SQL Server LIKE: `%`, `_` and `[...]` classes, case-insensitively. */
function likePattern(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) {
        source += '\\[';
        continue;
      }
      const body = pattern.slice(i + 1, end);
      const negated = body.startsWith('^');
      const members = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&');
      source += `[${negated ? '^' : ''}${members}]`;
      i = end;
    } else source += ch.replace(/[.*+?^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'is');
}

/** queryParam `setCondition` (queryParam.cfc:159-196); `''` for a name it does not know, which fails the SQL. */
function sqlCondition(condition: string, type: ColumnType): string {
  const name = condition.toLowerCase();
  if (['equals', 'eq', 'is', '='].includes(name)) return '=';
  if (['gt', '>'].includes(name)) return '>';
  if (name === 'in') return 'in';
  if (['notin', 'not in'].includes(name)) return 'not in';
  if (['neq', '!='].includes(name)) return '!=';
  if (['gte', '>='].includes(name)) return '>=';
  if (['lt', '<'].includes(name)) return '<';
  if (['lte', '<='].includes(name)) return '<=';
  if (['begins', 'beginswith', 'contains', 'containsvalue', 'like', 'ends', 'endswith'].includes(name)) return type === 'varchar' ? 'like' : '=';
  return '';
}

/** queryParam `setCriteria` (queryParam.cfc:213-305): the criteria as the SQL binds it, `null`, or undefined for criteria the column type cannot hold. */
function sqlCriteria(criteria: string, condition: string, type: ColumnType): string | number | Date | null | undefined {
  if (criteria.toLowerCase() === 'null') return null;
  if (type === 'varchar') {
    const name = condition.toLowerCase();
    if (name === 'begins' || name === 'beginswith') return `${criteria}%`;
    if (name === 'ends' || name === 'endswith') return `%${criteria}`;
    if (name === 'contains' || name === 'containsvalue' || name === 'like') return `%${criteria}%`;
    return criteria;
  }
  if (type === 'numeric') return cfIsNumeric(criteria) ? cfToNumber(criteria) : undefined;
  return criteriaDate(criteria);
}

/** Compares a stored column value with one bound criteria value under `type`. */
function compareColumn(value: string | number | Date, criteria: string | number | Date, type: ColumnType): number | undefined {
  if (type === 'numeric') {
    const left = typeof value === 'number' ? value : Number(value);
    const right = typeof criteria === 'number' ? criteria : Number(criteria);
    return Number.isNaN(left) || Number.isNaN(right) ? undefined : left - right;
  }
  if (type === 'timestamp') {
    if (!(value instanceof Date) || !(criteria instanceof Date)) return undefined;
    return value.getTime() - criteria.getTime();
  }
  return compareText(String(value), String(criteria));
}

/** One `queryParam` as getAdvancedSearch's WHERE clause tests it. */
function feedParam(column: string, type: ColumnType, condition: string, criteria: string, relationship: 'and' | 'or'): FeedParam {
  const sql = sqlCondition(condition, type);
  const bound = sqlCriteria(criteria, condition, type);
  // init's validate() marks every named param valid again, so criteria the type cannot hold binds '' and fails the SQL (queryParam.cfc:94-105,352-360).
  if (bound === undefined || sql === '') throw serverError();
  const read = (row: GroupRecord): string | number | Date | null => row[column as keyof GroupRecord] ?? null;
  if (bound === null) {
    if (sql === '=') return { relationship, test: (row) => read(row) === null };
    if (sql === '!=') return { relationship, test: (row) => read(row) !== null };
    // getCondition() returns nothing for a NULL criteria under any other condition, which fails the SQL (queryParam.cfc:198-208).
    throw serverError();
  }
  if (sql === 'like') {
    const pattern = likePattern(String(bound));
    return { relationship, test: (row) => { const value = read(row); return value !== null && pattern.test(String(value)); } };
  }
  if (sql === 'in' || sql === 'not in') {
    // cfqueryparam list="true" binds each comma-separated item.
    const items = String(bound).split(',');
    const member = (value: string | number | Date): boolean => items.some((item) => compareColumn(value, item, type) === 0);
    return {
      relationship,
      test: (row) => {
        const value = read(row);
        return value !== null && (sql === 'in' ? member(value) : !member(value));
      },
    };
  }
  const holds = (order: number): boolean =>
    sql === '=' ? order === 0 : sql === '!=' ? order !== 0 : sql === '>' ? order > 0 : sql === '>=' ? order >= 0 : sql === '<' ? order < 0 : order <= 0;
  return {
    relationship,
    test: (row) => {
      const value = read(row);
      if (value === null) return false;
      const order = compareColumn(value, bound, type);
      return order !== undefined && holds(order);
    },
  };
}

/** The params' WHERE clause: `p1 rel p2 rel p3 …` with SQL's AND-before-OR precedence. */
function matchesParams(params: readonly FeedParam[], row: GroupRecord): boolean {
  if (params.length === 0) return true;
  const groups: FeedParam[][] = [];
  params.forEach((param, i) => {
    if (i === 0 || param.relationship === 'or') groups.push([param]);
    else groups[groups.length - 1]?.push(param);
  });
  return groups.some((group) => group.every((param) => param.test(row)));
}

/** userFeedBean `setType`: a number, or `user`/`group`; anything else leaves the type. */
function feedType(current: string, value: string): string {
  if (cfIsNumeric(value)) return value;
  if (cfEq(value, 'user')) return '2';
  if (cfEq(value, 'group')) return '1';
  return current;
}

/** `setFeedProps(feed, params)` as a user feed reads it (jsonApiUtility.cfc:2973-3157). */
function applyFeedProps(feed: GroupFeed, params: Readonly<Struct>): void {
  let sort = '';
  const orderBy = textOf(valueOf(params, 'orderby'));
  if (orderBy) sort = orderBy;
  const sortParam = textOf(valueOf(params, 'sort'));
  if (sortParam) sort = sortParam;
  if (sort !== '') {
    feed.orderBy = cfListToArray(sort)
      .map((item) => {
        if (item.length <= 1) return item;
        const prefix = item.charAt(0);
        const signed = prefix === '+' || prefix === '-';
        let prop = signed ? item.slice(1) : item;
        if (cfListToArray(prop, '.').length === 1) prop = `tusers.${prop}`;
        return `${prop} ${prefix === '-' ? 'desc' : 'asc'}`;
      })
      .join(',');
  }
  const sortDirection = textOf(valueOf(params, 'sortdirection'));
  if (sortDirection && listHasNoCase(['desc', 'asc'], sortDirection)) feed.sortDirection = sortDirection;
  const sortBy = textOf(valueOf(params, 'sortby'));
  if (sortBy) feed.sortBy = sortBy.trim();
  const type = textOf(valueOf(params, 'type'));
  if (type) feed.type = feedType(feed.type, type);
  const distinct = valueOf(params, 'distinct');
  // A distinct feed iterates generic beans instead of users (userFeedBean.cfc:168-176).
  if (cfIsBoolean(distinct) && cfToBoolean(distinct)) throw unavailable('A distinct group feed iterates generic beans', 'group-feed-distinct');
  const fields = textOf(valueOf(params, 'fields'));
  if (fields) {
    const listed = cfListToArray(fields);
    if (!listHasNoCase(listed, 'userid')) listed.push('userid');
    // setFields keeps only names the tusers metadata holds (beanFeed.cfc:201-213).
    feed.fields = listed.map((name) => name.trim().toLowerCase()).filter((name) => TUSERS_COLUMNS.has(name));
  }
  const maxItems = valueOf(params, 'maxitems');
  if (cfIsNumeric(maxItems)) feed.maxItems = cfToNumber(maxItems);
  else if (maxItems === '*') feed.maxItems = 0;
  for (const name of ['size', 'limit']) {
    const value = valueOf(params, name);
    if (cfIsNumeric(value)) feed.maxItems = cfToNumber(value);
  }
}

/** `utility.validateSort`: `field direction` items, else `Masa.InvalidSortBy`/`InvalidSortDirection` (utility.cfc:1134-1240). */
function validatedSort(sort: string): Array<{ field: string; desc: boolean }> {
  return cfListToArray(sort).map((raw) => {
    const parts = cfListToArray(raw.trim().replace(/\s+/g, ' '), ' ');
    const direction = parts.length >= 2 ? (parts.at(-1) ?? '') : 'asc';
    const field = parts.length >= 2 ? parts.slice(0, -1).join(' ') : (parts[0] ?? '');
    if (!/^[a-zA-Z0-9_.]+$/.test(field.trim())) throw serverError();
    const normalized = direction.trim().toLowerCase();
    if (normalized !== 'asc' && normalized !== 'desc') throw serverError();
    return { field: field.trim(), desc: normalized === 'desc' };
  });
}

interface SortKey {
  column: string;
  type: ColumnType;
  desc: boolean;
}

/** The ORDER BY getAdvancedSearch builds; an extended-attribute `sortBy` orders by a value groups never hold. */
function sortKeysOf(feed: GroupFeed): SortKey[] {
  if (feed.orderBy.trim() !== '') {
    return validatedSort(feed.orderBy).map(({ field, desc }) => {
      const column = field.toLowerCase().startsWith('tusers.') ? field.slice(7).toLowerCase() : field.toLowerCase();
      const type = TUSERS_COLUMNS.get(column);
      if (type !== undefined && !column.includes('.')) return { column, type, desc };
      // Another table's column is a joined table's data (tfiles is strategies-content's); an unknown tusers name fails the SQL.
      if (column.includes('.')) throw unavailable(`Ordering groups by ${field} reads another table`, 'group-feed-join');
      throw serverError();
    });
  }
  if (!listHasNoCase(SORT_OPTIONS, feed.sortBy)) {
    // The extended sort joins tclassextenddatauseractivity values no group row carries; only the direction is validated.
    validatedSort(`x ${feed.sortDirection}`);
    return [];
  }
  const [{ field, desc }] = validatedSort(`${feed.sortBy} ${feed.sortDirection}`) as [{ field: string; desc: boolean }];
  const type = TUSERS_COLUMNS.get(field.toLowerCase());
  if (type === undefined) throw serverError();
  return [{ column: field.toLowerCase(), type, desc }];
}

/** SQL Server ORDER BY of one column: NULLs first ascending, last descending. */
function compareRows(keys: readonly SortKey[], a: GroupRecord, b: GroupRecord): number {
  for (const { column, type, desc } of keys) {
    const left = a[column as keyof GroupRecord] ?? null;
    const right = b[column as keyof GroupRecord] ?? null;
    let order = 0;
    if (left === null || right === null) order = left === right ? 0 : left === null ? -1 : 1;
    else order = compareColumn(left, right, type) ?? 0;
    if (order !== 0) return desc ? -order : order;
  }
  return 0;
}

/** The groups a feed selects in its order, before TOP: type 1 in the site's user pool(s), its params, S2 and inactive filters. */
async function feedRows(call: ApiCall, feed: GroupFeed, extra?: (row: GroupRecord) => boolean): Promise<GroupRecord[]> {
  // A type other than 1 queries users, whose person columns are people data.
  if (!cfEq(feed.type, '1')) throw unavailable('A user feed reads people data', 'user-feed');
  const visibility = cfIsNumeric(feed.isPublic) ? cfToNumber(feed.isPublic) : undefined;
  const flags = visibility === undefined ? [0, 1] : visibility === 0 || visibility === 1 ? [visibility] : [];
  const rows = new Map<string, GroupRecord>();
  for (const isPublic of flags) {
    for (const { counter: _counter, ...row } of await listGroups(call.deps.groups, { siteId: call.siteId, isPublic })) {
      if (!rows.has(row.userid)) rows.set(row.userid, row);
    }
  }
  const keys = sortKeysOf(feed);
  return [...rows.values()]
    .filter((row) => call.caller.superUser || row.s2 === 0)
    .filter((row) => feed.inactive === undefined || row.inactive === feed.inactive)
    .filter((row) => matchesParams(feed.params, row) && (extra === undefined || extra(row)))
    // The clustered key order SQL Server returns ties in.
    .sort((a, b) => (a.userid < b.userid ? -1 : a.userid > b.userid ? 1 : 0))
    .sort((a, b) => compareRows(keys, a, b));
}

/** The `TOP maxItems` of the selected rows; MSSQL refuses a negative or fractional TOP. */
function topRows(feed: GroupFeed, rows: GroupRecord[]): GroupRecord[] {
  if (feed.maxItems === 0) return rows;
  if (!Number.isInteger(feed.maxItems) || feed.maxItems < 0) throw serverError();
  return rows.slice(0, feed.maxItems);
}

/** A feed row as the iterator's bean: the selected columns over a new bean's values, `isNew` 1 as userIterator leaves it. */
function rowBean(call: ApiCall, row: GroupRecord, feed: GroupFeed): UserBean {
  if (feed.fields.length === 0) return { values: row, isNew: 1 };
  const values: GroupRecord = { ...newGroupRecord(call.deps.groups.clock, ''), type: 2, siteid: '' };
  const target = values as unknown as Record<string, unknown>;
  for (const column of feed.fields) target[column] = row[column as keyof GroupRecord];
  return { values, isNew: 1, photoFileExt: '' };
}

/** The page the iterator yields: `setQuery`, then `setIteratorProps` (jsonApiUtility.cfc:3160-3182; queryIterator.cfc). */
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

/** `packageIteratorArray` of a group iterator (jsonApiUtility.cfc:287-366). */
function packagePage(call: ApiCall, page: IteratorPage, items: Struct[], baseUrl: string): Struct {
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
  result.entityname = 'group';
  const index = count > 0 ? pageIndex : 0;
  const nextIndex = index < totalPages ? index + 1 : 1;
  const prevIndex = index > 1 ? index - 1 : totalPages;
  const links: Struct = {
    self: `${baseUrl}&pageIndex=${index}`,
    entities: call.endpoint,
    properties: `${call.endpoint}/group/properties`,
    permissions: `${call.endpoint}/group/permissions`,
  };
  if (index > 1) {
    links.first = `${baseUrl}&pageIndex=1`;
    links.previous = `${baseUrl}&pageIndex=${prevIndex}`;
  }
  if (totalPages > 1) links.last = `${baseUrl}&pageIndex=${totalPages}`;
  if (index < totalPages) links.next = `${baseUrl}&pageIndex=${nextIndex}`;
  result.links = links;
  return result;
}

/** Whether a direct call's resolution set param `key` after `structAppend(form, params)`: no request scope or `X-` header carries it (jsonApiUtility.cfc:845-891). */
function setAfterFormCopy(call: ApiCall, key: string): boolean {
  if (!call.direct || requestParam(call.request, key) !== undefined) return false;
  const { headers } = call.request;
  return headerValue(headers, `x-${key}`) === undefined && headerValue(headers, `x-${key.replace(/_/g, '-')}`) === undefined;
}

/** packageIteratorArray's own base URL: url then form values, `pageIndex` left out, `method` reported as the operation. */
function scopeBaseUrl(call: ApiCall, operation: string): string {
  const merged: Struct = {};
  const order: string[] = [];
  const put = (key: string, value: unknown): void => {
    const existing = keyOf(merged, key);
    if (existing === undefined) order.push(key);
    merged[existing ?? key] = value;
  };
  for (const [key, value] of Object.entries(call.url)) put(key, textOf(value) ?? '');
  if (keyOf(call.url, 'entityname') === undefined) put('entityname', 'group');
  // structAppend(form, params) left the resolved params in the form scope; a direct call set its path method, default siteid and path pairs later.
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

/** `beanFeed.addParam` of a group feed: a feed setter, or a `tusers` column param (beanFeed.cfc:301-345). */
function addFeedParam(feed: GroupFeed, rawField: string, criteria: string, condition: string, relationship: 'and' | 'or'): void {
  const field = rawField.replace(/[^0-9A-Za-z._,\-*]/g, '');
  const name = field.toLowerCase();
  if (isValidVariableName(field)) {
    switch (name) {
      case 'ispublic':
        feed.isPublic = criteria;
        return;
      case 'inactive':
        if (cfIsNumeric(criteria)) feed.inactive = cfToNumber(criteria);
        return;
      case 'type':
        feed.type = feedType(feed.type, criteria);
        return;
      case 'nextn':
        if (cfIsNumeric(criteria)) feed.nextN = cfToNumber(criteria);
        return;
      case 'orderby':
        feed.orderBy = criteria;
        return;
      case 'lastupdateby':
        // bean.setlastUpdateBy sets the feed's own value; no param is added.
        return;
      case 'groupid':
      case 'categoryid':
        // Membership and interest subqueries read rows this layer has no reader for.
        if (criteria.trim() !== '') throw unavailable(`A group feed filtered by ${field} is not readable here`, 'group-feed-subquery');
        return;
      default:
        if (UNSUPPORTED_SETTERS.includes(name)) throw unavailable(`The feed setter ${field} is not reproduced`, 'group-feed-setter');
    }
  }
  // The `tag` alias joins tuserstags (userFeedBean.cfc:102).
  if (name === 'tag') throw unavailable('A group feed joined to tuserstags is not readable here', 'group-feed-join');
  const parts = field.split('.');
  let column = name;
  if (parts.length > 1) {
    if (parts.length !== 2 || (parts[0] ?? '').toLowerCase() !== 'tusers') {
      throw unavailable(`A group feed param on ${field} joins another table`, 'group-feed-join');
    }
    column = (parts[1] ?? '').toLowerCase();
    if (!TUSERS_COLUMNS.has(column)) throw serverError();
  } else if (!TUSERS_COLUMNS.has(column)) {
    // A name no column holds is an extended-attribute subquery over tclassextenddatauseractivity.
    if (field === '') return;
    throw unavailable(`A group feed filtered by the extended attribute ${field} is not readable here`, 'group-feed-extended');
  }
  // getAdvancedSearch never applies a tusers.siteid param; the feed's own site selects the pool.
  if (column === 'siteid') return;
  feed.params.push(feedParam(column, TUSERS_COLUMNS.get(column) as ColumnType, condition, criteria, relationship));
}

/** findQuery's feed and base URL, built from `cgi.QUERY_STRING` in order (jsonApiUtility.cfc:2712-2905). */
function queryFeed(call: ApiCall): { feed: GroupFeed; baseUrl: string } {
  const feed = newGroupFeed();
  const url = call.url;
  let baseUrl = `${call.endpoint}/group/?`;
  let started = false;
  let relationship: 'and' | 'or' = 'and';
  let advancedSort = '';
  const names = cfListToArray(queryStringOf(call.request), '&')
    .map((item) => cfUrlDecode(cfListFirst(item, '=')))
    .filter((name) => name.toLowerCase() !== 'pageindex');
  for (const name of names) {
    // Bracketed names delete the indexed arguments and filter by their base name (jsonApiUtility.cfc:2858-2864).
    if (name.includes('[')) throw unavailable(`The bracketed query param ${name} is not reproduced`, 'group-feed-bracket');
    // changesetid calls the content-only setActiveOnly on a user feed.
    if (cfEq(name, 'changesetid')) throw unavailable('A changeset filter on a group feed is not reproduced', 'group-feed-changeset');
    const key = keyOf(url, name);
    if (key === undefined) continue;
    const value = textOf(url[key]) ?? '';
    baseUrl += `${started ? '&' : ''}${esapiUrlEncode(name)}`;
    started = true;
    if (value !== '') baseUrl += `=${esapiUrlEncode(value)}`;
    if (listHasNoCase(QUERY_EXCLUDED, name)) continue;
    if (cfEq(name, 'sort')) {
      advancedSort = advancedSort === '' ? value : `${advancedSort},${value}`;
    } else if (cfEq(name, 'or')) {
      relationship = 'or';
    } else if (listHasNoCase(GROUPING_NAMES, name)) {
      // A grouping param has no field, so getAdvancedSearch skips it as invalid.
      relationship = 'and';
    } else if (listHasNoCase(AGGREGATE_NAMES, name) || cfEq(name, 'innerJoin') || cfEq(name, 'leftJoin')) {
      throw unavailable(`The ${name} feed clause is not reproduced`, 'group-feed-aggregate');
    } else {
      let condition = 'eq';
      let criteria = value;
      const pieces = cfListToArray(criteria, '^');
      if (pieces.length > 1) {
        condition = pieces[0] ?? '';
        criteria = pieces[1] ?? '';
      } else if (criteria.includes('*')) {
        condition = 'like';
        criteria = criteria.replace(/\*/g, '%');
      }
      addFeedParam(feed, cfEq(name, 'id') ? 'userid' : name, criteria, condition, relationship);
      relationship = 'and';
    }
  }
  const props: Struct = { ...url };
  if (advancedSort !== '') setIn(props, 'sort', advancedSort);
  applyFeedProps(feed, props);
  return { feed, baseUrl };
}

/** `url.entityname` defaults to the entity before a find reads it, which turns `url.fields` on (jsonApiUtility.cfc:2296-2298). */
function defaultUrlEntity(call: ApiCall): void {
  if (keyOf(call.url, 'entityname') === undefined) call.url.entityname = 'group';
}

function requireUsersModule(call: ApiCall): void {
  if (!call.caller.usersModule) throw new LegacyApiError('authorization');
}

/** setIteratorProps reads an undefined `feed` for a numeric `offset`, whatever the feed selected (jsonApiUtility.cfc:3177-3179). */
function rejectOffset(call: ApiCall): void {
  if (cfIsNumeric(valueOf(call.url, 'offset'))) throw serverError();
}

/** The items of one iterator page, as getFilteredValues serializes each row. */
function pageItems(call: ApiCall, rows: readonly GroupRecord[], feed: GroupFeed, page: IteratorPage): Struct[] {
  return page.positions.map((position) =>
    filteredValues(call, rowBean(call, rows[position] as GroupRecord, feed), { configName: 'group', editableCheck: false, urlFields: true }),
  );
}

/** findAll(entityName='group') (jsonApiUtility.cfc:2542-2623). */
async function findAll(call: ApiCall): Promise<Struct> {
  defaultUrlEntity(call);
  requireUsersModule(call);
  rejectOffset(call);
  const countOnly = valueOf(call.url, 'countonly');
  // userFeedBean.getAvailableCount reads a `count` column its user query never selects (userFeedBean.cfc:240-242).
  if (cfIsBoolean(countOnly) && cfToBoolean(countOnly)) throw serverError();
  const feed = newGroupFeed();
  applyFeedProps(feed, call.url);
  const rows = topRows(feed, await feedRows(call, feed));
  const page = iteratorPage(rows.length, feed.nextN, call.url);
  return packagePage(call, page, pageItems(call, rows, feed, page), scopeBaseUrl(call, 'findall'));
}

/** findQuery(entityName='group') (jsonApiUtility.cfc:2712-2920). */
async function findQuery(call: ApiCall): Promise<Struct> {
  defaultUrlEntity(call);
  requireUsersModule(call);
  rejectOffset(call);
  const { feed, baseUrl } = queryFeed(call);
  const rows = topRows(feed, await feedRows(call, feed));
  const page = iteratorPage(rows.length, feed.nextN, call.url);
  return packagePage(call, page, pageItems(call, rows, feed, page), baseUrl);
}

/** findMany(entityName='group', ids): the listed ids in list order unless sorted (jsonApiUtility.cfc:2625-2710). */
async function findMany(call: ApiCall): Promise<Struct> {
  defaultUrlEntity(call);
  requireUsersModule(call);
  rejectOffset(call);
  // The entity route copies params.id into ids (jsonApiUtility.cfc:1259-1262).
  const ids = call.direct ? call.params.ids : call.params.id;
  // An undefined `ids` argument fails the addParam call.
  if (ids === undefined) throw serverError();
  const feed = newGroupFeed();
  feed.params.push(feedParam('userid', 'varchar', 'in', ids, 'and'));
  applyFeedProps(feed, call.url);
  const rows = topRows(feed, await feedRows(call, feed));
  const page = iteratorPage(rows.length, feed.nextN, call.url);
  const items = pageItems(call, rows, feed, page);
  const sort = textOf(valueOf(call.url, 'sort'));
  const ordered =
    sort !== undefined && sort !== ''
      ? items
      : cfListToArray(ids).flatMap((id) => {
          const match = items.find((item) => cfEq(String(valueOf(item, 'id')), id));
          return match === undefined ? [] : [match];
        });
  return packagePage(call, page, ordered, scopeBaseUrl(call, 'findmany'));
}

// --- Single-entity group operations ---

/** userBean property metadata the group entity reports, in `getProperties()` order (jsonApiUtility.cfc:1548-1622; oracle output). */
const GROUP_PROPERTIES: ReadonlyMap<string, Readonly<Struct>> = new Map<string, Readonly<Struct>>(
  (
    [
      ['userid', 'id', '35', 'char', ''],
      ['type', '', undefined, 'int', '2'],
      ['subtype', '', '50', 'varchar', 'Default'],
      ['ispublic', '', undefined, 'int', '1'],
      ['groupname', '', '50', 'varchar', ''],
      ['siteid', '', '50', 'varchar', ''],
      ['remoteid', '', '50', 'varchar', ''],
    ] as const
  ).map(([name, fieldtype, length, datatype, defaultValue]): [string, Struct] => [
    name,
    {
      fieldtype,
      ...(length === undefined ? {} : { length }),
      required: false,
      html: 'false',
      nullable: true,
      name,
      datatype,
      default: defaultValue,
    },
  ]),
);

/** Whether `id` names a stored user account in any registered tenant, as userDAO.read finds any `tusers` row by id. */
async function namesStoredUser(call: ApiCall, id: string): Promise<boolean> {
  const { db, repo } = call.deps.groups;
  for (const { tenantId } of await registeredTenants(db)) {
    const account = await withTenant(db, tenantId, (tx) => repo.findAccountById(tx, id, { includePending: true }));
    if (account !== null) return true;
  }
  return false;
}

/** `loadBy(userid=id)`: the stored group, or null for an unknown id; a user record's person columns are people data. */
async function loadGroup(call: ApiCall, id: string): Promise<GroupRecord | null> {
  if (id === '') return null;
  const located = await findGroupForSite(call.deps.groups, { groupId: id, siteId: call.siteId });
  if (located !== null) return located.group;
  if (isCfUuid(id) && (await namesStoredUser(call, id))) {
    throw unavailable(`JSON API group ${id} names a user, whose values are people data`, 'group-api-user-record');
  }
  return null;
}

/** findOne(entityName='group') (jsonApiUtility.cfc:2292-2382). */
async function findOne(call: ApiCall): Promise<Struct> {
  defaultUrlEntity(call);
  const id = call.params.id;
  // A direct call without an id reads an undefined argument.
  if (id === undefined) throw serverError();
  // `$.getBean('group')` is a type 2 userBean until a row loads.
  const bean = beanOf(call, await loadGroup(call, id), 2);
  requireUsersModule(call);
  assertNoHumanCheck(call);
  return filteredValues(call, bean, { configName: 'group', editableCheck: true, urlFields: true });
}

/** Whether `url.entityname` names the group entity, which turns `url.fields` on for an expanded read. */
function urlNamesGroup(call: ApiCall): boolean {
  const named = textOf(valueOf(call.url, 'entityname'));
  return named !== undefined && named !== '' && cfEq(named, 'group');
}

/** findNew(entityName='group'): a new type 1 bean under a fresh id (jsonApiUtility.cfc:2384-2422). */
function findNew(call: ApiCall): Struct {
  const bean = beanOf(call, null, 1);
  requireUsersModule(call);
  assertNoHumanCheck(call);
  return filteredValues(call, bean, { configName: 'group', editableCheck: true, urlFields: urlNamesGroup(call) });
}

/** findPermissions(entityName='group'): `bean.getPermissions()` of the loaded or new bean (jsonApiUtility.cfc:2240-2266; bean.cfc:1499-1521). */
function findPermissions(call: ApiCall): Struct {
  const { id } = call.params;
  // A direct call without an id reads an undefined argument.
  if (id === undefined) throw serverError();
  const loads = isCfUuid(id) || id.length === 35;
  // An unloaded bean's lazily created id is never the caller's.
  const own = loads && call.caller.userId !== '' && cfEq(id, call.caller.userId);
  const write = call.caller.usersModule || own;
  return { read: call.caller.usersModule, delete: write, save: write };
}

/** findProperties(entityname='group', properties) (jsonApiUtility.cfc:1548-1622). */
function findProperties(call: ApiCall): Struct {
  const listed = cfListToArray(call.params.properties ?? '');
  const names = listed.length > 0 ? listed.map((name) => name.toLowerCase()) : [...GROUP_PROPERTIES.keys()];
  const properties: Struct[] = [];
  for (const name of names) {
    if (!listHasNoCase(GROUP_CONFIG_FIELDS, name)) continue;
    const property = GROUP_PROPERTIES.get(name);
    // props[p] of a configured field with no property (`links`) raises.
    if (property === undefined) throw serverError();
    properties.push({ ...property });
  }
  const base = call.endpoint;
  const result: Struct = {
    properties,
    entityname: 'group',
    bundleable: false,
    orderby: '',
    historical: false,
    dynamic: false,
    scaffold: false,
    displayname: 'group',
    primarykey: 'userid',
    public: false,
    links: {
      entities: base,
      endpoint: `${base}/group`,
      swagger_json: `${base}/swagger?mode=json&entities=group`,
      swagger_rest: `${base}/swagger?mode=rest&entities=group`,
      self: `${base}/group/properties`,
    },
  };
  if (call.caller.adminUser || call.caller.superUser) result.table = 'tusers';
  return result;
}

/** The acting session user of a write, from its login snapshot; a session that is gone or signed out has no actor. */
async function actorOf(call: ApiCall): Promise<GroupActor> {
  const { user } = call.caller;
  const row = user === undefined || user.sid === '' ? undefined : (await locateSession(call.deps.sessions, user.sid))?.row;
  if (user === undefined || row === undefined || row.state !== 'active' || row.user_id === null || row.login_snapshot === null) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  const snapshot = JSON.parse(row.login_snapshot) as { fname: string | null; lname: string | null; roleList: string };
  return { userId: user.sub, fname: snapshot.fname, lname: snapshot.lname, isSuperUser: snapshotIsS2(snapshot) };
}

/** userBean `setType`: a number as is, `group` as 1, any other text as 2 (userBean.cfc:753-765). */
function beanTypeOf(value: string): string {
  if (cfIsNumeric(value)) return value;
  return cfEq(value, 'group') ? '1' : '2';
}

/** save(entityName='group') of a group without a photo or extended data (jsonApiUtility.cfc:1903-2074). */
async function save(call: ApiCall): Promise<Struct> {
  const { request, params, caller } = call;
  const csrfContext = params.id ?? 'new';
  const vals: Struct = { ...params };
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

  let id = csrfContext;
  if (postedId !== undefined && postedId !== '' && (isCfUuid(postedId) || postedId === LEGACY_ADMIN_SENTINEL_ID)) id = postedId;
  if (cfEq(id, 'new')) {
    id = cfUuid();
    setIn(vals, 'id', id);
  }
  setIn(vals, 'userid', id);
  if (!call.restMode && !(await validateCsrfForRoute({ csrf: call.deps.csrf }, request, csrfContext))) {
    throw new LegacyApiError('invalidTokens');
  }
  const record = await loadGroup(call, id);
  const postedType = textOf(valueOf(vals, 'type'));
  const type = postedType === undefined ? String(record?.type ?? 2) : beanTypeOf(postedType.trim());
  // Saving a type 2 bean creates or rewrites a user, whose person columns are people data.
  if (!cfEq(type, '1')) throw unavailable(`A JSON API group save of ${id} writes a user record`, 'group-save-user');
  if (!allowsAction(caller, id)) throw new LegacyApiError('authorization');
  const actor = await actorOf(call);
  let input: GroupSaveInput;
  try {
    input = groupSaveInputFrom(vals);
  } catch (err) {
    if (err instanceof TypeError) throw new LegacyApiError('invalidParameters');
    throw err;
  }
  const result = record === null ? await createGroup(call.deps.groups, actor, input) : await updateGroup(call.deps.groups, actor, input);
  const bean: UserBean = { values: result.group, isNew: record === null && !result.written ? 1 : 0 };
  const values = filteredValues(call, bean, { configName: 'group', editableCheck: false, urlFields: urlNamesGroup(call) });
  // The bean's saveErrors is the posted value set() copied, else its init value.
  setIn(values, 'saveErrors', valueOf(params, 'saveerrors') ?? false);
  setIn(values, 'errors', result.errors);
  return values;
}

/** `urlDecode`, then `deserializeJSON` of a JSON text argument; `invalidParameters` when it is not JSON. */
function jsonArgument(text: string): unknown {
  try {
    return JSON.parse(cfUrlDecode(text));
  } catch {
    throw new LegacyApiError('invalidParameters');
  }
}

/** validate(data, validations) as a `group.validate` call reaches it (jsonApiUtility.cfc:3703-3808). */
async function validate(call: ApiCall): Promise<Struct> {
  const data = jsonArgument(call.params.data ?? '{}');
  const validations = jsonArgument(call.params.validations ?? '{}');
  if (!isRecord(data) || !isRecord(validations)) return { invalid: 'Invalid validation request' };
  const entityName = textOf(valueOf(data, 'entityname'));
  if (entityName !== undefined && !cfEq(entityName, 'bean')) {
    // Only the user and group entities are identity's; validating a user reads person columns.
    if (!cfEq(entityName, 'group') && !cfEq(entityName, 'user')) {
      throw unavailable(`Validating a ${entityName} entity belongs to its owner`, 'validate-entity');
    }
    requireUsersModule(call);
    const id = textOf(valueOf(data, 'userid')) ?? '';
    const record = await loadGroup(call, id);
    // A new bean is type 2, whose username and email rules are people's (userBean.cfc:470-485).
    if (record === null) throw unavailable('Validating a new user bean reads person rules', 'validate-user');
    // A group has no username or email rules, and identity holds no class-extension definitions for it.
    return {};
  }
  if (Object.keys(validations).length > 0) throw unavailable('Ad hoc validation rules are not reproduced', 'validate-rules');
  const bean = textOf(valueOf(data, 'bean'));
  if (bean !== undefined && valueOf(data, 'loadby') !== undefined && !cfEq(bean, 'bean')) {
    throw unavailable('A loadby validation reads the named entity', 'validate-loadby');
  }
  return {};
}

// --- Named methods ---

/** loginManager `logout()` deletes the remember-me cookies (loginManager.cfc:507-508). */
const REMEMBER_ME_COOKIES: readonly string[] = Object.freeze(['userHash', 'userid']);

/** A direct method argument CFML reads as `arguments.<name>`; undefined raises `Element … is undefined in ARGUMENTS`. */
function requiredArgument(call: ApiCall, name: string): string {
  const value = call.params[name];
  if (value === undefined) throw serverError();
  return value;
}

/** login(username, password, siteid): the CSRF check under context `login`, then the session's credential login (jsonApiUtility.cfc:1856-1870). */
async function loginMethod(call: ApiCall): Promise<Struct> {
  if (!(await validateCsrfForRoute({ csrf: call.deps.csrf }, call.request, 'login'))) {
    // Legacy's own misspelling.
    return { status: 'Invalid CSFR Tokens' };
  }
  const lockdown = call.params.lockdowncheck;
  // A lockdown check sets the passedLockdown session flag or cookie instead of logging in (userUtility.cfc:207-221).
  if (lockdown !== undefined && !(cfIsBoolean(lockdown) && !cfToBoolean(lockdown))) {
    throw unavailable('A JSON API lockdown login is not reproduced', 'login-lockdown');
  }
  // A valid token implies the caller's session; its id is kept across the login, as legacy keeps it.
  const result = await login(call.deps.login, {
    username: call.params.username ?? '',
    password: call.params.password ?? '',
    siteId: call.siteId,
    sessionId: call.caller.user?.sid ?? '',
    mode: 'target-primary',
  });
  return { status: result.ok ? 'success' : 'failed' };
}

/** logout(): the session ends and its epoch change ends the legacy session too (jsonApiUtility.cfc:1872-1875). */
async function logoutMethod(call: ApiCall): Promise<Struct> {
  const sessionId = call.caller.user?.sid;
  if (sessionId) await logout(call.deps.login, sessionId);
  const now = call.deps.sessions.clock.now();
  call.reply.header('set-cookie', REMEMBER_ME_COOKIES.map((name) => deleteCookieLegacy(name, {}, now)));
  return { status: 'success' };
}

/** generateCSRFTokens(siteid, context): one token under the session's secret (jsonApiUtility.cfc:4111-4115). */
async function generateTokensMethod(call: ApiCall): Promise<Struct> {
  const context = requiredArgument(call, 'context');
  const sessionId = call.caller.user?.sid;
  const located = sessionId ? await locateSession(call.deps.sessions, sessionId) : undefined;
  if (located === undefined || located.row.state !== 'active') throw AuthDenial.unauthenticated('invalid-credential');
  const tokens = issueTokens({ csrfSecret: located.row.csrf_secret }, { context, clock: call.deps.csrf.clock });
  return { csrf_token: tokens.token, csrf_token_expires: tokens.expires };
}

/** Integer hints for every key holding a number, so values another service serialized keep their JSON types. */
function numberHints(value: unknown, hints: Map<string, ApiKeyHint> = new Map()): ApiKeyHint[] {
  if (Array.isArray(value)) {
    for (const item of value) numberHints(item, hints);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number') hints.set(key.toLowerCase(), { key, hint: Number.isInteger(item) ? 'integer' : 'float' });
      else numberHints(item, hints);
    }
  }
  return [...hints.values()];
}

/** The API family segment of the request path: `json`, `ajax` or `rest`. */
function familyOf(request: FastifyRequest): string {
  return /\/_api\/(json|ajax|rest)\/v1/i.exec(pathOf(request))?.[1]?.toLowerCase() ?? 'json';
}

/** findCurrentUser(): people's JSON API `user` findOne of the session user, read with the caller's token, plus the session's role lists (jsonApiUtility.cfc:2268-2290). */
async function findCurrentUserMethod(call: ApiCall): Promise<SerializedLegacyResponse> {
  const { caller } = call;
  const query: Record<string, string> = {};
  for (const name of ['fields', 'expand', 'expanddepth']) {
    const value = textOf(valueOf(call.url, name));
    if (value !== undefined) query[name] = value;
  }
  const site = encodeURIComponent(call.siteId);
  const target = caller.userId === '' ? 'new' : encodeURIComponent(caller.userId);
  const response = await call.deps.client.request<unknown>({
    service: 'people',
    method: 'GET',
    path: `/_api/${familyOf(call.request)}/v1/${site}/user/${target}`,
    query,
  });
  const body = response.body;
  if (response.status === 503) throw unavailable('People answered the current user read with 503', 'people-unavailable');
  if (!isRecord(body)) throw new Error(`People answered the current user read with a ${response.status} non-envelope body`);
  const method = call.method ?? 'findCurrentUser';
  const error = valueOf(body, 'error');
  if (response.status !== 200 || error !== undefined) {
    if (!isRecord(error)) throw new Error(`People answered the current user read with ${response.status} and no error`);
    const answer = serializeResponse(buildEnvelope({ method, params: paramsWithoutMethod(call.params), error }), {
      statusCode: response.status,
    });
    const challenge = response.headers['www-authenticate'];
    if (typeof challenge === 'string') answer.headers['WWW-Authenticate'] = challenge;
    return answer;
  }
  const data = valueOf(body, 'data');
  if (!isRecord(data)) throw new Error('People answered the current user read without a data struct');
  const snapshot = caller.user === undefined || caller.user.sid === '' ? undefined : await sessionSnapshot(call.deps.sessions, caller.user.sid);
  const user: Struct = { ...data };
  setIn(user, 'memberships', snapshot === undefined ? [] : cfListToArray(snapshot.user.memberships));
  setIn(user, 'membershipids', snapshot === undefined ? [] : cfListToArray(snapshot.user.membershipids));
  setIn(user, 'isloggedin', snapshot === undefined ? false : snapshot.user.isLoggedIn);
  return serializeResponse(buildEnvelope({ method, params: paramsWithoutMethod(call.params), data: user }), {
    useDataNamespace: call.params.usedatanamespace,
    serializer: createApiSerializer(numberHints(data)),
  });
}

/** validateEmail(email): BriteVerify's `filecontent` as a JSON string, sent as is, with the empty `mmpBrightVerifyAPIKey` identity holds (jsonApiUtility.cfc:1831-1854). */
async function validateEmailMethod(call: ApiCall): Promise<SerializedLegacyResponse> {
  const email = requiredArgument(call, 'email');
  const fetcher = call.deps.fetch ?? globalThis.fetch;
  let fileContent: string;
  try {
    // cfhttp interpolates the values unencoded.
    const answer = await fetcher(`https://bpi.briteverify.com/emails.json?address=${email}&apikey=`, { method: 'GET' });
    fileContent = await answer.text();
  } catch {
    // ACF reports an unreachable host through `filecontent`, not an exception.
    fileContent = 'Connection Failure';
  }
  const body = createApiSerializer().serialize(fileContent);
  return { status: 200, headers: { 'Content-Type': LEGACY_JSON_CONTENT_TYPE }, body };
}

/** The REST credential block's own answer for `oauth`, `oauth2` and `tokeninfo` (jsonApiUtility.cfc:422-835). */
async function oauthAnswer(call: ApiCall, headers: FastifyRequest['headers']): Promise<SerializedLegacyResponse> {
  const flat: Record<string, string | undefined> = {};
  for (const name of Object.keys(headers)) flat[name] = headerValue(headers, name);
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(scopeOf(call.request.query, true))) query[name] = Array.isArray(value) ? value.join(',') : value;
  const input: RestAuthInput = {
    path: pathOf(call.request).replace(/^\/index\.cfm(?=\/|$)/i, ''),
    httpMethod: call.request.method,
    headers: flat,
    query,
    params: legacyParamsOf(call.request),
    siteId: call.apiSite,
  };
  const outcome = await authenticateRestRequest(call.deps.rest, input);
  // The route key names these paths only when the credential block answers itself, so a continued session is unreachable.
  if (outcome.kind !== 'response') throw new Error(`REST credential block continued on ${input.path}`);
  return { status: outcome.status, headers: outcome.headers, body: outcome.body };
}

// --- Dispatch ---

/** A direct method's or an entity-route operation's result in the legacy envelope (jsonApiUtility.cfc:893-896, 1309-1314). */
function envelopeAnswer(call: ApiCall, data: unknown): SerializedLegacyResponse {
  return serializeResponse(buildEnvelope({ method: call.method ?? 'undefined', params: paramsWithoutMethod(call.params), data }), {
    useDataNamespace: call.params.usedatanamespace,
    serializer: groupSerializer(),
  });
}

/** One of the methods identity serves, invoked by name (jsonApiUtility.cfc:869-900). */
async function namedAnswer(call: ApiCall, name: NamedMethod): Promise<SerializedLegacyResponse> {
  switch (name) {
    case 'login':
      return envelopeAnswer(call, await loginMethod(call));
    case 'logout':
      return envelopeAnswer(call, await logoutMethod(call));
    case 'generatecsrftokens':
      return envelopeAnswer(call, await generateTokensMethod(call));
    case 'findcurrentuser':
      return findCurrentUserMethod(call);
    case 'validateemail':
      return validateEmailMethod(call);
  }
}

/** A `group` operation, as a direct method or on the entity route, which sets `params.method` first (jsonApiUtility.cfc:1240-1314). */
async function groupAnswer(call: ApiCall, operation: GroupOperation): Promise<SerializedLegacyResponse> {
  if (!call.direct) call.method = operation;
  let data: Struct;
  switch (operation) {
    case 'findAll':
      data = await findAll(call);
      break;
    case 'findMany':
      data = await findMany(call);
      break;
    case 'findNew':
      data = findNew(call);
      break;
    case 'findOne':
      data = await findOne(call);
      break;
    case 'findPermissions':
      data = findPermissions(call);
      break;
    case 'findProperties':
      data = findProperties(call);
      break;
    case 'findQuery':
      data = await findQuery(call);
      break;
    case 'save':
      data = await save(call);
      break;
    case 'validate':
      data = await validate(call);
      break;
  }
  if (call.direct) return envelopeAnswer(call, data);
  // The entity route answers 403 when the result carries errors.
  return serializeSaveResult(
    { method: call.method ?? operation, params: call.params, data },
    { useDataNamespace: call.params.usedatanamespace, serializer: groupSerializer() },
  );
}

/** The registry as one request reads it; origin domains are read only for a request with an Origin. */
type RegistrySnapshot = ReadonlyArray<RegisteredSite & { domains?: string[] }>;

/** Registers the contract's JSON API routes of every family; each method and path form shares one handler. */
export async function registerLegacyApiRoutes(app: FastifyInstance, deps: LegacyApiRouteDeps): Promise<void> {
  const settings = deps.legacy ?? legacyApiSettings(process.env);
  const snapshots = new WeakMap<FastifyRequest, Promise<RegistrySnapshot>>();

  /** The request's single registry read, which the Origin echo and the route resolution share. */
  function registryOf(request: FastifyRequest): Promise<RegistrySnapshot> {
    let snapshot = snapshots.get(request);
    if (snapshot === undefined) {
      snapshot = request.headers.origin === undefined ? registeredTenants(deps.db) : registryEntries(deps.db);
      snapshots.set(request, snapshot);
    }
    return snapshot;
  }

  /** processRequest's Origin echo on every answer of the route, auth denials included (jsonApiUtility.cfc:382-394). */
  async function allowOrigin(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
    const origin = request.headers.origin;
    if (origin === undefined) return payload;
    let registry: RegistrySnapshot;
    try {
      registry = await registryOf(request);
    } catch {
      // The answer goes out without the echo: a throw from onSend re-enters error handling and sends it again.
      return payload;
    }
    const sites = registry.map((entry) => ({ domain: entry.domains?.join(',') ?? '' }));
    const { adminDomain } = settings;
    const cfg = { adminDomain, currentAdminDomain: currentAdminDomainOf(request, adminDomain) };
    reply.headers(corsHeaders(origin, accessControlOriginDomains(sites, cfg)));
    return payload;
  }

  /** getEndPoint() and getAdminPath(complete=1) of this request (jsonApiUtility.cfc:3337-3364; settingsBean.cfc:1416-1462). */
  function urlsOf(request: FastifyRequest, mode: 'json' | 'rest', apiSite: string): { endpoint: string; adminPath: string } {
    const host = clientHostOf(request);
    const port = settings.serverPort ?? serverPortSetting(host.port);
    const protocol = settings.adminSSL ? 'https' : requestProtocolOf(request);
    const hasAdminDomain = settings.adminDomain !== '';
    // configBean.getAdminPath takes getCurrentAdminDomain() as is, so a host off the admin domains keeps its port (configBean.cfc:517-528,1860-1875).
    const domain = hasAdminDomain ? currentAdminDomainOf(request, settings.adminDomain) : host.name;
    // configBean.getScheme() defaults `secure` to adminSSL; settingsBean.getWebPath reads only the request protocol (settingsBean.cfc:1416-1433).
    const scheme = (hasAdminDomain && settings.adminSSL) || requestProtocolOf(request) === 'https' ? 'https' : 'http';
    return {
      endpoint: `${protocol}://${host.name}${port}${settings.context}/index.cfm/_api/${mode}/v1/${apiSite}`,
      adminPath: `${scheme}://${domain}${port}${settings.context}/admin`,
    };
  }

  /** processRequest's resolution through the shared route key, then the method or operation identity serves. */
  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const registry = new Map((await registryOf(request)).map((entry) => [entry.siteId.toLowerCase(), entry]));
    const lookup = (siteId: string): RegisteredSite | undefined => registry.get(siteId.toLowerCase());
    const headers = clientHeadersOf(request);
    const keyed = routeKeyRequestOf(request, headers);
    const key = routeKeyForRequest(keyed, {
      siteExists: (siteId) => lookup(siteId) !== undefined,
      variants: GROUP_SAVE_VARIANTS,
      context: settings.context,
      appReloadKey: settings.appReloadKey,
    });
    const { params } = key;
    const restMode = key.family === 'rest';
    const methodCtx: ApiNameContext = {
      hasOrigin: request.headers.origin !== undefined,
      restMode,
      hasAuthorization: restMode && headerValue(headers, 'authorization') !== undefined,
    };
    // A key identity does not own, or a withheld variant, is no route of this service.
    const notFound = (): FastifyReply =>
      sendLegacyResponse(reply, legacyErrorResponse('invalidMethodCall', { method: params.method, params, methodCtx, mura404: true }));
    if (key.family !== 'api' && key.family !== 'rest') return notFound();

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
    const body = key.baseKey.slice(key.family.length + 1);
    const operation = GROUP_OPERATIONS.get(body);
    const requested = requestParam(request, 'method');
    // A dotted method (group.<m>) rewrites the path and resolves as the entity route (jsonApiUtility.cfc:953-961).
    const dotted = typeof requested === 'string' && requested.includes('.');
    const call: ApiCall = {
      request,
      reply,
      deps,
      params,
      url: Object.fromEntries(Object.entries(scopeOf(request.query, true)).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value])),
      caller: callerOf(user),
      restMode,
      apiSite,
      siteId: params.siteid ?? apiSite,
      direct: operation !== undefined && !dotted && params.method !== undefined && cfEq(params.method, operation),
      method: params.method,
      methodCtx,
      ...urlsOf(request, restMode ? 'rest' : 'json', apiSite),
    };
    try {
      const failure = RESOLUTION_ERRORS.get(body);
      if (failure !== undefined) throw new LegacyApiError(failure, { method: params.method, methodCtx });
      if (restMode && OAUTH_KEYS.has(body)) return sendLegacyResponse(reply, await oauthAnswer(call, headers));
      if (key.variant !== undefined) return notFound();
      // A REST request reaches a method only after its credentials were exchanged for a session token.
      if (restMode && user === undefined) {
        throw new LegacyApiError('authorization', { method: 'Not Available', wwwAuthenticate: WWW_AUTHENTICATE.basic });
      }
      if (NAMED_METHODS.has(body)) return sendLegacyResponse(reply, await namedAnswer(call, body as NamedMethod));
      if (operation !== undefined) return sendLegacyResponse(reply, await groupAnswer(call, operation));
      return notFound();
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
      const error = err instanceof Error ? err : new Error(String(err));
      request.log.error({ error: { type: error.name, message: error.message, stack: error.stack } }, 'unhandled JSON API error');
      // catch (Any e) reports params.method as the failing operation had set it.
      return sendLegacyResponse(reply, legacyErrorResponse('server_error', { method: call.method, params, methodCtx }));
    }
  }

  for (const family of FAMILIES) {
    app.route({
      method: [...HTTP_METHODS],
      url: `/_api/${family}/v1/*`,
      config: { opt2: { ...ROUTE_AUTH } },
      onSend: allowOrigin,
      handler: handle,
    });
  }
}
