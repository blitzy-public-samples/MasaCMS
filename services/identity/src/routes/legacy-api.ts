/** JSON API methods and the `group` entity identity owns, served as Masa's `processRequest` serves them [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:368-1402]. */
import { AuthDenial, Roles, assertSiteMatches, moduleRole, untilAborted, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  PHOTO_CONDITION,
  WWW_AUTHENTICATE,
  buildEnvelope,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  createApiSerializer,
  deleteCookieLegacy,
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
  type RouteKeyRequest,
  type SerializedLegacyResponse,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import type { RepositoryRow } from '@opt2/platform/migration-kit';
import {
  EnvValidationError,
  SERVICE_CALL_TIMEOUT_MS,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import { registeredTenants, registryEntries, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { EN_ACCOUNT_MESSAGES, messageFormat } from '../domain/account-operations.js';
import { issueTokens } from '../domain/csrf.js';
import {
  createGroup,
  findGroupForSite,
  findPoolRows,
  groupSaveInputFrom,
  listGroupRelationRows,
  newGroupRecord,
  readFeedGroups,
  scanFeedGroups,
  updateGroup,
  type GroupActor,
  type GroupDeps,
  type GroupLocation,
  type GroupRecord,
  type GroupSaveInput,
} from '../domain/groups.js';
import { lockdownLogin, login, logout, type LoginDeps } from '../domain/login.js';
import { snapshotIsS2 } from '../domain/roles.js';
import { locateSession, sessionSnapshot, type SessionDeps } from '../domain/sessions.js';
import {
  isSqlExpressible,
  type FeedComparison,
  type GroupFeedCondition,
  type GroupFeedFilter,
  type GroupFeedQuery,
  type GroupFeedSortKey,
} from '../repo/group-feed.js';
import { charKey, type GroupRelation } from '../repo/repository.js';
import { tokenMembershipIds } from './admin-groups.js';
import { CF_QUERY, CfNumber, CfStruct, acfStructKeyOrder, deserializeCfJson, isSimple, simpleText, type CfValue } from './cfml-struct.js';
import { validateCsrfForRoute, type CsrfRouteDeps } from './internal-csrf.js';
import {
  appendErrors,
  errorsObject,
  validateAdHoc,
  validateHalted,
  validateRefused,
  validateUserBean,
  type ValidatedBean,
  type ValidationContext,
  type ValidationErrors,
} from './legacy-bean-validator.js';
import { clientHost, currentAdminDomain, originEcho } from './legacy-origin.js';
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
  /** configBean `stricthtml`; undefined is its default, false (bean.cfc:511). */
  readonly strictHtml?: boolean;
  /** configBean `sessionBasedLockdown`; undefined is its default, true (configBean.cfc:238). */
  readonly sessionBasedLockdown?: boolean;
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
  /** Replaces SERVICE_CALL_TIMEOUT_MS as `validateEmail`'s deadline in tests. */
  validateEmailTimeoutMs?: number;
};

const FAMILIES = ['json', 'ajax', 'rest'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/** JSON API family prefixes, bare and behind `/index.cfm`, then both behind a non-empty configBean `context`; createService takes them as `noCasePathPrefixes`. */
export function legacyApiPrefixes(context = ''): readonly string[] {
  const segments = context.split('/').filter((segment) => segment !== '');
  const leads = segments.length === 0 ? [''] : ['', `/${segments.join('/')}`];
  return Object.freeze(leads.flatMap((lead) => FAMILIES.flatMap((family) => [`${lead}/_api/${family}/v1`, `${lead}/index.cfm/_api/${family}/v1`])));
}

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
    MURA_STRICTHTML: literalSetting((v) => BLANK.test(v) || cfIsBoolean(v), 'must be a CFML boolean'),
    MURA_SESSIONBASEDLOCKDOWN: literalSetting((v) => BLANK.test(v) || cfIsBoolean(v), 'must be a CFML boolean'),
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
    ...(env.MURA_STRICTHTML === undefined || BLANK.test(env.MURA_STRICTHTML) ? {} : { strictHtml: cfToBoolean(env.MURA_STRICTHTML) }),
    ...(env.MURA_SESSIONBASEDLOCKDOWN === undefined || BLANK.test(env.MURA_SESSIONBASEDLOCKDOWN)
      ? {}
      : { sessionBasedLockdown: cfToBoolean(env.MURA_SESSIONBASEDLOCKDOWN) }),
  }));

/** The settings from `MURA_<KEY>` variables, else the settings template values; throws EnvValidationError naming each malformed variable. */
export function legacyApiSettings(env: Readonly<Record<string, string | undefined>>): LegacyApiSettings {
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
  return clientHost(request.headers);
}

/** configBean.getCurrentAdminDomain() (configBean.cfc:517-525): the host's name on an admin domain, else the host. */
function currentAdminDomainOf(request: FastifyRequest, adminDomain: string): string {
  return currentAdminDomain(request.headers, adminDomain);
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
  /** settingsManager `siteExists` over the request's registry read. */
  isRegisteredSite: (siteId: string) => boolean;
  /** Invoked as a direct method, which always answers 200 with the method as requested (jsonApiUtility.cfc:870-898). */
  direct: boolean;
  /** `params.method` as the catch block and the envelope report it; updated as legacy updates it. */
  method: string | undefined;
  methodCtx: ApiNameContext;
  /** `getEndPoint()` (jsonApiUtility.cfc:3337-3364). */
  endpoint: string;
  /** settingsBean `getAdminPath(complete=1)` (settingsBean.cfc:1416-1433). */
  adminPath: string;
  /** The configBean settings the routes read. */
  settings: LegacyApiSettings;
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

/** Feed setters `addParam` calls instead of adding a param: these two dereference the text as a struct (beanFeed.cfc:317-320). */
const FAILING_SETTERS: readonly string[] = Object.freeze(['params', 'allvalues']);

/** Feed and bean setters whose value no group query reads. */
const INERT_SETTERS: readonly string[] = Object.freeze(['advancedparams', 'configbean', 'addedobjectvalues', 'errors', 'propasidcolumn', 'validations', 'value']);

/** SQL Server column types a feed's comparisons, conversions and aggregates tell apart. */
type SqlType = 'text' | 'int' | 'tinyint' | 'float' | 'datetime' | 'binary';

const SQL_TYPE_CODES: Readonly<Record<string, SqlType>> = { t: 'text', i: 'int', b: 'tinyint', f: 'float', d: 'datetime', x: 'binary' };

/** `name:code` pairs as a column map. */
function sqlColumns(spec: string): ReadonlyMap<string, SqlType> {
  return new Map(spec.split(' ').map((item): [string, SqlType] => [cfListFirst(item, ':'), SQL_TYPE_CODES[cfListLast(item, ':')] ?? 'text']));
}

/** Columns of the tables a group feed's FROM clause can expose, as the Masa 7.6.1 schema types them (core/setup/db/mssql.sql). */
const FEED_SCHEMA: ReadonlyMap<string, ReadonlyMap<string, SqlType>> = new Map([
  [
    'tusers',
    sqlColumns(
      'userid:t groupname:t fname:t lname:t username:t password:t passwordcreated:d email:t company:t jobtitle:t mobilephone:t website:t ' +
        'type:i subtype:t ext:i contactform:t admin:i s2:i lastlogin:d lastupdate:d lastupdateby:t lastupdatebyid:t perm:b inactive:b ' +
        'ispublic:i siteid:t subscribe:i notes:t description:t interests:t keepprivate:b photofileid:t imname:t imservice:t created:d ' +
        'remoteid:t tags:t tablist:t',
    ),
  ],
  [
    'tfiles',
    sqlColumns(
      'fileid:t contentid:t siteid:t moduleid:t filename:t image:x imagesmall:x imagemedium:x filesize:i contenttype:t contentsubtype:t ' +
        'fileext:t created:d deleted:b caption:t credits:t alttext:t remoteid:t remoteurl:t remotepubdate:d remotesource:t remotesourceurl:t exif:t',
    ),
  ],
  ['tuserstags', sqlColumns('tagid:i userid:t siteid:t tag:t')],
  ['tusersinterests', sqlColumns('userid:t categoryid:t')],
  [
    'tuseraddresses',
    sqlColumns(
      'addressid:t userid:t siteid:t addressname:t address1:t address2:t city:t state:t zip:t country:t phone:t fax:t isprimary:b ' +
        'addressnotes:t addressurl:t longitude:f latitude:f addressemail:t hours:t',
    ),
  ],
  ['tusersfavorites', sqlColumns('favoriteid:t userid:t favoritename:t favorite:t type:t siteid:t datecreated:d columnnumber:i rownumber:i maxrssitems:i')],
]);

/** `deniedFeedJoinTables`: tables a feed may never join, aggregate over or sort by (configBean.cfc:162). */
const DENIED_FEED_TABLES: readonly string[] = Object.freeze([
  'tusers', 'tusersmemb', 'tusergroups', 'tsettings', 'tusersession', 'toauthtokens', 'tremembertokens', 'tpermissions', 'tsessiontracking',
  'tredirects', 'toauthclients', 'tuserremotesessions', 'tuserdevice',
]);

/** Masa 7.6.1 tables without a `userid` column, whose implied join fails to bind (core/setup/db/mssql.sql; core/setup/dbUpdates). */
const TABLES_WITHOUT_USERID: ReadonlySet<string> = new Set(
  (
    'tapprovalassignments tapprovalchains tapprovalmemberships tchangesetcategoryassign tchangesetrollback tchangesets tchangesettagassign ' +
    'tclassextend tclassextendattributes tclassextenddata tclassextenddatauseractivity tclassextendrcsets tclassextendsets tclustercommands ' +
    'tclusterpeers tcontent tcontentcategories tcontentcategoryassign tcontentcommentcommenters tcontentdisplaytitleapprovals ' +
    'tcontenteventreminders tcontentfeedadvancedparams tcontentfeeditems tcontentfeeds tcontentfilemetadata tcontentfilenamearchive ' +
    'tcontentobjects tcontentpublicsubmissionapprovals tcontentrelated tcontentremotepointer tcontentsourcemaps tcontentstats tcontenttags ' +
    'tcontentvariationtargeting tdirectories temailreturnstats temails temailstats tentity tfiles tformresponsepackets tformresponsequestions ' +
    'timagesizes tmailinglist tmailinglistmembers tpermissions tplugindisplayobjects tplugins tpluginscripts tpluginsettings trazunasettings ' +
    'tsettings tsystemobjects ttrash tuserstrikes'
  ).split(' '),
);

/**
 * Entities whose `objectMappings` table a user feed's FROM clause can hold, mapped only once a request has instantiated them; every
 * other unregistered-at-start entity names a table the statement never binds (onApplicationStart_include.cfm:432-456).
 */
const MAPPED_ENTITIES: ReadonlySet<string> = new Set(['group', 'address', 'favorite']);

/** userGateway's `fieldList`, the default select list ordinal sorts index (userGateway.cfc:82). */
const FIELD_LIST_COLUMNS: readonly string[] = Object.freeze([
  'userid', 'groupname', 'fname', 'lname', 'username', 'passwordcreated', 'email', 'company', 'jobtitle', 'mobilephone', 'website', 'type',
  'subtype', 'contactform', 's2', 'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'perm', 'inactive', 'ispublic', 'siteid',
  'subscribe', 'notes', 'description', 'interests', 'keepprivate', 'photofileid', 'imname', 'imservice', 'created', 'remoteid', 'tags',
  'tablist', 'tfiles.fileext',
]);

const FEED_EXCEPTION = 'EX-GROUP-FEED';

/** A group feed case whose answer reads another owner's data or the legacy runtime, which identity cannot reproduce: it stays on legacy. */
export function feedHalted(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} stays on legacy (${FEED_EXCEPTION})`, 'auto', reason);
}

const FEED_DATA_EXCEPTION = 'EX-GROUP-FEED-DATA';

/** A group feed case whose legacy answer turns on the stored rows, SQL Server's plan over them or the legacy database's name: the target refuses it. */
export function feedRefused(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} is refused (${FEED_DATA_EXCEPTION})`, 'auto', reason);
}

/** One `addParam` row: the field as `formatField` stored it and the datatype `addParam` gave it (beanFeed.cfc:301-345). */
interface FeedParamRow {
  field: string;
  relationship: 'and' | 'or';
  condition: string;
  criteria: string;
  dataType: ColumnType;
}

/** One row of the feed's FROM clause: the group and the row each inner join adds, by lowercase table. */
interface FeedRow {
  group: GroupRecord;
  joined: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/** The joined rows of a FROM row of `tusers` alone. */
const NO_JOINS: FeedRow['joined'] = new Map();

/** One valid `queryParam`, joined to the previous one by `relationship`: its test over a FROM row, and its WHERE condition when it names a `tusers` column. */
interface FeedParam {
  relationship: 'and' | 'or';
  test: (row: FeedRow) => boolean;
  condition?: GroupFeedCondition;
}

type AggregateKind = 'groupby' | 'sum' | 'count' | 'avg' | 'min' | 'max';

/** The aggregate arrays in the order getAdvancedSearch checks and selects them (userGateway.cfc:240-248,282-311). */
const AGGREGATE_KINDS: readonly AggregateKind[] = Object.freeze(['groupby', 'sum', 'count', 'avg', 'min', 'max']);

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
  params: FeedParamRow[];
  /** `groupID` and `categoryID` as their setters trim them (userFeedBean.cfc:183-210). */
  groupIds: string;
  categoryIds: string;
  /** `setDistinct` of a CFML boolean `distinct` (jsonApiUtility.cfc:3117-3119). */
  distinct: boolean;
  /** `aggregate()` items, trimmed (beanFeed.cfc:688-733). */
  aggregates: Record<AggregateKind, string[]>;
}

function newGroupFeed(): GroupFeed {
  return {
    isPublic: '1', type: '1', sortBy: 'lname', sortDirection: 'asc', orderBy: '', maxItems: 0, nextN: 1000, fields: [], params: [], groupIds: '',
    categoryIds: '', distinct: false, aggregates: { groupby: [], sum: [], count: [], avg: [], min: [], max: [] },
  };
}

/** A feed or SQL failure processRequest's `catch (Any e)` answers. */
function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/**
 * REST runs sessionless, so on ACF 2023 a `$` event of a registered site throws building its content renderer: the one a
 * method builds first, or serializeResponse's for a data struct (jsonApiUtility.cfc:1486-1487; contentRenderer.cfc:701).
 */
function assertSitelessEvent(call: ApiCall, siteId: string): void {
  if (call.restMode && call.isRegisteredSite(siteId)) throw serverError();
}

/** SQL Server's case-insensitive, trailing-space-insensitive text comparison under its default collation. */
export function compareText(a: string, b: string): number {
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

/** SQL Server LIKE as a whole-value, case-insensitive predicate over `%`, `_` and `[...]` classes, in O(value × pattern) steps. */
export function likeMatcher(pattern: string): (value: string) => boolean {
  // null is a run of `%`; every other token matches exactly one UTF-16 code unit, so backtracking to the last `%` is exact.
  const tokens: Array<RegExp | null> = [];
  const unit = (source: string): void => {
    tokens.push(new RegExp(`^(?:${source})$`, 'is'));
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '%') {
      if (tokens.at(-1) !== null) tokens.push(null);
    } else if (ch === '_') unit('.');
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) {
        unit('\\[');
        continue;
      }
      const body = pattern.slice(i + 1, end);
      const negated = body.startsWith('^');
      const members = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&');
      unit(`[${negated ? '^' : ''}${members}]`);
      i = end;
    } else unit(ch.replace(/[.*+?^${}()|\\/]/g, '\\$&'));
  }
  return (value) => {
    let v = 0;
    let t = 0;
    let star = -1;
    let resume = 0;
    while (v < value.length) {
      const token = tokens[t];
      if (token === null) {
        star = t;
        resume = v;
        t += 1;
      } else if (token !== undefined && token.test(value.charAt(v))) {
        v += 1;
        t += 1;
      } else if (star >= 0) {
        resume += 1;
        v = resume;
        t = star + 1;
      } else return false;
    }
    while (tokens[t] === null) t += 1;
    return t === tokens.length;
  };
}

/** queryParam `setCondition` (queryParam.cfc:159-196); `''` for a name it does not know, which fails the SQL. */
function sqlCondition(condition: string, type: ColumnType): FeedComparison | 'in' | 'not in' | 'like' | '' {
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

/** A column value a feed clause reads; NULL as null. */
type FeedValue = string | number | Date | null;

/** A feed condition as getAdvancedSearch's WHERE clause tests a row's column; a NULL column value passes only IS [NOT] NULL. */
export function conditionTest(condition: GroupFeedCondition): (row: Readonly<Record<string, unknown>>) => boolean {
  const read = (row: Readonly<Record<string, unknown>>): FeedValue => (row[condition.column] ?? null) as FeedValue;
  if (condition.kind === 'null') return (row) => (read(row) === null) !== condition.negated;
  if (condition.kind === 'like') {
    const matches = likeMatcher(condition.pattern);
    return (row) => { const value = read(row); return value !== null && matches(String(value)); };
  }
  if (condition.kind === 'in') {
    const { items, type, negated } = condition;
    const member = (value: string | number | Date): boolean => items.some((item) => compareColumn(value, item, type) === 0);
    return (row) => {
      const value = read(row);
      return value !== null && (negated ? !member(value) : member(value));
    };
  }
  const { op, value: bound, type } = condition;
  return (row) => {
    const value = read(row);
    if (value === null) return false;
    const order = compareColumn(value, bound, type);
    return order !== undefined && conditionHolds(op, order);
  };
}

/** One `queryParam` on `column` as getAdvancedSearch's WHERE clause binds it. */
function feedCondition(column: string, type: ColumnType, condition: string, criteria: string): GroupFeedCondition {
  const sql = sqlCondition(condition, type);
  const bound = sqlCriteria(criteria, condition, type);
  // init's validate() marks every named param valid again, so criteria the type cannot hold binds '' and fails the SQL (queryParam.cfc:94-105,352-360).
  if (bound === undefined || sql === '') throw serverError();
  let where: GroupFeedCondition;
  if (bound === null) {
    // getCondition() returns nothing for a NULL criteria under any other condition, which fails the SQL (queryParam.cfc:198-208).
    if (sql !== '=' && sql !== '!=') throw serverError();
    where = { kind: 'null', column, negated: sql === '!=' };
  } else if (sql === 'like') {
    where = { kind: 'like', column, pattern: String(bound) };
  } else if (sql === 'in' || sql === 'not in') {
    // cfqueryparam list="true" binds each comma-separated item.
    where = { kind: 'in', column, type, negated: sql === 'not in', items: String(bound).split(',') };
  } else {
    where = { kind: 'compare', column, type, op: sql, value: bound };
  }
  return where;
}

/** One `queryParam` on a `tusers` column: its WHERE condition, and that condition's test over a FROM row's group. */
function feedParam(column: string, type: ColumnType, condition: string, criteria: string, relationship: 'and' | 'or'): FeedParam {
  const where = feedCondition(column, type, condition, criteria);
  const test = conditionTest(where);
  return { relationship, condition: where, test: (row) => test(row.group) };
}

/** Whether a comparison of `order` (value minus criteria) satisfies SQL condition `sql`. */
function conditionHolds(sql: string, order: number): boolean {
  return sql === '=' ? order === 0 : sql === '!=' ? order !== 0 : sql === '>' ? order > 0 : sql === '>=' ? order >= 0 : sql === '<' ? order < 0 : order <= 0;
}

/** SQL Server's implicit conversion of varchar criteria to an int or tinyint column: digits between spaces after an optional sign, '' as 0; undefined where it raises. */
function sqlServerInteger(text: string, type: SqlType): number | undefined {
  const match = /^ *([+-]?) *(\d*) *$/.exec(text);
  if (match === null) return undefined;
  const digits = match[2] ?? '';
  const magnitude = digits === '' ? 0 : Number(digits);
  const value = match[1] === '-' && magnitude !== 0 ? -magnitude : magnitude;
  const [min, max] = type === 'tinyint' ? [0, 255] : [-2147483648, 2147483647];
  return value < min || value > max ? undefined : value;
}

/** SQL Server's implicit conversion of varchar criteria to a float column, `d` exponents included; undefined where it raises. */
function sqlServerFloat(text: string): number | undefined {
  if (/^ *$/.test(text)) return 0;
  const match = /^[ \t\n\r\v\f\u00a0]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?) *$/.exec(text);
  const value = match === null ? Number.NaN : Number((match[1] ?? '').replace(/[dD]/, 'e'));
  return Number.isFinite(value) ? value : undefined;
}

/** A column a feed clause names, bound to one table of its FROM clause. */
interface FeedColumn {
  table: string;
  column: string;
  type: SqlType;
}

/** One `queryParam` on a joined table's column: its varchar criteria convert to the column's type as SQL Server converts them, once. */
function joinedParam(column: FeedColumn, param: FeedParamRow, field: string): FeedParam {
  const read = (row: FeedRow): FeedValue => (row.joined.get(column.table)?.[column.column] ?? null) as FeedValue;
  const sql = sqlCondition(param.condition, param.dataType);
  const bound = sqlCriteria(param.criteria, param.condition, param.dataType);
  if (bound === undefined || sql === '') throw serverError();
  // A numeric or date bind on a text column converts the column, row by row, so stored values decide whether the statement fails.
  if (bound !== null && param.dataType !== 'varchar') throw feedRefused(`A ${param.dataType} criteria on ${field}`, 'feed-typed-param');
  const { relationship } = param;
  if (bound === null || column.type === 'text') {
    // Tested here only: no group_account statement reads a joined table.
    const test = conditionTest(feedCondition(column.column, param.dataType, param.condition, param.criteria));
    return { relationship, test: (row) => test(row.joined.get(column.table) ?? {}) };
  }
  if (column.type !== 'int' && column.type !== 'tinyint' && column.type !== 'float') {
    throw feedHalted(`A criteria on the datetime column ${field}`, 'feed-datetime');
  }
  if (sql === 'like') {
    // LIKE converts the number to text; SQL Server's float text is its own format.
    if (column.type === 'float') throw feedHalted(`A LIKE criteria on the float column ${field}`, 'feed-float-like');
    const matches = likeMatcher(String(bound));
    return { relationship, test: (row) => { const value = read(row); return value !== null && matches(String(value)); } };
  }
  const items = sql === 'in' || sql === 'not in' ? String(bound).split(',') : [String(bound)];
  const numbers = items.map((item) => (column.type === 'float' ? sqlServerFloat(item) : sqlServerInteger(item, column.type)));
  const criteria = numbers.filter((value): value is number => value !== undefined);
  if (criteria.length !== numbers.length) throw serverError();
  return {
    relationship,
    test: (row) => {
      const value = read(row);
      if (value === null) return false;
      const number = Number(value);
      if (sql === 'in' || sql === 'not in') return criteria.includes(number) === (sql === 'in');
      return conditionHolds(sql, number - (criteria[0] ?? 0));
    },
  };
}

/** The params' WHERE clause: `p1 rel p2 rel p3 …` with SQL's AND-before-OR precedence. */
function matchesParams(params: readonly FeedParam[], row: FeedRow): boolean {
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
  if (cfIsBoolean(distinct)) feed.distinct = cfToBoolean(distinct);
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
  read: (row: FeedRow) => FeedValue;
  type: ColumnType;
  desc: boolean;
  /** Whether the key is a joined table's column, whose ties SQL Server orders by its plan. */
  joined: boolean;
  /** The `tusers` column the key orders by, which a group_account statement can order by too. */
  column?: string;
}

/** `utility.isDeniedFeedTable(reference, 'tusers')`: the reference's table part names a denied table (utility.cfc:333-346). */
function isDeniedFeedTable(reference: string): boolean {
  const table = cfListFirst(reference, '.').replace(/[^0-9A-Za-z_]/g, '');
  return !cfEq(table, 'tusers') && listHasNoCase(DENIED_FEED_TABLES, table);
}

/** Binds a column reference as SQL Server does over `tables`, the FROM clause's lowercase exposed names: a name in exactly one table, `table.column` or `dbo.table.column`. */
function bindColumn(reference: string, tables: readonly string[]): FeedColumn {
  const parts = reference.split('.');
  if (parts.length >= 4 || parts.slice(0, -1).some((part) => part === '')) {
    throw feedRefused(`The column reference ${reference}, which names the legacy database,`, 'feed-database-name');
  }
  // A trailing dot, or a number where a name belongs, is a syntax error.
  if (parts.some((part) => !/^[A-Za-z_]\w*$/.test(part))) throw serverError();
  const named = parts.length === 3 && cfEq(parts[0] ?? '', 'dbo') ? parts.slice(1) : parts;
  if (named.length === 3) throw serverError();
  const [first = '', second] = named.map((part) => part.toLowerCase());
  if (second !== undefined) {
    const type = tables.includes(first) ? FEED_SCHEMA.get(first)?.get(second) : undefined;
    if (type === undefined) throw serverError();
    return { table: first, column: second, type };
  }
  const owners = tables.filter((table) => FEED_SCHEMA.get(table)?.has(first));
  const table = owners.length === 1 ? (owners[0] ?? '') : '';
  const type = FEED_SCHEMA.get(table)?.get(first);
  // An ambiguous or unknown name fails to bind.
  if (type === undefined) throw serverError();
  return { table, column: first, type };
}

/** The value of `column` in a FROM row. */
function columnReader(column: FeedColumn): (row: FeedRow) => FeedValue {
  if (column.table === 'tusers') return (row) => row.group[column.column as keyof GroupRecord] ?? null;
  return (row) => (row.joined.get(column.table)?.[column.column] ?? null) as FeedValue;
}

/** An ORDER BY key on `column`; tfiles values are strategies-content's file rows. */
function columnKey(column: FeedColumn, desc: boolean): SortKey {
  if (column.table === 'tfiles') throw feedHalted(`Ordering groups by tfiles.${column.column}`, 'feed-tfiles');
  const type: ColumnType = column.type === 'text' ? 'varchar' : column.type === 'datetime' ? 'timestamp' : 'numeric';
  if (column.table === 'tusers') return { read: columnReader(column), type, desc, joined: false, column: column.column };
  return { read: columnReader(column), type, desc, joined: true };
}

/** The select list ordinal sorts index: bound columns, or the number of aggregate expressions. */
type SelectList = { kind: 'columns'; columns: readonly FeedColumn[] } | { kind: 'aggregate'; count: number };

/** The ORDER BY getAdvancedSearch builds (userGateway.cfc:571-588); an extended-attribute `sortBy` orders by a value groups never hold. */
function sortKeysOf(feed: GroupFeed, tables: readonly string[], select: SelectList): SortKey[] {
  const ordinal = (field: string, desc: boolean): SortKey[] => {
    const position = Number(field);
    if (select.kind === 'aggregate') {
      if (position < 1 || position > select.count) throw serverError();
      // The one aggregate row needs no order.
      return [];
    }
    const column = select.columns[position - 1];
    if (column === undefined) throw serverError();
    return [columnKey(column, desc)];
  };
  if (feed.orderBy.trim() !== '') {
    return validatedSort(feed.orderBy).flatMap(({ field, desc }) => {
      if (/^\d+$/.test(field)) return ordinal(field, desc);
      // An aggregate select list admits only ordinal positions.
      if (select.kind === 'aggregate') throw serverError();
      return [columnKey(bindColumn(field, tables), desc)];
    });
  }
  // Neither tusers.Lname nor the extended sort value is in an aggregate select list.
  if (select.kind === 'aggregate') throw serverError();
  if (!listHasNoCase(SORT_OPTIONS, feed.sortBy)) {
    // The extended sort joins tclassextenddatauseractivity values no group row carries; only the direction is validated.
    validatedSort(`x ${feed.sortDirection}`);
    return [];
  }
  const [{ field, desc }] = validatedSort(`${feed.sortBy} ${feed.sortDirection}`) as [{ field: string; desc: boolean }];
  return [columnKey(bindColumn(`tusers.${field}`, tables), desc)];
}

/** SQL Server ORDER BY of one column's two values: NULLs first ascending, last descending. */
function compareKey(left: FeedValue, right: FeedValue, type: ColumnType, desc: boolean): number {
  let order = 0;
  if (left === null || right === null) order = left === right ? 0 : left === null ? -1 : 1;
  else order = compareColumn(left, right, type) ?? 0;
  return desc ? -order : order;
}

/** SQL Server ORDER BY of FROM rows by `keys`. */
function compareRows(keys: readonly SortKey[], a: FeedRow, b: FeedRow): number {
  for (const { read, type, desc } of keys) {
    const order = compareKey(read(a), read(b), type, desc);
    if (order !== 0) return order;
  }
  return 0;
}

/** The feed order of stored groups: ORDER BY keys on `tusers` columns, ties in the clustered userid order SQL Server returns them in. */
export function feedOrder(keys: readonly GroupFeedSortKey[], a: GroupRecord, b: GroupRecord): number {
  for (const { column, type, desc } of keys) {
    const order = compareKey(groupColumn(a, column), groupColumn(b, column), type, desc);
    if (order !== 0) return order;
  }
  return a.userid < b.userid ? -1 : a.userid > b.userid ? 1 : 0;
}

/** A stored group's `tusers` column value; NULL as null. */
function groupColumn(group: GroupRecord, column: string): FeedValue {
  return group[column as keyof GroupRecord] ?? null;
}

/** Entities whose `objectMappings` table is registered by the time a feed runs: the feed's own, the settings bean and those application start instantiates (onApplicationStart_include.cfm:432-456). */
const LOADED_ENTITY_TABLES: ReadonlyMap<string, string> = new Map([
  ['user', 'tusers'],
  ['site', 'tsettings'],
  ['file', 'tfiles'],
  ['userdevice', 'tuserdevice'],
  ['userredirect', 'tredirects'],
  ['oauthclient', 'toauthclients'],
  ['oauthtoken', 'toauthtokens'],
]);

/** `transformFieldName` of a user feed over the entities registered by the time it runs: `entity.column` names the entity's table (beanFeed.cfc:739-756). */
function registeredReference(item: string): string {
  const parts = cfListToArray(item, '.');
  if (parts.length !== 2 || cfEq(item, 'tusers.*')) return item;
  const table = LOADED_ENTITY_TABLES.get((parts[0] ?? '').toLowerCase());
  return table === undefined ? item : `${table}.${parts[1] ?? ''}`;
}

/** `transformFieldName` of a user feed: a registered entity names its table, a FROM-able one depends on what legacy has loaded (beanFeed.cfc:739-756). */
function aggregateReference(item: string): string {
  const parts = cfListToArray(item, '.');
  if (parts.length === 2 && MAPPED_ENTITIES.has((parts[0] ?? '').toLowerCase())) {
    throw feedHalted(`An aggregate over the ${parts[0] ?? ''} entity's ${parts[1] ?? ''}`, 'feed-entity-name');
  }
  return registeredReference(item);
}

/** One aggregate expression of the select list as SQL Server compiles it (userGateway.cfc:282-311). */
function checkAggregate(kind: Exclude<AggregateKind, 'groupby'>, reference: string, tables: readonly string[]): void {
  const expression = reference.replace(/[^0-9A-Za-z._,\-*]/g, '');
  if (kind === 'count' && cfListLast(expression, '.') === '*') return;
  // sum names its alias after the whole expression, the others after its last part.
  const alias = kind === 'sum' ? expression : cfListLast(expression, '.');
  if (!/^\w+$/.test(alias) || expression.includes('*')) throw serverError();
  if (/^\d+$/.test(expression)) return;
  if (!expression.split('.').every((part) => part === '' || /^[A-Za-z_]\w*$/.test(part))) {
    throw feedHalted(`The aggregate expression ${expression}`, 'feed-aggregate-expression');
  }
  const column = bindColumn(expression, tables);
  // sum and avg take numbers only.
  if ((kind === 'sum' || kind === 'avg') && column.type !== 'int' && column.type !== 'tinyint' && column.type !== 'float') throw serverError();
}

/** One param's WHERE test, or undefined for an invalid param getAdvancedSearch skips (userGateway.cfc:358-516; queryParam.cfc:120-131). */
function feedParamOf(param: FeedParamRow, tables: readonly string[]): FeedParam | undefined {
  const field = param.field.replace(/[^\w.]+/g, '');
  if (field === '' || cfEq(field, 'tusers.siteid')) return undefined;
  // A name without a table filters by an extended attribute through tclassextendattributes, strategies-content's definitions.
  if (cfListToArray(field, '.').length <= 1) throw feedHalted(`A group feed filtered by the extended attribute ${field}`, 'feed-extended');
  const column = bindColumn(field, tables);
  if (column.table === 'tfiles') throw feedHalted(`A group feed filtered by ${field}`, 'feed-tfiles');
  if (column.table !== 'tusers') return joinedParam(column, param, field);
  return feedParam(column.column, param.dataType, param.condition, param.criteria, param.relationship);
}

/** jsonApiUtility `isAggregateQuery`: no `url.fields`, and an aggregate or `distinct` url key, or `=<key>[` in the query string (jsonApiUtility.cfc:4981-4996). */
function isAggregatePage(call: ApiCall): boolean {
  const fields = textOf(valueOf(call.url, 'fields'));
  if (fields !== undefined && fields !== '') return false;
  const query = queryStringOf(call.request);
  return [...AGGREGATE_NAMES, 'distinct'].some((name) => keyOf(call.url, name) !== undefined || query.includes(`=${name}[`));
}

/** beanFeed `isAggregateQuery`: no `url.fields` and an aggregate expression (beanFeed.cfc:758-769). */
function selectsAggregates(call: ApiCall, feed: GroupFeed): boolean {
  const fields = textOf(valueOf(call.url, 'fields'));
  return (fields === undefined || fields === '') && AGGREGATE_KINDS.some((kind) => feed.aggregates[kind].length > 0);
}

/** What getAdvancedSearch compiles for a feed: its joins, params, select list kind and ORDER BY. */
interface FeedPlan {
  joins: string[];
  params: FeedParam[];
  keys: SortKey[];
  aggregate: boolean;
}

/** The tables getAdvancedSearch joins for a feed's params, once no param, aggregate or ORDER BY item names a denied table (userGateway.cfc:227-254). */
function authorizedJoins(feed: GroupFeed): string[] {
  const joins: string[] = [];
  for (const param of feed.params) {
    const parts = cfListToArray(param.field, '.');
    if (parts.length !== 2) continue;
    const table = (parts[0] ?? '').replace(/[^0-9A-Za-z_]/g, '');
    if (isDeniedFeedTable(table)) throw new LegacyApiError('authorization');
    // listFind keeps case variants apart.
    if (!cfEq(table, 'tusers') && !joins.includes(table)) joins.push(table);
  }
  // The entities whose mapping depends on what legacy has loaded name tables no feed denies, mapped or not.
  if (AGGREGATE_KINDS.some((kind) => feed.aggregates[kind].some((item) => isDeniedFeedTable(registeredReference(item))))) {
    throw new LegacyApiError('authorization');
  }
  if (cfListToArray(feed.orderBy).some((item) => isDeniedFeedTable(cfListFirst(javaTrim(item), ' ')))) throw new LegacyApiError('authorization');
  return joins;
}

/** getAdvancedSearch up to its query: restricted references answer authorization, then the statement compiles (userGateway.cfc:164-592). */
function planFeed(call: ApiCall, feed: GroupFeed): FeedPlan {
  const joins = authorizedJoins(feed);
  const aggregates = new Map(AGGREGATE_KINDS.map((kind) => [kind, feed.aggregates[kind].map(aggregateReference)] as const));
  // Two spellings of one table, or tfiles beside the photo join, share an exposed name.
  const tables = ['tusers', 'tfiles'];
  for (const join of joins) {
    const table = join.toLowerCase();
    if (tables.includes(table) || TABLES_WITHOUT_USERID.has(table)) throw serverError();
    if (!FEED_SCHEMA.has(table)) throw feedHalted(`A group feed joined to ${join}, whose rows identity does not hold,`, 'feed-other-table');
    tables.push(table);
  }
  const aggregate = selectsAggregates(call, feed);
  let select: SelectList;
  if (feed.fields.length > 0) {
    select = { kind: 'columns', columns: feed.fields.map((field) => bindColumn(field, tables)) };
  } else if (aggregate) {
    let count = 0;
    for (const kind of AGGREGATE_KINDS) {
      for (const reference of aggregates.get(kind) ?? []) {
        if (kind !== 'groupby') checkAggregate(kind, reference, tables);
        count += 1;
      }
    }
    select = { kind: 'aggregate', count };
  } else {
    select = { kind: 'columns', columns: FIELD_LIST_COLUMNS.map((field) => bindColumn(field.includes('.') ? field : `tusers.${field}`, tables)) };
  }
  const params = feed.params.flatMap((param) => feedParamOf(param, tables) ?? []);
  // The GROUP BY clause reads an undefined `llocal.i` (userGateway.cfc:563-567).
  if (feed.aggregates.groupby.length > 0) throw serverError();
  return { joins: tables.slice(2), params, keys: sortKeysOf(feed, tables, select), aggregate };
}

/** A CFML list filter's items as `IN` binds them: none binds listFirst's `''` (userGateway.cfc:525-553). */
function subqueryItems(list: string): string[] {
  const items = cfListToArray(list);
  return items.length === 0 ? [''] : items;
}

/** The group child rows of `relation` for `groups` of the `isPublic` user pool, by group key. */
async function relationRows(call: ApiCall, relation: GroupRelation, isPublic: number, groups: readonly GroupRecord[]): Promise<Map<string, RepositoryRow[]>> {
  const byGroup = new Map<string, RepositoryRow[]>();
  if (groups.length === 0) return byGroup;
  const groupIds = groups.map((group) => group.userid);
  for (const row of await listGroupRelationRows(call.deps.groups, { siteId: call.siteId, isPublic, relation, groupIds })) {
    const key = charKey(String(row.userid));
    byGroup.set(key, [...(byGroup.get(key) ?? []), row]);
  }
  return byGroup;
}

/** The rows a feed's query returns and how its iterator builds beans. */
interface FeedSelection {
  rows: FeedRow[];
  /** A distinct or aggregate feed iterates generic beans (userFeedBean.cfc:168-176). */
  generic: boolean;
}

/** The user pools a feed's `isPublic` selects: 0 or 1 that pool, another number neither, a non-number both. */
function feedPools(feed: GroupFeed): number[] {
  const visibility = cfIsNumeric(feed.isPublic) ? cfToNumber(feed.isPublic) : undefined;
  return visibility === undefined ? [0, 1] : visibility === 0 || visibility === 1 ? [visibility] : [];
}

/** The FROM rows one cursor page of the `isPublic` pool yields: its groups through the interest and membership filters, the joins and the params. */
async function pageFeedRows(call: ApiCall, feed: GroupFeed, plan: FeedPlan, isPublic: number, page: readonly GroupRecord[]): Promise<FeedRow[]> {
  let groups = page;
  for (const [relation, column, list] of [['tusersinterests', 'categoryid', feed.categoryIds], ['tusersmemb', 'groupid', feed.groupIds]] as const) {
    if (list === '') continue;
    const items = subqueryItems(list);
    const rows = await relationRows(call, relation, isPublic, groups);
    groups = groups.filter((group) =>
      (rows.get(charKey(group.userid)) ?? []).some((row) => items.some((item) => compareText(String(row[column] ?? ''), item) === 0)),
    );
  }
  let rows: FeedRow[] = groups.map((group) => ({ group, joined: NO_JOINS }));
  for (const table of plan.joins) {
    const joined = await relationRows(call, table as GroupRelation, isPublic, groups);
    rows = rows.flatMap((row) => (joined.get(charKey(row.group.userid)) ?? []).map((child) => ({ group: row.group, joined: new Map([...row.joined, [table, child]]) })));
  }
  return rows.filter((row) => matchesParams(plan.params, row));
}

/** The FROM rows an extended feed selects in its order, before TOP: type 1 in the site's user pool(s), the S2, inactive, interest and membership filters, joins and params. */
async function extendedFeedRows(call: ApiCall, feed: GroupFeed, plan: FeedPlan): Promise<FeedSelection> {
  const generic = feed.distinct || plan.aggregate;
  if (plan.aggregate) {
    // beanIterator's getBean('group') takes the aggregate columns as values no userBean property holds (beanIterator.cfc:98-101).
    const fresh: GroupRecord = { ...newGroupRecord(call.deps.groups.clock, cfUuid()), type: 2, siteid: '' };
    return { rows: [{ group: fresh, joined: NO_JOINS }], generic };
  }
  const seen = new Set<string>();
  const selected: FeedRow[] = [];
  for (const isPublic of feedPools(feed)) {
    // scanFeedGroups visits each cursor page synchronously, so the pages' child rows are read once its scan ends.
    const pages: GroupRecord[][] = [];
    const scan = { siteId: call.siteId, isPublic, includeS2: call.caller.superUser, inactive: feed.inactive };
    await scanFeedGroups(call.deps.groups, scan, (rows) => {
      const unseen = rows.filter((group) => !seen.has(group.userid));
      for (const group of unseen) seen.add(group.userid);
      if (unseen.length > 0) pages.push(unseen);
    });
    for (let page = pages.shift(); page !== undefined; page = pages.shift()) {
      for (const row of await pageFeedRows(call, feed, plan, isPublic, page)) selected.push(row);
    }
  }
  selected
    // The clustered key order SQL Server returns ties in.
    .sort((a, b) => (a.group.userid < b.group.userid ? -1 : a.group.userid > b.group.userid ? 1 : 0))
    .sort((a, b) => compareRows(plan.keys, a, b));
  if (plan.keys.some((key) => key.joined)) {
    for (let i = 1; i < selected.length; i += 1) {
      const [a, b] = [selected[i - 1] as FeedRow, selected[i] as FeedRow];
      if (!cfEq(a.group.userid, b.group.userid) && compareRows(plan.keys, a, b) === 0) {
        throw feedRefused('Ordering groups by a joined column on which two groups tie', 'feed-join-sort-tie');
      }
    }
  }
  return { rows: selected, generic };
}

/** The `TOP maxItems` row limit, Infinity for none; MSSQL refuses a negative or fractional TOP. */
function topLimit(feed: GroupFeed): number {
  if (feed.maxItems === 0) return Infinity;
  if (!Number.isInteger(feed.maxItems) || feed.maxItems < 0) throw serverError();
  return feed.maxItems;
}

/** How many leading rows of the feed order `iteratorPage(count, nextN, params)` can address whatever the count; Infinity when its page size is the count. */
function addressableRows(nextN: number, params: Readonly<Struct>): number {
  let max: number | undefined = nextN !== 0 && Number.isFinite(nextN) ? nextN : undefined;
  const itemsPerPage = valueOf(params, 'itemsperpage');
  if (cfIsNumeric(itemsPerPage)) {
    const n = cfToNumber(itemsPerPage);
    max = n !== 0 ? n : undefined;
  } else if (itemsPerPage === '*') max = undefined;
  if (max === undefined) return Infinity;
  const size = max;
  // The iterator ends on page 1, `pageindex` or the page of `startindex`, and each position lies below that page times its size.
  const pages = [1];
  const page = valueOf(params, 'pageindex');
  if (cfIsNumeric(page)) pages.push(cfToNumber(page));
  const start = valueOf(params, 'startindex');
  if (cfIsNumeric(start)) {
    const startRow = cfToNumber(start);
    pages.push(size !== 1 ? Math.ceil(startRow / size) : startRow);
  }
  return Math.max(0, ...pages.map((n) => Math.ceil(n * size)));
}

/** A bounded max-heap keeping the first `limit` values of `order`; its root is the last value kept. */
interface FirstValues<T> {
  offer(value: T): void;
  /** The kept values in `order`. */
  sorted(): T[];
}

function firstValues<T>(limit: number, order: (a: T, b: T) => number): FirstValues<T> {
  const heap: T[] = [];
  const at = (i: number): T => heap[i] as T;
  const swap = (i: number, j: number): void => {
    [heap[i], heap[j]] = [at(j), at(i)];
  };
  return {
    offer(value: T): void {
      if (heap.length < limit) {
        heap.push(value);
        for (let i = heap.length - 1; i > 0; ) {
          const parent = Math.floor((i - 1) / 2);
          if (order(at(parent), at(i)) >= 0) break;
          swap(parent, i);
          i = parent;
        }
        return;
      }
      if (heap.length === 0 || order(value, at(0)) >= 0) return;
      heap[0] = value;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        let last = i;
        if (left < heap.length && order(at(left), at(last)) > 0) last = left;
        if (left + 1 < heap.length && order(at(left + 1), at(last)) > 0) last = left + 1;
        if (last === i) break;
        swap(i, last);
        i = last;
      }
    },
    sorted: (): T[] => [...heap].sort(order),
  };
}

/** An iterator page over a feed's selection and the leading rows of its order that hold every page position. */
interface FeedPage {
  page: IteratorPage;
  selection: FeedSelection;
}

/** The first `limit` groups of a plain feed's selection in its order, and how many groups it selects (each pool's count capped at `top`). */
interface FeedRows {
  rows: GroupRecord[];
  matched: number;
}

/** A plain feed's group_account filters and order, the whole WHERE and ORDER BY a FROM clause of `tusers` alone compiles. */
interface PlainFeed {
  filters: GroupFeedFilter[];
  keys: GroupFeedSortKey[];
}

/** The plan of a type 1 feed over `tusers` alone, or undefined when a distinct or aggregate select, a join or a subquery needs the extended feed. */
function plainFeedOf(feed: GroupFeed, plan: FeedPlan): PlainFeed | undefined {
  if (feed.distinct || plan.aggregate || plan.joins.length > 0 || feed.groupIds !== '' || feed.categoryIds !== '') return undefined;
  const filters: GroupFeedFilter[] = [];
  for (const { relationship, condition } of plan.params) {
    if (condition === undefined) return undefined;
    filters.push({ relationship, condition });
  }
  const keys: GroupFeedSortKey[] = [];
  for (const { column, type, desc } of plan.keys) {
    if (column === undefined) return undefined;
    keys.push({ column, type, desc });
  }
  return { filters, keys };
}

/** FeedRows of the pools in `flags`, each filtered, ordered, counted and cut by one identity statement, then merged. */
async function selectFeedRows(call: ApiCall, feed: GroupFeed, plain: PlainFeed, flags: readonly number[], top: number, limit: number): Promise<FeedRows> {
  const { filters, keys } = plain;
  const query: GroupFeedQuery = { includeS2: call.caller.superUser, inactive: feed.inactive, filters, order: keys, top, limit };
  const pools: FeedRows[] = [];
  for (const isPublic of flags) {
    const { rows, total } = await readFeedGroups(call.deps.groups, { siteId: call.siteId, isPublic }, query);
    pools.push({ rows, matched: total });
  }
  const matched = pools.reduce((sum, pool) => sum + pool.matched, 0);
  if (pools.length < 2) return { rows: pools[0]?.rows ?? [], matched };
  // The merged order's first `limit` rows lie among each pool's first `limit`.
  return { rows: pools.flatMap((pool) => pool.rows).sort((a, b) => feedOrder(keys, a, b)).slice(0, limit), matched };
}

/** FeedRows of the pools in `flags` from a cursor scan whose rows the feed's params test here, for params no SQL reproduces. */
async function scanFeedRows(call: ApiCall, feed: GroupFeed, params: readonly FeedParam[], plain: PlainFeed, flags: readonly number[], limit: number): Promise<FeedRows> {
  const kept = firstValues<GroupRecord>(limit, (a, b) => feedOrder(plain.keys, a, b));
  let matched = 0;
  for (const isPublic of flags) {
    const scan = { siteId: call.siteId, isPublic, includeS2: call.caller.superUser, inactive: feed.inactive };
    await scanFeedGroups(call.deps.groups, scan, (rows) => {
      for (const row of rows) {
        if (!matchesParams(params, { group: row, joined: NO_JOINS })) continue;
        matched += 1;
        kept.offer(row);
      }
    });
  }
  return { rows: kept.sorted(), matched };
}

/** The iterator page of `params` over a feed's FROM rows after its order and TOP; a plain feed holds only the rows the page can address. */
async function feedPage(call: ApiCall, feed: GroupFeed, params: Readonly<Struct>): Promise<FeedPage> {
  // A type other than 1 queries users, whose person columns are people data.
  if (!cfEq(feed.type, '1')) throw feedHalted('A user feed', 'user-feed');
  const plan = planFeed(call, feed);
  const plain = plainFeedOf(feed, plan);
  if (plain === undefined) {
    const selection = await extendedFeedRows(call, feed, plan);
    const rows = selection.rows.slice(0, topLimit(feed));
    return { page: iteratorPage(rows.length, feed.nextN, params), selection: { ...selection, rows } };
  }
  const top = topLimit(feed);
  const flags = feedPools(feed);
  const limit = Math.min(top, addressableRows(feed.nextN, params));
  const { rows, matched } = plain.filters.every(({ condition }) => isSqlExpressible(condition))
    ? await selectFeedRows(call, feed, plain, flags, top, limit)
    : await scanFeedRows(call, feed, plan.params, plain, flags, limit);
  const page = iteratorPage(Math.min(matched, top), feed.nextN, params);
  const last = page.positions.at(-1);
  if (last !== undefined && last >= rows.length) throw new Error(`Feed page position ${last} lies beyond the ${rows.length} rows kept`);
  return { page, selection: { rows: rows.map((group) => ({ group, joined: NO_JOINS })), generic: false } };
}

/** Whether `userBean.set` leaves `column` at its init value: setPasswordCreated and setKeepPrivate skip a NULL, setSubType a blank (userBean.cfc:541-556; beanExtendable.cfc:122-128). */
function keepsInitValue(column: string, value: unknown): boolean {
  if (column === 'passwordcreated' || column === 'keepprivate') return value === null || value === undefined;
  return column === 'subtype' && javaTrim(String(value ?? '')) === '';
}

/** A feed row as the iterator's bean: the selected columns set over a new bean's values; `isNew` 1 from userIterator, 0 from a generic iterator. */
function rowBean(call: ApiCall, row: FeedRow, feed: GroupFeed, generic: boolean): UserBean {
  const isNew = generic ? 0 : 1;
  const fresh = newGroupRecord(call.deps.groups.clock, '');
  const all = feed.fields.length === 0;
  const values: GroupRecord = all ? { ...row.group } : { ...fresh, type: 2, siteid: '' };
  const source = row.group as unknown as Readonly<Record<string, unknown>>;
  const initial = fresh as unknown as Readonly<Record<string, unknown>>;
  const target = values as unknown as Record<string, unknown>;
  for (const column of all ? Object.keys(source) : feed.fields) {
    target[column] = keepsInitValue(column, source[column]) ? initial[column] : source[column];
  }
  return all ? { values, isNew } : { values, isNew, photoFileExt: '' };
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

/** `packageIteratorArray` of a group iterator, `bean` the entity name of an aggregate page (jsonApiUtility.cfc:287-366). */
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
  result.entityname = isAggregatePage(call) ? 'bean' : 'group';
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

/**
 * packageIteratorArray's own base URL: url then form values, `pageIndex` left out, `method` reported as the operation; `packaged`
 * when getFilteredValues ran for an item, whose `param url.expanddepth` left a numeric depth in the url scope (jsonApiUtility.cfc:2227-2231).
 */
function scopeBaseUrl(call: ApiCall, operation: string, packaged: boolean): string {
  const merged: Struct = {};
  const order: string[] = [];
  const put = (key: string, value: unknown): void => {
    if (keyOf(merged, key) === undefined) order.push(key);
    setIn(merged, key, value);
  };
  for (const [key, value] of Object.entries(call.url)) put(key, textOf(value) ?? '');
  if (keyOf(call.url, 'entityname') === undefined) put('entityname', 'group');
  if (packaged && !cfIsNumeric(valueOf(call.url, 'expanddepth'))) put('expanddepth', '1');
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
        // setGroupID and setCategoryID trim the whole list (userFeedBean.cfc:183-210).
        feed.groupIds = javaTrim(criteria);
        return;
      case 'categoryid':
        feed.categoryIds = javaTrim(criteria);
        return;
      default:
        if (FAILING_SETTERS.includes(name)) throw serverError();
        if (INERT_SETTERS.includes(name)) return;
    }
  }
  // The `tag` alias names tuserstags.tag (userFeedBean.cfc:102); any other datatype is the tusers column's of the field's last name.
  const alias = name === 'tag';
  const dataType = alias ? 'varchar' : (TUSERS_COLUMNS.get(cfListLast(field, '.').toLowerCase()) ?? 'varchar');
  const named = alias ? 'tuserstags.tag' : field;
  // formatField qualifies a tusers column name.
  feed.params.push({ field: TUSERS_COLUMNS.has(named.toLowerCase()) ? `tusers.${named}` : named, relationship, condition, criteria, dataType });
}

/** `feed.aggregate(kind, property)`: each item of a non-blank list (beanFeed.cfc:697-733). */
function addAggregate(feed: GroupFeed, kind: string, property: string): void {
  if (javaTrim(property) === '') return;
  feed.aggregates[kind.toLowerCase() as AggregateKind].push(...cfListToArray(property).map(javaTrim));
}

/** findQuery's feed and base URL, built from `cgi.QUERY_STRING` in order (jsonApiUtility.cfc:2712-2905); `argumentDeleted` when a bracketed name deleted the `siteid` or `expand` argument. */
function queryFeed(call: ApiCall): { feed: GroupFeed; baseUrl: string; argumentDeleted: boolean } {
  const feed = newGroupFeed();
  const url = call.url;
  let baseUrl = `${call.endpoint}/group/?`;
  let started = false;
  let relationship: 'and' | 'or' = 'and';
  let advancedSort = '';
  let argumentDeleted = false;
  const names = cfListToArray(queryStringOf(call.request), '&')
    .map((item) => cfUrlDecode(cfListFirst(item, '=')))
    .filter((name) => name.toLowerCase() !== 'pageindex');
  for (const name of names) {
    let propName = name;
    if (name.includes('[')) {
      // A bracketed name acts under its base name and deletes the argument its base and index spell (jsonApiUtility.cfc:2817-2824).
      propName = cfListFirst(name, '[');
      const deleted = `${propName}${cfListFirst(cfListLast(name, '['), ']')}`.toLowerCase();
      // The next statement dereferences the deleted params argument.
      if (deleted === 'params') throw serverError();
      if (deleted === 'siteid' || deleted === 'expand') argumentDeleted = true;
      // Deleting the expanded or queryString argument changes what the rest of findQuery reads in ways the CFML runtime decides.
      if (deleted === 'expanded' || deleted === 'querystring') {
        throw feedHalted(`The bracketed name ${name}, which deletes findQuery's ${deleted} argument,`, 'feed-cfml-argument');
      }
    }
    const key = keyOf(url, name);
    if (key === undefined) continue;
    const value = textOf(url[key]) ?? '';
    baseUrl += `${started ? '&' : ''}${esapiUrlEncode(name)}`;
    started = true;
    if (value !== '') baseUrl += `=${esapiUrlEncode(value)}`;
    if (listHasNoCase(QUERY_EXCLUDED, propName)) continue;
    if (cfEq(propName, 'sort')) {
      advancedSort = advancedSort === '' ? value : `${advancedSort},${value}`;
    } else if (cfEq(propName, 'or')) {
      relationship = 'or';
    } else if (listHasNoCase(GROUPING_NAMES, propName)) {
      // A grouping param has no field, so getAdvancedSearch skips it as invalid.
      relationship = 'and';
    } else if (listHasNoCase(AGGREGATE_NAMES, propName)) {
      addAggregate(feed, propName, value);
      // innerJoin and leftJoin add nothing: userBean declares no related entity (beanFeed.cfc:652-686).
    } else if (!cfEq(propName, 'innerJoin') && !cfEq(propName, 'leftJoin')) {
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
      addFeedParam(feed, cfEq(propName, 'id') ? 'userid' : propName, criteria, condition, relationship);
      relationship = 'and';
    }
  }
  const props: Struct = { ...url };
  if (advancedSort !== '') setIn(props, 'sort', advancedSort);
  applyFeedProps(feed, props);
  return { feed, baseUrl, argumentDeleted };
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

/** The items of one iterator page, as getFilteredValues serializes each row under `configName`, the find's `entity.getEntityName()`. */
function pageItems(call: ApiCall, selection: FeedSelection, feed: GroupFeed, page: IteratorPage, configName: 'group' | 'user' = 'group'): Struct[] {
  return page.positions.map((position) =>
    filteredValues(call, rowBean(call, selection.rows[position] as FeedRow, feed, selection.generic), {
      configName,
      editableCheck: false,
      urlFields: true,
    }),
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
  const { page, selection } = await feedPage(call, feed, call.url);
  const items = pageItems(call, selection, feed, page);
  return packagePage(call, page, items, scopeBaseUrl(call, 'findall', items.length > 0));
}

/** findQuery(entityName='group') (jsonApiUtility.cfc:2712-2920). */
async function findQuery(call: ApiCall): Promise<Struct> {
  defaultUrlEntity(call);
  requireUsersModule(call);
  rejectOffset(call);
  const { feed, baseUrl, argumentDeleted } = queryFeed(call);
  if (argumentDeleted) {
    // The iteratorToArray call reads the deleted siteid or expand argument once the query has run, whatever it selected or failed on (jsonApiUtility.cfc:2914).
    authorizedJoins(feed);
    throw serverError();
  }
  const { page, selection } = await feedPage(call, feed, call.url);
  return packagePage(call, page, pageItems(call, selection, feed, page), baseUrl);
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
  feed.params.push({ field: 'tusers.userid', relationship: 'and', condition: 'in', criteria: ids, dataType: 'varchar' });
  applyFeedProps(feed, call.url);
  const { page, selection } = await feedPage(call, feed, call.url);
  // findMany never sets the entity's type, so its userBean names itself `user` (jsonApiUtility.cfc:2643-2648,2675-2679; userBean.cfc:799-810).
  const items = pageItems(call, selection, feed, page, 'user');
  const sort = textOf(valueOf(call.url, 'sort'));
  const ordered =
    sort !== undefined && sort !== ''
      ? items
      : cfListToArray(ids).flatMap((id) => {
          const match = items.find((item) => cfEq(String(valueOf(item, 'id')), id));
          return match === undefined ? [] : [match];
        });
  return packagePage(call, page, ordered, scopeBaseUrl(call, 'findmany', items.length > 0));
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

/** `loadBy(userid=id)`: the stored group and its tenant, or null for an unknown id; an id naming a user, whose person columns are people data, raises `refuseUser(id)`. */
async function locateLoadedGroup(call: ApiCall, id: string, refuseUser: (id: string) => LegacyServiceUnavailableError): Promise<GroupLocation | null> {
  if (id === '') return null;
  const located = await findGroupForSite(call.deps.groups, { groupId: id, siteId: call.siteId });
  if (located !== null) return located;
  if (isCfUuid(id) && (await namesStoredUser(call, id))) throw refuseUser(id);
  return null;
}

const USER_RECORD_EXCEPTION = 'EX-GROUP-USER-RECORD';

/** A group read or save of a user record, whose person columns are people data: the target refuses it. */
export function userRecordRefused(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} is refused (${USER_RECORD_EXCEPTION})`, 'auto', reason);
}

/** The refusal of a group read or save whose id names a user. */
function loadedUserRefused(user: string): LegacyServiceUnavailableError {
  return userRecordRefused(`JSON API group ${user}, which names a user,`, 'group-api-user-record');
}

/** `loadBy(userid=id)`: the stored group, or null for an unknown id. */
async function loadGroup(call: ApiCall, id: string): Promise<GroupRecord | null> {
  return (await locateLoadedGroup(call, id, loadedUserRefused))?.group ?? null;
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
  if (!cfEq(type, '1')) throw userRecordRefused(`A JSON API group save of ${id}, which writes a user record,`, 'group-save-user');
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

/** `urlDecode`, `isJSON` and `deserializeJSON` of a validate argument; `invalidParameters` when it is not JSON (jsonApiUtility.cfc:3705-3721). */
function jsonArgument(text: string): CfValue | null {
  const value = deserializeCfJson(cfUrlDecode(text));
  if (value === undefined) throw new LegacyApiError('invalidParameters');
  return value;
}

/** A simple value as a `string` argument or a comparison reads it; a complex one raises. */
function simpleArgument(value: CfValue): string {
  if (!isSimple(value)) throw serverError();
  return simpleText(value);
}

/** Whether `data` posts a complex value for `name`. */
function postsComplex(data: CfStruct, name: string): boolean {
  const value = data.get(name);
  return value !== null && value !== undefined && !isSimple(value);
}

/** The site `getBean('Mura').init(siteid)` builds its event for: a struct is the event's own data; other complex values raise (MuraScope.cfc:85-96; event.cfc:82-99). */
function eventSiteOf(call: ApiCall, siteValue: CfValue): string {
  if (!(siteValue instanceof CfStruct)) return simpleArgument(siteValue);
  const own = siteValue.get('siteid');
  return own === null || own === undefined ? call.siteId : simpleArgument(own);
}

/** fileManager `isPostedFile(name)`: a posted form field whose value's last `.` item is tmp or upload, as a file field's is, or such a name (fileManager.cfc:651-654). */
function isPostedFile(call: ApiCall, name: string): boolean {
  const upload = (text: string): boolean => listHasNoCase(['tmp', 'upload'], cfListLast(text, '.'));
  if (upload(name) || multipartFilesOf(call.request).some(({ field }) => cfEq(field, name))) return true;
  const posted = valueOf(scopeOf(call.request.body), name);
  return posted !== undefined && upload(Array.isArray(posted) ? posted.join(',') : String(posted));
}

/** `en` text of `user.emailrequired` [legacy: core/mura/resourceBundle/resources/en.properties:1744]. */
const EMAIL_REQUIRED_TEXT = "The 'Email Address' field is required.";

/** userBean properties `hasProperty` finds, lower-cased (userBean.cfc:78-120; beanExtendable.cfc:80-86; bean.cfc:79-82). */
const USER_BEAN_PROPERTIES: ReadonlySet<string> = new Set([
  'userid', 'remoteid', 'groupname', 'fname', 'lname', 'username', 'password', 'passwordcreated', 'email', 'company', 'jobtitle', 'website',
  'mobilephone', 'type', 'subtype', 's2', 'contactformat', 'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'created', 'perm',
  'inactive', 'ispublic', 'siteid', 'subscribe', 'notes', 'categoryid', 'primaryaddressid', 'addressid', 'addresses', 'description',
  'interests', 'photofileid', 'photofileext', 'keepprivate', 'imname', 'imservice', 'extenddatatable', 'isnew', 'tablist', 'newfile',
  'extenddata', 'extendsetid', 'extendautocomplete', 'errors', 'frommuracache', 'instanceid',
]);

/** A `tusers` date as CFML date text. */
function cfDateText(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** A `tusers` column value as the bean holds it; NULL reads as ''. */
function cfColumnValue(value: unknown): CfValue {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return new CfNumber(String(value), value);
  if (value instanceof Date) return cfDateText(value);
  if (typeof value === 'boolean') return value;
  return String(value);
}

/** The userBean whose `getValue` results `values` holds by lower-cased property. */
function validatedUserBean(values: ReadonlyMap<string, CfValue>): ValidatedBean {
  return {
    value: (property) => values.get(property.toLowerCase()) ?? '',
    hasProperty: (property) => USER_BEAN_PROPERTIES.has(property.toLowerCase()),
  };
}

/** A new userBean's init values; `contactFormat` and the other unset properties read '' (userBean.cfc:128-180). */
function newUserBeanValues(userId: string, siteId: string, now: Date): Map<string, CfValue> {
  const zero = new CfNumber('0', 0);
  const one = new CfNumber('1', 1);
  const at = cfDateText(now);
  return new Map<string, CfValue>([
    ['userid', userId], ['passwordcreated', at], ['type', new CfNumber('2', 2)], ['subtype', 'Default'], ['s2', zero], ['lastupdate', at],
    ['created', at], ['perm', zero], ['inactive', zero], ['ispublic', one], ['siteid', siteId], ['subscribe', one], ['addresses', CF_QUERY],
    ['keepprivate', zero], ['extenddatatable', 'tclassextenddatauseractivity'], ['isnew', one],
  ]);
}

/**
 * userBean `validate()` of the bean `loadBy` left (userBean.cfc:446-500): a stored group with the interest list `setUserBeanMetaData`
 * gives it (userDAO.cfc:924-933), or a new type 2 bean; `siteOverride` is `set('siteid', …)`'s non-empty argument.
 */
async function validateLoaded(call: ApiCall, context: ValidationContext, located: GroupLocation | null, newUserId: string, siteOverride?: string): Promise<ValidationErrors> {
  // bean.cfc validate's stricthtml pass reads every property of the bean (bean.cfc:511-523).
  if (call.settings.strictHtml === true) throw validateRefused('A userBean validation under stricthtml', 'validate-stricthtml');
  const { db, repo, clock } = call.deps.groups;
  if (located === null) {
    const siteId = siteOverride ?? call.siteId;
    const usernameMessage = messageFormat(EN_ACCOUNT_MESSAGES['user.usernamevalidate'], '');
    return validateUserBean(validatedUserBean(newUserBeanValues(newUserId, siteId, clock.now())), context, {
      siteId: javaTrim(siteId),
      newUser: { usernameMessage, emailMessage: EMAIL_REQUIRED_TEXT },
    });
  }
  const { tenantId, group } = located;
  // validateExtendedData checks the group's extended values against strategies-content's attribute definitions (extendManager.cfc:362-440).
  if (await withTenant(db, tenantId, (tx) => repo.hasGroupExtendData(tx, group.userid))) {
    throw validateRefused(`Validating group ${group.userid}, which holds extended values`, 'validate-extended-data');
  }
  // A posted simple categoryID or photoFileExt passes its string rule whatever the bean holds, so only a complex one reads them.
  const categoryId = postsComplex(context.data, 'categoryid') ? (await withTenant(db, tenantId, (tx) => repo.groupInterestIds(tx, group.userid))).join(',') : '';
  const photoFileExt = postsComplex(context.data, 'photofileext') ? String(beanValue({ values: group, isNew: 0 }, 'photofileext')) : '';
  const siteId = siteOverride ?? group.siteid ?? '';
  // userDAO's field list loads every column but the password (userDAO.cfc:78).
  const record: Readonly<Record<string, unknown>> = { ...group, siteid: siteId };
  const values = new Map<string, CfValue>([...BEAN_COLUMNS].map((key) => [key, cfColumnValue(record[key])]));
  values.set('extenddatatable', 'tclassextenddatauseractivity');
  values.set('addresses', CF_QUERY);
  values.set('categoryid', categoryId);
  values.set('photofileext', photoFileExt);
  values.set('isnew', new CfNumber('0', 0));
  // Setters that skip a NULL column keep the init value (userBean.cfc:541-556; beanExtendable.cfc:122-128).
  if (group.passwordcreated === null) values.set('passwordcreated', cfDateText(clock.now()));
  if (group.keepprivate === null) values.set('keepprivate', new CfNumber('0', 0));
  if (javaTrim(group.subtype ?? '') === '') values.set('subtype', 'Default');
  return validateUserBean(validatedUserBean(values), context, { siteId: javaTrim(siteId) });
}

/** The refusal of a validation whose `loadBy` id names a user, whose rules read person columns people owns. */
function validatedUserRefused(user: string): LegacyServiceUnavailableError {
  return validateRefused(`Validating user ${user}`, 'validate-user-record');
}

/** The entity branch: `getBean(entityname)`, a fresh primary key, `loadBy`, `set('siteid')`, then the bean's `validate()` (jsonApiUtility.cfc:3736-3765). */
async function validateEntity(call: ApiCall, data: CfStruct, context: ValidationContext, entityName: string): Promise<ValidationErrors> {
  assertBeanName(entityName);
  if (!data.has('userid')) data.set('userid', cfUuid());
  requireUsersModule(call);
  // loadBy(userid) and setSiteID take `string` arguments.
  const id = simpleArgument(data.get('userid') as CfValue);
  const located = await locateLoadedGroup(call, id, validatedUserRefused);
  // beanExtendable.setValue trims the site before setSiteID, which ignores '' (beanExtendable.cfc:131-137,236-247).
  const posted = javaTrim(simpleArgument(data.get('siteid') as CfValue));
  return validateLoaded(call, context, located, id, posted === '' ? undefined : posted);
}

/** `getBean(name)` of a validate call: the group and user beans are identity's; `''` names no bean. */
function assertBeanName(name: string): void {
  if (name === '') throw serverError();
  if (!cfEq(name, 'group') && !cfEq(name, 'user')) throw validateHalted(`Validating a ${name} entity`, 'validate-entity');
}

/** `userManager.read` of loadBy's two arguments: by name in the site's user pools when a site is known, else by id (userManager.cfc:125-170). */
async function loadByLookup(call: ApiCall, loadBy: string, value: CfValue, siteValue: CfValue): Promise<GroupLocation | null> {
  const key = loadBy.toLowerCase();
  // read()'s typed arguments raise for a complex value.
  if (['userid', 'username', 'remoteid', 'siteid', 'groupname', 'ispublic', 'groupid'].includes(key)) simpleArgument(value);
  const siteId = simpleArgument(siteValue);
  if (key === 'username' || key === 'groupname' || key === 'remoteid') {
    const text = simpleArgument(value);
    if (text === '') return null;
    // read() takes the session's siteID for an empty one.
    if (siteId === '') throw validateHalted('A loadby name lookup without a site', 'validate-session-site');
    const { groups, accounts } = await findPoolRows(call.deps.groups, { siteId, column: key, value: text });
    // More than one row leaves loadBy's bean new, as none does.
    if (groups.length + accounts !== 1) return null;
    const [group] = groups;
    if (group === undefined) throw validateRefused(`A loadby ${key} lookup matching one user`, 'validate-loadby-user');
    return group;
  }
  if (key === 'userid' || key === 'groupid') return locateLoadedGroup(call, simpleArgument(value), validatedUserRefused);
  return null;
}

/** The loadby branch: the denylist, `getBean(bean)`, `loadBy` of `data[loadby]` and the site, then the bean's `validate()` (jsonApiUtility.cfc:3783-3805). */
async function validateLoadBy(call: ApiCall, data: CfStruct, context: ValidationContext, beanName: string, loadBy: string): Promise<ValidationErrors> {
  if (listHasNoCase(['orderby', 'returnFormat', 'cachedWithin'], loadBy)) throw new LegacyApiError('invalidParameters');
  assertBeanName(beanName);
  const value = data.get(loadBy);
  // `arguments.data[arguments.data.loadby]` of a missing key raises.
  if (value === null || value === undefined) throw serverError();
  requireUsersModule(call);
  const located = await loadByLookup(call, loadBy, value, data.get('siteid') as CfValue);
  return validateLoaded(call, context, located, cfUuid());
}

/** validate(data, validations) as a `group.validate` call reaches it (jsonApiUtility.cfc:3703-3808). */
async function validate(call: ApiCall): Promise<Struct> {
  const data = jsonArgument(call.params.data ?? '{}');
  const validations = jsonArgument(call.params.validations ?? '{}');
  if (!(data instanceof CfStruct) || !(validations instanceof CfStruct)) return { invalid: 'Invalid validation request' };
  // The `param` defaults land in the data struct, which is the validation context (jsonApiUtility.cfc:3727-3736).
  if (!data.has('fields')) data.set('fields', '');
  if (!data.has('siteid')) data.set('siteid', call.siteId);
  assertSitelessEvent(call, eventSiteOf(call, data.get('siteid') as CfValue));
  const context: ValidationContext = { data, isPostedFile: (name) => isPostedFile(call, name) };
  const entityName = data.get('entityname');
  if (entityName !== null && entityName !== undefined && !cfEq(simpleArgument(entityName), 'bean')) {
    return errorsObject(await validateEntity(call, data, context, simpleArgument(entityName)));
  }
  const errors: ValidationErrors = new CfStruct();
  if (validations.size > 0) {
    const ids = { instanceId: cfUuid(), validationContextId: cfUuid() };
    appendErrors(errors, validateAdHoc(validations, context, data.get('fields') as CfValue, ids));
  }
  const beanName = data.get('bean');
  const loadBy = data.get('loadby');
  if (beanName !== null && beanName !== undefined && loadBy !== null && loadBy !== undefined && !cfEq(simpleArgument(beanName), 'bean')) {
    appendErrors(errors, await validateLoadBy(call, data, context, simpleArgument(beanName), simpleArgument(loadBy)));
  }
  return errorsObject(errors);
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

const LOCKDOWN_EXCEPTION = 'EX-LOGIN-LOCKDOWN';

/** A passed session-based lockdown check, whose `session.passedLockdown` legacy's site lockdown reads: the target refuses it (userUtility.cfc:210-212; sessionUserFacade.cfc:178-185). */
export function lockdownRefused(): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`A session-based lockdown check is refused (${LOCKDOWN_EXCEPTION})`, 'auto', 'login-session-lockdown');
}

/** login(username, password, siteid, lockdownCheck): the CSRF check under context `login`, then the session's credential login or lockdown check (jsonApiUtility.cfc:1856-1870). */
async function loginMethod(call: ApiCall): Promise<Struct> {
  if (!(await validateCsrfForRoute({ csrf: call.deps.csrf }, call.request, 'login'))) {
    // Legacy's own misspelling.
    return { status: 'Invalid CSFR Tokens' };
  }
  // A valid token implies the caller's session; its id is kept across the login, as legacy keeps it.
  const request = {
    username: call.params.username ?? '',
    password: call.params.password ?? '',
    siteId: call.siteId,
    sessionId: call.caller.user?.sid ?? '',
    mode: 'target-primary',
  } as const;
  const check = call.params.lockdowncheck;
  if (check === undefined || (cfIsBoolean(check) && !cfToBoolean(check))) {
    return { status: (await login(call.deps.login, request)).ok ? 'success' : 'failed' };
  }
  // A lockdown check passes instead of logging in (userUtility.cfc:207-221).
  const result = await lockdownLogin(call.deps.login, {
    ...request,
    lockdown: cfIsBoolean(check) ? 'check' : 'unreadable',
    sessionBased: call.settings.sessionBasedLockdown !== false,
  });
  if (result.ok) return { status: 'success' };
  // `not arguments.lockdownCheck` raises for a value CFML cannot read as a boolean.
  if (result.reason === 'unreadable') throw serverError();
  if (result.reason === 'session-lockdown') throw lockdownRefused();
  return { status: 'failed' };
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

/**
 * findCurrentUser(): people's `readCurrentUser` of the token's own user, which skips findOne's allowAccess and allowRead,
 * with identity's membership ids as its `groupid`, plus the session's role lists (jsonApiUtility.cfc:2268-2290, 2366-2378).
 */
async function findCurrentUserMethod(call: ApiCall): Promise<SerializedLegacyResponse> {
  const { caller } = call;
  const query: Record<string, string> = { siteid: call.siteId, endpoint: call.endpoint, adminpath: call.adminPath };
  for (const name of ['fields', 'expand', 'expanddepth']) {
    const value = textOf(valueOf(call.url, name));
    if (value !== undefined) query[name] = value;
  }
  // userDAO.read's `groupid` is identity's membership data, which people reads from identity only for cUsers callers.
  if (caller.user !== undefined && caller.userId !== '') query.groupids = (await tokenMembershipIds(call.deps.groups, caller.user, caller.userId)).join(',');
  const response = await call.deps.client.request<unknown>({ service: 'people', method: 'GET', path: '/internal/v1/users/current', query });
  if (response.status === 503) throw unavailable('People answered the current user read with 503', 'people-unavailable');
  const data = isRecord(response.body) ? valueOf(response.body, 'data') : undefined;
  if (response.status !== 200 || !isRecord(data)) throw new Error(`People answered the current user read with ${response.status} and no data struct`);
  assertNoHumanCheck(call);
  const method = call.method ?? 'findCurrentUser';
  const snapshot = caller.user === undefined || caller.user.sid === '' ? undefined : await sessionSnapshot(call.deps.sessions, caller.user.sid);
  const user: Struct = { ...data };
  setIn(user, 'memberships', snapshot === undefined ? [] : cfListToArray(snapshot.user.memberships));
  setIn(user, 'membershipids', snapshot === undefined ? [] : cfListToArray(snapshot.user.membershipids));
  setIn(user, 'isloggedin', snapshot === undefined ? false : snapshot.user.isLoggedIn);
  return serializeResponse(buildEnvelope({ method, params: paramsWithoutMethod(call.params), data: user }), {
    useDataNamespace: call.params.usedatanamespace,
    serializer: createApiSerializer(numberHints(data)),
    keyOrder: 'acf',
  });
}

/** validateEmail(email): BriteVerify's `filecontent` as a JSON string, sent as is, with the empty `mmpBrightVerifyAPIKey` identity holds (jsonApiUtility.cfc:1831-1854). */
async function validateEmailMethod(call: ApiCall): Promise<SerializedLegacyResponse> {
  const email = requiredArgument(call, 'email');
  const fetcher = call.deps.fetch ?? globalThis.fetch;
  // One deadline bounds the exchange and its body, even for a fetch that ignores the signal.
  const deadline = AbortSignal.timeout(call.deps.validateEmailTimeoutMs ?? SERVICE_CALL_TIMEOUT_MS);
  let fileContent: string;
  try {
    // cfhttp interpolates the values unencoded.
    const exchange = fetcher(`https://bpi.briteverify.com/emails.json?address=${email}&apikey=`, { method: 'GET', signal: deadline });
    fileContent = await untilAborted(exchange.then((answer) => answer.text()), deadline);
  } catch {
    // ACF reports an unreachable or outlasted host through `filecontent`, not an exception.
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
  if (isRecord(data)) assertSitelessEvent(call, call.apiSite);
  return serializeResponse(buildEnvelope({ method: call.method ?? 'undefined', params: paramsWithoutMethod(call.params), data }), {
    useDataNamespace: call.params.usedatanamespace,
    serializer: groupSerializer(),
    keyOrder: 'acf',
  });
}

/** One of the methods identity serves, invoked by name (jsonApiUtility.cfc:869-900). */
async function namedAnswer(call: ApiCall, name: NamedMethod): Promise<SerializedLegacyResponse> {
  // Each method but logout builds its event first: validateEmail's of the API site, the others' of params.siteid.
  if (name !== 'logout') assertSitelessEvent(call, name === 'validateemail' ? call.apiSite : call.siteId);
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

/** A `group` operation, as a direct method or on the entity route, which sets `params.method` first except on the `<id>/permissions` path (jsonApiUtility.cfc:1006-1009, 1240-1314). */
async function groupAnswer(call: ApiCall, operation: GroupOperation): Promise<SerializedLegacyResponse> {
  const permissionsPath = !call.direct && operation === 'findPermissions' && !cfEq(call.params.id ?? '', 'permissions');
  if (!call.direct && !permissionsPath) call.method = operation;
  // findProperties builds no event of its own; validate builds its event after reading its arguments.
  if (operation !== 'findProperties' && operation !== 'validate') assertSitelessEvent(call, call.siteId);
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
  assertSitelessEvent(call, call.apiSite);
  // The entity route answers 403 when the result carries errors.
  return serializeSaveResult(
    { method: operation, params: call.params, data },
    { useDataNamespace: call.params.usedatanamespace, serializer: groupSerializer(), keyOrder: 'acf' },
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
    reply.headers(originEcho(request.headers, registry, settings.adminDomain));
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
      isRegisteredSite: (siteId) => lookup(siteId) !== undefined,
      direct: operation !== undefined && !dotted && params.method !== undefined && cfEq(params.method, operation),
      method: params.method,
      methodCtx,
      ...urlsOf(request, restMode ? 'rest' : 'json', apiSite),
      settings,
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
      request.log.error({ error: serializeError(err) }, 'unhandled JSON API error');
      // catch (Any e) reports params.method as the failing operation had set it.
      return sendLegacyResponse(reply, legacyErrorResponse('server_error', { method: call.method, params, methodCtx }));
    }
  }

  for (const prefix of legacyApiPrefixes(settings.context)) {
    app.route({
      method: [...HTTP_METHODS],
      // The router reads `:` as a parameter, so a context's literal colon is doubled.
      url: `${prefix.replaceAll(':', '::')}*`,
      config: { opt2: { ...ROUTE_AUTH } },
      onSend: allowOrigin,
      handler: handle,
    });
  }
}
