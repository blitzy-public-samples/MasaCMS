// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job runner of the `reporting-export-run` task: moves one queued job to running, then to done or failed, as the fixture's runner thread does. */
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { sha256Hex, withGatedTenant } from '@opt2/platform/migration-kit';
import type { ExportRunPayload, ReportingDeps } from './deps.js';
import { transitionJob, type ExportError, type JobState, type TransitionInput, type TransitionOutcome } from './job-state.js';
import { SourceUnavailableError, fetchExportTable } from './sources.js';
import { extensionFor, renderExport } from './writers/index.js';
import { findDefinition } from '../repo/queries.js';
import { EXPORT_BUCKET, exportObjectKey, type ExportDefinitionRow, type ExportJobRow } from '../repo/tables.js';

/** One delivery of a `reporting-export-run` task; `tenantId` is the task's verified tenant, never read from the payload. */
export interface RunExportInput {
  tenantId: string;
  jobId: string;
  payload: ExportRunPayload;
}

/** The terminal state a run recorded, or `skipped` with the state it found when the job was not its to move. */
export type RunExportResult =
  | { outcome: 'done' | 'failed'; state: JobState; error?: ExportError }
  | { outcome: 'skipped'; state: JobState | null };

/** Collaborators the runner uses. */
type RunExportDeps = Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'client'>;

/** The start move's outcome; a started job carries its definition, null when the tenant has none. */
type StartOutcome =
  | Exclude<TransitionOutcome, { outcome: 'legal' }>
  | { outcome: 'legal'; job: ExportJobRow; definition: ExportDefinitionRow | null };

/** A stored export as the done move records it, or the error the failed move records. */
type Produced =
  | { error: ExportError }
  | { error?: undefined; fileName: string; contentType: string; objectKey: string; outputSha256: string };

/** Fetches, renders and stores the job's export; an unreadable source or any other failure becomes the job's error, a legacy 503 propagates. */
async function produce(deps: RunExportDeps, input: RunExportInput, job: ExportJobRow, definition: ExportDefinitionRow): Promise<Produced> {
  try {
    const table = await fetchExportTable(deps, { job, definition, payload: input.payload });
    const rendering = await renderExport(job.format, { definition, table, job });
    const sha = sha256Hex(rendering.bytes);
    const objectKey = exportObjectKey(input.tenantId, input.jobId, extensionFor(job.format));
    const put = await deps.storage.put(EXPORT_BUCKET, objectKey, rendering.bytes, { contentType: rendering.contentType });
    if (put.sha256 !== sha) return { error: 'export-failed' };
    return { fileName: rendering.fileName, contentType: rendering.contentType, objectKey, outputSha256: put.sha256 };
  } catch (err) {
    // SourceUnavailableError first: sources.ts wraps the client's ServiceUnavailableError, itself a LegacyServiceUnavailableError.
    if (err instanceof SourceUnavailableError) return { error: 'source-unavailable' };
    if (err instanceof LegacyServiceUnavailableError) throw err;
    return { error: 'export-failed' };
  }
}

/** The finishing move of job `jobId` for `produced`, at `now`. */
function finishMove(jobId: string, produced: Produced, now: Date): TransitionInput {
  if (produced.error !== undefined) return { jobId, to: 'failed', now, error: produced.error };
  const { fileName, contentType, objectKey, outputSha256 } = produced;
  return { jobId, to: 'done', now, fileName, contentType, objectKey, outputSha256 };
}

/** Runs export job `input.jobId` once: resolves with its recorded outcome, rejects with a LegacyServiceUnavailableError when a unit gate refuses it. */
export async function runExport(deps: RunExportDeps, input: RunExportInput): Promise<RunExportResult> {
  const started = await withGatedTenant(deps.db, input.tenantId, async (tx): Promise<StartOutcome> => {
    const moved = await transitionJob(tx, deps.repository, { jobId: input.jobId, to: 'running', now: deps.clock.now() });
    if (moved.outcome !== 'legal') return moved;
    return { outcome: 'legal', job: moved.job, definition: await findDefinition(tx, moved.job.definition_id) };
  });
  if (started.outcome !== 'legal') return { outcome: 'skipped', state: started.state };

  // The fixture's definition join finds no row and its runner records export-failed.
  const produced: Produced =
    started.definition === null ? { error: 'export-failed' } : await produce(deps, input, started.job, started.definition);

  const finished = await withGatedTenant(deps.db, input.tenantId, (tx) =>
    transitionJob(tx, deps.repository, finishMove(input.jobId, produced, deps.clock.now())),
  );
  if (finished.outcome !== 'legal') return { outcome: 'skipped', state: finished.state };
  return produced.error === undefined
    ? { outcome: 'done', state: finished.state }
    : { outcome: 'failed', state: finished.state, error: produced.error };
}
