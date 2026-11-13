/** Port of the JSON API `site` feed: beanFeed over `tsettings`, setFeedProps, findQuery's url params and the query iterator. */
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  REGISTERED_ENTITIES,
  cfEq,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfParseDateTimeText,
  cfToBoolean,
  cfToNumber,
  esapiUrlEncode,
  isValidVariableName,
} from '@opt2/platform/legacy-compat';
import { acfStruct, type StructOp } from './acf-struct.js';
import { SITE_COLUMNS, targetNameFor, type SiteRow } from './site-fields.js';

/** A url scope as CFML holds it: names as sent, a repeated name's values joined with `,`. */
export type UrlScope = Readonly<Record<string, string>>;

/** transformParamType of a `tsettings` column (dbUtility.cfc:1509-1541). */
export type ColumnType = 'varchar' | 'numeric' | 'timestamp';

// legacy: core/setup/db/mssql.sql:370-433 and core/mura/dbUpdates (int and tinyint columns; datetime columns).
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(
  [
    'MaxNestLevel', 'PageLimit', 'EmailBroadcaster', 'Extranet', 'ExtranetPublicReg', 'ExtranetSSL', 'Cache', 'ViewDepth',
    'NextN', 'DataCollection', 'columnCount', 'primaryColumn', 'publicSubmission', 'orderNo', 'emailBroadcasterLimit',
    'feedManager', 'galleryMainScale', 'gallerySmallScale', 'galleryMediumScale', 'CommentApprovalDefault', 'deploy',
    'useDefaultSMTPServer', 'cacheCapacity', 'cacheFreeMemoryThreshold', 'hasChangesets', 'enforcePrimaryDomain',
    'enforceChangesets', 'hasComments', 'hasLockableNodes', 'JSONApi', 'useSSL', 'isremote', 'resourceSSL', 'remoteport',
    'showDashboard', 'scaffolding',
  ].map((name) => name.toLowerCase()),
);
const TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set(['archivedate', 'lastdeployment']);

/** The feed's base table, which only its own columns may be read from. */
const SITE_TABLE = 'tsettings';

/** The `tsettings` column `name` names, ignoring case, and its param type; undefined for any other name. */
export function siteColumn(name: string): { column: string; type: ColumnType } | undefined {
  const column = targetNameFor(name);
  if (column === undefined) return undefined;
  const type: ColumnType = NUMERIC_COLUMNS.has(column) ? 'numeric' : TIMESTAMP_COLUMNS.has(column) ? 'timestamp' : 'varchar';
  return { column, type };
}

/** A failure processRequest's `catch (Any e)` answers with `server_error`. */
export function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/** A feed clause whose rows are another table's or another owner's, answered with the legacy-shaped 503. */
export function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** SQL three-valued logic: NULL comparisons are unknown. */
type Truth = boolean | null;

/** One WHERE token beanFeed.getQuery writes (beanFeed.cfc:983-1061). */
type Token = 'and' | 'or' | 'not' | '(' | ')' | { test: (row: SiteRow) => Truth };

/** A column param as addParam stores it; the query binds it when it runs. */
interface ColumnParam {
  field: string;
  datatype: ColumnType;
  condition: string;
  criteria: string;
}

/** One `queryParam` of the feed: a grouping relationship, or a column param joined by `relationship`. */
interface FeedParam {
  relationship: string;
  column?: ColumnParam;
}

/** The beanFeed state a `site` feed builds (beanFeed.cfc:100-125). */
export interface SiteFeed {
  /** `siteID`: the site the feed was taken from. */
  siteId: string;
  /** `contentPoolID`: '' reads the feed's site, `*` its content pool, else the listed sites. */
  contentPool: string;
  sortBy: string;
  sortDirection: string;
  orderBy: string;
  maxItems: number;
  nextN: number;
  /** Selected `tsettings` columns; empty selects every column. */
  fields: string[];
  distinct: boolean;
  params: FeedParam[];
}

/** `$.getBean('site').getFeed()` for the scope site. */
export function newSiteFeed(siteId: string): SiteFeed {
  return { siteId, contentPool: '', sortBy: '', sortDirection: 'asc', orderBy: '', maxItems: 0, nextN: 1000, fields: [], distinct: false, params: [] };
}

/** CFML `listFindNoCase` over an array. */
function listHasNoCase(list: readonly string[], item: string): boolean {
  return list.some((entry) => entry.toLowerCase() === item.toLowerCase());
}

/** `listFirst` with `delim`: the first non-empty element, or `''`. */
function cfListFirst(list: string, delim: string): string {
  return list.split(delim).find((item) => item !== '') ?? '';
}

/** The url value of `name`, ignoring case. */
export function urlValue(url: UrlScope, name: string): string | undefined {
  if (Object.hasOwn(url, name)) return url[name];
  const key = Object.keys(url).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : url[key];
}

/** CFML `urlDecode`: `+` is a space and `%XX` runs are UTF-8; a `%` that starts no escape, or bytes that are not UTF-8, stay as sent. */
export function cfUrlDecode(text: string): string {
  return text.replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** SQL Server's case-insensitive, trailing-space-insensitive text comparison under its default collation. */
function compareText(a: string, b: string): number {
  return a.replace(/ +$/, '').localeCompare(b.replace(/ +$/, ''), 'en', { sensitivity: 'accent' });
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

/** A criteria as `lsIsDate`/`isDate` and their parsers read it; undefined when not a date. */
function criteriaDate(text: string): Date | undefined {
  try {
    if (cfLsIsDate(text)) return cfLsParseDateTime(text);
    if (cfIsDateText(text)) return cfParseDateTimeText(text);
  } catch {
    return undefined;
  }
  return undefined;
}

/** One bound value of a criteria under `type`; undefined for text the cfqueryparam type refuses, which fails the SQL. */
function boundValue(text: string, type: ColumnType): string | number | Date | undefined {
  if (type === 'varchar') return text;
  if (type === 'numeric') return cfIsNumeric(text) ? cfToNumber(text) : undefined;
  return criteriaDate(text);
}

/** queryParam `setCriteria` of varchar text: begins, ends and contains conditions wrap it in `%` (queryParam.cfc:213-245). */
function likeCriteria(criteria: string, condition: string): string {
  const name = condition.toLowerCase();
  if (name === 'begins' || name === 'beginswith') return `${criteria}%`;
  if (name === 'ends' || name === 'endswith') return `%${criteria}`;
  if (name === 'contains' || name === 'containsvalue' || name === 'like') return `%${criteria}%`;
  return criteria;
}

/** Compares a stored column value with a bound value under `type`; undefined when SQL could not compare them. */
function compareColumn(value: unknown, bound: string | number | Date, type: ColumnType): number | undefined {
  if (type === 'numeric') {
    const left = typeof value === 'number' ? value : Number(value);
    const right = typeof bound === 'number' ? bound : Number(bound);
    return Number.isNaN(left) || Number.isNaN(right) ? undefined : left - right;
  }
  if (type === 'timestamp') {
    return value instanceof Date && bound instanceof Date ? value.getTime() - bound.getTime() : undefined;
  }
  return compareText(String(value), String(bound));
}

/** Whether `order` satisfies the comparison `sql`. */
function holds(sql: string, order: number): boolean {
  if (sql === '=') return order === 0;
  if (sql === '!=') return order !== 0;
  if (sql === '>') return order > 0;
  if (sql === '>=') return order >= 0;
  if (sql === '<') return order < 0;
  return order <= 0;
}

/** The stored value of `column`; SQL NULL as null. */
function cell(row: SiteRow, column: string): unknown {
  const value = row[column];
  return value === undefined ? null : value;
}

// legacy: core/mura/configBean.cfc:162 (deniedFeedJoinTables; the feed's own table stays allowed)
const DENIED_FEED_TABLES: readonly string[] = Object.freeze([
  'tusers', 'tusersmemb', 'tusergroups', 'tusersession', 'toauthtokens', 'tremembertokens', 'tpermissions', 'tsessiontracking',
  'tredirects', 'toauthclients', 'tuserremotesessions', 'tuserdevice',
]);

/** `utility.isDeniedFeedTable(reference, 'tsettings')`: the reference's table is on the denied list (utility.cfc:338-346). */
function deniedTable(reference: string): boolean {
  const table = cfListFirst(reference, '.').replace(/[^0-9A-Za-z_]/g, '');
  return !cfEq(table, SITE_TABLE) && listHasNoCase(DENIED_FEED_TABLES, table);
}

/** getQuery's restricted-table checks, which answer `authorization` before the query runs (beanFeed.cfc:843-870). */
function assertNoDeniedTable(feed: SiteFeed): void {
  const denied =
    feed.params.some(({ column }) => column !== undefined && cfListToArray(column.field, '.').length === 2 && deniedTable(column.field)) ||
    cfListToArray(feed.orderBy).some((item) => deniedTable(cfListFirst(item.trim(), ' '))) ||
    (cfListToArray(feed.sortBy, '.').length > 1 && deniedTable(feed.sortBy));
  if (denied) throw new LegacyApiError('authorization');
}

/** The `tsettings` column a param field or an ORDER BY item names, else 'unknown', which fails the SQL (beanFeed.cfc:843-852). */
function qualifiedColumn(reference: string): { column: string; type: ColumnType } | 'unknown' {
  const parts = cfListToArray(reference, '.');
  if (parts.length <= 1) return siteColumn(parts[0] ?? '') ?? 'unknown';
  if (parts.length > 2) throw unavailable(`A site feed reference to ${reference} names a multi-part identifier`, 'site-feed-identifier');
  if (cfEq((parts[0] ?? '').replace(/[^0-9A-Za-z_]/g, ''), SITE_TABLE)) return siteColumn(parts[1] ?? '') ?? 'unknown';
  // A param on another table joins it on the site entity's blank key fields, `on (tsettings.=t.)`, and an ORDER BY
  // item names a table the query never joined: either fails the SQL.
  return 'unknown';
}

/** A criteria `entity.column` or `table.column` beanFeed writes as a column reference instead of a bound value (beanFeed.cfc:1034-1050). */
function criteriaColumn(criteria: string): { column: string; type: ColumnType } | undefined {
  const parts = cfListToArray(criteria, '.');
  if (parts.length !== 2) return undefined;
  const [first = '', second = ''] = parts;
  if (cfEq(first, 'site')) return siteColumn(second);
  if (cfEq(first, SITE_TABLE)) {
    const column = siteColumn(second.replace(/[^0-9A-Za-z._,\-*]/g, ''));
    // The unqualified reference names no column, which fails the SQL.
    if (column === undefined) throw serverError();
    return column;
  }
  if (listHasNoCase(REGISTERED_ENTITIES, first)) {
    throw unavailable(`A site feed criteria ${criteria} may name another entity's column`, 'site-feed-join');
  }
  return undefined;
}

/** One `queryParam` as beanFeed.getQuery binds it (queryParam.cfc:60-360; beanFeed.cfc:1022-1060). */
function columnTest({ field, datatype, condition, criteria }: ColumnParam): (row: SiteRow) => Truth {
  const resolved = qualifiedColumn(field);
  // A name no column holds fails the SQL when the query runs.
  if (resolved === 'unknown') throw serverError();
  const { column } = resolved;
  const sql = sqlCondition(condition, datatype);
  if (sql === '') throw serverError();
  if (criteria.toLowerCase() === 'null') {
    // getCondition() writes `is` or `is not` for a NULL criteria and nothing for any other condition.
    if (sql === '=') return (row) => cell(row, column) === null;
    if (sql === '!=') return (row) => cell(row, column) !== null;
    throw serverError();
  }
  const listed = sql === 'in' || sql === 'not in';
  // setCriteria keeps numeric or date text only when the whole criteria is one, else it binds '' (queryParam.cfc:244-305).
  if (datatype !== 'varchar' && boundValue(criteria, datatype) === undefined) {
    // cfqueryparam refuses '' for these types except as a list: a numeric one binds 0, and an empty timestamp list
    // matches no NULL cell; how it compares with a stored date is not reproduced.
    if (!listed) throw serverError();
    return (row) => {
      const value = cell(row, column);
      if (value === null) return null;
      if (datatype === 'timestamp') throw unavailable(`The ${field} list binds an empty timestamp`, 'site-feed-conversion');
      const member = compareColumn(value, 0, datatype) === 0;
      return sql === 'in' ? member : !member;
    };
  }
  const text = datatype === 'varchar' ? likeCriteria(criteria, condition) : criteria;
  const reference = criteriaColumn(text);
  if (reference !== undefined) {
    // A column reference carries no list parentheses, and columns of different types are not compared here.
    if (listed) throw serverError();
    if (reference.type !== resolved.type) {
      throw unavailable(`Comparing ${field} with ${criteria} converts between column types`, 'site-feed-conversion');
    }
    return (row) => {
      const left = cell(row, column);
      const right = cell(row, reference.column);
      if (left === null || right === null) return null;
      if (sql === 'like') return likePattern(String(right)).test(String(left));
      const order = compareColumn(left, right as string | number | Date, resolved.type);
      return order === undefined ? null : holds(sql, order);
    };
  }
  if (listed) {
    // cfqueryparam list="true" binds each comma-separated item.
    const items = (text === '' ? [''] : cfListToArray(text)).map((item) => boundValue(item, datatype));
    if (items.some((item) => item === undefined)) throw serverError();
    return (row) => {
      const value = cell(row, column);
      if (value === null) return null;
      const member = items.some((item) => compareColumn(value, item as string | number | Date, datatype) === 0);
      return sql === 'in' ? member : !member;
    };
  }
  const bound = boundValue(text, datatype);
  // init's validate() marks the param valid again, so criteria its type cannot hold binds '' and fails the SQL.
  if (bound === undefined) throw serverError();
  if (sql === 'like') {
    const pattern = likePattern(String(bound));
    return (row) => {
      const value = cell(row, column);
      return value === null ? null : pattern.test(String(value));
    };
  }
  return (row) => {
    const value = cell(row, column);
    if (value === null) return null;
    const order = compareColumn(value, bound, datatype);
    return order === undefined ? null : holds(sql, order);
  };
}

/** Names beanFeed.addParam hands to a setter instead of adding a param; of those a site query reads, only `nextN` and `orderBy` reach here (beanFeed.cfc:315-318). */
const FEED_SETTERS: readonly string[] = Object.freeze([
  'advancedparams', 'configbean', 'distinct', 'entityname', 'fields', 'itemsperpage', 'maxitems', 'nextn', 'orderby', 'params',
  'sort', 'sortdirection', 'addedobjectvalues', 'allvalues', 'errors', 'propasidcolumn', 'validations', 'value', 'lastupdateby',
]);

/** Setters that dereference their url text as a struct or call it as the config bean, which fails (beanFeed.cfc:260-280; bean.cfc). */
const FAILING_SETTERS: readonly string[] = Object.freeze(['params', 'allvalues', 'configbean']);

/** queryParam `setRelationship`: only these relationships are kept (queryParam.cfc:111-116). */
const RELATIONSHIPS: readonly string[] = Object.freeze(['or', 'and']);
const GROUP_RELATIONSHIPS: readonly string[] = Object.freeze([
  '(', 'and (', 'or (', ')', 'and not (', 'or not (', 'openGrouping', 'orOpenGrouping', 'andOpenGrouping', 'closeGrouping',
]);

/** beanFeed.addParam of one param: a feed setter, a grouping, or a `tsettings` column param (beanFeed.cfc:301-345). */
export function addFeedParam(feed: SiteFeed, rawField: string, criteria: string, condition = 'EQUALS', relationship = 'and'): void {
  const field = rawField.replace(/[^0-9A-Za-z._,\-*]/g, '');
  const setter = field.toLowerCase();
  if (isValidVariableName(field) && FEED_SETTERS.includes(setter)) {
    if (FAILING_SETTERS.includes(setter)) throw serverError();
    if (setter === 'nextn' && cfIsNumeric(criteria)) feed.nextN = cfToNumber(criteria);
    else if (setter === 'orderby') feed.orderBy = criteria;
    return;
  }
  const grouping = listHasNoCase(GROUP_RELATIONSHIPS, relationship);
  const kept = grouping || listHasNoCase(RELATIONSHIPS, relationship) ? relationship : '';
  // queryParam.setField keeps word characters and dots; an empty field is valid only as a grouping (queryParam.cfc:117-130,342-350).
  const column = field.replace(/[^\w.]+/g, '');
  if (column === '') {
    if (grouping) feed.params.push({ relationship: kept });
    return;
  }
  const datatype = siteColumn(cfListToArray(field, '.').at(-1) ?? '')?.type ?? 'varchar';
  feed.params.push({ relationship: kept, column: { field: column, datatype, condition, criteria } });
}

/** setFields: the listed names a `tsettings` column holds, trimmed, as target column names (beanFeed.cfc:201-213). */
function selectedColumns(fields: string): string[] {
  return cfListToArray(fields).flatMap((name) => {
    const column = siteColumn(name.trim());
    return column === undefined ? [] : [column.column];
  });
}

/** Names findQuery never turns into a feed param (jsonApiUtility.cfc:2850). */
const QUERY_EXCLUDED: readonly string[] = Object.freeze([
  'expanddepth', 'expand', 'muraPointInTime', 'liveOnly', 'feedid', 'cacheid', '_cacheid', 'distinct', 'fields', 'entityname',
  'method', 'maxItems', 'pageIndex', 'itemsPerPage', 'sortBy', 'sortDirection', 'contentpoolid', 'shownavonly', 'showexcludesearch',
  'includehomepage', 'feedname', 'useCategoryIntersect', 'useDataNamespace',
]);

const GROUPING_NAMES: readonly string[] = Object.freeze(['openGrouping', 'orOpenGrouping', 'andOpenGrouping', 'closeGrouping']);
const AGGREGATE_NAMES: readonly string[] = Object.freeze(['sum', 'avg', 'count', 'max', 'min', 'groupBy']);

/** Joins of a related entity among the site's has-one and has-many properties, of which it has none, so they add nothing (beanFeed.cfc:652-686). */
const RELATED_JOINS: readonly string[] = Object.freeze(['innerJoin', 'leftJoin']);

/** The pool request setFeedProps reads from `contentpoolid`, before getContentPoolID resolves it. */
export interface PoolRequest {
  /** The API site's own `contentPoolID` setting, which bounds an explicit list. */
  readonly validPools: string;
}

/** `setFeedProps(feed, params)` as a `site` feed reads it (jsonApiUtility.cfc:2955-3157). */
export function applyFeedProps(feed: SiteFeed, params: UrlScope, pools: PoolRequest): void {
  const text = (name: string): string => urlValue(params, name) ?? '';
  let sort = '';
  if (text('orderby') !== '') sort = text('orderby');
  if (text('sort') !== '') sort = text('sort');
  const pool = text('contentpoolid');
  if (pool !== '') {
    if (pool === '*') feed.contentPool = '*';
    else {
      const valid = cfListToArray(pools.validPools);
      const requested = cfListToArray(pool).filter((siteId) => listHasNoCase(valid, siteId));
      if (requested.length > 0) feed.contentPool = requested.join(',');
    }
  }
  if (sort !== '') {
    feed.orderBy = cfListToArray(sort)
      .map((item) => {
        if (item.length <= 1) return item;
        const prefix = item.charAt(0);
        const signed = prefix === '+' || prefix === '-';
        let prop = signed ? item.slice(1) : item;
        if (cfListToArray(prop, '.').length === 1) prop = `${SITE_TABLE}.${prop}`;
        return `${prop} ${prefix === '-' ? 'desc' : 'asc'}`;
      })
      .join(',');
  }
  const sortDirection = text('sortdirection');
  if (sortDirection !== '' && listHasNoCase(['desc', 'asc'], sortDirection)) feed.sortDirection = sortDirection;
  const sortBy = text('sortby');
  // bean.setValue trims a simple value.
  if (sortBy !== '') feed.sortBy = sortBy.trim();
  const distinct = urlValue(params, 'distinct');
  if (distinct !== undefined && cfIsBoolean(distinct)) feed.distinct = cfToBoolean(distinct);
  const fields = text('fields');
  if (fields !== '') feed.fields = selectedColumns(listHasNoCase(cfListToArray(fields), 'siteid') ? fields : `${fields},siteid`);
  const maxItems = urlValue(params, 'maxitems');
  if (maxItems !== undefined) {
    if (cfIsNumeric(maxItems)) feed.maxItems = cfToNumber(maxItems);
    else if (maxItems === '*') feed.maxItems = 0;
  }
  for (const name of ['size', 'limit']) {
    const value = urlValue(params, name);
    if (value !== undefined && cfIsNumeric(value)) feed.maxItems = cfToNumber(value);
  }
}

/** findQuery's feed params and base URL, built from `cgi.QUERY_STRING` in order (jsonApiUtility.cfc:2729-2905). */
export function applyQueryParams(feed: SiteFeed, url: UrlScope, queryString: string, endpoint: string): { url: UrlScope; baseUrl: string } {
  const scope: Record<string, string> = { ...url };
  let baseUrl = `${endpoint}/site/?`;
  let started = false;
  let relationship = 'and';
  let advancedSort = '';
  const names = cfListToArray(queryString, '&')
    .map((item) => cfUrlDecode(cfListFirst(item, '=')))
    .filter((name) => !cfEq(name, 'pageIndex'));
  for (const name of names) {
    const propName = name.includes('[') ? cfListFirst(name, '[') : name;
    // A changeset filter calls setActiveOnly, which the generic feed does not define.
    if (cfEq(propName, 'changesetid')) throw serverError();
    const value = urlValue(scope, name);
    if (value === undefined) continue;
    baseUrl += `${started ? '&' : ''}${esapiUrlEncode(name)}`;
    started = true;
    if (value !== '') baseUrl += `=${esapiUrlEncode(value)}`;
    if (!listHasNoCase(QUERY_EXCLUDED, propName) && !listHasNoCase(RELATED_JOINS, propName)) {
      if (cfEq(propName, 'sort')) {
        advancedSort = advancedSort === '' ? value : `${advancedSort},${value}`;
      } else if (cfEq(propName, 'or')) {
        relationship = 'or';
      } else if (listHasNoCase(GROUPING_NAMES, propName)) {
        addFeedParam(feed, '', '', 'EQUALS', name);
        relationship = 'and';
      } else if (listHasNoCase(AGGREGATE_NAMES, propName)) {
        throw unavailable(`The ${propName} feed clause selects generic aggregate beans`, 'site-feed-aggregate');
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
        addFeedParam(feed, cfEq(propName, 'id') ? 'siteid' : propName, criteria, condition, relationship);
        relationship = 'and';
      }
    }
    if (advancedSort !== '') scope[Object.keys(scope).find((key) => cfEq(key, 'sort')) ?? 'sort'] = advancedSort;
  }
  return { url: scope, baseUrl };
}

/** Parses WHERE tokens with SQL precedence (NOT, AND, OR); a malformed clause fails the SQL. */
function evaluate(tokens: readonly Token[], row: SiteRow): Truth {
  let at = 0;
  const and3 = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === null || b === null ? null : true);
  const or3 = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === null || b === null ? null : false);
  const primary = (): Truth => {
    const token = tokens[at];
    at += 1;
    if (token === 'not') {
      const value = primary();
      return value === null ? null : !value;
    }
    if (token === '(') {
      const value = disjunction();
      if (tokens[at] !== ')') throw serverError();
      at += 1;
      return value;
    }
    if (typeof token === 'object') return token.test(row);
    throw serverError();
  };
  const conjunction = (): Truth => {
    let value = primary();
    while (tokens[at] === 'and') {
      at += 1;
      value = and3(value, primary());
    }
    return value;
  };
  const disjunction = (): Truth => {
    let value = conjunction();
    while (tokens[at] === 'or') {
      at += 1;
      value = or3(value, conjunction());
    }
    return value;
  };
  const value = disjunction();
  if (at !== tokens.length) throw serverError();
  return value;
}

/** The WHERE clause after `siteID in (…)` that beanFeed.getQuery writes from the params, each bound as it is written (beanFeed.cfc:983-1061). */
function whereTokens(params: readonly FeedParam[]): Token[] {
  // The pool condition the clause follows; the rows read are already the pool's.
  const tokens: Token[] = [{ test: () => true }];
  let started = false;
  let openGrouping = false;
  const is = (relationship: string, ...names: string[]): boolean => listHasNoCase(names, relationship);
  for (const { relationship, column } of params) {
    const test = column === undefined ? undefined : columnTest(column);
    if (!started) {
      openGrouping = true;
      tokens.push('and', '(');
    }
    if (is(relationship, 'openGrouping', '(')) {
      if (!openGrouping) tokens.push('and');
      tokens.push('(');
      openGrouping = true;
    } else if (is(relationship, 'orOpenGrouping', 'or (')) {
      if (!openGrouping) tokens.push('or');
      tokens.push('(');
      openGrouping = true;
    } else if (is(relationship, 'andOpenGrouping', 'and (')) {
      if (!openGrouping) tokens.push('and');
      tokens.push('(');
      openGrouping = true;
    } else if (is(relationship, 'and not (')) {
      if (!openGrouping) tokens.push('and');
      tokens.push('not', '(');
      openGrouping = true;
    } else if (is(relationship, 'or not (')) {
      if (!openGrouping) tokens.push('or');
      tokens.push('not', '(');
      openGrouping = true;
    } else if (is(relationship, 'closeGrouping', ')')) {
      tokens.push(')');
      openGrouping = false;
    } else if (!openGrouping && relationship !== '') {
      tokens.push(relationship.toLowerCase() === 'or' ? 'or' : 'and');
    }
    started = true;
    if (test !== undefined) {
      tokens.push({ test });
      openGrouping = false;
    }
  }
  if (started) tokens.push(')');
  return tokens;
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

/** The ORDER BY beanFeed.getQuery writes: `orderby`, else `sortBy` and `sortDirection` (beanFeed.cfc:1081-1099). */
function sortKeysOf(feed: SiteFeed): SortKey[] {
  const keyOf = (field: string, desc: boolean): SortKey => {
    const resolved = qualifiedColumn(field);
    if (resolved === 'unknown') throw serverError();
    return { ...resolved, desc };
  };
  if (feed.orderBy.trim() !== '') return validatedSort(feed.orderBy).map(({ field, desc }) => keyOf(field, desc));
  if (feed.sortBy === '') return [];
  const fields = cfListToArray(feed.sortBy).map((field) => field.trim());
  // `tsettings.` prefixes the first field, so a dotted one names a three-part identifier.
  if (fields.some((field) => !/^[a-zA-Z0-9_.]+$/.test(field)) || (fields[0] ?? '').includes('.')) throw serverError();
  // setSortDirection keeps only asc and desc.
  const desc = feed.sortDirection.toLowerCase() === 'desc';
  return fields.map((field, i) => keyOf(field, i === fields.length - 1 && desc));
}

/** SQL Server ORDER BY of the keys: NULLs first ascending, last descending. */
function compareRows(keys: readonly SortKey[], a: SiteRow, b: SiteRow): number {
  for (const { column, type, desc } of keys) {
    const left = cell(a, column);
    const right = cell(b, column);
    let order = 0;
    if (left === null || right === null) order = left === right ? 0 : left === null ? -1 : 1;
    else order = compareColumn(left, right as string | number | Date, type) ?? 0;
    if (order !== 0) return desc ? -order : order;
  }
  return 0;
}

/** Stored rows the feed reads: the sites a `siteID in (…)` list names, and a site's `contentPoolID` setting. */
export interface FeedSource {
  /** Stored rows of the listed site ids, each at most once. */
  rows(siteIds: readonly string[]): Promise<SiteRow[]>;
  /** The `contentPoolID` setting getSite(siteId) returns; undefined for a site that is not registered. */
  contentPool(siteId: string): Promise<string | undefined>;
}

/** getContentPoolID (beanFeed.cfc:153-160): the feed's site, its content pool for `*`, else the set list. */
async function poolSiteIds(feed: SiteFeed, source: FeedSource): Promise<string[]> {
  if (feed.contentPool === '') return [feed.siteId];
  if (feed.contentPool === '*') return cfListToArray((await source.contentPool(feed.siteId)) ?? '');
  return cfListToArray(feed.contentPool);
}

/** The rows the feed's query selects, in order, before TOP; `countOnly` skips the ORDER BY as the count query does. */
export async function feedRows(feed: SiteFeed, source: FeedSource, countOnly = false): Promise<SiteRow[]> {
  assertNoDeniedTable(feed);
  const tokens = whereTokens(feed.params);
  const keys = countOnly ? [] : sortKeysOf(feed);
  // A malformed clause fails the SQL whatever rows the pool holds.
  evaluate(tokens, {});
  const rows = (await source.rows(await poolSiteIds(feed, source))).filter((row) => evaluate(tokens, row) === true);
  // The clustered key order SQL Server returns ties in.
  const clustered = [...rows].sort((a, b) => compareText(String(a.siteid), String(b.siteid)));
  return countOnly ? clustered : clustered.sort((a, b) => compareRows(keys, a, b));
}

/** The `TOP maxItems` of the selected rows; MSSQL refuses a negative or fractional TOP. */
export function topRows(feed: SiteFeed, rows: SiteRow[]): SiteRow[] {
  if (feed.maxItems === 0) return rows;
  if (!Number.isInteger(feed.maxItems) || feed.maxItems < 0) throw serverError();
  return rows.slice(0, feed.maxItems);
}

/** A query row as the iterator reads it: the selected `tsettings` columns, NULL as ''. */
export function queryRow(feed: SiteFeed, row: SiteRow | undefined): Record<string, unknown> {
  const columns = feed.fields.length > 0 ? feed.fields : SITE_COLUMNS.map(({ targetName }) => targetName);
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column] = row === undefined ? '' : (row[column] ?? '');
  return out;
}

/** The page the iterator yields: `setQuery`, then `setIteratorProps` (jsonApiUtility.cfc:3160-3182; queryIterator.cfc:100-250). */
export interface IteratorPage {
  count: number;
  maxRecordsPerPage: number;
  pageIndex: number;
  /** One-based record indexes of the page; one outside 1..count reads a blank row. */
  positions: number[];
}

/** The iterator's page over `count` rows with `nextN` per page, after the url's itemsPerPage, pageIndex and startIndex. */
export function iteratorPage(count: number, nextN: number, url: UrlScope): IteratorPage {
  let max = nextN !== 0 && Number.isFinite(nextN) ? nextN : count;
  let pageIndex = 1;
  let recordIndex = 0;
  const setPage = (page: number): void => {
    // A CFML number has no negative zero.
    pageIndex = page + 0;
    recordIndex = (pageIndex - 1) * max;
    if (recordIndex > count) {
      recordIndex = 0;
      pageIndex = 1;
    }
  };
  const itemsPerPage = urlValue(url, 'itemsperpage');
  if (itemsPerPage !== undefined && cfIsNumeric(itemsPerPage)) {
    const n = cfToNumber(itemsPerPage);
    max = n !== 0 ? n : count;
  } else if (itemsPerPage === '*') max = count;
  const page = urlValue(url, 'pageindex');
  if (page !== undefined && cfIsNumeric(page)) setPage(cfToNumber(page));
  const start = urlValue(url, 'startindex');
  if (start !== undefined && cfIsNumeric(start)) {
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
    positions.push(recordIndex);
  }
  return { count, maxRecordsPerPage: max, pageIndex, positions };
}

/** The query row at one-based `position`, which ColdFusion reads at its integer part; a row outside the query is blank. */
export function rowAt(rows: readonly SiteRow[], position: number): SiteRow | undefined {
  const index = Math.trunc(position);
  return index >= 1 && index <= rows.length ? rows[index - 1] : undefined;
}

const AGGREGATE_KEYS: readonly string[] = Object.freeze(['sum', 'avg', 'count', 'max', 'min', 'groupBy', 'distinct']);

/** isAggregateQuery (jsonApiUtility.cfc:4981-4997): no `fields`, and an aggregate or `distinct` url key or `=<key>[` query text. */
export function isAggregateQuery(url: UrlScope, queryString: string): boolean {
  if ((urlValue(url, 'fields') ?? '') !== '') return false;
  return AGGREGATE_KEYS.some((key) => urlValue(url, key) !== undefined || queryString.includes(`=${key}[`));
}

/** packageIteratorArray (jsonApiUtility.cfc:287-366): the page's counts, items and links in ColdFusion struct order. */
export function packagePage(
  page: IteratorPage,
  items: unknown[],
  a: { aggregate: boolean; iteratorEntity: 'site' | 'bean'; endpoint: string; baseUrl: string },
): Record<string, unknown> {
  const { count, maxRecordsPerPage: max, pageIndex } = page;
  const first = (pageIndex - 1) * max;
  const totalPages = count > 0 ? Math.ceil(count / max) : 0;
  const values: Record<string, unknown> =
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
  values.entityname = a.aggregate ? 'bean' : a.iteratorEntity;
  const index = values.pageIndex as number;
  const nextIndex = index < totalPages ? index + 1 : 1;
  const prevIndex = index > 1 ? index - 1 : totalPages;
  const links: Record<string, unknown> = { self: `${a.baseUrl}&pageIndex=${index}`, entities: a.endpoint };
  if (a.iteratorEntity !== 'bean') {
    links.properties = `${a.endpoint}/${a.iteratorEntity}/properties`;
    links.permissions = `${a.endpoint}/${a.iteratorEntity}/permissions`;
  }
  if (index > 1) {
    links.first = `${a.baseUrl}&pageIndex=1`;
    links.previous = `${a.baseUrl}&pageIndex=${prevIndex}`;
  }
  if (totalPages > 1) links.last = `${a.baseUrl}&pageIndex=${totalPages}`;
  if (index < totalPages) links.next = `${a.baseUrl}&pageIndex=${nextIndex}`;
  values.links = acfStruct(links);
  return acfStruct(values);
}

/** packageIteratorArray's own base URL: url then form values, `pageIndex` left out, an undefined method reported as `operation`. */
export function scopeBaseUrl(endpoint: string, url: UrlScope, form: Readonly<Record<string, string>>, operation: string): string {
  const merged: Record<string, string> = {};
  const ops: StructOp[] = [];
  const put = (key: string, value: string): void => {
    const existing = Object.keys(merged).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existing === undefined) ops.push(['set', key]);
    merged[existing ?? key] = value;
  };
  for (const [key, value] of Object.entries(url)) put(key, value);
  for (const [key, value] of Object.entries(form)) put(key, value);
  const method = urlValue(merged, 'method');
  if (method === undefined || method === 'undefined') put('method', operation);
  let baseUrl = `${endpoint}/?`;
  for (const key of Object.keys(acfStruct(merged, ops))) {
    if (!cfEq(key, 'pageIndex')) baseUrl += `&${key.toLowerCase()}=${merged[key] ?? ''}`;
  }
  return baseUrl;
}
