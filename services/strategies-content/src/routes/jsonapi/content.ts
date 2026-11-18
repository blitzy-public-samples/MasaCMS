/**
 * JSON API `content` and `contentnav` entity (core/mura/client/api/json/v1/jsonApiUtility.cfc:69-105): the generic
 * finders and delete of contentBean and contentNavBean over ../../domain/content.ts, content-tree.ts and search.ts.
 * Their save is withheld: with no handler, the dispatcher answers it with the legacy 503.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  LegacyApiError,
  LegacyServiceUnavailableError,
  adminUrl,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  isCfUuid,
} from '@opt2/platform/legacy-compat';
import { throwIfRequestAborted } from '@opt2/platform/service-kit';
import { deleteContentEntity, LegacyContentBean, type ContentDeps } from '../../domain/content.js';
import { getCrumbList, readContent, readContentVersions, type ContentBean, type ContentRef, type ContentVersionRef } from '../../domain/content-tree.js';
import type { Actor, SiteContentSettings } from '../../domain/context.js';
import { FeedContentUnsupportedError } from '../../domain/feeds.js';
import { allowContentAction } from '../../domain/permissions.js';
import { contentPoolSites, type PoolSite } from '../../domain/pools.js';
import { findContentQuery, type ContentQueryRequest, type ContentQueryResult } from '../../domain/search.js';
import { CONTENT_ENTITIES } from '../../legacy/jsonapi-entities.js';
import { contentUrl, type LegacySiteUrlConfig } from '../../legacy/content-urls.js';
import {
  iteratorPage,
  paramUrl,
  selectFields,
  serializeCollection,
  serializeContentEntity,
  serializeEntityList,
  urlParam,
  type ApiEntityView,
  type EntityCollectionSource,
  type ExpansionOptions,
  type ExpansionResolver,
  type FilteredValuesOptions,
  type JsonApiRequestContext,
} from '../../legacy/jsonapi-serializers.js';
import {
  authorizationDenied,
  entityAccessAllowed,
  finderOf,
  finderParamsOf,
  findPropertiesFor,
  jsonApiResultOf,
  permissionsOf,
  relatedResolver,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type RelationSourceKey,
  type SourceBeanGetter,
} from './types.js';
import { validate } from './validate.js';

type Ctx = Parameters<JsonApiHandlerFn>[0];
type Struct = Record<string, unknown>;
/** A contentNavBean's row struct (a feed row or a crumb), which its getValue reads before the content bean's. */
type NavRow = Readonly<Struct>;

const ENTITY = 'content';
const CONTENT = CONTENT_ENTITIES.content;
/** The pk content beans are serialized and loaded by. */
const PK = 'contentid';
/** contentBean getters bean.getValue prefers to stored values, as LegacyContentBean.get answers them. */
const GETTER_KEYS: readonly string[] = ['imagesize', 'imageheight', 'imagewidth', 'htmltitle', 'metakeywords', 'canonicalurl', 'initjs', 'ishome', 'depth'];
/** The types AllowAction takes from the request `type` instead of the bean (jsonApiUtility.cfc:1748-1750). */
const TYPE_OVERRIDES: ReadonlySet<string> = new Set(['form', 'component', 'variation']);
/** Types whose getEditURL `topid` is their module (contentBean.cfc:1328-1330). */
const MODULE_TOP_TYPES: ReadonlySet<string> = new Set(['form', 'component']);
/** Fields getFilteredValues fills itself after the field loop, whatever the bean holds (2195-2221). */
const COMPUTED_FIELDS: ReadonlySet<string> = new Set(['links', 'images', 'url']);
const OVERWRITTEN_FIELDS: ReadonlySet<string> = new Set(['id', 'entityname']);
/** Fields the content bean's own site builds: its renderer's URLs. */
const SITE_URL_FIELDS: ReadonlySet<string> = new Set(['url', 'images', 'assocurl']);

/** Per-call state: the reader, the request context whose AllowAction judges content, and the expansion resolver. */
interface ContentScope {
  readonly ctx: Ctx;
  readonly call: JsonApiCall;
  readonly reader: Actor;
  readonly apiContext: JsonApiRequestContext;
  readonly resolver: ExpansionResolver;
  /** The registered sites of the request tenant's content pool, read at most once. */
  poolSites(): Promise<readonly PoolSite[]>;
}

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

/** CFML `isBoolean(x) && x`. */
function isTrue(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** SQL Server's site id equality: case-insensitive, trailing spaces ignored. */
function sameSite(a: string, b: string): boolean {
  return a.trimEnd().toLowerCase() === b.trimEnd().toLowerCase();
}

/** The acting user with the call's verified tenant and site, which the content reads run in (anonymous actors carry neither). */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** The request's `expand` list. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** `$.event()` of the API request: the API site, the merged params, and the `id` the dispatcher resolved (event.cfc:82-101). */
function eventValues(call: JsonApiCall): Struct {
  const event: Struct = { siteid: call.siteId };
  for (const [key, value] of call.params.entries()) {
    if (!cfEq(key, 'siteid')) setNoCase(event, key, value);
  }
  if (call.id !== undefined) setNoCase(event, 'id', call.id);
  return event;
}

/** The collaborators of a content write: the domain deps with the service's storage for uploads. */
function writeDeps(ctx: Ctx): ContentDeps {
  return { ...ctx.domain, storage: ctx.storage };
}

/**
 * settingsBean `extranet` (`applyPermFilter` of the finders' iterators) where the site settings carry it, else the
 * settingsBean default 0 (settingsBean.cfc:199): neither SiteContentSettings nor the registry declares the setting.
 */
function extranetOf(call: JsonApiCall): boolean {
  const site: SiteContentSettings & { extranet?: unknown } = call.site;
  return isTrue(site.extranet);
}

/** The legacy 503 for a content response whose values come from the CFML runtime or another entity's finder. */
function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** `url.ishuman` renders the CFML form-protection include into findOne and findNew results (2378-2381, 2416-2419). */
function assertNoHumanCheck(call: JsonApiCall): void {
  if (urlParam(call.apiContext, 'ishuman') !== undefined) {
    throw unavailable('The ishuman field renders a CFML display object', 'cfml-render');
  }
}

// ---- content beans as the serializers read them ----

/** contentBean.getAssocURL (contentBean.cfc:1293-1299): a Link's body, else the complete URL of its filename on `site`. */
function assocUrlOf(site: LegacySiteUrlConfig, bean: LegacyContentBean): unknown {
  if (cfEq(bean.text('type'), 'Link')) return bean.get('body');
  return contentUrl(site, { filename: bean.text('filename') }, { complete: true });
}

/** getEditURL (contentBean.cfc:1325-1349, contentNavBean.cfc:274-302) without compact display, tab or hash. */
function editUrlOf(call: JsonApiCall, value: (key: string) => string): string {
  const type = value('type');
  return adminUrl({
    circuit: 'cArch',
    action: 'edit',
    context: call.site.urls.context,
    params: [
      ['contenthistid', value('contenthistid')],
      ['contentid', value('contentid')],
      ['type', type],
      ['siteid', value('siteid')],
      ['topid', MODULE_TOP_TYPES.has(type.toLowerCase()) ? value('moduleid') : LEGACY_ADMIN_SENTINEL_ID],
      ['parentid', value('parentid')],
      ['moduleid', value('moduleid')],
      ['compactdisplay', 'false'],
    ],
  });
}

/**
 * The view of a content bean, or of a contentNavBean over `row`, whose getValue reads the row before the bean; reading
 * the ids creates them, as getContentID does. `site` is the bean's own site when it is not the request site.
 */
function contentView(scope: ContentScope, bean: LegacyContentBean, configName: string, row?: NavRow, site?: LegacySiteUrlConfig): ApiEntityView {
  const values: Struct = {
    contentid: bean.contentId(),
    contenthistid: bean.contentHistId(),
    assocurl: assocUrlOf(site ?? scope.call.apiContext.site, bean),
  };
  for (const key of GETTER_KEYS) values[key] = bean.get(key);
  for (const [key, value] of Object.entries(row ?? {})) setNoCase(values, key, value ?? '');
  const value = (key: string): string => cfText(getNoCase(values, key) ?? bean.get(key));
  return {
    entityName: ENTITY,
    configName,
    primaryKey: PK,
    allValues: Object.fromEntries(bean.entries()),
    values,
    hasMany: CONTENT.hasMany,
    hasOne: CONTENT.hasOne,
    editUrl: editUrlOf(scope.call, value),
    ...(site === undefined ? {} : { site }),
  };
}

/** The value getValue answers for `name` on `view`; undefined when the bean holds none. */
function heldValue(view: ApiEntityView, name: string): unknown {
  const getter = view.values === undefined ? undefined : getNoCase(view.values, name);
  return getter !== undefined ? getter : getNoCase(view.allValues, name);
}

// Fail closed: getAllValues merges the subtype's extended attributes and contentDAO's status values, and a field the
// instance does not hold may name an extended attribute; the read path loads neither, so such a response would differ.
/** Throws the legacy 503 for a selected field the view cannot answer as legacy does. */
function assertServable(scope: ContentScope, view: ApiEntityView, opts: FilteredValuesOptions, foreignSite: boolean): void {
  const { fields, allFields } = selectFields(view, scope.apiContext, opts);
  if (allFields) throw unavailable('Every value of a content bean merges its extended attributes and status', 'content-all-values');
  for (const field of fields) {
    const lower = field.toLowerCase();
    if (lower === 'extendeddata' || lower === 'displayinterval') {
      throw unavailable(`The ${field} field reads a content bean object`, `content-field-${lower}`);
    }
    if (foreignSite && SITE_URL_FIELDS.has(lower)) {
      throw unavailable(`The ${field} field of another content-pool site needs that site's URL settings`, 'content-pool-site-urls');
    }
    const property = cfListToArray(field, '.').at(-1) ?? '';
    if (!COMPUTED_FIELDS.has(field) && !OVERWRITTEN_FIELDS.has(lower) && heldValue(view, property) === undefined) {
      throw unavailable(`The ${field} field may name an extended attribute`, 'content-extended-attribute');
    }
  }
}

/** getFilteredValues of one view, under the scope's AllowAction and expansion resolver. */
async function serializeView(scope: ContentScope, view: ApiEntityView, opts: FilteredValuesOptions): Promise<Struct> {
  assertServable(scope, view, opts, false);
  return serializeContentEntity(view, scope.apiContext, scope.resolver, opts);
}

/** A contentManager.read result as the serializers read it: the stored version, else the new bean of its site. */
function legacyBeanOf(scope: ContentScope, read: ContentBean): LegacyContentBean {
  const { ctx, reader } = scope;
  const now = ctx.domain.clock.now();
  return read.isNew === 0 ? LegacyContentBean.fromVersion(read.version, reader, now) : LegacyContentBean.notFound(reader, now, read.values.siteid);
}

/** contentManager.read of `ref` in the request tenant: the stored version, else the new bean. */
async function loadBean(scope: ContentScope, ref: Omit<ContentRef, 'siteId'> & { siteId?: string }): Promise<LegacyContentBean> {
  return legacyBeanOf(scope, await readContent(scope.ctx.domain, scope.reader, { ...ref, siteId: ref.siteId ?? scope.call.siteId }));
}

/** The tenant of a content-pool site, from the registry; the request site is the request tenant. */
async function tenantOfSite(scope: ContentScope, siteId: string): Promise<string> {
  if (sameSite(siteId, scope.call.siteId)) return scope.call.tenantId;
  const site = (await scope.poolSites()).find((candidate) => sameSite(candidate.siteId, siteId));
  if (site === undefined) throw new Error(`Site ${siteId} is not a registered site of the content pool of tenant ${scope.call.tenantId}`);
  return site.tenantId;
}

/** contentNavBean.getContentBean's read (contentNavBean.cfc:168-188): the row's version, else the active version of its contentid. */
function navRef(row: NavRow, siteId: string): Omit<ContentRef, 'siteId'> & { siteId: string } {
  const contentHistId = getNoCase(row, 'contenthistid');
  if (contentHistId !== undefined) return { siteId, contentHistId: cfText(contentHistId) };
  return { siteId, contentId: cfText(getNoCase(row, 'contentid')) };
}

/** Whether every column of `row` is '', as queryRowToStruct reads a row at or before index 0. */
function isBlankRow(row: NavRow): boolean {
  return Object.values(row).every((value) => value === '');
}

/** A NavRow with the version it proxies and the tenant of its site, which that version is read in. */
interface NavRead extends ContentVersionRef {
  row: NavRow;
  tenantId: string;
}

/** The bean of each read, in order: one readContentVersions per site tenant, under that tenant's reader. */
async function navBeans(scope: ContentScope, reads: readonly NavRead[]): Promise<LegacyContentBean[]> {
  const { ctx, reader } = scope;
  const groups = new Map<string, NavRead[]>();
  for (const read of reads) {
    const group = groups.get(read.tenantId);
    if (group === undefined) groups.set(read.tenantId, [read]);
    else group.push(read);
  }
  const loaded = new Map<NavRead, ContentBean>();
  for (const [tenantId, group] of groups) {
    throwIfRequestAborted();
    const actor = tenantId === reader.tenantId ? reader : { ...reader, tenantId };
    const beans = await readContentVersions(ctx.domain, actor, group);
    group.forEach((read, at) => loaded.set(read, beans[at] as ContentBean));
  }
  return reads.map((read) => legacyBeanOf(scope, loaded.get(read) as ContentBean));
}

/** One row of navViews: a blank row, a bean read already, or a version read batched by navBeans. */
type NavSlot = { kind: 'blank'; row: NavRow } | { kind: 'bean'; row: NavRow; tenantId: string; bean: LegacyContentBean } | { kind: 'read'; read: NavRead };

/**
 * contentNavBean views of `rows`, each with the full version it proxies read in its site's tenant; a blank row, or one
 * at a position of `misses`, proxies contentDAO's new bean. Throws the error of the first failing row.
 */
async function navViews(scope: ContentScope, rows: readonly NavRow[], opts: FilteredValuesOptions, misses: ReadonlySet<number> = new Set()): Promise<ApiEntityView[]> {
  const { ctx, reader } = scope;
  const slots: NavSlot[] = [];
  let failure: { error: unknown } | undefined;
  for (const [position, row] of rows.entries()) {
    try {
      if (isBlankRow(row)) {
        slots.push({ kind: 'blank', row });
        continue;
      }
      const siteId = cfText(getNoCase(row, 'siteid'));
      const tenantId = await tenantOfSite(scope, siteId);
      const ref = navRef(row, siteId);
      if (misses.has(position)) {
        slots.push({ kind: 'bean', row, tenantId, bean: LegacyContentBean.notFound(reader, ctx.domain.clock.now(), siteId) });
      } else if (ref.contentHistId === undefined) {
        const actor = tenantId === reader.tenantId ? reader : { ...reader, tenantId };
        slots.push({ kind: 'bean', row, tenantId, bean: legacyBeanOf(scope, await readContent(ctx.domain, actor, ref)) });
      } else {
        slots.push({ kind: 'read', read: { row, siteId, tenantId, contentHistId: ref.contentHistId } });
      }
    } catch (error) {
      failure = { error };
      break;
    }
  }
  const reads = slots.flatMap((slot) => (slot.kind === 'read' ? [slot.read] : []));
  const beans = await navBeans(scope, reads);
  const beanOf = new Map(reads.map((read, at) => [read, beans[at] as LegacyContentBean]));
  const views = slots.map((slot) => {
    if (slot.kind === 'blank') {
      // No version has the blank ids, so contentDAO answers a new bean of site '' (contentDAO.cfc:177-181), whose URLs
      // getSite('') builds with the `default` site's settings (settingsManager.cfc:537-541).
      const site = scope.call.defaultSiteUrls;
      const view = contentView(scope, LegacyContentBean.notFound(reader, ctx.domain.clock.now(), ''), 'contentnav', slot.row, site);
      assertServable(scope, view, opts, site === undefined);
      return view;
    }
    const [row, tenantId, bean] = slot.kind === 'read' ? [slot.read.row, slot.read.tenantId, beanOf.get(slot.read) as LegacyContentBean] : [slot.row, slot.tenantId, slot.bean];
    const view = contentView(scope, bean, 'contentnav', row);
    assertServable(scope, view, opts, tenantId !== scope.call.tenantId);
    return view;
  });
  if (failure !== undefined) throw failure.error;
  return views;
}

/** contentNavBean views of `rows` (feed rows or crumbs) for callers that serialize content lists themselves. */
export function contentNavViews(ctx: Ctx, call: JsonApiCall, rows: readonly NavRow[], opts: ExpansionOptions, misses?: ReadonlySet<number>): Promise<ApiEntityView[]> {
  return navViews(scopeOf(ctx, call), rows, { expanded: opts.expanded, expandLinks: opts.expand }, misses);
}

// ---- AllowAction and the expansion resolver ----

/** The request `type` AllowAction sets on a content bean (Form, Component or Variation), else the bean's own. */
function actionType(call: JsonApiCall, beanType: string): string {
  const requested = call.params.string('type');
  return TYPE_OVERRIDES.has(requested.toLowerCase()) ? requested : beanType;
}

/** AllowAction's content branch (jsonApiUtility.cfc:1748-1799) for a bean's values; the domain's crumb walk stands in for loadBy(contentID). */
async function contentActionAllowed(scope: ContentScope, value: (key: string) => unknown): Promise<boolean> {
  const text = (key: string): string => cfText(value(key));
  const verdict = await allowContentAction(scope.ctx.domain, scope.reader, {
    type: actionType(scope.call, text('type')),
    contentId: text('contentid'),
    siteId: text('siteid'),
    parentId: text('parentid'),
  });
  return verdict.allowed;
}

/** The scope of one handler call. */
function scopeOf(ctx: Ctx, call: JsonApiCall): ContentScope {
  let poolSites: Promise<readonly PoolSite[]> | undefined;
  const related = relatedResolver(call);
  const scope: ContentScope = {
    ctx,
    call,
    reader: readerOf(call),
    apiContext: { ...call.apiContext, allowAction: (view) => contentActionAllowed(scope, (key) => heldValue(view, key)) },
    resolver: {
      hasMany: (prop, params, opts) => (cfEq(prop.cfc, ENTITY) ? expandedQuery(scope, params, opts) : related.hasMany(prop, params, opts)),
      hasOne: (prop, id, opts) => (cfEq(prop.cfc, ENTITY) ? contentData(scope, cfText(id), opts) : related.hasOne(prop, id, opts)),
      crumbs: (view) => crumbSource(scope, view),
      relatedContent: related.relatedContent,
    },
    poolSites: () => (poolSites ??= contentPoolSites(ctx.domain.db, call.tenantId)),
  };
  return scope;
}

/** The expansion resolver of content relations: kids and parent through the content finders, crumbs through getCrumbList, the others through their entities. */
export function contentExpansionResolver(ctx: Ctx, call: JsonApiCall): ExpansionResolver {
  return scopeOf(ctx, call).resolver;
}

/** getCrumbIterator of a content view, for callers outside this module. */
export function contentCrumbSource(ctx: Ctx, call: JsonApiCall, view: ApiEntityView): Promise<EntityCollectionSource> {
  return crumbSource(scopeOf(ctx, call), view);
}

/** getCrumbIterator (contentBean.cfc:1278-1283) of a view: its crumbs, node to root, as one iterator page. */
async function crumbSource(scope: ContentScope, view: ApiEntityView): Promise<EntityCollectionSource> {
  throwIfRequestAborted();
  const text = (key: string): string => cfText(heldValue(view, key));
  const crumbs = await getCrumbList(scope.ctx.domain, scope.reader, { contentId: text('contentid'), siteId: text('siteid'), path: text('path') });
  const rows = crumbs.map((crumb): NavRow => Object.fromEntries(Object.entries(crumb)));
  // findCrumbArray serializes the crumbs one level down and without an expand list.
  const items = await navViews(scope, rows, { expanded: 1, expandLinks: '' });
  return { items, page: iteratorPage({ recordCount: items.length, maxRecordsPerPage: items.length, entityName: ENTITY }) };
}

// ---- reads ----

/** findOne's load (2340-2346): the event's `contenthistid`, else its `contentid`, else the id it was called with. */
function findOneRef(call: JsonApiCall, id: string): Omit<ContentRef, 'siteId'> {
  const contentHistId = call.params.string('contenthistid');
  if (contentHistId !== '') return { contentHistId };
  const contentId = call.params.string('contentid');
  return { contentId: contentId !== '' ? contentId : id };
}

/** findOne (2292-2384) without render: the loaded bean, or legacy's new bean, under the `content` config with the editable check. */
async function contentData(scope: ContentScope, id: string, opts: ExpansionOptions): Promise<Struct> {
  const { call } = scope;
  throwIfRequestAborted();
  paramUrl(call.apiContext, 'entityname', ENTITY);
  assertNoHumanCheck(call);
  const bean = await loadBean(scope, findOneRef(call, id));
  if (!entityAccessAllowed(call.actor, CONTENT)) throw new LegacyApiError('authorization');
  return serializeView(scope, contentView(scope, bean, ENTITY), { expanded: opts.expanded, expandLinks: opts.expand, pk: PK, editableCheck: true });
}

/** The findQuery request of the call over `params`, paged by the URL scope and permission-filtered as the site's extranet setting asks. */
function queryRequest(scope: ContentScope, params: Readonly<Struct>, queryString: string, event: Readonly<Struct>, expanded?: number): ContentQueryRequest {
  const { call } = scope;
  return {
    siteId: call.siteId,
    params,
    queryString,
    event,
    url: call.apiContext.url,
    extranet: extranetOf(call),
    ...(expanded === undefined ? {} : { expanded }),
  };
}

/** findContentQuery for the scope's reader; a feed step this service does not reproduce answers the legacy 503. */
async function contentQuery(scope: ContentScope, request: ContentQueryRequest): Promise<ContentQueryResult> {
  try {
    return await findContentQuery(scope.ctx.domain, scope.reader, request);
  } catch (err) {
    if (err instanceof FeedContentUnsupportedError) throw unavailable(err.message, 'feed-content-unsupported');
    throw err;
  }
}

/** findQuery's base URL (2795): the endpoint's `content` collection with the query the filters were built from. */
function queryBaseUrl(call: JsonApiCall, baseQuery: string): string {
  return `${call.apiContext.endpoint}/${ENTITY}/?${baseQuery}`;
}

/** `{count}`, or packageIteratorArray (287-366) of the page's items; `arrange` orders the serialized items. */
async function collectionData(
  scope: ContentScope,
  result: ContentQueryResult,
  method: string,
  opts: ExpansionOptions & { baseUrl?: string },
  arrange: (items: Struct[]) => Struct[] = (items) => items,
): Promise<Struct> {
  if ('count' in result) return { count: result.count };
  const views = await navViews(scope, result.rows, { expanded: opts.expanded, expandLinks: opts.expand }, result.misses);
  const items = await serializeEntityList(views, scope.apiContext, { entityName: ENTITY, expand: opts.expand, expanded: opts.expanded }, scope.resolver);
  const page = iteratorPage({
    recordCount: result.paging.recordCount,
    maxRecordsPerPage: result.paging.nextN,
    pageIndex: result.paging.pageIndex,
    entityName: ENTITY,
  });
  return serializeCollection(arrange(items), page, scope.apiContext, {
    method,
    expanded: opts.expanded,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
  });
}

/** expandEntity's content `kids` (2432-2468): findQuery's expanded branch, every non-excluded param filtering by equality. */
async function expandedQuery(scope: ContentScope, params: Struct, opts: ExpansionOptions): Promise<Struct> {
  const { call } = scope;
  throwIfRequestAborted();
  paramUrl(call.apiContext, 'entityname', ENTITY);
  const result = await contentQuery(scope, queryRequest(scope, params, call.query.raw, eventValues(call), opts.expanded));
  const baseUrl = 'count' in result ? undefined : queryBaseUrl(call, result.baseQuery);
  return collectionData(scope, result, 'findQuery', { ...opts, ...(baseUrl === undefined ? {} : { baseUrl }) });
}

/** The exceptions-list entry of findOne's render branch, which only the CFML theme runtime answers. */
export const CONTENT_RENDER_EXCEPTION = 'EX-CONTENT-RENDER';

// Fail closed: legacy answers every render request, an unknown filename's 404 page data included, from the CFML theme
// runtime (renderFilename, the JSON translator's displayRegions, template and dspBody), which the target cannot reproduce.
/** findOne's render branch (2302-2331): the legacy 503 for every request. */
function renderContent(): never {
  throw unavailable(`The rendered content response runs the CFML theme renderer (${CONTENT_RENDER_EXCEPTION})`, 'cfml-render');
}

/** findMany's `ids` as legacy lists them. */
function idsOf(call: JsonApiCall): string[] {
  return call.ids ?? cfListToArray(call.params.string('ids'));
}

/** `items` in the order of `ids`, each id's first match, as findMany arranges them without a `sort` (2694-2705). */
function inIdOrder(ids: readonly string[]): (items: Struct[]) => Struct[] {
  return (items) =>
    ids.flatMap((id): Struct[] => {
      const item = items.find((candidate) => cfEq(cfText(getNoCase(candidate, 'id')), id));
      return item === undefined ? [] : [item];
    });
}

/** A copy of `record` without `name` in any case. */
function without(record: Readonly<Struct>, name: string): Struct {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !cfEq(key, name)));
}

/** findOne (2292-2384): the content `contenthistid`, `contentid` or the id names, or legacy's new bean, answered 200 either way. */
const findOne: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  const scope = scopeOf(ctx, call);
  if (call.render !== undefined) return renderContent();
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  return jsonApiResultOf(await contentData(scope, call.id ?? '', finderOf(call)), ENTITY);
};

/** findMany (2627-2709): the content or `feedid` feed restricted to the ids, in `ids` order unless `sort` is set. */
const findMany: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const scope = scopeOf(ctx, call);
  const ids = idsOf(call);
  // `contentid in ids` stated in findQuery's `in^` criteria syntax builds legacy's addParam; findMany never answers
  // countOnly, and only `feedid` (never `feedname`) names its feed.
  const params = without(call.apiContext.url, 'countOnly');
  setNoCase(params, PK, `in^${ids.join(',')}`);
  const feedId = call.params.string('feedid');
  const result = await contentQuery(scope, queryRequest(scope, params, PK, feedId === '' ? {} : { feedid: feedId }));
  const sorted = cfText(urlParam(call.apiContext, 'sort')) !== '';
  const data = await collectionData(scope, result, 'findmany', { expand: expandOf(call), expanded: 0 }, sorted ? undefined : inIdOrder(ids));
  return jsonApiResultOf(data, ENTITY);
};

/** findAll (2542-2625): the content feed under the URL feed props only, or its `countOnly` count. */
const findAll: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const scope = scopeOf(ctx, call);
  const result = await contentQuery(scope, queryRequest(scope, call.apiContext.url, '', {}));
  return jsonApiResultOf(await collectionData(scope, result, 'findall', { expand: expandOf(call), expanded: 0 }), ENTITY);
};

/** findQuery (2711-2918): the content feed (or the `feedid`/`feedname` feed) filtered by the query string or a related caller's params, or its count. */
const findQuery: JsonApiHandlerFn = async (ctx, call) => {
  paramUrl(call.apiContext, 'entityname', call.entityName);
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const scope = scopeOf(ctx, call);
  const opts = finderOf(call);
  const request = queryRequest(scope, finderParamsOf(call), call.query.raw, eventValues(call), opts.expanded > 0 ? opts.expanded : undefined);
  const result = await contentQuery(scope, request);
  const baseUrl = 'count' in result ? undefined : queryBaseUrl(call, result.baseQuery);
  const data = await collectionData(scope, result, 'findQuery', { ...opts, ...(baseUrl === undefined ? {} : { baseUrl }) });
  return jsonApiResultOf(data, ENTITY);
};

/** findNew (2386-2422): loadBy a fresh contentid leaves legacy's new bean of the site, serialized expanded with the editable check. */
const findNew: JsonApiHandlerFn = async (ctx, call) => {
  const scope = scopeOf(ctx, call);
  assertNoHumanCheck(call);
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const bean = LegacyContentBean.notFound(scope.reader, ctx.domain.clock.now(), call.siteId);
  const data = await serializeView(scope, contentView(scope, bean, ENTITY), { expanded: true, expandLinks: expandOf(call), pk: PK, editableCheck: true });
  return jsonApiResultOf(data, ENTITY);
};

/** findProperties (1548-1618) from the registration. */
const findProperties: JsonApiHandlerFn = async (_ctx, call) => jsonApiResultOf(findPropertiesFor(CONTENT, call), ENTITY);

/** loadBy(contentid=id) of a relation path's source: the stored version, else the new bean, whose ids its getters create. */
async function loadBy(ctx: Ctx, call: JsonApiCall, key: RelationSourceKey): Promise<SourceBeanGetter> {
  const bean = await loadBean(scopeOf(ctx, call), { contentId: 'contentid' in key ? key.contentid : key.primaryKey });
  return (name) => bean.get(cfEq(name, 'primaryKey') ? PK : name);
}

/** findPermissions (2240-2266): bean.getPermissions of the content a CF UUID or 35-character id loads; a bean without a site gets none. */
const findPermissions: JsonApiHandlerFn = async (ctx, call) => {
  const id = call.id ?? '';
  if (!(isCfUuid(id) || id.length === 35)) return jsonApiResultOf(permissionsOf({ hasSiteId: false, readAllowed: true, actionAllowed: false }), ENTITY);
  const scope = scopeOf(ctx, call);
  const bean = await loadBean(scope, { contentId: id });
  const actionAllowed = await contentActionAllowed(scope, (key) => bean.get(key));
  return jsonApiResultOf(permissionsOf({ hasSiteId: bean.text('siteid') !== '', readAllowed: true, actionAllowed }), ENTITY);
};

// ---- writes ----

/** delete (3259-3335) in legacy's order (load, exists, AllowAction, CSRF, delete); answers ''. */
const remove: JsonApiHandlerFn = async (ctx, call) => {
  // Legacy's component-scope `pk` (3287-3289) is process history a stateless service does not keep, so a CF-UUID
  // `contentid` delete without `contenthistid` fails as it does on a freshly started legacy application.
  await deleteContentEntity(writeDeps(ctx), readerOf(call), call.site, { event: eventValues(call), validateCsrf: () => call.validateCsrf() });
  return jsonApiResultOf('', ENTITY);
};

/** The JSON API `content` entity, also serving `contentnav`: public reads, writes under the type's module and node verdict. */
export const contentHandler: EntityHandler = Object.freeze({
  entity: ENTITY,
  config: CONTENT,
  validate,
  findOne,
  findMany,
  findAll,
  findNew,
  findQuery,
  findProperties,
  findPermissions,
  delete: remove,
  loadBy,
});
