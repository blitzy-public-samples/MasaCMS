/** Tenant-scoped file reads, manifest queries and durable publication intents. */
import { awaitReadable, qualified } from '@opt2/platform/migration-kit';
import type { QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import {
  CONTENT,
  EXTEND_DATA,
  FILE,
  FILE_METADATA,
  FILE_OBJECT,
  UNIT_OF,
  type ContentRow,
  type ExtendDataRow,
  type FileMetadataRow,
  type FileObjectRow,
  type FileRow,
} from './tables.js';

type Column<R> = Extract<keyof R, string>;

/** `fileDAO.read`'s select list, in its order. */
const READ_COLUMNS = [
  'fileid',
  'contentid',
  'siteid',
  'moduleid',
  'filename',
  'filesize',
  'contenttype',
  'contentsubtype',
  'fileext',
  'image',
  'created',
  'alttext',
  'caption',
  'credits',
] as const satisfies readonly Column<FileRow>[];

/** `fileDAO.readMeta`'s select list: `read`'s without `image`. */
const META_COLUMNS = [
  'fileid',
  'contentid',
  'siteid',
  'moduleid',
  'filename',
  'filesize',
  'contenttype',
  'contentsubtype',
  'fileext',
  'created',
  'alttext',
  'caption',
  'credits',
] as const satisfies readonly Column<FileRow>[];

/** `fileDAO.readSmall`'s select list. */
const SMALL_COLUMNS = [
  'fileid',
  'contentid',
  'siteid',
  'moduleid',
  'filename',
  'filesize',
  'contenttype',
  'contentsubtype',
  'fileext',
  'imagesmall',
  'created',
  'alttext',
  'caption',
  'credits',
] as const satisfies readonly Column<FileRow>[];

/** `fileDAO.readMedium`'s select list. */
const MEDIUM_COLUMNS = [
  'fileid',
  'contentid',
  'siteid',
  'moduleid',
  'filename',
  'filesize',
  'contenttype',
  'contentsubtype',
  'fileext',
  'imagemedium',
  'created',
] as const satisfies readonly Column<FileRow>[];

/** The `file_object` columns of the object-manifest export. */
const EXPORT_COLUMNS = ['object_key', 'file_id', 'variant', 'ext', 'size', 'sha256', 'content_type', 'orphan'] as const satisfies readonly Column<FileObjectRow>[];

/** A `fileDAO.read` row. */
export type ReadFileRow = Pick<FileRow, (typeof READ_COLUMNS)[number]>;

/** A `fileDAO.readMeta` row. */
export type ReadFileMetaRow = Pick<FileRow, (typeof META_COLUMNS)[number]>;

/** A `fileDAO.readSmall` row; only rows with a small image are read. */
export type ReadFileSmallRow = Omit<Pick<FileRow, (typeof SMALL_COLUMNS)[number]>, 'imagesmall'> & { imagesmall: Buffer };

/** A `fileDAO.readMedium` row; only rows with a medium image are read. */
export type ReadFileMediumRow = Omit<Pick<FileRow, (typeof MEDIUM_COLUMNS)[number]>, 'imagemedium'> & { imagemedium: Buffer };

/** One stored object of the manifest export. */
export type FileObjectExportRow = Pick<FileObjectRow, (typeof EXPORT_COLUMNS)[number]>;

/** The metadata rows `listFileMetadata` reads: one site's, narrowed to a file, a content version, or both. */
export interface FileMetadataFilter {
  siteId: string;
  fileId?: string;
  contentHistId?: string;
}

/** One keyset page of the manifest export: up to `limit` objects whose key follows `afterKey`. */
export interface FileObjectExportPage {
  afterKey?: string;
  limit: number;
}

/** `names` quoted and comma-joined, in the given order. */
function selectList(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/** Every catalogue column of `def`, quoted, in catalogue order. */
function allColumns(def: { columns: readonly { name: string }[] }): string {
  return selectList(def.columns.map((column) => column.name));
}

const fileCol = (name: Column<FileRow>): string => `"${name}"`;
const metaCol = (name: Column<FileMetadataRow>): string => `"${name}"`;
const objectCol = (name: Column<FileObjectRow>): string => `"${name}"`;
const contentCol = (name: Column<ContentRow>): string => `"${name}"`;
const extendCol = (name: Column<ExtendDataRow>): string => `"${name}"`;

/** SQL `column = param` as SQL Server's char equality; leakproof, unlike lower(), so its index applies under forced RLS. */
const idEquals = (tx: TenantTx, column: string, param: string): string =>
  `(${column} COLLATE ${qualified(tx.schema, 'legacy_char_ci')}) = ${param}::bpchar`;

/** SQL `expr` as SQL Server's case-insensitive collation compares it: trailing spaces dropped, lower-cased. */
const ci = (expr: string): string => `lower(rtrim(${expr}))`;

/** `ci` of a JavaScript string. */
const ciKey = (value: string): string => value.replace(/ +$/, '').toLowerCase();

/** The first row `sql` returns over `params`, or null. */
async function firstRow<R extends QueryResultRow>(tx: TenantTx, sql: string, params: unknown[]): Promise<R | null> {
  const { rows } = await tx.query<R>(sql, params);
  return rows[0] ?? null;
}

/** One `fileDAO.readX` select of the file `fileId`: the `columns` list, optionally only where `present` is not null. */
async function readFileColumns<R extends QueryResultRow>(
  tx: TenantTx,
  fileId: string,
  columns: readonly string[],
  present?: Column<FileRow>,
): Promise<R | null> {
  await awaitReadable(tx, [UNIT_OF.file]);
  const notNull = present === undefined ? '' : ` AND ${fileCol(present)} IS NOT NULL`;
  return firstRow<R>(
    tx,
    `SELECT ${selectList(columns)} FROM ${qualified(tx.schema, FILE.table)} WHERE ${idEquals(tx, fileCol('fileid'), '$1')}${notNull}`,
    [fileId],
  );
}

/** `fileDAO.read`: the file `fileId` with its original image bytes; null when absent. */
export function readFile(tx: TenantTx, fileId: string): Promise<ReadFileRow | null> {
  return readFileColumns<ReadFileRow>(tx, fileId, READ_COLUMNS);
}

/** `fileDAO.readAll`: every column of the file `fileId`; null when absent. */
export function readFileAll(tx: TenantTx, fileId: string): Promise<FileRow | null> {
  return readFileColumns<FileRow>(tx, fileId, FILE.columns.map((column) => column.name));
}

/** `fileDAO.readMeta`: the file `fileId` without image bytes; null when absent. */
export function readFileMeta(tx: TenantTx, fileId: string): Promise<ReadFileMetaRow | null> {
  return readFileColumns<ReadFileMetaRow>(tx, fileId, META_COLUMNS);
}

/** `fileDAO.readSmall`: the file `fileId` with its small rendition; null when absent or without one. */
export function readFileSmall(tx: TenantTx, fileId: string): Promise<ReadFileSmallRow | null> {
  return readFileColumns<ReadFileSmallRow>(tx, fileId, SMALL_COLUMNS, 'imagesmall');
}

/** `fileDAO.readMedium`: the file `fileId` with its medium rendition; null when absent or without one. */
export function readFileMedium(tx: TenantTx, fileId: string): Promise<ReadFileMediumRow | null> {
  return readFileColumns<ReadFileMediumRow>(tx, fileId, MEDIUM_COLUMNS, 'imagemedium');
}

/** The `file` entity feed's rows (`select * from tfiles where siteid = ?`): every column of `siteId`'s files, by `fileid`. */
export async function listFiles(tx: TenantTx, siteId: string): Promise<FileRow[]> {
  await awaitReadable(tx, [UNIT_OF.file]);
  const { rows } = await tx.query<FileRow>(
    `SELECT ${allColumns(FILE)} FROM ${qualified(tx.schema, FILE.table)} WHERE ${ci(fileCol('siteid'))} = ${ci('$1::text')} ORDER BY ${fileCol('fileid')}`,
    [siteId],
  );
  return rows;
}

/** `fileMetaData` entity rows of `filter.siteId`, narrowed to `filter.fileId` and `filter.contentHistId` when given, by `metaid`. */
export async function listFileMetadata(tx: TenantTx, filter: FileMetadataFilter): Promise<FileMetadataRow[]> {
  await awaitReadable(tx, [UNIT_OF.file_metadata]);
  const params: unknown[] = [filter.siteId];
  const predicates = [`${ci(metaCol('siteid'))} = ${ci('$1::text')}`];
  if (filter.fileId !== undefined) {
    params.push(filter.fileId);
    predicates.push(idEquals(tx, metaCol('fileid'), `$${params.length}`));
  }
  if (filter.contentHistId !== undefined) {
    params.push(filter.contentHistId);
    predicates.push(idEquals(tx, metaCol('contenthistid'), `$${params.length}`));
  }
  const { rows } = await tx.query<FileMetadataRow>(
    `SELECT ${allColumns(FILE_METADATA)} FROM ${qualified(tx.schema, FILE_METADATA.table)}` +
      ` WHERE ${predicates.join(' AND ')} ORDER BY ${metaCol('metaid')}`,
    params,
  );
  return rows;
}

// file_object has no unit of its own; its rows are content.file data written in that unit's gated transactions, so the
// user-facing object reads below wait out content.file's write windows as the file reads do.

/** The stored object of variant `variant` (`''`, `_source`, `_small` or `_medium`) of the file `fileId`; null when absent. */
export async function findFileObject(tx: TenantTx, fileId: string, variant: string): Promise<FileObjectRow | null> {
  await awaitReadable(tx, [UNIT_OF.file]);
  return firstRow<FileObjectRow>(
    tx,
    `SELECT ${allColumns(FILE_OBJECT)} FROM ${qualified(tx.schema, FILE_OBJECT.table)}` +
      ` WHERE ${idEquals(tx, objectCol('file_id'), '$1')} AND ${objectCol('variant')} = $2 ORDER BY ${objectCol('object_key')} LIMIT 1`,
    [fileId, variant],
  );
}

/** Every stored object of the file `fileId`, by variant. */
export async function listFileObjects(tx: TenantTx, fileId: string): Promise<FileObjectRow[]> {
  await awaitReadable(tx, [UNIT_OF.file]);
  const { rows } = await tx.query<FileObjectRow>(
    `SELECT ${allColumns(FILE_OBJECT)} FROM ${qualified(tx.schema, FILE_OBJECT.table)}` +
      ` WHERE ${idEquals(tx, objectCol('file_id'), '$1')} ORDER BY ${objectCol('variant')}, ${objectCol('object_key')}`,
    [fileId],
  );
  return rows;
}

// The migration object transfer and the manifest export run while a write window's import holds content.file in phase
// `importing`, so these reads take no gate, as the platform's migration export does; file_object has no unit to wait on.

const FILE_OBJECT_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/** Holds the publication lock of the stored object `objectKey` until `tx` ends, so its bytes and manifest row change together. */
export async function lockFileObjectKey(tx: TenantTx, objectKey: string): Promise<void> {
  await tx.query(FILE_OBJECT_LOCK_SQL, [`${tx.schema}.${FILE_OBJECT.table}:${objectKey}`]);
}

/** A durable content-files publication intent; `committed` once its publication committed with a backup still to delete. */
export interface StagedObjectEntry {
  tenant_id: string;
  stage_id: string;
  object_key: string;
  kind: 'migration' | 'upload';
  file_id: string;
  variant: string;
  ext: string;
  size: number | string;
  sha256: string;
  content_type: string | null;
  state: 'staged' | 'committed';
}

export interface StagedObjectCursor {
  recorded_at: string;
  stage_id: string;
}

/** Records an intent without a changelog row. */
export async function insertStagedObject(tx: TenantTx, entry: StagedObjectEntry): Promise<void> {
  await tx.query(
    `INSERT INTO ${qualified(tx.schema, 'staged_object')}` +
      ' (tenant_id, stage_id, object_key, kind, file_id, variant, ext, size, sha256, content_type, state)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [
      tx.tenantId,
      entry.stage_id,
      entry.object_key,
      entry.kind,
      entry.file_id,
      entry.variant,
      entry.ext,
      entry.size,
      entry.sha256,
      entry.content_type,
      entry.state,
    ],
  );
}

/** Locks an intent and returns its stored form; null when it no longer exists. */
export function claimStagedObject(tx: TenantTx, stageId: string): Promise<StagedObjectEntry | null> {
  return firstRow<StagedObjectEntry>(
    tx,
    `SELECT * FROM ${qualified(tx.schema, 'staged_object')} WHERE stage_id = $1 FOR UPDATE`,
    [stageId],
  );
}

/** Marks an intent whose publication commits with a backup of the replaced version still stored. */
export async function markStagedObjectCommitted(tx: TenantTx, stageId: string): Promise<void> {
  await tx.query(`UPDATE ${qualified(tx.schema, 'staged_object')} SET state = 'committed' WHERE stage_id = $1`, [stageId]);
}

/** Removes a settled intent without a changelog row. */
export async function deleteStagedObject(tx: TenantTx, stageId: string): Promise<void> {
  await tx.query(`DELETE FROM ${qualified(tx.schema, 'staged_object')} WHERE stage_id = $1`, [stageId]);
}

/** Locks one stale page, retaining PostgreSQL's timestamp precision for the cursor. */
export async function listStaleStagedObjects(
  tx: TenantTx,
  graceMs: number,
  limit: number,
  after?: StagedObjectCursor,
): Promise<(StagedObjectEntry & StagedObjectCursor)[]> {
  const { rows } = await tx.query<StagedObjectEntry & StagedObjectCursor>(
    `SELECT s.*, s.recorded_at::text AS recorded_at FROM ${qualified(tx.schema, 'staged_object')} s` +
      " WHERE recorded_at < clock_timestamp() - ($1 * interval '1 millisecond')" +
      (after === undefined ? '' : ' AND (recorded_at, stage_id) > ($3::timestamptz, $4::bpchar)') +
      ' ORDER BY s.recorded_at, stage_id LIMIT $2 FOR UPDATE SKIP LOCKED',
    after === undefined ? [graceMs, limit] : [graceMs, limit, after.recorded_at, after.stage_id],
  );
  return rows;
}

/** Whether reconciliation must wait for stale publication recovery. */
export async function hasStaleStagedObjects(tx: TenantTx, graceMs: number): Promise<boolean> {
  const row = await firstRow(
    tx,
    `SELECT 1 FROM ${qualified(tx.schema, 'staged_object')}` +
      " WHERE recorded_at < clock_timestamp() - ($1 * interval '1 millisecond') LIMIT 1",
    [graceMs],
  );
  return row !== null;
}

/** Tries the publication lock without waiting on a live writer. */
export async function tryLockFileObjectKey(tx: TenantTx, objectKey: string): Promise<boolean> {
  const row = await firstRow<{ locked: boolean }>(
    tx,
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [`${tx.schema}.${FILE_OBJECT.table}:${objectKey}`],
  );
  return row?.locked === true;
}

/** The stored object under `objectKey`, whose `sha256` tells a repeated transfer of the same bytes; null when absent. */
export function findFileObjectBySha(tx: TenantTx, objectKey: string): Promise<FileObjectRow | null> {
  return firstRow<FileObjectRow>(
    tx,
    `SELECT ${allColumns(FILE_OBJECT)} FROM ${qualified(tx.schema, FILE_OBJECT.table)} WHERE ${objectCol('object_key')} = $1`,
    [objectKey],
  );
}

/** Whether a `content.file` row has the id `fileId`, compared as SQL Server compares ids; a stored object without one is an orphan. */
export async function fileRowExists(tx: TenantTx, fileId: string): Promise<boolean> {
  const row = await firstRow(
    tx,
    `SELECT 1 FROM ${qualified(tx.schema, FILE.table)} WHERE ${idEquals(tx, fileCol('fileid'), '$1')} LIMIT 1`,
    [fileId],
  );
  return row !== null;
}

/** One keyset page of the object manifest, by `object_key` ascending, after `page.afterKey` when given. */
export async function listFileObjectsForExport(tx: TenantTx, page: FileObjectExportPage): Promise<FileObjectExportRow[]> {
  // The keyset keeps the primary key's own collation, so its (tenant_id, object_key) index serves every page.
  const from = `SELECT ${selectList(EXPORT_COLUMNS)} FROM ${qualified(tx.schema, FILE_OBJECT.table)}`;
  const order = ` ORDER BY ${objectCol('object_key')}`;
  const { rows } =
    page.afterKey === undefined
      ? await tx.query<FileObjectExportRow>(`${from}${order} LIMIT $1`, [page.limit])
      : await tx.query<FileObjectExportRow>(`${from} WHERE ${objectCol('object_key')} > $1${order} LIMIT $2`, [page.afterKey, page.limit]);
  return rows;
}

/** `fileDAO.purgeDeleted`'s select: ids of files flagged deleted, of `siteId` when it is non-empty. */
export async function listDeletedFileIds(tx: TenantTx, siteId?: string): Promise<string[]> {
  await awaitReadable(tx, [UNIT_OF.file]);
  const from = `SELECT ${fileCol('fileid')} FROM ${qualified(tx.schema, FILE.table)} WHERE ${fileCol('deleted')} = 1`;
  const order = ` ORDER BY ${fileCol('fileid')}`;
  const { rows } = siteId
    ? await tx.query<Pick<FileRow, 'fileid'>>(`${from} AND ${ci(fileCol('siteid'))} = ${ci('$1::text')}${order}`, [siteId])
    : await tx.query<Pick<FileRow, 'fileid'>>(`${from}${order}`);
  return rows.map((row) => row.fileid);
}

/**
 * `fileDAO.deleteIfNotUsed`'s content-schema checks (`tcontent.fileID` and `tclassextenddata.stringValue`): the distinct
 * `fileIds`, in their order, that a content version or an extended attribute value outside `excludeBaseIds` references.
 */
export async function fileIdsReferencedInContent(
  tx: TenantTx,
  fileIds: readonly string[],
  excludeBaseIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(fileIds)];
  if (wanted.length === 0) {
    return [];
  }
  await awaitReadable(tx, [UNIT_OF.content, UNIT_OF.extend_data]);
  // cfqueryparam binds an empty list as one empty string, so legacy's NOT IN never meets an empty list.
  const excluded = excludeBaseIds.length === 0 ? [''] : excludeBaseIds.map(ciKey);
  const { rows } = await tx.query<{ fileid: string }>(
    `SELECT ${ci(contentCol('fileid'))} AS "fileid" FROM ${qualified(tx.schema, CONTENT.table)}` +
      ` WHERE ${ci(contentCol('fileid'))} = ANY($1::text[]) AND ${ci(contentCol('contenthistid'))} <> ALL($2::text[])` +
      ` UNION SELECT ${ci(extendCol('stringvalue'))} FROM ${qualified(tx.schema, EXTEND_DATA.table)}` +
      ` WHERE ${ci(extendCol('stringvalue'))} = ANY($1::text[]) AND ${ci(extendCol('baseid'))} <> ALL($2::text[])`,
    [[...new Set(wanted.map(ciKey))], excluded],
  );
  const referenced = new Set(rows.map((row) => row.fileid));
  return wanted.filter((fileId) => referenced.has(ciKey(fileId)));
}
