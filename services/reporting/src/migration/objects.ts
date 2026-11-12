// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Object manifest of the export-job unit, one manifest page with each page of `GET /internal/v1/migration/export`. */
import type { MigrationHandlerOptions, ObjectManifestEntry } from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import { listJobObjects, type JobObject } from '../repo/queries.js';
import type { ReportingRepository } from '../repo/repository.js';
import { EXPORT_BUCKET, EXPORT_JOB } from '../repo/tables.js';

/** Collaborators `src/app.ts` hands to `createExportObjects`. */
export type ExportObjectsDeps = { storage: StoragePort; repository: ReportingRepository };

/** Fixture table whose `output` column held the bytes. */
const LEGACY_TABLE = 'synthetic.export_job';

/** The manifest entry of one job output with the size and SHA-256 of the object as stored, or null when the object is absent. */
async function manifestEntry(storage: StoragePort, job: JobObject): Promise<ObjectManifestEntry | null> {
  const head = await storage.head(EXPORT_BUCKET, job.objectKey);
  if (head === null) return null;
  return {
    key: job.objectKey,
    size: head.size,
    sha256: head.sha256,
    ...(job.contentType === undefined ? {} : { contentType: job.contentType }),
    // The legacy bytes live in a row, not a file, so their location is the fixture table plus the job id.
    legacyPath: `${LEGACY_TABLE}/${job.jobId}`,
  };
}

// The manifest is read in the export transaction the platform passes, so `deps.repository` is unread;
// it keeps the `{ storage, repository }` wiring `src/app.ts` passes.
/** Builds the `exportObjects` callback: one page of the tenant's stored export outputs for `reporting.export_job`, none for other units. */
export function createExportObjects(deps: ExportObjectsDeps): NonNullable<MigrationHandlerOptions['exportObjects']> {
  const { storage } = deps;
  return async (tx, { unit, after, limit }) => {
    // Only the export-job unit stores objects; any other unit's empty manifest goes whole with its first export page.
    if (unit !== EXPORT_JOB.unit) return [];
    const page = await listJobObjects(tx, { after, limit });
    const objects: ObjectManifestEntry[] = [];
    // Heads run one at a time, so a page never fans out into concurrent storage requests.
    for (const job of page.objects) {
      const entry = await manifestEntry(storage, job);
      if (entry !== null) objects.push(entry);
    }
    return { objects, next: page.next };
  };
}
