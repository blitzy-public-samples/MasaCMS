// Per-snapshot manifest of the legacy file store, listed through the bridge and kept in migration.file_manifest.
import type { MigrationContext } from '../context.js';
import { UnsupportedFileStoreError, type FileListing } from '../legacy/bridge.js';

import { nameFromStorePath, parseStoredName, storePath, type StoredVariant } from './names.js';

/** Context the file-store functions use; each function takes the narrowest part it needs. */
export type FilesContext = Pick<MigrationContext, 'env' | 'config' | 'db' | 'legacy' | 'bridge' | 'owners' | 'logger'>;

/** Identity of a manifest object: its site directory and store-relative path. */
export interface ManifestKey {
  siteId: string;
  /** `<siteId>/cache/file/<name>`. */
  path: string;
}

/** One file-store object recorded for a snapshot; `sha256` is lowercase hex, `orphan` means no `tfiles` row. */
export interface ManifestEntry extends ManifestKey {
  snapshotSeq: number;
  name: string;
  fileId: string;
  variant: StoredVariant;
  ext: string;
  size: number;
  sha256: string;
  orphan: boolean;
}

/** Outcome of one manifest build; `skipped` lists listed names that are not stored-object names. */
export interface ManifestBuildResult {
  snapshotSeq: number;
  database: string;
  sites: number;
  entries: number;
  orphans: number;
  bytes: number;
  skipped: { siteId: string; name: string }[];
}

/** The only legacy file store whose objects can be listed, read and moved. */
export const SUPPORTED_FILE_STORE = 'fileDir';

/** Raised when the legacy file store is not `fileDir`, so the file units cannot move. */
export class FileStoreUnsupportedError extends Error {
  override readonly name = 'FileStoreUnsupportedError';
  readonly code = 'unsupportedFileStore';
  readonly fileStore: string;
  readonly siteId: string;

  constructor(fileStore: string, siteId: string, options?: ErrorOptions) {
    super(`Legacy file store ${JSON.stringify(fileStore)} of site ${siteId} is not ${SUPPORTED_FILE_STORE}`, options);
    this.fileStore = fileStore;
    this.siteId = siteId;
  }
}

const SNAPSHOT_DATABASE_SQL = 'SELECT database_name FROM migration.snapshot WHERE seq = $1';
const SNAPSHOT_SITES_SQL = 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];';
// The varbinary(max) image columns stay unread: only ownership is needed here.
const SNAPSHOT_FILE_OWNERS_SQL = 'SELECT [fileID], [siteID] FROM [dbo].[tfiles];';
const DELETE_MANIFEST_SQL = 'DELETE FROM migration.file_manifest WHERE snapshot_seq = $1';
const MARK_MANIFEST_COMPLETE_SQL = 'UPDATE migration.snapshot SET manifest_complete = true WHERE seq = $1';
const READ_MANIFEST_SQL = [
  'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan',
  'FROM migration.file_manifest',
  'WHERE snapshot_seq = $1',
  'ORDER BY site_id COLLATE "C", path COLLATE "C"',
].join(' ');

const MANIFEST_COLUMNS = [
  'snapshot_seq',
  'site_id',
  'path',
  'file_id',
  'variant',
  'ext',
  'size',
  'sha256',
  'orphan',
  'last_modified',
] as const;
const INSERT_CHUNK_ROWS = 500;

/** Entry as written, with the listing's modification time for `last_modified`. */
interface ManifestRowInput extends ManifestEntry {
  lastModified: string;
}

/** `migration.file_manifest` row as `pg` returns it; `size` is int8, which arrives as a string. */
interface ManifestRow {
  site_id: string;
  path: string;
  file_id: string;
  variant: string;
  ext: string;
  size: string | number;
  sha256: string;
  orphan: boolean;
}

/** Name of the restored database of snapshot `snapshotSeq`, from its `migration.snapshot` row; throws for an unknown snapshot. */
export async function snapshotDatabase(ctx: Pick<FilesContext, 'db'>, snapshotSeq: number): Promise<string> {
  const result = await ctx.db.withMetadata((tx) =>
    tx.query<{ database_name: string }>(SNAPSHOT_DATABASE_SQL, [snapshotSeq]),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`unknown snapshot ${String(snapshotSeq)}`);
  return row.database_name;
}

/** Distinct non-empty site ids of the snapshot database's `tsettings`, in SiteID order. */
export async function readSnapshotSites(ctx: Pick<FilesContext, 'legacy'>, database: string): Promise<string[]> {
  const pool = await ctx.legacy.database(database);
  const result = await pool.request().query<{ SiteID: string | null }>(SNAPSHOT_SITES_SQL);
  return result.recordset.flatMap((row) => (row.SiteID === null || row.SiteID === '' ? [] : [row.SiteID]));
}

/** `tfiles` owners of the snapshot database: upper-cased trimmed `fileID` to its `siteID`, the file-pool site. */
export async function readSnapshotFileOwners(
  ctx: Pick<FilesContext, 'legacy'>,
  database: string,
): Promise<Map<string, string | null>> {
  const pool = await ctx.legacy.database(database);
  const result = await pool.request().query<{ fileID: string; siteID: string | null }>(SNAPSHOT_FILE_OWNERS_SQL);
  return new Map(result.recordset.map((row) => [row.fileID.trim().toUpperCase(), row.siteID]));
}

/** Store named by a bridge 409 `unsupportedFileStore` body, whose `message` carries it. */
function storeOf(error: UnsupportedFileStoreError): string {
  const message = typeof error.body === 'object' && error.body !== null ? (error.body as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message !== '' ? message : 'unknown';
}

/** Lists one site's cached files; a store other than `fileDir` raises FileStoreUnsupportedError. */
async function listSite(ctx: Pick<FilesContext, 'bridge'>, siteId: string): Promise<FileListing> {
  let listing: FileListing;
  try {
    listing = await ctx.bridge.filesList(siteId);
  } catch (error) {
    if (error instanceof UnsupportedFileStoreError) throw new FileStoreUnsupportedError(storeOf(error), siteId, { cause: error });
    throw error;
  }
  if (listing.fileStore !== SUPPORTED_FILE_STORE) throw new FileStoreUnsupportedError(listing.fileStore, siteId);
  return listing;
}

/** Replaces the snapshot's manifest rows with `rows` and marks its manifest complete, in one transaction. */
async function writeManifest(ctx: Pick<FilesContext, 'db'>, snapshotSeq: number, rows: ManifestRowInput[]): Promise<void> {
  await ctx.db.withMetadata(async (tx) => {
    await tx.query(DELETE_MANIFEST_SQL, [snapshotSeq]);
    for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
      const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
      const values: unknown[] = [];
      const tuples = chunk.map((row, index) => {
        values.push(
          row.snapshotSeq,
          row.siteId,
          row.path,
          row.fileId,
          row.variant,
          row.ext,
          row.size,
          row.sha256,
          row.orphan,
          row.lastModified,
        );
        const first = index * MANIFEST_COLUMNS.length;
        return `(${MANIFEST_COLUMNS.map((_column, offset) => `$${String(first + offset + 1)}`).join(', ')})`;
      });
      await tx.query(
        `INSERT INTO migration.file_manifest (${MANIFEST_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
        values,
      );
    }
    await tx.query(MARK_MANIFEST_COMPLETE_SQL, [snapshotSeq]);
  });
}

/**
 * Lists every site of the snapshot through the bridge and records each stored object, replacing earlier rows of the snapshot.
 * Files without a `tfiles` row are kept with `orphan: true`.
 * @param opts.database restored snapshot database; defaults to the one recorded for `snapshotSeq`.
 * @throws FileStoreUnsupportedError before any row is written when the store is not `fileDir`.
 */
export async function buildFileManifest(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'bridge' | 'logger'>,
  snapshotSeq: number,
  opts: { database?: string } = {},
): Promise<ManifestBuildResult> {
  const database = opts.database ?? (await snapshotDatabase(ctx, snapshotSeq));
  const sites = await readSnapshotSites(ctx, database);
  const owners = await readSnapshotFileOwners(ctx, database);

  const listings: { siteId: string; listing: FileListing }[] = [];
  for (const siteId of sites) {
    listings.push({ siteId, listing: await listSite(ctx, siteId) });
  }

  const rows: ManifestRowInput[] = [];
  const skipped: { siteId: string; name: string }[] = [];
  let orphans = 0;
  let bytes = 0;
  for (const { siteId, listing } of listings) {
    for (const file of listing.files) {
      // Parts come from the name itself, not the listing; on-demand renditions such as `_W100_H50` parse as variants
      // and are recorded like fileDAO's, so only names outside the stored-name language are skipped.
      const parsed = parseStoredName(file.name);
      if (parsed === null) {
        skipped.push({ siteId, name: file.name });
        continue;
      }
      // The listing is CFML-serialized JSON; coerce before summing.
      const size = Number(file.size);
      const orphan = !owners.has(parsed.fileId.toUpperCase());
      rows.push({
        snapshotSeq,
        siteId,
        path: storePath(siteId, file.name),
        name: file.name,
        fileId: parsed.fileId,
        variant: parsed.variant,
        ext: parsed.ext,
        size,
        sha256: file.sha256.toLowerCase(),
        orphan,
        lastModified: file.lastModified,
      });
      if (orphan) orphans += 1;
      bytes += size;
    }
  }

  await writeManifest(ctx, snapshotSeq, rows);
  ctx.logger.info(
    `file manifest of snapshot ${String(snapshotSeq)} built: ${String(sites.length)} sites, ` +
      `${String(rows.length)} entries, ${String(orphans)} orphans, ${String(skipped.length)} skipped`,
  );
  return { snapshotSeq, database, sites: sites.length, entries: rows.length, orphans, bytes, skipped };
}

/** Manifest of snapshot `snapshotSeq`, ordered by site id then path in byte order. */
export async function readManifest(ctx: Pick<FilesContext, 'db'>, snapshotSeq: number): Promise<ManifestEntry[]> {
  const result = await ctx.db.withMetadata((tx) => tx.query<ManifestRow>(READ_MANIFEST_SQL, [snapshotSeq]));
  return result.rows.map((row) => ({
    snapshotSeq,
    siteId: row.site_id,
    path: row.path,
    name: nameFromStorePath(row.path),
    fileId: row.file_id,
    variant: row.variant as StoredVariant,
    ext: row.ext,
    size: Number(row.size),
    sha256: row.sha256,
    orphan: row.orphan,
  }));
}
