// Collection (cFeed) edit model: strategies-content's screen model read as `cfeed/edit.cfm` reads it (server-only).
import {
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/strategies-content';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import type { Rc, ScreenContext } from '../registry';
import { applyCfeedDefaults } from './before';
import { feedCategoryTree, type FeedCategoryNode, type FeedCategoryRow } from './categories-nest';
import { cfTruthy, type CfFlag } from './common';
import type { FeedUsageRow } from './tab-usage';

type Schemas = components['schemas'];

/** `getFeed`'s screen model (`rc` keys as its contract description lists them), or a rejected save's write result. */
export type FeedEditSource = Schemas['AdminViewModel'] | Schemas['AdminWriteResult'];

/** The request values the mapping reads: the defaulted `rc` and the session site. */
export type FeedEditRequest = Pick<AdminRequest, 'rc' | 'site'>;

/** A legacy error struct, keyed and ordered as strategies-content reports it. */
export type FeedErrors = Readonly<Record<string, string>>;

/** `rc.feedBean` through its getters, after the view's own changes (site id, display object instance). */
export interface FeedView {
  readonly feedID: string;
  readonly siteID: string;
  readonly type: string;
  readonly isNew: boolean;
  /** `exists()`: not new. */
  readonly exists: boolean;
  readonly isLocked: boolean;
  readonly name: string;
  /** `getContentPoolID()`: the stored list, the site id when empty, the site's pool for `*`. */
  readonly contentPoolID: string;
  readonly sortBy: string;
  readonly sortDirection: string;
  /** CFML text, compared with `cfEq` as the view's `eq` does. */
  readonly maxItems: string;
  readonly nextN: string;
  readonly isFeaturesOnly: boolean;
  readonly showNavOnly: boolean;
  readonly showExcludeSearch: boolean;
  /** Comma list of the selected category ids. */
  readonly categoryID: string;
  readonly useCategoryIntersect: boolean;
  /** `getImageSize()`: `small` for a custom size whose width and height are both `AUTO`. */
  readonly imageSize: string;
  /** `getImageWidth()`: the stored width only for a custom size, else `AUTO`. */
  readonly imageWidth: string;
  readonly imageHeight: string;
  readonly displayName: boolean;
  readonly altName: string;
  readonly cssClass: string;
  readonly viewAllLink: string;
  readonly viewAllLabel: string;
  /** `getDisplayList()`: the site renderer's `defaultCollectionDisplayList` when none is stored. */
  readonly displayList: string;
  /** `getAvailableDisplayList()`: every display field not in `displayList`. */
  readonly availableDisplayList: string;
  readonly description: string;
  readonly allowHTML: boolean;
  readonly isPublic: boolean;
  readonly version: string;
  readonly lang: string;
  /** `getrestricted() eq 1`. */
  readonly restricted: boolean;
  readonly restrictGroups: string;
  readonly channelLink: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly authType: string;
  readonly autoImport: boolean;
  readonly parentID: string;
  /** The display object's stored params for an instance edit, else the bean's value. */
  readonly instanceParams: string;
}

/** One advanced filter (`getAdvancedParams()` row). */
export interface FeedAdvancedParam {
  readonly relationship: string;
  readonly field: string;
  readonly dataType: string;
  readonly condition: string;
  readonly criteria: string;
}

/** A section filter: a `getcontentItems` row whose content exists, with its crumb markup. */
export interface FeedContentFilter {
  readonly contentID: string;
  readonly siteID: string;
  readonly type: string;
  /** `$.dspZoomNoLinks(item.getCrumbArray())` markup as strategies-content renders it. */
  readonly zoom: string;
}

/** A `contentUtility.getRestrictGroups` row. */
export interface FeedRestrictGroup {
  readonly userID: string;
  readonly groupName: string;
  /** Member group when true, admin group otherwise. */
  readonly isPublic: boolean;
}

/** An active `tcontent` extended attribute (the view's `rsExtend`). */
export interface FeedExtendedAttribute {
  readonly attributeID: string;
  readonly type: string;
  readonly subType: string;
  readonly attribute: string;
}

/** One item of the site's `contentPoolID` list with the site's name. */
export interface FeedPoolSite {
  readonly siteID: string;
  readonly site: string;
}

/** Everything the Local and Remote branches of `cfeed/edit.cfm` read. */
export interface FeedEditModel {
  readonly feed: FeedView;
  readonly errors: FeedErrors;
  readonly advancedParams: readonly FeedAdvancedParam[];
  readonly contentFilters: readonly FeedContentFilter[];
  readonly restrictGroups: readonly FeedRestrictGroup[];
  readonly extendedAttributes: readonly FeedExtendedAttribute[];
  /** `categoryManager.getCategoryCount(rc.siteid)` is non-zero. */
  readonly hasCategories: boolean;
  readonly categories: readonly FeedCategoryNode[];
  /** Usage rows of a saved collection; empty for a new one. */
  readonly usage: readonly FeedUsageRow[];
  /** Names of the site's custom image sizes, in iterator order. */
  readonly customImageSizes: readonly string[];
  /** The site content renderer's `useLayoutManager()`. */
  readonly useLayoutManager: boolean;
  /** The session site's `getHasComments()`, when boolean and true. */
  readonly siteHasComments: boolean;
  readonly siteExtranet: boolean;
  /** One entry per item of the site's `contentPoolID` list, in list order. */
  readonly contentPool: readonly FeedPoolSite[];
  /** Menu title of the import location (`getActiveContent(parentID).getMenuTitle()`); '' without a parent. */
  readonly parentMenuTitle: string;
  /** Whether the service factory holds a `marketingManager` bean. */
  readonly hasMarketingManager: boolean;
  /** `len(globalConfig('proxyserver'))`. */
  readonly hasProxyServer: boolean;
  /** `len(globalConfig('proxyuser'))`. */
  readonly hasProxyUser: boolean;
  /** A Local edit of a display object instance (`rc.assignmentID` set). */
  readonly isObjectInstance: boolean;
  /** `configBean.getValue('showUsageTabs', true)`. */
  readonly showUsageTabs: boolean;
  /** The feed API endpoint strategies-content returned; renderers fall back to `feedApiEndpoint`. */
  readonly endpoint?: string;
  /** `pluginManager.renderEvent('onFeedEditMessageRender')` output. */
  readonly pluginMessage: string;
}

// Legacy defaults for what neither the contract nor legacySettings() carries: Masa core registers no
// `marketingManager`, and plugin event output renders only in the legacy plugin runtime.
const HAS_MARKETING_MANAGER = false;
const PLUGIN_MESSAGE = '';

/** The fields `getAvailableDisplayList()` starts from, before the site's content attribute names. */
const CORE_DISPLAY_FIELDS = 'Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating';
const NO_SUMMARY_OBJECTS = 'feed_slideshow_no_summary,feed_no_summary';
const SLIDESHOW_OBJECTS = 'feed_slideshow_no_summary,feed_slideshow';

// ---- Struct reads ----

type Struct = Readonly<Record<string, unknown>>;

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple value as CFML text; absent and SQL NULL read as `''`, complex values throw as CFML output does. */
function simpleText(value: unknown, key: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

const text = (struct: Struct, key: string): string => simpleText(member(struct, key), key);

/** A simple value as a CFML flag; complex values throw. */
function flagOf(value: unknown, key: string): CfFlag {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return simpleText(value, key);
}

/** A struct member; throws when it is absent or not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = member(struct, key);
  if (!isStruct(value)) throw new TypeError(`${key} is not a struct`);
  return value;
}

/** A query's rows; throws when `value` is absent or not a list of structs. */
function rowsIn(value: unknown, key: string): readonly Struct[] {
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${key} is not a list of rows`);
  return value;
}

const rowsOf = (struct: Struct, key: string): readonly Struct[] => rowsIn(member(struct, key), key);

/** A simple member the view reads; throws when it is absent. */
function requiredText(struct: Struct, key: string): string {
  if (member(struct, key) === undefined) throw new TypeError(`${key} is missing from the collection edit model`);
  return text(struct, key);
}

/** A flag member the view tests, read as CFML truthiness; throws when it is absent. */
function requiredFlag(struct: Struct, key: string): boolean {
  if (member(struct, key) === undefined) throw new TypeError(`${key} is missing from the collection edit model`);
  return cfTruthy(flagOf(member(struct, key), key));
}

/** An error struct as text, in its key order. */
function errorsOf(errors: Struct): FeedErrors {
  return Object.fromEntries(Object.keys(errors).map((key) => [key, text(errors, key)]));
}

/** `rc[name]` by case-insensitive name; `''` when absent. */
function rcText(rc: Rc, name: string): string {
  return simpleText(member(rc, name), name);
}

/** CFML `listFindNoCase(list, value) > 0`. */
function listHasNoCase(list: string, value: string): boolean {
  const wanted = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === wanted);
}

// ---- The feed bean's instance ----

/** A bean's `variables.instance`: values as stored, under case-insensitive keys. */
type Instance = Map<string, unknown>;

function instanceOf(bean: Struct): Instance {
  return new Map(Object.entries(bean).map(([key, value]) => [key.toLowerCase(), value]));
}

const stored = (inst: Instance, key: string): string => simpleText(inst.get(key.toLowerCase()), key);

const storedFlag = (inst: Instance, key: string): boolean => cfTruthy(flagOf(inst.get(key.toLowerCase()), key));

/** feedBean/beanFeed setters that only accept a boolean and store it as 1 or 0. */
const FLAG_SETTERS: ReadonlySet<string> = new Set([
  'displayname',
  'displayratings',
  'displaycomments',
  'displaykids',
  'includehomepage',
  'liveonly',
  'shownavonly',
  'islocked',
  'usecategoryintersect',
  'showexcludesearch',
  'autoimport',
]);

/** beanFeed/feedBean setters that only accept a number. */
const NUMERIC_SETTERS: ReadonlySet<string> = new Set(['imageheight', 'imagewidth', 'maxitems', 'nextn']);

// These setters write advanced params, dates, the alternate table or query plumbing, none of which an instance edit
// renders, so their keys change nothing here (the generic store would wrongly shadow `params`).
const UNMODELLED_SETTERS: ReadonlySet<string> = new Set([
  'advancedparams',
  'params',
  'alttable',
  'datecreated',
  'lastupdate',
  'remotepubdate',
  'lastupdateby',
  'feedmanager',
  'configbean',
  'distinct',
  'entityname',
  'fields',
  'orderby',
  'sort',
  'validations',
  'propasidcolumn',
  'addedobjectvalues',
]);

/** bean `setValue(property, value)` with the feedBean and beanFeed setters that reach this model. */
function setValue(inst: Instance, property: string, value: unknown): void {
  const key = property.toLowerCase();
  if (UNMODELLED_SETTERS.has(key)) return;
  if (FLAG_SETTERS.has(key)) {
    if (cfIsBoolean(value)) inst.set(key, cfToBoolean(value) ? 1 : 0);
    return;
  }
  if (key === 'itemsperpage') return setValue(inst, 'nextN', value);
  if (NUMERIC_SETTERS.has(key)) {
    if (cfIsNumeric(value)) inst.set(key, value);
    return;
  }
  switch (key) {
    case 'imagesize':
      if (simpleText(value, property) !== '') inst.set(key, value);
      return;
    case 'sortdirection':
      if (['desc', 'asc'].includes(simpleText(value, property).toLowerCase())) inst.set(key, value);
      return;
    case 'contentid':
    case 'categoryid':
      inst.set(key, javaTrim(simpleText(value, property)));
      return;
    case 'errors':
      if (isStruct(value)) inst.set(key, value);
      return;
  }
  // The generic store trims simple values, as `setValue` does for a property without a setter.
  const simple = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  inst.set(key, simple ? javaTrim(String(value)) : value);
}

// `set(struct)` ends with `setAdvancedParams(struct)`, which rebuilds the advanced filters; an instance edit renders
// none of them, so that step is left out.
/** feedBean `set(value)` of a deserialized JSON value: a struct key by key, a simple value as an empty property. */
function setAll(inst: Instance, value: unknown): void {
  if (isStruct(value)) {
    for (const [key, item] of Object.entries(value)) setValue(inst, key, item);
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    setValue(inst, String(value), '');
  }
}

/** CFML `isJSON(text)` then `deserializeJSON(text)`; undefined when the text is no JSON. */
function parseJson(textValue: string): unknown {
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    return undefined;
  }
}

/** `getDisplayList()`: the stored list, else `defaultList` (the site renderer's `defaultCollectionDisplayList`). */
function displayListOf(inst: Instance, defaultList: string): string {
  const list = stored(inst, 'displayList');
  return list === '' ? defaultList : list;
}

/**
 * edit.cfm 160-180: the display object's params become `instanceParams`, then a JSON object overlays the bean, while
 * other params keep the display list (`defaultList` when none is stored) and give slideshows medium images.
 * @throws Error When a no-summary object's list holds `Summary`: legacy then reads an undefined `arguments.hasSummary`.
 */
function applyDisplayObject(inst: Instance, object: string, params: string, defaultList: string): void {
  setValue(inst, 'instanceParams', params);
  const json = parseJson(params);
  if (json !== undefined) {
    setAll(inst, json);
    return;
  }
  const fields = displayListOf(inst, defaultList);
  if (listHasNoCase(NO_SUMMARY_OBJECTS, object) && listHasNoCase(fields, 'Summary')) {
    throw new Error('Element HASSUMMARY is undefined in ARGUMENTS.');
  }
  if (listHasNoCase(SLIDESHOW_OBJECTS, object)) {
    // The height and width setters ignore `AUTO`, which is not numeric; the getters still answer `AUTO`.
    setValue(inst, 'imageSize', 'medium');
    setValue(inst, 'imageHeight', 'AUTO');
    setValue(inst, 'imageWidth', 'AUTO');
  }
  setValue(inst, 'displayList', fields);
}

// ---- Getters ----

/** `getContentPoolID()`: `''` reads as the feed's site, `*` as that site's content pool. */
function contentPoolOf(inst: Instance, req: FeedEditRequest): string {
  const pool = stored(inst, 'contentPoolID');
  const siteID = stored(inst, 'siteID');
  if (pool === '') return siteID;
  if (pool !== '*') return pool;
  if (req.site === undefined || req.site.siteid.toLowerCase() !== siteID.toLowerCase()) {
    throw new Error(`contentPoolID '*' needs the settings of site '${siteID}', which the request did not load`);
  }
  return req.site.contentPoolID;
}

/** `getAvailableDisplayList()`: the display fields, then the site's content attribute names, less `displayList`. */
function availableDisplayListOf(displayList: string, attributeNames: readonly string[]): string {
  const base = attributeNames.length === 0 ? CORE_DISPLAY_FIELDS : `${CORE_DISPLAY_FIELDS},${attributeNames.join(',')}`;
  const fields = cfListToArray(base);
  for (const item of cfListToArray(displayList)) {
    const wanted = item.toLowerCase();
    const found = fields.findIndex((field) => field.toLowerCase() === wanted);
    if (found >= 0) fields.splice(found, 1);
  }
  return fields.join(',');
}

// ACF query-of-queries compares strings case-sensitively, so `group by attribute order by attribute` keeps
// differently cased names apart and sorts by code unit.
/** The distinct `attribute` names of every content attribute, as `getAvailableDisplayList()` queries them. */
function displayAttributeNames(rows: readonly Struct[]): string[] {
  return [...new Set(rows.map((row) => text(row, 'attribute')))].sort();
}

/** The bean's getters over `inst`; `defaultList` is the site renderer's `defaultCollectionDisplayList`. */
function feedViewOf(
  inst: Instance,
  req: FeedEditRequest,
  attributeNames: readonly string[],
  defaultList: string,
): FeedView {
  const imageSize = stored(inst, 'imageSize');
  const imageHeight = stored(inst, 'imageHeight');
  const imageWidth = stored(inst, 'imageWidth');
  const custom = cfEq(imageSize, 'Custom');
  const displayList = displayListOf(inst, defaultList);
  // `exists()` params a missing `isNew` to 1.
  const isNew = cfTruthy(flagOf(inst.get('isnew') ?? 1, 'isNew'));
  return {
    feedID: stored(inst, 'feedID'),
    siteID: stored(inst, 'siteID'),
    type: stored(inst, 'type'),
    isNew,
    exists: !isNew,
    isLocked: storedFlag(inst, 'isLocked'),
    name: stored(inst, 'name'),
    contentPoolID: contentPoolOf(inst, req),
    sortBy: stored(inst, 'sortBy'),
    sortDirection: stored(inst, 'sortDirection'),
    maxItems: stored(inst, 'maxItems'),
    nextN: stored(inst, 'nextN'),
    isFeaturesOnly: storedFlag(inst, 'isFeaturesOnly'),
    showNavOnly: storedFlag(inst, 'showNavOnly'),
    showExcludeSearch: storedFlag(inst, 'showExcludeSearch'),
    categoryID: stored(inst, 'categoryID'),
    useCategoryIntersect: storedFlag(inst, 'useCategoryIntersect'),
    imageSize: custom && cfEq(imageHeight, 'AUTO') && cfEq(imageWidth, 'AUTO') ? 'small' : imageSize,
    imageWidth: custom ? imageWidth : 'AUTO',
    imageHeight: custom ? imageHeight : 'AUTO',
    displayName: storedFlag(inst, 'displayName'),
    altName: stored(inst, 'altName'),
    cssClass: stored(inst, 'cssClass'),
    viewAllLink: stored(inst, 'viewAllLink'),
    viewAllLabel: stored(inst, 'viewAllLabel'),
    displayList,
    availableDisplayList: availableDisplayListOf(displayList, attributeNames),
    description: stored(inst, 'description'),
    allowHTML: storedFlag(inst, 'allowHTML'),
    isPublic: storedFlag(inst, 'isPublic'),
    version: stored(inst, 'version'),
    lang: stored(inst, 'lang'),
    restricted: cfEq(stored(inst, 'restricted'), '1'),
    restrictGroups: stored(inst, 'restrictGroups'),
    channelLink: stored(inst, 'channelLink'),
    isActive: storedFlag(inst, 'isActive'),
    isDefault: storedFlag(inst, 'isDefault'),
    authType: stored(inst, 'authType'),
    autoImport: storedFlag(inst, 'autoImport'),
    parentID: stored(inst, 'parentID'),
    instanceParams: stored(inst, 'instanceParams'),
  };
}

// ---- Rows ----

/** A category flag column as the nest compares it: numbers and booleans as stored, text by CFML conversion. */
function categoryFlag(row: Struct, key: string): number | boolean {
  const value = flagOf(member(row, key), key);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return cfIsNumeric(value) ? cfToNumber(value) : cfTruthy(value);
}

function categoryRow(row: Struct): FeedCategoryRow {
  return {
    categoryID: text(row, 'categoryID'),
    parentID: text(row, 'parentID'),
    name: text(row, 'name'),
    isOpen: categoryFlag(row, 'isOpen'),
    permitted: cfTruthy(flagOf(member(row, 'permitted'), 'permitted')),
  };
}

/** A nullable date column as text; SQL NULL stays null. */
function dateText(row: Struct, key: string): string | null {
  const value = member(row, key);
  return value === undefined || value === null ? null : simpleText(value, key);
}

function usageRow(row: Struct): FeedUsageRow {
  return {
    contentHistID: text(row, 'contentHistID'),
    contentID: text(row, 'contentID'),
    type: text(row, 'type'),
    parentID: text(row, 'parentID'),
    siteID: text(row, 'siteID'),
    moduleID: text(row, 'moduleID'),
    display: flagOf(member(row, 'display'), 'display'),
    approved: flagOf(member(row, 'approved'), 'approved'),
    displayStart: dateText(row, 'displayStart'),
    displayStop: dateText(row, 'displayStop'),
    lastUpdate: dateText(row, 'lastUpdate'),
    zoom: text(row, 'zoom'),
    verdict: text(row, 'verdict'),
  };
}

/** Section filters whose content exists; a row without `exists` was listed as existing. */
function contentFiltersOf(rows: readonly Struct[]): FeedContentFilter[] {
  return rows
    .filter((row) => member(row, 'exists') === undefined || cfTruthy(flagOf(member(row, 'exists'), 'exists')))
    .map((row) => ({
      contentID: text(row, 'contentID'),
      siteID: text(row, 'siteID'),
      type: text(row, 'type'),
      zoom: text(row, 'zoom'),
    }));
}

/** The view's `rsExtend`: attributes of active subtypes, in legacy order. */
function activeAttributes(rows: readonly Struct[]): FeedExtendedAttribute[] {
  return rows
    .filter((row) => cfTruthy(flagOf(member(row, 'isActive'), 'isActive')))
    .map((row) => ({
      attributeID: text(row, 'attributeID'),
      type: text(row, 'type'),
      subType: text(row, 'subType'),
      attribute: text(row, 'attribute'),
    }));
}

/** The rc values and, for a write result, its error struct. */
function sourceParts(source: FeedEditSource): { readonly rc: Struct; readonly errors?: FeedErrors } {
  if ('rc' in source) return { rc: source.rc };
  if (!isStruct(source.data)) throw new TypeError('The collection write result carries no re-render data');
  return { rc: source.data, errors: errorsOf(source.errors) };
}

// ---- Model ----

/**
 * Maps a collection screen model, or a rejected save's write result, to what `edit.cfm` reads. A Local edit takes
 * `rc.siteid` as the feed's site; a Local instance edit lays `rsDisplayObject` over the feed when the service returned
 * it (without it, `feedBean` is already the merged instance).
 * @throws TypeError When the model lacks a value the view reads.
 * @throws Error Where legacy fails rendering an instance (see {@link applyDisplayObject}).
 */
export function feedEditModelFrom(source: FeedEditSource, req: FeedEditRequest): FeedEditModel {
  const { rc, errors: writeErrors } = sourceParts(source);
  const local = cfEq(rcText(req.rc, 'type'), 'Local');
  const isObjectInstance = local && rcText(req.rc, 'assignmentID') !== '';
  const inst = instanceOf(structOf(rc, 'feedBean'));
  const defaultList = requiredText(rc, 'defaultCollectionDisplayList');
  if (local) setValue(inst, 'siteID', rcText(req.rc, 'siteid'));
  if (isObjectInstance && member(rc, 'rsDisplayObject') !== undefined) {
    // An empty query reads its columns as ''.
    const row = rowsOf(rc, 'rsDisplayObject')[0] ?? {};
    applyDisplayObject(inst, text(row, 'object'), text(row, 'params'), defaultList);
  }
  const attributes = rowsOf(rc, 'rsExtendedAttributes');
  const feed = feedViewOf(inst, req, displayAttributeNames(attributes), defaultList);
  const beanErrors = inst.get('errors');
  const saved = rcText(req.rc, 'feedID') !== '';
  const endpoint = member(rc, 'endpoint');
  const { hasProxyServer, hasProxyUser, showUsageTabs } = legacySettings();
  return {
    feed,
    errors: writeErrors ?? (isStruct(beanErrors) ? errorsOf(beanErrors) : {}),
    advancedParams: rowsIn(inst.get('params'), 'feedBean.params').map((row) => ({
      relationship: text(row, 'relationship'),
      field: text(row, 'field'),
      dataType: text(row, 'dataType'),
      condition: text(row, 'condition'),
      criteria: text(row, 'criteria'),
    })),
    contentFilters: contentFiltersOf(rowsOf(rc, 'rslist')),
    restrictGroups: rowsOf(rc, 'rsRestrictGroups').map((row) => ({
      userID: text(row, 'userID'),
      groupName: text(row, 'groupName'),
      isPublic: cfTruthy(flagOf(member(row, 'isPublic'), 'isPublic')),
    })),
    extendedAttributes: activeAttributes(attributes),
    hasCategories: cfTruthy(flagOf(member(rc, 'hasCategories'), 'hasCategories')),
    categories: feedCategoryTree(rowsOf(rc, 'categories').map(categoryRow)),
    usage: saved || member(rc, 'rsUsage') !== undefined ? rowsOf(rc, 'rsUsage').map(usageRow) : [],
    customImageSizes: rowsOf(rc, 'imageSizes').map((row) => text(row, 'name')),
    useLayoutManager: requiredFlag(rc, 'useLayoutManager'),
    siteHasComments: req.site?.hasComments === true,
    siteExtranet: req.site?.extranet === true,
    contentPool: rowsOf(rc, 'contentPool').map((row) => ({ siteID: text(row, 'siteID'), site: text(row, 'site') })),
    // Only the Remote import location reads it.
    parentMenuTitle: !local && feed.parentID !== '' ? requiredText(rc, 'parentMenuTitle') : '',
    hasMarketingManager: HAS_MARKETING_MANAGER,
    hasProxyServer,
    hasProxyUser,
    isObjectInstance,
    showUsageTabs,
    endpoint: typeof endpoint === 'string' && endpoint !== '' ? endpoint : undefined,
    pluginMessage: PLUGIN_MESSAGE,
  };
}

/** The `getFeed` query: the rc values the service reads, each sent only when the request holds it. */
function feedQuery(rc: Rc): Record<string, string | undefined> {
  const names = ['type', 'assignmentID', 'regionID', 'orderno', 'instanceid', 'homeID', 'compactDisplay'] as const;
  return Object.fromEntries(names.map((name) => [name, member(rc, name) === undefined ? undefined : rcText(rc, name)]));
}

/**
 * Loads the edit model of `rc.feedID`. The cfeed `before()` defaults are applied to `req.rc` first and the result
 * becomes `ctx.req`, so the view reads them as legacy's does.
 * @throws TypeError When `rc.siteid` is empty or the screen model lacks a value the view reads.
 * @throws GatewayDenialError When strategies-content refuses the read (401 or 403).
 */
export async function loadFeedEditModel(req: AdminRequest, ctx: ScreenContext): Promise<FeedEditModel> {
  const defaulted: AdminRequest = { ...req, rc: applyCfeedDefaults(req.rc) };
  ctx.req = defaulted;
  const siteid = rcText(defaulted.rc, 'siteid');
  if (siteid === '') throw new TypeError('rc.siteid is empty; the collection edit model needs a site');
  const feedid = rcText(defaulted.rc, 'feedID');
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/feeds/{feedid}', {
    // The path needs an id: a fresh one matches no collection, so the service reads a new bean as legacy's
    // `feedManager.read(feedID='')` does.
    params: { siteid, feedid: feedid === '' ? cfUuid() : feedid },
    query: feedQuery(defaulted.rc),
  });
  return feedEditModelFrom(okBody(response, 'strategies-content', 'getFeed'), defaulted);
}
