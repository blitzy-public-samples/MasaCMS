/** JSON API `validate` of every strategies-content entity route (core/mura/client/api/json/v1/jsonApiUtility.cfc:3703-3808). */
import { cfEq, cfTimestampText, cfUuid, javaTrim, LEGACY_ADMIN_SENTINEL_ID, LegacyApiError } from '@opt2/platform/legacy-compat';
import { registryEntries, withTenant } from '@opt2/platform/tenancy';
import { listPoolCategories, newCategoryBean, readCategory, type CategoryReadKey } from '../../domain/categories.js';
import { findChangesetCategoryAssignment, loadChangeset } from '../../domain/changesets.js';
import { findCommentValues } from '../../domain/comments.js';
import { contentValidateChecks, DisplayConflictsUnsupportedError, LegacyContentBean, type ContentBeanChecks } from '../../domain/content.js';
import { readContent, type ContentRef } from '../../domain/content-tree.js';
import type { Actor } from '../../domain/context.js';
import { FeedBean, readFeed, type FeedReadKey } from '../../domain/feeds.js';
import { withPoolTenant } from '../../domain/pools.js';
import { findVariationTargeting, variationsEnabled } from '../../domain/variations.js';
import { CONTENT_ENTITIES, type ContentEntityConfig } from '../../legacy/jsonapi-entities.js';
// Type-only: ../index.ts imports ../jsonapi.ts, which imports this folder.
import type { ContentRouteContext } from '../index.js';
import { BEAN_MODELS, ormInitValues, type BeanModel } from './bean-metadata.js';
import {
  appendErrors,
  errorsObject,
  possiblyUrl,
  stringArgument,
  validateAdHoc,
  validateBeanRules,
  type ValidatedBean,
  type ValidationContext,
  type ValidationErrors,
} from './bean-validator.js';
import { CF_QUERY, CfNumber, CfStruct, cfUrlDecode, cfValueOf, deserializeCfJson, isSimple, simpleText, validateHalted, type CfValue } from './cfml-values.js';
import { entityAccessAllowed, type JsonApiCall, type JsonApiHandlerFn, type JsonApiResult } from './types.js';

/** What one validate call reads. */
interface Scope {
  ctx: ContentRouteContext;
  call: JsonApiCall;
  /** The acting user in the call's tenant and site. */
  reader: Actor;
  context: ValidationContext;
}

/** A CFML runtime error processRequest's `catch (Any e)` answers with the legacy 500. */
function serverError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/** A simple value as a `string` argument or a comparison reads it; a complex one raises. */
function simpleArgument(value: CfValue): string {
  if (!isSimple(value)) throw serverError();
  return simpleText(value);
}

/** A data value that is set: neither absent nor a JSON null, as `isDefined` reads it. */
function isSet(value: CfValue | null | undefined): value is CfValue {
  return value !== null && value !== undefined;
}

/** A bean value as CFML holds it: dates as their `{ts …}` text, NULL as '', bytes as ACF serializes binary. */
function beanValue(value: unknown): CfValue {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return cfTimestampText(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return cfValueOf(value) ?? '';
}

/** A stored column as `set(query)` leaves it on a bean: as beanValue, text trimmed by setValue. */
function columnValue(value: unknown): CfValue {
  return typeof value === 'string' ? javaTrim(value) : beanValue(value);
}

/** bean.cfc setValue of a property without a setter: a simple value trimmed (bean.cfc:417-440). */
function setValueOf(value: CfValue): CfValue {
  return isSimple(value) ? javaTrim(simpleText(value)) : value;
}

// ---- the request ----

/**
 * A `data` or `validations` argument: text urlDecoded and read as JSON, else invalidParameters; a JSON body value as
 * posted, and the `'{}'` default for one argumentCollection does not pass, a JSON null included (3705-3723).
 */
function argumentValue(call: JsonApiCall, name: 'data' | 'validations'): CfValue | null | symbol {
  const posted = call.params.get(name);
  const value = cfValueOf(posted ?? '{}');
  if (value === null || !isSimple(value)) return value;
  const parsed = deserializeCfJson(cfUrlDecode(simpleText(value)));
  if (parsed === undefined) throw new LegacyApiError('invalidParameters');
  return parsed;
}

/** The request's `siteid` param as posted, which processRequest defaults to the API site (869-883). */
function postedSite(call: JsonApiCall): unknown {
  return call.params.has('siteid') ? call.params.get('siteid') : call.siteId;
}

/** `arguments.siteid` as CFML holds it. */
function siteArgument(call: JsonApiCall): CfValue {
  return cfValueOf(postedSite(call)) ?? '';
}

/** The posted `data` struct, which argumentCollection passes by reference, so validate's writes show in the echoed params. */
function postedData(call: JsonApiCall): Record<string, unknown> | undefined {
  const posted = call.params.get('data');
  return typeof posted === 'object' && posted !== null && !Array.isArray(posted) ? (posted as Record<string, unknown>) : undefined;
}

/** `arguments.data[name] = value`: the validation struct and, case-insensitively, the posted struct it was read from. */
function setData(scope: Scope, name: string, value: CfValue, posted: unknown = value): void {
  scope.context.data.set(name, value);
  const record = postedData(scope.call);
  if (record === undefined) return;
  const key = Object.keys(record).find((candidate) => cfEq(candidate, name)) ?? name;
  Object.defineProperty(record, key, { value: posted, writable: true, enumerable: true, configurable: true });
}

/** `getBean('Mura').init(siteid)`: a struct is the event's own data; an array, or a struct's complex site, raises (MuraScope.cfc:85-96). */
function assertEventSite(site: CfValue): void {
  if (Array.isArray(site) || site === CF_QUERY) throw serverError();
  if (site instanceof CfStruct) {
    const own = site.get('siteid');
    if (isSet(own)) simpleArgument(own);
  }
}

/** Whether the request is multipart, whose ACF form scope holds each uploaded part as its temporary file path. */
function isMultipart(call: JsonApiCall): boolean {
  return (call.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
}

/** CFML `listLast(text, '.')`. */
function lastDotItem(text: string): string {
  return text.split('.').filter((item) => item !== '').at(-1) ?? '';
}

/** fileManager.isPostedFile(name): a form field whose value's last `.` item is tmp or upload, or such a name (fileManager.cfc:651-654). */
function isPostedFile(call: JsonApiCall, name: string): boolean {
  const upload = (text: string): boolean => ['tmp', 'upload'].some((ext) => cfEq(lastDotItem(text), ext));
  if (upload(name)) return true;
  const key = Object.keys(call.apiContext.form).find((candidate) => cfEq(candidate, name));
  if (key === undefined) return false;
  // The target's form scope holds an uploaded part as its client file name, not the temporary path ACF gives it.
  if (isMultipart(call)) throw validateHalted('A multipart form field fileManager.isPostedFile reads', 'validate-multipart-form');
  const value = call.apiContext.form[key];
  return upload(typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : '');
}

// ---- beans ----

/** A bean's `variables.instance` with its class's getters, hasProperty and getProperties. */
class InstanceBean implements ValidatedBean {
  readonly instance = new CfStruct();

  constructor(
    readonly model: BeanModel,
    values: Iterable<readonly [string, unknown]>,
    private readonly getters: ReadonlyMap<string, (bean: InstanceBean) => CfValue> = new Map(),
  ) {
    for (const [key, value] of values) this.instance.set(key, beanValue(value));
  }

  value(property: string): CfValue {
    const getter = this.getters.get(property.toLowerCase());
    return getter === undefined ? this.raw(property) : getter(this);
  }

  /** `variables.instance[property]`, '' when unset. */
  raw(property: string): CfValue {
    return this.instance.get(property) ?? '';
  }

  hasProperty(property: string): boolean {
    return this.model.hasProperty(property);
  }

  /** bean.cfc setValue of a property without a setter. */
  setValue(property: string, value: CfValue): void {
    this.instance.set(property, setValueOf(value));
  }
}

/** A getter that creates the id on first read of an empty one, as getCommentID and getChangesetID do. */
function idGetter(property: string): [string, (bean: InstanceBean) => CfValue] {
  return [
    property.toLowerCase(),
    (bean) => {
      if (simpleArgument(bean.raw(property)) === '') bean.instance.set(property, cfUuid());
      return bean.raw(property);
    },
  ];
}

/** The content bean's getValue, hasProperty and generated rules. */
function contentValidated(bean: LegacyContentBean): ValidatedBean {
  return { value: (property) => beanValue(bean.get(property)), hasProperty: (property) => BEAN_MODELS.content.hasProperty(property) };
}

// ---- the beans' own validate ----

/** bean.validate(fields) (bean.cfc:487-545): the generated rules, filtered by `fields`. */
function beanValidate(scope: Scope, bean: InstanceBean, fields: CfValue): ValidationErrors {
  return validateBeanRules(bean, bean.model.validations, scope.context, fields);
}

/** beanORM.validate() (beanORM.cfc:368-377), which takes no fields: the generated rules, then a primary key it requires. */
function ormValidate(scope: Scope, bean: InstanceBean, primaryKey: string): ValidationErrors {
  const errors = validateBeanRules(bean, bean.model.validations, scope.context, undefined);
  const property = [...bean.model.properties].find(([name]) => cfEq(name, primaryKey))?.[1];
  const persistent = property !== undefined && property.get('persistent') === true;
  if (primaryKey === '' || !persistent || simpleArgument(bean.raw(primaryKey)) === '' || primaryKey === 'primarykey') {
    errors.set('primarykey', `The primary key '${primaryKey}' is required.`);
  }
  return errors;
}

/** The lower-cased names of the API site's File extend attributes, as extendManager.isFileAttribute finds them (extendManager.cfc:188-252). */
async function siteFileAttributes(scope: Scope): Promise<ReadonlySet<string>> {
  const { db, repository } = scope.ctx.domain;
  return withTenant(db, scope.call.tenantId, async (tx) => {
    const names = new Set<string>();
    for (const subtype of await repository.extend.subtypes(tx, { siteId: scope.call.siteId })) {
      for (const set of await repository.extend.setsForSubtype(tx, { subTypeId: subtype.subtypeid })) {
        for (const attribute of await repository.extend.attributesForSet(tx, { extendSetId: set.extendsetid })) {
          if (cfEq(attribute.type ?? '', 'file')) names.add((attribute.name ?? '').toLowerCase());
        }
      }
    }
    return names;
  });
}

/** fileBean.validate: beanORM's, then fileManager.requestHasRestrictedFiles over the bean's values (fileBean.cfc:54-75; fileManager.cfc:656-728). */
async function fileValidate(scope: Scope, bean: InstanceBean): Promise<ValidationErrors> {
  const errors = ormValidate(scope, bean, 'fileid');
  if (scope.ctx.domain.config.fmAllowedExtensions === '') return errors;
  const urlKeys: string[] = [];
  for (const key of bean.instance.keys()) {
    const value = bean.instance.get(key);
    if (!isSet(value) || !isSimple(value)) continue;
    // A posted file's client name decides; ACF reads it from the multipart parts array, which this request does not carry.
    if (scope.context.isPostedFile(key)) throw validateHalted('A file bean value fileManager.isPostedFile accepts', 'validate-posted-file');
    const text = simpleText(value);
    if (possiblyUrl(text) && !text.endsWith('/')) urlKeys.push(key);
  }
  // A URL under any other key ends the scan unrestricted, so only a File attribute's isValid('url') verdict can restrict.
  if (urlKeys.length === 0) return errors;
  const site = bean.raw('siteid');
  if (isSimple(site) && simpleText(site) === '') return errors;
  if (!isSimple(site) || !sameId(simpleText(site), scope.call.siteId)) {
    throw validateHalted("A file bean's URL value under another site's attributes", 'validate-other-site');
  }
  const fileAttributes = await siteFileAttributes(scope);
  if (urlKeys.some((key) => fileAttributes.has(key.toLowerCase()))) {
    throw validateHalted("A File attribute's URL value read by isValid('url')", 'validate-isvalid-pattern');
  }
  return errors;
}

/** The registered sites `settingsManager.siteExists` knows. */
async function registeredSiteIds(scope: Scope): Promise<string[]> {
  return (await registryEntries(scope.ctx.domain.db)).map((entry) => entry.siteId);
}

/** contentBean.validate's own checks, a calendar's display-conflict search halting (contentIntervalManager.findConflicts). */
async function contentChecks(scope: Scope, bean: LegacyContentBean): Promise<ContentBeanChecks> {
  const { ctx, call, reader } = scope;
  const homeChild = !call.site.urls.siteIdInUrls && cfEq(bean.text('parentid'), LEGACY_ADMIN_SENTINEL_ID);
  const opts = homeChild ? { siteIds: await registeredSiteIds(scope) } : {};
  try {
    return await contentValidateChecks({ ...ctx.domain, storage: ctx.storage }, reader, call.site, bean, opts);
  } catch (err) {
    if (err instanceof DisplayConflictsUnsupportedError) throw validateHalted('A calendar display-conflict check', 'validate-display-conflicts');
    throw err;
  }
}

/** contentBean.validate() (contentBean.cfc:467-526), which takes no fields: the generated rules, extend values, then its own checks. */
async function contentValidate(scope: Scope, bean: LegacyContentBean): Promise<ValidationErrors> {
  const errors = validateBeanRules(contentValidated(bean), BEAN_MODELS.content.validations, scope.context, undefined);
  const found = await contentChecks(scope, bean);
  for (const assignments of [found.extended, found.checks]) {
    const struct = new CfStruct();
    for (const [key, message] of assignments) struct.set(key, message);
    appendErrors(errors, struct);
  }
  return errors;
}

// ---- loading ----

/** The site of a loadby branch's `loadBy(…, siteid=data.siteid)`: the API site, else the halt for another site's data. */
function loadBySite(scope: Scope, site: CfValue): string {
  const siteId = simpleArgument(site);
  if (siteId !== '' && !sameId(siteId, scope.call.siteId)) {
    throw validateHalted("A loadby of another site's bean", 'validate-other-site');
  }
  return siteId;
}

/** contentManager.read of `ref` on the bean getBean gave `siteId`: the stored version, else the new bean (contentManager.cfc:359-388). */
async function loadContent(scope: Scope, ref: Omit<ContentRef, 'siteId'>, siteId: string): Promise<LegacyContentBean> {
  // "A 'SITEID' is required in order to read content."
  if (siteId === '') throw serverError();
  const read = await readContent(scope.ctx.domain, scope.reader, { ...ref, siteId });
  const now = scope.ctx.domain.clock.now();
  return read.isNew === 0 ? LegacyContentBean.fromVersion(read.version, scope.reader, now) : LegacyContentBean.notFound(scope.reader, now, read.values.siteid);
}

/** contentManager.read's keys a loadby names (contentManager.cfc:360-370); its other arguments steer the read itself. */
const CONTENT_READ_KEYS: Readonly<Record<string, keyof ContentRef>> = Object.freeze({
  contentid: 'contentId',
  contenthistid: 'contentHistId',
  filename: 'filename',
  remoteid: 'remoteId',
  title: 'title',
  urltitle: 'urlTitle',
});
const CONTENT_READ_CONTROLS: ReadonlySet<string> = new Set(['use404', 'contentbean', 'type', 'sourceiterator']);

/** setSiteID through beanExtendable.setValue: a trimmed, non-empty site other than the bean's (beanExtendable.cfc:131-137,236-249). */
function setContentSite(bean: LegacyContentBean, site: CfValue): void {
  // setSiteID takes a `string` argument.
  const siteId = javaTrim(simpleArgument(site));
  if (siteId === '' || cfEq(siteId, bean.text('siteid'))) return;
  // The bean's own checks would then read that site's extend definitions, titles and renderer.
  throw validateHalted("Validating a content bean set to another site's id", 'validate-other-site');
}

/** One content bean `validate` loads: getBean(name)'s class as the entity and loadby branches use it. */
interface ValidatedEntity {
  name: string;
  /** getPrimaryKey(). */
  primaryKey: string;
  /** AllowAccess(bean, $) (jsonApiUtility.cfc:1686-1738). */
  allowed: (scope: Scope) => boolean;
  /** loadBy(pk=id) on the bean getBean gave the API site, set('siteid'), set(pk), then validate(fields) (3760-3765). */
  entity: (scope: Scope, id: CfValue, site: CfValue, fields: CfValue) => Promise<ValidationErrors>;
  /** loadBy(column=value, siteid=site), then validate(fields) (3801-3803). */
  loadBy: (scope: Scope, column: string, value: CfValue, site: CfValue, fields: CfValue) => Promise<ValidationErrors>;
}

/** The halt of a loadby over a column the bean's read does not take as a key. */
function loadByColumnHalted(name: string, column: string): never {
  throw validateHalted(`A ${name} loadby of ${column}`, 'validate-loadby-column');
}

const content: ValidatedEntity = {
  name: 'content',
  primaryKey: 'contentid',
  allowed: (scope) => entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.content),
  async entity(scope, id, site) {
    // contentManager.read's len() of a complex id raises.
    const contentId = simpleArgument(id);
    const bean = await loadContent(scope, { contentId }, scope.call.siteId);
    setContentSite(bean, site);
    bean.setValue('contentid', javaTrim(contentId));
    return contentValidate(scope, bean);
  },
  async loadBy(scope, column, value, site) {
    const siteId = loadBySite(scope, site);
    const key = column.toLowerCase();
    if (CONTENT_READ_CONTROLS.has(key)) loadByColumnHalted('content', column);
    const refKey = CONTENT_READ_KEYS[key];
    // The read's `string`-less arguments still pass through len(), which raises for a complex value.
    const ref: Omit<ContentRef, 'siteId'> = refKey === undefined ? {} : { [refKey]: simpleArgument(value) };
    return contentValidate(scope, await loadContent(scope, ref, siteId));
  },
};

/** The bean of a category read: a loaded one, or the fresh bean legacy keeps when several match (categoryDAO.cfc:146-180). */
async function categoryBean(scope: Scope, key: string | CategoryReadKey): Promise<InstanceBean> {
  const read = await readCategory(scope.ctx.domain, scope.reader, key as CategoryReadKey);
  const values = Array.isArray(read) ? { ...newCategoryBean(scope.ctx.domain.clock), siteid: scope.call.siteId } : read;
  return new InstanceBean(BEAN_MODELS.category, Object.entries(values));
}

const CATEGORY_READ_KEYS: Readonly<Record<string, keyof CategoryReadKey>> = Object.freeze({
  categoryid: 'categoryId',
  name: 'name',
  remoteid: 'remoteId',
  filename: 'filename',
  urltitle: 'urlTitle',
});

const category: ValidatedEntity = {
  name: 'category',
  primaryKey: 'categoryid',
  allowed: (scope) => entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.category),
  async entity(scope, id, site, fields) {
    const bean = await categoryBean(scope, { categoryId: simpleArgument(id), siteId: scope.call.siteId });
    bean.setValue('siteid', site);
    bean.setValue('categoryid', id);
    return beanValidate(scope, bean, fields);
  },
  async loadBy(scope, column, value, site, fields) {
    const siteId = loadBySite(scope, site);
    const key = column.toLowerCase();
    if (key === 'categorybean') loadByColumnHalted('category', column);
    // An empty site makes categoryManager.read take the session's (categoryManager.cfc:369-371).
    if (siteId === '') throw validateHalted("A category loadby reading the session's site", 'validate-session-site');
    const readKey = CATEGORY_READ_KEYS[key];
    const bean = await categoryBean(scope, readKey === undefined ? { siteId } : { [readKey]: simpleArgument(value), siteId });
    return beanValidate(scope, bean, fields);
  },
};

/** The values of a comment `loadBy` leaves: the stored row, else the fresh bean (contentCommentBean.cfc:226-233). */
async function commentBean(scope: Scope, commentId: string): Promise<InstanceBean> {
  const values = await findCommentValues(scope.ctx.domain, scope.call.tenantId, commentId, { scheme: scope.call.site.urls.scheme });
  return new InstanceBean(BEAN_MODELS.comment, Object.entries(values), new Map([idGetter('commentID')]));
}

const comment: ValidatedEntity = {
  name: 'comment',
  primaryKey: 'commentid',
  allowed: (scope) => entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.comment),
  async entity(scope, id, site, fields) {
    const bean = await commentBean(scope, simpleArgument(id));
    bean.setValue('siteid', site);
    bean.setValue('commentid', id);
    return beanValidate(scope, bean, fields);
  },
  async loadBy(scope, column, value, _site, fields) {
    const key = column.toLowerCase();
    // getQuery selects by remoteID alone, the first of several matching rows in SQL Server's scan order.
    if (key === 'remoteid') loadByColumnHalted('comment', column);
    // Any other column leaves getQuery the bean's own fresh id, which no row holds.
    const bean = await commentBean(scope, key === 'commentid' ? simpleArgument(value) : cfUuid());
    return beanValidate(scope, bean, fields);
  },
};

/** The feed bean's getters of its rule properties whose value differs from the instance's (feedBean.cfc:272-279,460-509). */
function feedGetters(feed: Awaited<ReturnType<typeof readFeed>>): ReadonlyMap<string, (bean: InstanceBean) => CfValue> {
  return new Map<string, (bean: InstanceBean) => CfValue>([
    ...['imagesize', 'imageheight', 'imagewidth'].map((key): [string, () => CfValue] => [key, () => beanValue(feed.get(key))]),
    ['contentpoolid', (bean) => (simpleArgument(bean.raw('contentpoolid')) === '' ? bean.raw('siteid') : bean.raw('contentpoolid'))],
  ]);
}

/** Whether readByName or readByRemoteID finds several feeds, which leaves the bean they were given fresh (feedDAO.cfc:178-251). */
async function severalFeedsMatch(scope: Scope, key: FeedReadKey): Promise<boolean> {
  const siteId = key.siteId ?? '';
  if ((key.feedId ?? '') !== '' || siteId === '') return false;
  const [column, value] = (key.name ?? '') !== '' ? (['name', key.name ?? ''] as const) : (['remoteid', key.remoteId ?? ''] as const);
  if (value === '') return false;
  const { db, repository } = scope.ctx.domain;
  return (await withTenant(db, scope.call.tenantId, (tx) => repository.feeds.feedMatchCount(tx, { siteId, column, value }))) > 1;
}

/** feedManager.read of `key` (feedManager.cfc:190-244) on the bean getBean gave the API site. */
async function feedBean(scope: Scope, key: FeedReadKey): Promise<InstanceBean> {
  const fresh = (): FeedBean => {
    const bean = FeedBean.init(scope.ctx.domain.clock);
    bean.put('siteid', scope.call.siteId);
    return bean;
  };
  const feed = (await severalFeedsMatch(scope, key)) ? fresh() : await readFeed(scope.ctx.domain, scope.reader, key);
  // The required displayList rule reads getDisplayList, which fills an empty list from the site renderer's CFML settings.
  if (feed.text('displaylist') === '' && !scope.context.data.has('displaylist')) {
    throw validateHalted("A feed's renderer display list", 'validate-renderer-setting');
  }
  return new InstanceBean(BEAN_MODELS.feed, feed.entries(), feedGetters(feed));
}

const feed: ValidatedEntity = {
  name: 'feed',
  primaryKey: 'feedID',
  // feedBean.getEntityName() answers `content`, whose registration AllowAccess then reads (feedBean.cfc:771-778).
  allowed: (scope) => entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.content),
  async entity(scope, id, site, fields) {
    const bean = await feedBean(scope, { feedId: simpleArgument(id), siteId: scope.call.siteId });
    bean.setValue('siteid', site);
    bean.setValue('feedid', id);
    return beanValidate(scope, bean, fields);
  },
  async loadBy(scope, column, value, site, fields) {
    const siteId = loadBySite(scope, site);
    const key = column.toLowerCase();
    // loadBy passes the bean itself as `feedBean`, so that column reads like any other the read does not take.
    const text = (name: string): string => (key === name ? simpleArgument(value) : '');
    const bean = await feedBean(scope, { feedId: text('feedid'), name: text('name'), remoteId: text('remoteid'), siteId });
    return beanValidate(scope, bean, fields);
  },
};

/** changesetBean.loadBy(changesetID) on the bean of `siteId`: the site's stored change set, else a new one. */
async function changesetBean(scope: Scope, changesetId: string, siteId: string): Promise<InstanceBean> {
  const values = await loadChangeset(scope.ctx.domain, scope.reader, { changesetId, siteId });
  return new InstanceBean(BEAN_MODELS.changeset, Object.entries(values), new Map([idGetter('changesetID')]));
}

const changeset: ValidatedEntity = {
  name: 'changeset',
  primaryKey: 'changesetID',
  allowed: (scope) => entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.changeset),
  async entity(scope, id, site, fields) {
    const bean = await changesetBean(scope, simpleArgument(id), scope.call.siteId);
    bean.setValue('siteid', site);
    bean.setValue('changesetid', id);
    return beanValidate(scope, bean, fields);
  },
  async loadBy(scope, column, value, site, fields) {
    const siteId = loadBySite(scope, site);
    // By name or remote id, set(rs) takes the first of several matching rows in SQL Server's scan order.
    if (!cfEq(column, 'changesetid')) loadByColumnHalted('changeset', column);
    // Without a site, changesetManager.read selects the id among every site's change sets (changesetManager.cfc:42-57).
    if (siteId === '') throw validateHalted('A changeset loadby without a site', 'validate-other-site');
    return beanValidate(scope, await changesetBean(scope, simpleArgument(value), siteId), fields);
  },
};

/** loadBy's own arguments, which `set(arguments)` stores on a bean no row matches (beanORM.cfc:750,912-916). */
const LOAD_BY_ARGUMENTS: ReadonlyArray<readonly [string, CfValue]> = [
  ['returnFormat', 'self'],
  ['cachedWithin', new CfNumber('0', 0)],
];

/** A beanORM bean after loadBy(pk=id, siteid): the stored row over its init values, else those with loadBy's arguments (beanORM.cfc:87-144,750-916). */
function ormBean(scope: Scope, model: BeanModel, key: { primaryKey: string; id: string; siteId: string }, row: Readonly<Record<string, unknown>> | null): InstanceBean {
  const bean = new InstanceBean(model, []);
  const init = ormInitValues(model, cfTimestampText(scope.ctx.domain.clock.now()));
  for (const name of init.assigned()) bean.instance.set(name, init.get(name) ?? '');
  bean.setValue('siteid', scope.call.siteId);
  if (row !== null) {
    for (const [column, value] of Object.entries(row)) if (column !== 'tenant_id') bean.instance.set(column, columnValue(value));
    return bean;
  }
  // set(struct) skips an empty primary key (bean.cfc:333).
  if (key.primaryKey !== '' && key.id !== '') bean.setValue(key.primaryKey, key.id);
  bean.setValue('siteid', key.siteId);
  for (const [name, value] of LOAD_BY_ARGUMENTS) bean.setValue(name, value);
  return bean;
}

/** An id or site id as SQL Server compares it: trailing spaces dropped, case ignored. */
function idKey(value: string | null): string {
  return (value ?? '').replace(/ +$/u, '').toLowerCase();
}

function sameId(a: string | null, b: string): boolean {
  return idKey(a) === idKey(b);
}

/** One beanORM entity: its loadBy(pk=id, siteid) read and its own validate. */
interface OrmEntitySpec {
  name: 'file' | 'fileMetaData' | 'changesetCategoryAssignment' | 'variationTargeting';
  model: BeanModel;
  primaryKey: string;
  allowed: (scope: Scope) => boolean;
  /** The stored row of `id` in the API site, or null. */
  row: (scope: Scope, id: string) => Promise<Readonly<Record<string, unknown>> | null>;
  /** set('siteid', site) through the bean's setter. */
  setSite?: (bean: InstanceBean, site: CfValue) => void;
  validate: (scope: Scope, bean: InstanceBean) => ValidationErrors | Promise<ValidationErrors>;
}

/** A beanORM entity, whose loadby is served by its primary key alone. */
function ormEntity(spec: OrmEntitySpec): ValidatedEntity {
  const load = async (scope: Scope, id: string, siteId: string): Promise<InstanceBean> => {
    // No row has an empty key or site (`where <pk> = '' and siteid = …`).
    const row = id === '' || siteId === '' ? null : await spec.row(scope, id);
    return ormBean(scope, spec.model, { primaryKey: spec.primaryKey, id, siteId }, row);
  };
  return {
    name: spec.name,
    primaryKey: spec.primaryKey,
    allowed: spec.allowed,
    async entity(scope, id, site) {
      // addQueryParam of a complex key raises.
      const bean = await load(scope, simpleArgument(id), scope.call.siteId);
      if (spec.setSite === undefined) bean.setValue('siteid', site);
      else spec.setSite(bean, site);
      bean.setValue(spec.primaryKey, id);
      return spec.validate(scope, bean);
    },
    async loadBy(scope, column, value, site) {
      const siteId = loadBySite(scope, site);
      // beanORM.loadBy over any other column reads the first matching row in SQL Server's unordered scan (beanORM.cfc:799-916).
      if (!cfEq(column, spec.primaryKey)) loadByColumnHalted(spec.name, column);
      return spec.validate(scope, await load(scope, simpleArgument(value), siteId));
    },
  };
}

/** AllowAccess of a registered entity: public, else its module permission. */
function moduleAccess(config: ContentEntityConfig): (scope: Scope) => boolean {
  return (scope) => entityAccessAllowed(scope.call.actor, config);
}

const file = ormEntity({
  name: 'file',
  model: BEAN_MODELS.file,
  primaryKey: 'fileid',
  allowed: moduleAccess(CONTENT_ENTITIES.file),
  // beanORM.loadBy filters by the bean's site; files live in the token tenant's file pool tenant.
  row: (scope, id) =>
    withPoolTenant(scope.ctx.domain.db, scope.call.tenantId, 'file', async (tx) => {
      const row = await scope.ctx.domain.repository.files.readFileAll(tx, id);
      return row !== null && sameId(row.siteid, scope.call.siteId) ? row : null;
    }),
  validate: fileValidate,
});

/** The `tfiles` columns contentFileMetaDataBean's load joins in (contentFileMetaDataBean.cfc:131-136). */
const META_FILE_COLUMNS = ['filename', 'filesize', 'contenttype', 'contentsubtype', 'fileext', 'created'] as const;

const fileMetaData = ormEntity({
  name: 'fileMetaData',
  model: BEAN_MODELS.fileMetaData,
  primaryKey: 'metaID',
  allowed: moduleAccess(CONTENT_ENTITIES.fileMetaData),
  // The load inner-joins tfiles, read in the token tenant's file pool tenant.
  async row(scope, id) {
    const { db, repository } = scope.ctx.domain;
    const meta = await withTenant(db, scope.call.tenantId, (tx) => repository.files.findFileMetadata(tx, { siteId: scope.call.siteId, metaId: id }));
    const fileId = meta?.fileid ?? null;
    if (meta === null || fileId === null) return null;
    const stored = await withPoolTenant(db, scope.call.tenantId, 'file', (tx) => repository.files.readFileMeta(tx, fileId));
    return stored === null ? null : { ...meta, ...Object.fromEntries(META_FILE_COLUMNS.map((column) => [column, stored[column]])) };
  },
  // contentFileMetaDataBean.setSiteID keeps an empty site and stores another untrimmed (contentFileMetaDataBean.cfc:156-161).
  setSite(bean, site) {
    if (simpleArgument(site) !== '') bean.instance.set('siteid', site);
  },
  validate: (scope, bean) => ormValidate(scope, bean, 'metaID'),
});

const changesetCategoryAssignment = ormEntity({
  name: 'changesetCategoryAssignment',
  model: BEAN_MODELS.changesetCategoryAssignment,
  primaryKey: 'assignmentid',
  allowed: moduleAccess(CONTENT_ENTITIES.changesetCategoryAssignment),
  row: (scope, id) => findChangesetCategoryAssignment(scope.ctx.domain, scope.reader, { assignmentId: id, siteId: scope.call.siteId }),
  validate: (scope, bean) => ormValidate(scope, bean, 'assignmentid'),
});

const variationTargeting = ormEntity({
  name: 'variationTargeting',
  model: BEAN_MODELS.variationTargeting,
  primaryKey: 'targetingid',
  // Unregistered while `variations` is off, so AllowAccess refuses (jsonApiUtility.cfc:103-105,1714-1715).
  allowed: (scope) => variationsEnabled(scope.ctx.domain.config) && entityAccessAllowed(scope.call.actor, CONTENT_ENTITIES.variationTargeting),
  async row(scope, id) {
    const found = await findVariationTargeting(scope.ctx.domain, scope.reader, { targetingId: id, siteId: scope.call.siteId });
    if (found.isNew === 1 || !sameId(found.siteid, scope.call.siteId)) return null;
    const { targetingid, contentid, siteid, initjs, targetingjs } = found;
    return { targetingid, contentid, siteid, initjs, targetingjs };
  },
  validate: (scope, bean) => ormValidate(scope, bean, 'targetingid'),
});

/** The site's first assignment a key-less beanORM.loadBy reads: the joined load in clustered-key order (beanORM.cfc:766-916). */
async function firstAssignment(scope: Scope): Promise<Readonly<Record<string, unknown>> | null> {
  const { ctx, call, reader } = scope;
  const { db, repository } = ctx.domain;
  const pool = await listPoolCategories(ctx.domain, reader);
  const own = await withTenant(db, call.tenantId, (tx) => repository.categories.categoriesBySite(tx, { siteId: call.siteId }));
  // INNER JOIN tcontentcategories: the category pool's rows first, then the own site's (contentCategoryAssignBean.cfc:93-100).
  const index = new Map<string, (typeof own)[number]>();
  for (const row of [...pool, ...own]) if (!index.has(idKey(row.categoryid))) index.set(idKey(row.categoryid), row);
  const categories = [...index.values()].map((row) => ({
    categoryid: row.categoryid,
    categoryname: row.name,
    parentname: (row.parentid === null ? undefined : index.get(idKey(row.parentid)))?.name ?? null,
    parentid: row.parentid,
    filename: row.filename,
    path: row.path,
  }));
  const source = repository.beanFeed.source<Record<string, unknown>>(
    (fn) => withTenant(db, call.tenantId, fn),
    repository.content.categoryAssignmentsFeed({ siteId: call.siteId, categories }),
  );
  const [first] = await source.rows({ order: [] }, 0, 1);
  return first ?? null;
}

const contentCategoryAssign: ValidatedEntity = {
  name: 'contentCategoryAssign',
  // The bean declares no id property, so getPrimaryKey() is '' and loadBy has no key to filter by.
  primaryKey: '',
  allowed: moduleAccess(CONTENT_ENTITIES.contentCategoryAssign),
  async entity(scope, id, site) {
    const bean = ormBean(scope, BEAN_MODELS.contentCategoryAssign, { primaryKey: '', id: '', siteId: scope.call.siteId }, await firstAssignment(scope));
    bean.setValue('siteid', site);
    bean.setValue('', id);
    return ormValidate(scope, bean, '');
  },
  // Its only key-less read is the site's first assignment, and `primarykey` names the empty key in SQL.
  loadBy: (_scope, column) => loadByColumnHalted('contentCategoryAssign', column),
};

const stats: ValidatedEntity = {
  name: 'stats',
  primaryKey: 'contentid',
  allowed: moduleAccess(CONTENT_ENTITIES.stats),
  // contentStatsBean defines no loadBy: "The method loadBy was not found" (contentStatsBean.cfc).
  entity: () => Promise.reject(serverError()),
  loadBy: () => Promise.reject(serverError()),
};

/** The beans of strategies-content `getBean` resolves, by lower-cased name (onApplicationStart_include.cfm:340-390). */
const ENTITIES: ReadonlyMap<string, ValidatedEntity> = new Map(
  [content, comment, category, contentCategoryAssign, file, fileMetaData, changeset, changesetCategoryAssignment, feed, stats, variationTargeting].map(
    (entity) => [entity.name.toLowerCase(), entity],
  ),
);

/** Entities another service owns and validates. */
const OWNED_ELSEWHERE: ReadonlySet<string> = new Set(['user', 'group', 'address', 'site']);

/** getBean(name) of a validate call: '' names no bean; any other name is a bean of another owner, a plugin or the DI factory. */
function entityOf(name: string): ValidatedEntity {
  if (name === '') throw serverError();
  const entity = ENTITIES.get(name.toLowerCase());
  if (entity !== undefined) return entity;
  if (OWNED_ELSEWHERE.has(name.toLowerCase())) throw validateHalted(`Validating a ${name} bean, which its owning service validates,`, 'validate-foreign-entity');
  throw validateHalted(`Validating a ${name} bean`, 'validate-entity');
}

// ---- the branches ----

/** The entity branch (3740-3768): a fresh key, AllowAccess, loadBy, set('siteid') and set(pk), then the bean's validate(). */
async function validateEntity(scope: Scope, name: string): Promise<ValidationErrors> {
  const { data } = scope.context;
  if (cfEq(name, 'content') && !data.has('contentid')) setData(scope, 'contentid', cfUuid());
  const entity = entityOf(name);
  if (!data.has(entity.primaryKey)) setData(scope, entity.primaryKey, cfUuid());
  if (!entity.allowed(scope)) throw new LegacyApiError('authorization');
  return entity.entity(scope, data.get(entity.primaryKey) as CfValue, data.get('siteid') as CfValue, data.get('fields') as CfValue);
}

/** The loadby branch (3782-3806): the denylist, getBean, AllowAccess, loadBy(loadby=value, siteid), then the bean's validate(). */
async function validateLoadBy(scope: Scope, beanName: string, loadBy: CfValue): Promise<ValidationErrors> {
  const { data } = scope.context;
  const column = stringArgument(loadBy);
  if (['orderby', 'returnformat', 'cachedwithin'].includes(column.toLowerCase())) throw new LegacyApiError('invalidParameters');
  const entity = entityOf(beanName);
  const value = data.get(column);
  // `arguments.data[arguments.data.loadby]` of a missing key raises.
  if (!isSet(value)) throw serverError();
  if (!entity.allowed(scope)) throw new LegacyApiError('authorization');
  return entity.loadBy(scope, column, value, data.get('siteid') as CfValue, data.get('fields') as CfValue);
}

/** The acting user in the call's verified tenant and site, which an anonymous actor does not carry itself. */
function readerOf(call: JsonApiCall): Actor {
  return { ...call.actor, tenantId: call.tenantId, siteId: call.siteId };
}

/** validate's result, which processRequest always answers with 200 (891-897). */
function answer(data: Record<string, unknown>): JsonApiResult {
  return { status: 200, data };
}

/** validate(data, validations, siteid) of any strategies-content entity route (jsonApiUtility.cfc:3703-3808). */
export const validate: JsonApiHandlerFn = async (ctx, call) => {
  const data = argumentValue(call, 'data');
  const validations = argumentValue(call, 'validations');
  if (!(data instanceof CfStruct) || !(validations instanceof CfStruct)) return answer({ invalid: 'Invalid validation request' });
  const scope: Scope = { ctx, call, reader: readerOf(call), context: { data, isPostedFile: (name) => isPostedFile(call, name) } };
  // The `param` defaults land in the data struct, which is the validation context (3729-3738).
  if (!data.has('fields')) setData(scope, 'fields', '');
  if (!data.has('siteid')) setData(scope, 'siteid', siteArgument(call), postedSite(call));
  assertEventSite(data.get('siteid') as CfValue);
  const entityName = data.get('entityname');
  if (isSet(entityName) && !cfEq(simpleArgument(entityName), 'bean')) {
    return answer(errorsObject(await validateEntity(scope, simpleArgument(entityName))));
  }
  const errors: ValidationErrors = new CfStruct();
  if (validations.size > 0) {
    appendErrors(errors, validateAdHoc(validations, scope.context, data.get('fields') as CfValue, { instanceId: cfUuid(), validationContextId: cfUuid() }));
  }
  const beanName = data.get('bean');
  const loadBy = data.get('loadby');
  if (isSet(beanName) && isSet(loadBy) && !cfEq(simpleArgument(beanName), 'bean')) {
    appendErrors(errors, await validateLoadBy(scope, simpleArgument(beanName), loadBy));
  }
  return answer(errorsObject(errors));
};
