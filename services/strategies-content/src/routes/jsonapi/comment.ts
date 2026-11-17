/**
 * JSON API `comment` entity (core/mura/client/api/json/v1/jsonApiUtility.cfc:76-80): the generic finders, save and
 * delete of contentCommentBean (core/mura/content/contentCommentBean.cfc), its feed and its remote functions, over
 * ../../domain/comments.ts.
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
  LegacyApiError,
  LegacyServiceUnavailableError,
} from '@opt2/platform/legacy-compat';
import { withTenant } from '@opt2/platform/tenancy';
import {
  deleteComment,
  feedCommentValues,
  findCommentValues,
  flagComment,
  getComments,
  markAsSpam,
  saveComment,
  undeleteComment,
  unmarkAsSpam,
  type CommentCallOptions,
  type CommentSaveSite,
  type CommentValues,
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
  finderOf,
  finderParamsOf,
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
  type RemoteFunctionFn,
  type SourceBeanGetter,
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

/** Per-call state: the call, the values view and the resolver of comment relations. */
interface CommentScope {
  readonly ctx: Ctx;
  readonly call: JsonApiCall;
  readonly view: CommentValuesView;
  readonly resolver: ExpansionResolver;
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
  // `<cfset arguments.params.fields=…>` creates an absent key upper-cased.
  const fieldsKey = keyOf(params, 'fields') ?? 'FIELDS';
  if (allowModuleAccess(actor)) {
    params[fieldsKey] = MODULE_QUERY_FIELDS;
    return;
  }
  params[fieldsKey] = PUBLIC_QUERY_FIELDS;
  setNoCase(params, 'isspam', 0);
  setNoCase(params, 'isdeleted', 0);
}

/** `url.ishuman` renders the CFML form-protection include into findOne and findNew results (2373-2376, 2416-2419). */
function assertNoHumanCheck(call: JsonApiCall): void {
  if (urlParam(call.apiContext, 'ishuman') !== undefined) {
    throw new LegacyServiceUnavailableError('The ishuman field renders a CFML display object', 'auto', 'cfml-render');
  }
}

/** beanFeed over the site's comments (the feed's `siteID in (contentPoolID)` scope), or those of `ids`, in SQL in one transaction in the call's tenant. */
function siteFeed(ctx: Ctx, call: JsonApiCall, options: BeanFeedOptions, ids?: readonly string[]): Promise<BeanFeedResult<FeedRow>> {
  const { db, repository } = ctx.domain;
  const spec = repository.comments.commentFeedSpec(ids === undefined ? { siteId: call.siteId } : { siteId: call.siteId, commentIds: ids });
  // An anonymous actor carries no tenant of its own.
  return withTenant(db, call.tenantId, (tx) => beanFeedQuery(repository.beanFeed.source<FeedRow>((fn) => fn(tx), spec), call, options));
}

/** What the comment's values need beyond its row: the site scheme setURL prefixes. */
function valuesView(call: JsonApiCall): CommentValuesView {
  return { scheme: call.site.urls.scheme };
}

/** The scope of one handler call: comment relations through the comment finders, the others through their entities'. */
function commentScope(ctx: Ctx, call: JsonApiCall): CommentScope {
  const related = relatedResolver(call);
  const scope: CommentScope = {
    ctx,
    call,
    view: valuesView(call),
    resolver: {
      hasMany: (prop, params, opts) => (cfEq(prop.cfc, 'comment') ? expandMany(scope, params, opts) : related.hasMany(prop, params, opts)),
      hasOne: (prop, id, opts) => (cfEq(prop.cfc, 'comment') ? expandOne(scope, prop, id, opts) : related.hasOne(prop, id, opts)),
      crumbs: related.crumbs,
      relatedContent: related.relatedContent,
    },
  };
  return scope;
}

/** `$.getBean('comment').loadBy(commentID=id)`: a bean no row filled keeps the site `$.getBean` gave it, the request's. */
async function apiBeanValues(scope: CommentScope, id: string, overlay: Readonly<Struct> = {}): Promise<CommentValues> {
  const values = await findCommentValues(scope.ctx.domain, scope.call.tenantId, id, scope.view, overlay);
  return values.isNew === 0 ? values : { ...values, siteID: scope.call.siteId };
}

/** findOne's getFilteredValues (2292-2384) of the comment `loadBy` finds, else of a new bean under a fresh id. */
async function commentData(
  scope: CommentScope,
  entityName: string,
  id: string,
  opts: ExpansionOptions,
): Promise<Struct> {
  const { call } = scope;
  assertNoHumanCheck(call);
  paramUrl(call.apiContext, 'entityname', entityName);
  const values = await apiBeanValues(scope, id);
  return serializeContentEntity(commentView({ ...values }), call.apiContext, scope.resolver, {
    expanded: opts.expanded,
    expandLinks: opts.expand,
    pk: BEAN_PRIMARY_KEY,
    editableCheck: true,
  });
}

/** iteratorToArray (2920-2953) over feed rows, each a beanIterator bean of the row. */
function serializeItems(scope: CommentScope, rows: ReadonlyArray<FeedRow | BlankFeedRow>, opts: ExpansionOptions): Promise<Struct[]> {
  const now = scope.ctx.domain.clock.now();
  const views = rows.map((row): ApiEntityView => {
    const view = commentView(feedCommentValues(row, scope.view.scheme, now));
    // set() skips the blank id and getCommentID creates one (contentCommentBean.cfc:156-161), once getFilteredValues has copied the values.
    return isBlankFeedRow(row) ? { ...view, values: { commentid: cfUuid() } } : view;
  });
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
async function expandMany(scope: CommentScope, params: Struct, opts: ExpansionOptions): Promise<unknown> {
  const expandedParams = { ...params };
  allowQueryParams(expandedParams, scope.call.actor);
  const result = await siteFeed(scope.ctx, scope.call, { ...FEED_OPTIONS, expandedParams });
  return feedData(scope, result, 'findQuery', opts);
}

/** expandEntity's `parent` (2472-2482): findOne of the parent comment at the next depth. */
async function expandOne(scope: CommentScope, prop: RelationProp, id: unknown, opts: ExpansionOptions): Promise<unknown> {
  return commentData(scope, prop.cfc, typeof id === 'string' ? id : '', opts);
}

/** findOne (2292-2384): a missing comment serializes as a new bean with 200, as legacy answers it. */
async function findOne(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const data = await commentData(commentScope(ctx, call), call.entityName, call.id ?? '', finderOf(call));
  return jsonApiResultOf(data, 'comment');
}

/** findAll (2542-2625) and findQuery (2711-2918): the site's comments under allowQueryParams, filtered and paged. */
async function findFeed(ctx: Ctx, call: JsonApiCall, method: 'findall' | 'findQuery'): Promise<JsonApiResult> {
  const scope = commentScope(ctx, call);
  paramUrl(call.apiContext, 'entityname', call.entityName);
  allowQueryParams(finderParamsOf(call), call.actor);
  const result = await siteFeed(ctx, call, FEED_OPTIONS);
  return jsonApiResultOf(await feedData(scope, result, method, finderOf(call)), 'comment');
}

/** loadBy (226-232): by `commentID`; a `contentid` key names no argument getQuery reads, so the bean stays new. */
async function loadBy(ctx: Ctx, call: JsonApiCall, key: RelationSourceKey): Promise<SourceBeanGetter> {
  const id = 'primaryKey' in key ? key.primaryKey : cfUuid();
  const values: Struct = { ...(await findCommentValues(ctx.domain, call.tenantId, id, valuesView(call))) };
  return (name) => getNoCase(values, cfEq(name, 'primaryKey') ? BEAN_PRIMARY_KEY : name);
}

/** findMany (2627-2709): the comments of `ids`, in the order of `ids` (repeats included) unless `sort` is set. */
async function findMany(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  const scope = commentScope(ctx, call);
  paramUrl(call.apiContext, 'entityname', call.entityName);
  const ids = call.ids ?? [];
  const result = await siteFeed(ctx, call, FEED_OPTIONS, ids);
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
  const values = await apiBeanValues(scope, cfUuid());
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

/** findPermissions (2240-2266): bean.getPermissions of the comment a CF UUID or 35-character id loads, else of a new bean of the request site. */
async function findPermissions(ctx: Ctx, call: JsonApiCall): Promise<JsonApiResult> {
  // Legacy reads the undefined `arguments.id`.
  if (call.id === undefined) throw new LegacyApiError('server_error');
  const id = call.id;
  const stored = isCfUuid(id) || id.length === 35 ? await findCommentValues(ctx.domain, call.tenantId, id, valuesView(call)) : undefined;
  const permissions = permissionsOf({
    hasSiteId: (stored?.isNew === 0 ? stored.siteID : call.siteId) !== '',
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
  const reloaded = await apiBeanValues(scope, saved.value.commentID, overlay ? values : {});
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

/** The bean's own remote functions run under the API request, and no manager try/catch swallows their failures. */
const REMOTE_OPTIONS: CommentCallOptions = Object.freeze({ apiRequest: true, onSwallowedError: rethrow });

/** The acting user in the call's verified tenant, which an anonymous actor does not carry itself. */
function actorOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId };
}

/** The comment a remote function changes: the one `loadBy` loaded, else a new bean's getCommentID(), a fresh id no comment holds. */
function remoteCommentId(beanId: string | undefined): string {
  return beanId ?? cfUuid();
}

/**
 * contentCommentBean's remote functions (contentCommentBean.cfc:317-428) by legacy name: `flag` adds one to the flag count
 * for any caller; the others set `isDeleted` or `isSpam` only under allowModuleAccess. Each write recounts the content's comments.
 */
export const commentRemoteFunctions: Readonly<Record<string, RemoteFunctionFn>> = Object.freeze({
  delete: async (ctx, call, beanId) => {
    await deleteComment(ctx.domain, actorOf(call), remoteCommentId(beanId), REMOTE_OPTIONS);
  },
  undelete: async (ctx, call, beanId) => {
    await undeleteComment(ctx.domain, actorOf(call), remoteCommentId(beanId), REMOTE_OPTIONS);
  },
  flag: (ctx, call, beanId) => flagComment(ctx.domain, call.tenantId, remoteCommentId(beanId), { actor: call.actor }),
  markAsSpam: async (ctx, call, beanId) => {
    await markAsSpam(ctx.domain, actorOf(call), remoteCommentId(beanId), REMOTE_OPTIONS);
  },
  unMarkAsSpam: async (ctx, call, beanId) => {
    await unmarkAsSpam(ctx.domain, actorOf(call), remoteCommentId(beanId), REMOTE_OPTIONS);
  },
});

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
  loadBy,
};
