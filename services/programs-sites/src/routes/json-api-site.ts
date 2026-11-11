/** JSON API `site` entity routes: findOne and save (update) of a site as Masa's jsonApiUtility serves them. */
import { assertSiteMatches, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  buildEnvelope,
  cfEq,
  cfIsBoolean,
  cfToBoolean,
  isLegacyFindOneId,
  paramsWithoutMethod,
  routeKeyForRequest,
  serializeResponse,
  serializeSaveResult,
  type ApiNameContext,
  type LegacyApiErrorType,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import {
  csrfPreHandler,
  legacyParamsOf,
  multipartFilesOf,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registeredTenants, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { SitesDomain } from '../domain/sites.js';
import {
  canWriteSite,
  jsonApiBaseUrl,
  jsonApiSiteValues,
  type JsonApiEndpointInput,
  type JsonApiMode,
} from '../legacy/json-api-site.js';
import { applySet, getSiteValue, newSiteBean, readBean, type SiteBean } from '../legacy/site-fields.js';
import { hasSiteErrors } from '../legacy/validation.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';

/** configBean and application settings the endpoint URL and the route key read. */
export interface JsonApiLegacySettings {
  /** configBean `adminSSL`. */
  readonly adminSSL: boolean;
  /** configBean `serverPort`, `':8080'` or `''`; undefined takes the request host's port. */
  readonly serverPort?: string;
  /** configBean `context`, e.g. `''` or `'/masa'`. */
  readonly context: string;
  /** `application.appreloadkey`. */
  readonly appReloadKey: string;
}

/** Dependencies of {@link registerJsonApiSiteRoutes}. */
export interface JsonApiSiteRouteDeps {
  db: TenantDb;
  repository: ProgramsSitesRepository;
  sites: SitesDomain;
  /** Defaults to {@link jsonApiLegacySettings} over `process.env`. */
  legacy?: JsonApiLegacySettings;
}

/** Path templates of the contract's JSON API `site` operations, each GET and POST; forms it omits stay with legacy. */
export const JSON_API_SITE_PATHS: readonly string[] = Object.freeze(
  (['json', 'ajax', 'rest'] as const).map((family) => `/_api/${family}/v1/:siteid/site`),
);

const JSON_API_SITE_METHODS = ['GET', 'POST'] as const;

// The entity is public (jsonApiUtility.cfc:69-73); the handler runs the site check itself, after the API site fallback.
const ROUTE_AUTH: Opt2RouteConfig = { transport: 'service', public: true, siteCheck: false };

type Operation = 'findOne' | 'save';

/** The route-key bodies this module serves; every other key stays on legacy. */
const OPERATIONS: ReadonlyMap<string, Operation> = new Map([
  ['site.findone', 'findOne'],
  ['site.save', 'save'],
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

/** The settings from `MURA_<KEY>` variables, which override settings.ini.cfm, else the settings template values. */
export function jsonApiLegacySettings(env: Readonly<Record<string, string | undefined>> = process.env): JsonApiLegacySettings {
  const adminSSL = literal(env.MURA_ADMINSSL) ?? 'false';
  const port = literal(env.MURA_PORT);
  return {
    adminSSL: cfIsBoolean(adminSSL) && cfToBoolean(adminSSL),
    // The template's port is ${cgi.SERVER_PORT}, which the servlet takes from the request host.
    ...(port === undefined ? {} : { serverPort: serverPortSetting(port) }),
    context: cleanFilePath(literal(env.MURA_CONTEXT) ?? ''),
    appReloadKey: env.MURA_APPRELOADKEY ?? 'appreload',
  };
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
}

type StoredSite = Awaited<ReturnType<ProgramsSitesRepository['readSite']>>;

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

  function readSiteRow(tenantId: string, site: RegisteredSite): Promise<StoredSite> {
    return withTenant(deps.db, tenantId, (tx) => deps.repository.readSite(tx, site.siteId));
  }

  /** findOne(entityName='site'): the site the merged `siteid` names (jsonApiUtility.cfc:2292-2382). */
  async function findOne(call: SiteCall): Promise<FastifyReply> {
    const bean = loadedBean(await readSiteRow(call.tenantId, call.site), call.scopeSiteId);
    const envelope = buildEnvelope({
      method: call.reported,
      params: paramsWithoutMethod(call.params),
      data: jsonApiSiteValues(bean, call.baseUrl),
    });
    return sendLegacyResponse(call.reply, serializeResponse(envelope, { useDataNamespace: call.params.usedatanamespace }));
  }

  /** save(entityName='site') of an existing site, an update through the gated domain (jsonApiUtility.cfc:1903-2075). */
  async function save(call: SiteCall): Promise<FastifyReply> {
    const { request, reply, params, site, user, reported, methodCtx } = call;
    const csrfContext = params.id ?? 'new';
    // A uuid site id replaces the id; `new` mints a uuid site id, which creates a site (jsonApiUtility.cfc:1957-1965).
    const id = isLegacyFindOneId(call.scopeSiteId) ? call.scopeSiteId : csrfContext;
    if (cfEq(id, 'new')) throw unavailable('A JSON API site save without an id creates a site', 'site-create');
    // loadBy(siteid=id) then set(event) saves site `id`'s values, or a new bean's defaults, into the addressed site.
    if (!sameSiteId(id, site.siteId)) throw unavailable('A JSON API site save copies another site', 'site-copy');
    const stored = await readSiteRow(call.tenantId, site);
    // settingsManager.save creates a site that has no tsettings row (settingsManager.cfc:807-830).
    if (stored === null) throw unavailable('A JSON API site save of a site without a row creates it', 'site-create');
    if (call.sessionManaged) {
      const consumeToken = csrfPreHandler({
        contextOf: () => csrfContext,
        onReject: () => {
          throw new LegacyApiError('invalidTokens', { method: reported, methodCtx });
        },
      });
      await consumeToken.call(request.server, request, reply);
    }
    if (user === undefined || !canWriteSite(user)) {
      throw new LegacyApiError('authorization', { method: reported, methodCtx });
    }
    const result = await deps.sites.updateSite(deps.db, user, site.siteId, params);
    const saveErrors = getSiteValue(applySet(readBean(stored), params), 'saveErrors');
    const reloaded = loadedBean(await readSiteRow(call.tenantId, site), call.scopeSiteId);
    const reapply = !(cfIsBoolean(saveErrors) && cfToBoolean(saveErrors)) && hasSiteErrors(result.errors);
    const bean = reapply ? applySet(reloaded, params) : reloaded;
    const data = { ...jsonApiSiteValues(bean, call.baseUrl), saveErrors, errors: result.errors };
    const options = { useDataNamespace: params.usedatanamespace };
    const response = call.direct
      ? serializeResponse(buildEnvelope({ method: reported, params: paramsWithoutMethod(params), data }), options)
      : serializeSaveResult({ method: reported, params, data }, options);
    return sendLegacyResponse(reply, response);
  }

  /** processRequest's resolution through the shared route key, then the served operation. */
  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const registry = new Map((await registeredTenants(deps.db)).map((entry) => [entry.siteId.toLowerCase(), entry]));
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
    // site.delete spans every owner, and every other method addressing the site stays with legacy.
    if (operation === undefined) throw unavailable(`JSON API ${key.key} is not served by programs-sites`, 'not-carried');
    const requested = requestParam(request, 'method');
    // A dotted method (site.<m>) rewrites the path and resolves as the entity route (jsonApiUtility.cfc:953-961).
    const dotted = typeof requested === 'string' && requested.includes('.');
    const method = params.method;
    const direct = !dotted && method !== undefined && method.toLowerCase() === operation.toLowerCase();
    const apiSite = lookup(apiSiteId)?.siteId ?? apiSiteId;
    // A direct method without a siteid takes the API instance's stored site id (jsonApiUtility.cfc:883).
    const scopeSiteId = direct && requestParam(request, 'siteid') === undefined ? apiSite : (params.siteid ?? '');
    const site = lookup(scopeSiteId);
    if (site === undefined) throw new LegacyApiError('invalidParameters', { method: params.method, methodCtx });
    if (user !== undefined) assertSiteMatches(site.siteId, user);

    const mode: JsonApiMode = restMode ? 'rest' : 'json';
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
      reported: direct ? method : operation,
      baseUrl: jsonApiBaseUrl({ ...endpointOf(request, settings), mode, siteId: apiSite }),
      methodCtx,
    };
    return operation === 'findOne' ? findOne(call) : save(call);
  }

  for (const url of JSON_API_SITE_PATHS) {
    app.route({ method: [...JSON_API_SITE_METHODS], url, config: { opt2: { ...ROUTE_AUTH } }, handler: handle });
  }
}
