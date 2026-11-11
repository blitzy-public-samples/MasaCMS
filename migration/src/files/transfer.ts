// Moves the bytes of each manifest object to strategies-content's `content-files`, under the tenant of its `tfiles` row.
import { resolveTenant, sha256Hex, type TenantSource } from '@opt2/platform/migration-kit';

import { BridgeHashMismatchError, type LegacyFileBytes } from '../legacy/bridge.js';

import {
  readManifest,
  readSnapshotFileOwners,
  snapshotDatabase,
  type FilesContext,
  type ManifestEntry,
  type ManifestKey,
} from './manifest.js';
import { objectKey } from './names.js';

/** Tenant rule of `tfiles` rows: their own `siteID`, which Masa already sets to the file-pool site. */
const TFILES_TENANT_SOURCE: TenantSource = { kind: 'site', column: 'siteID' };

// The varbinary(max) image columns stay unread: only the parts of the object's content type are needed here.
const SNAPSHOT_FILE_TYPES_SQL = 'SELECT [fileID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles];';
const OCTET_STREAM = 'application/octet-stream';
const FLV_EXT = 'flv';
const FLV_RENDITION_CONTENT_TYPE = 'image/jpeg';

/** One manifest object with its destination; a `misplaced` object lies outside its `tfiles` site's directory and is never sent. */
export interface PlannedObject {
  entry: ManifestEntry;
  tenantId: string;
  /** `content-files` key `<tenantId>/<fileId><variant>.<ext>`. */
  key: string;
  /** Content type stored with the object. */
  contentType: string;
  status: 'transfer' | 'misplaced';
  /** True when the object has no `tfiles` row and is placed under the umbrella tenant. */
  orphan: boolean;
}

/** Options of {@link planObjects} and {@link transferFiles}. */
export interface PlanOptions {
  /** Keeps only these `(siteId, path)` keys, such as a feed's changed objects. */
  only?: ReadonlyArray<ManifestKey>;
  /** Database whose `tfiles` rows own the objects; defaults to the snapshot's restored database. */
  database?: string;
}

/** Outcome of one transfer; `unchanged` counts objects the owner already held with the same SHA-256. */
export interface TransferResult {
  snapshotSeq: number;
  transferred: number;
  unchanged: number;
  /** Bytes sent to the owner. */
  bytes: number;
  orphans: ManifestKey[];
  misplaced: ManifestKey[];
}

/** Raised when bytes read from the legacy store do not hash to the manifest's SHA-256; nothing is sent for that object. */
export class FileHashMismatchError extends Error {
  override readonly name = 'FileHashMismatchError';
  readonly siteId: string;
  readonly path: string;
  /** Manifest SHA-256, lowercase hex. */
  readonly expected: string;
  /** Digest of the bytes read, or the bridge's `X-Opt2-Sha256` when only that differs; lowercase hex, `''` for a missing header. */
  readonly actual: string;

  constructor(siteId: string, path: string, expected: string, actual: string, options?: ErrorOptions) {
    super(`Legacy file ${path} of site ${siteId} hashes to ${actual || '(none)'}, not the manifest's ${expected}`, options);
    this.siteId = siteId;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/** `tfiles` row as mssql returns the selected columns. */
interface FileTypeRow {
  fileID: string;
  contentType: string | null;
  contentSubType: string | null;
  fileExt: string | null;
}

/** Content type parts of one `tfiles` row; `contentType` is null unless both type parts are set. */
interface FileType {
  contentType: string | null;
  fileExt: string;
}

/** Identity text of a manifest key; NUL cannot occur in a site id or path. */
function keyText(key: ManifestKey): string {
  return `${key.siteId}\u0000${key.path}`;
}

/** The `ManifestKey` part of an entry. */
function keyOf(entry: ManifestEntry): ManifestKey {
  return { siteId: entry.siteId, path: entry.path };
}

// The owner's upload requires a content type, which neither the fileDir store nor the bridge keeps per object, so it is
// read from `tfiles` here. Objects take the type Masa's s3 store gives them (fileDAO.cfc:200-209): their row's type, or
// image/jpeg for an FLV's `.jpg` renditions; objects without a typed row stay octet-stream.
/** Content types of the database's `tfiles` rows, by upper-cased trimmed `fileID`. */
async function readSnapshotFileTypes(ctx: Pick<FilesContext, 'legacy'>, database: string): Promise<Map<string, FileType>> {
  const pool = await ctx.legacy.database(database);
  const result = await pool.request().query<FileTypeRow>(SNAPSHOT_FILE_TYPES_SQL);
  return new Map(
    result.recordset.map((row) => [
      row.fileID.trim().toUpperCase(),
      {
        contentType: row.contentType && row.contentSubType ? `${row.contentType}/${row.contentSubType}` : null,
        fileExt: (row.fileExt ?? '').toLowerCase(),
      },
    ]),
  );
}

/** Content type of one object of a `tfiles` row. */
function contentTypeOf(entry: ManifestEntry, type: FileType | undefined, flvRenditionExt: string): string {
  if (type === undefined || type.contentType === null) return OCTET_STREAM;
  const ext = entry.ext.toLowerCase();
  if (ext === type.fileExt) return type.contentType;
  return type.fileExt === FLV_EXT && ext === flvRenditionExt.toLowerCase() ? FLV_RENDITION_CONTENT_TYPE : OCTET_STREAM;
}

/**
 * Destination of each manifest object of snapshot `snapshotSeq`, in manifest order.
 * Orphans go to the umbrella tenant; an object in another directory than its row's site is `misplaced`.
 */
export async function planObjects(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config'>,
  snapshotSeq: number,
  opts: PlanOptions = {},
): Promise<PlannedObject[]> {
  const only = opts.only === undefined ? undefined : new Set(opts.only.map(keyText));
  const entries = (await readManifest(ctx, snapshotSeq)).filter((entry) => only?.has(keyText(entry)) ?? true);
  const database = opts.database ?? (await snapshotDatabase(ctx, snapshotSeq));
  const [owners, types] = await Promise.all([readSnapshotFileOwners(ctx, database), readSnapshotFileTypes(ctx, database)]);
  const lookups = { umbrellaSiteId: ctx.config.umbrellaSiteId };
  const { flvRenditionExt } = ctx.config.fileStore;

  return entries.map((entry): PlannedObject => {
    const fileId = entry.fileId.toUpperCase();
    // A null site makes resolveTenant answer the umbrella tenant with `orphan: true`, as the `tfiles` backfill does.
    const siteID = entry.orphan ? null : (owners.get(fileId) ?? null);
    const resolved = resolveTenant(TFILES_TENANT_SOURCE, { siteID }, lookups);
    // Masa renders from the row's site directory (fileManager.cfc:244), so a copy elsewhere is never read, and sending
    // it would overwrite the owner's object under the same key.
    const misplaced = !resolved.orphan && resolved.siteId.toLowerCase() !== entry.siteId.toLowerCase();
    return {
      entry,
      tenantId: resolved.tenantId,
      key: objectKey(resolved.tenantId, entry.fileId, entry.variant, entry.ext),
      contentType: contentTypeOf(entry, types.get(fileId), flvRenditionExt),
      status: misplaced ? 'misplaced' : 'transfer',
      orphan: resolved.orphan,
    };
  });
}

/** Plan grouped by site directory, in first-appearance order. */
function bySite(plan: readonly PlannedObject[]): Map<string, PlannedObject[]> {
  const groups = new Map<string, PlannedObject[]>();
  for (const planned of plan) {
    const group = groups.get(planned.entry.siteId);
    if (group === undefined) groups.set(planned.entry.siteId, [planned]);
    else group.push(planned);
  }
  return groups;
}

/** Bytes of one object, which both the bridge's header and their own digest must match to the manifest hash. */
async function readVerified(ctx: Pick<FilesContext, 'bridge'>, entry: ManifestEntry): Promise<Buffer> {
  const expected = entry.sha256.toLowerCase();
  let got: LegacyFileBytes;
  try {
    got = await ctx.bridge.filesGet(entry.siteId, entry.name);
  } catch (error) {
    if (!(error instanceof BridgeHashMismatchError)) throw error;
    const actual = error.actual === expected ? error.expected : error.actual;
    throw new FileHashMismatchError(entry.siteId, entry.path, expected, actual, { cause: error });
  }
  const actual = [sha256Hex(got.bytes), got.sha256.toLowerCase()].find((hash) => hash !== expected);
  if (actual !== undefined) throw new FileHashMismatchError(entry.siteId, entry.path, expected, actual);
  return got.bytes;
}

/**
 * Sends each planned `transfer` object of snapshot `snapshotSeq` to strategies-content, one object at a time, site after site.
 * @throws FileHashMismatchError when bytes read differ from the manifest; objects already sent stay stored, and a re-run
 *   answers them `unchanged`.
 */
export async function transferFiles(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config' | 'bridge' | 'owners' | 'logger'>,
  snapshotSeq: number,
  opts: PlanOptions = {},
): Promise<TransferResult> {
  const plan = await planObjects(ctx, snapshotSeq, opts);
  const result: TransferResult = { snapshotSeq, transferred: 0, unchanged: 0, bytes: 0, orphans: [], misplaced: [] };

  for (const [siteId, objects] of bySite(plan)) {
    let transferred = 0;
    let unchanged = 0;
    for (const planned of objects) {
      const { entry } = planned;
      if (planned.orphan) result.orphans.push(keyOf(entry));
      if (planned.status === 'misplaced') {
        result.misplaced.push(keyOf(entry));
        continue;
      }
      const bytes = await readVerified(ctx, entry);
      const stored = await ctx.owners.putObject(
        {
          tenantId: planned.tenantId,
          fileId: entry.fileId,
          variant: entry.variant,
          ext: entry.ext,
          contentType: planned.contentType,
          sha256: entry.sha256.toLowerCase(),
        },
        bytes,
      );
      if (stored.created) transferred += 1;
      else unchanged += 1;
      result.bytes += bytes.byteLength;
    }
    result.transferred += transferred;
    result.unchanged += unchanged;
    ctx.logger.info(
      `files of snapshot ${String(snapshotSeq)} site ${siteId} transferred: ` +
        `${String(transferred)} stored, ${String(unchanged)} unchanged`,
    );
  }
  return result;
}
