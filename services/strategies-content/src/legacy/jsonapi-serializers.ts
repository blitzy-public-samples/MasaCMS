/**
 * `data` values of the strategies-content JSON API, ported from core/mura/client/api/json/v1/jsonApiUtility.cfc:
 * getFilteredValues, getLinks, setImageURLs, expandEntity, iteratorToArray, packageIteratorArray, findCrumbArray,
 * findVersionHistory and findRelatedContent. Pure over prepared entity views; the envelope, error map, ETag and JSON
 * text are @opt2/platform/legacy-compat's.
 */
import {
  cfEq,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfToNumber,
  cfUuid,
  createApiSerializer,
  type LegacyJsonSerializer,
} from '@opt2/platform/legacy-compat';
import { contentImageUrl, contentUrl, hasImage, type ImageUrlOptions, type LegacySiteUrlConfig } from './content-urls.js';
import { entitySerializerHints, getContentEntityConfig, type RelationProp } from './jsonapi-entities.js';

type Struct = Record<string, unknown>;

/** Request-scoped inputs every serializer reads; one object is passed unchanged to every call of a request. */
export interface JsonApiRequestContext {
  /** The API utility's site (`variables.siteid`), after the `default` fallback. */
  siteId: string;
  mode: 'json' | 'ajax' | 'rest';
  /** getEndPoint() of the request, built by {@link jsonApiEndpoint}. */
  endpoint: string;
  /**
   * The legacy URL scope as dispatch left it, in insertion order. Serializers write to it where legacy does
   * (`param url.expanddepth`), so later default collection URLs carry those keys as legacy's do.
   */
  url: Record<string, unknown>;
  /** The legacy form scope: posted form fields only, never a JSON body. */
  form: Readonly<Record<string, unknown>>;
  /** The resolved API method (e.g. `findAll`); it names the default collection method. */
  method: string;
  /** isAggregateQuery() of the request (4981-4997). */
  isAggregateQuery: boolean;
  user: { loggedIn: boolean; systemUser: boolean };
  /** AllowAction(entity) (1740-1829) for the entity whose links are built. */
  allowAction: (view: ApiEntityView) => boolean | Promise<boolean>;
  site: LegacySiteUrlConfig;
  /** The site's custom image sizes, in iterator order. */
  customImageSizes: readonly { name: string }[];
  /** Stored-file lookups custom image sizes and extension-less image calls need. */
  imageLookups?: Pick<ImageUrlOptions, 'fileExtOf' | 'variantExists' | 'customImageSize'>;
}

/** One bean as getFilteredValues reads it, prepared by the domain layer from repository rows. */
export interface ApiEntityView {
  /** Bean getEntityName(): `content` for content and contentnav beans, and for feed beans (feedBean.cfc:771-778). */
  entityName: string;
  /** The entityConfigName it is serialized under, e.g. `contentnav`. */
  configName: string;
  /** Bean getPrimaryKey(), e.g. `contentid`, `commentID`, `feedID`; '' when the bean declares none. */
  primaryKey: string;
  /** getAllValues(expand=true), extended attributes merged. */
  allValues: Readonly<Record<string, unknown>>;
  /** Results of the bean's `get<Property>()` getters, which getValue prefers to stored values (e.g. `assocurl`). */
  values?: Readonly<Record<string, unknown>>;
  /** getExtendedData().getAllExtendSetData().data, read by the `extendeddata` field. */
  extendSetData?: Readonly<Record<string, unknown>>;
  /** getDisplayInterval().getAll(), read by the `displayInterval` field. */
  displayInterval?: Readonly<Record<string, unknown>>;
  type?: string;
  filename?: string;
  fileId?: string;
  fileExt?: string;
  hasMany: readonly RelationProp[];
  hasOne: readonly RelationProp[];
  /** Bean getEditURL(); absent or '' when the bean has none. */
  editUrl?: string;
  /** The bean's own site when it is not the request site (content pools); URL getters use it. */
  site?: LegacySiteUrlConfig;
}

/** The iterator values packageIteratorArray reads. */
export interface CollectionPage {
  recordCount: number;
  pageCount: number;
  pageIndex: number;
  firstOnPage: number;
  lastOnPage: number;
  nextN: number;
  /** Iterator getEntityName(). */
  entityName: string;
}

/** An iterator's beans with its page values. */
export interface EntityCollectionSource {
  items: readonly ApiEntityView[];
  page: CollectionPage;
}

/** One related content set of a subtype, with its related-content iterator. */
export interface RelatedContentSetSource extends EntityCollectionSource {
  name: string;
  entityType: string;
  relatedContentSetId: string;
}

/** findRelatedContent input: every set of the subtype (set id '', `*` or `all`), or the items of one set. */
export type RelatedContentSource =
  | { kind: 'sets'; sets: readonly RelatedContentSetSource[] }
  | ({ kind: 'set'; relatedContentSetId: string } & EntityCollectionSource);

/** Arguments one relation expansion is called with: the request's expand list and the incremented depth. */
export interface ExpansionOptions {
  expand: string;
  expanded: number;
}

/** Data access of expandEntity (2424-2498), supplied by the route layer; results are already serialized. */
export interface ExpansionResolver {
  /** findQuery(entityName=prop.cfc, params=params): the related collection. */
  hasMany: (prop: RelationProp, params: Record<string, unknown>, opts: ExpansionOptions) => Promise<unknown>;
  /** findOne(entityName=prop.cfc, id=id): the related entity. */
  hasOne: (prop: RelationProp, id: unknown, opts: ExpansionOptions) => Promise<unknown>;
  /** The bean's getCrumbIterator(); access is checked as findCrumbArray does. */
  crumbs: (view: ApiEntityView) => Promise<EntityCollectionSource>;
  /** The subtype's related content sets, inherited ones included, each with its iterator. */
  relatedContent: (view: ApiEntityView) => Promise<readonly RelatedContentSetSource[]>;
}

/** getFilteredValues arguments besides the entity. */
export interface FilteredValuesOptions {
  /** Expansion depth reached; `true` (save, findNew) counts as 1. */
  expanded?: number | boolean;
  /** The `expand` list. */
  expandLinks?: string;
  /** Key whose value becomes `id`; '' sets none. */
  pk?: string;
  editableCheck?: boolean;
  expandedProp?: string;
}

/** Options of {@link serializeCollection}. */
export interface CollectionOptions {
  /** packageIteratorArray's `method` argument; defaults to the request method's collection name. */
  method?: string;
  expanded?: number | boolean;
  /** The caller's base URL (findQuery); absent or '' builds the default one from the URL and form scopes. */
  baseUrl?: string;
}

/** Options of the iterator serializers. */
export interface IteratorOptions {
  expand?: string;
  expanded?: number | boolean;
}

const ALL_FIELDS_DELETED: readonly string[] = [
  'addObjects',
  'removeObjects',
  'sourceiterator',
  'frommuracache',
  'errors',
  'instanceid',
  'primaryKey',
  'extenddatatable',
  'extenddata',
  'extendAutoComplete',
  'saveErrors',
  'password',
];
const DISPLAY_INTERVAL_DELETED: readonly string[] = [
  'addObjects',
  'removeObjects',
  'sourceiterator',
  'frommuracache',
  'errors',
  'instanceid',
  'primaryKey',
  'isNew',
];
const LINK_PATH_ENTITIES = 'content,contentnav,comment,category,contentCategoryAssign';
const CONTENT_ENTITY_NAMES = 'content,contentnav';
const IMAGE_SIZES: readonly string[] = ['small', 'medium', 'large', 'source'];
const CONTENT_URL_PASSTHROUGH: readonly string[] = ['showexcludesearch', 'includeHomePage', 'shownavonly'];
const URL_PASSTHROUGH: readonly string[] = ['maxitems', 'cachedWithin', 'itemsPerPage'];
// The method argument each finder passes to packageIteratorArray; findAll and findMany pass it lower-cased (2624, 2708).
const COLLECTION_METHODS: ReadonlyMap<string, string> = new Map([
  ['findall', 'findall'],
  ['findmany', 'findmany'],
  ['findquery', 'findQuery'],
  ['findcrumbarray', 'findCrumbArray'],
  ['findversionhistory', 'findVersionHistory'],
  ['findrelatedcontent', 'findRelatedContent'],
]);

/** The own key equal to `key` ignoring case, as CFML struct keys resolve. */
function keyOf(s: Readonly<Struct>, key: string): string | undefined {
  if (Object.hasOwn(s, key)) return key;
  const lower = key.toLowerCase();
  return Object.keys(s).find((k) => k.toLowerCase() === lower);
}

/** CFML struct read ignoring case; undefined when absent. */
function getNoCase(s: Readonly<Struct>, key: string): unknown {
  const found = keyOf(s, key);
  return found === undefined ? undefined : s[found];
}

/** CFML struct write: replaces an existing key ignoring case, else adds it; defined, so `__proto__` stays a data key. */
function setNoCase(s: Struct, key: string, value: unknown): void {
  Object.defineProperty(s, keyOf(s, key) ?? key, { value, writable: true, enumerable: true, configurable: true });
}

/** CFML structDelete ignoring case. */
function deleteNoCase(s: Struct, key: string): void {
  const lower = key.toLowerCase();
  for (const k of Object.keys(s)) if (k.toLowerCase() === lower) delete s[k];
}

/** CFML listFindNoCase over a comma list. */
function listFindNoCase(list: string, value: string): boolean {
  const lower = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === lower);
}

/** CFML isStruct for plain data. */
function isStruct(v: unknown): v is Struct {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A simple value as CFML string interpolation renders it. */
function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return cfNumberString(v);
  if (typeof v === 'boolean') return String(v);
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

/** Expansion depth as a number; CFML reads `true` as 1. */
function depthOf(expanded: number | boolean | undefined): number {
  if (typeof expanded === 'boolean') return expanded ? 1 : 0;
  return expanded ?? 0;
}

/** CFML `url.<name>`: the URL-scope value matched ignoring case; undefined when absent. */
export function urlParam(ctx: Pick<JsonApiRequestContext, 'url'>, name: string): unknown {
  return getNoCase(ctx.url, name);
}

/** CFML `param name="url.<name>" default=value`: sets the URL-scope key when it is absent. */
export function paramUrl(ctx: Pick<JsonApiRequestContext, 'url'>, name: string, value: unknown): void {
  if (getNoCase(ctx.url, name) === undefined) setNoCase(ctx.url, name, value);
}

/** Bean getValue (bean.cfc:449-465): the getter's value, else the stored value; undefined when neither exists. */
function lookupValue(view: ApiEntityView, property: string): unknown {
  const getter = view.values === undefined ? undefined : getNoCase(view.values, property);
  return getter !== undefined ? getter : getNoCase(view.allValues, property);
}

/** Bean getValue with legacy's '' for a missing property. */
function valueOf(view: ApiEntityView, property: string): unknown {
  return lookupValue(view, property) ?? '';
}

/** bean translatePropKey (bean.cfc:271-276): `primaryKey` names the bean's primary key. */
function translatePropKey(view: ApiEntityView, property: string): string {
  return cfEq(property, 'primaryKey') ? view.primaryKey : property;
}

/** A value the view states explicitly, else the bean value. */
function fieldOf(view: ApiEntityView, field: 'type' | 'filename' | 'fileId' | 'fileExt'): string {
  return view[field] ?? text(valueOf(view, field));
}

/** The site whose renderer builds the bean's URLs. */
function siteOf(view: ApiEntityView, ctx: JsonApiRequestContext): LegacySiteUrlConfig {
  return view.site ?? ctx.site;
}

/** Primary key application.objectMappings registers for an entity; '' when it has none. */
function registeredPrimaryKey(entityName: string): string {
  const config = getContentEntityConfig(entityName);
  return 'primaryKey' in config ? config.primaryKey : '';
}

/** getEndPoint (3337-3364): `index.cfm` is always present and the mode is the request's (`json`, `ajax` or `rest`). */
export function jsonApiEndpoint(a: {
  adminSSL: boolean;
  /** utility getRequestProtocol(): `http` or `https`. */
  requestProtocol: string;
  /** cgi.server_name. */
  serverName: string;
  /** configBean getServerPort(): '' or `:<port>`. */
  serverPort: string;
  /** configBean getContext(). */
  context: string;
  mode: JsonApiRequestContext['mode'];
  siteId: string;
}): string {
  const protocol = a.adminSSL ? 'https:' : `${a.requestProtocol}:`;
  return `${protocol}//${a.serverName}${a.serverPort}${a.context}/index.cfm/_api/${a.mode}/v1/${a.siteId}`;
}

/** The JSON API serializer for responses about `entityName`: legacy API hints, then every content entity's hints. */
export function contentApiSerializer(entityName: string): LegacyJsonSerializer {
  return createApiSerializer(entitySerializerHints(entityName));
}

/** Page values of a queryIterator over `recordCount` records (queryIterator.cfc:100-115, 187-226). */
export function iteratorPage(a: {
  recordCount: number;
  maxRecordsPerPage: number;
  pageIndex?: number;
  entityName: string;
}): CollectionPage {
  const { recordCount, maxRecordsPerPage, entityName } = a;
  let pageIndex = a.pageIndex ?? 1;
  // setPageIndex resets a page past the last record to 1.
  if ((pageIndex - 1) * maxRecordsPerPage > recordCount) pageIndex = 1;
  const first = (pageIndex - 1) * maxRecordsPerPage;
  return {
    recordCount,
    // Legacy divides only for a non-empty iterator, which never has zero records per page.
    pageCount: maxRecordsPerPage > 0 ? Math.ceil(recordCount / maxRecordsPerPage) : 0,
    pageIndex,
    firstOnPage: first > recordCount ? 1 : first + 1,
    lastOnPage: Math.min(first + maxRecordsPerPage, recordCount),
    nextN: maxRecordsPerPage,
    entityName,
  };
}

/** The field list getFilteredValues settles (2084-2131); `allFields` when it is empty or holds `*` or `all`. */
export function selectFields(
  view: ApiEntityView,
  ctx: JsonApiRequestContext,
  opts: Pick<FilteredValuesOptions, 'expanded' | 'expandLinks' | 'expandedProp'> = {},
): { fields: string[]; allFields: boolean } {
  const expanded = ctx.isAggregateQuery ? 0 : depthOf(opts.expanded);
  const expandLinks = opts.expandLinks ?? '';
  const expandedProp = opts.expandedProp ?? '';
  const urlEntityName = text(urlParam(ctx, 'entityname'));
  const doFields =
    !expanded ||
    (!cfEq(expandedProp, 'crumbs') &&
      !cfEq(expandedProp, 'relatedcontent') &&
      urlEntityName !== '' &&
      (cfEq(urlEntityName, view.entityName) || cfEq(urlEntityName, view.configName)));

  const config = getContentEntityConfig(view.configName);
  const fieldSelect = !('allowFieldSelect' in config) || config.allowFieldSelect;
  const urlFields = text(urlParam(ctx, 'fields'));
  let fields = '';

  if (fieldSelect && doFields && urlFields !== '') {
    fields = urlFields;
    if (!ctx.isAggregateQuery) {
      const isContent = cfEq(view.entityName, 'content');
      if (isContent && !listFindNoCase(fields, 'contentid')) fields = cfListAppend(fields, 'contentid');
      else if (!isContent && !listFindNoCase(fields, view.primaryKey)) fields = cfListAppend(fields, view.primaryKey);
      if (!listFindNoCase(fields, 'siteid')) fields = cfListAppend(fields, 'siteid');
      if (
        listFindNoCase(LINK_PATH_ENTITIES, view.entityName) &&
        (listFindNoCase('*,all', expandLinks) || listFindNoCase(expandLinks, 'crumbs'))
      ) {
        if (!listFindNoCase(fields, 'links')) fields = cfListAppend(fields, 'links');
        if (!listFindNoCase(fields, 'path')) fields = cfListAppend(fields, 'path');
      }
    }
  } else if ('fields' in config && config.fields !== undefined && config.fields.length > 0) {
    fields = config.fields.join(',');
  }

  if (fields !== '' && !listFindNoCase(fields, 'isnew')) fields = cfListAppend(fields, 'isnew');
  const list = cfListToArray(fields);
  // arrayFind is case-sensitive: `ALL` or `*` in another case is an ordinary field name.
  return { fields: list, allFields: list.length === 0 || list.includes('*') || list.includes('all') };
}

/** getDisplayInterval().getAll() without the bean bookkeeping keys (2150-2158). */
function displayIntervalValues(view: ApiEntityView): Struct {
  // Legacy calls getAll() on what getDisplayInterval() returns, which fails for beans without a display interval.
  if (view.displayInterval === undefined) throw new TypeError(`The ${view.entityName} bean has no display interval`);
  const prop: Struct = { ...view.displayInterval };
  for (const key of DISPLAY_INTERVAL_DELETED) deleteNoCase(prop, key);
  return prop;
}

/** getFilteredValues (2076-2238): one entity's `data` struct with its links, images, url and expansions. */
export async function serializeContentEntity(
  view: ApiEntityView,
  ctx: JsonApiRequestContext,
  resolver?: ExpansionResolver,
  opts: FilteredValuesOptions = {},
): Promise<Record<string, unknown>> {
  const expanded = ctx.isAggregateQuery ? 0 : depthOf(opts.expanded);
  const expandLinks = opts.expandLinks ?? '';
  const pk = opts.pk ?? '';
  const { fields, allFields } = selectFields(view, ctx, { ...opts, expanded });

  let vals: Struct;
  if (!allFields) {
    vals = {};
    for (const f of fields) {
      if (cfEq(f, 'extendeddata')) {
        for (const [key, value] of Object.entries(view.extendSetData ?? {})) setNoCase(vals, key, value);
      } else {
        const property = cfListToArray(f, '.').at(-1) ?? '';
        setNoCase(vals, f, cfEq(f, 'displayInterval') ? displayIntervalValues(view) : valueOf(view, property));
      }
    }
    deleteNoCase(vals, 'password');
  } else {
    vals = { ...view.allValues };
    for (const key of ALL_FIELDS_DELETED) deleteNoCase(vals, key);
  }

  if (pk !== '') setNoCase(vals, 'id', valueOf(view, pk));

  if (allFields || fields.includes('links')) {
    const urlId = urlParam(ctx, 'id');
    let editable = opts.editableCheck ?? false;
    if (urlId !== undefined) {
      const id = getNoCase(vals, 'id');
      // Legacy reads vals.id unguarded once url.id exists.
      if (id === undefined) throw new TypeError('Element ID is undefined in VALS.');
      editable = cfEq(text(id), text(urlId)) || editable;
    }
    setNoCase(vals, 'links', await contentEntityLinks(view, ctx, editable));
  }

  if (listFindNoCase(CONTENT_ENTITY_NAMES, view.configName)) {
    if (allFields || fields.includes('images')) setNoCase(vals, 'images', contentImages(view, ctx));
    if (allFields || fields.includes('url')) {
      setNoCase(vals, 'url', contentUrl(siteOf(view, ctx), { filename: fieldOf(view, 'filename') }, { complete: true }));
    }
  }

  setNoCase(vals, 'entityname', cfEq(view.configName, 'contentnav') ? 'content' : view.configName);

  paramUrl(ctx, 'expanddepth', 1);
  if (!cfIsNumeric(urlParam(ctx, 'expanddepth'))) setNoCase(ctx.url, 'expanddepth', 1);

  if (expanded < cfToNumber(urlParam(ctx, 'expanddepth')) && expandLinks !== '') {
    await expandEntity(view, vals, ctx, resolver, expandLinks, expanded);
  }
  return vals;
}

/** expandEntity (2424-2498): writes the expanded relations, crumbs and related content into `vals`. */
async function expandEntity(
  view: ApiEntityView,
  vals: Struct,
  ctx: JsonApiRequestContext,
  resolver: ExpansionResolver | undefined,
  expand: string,
  depth: number,
): Promise<void> {
  const opts: ExpansionOptions = { expand, expanded: depth + 1 };
  const expandAll = cfEq(expand, 'all') || cfEq(expand, '*');
  const wanted = (name: string): boolean => expandAll || listFindNoCase(expand, name);
  const source = (): ExpansionResolver => {
    if (resolver === undefined) throw new TypeError(`Expanding "${expand}" needs an expansion resolver`);
    return resolver;
  };

  for (const p of view.hasMany) {
    if (!wanted(p.name)) continue;
    const params: Struct = {};
    // getValue(column, createUUID()): a missing column loads by a fresh id, so nothing matches.
    setNoCase(params, translatePropKey(view, p.loadkey), lookupValue(view, translatePropKey(view, p.column)) ?? cfUuid());
    if (cfEq(p.cfc, 'content')) {
      for (const name of CONTENT_URL_PASSTHROUGH) copyUrlParam(ctx, params, name);
      setNoCase(params, 'sortBy', valueOf(view, 'sortBy'));
      setNoCase(params, 'sortDirection', valueOf(view, 'sortDirection'));
    }
    for (const name of URL_PASSTHROUGH) copyUrlParam(ctx, params, name);
    setNoCase(vals, p.name, await source().hasMany(p, params, opts));
  }

  for (const p of view.hasOne) {
    if (!wanted(p.name)) continue;
    setNoCase(vals, p.name, await source().hasOne(p, valueOf(view, translatePropKey(view, p.column)), opts));
  }

  if (wanted('crumbs')) {
    const links = getNoCase(vals, 'links');
    const crumbLink = isStruct(links) ? getNoCase(links, 'crumbs') : undefined;
    const path = getNoCase(vals, 'path');
    if (crumbLink !== undefined && crumbLink !== null && path !== undefined && path !== null) {
      const crumbs = await source().crumbs(view);
      const entityName = text(getNoCase(vals, 'entityname'));
      setNoCase(vals, 'crumbs', await serializeCrumbs(crumbs, ctx, { entityName, expanded: opts.expanded }, resolver));
    }
  }

  if (listFindNoCase(CONTENT_ENTITY_NAMES, view.entityName) && wanted('relatedcontent')) {
    const sets = await source().relatedContent(view);
    setNoCase(vals, 'relatedcontent', await serializeRelatedContent({ kind: 'sets', sets }, ctx, { expanded: opts.expanded }, resolver));
  }
}

/** Copies `url.<name>` into expansion params when the URL scope defines it. */
function copyUrlParam(ctx: JsonApiRequestContext, params: Struct, name: string): void {
  const value = urlParam(ctx, name);
  if (value !== undefined) setNoCase(params, name, value);
}

/** getLinks (3374-3472); `linkMethods` are plugin hooks and stay on legacy. */
export async function contentEntityLinks(
  view: ApiEntityView,
  ctx: JsonApiRequestContext,
  editableCheck = false,
): Promise<Record<string, string>> {
  const base = ctx.endpoint;
  const links: Record<string, string> = {};
  setNoCase(links, 'entities', base);
  const entity = view.entityName;
  if (cfEq(entity, 'bean')) return links;

  if (editableCheck && ctx.user.loggedIn && ctx.user.systemUser && (await ctx.allowAction(view))) {
    const editUrl = view.editUrl ?? '';
    if (editUrl !== '') setNoCase(links, 'edit', editUrl);
  }
  setNoCase(links, 'all', `${base}/${entity}`);
  setNoCase(links, 'properties', `${base}/${entity}/properties`);

  const pkValue = (): string => text(valueOf(view, view.primaryKey));
  if (cfEq(entity, 'content')) {
    const contentId = text(valueOf(view, 'contentid'));
    const rendered = `${base}/content/_path/${fieldOf(view, 'filename')}`;
    setNoCase(links, 'self', `${base}/content/${contentId}`);
    setNoCase(links, 'history', `${base}/content/${contentId}/history`);
    setNoCase(links, 'rendered', rendered);
    if (cfEq(fieldOf(view, 'type'), 'Variation')) setNoCase(links, 'self', rendered);
    else setNoCase(links, 'crumbs', `${base}/${entity}/${contentId}/crumbs`);
    setNoCase(links, 'relatedcontent', `${base}/${entity}/${contentId}/relatedcontent`);
  } else if (cfEq(entity, 'category')) {
    setNoCase(links, 'crumbs', `${base}/${entity}/${text(valueOf(view, 'categoryid'))}/crumbs`);
    setNoCase(links, 'self', `${base}/${entity}/${pkValue()}`);
  } else if (cfEq(entity, 'site')) {
    setNoCase(links, 'self', `${base}/site`);
  } else {
    setNoCase(links, 'self', `${base}/${entity}/${pkValue()}`);
  }

  if (listFindNoCase('feed,contentFeed', entity)) setNoCase(links, 'feed', `${base}/content/?feedid=${text(valueOf(view, 'feedid'))}`);

  if (cfEq(entity, 'content')) setNoCase(links, 'permissions', `${base}/${entity}/${text(valueOf(view, 'contentid'))}/permissions`);
  else if (view.primaryKey !== '') setNoCase(links, 'permissions', `${base}/${entity}/${pkValue()}/permissions`);

  for (const p of view.hasMany) {
    const value = text(valueOf(view, translatePropKey(view, p.column)));
    setNoCase(links, p.name, `${base}/${p.cfc}?${translatePropKey(view, p.loadkey)}=${value}`);
  }

  for (const p of view.hasOne) {
    if (cfEq(p.name, 'site')) {
      setNoCase(links, p.name, `${base}/site`);
      continue;
    }
    const key = translatePropKey(view, p.column);
    const value = text(valueOf(view, key));
    if (value === '') continue;
    if (cfEq(p.cfc, 'content') && cfEq(key, 'contenthistid')) setNoCase(links, p.name, `${base}/${p.cfc}/?contenthistid=${value}`);
    else setNoCase(links, p.name, `${base}/${p.cfc}/${value}`);
  }
  return links;
}

/**
 * setImageURLs for `fileid` (3588-3615): small, medium, large, source and each custom size, each the bean's
 * getImageURL, when the content has an image or the site a placeholder, else {}. URLs keep the legacy direct or
 * `_api/render` forms, never signed URLs.
 */
export function contentImages(view: ApiEntityView, ctx: JsonApiRequestContext): Record<string, string> {
  const site = siteOf(view, ctx);
  const row = { fileid: fieldOf(view, 'fileId'), fileext: fieldOf(view, 'fileExt'), type: fieldOf(view, 'type') };
  if (!hasImage(row, site)) return {};
  const opts = { ...ctx.imageLookups, complete: true, secure: site.useSSL };
  const images: Record<string, string> = {};
  for (const size of IMAGE_SIZES) setNoCase(images, size, contentImageUrl(site, row, { ...opts, size }));
  for (const { name } of ctx.customImageSizes) setNoCase(images, name, contentImageUrl(site, row, { ...opts, size: name }));
  return images;
}

/** packageIteratorArray's default base URL (318-336): the endpoint plus every URL and form param but pageIndex, raw. */
function defaultBaseUrl(ctx: JsonApiRequestContext, method: string): string {
  const params: Struct = {};
  for (const [key, value] of Object.entries(ctx.url)) setNoCase(params, key, value);
  for (const [key, value] of Object.entries(ctx.form)) setNoCase(params, key, value);
  if (getNoCase(params, 'method') === undefined) setNoCase(params, 'method', method);
  if (method.includes('.')) setNoCase(params, 'method', method);
  if (cfEq(text(getNoCase(params, 'method')), 'undefined')) setNoCase(params, 'method', method);

  let baseUrl = `${ctx.endpoint}/?`;
  for (const [key, value] of Object.entries(params)) {
    if (!cfEq(key, 'pageIndex')) baseUrl += `&${key.toLowerCase()}=${text(value)}`;
  }
  return baseUrl;
}

/** packageIteratorArray (287-366): an iterator's serialized items with totals, page indexes and paging links. */
export function serializeCollection(
  items: readonly unknown[],
  page: CollectionPage,
  ctx: JsonApiRequestContext,
  opts: CollectionOptions = {},
): Record<string, unknown> {
  const method = opts.method ?? COLLECTION_METHODS.get(ctx.method.toLowerCase()) ?? ctx.method;
  const result: Struct = page.recordCount
    ? {
        totalItems: page.recordCount,
        totalPages: page.pageCount,
        pageIndex: page.pageIndex,
        items,
        startindex: page.firstOnPage,
        endindex: page.lastOnPage,
        itemsperpage: page.nextN,
      }
    : { totalItems: 0, totalPages: 0, pageIndex: 0, items: [], startindex: 0, endindex: 0, itemsperpage: page.nextN };
  result['entityname'] = ctx.isAggregateQuery ? 'bean' : page.entityName;

  let baseUrl = opts.baseUrl;
  // Legacy's `!expanded && !isDefined(baseURL) || !len(baseURL)` reads an undefined baseURL once expanded.
  if (depthOf(opts.expanded) && baseUrl === undefined) throw new TypeError('Element BASEURL is undefined in ARGUMENTS.');
  if (baseUrl === undefined || baseUrl === '') baseUrl = defaultBaseUrl(ctx, method);

  const pageIndex = result['pageIndex'] as number;
  const totalPages = result['totalPages'] as number;
  const nextIndex = pageIndex < totalPages ? pageIndex + 1 : 1;
  const prevIndex = pageIndex > 1 ? pageIndex - 1 : totalPages;
  const pageLink = (index: number): string => `${baseUrl}&pageIndex=${text(index)}`;

  const links: Record<string, string> = { self: pageLink(pageIndex), entities: ctx.endpoint };
  if (!cfEq(page.entityName, 'bean')) {
    links['properties'] = `${ctx.endpoint}/${page.entityName}/properties`;
    links['permissions'] = `${ctx.endpoint}/${page.entityName}/permissions`;
  }
  if (pageIndex > 1) {
    links['first'] = pageLink(1);
    links['previous'] = pageLink(prevIndex);
  }
  if (totalPages > 1) links['last'] = pageLink(totalPages);
  if (pageIndex < totalPages) links['next'] = pageLink(nextIndex);
  result['links'] = links;
  return result;
}

/** iteratorToArray (2920-2953): each bean of an iterator over `opts.entityName`, under the iterator's entity config. */
export async function serializeEntityList(
  views: readonly ApiEntityView[],
  ctx: JsonApiRequestContext,
  opts: IteratorOptions & { entityName: string },
  resolver?: ExpansionResolver,
): Promise<Record<string, unknown>[]> {
  const { entityName } = opts;
  const pk = listFindNoCase(CONTENT_ENTITY_NAMES, entityName)
    ? 'contentid'
    : cfEq(entityName, 'feed')
      ? 'feedid'
      : registeredPrimaryKey(entityName);
  const configName = cfEq(entityName, 'content') ? 'contentnav' : entityName;
  const items: Record<string, unknown>[] = [];
  for (const view of views) {
    items.push(
      await serializeContentEntity({ ...view, configName }, ctx, resolver, {
        expanded: opts.expanded,
        expandLinks: opts.expand ?? '',
        pk,
      }),
    );
  }
  return items;
}

/** findCrumbArray (3185-3233): an entity's crumb iterator as a collection (method `findCrumbArray`). */
export async function serializeCrumbs(
  source: EntityCollectionSource,
  ctx: JsonApiRequestContext,
  opts: IteratorOptions & { entityName: string },
  resolver?: ExpansionResolver,
): Promise<Record<string, unknown>> {
  const entityName = cfEq(opts.entityName, 'contentnav') ? 'content' : opts.entityName;
  const isContent = cfEq(entityName, 'content');
  const pk = isContent ? 'contentid' : registeredPrimaryKey(entityName);
  const configName = isContent ? 'contentnav' : entityName;
  const items: Record<string, unknown>[] = [];
  for (const view of source.items) {
    items.push(
      await serializeContentEntity({ ...view, configName }, ctx, resolver, {
        expanded: opts.expanded,
        expandLinks: opts.expand ?? '',
        pk,
      }),
    );
  }
  return serializeCollection(items, source.page, ctx, { method: 'findCrumbArray' });
}

/** findVersionHistory (3236-3256): versions whose self links carry `?contenthistid=` (method `findVersionHistory`). */
export async function serializeVersionHistory(
  source: EntityCollectionSource,
  ctx: JsonApiRequestContext,
  opts: IteratorOptions = {},
  resolver?: ExpansionResolver,
): Promise<Record<string, unknown>> {
  const items = await serializeEntityList(source.items, ctx, { ...opts, entityName: source.page.entityName }, resolver);
  for (const item of items) {
    const links = getNoCase(item, 'links');
    const contentHistId = getNoCase(item, 'contenthistid');
    // Legacy appends to i.links.self unguarded; a field list without links or contenthistid fails there.
    if (!isStruct(links) || getNoCase(links, 'self') === undefined || contentHistId === undefined) {
      throw new TypeError('Element LINKS.SELF or CONTENTHISTID is undefined in I.');
    }
    setNoCase(links, 'self', `${text(getNoCase(links, 'self'))}?contenthistid=${text(contentHistId)}`);
  }
  return serializeCollection(items, source.page, ctx, { method: 'findVersionHistory' });
}

/**
 * findRelatedContent (3474-3565): every set as a `relatedcontentset` collection of per-set collections, or the items
 * of one set named by its id; neither level keeps its links.
 */
export async function serializeRelatedContent(
  source: RelatedContentSource,
  ctx: JsonApiRequestContext,
  opts: IteratorOptions = {},
  resolver?: ExpansionResolver,
): Promise<Record<string, unknown>> {
  const packageSet = async (set: EntityCollectionSource): Promise<Struct> => {
    const items = await serializeEntityList(set.items, ctx, { ...opts, entityName: set.page.entityName }, resolver);
    const packaged = serializeCollection(items, set.page, ctx, { method: 'findRelatedContent' });
    deleteNoCase(packaged, 'links');
    return packaged;
  };

  if (source.kind === 'set') {
    const packaged = await packageSet(source);
    // Legacy names a single set by the id it was asked for.
    setNoCase(packaged, 'name', source.relatedContentSetId);
    return packaged;
  }

  const sets: Struct[] = [];
  for (const set of source.sets) {
    const packaged = await packageSet(set);
    setNoCase(packaged, 'name', set.name);
    setNoCase(packaged, 'entityname', set.entityType);
    setNoCase(packaged, 'relatedcontentsetid', set.relatedContentSetId);
    setNoCase(packaged, 'siteid', ctx.siteId);
    sets.push(packaged);
  }
  // beanIterator.setArray(sets): one page holding every set.
  const page = iteratorPage({ recordCount: sets.length, maxRecordsPerPage: sets.length, entityName: 'relatedcontentset' });
  const result = serializeCollection(sets, page, ctx, { method: 'findRelatedContent' });
  deleteNoCase(result, 'links');
  return result;
}
