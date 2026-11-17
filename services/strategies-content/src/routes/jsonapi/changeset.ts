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
  loadChangeset,
  loadedBean,
  newChangesetBean,
  queryChangesetCategoryAssignmentFeed,
  queryChangesetFeed,
  saveChangesetCategoryAssignment,
  saveChangesetEntity,
  setChangesetValues,
  type ChangesetBean,
  type ChangesetCategoryAssignmentColumns,
  type ChangesetCategoryAssignmentValues,
  type ChangesetColumns,
} from '../../domain/changesets.js';
import type { Actor } from '../../domain/context.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
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
  finderOf,
  findPropertiesFor,
  isBlankFeedRow,
  jsonApiResultOf,
  permissionsOf,
  relatedResolver,
  type BeanFeedOptions,
  type BeanFeedResult,
  type BlankFeedRow,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
  type RelationSourceKey,
  type SourceBeanGetter,
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

/** The scope of one handler call: both entities' own relations through these finders, the others through their entities'. */
function scopeOf(ctx: Ctx, call: JsonApiCall): Scope {
  const related = relatedResolver(call);
  const resolver: ExpansionResolver = {
    hasMany: (prop, params, opts) => (cfEq(prop.cfc, ASSIGNMENT.name) ? expandMany(scope, params, opts) : related.hasMany(prop, params, opts)),
    hasOne: (prop, id, opts) => (cfEq(prop.cfc, CHANGESET.name) ? expandOne(scope, id, opts) : related.hasOne(prop, id, opts)),
    crumbs: related.crumbs,
    relatedContent: related.relatedContent,
  };
  const scope: Scope = { ctx, call, resolver };
  return scope;
}

/** `{count}`, or packageIteratorArray (287-366) of the selected rows' beans; `arrange` orders the serialized items. */
async function collectionData<R>(
  scope: Scope,
  result: BeanFeedResult<R>,
  view: (row: R | BlankFeedRow) => ApiEntityView,
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
function changesetItems(scope: Scope, columns: readonly string[]): (row: ChangesetColumns | BlankFeedRow) => ApiEntityView {
  const bean = newChangesetBean(scope.call.actor, scope.ctx.domain.clock);
  const template = changesetValues(bean);
  return (row) => {
    const blank = isBlankFeedRow(row);
    const stored = changesetValues(blank ? setChangesetValues(bean, row) : loadedBean({ ...row, tenant_id: scope.call.tenantId }));
    const values: Struct = { ...template };
    for (const column of columns) values[column] = stored[column];
    const view = changesetView(values);
    // getChangesetID creates an id for a bean holding none (changesetBean.cfc:89-94), once getFilteredValues has copied the values.
    return blank ? { ...view, values: { changesetid: cfUuid() } } : view;
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

/** The changeset feed's page (or count) over the site's change sets, only those of `ids` when given. */
async function changesetFeed(
  scope: Scope,
  ids?: readonly string[],
  arrange?: (items: Struct[]) => Struct[],
): Promise<JsonApiResult> {
  const { ctx, call } = scope;
  const feedScope = { siteId: call.siteId, changesetIds: ids };
  const result = await queryChangesetFeed(ctx.domain, readerOf(call), feedScope, (source) => beanFeedQuery(source, call, CHANGESET_FEED));
  const view = changesetItems(scope, selectedColumns(call, CHANGESET_COLUMNS));
  return jsonApiResultOf(await collectionData(scope, result, view, CHANGESET.name, finderOf(call), arrange), CHANGESET.name);
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
  return changesetFeed(scopeOf(ctx, call));
}

/** The bean after save's error overlay (2054-2061): each request value the reloaded bean holds is set on it again. */
function overlaid(bean: ChangesetBean, event: Readonly<Struct>): Struct {
  const values = changesetValues(setChangesetValues(bean, event));
  for (const name of STORED_BASE_VALUES) {
    if (keyOf(event, name) !== undefined) values[name] = storedValue(event, name);
  }
  return values;
}

/** The `changeset` entity: change sets of the request site behind the Change Sets module (`m:014`). */
export const changesetHandler: EntityHandler = Object.freeze({
  entity: CHANGESET.name,
  config: CHANGESET,

  /** findOne (2292-2384). */
  async findOne(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
    const data = await changesetEntity(scopeOf(ctx, call), call.id ?? '', finderOf(call));
    return jsonApiResultOf(data, CHANGESET.name);
  },

  /** findMany (2627-2709): the site's change sets with the ids, in `ids` order unless the URL sorts them. */
  async findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, CHANGESET)) return authorizationDenied();
    return changesetFeed(scopeOf(ctx, call), idsOf(call), findManyOrder(call));
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
  async findProperties(_ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    return jsonApiResultOf(findPropertiesFor(CHANGESET, call), CHANGESET.name);
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
function assignmentItems(columns: readonly string[]): (row: ChangesetCategoryAssignmentColumns | BlankFeedRow) => ApiEntityView {
  return (row) => {
    const values: Struct = { ...baseValues(), ...ASSIGNMENT_INIT };
    if (isBlankFeedRow(row)) {
      for (const column of columns) values[column] = '';
      // beanORM.init gives the id column a createUUID() (beanORM.cfc:101-102), which set() keeps for an empty key.
      values['assignmentid'] = cfUuid();
    } else {
      const stored = storedAssignmentValues(row);
      for (const column of columns) values[column] = stored[column];
    }
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
    expandLinks: finderOf(scope.call).expand,
    pk: ASSIGNMENT_PK,
  });
}

/** findAll and findQuery (2542-2625, 2711-2918) over the site's assignments. */
async function findAssignments(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
  return assignmentFeed(scopeOf(ctx, call));
}

/** The assignment feed's page (or count) over the site's assignments, only those of `ids` when given. */
async function assignmentFeed(
  scope: Scope,
  ids?: readonly string[],
  arrange?: (items: Struct[]) => Struct[],
): Promise<JsonApiResult> {
  const { ctx, call } = scope;
  const feedScope = { siteId: call.siteId, assignmentIds: ids };
  const result = await queryChangesetCategoryAssignmentFeed(ctx.domain, readerOf(call), feedScope, (source) =>
    beanFeedQuery(source, call, ASSIGNMENT_FEED),
  );
  const view = assignmentItems(selectedColumns(call, ASSIGNMENT_COLUMNS));
  return jsonApiResultOf(await collectionData(scope, result, view, ASSIGNMENT.name, finderOf(call), arrange), ASSIGNMENT.name);
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
    const opts = { expanded: finderOf(call).expanded, editableCheck: true };
    return jsonApiResultOf(await serializeAssignment(scopeOf(ctx, call), values, opts), ASSIGNMENT.name);
  },

  /** findMany (2627-2709): the site's assignments with the ids, in `ids` order unless the URL sorts them. */
  async findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    if (!entityAccessAllowed(call.actor, ASSIGNMENT)) return authorizationDenied();
    return assignmentFeed(scopeOf(ctx, call), idsOf(call), findManyOrder(call));
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
  async findProperties(_ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
    return jsonApiResultOf(findPropertiesFor(ASSIGNMENT, call), ASSIGNMENT.name);
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

  /** loadBy(assignmentid=id) of a relation path's source; a `contentid` key names no column, so no row matches it. */
  async loadBy(ctx: Ctx, call: JsonApiCall, key: RelationSourceKey): Promise<SourceBeanGetter> {
    const id = 'primaryKey' in key ? key.primaryKey : '';
    const row = id === '' ? null : await findChangesetCategoryAssignment(ctx.domain, readerOf(call), { assignmentId: id, siteId: call.siteId });
    const values = row === null ? newAssignmentValues(id, call.siteId) : storedAssignmentValues(row);
    return (name) => getNoCase(values, cfEq(name, 'primaryKey') ? ASSIGNMENT_PK : name);
  },
});

// ---- relation expansion (expandEntity, 2424-2498) ----

/** findQuery(changesetCategoryAssignment, params) of a changeset's `categoryAssignments`; AllowAccess throws (2711-2720). */
async function expandMany(scope: Scope, params: Struct, opts: ExpansionOptions): Promise<unknown> {
  const { ctx, call } = scope;
  if (!entityAccessAllowed(call.actor, ASSIGNMENT)) throw new LegacyApiError('authorization');
  const feedCall: JsonApiCall = { ...call, entityName: ASSIGNMENT.name, method: 'findQuery' };
  const result = await queryChangesetCategoryAssignmentFeed(ctx.domain, readerOf(call), { siteId: call.siteId }, (source) =>
    beanFeedQuery(source, feedCall, { ...ASSIGNMENT_FEED, expandedParams: params }),
  );
  return collectionData(scope, result, assignmentItems(ASSIGNMENT_COLUMNS), ASSIGNMENT.name, opts);
}

/** findOne(changeset, id) of an assignment's `changeset`; AllowAccess throws (2365-2371). */
async function expandOne(scope: Scope, id: unknown, opts: ExpansionOptions): Promise<unknown> {
  if (!entityAccessAllowed(scope.call.actor, CHANGESET)) throw new LegacyApiError('authorization');
  return changesetEntity(scope, text(id), opts);
}
