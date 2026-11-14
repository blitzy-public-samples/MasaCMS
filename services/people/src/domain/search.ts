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
import { systemClock, throwIfRequestAborted, type Clock } from '@opt2/platform/service-kit';
import type { AccountCountRequest, AccountView, AccountWhere, IdentityClient } from '../legacy/identity-client.js';
import {
  LEGACY_CHAR_CI_COLLATION,
  PERSON_LAST_NAME_ORDER,
  PERSON_NAME_ORDER,
  type Page,
  type PeopleRepository,
  type PersonCursor,
  type PersonNameLike,
  type PersonOrderScope,
  type PersonQueryColumn,
  type PersonSortKey,
} from '../repo/repository.js';
import { ADDRESS, FAVORITE, INTEREST, PERSON, TAG, type ExtendAttributeRow, type ExtendDataRow, type PersonRow } from '../repo/tables.js';
import { castColumnFor, EXTEND_CONFIG_DEFAULTS, type ExtendConfig } from './extended-data.js';
import { observePersons, type PersonObserver, type PersonObserverDeps } from './roster-protocol.js';

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
  /** Set by the `siteid=all` reads of an S2 viewer: accounts come from every registered site, which identity admits S2 to. */
  allSites?: true;
}

/** The viewer of verified user claims. */
export function viewerScope(claims: Pick<UserClaims, 'tid' | 'site' | 's2'>): ViewerScope {
  return { tid: claims.tid, site: claims.site, isS2: claims.s2 };
}

/** Collaborators of the reads; without `photoFileExts` (strategies-content's photo lookup) every `photoFileExt` is ''. */
export interface SearchDeps {
  db: TenantDb;
  repo: PeopleRepository;
  identity: Pick<IdentityClient, 'readAccounts' | 'readAccountsAllSites' | 'lookupMemberships' | 'countAccounts' | 'usernameCandidates'>;
  photoFileExts?: (fileIds: readonly (string | null | undefined)[]) => Promise<ReadonlyMap<string, string>>;
  extendConfig?: Pick<ExtendConfig, 'strictExtendedData'>;
  /** Times the wait for users a roster operation keeps closed; defaults to the system clock. */
  clock?: Clock;
  /** Waits between closed-user polls; defaults to a timer. */
  sleep?: (ms: number) => Promise<unknown>;
}

/** The roster observer collaborators of `deps`. */
function observerDeps(deps: SearchDeps): PersonObserverDeps {
  return { db: deps.db, repo: deps.repo, clock: deps.clock ?? systemClock, sleep: deps.sleep };
}

/** The user ids of `persons`, which an observed list read covers. */
function personIds(persons: readonly PersonRow[]): string[] {
  return persons.map((person) => person.userid);
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

/** The cusers paging `before()` leaves: `rc.startrow` and `rc.recordsperpage`. */
export interface UsersPaging {
  startRow?: number;
  recordsPerPage?: number;
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

/** A `tusers` column people can read: its kind, its value in one candidate and, for people's columns, the person column. */
interface UserColumn {
  kind: Kind;
  read: (c: Candidate) => unknown;
  person?: PersonQueryColumn;
}

const PERSON_KINDS: ReadonlyMap<string, Kind> = new Map(PERSON.columns.map((column) => [column.name, column.type as Kind]));

function personColumn(name: PersonQueryColumn & keyof PersonRow): UserColumn {
  return { kind: PERSON_KINDS.get(name) ?? 's', read: (c) => c.person[name], person: name };
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

/** One LIKE pattern token: `%` for any run of code units, else a test of exactly one code unit. */
type LikeToken = '%' | ((unit: string) => boolean);

/** ECMAScript's non-unicode ignoreCase `Canonicalize` of one UTF-16 code unit, as a regex `i` flag compares literals. */
function canonicalUnit(unit: string): string {
  const upper = unit.toUpperCase();
  if (upper.length !== 1) return unit;
  return unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? unit : upper;
}

/** A SQL Server LIKE pattern as a case-insensitive whole-value matcher: `%`, `_` and `[...]` classes, no escape character; O(value × pattern) per test. */
export function likeMatcher(pattern: string): { test(value: string): boolean } {
  const tokens: LikeToken[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    const close = char === '[' ? pattern.indexOf(']', i + 1) : -1;
    if (char === '%') {
      if (tokens.at(-1) !== '%') tokens.push('%');
    } else if (char === '_') {
      tokens.push(() => true);
    } else if (close !== -1) {
      const body = pattern.slice(i + 1, close);
      const negated = body.startsWith('^');
      const unitClass = new RegExp(`^[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')}]$`, 'i');
      tokens.push((unit) => unitClass.test(unit));
      i = close;
    } else {
      const literal = canonicalUnit(char);
      tokens.push((unit) => canonicalUnit(unit) === literal);
    }
  }
  return {
    test(value: string): boolean {
      // Every token but `%` consumes one code unit, so a mismatch only retries the latest `%` one unit further on.
      let t = 0;
      let v = 0;
      let lastRun = -1;
      let runEnd = 0;
      while (v < value.length) {
        const token = tokens[t];
        if (token === '%') {
          lastRun = t;
          runEnd = v;
          t += 1;
        } else if (token !== undefined && token(value.charAt(v))) {
          t += 1;
          v += 1;
        } else if (lastRun !== -1) {
          runEnd += 1;
          v = runEnd;
          t = lastRun + 1;
        } else {
          return false;
        }
      }
      while (tokens[t] === '%') t += 1;
      return t === tokens.length;
    },
  };
}

/** A PostgreSQL `COLLATE "C" ILIKE … ESCAPE ''` pattern matching every value `likeMatcher(pattern)` matches: ASCII literals kept, other tokens `%`. */
export function likePrefilter(pattern: string): string {
  let prefilter = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    const close = char === '[' ? pattern.indexOf(']', i + 1) : -1;
    if (close !== -1) i = close;
    // Under COLLATE "C" an ASCII literal folds as canonicalUnit does, and no other unit folds to ASCII; `%` spans surrogate pairs.
    const literal = close === -1 && char !== '%' && char !== '_' && char.charCodeAt(0) < 128;
    if (literal) prefilter += char;
    else if (!prefilter.endsWith('%')) prefilter += '%';
  }
  return prefilter;
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
      const pattern = likeMatcher(likeText(bindValue(dataType, param.criteria), 's'));
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

/** CFML `value eq n` for a literal 0 or 1: a boolean word compares as its 1 or 0 (ACF: `'no' eq 0`, `'TRUE' eq 1`). */
function eqFlag(value: unknown, n: 0 | 1): boolean {
  const word = booleanWordValue(value);
  return word === undefined ? cfEq(text(value), String(n)) : word === n;
}

/** CFML `value eq 0`. */
function isZero(value: unknown): boolean {
  return eqFlag(value, 0);
}

/** A numeric `cfqueryparam` of a request value; throws ACF's binding error for non-numeric text. */
function numericParam(value: unknown, sqlType: string): number {
  if (cfIsNumeric(value)) return cfToNumber(value);
  throw queryError(`Invalid data ${text(value)} for CFSQLTYPE CF_SQL_${sqlType}.`);
}

/** 1 or 0 for a Java-trimmed `true|yes|false|no` word in any case, as ACF reads it in `eq` and an integer binding. */
function booleanWordValue(value: unknown): 0 | 1 | undefined {
  if (typeof value !== 'string') return undefined;
  const word = javaTrim(value).toLowerCase();
  if (word === 'true' || word === 'yes') return 1;
  return word === 'false' || word === 'no' ? 0 : undefined;
}

/** A `type="numeric"` function argument; throws ACF's argument-type error for a non-numeric value. */
export function numericArgument(value: unknown, argument: string, fn: string): number {
  if (cfIsNumeric(value)) return cfToNumber(value);
  throw queryError(`The ${argument.toUpperCase()} argument passed to the ${fn} function is not of type numeric.`);
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

/** getAdvancedSearch's `userPoolID` [legacy: core/mura/user/userGateway.cfc:215-223]: one pool for 0, 1 or a boolean word, else both when they differ. */
function advancedPools(entry: TenantRegistryEntry, isPublic: unknown): UserPool[] {
  const publicPool = userPool(entry, true);
  if (isZero(isPublic)) return [userPool(entry, false)];
  if (eqFlag(isPublic, 1)) return [publicPool];
  const privatePool = userPool(entry, false);
  return cfEq(publicPool.siteId, privatePool.siteId) ? [publicPool] : [publicPool, privatePool];
}

/** The candidates of `persons` in their order: each with the account `where` matches, of every site for an `allSites` viewer. */
async function withAccounts(
  deps: Pick<SearchDeps, 'identity'>,
  viewer: Pick<ViewerScope, 'allSites'>,
  persons: readonly PersonRow[],
  where: AccountWhere,
): Promise<Candidate[]> {
  if (persons.length === 0) return [];
  const userIds = persons.map((person) => person.userid);
  const accounts = viewer.allSites === true ? await deps.identity.readAccountsAllSites(userIds, where) : await deps.identity.readAccounts(userIds, where);
  const byId = new Map([...accounts.values()].map((account) => [idKey(account.userId), account]));
  // A person identity does not list (a pending or missing account) has no complete legacy row.
  return persons.flatMap((person) => {
    const account = byId.get(idKey(person.userid));
    return account === undefined ? [] : [{ person, account }];
  });
}

/** Each candidate's stored `tusersmemb` group ids, by user id key, from one identity lookup. */
async function membershipsOf(deps: Pick<SearchDeps, 'identity'>, candidates: readonly Candidate[]): Promise<Map<string, string[]>> {
  if (candidates.length === 0) return new Map();
  const groups = await deps.identity.lookupMemberships(candidates.map((c) => c.person.userid));
  return new Map([...groups].map(([userId, groupIds]) => [idKey(userId), groupIds]));
}

/** Persons one keyset read returns; each batch costs one identity account lookup. */
const SCAN_BATCH = 500;

/** One keyset page of persons in the transaction tenant, after `after`. */
type PersonPager = (tx: TenantTx, after: PersonCursor | null) => Promise<Page<PersonRow, PersonCursor>>;

/** A pager of `pagePersonsInOrder` over `scope` by `orderBy`, then userid. */
function orderedPager(repo: PeopleRepository, scope: PersonOrderScope, orderBy: readonly PersonSortKey[]): PersonPager {
  return (tx, after) => repo.pagePersonsInOrder(tx, scope, { orderBy, after, limit: SCAN_BATCH });
}

/** One page of persons and what was read beside it in the page's transaction. */
interface PersonBatch<B> {
  persons: PersonRow[];
  loaded: B;
}

/** What `match` keeps of each page of `pager` in `tenantId`, each page and its `load` rows observed with `match`'s identity reads (in `observer` when given); a stopped consumer or an abandoned request reads no further page. */
async function* personBatches<B, T>(
  deps: SearchDeps,
  tenantId: string,
  pager: PersonPager,
  load: (tx: TenantTx, persons: PersonRow[]) => Promise<B>,
  match: (batch: PersonBatch<B>) => Promise<readonly T[]>,
  observer?: PersonObserver,
): AsyncGenerator<T> {
  let after: PersonCursor | null = null;
  do {
    throwIfRequestAborted();
    const cursor: PersonCursor | null = after;
    const people = (reader: PersonObserver) =>
      reader.read(
        tenantId,
        async (tx) => {
          const read = await pager(tx, cursor);
          return { page: read, loaded: await load(tx, read.rows) };
        },
        ({ page: read }) => personIds(read.rows),
      );
    const identity = async ({ page: read, loaded }: Awaited<ReturnType<typeof people>>) => ({
      page: read,
      matched: read.rows.length === 0 ? [] : await match({ persons: read.rows, loaded }),
    });
    const { page, matched } = observer === undefined ? await observePersons(observerDeps(deps), people, identity) : await identity(await people(observer));
    yield* matched;
    after = page.next;
  } while (after !== null);
}

/** Nothing read beside a page. */
const NOTHING = (): Promise<undefined> => Promise.resolve(undefined);

/** The values of the `compare`-ordered `streams` in one `compare` order; equal values keep stream order. */
async function* mergeOrdered<T>(streams: readonly AsyncIterator<T>[], compare: (a: T, b: T) => number): AsyncGenerator<T> {
  const heads: { value: T; stream: AsyncIterator<T> }[] = [];
  try {
    for (const stream of streams) {
      const first = await stream.next();
      if (first.done !== true) heads.push({ value: first.value, stream });
    }
    while (heads.length > 0) {
      // Heads stay in stream order, so the first of equal heads wins.
      let best = 0;
      heads.forEach((head, index) => {
        if (compare(head.value, (heads[best] as { value: T }).value) < 0) best = index;
      });
      const head = heads[best] as { value: T; stream: AsyncIterator<T> };
      yield head.value;
      const next = await head.stream.next();
      if (next.done === true) heads.splice(best, 1);
      else head.value = next.value;
    }
  } finally {
    for (const { stream } of heads) await stream.return?.();
  }
}

/** The matches of a scan in `compare` order: every one counted, only the first `limit` held, ties in offer order. */
interface Selection<T> {
  offer(value: T): void;
  /** How many values were offered. */
  readonly count: number;
  /** The first `limit` offered values in order. */
  leading(): T[];
}

/** A selection holding at most 2 × `limit` values at a time; `Infinity` keeps every value. */
function selection<T>(limit: number, compare: (a: T, b: T) => number): Selection<T> {
  const held: T[] = [];
  let count = 0;
  // Array sort is stable and held values precede later offers, so equal values keep their offer order.
  const trim = (): void => {
    held.sort(compare);
    if (held.length > limit) held.length = limit;
  };
  return {
    offer(value) {
      count += 1;
      held.push(value);
      if (held.length >= 2 * limit) trim();
    },
    get count() {
      return count;
    },
    leading() {
      trim();
      return held;
    },
  };
}

/** Photo file extensions of the candidates' `photoFileID`s; empty without a lookup. */
async function photoExtensions(deps: Pick<SearchDeps, 'photoFileExts'>, candidates: readonly Candidate[]): Promise<ReadonlyMap<string, string>> {
  if (deps.photoFileExts === undefined) return new Map();
  return deps.photoFileExts(candidates.map((c) => c.person.photofileid));
}

/** One ORDER BY key over candidates; `person` names the person column it reads, if any. */
interface OrderKey {
  read: (c: Candidate) => unknown;
  descending: boolean;
  person?: PersonQueryColumn;
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

/** `keys` as `pagePersonsInOrder` sort keys, which order persons as `compareCandidates` does; undefined when a key reads an account column. */
function personOrder(keys: readonly OrderKey[]): PersonSortKey[] | undefined {
  const order: PersonSortKey[] = [];
  for (const { person, descending } of keys) {
    if (person === undefined) return undefined;
    order.push({ column: person, descending });
  }
  return order;
}

const BY_NAME: readonly OrderKey[] = [
  { read: (c) => c.person.lname, descending: false },
  { read: (c) => c.person.fname, descending: false },
];

/** getUsers' order, which `PERSON_NAME_ORDER` reads persons in: last name, first name, userid. */
const byName = (a: Candidate, b: Candidate): number => compareCandidates(a, b, BY_NAME);

/** Arguments of `getUsers`; `siteid` only switches the pool filter on, as the pools come from the viewer's tenant. */
export interface UsersQueryArgs {
  siteid?: string;
  ispublic?: number | string;
  isunassigned?: unknown;
  showsuperusers?: unknown;
}

const NO_EXTENSIONS: ReadonlyMap<string, string> = new Map();

/** One getUsers row of a candidate. */
function usersRow(c: Candidate): Record<string, unknown> {
  return resultRow(c, USERS_LIST_COLUMNS, NO_EXTENSIONS);
}

/** getUsers' account predicates, which identity applies; throws ACF's binding error for an `ispublic` neither numeric nor a boolean word. */
function usersWhere({ ispublic = 1, isunassigned = 0, showsuperusers = 0 }: UsersQueryArgs): AccountWhere {
  const where: AccountWhere = {};
  // ACF's `cf_sql_integer` binding, like the pool's `isPublic eq 0`, reads a boolean word as 1 or 0 [legacy: core/mura/user/userGateway.cfc:696-703].
  if (text(ispublic) !== '') where.isPublic = booleanWordValue(ispublic) ?? numericParam(ispublic, 'INTEGER');
  // Legacy's showsuperusers is inverted: a true value hides S2 users (`s2 <> 1`).
  if (flag(showsuperusers)) where.excludeS2Users = true;
  if (flag(isunassigned)) where.unassigned = true;
  return where;
}

/** A validated getUsers: identity's count of its rows, and its rows by name, read one person batch at a time. */
interface UsersRead {
  count: AccountCountRequest;
  candidates(): AsyncGenerator<Candidate>;
}

/** The persons of `scope` in `tenantId` by name whose account `where` matches, one account lookup per batch. */
function listedCandidates(deps: SearchDeps, viewer: ViewerScope, tenantId: string, scope: PersonOrderScope, where: AccountWhere): AsyncGenerator<Candidate> {
  return personBatches(deps, tenantId, orderedPager(deps.repo, scope, PERSON_NAME_ORDER), NOTHING, ({ persons }) => withAccounts(deps, viewer, persons, where));
}

/** getUsers of the site's pool, or with no `siteid` of the viewer's tenant. */
async function usersRead(deps: SearchDeps, viewer: ViewerScope, args: UsersQueryArgs): Promise<UsersRead> {
  const where = usersWhere(args);
  if ((args.siteid ?? '') === '') {
    return { count: { scope: 'tenant', where }, candidates: () => listedCandidates(deps, viewer, viewer.tid, {}, where) };
  }
  const publicPool = !isZero(args.ispublic ?? 1);
  const pool = userPool(await registryEntry(deps, viewer.tid), publicPool);
  return {
    count: { scope: 'pool', publicPool, where },
    candidates: () => listedCandidates(deps, viewer, pool.tenantId, { siteIds: [pool.siteId] }, where),
  };
}

/** The scopes of an S2 `siteid=all` read: each registered tenant and its site, with accounts of every site. */
async function allSiteScopes(deps: Pick<SearchDeps, 'db'>, viewer: ViewerScope): Promise<ViewerScope[]> {
  return (await registeredTenants(deps.db)).map(({ tenantId, siteId }) => ({ ...viewer, tid: tenantId, site: siteId, allSites: true }));
}

/** getUsers of every registered tenant for an S2 viewer, merged by name. */
async function allSitesRead(deps: SearchDeps, viewer: ViewerScope, args: Omit<UsersQueryArgs, 'siteid'>): Promise<UsersRead> {
  const scopes = await allSiteScopes(deps, viewer);
  const where = usersWhere(args);
  return {
    count: { scope: 'all-sites', where },
    candidates: () => mergeOrdered(scopes.map((scope) => listedCandidates(deps, scope, scope.tid, {}, where)), byName),
  };
}

/** A legacy query whose rows are read only as they are iterated, one person batch at a time. */
export interface StreamedQuery {
  columnList: string[];
  rows: AsyncIterable<Record<string, unknown>>;
}

/** The getUsers rows of a users read, in its order. */
async function* usersRows(read: UsersRead): AsyncGenerator<Record<string, unknown>> {
  for await (const candidate of read.candidates()) yield usersRow(candidate);
}

/** Every row of a users read, in its order. */
async function usersQuery(read: UsersRead): Promise<LegacyQuery> {
  return legacyQuery([...USERS_LIST_COLUMNS], await collect(usersRows(read)));
}

/** The page `paging` selects of a users read: identity counts the total, then persons are read only up to the page's last row. */
async function usersPage(deps: SearchDeps, read: UsersRead, paging: UsersPaging): Promise<UsersPage<Record<string, unknown>>> {
  // Identity counts accounts and people lists persons, so an account without its person row leaves the page shorter than nextn says.
  const total = await deps.identity.countAccounts(read.count);
  return rowsOf(await windowOf(read.candidates(), total, paging), usersRow);
}

/** `userGateway.getUsers` [legacy: core/mura/user/userGateway.cfc:679-716]: users of the site's pool, or with no `siteid` the viewer's tenant, by name. */
export async function getUsers(deps: SearchDeps, viewer: ViewerScope, args: UsersQueryArgs = {}): Promise<LegacyQuery> {
  return usersQuery(await usersRead(deps, viewer, args));
}

/** `getUsers` read as its rows are iterated; argument and registry errors reject before any row is read. */
export async function getUsersStream(deps: SearchDeps, viewer: ViewerScope, args: UsersQueryArgs = {}): Promise<StreamedQuery> {
  return { columnList: [...USERS_LIST_COLUMNS], rows: usersRows(await usersRead(deps, viewer, args)) };
}

/** `getUsers` as the cusers page `paging` selects, holding only the rows that page shows. */
export async function getUsersPage(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: UsersQueryArgs,
  paging: UsersPaging,
): Promise<UsersPage<Record<string, unknown>>> {
  return usersPage(deps, await usersRead(deps, viewer, args), paging);
}

/** `getUsersPage` for `siteid=all` [legacy: admin/core/controllers/cusers.cfc:186-188]: per tenant for S2, merged by name; else own site. */
export async function getAllSitesUsersPage(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: Omit<UsersQueryArgs, 'siteid'>,
  paging: UsersPaging,
): Promise<UsersPage<Record<string, unknown>>> {
  if (!viewer.isS2) return getUsersPage(deps, viewer, { ...args, siteid: viewer.site }, paging);
  return usersPage(deps, await allSitesRead(deps, viewer, args), paging);
}

/** `getUsers` for `siteid=all` [legacy: admin/core/controllers/cusers.cfc:186-188]: every tenant's users for S2, merged by name; else own site. */
export async function getAllSitesUsers(deps: SearchDeps, viewer: ViewerScope, args: Omit<UsersQueryArgs, 'siteid'>): Promise<LegacyQuery> {
  if (!viewer.isS2) return getUsers(deps, viewer, { ...args, siteid: viewer.site });
  return usersQuery(await allSitesRead(deps, viewer, args));
}

/** The getUsers arguments `getUnassignedUsers` passes. */
function unassignedArgs(args: Omit<UsersQueryArgs, 'isunassigned'>): UsersQueryArgs {
  return { ...args, ispublic: args.ispublic ?? 1, isunassigned: true };
}

/** `userManager.getUnassignedUsers` [legacy: core/mura/user/userManager.cfc:1121-1127]: `getUsers` of users without a membership. */
export function getUnassignedUsers(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: Omit<UsersQueryArgs, 'isunassigned'> = {},
): Promise<LegacyQuery> {
  return getUsers(deps, viewer, unassignedArgs(args));
}

/** `getUnassignedUsers` read as its rows are iterated. */
export function getUnassignedUsersStream(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: Omit<UsersQueryArgs, 'isunassigned'> = {},
): Promise<StreamedQuery> {
  return getUsersStream(deps, viewer, unassignedArgs(args));
}

/** Arguments of `getSearch`; `siteid` is the legacy argument the pools came from, here the viewer's verified site. */
export interface SearchQueryArgs {
  search?: string;
  siteid?: string;
  isPublic?: number | string;
}

/** Person columns getSearch matches the term against; identity's `username` is the sixth. */
const SEARCH_PERSON_COLUMNS = ['lname', 'fname', 'company', 'email', 'jobtitle'] as const;

/** Most username candidates a search asks identity for; past it the search reads every pool person with its username. */
const USERNAME_CANDIDATE_LIMIT = 5000;

/** `maxLength` of identity's `UsernameCandidateRequest` pattern; a longer prefilter reads every pool person with its username. */
const USERNAME_CANDIDATE_PATTERN_MAX = 2000;

/** The person prefilter of a search: `pattern` or a username candidate; undefined when every pool person must be read. */
async function searchNameLike(
  deps: SearchDeps,
  like: { test(value: string): boolean },
  pattern: string,
  publicPool: boolean,
  where: AccountWhere,
): Promise<PersonNameLike | undefined> {
  // A prefilter without a literal matches every value.
  if (!/[^%]/.test(pattern)) return undefined;
  // JSON Schema counts maxLength in code points.
  if ([...pattern].length > USERNAME_CANDIDATE_PATTERN_MAX) return undefined;
  const candidates = await deps.identity.usernameCandidates({ publicPool, pattern, where, limit: USERNAME_CANDIDATE_LIMIT });
  if (!candidates.complete) return undefined;
  return { pattern, orUserIds: candidates.items.filter(({ username }) => like.test(username)).map(({ userId }) => userId) };
}

/** getSearch's matches in last-name order, at most SEARCH_MAX_ROWS of them; an empty term matches nothing. */
async function* searchMatches(deps: SearchDeps, viewer: ViewerScope, { search = '', isPublic = 0 }: SearchQueryArgs): AsyncGenerator<Candidate> {
  // ACF checks the numeric isPublic argument at the call, before any query [legacy: core/mura/user/userManager.cfc:812].
  const isPublicValue = numericArgument(isPublic, 'isPublic', 'getSearch');
  // Legacy adds `and 0=1` for an empty term.
  if (search === '') return;
  const publicPool = !isZero(isPublic);
  const pool = userPool(await registryEntry(deps, viewer.tid), publicPool);
  const like = likeMatcher(`%${search}%`);
  const where: AccountWhere = viewer.isS2 ? { isPublic: isPublicValue } : { isPublic: isPublicValue, s2: 0 };
  const personMatches = (person: PersonRow): boolean =>
    SEARCH_PERSON_COLUMNS.some((column) => {
      const value = person[column];
      return value !== null && like.test(value);
    });
  const nameLike = await searchNameLike(deps, like, likePrefilter(`%${search}%`), publicPool, where);
  const usernameIds = new Set((nameLike?.orUserIds ?? []).map(idKey));
  const scope: PersonOrderScope = nameLike === undefined ? { siteIds: [pool.siteId] } : { siteIds: [pool.siteId], nameLike };
  let found = 0;
  // Past the prefilter, only a person whose own columns match or a username candidate can match.
  const asked = (persons: PersonRow[]): PersonRow[] =>
    nameLike === undefined ? persons : persons.filter((person) => personMatches(person) || usernameIds.has(idKey(person.userid)));
  const pager = orderedPager(deps.repo, scope, PERSON_LAST_NAME_ORDER);
  for await (const c of personBatches(deps, pool.tenantId, pager, NOTHING, ({ persons }) => withAccounts(deps, viewer, asked(persons), where))) {
    if (!personMatches(c.person) && (c.account.username === null || !like.test(c.account.username))) continue;
    yield c;
    found += 1;
    if (found === SEARCH_MAX_ROWS) return;
  }
}

/** `userGateway.getSearch` [legacy: core/mura/user/userGateway.cfc:124-162]: pool users LIKE `%search%` on six columns, by last name, at most 2100. */
export async function getSearch(deps: SearchDeps, viewer: ViewerScope, args: SearchQueryArgs = {}): Promise<LegacyQuery> {
  const matched = await collect(searchMatches(deps, viewer, args));
  const exts = await photoExtensions(deps, matched);
  return legacyQuery([...SEARCH_FIELD_LIST], matched.map((c) => resultRow(c, SEARCH_FIELD_LIST, exts)));
}

/** `getSearch` as the cusers page `paging` selects, holding at most two pages; `TotalRecords` counts at most the 2100 rows getSearch returns. */
export async function getSearchPage(
  deps: SearchDeps,
  viewer: ViewerScope,
  args: SearchQueryArgs,
  paging: UsersPaging,
): Promise<UsersPage<Record<string, unknown>>> {
  const page = await heldPage(searchMatches(deps, viewer, args), paging);
  const exts = await photoExtensions(deps, page.rows);
  return rowsOf(page, (c) => resultRow(c, SEARCH_FIELD_LIST, exts));
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
    return { read: column.read, descending, person: column.person };
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

/** The rows of one batch of pool persons an advanced search reads beside them: their extended data and implied-join rows. */
interface BatchRows {
  extendData: ExtendDataRow[];
  joins: Map<string, QueryResultRow[]>;
}

/** The rows of a join table in the transaction tenant whose userid is one of `userIds`, read behind its unit's window phase. */
async function tenantTableRows(repo: PeopleRepository, tx: TenantTx, table: JoinTable, userIds: readonly string[]): Promise<QueryResultRow[]> {
  if (userIds.length === 0) return [];
  // The repository's char-id comparison: case-insensitive, trailing spaces ignored, served by the (tenant_id, userid) indexes.
  const sql =
    `SELECT * FROM ${qualified(repo.schema, table.table)} WHERE tenant_id = $1` +
    ` AND userid COLLATE ${qualified(repo.schema, LEGACY_CHAR_CI_COLLATION)} = ANY ($2::bpchar[])`;
  return repo.read(tx, table.unit, async () => (await tx.query(sql, [tx.tenantId, [...userIds]])).rows);
}

/** The extended data (when `extended`) and the `tables` rows of one batch of persons. */
async function loadBatchRows(
  repo: PeopleRepository,
  tx: TenantTx,
  persons: readonly PersonRow[],
  needs: { extended: boolean; tables: readonly string[] },
): Promise<BatchRows> {
  const userIds = persons.map((person) => person.userid);
  const extendData = needs.extended ? await repo.listExtendData(tx, userIds) : [];
  const joins = new Map<string, QueryResultRow[]>();
  for (const key of needs.tables) {
    const table = JOIN_TABLES.get(key);
    if (table !== undefined) joins.set(key, await tenantTableRows(repo, tx, table, userIds));
  }
  return { extendData, joins };
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

/** One advanced-search result row before projection: the user and the extended-sort value its row carries. */
interface SortedMatch {
  candidate: Candidate;
  sortValue: unknown;
}

/** A validated getAdvancedSearch: the ORDER BY of its rows and its matching rows, already in that order when `ordered`. */
interface AdvancedScan {
  compare: (a: SortedMatch, b: SortedMatch) => number;
  ordered: boolean;
  matches(): AsyncGenerator<SortedMatch>;
}

/** getAdvancedSearch's isPublic, pool, inActive and S2 terms as identity's account predicates, exact while the params stay grouped. */
function advancedAccountWhere(feed: UserFeed, pools: readonly UserPool[], viewer: ViewerScope): AccountWhere {
  const where: AccountWhere = { siteIds: pools.map((pool) => pool.siteId) };
  if (cfIsNumeric(feed.isPublic)) where.isPublic = cfToNumber(feed.isPublic);
  if (cfIsNumeric(feed.inactive)) where.inActive = cfToNumber(feed.inactive);
  if (!viewer.isS2) where.s2 = 0;
  return where;
}

/** Whether the params' `and ( … )` closes only at its end, keeping the WHERE one conjunction; a stray `)` lets an `or` escape it. */
function paramsGrouped(tokens: readonly Token[]): boolean {
  let depth = 0;
  return tokens.every((token, index) => {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    return depth > 0 || index === 0 || index === tokens.length - 1;
  });
}

/** The pools and viewer of the `advancedAccountWhere` terms when the WHERE evaluates them in place. */
interface AccountTerms {
  pools: readonly UserPool[];
  viewer: ViewerScope;
}

/** The WHERE of getAdvancedSearch over one batch [legacy: core/mura/user/userGateway.cfc:355-554], with the account terms in place when `terms` is given; throws legacy's syntax and binding errors. */
function advancedWhere(
  feed: UserFeed,
  params: readonly QueryParam[],
  ctx: ExtendContext,
  joinRows: ReadonlyMap<string, readonly QueryResultRow[]>,
  memberships: ReadonlyMap<string, string[]>,
  terms?: AccountTerms,
): Predicate {
  const typeValue = numericParam(feed.type, 'INTEGER');
  const tokens: Token[] = [(row) => numberEquals(row.candidate.account.type, typeValue)];
  const and = (predicate: Predicate): void => {
    tokens.push('and', predicate);
  };
  if (terms !== undefined) {
    if (cfIsNumeric(feed.isPublic)) {
      const isPublicValue = cfToNumber(feed.isPublic);
      and((row) => numberEquals(row.candidate.account.isPublic, isPublicValue));
    }
    and((row) => terms.pools.some((pool) => textEquals(row.candidate.account.siteId, pool.siteId)));
  }
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
  if (terms !== undefined) {
    if (cfIsNumeric(feed.inactive)) {
      const inactive = cfToNumber(feed.inactive);
      and((row) => numberEquals(row.candidate.account.inactive, inactive));
    }
    if (!terms.viewer.isS2) and((row) => numberEquals(row.candidate.account.s2, 0));
  }
  return compileWhere(tokens);
}

/** Each user's values of the extended sort attribute `sortBy` among `ctx.data`, by user id key, in data order. */
function sortValues(ctx: ExtendContext, sortBy: string, column: keyof ExtendDataRow): Map<string, unknown[]> {
  const values = new Map<string, unknown[]>();
  for (const row of ctx.data) {
    const attribute = ctx.attributes.get(row.attributeid);
    if (attribute === undefined || !textEquals(attribute.siteid, ctx.siteId) || !textEquals(attribute.name, sortBy)) continue;
    const id = idKey(row.baseid);
    values.set(id, [...(values.get(id) ?? []), row[column]]);
  }
  return values;
}

/** Validates getAdvancedSearch's criteria and options in legacy's order, then prepares the batched scan of its pools, read through `observer` when given. */
async function prepareAdvancedSearch(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  { siteid = '', isPublic = '', sortBy = 'lname', sortDirection = 'asc', countOnly = false }: AdvancedSearchOptions,
  observer?: PersonObserver,
): Promise<AdvancedScan> {
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
  const attributes = new Map<number, ExtendAttributeRow>();
  for (const tenantId of extended ? tenantIds : []) {
    for (const row of await deps.db.withTenant(tenantId, (tx) => deps.repo.listExtendAttributes(tx, {}))) attributes.set(row.attributeid, row);
  }
  const context = (data: readonly ExtendDataRow[]): ExtendContext => ({
    data,
    attributes,
    siteId,
    poolValue: pools.map((pool) => pool.siteId).join(','),
    config: deps.extendConfig ?? EXTEND_CONFIG_DEFAULTS,
  });
  // SQL Server rejects a malformed or unbindable WHERE before it reads a row, so these errors stand even for an empty pool.
  advancedWhere(feed, params, context([]), new Map(), new Map());

  const sortColumn = extendedSort ? castFor(context([]), sortBy).column : undefined;
  const compare = (a: SortedMatch, b: SortedMatch): number => {
    if (sortColumn === undefined) return compareCandidates(a.candidate, b.candidate, order);
    const byValue = compareSql(sqlValue(a.sortValue), sqlValue(b.sortValue));
    return byValue !== 0 ? (descending ? -byValue : byValue) : compareCandidates(a.candidate, b.candidate, []);
  };
  // A built-in sort on person columns is people's SQL order; an account or extended sort, or a count, reads the pool unordered.
  const personSort = countOnly || sortColumn !== undefined ? undefined : personOrder(order);
  const siteIds = pools.map((pool) => pool.siteId);
  const pager: PersonPager =
    personSort === undefined
      ? (tx, after) => deps.repo.pageQueryPersons(tx, { siteIds }, { after, limit: SCAN_BATCH })
      : orderedPager(deps.repo, { siteIds }, personSort);
  const load = (tx: TenantTx, persons: PersonRow[]): Promise<BatchRows> => loadBatchRows(deps.repo, tx, persons, { extended, tables });
  // SQL's AND binds tighter than an escaped OR, so identity applies the account and type terms only while the params stay grouped.
  const grouped = paramsGrouped(paramTokens(params, context([])));
  const terms: AccountTerms | undefined = grouped ? undefined : { pools, viewer };
  const where = grouped ? advancedAccountWhere(feed, pools, viewer) : {};
  const match = async ({ persons, loaded }: PersonBatch<BatchRows>): Promise<SortedMatch[]> => {
    const candidates = await withAccounts(deps, viewer, persons, where);
    const memberships = feed.groupId === '' ? new Map<string, string[]>() : await membershipsOf(deps, candidates);
    const ctx = context(loaded.extendData);
    const predicate = advancedWhere(feed, params, ctx, loaded.joins, memberships, terms);
    const matched = joinedRows(candidates, joins, loaded.joins).filter((row) => predicate(row) === true);
    // The extended sort is a left join, so a user with several matching values appears once per value.
    const values = sortColumn === undefined ? undefined : sortValues(ctx, sortBy, sortColumn);
    return matched.flatMap(({ candidate }) => (values?.get(idKey(candidate.person.userid)) ?? [null]).map((sortValue) => ({ candidate, sortValue })));
  };
  const poolTenants = tenantIds.filter((tenant) => pools.some((pool) => pool.tenantId === tenant));
  // Identity lists Type=2 accounts only, so a grouped feed of another type matches no account and reads none.
  const streams = (): AsyncGenerator<SortedMatch>[] =>
    !grouped || numericParam(feed.type, 'INTEGER') === 2 ? poolTenants.map((tenant) => personBatches(deps, tenant, pager, load, match, observer)) : [];

  return {
    compare,
    ordered: personSort !== undefined,
    matches: () => (personSort === undefined ? concatenated(streams()) : mergeOrdered(streams(), compare)),
  };
}

/** The values of `streams`, one stream after another. */
async function* concatenated<T>(streams: readonly AsyncIterable<T>[]): AsyncGenerator<T> {
  for (const stream of streams) yield* stream;
}

/** Every value of `values`, in order. */
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

/** An unordered scan's matches offered to a selection of the first `limit` in `compare` order; every match is counted. */
async function selected(scan: AdvancedScan, limit: number): Promise<Selection<SortedMatch>> {
  const matches = selection(limit, scan.compare);
  for await (const match of scan.matches()) matches.offer(match);
  return matches;
}

/** `userGateway.getAdvancedSearch` of criteria [legacy: core/mura/user/userGateway.cfc:164-592] over people's rows; `countOnly` answers `[{count}]`. */
export async function getAdvancedSearch(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  options: AdvancedSearchOptions = {},
): Promise<LegacyQuery> {
  const scan = await prepareAdvancedSearch(deps, viewer, criteria, options);
  if (options.countOnly === true) return legacyQuery(['count'], [{ count: (await selected(scan, 0)).count }]);
  const sorted = scan.ordered ? await collect(scan.matches()) : (await selected(scan, Number.POSITIVE_INFINITY)).leading();
  const exts = await photoExtensions(deps, sorted.map(({ candidate }) => candidate));
  return legacyQuery([...SEARCH_FIELD_LIST], sorted.map(({ candidate }) => resultRow(candidate, SEARCH_FIELD_LIST, exts)));
}

/** The SEARCH_FIELD_LIST rows of `candidates`, their photo extensions read in one lookup. */
async function searchFieldRows(deps: SearchDeps, candidates: readonly Candidate[]): Promise<Record<string, unknown>[]> {
  const exts = await photoExtensions(deps, candidates);
  return candidates.map((c) => resultRow(c, SEARCH_FIELD_LIST, exts));
}

/** The SEARCH_FIELD_LIST rows of `matches` in their order, one photo lookup per SCAN_BATCH rows. */
async function* matchRows(deps: SearchDeps, matches: AsyncIterable<SortedMatch>): AsyncGenerator<Record<string, unknown>> {
  let batch: Candidate[] = [];
  for await (const { candidate } of matches) {
    batch.push(candidate);
    if (batch.length === SCAN_BATCH) {
      yield* await searchFieldRows(deps, batch);
      batch = [];
    }
  }
  if (batch.length > 0) yield* await searchFieldRows(deps, batch);
}

/** `getAdvancedSearch` in the feed's default `lname asc` order (setParams sets no sort), read as its rows are iterated; criteria errors reject. */
export async function getAdvancedSearchStream(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  { siteid, isPublic }: Pick<AdvancedSearchOptions, 'siteid' | 'isPublic'> = {},
): Promise<StreamedQuery> {
  const scan = await prepareAdvancedSearch(deps, viewer, criteria, { siteid, isPublic });
  return { columnList: [...SEARCH_FIELD_LIST], rows: matchRows(deps, scan.matches()) };
}

/** `getAdvancedSearch` as the cusers page `paging` selects, holding only the rows that page can show. */
export async function getAdvancedSearchPage(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  options: Omit<AdvancedSearchOptions, 'countOnly'>,
  paging: UsersPaging,
): Promise<UsersPage<Record<string, unknown>>> {
  const scan = await prepareAdvancedSearch(deps, viewer, criteria, options);
  // The total needs every pool candidate's criteria evaluated, so the whole pool is read even when the page fills early.
  let page: UsersPage<SortedMatch>;
  if (scan.ordered) {
    page = await heldPage(scan.matches(), paging);
  } else {
    const matches = await selected(scan, pageReach(paging));
    page = pageFrom(matches.leading(), matches.count, paging);
  }
  const exts = await photoExtensions(deps, page.rows.map(({ candidate }) => candidate));
  return rowsOf(page, ({ candidate }) => resultRow(candidate, SEARCH_FIELD_LIST, exts));
}

/** The rows of an advanced search a caller may show, decided before the match count is known. */
export interface AdvancedSearchHold {
  /** Whether the row at 0-based `index` of the ordered matches is kept. */
  keep(index: number): boolean;
  /** No row at or past this index is kept; Infinity for no bound. */
  reach: number;
}

/** An advanced search's match count and the SEARCH_FIELD_LIST rows its hold kept, by 0-based row index. */
export interface AdvancedSearchWindow {
  count: number;
  rows: ReadonlyMap<number, Record<string, unknown>>;
}

/** `getAdvancedSearch` counting every match but keeping, with their photo extensions, only the rows `hold` names; with `observer`, its person batches are read in the caller's observation. */
export async function getAdvancedSearchWindow(
  deps: SearchDeps,
  viewer: ViewerScope,
  criteria: AdvancedSearchCriteria & UserFeedKeys,
  options: Omit<AdvancedSearchOptions, 'countOnly'>,
  hold: AdvancedSearchHold,
  observer?: PersonObserver,
): Promise<AdvancedSearchWindow> {
  const scan = await prepareAdvancedSearch(deps, viewer, criteria, options, observer);
  // A selection's limit must be a whole number of rows.
  const reach = Math.max(0, Math.ceil(hold.reach));
  const kept: [number, SortedMatch][] = [];
  let count = 0;
  if (scan.ordered) {
    for await (const match of scan.matches()) {
      if (count < reach && hold.keep(count)) kept.push([count, match]);
      count += 1;
    }
  } else {
    const matches = await selected(scan, reach);
    count = matches.count;
    for (const [index, match] of matches.leading().entries()) if (hold.keep(index)) kept.push([index, match]);
  }
  const exts = await photoExtensions(deps, kept.map(([, { candidate }]) => candidate));
  return { count, rows: new Map(kept.map(([index, { candidate }]) => [index, resultRow(candidate, SEARCH_FIELD_LIST, exts)])) };
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

/** The page size and start row `pageRows` reads, before the start row is held to the row count. */
function pagingOf({ startRow = 1, recordsPerPage = 25 }: UsersPaging): { perPage: number; start: number } {
  return { perPage: recordsPerPage >= 1 ? recordsPerPage : 25, start: startRow >= 1 ? startRow : 1 };
}

/** How many leading rows of the ordered matches the page `paging` selects can reach, whatever their count. */
function pageReach(paging: UsersPaging): number {
  const { perPage, start } = pagingOf(paging);
  return Math.ceil(start * perPage);
}

/** A row index as `Array.prototype.slice` reads one: truncated, NaN as 0. */
function sliceIndex(value: number): number {
  return Number.isNaN(value) ? 0 : Math.trunc(value);
}

/** The rows `pageRows` shows of `total` ordered rows, indices `from` to before `to`, with the iterator's page index and the nextN struct. */
function pageWindow(total: number, paging: UsersPaging): { from: number; to: number; pageIndex: number; nextn: NextN } {
  const { perPage } = pagingOf(paging);
  let { start } = pagingOf(paging);
  if (start > total) start = 1;
  const nextn = nextN(total, perPage, start, 3);
  // The user iterator's final setPage(startrow) reads the start row as a page number.
  let pageIndex = start;
  let recordIndex = (pageIndex - 1) * perPage;
  if (recordIndex > total) {
    pageIndex = 1;
    recordIndex = 0;
  }
  return { from: sliceIndex(recordIndex), to: sliceIndex(Math.min(total, pageIndex * perPage)), pageIndex, nextn };
}

/** `pageRows` over `total` ordered rows of which `leading` holds at least the first `pageReach(paging)`. */
function pageFrom<R>(leading: readonly R[], total: number, paging: UsersPaging): UsersPage<R> {
  const { from, to, pageIndex, nextn } = pageWindow(total, paging);
  return { rows: leading.slice(from, to), pageIndex, nextn };
}

/** The page `paging` selects of `total` ordered `values`, reading them only up to the page's last row. */
async function windowOf<T>(values: AsyncIterable<T>, total: number, paging: UsersPaging): Promise<UsersPage<T>> {
  const { from, to, pageIndex, nextn } = pageWindow(total, paging);
  const rows: T[] = [];
  let index = 0;
  if (index < to) {
    for await (const value of values) {
      if (index >= from) rows.push(value);
      index += 1;
      if (index >= to) break;
    }
  }
  return { rows, pageIndex, nextn };
}

/** The values of an ordered stream of unknown length that `pageRows` may show once it ends: page 1's and the requested page's. */
export interface PageHold<T> {
  offer(value: T): void;
  /** How many values were offered. */
  readonly count: number;
  /** How many offered values are held, at most two pages. */
  readonly held: number;
  /** The page `pageRows` shows of every offered value. */
  page(): UsersPage<T>;
}

/** A hold of the values the page `paging` selects can show, whatever the stream's length turns out to be. */
export function pageHold<T>(paging: UsersPaging): PageHold<T> {
  const { perPage, start } = pagingOf(paging);
  // pageWindow shows page 1 when the start row passes the total, else the requested page.
  const firstEnd = sliceIndex(perPage);
  const from = sliceIndex((start - 1) * perPage);
  const to = sliceIndex(start * perPage);
  const kept = new Map<number, T>();
  let count = 0;
  return {
    offer(value) {
      if (count < firstEnd || (count >= from && count < to)) kept.set(count, value);
      count += 1;
    },
    get count() {
      return count;
    },
    get held() {
      return kept.size;
    },
    page() {
      const window = pageWindow(count, paging);
      const rows: T[] = [];
      for (let index = window.from; index < window.to; index += 1) rows.push(kept.get(index) as T);
      return { rows, pageIndex: window.pageIndex, nextn: window.nextn };
    },
  };
}

/** The page `paging` selects of the ordered `values`, holding at most two pages of them. */
async function heldPage<T>(values: AsyncIterable<T>, paging: UsersPaging): Promise<UsersPage<T>> {
  const hold = pageHold<T>(paging);
  for await (const value of values) hold.offer(value);
  return hold.page();
}

/** `page` with each row mapped by `row`. */
function rowsOf<T, R>(page: UsersPage<T>, row: (value: T) => R): UsersPage<R> {
  return { ...page, rows: page.rows.map(row) };
}

/** The page `cusers` shows [legacy: admin/core/controllers/cusers.cfc:498-518]: its rows, the iterator's page index and the nextN struct. */
export function pageRows<R>(rows: readonly R[], paging: UsersPaging = {}): UsersPage<R> {
  return pageFrom(rows, rows.length, paging);
}

