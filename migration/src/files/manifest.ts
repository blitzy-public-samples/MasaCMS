// Per-snapshot manifest of the legacy file store, listed through the bridge and kept in migration.file_manifest.
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { MetadataTx } from '@opt2/platform/tenancy';
import sql from 'mssql';

import type { MigrationContext } from '../context.js';
import { UnsupportedFileStoreError, type FileListing, type LegacyFileEntry } from '../legacy/bridge.js';

import { STORED_NAME_PATTERN, nameFromStorePath, parseStoredName, storePath, type StoredName, type StoredVariant } from './names.js';

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

/** Why a listed name is left out of the manifest. */
export type SkipReason = 'not a stored-object name' | 'file id is not a CF UUID';

/** Outcome of one manifest build; `skipped` lists listed names that are not stored-object names. */
export interface ManifestBuildResult {
  snapshotSeq: number;
  database: string;
  sites: number;
  entries: number;
  orphans: number;
  bytes: number;
  skipped: { siteId: string; name: string; reason: SkipReason }[];
}

/** The only legacy file store whose objects can be listed, read and moved. */
export const SUPPORTED_FILE_STORE = 'fileDir';

/** Default entries per manifest page read. */
export const MANIFEST_PAGE_ROWS = 1000;

/** Most file ids one `tfiles` lookup binds, well below SQL Server's 2,100 parameters per request; also the most names one manifest lookup binds. */
export const FILE_LOOKUP_IDS = 1000;

/** The `tfiles` columns the file store needs of one row: its file-pool site and content type parts. */
export interface FileRow {
  fileID: string;
  siteID: string | null;
  contentType: string | null;
  contentSubType: string | null;
  fileExt: string | null;
}

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
// The varbinary(max) image columns stay unread: only ownership and the content type parts are needed.
const SNAPSHOT_FILES_SQL = 'SELECT [fileID], [siteID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles] WHERE [fileID] IN';
/** Width of `tfiles.fileID`, `char(35)` [core/setup/db/mssql.sql:271]. */
const FILE_ID_LENGTH = 35;
const DELETE_MANIFEST_SQL = 'DELETE FROM migration.file_manifest WHERE snapshot_seq = $1';
const MARK_MANIFEST_COMPLETE_SQL = 'UPDATE migration.snapshot SET manifest_complete = true WHERE seq = $1';
const SELECT_MANIFEST = 'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest';
const MANIFEST_ORDER = 'ORDER BY site_id COLLATE "C", path COLLATE "C"';
const READ_MANIFEST_FIRST_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 ${MANIFEST_ORDER} LIMIT $2`;
const READ_MANIFEST_PAGE_SQL =
  `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND (site_id COLLATE "C", path COLLATE "C") > ($2, $3) ` +
  `${MANIFEST_ORDER} LIMIT $4`;
// bpchar[] keeps the comparison on file_id's own type, so file_manifest_file_id_idx serves it; the unnested
// (file_id, variant, ext) triples then keep only the exact names asked.
const READ_MANIFEST_NAMES_SQL =
  `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND file_id = ANY($2::bpchar[]) ` +
  `AND (file_id, variant, ext) IN (SELECT * FROM unnest($2::bpchar[], $3::text[], $4::text[])) ${MANIFEST_ORDER}`;
const SPILL_PREFIX = 'opt2-file-manifest-';
const SPILL_FILE = 'rows.ndjson';

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

/**
 * `tfiles` rows of `fileIds` in database `database`, by upper-cased trimmed `fileID`; one parameterized query per
 * FILE_LOOKUP_IDS distinct ids, and none without ids.
 */
export async function readSnapshotFiles(
  ctx: Pick<FilesContext, 'legacy'>,
  database: string,
  fileIds: Iterable<string>,
): Promise<Map<string, FileRow>> {
  const ids = [...new Set(Array.from(fileIds, (fileId) => fileId.toUpperCase()))];
  const files = new Map<string, FileRow>();
  if (ids.length === 0) return files;
  const pool = await ctx.legacy.database(database);
  for (let start = 0; start < ids.length; start += FILE_LOOKUP_IDS) {
    const chunk = ids.slice(start, start + FILE_LOOKUP_IDS);
    const request = pool.request();
    chunk.forEach((fileId, index) => request.input(`p${String(index)}`, sql.Char(FILE_ID_LENGTH), fileId));
    const params = chunk.map((_fileId, index) => `@p${String(index)}`).join(', ');
    const result = await request.query<FileRow>(`${SNAPSHOT_FILES_SQL} (${params});`);
    for (const row of result.recordset) files.set(row.fileID.trim().toUpperCase(), row);
  }
  return files;
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

/** Inserts one chunk of manifest rows in a single statement. */
async function insertChunk(tx: MetadataTx, chunk: readonly ManifestRowInput[]): Promise<void> {
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
  await tx.query(`INSERT INTO migration.file_manifest (${MANIFEST_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

/** Replaces the snapshot's manifest rows with `rows` and marks its manifest complete, in one transaction. */
async function writeManifest(ctx: Pick<FilesContext, 'db'>, snapshotSeq: number, rows: AsyncIterable<ManifestRowInput>): Promise<void> {
  await ctx.db.withMetadata(async (tx) => {
    await tx.query(DELETE_MANIFEST_SQL, [snapshotSeq]);
    let chunk: ManifestRowInput[] = [];
    for await (const row of rows) {
      chunk.push(row);
      if (chunk.length === INSERT_CHUNK_ROWS) {
        await insertChunk(tx, chunk);
        chunk = [];
      }
    }
    if (chunk.length > 0) await insertChunk(tx, chunk);
    await tx.query(MARK_MANIFEST_COMPLETE_SQL, [snapshotSeq]);
  });
}

/** Appends `rows` to the spill file, one JSON line each. */
async function spillRows(handle: FileHandle, rows: readonly ManifestRowInput[]): Promise<void> {
  if (rows.length > 0) await handle.appendFile(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

/** Rows of a spill file in written order. */
async function* spilledRows(spill: string): AsyncGenerator<ManifestRowInput, void, undefined> {
  const input = createReadStream(spill, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) yield JSON.parse(line) as ManifestRowInput;
  } finally {
    input.destroy();
  }
}

/** Counts of one manifest build. */
type BuildCounts = Pick<ManifestBuildResult, 'entries' | 'orphans' | 'bytes' | 'skipped'>;

/**
 * Lists the sites one at a time and appends each one's stored objects to `spill` in insert-sized chunks, flagging as
 * orphans those whose file id has no `tfiles` row in `database`, looked up per chunk.
 */
async function spillSites(
  ctx: Pick<FilesContext, 'bridge' | 'legacy'>,
  snapshotSeq: number,
  sites: readonly string[],
  database: string,
  spill: string,
): Promise<BuildCounts> {
  const counts: BuildCounts = { entries: 0, orphans: 0, bytes: 0, skipped: [] };
  const handle = await open(spill, 'wx');
  try {
    for (const siteId of sites) {
      const listing = await listSite(ctx, siteId);
      const stored: { file: LegacyFileEntry; parsed: StoredName }[] = [];
      for (const file of listing.files) {
        // Parts come from the name itself, not the listing; on-demand renditions such as `_W100_H50` parse as variants
        // and are recorded like fileDAO's, so only names outside the stored-name language are skipped.
        const parsed = parseStoredName(file.name);
        if (parsed === null) {
          const reason: SkipReason = STORED_NAME_PATTERN.test(file.name) ? 'file id is not a CF UUID' : 'not a stored-object name';
          counts.skipped.push({ siteId, name: file.name, reason });
          continue;
        }
        stored.push({ file, parsed });
      }
      for (let start = 0; start < stored.length; start += INSERT_CHUNK_ROWS) {
        const chunk = stored.slice(start, start + INSERT_CHUNK_ROWS);
        const owned = await readSnapshotFiles(ctx, database, chunk.map(({ parsed }) => parsed.fileId));
        const rows = chunk.map(({ file, parsed }): ManifestRowInput => {
          // The listing is CFML-serialized JSON; coerce before summing.
          const size = Number(file.size);
          const orphan = !owned.has(parsed.fileId.toUpperCase());
          counts.entries += 1;
          if (orphan) counts.orphans += 1;
          counts.bytes += size;
          return {
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
          };
        });
        await spillRows(handle, rows);
      }
    }
  } finally {
    await handle.close();
  }
  return counts;
}

/**
 * Lists every site of the snapshot through the bridge and records each stored object, replacing earlier rows of the snapshot.
 * Files without a `tfiles` row are kept with `orphan: true`; each skipped name is logged as a warning with its reason.
 * @param opts.database restored snapshot database; defaults to the one recorded for `snapshotSeq`.
 * @param opts.spillDir parent of the temporary directory the listed rows are spilled to; defaults to the OS temporary directory.
 * @throws FileStoreUnsupportedError before any row is written when the store is not `fileDir`.
 */
export async function buildFileManifest(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'bridge' | 'logger'>,
  snapshotSeq: number,
  opts: { database?: string; spillDir?: string } = {},
): Promise<ManifestBuildResult> {
  const database = opts.database ?? (await snapshotDatabase(ctx, snapshotSeq));
  const sites = await readSnapshotSites(ctx, database);

  const dir = await mkdtemp(join(opts.spillDir ?? tmpdir(), SPILL_PREFIX));
  try {
    const spill = join(dir, SPILL_FILE);
    const { entries, orphans, bytes, skipped } = await spillSites(ctx, snapshotSeq, sites, database, spill);
    await writeManifest(ctx, snapshotSeq, spilledRows(spill));
    ctx.logger.info(
      `file manifest of snapshot ${String(snapshotSeq)} built: ${String(sites.length)} sites, ` +
        `${String(entries)} entries, ${String(orphans)} orphans, ${String(skipped.length)} skipped`,
    );
    for (const { siteId, name, reason } of skipped) {
      ctx.logger.warn(`file manifest of snapshot ${String(snapshotSeq)} skipped ${name} of site ${siteId}: ${reason}`);
    }
    return { snapshotSeq, database, sites: sites.length, entries, orphans, bytes, skipped };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Entry of one `migration.file_manifest` row. */
function manifestEntry(snapshotSeq: number, row: ManifestRow): ManifestEntry {
  return {
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
  };
}

/**
 * Up to `limit` entries of snapshot `snapshotSeq` following key `after`, or from the start when it is undefined, ordered
 * by site id then path in byte order.
 */
export async function readManifestPage(
  ctx: Pick<FilesContext, 'db'>,
  snapshotSeq: number,
  after: ManifestKey | undefined,
  limit: number = MANIFEST_PAGE_ROWS,
): Promise<ManifestEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`manifest page size must be a positive integer, not ${String(limit)}`);
  }
  const result = await ctx.db.withMetadata((tx) =>
    after === undefined
      ? tx.query<ManifestRow>(READ_MANIFEST_FIRST_PAGE_SQL, [snapshotSeq, limit])
      : tx.query<ManifestRow>(READ_MANIFEST_PAGE_SQL, [snapshotSeq, after.siteId, after.path, limit]),
  );
  return result.rows.map((row) => manifestEntry(snapshotSeq, row));
}

/**
 * Entries of snapshot `snapshotSeq` whose file id, variant and extension are exactly those of one of `names`, at most one
 * per site and name; one query per FILE_LOOKUP_IDS distinct names, each in readManifest order, and none without names.
 */
export async function readManifestNames(
  ctx: Pick<FilesContext, 'db'>,
  snapshotSeq: number,
  names: readonly StoredName[],
): Promise<ManifestEntry[]> {
  const distinct = [...new Map(names.map((name) => [`${name.fileId}\u0000${name.variant}\u0000${name.ext}`, name])).values()];
  const entries: ManifestEntry[] = [];
  for (let start = 0; start < distinct.length; start += FILE_LOOKUP_IDS) {
    const chunk = distinct.slice(start, start + FILE_LOOKUP_IDS);
    const values = [snapshotSeq, chunk.map((name) => name.fileId), chunk.map((name) => name.variant), chunk.map((name) => name.ext)];
    const result = await ctx.db.withMetadata((tx) => tx.query<ManifestRow>(READ_MANIFEST_NAMES_SQL, values));
    for (const row of result.rows) entries.push(manifestEntry(snapshotSeq, row));
  }
  return entries;
}

/** Manifest of snapshot `snapshotSeq` in readManifest order, one keyset page of `opts.pageRows` entries per query. */
export async function* streamManifest(
  ctx: Pick<FilesContext, 'db'>,
  snapshotSeq: number,
  opts: { pageRows?: number } = {},
): AsyncGenerator<ManifestEntry, void, undefined> {
  const pageRows = opts.pageRows ?? MANIFEST_PAGE_ROWS;
  let after: ManifestKey | undefined;
  for (;;) {
    const page = await readManifestPage(ctx, snapshotSeq, after, pageRows);
    yield* page;
    const last = page.at(-1);
    if (last === undefined || page.length < pageRows) return;
    after = { siteId: last.siteId, path: last.path };
  }
}

/** Manifest of snapshot `snapshotSeq`, ordered by site id then path in byte order. */
export async function readManifest(ctx: Pick<FilesContext, 'db'>, snapshotSeq: number): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for await (const entry of streamManifest(ctx, snapshotSeq)) entries.push(entry);
  return entries;
}
