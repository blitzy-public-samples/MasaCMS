/** Categories and category assignments: categoryManager, categoryDAO, categoryGateway, categoryBean and the ccategory.update controller. */
import {
  cfDateTimeFormat,
  cfEq,
  cfIsDateText,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfTimestampParam,
  cfToNumber,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { registryEntryForTenant, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { formatFilename, type FilenameRules } from '../legacy/content-urls.js';
import type {
  CategoryAssignmentInput,
  CategoryCrumbRow,
  CategoryFeatureRow,
  CategoryListRow,
  CategoryLookup,
  CategoryPatch,
  CategoryInput as CategoryRowInput,
  ContentRepository,
} from '../repo/repository.js';
import type { CategoryAssignRow, CategoryRow, TrashRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type DomainDeps, type LegacyErrors } from './context.js';
import { getModulePerm, sitePools } from './permissions.js';
import { UnregisteredTenantError, contentPoolSites, withGatedPoolTenant, withPoolTenant, type PoolSite } from './pools.js';
import {
  createTrashCounter,
  deleteMarkerAssignments,
  deleteMarkers,
  deletedParentId,
  takeOut,
  throwIn,
  trashObjectSubType,
  trashObjectType,
} from './trash.js';
import { WddxDate, cfStruct, wddxNumber, type WddxStruct, type WddxValue } from './wddx.js';

/** A CFML simple value as a categoryBean property holds it: text once set, a number from init or a numeric row value. */
export type CfSimpleValue = string | number;

/** categoryBean instance values (categoryBean.cfc:107-131 over bean.cfc:93-101), keys lower-cased. */
export interface CategoryBean {
  categoryid: string;
  siteid: string;
  /** A date, '' when unset, or the `{ts …}` text init assigns (`"#now()#"`). */
  datecreated: Date | string;
  lastupdate: Date | string;
  lastupdateby: string;
  name: string;
  isinterestgroup: CfSimpleValue;
  parentid: string;
  isactive: CfSimpleValue;
  isopen: CfSimpleValue;
  notes: string;
  sortby: string;
  sortdirection: string;
  restrictgroups: string;
  path: string;
  remoteid: string;
  remotesourceurl: string;
  remotepubdate: Date | string;
  urltitle: string;
  filename: string;
  isfeatureable: CfSimpleValue;
  /** 1 for a new bean, "0" once read from a row or created. */
  isnew: CfSimpleValue;
  frommuracache: boolean;
  instanceid: string;
  errors: LegacyErrors;
}

/** A legacy rc or data value. */
export type CategoryInputValue = string | number | boolean | Date | null | undefined;

/** The rc or data struct a category save reads: bean properties, `orderID`/`orderno` and `action`; keys case-insensitive. */
export interface CategoryInput {
  categoryid?: CategoryInputValue;
  siteid?: CategoryInputValue;
  datecreated?: CategoryInputValue;
  lastupdate?: CategoryInputValue;
  lastupdateby?: CategoryInputValue;
  name?: CategoryInputValue;
  isinterestgroup?: CategoryInputValue;
  parentid?: CategoryInputValue;
  isactive?: CategoryInputValue;
  isopen?: CategoryInputValue;
  notes?: CategoryInputValue;
  sortby?: CategoryInputValue;
  sortdirection?: CategoryInputValue;
  restrictgroups?: CategoryInputValue;
  path?: CategoryInputValue;
  remoteid?: CategoryInputValue;
  remotesourceurl?: CategoryInputValue;
  remotepubdate?: CategoryInputValue;
  urltitle?: CategoryInputValue;
  filename?: CategoryInputValue;
  isfeatureable?: CategoryInputValue;
  orderid?: CategoryInputValue;
  orderno?: CategoryInputValue;
  action?: CategoryInputValue;
  [key: string]: unknown;
}

/** What category operations run against. */
export type CategoryDeps = Pick<DomainDeps, 'db' | 'repository' | 'clock'>;

/** Settings of a category operation. */
export interface CategoryOptions {
  /** configBean `URLTitleDelim` and `allowUnicodeInFilenames`; the configBean defaults when absent. */
  filenameRules?: FilenameRules;
  requestId?: string;
}

/** configBean defaults of the filename rules (configBean.cfc:190, 205). */
export const CATEGORY_FILENAME_RULES_DEFAULT: Readonly<FilenameRules> = Object.freeze({ urlTitleDelim: '-', allowUnicodeInFilenames: false });

const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

/** `left(…, n)` of categoryBean setters. */
const AUDIT_NAME_LENGTH = 50;
const FILENAME_LENGTH = 255;

/** Columns categoryDAO selects into a bean (`variables.fieldlist`), as stored lower-cased. */
const DAO_FIELDS = [
  'categoryid', 'siteid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'isinterestgroup', 'parentid', 'isactive',
  'isopen', 'notes', 'sortby', 'sortdirection', 'restrictgroups', 'path', 'remoteid', 'remotesourceurl', 'remotepubdate',
  'urltitle', 'filename', 'isfeatureable',
] as const satisfies readonly (keyof CategoryBean & keyof CategoryRow)[];

/** Properties bean.setValue stores trimmed, having no setter of their own. */
type TextProperty =
  | 'siteid' | 'name' | 'parentid' | 'notes' | 'sortby' | 'sortdirection' | 'restrictgroups' | 'path' | 'remoteid'
  | 'remotesourceurl' | 'isinterestgroup' | 'isactive' | 'isopen';

const TEXT_PROPERTIES: ReadonlySet<string> = new Set<TextProperty>([
  'siteid', 'name', 'parentid', 'notes', 'sortby', 'sortdirection', 'restrictgroups', 'path', 'remoteid', 'remotesourceurl',
  'isinterestgroup', 'isactive', 'isopen',
]);

/** Lower-cased keys of a CFML struct; a later spelling of a key replaces an earlier one. */
type Data = ReadonlyMap<string, unknown>;

/** The struct of `input` as CFML resolves its keys. */
function dataOf(input: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const data = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) {
    data.set(key.toLowerCase(), value);
  }
  return data;
}

/** `structKeyExists`/`isDefined`: present with a non-null value. */
function has(data: Data, key: string): boolean {
  const value = data.get(key);
  return value !== undefined && value !== null;
}

/** A key legacy dereferences without a default; ACF fails the request when it is missing. */
function required(data: Data, key: string, scope: string): unknown {
  if (!has(data, key)) {
    throw new Error(`Element ${key.toUpperCase()} is undefined in ${scope}.`);
  }
  return data.get(key);
}

/** `{ts 'yyyy-mm-dd HH:nn:ss'}`, a date as ACF renders it in string context. */
function tsText(value: Date): string {
  return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

/** A simple value as CFML renders it in string context; a complex value fails as a string conversion would. */
function cfText(key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return tsText(value);
  throw new TypeError(`Category value '${key}' is not a simple value`);
}

/** `value` without its milliseconds, as a date round-tripped through its `{ts}` text. */
function wholeSeconds(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

const T_DATE_TIME = /\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/;
const SPACE_DATE_TIME = /\d\d\d\d-\d\d-\d\d\s\d\d:\d\d:\d\d/;

/** bean.parseDateArg (bean.cfc:278-301): a date, '' for no date, or the text itself when parsing throws. */
function parseDateArg(key: string, value: unknown): Date | string {
  if (value instanceof Date) return wholeSeconds(value);
  let arg = cfText(key, value);
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

/** categoryBean.setRemotePubDate (categoryBean.cfc:208-219). */
function remotePubDateOf(key: string, value: unknown): Date | string {
  if (value instanceof Date) return value;
  const text = cfText(key, value);
  if (!cfLsIsDate(text)) return '';
  try {
    return cfLsParseDateTime(text);
  } catch {
    return text;
  }
}

/** bean.setlastUpdateBy: `left(trim(value), 50)`. */
function lastUpdateByOf(value: string): string {
  return javaTrim(value).slice(0, AUDIT_NAME_LENGTH);
}

/** categoryBean.setFilename: `left(trim(value), 255)`. */
function filenameOf(value: string): string {
  return javaTrim(value).slice(0, FILENAME_LENGTH);
}

/** categoryBean.setURLTitle: a value CFML `!=` the current one is stored through contentUtility.formatFilename. */
function setUrlTitle(bean: CategoryBean, value: string, rules: FilenameRules): void {
  if (!cfEq(value, bean.urltitle)) {
    bean.urltitle = formatFilename(value, rules);
  }
}

/** The audit name a save stamps: `left(fname & " " & lname, 50)` through the trimming setter. */
function auditName(actor: Actor): string {
  return lastUpdateByOf(actor.fullName.slice(0, AUDIT_NAME_LENGTH));
}

/** getBean('category'): bean.cfc init, then categoryBean init. */
export function newCategoryBean(clock: Clock): CategoryBean {
  const now = tsText(clock.now());
  return {
    categoryid: '',
    siteid: '',
    datecreated: now,
    lastupdate: now,
    lastupdateby: '',
    name: '',
    isinterestgroup: 1,
    parentid: '',
    isactive: 1,
    isopen: 1,
    notes: '',
    sortby: 'orderno',
    sortdirection: 'asc',
    restrictgroups: '',
    path: '',
    remoteid: '',
    remotesourceurl: '',
    remotepubdate: '',
    urltitle: '',
    filename: '',
    isfeatureable: 1,
    isnew: 1,
    frommuracache: false,
    instanceid: cfUuid(),
    errors: {},
  };
}

/** bean.set(struct): each present key through its setter, or trimmed by setValue; an empty primary key is skipped. */
function applyData(bean: CategoryBean, data: Data, rules: FilenameRules): void {
  for (const [key, value] of data) {
    if (value === undefined || value === null) continue;
    switch (key) {
      case 'categoryid':
        if (cfText(key, value) !== '') bean.categoryid = javaTrim(cfText(key, value));
        break;
      case 'datecreated':
        bean.datecreated = parseDateArg(key, value);
        break;
      case 'lastupdate':
        bean.lastupdate = parseDateArg(key, value);
        break;
      case 'lastupdateby':
        bean.lastupdateby = lastUpdateByOf(cfText(key, value));
        break;
      case 'remotepubdate':
        bean.remotepubdate = remotePubDateOf(key, value);
        break;
      case 'urltitle':
        setUrlTitle(bean, cfText(key, value), rules);
        break;
      case 'filename':
        bean.filename = filenameOf(cfText(key, value));
        break;
      case 'isfeatureable':
        if (cfIsNumeric(value)) bean.isfeatureable = value as CfSimpleValue;
        break;
      default:
        if (TEXT_PROPERTIES.has(key)) bean[key as TextProperty] = javaTrim(cfText(key, value));
    }
  }
}

/** categoryDAO.read's `bean.set(rsCategory)` then `setIsNew(0)`: every selected column, NULL as ''. */
function loadedBean(row: CategoryRow, clock: Clock, rules: FilenameRules): CategoryBean {
  const bean = newCategoryBean(clock);
  applyData(bean, new Map(DAO_FIELDS.map((column) => [column, row[column] ?? ''])), rules);
  bean.isnew = '0';
  return bean;
}

/** bean.getAllValues() of `bean` as the data struct a save re-reads (categoryBean.save → categoryManager.save). */
function beanData(bean: CategoryBean): Map<string, unknown> {
  return new Map(DAO_FIELDS.map((column) => [column, bean[column]]));
}

/** A beanValidator rule of a categoryBean property: the value it reads and when that value fails. */
interface CategoryRule {
  value: (bean: CategoryBean) => unknown;
  required?: boolean;
  type?: 'numeric' | 'date';
  maxLength?: number;
}

// Keyed as bean.getValidations keys them (relationships by fkcolumn); `string` rules always pass, so only key order matters.
const RULES: Readonly<Record<string, CategoryRule>> = {
  categoryID: { value: (b) => b.categoryid, maxLength: 35 },
  parentid: { value: (b) => b.parentid, maxLength: 35 },
  siteid: { value: (b) => b.siteid, maxLength: 25 },
  dateCreated: { value: (b) => b.datecreated, type: 'date' },
  lastUpdate: { value: (b) => b.lastupdate, type: 'date' },
  lastUpdateBy: { value: (b) => b.lastupdateby },
  name: { value: (b) => b.name, required: true },
  isInterestGroup: { value: (b) => b.isinterestgroup, required: true, type: 'numeric' },
  isActive: { value: (b) => b.isactive, required: true, type: 'numeric' },
  isOpen: { value: (b) => b.isopen, type: 'numeric' },
  // The property is `note`; the bean holds `notes`, so the rule reads ''.
  note: { value: () => '' },
  sortBy: { value: (b) => b.sortby, required: true },
  sortDirection: { value: (b) => b.sortdirection, required: true },
  restrictGroups: { value: (b) => b.restrictgroups },
  path: { value: (b) => b.path },
  remoteID: { value: (b) => b.remoteid },
  remoteSourceURL: { value: (b) => b.remotesourceurl },
  remotePubDate: { value: (b) => b.remotepubdate, type: 'date' },
  URLtitle: { value: (b) => b.urltitle },
  filename: { value: (b) => b.filename },
  isFeatureable: { value: (b) => b.isfeatureable, required: true, type: 'numeric' },
};

/** categoryBean's properties in metadata order (its own, then bean.cfc's) and the rule key of those with rules. */
const PROPERTY_RULE_KEYS: ReadonlyArray<readonly [string, string | null]> = [
  ['categoryID', 'categoryID'], ['kids', null], ['parent', 'parentid'], ['contentAssignments', null], ['site', 'siteid'],
  ['dateCreated', 'dateCreated'], ['lastUpdate', 'lastUpdate'], ['lastUpdateBy', 'lastUpdateBy'], ['name', 'name'],
  ['isInterestGroup', 'isInterestGroup'], ['isActive', 'isActive'], ['isOpen', 'isOpen'], ['note', 'note'],
  ['sortBy', 'sortBy'], ['sortDirection', 'sortDirection'], ['restrictGroups', 'restrictGroups'], ['path', 'path'],
  ['remoteID', 'remoteID'], ['remoteSourceURL', 'remoteSourceURL'], ['remotePubDate', 'remotePubDate'],
  ['URLtitle', 'URLtitle'], ['filename', 'filename'], ['isNew', null], ['isFeatureable', 'isFeatureable'],
  ['errors', null], ['fromMuraCache', null], ['instanceID', null],
];

/** Keys of a struct built by assigning `keys` in order, in ACF iteration order. */
function structOrder(keys: readonly string[]): string[] {
  return cfStruct(keys.map((key): [string, WddxValue] => [key, ''])).entries.map(([key]) => key);
}

// beanValidator walks the context-validation struct, built from the validations struct, built from the properties struct.
const RULE_KEY_OF = new Map(PROPERTY_RULE_KEYS);
const VALIDATION_ORDER: readonly string[] = structOrder(
  structOrder(structOrder(PROPERTY_RULE_KEYS.map(([property]) => property)).flatMap((property) => RULE_KEY_OF.get(property) ?? [])),
);

/** CFML `len()` of a simple value. */
function cfLen(value: unknown): number {
  return value instanceof Date ? tsText(value).length : cfText('value', value).length;
}

/** Whether `rule` fails for `value`: required and empty, or a present value of the wrong type or length. */
function ruleFails(rule: CategoryRule, value: unknown): boolean {
  const empty = !cfIsNumeric(value) && cfLen(value) === 0;
  if (rule.required === true && empty) return true;
  if (empty) return false;
  if (rule.type === 'numeric' && !cfIsNumeric(value)) return true;
  if (rule.type === 'date' && !(value instanceof Date) && !cfIsDateText(cfText('value', value))) return true;
  return rule.maxLength !== undefined && cfLen(value) > rule.maxLength;
}

/** categoryBean.validate(): beanValidator's errors in ACF struct order (Masa's default `stricthtml` off; no add objects). */
export function validateCategory(bean: CategoryBean): LegacyErrors {
  const failing = VALIDATION_ORDER.filter((key) => {
    const rule = RULES[key];
    return rule !== undefined && ruleFails(rule, rule.value(bean));
  });
  const errors: LegacyErrors = {};
  for (const key of structOrder(failing)) {
    errors[key] = `The property named '${key}' is not valid`;
  }
  return errors;
}

/** A bean value as cfwddx writes it. */
function wddxValueOf(value: CfSimpleValue | Date): WddxValue {
  if (value instanceof Date) return new WddxDate(value);
  return typeof value === 'number' ? wddxNumber(value) : value;
}

/** The bean's getAllValues() struct in ACF key order (upper-cased init keys), then `extra` such as the trash markers. */
export function categoryStruct(bean: CategoryBean, extra: Iterable<readonly [string, WddxValue]> = []): WddxStruct {
  return cfStruct([
    ['ISNEW', wddxNumber(1)],
    ['ERRORS', cfStruct(Object.entries(bean.errors))],
    ['FROMMURACACHE', bean.frommuracache],
    ['INSTANCEID', bean.instanceid],
    ['ADDOBJECTS', []],
    ['REMOVEOBJECTS', []],
    ['CATEGORYID', bean.categoryid],
    ['SITEID', bean.siteid],
    ['DATECREATED', wddxValueOf(bean.datecreated)],
    ['LASTUPDATE', wddxValueOf(bean.lastupdate)],
    ['LASTUPDATEBY', bean.lastupdateby],
    ['NAME', bean.name],
    ['ISINTERESTGROUP', wddxValueOf(bean.isinterestgroup)],
    ['PARENTID', bean.parentid],
    ['ISACTIVE', wddxValueOf(bean.isactive)],
    ['ISOPEN', wddxValueOf(bean.isopen)],
    ['NOTES', bean.notes],
    ['SORTBY', bean.sortby],
    ['SORTDIRECTION', bean.sortdirection],
    ['RESTRICTGROUPS', bean.restrictgroups],
    ['PATH', bean.path],
    ['REMOTEID', bean.remoteid],
    ['REMOTESOURCEURL', bean.remotesourceurl],
    ['REMOTEPUBDATE', wddxValueOf(bean.remotepubdate)],
    ['URLTITLE', bean.urltitle],
    ['FILENAME', bean.filename],
    ['ISNEW', wddxValueOf(bean.isnew)],
    ['ISFEATUREABLE', wddxValueOf(bean.isfeatureable)],
    ...extra,
  ]);
}

/** The DAO's `isDate(x) ? cf_sql_timestamp : null` of dateCreated and lastUpdate. */
function auditDateColumn(value: Date | string): Date | null {
  if (value instanceof Date) return value;
  return value !== '' && cfIsDateText(value) ? cfTimestampParam(value) : null;
}

/** The DAO's `iif(isNumeric(x), x, 0)` of an integer flag. */
function flagColumn(value: CfSimpleValue): number {
  return cfIsNumeric(value) ? cfToNumber(value) : 0;
}

/** The tcontentcategories columns categoryDAO.update binds (categoryDAO.cfc:343-364); the repository stores '' as NULL. */
function updateColumns(bean: CategoryBean): CategoryPatch {
  return {
    lastupdate: auditDateColumn(bean.lastupdate),
    lastupdateby: bean.lastupdateby,
    name: bean.name,
    isactive: flagColumn(bean.isactive),
    isopen: flagColumn(bean.isopen),
    parentid: bean.parentid,
    isinterestgroup: flagColumn(bean.isinterestgroup),
    notes: bean.notes,
    sortby: bean.sortby,
    sortdirection: bean.sortdirection,
    restrictgroups: bean.restrictgroups,
    path: bean.path,
    remoteid: bean.remoteid,
    remotesourceurl: bean.remotesourceurl,
    remotepubdate: bean.remotepubdate === '' ? null : cfTimestampParam(bean.remotepubdate),
    urltitle: bean.urltitle,
    filename: bean.filename,
    isfeatureable: flagColumn(bean.isfeatureable),
  };
}

/** The tcontentcategories row categoryDAO.create inserts (categoryDAO.cfc:89-119). */
function createColumns(bean: CategoryBean): CategoryRowInput {
  return {
    ...updateColumns(bean),
    categoryid: bean.categoryid,
    siteid: bean.siteid,
    datecreated: auditDateColumn(bean.datecreated),
  };
}

/** The token's site and its category pool site (settingsBean getCategoryPoolID), each with the tenant its rows live in. */
interface CategorySites {
  own: PoolSite;
  pool: PoolSite;
}

/** The open transactions of one operation: the category pool tenant's, and the token tenant's when it differs. */
interface CategoryScope {
  sites: CategorySites;
  poolTx: TenantTx;
  ownTx: TenantTx;
  /** Pool first. */
  txs: readonly TenantTx[];
}

/** One category operation: its scope, collaborators and write context. */
interface CategoryOp {
  repository: ContentRepository;
  clock: Clock;
  actor: Actor;
  scope: CategoryScope;
  rules: FilenameRules;
  write: WriteContext;
  /** Ids whose categoryManager.save is on the stack, which a cyclic parent chain would re-enter. */
  saving: Set<string>;
}

/** SQL Server's `siteid = …` under its case-insensitive collation, trailing spaces ignored. */
function sameSite(a: string, b: string): boolean {
  return a.replace(/ +$/u, '').toLowerCase() === b.replace(/ +$/u, '').toLowerCase();
}

/** The registry's category pool of the token's tenant. */
async function categorySites(tx: TenantTx, actor: Actor): Promise<CategorySites> {
  const entry = await registryEntryForTenant(tx, actor.tenantId);
  if (entry === null) {
    throw new UnregisteredTenantError(actor.tenantId);
  }
  return {
    own: { siteId: entry.siteId, tenantId: entry.tenantId },
    pool: { siteId: entry.categoryPoolId ?? entry.siteId, tenantId: entry.categoryPoolTenant ?? entry.tenantId },
  };
}

// Rows live in the tenant of their stored siteid. Legacy reads by pool but stores, and scopes path, filename and
// uniqueness statements, by the bean's own siteid, so those run in the token's tenant when its pool is another site.
/** The transaction holding the category rows of `siteId`, or null for a site that is neither the token's nor its pool. */
function siteTx(scope: CategoryScope, siteId: string): TenantTx | null {
  if (sameSite(siteId, scope.sites.pool.siteId)) return scope.poolTx;
  if (siteId === '' || sameSite(siteId, scope.sites.own.siteId)) return scope.ownTx;
  return null;
}

/** Runs `fn` in the category pool tenant (gated for writes), nesting a token-tenant transaction when that differs. */
async function inCategoryScope<T>(deps: CategoryDeps, actor: Actor, gated: boolean, fn: (scope: CategoryScope) => Promise<T>): Promise<T> {
  const run = async (poolTx: TenantTx): Promise<T> => {
    const sites = await categorySites(poolTx, actor);
    if (sites.own.tenantId === poolTx.tenantId) {
      return fn({ sites, poolTx, ownTx: poolTx, txs: [poolTx] });
    }
    return withTenant(deps.db, sites.own.tenantId, (ownTx) => fn({ sites, poolTx, ownTx, txs: [poolTx, ownTx] }));
  };
  return gated
    ? withGatedPoolTenant(deps.db, actor.tenantId, 'category', (tx) => run(tx))
    : withPoolTenant(deps.db, actor.tenantId, 'category', (tx) => run(tx));
}

/** Runs `fn` in the category pool tenant with the pool site; for reads legacy scopes to `getCategoryPoolID()`. */
function inCategoryPool<T>(deps: CategoryDeps, actor: Actor, fn: (tx: TenantTx, pool: PoolSite) => Promise<T>): Promise<T> {
  return withPoolTenant(deps.db, actor.tenantId, 'category', async (tx) => fn(tx, (await categorySites(tx, actor)).pool));
}

function newOp(deps: CategoryDeps, actor: Actor, scope: CategoryScope, opts: CategoryOptions): CategoryOp {
  return {
    repository: deps.repository,
    clock: deps.clock,
    actor,
    scope,
    rules: opts.filenameRules ?? CATEGORY_FILENAME_RULES_DEFAULT,
    write: writeContextFor(actor, opts.requestId),
    saving: new Set(),
  };
}

/** A stored category and the transaction of the tenant holding it. */
interface FoundCategory {
  row: CategoryRow;
  tx: TenantTx;
}

/** categoryDAO.read's `categoryID = ?` over the tenants the token reaches, pool first. */
async function findById(op: CategoryOp, categoryId: string): Promise<FoundCategory | null> {
  for (const tx of op.scope.txs) {
    const [row] = await op.repository.categories.readCategory(tx, { categoryId });
    if (row !== undefined) return { row, tx };
  }
  return null;
}

/** categoryDAO.read: the stored category as a bean, else a new bean. */
async function readById(op: CategoryOp, categoryId: string): Promise<{ bean: CategoryBean; found: FoundCategory | null }> {
  const found = await findById(op, categoryId);
  return { bean: found === null ? newCategoryBean(op.clock) : loadedBean(found.row, op.clock, op.rules), found };
}

// Legacy walks a cyclic parent chain until the request times out; the walk fails instead of holding its transactions.
/** A parent chain that returns to an id already visited. */
function cyclicParents(categoryId: string): Error {
  return new Error(`Category ${categoryId} is its own ancestor`);
}

/** categoryManager.setMaterializedPath (categoryManager.cfc:181-209): the bean's site's ancestors, root first, then its id. */
async function setMaterializedPath(op: CategoryOp, bean: CategoryBean): Promise<void> {
  let id = bean.parentid;
  let path = bean.categoryid;
  if (id !== '') {
    const tx = siteTx(op.scope, bean.siteid);
    const visited = new Set<string>();
    while (id !== '') {
      if (visited.has(id.toUpperCase())) throw cyclicParents(id);
      visited.add(id.toUpperCase());
      path = cfListAppend(path, id);
      const rows = tx === null ? [] : await op.repository.categories.readCategory(tx, { categoryId: id });
      id = rows.find((row) => row.siteid !== null && sameSite(row.siteid, bean.siteid))?.parentid ?? '';
    }
    path = cfListToArray(path).reduceRight((reversed, item) => cfListAppend(reversed, item), '');
  }
  bean.path = path;
}

/** categoryManager.updateMaterializedPath (categoryManager.cfc:211-225) on the rows of `siteId`. */
async function updateMaterializedPath(op: CategoryOp, newPath: string, currentPath: string, siteId: string): Promise<void> {
  const tx = siteTx(op.scope, siteId);
  if (tx !== null) {
    await op.repository.categories.replacePathPrefix(tx, { siteId, currentPath, newPath }, op.write);
  }
}

/** categoryManager.makeFilenameUnique (categoryManager.cfc:328-353): appends 1, 2, … while another category of the site has the filename. */
async function makeFilenameUnique(op: CategoryOp, bean: CategoryBean): Promise<void> {
  const tx = siteTx(op.scope, bean.siteid);
  let count = 0;
  let candidate = bean.filename;
  while (
    tx !== null &&
    (await op.repository.categories.filenameInUse(tx, { categoryId: bean.categoryid, filename: candidate, siteId: bean.siteid }))
  ) {
    count += 1;
    candidate = `${bean.filename}${count}`;
  }
  if (count > 0) {
    bean.filename = filenameOf(candidate);
    setUrlTitle(bean, cfListToArray(candidate, '/').at(-1) ?? '', op.rules);
  }
}

/** The parent's filename (re-saving a parent that has none first, as legacy does) with the URL title, made unique. */
async function setFilenameUnderParent(op: CategoryOp, bean: CategoryBean): Promise<void> {
  let parent = await readById(op, bean.parentid);
  if (parent.found !== null) {
    if (parent.bean.filename === '') {
      await saveInScope(op, beanData(parent.bean));
      parent = await readById(op, bean.parentid);
    }
    bean.filename = filenameOf(`${parent.bean.filename}/${bean.urltitle}`);
  } else {
    bean.filename = filenameOf(bean.urltitle);
  }
  await makeFilenameUnique(op, bean);
}

/** categoryManager.save (categoryManager.cfc:227-255): update when a category has the id, else create. */
async function saveInScope(op: CategoryOp, data: Data): Promise<{ bean: CategoryBean; updated: boolean }> {
  if (!has(data, 'categoryid')) {
    throw new Error("The attribute 'CATEGORYID' is required when saving a category.");
  }
  const categoryId = cfText('categoryid', data.get('categoryid'));
  const key = categoryId.toUpperCase();
  if (op.saving.has(key)) throw cyclicParents(categoryId);
  op.saving.add(key);
  const saved =
    (await findById(op, categoryId)) === null
      ? { bean: await createInScope(op, data), updated: false }
      : { bean: await updateInScope(op, data), updated: true };
  op.saving.delete(key);
  return saved;
}

/** categoryManager.create (categoryManager.cfc:257-326); a bean with validation errors writes nothing. */
async function createInScope(op: CategoryOp, data: Data): Promise<CategoryBean> {
  const bean = newCategoryBean(op.clock);
  applyData(bean, data, op.rules);
  bean.errors = validateCategory(bean);
  if (Object.keys(bean.errors).length > 0) return bean;

  bean.lastupdate = wholeSeconds(op.clock.now());
  bean.lastupdateby = auditName(op.actor);
  if (!(has(data, 'categoryid') && cfText('categoryid', data.get('categoryid')) !== '')) {
    bean.categoryid = cfUuid();
  }
  await setMaterializedPath(op, bean);
  if (bean.urltitle === '') setUrlTitle(bean, bean.name, op.rules);
  await setFilenameUnderParent(op, bean);

  const tx = siteTx(op.scope, bean.siteid);
  if (tx === null) {
    throw new Error(`Category site ${bean.siteid} is neither the token's site nor its category pool`);
  }
  await op.repository.categories.insertCategory(tx, createColumns(bean), op.write);
  takeOut(categoryStruct(bean));
  bean.isnew = '0';
  return bean;
}

/** categoryManager.update (categoryManager.cfc:687-770) through the DAO update; the list order is the caller's, after commit. */
async function updateInScope(op: CategoryOp, data: Data): Promise<CategoryBean> {
  const { bean, found } = await readById(op, cfText('categoryid', required(data, 'categoryid', 'ARGUMENTS.DATA')));
  const currentParentId = bean.parentid;
  const currentUrlTitle = bean.urltitle;
  const currentFilename = bean.filename;
  applyData(bean, data, op.rules);
  bean.errors = validateCategory(bean);
  // Read after the data is applied, as legacy reads it.
  const currentPath = bean.path;
  if (Object.keys(bean.errors).length > 0) return bean;

  if (bean.urltitle === '') setUrlTitle(bean, bean.name, op.rules);
  const moved = !cfEq(currentParentId, bean.parentid);
  if (moved || !cfEq(currentUrlTitle, bean.urltitle)) {
    if (moved) {
      await setMaterializedPath(op, bean);
      await updateMaterializedPath(op, bean.path, currentPath, bean.siteid);
    }
    await setFilenameUnderParent(op, bean);
    const tx = siteTx(op.scope, bean.siteid);
    if (tx !== null) {
      await op.repository.categories.replaceFilenamePrefix(
        tx,
        { siteId: bean.siteid, currentFilename, newFilename: bean.filename },
        op.write,
      );
    }
  }
  bean.lastupdate = wholeSeconds(op.clock.now());
  bean.lastupdateby = auditName(op.actor);
  if (found !== null) {
    await op.repository.categories.updateCategory(found.tx, bean.categoryid, updateColumns(bean), op.write);
  }
  return bean;
}

/** A category delete: the bean as read, and the trash row throwIn inserted (null when one existed). */
export interface CategoryDeletion {
  bean: CategoryBean;
  trash: TrashRow | null;
}

/** categoryManager.delete (categoryManager.cfc:786-818): descendants' paths, throwIn, then categoryDAO.delete. */
async function deleteInScope(op: CategoryOp, categoryId: string): Promise<CategoryDeletion> {
  const { bean, found } = await readById(op, categoryId);
  const currentPath = bean.path;
  if (currentPath !== '') {
    await updateMaterializedPath(op, cfListToArray(currentPath).slice(0, -1).join(','), currentPath, bean.siteid);
  }
  const markers = deleteMarkers(op.clock.now());
  const values = categoryStruct(bean, deleteMarkerAssignments(markers));
  const trash = await throwIn(
    found?.tx ?? op.scope.ownTx,
    op.repository,
    {
      objectClass: 'category',
      objectId: bean.categoryid,
      parentId: deletedParentId(values),
      siteId: bean.siteid !== '' ? bean.siteid : op.actor.siteId,
      label: bean.name,
      objectType: trashObjectType(values, 'category'),
      objectSubType: trashObjectSubType(values),
      values,
      ...markers,
    },
    op.actor,
    createTrashCounter(),
    op.write,
  );
  // categoryDAO.delete reparents children of every site, so each reachable tenant's children move up.
  for (const tx of op.scope.txs) {
    await op.repository.categories.deleteCategory(tx, { categoryId, parentId: bean.parentid }, op.write);
  }
  return { bean, trash };
}

/** ccategory.cfc before() (86-89): the site's private-pool Admin or S2, else both the Categories and Site Manager module permissions. */
export function categoryAccess(actor: Actor): boolean {
  // getModulePerm already answers true for S2 and the site Admin role.
  return getModulePerm(actor, CATEGORY_MODULE_ID) && getModulePerm(actor, SITE_MANAGER_MODULE_ID);
}

/** How categoryManager.read finds a category: by id, else within the category pool by name, remote id, filename or URL title. */
export interface CategoryReadKey {
  categoryId?: string;
  name?: string;
  remoteId?: string;
  filename?: string;
  urlTitle?: string;
  /** The site a bean not found by name, remote id, filename or URL title takes; the token's site when absent. */
  siteId?: string;
}

/** categoryManager.readByFilename's trimming of one leading and one trailing slash. */
function trimSlashes(filename: string): string {
  if (filename === '/') return '';
  let trimmed = filename;
  if (trimmed.startsWith('/')) trimmed = trimmed.length > 1 ? trimmed.slice(1) : '';
  if (trimmed.endsWith('/')) trimmed = trimmed.length > 1 ? trimmed.slice(0, -1) : '';
  return trimmed;
}

/** The readBy lookup categoryManager.read picks for an empty id: name, then remote id, filename, URL title; null for none. */
function readByLookup(key: CategoryReadKey, poolSiteId: string): CategoryLookup | null {
  if ((key.name ?? '') !== '') return { name: key.name ?? '', siteId: poolSiteId };
  if ((key.remoteId ?? '') !== '') return { remoteId: key.remoteId ?? '', siteId: poolSiteId };
  if ((key.filename ?? '') !== '') return { filename: trimSlashes(key.filename ?? ''), siteId: poolSiteId };
  if ((key.urlTitle ?? '') !== '') return { urlTitle: key.urlTitle ?? '', siteId: poolSiteId };
  return null;
}

/** categoryManager.read (categoryManager.cfc:355-620): by id over pool and own tenant, else by a readBy key in the pool. */
export function readCategory(deps: CategoryDeps, actor: Actor, key: string, opts?: CategoryOptions): Promise<CategoryBean>;
export function readCategory(
  deps: CategoryDeps,
  actor: Actor,
  key: CategoryReadKey,
  opts?: CategoryOptions,
): Promise<CategoryBean | CategoryBean[]>;
export async function readCategory(
  deps: CategoryDeps,
  actor: Actor,
  key: string | CategoryReadKey,
  opts: CategoryOptions = {},
): Promise<CategoryBean | CategoryBean[]> {
  const readKey: CategoryReadKey = typeof key === 'string' ? { categoryId: key } : key;
  const categoryId = readKey.categoryId ?? '';
  const siteId = (readKey.siteId ?? '') !== '' ? (readKey.siteId ?? '') : actor.siteId;
  const rules = opts.filenameRules ?? CATEGORY_FILENAME_RULES_DEFAULT;
  if (categoryId === '' && siteId !== '') {
    const found = await inCategoryPool(deps, actor, async (tx, pool) => {
      const lookup = readByLookup(readKey, pool.siteId);
      return lookup === null ? null : deps.repository.categories.readCategory(tx, lookup);
    });
    if (found !== null) {
      if (found.length > 1) return found.map((row) => loadedBean(row, deps.clock, rules));
      const [row] = found;
      if (row !== undefined) return loadedBean(row, deps.clock, rules);
      return { ...newCategoryBean(deps.clock), siteid: siteId };
    }
  }
  return inCategoryScope(deps, actor, false, async (scope) => (await readById(newOp(deps, actor, scope, opts), categoryId)).bean);
}

/** Arguments of categoryManager.getCategories; the site is the token's, read through its category pool. */
export interface ListCategoriesOptions {
  parentId?: string;
  keywords?: string;
  activeOnly?: boolean;
  interestsOnly?: boolean;
}

/** categoryGateway.getCategories: a level of the pool's tree (top level without `parentId`) with child counts, by name. */
export function listCategories(deps: CategoryDeps, actor: Actor, args: ListCategoriesOptions = {}): Promise<CategoryListRow[]> {
  return inCategoryPool(deps, actor, (tx, pool) => deps.repository.categories.listCategories(tx, { ...args, siteId: pool.siteId }));
}

/** categoryGateway.getCategoriesBySiteID, or getInterestGroupsBySiteID with `interestOnly`: every pool category, by name. */
export function listPoolCategories(
  deps: CategoryDeps,
  actor: Actor,
  args: { keywords?: string; interestOnly?: boolean } = {},
): Promise<CategoryRow[]> {
  return inCategoryPool(deps, actor, (tx, pool) => {
    const query = { siteId: pool.siteId, keywords: args.keywords ?? '' };
    return args.interestOnly === true
      ? deps.repository.categories.interestGroupsBySite(tx, query)
      : deps.repository.categories.categoriesBySite(tx, query);
  });
}

/** categoryGateway.getCategoryCount, or getInterestGroupCount with `interestOnly`. */
export function countCategories(
  deps: CategoryDeps,
  actor: Actor,
  args: { activeOnly?: boolean; interestOnly?: boolean } = {},
): Promise<number> {
  return inCategoryPool(deps, actor, (tx, pool) => {
    const query = { siteId: pool.siteId, activeOnly: args.activeOnly === true };
    return args.interestOnly === true
      ? deps.repository.categories.interestGroupCount(tx, query)
      : deps.repository.categories.categoryCount(tx, query);
  });
}

/** categoryManager.getCrumbQuery: the pool categories a materialized path names, by depth (`desc` reverses). */
export function categoryCrumbs(deps: CategoryDeps, actor: Actor, args: { path: string; sort?: string }): Promise<CategoryCrumbRow[]> {
  const sort = cfEq(args.sort ?? 'asc', 'desc') ? 'desc' : 'asc';
  return inCategoryPool(deps, actor, (tx, pool) => deps.repository.categories.crumbQuery(tx, { path: args.path, siteId: pool.siteId, sort }));
}

/** categoryManager.getCategoryFeatures, or getLiveCategoryFeatures with `live`: the token tenant's featured content. */
export async function categoryFeatures(
  deps: CategoryDeps,
  actor: Actor,
  categoryId: string,
  opts: CategoryOptions & { live?: boolean } = {},
): Promise<CategoryFeatureRow[]> {
  const bean = await readCategory(deps, actor, categoryId, opts);
  const args = { categoryId: bean.categoryid, sortBy: bean.sortby, sortDirection: bean.sortdirection };
  return withTenant(deps.db, actor.tenantId, (tx) =>
    opts.live === true ? deps.repository.categories.liveCategoryFeatures(tx, args) : deps.repository.categories.categoryFeatures(tx, args),
  );
}

/** categoryManager.create: the new bean, or the bean with its validation errors and nothing written. */
export function createCategory(deps: CategoryDeps, actor: Actor, input: CategoryInput, opts: CategoryOptions = {}): Promise<CategoryBean> {
  const data = dataOf(input);
  return inCategoryScope(deps, actor, true, (scope) => createInScope(newOp(deps, actor, scope, opts), data));
}

/** update's `setListOrder` when the data carries `orderID` and validation passed (categoryManager.cfc:771-773). */
async function applyListOrder(deps: CategoryDeps, actor: Actor, data: Data, bean: CategoryBean, opts: CategoryOptions): Promise<void> {
  if (Object.keys(bean.errors).length > 0 || !has(data, 'orderid')) return;
  await setListOrder(
    deps,
    actor,
    {
      categoryId: bean.categoryid,
      orderId: cfText('orderid', data.get('orderid')),
      orderno: cfText('orderno', required(data, 'orderno', 'ARGUMENTS.DATA')),
      siteId: cfText('siteid', required(data, 'siteid', 'ARGUMENTS.DATA')),
    },
    opts,
  );
}

/** categoryManager.update: the updated bean, or the bean with its validation errors and nothing written. */
export async function updateCategory(deps: CategoryDeps, actor: Actor, input: CategoryInput, opts: CategoryOptions = {}): Promise<CategoryBean> {
  const data = dataOf(input);
  const bean = await inCategoryScope(deps, actor, true, (scope) => updateInScope(newOp(deps, actor, scope, opts), data));
  await applyListOrder(deps, actor, data, bean, opts);
  return bean;
}

/** categoryManager.save (categoryBean.save): update when a category has the data's id, else create. */
export async function saveCategory(deps: CategoryDeps, actor: Actor, input: CategoryInput, opts: CategoryOptions = {}): Promise<CategoryBean> {
  const data = dataOf(input);
  const saved = await inCategoryScope(deps, actor, true, (scope) => saveInScope(newOp(deps, actor, scope, opts), data));
  if (saved.updated) await applyListOrder(deps, actor, data, saved.bean, opts);
  return saved.bean;
}

/** categoryManager.delete: children's paths rewritten, one trash row (objectClass `category`), children reparented, row removed. */
export function deleteCategory(deps: CategoryDeps, actor: Actor, categoryId: string, opts: CategoryOptions = {}): Promise<CategoryDeletion> {
  return inCategoryScope(deps, actor, true, (scope) => deleteInScope(newOp(deps, actor, scope, opts), categoryId));
}

/** One contentUtility.getRestrictGroups row. */
export interface RestrictGroupRow {
  groupname: string;
  userid: string;
  ispublic: number;
}

/** contentUtility.getRestrictGroups (contentUtility.cfc:302-317): public-pool then private-pool groups, `Admin` excepted. */
export async function restrictGroups(deps: Pick<DomainDeps, 'db' | 'repository'>, actor: Actor): Promise<RestrictGroupRow[]> {
  const pools = await sitePools(deps, actor);
  const rows: RestrictGroupRow[] = [];
  for (const [kind, siteId, isPublic] of [
    ['publicUser', pools.publicUserPoolId, 1],
    ['privateUser', pools.privateUserPoolId, 0],
  ] as const) {
    const groups = await withPoolTenant(deps.db, actor.tenantId, kind, (tx) => deps.repository.projections.restrictGroups(tx, { siteId, isPublic }));
    rows.push(...groups.map((group) => ({ groupname: group.group_name ?? '', userid: javaTrim(group.group_id), ispublic: isPublic })));
  }
  return rows;
}

/** The ccategory.update outcome: the list redirect, or the edit form re-rendered with the bean's errors. */
export type CategoryActionOutcome =
  | { kind: 'redirect'; action: 'cCategory.list'; append: readonly ['siteid'] }
  | { kind: 'rerender'; bean: CategoryBean; rsRestrictGroups: RestrictGroupRow[] };

/** Settings of updateCategoryAction; `csrfValid` is the route's `validateCSRFTokens(context=rc.categoryid)` verdict. */
export interface CategoryActionOptions extends CategoryOptions {
  csrfValid?: boolean;
}

const LIST_REDIRECT: CategoryActionOutcome = Object.freeze({ kind: 'redirect', action: 'cCategory.list', append: Object.freeze(['siteid'] as const) });

/** ccategory.update (ccategory.cfc:99-121): runs `action` when the token is valid, then redirects unless errors remain. */
export async function updateCategoryAction(
  deps: Pick<DomainDeps, 'db' | 'repository' | 'clock'>,
  actor: Actor,
  rc: CategoryInput,
  opts: CategoryActionOptions = {},
): Promise<CategoryActionOutcome> {
  const data = dataOf(rc);
  const action = cfText('action', required(data, 'action', 'RC'));
  let bean: CategoryBean | undefined;
  if (opts.csrfValid ?? true) {
    switch (action.toLowerCase()) {
      case 'update':
        bean = await updateCategory(deps, actor, rc, opts);
        break;
      case 'delete':
        await deleteCategory(deps, actor, cfText('categoryid', required(data, 'categoryid', 'RC')), opts);
        break;
      case 'add':
        bean = await createCategory(deps, actor, rc, opts);
        break;
      default:
        break;
    }
  }
  if (cfEq(action, 'delete')) return LIST_REDIRECT;
  if (bean === undefined) {
    // A rejected token or unknown action leaves rc.categoryBean undefined, which legacy then dereferences.
    throw new Error('Element CATEGORYBEAN is undefined in ARGUMENTS.RC.');
  }
  if (Object.keys(bean.errors).length === 0) return LIST_REDIRECT;
  return { kind: 'rerender', bean, rsRestrictGroups: await restrictGroups(deps, actor) };
}

/** Arguments of categoryManager.setListOrder: parallel CF lists of content ids and order numbers. */
export interface SetListOrderArgs {
  categoryId: string;
  orderId: string;
  orderno: string;
  /** The token's site, whose content pool the assignments are reordered in (the route checks it equals the token's). */
  siteId: string;
}

/** categoryDAO.setListOrder (categoryDAO.cfc:386-404): each item's `orderno`, one gated transaction per content-pool tenant. */
export async function setListOrder(
  deps: Pick<DomainDeps, 'db' | 'repository'>,
  actor: Actor,
  args: SetListOrderArgs,
  opts: Pick<CategoryOptions, 'requestId'> = {},
): Promise<CategoryAssignRow[]> {
  const numbers = cfListToArray(args.orderno);
  const items = cfListToArray(args.orderId).map((contentId, index) => {
    const orderNo = numbers[index];
    if (orderNo === undefined) {
      throw new Error(`Invalid list index ${index + 1}.`);
    }
    return { contentId, orderNo: cfToNumber(orderNo) };
  });
  const write = writeContextFor(actor, opts.requestId);
  const updated: CategoryAssignRow[] = [];
  for (const site of await contentPoolSites(deps.db, actor.tenantId)) {
    const rows = await withGatedTenant(deps.db, site.tenantId, (tx) =>
      deps.repository.categories.setListOrder(tx, { categoryId: args.categoryId, items, siteIds: [site.siteId] }, write),
    );
    updated.push(...rows);
  }
  return updated;
}

/** A content save's category assignments, written in the content's tenant transaction. */
export interface SetCategoryAssignmentsArgs {
  /** The save's data (rc): `categoryID` list, `categoryAssign<id>` values and feature schedule fields; keys case-insensitive. */
  data: Readonly<Record<string, unknown>>;
  contentId: string;
  contentHistId: string;
  siteId: string;
  /** categoryGateway.getCategoriesBySiteID(siteID, '') rows, read beforehand in the category pool tenant (`listPoolCategories`). */
  poolCategories: readonly Pick<CategoryRow, 'categoryid'>[];
  /** The source version's assignments (`rsCurrent`). */
  current: readonly CategoryAssignmentInput[];
  write?: WriteContext;
}

/** CFML `isDate` of a schedule field and its date. */
function scheduleDate(key: string, value: unknown): Date | null {
  if (value instanceof Date) return value;
  const text = cfText(key, value);
  return cfIsDateText(text) ? cfParseDateTimeText(text) : null;
}

/** CFML `createDateTime(y, m, d, h, n, 0)`; an hour or minute out of range fails as ACF does. */
function createDateTime(day: Date, hour: unknown, minute: unknown): Date {
  const h = cfToNumber(hour);
  const n = cfToNumber(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(n) || n < 0 || n > 59) {
    throw new Error(`Invalid time ${String(hour)}:${String(minute)} for createDateTime.`);
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, n, 0, 0);
}

/** categoryDAO.setAssignment's hour of a feature start or stop after its AM/PM day part. */
function scheduleHour(hour: unknown, dayPart: string): unknown {
  if (cfEq(dayPart, 'PM')) {
    const pm = cfToNumber(hour) + 12;
    return pm === 24 ? 12 : pm;
  }
  if (cfEq(dayPart, 'AM') && cfEq(cfText('hour', hour), '12')) return 0;
  return hour;
}

/** One half of setCategories' `schedule` struct; the day part defaults to '' (cfparam), the other fields must be posted. */
interface ScheduleFields {
  day: Date | null;
  hour: unknown;
  minute: unknown;
  dayPart: string;
}

/** The feature start or stop fields setCategories reads for a scheduled feature. */
function scheduleFields(data: Data, prefix: 'start' | 'stop', catTrim: string): ScheduleFields {
  const dateKey = `feature${prefix}${catTrim}`;
  const day = scheduleDate(dateKey, required(data, dateKey, 'ARGUMENTS.DATA'));
  const hour = required(data, `${prefix}hour${catTrim}`, 'ARGUMENTS.DATA');
  const minute = required(data, `${prefix}minute${catTrim}`, 'ARGUMENTS.DATA');
  const dayPartKey = `${prefix}daypart${catTrim}`;
  return { day, hour, minute, dayPart: has(data, dayPartKey) ? cfText(dayPartKey, data.get(dayPartKey)) : '' };
}

/** categoryDAO.setAssignment's date of one half of the schedule, or null when its date field is no date. */
function scheduledAt(fields: ScheduleFields): Date | null {
  return fields.day === null ? null : createDateTime(fields.day, scheduleHour(fields.hour, fields.dayPart), fields.minute);
}

/** categoryManager.setCategories (categoryManager.cfc:831-903): assigns listed non-empty keys, keeps rows whose key is absent. */
export async function setCategoryAssignments(
  tx: TenantTx,
  repository: ContentRepository,
  args: SetCategoryAssignmentsArgs,
): Promise<CategoryAssignRow[]> {
  const data = dataOf(args.data);
  const stored: CategoryAssignRow[] = [];
  for (const { categoryid: categoryId } of args.poolCategories) {
    const catTrim = categoryId.replaceAll('-', '').toLowerCase();
    const key = `categoryassign${catTrim}`;
    if (!has(data, key)) {
      const keeper = args.current.find((row) => row.categoryid === categoryId);
      if (keeper !== undefined) stored.push(...(await keepCategories(tx, repository, args.contentHistId, [keeper], args.write)));
      continue;
    }
    const value = data.get(key);
    const listed = cfListToArray(cfText('categoryid', required(data, 'categoryid', 'ARGUMENTS.DATA'))).includes(categoryId);
    if (!listed || cfText(key, value) === '') continue;
    if (!cfIsNumeric(value)) {
      throw new Error('The ISFEATURE argument passed to the setAssignment function is not of type numeric.');
    }
    let isFeature = cfToNumber(value);
    let featureStart: Date | null = null;
    let featureStop: Date | null = null;
    if (isFeature === 2) {
      const start = scheduleFields(data, 'start', catTrim);
      const stop = scheduleFields(data, 'stop', catTrim);
      featureStart = scheduledAt(start);
      if (featureStart === null) isFeature = 1;
      else featureStop = scheduledAt(stop);
    }
    stored.push(
      await repository.categories.setAssignment(
        tx,
        { categoryId, contentId: args.contentId, contentHistId: args.contentHistId, isFeature, orderNo: 0, siteId: args.siteId, featureStart, featureStop },
        args.write,
      ),
    );
  }
  return stored;
}

/** categoryDAO.keepCategories: copies `keepers` onto `contentHistId`; feature dates are kept only for `isFeature = 2`. */
export function keepCategories(
  tx: TenantTx,
  repository: ContentRepository,
  contentHistId: string,
  keepers: readonly CategoryAssignmentInput[],
  write?: WriteContext,
): Promise<CategoryAssignRow[]> {
  return repository.categories.keepCategories(
    tx,
    contentHistId,
    keepers.map((row) => {
      const scheduled = row.isfeature === 2;
      return {
        categoryid: row.categoryid,
        contentid: row.contentid,
        siteid: row.siteid,
        orderno: row.orderno,
        isfeature: row.isfeature,
        featurestart: scheduled ? (row.featurestart ?? null) : null,
        featurestop: scheduled ? (row.featurestop ?? null) : null,
      };
    }),
    write,
  );
}
