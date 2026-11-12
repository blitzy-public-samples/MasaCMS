// Masa user lists, search and advanced search (userGateway getUsers/getSearch/getAdvancedSearch with queryParam and
// userFeedBean) over people's rows joined with identity's account columns, plus the cusers nextN paging.
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  cfEq,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfTimestampParam,
  cfToBoolean,
  cfToNumber,
  javaTrim,
  legacyQuery,
  type LegacyQuery,
} from '@opt2/platform/legacy-compat';
import { qualified } from '@opt2/platform/migration-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantIdForSite,
  type QueryResultRow,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';
import type { UserClaims } from '@opt2/platform/auth';
import type { AccountView, IdentityClient } from '../legacy/identity-client.js';
import type { PeopleRepository } from '../repo/repository.js';
import { ADDRESS, FAVORITE, INTEREST, PERSON, TAG, type ExtendAttributeRow, type ExtendDataRow, type PersonRow } from '../repo/tables.js';
import { castColumnFor, EXTEND_CONFIG_DEFAULTS, type ExtendConfig } from './extended-data.js';

/** Columns of getSearch and getAdvancedSearch, in userGateway's `fieldList` order [legacy: core/mura/user/userGateway.cfc:82]. */
export const SEARCH_FIELD_LIST = [
  'userID', 'GroupName', 'Fname', 'Lname', 'UserName', 'PasswordCreated', 'Email', 'Company', 'JobTitle', 'MobilePhone',
  'Website', 'Type', 'subType', 'ContactForm', 'S2', 'LastLogin', 'LastUpdate', 'LastUpdateBy', 'LastUpdateByID', 'Perm',
  'InActive', 'IsPublic', 'SiteID', 'Subscribe', 'Notes', 'description', 'Interests', 'keepPrivate', 'PhotoFileID', 'IMName',
  'IMService', 'Created', 'RemoteID', 'Tags', 'tablist', 'photoFileExt',
] as const;

/** Columns of getUsers [legacy: core/mura/user/userGateway.cfc:690]. */
export const USERS_LIST_COLUMNS = [
  'UserID', 'GroupName', 'Fname', 'Lname', 'UserName', 'Email', 'Type', 'subType', 'Admin', 'S2', 'LastUpdate', 'LastUpdateBy',
  'isPublic', 'SiteID',
] as const;

/** getSearch's `maxrows` on SQL Server [legacy: core/mura/user/userGateway.cfc:129]. */
export const SEARCH_MAX_ROWS = 2100;

// Legacy spells isPublic as isPubic here, so a sort by isPublic is an extended sort and one by isPubic an invalid column.
/** getAdvancedSearch's built-in sort columns [legacy: core/mura/user/userGateway.cfc:181]. */
export const SORT_OPTIONS = 'fname,lname,username,company,lastupdate,created,isPubic,email';

/** configBean `deniedFeedJoinTables` [legacy: core/mura/configBean.cfc:162]; the feed's own `tusers` stays allowed. */
export const DENIED_FEED_JOIN_TABLES =
  'tusers,tusersmemb,tusergroups,tsettings,tusersession,toauthtokens,tremembertokens,tpermissions,tsessiontracking,tredirects,toauthclients,tuserremotesessions,tuserdevice';

/** Who runs a read: tenant and site from verified claims; a viewer without S2 never sees S2 users. */
export interface ViewerScope {
  tid: string;
  site: string;
  isS2: boolean;
  /** Legacy `session.mura.memberships`, when the caller holds it. */
  memberships?: string;
}

/** The viewer of verified user claims. */
export function viewerScope(claims: Pick<UserClaims, 'tid' | 'site' | 's2'>): ViewerScope {
  return { tid: claims.tid, site: claims.site, isS2: claims.s2 };
}

/** Collaborators of the reads; without `photoFileExts` (strategies-content's photo lookup) every `photoFileExt` is ''. */
export interface SearchDeps {
  db: TenantDb;
  repo: PeopleRepository;
  identity: Pick<IdentityClient, 'readAccounts' | 'membershipGroupIds'>;
  photoFileExts?: (fileIds: readonly (string | null | undefined)[]) => Promise<ReadonlyMap<string, string>>;
  extendConfig?: Pick<ExtendConfig, 'strictExtendedData'>;
}

/** One stored advanced-search row, as `session.paramArray` holds it. */
export interface SearchParamEntry {
  field: string;
  relationship: string;
  criteria: string;
  condition: string;
}

/** The session's advanced-search criteria [legacy: admin/Application.cfc:459-466]. */
export interface AdvancedSearchCriteria {
  paramArray: SearchParamEntry[];
  paramCount: number;
  paramCircuit: string;
  paramCategories: string;
  paramGroups: string;
  inActive: string;
  membersOnly: string | boolean;
  visitorStatus: string;
}

/** Struct keys `userFeedBean.setParams` reads beside the params; admin criteria hold none of them. */
export interface UserFeedKeys {
  ispublic?: unknown;
  type?: unknown;
  siteid?: unknown;
  categoryID?: unknown;
  groupID?: unknown;
}

/** Criteria with the session defaults admin request start-up sets. */
export function newAdvancedSearchCriteria(): AdvancedSearchCriteria {
  return {
    paramArray: [],
    paramCount: 0,
    paramCircuit: '',
    paramCategories: '',
    paramGroups: '',
    inActive: '',
    membersOnly: false,
    visitorStatus: 'All',
  };
}

/** One `queryParam.init` argument set. */
export interface QueryParamInput {
  relationship?: string;
  field?: string;
  dataType?: string;
  condition?: string;
  criteria?: string;
}

/** The state of a `queryParam` after `init`; date data types carry a parsed criteria. */
export interface QueryParam {
  relationship: string;
  field: string;
  dataType: string;
  condition: string;
  criteria: string | Date;
  isValid: boolean;
}

/** The nextN struct of `utility.getNextN` [legacy: core/mura/utility.cfc:126-178]. */
export interface NextN {
  TotalRecords: number;
  RecordsPerPage: number;
  NumberOfPages: number;
  CurrentPageNumber: number;
  firstPage: number;
  lastPage: number;
  next: number;
  previous: number;
  through: number;
  startrow: number;
}

/** The rows the cusers user iterator shows, its page index and the nextN struct. */
export interface UsersPage<R> {
  rows: R[];
  pageIndex: number;
  nextn: NextN;
}

type Kind = 's' | 'i' | 'f' | 't';
type SqlValue = string | number | Date | null;
type Truth = boolean | null;

/** A person with identity's account columns: one legacy `tusers` Type=2 row. */
interface Candidate {
  person: PersonRow;
  account: AccountView;
}

/** The 500 of a legacy query that fails; `detail` names SQL Server's or ACF's error. */
function queryError(detail: string): LegacyApiError {
  const err = new LegacyApiError('server_error');
  err.cause = new Error(detail);
  return err;
}

/** A simple value as CFML text; NULL and undefined read as ''. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

/** CFML `listFindNoCase` over a comma list. */
function listFindNoCase(list: string, value: string): boolean {
  const needle = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === needle);
}

/** A char(35) or varchar id as SQL Server compares it: case-insensitive, trailing spaces ignored. */
function idKey(id: string): string {
  return id.replace(/ +$/, '').toUpperCase();
}

// Windows collation word sort weighs hyphens and apostrophes lightly; ICU does not, so ordering of such names can differ.
const COLLATOR = new Intl.Collator('en-US', { sensitivity: 'accent' });

/** SQL Server text comparison under SQL_Latin1_General_CP1_CI_AS: case-insensitive, accent-sensitive, trailing spaces ignored. */
function compareText(a: string, b: string): number {
  return COLLATOR.compare(a.replace(/ +$/, ''), b.replace(/ +$/, ''));
}

/** SQL Server ORDER BY of one key: NULLs lowest. */
function compareSql(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return compareText(text(a), text(b));
}

/** Identity's `LocalTimestamp` wall-clock text as a local Date; other text stays as it is. */
function wallClock(value: string | null): Date | string | null {
  const m = value === null ? null : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (m === null) return value;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number((ms ?? '0').padEnd(3, '0')));
}

/** A `tusers` column people can read: its kind and its value in one candidate. */
interface UserColumn {
  kind: Kind;
  read: (c: Candidate) => unknown;
}

const PERSON_KINDS: ReadonlyMap<string, Kind> = new Map(PERSON.columns.map((column) => [column.name, column.type as Kind]));

function personColumn(name: keyof PersonRow): UserColumn {
  return { kind: PERSON_KINDS.get(name) ?? 's', read: (c) => c.person[name] };
}

function accountColumn(kind: Kind, read: (account: AccountView) => unknown): UserColumn {
  return { kind, read: (c) => read(c.account) };
}

/** Every `tusers` column, lower-cased: person columns from people, account columns from identity. */
const TUSERS_COLUMNS: ReadonlyMap<string, UserColumn> = new Map<string, UserColumn>([
  ...(['userid', 'groupname', 'fname', 'lname', 'email', 'company', 'jobtitle', 'mobilephone', 'website', 'subtype', 'ext', 'contactform',
    'lastupdate', 'lastupdateby', 'lastupdatebyid', 'subscribe', 'notes', 'description', 'interests', 'keepprivate', 'photofileid',
    'imname', 'imservice', 'created', 'tags'] as const).map((name) => [name, personColumn(name)] as const),
  ['username', accountColumn('s', (a) => a.username)],
  // Identity never exposes credentials, so a criterion on the password hash compares against NULL.
  ['password', accountColumn('s', () => null)],
  ['passwordcreated', accountColumn('t', (a) => wallClock(a.passwordCreated))],
  ['lastlogin', accountColumn('t', (a) => wallClock(a.lastLogin))],
  ['type', accountColumn('i', (a) => a.type)],
  ['admin', accountColumn('i', (a) => a.admin)],
  ['s2', accountColumn('i', (a) => a.s2)],
  ['perm', accountColumn('i', (a) => a.perm)],
  ['inactive', accountColumn('i', (a) => a.inactive)],
  ['ispublic', accountColumn('i', (a) => a.isPublic)],
  ['siteid', accountColumn('s', (a) => a.siteId)],
  ['remoteid', accountColumn('s', (a) => a.remoteId)],
  ['tablist', accountColumn('s', (a) => a.tablist)],
]);

/** The value of `tusers` column `name` (any case) in a candidate. */
function userValue(c: Candidate, name: string): unknown {
  return TUSERS_COLUMNS.get(name.toLowerCase())?.read(c) ?? null;
}

/** One legacy result row with `columns`, values read from the candidate; `photoFileExt` comes from `exts`. */
function resultRow(c: Candidate, columns: readonly string[], exts: ReadonlyMap<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    row[column] = column === 'photoFileExt' ? (exts.get(c.person.photofileid ?? '') ?? '') : userValue(c, column);
  }
  return row;
}

/** A people table an implied advanced-search join reaches on `userid`. */
interface JoinTable {
  table: string;
  unit: string;
  kinds: ReadonlyMap<string, Kind>;
}

function joinTable(def: { table: string; unit: string; columns: readonly { name: string; type: string }[] }): JoinTable {
  return { table: def.table, unit: def.unit, kinds: new Map(def.columns.map((column) => [column.name, column.type as Kind])) };
}

/** Legacy tables of people's Type=2 rows that userGateway joins by field prefix, lower-cased. */
const JOIN_TABLES: ReadonlyMap<string, JoinTable> = new Map([
  ['tuseraddresses', joinTable(ADDRESS)],
  ['tuserstags', joinTable(TAG)],
  ['tusersinterests', joinTable(INTEREST)],
  ['tusersfavorites', joinTable(FAVORITE)],
]);

/** The value of `context[name]`, matched ignoring case as a CFML struct is; undefined when absent. */
function contextValue(context: ReadonlyMap<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  if (context.has(lower)) return context.get(lower);
  for (const [key, value] of context) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/** `request.context[name]`, failing as ACF does for an element the struct lacks. */
function requiredContext(context: ReadonlyMap<string, unknown>, name: string): string {
  const value = contextValue(context, name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in a CFML structure referenced as part of an expression.`);
  return text(value);
}

/** Session criteria after admin request start-up [legacy: admin/Application.cfc:467-498]: rebuilt from a non-empty `param`, else `previous`. */
export function buildAdvancedSearchCriteria(context: ReadonlyMap<string, unknown>, previous: AdvancedSearchCriteria): AdvancedSearchCriteria {
  const param = text(contextValue(context, 'param'));
  if (param === '') return previous;
  const paramArray: SearchParamEntry[] = [];
  for (const index of cfListToArray(param)) {
    const field = requiredContext(context, `paramField${index}`);
    if (cfEq(field, 'Select Field') || field === '') continue;
    const criteria = requiredContext(context, `paramCriteria${index}`);
    if (criteria === '') continue;
    paramArray.push({
      field,
      relationship: requiredContext(context, `paramRelationship${index}`),
      criteria,
      condition: requiredContext(context, `paramCondition${index}`),
    });
  }
  const withDefault = (name: string, fallback: string | boolean): string | boolean => {
    const value = contextValue(context, name);
    return value === undefined ? fallback : typeof value === 'boolean' ? value : text(value);
  };
  const circuit = cfListToArray(cfListToArray(text(contextValue(context, 'muraAction')), '.')[0] ?? '', ':').at(-1) ?? '';
  return {
    paramArray,
    paramCount: paramArray.length,
    paramCircuit: circuit,
    paramCategories: text(withDefault('categoryID', '')),
    paramGroups: text(withDefault('groupID', '')),
    inActive: text(withDefault('inActive', '0')),
    membersOnly: withDefault('membersOnly', false),
    visitorStatus: text(withDefault('visitorStatus', 'All')),
  };
}

/** The `userFeedBean` state getAdvancedSearch reads. */
interface UserFeed {
  params: QueryParamInput[];
  inactive: unknown;
  isPublic: unknown;
  type: unknown;
  siteId: string;
  categoryId: string;
  groupId: string;
}

/** CFML `isValid('variablename')`. */
const VARIABLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The SQL type addParam gives a `tusers` column passed without one. */
const PARAM_TYPE_OF_KIND: Readonly<Record<Kind, string>> = { s: 'varchar', i: 'integer', f: 'float', t: 'timestamp' };

/** `userFeedBean.setType`: numbers as given, 'user' 2, 'group' 1, anything else unchanged. */
function feedType(current: unknown, value: unknown): unknown {
  if (cfIsNumeric(value)) return value;
  if (cfEq(text(value), 'user')) return 2;
  if (cfEq(text(value), 'group')) return 1;
  return current;
}

/** Filter setters of `userFeedBean` that `addParam` calls instead of adding a param, lower-cased. */
const FEED_SETTERS: ReadonlySet<string> = new Set(['inactive', 'ispublic', 'type', 'groupid', 'categoryid']);

/** `setValue(name, value)` on the user feed for one of `FEED_SETTERS` [legacy: core/mura/user/userFeedBean.cfc:185-238]. */
function applyFeedSetter(feed: UserFeed, name: string, value: unknown): void {
  switch (name) {
    case 'inactive':
      if (cfIsNumeric(value)) feed.inactive = value;
      break;
    case 'ispublic':
      feed.isPublic = value;
      break;
    case 'type':
      feed.type = feedType(feed.type, value);
      break;
    case 'groupid':
      feed.groupId = javaTrim(text(value));
      break;
    default:
      feed.categoryId = javaTrim(text(value));
  }
}

/** `beanFeed.addParam` of one row into `feed` [legacy: core/mura/bean/beanFeed.cfc:301-342]. */
function addParam(feed: UserFeed, input: Required<QueryParamInput>): void {
  let field = input.field.replace(/[^0-9A-Za-z._,\-*]/g, '');
  let dataType = input.dataType;
  // Only the user feed's filter setters are modelled; other bean property names stay params.
  if (VARIABLE_NAME.test(field) && FEED_SETTERS.has(field.toLowerCase())) {
    applyFeedSetter(feed, field.toLowerCase(), input.criteria);
    return;
  }
  if (field.toLowerCase() === 'tag') {
    field = 'tuserstags.tag';
    dataType = 'varchar';
  }
  if (dataType === '') dataType = PARAM_TYPE_OF_KIND[TUSERS_COLUMNS.get((field.split('.').at(-1) ?? '').toLowerCase())?.kind ?? 's'];
  if (TUSERS_COLUMNS.has(field.toLowerCase())) field = `tusers.${field}`;
  feed.params.push({ ...input, field, dataType });
}

/** `userFeedBean.setParams(criteria)` [legacy: core/mura/user/userFeedBean.cfc:109-158], then getAdvancedSearch's `isPublic` argument. */
function userFeed(criteria: AdvancedSearchCriteria & UserFeedKeys, isPublic: unknown): UserFeed {
  const feed: UserFeed = { params: [], inactive: '', isPublic: 1, type: 2, siteId: '', categoryId: '', groupId: '' };
  for (const entry of criteria.paramArray) {
    const parts = cfListToArray(entry.field, '^');
    addParam(feed, {
      field: parts[0] ?? '',
      relationship: entry.relationship,
      criteria: entry.criteria,
      condition: entry.condition,
      dataType: parts.at(-1) ?? '',
    });
  }
  applyFeedSetter(feed, 'inactive', criteria.inActive);
  if (criteria.ispublic !== undefined) applyFeedSetter(feed, 'ispublic', criteria.ispublic);
  if (criteria.type !== undefined) applyFeedSetter(feed, 'type', criteria.type);
  if (criteria.siteid !== undefined) feed.siteId = text(criteria.siteid);
  // Admin criteria hold paramCategories and paramGroups but no categoryID or groupID keys, so those filters never apply there.
  if (criteria.categoryID !== undefined) applyFeedSetter(feed, 'categoryid', criteria.categoryID);
  if (criteria.groupID !== undefined) applyFeedSetter(feed, 'groupid', criteria.groupID);
  if (cfIsNumeric(isPublic)) feed.isPublic = isPublic;
  return feed;
}

/** Relationships `queryParam.setRelationship` keeps, lower-cased. */
const RELATIONSHIPS = 'or,and,(,and (,or (,),and not (,or not (,openGrouping,orOpenGrouping,andOpenGrouping,closeGrouping';
const GROUPING_RELATIONSHIPS = '(,and (,or (,),and not (,or not (,openGrouping,orOpenGrouping,andOpenGrouping,closeGrouping';

/** `queryParam.setCondition` [legacy: core/mura/queryParam.cfc:159-196]; undefined for a name no case matches. */
function conditionFor(condition: string, dataType: string): string | undefined {
  const lower = condition.toLowerCase();
  if (['equals', 'eq', 'is', '='].includes(lower)) return '=';
  if (['gt', '>'].includes(lower)) return '>';
  if (lower === 'in') return 'in';
  if (['notin', 'not in'].includes(lower)) return 'not in';
  if (['neq', '!='].includes(lower)) return '!=';
  if (['gte', '>='].includes(lower)) return '>=';
  if (['lt', '<'].includes(lower)) return '<';
  if (['lte', '<='].includes(lower)) return '<=';
  if (['begins', 'beginswith', 'contains', 'containsvalue', 'like', 'ends', 'endswith'].includes(lower)) {
    return listFindNoCase('varchar,longvarchar', dataType) ? 'like' : '=';
  }
  return undefined;
}

/** `queryParam.setDataType`. */
function dataTypeFor(dataType: string): string {
  if (cfEq(dataType, 'datetime')) return 'timestamp';
  if (cfEq(dataType, 'boolean')) return 'bit';
  return dataType.replace(/\W/g, '');
}

/** `createODBCDateTime`: whole seconds. */
function odbcDateTime(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

/** `createODBCDate(createDate(year, month, day))`. */
function odbcDate(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/** `queryParam.setCriteria`; undefined when the data type matches no case and the previous criteria stays. */
function criteriaFor(tmp: string, condition: string, dataType: string): string | Date | undefined {
  if (cfEq(tmp, 'null')) return 'null';
  switch (dataType.toLowerCase()) {
    case 'varchar':
    case 'longvarchar': {
      const lower = condition.toLowerCase();
      if (lower === 'begins' || lower === 'beginswith') return `${tmp}%`;
      if (lower === 'ends' || lower === 'endswith') return `%${tmp}`;
      if (lower === 'contains' || lower === 'containsvalue' || lower === 'like') return `%${tmp}%`;
      return tmp;
    }
    case 'bit':
      return cfIsBoolean(tmp) ? tmp : '';
    case 'date':
      if (cfLsIsDate(tmp)) return odbcDate(cfLsParseDateTime(tmp));
      return cfIsDateText(tmp) ? odbcDate(cfParseDateTimeText(tmp)) : '';
    case 'timestamp':
    case 'datetime':
      if (cfLsIsDate(tmp)) return odbcDateTime(cfLsParseDateTime(tmp));
      return cfIsDateText(tmp) ? odbcDateTime(cfParseDateTimeText(tmp)) : '';
    case 'time':
      return cfIsDateText(tmp) ? odbcDateTime(cfParseDateTimeText(tmp)) : '';
    case 'numeric':
      return cfIsNumeric(tmp) ? tmp : '';
    default:
      return undefined;
  }
}

/** `queryParam.init` in legacy order [legacy: core/mura/queryParam.cfc:87-107]; an invalid part keeps `previous`'s value (one reused object). */
export function parseQueryParam(raw: QueryParamInput, previous?: QueryParam): QueryParam {
  // `[mura]` tags in the criteria are not rendered: that needs the CFML content renderer.
  const field = (raw.field ?? '').replace(/[^\w.]+/g, '');
  const relationship = listFindNoCase(RELATIONSHIPS, raw.relationship ?? '') ? (raw.relationship ?? '') : (previous?.relationship ?? '');
  let dataType = dataTypeFor(raw.dataType ?? '');
  const rawCondition = raw.condition ?? 'Equals';
  const condition = conditionFor(rawCondition, dataType) ?? previous?.condition ?? '';
  const tmp = raw.criteria ?? '';
  if (dataType === '' && tmp !== '' && (cfLsIsDate(tmp) || cfIsDateText(tmp))) dataType = 'timestamp';
  const criteria = criteriaFor(tmp, rawCondition, dataType) ?? previous?.criteria ?? '';
  const emptyField = field === '' || cfEq(field, 'Select Field');
  const isValid = listFindNoCase(GROUPING_RELATIONSHIPS, relationship) || !emptyField;
  return { relationship, field: isValid ? field : '', dataType, condition, criteria, isValid };
}

/** `queryParam.getCondition`: `=`/`!=` against 'null' become `is`/`is not`; undefined for any other condition against 'null'. */
export function paramCondition(param: Pick<QueryParam, 'condition' | 'criteria'>): string | undefined {
  if (typeof param.criteria === 'string' && cfEq(param.criteria, 'null')) {
    if (param.condition === '=') return 'is';
    if (param.condition === '!=') return 'is not';
    return undefined;
  }
  return param.condition;
}

/** A SQL Server LIKE pattern as an anchored, case-insensitive regex: `%`, `_` and `[...]` classes, no escape character. */
function likeRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    const close = char === '[' ? pattern.indexOf(']', i + 1) : -1;
    if (char === '%') {
      source += '[\\s\\S]*';
    } else if (char === '_') {
      source += '[\\s\\S]';
    } else if (close !== -1) {
      const body = pattern.slice(i + 1, close);
      const negated = body.startsWith('^');
      source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')}]`;
      i = close;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** SQL Server's default (style 0) datetime-to-text conversion, e.g. `Jun  5 2026  9:05AM`. */
function datetimeText(value: Date): string {
  const hour = value.getHours() % 12 === 0 ? 12 : value.getHours() % 12;
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, ' ');
  return `${MONTHS[value.getMonth()]} ${day} ${value.getFullYear()} ${String(hour).padStart(2, ' ')}:${minutes}${value.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** SQL Server's default float-to-text conversion: six significant digits, exponent form outside 1e-4 to 1e6. */
function floatText(value: number): string {
  const rounded = Number(value.toPrecision(6));
  if (rounded === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent < 6 && exponent >= -4) return String(rounded);
  const [mantissa = '', power = '0'] = rounded.toExponential().split('e');
  return `${mantissa}e${power.startsWith('-') ? '-' : '+'}${power.replace(/^[+-]/, '').padStart(3, '0')}`;
}

/** The text LIKE matches a value of `kind` against, as SQL Server converts it. */
function likeText(value: Exclude<SqlValue, null>, kind: Kind): string {
  if (value instanceof Date) return datetimeText(value);
  if (typeof value === 'number') return kind === 'f' ? floatText(value) : String(value);
  return value;
}

/** A stored or computed column value as a SQL value. */
function sqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) return value;
  return text(value);
}

/** A value SQL Server converts to datetime for a comparison; text must read as a date. */
function toDatetime(value: Exclude<SqlValue, null>): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && cfIsDateText(value)) return cfParseDateTimeText(value).getTime();
  throw queryError(`Conversion failed when converting ${text(value)} to datetime.`);
}

/** A value SQL Server converts to a number for a comparison; text must be numeric. */
function toNumber(value: Exclude<SqlValue, null>): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && cfIsNumeric(value)) return cfToNumber(value);
  throw queryError(`Conversion failed when converting the value ${text(value)} to a number.`);
}

/** Order of two non-NULL values under SQL Server's type precedence: datetime, then numbers, then text. */
function compareValues(left: Exclude<SqlValue, null>, right: Exclude<SqlValue, null>): number {
  if (left instanceof Date || right instanceof Date) return toDatetime(left) - toDatetime(right);
  if (typeof left === 'number' || typeof right === 'number') return toNumber(left) - toNumber(right);
  return compareText(left, right);
}

const TEXT_TYPES = 'varchar,char,longvarchar,nvarchar,nchar,longnvarchar,clob,nclob';
const NUMBER_TYPES = 'integer,bigint,smallint,tinyint,numeric,decimal,double,float,real,money,money4';
const DATE_TYPES = 'date,timestamp,time';

/** `cfqueryparam cfsqltype="cf_sql_<dataType>"` of one value; throws ACF's binding error where ACF refuses it. */
function bindValue(dataType: string, value: string | Date): Exclude<SqlValue, null> {
  const invalid = (): LegacyApiError => queryError(`Invalid data ${text(value)} for CFSQLTYPE CF_SQL_${dataType.toUpperCase()}.`);
  if (listFindNoCase(TEXT_TYPES, dataType)) {
    if (typeof value === 'string') return value;
    throw invalid();
  }
  if (listFindNoCase(NUMBER_TYPES, dataType)) {
    if (typeof value === 'string' && cfIsNumeric(value)) return cfToNumber(value);
    throw invalid();
  }
  if (cfEq(dataType, 'bit')) {
    if (typeof value === 'string' && cfIsBoolean(value)) return cfToBoolean(value) ? 1 : 0;
    throw invalid();
  }
  if (listFindNoCase(DATE_TYPES, dataType)) {
    let date: Date;
    try {
      date = cfTimestampParam(value);
    } catch (err) {
      throw queryError(err instanceof Error ? err.message : String(err));
    }
    return cfEq(dataType, 'date') ? odbcDate(date) : date;
  }
  throw queryError(`Invalid CFSQLTYPE CF_SQL_${dataType.toUpperCase()}.`);
}

/** `cfqueryparam list="true"`: the non-empty comma items of the criteria, each bound. */
function bindList(dataType: string, value: string | Date): Exclude<SqlValue, null>[] {
  const items = typeof value === 'string' ? cfListToArray(value) : [value];
  if (items.length === 0) throw queryError("Incorrect syntax near ')'.");
  return items.map((item) => bindValue(dataType, item));
}

/** The SQL truth of a column value of `kind` under one condition. */
type ValueTest = (value: SqlValue, kind: Kind) => Truth;

const COMPARISONS: Readonly<Record<string, (order: number) => boolean>> = {
  '=': (order) => order === 0,
  '!=': (order) => order !== 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
};

/** The test `<column> <condition> <criteria>` applies; the criteria is bound once as `dataType`. */
function valueTest(condition: string | undefined, param: QueryParam, dataType: string): ValueTest {
  switch (condition) {
    case 'is':
      return (value) => value === null;
    case 'is not':
      return (value) => value !== null;
    case 'like': {
      const pattern = likeRegex(likeText(bindValue(dataType, param.criteria), 's'));
      return (value, kind) => (value === null ? null : pattern.test(likeText(value, kind)));
    }
    case 'in':
    case 'not in': {
      const values = bindList(dataType, param.criteria);
      const negate = condition === 'not in';
      return (value) => (value === null ? null : values.some((item) => compareValues(value, item) === 0) !== negate);
    }
    default: {
      const comparison = condition === undefined ? undefined : COMPARISONS[condition];
      if (comparison === undefined) throw queryError(`Incorrect syntax near '${condition ?? 'NULL'}'.`);
      const right = bindValue(dataType, param.criteria);
      return (value) => (value === null ? null : comparison(compareValues(value, right)));
    }
  }
}

/** One joined result row before projection: the user and the implied-join rows it pairs with. */
interface SearchRow {
  candidate: Candidate;
  joined: ReadonlyMap<string, QueryResultRow>;
}

type Predicate = (row: SearchRow) => Truth;
type Token = 'and' | 'or' | 'not' | '(' | ')' | Predicate;

/** Compiles a WHERE token stream with SQL precedence (NOT, AND, OR) and three-valued logic; malformed text is a syntax error. */
function compileWhere(tokens: readonly Token[]): Predicate {
  let pos = 0;
  const syntaxError = (): LegacyApiError => {
    const token = tokens[pos - 1];
    return queryError(`Incorrect syntax near '${typeof token === 'string' ? token : 'expression'}'.`);
  };
  const primary = (): Predicate => {
    const token = tokens[pos];
    pos += 1;
    if (typeof token === 'function') return token;
    if (token !== '(') throw syntaxError();
    const inner = disjunction();
    pos += 1;
    if (tokens[pos - 1] !== ')') throw syntaxError();
    return inner;
  };
  const negation = (): Predicate => {
    if (tokens[pos] !== 'not') return primary();
    pos += 1;
    const inner = negation();
    return (row) => {
      const value = inner(row);
      return value === null ? null : !value;
    };
  };
  const conjunction = (): Predicate => {
    let left = negation();
    while (tokens[pos] === 'and') {
      pos += 1;
      const [a, b] = [left, negation()];
      left = (row) => {
        const x = a(row);
        if (x === false) return false;
        const y = b(row);
        if (y === false) return false;
        return x === null || y === null ? null : true;
      };
    }
    return left;
  };
  function disjunction(): Predicate {
    let left = conjunction();
    while (tokens[pos] === 'or') {
      pos += 1;
      const [a, b] = [left, conjunction()];
      left = (row) => {
        const x = a(row);
        if (x === true) return true;
        const y = b(row);
        if (y === true) return true;
        return x === null || y === null ? null : false;
      };
    }
    return left;
  }
  const where = disjunction();
  if (pos !== tokens.length) {
    pos += 1;
    throw syntaxError();
  }
  return where;
}

/** SQL `=` on text, NULL matching nothing. */
function textEquals(value: unknown, expected: string): boolean {
  return typeof value === 'string' && compareText(value, expected) === 0;
}

/** SQL `=` of a nullable integer column with a number. */
function numberEquals(value: number | null, expected: number): Truth {
  return value === null ? null : value === expected;
}


/** CFML `isBoolean(value) and value`. */
function flag(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** CFML `value eq 0`. */
function isZero(value: unknown): boolean {
  return cfEq(text(value), '0');
}

/** A numeric `cfqueryparam` of a request value; throws ACF's binding error for non-numeric text. */
function numericParam(value: unknown, sqlType: string): number {
  if (cfIsNumeric(value)) return cfToNumber(value);
  throw queryError(`Invalid data ${text(value)} for CFSQLTYPE CF_SQL_${sqlType}.`);
}

/** One user pool: the legacy pool site and the tenant holding its rows. */
interface UserPool {
  siteId: string;
  tenantId: string;
}

/** The registry entry of the viewer's verified tenant; an unregistered tenant answers the legacy 503. */
async function registryEntry(deps: Pick<SearchDeps, 'db'>, tid: string): Promise<TenantRegistryEntry> {
  const entry = await registryEntryForTenant(deps.db, tid);
  if (entry === null) throw new LegacyServiceUnavailableError(`Tenant ${tid} has no site registry entry`, 'auto', 'tenant-unregistered');
  return entry;
}

/** `getPublicUserPoolID()` or `getPrivateUserPoolID()` of a site; settingsBean reads an empty pool id as the site's own. */
function userPool(entry: TenantRegistryEntry, isPublic: boolean): UserPool {
  const poolId = isPublic ? entry.publicUserPoolId : entry.privateUserPoolId;
  const siteId = poolId === null || poolId === '' ? entry.siteId : poolId;
  return { siteId, tenantId: (isPublic ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId) };
}

/** getAdvancedSearch's `userPoolID` [legacy: core/mura/user/userGateway.cfc:215-223]: one pool for 0 or 1, else both when they differ. */
function advancedPools(entry: TenantRegistryEntry, isPublic: unknown): UserPool[] {
  const publicPool = userPool(entry, true);
  if (isZero(isPublic)) return [userPool(entry, false)];
  if (cfEq(text(isPublic), '1')) return [publicPool];
  const privatePool = userPool(entry, false);
  return cfEq(publicPool.siteId, privatePool.siteId) ? [publicPool] : [publicPool, privatePool];
}

/** The candidates of `persons`: each joined with identity's account columns. */
async function withAccounts(deps: Pick<SearchDeps, 'identity'>, persons: readonly PersonRow[]): Promise<Candidate[]> {
  const accounts = await deps.identity.readAccounts(persons.map((person) => person.userid));
  const byId = new Map([...accounts.values()].map((account) => [idKey(account.userId), account]));
  // A person identity does not list (a pending or missing account) has no complete legacy row.
  return persons.flatMap((person) => {
    const account = byId.get(idKey(person.userid));
    return account === undefined ? [] : [{ person, account }];
  });
}

const MEMBERSHIP_BATCH = 16;

/** Each candidate's group ids, by user id key; identity has no bulk membership read, so users are read in bounded batches. */
async function membershipsOf(deps: Pick<SearchDeps, 'identity'>, candidates: readonly Candidate[]): Promise<Map<string, string[]>> {
  const memberships = new Map<string, string[]>();
  for (let start = 0; start < candidates.length; start += MEMBERSHIP_BATCH) {
    const batch = candidates.slice(start, start + MEMBERSHIP_BATCH);
    const groups = await Promise.all(batch.map((c) => deps.identity.membershipGroupIds(c.person.userid)));
    batch.forEach((c, index) => memberships.set(idKey(c.person.userid), groups[index] ?? []));
  }
  return memberships;
}

/** Photo file extensions of the candidates' `photoFileID`s; empty without a lookup. */
async function photoExtensions(deps: Pick<SearchDeps, 'photoFileExts'>, candidates: readonly Candidate[]): Promise<ReadonlyMap<string, string>> {
  if (deps.photoFileExts === undefined) return new Map();
  return deps.photoFileExts(candidates.map((c) => c.person.photofileid));
}

/** One ORDER BY key over candidates. */
interface OrderKey {
  read: (c: Candidate) => unknown;
  descending: boolean;
}

// SQL Server leaves the order of rows with equal keys unspecified; userid breaks ties, so tied rows may still order differently.
/** Compares two candidates by `keys`, then by userid. */
function compareCandidates(a: Candidate, b: Candidate, keys: readonly OrderKey[]): number {
  for (const key of keys) {
    const order = compareSql(sqlValue(key.read(a)), sqlValue(key.read(b)));
    if (order !== 0) return key.descending ? -order : order;
  }
  return compareSql(a.person.userid, b.person.userid);
}

const BY_NAME: readonly OrderKey[] = [
  { read: (c) => c.person.lname, descending: false },
  { read: (c) => c.person.fname, descending: false },
];

/** Arguments of `getUsers`; `siteid` only switches the pool filter on, as the pools come from the viewer's tenant. */
export interface UsersQueryArgs {
  siteid?: string;
  ispublic?: number | string;
  isunassigned?: unknown;
  showsuperusers?: unknown;
}

/** `userGateway.getUsers` [legacy: core/mura/user/userGateway.cfc:679-716]: users of the site's pool, or with no `siteid` the viewer's tenant, by name. */
export async function getUsers(
  deps: SearchDeps,
  viewer: ViewerScope,
  { siteid = '', ispublic = 1, isunassigned = 0, showsuperusers = 0 }: UsersQueryArgs = {},
): Promise<LegacyQuery> {
  const publicFilter = text(ispublic) === '' ? undefined : numericParam(ispublic, 'INTEGER');
  const pool = siteid === '' ? undefined : userPool(await registryEntry(deps, viewer.tid), !isZero(ispublic));
  const persons = await deps.db.withTenant(pool?.tenantId ?? viewer.tid, (tx) =>
    pool === undefined ? deps.repo.queryPersons(tx, {}) : deps.repo.listPersonsForSite(tx, pool.siteId),
  );
  let candidates = (await withAccounts(deps, persons)).filter(
    (c) =>
      numberEquals(c.account.type, 2) === true &&
      (publicFilter === undefined || numberEquals(c.account.isPublic, publicFilter) === true) &&
      // Legacy's showsuperusers is inverted: a true value hides S2 users (`s2 <> 1`).
      (!flag(showsuperusers) || (c.account.s2 !== null && c.account.s2 !== 1)),
  );
  if (flag(isunassigned)) {
    const memberships = await membershipsOf(deps, candidates);
    candidates = candidates.filter((c) => (memberships.get(idKey(c.person.userid)) ?? []).length === 0);
  }
  candidates.sort((a, b) => compareCandidates(a, b, BY_NAME));
  const empty = new Map<string, string>();
  return legacyQuery([...USERS_LIST_COLUMNS], candidates.map((c) => resultRow(c, USERS_LIST_COLUMNS, empty)));
}

/** `userManager.getUnassignedUsers` [legacy: core/mura/user/userManager.cfc:1121-1127]: `getUsers` of users without a membership. */
export function getUnassignedUsers(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: Omit<UsersQueryArgs, 'isunassigned'> = {},
): Promise<LegacyQuery> {
  return getUsers(deps, viewer, { ...args, ispublic: args.ispublic ?? 1, isunassigned: true });
}

/** Arguments of `getSearch`; `siteid` is the legacy argument the pools came from, here the viewer's verified site. */
export interface SearchQueryArgs {
  search?: string;
  siteid?: string;
  isPublic?: number | string;
}

/** Columns getSearch matches the term against. */
const SEARCH_COLUMNS = ['lname', 'fname', 'company', 'username', 'email', 'jobtitle'] as const;

/** `userGateway.getSearch` [legacy: core/mura/user/userGateway.cfc:124-162]: pool users LIKE `%search%` on six columns, by last name, at most 2100. */
export async function getSearch(deps: SearchDeps, viewer: ViewerScope, { search = '', isPublic = 0 }: SearchQueryArgs = {}): Promise<LegacyQuery> {
  const isPublicValue = numericParam(isPublic, 'NUMERIC');
  // Legacy adds `and 0=1` for an empty term.
  if (search === '') return legacyQuery([...SEARCH_FIELD_LIST], []);
  const pool = userPool(await registryEntry(deps, viewer.tid), !isZero(isPublic));
  const persons = await deps.db.withTenant(pool.tenantId, (tx) => deps.repo.listPersonsForSite(tx, pool.siteId));
  const pattern = likeRegex(`%${search}%`);
  const matched = (await withAccounts(deps, persons))
    .filter(
      (c) =>
        numberEquals(c.account.type, 2) === true &&
        numberEquals(c.account.isPublic, isPublicValue) === true &&
        SEARCH_COLUMNS.some((column) => {
          const value = sqlValue(userValue(c, column));
          return value !== null && pattern.test(likeText(value, 's'));
        }) &&
        (viewer.isS2 || numberEquals(c.account.s2, 0) === true),
    )
    .sort((a, b) => compareCandidates(a, b, BY_NAME.slice(0, 1)))
    .slice(0, SEARCH_MAX_ROWS);
  const exts = await photoExtensions(deps, matched);
  return legacyQuery([...SEARCH_FIELD_LIST], matched.map((c) => resultRow(c, SEARCH_FIELD_LIST, exts)));
}

/** `utility.isDeniedFeedTable(reference, 'tusers')` of a sanitized table name. */
function isDeniedFeedTable(table: string): boolean {
  return !cfEq(table, 'tusers') && listFindNoCase(DENIED_FEED_JOIN_TABLES, table);
}

/** Implied join tables of `table.column` fields, lower-cased [legacy: core/mura/user/userGateway.cfc:228-238]; denied ones throw `authorization`. */
function impliedJoins(params: readonly QueryParamInput[]): string[] {
  const spelled: string[] = [];
  for (const param of params) {
    const parts = cfListToArray(param.field ?? '', '.');
    if (parts.length !== 2) continue;
    const table = (parts[0] ?? '').replace(/[^0-9A-Za-z_]/g, '');
    if (isDeniedFeedTable(table)) throw new LegacyApiError('authorization');
    if (!cfEq(table, 'tusers') && !spelled.includes(table)) spelled.push(table);
  }
  const joins: string[] = [];
  for (const table of spelled) {
    const key = table.toLowerCase();
    if (joins.includes(key)) throw queryError(`The objects "${table}" and "${table}" in the FROM clause have the same exposed names.`);
    // Implied joins reach people's own tables only; another owner's table is not joined, so the query fails as an invalid one would.
    if (!JOIN_TABLES.has(key)) throw queryError(`Invalid object name '${table}'.`);
    joins.push(key);
  }
  return joins;
}

/** `utility.validateSortDirection` [legacy: core/mura/utility.cfc:1134-1145]. */
function validSortDirection(direction: string): boolean {
  const normalized = javaTrim(direction).toLowerCase();
  if (normalized !== 'asc' && normalized !== 'desc') throw new LegacyApiError('Masa.InvalidSortDirection');
  return normalized === 'desc';
}

/** `tusers.` + `utility.validateSort(sortBy & ' ' & sortDirection)` as ORDER BY keys [legacy: core/mura/utility.cfc:1193-1240]. */
function builtInOrder(sortBy: string, sortDirection: string): OrderKey[] {
  return cfListToArray(`${sortBy} ${sortDirection}`).map((item) => {
    const parts = javaTrim(item).split(/\s+/);
    const field = (parts.length >= 2 ? parts.slice(0, -1) : parts).join(' ');
    if (!/^[a-zA-Z0-9_.]+$/.test(field)) throw new LegacyApiError('Masa.InvalidSortBy');
    const descending = parts.length >= 2 ? validSortDirection(parts.at(-1) ?? '') : false;
    const column = TUSERS_COLUMNS.get(field.toLowerCase());
    if (column === undefined) throw queryError(`Invalid column name '${field}'.`);
    return { read: column.read, descending };
  });
}

/** The queryParam states of the feed's params, one reused param object as legacy uses. */
function parseParams(inputs: readonly QueryParamInput[]): QueryParam[] {
  const parsed: QueryParam[] = [];
  for (const input of inputs) parsed.push(parseQueryParam(input, parsed.at(-1)));
  return parsed;
}

/** Whether a valid param compares an extended attribute (a field without a table). */
function isExtendedParam(param: QueryParam): boolean {
  return param.isValid && param.field !== '' && cfListToArray(param.field, '.').length <= 1;
}

/** People rows one pool or site tenant holds for an advanced search. */
interface TenantRows {
  persons: PersonRow[];
  extendData: ExtendDataRow[];
  attributes: ExtendAttributeRow[];
  joins: Map<string, QueryResultRow[]>;
}

/** Every row of a join table in the transaction tenant, read behind its unit's window phase. */
async function tenantTableRows(repo: PeopleRepository, tx: TenantTx, table: JoinTable): Promise<QueryResultRow[]> {
  const sql = `SELECT * FROM ${qualified(repo.schema, table.table)} WHERE tenant_id = $1`;
  return repo.read(tx, table.unit, async () => (await tx.query(sql, [tx.tenantId])).rows);
}

/** The rows of one tenant: persons and join rows for a pool tenant, extended data and attributes when `extended`. */
async function loadTenantRows(
  deps: SearchDeps,
  tenantId: string,
  needs: { pool: boolean; extended: boolean; tables: readonly string[] },
): Promise<TenantRows> {
  return deps.db.withTenant(tenantId, async (tx) => {
    const persons = needs.pool ? await deps.repo.queryPersons(tx, {}) : [];
    const extendData = needs.extended ? await deps.repo.listExtendData(tx, persons.map((person) => person.userid)) : [];
    const attributes = needs.extended ? await deps.repo.listExtendAttributes(tx, {}) : [];
    const joins = new Map<string, QueryResultRow[]>();
    for (const key of needs.pool ? needs.tables : []) {
      const table = JOIN_TABLES.get(key);
      if (table !== undefined) joins.set(key, await tenantTableRows(deps.repo, tx, table));
    }
    return { persons, extendData, attributes, joins };
  });
}

/** What the extended-attribute predicates and the extended sort read. */
interface ExtendContext {
  data: readonly ExtendDataRow[];
  attributes: ReadonlyMap<number, ExtendAttributeRow>;
  /** `params.getSiteID()`, which getCastString and the extended sort match attributes by. */
  siteId: string;
  /** `userPoolID` as one bound value: a single pool site, or for two pools their comma list. */
  poolValue: string;
  config: Pick<ExtendConfig, 'strictExtendedData'>;
}

/** `extendManager.getCastString(attribute, siteID)` [legacy: core/mura/extend/extendManager.cfc:1147-1184]. */
function castFor(ctx: ExtendContext, attribute: string): { column: 'numericvalue' | 'datetimevalue' | 'stringvalue'; kind: Kind } {
  let validation = '';
  if (cfIsNumeric(attribute)) {
    validation = ctx.attributes.get(cfToNumber(attribute))?.validation ?? '';
  } else {
    const ids = [...ctx.attributes.keys()].sort((a, b) => a - b);
    const match = ids.map((id) => ctx.attributes.get(id)).find((row) => textEquals(row?.siteid, ctx.siteId) && textEquals(row?.name, attribute));
    validation = match?.validation ?? '';
  }
  const column = castColumnFor({ validation }, ctx.config);
  return { column, kind: column === 'numericvalue' ? 'f' : column === 'datetimevalue' ? 't' : 's' };
}

/** The data rows of the attribute a criterion names: by id, or by name among the attributes of `userPoolID`. */
function attributeRows(ctx: ExtendContext, field: string): ExtendDataRow[] {
  if (cfIsNumeric(field)) return ctx.data.filter((row) => row.attributeid === cfToNumber(field));
  return ctx.data.filter((row) => {
    const attribute = ctx.attributes.get(row.attributeid);
    // Two pools bind as one comma-list value, so a criterion by attribute name then matches no attribute, as in legacy.
    return attribute !== undefined && textEquals(attribute.siteid, ctx.poolValue) && textEquals(attribute.name, field);
  });
}

/** The extended-attribute criterion of a field without a table [legacy: core/mura/user/userGateway.cfc:422-505]. */
function extendedPredicate(param: QueryParam, ctx: ExtendContext): Predicate {
  const condition = paramCondition(param);
  const rows = attributeRows(ctx, param.field);
  const userId = (row: SearchRow): string => idKey(row.candidate.person.userid);
  if (condition === 'is') {
    const all = new Set(rows.map((row) => idKey(row.baseid)));
    const nullValued = new Set(rows.filter((row) => row.attributevalue === null).map((row) => idKey(row.baseid)));
    return (row) => !all.has(userId(row)) || nullValued.has(userId(row));
  }
  let cast: { column: keyof ExtendDataRow; kind: Kind } = { column: 'attributevalue', kind: 's' };
  let dataType = param.dataType;
  if (condition !== 'like') {
    cast = castFor(ctx, param.field);
    if (cast.column === 'datetimevalue') dataType = 'timestamp';
    if (cast.column === 'numericvalue') dataType = 'Numeric';
  }
  const test = valueTest(condition, param, dataType);
  const matching = new Set(rows.filter((row) => test(sqlValue(row[cast.column]), cast.kind) === true).map((row) => idKey(row.baseid)));
  return (row) => matching.has(userId(row));
}

/** The criterion of a `table.column` field over the user or an implied-join row. */
function fieldPredicate(param: QueryParam): Predicate {
  const parts = cfListToArray(param.field, '.');
  if (parts.length > 2) throw queryError(`The multi-part identifier "${param.field}" could not be bound.`);
  const tableKey = (parts[0] ?? '').toLowerCase();
  const columnKey = (parts[1] ?? '').toLowerCase();
  const test = valueTest(paramCondition(param), param, param.dataType);
  if (tableKey === 'tusers') {
    const column = TUSERS_COLUMNS.get(columnKey);
    if (column === undefined) throw queryError(`Invalid column name '${parts[1] ?? ''}'.`);
    return (row) => test(sqlValue(column.read(row.candidate)), column.kind);
  }
  const kind = columnKey === 'tenant_id' ? undefined : JOIN_TABLES.get(tableKey)?.kinds.get(columnKey);
  if (kind === undefined) throw queryError(`Invalid column name '${parts[1] ?? ''}'.`);
  return (row) => test(sqlValue(row.joined.get(tableKey)?.[columnKey]), kind);
}

/** The `and ( … )` the params add to the WHERE clause, with legacy's grouping rules [legacy: core/mura/user/userGateway.cfc:366-510]. */
function paramTokens(params: readonly QueryParam[], ctx: ExtendContext): Token[] {
  const tokens: Token[] = [];
  let started = false;
  let openGrouping = false;
  const open = (connector: 'and' | 'or', negate: boolean): void => {
    if (!openGrouping) tokens.push(connector);
    tokens.push(...(negate ? (['not', '('] as const) : (['('] as const)));
    openGrouping = true;
  };
  for (const param of params) {
    if (!param.isValid || cfEq(param.field, 'tusers.siteid')) continue;
    if (!started) {
      tokens.push('and', '(');
      openGrouping = true;
    }
    const relationship = param.relationship.toLowerCase();
    if (relationship === 'opengrouping' || relationship === '(' || relationship === 'andopengrouping' || relationship === 'and (') {
      open('and', false);
    } else if (relationship === 'oropengrouping' || relationship === 'or (') {
      open('or', false);
    } else if (relationship === 'and not (') {
      open('and', true);
    } else if (relationship === 'or not (') {
      open('or', true);
    } else if (relationship === 'closegrouping' || relationship === ')') {
      tokens.push(')');
      openGrouping = false;
    } else if (!openGrouping && (relationship === 'and' || relationship === 'or')) {
      tokens.push(relationship);
    }
    started = true;
    if (param.field === '') continue;
    tokens.push(cfListToArray(param.field, '.').length > 1 ? fieldPredicate(param) : extendedPredicate(param, ctx));
    openGrouping = false;
  }
  if (started) tokens.push(')');
  return tokens;
}

/** Each candidate paired with every combination of its implied-join rows; a user without a row in a joined table drops out. */
function joinedRows(candidates: readonly Candidate[], joins: readonly string[], rows: ReadonlyMap<string, readonly QueryResultRow[]>): SearchRow[] {
  const byUser = new Map(
    joins.map((key) => {
      const index = new Map<string, QueryResultRow[]>();
      for (const row of rows.get(key) ?? []) {
        const id = idKey(text(row.userid));
        index.set(id, [...(index.get(id) ?? []), row]);
      }
      return [key, index] as const;
    }),
  );
  return candidates.flatMap((candidate) => {
    let combos: Map<string, QueryResultRow>[] = [new Map()];
    for (const [key, index] of byUser) {
      const matches = index.get(idKey(candidate.person.userid)) ?? [];
      combos = combos.flatMap((combo) => matches.map((row) => new Map(combo).set(key, row)));
    }
    return combos.map((joined) => ({ candidate, joined }));
  });
}

/** Options of `getAdvancedSearch`, as its deprecated arguments and the feed's sort properties give them. */
export interface AdvancedSearchOptions {
  siteid?: string;
  isPublic?: unknown;
  sortBy?: string;
  sortDirection?: string;
  countOnly?: boolean;
}

/** `userGateway.getAdvancedSearch` of criteria [legacy: core/mura/user/userGateway.cfc:164-592] over people's rows; `countOnly` answers `[{count}]`. */
export async function getAdvancedSearch(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  { siteid = '', isPublic = '', sortBy = 'lname', sortDirection = 'asc', countOnly = false }: AdvancedSearchOptions = {},
): Promise<LegacyQuery> {
  const feed = userFeed(criteria, isPublic);
  const siteId = siteid !== '' ? siteid : feed.siteId !== '' ? feed.siteId : viewer.site;
  const joins = impliedJoins(feed.params);
  const extendedSort = !countOnly && !listFindNoCase(SORT_OPTIONS, sortBy);
  const order = countOnly || extendedSort ? [] : builtInOrder(sortBy, sortDirection);
  const descending = extendedSort && validSortDirection(sortDirection);
  const params = parseParams(feed.params);
  const extended = extendedSort || params.some(isExtendedParam);
  const pools = advancedPools(await registryEntry(deps, viewer.tid), feed.isPublic);

  const tenantIds = [...new Set([...pools.map((pool) => pool.tenantId), ...(extended ? [viewer.tid] : [])])];
  const tables = feed.categoryId === '' ? joins : [...new Set([...joins, 'tusersinterests'])];
  const loaded: TenantRows[] = [];
  for (const tenantId of tenantIds) {
    loaded.push(await loadTenantRows(deps, tenantId, { pool: pools.some((pool) => pool.tenantId === tenantId), extended, tables }));
  }
  const candidates = await withAccounts(deps, loaded.flatMap((rows) => rows.persons));
  const memberships = feed.groupId === '' ? new Map<string, string[]>() : await membershipsOf(deps, candidates);
  const joinRows = new Map(tables.map((key) => [key, loaded.flatMap((rows) => rows.joins.get(key) ?? [])]));
  const ctx: ExtendContext = {
    data: loaded.flatMap((rows) => rows.extendData),
    attributes: new Map(loaded.flatMap((rows) => rows.attributes).map((row) => [row.attributeid, row])),
    siteId,
    poolValue: pools.map((pool) => pool.siteId).join(','),
    config: deps.extendConfig ?? EXTEND_CONFIG_DEFAULTS,
  };

  const typeValue = numericParam(feed.type, 'INTEGER');
  const tokens: Token[] = [(row) => numberEquals(row.candidate.account.type, typeValue)];
  const and = (predicate: Predicate): void => {
    tokens.push('and', predicate);
  };
  if (cfIsNumeric(feed.isPublic)) {
    const isPublicValue = cfToNumber(feed.isPublic);
    and((row) => numberEquals(row.candidate.account.isPublic, isPublicValue));
  }
  and((row) => pools.some((pool) => textEquals(row.candidate.account.siteId, pool.siteId)));
  tokens.push(...paramTokens(params, ctx));
  if (feed.categoryId !== '') {
    const categories = cfListToArray(feed.categoryId);
    const interested = new Set(
      (joinRows.get('tusersinterests') ?? [])
        .filter((row) => categories.some((id) => textEquals(row.categoryid, id)))
        .map((row) => idKey(text(row.userid))),
    );
    and((row) => interested.has(idKey(row.candidate.person.userid)));
  }
  if (feed.groupId !== '') {
    const groups = cfListToArray(feed.groupId);
    and((row) => (memberships.get(idKey(row.candidate.person.userid)) ?? []).some((member) => groups.some((id) => textEquals(member, id))));
  }
  if (cfIsNumeric(feed.inactive)) {
    const inactive = cfToNumber(feed.inactive);
    and((row) => numberEquals(row.candidate.account.inactive, inactive));
  }
  if (!viewer.isS2) and((row) => numberEquals(row.candidate.account.s2, 0));
  const where = compileWhere(tokens);

  const matched = joinedRows(candidates, joins, joinRows).filter((row) => where(row) === true);
  if (countOnly) return legacyQuery(['count'], [{ count: matched.length }]);

  let sorted: { candidate: Candidate; sortValue: unknown }[];
  if (extendedSort) {
    const cast = castFor(ctx, sortBy);
    const values = new Map<string, unknown[]>();
    for (const row of ctx.data) {
      const attribute = ctx.attributes.get(row.attributeid);
      if (attribute === undefined || !textEquals(attribute.siteid, siteId) || !textEquals(attribute.name, sortBy)) continue;
      const id = idKey(row.baseid);
      values.set(id, [...(values.get(id) ?? []), row[cast.column]]);
    }
    // The extended sort is a left join, so a user with several matching values appears once per value.
    sorted = matched.flatMap(({ candidate }) =>
      (values.get(idKey(candidate.person.userid)) ?? [null]).map((sortValue) => ({ candidate, sortValue })),
    );
    sorted.sort((a, b) => {
      const order = compareSql(sqlValue(a.sortValue), sqlValue(b.sortValue));
      return order !== 0 ? (descending ? -order : order) : compareCandidates(a.candidate, b.candidate, []);
    });
  } else {
    sorted = matched.map(({ candidate }) => ({ candidate, sortValue: null }));
    sorted.sort((a, b) => compareCandidates(a.candidate, b.candidate, order));
  }
  const exts = await photoExtensions(deps, sorted.map(({ candidate }) => candidate));
  return legacyQuery([...SEARCH_FIELD_LIST], sorted.map(({ candidate }) => resultRow(candidate, SEARCH_FIELD_LIST, exts)));
}

/** A query cell by column name, matched ignoring case. */
function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const key = Object.keys(row).find((name) => name.toLowerCase() === column.toLowerCase());
  return key === undefined ? undefined : row[key];
}

/** `siteid=all` of `cusers.listUsers` [legacy: admin/core/controllers/cusers.cfc:186-188]: per tenant for S2, merged by name; else own site. */
export async function searchAllSites(
  deps: Pick<SearchDeps, 'db'>,
  viewer: ViewerScope,
  fn: (scope: ViewerScope, siteid: string) => Promise<LegacyQuery>,
): Promise<LegacyQuery> {
  if (!viewer.isS2) return fn(viewer, viewer.site);
  const results: LegacyQuery[] = [];
  for (const { tenantId, siteId } of await registeredTenants(deps.db)) {
    results.push(await fn({ ...viewer, tid: tenantId, site: siteId }, ''));
  }
  const rows = results.flatMap((result) => result.rows);
  const keys = ['lname', 'fname', 'userid'];
  rows.sort((a, b) => {
    for (const key of keys) {
      const order = compareSql(sqlValue(cell(a, key)), sqlValue(cell(b, key)));
      if (order !== 0) return order;
    }
    return 0;
  });
  return legacyQuery([...(results[0]?.columnList ?? [])], rows);
}

/** `utility.getNextN` [legacy: core/mura/utility.cfc:126-178]. */
export function nextN(total: number, recordsPerPage: number, startRow: number, pageBuffer = 3): NextN {
  const numberOfPages = Math.ceil(total / recordsPerPage);
  const currentPageNumber = Math.ceil(startRow / recordsPerPage);
  let firstPage = currentPageNumber > pageBuffer ? currentPageNumber - pageBuffer : 1;
  let lastPage = firstPage + 2 * pageBuffer;
  if (numberOfPages < lastPage) lastPage = numberOfPages;
  if (lastPage - firstPage < 2 * pageBuffer) firstPage = Math.max(1, lastPage - 2 * pageBuffer);
  let next = (currentPageNumber + 1) * recordsPerPage - recordsPerPage + 1;
  const previous = Math.max(currentPageNumber - 1, 1) * recordsPerPage - recordsPerPage + 1;
  const through = total < next ? total : next - 1;
  if (next > total) next = 1;
  return {
    TotalRecords: total,
    RecordsPerPage: recordsPerPage,
    NumberOfPages: numberOfPages,
    CurrentPageNumber: currentPageNumber,
    firstPage,
    lastPage,
    next,
    previous,
    through,
    startrow: startRow,
  };
}

/** The page `cusers` shows [legacy: admin/core/controllers/cusers.cfc:498-518]: its rows, the iterator's page index and the nextN struct. */
export function pageRows<R>(rows: readonly R[], { startRow = 1, recordsPerPage = 25 }: { startRow?: number; recordsPerPage?: number } = {}): UsersPage<R> {
  const perPage = recordsPerPage >= 1 ? recordsPerPage : 25;
  let start = startRow >= 1 ? startRow : 1;
  if (start > rows.length) start = 1;
  const nextn = nextN(rows.length, perPage, start, 3);
  // The user iterator's final setPage(startrow) reads the start row as a page number.
  let pageIndex = start;
  let recordIndex = (pageIndex - 1) * perPage;
  if (recordIndex > rows.length) {
    pageIndex = 1;
    recordIndex = 0;
  }
  return { rows: rows.slice(recordIndex, Math.min(rows.length, pageIndex * perPage)), pageIndex, nextn };
}

