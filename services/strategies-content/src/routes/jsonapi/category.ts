/**
 * JSON API `category` and `contentCategoryAssign` entity handlers (jsonApiUtility.cfc over categoryBean.cfc and
 * contentCategoryAssignBean.cfc).
 */
import {
  adminUrl,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  LegacyApiError,
} from '@opt2/platform/legacy-compat';
import { withTenant } from '@opt2/platform/tenancy';
import {
  deleteCategory,
  listPoolCategories,
  newCategoryBean,
  readCategory,
  saveCategory,
  type CategoryBean,
  type CategoryOptions,
} from '../../domain/categories.js';
import type { Actor } from '../../domain/context.js';
import { feedPoolSites, readAcrossContentPool, type PoolSite } from '../../domain/pools.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
import {
  paramUrl,
  serializeCollection,
  serializeContentEntity,
  serializeEntityList,
  urlParam,
  type ApiEntityView,
} from '../../legacy/jsonapi-serializers.js';
import type { ContentRepository } from '../../repo/repository.js';
// Type-only: ../index.ts imports ../jsonapi.ts, which imports this folder.
import type { ContentRouteContext } from '../index.js';
import {
  authorizationDenied,
  beanFeedQuery,
  entityAccessAllowed,
  entityActionAllowed,
  findPropertiesFor,
  jsonApiResultOf,
  permissionsOf,
  type BeanFeedOptions,
  type BeanFeedResult,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiResult,
} from './types.js';

type Struct = Record<string, unknown>;
type CategoryRow = Awaited<ReturnType<ContentRepository['categories']['categoriesBySite']>>[number];
type AssignmentRow = Awaited<ReturnType<ContentRepository['content']['categoryAssignments']>>[number];

const CATEGORY = CONTENT_ENTITIES.category;
const ASSIGNMENT = CONTENT_ENTITIES.contentCategoryAssign;

/** categoryBean getPrimaryKey() as getLinks and translatePropKey read it (`contentCategoryAssign?categoryID=`). */
const CATEGORY_BEAN_PK = 'categoryID';

/** tcontentcategories columns, which `select *` of the category feed returns. */
const CATEGORY_COLUMNS = [
  'categoryid', 'siteid', 'parentid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'notes', 'isinterestgroup',
  'isactive', 'isopen', 'sortby', 'sortdirection', 'restrictgroups', 'path', 'remoteid', 'remotesourceurl', 'remotepubdate',
  'urltitle', 'filename', 'isfeatureable',
] as const satisfies readonly (keyof CategoryRow)[];

/** tcontentcategoryassign columns. */
const ASSIGNMENT_COLUMNS = [
  'contenthistid', 'categoryid', 'contentid', 'isfeature', 'orderno', 'siteid', 'featurestart', 'featurestop',
] as const satisfies readonly (keyof AssignmentRow)[];

// A query param filters only when the bean holds a value under its name and hasProperty accepts it (findQuery,
// jsonApiUtility.cfc:2864-2892); `notes`, a value without a property, is rejected by rejectNotesFilter.
const CATEGORY_FEED: BeanFeedOptions = {
  primaryKey: CATEGORY.primaryKey,
  propertyNames: [
    'categoryid', 'siteid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'isinterestgroup', 'parentid', 'isactive',
    'isopen', 'sortby', 'sortdirection', 'restrictgroups', 'path', 'remoteid', 'remotesourceurl', 'remotepubdate',
    'urltitle', 'filename', 'isfeatureable', 'isnew', 'errors', 'frommuracache', 'instanceid',
  ],
  // categoryFeedBean.cfc:84-85.
  defaultSort: { sortBy: 'name', sortDirection: 'asc' },
  hints: CATEGORY.hints,
  relations: [...CATEGORY.hasMany, ...CATEGORY.hasOne],
  columns: CATEGORY_COLUMNS,
  table: 'tcontentcategories',
};

// Joined columns (categoryName, parentName, parentid, filename, path) are no tcontentcategoryassign columns, so a
// filter or sort on them fails as legacy's ambiguous or unknown column does.
const ASSIGNMENT_FEED: BeanFeedOptions = {
  primaryKey: ASSIGNMENT.primaryKey,
  propertyNames: [
    'siteid', 'categoryid', 'parentid', 'contenthistid', 'contentid', 'isfeature', 'featurestart', 'featuresop',
    'categoryname', 'parentname', 'filename', 'path', 'saveerrors', 'errors', 'isnew', 'frommuracache', 'instanceid',
  ],
  hints: { ...ASSIGNMENT.hints, featurestop: 'date', orderno: 'integer' },
  relations: [...ASSIGNMENT.hasMany, ...ASSIGNMENT.hasOne],
  columns: ASSIGNMENT_COLUMNS,
  table: 'tcontentcategoryassign',
};

/** contentCategoryAssignBean instance values after init (beanORM defaults; relations by fkcolumn). */
const ASSIGNMENT_DEFAULTS: Readonly<Struct> = Object.freeze({
  contenthistid: '',
  contentid: '',
  categoryid: '',
  parentid: '',
  siteid: '',
  isfeature: 0,
  featurestart: '',
  featuresop: '',
  categoryname: '',
  parentname: '',
  filename: '',
  path: '',
  saveerrors: false,
});

/** A simple value as CFML renders it in string context; '' for null or undefined. */
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

/** CFML struct read ignoring case. */
function getNoCase(record: Readonly<Struct>, name: string): unknown {
  const key = keyOf(record, name);
  return key === undefined ? undefined : record[key];
}

/** CFML struct write: replaces an existing key ignoring case, else adds it. */
function setNoCase(record: Struct, name: string, value: unknown): void {
  Object.defineProperty(record, keyOf(record, name) ?? name, { value, writable: true, enumerable: true, configurable: true });
}

/** SQL Server's id and site equality: case-insensitive, trailing spaces ignored. */
function sqlKey(value: unknown): string {
  return cfText(value).replace(/ +$/u, '').toLowerCase();
}

/** The acting user with the call's verified tenant and site, which pool resolution reads (anonymous actors carry neither). */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** The `expand` argument the finders receive. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** A truthy CFML boolean, as `isBoolean(x) && x` reads it. */
function isTrue(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** The request values as the API's event holds them: the merged params, with the API site as siteid (MuraScope init wins). */
function eventValues(call: JsonApiCall): Struct {
  const event: Struct = call.params.toRecord();
  setNoCase(event, 'siteid', call.siteId);
  return event;
}

/** The sites a feed reads (`contentpoolid`, beanFeed getContentPoolID): registry-granted pool sites, else the own site. */
async function feedSites(ctx: ContentRouteContext, call: JsonApiCall): Promise<PoolSite[]> {
  const requested = cfText(urlParam(call.apiContext, 'contentpoolid'));
  const sites = requested === '' ? [] : await feedPoolSites(ctx.domain.db, call.tenantId, requested);
  return sites.length > 0 ? sites : [{ siteId: call.siteId, tenantId: call.tenantId }];
}

/** The countOnly result, or the page of iteratorToArray items packageIteratorArray returns, as `data`. */
async function feedData<R extends Readonly<Struct>>(
  call: JsonApiCall,
  entityName: string,
  result: BeanFeedResult<R>,
  views: (row: R) => ApiEntityView,
  reorder?: (items: Struct[]) => Struct[],
): Promise<unknown> {
  if ('count' in result) return { count: result.count };
  const items = await serializeEntityList(result.items.map(views), call.apiContext, { entityName, expand: expandOf(call) });
  const opts = result.baseUrl === undefined ? {} : { baseUrl: result.baseUrl };
  return serializeCollection(reorder === undefined ? items : reorder(items), result.page, call.apiContext, opts);
}

/** The row a `fields` SELECT returns (beanFeed.cfc:884-886): listed columns only; a name that is no column fails. */
function selectedRow(row: Readonly<Struct>, call: JsonApiCall, columns: readonly string[]): Readonly<Struct> {
  const fields = cfListToArray(cfText(urlParam(call.apiContext, 'fields'))).map((field) =>
    (field.trim().split('.').at(-1) ?? '').toLowerCase(),
  );
  if (fields.length === 0 || fields.includes('*')) return row;
  const selected: Struct = {};
  for (const field of fields.filter((name) => name !== '')) {
    if (!columns.includes(field)) throw new LegacyApiError('server_error');
    selected[field] = row[field];
  }
  return selected;
}

/** findMany's `ids` as legacy lists them. */
function idsOf(call: JsonApiCall): string[] {
  return call.ids ?? cfListToArray(call.params.string('ids'));
}

/** Whether findMany keeps the feed order: a non-empty URL `sort` (jsonApiUtility.cfc:2694). */
function sortRequested(call: JsonApiCall): boolean {
  return cfText(urlParam(call.apiContext, 'sort')) !== '';
}

// ---- category ----

/** The filename rules category operations take from the request's site; the changelog reads the request id itself. */
function categoryOptions(call: JsonApiCall): CategoryOptions {
  const { urlTitleDelim, allowUnicodeInFilenames } = call.site.urls;
  return { filenameRules: { urlTitleDelim, allowUnicodeInFilenames } };
}

/** Whether `bean` was read from a stored row. */
function isStored(bean: CategoryBean): boolean {
  return cfText(bean.isnew) === '0';
}

/** A category bean's values; a bean no row filled keeps the site `$.getBean` gave it, the request's. */
function beanValues(bean: CategoryBean, call: JsonApiCall): Struct {
  return isStored(bean) ? { ...bean } : { ...bean, siteid: bean.siteid === '' ? call.siteId : bean.siteid };
}

/** The category bean an iterator builds from a feed row (`set(row)` over the init values, isNew 0), NULL as ''. */
function rowValues(row: Readonly<Struct>, ctx: ContentRouteContext): Struct {
  const values: Struct = { ...newCategoryBean(ctx.domain.clock) };
  for (const [column, value] of Object.entries(row)) values[column] = value ?? '';
  values['isnew'] = 0;
  return values;
}

/** The view of a selected category feed row. */
function categoryRowView(row: Readonly<Struct>, ctx: ContentRouteContext, call: JsonApiCall): ApiEntityView {
  return categoryView(rowValues(selectedRow(row, call, CATEGORY_COLUMNS), ctx), call);
}

/** A category bean as the serializers read it, with categoryBean.getEditUrl (categoryBean.cfc:254-258). */
function categoryView(values: Readonly<Struct>, call: JsonApiCall): ApiEntityView {
  const value = (name: string): string => cfText(getNoCase(values, name));
  return {
    entityName: CATEGORY.name,
    configName: CATEGORY.name,
    primaryKey: CATEGORY_BEAN_PK,
    allValues: values,
    hasMany: CATEGORY.hasMany,
    hasOne: CATEGORY.hasOne,
    editUrl: adminUrl({
      circuit: 'cCategory',
      action: 'edit',
      params: [
        ['categoryID', value('categoryid')],
        ['parentID', value('parentid')],
        ['siteid', value('siteid')],
        ['compactDisplay', 'false'],
      ],
      context: call.site.urls.context,
    }),
  };
}

/** The category feed's rows (beanFeed `siteID IN (…)`), each site's read in that site's tenant. */
function categoryFeedRows(ctx: ContentRouteContext, sites: readonly PoolSite[]): Promise<Struct[]> {
  return readAcrossContentPool(ctx.domain.db, sites, async (tx, site) =>
    (await ctx.domain.repository.categories.categoriesBySite(tx, { siteId: site.siteId })).map(
      (row): Struct => Object.fromEntries(CATEGORY_COLUMNS.map((column) => [column, row[column]])),
    ),
  );
}

/** getFilteredValues of one category bean (jsonApiUtility.cfc:2076-2238). */
function serializeCategory(
  values: Readonly<Struct>,
  call: JsonApiCall,
  opts: { expanded: number | boolean; editableCheck: boolean },
): Promise<Struct> {
  return serializeContentEntity(categoryView(values, call), call.apiContext, undefined, {
    ...opts,
    expandLinks: expandOf(call),
    pk: CATEGORY_BEAN_PK,
  });
}

// categoryBean holds a `notes` value but declares the property `note`, so findQuery rejects a `notes` filter as a value
// without a property (jsonApiUtility.cfc:2886-2890); BeanFeedOptions can only ignore a name, so the check runs here.
/** Throws findQuery's invalidParameters for a `notes` query param. */
function rejectNotesFilter(call: JsonApiCall): void {
  const named = call.query.params.entries().some(([key]) => cfEq(cfListToArray(key, '[')[0] ?? '', 'notes'));
  if (named && cfEq(call.method, 'findQuery')) throw new LegacyApiError('invalidParameters');
}

/** findAll and findQuery (jsonApiUtility.cfc:2542-2625, 2711-2918) over the category feed. */
async function findCategories(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  if (!entityAccessAllowed(call.actor, CATEGORY)) return authorizationDenied();
  rejectNotesFilter(call);
  const rows = await categoryFeedRows(ctx, await feedSites(ctx, call));
  const result = beanFeedQuery(rows, call, CATEGORY_FEED);
  return jsonApiResultOf(await feedData(call, CATEGORY.name, result, (row) => categoryRowView(row, ctx, call)), CATEGORY.name);
}

/** The `category` entity: reads are public, writes need the Categories module (`m:010`). */
export const categoryHandler: EntityHandler = Object.freeze({
  entity: CATEGORY.name,
  config: CATEGORY,

  /** findOne (2292-2384): the category with the id over the pool and own tenants, else a new bean. */
  async findOne(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CATEGORY)) return authorizationDenied();
    const bean = await readCategory(ctx.domain, readerOf(call), call.id ?? '', categoryOptions(call));
    const data = await serializeCategory(beanValues(bean, call), call, { expanded: 0, editableCheck: true });
    return jsonApiResultOf(data, CATEGORY.name);
  },

  /** findMany (2627-2709): the feed's categories with the ids, in `ids` order unless a URL `sort` is given. */
  async findMany(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CATEGORY)) return authorizationDenied();
    const ids = idsOf(call);
    const wanted = new Set(ids.map(sqlKey));
    const rows = (await categoryFeedRows(ctx, await feedSites(ctx, call))).filter((row) => wanted.has(sqlKey(row['categoryid'])));
    const result = beanFeedQuery(rows, call, CATEGORY_FEED);
    const inIdOrder = (items: Struct[]): Struct[] =>
      ids.flatMap((id): Struct[] => {
        const item = items.find((candidate) => cfEq(cfText(candidate['id']), id));
        return item === undefined ? [] : [item];
      });
    const reorder = sortRequested(call) ? undefined : inIdOrder;
    const data = await feedData(call, CATEGORY.name, result, (row) => categoryRowView(row, ctx, call), reorder);
    return jsonApiResultOf(data, CATEGORY.name);
  },

  findAll: findCategories,
  findQuery: findCategories,

  /** findNew (2386-2414): loadBy a fresh id, which no row holds, so a new bean of the request's site. */
  async findNew(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    if (!entityAccessAllowed(call.actor, CATEGORY)) return authorizationDenied();
    const values = { ...newCategoryBean(ctx.domain.clock), siteid: call.siteId };
    return jsonApiResultOf(await serializeCategory(values, call, { expanded: true, editableCheck: true }), CATEGORY.name);
  },

  /** findProperties (1548-1618). */
  findProperties(_ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    return Promise.resolve(jsonApiResultOf(findPropertiesFor(CATEGORY, call), CATEGORY.name));
  },

  /** findPermissions (2240-2266): the bean is loaded for a 35-character or UUID id; read is public. */
  async findPermissions(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    const id = call.id ?? '';
    const loads = isCfUuid(id) || id.length === 35;
    const bean = loads ? await readCategory(ctx.domain, readerOf(call), id, categoryOptions(call)) : undefined;
    const siteId = bean === undefined ? call.siteId : cfText(beanValues(bean, call)['siteid']);
    const data = permissionsOf({
      hasSiteId: siteId !== '',
      readAllowed: entityAccessAllowed(call.actor, CATEGORY),
      actionAllowed: entityActionAllowed(call.actor, CATEGORY),
    });
    return jsonApiResultOf(data, CATEGORY.name);
  },

  /** save (1903-2074): CSRF, AllowAction, categoryManager.save; the reloaded or erroneous bean plus `saveErrors` and `errors`. */
  async save(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    const data = eventValues(call);
    const requestedId = cfText(getNoCase(data, 'categoryid'));
    let id = call.id ?? 'new';
    if (requestedId !== '' && isLegacyFindOneId(requestedId)) id = requestedId;
    if (cfEq(id, 'new')) {
      id = cfUuid();
      setNoCase(data, 'id', id);
      setNoCase(data, 'categoryid', id);
    }
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };

    const actor = readerOf(call);
    const opts = categoryOptions(call);
    const loaded = await readCategory(ctx.domain, actor, id, opts);
    if (!entityActionAllowed(call.actor, CATEGORY)) return authorizationDenied();
    // bean.set skips an empty primary key, so the saved values keep the loaded bean's id.
    if (cfText(getNoCase(data, 'categoryid')) === '') setNoCase(data, 'categoryid', isStored(loaded) ? loaded.categoryid : '');

    const saved = await saveCategory(ctx.domain, actor, data, opts);
    // With errors legacy reloads the bean and sets the request values back on it, which is the bean the save returned.
    const shown = Object.keys(saved.errors).length === 0 ? await readCategory(ctx.domain, actor, saved.categoryid, opts) : saved;
    const result = await serializeCategory(beanValues(shown, call), call, { expanded: true, editableCheck: false });
    // categoryBean has no saveErrors value, so getValue answers ''.
    setNoCase(result, 'saveErrors', '');
    setNoCase(result, 'errors', { ...saved.errors });
    return jsonApiResultOf(result, CATEGORY.name);
  },

  /** delete (3259-3335): a stored category, after AllowAction and CSRF, goes through categoryManager.delete; answers ''. */
  async delete(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    const requestedId = call.params.string('categoryid');
    const fallbackId = call.params.has('id') ? call.params.string('id') : (call.id ?? '');
    const id = requestedId !== '' && isCfUuid(requestedId) ? requestedId : fallbackId;
    const actor = readerOf(call);
    const opts = categoryOptions(call);
    const bean = await readCategory(ctx.domain, actor, id, opts);
    if (!isStored(bean)) return jsonApiResultOf('');
    if (!entityActionAllowed(call.actor, CATEGORY)) return authorizationDenied();
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    await deleteCategory(ctx.domain, actor, bean.categoryid, opts);
    return jsonApiResultOf('');
  },
});

// ---- contentCategoryAssign ----

/** Query keys after which a filter no longer bounds every selected row. */
const UNBOUNDING_KEYS: ReadonlySet<string> = new Set(['or', 'opengrouping', 'oropengrouping', 'andopengrouping', 'closegrouping']);

/** The ACF error of reading a struct key that is not there; service-kit answers it with the legacy 500. */
function undefinedElement(element: string, scope: string): Error {
  return new Error(`Element ${element} is undefined in ${scope}.`);
}

// beanORM save and delete announce their plugin event with objectid=get(get('primaryKey')) (beanORM.cfc:393, 705); with
// no primary key that is get(''), every value as a struct, and the plugin manager's len() of it fails before any SQL.
/** The ACF error contentCategoryAssign save and delete raise; service-kit answers it with the legacy 500. */
function complexObjectId(): Error {
  return new Error('Complex object types cannot be converted to simple values.');
}

/** The categories assignments join by id (`INNER JOIN tcontentcategories`): the category pool's first, then the own site's. */
async function categoryIndex(ctx: ContentRouteContext, call: JsonApiCall): Promise<Map<string, CategoryRow>> {
  const pool = await listPoolCategories(ctx.domain, readerOf(call));
  const own = await withTenant(ctx.domain.db, call.tenantId, (tx) =>
    ctx.domain.repository.categories.categoriesBySite(tx, { siteId: call.siteId }),
  );
  const index = new Map<string, CategoryRow>();
  for (const row of [...pool, ...own]) {
    if (!index.has(sqlKey(row.categoryid))) index.set(sqlKey(row.categoryid), row);
  }
  return index;
}

/** getLoadSQLColumnsAndTables' joins (contentCategoryAssignBean.cfc:93-100): rows whose category exists, with its columns. */
function joinCategories(rows: readonly Struct[], index: ReadonlyMap<string, CategoryRow>): Struct[] {
  return rows.flatMap((row) => {
    const category = index.get(sqlKey(row['categoryid']));
    if (category === undefined) return [];
    const parent = category.parentid === null ? undefined : index.get(sqlKey(category.parentid));
    return [
      {
        ...row,
        categoryname: category.name,
        parentname: parent?.name ?? null,
        parentid: category.parentid,
        filename: category.filename,
        path: category.path,
      },
    ];
  });
}

/** The contenthistid a findQuery filters by plain equality with no `or` or grouping, which then bounds every row it selects. */
function boundHistId(call: JsonApiCall): string | undefined {
  if (!cfEq(call.method, 'findQuery')) return undefined;
  if (call.query.params.entries().some(([key]) => UNBOUNDING_KEYS.has(key.toLowerCase()))) return undefined;
  const value = cfText(urlParam(call.apiContext, 'contenthistid'));
  return value === '' || value.includes('^') || value.includes('*') ? undefined : value;
}

/** Whether the feed SELECT keeps its joins: neither countOnly (`count(*) from` the table) nor a `fields` list (beanFeed.cfc:883-931). */
function joinsCategories(call: JsonApiCall): boolean {
  return !isTrue(urlParam(call.apiContext, 'countOnly')) && cfText(urlParam(call.apiContext, 'fields')) === '';
}

/** The assignment rows of `sites` (`siteID IN (…)`), each site's read in that site's tenant; a bounded findQuery reads one version's. */
async function assignmentFeedRows(
  ctx: ContentRouteContext,
  call: JsonApiCall,
  sites: readonly PoolSite[],
  join: boolean,
): Promise<Struct[]> {
  const histId = boundHistId(call);
  const content = ctx.domain.repository.content;
  const rows = await readAcrossContentPool(ctx.domain.db, sites, async (tx, site): Promise<Struct[]> => {
    const read =
      histId === undefined
        ? await content.siteCategoryAssignments(tx, { siteId: site.siteId })
        : (await content.categoryAssignments(tx, { contentHistId: histId })).filter((row) => sqlKey(row.siteid) === sqlKey(site.siteId));
    return read.map((row): Struct => ({ ...row }));
  });
  return join && rows.length > 0 ? joinCategories(rows, await categoryIndex(ctx, call)) : rows;
}

/** The row a key-less loadBy reads (beanORM.cfc:766-845): the request site's first joined assignment, in clustered-key order. */
async function firstAssignment(ctx: ContentRouteContext, call: JsonApiCall): Promise<Struct | undefined> {
  const [first] = await assignmentFeedRows(ctx, call, [{ siteId: call.siteId, tenantId: call.tenantId }], true);
  return first;
}

/** An assignment bean's values: a row's over the init defaults (NULL as '', isNew 0), else loadBy's own arguments set on it. */
function assignmentValues(row: Readonly<Struct> | undefined, call: JsonApiCall): Struct {
  if (row === undefined) return { ...ASSIGNMENT_DEFAULTS, siteid: call.siteId, returnformat: 'self', cachedwithin: 0, isnew: 1 };
  const values: Struct = { ...ASSIGNMENT_DEFAULTS };
  for (const [key, value] of Object.entries(row)) values[key] = value ?? '';
  values['isnew'] = 0;
  return values;
}

/** An assignment bean as the serializers read it; it has no primary key, so no `id` and no permissions link. */
function assignmentView(values: Readonly<Struct>): ApiEntityView {
  return {
    entityName: ASSIGNMENT.name,
    configName: ASSIGNMENT.name,
    primaryKey: ASSIGNMENT.primaryKey,
    allValues: values,
    hasMany: ASSIGNMENT.hasMany,
    hasOne: ASSIGNMENT.hasOne,
  };
}

/** The view of a selected assignment feed row. */
function assignmentRowView(row: Readonly<Struct>, call: JsonApiCall): ApiEntityView {
  return assignmentView(assignmentValues(selectedRow(row, call, ASSIGNMENT_COLUMNS), call));
}

/** getFilteredValues of one assignment bean. */
function serializeAssignment(
  values: Readonly<Struct>,
  call: JsonApiCall,
  opts: { expanded: number | boolean; editableCheck: boolean },
): Promise<Struct> {
  return serializeContentEntity(assignmentView(values), call.apiContext, undefined, {
    ...opts,
    expandLinks: expandOf(call),
    pk: ASSIGNMENT.primaryKey,
  });
}

/** findAll and findQuery over the assignment feed. */
async function findAssignments(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
  const rows = await assignmentFeedRows(ctx, call, await feedSites(ctx, call), joinsCategories(call));
  const result = beanFeedQuery(rows, call, ASSIGNMENT_FEED);
  return jsonApiResultOf(await feedData(call, ASSIGNMENT.name, result, (row) => assignmentRowView(row, call)), ASSIGNMENT.name);
}

/** The `contentCategoryAssign` entity: public reads, writes need `m:000`; having no primary key, save and delete never write. */
export const contentCategoryAssignHandler: EntityHandler = Object.freeze({
  entity: ASSIGNMENT.name,
  config: ASSIGNMENT,

  /** findOne: the id is no column, so the site's first assignment or the unloaded bean. */
  async findOne(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    const values = assignmentValues(await firstAssignment(ctx, call), call);
    return jsonApiResultOf(await serializeAssignment(values, call, { expanded: 0, editableCheck: true }), ASSIGNMENT.name);
  },

  /** findMany: the `ids` filter names no column, so every feed row; ordering them by `id` fails unless a URL `sort` is given. */
  async findMany(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    const rows = await assignmentFeedRows(ctx, call, await feedSites(ctx, call), joinsCategories(call));
    const result = beanFeedQuery(rows, call, ASSIGNMENT_FEED);
    const ids = idsOf(call);
    const inIdOrder = (items: Struct[]): Struct[] => {
      if (ids.length > 0 && items.length > 0) throw undefinedElement('ID', 'I2');
      return [];
    };
    const reorder = sortRequested(call) ? undefined : inIdOrder;
    const data = await feedData(call, ASSIGNMENT.name, result, (row) => assignmentRowView(row, call), reorder);
    return jsonApiResultOf(data, ASSIGNMENT.name);
  },

  findAll: findAssignments,
  findQuery: findAssignments,

  /** findNew: loadBy a fresh id, which names no column either, so the same bean as findOne. */
  async findNew(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    const values = assignmentValues(await firstAssignment(ctx, call), call);
    return jsonApiResultOf(await serializeAssignment(values, call, { expanded: true, editableCheck: true }), ASSIGNMENT.name);
  },

  /** findProperties (1548-1618). */
  findProperties(_ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    return Promise.resolve(jsonApiResultOf(findPropertiesFor(ASSIGNMENT, call), ASSIGNMENT.name));
  },

  /** findPermissions: whether or not a row loads, the bean holds the request's site; read is public. */
  findPermissions(_ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    const data = permissionsOf({
      hasSiteId: call.siteId !== '',
      readAllowed: entityAccessAllowed(call.actor, ASSIGNMENT),
      actionAllowed: entityActionAllowed(call.actor, ASSIGNMENT),
    });
    return Promise.resolve(jsonApiResultOf(data, ASSIGNMENT.name));
  },

  /** save: CSRF, then AllowAction; the save itself fails at its plugin event, so nothing is written. */
  async save(_ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    if (!entityActionAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    throw complexObjectId();
  },

  /** delete: '' when the site has no assignment; otherwise, after AllowAction and CSRF, the delete fails at its plugin event. */
  async delete(ctx: ContentRouteContext, call: JsonApiCall): Promise<JsonApiResult> {
    if ((await firstAssignment(ctx, call)) === undefined) return jsonApiResultOf('');
    if (!entityActionAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    throw complexObjectId();
  },
});
