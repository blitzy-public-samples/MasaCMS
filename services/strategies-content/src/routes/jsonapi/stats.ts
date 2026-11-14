/**
 * JSON API `stats` handlers (jsonApiUtility.cfc:101, 1210-1211, 2240-2347, 2542-2918; contentStatsBean.cfc:76-262).
 * contentStatsBean extends mura.bean.bean rather than beanORM, so it has no `loadBy`.
 */
import { cfEq, isCfUuid } from '@opt2/platform/legacy-compat';
import { withTenant } from '@opt2/platform/tenancy';
import { UndefinedLegacyMethodError } from '../../domain/context.js';
import { STATS_DEFAULTS, loadStats, statsValues, type ContentStats } from '../../domain/stats.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
import {
  paramUrl,
  serializeCollection,
  serializeContentEntity,
  serializeEntityList,
  urlParam,
  type ApiEntityView,
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

const ENTITY = 'stats';
const CONFIG = CONTENT_ENTITIES.stats;

// contentStatsBean.init sets only these instance values (it never calls super.init), and they are tcontentstats'
// columns: findQuery filters by a name only when the bean holds a value for it, so `?isnew=0` is ignored.
const STATS_FIELDS: readonly string[] = Object.keys(STATS_DEFAULTS);

/** The plain beanFeed `getBean('stats').getFeed()` builds: no entity feed, no default sort. */
const FEED_OPTIONS: BeanFeedOptions = Object.freeze({
  primaryKey: CONFIG.primaryKey,
  propertyNames: STATS_FIELDS,
  columns: STATS_FIELDS,
  hints: CONFIG.hints,
  relations: [...CONFIG.hasMany, ...CONFIG.hasOne],
  table: 'tcontentstats',
});

/** One stats bean as getFilteredValues reads it. */
function statsView(stats: ContentStats): ApiEntityView {
  return {
    entityName: ENTITY,
    configName: ENTITY,
    primaryKey: CONFIG.primaryKey,
    allValues: { ...stats },
    hasMany: CONFIG.hasMany,
    hasOne: CONFIG.hasOne,
  };
}

/**
 * Legacy calls `loadBy` on the stats bean here, which bean.cfc's onMissingMethod rejects (bean.cfc:182) before any
 * access check or write, so the call answers the legacy 500 `server_error`.
 */
function missingLoadBy(): never {
  throw new UndefinedLegacyMethodError('loadBy');
}

/** An item's `id` value, read ignoring case as CFML does. */
function itemId(item: Readonly<Record<string, unknown>>): string {
  const key = Object.keys(item).find((name) => name.toLowerCase() === 'id');
  const value = key === undefined ? undefined : item[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

/** findMany's order (jsonApiUtility.cfc:2697-2709): for each requested id, the first item whose `id` equals it. */
function inIdOrder(items: readonly Record<string, unknown>[], ids: readonly string[]): Record<string, unknown>[] {
  return ids.flatMap((id) => {
    const match = items.find((item) => cfEq(itemId(item), id));
    return match === undefined ? [] : [match];
  });
}

/** The feed's count or page over `rows`, each page row packaged as an iterator bean (`set(row).setIsNew(0)`). */
async function feedResult(
  call: JsonApiCall,
  rows: readonly Readonly<Record<string, unknown>>[],
  ids?: readonly string[],
): Promise<JsonApiResult> {
  const result = beanFeedQuery(rows, call, FEED_OPTIONS);
  if ('count' in result) return jsonApiResultOf({ count: result.count }, ENTITY);
  const views = result.items.map((row) => statsView(statsValues({ ...row, isNew: 0 })));
  let items = await serializeEntityList(views, call.apiContext, { entityName: ENTITY, expand: call.params.string('expand') });
  if (ids !== undefined && String(urlParam(call.apiContext, 'sort') ?? '') === '') items = inIdOrder(items, ids);
  return jsonApiResultOf(serializeCollection(items, result.page, call.apiContext, { baseUrl: result.baseUrl }), ENTITY);
}

/** findOne (2341-2347): the item's stats row over the bean defaults, or the defaults alone; reading never inserts. */
const findOne: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(call.actor, CONFIG)) return authorizationDenied();
  const stats = await withTenant(ctx.domain.db, call.tenantId, (tx) =>
    loadStats(tx, ctx.domain.repository, call.id ?? '', call.siteId),
  );
  const data = await serializeContentEntity(statsView(statsValues(stats)), call.apiContext, undefined, {
    expanded: 0,
    expandLinks: call.params.string('expand'),
    pk: CONFIG.primaryKey,
    editableCheck: true,
  });
  return jsonApiResultOf(data, ENTITY);
};

/** findAll and findQuery (2542-2625, 2711-2918): the site's stats rows through the generic beanFeed. */
const findFeed: JsonApiHandlerFn = async (ctx, call) => {
  if (!entityAccessAllowed(call.actor, CONFIG)) return authorizationDenied();
  // Only the request site's rows: a `contentpoolid` naming other sites would reach other tenants' rows.
  const rows = await withTenant(ctx.domain.db, call.tenantId, (tx) =>
    ctx.domain.repository.stats.siteStats(tx, { siteId: call.siteId }),
  );
  return feedResult(call, rows);
};

/** findMany (2627-2710): the site's rows of `ids`, in the order of `ids` unless the URL sorts them. */
const findMany: JsonApiHandlerFn = async (ctx, call) => {
  if (!entityAccessAllowed(call.actor, CONFIG)) return authorizationDenied();
  const ids = call.ids ?? [];
  const rows = await withTenant(ctx.domain.db, call.tenantId, (tx) =>
    ctx.domain.repository.stats.siteStats(tx, { siteId: call.siteId, contentIds: ids }),
  );
  return feedResult(call, rows, ids);
};

/** findPermissions (2240-2266): bean.getPermissions of a fresh stats bean; an id makes legacy call `loadBy`. */
const findPermissions: JsonApiHandlerFn = async (_ctx, call) => {
  const id = call.id ?? '';
  if (isCfUuid(id) || id.length === 35) missingLoadBy();
  const permissions = permissionsOf({
    hasSiteId: call.siteId !== '',
    readAllowed: entityAccessAllowed(call.actor, CONFIG),
    actionAllowed: entityActionAllowed(call.actor, CONFIG),
  });
  return jsonApiResultOf(permissions, ENTITY);
};

/** findProperties (1548-1618): answered without an access check, as legacy does. */
const findProperties: JsonApiHandlerFn = async (_ctx, call) => jsonApiResultOf(findPropertiesFor(CONFIG, call), ENTITY);

/** save (1903-2074): the CSRF check, then the failing `loadBy`; nothing is written. */
const save: JsonApiHandlerFn = async (_ctx, call) => {
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  return missingLoadBy();
};

/** findNew (2386-2410) and delete (3259-3335) call `loadBy` first. */
const loadByFirst: JsonApiHandlerFn = async () => missingLoadBy();

/** The `stats` entity's generic-method handlers. */
export const statsHandler: EntityHandler = Object.freeze({
  entity: ENTITY,
  config: CONFIG,
  findOne,
  findMany,
  findAll: findFeed,
  findNew: loadByFirst,
  findQuery: findFeed,
  findProperties,
  findPermissions,
  save,
  delete: loadByFirst,
});
