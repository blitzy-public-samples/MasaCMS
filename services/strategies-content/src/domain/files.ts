/** Non-image uploads, file version deletes, file metadata and `/_api/render/*` object resolution (Masa fileBean, fileManager and fileDAO, `fileDir` store). */
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { contentFileKey, type ContentFileVariant, type StoragePort } from '@opt2/platform/storage';
import { registryEntryForTenant, type TenantTx } from '@opt2/platform/tenancy';
import { CONTENT_FILES_BUCKET } from '../migration/objects.js';
import type { ContentFilesDeletion, ContentRepository, Patch } from '../repo/repository.js';
import type { FileMetadataRow, FileObjectRow, FileRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type DomainDeps } from './context.js';
import { UnregisteredTenantError, withPoolTenant } from './pools.js';

/** Upload extensions whose renditions Masa writes with ColdFusion's image engine (fileDAO.cfc:159-179); those uploads stay legacy-written. */
export const IMAGE_UPLOAD_EXTS = ['png', 'gif', 'jpg', 'jpeg', 'flv'] as const;

/** Extensions renderFile serves a sized rendition of (fileManager.cfc:238). */
const RENDITION_EXTS = 'png,jpg,jpeg,gif';

// `tusers.photoFileID` is absent on purpose: legacy assigns that query to rs4 and the placeholderImgID query overwrites it,
// so a user photo reference never keeps a file.
/** Legacy deleteIfNotUsed checks of tables other owners hold, which this service cannot read; a file only they reference is still flagged. */
export const DELETE_IF_NOT_USED_UNCHECKED = ['tclassextenddatauseractivity', 'tsettings.placeholderImgID'] as const;

/** Whether `ext` (any case) is an image upload extension. */
export function isImageUploadExt(ext: string): boolean {
  return (IMAGE_UPLOAD_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/** Raised when an image upload reaches the target: its renditions are legacy-written (`EX-FILE-RENDITION`), so the gateway keeps it on legacy. */
export class ImageUploadHaltedError extends Error {
  override readonly name = 'ImageUploadHaltedError';

  constructor(readonly ext: string) {
    super(`Image upload .${ext} is legacy-written (EX-FILE-RENDITION)`);
  }
}

/** One posted file part of a request. */
export interface UploadedFile {
  /** Form field the part was posted under, e.g. `newfile` or `files`. */
  fieldName: string;
  /** Client file name (cffile `clientFile`). */
  fileName: string;
  /** MIME type of the part, `<contentType>/<contentSubType>`. */
  contentType: string;
  bytes: Buffer;
}

/** CFML `listLast(value, '.')`: empty elements are skipped. */
function listLastDot(value: string): string {
  return value.split('.').filter((part) => part !== '').at(-1) ?? '';
}

/** CFML `listFindNoCase(list, value) > 0` over a comma list. */
function listHasNoCase(list: string, value: string): boolean {
  const wanted = value.toLowerCase();
  return list.split(',').some((item) => item !== '' && item.toLowerCase() === wanted);
}

// Only the posted-file branch is ported: target uploads arrive as multipart parts, and legacy's URL-valued field branch
// breaks out of a loop over the ACF form scope, whose iteration order the target cannot reproduce.
/**
 * fileManager.requestHasRestrictedFiles: true when a posted file's extension (CFML `listLast` on `.`) has 1-4
 * characters and is not in `allowedExtensions`; an empty list allows every file.
 */
export function requestHasRestrictedFiles(files: readonly Pick<UploadedFile, 'fileName'>[], allowedExtensions: string): boolean {
  if (allowedExtensions === '') return false;
  return files.some(({ fileName }) => {
    const ext = listLastDot(fileName);
    return ext.length > 0 && ext.length < 5 && !listHasNoCase(allowedExtensions, ext);
  });
}

/** cffile `serverFileExt` of a client file name: the text after its last dot, '' without one. */
function uploadExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1);
}

/** cffile `contentType` and `contentSubType` of a MIME type. */
function splitMime(mime: string): [string, string] {
  const slash = mime.indexOf('/');
  return slash < 0 ? [mime, ''] : [mime.slice(0, slash), mime.slice(slash + 1)];
}

/** Collaborators of an upload. */
export type UploadDeps = Pick<DomainDeps, 'db' | 'repository' | 'clock' | 'config'> & { storage: StoragePort };

/** An upload and the fileBean values it is saved with. */
export interface StoreUploadArgs {
  file: UploadedFile;
  /** The owning item; empty for a multi-file upload, which links it later with `setFileContentId`. */
  contentId?: string | null;
  /** Module of the owning item; the fileBean default (site tree) when absent. */
  moduleId?: string;
  caption?: string | null;
  credits?: string | null;
  alttext?: string | null;
  remoteId?: string | null;
  remoteUrl?: string | null;
  remotePubDate?: Date | null;
  remoteSource?: string | null;
  remoteSourceUrl?: string | null;
  requestId?: string;
}

/**
 * A saved upload with the `fileID` and `filename` the saving bean takes: the stored row and object, or legacy's
 * rejection of an extension outside `fmAllowedExtensions` (a fresh id that names no row).
 */
export type StoredUpload =
  | { kind: 'stored'; fileid: string; filename: string; file: FileRow; object: FileObjectRow }
  | { kind: 'rejected'; fileid: string; filename: string };

/**
 * fileBean.save → fileManager.create → fileDAO.create for a non-image upload: stores the bytes under the site's file
 * pool tenant in `content-files`, then the `content.file` row (siteid = the site's filePoolID) and its object row.
 * @throws ImageUploadHaltedError for an image extension; UnregisteredTenantError when the token tenant has no file pool.
 */
export async function storeUploadedFile(deps: UploadDeps, actor: Actor, args: StoreUploadArgs): Promise<StoredUpload> {
  const serverExt = uploadExt(args.file.fileName);
  if (isImageUploadExt(serverExt)) throw new ImageUploadHaltedError(serverExt);

  const fileId = cfUuid();
  const allowed = deps.config.fmAllowedExtensions;
  if (allowed !== '' && !listHasNoCase(allowed, serverExt)) {
    return { kind: 'rejected', fileid: fileId, filename: `Invalid file type .${serverExt.toUpperCase()}` };
  }

  // The pool is resolved once, before the bytes are written, so the key's tenant prefix and the row's tenant cannot
  // differ; withGatedPoolTenant would resolve it again inside the transaction.
  const entry = await registryEntryForTenant(deps.db, actor.tenantId);
  const poolTenantId = entry?.filePoolTenant ?? null;
  if (entry === null || poolTenantId === null) throw new UnregisteredTenantError(actor.tenantId);

  const ext = serverExt.toLowerCase();
  const objectKey = contentFileKey({ tenantId: poolTenantId, fileId, variant: '', ext });
  const mime = args.file.contentType;
  // Bytes before the row: a failed transaction leaves an object without a row, which reconciliation reports as an orphan.
  const put = await deps.storage.put(CONTENT_FILES_BUCKET, objectKey, args.file.bytes, { contentType: mime });
  const [contentType, contentSubType] = splitMime(mime);
  const write = writeContextFor(actor, args.requestId);

  return withGatedTenant(deps.db, poolTenantId, async (tx) => {
    const now = deps.clock.now();
    const file = await deps.repository.files.insertFile(
      tx,
      {
        fileid: fileId,
        contentid: args.contentId ?? null,
        siteid: entry.filePoolId || entry.siteId,
        ...(args.moduleId === undefined ? {} : { moduleid: args.moduleId }),
        filename: args.file.fileName,
        contenttype: contentType,
        contentsubtype: contentSubType,
        filesize: put.size,
        fileext: ext,
        created: now,
        deleted: 0,
        caption: args.caption ?? null,
        credits: args.credits ?? null,
        alttext: args.alttext ?? null,
        remoteid: args.remoteId ?? null,
        remoteurl: args.remoteUrl ?? null,
        remotepubdate: args.remotePubDate ?? null,
        remotesource: args.remoteSource ?? null,
        remotesourceurl: args.remoteSourceUrl ?? null,
        // cffile results carry an empty exif struct for non-JPEG uploads, which fileBean serializes as '{}'.
        exif: '{}',
      },
      write,
    );
    const object = await deps.repository.files.upsertFileObject(
      tx,
      {
        file_id: fileId,
        variant: '',
        ext,
        object_key: objectKey,
        size: put.size,
        sha256: put.sha256,
        content_type: mime,
        orphan: false,
        created_at: now,
      },
      write,
    );
    return { kind: 'stored', fileid: file.fileid, filename: file.filename ?? '', file, object };
  });
}

/** multiFileUpload's `update tfiles set contentID`: links a stored file to its new item; `tx` is the file pool tenant's. */
export function setFileContentId(
  tx: TenantTx,
  repository: ContentRepository,
  fileId: string,
  contentId: string,
  write?: WriteContext,
): Promise<FileRow | null> {
  return repository.files.updateFile(tx, fileId, { contentid: contentId }, write);
}

/** fileDAO.deleteVersion: flags the file deleted; its objects stay until legacy's purgeDeleted. `tx` is the file pool tenant's. */
export function deleteFileVersion(tx: TenantTx, repository: ContentRepository, fileId: string, write?: WriteContext): Promise<FileRow[]> {
  return repository.files.deleteFileVersion(tx, { fileId }, write);
}

/** Where the `content.file` rows of a content operation live, and the changelog actor of its writes. */
export interface FileTxOptions {
  /** Transaction of the site's file pool tenant; defaults to the content transaction, as for an unpooled site. */
  fileTx?: TenantTx;
  write?: WriteContext;
}

/**
 * fileDAO.deleteIfNotUsed: flags the files deleted unless a content version or extend value outside `baseIds`
 * references one, looked up in the content tenant (`tx`) and the file pool tenant; returns the ids flagged.
 */
export async function deleteIfNotUsed(
  tx: TenantTx,
  repository: ContentRepository,
  fileIds: readonly string[],
  baseIds: readonly string[],
  opts: FileTxOptions = {},
): Promise<string[]> {
  const fileTx = opts.fileTx ?? tx;
  const referencedElsewhere =
    fileTx.tenantId === tx.tenantId ? [] : await repository.files.fileIdsReferencedInContent(tx, fileIds, baseIds);
  return repository.files.deleteIfNotUsed(fileTx, { fileIds, baseIds, referencedElsewhere }, opts.write);
}

/** fileDAO.deleteAll: `deleteIfNotUsed` over the file of every version of `contentId`, those versions excluded. */
export async function deleteAllFiles(
  tx: TenantTx,
  repository: ContentRepository,
  contentId: string,
  opts: FileTxOptions = {},
): Promise<ContentFilesDeletion> {
  const versionFiles = await repository.files.versionFiles(tx, { contentId });
  const deletedFileIds = await deleteIfNotUsed(
    tx,
    repository,
    versionFiles.map((pair) => pair.fileid),
    versionFiles.map((pair) => pair.contenthistid),
    opts,
  );
  return { versionFiles, deletedFileIds };
}

/** Editable metadata of a version's file, by `content.file_metadata` column, as one fileMetaDataAssign entry sets them. */
export type FileMetaDataValues = Partial<
  Pick<FileMetadataRow, 'alttext' | 'caption' | 'credits' | 'remoteid' | 'remoteurl' | 'remotepubdate' | 'remotesource' | 'remotesourceurl' | 'exif'>
>;

/** One fileMetaDataAssign entry: the version, the file its property names, the submitted values and `setAsDefault`. */
export interface SaveFileMetaDataArgs {
  contentId: string;
  contentHistId: string;
  /** Site of the content version. */
  siteId: string;
  fileId: string;
  values: FileMetaDataValues;
  setAsDefault: boolean;
}

/** `tfiles` columns a new metadata bean takes from its file (`set(query)` in contentFileMetaDataBean.loadBy); `siteid` only when set. */
const COPIED_FILE_COLUMNS = [
  'fileid',
  'contentid',
  'caption',
  'credits',
  'alttext',
  'remoteid',
  'remoteurl',
  'remotepubdate',
  'remotesource',
  'remotesourceurl',
  'exif',
] as const satisfies readonly (keyof FileRow & keyof FileMetadataRow)[];

/** SQL Server's equality key of an id: trailing spaces dropped, case ignored. */
function idKey(id: string | null): string {
  return (id ?? '').replace(/ +$/u, '').toLowerCase();
}

/** The bean `serializeExif`: JSON text is kept, anything else becomes '{}'. */
function serializedExif(exif: string | null | undefined): string {
  if (exif === null || exif === undefined) return '{}';
  try {
    JSON.parse(exif);
    return exif;
  } catch {
    return '{}';
  }
}

/** The content type fileBean.save(processFile=false) sets for a `css`, `js`, `html` or `htm` file name (CFML `==`); none otherwise. */
function savedContentType(filename: string | null): Patch<FileRow, 'fileid'> {
  const ext = listLastDot(filename ?? '').toLowerCase();
  if (ext === 'css') return { contenttype: 'text', contentsubtype: 'css' };
  if (ext === 'js') return { contenttype: 'application', contentsubtype: 'javascript' };
  if (ext === 'html' || ext === 'htm') return { contenttype: 'text', contentsubtype: 'html' };
  return {};
}

/** contentFileMetaDataBean.save(setAsDefault=true): copies the metadata onto its file, which is saved without a new upload. */
async function setFileDefaults(fileTx: TenantTx, repository: ContentRepository, meta: FileMetadataRow, write?: WriteContext): Promise<void> {
  const file = meta.fileid === null ? null : await repository.files.readFileMeta(fileTx, meta.fileid);
  // Legacy would insert a bare tfiles row for a missing file; it would have no site, so no tenant could hold it.
  if (file === null) return;
  await repository.files.updateFile(
    fileTx,
    file.fileid,
    {
      caption: meta.caption,
      alttext: meta.alttext,
      credits: meta.credits,
      remoteid: meta.remoteid,
      remoteurl: meta.remoteurl,
      remotepubdate: meta.remotepubdate,
      remotesource: meta.remotesource,
      remotesourceurl: meta.remotesourceurl,
      exif: serializedExif(meta.exif),
      ...savedContentType(file.filename),
    },
    write,
  );
}

/**
 * One pass of contentManager.add's fileMetaDataAssign loop (contentManager.cfc:1640-1646): loads the version's metadata
 * row of the file or starts one from the file's own columns, applies `values`, saves it and, with `setAsDefault`, the file.
 * A new row taking the file's pool site is written in that site's tenant (`opts.fileTx`), where its siteid places it.
 */
export async function saveFileMetaData(
  tx: TenantTx,
  repository: ContentRepository,
  args: SaveFileMetaDataArgs,
  opts: FileTxOptions = {},
): Promise<FileMetadataRow> {
  const fileTx = opts.fileTx ?? tx;
  const loaded = await repository.files.listFileMetadata(tx, { siteId: args.siteId, fileId: args.fileId, contentHistId: args.contentHistId });
  const existing = loaded.find((row) => idKey(row.contentid) === idKey(args.contentId));

  let saved: FileMetadataRow;
  if (existing !== undefined) {
    const exif = serializedExif(args.values.exif === undefined ? existing.exif : args.values.exif);
    const updated = await repository.files.updateFileMetadata(tx, existing.metaid, { ...args.values, exif }, opts.write);
    if (updated === null) throw new Error(`File metadata ${existing.metaid} vanished while it was saved`);
    saved = updated;
  } else {
    const file = args.fileId === '' ? null : await repository.files.readFileAll(fileTx, args.fileId);
    const fromFile: Partial<Pick<FileMetadataRow, (typeof COPIED_FILE_COLUMNS)[number]>> =
      file === null ? {} : Object.fromEntries(COPIED_FILE_COLUMNS.map((column) => [column, file[column]]));
    const row = {
      contentid: args.contentId,
      contenthistid: args.contentHistId,
      siteid: file?.siteid ? file.siteid : args.siteId,
      fileid: args.fileId,
      ...fromFile,
      ...args.values,
    };
    const metaTx = idKey(row.siteid) === idKey(args.siteId) ? tx : fileTx;
    saved = await repository.files.insertFileMetadata(metaTx, { ...row, exif: serializedExif(row.exif) }, opts.write);
  }

  if (args.setAsDefault) await setFileDefaults(fileTx, repository, saved, opts.write);
  return saved;
}

/** Collaborators of a render resolution. */
export type RenderDeps = Pick<DomainDeps, 'db' | 'repository'> & { storage: StoragePort };

/** One `/_api/render/*` request as the route parsed it. */
export interface RenderRequest {
  /** Verified token tenant; the file is read in its file pool tenant. */
  tenantId: string;
  /** `url.fileid`. */
  fileId: string;
  /** `url.size`: `small` and `medium` (any case, as cfswitch matches) take renderSmall and renderMedium, anything else renderFile. */
  size?: string;
}

/** The `content-files` object a render request streams with its `streamFile` metadata, or the legacy outcome when there is none. */
export type RenderResolution =
  | { kind: 'object'; objectKey: string; contentType: string; fileName: string; created: Date | null }
  | { kind: 'not-found' }
  | { kind: 'missing-rendition'; objectKey: string };

/**
 * fileManager.renderFile, renderSmall and renderMedium (`filedir` store, fileManager.cfc:193-353): the object key of the
 * request. A sized rendition of an image that was never stored is `missing-rendition`, since legacy's cropAndScale
 * generation has no target counterpart.
 */
export async function resolveRenderObject(deps: RenderDeps, req: RenderRequest): Promise<RenderResolution> {
  const size = req.size ?? '';
  if (!isCfUuid(req.fileId) || size.includes('.')) return { kind: 'not-found' };

  const found = await withPoolTenant(deps.db, req.tenantId, 'file', async (tx, poolTenantId) => {
    const row = await deps.repository.files.readFileMeta(tx, req.fileId);
    return row === null ? null : { row, poolTenantId };
  });
  if (found === null) return { kind: 'not-found' };

  const { row, poolTenantId } = found;
  const ext = row.fileext ?? '';
  // Legacy builds the path from the requested fileID and the stored fileExt, so the key does too.
  const keyOf = (variant: ContentFileVariant): string => contentFileKey({ tenantId: poolTenantId, fileId: req.fileId, variant, ext });
  const object = (objectKey: string): RenderResolution => ({
    kind: 'object',
    objectKey,
    contentType: `${row.contenttype ?? ''}/${row.contentsubtype ?? ''}`,
    fileName: row.filename ?? '',
    created: row.created,
  });

  // The stored fileExt also names small and medium renditions, so an FLV's `_small.jpg` thumbnail is never found.
  const named = size.toLowerCase();
  if (named === 'small' || named === 'medium') return object(keyOf(`_${named}`));

  if (size !== '' && listHasNoCase(RENDITION_EXTS, ext)) {
    const objectKey = keyOf(`_${size}`);
    return (await deps.storage.head(CONTENT_FILES_BUCKET, objectKey)) === null ? { kind: 'missing-rendition', objectKey } : object(objectKey);
  }
  return object(keyOf(''));
}
