/**
 * Related-entity reads of the strategies-content JSON API (core/mura/client/api/json/v1/jsonApiUtility.cfc): the findOne
 * and findQuery calls of expandEntity (2424-2497) and of the relation paths `<entity>/<id>/<relation>` (1086-1150), each
 * answered by the related entity's own handler and access rules; the `site` entity's values come from programs-sites.
 */
import { cfEq, cfNumberString, LegacyApiError } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { UndefinedLegacyMethodError } from '../domain/context.js';
import { getContentEntityConfig, type RelationProp } from '../legacy/jsonapi-entities.js';
import { urlParam } from '../legacy/jsonapi-serializers.js';
import type { SiteJsonApiValues, SitesClient } from '../legacy/sites-client.js';
import type { ContentRouteContext } from './index.js';
import { categoryCrumbSource } from './jsonapi/category.js';
import { contentCrumbSource } from './jsonapi/content.js';
import {
  createJsonApiParams,
  jsonApiResultOf,
  lookupEntityHandler,
  relatedReaderOf,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiQuery,
  type JsonApiResult,
  type RelatedEntityReader,
  type RelatedFinder,
  type RelationSourceKey,
  type SourceBeanGetter,
} from './jsonapi/index.js';
import { relatedContentOfView } from './jsonapi/methods.js';

type Struct = Record<string, unknown>;

const SITES_SERVICE = 'programs-sites';

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

/** CFML struct write: replaces an existing key ignoring case, else adds it. */
function setNoCase(record: Struct, name: string, value: unknown): void {
  Object.defineProperty(record, keyOf(record, name) ?? name, { value, writable: true, enumerable: true, configurable: true });
}

/** CFML structDelete ignoring case. */
function deleteNoCase(record: Struct, name: string): void {
  const key = keyOf(record, name);
  if (key !== undefined) delete record[key];
}

/** `$.getBean(entityName)` of a related entity: its registered handler; ACF fails for a bean name no handler serves. */
function handlerOf(entityName: string): EntityHandler {
  const handler = lookupEntityHandler(entityName, { variations: true });
  if (handler === undefined) throw new Error(`No JSON API entity handler serves ${entityName}`);
  return handler;
}

/** The handler result's data; its error is thrown as processRequest's catch receives it. */
function dataOf(result: JsonApiResult): unknown {
  if (result.error !== undefined) throw new LegacyApiError(result.error);
  return result.data;
}

/** The call of `method` on the related `entity`, under the request's scopes and actor. */
function relatedCall(call: JsonApiCall, entity: string, method: string, finder: RelatedFinder, query: JsonApiQuery, id?: string): JsonApiCall {
  const related: JsonApiCall = { ...call, entityName: entity, method, finder, query };
  delete related.entityConfigName;
  delete related.ids;
  delete related.relatedEntity;
  delete related.relatedContentSetId;
  delete related.render;
  if (id === undefined) delete related.id;
  else related.id = id;
  return related;
}

/** A relation path's query string as findQuery reads it: its `name=value` pairs as the URL scope. */
function queryOf(queryString: string): JsonApiQuery {
  const pairs = queryString.split('&').map((pair): [string, string] => {
    const at = pair.indexOf('=');
    return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
  });
  return { raw: queryString, params: createJsonApiParams(pairs) };
}

/** The request's related-entity reader; `site` values are read from programs-sites once per site. */
export function createRelatedEntityReader(ctx: ContentRouteContext, sites: SitesClient): RelatedEntityReader {
  const siteValues = new Map<string, Promise<SiteJsonApiValues>>();

  /**
   * findOne('site') (2350-2361): the values of the API site, whatever id the relation holds; under a feed finder's
   * `url.entityname` the bean loads by `feedid`, so its `id` is ''.
   */
  async function siteData(call: JsonApiCall): Promise<unknown> {
    const { endpoint, siteId } = call.apiContext;
    const key = `${endpoint}\n${siteId}`;
    let values = siteValues.get(key);
    if (values === undefined) {
      values = sites.jsonApiValues(endpoint, [siteId]).then(([site]) => {
        if (site === undefined) throw new ServiceUnavailableError(SITES_SERVICE, new Error(`${SITES_SERVICE} answered no values for site ${siteId}`));
        return site;
      });
      siteValues.set(key, values);
    }
    const site = structuredClone(await values);
    if (cfEq(cfText(urlParam(call.apiContext, 'entityname')), 'feed')) site.id = '';
    return site;
  }

  return {
    async findOne(call, entityName, id, finder) {
      if (cfEq(entityName, 'site')) return siteData(call);
      const handler = handlerOf(entityName);
      if (handler.findOne === undefined) throw new Error(`The ${handler.entity} handler serves no findOne`);
      return dataOf(await handler.findOne(ctx, relatedCall(call, handler.entity, 'findOne', finder, call.query, id)));
    },
    async findQuery(call, entityName, finder, queryString) {
      const handler = handlerOf(entityName);
      if (handler.findQuery === undefined) throw new Error(`The ${handler.entity} handler serves no findQuery`);
      const query = queryString === undefined ? call.query : queryOf(queryString);
      return dataOf(await handler.findQuery(ctx, relatedCall(call, handler.entity, 'findQuery', finder, query)));
    },
    crumbs(call, view) {
      if (cfEq(view.entityName, 'content')) return contentCrumbSource(ctx, call, view);
      if (cfEq(view.entityName, 'category')) return categoryCrumbSource(ctx, call, view);
      // findCrumbArray reads getCrumbIterator, which no other bean defines.
      return Promise.reject(new UndefinedLegacyMethodError('getCrumbIterator'));
    },
    relatedContent(call, view, opts) {
      return relatedContentOfView(ctx, call, view, opts);
    },
  };
}

// ---- relation paths ----

/** `<entity>/<id>/<relation>` of a property with a cfc (1086-1150): the related findOne or findQuery and the method it reports. */
export interface RelationPath {
  method: string;
  fn: JsonApiHandlerFn;
}

/** loadBy of the path's source bean: by `contentid` when the relation is content's, else by its primary key (1093-1103). */
async function sourceGetter(ctx: ContentRouteContext, call: JsonApiCall, prop: RelationProp): Promise<SourceBeanGetter> {
  const source = handlerOf(call.entityName);
  // contentStatsBean extends mura.bean.bean, whose onMissingMethod rejects loadBy (bean.cfc:182).
  if (source.loadBy === undefined) throw new UndefinedLegacyMethodError('loadBy');
  const id = call.id ?? '';
  const key: RelationSourceKey = cfEq(prop.cfc, 'content') ? { contentid: id } : { primaryKey: id };
  return source.loadBy(ctx, call, key);
}

/** A many-to-one or one-to-one relation (1090-1112): findOne of the related entity by the source's column value. */
function relatedOnePath(prop: RelationProp): JsonApiHandlerFn {
  return async (ctx, call) => {
    setNoCase(call.apiContext.url, 'method', 'findOne');
    const id = cfEq(prop.loadkey, 'primaryKey') ? (call.id ?? '') : cfText((await sourceGetter(ctx, call, prop))(prop.column));
    const data = await relatedReaderOf(call).findOne(call, prop.cfc, id, { expand: '', expanded: 0 });
    return jsonApiResultOf(data, call.entityName);
  };
}

/** A one-to-many relation (1113-1146): findQuery of the related entity filtered by the source's key value. */
function relatedManyPath(prop: RelationProp): JsonApiHandlerFn {
  return async (ctx, call) => {
    const { url } = call.apiContext;
    setNoCase(url, 'method', 'findQuery');
    setNoCase(url, 'entityName', prop.cfc);
    // The primaryKey branch deletes params.id before building its query string from it.
    if (cfEq(prop.loadkey, 'primaryKey')) throw new Error('Element ID is undefined in PARAMS.');
    const get = await sourceGetter(ctx, call, prop);
    const value = get(prop.column);
    const params = call.params.toRecord();
    setNoCase(params, 'entityname', prop.cfc);
    setNoCase(params, prop.loadkey, value);
    setNoCase(url, prop.loadkey, value);
    deleteNoCase(params, 'id');
    const finder = { expand: '', expanded: 0, params };
    const data = await relatedReaderOf(call).findQuery(call, prop.cfc, finder, `${prop.loadkey}=${cfText(value)}`);
    return jsonApiResultOf(data, call.entityName);
  };
}

/** The `file` direct-method branch (856-886), which every `<site>/file/…` path takes before the entity route. */
const fileMethodCall: JsonApiHandlerFn = () =>
  // ACF's isDefined('file') also holds where the catch reports params.method (1319-1322).
  Promise.reject(new LegacyApiError('invalidMethodCall', { method: 'file', methodCtx: { registeredMethods: ['file'] } }));

/** The relation path of `entity`'s property `name`, or undefined when no relation of the entity has that name. */
export function relationPathOf(entity: string, name: string): RelationPath | undefined {
  const config = getContentEntityConfig(entity);
  if (!('hasMany' in config)) return undefined;
  const many = config.hasMany.find((prop) => cfEq(prop.name, name));
  const one = config.hasOne.find((prop) => cfEq(prop.name, name));
  if (many === undefined && one === undefined) return undefined;
  // `isDefined('file')` holds in processRequest, so `file` resolves as a public method name and is refused (856-866).
  if (cfEq(entity, 'file')) return { method: 'file', fn: fileMethodCall };
  if (one !== undefined) return { method: 'findOne', fn: relatedOnePath(one) };
  return many === undefined ? undefined : { method: 'findQuery', fn: relatedManyPath(many) };
}
