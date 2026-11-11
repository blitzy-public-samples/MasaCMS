// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Object manifest of the attachment unit, returned with the first page of `GET /internal/v1/migration/export`. */
import { programTableName } from '@opt2/platform/migration-kit';
import type { MigrationHandlerOptions, ObjectManifestEntry } from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import { FINANCE_ATTACHMENT } from '../repo/tables.js';
import { listAttachmentObjects, type AttachmentObject } from '../repo/queries.js';
import type { FinanceRepository } from '../repo/repository.js';

/** Collaborators `src/app.ts` hands to `createExportObjects`. */
export type ExportObjectsDeps = { storage: StoragePort; repository: FinanceRepository };

/** Bare fixture table whose `content` column held the bytes; folded from every `Program_<id>` schema. */
const LEGACY_TABLE = 'finance_attachment';

/** The manifest entry of one stored attachment, with its size and SHA-256 exactly as stored. */
function manifestEntry(row: AttachmentObject): ObjectManifestEntry {
  return {
    key: row.object_key,
    size: row.size,
    sha256: row.sha256,
    contentType: row.content_type,
    // The legacy bytes live in a row, not a file, so their location is the Program table plus the row's key.
    legacyPath: `${programTableName(row.legacy_program_id, LEGACY_TABLE)}/${row.attachment_id}`,
  };
}

// The manifest entry has no download-URL or bucket field, so nothing is signed and `_deps` is unread;
// the parameter keeps the `{ storage, repository }` wiring `src/app.ts` passes.
/** Builds the `exportObjects` callback: the tenant's attachment objects for `finance.attachment`, none for other units. */
export function createExportObjects(_deps: ExportObjectsDeps): NonNullable<MigrationHandlerOptions['exportObjects']> {
  return async (tx, { unit }) => {
    // The platform asks for objects on the first export page of every unit; only the attachment unit stores any.
    if (unit !== FINANCE_ATTACHMENT.unit) return [];
    return (await listAttachmentObjects(tx)).map(manifestEntry);
  };
}
