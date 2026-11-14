/**
 * JSON API `variationTargeting` entity (jsonApiUtility.cfc:103-105, core/mura/content/contentVariationTargetingBean.cfc):
 * the generic finders, save and delete as legacy answers them, served only while the configBean `variations` setting is on.
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
import type { Actor } from '../../domain/context.js';
import {
  deleteVariationTargeting,
  findVariationTargeting,
  listVariationTargetings,
  saveVariationTargeting,
  variationsEnabled,
  type VariationTargeting,
  type VariationTargetingColumns,
  type VariationTargetingValues,
} from '../../domain/variations.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
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
  jsonApiResultOf,
  permissionsOf,
  type BeanFeedOptions,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
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

// applyPropertyFormat of each persistent or related property of contentVariationTargetingBean, in getProperties order,
// exactly as the oracle answers findProperties (jsonApiUtility.cfc:1517-1618).
const PROPERTY_FORMATS: ReadonlyMap<string, Readonly<Struct>> = new Map([
  [
    'targetingid',
    { fieldtype: 'id', length: '35', required: true, nullable: false, html: 'false', name: 'targetingid', datatype: 'char', default: '' },
  ],
  [
    'site',
    {
      fieldtype: 'many-to-one',
      loadkey: 'siteid',
      length: '25',
      required: false,
      cascade: 'none',
      nullable: true,
      html: 'false',
      fkcolumn: 'siteid',
      name: 'site',
      datatype: 'varchar',
      relatesto: 'site',
      default: '',
    },
  ],
  ['initjs', { fieldtype: '', required: false, html: 'false', nullable: true, name: 'initjs', datatype: 'text', default: 'null' }],
  [
    'targetingjs',
    { fieldtype: '', required: false, html: 'false', nullable: true, name: 'targetingjs', datatype: 'text', default: 'null' },
  ],
  [
    'content',
    {
      fieldtype: 'one-to-one',
      loadkey: 'contentid',
      length: '35',
      required: false,
      cascade: 'none',
      nullable: true,
      html: 'false',
      fkcolumn: 'contentid',
      name: 'content',
      datatype: 'char',
      relatesto: 'content',
      default: '',
    },
  ],
]);

// Non-persistent base properties findProperties skips without error (bean.cfc:79-82, beanORM.cfc:79).
const NON_PERSISTENT_PROPERTIES: ReadonlySet<string> = new Set(['errors', 'isnew', 'frommuracache', 'instanceid', 'saveerrors']);

// Legacy registers the entity only while `variations` is on (jsonApiUtility.cfc:103-105). Unregistered, the bean still
// exists, so legacy reads refuse with `authorization` (oracle), never `invalidEntityCall`; every handler answers so.
/** `fn` behind the `variations` setting. */
function guarded(fn: JsonApiHandlerFn): JsonApiHandlerFn {
  return async (ctx, call) => {
    if (!variationsEnabled(ctx.domain.config)) throw new LegacyApiError('authorization');
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

/** SQL Server's `=` key: case-insensitive, trailing spaces ignored. */
function sqlKey(id: string): string {
  return id.replace(/ +$/u, '').toLowerCase();
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
function listedValues(row: VariationTargetingColumns, ctx: JsonApiRequestContext): Struct {
  const selected = cfListToArray(urlText(ctx, 'fields'))
    .map((field) => javaTrim(field).toLowerCase())
    .filter((field) => COLUMNS.includes(field));
  const values: Struct = {};
  for (const [column, value] of Object.entries(row)) {
    if (selected.length === 0 || selected.includes(column)) values[column] = loadedText(value);
  }
  values['isnew'] = 0;
  return values;
}

/** packageIteratorArray over the feed's page, or the countOnly count, which beanFeed answers as a string. */
async function feedResult(
  call: JsonApiCall,
  rows: readonly VariationTargetingColumns[],
  order: (items: Struct[]) => Struct[] = (items) => items,
): Promise<JsonApiResult> {
  const result = beanFeedQuery(rows, call, FEED_OPTIONS);
  if ('count' in result) return jsonApiResultOf({ count: String(result.count) }, ENTITY);
  const ctx = call.apiContext;
  const expandLinks = expandOf(call);
  const items: Struct[] = [];
  for (const row of result.items) {
    items.push(await serializeContentEntity(viewOf(listedValues(row, ctx)), ctx, undefined, { expandLinks, pk: PRIMARY_KEY }));
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
  const data = await serializeContentEntity(viewOf(beanValues(bean)), call.apiContext, undefined, {
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
  const data = await serializeContentEntity(viewOf(beanValues(bean)), call.apiContext, undefined, {
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
  return feedResult(call, await listVariationTargetings(ctx.domain, actor));
});

/** findMany (2627-2709): the rows whose id is in `ids`, in list order unless the URL sorts them. */
const findMany: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  if (!entityAccessAllowed(actor, CONFIG)) return authorizationDenied();
  const ids = call.ids ?? [];
  const wanted = new Set(ids.map(sqlKey));
  const rows = (await listVariationTargetings(ctx.domain, actor)).filter((row) => wanted.has(sqlKey(row.targetingid)));
  if (urlText(call.apiContext, 'sort') !== '') return feedResult(call, rows);
  return feedResult(call, rows, (items) =>
    ids.flatMap((id): Struct[] => {
      const item = items.find((candidate) => typeof candidate['id'] === 'string' && cfEq(candidate['id'], id));
      return item === undefined ? [] : [item];
    }),
  );
});

/** findProperties (1548-1618): the bean's ORM property metadata; no access check, as legacy. */
const findProperties: JsonApiHandlerFn = guarded(async (_ctx, call) => {
  const requested = cfListToArray(call.params.string('properties')).map((name) => name.toLowerCase());
  const names = requested.length > 0 ? requested : [...PROPERTY_FORMATS.keys()];
  const properties = names.flatMap((name) => {
    if (NON_PERSISTENT_PROPERTIES.has(name)) return [];
    const format = PROPERTY_FORMATS.get(name);
    // `props[p]` of an unknown name raises an undefined-element error (1568).
    if (format === undefined) throw new LegacyApiError('server_error');
    return [{ ...format }];
  });
  const result = findPropertiesFor(CONFIG, call);
  result['properties'] = properties;
  // The component declares bundleable=true, which getBundleable reports as metadata text.
  result['bundleable'] = 'true';
  if (Object.hasOwn(result, 'table')) result['table'] = TABLE;
  return jsonApiResultOf(result, ENTITY);
});

/** findPermissions (2240-2266): bean.getPermissions of the addressed bean; no access check, as legacy. */
const findPermissions: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  const id = call.id ?? '';
  // Only a uuid or 35-character id loads the bean; otherwise it keeps the request site.
  const hasSiteId =
    isCfUuid(id) || id.length === 35
      ? (await findVariationTargeting(ctx.domain, actor, { targetingId: id, siteId: call.siteId })).siteid !== ''
      : call.siteId !== '';
  const permissions = permissionsOf({
    hasSiteId,
    readAllowed: entityAccessAllowed(actor, CONFIG),
    actionAllowed: entityActionAllowed(actor, CONFIG),
  });
  return jsonApiResultOf(permissions, ENTITY);
});

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

/** save (1903-2074): CSRF first, then AllowAction, then `set(event).save()` and the reloaded bean. */
const save: JsonApiHandlerFn = guarded(async (ctx, call) => {
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  const actor = actorOf(call);
  if (!entityActionAllowed(actor, CONFIG)) return authorizationDenied();
  const { loadId, savedId } = saveKeys(call);
  // A `targetingid` param that is not the load key re-keys the loaded bean; its unsupplied values carry over.
  const loaded = savedId === loadId ? undefined : await findVariationTargeting(ctx.domain, actor, { targetingId: loadId, siteId: call.siteId });
  // The event's siteid is always the request site (event.cfc:82-89).
  const input: VariationTargetingValues = { targetingid: savedId, siteid: call.siteId };
  for (const field of SAVED_FIELDS) {
    const value = call.params.get(field);
    // bean.set skips null values and trims simple ones (bean.cfc:333, 427-429).
    if (value !== undefined && value !== null) input[field] = javaTrim(call.params.string(field));
    else if (loaded !== undefined) input[field] = loaded[field];
  }
  const saved = await saveVariationTargeting(ctx.domain, actor, input);
  if (saved === null) throw new LegacyApiError('authorization');
  const data = await serializeContentEntity(viewOf(beanValues(saved)), call.apiContext, undefined, {
    expanded: true,
    expandLinks: expandOf(call),
    pk: PRIMARY_KEY,
  });
  data['saveErrors'] = saveErrorsOf(call);
  data['errors'] = {};
  return jsonApiResultOf(data, ENTITY);
});

/** delete (3259-3335): a silent no-op for an absent row; else AllowAction, then CSRF, then the delete. */
const remove: JsonApiHandlerFn = guarded(async (ctx, call) => {
  const actor = actorOf(call);
  const param = call.params.string(PRIMARY_KEY);
  const targetingId = param !== '' && isCfUuid(param) ? param : (call.id ?? '');
  const bean = await findVariationTargeting(ctx.domain, actor, { targetingId, siteId: call.siteId });
  if (bean.isNew === 1) return { data: '' };
  if (!entityActionAllowed(actor, CONFIG)) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  await deleteVariationTargeting(ctx.domain, actor, targetingId);
  return { data: '' };
});

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
});
