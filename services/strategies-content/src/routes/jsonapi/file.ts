/**
 * JSON API `file` and `fileMetaData` entity handlers (jsonApiUtility.cfc) over fileBean.cfc and contentFileMetaDataBean.cfc.
 * `file` rows live in the token tenant's file pool tenant, `fileMetaData` rows in the content tenant.
 */
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  cfEq,
  cfIsDateText,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfUuid,
  isCfUuid,
  isLegacyFindOneId,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { writeContextFor } from '../../domain/context.js';
import {
  ImageUploadHaltedError,
  deleteFileEntity,
  deleteFileMetaDataEntity,
  isImageUploadExt,
  saveFileMetaDataEntity,
  storeUploadedFile,
  type FileMetaDataValues,
} from '../../domain/files.js';
import { withPoolTenant } from '../../domain/pools.js';
import type { FeedTableSpec } from '../../repo/bean-feed-sql.js';
import type { ReadFileMetaRow } from '../../repo/files.js';
import type { ContentRepository } from '../../repo/repository.js';
import { CONTENT_ENTITIES, type ContentEntityConfig } from '../../legacy/jsonapi-entities.js';
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
  finderOf,
  findPropertiesFor,
  isBlankFeedRow,
  jsonApiResultOf,
  permissionsOf,
  relatedResolver,
  type BeanFeedOptions,
  type BeanFeedSource,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
  type RelationSourceKey,
  type SourceBeanGetter,
} from './types.js';
import { validate } from './validate.js';

type Struct = Record<string, unknown>;
type RouteContext = Parameters<JsonApiHandlerFn>[0];
type FileRow = NonNullable<Awaited<ReturnType<ContentRepository['files']['readFileAll']>>>;
type FileMetadataRow = Awaited<ReturnType<ContentRepository['files']['listFileMetadata']>>[number];

const FILE_CONFIG = CONTENT_ENTITIES.file;
const META_CONFIG = CONTENT_ENTITIES.fileMetaData;

/** fileBean `moduleid` default (fileBean.cfc:11). */
const FILE_DEFAULT_MODULE_ID = '00000000000000000000000000000000000';
const TENANT_COLUMN = 'tenant_id';

/** What beanORM.loadBy's `set(arguments)` adds to a bean when no row matches, besides its key and site (beanORM.cfc:750, 909-913). */
const NOT_FOUND_ARGUMENTS: Readonly<Struct> = Object.freeze({ returnformat: 'self', cachedwithin: 0 });

// bean.cfc:79-82 properties, which every entity's hasProperty also accepts.
const BASE_PROPERTIES = ['errors', 'isNew', 'fromMuraCache', 'instanceID'];

/** Names fileBean's hasProperty accepts: its properties and their relation columns (fileBean.cfc:3-33). */
const FILE_PROPERTY_NAMES: readonly string[] = [
  'fileid',
  'content',
  'contentid',
  'site',
  'siteid',
  'filename',
  'contentType',
  'contentSubType',
  'fileSize',
  'fileExt',
  'moduleid',
  'created',
  'deleted',
  'caption',
  'credits',
  'alttext',
  'fileField',
  'remoteID',
  'remoteURL',
  'remotePubDate',
  'remoteSource',
  'remoteSourceURL',
  'exif',
  ...BASE_PROPERTIES,
];

/** Names contentFileMetaDataBean's hasProperty accepts (contentFileMetaDataBean.cfc:84-111, beanORMVersioned.cfc:78-80). */
const META_PROPERTY_NAMES: readonly string[] = [
  'metaID',
  'file',
  'fileid',
  'altText',
  'caption',
  'credits',
  'filename',
  'filesize',
  'contentType',
  'contentSubType',
  'fileExt',
  'created',
  'directImages',
  'remoteID',
  'remoteURL',
  'remotePubDate',
  'remoteSource',
  'remoteSourceURL',
  'exif',
  'activeContent',
  'contentid',
  'content',
  'contenthistid',
  'site',
  'siteID',
  ...BASE_PROPERTIES,
];

/** `tfiles` columns the fileMetaData load joins in (contentFileMetaDataBean.cfc:132-136). */
const JOINED_FILE_COLUMNS = ['filename', 'filesize', 'contenttype', 'contentsubtype', 'fileext', 'created'] as const satisfies readonly (keyof ReadFileMetaRow)[];

// remotePubDate is left out: contentFileMetaDataBean.setRemotePubDate assigns variables.remotepubdate, not the instance
// value, so a posted value is never saved (contentFileMetaDataBean.cfc:200-203).
/** `fileMetaData` columns a posted value is saved to. */
const META_POSTED_COLUMNS = [
  'alttext',
  'caption',
  'credits',
  'remoteid',
  'remoteurl',
  'remotesource',
  'remotesourceurl',
  'exif',
] as const satisfies readonly (keyof FileMetaDataValues)[];

const T_DATE_TIME = /\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/;
const SPACE_DATE_TIME = /\d\d\d\d-\d\d-\d\d\s\d\d:\d\d:\d\d/;

/** SQL Server equality of two ids or site ids: trailing spaces dropped, case ignored. */
function sameId(a: string | null, b: string): boolean {
  return (a ?? '').replace(/ +$/u, '').toLowerCase() === b.replace(/ +$/u, '').toLowerCase();
}

/** A simple bean value as CFML renders it; '' for anything else. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** A posted simple value as `bean.setValue` stores it, trimmed; undefined when the request holds none. */
function postedText(call: JsonApiCall, name: string): string | undefined {
  const value = call.params.get(name);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? javaTrim(text(value)) : undefined;
}

/** A stored column as `set(query)` leaves it on a bean: NULL as '' (ACF query cells), text trimmed, bytes as ACF serializes binary. */
function beanValue(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return javaTrim(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

/** `row`'s columns without the tenant column, narrowed to `selected` when given. */
function columnsOf(row: Readonly<Struct>, selected?: ReadonlySet<string>): Struct {
  const values: Struct = {};
  for (const [column, value] of Object.entries(row)) {
    if (column !== TENANT_COLUMN && (selected === undefined || selected.has(column))) values[column] = value;
  }
  return values;
}

/** `row`'s columns as the bean holds them after `set(query)`. */
function beanColumns(row: Readonly<Struct>, selected?: ReadonlySet<string>): Struct {
  return Object.fromEntries(Object.entries(columnsOf(row, selected)).map(([column, value]) => [column, beanValue(value)]));
}

/** The columns `set(row)` stores from a feed row: a blank row's empty primary key is skipped (bean.cfc:333). */
function setColumns(row: Readonly<Struct>, primaryKey: string): Readonly<Struct> {
  return isBlankFeedRow(row) ? Object.fromEntries(Object.entries(row).filter(([column]) => column !== primaryKey)) : row;
}

/** bean.parseDateArg (bean.cfc:278-301) as fileBean.setRemotePubDate applies it; null for text that is no date. */
function remotePubDateOf(posted: string): Date | null {
  const arg = T_DATE_TIME.test(posted) ? posted.replace('T', ' ') : posted;
  if (!SPACE_DATE_TIME.test(arg) && cfLsIsDate(arg)) return cfLsParseDateTime(arg);
  return cfIsDateText(arg) ? cfParseDateTimeText(arg) : null;
}

/** cffile `serverFileExt` of a client file name: the text after its last dot, '' without one. */
function uploadExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1);
}

/** The `id` argument of a method that reads it; legacy fails on an undefined `arguments.id`. */
function requiredId(call: JsonApiCall): string {
  if (call.id === undefined) throw new LegacyApiError('server_error');
  return call.id;
}

/** save's key (jsonApiUtility.cfc:1957-1967): a posted uuid or home id under `pk`, else `id`; `new` takes a fresh uuid. */
function saveKey(call: JsonApiCall, pk: string): string {
  const posted = call.params.string(pk);
  const id = isLegacyFindOneId(posted) ? posted : (call.id ?? 'new');
  return id === 'new' ? cfUuid() : id;
}

/** delete's key (jsonApiUtility.cfc:3312-3317): a posted uuid under `pk`, else the request `id`. */
function deleteKey(call: JsonApiCall, pk: string): string {
  const posted = call.params.string(pk);
  return isCfUuid(posted) ? posted : (call.id ?? '');
}

/** fileBean's instance after init (fileBean.cfc:3-33, beanORM.cfc:80-140, bean.cfc:89-105). */
function fileBeanDefaults(fileId: string, siteId: string, now: Date): Struct {
  return {
    fileid: fileId,
    contentid: '',
    siteid: siteId,
    filename: '',
    contenttype: '',
    contentsubtype: '',
    filesize: 0,
    fileext: '',
    moduleid: FILE_DEFAULT_MODULE_ID,
    created: now,
    deleted: 0,
    caption: '',
    credits: '',
    alttext: '',
    filefield: 'newfile',
    remoteid: '',
    remoteurl: '',
    remotepubdate: '',
    remotesource: '',
    remotesourceurl: '',
    exif: '',
    isnew: 1,
  };
}

/** contentFileMetaDataBean's instance after init; `directImages` is the site renderer's once a site is set (contentFileMetaDataBean.cfc:160-165). */
function metaBeanDefaults(metaId: string, siteId: string, directImages: boolean, now: Date): Struct {
  return {
    metaid: metaId,
    fileid: '',
    alttext: '',
    caption: '',
    credits: '',
    filename: '',
    filesize: 0,
    contenttype: '',
    contentsubtype: '',
    fileext: '',
    created: now,
    directimages: siteId === '' ? true : directImages,
    remoteid: '',
    remoteurl: '',
    remotepubdate: '',
    remotesource: '',
    remotesourceurl: '',
    exif: '',
    contentid: '',
    contenthistid: '',
    siteid: siteId,
    isnew: 1,
  };
}

// beanORM.loadBy also filters by the bean's site, which $.getBean set to the request site (cfobject.cfc:138-149,
// beanORM.cfc:766-768), so a pooled site's files, stored under the pool site, are not found from that site.
/** fileBean.loadBy(fileid, siteid): the file row of `siteId`, read in the token tenant's file pool tenant; null when none matches. */
function loadFileRow(ctx: RouteContext, call: JsonApiCall, fileId: string, siteId = call.siteId): Promise<FileRow | null> {
  return withPoolTenant(ctx.domain.db, call.tenantId, 'file', async (tx) => {
    const row = await ctx.domain.repository.files.readFileAll(tx, fileId);
    return row !== null && sameId(row.siteid, siteId) ? row : null;
  });
}

/** A stored file as the loaded bean holds it. */
function storedFileValues(row: FileRow, now: Date): Struct {
  return { ...fileBeanDefaults(row.fileid, '', now), ...beanColumns(row), isnew: 0 };
}

/** A stored metadata row and its loaded bean values. */
interface MetaRecord {
  meta: FileMetadataRow;
  values: Struct;
}

/**
 * contentFileMetaDataBean.loadBy(metaid, siteid): the request site's row with its file's joined columns, the file read in
 * the token tenant's file pool tenant; null when either is missing, as the load inner-joins tfiles.
 */
async function loadMetaRecord(ctx: RouteContext, call: JsonApiCall, metaId: string): Promise<MetaRecord | null> {
  const { db, repository, clock } = ctx.domain;
  const meta = await withTenant(db, call.tenantId, (tx) => repository.files.findFileMetadata(tx, { siteId: call.siteId, metaId }));
  const fileId = meta?.fileid ?? null;
  if (meta === null || fileId === null) return null;
  const file = await withPoolTenant(db, call.tenantId, 'file', (tx) => repository.files.readFileMeta(tx, fileId));
  if (file === null) return null;
  const joined = Object.fromEntries(JOINED_FILE_COLUMNS.map((column) => [column, beanValue(file[column])]));
  const values = { ...metaBeanDefaults(meta.metaid, call.siteId, call.site.urls.directImages, clock.now()), ...beanColumns(meta), ...joined, isnew: 0 };
  return { meta, values };
}

/** What the shared read handlers need of one entity. */
interface FileEntity {
  config: ContentEntityConfig;
  feedOptions: BeanFeedOptions;
  /** loadBy(pk=id, siteid): the stored bean's values, or null. */
  load(ctx: RouteContext, call: JsonApiCall, id: string): Promise<Struct | null>;
  /** A new bean's values under the key `id` and the site `siteId`. */
  fresh(ctx: RouteContext, call: JsonApiCall, id: string, siteId: string): Struct;
  /** Runs `use` in the rows' tenant over the entity feed of the request site (only rows of `ids` when given), before request params apply. */
  feed<T>(ctx: RouteContext, call: JsonApiCall, ids: readonly string[] | undefined, use: (source: BeanFeedSource<Struct>) => Promise<T>): Promise<T>;
  /** The bean an iterator builds from a feed row (beanIterator.cfc:98-101), narrowed to the selected columns. */
  item(ctx: RouteContext, call: JsonApiCall, row: Readonly<Struct>, selected?: ReadonlySet<string>): Struct;
  view(values: Struct): ApiEntityView;
}

const FILE: FileEntity = {
  config: FILE_CONFIG,
  feedOptions: {
    primaryKey: FILE_CONFIG.primaryKey,
    propertyNames: FILE_PROPERTY_NAMES,
    hints: FILE_CONFIG.hints,
    relations: FILE_CONFIG.hasOne,
    table: 'tfiles',
  },
  load: async (ctx, call, id) => {
    const row = await loadFileRow(ctx, call, id);
    return row === null ? null : storedFileValues(row, ctx.domain.clock.now());
  },
  fresh: (ctx, _call, id, siteId) => fileBeanDefaults(id, siteId, ctx.domain.clock.now()),
  feed: (ctx, call, ids, use) => {
    const { db, repository } = ctx.domain;
    return withPoolTenant(db, call.tenantId, 'file', (tx) =>
      use(projectedSource(ctx, call, tx, repository.files.siteFilesFeed(tx, { siteId: call.siteId, ids }))),
    );
  },
  item: (ctx, _call, row, selected) => {
    // setFileSize stores int(fileSize) (fileBean.cfc:42-45), which fails on the '' of a blank row.
    if (isBlankFeedRow(row) && (selected === undefined || selected.has('filesize'))) throw new LegacyApiError('server_error');
    return { ...fileBeanDefaults(cfUuid(), '', ctx.domain.clock.now()), ...beanColumns(setColumns(row, FILE_CONFIG.primaryKey), selected), isnew: 0 };
  },
  // The legacy oracle's file beans carry no `fileMetaData` back-reference, so no link or expansion names one.
  view: (values) => ({ entityName: 'file', configName: 'file', primaryKey: FILE_CONFIG.primaryKey, allValues: values, hasMany: [], hasOne: FILE_CONFIG.hasOne }),
};

const META: FileEntity = {
  config: META_CONFIG,
  feedOptions: {
    primaryKey: META_CONFIG.primaryKey,
    propertyNames: META_PROPERTY_NAMES,
    hints: META_CONFIG.hints,
    relations: META_CONFIG.hasOne,
    table: 'tcontentfilemetadata',
  },
  load: async (ctx, call, id) => (await loadMetaRecord(ctx, call, id))?.values ?? null,
  fresh: (ctx, call, id, siteId) => metaBeanDefaults(id, siteId, call.site.urls.directImages, ctx.domain.clock.now()),
  feed: (ctx, call, ids, use) => {
    const { db, repository } = ctx.domain;
    return withTenant(db, call.tenantId, (tx) =>
      use(projectedSource(ctx, call, tx, repository.files.siteFileMetadataFeed(tx, { siteId: call.siteId, ids }))),
    );
  },
  // A feed selects the table alone, so iterator beans carry no joined file columns.
  item: (ctx, call, row, selected) => {
    const values = beanColumns(setColumns(row, META_CONFIG.primaryKey), selected);
    const siteId = text(values['siteid']);
    return { ...metaBeanDefaults(cfUuid(), siteId, call.site.urls.directImages, ctx.domain.clock.now()), ...values, isnew: 0 };
  },
  view: (values) => ({
    entityName: 'fileMetaData',
    configName: 'fileMetaData',
    primaryKey: META_CONFIG.primaryKey,
    allValues: values,
    hasMany: META_CONFIG.hasMany,
    hasOne: META_CONFIG.hasOne,
  }),
};

/** loadBy(pk=id): the stored bean, else a new one holding the key, the site and loadBy's own arguments. */
async function loadOrNew(entity: FileEntity, ctx: RouteContext, call: JsonApiCall, id: string): Promise<Struct> {
  const stored = await entity.load(ctx, call, id);
  if (stored !== null) return stored;
  // set(arguments) skips an empty primary key, so the new bean keeps the id its init generated.
  return { ...entity.fresh(ctx, call, id === '' ? cfUuid() : id, call.siteId), ...NOT_FOUND_ARGUMENTS };
}

/** getFilteredValues of one bean under the entity's own config, with the finder's `expand` list; relations through their entities. */
function serializeBean(
  entity: FileEntity,
  call: JsonApiCall,
  values: Struct,
  opts: { expanded: number | boolean; editableCheck?: boolean },
): Promise<Struct> {
  return serializeContentEntity(entity.view(values), call.apiContext, relatedResolver(call), {
    expanded: opts.expanded,
    expandLinks: finderOf(call).expand,
    pk: entity.config.primaryKey,
    editableCheck: opts.editableCheck ?? false,
  });
}

/** findOne (jsonApiUtility.cfc:2292-2386); a missing row answers the new bean. */
function findOneHandler(entity: FileEntity): JsonApiHandlerFn {
  return async (ctx, call) => {
    paramUrl(call.apiContext, 'entityname', call.entityName);
    const id = requiredId(call);
    if (!entityAccessAllowed(call.actor, entity.config)) return authorizationDenied();
    const values = await loadOrNew(entity, ctx, call, id);
    const opts = { expanded: finderOf(call).expanded, editableCheck: true };
    return jsonApiResultOf(await serializeBean(entity, call, values, opts), entity.config.name);
  };
}

/** findNew (jsonApiUtility.cfc:2388-2422): a new bean under a fresh uuid. */
function findNewHandler(entity: FileEntity): JsonApiHandlerFn {
  return async (ctx, call) => {
    if (!entityAccessAllowed(call.actor, entity.config)) return authorizationDenied();
    const values = { ...entity.fresh(ctx, call, cfUuid(), call.siteId), ...NOT_FOUND_ARGUMENTS };
    return jsonApiResultOf(await serializeBean(entity, call, values, { expanded: true, editableCheck: true }), entity.config.name);
  };
}

/** The columns a feed's `fields` param selects (beanFeed.cfc:201-213): the listed names that are columns, or undefined for all. */
function selectedColumns(call: JsonApiCall, feedColumns: readonly string[]): ReadonlySet<string> | undefined {
  const columns = new Set(feedColumns);
  const fields = text(urlParam(call.apiContext, 'fields'))
    .split(',')
    .map((field) => field.trim().toLowerCase())
    .filter((field) => columns.has(field));
  return fields.length === 0 ? undefined : new Set(fields);
}

/** The entity feed source over `spec` in `tx`, whose returned rows hold only the columns {@link feedResult} keeps of them. */
function projectedSource(ctx: RouteContext, call: JsonApiCall, tx: TenantTx, spec: FeedTableSpec): BeanFeedSource<Struct> {
  // Read when rows are read, after the feed props appended the primary key to `fields`, as feedResult reads it.
  return ctx.domain.repository.beanFeed.source<Struct>((fn) => fn(tx), spec, () => selectedColumns(call, Object.keys(spec.columns)));
}

/** findMany's order (jsonApiUtility.cfc:2692-2705): for each requested id, the first item whose `id` matches it. */
function inIdsOrder(items: readonly Struct[], ids: readonly string[]): Struct[] {
  return ids.flatMap((id): Struct[] => {
    const item = items.find((candidate) => cfEq(text(candidate['id']), id));
    return item === undefined ? [] : [item];
  });
}

/** findAll, findQuery and findMany (jsonApiUtility.cfc:2542-2918) over the entity feed, narrowed to the rows of `scopeIds` when given. */
async function feedResult(entity: FileEntity, ctx: RouteContext, call: JsonApiCall, scopeIds?: readonly string[]): Promise<JsonApiResult> {
  const { result, columns } = await entity.feed(ctx, call, scopeIds, async (source) => ({
    result: await beanFeedQuery(source, call, entity.feedOptions),
    columns: source.columns,
  }));
  if ('count' in result) return jsonApiResultOf({ count: result.count }, entity.config.name);
  const selected = selectedColumns(call, columns);
  const views = result.items.map((row) => entity.view(entity.item(ctx, call, row, selected)));
  const items = await serializeEntityList(views, call.apiContext, { entityName: entity.config.name, ...finderOf(call) }, relatedResolver(call));
  const ids = cfEq(call.method, 'findMany') && text(urlParam(call.apiContext, 'sort')) === '' ? call.ids : undefined;
  const ordered = ids === undefined ? items : inIdsOrder(items, ids);
  const options = result.baseUrl === undefined ? {} : { baseUrl: result.baseUrl };
  return jsonApiResultOf(serializeCollection(ordered, result.page, call.apiContext, options), entity.config.name);
}

/** findAll and findQuery. */
function feedHandler(entity: FileEntity): JsonApiHandlerFn {
  return async (ctx, call) => {
    if (!entityAccessAllowed(call.actor, entity.config)) return authorizationDenied();
    return feedResult(entity, ctx, call);
  };
}

/** findMany: the feed narrowed to `pk in (ids)`. */
function findManyHandler(entity: FileEntity): JsonApiHandlerFn {
  return async (ctx, call) => {
    if (!entityAccessAllowed(call.actor, entity.config)) return authorizationDenied();
    const ids = call.ids;
    if (ids === undefined) throw new LegacyApiError('server_error');
    return feedResult(entity, ctx, call, ids);
  };
}

// Legacy findProperties and findPermissions run no AllowAccess check (jsonApiUtility.cfc:1005-1009, 1548, 2240).
/** findProperties from the entity registration. */
function findPropertiesHandler(entity: FileEntity): JsonApiHandlerFn {
  return (_ctx, call) => Promise.resolve(jsonApiResultOf(findPropertiesFor(entity.config, call), entity.config.name));
}

/** findPermissions (jsonApiUtility.cfc:2240-2264): whether loaded or new, the bean holds the request site. */
function findPermissionsHandler(entity: FileEntity): JsonApiHandlerFn {
  return (_ctx, call) => {
    if (call.id === undefined) return Promise.reject(new LegacyApiError('server_error'));
    const permissions = permissionsOf({
      hasSiteId: call.siteId !== '',
      readAllowed: entityAccessAllowed(call.actor, entity.config),
      actionAllowed: entityActionAllowed(call.actor, entity.config),
    });
    return Promise.resolve(jsonApiResultOf(permissions, entity.config.name));
  };
}

/** The save answer (jsonApiUtility.cfc:2028-2063): the bean reloaded by `id`, with empty `saveErrors` and `errors`. */
async function saveResult(entity: FileEntity, ctx: RouteContext, call: JsonApiCall, id: string): Promise<JsonApiResult> {
  const data = await serializeBean(entity, call, await loadOrNew(entity, ctx, call, id), { expanded: true });
  data['saveErrors'] = '';
  data['errors'] = {};
  return jsonApiResultOf(data, entity.config.name);
}

/**
 * JSON API save of a `file` (jsonApiUtility.cfc:1903-2074, fileBean.cfc:62-150): the part posted under `fileField` is
 * stored as a new file whatever key the request named, with the named bean's values, and the answer reloads the new id.
 */
async function saveFile(ctx: RouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  const id = saveKey(call, FILE_CONFIG.primaryKey);
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  if (!entityActionAllowed(call.actor, FILE_CONFIG)) return authorizationDenied();
  const fileField = (postedText(call, 'filefield') ?? 'newfile').toLowerCase();
  const file = call.files?.find((part) => part.fieldName.toLowerCase() === fileField);
  // Without a posted part legacy saves the bean values (beanORM.save) or fetches a URL or local path (emulateUpload); the
  // target has neither operation, so the save fails closed before anything is written.
  if (file === undefined) {
    throw new LegacyServiceUnavailableError('A file save without a posted file is not served by the target', 'auto', 'file-save-without-upload');
  }
  const ext = uploadExt(file.fileName);
  // The `{upload=image}` variant stays legacy-written (EX-FILE-RENDITION) and the gateway routes it to legacy; this guards direct calls.
  if (isImageUploadExt(ext)) throw new ImageUploadHaltedError(ext);

  const stored = await loadFileRow(ctx, call, id);
  const now = ctx.domain.clock.now();
  const bean = stored === null ? fileBeanDefaults(id, call.siteId, now) : storedFileValues(stored, now);
  const value = (name: string): string => postedText(call, name) ?? text(bean[name]);
  const postedPubDate = postedText(call, 'remotepubdate');
  const saved = await storeUploadedFile({ ...ctx.domain, storage: ctx.storage }, call.actor, {
    file,
    contentId: value('contentid'),
    moduleId: value('moduleid'),
    caption: value('caption'),
    credits: value('credits'),
    alttext: value('alttext'),
    remoteId: value('remoteid'),
    remoteUrl: value('remoteurl'),
    remotePubDate: postedPubDate === undefined ? (stored?.remotepubdate ?? null) : remotePubDateOf(postedPubDate),
    remoteSource: value('remotesource'),
    remoteSourceUrl: value('remotesourceurl'),
  });
  return saveResult(FILE, ctx, call, saved.fileid);
}

// A call without a tenant reaches no row, and no such caller holds the module permission a delete needs.
/** JSON API delete of a `file` (jsonApiUtility.cfc:3259-3335): beanORM.delete removes the row; a missing row answers ''. */
async function deleteFile(ctx: RouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  if (call.tenantId === '') return authorizationDenied();
  const row = await loadFileRow(ctx, call, deleteKey(call, FILE_CONFIG.primaryKey));
  if (row === null) return jsonApiResultOf('');
  if (!entityActionAllowed(call.actor, FILE_CONFIG)) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  await deleteFileEntity(ctx.domain, call.tenantId, row.fileid, writeContextFor(call.actor));
  return jsonApiResultOf('');
}

/**
 * JSON API save of a `fileMetaData` (jsonApiUtility.cfc:1903-2074, contentFileMetaDataBean.cfc:205-222) through
 * `saveFileMetaData`, which finds the row by version, file and content item, applying only the posted values.
 */
async function saveFileMetaDataCall(ctx: RouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  const id = saveKey(call, META_CONFIG.primaryKey);
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  if (!entityActionAllowed(call.actor, META_CONFIG)) return authorizationDenied();
  const loaded = (await loadMetaRecord(ctx, call, id))?.values;
  const fileId = postedText(call, 'fileid') ?? text(loaded?.['fileid']);
  // A new bean holding a posted fileid takes that file's columns, loaded under the file pool site (contentFileMetaDataBean.cfc:116-118).
  const file = loaded === undefined && fileId !== '' ? await loadFileRow(ctx, call, fileId, call.site.urls.filePoolId) : null;
  const contentId = postedText(call, 'contentid') ?? text(loaded?.['contentid'] ?? beanValue(file?.contentid));
  const contentHistId = postedText(call, 'contenthistid') ?? text(loaded?.['contenthistid']);
  const values: FileMetaDataValues = {};
  for (const column of META_POSTED_COLUMNS) {
    const posted = postedText(call, column);
    if (posted !== undefined) values[column] = posted;
  }
  const saved = await saveFileMetaDataEntity(
    ctx.domain,
    call.tenantId,
    { contentId, contentHistId, siteId: call.siteId, fileId, values, setAsDefault: false },
    writeContextFor(call.actor),
  );
  return saveResult(META, ctx, call, saved.metaid);
}

// A call without a tenant reaches no row, and no such caller holds the module permission a delete needs.
/** JSON API delete of a `fileMetaData`: beanORM.delete removes the row; a missing row, or one whose file is gone, answers ''. */
async function deleteFileMetaDataCall(ctx: RouteContext, call: JsonApiCall): Promise<JsonApiResult> {
  if (call.tenantId === '') return authorizationDenied();
  const record = await loadMetaRecord(ctx, call, deleteKey(call, META_CONFIG.primaryKey));
  if (record === null) return jsonApiResultOf('');
  if (!entityActionAllowed(call.actor, META_CONFIG)) return authorizationDenied();
  if (!(await call.validateCsrf())) return { error: 'invalidTokens' };
  await deleteFileMetaDataEntity(ctx.domain, call.tenantId, record.meta.metaid, writeContextFor(call.actor));
  return jsonApiResultOf('');
}

/** The `file` entity (jsonApiUtility.cfc:98): non-public, Site Manager module. */
export const fileHandler: EntityHandler = {
  entity: 'file',
  config: FILE_CONFIG,
  validate,
  findOne: findOneHandler(FILE),
  findNew: findNewHandler(FILE),
  findMany: findManyHandler(FILE),
  findAll: feedHandler(FILE),
  findQuery: feedHandler(FILE),
  findProperties: findPropertiesHandler(FILE),
  findPermissions: findPermissionsHandler(FILE),
  save: saveFile,
  delete: deleteFile,
};

/**
 * contentFileMetaDataBean.loadBy as a relation path's source: by `metaid`, or by `contentid` the site's first row of the
 * item whose file exists; a bean no row backs holds loadBy's arguments.
 */
async function loadFileMetaDataBy(ctx: RouteContext, call: JsonApiCall, key: RelationSourceKey): Promise<SourceBeanGetter> {
  let values: Struct;
  if ('primaryKey' in key) {
    values = await loadOrNew(META, ctx, call, key.primaryKey);
  } else {
    const rows = await withTenant(ctx.domain.db, call.tenantId, (tx) => ctx.domain.repository.files.listFileMetadata(tx, { siteId: call.siteId }));
    const contentId = key.contentid.trimEnd().toLowerCase();
    let record: MetaRecord | null = null;
    for (const row of rows.filter((candidate) => (candidate.contentid ?? '').trimEnd().toLowerCase() === contentId)) {
      record = await loadMetaRecord(ctx, call, row.metaid);
      if (record !== null) break;
    }
    values = record?.values ?? { ...META.fresh(ctx, call, cfUuid(), call.siteId), ...NOT_FOUND_ARGUMENTS, contentid: key.contentid };
  }
  return (name) => values[(cfEq(name, 'primaryKey') ? META_CONFIG.primaryKey : name).toLowerCase()];
}

/** The `fileMetaData` entity (jsonApiUtility.cfc:99): non-public, Site Manager module. */
export const fileMetaDataHandler: EntityHandler = {
  entity: 'fileMetaData',
  config: META_CONFIG,
  validate,
  findOne: findOneHandler(META),
  findNew: findNewHandler(META),
  findMany: findManyHandler(META),
  findAll: feedHandler(META),
  findQuery: feedHandler(META),
  findProperties: findPropertiesHandler(META),
  findPermissions: findPermissionsHandler(META),
  save: saveFileMetaDataCall,
  delete: deleteFileMetaDataCall,
  loadBy: loadFileMetaDataBy,
};
