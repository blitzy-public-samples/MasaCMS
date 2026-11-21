/** Migration mappings of Masa `tcontent` and its version child tables into schema `content`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import {
  CONTENT,
  CONTENT_ASSIGNMENT,
  CONTENT_RELATED,
  CONTENT_TAG,
  DISPLAY_TITLE_APPROVAL,
  FILENAME_ARCHIVE,
  PUBLIC_SUBMISSION_APPROVAL,
  REMOTE_POINTER,
  SOURCE_MAP,
  VARIATION_TARGETING,
} from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

// Legacy names keep the live catalog spelling and order of opt2/table-ownership.json; target names and canonical
// types come from the repository definitions, so a mapping can never disagree with the table it writes.

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** Masa `tcontent` ↔ `content.content`, one row per version keyed by its IDENTITY `tcontent_ID`; tenant from `SiteID`. */
export const tcontentMapping: Mapping = defineMapping({
  legacyTable: 'tcontent',
  targetTable: CONTENT.unit,
  unit: CONTENT.unit,
  columns: columnsOf('tcontent', CONTENT, [
    'tcontent_ID', 'SiteID', 'ModuleID', 'ParentID', 'ContentID', 'ContentHistID', 'RemoteID', 'RemoteURL',
    'RemotePubDate', 'RemoteSourceURL', 'RemoteSource', 'Credits', 'FileID', 'Template', 'Type', 'subType', 'Active',
    'OrderNo', 'Title', 'MenuTitle', 'Summary', 'Filename', 'MetaDesc', 'MetaKeyWords', 'Body', 'lastUpdate',
    'lastUpdateBy', 'lastUpdateByID', 'DisplayStart', 'DisplayStop', 'Display', 'Approved', 'IsNav', 'Restricted',
    'RestrictGroups', 'Target', 'TargetParams', 'responseChart', 'responseMessage', 'responseSendTo',
    'responseDisplayFields', 'moduleAssign', 'displayTitle', 'Notes', 'inheritObjects', 'isFeature', 'ReleaseDate',
    'IsLocked', 'nextN', 'sortBy', 'sortDirection', 'featureStart', 'featureStop', 'forceSSL', 'audience', 'keyPoints',
    'searchExclude', 'path', 'tags', 'doCache', 'urltitle', 'htmltitle', 'created', 'mobileExclude', 'changesetID',
    'imageSize', 'imageHeight', 'imageWidth', 'childTemplate', 'majorVersion', 'minorVersion', 'expires',
    'displayInterval', 'objectParams',
  ]),
  key: CONTENT.key,
  tenant: { kind: 'site', column: 'SiteID' },
});

/** Masa `tcontentrelated` ↔ `content.content_related`, keyed by its IDENTITY `relatedContentID`; tenant from `siteID`. */
export const tcontentrelatedMapping: Mapping = defineMapping({
  legacyTable: 'tcontentrelated',
  targetTable: CONTENT_RELATED.unit,
  unit: CONTENT_RELATED.unit,
  columns: columnsOf('tcontentrelated', CONTENT_RELATED, [
    'contentHistID', 'relatedID', 'contentID', 'siteID', 'relatedContentSetID', 'orderNo', 'relatedContentID',
  ]),
  key: CONTENT_RELATED.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tcontenttags` ↔ `content.content_tag`, keyed by its IDENTITY `tagID`; tenant from the space-padded `siteID`. */
export const tcontenttagsMapping: Mapping = defineMapping({
  legacyTable: 'tcontenttags',
  targetTable: CONTENT_TAG.unit,
  unit: CONTENT_TAG.unit,
  columns: columnsOf('tcontenttags', CONTENT_TAG, ['tagID', 'contentHistID', 'contentID', 'siteID', 'tag', 'taggroup']),
  key: CONTENT_TAG.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tcontentassignments` ↔ `content.content_assignment`; tenant from `siteID`. */
export const tcontentassignmentsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentassignments',
  targetTable: CONTENT_ASSIGNMENT.unit,
  unit: CONTENT_ASSIGNMENT.unit,
  columns: columnsOf('tcontentassignments', CONTENT_ASSIGNMENT, ['contentID', 'contentHistID', 'siteID', 'userID', 'type']),
  key: CONTENT_ASSIGNMENT.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** ORM `tcontentfilenamearchive` ↔ `content.filename_archive`; tenant from `siteID`. */
export const tcontentfilenamearchiveMapping: Mapping = defineMapping({
  legacyTable: 'tcontentfilenamearchive',
  targetTable: FILENAME_ARCHIVE.unit,
  unit: FILENAME_ARCHIVE.unit,
  columns: columnsOf('tcontentfilenamearchive', FILENAME_ARCHIVE, ['siteID', 'archiveid', 'contentID', 'filename']),
  key: FILENAME_ARCHIVE.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** ORM `tcontentsourcemaps` ↔ `content.source_map`; tenant from `siteid`. */
export const tcontentsourcemapsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentsourcemaps',
  targetTable: SOURCE_MAP.unit,
  unit: SOURCE_MAP.unit,
  columns: columnsOf('tcontentsourcemaps', SOURCE_MAP, ['siteid', 'created', 'sourceid', 'contenthistid', 'mapid', 'contentid']),
  key: SOURCE_MAP.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** ORM `tcontentremotepointer` ↔ `content.content_remote_pointer`; tenant from `siteID`. */
export const tcontentremotepointerMapping: Mapping = defineMapping({
  legacyTable: 'tcontentremotepointer',
  targetTable: REMOTE_POINTER.unit,
  unit: REMOTE_POINTER.unit,
  // `created` is text, not a timestamp: the ORM property misspells its datatype attribute
  // [core/mura/content/contentRemotePointerBean.cfc:12], so Masa creates the column with its default varchar type.
  columns: columnsOf('tcontentremotepointer', REMOTE_POINTER, ['siteID', 'remoteid', 'remoteurl', 'created', 'pointerid', 'contentid']),
  key: REMOTE_POINTER.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** ORM `tcontentvariationtargeting` ↔ `content.variation_targeting`; scripts are byte-exact text; tenant from `siteid`. */
export const tcontentvariationtargetingMapping: Mapping = defineMapping({
  legacyTable: 'tcontentvariationtargeting',
  targetTable: VARIATION_TARGETING.unit,
  unit: VARIATION_TARGETING.unit,
  columns: columnsOf('tcontentvariationtargeting', VARIATION_TARGETING, ['targetingid', 'siteid', 'initjs', 'targetingjs', 'contentid']),
  key: VARIATION_TARGETING.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** Masa `tcontentdisplaytitleapprovals` ↔ `content.display_title_approval`, keyless (multiset rows); tenant from `siteid`. */
export const tcontentdisplaytitleapprovalsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentdisplaytitleapprovals',
  targetTable: DISPLAY_TITLE_APPROVAL.unit,
  unit: DISPLAY_TITLE_APPROVAL.unit,
  columns: columnsOf('tcontentdisplaytitleapprovals', DISPLAY_TITLE_APPROVAL, ['contentid', 'isApproved', 'email', 'siteid']),
  key: DISPLAY_TITLE_APPROVAL.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** Masa `tcontentpublicsubmissionapprovals` ↔ `content.public_submission_approval`, keyless (multiset rows); tenant from `siteid`. */
export const tcontentpublicsubmissionapprovalsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentpublicsubmissionapprovals',
  targetTable: PUBLIC_SUBMISSION_APPROVAL.unit,
  unit: PUBLIC_SUBMISSION_APPROVAL.unit,
  columns: columnsOf('tcontentpublicsubmissionapprovals', PUBLIC_SUBMISSION_APPROVAL, ['contentid', 'isApproved', 'email', 'siteid']),
  key: PUBLIC_SUBMISSION_APPROVAL.key,
  tenant: { kind: 'site', column: 'siteid' },
});
