/**
 * JSON API `variationTargeting` entity (jsonApiUtility.cfc:103-105, core/mura/content/contentVariationTargetingBean.cfc):
 * the generic finders, save and delete as legacy answers them; the reads are served only while the entity is registered
 * for the site: the configBean `variations` setting is on, or findProperties has registered it.
 */
import {
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfToBoolean,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  javaTrim,
  LegacyApiError,
} from '@opt2/platform/legacy-compat';
import { isUnstorableTextError } from '@opt2/platform/service-kit';
import type { Actor, DomainDeps, LegacyErrors } from '../../domain/context.js';
import {
  deleteVariationTargeting,
  findVariationTargeting,
  saveVariationTargeting,
  variationsEnabled,
  withVariationTargetingFeed,
  type VariationTargeting,
  type VariationTargetingColumns,
  type VariationTargetingValues,
} from '../../domain/variations.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
import type { ContentRouteContext } from '../index.js';
import {
  paramUrl,
  serializeCollection,
  serializeContentEntity,
  urlParam,
  type ApiEntityView,
  type JsonApiRequestContext,
} from '../../legacy/jsonapi-serializers.js';
import {
  authorizationDenied,
  beanFeedQuery,
  entityAccessAllowed,
  entityActionAllowed,
  findPropertiesFor,
  firstScannedRow,
  isBlankFeedRow,
  jsonApiResultOf,
  permissionsOf,
  relatedResolver,
  type BeanFeedOptions,
  type BlankFeedRow,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
  type RelationSourceKey,
  type SourceBeanGetter,
} from './types.js';

type Struct = Record<string, unknown>;

const CONFIG = CONTENT_ENTITIES.variationTargeting;
const ENTITY = CONFIG.name;
const PRIMARY_KEY = CONFIG.primaryKey;
const TABLE = 'tcontentvariationtargeting';
const COLUMNS: readonly string[] = ['targetingid', 'contentid', 'siteid', 'initjs', 'targetingjs'];
const SAVED_FIELDS = ['contentid', 'initjs', 'targetingjs'] as const;

// beanORM.loadBy sets its own arguments on a bean no row matches (beanORM.cfc:913-915), so getAllValues of such a bean
// also reports loadBy's returnFormat and cachedWithin defaults (oracle: "returnformat":"self","cachedwithin":"0").
const LOAD_BY_DEFAULTS: Readonly<Struct> = Object.freeze({ cachedwithin: '0', returnformat: 'self' });

// findQuery filters by a param only when the sample bean holds a value under its name (bean.valueExists): the columns
// and the base bean values (bean.cfc:79-82, beanORM.cfc:79). The relation names `site` and `content` hold none, so
// legacy ignores `?site=` and `?content=`.
const FEED_OPTIONS: BeanFeedOptions = Object.freeze({
  primaryKey: PRIMARY_KEY,
  propertyNames: [...COLUMNS, 'errors', 'isNew', 'fromMuraCache', 'instanceID', 'saveErrors'],
  hints: CONFIG.hints,
  relations: [...CONFIG.hasMany, ...CONFIG.hasOne],
  columns: COLUMNS,
  table: TABLE,
});

// Legacy registers the entity at start-up only while `variations` is on (jsonApiUtility.cfc:103-105); otherwise
// findProperties registers it through getEntityConfig (124-129, 1559) on the site's API instance, which settingsBean
// caches (settingsBean.cfc:1249-1254) and the json, ajax and REST families share (contentServer.cfc:610-636). That
// registration lasts for the route context here, so for the service instance.
const registeredSites = new WeakMap<ContentRouteContext, Set<string>>();

/** Whether the entity is registered on `siteId`'s API instance; site ids match ignoring case, as settingsManager's. */
function registered(ctx: ContentRouteContext, siteId: string): boolean {
  return variationsEnabled(ctx.domain.config) || (registeredSites.get(ctx)?.has(siteId.toLowerCase()) ?? false);
}

/** getEntityConfig's registration of the entity on `siteId`'s API instance. */
function register(ctx: ContentRouteContext, siteId: string): void {
  const sites = registeredSites.get(ctx) ?? new Set<string>();
  sites.add(siteId.toLowerCase());
  registeredSites.set(ctx, sites);
}

// Unregistered, the bean still exists, so legacy reads refuse with `authorization` (oracle), never `invalidEntityCall`;
// save, delete and findProperties never consult the registration, and findPermissions reads it only for `read` (AllowAccess).
/** The read `fn`, refused while the entity is unregistered on the API instance of the request's site. */
function guarded(fn: JsonApiHandlerFn): JsonApiHandlerFn {
  return async (ctx, call) => {
    if (!registered(ctx, call.apiContext.siteId)) throw new LegacyApiError('authorization');
    return fn(ctx, call);
  };
}

/** The acting user in the call's verified tenant, which an anonymous actor does not carry itself. */
function actorOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId };
}

/** The request's `expand` list. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** A URL-scope value as text; '' when absent. */
function urlText(ctx: JsonApiRequestContext, name: string): string {
  const value = urlParam(ctx, name);
  return typeof value === 'string' ? value : '';
}

/** The bean as getFilteredValues reads it. */
function viewOf(allValues: Struct): ApiEntityView {
  return {
    entityName: ENTITY,
    configName: ENTITY,
    primaryKey: PRIMARY_KEY,
    allValues,
    hasMany: CONFIG.hasMany,
    hasOne: CONFIG.hasOne,
  };
}

// bean.set(query) trims every simple value it loads (bean.cfc:324-329, 427-429), so char(35) padding and surrounding
// whitespace of stored values never reach a response.
/** A column value as the loaded bean holds it; NULL reads as ''. */
function loadedText(value: string | null): string {
  return value === null ? '' : javaTrim(value);
}

/** getAllValues of a loaded or new bean. */
function beanValues(bean: VariationTargeting): Struct {
  const { isNew, ...columns } = bean;
  const values: Struct = {};
  for (const [column, value] of Object.entries(columns)) values[column] = loadedText(value);
  return isNew === 1 ? { ...values, ...LOAD_BY_DEFAULTS, isnew: 1 } : { ...values, isnew: 0 };
}

/**
 * getAllValues of an iterator bean over a feed row: beanFeed.setFields selects only the table columns `fields` names
 * (setFeedProps has appended the primary key), every column when it names none.
 */
function listedValues(row: VariationTargetingColumns | BlankFeedRow, ctx: JsonApiRequestContext): Struct {
  const selected = cfListToArray(urlText(ctx, 'fields'))
    .map((field) => javaTrim(field).toLowerCase())
    .filter((field) => COLUMNS.includes(field));
  const values: Struct = {};
  for (const [column, value] of Object.entries(row)) {
    if (selected.length === 0 || selected.includes(column)) values[column] = loadedText(value);
  }
  // beanORM.init gives the id column a createUUID() (beanORM.cfc:101-102), which set() keeps for an empty key.
  if (isBlankFeedRow(row)) values[PRIMARY_KEY] = cfUuid();
  values['isnew'] = 0;
  return values;
}

/**
 * packageIteratorArray over the feed's page of the actor's targeting rows (only those of `input.ids` when given), or the
 * countOnly count, which beanFeed answers as a string.
 */
async function feedResult(
  domain: DomainDeps,
  actor: Actor,
  call: JsonApiCall,
  input: { ids?: readonly string[] },
  order: (items: Struct[]) => Struct[] = (items) => items,
): Promise<JsonApiResult> {
  const result = await withVariationTargetingFeed(domain, actor, input, (source) => beanFeedQuery(source, call, FEED_OPTIONS));
  if ('count' in result) return jsonApiResultOf({ count: String(result.count) }, ENTITY);
  const ctx = call.apiContext;
  const expandLinks = expandOf(call);
  const items: Struct[] = [];
  for (const row of result.items) {
    items.push(await serializeContentEntity(viewOf(listedValues(row, ctx)), ctx, relatedResolver(call), { expandLinks, pk: PRIMARY_KEY }));
  }
  const options = result.baseUrl === undefined ? {} : { baseUrl: result.baseUrl };
  return jsonApiResultOf(serializeCollection(order(items), result.page, ctx, options), ENTITY);
}

/** findOne (2292-2384): loads by `targetingid`, a new bean when absent. */
const findOne: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(actor, CONFIG)) return authorizationDenied();
  const bean = await findVariationTargeting(ctx.domain, actor, { targetingId: call.id ?? '', siteId: call.siteId });
  const data = await serializeContentEntity(viewOf(beanValues(bean)), call.apiContext, relatedResolver(call), {
    expandLinks: expandOf(call),
    pk: PRIMARY_KEY,
    editableCheck: true,
  });
  return jsonApiResultOf(data, ENTITY);
});

/** findNew (2386-2422): a new bean under a fresh id in the request site. */
const findNew: JsonApiHandlerFn = guarded(async (_ctx, call) => {
  if (!entityAccessAllowed(actorOf(call), CONFIG)) return authorizationDenied();
  const bean: VariationTargeting = { targetingid: cfUuid(), contentid: '', siteid: call.siteId, initjs: '', targetingjs: '', isNew: 1 };
  const data = await serializeContentEntity(viewOf(beanValues(bean)), call.apiContext, relatedResolver(call), {
    expanded: true,
    expandLinks: expandOf(call),
    pk: PRIMARY_KEY,
    editableCheck: true,
  });
  return jsonApiResultOf(data, ENTITY);
});

/** findAll and findQuery (2542-2625, 2711-2918) over the site's targeting rows. */
const findFeed: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  if (!entityAccessAllowed(actor, CONFIG)) return authorizationDenied();
  return feedResult(ctx.domain, actor, call, {});
});

/** findMany (2627-2709): the rows whose id is in `ids`, in list order unless the URL sorts them. */
const findMany: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  if (!entityAccessAllowed(actor, CONFIG)) return authorizationDenied();
  const ids = call.ids ?? [];
  if (urlText(call.apiContext, 'sort') !== '') return feedResult(ctx.domain, actor, call, { ids });
  return feedResult(ctx.domain, actor, call, { ids }, (items) =>
    ids.flatMap((id): Struct[] => {
      const item = items.find((candidate) => typeof candidate['id'] === 'string' && cfEq(candidate['id'], id));
      return item === undefined ? [] : [item];
    }),
  );
});

/** findProperties (1548-1618); no access check, as legacy. It registers the entity before any property is read. */
const findProperties: JsonApiHandlerFn = (ctx, call) =>
  new Promise((resolve) => {
    register(ctx, call.apiContext.siteId);
    resolve(jsonApiResultOf(findPropertiesFor(CONFIG, call), ENTITY));
  });

/** findPermissions (2240-2266): bean.getPermissions of the addressed bean; no access check, as legacy. */
const findPermissions: JsonApiHandlerFn = async (ctx, call) => {
  const actor = actorOf(call);
  const id = call.id ?? '';
  // Only a uuid or 35-character id loads the bean; otherwise it keeps the request site.
  const hasSiteId =
    isCfUuid(id) || id.length === 35
      ? (await findVariationTargeting(ctx.domain, actor, { targetingId: id, siteId: call.siteId })).siteid !== ''
      : call.siteId !== '';
  const permissions = permissionsOf({
    hasSiteId,
    // AllowAccess refuses an unregistered entity; getPermissions asks the API instance of the bean's site, the request site.
    readAllowed: registered(ctx, call.siteId) && entityAccessAllowed(actor, CONFIG),
    actionAllowed: entityActionAllowed(actor, CONFIG),
  });
  return jsonApiResultOf(permissions, ENTITY);
};

/**
 * save's load key and the id the bean is saved under (1958-1973): a uuid `targetingid` param, else the call id, `new`
 * becoming a fresh id; bean.set then applies a non-empty `targetingid` param, trimmed, and skips an empty one.
 */
function saveKeys(call: JsonApiCall): { loadId: string; savedId: string } {
  const param = call.params.string(PRIMARY_KEY);
  const loadId = param !== '' && isLegacyFindOneId(param) ? param : (call.id ?? 'new');
  if (cfEq(loadId, 'new')) {
    const id = cfUuid();
    return { loadId: id, savedId: id };
  }
  const trimmed = javaTrim(param);
  return { loadId, savedId: trimmed !== '' ? trimmed : loadId };
}

/** The bean's saveErrors after `set(event)`: a boolean param, else false (beanORM.cfc:206-218). */
function saveErrorsOf(call: JsonApiCall): boolean {
  const value = call.params.get('saveErrors');
  return cfIsBoolean(value) && cfToBoolean(value);
}

/**
 * The bean save answers when validation kept it unwritten (2041-2049): reloaded by its primary key, then each request
 * value whose key the bean holds set on it as bean.set does (null skipped, text trimmed).
 */
async function unsavedValues(domain: DomainDeps, actor: Actor, call: JsonApiCall, savedId: string): Promise<Struct> {
  const values = beanValues(await findVariationTargeting(domain, actor, { targetingId: savedId, siteId: call.siteId }));
  for (const key of Object.keys(values)) {
    const value = call.params.get(key);
    if (value !== undefined && value !== null) values[key] = javaTrim(call.params.string(key));
  }
  // The event holds the request site and the id the bean was saved under.
  return { ...values, siteid: call.siteId, targetingid: savedId };
}

/** save's `set(event).save()` (1958-2049): the reloaded bean's values and the bean's validation errors. */
async function savedValues(
  domain: DomainDeps,
  actor: Actor,
  call: JsonApiCall,
  saveErrors: boolean,
): Promise<{ values: Struct; errors: LegacyErrors }> {
  const { loadId, savedId } = saveKeys(call);
  // A `targetingid` param that is not the load key re-keys the loaded bean; its unsupplied values carry over.
  const loaded = savedId === loadId ? undefined : await findVariationTargeting(domain, actor, { targetingId: loadId, siteId: call.siteId });
  // The event's siteid is always the request site (event.cfc:82-89).
  const input: VariationTargetingValues = { targetingid: savedId, siteid: call.siteId };
  for (const field of SAVED_FIELDS) {
    const value = call.params.get(field);
    // bean.set skips null values and trims simple ones (bean.cfc:333, 427-429).
    if (value !== undefined && value !== null) input[field] = javaTrim(call.params.string(field));
    else if (loaded !== undefined) input[field] = loaded[field];
  }
  const { saved, errors } = await saveVariationTargeting(domain, actor, input, { saveErrors });
  return { values: saved === null ? await unsavedValues(domain, actor, call, savedId) : beanValues(saved), errors };
}

/** save (1903-2074): CSRF first, then AllowAction, then `set(event).save()` and the reloaded bean. */
const save: JsonApiHandlerFn = async (ctx, call) => {
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  const actor = actorOf(call);
  if (!entityActionAllowed(actor, CONFIG)) return authorizationDenied();
  const saveErrors = saveErrorsOf(call);
  let saved: { values: Struct; errors: LegacyErrors };
  try {
    saved = await savedValues(ctx.domain, actor, call, saveErrors);
  } catch (err) {
    // PostgreSQL text cannot hold a NUL, which legacy stores (EX-UNSTORABLE-TEXT-VARIATIONTARGETING).
    if (isUnstorableTextError(err)) return { error: 'invalidParameters' };
    throw err;
  }
  const data = await serializeContentEntity(viewOf(saved.values), call.apiContext, relatedResolver(call), {
    expanded: true,
    expandLinks: expandOf(call),
    pk: PRIMARY_KEY,
  });
  data['saveErrors'] = saveErrors;
  data['errors'] = saved.errors;
  return jsonApiResultOf(data, ENTITY);
};

/** delete (3259-3335): a silent no-op for an absent row; else AllowAction, then CSRF, then the delete. */
const remove: JsonApiHandlerFn = async (ctx, call) => {
  const actor = actorOf(call);
  const param = call.params.string(PRIMARY_KEY);
  const targetingId = param !== '' && isCfUuid(param) ? param : (call.id ?? '');
  const bean = await findVariationTargeting(ctx.domain, actor, { targetingId, siteId: call.siteId });
  if (bean.isNew === 1) return { data: '' };
  if (!entityActionAllowed(actor, CONFIG)) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  await deleteVariationTargeting(ctx.domain, actor, targetingId);
  return { data: '' };
};

/** SQL Server's key equality: case-insensitive, trailing spaces ignored. */
function sqlKey(value: string | null): string {
  return (value ?? '').trimEnd().toLowerCase();
}

/**
 * beanORM.loadBy of a relation path's source, whatever the `variations` setting: by `targetingid`, or by `contentid`
 * the site's first row of the item, else loadBy's arguments on a new bean.
 */
async function loadBy(ctx: ContentRouteContext, call: JsonApiCall, key: RelationSourceKey): Promise<SourceBeanGetter> {
  const actor = actorOf(call);
  let values: Struct;
  if ('primaryKey' in key) {
    values = beanValues(await findVariationTargeting(ctx.domain, actor, { targetingId: key.primaryKey, siteId: call.siteId }));
  } else {
    const row = await withVariationTargetingFeed(ctx.domain, actor, {}, (source) =>
      firstScannedRow(source, (candidate) => sqlKey(candidate.siteid) === sqlKey(call.siteId) && sqlKey(candidate.contentid) === sqlKey(key.contentid)),
    );
    if (row === undefined) {
      values = beanValues({ targetingid: '', contentid: key.contentid, siteid: call.siteId, initjs: '', targetingjs: '', isNew: 1 });
    } else {
      values = { isnew: 0 };
      for (const [column, value] of Object.entries(row)) values[column] = loadedText(value);
    }
  }
  return (name) => values[(cfEq(name, 'primaryKey') ? PRIMARY_KEY : name).toLowerCase()];
}

/** The `variationTargeting` entity's handlers. */
export const variationTargetingHandler: EntityHandler = Object.freeze({
  entity: ENTITY,
  config: CONFIG,
  findOne,
  findMany,
  findAll: findFeed,
  findNew,
  findQuery: findFeed,
  findProperties,
  findPermissions,
  save,
  delete: remove,
  loadBy,
});
