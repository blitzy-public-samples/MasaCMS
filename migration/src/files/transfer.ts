// Moves the bytes of each manifest object to strategies-content's `content-files`, under the tenant of its `tfiles` row, and
// deletes the objects a later snapshot no longer holds.
import type { Writable } from 'node:stream';

import { resolveTenant, type TenantSource } from '@opt2/platform/migration-kit';

import { BridgeHashMismatchError, type LegacyFileDownload } from '../legacy/bridge.js';
import { OwnerCallError } from '../owners/index.js';

import { compareManifestKeys, differs, streamDroppedEntries, type ManifestDiff } from './feed.js';
import {
  MANIFEST_PAGE_ROWS,
  readManifestNames,
  readSnapshotFiles,
  snapshotDatabase,
  streamManifest,
  type FileRow,
  type FilesContext,
  type ManifestEntry,
  type ManifestKey,
} from './manifest.js';
import { objectKey } from './names.js';
import { withSpool } from './spool.js';

/** Tenant rule of `tfiles` rows: their own `siteID`, which Masa already sets to the file-pool site. */
const TFILES_TENANT_SOURCE: TenantSource = { kind: 'site', column: 'siteID' };

/** Statuses of a refused upload that concern the caller's credential rather than the object, so they fail the transfer. */
const CALLER_REFUSALS: ReadonlySet<number> = new Set([401, 403]);
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
  /** Entries of the snapshot to plan instead of its whole manifest, such as a feed's added and changed copies; read once, in order. */
  entries?: AsyncIterable<ManifestEntry> | Iterable<ManifestEntry>;
  /** Database whose `tfiles` rows own the objects; defaults to the snapshot's restored database. */
  database?: string;
}

/** A manifest object whose upload the owner refused; it stays untransferred, so reconciliation reports it. */
export interface RejectedObject extends ManifestKey {
  /** `content-files` key the object was sent under. */
  key: string;
  /** HTTP status of the owner's refusal. */
  status: number;
  /** The owner's error code and message, or the call's own message when its answer carries none. */
  error: string;
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
  /** Objects the owner refused one at a time while the transfer went on with the next. */
  rejected: RejectedObject[];
}

/** Outcome of one removal; counts are distinct `content-files` keys, except `misplaced`, which counts manifest copies. */
export interface RemovalResult {
  from: number;
  to: number;
  /** Keys whose stored object the owner deleted. */
  deleted: number;
  /** Keys the owner no longer recorded, as on a repeated run. */
  absent: number;
  /** Keys snapshot `to` still plans for transfer, so their objects stay. */
  retained: number;
  /** Dropped copies outside their `tfiles` site's directory, which were never transferred. */
  misplaced: number;
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

/** Content type parts of one `tfiles` row; `contentType` is null unless both type parts are set. */
interface FileType {
  contentType: string | null;
  fileExt: string;
}

/** The `ManifestKey` part of an entry. */
function keyOf(entry: ManifestEntry): ManifestKey {
  return { siteId: entry.siteId, path: entry.path };
}

// The owner's upload requires a content type, which neither the fileDir store nor the bridge keeps per object, so it is
// read from `tfiles` here. Objects take the type Masa's s3 store gives them (fileDAO.cfc:200-209): their row's type, or
// image/jpeg for an FLV's `.jpg` renditions; objects without a typed row stay octet-stream.
/** Content type parts of a `tfiles` row, undefined without one. */
function fileTypeOf(row: FileRow | undefined): FileType | undefined {
  if (row === undefined) return undefined;
  return {
    contentType: row.contentType && row.contentSubType ? `${row.contentType}/${row.contentSubType}` : null,
    fileExt: (row.fileExt ?? '').toLowerCase(),
  };
}

/** Content type of one object of a `tfiles` row. */
function contentTypeOf(entry: ManifestEntry, type: FileType | undefined, flvRenditionExt: string): string {
  if (type === undefined || type.contentType === null) return OCTET_STREAM;
  const ext = entry.ext.toLowerCase();
  if (ext === type.fileExt) return type.contentType;
  return type.fileExt === FLV_EXT && ext === flvRenditionExt.toLowerCase() ? FLV_RENDITION_CONTENT_TYPE : OCTET_STREAM;
}

/** Destinations of `entries` in order, against the `tfiles` owners and content types of their file ids in `database`. */
async function planBatch(
  ctx: Pick<FilesContext, 'legacy' | 'config'>,
  database: string,
  entries: readonly ManifestEntry[],
): Promise<PlannedObject[]> {
  const files = await readSnapshotFiles(ctx, database, entries.map((entry) => entry.fileId));
  const lookups = { umbrellaSiteId: ctx.config.umbrellaSiteId };
  const { flvRenditionExt } = ctx.config.fileStore;

  return entries.map((entry): PlannedObject => {
    const row = files.get(entry.fileId.toUpperCase());
    // A null site makes resolveTenant answer the umbrella tenant with `orphan: true`, as the `tfiles` backfill does.
    const siteID = entry.orphan ? null : (row?.siteID ?? null);
    const resolved = resolveTenant(TFILES_TENANT_SOURCE, { siteID }, lookups);
    // Masa renders from the row's site directory (fileManager.cfc:244), so a copy elsewhere is never read, and sending
    // it would overwrite the owner's object under the same key.
    const misplaced = !resolved.orphan && resolved.siteId.toLowerCase() !== entry.siteId.toLowerCase();
    return {
      entry,
      tenantId: resolved.tenantId,
      key: objectKey(resolved.tenantId, entry.fileId, entry.variant, entry.ext),
      contentType: contentTypeOf(entry, fileTypeOf(row), flvRenditionExt),
      status: misplaced ? 'misplaced' : 'transfer',
      orphan: resolved.orphan,
    };
  });
}

/** `items` in order, in arrays of at most `size`. */
async function* batchesOf<T>(items: AsyncIterable<T> | Iterable<T>, size: number): AsyncGenerator<T[], void, undefined> {
  let batch: T[] = [];
  for await (const item of items) {
    batch.push(item);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** Destinations of `opts.entries`, or of the snapshot's whole manifest read page by page, planned per MANIFEST_PAGE_ROWS entries. */
async function* streamPlannedObjects(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config'>,
  snapshotSeq: number,
  opts: PlanOptions,
): AsyncGenerator<PlannedObject, void, undefined> {
  const database = opts.database ?? (await snapshotDatabase(ctx, snapshotSeq));
  for await (const batch of batchesOf(opts.entries ?? streamManifest(ctx, snapshotSeq), MANIFEST_PAGE_ROWS)) {
    yield* await planBatch(ctx, database, batch);
  }
}

/**
 * Destination of each manifest object of snapshot `snapshotSeq`, or of `opts.entries`, in order.
 * Orphans go to the umbrella tenant; an object in another directory than its row's site is `misplaced`.
 */
export async function planObjects(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config'>,
  snapshotSeq: number,
  opts: PlanOptions = {},
): Promise<PlannedObject[]> {
  const planned: PlannedObject[] = [];
  for await (const object of streamPlannedObjects(ctx, snapshotSeq, opts)) planned.push(object);
  return planned;
}

/** Downloads one object into `sink`; the digest the bridge verified against its header must also match the manifest hash. */
async function readVerified(ctx: Pick<FilesContext, 'bridge'>, entry: ManifestEntry, sink: Writable): Promise<LegacyFileDownload> {
  const expected = entry.sha256.toLowerCase();
  let got: LegacyFileDownload;
  try {
    got = await ctx.bridge.filesGet(entry.siteId, entry.name, sink);
  } catch (error) {
    if (!(error instanceof BridgeHashMismatchError)) throw error;
    const actual = error.actual === expected ? error.expected : error.actual;
    throw new FileHashMismatchError(entry.siteId, entry.path, expected, actual, { cause: error });
  }
  if (got.sha256 !== expected) throw new FileHashMismatchError(entry.siteId, entry.path, expected, got.sha256);
  return got;
}

/** Spools one planned object's verified bytes to disk, then streams them to strategies-content; `size` is the bytes sent. */
async function sendObject(ctx: Pick<FilesContext, 'bridge' | 'owners'>, planned: PlannedObject): Promise<{ created: boolean; size: number }> {
  const { entry } = planned;
  return withSpool(async (spool) => {
    const got = await readVerified(ctx, entry, await spool.writer());
    const stored = await ctx.owners.putObject(
      {
        tenantId: planned.tenantId,
        fileId: entry.fileId,
        variant: entry.variant,
        ext: entry.ext,
        contentType: planned.contentType,
        sha256: entry.sha256.toLowerCase(),
      },
      { stream: await spool.reader(), size: got.size },
    );
    return { created: stored.created, size: got.size };
  });
}

/** The owner's refusal of this one object's upload: a 4xx answer other than a refusal of the caller's credential. */
function objectRefusal(error: unknown): OwnerCallError | undefined {
  return error instanceof OwnerCallError && error.status >= 400 && error.status < 500 && !CALLER_REFUSALS.has(error.status) ? error : undefined;
}

/** `code: message` of the error in an owner's answer, else the call error's own message. */
function refusalText(error: OwnerCallError): string {
  const detail = (error.body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  const parts = [detail?.code, detail?.message].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join(': ') : error.message;
}

/**
 * Sends each planned `transfer` object of snapshot `snapshotSeq`, or of `opts.entries`, to strategies-content, one object
 * at a time, site after site, planning MANIFEST_PAGE_ROWS entries at a time. An object the owner refuses is recorded in
 * `rejected` and the transfer goes on.
 * @throws FileHashMismatchError when bytes read differ from the manifest; objects already sent stay stored, and a re-run
 *   answers them `unchanged`. Bridge failures, owner credential refusals and owner 5xx answers also stop the transfer.
 */
export async function transferFiles(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config' | 'bridge' | 'owners' | 'logger'>,
  snapshotSeq: number,
  opts: PlanOptions = {},
): Promise<TransferResult> {
  const result: TransferResult = { snapshotSeq, transferred: 0, unchanged: 0, bytes: 0, orphans: [], misplaced: [], rejected: [] };
  // The manifest is ordered by site id first, so each site's objects arrive together.
  let site: { siteId: string; transferred: number; unchanged: number; rejected: number } | undefined;
  const finishSite = (): void => {
    if (site === undefined) return;
    result.transferred += site.transferred;
    result.unchanged += site.unchanged;
    ctx.logger.info(
      `files of snapshot ${String(snapshotSeq)} site ${site.siteId} transferred: ` +
        `${String(site.transferred)} stored, ${String(site.unchanged)} unchanged` +
        (site.rejected > 0 ? `, ${String(site.rejected)} refused by the owner` : ''),
    );
  };

  for await (const planned of streamPlannedObjects(ctx, snapshotSeq, opts)) {
    const { entry } = planned;
    if (site?.siteId !== entry.siteId) {
      finishSite();
      site = { siteId: entry.siteId, transferred: 0, unchanged: 0, rejected: 0 };
    }
    if (planned.orphan) result.orphans.push(keyOf(entry));
    if (planned.status === 'misplaced') {
      result.misplaced.push(keyOf(entry));
      continue;
    }
    let sent: { created: boolean; size: number };
    try {
      sent = await sendObject(ctx, planned);
    } catch (error) {
      const refusal = objectRefusal(error);
      if (refusal === undefined) throw error;
      result.rejected.push({ ...keyOf(entry), key: planned.key, status: refusal.status, error: refusalText(refusal) });
      site.rejected += 1;
      continue;
    }
    if (sent.created) site.transferred += 1;
    else site.unchanged += 1;
    result.bytes += sent.size;
  }
  finishSite();
  if (result.rejected.length > 0) {
    ctx.logger.warn(
      `files of snapshot ${String(snapshotSeq)}: strategies-content refused ${String(result.rejected.length)} objects, which stay untransferred`,
    );
  }
  return result;
}

/** Identity text of a manifest key; NUL cannot occur in a site id or path. */
function keyText(key: ManifestKey): string {
  return `${key.siteId}\u0000${key.path}`;
}

/**
 * Misplaced copies of `batch`, and each `transfer` key whose first dropped copy in key order is in `batch` with whether
 * snapshot `to` still plans it. Copies forming one key share its exact name, so both snapshots' copies of the batch's
 * names, at most one per site and name, decide its keys, each key once.
 */
async function decideBatch(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config'>,
  diff: Pick<ManifestDiff, 'from' | 'to'>,
  databases: { from: string; to: string },
  batch: readonly ManifestEntry[],
): Promise<{ misplaced: number; keys: { key: string; retained: boolean }[] }> {
  const [before, after] = await Promise.all([readManifestNames(ctx, diff.from, batch), readManifestNames(ctx, diff.to, batch)]);
  const kept = new Map(after.map((entry) => [keyText(entry), entry]));
  const droppedCopies = before.filter((entry) => {
    const next = kept.get(keyText(entry));
    return next === undefined || differs(entry, next);
  });
  const [plannedDropped, plannedKept] = await Promise.all([
    planBatch(ctx, databases.from, droppedCopies),
    planBatch(ctx, databases.to, after),
  ]);
  const firstCopy = new Map<string, ManifestEntry>();
  for (const object of plannedDropped) {
    if (object.status !== 'transfer') continue;
    const first = firstCopy.get(object.key);
    if (first === undefined || compareManifestKeys(object.entry, first) < 0) firstCopy.set(object.key, object.entry);
  }
  // Several copies can share one key, such as orphans of two sites, so a key still planned by any copy keeps its object.
  const stillPlanned = new Set(plannedKept.flatMap((object) => (object.status === 'transfer' ? [object.key] : [])));
  const byPath = new Map(plannedDropped.map((object) => [keyText(object.entry), object]));
  const decided = { misplaced: 0, keys: [] as { key: string; retained: boolean }[] };
  for (const entry of batch) {
    const object = byPath.get(keyText(entry));
    if (object === undefined) {
      throw new Error(`manifest of snapshot ${String(diff.from)} no longer drops ${entry.path} of site ${entry.siteId} against snapshot ${String(diff.to)}`);
    }
    if (object.status === 'misplaced') decided.misplaced += 1;
    else if (firstCopy.get(object.key) === object.entry) decided.keys.push({ key: object.key, retained: stillPlanned.has(object.key) });
  }
  return decided;
}

/**
 * Deletes from strategies-content the objects of the copies snapshot `diff.to` removed or changed, placed as snapshot
 * `diff.from` placed them, unless `diff.to` still plans their key; streams the diff, MANIFEST_PAGE_ROWS dropped copies at
 * a time. Runs after the feed's transfer, so a moved key is stored first; a repeat answers deleted keys as `absent`.
 */
export async function removeDroppedObjects(
  ctx: Pick<FilesContext, 'db' | 'legacy' | 'config' | 'owners' | 'logger'>,
  diff: Pick<ManifestDiff, 'from' | 'to'>,
): Promise<RemovalResult> {
  const result: RemovalResult = { from: diff.from, to: diff.to, deleted: 0, absent: 0, retained: 0, misplaced: 0 };
  let databases: { from: string; to: string } | undefined;
  for await (const batch of batchesOf(streamDroppedEntries(ctx, diff.from, diff.to), MANIFEST_PAGE_ROWS)) {
    databases ??= { from: await snapshotDatabase(ctx, diff.from), to: await snapshotDatabase(ctx, diff.to) };
    const decided = await decideBatch(ctx, diff, databases, batch);
    result.misplaced += decided.misplaced;
    for (const { key, retained } of decided.keys) {
      if (retained) {
        result.retained += 1;
      } else if ((await ctx.owners.deleteObject(key)).deleted) {
        result.deleted += 1;
      } else {
        result.absent += 1;
      }
    }
  }
  if (databases === undefined) return result;
  ctx.logger.info(
    `files of snapshot ${String(diff.to)} dropped since snapshot ${String(diff.from)}: ${String(result.deleted)} deleted, ` +
      `${String(result.absent)} already absent, ${String(result.retained)} still planned, ${String(result.misplaced)} misplaced`,
  );
  return result;
}
