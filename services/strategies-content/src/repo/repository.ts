/** The only write path of schema `content`: the platform repository plus the helpers of each content area, with the read query modules re-exposed. */
import {
  RepositoryError,
  acquireWriteGates,
  createRepository,
  isMigrationAuthority,
  qualified,
  type Repository,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { LEGACY_ADMIN_SENTINEL_ID, cfEq, cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import * as contentQueries from './content-queries.js';
import { ContentQueryError, SqlParams, firstById, type SortDirection } from './content-queries.js';
import * as feedQueries from './feed-queries.js';
import * as fileQueries from './files.js';
import {
  APPROVAL_ACTION,
  APPROVAL_ASSIGNMENT,
  APPROVAL_CHAIN,
  APPROVAL_MEMBERSHIP,
  APPROVAL_REQUEST,
  CATEGORY,
  CATEGORY_ASSIGN,
  CHANGESET,
  CHANGESET_CATEGORY_ASSIGN,
  CHANGESET_ROLLBACK,
  CHANGESET_TAG_ASSIGN,
  COMMENT,
  COMMENTER,
  CONTENT,
  CONTENT_ASSIGNMENT,
  CONTENT_OBJECT,
  CONTENT_RATING,
  CONTENT_RELATED,
  CONTENT_STATS,
  CONTENT_TAG,
  DISPLAY_TITLE_APPROVAL,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RCSET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  FEED,
  FEED_ADVANCED_PARAM,
  FEED_ITEM,
  FILE,
  FILE_METADATA,
  FILE_OBJECT,
  FILENAME_ARCHIVE,
  FORM_RESPONSE_PACKET,
  FORM_RESPONSE_QUESTION,
  GROUP_PROJECTION,
  MEMBERSHIP_PROJECTION,
  OWNED_TABLES,
  PERMISSION_PROJECTION,
  PUBLIC_SUBMISSION_APPROVAL,
  REMOTE_POINTER,
  SOURCE_MAP,
  TRASH,
  VARIATION_TARGETING,
  type ApprovalActionRow,
  type ApprovalAssignmentRow,
  type ApprovalChainRow,
  type ApprovalMembershipRow,
  type ApprovalRequestRow,
  type CategoryAssignRow,
  type CategoryRow,
  type ChangesetCategoryAssignRow,
  type ChangesetRollbackRow,
  type ChangesetRow,
  type ChangesetTagAssignRow,
  type CommentRow,
  type CommenterRow,
  type ContentAssignmentRow,
  type ContentObjectRow,
  type ContentRatingRow,
  type ContentRelatedRow,
  type ContentRow,
  type ContentStatsRow,
  type ContentTagRow,
  type DisplayTitleApprovalRow,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendRcsetRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
  type FeedAdvancedParamRow,
  type FeedItemRow,
  type FeedRow,
  type FileMetadataRow,
  type FileObjectRow,
  type FileRow,
  type FilenameArchiveRow,
  type FormResponsePacketRow,
  type FormResponseQuestionRow,
  type GroupProjectionRow,
  type MembershipProjectionRow,
  type PermissionProjectionRow,
  type PublicSubmissionApprovalRow,
  type RemotePointerRow,
  type SourceMapRow,
  type TrashRow,
  type VariationTargetingRow,
} from './tables.js';

/** Service name the strategies-content write positions carry. */
export const OWNER = 'strategies-content' as const;

/** Schema the strategies-content service owns. */
export const SCHEMA = 'content' as const;

/** Content types whose sibling order numbers `contentManager.save` shifts (contentManager.cfc:1543-1556). */
export const SIBLING_ORDER_TYPES: readonly string[] = Object.freeze(['Page', 'Folder', 'Link', 'File', 'Component', 'Calendar', 'Form']);

/** Settings of `createContentRepository`; `schema` differs from `content` only for throwaway test schemas. */
export interface ContentRepositoryOptions {
  clock?: Clock;
  schema?: string;
}

/** The columns of row `R` a write may supply: every column but `tenant_id`, each optional. */
export type Fields<R> = { [K in Exclude<keyof R, 'tenant_id'>]?: R[K] };

/** A change of row `R`: any columns but `tenant_id` and the listed fixed ones. */
export type Patch<R, Fixed extends keyof R = never> = { [K in Exclude<keyof R, 'tenant_id' | Fixed>]?: R[K] };

/** A patch, or a function that derives one from the locked row (null leaves the row unchanged). */
export type PatchOf<R, Fixed extends keyof R = never> = Patch<R, Fixed> | ((row: R) => Patch<R, Fixed> | null);

/** A page of a list read: `limit` rows after the first `offset` (default 0). */
export interface RowPage {
  limit: number;
  offset?: number;
}

/** One page of a list read and the count of every row the unpaged read returns. */
export interface PagedRows<R> {
  rows: R[];
  total: number;
}

/** Rows per batch of the batched all-results reads. */
export const DEFAULT_ROW_BATCH_SIZE = 500;

type Ctx = WriteContext | undefined;
type TableDef = { readonly table: string; readonly key: readonly string[] | null; readonly unit?: string };

/** A list read's SELECT without its ORDER BY, the ORDER BY clause, and the bound values. */
interface BuiltSelect {
  readonly select: string;
  readonly order: string;
  readonly values: readonly unknown[];
}

let batchCursorCount = 0;

/** The forms a stored single-case CF id may take for a caller-supplied id. */
function idForms(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]))];
}

/** SQL Server `expr IN (ids)` for a stored CF id column under its case-insensitive collation. */
function idIn(p: SqlParams, expr: string, ids: readonly string[]): string {
  return `${expr} = ANY(${p.add(idForms(ids))}::bpchar[])`;
}

/** SQL Server `expr = id` for a stored CF id column. */
function idEq(p: SqlParams, expr: string, id: string): string {
  return idIn(p, expr, [id]);
}

/** SQL Server `expr = value`: case-insensitive, trailing spaces ignored. */
function ciEq(p: SqlParams, expr: string, value: string): string {
  return `lower(rtrim(${expr})) = lower(rtrim(${p.add(value)}::text))`;
}

/** SQL Server `expr IN (values)` under its case-insensitive collation. */
function ciIn(p: SqlParams, expr: string, values: readonly string[]): string {
  return `lower(rtrim(${expr})) IN (SELECT lower(rtrim(v)) FROM unnest(${p.add(values)}::text[]) AS v)`;
}

/** SQL Server `expr LIKE pattern`: case-insensitive and without an escape character. */
function ciLike(p: SqlParams, expr: string, pattern: string): string {
  return `upper(${expr}) LIKE upper(${p.add(pattern)}::text) ESCAPE ''`;
}

/** One ORDER BY key with SQL Server's NULL placement: lowest, so first ascending and last descending. */
function orderKey(expr: string, direction: SortDirection): string {
  return `${expr} ${direction.toUpperCase()} NULLS ${direction === 'asc' ? 'FIRST' : 'LAST'}`;
}

/** The elements of a CF list: comma-separated, empty elements skipped. */
function cfList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').filter((item) => item.length > 0);
}

/** A stored CF string value: the empty string stored as NULL, as the legacy DAOs bind `null="#value eq ''#"`. */
function nullIfEmpty<T>(value: T): T | null {
  return value === '' ? null : value;
}

/** CF `createDateTime(y, m, d, h, n, 0)`: the wall-clock minute of `value`, or null when it is not a date. */
function toMinute(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  const result = new Date(value.getTime());
  result.setSeconds(0, 0);
  return result;
}

/** CF `createDateTime(y, m, d, h, n, s)`: the wall-clock second of `value`, or null when it is not a date. */
function toSecond(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  const result = new Date(value.getTime());
  result.setMilliseconds(0);
  return result;
}

/** CF `createDateTime(year, month, day, h, n, s)` of the calendar day of `value`. */
function atTimeOfDay(value: Date, hours: number, minutes: number, seconds: number): Date {
  const result = new Date(value.getTime());
  result.setHours(hours, minutes, seconds, 0);
  return result;
}

/** CF `replaceNoCase(text, find, replacement, "ALL")`. */
function replaceAllNoCase(text: string, find: string, replacement: string): string {
  if (find === '') {
    return text;
  }
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return text.replace(pattern, () => replacement);
}

/** Distinct units of `defs`, in order; tables without a unit add none. */
function unitsOf(...defs: readonly TableDef[]): string[] {
  return [...new Set(defs.flatMap((def) => (def.unit === undefined ? [] : [def.unit])))];
}

/** The primary-key columns of `row` under `def`. */
function keyOf(def: TableDef, row: RepositoryRow): RepositoryRow {
  if (def.key === null) {
    throw new RepositoryError('has no primary key', def.table);
  }
  return Object.fromEntries(def.key.map((column) => [column, row[column]]));
}

/** The columns of `row` other than `tenant_id`, `legacy_row_hash` and `occurrence`: the content image of a keyless row. */
function keylessContent(row: RepositoryRow): RepositoryRow {
  return Object.fromEntries(
    Object.entries(row).filter(([column]) => column !== 'tenant_id' && column !== 'legacy_row_hash' && column !== 'occurrence'),
  );
}

/** `values` with each duplicate dropped, first occurrence kept. */
function distinctValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The non-empty elements of a CF list with case-insensitive duplicates dropped, as repeated ORM `loadBy(…).save()` calls leave them. */
function distinctNoCase(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const lowered = value.toLowerCase();
    if (value === '' || seen.has(lowered)) {
      return false;
    }
    seen.add(lowered);
    return true;
  });
}

// ---- content ----

/** A content version to insert; `contentid` and `contenthistid` default to new CF UUIDs. */
export type VersionInput = Omit<Fields<ContentRow>, 'tcontent_id'>;

/** A column-scoped change of content versions. */
export type ContentPatch = Patch<ContentRow, 'tcontent_id'>;

/** The versions a multi-row legacy `update tcontent … where` touches; LIKE patterns are the legacy statement's own. */
export interface VersionFilter {
  siteId?: string;
  contentId?: string;
  contentIds?: readonly string[];
  contentHistIds?: readonly string[];
  parentId?: string;
  remoteId?: string;
  changesetId?: string;
  active?: number;
  approved?: number;
  types?: readonly string[];
  orderNoAbove?: number;
  filename?: string;
  filenameLike?: string;
  pathLike?: string;
  bodyLike?: string;
  summaryLike?: string;
}

/** A display object placed on a version (contentDAO.createObjects). */
export type ContentObjectInput = Omit<Fields<ContentObjectRow>, 'contenthistid'> & {
  objectid: string;
  object: string;
  orderno: number;
  columnid: number;
};

/** A tag of a version (contentDAO.createTags). */
export interface ContentTagInput {
  contentid: string;
  siteid: string;
  tag: string;
  taggroup?: string | null;
}

/** A related-content item of a version (contentDAO.createRelatedItems). */
export interface RelatedItemInput {
  contentid: string;
  relatedid: string;
  relatedcontentsetid?: string | null;
  orderno?: number | null;
}

/** A category assignment of a version; feature dates are stored only for scheduled features (`isfeature = 2`). */
export type CategoryAssignmentInput = Omit<Fields<CategoryAssignRow>, 'contenthistid'> & { categoryid: string };

/** A content assignment row (contentDAO.createContentAssignment). */
export type ContentAssignmentInput = Omit<ContentAssignmentRow, 'tenant_id'>;

/** What a version deletion removed: the version rows and the values of their File extend attributes. */
export interface VersionDeletion {
  versions: ContentRow[];
  /** Candidates for the file manager's `deleteIfNotUsed`, which runs in the file-pool tenant. */
  extendFileIds: string[];
}

/** The content item `contentDAO.delete` removes. */
export interface ContentDeletionArgs {
  contentId: string;
  siteId: string;
  parentId: string | null;
  type: string | null;
}

/** Which versioned objects `contentDAO.deleteVersionedObjects` removes: one version's, or every version's of an item. */
export type VersionedObjectsTarget = { contentHistId: string } | { contentId: string; siteId: string };

/** Which metadata rows `persistVersionedObjects` carries to the new version. */
export interface PersistVersionedOptions {
  /** Only rows whose file the new version still references (`contentFileMetaDataBean.persistToVersion`). */
  fileIds?: readonly string[];
  /** Rows the save removed or replaced (`removeObjects`, `addObjects`). */
  excludeMetaIds?: readonly string[];
}

/** A version's columns as `contentDAO.create` stores them, with `lastupdate` stamped by the clock. */
function versionStorage(row: VersionInput, now: Date): RepositoryRow {
  const stored: RepositoryRow = { ...row };
  for (const column of VERSION_NULL_IF_EMPTY) {
    if (column in stored) {
      stored[column] = nullIfEmpty(stored[column]);
    }
  }
  for (const column of VERSION_TRIMMED) {
    const value = stored[column];
    if (typeof value === 'string') {
      stored[column] = value.trim();
    }
  }
  const scheduled = Number(row.display) === 2;
  const featured = Number(row.isfeature) === 2;
  stored.displaystart = scheduled ? toMinute(row.displaystart) : null;
  stored.displaystop = scheduled ? toMinute(row.displaystop) : null;
  stored.featurestart = featured ? toMinute(row.featurestart) : null;
  stored.featurestop = featured ? toMinute(row.featurestop) : null;
  stored.releasedate = toSecond(row.releasedate);
  stored.expires = toSecond(row.expires);
  stored.created = toSecond(row.created) ?? now;
  stored.targetparams = row.target === '_blank' && row.targetparams !== undefined && row.targetparams !== null && row.targetparams !== '' ? row.targetparams : null;
  stored.lastupdate = now;
  return stored;
}

/** A category assignment as `categoryDAO.saveAssignment` stores it: feature dates only for a scheduled feature. */
function assignmentStorage(row: Fields<CategoryAssignRow>): RepositoryRow {
  const scheduled = Number(row.isfeature) === 2;
  return { ...row, featurestart: scheduled ? (row.featurestart ?? null) : null, featurestop: scheduled ? (row.featurestop ?? null) : null };
}

// contentDAO.create binds these with null="#value eq ''#".
const VERSION_NULL_IF_EMPTY = [
  'metadesc', 'metakeywords', 'body', 'summary', 'path', 'tags', 'responsemessage', 'responsedisplayfields', 'title',
  'menutitle', 'filename', 'parentid', 'lastupdateby', 'lastupdatebyid', 'siteid', 'target', 'restrictgroups', 'template',
  'responsesendto', 'moduleassign', 'notes', 'inheritobjects', 'sortby', 'sortdirection', 'fileid', 'remoteid', 'remoteurl',
  'remotepubdate', 'remotesource', 'remotesourceurl', 'credits', 'audience', 'keypoints', 'urltitle', 'htmltitle',
  'changesetid', 'imagesize', 'imageheight', 'imagewidth', 'childtemplate', 'displayinterval', 'objectparams',
] as const;
// contentDAO.create stores these trimmed.
const VERSION_TRIMMED = ['title', 'parentid', 'lastupdateby', 'lastupdatebyid'] as const;

// ---- stats and files ----

/** The content item a stats row belongs to. */
export interface StatsKey {
  contentId: string;
  siteId: string;
}

/** Stats columns a save may change; a non-numeric count is ignored as the bean setters ignore it. */
export type StatsChanges = Patch<ContentStatsRow, 'contentid' | 'siteid'>;

/** `raterManager.getAvgRating`: the truncated integer average, vote count, up votes and down votes (rate 1). */
export interface AvgRatingRow {
  theavg: number | null;
  thecount: number;
  upvotes: number | null;
  downvotes: number | null;
}

/** `raterManager.getTopRated` columns; the `tfiles` columns come from `content.fileJoinColumns` by `fileid`. */
export type TopRatedRow = Pick<
  ContentRow,
  | 'contenthistid' | 'contentid' | 'approved' | 'filename' | 'active' | 'type' | 'orderno' | 'parentid' | 'siteid' | 'moduleid'
  | 'title' | 'menutitle' | 'lastupdate' | 'lastupdateby' | 'lastupdatebyid' | 'display' | 'displaystart' | 'displaystop'
  | 'isnav' | 'restricted' | 'isfeature' | 'inheritobjects' | 'target' | 'targetparams' | 'islocked' | 'sortby'
  | 'sortdirection' | 'releasedate' | 'fileid'
> & { theavg: number | null; thecount: number };

/** Arguments of `raterManager.getTopRated`; dates bound the rating's entered day. */
export interface TopRatedArgs {
  siteId: string;
  threshold?: number;
  limit?: number;
  startDate?: Date;
  stopDate?: Date;
}

/** A non-image upload as `fileDAO.create` stores it; image bytes stay null because renditions are legacy-written. */
export type FileInput = Omit<Fields<FileRow>, 'image' | 'imagesmall' | 'imagemedium'> & { contentid?: string | null; siteid: string };

/** A stored-object manifest row of `content-files`. */
export type FileObjectInput = Omit<Fields<FileObjectRow>, 'size' | 'created_at'> & {
  file_id: string;
  variant: string;
  ext: string;
  object_key: string;
  sha256: string;
  size: number | string;
  created_at?: Date;
};

/** A file metadata row of a version (contentFileMetaDataBean). */
export type FileMetadataInput = Omit<Fields<FileMetadataRow>, 'metaid'> & { metaid?: string };

/** What `files.deleteAllForContent` found and marked: each version's file and the files marked deleted. */
export interface ContentFilesDeletion {
  versionFiles: { contenthistid: string; fileid: string }[];
  deletedFileIds: string[];
}

/** A row as the ORM bean save stores it: empty strings of nullable columns as NULL. */
function ormStorage(row: RepositoryRow): RepositoryRow {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, nullIfEmpty(value)]));
}

const STATS_COUNT_COLUMNS = ['views', 'rating', 'totalvotes', 'upvotes', 'downvotes', 'comments', 'disablecomments', 'majorversion', 'minorversion'] as const;
// `select *` of tcontentstats without the tenant column.
const STATS_FEED_COLUMNS = CONTENT_STATS.columns
  .map((column) => column.name)
  .filter((column) => column !== 'tenant_id')
  .join(', ');
// raterManager.getTopRated's content types and grouped content columns (raterManager.cfc:204-253), plus `fileid` for the file join.
const TOP_RATED_TYPES = ['Page', 'Component', 'Link', 'File', 'Folder', 'Calendar', 'Form', 'Gallery'];
const TOP_RATED_COLUMNS = [
  'contenthistid', 'contentid', 'approved', 'filename', 'active', 'type', 'orderno', 'parentid', 'siteid', 'moduleid', 'title',
  'menutitle', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'display', 'displaystart', 'displaystop', 'isnav', 'restricted',
  'isfeature', 'inheritobjects', 'target', 'targetparams', 'islocked', 'sortby', 'sortdirection', 'releasedate', 'fileid',
] as const;

// ---- feeds, comments and categories ----

/** A feed (collection) to insert; `feedid` defaults to a new CF UUID. */
export type FeedInput = Omit<Fields<FeedRow>, 'feedid'> & { feedid?: string; siteid: string };

/** One advanced filter of a feed (feedDAO.createAdvancedParams); each insert gets a new `paramid`. */
export interface FeedAdvancedParamInput {
  param: number | string | null;
  relationship: string | null;
  field: string | null;
  datatype: string | null;
  condition: string | null;
  criteria: string | null;
}

/** The content and category items of a feed (feedDAO.createItems of the `contentID` and `categoryID` lists). */
export interface FeedItemsInput {
  contentIds?: readonly string[];
  categoryIds?: readonly string[];
}

/** The item and advanced-param sets feedDAO.create and update write with the feed row. */
export interface FeedChildrenInput extends FeedItemsInput {
  advancedParams?: readonly FeedAdvancedParamInput[];
}

/** A comment to insert (contentCommentBean.save); `commentid` defaults to a new CF UUID, `path` comes from the caller. */
export type CommentInput = Omit<Fields<CommentRow>, 'commentid'> & { commentid?: string; contentid: string; siteid: string };

/** A comment change (contentCommentBean.save of an existing comment). */
export type CommentPatch = Patch<CommentRow, 'commentid'>;

/** The comment columns of contentDAO.readComments; the commenter photo comes from the people service. */
export type CommentListRow = Pick<
  CommentRow,
  'contentid' | 'commentid' | 'parentid' | 'name' | 'email' | 'url' | 'comments' | 'entered' | 'siteid' | 'isapproved' | 'subscribe' | 'userid' | 'path'
> & { kids: number | null };

/** contentCommentBean.getQuery: the comment with its flags and legacy's `kids` count. */
export type CommentFindRow = CommentListRow & Pick<CommentRow, 'isdeleted' | 'isspam' | 'remoteid' | 'flagcount'>;

/** contentCommentBean.getCrumbQuery: a comment of the path with its depth. */
export type CommentCrumbRow = CommentListRow & { depth: number };

/** Arguments of contentDAO.readComments, with its defaults. */
export interface ListCommentsArgs {
  contentId: string;
  siteId: string;
  isEditor?: boolean;
  sortOrder?: SortDirection;
  parentId?: string;
  filterByParentId?: boolean;
  includeSpam?: boolean;
  includeDeleted?: boolean;
  includeKids?: boolean;
}

/** Arguments of contentCommentManager.getComments; an omitted filter is not applied, `siteId` defaults to `default`. */
export interface CommentFeedArgs {
  siteId?: string;
  commentId?: string;
  keywords?: string;
  contentId?: string;
  parentId?: string;
  remoteId?: string;
  ip?: string;
  email?: string;
  name?: string;
  isApproved?: boolean;
  isSpam?: boolean;
  isDeleted?: boolean;
  startDate?: Date;
  endDate?: Date;
  categoryIds?: readonly string[];
  sortBy?: string;
  sortDirection?: string;
  maxItems?: number;
}

/** A category to insert; `categoryid` defaults to a new CF UUID. */
export type CategoryInput = Omit<Fields<CategoryRow>, 'categoryid'> & { categoryid?: string; siteid: string };

/** A category change. */
export type CategoryPatch = Patch<CategoryRow, 'categoryid'>;

/** Arguments of categoryDAO.setAssignment; the feature start and stop already carry the chosen hour and minute. */
export interface SetAssignmentArgs {
  categoryId: string;
  contentId: string;
  contentHistId: string;
  isFeature: number;
  orderNo: number;
  siteId: string;
  featureStart?: Date | null;
  featureStop?: Date | null;
}

/** categoryGateway.getCategories columns. */
export type CategoryListRow = Pick<
  CategoryRow,
  'siteid' | 'categoryid' | 'name' | 'filename' | 'urltitle' | 'parentid' | 'isactive' | 'isinterestgroup' | 'isopen' | 'restrictgroups' | 'isfeatureable'
> & { haskids: number };

/** Arguments of categoryGateway.getCategories; `siteId` is the category pool site. */
export interface ListCategoriesArgs {
  siteId: string;
  parentId?: string;
  keywords?: string;
  activeOnly?: boolean;
  interestsOnly?: boolean;
}

/** A site whose interest groups `privateInterestGroups` and `publicInterestGroups` list, with its name (`tsettings.Site`). */
export interface InterestGroupSite {
  siteId: string;
  site: string | null;
}

/** categoryGateway.getPrivateInterestGroups and getPublicInterestGroups columns. */
export type InterestGroupRow = Pick<CategoryRow, 'categoryid' | 'name' | 'filename' | 'urltitle' | 'isopen'> & { site: string | null; haskids: number };

/** categoryGateway.getCategoryFeatures columns; the `tfiles` columns come from `content.fileJoinColumns` by `fileid`. */
export type CategoryFeatureRow = Pick<
  ContentRow,
  | 'title' | 'releasedate' | 'menutitle' | 'lastupdate' | 'summary' | 'filename' | 'type' | 'contentid' | 'target' | 'targetparams'
  | 'restricted' | 'restrictgroups' | 'displaystart' | 'displaystop' | 'display' | 'active' | 'approved' | 'fileid' | 'credits'
  | 'remotesource' | 'remoteurl' | 'remotesourceurl' | 'audience' | 'keypoints'
> &
  Pick<CategoryAssignRow, 'orderno' | 'featurestart' | 'featurestop' | 'isfeature'> & { comments: number };

/** The category bean settings a feature list sorts by. */
export interface CategoryFeatureArgs {
  categoryId: string;
  sortBy: string;
  sortDirection: string;
}

/** categoryGateway.getCrumbQuery columns. */
export type CategoryCrumbRow = Pick<
  CategoryRow,
  | 'categoryid' | 'siteid' | 'datecreated' | 'lastupdate' | 'lastupdateby' | 'name' | 'isinterestgroup' | 'parentid' | 'isactive'
  | 'isopen' | 'notes' | 'sortby' | 'sortdirection' | 'restrictgroups' | 'path' | 'remoteid' | 'remotesourceurl' | 'remotepubdate'
> & { depth: number };

/** How categoryDAO looks a category up: by id, or within a category pool site by name, URL title, filename or remote id. */
export type CategoryLookup =
  | { categoryId: string }
  | { name: string; siteId: string }
  | { urlTitle: string; siteId: string }
  | { filename: string; siteId: string }
  | { remoteId: string; siteId: string };

/** A category row as categoryDAO stores it: empty strings as NULL, the flag columns 0 unless numeric. */
function categoryStorage(row: RepositoryRow): RepositoryRow {
  const stored = ormStorage(row);
  for (const column of ['isinterestgroup', 'isactive', 'isopen', 'isfeatureable']) {
    if (column in stored) {
      const value = stored[column];
      stored[column] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }
  }
  for (const column of ['datecreated', 'lastupdate']) {
    if (column in stored && !(stored[column] instanceof Date)) {
      stored[column] = null;
    }
  }
  return stored;
}

/** A feed row as feedDAO stores it: empty strings as NULL, creation and update stamps only when dates. */
function feedStorage(row: RepositoryRow): RepositoryRow {
  const stored = ormStorage(row);
  for (const column of ['datecreated', 'lastupdate']) {
    if (column in stored && !(stored[column] instanceof Date)) {
      stored[column] = null;
    }
  }
  return stored;
}

/** A comment row as contentCommentBean.save stores it: empty parent, email, URL and remote id as NULL. */
function commentStorage(row: RepositoryRow): RepositoryRow {
  const stored = { ...row };
  for (const column of ['parentid', 'email', 'url', 'remoteid']) {
    if (column in stored) {
      stored[column] = nullIfEmpty(stored[column]);
    }
  }
  return stored;
}

/** The sort direction of a legacy `order by #sortby# #sortdirection#`; anything else fails as the SQL would. */
function sqlDirection(direction: string): SortDirection {
  const lowered = direction.trim().toLowerCase();
  if (lowered !== 'asc' && lowered !== 'desc') {
    throw new ContentQueryError(`Invalid sort direction ${direction}`);
  }
  return lowered;
}

/** The ORDER BY key of column `sortBy` of `def` under alias `alias`; an unknown column fails as the legacy SQL would. */
function sortColumn(def: { readonly table: string; readonly columns: readonly { readonly name: string; readonly type: string }[] }, alias: string, sortBy: string): string {
  const column = def.columns.find((candidate) => candidate.name === sortBy.trim().toLowerCase() && candidate.name !== 'tenant_id');
  if (column === undefined) {
    throw new ContentQueryError(`Invalid column name ${sortBy} for ${def.table}`);
  }
  return column.type === 's' ? `lower(${alias}.${column.name})` : `${alias}.${column.name}`;
}

// ---- change sets, approvals, forms, extend, variation, queues, trash and projections ----

/** A change set to save; `created` and `lastupdate` are stamped as changesetManager.save stamps them. */
export type ChangesetInput = Omit<Fields<ChangesetRow>, 'changesetid' | 'created' | 'lastupdate'> & { changesetid?: string; siteid: string };

/** The category and tag lists changesetManager.save assigns to a change set. */
export interface ChangesetAssignmentsInput {
  categoryIds?: readonly string[];
  tags?: readonly string[];
}

/** How changesetManager.read finds a change set. */
export type ChangesetLookup = { changesetId: string } | { name: string; siteId: string } | { remoteId: string; siteId: string };

/** Arguments of changesetManager.getQuery. */
export interface ChangesetQueryArgs {
  siteId: string;
  published?: number;
  publishDate?: Date;
  publishDateOnly?: boolean;
  keywords?: string;
  sortBy?: string;
  openOnly?: boolean;
  tag?: string;
}

/** changesetManager.getQuery columns. */
export type ChangesetListRow = Pick<
  ChangesetRow,
  'changesetid' | 'siteid' | 'name' | 'description' | 'created' | 'publishdate' | 'published' | 'lastupdate' | 'lastupdateby' | 'remoteid' | 'remotepubdate' | 'remotesourceurl'
>;

/** changesetManager.getPendingByContentID columns. */
export type ChangesetPendingRow = Pick<ContentRow, 'contentid' | 'contenthistid' | 'siteid' | 'menutitle' | 'lastupdate' | 'lastupdateby'> &
  Pick<ChangesetRow, 'changesetid' | 'publishdate' | 'closedate'> & {
    changesetname: string | null;
    approvalstatus: string | null;
    requestid: string | null;
    approvalgroupid: string | null;
  };

/** changesetManager.getAssignmentsQuery columns; `fileext` comes from `content.fileJoinColumns` by `fileid`. */
export type ChangesetAssignmentRow = Pick<
  ContentRow,
  | 'menutitle' | 'siteid' | 'parentid' | 'path' | 'contentid' | 'contenthistid' | 'fileid' | 'type' | 'subtype' | 'lastupdateby' | 'active'
  | 'approved' | 'lastupdate' | 'lastupdatebyid' | 'display' | 'displaystart' | 'displaystop' | 'moduleid' | 'isnav' | 'notes' | 'isfeature'
  | 'inheritobjects' | 'filename' | 'targetparams' | 'releasedate' | 'changesetid' | 'title' | 'remoteid' | 'remoteurl' | 'urltitle'
> & { approvalstatus: string | null; requestid: string | null };

/** An approval chain to insert; `lastupdate` is stamped as the bean save stamps it. */
export type ApprovalChainInput = Omit<Fields<ApprovalChainRow>, 'chainid' | 'lastupdate'> & { chainid?: string; siteid: string };

/** An approval request to insert; `status` defaults to `Pending`, as the bean property does. */
export type ApprovalRequestInput = Omit<Fields<ApprovalRequestRow>, 'requestid'> & { requestid?: string; contenthistid: string };

/** An approval action to insert. */
export type ApprovalActionInput = Omit<Fields<ApprovalActionRow>, 'actiontid'> & { actiontid?: string; requestid: string };

/** A chain assignment of a content node to save. */
export type ApprovalAssignmentInput = Omit<Fields<ApprovalAssignmentRow>, 'assignmentid'> & { assignmentid?: string };

/** Which approval requests `requestsByStatus` lists. */
export interface ApprovalRequestFilter {
  status: string;
  siteId?: string;
  chainId?: string;
  groupId?: string;
}

/** One form submission as dataCollectionManager.update writes it: the questions, then the packet. */
export interface FormResponseInput {
  responseid?: string;
  formid: string;
  siteid: string;
  entered: Date;
  /** The WDDX packet, stored and returned byte-exact. */
  data: string | null;
  fieldlist: string | null;
  questions: readonly { formfield: string; formvalue: string | null; pollvalue?: string | null }[];
}

/** The rows a form submission wrote. */
export interface FormResponseWrite {
  packet: FormResponsePacketRow;
  questions: FormResponseQuestionRow[];
}

/** What dataCollectionManager.delete removed, with the attachment file ids its `deleteFiles` marks deleted in the file tenant. */
export interface FormResponseDeletion {
  packet: FormResponsePacketRow | null;
  questions: FormResponseQuestionRow[];
  attachmentFileIds: string[];
}

/** Arguments of dataCollectionManager.getData; `start` and `stop` already carry the chosen hour and minute. */
export interface FormResponsesArgs {
  formId: string;
  siteId: string;
  fieldNames?: readonly string[];
  start?: Date;
  stop?: Date;
  keywords?: string;
  filterBy?: string;
  sortBy?: string;
  sortDirection?: string;
}

/** One extend value of a base object, saved per attribute as extendManager.saveExtendedData saves it. */
export type ExtendDataInput = Omit<Fields<ExtendDataRow>, 'dataid' | 'baseid'> & { attributeid: number };

/** An extend value with the attribute, set and subtype it belongs to (extendManager.preserveExtendedData's select). */
export type ExtendDataDetailRow = ExtendDataRow & {
  name: string | null;
  extendsetid: string | null;
  subtypeid: string | null;
  type: string | null;
  subtype: string | null;
};

/** A variation targeting row to save. */
export type VariationTargetingInput = Omit<Fields<VariationTargetingRow>, 'targetingid'> & { targetingid?: string };

/** A trash row to insert (trashManager.throwIn). */
export type TrashInput = Omit<Fields<TrashRow>, 'objectid'> & { objectid: string };

/** trashManager.getQuery columns. */
export type TrashListRow = Omit<TrashRow, 'tenant_id' | 'objectstring'>;

/** Arguments of trashManager.getQuery; `objectLabel` compares `objectClass`, as legacy's does. */
export interface TrashQueryArgs {
  siteId?: string;
  objectId?: string;
  parentId?: string;
  objectType?: string;
  objectSubType?: string;
  objectClass?: string;
  deletedBy?: string;
  deleteId?: string;
  objectLabel?: string;
  deletedDate?: Date;
  sinceDate?: Date;
  beforeDate?: Date;
  keywords?: string;
}

/** A group's name and flags from `identity.group.changed.v1`. */
export interface GroupProjectionInput {
  groupId: string;
  siteId: string;
  groupName: string | null;
  isPublic: number | null;
  deleted: boolean;
}

/** One node verdict of a group from `identity.permission.changed.v1`. */
export interface PermissionProjectionInput {
  contentId: string;
  siteId: string;
  type: string;
}

/** A change set as changesetManager.save binds it: publish, remote publish and close dates to the minute. */
function changesetStorage(row: RepositoryRow): RepositoryRow {
  const stored = { ...row };
  for (const column of ['publishdate', 'remotepubdate', 'closedate']) {
    if (column in stored) {
      stored[column] = toMinute(stored[column]);
    }
  }
  return stored;
}

/** Builds the content repository: the platform repository of `OWNED_TABLES` and one helper namespace per content area. */
export function createContentRepository({ clock = systemClock, schema = SCHEMA }: ContentRepositoryOptions = {}) {
  const platform: Repository = createRepository({ owner: OWNER, schema, tables: OWNED_TABLES, clock });
  const name = (def: TableDef): string => qualified(schema, def.table);
  /** An id column as SQL Server's CI_AS `=` compares it; leakproof, unlike lower(), so its expression index applies under forced RLS. */
  const ciIdExpr = (column: string, collation: 'legacy_ci' | 'legacy_char_ci'): string =>
    `((${column}::bpchar) COLLATE ${qualified(schema, collation)})`;

  /** Rows of a raw SELECT over `defs`, read behind their units' window phase. */
  function select<R extends QueryResultRow>(tx: TenantTx, defs: readonly TableDef[], sql: string, values: readonly unknown[]): Promise<R[]> {
    return platform.read(tx, unitsOf(...defs), async () => (await tx.query<R>(sql, [...values])).rows);
  }

  /** One page of a built SELECT over `defs` in its order, with the count of all its rows, read behind their units' window phase. */
  function selectPage<R extends QueryResultRow>(tx: TenantTx, defs: readonly TableDef[], built: BuiltSelect, page: RowPage): Promise<PagedRows<R>> {
    return platform.read(tx, unitsOf(...defs), async () => {
      const count = `SELECT count(*)::integer AS total FROM (${built.select}) q`;
      const [{ total }] = (await tx.query<{ total: number }>(count, [...built.values])).rows as [{ total: number }];
      const offset = page.offset ?? 0;
      if (offset >= total) {
        return { rows: [], total };
      }
      const next = built.values.length;
      const sql = `${built.select} ${built.order} LIMIT $${next + 1} OFFSET $${next + 2}`;
      return { rows: (await tx.query<R>(sql, [...built.values, page.limit, offset])).rows, total };
    });
  }

  /** Every row of a built SELECT over `defs` in its order, `batchSize` rows per cursor FETCH, read behind their units' window phase. */
  async function* selectBatches<R extends QueryResultRow>(
    tx: TenantTx,
    defs: readonly TableDef[],
    built: BuiltSelect,
    batchSize: number = DEFAULT_ROW_BATCH_SIZE,
  ): AsyncGenerator<R[], void, undefined> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new ContentQueryError(`Invalid batch size ${batchSize}`);
    }
    batchCursorCount += 1;
    const cursor = `content_rows_${batchCursorCount}`;
    await platform.read(tx, unitsOf(...defs), () => tx.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${built.select} ${built.order}`, [...built.values]));
    // A failed FETCH aborts the transaction, so a CLOSE after it would only mask the error.
    let fetched = true;
    try {
      for (;;) {
        fetched = false;
        const { rows } = await tx.query<R>(`FETCH FORWARD ${batchSize} FROM ${cursor}`);
        fetched = true;
        if (rows.length > 0) {
          yield rows;
        }
        if (rows.length < batchSize) {
          return;
        }
      }
    } finally {
      if (fetched) {
        await tx.query(`CLOSE ${cursor}`);
      }
    }
  }

  /** The rows of `def` that `build` selects, locked FOR UPDATE in key order once the unit's write gate is held. */
  function lockRows<R extends QueryResultRow>(tx: TenantTx, def: TableDef, build: (p: SqlParams) => string, ctx: Ctx): Promise<R[]> {
    const p = new SqlParams(1);
    const predicate = build(p);
    const order = def.key === null ? 'legacy_row_hash, occurrence' : def.key.join(', ');
    const sql = `SELECT * FROM ${name(def)} WHERE tenant_id = $1 AND (${predicate}) ORDER BY ${order} FOR UPDATE`;
    const units = unitsOf(def);
    return platform.read(tx, [], async () => {
      if (ctx?.authority === undefined && units.length > 0) {
        await acquireWriteGates(tx, units);
      }
      return (await tx.query<R>(sql, [tx.tenantId, ...p.values])).rows;
    });
  }

  /** One platform update per row; a patch function returning null leaves its row unchanged. */
  async function updateEach<R extends QueryResultRow>(
    tx: TenantTx,
    def: TableDef,
    rows: readonly R[],
    patch: RepositoryRow | ((row: R) => RepositoryRow | null),
    ctx: Ctx,
  ): Promise<R[]> {
    const updated: R[] = [];
    for (const row of rows) {
      const change = typeof patch === 'function' ? patch(row) : patch;
      if (change === null) {
        continue;
      }
      const after = await platform.update<R>(tx, def.table, keyOf(def, row), change, ctx);
      if (after !== null) {
        updated.push(after);
      }
    }
    return updated;
  }

  /** One platform delete per row: by key, or by full content image for a keyless table. */
  async function deleteEach<R extends QueryResultRow>(tx: TenantTx, def: TableDef, rows: readonly R[], ctx: Ctx): Promise<R[]> {
    const removed: R[] = [];
    for (const row of rows) {
      const gone =
        def.key === null
          ? await platform.deleteOne<R>(tx, def.table, keylessContent(row), ctx)
          : await platform.delete<R>(tx, def.table, keyOf(def, row), ctx);
      if (gone !== null) {
        removed.push(gone);
      }
    }
    return removed;
  }

  /** The legacy `update <table> set … where …` as one changelogged update per affected row. */
  async function updateWhere<R extends QueryResultRow>(
    tx: TenantTx,
    def: TableDef,
    build: (p: SqlParams) => string,
    patch: RepositoryRow | ((row: R) => RepositoryRow | null),
    ctx: Ctx,
  ): Promise<R[]> {
    return updateEach(tx, def, await lockRows<R>(tx, def, build, ctx), patch, ctx);
  }

  /** The legacy `delete from <table> where …` as one changelogged delete per affected row. */
  async function deleteWhere<R extends QueryResultRow>(tx: TenantTx, def: TableDef, build: (p: SqlParams) => string, ctx: Ctx): Promise<R[]> {
    return deleteEach(tx, def, await lockRows<R>(tx, def, build, ctx), ctx);
  }

  /** Inserts each row in order and returns the stored rows. */
  async function insertEach<R>(tx: TenantTx, def: TableDef, rows: readonly RepositoryRow[], ctx: Ctx): Promise<R[]> {
    const stored: R[] = [];
    for (const row of rows) {
      stored.push(await platform.insert<R>(tx, def.table, row, ctx));
    }
    return stored;
  }

  // ---- shared deletes ----

  /** `rows` ordered by the first of `ids` that `idOf(row)` matches as `idIn` does, keeping lock order within each id. */
  function inIdOrder<R>(rows: readonly R[], ids: readonly string[], idOf: (row: R) => string | null): R[] {
    const trimEnd = (value: string): string => value.replace(/ +$/, '');
    const rank = new Map<string, number>();
    ids.forEach((id, index) => {
      for (const form of idForms([id]).map(trimEnd)) {
        if (!rank.has(form)) {
          rank.set(form, index);
        }
      }
    });
    return rows
      .map((row) => ({ row, rank: rank.get(trimEnd(idOf(row) ?? '')) ?? ids.length }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ row }) => row);
  }

  /** extendManager.deleteExtendedData for each of `baseIds` under one lock; returns their File attribute values in base order. */
  async function deleteExtendDataOf(tx: TenantTx, baseIds: readonly string[], ctx: Ctx): Promise<string[]> {
    if (baseIds.length === 0) {
      return [];
    }
    const locked = await lockRows<ExtendDataRow>(tx, EXTEND_DATA, (p) => idIn(p, 'baseid', baseIds), ctx);
    const rows = inIdOrder(locked, baseIds, (row) => row.baseid);
    const fileIds = await fileAttributeValues(tx, rows);
    await deleteEach(tx, EXTEND_DATA, rows, ctx);
    return fileIds;
  }

  /** extendManager.deleteExtendedData: removes the extend rows of `baseId` and returns its File attribute values. */
  function deleteExtendData(tx: TenantTx, baseId: string, ctx: Ctx): Promise<string[]> {
    return deleteExtendDataOf(tx, [baseId], ctx);
  }

  /** Values of the File-type attributes among `rows` (extendManager.cfc:1064-1077). */
  async function fileAttributeValues(tx: TenantTx, rows: readonly ExtendDataRow[]): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }
    const attributeIds = [...new Set(rows.map((row) => row.attributeid))];
    const fileAttributes = await select<{ attributeid: number }>(
      tx,
      [EXTEND_ATTRIBUTE],
      `SELECT attributeid FROM ${name(EXTEND_ATTRIBUTE)} WHERE tenant_id = $1 AND attributeid = ANY($2::integer[]) AND lower(type) = 'file'`,
      [tx.tenantId, attributeIds],
    );
    const isFile = new Set(fileAttributes.map((row) => row.attributeid));
    return distinctValues(
      rows.flatMap((row) => (isFile.has(row.attributeid) && row.attributevalue !== null && row.attributevalue !== '' ? [row.attributevalue] : [])),
    );
  }

  /** approvalRequest.delete for each request of versions `histIds`, in version order, under one lock. */
  async function deleteRequestsOfVersions(tx: TenantTx, histIds: readonly string[], ctx: Ctx): Promise<ApprovalRequestRow[]> {
    if (histIds.length === 0) {
      return [];
    }
    const requests = await lockRows<ApprovalRequestRow>(tx, APPROVAL_REQUEST, (p) => idIn(p, 'contenthistid', histIds), ctx);
    return deleteRequestRows(tx, inIdOrder(requests, histIds, (row) => row.contenthistid), ctx);
  }

  /** contentDAO.deleteVersionedObjects for each of versions `histIds`, in version order, under one lock. */
  async function deleteVersionedObjectsOf(tx: TenantTx, histIds: readonly string[], ctx: Ctx): Promise<FileMetadataRow[]> {
    if (histIds.length === 0) {
      return [];
    }
    const rows = await lockRows<FileMetadataRow>(tx, FILE_METADATA, (p) => idIn(p, 'contenthistid', histIds), ctx);
    return deleteEach(tx, FILE_METADATA, inIdOrder(rows, histIds, (row) => row.contenthistid), ctx);
  }

  /** contentDAO.deleteVersionedObjects: the versioned `file_metadata` rows of one version or of every version of an item. */
  function deleteVersionedObjects(tx: TenantTx, target: VersionedObjectsTarget, ctx?: WriteContext): Promise<FileMetadataRow[]> {
    if ('contentHistId' in target) {
      return deleteVersionedObjectsOf(tx, [target.contentHistId], ctx);
    }
    return deleteWhere<FileMetadataRow>(tx, FILE_METADATA, (p) => `${idEq(p, 'contentid', target.contentId)} AND siteid = ${p.add(target.siteId)}`, ctx);
  }

  /** The non-null `contenthistid` of each of `versions`, in order. */
  function histIdsOf(versions: readonly ContentRow[]): string[] {
    return versions.flatMap((version) => (version.contenthistid === null ? [] : [version.contenthistid]));
  }

  /** The child rows `contentDAO` removes with versions `histIds` of `siteId`. */
  async function deleteVersionChildren(
    tx: TenantTx,
    histIds: readonly string[],
    siteId: string,
    parts: { objects?: boolean; categories?: boolean; related?: boolean; tags?: boolean },
    ctx: Ctx,
  ): Promise<void> {
    if (histIds.length === 0) {
      return;
    }
    const scoped = (p: SqlParams): string => `siteid = ${p.add(siteId)} AND ${idIn(p, 'contenthistid', histIds)}`;
    if (parts.objects === true) {
      await deleteWhere(tx, CONTENT_OBJECT, scoped, ctx);
    }
    if (parts.categories === true) {
      await deleteWhere(tx, CATEGORY_ASSIGN, scoped, ctx);
    }
    if (parts.related === true) {
      await deleteWhere(tx, CONTENT_RELATED, scoped, ctx);
    }
    if (parts.tags === true) {
      await deleteWhere(tx, CONTENT_TAG, scoped, ctx);
    }
  }

  /** contentDAO.deleteOldSourceMaps: the source maps older than every version of the item, or of an item the site no longer holds. */
  async function deleteOldSourceMaps(tx: TenantTx, args: { contentId: string; siteId: string }, ctx?: WriteContext): Promise<SourceMapRow[]> {
    return deleteWhere<SourceMapRow>(
      tx,
      SOURCE_MAP,
      (p) => {
        const site = p.add(args.siteId);
        const item = idEq(p, 'contentid', args.contentId);
        const versions = idEq(p, 'v.contentid', args.contentId);
        return (
          `${item} AND siteid = ${site} AND (created < (SELECT min(v.lastupdate) FROM ${name(CONTENT)} v` +
          ` WHERE v.tenant_id = $1 AND ${versions} AND v.siteid = ${site})` +
          ` OR contentid NOT IN (SELECT DISTINCT c.contentid FROM ${name(CONTENT)} c WHERE c.tenant_id = $1 AND c.siteid = ${site} AND c.contentid IS NOT NULL))`
        );
      },
      ctx,
    );
  }

  /** contentDAO.deleteContentAssignments: an `expire` set by version, any other by item and site. */
  function deleteContentAssignments(tx: TenantTx, args: { id: string; siteId: string; type: string }, ctx?: WriteContext): Promise<ContentAssignmentRow[]> {
    return deleteWhere<ContentAssignmentRow>(
      tx,
      CONTENT_ASSIGNMENT,
      (p) =>
        cfEq(args.type, 'expire')
          ? `${idEq(p, 'contenthistid', args.id)} AND ${ciEq(p, 'type', args.type)}`
          : `${idEq(p, 'contentid', args.id)} AND siteid = ${p.add(args.siteId)} AND ${ciEq(p, 'type', args.type)}`,
      ctx,
    );
  }

  /** The predicate of a `VersionFilter`; throws for a filter naming no column. */
  function versionPredicate(p: SqlParams, filter: VersionFilter): string {
    const parts: string[] = [];
    if (filter.siteId !== undefined) parts.push(`siteid = ${p.add(filter.siteId)}`);
    if (filter.contentId !== undefined) parts.push(idEq(p, 'contentid', filter.contentId));
    if (filter.contentIds !== undefined) parts.push(idIn(p, 'contentid', filter.contentIds));
    if (filter.contentHistIds !== undefined) parts.push(idIn(p, 'contenthistid', filter.contentHistIds));
    if (filter.parentId !== undefined) parts.push(idEq(p, 'parentid', filter.parentId));
    if (filter.remoteId !== undefined) parts.push(ciEq(p, 'remoteid', filter.remoteId));
    if (filter.changesetId !== undefined) parts.push(idEq(p, 'changesetid', filter.changesetId));
    if (filter.active !== undefined) parts.push(`active = ${p.add(filter.active)}`);
    if (filter.approved !== undefined) parts.push(`approved = ${p.add(filter.approved)}`);
    if (filter.types !== undefined) parts.push(ciIn(p, 'type', filter.types));
    if (filter.orderNoAbove !== undefined) parts.push(`orderno > ${p.add(filter.orderNoAbove)}`);
    if (filter.filename !== undefined) parts.push(ciEq(p, 'filename', filter.filename));
    if (filter.filenameLike !== undefined) parts.push(ciLike(p, 'filename', filter.filenameLike));
    if (filter.pathLike !== undefined) parts.push(ciLike(p, 'path', filter.pathLike));
    if (filter.bodyLike !== undefined) parts.push(ciLike(p, 'body', filter.bodyLike));
    if (filter.summaryLike !== undefined) parts.push(ciLike(p, 'summary', filter.summaryLike));
    if (parts.length === 0) {
      throw new RepositoryError('version filter names no column', CONTENT.table);
    }
    return parts.join(' AND ');
  }

  /** The versions of `filter`, locked for a multi-row update. */
  function lockVersions(tx: TenantTx, filter: VersionFilter, ctx: Ctx): Promise<ContentRow[]> {
    return lockRows<ContentRow>(tx, CONTENT, (p) => versionPredicate(p, filter), ctx);
  }

  /** One changelogged update per version `filter` selects. */
  async function updateVersions(tx: TenantTx, filter: VersionFilter, patch: PatchOf<ContentRow, 'tcontent_id'>, ctx?: WriteContext): Promise<ContentRow[]> {
    return updateEach(tx, CONTENT, await lockVersions(tx, filter, ctx), patch as RepositoryRow | ((row: ContentRow) => RepositoryRow | null), ctx);
  }

  /** Removes `versions` of `siteId` with their child rows, extend data, versioned objects and, when asked, approval requests (contentDAO.deleteHistAll). */
  async function purgeVersions(
    tx: TenantTx,
    versions: readonly ContentRow[],
    siteId: string,
    opts: { requests: boolean },
    ctx: Ctx,
  ): Promise<VersionDeletion> {
    if (versions.length === 0) {
      return { versions: [], extendFileIds: [] };
    }
    const histIds = histIdsOf(versions);
    await deleteVersionChildren(tx, histIds, siteId, { objects: true }, ctx);
    const extendFileIds = await deleteExtendDataOf(tx, histIds, ctx);
    if (opts.requests) {
      await deleteRequestsOfVersions(tx, histIds, ctx);
    }
    await deleteVersionedObjectsOf(tx, histIds, ctx);
    await deleteVersionChildren(tx, histIds, siteId, { categories: true, related: true, tags: true }, ctx);
    const removed = await deleteEach(tx, CONTENT, versions, ctx);
    return { versions: removed, extendFileIds };
  }

  /** The inactive versions of an item that are neither pending approval nor, unless `approvedToo`, approved. */
  function historyVersions(tx: TenantTx, args: { contentId: string; siteId: string }, approvedToo: boolean, ctx: Ctx): Promise<ContentRow[]> {
    return lockRows<ContentRow>(
      tx,
      CONTENT,
      (p) => {
        const kept = approvedToo ? '((approved = 0 AND changesetid IS NULL) OR (approved = 1 AND active = 0))' : 'approved = 0 AND changesetid IS NULL';
        // The legacy left join keeps a version with no request, or with any request whose status is not Pending.
        const requests = `FROM ${name(APPROVAL_REQUEST)} r WHERE r.tenant_id = $1 AND r.contenthistid = ${name(CONTENT)}.contenthistid`;
        return (
          `siteid = ${p.add(args.siteId)} AND ${idEq(p, 'contentid', args.contentId)} AND active = 0 AND ${kept}` +
          ` AND (NOT EXISTS (SELECT 1 ${requests}) OR EXISTS (SELECT 1 ${requests} AND (lower(rtrim(r.status)) <> 'pending' OR r.status IS NULL)))`
        );
      },
      ctx,
    );
  }

  const content = {
    ...contentQueries,

    /** contentDAO.create: inserts a version as legacy stores it and returns it with its identity `tcontent_id`. */
    async insertVersion(tx: TenantTx, row: VersionInput, ctx?: WriteContext): Promise<ContentRow> {
      const stored = versionStorage({ ...row, contentid: row.contentid ?? cfUuid(), contenthistid: row.contenthistid ?? cfUuid() }, clock.now());
      return platform.insert<ContentRow>(tx, CONTENT.table, stored, ctx);
    },

    /** Sets `changes` on version `contentHistId`; null when no version has it. */
    async updateVersion(tx: TenantTx, contentHistId: string, changes: ContentPatch, ctx?: WriteContext): Promise<ContentRow | null> {
      const updated = await updateVersions(tx, { contentHistIds: [contentHistId] }, changes, ctx);
      return updated[0] ?? null;
    },

    updateVersions,

    /** contentDAO.archiveActive: sets `active = 0` on the active versions of an item. */
    archiveActive(tx: TenantTx, args: { contentId: string; siteId: string }, ctx?: WriteContext): Promise<ContentRow[]> {
      return updateVersions(tx, { contentId: args.contentId, active: 1, siteId: args.siteId }, { active: 0 }, ctx);
    },

    /** Makes version `contentHistId` the active one. */
    async setActive(tx: TenantTx, args: { contentHistId: string }, ctx?: WriteContext): Promise<ContentRow | null> {
      return (await updateVersions(tx, { contentHistIds: [args.contentHistId] }, { active: 1 }, ctx))[0] ?? null;
    },

    /** Sets the approval flag of version `contentHistId`, with any other columns the approval step changes. */
    async setApproval(
      tx: TenantTx,
      args: { contentHistId: string; approved: number; changes?: ContentPatch },
      ctx?: WriteContext,
    ): Promise<ContentRow | null> {
      return (await updateVersions(tx, { contentHistIds: [args.contentHistId] }, { ...args.changes, approved: args.approved }, ctx))[0] ?? null;
    },

    /** contentManager.save: detaches every version of an item from change set `changesetId` (contentManager.cfc:1306-1330). */
    clearChangeset(tx: TenantTx, args: { contentId: string; changesetId: string; siteId: string }, ctx?: WriteContext): Promise<ContentRow[]> {
      return updateVersions(tx, { contentId: args.contentId, changesetId: args.changesetId, siteId: args.siteId }, { changesetid: null }, ctx);
    },

    /** contentManager.save: shifts the active siblings under `parentId` by `delta`, optionally only those after `orderNoAbove`. */
    shiftSiblingOrder(
      tx: TenantTx,
      args: { parentId: string; siteId: string; delta: number; orderNoAbove?: number },
      ctx?: WriteContext,
    ): Promise<ContentRow[]> {
      const filter: VersionFilter = { parentId: args.parentId, siteId: args.siteId, types: SIBLING_ORDER_TYPES, active: 1 };
      if (args.orderNoAbove !== undefined) {
        filter.orderNoAbove = args.orderNoAbove;
      }
      return updateVersions(tx, filter, (row) => ({ orderno: row.orderno === null ? null : row.orderno + args.delta }), ctx);
    },

    /** contentManager.save `rsOrder`: the highest order number among the active siblings under `parentId`, or null. */
    async maxSiblingOrderNo(tx: TenantTx, args: { parentId: string; siteId: string }): Promise<number | null> {
      const p = new SqlParams(1);
      const rows = await select<{ thebottom: number | null }>(
        tx,
        [CONTENT],
        `SELECT max(orderno) AS thebottom FROM ${name(CONTENT)} WHERE tenant_id = $1 AND ${idEq(p, 'parentid', args.parentId)}` +
          ` AND siteid = ${p.add(args.siteId)} AND ${ciIn(p, 'type', SIBLING_ORDER_TYPES)} AND active = 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0]?.thebottom ?? null;
    },

    /** contentManager.deleteAll `rs`: the content ids of the active versions under `parentId`, in the clustered scan order. */
    async activeChildIds(tx: TenantTx, args: { parentId: string }): Promise<string[]> {
      const p = new SqlParams(1);
      const rows = await select<{ contentid: string | null }>(
        tx,
        [CONTENT],
        `SELECT contentid FROM ${name(CONTENT)} WHERE tenant_id = $1 AND ${idEq(p, 'parentid', args.parentId)} AND active = 1 ORDER BY tcontent_id`,
        [tx.tenantId, ...p.values],
      );
      return rows.map((row) => row.contentid ?? '');
    },

    /** contentDAO.createRelatedItems `rsCheck`: the active Link versions under `parentId` whose body is like `bodyLike`. */
    activeLinksByBody(tx: TenantTx, args: { parentId: string; siteId: string; bodyLike: string }): Promise<Array<{ contenthistid: string; siteid: string | null }>> {
      const p = new SqlParams(1);
      return select<{ contenthistid: string; siteid: string | null }>(
        tx,
        [CONTENT],
        `SELECT contenthistid, siteid FROM ${name(CONTENT)} WHERE tenant_id = $1 AND ${idEq(p, 'parentid', args.parentId)}` +
          ` AND siteid = ${p.add(args.siteId)} AND active = 1 AND ${ciEq(p, 'type', 'Link')} AND ${ciLike(p, 'body', args.bodyLike)}` +
          ' ORDER BY tcontent_id',
        [tx.tenantId, ...p.values],
      );
    },

    /** contentManager.save: moves the inactive versions of a moved item under its new parent. */
    reparentInactive(tx: TenantTx, args: { contentId: string; siteId: string; parentId: string }, ctx?: WriteContext): Promise<ContentRow[]> {
      return updateVersions(tx, { contentId: args.contentId, active: 0, siteId: args.siteId }, { parentid: args.parentId }, ctx);
    },

    /** contentManager.updateMaterializedPath: `path = replace(ltrim(rtrim(cast(path AS char(2000)))), current, new)` under `path like current%`. */
    replacePathPrefix(tx: TenantTx, args: { siteId: string; currentPath: string; newPath: string }, ctx?: WriteContext): Promise<ContentRow[]> {
      return updateVersions(tx, { pathLike: `${args.currentPath}%`, siteId: args.siteId }, (row) => {
        const trimmed = (row.path ?? '').slice(0, 2000).replace(/^ +| +$/g, '');
        return { path: replaceAllNoCase(trimmed, args.currentPath, args.newPath) };
      }, ctx);
    },

    /** contentDAO.delete: reparents the children, then removes every version of the item and its child rows (none for the home page). */
    async deleteContent(tx: TenantTx, args: ContentDeletionArgs, ctx?: WriteContext): Promise<VersionDeletion> {
      // contentDAO.delete never removes a site's home node.
      if (args.contentId === LEGACY_ADMIN_SENTINEL_ID) {
        return { versions: [], extendFileIds: [] };
      }
      await updateVersions(tx, { siteId: args.siteId, parentId: args.contentId }, { parentid: args.parentId }, ctx);
      const versions = await lockVersions(tx, { siteId: args.siteId, contentId: args.contentId }, ctx);
      const histIds = histIdsOf(versions);
      const extendFileIds = await deleteExtendDataOf(tx, histIds, ctx);
      await deleteRequestsOfVersions(tx, histIds, ctx);
      // Active versions keep their versioned objects so a trash restore finds them.
      await deleteVersionedObjectsOf(tx, histIdsOf(versions.filter((version) => version.active !== 1)), ctx);
      const removed = await deleteEach(tx, CONTENT, versions, ctx);
      const item = (p: SqlParams): string => `${idEq(p, 'contentid', args.contentId)} AND siteid = ${p.add(args.siteId)}`;
      await deleteWhere(tx, CONTENT_ASSIGNMENT, item, ctx);
      if (!cfEq(args.type ?? '', 'Form') && !cfEq(args.type ?? '', 'Component')) {
        await deleteWhere(tx, REMOTE_POINTER, item, ctx);
        await deleteWhere(tx, CONTENT_OBJECT, item, ctx);
        await deleteWhere(tx, CONTENT_TAG, item, ctx);
        await deleteWhere(tx, CATEGORY_ASSIGN, item, ctx);
        await deleteWhere(
          tx,
          CONTENT_RELATED,
          (p) => `(${idEq(p, 'contentid', args.contentId)} OR ${idEq(p, 'relatedid', args.contentId)}) AND siteid = ${p.add(args.siteId)}`,
          ctx,
        );
      } else {
        await deleteWhere(tx, CONTENT_OBJECT, (p) => `${idEq(p, 'objectid', args.contentId)} AND siteid = ${p.add(args.siteId)}`, ctx);
      }
      return { versions: removed, extendFileIds };
    },

    /** contentDAO.deleteHistAll: removes the archived and unassigned draft versions not pending approval, then old source maps. */
    async deleteHistAll(tx: TenantTx, args: { contentId: string; siteId: string }, ctx?: WriteContext): Promise<VersionDeletion> {
      const versions = await historyVersions(tx, args, true, ctx);
      const result = await purgeVersions(tx, versions, args.siteId, { requests: true }, ctx);
      await deleteOldSourceMaps(tx, args, ctx);
      return result;
    },

    /** contentDAO.deleteDraftHistAll: removes the unassigned draft versions not pending approval, then old source maps. */
    async deleteDraftHistAll(tx: TenantTx, args: { contentId: string; siteId: string }, ctx?: WriteContext): Promise<VersionDeletion> {
      const versions = await historyVersions(tx, args, false, ctx);
      const result = await purgeVersions(tx, versions, args.siteId, { requests: false }, ctx);
      await deleteOldSourceMaps(tx, args, ctx);
      return result;
    },

    /** contentManager.deleteVersion: one version with its extend data, tags, objects, category assignments, expiry assignments and versioned objects. */
    async deleteVersion(tx: TenantTx, args: { contentHistId: string; siteId: string }, ctx?: WriteContext): Promise<VersionDeletion> {
      const extendFileIds = await deleteExtendData(tx, args.contentHistId, ctx);
      const versions = await lockVersions(tx, { contentHistIds: [args.contentHistId], siteId: args.siteId }, ctx);
      const removed = await deleteEach(tx, CONTENT, versions, ctx);
      await deleteVersionChildren(tx, [args.contentHistId], args.siteId, { tags: true, objects: true, categories: true }, ctx);
      await deleteWhere(tx, CONTENT_ASSIGNMENT, (p) => `${idEq(p, 'contenthistid', args.contentHistId)} AND lower(rtrim(type)) = 'expire'`, ctx);
      await deleteVersionedObjects(tx, { contentHistId: args.contentHistId }, ctx);
      return { versions: removed, extendFileIds };
    },

    /** contentDAO.deleteObjectsHist then createObjects: replaces the display objects of a version. */
    async replaceObjects(tx: TenantTx, contentHistId: string, rows: readonly ContentObjectInput[], ctx?: WriteContext): Promise<ContentObjectRow[]> {
      await deleteWhere(tx, CONTENT_OBJECT, (p) => idEq(p, 'contenthistid', contentHistId), ctx);
      return insertEach<ContentObjectRow>(tx, CONTENT_OBJECT, rows.map((row) => ({ ...row, contenthistid: contentHistId })), ctx);
    },

    /** contentDAO.updateContentObjectParams: sets the params of the objects at one region position of a version. */
    updateObjectParams(
      tx: TenantTx,
      args: { contentHistId: string; columnId: number; orderNo: number; params: string | null },
      ctx?: WriteContext,
    ): Promise<ContentObjectRow[]> {
      return updateWhere<ContentObjectRow>(
        tx,
        CONTENT_OBJECT,
        (p) => `${idEq(p, 'contenthistid', args.contentHistId)} AND columnid = ${p.add(args.columnId)} AND orderno = ${p.add(args.orderNo)}`,
        { params: args.params },
        ctx,
      );
    },

    /** contentDAO.deleteTagHist then createTags: replaces the tags of a version. */
    async replaceTags(tx: TenantTx, contentHistId: string, rows: readonly ContentTagInput[], ctx?: WriteContext): Promise<ContentTagRow[]> {
      await deleteWhere(tx, CONTENT_TAG, (p) => idEq(p, 'contenthistid', contentHistId), ctx);
      return insertEach<ContentTagRow>(tx, CONTENT_TAG, rows.map((row) => ({ ...row, contenthistid: contentHistId })), ctx);
    },

    /** contentDAO.deleteRelatedItems then createRelatedItems: replaces the related content of a version. */
    async replaceRelatedItems(
      tx: TenantTx,
      contentHistId: string,
      siteId: string,
      rows: readonly RelatedItemInput[],
      ctx?: WriteContext,
    ): Promise<ContentRelatedRow[]> {
      await deleteWhere(tx, CONTENT_RELATED, (p) => idEq(p, 'contenthistid', contentHistId), ctx);
      return insertEach<ContentRelatedRow>(
        tx,
        CONTENT_RELATED,
        rows.map((row) => ({ ...row, contenthistid: contentHistId, siteid: siteId })),
        ctx,
      );
    },

    /** contentDAO.deleteCategoryHist then the category saves: replaces the category assignments of a version. */
    async replaceCategoryAssignments(
      tx: TenantTx,
      contentHistId: string,
      rows: readonly CategoryAssignmentInput[],
      ctx?: WriteContext,
    ): Promise<CategoryAssignRow[]> {
      await deleteWhere(tx, CATEGORY_ASSIGN, (p) => idEq(p, 'contenthistid', contentHistId), ctx);
      return insertEach<CategoryAssignRow>(tx, CATEGORY_ASSIGN, rows.map((row) => assignmentStorage({ ...row, contenthistid: contentHistId })), ctx);
    },

    deleteContentAssignments,

    /** contentDAO.createContentAssignment. */
    insertContentAssignment(tx: TenantTx, row: ContentAssignmentInput, ctx?: WriteContext): Promise<ContentAssignmentRow> {
      return platform.insert<ContentAssignmentRow>(tx, CONTENT_ASSIGNMENT.table, row, ctx);
    },

    /** Replaces the `type` assignments of a version with one row per user. */
    async replaceContentAssignments(
      tx: TenantTx,
      args: { contentId: string; contentHistId: string; siteId: string; type: string; userIds: readonly string[] },
      ctx?: WriteContext,
    ): Promise<ContentAssignmentRow[]> {
      await deleteContentAssignments(tx, { id: cfEq(args.type, 'expire') ? args.contentHistId : args.contentId, siteId: args.siteId, type: args.type }, ctx);
      return insertEach<ContentAssignmentRow>(
        tx,
        CONTENT_ASSIGNMENT,
        distinctValues(args.userIds).map((userid) => ({
          contentid: args.contentId,
          contenthistid: args.contentHistId,
          siteid: args.siteId,
          userid,
          type: args.type,
        })),
        ctx,
      );
    },

    deleteOldSourceMaps,

    /** Records the source version a version was created from (contentSourceMapBean.save). */
    insertSourceMap(tx: TenantTx, row: Omit<Fields<SourceMapRow>, 'mapid'> & { mapid?: string }, ctx?: WriteContext): Promise<SourceMapRow> {
      return platform.insert<SourceMapRow>(tx, SOURCE_MAP.table, { ...row, mapid: row.mapid ?? cfUuid(), created: row.created ?? clock.now() }, ctx);
    },

    /** Records a filename an item used to have (contentFilenameArchiveBean.save). */
    insertFilenameArchive(
      tx: TenantTx,
      row: Omit<Fields<FilenameArchiveRow>, 'archiveid'> & { archiveid?: string },
      ctx?: WriteContext,
    ): Promise<FilenameArchiveRow> {
      return platform.insert<FilenameArchiveRow>(tx, FILENAME_ARCHIVE.table, { ...row, archiveid: row.archiveid ?? cfUuid() }, ctx);
    },

    /** contentFilenameArchiveBean.loadBy(filename, siteid) then save: the first stored row of the filename takes `contentId`, else one is inserted. */
    async saveFilenameArchive(
      tx: TenantTx,
      args: { filename: string; siteId: string; contentId: string },
      ctx?: WriteContext,
    ): Promise<FilenameArchiveRow> {
      const [stored] = await lockRows<FilenameArchiveRow>(
        tx,
        FILENAME_ARCHIVE,
        (p) => `${ciEq(p, 'filename', args.filename)} AND siteid = ${p.add(args.siteId)}`,
        ctx,
      );
      if (stored !== undefined) {
        const updated = await platform.update<FilenameArchiveRow>(tx, FILENAME_ARCHIVE.table, { archiveid: stored.archiveid }, { contentid: args.contentId }, ctx);
        if (updated !== null) return updated;
      }
      return platform.insert<FilenameArchiveRow>(
        tx,
        FILENAME_ARCHIVE.table,
        { archiveid: cfUuid(), filename: args.filename, siteid: args.siteId, contentid: args.contentId },
        ctx,
      );
    },

    /** Saves the remote pointer of an item (contentRemotePointerBean.save). */
    upsertRemotePointer(
      tx: TenantTx,
      row: Omit<Fields<RemotePointerRow>, 'pointerid'> & { pointerid?: string },
      ctx?: WriteContext,
    ): Promise<RemotePointerRow> {
      return platform.upsert<RemotePointerRow>(tx, REMOTE_POINTER.table, { ...row, pointerid: row.pointerid ?? cfUuid() }, ctx);
    },

    /** contentDAO.persistVersionedObjects: copies the metadata rows of `fromHistId` to `toHistId` under new ids. */
    async persistVersionedObjects(
      tx: TenantTx,
      fromHistId: string,
      toHistId: string,
      opts: PersistVersionedOptions = {},
      ctx?: WriteContext,
    ): Promise<FileMetadataRow[]> {
      const p = new SqlParams(1);
      const rows = await select<FileMetadataRow>(
        tx,
        [FILE_METADATA],
        `SELECT * FROM ${name(FILE_METADATA)} WHERE tenant_id = $1 AND ${idEq(p, 'contenthistid', fromHistId)} ORDER BY metaid`,
        [tx.tenantId, ...p.values],
      );
      const excluded = new Set((opts.excludeMetaIds ?? []).map((id) => id.toLowerCase()));
      const kept = opts.fileIds === undefined ? undefined : new Set(opts.fileIds.map((id) => id.toLowerCase()));
      const copies = rows
        .filter((row) => !excluded.has(row.metaid.toLowerCase()))
        .filter((row) => kept === undefined || (row.fileid !== null && kept.has(row.fileid.toLowerCase())))
        .map(({ tenant_id: _tenant, ...row }) => ({ ...row, contenthistid: toHistId, metaid: cfUuid() }));
      return insertEach<FileMetadataRow>(tx, FILE_METADATA, copies, ctx);
    },

    deleteVersionedObjects,
  };


  // ---- stats ----

  /** Serialises the stats writers of one item, whether or not its row exists, until `tx` ends; the unit's write gate is taken first. */
  function lockStatsItem(tx: TenantTx, args: StatsKey, ctx: Ctx): Promise<void> {
    const item = [args.contentId, args.siteId].map((id) => id.toLowerCase().replace(/ +$/u, '')).join(':');
    const units = unitsOf(CONTENT_STATS);
    return platform.read(tx, [], async () => {
      if (ctx?.authority === undefined && units.length > 0) {
        await acquireWriteGates(tx, units);
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${schema}.${CONTENT_STATS.table}:${tx.tenantId}:${item}`]);
    });
  }

  /** contentStatsBean.load then save: applies `changes` to the item's stats row, or inserts it from the bean defaults. */
  async function upsertStats(tx: TenantTx, args: StatsKey & StatsChanges, ctx?: WriteContext): Promise<ContentStatsRow> {
    const { contentId, siteId, ...changes } = args;
    await lockStatsItem(tx, { contentId, siteId }, ctx);
    const [current] = await lockRows<ContentStatsRow>(
      tx,
      CONTENT_STATS,
      (p) => `${idEq(p, 'contentid', contentId)} AND siteid = ${p.add(siteId)}`,
      ctx,
    );
    const values: RepositoryRow = {};
    for (const column of STATS_COUNT_COLUMNS) {
      const changed = changes[column];
      const stored = current?.[column];
      values[column] = typeof changed === 'number' && Number.isFinite(changed) ? changed : typeof stored === 'number' ? stored : 0;
    }
    values.lockid = nullIfEmpty(changes.lockid !== undefined ? (changes.lockid ?? '') : (current?.lockid ?? ''));
    values.locktype = nullIfEmpty(changes.locktype !== undefined ? (changes.locktype ?? '') : (current?.locktype ?? ''));
    if (current !== undefined) {
      return (await platform.update<ContentStatsRow>(tx, CONTENT_STATS.table, keyOf(CONTENT_STATS, current), values, ctx)) as ContentStatsRow;
    }
    return platform.insert<ContentStatsRow>(tx, CONTENT_STATS.table, { contentid: contentId, siteid: siteId, ...values }, ctx);
  }

  const stats = {
    upsertStats,

    /** contentManager lock: records the user and type holding the item's lock. */
    setLock(tx: TenantTx, args: StatsKey & { lockId: string; lockType: string }, ctx?: WriteContext): Promise<ContentStatsRow> {
      return upsertStats(tx, { contentId: args.contentId, siteId: args.siteId, lockid: args.lockId, locktype: args.lockType }, ctx);
    },

    /** contentManager unlock: clears the item's lock. */
    clearLock(tx: TenantTx, args: StatsKey, ctx?: WriteContext): Promise<ContentStatsRow> {
      return upsertStats(tx, { contentId: args.contentId, siteId: args.siteId, lockid: '', locktype: '' }, ctx);
    },

    /** contentManager.setCommentStat: stores the count of approved comments that are neither spam nor deleted, counted under the item lock held until commit. */
    async setCommentCount(tx: TenantTx, args: StatsKey, ctx?: WriteContext): Promise<ContentStatsRow> {
      await lockStatsItem(tx, args, ctx);
      const comments = await contentQueries.commentCount(tx, { siteId: args.siteId, contentId: args.contentId });
      return upsertStats(tx, { contentId: args.contentId, siteId: args.siteId, comments }, ctx);
    },

    /** Stores the item's major and minor version numbers. */
    setVersionNumbers(tx: TenantTx, args: StatsKey & { majorVersion: number; minorVersion: number }, ctx?: WriteContext): Promise<ContentStatsRow> {
      return upsertStats(
        tx,
        { contentId: args.contentId, siteId: args.siteId, majorversion: args.majorVersion, minorversion: args.minorVersion },
        ctx,
      );
    },

    /** contentStatsBean.getQuery. */
    readStats: contentQueries.stats,

    /** A beanFeed over `tcontentstats`: the site's rows, only those of `contentIds` when given, in clustered key order. */
    siteStats(tx: TenantTx, args: { siteId: string; contentIds?: readonly string[] }): Promise<Omit<ContentStatsRow, 'tenant_id'>[]> {
      const p = new SqlParams(1);
      const filters = ['tenant_id = $1', `siteid = ${p.add(args.siteId)}`];
      if (args.contentIds !== undefined) {
        filters.push(idIn(p, 'contentid', args.contentIds));
      }
      return select<Omit<ContentStatsRow, 'tenant_id'>>(
        tx,
        [CONTENT_STATS],
        `SELECT ${STATS_FEED_COLUMNS} FROM ${name(CONTENT_STATS)} WHERE ${filters.join(' AND ')} ORDER BY contentid, siteid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** raterManager.readRate: one user's rating of an item, or null. */
    async readRate(tx: TenantTx, args: StatsKey & { userId: string }): Promise<ContentRatingRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ContentRatingRow>(
        tx,
        [CONTENT_RATING],
        `SELECT * FROM ${name(CONTENT_RATING)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)}` +
          ` AND ${ciEq(p, 'userid', args.userId)} AND siteid = ${p.add(args.siteId)}`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** raterManager.getAvgRating: SQL Server's integer `avg(rate)` with the vote counts; null for an unrated item. */
    async avgRating(tx: TenantTx, args: StatsKey): Promise<AvgRatingRow | null> {
      const p = new SqlParams(1);
      const site = p.add(args.siteId);
      const item = idEq(p, 'r.contentid', args.contentId);
      const downItem = idEq(p, 'd.contentid', args.contentId);
      const rows = await select<AvgRatingRow>(
        tx,
        [CONTENT_RATING],
        'SELECT trunc(avg(r.rate))::integer AS theavg, count(r.contentid)::integer AS thecount,' +
          ' (count(r.contentid) - q.downvotes)::integer AS upvotes, q.downvotes' +
          ` FROM ${name(CONTENT_RATING)} r LEFT JOIN (SELECT count(d.rate)::integer AS downvotes, d.contentid, d.siteid` +
          ` FROM ${name(CONTENT_RATING)} d WHERE d.tenant_id = $1 AND d.siteid = ${site} AND ${downItem} AND d.rate = 1` +
          ' GROUP BY d.contentid, d.siteid) q ON (r.contentid = q.contentid AND r.siteid = q.siteid)' +
          ` WHERE r.tenant_id = $1 AND r.siteid = ${site} AND ${item} GROUP BY q.downvotes`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** raterManager.getTopRated: active rated content by integer average then vote count. */
    topRated(tx: TenantTx, args: TopRatedArgs): Promise<TopRatedRow[]> {
      const p = new SqlParams(1);
      const filters = [`c.tenant_id = $1`, `c.siteid = ${p.add(args.siteId)}`, 'c.active = 1', ciIn(p, 'c.type', TOP_RATED_TYPES)];
      if (args.startDate !== undefined) {
        filters.push(`r.entered >= ${p.add(atTimeOfDay(args.startDate, 0, 0, 0))}`);
      }
      if (args.stopDate !== undefined) {
        filters.push(`r.entered <= ${p.add(atTimeOfDay(args.stopDate, 23, 59, 0))}`);
      }
      const grouped = TOP_RATED_COLUMNS.map((column) => `c.${column}`).join(', ');
      const having = (args.threshold ?? 0) > 1 ? ` HAVING count(r.contentid) >= ${p.add(args.threshold)}` : '';
      const limit = (args.limit ?? 0) > 0 ? ` LIMIT ${p.add(args.limit)}` : '';
      return select<TopRatedRow>(
        tx,
        [CONTENT, CONTENT_RATING],
        `SELECT ${grouped}, trunc(avg(r.rate))::integer AS theavg, count(r.contentid)::integer AS thecount` +
          ` FROM ${name(CONTENT)} c INNER JOIN ${name(CONTENT_RATING)} r ON c.tenant_id = r.tenant_id AND c.contentid = r.contentid AND c.siteid = r.siteid` +
          ` WHERE ${filters.join(' AND ')} GROUP BY ${grouped}${having}` +
          ` ORDER BY ${orderKey('trunc(avg(r.rate))', 'desc')}, count(r.contentid) DESC${limit}`,
        [tx.tenantId, ...p.values],
      );
    },
  };

  // ---- files ----

  /** fileDAO.deleteVersion and restoreVersion: sets the deleted flag of one file. */
  function setFileDeleted(tx: TenantTx, args: { fileId: string; deleted: number }, ctx?: WriteContext): Promise<FileRow[]> {
    return updateWhere<FileRow>(tx, FILE, (p) => idEq(p, 'fileid', args.fileId), { deleted: args.deleted }, ctx);
  }

  /**
   * fileDAO.deleteIfNotUsed in this tenant: marks the files deleted unless content, extend data or `referencedElsewhere`
   * (user extend data and site placeholders, held by other owners) still reference any of them.
   */
  async function deleteIfNotUsed(
    tx: TenantTx,
    args: { fileIds: readonly string[]; baseIds: readonly string[]; referencedElsewhere?: readonly string[] },
    ctx?: WriteContext,
  ): Promise<string[]> {
    if (args.fileIds.length === 0) {
      return [];
    }
    const referenced = await fileQueries.fileIdsReferencedInContent(tx, args.fileIds, args.baseIds);
    if (referenced.length > 0 || (args.referencedElsewhere?.length ?? 0) > 0) {
      return [];
    }
    // fileDAO.deleteVersion binds the whole list as one value, so only a one-element list matches a file.
    const [only] = args.fileIds;
    if (args.fileIds.length !== 1 || only === undefined) {
      return [];
    }
    return (await setFileDeleted(tx, { fileId: only, deleted: 1 }, ctx)).map((row) => row.fileid);
  }

  /** The (version, file) pairs of an item's versions that carry a file (fileDAO.deleteAll's select). */
  function listVersionFiles(tx: TenantTx, args: { contentId: string }): Promise<{ contenthistid: string; fileid: string }[]> {
    const p = new SqlParams(1);
    return select(
      tx,
      [CONTENT],
      `SELECT contenthistid, fileid FROM ${name(CONTENT)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)}` +
        ' AND fileid IS NOT NULL ORDER BY tcontent_id',
      [tx.tenantId, ...p.values],
    );
  }
  const versionFiles = listVersionFiles;

  /** Takes the `content.file` write gate for a unit-less `file_object` write; a migration apply passes any gate state. */
  function gateFileObjectWrite(tx: TenantTx, ctx: Ctx): Promise<void> {
    return platform.read(tx, [], async () => {
      if (!isMigrationAuthority(ctx?.authority)) {
        await acquireWriteGates(tx, unitsOf(FILE));
      }
    });
  }

  const files = {
    ...fileQueries,

    /** fileDAO.create for a non-image upload: the file row under a new CF UUID, with the file bean defaults. */
    insertFile(tx: TenantTx, row: FileInput, ctx?: WriteContext): Promise<FileRow> {
      return platform.insert<FileRow>(
        tx,
        FILE.table,
        ormStorage({
          ...row,
          fileid: row.fileid ?? cfUuid(),
          moduleid: row.moduleid ?? contentQueries.SITE_TREE_MODULE_ID,
          filesize: row.filesize ?? 0,
          fileext: typeof row.fileext === 'string' ? row.fileext.toLowerCase() : row.fileext,
          created: row.created ?? clock.now(),
          deleted: row.deleted ?? 0,
          image: null,
          imagesmall: null,
          imagemedium: null,
        }),
        ctx,
      );
    },

    /** Sets `changes` on file `fileId`, such as its content id or the caption, credits and alt text of a default metadata row. */
    updateFile(tx: TenantTx, fileId: string, changes: Patch<FileRow, 'fileid'>, ctx?: WriteContext): Promise<FileRow | null> {
      return platform.update<FileRow>(tx, FILE.table, { fileid: fileId }, ormStorage(changes), ctx);
    },

    setFileDeleted,

    /** fileDAO.deleteVersion: marks one file deleted. */
    deleteFileVersion(tx: TenantTx, args: { fileId: string }, ctx?: WriteContext): Promise<FileRow[]> {
      return setFileDeleted(tx, { fileId: args.fileId, deleted: 1 }, ctx);
    },

    /** fileDAO.restoreVersion: clears the deleted mark of one file. */
    restoreVersion(tx: TenantTx, args: { fileId: string }, ctx?: WriteContext): Promise<FileRow[]> {
      return setFileDeleted(tx, { fileId: args.fileId, deleted: 0 }, ctx);
    },

    deleteIfNotUsed,
    versionFiles,

    /** fileDAO.deleteAll where the item's files live in this tenant: `deleteIfNotUsed` over every version's file. */
    async deleteAllForContent(
      tx: TenantTx,
      args: { contentId: string; referencedElsewhere?: readonly string[] },
      ctx?: WriteContext,
    ): Promise<ContentFilesDeletion> {
      const versionFiles = await listVersionFiles(tx, { contentId: args.contentId });
      const deletedFileIds = await deleteIfNotUsed(
        tx,
        {
          fileIds: versionFiles.map((pair) => pair.fileid),
          baseIds: versionFiles.map((pair) => pair.contenthistid),
          ...(args.referencedElsewhere === undefined ? {} : { referencedElsewhere: args.referencedElsewhere }),
        },
        ctx,
      );
      return { versionFiles, deletedFileIds };
    },

    /** fileDAO.purgeDeleted: removes the deleted files, of one site when `siteId` is given, row by row. */
    purgeDeleted(tx: TenantTx, args: { siteId?: string } = {}, ctx?: WriteContext): Promise<FileRow[]> {
      return deleteWhere<FileRow>(
        tx,
        FILE,
        (p) => (args.siteId !== undefined && args.siteId !== '' ? `deleted = 1 AND siteid = ${p.add(args.siteId)}` : 'deleted = 1'),
        ctx,
      );
    },

    /** Records a stored object of `content-files`, or updates the row with the same object key. */
    async upsertFileObject(tx: TenantTx, row: FileObjectInput, ctx?: WriteContext): Promise<FileObjectRow> {
      await gateFileObjectWrite(tx, ctx);
      return platform.upsert<FileObjectRow>(
        tx,
        FILE_OBJECT.table,
        { ...row, size: String(row.size), orphan: row.orphan ?? false, created_at: row.created_at ?? clock.now() },
        ctx,
      );
    },

    /** Removes the manifest row of one stored object. */
    async deleteFileObject(tx: TenantTx, args: { objectKey: string }, ctx?: WriteContext): Promise<FileObjectRow | null> {
      await gateFileObjectWrite(tx, ctx);
      return platform.delete<FileObjectRow>(tx, FILE_OBJECT.table, { object_key: args.objectKey }, ctx);
    },

    /** contentFileMetaDataBean.save of a new row, under a new CF UUID. */
    insertFileMetadata(tx: TenantTx, row: FileMetadataInput, ctx?: WriteContext): Promise<FileMetadataRow> {
      return platform.insert<FileMetadataRow>(tx, FILE_METADATA.table, ormStorage({ ...row, metaid: row.metaid ?? cfUuid() }), ctx);
    },

    /** contentFileMetaDataBean.save of an existing row. */
    updateFileMetadata(tx: TenantTx, metaId: string, changes: Patch<FileMetadataRow, 'metaid'>, ctx?: WriteContext): Promise<FileMetadataRow | null> {
      return platform.update<FileMetadataRow>(tx, FILE_METADATA.table, { metaid: metaId }, ormStorage(changes), ctx);
    },

    /** contentFileMetaDataBean.delete. */
    deleteFileMetadata(tx: TenantTx, args: { metaId: string }, ctx?: WriteContext): Promise<FileMetadataRow | null> {
      return platform.delete<FileMetadataRow>(tx, FILE_METADATA.table, { metaid: args.metaId }, ctx);
    },
  };


  // ---- feeds ----

  /** feedDAO.createItems of the `contentID` and `categoryID` lists; empty list elements are skipped as `cfloop list` skips them. */
  function createFeedItems(tx: TenantTx, feedId: string, items: FeedItemsInput, ctx: Ctx): Promise<FeedItemRow[]> {
    const rows = [
      ...(items.contentIds ?? []).filter((id) => id !== '').map((itemid) => ({ feedid: feedId, itemid, type: 'contentID' })),
      ...(items.categoryIds ?? []).filter((id) => id !== '').map((itemid) => ({ feedid: feedId, itemid, type: 'categoryID' })),
    ];
    return insertEach<FeedItemRow>(tx, FEED_ITEM, rows, ctx);
  }

  /** feedDAO.deleteItems then createItems. */
  async function replaceFeedItems(tx: TenantTx, feedId: string, items: FeedItemsInput, ctx?: WriteContext): Promise<FeedItemRow[]> {
    await deleteWhere(tx, FEED_ITEM, (p) => idEq(p, 'feedid', feedId), ctx);
    return createFeedItems(tx, feedId, items, ctx);
  }

  /** feedDAO.createAdvancedParams: deletes the feed's advanced params, then inserts each under a new `paramid`. */
  async function replaceAdvancedParams(
    tx: TenantTx,
    feedId: string,
    params: readonly FeedAdvancedParamInput[],
    ctx?: WriteContext,
  ): Promise<FeedAdvancedParamRow[]> {
    await deleteWhere(tx, FEED_ADVANCED_PARAM, (p) => idEq(p, 'feedid', feedId), ctx);
    return insertEach<FeedAdvancedParamRow>(
      tx,
      FEED_ADVANCED_PARAM,
      params.map((param) => ({
        feedid: feedId,
        paramid: cfUuid(),
        param: param.param === null ? null : String(param.param),
        relationship: param.relationship,
        field: param.field,
        datatype: param.datatype,
        condition: param.condition,
        criteria: param.criteria,
      })),
      ctx,
    );
  }

  /** The item and param rewrites feedDAO.create and update run after the feed row: items when either list is given, params when given. */
  async function writeFeedChildren(tx: TenantTx, feedId: string, children: FeedChildrenInput, ctx: Ctx): Promise<void> {
    if (children.contentIds !== undefined || children.categoryIds !== undefined) {
      await replaceFeedItems(tx, feedId, children, ctx);
    }
    if (children.advancedParams !== undefined) {
      await replaceAdvancedParams(tx, feedId, children.advancedParams, ctx);
    }
  }

  const feeds = {
    ...feedQueries,

    /** feedDAO.create: the feed row, then its items and advanced params. */
    async insertFeed(tx: TenantTx, row: FeedInput, children: FeedChildrenInput = {}, ctx?: WriteContext): Promise<FeedRow> {
      const stored = await platform.insert<FeedRow>(tx, FEED.table, feedStorage({ ...row, feedid: row.feedid ?? cfUuid() }), ctx);
      await writeFeedChildren(tx, stored.feedid, children, ctx);
      return stored;
    },

    /** feedDAO.update: the feed row's columns, then its items and advanced params; null when no feed has `feedId`. */
    async updateFeed(
      tx: TenantTx,
      feedId: string,
      changes: Patch<FeedRow, 'feedid'>,
      children: FeedChildrenInput = {},
      ctx?: WriteContext,
    ): Promise<FeedRow | null> {
      const [updated] = await updateWhere<FeedRow>(tx, FEED, (p) => idEq(p, 'feedid', feedId), feedStorage(changes), ctx);
      if (updated === undefined) {
        return null;
      }
      await writeFeedChildren(tx, updated.feedid, children, ctx);
      return updated;
    },

    /** feedDAO.delete: removes the feed row only; legacy leaves its items and advanced params in place, and so does this. */
    async deleteFeed(tx: TenantTx, args: { feedId: string }, ctx?: WriteContext): Promise<FeedRow | null> {
      const [removed] = await deleteWhere<FeedRow>(tx, FEED, (p) => idEq(p, 'feedid', args.feedId), ctx);
      return removed ?? null;
    },

    replaceFeedItems,

    /** feedDAO.deleteItem: removes one item of a feed. */
    deleteFeedItem(tx: TenantTx, args: { feedId: string; itemId: string }, ctx?: WriteContext): Promise<FeedItemRow[]> {
      return deleteWhere<FeedItemRow>(tx, FEED_ITEM, (p) => `${idEq(p, 'feedid', args.feedId)} AND ${ciEq(p, 'itemid', args.itemId)}`, ctx);
    },

    replaceAdvancedParams,
  };

  // ---- comments ----

  const commentColumns = (alias: string): string =>
    ['contentid', 'commentid', 'parentid', 'name', 'email', 'url', 'comments', 'entered', 'siteid', 'isapproved', 'subscribe', 'userid', 'path']
      .map((column) => `${alias}.${column}`)
      .join(', ');

  /** Single-row comment flag changes of contentCommentBean (`where commentID = …`). */
  async function setCommentColumns(tx: TenantTx, commentId: string, patch: CommentPatch | ((row: CommentRow) => CommentPatch | null), ctx: Ctx): Promise<CommentRow | null> {
    const [updated] = await updateWhere<CommentRow>(
      tx,
      COMMENT,
      (p) => idEq(p, 'commentid', commentId),
      patch as RepositoryRow | ((row: CommentRow) => RepositoryRow | null),
      ctx,
    );
    return updated ?? null;
  }

  /** contentDAO.readComments' SELECT. */
  function commentListSelect(tx: TenantTx, args: ListCommentsArgs): BuiltSelect {
    const p = new SqlParams(1);
    const isEditor = args.isEditor === true;
    const includeSpam = args.includeSpam === true;
    const includeDeleted = args.includeDeleted === true;
    const visibility = (alias: string): string =>
      `${isEditor ? '' : ` AND ${alias}.isapproved = 1`}${includeSpam ? '' : ` AND ${alias}.isspam = 0`}${includeDeleted ? '' : ` AND ${alias}.isdeleted = 0`}`;
    const site = p.add(args.siteId);
    let kids = '0 AS kids';
    let join = '';
    if (args.includeKids === true) {
      kids = 'k.kids';
      join =
        ` LEFT JOIN (SELECT count(*)::integer AS kids, x.parentid FROM ${name(COMMENT)} x WHERE x.tenant_id = $1 AND x.parentid IN` +
        ` (SELECT y.commentid FROM ${name(COMMENT)} y WHERE y.tenant_id = $1 AND ${idEq(p, 'y.contentid', args.contentId)} AND y.siteid = ${site}${visibility('y')})` +
        ' GROUP BY x.parentid) k ON c.commentid = k.parentid';
    }
    const filters = [`c.tenant_id = $1`, idEq(p, 'c.contentid', args.contentId), `c.siteid = ${site}`];
    if (args.filterByParentId !== false) {
      filters.push(args.parentId !== undefined && args.parentId !== '' ? idEq(p, 'c.parentid', args.parentId) : 'c.parentid IS NULL');
    }
    return {
      select: `SELECT ${commentColumns('c')}, ${kids} FROM ${name(COMMENT)} c${join} WHERE ${filters.join(' AND ')}${visibility('c')}`,
      order: `ORDER BY ${orderKey('c.entered', sqlDirection(args.sortOrder ?? 'asc'))}, c.commentid`,
      values: [tx.tenantId, ...p.values],
    };
  }

  /** contentDAO.readComments: a content item's comments, optionally with their reply counts. */
  function listComments(tx: TenantTx, args: ListCommentsArgs): Promise<CommentListRow[]> {
    const built = commentListSelect(tx, args);
    return select<CommentListRow>(tx, [COMMENT], `${built.select} ${built.order}`, built.values);
  }

  /** contentCommentManager.getComments' WHERE, ORDER BY and row cap (`maxItems` above 0) bound into `p`; an unknown sort throws here. */
  function commentFeedQuery(p: SqlParams, args: CommentFeedArgs): { where: string; order: string; cap: number | undefined } {
    const filters = [`tenant_id = $1`, `siteid = ${p.add(args.siteId ?? 'default')}`];
    if (args.commentId !== undefined) filters.push(idEq(p, 'commentid', args.commentId));
    if (args.keywords !== undefined) {
      filters.push(`(${ciLike(p, 'comments', `%${args.keywords}%`)} OR ${ciLike(p, 'name', `%${args.keywords}%`)})`);
    }
    if (args.contentId !== undefined && args.contentId !== '') filters.push(idEq(p, 'contentid', args.contentId));
    if (args.parentId !== undefined) filters.push(idEq(p, 'parentid', args.parentId));
    if (args.remoteId !== undefined) filters.push(ciEq(p, 'remoteid', args.remoteId));
    if (args.ip !== undefined) filters.push(ciEq(p, 'ip', args.ip));
    if (args.email !== undefined) filters.push(ciEq(p, 'email', args.email));
    if (args.name !== undefined) filters.push(ciEq(p, 'name', args.name));
    if (args.isApproved !== undefined) filters.push(`isapproved = ${p.add(args.isApproved ? 1 : 0)}`);
    if (args.isSpam !== undefined) filters.push(`isspam = ${p.add(args.isSpam ? 1 : 0)}`);
    if (args.isDeleted !== undefined) filters.push(`isdeleted = ${p.add(args.isDeleted ? 1 : 0)}`);
    if (args.startDate !== undefined) filters.push(`entered >= ${p.add(atTimeOfDay(args.startDate, 0, 0, 0))}`);
    if (args.endDate !== undefined) filters.push(`entered <= ${p.add(atTimeOfDay(args.endDate, 23, 59, 59))}`);
    if (args.categoryIds !== undefined && args.categoryIds.length > 0) {
      filters.push(
        `contentid IN (SELECT DISTINCT a.contentid FROM ${name(CATEGORY_ASSIGN)} a WHERE a.tenant_id = $1 AND ${idIn(p, 'a.categoryid', args.categoryIds)})`,
      );
    }
    const sort = orderKey(sortColumn(COMMENT, name(COMMENT), args.sortBy ?? 'entered'), sqlDirection(args.sortDirection ?? 'asc'));
    const maxItems = args.maxItems ?? 1000;
    return { where: filters.join(' AND '), order: `ORDER BY ${sort}, commentid`, cap: maxItems > 0 ? Math.trunc(maxItems) : undefined };
  }

  const comments = {
    /** contentCommentBean.save of a new comment, as legacy stores it. */
    insertComment(tx: TenantTx, row: CommentInput, ctx?: WriteContext): Promise<CommentRow> {
      return platform.insert<CommentRow>(tx, COMMENT.table, commentStorage({ ...row, commentid: row.commentid ?? cfUuid() }), ctx);
    },

    /** contentCommentBean.save of an existing comment. */
    updateComment(tx: TenantTx, commentId: string, changes: CommentPatch, ctx?: WriteContext): Promise<CommentRow | null> {
      return setCommentColumns(tx, commentId, commentStorage(changes) as CommentPatch, ctx);
    },

    /** contentManager.approveComment and unapproveComment. */
    setApproved(tx: TenantTx, args: { commentId: string; isApproved: number }, ctx?: WriteContext): Promise<CommentRow | null> {
      return setCommentColumns(tx, args.commentId, { isapproved: args.isApproved }, ctx);
    },

    /** contentCommentBean.markAsSpam and unMarkAsSpam. */
    setSpam(tx: TenantTx, args: { commentId: string; isSpam: number }, ctx?: WriteContext): Promise<CommentRow | null> {
      return setCommentColumns(tx, args.commentId, { isspam: args.isSpam }, ctx);
    },

    /** contentCommentBean.delete and undelete. */
    setDeleted(tx: TenantTx, args: { commentId: string; isDeleted: number }, ctx?: WriteContext): Promise<CommentRow | null> {
      return setCommentColumns(tx, args.commentId, { isdeleted: args.isDeleted }, ctx);
    },

    /** contentCommentBean.flag: `flagCount = flagCount + 1`. */
    incrementFlagCount(tx: TenantTx, args: { commentId: string }, ctx?: WriteContext): Promise<CommentRow | null> {
      return setCommentColumns(tx, args.commentId, (row) => ({ flagcount: row.flagcount === null ? null : row.flagcount + 1 }), ctx);
    },

    /** contentCommentBean.saveSubscription: sets `subscribe` on every comment of the email on the content item. */
    setSubscribe(tx: TenantTx, args: { contentId: string; siteId: string; email: string; subscribe: number }, ctx?: WriteContext): Promise<CommentRow[]> {
      return updateWhere<CommentRow>(
        tx,
        COMMENT,
        (p) => `${idEq(p, 'contentid', args.contentId)} AND siteid = ${p.add(args.siteId)} AND ${ciEq(p, 'email', args.email)}`,
        { subscribe: args.subscribe },
        ctx,
      );
    },

    /** contentCommentManager.purgeDeletedComments: removes the deleted comments, of one site when `siteId` is given. */
    purgeDeleted(tx: TenantTx, args: { siteId?: string } = {}, ctx?: WriteContext): Promise<CommentRow[]> {
      return deleteWhere<CommentRow>(
        tx,
        COMMENT,
        (p) => (args.siteId !== undefined ? `isdeleted = 1 AND siteid = ${p.add(args.siteId)}` : 'isdeleted = 1'),
        ctx,
      );
    },

    /** Saves a commenter (contentCommentCommenterBean); `commenterid` defaults to a new CF UUID. */
    upsertCommenter(tx: TenantTx, row: Omit<Fields<CommenterRow>, 'commenterid'> & { commenterid?: string }, ctx?: WriteContext): Promise<CommenterRow> {
      return platform.upsert<CommenterRow>(tx, COMMENTER.table, { ...row, commenterid: row.commenterid ?? cfUuid() }, ctx);
    },

    /** commenter.loadBy(commenterID | remoteID): the first matching commenter, or null. */
    async findCommenter(tx: TenantTx, lookup: { commenterId: string } | { remoteId: string }): Promise<CommenterRow | null> {
      const p = new SqlParams(1);
      const where = 'commenterId' in lookup ? idEq(p, 'commenterid', lookup.commenterId) : ciEq(p, 'remoteid', lookup.remoteId);
      const rows = await select<CommenterRow>(
        tx,
        [COMMENTER],
        `SELECT * FROM ${name(COMMENTER)} WHERE tenant_id = $1 AND ${where} ORDER BY commenterid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** `findCommenter` by commenter id for several ids with one query: each id's first commenter, keyed by the id. */
    async findCommenters(tx: TenantTx, commenterIds: readonly string[]): Promise<Map<string, CommenterRow>> {
      const ids = [...new Set(commenterIds)];
      if (ids.length === 0) return new Map();
      const p = new SqlParams(1);
      const rows = await select<CommenterRow>(
        tx,
        [COMMENTER],
        `SELECT * FROM ${name(COMMENTER)} WHERE tenant_id = $1 AND ${idIn(p, 'commenterid', ids)} ORDER BY commenterid`,
        [tx.tenantId, ...p.values],
      );
      return firstById(rows, ids, (row) => row.commenterid);
    },

    /** The name `findComment` reads for several comment ids with one query: each id's first comment, keyed by the id. */
    async commentNames(tx: TenantTx, commentIds: readonly string[]): Promise<Map<string, Pick<CommentRow, 'commentid' | 'name'>>> {
      const ids = [...new Set(commentIds)];
      if (ids.length === 0) return new Map();
      const p = new SqlParams(1);
      const rows = await select<Pick<CommentRow, 'commentid' | 'name'>>(
        tx,
        [COMMENT],
        `SELECT c.commentid, c.name FROM ${name(COMMENT)} c WHERE c.tenant_id = $1 AND ${idIn(p, 'c.commentid', ids)} ORDER BY c.commentid`,
        [tx.tenantId, ...p.values],
      );
      return firstById(rows, ids, (row) => row.commentid);
    },

    /** contentCommentBean.getQuery: one comment by id or remote id, with legacy's self-referencing `kids` count. */
    async findComment(tx: TenantTx, lookup: { commentId: string } | { remoteId: string }): Promise<CommentFindRow | null> {
      const p = new SqlParams(1);
      const probe = 'commentId' in lookup ? lookup.commentId : '';
      const kidsJoin =
        ` LEFT JOIN (SELECT count(*)::integer AS kids, k0.parentid FROM ${name(COMMENT)} k0 WHERE k0.tenant_id = $1` +
        ` AND ${idEq(p, 'k0.commentid', probe)} GROUP BY k0.parentid) k ON c.commentid = k.parentid`;
      const where = 'commentId' in lookup ? idEq(p, 'c.commentid', lookup.commentId) : ciEq(p, 'c.remoteid', lookup.remoteId);
      const rows = await select<CommentFindRow>(
        tx,
        [COMMENT],
        `SELECT ${commentColumns('c')}, c.isdeleted, c.isspam, c.remoteid, k.kids, c.flagcount FROM ${name(COMMENT)} c${kidsJoin}` +
          ` WHERE c.tenant_id = $1 AND ${where} ORDER BY c.commentid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    listComments,

    /** contentDAO.readComments, one page in its order with the count of all its rows. */
    async listCommentsPage(tx: TenantTx, args: ListCommentsArgs, page: RowPage): Promise<PagedRows<CommentListRow>> {
      return selectPage<CommentListRow>(tx, [COMMENT], commentListSelect(tx, args), page);
    },

    /** contentDAO.readComments, every row in its order, `batchSize` rows per batch. */
    async *listCommentBatches(tx: TenantTx, args: ListCommentsArgs, batchSize?: number): AsyncGenerator<CommentListRow[], void, undefined> {
      yield* selectBatches<CommentListRow>(tx, [COMMENT], commentListSelect(tx, args), batchSize);
    },

    /** contentDAO.readRecentComments; legacy's default `approvedOnly` names a column the table lacks, so it fails as legacy does. */
    recentComments(
      tx: TenantTx,
      args: { siteId: string; size?: number; approvedOnly?: boolean; includeSpam?: boolean; includeDeleted?: boolean },
    ): Promise<Omit<CommentListRow, 'kids'>[]> {
      if (args.approvedOnly !== false) {
        return Promise.reject(new ContentQueryError('Invalid column name approved for tcontentcomments'));
      }
      const p = new SqlParams(1);
      const filters = [`c.tenant_id = $1`, `c.siteid = ${p.add(args.siteId)}`];
      if (args.includeSpam !== true) filters.push('c.isspam = 0');
      if (args.includeDeleted !== true) filters.push('c.isdeleted = 0');
      const size = args.size ?? 5;
      return select<Omit<CommentListRow, 'kids'>>(
        tx,
        [COMMENT],
        `SELECT ${commentColumns('c')} FROM ${name(COMMENT)} c WHERE ${filters.join(' AND ')}` +
          ` ORDER BY ${orderKey('c.entered', 'desc')}, c.commentid${size > 0 ? ` LIMIT ${p.add(Math.trunc(size))}` : ''}`,
        [tx.tenantId, ...p.values],
      );
    },

    /** contentDAO.getCommentCount: the comments of an item an editor or visitor sees. */
    async commentCount(
      tx: TenantTx,
      args: { contentId: string; siteId: string; isEditor?: boolean; includeSpam?: boolean; includeDeleted?: boolean },
    ): Promise<number> {
      const p = new SqlParams(1);
      const filters = [`tenant_id = $1`, idEq(p, 'contentid', args.contentId), `siteid = ${p.add(args.siteId)}`];
      if (args.isEditor !== true) filters.push('isapproved = 1');
      if (args.includeSpam !== true) filters.push('isspam = 0');
      if (args.includeDeleted !== true) filters.push('isdeleted = 0');
      const rows = await select<{ totalcomments: number }>(
        tx,
        [COMMENT],
        `SELECT count(*)::integer AS totalcomments FROM ${name(COMMENT)} WHERE ${filters.join(' AND ')}`,
        [tx.tenantId, ...p.values],
      );
      return rows[0]?.totalcomments ?? 0;
    },

    /** contentDAO.getCommentSubscribers: the distinct emails subscribed to an item's approved comments. */
    async commentSubscribers(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<string[]> {
      const p = new SqlParams(1);
      const rows = await select<{ email: string }>(
        tx,
        [COMMENT],
        `SELECT DISTINCT email FROM ${name(COMMENT)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)}` +
          ` AND siteid = ${p.add(args.siteId)} AND email IS NOT NULL AND isapproved = 1 AND subscribe = 1 AND isspam = 0 AND isdeleted = 0 ORDER BY email`,
        [tx.tenantId, ...p.values],
      );
      return rows.map((row) => row.email);
    },

    /** contentCommentManager.getComments: the comment manager's filter, sort and row limit. */
    commentFeed(tx: TenantTx, args: CommentFeedArgs = {}): Promise<CommentRow[]> {
      const p = new SqlParams(1);
      const feed = commentFeedQuery(p, args);
      return select<CommentRow>(
        tx,
        [COMMENT, CATEGORY_ASSIGN],
        `SELECT * FROM ${name(COMMENT)} WHERE ${feed.where} ${feed.order}${feed.cap !== undefined ? ` LIMIT ${p.add(feed.cap)}` : ''}`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The number of rows `commentFeed` returns for `args`. */
    async commentFeedCount(tx: TenantTx, args: CommentFeedArgs = {}): Promise<number> {
      const p = new SqlParams(1);
      const feed = commentFeedQuery(p, args);
      const rows = await select<{ total: number }>(
        tx,
        [COMMENT, CATEGORY_ASSIGN],
        `SELECT count(*)::integer AS total FROM (SELECT 1 FROM ${name(COMMENT)} WHERE ${feed.where}` +
          `${feed.cap !== undefined ? ` LIMIT ${p.add(feed.cap)}` : ''}) q`,
        [tx.tenantId, ...p.values],
      );
      return rows[0]?.total ?? 0;
    },

    /** The `commentFeed` rows for `args` at zero-based positions `offset` to `offset + limit - 1`, never past its row cap. */
    commentFeedPage(tx: TenantTx, args: CommentFeedArgs, page: RowPage): Promise<CommentRow[]> {
      const p = new SqlParams(1);
      const feed = commentFeedQuery(p, args);
      const offset = page.offset ?? 0;
      const limit = feed.cap === undefined ? page.limit : Math.max(0, Math.min(page.limit, feed.cap - offset));
      return select<CommentRow>(
        tx,
        [COMMENT, CATEGORY_ASSIGN],
        `SELECT * FROM ${name(COMMENT)} WHERE ${feed.where} ${feed.order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
        [tx.tenantId, ...p.values],
      );
    },

    /** contentCommentBean.getKidsQuery: the replies to one comment. */
    commentKids(
      tx: TenantTx,
      args: { commentId: string; contentId: string; siteId: string; isEditor?: boolean; sortOrder?: SortDirection },
    ): Promise<CommentListRow[]> {
      return listComments(tx, {
        contentId: args.contentId,
        siteId: args.siteId,
        isEditor: args.isEditor ?? false,
        sortOrder: args.sortOrder ?? 'asc',
        parentId: args.commentId,
      });
    },

    /** contentCommentBean.getCrumbQuery: the comments of a materialized path by depth. */
    commentCrumbs(tx: TenantTx, args: { path: string; sort?: SortDirection }): Promise<CommentCrumbRow[]> {
      const ids = cfList(args.path);
      const p = new SqlParams(1);
      const pathIds = p.add(idForms(ids));
      return select<CommentCrumbRow>(
        tx,
        [COMMENT],
        `SELECT ${commentColumns('c')}, length(rtrim(left(c.path, 1000)))::integer AS depth, k.kids FROM ${name(COMMENT)} c` +
          ` LEFT JOIN (SELECT count(*)::integer AS kids, x.parentid FROM ${name(COMMENT)} x WHERE x.tenant_id = $1 AND x.parentid IN` +
          ` (SELECT y.commentid FROM ${name(COMMENT)} y WHERE y.tenant_id = $1 AND y.parentid = ANY(${pathIds}::bpchar[])) GROUP BY x.parentid) k` +
          ` ON c.commentid = k.parentid WHERE c.tenant_id = $1 AND c.commentid = ANY(${pathIds}::bpchar[])` +
          ` ORDER BY ${orderKey('length(rtrim(left(c.path, 1000)))', args.sort === 'desc' ? 'desc' : 'asc')}, c.commentid`,
        [tx.tenantId, ...p.values],
      );
    },
  };

  // ---- categories ----

  /** categoryDAO.saveAssignment: one category assignment of a version. */
  function saveAssignment(tx: TenantTx, row: Fields<CategoryAssignRow> & { contenthistid: string; categoryid: string }, ctx: Ctx): Promise<CategoryAssignRow> {
    return platform.insert<CategoryAssignRow>(tx, CATEGORY_ASSIGN.table, assignmentStorage(row), ctx);
  }

  /** categoryGateway.getCategories and the interest-group lists: categories of a pool site with their child counts. */
  function categoryList(tx: TenantTx, args: ListCategoriesArgs): Promise<CategoryListRow[]> {
    const p = new SqlParams(1);
    const filters = [`c.tenant_id = $1`, `c.siteid = ${p.add(args.siteId)}`];
    filters.push(args.parentId !== undefined && args.parentId !== '' ? idEq(p, 'c.parentid', args.parentId) : 'c.parentid IS NULL');
    if (args.keywords !== undefined && args.keywords !== '') filters.push(ciLike(p, 'c.name', `%${args.keywords}%`));
    if (args.activeOnly === true) filters.push('c.isactive = 1');
    if (args.interestsOnly === true) filters.push('c.isinterestgroup = 1');
    const grouped = 'c.siteid, c.categoryid, c.name, c.filename, c.urltitle, c.parentid, c.isactive, c.isinterestgroup, c.isopen, c.restrictgroups, c.isfeatureable';
    return select<CategoryListRow>(
      tx,
      [CATEGORY],
      `SELECT ${grouped}, count(k.parentid)::integer AS haskids FROM ${name(CATEGORY)} c` +
        ` LEFT JOIN ${name(CATEGORY)} k ON (k.tenant_id = c.tenant_id AND c.categoryid = k.parentid)` +
        ` WHERE ${filters.join(' AND ')} GROUP BY ${grouped} ORDER BY ${orderKey('lower(c.name)', 'asc')}, c.categoryid`,
      [tx.tenantId, ...p.values],
    );
  }

  /** categoryGateway.getPrivateInterestGroups and getPublicInterestGroups over the sites sharing the user pool. */
  function interestGroups(tx: TenantTx, args: { sites: readonly InterestGroupSite[]; parentId?: string }): Promise<InterestGroupRow[]> {
    const p = new SqlParams(1);
    const siteIds = p.add(args.sites.map((site) => site.siteId));
    const siteNames = p.add(args.sites.map((site) => site.site));
    const parent = args.parentId !== undefined && args.parentId !== '' ? idEq(p, 'c.parentid', args.parentId) : 'c.parentid IS NULL';
    const grouped = 's.site, c.categoryid, c.name, c.filename, c.urltitle, c.isopen';
    return select<InterestGroupRow>(
      tx,
      [CATEGORY],
      `SELECT ${grouped}, count(k.parentid)::integer AS haskids FROM unnest(${siteIds}::text[], ${siteNames}::text[]) AS s(siteid, site)` +
        ` INNER JOIN ${name(CATEGORY)} c ON (c.tenant_id = $1 AND s.siteid = c.siteid)` +
        ` LEFT JOIN ${name(CATEGORY)} k ON (k.tenant_id = c.tenant_id AND c.categoryid = k.parentid)` +
        ` WHERE c.isinterestgroup = 1 AND ${parent} GROUP BY ${grouped}` +
        ` ORDER BY ${orderKey('lower(s.site)', 'asc')}, ${orderKey('lower(c.name)', 'asc')}, c.categoryid`,
      [tx.tenantId, ...p.values],
    );
  }

  /** categoryGateway.getCategoryFeatures and getLiveCategoryFeatures: the content featured in a category. */
  function categoryFeatureList(tx: TenantTx, args: CategoryFeatureArgs, live: boolean): Promise<CategoryFeatureRow[]> {
    const p = new SqlParams(1);
    const filters = [`c.tenant_id = $1`, 'c.active = 1'];
    if (live) {
      const now = clock.now();
      filters.push(
        `(c.display = 1 OR (c.display = 2 AND c.displaystart <= ${p.add(now)} AND (c.displaystop >= ${p.add(now)} OR c.displaystop IS NULL)))`,
        `(a.isfeature = 1 OR (a.isfeature = 2 AND a.featurestart <= ${p.add(now)} AND (a.featurestop >= ${p.add(now)} OR a.featurestop IS NULL)))`,
      );
    } else {
      filters.push('a.isfeature > 0');
    }
    filters.push(idEq(p, 'a.categoryid', args.categoryId));
    const sortKey = args.sortBy.trim().toLowerCase() === 'orderno' ? 'a.orderno' : sortColumn(CONTENT, 'c', args.sortBy);
    return select<CategoryFeatureRow>(
      tx,
      [CONTENT, CATEGORY_ASSIGN],
      'SELECT c.title, c.releasedate, c.menutitle, c.lastupdate, c.summary, c.filename, c.type, c.contentid, c.target, c.targetparams,' +
        ' c.restricted, c.restrictgroups, c.displaystart, c.displaystop, 0 AS comments, a.orderno, c.display, c.active, c.approved,' +
        ' a.featurestart, a.featurestop, a.isfeature, c.fileid, c.credits, c.remotesource, c.remoteurl, c.remotesourceurl, c.audience, c.keypoints' +
        ` FROM ${name(CONTENT)} c INNER JOIN ${name(CATEGORY_ASSIGN)} a ON (c.tenant_id = a.tenant_id AND c.contenthistid = a.contenthistid)` +
        ` WHERE ${filters.join(' AND ')} ORDER BY ${orderKey(sortKey, sqlDirection(args.sortDirection))}, c.contenthistid`,
      [tx.tenantId, ...p.values],
    );
  }

  /** The categories a category pool site holds, optionally only interest groups, by name. */
  function siteCategories(tx: TenantTx, args: { siteId: string; keywords?: string }, interestOnly: boolean): Promise<CategoryRow[]> {
    const p = new SqlParams(1);
    const filters = [`tenant_id = $1`, `siteid = ${p.add(args.siteId)}`];
    if (interestOnly) filters.push('isinterestgroup = 1');
    if (args.keywords !== undefined && args.keywords !== '') filters.push(ciLike(p, 'name', `%${args.keywords}%`));
    return select<CategoryRow>(
      tx,
      [CATEGORY],
      `SELECT * FROM ${name(CATEGORY)} WHERE ${filters.join(' AND ')} ORDER BY ${orderKey('lower(name)', 'asc')}, categoryid`,
      [tx.tenantId, ...p.values],
    );
  }

  /** The categories counted by categoryGateway.getCategoryCount and getInterestGroupCount. */
  async function countCategories(tx: TenantTx, args: { siteId: string; activeOnly?: boolean }, interestOnly: boolean): Promise<number> {
    const p = new SqlParams(1);
    const filters = [`tenant_id = $1`, `siteid = ${p.add(args.siteId)}`];
    if (interestOnly) filters.push('isinterestgroup = 1');
    if (args.activeOnly === true) filters.push('isactive = 1');
    const rows = await select<{ thecount: number }>(
      tx,
      [CATEGORY],
      `SELECT count(*)::integer AS thecount FROM ${name(CATEGORY)} WHERE ${filters.join(' AND ')}`,
      [tx.tenantId, ...p.values],
    );
    return rows[0]?.thecount ?? 0;
  }

  /** The categories whose materialized path names `categoryId`, the category itself included (`path like %id%`). */
  function categoriesUnderPath(tx: TenantTx, args: { categoryId: string }): Promise<CategoryRow[]> {
    const p = new SqlParams(1);
    return select<CategoryRow>(
      tx,
      [CATEGORY],
      `SELECT * FROM ${name(CATEGORY)} WHERE tenant_id = $1 AND ${ciLike(p, 'path', `%${args.categoryId}%`)} ORDER BY categoryid`,
      [tx.tenantId, ...p.values],
    );
  }

  const categories = {
    /** categoryDAO.create, as legacy stores it. */
    insertCategory(tx: TenantTx, row: CategoryInput, ctx?: WriteContext): Promise<CategoryRow> {
      return platform.insert<CategoryRow>(
        tx,
        CATEGORY.table,
        categoryStorage({
          isinterestgroup: 0,
          isactive: 0,
          isopen: 0,
          isfeatureable: 0,
          datecreated: null,
          lastupdate: null,
          ...row,
          categoryid: row.categoryid ?? cfUuid(),
        }),
        ctx,
      );
    },

    /** categoryDAO.update; null when no category has `categoryId`. */
    async updateCategory(tx: TenantTx, categoryId: string, changes: CategoryPatch, ctx?: WriteContext): Promise<CategoryRow | null> {
      const [updated] = await updateWhere<CategoryRow>(tx, CATEGORY, (p) => idEq(p, 'categoryid', categoryId), categoryStorage(changes), ctx);
      return updated ?? null;
    },

    /** categoryDAO.delete: moves the children under the deleted category's parent, then removes it. */
    async deleteCategory(tx: TenantTx, args: { categoryId: string; parentId: string | null }, ctx?: WriteContext): Promise<CategoryRow | null> {
      await updateWhere(tx, CATEGORY, (p) => idEq(p, 'parentid', args.categoryId), { parentid: nullIfEmpty(args.parentId) }, ctx);
      const [removed] = await deleteWhere<CategoryRow>(tx, CATEGORY, (p) => idEq(p, 'categoryid', args.categoryId), ctx);
      return removed ?? null;
    },

    /** categoryDAO.setListOrder: the order number of each listed item in the category, across the content pool `siteIds`. */
    async setListOrder(
      tx: TenantTx,
      args: { categoryId: string; items: readonly { contentId: string; orderNo: number }[]; siteIds: readonly string[] },
      ctx?: WriteContext,
    ): Promise<CategoryAssignRow[]> {
      const updated: CategoryAssignRow[] = [];
      for (const item of args.items) {
        updated.push(
          ...(await updateWhere<CategoryAssignRow>(
            tx,
            CATEGORY_ASSIGN,
            (p) => `${idEq(p, 'contentid', item.contentId)} AND ${idEq(p, 'categoryid', args.categoryId)} AND siteid = ANY(${p.add([...args.siteIds])}::text[])`,
            { orderno: item.orderNo },
            ctx,
          )),
        );
      }
      return updated;
    },

    /** categoryDAO.pushCategory: `orderno = orderno + 1` on the category's assignments across the content pool `siteIds`. */
    pushCategory(tx: TenantTx, args: { categoryId: string; siteIds: readonly string[] }, ctx?: WriteContext): Promise<CategoryAssignRow[]> {
      return updateWhere<CategoryAssignRow>(
        tx,
        CATEGORY_ASSIGN,
        (p) => `${idEq(p, 'categoryid', args.categoryId)} AND siteid = ANY(${p.add([...args.siteIds])}::text[])`,
        (row) => ({ orderno: row.orderno === null ? null : row.orderno + 1 }),
        ctx,
      );
    },

    /** categoryDAO.setAssignment: a scheduled feature without a start date is stored as a plain feature. */
    setAssignment(tx: TenantTx, args: SetAssignmentArgs, ctx?: WriteContext): Promise<CategoryAssignRow> {
      const start = toMinute(args.featureStart);
      const feature = args.isFeature === 2 && start === null ? 1 : args.isFeature;
      return saveAssignment(
        tx,
        {
          contenthistid: args.contentHistId,
          contentid: args.contentId,
          categoryid: args.categoryId,
          siteid: args.siteId,
          orderno: args.orderNo,
          isfeature: feature,
          featurestart: feature === 2 ? start : null,
          featurestop: feature === 2 ? toMinute(args.featureStop) : null,
        },
        ctx,
      );
    },

    /** categoryDAO.keepCategories: copies the kept assignments of the previous version onto `contentHistId`. */
    async keepCategories(tx: TenantTx, contentHistId: string, rows: readonly CategoryAssignmentInput[], ctx?: WriteContext): Promise<CategoryAssignRow[]> {
      const stored: CategoryAssignRow[] = [];
      for (const row of rows) {
        stored.push(await saveAssignment(tx, { ...row, contenthistid: contentHistId }, ctx));
      }
      return stored;
    },

    /** categoryManager.updateMaterializedPath: `path = replace(rtrim(ltrim(cast(path AS char(1000)))), current, new)` under `path like current%`. */
    replacePathPrefix(tx: TenantTx, args: { siteId: string; currentPath: string; newPath: string }, ctx?: WriteContext): Promise<CategoryRow[]> {
      return updateWhere<CategoryRow>(
        tx,
        CATEGORY,
        (p) => `${ciLike(p, 'path', `${args.currentPath}%`)} AND siteid = ${p.add(args.siteId)}`,
        (row) => ({ path: replaceAllNoCase((row.path ?? '').slice(0, 1000).replace(/^ +| +$/g, ''), args.currentPath, args.newPath) }),
        ctx,
      );
    },

    /** categoryManager.update's descendant rewrite: `filename = replace(filename, current/, new/)` under `filename like current/%`. */
    replaceFilenamePrefix(
      tx: TenantTx,
      args: { siteId: string; currentFilename: string; newFilename: string },
      ctx?: WriteContext,
    ): Promise<CategoryRow[]> {
      return updateWhere<CategoryRow>(
        tx,
        CATEGORY,
        (p) => `siteid = ${p.add(args.siteId)} AND ${ciLike(p, 'filename', `${args.currentFilename}/%`)}`,
        (row) => ({ filename: replaceAllNoCase(row.filename ?? '', `${args.currentFilename}/`, `${args.newFilename}/`) }),
        ctx,
      );
    },

    /** categoryDAO.read and its readBy variants; more than one row where legacy returns a bean array. */
    readCategory(tx: TenantTx, lookup: CategoryLookup): Promise<CategoryRow[]> {
      const p = new SqlParams(1);
      let where: string;
      if ('categoryId' in lookup) {
        where = idEq(p, 'categoryid', lookup.categoryId);
      } else {
        const [column, value]: [string, string] =
          'name' in lookup ? ['name', lookup.name] : 'urlTitle' in lookup ? ['urltitle', lookup.urlTitle] : 'filename' in lookup ? ['filename', lookup.filename] : ['remoteid', lookup.remoteId];
        where = `${ciEq(p, column, value)} AND siteid = ${p.add(lookup.siteId)}`;
      }
      return select<CategoryRow>(tx, [CATEGORY], `SELECT * FROM ${name(CATEGORY)} WHERE tenant_id = $1 AND ${where} ORDER BY categoryid`, [
        tx.tenantId,
        ...p.values,
      ]);
    },

    listCategories: categoryList,

    /** categoryGateway.getCategoryCount. */
    categoryCount(tx: TenantTx, args: { siteId: string; activeOnly?: boolean }): Promise<number> {
      return countCategories(tx, args, false);
    },

    /** categoryGateway.getInterestGroupCount. */
    interestGroupCount(tx: TenantTx, args: { siteId: string; activeOnly?: boolean }): Promise<number> {
      return countCategories(tx, args, true);
    },

    /** categoryGateway.getCategoriesBySiteID. */
    categoriesBySite(tx: TenantTx, args: { siteId: string; keywords?: string }): Promise<CategoryRow[]> {
      return siteCategories(tx, args, false);
    },

    /** categoryGateway.getInterestGroupsBySiteID. */
    interestGroupsBySite(tx: TenantTx, args: { siteId: string; keywords?: string }): Promise<CategoryRow[]> {
      return siteCategories(tx, args, true);
    },

    /** categoryGateway.getPrivateInterestGroups over the sites sharing the private user pool. */
    privateInterestGroups: interestGroups,

    /** categoryGateway.getPublicInterestGroups over the sites sharing the public user pool. */
    publicInterestGroups: interestGroups,

    /** categoryGateway.getCategoryFeatures. */
    categoryFeatures(tx: TenantTx, args: CategoryFeatureArgs): Promise<CategoryFeatureRow[]> {
      return categoryFeatureList(tx, args, false);
    },

    /** categoryGateway.getLiveCategoryFeatures, at the clock's now. */
    liveCategoryFeatures(tx: TenantTx, args: CategoryFeatureArgs): Promise<CategoryFeatureRow[]> {
      return categoryFeatureList(tx, args, true);
    },

    /** categoryGateway.getCrumbQuery: the categories of a materialized path by depth. */
    crumbQuery(tx: TenantTx, args: { path: string; siteId: string; sort?: SortDirection }): Promise<CategoryCrumbRow[]> {
      const p = new SqlParams(1);
      const depth = 'length(rtrim(left(path, 1000)))';
      return select<CategoryCrumbRow>(
        tx,
        [CATEGORY],
        'SELECT categoryid, siteid, datecreated, lastupdate, lastupdateby, name, isinterestgroup, parentid, isactive, isopen, notes,' +
          ` sortby, sortdirection, restrictgroups, path, remoteid, remotesourceurl, remotepubdate, ${depth}::integer AS depth` +
          ` FROM ${name(CATEGORY)} WHERE tenant_id = $1 AND ${idIn(p, 'categoryid', cfList(args.path))} AND siteid = ${p.add(args.siteId)}` +
          ` ORDER BY ${orderKey(depth, args.sort === 'desc' ? 'desc' : 'asc')}, categoryid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** categoryDAO.getCurrentOrderNo: the item's order number in the category among the content pool `siteIds`, else 0. */
    async currentOrderNo(tx: TenantTx, args: { contentId: string; categoryId: string; siteIds: readonly string[] }): Promise<number> {
      const p = new SqlParams(1);
      const rows = await select<{ orderno: number | null }>(
        tx,
        [CONTENT, CATEGORY_ASSIGN],
        `SELECT DISTINCT a.orderno FROM ${name(CATEGORY_ASSIGN)} a INNER JOIN ${name(CONTENT)} c` +
          ' ON (a.tenant_id = c.tenant_id AND a.contentid = c.contentid AND a.siteid = c.siteid)' +
          ` WHERE a.tenant_id = $1 AND ${idEq(p, 'c.contentid', args.contentId)} AND ${idEq(p, 'a.categoryid', args.categoryId)}` +
          ` AND c.siteid = ANY(${p.add([...args.siteIds])}::text[]) AND c.active = 1 ORDER BY a.orderno`,
        [tx.tenantId, ...p.values],
      );
      return rows[0]?.orderno ?? 0;
    },

    descendants: categoriesUnderPath,

    /** The ids of the categories whose path names `categoryId`, for expanding category filters. */
    async descendantIds(tx: TenantTx, categoryId: string): Promise<string[]> {
      return (await categoriesUnderPath(tx, { categoryId })).map((row) => row.categoryid);
    },

    /** categoryManager.makeFilenameUnique's check: whether another category of the site already uses `filename`. */
    async filenameInUse(tx: TenantTx, args: { categoryId: string; filename: string; siteId: string }): Promise<boolean> {
      const p = new SqlParams(1);
      const rows = await select<{ categoryid: string }>(
        tx,
        [CATEGORY],
        `SELECT categoryid FROM ${name(CATEGORY)} WHERE tenant_id = $1 AND NOT (${idEq(p, 'categoryid', args.categoryId)})` +
          ` AND ${ciEq(p, 'filename', args.filename)} AND siteid = ${p.add(args.siteId)} LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows.length > 0;
    },
  };


  // ---- change sets ----

  /** changesetCategoryAssignment saves: replaces a change set's categories with one row per distinct category. */
  async function replaceChangesetCategories(
    tx: TenantTx,
    args: { changesetId: string; siteId: string; categoryIds: readonly string[] },
    ctx?: WriteContext,
  ): Promise<ChangesetCategoryAssignRow[]> {
    await deleteWhere(tx, CHANGESET_CATEGORY_ASSIGN, (p) => idEq(p, 'changesetid', args.changesetId), ctx);
    return insertEach<ChangesetCategoryAssignRow>(
      tx,
      CHANGESET_CATEGORY_ASSIGN,
      distinctNoCase(args.categoryIds).map((categoryid) => ({ assignmentid: cfUuid(), changesetid: args.changesetId, siteid: args.siteId, categoryid })),
      ctx,
    );
  }

  /** changesetTagAssignment saves: replaces a change set's tags with one row per distinct tag. */
  async function replaceChangesetTags(
    tx: TenantTx,
    args: { changesetId: string; siteId: string; tags: readonly string[] },
    ctx?: WriteContext,
  ): Promise<ChangesetTagAssignRow[]> {
    await deleteWhere(tx, CHANGESET_TAG_ASSIGN, (p) => idEq(p, 'changesetid', args.changesetId), ctx);
    return insertEach<ChangesetTagAssignRow>(
      tx,
      CHANGESET_TAG_ASSIGN,
      distinctNoCase(args.tags).map((tag) => ({ assignmentid: cfUuid(), changesetid: args.changesetId, siteid: args.siteId, tag })),
      ctx,
    );
  }

  /** The assignment rewrite that closes changesetManager.save. */
  async function writeChangesetAssignments(tx: TenantTx, row: ChangesetRow, assignments: ChangesetAssignmentsInput, ctx: Ctx): Promise<void> {
    const key = { changesetId: row.changesetid, siteId: row.siteid ?? '' };
    await replaceChangesetCategories(tx, { ...key, categoryIds: assignments.categoryIds ?? [] }, ctx);
    await replaceChangesetTags(tx, { ...key, tags: assignments.tags ?? [] }, ctx);
  }

  /** Columns of the change sets one lookup selects. */
  function changesetWhere(p: SqlParams, lookup: ChangesetLookup): string {
    if ('changesetId' in lookup) {
      return idEq(p, 'changesetid', lookup.changesetId);
    }
    const [column, value]: [string, string] = 'name' in lookup ? ['name', lookup.name] : ['remoteid', lookup.remoteId];
    return `${ciEq(p, column, value)} AND siteid = ${p.add(lookup.siteId)}`;
  }

  /** changesetManager.getQuery's SELECT; its tag filter reads from `fromt tchangesettagassign`, which fails, so a tag filter throws here too. */
  function changesetListSelect(tx: TenantTx, args: ChangesetQueryArgs): BuiltSelect {
    if (args.tag !== undefined && args.tag !== '') {
      throw new ContentQueryError("Incorrect syntax near 'tchangesettagassign'");
    }
    const p = new SqlParams(1);
    const filters = [`tenant_id = $1`, `siteid = ${p.add(args.siteId)}`];
    if (args.published !== undefined && Number.isFinite(args.published)) filters.push(`published = ${p.add(Math.trunc(args.published))}`);
    if (args.publishDate !== undefined) {
      filters.push(`(publishdate > ${p.add(args.publishDate)}${args.publishDateOnly === false ? ' OR publishdate IS NULL' : ''})`);
    }
    if (args.openOnly === true) filters.push(`(closedate > ${p.add(clock.now())} OR closedate IS NULL)`);
    if (args.keywords !== undefined && args.keywords !== '') {
      filters.push(`(${ciLike(p, 'name', `%${args.keywords}%`)} OR ${ciLike(p, 'description', `%${args.keywords}%`)})`);
    }
    const order =
      args.sortBy !== undefined && args.sortBy.toLowerCase() === 'publishdate'
        ? `${orderKey('publishdate', 'desc')}, ${orderKey('lower(name)', 'asc')}`
        : `${orderKey('published', 'asc')}, ${orderKey('lower(name)', 'asc')}`;
    return {
      select:
        'SELECT changesetid, siteid, name, description, created, publishdate, published, lastupdate, lastupdateby, remoteid, remotepubdate, remotesourceurl' +
        ` FROM ${name(CHANGESET)} WHERE ${filters.join(' AND ')}`,
      order: `ORDER BY ${order}, changesetid`,
      values: [tx.tenantId, ...p.values],
    };
  }

  const changesets = {
    /** changesetManager.save of a new change set: stamps `created` and `lastupdate`, then writes the assignments. */
    async insertChangeset(tx: TenantTx, row: ChangesetInput, assignments: ChangesetAssignmentsInput = {}, ctx?: WriteContext): Promise<ChangesetRow> {
      const now = clock.now();
      const stored = await platform.insert<ChangesetRow>(
        tx,
        CHANGESET.table,
        changesetStorage({ ...row, changesetid: row.changesetid ?? cfUuid(), created: now, lastupdate: now }),
        ctx,
      );
      await writeChangesetAssignments(tx, stored, assignments, ctx);
      return stored;
    },

    /** changesetManager.save of an existing change set: the columns with `lastupdate` stamped, then the assignment rewrite. */
    async updateChangeset(
      tx: TenantTx,
      changesetId: string,
      changes: Omit<ChangesetInput, 'changesetid' | 'siteid'> & { siteid?: string },
      assignments: ChangesetAssignmentsInput = {},
      ctx?: WriteContext,
    ): Promise<ChangesetRow | null> {
      const [updated] = await updateWhere<ChangesetRow>(
        tx,
        CHANGESET,
        (p) => idEq(p, 'changesetid', changesetId),
        changesetStorage({ ...changes, lastupdate: clock.now() }),
        ctx,
      );
      if (updated === undefined) {
        return null;
      }
      await writeChangesetAssignments(tx, updated, assignments, ctx);
      return updated;
    },

    /** changesetManager.delete: the change set and its category and tag assignments. */
    async deleteChangeset(tx: TenantTx, args: { changesetId: string }, ctx?: WriteContext): Promise<ChangesetRow | null> {
      const [removed] = await deleteWhere<ChangesetRow>(tx, CHANGESET, (p) => idEq(p, 'changesetid', args.changesetId), ctx);
      await deleteWhere(tx, CHANGESET_CATEGORY_ASSIGN, (p) => idEq(p, 'changesetid', args.changesetId), ctx);
      await deleteWhere(tx, CHANGESET_TAG_ASSIGN, (p) => idEq(p, 'changesetid', args.changesetId), ctx);
      return removed ?? null;
    },

    /** changesetManager.publish: `published = 1` and the publish date set to now, stored to the minute. */
    async markPublished(tx: TenantTx, args: { changesetId: string }, ctx?: WriteContext): Promise<ChangesetRow | null> {
      const now = clock.now();
      const [updated] = await updateWhere<ChangesetRow>(
        tx,
        CHANGESET,
        (p) => idEq(p, 'changesetid', args.changesetId),
        { published: 1, publishdate: toMinute(now), lastupdate: now },
        ctx,
      );
      return updated ?? null;
    },

    /** changesetRollBack.loadBy(…).save(): records the version a publish replaced, once per change set, version pair and site. */
    async insertRollback(tx: TenantTx, row: Omit<ChangesetRollbackRow, 'tenant_id' | 'rollbackid'>, ctx?: WriteContext): Promise<ChangesetRollbackRow> {
      const p = new SqlParams(1);
      const [existing] = await select<ChangesetRollbackRow>(
        tx,
        [CHANGESET_ROLLBACK],
        `SELECT * FROM ${name(CHANGESET_ROLLBACK)} WHERE tenant_id = $1 AND ${idEq(p, 'changesethistid', row.changesethistid ?? '')}` +
          ` AND ${idEq(p, 'changesetid', row.changesetid ?? '')} AND ${idEq(p, 'previoushistid', row.previoushistid ?? '')}` +
          ` AND siteid = ${p.add(row.siteid ?? '')} ORDER BY rollbackid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      if (existing !== undefined) {
        return existing;
      }
      return platform.insert<ChangesetRollbackRow>(tx, CHANGESET_ROLLBACK.table, ormStorage({ ...row, rollbackid: cfUuid() }), ctx);
    },

    replaceCategoryAssignments: replaceChangesetCategories,
    replaceTagAssignments: replaceChangesetTags,

    /** changesetManager.removeItem: detaches one version from the change set. */
    removeItem(tx: TenantTx, args: { changesetId: string; contentHistId: string }, ctx?: WriteContext): Promise<ContentRow[]> {
      return updateVersions(tx, { changesetId: args.changesetId, contentHistIds: [args.contentHistId] }, { changesetid: null }, ctx);
    },

    /** changesetManager.read: by id, or within a site by name or remote id; null when none matches. */
    async findChangeset(tx: TenantTx, lookup: ChangesetLookup): Promise<ChangesetRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ChangesetRow>(
        tx,
        [CHANGESET],
        `SELECT * FROM ${name(CHANGESET)} WHERE tenant_id = $1 AND ${changesetWhere(p, lookup)} ORDER BY changesetid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** changesetManager.getQuery; its tag filter reads from `fromt tchangesettagassign`, which fails, so a tag filter fails here too. */
    async changesetQuery(tx: TenantTx, args: ChangesetQueryArgs): Promise<ChangesetListRow[]> {
      const built = changesetListSelect(tx, args);
      return select<ChangesetListRow>(tx, [CHANGESET], `${built.select} ${built.order}`, built.values);
    },

    /** changesetManager.getQuery, one page in its order with the count of all its rows. */
    async changesetQueryPage(tx: TenantTx, args: ChangesetQueryArgs, page: RowPage): Promise<PagedRows<ChangesetListRow>> {
      return selectPage<ChangesetListRow>(tx, [CHANGESET], changesetListSelect(tx, args), page);
    },

    /** changesetManager.getQuery, every row in its order, `batchSize` rows per batch. */
    async *changesetQueryBatches(tx: TenantTx, args: ChangesetQueryArgs, batchSize?: number): AsyncGenerator<ChangesetListRow[], void, undefined> {
      yield* selectBatches<ChangesetListRow>(tx, [CHANGESET], changesetListSelect(tx, args), batchSize);
    },

    /** changesetManager.getPendingByContentID: the unpublished change sets holding a version of the item. */
    pendingByContentId(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<ChangesetPendingRow[]> {
      const p = new SqlParams(1);
      return select<ChangesetPendingRow>(
        tx,
        [CONTENT, CHANGESET, APPROVAL_REQUEST],
        'SELECT s.changesetid, c.contentid, c.contenthistid, c.siteid, c.menutitle, s.name AS changesetname, r.status AS approvalstatus, r.requestid,' +
          ' c.lastupdate, c.lastupdateby, r.groupid AS approvalgroupid, s.publishdate, s.closedate' +
          ` FROM ${name(CONTENT)} c INNER JOIN ${name(CHANGESET)} s ON (s.tenant_id = c.tenant_id AND c.changesetid = s.changesetid)` +
          ` LEFT JOIN ${name(APPROVAL_REQUEST)} r ON (r.tenant_id = c.tenant_id AND c.contenthistid = r.contenthistid)` +
          ` WHERE c.tenant_id = $1 AND c.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'c.contentid', args.contentId)} AND s.published = 0` +
          ' ORDER BY c.contenthistid, r.requestid',
        [tx.tenantId, ...p.values],
      );
    },

    /** changesetManager.getAssignmentsQuery: the versions assigned to a change set, by menu title. */
    assignmentsQuery(tx: TenantTx, args: { changesetId: string; keywords?: string; moduleId?: string }): Promise<ChangesetAssignmentRow[]> {
      const p = new SqlParams(1);
      const filters = [`c.tenant_id = $1`, idEq(p, 'c.changesetid', args.changesetId)];
      if (args.keywords !== undefined && args.keywords !== '') {
        const like = `%${args.keywords}%`;
        filters.push(`(${ciLike(p, 'c.title', like)} OR ${ciLike(p, 'c.menutitle', like)} OR ${ciLike(p, 'c.summary', like)} OR ${ciLike(p, 'c.body', like)})`);
      }
      if (args.moduleId !== undefined && args.moduleId !== '') filters.push(idEq(p, 'c.moduleid', args.moduleId));
      return select<ChangesetAssignmentRow>(
        tx,
        [CONTENT, APPROVAL_REQUEST],
        'SELECT c.menutitle, c.siteid, c.parentid, c.path, c.contentid, c.contenthistid, c.fileid, c.type, c.subtype, c.lastupdateby, c.active,' +
          ' c.approved, c.lastupdate, c.lastupdatebyid, c.display, c.displaystart, c.displaystop, c.moduleid, c.isnav, c.notes, c.isfeature,' +
          ' c.inheritobjects, c.filename, c.targetparams, c.releasedate, c.changesetid, c.title, r.status AS approvalstatus, r.requestid,' +
          ` c.remoteid, c.remoteurl, c.urltitle FROM ${name(CONTENT)} c` +
          ` LEFT JOIN ${name(APPROVAL_REQUEST)} r ON (r.tenant_id = c.tenant_id AND c.contenthistid = r.contenthistid)` +
          ` WHERE ${filters.join(' AND ')} ORDER BY ${orderKey('lower(c.menutitle)', 'asc')}, c.contenthistid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** changesetManager.hasPendingApprovals: the change set's versions whose approval request is not Approved. */
    async hasPendingApprovals(tx: TenantTx, args: { changesetId: string }): Promise<number> {
      const p = new SqlParams(1);
      const rows = await select<{ pending: number }>(
        tx,
        [CONTENT, APPROVAL_REQUEST],
        `SELECT count(*)::integer AS pending FROM ${name(CONTENT)} c` +
          ` INNER JOIN ${name(APPROVAL_REQUEST)} r ON (r.tenant_id = c.tenant_id AND c.contenthistid = r.contenthistid)` +
          ` WHERE c.tenant_id = $1 AND ${idEq(p, 'c.changesetid', args.changesetId)} AND lower(rtrim(r.status)) <> 'approved'`,
        [tx.tenantId, ...p.values],
      );
      return rows[0]?.pending ?? 0;
    },

    /** changesetBean.rollback's iterator: the versions a published change set replaced. */
    rollbackRows(tx: TenantTx, args: { changesetId: string; siteId: string }): Promise<ChangesetRollbackRow[]> {
      const p = new SqlParams(1);
      return select<ChangesetRollbackRow>(
        tx,
        [CHANGESET_ROLLBACK],
        `SELECT * FROM ${name(CHANGESET_ROLLBACK)} WHERE tenant_id = $1 AND ${idEq(p, 'changesetid', args.changesetId)}` +
          ` AND siteid = ${p.add(args.siteId)} ORDER BY rollbackid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The category ids assigned to a change set. */
    async assignedCategoryIds(tx: TenantTx, args: { changesetId: string }): Promise<string[]> {
      const p = new SqlParams(1);
      const rows = await select<{ categoryid: string }>(
        tx,
        [CHANGESET_CATEGORY_ASSIGN],
        `SELECT categoryid FROM ${name(CHANGESET_CATEGORY_ASSIGN)} WHERE tenant_id = $1 AND ${idEq(p, 'changesetid', args.changesetId)}` +
          ' AND categoryid IS NOT NULL ORDER BY categoryid',
        [tx.tenantId, ...p.values],
      );
      return rows.map((row) => row.categoryid);
    },

    /** The tags assigned to a change set. */
    async assignedTags(tx: TenantTx, args: { changesetId: string }): Promise<string[]> {
      const p = new SqlParams(1);
      const rows = await select<{ tag: string }>(
        tx,
        [CHANGESET_TAG_ASSIGN],
        `SELECT tag FROM ${name(CHANGESET_TAG_ASSIGN)} WHERE tenant_id = $1 AND ${idEq(p, 'changesetid', args.changesetId)}` +
          ` AND tag IS NOT NULL ORDER BY ${orderKey('lower(tag)', 'asc')}, tag`,
        [tx.tenantId, ...p.values],
      );
      return rows.map((row) => row.tag);
    },

    /** changesetManager.getTagCloud: every change-set tag of the tenant with its count, unscoped by site as legacy's is. */
    changesetTagCloud(tx: TenantTx): Promise<{ tag: string | null; tagcount: number }[]> {
      return select(
        tx,
        [CHANGESET_TAG_ASSIGN],
        `SELECT tag, count(tag)::integer AS tagcount FROM ${name(CHANGESET_TAG_ASSIGN)} WHERE tenant_id = $1 GROUP BY tag ORDER BY ${orderKey('lower(tag)', 'asc')}`,
        [tx.tenantId],
      );
    },

    /** changesetManager.publishBySchedule's select: unpublished change sets due by `now`, earliest first. */
    async pendingScheduledChangesets(tx: TenantTx, now: Date): Promise<string[]> {
      const rows = await select<{ changesetid: string }>(
        tx,
        [CHANGESET],
        `SELECT changesetid FROM ${name(CHANGESET)} WHERE tenant_id = $1 AND published = 0 AND publishdate IS NOT NULL` +
          ' AND publishdate <= $2 ORDER BY publishdate ASC, changesetid',
        [tx.tenantId, now],
      );
      return rows.map((row) => row.changesetid);
    },
  };

  // ---- approvals ----

  /** approvalRequest.delete for each request: the actions of all of them under one lock first (cascade="delete"), then the requests. */
  async function deleteRequestRows(tx: TenantTx, requests: readonly ApprovalRequestRow[], ctx: Ctx): Promise<ApprovalRequestRow[]> {
    const requestIds = requests.map((request) => request.requestid);
    if (requestIds.length > 0) {
      const actions = await lockRows<ApprovalActionRow>(tx, APPROVAL_ACTION, (p) => idIn(p, 'requestid', requestIds), ctx);
      await deleteEach(tx, APPROVAL_ACTION, inIdOrder(actions, requestIds, (row) => row.requestid), ctx);
    }
    return deleteEach(tx, APPROVAL_REQUEST, requests, ctx);
  }

  const approvals = {
    /** approvalChainBean.save of a new chain: `created` defaults to now and `lastupdate` is stamped. */
    insertChain(tx: TenantTx, row: ApprovalChainInput, ctx?: WriteContext): Promise<ApprovalChainRow> {
      const now = clock.now();
      return platform.insert<ApprovalChainRow>(
        tx,
        APPROVAL_CHAIN.table,
        ormStorage({ ...row, chainid: row.chainid ?? cfUuid(), created: row.created ?? now, lastupdate: now }),
        ctx,
      );
    },

    /** approvalChainBean.save of an existing chain, `lastupdate` stamped. */
    async updateChain(tx: TenantTx, chainId: string, changes: Patch<ApprovalChainRow, 'chainid' | 'lastupdate'>, ctx?: WriteContext): Promise<ApprovalChainRow | null> {
      const [updated] = await updateWhere<ApprovalChainRow>(
        tx,
        APPROVAL_CHAIN,
        (p) => idEq(p, 'chainid', chainId),
        ormStorage({ ...changes, lastupdate: clock.now() }),
        ctx,
      );
      return updated ?? null;
    },

    /** approvalChainBean.delete: its memberships and its requests with their actions (cascade="delete"), then the chain. */
    async deleteChain(tx: TenantTx, args: { chainId: string }, ctx?: WriteContext): Promise<ApprovalChainRow | null> {
      await deleteWhere(tx, APPROVAL_MEMBERSHIP, (p) => idEq(p, 'chainid', args.chainId), ctx);
      await deleteRequestRows(tx, await lockRows<ApprovalRequestRow>(tx, APPROVAL_REQUEST, (p) => idEq(p, 'chainid', args.chainId), ctx), ctx);
      const [removed] = await deleteWhere<ApprovalChainRow>(tx, APPROVAL_CHAIN, (p) => idEq(p, 'chainid', args.chainId), ctx);
      return removed ?? null;
    },

    /**
     * approvalChainBean.save's `groupID` handling: orders the listed groups' memberships, removes the unlisted ones, then
     * moves the chain's requests to the first group.
     */
    async replaceChainMemberships(
      tx: TenantTx,
      chainId: string,
      groupIds: readonly string[],
      ctx?: WriteContext,
    ): Promise<{ memberships: ApprovalMembershipRow[]; removed: ApprovalMembershipRow[] }> {
      const current = await lockRows<ApprovalMembershipRow>(tx, APPROVAL_MEMBERSHIP, (p) => idEq(p, 'chainid', chainId), ctx);
      const listed = groupIds.filter((groupId) => groupId !== '');
      const listedLower = new Set(listed.map((groupId) => groupId.toLowerCase()));
      const unlisted = current.filter((membership) => !listedLower.has((membership.groupid ?? '').toLowerCase()));
      const known = [...current];
      const memberships: ApprovalMembershipRow[] = [];
      for (const [index, groupId] of listed.entries()) {
        const existing = known.find((membership) => (membership.groupid ?? '').toLowerCase() === groupId.toLowerCase());
        const saved =
          existing !== undefined
            ? ((await platform.update<ApprovalMembershipRow>(tx, APPROVAL_MEMBERSHIP.table, keyOf(APPROVAL_MEMBERSHIP, existing), { orderno: index + 1 }, ctx)) ??
              existing)
            : await platform.insert<ApprovalMembershipRow>(
                tx,
                APPROVAL_MEMBERSHIP.table,
                { membershipid: cfUuid(), chainid: chainId, groupid: groupId, orderno: index + 1, created: clock.now() },
                ctx,
              );
        if (existing === undefined) {
          known.push(saved);
        }
        memberships.push(saved);
      }
      const removed = await deleteEach(tx, APPROVAL_MEMBERSHIP, unlisted, ctx);
      const firstId = listed[0] ?? '';
      // Legacy binds the whole group list as one value, so `groupID not in (:groupID)` compares each request with the joined list.
      const joined = groupIds.join(',');
      await updateWhere(
        tx,
        APPROVAL_REQUEST,
        (p) => `${idEq(p, 'chainid', chainId)} AND groupid IS NOT NULL AND lower(rtrim(groupid)) <> lower(rtrim(${p.add(joined)}::text))`,
        { groupid: firstId },
        ctx,
      );
      await updateWhere(tx, APPROVAL_REQUEST, (p) => `${idEq(p, 'chainid', chainId)} AND (groupid IS NULL OR rtrim(groupid) = '')`, { groupid: firstId }, ctx);
      return { memberships, removed };
    },

    /** approvalChainAssignmentBean.save. */
    upsertAssignment(tx: TenantTx, row: ApprovalAssignmentInput, ctx?: WriteContext): Promise<ApprovalAssignmentRow> {
      return platform.upsert<ApprovalAssignmentRow>(tx, APPROVAL_ASSIGNMENT.table, ormStorage({ ...row, assignmentid: row.assignmentid ?? cfUuid() }), ctx);
    },

    /** approvalChainAssignmentBean.delete. */
    deleteAssignment(tx: TenantTx, args: { assignmentId: string }, ctx?: WriteContext): Promise<ApprovalAssignmentRow | null> {
      return platform.delete<ApprovalAssignmentRow>(tx, APPROVAL_ASSIGNMENT.table, { assignmentid: args.assignmentId }, ctx);
    },

    /** approvalRequestBean.save of a new request. */
    insertRequest(tx: TenantTx, row: ApprovalRequestInput, ctx?: WriteContext): Promise<ApprovalRequestRow> {
      return platform.insert<ApprovalRequestRow>(
        tx,
        APPROVAL_REQUEST.table,
        ormStorage({ ...row, requestid: row.requestid ?? cfUuid(), status: row.status ?? 'Pending', created: row.created ?? clock.now() }),
        ctx,
      );
    },

    /** approvalRequestBean.save of an existing request, such as its status, group or version. */
    async updateRequest(tx: TenantTx, requestId: string, changes: Patch<ApprovalRequestRow, 'requestid'>, ctx?: WriteContext): Promise<ApprovalRequestRow | null> {
      const [updated] = await updateWhere<ApprovalRequestRow>(tx, APPROVAL_REQUEST, (p) => idEq(p, 'requestid', requestId), ormStorage(changes), ctx);
      return updated ?? null;
    },

    /** approvalRequestBean.delete: its actions, then the request. */
    async deleteRequest(tx: TenantTx, args: { requestId: string }, ctx?: WriteContext): Promise<ApprovalRequestRow | null> {
      const requests = await lockRows<ApprovalRequestRow>(tx, APPROVAL_REQUEST, (p) => idEq(p, 'requestid', args.requestId), ctx);
      const [removed] = await deleteRequestRows(tx, requests, ctx);
      return removed ?? null;
    },

    /** approvalActionBean.save of a new action. */
    insertAction(tx: TenantTx, row: ApprovalActionInput, ctx?: WriteContext): Promise<ApprovalActionRow> {
      return platform.insert<ApprovalActionRow>(
        tx,
        APPROVAL_ACTION.table,
        ormStorage({ ...row, actiontid: row.actiontid ?? cfUuid(), created: row.created ?? clock.now() }),
        ctx,
      );
    },

    /** The approval chains of a site, by name. */
    listChains(tx: TenantTx, args: { siteId: string }): Promise<ApprovalChainRow[]> {
      return select<ApprovalChainRow>(
        tx,
        [APPROVAL_CHAIN],
        `SELECT * FROM ${name(APPROVAL_CHAIN)} WHERE tenant_id = $1 AND siteid = $2 ORDER BY ${orderKey('lower(name)', 'asc')}, chainid`,
        [tx.tenantId, args.siteId],
      );
    },

    /** One approval chain, or null. */
    async findChain(tx: TenantTx, args: { chainId: string }): Promise<ApprovalChainRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ApprovalChainRow>(
        tx,
        [APPROVAL_CHAIN],
        `SELECT * FROM ${name(APPROVAL_CHAIN)} WHERE tenant_id = $1 AND ${idEq(p, 'chainid', args.chainId)} ORDER BY chainid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** approvalChainBean memberships (`orderby="orderno asc"`); group names come from `projections.groupNames`. */
    chainMemberships(tx: TenantTx, args: { chainId: string }): Promise<ApprovalMembershipRow[]> {
      const p = new SqlParams(1);
      return select<ApprovalMembershipRow>(
        tx,
        [APPROVAL_MEMBERSHIP],
        `SELECT * FROM ${name(APPROVAL_MEMBERSHIP)} WHERE tenant_id = $1 AND ${idEq(p, 'chainid', args.chainId)}` +
          ` ORDER BY ${orderKey('orderno', 'asc')}, membershipid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The chain assignment of a content node, or null. */
    async assignmentFor(tx: TenantTx, args: { contentId: string; siteId?: string }): Promise<ApprovalAssignmentRow | null> {
      const p = new SqlParams(1);
      const site = args.siteId !== undefined ? ` AND siteid = ${p.add(args.siteId)}` : '';
      const rows = await select<ApprovalAssignmentRow>(
        tx,
        [APPROVAL_ASSIGNMENT],
        `SELECT * FROM ${name(APPROVAL_ASSIGNMENT)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)}${site} ORDER BY assignmentid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** approvalRequest.loadBy(contenthistid): the earliest request of a version, or null. */
    async requestForVersion(tx: TenantTx, args: { contentHistId: string }): Promise<ApprovalRequestRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ApprovalRequestRow>(
        tx,
        [APPROVAL_REQUEST],
        `SELECT * FROM ${name(APPROVAL_REQUEST)} WHERE tenant_id = $1 AND ${idEq(p, 'contenthistid', args.contentHistId)}` +
          ` ORDER BY ${orderKey('created', 'asc')}, requestid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** The requests in one status, optionally of one site, chain or group, by creation (`orderby="created asc"`). */
    requestsByStatus(tx: TenantTx, filter: ApprovalRequestFilter): Promise<ApprovalRequestRow[]> {
      const p = new SqlParams(1);
      const filters = [`tenant_id = $1`, ciEq(p, 'status', filter.status)];
      if (filter.siteId !== undefined) filters.push(`siteid = ${p.add(filter.siteId)}`);
      if (filter.chainId !== undefined) filters.push(idEq(p, 'chainid', filter.chainId));
      if (filter.groupId !== undefined) filters.push(idEq(p, 'groupid', filter.groupId));
      return select<ApprovalRequestRow>(
        tx,
        [APPROVAL_REQUEST],
        `SELECT * FROM ${name(APPROVAL_REQUEST)} WHERE ${filters.join(' AND ')} ORDER BY ${orderKey('created', 'asc')}, requestid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** approvalRequestBean actions (`orderby="created asc"`). */
    actionsForRequest(tx: TenantTx, args: { requestId: string }): Promise<ApprovalActionRow[]> {
      const p = new SqlParams(1);
      return select<ApprovalActionRow>(
        tx,
        [APPROVAL_ACTION],
        `SELECT * FROM ${name(APPROVAL_ACTION)} WHERE tenant_id = $1 AND ${idEq(p, 'requestid', args.requestId)}` +
          ` ORDER BY ${orderKey('created', 'asc')}, actiontid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** approvalRequest.loadBy(requestID): one request, or null. */
    async findRequest(tx: TenantTx, args: { requestId: string }): Promise<ApprovalRequestRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ApprovalRequestRow>(
        tx,
        [APPROVAL_REQUEST],
        `SELECT * FROM ${name(APPROVAL_REQUEST)} WHERE tenant_id = $1 AND ${idEq(p, 'requestid', args.requestId)} ORDER BY requestid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** approvalRequest.loadBy(contenthistid, chainID, siteID) (contentBean.getApprovalRequest): the earliest match, or null. */
    async requestFor(tx: TenantTx, args: { contentHistId: string; chainId: string; siteId: string }): Promise<ApprovalRequestRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ApprovalRequestRow>(
        tx,
        [APPROVAL_REQUEST],
        `SELECT * FROM ${name(APPROVAL_REQUEST)} WHERE tenant_id = $1 AND ${idEq(p, 'contenthistid', args.contentHistId)}` +
          ` AND ${idEq(p, 'chainid', args.chainId)} AND siteid = ${p.add(args.siteId)}` +
          ` ORDER BY ${orderKey('created', 'asc')}, requestid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** contentManager.add `rsApprovalsCancel`: the requests of an item's versions in change set `changesetId`. */
    requestsOfChangesetVersions(
      tx: TenantTx,
      args: { contentId: string; changesetId: string; siteId: string },
    ): Promise<Array<{ contenthistid: string; requestid: string }>> {
      const p = new SqlParams(1);
      return select<{ contenthistid: string; requestid: string }>(
        tx,
        [CONTENT, APPROVAL_REQUEST],
        `SELECT c.contenthistid, r.requestid FROM ${name(CONTENT)} c` +
          ` INNER JOIN ${name(APPROVAL_REQUEST)} r ON (r.tenant_id = c.tenant_id AND c.contenthistid = r.contenthistid)` +
          ` WHERE c.tenant_id = $1 AND ${idEq(p, 'c.contentid', args.contentId)} AND ${idEq(p, 'c.changesetid', args.changesetId)}` +
          ` AND c.siteid = ${p.add(args.siteId)} ORDER BY c.tcontent_id, r.requestid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** approvalAction.loadBy(requestID, groupID): the earliest action of a request's group, or null. */
    async actionFor(tx: TenantTx, args: { requestId: string; groupId: string }): Promise<ApprovalActionRow | null> {
      const p = new SqlParams(1);
      const rows = await select<ApprovalActionRow>(
        tx,
        [APPROVAL_ACTION],
        `SELECT * FROM ${name(APPROVAL_ACTION)} WHERE tenant_id = $1 AND ${idEq(p, 'requestid', args.requestId)}` +
          ` AND ${idEq(p, 'groupid', args.groupId)} ORDER BY ${orderKey('created', 'asc')}, actiontid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** approvalActionBean.save of an existing action. */
    async updateAction(tx: TenantTx, actionId: string, changes: Patch<ApprovalActionRow, 'actiontid'>, ctx?: WriteContext): Promise<ApprovalActionRow | null> {
      const [updated] = await updateWhere<ApprovalActionRow>(tx, APPROVAL_ACTION, (p) => idEq(p, 'actiontid', actionId), ormStorage(changes), ctx);
      return updated ?? null;
    },
  };


  // ---- forms ----

  /** dataCollectionManager.update's inserts: each question, its field name and poll value cut to 255 characters, then the packet. */
  async function insertFormResponse(tx: TenantTx, input: FormResponseInput, ctx: Ctx): Promise<FormResponseWrite> {
    const responseid = input.responseid ?? cfUuid();
    const questions = await insertEach<FormResponseQuestionRow>(
      tx,
      FORM_RESPONSE_QUESTION,
      input.questions.map((question) => ({
        responseid,
        formid: input.formid,
        formfield: question.formfield.slice(0, 255),
        formvalue: question.formvalue,
        pollvalue: question.pollvalue !== undefined ? question.pollvalue : question.formvalue === null ? null : question.formvalue.slice(0, 255),
      })),
      ctx,
    );
    const packet = await platform.insert<FormResponsePacketRow>(
      tx,
      FORM_RESPONSE_PACKET.table,
      { responseid, formid: input.formid, siteid: input.siteid, entered: input.entered, data: input.data, fieldlist: input.fieldlist },
      ctx,
    );
    return { packet, questions };
  }

  /** dataCollectionManager.delete: the questions, then the packet, with the attachment file ids `deleteFiles` marks deleted. */
  async function deleteFormResponse(tx: TenantTx, args: { responseId: string }, ctx: Ctx): Promise<FormResponseDeletion> {
    const questions = await deleteWhere<FormResponseQuestionRow>(tx, FORM_RESPONSE_QUESTION, (p) => idEq(p, 'responseid', args.responseId), ctx);
    const [packet] = await deleteWhere<FormResponsePacketRow>(tx, FORM_RESPONSE_PACKET, (p) => idEq(p, 'responseid', args.responseId), ctx);
    const attachmentFileIds = questions.flatMap((question) =>
      /attachment/i.test(question.formfield) && question.formvalue !== null && isCfUuid(question.formvalue) ? [question.formvalue] : [],
    );
    return { packet: packet ?? null, questions, attachmentFileIds };
  }

  /** dataCollectionManager.getFullFieldList: every field name answered on the form, as a CF list. */
  async function fullFieldList(tx: TenantTx, args: { formId: string }): Promise<string> {
    const p = new SqlParams(1);
    const rows = await select<{ formfield: string }>(
      tx,
      [FORM_RESPONSE_QUESTION],
      `SELECT DISTINCT formfield, lower(formfield) AS sortkey FROM ${name(FORM_RESPONSE_QUESTION)} WHERE tenant_id = $1` +
        ` AND ${idEq(p, 'formid', args.formId)} ORDER BY sortkey ASC, formfield`,
      [tx.tenantId, ...p.values],
    );
    return rows.map((row) => row.formfield).join(',');
  }

  /** dataCollectionManager.getData's SELECT. */
  function formResponseSelect(tx: TenantTx, args: FormResponsesArgs): BuiltSelect {
    const p = new SqlParams(1);
    const fieldNames = args.fieldNames ?? [];
    const sortBy = args.sortBy ?? '';
    const keywords = args.keywords ?? '';
    const byEntered = sortBy.toLowerCase() === 'entered';
    // listFind, as legacy uses it here, is case-sensitive.
    const byField = sortBy !== '' && !byEntered && fieldNames.includes(sortBy);
    const joins: string[] = [];
    const filters = [`r.tenant_id = $1`, `r.siteid = ${p.add(args.siteId)}`, idEq(p, 'r.formid', args.formId)];
    if (byField) {
      joins.push(`LEFT JOIN ${name(FORM_RESPONSE_QUESTION)} e ON (e.tenant_id = r.tenant_id AND r.responseid = e.responseid)`);
      filters.push(ciEq(p, 'e.formfield', sortBy));
    }
    if (args.start !== undefined) filters.push(`r.entered >= ${p.add(args.start)}`);
    if (args.stop !== undefined) filters.push(`r.entered <= ${p.add(args.stop)}`);
    if (keywords !== '') {
      joins.push(`LEFT JOIN ${name(FORM_RESPONSE_QUESTION)} k ON (k.tenant_id = r.tenant_id AND r.responseid = k.responseid)`);
      filters.push(ciLike(p, 'k.pollvalue', keywords));
      if (args.filterBy !== undefined && args.filterBy !== '' && fieldNames.includes(args.filterBy)) {
        filters.push(ciEq(p, 'k.formfield', args.filterBy));
      }
    }
    const order = byEntered
      ? orderKey('r.entered', sqlDirection(args.sortDirection ?? 'asc'))
      : byField
        ? orderKey('lower(e.pollvalue)', sqlDirection(args.sortDirection ?? 'asc'))
        : orderKey('r.entered', 'asc');
    return {
      select: `SELECT r.* FROM ${name(FORM_RESPONSE_PACKET)} r ${joins.join(' ')} WHERE ${filters.join(' AND ')}`,
      order: `ORDER BY ${order}, r.responseid`,
      values: [tx.tenantId, ...p.values],
    };
  }

  const forms = {
    /** dataCollectionManager.update of a new submission. */
    insertResponse(tx: TenantTx, input: FormResponseInput, ctx?: WriteContext): Promise<FormResponseWrite> {
      return insertFormResponse(tx, input, ctx);
    },

    /** dataCollectionManager.update of an existing submission: removes it without its files, then writes it under the same id. */
    async updateResponse(tx: TenantTx, input: FormResponseInput & { responseid: string }, ctx?: WriteContext): Promise<FormResponseWrite> {
      await deleteFormResponse(tx, { responseId: input.responseid }, ctx);
      return insertFormResponse(tx, input, ctx);
    },

    /** dataCollectionManager.delete. */
    deleteResponse(tx: TenantTx, args: { responseId: string }, ctx?: WriteContext): Promise<FormResponseDeletion> {
      return deleteFormResponse(tx, args, ctx);
    },

    /** dataCollectionManager.read: one submission packet, or null. */
    async readResponse(tx: TenantTx, args: { responseId: string }): Promise<FormResponsePacketRow | null> {
      const p = new SqlParams(1);
      const rows = await select<FormResponsePacketRow>(
        tx,
        [FORM_RESPONSE_PACKET],
        `SELECT * FROM ${name(FORM_RESPONSE_PACKET)} WHERE tenant_id = $1 AND ${idEq(p, 'responseid', args.responseId)} LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** dataCollectionManager.getData: a form's packets, filtered by date and an unwildcarded poll-value LIKE, sorted by date or one field. */
    responses(tx: TenantTx, args: FormResponsesArgs): Promise<FormResponsePacketRow[]> {
      const built = formResponseSelect(tx, args);
      return select<FormResponsePacketRow>(tx, [FORM_RESPONSE_PACKET, FORM_RESPONSE_QUESTION], `${built.select} ${built.order}`, built.values);
    },

    /** dataCollectionManager.getData, one page in its order with the count of all its rows. */
    async responsesPage(tx: TenantTx, args: FormResponsesArgs, page: RowPage): Promise<PagedRows<FormResponsePacketRow>> {
      return selectPage<FormResponsePacketRow>(tx, [FORM_RESPONSE_PACKET, FORM_RESPONSE_QUESTION], formResponseSelect(tx, args), page);
    },

    /** dataCollectionManager.getData, every row in its order, `batchSize` rows per batch. */
    async *responseBatches(tx: TenantTx, args: FormResponsesArgs, batchSize?: number): AsyncGenerator<FormResponsePacketRow[], void, undefined> {
      yield* selectBatches<FormResponsePacketRow>(tx, [FORM_RESPONSE_PACKET, FORM_RESPONSE_QUESTION], formResponseSelect(tx, args), batchSize);
    },

    fullFieldList,

    /** dataCollectionManager.getCurrentFieldList: the form's chosen display fields, else every answered field. */
    async currentFieldList(tx: TenantTx, args: { formId: string }): Promise<string> {
      const p = new SqlParams(1);
      const rows = await select<{ responsedisplayfields: string | null }>(
        tx,
        [CONTENT],
        `SELECT responsedisplayfields FROM ${name(CONTENT)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.formId)} AND active = 1` +
          ' ORDER BY tcontent_id LIMIT 1',
        [tx.tenantId, ...p.values],
      );
      const display = (rows[0]?.responsedisplayfields ?? '').split('~').find((element) => element !== '') ?? '';
      return display !== '' ? display.replaceAll('^', ',') : fullFieldList(tx, args);
    },
  };

  // ---- extend ----

  /** The attributes of several extend sets, by set, order number then name. */
  function attributesForSets(tx: TenantTx, args: { extendSetIds: readonly string[] }): Promise<ExtendAttributeRow[]> {
    const p = new SqlParams(1);
    return select<ExtendAttributeRow>(
      tx,
      [EXTEND_ATTRIBUTE],
      `SELECT * FROM ${name(EXTEND_ATTRIBUTE)} WHERE tenant_id = $1 AND ${idIn(p, 'extendsetid', args.extendSetIds)}` +
        ` ORDER BY extendsetid, ${orderKey('orderno', 'asc')}, ${orderKey('lower(name)', 'asc')}, attributeid`,
      [tx.tenantId, ...p.values],
    );
  }

  const extend = {
    /** extendManager.saveExtendedData: for each attribute value, removes the base object's rows of that attribute and inserts the value. */
    async replaceExtendData(tx: TenantTx, baseId: string, rows: readonly ExtendDataInput[], ctx?: WriteContext): Promise<ExtendDataRow[]> {
      const stored: ExtendDataRow[] = [];
      for (const row of rows) {
        await deleteWhere(tx, EXTEND_DATA, (p) => `${idEq(p, 'baseid', baseId)} AND attributeid = ${p.add(row.attributeid)}`, ctx);
        stored.push(await platform.insert<ExtendDataRow>(tx, EXTEND_DATA.table, { ...row, baseid: baseId }, ctx));
      }
      return stored;
    },

    /** extendManager.preserveExtendedData's inserts: appends rows to a base object without removing any, duplicates included. */
    insertExtendData(tx: TenantTx, baseId: string, rows: readonly ExtendDataInput[], ctx?: WriteContext): Promise<ExtendDataRow[]> {
      return insertEach<ExtendDataRow>(tx, EXTEND_DATA, rows.map((row) => ({ ...row, baseid: baseId })), ctx);
    },

    /** extendManager.deleteExtendedData; returns the File attribute values for the file manager's `deleteIfNotUsed`. */
    deleteExtendDataForBase(tx: TenantTx, baseId: string, ctx?: WriteContext): Promise<string[]> {
      return deleteExtendData(tx, baseId, ctx);
    },

    /** The content subtypes of a site, optionally of one type and subtype, by type then subtype. */
    subtypes(tx: TenantTx, args: { siteId: string; type?: string; subType?: string }): Promise<ExtendSubtypeRow[]> {
      const p = new SqlParams(1);
      const filters = [`tenant_id = $1`, `siteid = ${p.add(args.siteId)}`];
      if (args.type !== undefined) filters.push(ciEq(p, 'type', args.type));
      if (args.subType !== undefined) filters.push(ciEq(p, 'subtype', args.subType));
      return select<ExtendSubtypeRow>(
        tx,
        [EXTEND_SUBTYPE],
        `SELECT * FROM ${name(EXTEND_SUBTYPE)} WHERE ${filters.join(' AND ')}` +
          ` ORDER BY ${orderKey('lower(type)', 'asc')}, ${orderKey('lower(subtype)', 'asc')}, subtypeid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The extend sets of a subtype by order number (extendSubType.getSets). */
    setsForSubtype(tx: TenantTx, args: { subTypeId: string }): Promise<ExtendSetRow[]> {
      const p = new SqlParams(1);
      return select<ExtendSetRow>(
        tx,
        [EXTEND_SET],
        `SELECT * FROM ${name(EXTEND_SET)} WHERE tenant_id = $1 AND ${idEq(p, 'subtypeid', args.subTypeId)} ORDER BY ${orderKey('orderno', 'asc')}, extendsetid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The attributes of one extend set by order number then name (extendSet.getAttributes). */
    attributesForSet(tx: TenantTx, args: { extendSetId: string }): Promise<ExtendAttributeRow[]> {
      return attributesForSets(tx, { extendSetIds: [args.extendSetId] });
    },

    attributesForSets,

    /** The related-content sets of a subtype by order number (extendSubType.getRelatedContentSets). */
    rcsetsForSubtype(tx: TenantTx, args: { subTypeId: string }): Promise<ExtendRcsetRow[]> {
      const p = new SqlParams(1);
      return select<ExtendRcsetRow>(
        tx,
        [EXTEND_RCSET],
        `SELECT * FROM ${name(EXTEND_RCSET)} WHERE tenant_id = $1 AND ${idEq(p, 'subtypeid', args.subTypeId)}` +
          ` ORDER BY ${orderKey('orderno', 'asc')}, relatedcontentsetid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The extend values of a base object (a content version), by attribute. */
    extendDataFor(tx: TenantTx, args: { baseId: string }): Promise<ExtendDataRow[]> {
      const p = new SqlParams(1);
      return select<ExtendDataRow>(
        tx,
        [EXTEND_DATA],
        `SELECT * FROM ${name(EXTEND_DATA)} WHERE tenant_id = $1 AND ${idEq(p, 'baseid', args.baseId)} ORDER BY attributeid, dataid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** The extend values of a base object with their attribute name, set and subtype (extendManager.preserveExtendedData's join). */
    extendDataDetail(tx: TenantTx, args: { baseId: string }): Promise<ExtendDataDetailRow[]> {
      const p = new SqlParams(1);
      return select<ExtendDataDetailRow>(
        tx,
        [EXTEND_DATA, EXTEND_ATTRIBUTE, EXTEND_SET, EXTEND_SUBTYPE],
        `SELECT d.*, a.name, a.extendsetid, s.subtypeid, t.type, t.subtype FROM ${name(EXTEND_DATA)} d` +
          ` INNER JOIN ${name(EXTEND_ATTRIBUTE)} a ON (a.tenant_id = d.tenant_id AND d.attributeid = a.attributeid)` +
          ` INNER JOIN ${name(EXTEND_SET)} s ON (s.tenant_id = a.tenant_id AND a.extendsetid = s.extendsetid)` +
          ` INNER JOIN ${name(EXTEND_SUBTYPE)} t ON (t.tenant_id = s.tenant_id AND s.subtypeid = t.subtypeid)` +
          ` WHERE d.tenant_id = $1 AND ${idEq(p, 'd.baseid', args.baseId)} ORDER BY d.attributeid, d.dataid`,
        [tx.tenantId, ...p.values],
      );
    },
  };

  // ---- variation targeting ----

  const variation = {
    /** contentVariationTargetingBean.save; `targetingid` defaults to a new CF UUID. */
    upsertTargeting(tx: TenantTx, row: VariationTargetingInput, ctx?: WriteContext): Promise<VariationTargetingRow> {
      return platform.upsert<VariationTargetingRow>(tx, VARIATION_TARGETING.table, ormStorage({ ...row, targetingid: row.targetingid ?? cfUuid() }), ctx);
    },

    /** contentVariationTargetingBean.delete. */
    deleteTargeting(tx: TenantTx, args: { targetingId: string }, ctx?: WriteContext): Promise<VariationTargetingRow | null> {
      return platform.delete<VariationTargetingRow>(tx, VARIATION_TARGETING.table, { targetingid: args.targetingId }, ctx);
    },

    /** contentVariationTargetingBean.loadBy(contentid, siteid): the item's targeting, or null. */
    async targetingFor(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<VariationTargetingRow | null> {
      const p = new SqlParams(1);
      const rows = await select<VariationTargetingRow>(
        tx,
        [VARIATION_TARGETING],
        `SELECT * FROM ${name(VARIATION_TARGETING)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)}` +
          ` AND siteid = ${p.add(args.siteId)} ORDER BY targetingid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** The tenant's targeting rows in primary-key order, as contentVariationTargetingBean's beanFeed selects them. */
    targetingsOfTenant(tx: TenantTx): Promise<VariationTargetingRow[]> {
      return select<VariationTargetingRow>(
        tx,
        [VARIATION_TARGETING],
        `SELECT * FROM ${name(VARIATION_TARGETING)} WHERE tenant_id = $1 ORDER BY targetingid`,
        [tx.tenantId],
      );
    },
  };

  // ---- keyless approval queues ----

  const approvalQueues = {
    /** contentUtility.setApprovalQue: queues a public submission for approval. */
    insertSubmissionApproval(
      tx: TenantTx,
      args: { contentId: string; email: string | null; siteId: string },
      ctx?: WriteContext,
    ): Promise<PublicSubmissionApprovalRow> {
      return platform.insert<PublicSubmissionApprovalRow>(
        tx,
        PUBLIC_SUBMISSION_APPROVAL.table,
        { contentid: args.contentId, isapproved: 0, email: args.email, siteid: args.siteId },
        ctx,
      );
    },

    /** contentUtility.checkApprovalQue's select, which compares `contentid` with the version's content history id. */
    pendingSubmissionApprovals(tx: TenantTx, args: { contentHistId: string }): Promise<PublicSubmissionApprovalRow[]> {
      const p = new SqlParams(1);
      return select<PublicSubmissionApprovalRow>(
        tx,
        [PUBLIC_SUBMISSION_APPROVAL],
        `SELECT * FROM ${name(PUBLIC_SUBMISSION_APPROVAL)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentHistId)}` +
          ' AND isapproved = 0 ORDER BY legacy_row_hash, occurrence',
        [tx.tenantId, ...p.values],
      );
    },

    /** contentUtility.checkApprovalQue's update: marks each pending occurrence for the item approved, one occurrence at a time. */
    async approveSubmission(tx: TenantTx, args: { contentId: string }, ctx?: WriteContext): Promise<PublicSubmissionApprovalRow[]> {
      const pending = await lockRows<PublicSubmissionApprovalRow>(
        tx,
        PUBLIC_SUBMISSION_APPROVAL,
        (p) => `${idEq(p, 'contentid', args.contentId)} AND isapproved = 0`,
        ctx,
      );
      const approved: PublicSubmissionApprovalRow[] = [];
      for (const row of pending) {
        const before = keylessContent(row);
        const after = await platform.replaceOne<PublicSubmissionApprovalRow>(tx, PUBLIC_SUBMISSION_APPROVAL.table, before, { ...before, isapproved: 1 }, ctx);
        if (after !== null) {
          approved.push(after);
        }
      }
      return approved;
    },

    /** The display-title approval rows of an item; legacy has no writer of this table. */
    displayTitleApprovals(tx: TenantTx, args: { contentId: string }): Promise<DisplayTitleApprovalRow[]> {
      const p = new SqlParams(1);
      return select<DisplayTitleApprovalRow>(
        tx,
        [DISPLAY_TITLE_APPROVAL],
        `SELECT * FROM ${name(DISPLAY_TITLE_APPROVAL)} WHERE tenant_id = $1 AND ${idEq(p, 'contentid', args.contentId)} ORDER BY legacy_row_hash, occurrence`,
        [tx.tenantId, ...p.values],
      );
    },
  };

  // ---- trash ----

  const trash = {
    /** trashManager.getQuery: trash rows by its filters, a delete batch by order number, otherwise newest first. */
    trashFor(tx: TenantTx, args: TrashQueryArgs = {}): Promise<TrashListRow[]> {
      const p = new SqlParams(1);
      const filters = [`tenant_id = $1`];
      if (args.sinceDate !== undefined) filters.push(`deleteddate >= ${p.add(atTimeOfDay(args.sinceDate, 0, 0, 0))}`);
      if (args.beforeDate !== undefined) filters.push(`deleteddate <= ${p.add(atTimeOfDay(args.beforeDate, 23, 59, 59))}`);
      if (args.objectId !== undefined) filters.push(ciEq(p, 'objectid', args.objectId));
      if (args.parentId !== undefined) filters.push(ciEq(p, 'parentid', args.parentId));
      if (args.siteId !== undefined) filters.push(`siteid = ${p.add(args.siteId)}`);
      if (args.objectType !== undefined) filters.push(ciEq(p, 'objecttype', args.objectType));
      if (args.objectSubType !== undefined) filters.push(ciEq(p, 'objectsubtype', args.objectSubType));
      if (args.objectClass !== undefined) filters.push(ciEq(p, 'objectclass', args.objectClass));
      if (args.deletedBy !== undefined) filters.push(ciEq(p, 'deletedby', args.deletedBy));
      if (args.deleteId !== undefined) filters.push(ciEq(p, 'deleteid', args.deleteId));
      if (args.objectLabel !== undefined) filters.push(ciEq(p, 'objectclass', args.objectLabel));
      if (args.deletedDate !== undefined) filters.push(`deleteddate = ${p.add(args.deletedDate)}`);
      if (args.keywords !== undefined && args.keywords !== '') {
        const like = `%${args.keywords}%`;
        const columns = ['objectclass', 'objectsubtype', 'objecttype', 'deletedby', 'siteid', 'objectlabel'];
        filters.push(`(${columns.map((column) => ciLike(p, column, like)).join(' OR ')})`);
      }
      const order = args.deleteId !== undefined ? orderKey('orderno', 'desc') : orderKey('deleteddate', 'desc');
      return select<TrashListRow>(
        tx,
        [TRASH],
        'SELECT objectid, siteid, parentid, objectclass, objecttype, objectsubtype, objectlabel, deleteddate, deletedby, deleteid, orderno' +
          ` FROM ${name(TRASH)} WHERE ${filters.join(' AND ')} ORDER BY ${order}, objectid`,
        [tx.tenantId, ...p.values],
      );
    },

    /** trashManager.getTrashItem: one trash row with its serialized object, or null. */
    async trashItem(tx: TenantTx, args: { objectId: string }): Promise<TrashRow | null> {
      const p = new SqlParams(1);
      const rows = await select<TrashRow>(
        tx,
        [TRASH],
        `SELECT * FROM ${name(TRASH)} WHERE tenant_id = $1 AND ${ciEq(p, 'objectid', args.objectId)} ORDER BY objectid LIMIT 1`,
        [tx.tenantId, ...p.values],
      );
      return rows[0] ?? null;
    },

    /** trashManager.throwIn's insert, skipped when the object is already in the trash; null when skipped. */
    async insertTrashIfAbsent(tx: TenantTx, row: TrashInput, ctx?: WriteContext): Promise<TrashRow | null> {
      const existing = await lockRows<TrashRow>(tx, TRASH, (p) => ciEq(p, 'objectid', row.objectid), ctx);
      if (existing.length > 0) {
        return null;
      }
      return platform.insert<TrashRow>(tx, TRASH.table, row, ctx);
    },
  };

  // ---- projections ----

  const projections = {
    /** Stores a group's name and flags from `identity.group.changed.v1`. */
    upsertGroupProjection(tx: TenantTx, row: GroupProjectionInput, ctx?: WriteContext): Promise<GroupProjectionRow> {
      return platform.upsert<GroupProjectionRow>(
        tx,
        GROUP_PROJECTION.table,
        { group_id: row.groupId, site_id: row.siteId, group_name: row.groupName, is_public: row.isPublic, deleted: row.deleted },
        ctx,
      );
    },

    /** Marks a projected group deleted; null when the group was never projected. */
    markGroupDeleted(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<GroupProjectionRow | null> {
      return platform.update<GroupProjectionRow>(tx, GROUP_PROJECTION.table, { group_id: groupId }, { deleted: true }, ctx);
    },

    /** Replaces a group's node verdicts on a site with `rows`; an empty list clears them. */
    async replaceGroupPermissions(
      tx: TenantTx,
      groupId: string,
      siteId: string,
      rows: readonly PermissionProjectionInput[],
      ctx?: WriteContext,
    ): Promise<PermissionProjectionRow[]> {
      await deleteWhere(
        tx,
        PERMISSION_PROJECTION,
        (p) => `${ciIdExpr('group_id', 'legacy_char_ci')} = ${p.add(groupId)}::bpchar AND ${ciIdExpr('site_id', 'legacy_ci')} = ${p.add(siteId)}::bpchar`,
        ctx,
      );
      const seen = new Set<string>();
      const stored: PermissionProjectionRow[] = [];
      for (const row of rows) {
        const key = JSON.stringify([row.siteId, row.contentId, row.type]);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        stored.push(
          await platform.upsert<PermissionProjectionRow>(
            tx,
            PERMISSION_PROJECTION.table,
            { group_id: groupId, site_id: row.siteId, content_id: row.contentId, type: row.type },
            ctx,
          ),
        );
      }
      return stored;
    },

    /** Replaces every projected membership of a user with `groupIds` on `siteId`; an empty list clears them. */
    async replaceUserMemberships(
      tx: TenantTx,
      userId: string,
      siteId: string,
      groupIds: readonly string[],
      ctx?: WriteContext,
    ): Promise<MembershipProjectionRow[]> {
      await deleteWhere(tx, MEMBERSHIP_PROJECTION, (p) => `${ciIdExpr('user_id', 'legacy_char_ci')} = ${p.add(userId)}::bpchar`, ctx);
      return insertEach<MembershipProjectionRow>(
        tx,
        MEMBERSHIP_PROJECTION,
        distinctValues(groupIds).map((groupId) => ({ user_id: userId, site_id: siteId, group_id: groupId })),
        ctx,
      );
    },

    /** The projected groups among `groupIds`, deleted ones included. */
    groupNames(tx: TenantTx, groupIds: readonly string[]): Promise<GroupProjectionRow[]> {
      return select<GroupProjectionRow>(
        tx,
        [GROUP_PROJECTION],
        `SELECT * FROM ${name(GROUP_PROJECTION)} WHERE tenant_id = $1 AND ${ciIdExpr('group_id', 'legacy_char_ci')} = ANY($2::bpchar[]) ORDER BY group_id`,
        [tx.tenantId, distinctValues(groupIds)],
      );
    },

    /** The group ids a user is a projected member of. */
    async groupsOfUser(tx: TenantTx, userId: string): Promise<string[]> {
      const rows = await select<{ group_id: string }>(
        tx,
        [MEMBERSHIP_PROJECTION],
        `SELECT group_id FROM ${name(MEMBERSHIP_PROJECTION)} WHERE tenant_id = $1 AND ${ciIdExpr('user_id', 'legacy_char_ci')} = $2::bpchar ORDER BY group_id`,
        [tx.tenantId, userId],
      );
      return rows.map((row) => row.group_id);
    },

    /** The projected node verdicts of a site's `contentIds`, optionally only those of `groupIds` (inputs of the permission.cfc verdict). */
    permissionsForNodes(
      tx: TenantTx,
      args: { siteId: string; contentIds: readonly string[]; groupIds?: readonly string[] },
    ): Promise<PermissionProjectionRow[]> {
      const p = new SqlParams(1);
      const filters = [
        `tenant_id = $1`,
        `${ciIdExpr('site_id', 'legacy_ci')} = ${p.add(args.siteId)}::bpchar`,
        `${ciIdExpr('content_id', 'legacy_char_ci')} = ANY(${p.add(distinctValues(args.contentIds))}::bpchar[])`,
      ];
      if (args.groupIds !== undefined) {
        filters.push(`${ciIdExpr('group_id', 'legacy_char_ci')} = ANY(${p.add(distinctValues(args.groupIds))}::bpchar[])`);
      }
      return select<PermissionProjectionRow>(
        tx,
        [PERMISSION_PROJECTION],
        `SELECT * FROM ${name(PERMISSION_PROJECTION)} WHERE ${filters.join(' AND ')} ORDER BY content_id, group_id, type`,
        [tx.tenantId, ...p.values],
      );
    },

    /** contentUtility.getRestrictGroups over one user pool: the live groups of `siteId` with `isPublic`, `Admin` excepted, by name. */
    restrictGroups(tx: TenantTx, args: { siteId: string; isPublic: 0 | 1 }): Promise<GroupProjectionRow[]> {
      const p = new SqlParams(1);
      return select<GroupProjectionRow>(
        tx,
        [GROUP_PROJECTION],
        `SELECT * FROM ${name(GROUP_PROJECTION)} WHERE tenant_id = $1 AND NOT deleted AND is_public = ${p.add(args.isPublic)}` +
          ` AND ${ciIdExpr('site_id', 'legacy_ci')} = ${p.add(args.siteId)}::bpchar AND lower(rtrim(group_name)) <> 'admin'` +
          ` ORDER BY ${orderKey('lower(group_name)', 'asc')}, group_id`,
        [tx.tenantId, ...p.values],
      );
    },
  };

  return Object.freeze({
    platform,
    content,
    files,
    feeds,
    comments,
    categories,
    changesets,
    approvals,
    forms,
    extend,
    stats,
    variation,
    approvalQueues,
    trash,
    projections,
  });
}

/** The content repository: the platform repository and one helper namespace per content area. */
export type ContentRepository = ReturnType<typeof createContentRepository>;

