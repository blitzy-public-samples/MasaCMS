/** Collections: feedBean, feedManager, feedDAO, feedUtility.doImport and the cfeed controller over `repo.feeds` and `legacy/remote-feed`. */
import {
  cfDateTimeFormat,
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
  cfUuid,
  isCfUuid,
  isValidVariableName,
  javaTrim,
} from '@opt2/platform/legacy-compat';
// The role names identity mints, read as permissions.ts reads them.
import { Roles } from '@opt2/platform/auth';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, type Clock } from '@opt2/platform/service-kit';
import { registryEntryForTenant, siteForTenant, tenantForRegisteredSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  feedItemRemoteId,
  importFormat,
  importItemFields,
  importOrder,
  isImportSelected,
  parseFeedXml,
  prepareRemoteFeedText,
  previewOrder,
  rssChannelItems,
} from '../legacy/remote-feed.js';
import {
  FEED_SORT_OPTIONS,
  type FeedAdvancedParamFields,
  type FeedContentItemRow,
  type FeedContentRow,
  type FeedCount,
  type FeedFields,
  type FeedParamInput,
  type FeedQuery,
} from '../repo/feed-queries.js';
import type { ContentRepository, FeedAdvancedParamInput, FeedInput as FeedRowInput } from '../repo/repository.js';
import { CONTENT, type TrashRow } from '../repo/tables.js';
// The category-pool and restrict-group reads and the ACF struct order of the trash packet are reproduced only in these
// two modules; a copy here would fork them.
import { listPoolCategories, restrictGroups, type RestrictGroupRow } from './categories.js';
import { LegacyContentBean, deleteHistAll, getActiveContent, saveContentInTx, type ContentBean, type ContentSaveSite, type SaveContentResult } from './content.js';
import { writeContextFor, type Actor, type DomainDeps, type LegacyErrors } from './context.js';
import { getModulePerm, loadMemberships, setRestriction, sitePools } from './permissions.js';
import { feedPoolSites, readAcrossContentPool, withPoolTenant, type PoolSite } from './pools.js';
import { createTrashCounter, deleteMarkerAssignments, deleteMarkers, deletedParentId, throwIn, trashObjectSubType, trashObjectType } from './trash.js';
import { WddxDate, cfStruct, wddxNumber, type WddxQuery, type WddxStruct, type WddxValue } from './wddx.js';

/** What collection reads and writes run against. */
export type FeedDeps = Pick<DomainDeps, 'db' | 'repository' | 'clock'>;

const FEED_MODULE_ID = '00000000000000000000000000000000011';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
/** `left(…, 50)` of the audit name. */
const AUDIT_NAME_LENGTH = 50;
const SECONDS_PER_DAY = 86_400;

// ---- CFML value helpers ----

/** `{ts 'yyyy-mm-dd HH:nn:ss'}`, a date as ACF renders it in string context. */
function tsText(value: Date): string {
  return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

/** The text CFML gives a simple value; complex and missing values read as ''. */
function cfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return tsText(value);
  return '';
}

function isSimple(value: unknown): value is string | number | boolean | Date {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof FeedParamsQuery);
}

/** CFML `isBoolean(x) and x`. */
function cfBool(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** CFML `isJSON`. */
function isJson(value: unknown): value is string {
  if (typeof value !== 'string' || javaTrim(value) === '') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** `value` without its milliseconds, as a date round-tripped through its `{ts}` text. */
function wholeSeconds(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

const T_DATE_TIME = /\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/;
const SPACE_DATE_TIME = /\d\d\d\d-\d\d-\d\d\s\d\d:\d\d:\d\d/;

/** bean.parseDateArg (bean.cfc:278-301) over its `String` argument: a date, '' for no date, or the text when parsing throws. */
function parseDateArg(value: unknown): Date | string {
  if (value instanceof Date) return wholeSeconds(value);
  let arg = cfText(value);
  if (T_DATE_TIME.test(arg)) arg = arg.replace('T', ' ');
  if (!SPACE_DATE_TIME.test(arg) && cfLsIsDate(arg)) {
    try {
      return cfLsParseDateTime(arg);
    } catch {
      return arg;
    }
  }
  if (cfIsDateText(arg)) {
    try {
      return cfParseDateTimeText(arg);
    } catch {
      return arg;
    }
  }
  return '';
}

/** feedBean.setRemotePubDate (feedBean.cfc:653-664). */
function remotePubDateOf(value: unknown): Date | string {
  if (value instanceof Date) return value;
  const text = cfText(value);
  if (!cfLsIsDate(text)) return '';
  try {
    return cfLsParseDateTime(text);
  } catch {
    return text;
  }
}

/** queryParam's date reading of an advanced-param criteria: lsIsDate then isDate, each with its parse. */
function criteriaDate(text: string): Date | null {
  if (cfLsIsDate(text)) return cfLsParseDateTime(text);
  return cfIsDateText(text) ? cfParseDateTimeText(text) : null;
}

/** ACF's error for a key legacy dereferences that was never set. */
export class FeedElementUndefinedError extends Error {
  override readonly name: string = 'FeedElementUndefinedError';

  constructor(element: string, scope: string) {
    super(`Element ${element.toUpperCase()} is undefined in ${scope}.`);
  }
}

/** A CF struct's case-insensitive lookup over a request or data struct. */
function lookup(data: ReadonlyMap<string, unknown>, key: string): unknown {
  return data.get(key.toLowerCase());
}

/** `structKeyExists`/`isDefined`: present with a non-null value. */
function given(data: ReadonlyMap<string, unknown>, key: string): boolean {
  const value = lookup(data, key);
  return value !== undefined && value !== null;
}

/** `input` as a CF struct: keys in their given order and casing, a later spelling of a key replacing an earlier one. */
function structOf(input: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>): { entries: Array<[string, unknown]>; byKey: Map<string, unknown> } {
  const byKey = new Map<string, unknown>();
  const firstKey = new Map<string, string>();
  for (const [key, value] of input instanceof Map ? input : Object.entries(input)) {
    const lower = key.toLowerCase();
    if (!firstKey.has(lower)) firstKey.set(lower, key);
    byKey.set(lower, value);
  }
  return { entries: [...firstKey].map(([lower, key]) => [key, byKey.get(lower)]), byKey };
}

// ---- feedBean ----

/** A CFML query a feed bean holds (`params`): column names in query order and one record per row. */
export class FeedParamsQuery {
  constructor(
    readonly columns: readonly string[],
    readonly rows: Array<Record<string, unknown>> = [],
  ) {}
}

/** beanFeed.clearAdvancedParams' columns (beanFeed.cfc:361). */
const BEANFEED_PARAM_COLUMNS = ['param', 'relationship', 'field', 'condition', 'criteria', 'dataType'] as const;
/** feedBean.init's params columns (feedBean.cfc:175). */
const FEED_PARAM_COLUMNS = ['feedID', ...BEANFEED_PARAM_COLUMNS] as const;
/** `select *` of tcontentfeedadvancedparams, as legacy names its columns (mssql.sql:145-154). */
const STORED_PARAM_COLUMNS = ['paramID', 'feedID', 'param', 'relationship', 'field', 'condition', 'criteria', 'dataType'] as const;

/** Explicit `set<Property>` methods of feedBean, beanFeed and bean (lower-cased), which addParam assigns directly. */
const EXPLICIT_SETTERS: ReadonlySet<string> = new Set([
  'datecreated', 'lastupdate', 'contentid', 'categoryid', 'displayname', 'displayratings', 'displaycomments', 'displaykids',
  'includehomepage', 'liveonly', 'shownavonly', 'islocked', 'usecategoryintersect', 'showexcludesearch', 'imagesize',
  'imageheight', 'imagewidth', 'autoimport', 'params', 'advancedparams', 'remotepubdate', 'alttable', 'entityname', 'orderby',
  'sort', 'sortdirection', 'itemsperpage', 'nextn', 'maxitems', 'fields', 'distinct', 'errors', 'lastupdateby', 'feedmanager',
  'configbean',
]);

/** The boolean-flag setters, which store 1 or 0 for a CF boolean and ignore anything else. */
const FLAG_SETTERS: ReadonlySet<string> = new Set([
  'displayname', 'displayratings', 'displaycomments', 'displaykids', 'includehomepage', 'liveonly', 'shownavonly', 'islocked',
  'usecategoryintersect', 'showexcludesearch', 'autoimport',
]);

/** The tcontent column names, for addParam's `formatField` and its datatype default. */
const CONTENT_COLUMNS: ReadonlyMap<string, string> = new Map(
  CONTENT.columns.filter((column) => column.name !== 'tenant_id').map((column) => [column.name, column.type]),
);

/** dbUtility.transformParamType of a tcontent column as transformColumnMetaData reads it from SQL Server. */
function contentColumnParamType(column: string): string {
  switch (CONTENT_COLUMNS.get(column.toLowerCase())) {
    case undefined:
      return 'varchar';
    case 'i':
      return 'numeric';
    case 't':
      return 'timestamp';
    default:
      return 'varchar';
  }
}

/** Raised for an advanced-param category lookup by name (feedBean.cfc:553-570), which the admin form never posts. */
export class FeedParamLookupUnsupportedError extends Error {
  override readonly name: string = 'FeedParamLookupUnsupportedError';

  constructor(readonly field: string) {
    super(`The advanced param "${field}" resolves category names, which this service does not reproduce`);
  }
}

type Entry = { key: string; value: unknown };

/** One feedBean instance: values under case-insensitive keys in their first casing, as `variables.instance` holds them. */
export class FeedBean {
  private readonly instance = new Map<string, Entry>();

  /** getBean('feed'): beanFeed.init then feedBean.init (feedBean.cfc:137-200); dot-notation keys are upper-cased as ACF stores them. */
  static init(clock: Clock): FeedBean {
    const bean = new FeedBean();
    const now = tsText(clock.now());
    const assignments: Array<[string, unknown]> = [
      ['ISNEW', 1], ['ERRORS', {}], ['FROMMURACACHE', false], ['INSTANCEID', cfUuid()], ['ADDOBJECTS', []], ['REMOVEOBJECTS', []],
      ['SITEID', ''], ['CONTENTPOOLID', ''], ['ENTITYNAME', ''], ['FIELDS', ''], ['DISTINCT', false], ['TABLE', ''], ['KEYFIELD', ''],
      ['SORTBY', ''], ['SORTDIRECTION', 'asc'], ['ORDERBY', ''], ['TABLEFIELDLOOKUP', {}], ['TABLEFIELDLIST', ''], ['NEXTN', 1000],
      ['MAXITEMS', 0], ['PAGEINDEX', 1], ['ADDITIONALCOLUMNS', ''], ['SORTTABLE', ''], ['FIELDALIASES', {}], ['CACHEDWITHIN', 0],
      ['PARAMS', new FeedParamsQuery(BEANFEED_PARAM_COLUMNS)], ['JOINS', []], ['PENDINGPARAM', {}], ['SUMVALARRAY', []],
      ['COUNTVALARRAY', []], ['AVGVALARRAY', []], ['MINVALARRAY', []], ['MAXVALARRAY', []], ['GROUPBYARRAY', []],
      ['FEEDID', ''], ['SITEID', ''], ['DATECREATED', now], ['LASTUPDATE', now], ['LASTUPDATEBY', ''], ['NAME', ''], ['ALTNAME', ''],
      ['LANG', 'en-us'], ['ISACTIVE', 1], ['SHOWNAVONLY', 1], ['SHOWEXCLUDESEARCH', 0], ['ISPUBLIC', 0], ['ISDEFAULT', 0],
      ['DESCRIPTION', ''], ['CONTENTID', ''], ['CATEGORYID', ''], ['MAXITEMS', 20], ['ALLOWHTML', 1], ['ISFEATURESONLY', 0],
      ['FEATURETYPE', 'either'], ['RESTRICTED', 0], ['RESTRICTGROUPS', ''], ['VERSION', 'RSS 2.0'], ['CHANNELLINK', ''],
      ['AUTHTYPE', 'DEFAULT'], ['TYPE', 'local'], ['SORTBY', 'lastUpdate'], ['SORTDIRECTION', 'desc'], ['PARENTID', ''], ['NEXTN', 20],
      ['DISPLAYNAME', 0], ['DISPLAYRATINGS', 0], ['DISPLAYCOMMENTS', 0], ['DISPLAYSUMMARIES', 1], ['DISPLAYKIDS', 0], ['ISNEW', 1],
      ['PARAMS', new FeedParamsQuery(FEED_PARAM_COLUMNS)], ['ERRORS', {}], ['REMOTEID', ''], ['REMOTESOURCEURL', ''],
      ['REMOTEPUBDATE', ''], ['IMAGESIZE', 'small'], ['IMAGEHEIGHT', 'AUTO'], ['IMAGEWIDTH', 'AUTO'],
      ['DISPLAYLIST', 'Date,Title,Image,Summary,Credits,Tags'], ['LIVEONLY', 1], ['ACTIVEONLY', 1], ['ENTITYNAME', 'content'],
      ['TABLE', 'tcontent'], ['VIEWALLLINK', ''], ['VIEWALLLABEL', ''], ['AUTOIMPORT', 0], ['ISLOCKED', 0], ['CSSCLASS', ''],
      ['USECATEGORYINTERSECT', 0], ['ALTTABLE', ''], ['CONTENTPOOLID', ''],
      ['FIELDALIASES', { tag: { FIELD: 'tcontenttags.tag', DATATYPE: 'varchar' }, taggroup: { FIELD: 'tcontenttags.taggroup', DATATYPE: 'varchar' } }],
      ['CACHEDWITHIN', 0], ['INCLUDEHOMEPAGE', 0],
    ];
    for (const [key, value] of assignments) bean.put(key, value);
    return bean;
  }

  has(key: string): boolean {
    return this.instance.has(key.toLowerCase());
  }

  /** `variables.instance[key]`, undefined when unset. */
  raw(key: string): unknown {
    return this.instance.get(key.toLowerCase())?.value;
  }

  /** `variables.instance[key] = value`: the first casing of a key is kept. */
  put(key: string, value: unknown): void {
    const lower = key.toLowerCase();
    const entry = this.instance.get(lower);
    if (entry === undefined) this.instance.set(lower, { key, value });
    else entry.value = value;
  }

  /** getAllValues(): every instance entry in assignment order, under its stored key. */
  entries(): Array<[string, unknown]> {
    return [...this.instance.values()].map(({ key, value }) => [key, value]);
  }

  /** bean.getValue with feedBean's image getters (feedBean.cfc:460-509); a missing key reads ''. */
  get(key: string): unknown {
    const lower = key.toLowerCase();
    switch (lower) {
      case 'imagesize':
        return cfEq(cfText(this.raw('imagesize')), 'Custom') && cfEq(cfText(this.raw('imageheight')), 'AUTO') && cfEq(cfText(this.raw('imagewidth')), 'AUTO')
          ? 'small'
          : this.raw('imagesize');
      case 'imageheight':
      case 'imagewidth':
        return cfEq(cfText(this.raw('imagesize')), 'Custom') ? this.raw(lower) : 'AUTO';
      default:
        return this.raw(lower) ?? '';
    }
  }

  /** The CF text of `get(key)`. */
  text(key: string): string {
    return cfText(this.get(key));
  }

  get isNew(): 0 | 1 {
    const value = this.raw('isnew');
    return cfIsNumeric(value) && cfToNumber(value) === 0 ? 0 : 1;
  }

  /** `setIsNew(n)`, which onMissingMethod stores through setValue as trimmed text. */
  set isNew(value: 0 | 1) {
    this.put('IsNew', String(value));
  }

  /** The bean's `errors` struct. */
  get errors(): LegacyErrors {
    const errors = this.raw('errors');
    if (isPlainObject(errors)) return errors as LegacyErrors;
    const fresh: LegacyErrors = {};
    this.put('errors', fresh);
    return fresh;
  }

  set errors(value: LegacyErrors) {
    this.put('errors', value);
  }

  /** The `params` query. */
  get params(): FeedParamsQuery {
    const params = this.raw('params');
    return params instanceof FeedParamsQuery ? params : new FeedParamsQuery(BEANFEED_PARAM_COLUMNS);
  }

  /** bean.setValue with the explicit setters of feedBean, beanFeed and bean; any other simple value is stored trimmed. */
  setValue(key: string, value: unknown): void {
    const lower = key.toLowerCase();
    if (FLAG_SETTERS.has(lower)) {
      if (cfIsBoolean(value)) this.put(key, cfToBoolean(value) ? 1 : 0);
      return;
    }
    switch (lower) {
      case 'datecreated':
      case 'lastupdate':
        this.put(key, parseDateArg(value));
        return;
      case 'contentid':
      case 'categoryid':
        this.put(key, javaTrim(cfText(value)));
        return;
      case 'imagesize':
        if (cfText(value) !== '') this.put(key, value);
        return;
      case 'imageheight':
      case 'imagewidth':
      case 'nextn':
      case 'maxitems':
        if (cfIsNumeric(value)) this.put(key, value);
        return;
      case 'itemsperpage':
        if (cfIsNumeric(value)) this.put('NextN', value);
        return;
      case 'sortdirection':
        if (['desc', 'asc'].includes(cfText(value).toLowerCase())) this.put(key, value);
        return;
      case 'remotepubdate':
        this.put(key, remotePubDateOf(value));
        return;
      case 'lastupdateby':
        this.put(key, javaTrim(cfText(value)).slice(0, AUDIT_NAME_LENGTH));
        return;
      case 'orderby':
      case 'sort':
        this.put('orderby', value);
        return;
      case 'entityname':
      case 'distinct':
        this.put(key, value);
        return;
      case 'errors':
        if (isPlainObject(value)) this.put(key, value);
        return;
      case 'alttable':
        this.setAltTable(value);
        return;
      case 'fields':
        this.setFields(value);
        return;
      case 'params':
      case 'advancedparams':
        this.setParams(value);
        return;
      case 'feedmanager':
      case 'configbean':
        return;
      default:
        this.put(key, isSimple(value) ? javaTrim(cfText(value)) : value);
    }
  }

  /** feedBean.setAltTable (feedBean.cfc:666-698): only `tcontent` exists among the tables this service holds. */
  private setAltTable(value: unknown): void {
    const text = cfText(value);
    if (text === '') return;
    const sanitized = text.replace(/[^a-zA-Z0-9_.]/g, '');
    const parts = sanitized.split('.').filter((part) => part !== '');
    const valid = parts.length > 0 && parts.length <= 2 && parts.every((part) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part) && part.length <= 64);
    this.put('altTable', valid && parts.at(-1)?.toLowerCase() === 'tcontent' ? sanitized : '');
  }

  /** beanFeed.setFields (beanFeed.cfc:201-213): the listed tcontent columns as `tcontent.<column>`. */
  private setFields(value: unknown): void {
    const fields = cfListToArray(cfText(value))
      .map((field) => javaTrim(field))
      .filter((field) => CONTENT_COLUMNS.has(field.toLowerCase()))
      .map((field) => `tcontent.${field}`);
    this.put('fields', fields.join(','));
  }

  /** feedBean.setParams (feedBean.cfc:511-529): a query as is, or the posted `param`/`paramField<n>` rows rebuilt through addParam. */
  private setParams(value: unknown): void {
    if (value instanceof FeedParamsQuery) {
      this.put('params', value);
      return;
    }
    const data = value instanceof Map ? (value as ReadonlyMap<string, unknown>) : isPlainObject(value) ? structOf(value).byKey : undefined;
    if (data === undefined || !given(data, 'param')) return;
    this.put('params', new FeedParamsQuery(BEANFEED_PARAM_COLUMNS));
    const count = cfListToArray(cfText(lookup(data, 'param'))).length;
    const at = (name: string, i: number): string => {
      const key = `${name}${i}`;
      if (!given(data, key)) throw new FeedElementUndefinedError(key, 'ARGUMENTS.PARAMS');
      return cfText(lookup(data, key));
    };
    for (let i = 1; i <= count; i += 1) {
      const field = cfListToArray(at('paramField', i), '^');
      this.addParam({
        field: field[0] ?? '',
        relationship: at('paramRelationship', i),
        criteria: at('paramCriteria', i),
        condition: at('paramCondition', i),
        datatype: field.at(-1) ?? '',
      });
    }
  }

  /** feedBean.addParam (feedBean.cfc:531-601) for the fields the admin form posts. */
  addParam(param: { field: string; relationship: string; criteria: string; condition: string; datatype: string }): void {
    let { field, datatype } = param;
    const { criteria } = param;
    if (field !== 'categoryid' && field !== 'contentid' && isValidVariableName(field) && EXPLICIT_SETTERS.has(field.toLowerCase())) {
      this.setValue(field, criteria);
      return;
    }
    const lowered = field.toLowerCase();
    if (['tcontentcategories.categoryid', 'categoryid', 'category'].includes(lowered)) field = 'tcontentcategoryassign.categoryid';
    else if (lowered === 'categorypathid') field = 'tcontentcategories.path';
    const categoryField = ['tcontentcategories.path', 'tcontentcategoryassign.categoryid', 'tcontentcategories.parentid'].includes(field.toLowerCase());
    if (criteria !== '' && categoryField && !isCfUuid(cfListToArray(criteria)[0] ?? '')) {
      if ((field.split('.').at(-1) ?? '').toLowerCase() !== 'categoryid') throw new FeedParamLookupUnsupportedError(field);
      field = 'tcontentcategories.name';
    } else if (lowered === 'tag') {
      field = 'tcontenttags.tag';
    }
    const aliases = this.raw('fieldaliases');
    const alias = isPlainObject(aliases) ? Object.entries(aliases).find(([name]) => name.toLowerCase() === field.toLowerCase())?.[1] : undefined;
    if (isPlainObject(alias)) {
      datatype = cfText(alias.DATATYPE);
      field = cfText(alias.FIELD);
    }
    if (datatype === '') datatype = contentColumnParamType(field.split('.').at(-1) ?? '');
    const params = this.params;
    // queryAddRow leaves the cells of the query's other columns empty.
    const row: Record<string, unknown> = Object.fromEntries(params.columns.map((column) => [column, '']));
    Object.assign(row, {
      param: params.rows.length + 1,
      field: CONTENT_COLUMNS.has(field.toLowerCase()) ? `tcontent.${field}` : field,
      relationship: param.relationship,
      criteria,
      condition: param.condition,
      dataType: datatype,
    });
    params.rows.push(row);
  }

  /** feedBean.set(struct) (feedBean.cfc:207-227): each key through setValue (a null as the argument default ''), then setAdvancedParams of the struct. */
  set(data: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>): this {
    const struct = structOf(data);
    for (const [key, value] of struct.entries) this.setValue(key, value ?? '');
    this.setParams(struct.byKey);
    return this;
  }
}

// ---- validation ----

/** A beanValidator rule set of one feedBean property (bean.getValidations over its metadata). */
interface FeedRule {
  required?: true;
  type: 'string' | 'numeric' | 'date';
  maxLength?: number;
}

const STRING: FeedRule = { type: 'string' };
const REQUIRED_STRING: FeedRule = { type: 'string', required: true };
const NUMERIC: FeedRule = { type: 'numeric' };
const REQUIRED_NUMERIC: FeedRule = { type: 'numeric', required: true };
const DATE: FeedRule = { type: 'date' };

// feedBean's properties, then beanFeed's and bean's not already declared, in metadata order: [property, rule key, rule].
// A null rule is a non-persistent property, which has no validations.
const PROPERTIES: ReadonlyArray<readonly [string, string, FeedRule | null]> = [
  ['feedID', 'feedID', { type: 'string', maxLength: 35 }], ['site', 'siteID', { type: 'string', maxLength: 25 }],
  ['dateCreated', 'dateCreated', DATE], ['lastUpdate', 'lastUpdate', DATE], ['lastUpdateBy', 'lastUpdateBy', STRING],
  ['name', 'name', STRING], ['altName', 'altName', STRING], ['lang', 'lang', REQUIRED_STRING],
  ['isActive', 'isActive', REQUIRED_NUMERIC], ['showNavOnly', 'showNavOnly', REQUIRED_NUMERIC],
  ['showExcludeSearch', 'showExcludeSearch', REQUIRED_NUMERIC], ['isPublic', 'isPublic', REQUIRED_NUMERIC],
  ['isDefault', 'isDefault', REQUIRED_NUMERIC], ['description', 'description', STRING], ['contentID', 'contentID', STRING],
  ['categoryID', 'categoryID', STRING], ['maxItems', 'maxItems', REQUIRED_NUMERIC], ['allowHTML', 'allowHTML', REQUIRED_NUMERIC],
  ['isFeaturesOnly', 'isFeaturesOnly', REQUIRED_NUMERIC], ['featureType', 'featureType', STRING],
  ['restricted', 'restricted', REQUIRED_NUMERIC], ['restrictGroups', 'restrictGroups', STRING], ['version', 'version', REQUIRED_STRING],
  ['channelLink', 'channelLink', STRING], ['authtype', 'authtype', STRING], ['type', 'type', REQUIRED_STRING],
  ['sortBy', 'sortBy', STRING], ['sortDirection', 'sortDirection', REQUIRED_STRING], ['parentID', 'parentID', STRING],
  ['nextN', 'nextN', REQUIRED_NUMERIC], ['displayName', 'displayName', REQUIRED_NUMERIC],
  ['displayRatings', 'displayRatings', REQUIRED_NUMERIC], ['displayComments', 'displayComments', REQUIRED_NUMERIC],
  ['displayKids', 'displayKids', REQUIRED_NUMERIC], ['isNew', 'isNew', null], ['params', 'params', null],
  ['remoteID', 'remoteID', STRING], ['remoteSourceURL', 'remoteSourceURL', STRING], ['remotePubDAte', 'remotePubDAte', STRING],
  ['imageSize', 'imageSize', REQUIRED_STRING], ['imageHeight', 'imageHeight', REQUIRED_STRING],
  ['imageWidth', 'imageWidth', REQUIRED_STRING], ['displayList', 'displayList', REQUIRED_STRING],
  ['liveOnly', 'liveOnly', REQUIRED_NUMERIC], ['entityName', 'entityName', STRING], ['viewalllabel', 'viewalllabel', STRING],
  ['viewalllink', 'viewalllink', STRING], ['autoimport', 'autoimport', REQUIRED_NUMERIC], ['isLocked', 'isLocked', REQUIRED_NUMERIC],
  ['cssClass', 'cssClass', STRING], ['useCategoryIntersect', 'useCategoryIntersect', NUMERIC], ['altTable', 'altTable', STRING],
  ['contentpoolid', 'contentpoolid', STRING], ['includeHomePage', 'includeHomePage', NUMERIC],
  ['table', 'table', STRING], ['keyField', 'keyField', STRING], ['siteID', 'siteID', STRING], ['orderby', 'orderby', STRING],
  ['additionalColumns', 'additionalColumns', STRING], ['sortTable', 'sortTable', STRING], ['pageIndex', 'pageIndex', NUMERIC],
  ['errors', 'errors', null], ['fromMuraCache', 'fromMuraCache', null], ['instanceID', 'instanceID', null],
];

/** Keys of a struct built by assigning `keys` in order, in ACF iteration order. */
function structOrder(keys: readonly string[]): string[] {
  return cfStruct(keys.map((key): [string, WddxValue] => [key, ''])).entries.map(([key]) => key);
}

// getValidations walks the properties struct and assigns each rule key, a later property overwriting an earlier one's
// rules (`site` and beanFeed's `siteID` share `siteID`); beanValidator then walks that struct, and its errors struct.
const PROPERTY_BY_NAME = new Map(PROPERTIES.map((property) => [property[0], property] as const));
const RULES = new Map<string, FeedRule>();
for (const name of structOrder(PROPERTIES.map(([property]) => property))) {
  const [, ruleKey, rule] = PROPERTY_BY_NAME.get(name) ?? [name, name, null];
  if (rule !== null) RULES.set(ruleKey, rule);
}
const VALIDATION_ORDER: readonly string[] = structOrder(structOrder([...RULES.keys()]));

/** CFML `len()` of a simple value. */
function cfLen(value: unknown): number {
  return cfText(value).length;
}

/** Whether `rule` fails for `value`: required and empty, or a present value of the wrong type or length. */
function ruleFails(rule: FeedRule, value: unknown): boolean {
  const simple = isSimple(value);
  const empty = simple && !cfIsNumeric(value) && cfLen(value) === 0;
  if (rule.required === true && empty) return true;
  if (empty && rule.required !== true) return false;
  if (rule.type === 'string' && !simple) return true;
  if (rule.type === 'numeric' && !cfIsNumeric(value)) return true;
  if (rule.type === 'date' && !(value instanceof Date) && !(typeof value === 'string' && (value === '' || cfIsDateText(value)))) return true;
  return rule.maxLength !== undefined && simple && cfLen(value) > rule.maxLength;
}

/** feedBean.validate(): beanValidator's errors in ACF struct order (Masa's default `stricthtml` off; no add objects). */
export function validateFeed(bean: FeedBean): LegacyErrors {
  const failing = VALIDATION_ORDER.filter((key) => {
    const rule = RULES.get(key);
    return rule !== undefined && ruleFails(rule, bean.get(key));
  });
  const errors: LegacyErrors = {};
  for (const key of structOrder(failing)) errors[key] = `The property named '${key}' is not valid`;
  return errors;
}

// ---- site values the getters read ----

/** Site values the feed bean's getters and the cfeed gate read beyond the registry; the route layer supplies them. */
export interface FeedSiteSettings {
  siteId: string;
  /** settingsBean `hasFeedManager`. */
  hasFeedManager: boolean;
  /** The site content renderer's `defaultCollectionDisplayList`, when it defines one. */
  defaultCollectionDisplayList?: string;
}

/** settingsBean.getContentPoolID of a registered site: its content pool list, else the site itself. */
async function siteContentPoolId(db: TenantDb, siteId: string): Promise<string> {
  const tenantId = await tenantForRegisteredSite(db, siteId);
  const entry = tenantId === null ? null : await registryEntryForTenant(db, tenantId);
  return entry !== null && entry.contentPoolIds.length > 0 ? entry.contentPoolIds.join(',') : siteId;
}

/** feedBean.getContentPoolID (feedBean.cfc:272-279), which stores what it returns: '' is the own site, `*` the site's content pool. */
async function resolveContentPoolId(db: TenantDb, bean: FeedBean): Promise<string> {
  const stored = bean.text('contentpoolid');
  if (stored === '') bean.put('contentpoolid', bean.text('siteid'));
  else if (stored === '*') bean.put('contentpoolid', await siteContentPoolId(db, bean.text('siteid')));
  return bean.text('contentpoolid');
}

/** feedBean.getDisplayList (feedBean.cfc:706-737), which stores the default list it builds for an empty one. */
function resolveDisplayList(bean: FeedBean, settings: Pick<FeedSiteSettings, 'defaultCollectionDisplayList'>): string {
  if (bean.text('displaylist') !== '') return bean.text('displaylist');
  if (settings.defaultCollectionDisplayList !== undefined) {
    bean.put('displayList', settings.defaultCollectionDisplayList);
    return settings.defaultCollectionDisplayList;
  }
  const items = ['Date', 'Title', 'Image', 'Summary', 'Credits'];
  if (cfBool(bean.get('displaycomments'))) items.push('Comments');
  items.push('Tags');
  if (cfBool(bean.get('displayratings'))) items.push('Rating');
  bean.put('displayList', items.join(','));
  return items.join(',');
}

/** validate() through beanValidator, whose getValue calls resolve the content pool and display list first. */
async function validateWithGetters(db: TenantDb, bean: FeedBean, settings: Pick<FeedSiteSettings, 'defaultCollectionDisplayList'>): Promise<LegacyErrors> {
  await resolveContentPoolId(db, bean);
  resolveDisplayList(bean, settings);
  const errors = validateFeed(bean);
  bean.errors = errors;
  return errors;
}

// ---- feedDAO ----

/** The tcontentfeeds columns feedDAO selects into a bean (`variables.fieldList`), as stored lower-cased. */
const DAO_FIELDS = [
  'feedid', 'siteid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'altname', 'lang', 'maxitems', 'isactive', 'ispublic',
  'isdefault', 'description', 'allowhtml', 'isfeaturesonly', 'restricted', 'restrictgroups', 'version', 'channellink', 'type',
  'sortby', 'sortdirection', 'nextn', 'displayname', 'displayratings', 'displaycomments', 'parentid', 'remoteid', 'remotesourceurl',
  'remotepubdate', 'imagesize', 'imageheight', 'imagewidth', 'displaylist', 'shownavonly', 'showexcludesearch', 'viewalllink',
  'viewalllabel', 'autoimport', 'islocked', 'cssclass', 'usecategoryintersect', 'contentpoolid', 'authtype',
] as const satisfies readonly (keyof FeedFields)[];

/** The query feedDAO.readAdvancedParams sets on the bean (`select *`, NULL cells kept). */
function storedParams(rows: readonly FeedAdvancedParamFields[]): FeedParamsQuery {
  return new FeedParamsQuery(
    STORED_PARAM_COLUMNS,
    rows.map((row) => ({
      paramID: row.paramid,
      feedID: row.feedid,
      param: row.param === null ? null : Number(row.param),
      relationship: row.relationship,
      field: row.field,
      condition: row.condition,
      criteria: row.criteria,
      dataType: row.datatype,
    })),
  );
}

/** feedDAO.read's bean of a stored feed: `set(rs)` (NULL as ''), its item lists and advanced params, then `setIsNew(0)`. */
async function loadedBean(tx: TenantTx, repository: ContentRepository, row: FeedFields, clock: Clock): Promise<FeedBean> {
  const bean = FeedBean.init(clock);
  for (const column of DAO_FIELDS) bean.setValue(column, row[column] ?? '');
  const items = (type: string): Promise<string> =>
    repository.feeds.feedItems(tx, { feedId: row.feedid, type }).then((rows) => rows.map((item) => item.itemid).join(','));
  bean.setValue('contentID', await items('contentID'));
  bean.setValue('categoryID', await items('categoryID'));
  bean.setValue('advancedParams', storedParams(await repository.feeds.feedAdvancedParams(tx, { feedId: row.feedid })));
  bean.isNew = 0;
  return bean;
}

/** The arguments of feedManager.read: the first non-empty key in legacy's order selects the read. */
export interface FeedReadKey {
  feedId?: string;
  siteId?: string;
  name?: string;
  remoteId?: string;
}

/** feedManager.read (feedManager.cfc:190-244) inside `tx`; the target holds no data cache, so every read is feedDAO's. */
async function readFeedInTx(tx: TenantTx, deps: FeedDeps, key: FeedReadKey): Promise<FeedBean> {
  const feedId = key.feedId ?? '';
  const siteId = key.siteId ?? '';
  const byKey = async (row: FeedFields | null): Promise<FeedBean> => {
    if (row !== null) return loadedBean(tx, deps.repository, row, deps.clock);
    const bean = FeedBean.init(deps.clock);
    bean.setValue('SiteID', siteId);
    return bean;
  };
  if (feedId === '' && siteId !== '') {
    if ((key.name ?? '') !== '') return byKey(await deps.repository.feeds.feedByName(tx, { siteId, name: key.name ?? '' }));
    if ((key.remoteId ?? '') !== '') return byKey(await deps.repository.feeds.feedByRemoteId(tx, { siteId, remoteId: key.remoteId ?? '' }));
  }
  const row = await deps.repository.feeds.feedById(tx, { feedId });
  return row === null ? FeedBean.init(deps.clock) : loadedBean(tx, deps.repository, row, deps.clock);
}

/** A CF numeric literal feedDAO interpolates into its SQL (`#bean.getX()#`), as the integer column stores it. */
function numericLiteral(bean: FeedBean, key: string): number {
  const value = bean.get(key);
  if (!cfIsNumeric(value)) throw new Error(`Incorrect syntax near '${cfText(value)}'.`);
  return Math.trunc(cfToNumber(value));
}

/** feedDAO's `isDate(x) ? cf_sql_timestamp : null` of dateCreated and lastUpdate. */
function auditDateColumn(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const text = cfText(value);
  return text !== '' && cfIsDateText(text) ? cfTimestampParam(text) : null;
}

/** The tcontentfeeds columns feedDAO.update binds (feedDAO.cfc:267-311); the repository stores '' as NULL. */
function updateColumns(bean: FeedBean): Omit<FeedRowInput, 'feedid' | 'siteid' | 'datecreated'> {
  const text = (key: string): string => bean.text(key);
  const remotePubDate = bean.get('remotepubdate');
  return {
    lastupdate: auditDateColumn(bean.get('lastupdate')),
    lastupdateby: text('lastupdateby'),
    name: text('name'),
    altname: text('altname'),
    isactive: numericLiteral(bean, 'isactive'),
    isdefault: numericLiteral(bean, 'isdefault'),
    ispublic: numericLiteral(bean, 'ispublic'),
    description: text('description'),
    lang: text('lang'),
    maxitems: numericLiteral(bean, 'maxitems'),
    allowhtml: numericLiteral(bean, 'allowhtml'),
    isfeaturesonly: numericLiteral(bean, 'isfeaturesonly'),
    restricted: numericLiteral(bean, 'restricted'),
    restrictgroups: text('restrictgroups'),
    version: text('version'),
    channellink: text('channellink'),
    type: text('type'),
    parentid: text('parentid'),
    sortby: text('sortby'),
    sortdirection: text('sortdirection'),
    nextn: numericLiteral(bean, 'nextn'),
    displayname: numericLiteral(bean, 'displayname'),
    displayratings: numericLiteral(bean, 'displayratings'),
    displaycomments: numericLiteral(bean, 'displaycomments'),
    remoteid: text('remoteid'),
    remotesourceurl: text('remotesourceurl'),
    remotepubdate: cfText(remotePubDate) === '' ? null : cfTimestampParam(remotePubDate),
    imagesize: text('imagesize'),
    imageheight: text('imageheight'),
    imagewidth: text('imagewidth'),
    displaylist: text('displaylist'),
    shownavonly: numericLiteral(bean, 'shownavonly'),
    showexcludesearch: numericLiteral(bean, 'showexcludesearch'),
    viewalllink: text('viewalllink'),
    viewalllabel: text('viewalllabel'),
    autoimport: numericLiteral(bean, 'autoimport'),
    islocked: numericLiteral(bean, 'islocked'),
    cssclass: text('cssclass'),
    usecategoryintersect: numericLiteral(bean, 'usecategoryintersect'),
    contentpoolid: text('contentpoolid'),
    authtype: text('authtype'),
  };
}

/** The tcontentfeeds row feedDAO.create inserts (feedDAO.cfc:91-142). */
function createColumns(bean: FeedBean): FeedRowInput {
  return {
    ...updateColumns(bean),
    feedid: bean.text('feedid'),
    siteid: bean.text('siteid'),
    datecreated: auditDateColumn(bean.get('datecreated')),
  };
}

/** feedDAO.createItems and createAdvancedParams: the bean's item lists and its params query rows. */
function childColumns(bean: FeedBean): { contentIds: string[]; categoryIds: string[]; advancedParams: FeedAdvancedParamInput[] } {
  // A query cell is read case-insensitively, a NULL cell as ''.
  const cell = (row: Record<string, unknown>, column: string): string => {
    const found = Object.entries(row).find(([name]) => name.toLowerCase() === column.toLowerCase());
    return found === undefined || found[1] === null || found[1] === undefined ? '' : cfText(found[1]);
  };
  return {
    contentIds: cfListToArray(bean.text('contentid')),
    categoryIds: cfListToArray(bean.text('categoryid')),
    advancedParams: bean.params.rows.map((row) => {
      const param = cell(row, 'param');
      if (!cfIsNumeric(param)) throw new Error(`Invalid data '${param}' for CFSQLTYPE CF_SQL_NUMERIC.`);
      return {
        param: cfToNumber(param),
        relationship: cell(row, 'relationship'),
        field: cell(row, 'field'),
        datatype: cell(row, 'dataType'),
        condition: cell(row, 'condition'),
        criteria: cell(row, 'criteria'),
      };
    }),
  };
}

/** A bean value as cfwddx writes it. */
function toWddx(value: unknown): WddxValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return wddxNumber(value);
  if (value instanceof Date) return new WddxDate(value);
  if (Array.isArray(value)) return value.map((item) => toWddx(item));
  if (value instanceof FeedParamsQuery) {
    const query: WddxQuery = {
      kind: 'query',
      columns: [...value.columns],
      rows: value.rows.map((row) => Object.fromEntries(value.columns.map((column) => [column, toWddx(row[column] ?? null)]))),
    };
    return query;
  }
  if (isPlainObject(value)) return cfStruct(Object.entries(value).map(([key, item]) => [key, toWddx(item)] as const));
  return cfText(value);
}

/** The bean's getAllValues() struct in ACF key order, then `extra` such as the trash markers. */
export function feedStruct(bean: FeedBean, extra: Iterable<readonly [string, WddxValue]> = []): WddxStruct {
  return cfStruct([...bean.entries().map(([key, value]) => [key, toWddx(value)] as const), ...extra]);
}

// ---- the cfeed gate ----

/** cfeed.cfc before() (86-89): the site's collections manager is on and the actor is S2, the site Admin, or holds both the Collections and Site Manager module permissions; false is legacy's secure(). */
export function feedAccess(actor: Actor, site: Pick<FeedSiteSettings, 'hasFeedManager'>): boolean {
  // getModulePerm already answers true for S2 and the site Admin role.
  return site.hasFeedManager && getModulePerm(actor, FEED_MODULE_ID) && getModulePerm(actor, SITE_MANAGER_MODULE_ID);
}

/** The `param` defaults cfeed's before() gives the request (cfeed.cfc:90-103). */
export const FEED_RC_DEFAULTS: Readonly<Record<string, string | number>> = Object.freeze({
  startrow: 1,
  keywords: '',
  categoryID: '',
  contentID: '',
  restricted: 0,
  closeCompactDisplay: '',
  compactDisplay: '',
  homeID: '',
  action: '',
  assignmentID: '',
  regionID: 0,
  orderno: 0,
  instanceParams: '',
  instanceid: '',
});

/** `rc` with each before() default it does not already hold (any key casing). */
export function withFeedRcDefaults(rc: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const held = new Set(Object.entries(rc).flatMap(([key, value]) => (value === undefined || value === null ? [] : [key.toLowerCase()])));
  const out: Record<string, unknown> = { ...rc };
  for (const [key, value] of Object.entries(FEED_RC_DEFAULTS)) {
    if (!held.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

// ---- feedManager reads ----

/** The local and remote collections of cfeed.list (feedManager.getFeeds, feedManager.cfc:103-110). */
export interface FeedLists {
  rsLocal: FeedFields[];
  rsRemote: FeedFields[];
}

/** cfeed.list: the site's Local and Remote collections by name. */
export function listFeeds(deps: FeedDeps, actor: Actor, siteId: string): Promise<FeedLists> {
  return withTenant(deps.db, actor.tenantId, async (tx) => ({
    rsLocal: await deps.repository.feeds.listFeeds(tx, { siteId, type: 'Local' }),
    rsRemote: await deps.repository.feeds.listFeeds(tx, { siteId, type: 'Remote' }),
  }));
}

/** feedManager.read: the stored feed the key names, else a new bean (of the site, for a name or remote id read). */
export function readFeed(deps: FeedDeps, actor: Actor, key: FeedReadKey): Promise<FeedBean> {
  return withTenant(deps.db, actor.tenantId, (tx) => readFeedInTx(tx, deps, key));
}

/** feedGateway.getcontentItems (feedGateway.cfc:966-988): the active versions of the bean's content ids in its content pool, one tenant per pool site. */
export async function getContentItems(deps: FeedDeps, actor: Actor, bean: FeedBean): Promise<FeedContentItemRow[]> {
  const contentIds = cfListToArray(bean.text('contentid'));
  const sites = await feedPoolSites(deps.db, actor.tenantId, await resolveContentPoolId(deps.db, bean));
  return readAcrossContentPool(deps.db, sites, (tx, site) =>
    deps.repository.feeds.contentItems(tx, { siteId: site.siteId, contentIds, contentPoolSiteIds: [site.siteId] }),
  );
}

/** The cfeed.edit model (cfeed.cfc:111-115). */
export interface FeedEditModel {
  feedBean: FeedBean;
  rsRestrictGroups: RestrictGroupRow[];
  rslist: FeedContentItemRow[];
}

/** cfeed.edit: the site's restrict groups, the feed as read, and its content items. */
export async function feedEditModel(deps: FeedDeps, actor: Actor, key: FeedReadKey): Promise<FeedEditModel> {
  const rsRestrictGroups = await restrictGroups(deps, actor);
  const feedBean = await readFeed(deps, actor, key);
  return { feedBean, rsRestrictGroups, rslist: await getContentItems(deps, actor, feedBean) };
}

// ---- feedManager writes ----

/** A feed save's data struct (cfeed's rc, or a bean's getAllValues()); keys case-insensitive. */
export type FeedData = Readonly<Record<string, unknown>>;

/** Settings of a feed write. */
export interface FeedWriteOptions {
  /** The site content renderer's `defaultCollectionDisplayList`, which validation reads through getDisplayList. */
  defaultCollectionDisplayList?: string;
  requestId?: string;
}

/** The audit stamp create and update set on a valid bean: now, and `left(fname & " " & lname, 50)` through setlastUpdateBy. */
function stampAudit(bean: FeedBean, deps: FeedDeps, actor: Actor): void {
  bean.setValue('lastUpdate', deps.clock.now());
  bean.setValue('lastUpdateBy', actor.fullName.slice(0, AUDIT_NAME_LENGTH));
}

/** feedManager.create (feedManager.cfc:156-188): the bean of `data`, inserted with its items and params unless validation failed. */
export async function createFeed(deps: FeedDeps, actor: Actor, data: FeedData, opts: FeedWriteOptions = {}): Promise<FeedBean> {
  const struct = structOf(data).byKey;
  const bean = FeedBean.init(deps.clock).set(data);
  const errors = await validateWithGetters(deps.db, bean, opts);
  if (Object.keys(errors).length > 0) return bean;
  stampAudit(bean, deps, actor);
  if (!(given(struct, 'feedid') && cfText(lookup(struct, 'feedid')) !== '')) bean.setValue('FeedID', cfUuid());
  const write = writeContextFor(actor, opts.requestId);
  await withGatedTenant(deps.db, actor.tenantId, (tx) => deps.repository.feeds.insertFeed(tx, createColumns(bean), childColumns(bean), write));
  bean.isNew = 0;
  return bean;
}

/** `data.feedID`, which update and save dereference without a default. */
function requiredFeedId(data: FeedData, scope: string): string {
  const struct = structOf(data).byKey;
  if (!given(struct, 'feedid')) throw new FeedElementUndefinedError('feedID', scope);
  return cfText(lookup(struct, 'feedid'));
}

/** feedManager.update (feedManager.cfc:387-415): the stored feed set from `data`, rewritten with its items and params unless validation failed. */
export async function updateFeed(deps: FeedDeps, actor: Actor, data: FeedData, opts: FeedWriteOptions = {}): Promise<FeedBean> {
  const feedId = requiredFeedId(data, 'ARGUMENTS.DATA');
  const write = writeContextFor(actor, opts.requestId);
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const bean = (await readFeedInTx(tx, deps, { feedId })).set(data);
    const errors = await validateWithGetters(deps.db, bean, opts);
    if (Object.keys(errors).length > 0) return bean;
    stampAudit(bean, deps, actor);
    await deps.repository.feeds.updateFeed(tx, bean.text('feedid'), updateColumns(bean), childColumns(bean), write);
    return bean;
  });
}

/** feedManager.save (feedManager.cfc:417-446): update when a feed has the data's feedID, else create. */
export async function saveFeed(deps: FeedDeps, actor: Actor, data: FeedData | FeedBean, opts: FeedWriteOptions = {}): Promise<FeedBean> {
  const values: FeedData = data instanceof FeedBean ? Object.fromEntries(data.entries()) : data;
  const struct = structOf(values).byKey;
  if (!given(struct, 'feedid')) throw new Error("The attribute 'FEEDID' is required when saving a feed.");
  const feedId = cfText(lookup(struct, 'feedid'));
  const exists = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.feeds.feedById(tx, { feedId }));
  return exists === null ? createFeed(deps, actor, values, opts) : updateFeed(deps, actor, values, opts);
}

/** A feed delete: the bean as read, the trash row throwIn inserted (null when one existed or the feed is locked), and whether it was deleted. */
export interface FeedDeletion {
  bean: FeedBean;
  trash: TrashRow | null;
  deleted: boolean;
}

/** feedManager.delete (feedManager.cfc:448-468): an unlocked feed goes to the trash and its row is removed; its items and params stay, as legacy leaves them. */
export function deleteFeed(deps: FeedDeps, actor: Actor, feedId: string, opts: Pick<FeedWriteOptions, 'requestId'> = {}): Promise<FeedDeletion> {
  const write = writeContextFor(actor, opts.requestId);
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const bean = await readFeedInTx(tx, deps, { feedId });
    if (cfBool(bean.get('islocked'))) return { bean, trash: null, deleted: false };
    const markers = deleteMarkers(deps.clock.now());
    for (const [key, value] of deleteMarkerAssignments(markers)) bean.put(key, value);
    const values = feedStruct(bean);
    const trash = await throwIn(
      tx,
      deps.repository,
      {
        objectClass: 'feed',
        objectId: bean.text('feedid'),
        parentId: deletedParentId(values),
        siteId: bean.text('siteid') !== '' ? bean.text('siteid') : actor.siteId,
        label: bean.text('name'),
        objectType: trashObjectType(values, 'feed'),
        objectSubType: trashObjectSubType(values),
        values,
        ...markers,
      },
      actor,
      createTrashCounter(),
      write,
    );
    await deps.repository.feeds.deleteFeed(tx, { feedId }, write);
    return { bean, trash, deleted: true };
  });
}

/** A CF numeric bound with cfqueryparam cf_sql_numeric, which rejects anything else. */
function numericParam(value: unknown): number {
  if (!cfIsNumeric(value)) throw new Error(`Invalid data ${cfText(value)} for CFSQLTYPE CF_SQL_NUMERIC.`);
  return cfToNumber(value);
}

// ---- cfeed.update ----

/** The cfeed.update outcome: the list redirect, the compact-display close document, or the edit form re-rendered with the bean's errors. */
export type FeedActionOutcome =
  | { kind: 'redirect'; action: 'cFeed.list'; append: readonly ['siteid'] }
  | { kind: 'close'; feedBean: FeedBean | undefined }
  | { kind: 'rerender'; feedBean: FeedBean; rsRestrictGroups: RestrictGroupRow[]; rslist: FeedContentItemRow[] };

/** Settings of updateFeedAction; `csrfValid` is the route's `validateCSRFTokens(context=rc.feedid)` verdict. */
export interface FeedActionOptions extends FeedWriteOptions {
  csrfValid?: boolean;
}

const LIST_REDIRECT: FeedActionOutcome = Object.freeze({ kind: 'redirect', action: 'cFeed.list', append: Object.freeze(['siteid'] as const) });

/** cfeed.update (cfeed.cfc:117-146) over `rc` with before()'s defaults: runs `action` when the token is valid, then redirects unless the form must close or re-render. */
export async function updateFeedAction(deps: FeedDeps, actor: Actor, rc: FeedData, opts: FeedActionOptions = {}): Promise<FeedActionOutcome> {
  if (!(opts.csrfValid ?? true)) return LIST_REDIRECT;
  const input = withFeedRcDefaults(rc);
  const data = structOf(input).byKey;
  const text = (key: string): string => cfText(lookup(data, key));
  const action = text('action');
  const feedIdOf = (): string => {
    if (!given(data, 'feedid')) throw new FeedElementUndefinedError('feedID', 'ARGUMENTS.RC');
    return text('feedid');
  };
  let bean: FeedBean | undefined;
  if (cfEq(action, 'update')) {
    if (text('assignmentid') !== '' && isJson(lookup(data, 'instanceparams'))) {
      // contentManager.updateContentObjectParams (contentManager.cfc:3009-3016) of the display object being edited.
      const write = writeContextFor(actor, opts.requestId);
      const args = {
        contentHistId: text('assignmentid'),
        columnId: numericParam(lookup(data, 'regionid')),
        orderNo: numericParam(lookup(data, 'orderno')),
        params: text('instanceparams'),
      };
      await withGatedTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.updateObjectParams(tx, args, write));
      bean = await readFeed(deps, actor, { feedId: feedIdOf(), siteId: text('siteid') });
    } else {
      bean = await updateFeed(deps, actor, input, opts);
    }
  }
  if (cfEq(action, 'delete')) await deleteFeed(deps, actor, feedIdOf(), opts);
  if (cfEq(action, 'add')) bean = await createFeed(deps, actor, input, opts);
  const isDelete = cfEq(action, 'delete');
  // An unknown action leaves rc.feedBean undefined, which legacy then dereferences.
  const withErrors = (): FeedBean | null => {
    if (bean === undefined) throw new FeedElementUndefinedError('feedBean', 'ARGUMENTS.RC');
    return Object.keys(bean.errors).length > 0 ? bean : null;
  };
  if (!cfEq(text('closecompactdisplay'), 'true') && !(!isDelete && withErrors() !== null)) return LIST_REDIRECT;
  const invalid = isDelete ? null : withErrors();
  if (invalid !== null) {
    return { kind: 'rerender', feedBean: invalid, rsRestrictGroups: await restrictGroups(deps, actor), rslist: await getContentItems(deps, actor, invalid) };
  }
  return { kind: 'close', feedBean: bean };
}


// ---- feed content (local feeds) ----

// Raised rather than returning rows legacy would have reshaped, so no caller serves a silently different list.
/** Raised where a feed needs a legacy step this service does not reproduce (beanFeed fields, calendar interval expansion). */
export class FeedContentUnsupportedError extends Error {
  override readonly name: string = 'FeedContentUnsupportedError';
}

/** The getFeed arguments a caller passes beside the bean (feedManager.getFeed, feedManager.cfc:112-134). */
export interface FeedContentOptions {
  tag?: string;
  /** Legacy `nowAdjusted` before rounding; the clock's now when absent. */
  today?: Date;
  from?: Date | null;
  to?: Date | null;
  preview?: FeedQuery['preview'];
  mobile?: boolean;
  /** permUtility.queryPermFilter of the rows; legacy default false. */
  applyPermFilter?: boolean;
  /** contentIntervalManager.apply of live feeds; legacy default true. */
  applyIntervals?: boolean;
  countOnly?: boolean;
}

/** The getFeed sort keys that order by one content column (feedGateway's cfcase list). */
const COLUMN_SORTS: ReadonlySet<string> = new Set([
  'menutitle', 'title', 'lastupdate', 'releasedate', 'orderno', 'displaystart', 'displaystop', 'created', 'expires', 'credits', 'type', 'subtype',
]);

/** The columns of a default feed row, which a merged sort can read. */
const FEED_ROW_COLUMNS: ReadonlySet<string> = new Set([
  'siteid', 'title', 'menutitle', 'restricted', 'restrictgroups', 'type', 'subtype', 'filename', 'displaystart', 'displaystop',
  'remotesource', 'remoteurl', 'remotesourceurl', 'keypoints', 'contentid', 'parentid', 'approved', 'islocked', 'contenthistid',
  'target', 'targetparams', 'releasedate', 'lastupdate', 'summary', 'fileid', 'tags', 'credits', 'audience', 'orderno', 'path',
  'created', 'nextn', 'majorversion', 'minorversion', 'expires', 'displayinterval', 'display', 'changesetid', 'filesize', 'fileext',
  'rating', 'totalvotes', 'downvotes', 'upvotes', 'comments', 'lockid', 'locktype', 'parenttype', 'assocfilename', 'filealttext',
]);

/** Aliases whose `alias.column` references name a default feed row column of the same name. */
const ROW_ALIASES: ReadonlySet<string> = new Set(['tcontent', 'tcontentstats', 'tfiles']);

type MergeKey = { column: string; direction: 'asc' | 'desc' } | 'random';

/** The column a merged sort reads for an ORDER BY reference, or undefined when the row does not hold it. */
function rowColumn(reference: string): string | undefined {
  const parts = reference.toLowerCase().split('.');
  const column = parts.length === 2 && ROW_ALIASES.has(parts[0] ?? '') ? parts[1] : parts.length === 1 ? parts[0] : undefined;
  return column !== undefined && FEED_ROW_COLUMNS.has(column) ? column : undefined;
}

/** getFeed's ORDER BY as merge keys over the returned rows; undefined where the rows lack a sort key (extended-attribute sorts). */
function mergeKeys(bean: FeedBean): MergeKey[] | undefined {
  const orderBy = bean.text('orderby');
  const sortBy = bean.text('sortby');
  const direction = bean.text('sortdirection').toLowerCase() === 'asc' ? 'asc' : 'desc';
  if (orderBy !== '') {
    if (orderBy.toLowerCase() === 'random') return ['random'];
    const keys: MergeKey[] = [];
    for (const item of cfListToArray(orderBy)) {
      const parts = javaTrim(item).split(/\s+/);
      const column = rowColumn(parts.length >= 2 ? parts.slice(0, -1).join(' ') : (parts[0] ?? ''));
      if (column === undefined) return undefined;
      keys.push({ column, direction: parts.length >= 2 && (parts.at(-1) ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc' });
    }
    return keys;
  }
  if (sortBy === '') return [];
  const key = sortBy.toLowerCase();
  if (COLUMN_SORTS.has(key)) return [{ column: key, direction }];
  if (key === 'rating') return [{ column: 'rating', direction }, { column: 'totalvotes', direction }];
  if (key === 'comments') return [{ column: 'comments', direction }];
  if (key === 'random') return ['random'];
  if (!(FEED_SORT_OPTIONS as readonly string[]).includes(key)) return undefined;
  return [
    { column: 'releasedate', direction: 'desc' },
    { column: 'lastupdate', direction: 'desc' },
    { column: 'menutitle', direction: 'asc' },
  ];
}

/** SQL Server ordering of two values: NULL lowest, text case-insensitive. */
function compareValues(a: unknown, b: unknown): number {
  const absent = (v: unknown): boolean => v === null || v === undefined;
  if (absent(a) || absent(b)) return absent(a) === absent(b) ? 0 : absent(a) ? -1 : 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = cfText(a).toLowerCase();
  const y = cfText(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The comparator of `keys` over feed rows; `random` draws one key per row. */
function rowComparator(keys: readonly MergeKey[]): (a: FeedContentRow, b: FeedContentRow) => number {
  const draws = new WeakMap<FeedContentRow, number>();
  const draw = (row: FeedContentRow): number => {
    const held = draws.get(row);
    if (held !== undefined) return held;
    const value = Math.random();
    draws.set(row, value);
    return value;
  };
  return (a, b) => {
    for (const key of keys) {
      const order =
        key === 'random'
          ? draw(a) - draw(b)
          : (key.direction === 'asc' ? 1 : -1) * compareValues((a as Record<string, unknown>)[key.column], (b as Record<string, unknown>)[key.column]);
      if (order !== 0) return order;
    }
    return 0;
  };
}

/** The feed's categoryID list as getFeed filters by it: the listed ids with useCategoryIntersect, else every category whose path names one, read in the category pool. */
async function feedCategoryIds(deps: FeedDeps, actor: Actor, bean: FeedBean): Promise<string[] | undefined> {
  const listed = cfListToArray(bean.text('categoryid'));
  if (listed.length === 0) return undefined;
  if (cfBool(bean.get('usecategoryintersect'))) return listed;
  return withPoolTenant(deps.db, actor.tenantId, 'category', async (tx) => {
    const ids = new Set<string>();
    for (const categoryId of listed) {
      for (const id of await deps.repository.categories.descendantIds(tx, categoryId)) ids.add(id);
    }
    return [...ids];
  });
}

/** The params query rows as feed-queries reads them. */
function paramInputs(bean: FeedBean): FeedParamInput[] {
  const cell = (row: Record<string, unknown>, column: string): string | null => {
    const found = Object.entries(row).find(([name]) => name.toLowerCase() === column.toLowerCase())?.[1];
    return found === undefined || found === null ? null : cfText(found);
  };
  return bean.params.rows.map((row) => ({
    relationship: cell(row, 'relationship'),
    field: cell(row, 'field'),
    condition: cell(row, 'condition'),
    criteria: cell(row, 'criteria'),
    datatype: cell(row, 'dataType'),
  }));
}

/** The getFeed criteria of a feed bean (feedGateway.cfc:132-940) over the pool sites, with the category ids resolved. */
function feedCriteria(deps: FeedDeps, actor: Actor, bean: FeedBean, sites: readonly PoolSite[], categoryIds: string[] | undefined, opts: FeedContentOptions): FeedQuery {
  const categoryPool = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withPoolTenant(deps.db, actor.tenantId, 'category', (tx) => fn(tx));
  const cachedWithin = bean.get('cachedwithin');
  return {
    siteId: bean.text('siteid'),
    contentPoolSiteIds: sites.map((site) => site.siteId),
    type: bean.text('type'),
    contentIds: cfListToArray(bean.text('contentid')),
    categoryIds,
    useCategoryIntersect: cfBool(bean.get('usecategoryintersect')),
    advanced: { rows: paramInputs(bean), parseDate: criteriaDate },
    tag: opts.tag ?? '',
    isFeaturesOnly: cfBool(bean.get('isfeaturesonly')),
    featureType: bean.text('featuretype'),
    showNavOnly: cfBool(bean.get('shownavonly')),
    showExcludeSearch: cfBool(bean.get('showexcludesearch')),
    includeHomePage: cfBool(bean.get('includehomepage')),
    liveOnly: cfBool(bean.get('liveonly')),
    activeOnly: cfBool(bean.get('activeonly')),
    preview: opts.preview ?? null,
    mobile: opts.mobile ?? false,
    today: opts.today ?? deps.clock.now(),
    // createTimeSpan holds days; the query reads whole seconds.
    cachedWithinSeconds: cfIsNumeric(cachedWithin) ? Math.round(cfToNumber(cachedWithin) * SECONDS_PER_DAY) : 0,
    from: opts.from ?? null,
    to: opts.to ?? null,
    sortBy: bean.text('sortby'),
    sortDirection: bean.text('sortdirection'),
    orderBy: bean.text('orderby'),
    maxItems: numericLiteral(bean, 'maxitems'),
    distinct: cfBool(bean.get('distinct')),
    altTable: bean.text('alttable'),
    categoryPool,
  };
}

/** `rows` with the file columns filled in each pool site's file-pool tenant, where the query could not join them; legacy joins `tfiles` on fileid alone. */
async function withPooledFiles(deps: FeedDeps, sites: readonly PoolSite[], rows: FeedContentRow[]): Promise<FeedContentRow[]> {
  const unjoined = (row: FeedContentRow): boolean => (row.fileid ?? '') !== '' && row.filesize === null && row.fileext === null;
  const filled = new Map<FeedContentRow, FeedContentRow>();
  for (const site of sites) {
    const pending = rows.filter((row) => unjoined(row) && (row.siteid ?? '').toLowerCase() === site.siteId.toLowerCase());
    const fileIds = [...new Set(pending.map((row) => row.fileid ?? ''))];
    if (fileIds.length === 0) continue;
    const files = await withPoolTenant(deps.db, site.tenantId, 'file', (tx, poolTenantId) =>
      poolTenantId === site.tenantId ? Promise.resolve([]) : deps.repository.content.fileJoinColumns(tx, fileIds),
    );
    const byId = new Map(files.map((file) => [file.fileid.toLowerCase(), file]));
    for (const row of pending) {
      const file = byId.get((row.fileid ?? '').toLowerCase());
      if (file !== undefined) filled.set(row, { ...row, filesize: file.filesize, fileext: file.fileext, assocfilename: file.assocfilename });
    }
  }
  return filled.size === 0 ? rows : rows.map((row) => filled.get(row) ?? row);
}

/** The interval members contentIntervalManager.deserializeInterval reads to decide whether `apply` expands a row. */
function intervalRepeats(raw: string | null): boolean {
  const text = raw ?? '';
  let data: Record<string, unknown> = {};
  if (isJson(text)) {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) data = parsed;
  } else if (text !== '') {
    data = { type: text };
  }
  const member = (name: string): unknown => Object.entries(data).find(([key]) => key.toLowerCase() === name)?.[1];
  const repeats = member('repeats');
  if (repeats !== undefined) return cfBool(repeats);
  const every = member('every') ?? 1;
  return !(cfEq(cfText(member('type') ?? 'daily'), 'daily') && !cfBool(every));
}

/** Whether contentIntervalManager.apply (contentIntervalManager.cfc:313-320) would expand or drop `row`. */
function intervalApplies(row: FeedContentRow): boolean {
  return row.display === 2 && (cfEq(row.parenttype ?? '', 'calendar') || intervalRepeats(row.displayinterval));
}

/** feedManager.getFeed of a local feed: one query per content-pool tenant, merged in the feed's sort, then `maxItems`, the permission filter and the calendar order. */
export async function feedContent(deps: FeedDeps, actor: Actor, feed: FeedBean, opts: FeedContentOptions & { countOnly: true }): Promise<FeedCount>;
export async function feedContent(deps: FeedDeps, actor: Actor, feed: FeedBean, opts?: FeedContentOptions & { countOnly?: false }): Promise<FeedContentRow[]>;
export async function feedContent(deps: FeedDeps, actor: Actor, feed: FeedBean, opts: FeedContentOptions = {}): Promise<FeedContentRow[] | FeedCount> {
  if (feed.text('fields') !== '') throw new FeedContentUnsupportedError('Feeds with beanFeed fields are not served by feedContent');
  const sites = await feedPoolSites(deps.db, actor.tenantId, await resolveContentPoolId(deps.db, feed));
  const criteria = feedCriteria(deps, actor, feed, sites, await feedCategoryIds(deps, actor, feed), opts);
  const calendarSort = cfEq(feed.text('sortby'), 'displayStart');
  if (opts.countOnly === true) {
    // filterCalendarItems orders the one-row count query by a displaystart column it does not have.
    if (calendarSort) throw new FeedContentUnsupportedError('Column displaystart is not in the count query');
    let count = 0;
    for (const site of sites) {
      count += (await withTenant(deps.db, site.tenantId, (tx) => deps.repository.feeds.feedContent(tx, { ...criteria, countOnly: true }))).count;
    }
    return { count };
  }
  const keys = sites.length > 1 ? mergeKeys(feed) : [];
  if (keys === undefined) throw new FeedContentUnsupportedError(`The sort "${feed.text('sortby')}" of a multi-site feed reads columns its rows do not hold`);
  const rowCriteria = { ...criteria, countOnly: false as const, fields: undefined, aggregates: undefined };
  let rows = await readAcrossContentPool(
    deps.db,
    sites,
    (tx) => deps.repository.feeds.feedContent(tx, rowCriteria),
    keys.length > 0 ? rowComparator(keys) : undefined,
  );
  const maxItems = criteria.maxItems ?? 0;
  if (maxItems > 0 && rows.length > maxItems) rows = rows.slice(0, maxItems);
  rows = await withPooledFiles(deps, sites, rows);
  if (opts.applyPermFilter === true) rows = await permitted(deps, actor, feed, rows);
  if ((criteria.liveOnly ?? true) && (opts.applyIntervals ?? true) && rows.some(intervalApplies)) {
    throw new FeedContentUnsupportedError('contentIntervalManager.apply');
  }
  // contentCalendarUtilityBean.filterCalendarItems: `ORDER BY displaystart <sortDirection>` over the rows, none dropped.
  if (calendarSort) rows = [...rows].sort(rowComparator([{ column: 'displaystart', direction: feed.text('sortdirection').toLowerCase() === 'asc' ? 'asc' : 'desc' }]));
  return rows;
}

/** permUtility.queryPermFilter (permission.cfc:710-754): the rows whose crumbs are unrestricted or allowed for the actor. */
async function permitted(deps: FeedDeps, actor: Actor, feed: FeedBean, rows: readonly FeedContentRow[]): Promise<FeedContentRow[]> {
  const siteId = feed.text('siteid');
  const kept: FeedContentRow[] = [];
  for (const row of rows) {
    const crumbs = await withTenant(deps.db, actor.tenantId, (tx) =>
      deps.repository.content.crumbPath(tx, { contentId: row.contentid ?? '', siteId, path: row.path ?? '' }),
    );
    const restriction = await setRestriction(deps, actor, crumbs);
    if (!restriction.restrict || restriction.allow) kept.push(row);
  }
  return kept;
}

/** The restricted-feed member lookup allowFeed runs on tusers and tusersmemb (feedManager.cfc:486-508), which identity owns. */
export type FeedMemberLookup = (query: { username: string; password: string; publicUserPoolId: string; restrictGroups: readonly string[] }) => Promise<boolean>;

/** The feed API's `username` and `password` arguments. */
export interface FeedCredentials {
  username?: string;
  password?: string;
}

/** Raised for a restricted feed without the member lookup the caller must supply. */
export class FeedMemberLookupRequiredError extends Error {
  override readonly name: string = 'FeedMemberLookupRequiredError';

  constructor() {
    super('A restricted feed needs the identity member lookup');
  }
}

// Reproduced, not fixed: legacy reaches the end of allowFeed without a cfreturn once a member is found.
/** ACF's error when allowFeed returns no value from its `returntype="boolean"` function. */
export class FeedAllowReturnTypeError extends Error {
  override readonly name: string = 'FeedAllowReturnTypeError';

  constructor() {
    super('The value returned from the allowFeed function is not of type boolean.');
  }
}

/** feedManager.allowFeed (feedManager.cfc:470-517): whether the actor, or the given credentials, may read the feed. */
export async function allowFeed(
  deps: FeedDeps,
  actor: Actor,
  feed: FeedBean,
  credentials: FeedCredentials = {},
  findMember?: FeedMemberLookup,
): Promise<boolean> {
  // `S2IsPrivate;<user siteid>` is in the memberships of every system user, whose siteid is the private user pool;
  // listFind matches it case-sensitively.
  if (actor.isLoggedIn && (actor.s2 || actor.roles.includes(Roles.s2) || actor.roles.includes(Roles.systemUser))) {
    const pools = await sitePools(deps, actor);
    if (pools.privateUserPoolId === feed.text('siteid')) return true;
  }
  if (feed.isNew === 1) return false;
  if (!cfBool(feed.get('restricted'))) return true;
  if (findMember === undefined) throw new FeedMemberLookupRequiredError();
  const pools = await sitePools(deps, actor);
  const found = await findMember({
    username: credentials.username ?? '',
    password: credentials.password ?? '',
    publicUserPoolId: pools.publicUserPoolId,
    restrictGroups: cfListToArray(feed.text('restrictgroups')),
  });
  if (!found) return false;
  throw new FeedAllowReturnTypeError();
}

// ---- remote import ----

/** The cfhttp attributes of a feed fetch that getHTTPAttrs adds: the connection type and any credentials. */
export interface RemoteFetchOptions {
  authType: string;
  username?: string;
  password?: string;
}

/** Fetches a remote feed URL with GET; the answer's status and decoded body. */
export type FetchRemote = (url: string, opts: RemoteFetchOptions) => Promise<{ status: number; body: string }>;

/** getHTTPAttrs (cfobject.cfc:325-365) under configBean's empty default proxy settings: the feed's connection type, no credentials. */
export function remoteFetchOptions(authType: string): RemoteFetchOptions {
  return { authType: ['PROXY', 'NTLM', 'BASIC'].includes(authType.toUpperCase()) ? authType : 'BASIC' };
}

/** Raised for a fetch that needs credentials the default fetch cannot present (NTLM or a configured proxy). */
export class RemoteFeedAuthUnsupportedError extends Error {
  override readonly name: string = 'RemoteFeedAuthUnsupportedError';

  constructor(readonly authType: string) {
    super(`Remote feeds fetched with ${authType} credentials are not supported`);
  }
}

/** cfhttp `throwOnError="Yes"` for a non-2xx answer. */
export class RemoteFeedHttpError extends Error {
  override readonly name: string = 'RemoteFeedHttpError';

  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${status} ${url}`);
  }
}

/** The response charset, as cfhttp decodes the body by it; UTF-8 when absent or unknown. */
function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim();
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** One GET of `url` with the global fetch, bounded by the service-call timeout and never retried; redirects are followed as cfhttp follows them. */
export const defaultFetchRemote: FetchRemote = async (url, opts) => {
  if ((opts.username ?? '') !== '' || (opts.password ?? '') !== '') throw new RemoteFeedAuthUnsupportedError(opts.authType);
  const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS) });
  return { status: response.status, body: decodeBody(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type')) };
};

/** feedUtility.doImport's `theImport` struct, which cfeed.import2 renders. */
export interface FeedImport {
  feedBean: FeedBean;
  /** contentManager.getActiveContent of the feed's parent; absent when the feed has no parent. */
  parentBean?: ContentBean;
  /** Unset for an Atom or unknown version, which legacy leaves without `success`. */
  success?: boolean;
  /** Each selected item's save, in import order. */
  saves: SaveContentResult[];
}

/** doImport's `data`: the feed and the selected item ids (`All`, or a list of feed item remote ids). */
export interface FeedImportArgs {
  feedId: string;
  remoteId?: string;
}

// Each item saves in its own gated transaction, as each contentManager.add commits its own; deleteHistAll opens its own.
/** feedUtility.doImport (feedUtility.cfc:89-229): saves the selected RSS items, last visible first, as pages under the feed's parent. */
export async function importRemoteFeed(
  deps: DomainDeps,
  actor: Actor,
  site: ContentSaveSite,
  args: FeedImportArgs,
  fetchRemote: FetchRemote = defaultFetchRemote,
  opts: Pick<FeedWriteOptions, 'requestId'> = {},
): Promise<FeedImport> {
  const feedBean = await readFeed(deps, actor, { feedId: args.feedId });
  const parentId = feedBean.text('parentid');
  if (parentId === '') return { feedBean, success: false, saves: [] };
  const siteId = feedBean.text('siteid');
  const parentBean = await getActiveContent(deps, actor, { contentId: parentId, siteId });
  if (parentBean.isNew === 1) return { feedBean, parentBean, success: false, saves: [] };
  const response = await fetchRemote(feedBean.text('channellink'), remoteFetchOptions(feedBean.text('authtype')));
  if (response.status < 200 || response.status >= 300) throw new RemoteFeedHttpError(feedBean.text('channellink'), response.status);
  const xml = parseFeedXml(response.body);
  if (importFormat(feedBean.text('version')) !== 'rss') return { feedBean, parentBean, saves: [] };
  const items = importOrder(rssChannelItems(xml), numericLiteral(feedBean, 'maxitems'));
  const prepared = { memberships: await loadMemberships(deps, actor), poolCategories: await listPoolCategories(deps, actor), requestId: opts.requestId };
  const saves: SaveContentResult[] = [];
  for (const item of items) {
    const itemId = feedItemRemoteId(item);
    if (!isImportSelected(args.remoteId, itemId)) continue;
    const fields = importItemFields(item, { parentId, siteId, categoryIds: feedBean.text('categoryid') }, { now: deps.clock.now() });
    const result = await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
      // contentBean.loadBy(remoteID, siteID).set(feedItem).save(): the bean legacy unpacks with getAllValues().
      const now = deps.clock.now();
      const row = (await deps.repository.content.readActiveByRemoteId(tx, { siteId, remoteId: itemId })).at(-1);
      const bean = row === undefined ? LegacyContentBean.notFound(actor, now, siteId) : LegacyContentBean.fromVersion(row, actor, now);
      bean.set(fields, actor);
      return saveContentInTx(tx, deps, actor, site, bean, prepared);
    });
    if (result.afterCommitError !== undefined) throw result.afterCommitError;
    saves.push(result);
    if (result.bean.isNew === 0 && cfEq(args.remoteId ?? '', 'All')) {
      await deleteHistAll(deps, actor, site, { contentId: result.bean.contentId(), siteId: result.bean.text('siteid') }, opts);
    }
  }
  return { feedBean, parentBean, success: true, saves };
}

/** One RSS item cfeed.import1 offers: its remote id, link, title and description markup, and whether no active content holds the id. */
export interface FeedImportPreviewItem {
  remoteID: string;
  link: string;
  title: string;
  description: string;
  isNew: boolean;
}

/** The cfeed.import1 model: the feed as read and the items it offers; none for a version other than RSS. */
export interface FeedImportPreview {
  feedBean: FeedBean;
  items: FeedImportPreviewItem[];
}

/** CFML `pubDate eq remotePubDate`: as dates when the stored value is one and the text parses, else as text. */
function samePubDate(text: string, stored: unknown): boolean {
  if (stored instanceof Date) {
    const parsed = parseDateArg(text);
    return parsed instanceof Date && parsed.getTime() === stored.getTime();
  }
  return cfEq(text, cfText(stored));
}

/** cfeed.import1 (import1.cfm:102-151): the first `maxItems` RSS items of the remote feed that are new, or whose pubDate differs from the imported version's. */
export async function previewFeedImport(
  deps: FeedDeps,
  actor: Actor,
  args: { feedId: string; siteId: string },
  fetchRemote: FetchRemote = defaultFetchRemote,
): Promise<FeedImportPreview> {
  const feedBean = await readFeed(deps, actor, { feedId: args.feedId });
  const url = feedBean.text('channellink');
  const response = await fetchRemote(url, remoteFetchOptions(feedBean.text('authtype')));
  if (response.status < 200 || response.status >= 300) throw new RemoteFeedHttpError(url, response.status);
  // import1.cfm strips the text before the first `<` but, unlike getRemoteFeedData, keeps chr(20).
  const xml = parseFeedXml(prepareRemoteFeedText(response.body));
  if (importFormat(feedBean.text('version')) !== 'rss') return { feedBean, items: [] };
  const now = deps.clock.now();
  const items: FeedImportPreviewItem[] = [];
  for (const item of previewOrder(rssChannelItems(xml), numericLiteral(feedBean, 'maxitems'))) {
    const remoteID = feedItemRemoteId(item);
    const rows = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.readActiveByRemoteId(tx, { siteId: args.siteId, remoteId: remoteID }));
    const row = rows.at(-1);
    // `not isNew and pubDate eq …` reads pubDate only for an item already imported.
    if (row !== undefined && samePubDate(item.child('pubDate').xmlText, LegacyContentBean.fromVersion(row, actor, now).get('remotepubdate'))) continue;
    items.push({ remoteID, link: item.child('link').xmlText, title: item.child('title').xmlText, description: item.child('description').xmlText, isNew: row === undefined });
  }
  return { feedBean, items };
}

// ---- auto-import job step ----

/** The site-monitor feed step's inputs: the domain collaborators, the site, and the site settings content saves read. */
export interface AutoImportArgs extends DomainDeps {
  siteId: string;
  fetchRemote?: FetchRemote;
  /** The settings of the registered site, which the job route reads; called only when the site has a feed to import. */
  siteFor: (siteId: string) => ContentSaveSite | Promise<ContentSaveSite>;
  requestId?: string;
}

/** The feeds doAutoImport imported for a site; none for an unregistered site. */
export interface AutoImportResult {
  siteId: string;
  imports: FeedImport[];
}

/** feedManager.doAutoImport (feedManager.cfc:371-385): imports every item of the site's active autoimport remote feeds as the system actor. */
export async function doAutoImport(args: AutoImportArgs): Promise<AutoImportResult> {
  const deps: DomainDeps = { db: args.db, repository: args.repository, clock: args.clock, config: args.config };
  const tenantId = await tenantForRegisteredSite(deps.db, args.siteId);
  if (tenantId === null) return { siteId: args.siteId, imports: [] };
  // SQL Server matched the site id case-insensitively; the registry holds its stored spelling.
  const siteId = (await siteForTenant(deps.db, tenantId)) ?? args.siteId;
  const actor: Actor = { userId: '', fullName: '', isLoggedIn: false, s2: false, roles: [], siteId, tenantId };
  const feeds = await withTenant(deps.db, tenantId, (tx) => deps.repository.feeds.listFeeds(tx, { siteId, type: 'Remote', publicOnly: false, activeOnly: true }));
  const imports: FeedImport[] = [];
  let site: ContentSaveSite | undefined;
  for (const feed of feeds) {
    if (feed.autoimport !== 1) continue;
    site ??= await args.siteFor(siteId);
    imports.push(await importRemoteFeed(deps, actor, site, { feedId: feed.feedid, remoteId: 'All' }, args.fetchRemote ?? defaultFetchRemote, { requestId: args.requestId }));
  }
  return { siteId, imports };
}

