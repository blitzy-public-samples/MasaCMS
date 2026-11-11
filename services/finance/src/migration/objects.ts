// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Object manifest of the attachment unit, returned with the first page of `GET /internal/v1/migration/export`. */
import { createHash } from 'node:crypto';
import { programTableName } from '@opt2/platform/migration-kit';
import type { MigrationHandlerOptions, ObjectManifestEntry } from '@opt2/platform/migration-kit';
import { StorageObjectNotFoundError, type OpenedObject, type StoragePort } from '@opt2/platform/storage';
import { ATTACHMENT_BUCKET, FINANCE_ATTACHMENT } from '../repo/tables.js';
import { attachmentObjects, type AttachmentObject } from '../repo/queries.js';
import type { FinanceRepository } from '../repo/repository.js';

/** Collaborators `src/app.ts` hands to `createExportObjects`. */
export type ExportObjectsDeps = { storage: StoragePort; repository: FinanceRepository };

/** Bare fixture table whose `content` column held the bytes; folded from every `Program_<id>` schema. */
const LEGACY_TABLE = 'finance_attachment';

/** The manifest entry of the bytes stored under `row.object_key`, sized and hashed as they stream from storage; null when nothing is stored there. */
async function manifestEntry(storage: StoragePort, row: AttachmentObject): Promise<ObjectManifestEntry | null> {
  let opened: OpenedObject;
  try {
    opened = await storage.open(ATTACHMENT_BUCKET, row.object_key);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) return null;
    throw err;
  }
  // The row's size and hash and the stored metadata date from the write; only the bytes show what is stored now.
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of opened.body as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return {
    key: row.object_key,
    size,
    sha256: hash.digest('hex'),
    contentType: opened.head.contentType,
    // The legacy bytes live in a row, not a file, so their location is the Program table plus the row's key.
    legacyPath: `${programTableName(row.legacy_program_id, LEGACY_TABLE)}/${row.attachment_id}`,
  };
}

/** Builds the `exportObjects` callback: one entry per stored object of `finance.attachment`, read one at a time; none for other units or missing objects. */
export function createExportObjects(deps: ExportObjectsDeps): NonNullable<MigrationHandlerOptions['exportObjects']> {
  return async (tx, { unit }) => {
    // The platform asks for objects on the first export page of every unit; only the attachment unit stores any.
    if (unit !== FINANCE_ATTACHMENT.unit) return [];
    const entries: ObjectManifestEntry[] = [];
    for await (const row of attachmentObjects(tx)) {
      const entry = await manifestEntry(deps.storage, row);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  };
}
