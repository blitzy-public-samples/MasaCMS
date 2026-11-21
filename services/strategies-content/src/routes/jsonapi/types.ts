/**
 * Contract between ../jsonapi.ts and the JSON API entity and method handlers of this folder, with the pure helpers they
 * share: access verdicts, result shaping, findProperties and the generic beanFeed query semantics
 * (core/mura/client/api/json/v1/jsonApiUtility.cfc, core/mura/bean/bean.cfc, core/mura/bean/beanFeed.cfc).
 */
import { hash } from 'node:crypto';
import { serialize } from 'node:v8';
import { Roles } from '@opt2/platform/auth';
import {
  acfKeyOrder,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  esapiUrlEncode,
  isValidVariableName,
  javaTrim,
  LegacyApiError,
  type LegacyApiErrorType,
  type StructOp,
} from '@opt2/platform/legacy-compat';
import type { Actor, SiteContentSettings } from '../../domain/context.js';
import type { UploadedFile } from '../../domain/files.js';
import { getModulePerm } from '../../domain/permissions.js';
import {
  queryColumns,
  type BeanFeedSource,
  type FeedCondition,
  type FeedCount,
  type FeedOperator,
  type FeedOrderTerm,
  type FeedParamCondition,
  type FeedParamType,
  type FeedQuery,
} from '../../repo/bean-feed-sql.js';
import { likeRuns, likeVerdict, type LikeRuns, type LikeToken } from '../../repo/feed-like.js';
import type {
  ContentEntityConfig,
  ContentEntityName,
  EntityPropertyHint,
  RelationProp,
} from '../../legacy/jsonapi-entities.js';
import { ENTITY_PROPERTIES } from '../../legacy/jsonapi-properties.js';
import {
  iteratorPage,
  iteratorRows,
  paramUrl,
  readRecords,
  urlParam,
  type ApiEntityView,
  type CollectionPage,
  type EntityCollectionSource,
  type ExpansionOptions,
  type ExpansionResolver,
  type IteratorRows,
  type JsonApiRequestContext,
  type RelatedContentSetSource,
} from '../../legacy/jsonapi-serializers.js';
// Type-only: ../index.ts imports ../jsonapi.ts, which imports this folder.
import type { ContentRouteContext } from '../index.js';
import { SpillSort } from './spill-sort.js';

export type {
  BeanFeedSource,
  FeedCondition,
  FeedCount,
  FeedOperator,
  FeedOrderTerm,
  FeedParamCondition,
  FeedParamType,
  FeedQuery,
  FeedScanRequest,
  FeedScanVisit,
} from '../../repo/bean-feed-sql.js';

type Struct = Record<string, unknown>;

/** API family mode; `rest` runs without session management (applicationSettings.cfm:179). */
export type JsonApiMode = 'json' | 'ajax' | 'rest';

/** Ordered, case-insensitive view of the merged legacy params (scanned query, then scanned form, then JSON body; jsonApiUtility.cfc:405-412). */
export interface JsonApiParams {
  /** The value under `name` in any case; undefined when absent. */
  get(name: string): unknown;
  /** The value as CFML converts it to a string; '' when absent. */
  string(name: string): string;
  has(name: string): boolean;
  /** Entries in first-insertion order, each under the casing it was first given. */
  entries(): ReadonlyArray<readonly [string, unknown]>;
  toRecord(): Record<string, unknown>;
}

/** The URL of the request: `raw` is `cgi.QUERY_STRING` without `?`, which the start-up scan leaves as sent; `params` is the URL scope only, as the scan leaves it. */
export interface JsonApiQuery {
  raw: string;
  params: JsonApiParams;
}

/** One resolved JSON API call, as ../jsonapi.ts hands it to a handler. */
export interface JsonApiCall {
  /** Request family mode. */
  mode: JsonApiMode;
  /** Route family, e.g. `/_api/json/v1`. */
  family: string;
  /** The shared route key, e.g. `api:content.findone`. */
  routeKey: string;
  /** Resolved legacy method (`findOne`, `findQuery`, `save`, … or a public method name). */
  method: string;
  /** Canonical entity name; `contentnav(s)` resolves to `content`. */
  entityName: string;
  /** `contentnav` when the request named it. */
  entityConfigName?: string;
  /** The incoming `id` argument as legacy passes it; for `_path` the joined filename. */
  id?: string;
  /** findMany ids. */
  ids?: string[];
  /** Related entity a path segment names. */
  relatedEntity?: string;
  /** Related content set id of a findRelatedContent call. */
  relatedContentSetId?: string;
  /** Set for `_path` and `_variation` renders (jsonApiUtility.cfc:1171-1190). */
  render?: { variation: boolean };
  /** Path segments after the API family. */
  pathInfo: readonly string[];
  /** Merged request params. */
  params: JsonApiParams;
  /** URL query string and URL scope. */
  query: JsonApiQuery;
  /** Legacy site id after the `default` fallback and the token site check. */
  siteId: string;
  /** Tenant UUID from the verified token (`tid`), never from params. */
  tenantId: string;
  /** The acting user. */
  actor: Actor;
  /** Site values, URL settings included, built by ../jsonapi.ts. */
  site: SiteContentSettings;
  /** URL settings of the `default` site, which settingsManager.getSite answers for site id ''; absent when it is not registered. */
  defaultSiteUrls?: SiteContentSettings['urls'];
  /** Request context passed unchanged to every serializer call. */
  apiContext: JsonApiRequestContext;
  /** HTTP method after `X-HTTP-Method-Override`. */
  httpMethod: string;
  /** Request headers under lower-cased names. */
  headers: Readonly<Record<string, string>>;
  /** Uploaded files of a multipart request. */
  files?: UploadedFile[];
  /**
   * `!request.muraSessionManagement || $.validateCSRFTokens(context=…)`, bound to the legacy context; true without
   * consuming a token in REST mode. Call it only where legacy validates, since a validation consumes the token.
   */
  validateCsrf(): Promise<boolean>;
  /** The arguments of a finder another entity's expansion or relation path calls. */
  finder?: RelatedFinder;
  /** The request's reader of related entities, set by ../jsonapi.ts. */
  related?: RelatedEntityReader;
}

/** findOne and findQuery arguments of a related read (jsonApiUtility.cfc:1086-1150, 2424-2497). */
export interface RelatedFinder {
  /** The `expand` list the related entity is serialized with; '' on a relation path. */
  expand: string;
  /** The depth reached: expandEntity's incremented depth, 0 on a relation path. */
  expanded: number;
  /** findQuery's `params` where they are not the URL scope: expandEntity's built params, or a relation path's request params. */
  params?: Record<string, unknown>;
}

/** Reads of other entities for one request, each through that entity's own handler and access rules. */
export interface RelatedEntityReader {
  /** findOne(entityName, id); `site` answers programs-sites' values of the request site. */
  findOne(call: JsonApiCall, entityName: string, id: string, finder: RelatedFinder): Promise<unknown>;
  /** findQuery(entityName, params); `queryString` replaces the request's on a relation path. */
  findQuery(
    call: JsonApiCall,
    entityName: string,
    finder: RelatedFinder & { params: Record<string, unknown> },
    queryString?: string,
  ): Promise<unknown>;
  /** The view's getCrumbIterator, as findCrumbArray reads it. */
  crumbs(call: JsonApiCall, view: ApiEntityView): Promise<EntityCollectionSource>;
  /** findRelatedContent(entity=view): every related-content set of the view's subtype, its items serialized under `opts`. */
  relatedContent(call: JsonApiCall, view: ApiEntityView, opts: ExpansionOptions): Promise<readonly RelatedContentSetSource[]>;
}

/** A relation path's source loadBy (jsonApiUtility.cfc:1093-1146): by `contentid` for a content relation, else by the bean's primary key. */
export type RelationSourceKey = { contentid: string } | { primaryKey: string };

/** `bean.get(bean.translatePropKey(name))` of a loaded source bean; `primaryKey` names its primary key. */
export type SourceBeanGetter = (name: string) => unknown;

/** A handler's answer: `data` for the envelope, `rawJson` as the whole body, or `error` for the legacy error response. */
export interface JsonApiResult {
  status?: 200 | 403 | 404;
  data?: unknown;
  /** JSON text returned as the body without an envelope (methods whose result `isJson`, jsonApiUtility.cfc:891-898). */
  rawJson?: string;
  error?: LegacyApiErrorType;
  /** Entity whose `contentApiSerializer` hints serialize `data`. */
  serializerEntity?: string;
}

/** Handles one resolved call. */
export type JsonApiHandlerFn = (ctx: ContentRouteContext, call: JsonApiCall) => Promise<JsonApiResult>;

/** An entity bean's `access="remote"` function, run on the bean `loadBy` loaded under `beanId`, or on a new bean when it is undefined. */
export type RemoteFunctionFn = (ctx: ContentRouteContext, call: JsonApiCall, beanId: string | undefined) => Promise<void>;

/** The generic-method handlers of one entity; an absent method is not served for it. */
export interface EntityHandler {
  entity: ContentEntityName;
  config: ContentEntityConfig;
  findOne?: JsonApiHandlerFn;
  findMany?: JsonApiHandlerFn;
  findAll?: JsonApiHandlerFn;
  findNew?: JsonApiHandlerFn;
  findQuery?: JsonApiHandlerFn;
  findProperties?: JsonApiHandlerFn;
  findPermissions?: JsonApiHandlerFn;
  save?: JsonApiHandlerFn;
  delete?: JsonApiHandlerFn;
  validate?: JsonApiHandlerFn;
  /** loadBy of the bean as a relation path's source; absent where the bean has no loadBy (bean.cfc:182). */
  loadBy?: (ctx: ContentRouteContext, call: JsonApiCall, key: RelationSourceKey) => Promise<SourceBeanGetter>;
}

/** Handles a public method such as `findCrumbArray`. */
export type MethodHandler = JsonApiHandlerFn;

/** The error CFML raises converting a complex value to a string. */
function complexValueError(): TypeError {
  return new TypeError('Complex object types cannot be converted to simple values.');
}

/** CFML conversion of a simple value to a string; '' for null or undefined. */
function cfText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  throw complexValueError();
}

/** The key of `record` matching `name` ignoring case. */
function keyOf(record: Readonly<Struct>, name: string): string | undefined {
  if (Object.hasOwn(record, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === lower);
}

/** CFML struct write: replaces an existing key ignoring case, else adds it. */
function setNoCase(record: Struct, name: string, value: unknown): void {
  Object.defineProperty(record, keyOf(record, name) ?? name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** A JsonApiParams view of `entries`; a later duplicate key replaces the value and keeps the first position and casing. */
export function createJsonApiParams(entries: Iterable<readonly [string, unknown]>): JsonApiParams {
  const byLower = new Map<string, [string, unknown]>();
  for (const [key, value] of entries) {
    const held = byLower.get(key.toLowerCase());
    if (held === undefined) byLower.set(key.toLowerCase(), [key, value]);
    else held[1] = value;
  }
  const get = (name: string): unknown => byLower.get(name.toLowerCase())?.[1];
  return {
    get,
    string: (name) => cfText(get(name)),
    has: (name) => byLower.has(name.toLowerCase()),
    entries: () => [...byLower.values()].map(([key, value]) => [key, value] as const),
    toRecord: () => {
      const record: Struct = {};
      for (const [key, value] of byLower.values()) setNoCase(record, key, value);
      return record;
    },
  };
}

/** CFML isStruct for plain data. */
function isStruct(value: unknown): value is Struct {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** processRequest's status rule (jsonApiUtility.cfc:1310-1314): 403 when `data.errors` is a non-empty struct, else 200. */
export function jsonApiResultOf(data: unknown, serializerEntity?: string): JsonApiResult {
  const errorsKey = isStruct(data) ? keyOf(data, 'errors') : undefined;
  const errors = errorsKey === undefined ? undefined : (data as Struct)[errorsKey];
  const status = isStruct(errors) && Object.keys(errors).length > 0 ? 403 : 200;
  return serializerEntity === undefined ? { status, data } : { status, data, serializerEntity };
}

/** The expand list and depth a finder serializes with: its related caller's, else the request's `expand` at depth 0. */
export function finderOf(call: JsonApiCall): ExpansionOptions {
  return call.finder === undefined ? { expand: call.params.string('expand'), expanded: 0 } : { expand: call.finder.expand, expanded: call.finder.expanded };
}

/** findQuery's `params`: the related caller's, else the URL scope. */
export function finderParamsOf(call: JsonApiCall): Struct {
  return call.finder?.params ?? call.apiContext.url;
}

/** The request's related-entity reader. */
export function relatedReaderOf(call: JsonApiCall): RelatedEntityReader {
  if (call.related === undefined) throw new Error(`JSON API call ${call.routeKey} carries no related-entity reader`);
  return call.related;
}

/**
 * expandEntity's data access (jsonApiUtility.cfc:2424-2497) through the request's related-entity reader: hasMany through
 * findQuery of `prop.cfc`, hasOne through findOne (`site` for the site relation), crumbs and related content as legacy reads them.
 */
export function relatedResolver(call: JsonApiCall): ExpansionResolver {
  return {
    hasMany: async (prop, params, opts) => relatedReaderOf(call).findQuery(call, prop.cfc, { ...opts, params }),
    hasOne: async (prop, id, opts) => relatedReaderOf(call).findOne(call, cfEq(prop.name, 'site') ? 'site' : prop.cfc, cfText(id), opts),
    crumbs: async (view) => relatedReaderOf(call).crumbs(call, view),
    relatedContent: async (view, opts) => relatedReaderOf(call).relatedContent(call, view, opts),
  };
}

/** The `authorization` exception (401 Insufficient Account Permissions). */
export function authorizationDenied(): JsonApiResult {
  return { error: 'authorization' };
}

/** AllowAccess (jsonApiUtility.cfc:1686-1738) for a strategies-content entity: public, else its module permission. */
export function entityAccessAllowed(actor: Actor, config: ContentEntityConfig): boolean {
  return config.public || getModulePerm(actor, config.moduleId);
}

/**
 * AllowAction's default branch (jsonApiUtility.cfc:1820-1826): the module permission, public entities included; content
 * beans take the node-permission branch instead (`allowContentAction`).
 */
export function entityActionAllowed(actor: Actor, config: ContentEntityConfig): boolean {
  return getModulePerm(actor, config.moduleId);
}

/** Inputs of {@link permissionsOf}. */
export interface PermissionsInput {
  /** `get('siteid') != ''` on the bean. */
  hasSiteId: boolean;
  /** Bean getPublicAPI() or (AllowAccess and allowRead). */
  readAllowed: boolean;
  /** AllowAction for the bean. */
  actionAllowed: boolean;
  /** The bean's own allowSave(), false unless overridden (bean.cfc:1353; comment overrides it). */
  saveAllowed?: boolean;
  /** The bean's own allowDelete(), false unless overridden (bean.cfc:1357). */
  deleteAllowed?: boolean;
}

/** bean.getPermissions (bean.cfc:1499-1521) as findPermissions answers it (jsonApiUtility.cfc:2262-2264). */
export function permissionsOf(input: PermissionsInput): { read: boolean; delete: boolean; save: boolean } {
  if (!input.hasSiteId) return { read: false, delete: false, save: false };
  return {
    read: input.readAllowed,
    delete: (input.deleteAllowed ?? false) || input.actionAllowed,
    save: (input.saveAllowed ?? false) || input.actionAllowed,
  };
}

// Structs built in legacy's iteration order: Masa reaches them through writes, deletes and resizes, or reads them from
// component metadata, so ACF's order of their final keys alone does not give that order.
const IN_LEGACY_ORDER = new WeakSet<object>();

/** Marks `struct` as holding its keys in the order legacy iterates it, which the response then keeps. */
export function inLegacyOrder<T extends object>(struct: T): T {
  IN_LEGACY_ORDER.add(struct);
  return struct;
}

/** Whether {@link inLegacyOrder} marked `struct`. */
export function isInLegacyOrder(struct: object): boolean {
  return IN_LEGACY_ORDER.has(struct);
}

/** CFML listFindNoCase. */
function listFindNoCase(list: string, value: string): boolean {
  const lower = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === lower);
}

/** findProperties (jsonApiUtility.cfc:1548-1618) from the entity's recorded metadata, in legacy key order. */
export function findPropertiesFor(config: ContentEntityConfig, call: JsonApiCall): Record<string, unknown> {
  const meta = ENTITY_PROPERTIES[config.name];
  const fields = (config.fields ?? []).join(',');
  const requested = cfListToArray(call.params.string('properties')).map((p) => p.toLowerCase());
  const names = requested.length > 0 ? requested : [...meta.formats.keys()];
  const properties = names
    .filter((name) => fields === '' || listFindNoCase(fields, name))
    .flatMap((name) => {
      // `props[p]` of an undeclared name raises; a declared name without a format is persistent=false without a cfc.
      if (!config.declaredProperties.has(name)) throw serverError();
      const format = meta.formats.get(name);
      return format === undefined ? [] : [inLegacyOrder({ ...format })];
    });

  const endpoint = call.apiContext.endpoint;
  const actor = call.actor;
  // The order ACF iterates formatArray's struct after the entity values, `table` and `properties` are written and `items` deleted.
  const result: Struct = {
    displayname: config.displayName,
    properties,
    historical: false,
    links: {
      swagger_json: `${endpoint}/swagger?mode=json&entities=${call.entityName}`,
      endpoint: `${endpoint}/${call.entityName}`,
      swagger_rest: `${endpoint}/swagger?mode=rest&entities=${call.entityName}`,
      self: `${endpoint}/${call.entityName}/properties`,
      entities: endpoint,
    },
    dynamic: false,
  };
  if (actor.s2 || actor.roles.includes(Roles.s2) || actor.roles.includes(Roles.siteAdmin)) result['table'] = meta.table;
  Object.assign(result, {
    primarykey: config.primaryKey.toLowerCase(),
    public: config.public,
    bundleable: meta.bundleable,
    orderby: meta.orderby,
    entityname: config.displayName,
    scaffold: false,
  });
  return inLegacyOrder(result);
}

/** An entity feed's default sort, e.g. comment feeds sort by `entered asc` (contentCommentFeedBean.cfc:84-85). */
export interface BeanFeedDefaultSort {
  sortBy: string;
  sortDirection?: 'asc' | 'desc';
}

/** The entity metadata {@link beanFeedQuery} applies request params against. */
export interface BeanFeedOptions {
  /** The bean's getPrimaryKey(); `id` filters by it and a `fields` list always selects it. */
  primaryKey: string;
  /** Names hasProperty accepts: declared properties and their columns. */
  propertyNames: readonly string[];
  /** The entity feed's default sortBy and sortDirection; a plain beanFeed has none. */
  defaultSort?: BeanFeedDefaultSort;
  /** The entity feed's own setOrderBy list (e.g. changesetBean.getFeed's `name asc`); a request `sort` or `orderby` replaces it, `sortBy` never does. */
  defaultOrderBy?: string;
  /** `ContentEntityConfig.hints`, which type numeric and date columns; every other column compares as varchar. */
  hints?: Readonly<Record<string, EntityPropertyHint>>;
  /** The entity's `hasMany` and `hasOne` relations, which `innerJoin` and `leftJoin` resolve against. */
  relations?: readonly RelationProp[];
  /** The table's columns; defaults to the keys of the rows, and without rows no column is checked. */
  columns?: readonly string[];
  /** The legacy table, which a qualified sort term may name. */
  table?: string;
  /** expandEntity's params (jsonApiUtility.cfc:2424-2470); each key filters by equality instead of the query string. */
  expandedParams?: Readonly<Record<string, unknown>>;
}

/** countOnly's count, or one page of the selected rows between its blank rows, with the base URL findQuery's paging links use. */
export type BeanFeedResult<R> = { count: number } | { items: Array<R | BlankFeedRow>; page: CollectionPage; baseUrl?: string };

/** A row before the first or past the last record, which queryRowToStruct reads as '' in every column (queryIterator.cfc:303-331). */
export type BlankFeedRow = Readonly<Record<string, ''>>;

/**
 * A feed request legacy answers with rows the in-memory feed cannot compute: an aggregate SELECT (sum, avg, count, min,
 * max, groupBy) SQL Server accepts, an inner join on one of the entity's relations, or a LIKE class whose `--`, range
 * end or tested character's collation order is not reproduced. The service-kit error handler answers it with the legacy
 * 500 and logs it as unhandled.
 */
export class UnsupportedFeedQueryError extends Error {
  override readonly name: string = 'UnsupportedFeedQueryError';
}

type ParamType = FeedParamType;
type Condition = FeedOperator | '';

/** One row of beanFeed's params query, as mura.queryParam leaves it. */
interface FeedParam {
  relationship: string;
  /** Column text; '' for a grouping param. */
  field: string;
  type: ParamType;
  condition: Condition;
  criteria: string;
  isNull: boolean;
  /** The compiled pattern of a `like` param. */
  pattern?: LikePattern;
}

/** One ORDER BY item before validateSort: the term text and whether its table is the entity's own. */
interface OrderItem {
  text: string;
  ownTable: boolean;
}

type Truth = boolean | null;
type Expr = FeedCondition;

// findQuery's two exclusion lists (jsonApiUtility.cfc:2800 and 2850), lower-cased.
const EXPANDED_EXCLUDED: ReadonlySet<string> = new Set(
  'expanddepth,muraPointInTime,liveOnly,feedid,maxItems,pageIndex,sort,itemsPerPage,sortBy,sortDirection,contentpoolid,shownavonly,showexcludesearch,includehomepage,feedname,expand,useCategoryIntersect,useDataNamespace'
    .toLowerCase()
    .split(','),
);
const QUERY_EXCLUDED: ReadonlySet<string> = new Set(
  'expanddepth,expand,muraPointInTime,liveOnly,feedid,cacheid,_cacheid,distinct,fields,entityname,method,maxItems,pageIndex,itemsPerPage,sortBy,sortDirection,contentpoolid,shownavonly,showexcludesearch,includehomepage,feedname,useCategoryIntersect,useDataNamespace'
    .toLowerCase()
    .split(','),
);
// The grouping keywords findQuery passes as a param's relationship; queryParam.setRelationship accepts them in any case.
const GROUPING_KEYS: ReadonlySet<string> = new Set([
  'opengrouping',
  'oropengrouping',
  'andopengrouping',
  'closegrouping',
]);
const AGGREGATE_KEYS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'max', 'min', 'groupby']);
// Instance values of every bean that are not properties (bean.cfc:100-101): valueExists without hasProperty.
const BEAN_NON_PROPERTY_VALUES: ReadonlySet<string> = new Set(['addobjects', 'removeobjects']);
// The set<name> methods of bean, beanFeed and cfobject; addParam hands a field so named to the setter, not the WHERE clause.
const FEED_SETTERS: ReadonlySet<string> = new Set([
  'addedobjectvalues',
  'advancedparams',
  'allvalues',
  'configbean',
  'distinct',
  'entityname',
  'errors',
  'fields',
  'itemsperpage',
  'lastupdateby',
  'maxitems',
  'nextn',
  'orderby',
  'params',
  'propasidcolumn',
  'sort',
  'sortdirection',
  'validations',
  'value',
]);
// configBean deniedFeedJoinTables default (configBean.cfc:162).
const DENIED_FEED_TABLES: ReadonlySet<string> = new Set(
  'tusers,tusersmemb,tusergroups,tsettings,tusersession,toauthtokens,tremembertokens,tpermissions,tsessiontracking,tredirects,toauthclients,tuserremotesessions,tuserdevice'.split(
    ',',
  ),
);
// Related entities whose table is denied: `site` maps tsettings.
const DENIED_RELATED_ENTITIES: ReadonlySet<string> = new Set(['site']);
const DEFAULT_NEXT_N = 1000;
const SORT_FIELD = /^[a-zA-Z0-9_.]+$/;
const COLLATOR = new Intl.Collator('en', { sensitivity: 'accent' });

/** The server_error a SQL Server or CFML error raises inside processRequest. */
function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/** CFML listFirst: the first non-empty item, or ''. */
function cfListFirst(list: string, delim: string): string {
  return cfListToArray(list, delim)[0] ?? '';
}

/** CFML URLDecode, leaving malformed escapes as they are. */
function urlDecode(value: string): string {
  return value.replaceAll('+', ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The value under `name` ignoring case. */
function getNoCase(record: Readonly<Struct>, name: string): unknown {
  const key = keyOf(record, name);
  return key === undefined ? undefined : record[key];
}

/** utility.sanitizeFeedIdentifier: word characters only. */
function feedIdentifier(value: string): string {
  return value.replace(/[^0-9A-Za-z_]/g, '');
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AaPp])[Mm])?)?$/;
const ODBC_DATE = /^\{(?:ts|d) '([^']*)'\}$/;

/** A valid local date from its parts, or undefined. */
function localDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date | undefined {
  const date = new Date(y, mo - 1, d, h, mi, s, ms);
  const valid =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi;
  return valid && s < 60 ? date : undefined;
}

/** CFML isDate / parseDateTime for the ISO, US and ODBC forms, in the process time zone; undefined when not a date. */
function parseCfDate(value: string): Date | undefined {
  const text = value.trim().replace(ODBC_DATE, '$1');
  const iso = ISO_DATE.exec(text);
  if (iso !== null) {
    const [, y, mo, d, h, mi, s, ms] = iso;
    return localDate(
      Number(y),
      Number(mo),
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
      Number((ms ?? '0').padEnd(3, '0')),
    );
  }
  const us = US_DATE.exec(text);
  if (us === null) return undefined;
  const [, mo, d, y, h, mi, s, meridiem] = us;
  let hours = Number(h ?? 0);
  if (meridiem !== undefined) {
    if (hours < 1 || hours > 12) return undefined;
    hours = (hours % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  }
  return localDate(Number(y), Number(mo), Number(d), hours, Number(mi ?? 0), Number(s ?? 0));
}

/** A row's timestamp value in milliseconds; undefined when it is not a date. */
function timeOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? parseCfDate(value)?.getTime() : undefined;
}

/** Whether `token` matches the code unit `ch`; a class verdict the in-memory feed cannot compute raises. */
function likeTokenMatches(token: LikeToken, ch: string): boolean {
  const verdict = likeVerdict(token, ch);
  if (verdict === 'unsupported' && token.kind === 'class') throw new UnsupportedFeedQueryError(`LIKE class [${token.content}]`);
  return verdict === 'match';
}

/** Whether `run` matches `text` at offset `at`. */
function likeRunAt(run: readonly LikeToken[], text: string, at: number): boolean {
  return at + run.length <= text.length && run.every((token, i) => likeTokenMatches(token, text.charAt(at + i)));
}

/** A SQL Server LIKE pattern (`%`, `_` and `[...]` classes) matched case-insensitively without backtracking. */
class LikePattern {
  private readonly runs: LikeRuns;

  constructor(pattern: string) {
    this.runs = likeRuns(pattern);
  }

  /** Whether `text` matches; each middle run takes its leftmost fit, which is optimal for fixed-length runs. */
  matches(text: string): boolean {
    const { head, middle, tail } = this.runs;
    if (tail === undefined) return text.length === head.length && likeRunAt(head, text, 0);
    if (!likeRunAt(head, text, 0)) return false;
    let cursor = head.length;
    for (const run of middle) {
      const latest = text.length - run.length;
      let at = cursor;
      while (at <= latest && !likeRunAt(run, text, at)) at++;
      if (at > latest) return false;
      cursor = at + run.length;
    }
    const start = text.length - tail.length;
    return start >= cursor && likeRunAt(tail, text, start);
  }
}

/** queryParam.setCondition (queryParam.cfc:159-196): the SQL operator, '' for an unknown condition. */
function sqlCondition(condition: string, type: ParamType): Condition {
  switch (condition.toLowerCase()) {
    case 'equals':
    case 'eq':
    case 'is':
    case '=':
      return '=';
    case 'gt':
    case '>':
      return '>';
    case 'in':
      return 'in';
    case 'notin':
    case 'not in':
      return 'not in';
    case 'neq':
    case '!=':
      return '!=';
    case 'gte':
    case '>=':
      return '>=';
    case 'lt':
    case '<':
      return '<';
    case 'lte':
    case '<=':
      return '<=';
    case 'begins':
    case 'beginswith':
    case 'contains':
    case 'containsvalue':
    case 'like':
    case 'ends':
    case 'endswith':
      return type === 'varchar' ? 'like' : '=';
    default:
      return '';
  }
}

/** queryParam.setCriteria (queryParam.cfc:214-308); a value the type cannot hold becomes '', which SQL Server rejects. */
function sqlCriteria(criteria: string, condition: string, type: ParamType): { criteria: string; isNull: boolean } {
  if (criteria.toLowerCase() === 'null') return { criteria: 'null', isNull: true };
  if (type === 'numeric') return { criteria: cfIsNumeric(criteria) ? criteria : '', isNull: false };
  if (type === 'timestamp') return { criteria: parseCfDate(criteria) === undefined ? '' : criteria, isNull: false };
  switch (condition.toLowerCase()) {
    case 'begins':
    case 'beginswith':
      return { criteria: `${criteria}%`, isNull: false };
    case 'ends':
    case 'endswith':
      return { criteria: `%${criteria}`, isNull: false };
    case 'contains':
    case 'containsvalue':
    case 'like':
      return { criteria: `%${criteria}%`, isNull: false };
    default:
      return { criteria, isNull: false };
  }
}

/** SQL Server ordering of two non-null column values of `type` (case-insensitive collation, trailing spaces ignored). */
function compareNonNull(a: unknown, b: unknown, type: ParamType): number {
  if (type === 'numeric') return Number(a) - Number(b);
  if (type === 'timestamp') return (timeOf(a) ?? 0) - (timeOf(b) ?? 0);
  return COLLATOR.compare(cfText(a).trimEnd(), cfText(b).trimEnd());
}

/** Parses the params' token list with SQL precedence (AND before OR); a malformed list is a SQL syntax error. */
class ConditionParser {
  private pos = 0;

  constructor(private readonly tokens: readonly (string | FeedParamCondition)[]) {}

  parse(): Expr {
    const expr = this.or();
    if (this.pos !== this.tokens.length) throw serverError();
    return expr;
  }

  private or(): Expr {
    let left = this.and();
    while (this.tokens[this.pos] === 'or') {
      this.pos++;
      left = { kind: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): Expr {
    let left = this.unary();
    while (this.tokens[this.pos] === 'and') {
      this.pos++;
      left = { kind: 'and', left, right: this.unary() };
    }
    return left;
  }

  private unary(): Expr {
    const token = this.tokens[this.pos++];
    if (token === '(') {
      const expr = this.or();
      if (this.tokens[this.pos++] !== ')') throw serverError();
      return expr;
    }
    if (token === undefined || typeof token === 'string') throw serverError();
    return token;
  }
}

/** A WHERE-clause param as the feed plan carries it. */
function conditionOf(param: FeedParam, condition: FeedOperator): FeedParamCondition {
  const { field, type, criteria, isNull } = param;
  const listed = condition === 'in' || condition === 'not in';
  const items = cfListToArray(criteria);
  const compared = listed ? (items.length > 0 ? items : ['']) : [criteria];
  return {
    kind: 'param',
    column: field.toLowerCase(),
    field,
    type,
    condition,
    criteria,
    isNull,
    ...(listed ? { items: compared } : {}),
    ...(param.pattern === undefined ? {} : { pattern: criteria }),
    ...(type === 'timestamp' ? { times: compared.map((value) => timeOf(value) ?? 0) } : {}),
  };
}

const likePatterns = new WeakMap<FeedParamCondition, LikePattern>();

/** The compiled `like` pattern of a param, once per param. */
function likePattern(param: FeedParamCondition, pattern: string): LikePattern {
  let compiled = likePatterns.get(param);
  if (compiled === undefined) {
    compiled = new LikePattern(pattern);
    likePatterns.set(param, compiled);
  }
  return compiled;
}

/** SQL three-valued truth of `param` for `row`. */
function paramTruth(param: FeedParamCondition, row: Readonly<Struct>): Truth {
  const value = getNoCase(row, param.field);
  if (param.isNull) {
    if (param.condition === '=') return value === null || value === undefined;
    if (param.condition === '!=') return value !== null && value !== undefined;
    return null;
  }
  if (value === null || value === undefined) return null;
  if (param.pattern !== undefined) return likePattern(param, param.pattern).matches(cfText(value).trimEnd());
  if (param.condition === 'in' || param.condition === 'not in') {
    const found = (param.items ?? ['']).some((item) => compareNonNull(value, item, param.type) === 0);
    return param.condition === 'in' ? found : !found;
  }
  const order = compareNonNull(value, param.criteria, param.type);
  switch (param.condition) {
    case '=':
      return order === 0;
    case '!=':
      return order !== 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    default:
      return order <= 0;
  }
}

/** SQL three-valued evaluation of `expr` for `row`. */
function exprTruth(expr: Expr, row: Readonly<Struct>): Truth {
  if (expr.kind === 'param') return paramTruth(expr, row);
  const left = exprTruth(expr.left, row);
  const right = exprTruth(expr.right, row);
  if (expr.kind === 'and') {
    if (left === false || right === false) return false;
    return left === true && right === true ? true : null;
  }
  if (left === true || right === true) return true;
  return left === false && right === false ? false : null;
}

/** Raises the error filtering `rows` by `where` raises at its first row that raises one. */
function raiseFilter(where: Expr | undefined, rows: readonly Readonly<Struct>[]): void {
  if (where !== undefined) for (const row of rows) exprTruth(where, row);
}

/** beanFeed state a request builds (beanFeed.cfc:301-346, 614-733), evaluated by its source in getQuery's order (819-1111). */
class BeanFeed<R extends Readonly<Struct>> {
  readonly params: FeedParam[] = [];
  readonly groupBy: string[] = [];
  readonly aggregates: string[] = [];
  readonly joins: { kind: 'inner' | 'left'; cfc: string }[] = [];
  orderBy: OrderItem[] = [];
  sortBy: string;
  sortDirection: string;
  maxItems = 0;
  nextN = DEFAULT_NEXT_N;
  private readonly columns: ReadonlySet<string> | undefined;
  private readonly properties: ReadonlySet<string>;
  /** The query whose count a scan answered, and whether its selected rows hold a value the comparator cannot order. */
  private scanned: { query: FeedQuery; unstable: boolean } | undefined;

  /** `columns` are the table's, or undefined for a scope without rows whose columns were not declared. */
  constructor(
    private readonly source: BeanFeedSource<R>,
    columns: readonly string[] | undefined,
    private readonly options: BeanFeedOptions,
  ) {
    this.sortBy = options.defaultSort?.sortBy ?? '';
    this.sortDirection = options.defaultSort?.sortDirection ?? 'asc';
    this.orderBy = cfListToArray(options.defaultOrderBy ?? '').map((text): OrderItem => ({ text, ownTable: false }));
    this.properties = new Set(options.propertyNames.map((name) => name.toLowerCase()));
    this.columns = columns === undefined ? undefined : new Set(columns.map((c) => c.toLowerCase()));
  }

  /** bean.valueExists: a property or one of the base bean's other instance values. */
  valueExists(name: string): boolean {
    return this.properties.has(name.toLowerCase()) || BEAN_NON_PROPERTY_VALUES.has(name.toLowerCase());
  }

  hasProperty(name: string): boolean {
    return this.properties.has(name.toLowerCase());
  }

  /** The param type of `field`'s column: from its hint, varchar for anything else. */
  private typeOf(field: string): ParamType {
    const column = field.split('.').at(-1) ?? '';
    if (this.columns !== undefined && !this.columns.has(column.toLowerCase())) return 'varchar';
    const hints = this.options.hints ?? {};
    const hint = hints[keyOf(hints, column) ?? ''];
    if (hint === 'date') return 'timestamp';
    return hint === undefined ? 'varchar' : 'numeric';
  }

  /** beanFeed.addParam with mura.queryParam's field, relationship, condition and criteria rules. */
  addParam(field: string, criteria: string, condition = 'EQUALS', relationship = 'and'): void {
    const sanitized = field.replace(/[^0-9A-Za-z._,\-*]/g, '');
    if (isValidVariableName(sanitized) && FEED_SETTERS.has(sanitized.toLowerCase())) {
      this.applySetter(sanitized.toLowerCase(), criteria);
      return;
    }
    const type = this.typeOf(sanitized);
    const rel = relationship.toLowerCase();
    const accepted = rel === 'and' || rel === 'or' || GROUPING_KEYS.has(rel) ? rel : '';
    const column = sanitized.replace(/[^\w.]+/g, '');
    if (column === '' && !GROUPING_KEYS.has(accepted)) return;
    const operator = sqlCondition(condition, type);
    const value = sqlCriteria(criteria, condition, type);
    this.params.push({
      relationship: accepted,
      field: GROUPING_KEYS.has(accepted) ? '' : column,
      type,
      condition: operator,
      ...value,
      ...(operator === 'like' && !value.isNull ? { pattern: new LikePattern(value.criteria) } : {}),
    });
  }

  /** Of the setters a filter can reach (findQuery excludes maxItems, itemsPerPage, sortDirection), only setNextN pages rows. */
  private applySetter(name: string, value: string): void {
    if (name === 'nextn' && cfIsNumeric(value)) this.nextN = cfToNumber(value);
  }

  /** beanFeed.setSortDirection: only asc or desc, in any case. */
  setSortDirection(value: string): void {
    if (value.toLowerCase() === 'asc' || value.toLowerCase() === 'desc') this.sortDirection = value;
  }

  /** beanFeed.aggregate (beanFeed.cfc:697-733). */
  aggregate(type: string, value: string): void {
    if (value.trim() === '') return;
    const target = type === 'groupby' ? this.groupBy : this.aggregates;
    target.push(...cfListToArray(value).map((p) => p.trim()));
  }

  /** beanFeed.innerJoin / leftJoin: a join only for a relation whose cfc is `related`. */
  join(kind: 'inner' | 'left', related: string): void {
    const relation = (this.options.relations ?? []).find((prop) => cfEq(prop.cfc, related));
    if (relation !== undefined) this.joins.push({ kind, cfc: relation.cfc });
  }

  /** setFeedProps' sort list (jsonApiUtility.cfc:3012-3073) as ORDER BY items. */
  setSort(sort: string): void {
    this.orderBy = cfListToArray(sort).map((s): OrderItem => {
      if (s.length <= 1) return { text: s, ownTable: false };
      const signed = s.startsWith('+') || s.startsWith('-');
      const prop = signed ? s.slice(1) : s;
      const ownTable = cfListToArray(prop, '.').length === 1;
      return { text: `${ownTable ? 'own.' : ''}${prop} ${s.startsWith('-') ? 'desc' : 'asc'}`, ownTable };
    });
  }

  /** isDeniedFeedTable (utility.cfc:338-346) for a possibly qualified reference. */
  private denied(reference: string): boolean {
    const table = feedIdentifier(cfListFirst(reference, '.'));
    if (this.options.table !== undefined && table.toLowerCase() === feedIdentifier(this.options.table).toLowerCase())
      return false;
    return DENIED_FEED_TABLES.has(table.toLowerCase());
  }

  /** getQuery's denied-table checks, which run before any SQL (beanFeed.cfc:843-875). */
  private checkDeniedTables(): void {
    const references = [
      ...this.groupBy,
      ...this.aggregates,
      ...this.orderBy.filter((item) => !item.ownTable).map((item) => cfListFirst(item.text.trim(), ' ')),
      ...(cfListToArray(this.sortBy, '.').length > 1 ? [this.sortBy] : []),
    ];
    const deniedJoin = this.joins.some((j) => DENIED_RELATED_ENTITIES.has(j.cfc.toLowerCase()));
    if (deniedJoin || references.some((reference) => this.denied(reference))) throw new LegacyApiError('authorization');
  }

  /** A column the table has; every column passes when the columns are unknown. */
  private hasColumn(column: string): boolean {
    return this.columns === undefined || this.columns.has(column.toLowerCase());
  }

  /** The WHERE clause SQL Server would compile, as an expression; undefined when there are no params. */
  private where(): Expr | undefined {
    const tokens: (string | FeedParamCondition)[] = [];
    let started = false;
    let openGrouping = false;
    const open = (connector: string): void => {
      if (!openGrouping) tokens.push(connector);
      tokens.push('(');
      openGrouping = true;
    };
    for (const param of this.params) {
      let leaf: FeedParamCondition | undefined;
      if (param.field !== '') {
        const invalidType = param.type !== 'varchar' && !param.isNull && param.criteria === '';
        const nullList = param.isNull && (param.condition === 'in' || param.condition === 'not in');
        if (param.condition === '' || !this.hasColumn(param.field) || invalidType || nullList) throw serverError();
        leaf = conditionOf(param, param.condition);
      }
      if (!started) {
        openGrouping = true;
        tokens.push('(');
      }
      const rel = param.relationship;
      if (rel === 'opengrouping' || rel === 'andopengrouping') open('and');
      else if (rel === 'oropengrouping') open('or');
      else if (rel === 'closegrouping') {
        tokens.push(')');
        openGrouping = false;
      } else if (!openGrouping) tokens.push(rel);
      started = true;
      if (leaf !== undefined) {
        tokens.push(leaf);
        openGrouping = false;
      }
    }
    if (!started) return undefined;
    tokens.push(')');
    return new ConditionParser(tokens).parse();
  }

  /** The WHERE clause, after every check getQuery's SQL would fail before reading a row. */
  private checkedWhere(): Expr | undefined {
    this.checkDeniedTables();
    const where = this.where();
    // leftJoin builds its ON clause from the sample bean's column value, so its SQL never compiles (beanFeed.cfc:670-686).
    if (this.joins.some((join) => join.kind === 'left')) throw serverError();
    const inner = this.joins[0];
    if (inner !== undefined) throw new UnsupportedFeedQueryError(`innerJoin on ${inner.cfc}`);
    return where;
  }

  /** Raises the error that filtering the rows by `where` raises. */
  private async checkFilter(where: Expr | undefined): Promise<void> {
    const rows = await this.source.filterThrows(where);
    if (rows === undefined) await scanFilter(this.source, where);
    else raiseFilter(where, rows);
  }

  /** The count of the rows `query` selects; what the source cannot evaluate exactly, a scan of its rows evaluates. */
  private async counted(query: FeedQuery): Promise<number> {
    const counted = await this.source.count(query);
    if (counted.kind === 'count') return counted.count;
    if (counted.kind === 'throws') {
      raiseFilter(query.where, counted.rows);
      throw complexValueError();
    }
    const scanned = await scanCount(this.source, query);
    this.scanned = { query, unstable: scanned.unstable };
    return scanned.count;
  }

  /** getAvailableCount: `count(*)` over the filtered rows, before TOP. */
  async count(): Promise<number> {
    const where = this.checkedWhere();
    if (this.groupBy.length > 0) {
      await this.checkFilter(where);
      throw new UnsupportedFeedQueryError('countOnly with groupBy');
    }
    return this.counted({ where, order: [] });
  }

  /** A validated ORDER BY column; qualified names must name the entity's table. */
  private orderColumn(field: string, ownTable: boolean): string {
    const segments = field.split('.');
    if (segments.some((segment) => segment === '')) throw serverError();
    let column: string | undefined;
    if (ownTable && segments.length === 2) column = segments[1];
    else if (!ownTable && segments.length === 1) column = segments[0];
    else if (
      !ownTable &&
      segments.length === 2 &&
      this.options.table !== undefined &&
      cfEq(segments[0] ?? '', this.options.table)
    )
      column = segments[1];
    if (column === undefined || !this.hasColumn(column)) throw serverError();
    return column;
  }

  /** An ORDER BY term over `column`, typed as its params are. */
  private term(column: string, desc: boolean): FeedOrderTerm {
    return { column: column.toLowerCase(), field: column, desc, type: this.typeOf(column) };
  }

  /** The ORDER BY terms (utility.validateSort / validateSortBy / validateSortDirection, beanFeed.caseInsensitiveOrderBy). */
  private orderTerms(): FeedOrderTerm[] {
    if (this.orderBy.length > 0) {
      return this.orderBy.map(({ text, ownTable }) => {
        const parts = text.trim().replace(/\s+/g, ' ').split(' ');
        const direction = parts.length >= 2 ? (parts.pop() ?? '').toLowerCase() : 'asc';
        const field = parts.join(' ').trim();
        if (!SORT_FIELD.test(field) || (direction !== 'asc' && direction !== 'desc')) throw serverError();
        return this.term(this.orderColumn(field, ownTable), direction === 'desc');
      });
    }
    if (this.sortBy === '') return [];
    const fields = cfListToArray(this.sortBy).map((field) => field.trim());
    if (fields.some((field) => !SORT_FIELD.test(field))) throw serverError();
    const desc = this.sortDirection.toLowerCase() === 'desc';
    return fields.map((field, i) =>
      this.term(this.orderColumn(i === 0 ? `own.${field}` : field, i === 0), i === fields.length - 1 && desc),
    );
  }

  /** The selected rows' query and count: filtered, grouped as SQL Server allows, ordered and limited by TOP. */
  async select(urlFields: string): Promise<{ query: FeedQuery; recordCount: number }> {
    const where = this.checkedWhere();
    let order: FeedOrderTerm[];
    try {
      order = this.orderTerms();
      const grouped = this.groupBy.length > 0;
      // beanFeed.isAggregateQuery (beanFeed.cfc:758-769): a `fields` URL param keeps the plain column SELECT.
      if (urlFields === '' && (grouped || this.aggregates.length > 0)) {
        const groupColumns = new Set(this.groupBy.map((column) => column.toLowerCase()));
        if (order.some((term) => !groupColumns.has(term.column.toLowerCase()))) throw serverError();
        throw new UnsupportedFeedQueryError('aggregate SELECT');
      }
      // Every selected column must be grouped, and the pk is always selected ungrouped.
      if (grouped) throw serverError();
      if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 0) throw serverError();
    } catch (error) {
      // The rows are filtered before these checks run, so the filter's conversion error comes first.
      await this.checkFilter(where);
      throw error;
    }
    const query: FeedQuery = { where, order };
    const count = await this.counted(query);
    return { query, recordCount: this.maxItems > 0 ? Math.min(count, this.maxItems) : count };
  }

  /** `limit` rows of `query` after the first `offset`. */
  rows(query: FeedQuery, offset: number, limit: number): Promise<R[]> {
    const scanned = this.scanned;
    if (scanned?.query === query) return scanRows(this.source, query, offset, limit, scanned.unstable);
    return this.source.rows(query, offset, limit);
  }
}

/** `a` against `b` by `order`: the first term that differs, NULL lowest; 0 when every term ties. */
function compareRows(a: Readonly<Struct>, b: Readonly<Struct>, order: readonly FeedOrderTerm[]): number {
  for (const term of order) {
    const x = getNoCase(a, term.field);
    const y = getNoCase(b, term.field);
    const xNull = x === null || x === undefined;
    const yNull = y === null || y === undefined;
    const diff = xNull || yNull ? Number(!xNull) - Number(!yNull) : compareNonNull(x, y, term.type);
    if (diff !== 0) return term.desc ? -diff : diff;
  }
  return 0;
}

/** `rows` sorted by `order`, ties kept in row order. */
function sortRows<R extends Readonly<Struct>>(rows: R[], order: readonly FeedOrderTerm[]): R[] {
  if (order.length === 0) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const diff = compareRows(a.row, b.row, order);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(({ row }) => row);
}

/** A value cfText refuses. */
function isComplexValue(value: unknown): boolean {
  return value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value);
}

/** A non-null value of a numeric or timestamp term that compareNonNull orders inconsistently (NaN, infinite). */
function isUnorderable(value: unknown, type: ParamType): boolean {
  if (value === null || value === undefined) return false;
  return !Number.isFinite(type === 'numeric' ? Number(value) : (timeOf(value) ?? 0));
}

/** A complex value's order key: cfText refuses it, so comparing it with any non-null key raises. */
const COMPLEX_KEY: unique symbol = Symbol('complex value');
/** A row's order key of one term: the operand compareNonNull compares, NULL as null. */
type SortKey = string | number | null | typeof COMPLEX_KEY;
/** A selected row in a scan's sort: its keys of the order terms, its 1-based scan position and, when checked, its digest. */
interface SortEntry {
  readonly keys: readonly SortKey[];
  readonly position: number;
  readonly digest?: string | undefined;
}
// The estimated bytes of order keys a scan's sort holds before it spills them to temporary files.
const SORT_BUDGET = 4 * 1024 * 1024;
// How many times a page over a rereading source is ranked before a source still changing under it fails the page.
const RANK_ATTEMPTS = 3;

/** A digest of `row`'s columns and values, which differs when any of them does. */
function rowDigest(row: Readonly<Struct>): string {
  return hash('sha256', serialize(row), 'base64');
}

/** `value`'s order key under a term of `type`. */
function sortKeyOf(value: unknown, type: ParamType): SortKey {
  if (value === null || value === undefined) return null;
  if (type === 'numeric') return Number(value);
  if (type === 'timestamp') return timeOf(value) ?? 0;
  return isComplexValue(value) ? COMPLEX_KEY : cfText(value).trimEnd();
}

/** compareRows over order keys. */
function compareKeys(a: readonly SortKey[], b: readonly SortKey[], order: readonly FeedOrderTerm[]): number {
  for (const [index, term] of order.entries()) {
    const x = a[index] ?? null;
    const y = b[index] ?? null;
    let diff: number;
    if (x === null || y === null) diff = Number(x !== null) - Number(y !== null);
    else if (typeof x === 'number' && typeof y === 'number') diff = x - y;
    else if (typeof x === 'string' && typeof y === 'string') diff = COLLATOR.compare(x, y);
    else throw complexValueError();
    if (diff !== 0) return term.desc ? -diff : diff;
  }
  return 0;
}

/** The sort entry of a selected `row` at scan `position`, with the row's digest when `digest` is set. */
function sortEntryOf(row: Readonly<Struct>, order: readonly FeedOrderTerm[], position: number, digest = false): SortEntry {
  const keys = order.map((term) => sortKeyOf(getNoCase(row, term.field), term.type));
  return digest ? { keys, position, digest: rowDigest(row) } : { keys, position };
}

/** An entry holding a numeric or timestamp key the comparator orders inconsistently (NaN, infinite). */
function isUnorderableEntry(entry: SortEntry): boolean {
  return entry.keys.some((key) => typeof key === 'number' && !Number.isFinite(key));
}

/** A key as a spilled line holds it: JSON has no symbol or non-finite number. */
function encodedKey(key: SortKey): string | number | null {
  if (key === COMPLEX_KEY) return 0;
  return typeof key === 'number' && !Number.isFinite(key) ? String(key) : key;
}

/** A spilled key of a term of `type`. */
function decodedKey(key: string | number | null, type: ParamType | undefined): SortKey {
  if (key === null) return null;
  if (type === 'varchar') return typeof key === 'number' ? COMPLEX_KEY : key;
  return typeof key === 'string' ? Number(key) : key;
}

/** The sort sortRows applies to the selected rows of `order`, over their entries in scan order. */
function entrySort(order: readonly FeedOrderTerm[]): SpillSort<SortEntry> {
  return new SpillSort<SortEntry>({
    compare: (a, b) => {
      const diff = compareKeys(a.keys, b.keys, order);
      return diff !== 0 ? diff : a.position - b.position;
    },
    encode: (entry) => JSON.stringify([entry.position, entry.digest ?? null, ...entry.keys.map(encodedKey)]),
    decode: (line) => {
      const [position, digest, ...keys] = JSON.parse(line) as [number, string | null, ...(string | number | null)[]];
      const decoded = keys.map((key, index) => decodedKey(key, order[index]?.type));
      return digest === null ? { position, keys: decoded } : { position, keys: decoded, digest };
    },
    size: (entry) =>
      entry.keys.reduce<number>(
        (total, key) => total + (typeof key === 'string' ? 24 + 2 * key.length : 8),
        48 + (entry.digest === undefined ? 0 : 24 + 2 * entry.digest.length),
      ),
    budget: SORT_BUDGET,
  });
}

/** Whether `where` selects `row`; raises what filtering it raises. */
function selects(where: Expr | undefined, row: Readonly<Struct>): boolean {
  return where === undefined || exprTruth(where, row) === true;
}

/** Raises what filtering a source's rows by `where` raises, reading them a batch at a time. */
async function scanFilter<R extends Readonly<Struct>>(source: BeanFeedSource<R>, where: Expr | undefined): Promise<void> {
  if (where === undefined) return;
  await source.scan({ columns: queryColumns({ where, order: [] }), rows: false }, (rows) => {
    raiseFilter(where, rows);
    return true;
  });
}

/** The count of `query` over a scan of the source, raising what filtering and then sorting its rows in memory raise. */
async function scanCount<R extends Readonly<Struct>>(source: BeanFeedSource<R>, query: FeedQuery): Promise<{ count: number; unstable: boolean }> {
  const { where, order } = query;
  // Only a varchar term's comparison can raise, so only then does the count hold the keys a sort needs.
  const sort = order.some((term) => term.type === 'varchar') ? entrySort(order) : undefined;
  let count = 0;
  let position = 0;
  let unstable = false;
  let complex = false;
  try {
    await source.scan({ columns: queryColumns(query), rows: false }, async (rows) => {
      for (const row of rows) {
        position += 1;
        if (!selects(where, row)) continue;
        count += 1;
        if (order.length === 0) continue;
        const entry = sortEntryOf(row, order, position);
        unstable ||= isUnorderableEntry(entry);
        complex ||= entry.keys.includes(COMPLEX_KEY);
        sort?.push(entry);
      }
      await sort?.settle();
      return true;
    });
    if (complex) await sort?.window(0, 0, !unstable);
    return { count, unstable };
  } finally {
    await sort?.dispose();
  }
}

/** `limit` rows of `query` after the first `offset` over a scan of the source, as the in-memory evaluator selects them. */
async function scanRows<R extends Readonly<Struct>>(
  source: BeanFeedSource<R>,
  query: FeedQuery,
  offset: number,
  limit: number,
  unstable: boolean,
): Promise<R[]> {
  const { where, order } = query;
  const columns = queryColumns(query);
  // Without terms, or with terms the source orders as the evaluator does, the scan reads the rows in the page's order.
  if (order.length === 0 || (!unstable && source.orders(order))) {
    const found: R[] = [];
    let skipped = 0;
    await source.scan({ columns, rows: true, order }, (rows) => {
      for (const row of rows) {
        if (!selects(where, row)) continue;
        if (skipped < offset) skipped += 1;
        else if (found.push(row) >= limit) return false;
      }
      return true;
    });
    return found;
  }
  // A source rereading elsewhere may change between its reads, so a page it no longer answers is ranked afresh.
  const attempts = source.rereads === true ? RANK_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const page = await rankedPage(source, query, offset, limit);
    if (page !== undefined) return page;
  }
  throw serverError();
}

/** `limit` ranked rows of `query` after the first `offset` over one scan; undefined when the revisit answers other rows. */
async function rankedPage<R extends Readonly<Struct>>(
  source: BeanFeedSource<R>,
  query: FeedQuery,
  offset: number,
  limit: number,
): Promise<R[] | undefined> {
  const { where, order } = query;
  const digest = source.rereads === true;
  const sort = entrySort(order);
  try {
    let position = 0;
    let consistent = true;
    let window: SortEntry[] = [];
    let positions: number[] = [];
    const rows = await source.scan(
      { columns: queryColumns(query), rows: true },
      async (batch) => {
        for (const row of batch) {
          position += 1;
          if (!selects(where, row)) continue;
          const entry = sortEntryOf(row, order, position, digest);
          consistent &&= !isUnorderableEntry(entry);
          sort.push(entry);
        }
        await sort.settle();
        return true;
      },
      async () => {
        window = await sort.window(offset, offset + limit, consistent);
        positions = window.map((entry) => entry.position).sort((a, b) => a - b);
        return positions;
      },
    );
    // Rows pair with positions by index, so any other count leaves the pairing unknown.
    if (rows.length !== positions.length) return undefined;
    const byPosition = new Map(positions.map((at, index) => [at, rows[index]]));
    const page: R[] = [];
    for (const entry of window) {
      const row = byPosition.get(entry.position);
      if (row === undefined || (digest && rowDigest(row) !== entry.digest)) return undefined;
      page.push(row);
    }
    return page;
  } finally {
    await sort.dispose();
  }
}

/** A feed source over rows in memory, which answers every query itself. */
interface MemorySource<R> extends BeanFeedSource<R> {
  count(query: FeedQuery): Promise<Extract<FeedCount<R>, { kind: 'count' }>>;
}

/** A feed source over rows read whole: the in-memory evaluator of legacy's SQL Server semantics. */
export function rowsSource<R extends Readonly<Struct>>(rows: readonly R[]): MemorySource<R> {
  const selected = new WeakMap<FeedQuery, R[]>();
  const filter = (where: Expr | undefined): R[] =>
    where === undefined ? [...rows] : rows.filter((row) => exprTruth(where, row) === true);
  const select = (query: FeedQuery): R[] => {
    let held = selected.get(query);
    if (held === undefined) {
      held = sortRows(filter(query.where), query.order);
      selected.set(query, held);
    }
    return held;
  };
  return {
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
    isEmpty: () => Promise.resolve(rows.length === 0),
    filterThrows: () => Promise.resolve(rows),
    count: (query) => {
      const held = select(query);
      const holds = (test: (term: FeedOrderTerm, value: unknown) => boolean): boolean =>
        query.order.some((term) => held.some((row) => test(term, getNoCase(row, term.field))));
      return Promise.resolve({
        kind: 'count',
        count: held.length,
        pairable: holds((term, value) => term.type === 'varchar' && isComplexValue(value)),
        unstable: holds((term, value) => term.type !== 'varchar' && isUnorderable(value, term.type)),
      });
    },
    rows: (query, offset, limit) => Promise.resolve(select(query).slice(offset, offset + limit)),
    orders: () => false,
    // The rows are held already, so one batch hands them all.
    scan: async (_request, visit, revisit) => {
      if (visit !== undefined && rows.length > 0) await visit(rows);
      if (revisit === undefined) return [];
      return (await revisit()).flatMap((position): R[] => {
        const row = rows[position - 1];
        return row === undefined ? [] : [row];
      });
    },
  };
}

/** A feed over `sources` (e.g. one transaction per pool tenant) whose rows are theirs concatenated in source order. */
export function mergedSource<R extends Readonly<Struct>>(sources: readonly BeanFeedSource<R>[]): BeanFeedSource<R> {
  return {
    columns: [...new Set(sources.flatMap((source) => source.columns))],
    async isEmpty() {
      for (const source of sources) if (!(await source.isEmpty())) return false;
      return true;
    },
    async filterThrows(where) {
      // Each source's rows hold its first raising row, so in source order the first raising row is the merged feed's.
      const lists: (readonly R[])[] = [];
      for (const source of sources) {
        const list = await source.filterThrows(where);
        if (list === undefined) return undefined;
        lists.push(list);
      }
      return lists.flat();
    },
    async count(query) {
      const counted: Extract<FeedCount<R>, { kind: 'count' }>[] = [];
      let ordering = false;
      for (const source of sources) {
        const each = await source.count(query);
        // Every row is filtered before any is sorted, so the first source whose filtering raises decides the error.
        if (each.kind === 'rows' || (each.kind === 'throws' && each.rows.length > 0)) return each;
        if (each.kind === 'throws') ordering = true;
        else counted.push(each);
      }
      if (ordering) return { kind: 'throws', rows: [] };
      // Rows of different sources a comparator cannot order, or that may tie on a complex value, need one in-memory sort.
      const pairable = counted.filter((each) => each.pairable).length;
      if (pairable > 1 || counted.some((each) => each.unstable)) return { kind: 'rows' };
      const count = counted.reduce((total, each) => total + each.count, 0);
      return { kind: 'count', count, pairable: pairable > 0, unstable: false };
    },
    async rows(query, offset, limit) {
      const lists: R[][] = [];
      for (const source of sources) lists.push(await source.rows(query, 0, offset + limit));
      return lists
        .flatMap((rows, at) => rows.map((row, index) => ({ row, at, index })))
        .sort((a, b) => {
          const diff = compareRows(a.row, b.row, query.order);
          if (diff !== 0) return diff;
          return a.at !== b.at ? a.at - b.at : a.index - b.index;
        })
        .slice(offset, offset + limit)
        .map(({ row }) => row);
    },
    orders: () => false,
    async scan(request, visit, revisit) {
      if ((request.order?.length ?? 0) > 0) throw new Error('A merged feed scans in source order only; orders() refuses terms');
      // Scan positions run on through the sources in order.
      const sizes: number[] = [];
      let reading = visit !== undefined;
      for (const source of sources) {
        let size = 0;
        if (visit !== undefined && reading) {
          await source.scan(request, async (rows) => {
            size += rows.length;
            reading = await visit(rows);
            return reading;
          });
        }
        sizes.push(size);
      }
      if (revisit === undefined) return [];
      // Each source's statements run in a transaction of their own, so each re-reads its positions in a snapshot of its own (`rereads`).
      const positions = await revisit();
      const found: R[] = [];
      let start = 0;
      for (const [index, source] of sources.entries()) {
        const end = start + (sizes[index] ?? 0);
        const local = positions.filter((position) => position > start && position <= end).map((position) => position - start);
        if (local.length > 0) for (const row of await source.scan(request, undefined, () => Promise.resolve(local))) found.push(row);
        start = end;
      }
      return found;
    },
    rereads: true,
  };
}

/** The first row of the source's scope, in its own order, that `test` holds for; read a batch at a time, stopping there. */
export async function firstScannedRow<R>(source: BeanFeedSource<R>, test: (row: R) => boolean): Promise<R | undefined> {
  let found: R | undefined;
  await source.scan({ columns: [], rows: true }, (rows) => {
    found = rows.find(test);
    return found === undefined;
  });
  return found;
}

/** findQuery's query-string loop (jsonApiUtility.cfc:2812-2903): filters, keywords and the base URL. */
function applyQueryString<R extends Readonly<Struct>>(
  feed: BeanFeed<R>,
  call: JsonApiCall,
  primaryKey: string,
): string {
  const ctx = call.apiContext;
  const queryParams = cfListToArray(call.query.raw, '&')
    .map((item) => urlDecode(cfListFirst(item, '=')))
    .filter((key) => !cfEq(key, 'pageIndex'));
  let baseUrl = `${ctx.endpoint}/${call.entityName}/?`;
  let started = false;
  let relationship = 'and';
  let advancedSort = '';
  for (const p of queryParams) {
    const propName = p.includes('[') ? cfListFirst(p, '[') : p;
    const value = urlParam(ctx, p);
    if (value !== undefined) {
      const text = cfText(value);
      baseUrl += `${started ? '&' : ''}${esapiUrlEncode(p)}${text === '' ? '' : `=${esapiUrlEncode(text)}`}`;
      started = true;
      const key = propName.toLowerCase();
      if (key === 'sort') advancedSort = cfListAppend(advancedSort, text);
      else if (key === 'or') relationship = 'or';
      else if (GROUPING_KEYS.has(key)) {
        feed.addParam('', '', 'EQUALS', p);
        relationship = 'and';
      } else if (AGGREGATE_KEYS.has(key)) feed.aggregate(key, text);
      else if (key === 'innerjoin') feed.join('inner', text);
      else if (key === 'leftjoin') feed.join('left', text);
      // A name the bean holds no value for is ignored, as legacy ignores `?foo=bar`; only a value that is not a
      // property (`addObjects`) or an `id` without a primary key property is invalidParameters.
      else if (!QUERY_EXCLUDED.has(key) && (cfEq(propName, 'id') || feed.valueExists(propName))) {
        const parts = cfListToArray(text, '^');
        let condition = 'eq';
        let criteria = text;
        if (parts.length > 1) {
          condition = parts[0] ?? condition;
          criteria = parts[1] ?? '';
        } else if (criteria.includes('*')) {
          condition = 'like';
          criteria = criteria.replaceAll('*', '%');
        }
        const column = cfEq(propName, 'id') ? primaryKey : propName;
        if (!feed.hasProperty(column)) throw new LegacyApiError('invalidParameters');
        feed.addParam(column, criteria, condition, relationship);
        relationship = 'and';
      }
    }
    // Legacy writes the joined sort back into the URL scope, so a repeated `sort` key reads the joined value.
    if (advancedSort !== '') setNoCase(ctx.url, 'sort', advancedSort);
  }
  return baseUrl;
}

/** findQuery's expanded branch (jsonApiUtility.cfc:2796-2811): every non-excluded param filters by equality. */
function applyExpandedParams<R extends Readonly<Struct>>(
  feed: BeanFeed<R>,
  call: JsonApiCall,
  params: Readonly<Record<string, unknown>>,
): string {
  let baseUrl = `${call.apiContext.endpoint}/${call.entityName}/?`;
  let started = false;
  // `for (p in params)` walks the struct in ACF's key order, not insertion order.
  for (const key of acfKeyOrder(Object.keys(params).map((name): StructOp => ['set', name]))) {
    if (EXPANDED_EXCLUDED.has(key.toLowerCase())) continue;
    const value = params[key];
    feed.addParam(key, cfText(value));
    baseUrl += `${started ? '&' : ''}${key}=${cfText(value)}`;
    started = true;
  }
  return baseUrl;
}

/**
 * setFeedProps (jsonApiUtility.cfc:2955-3158) for a non-content feed. `contentpoolid` and `cachedWithin` are not
 * applied: the caller's rows already hold the pool's sites, and caching does not change them.
 */
function applyFeedProps<R extends Readonly<Struct>>(
  feed: BeanFeed<R>,
  call: JsonApiCall,
  params: Struct,
  primaryKey: string,
): void {
  const text = (name: string): string => cfText(getNoCase(params, name));
  const sort = text('sort') !== '' ? text('sort') : text('orderby');
  if (sort !== '') feed.setSort(sort);
  if (text('sortdirection') !== '') feed.setSortDirection(text('sortdirection'));
  // bean.setValue trims a simple value before storing it.
  if (text('sortby') !== '') feed.sortBy = javaTrim(text('sortby'));
  const fields = text('fields');
  if (fields !== '' && !requestIsAggregate(call.apiContext) && !listFindNoCase(fields, primaryKey)) {
    setNoCase(params, 'fields', cfListAppend(fields, primaryKey));
  }
  const maxItems = getNoCase(params, 'maxitems');
  if (maxItems !== undefined) {
    if (cfIsNumeric(maxItems)) feed.maxItems = cfToNumber(maxItems);
    else if (cfText(maxItems) === '*') feed.maxItems = 0;
  }
  for (const name of ['size', 'limit']) {
    const value = getNoCase(params, name);
    if (cfIsNumeric(value)) feed.maxItems = cfToNumber(value);
  }
}

/** jsonApiUtility.isAggregateQuery (4981-4997) over the current URL scope: a `fields` URL param makes it false. */
function requestIsAggregate(ctx: JsonApiRequestContext): boolean {
  return cfText(urlParam(ctx, 'fields')) === '' && ctx.isAggregateQuery;
}

/** The beanIterator page over `recordCount` rows (jsonApiUtility.cfc:3160-3183) and the rows it reads. */
function iteratorPageOf(
  recordCount: number,
  ctx: JsonApiRequestContext,
  feedNextN: number,
  entityName: string,
): {
  rows: IteratorRows;
  page: CollectionPage;
} {
  const nextN = (n: unknown): number => (cfIsNumeric(n) && cfToNumber(n) !== 0 ? cfToNumber(n) : recordCount);
  let perPage = nextN(feedNextN);
  let pageIndex = 1;
  let recordIndex = 0;
  const setPageIndex = (n: number): void => {
    pageIndex = n;
    recordIndex = (n - 1) * perPage;
    if (recordIndex > recordCount) {
      recordIndex = 0;
      pageIndex = 1;
    }
  };
  const itemsPerPage = urlParam(ctx, 'itemsPerPage');
  if (cfIsNumeric(itemsPerPage)) perPage = nextN(itemsPerPage);
  else if (itemsPerPage !== undefined && cfText(itemsPerPage) === '*') perPage = nextN(0);
  const pageParam = urlParam(ctx, 'pageIndex');
  if (cfIsNumeric(pageParam)) setPageIndex(cfToNumber(pageParam));
  const startParam = urlParam(ctx, 'startIndex');
  if (cfIsNumeric(startParam)) {
    const startRow = cfToNumber(startParam);
    if (recordCount > 0) {
      setPageIndex(perPage !== 1 ? Math.ceil(startRow / perPage) : startRow);
      const queued = startRow === 0 ? 0 : startRow - 1;
      if (recordIndex !== queued && queued < recordCount) recordIndex = queued;
    } else {
      recordIndex = 0;
      setPageIndex(1);
    }
  }
  // setIteratorProps calls feed.setMaxItems on an undefined `feed` (3180), so a numeric offset fails the request.
  if (cfIsNumeric(urlParam(ctx, 'offset'))) throw serverError();
  const end = Math.min(recordCount, pageIndex * perPage);
  return {
    rows: iteratorRows(recordCount, recordIndex, end, entityName),
    page: iteratorPage({ recordCount, maxRecordsPerPage: perPage, pageIndex, entityName }),
  };
}

const BLANK_FEED_ROWS = new WeakSet<object>();

/** Whether `row` is a page's {@link BlankFeedRow}. */
export function isBlankFeedRow(row: object): row is BlankFeedRow {
  return BLANK_FEED_ROWS.has(row);
}

/** `count` rows holding '' in each of `columns`. */
function blankFeedRows(columns: readonly string[], count: number): BlankFeedRow[] {
  if (count === 0) return [];
  const row: BlankFeedRow = Object.freeze(Object.fromEntries(columns.map((column): [string, ''] => [column, ''])));
  BLANK_FEED_ROWS.add(row);
  return Array.from({ length: count }, () => row);
}

/** A source rather than rows. */
function isSource<R>(rows: readonly R[] | BeanFeedSource<R>): rows is BeanFeedSource<R> {
  return !Array.isArray(rows);
}

/**
 * findAll, findMany and findQuery (jsonApiUtility.cfc:2542-2918) for a non-content entity over the rows its feed
 * selects before request params apply: site or pool scope, findMany's ids and the entity feed's own defaults.
 * findQuery's filters run for `call.method` findQuery or when `options.expandedParams` or an expanded related finder
 * gives params; findMany never answers `countOnly`; paging always reads the URL scope.
 */
export async function beanFeedQuery<R extends Readonly<Record<string, unknown>>>(
  rows: readonly R[] | BeanFeedSource<R>,
  call: JsonApiCall,
  options: BeanFeedOptions,
): Promise<BeanFeedResult<R>> {
  const ctx = call.apiContext;
  paramUrl(ctx, 'entityname', call.entityName);
  const source = isSource(rows) ? rows : rowsSource(rows);
  const columns = options.columns ?? ((await source.isEmpty()) ? undefined : source.columns);
  const feed = new BeanFeed(source, columns, options);
  const { finder } = call;
  const expanded = options.expandedParams ?? (finder !== undefined && finder.expanded > 0 ? finder.params : undefined);
  let baseUrl: string | undefined;
  if (expanded !== undefined) baseUrl = applyExpandedParams(feed, call, expanded);
  else if (cfEq(call.method, 'findQuery')) baseUrl = applyQueryString(feed, call, options.primaryKey);
  const params: Struct = expanded === undefined ? finderParamsOf(call) : { ...expanded };
  applyFeedProps(feed, call, params, options.primaryKey);
  const countOnly = getNoCase(params, 'countOnly');
  if (!cfEq(call.method, 'findMany') && cfIsBoolean(countOnly) && cfToBoolean(countOnly)) return { count: await feed.count() };
  const { query, recordCount } = await feed.select(cfText(urlParam(ctx, 'fields')));
  const { rows: read, page } = iteratorPageOf(recordCount, ctx, feed.nextN, call.entityName);
  const items = [
    ...blankFeedRows(source.columns, read.blank),
    ...(read.count > 0 ? readRecords(read, await feed.rows(query, read.from, read.count)) : []),
    ...blankFeedRows(source.columns, read.blankAfter),
  ];
  return baseUrl === undefined ? { items, page } : { items, page, baseUrl };
}
