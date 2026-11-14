/** JSON API `changeset` and `changesetCategoryAssignment` entities (jsonApiUtility.cfc:93, 100): generic finders, save and delete. */
import {
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  javaTrim,
  LegacyApiError,
  LegacyServiceUnavailableError,
} from '@opt2/platform/legacy-compat';
import {
  deleteChangeset,
  deleteChangesetCategoryAssignment,
  findChangesetCategoryAssignment,
  listChangesetCategoryAssignments,
  listChangesetRows,
  loadChangeset,
  loadedBean,
  newChangesetBean,
  saveChangesetCategoryAssignment,
  saveChangesetEntity,
  setChangesetValues,
  type ChangesetBean,
  type ChangesetCategoryAssignmentColumns,
  type ChangesetCategoryAssignmentValues,
  type ChangesetColumns,
} from '../../domain/changesets.js';
import type { Actor } from '../../domain/context.js';
import { CONTENT_ENTITIES, type RelationProp } from '../../legacy/jsonapi-entities.js';
import {
  paramUrl,
  serializeCollection,
  serializeContentEntity,
  serializeEntityList,
  urlParam,
  type ApiEntityView,
  type ExpansionOptions,
  type ExpansionResolver,
} from '../../legacy/jsonapi-serializers.js';
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
  type JsonApiHandlerFn,
  type JsonApiResult,
} from './types.js';

type Struct = Record<string, unknown>;
type Ctx = Parameters<JsonApiHandlerFn>[0];

const CHANGESET = CONTENT_ENTITIES.changeset;
const ASSIGNMENT = CONTENT_ENTITIES.changesetCategoryAssignment;
/** changesetBean.getPrimaryKey(), which save, getLinks and translatePropKey read. */
const CHANGESET_PK = 'changesetID';
const ASSIGNMENT_PK = ASSIGNMENT.primaryKey;
const CHANGESET_TABLE = 'tchangesets';
const ASSIGNMENT_TABLE = 'tchangesetcategoryassign';

/** tchangesets columns. */
const CHANGESET_COLUMNS = [
  'changesetid', 'siteid', 'name', 'description', 'created', 'publishdate', 'published', 'lastupdate', 'lastupdateby',
  'lastupdatebyid', 'remoteid', 'remotepubdate', 'remotesourceurl', 'closedate',
] as const satisfies readonly (keyof ChangesetColumns)[];

/** tchangesetcategoryassign columns. */
const ASSIGNMENT_COLUMNS = ['assignmentid', 'changesetid', 'siteid', 'categoryid'] as const satisfies readonly (
  keyof ChangesetCategoryAssignmentColumns
)[];
const ASSIGNMENT_SAVED_FIELDS = ['changesetid', 'categoryid'] as const;

// findQuery filters by a name only when the bean holds a value under it and hasProperty accepts it: changesetBean's
// declared properties and the base bean's (changesetBean.cfc:6-22, bean.cfc:79-82). The relations hold no value, so
// `?categoryassignments=` is ignored, as the oracle ignores it.
const CHANGESET_FEED: BeanFeedOptions = Object.freeze({
  primaryKey: CHANGESET_PK,
  propertyNames: [
    'changesetid', 'siteid', 'name', 'created', 'description', 'publishdate', 'published', 'remoteid', 'remotesourceurl',
    'remotepubdate', 'lastupdate', 'lastupdateby', 'closedate', 'categoryid', 'tags', 'isnew', 'errors', 'frommuracache',
    'instanceid',
  ],
  // changesetBean.getFeed's setOrderBy('name asc'), which a request sortBy never replaces (oracle: ?sortBy=bogus is 200).
  defaultOrderBy: 'name asc',
  hints: CHANGESET.hints,
  relations: [...CHANGESET.hasMany, ...CHANGESET.hasOne],
  columns: CHANGESET_COLUMNS,
  table: CHANGESET_TABLE,
});

// beanORM holds a value for each column (relations by fkcolumn) and the base values; the relation names hold none, so
// `?changeset=` is ignored (oracle).
const ASSIGNMENT_FEED: BeanFeedOptions = Object.freeze({
  primaryKey: ASSIGNMENT_PK,
  propertyNames: [...ASSIGNMENT_COLUMNS, 'errors', 'isNew', 'fromMuraCache', 'instanceID', 'saveErrors'],
  hints: ASSIGNMENT.hints,
  relations: [...ASSIGNMENT.hasMany, ...ASSIGNMENT.hasOne],
  columns: ASSIGNMENT_COLUMNS,
  table: ASSIGNMENT_TABLE,
});

/** A changesetCategoryAssignment bean's column values after init. */
const ASSIGNMENT_INIT: Readonly<Struct> = Object.freeze({ assignmentid: '', changesetid: '', siteid: '', categoryid: '' });

// beanORM.loadBy sets its own arguments on a bean no row matches (beanORM.cfc:913-915), so such a bean also reports
// loadBy's returnFormat and cachedWithin defaults (oracle: "returnformat":"self","cachedwithin":"0").
const LOAD_BY_DEFAULTS: Readonly<Struct> = Object.freeze({ returnformat: 'self', cachedwithin: '0' });

// Base bean values set() stores as given (bean.cfc setValue without a setter); setErrors ignores a simple value.
const STORED_BASE_VALUES = ['isnew', 'frommuracache', 'instanceid', 'addobjects', 'removeobjects'] as const;

/** A varchar property of changesetBean; `required="true"` stays attribute text. */
function varchar50(name: string, required: boolean): Struct {
  const requiredText = required ? 'true' : false;
  return { fieldtype: '', length: '50', required: requiredText, html: 'false', nullable: !required, name, datatype: 'varchar', default: '' };
}

/** A date property of changesetBean. */
function datetime(name: string): Struct {
  return { fieldtype: '', required: false, html: 'false', nullable: true, name, datatype: 'datetime', default: '' };
}

/** A one-to-many relation of changesetBean, keyed by the bean's primary key. */
function oneToMany(name: string, relatesto: string): Struct {
  return {
    fieldtype: 'one-to-many', loadkey: 'primaryKey', length: '50', required: false, cascade: 'none', nullable: true, html: 'false',
    fkcolumn: 'primaryKey', name, datatype: 'varchar', relatesto, default: 'null',
  };
}

/** A many-to-one relation of changesetCategoryAssignmentBean. */
function manyToOne(name: string, fkcolumn: string, length: string, datatype: string): Struct {
  return {
    fieldtype: 'many-to-one', loadkey: fkcolumn, length, required: false, cascade: 'none', nullable: true, html: 'false', fkcolumn,
    name, datatype, relatesto: name, default: '',
  };
}

/** Property formats keyed by name, in getProperties order. */
function formatsOf(formats: readonly Struct[]): ReadonlyMap<string, Readonly<Struct>> {
  return new Map(formats.map((format): [string, Readonly<Struct>] => [String(format['name']), Object.freeze(format)]));
}

// applyPropertyFormat of each persistent or related property, in getProperties order, exactly as the oracle answers
// findProperties (jsonApiUtility.cfc:1517-1618).
const CHANGESET_PROPERTIES = formatsOf([
  { fieldtype: 'id', length: '35', required: 'true', nullable: false, html: 'false', name: 'changesetid', datatype: 'char', default: '' },
  datetime('publishdate'),
  oneToMany('categoryassignments', ASSIGNMENT.name),
  varchar50('categoryid', false),
  varchar50('siteid', true),
  oneToMany('contentassignments', 'content'),
  varchar50('name', true),
  datetime('created'),
  varchar50('remoteid', false),
  datetime('lastupdate'),
  { fieldtype: '', required: 'true', html: 'false', nullable: false, name: 'published', datatype: 'int', default: '0' },
  varchar50('remotesourceurl', false),
  varchar50('description', false),
  datetime('remotepubdate'),
  varchar50('lastupdateby', false),
  datetime('closedate'),
  varchar50('tags', false),
]);

const ASSIGNMENT_PROPERTIES = formatsOf([
  manyToOne('site', 'siteid', '25', 'varchar'),
  manyToOne('category', 'categoryid', '35', 'char'),
  manyToOne('changeset', 'changesetid', '35', 'char'),
  { fieldtype: 'id', length: '35', required: true, nullable: false, html: 'false', name: 'assignmentid', datatype: 'char', default: '' },
]);

// Non-persistent properties findProperties skips without error (bean.cfc:79-82, beanORM.cfc:79, changesetBean.cfc:21).
const CHANGESET_NON_PERSISTENT: ReadonlySet<string> = new Set(['isnew', 'errors', 'frommuracache', 'instanceid']);
const ASSIGNMENT_NON_PERSISTENT: ReadonlySet<string> = new Set(['isnew', 'errors', 'frommuracache', 'instanceid', 'saveerrors']);

/** Per-call state: the call and the resolver of both entities' relations. */
interface Scope {
  readonly ctx: Ctx;
  readonly call: JsonApiCall;
  readonly resolver: ExpansionResolver;
}

/** A simple value as CFML renders it in string context; '' for null or undefined. */
function text(value: unknown): string {
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

/** SQL Server's id equality: case-insensitive, trailing spaces ignored. */
function sqlKey(value: unknown): string {
  return text(value).replace(/ +$/u, '').toLowerCase();
}

/** A truthy CFML boolean, as `isBoolean(x) && x` reads it. */
function isTrue(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** The acting user with the call's verified tenant and site, which anonymous actors do not carry. */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** The request's `expand` list. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** The request values as the API's event holds them: the merged params, with the API site as siteid. */
function eventValues(call: JsonApiCall): Struct {
  const event: Struct = call.params.toRecord();
  setNoCase(event, 'siteid', call.siteId);
  return event;
}

/** findMany's `ids` as legacy lists them. */
function idsOf(call: JsonApiCall): string[] {
  return call.ids ?? cfListToArray(call.params.string('ids'));
}

/** `items` in the order of `ids`, each id's first match, as findMany arranges them without a URL `sort` (2694). */
function inIdOrder(ids: readonly string[]): (items: Struct[]) => Struct[] {
  return (items) =>
    ids.flatMap((id): Struct[] => {
      const item = items.find((candidate) => cfEq(text(candidate['id']), id));
      return item === undefined ? [] : [item];
    });
}

/** findMany's arrangement: the feed order with a URL `sort`, else the `ids` order. */
function findManyOrder(call: JsonApiCall): ((items: Struct[]) => Struct[]) | undefined {
  return text(urlParam(call.apiContext, 'sort')) !== '' ? undefined : inIdOrder(idsOf(call));
}

/** The columns beanFeed.setFields selects from the URL `fields` (which setFeedProps extended by the primary key); all without any. */
function selectedColumns(call: JsonApiCall, columns: readonly string[]): readonly string[] {
  const named = cfListToArray(text(urlParam(call.apiContext, 'fields'))).map((field) => javaTrim(field).toLowerCase());
  const selected = columns.filter((column) => named.includes(column));
  return selected.length > 0 ? selected : columns;
}

/** bean.getValue of a value set() stored without a setter: trimmed when simple, '' when never set. */
function storedValue(record: Readonly<Struct>, name: string): unknown {
  const value = getNoCase(record, name);
  if (value === undefined || value === null) return '';
  return typeof value === 'object' && !(value instanceof Date) ? value : javaTrim(text(value));
}

/** The base bean's instance values (bean.cfc:94-101). */
function baseValues(): Struct {
  return { errors: {}, frommuracache: false, instanceid: cfUuid(), addobjects: [], removeobjects: [] };
}

/** `url.ishuman` renders the CFML form-protection include into findOne and findNew results (2373-2376, 2416-2419). */
function assertNoHumanCheck(call: JsonApiCall): void {
  if (urlParam(call.apiContext, 'ishuman') !== undefined) {
    throw new LegacyServiceUnavailableError('The ishuman field renders a CFML display object', 'auto', 'cfml-render');
  }
}

// Fail closed: `contentAssignments` expands through the content entity's findQuery, `category` through the category
// entity's findOne and `site` is programs-sites data, none of which these handlers reach; neither entity's links carry
// crumbs, and only content expands related content.
/** The legacy 503 for a relation another entity's finder serves. */
function relationUnavailable(entity: string, name: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(
    `The ${name} relation of a ${entity} is served by another entity's finder`,
    'auto',
    `${entity.toLowerCase()}-expand-${name.toLowerCase()}`,
  );
}

/** The scope of one handler call, whose resolver serves the relations of both entities. */
function scopeOf(ctx: Ctx, call: JsonApiCall): Scope {
  const resolver: ExpansionResolver = {
    hasMany: (prop, params, opts) => expandMany(scope, prop, params, opts),
    hasOne: (prop, id, opts) => expandOne(scope, prop, id, opts),
    crumbs: (view) => Promise.reject(relationUnavailable(view.entityName, 'crumbs')),
    relatedContent: (view) => Promise.reject(relationUnavailable(view.entityName, 'relatedcontent')),
  };
  const scope: Scope = { ctx, call, resolver };
  return scope;
}

/** `{count}`, or packageIteratorArray (287-366) of the selected rows' beans; `arrange` orders the serialized items. */
async function collectionData<R>(
  scope: Scope,
  result: BeanFeedResult<R>,
  view: (row: R) => ApiEntityView,
  entityName: string,
  opts: { expand: string; expanded?: number },
  arrange: (items: Struct[]) => Struct[] = (items) => items,
): Promise<Struct> {
  // getAvailableCount answers the count query's cell, which serializes as text (oracle: {"count":"0"}).
  if ('count' in result) return { count: String(result.count) };
  const ctx = scope.call.apiContext;
  const listOpts = { entityName, expand: opts.expand, expanded: opts.expanded };
  const items = await serializeEntityList(result.items.map(view), ctx, listOpts, scope.resolver);
  return serializeCollection(arrange(items), result.page, ctx, { expanded: opts.expanded, baseUrl: result.baseUrl });
}

// ---- changeset ----

/** An unset bean date as getAllValues holds it. */
function dateValue(value: Date | null): Date | string {
  return value ?? '';
}

/** getAllValues of a changeset bean (changesetBean.cfc init assignments, stored values over them). */
function changesetValues(bean: ChangesetBean): Struct {
  return {
    ...baseValues(),
    changesetid: bean.changesetid,
    siteid: bean.siteid,
    name: bean.name,
    created: dateValue(bean.created),
    description: bean.description,
    publishdate: dateValue(bean.publishdate),
    published: bean.published,
    remoteid: bean.remoteid,
    remotesourceurl: bean.remotesourceurl,
    remotepubdate: dateValue(bean.remotepubdate),
    lastupdate: dateValue(bean.lastupdate),
    lastupdateby: bean.lastupdateby,
    closedate: dateValue(bean.closedate),
    isnew: bean.isnew,
    categoryid: bean.categoryid,
    tags: bean.tags,
    errors: { ...bean.errors },
    lastupdatebyid: bean.lastupdatebyid,
  };
}

/** A changeset bean as the serializers read it; changesetBean has no edit URL. */
function changesetView(values: Readonly<Struct>): ApiEntityView {
  return {
    entityName: CHANGESET.name,
    configName: CHANGESET.name,
    primaryKey: CHANGESET_PK,
    allValues: values,
    hasMany: CHANGESET.hasMany,
    hasOne: CHANGESET.hasOne,
  };
}

/** changesetIterator.packageRecord: a per-iterator new-bean template, then `set(row)` of the selected columns; isNew stays 1. */
function changesetItems(scope: Scope, columns: readonly string[]): (row: ChangesetColumns) => ApiEntityView {
  const template = changesetValues(newChangesetBean(scope.call.actor, scope.ctx.domain.clock));
  return (row) => {
    const stored = changesetValues(loadedBean({ ...row, tenant_id: scope.call.tenantId }));
    const values: Struct = { ...template };
    for (const column of columns) values[column] = stored[column];
    return changesetView(values);
  };
}

/** findOne (2292-2384) of a changeset: the site's change set with the id, else a new bean of the site. */
async function changesetEntity(scope: Scope, id: string, opts: ExpansionOptions): Promise<Struct> {
  const { ctx, call } = scope;
  paramUrl(call.apiContext, 'entityname', CHANGESET.name);
  assertNoHumanCheck(call);
  const bean = await loadChangeset(ctx.domain, readerOf(call), { changesetId: id, siteId: call.siteId });
  return serializeContentEntity(changesetView(changesetValues(bean)), call.apiContext, scope.resolver, {
    expanded: opts.expanded,
    expandLinks: opts.expand,
    pk: CHANGESET_PK,
    editableCheck: true,
  });
}

/** The changeset feed's page (or count) over `rows`. */
async function changesetFeed(
  scope: Scope,
  rows: readonly ChangesetColumns[],
  arrange?: (items: Struct[]) => Struct[],
): Promise<JsonApiResult> {
  const { call } = scope;
  const result = beanFeedQuery(rows, call, CHANGESET_FEED);
  const view = changesetItems(scope, selectedColumns(call, CHANGESET_COLUMNS));
  return jsonApiResultOf(await collectionData(scope, result, view, CHANGESET.name, { expand: expandOf(call) }, arrange), CHANGESET.name);
}

// changesetBean.init holds a `LastUpdateByID` value but declares no such property, so findQuery rejects it as a value
// without a property (jsonApiUtility.cfc:2886-2890; oracle 400); BeanFeedOptions can only ignore a name.
/** Throws findQuery's invalidParameters for a `lastupdatebyid` query param. */
function rejectUndeclaredFilter(call: JsonApiCall): void {
  if (!cfEq(call.method, 'findQuery')) return;
  if (call.query.params.entries().some(([key]) => cfEq(cfListToArray(key, '[')[0] ?? '', 'lastupdatebyid'))) {
    throw new LegacyApiError('invalidParameters');
  }
}

/** findAll and findQuery (2542-2625, 2711-2918) over the site's change sets. */
async function findChangesets(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
  rejectUndeclaredFilter(call);
  return changesetFeed(scopeOf(ctx, call), await listChangesetRows(ctx.domain, readerOf(call), call.siteId));
}

/** The bean after save's error overlay (2054-2061): each request value the reloaded bean holds is set on it again. */
function overlaid(bean: ChangesetBean, event: Readonly<Struct>): Struct {
  const values = changesetValues(setChangesetValues(bean, event));
  for (const name of STORED_BASE_VALUES) {
    if (keyOf(event, name) !== undefined) values[name] = storedValue(event, name);
  }
  return values;
}

/** findProperties (1548-1618) from `formats`; an unknown requested name fails as `props[p]` does (1568). */
async function propertiesResult(
  call: JsonApiCall,
  config: typeof CHANGESET | typeof ASSIGNMENT,
  meta: { formats: ReadonlyMap<string, Readonly<Struct>>; nonPersistent: ReadonlySet<string>; bundleable: boolean | string; table: string },
): Promise<JsonApiResult> {
  const requested = cfListToArray(call.params.string('properties')).map((name) => name.toLowerCase());
  const names = requested.length > 0 ? requested : [...meta.formats.keys()];
  const properties = names.flatMap((name) => {
    if (meta.nonPersistent.has(name)) return [];
    const format = meta.formats.get(name);
    if (format === undefined) throw new LegacyApiError('server_error');
    return [{ ...format }];
  });
  const result = findPropertiesFor(config, call);
  result['properties'] = properties;
  result['bundleable'] = meta.bundleable;
  if (Object.hasOwn(result, 'table')) result['table'] = meta.table;
  return jsonApiResultOf(result, config.name);
}

/** The `changeset` entity: change sets of the request site behind the Change Sets module (`m:014`). */
export const changesetHandler: EntityHandler = Object.freeze({
  entity: CHANGESET.name,
  config: CHANGESET,

  /** findOne (2292-2384). */
  async findOne(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
    const data = await changesetEntity(scopeOf(ctx, call), call.id ?? '', { expand: expandOf(call), expanded: 0 });
    return jsonApiResultOf(data, CHANGESET.name);
  },

  /** findMany (2627-2709): the site's change sets with the ids, in `ids` order unless the URL sorts them. */
  async findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
    const wanted = new Set(idsOf(call).map(sqlKey));
    const rows = (await listChangesetRows(ctx.domain, readerOf(call), call.siteId)).filter((row) => wanted.has(sqlKey(row.changesetid)));
    return changesetFeed(scopeOf(ctx, call), rows, findManyOrder(call));
  },

  findAll: findChangesets,
  findQuery: findChangesets,

  /** findNew (2386-2422): loadBy a fresh id, which no row holds, so a new bean of the request site. */
  async findNew(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
    assertNoHumanCheck(call);
    const bean = newChangesetBean(call.actor, ctx.domain.clock, { siteid: call.siteId });
    const data = await serializeContentEntity(changesetView(changesetValues(bean)), call.apiContext, scopeOf(ctx, call).resolver, {
      expanded: true,
      expandLinks: expandOf(call),
      pk: CHANGESET_PK,
      editableCheck: true,
    });
    return jsonApiResultOf(data, CHANGESET.name);
  },

  /** findProperties (1548-1618): changesetBean's property metadata; no access check, as legacy. */
  findProperties(_ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const meta = { formats: CHANGESET_PROPERTIES, nonPersistent: CHANGESET_NON_PERSISTENT, bundleable: false, table: CHANGESET_TABLE };
    return propertiesResult(call, CHANGESET, meta);
  },

  /** findPermissions (2240-2266): the bean is loaded for a UUID or 35-character id; no access check, as legacy. */
  async findPermissions(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const id = call.id ?? '';
    const loads = isCfUuid(id) || id.length === 35;
    const siteId = loads ? (await loadChangeset(ctx.domain, readerOf(call), { changesetId: id, siteId: call.siteId })).siteid : call.siteId;
    const data = permissionsOf({
      hasSiteId: siteId !== '',
      readAllowed: entityAccessAllowed(call.actor, CHANGESET),
      actionAllowed: entityActionAllowed(call.actor, CHANGESET),
    });
    return jsonApiResultOf(data, CHANGESET.name);
  },

  /** save (1903-2074): CSRF, loadBy and set, AllowAction, changesetManager.save; answers the reload with `saveErrors` and `errors`. */
  async save(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const event = eventValues(call);
    const requestedId = text(getNoCase(event, CHANGESET_PK));
    let id = call.id ?? 'new';
    if (requestedId !== '' && isLegacyFindOneId(requestedId)) id = requestedId;
    if (cfEq(id, 'new')) {
      id = cfUuid();
      setNoCase(event, 'id', id);
      setNoCase(event, CHANGESET_PK, id);
    }
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    if (!entityActionAllowed(call.actor, CHANGESET)) return authorizationDenied();

    // Not cChangesets.save's saveChangeset: the API loads by `id` within the site, which can differ from the event's changesetid.
    const { saved, reloaded } = await saveChangesetEntity(ctx.domain, readerOf(call), { loadId: id, siteId: call.siteId, values: event });
    // changesetBean has no saveErrors property, so getValue answers the request value set() stored, else ''.
    const saveErrors = storedValue(event, 'saveErrors');
    const failed = Object.keys(saved.errors).length > 0;
    const values = failed && !isTrue(saveErrors) ? overlaid(reloaded, event) : changesetValues(reloaded);
    const data = await serializeContentEntity(changesetView(values), call.apiContext, scopeOf(ctx, call).resolver, {
      expanded: true,
      expandLinks: expandOf(call),
      pk: CHANGESET_PK,
    });
    setNoCase(data, 'saveErrors', saveErrors);
    setNoCase(data, 'errors', { ...saved.errors });
    return jsonApiResultOf(data, CHANGESET.name);
  },

  /** delete (3259-3335): a stored change set, after AllowAction and CSRF, is thrown in the trash and deleted; answers ''. */
  async delete(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const requestedId = call.params.string(CHANGESET_PK);
    const fallbackId = call.params.has('id') ? call.params.string('id') : (call.id ?? '');
    const id = requestedId !== '' && isCfUuid(requestedId) ? requestedId : fallbackId;
    const actor = readerOf(call);
    const bean = await loadChangeset(ctx.domain, actor, { changesetId: id, siteId: call.siteId });
    if (bean.isnew === 1) return jsonApiResultOf('');
    if (!entityActionAllowed(call.actor, CHANGESET)) return authorizationDenied();
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    await deleteChangeset(ctx.domain, actor, bean.changesetid);
    return jsonApiResultOf('');
  },
});

// ---- changesetCategoryAssignment ----

/** A stored assignment as `set(row)` leaves the bean: every value trimmed, NULL as ''. */
function storedAssignmentValues(row: ChangesetCategoryAssignmentColumns): Struct {
  const values: Struct = { ...baseValues(), ...ASSIGNMENT_INIT };
  for (const column of ASSIGNMENT_COLUMNS) values[column] = javaTrim(row[column] ?? '');
  values['isnew'] = 0;
  return values;
}

/** An assignment no row matched: loadBy's arguments, the request site among them, set on a new bean. */
function newAssignmentValues(assignmentId: string, siteId: string): Struct {
  return { ...baseValues(), ...ASSIGNMENT_INIT, assignmentid: javaTrim(assignmentId), siteid: siteId, ...LOAD_BY_DEFAULTS, isnew: 1 };
}

/** An assignment bean as the serializers read it. */
function assignmentView(values: Readonly<Struct>): ApiEntityView {
  return {
    entityName: ASSIGNMENT.name,
    configName: ASSIGNMENT.name,
    primaryKey: ASSIGNMENT_PK,
    allValues: values,
    hasMany: ASSIGNMENT.hasMany,
    hasOne: ASSIGNMENT.hasOne,
  };
}

/** beanIterator.packageRecord: a new bean, `set(row)` of the selected columns, isNew 0. */
function assignmentItems(columns: readonly string[]): (row: ChangesetCategoryAssignmentColumns) => ApiEntityView {
  return (row) => {
    const stored = storedAssignmentValues(row);
    const values: Struct = { ...baseValues(), ...ASSIGNMENT_INIT };
    for (const column of columns) values[column] = stored[column];
    values['isnew'] = 0;
    return assignmentView(values);
  };
}

/** getFilteredValues of one assignment bean (2076-2238). */
function serializeAssignment(
  scope: Scope,
  values: Readonly<Struct>,
  opts: { expanded: number | boolean; editableCheck?: boolean },
): Promise<Struct> {
  return serializeContentEntity(assignmentView(values), scope.call.apiContext, scope.resolver, {
    ...opts,
    expandLinks: expandOf(scope.call),
    pk: ASSIGNMENT_PK,
  });
}

/** findAll and findQuery (2542-2625, 2711-2918) over the site's assignments. */
async function findAssignments(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
  return assignmentFeed(scopeOf(ctx, call), await listChangesetCategoryAssignments(ctx.domain, readerOf(call), call.siteId));
}

/** The assignment feed's page (or count) over `rows`. */
async function assignmentFeed(
  scope: Scope,
  rows: readonly ChangesetCategoryAssignmentColumns[],
  arrange?: (items: Struct[]) => Struct[],
): Promise<JsonApiResult> {
  const { call } = scope;
  const result = beanFeedQuery(rows, call, ASSIGNMENT_FEED);
  const view = assignmentItems(selectedColumns(call, ASSIGNMENT_COLUMNS));
  return jsonApiResultOf(await collectionData(scope, result, view, ASSIGNMENT.name, { expand: expandOf(call) }, arrange), ASSIGNMENT.name);
}

/** The bean's saveErrors after `set(event)`: a boolean param, else beanORM's false (beanORM.cfc:206-218). */
function saveErrorsOf(call: JsonApiCall): boolean {
  return isTrue(call.params.get('saveErrors'));
}

/** The `changesetCategoryAssignment` entity: change-set category rows of the request site behind module `…000`. */
export const changesetCategoryAssignmentHandler: EntityHandler = Object.freeze({
  entity: ASSIGNMENT.name,
  config: ASSIGNMENT,

  /** findOne (2292-2384): the site's assignment with the id, else a new bean keyed by it. */
  async findOne(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    assertNoHumanCheck(call);
    const id = call.id ?? '';
    const row = await findChangesetCategoryAssignment(ctx.domain, readerOf(call), { assignmentId: id, siteId: call.siteId });
    const values = row === null ? newAssignmentValues(id, call.siteId) : storedAssignmentValues(row);
    return jsonApiResultOf(await serializeAssignment(scopeOf(ctx, call), values, { expanded: 0, editableCheck: true }), ASSIGNMENT.name);
  },

  /** findMany (2627-2709): the site's assignments with the ids, in `ids` order unless the URL sorts them. */
  async findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    const wanted = new Set(idsOf(call).map(sqlKey));
    const rows = (await listChangesetCategoryAssignments(ctx.domain, readerOf(call), call.siteId)).filter((row) =>
      wanted.has(sqlKey(row.assignmentid)),
    );
    return assignmentFeed(scopeOf(ctx, call), rows, findManyOrder(call));
  },

  findAll: findAssignments,
  findQuery: findAssignments,

  /** findNew (2386-2422): loadBy a fresh id, which no row holds. */
  async findNew(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    assertNoHumanCheck(call);
    const values = newAssignmentValues(cfUuid(), call.siteId);
    return jsonApiResultOf(await serializeAssignment(scopeOf(ctx, call), values, { expanded: true, editableCheck: true }), ASSIGNMENT.name);
  },

  /** findProperties (1548-1618): the ORM property metadata; no access check, as legacy. */
  findProperties(_ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    // The component declares bundleable=true, which getBundleable reports as metadata text.
    const meta = { formats: ASSIGNMENT_PROPERTIES, nonPersistent: ASSIGNMENT_NON_PERSISTENT, bundleable: 'true', table: ASSIGNMENT_TABLE };
    return propertiesResult(call, ASSIGNMENT, meta);
  },

  /** findPermissions (2240-2266): the bean is loaded for a UUID or 35-character id; no access check, as legacy. */
  async findPermissions(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const id = call.id ?? '';
    const loads = isCfUuid(id) || id.length === 35;
    const row = loads ? await findChangesetCategoryAssignment(ctx.domain, readerOf(call), { assignmentId: id, siteId: call.siteId }) : null;
    // A load that finds no row sets its siteid argument, the request site, on the bean.
    const siteId = row === null ? call.siteId : javaTrim(row.siteid ?? '');
    const data = permissionsOf({
      hasSiteId: siteId !== '',
      readAllowed: entityAccessAllowed(call.actor, ASSIGNMENT),
      actionAllowed: entityActionAllowed(call.actor, ASSIGNMENT),
    });
    return jsonApiResultOf(data, ASSIGNMENT.name);
  },

  /** save (1903-2074): CSRF, then `loadBy(id).set(event)`, AllowAction and beanORM.save; answers the stored row. */
  async save(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const requestedId = call.params.string(ASSIGNMENT_PK);
    let id = call.id ?? 'new';
    if (requestedId !== '' && isLegacyFindOneId(requestedId)) id = requestedId;
    let eventId = requestedId;
    if (cfEq(id, 'new')) {
      // A fresh id becomes the event's primary key.
      id = cfUuid();
      eventId = id;
    }
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    if (!entityActionAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();

    // The event's siteid is always the request site (event.cfc:82-89); bean.set skips an empty primary key and null
    // values, and trims simple ones (bean.cfc:333, 427-429).
    const values: ChangesetCategoryAssignmentValues = { siteid: call.siteId };
    if (javaTrim(eventId) !== '') values.assignmentid = javaTrim(eventId);
    for (const field of ASSIGNMENT_SAVED_FIELDS) {
      const value = call.params.get(field);
      if (value !== undefined && value !== null) values[field] = javaTrim(call.params.string(field));
    }
    const saved = await saveChangesetCategoryAssignment(ctx.domain, readerOf(call), { loadId: id, siteId: call.siteId, values });
    const data = await serializeAssignment(scopeOf(ctx, call), storedAssignmentValues(saved), { expanded: true });
    setNoCase(data, 'saveErrors', saveErrorsOf(call));
    setNoCase(data, 'errors', {});
    return jsonApiResultOf(data, ASSIGNMENT.name);
  },

  /** delete (3259-3335): a stored assignment, after AllowAction and CSRF, is deleted by its id; answers ''. */
  async delete(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    const requestedId = call.params.string(ASSIGNMENT_PK);
    const fallbackId = call.params.has('id') ? call.params.string('id') : (call.id ?? '');
    const id = requestedId !== '' && isCfUuid(requestedId) ? requestedId : fallbackId;
    const actor = readerOf(call);
    const row = await findChangesetCategoryAssignment(ctx.domain, actor, { assignmentId: id, siteId: call.siteId });
    if (row === null) return jsonApiResultOf('');
    if (!entityActionAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
    await deleteChangesetCategoryAssignment(ctx.domain, actor, javaTrim(row.assignmentid));
    return jsonApiResultOf('');
  },
});

// ---- relation expansion (expandEntity, 2424-2498) ----

/** findQuery(changesetCategoryAssignment, params) of a changeset's `categoryAssignments`; AllowAccess throws (2711-2720). */
async function expandMany(scope: Scope, prop: RelationProp, params: Struct, opts: ExpansionOptions): Promise<unknown> {
  if (!cfEq(prop.cfc, ASSIGNMENT.name)) throw relationUnavailable(CHANGESET.name, prop.name);
  const { ctx, call } = scope;
  if (!entityAccessAllowed(call.actor, ASSIGNMENT)) throw new LegacyApiError('authorization');
  const rows = await listChangesetCategoryAssignments(ctx.domain, readerOf(call), call.siteId);
  const feedCall: JsonApiCall = { ...call, entityName: ASSIGNMENT.name, method: 'findQuery' };
  const result = beanFeedQuery(rows, feedCall, { ...ASSIGNMENT_FEED, expandedParams: params });
  return collectionData(scope, result, assignmentItems(ASSIGNMENT_COLUMNS), ASSIGNMENT.name, opts);
}

/** findOne(changeset, id) of an assignment's `changeset`; AllowAccess throws (2365-2371). */
async function expandOne(scope: Scope, prop: RelationProp, id: unknown, opts: ExpansionOptions): Promise<unknown> {
  if (!cfEq(prop.cfc, CHANGESET.name)) throw relationUnavailable(ASSIGNMENT.name, prop.name);
  if (!entityAccessAllowed(scope.call.actor, CHANGESET)) throw new LegacyApiError('authorization');
  return changesetEntity(scope, text(id), opts);
}
