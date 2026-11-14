/** JSON API public methods strategies-content carries (core/mura/client/api/json/v1/jsonApiUtility.cfc:34, 856-898, 1005-1066). */
import {
  adminUrl,
  cfDateFormat,
  cfEq,
  cfHour,
  cfIsBoolean,
  cfIsDateText,
  cfIsNumeric,
  cfListToArray,
  cfNumberString,
  cfParseDateTimeText,
  cfQueryColumnOrder,
  cfToBoolean,
  cfToNumber,
  isCfUuid,
  javaTrim,
  legacyQuery,
  LegacyApiError,
  LegacyJsonSerializer,
  LegacyServiceUnavailableError,
} from '@opt2/platform/legacy-compat';
import { categoryCrumbs, newCategoryBean, readCategory } from '../../domain/categories.js';
import { getCrumbList, getHistory, readContent, type ContentBean } from '../../domain/content-tree.js';
import type { Actor, SiteContentSettings } from '../../domain/context.js';
import { FeedBean, FeedContentUnsupportedError, feedContent } from '../../domain/feeds.js';
import { submitForm as undefinedSubmitForm } from '../../domain/forms.js';
import { allowContentAction, getNodePerm, setRestriction } from '../../domain/permissions.js';
import { contentPoolSites, readAcrossContentPool, withPoolTenant, type PoolSite } from '../../domain/pools.js';
import { contentUrl, imageUrl } from '../../legacy/content-urls.js';
import { CONTENT_ENTITIES, getContentEntityConfig } from '../../legacy/jsonapi-entities.js';
import {
  iteratorPage,
  serializeCrumbs,
  serializeRelatedContent,
  serializeVersionHistory,
  urlParam,
  type ApiEntityView,
  type CollectionPage,
  type EntityCollectionSource,
  type ExpansionResolver,
  type JsonApiRequestContext,
  type RelatedContentSetSource,
} from '../../legacy/jsonapi-serializers.js';
import type { ContentRepository } from '../../repo/repository.js';
import { contentExpansionResolver, contentNavViews } from './content.js';
import {
  authorizationDenied,
  entityAccessAllowed,
  jsonApiResultOf,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
  type MethodHandler,
} from './types.js';

type Ctx = Parameters<JsonApiHandlerFn>[0];
type Struct = Record<string, unknown>;
/** A query row a contentNavBean, categoryBean or comment bean is built from. */
type Row = Readonly<Struct>;
type ContentQueries = ContentRepository['content'];
type RelatedContentArgs = Parameters<ContentQueries['relatedContent']>[1];
type RelatedContentRow = Awaited<ReturnType<ContentQueries['relatedContent']>>[number];
type RcSetRow = Awaited<ReturnType<ContentRepository['extend']['rcsetsForSubtype']>>[number];
type FeedRow = Awaited<ReturnType<typeof feedContent>>[number];
/** The getRelatedContentIterator arguments findRelatedContent passes (jsonApiUtility.cfc:3489-3511). */
type RelatedIteratorArgs = Pick<RelatedContentArgs, 'sortBy' | 'sortDirection' | 'name' | 'reverse' | 'relatedContentSetId'>;
/** A content version a related-content read starts from. */
type StoredVersion = Extract<ContentBean, { isNew: 0 }>['version'];

const CONTENT = CONTENT_ENTITIES.content;
const CATEGORY = CONTENT_ENTITIES.category;
/** categoryBean getPrimaryKey(), as getLinks and translatePropKey read it. */
const CATEGORY_BEAN_PK = 'categoryID';
/** The id extendSubType gives the `Default` related-content set (extendSubType.cfc:574-576). */
const DEFAULT_SET_ID = '00000000000000000000000000000000000';
/** Types whose related-content sets inherit no `Base` sets (extendSubType.cfc:550). */
const NO_BASE_EXTEND_TYPES: ReadonlySet<string> = new Set(['1', '2', 'user', 'group', 'address', 'site', 'component', 'form']);
/** The types AllowAction takes from the request `type` instead of the bean (jsonApiUtility.cfc:1748-1750). */
const ACTION_TYPE_OVERRIDES: ReadonlySet<string> = new Set(['form', 'component', 'variation']);
/** getCalendarItems' empty result, `QueryNew('url,contentid,menutitle,displaystart,displaystop')`. */
const EMPTY_CALENDAR_COLUMNS: readonly string[] = ['url', 'contentid', 'menutitle', 'displaystart', 'displaystop'];
/** filterCalendarItems' maxRows for `maxItems = 0` (contentCalendarUtilityBean.cfc:206). */
const CALENDAR_MAX_ROWS = 100_000;

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

/** SQL Server's id, name and site equality: case-insensitive, trailing spaces ignored. */
function sqlKey(value: string | null | undefined): string {
  return (value ?? '').trimEnd().toLowerCase();
}

/** The acting user with the call's verified tenant and site, which the reads run in (anonymous actors carry neither). */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** The method's `id` argument: the resolved id, else the merged `id` param. */
function idOf(call: JsonApiCall): string {
  return call.id ?? call.params.string('id');
}

/** The request's `expand` list. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** The legacy 503 for a result whose rows need a legacy step this service does not reproduce. */
function unavailable(message: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', reason);
}

/** A query row as a plain struct. */
function rowOf(row: object): Row {
  return Object.fromEntries(Object.entries(row));
}

/** processRequest's URL-scope writes for a path-route method (jsonApiUtility.cfc:1012-1059); a method called by name makes none. */
function applyPathRouteUrl(call: JsonApiCall, route: 'crumbs' | 'history' | 'relatedcontent', entityName: string): void {
  const segment = call.pathInfo[3];
  if (segment === undefined || !cfEq(segment, route) || call.pathInfo[2] !== call.id) return;
  const { url } = call.apiContext;
  setNoCase(url, 'id', call.id);
  if (route !== 'history') setNoCase(url, 'siteid', call.apiContext.siteId);
  setNoCase(url, 'entityname', entityName);
}

/** The value getValue answers for `name` on `view`: its getter, else its stored value. */
function heldValue(view: ApiEntityView, name: string): unknown {
  const getter = view.values === undefined ? undefined : getNoCase(view.values, name);
  return getter !== undefined ? getter : getNoCase(view.allValues, name);
}

/** The serializers' request context, with AllowAction's content branch (jsonApiUtility.cfc:1748-1799) judging content views. */
function contentApiContext(ctx: Ctx, call: JsonApiCall): JsonApiRequestContext {
  const reader = readerOf(call);
  const requested = call.params.string('type');
  return {
    ...call.apiContext,
    allowAction: async (view) => {
      const value = (key: string): string => cfText(heldValue(view, key));
      const type = ACTION_TYPE_OVERRIDES.has(requested.toLowerCase()) ? requested : value('type');
      const verdict = await allowContentAction(ctx.domain, reader, {
        type,
        contentId: value('contentid'),
        siteId: value('siteid'),
        parentId: value('parentid'),
      });
      return verdict.allowed;
    },
  };
}

/** An iterator holding every one of `items` on one page, as setArray and an unpaged setQuery leave it. */
function onePage<T>(items: readonly T[], entityName: string): { items: readonly T[]; page: CollectionPage } {
  return { items, page: iteratorPage({ recordCount: items.length, maxRecordsPerPage: items.length, entityName }) };
}

/** The page setIteratorProps (jsonApiUtility.cfc:3160-3183) selects from a queryIterator over `rows` set without a page size. */
function urlPageOf<R>(rows: readonly R[], ctx: JsonApiRequestContext, entityName: string): { items: R[]; page: CollectionPage } {
  const recordCount = rows.length;
  const nextN = (n: unknown): number => (cfIsNumeric(n) && cfToNumber(n) !== 0 ? cfToNumber(n) : recordCount);
  let perPage = recordCount;
  let pageIndex = 1;
  let recordIndex = 0;
  const setPageIndex = (n: number): void => {
    pageIndex = n;
    recordIndex = (n - 1) * perPage;
    if (recordIndex > recordCount) {
      recordIndex = 0;
      pageIndex = 1;
    }
  };
  const itemsPerPage = urlParam(ctx, 'itemsPerPage');
  if (cfIsNumeric(itemsPerPage)) perPage = nextN(itemsPerPage);
  else if (itemsPerPage !== undefined && cfText(itemsPerPage) === '*') perPage = recordCount;
  const pageParam = urlParam(ctx, 'pageIndex');
  if (cfIsNumeric(pageParam)) setPageIndex(cfToNumber(pageParam));
  const startParam = urlParam(ctx, 'startIndex');
  if (cfIsNumeric(startParam)) {
    const startRow = cfToNumber(startParam);
    if (recordCount > 0) {
      setPageIndex(perPage !== 1 ? Math.ceil(startRow / perPage) : startRow);
      const queued = startRow === 0 ? 0 : startRow - 1;
      if (recordIndex !== queued && queued < recordCount) recordIndex = queued;
    } else {
      recordIndex = 0;
      setPageIndex(1);
    }
  }
  // setIteratorProps calls setMaxItems on a `feed` it never defines, so a numeric offset fails the request.
  if (cfIsNumeric(urlParam(ctx, 'offset'))) throw new LegacyApiError('server_error');
  const end = Math.min(recordCount, pageIndex * perPage);
  if (recordIndex < 0 && recordIndex < end) throw new LegacyApiError('server_error');
  return { items: rows.slice(recordIndex, end), page: iteratorPage({ recordCount, maxRecordsPerPage: perPage, pageIndex, entityName }) };
}

// ---- findCrumbArray ----

/** The expansion resolver of category crumbs; their relations are served by the category finders. */
function categoryCrumbRelations(): ExpansionResolver {
  const reject = (name: string): Promise<never> =>
    Promise.reject(unavailable(`The ${name} relation of a category crumb is served by the category finders`, `category-crumbs-expand-${name.toLowerCase()}`));
  return {
    hasMany: (prop) => reject(prop.name),
    hasOne: (prop) => reject(prop.name),
    crumbs: () => reject('crumbs'),
    relatedContent: () => reject('relatedcontent'),
  };
}

/** The crumbs getCrumbArray reads for `bean` (contentBean.cfc:1270-1275); a new bean walks from its empty parent id, which has none. */
async function beanCrumbs(ctx: Ctx, reader: Actor, bean: ContentBean): Promise<Awaited<ReturnType<typeof getCrumbList>>> {
  if (bean.isNew === 1) return [];
  const { contentid, siteid, path } = bean.version;
  return getCrumbList(ctx.domain, reader, { contentId: contentid ?? '', siteId: siteid ?? '', path: path ?? '' });
}

/** A content item's getCrumbIterator, node to root, as contentnav items. */
async function contentCrumbs(ctx: Ctx, call: JsonApiCall, id: string): Promise<JsonApiResult> {
  const reader = readerOf(call);
  const crumbs = await beanCrumbs(ctx, reader, await readContent(ctx.domain, reader, { contentId: id, siteId: call.siteId }));
  const expand = expandOf(call);
  const views = await contentNavViews(ctx, call, crumbs.map(rowOf), { expand, expanded: 0 });
  const opts = { entityName: 'content', expand, expanded: 0 };
  const data = await serializeCrumbs(onePage(views, 'content'), contentApiContext(ctx, call), opts, contentExpansionResolver(ctx, call));
  return jsonApiResultOf(data, 'content');
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

/** categoryBean.getCrumbIterator (categoryBean.cfc:244-253): the pool categories its path names, by depth, as a `categoryBean` iterator. */
async function categoryCrumbsOf(ctx: Ctx, call: JsonApiCall, id: string): Promise<JsonApiResult> {
  const reader = readerOf(call);
  const { urlTitleDelim, allowUnicodeInFilenames } = call.site.urls;
  const category = await readCategory(ctx.domain, reader, id, { filenameRules: { urlTitleDelim, allowUnicodeInFilenames } });
  const rows = await categoryCrumbs(ctx.domain, reader, { path: category.path, sort: 'asc' });
  const views = rows.map((row) => {
    // beanIterator.packageRecord: `getBean('categoryBean').set(row).setIsNew(0)`, NULL cells as ''.
    const values: Struct = { ...newCategoryBean(ctx.domain.clock) };
    for (const [column, value] of Object.entries(row)) values[column] = value ?? '';
    values['isnew'] = 0;
    return categoryView(values, call);
  });
  const opts = { entityName: CATEGORY.name, expand: expandOf(call), expanded: 0 };
  const data = await serializeCrumbs(onePage(views, 'categoryBean'), call.apiContext, opts, categoryCrumbRelations());
  return jsonApiResultOf(data, CATEGORY.name);
}

/** findCrumbArray (jsonApiUtility.cfc:3185-3233): the crumbs of a content item, category or comment as a collection. */
const findCrumbArray: MethodHandler = async (ctx, call) => {
  const named = call.entityName !== '' ? call.entityName : call.params.string('entityname');
  const entityName = cfEq(named, 'contentnav') ? 'content' : named;
  applyPathRouteUrl(call, 'crumbs', entityName);
  const config = getContentEntityConfig(entityName);
  // `$.getBean` of a name this service holds no bean for fails before any access check.
  if (!('moduleId' in config)) throw new LegacyApiError('server_error');
  if (!entityAccessAllowed(call.actor, config)) return authorizationDenied();
  const id = idOf(call);
  if (cfEq(entityName, 'content')) return contentCrumbs(ctx, call, id);
  if (cfEq(entityName, 'category')) return categoryCrumbsOf(ctx, call, id);
  // contentCommentIterator defines no getEntityName, which packageIteratorArray calls for every iterator
  // (jsonApiUtility.cfc:313, 348), and the other beans define no getCrumbIterator: legacy answers both with a 500.
  throw new LegacyApiError('server_error');
};

// ---- findVersionHistory ----

/** contentBean.getVersionHistoryQuery of the item's active version: every getHist row, newest first. */
async function versionRows(ctx: Ctx, reader: Actor, item: { contentId: string; siteId: string }): Promise<Row[]> {
  const history = await getHistory(ctx.domain, reader, item);
  if (history.historyTotal <= history.items.length || history.contentBean.isNew === 1) return history.items;
  // The history screen's page stops at 1000 versions; the JSON API iterator pages over all of them.
  const { contentid, siteid } = history.contentBean.version;
  return ctx.domain.db.withTenant(reader.tenantId, (tx) => ctx.domain.repository.content.hist(tx, { contentId: contentid ?? '', siteId: siteid ?? '' }));
}

/** findVersionHistory (jsonApiUtility.cfc:3236-3256): a content item's versions for its authors and editors, each self link naming its version. */
const findVersionHistory: MethodHandler = async (ctx, call) => {
  applyPathRouteUrl(call, 'history', 'content');
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const reader = readerOf(call);
  const item = { contentId: idOf(call), siteId: call.siteId };
  const perm = await getNodePerm(ctx.domain, reader, await getCrumbList(ctx.domain, reader, item));
  if (perm !== 'author' && perm !== 'editor') return authorizationDenied();
  const { items, page } = urlPageOf(await versionRows(ctx, reader, item), call.apiContext, 'content');
  const expand = expandOf(call);
  const views = await contentNavViews(ctx, call, items, { expand, expanded: 0 });
  const opts = { expand, expanded: 0 };
  const data = await serializeVersionHistory({ items: views, page }, contentApiContext(ctx, call), opts, contentExpansionResolver(ctx, call));
  return jsonApiResultOf(data, 'content');
};

// ---- findRelatedContent ----

/** A related-content set of a subtype, as extendRelatedContentSetBean holds it. */
interface RelatedSet {
  relatedContentSetId: string;
  name: string;
  /** getEntityType(): the stored type, `content` when none is stored (setEntityType ignores ''). */
  entityType: string;
}

const DEFAULT_SET: Readonly<RelatedSet> = Object.freeze({ relatedContentSetId: DEFAULT_SET_ID, name: 'Default', entityType: 'content' });

/** extendRelatedContentSetBean.set(row). */
function relatedSetOf(row: RcSetRow): RelatedSet {
  return { relatedContentSetId: row.relatedcontentsetid, name: row.name ?? '', entityType: (row.entitytype ?? '') !== '' ? (row.entitytype ?? '') : 'content' };
}

/** extendSubType.getRelatedContentSets(includeInheritedSets=true) (extendSubType.cfc:517-576): ID sets, Default, TYPE then BASE sets. */
function relatedContentSets(ctx: Ctx, call: JsonApiCall, type: string, subType: string): Promise<RelatedSet[]> {
  const { siteId } = call;
  const repo = ctx.domain.repository.extend;
  return ctx.domain.db.withTenant(call.tenantId, async (tx) => {
    const setsOf = async (subtypes: ReadonlyArray<{ subtypeid: string }>): Promise<RelatedSet[]> => {
      const rows: RcSetRow[] = [];
      for (const subtype of subtypes) {
        rows.push(...(await repo.rcsetsForSubtype(tx, { subTypeId: subtype.subtypeid })).filter((row) => sqlKey(row.siteid) === sqlKey(siteId)));
      }
      // One `order by orderNo` across the matched subtypes; the stable sort keeps each subtype's order on ties.
      return rows.sort((a, b) => (a.orderno ?? 0) - (b.orderno ?? 0)).map(relatedSetOf);
    };
    const sets = [...(await setsOf((await repo.subtypes(tx, { siteId, type, subType })).slice(0, 1))), { ...DEFAULT_SET }];
    if (!cfEq(subType, 'Default')) sets.push(...(await setsOf(await repo.subtypes(tx, { siteId, type, subType: 'Default' }))));
    if (!NO_BASE_EXTEND_TYPES.has(type.toLowerCase())) sets.push(...(await setsOf(await repo.subtypes(tx, { siteId, type: 'Base', subType: 'Default' }))));
    return sets;
  });
}

/** getRelatedContentIterator's entity type of a set named by id or name (contentManager.cfc:2259-2270); `content` when none matches. */
async function namedSetEntityType(ctx: Ctx, call: JsonApiCall, set: string): Promise<string> {
  if (set === '' || set === DEFAULT_SET_ID || cfEq(set, 'default')) return 'content';
  const repo = ctx.domain.repository.extend;
  const rows = await ctx.domain.db.withTenant(call.tenantId, async (tx) => {
    const found: RcSetRow[] = [];
    for (const subtype of await repo.subtypes(tx, { siteId: call.siteId })) found.push(...(await repo.rcsetsForSubtype(tx, { subTypeId: subtype.subtypeid })));
    return found;
  });
  const key = isCfUuid(set) ? (row: RcSetRow): string | null => row.relatedcontentsetid : (row: RcSetRow): string | null => row.name;
  const match = rows.find((row) => sqlKey(row.siteid) === sqlKey(call.siteId) && sqlKey(key(row)) === sqlKey(set));
  return match === undefined ? 'content' : relatedSetOf(match).entityType;
}

// Fail closed: a set of another entity type reads that entity's table (contentGateway.getRelatedContent's sample-bean branch).
/** Throws the legacy 503 unless `entityType` is content. */
function assertContentSet(entityType: string): void {
  if (!cfEq(entityType, 'content')) {
    throw unavailable(`A related-content set of ${entityType} beans reads that entity's table`, 'related-content-entity-type');
  }
}

/** The getRelatedContentIterator arguments findRelatedContent takes from its params, the URL scope (jsonApiUtility.cfc:3489-3511). */
function relatedIteratorArgs(call: JsonApiCall): RelatedIteratorArgs {
  const value = (name: string): string => cfText(urlParam(call.apiContext, name));
  const args: RelatedIteratorArgs = {};
  if (value('sortby') !== '') args.sortBy = value('sortby');
  if (value('sortdirection') !== '') args.sortDirection = value('sortdirection');
  if (value('name') !== '') args.name = value('name');
  if (value('reverse') !== '') args.reverse = cfToBoolean(value('reverse'));
  if (value('relatedContentSetID') !== '') args.relatedContentSetId = value('relatedContentSetID');
  return args;
}

/** deserializeInterval's `type` and `repeats` (contentIntervalManager.cfc:165-208). */
function intervalOf(raw: string | null): { type: string; repeats: boolean } {
  const text = raw ?? '';
  let data: Struct = {};
  if (javaTrim(text) !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Struct) : {};
    } catch {
      data = { type: text };
    }
  }
  const type = cfText(getNoCase(data, 'type') ?? 'daily');
  const repeats = getNoCase(data, 'repeats');
  if (repeats !== undefined) return { type, repeats: isTrue(repeats) };
  return { type, repeats: !(cfEq(type, 'daily') && !isTrue(getNoCase(data, 'every') ?? 1)) };
}

/** Whether contentIntervalManager.apply (contentIntervalManager.cfc:313-320) would expand or drop a live related row, which has no parent type. */
function intervalApplies(row: Pick<RelatedContentRow, 'display' | 'displayinterval'>): boolean {
  const interval = intervalOf(row.displayinterval);
  return row.display === 2 && interval.type !== '' && interval.repeats;
}

/** contentGateway.getRelatedContent across the site's content pool, merged in the legacy ORDER BY. */
async function relatedRows(ctx: Ctx, call: JsonApiCall, sites: readonly PoolSite[], args: RelatedContentArgs): Promise<RelatedContentRow[]> {
  const { db } = ctx.domain;
  const repo = ctx.domain.repository.content;
  if (sites.every((site) => site.tenantId === call.tenantId)) return db.withTenant(call.tenantId, (tx) => repo.relatedContent(tx, args));
  const links = args.reverse === true ? undefined : await db.withTenant(call.tenantId, (tx) => repo.relatedLinks(tx, args));
  const candidates = await readAcrossContentPool(db, sites, async (tx) => [await repo.relatedCandidates(tx, links === undefined ? args : { ...args, links })]);
  return db.withTenant(call.tenantId, (tx) => repo.mergeRelatedContent(tx, args, candidates));
}

/** `rows` with the file columns filled in each pool site's file-pool tenant, where the query could not join them (fileid alone). */
async function withPooledFileColumns(ctx: Ctx, sites: readonly PoolSite[], rows: RelatedContentRow[]): Promise<RelatedContentRow[]> {
  const unjoined = (row: RelatedContentRow): boolean => (row.fileid ?? '') !== '' && row.filesize === null && row.fileext === null;
  const filled = new Map<RelatedContentRow, RelatedContentRow>();
  for (const site of sites) {
    const pending = rows.filter((row) => unjoined(row) && sqlKey(row.siteid) === sqlKey(site.siteId));
    const fileIds = [...new Set(pending.map((row) => row.fileid ?? ''))];
    if (fileIds.length === 0) continue;
    const files = await withPoolTenant(ctx.domain.db, site.tenantId, 'file', (tx, poolTenantId) =>
      poolTenantId === site.tenantId ? Promise.resolve([]) : ctx.domain.repository.content.fileJoinColumns(tx, fileIds),
    );
    const byId = new Map(files.map((file) => [file.fileid.toLowerCase(), file]));
    for (const row of pending) {
      const file = byId.get((row.fileid ?? '').toLowerCase());
      if (file !== undefined) filled.set(row, { ...row, filesize: file.filesize, fileext: file.fileext });
    }
  }
  return filled.size === 0 ? rows : rows.map((row) => filled.get(row) ?? row);
}

/** One set's getRelatedContentIterator after setIteratorProps, its page's items as contentnav views. */
async function relatedSource(
  ctx: Ctx,
  call: JsonApiCall,
  item: { version: StoredVersion; sites: readonly PoolSite[] } | null,
  args: RelatedIteratorArgs,
): Promise<EntityCollectionSource> {
  const sites = item?.sites ?? [];
  // A new bean's getContentHistID and getContentID are fresh ids, which no link names.
  const rows =
    item === null
      ? []
      : await relatedRows(ctx, call, sites, {
          ...args,
          siteId: item.version.siteid ?? call.siteId,
          contentHistId: item.version.contenthistid ?? '',
          reverseContentId: item.version.contentid ?? '',
          today: ctx.domain.clock.now(),
          contentPoolSiteIds: sites.map((site) => site.siteId),
        });
  // Fail closed: live rows go through contentIntervalManager.applyByMenuTypeAndDate, which this service does not reproduce.
  if (rows.some(intervalApplies)) {
    throw unavailable('Related content with a repeating display interval needs contentIntervalManager.apply', 'related-content-intervals');
  }
  const { items, page } = urlPageOf(rows, call.apiContext, 'content');
  const views = await contentNavViews(ctx, call, (await withPooledFileColumns(ctx, sites, items)).map(rowOf), { expand: expandOf(call), expanded: 0 });
  return { items: views, page };
}

/** findRelatedContent (jsonApiUtility.cfc:3474-3564): every related-content set for '', `*` or `all`, else one set named by the id. */
const findRelatedContent: MethodHandler = async (ctx, call) => {
  applyPathRouteUrl(call, 'relatedcontent', 'content');
  if (!entityAccessAllowed(call.actor, CONTENT)) return authorizationDenied();
  const bean = await readContent(ctx.domain, readerOf(call), { contentId: idOf(call), siteId: call.siteId });
  const version = bean.isNew === 0 ? bean.version : null;
  const item = version === null ? null : { version, sites: await contentPoolSites(ctx.domain.db, call.tenantId) };
  // The path segment, else the `relatedcontentsetid` param, else globalConfig's `relatedcontentsetid` default `*`.
  const setId = call.relatedContentSetId ?? (call.params.has('relatedcontentsetid') ? call.params.string('relatedcontentsetid') : '*');
  const args = relatedIteratorArgs(call);
  const opts = { expand: expandOf(call), expanded: 0 };
  const apiContext = contentApiContext(ctx, call);
  const resolver = contentExpansionResolver(ctx, call);
  if (setId === '' || setId === '*' || cfEq(setId, 'all')) {
    const sets = await relatedContentSets(ctx, call, version?.type ?? 'Page', version?.subtype ?? 'Default');
    for (const set of sets) assertContentSet(set.entityType);
    const sources: RelatedContentSetSource[] = [];
    for (const set of sets) {
      const source = await relatedSource(ctx, call, item, { ...args, relatedContentSetId: set.relatedContentSetId, name: set.name });
      sources.push({ ...source, name: set.name, entityType: set.entityType, relatedContentSetId: set.relatedContentSetId });
    }
    return jsonApiResultOf(await serializeRelatedContent({ kind: 'sets', sets: sources }, apiContext, opts, resolver), 'content');
  }
  // Only the URL's `relatedContentSetID` filters this branch; the requested id names the result.
  assertContentSet(await namedSetEntityType(ctx, call, args.relatedContentSetId ?? ''));
  const source = await relatedSource(ctx, call, item, args);
  return jsonApiResultOf(await serializeRelatedContent({ kind: 'set', relatedContentSetId: setId, ...source }, apiContext, opts, resolver), 'content');
};

// ---- findCalendarItems ----

/** CFML URLDecode, leaving malformed escapes as they are. */
function urlDecode(value: string): string {
  return value.replaceAll('+', ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** A date argument as `isDate` reads it, parsed; undefined when it is not a date. */
function dateArg(text: string): Date | undefined {
  return cfIsDateText(text) ? cfParseDateTimeText(text) : undefined;
}

/** The local midnight of `date`'s day, which `Fix(date)` and `DateFormat(date, 'yyyy-mm-dd')` keep. */
function dayOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** getCalendarItems' window (contentCalendarUtilityBean.cfc:39-77): `start` defaults to the event's month, `end` to the end of `start`'s. */
function calendarWindow(call: JsonApiCall, now: Date): { from: Date; to: Date } {
  const given = (name: string): string | undefined => {
    const value = call.params.get(name);
    return value === undefined || value === null ? undefined : call.params.string(name);
  };
  const eventStart = `${call.params.string('year')}-${call.params.string('month')}-1`;
  const start = dateArg(given('start') ?? eventStart) ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const end = dateArg(given('end') ?? '');
  const from = dayOf(start);
  const to = end === undefined || dayOf(end) < from ? new Date(start.getFullYear(), start.getMonth() + 1, 0) : dayOf(end);
  return { from, to };
}

/** A query's columns in ACF's `columnList` order, which the serializer writes. */
function columnListOf(columns: readonly string[]): string[] {
  return cfQueryColumnOrder(columns.filter((column) => column !== 'tenant_id')).map((column) => column.name);
}

/** fullCalendarFormat (contentCalendarUtilityBean.cfc:8-36): the items as FullCalendar event JSON. */
function fullCalendarFormat(rows: readonly Row[]): string {
  const serializer = new LegacyJsonSerializer().asString('id').asString('url').asBoolean('allDay').asString('title').asUtcDate('start').asUtcDate('end');
  const events = rows.map((row) => ({
    url: row['url'],
    id: row['contentid'],
    title: row['menutitle'],
    start: row['displaystart'],
    end: row['displaystop'],
    allday: row['allday'],
  }));
  return serializer.serialize(legacyQuery(columnListOf(['url', 'id', 'title', 'start', 'end', 'allday']), events));
}

/** getCalendarItems' allday (contentCalendarUtilityBean.cfc:154-166): 1 at hour 0; `minute(hour(…))` and `!isDate(isDate(…))` always hold. */
function allDayOf(displayStart: unknown): number {
  return displayStart instanceof Date && cfHour(displayStart) === 0 ? 1 : 0;
}

/** filterCalendarItems (contentCalendarUtilityBean.cfc:205-216) with `maxItems = 0`: every row by `displaystart` ascending. */
function filterCalendarItems(rows: readonly Row[]): Row[] {
  const time = (row: Row): number => {
    const value = row['displaystart'];
    return value instanceof Date ? value.getTime() : Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort((a, b) => time(a) - time(b)).slice(0, CALENDAR_MAX_ROWS);
}

/** The calendar feed of getCalendarItems (contentCalendarUtilityBean.cfc:84-131) over the allowed calendar ids. */
function calendarFeed(ctx: Ctx, call: JsonApiCall, calendarIds: readonly string[], window: { from: Date; to: Date }): FeedBean {
  const displayStart = cfDateFormat(window.from, 'yyyy-mm-dd');
  const displayStop = cfDateFormat(window.to, 'yyyy-mm-dd');
  // addParam's defaults: relationship `and`, condition `EQUALS`, datatype '' (feedBean.cfc:531).
  const param = (relationship: string, field = '', condition = 'EQUALS', criteria = ''): Parameters<FeedBean['addParam']>[0] => ({
    relationship,
    field,
    condition,
    criteria,
    datatype: '',
  });
  const feed = FeedBean.init(ctx.domain.clock);
  feed.setValue('maxItems', 0);
  feed.setValue('nextN', 0);
  feed.setValue('siteID', call.siteId);
  feed.setValue('showNavOnly', call.params.get('shownavonly') ?? 0);
  feed.setValue('showExcludeSearch', call.params.get('showexcludesearch') ?? 0);
  feed.addParam(param('AND', 'tcontent.parentid', calendarIds.length > 1 ? 'IN' : 'EQ', calendarIds.join(',')));
  feed.addParam(param('AND', 'tcontent.displaystart', 'LTE', displayStop));
  feed.addParam(param('andOpenGrouping'));
  feed.addParam(param('and', 'tcontent.displaystop', 'GTE', displayStart));
  feed.addParam(param('OR', 'tcontent.displaystop', 'EQUALS', 'null'));
  feed.addParam(param('closeGrouping'));
  const categoryId = call.params.string('categoryid');
  if (categoryId !== '' && isCfUuid(categoryId)) feed.setValue('categoryID', categoryId);
  const tag = call.params.string('tag');
  if (tag !== '') feed.addParam(param('AND', 'tcontenttags.tag', 'CONTAINS', urlDecode(tag)));
  return feed;
}

/** feedBean.getQuery of the calendar feed; a listing feedContent cannot reproduce answers the legacy 503. */
async function calendarRows(ctx: Ctx, reader: Actor, feed: FeedBean, opts: { from: Date; to: Date; applyPermFilter: boolean }): Promise<FeedRow[]> {
  try {
    return await feedContent(ctx.domain, reader, feed, opts);
  } catch (err) {
    if (err instanceof FeedContentUnsupportedError) throw unavailable(err.message, 'feed-content-unsupported');
    throw err;
  }
}

/** findCalendarItems (jsonApiUtility.cfc:1877-1900): the listed calendars' items in the window, as a query or FullCalendar JSON. */
const findCalendarItems: MethodHandler = async (ctx, call) => {
  const calendarId = call.params.string('calendarid');
  if (calendarId === '') return jsonApiResultOf('Please provide a <strong>calendarid</strong>.');
  if (call.siteId === '') return jsonApiResultOf('Please provide a <strong>siteid</strong>.');
  const fullCalendar = cfEq(call.params.string('format'), 'fullcalendar');
  const reader = readerOf(call);
  const site: SiteContentSettings & { extranet?: unknown } = call.site;
  const allowable: string[] = [];
  let applyPermFilter = false;
  for (const id of cfListToArray(calendarId)) {
    const bean = await readContent(ctx.domain, reader, { contentId: id, siteId: call.siteId });
    // `siteConfig('extranet') == 1 && setRestriction(crumbs).restrict`, reassigned per id so the last one decides.
    if (isTrue(site.extranet)) applyPermFilter = (await setRestriction(ctx.domain, reader, await beanCrumbs(ctx, reader, bean))).restrict;
    if (bean.isNew === 0 && cfEq(bean.version.type ?? '', 'Calendar')) allowable.push(id);
  }
  if (allowable.length === 0) {
    // QueryNew without an `allday` column, which fullCalendarFormat's query of queries selects.
    if (fullCalendar) throw new LegacyApiError('server_error');
    return jsonApiResultOf(legacyQuery(columnListOf(EMPTY_CALENDAR_COLUMNS), []), 'content');
  }
  // Fail closed: `returnFormat=iterator` reaches getCalendarItems through argumentCollection and returns a contentIterator,
  // which fullCalendarFormat's `required query` refuses and the API would serialize as a component.
  if (cfEq(call.params.string('returnformat'), 'iterator')) {
    if (fullCalendar) throw new LegacyApiError('server_error');
    throw unavailable('getCalendarItems with returnFormat=iterator returns a CFML iterator', 'calendar-iterator');
  }
  const window = calendarWindow(call, ctx.domain.clock.now());
  const rows = await calendarRows(ctx, reader, calendarFeed(ctx, call, allowable, window), { ...window, applyPermFilter });
  const items = filterCalendarItems(
    rows.map((row) => ({
      ...row,
      url: contentUrl(call.site.urls, { filename: row.filename }, { complete: true }),
      allday: allDayOf(row.displaystart),
    })),
  );
  // A result that is JSON text is returned without the envelope (jsonApiUtility.cfc:891-897).
  if (fullCalendar) return { rawJson: fullCalendarFormat(items) };
  return jsonApiResultOf(legacyQuery(columnListOf(Object.keys(items[0] ?? {})), items), 'content');
};

// ---- getURLForImage ----

/** fileManager.readMeta(fileID).fileEXT, read in the site's file-pool tenant; '' when none. */
async function storedFileExt(ctx: Ctx, call: JsonApiCall, fileId: string): Promise<string> {
  // Legacy reads any site's file by id; tenants come only from the verified token and the registry, so other pools stay unread.
  const meta = await withPoolTenant(ctx.domain.db, call.tenantId, 'file', (tx) => ctx.domain.repository.files.readFileMeta(tx, fileId));
  return meta?.fileext ?? '';
}

/** getURLForImage (jsonApiUtility.cfc:4117-4120, fileManager.cfc:955-1067): `{url}`, '' for no image; `fileExt` and `direct` params apply. */
const getURLForImage: MethodHandler = async (ctx, call) => {
  const given = (name: string): boolean => call.params.get(name) !== undefined && call.params.get(name) !== null;
  const text = (name: string, fallback: string): string => (given(name) ? call.params.string(name) : fallback);
  // A value CFML cannot read as a boolean fails the `type="boolean"` argument or the `cfif` that tests it.
  const flag = (name: string, fallback: boolean): boolean => {
    if (!given(name)) return fallback;
    const value = call.params.get(name);
    if (!cfIsBoolean(value)) throw new LegacyApiError('server_error');
    return cfToBoolean(value);
  };
  const site = call.site.urls;
  let fileId = text('fileid', '');
  let fileExt = text('fileext', '');
  if (fileId === '') {
    fileId = site.placeholderImgId;
    fileExt = site.placeholderImgExt;
  }
  if (fileExt === '' && fileId !== '') fileExt = await storedFileExt(ctx, call, fileId);
  const lookups = call.apiContext.imageLookups;
  const url = imageUrl(site, {
    fileId,
    fileExt,
    fileExtOf: () => '',
    variantExists: lookups?.variantExists,
    customImageSize: lookups?.customImageSize,
    size: text('size', 'small'),
    height: text('height', 'auto'),
    width: text('width', 'auto'),
    direct: flag('direct', site.directImages),
    complete: flag('complete', true),
    secure: flag('secure', false),
    useProtocol: flag('useprotocol', false),
  });
  return jsonApiResultOf({ url }, 'content');
};

// ---- submitForm ----

/** submitForm: listed in publicMethods but defined nowhere, so legacy's invoke fails with the 500 (jsonApiUtility.cfc:34, 889). */
const submitForm: MethodHandler = async () => undefinedSubmitForm();

/** The JSON API methods strategies-content serves, by legacy name. */
export const CONTENT_METHODS: Readonly<Record<string, MethodHandler>> = Object.freeze({
  findCrumbArray,
  findVersionHistory,
  findRelatedContent,
  findCalendarItems,
  getURLForImage,
  submitForm,
});
