/**
 * Front controller of the JSON API families strategies-content carries (`/_api/json/v1`, `/_api/ajax/v1`, `/_api/rest/v1`):
 * each request is resolved as jsonApiUtility.processRequest resolves it (core/mura/client/api/json/v1/jsonApiUtility.cfc:368-1402)
 * through the shared route key, then answered by the entity and method handlers of ./jsonapi/.
 */
import { AuthDenial, Roles, assertSiteMatches, suppliedSiteIdsOf, type DenialRenderer, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  IMAGE_UPLOAD_CONDITION,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  REST_CONSUMED_PARAMS_HEADER,
  REST_CREDENTIAL_PARAMS,
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
  errorSpec,
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
  type LegacyJsonSerializer,
  type RouteKeyOptions,
  type RouteKeyResult,
  type SerializedLegacyResponse,
  type StructOp,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import {
  EnvValidationError,
  RequestAbortedError,
  abandonOnDisconnect,
  csrfPreHandler,
  multipartFilesOf,
  recordOutcomeReason,
  sendLegacyResponse,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { registryEntries, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { Actor, SiteContentSettings } from '../domain/context.js';
import type { LegacySiteUrlConfig } from '../legacy/content-urls.js';
import { contentEntities, getContentEntityConfig, isContentEntity } from '../legacy/jsonapi-entities.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../legacy/jsonapi-serializers.js';
import { createSitesClient, type SitesClient } from '../legacy/sites-client.js';
import type { ContentRouteContext } from './index.js';
import { createRelatedEntityReader, relationPathOf } from './jsonapi-relations.js';
import {
  CONTENT_METHOD_HANDLERS,
  CONTENT_REMOTE_FUNCTIONS,
  createJsonApiParams,
  entityActionAllowed,
  isInLegacyOrder,
  lookupEntityHandler,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiMode,
  type JsonApiParams,
  type JsonApiResult,
  type RelatedEntityReader,
  type RemoteFunctionFn,
} from './jsonapi/index.js';

type Struct = Record<string, unknown>;

/** API families in handleAPIRequest order (contentServer.cfc:593-636). */
const FAMILIES: readonly JsonApiMode[] = Object.freeze(['json', 'ajax', 'rest']);

/** Leads of the JSON API paths, bare and behind `/index.cfm`; the app routes them in any letter case (`noCasePathPrefixes`), as legacy compares them. */
export const JSON_API_PREFIXES: readonly string[] = Object.freeze(FAMILIES.flatMap((family) => [`/_api/${family}/v1`, `/index.cfm/_api/${family}/v1`]));

/** Methods of the contract's JSON API operations. */
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

// Public: legacy authorises inside the API, after the `default` site fallback, which the automatic site check would precede.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ public: true, transport: 'service', siteCheck: false });

/** Remote function names of each content entity (contentCommentBean.cfc:317-430), as the route key resolves them. */
const ENTITY_REMOTE_FUNCTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(CONTENT_REMOTE_FUNCTIONS).map(([entity, functions]) => [entity, Object.freeze(Object.keys(functions))])),
);

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
type GenericOperation = Exclude<keyof EntityHandler, 'entity' | 'config' | 'loadBy'>;

/** Entity operations that write nothing, whose calls stop between reads once the client disconnects. */
const READ_OPERATIONS: ReadonlySet<GenericOperation> = new Set(['findOne', 'findMany', 'findAll', 'findNew', 'findQuery', 'findProperties', 'findPermissions']);

/** Public methods that write nothing, whose calls stop between reads once the client disconnects. */
const READ_METHODS: ReadonlySet<string> = new Set(['findCrumbArray', 'findVersionHistory', 'findRelatedContent', 'findCalendarItems', 'getURLForImage']);

/** configBean and settings values the endpoint URL, the route key, the CORS allow-list, the site URLs and the envelope read. */
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
  /** configBean `suppressAPIParams`: drops `params` from every envelope. */
  readonly suppressAPIParams: boolean;
  /** configBean `useDataNamespaceForAPI`: keeps a struct `data` under `data` unless the request's `useDataNamespace` says otherwise. */
  readonly useDataNamespaceForAPI: boolean;
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
export function serverPortSetting(port: string): string {
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
    // No setter: serializeResponse reads the raw value with `&&` and `!`, which throw on a non-boolean (jsonApiUtility.cfc:1482,1493).
    MURA_SUPPRESSAPIPARAMS: textSetting((v) => cfIsBoolean(v), 'must be a CFML boolean'),
    MURA_USEDATANAMESPACEFORAPI: textSetting((v) => cfIsBoolean(v), 'must be a CFML boolean'),
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
      suppressAPIParams: env.MURA_SUPPRESSAPIPARAMS === undefined || cfToBoolean(env.MURA_SUPPRESSAPIPARAMS),
      // The site renderer's `useDataNamespaceForAPI` would override this (jsonApiUtility.cfc:13-15); no deployed renderer sets it.
      useDataNamespaceForAPI: env.MURA_USEDATANAMESPACEFORAPI === undefined || cfToBoolean(env.MURA_USEDATANAMESPACEFORAPI),
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
  /** An entity bean's remote function, by its legacy name. */
  | { kind: 'remote'; name: string; fn: RemoteFunctionFn }
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
  /** The id a remote function's bean `loadBy` loads (jsonApiUtility.cfc:1063-1080); absent where it runs on a new bean (1165-1170, 1444-1456). */
  beanId?: string;
  relatedContentSetId?: string;
  render?: { variation: boolean };
  /** Path segments after the API family, as the entity route rewrote them. */
  pathInfo: string[];
  /** The merged params as resolution left them, each JSON null left out as every read but the echo finds it undefined. */
  params: JsonApiParams;
  /** The same params as the envelopes echo them, JSON nulls included; a struct value is the one the handlers receive. */
  echoParams: Struct;
  /** The url, form and JSON body scopes merged, as params stand before the REST credential block (jsonApiUtility.cfc:403-411). */
  requestParams: Struct;
  /** The url scope as onRequestStart leaves it, `mobileFormat` included, without the reload key. */
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
  // An operation its handler does not port fails closed.
  return fn === undefined ? { kind: 'refused', reason: `jsonapi-${entity}-${op}-not-ported` } : { kind: 'entity', operation, fn };
}

/** A public method handler of this service, by any spelling of its name. */
function methodTarget(name: string): JsonApiTarget {
  const canonical = canonicalMethodName(name);
  const fn = Object.hasOwn(CONTENT_METHOD_HANDLERS, canonical) ? CONTENT_METHOD_HANDLERS[canonical] : undefined;
  return fn === undefined ? { kind: 'foreign' } : { kind: 'method', name: canonical, fn };
}

/** The remote function `name` of `entity`, both matched ignoring case as `isDefined` matches them; undefined when it has none so named. */
function remoteTarget(entity: string, name: string): JsonApiTarget | undefined {
  const functions = Object.entries(CONTENT_REMOTE_FUNCTIONS).find(([candidate]) => cfEq(candidate, entity))?.[1] ?? {};
  const found = Object.entries(functions).find(([candidate]) => cfEq(candidate, name));
  return found === undefined ? undefined : { kind: 'remote', name: found[0], fn: found[1] };
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
  if (op.startsWith('~')) {
    // processRequest tries the entity's remote function before its relation (1063-1153).
    const remote = remoteTarget(entity, op.slice(1));
    if (remote !== undefined) return remote;
    const relation = relationPathOf(entity, op.slice(1));
    if (relation !== undefined) return { kind: 'method', name: relation.method, fn: relation.fn };
    return { kind: 'refused', reason: `jsonapi-${entity}-${op.slice(1)}-not-ported` };
  }
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
    if (REST_CREDENTIAL_PARAMS.has(lower) && simpleText(value) !== undefined && !Object.hasOwn(key.params, lower)) params.delete(lower);
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

/** The url scope after onRequestStart's `param url.mobileFormat default=false`, which runs without session management or under an admin preview (onRequestStart_include.cfm:271-306). */
function startedQuery(query: unknown, restMode: boolean): Struct {
  const url: Struct = isPlainObject(query) ? { ...query } : {};
  const names = new Set(Object.keys(url).map((name) => name.toLowerCase()));
  if ((restMode || names.has('muraadminpreview')) && !names.has('mobileformat')) url.mobileFormat = 'false';
  return url;
}

/** A struct's entries without its JSON nulls, which isDefined, structKeyExists, param and argumentCollection all read as absent. */
function definedEntries(struct: CfStruct): Array<readonly [string, unknown]> {
  return structEntries(struct).filter(([, value]) => value !== null);
}

/**
 * How processRequest reaches remote function `name`, and the name as requested: on the bean `<id>/<function>` loads
 * (jsonApiUtility.cfc:1063-1080), else on a new bean as the segment after the entity (1165-1170) or as the `id`
 * doubleCheckEntityMethod invokes (1444-1456); the first and last delete `params.id` before the call (1082, 1453).
 */
function remoteCallOf(pathInfo: readonly string[], key: RouteKeyResult, name: string): { requested: string; beanId?: string; dropsId: boolean } {
  const [, , third = '', fourth = ''] = pathInfo;
  if (pathInfo.length === 4 && third.length === 35 && cfEq(fourth, name)) return { requested: fourth, beanId: third, dropsId: true };
  if (pathInfo.length > 2 && third.length !== 35 && cfEq(third, name)) return { requested: third, dropsId: false };
  return { requested: key.params.id ?? name, dropsId: true };
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

  const scopes = legacyScopesFrom({ query: startedQuery(facts.query, restMode), body: facts.body, headers: { 'content-type': contentType }, url: facts.url });
  const apiSiteId = jsonApiSiteOf(segments, Object.fromEntries(scopes.form.entries), Object.fromEntries(scopes.url.entries), opts.siteExists);
  const reloadKey = opts.appReloadKey.toLowerCase();
  const urlEntries = scopes.url.entries.filter(([name]) => name.toLowerCase() !== reloadKey);
  const fieldnames = json ? undefined : postedFieldNames(facts.body);
  const formEntries = fieldnames === undefined ? scopes.form.entries : [...scopes.form.entries, ['fieldnames', fieldnames] as const];
  // deserializeJSON keeps a JSON null as a key without a value, which structAppend copies into params (408-412).
  const jsonEntries = json && isPlainObject(scopes.jsonBody) ? Object.entries(scopes.jsonBody) : [];
  const merged = structOf([...urlEntries, ...formEntries, ...jsonEntries]);
  const copied = copiedParams(merged, key, facts, restMode);
  const params = resolvedParams(copied, key);
  const target = targetOf(key);

  const requested = structGet(copied, 'method') ?? undefined;
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
  if (dotted !== undefined && (resolvedName !== undefined || target.kind === 'remote')) {
    const parts = cfListToArray(dotted, '.');
    pathInfo = [pathInfo[0] ?? '', parts[0] ?? '', parts.at(-1) ?? ''];
  }
  const remote = target.kind === 'remote' ? remoteCallOf(pathInfo, key, target.name) : undefined;

  const form = structOf(scopes.form.entries);
  // The entity route copies the resolved params into the form scope again before its switch (1239).
  for (const [name, value] of definedEntries(target.kind === 'entity' && !direct ? params : copied)) structSet(form, name, value);
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
  // Each remote dispatch sets `params.method` to the function name as requested (1064, 1166, 1451).
  if (remote !== undefined) structSet(params, 'method', remote.requested);
  if (remote?.dropsId === true) params.delete('id');
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
    method: remote?.requested ?? method,
    direct,
    withParams: !(pathPermissions || pathRelated),
    entityName,
    ...(entityConfigName === undefined ? {} : { entityConfigName }),
    ...(id === undefined ? {} : { id }),
    ...(ids === undefined ? {} : { ids }),
    ...(remote?.beanId === undefined ? {} : { beanId: remote.beanId }),
    ...(relatedContentSetId === undefined ? {} : { relatedContentSetId }),
    ...(render === undefined ? {} : { render }),
    pathInfo,
    params: createJsonApiParams(definedEntries(params)),
    echoParams: structRecord(params),
    requestParams: structRecord(merged),
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
export function requestProtocolOf(request: FastifyRequest): 'http' | 'https' {
  if (headerValue(request, 'x-forwarded-proto')?.toLowerCase() === 'https') return 'https';
  if (isTrue(headerValue(request, 'front-end-https'))) return 'https';
  return request.protocol === 'https' ? 'https' : 'http';
}

/** The client's host as the gateway forwards it: `X-Forwarded-Host` before the hop's own `Host`. */
export function clientHostOf(request: FastifyRequest): { name: string; port: string } {
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

/** The site URL values a request decides: its scheme, its host where the site answers to it (else the primary domain), the port, context and configBean URL flags. */
export function requestSiteUrls(
  site: Pick<TenantRegistryEntry, 'siteId' | 'domains'>,
  request: FastifyRequest,
  settings: JsonApiLegacySettings,
): Pick<LegacySiteUrlConfig, 'siteId' | 'scheme' | 'domain' | 'requestDomain' | 'serverPort' | 'context'> & JsonApiLegacySettings['urls'] {
  const domain = site.domains[0] ?? '';
  const host = clientHostOf(request);
  const onSiteDomain = site.domains.some((candidate) => candidate.toLowerCase() === host.name.toLowerCase());
  return {
    siteId: site.siteId,
    scheme: requestProtocolOf(request),
    domain,
    requestDomain: onSiteDomain ? host.name : domain,
    serverPort: settings.serverPort ?? serverPortSetting(host.port),
    context: settings.context,
    ...settings.urls,
  };
}

// strategies-content holds no tsettings or timagesizes projection (programs-sites owns them): the registry supplies the
// site's identity, domains and file pool, the configBean flags come from MURA_<KEY>, and every other value keeps the
// empty value or legacy default its type documents.
/** The URL settings of a registered site for this request. */
function siteUrlsOf(entry: TenantRegistryEntry, request: FastifyRequest, settings: JsonApiLegacySettings): LegacySiteUrlConfig {
  return {
    ...requestSiteUrls(entry, request, settings),
    previewDomain: '',
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

/** The request's spooled upload parts, each with its size, hash and stream factory for the domain's file writes. */
function uploadsOf(request: FastifyRequest): UploadedFile[] {
  return multipartFilesOf(request).map((part) => ({
    fieldName: part.field,
    fileName: part.filename,
    contentType: part.mimetype,
    size: part.size,
    sha256: part.sha256,
    stream: () => part.stream(),
  }));
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
  /** The registry's `default` site, from the same snapshot; undefined when it is not registered. */
  defaultSite: TenantRegistryEntry | undefined;
  related: RelatedEntityReader;
  sites: SitesClient;
}

/** The handler call of a served resolution. */
async function callOf(resolved: ResolvedJsonApiCall, scope: CallScope): Promise<JsonApiCall> {
  const { request, reply, ctx, settings, site, defaultSite } = scope;
  const actor = await ctx.actorFor(request);
  const urls = siteUrlsOf(site, request, settings);
  const defaultSiteUrls = defaultSite === undefined ? undefined : defaultSite === site ? urls : siteUrlsOf(defaultSite, request, settings);
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
  const files = save && multipartFilesOf(request).length > 0 ? uploadsOf(request) : undefined;
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
    ...(defaultSiteUrls === undefined ? {} : { defaultSiteUrls }),
    apiContext,
    httpMethod: resolved.key.httpMethod,
    headers: lowerHeaders(clientHeadersOf(request)),
    ...(files === undefined ? {} : { files }),
    // `!request.muraSessionManagement || $.validateCSRFTokens(...)`: the REST family runs without sessions (applicationSettings.cfm:179).
    validateCsrf: () => (restMode ? Promise.resolve(true) : consumeCsrf(request, reply, csrfContext)),
    related: scope.related,
  };
}

// ---- Responses ----

/** Legacy's one API serializer: the API hints and those every registered entity adds, which error envelopes are written with. */
const API_SERIALIZER = contentApiSerializer('content');

/** Params as an envelope echoes them: method and cache ids dropped, keys in ACF's order. */
function echoedParams(params: Struct): Struct {
  return inAcfOrder(paramsWithoutMethod(params)) as Struct;
}

/** A JSON API answer; only onError's page sets `statusText`. */
type JsonApiAnswer = SerializedLegacyResponse & { statusText?: string };

/**
 * onError's page with debugging off (onError_include.cfm:138-151) for echoed params holding a JSON null under a hinted key,
 * on which the serializer raises (jsonSerializer.cfc:288-290) in the answer and again in processRequest's catch block.
 * The headers set before serializing stay; the ETag, set after it, is never sent (jsonApiUtility.cfc:1471-1511).
 */
function unechoableAnswer(params: Struct, serializer: LegacyJsonSerializer, settings: JsonApiLegacySettings, wwwAuthenticate?: string): JsonApiAnswer | undefined {
  if (settings.suppressAPIParams || !serializer.nullUnderHint(params)) return undefined;
  const headers: Record<string, string> = { 'Content-Type': LEGACY_JSON_CONTENT_TYPE };
  if (wwwAuthenticate !== undefined) headers['WWW-Authenticate'] = wwwAuthenticate;
  return { status: 500, statusText: LEGACY_ERROR_STATUS_TEXT, headers, body: LEGACY_ERROR_PAGE_HTML };
}

/** What an error envelope reports beside its type; each defaults to the resolution's own. */
interface ErrorAnswerOptions {
  method?: string;
  params?: Struct;
  methodCtx?: ApiNameContext;
  wwwAuthenticate?: string;
  mura404?: boolean;
}

/** The error envelope of `type` as processRequest's catch blocks serialize it (jsonApiUtility.cfc:1318-1402). */
function errorAnswer(resolved: ResolvedJsonApiCall, type: string, settings: JsonApiLegacySettings, opts: ErrorAnswerOptions = {}): JsonApiAnswer {
  const params = echoedParams(opts.params ?? resolved.echoParams);
  const unechoable = unechoableAnswer(params, API_SERIALIZER, settings, opts.wwwAuthenticate);
  if (unechoable !== undefined) return unechoable;
  return legacyErrorResponse(type, {
    method: opts.method ?? resolved.method,
    params,
    methodCtx: opts.methodCtx ?? resolved.methodCtx,
    suppressAPIParams: settings.suppressAPIParams,
    serializer: API_SERIALIZER,
    ...(opts.wwwAuthenticate === undefined ? {} : { wwwAuthenticate: opts.wwwAuthenticate }),
    ...(opts.mura404 === true ? { mura404: true } : {}),
  });
}

/** The credential headers processRequest copies into params, in its order (jsonApiUtility.cfc:424-446). */
const CREDENTIAL_HEADERS: ReadonlyArray<readonly [header: string, param: string]> = Object.freeze([
  ['X-client_id', 'client_id'],
  ['X-client_secret', 'client_secret'],
  ['X-access_token', 'access_token'],
  ['X-client-id', 'client_id'],
  ['X-client-secret', 'client_secret'],
  ['X-access-token', 'access_token'],
] as const);

/** CFML `isDefined('params.<name>')`: a key holding a value, a JSON null being none. */
function isDefinedIn(params: CfStruct, name: string): boolean {
  const value = structGet(params, name);
  return value !== undefined && value !== null;
}

/** An OAuth endpoint path, as listFind compares its segments (jsonApiUtility.cfc:543-550). */
function onOAuthPath(segments: readonly string[]): boolean {
  const oauth = (segment: string | undefined): boolean => segment === 'oauth' || segment === 'oauth2';
  return (segments.length === 6 && oauth(segments[4])) || (segments.length === 5 && (oauth(segments[3]) || oauth(segments[4])));
}

/** `params.method` as the credential block leaves it, before processRequest resolves one: 'undefined' when none was sent. */
function credentialBlockMethod(params: CfStruct): string {
  const requested = structGet(params, 'method');
  if (requested === undefined || requested === null) return 'undefined';
  return simpleText(requested) ?? 'invalid';
}

/** Exceptions-list entry of the credential lookups {@link restCredentialAnswer} leaves to identity. */
const REST_CREDENTIALS_EXCEPTION = 'EX-JSONAPI-REST-CREDENTIALS';

/** The REST credential block (jsonApiUtility.cfc:422-560) of a tokenless call: request-decided answers; identity's client and token lookups fail closed. */
function restCredentialAnswer(
  resolved: ResolvedJsonApiCall,
  headers: JsonApiRequestFacts['headers'],
  segments: readonly string[],
  settings: JsonApiLegacySettings,
): JsonApiAnswer {
  const refuse = (what: string): never => {
    throw new LegacyServiceUnavailableError(`REST credentials of ${what} are verified by identity (${REST_CREDENTIALS_EXCEPTION})`, 'auto', 'jsonapi-rest-credentials');
  };
  if (headerText(headers, REST_CONSUMED_PARAMS_HEADER) !== undefined) refuse('a session that ended after the exchange');
  const params = structOf(Object.entries(resolved.requestParams));
  for (const [header, name] of CREDENTIAL_HEADERS) {
    const value = headerText(headers, header);
    if (value !== undefined) structSet(params, name, value);
  }
  if (isDefinedIn(params, 'access_token')) refuse('an access token');
  if (!isDefinedIn(params, 'client_id') && !isDefinedIn(params, 'refresh_token')) {
    for (const name of ['client_id', 'client_secret', 'refresh_token']) params.delete(name);
    const wwwAuthenticate = onOAuthPath(segments) ? WWW_AUTHENTICATE.bearerInvalidClientCredentials : WWW_AUTHENTICATE.basic;
    return errorAnswer(resolved, 'authorization', settings, { method: 'Not Available', params: structRecord(params), wwwAuthenticate });
  }
  // `oauthClient.loadBy(clientid=params.client_id)` of a refresh token alone reads an undefined element.
  if (!isDefinedIn(params, 'client_id')) {
    return errorAnswer(resolved, 'server_error', settings, { method: credentialBlockMethod(params), params: structRecord(params) });
  }
  // No OAuth client has an empty client id, so its lookup finds none and params become `{method='getOAuthToken'}` (558-567).
  if (simpleText(structGet(params, 'client_id')) === '') {
    return errorAnswer(resolved, 'authorization', settings, {
      method: 'getOAuthToken',
      params: {},
      wwwAuthenticate: WWW_AUTHENTICATE.bearerInvalidClientCredentials,
    });
  }
  return refuse('an OAuth client');
}

/** Whether processRequest answers `type` from `catch (Any e)`, the one catch block that logs (jsonApiUtility.cfc:1388-1389). */
function isUnhandled(type: string): boolean {
  return errorSpec(type).code === 'server_error';
}

/** `catch (Any e)`'s writeLog of the exception: an error record carrying its type, message and stack. */
function logUnhandled(request: FastifyRequest, err: unknown): void {
  request.log.error({ error: serializeError(err) }, 'unhandled JSON API error');
}

/** `$.event('useDataNamespace')`: the url value, else the form value. */
function useDataNamespaceOf(resolved: ResolvedJsonApiCall): string | undefined {
  return scopeString(resolved.url, 'usedatanamespace') ?? scopeString(resolved.form, 'usedatanamespace');
}

/** `value` with each struct in ACF's iteration order: Masa builds every response struct unordered (`{}`); a struct marked inLegacyOrder keeps its own. */
function inAcfOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inAcfOrder);
  if (!isPlainObject(value)) return value;
  const ordered: Struct = {};
  const keys = isInLegacyOrder(value) ? Object.keys(value) : acfKeyOrder(Object.keys(value).map((name): StructOp => ['set', name]));
  for (const key of keys) {
    Object.defineProperty(ordered, key, { value: inAcfOrder(value[key]), writable: true, enumerable: true, configurable: true });
  }
  return ordered;
}

/** processRequest's answer to a handler result (jsonApiUtility.cfc:891-898, 1307-1314, 1471-1511). */
function resultAnswer(resolved: ResolvedJsonApiCall, result: JsonApiResult, settings: JsonApiLegacySettings): JsonApiAnswer {
  if (result.error !== undefined) return errorAnswer(resolved, result.error, settings);
  // A direct method whose result is JSON text answers it as the body (891-897).
  if (result.rawJson !== undefined) return { status: 200, headers: { 'Content-Type': LEGACY_JSON_CONTENT_TYPE }, body: result.rawJson };
  // Direct methods and the path methods always answer 200; the entity route answers 403 when the result carries errors.
  const routed = !resolved.direct && resolved.target.kind === 'entity';
  const status = result.status === 404 ? 404 : routed ? (result.status ?? 200) : 200;
  const serializer = contentApiSerializer(result.serializerEntity ?? resolved.entityName);
  const params = resolved.withParams ? { params: echoedParams(resolved.echoParams) } : {};
  const unechoable = params.params === undefined ? undefined : unechoableAnswer(params.params, serializer, settings);
  if (unechoable !== undefined) return unechoable;
  return serializeResponse(buildEnvelope({ method: resolved.method, ...params, data: inAcfOrder(result.data) }), {
    statusCode: status,
    mura404: status === 404,
    serializer,
    suppressAPIParams: settings.suppressAPIParams,
    useDataNamespace: useDataNamespaceOf(resolved),
    useDataNamespaceForAPI: settings.useDataNamespaceForAPI,
    keyOrder: 'acf',
  });
}

/**
 * `invoke(entity, name, params)` of a remote function: it returns nothing, so building the envelope from its result
 * throws once it has run, and the call answers 500 `server_error` (jsonApiUtility.cfc:1083-1084; oracle: "Variable RESULT is undefined").
 */
function remoteHandler(fn: RemoteFunctionFn, beanId: string | undefined): JsonApiHandlerFn {
  return async (ctx, call) => {
    await fn(ctx, call, beanId);
    return { error: 'server_error' };
  };
}

/** The handler's answer, or the response processRequest's catch blocks give its exception. */
async function dispatch(resolved: ResolvedJsonApiCall, fn: JsonApiHandlerFn, scope: CallScope): Promise<JsonApiAnswer> {
  const call = await callOf(resolved, scope);
  // delete's `var csrfcontext=arguments.id` reads an undefined argument (jsonApiUtility.cfc:3262).
  if (resolved.target.kind === 'entity' && resolved.target.operation === 'delete' && resolved.id === undefined) {
    logUnhandled(scope.request, new LegacyApiError('server_error', { method: resolved.method }));
    return errorAnswer(resolved, 'server_error', scope.settings);
  }
  try {
    return resultAnswer(resolved, await fn(scope.ctx, call), scope.settings);
  } catch (err) {
    if (err instanceof LegacyApiError) {
      if (isUnhandled(err.type)) logUnhandled(scope.request, err);
      return errorAnswer(resolved, err.type, scope.settings, {
        ...(err.method === undefined ? {} : { method: err.method }),
        ...(err.params === undefined ? {} : { params: err.params }),
        ...(err.methodCtx === undefined ? {} : { methodCtx: err.methodCtx }),
        ...(err.wwwAuthenticate === undefined ? {} : { wwwAuthenticate: err.wwwAuthenticate }),
      });
    }
    // The domain refuses an image upload, whose renditions stay legacy-written (EX-FILE-RENDITION); domain/files.ts is not
    // a dependency of this module, so the refusal is recognised by its error name.
    if (err instanceof Error && err.name === 'ImageUploadHaltedError') {
      throw new LegacyServiceUnavailableError(err.message, 'auto', 'jsonapi-image-upload-halted');
    }
    if (err instanceof LegacyServiceUnavailableError || err instanceof AuthDenial || err instanceof RequestAbortedError) throw err;
    // catch (Any e) logs the exception and reports params.method as the failing call had set it (1390-1400).
    logUnhandled(scope.request, err);
    return errorAnswer(resolved, 'server_error', scope.settings);
  }
}

/** renderAuthDenial under the configured suppressAPIParams: the denial's status, the url scope as params. */
function denialAnswer(settings: JsonApiLegacySettings): DenialRenderer {
  return (denial, request) => {
    const url = isPlainObject(request.query) ? request.query : {};
    const response = legacyErrorResponse(denial.type, {
      method: scopeString(url, 'method'),
      params: echoedParams({ ...url }),
      suppressAPIParams: settings.suppressAPIParams,
      serializer: API_SERIALIZER,
      ...(denial.wwwAuthenticate === undefined ? {} : { wwwAuthenticate: denial.wwwAuthenticate }),
    });
    return { ...response, status: denial.statusCode };
  };
}

/** `handle`, answering an AuthDenial it throws by `render` as the auth hooks answer one; service-kit's error handler would ignore the route's renderer. */
function answeringDenials(
  handle: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
  render: DenialRenderer,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    try {
      return await handle(request, reply);
    } catch (err) {
      if (!(err instanceof AuthDenial)) throw err;
      recordOutcomeReason(request, err.reason);
      return sendLegacyResponse(reply, await render(err, request));
    }
  };
}

// ---- Routes ----

/**
 * Registers the contract's JSON API operations of every family (`/_api/{json,ajax,rest}/v1`, `…/{siteid}`,
 * `…/{siteid}/{path}`, each also behind `/index.cfm`); every path and method shares one handler. Throws EnvValidationError for malformed settings.
 */
export function registerJsonApiRoutes(
  app: FastifyInstance,
  ctx: ContentRouteContext,
  settings: JsonApiLegacySettings = jsonApiLegacySettings(),
): void {
  const snapshots = new WeakMap<FastifyRequest, Promise<TenantRegistryEntry[]>>();
  const renderDenial = denialAnswer(settings);
  const answer = answeringDenials(handle, renderDenial);
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
      // An unregistered siteid only selects the `default` fallback; a registered one, path element 4 included, must be the token's site.
      for (const supplied of [pathSegmentsOf(request.url)[3] ?? '', ...suppliedSiteIdsOf(request)]) {
        if (lookup(supplied) !== undefined) assertSiteMatches(supplied, user);
      }
    }
    // The REST family's credential block answers before any resolution (jsonApiUtility.cfc:422-560); the gateway exchanges
    // valid REST credentials for the user token, so a REST call reaches here without one only as the block left it.
    if (resolved.mode === 'rest' && user === undefined) {
      return sendLegacyResponse(reply, restCredentialAnswer(resolved, clientHeadersOf(request), pathSegmentsOf(request.url), settings));
    }
    const { target } = resolved;
    switch (target.kind) {
      case 'error':
        if (isUnhandled(target.type)) logUnhandled(request, new LegacyApiError(target.type, { method: resolved.method }));
        return sendLegacyResponse(reply, errorAnswer(resolved, target.type, settings));
      case 'foreign':
        // A key of another owner is no route of this service: the gateway routes it elsewhere.
        return sendLegacyResponse(reply, errorAnswer(resolved, 'invalidMethodCall', settings, { mura404: true }));
      case 'refused':
        throw new LegacyServiceUnavailableError(`JSON API ${resolved.key.key} is not served by strategies-content`, 'auto', target.reason);
      case 'entity':
      case 'method':
      case 'remote':
        break;
    }
    const site = lookup(resolved.params.string('siteid'));
    if (site === undefined) return sendLegacyResponse(reply, errorAnswer(resolved, 'invalidParameters', settings));
    if (user !== undefined) assertSiteMatches(site.siteId, user);
    const apiSite = lookup(resolved.apiSiteId)?.siteId ?? resolved.apiSiteId;
    // The token's tenant; a browser call without a session token is anonymous in the verified registry's tenant of its site.
    const tenantId = user?.tid ?? site.tenantId;
    const scope: CallScope = { request, reply, ctx, settings, tenantId, site, apiSite, defaultSite: lookup('default'), related: createRelatedEntityReader(ctx, sites), sites };
    if (target.kind === 'entity' ? READ_OPERATIONS.has(target.operation) : READ_METHODS.has(target.name)) abandonOnDisconnect(request);
    const fn = target.kind === 'remote' ? remoteHandler(target.fn, resolved.beanId) : target.fn;
    return sendLegacyResponse(reply, await dispatch(resolved, fn, scope));
  }

  for (const prefix of JSON_API_PREFIXES) {
    for (const url of [prefix, `${prefix}/:siteid`, `${prefix}/:siteid/*`]) {
      app.route({ method: [...ROUTE_METHODS], url, config: { opt2: { ...ROUTE_AUTH, renderDenial } }, onSend: allowOrigin, handler: answer });
    }
  }
}
