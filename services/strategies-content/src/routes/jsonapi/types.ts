/**
 * Contract between ../jsonapi.ts and the JSON API entity and method handlers of this folder, with the pure helpers they
 * share: access verdicts, result shaping, findProperties and the generic beanFeed query semantics
 * (core/mura/client/api/json/v1/jsonApiUtility.cfc, core/mura/bean/bean.cfc, core/mura/bean/beanFeed.cfc).
 */
import { Roles } from '@opt2/platform/auth';
import {
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
} from '@opt2/platform/legacy-compat';
import type { Actor, SiteContentSettings } from '../../domain/context.js';
import type { UploadedFile } from '../../domain/files.js';
import { getModulePerm } from '../../domain/permissions.js';
import type {
  ContentEntityConfig,
  ContentEntityName,
  EntityPropertyHint,
  RelationProp,
} from '../../legacy/jsonapi-entities.js';
import {
  iteratorPage,
  paramUrl,
  urlParam,
  type CollectionPage,
  type JsonApiRequestContext,
} from '../../legacy/jsonapi-serializers.js';
// Type-only: ../index.ts imports ../jsonapi.ts, which imports this folder.
import type { ContentRouteContext } from '../index.js';

type Struct = Record<string, unknown>;

/** API family mode; `rest` runs without session management (applicationSettings.cfm:179). */
export type JsonApiMode = 'json' | 'ajax' | 'rest';

/** Ordered, case-insensitive view of the merged legacy params (query, then form, then JSON body; jsonApiUtility.cfc:405-412). */
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

/** The URL of the request: `raw` is `cgi.QUERY_STRING` without `?`; `params` is the URL scope only. */
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
}

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
}

/** Handles a public method such as `findCrumbArray`. */
export type MethodHandler = JsonApiHandlerFn;

/** CFML conversion of a simple value to a string; '' for null or undefined. */
function cfText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  throw new TypeError('Complex object types cannot be converted to simple values.');
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

/** applyPropertyFormat's datatype for a property hint (jsonApiUtility.cfc:1517-1546); `numeric` bean props hint as float. */
const HINT_DATATYPES: Readonly<Record<EntityPropertyHint, string>> = Object.freeze({
  integer: 'int',
  float: 'int',
  date: 'datetime',
});

// bean.cfc:80 declares isNew persistent=false, so findProperties never lists it.
const NON_PERSISTENT_BASE_PROPERTIES: ReadonlySet<string> = new Set(['isnew']);

/** CFML listFindNoCase. */
function listFindNoCase(list: string, value: string): boolean {
  const lower = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === lower);
}

/** The findProperties entries `config` can describe, keyed by lower-cased name, in primary key, hint, relation order. */
function describedProperties(config: ContentEntityConfig): Map<string, Struct> {
  const props = new Map<string, Struct>();
  if (config.primaryKey !== '')
    props.set(config.primaryKey.toLowerCase(), { fieldtype: 'id', name: config.primaryKey.toLowerCase() });
  for (const [name, hint] of Object.entries(config.hints)) {
    const lower = name.toLowerCase();
    if (NON_PERSISTENT_BASE_PROPERTIES.has(lower)) continue;
    props.set(lower, { fieldtype: props.get(lower)?.['fieldtype'] ?? '', name: lower, datatype: HINT_DATATYPES[hint] });
  }
  const relations: [RelationProp, string][] = [
    ...config.hasMany.map((p): [RelationProp, string] => [p, 'one-to-many']),
    ...config.hasOne.map((p): [RelationProp, string] => [p, 'many-to-one']),
  ];
  for (const [prop, fieldtype] of relations) {
    const entry: Struct = { fieldtype, loadkey: prop.loadkey, fkcolumn: prop.column, name: prop.name.toLowerCase() };
    // A one-to-many property has no column of its own, so getProperties types it as an untyped (varchar) string.
    if (fieldtype === 'one-to-many') entry['datatype'] = 'varchar';
    entry['relatesto'] = prop.cfc;
    props.set(prop.name.toLowerCase(), entry);
  }
  return props;
}

/**
 * findProperties (jsonApiUtility.cfc:1548-1618) from the registration alone. Entity-level metadata the registration
 * does not hold (orderby, bundleable, historical, dynamic, scaffold, table) takes bean.cfc's defaults, and only the
 * properties the registration describes (primary key, hinted properties, relations) are listed.
 */
export function findPropertiesFor(config: ContentEntityConfig, call: JsonApiCall): Record<string, unknown> {
  const fields = (config.fields ?? []).join(',');
  const described = describedProperties(config);
  const requested = cfListToArray(call.params.string('properties')).map((p) => p.toLowerCase());
  const names = requested.length > 0 ? requested : [...described.keys()];
  const properties = names
    .filter((name) => fields === '' || listFindNoCase(fields, name))
    .flatMap((name) => described.get(name) ?? []);

  const endpoint = call.apiContext.endpoint;
  const actor = call.actor;
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
  if (actor.s2 || actor.roles.includes(Roles.s2) || actor.roles.includes(Roles.siteAdmin)) result['table'] = '';
  Object.assign(result, {
    primarykey: config.primaryKey.toLowerCase(),
    public: config.public,
    bundleable: false,
    orderby: '',
    entityname: config.displayName,
    scaffold: false,
  });
  return result;
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

/** countOnly's count, or one page of the selected rows with the base URL findQuery's paging links use. */
export type BeanFeedResult<R> = { count: number } | { items: R[]; page: CollectionPage; baseUrl?: string };

/**
 * A feed request legacy answers with rows the in-memory feed cannot compute: an aggregate SELECT (sum, avg, count, min,
 * max, groupBy) SQL Server accepts, or an inner join on one of the entity's relations. The service-kit error handler
 * answers it with the legacy 500 and logs it as unhandled.
 */
export class UnsupportedFeedQueryError extends Error {
  override readonly name: string = 'UnsupportedFeedQueryError';
}

type ParamType = 'varchar' | 'numeric' | 'timestamp';
type Condition = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like' | '';

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
  pattern?: RegExp;
}

/** One ORDER BY item before validateSort: the term text and whether its table is the entity's own. */
interface OrderItem {
  text: string;
  ownTable: boolean;
}

interface OrderTerm {
  column: string;
  desc: boolean;
}

type Truth = boolean | null;
type Expr = { kind: 'param'; param: FeedParam } | { kind: 'and' | 'or'; left: Expr; right: Expr };

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

/**
 * A SQL Server LIKE pattern (`%`, `_` and `[...]` classes) as a case-insensitive regular expression. A `[^...]` class
 * never reaches it: findQuery splits a criteria on `^` before it becomes a pattern.
 */
function likeRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    const close = ch === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else if (close > 0) {
      source += `[${pattern.slice(i + 1, close).replace(/[\\\]]/g, '\\$&')}]`;
      i = close;
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
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

  constructor(private readonly tokens: readonly (string | FeedParam)[]) {}

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
    return { kind: 'param', param: token };
  }
}

/** SQL three-valued truth of `param` for `row`. */
function paramTruth(param: FeedParam, row: Readonly<Struct>): Truth {
  const value = getNoCase(row, param.field);
  if (param.isNull) {
    if (param.condition === '=') return value === null || value === undefined;
    if (param.condition === '!=') return value !== null && value !== undefined;
    return null;
  }
  if (value === null || value === undefined) return null;
  if (param.pattern !== undefined) return param.pattern.test(cfText(value).trimEnd());
  if (param.condition === 'in' || param.condition === 'not in') {
    const items = cfListToArray(param.criteria);
    const found = (items.length > 0 ? items : ['']).some((item) => compareNonNull(value, item, param.type) === 0);
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
  if (expr.kind === 'param') return paramTruth(expr.param, row);
  const left = exprTruth(expr.left, row);
  const right = exprTruth(expr.right, row);
  if (expr.kind === 'and') {
    if (left === false || right === false) return false;
    return left === true && right === true ? true : null;
  }
  if (left === true || right === true) return true;
  return left === false && right === false ? false : null;
}

/** beanFeed state a request builds (beanFeed.cfc:301-346, 614-733), evaluated over rows in getQuery's order (819-1111). */
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

  constructor(
    private readonly rows: readonly R[],
    private readonly options: BeanFeedOptions,
  ) {
    this.sortBy = options.defaultSort?.sortBy ?? '';
    this.sortDirection = options.defaultSort?.sortDirection ?? 'asc';
    this.properties = new Set(options.propertyNames.map((name) => name.toLowerCase()));
    const columns = options.columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
    this.columns =
      options.columns === undefined && rows.length === 0 ? undefined : new Set(columns.map((c) => c.toLowerCase()));
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
      ...(operator === 'like' && !value.isNull ? { pattern: likeRegExp(value.criteria) } : {}),
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
    const tokens: (string | FeedParam)[] = [];
    let started = false;
    let openGrouping = false;
    const open = (connector: string): void => {
      if (!openGrouping) tokens.push(connector);
      tokens.push('(');
      openGrouping = true;
    };
    for (const param of this.params) {
      if (param.field !== '') {
        const invalidType = param.type !== 'varchar' && !param.isNull && param.criteria === '';
        const nullList = param.isNull && (param.condition === 'in' || param.condition === 'not in');
        if (param.condition === '' || !this.hasColumn(param.field) || invalidType || nullList) throw serverError();
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
      if (param.field !== '') {
        tokens.push(param);
        openGrouping = false;
      }
    }
    if (!started) return undefined;
    tokens.push(')');
    return new ConditionParser(tokens).parse();
  }

  /** The rows the WHERE clause and joins select, after every check getQuery's SQL would fail. */
  private filtered(): R[] {
    this.checkDeniedTables();
    const where = this.where();
    // leftJoin builds its ON clause from the sample bean's column value, so its SQL never compiles (beanFeed.cfc:670-686).
    if (this.joins.some((join) => join.kind === 'left')) throw serverError();
    const inner = this.joins[0];
    if (inner !== undefined) throw new UnsupportedFeedQueryError(`innerJoin on ${inner.cfc}`);
    return where === undefined ? [...this.rows] : this.rows.filter((row) => exprTruth(where, row) === true);
  }

  /** getAvailableCount: `count(*)` over the filtered rows, before TOP. */
  count(): number {
    const rows = this.filtered();
    if (this.groupBy.length > 0) throw new UnsupportedFeedQueryError('countOnly with groupBy');
    return rows.length;
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

  /** The ORDER BY terms (utility.validateSort / validateSortBy / validateSortDirection, beanFeed.caseInsensitiveOrderBy). */
  private orderTerms(): OrderTerm[] {
    if (this.orderBy.length > 0) {
      return this.orderBy.map(({ text, ownTable }) => {
        const parts = text.trim().replace(/\s+/g, ' ').split(' ');
        const direction = parts.length >= 2 ? (parts.pop() ?? '').toLowerCase() : 'asc';
        const field = parts.join(' ').trim();
        if (!SORT_FIELD.test(field) || (direction !== 'asc' && direction !== 'desc')) throw serverError();
        return { column: this.orderColumn(field, ownTable), desc: direction === 'desc' };
      });
    }
    if (this.sortBy === '') return [];
    const fields = cfListToArray(this.sortBy).map((field) => field.trim());
    if (fields.some((field) => !SORT_FIELD.test(field))) throw serverError();
    const desc = this.sortDirection.toLowerCase() === 'desc';
    return fields.map((field, i) => ({
      column: this.orderColumn(i === 0 ? `own.${field}` : field, i === 0),
      desc: i === fields.length - 1 && desc,
    }));
  }

  /** The selected rows: filtered, grouped as SQL Server allows, ordered and limited by TOP. */
  select(urlFields: string): R[] {
    const rows = this.filtered();
    const order = this.orderTerms();
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
    const types = order.map((term) => this.typeOf(term.column));
    const sorted =
      order.length === 0
        ? rows
        : rows
            .map((row, index) => ({ row, index }))
            .sort((a, b) => {
              for (const [i, term] of order.entries()) {
                const x = getNoCase(a.row, term.column);
                const y = getNoCase(b.row, term.column);
                const xNull = x === null || x === undefined;
                const yNull = y === null || y === undefined;
                const diff =
                  xNull || yNull ? Number(!xNull) - Number(!yNull) : compareNonNull(x, y, types[i] ?? 'varchar');
                if (diff !== 0) return term.desc ? -diff : diff;
              }
              return a.index - b.index;
            })
            .map(({ row }) => row);
    return this.maxItems > 0 ? sorted.slice(0, this.maxItems) : sorted;
  }
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
  for (const [key, value] of Object.entries(params)) {
    if (EXPANDED_EXCLUDED.has(key.toLowerCase())) continue;
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

/** The beanIterator page over `rows` after setIteratorProps (jsonApiUtility.cfc:3160-3183, queryIterator.cfc). */
function iteratorPageOf<R>(
  rows: readonly R[],
  ctx: JsonApiRequestContext,
  feedNextN: number,
  entityName: string,
): {
  items: R[];
  page: CollectionPage;
} {
  const recordCount = rows.length;
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
  // queryRowToStruct has no row at or below 0.
  if (recordIndex < 0 && recordIndex < end) throw serverError();
  return {
    items: rows.slice(recordIndex, end),
    page: iteratorPage({ recordCount, maxRecordsPerPage: perPage, pageIndex, entityName }),
  };
}

/**
 * findAll and findQuery (jsonApiUtility.cfc:2542-2625, 2711-2918) for a non-content entity over the rows its feed
 * selects before request params apply: site or pool scope and the entity feed's own defaults. findQuery's filters run
 * for `call.method` findQuery or when `options.expandedParams` is given; paging always reads the URL scope.
 */
export function beanFeedQuery<R extends Readonly<Record<string, unknown>>>(
  rows: readonly R[],
  call: JsonApiCall,
  options: BeanFeedOptions,
): BeanFeedResult<R> {
  const ctx = call.apiContext;
  paramUrl(ctx, 'entityname', call.entityName);
  const feed = new BeanFeed(rows, options);
  const expanded = options.expandedParams;
  let baseUrl: string | undefined;
  if (expanded !== undefined) baseUrl = applyExpandedParams(feed, call, expanded);
  else if (cfEq(call.method, 'findQuery')) baseUrl = applyQueryString(feed, call, options.primaryKey);
  const params: Struct = expanded === undefined ? ctx.url : { ...expanded };
  applyFeedProps(feed, call, params, options.primaryKey);
  const countOnly = getNoCase(params, 'countOnly');
  if (cfIsBoolean(countOnly) && cfToBoolean(countOnly)) return { count: feed.count() };
  const selected = feed.select(cfText(urlParam(ctx, 'fields')));
  const { items, page } = iteratorPageOf(selected, ctx, feed.nextN, call.entityName);
  return baseUrl === undefined ? { items, page } : { items, page, baseUrl };
}
