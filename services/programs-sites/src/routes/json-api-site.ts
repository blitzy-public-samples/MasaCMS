/** JSON API `site` entity routes: every generic method of the site entity as Masa's jsonApiUtility serves it. */
import { assertSiteMatches, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  accessControlOriginDomains,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  corsHeaders,
  isCfUuid,
  isLegacyFindOneId,
  routeKeyForRequest,
  serializeResponse,
  type ApiNameContext,
  type LegacyApiErrorType,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import {
  EnvValidationError,
  csrfPreHandler,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registeredTenants, registryEntries, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { SiteColumnTruncationError, type SitesDomain } from '../domain/sites.js';
import {
  addFeedParam,
  applyFeedProps,
  applyQueryParams,
  feedRows,
  isAggregateQuery,
  iteratorPage,
  newSiteFeed,
  packagePage,
  queryRow,
  rowAt,
  scopeBaseUrl,
  serverError,
  topRows,
  urlValue,
  type FeedSource,
  type IteratorPage,
  type PoolRequest,
  type SiteFeed,
  type UrlScope,
} from '../legacy/json-api-site-feed.js';
import {
  canWriteSite,
  isSiteAdmin,
  jsonApiBaseUrl,
  jsonApiEnvelope,
  jsonApiGenericValues,
  jsonApiSaveValues,
  jsonApiSitePermissions,
  jsonApiSiteProperties,
  jsonApiSiteValues,
  jsonApiValidate,
  type JsonApiEndpointInput,
  type JsonApiMode,
  type JsonApiSiteValues,
} from '../legacy/json-api-site.js';
import { applySet, getSiteText, getSiteValue, newSiteBean, readBean, type SiteBean, type SiteRow } from '../legacy/site-fields.js';
import { hasSiteErrors } from '../legacy/validation.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';

/** configBean and application settings the endpoint URL, the route key and the CORS allow-list read. */
export interface JsonApiLegacySettings {
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

/** Dependencies of {@link registerJsonApiSiteRoutes}. */
export interface JsonApiSiteRouteDeps {
  db: TenantDb;
  repository: ProgramsSitesRepository;
  sites: SitesDomain;
  /** Defaults to {@link jsonApiLegacySettings} over `process.env`. */
  legacy?: JsonApiLegacySettings;
}

/** Leads of the JSON API paths, without and with the front controller; the app matches them ignoring case, as legacy does. */
export const JSON_API_SITE_PREFIXES: readonly string[] = Object.freeze(
  (['json', 'ajax', 'rest'] as const).flatMap((family) => [`/_api/${family}/v1`, `/index.cfm/_api/${family}/v1`]),
);

/** Every path under a JSON API lead, which contentServer hands to the API by its first 13 characters; the route key picks the operation. */
export const JSON_API_SITE_PATHS: readonly string[] = Object.freeze(JSON_API_SITE_PREFIXES.map((prefix) => `${prefix}*`));

/** Methods a `site` key can arrive with: a three-segment path is findOne under any verb (jsonApiUtility.cfc:399). */
const JSON_API_SITE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] as const;

// The entity is public (jsonApiUtility.cfc:69-73); the handler runs the site check itself, after the API site fallback.
const ROUTE_AUTH: Opt2RouteConfig = { transport: 'service', public: true, siteCheck: false };

type Operation =
  | 'findOne'
  | 'findAll'
  | 'findMany'
  | 'findQuery'
  | 'findNew'
  | 'findProperties'
  | 'findPermissions'
  | 'validate'
  | 'delete'
  | 'save'
  | 'none';

/** The `site` route-key bodies served here: each generic method, and the verbs the entity switch calls nothing for (jsonApiUtility.cfc:1242-1304). */
const OPERATIONS: ReadonlyMap<string, Operation> = new Map([
  ...(
    ['findOne', 'findAll', 'findMany', 'findQuery', 'findNew', 'findProperties', 'findPermissions', 'validate', 'delete', 'save'] as const
  ).map((operation): [string, Operation] => [`site.${operation.toLowerCase()}`, operation]),
  ...['head', 'options', 'patch'].map((verb): [string, Operation] => [`site.http-${verb}`, 'none']),
]);

/** Route-key error bodies and the legacy exception types processRequest throws for them. */
const RESOLUTION_ERRORS: ReadonlyMap<string, LegacyApiErrorType> = new Map([
  ['!invalidparameters', 'invalidParameters'],
  ['!invalidmethodcall', 'invalidMethodCall'],
  ['!invalidentitycall', 'invalidEntityCall'],
  ['!server_error', 'server_error'],
]);

/** A site of this service's registry. */
interface RegisteredSite {
  tenantId: string;
  siteId: string;
}

/** The registry as one request reads it; origin domains are read only for a request with an Origin. */
type RegistrySnapshot = ReadonlyArray<RegisteredSite & { domains?: string[] }>;

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
  .transform((env): JsonApiLegacySettings => ({
    adminSSL: env.MURA_ADMINSSL !== undefined && !BLANK.test(env.MURA_ADMINSSL) && cfToBoolean(env.MURA_ADMINSSL),
    // The template's port is ${cgi.SERVER_PORT}, which the servlet takes from the request host.
    ...(env.MURA_PORT === undefined ? {} : { serverPort: serverPortSetting(env.MURA_PORT) }),
    context: env.MURA_CONTEXT === undefined || BLANK.test(env.MURA_CONTEXT) ? '' : cleanFilePath(env.MURA_CONTEXT),
    appReloadKey: env.MURA_APPRELOADKEY ?? 'appreload',
    adminDomain: env.MURA_ADMINDOMAIN === undefined || BLANK.test(env.MURA_ADMINDOMAIN) ? '' : env.MURA_ADMINDOMAIN,
  }));

/**
 * The settings from `MURA_<KEY>` variables, which override settings.ini.cfm, else the settings template values.
 * Throws EnvValidationError naming each malformed variable.
 */
export function jsonApiLegacySettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): JsonApiLegacySettings {
  const parsed = LEGACY_SETTINGS.safeParse(env);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new EnvValidationError(issues, 'programs-sites');
}

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

/** A parsed query or form body as a route-key scope; anything else is an empty scope. */
function scopeOf(source: unknown): Record<string, string | string[]> {
  const scope = Object.create(null) as Record<string, string | string[]>;
  if (!isRecord(source)) return scope;
  for (const [key, value] of Object.entries(source)) {
    scope[key] = Array.isArray(value) ? value.map(scopeText) : scopeText(value);
  }
  return scope;
}

function isJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
}

/** The request facts the shared route key is derived from, url, form and JSON body kept apart as legacy reads them. */
function routeKeyRequestOf(request: FastifyRequest): RouteKeyRequest {
  const json = isJsonRequest(request);
  return {
    method: request.method,
    path: request.url.split('?', 1)[0] ?? '',
    query: scopeOf(request.query),
    form: json ? {} : scopeOf(request.body),
    jsonBody: json ? request.body : undefined,
    headers: request.headers,
    multipartFileNames: multipartFilesOf(request).map(({ field, filename }) => ({ field, filename })),
  };
}

/** Every `siteid` the request supplies, as the CFML scopes hold them: path, url, form, then a JSON body. */
function suppliedSiteIds(request: FastifyRequest, keyed: RouteKeyRequest): string[] {
  const path = isRecord(request.params) ? request.params.siteid : undefined;
  const json = isRecord(keyed.jsonBody) ? scopeOf(keyed.jsonBody) : {};
  const sources: unknown[] = [path];
  for (const scope of [keyed.query, keyed.form ?? {}, json]) {
    for (const [name, value] of Object.entries(scope)) {
      if (name.toLowerCase() === 'siteid') sources.push(Array.isArray(value) ? value.join(',') : value);
    }
  }
  return sources.filter((value): value is string => typeof value === 'string');
}

/** The first value of header `name`. */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** `utility.getRequestProtocol()` (utility.cfc:481-500). */
function requestProtocolOf(request: FastifyRequest): string {
  if (headerValue(request, 'x-forwarded-proto')?.toLowerCase() === 'https') return 'https';
  const frontEnd = headerValue(request, 'front-end-https');
  if (frontEnd !== undefined && cfIsBoolean(frontEnd) && cfToBoolean(frontEnd)) return 'https';
  return request.protocol;
}

/** The client's host as the gateway forwards it, `X-Forwarded-Host` before the hop's own `Host`. */
function clientHostOf(request: FastifyRequest): { name: string; port: string } {
  const host = (headerValue(request, 'x-forwarded-host') || headerValue(request, 'host') || '').split(',')[0]?.trim() ?? '';
  const match = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(host);
  return { name: match?.[1] ?? host, port: match?.[2] ?? '' };
}

/** configBean.getCurrentAdminDomain() (configBean.cfc:517-525): the host's name on an admin domain, else the host. */
function currentAdminDomainOf(request: FastifyRequest, adminDomain: string): string {
  const { name, port } = clientHostOf(request);
  const onAdminDomain = adminDomain.split(',').some((domain) => domain.toLowerCase() === name.toLowerCase());
  return onAdminDomain || port === '' ? name : `${name}:${port}`;
}

/** The request and configBean parts of getEndPoint's URL (jsonApiUtility.cfc:3337-3364). */
function endpointOf(
  request: FastifyRequest,
  settings: JsonApiLegacySettings,
): Omit<JsonApiEndpointInput, 'mode' | 'siteId'> {
  const host = clientHostOf(request);
  return {
    requestProtocol: requestProtocolOf(request),
    adminSSL: settings.adminSSL,
    serverName: host.name,
    serverPort: settings.serverPort ?? serverPortSetting(host.port),
    context: settings.context,
  };
}

/** SQL Server `siteid = ?` under its case-insensitive collation, trailing spaces ignored. */
function sameSiteId(a: string, b: string): boolean {
  return a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** The request's own parameter `name`, ignoring case, before legacy resolution rewrites it. */
function requestParam(request: FastifyRequest, name: string): unknown {
  const params = legacyParamsOf(request);
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : params[key];
}

function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** One resolved `site` call: who asks, the addressed site and how legacy reports the response. */
interface SiteCall {
  request: FastifyRequest;
  reply: FastifyReply;
  /** The merged, resolved request params. */
  params: Record<string, string>;
  user: UserClaims | undefined;
  /** The addressed site as registered. */
  site: RegisteredSite;
  /** The addressed site id as the request spells it, which the response reports. */
  scopeSiteId: string;
  tenantId: string;
  /** json and ajax modes are session-managed; rest is sessionless (applicationSettings.cfm:179). */
  sessionManaged: boolean;
  /** Invoked as a direct method, which always answers 200 with the method as requested (jsonApiUtility.cfc:870-898). */
  direct: boolean;
  /** `params.method` as the response reports it. */
  reported: string;
  baseUrl: string;
  methodCtx: ApiNameContext;
  /** The url scope as the request sent it. */
  url: UrlScope;
  /** The JSON API instance's site, as registered. */
  apiSite: RegisteredSite;
  /** The registered site `siteId` names, ignoring case. */
  lookup: (siteId: string) => RegisteredSite | undefined;
}

type StoredSite = Awaited<ReturnType<ProgramsSitesRepository['readSite']>>;

/** The url scope of a request: names as sent, a repeated name's values joined with `,` as CFML joins them. */
function urlScopeOf(request: FastifyRequest): Record<string, string> {
  const url: Record<string, string> = {};
  for (const [name, value] of Object.entries(scopeOf(request.query))) {
    Object.defineProperty(url, name, { value: Array.isArray(value) ? value.join(',') : value, writable: true, enumerable: true, configurable: true });
  }
  return url;
}

/** The raw query string `cgi.QUERY_STRING` holds. */
function queryStringOf(request: FastifyRequest): string {
  const at = request.url.indexOf('?');
  return at < 0 ? '' : request.url.slice(at + 1);
}

/** Whether a direct call's resolution set param `key` after `structAppend(form, params)`: no request scope or `X-` header carries it (jsonApiUtility.cfc:845-891). */
function setAfterFormCopy(call: SiteCall, key: string): boolean {
  if (!call.direct || requestParam(call.request, key) !== undefined) return false;
  return headerValue(call.request, `x-${key}`) === undefined && headerValue(call.request, `x-${key.replace(/_/g, '-')}`) === undefined;
}

/** ColdFusion's `form.fieldnames`: each posted field name once, ignoring case, upper-cased in posting order; none without a form body. */
function postedFieldNames(request: FastifyRequest): string[] {
  if (isJsonRequest(request)) return [];
  const names: string[] = [];
  for (const name of Object.keys(scopeOf(request.body))) {
    const upper = name.toUpperCase();
    if (!names.includes(upper)) names.push(upper);
  }
  return names;
}

/** The form scope packageIteratorArray reads: the resolved params structAppend copied into it, and the posted `fieldnames`. */
function formScopeOf(call: SiteCall): Record<string, string> {
  const form = Object.fromEntries(Object.entries(call.params).filter(([key]) => !setAfterFormCopy(call, key)));
  const names = postedFieldNames(call.request);
  if (names.length > 0) {
    // The servlet's own list replaces a posted `fieldnames` field.
    const key = Object.keys(form).find((name) => name.toLowerCase() === 'fieldnames') ?? 'fieldnames';
    form[key] = names.join(',');
  }
  return form;
}

/**
 * `$.getBean('site').loadBy(...)`: the scope seeds the bean with the request's site id (cfobject.cfc:138-149), and
 * setSiteID keeps it over the stored id it equals ignoring case; the defaulted new bean when no row is stored.
 */
function loadedBean(row: StoredSite, scopeSiteId: string): SiteBean {
  const bean = row === null ? newSiteBean() : readBean(row);
  return { values: { ...bean.values, siteid: scopeSiteId }, isNew: bean.isNew };
}

/** Registers the contract's JSON API `site` routes; every mode and path shares one handler. */
export async function registerJsonApiSiteRoutes(app: FastifyInstance, deps: JsonApiSiteRouteDeps): Promise<void> {
  const settings = deps.legacy ?? jsonApiLegacySettings();
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

  function readSiteRow(tenantId: string, site: RegisteredSite): Promise<StoredSite> {
    return withTenant(deps.db, tenantId, (tx) => deps.repository.readSite(tx, site.siteId));
  }

  /** The tenant a read of `site` runs under: the call's for the addressed site, else the site's own. */
  function tenantFor(call: SiteCall, site: RegisteredSite): string {
    return sameSiteId(site.siteId, call.site.siteId) ? call.tenantId : site.tenantId;
  }

  /** The stored rows and settings a site feed of `call` reads. */
  function feedSource(call: SiteCall): FeedSource {
    const storedRow = async (siteId: string): Promise<StoredSite> => {
      // SQL Server's `siteID in (…)` ignores trailing spaces.
      const site = call.lookup(siteId.replace(/ +$/, ''));
      return site === undefined ? null : readSiteRow(tenantFor(call, site), site);
    };
    return {
      async rows(siteIds) {
        const rows: SiteRow[] = [];
        for (const siteId of siteIds) {
          const row = await storedRow(siteId);
          if (row !== null && !rows.some((seen) => sameSiteId(String(seen.siteid), String(row.siteid)))) rows.push(row);
        }
        return rows;
      },
      async contentPool(siteId) {
        const row = await storedRow(siteId);
        return row === null ? undefined : getSiteText(readBean(row), 'contentPoolID');
      },
    };
  }

  /** serializeResponse of `data` in the envelope legacy builds, sent with `status`. */
  function respond(call: SiteCall, data: unknown, status = 200): FastifyReply {
    const envelope = jsonApiEnvelope(call.reported, data, call.params.usedatanamespace);
    // The envelope already has its final shape and order, so the serializer neither flattens nor reorders it.
    return sendLegacyResponse(call.reply, serializeResponse(envelope, { statusCode: status, useDataNamespace: 'true' }));
  }

  /** `$.validateCSRFTokens(context)` of a session-managed write; a refused token is `invalidTokens`. */
  async function consumeCsrf(call: SiteCall, context: string): Promise<void> {
    const consumeToken = csrfPreHandler({
      contextOf: () => context,
      onReject: () => {
        throw new LegacyApiError('invalidTokens', { method: call.reported, methodCtx: call.methodCtx });
      },
    });
    await consumeToken.call(call.request.server, call.request, call.reply);
  }

  /** findOne(entityName='site'): the site the merged `siteid` names (jsonApiUtility.cfc:2292-2382). */
  async function findOne(call: SiteCall): Promise<FastifyReply> {
    const bean = loadedBean(await readSiteRow(call.tenantId, call.site), call.scopeSiteId);
    assertNoHumanCheck(call);
    return respond(call, jsonApiSiteValues(bean, call.baseUrl, call.params.entityname ?? 'site'));
  }

  /** findNew(entityName='site'): a new bean seeded with the scope's site id (jsonApiUtility.cfc:2386-2422). */
  function findNew(call: SiteCall): FastifyReply {
    assertNoHumanCheck(call);
    return respond(call, jsonApiSiteValues(loadedBean(null, call.scopeSiteId), call.baseUrl));
  }

  /** findProperties(entityname, properties) of the site entity (jsonApiUtility.cfc:1548-1622). */
  function findProperties(call: SiteCall): FastifyReply {
    const { user } = call;
    const showTable = user !== undefined && (canWriteSite(user) || isSiteAdmin(user));
    const entityName = call.params.entityname ?? 'site';
    return respond(call, jsonApiSiteProperties({ properties: call.params.properties, entityName, baseUrl: call.baseUrl, showTable }));
  }

  /** findPermissions(entityName='site', id) (jsonApiUtility.cfc:2240-2266). */
  function findPermissions(call: SiteCall): FastifyReply {
    // isValid('UUID', arguments.id) reads an undefined argument.
    if (call.params.id === undefined) throw serverError();
    return respond(call, jsonApiSitePermissions(call.user !== undefined && canWriteSite(call.user)));
  }

  /** validate(data, validations, siteid) (jsonApiUtility.cfc:3703-3808); a JSON body's struct arguments arrive as sent. */
  function validate(call: SiteCall): FastifyReply {
    const argument = (name: string): unknown => {
      const raw = requestParam(call.request, name);
      return typeof raw === 'object' && raw !== null ? raw : call.params[name];
    };
    return respond(call, jsonApiValidate({ data: argument('data'), validations: argument('validations'), siteId: call.scopeSiteId }));
  }

  /** delete(entityName='site', id): a stored site needs a super user and, in session modes, the id's CSRF token; it then fails (jsonApiUtility.cfc:3259-3335). */
  async function deleteSite(call: SiteCall): Promise<FastifyReply> {
    const { params } = call;
    // `var csrfcontext=arguments.id` reads an undefined argument.
    if (params.id === undefined) throw serverError();
    const scopeId = params.siteid ?? '';
    const id = scopeId !== '' && isCfUuid(scopeId) ? scopeId : params.id;
    const target = call.lookup(id.replace(/ +$/, ''));
    const stored = target === undefined ? null : await readSiteRow(tenantFor(call, target), target);
    if (stored === null) return respond(call, '');
    if (call.user === undefined || !canWriteSite(call.user)) throw new LegacyApiError('authorization');
    if (call.sessionManaged) await consumeCsrf(call, params.id);
    // settingsBean defines no delete(), so the call raises before anything is written.
    throw serverError();
  }

  /** `url.ishuman` renders the CFML form-protection include into the result (jsonApiUtility.cfc:2373-2376, 2414-2417). */
  function assertNoHumanCheck(call: SiteCall): void {
    if (urlValue(call.url, 'ishuman') !== undefined) throw unavailable('The ishuman field renders a CFML display object', 'cfml-render');
  }

  /** The API site's own `contentPoolID`, which bounds a listed `contentpoolid` (jsonApiUtility.cfc:2968-2985). */
  async function poolsOf(call: SiteCall, url: UrlScope, source: FeedSource): Promise<PoolRequest> {
    const requested = urlValue(url, 'contentpoolid') ?? '';
    const validPools = requested === '' || requested === '*' ? '' : ((await source.contentPool(call.apiSite.siteId)) ?? '');
    return { validPools };
  }

  /** setIteratorProps reads an undefined `feed` for a numeric `offset` (jsonApiUtility.cfc:3177-3179). */
  function rejectOffset(url: UrlScope): void {
    const offset = urlValue(url, 'offset');
    if (offset !== undefined && cfIsNumeric(offset)) throw serverError();
  }

  /** The items of one iterator page through getFilteredValues; a distinct feed iterates generic beans (beanFeed.cfc:441-462). */
  function pageItems(call: SiteCall, feed: SiteFeed, rows: readonly SiteRow[], page: IteratorPage): JsonApiSiteValues[] {
    return page.positions.map((position) => {
      const row = queryRow(feed, rowAt(rows, position));
      if (feed.distinct) return jsonApiGenericValues(row, call.baseUrl);
      // beanIterator.packageRecord: getBean('site').set(row).setIsNew(0).
      return jsonApiSiteValues({ values: applySet(newSiteBean(), row).values, isNew: 0 }, call.baseUrl);
    });
  }

  /** The url scope after a find defaults `entityname` and, once an item serializes, getFilteredValues defaults `expanddepth`. */
  function resultUrl(call: SiteCall, items: number): Record<string, string> {
    const url: Record<string, string> = { ...call.url };
    if (urlValue(url, 'entityname') === undefined) url.entityname = call.params.entityname ?? 'site';
    if (items > 0) {
      const key = Object.keys(url).find((name) => name.toLowerCase() === 'expanddepth');
      if (key === undefined) url.expanddepth = '1';
      else if (!cfIsNumeric(url[key])) url[key] = '1';
    }
    return url;
  }

  /** One collection answer: the page packaged with the feed's iterator entity and the self link `baseUrl`. */
  function respondPage(call: SiteCall, feed: SiteFeed, page: IteratorPage, items: unknown[], baseUrl: string): FastifyReply {
    const aggregate = isAggregateQuery(call.url, queryStringOf(call.request));
    const iteratorEntity = feed.distinct ? 'bean' : 'site';
    return respond(call, packagePage(page, items, { aggregate, iteratorEntity, endpoint: call.baseUrl, baseUrl }));
  }

  /** `countOnly` as a find reads it: a true CFML boolean answers the feed's count alone. */
  function countOnly(url: UrlScope): boolean {
    const value = urlValue(url, 'countonly');
    return value !== undefined && cfIsBoolean(value) && cfToBoolean(value);
  }

  /** findAll(entityName='site'): the scope site's feed (jsonApiUtility.cfc:2542-2623). */
  async function findAll(call: SiteCall): Promise<FastifyReply> {
    const source = feedSource(call);
    const feed = newSiteFeed(call.scopeSiteId);
    applyFeedProps(feed, call.url, await poolsOf(call, call.url, source));
    if (countOnly(call.url)) return respond(call, { count: (await feedRows(feed, source, true)).length });
    const rows = topRows(feed, await feedRows(feed, source));
    rejectOffset(call.url);
    const page = iteratorPage(rows.length, feed.nextN, call.url);
    const items = pageItems(call, feed, rows, page);
    return respondPage(call, feed, page, items, scopeBaseUrl(call.baseUrl, resultUrl(call, items.length), formScopeOf(call), 'findall'));
  }

  /** findMany(entityName='site', ids): the listed ids of the scope site's feed, in list order unless sorted (jsonApiUtility.cfc:2625-2709). */
  async function findMany(call: SiteCall): Promise<FastifyReply> {
    const { ids } = call.params;
    // addParam(criteria=arguments.ids) reads an undefined argument.
    if (ids === undefined) throw serverError();
    const source = feedSource(call);
    const feed = newSiteFeed(call.scopeSiteId);
    addFeedParam(feed, 'siteid', ids, 'in');
    applyFeedProps(feed, call.url, await poolsOf(call, call.url, source));
    const rows = topRows(feed, await feedRows(feed, source));
    rejectOffset(call.url);
    const page = iteratorPage(rows.length, feed.nextN, call.url);
    const items = pageItems(call, feed, rows, page);
    const sorted = (urlValue(call.url, 'sort') ?? '') !== '';
    const ordered = sorted
      ? items
      : cfListToArray(ids).flatMap((id) => {
          const match = items.find((item) => cfEq(item.id, id));
          return match === undefined ? [] : [match];
        });
    return respondPage(call, feed, page, ordered, scopeBaseUrl(call.baseUrl, resultUrl(call, items.length), formScopeOf(call), 'findmany'));
  }

  /** findQuery(entityName='site'): the scope site's feed filtered by the query string's params (jsonApiUtility.cfc:2711-2905). */
  async function findQuery(call: SiteCall): Promise<FastifyReply> {
    const source = feedSource(call);
    const feed = newSiteFeed(call.scopeSiteId);
    const { url, baseUrl } = applyQueryParams(feed, resultUrl(call, 0), queryStringOf(call.request), call.baseUrl);
    applyFeedProps(feed, url, await poolsOf(call, url, source));
    if (countOnly(url)) return respond(call, { count: (await feedRows(feed, source, true)).length });
    const rows = topRows(feed, await feedRows(feed, source));
    rejectOffset(url);
    // iteratorToArray serializes a generic bean's every column, which the entity-typed serializer here does not reproduce.
    if (feed.distinct) throw unavailable('A distinct site findQuery serializes every tsettings column of generic beans', 'site-feed-distinct-query');
    const page = iteratorPage(rows.length, feed.nextN, url);
    return respondPage(call, feed, page, pageItems(call, feed, rows, page), baseUrl);
  }

  /** save(entityName='site') of an existing site, an update through the gated domain (jsonApiUtility.cfc:1903-2075). */
  async function save(call: SiteCall): Promise<FastifyReply> {
    const { params, site, user } = call;
    const csrfContext = params.id ?? 'new';
    // A uuid site id replaces the id; `new` mints a uuid site id, which creates a site (jsonApiUtility.cfc:1957-1965).
    const id = isLegacyFindOneId(call.scopeSiteId) ? call.scopeSiteId : csrfContext;
    if (cfEq(id, 'new')) throw unavailable('A JSON API site save without an id creates a site', 'site-create');
    // loadBy(siteid=id) then set(event) saves site `id`'s values, or a new bean's defaults, into the addressed site.
    if (!sameSiteId(id, site.siteId)) throw unavailable('A JSON API site save copies another site', 'site-copy');
    const stored = await readSiteRow(call.tenantId, site);
    // settingsManager.save creates a site that has no tsettings row (settingsManager.cfc:807-830).
    if (stored === null) throw unavailable('A JSON API site save of a site without a row creates it', 'site-create');
    if (call.sessionManaged) await consumeCsrf(call, csrfContext);
    if (user === undefined || !canWriteSite(user)) throw new LegacyApiError('authorization');
    // The JSON API save sets no request locale, so date text is read in the server locale.
    const result = await deps.sites.updateSite(deps.db, user, site.siteId, params, { locale: '' }).catch((error: unknown) => {
      if (!(error instanceof SiteColumnTruncationError)) throw error;
      // processRequest's catch (Any) logs the error and reports the request's method (jsonApiUtility.cfc:1390-1399).
      call.request.log.error({ error: serializeError(error) }, 'unhandled error');
      throw new LegacyApiError('server_error', { method: call.reported, methodCtx: call.methodCtx });
    });
    const saveErrors = getSiteValue(applySet(readBean(stored), params), 'saveErrors');
    const reloaded = loadedBean(await readSiteRow(call.tenantId, site), call.scopeSiteId);
    const reapply = !(cfIsBoolean(saveErrors) && cfToBoolean(saveErrors)) && hasSiteErrors(result.errors);
    const bean = reapply ? applySet(reloaded, params) : reloaded;
    // The entity route answers 403 when the result carries errors; a direct call always answers 200 (jsonApiUtility.cfc:1308-1313).
    const status = !call.direct && hasSiteErrors(result.errors) ? 403 : 200;
    return respond(call, jsonApiSaveValues(bean, call.baseUrl, saveErrors, result.errors), status);
  }

  /** The served operation of a resolved call. */
  function dispatch(call: SiteCall, operation: Operation): FastifyReply | Promise<FastifyReply> {
    switch (operation) {
      case 'findOne':
        return findOne(call);
      case 'findAll':
        return findAll(call);
      case 'findMany':
        return findMany(call);
      case 'findQuery':
        return findQuery(call);
      case 'findNew':
        return findNew(call);
      case 'findProperties':
        return findProperties(call);
      case 'findPermissions':
        return findPermissions(call);
      case 'validate':
        return validate(call);
      case 'delete':
        return deleteSite(call);
      case 'save':
        return save(call);
      case 'none':
        return respond(call, '');
    }
  }

  /** processRequest's resolution through the shared route key, then the served operation. */
  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const registry = new Map((await registryOf(request)).map((entry) => [entry.siteId.toLowerCase(), entry]));
    const lookup = (siteId: string): RegisteredSite | undefined => registry.get(siteId.toLowerCase());
    const keyed = routeKeyRequestOf(request);
    const key = routeKeyForRequest(keyed, {
      siteExists: (siteId) => lookup(siteId) !== undefined,
      context: settings.context,
      appReloadKey: settings.appReloadKey,
    });
    if (key.family !== 'api' && key.family !== 'rest') {
      throw unavailable(`Route ${key.key} is not served by programs-sites`, 'not-carried');
    }
    const user = request.opt2Auth.user;
    const apiSiteId = key.siteId ?? 'default';
    if (user !== undefined) {
      assertSiteMatches(apiSiteId, user);
      // An unregistered siteid only selects the `default` fallback; a registered one must be the token's site.
      for (const supplied of suppliedSiteIds(request, keyed)) {
        if (lookup(supplied) !== undefined) assertSiteMatches(supplied, user);
      }
    }

    const { params } = key;
    const restMode = key.family === 'rest';
    const methodCtx: ApiNameContext = { hasOrigin: request.headers.origin !== undefined, restMode };
    const body = key.baseKey.slice(key.family.length + 1);
    const failure = RESOLUTION_ERRORS.get(body);
    if (failure !== undefined) throw new LegacyApiError(failure, { method: params.method, methodCtx });
    const operation = OPERATIONS.get(body);
    // A key of no entity, or of another entity, has another owner or stays with legacy.
    if (operation === undefined) throw unavailable(`JSON API ${key.key} is not served by programs-sites`, 'not-carried');
    const requested = requestParam(request, 'method');
    // A dotted method (site.<m>) rewrites the path and resolves as the entity route (jsonApiUtility.cfc:953-961).
    const dotted = typeof requested === 'string' && requested.includes('.');
    const method = params.method;
    const direct = !dotted && method !== undefined && method.toLowerCase() === operation.toLowerCase();
    const apiSite = lookup(apiSiteId) ?? { tenantId: '', siteId: apiSiteId };
    // A direct method without a siteid takes the API instance's stored site id (jsonApiUtility.cfc:883).
    const scopeSiteId = direct && requestParam(request, 'siteid') === undefined ? apiSite.siteId : (params.siteid ?? '');
    const site = lookup(scopeSiteId);
    if (site === undefined) throw new LegacyApiError('invalidParameters', { method: params.method, methodCtx });
    if (user !== undefined) assertSiteMatches(site.siteId, user);

    const mode: JsonApiMode = restMode ? 'rest' : 'json';
    // An entity route reports the method it set; a verb it has no case for leaves params.method as resolved.
    const reported = direct ? method : operation === 'none' ? (method ?? 'undefined') : operation;
    const call: SiteCall = {
      request,
      reply,
      params,
      user,
      site,
      scopeSiteId,
      tenantId: user?.tid ?? site.tenantId,
      sessionManaged: !restMode,
      direct,
      reported,
      baseUrl: jsonApiBaseUrl({ ...endpointOf(request, settings), mode, siteId: apiSite.siteId }),
      methodCtx,
      url: urlScopeOf(request),
      apiSite,
      lookup,
    };
    try {
      return await dispatch(call, operation);
    } catch (error) {
      // processRequest's catch blocks report params.method, which the call has set by now.
      if (error instanceof LegacyApiError && error.method === undefined) {
        const { params: errorParams, wwwAuthenticate, data } = error;
        throw new LegacyApiError(error.type, { method: reported, methodCtx, params: errorParams, wwwAuthenticate, data });
      }
      throw error;
    }
  }

  for (const url of JSON_API_SITE_PATHS) {
    app.route({
      method: [...JSON_API_SITE_METHODS],
      url,
      config: { opt2: { ...ROUTE_AUTH } },
      onSend: [allowOrigin, headersOnly],
      handler: handle,
    });
  }
}

/** A HEAD answer keeps the GET answer's status and headers, ETag included, and sends no body or length, as legacy's chunked answer does. */
async function headersOnly(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (request.method !== 'HEAD') return payload;
  reply.removeHeader('content-length');
  return null;
}
