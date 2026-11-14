/**
 * JSON API `comment` entity (core/mura/client/api/json/v1/jsonApiUtility.cfc:76-80): the generic finders, save and
 * delete of contentCommentBean (core/mura/content/contentCommentBean.cfc) and its feed, over ../../domain/comments.ts.
 */
import {
  cfEq,
  cfIsBoolean,
  cfNumberString,
  cfToBoolean,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  javaTrim,
  LegacyServiceUnavailableError,
} from '@opt2/platform/legacy-compat';
import {
  deleteComment,
  feedCommentValues,
  findCommentValues,
  getComments,
  saveComment,
  type CommentSaveSite,
  type CommentValuesView,
} from '../../domain/comments.js';
import type { Actor } from '../../domain/context.js';
import { getModulePerm } from '../../domain/permissions.js';
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

type Ctx = Parameters<JsonApiHandlerFn>[0];
type Struct = Record<string, unknown>;
/** One `tcontentcomments` row of the site, as the comment feed selects it. */
type FeedRow = Omit<Awaited<ReturnType<typeof getComments>>[number], 'tenant_id'>;

const config = CONTENT_ENTITIES.comment;
// contentCommentBean.getPrimaryKey(); `config.primaryKey` is the lower-cased form findProperties reports.
const BEAN_PRIMARY_KEY = 'commentID';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
// settingsBean.cfc:141.
const COMMENT_APPROVAL_DEFAULT = 1;
const PUBLIC_QUERY_FIELDS =
  'comments,links,entered,isspam,flagcount,parentid,name,isapproved,kids,isdeleted,userid,subscribe,isnew,contentid,path,siteid,id,remoteid,contenthistid';
const MODULE_QUERY_FIELDS =
  'comments,email,links,entered,isspam,flagcount,parentid,name,isapproved,kids,isdeleted,userid,subscribe,isnew,contentid,path,siteid,id,remoteid,contenthistid';

const FEED_OPTIONS: BeanFeedOptions = {
  primaryKey: BEAN_PRIMARY_KEY,
  // The values a new contentCommentBean holds (contentCommentBean.cfc:100-124, bean.cfc:94-101): valueExists accepts
  // exactly these, so relation names such as `content` are ignored as legacy ignores them.
  propertyNames: [
    'commentID', 'contentID', 'parentID', 'siteID', 'comments', 'url', 'name', 'email', 'entered', 'subscribe',
    'isApproved', 'isSpam', 'isDeleted', 'userID', 'path', 'kids', 'remoteID', 'isNew', 'flagCount', 'errors',
    'fromMuraCache', 'instanceID',
  ],
  // tcontentcomments (mssql.sql:118-130 and the 5.x dbUpdates), checked even when the site has no comments.
  columns: [
    'commentid', 'contentid', 'contenthistid', 'url', 'name', 'comments', 'entered', 'email', 'siteid', 'ip',
    'isapproved', 'subscribe', 'userid', 'parentid', 'path', 'remoteid', 'flagcount', 'isspam', 'isdeleted',
  ],
  defaultSort: { sortBy: 'entered', sortDirection: 'asc' },
  hints: config.hints,
  relations: [...config.hasMany, ...config.hasOne],
  table: 'tcontentcomments',
};

/** Per-call state: the site's comment rows, read at most once, and the resolver of comment relations. */
interface CommentScope {
  readonly ctx: Ctx;
  readonly call: JsonApiCall;
  readonly view: CommentValuesView;
  readonly resolver: ExpansionResolver;
  rows(): Promise<FeedRow[]>;
}

/** The own key equal to `name` ignoring case. */
function keyOf(s: Readonly<Struct>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(s).find((key) => key.toLowerCase() === lower);
}

/** CFML struct write: replaces the key in any case, else adds it. */
function setNoCase(s: Struct, name: string, value: unknown): void {
  s[keyOf(s, name) ?? name] = value;
}

/** CFML `param`: sets the key only when no case of it exists. */
function paramNoCase(s: Struct, name: string, value: unknown): void {
  if (keyOf(s, name) === undefined) s[name] = value;
}

/** The value under `name` ignoring case. */
function getNoCase(s: Readonly<Struct>, name: string): unknown {
  const key = keyOf(s, name);
  return key === undefined ? undefined : s[key];
}

/** The request's `expand` list. */
function expandOf(call: JsonApiCall): string {
  return call.params.string('expand');
}

/** The view getFilteredValues reads for one comment bean's values. */
function commentView(values: Readonly<Struct>): ApiEntityView {
  return {
    entityName: 'comment',
    configName: 'comment',
    primaryKey: BEAN_PRIMARY_KEY,
    allValues: values,
    hasMany: config.hasMany,
    hasOne: config.hasOne,
  };
}

/** contentCommentBean.allowModuleAccess on an API request (765-775): comments and Site Manager module access. */
function allowModuleAccess(actor: Actor): boolean {
  return getModulePerm(actor, config.moduleId) && getModulePerm(actor, SITE_MANAGER_MODULE);
}

/**
 * contentCommentBean.allowQueryParams (748-763) on a feed request's params. Its approval lines name `arguments.param`
 * (sic), so only the spam and deleted flags are ever forced.
 */
function allowQueryParams(params: Struct, actor: Actor): void {
  paramNoCase(params, 'isspam', 0);
  paramNoCase(params, 'isdeleted', 0);
  if (allowModuleAccess(actor)) {
    setNoCase(params, 'fields', MODULE_QUERY_FIELDS);
    return;
  }
  setNoCase(params, 'fields', PUBLIC_QUERY_FIELDS);
  setNoCase(params, 'isspam', 0);
  setNoCase(params, 'isdeleted', 0);
}

/** `url.ishuman` renders the CFML form-protection include into findOne and findNew results (2373-2376, 2416-2419). */
function assertNoHumanCheck(call: JsonApiCall): void {
  if (urlParam(call.apiContext, 'ishuman') !== undefined) {
    throw new LegacyServiceUnavailableError('The ishuman field renders a CFML display object', 'auto', 'cfml-render');
  }
}

// Fail closed: `content` expands through the content entity's findOne and `site` is programs-sites data, neither of
// which a comment call reaches; comment links carry no crumbs and only content expands related content.
/** The legacy 503 for a relation a comment cannot expand here. */
function relationUnavailable(name: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(
    `The ${name} relation of a comment is served by another entity's finder`,
    'auto',
    `comment-expand-${name}`,
  );
}

/** Every comment of the request site (the comment feed's `siteID in (contentPoolID)` scope), in its tenant. */
async function siteRows(ctx: Ctx, call: JsonApiCall): Promise<FeedRow[]> {
  const rows = await getComments(ctx.domain, call.actor, { siteId: call.siteId, maxItems: 0 });
  return rows.map(({ tenant_id: _tenantId, ...row }) => row);
}

/** What the comment's values need beyond its row: the site scheme setURL prefixes. */
function valuesView(call: JsonApiCall): CommentValuesView {
  return { scheme: call.site.urls.scheme };
}

/** The scope of one handler call. */
function commentScope(ctx: Ctx, call: JsonApiCall): CommentScope {
  let rows: Promise<FeedRow[]> | undefined;
  const scope: CommentScope = {
    ctx,
    call,
    view: valuesView(call),
    resolver: {
      hasMany: (prop, params, opts) => expandMany(scope, prop, params, opts),
      hasOne: (prop, id, opts) => expandOne(scope, prop, id, opts),
      crumbs: () => Promise.reject(relationUnavailable('crumbs')),
      relatedContent: () => Promise.reject(relationUnavailable('relatedcontent')),
    },
    rows: () => (rows ??= siteRows(ctx, call)),
  };
  return scope;
}

/** findOne's getFilteredValues (2292-2384) of the comment `loadBy` finds, else of a new bean under a fresh id. */
async function commentData(
  scope: CommentScope,
  entityName: string,
  id: string,
  opts: ExpansionOptions,
): Promise<Struct> {
  const { ctx, call } = scope;
  assertNoHumanCheck(call);
  paramUrl(call.apiContext, 'entityname', entityName);
  const values = await findCommentValues(ctx.domain, call.tenantId, id, scope.view);
  return serializeContentEntity(commentView({ ...values }), call.apiContext, scope.resolver, {
    expanded: opts.expanded,
    expandLinks: opts.expand,
    pk: BEAN_PRIMARY_KEY,
    editableCheck: true,
  });
}

/** iteratorToArray (2920-2953) over feed rows, each a beanIterator bean of the row. */
function serializeItems(scope: CommentScope, rows: readonly FeedRow[], opts: ExpansionOptions): Promise<Struct[]> {
  const now = scope.ctx.domain.clock.now();
  const views = rows.map((row) => commentView(feedCommentValues(row, scope.view.scheme, now)));
  return serializeEntityList(views, scope.call.apiContext, { entityName: 'comment', ...opts }, scope.resolver);
}

/** `{count}`, or packageIteratorArray (287-366) of the selected comments; `arrange` orders the serialized items. */
async function feedData(
  scope: CommentScope,
  result: BeanFeedResult<FeedRow>,
  method: string,
  opts: ExpansionOptions,
  arrange: (items: Struct[]) => Struct[] = (items) => items,
): Promise<Struct> {
  if ('count' in result) return { count: result.count };
  const items = arrange(await serializeItems(scope, result.items, opts));
  return serializeCollection(items, result.page, scope.call.apiContext, {
    method,
    expanded: opts.expanded,
    baseUrl: result.baseUrl,
  });
}

/** expandEntity's `kids` (2432-2468): findQuery's expanded branch over its params after allowQueryParams. */
async function expandMany(scope: CommentScope, prop: RelationProp, params: Struct, opts: ExpansionOptions): Promise<unknown> {
  if (!cfEq(prop.cfc, 'comment')) throw relationUnavailable(prop.name);
  const expandedParams = { ...params };
  allowQueryParams(expandedParams, scope.call.actor);
  const result = beanFeedQuery(await scope.rows(), scope.call, { ...FEED_OPTIONS, expandedParams });
  return feedData(scope, result, 'findQuery', opts);
}

/** expandEntity's `parent` (2472-2482): findOne of the parent comment at the next depth. */
async function expandOne(scope: CommentScope, prop: RelationProp, id: unknown, opts: ExpansionOptions): Promise<unknown> {
  if (!cfEq(prop.cfc, 'comment')) throw relationUnavailable(prop.name);
  return commentData(scope, prop.cfc, typeof id === 'string' ? id : '', opts);
}

/** findOne (2292-2384): a missing comment serializes as a new bean with 200, as legacy answers it. */
async function findOne(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const data = await commentData(commentScope(ctx, call), call.entityName, call.id ?? '', {
    expand: expandOf(call),
    expanded: 0,
  });
  return jsonApiResultOf(data, 'comment');
}

/** findAll (2542-2625) and findQuery (2711-2918): the site's comments under allowQueryParams, filtered and paged. */
async function findFeed(ctx: Ctx, call: JsonApiCall, method: 'findall' | 'findQuery'): Promise<JsonApiResult> {
  const scope = commentScope(ctx, call);
  paramUrl(call.apiContext, 'entityname', call.entityName);
  allowQueryParams(call.apiContext.url, call.actor);
  const result = beanFeedQuery(await scope.rows(), call, FEED_OPTIONS);
  return jsonApiResultOf(await feedData(scope, result, method, { expand: expandOf(call), expanded: 0 }), 'comment');
}

/** SQL Server `IN` equality of a stored id: case-insensitive, trailing spaces ignored. */
function sameId(stored: string, id: string): boolean {
  return stored.trimEnd().toLowerCase() === id.trimEnd().toLowerCase();
}

/** findMany (2627-2709): the comments of `ids`, in the order of `ids` (repeats included) unless `sort` is set. */
async function findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const scope = commentScope(ctx, call);
  paramUrl(call.apiContext, 'entityname', call.entityName);
  const ids = call.ids ?? [];
  const rows = (await scope.rows()).filter((row) => ids.some((id) => sameId(row.commentid, id)));
  const result = beanFeedQuery(rows, call, FEED_OPTIONS);
  const sort = urlParam(call.apiContext, 'sort');
  const sorted = sort !== undefined && sort !== null && sort !== '';
  const inIdOrder = (items: Struct[]): Struct[] =>
    ids.flatMap((id) => {
      const item = items.find((candidate) => cfEq(String(getNoCase(candidate, 'id') ?? ''), id));
      return item === undefined ? [] : [item];
    });
  const data = await feedData(scope, result, 'findmany', { expand: expandOf(call), expanded: 0 }, sorted ? undefined : inIdOrder);
  return jsonApiResultOf(data, 'comment');
}

/** findNew (2386-2422): a new bean under a fresh id, serialized expanded. */
async function findNew(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const scope = commentScope(ctx, call);
  assertNoHumanCheck(call);
  const values = await findCommentValues(ctx.domain, call.tenantId, cfUuid(), scope.view);
  const data = await serializeContentEntity(commentView({ ...values }), call.apiContext, scope.resolver, {
    expanded: true,
    expandLinks: expandOf(call),
    pk: BEAN_PRIMARY_KEY,
    editableCheck: true,
  });
  return jsonApiResultOf(data, 'comment');
}

/** findProperties (1548-1618) from the registration. */
async function findProperties(_ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  return jsonApiResultOf(findPropertiesFor(config, call), 'comment');
}

/** findPermissions (2240-2266): bean.getPermissions of the comment a CF UUID or 35-character id loads. */
async function findPermissions(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const id = call.id ?? '';
  const stored = isCfUuid(id) || id.length === 35 ? await findCommentValues(ctx.domain, call.tenantId, id, valuesView(call)) : undefined;
  const permissions = permissionsOf({
    hasSiteId: stored !== undefined && stored.siteID !== '',
    readAllowed: true,
    actionAllowed: entityActionAllowed(call.actor, config),
    // contentCommentBean.allowSave (777-783): module access, or a comment that does not exist yet.
    saveAllowed: allowModuleAccess(call.actor) || (stored?.isNew ?? 1) !== 0,
  });
  return jsonApiResultOf(permissions, 'comment');
}

/** bean.getValue of a value `set()` stored without a property: trimmed when simple, '' when never set. */
function storedValue(values: Readonly<Struct>, name: string): unknown {
  const value = getNoCase(values, name);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return javaTrim(value);
  if (typeof value === 'number') return cfNumberString(value);
  return typeof value === 'boolean' ? String(value) : value;
}

/** CGI.REMOTE_ADDR as legacy would see it: the peer the gateway appends last to X-Forwarded-For; '' without one. */
function remoteAddrOf(call: JsonApiCall): string {
  return (call.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() ?? '';
}

/** The site values contentCommentBean.save reads. */
function saveSite(call: JsonApiCall): CommentSaveSite {
  const { siteId, site, contactEmail, urls } = call.site;
  return { siteId, site, contactEmail, urls, commentApprovalDefault: call.site.commentApprovalDefault ?? COMMENT_APPROVAL_DEFAULT };
}

/**
 * The id save loads and the event values it applies (1946-1966); loadBy keeps no id it misses, so a missed call id
 * saves under the `commentid` param or a fresh id.
 */
async function saveTarget(scope: CommentScope): Promise<{ commentId: string; values: Struct }> {
  const { ctx, call } = scope;
  const values = call.params.toRecord();
  const pkParam = call.params.string(BEAN_PRIMARY_KEY);
  if (pkParam !== '' && isLegacyFindOneId(pkParam)) return { commentId: pkParam, values };
  const id = call.id ?? 'new';
  if (cfEq(id, 'new')) {
    const commentId = cfUuid();
    setNoCase(values, BEAN_PRIMARY_KEY, commentId);
    return { commentId, values };
  }
  const stored = await findCommentValues(ctx.domain, call.tenantId, id, scope.view);
  return { commentId: stored.isNew === 0 ? id : cfUuid(), values };
}

/** save (1903-2074): CSRF, saveComment, then the reloaded comment with `saveErrors` and `errors` (403 with errors). */
async function save(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  // AllowAction is not checked first: legacy lets anyone post a new comment (allowSave is `not exists()`), and
  // saveComment applies the allowSave-or-AllowAction rule after loading the comment.
  const scope = commentScope(ctx, call);
  const { commentId, values } = await saveTarget(scope);
  const saved = await saveComment(ctx.domain, call.actor, {
    commentId,
    values,
    site: saveSite(call),
    remoteAddr: remoteAddrOf(call),
  });
  const saveErrors = storedValue(values, 'saveErrors');
  const overlay = Object.keys(saved.errors).length > 0 && !(cfIsBoolean(saveErrors) && cfToBoolean(saveErrors));
  const reloaded = await findCommentValues(ctx.domain, call.tenantId, saved.value.commentID, scope.view, overlay ? values : {});
  const data = await serializeContentEntity(commentView({ ...reloaded }), call.apiContext, scope.resolver, {
    expanded: true,
    expandLinks: expandOf(call),
    pk: BEAN_PRIMARY_KEY,
  });
  setNoCase(data, 'saveErrors', saveErrors);
  setNoCase(data, 'errors', saved.errors);
  return jsonApiResultOf(data, 'comment');
}

/** Rethrows an error the comment manager would swallow. */
function rethrow(error: unknown): never {
  throw error;
}

/** delete (3259-3335): a missing comment answers '' untouched; else AllowAction, CSRF, then the bean's delete. */
async function remove(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const pkParam = call.params.string(BEAN_PRIMARY_KEY);
  const id = pkParam !== '' && isCfUuid(pkParam) ? pkParam : (call.id ?? '');
  const stored = await findCommentValues(ctx.domain, call.tenantId, id, valuesView(call));
  if (stored.isNew !== 0) return jsonApiResultOf('', 'comment');
  if (!entityActionAllowed(call.actor, config)) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  // The JSON API calls the bean's own delete(), which no manager try/catch wraps, so every failure propagates.
  await deleteComment(ctx.domain, call.actor, stored.commentID, { apiRequest: true, onSwallowedError: rethrow });
  return jsonApiResultOf('', 'comment');
}

/** The JSON API `comment` entity: public reads, writes under the comments module (`m:015`). */
export const commentHandler: EntityHandler = {
  entity: 'comment',
  config,
  findOne,
  findMany,
  findAll: (ctx, call) => findFeed(ctx, call, 'findall'),
  findNew,
  findQuery: (ctx, call) => findFeed(ctx, call, 'findQuery'),
  findProperties,
  findPermissions,
  save,
  delete: remove,
};
