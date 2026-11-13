/** Stored objects of `content-files`: the migration transfer of legacy file-store bytes and the object manifest export of `content.file`. */
import {
  DEFAULT_EXPORT_LIMIT,
  requestMigrationAuthority,
  sha256Hex,
  type ApplyOrigin,
  type MigrationHandlerOptions,
  type ObjectManifestEntry,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import {
  StorageObjectNotFoundError,
  contentFileKey,
  type BucketName,
  type ContentFileVariant,
  type OpenedObject,
  type StoragePort,
} from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { listFileObjectsForExport, type FileObjectExportRow } from '../repo/files.js';
import type { ContentRepository } from '../repo/repository.js';
import { FILE, type FileObjectRow } from '../repo/tables.js';

/** The bucket of legacy file-store objects, written only by strategies-content. */
export const CONTENT_FILES_BUCKET = 'content-files' satisfies BucketName;

/** Rendition suffix of a stored object: `''` for the original, `_source`, `_small`, `_medium`, or an on-demand rendition. */
export type FileVariant = ContentFileVariant;

/** One legacy file-store object as the migration service sends it; the route has already validated every field. */
export interface MigrationObjectRequest {
  /** Tenant of the object's `tfiles` row as the sender resolved it, the umbrella tenant for a pooled or orphan file; the wire carries no site id. */
  tenantId: string;
  fileId: string;
  variant: FileVariant;
  /** The object's own extension, which differs from the file's for FLV renditions (`jpg`). */
  ext: string;
  contentType: string;
  /** Lowercase hex SHA-256 the sender computed over `bytes`. */
  sha256: string;
  bytes: Buffer;
  /** Changelog origin of the manifest write; `backfill` when absent, as the wire carries none and the projector skips every migration origin alike. */
  origin?: ApplyOrigin;
  requestId?: string;
}

/** Collaborators of `storeMigrationObject`. */
export interface StoreObjectDeps {
  db: TenantDb;
  repository: ContentRepository;
  storage: StoragePort;
  clock: Clock;
}

/** The stored object's manifest row; `key`, `size`, `sha256` and `created` form the contract's `FileObject`. */
export interface StoredObjectResult {
  tenantId: string;
  key: string;
  fileId: string;
  variant: string;
  ext: string;
  size: number;
  sha256: string;
  contentType: string | null;
  /** True when no `content.file` row has the object's file id. */
  orphan: boolean;
  /** False when the key already held the same SHA-256, so nothing was written. */
  created: boolean;
}

/** `row` in result form. */
function resultOf(row: FileObjectRow, created: boolean): StoredObjectResult {
  return {
    tenantId: row.tenant_id,
    key: row.object_key,
    fileId: row.file_id,
    variant: row.variant,
    ext: row.ext,
    size: Number(row.size),
    sha256: row.sha256,
    contentType: row.content_type,
    orphan: row.orphan,
    created,
  };
}

/**
 * Stores one legacy object in `content-files` under `<tenantId>/<fileId><variant>.<ext>` and records its `content.file_object`
 * row, once per SHA-256; a `platform.migration` caller's write passes any `content.file` gate state.
 * @throws LegacyApiError `badRequest` when `bytes` do not hash to `sha256`; nothing is stored then.
 */
export async function storeMigrationObject(deps: StoreObjectDeps, req: MigrationObjectRequest): Promise<StoredObjectResult> {
  if (sha256Hex(req.bytes) !== req.sha256) throw new LegacyApiError('badRequest');
  const key = contentFileKey({ tenantId: req.tenantId, fileId: req.fileId, variant: req.variant, ext: req.ext });
  const { files } = deps.repository;

  const held = await deps.db.withTenant(req.tenantId, (tx) => files.findFileObjectBySha(tx, key));
  if (held !== null && held.sha256 === req.sha256) return resultOf(held, false);

  // Bytes before the row, so no row names a missing object; a retry after a failed row write rewrites the same object.
  const put = await deps.storage.put(CONTENT_FILES_BUCKET, key, req.bytes, { contentType: req.contentType });
  const ctx: WriteContext = { origin: req.origin ?? 'backfill', requestId: req.requestId, authority: requestMigrationAuthority() };
  const stored = await deps.db.withTenant(req.tenantId, async (tx) => {
    const current = await files.findFileObjectBySha(tx, key);
    const orphan = !(await files.fileRowExists(tx, req.fileId));
    return files.upsertFileObject(
      tx,
      {
        file_id: req.fileId,
        variant: req.variant,
        ext: req.ext,
        object_key: key,
        size: put.size,
        sha256: put.sha256,
        content_type: req.contentType,
        orphan,
        created_at: current?.created_at ?? deps.clock.now(),
      },
      ctx,
    );
  });
  return resultOf(stored, true);
}

/** The stored version of the object recorded under `key`, read in the key's own tenant; null when that tenant has no such row or object. */
export async function openMigrationObject(deps: Pick<StoreObjectDeps, 'db' | 'repository' | 'storage'>, key: string): Promise<OpenedObject | null> {
  // Keys are `<tenantId>/<fileId><variant>.<ext>`, so the first segment names the tenant whose row records the object.
  const tenantId = key.slice(0, key.indexOf('/'));
  const row = await deps.db.withTenant(tenantId, (tx) => deps.repository.files.findFileObjectBySha(tx, key));
  if (row === null) return null;
  try {
    return await deps.storage.open(CONTENT_FILES_BUCKET, key);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) return null;
    throw err;
  }
}

/** `row` as a manifest entry; no `legacyPath`, as the row keeps no site directory and a partial path would misname it. */
function manifestEntry(row: FileObjectExportRow): ObjectManifestEntry {
  return {
    key: row.object_key,
    size: Number(row.size),
    sha256: row.sha256,
    ...(row.content_type === null ? {} : { contentType: row.content_type }),
  };
}

/** Object manifest of the `content.file` unit, one page by object key after the owner position `after`; other units store no objects. */
export const exportObjects: NonNullable<MigrationHandlerOptions['exportObjects']> = async (tx, { unit, after, limit = DEFAULT_EXPORT_LIMIT }) => {
  if (unit !== FILE.unit) return [];
  const rows = await listFileObjectsForExport(tx, { afterKey: after, limit });
  // Keyset pages follow the primary key's collation, so the last row read is the position, kept in database order.
  const last = rows.length < limit ? undefined : rows.at(-1);
  return { objects: rows.map(manifestEntry), next: last?.object_key ?? null };
};
