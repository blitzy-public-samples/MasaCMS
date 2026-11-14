/**
 * JSON API `feed` entity handlers (jsonApiUtility.cfc:94 and its generic methods over feedBean.cfc and feedManager.cfc).
 * feedBean.getEntityName() answers its proxy name `content` (feedBean.cfc:771-778), so every legacy step handed the bean
 * object (AllowAccess, AllowAction, getLinks, the save and findNew serializer config) treats a feed as content, while the
 * steps handed the entity name (findMany and findQuery access, iterator configs) treat it as `feed`.
 */
import {
  adminUrl,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfNumberString,
  cfParseDateTimeText,
  cfToBoolean,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  legacyQuery,
  LegacyApiError,
} from '@opt2/platform/legacy-compat';
import { UndefinedLegacyMethodError, type Actor } from '../../domain/context.js';
import { FeedBean, FeedParamsQuery, deleteFeed, getContentItems, listFeeds, readFeed, saveFeed } from '../../domain/feeds.js';
import { allowContentAction, getModulePerm } from '../../domain/permissions.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
import {
  paramUrl,
  selectFields,
  serializeCollection,
  serializeContentEntity,
  urlParam,
  type ApiEntityView,
  type FilteredValuesOptions,
  type JsonApiRequestContext,
} from '../../legacy/jsonapi-serializers.js';
import {
  authorizationDenied,
  beanFeedQuery,
  entityAccessAllowed,
  findPropertiesFor,
  jsonApiResultOf,
  permissionsOf,
  type BeanFeedOptions,
  type BeanFeedResult,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
} from './types.js';

type Struct = Record<string, unknown>;
// Derived from the handler type: ../index.ts imports ../jsonapi.ts, which imports this folder.
type RouteContext = Parameters<JsonApiHandlerFn>[0];
type FeedRow = Awaited<ReturnType<typeof listFeeds>>['rsLocal'][number];

const ENTITY = 'feed';
const FEED = CONTENT_ENTITIES.feed;
/** feedBean.getPrimaryKey(), which getLinks reads. */
const BEAN_PK = 'feedID';
/** The pk save, findOne, findNew, findMany, findQuery and delete key a feed by. */
const PK = 'feedid';

/** tcontentfeeds columns in catalog order. */
const FEED_COLUMNS = [
  'feedid', 'siteid', 'parentid', 'name', 'isactive', 'ispublic', 'isdefault', 'isfeaturesonly', 'description', 'maxitems',
  'allowhtml', 'lang', 'lastupdateby', 'lastupdate', 'datecreated', 'restricted', 'restrictgroups', 'version', 'channellink',
  'type', 'sortby', 'sortdirection', 'nextn', 'displayname', 'displayratings', 'displaycomments', 'altname', 'remoteid',
  'remotesourceurl', 'remotepubdate', 'imagesize', 'imageheight', 'imagewidth', 'displaylist', 'shownavonly', 'showexcludesearch',
  'viewalllink', 'viewalllabel', 'cssclass', 'autoimport', 'islocked', 'contentpoolid', 'usecategoryintersect', 'authtype',
] as const satisfies readonly (keyof FeedRow)[];
const FEED_COLUMN_SET: ReadonlySet<string> = new Set(FEED_COLUMNS);

// feedBean, beanFeed and bean properties the fresh bean also holds a value for, so findQuery's valueExists and
// hasProperty both pass; the `site` relation holds no value, so `?site=` is ignored as legacy ignores it.
const PROPERTY_NAMES: readonly string[] = [
  'feedid', 'siteid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'altname', 'lang', 'isactive', 'shownavonly',
  'showexcludesearch', 'ispublic', 'isdefault', 'description', 'contentid', 'categoryid', 'maxitems', 'allowhtml',
  'isfeaturesonly', 'featuretype', 'restricted', 'restrictgroups', 'version', 'channellink', 'authtype', 'type', 'sortby',
  'sortdirection', 'parentid', 'nextn', 'displayname', 'displayratings', 'displaycomments', 'displaykids', 'isnew', 'params',
  'remoteid', 'remotesourceurl', 'remotepubdate', 'imagesize', 'imageheight', 'imagewidth', 'displaylist', 'liveonly',
  'entityname', 'viewalllabel', 'viewalllink', 'autoimport', 'islocked', 'cssclass', 'usecategoryintersect', 'alttable',
  'contentpoolid', 'includehomepage', 'table', 'keyfield', 'orderby', 'additionalcolumns', 'sorttable', 'pageindex', 'errors',
  'frommuracache', 'instanceid',
];

// Values feedBean.init sets that are no property: findQuery's valueExists passes and hasProperty fails, so filtering by
// one is invalidParameters (jsonApiUtility.cfc:2864-2892). `distinct` and `fields` are excluded from filtering first.
const INSTANCE_ONLY_VALUES: ReadonlySet<string> = new Set([
  'activeonly', 'avgvalarray', 'cachedwithin', 'countvalarray', 'displaysummaries', 'fieldaliases', 'groupbyarray', 'joins',
  'maxvalarray', 'minvalarray', 'pendingparam', 'sumvalarray', 'tablefieldlist', 'tablefieldlookup',
]);

/** The plain beanFeed feedBean.getFeed builds (feedBean.cfc:792-804): table tcontentfeeds, no default sort. */
const FEED_OPTIONS: BeanFeedOptions = Object.freeze({
  primaryKey: PK,
  propertyNames: PROPERTY_NAMES,
  hints: FEED.hints,
  relations: [...FEED.hasMany, ...FEED.hasOne],
  columns: FEED_COLUMNS,
  table: 'tcontentfeeds',
});

/** The modules AllowAction's content branch checks by type (jsonApiUtility.cfc:1752-1773); any other type checks Site Manager. */
const TYPE_MODULES: ReadonlyMap<string, string> = new Map([
  ['form', '00000000000000000000000000000000004'],
  ['component', '00000000000000000000000000000000003'],
  ['variation', '00000000000000000000000000000000099'],
]);
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';

/** Instance values that hold a date, which feedBean.init sets to `now()`. */
const DATE_VALUES: ReadonlySet<string> = new Set(['datecreated', 'lastupdate']);
const TS_TEXT = /^\{ts '[^']*'\}$/;

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

/** SQL Server's id equality: case-insensitive, trailing spaces ignored. */
function sqlKey(value: unknown): string {
  return cfText(value).replace(/ +$/u, '').toLowerCase();
}

/** The acting user with the call's verified tenant and site, which the feed reads run in (anonymous actors carry neither). */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** The `expand` argument the finders receive. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** The request values as the API's event holds them: the merged params, with the API site as siteid. */
function eventValues(call: JsonApiCall): Struct {
  const event: Struct = call.params.toRecord();
  setNoCase(event, 'siteid', call.siteId);
  return event;
}

// ---- feed beans ----

/** `$.getBean('feed')`: a fresh bean holding the request's site. */
function newFeed(ctx: RouteContext, call: JsonApiCall): FeedBean {
  const bean = FeedBean.init(ctx.domain.clock);
  bean.setValue('siteid', call.siteId);
  return bean;
}

/** `$.getBean('feed').loadBy(feedid=id)`: the stored feed, else the fresh bean of the request's site. */
async function loadFeed(ctx: RouteContext, call: JsonApiCall, feedId: string): Promise<FeedBean> {
  const bean = await readFeed(ctx.domain, readerOf(call), { feedId });
  if (bean.isNew === 1) bean.setValue('siteid', call.siteId);
  return bean;
}

/** The columns a `fields` SELECT reads: beanFeed.setFields keeps only tcontentfeeds columns; undefined selects them all. */
function selectedColumns(call: JsonApiCall): ReadonlySet<string> | undefined {
  const columns = cfListToArray(cfText(urlParam(call.apiContext, 'fields')))
    .map((field) => field.trim().toLowerCase())
    .filter((field) => FEED_COLUMN_SET.has(field));
  return columns.length === 0 ? undefined : new Set(columns);
}

/** The bean an iterator builds from a feed row (`getBean('feed').set(row).setIsNew(0)`), over the selected columns only. */
function rowBean(ctx: RouteContext, row: Readonly<Struct>, columns: ReadonlySet<string> | undefined): FeedBean {
  const values = columns === undefined ? row : Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key)));
  const bean = FeedBean.init(ctx.domain.clock).set(values);
  bean.isNew = 0;
  return bean;
}

/** An instance value as legacy holds it: init's `now()` as a date, the params query as a query. */
function legacyValue(key: string, value: unknown): unknown {
  if (value instanceof FeedParamsQuery) return legacyQuery([...value.columns], value.rows.map((row) => ({ ...row })));
  if (typeof value === 'string' && DATE_VALUES.has(key.toLowerCase()) && TS_TEXT.test(value)) return cfParseDateTimeText(value);
  return value;
}

/** feedBean's own getters that getValue prefers to stored values (feedBean.cfc:272-279, 460-509, 767-778). */
function getterValues(bean: FeedBean): Struct {
  return {
    imagesize: bean.get('imagesize'),
    imageheight: bean.get('imageheight'),
    imagewidth: bean.get('imagewidth'),
    // getContentPoolID answers the own site for ''; `*`, resolved through the site registry, keeps its stored value.
    contentpoolid: bean.text('contentpoolid') === '' ? bean.text('siteid') : bean.get('contentpoolid'),
    primarykey: BEAN_PK,
    entityname: 'content',
  };
}

/** A feed bean as the serializers read it: entity name `content`, the feed's own relations and getEditUrl (feedBean.cfc:700-704). */
function feedView(call: JsonApiCall, bean: FeedBean, configName: string): ApiEntityView {
  return {
    entityName: 'content',
    configName,
    primaryKey: BEAN_PK,
    allValues: Object.fromEntries(bean.entries().map(([key, value]) => [key, legacyValue(key, value)])),
    values: getterValues(bean),
    hasMany: FEED.hasMany,
    hasOne: FEED.hasOne,
    editUrl: adminUrl({
      circuit: 'cFeed',
      action: 'edit',
      params: [
        ['feedID', bean.text('feedid'), 'raw'],
        ['siteid', bean.text('siteid'), 'raw'],
        ['type', bean.text('type'), 'raw'],
        ['compactDisplay', 'false', 'raw'],
      ],
      context: call.site.urls.context,
    }),
  };
}

// ---- AllowAction ----

/**
 * Whether content.loadBy(contentID, siteID) finds an item for the feed's content ids: a single id the feed's site holds
 * an active version of (a comma list matches no contentid).
 */
async function contentLoads(ctx: RouteContext, actor: Actor, bean: FeedBean): Promise<boolean> {
  const contentId = bean.text('contentid');
  if (contentId === '' || contentId.includes(',')) return false;
  const probe = FeedBean.init(ctx.domain.clock);
  probe.setValue('siteid', bean.text('siteid'));
  probe.setValue('contentid', contentId);
  return (await getContentItems(ctx.domain, actor, probe)).length > 0;
}

/**
 * AllowAction for a feed bean, which takes the content branch (jsonApiUtility.cfc:1740-1790): the type's module, then the
 * parent's node verdict. When the feed's content ids load an item, legacy passes the feed's missing crumb array ('') to
 * getNodePerm, whose array argument check fails; that error is raised here as the legacy 500.
 */
async function feedActionAllowed(ctx: RouteContext, call: JsonApiCall, bean: FeedBean): Promise<boolean> {
  const requested = call.params.string('type');
  const type = TYPE_MODULES.has(requested.toLowerCase()) ? requested : bean.text('type');
  const actor = readerOf(call);
  if (getModulePerm(actor, TYPE_MODULES.get(type.toLowerCase()) ?? SITE_MANAGER_MODULE) && (await contentLoads(ctx, actor, bean))) {
    throw new TypeError('The CRUMBDATA argument passed to the getNodePerm function is not of type array.');
  }
  const input = { type, contentId: bean.text('contentid'), siteId: bean.text('siteid'), parentId: bean.text('parentid'), isNew: true };
  return (await allowContentAction(ctx.domain, actor, input)).allowed;
}

/** The request context with getLinks' edit-link AllowAction judging `bean` as legacy does. */
function withFeedAction(ctx: RouteContext, call: JsonApiCall, bean: FeedBean): JsonApiRequestContext {
  return { ...call.apiContext, allowAction: () => feedActionAllowed(ctx, call, bean) };
}

// ---- serialization ----

/**
 * Throws the legacy 500 a content config raises for a feed bean: getFilteredValues calls setImageURLs for `images`,
 * which calls the bean's undefined hasImage (bean.cfc:182).
 */
function rejectContentImages(view: ApiEntityView, call: JsonApiCall, opts: Pick<FilteredValuesOptions, 'expanded' | 'expandLinks'>): void {
  const { fields, allFields } = selectFields(view, call.apiContext, opts);
  if (allFields || fields.includes('images')) throw new UndefinedLegacyMethodError('hasImage');
}

/** getFilteredValues of a feed bean; under a content config `url` is the bean's getURL(), which getValue answers as ''. */
async function serializeFeed(
  ctx: RouteContext,
  call: JsonApiCall,
  bean: FeedBean,
  configName: string,
  opts: Pick<FilteredValuesOptions, 'expanded' | 'editableCheck'>,
): Promise<Struct> {
  const view = feedView(call, bean, configName);
  const filtered = { expanded: opts.expanded, expandLinks: expandOf(call) };
  const asContent = configName !== ENTITY;
  if (asContent) rejectContentImages(view, call, filtered);
  const data = await serializeContentEntity(view, withFeedAction(ctx, call, bean), undefined, {
    ...filtered,
    pk: PK,
    editableCheck: opts.editableCheck ?? false,
  });
  if (asContent && getNoCase(data, 'url') !== undefined) setNoCase(data, 'url', '');
  return data;
}

/** findQuery's base URL, which legacy builds from entity.getEntityName(), so under `/content/?` (jsonApiUtility.cfc:2795). */
function contentBaseUrl(call: JsonApiCall, baseUrl: string | undefined): string | undefined {
  const feedBase = `${call.apiContext.endpoint}/${call.entityName}/?`;
  return baseUrl?.startsWith(feedBase) ? `${call.apiContext.endpoint}/content/?${baseUrl.slice(feedBase.length)}` : baseUrl;
}

/** packageIteratorArray over the page's items, each serialized under `configName`. */
async function collectionOf(
  ctx: RouteContext,
  call: JsonApiCall,
  result: Exclude<BeanFeedResult<FeedRow>, { count: number }>,
  configName: string,
  reorder?: (items: Struct[]) => Struct[],
): Promise<Struct> {
  const columns = selectedColumns(call);
  const items: Struct[] = [];
  for (const row of result.items) {
    items.push(await serializeFeed(ctx, call, rowBean(ctx, row, columns), configName, { expanded: 0 }));
  }
  const baseUrl = contentBaseUrl(call, result.baseUrl);
  return serializeCollection(reorder === undefined ? items : reorder(items), result.page, call.apiContext, baseUrl === undefined ? {} : { baseUrl });
}

// ---- feeds ----

/** The site's feeds as the plain beanFeed selects them: `siteID = ?`, Local and Remote alike, in clustered (feedid) order. */
async function siteFeedRows(ctx: RouteContext, call: JsonApiCall): Promise<FeedRow[]> {
  const { rsLocal, rsRemote } = await listFeeds(ctx.domain, readerOf(call), call.siteId);
  const order = (a: FeedRow, b: FeedRow): number => {
    const x = a.feedid.toUpperCase();
    const y = b.feedid.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return [...rsLocal, ...rsRemote].sort(order);
}

/** Throws findQuery's invalidParameters for a query param naming an instance value that is no property. */
function rejectInstanceValueFilters(call: JsonApiCall): void {
  const named = call.query.params.entries().some(([key]) => INSTANCE_ONLY_VALUES.has((cfListToArray(key, '[')[0] ?? '').toLowerCase()));
  if (named) throw new LegacyApiError('invalidParameters');
}

/** findMany's `ids` as legacy lists them. */
function idsOf(call: JsonApiCall): string[] {
  return call.ids ?? cfListToArray(call.params.string('ids'));
}

// ---- handlers ----
// AllowAccess of the bean object resolves the public `content` entity (jsonApiUtility.cfc:1686-1738), so findOne, findAll,
// findNew and findPermissions' read run no Collections module check; only findMany and findQuery, which pass the entity
// name, require it (`s2`, `site-admin` or `m:011`).

/** findOne (2292-2384): the stored feed or the fresh bean, every value under the `feed` config, with content links. */
const findOne: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  const bean = await loadFeed(ctx, call, call.id ?? '');
  return jsonApiResultOf(await serializeFeed(ctx, call, bean, ENTITY, { expanded: 0, editableCheck: true }), ENTITY);
};

/** findMany (2627-2709): the site's feeds with the ids, each under the `contentnav` config, in `ids` order unless sorted. */
const findMany: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(call.actor, FEED)) return authorizationDenied();
  const ids = idsOf(call);
  const wanted = new Set(ids.map(sqlKey));
  const rows = (await siteFeedRows(ctx, call)).filter((row) => wanted.has(sqlKey(row.feedid)));
  const result = beanFeedQuery(rows, call, FEED_OPTIONS);
  if ('count' in result) return jsonApiResultOf({ count: result.count }, ENTITY);
  const inIdOrder = (items: Struct[]): Struct[] =>
    ids.flatMap((id): Struct[] => {
      const item = items.find((candidate) => cfEq(cfText(getNoCase(candidate, 'id')), id));
      return item === undefined ? [] : [item];
    });
  const sorted = cfText(urlParam(call.apiContext, 'sort')) !== '';
  return jsonApiResultOf(await collectionOf(ctx, call, result, 'contentnav', sorted ? undefined : inIdOrder), ENTITY);
};

/** findAll (2542-2625): countOnly counts the site's feeds; otherwise legacy refuses `feed` with invalidParameters (2602-2606). */
const findAll: JsonApiHandlerFn = async (ctx, call) => {
  const result = beanFeedQuery(await siteFeedRows(ctx, call), call, FEED_OPTIONS);
  if ('count' in result) return jsonApiResultOf({ count: result.count }, ENTITY);
  throw new LegacyApiError('invalidParameters');
};

/** findQuery (2711-2918): the site's feeds filtered by the query string, each under the `feed` config. */
const findQuery: JsonApiHandlerFn = async (ctx, call) => {
  if (!entityAccessAllowed(call.actor, FEED)) return authorizationDenied();
  rejectInstanceValueFilters(call);
  const result = beanFeedQuery(await siteFeedRows(ctx, call), call, FEED_OPTIONS);
  if ('count' in result) return jsonApiResultOf({ count: result.count }, ENTITY);
  return jsonApiResultOf(await collectionOf(ctx, call, result, ENTITY), ENTITY);
};

/** findNew (2386-2414): loadBy a fresh id leaves the fresh bean, serialized under the `content` config. */
const findNew: JsonApiHandlerFn = async (ctx, call) =>
  jsonApiResultOf(await serializeFeed(ctx, call, newFeed(ctx, call), 'content', { expanded: true, editableCheck: true }), ENTITY);

/** findProperties (1548-1618): answered without an access check, as legacy does. */
const findProperties: JsonApiHandlerFn = async (_ctx, call) => jsonApiResultOf(findPropertiesFor(FEED, call), ENTITY);

/** findPermissions (2240-2266): bean.getPermissions; save and delete are the content-branch AllowAction. */
const findPermissions: JsonApiHandlerFn = async (ctx, call) => {
  const id = call.id ?? '';
  const bean = isCfUuid(id) || id.length === 35 ? await loadFeed(ctx, call, id) : newFeed(ctx, call);
  const hasSiteId = bean.text('siteid') !== '';
  const actionAllowed = hasSiteId && (await feedActionAllowed(ctx, call, bean));
  return jsonApiResultOf(permissionsOf({ hasSiteId, readAllowed: true, actionAllowed }), ENTITY);
};

/**
 * save (1903-2074): CSRF, AllowAction, feedManager.save, then the reloaded bean (with the request values set back when
 * validation failed) under the `content` config, which fails at hasImage after the write unless `fields` omits images.
 */
const save: JsonApiHandlerFn = async (ctx, call) => {
  const data = eventValues(call);
  // `$.getBean('feed').set(event)` precedes the CSRF check, so a malformed advanced-param post fails first.
  FeedBean.init(ctx.domain.clock).set(data);
  const requested = cfText(getNoCase(data, PK));
  let id = call.id ?? 'new';
  if (requested !== '' && isLegacyFindOneId(requested)) id = requested;
  if (cfEq(id, 'new')) {
    id = cfUuid();
    setNoCase(data, 'id', id);
    setNoCase(data, PK, id);
  }
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };

  const entity = (await loadFeed(ctx, call, id)).set(data);
  if (!(await feedActionAllowed(ctx, call, entity))) return authorizationDenied();
  const saved = await saveFeed(ctx.domain, readerOf(call), entity);
  // feedBean declares no saveErrors, so getValue answers '' unless the request posted one.
  const saveErrors = saved.get('saveErrors');
  const errors = { ...saved.errors };
  const shown = await loadFeed(ctx, call, saved.text(PK));
  if (!(cfIsBoolean(saveErrors) && cfToBoolean(saveErrors)) && Object.keys(errors).length > 0) {
    for (const [key, value] of Object.entries(data)) if (shown.has(key)) shown.setValue(key, value);
  }
  const result = await serializeFeed(ctx, call, shown, 'content', { expanded: true });
  setNoCase(result, 'saveErrors', saveErrors);
  setNoCase(result, 'errors', errors);
  return jsonApiResultOf(result, ENTITY);
};

/** delete (3259-3335): a stored feed, after AllowAction and CSRF, goes through feedManager.delete; answers ''. */
const remove: JsonApiHandlerFn = async (ctx, call) => {
  const requested = call.params.string(PK);
  const fallback = call.params.has('id') ? call.params.string('id') : (call.id ?? '');
  const bean = await loadFeed(ctx, call, requested !== '' && isCfUuid(requested) ? requested : fallback);
  if (bean.isNew === 1) return jsonApiResultOf('');
  if (!(await feedActionAllowed(ctx, call, bean))) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  await deleteFeed(ctx.domain, readerOf(call), bean.text(PK));
  return jsonApiResultOf('');
};

/** The `feed` entity's generic-method handlers. */
export const feedHandler: EntityHandler = Object.freeze({
  entity: ENTITY,
  config: FEED,
  findOne,
  findMany,
  findAll,
  findNew,
  findQuery,
  findProperties,
  findPermissions,
  save,
  delete: remove,
});

