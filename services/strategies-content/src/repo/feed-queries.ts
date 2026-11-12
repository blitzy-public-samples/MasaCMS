/**
 * Read-only SQL of Masa collections (local content feeds), ported from `feedGateway` and the read paths of
 * `feedDAO`. Every function runs in the caller's tenant transaction, whose RLS scopes the rows; `./repository.ts`
 * re-exposes them as `repo.feeds.*` and owns every write. Remote feeds are fetched by the feed-import job, not here.
 *
 * SQL Server semantics are reproduced where results depend on them: text equality and LIKE are case-insensitive,
 * text sorts through lower(), and NULLs sort lowest.
 */
import { cfIsBoolean, cfIsNumeric, cfToBoolean, cfToNumber } from '@opt2/platform/legacy-compat';
import { awaitReadable, qualified } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  APPROVAL_ASSIGNMENT,
  CATEGORY,
  CATEGORY_ASSIGN,
  COMMENT,
  CONTENT,
  CONTENT_ASSIGNMENT,
  CONTENT_OBJECT,
  CONTENT_RATING,
  CONTENT_RELATED,
  CONTENT_STATS,
  CONTENT_TAG,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  FEED,
  FEED_ADVANCED_PARAM,
  FEED_ITEM,
  FILE,
  FILE_METADATA,
  FILENAME_ARCHIVE,
  REMOTE_POINTER,
  SOURCE_MAP,
  VARIATION_TARGETING,
  type ContentRow,
  type ContentStatsRow,
  type ContentUnit,
  type ContentUnitTableDefinition,
  type FeedAdvancedParamRow,
  type FeedItemRow,
  type FeedRow,
  type FileMetadataRow,
  type FileRow,
} from './tables.js';
import {
  CONTENT_SORT_OPTIONS,
  ContentQueryError,
  SqlParams,
  activeClause,
  extendedCastColumn,
  isExtendedSort,
  mobileClause,
  sortDirectionOf,
  timespanInterval,
  type ChangesetPreview,
  type ExtendedCastColumn,
  type SortDirection,
} from './content-queries.js';

/** `getFeed` sort options; any other `sortBy` is an extended-attribute sort. */
export const FEED_SORT_OPTIONS = [...CONTENT_SORT_OPTIONS, 'expires'] as const;

/** Target names of legacy `histtables`, which feed joins match on `contenthistid` rather than `contentid`. */
export const FEED_HIST_TABLES = [
  CONTENT_TAG.table,
  CATEGORY_ASSIGN.table,
  CONTENT_OBJECT.table,
  CONTENT_RELATED.table,
  CONTENT_ASSIGNMENT.table,
] as const;

/** Raised where legacy refuses a feed reference to a restricted table (`cfthrow type="authorization"`). */
export class FeedAuthorizationError extends Error {
  override readonly name = 'FeedAuthorizationError';

  constructor() {
    super('Feed reference to a restricted table is not allowed.');
  }
}

/** One advanced param as `feed_advanced_param` stores it or `feedBean.addParam` builds it, criteria already rendered. */
export interface FeedParamInput {
  relationship?: string | null;
  field?: string | null;
  condition?: string | null;
  criteria?: string | null;
  datatype?: string | null;
}

/** CF `lsIsDate`/`isDate` with the matching parse: the date a criteria string denotes, or null where CF reads none. */
export type CriteriaDateParser = (text: string) => Date | null;

/** A feed's advanced params with the CF date reading their criteria need (`@opt2/platform/legacy-compat` provides it). */
export interface FeedAdvancedParams {
  rows: readonly FeedParamInput[];
  parseDate: CriteriaDateParser;
}

/** The `beanFeed` aggregate arrays: `table.column` references, or `*` for `count`. */
export interface FeedAggregates {
  groupBy?: readonly string[];
  sum?: readonly string[];
  count?: readonly string[];
  avg?: readonly string[];
  min?: readonly string[];
  max?: readonly string[];
}

/** Runs `fn` in a transaction of the site's category-pool tenant. */
export type CategoryPoolRunner = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** A local feed as `feedGateway.getFeed` reads it; omitted members take the `feedBean` defaults. */
export interface FeedCriteria {
  siteId: string;
  /** Legacy `getContentPoolID()`: the site ids the feed may read; defaults to `siteId`. */
  contentPoolSiteIds?: readonly string[];
  /** Feed type; defaults to `local`. `Remote` throws as legacy does. */
  type?: string;
  /** The feed's `contentID` list: parents whose children are listed. */
  contentIds?: readonly string[];
  /**
   * The feed's `categoryID` list resolved by the caller in the category-pool tenant: each id plus its descendants by
   * `path`, or the listed ids alone with `useCategoryIntersect`. Undefined filters nothing; an empty array matches nothing.
   */
  categoryIds?: readonly string[];
  useCategoryIntersect?: boolean;
  advanced?: FeedAdvancedParams;
  /** The `tag` argument of `getFeed`. */
  tag?: string;
  isFeaturesOnly?: boolean;
  /** `either` (default), `architecture` or `category`. */
  featureType?: string;
  /** Defaults to true. */
  showNavOnly?: boolean;
  showExcludeSearch?: boolean;
  includeHomePage?: boolean;
  /** Defaults to true. */
  liveOnly?: boolean;
  /** Defaults to true. */
  activeOnly?: boolean;
  preview?: ChangesetPreview | null;
  /** Legacy `request.muraMobileRequest`. */
  mobile?: boolean;
  /** Legacy `nowAdjusted` before rounding: the preview publish date, point in time, or the caller's clock. */
  today: Date;
  /** The feed's `cachedWithin` in seconds; 0 (default) rounds `today` to the five-minute interval. */
  cachedWithinSeconds?: number;
  /** Calendar window; used only when both are given, else `today` to twelve months later. */
  from?: Date | null;
  to?: Date | null;
  /** Defaults to `lastUpdate`. */
  sortBy?: string;
  /** `asc` or `desc`; anything else keeps the default `desc`. */
  sortDirection?: string;
  /** `beanFeed.orderBy`: a `validateSort` list or `random`; takes precedence over `sortBy`. */
  orderBy?: string;
  /** Defaults to 20; 0 lists every row. */
  maxItems?: number;
  distinct?: boolean;
  /** Legacy `altTable`; a plugin or alternate table this service does not hold, so a non-empty value throws. */
  altTable?: string;
  /** Category lookups of advanced params run here; defaults to the feed's own transaction. */
  categoryPool?: CategoryPoolRunner;
}

/** The `beanFeed` options that replace the default select list. */
export interface FeedProjection {
  /** `beanFeed.fields`: content column names. */
  fields?: readonly string[];
  aggregates?: FeedAggregates;
}

/** Every option of `feedContent`: a feed, its projection, and `countOnly`. */
export type FeedQuery = FeedCriteria & FeedProjection & { countOnly?: boolean };

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** A feed row without its tenant column. */
export type FeedFields = Omit<FeedRow, 'tenant_id'>;
/** A feed item row without its tenant column. */
export type FeedItemFields = Omit<FeedItemRow, 'tenant_id'>;
/** An advanced param row without its tenant column; `param` arrives as a decimal string. */
export type FeedAdvancedParamFields = Omit<FeedAdvancedParamRow, 'tenant_id'>;

/** A content row as `getFeed` selects it by default. */
export type FeedContentRow = Pick<
  ContentRow,
  | 'siteid'
  | 'title'
  | 'menutitle'
  | 'restricted'
  | 'restrictgroups'
  | 'type'
  | 'subtype'
  | 'filename'
  | 'displaystart'
  | 'displaystop'
  | 'remotesource'
  | 'remoteurl'
  | 'remotesourceurl'
  | 'keypoints'
  | 'contentid'
  | 'parentid'
  | 'approved'
  | 'islocked'
  | 'contenthistid'
  | 'target'
  | 'targetparams'
  | 'releasedate'
  | 'lastupdate'
  | 'summary'
  | 'fileid'
  | 'tags'
  | 'credits'
  | 'audience'
  | 'orderno'
  | 'path'
  | 'created'
  | 'nextn'
  | 'majorversion'
  | 'minorversion'
  | 'expires'
  | 'displayinterval'
  | 'display'
  | 'changesetid'
> &
  Nullable<Pick<FileRow, 'filesize' | 'fileext'>> &
  Nullable<Pick<ContentStatsRow, 'rating' | 'totalvotes' | 'downvotes' | 'upvotes' | 'comments' | 'lockid' | 'locktype'>> & {
    parenttype: string | null;
    assocfilename: FileRow['filename'] | null;
    filealttext: FileMetadataRow['alttext'] | null;
  };

/** A row of a feed with `fields` or aggregates, keyed by output column. */
export type FeedProjectionRow = Record<string, unknown>;

/** The `countOnly` answer of `feedContent`. */
export interface FeedCount {
  count: number;
}

/** A content item of a feed, as `getcontentItems` selects it. */
export type FeedContentItemRow = Pick<ContentRow, 'contentid' | 'menutitle' | 'type' | 'siteid'>;

/** A feed listing a category, as `getFeedsByCategoryID` selects it. */
export type FeedByCategoryRow = Pick<FeedRow, 'name' | 'channellink' | 'type'>;

type Def = ContentUnitTableDefinition;
type CanonicalTag = Def['columns'][number]['type'];

const MODULE_IDS = {
  site: '00000000000000000000000000000000000',
  component: '00000000000000000000000000000000003',
  form: '00000000000000000000000000000000004',
  variation: '00000000000000000000000000000000099',
} as const;
const HOME_PAGE_ID = '00000000000000000000000000000000001';

// configBean deniedFeedJoinTables default.
const DENIED_FEED_TABLES = new Set([
  'tusers',
  'tusersmemb',
  'tusergroups',
  'tsettings',
  'tusersession',
  'toauthtokens',
  'tremembertokens',
  'tpermissions',
  'tsessiontracking',
  'tredirects',
  'toauthclients',
  'tuserremotesessions',
  'tuserdevice',
]);

/**
 * How a legacy table name enters the feed query: the base table, a table the query always left-joins, the tag and
 * category tables legacy filters through subqueries, or a table a param joins (`implied`, on contentid or contenthistid).
 */
type TableRole = 'base' | 'left' | 'tags' | 'categoryAssign' | 'categories' | 'implied';

// Legacy names of the content tables a feed may reference; the alias of each is its legacy name.
const LEGACY_TABLES = {
  tcontent: { def: CONTENT, role: 'base' },
  tparent: { def: CONTENT, role: 'left' },
  tcontentstats: { def: CONTENT_STATS, role: 'left' },
  tfiles: { def: FILE, role: 'left' },
  tcontentfilemetadata: { def: FILE_METADATA, role: 'left' },
  tcontenttags: { def: CONTENT_TAG, role: 'tags' },
  tcontentcategoryassign: { def: CATEGORY_ASSIGN, role: 'categoryAssign' },
  tcontentcategories: { def: CATEGORY, role: 'categories' },
  tcontentobjects: { def: CONTENT_OBJECT, role: 'implied' },
  tcontentrelated: { def: CONTENT_RELATED, role: 'implied' },
  tcontentassignments: { def: CONTENT_ASSIGNMENT, role: 'implied' },
  tcontentratings: { def: CONTENT_RATING, role: 'implied' },
  tcontentcomments: { def: COMMENT, role: 'implied' },
  tapprovalassignments: { def: APPROVAL_ASSIGNMENT, role: 'implied' },
  tcontentfilenamearchive: { def: FILENAME_ARCHIVE, role: 'implied' },
  tcontentsourcemaps: { def: SOURCE_MAP, role: 'implied' },
  tcontentremotepointer: { def: REMOTE_POINTER, role: 'implied' },
  tcontentvariationtargeting: { def: VARIATION_TARGETING, role: 'implied' },
} as const satisfies Record<string, { def: Def; role: TableRole }>;

/** The feed table entry of a lower-cased legacy table name, or undefined for a table feeds cannot reference here. */
function legacyTable(name: string): { def: Def; role: TableRole } | undefined {
  return Object.hasOwn(LEGACY_TABLES, name) ? LEGACY_TABLES[name as keyof typeof LEGACY_TABLES] : undefined;
}

// The tables legacy never joins by param prefix (feedGateway.cfc:219).
const NOT_IMPLIED = new Set(['tcontent', 'tcontentstats', 'tfiles', 'tparent', 'tcontentcategoryassign', 'tcontenttags', 'tcontentcategories']);

// Bookkeeping columns of the target that legacy tables do not have.
const TARGET_ONLY_COLUMNS = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);

/** Runs `sql` in `tx`; the caller has already awaited readability of every unit it reads. */
async function run<R extends Record<string, unknown>>(tx: TenantTx, sql: string, params: readonly unknown[]): Promise<R[]> {
  const { rows } = await tx.query<R>(sql, [...params]);
  return rows;
}

/** Waits out a write window on `units`, so the reads that follow see no superseded rows. */
function readable(tx: TenantTx, units: Iterable<ContentUnit>): Promise<void> {
  return awaitReadable(tx, [...new Set(units)]);
}

/** The elements of a CF list: split on `delimiter`, empty elements skipped. */
function cfList(value: string, delimiter = ','): string[] {
  return value.split(delimiter).filter((item) => item.length > 0);
}

/** The forms a stored single-case CF id may take for a caller-supplied id. */
function idForms(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]))];
}

/** SQL Server `expr IN (ids)` for an id column, matching the id indexes. */
function idIn(p: SqlParams, expr: string, ids: readonly string[]): string {
  return `${expr} = ANY(${p.add(idForms(ids))}::bpchar[])`;
}

/** SQL Server `expr = value` for text: case-insensitive, trailing spaces ignored. */
function ciEq(p: SqlParams, expr: string, value: string): string {
  return `lower(rtrim(${expr})) = lower(rtrim(${p.add(value)}::text))`;
}

/** One ORDER BY key with SQL Server's NULL placement: lowest, so first ascending and last descending. */
function orderKey(expr: string, direction: SortDirection): string {
  return `${expr} ${direction.toUpperCase()} NULLS ${direction === 'asc' ? 'FIRST' : 'LAST'}`;
}

/** CF `dateAdd("m", months, date)`: calendar months, the day clamped to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), lastDay));
  return result;
}

/** CF `isBoolean` read as 1/0, or null where CF reads no boolean. */
function cfBit(text: string): 0 | 1 | null {
  if (!cfIsBoolean(text)) {
    return null;
  }
  return cfToBoolean(text) ? 1 : 0;
}

/** `utility.sanitizeFeedIdentifier`. */
function sanitizeIdentifier(value: string): string {
  return value.replace(/[^0-9A-Za-z_]/g, '');
}

/** `utility.isDeniedFeedTable` for a `table.column` reference, against the default denied list. */
function isDeniedFeedTable(reference: string): boolean {
  return DENIED_FEED_TABLES.has(sanitizeIdentifier(cfList(reference, '.')[0] ?? '').toLowerCase());
}

/** `feedGateway.sanitizedValue`. */
function sanitizedValue(value: string): string {
  return value.replace(/[^0-9A-Za-z._,*]/g, '');
}

/** A resolved column: its SQL expression over a joined alias, canonical type and output name. */
interface ScopeColumn {
  expr: string;
  type: CanonicalTag;
  name: string;
}

/** The legacy column `name` of `def`, matched case-insensitively; target bookkeeping columns are not legacy columns. */
function columnOf(def: Def, name: string): Def['columns'][number] | undefined {
  const wanted = name.toLowerCase();
  return TARGET_ONLY_COLUMNS.has(wanted) ? undefined : def.columns.find((column) => column.name === wanted);
}

/** The aliases a feed query has joined, by lower-cased legacy table name; it resolves references as SQL Server binds them. */
class Scope {
  readonly #aliases = new Map<string, Def>();

  add(alias: string, def: Def): void {
    this.#aliases.set(alias, def);
  }

  /** The column a `table.column` or bare `column` reference names; unbound, unknown and ambiguous names fail as SQL Server fails them. */
  column(reference: string): ScopeColumn {
    const parts = reference.split('.');
    if (parts.length === 2) {
      const [alias = '', name = ''] = parts;
      const def = this.#aliases.get(alias.toLowerCase());
      if (def === undefined) {
        throw new ContentQueryError(`The multi-part identifier "${reference}" could not be bound.`);
      }
      const column = columnOf(def, name);
      if (column === undefined) {
        throw new ContentQueryError(`Invalid column name '${name}'.`);
      }
      return { expr: `${alias.toLowerCase()}.${column.name}`, type: column.type, name: column.name };
    }
    if (parts.length === 1) {
      const matches = [...this.#aliases].flatMap(([alias, def]) => {
        const column = columnOf(def, reference);
        return column === undefined ? [] : [{ expr: `${alias}.${column.name}`, type: column.type, name: column.name }];
      });
      if (matches.length > 1) {
        throw new ContentQueryError(`Ambiguous column name '${reference}'.`);
      }
      const [match] = matches;
      if (match !== undefined) {
        return match;
      }
    }
    throw new ContentQueryError(`Invalid column name '${reference}'.`);
  }
}

// queryParam.cfc variables.grouprelationships, lower-cased.
const GROUP_RELATIONSHIPS = new Set(['(', 'and (', 'or (', ')', 'and not (', 'or not (', 'opengrouping', 'oropengrouping', 'andopengrouping', 'closegrouping']);

/** A param as `mura.queryParam` holds it after `init`: normalized relationship, condition, criteria and datatype. */
interface QueryParam {
  relationship: string;
  field: string;
  /** `=`, `>`, `>=`, `<`, `<=`, `!=`, `in`, `not in`, `like`, or empty for an unknown condition. */
  condition: string;
  /** The criteria string, `null` for a NULL test, or the date a date datatype parsed. */
  criteria: string | Date;
  /** Lower-cased cfsqltype suffix. */
  dataType: string;
  valid: boolean;
}

/** `dbUtility.columnParamType` of a two-part field's legacy column, empty for any other field. */
function columnParamType(field: string): string {
  const parts = cfList(field, '.');
  if (parts.length !== 2) {
    return '';
  }
  const def = legacyTable((parts[0] ?? '').toLowerCase())?.def;
  switch (def === undefined ? undefined : columnOf(def, parts[1] ?? '')?.type) {
    case 'i':
      return 'numeric';
    case 'f':
      return 'float';
    case 'd':
      return 'double';
    case 't':
      return 'timestamp';
    default:
      return 'varchar';
  }
}

/** `queryParam.setDataType`. */
function normalizeDataType(dataType: string): string {
  const value = dataType.toLowerCase();
  if (value === 'datetime') {
    return 'timestamp';
  }
  return value === 'boolean' ? 'bit' : value.replace(/\W/g, '');
}

/** `queryParam.setCondition` for the datatype `getDataType` reports. */
function normalizeCondition(condition: string, dataType: string): string {
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
      return dataType === 'varchar' || dataType === 'longvarchar' ? 'like' : '=';
    default:
      return '';
  }
}

/** CF `createDate(year(d), month(d), day(d))`. */
function dayOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `queryParam.setCriteria` once the datatype is known; datatypes it has no case for leave the criteria empty. */
function normalizeCriteria(text: string, condition: string, dataType: string, parseDate: CriteriaDateParser): string | Date {
  if (text.toLowerCase() === 'null') {
    return 'null';
  }
  switch (dataType) {
    case 'varchar':
    case 'longvarchar':
      switch (condition.toLowerCase()) {
        case 'begins':
        case 'beginswith':
          return `${text}%`;
        case 'ends':
        case 'endswith':
          return `%${text}`;
        case 'contains':
        case 'containsvalue':
        case 'like':
          return `%${text}%`;
        default:
          return text;
      }
    case 'bit':
      return cfIsBoolean(text) ? text : '';
    case 'date': {
      const date = parseDate(text);
      return date === null ? '' : dayOf(date);
    }
    case 'timestamp':
    case 'time':
      return parseDate(text) ?? '';
    case 'numeric':
      return cfIsNumeric(text) ? text : '';
    default:
      return '';
  }
}

/** `mura.queryParam` initialised from one advanced param. */
function queryParam(input: FeedParamInput, parseDate: CriteriaDateParser): QueryParam {
  const field = (input.field ?? '').replace(/[^\w.]+/g, '');
  const relationshipInput = (input.relationship ?? '').toLowerCase();
  const relationship = relationshipInput === 'and' || relationshipInput === 'or' || GROUP_RELATIONSHIPS.has(relationshipInput) ? relationshipInput : '';
  let dataType = normalizeDataType(input.datatype ?? '');
  if (dataType === '') {
    dataType = columnParamType(field);
  }
  // queryParam.init defaults an omitted condition to Equals; a stored NULL condition arrives empty.
  const conditionInput = input.condition === undefined ? 'Equals' : (input.condition ?? '');
  const condition = normalizeCondition(conditionInput, dataType);
  const text = input.criteria ?? '';
  if (dataType === '' && text !== '' && parseDate(text) !== null) {
    dataType = 'timestamp';
  }
  return {
    relationship,
    field,
    condition,
    criteria: normalizeCriteria(text, conditionInput, dataType, parseDate),
    dataType,
    valid: GROUP_RELATIONSHIPS.has(relationship) || field !== '',
  };
}

/** `queryParam.getCondition`: `is` and `is not` for a NULL test, which legacy cannot render for any other condition. */
function conditionOf(param: QueryParam): string {
  if (param.criteria !== 'null') {
    return param.condition;
  }
  if (param.condition === '=') {
    return 'is';
  }
  if (param.condition === '!=') {
    return 'is not';
  }
  throw new ContentQueryError(`Advanced param "${param.field}" tests NULL with condition "${param.condition}", which legacy cannot render`);
}

/** Whether a criteria is a date or a number, as the extended-attribute cast test reads it. */
function isDateOrNumeric(criteria: string | Date, parseDate: CriteriaDateParser): boolean {
  return criteria instanceof Date || cfIsNumeric(criteria) || parseDate(criteria) !== null;
}

// ACF cfsqltype suffixes by the value kind cfqueryparam binds.
const TEXT_SQL_TYPES = new Set(['char', 'varchar', 'longvarchar', 'nchar', 'nvarchar', 'longnvarchar', 'clob', 'nclob', 'idstamp']);
const NUMERIC_SQL_TYPES = new Set(['bigint', 'decimal', 'double', 'float', 'integer', 'money', 'money4', 'numeric', 'real', 'smallint', 'tinyint']);
const DATE_SQL_TYPES = new Set(['date', 'time', 'timestamp']);

type Bound = string | number | Date;

/** The value `cfqueryparam cfsqltype="cf_sql_<dataType>"` binds for `value`, failing where ACF rejects it. */
function bindValue(dataType: string, value: string | Date, parseDate: CriteriaDateParser): Bound {
  const invalid = (): ContentQueryError => new ContentQueryError(`Invalid data ${String(value)} for CFSQLTYPE CF_SQL_${dataType.toUpperCase()}.`);
  if (TEXT_SQL_TYPES.has(dataType)) {
    return value;
  }
  if (NUMERIC_SQL_TYPES.has(dataType)) {
    if (value instanceof Date || !cfIsNumeric(value)) {
      throw invalid();
    }
    return cfToNumber(value);
  }
  if (DATE_SQL_TYPES.has(dataType)) {
    const date = value instanceof Date ? value : parseDate(value);
    if (date === null) {
      throw invalid();
    }
    return date;
  }
  if (dataType === 'bit') {
    const bit = value instanceof Date ? null : cfBit(value);
    if (bit === null) {
      throw invalid();
    }
    return bit;
  }
  throw new ContentQueryError(`Invalid CFSQLTYPE CF_SQL_${dataType.toUpperCase()}.`);
}

const SCALAR_OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=']);

/** The left side of a comparison. */
interface Operand {
  expr: string;
  type: CanonicalTag;
}

/** `left op value` under SQL Server's case-insensitive text comparison and implicit conversion of text to dates. */
function scalarComparison(p: SqlParams, left: Operand, op: string, value: Bound): string {
  if (left.type !== 's') {
    return `${left.expr} ${op} ${p.add(value)}`;
  }
  if (value instanceof Date) {
    return `${left.expr}::timestamp ${op} ${p.add(value)}::timestamp`;
  }
  return `lower(rtrim(${left.expr})) ${op} lower(rtrim(${p.add(String(value))}::text))`;
}

/** `left [NOT] IN (values)` under SQL Server's case-insensitive text comparison. */
function listComparison(p: SqlParams, left: Operand, values: readonly Bound[], negate: boolean): string {
  const keyword = negate ? 'NOT IN' : 'IN';
  if (left.type === 's' && values.every((value) => !(value instanceof Date))) {
    return `lower(rtrim(${left.expr})) ${keyword} (SELECT lower(rtrim(v)) FROM unnest(${p.add(values.map(String))}::text[]) AS v)`;
  }
  return `${left.expr} ${keyword} (${values.map((value) => p.add(value)).join(', ')})`;
}

/** The predicate legacy renders as `field condition <cfqueryparam>` for `param` under the SQL condition `op`. */
function paramComparison(p: SqlParams, left: Operand, op: string, param: QueryParam, parseDate: CriteriaDateParser): string {
  if (op === 'is' || op === 'is not') {
    return `${left.expr} ${op.toUpperCase()} NULL`;
  }
  if (op === 'in' || op === 'not in') {
    // cfqueryparam list="true" splits the criteria as a CF list; an empty list binds one empty string.
    const items = param.criteria instanceof Date ? [param.criteria] : cfList(param.criteria);
    const values = (items.length === 0 ? [''] : items).map((item) => bindValue(param.dataType, item, parseDate));
    return listComparison(p, left, values, op === 'not in');
  }
  const value = bindValue(param.dataType, param.criteria, parseDate);
  if (op === 'like') {
    return `upper(${left.expr}::text) LIKE upper(${p.add(String(value))}::text) ESCAPE ''`;
  }
  if (!SCALAR_OPERATORS.has(op)) {
    throw new ContentQueryError(`Advanced param "${param.field}" has no condition legacy can render`);
  }
  return scalarComparison(p, left, op, value);
}


// tcontentfeeds columns in catalog order: feedDAO's fieldList and getFeeds' `select *` read the same set.
const FEED_FIELDS = FEED.columns.map((column) => column.name).filter((name) => !TARGET_ONLY_COLUMNS.has(name));

/** The feed columns of `alias`, comma-separated. */
function feedColumns(alias: string): string {
  return FEED_FIELDS.map((name) => `${alias}.${name}`).join(', ');
}

/** Feeds of `siteId` matching `where`, in legacy `order by name` with ties in clustered (feedid) order. */
async function feedsWhere(tx: TenantTx, p: SqlParams, where: string): Promise<FeedFields[]> {
  await readable(tx, [FEED.unit]);
  return run(
    tx,
    `SELECT ${feedColumns('tcontentfeeds')} FROM ${qualified(tx.schema, FEED.table)} tcontentfeeds` +
      ` WHERE ${where} ORDER BY ${orderKey('lower(tcontentfeeds.name)', 'asc')}, tcontentfeeds.feedid`,
    p.values,
  );
}

/** feedGateway.getFeeds: the feeds of a site and type, optionally public or active only. */
export function listFeeds(
  tx: TenantTx,
  args: { siteId: string; type: string; publicOnly?: boolean; activeOnly?: boolean },
): Promise<FeedFields[]> {
  const p = new SqlParams();
  const where = [`tcontentfeeds.siteid = ${p.add(args.siteId)}`, ciEq(p, 'tcontentfeeds.type', args.type)];
  if (args.publicOnly === true) {
    where.push('tcontentfeeds.ispublic = 1');
  }
  if (args.activeOnly === true) {
    where.push('tcontentfeeds.isactive = 1');
  }
  return feedsWhere(tx, p, where.join(' AND '));
}

/** feedGateway.getDefaultFeeds: the default feeds of a site. */
export function defaultFeeds(tx: TenantTx, args: { siteId: string }): Promise<FeedFields[]> {
  const p = new SqlParams();
  return feedsWhere(tx, p, `tcontentfeeds.siteid = ${p.add(args.siteId)} AND tcontentfeeds.isdefault = 1`);
}

/** The first feed matching `where` in clustered (feedid) order, or null. */
async function feedWhere(tx: TenantTx, p: SqlParams, where: string): Promise<FeedFields | null> {
  await readable(tx, [FEED.unit]);
  const rows = await run<FeedFields>(
    tx,
    `SELECT ${feedColumns('tcontentfeeds')} FROM ${qualified(tx.schema, FEED.table)} tcontentfeeds WHERE ${where} ORDER BY tcontentfeeds.feedid LIMIT 1`,
    p.values,
  );
  return rows[0] ?? null;
}

/** feedDAO.read: the feed `feedId`, or null. */
export function feedById(tx: TenantTx, args: { feedId: string }): Promise<FeedFields | null> {
  const p = new SqlParams();
  return feedWhere(tx, p, idIn(p, 'tcontentfeeds.feedid', [args.feedId]));
}

/** feedDAO.readByName: the feed of a site with `name` (the first of duplicates), or null. */
export function feedByName(tx: TenantTx, args: { siteId: string; name: string }): Promise<FeedFields | null> {
  const p = new SqlParams();
  return feedWhere(tx, p, `${ciEq(p, 'tcontentfeeds.name', args.name)} AND tcontentfeeds.siteid = ${p.add(args.siteId)}`);
}

/** feedDAO.readByRemoteID: the feed of a site with `remoteId` (the first of duplicates), or null. */
export function feedByRemoteId(tx: TenantTx, args: { siteId: string; remoteId: string }): Promise<FeedFields | null> {
  const p = new SqlParams();
  return feedWhere(tx, p, `${ciEq(p, 'tcontentfeeds.remoteid', args.remoteId)} AND tcontentfeeds.siteid = ${p.add(args.siteId)}`);
}

/** feedDAO.readItems: the items of a feed, of one type (`contentID` or `categoryID`) when given, in clustered order. */
export async function feedItems(tx: TenantTx, args: { feedId: string; type?: string }): Promise<FeedItemFields[]> {
  await readable(tx, [FEED_ITEM.unit]);
  const p = new SqlParams();
  const where = [idIn(p, 'feedid', [args.feedId]), ...(args.type === undefined ? [] : [ciEq(p, 'type', args.type)])];
  return run(
    tx,
    `SELECT feedid, itemid, type FROM ${qualified(tx.schema, FEED_ITEM.table)} WHERE ${where.join(' AND ')} ORDER BY feedid, itemid`,
    p.values,
  );
}

/** feedDAO.readAdvancedParams: the advanced params of a feed `order by param`, ties in clustered (paramid) order. */
export async function feedAdvancedParams(tx: TenantTx, args: { feedId: string }): Promise<FeedAdvancedParamFields[]> {
  await readable(tx, [FEED_ADVANCED_PARAM.unit]);
  const p = new SqlParams();
  return run(
    tx,
    'SELECT paramid, feedid, param, relationship, field, condition, criteria, datatype' +
      ` FROM ${qualified(tx.schema, FEED_ADVANCED_PARAM.table)} WHERE ${idIn(p, 'feedid', [args.feedId])}` +
      ` ORDER BY ${orderKey('param', 'asc')}, paramid`,
    p.values,
  );
}

/**
 * feedGateway.getcontentItems: the active versions of the feed's content items in its content pool, from `contentIds`
 * or else the feed's `contentID` items. Content-pool sites are other tenants, so the caller runs this once per tenant.
 */
export async function contentItems(
  tx: TenantTx,
  args: { feedId?: string; siteId: string; contentIds?: readonly string[]; contentPoolSiteIds?: readonly string[] },
): Promise<FeedContentItemRow[]> {
  const ids =
    args.contentIds ??
    (args.feedId === undefined ? [] : (await feedItems(tx, { feedId: args.feedId, type: 'contentID' })).map((item) => item.itemid));
  await readable(tx, [CONTENT.unit]);
  const p = new SqlParams();
  // Without items legacy compares contentid with the empty string.
  const where =
    ids.length === 0
      ? idIn(p, 'tcontent.contentid', [''])
      : `${idIn(p, 'tcontent.contentid', ids)} AND tcontent.siteid = ANY(${p.add(args.contentPoolSiteIds ?? [args.siteId])}::text[])`;
  return run(
    tx,
    `SELECT tcontent.contentid, tcontent.menutitle, tcontent.type, tcontent.siteid FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE tcontent.active = 1 AND ${where} ORDER BY tcontent.tcontent_id`,
    p.values,
  );
}

/** feedGateway.getFeedsByCategoryID: the feeds of a site listing `categoryId`, or any category of the site for `all`. */
export async function feedsByCategoryId(tx: TenantTx, args: { siteId: string; categoryId: string }): Promise<FeedByCategoryRow[]> {
  const all = args.categoryId.toLowerCase() === 'all';
  await readable(tx, [FEED.unit, FEED_ITEM.unit, ...(all ? [CATEGORY.unit] : [])]);
  const p = new SqlParams();
  const item = all
    ? `tcontentfeeditems.itemid IN (SELECT tcontentcategories.categoryid FROM ${qualified(tx.schema, CATEGORY.table)} tcontentcategories` +
      ` WHERE tcontentcategories.siteid = ${p.add(args.siteId)})`
    : idIn(p, 'tcontentfeeditems.itemid', [args.categoryId]);
  return run(
    tx,
    `SELECT tcontentfeeds.name, tcontentfeeds.channellink, tcontentfeeds.type FROM ${qualified(tx.schema, FEED.table)} tcontentfeeds` +
      ` WHERE tcontentfeeds.feedid IN (SELECT tcontentfeeditems.feedid FROM ${qualified(tx.schema, FEED_ITEM.table)} tcontentfeeditems` +
      ` WHERE ${item} AND lower(rtrim(tcontentfeeditems.type)) = 'categoryid')` +
      ` AND tcontentfeeds.siteid = ${p.add(args.siteId)} ORDER BY tcontentfeeds.feedid`,
    p.values,
  );
}

/** feedGateway.getTypeCount: the active feeds, of a site and of a type where given (empty matches all). */
export async function feedTypeCount(tx: TenantTx, args: { siteId?: string; type?: string }): Promise<{ total: number }[]> {
  await readable(tx, [FEED.unit]);
  const p = new SqlParams();
  const where = ['isactive = 1'];
  if (args.siteId !== undefined && args.siteId !== '') {
    where.push(`siteid = ${p.add(args.siteId)}`);
  }
  if (args.type !== undefined && args.type !== '') {
    where.push(ciEq(p, 'type', args.type));
  }
  return run(tx, `SELECT count(*)::integer AS total FROM ${qualified(tx.schema, FEED.table)} WHERE ${where.join(' AND ')}`, p.values);
}


/** Build state of one `getFeed` query; `p` numbers placeholders in the order the SQL text places them. */
interface FeedBuild {
  tx: TenantTx;
  p: SqlParams;
  scope: Scope;
  units: Set<ContentUnit>;
  siteId: string;
  pool: readonly string[];
  parseDate: CriteriaDateParser;
  inCategoryPool: CategoryPoolRunner;
  /** Legacy `paramCatList`: criteria items of category-id and category-path params, which the features filter adds. */
  paramCategoryItems: string[];
}

// Params whose criteria legacy adds to the features category list (feedGateway.cfc:521).
const CATEGORY_LIST_FIELDS = new Set(['tcontentcategoryassign.categoryid', 'tcontentcategories.path']);

/** The `table.column` of a two-part field resolved against one subquery table. */
function subqueryColumn(alias: string, def: Def, field: string): ScopeColumn {
  const scope = new Scope();
  scope.add(alias, def);
  return scope.column(field);
}

/** Ids of the categories `where` selects, read in the category-pool tenant. */
function poolCategoryIds(build: FeedBuild, where: (q: SqlParams) => string): Promise<string[]> {
  return build.inCategoryPool(async (poolTx) => {
    await readable(poolTx, [CATEGORY.unit]);
    const q = new SqlParams();
    const sql =
      `SELECT tcontentcategories.categoryid FROM ${qualified(poolTx.schema, CATEGORY.table)} tcontentcategories` +
      ` WHERE ${where(q)} ORDER BY tcontentcategories.categoryid`;
    const rows = await run<{ categoryid: string }>(poolTx, sql, q.values);
    return rows.map((row) => row.categoryid);
  });
}

/** `tcontent.contenthistid [NOT] IN` the versions whose category assignment satisfies `where`. */
function assignedVersions(build: FeedBuild, where: string, negate: boolean): string {
  build.units.add(CATEGORY_ASSIGN.unit);
  return (
    `tcontent.contenthistid ${negate ? 'NOT IN' : 'IN'} (SELECT DISTINCT tcontentcategoryassign.contenthistid` +
    ` FROM ${qualified(build.tx.schema, CATEGORY_ASSIGN.table)} tcontentcategoryassign WHERE ${where})`
  );
}

/** A category-table param: assignment columns compare in this tenant, category columns resolve in the category pool. */
async function categoryParamPredicate(build: FeedBuild, param: QueryParam, table: string, op: string, negate: boolean): Promise<string> {
  if (table === 'tcontentcategoryassign') {
    const column = subqueryColumn(table, CATEGORY_ASSIGN, param.field);
    return assignedVersions(build, paramComparison(build.p, column, op, param, build.parseDate), negate);
  }
  const column = subqueryColumn(table, CATEGORY, param.field);
  const ids = await poolCategoryIds(build, (q) => paramComparison(q, column, op, param, build.parseDate));
  return assignedVersions(build, idIn(build.p, 'tcontentcategoryassign.categoryid', ids), negate);
}

/** The `tclassextenddata` rows of an extended attribute named by `field` (an attribute id when numeric). */
function extendedSource(build: FeedBuild, field: string): string {
  const data = qualified(build.tx.schema, EXTEND_DATA.table);
  if (cfIsNumeric(field)) {
    return `FROM ${data} tclassextenddata WHERE tclassextenddata.attributeid = ${build.p.add(cfToNumber(field))}`;
  }
  return (
    `FROM ${data} tclassextenddata INNER JOIN ${qualified(build.tx.schema, EXTEND_ATTRIBUTE.table)} tclassextendattributes` +
    ' ON (tclassextenddata.attributeid = tclassextendattributes.attributeid)' +
    ` WHERE tclassextendattributes.siteid = ANY(${build.p.add(build.pool)}::text[]) AND ${ciEq(build.p, 'tclassextendattributes.name', field)}`
  );
}

/** An extended-attribute param, comparing the value column legacy's `castfield` rules pick. */
async function extendedPredicate(build: FeedBuild, param: QueryParam, op: string): Promise<string> {
  build.units.add(EXTEND_DATA.unit);
  build.units.add(EXTEND_ATTRIBUTE.unit);
  if (op === 'is') {
    const missing = extendedSource(build, param.field);
    const nullValued = extendedSource(build, param.field);
    return (
      `(tcontent.contenthistid NOT IN (SELECT tclassextenddata.baseid ${missing})` +
      ` OR tcontent.contenthistid IN (SELECT tclassextenddata.baseid ${nullValued} AND tclassextenddata.attributevalue IS NULL))`
    );
  }
  let cast: ExtendedCastColumn | 'attributevalue' = 'attributevalue';
  let dataType = param.dataType;
  if (param.criteria !== 'null' && op !== 'like') {
    if (isDateOrNumeric(param.criteria, build.parseDate)) {
      cast = await extendedCastColumn(build.tx, { siteId: build.siteId, attribute: param.field });
      dataType = cast === 'datetimevalue' ? 'timestamp' : cast === 'numericvalue' ? 'numeric' : dataType;
    } else {
      cast = await extendedCastColumn(build.tx, { siteId: build.siteId, attribute: param.field, datatype: param.dataType });
    }
  }
  const source = extendedSource(build, param.field);
  const value: Operand = { expr: `tclassextenddata.${cast}`, type: cast === 'numericvalue' ? 'f' : cast === 'datetimevalue' ? 't' : 's' };
  const comparison = paramComparison(build.p, value, op, { ...param, dataType }, build.parseDate);
  return `tcontent.contenthistid IN (SELECT tclassextenddata.baseid ${source} AND ${comparison})`;
}

/** The predicate of one valid param under its SQL condition `op`, or undefined for a grouping-only param. */
async function paramPredicate(build: FeedBuild, param: QueryParam, op: string): Promise<string | undefined> {
  const parts = cfList(param.field, '.');
  if (parts.length > 1) {
    const table = parts[0] ?? '';
    const negate = op === 'not in';
    const inner = negate ? 'in' : op;
    // Legacy matches the category tables case-sensitively (listFind) and the tag table case-insensitively.
    if (table === 'tcontentcategoryassign' || table === 'tcontentcategories') {
      const predicate = await categoryParamPredicate(build, param, table, inner, negate);
      if (CATEGORY_LIST_FIELDS.has(param.field.toLowerCase()) && param.criteria !== 'null') {
        build.paramCategoryItems.push(...cfList(String(param.criteria)));
      }
      return predicate;
    }
    if (table.toLowerCase() === 'tcontenttags') {
      build.units.add(CONTENT_TAG.unit);
      const comparison = paramComparison(build.p, subqueryColumn('tcontenttags', CONTENT_TAG, param.field), inner, param, build.parseDate);
      return (
        `tcontent.contenthistid ${negate ? 'NOT IN' : 'IN'} (SELECT DISTINCT tcontenttags.contenthistid` +
        ` FROM ${qualified(build.tx.schema, CONTENT_TAG.table)} tcontenttags WHERE ${comparison})`
      );
    }
    return paramComparison(build.p, build.scope.column(param.field), op, param, build.parseDate);
  }
  return param.field === '' ? undefined : extendedPredicate(build, param, op);
}

/** The `rsParams` group of `getFeed`, rendering relationships and groupings as legacy emits them; undefined without valid params. */
async function paramsGroup(build: FeedBuild, rows: readonly FeedParamInput[]): Promise<string | undefined> {
  const tokens: string[] = [];
  let started = false;
  let openGrouping = false;
  for (const row of rows) {
    const param = queryParam(row, build.parseDate);
    if (!param.valid) {
      continue;
    }
    if (!started) {
      openGrouping = true;
      tokens.push('(');
    }
    switch (param.relationship) {
      case 'opengrouping':
      case '(':
      case 'andopengrouping':
      case 'and (':
        tokens.push(...(openGrouping ? [] : ['AND']), '(');
        openGrouping = true;
        break;
      case 'oropengrouping':
      case 'or (':
        tokens.push(...(openGrouping ? [] : ['OR']), '(');
        openGrouping = true;
        break;
      case 'and not (':
        tokens.push(...(openGrouping ? [] : ['AND']), 'NOT (');
        openGrouping = true;
        break;
      case 'or not (':
        tokens.push(...(openGrouping ? [] : ['OR']), 'NOT (');
        openGrouping = true;
        break;
      case 'closegrouping':
      case ')':
        tokens.push(')');
        openGrouping = false;
        break;
      default:
        if (!openGrouping && param.relationship !== '') {
          tokens.push(param.relationship.toUpperCase());
        }
    }
    const op = conditionOf(param);
    started = true;
    const predicate = await paramPredicate(build, param, op);
    if (predicate !== undefined) {
      tokens.push(predicate);
      openGrouping = false;
    }
  }
  return started ? `${tokens.join(' ')} )` : undefined;
}

/** Legacy `isFeature` test on `alias` at `now`: always featured, or featured inside its feature window. */
function featureWindow(p: SqlParams, alias: string, now: Date): string {
  return (
    `(${alias}.isfeature = 1 OR (${alias}.isfeature = 2 AND ${alias}.featurestart <= ${p.add(now)}` +
    ` AND (${alias}.featurestop >= ${p.add(now)} OR ${alias}.featurestop IS NULL)))`
  );
}

/** The feed's category filter: assignments to any resolved id, or to every listed id with `useCategoryIntersect`. */
function categoryClause(build: FeedBuild, categoryIds: readonly string[], intersect: boolean): string {
  if (!intersect) {
    return assignedVersions(build, idIn(build.p, 'tcontentcategoryassign.categoryid', categoryIds), false);
  }
  const [first, ...rest] = categoryIds;
  if (first === undefined) {
    return 'FALSE';
  }
  build.units.add(CATEGORY_ASSIGN.unit);
  const assign = qualified(build.tx.schema, CATEGORY_ASSIGN.table);
  const joins = rest
    .map((id, i) => ` INNER JOIN ${assign} ca${i + 2} ON ca${i + 1}.contenthistid = ca${i + 2}.contenthistid AND ${idIn(build.p, `ca${i + 2}.categoryid`, [id])}`)
    .join('');
  return `tcontent.contenthistid IN (SELECT ca1.contenthistid FROM ${assign} ca1${joins} WHERE ${idIn(build.p, 'ca1.categoryid', [first])})`;
}

/** The `isFeaturesOnly` filter: content features, category features of the feed's and the params' categories, or both. */
async function featuresClause(build: FeedBuild, criteria: FeedCriteria, intersect: boolean, now: Date): Promise<string> {
  const featureType = (criteria.featureType ?? 'either').toLowerCase();
  const branches: string[] = [];
  if (featureType === 'either' || featureType === 'architecture') {
    branches.push(featureWindow(build.p, 'tcontent', now));
  }
  const items = build.paramCategoryItems;
  if ((featureType === 'either' || featureType === 'category') && (criteria.categoryIds !== undefined || items.length > 0)) {
    build.units.add(CATEGORY_ASSIGN.unit);
    const assign = qualified(build.tx.schema, CATEGORY_ASSIGN.table);
    if (intersect) {
      const listed = [...(criteria.categoryIds ?? []), ...items];
      if (listed.length > 1) {
        // Legacy reads arguments.hasFeatures here, which getFeed never declares.
        throw new ContentQueryError('Element HASFEATURES is undefined in ARGUMENTS.');
      }
      const [first] = listed;
      branches.push(
        first === undefined
          ? 'FALSE'
          : `tcontent.contenthistid IN (SELECT a.contenthistid FROM ${assign} a WHERE ${idIn(build.p, 'a.categoryid', [first])}` +
              ` AND ${featureWindow(build.p, 'a', now)})`,
      );
    } else {
      const fromItems =
        items.length === 0
          ? []
          : await poolCategoryIds(build, (q) =>
              items.map((item) => `upper(tcontentcategories.path) LIKE upper(${q.add(`%${item}%`)}::text) ESCAPE ''`).join(' OR '),
            );
      const ids = [...(criteria.categoryIds ?? []), ...fromItems];
      branches.push(
        `tcontent.contenthistid IN (SELECT DISTINCT tcontentcategoryassign.contenthistid FROM ${assign} tcontentcategoryassign` +
          ` WHERE ${idIn(build.p, 'tcontentcategoryassign.categoryid', ids)} AND ${featureWindow(build.p, 'tcontentcategoryassign', now)})`,
      );
    }
  }
  if (branches.length === 0) {
    // Legacy renders an empty `AND ( )`, which the database rejects.
    throw new ContentQueryError(`Feature type "${criteria.featureType ?? ''}" selects no feature filter`);
  }
  return `(${branches.join(' OR ')})`;
}

/** The `liveOnly` display window: displayed, scheduled and current, or a calendar item overlapping `from`..`to`. */
function displayWindow(p: SqlParams, now: Date, from: Date, to: Date): string {
  return (
    `(tcontent.display = 1 OR (tcontent.display = 2 AND ((lower(rtrim(tparent.type)) <> 'calendar'` +
    ` AND tcontent.displaystart <= ${p.add(now)} AND (tcontent.displaystop >= ${p.add(now)} OR tcontent.displaystop IS NULL))` +
    ` OR (lower(rtrim(tparent.type)) = 'calendar' AND tcontent.displaystart <= ${p.add(to)}` +
    ` AND (tcontent.displaystop >= ${p.add(from)} OR tcontent.displaystop IS NULL)))))`
  );
}

/** The module filter of a feed type. */
function moduleClause(type: string): string {
  switch (type) {
    case 'component':
      return `tcontent.moduleid = '${MODULE_IDS.component}'`;
    case 'form':
      return `tcontent.moduleid = '${MODULE_IDS.form}'`;
    case 'variation':
      return `tcontent.moduleid = '${MODULE_IDS.variation}'`;
    case '*':
      return `tcontent.moduleid IN ('${MODULE_IDS.component}', '${MODULE_IDS.form}', '${MODULE_IDS.variation}', '${MODULE_IDS.site}')`;
    default:
      return `tcontent.moduleid = '${MODULE_IDS.site}'`;
  }
}

// getFeed's default select list: [alias, column, output name where it differs].
const FEED_SELECT: readonly (readonly [alias: string, column: string, name?: string])[] = [
  ['tcontent', 'siteid'],
  ['tcontent', 'title'],
  ['tcontent', 'menutitle'],
  ['tcontent', 'restricted'],
  ['tcontent', 'restrictgroups'],
  ['tcontent', 'type'],
  ['tcontent', 'subtype'],
  ['tcontent', 'filename'],
  ['tcontent', 'displaystart'],
  ['tcontent', 'displaystop'],
  ['tcontent', 'remotesource'],
  ['tcontent', 'remoteurl'],
  ['tcontent', 'remotesourceurl'],
  ['tcontent', 'keypoints'],
  ['tcontent', 'contentid'],
  ['tcontent', 'parentid'],
  ['tcontent', 'approved'],
  ['tcontent', 'islocked'],
  ['tcontent', 'contenthistid'],
  ['tcontent', 'target'],
  ['tcontent', 'targetparams'],
  ['tcontent', 'releasedate'],
  ['tcontent', 'lastupdate'],
  ['tcontent', 'summary'],
  ['tfiles', 'filesize'],
  ['tfiles', 'fileext'],
  ['tcontent', 'fileid'],
  ['tcontent', 'tags'],
  ['tcontent', 'credits'],
  ['tcontent', 'audience'],
  ['tcontent', 'orderno'],
  ['tcontentstats', 'rating'],
  ['tcontentstats', 'totalvotes'],
  ['tcontentstats', 'downvotes'],
  ['tcontentstats', 'upvotes'],
  ['tcontentstats', 'comments'],
  ['tparent', 'type', 'parenttype'],
  ['tcontent', 'path'],
  ['tcontent', 'created'],
  ['tcontent', 'nextn'],
  ['tcontent', 'majorversion'],
  ['tcontent', 'minorversion'],
  ['tcontentstats', 'lockid'],
  ['tcontentstats', 'locktype'],
  ['tcontent', 'expires'],
  ['tfiles', 'filename', 'assocfilename'],
  ['tcontent', 'displayinterval'],
  ['tcontent', 'display'],
  ['tcontentfilemetadata', 'alttext', 'filealttext'],
  ['tcontent', 'changesetid'],
];

// feedBean.transformFields additions to a `fields` select.
const FIELDS_ADDITIONS = ['displayinterval', 'displaystart', 'displaystop', 'display', 'siteid'];

/** The `fields` select after `setFields` (content columns only) and `transformFields`; undefined when no field survives. */
function fieldOutputs(fields: readonly string[], scope: Scope): ScopeColumn[] | undefined {
  const names = fields.flatMap((field) => columnOf(CONTENT, field.trim())?.name ?? []);
  if (names.length === 0) {
    return undefined;
  }
  const withAdditions = [...names, ...FIELDS_ADDITIONS];
  if (!names.includes('contentid') && !names.includes('contenthistid')) {
    withAdditions.push('contentid');
  }
  return [
    ...[...new Set(withAdditions)].map((name) => scope.column(`tcontent.${name}`)),
    { ...scope.column('tparent.type'), name: 'parenttype' },
  ];
}

/** The aggregate select of `getFeed`: grouped columns, then sums, counts, averages, minimums and maximums, typed as SQL Server types them. */
function aggregateOutputs(aggregates: FeedAggregates, scope: Scope): { outputs: ScopeColumn[]; groupBy: ScopeColumn[] } {
  const column = (reference: string): ScopeColumn => scope.column(sanitizedValue(reference));
  const groupBy = (aggregates.groupBy ?? []).map(column);
  const integral = (c: ScopeColumn): boolean => c.type === 'i';
  const outputs: ScopeColumn[] = [
    ...groupBy,
    ...(aggregates.sum ?? []).map(column).map((c) => ({ name: `sum_${c.name}`, expr: integral(c) ? `sum(${c.expr})::integer` : `sum(${c.expr})`, type: c.type })),
    ...(aggregates.count ?? []).map((reference) => {
      if (cfList(reference, '.').at(-1) === '*') {
        return { name: 'count', expr: 'count(*)::integer', type: 'i' as const };
      }
      const c = column(reference);
      return { name: `count_${c.name}`, expr: `count(${c.expr})::integer`, type: 'i' as const };
    }),
    ...(aggregates.avg ?? []).map(column).map((c) => ({ name: `avg_${c.name}`, expr: integral(c) ? `trunc(avg(${c.expr}))::integer` : `avg(${c.expr})`, type: c.type })),
    ...(aggregates.min ?? []).map(column).map((c) => ({ name: `min_${c.name}`, expr: `min(${c.expr})`, type: c.type })),
    ...(aggregates.max ?? []).map(column).map((c) => ({ name: `max_${c.name}`, expr: `max(${c.expr})`, type: c.type })),
  ];
  return { outputs, groupBy };
}

/** One ORDER BY key before rendering; `random` orders by `random()`. */
interface OrderTerm {
  expr: string;
  type: CanonicalTag | 'random';
  direction: SortDirection;
}

// The cfcase column sorts of getFeed's sortBy switch.
const COLUMN_SORTS = new Set(['menutitle', 'title', 'lastupdate', 'releasedate', 'orderno', 'displaystart', 'displaystop', 'created', 'expires', 'credits', 'type', 'subtype']);

/** `utility.validateSort`: `field [direction]` items, each field of letters, digits, underscores and dots. */
function validateSort(sort: string): [string, SortDirection][] {
  return cfList(sort).map((item) => {
    const parts = cfList(item.trim().replace(/\s+/g, ' '), ' ');
    const field = parts.length >= 2 ? parts.slice(0, -1).join(' ') : (parts[0] ?? '');
    const direction = parts.length >= 2 ? (parts.at(-1) ?? '') : 'asc';
    if (!/^[a-zA-Z0-9_.]+$/.test(field.trim())) {
      throw new ContentQueryError(`Invalid sort by field: '${field.trim()}'`);
    }
    const normalized = direction.trim().toLowerCase();
    if (normalized !== 'asc' && normalized !== 'desc') {
      throw new ContentQueryError(`Invalid sort direction '${direction}'. Only 'asc' or 'desc' allowed to prevent SQL injection.`);
    }
    return [field.trim(), normalized];
  });
}

/** A sort reference as SQL Server binds it in ORDER BY: a select-list name first, then a joined column. */
function sortColumn(reference: string, scope: Scope, outputs: readonly ScopeColumn[]): ScopeColumn {
  if (!reference.includes('.')) {
    const output = outputs.find((candidate) => candidate.name === reference.toLowerCase());
    if (output !== undefined) {
      return output;
    }
  }
  return scope.column(reference);
}

/** The ORDER BY keys of `getFeed`: `orderBy` when set, else the `sortBy` switch; none when both are empty. */
function orderTerms(criteria: FeedCriteria, scope: Scope, outputs: readonly ScopeColumn[], extended: ExtendedCastColumn | undefined): OrderTerm[] {
  const orderBy = criteria.orderBy ?? '';
  const sortBy = criteria.sortBy ?? 'lastUpdate';
  const direction = sortDirectionOf(criteria.sortDirection, 'desc');
  if (orderBy !== '') {
    if (orderBy.toLowerCase() === 'random') {
      return [{ expr: 'random()', type: 'random', direction: 'asc' }];
    }
    const terms = validateSort(orderBy).map(([field, dir]): OrderTerm => ({ ...sortColumn(field, scope, outputs), direction: dir }));
    if (terms.length === 0) {
      throw new ContentQueryError('Incorrect syntax near the keyword ORDER BY.');
    }
    return terms;
  }
  if (sortBy === '') {
    return [];
  }
  const key = sortBy.toLowerCase();
  if (COLUMN_SORTS.has(key)) {
    return [{ ...scope.column(`tcontent.${key}`), direction }];
  }
  switch (key) {
    case 'rating':
      return [
        { ...scope.column('tcontentstats.rating'), direction },
        { ...scope.column('tcontentstats.totalvotes'), direction },
      ];
    case 'comments':
      return [{ ...scope.column('tcontentstats.comments'), direction }];
    case 'random':
      return [{ expr: 'random()', type: 'random', direction: 'asc' }];
    default:
      if (extended !== undefined) {
        return [{ expr: 'qextendedsort.extendedsort', type: extended === 'stringvalue' ? 's' : extended === 'numericvalue' ? 'f' : 't', direction }];
      }
      return [
        { ...scope.column('tcontent.releasedate'), direction: 'desc' },
        { ...scope.column('tcontent.lastupdate'), direction: 'desc' },
        { ...scope.column('tcontent.menutitle'), direction: 'asc' },
      ];
  }
}

/** One rendered ORDER BY key; text sorts as SQL Server's case-insensitive collation does. */
function termSql(term: OrderTerm): string {
  if (term.type === 'random') {
    return 'random()';
  }
  return orderKey(term.type === 's' ? `lower(${term.expr})` : term.expr, term.direction);
}


/** The aliases every feed query joins, before param-implied joins. */
const BASE_ALIASES = ['tcontent', 'tparent', 'tcontentstats', 'tfiles', 'tcontentfilemetadata'] as const;

/** The param-prefixed tables legacy inner-joins (feedGateway.cfc:209-223), refusing restricted tables first. */
function impliedJoinTables(rows: readonly FeedParamInput[], tag: string): string[] {
  const tables = tag === '' ? [] : ['tcontenttags'];
  for (const row of rows) {
    const parts = cfList(row.field ?? '', '.');
    if (parts.length !== 2) {
      continue;
    }
    const table = sanitizeIdentifier(parts[0] ?? '');
    if (isDeniedFeedTable(table)) {
      throw new FeedAuthorizationError();
    }
    if (!NOT_IMPLIED.has(table.toLowerCase()) && !tables.includes(table)) {
      tables.push(table);
    }
  }
  return tables;
}

/** The joins of `tables` on `contenthistid` (hist tables) or `contentid`, failing where SQL Server rejects the join. */
function impliedJoins(build: FeedBuild, tables: readonly string[]): string[] {
  const seen = new Set<string>();
  return tables.map((table) => {
    const key = table.toLowerCase();
    const entry = legacyTable(key);
    // tcontentfilemetadata is also left-joined below, and SQL Server names are case-insensitive.
    if (seen.has(key) || entry?.role === 'left') {
      throw new ContentQueryError(`The correlation name '${table}' is specified multiple times in a FROM clause.`);
    }
    if (entry === undefined || (entry.role !== 'implied' && entry.role !== 'tags')) {
      throw new ContentQueryError(`Invalid object name '${table}'.`);
    }
    seen.add(key);
    build.scope.add(key, entry.def);
    build.units.add(entry.def.unit);
    const on = (FEED_HIST_TABLES as readonly string[]).includes(entry.def.table) ? 'contenthistid' : 'contentid';
    return `INNER JOIN ${qualified(build.tx.schema, entry.def.table)} ${key} ON (tcontent.${on} = ${key}.${on})`;
  });
}

/**
 * feedGateway.getFeed for a local content feed: its content versions (or `{count}` with `countOnly`), before legacy's
 * permission filter, interval expansion and `displayStart` calendar re-sort, which the caller applies. Content-pool
 * sites are other tenants, so the caller runs this once per tenant of the site's registered content pool
 * (`contentPoolTenants`), each in its own `withTenant`, and merges with the legacy sort and `maxItems` after merging.
 * File columns are null where the site's file pool is another tenant; the caller fills them with `fileJoinColumns`.
 */
export function feedContent(tx: TenantTx, criteria: FeedQuery & { countOnly: true }): Promise<FeedCount>;
export function feedContent(
  tx: TenantTx,
  criteria: FeedCriteria & { countOnly?: false; fields?: undefined; aggregates?: undefined },
): Promise<FeedContentRow[]>;
export function feedContent(tx: TenantTx, criteria: FeedQuery & { countOnly?: false }): Promise<FeedProjectionRow[]>;
export function feedContent(tx: TenantTx, criteria: FeedQuery): Promise<FeedContentRow[] | FeedProjectionRow[] | FeedCount>;
export async function feedContent(tx: TenantTx, criteria: FeedQuery): Promise<FeedContentRow[] | FeedProjectionRow[] | FeedCount> {
  const altTable = criteria.altTable ?? '';
  if (altTable !== '' && altTable.toLowerCase() !== 'tcontent') {
    throw new ContentQueryError(`Feeds over the alternate table "${altTable}" are not served by this service`);
  }
  const countOnly = criteria.countOnly === true;
  const rows = criteria.advanced?.rows ?? [];
  const aggregates = criteria.aggregates ?? {};
  const tag = criteria.tag ?? '';
  const sortBy = criteria.sortBy ?? 'lastUpdate';
  const orderBy = criteria.orderBy ?? '';
  const joinTables = impliedJoinTables(rows, tag);
  if (Object.values(aggregates).some((references: readonly string[] | undefined) => (references ?? []).some(isDeniedFeedTable))) {
    throw new FeedAuthorizationError();
  }
  if (cfList(sortBy, '.').length > 1 && isDeniedFeedTable(sortBy)) {
    throw new FeedAuthorizationError();
  }
  const type = (criteria.type ?? 'local').toLowerCase();
  if (type === 'remote') {
    throw new ContentQueryError('This function is not available for remote feeds.');
  }
  if (!countOnly && (sortBy.toLowerCase() === 'mxprelevance' || (cfList(orderBy, ' ')[0] ?? '').toLowerCase() === 'mxprelevance')) {
    throw new ContentQueryError('The mxpRelevance sort reads the marketing plugin tables, which do not exist');
  }

  const pool = criteria.contentPoolSiteIds ?? [criteria.siteId];
  const build: FeedBuild = {
    tx,
    p: new SqlParams(),
    scope: new Scope(),
    units: new Set<ContentUnit>(),
    siteId: criteria.siteId,
    pool,
    // Only advanced params read criteria dates.
    parseDate: criteria.advanced?.parseDate ?? (() => null),
    inCategoryPool: criteria.categoryPool ?? ((fn) => fn(tx)),
    paramCategoryItems: [],
  };
  const { p, scope } = build;
  for (const alias of BASE_ALIASES) {
    const { def } = LEGACY_TABLES[alias];
    scope.add(alias, def);
    build.units.add(def.unit);
  }
  const q = (def: Def): string => qualified(tx.schema, def.table);
  const joins = [
    ...impliedJoins(build, joinTables),
    `LEFT JOIN ${q(FILE)} tfiles ON (tcontent.fileid = tfiles.fileid)`,
    `LEFT JOIN ${q(CONTENT_STATS)} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)`,
    `LEFT JOIN ${q(CONTENT)} tparent ON (tcontent.parentid = tparent.contentid AND tcontent.siteid = tparent.siteid AND tparent.active = 1)`,
    `LEFT JOIN ${q(FILE_METADATA)} tcontentfilemetadata ON (tcontent.fileid = tcontentfilemetadata.fileid` +
      ' AND tcontent.contenthistid = tcontentfilemetadata.contenthistid AND tcontent.siteid = tcontentfilemetadata.siteid)',
  ];

  const aggregate = aggregateOutputs(aggregates, scope);
  const fields = fieldOutputs(criteria.fields ?? [], scope);
  const defaults = (): ScopeColumn[] => FEED_SELECT.map(([alias, column, name]) => ({ ...scope.column(`${alias}.${column}`), name: name ?? column }));
  const outputs = fields ?? (aggregate.outputs.length > 0 ? aggregate.outputs : defaults());
  const aggregated = fields === undefined && aggregate.outputs.length > 0;

  let extended: ExtendedCastColumn | undefined;
  if (!countOnly && isExtendedSort(sortBy, FEED_SORT_OPTIONS)) {
    extended = await extendedCastColumn(tx, { siteId: criteria.siteId, attribute: sortBy });
    build.units.add(EXTEND_DATA.unit);
    build.units.add(EXTEND_ATTRIBUTE.unit);
    joins.push(
      `LEFT JOIN (SELECT tclassextenddata.${extended} AS extendedsort, tclassextenddata.baseid FROM ${q(EXTEND_DATA)} tclassextenddata` +
        ` INNER JOIN ${q(EXTEND_ATTRIBUTE)} tclassextendattributes ON (tclassextenddata.attributeid = tclassextendattributes.attributeid)` +
        ` WHERE tclassextendattributes.siteid = ANY(${p.add(pool)}::text[]) AND ${ciEq(p, 'tclassextendattributes.name', sortBy)}) qextendedsort` +
        ' ON (tcontent.contenthistid = qextendedsort.baseid)',
    );
  }

  const liveOnly = criteria.liveOnly ?? true;
  const intersect = criteria.useCategoryIntersect === true;
  const now = timespanInterval(criteria.today, criteria.cachedWithinSeconds ?? 0);
  // getFeed ignores its menuType argument: no menu-type window applies, only the liveOnly display window below.
  const where = [
    `tcontent.siteid = ANY(${p.add(pool)}::text[])`,
    p.include(activeClause('tcontent', criteria.preview, { liveOnly, activeOnly: criteria.activeOnly ?? true, offset: p.next })),
  ];
  if ((criteria.showNavOnly ?? true) && type !== 'form' && type !== 'component') {
    where.push('tcontent.isnav = 1');
  }
  where.push(moduleClause(type));
  if (criteria.showExcludeSearch !== true) {
    where.push('tcontent.searchexclude = 0');
  }
  if (criteria.includeHomePage !== true) {
    where.push(`tcontent.contentid <> '${HOME_PAGE_ID}'`);
  }
  where.push("lower(rtrim(tcontent.type)) <> 'module'");
  const group = await paramsGroup(build, rows);
  if (group !== undefined) {
    where.push(group);
  }
  if (tag !== '') {
    where.push(ciEq(p, 'tcontenttags.tag', tag));
  }
  const parents = criteria.contentIds ?? [];
  if (parents.length > 0) {
    where.push(idIn(p, 'tcontent.parentid', [...parents, '']));
  }
  if (criteria.categoryIds !== undefined) {
    where.push(categoryClause(build, criteria.categoryIds, intersect));
  }
  if (criteria.isFeaturesOnly === true) {
    where.push(await featuresClause(build, criteria, intersect, now));
  }
  if (liveOnly) {
    const calendar = criteria.from && criteria.to ? { from: criteria.from, to: criteria.to } : { from: now, to: addMonths(now, 12) };
    where.push(displayWindow(p, now, calendar.from, calendar.to), mobileClause('tcontent', criteria.mobile));
  }

  const distinct = criteria.distinct === true ? 'DISTINCT ' : '';
  const grouping = aggregate.groupBy.length > 0 ? ` GROUP BY ${aggregate.groupBy.map((column) => column.expr).join(', ')}` : '';
  const body = `FROM ${q(CONTENT)} tcontent ${joins.join(' ')} WHERE ${where.join(' AND ')}${grouping}`;
  if (countOnly) {
    await readable(tx, build.units);
    const counted = await run<{ count: number }>(tx, `SELECT ${distinct}count(*)::integer AS count ${body}`, p.values);
    return { count: counted[0]?.count ?? 0 };
  }

  const terms = orderTerms(criteria, scope, outputs, extended);
  const maxItems = criteria.maxItems ?? 20;
  if (maxItems !== 0 && (!Number.isInteger(maxItems) || maxItems < 0)) {
    throw new ContentQueryError(`The number of rows provided for a TOP clause must be a non-negative integer, not ${maxItems}.`);
  }
  const select = `SELECT ${distinct}${outputs.map((output) => `${output.expr} AS ${output.name}`).join(', ')} ${body}`;
  let sql: string;
  if (distinct !== '') {
    const keys = terms.map((term) => {
      const output = outputs.find((candidate) => candidate.expr === term.expr);
      if (term.type === 'random' || output === undefined) {
        throw new ContentQueryError('ORDER BY items must appear in the select list if SELECT DISTINCT is specified.');
      }
      return termSql({ ...term, expr: `d.${output.name}` });
    });
    sql = `SELECT * FROM (${select}) d${keys.length > 0 ? ` ORDER BY ${keys.join(', ')}` : ''}`;
  } else {
    // Ties keep the clustered (tcontent_id) order SQL Server scans in; grouped rows have no such column.
    const keys = [...terms.map(termSql), ...(aggregated || grouping !== '' ? [] : ['tcontent.tcontent_id'])];
    sql = `${select}${keys.length > 0 ? ` ORDER BY ${keys.join(', ')}` : ''}`;
  }
  if (maxItems > 0) {
    sql += ` LIMIT ${p.add(maxItems)}`;
  }
  await readable(tx, build.units);
  return run<FeedContentRow | FeedProjectionRow>(tx, sql, p.values) as Promise<FeedContentRow[] | FeedProjectionRow[]>;
}

