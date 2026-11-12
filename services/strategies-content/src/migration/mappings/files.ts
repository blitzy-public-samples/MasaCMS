/** Masa `tfiles` and `tcontentfilemetadata` ↔ `content.file` and `content.file_metadata`, and the tenant source of file rows. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, TenantSource } from '@opt2/platform/migration-kit';
import { FILE, FILE_METADATA } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapped columns for legacy spellings, each taking the name and canonical type of its lower-cased target column. */
function ownedColumns(legacyTable: string, target: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name) => {
    const column = target.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${target.unit} has no column ${name.toLowerCase()}`);
    const { name: targetName, ...type } = column;
    return { legacy: name, target: targetName, ...type };
  });
}

/** Tenant of a `tfiles` row, shared by the row and stored-object paths: its `siteID`, which is the pool site for pooled files. */
export const TFILES_TENANT_SOURCE: TenantSource = Object.freeze({ kind: 'site', column: 'siteID' });

/** Masa `tfiles` ↔ `content.file`; the `image`, `imageSmall` and `imageMedium` bytes stay `bytea` columns. */
export const tfilesMapping: Mapping = defineMapping({
  legacyTable: 'tfiles',
  targetTable: FILE.unit,
  unit: FILE.unit,
  // Live-catalog order: core/setup/db/mssql.sql:270-284, then core/mura/dbUpdates/5.2.1.2893.cfm:225 and 6.1.cfm:45-53.
  columns: ownedColumns('tfiles', FILE, [
    'fileID', 'contentID', 'siteID', 'moduleID', 'filename', 'image', 'imageSmall', 'imageMedium', 'fileSize',
    'contentType', 'contentSubType', 'fileExt', 'created', 'deleted', 'caption', 'credits', 'alttext', 'remoteID',
    'remoteURL', 'remotePubDate', 'remoteSource', 'remoteSourceURL', 'exif',
  ]),
  key: FILE.key,
  tenant: TFILES_TENANT_SOURCE,
});

/** Masa ORM table `tcontentfilemetadata` ↔ `content.file_metadata`; tenant from the row's `siteID`. */
export const tcontentfilemetadataMapping: Mapping = defineMapping({
  legacyTable: 'tcontentfilemetadata',
  targetTable: FILE_METADATA.unit,
  unit: FILE_METADATA.unit,
  // Live-catalog order of the ORM schema; the gps* properties are commented out in contentFileMetaDataBean.cfc, so no columns.
  columns: ownedColumns('tcontentfilemetadata', FILE_METADATA, [
    'altText', 'contenthistid', 'fileid', 'credits', 'siteID', 'remoteURL', 'exif', 'remoteID', 'remoteSourceURL',
    'remoteSource', 'remotePubDate', 'metaID', 'contentid', 'caption',
  ]),
  key: FILE_METADATA.key,
  tenant: { kind: 'site', column: 'siteID' },
});
