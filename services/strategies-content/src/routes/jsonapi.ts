/**
 * Front controller of the JSON API families strategies-content carries (`/_api/json/v1`, `/_api/ajax/v1`, `/_api/rest/v1`):
 * each request is resolved as jsonApiUtility.processRequest resolves it (core/mura/client/api/json/v1/jsonApiUtility.cfc:368-1402)
 * through the shared route key, then answered by the entity and method handlers of ./jsonapi/.
 */
import { AuthDenial, Roles, assertSiteMatches, suppliedSiteIdsOf, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  IMAGE_UPLOAD_CONDITION,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  WWW_AUTHENTICATE,
  accessControlOriginDomains,
  acfKeyOrder,
  buildEnvelope,
  canonicalMethodName,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfToBoolean,
  corsHeaders,
  fallbackSiteId,
  isDefinedApiName,
  isGenericMethod,
  isJsonContentType,
  isValidVariableName,
  legacyErrorResponse,
  legacyScopeParams,
  legacyScopeValue,
  legacyScopesFrom,
  paramsWithoutMethod,
  portcullisScan,
  scannedRouteKey,
  serializeResponse,
  type ApiNameContext,
  type LegacyApiErrorType,
  type RouteKeyOptions,
  type RouteKeyResult,
  type SerializedLegacyResponse,
  type StructOp,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  EnvValidationError,
  RequestAbortedError,
  csrfPreHandler,
  multipartFilesOf,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registryEntries, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import { ContentNotFoundError, type Actor, type SiteContentSettings } from '../domain/context.js';
import type { LegacySiteUrlConfig } from '../legacy/content-urls.js';
import { contentEntities, getContentEntityConfig, isContentEntity } from '../legacy/jsonapi-entities.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../legacy/jsonapi-serializers.js';
import { createSitesClient, type SitesClient } from '../legacy/sites-client.js';
import type { ContentRouteContext } from './index.js';
import {
  CONTENT_METHOD_HANDLERS,
  createJsonApiParams,
  entityActionAllowed,
  lookupEntityHandler,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiMode,
  type JsonApiParams,
  type JsonApiResult,
} from './jsonapi/index.js';

type Struct = Record<string, unknown>;

/** API families in handleAPIRequest order (contentServer.cfc:593-636). */
const FAMILIES: readonly JsonApiMode[] = Object.freeze(['json', 'ajax', 'rest']);

/** Leads of the JSON API paths; the app routes them in any letter case (`noCasePathPrefixes`), as legacy compares them. */
export const JSON_API_PREFIXES: readonly string[] = Object.freeze(FAMILIES.map((family) => `/_api/${family}/v1`));

/** Methods of the contract's JSON API operations. */
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

// Public: legacy authorises inside the API, after the `default` site fallback, which the automatic site check would precede.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ public: true, transport: 'service', siteCheck: false });

/** Remote functions of contentCommentBean (contentCommentBean.cfc:317-430), the only remote functions of a content entity. */
const ENTITY_REMOTE_FUNCTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  comment: Object.freeze(['delete', 'undelete', 'flag', 'markAsSpam', 'unMarkAsSpam']),
});

/** The `{upload=image}` variant of a JSON API `file` save, which stays legacy-written under EX-FILE-RENDITION. */
const IMAGE_UPLOAD_VARIANT = 'upload=image';

const VARIANTS: readonly VariantDeclaration[] = Object.freeze(
  ['api', 'rest'].map((family) => ({ route: `${family}:file.save`, variant: IMAGE_UPLOAD_VARIANT, when: [IMAGE_UPLOAD_CONDITION] })),
);

/** Route-key error bodies and the processRequest exception each answers with. */
const RESOLUTION_ERRORS: ReadonlyMap<string, LegacyApiErrorType> = new Map([
  ['!invalidparameters', 'invalidParameters'],
  ['!invalidmethodcall', 'invalidMethodCall'],
  ['!invalidentitycall', 'invalidEntityCall'],
  ['!server_error', 'server_error'],
]);

/** Path-addressed methods of the entity route (jsonApiUtility.cfc:1003-1059) and the method each reports. */
const PATH_METHODS: ReadonlyMap<string, string> = new Map([
  ['findrelatedcontent', 'findRelatedContent'],
  ['findversionhistory', 'findVersionHistory'],
  ['findcrumbarray', 'findCrumbArray'],
]);

/** Entity-generic operations an entity handler may serve. */
type GenericOperation = Exclude<keyof EntityHandler, 'entity' | 'config'>;

/** configBean and settings values the endpoint URL, the route key, the CORS allow-list and the site URLs read. */
export interface JsonApiLegacySettings {
  /** configBean `adminSSL`. */
  readonly adminSSL: boolean;
  /** configBean `serverPort`, `:<port>` or ''; undefined takes the request host's port, as the settings template does. */
  readonly serverPort?: string;
  /** configBean `context`, e.g. '' or `/masa`. */
  readonly context: string;
  /** `application.appreloadkey`. */
  readonly appReloadKey: string;
  /** configBean `adminDomain`, a comma list of admin host names, or ''. */
  readonly adminDomain: string;
  /** configBean URL flags the site renderer resolves. */
  readonly urls: Pick<LegacySiteUrlConfig, 'siteIdInUrls' | 'indexFileInUrls' | 'hashUrls' | 'legacyIndexFileLocation' | 'siteAssetPath'>;
}

const BLANK = /^\s*$/;

/** A `${expr}` or `{{expr}}` value, which Masa start-up evaluates as CFML; with no CFML runtime here it reads as unset. */
function literal(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const expression = (value.startsWith('${') && value.endsWith('}')) || (value.startsWith('{{') && value.endsWith('}}'));
  return expression ? undefined : value;
}

/** A `MURA_<KEY>` text setting that `valid` accepts; unset and expressions read as undefined. */
function textSetting(valid: (value: string) => boolean, message: string) {
  return z.preprocess(literal, z.string().refine(valid, message).optional());
}

/** A configBean flag: the settings template's value when unset, configBean's default when not a CFML boolean, which its setter ignores. */
function flagSetting(template: boolean, bean: boolean) {
  return z.preprocess(literal, z.string().optional()).transform((value) => {
    if (value === undefined) return template;
    return cfIsBoolean(value) ? cfToBoolean(value) : bean;
  });
}

/** configBean `setServerPort`: `:<port>`, or '' for 80, 443 and a blank port. */
function serverPortSetting(port: string): string {
  return port === '80' || port === '443' || BLANK.test(port) ? '' : `:${port}`;
}

/** configBean `cleanFilePath`: drops one trailing `/` or `\`. */
function cleanFilePath(path: string): string {
  return /[/\\]$/.test(path) ? path.slice(0, -1) : path;
}

// core/templates/settings.template.cfm and core/mura/configBean.cfc:131-231; MURA_<KEY> variables override both
// (core/appcfc/onApplicationStart_include.cfm:136-141).
const LEGACY_SETTINGS = z
  .object({
    MURA_ADMINSSL: textSetting((v) => BLANK.test(v) || cfIsBoolean(v), 'must be a CFML boolean'),
    MURA_PORT: textSetting((v) => BLANK.test(v) || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535), 'must be blank or a TCP port'),
    MURA_CONTEXT: textSetting((v) => /^(?:\s*|[/\\][^\s?#]*)$/.test(v), 'must be blank or a path from / or \\'),
    MURA_ADMINDOMAIN: textSetting((v) => /^(?:\s*|[^\s:/\\?#@]+)$/.test(v), 'must be a comma list of host names'),
    MURA_APPRELOADKEY: z.string().regex(/^[^\s\p{Cc}]*$/u, 'must not contain whitespace or control characters').optional(),
    MURA_SITEIDINURLS: flagSetting(false, true),
    MURA_INDEXFILEINURLS: flagSetting(true, true),
    MURA_HASHURLS: flagSetting(false, false),
    MURA_LEGACYINDEXFILELOCATION: textSetting((v) => cfIsBoolean(v), 'must be a CFML boolean'),
    MURA_SITEDIR: z.preprocess(literal, z.string().optional()),
  })
  .transform(
    (env): JsonApiLegacySettings => ({
      adminSSL: env.MURA_ADMINSSL !== undefined && !BLANK.test(env.MURA_ADMINSSL) && cfToBoolean(env.MURA_ADMINSSL),
      ...(env.MURA_PORT === undefined ? {} : { serverPort: serverPortSetting(env.MURA_PORT) }),
      context: env.MURA_CONTEXT === undefined || BLANK.test(env.MURA_CONTEXT) ? '' : cleanFilePath(env.MURA_CONTEXT),
      appReloadKey: env.MURA_APPRELOADKEY ?? 'appreload',
      adminDomain: env.MURA_ADMINDOMAIN === undefined || BLANK.test(env.MURA_ADMINDOMAIN) ? '' : env.MURA_ADMINDOMAIN,
      urls: {
        siteIdInUrls: env.MURA_SITEIDINURLS,
        indexFileInUrls: env.MURA_INDEXFILEINURLS,
        hashUrls: env.MURA_HASHURLS,
        legacyIndexFileLocation: env.MURA_LEGACYINDEXFILELOCATION !== undefined && cfToBoolean(env.MURA_LEGACYINDEXFILELOCATION),
        // configBean getSiteAssetPath().
        siteAssetPath: (env.MURA_SITEDIR ?? 'sites') === '' ? '' : `/${env.MURA_SITEDIR ?? 'sites'}`,
      },
    }),
  );

/** The settings from `MURA_<KEY>` variables, else the settings template's; throws EnvValidationError naming each malformed one. */
export function jsonApiLegacySettings(env: Readonly<Record<string, string | undefined>> = process.env): JsonApiLegacySettings {
  const parsed = LEGACY_SETTINGS.safeParse(env);
  if (parsed.success) return parsed.data;
  throw new EnvValidationError(
    parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    'strategies-content',
  );
}

// ---- Request resolution ----

/** A CFML struct: keys matched ignoring case, each kept under its first spelling, in insertion order. */
type CfStruct = Map<string, [key: string, value: unknown]>;

function structOf(entries: Iterable<readonly [string, unknown]>): CfStruct {
  const struct: CfStruct = new Map();
  for (const [key, value] of entries) structSet(struct, key, value);
  return struct;
}

/** CFML struct write: replaces the value of an existing key ignoring case, else appends the key. */
function structSet(struct: CfStruct, key: string, value: unknown): void {
  const held = struct.get(key.toLowerCase());
  if (held === undefined) struct.set(key.toLowerCase(), [key, value]);
  else held[1] = value;
}

function structGet(struct: CfStruct, key: string): unknown {
  return struct.get(key.toLowerCase())?.[1];
}

function structEntries(struct: CfStruct): Array<readonly [string, unknown]> {
  return [...struct.values()];
}

/** The struct as a plain record; defined, not assigned, so a `__proto__` key stays a data key. */
function structRecord(struct: CfStruct): Struct {
  const record: Struct = {};
  for (const [key, value] of struct.values()) {
    Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return record;
}

function isPlainObject(value: unknown): value is Struct {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null;
}

/** A simple CFML value's text; undefined for a complex value. */
function simpleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Header `name` matched ignoring case; repeated fields joined with `, `, as the servlet container joins them. */
function headerText(headers: JsonApiRequestFacts['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && key.toLowerCase() === wanted) return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** A request as Fastify parsed it: everything {@link resolveJsonApiCall} reads. */
export interface JsonApiRequestFacts {
  method: string;
  /** Request target as sent, query string included. */
  url: string;
  /** Parsed query string. */
  query: unknown;
  /** Parsed body: form fields, multipart parts, a JSON value or nothing. */
  body: unknown;
  /** The client's headers, without the gateway's user token and invocation credential. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  multipartFileNames?: ReadonlyArray<{ field: string; filename: string }>;
}

/** Legacy settings and registries {@link resolveJsonApiCall} resolves against. */
export interface JsonApiResolveOptions {
  /** settingsManager.siteExists over the verified site registry. */
  siteExists: (siteId: string) => boolean;
  /** application.appreloadkey, which processRequest deletes from the url scope (jsonApiUtility.cfc:403). */
  appReloadKey: string;
  /** configBean `context`. */
  context?: string;
  /** configBean `variations` (jsonApiUtility.cfc:102-105), which the route key's entity resolution reads. */
  variations: boolean;
}

/** What a resolved request is answered by. */
export type JsonApiTarget =
  | { kind: 'error'; type: LegacyApiErrorType }
  | { kind: 'entity'; operation: GenericOperation; fn: JsonApiHandlerFn }
  | { kind: 'method'; name: string; fn: JsonApiHandlerFn }
  /** A key this service owns but answers fail-closed: the legacy 503. */
  | { kind: 'refused'; reason: string }
  /** A key of another owner, or of no carried route: the legacy 404. */
  | { kind: 'foreign' };

/** One request as processRequest resolves it, before the acting user and the site settings are bound. */
export interface ResolvedJsonApiCall {
  /** The shared route key of the request. */
  key: RouteKeyResult;
  mode: JsonApiMode;
  /** Route family path, e.g. `/_api/json/v1`. */
  family: string;
  /** handleAPIRequest's site after the `default` fallback: the API instance's `variables.siteid`. */
  apiSiteId: string;
  target: JsonApiTarget;
  /** `params.method` as the response reports it. */
  method: string;
  /** Invoked as a direct method, which always answers 200 (jsonApiUtility.cfc:870-898, 921-940). */
  direct: boolean;
  /** Whether the answer echoes params; the `<id>/permissions` and `<id>/relatedcontent` paths send none (1007, 1031). */
  withParams: boolean;
  entityName: string;
  entityConfigName?: string;
  id?: string;
  ids?: string[];
  relatedContentSetId?: string;
  render?: { variation: boolean };
  /** Path segments after the API family, as the entity route rewrote them. */
  pathInfo: string[];
  /** The merged params as resolution left them. */
  params: JsonApiParams;
  /** The url scope without the reload key. */
  url: Struct;
  /** The form scope packageIteratorArray reads: posted fields with the params structAppend copied in (845, 1239). */
  form: Struct;
  /** `cgi.QUERY_STRING`. */
  queryString: string;
  methodCtx: ApiNameContext;
}

/** Relationship properties of each content entity (`application.objectMappings[entity].properties` with a `cfc`). */
const ENTITY_RELATIONSHIPS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(contentEntities({ variations: true }).map((entity) => [entity.name, [...entity.hasMany, ...entity.hasOne].map((prop) => prop.name)])),
);

/** Registered primary keys of the content entities processRequest does not hard-code (jsonApiUtility.cfc:1205-1235). */
const ENTITY_PRIMARY_KEYS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    contentEntities({ variations: true })
      .filter((entity) => entity.primaryKey !== '' && !['content', 'feed', 'stats', 'contentcategoryassign'].includes(entity.name.toLowerCase()))
      .map((entity) => [entity.name, entity.primaryKey]),
  ),
);

/** Route-key options of a resolution. */
function routeKeyOptionsOf(opts: JsonApiResolveOptions): RouteKeyOptions {
  return {
    siteExists: opts.siteExists,
    appReloadKey: opts.appReloadKey,
    context: opts.context ?? '',
    variationsEnabled: opts.variations,
    variants: VARIANTS,
    entityRemoteFunctions: ENTITY_REMOTE_FUNCTIONS,
    entityRelationships: ENTITY_RELATIONSHIPS,
    entityPrimaryKeys: ENTITY_PRIMARY_KEYS,
  };
}

/** One parsed url or form value as sent, as text: a multipart part by value or file name. */
function sentText(value: unknown): string {
  const text = legacyScopeValue(value);
  return typeof text === 'string' ? text : (JSON.stringify(text) ?? '');
}

/** A parsed query or form as sent: each name's value, or its repeated values, as text. */
function sentScopeOf(fields: unknown): Record<string, string | string[]> {
  if (!isPlainObject(fields)) return {};
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, Array.isArray(value) ? value.map(sentText) : sentText(value)]));
}

/** Path segments as processRequest reads them: decoded, the first `index.cfm` segment dropped (contentServer.cfc:141-165). */
function pathSegmentsOf(target: string): string[] {
  const raw = target.split('?', 1)[0] ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // The container rejects a malformed escape before routing, so only the router's own decoding reaches here.
  }
  const segments = cfListToArray(decoded, '/');
  const at = segments.findIndex((segment) => segment.toLowerCase() === 'index.cfm');
  if (at >= 0) segments.splice(at, 1);
  return segments;
}

/** `scope[name]` as CFML reads it, ignoring case; undefined when absent. */
function scopeString(scope: Readonly<Struct>, name: string): string | undefined {
  const key = Object.keys(scope).findLast((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : sentText(scope[key]);
}

/**
 * handleAPIRequest's site (contentServer.cfc:610-622): path element 4, else form then url `siteid`, and `default` for a
 * site the registry does not hold.
 */
export function jsonApiSiteOf(
  segments: readonly string[],
  form: Readonly<Struct>,
  url: Readonly<Struct>,
  siteExists: (siteId: string) => boolean,
): string {
  return fallbackSiteId(segments[3] ?? scopeString(form, 'siteid') ?? scopeString(url, 'siteid') ?? 'default', siteExists);
}

/** isAggregateQuery (jsonApiUtility.cfc:4981-4997): an aggregate url key or `=<name>[` in the query string, unless `fields` is set. */
function isAggregateQuery(url: Readonly<Struct>, queryString: string): boolean {
  if ((scopeString(url, 'fields') ?? '') !== '') return false;
  return ['sum', 'avg', 'count', 'max', 'min', 'groupBy', 'distinct'].some(
    (name) => scopeString(url, name.toLowerCase()) !== undefined || (queryString !== '' && queryString.includes(`=${name}[`)),
  );
}

/** The handler of a generic operation of a content entity, or why it is not served. */
function entityTarget(entity: string, op: string): JsonApiTarget {
  // With `variations` off, `variationTargeting` is unregistered but its bean exists (onApplicationStart_include.cfm:387), so
  // legacy still dispatches it and AllowAccess refuses; its handler answers that state itself.
  const handler = lookupEntityHandler(entity, { variations: true });
  if (handler === undefined) return { kind: 'foreign' };
  const operation = canonicalMethodName(op) as GenericOperation;
  const fn = handler[operation];
  // No handler of this folder ports the operation (e.g. the bean validator behind `validate`), so it fails closed.
  return fn === undefined ? { kind: 'refused', reason: `jsonapi-${entity}-${op}-not-ported` } : { kind: 'entity', operation, fn };
}

/** A public method handler of this service, by any spelling of its name. */
function methodTarget(name: string): JsonApiTarget {
  const canonical = canonicalMethodName(name);
  const fn = Object.hasOwn(CONTENT_METHOD_HANDLERS, canonical) ? CONTENT_METHOD_HANDLERS[canonical] : undefined;
  return fn === undefined ? { kind: 'foreign' } : { kind: 'method', name: canonical, fn };
}

/** The target of the key's body, its variant aside. */
function bodyTarget(body: string): JsonApiTarget {
  const failure = RESOLUTION_ERRORS.get(body);
  if (failure !== undefined) return { kind: 'error', type: failure };
  const dot = body.indexOf('.');
  if (dot < 0) return methodTarget(body);
  const entity = body.slice(0, dot);
  const op = body.slice(dot + 1);
  if (!isContentEntity(entity)) return { kind: 'foreign' };
  // An entity remote function or relationship read (1050-1137) invokes bean code no handler of this folder ports.
  if (op.startsWith('~')) return { kind: 'refused', reason: `jsonapi-${entity}-${op.slice(1)}-not-ported` };
  const pathMethod = PATH_METHODS.get(op);
  if (pathMethod !== undefined) return methodTarget(pathMethod);
  return isGenericMethod(op) ? entityTarget(entity, op) : { kind: 'foreign' };
}

/** What answers the key: an exception, an entity operation, a public method, a refusal or another owner. */
function targetOf(key: RouteKeyResult): JsonApiTarget {
  if (key.family !== 'api' && key.family !== 'rest') return { kind: 'foreign' };
  const target = bodyTarget(key.baseKey.slice(key.family.length + 1));
  // A variant (the `{upload=image}` file save under EX-FILE-RENDITION, a scan the runtime decides) stays legacy-served,
  // so nothing of it runs here.
  if (key.variant !== undefined && (target.kind === 'entity' || target.kind === 'method')) {
    return { kind: 'refused', reason: `jsonapi-variant-${key.variant}` };
  }
  return target;
}

/** The params at processRequest's form copy (845): the merged scopes with REST credentials consumed and CSRF headers copied. */
function copiedParams(merged: CfStruct, key: RouteKeyResult, facts: JsonApiRequestFacts, restMode: boolean): CfStruct {
  const params = structOf(structEntries(merged));
  // The REST credential block deletes the credentials it consumed (jsonApiUtility.cfc:472-835), which the key no longer holds.
  for (const [lower, [, value]] of merged) {
    if (simpleText(value) !== undefined && !Object.hasOwn(key.params, lower)) params.delete(lower);
  }
  if (!restMode) {
    for (const name of ['csrf_token', 'csrf_token_expires']) {
      const value = headerText(facts.headers, `X-${name}`);
      if (value !== undefined) structSet(params, name, value);
    }
  }
  return params;
}

/** The params as resolution left them: the key's simple values over the copied params, complex values kept. */
function resolvedParams(copied: CfStruct, key: RouteKeyResult): CfStruct {
  const params = structOf(structEntries(copied));
  for (const [name, value] of Object.entries(key.params)) {
    const held = structGet(params, name);
    if (held === undefined || simpleText(held) !== value) structSet(params, name, value);
  }
  return params;
}

/** ColdFusion's `form.fieldnames`: each posted field name once, upper-cased in posting order, as the start-up scan leaves it. */
function postedFieldNames(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const names = [...new Set(Object.keys(body).map((name) => name.toUpperCase()))];
  if (names.length === 0) return undefined;
  return legacyScopeParams(portcullisScan([['fieldnames', names.join(',')]])).fieldnames ?? '';
}

/** CFML `isBoolean(x) and x`. */
function isTrue(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** processRequest's resolution of `facts` (jsonApiUtility.cfc:368-1306) through the shared route key, with the params, ids and path it leaves. */
export function resolveJsonApiCall(facts: JsonApiRequestFacts, opts: JsonApiResolveOptions): ResolvedJsonApiCall {
  const segments = pathSegmentsOf(facts.url);
  const named = (segments[1] ?? '').toLowerCase();
  const mode: JsonApiMode = FAMILIES.find((family) => family === named) ?? 'json';
  const restMode = mode === 'rest';
  const contentType = headerText(facts.headers, 'content-type');
  const json = isJsonContentType(contentType);
  const at = facts.url.indexOf('?');
  const queryString = at < 0 ? '' : facts.url.slice(at + 1);
  const { result: key } = scannedRouteKey(
    {
      method: facts.method,
      path: facts.url.split('?', 1)[0] ?? '',
      url: facts.url,
      query: sentScopeOf(facts.query),
      form: json ? {} : sentScopeOf(facts.body),
      jsonBody: json ? facts.body : undefined,
      headers: facts.headers,
      multipartFileNames: [...(facts.multipartFileNames ?? [])],
    },
    routeKeyOptionsOf(opts),
  );
  const methodCtx: ApiNameContext = {
    hasOrigin: headerText(facts.headers, 'origin') !== undefined,
    restMode,
    hasAuthorization: restMode && headerText(facts.headers, 'authorization') !== undefined,
  };

  const scopes = legacyScopesFrom({ query: facts.query, body: facts.body, headers: { 'content-type': contentType }, url: facts.url });
  const apiSiteId = jsonApiSiteOf(segments, Object.fromEntries(scopes.form.entries), Object.fromEntries(scopes.url.entries), opts.siteExists);
  const reloadKey = opts.appReloadKey.toLowerCase();
  const urlEntries = scopes.url.entries.filter(([name]) => name.toLowerCase() !== reloadKey);
  const jsonEntries = json && isPlainObject(scopes.jsonBody) ? Object.entries(scopes.jsonBody).map(([name, value]) => [name, value ?? ''] as const) : [];
  const merged = structOf([...urlEntries, ...scopes.form.entries, ...jsonEntries]);
  const copied = copiedParams(merged, key, facts, restMode);
  const params = resolvedParams(copied, key);
  const target = targetOf(key);

  const requested = structGet(copied, 'method');
  const dotted = typeof requested === 'string' && requested.includes('.') ? requested : undefined;
  const effective = key.params.method;
  const resolvedName = target.kind === 'entity' ? target.operation : target.kind === 'method' ? target.name : undefined;
  const direct = dotted === undefined && effective !== undefined && resolvedName !== undefined && cfEq(effective, resolvedName);
  const method = direct || resolvedName === undefined ? (effective ?? 'undefined') : resolvedName;

  let pathInfo = segments.slice(3);
  const [first = '', second = ''] = pathInfo;
  // A path method after the site id is dropped from the path (jsonApiUtility.cfc:856-866).
  if (requested === undefined && pathInfo.length > 1 && isValidVariableName(first) && cfEq(first, apiSiteId)) {
    if (isValidVariableName(second) && isDefinedApiName(second, methodCtx)) pathInfo.splice(1, 1);
  }
  // A dotted method rewrites the path to `<site>/<entity>/<method>` (953-960).
  if (dotted !== undefined && resolvedName !== undefined) {
    const parts = cfListToArray(dotted, '.');
    pathInfo = [pathInfo[0] ?? '', parts[0] ?? '', parts.at(-1) ?? ''];
  }

  const form = structOf(scopes.form.entries);
  // The entity route copies the resolved params into the form scope again before its switch (1239).
  for (const [name, value] of structEntries(target.kind === 'entity' && !direct ? params : copied)) structSet(form, name, value);
  const fieldnames = json ? undefined : postedFieldNames(facts.body);
  if (fieldnames !== undefined) structSet(form, 'fieldnames', fieldnames);

  const spelled = key.params.entityname ?? '';
  const contentnav = cfEq(spelled, 'contentnav');
  const entityName = target.kind === 'method' && direct ? '' : contentnav ? 'content' : spelled;
  const entityConfigName = contentnav ? 'contentnav' : key.params.entityconfigname;
  const id = key.params.id;
  const pathRoute = !direct && pathInfo.length >= 4 && (pathInfo[2] ?? '').length === 35;
  const pathPermissions = pathRoute && pathInfo.length === 4 && cfEq(pathInfo[3] ?? '', 'permissions') && method === 'findPermissions';
  const pathRelated = pathRoute && method === 'findRelatedContent';
  const relatedContentSetId = pathRelated && pathInfo.length === 5 ? pathInfo[4] : undefined;

  if (!direct && resolvedName !== undefined) {
    // The entity route's own params writes (1012-1046, 1243-1303).
    structSet(params, 'method', method);
    if (method === 'findMany') structSet(params, 'ids', id ?? '');
    if (pathRelated || method === 'findCrumbArray') structSet(params, 'siteid', apiSiteId);
    if (relatedContentSetId !== undefined) structSet(params, 'relatedcontentsetid', relatedContentSetId);
  }
  const ids = !direct && method === 'findMany' ? cfListToArray(id ?? '') : undefined;
  const render =
    target.kind === 'entity' && target.operation === 'findOne' && isTrue(structGet(params, 'render'))
      ? { variation: isTrue(structGet(params, 'variation')) }
      : undefined;

  return {
    key,
    mode,
    family: `/_api/${mode}/v1`,
    apiSiteId,
    target,
    method,
    direct,
    withParams: !(pathPermissions || pathRelated),
    entityName,
    ...(entityConfigName === undefined ? {} : { entityConfigName }),
    ...(id === undefined ? {} : { id }),
    ...(ids === undefined ? {} : { ids }),
    ...(relatedContentSetId === undefined ? {} : { relatedContentSetId }),
    ...(render === undefined ? {} : { render }),
    pathInfo,
    params: createJsonApiParams(structEntries(params)),
    url: structRecord(structOf(urlEntries)),
    form: structRecord(form),
    queryString,
    methodCtx,
  };
}

// ---- Calls ----

/** One uploaded file part of a call. */
type UploadedFile = NonNullable<JsonApiCall['files']>[number];

/** The first value of request header `name`. */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The client's own headers: without the gateway's Bearer user token, which legacy would read as an OAuth access token, and the invocation credential. */
function clientHeadersOf(request: FastifyRequest): FastifyRequest['headers'] {
  const headers: FastifyRequest['headers'] = { ...request.headers };
  const { userToken } = request.opt2Auth;
  if (userToken !== undefined && headerText(headers, 'authorization') === `Bearer ${userToken}`) delete headers.authorization;
  delete headers['x-serverless-authorization'];
  return headers;
}

/** Headers under lower-cased names, repeated fields joined with `, `. */
function lowerHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) lowered[name.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
  }
  return lowered;
}

/** `utility.getRequestProtocol()` (utility.cfc:481-500). */
function requestProtocolOf(request: FastifyRequest): 'http' | 'https' {
  if (headerValue(request, 'x-forwarded-proto')?.toLowerCase() === 'https') return 'https';
  if (isTrue(headerValue(request, 'front-end-https'))) return 'https';
  return request.protocol === 'https' ? 'https' : 'http';
}

/** The client's host as the gateway forwards it: `X-Forwarded-Host` before the hop's own `Host`. */
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

// strategies-content holds no tsettings or timagesizes projection (programs-sites owns them): the registry supplies the
// site's identity, domains and file pool, the configBean flags come from MURA_<KEY>, and every other value keeps the
// empty value or legacy default its type documents.
/** The URL settings of a registered site for this request. */
function siteUrlsOf(entry: TenantRegistryEntry, request: FastifyRequest, settings: JsonApiLegacySettings): LegacySiteUrlConfig {
  const domain = entry.domains[0] ?? '';
  const host = clientHostOf(request);
  const onSiteDomain = entry.domains.some((candidate) => candidate.toLowerCase() === host.name.toLowerCase());
  return {
    siteId: entry.siteId,
    scheme: requestProtocolOf(request),
    domain,
    requestDomain: onSiteDomain ? host.name : domain,
    previewDomain: '',
    serverPort: settings.serverPort ?? serverPortSetting(host.port),
    context: settings.context,
    ...settings.urls,
    useSSL: false,
    // settingsBean getFilePoolID: the site itself when no pool is set.
    filePoolId: entry.filePoolId || entry.siteId,
    configFileAssetPath: '',
    assetPath: '',
    fileStore: 'fileDir',
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  };
}

/** The settingsBean values content operations read, for a registered site. */
function siteSettingsOf(entry: TenantRegistryEntry, urls: LegacySiteUrlConfig): SiteContentSettings {
  return {
    siteId: entry.siteId,
    site: '',
    locking: 'None',
    contentApprovalScript: '',
    contentRejectionScript: '',
    contentPendingScript: '',
    contentCanceledScript: '',
    contactEmail: '',
    urls,
  };
}

/** The request's spooled upload parts, read into memory for the domain's file writes. */
async function uploadsOf(request: FastifyRequest): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const part of multipartFilesOf(request)) {
    const chunks: Buffer[] = [];
    for await (const chunk of part.stream()) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    files.push({ fieldName: part.field, fileName: part.filename, contentType: part.mimetype, bytes: Buffer.concat(chunks) });
  }
  return files;
}

/** `$.validateCSRFTokens(context)`: identity validates and consumes the request's token, once. */
async function consumeCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<boolean> {
  let refused = false;
  const consume = csrfPreHandler({
    contextOf: () => context,
    onReject: () => {
      refused = true;
    },
  });
  await consume.call(request.server, request, reply);
  return !refused;
}

/** The actor's AllowAction default branch (jsonApiUtility.cfc:1820-1826) for the entity a view is serialized as. */
function allowActionFor(actor: Actor): JsonApiRequestContext['allowAction'] {
  return (view) => {
    const config = getContentEntityConfig(view.configName || view.entityName);
    return 'moduleId' in config && entityActionAllowed(actor, config);
  };
}

/**
 * getCustomImageSizeIterator within one request: the first image entity's site sizes, read once and reused for every
 * later entity, as `request.muraCustomImageIterator` is (jsonApiUtility.cfc:3574-3586).
 */
function requestImageSizes(sites: SitesClient): JsonApiRequestContext['customImageSizes'] {
  // Legacy's own per-request reuse, kept for unchanged behaviour; the Minimal Change rule's caching ban does not bind this refactor.
  let read: ReturnType<SitesClient['customImageSizes']> | undefined;
  return (siteId) => (read ??= sites.customImageSizes(siteId));
}

/** Everything one dispatched request reads beside its resolution. */
interface CallScope {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: ContentRouteContext;
  settings: JsonApiLegacySettings;
  /** Tenant every read and write of the call runs in. */
  tenantId: string;
  site: TenantRegistryEntry;
  apiSite: string;
  sites: SitesClient;
}

/** The handler call of a served resolution. */
async function callOf(resolved: ResolvedJsonApiCall, scope: CallScope): Promise<JsonApiCall> {
  const { request, reply, ctx, settings, site } = scope;
  const actor = await ctx.actorFor(request);
  const urls = siteUrlsOf(site, request, settings);
  const host = clientHostOf(request);
  const restMode = resolved.mode === 'rest';
  const signedIn = actor.isLoggedIn && actor.userId !== '';
  const apiContext: JsonApiRequestContext = {
    siteId: scope.apiSite,
    mode: resolved.mode,
    endpoint: jsonApiEndpoint({
      adminSSL: settings.adminSSL,
      requestProtocol: requestProtocolOf(request),
      serverName: host.name,
      serverPort: settings.serverPort ?? serverPortSetting(host.port),
      context: settings.context,
      // getEndPoint names `request.muraAPIRequestMode`, which only the REST family sets (contentServer.cfc:624).
      mode: restMode ? 'rest' : 'json',
      siteId: scope.apiSite,
    }),
    url: resolved.url,
    form: resolved.form,
    method: resolved.method,
    isAggregateQuery: isAggregateQuery(resolved.url, resolved.queryString),
    // The anonymous principal's token (`sub` '') is no signed-in user.
    user: { loggedIn: signedIn, systemUser: signedIn && (actor.s2 || actor.roles.includes(Roles.systemUser)) },
    allowAction: allowActionFor(actor),
    site: urls,
    customImageSizes: requestImageSizes(scope.sites),
  };
  const save = resolved.target.kind === 'entity' && resolved.target.operation === 'save';
  // save's and delete's `var csrfcontext=arguments.id`, save's id defaulting to `new` (jsonApiUtility.cfc:1903-1906, 3259-3262).
  const csrfContext = resolved.id ?? (save ? 'new' : '');
  const files = save && multipartFilesOf(request).length > 0 ? await uploadsOf(request) : undefined;
  return {
    mode: resolved.mode,
    family: resolved.family,
    routeKey: resolved.key.key,
    method: resolved.method,
    entityName: resolved.entityName,
    ...(resolved.entityConfigName === undefined ? {} : { entityConfigName: resolved.entityConfigName }),
    ...(resolved.id === undefined ? {} : { id: resolved.id }),
    ...(resolved.ids === undefined ? {} : { ids: resolved.ids }),
    ...(resolved.relatedContentSetId === undefined ? {} : { relatedContentSetId: resolved.relatedContentSetId }),
    ...(resolved.render === undefined ? {} : { render: resolved.render }),
    pathInfo: resolved.pathInfo,
    params: resolved.params,
    query: { raw: resolved.queryString, params: createJsonApiParams(Object.entries(resolved.url)) },
    siteId: site.siteId,
    tenantId: scope.tenantId,
    actor,
    site: siteSettingsOf(site, urls),
    apiContext,
    httpMethod: resolved.key.httpMethod,
    headers: lowerHeaders(clientHeadersOf(request)),
    ...(files === undefined ? {} : { files }),
    // `!request.muraSessionManagement || $.validateCSRFTokens(...)`: the REST family runs without sessions (applicationSettings.cfm:179).
    validateCsrf: () => (restMode ? Promise.resolve(true) : consumeCsrf(request, reply, csrfContext)),
  };
}

// ---- Responses ----

/** The error envelope of `type` as processRequest's catch blocks serialize it (jsonApiUtility.cfc:1318-1402). */
function errorAnswer(resolved: ResolvedJsonApiCall, type: string, opts: { method?: string; mura404?: boolean } = {}): SerializedLegacyResponse {
  return legacyErrorResponse(type, {
    method: opts.method ?? resolved.method,
    params: resolved.params.toRecord(),
    methodCtx: resolved.methodCtx,
    ...(opts.mura404 === true ? { mura404: true } : {}),
  });
}

/** `$.event('useDataNamespace')`: the url value, else the form value. */
function useDataNamespaceOf(resolved: ResolvedJsonApiCall): string | undefined {
  return scopeString(resolved.url, 'usedatanamespace') ?? scopeString(resolved.form, 'usedatanamespace');
}

/** `value` with each struct in ACF's iteration order: Masa builds every response struct unordered (`{}`). */
function inAcfOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inAcfOrder);
  if (!isPlainObject(value)) return value;
  const ordered: Struct = {};
  for (const key of acfKeyOrder(Object.keys(value).map((name): StructOp => ['set', name]))) {
    Object.defineProperty(ordered, key, { value: inAcfOrder(value[key]), writable: true, enumerable: true, configurable: true });
  }
  return ordered;
}

/** processRequest's answer to a handler result (jsonApiUtility.cfc:891-898, 1307-1314, 1471-1511). */
function resultAnswer(resolved: ResolvedJsonApiCall, result: JsonApiResult): SerializedLegacyResponse {
  if (result.error !== undefined) return errorAnswer(resolved, result.error);
  // A direct method whose result is JSON text answers it as the body (891-897).
  if (result.rawJson !== undefined) return { status: 200, headers: { 'Content-Type': LEGACY_JSON_CONTENT_TYPE }, body: result.rawJson };
  // Direct methods and the path methods always answer 200; the entity route answers 403 when the result carries errors.
  const routed = !resolved.direct && resolved.target.kind === 'entity';
  const status = result.status === 404 ? 404 : routed ? (result.status ?? 200) : 200;
  const params = resolved.withParams ? { params: inAcfOrder(paramsWithoutMethod(resolved.params.toRecord())) as Struct } : {};
  return serializeResponse(buildEnvelope({ method: resolved.method, ...params, data: inAcfOrder(result.data) }), {
    statusCode: status,
    mura404: status === 404,
    serializer: contentApiSerializer(result.serializerEntity ?? resolved.entityName),
    useDataNamespace: useDataNamespaceOf(resolved),
    keyOrder: 'acf',
  });
}

/** The handler's answer, or the response processRequest's catch blocks give its exception. */
async function dispatch(resolved: ResolvedJsonApiCall, fn: JsonApiHandlerFn, scope: CallScope): Promise<SerializedLegacyResponse> {
  const call = await callOf(resolved, scope);
  // delete's `var csrfcontext=arguments.id` reads an undefined argument (jsonApiUtility.cfc:3262).
  if (resolved.target.kind === 'entity' && resolved.target.operation === 'delete' && resolved.id === undefined) {
    return errorAnswer(resolved, 'server_error');
  }
  try {
    return resultAnswer(resolved, await fn(scope.ctx, call));
  } catch (err) {
    if (err instanceof LegacyApiError) {
      return legacyErrorResponse(err.type, {
        method: err.method ?? resolved.method,
        params: err.params ?? resolved.params.toRecord(),
        methodCtx: err.methodCtx ?? resolved.methodCtx,
        ...(err.wwwAuthenticate === undefined ? {} : { wwwAuthenticate: err.wwwAuthenticate }),
      });
    }
    // renderFilename's render404 for an unknown `_path` (contentServer.cfc:461-494) sets request.mura404.
    if (err instanceof ContentNotFoundError) return errorAnswer(resolved, 'invalidMethodCall', { mura404: true });
    // The domain refuses an image upload, whose renditions stay legacy-written (EX-FILE-RENDITION); domain/files.ts is not
    // a dependency of this module, so the refusal is recognised by its error name.
    if (err instanceof Error && err.name === 'ImageUploadHaltedError') {
      throw new LegacyServiceUnavailableError(err.message, 'auto', 'jsonapi-image-upload-halted');
    }
    if (err instanceof LegacyServiceUnavailableError || err instanceof AuthDenial || err instanceof RequestAbortedError) throw err;
    // catch (Any e) logs the exception and reports params.method as the failing call had set it (1390-1400).
    scope.request.log.error({ err }, 'unhandled JSON API error');
    return errorAnswer(resolved, 'server_error');
  }
}

// ---- Routes ----

/**
 * Registers the contract's JSON API operations of every family (`/_api/{json,ajax,rest}/v1`, `…/{siteid}`,
 * `…/{siteid}/{path}`); every path and method shares one handler. Throws EnvValidationError for malformed settings.
 */
export function registerJsonApiRoutes(
  app: FastifyInstance,
  ctx: ContentRouteContext,
  settings: JsonApiLegacySettings = jsonApiLegacySettings(),
): void {
  const snapshots = new WeakMap<FastifyRequest, Promise<TenantRegistryEntry[]>>();
  const sites = createSitesClient(app.opt2.client);

  /** The request's single registry read, which the Origin echo and the resolution share. */
  function registryOf(request: FastifyRequest): Promise<TenantRegistryEntry[]> {
    let snapshot = snapshots.get(request);
    if (snapshot === undefined) {
      snapshot = registryEntries(ctx.domain.db);
      snapshots.set(request, snapshot);
    }
    return snapshot;
  }

  /** processRequest's Origin echo on every answer of the route, denials included (jsonApiUtility.cfc:382-394). */
  async function allowOrigin(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
    const origin = headerValue(request, 'origin');
    if (origin === undefined) return payload;
    let registry: TenantRegistryEntry[];
    try {
      registry = await registryOf(request);
    } catch {
      // The answer goes out without the echo: a throw from onSend re-enters error handling and sends it again.
      return payload;
    }
    const sites = registry.map((entry) => ({ domain: entry.domains.join(',') }));
    const cfg = { adminDomain: settings.adminDomain, currentAdminDomain: currentAdminDomainOf(request, settings.adminDomain) };
    reply.headers(corsHeaders(origin, accessControlOriginDomains(sites, cfg)));
    return payload;
  }

  /** processRequest through the shared route key, then the handler of the entity or method strategies-content serves. */
  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const registry = new Map((await registryOf(request)).map((entry) => [entry.siteId.toLowerCase(), entry]));
    const lookup = (siteId: string): TenantRegistryEntry | undefined => registry.get(siteId.toLowerCase());
    const resolved = resolveJsonApiCall(
      {
        method: request.method,
        url: request.url,
        query: request.query,
        body: request.body,
        headers: clientHeadersOf(request),
        multipartFileNames: multipartFilesOf(request).map(({ field, filename }) => ({ field, filename })),
      },
      { siteExists: (siteId) => lookup(siteId) !== undefined, appReloadKey: settings.appReloadKey, context: settings.context, variations: ctx.env.MURA_VARIATIONS },
    );
    const user = request.opt2Auth.user;
    if (user !== undefined) {
      assertSiteMatches(resolved.apiSiteId, user);
      // An unregistered siteid only selects the `default` fallback; a registered one must be the token's site.
      for (const supplied of suppliedSiteIdsOf(request)) {
        if (lookup(supplied) !== undefined) assertSiteMatches(supplied, user);
      }
    }
    // The REST family's credential block answers before any resolution (jsonApiUtility.cfc:536-555); the gateway exchanges
    // REST credentials for the user token, so a REST call without one sent none.
    if (resolved.mode === 'rest' && user === undefined) {
      return sendLegacyResponse(
        reply,
        legacyErrorResponse('authorization', { method: 'Not Available', methodCtx: resolved.methodCtx, wwwAuthenticate: WWW_AUTHENTICATE.basic }),
      );
    }
    const { target } = resolved;
    switch (target.kind) {
      case 'error':
        return sendLegacyResponse(reply, errorAnswer(resolved, target.type));
      case 'foreign':
        // A key of another owner is no route of this service: the gateway routes it elsewhere.
        return sendLegacyResponse(reply, errorAnswer(resolved, 'invalidMethodCall', { mura404: true }));
      case 'refused':
        throw new LegacyServiceUnavailableError(`JSON API ${resolved.key.key} is not served by strategies-content`, 'auto', target.reason);
      case 'entity':
      case 'method':
        break;
    }
    const site = lookup(resolved.params.string('siteid'));
    if (site === undefined) return sendLegacyResponse(reply, errorAnswer(resolved, 'invalidParameters'));
    if (user !== undefined) assertSiteMatches(site.siteId, user);
    const apiSite = lookup(resolved.apiSiteId)?.siteId ?? resolved.apiSiteId;
    // The token's tenant; a browser call without a session token is anonymous in the verified registry's tenant of its site.
    const tenantId = user?.tid ?? site.tenantId;
    const scope: CallScope = { request, reply, ctx, settings, tenantId, site, apiSite, sites };
    return sendLegacyResponse(reply, await dispatch(resolved, target.fn, scope));
  }

  for (const prefix of JSON_API_PREFIXES) {
    for (const url of [prefix, `${prefix}/:siteid`, `${prefix}/:siteid/*`]) {
      app.route({ method: [...ROUTE_METHODS], url, config: { opt2: { ...ROUTE_AUTH } }, onSend: allowOrigin, handler: handle });
    }
  }
}
