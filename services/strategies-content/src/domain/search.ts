/** Admin search (carch.search), public search, JSON API content findQuery and cnav.searchsitedata; read-only. */
import {
  LegacyApiError,
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  esapiUrlEncode,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { registryEntries, registryEntryForTenant, withTenant, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import {
  SITE_TREE_MODULE_ID,
  type FileJoinRow,
  type PooledFileMatches,
  type PrivateSearchArgs,
  type PrivateSearchRow,
  type PublicSearchRow,
} from '../repo/content-queries.js';
import type { FeedContentRow, FeedCount } from '../repo/feed-queries.js';
import type { Actor, DomainDeps } from './context.js';
import { FeedBean, FeedContentUnsupportedError, feedContent, readFeed, type FeedContentOptions } from './feeds.js';
import { getModulePerm } from './permissions.js';
import { UnregisteredTenantError, withPoolTenant } from './pools.js';

/** What the search reads run against. */
export type SearchDeps = Pick<DomainDeps, 'db' | 'repository' | 'clock'>;

type Struct = Readonly<Record<string, unknown>>;

/** carch.search's page size (`utility.getNextN(rsList, 30, startRow)`). */
export const PRIVATE_SEARCH_RECORDS_PER_PAGE = 30;
/** The `maxrows` of getPrivateSearch and getPublicSearch. */
const SEARCH_MAX_ROWS = 1000;
const SECONDS_PER_DAY = 86_400;

// ---- CFML value helpers ----

/** The text CFML gives a simple value; complex and missing values read as ''. */
function cfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

/** CFML listFirst and listLast: the first or last non-empty item, or ''. */
function cfListFirst(list: string, delim: string): string {
  return cfListToArray(list, delim)[0] ?? '';
}

function cfListLast(list: string, delim: string): string {
  return cfListToArray(list, delim).at(-1) ?? '';
}

/** CFML URLDecode: `+` as a space and `%XX` runs as UTF-8, malformed escapes left as they are. */
function urlDecode(value: string): string {
  return value.replaceAll('+', ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function lowerSet(list: string): ReadonlySet<string> {
  return new Set(list.toLowerCase().split(','));
}

/** A CFML struct: keys case-insensitive in their first casing, a null value as absent. */
class CfStruct {
  private readonly items = new Map<string, { key: string; value: unknown }>();

  constructor(source: Struct) {
    for (const [key, value] of Object.entries(source)) this.set(key, value);
  }

  /** `structKeyExists` / `isDefined`. */
  has(key: string): boolean {
    const value = this.items.get(key.toLowerCase())?.value;
    return value !== undefined && value !== null;
  }

  get(key: string): unknown {
    return this.items.get(key.toLowerCase())?.value;
  }

  text(key: string): string {
    return cfText(this.get(key));
  }

  set(key: string, value: unknown): void {
    const held = this.items.get(key.toLowerCase());
    if (held === undefined) this.items.set(key.toLowerCase(), { key, value });
    else held.value = value;
  }

  entries(): Array<[string, unknown]> {
    return [...this.items.values()].map(({ key, value }) => [key, value]);
  }
}

// ---- pooled file columns ----

/** The `tfiles` columns a search row joins on `fileid`. */
interface FileJoined {
  fileid: string | null;
  filesize: FileJoinRow['filesize'] | null;
  fileext: string | null;
  assocfilename: string | null;
}

/** A row whose file the content tenant's join could not reach (the site's files live in another tenant). */
function unjoined(row: FileJoined): boolean {
  return row.fileid !== null && row.fileid !== '' && row.filesize === null && row.fileext === null;
}

function unjoinedFileIds(rows: readonly FileJoined[]): string[] {
  return [...new Set(rows.filter(unjoined).map((row) => row.fileid ?? ''))];
}

/** `rows` with the file columns of `files` filled where the content tenant's join left them null; legacy joins `tfiles` on fileid alone. */
function withFileColumns<R extends FileJoined>(rows: R[], files: readonly FileJoinRow[]): R[] {
  if (files.length === 0) return rows;
  const byId = new Map(files.map((file) => [file.fileid.toLowerCase(), file]));
  return rows.map((row) => {
    const file = unjoined(row) ? byId.get((row.fileid ?? '').toLowerCase()) : undefined;
    return file === undefined ? row : { ...row, filesize: file.filesize, fileext: file.fileext, assocfilename: file.assocfilename };
  });
}

/** The tenant holding a registered site's files; settingsBean defaults an empty `filePoolID` to the site itself. */
function fileTenantOf(entry: TenantRegistryEntry): string {
  return entry.filePoolTenant ?? entry.tenantId;
}

/** The registry entry of the token's tenant. */
async function ownEntry(deps: SearchDeps, actor: Actor): Promise<TenantRegistryEntry> {
  const entry = await registryEntryForTenant(deps.db, actor.tenantId);
  if (entry === null) throw new UnregisteredTenantError(actor.tenantId);
  return entry;
}

/** SQL Server's case-insensitive, trailing-space-insensitive key of a site id. */
function siteKey(siteId: string): string {
  return siteId.replace(/ +$/u, '').toLowerCase();
}

// ---- carch.search: contentManager.getPrivateSearch ----

/** The arguments of contentManager.getPrivateSearch, and the results page carch.search shows. */
export interface PrivateSearchInput {
  siteId: string;
  keywords: string;
  tag?: string;
  sectionId?: string;
  /** `default`, `image` or `file`. */
  searchType?: string;
  /** A CF list of module ids; the gateway defaults it to the site tree, components and forms. */
  moduleId?: string;
  /** `rc.startrow` of the results page. */
  startRow: number;
}

/** `session.keywords = rc.keywords`, which the route persists. */
export interface KeywordsSessionEffect {
  kind: 'keywords';
  keywords: string;
}

/** The getPrivateSearch rows with getNextN's page size and start row; the renderer computes the paging struct. */
export interface PrivateSearchResult {
  rows: PrivateSearchRow[];
  paging: { recordsPerPage: number; startRow: number };
  sessionEffect: KeywordsSessionEffect;
}

/** A site whose content one search reads, and the tenants holding its content and its files. */
interface SearchSite {
  siteId: string;
  tenantId: string;
  fileTenantId: string;
}

function searchSite(entry: TenantRegistryEntry): SearchSite {
  return { siteId: entry.siteId, tenantId: entry.tenantId, fileTenantId: fileTenantOf(entry) };
}

function isFileSearch(searchType: string): boolean {
  const type = searchType.toLowerCase();
  return type === 'image' || type === 'file';
}

/** An image or file search's sites (`siteID = X OR filePoolID = X` in tsettings): the own site, then the registered sites pooling their files in it. */
async function filePoolSearchSites(deps: SearchDeps, own: TenantRegistryEntry): Promise<SearchSite[]> {
  const key = siteKey(own.siteId);
  const members = (await registryEntries(deps.db)).filter(
    (entry) => entry.tenantId !== own.tenantId && entry.filePoolId !== null && siteKey(entry.filePoolId) === key,
  );
  return [own, ...members].map(searchSite);
}

/** getPrivateSearch over one site's tenant, its file columns read where the site keeps its files. */
async function privateSearchIn(deps: SearchDeps, site: SearchSite, args: PrivateSearchArgs): Promise<PrivateSearchRow[]> {
  const { content } = deps.repository;
  if (site.fileTenantId === site.tenantId) {
    return withTenant(deps.db, site.tenantId, (tx) => content.privateSearch(tx, args));
  }
  // The pool's files are matched in the file tenant; a default search needs only which of the versions' files exist there.
  const fileSearch = isFileSearch(args.searchType ?? 'default');
  const candidateType = fileSearch ? (args.searchType ?? 'file') : 'file';
  const fileIds = await withTenant(deps.db, site.tenantId, (tx) => content.privateSearchFileIds(tx, { ...args, searchType: candidateType }));
  const matches = await withTenant(deps.db, site.fileTenantId, (tx) =>
    content.poolFileMatches(tx, { keywords: args.keywords, searchType: candidateType, fileIds }),
  );
  const pooledFiles: PooledFileMatches = fileSearch ? matches : { fileIds: matches.fileIds, keywordFileIds: [] };
  const rows = await withTenant(deps.db, site.tenantId, (tx) => content.privateSearch(tx, { ...args, pooledFiles }));
  const ids = unjoinedFileIds(rows);
  const files = ids.length === 0 ? [] : await withTenant(deps.db, site.fileTenantId, (tx) => content.fileJoinColumns(tx, ids));
  return withFileColumns(rows, files);
}

/** getPrivateSearch's `ORDER BY supersort, priority, title`: NULL titles lowest, text case-insensitive. */
function privateSearchOrder(a: PrivateSearchRow, b: PrivateSearchRow): number {
  if (a.supersort !== b.supersort) return a.supersort - b.supersort;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.title === null || b.title === null) return a.title === b.title ? 0 : a.title === null ? -1 : 1;
  const x = a.title.toLowerCase();
  const y = b.title.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** carch.search (carch.cfc:488-492): getPrivateSearch with the gateway defaults, getNextN's page size and the `session.keywords` effect. */
export async function privateSearch(deps: SearchDeps, actor: Actor, input: PrivateSearchInput): Promise<PrivateSearchResult> {
  const own = await ownEntry(deps, actor);
  const args: PrivateSearchArgs = {
    siteId: input.siteId,
    keywords: input.keywords,
    tag: input.tag ?? '',
    sectionId: input.sectionId ?? '',
    searchType: input.searchType ?? 'default',
    ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
  };
  let rows: PrivateSearchRow[];
  if (isFileSearch(args.searchType ?? 'default')) {
    const sites = await filePoolSearchSites(deps, own);
    const scoped: PrivateSearchArgs = { ...args, filePoolSiteIds: sites.map((site) => site.siteId) };
    rows = [];
    for (const site of sites) rows.push(...(await privateSearchIn(deps, site, scoped)));
    if (sites.length > 1) rows = rows.sort(privateSearchOrder).slice(0, SEARCH_MAX_ROWS);
  } else {
    rows = await privateSearchIn(deps, searchSite(own), args);
  }
  return {
    rows,
    paging: { recordsPerPage: PRIVATE_SEARCH_RECORDS_PER_PAGE, startRow: input.startRow },
    sessionEffect: { kind: 'keywords', keywords: input.keywords },
  };
}

// ---- contentManager.getPublicSearch ----

/** The arguments of contentManager.getPublicSearch. */
export interface PublicSearchInput {
  siteId: string;
  keywords: string;
  /** A CF list of tags; searches by tag instead of keywords. */
  tag?: string;
  tagGroup?: string;
  sectionId?: string;
  /** A CF list of category ids, each matching every category whose path holds it. */
  categoryId?: string;
  /** Legacy `request.muraMobileRequest`. */
  mobile?: boolean;
}

/** The categories getPublicSearch filters by (`tcontentcategories.path LIKE %id%` per listed id), read in the category-pool tenant; undefined for no list. */
async function publicSearchCategories(deps: SearchDeps, actor: Actor, categoryId: string): Promise<string[] | undefined> {
  const listed = cfListToArray(categoryId);
  if (listed.length === 0) return undefined;
  return withPoolTenant(deps.db, actor.tenantId, 'category', async (tx) => {
    const ids = new Set<string>();
    for (const id of listed) {
      for (const found of await deps.repository.categories.descendantIds(tx, id)) ids.add(found);
    }
    return [...ids];
  });
}

/** contentManager.getPublicSearch (contentManager.cfc:2072-2085); restricted rows stay in, as the gateway returns them. */
export async function publicSearch(deps: SearchDeps, actor: Actor, input: PublicSearchInput): Promise<PublicSearchRow[]> {
  const own = await ownEntry(deps, actor);
  const categoryIds = await publicSearchCategories(deps, actor, input.categoryId ?? '');
  const rows = await withTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.content.publicSearch(tx, {
      siteId: input.siteId,
      keywords: input.keywords,
      tag: input.tag ?? '',
      sectionId: input.sectionId ?? '',
      today: deps.clock.now(),
      ...(input.tagGroup === undefined ? {} : { tagGroup: input.tagGroup }),
      ...(categoryIds === undefined ? {} : { categoryIds }),
      ...(input.mobile === undefined ? {} : { mobile: input.mobile }),
    }),
  );
  const fileTenantId = fileTenantOf(own);
  const ids = fileTenantId === own.tenantId ? [] : unjoinedFileIds(rows);
  const files = ids.length === 0 ? [] : await withTenant(deps.db, fileTenantId, (tx) => deps.repository.content.fileJoinColumns(tx, ids));
  return withFileColumns(rows, files);
}

// ---- JSON API findQuery for content ----

// findQuery's two exclusion lists (jsonApiUtility.cfc:2800 and 2850), lower-cased.
const QUERY_EXCLUDED = lowerSet(
  'expanddepth,expand,muraPointInTime,liveOnly,feedid,cacheid,_cacheid,distinct,fields,entityname,method,maxItems,pageIndex,itemsPerPage,sortBy,sortDirection,contentpoolid,shownavonly,showexcludesearch,includehomepage,feedname,useCategoryIntersect,useDataNamespace',
);
const EXPANDED_EXCLUDED = lowerSet(
  'expanddepth,muraPointInTime,liveOnly,feedid,maxItems,pageIndex,sort,itemsPerPage,sortBy,sortDirection,contentpoolid,shownavonly,showexcludesearch,includehomepage,feedname,expand,useCategoryIntersect,useDataNamespace',
);
const GROUPING_KEYS = lowerSet('openGrouping,orOpenGrouping,andOpenGrouping,closeGrouping');
const AGGREGATE_KEYS = lowerSet('sum,avg,count,max,min,groupBy');
const JOIN_KEYS = lowerSet('innerJoin,leftJoin');
/** The sorts setFeedProps hands to the content feed's sortBy instead of its ORDER BY. */
const SORT_BY_KEYS = lowerSet('comments,random,rating');
const SETTABLE_TYPES = lowerSet('form,component,variation');
const FLAG_PROPS = ['includeHomePage', 'shownavonly'] as const;

/** The feed a findQuery starts from: a stored feed by `feedid` or `feedname`, else the content entity's feed. */
export type ContentFeedSource = { kind: 'feedId'; feedId: string } | { kind: 'feedName'; name: string } | { kind: 'entity' };

/** One feedBean call findQuery and setFeedProps make, in legacy order. */
export type ContentFeedStep =
  | { kind: 'addParam'; param: Parameters<FeedBean['addParam']>[0] }
  | { kind: 'setValue'; key: string; value: unknown };

/** What contentQueryCriteria reads besides the params and query string. */
export interface ContentQueryOptions {
  /** `$.event()` values, which name a stored feed: the form scope, holding every merged request param; defaults to `params`. */
  event?: Struct;
  /** expandEntity's depth; above 0 every non-excluded param filters by equality instead of the query string. */
  expanded?: number;
  /** The request site's getContentPoolID() list, which bounds a requested `contentpoolid`. */
  contentPoolIds?: readonly string[];
  /** getModulePerm of the Site Manager module, without which `liveOnly` is ignored. */
  siteManagerAccess?: boolean;
}

// Expressed as feedBean calls rather than a repository FeedCriteria: feedContent derives that from the bean, through
// the bean's setters and its content-pool and category resolution, which a FeedCriteria built here would bypass.
/** findQuery's feed (jsonApiUtility.cfc:2711-2908): its source, its feedBean calls, the base URL after `<endpoint>/content/?` and `countOnly`. */
export interface ContentQueryCriteria {
  source: ContentFeedSource;
  steps: ContentFeedStep[];
  baseQuery: string;
  countOnly: boolean;
}

function setStep(key: string, value: unknown): ContentFeedStep {
  return { kind: 'setValue', key, value };
}

function paramStep(field: string, criteria: string, condition: string, relationship: string): ContentFeedStep {
  return { kind: 'addParam', param: { field, criteria, condition, relationship, datatype: '' } };
}

/** The stored feed findQuery loads: `feedid` from the query string's bracketed `feedid[...]` or the event, else `feedname`. */
function feedSource(queryArray: readonly string[], event: CfStruct): ContentFeedSource {
  for (const p of queryArray) {
    if (!cfEq(p.slice(0, 6), 'feedid')) continue;
    const checkProp = urlDecode(cfListFirst(p, '='));
    // Legacy compares the whole `name=value` item for an unbracketed name, so only `feedid[...]` (or a bare `feedid`) matches.
    const propName = checkProp.includes('[') ? cfListFirst(checkProp, '[') : p;
    if (cfEq(propName, 'feedid')) event.set('feedid', cfListLast(p, '='));
  }
  if (event.text('feedid') !== '') return { kind: 'feedId', feedId: event.text('feedid') };
  if (event.text('feedname') !== '') return { kind: 'feedName', name: event.text('feedname') };
  return { kind: 'entity' };
}

/** findQuery's query-string loop (2812-2903) over the URL scope `params`; returns the base URL query. */
function queryStringFilters(queryArray: readonly string[], params: CfStruct, steps: ContentFeedStep[]): string {
  const queryParams = queryArray.map((item) => urlDecode(cfListFirst(item, '='))).filter((key) => !cfEq(key, 'pageIndex'));
  let baseQuery = '';
  let started = false;
  let relationship = 'and';
  let advancedSort = '';
  for (const p of queryParams) {
    let propName = p.includes('[') ? cfListFirst(p, '[') : p;
    const key = propName.toLowerCase();
    if (key === 'changesetid') steps.push(setStep('activeOnly', 0));
    if (params.has(p)) {
      const text = params.text(p);
      baseQuery += `${started ? '&' : ''}${esapiUrlEncode(p)}${text === '' ? '' : `=${esapiUrlEncode(text)}`}`;
      started = true;
      if (key === 'sort') advancedSort = cfListAppend(advancedSort, text);
      else if (key === 'or') relationship = 'or';
      else if (GROUPING_KEYS.has(key)) {
        steps.push(paramStep('', '', 'EQUALS', p));
        relationship = 'and';
      } else if (AGGREGATE_KEYS.has(key)) {
        if (javaTrim(text) !== '') throw new FeedContentUnsupportedError(`The ${propName} aggregate of a content feed`);
      } else if (JOIN_KEYS.has(key)) {
        if (text !== '') throw new FeedContentUnsupportedError(`The ${propName} of a content feed`);
      } else if (!QUERY_EXCLUDED.has(key)) {
        // contentBean always holds `extendData`, so every other name filters, a non-column one as an extended attribute.
        let condition = 'eq';
        let criteria = text;
        const parts = cfListToArray(criteria, '^');
        if (parts.length > 1) {
          condition = parts[0] ?? condition;
          criteria = parts[1] ?? '';
        } else if (criteria.includes('*')) {
          condition = 'like';
          criteria = criteria.replaceAll('*', '%');
        }
        if (key === 'id') propName = 'contentid';
        steps.push(paramStep(propName, criteria, condition, relationship));
        relationship = 'and';
      }
    }
    // Legacy writes the joined sort back into `params`, so a repeated `sort` key reads the joined value.
    if (advancedSort !== '') params.set('sort', advancedSort);
  }
  return baseQuery;
}

/** findQuery's expanded branch (2796-2811): every non-excluded param filters by equality; the base URL is not encoded. */
function expandedFilters(params: CfStruct, steps: ContentFeedStep[]): string {
  const terms: string[] = [];
  for (const [key, value] of params.entries()) {
    if (EXPANDED_EXCLUDED.has(key.toLowerCase()) || value === undefined || value === null) continue;
    steps.push(paramStep(key, cfText(value), 'EQUALS', 'and'));
    terms.push(`${key}=${cfText(value)}`);
  }
  return terms.join('&');
}

/** setFeedProps' sort list (3012-3073): ORDER BY terms, or a sortBy for comments, random and rating. */
function sortSteps(sort: string, steps: ContentFeedStep[]): void {
  const orderBy: string[] = [];
  for (const s of cfListToArray(sort)) {
    if (s.length <= 1) {
      // Legacy's sortBy check here reads the previous term's prop, which is never one of the sortBy keys.
      orderBy.push(s);
      continue;
    }
    const signed = s.startsWith('+') || s.startsWith('-');
    let prop = signed ? s.slice(1) : s;
    if (SORT_BY_KEYS.has(prop.toLowerCase())) {
      steps.push(setStep('sortBy', prop));
      if (s.startsWith('-')) steps.push(setStep('sortDirection', 'desc'));
      // Legacy breaks before clearing useOrderby, so the terms before it still become the ORDER BY.
      break;
    }
    if (cfListToArray(prop, '.').length === 1) prop = `tcontent.${prop}`;
    orderBy.push(`${prop} ${s.startsWith('-') ? 'desc' : 'asc'}`);
  }
  steps.push(setStep('orderBy', orderBy.join(',')));
}

/** setFeedProps (2955-3158) for the content feed. */
function feedPropSteps(params: CfStruct, opts: ContentQueryOptions, steps: ContentFeedStep[]): void {
  const filled = (key: string): boolean => params.text(key) !== '';
  let sort = filled('orderby') ? params.text('orderby') : '';
  if (filled('sort')) sort = params.text('sort');
  if (filled('contentpoolid')) {
    const requested = params.text('contentpoolid');
    if (requested === '*') steps.push(setStep('contentPoolID', '*'));
    else {
      const valid = new Set((opts.contentPoolIds ?? []).map((id) => id.toLowerCase()));
      const pool = cfListToArray(requested).filter((id) => valid.has(id.toLowerCase()));
      if (pool.length > 0) steps.push(setStep('contentPoolID', pool.join(',')));
    }
  }
  if (filled('changesetid')) steps.push(setStep('activeOnly', 0));
  if (filled('type') && SETTABLE_TYPES.has(params.text('type').toLowerCase())) steps.push(setStep('type', params.get('type')));
  if (params.has('liveOnly') && cfIsBoolean(params.get('liveOnly')) && opts.siteManagerAccess === true) {
    steps.push(setStep('liveOnly', params.get('liveOnly')));
  }
  if (sort !== '') sortSteps(sort, steps);
  for (const flag of FLAG_PROPS) {
    if (params.has(flag) && cfIsBoolean(params.get(flag))) steps.push(setStep(flag, cfToBoolean(params.get(flag)) ? 1 : 0));
  }
  if (params.has('useCategoryIntersect')) steps.push(setStep('useCategoryIntersect', params.get('useCategoryIntersect')));
  if (params.has('showexcludesearch') && cfIsBoolean(params.get('showexcludesearch'))) {
    steps.push(setStep('showexcludesearch', cfToBoolean(params.get('showexcludesearch')) ? 1 : 0));
  }
  for (const key of ['sortdirection', 'sortby', 'type']) {
    if (filled(key)) steps.push(setStep(key, params.get(key)));
  }
  if (params.has('distinct') && cfIsBoolean(params.get('distinct'))) steps.push(setStep('distinct', params.get('distinct')));
  if (filled('fields')) {
    const fields = params.text('fields');
    // Aggregates throw before this point, so the query is never an aggregate one and the primary key is added.
    const withKey = cfListToArray(fields).some((field) => field.toLowerCase() === 'contentid') ? fields : cfListAppend(fields, 'contentid');
    params.set('fields', withKey);
    steps.push(setStep('fields', withKey));
  }
  if (params.has('maxitems')) {
    if (cfIsNumeric(params.get('maxitems'))) steps.push(setStep('maxItems', params.get('maxitems')));
    else if (params.text('maxitems') === '*') steps.push(setStep('maxItems', 0));
  }
  for (const key of ['size', 'limit']) {
    if (params.has(key) && cfIsNumeric(params.get(key))) steps.push(setStep('maxItems', params.get(key)));
  }
  if (params.has('cachedWithin') && cfIsNumeric(params.get('cachedWithin'))) {
    // createTimeSpan(0,0,0,n) holds days.
    steps.push(setStep('cachedWithin', cfToNumber(params.get('cachedWithin')) / SECONDS_PER_DAY));
  }
}

/** The content feed findQuery builds from `params` (the URL scope, or expandEntity's params) and the raw `queryString`. */
export function contentQueryCriteria(params: Struct, queryString: string, opts: ContentQueryOptions = {}): ContentQueryCriteria {
  const scope = new CfStruct(params);
  const queryArray = cfListToArray(queryString, '&');
  const source = feedSource(queryArray, new CfStruct(opts.event ?? params));
  const steps: ContentFeedStep[] = [];
  const baseQuery = (opts.expanded ?? 0) > 0 ? expandedFilters(scope, steps) : queryStringFilters(queryArray, scope, steps);
  feedPropSteps(scope, opts, steps);
  const countOnly = scope.get('countOnly');
  return { source, steps, baseQuery, countOnly: cfIsBoolean(countOnly) && cfToBoolean(countOnly) };
}

/** The request findContentQuery answers. */
export interface ContentQueryRequest {
  /** The request's legacy site id, already checked against the token's site. */
  siteId: string;
  /** findQuery's `params`: the URL scope, or expandEntity's params when `expanded`. */
  params: Struct;
  /** `cgi.QUERY_STRING` without the `?`. */
  queryString: string;
  /** `$.event()` values (see ContentQueryOptions); defaults to `params`. */
  event?: Struct;
  expanded?: number;
  /** The URL scope setIteratorProps pages by; defaults to `params`. */
  url?: Struct;
  /** settingsBean `extranet`, which getIterator passes as `applyPermFilter`. */
  extranet: boolean;
  /** Change-set preview, point in time and mobile flag of the request. */
  feedOptions?: Pick<FeedContentOptions, 'preview' | 'today' | 'mobile'>;
}

/** The content iterator's page values packageIteratorArray reads. */
export interface ContentQueryPaging {
  recordCount: number;
  /** Records per page (`getNextN()`). */
  nextN: number;
  pageIndex: number;
}

/** One page of findQuery rows with its paging and base URL query, or the `countOnly` count. */
export type ContentQueryResult = FeedCount | { rows: FeedContentRow[]; paging: ContentQueryPaging; baseQuery: string };

/** The feed bean findQuery starts from; a feed that is not found keeps the request site `$.getBean('feed')` gave it. */
async function sourceFeed(deps: SearchDeps, actor: Actor, siteId: string, source: ContentFeedSource): Promise<FeedBean> {
  const feed =
    source.kind === 'feedId'
      ? await readFeed(deps, actor, { feedId: source.feedId })
      : source.kind === 'feedName'
        ? await readFeed(deps, actor, { siteId, name: source.name })
        : FeedBean.init(deps.clock);
  if (feed.text('siteid') === '') feed.setValue('siteid', siteId);
  return feed;
}

/** contentIterator's page over `rows`: setQuery with the feed's nextN, then setIteratorProps over the URL scope (3160-3183). */
function contentIteratorPage(rows: readonly FeedContentRow[], feedNextN: unknown, url: CfStruct): { rows: FeedContentRow[]; paging: ContentQueryPaging } {
  const recordCount = rows.length;
  const perPageOf = (n: unknown): number => (cfIsNumeric(n) && cfToNumber(n) !== 0 ? cfToNumber(n) : recordCount);
  let perPage = perPageOf(feedNextN);
  let pageIndex = 1;
  let recordIndex = 0;
  const setPage = (n: number): void => {
    pageIndex = n;
    recordIndex = (n - 1) * perPage;
    if (recordIndex > recordCount) {
      recordIndex = 0;
      pageIndex = 1;
    }
  };
  if (url.has('itemsPerPage')) {
    if (cfIsNumeric(url.get('itemsPerPage'))) perPage = perPageOf(url.get('itemsPerPage'));
    else if (url.text('itemsPerPage') === '*') perPage = recordCount;
  }
  if (url.has('pageIndex') && cfIsNumeric(url.get('pageIndex'))) setPage(cfToNumber(url.get('pageIndex')));
  if (url.has('startIndex') && cfIsNumeric(url.get('startIndex'))) {
    const startRow = cfToNumber(url.get('startIndex'));
    if (recordCount > 0) {
      setPage(perPage !== 1 ? Math.ceil(startRow / perPage) : startRow);
      // A start row is queued to be next, so the record index sits one before it.
      const queued = startRow !== 0 ? startRow - 1 : 0;
      if (recordIndex !== queued && queued < recordCount) recordIndex = queued;
    } else {
      recordIndex = 0;
      setPage(1);
    }
  }
  // setIteratorProps calls setMaxItems on a `feed` it never defines, so a numeric offset fails the request.
  if (url.has('offset') && cfIsNumeric(url.get('offset'))) throw new LegacyApiError('server_error');
  const end = Math.min(recordCount, pageIndex * perPage);
  // packageRecord has no row at or below 0.
  if (recordIndex < 0 && recordIndex < end) throw new LegacyApiError('server_error');
  return { rows: rows.slice(recordIndex, end), paging: { recordCount, nextN: perPage, pageIndex } };
}

/** JSON API findQuery for `content` (jsonApiUtility.cfc:2711-2918): one content-iterator page, or the unfiltered `countOnly` count. */
export async function findContentQuery(deps: SearchDeps, actor: Actor, request: ContentQueryRequest): Promise<ContentQueryResult> {
  const own = await ownEntry(deps, actor);
  const criteria = contentQueryCriteria(request.params, request.queryString, {
    ...(request.event === undefined ? {} : { event: request.event }),
    ...(request.expanded === undefined ? {} : { expanded: request.expanded }),
    contentPoolIds: own.contentPoolIds,
    siteManagerAccess: getModulePerm(actor, SITE_TREE_MODULE_ID),
  });
  const feed = await sourceFeed(deps, actor, request.siteId, criteria.source);
  for (const step of criteria.steps) {
    if (step.kind === 'addParam') feed.addParam(step.param);
    else feed.setValue(step.key, step.value);
  }
  const options = request.feedOptions ?? {};
  if (criteria.countOnly) return feedContent(deps, actor, feed, { ...options, countOnly: true });
  const rows = await feedContent(deps, actor, feed, { ...options, applyPermFilter: request.extranet });
  const page = contentIteratorPage(rows, feed.get('nextn'), new CfStruct(request.url ?? request.params));
  return { ...page, baseQuery: criteria.baseQuery };
}

// ---- cnav.searchsitedata: settingsManager.getUserSites ----

/** A `tsettings` row getUserSites returns: the site id and its name (`site`). */
export interface SiteListRow {
  siteid: string;
  site: string | null;
}

/** The getUserSites arguments cnav.searchsitedata passes, with every site from verified site data. */
export interface SearchSiteDataInput<R extends SiteListRow = SiteListRow> {
  /** Every site (settingsManager.getList). */
  sites: readonly R[];
  /** `session.siteArray`: the sites the user had Site Manager module access to at login. */
  userSiteIds: readonly string[];
  isS2: boolean;
  searchString: string;
}

// SQL Server's default collation orders case-insensitively, accent-sensitively.
const SITE_NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'accent' });

/** getList(sortby="site"): `ORDER BY site`, NULL first, trailing spaces ignored; ties keep their given order. */
function bySiteName(a: SiteListRow, b: SiteListRow): number {
  if (a.site === null || b.site === null) return a.site === b.site ? 0 : a.site === null ? -1 : 1;
  return SITE_NAME_COLLATOR.compare(a.site.trimEnd(), b.site.trimEnd());
}

/** A query-of-queries LIKE pattern (`%`, `_`, `[...]`, `[^...]`) as a case-sensitive matcher, as ColdFusion compares it. */
function qoqLike(pattern: string): (value: string) => boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    const close = ch === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else if (close > 0) {
      const body = pattern.slice(i + 1, close);
      const negated = body.startsWith('^') && body.length > 1;
      source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&')}]`;
      i = close;
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  const expression = new RegExp(`^${source}$`);
  return (value) => expression.test(value);
}

/** cnav.searchsitedata (cnav.cfc:10-18): getUserSites(session.siteArray, isS2, searchString, -1) rows, which renderSearchSiteDataJson maps to `{id, value}`. */
export function searchSiteData<R extends SiteListRow>(input: SearchSiteDataInput<R>): R[] {
  const ordered = [...input.sites].sort(bySiteName);
  const allowed = new Set(input.userSiteIds);
  const visible = input.isS2 ? ordered : ordered.filter((row) => allowed.has(row.siteid));
  if (input.searchString === '') return visible;
  const matches = qoqLike(`%${input.searchString}%`);
  return visible.filter((row) => matches(row.siteid) || (row.site !== null && matches(row.site)));
}
