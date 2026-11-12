/** Owned tables of schema `content`, as the platform repository declares them. */
import type { CanonicalColumn, CanonicalType, TableDefinition } from '@opt2/platform/migration-kit';

/** Units of write authority of schema `content`, in the order `opt2/table-ownership.json` lists them. */
export const CONTENT_UNITS = [
  'content.approval_action',
  'content.approval_assignment',
  'content.approval_chain',
  'content.approval_membership',
  'content.approval_request',
  'content.category',
  'content.changeset',
  'content.changeset_category_assign',
  'content.changeset_rollback',
  'content.changeset_tag_assign',
  'content.comment',
  'content.commenter',
  'content.content',
  'content.content_assignment',
  'content.content_category_assign',
  'content.content_object',
  'content.content_rating',
  'content.content_related',
  'content.content_remote_pointer',
  'content.content_stats',
  'content.content_tag',
  'content.display_title_approval',
  'content.extend_attribute',
  'content.extend_data',
  'content.extend_rc_set',
  'content.extend_set',
  'content.extend_subtype',
  'content.feed',
  'content.feed_advanced_param',
  'content.feed_item',
  'content.file',
  'content.file_metadata',
  'content.filename_archive',
  'content.form_response_packet',
  'content.form_response_question',
  'content.public_submission_approval',
  'content.source_map',
  'content.trash',
  'content.variation_targeting',
] as const;

/** One strategies-content unit id. */
export type ContentUnit = (typeof CONTENT_UNITS)[number];

// file_object carries no unit: table ownership lists it only as a new table and no cut-over group gates it, so a
// unit of its own would stay legacy-authoritative forever; its target writes share the content.file transaction gate.
/** Content tables without a unit: never gated or mapped from a legacy table, but still written with changelog rows. */
export const NON_UNIT_TABLE_NAMES = ['file_object', 'group_projection', 'permission_projection', 'membership_projection'] as const;

type NonUnitTableName = (typeof NON_UNIT_TABLE_NAMES)[number];
type TableOfUnit<U extends string> = U extends `content.${infer T}` ? T : never;

/** Name of one gated `content` table. */
export type ContentUnitTableName = TableOfUnit<ContentUnit>;

/** Name of one owned `content` table. */
export type ContentTableName = ContentUnitTableName | NonUnitTableName;

type Columns = readonly CanonicalColumn[];
type ColumnName<C extends Columns> = C[number]['name'];
type Key<C extends Columns> = readonly [ColumnName<C>, ...ColumnName<C>[]];

/** A content table definition named `T` whose catalog columns are the tuple `C`. */
export interface ContentTableDefinition<T extends ContentTableName = ContentTableName, C extends Columns = Columns>
  extends TableDefinition {
  table: T;
  columns: [...C];
}

/** A gated content table definition whose unit is `U`. */
export interface ContentUnitTableDefinition<U extends ContentUnit = ContentUnit, C extends Columns = Columns>
  extends ContentTableDefinition<TableOfUnit<U>, C> {
  unit: U;
}

const UNIT_PREFIX = 'content.';
// The platform repository requires tenant_id among the declared columns and fills it from the transaction tenant.
const TENANT_ID = { name: 'tenant_id', type: 's' } as const satisfies CanonicalColumn;
const LEGACY_ROW_HASH = { name: 'legacy_row_hash', type: 's' } as const satisfies CanonicalColumn;
const OCCURRENCE = { name: 'occurrence', type: 'i' } as const satisfies CanonicalColumn;

function tableOf<U extends ContentUnit>(unit: U): TableOfUnit<U> {
  return unit.slice(UNIT_PREFIX.length) as TableOfUnit<U>;
}

function unitTable<U extends ContentUnit, C extends Columns>(unit: U, columns: C, key: Key<C>): ContentUnitTableDefinition<U, C> {
  return { table: tableOf(unit), columns: [...columns], key: [...key], unit };
}

/** A keyless unit table: `key: null`, its rows told apart by `legacy_row_hash` and `occurrence`. */
function keylessUnitTable<U extends ContentUnit, C extends Columns>(unit: U, columns: C): ContentUnitTableDefinition<U, C> {
  return { table: tableOf(unit), columns: [...columns], key: null, unit };
}

function nonUnitTable<T extends NonUnitTableName, C extends Columns>(table: T, columns: C, key: Key<C>): ContentTableDefinition<T, C> {
  return { table, columns: [...columns], key: [...key] };
}

const CONTENT_COLUMNS = [
  TENANT_ID,
  { name: 'tcontent_id', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'moduleid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remoteurl', type: 's' },
  { name: 'remotepubdate', type: 's' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'remotesource', type: 's' },
  { name: 'credits', type: 's' },
  { name: 'fileid', type: 's' },
  { name: 'template', type: 's' },
  { name: 'type', type: 's' },
  { name: 'subtype', type: 's' },
  { name: 'active', type: 'i' },
  { name: 'orderno', type: 'i' },
  { name: 'title', type: 's' },
  { name: 'menutitle', type: 's' },
  { name: 'summary', type: 's' },
  { name: 'filename', type: 's' },
  { name: 'metadesc', type: 's' },
  { name: 'metakeywords', type: 's' },
  { name: 'body', type: 's' },
  { name: 'lastupdate', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdatebyid', type: 's' },
  { name: 'displaystart', type: 't' },
  { name: 'displaystop', type: 't' },
  { name: 'display', type: 'i' },
  { name: 'approved', type: 'i' },
  { name: 'isnav', type: 'i' },
  { name: 'restricted', type: 'i' },
  { name: 'restrictgroups', type: 's' },
  { name: 'target', type: 's' },
  { name: 'targetparams', type: 's' },
  { name: 'responsechart', type: 'i' },
  { name: 'responsemessage', type: 's' },
  { name: 'responsesendto', type: 's' },
  { name: 'responsedisplayfields', type: 's' },
  { name: 'moduleassign', type: 's' },
  { name: 'displaytitle', type: 'i' },
  { name: 'notes', type: 's' },
  { name: 'inheritobjects', type: 's' },
  { name: 'isfeature', type: 'i' },
  { name: 'releasedate', type: 't' },
  { name: 'islocked', type: 'i' },
  { name: 'nextn', type: 'i' },
  { name: 'sortby', type: 's' },
  { name: 'sortdirection', type: 's' },
  { name: 'featurestart', type: 't' },
  { name: 'featurestop', type: 't' },
  { name: 'forcessl', type: 'i' },
  { name: 'audience', type: 's' },
  { name: 'keypoints', type: 's' },
  { name: 'searchexclude', type: 'i' },
  { name: 'path', type: 's' },
  { name: 'tags', type: 's' },
  { name: 'docache', type: 'i' },
  { name: 'urltitle', type: 's' },
  { name: 'htmltitle', type: 's' },
  { name: 'created', type: 't' },
  { name: 'mobileexclude', type: 'i' },
  { name: 'changesetid', type: 's' },
  { name: 'imagesize', type: 's' },
  { name: 'imageheight', type: 's' },
  { name: 'imagewidth', type: 's' },
  { name: 'childtemplate', type: 's' },
  { name: 'majorversion', type: 'i' },
  { name: 'minorversion', type: 'i' },
  { name: 'expires', type: 't' },
  { name: 'displayinterval', type: 's' },
  { name: 'objectparams', type: 's' },
] as const satisfies Columns;

/** `content.content`, from Masa `tcontent`: one row per content version. */
export const CONTENT = unitTable('content.content', CONTENT_COLUMNS, ['tcontent_id']);

const CONTENT_OBJECT_COLUMNS = [
  TENANT_ID,
  { name: 'contenthistid', type: 's' },
  { name: 'objectid', type: 's' },
  { name: 'object', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'columnid', type: 'i' },
  { name: 'params', type: 's' },
] as const satisfies Columns;

/** `content.content_object`, from Masa `tcontentobjects`; `params` is byte-exact text. */
export const CONTENT_OBJECT = unitTable('content.content_object', CONTENT_OBJECT_COLUMNS, [
  'contenthistid',
  'objectid',
  'object',
  'columnid',
  'orderno',
]);

const CONTENT_RELATED_COLUMNS = [
  TENANT_ID,
  { name: 'contenthistid', type: 's' },
  { name: 'relatedid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'relatedcontentsetid', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'relatedcontentid', type: 'i' },
] as const satisfies Columns;

/** `content.content_related`, from Masa `tcontentrelated`. */
export const CONTENT_RELATED = unitTable('content.content_related', CONTENT_RELATED_COLUMNS, ['relatedcontentid']);

const CONTENT_TAG_COLUMNS = [
  TENANT_ID,
  { name: 'tagid', type: 'i' },
  { name: 'contenthistid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'tag', type: 's' },
  { name: 'taggroup', type: 's' },
] as const satisfies Columns;

/** `content.content_tag`, from Masa `tcontenttags`. */
export const CONTENT_TAG = unitTable('content.content_tag', CONTENT_TAG_COLUMNS, ['tagid']);

const CATEGORY_ASSIGN_COLUMNS = [
  TENANT_ID,
  { name: 'contenthistid', type: 's' },
  { name: 'categoryid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'isfeature', type: 'i' },
  { name: 'orderno', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'featurestart', type: 't' },
  { name: 'featurestop', type: 't' },
] as const satisfies Columns;

/** `content.content_category_assign`, from Masa `tcontentcategoryassign`. */
export const CATEGORY_ASSIGN = unitTable('content.content_category_assign', CATEGORY_ASSIGN_COLUMNS, ['contenthistid', 'categoryid']);

const CATEGORY_COLUMNS = [
  TENANT_ID,
  { name: 'categoryid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'datecreated', type: 't' },
  { name: 'lastupdate', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'name', type: 's' },
  { name: 'notes', type: 's' },
  { name: 'isinterestgroup', type: 'i' },
  { name: 'isactive', type: 'i' },
  { name: 'isopen', type: 'i' },
  { name: 'sortby', type: 's' },
  { name: 'sortdirection', type: 's' },
  { name: 'restrictgroups', type: 's' },
  { name: 'path', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'remotepubdate', type: 't' },
  { name: 'urltitle', type: 's' },
  { name: 'filename', type: 's' },
  { name: 'isfeatureable', type: 'i' },
] as const satisfies Columns;

/** `content.category`, from Masa `tcontentcategories`. */
export const CATEGORY = unitTable('content.category', CATEGORY_COLUMNS, ['categoryid']);

const CONTENT_ASSIGNMENT_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'type', type: 's' },
] as const satisfies Columns;

/** `content.content_assignment`, from Masa `tcontentassignments`. */
export const CONTENT_ASSIGNMENT = unitTable('content.content_assignment', CONTENT_ASSIGNMENT_COLUMNS, [
  'contentid',
  'contenthistid',
  'siteid',
  'userid',
]);

const CONTENT_STATS_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'views', type: 'i' },
  { name: 'rating', type: 'f' },
  { name: 'totalvotes', type: 'i' },
  { name: 'upvotes', type: 'i' },
  { name: 'downvotes', type: 'i' },
  { name: 'comments', type: 'i' },
  { name: 'majorversion', type: 'i' },
  { name: 'minorversion', type: 'i' },
  { name: 'lockid', type: 's' },
  { name: 'locktype', type: 's' },
  { name: 'disablecomments', type: 'i' },
] as const satisfies Columns;

/** `content.content_stats`, from Masa `tcontentstats`, including its lock and version columns. */
export const CONTENT_STATS = unitTable('content.content_stats', CONTENT_STATS_COLUMNS, ['contentid', 'siteid']);

const CONTENT_RATING_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'rate', type: 'i' },
  { name: 'entered', type: 't' },
] as const satisfies Columns;

/** `content.content_rating`, from Masa `tcontentratings`. */
export const CONTENT_RATING = unitTable('content.content_rating', CONTENT_RATING_COLUMNS, ['contentid', 'userid', 'siteid']);

const COMMENT_COLUMNS = [
  TENANT_ID,
  { name: 'commentid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'url', type: 's' },
  { name: 'name', type: 's' },
  { name: 'comments', type: 's' },
  { name: 'entered', type: 't' },
  { name: 'email', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'ip', type: 's' },
  { name: 'isapproved', type: 'i' },
  { name: 'subscribe', type: 'i' },
  { name: 'userid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'path', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'flagcount', type: 'i' },
  { name: 'isspam', type: 'i' },
  { name: 'isdeleted', type: 'i' },
] as const satisfies Columns;

/** `content.comment`, from Masa `tcontentcomments`. */
export const COMMENT = unitTable('content.comment', COMMENT_COLUMNS, ['commentid']);

const COMMENTER_COLUMNS = [
  TENANT_ID,
  { name: 'remoteid', type: 's' },
  { name: 'commenterid', type: 's' },
  { name: 'email', type: 's' },
  { name: 'name', type: 's' },
] as const satisfies Columns;

/** `content.commenter`, from Masa `tcontentcommentcommenters`. */
export const COMMENTER = unitTable('content.commenter', COMMENTER_COLUMNS, ['commenterid']);

const FEED_COLUMNS = [
  TENANT_ID,
  { name: 'feedid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'isactive', type: 'i' },
  { name: 'ispublic', type: 'i' },
  { name: 'isdefault', type: 'i' },
  { name: 'isfeaturesonly', type: 'i' },
  { name: 'description', type: 's' },
  { name: 'maxitems', type: 'i' },
  { name: 'allowhtml', type: 'i' },
  { name: 'lang', type: 's' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdate', type: 't' },
  { name: 'datecreated', type: 't' },
  { name: 'restricted', type: 'i' },
  { name: 'restrictgroups', type: 's' },
  { name: 'version', type: 's' },
  { name: 'channellink', type: 's' },
  { name: 'type', type: 's' },
  { name: 'sortby', type: 's' },
  { name: 'sortdirection', type: 's' },
  { name: 'nextn', type: 'i' },
  { name: 'displayname', type: 'i' },
  { name: 'displayratings', type: 'i' },
  { name: 'displaycomments', type: 'i' },
  { name: 'altname', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'remotepubdate', type: 't' },
  { name: 'imagesize', type: 's' },
  { name: 'imageheight', type: 's' },
  { name: 'imagewidth', type: 's' },
  { name: 'displaylist', type: 's' },
  { name: 'shownavonly', type: 'i' },
  { name: 'showexcludesearch', type: 'i' },
  { name: 'viewalllink', type: 's' },
  { name: 'viewalllabel', type: 's' },
  { name: 'cssclass', type: 's' },
  { name: 'autoimport', type: 'i' },
  { name: 'islocked', type: 'i' },
  { name: 'contentpoolid', type: 's' },
  { name: 'usecategoryintersect', type: 'i' },
  { name: 'authtype', type: 's' },
] as const satisfies Columns;

/** `content.feed`, from Masa `tcontentfeeds`. */
export const FEED = unitTable('content.feed', FEED_COLUMNS, ['feedid']);

const FEED_ITEM_COLUMNS = [
  TENANT_ID,
  { name: 'feedid', type: 's' },
  { name: 'itemid', type: 's' },
  { name: 'type', type: 's' },
] as const satisfies Columns;

/** `content.feed_item`, from Masa `tcontentfeeditems`. */
export const FEED_ITEM = unitTable('content.feed_item', FEED_ITEM_COLUMNS, ['feedid', 'itemid']);

const FEED_ADVANCED_PARAM_COLUMNS = [
  TENANT_ID,
  { name: 'paramid', type: 's' },
  { name: 'feedid', type: 's' },
  { name: 'param', type: 'd', scale: 0 },
  { name: 'relationship', type: 's' },
  { name: 'field', type: 's' },
  { name: 'condition', type: 's' },
  { name: 'criteria', type: 's' },
  { name: 'datatype', type: 's' },
] as const satisfies Columns;

/** `content.feed_advanced_param`, from Masa `tcontentfeedadvancedparams`. */
export const FEED_ADVANCED_PARAM = unitTable('content.feed_advanced_param', FEED_ADVANCED_PARAM_COLUMNS, ['paramid']);

const FILENAME_ARCHIVE_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'archiveid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'filename', type: 's' },
] as const satisfies Columns;

/** `content.filename_archive`, from the ORM table `tcontentfilenamearchive`. */
export const FILENAME_ARCHIVE = unitTable('content.filename_archive', FILENAME_ARCHIVE_COLUMNS, ['archiveid']);

const SOURCE_MAP_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'created', type: 't' },
  { name: 'sourceid', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'mapid', type: 's' },
  { name: 'contentid', type: 's' },
] as const satisfies Columns;

/** `content.source_map`, from the ORM table `tcontentsourcemaps`. */
export const SOURCE_MAP = unitTable('content.source_map', SOURCE_MAP_COLUMNS, ['mapid']);

const REMOTE_POINTER_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remoteurl', type: 's' },
  { name: 'created', type: 's' },
  { name: 'pointerid', type: 's' },
  { name: 'contentid', type: 's' },
] as const satisfies Columns;

/** `content.content_remote_pointer`, from the ORM table `tcontentremotepointer`. */
export const REMOTE_POINTER = unitTable('content.content_remote_pointer', REMOTE_POINTER_COLUMNS, ['pointerid']);

const VARIATION_TARGETING_COLUMNS = [
  TENANT_ID,
  { name: 'targetingid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'initjs', type: 's' },
  { name: 'targetingjs', type: 's' },
  { name: 'contentid', type: 's' },
] as const satisfies Columns;

/** `content.variation_targeting`, from the ORM table `tcontentvariationtargeting`. */
export const VARIATION_TARGETING = unitTable('content.variation_targeting', VARIATION_TARGETING_COLUMNS, ['targetingid']);

const DISPLAY_TITLE_APPROVAL_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'isapproved', type: 'i' },
  { name: 'email', type: 's' },
  { name: 'siteid', type: 's' },
  LEGACY_ROW_HASH,
  OCCURRENCE,
] as const satisfies Columns;

/** `content.display_title_approval`, from Masa `tcontentdisplaytitleapprovals`; keyless, rows matched as a multiset. */
export const DISPLAY_TITLE_APPROVAL = keylessUnitTable('content.display_title_approval', DISPLAY_TITLE_APPROVAL_COLUMNS);

const PUBLIC_SUBMISSION_APPROVAL_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'isapproved', type: 'i' },
  { name: 'email', type: 's' },
  { name: 'siteid', type: 's' },
  LEGACY_ROW_HASH,
  OCCURRENCE,
] as const satisfies Columns;

/** `content.public_submission_approval`, from Masa `tcontentpublicsubmissionapprovals`; keyless, rows matched as a multiset. */
export const PUBLIC_SUBMISSION_APPROVAL = keylessUnitTable('content.public_submission_approval', PUBLIC_SUBMISSION_APPROVAL_COLUMNS);

const FILE_COLUMNS = [
  TENANT_ID,
  { name: 'fileid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'moduleid', type: 's' },
  { name: 'filename', type: 's' },
  { name: 'image', type: 'b' },
  { name: 'imagesmall', type: 'b' },
  { name: 'imagemedium', type: 'b' },
  { name: 'filesize', type: 'i' },
  { name: 'contenttype', type: 's' },
  { name: 'contentsubtype', type: 's' },
  { name: 'fileext', type: 's' },
  { name: 'created', type: 't' },
  { name: 'deleted', type: 'i' },
  { name: 'caption', type: 's' },
  { name: 'credits', type: 's' },
  { name: 'alttext', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remoteurl', type: 's' },
  { name: 'remotepubdate', type: 't' },
  { name: 'remotesource', type: 's' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'exif', type: 's' },
] as const satisfies Columns;

/** `content.file`, from Masa `tfiles`; the image columns stay bytea. */
export const FILE = unitTable('content.file', FILE_COLUMNS, ['fileid']);

const FILE_METADATA_COLUMNS = [
  TENANT_ID,
  { name: 'alttext', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'fileid', type: 's' },
  { name: 'credits', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'remoteurl', type: 's' },
  { name: 'exif', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'remotesource', type: 's' },
  { name: 'remotepubdate', type: 't' },
  { name: 'metaid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'caption', type: 's' },
] as const satisfies Columns;

/** `content.file_metadata`, from the versioned ORM table `tcontentfilemetadata`. */
export const FILE_METADATA = unitTable('content.file_metadata', FILE_METADATA_COLUMNS, ['metaid']);

const FILE_OBJECT_COLUMNS = [
  TENANT_ID,
  { name: 'file_id', type: 's' },
  { name: 'variant', type: 's' },
  { name: 'ext', type: 's' },
  { name: 'object_key', type: 's' },
  { name: 'size', type: 'i' },
  { name: 'sha256', type: 's' },
  { name: 'content_type', type: 's' },
  { name: 'orphan', type: 'i' },
  { name: 'created_at', type: 't' },
] as const satisfies Columns;

/** `content.file_object`: the stored-object manifest of the `content-files` bucket. */
export const FILE_OBJECT = nonUnitTable('file_object', FILE_OBJECT_COLUMNS, ['object_key']);

const APPROVAL_CHAIN_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'chainid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'created', type: 't' },
  { name: 'lastupdate', type: 't' },
  { name: 'description', type: 's' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdatebyid', type: 's' },
] as const satisfies Columns;

/** `content.approval_chain`, from the ORM table `tapprovalchains`. */
export const APPROVAL_CHAIN = unitTable('content.approval_chain', APPROVAL_CHAIN_COLUMNS, ['chainid']);

const APPROVAL_MEMBERSHIP_COLUMNS = [
  TENANT_ID,
  { name: 'groupid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'created', type: 't' },
  { name: 'orderno', type: 'i' },
  { name: 'membershipid', type: 's' },
  { name: 'chainid', type: 's' },
] as const satisfies Columns;

/** `content.approval_membership`, from the ORM table `tapprovalmemberships`: the approving groups of a chain. */
export const APPROVAL_MEMBERSHIP = unitTable('content.approval_membership', APPROVAL_MEMBERSHIP_COLUMNS, ['membershipid']);

const APPROVAL_ASSIGNMENT_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'assignmentid', type: 's' },
  { name: 'contentid', type: 's' },
  { name: 'exemptid', type: 's' },
  { name: 'chainid', type: 's' },
] as const satisfies Columns;

/** `content.approval_assignment`, from the ORM table `tapprovalassignments`. */
export const APPROVAL_ASSIGNMENT = unitTable('content.approval_assignment', APPROVAL_ASSIGNMENT_COLUMNS, ['assignmentid']);

const APPROVAL_REQUEST_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'groupid', type: 's' },
  { name: 'created', type: 't' },
  { name: 'status', type: 's' },
  { name: 'contenthistid', type: 's' },
  { name: 'requestid', type: 's' },
  { name: 'chainid', type: 's' },
] as const satisfies Columns;

/** `content.approval_request`, from the ORM table `tapprovalrequests`. */
export const APPROVAL_REQUEST = unitTable('content.approval_request', APPROVAL_REQUEST_COLUMNS, ['requestid']);

const APPROVAL_ACTION_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'actiontype', type: 's' },
  { name: 'comments', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'groupid', type: 's' },
  { name: 'created', type: 't' },
  { name: 'actiontid', type: 's' },
  { name: 'requestid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'chainid', type: 's' },
] as const satisfies Columns;

/** `content.approval_action`, from the ORM table `tapprovalactions`; its key keeps the legacy spelling `actiontid`. */
export const APPROVAL_ACTION = unitTable('content.approval_action', APPROVAL_ACTION_COLUMNS, ['actiontid']);

const CHANGESET_COLUMNS = [
  TENANT_ID,
  { name: 'changesetid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'description', type: 's' },
  { name: 'created', type: 't' },
  { name: 'publishdate', type: 't' },
  { name: 'published', type: 'i' },
  { name: 'lastupdate', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdatebyid', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'remotepubdate', type: 't' },
  { name: 'remotesourceurl', type: 's' },
  { name: 'closedate', type: 't' },
] as const satisfies Columns;

/** `content.changeset`, from Masa `tchangesets`. */
export const CHANGESET = unitTable('content.changeset', CHANGESET_COLUMNS, ['changesetid']);

const CHANGESET_ROLLBACK_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'rollbackid', type: 's' },
  { name: 'changesetid', type: 's' },
  { name: 'previoushistid', type: 's' },
  { name: 'changesethistid', type: 's' },
] as const satisfies Columns;

/** `content.changeset_rollback`, from the ORM table `tchangesetrollback`. */
export const CHANGESET_ROLLBACK = unitTable('content.changeset_rollback', CHANGESET_ROLLBACK_COLUMNS, ['rollbackid']);

const CHANGESET_CATEGORY_ASSIGN_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'categoryid', type: 's' },
  { name: 'changesetid', type: 's' },
  { name: 'assignmentid', type: 's' },
] as const satisfies Columns;

/** `content.changeset_category_assign`, from the ORM table `tchangesetcategoryassign`. */
export const CHANGESET_CATEGORY_ASSIGN = unitTable('content.changeset_category_assign', CHANGESET_CATEGORY_ASSIGN_COLUMNS, [
  'assignmentid',
]);

const CHANGESET_TAG_ASSIGN_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'changesetid', type: 's' },
  { name: 'assignmentid', type: 's' },
  { name: 'tag', type: 's' },
] as const satisfies Columns;

/** `content.changeset_tag_assign`, from the ORM table `tchangesettagassign`. */
export const CHANGESET_TAG_ASSIGN = unitTable('content.changeset_tag_assign', CHANGESET_TAG_ASSIGN_COLUMNS, ['assignmentid']);

const FORM_RESPONSE_PACKET_COLUMNS = [
  TENANT_ID,
  { name: 'responseid', type: 's' },
  { name: 'formid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'fieldlist', type: 's' },
  { name: 'data', type: 's' },
  { name: 'entered', type: 't' },
] as const satisfies Columns;

/** `content.form_response_packet`, from Masa `tformresponsepackets`; `data` is byte-exact text. */
export const FORM_RESPONSE_PACKET = unitTable('content.form_response_packet', FORM_RESPONSE_PACKET_COLUMNS, ['responseid']);

const FORM_RESPONSE_QUESTION_COLUMNS = [
  TENANT_ID,
  { name: 'responseid', type: 's' },
  { name: 'formid', type: 's' },
  { name: 'formfield', type: 's' },
  { name: 'formvalue', type: 's' },
  { name: 'pollvalue', type: 's' },
] as const satisfies Columns;

/** `content.form_response_question`, from Masa `tformresponsequestions`. */
export const FORM_RESPONSE_QUESTION = unitTable('content.form_response_question', FORM_RESPONSE_QUESTION_COLUMNS, [
  'responseid',
  'formid',
  'formfield',
]);

const EXTEND_SUBTYPE_COLUMNS = [
  TENANT_ID,
  { name: 'subtypeid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'basetable', type: 's' },
  { name: 'basekeyfield', type: 's' },
  { name: 'datatable', type: 's' },
  { name: 'type', type: 's' },
  { name: 'subtype', type: 's' },
  { name: 'isactive', type: 'i' },
  { name: 'notes', type: 's' },
  { name: 'lastupdate', type: 't' },
  { name: 'datecreated', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'hassummary', type: 'i' },
  { name: 'hasbody', type: 'i' },
  { name: 'description', type: 's' },
  { name: 'availablesubtypes', type: 's' },
  { name: 'iconclass', type: 's' },
  { name: 'hasassocfile', type: 'i' },
  { name: 'hasconfigurator', type: 'i' },
  { name: 'adminonly', type: 'i' },
] as const satisfies Columns;

/** `content.extend_subtype`, the `baseTable = tcontent` rows of Masa `tclassextend`. */
export const EXTEND_SUBTYPE = unitTable('content.extend_subtype', EXTEND_SUBTYPE_COLUMNS, ['subtypeid']);

const EXTEND_SET_COLUMNS = [
  TENANT_ID,
  { name: 'extendsetid', type: 's' },
  { name: 'subtypeid', type: 's' },
  { name: 'categoryid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'isactive', type: 'i' },
  { name: 'container', type: 's' },
] as const satisfies Columns;

/** `content.extend_set`, the Masa `tclassextendsets` rows of content subtypes. */
export const EXTEND_SET = unitTable('content.extend_set', EXTEND_SET_COLUMNS, ['extendsetid']);

const EXTEND_ATTRIBUTE_COLUMNS = [
  TENANT_ID,
  { name: 'attributeid', type: 'i' },
  { name: 'extendsetid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'label', type: 's' },
  { name: 'hint', type: 's' },
  { name: 'type', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'isactive', type: 'i' },
  { name: 'required', type: 's' },
  { name: 'validation', type: 's' },
  { name: 'regex', type: 's' },
  { name: 'message', type: 's' },
  { name: 'defaultvalue', type: 's' },
  { name: 'optionlist', type: 's' },
  { name: 'optionlabellist', type: 's' },
  { name: 'adminonly', type: 'i' },
] as const satisfies Columns;

/** `content.extend_attribute`, the Masa `tclassextendattributes` rows of content extend sets. */
export const EXTEND_ATTRIBUTE = unitTable('content.extend_attribute', EXTEND_ATTRIBUTE_COLUMNS, ['attributeid']);

const EXTEND_RCSET_COLUMNS = [
  TENANT_ID,
  { name: 'subtypeid', type: 's' },
  { name: 'availablesubtypes', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'entitytype', type: 's' },
  { name: 'name', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'relatedcontentsetid', type: 's' },
] as const satisfies Columns;

/** `content.extend_rc_set`, the Masa `tclassextendrcsets` rows of content subtypes. */
export const EXTEND_RCSET = unitTable('content.extend_rc_set', EXTEND_RCSET_COLUMNS, ['relatedcontentsetid']);

const EXTEND_DATA_COLUMNS = [
  TENANT_ID,
  { name: 'dataid', type: 'i' },
  { name: 'baseid', type: 's' },
  { name: 'attributeid', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'attributevalue', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'datetimevalue', type: 't' },
  { name: 'numericvalue', type: 'f' },
  { name: 'stringvalue', type: 's' },
] as const satisfies Columns;

/** `content.extend_data`, the Masa `tclassextenddata` rows of content attributes. */
export const EXTEND_DATA = unitTable('content.extend_data', EXTEND_DATA_COLUMNS, ['dataid']);

const TRASH_COLUMNS = [
  TENANT_ID,
  { name: 'objectid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'objectlabel', type: 's' },
  { name: 'objectclass', type: 's' },
  { name: 'objecttype', type: 's' },
  { name: 'objectsubtype', type: 's' },
  { name: 'objectstring', type: 's' },
  { name: 'deleteddate', type: 't' },
  { name: 'deletedby', type: 's' },
  { name: 'deleteid', type: 's' },
  { name: 'orderno', type: 'i' },
] as const satisfies Columns;

/** `content.trash`, the Masa `ttrash` rows of content object classes; `objectstring` is byte-exact WDDX. */
export const TRASH = unitTable('content.trash', TRASH_COLUMNS, ['objectid']);

const GROUP_PROJECTION_COLUMNS = [
  TENANT_ID,
  { name: 'group_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'group_name', type: 's' },
  { name: 'is_public', type: 'i' },
  { name: 'deleted', type: 'i' },
] as const satisfies Columns;

/** `content.group_projection`: group names fed by `identity.group.changed.v1`. */
export const GROUP_PROJECTION = nonUnitTable('group_projection', GROUP_PROJECTION_COLUMNS, ['group_id']);

const PERMISSION_PROJECTION_COLUMNS = [
  TENANT_ID,
  { name: 'group_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'content_id', type: 's' },
  { name: 'type', type: 's' },
] as const satisfies Columns;

/** `content.permission_projection`: node verdicts per group fed by `identity.permission.changed.v1`. */
export const PERMISSION_PROJECTION = nonUnitTable('permission_projection', PERMISSION_PROJECTION_COLUMNS, [
  'group_id',
  'site_id',
  'content_id',
  'type',
]);

const MEMBERSHIP_PROJECTION_COLUMNS = [
  TENANT_ID,
  { name: 'user_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'group_id', type: 's' },
] as const satisfies Columns;

/** `content.membership_projection`: user-to-group links fed by `identity.membership.changed.v1`. */
export const MEMBERSHIP_PROJECTION = nonUnitTable('membership_projection', MEMBERSHIP_PROJECTION_COLUMNS, ['user_id', 'group_id']);

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly ContentUnit[]> = { readonly [I in keyof T]: ContentUnitTableDefinition<T[I] & ContentUnit> };

/** Every unit table, in `CONTENT_UNITS` order. */
export const UNIT_TABLES: TablesForUnits<typeof CONTENT_UNITS> = [
  APPROVAL_ACTION,
  APPROVAL_ASSIGNMENT,
  APPROVAL_CHAIN,
  APPROVAL_MEMBERSHIP,
  APPROVAL_REQUEST,
  CATEGORY,
  CHANGESET,
  CHANGESET_CATEGORY_ASSIGN,
  CHANGESET_ROLLBACK,
  CHANGESET_TAG_ASSIGN,
  COMMENT,
  COMMENTER,
  CONTENT,
  CONTENT_ASSIGNMENT,
  CATEGORY_ASSIGN,
  CONTENT_OBJECT,
  CONTENT_RATING,
  CONTENT_RELATED,
  REMOTE_POINTER,
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
  FILENAME_ARCHIVE,
  FORM_RESPONSE_PACKET,
  FORM_RESPONSE_QUESTION,
  PUBLIC_SUBMISSION_APPROVAL,
  SOURCE_MAP,
  TRASH,
  VARIATION_TARGETING,
];

/** Every owned table, unit tables first, then `NON_UNIT_TABLE_NAMES` in order; the `tables` of the content repository. */
export const OWNED_TABLES: readonly ContentTableDefinition[] = [
  ...UNIT_TABLES,
  FILE_OBJECT,
  GROUP_PROJECTION,
  PERMISSION_PROJECTION,
  MEMBERSHIP_PROJECTION,
];

/** Unit id of each unit table, by bare table name, for `awaitReadable` before raw reads. */
export const UNIT_OF = Object.freeze(Object.fromEntries(UNIT_TABLES.map((definition) => [definition.table, definition.unit]))) as {
  readonly [U in ContentUnit as TableOfUnit<U>]: U;
};

/** The column PostgreSQL assigns by default (`GENERATED BY DEFAULT AS IDENTITY`) of each table that has one. */
export const IDENTITY_COLUMNS = Object.freeze({
  content: 'tcontent_id',
  content_related: 'relatedcontentid',
  content_tag: 'tagid',
  extend_attribute: 'attributeid',
  extend_data: 'dataid',
} as const satisfies { readonly [T in ContentTableName]?: string });

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** pg value of a canonical tag; int8 and boolean columns, which pg returns as decimal strings and booleans, are overridden per table. */
type ColumnValue<T extends CanonicalType> = T extends 's' | 'd' ? string : T extends 'i' | 'f' ? number : T extends 't' ? Date : Buffer;

/** A row of definition `D` as pg returns it, keyed by column name; `NotNull` columns are never null. */
export type RowOf<D extends { columns: Columns }, NotNull extends ColumnName<D['columns']> = never> = {
  [K in D['columns'][number] as K['name']]: ColumnValue<K['type']> | (K['name'] extends NotNull ? never : null);
};

/** Row `R` with the value types `O` names replaced, keeping each column's nullability. */
type Override<R, O extends Partial<Record<keyof R, unknown>>> = {
  [K in keyof R]: K extends keyof O ? O[K] | (null extends R[K] ? null : never) : R[K];
};

/** A `content` row: one content version. */
export type ContentRow = RowOf<typeof CONTENT, 'tenant_id' | 'tcontent_id' | 'forcessl'>;
/** A `content_object` row. */
export type ContentObjectRow = RowOf<typeof CONTENT_OBJECT, 'tenant_id' | 'contenthistid' | 'objectid' | 'object' | 'orderno' | 'columnid'>;
/** A `content_related` row. */
export type ContentRelatedRow = RowOf<
  typeof CONTENT_RELATED,
  'tenant_id' | 'contenthistid' | 'relatedid' | 'contentid' | 'siteid' | 'relatedcontentid'
>;
/** A `content_tag` row. */
export type ContentTagRow = RowOf<typeof CONTENT_TAG, 'tenant_id' | 'tagid' | 'contenthistid' | 'contentid' | 'siteid' | 'tag'>;
/** A `content_category_assign` row. */
export type CategoryAssignRow = RowOf<typeof CATEGORY_ASSIGN, 'tenant_id' | 'contenthistid' | 'categoryid'>;
/** A `category` row. */
export type CategoryRow = RowOf<typeof CATEGORY, 'tenant_id' | 'categoryid'>;
/** A `content_assignment` row. */
export type ContentAssignmentRow = RowOf<typeof CONTENT_ASSIGNMENT, 'tenant_id' | 'contentid' | 'contenthistid' | 'siteid' | 'userid'>;
/** A `content_stats` row. */
export type ContentStatsRow = RowOf<
  typeof CONTENT_STATS,
  'tenant_id' | 'contentid' | 'siteid' | 'views' | 'rating' | 'totalvotes' | 'upvotes' | 'downvotes' | 'comments'
>;
/** A `content_rating` row. */
export type ContentRatingRow = RowOf<typeof CONTENT_RATING, 'tenant_id' | 'contentid' | 'userid' | 'siteid'>;
/** A `comment` row. */
export type CommentRow = RowOf<typeof COMMENT, 'tenant_id' | 'commentid'>;
/** A `commenter` row. */
export type CommenterRow = RowOf<typeof COMMENTER, 'tenant_id' | 'commenterid'>;
/** A `feed` row. */
export type FeedRow = RowOf<typeof FEED, 'tenant_id' | 'feedid'>;
/** A `feed_item` row. */
export type FeedItemRow = RowOf<typeof FEED_ITEM, 'tenant_id' | 'feedid' | 'itemid'>;
/** A `feed_advanced_param` row; the numeric `param` arrives as a decimal string. */
export type FeedAdvancedParamRow = RowOf<typeof FEED_ADVANCED_PARAM, 'tenant_id' | 'paramid' | 'feedid'>;
/** A `filename_archive` row. */
export type FilenameArchiveRow = RowOf<typeof FILENAME_ARCHIVE, 'tenant_id' | 'archiveid'>;
/** A `source_map` row. */
export type SourceMapRow = RowOf<typeof SOURCE_MAP, 'tenant_id' | 'mapid'>;
/** A `content_remote_pointer` row. */
export type RemotePointerRow = RowOf<typeof REMOTE_POINTER, 'tenant_id' | 'pointerid'>;
/** A `variation_targeting` row. */
export type VariationTargetingRow = RowOf<typeof VARIATION_TARGETING, 'tenant_id' | 'targetingid'>;
/** A `display_title_approval` row, with its multiset bookkeeping. */
export type DisplayTitleApprovalRow = RowOf<typeof DISPLAY_TITLE_APPROVAL, 'tenant_id' | 'contentid' | 'legacy_row_hash' | 'occurrence'>;
/** A `public_submission_approval` row, with its multiset bookkeeping. */
export type PublicSubmissionApprovalRow = RowOf<
  typeof PUBLIC_SUBMISSION_APPROVAL,
  'tenant_id' | 'contentid' | 'legacy_row_hash' | 'occurrence'
>;
/** A `file` row; bytea columns arrive as Buffers. */
export type FileRow = RowOf<typeof FILE, 'tenant_id' | 'fileid'>;
/** A `file_metadata` row. */
export type FileMetadataRow = RowOf<typeof FILE_METADATA, 'tenant_id' | 'metaid'>;
/** A `file_object` row; the int8 `size` arrives as a decimal string and `orphan` as a boolean. */
export type FileObjectRow = Override<
  RowOf<typeof FILE_OBJECT, 'tenant_id' | 'file_id' | 'variant' | 'ext' | 'object_key' | 'size' | 'sha256' | 'orphan' | 'created_at'>,
  { size: string; orphan: boolean }
>;
/** An `approval_chain` row. */
export type ApprovalChainRow = RowOf<typeof APPROVAL_CHAIN, 'tenant_id' | 'chainid'>;
/** An `approval_membership` row. */
export type ApprovalMembershipRow = RowOf<typeof APPROVAL_MEMBERSHIP, 'tenant_id' | 'membershipid'>;
/** An `approval_assignment` row. */
export type ApprovalAssignmentRow = RowOf<typeof APPROVAL_ASSIGNMENT, 'tenant_id' | 'assignmentid'>;
/** An `approval_request` row. */
export type ApprovalRequestRow = RowOf<typeof APPROVAL_REQUEST, 'tenant_id' | 'requestid'>;
/** An `approval_action` row. */
export type ApprovalActionRow = RowOf<typeof APPROVAL_ACTION, 'tenant_id' | 'actiontid'>;
/** A `changeset` row. */
export type ChangesetRow = RowOf<typeof CHANGESET, 'tenant_id' | 'changesetid'>;
/** A `changeset_rollback` row. */
export type ChangesetRollbackRow = RowOf<typeof CHANGESET_ROLLBACK, 'tenant_id' | 'rollbackid'>;
/** A `changeset_category_assign` row. */
export type ChangesetCategoryAssignRow = RowOf<typeof CHANGESET_CATEGORY_ASSIGN, 'tenant_id' | 'assignmentid'>;
/** A `changeset_tag_assign` row. */
export type ChangesetTagAssignRow = RowOf<typeof CHANGESET_TAG_ASSIGN, 'tenant_id' | 'assignmentid'>;
/** A `form_response_packet` row. */
export type FormResponsePacketRow = RowOf<typeof FORM_RESPONSE_PACKET, 'tenant_id' | 'responseid'>;
/** A `form_response_question` row. */
export type FormResponseQuestionRow = RowOf<typeof FORM_RESPONSE_QUESTION, 'tenant_id' | 'responseid' | 'formid' | 'formfield'>;
/** An `extend_subtype` row. */
export type ExtendSubtypeRow = RowOf<typeof EXTEND_SUBTYPE, 'tenant_id' | 'subtypeid'>;
/** An `extend_set` row. */
export type ExtendSetRow = RowOf<typeof EXTEND_SET, 'tenant_id' | 'extendsetid'>;
/** An `extend_attribute` row. */
export type ExtendAttributeRow = RowOf<typeof EXTEND_ATTRIBUTE, 'tenant_id' | 'attributeid'>;
/** An `extend_rc_set` row. */
export type ExtendRcsetRow = RowOf<typeof EXTEND_RCSET, 'tenant_id' | 'name' | 'relatedcontentsetid'>;
/** An `extend_data` row. */
export type ExtendDataRow = RowOf<typeof EXTEND_DATA, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;
/** A `trash` row of the content share. */
export type TrashRow = RowOf<
  typeof TRASH,
  'tenant_id' | 'objectid' | 'parentid' | 'siteid' | 'objectlabel' | 'objectclass' | 'objecttype' | 'objectsubtype' | 'deletedby'
>;
/** A `group_projection` row; `deleted` arrives as a boolean. */
export type GroupProjectionRow = Override<RowOf<typeof GROUP_PROJECTION, 'tenant_id' | 'group_id' | 'deleted'>, { deleted: boolean }>;
/** A `permission_projection` row. */
export type PermissionProjectionRow = RowOf<typeof PERMISSION_PROJECTION, 'tenant_id' | 'group_id' | 'site_id' | 'content_id' | 'type'>;
/** A `membership_projection` row. */
export type MembershipProjectionRow = RowOf<typeof MEMBERSHIP_PROJECTION, 'tenant_id' | 'user_id' | 'group_id'>;
