// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job runner of the `reporting-export-run` task: claims one queued job, or reclaims one an interrupted delivery left running, then moves it to done or failed, as the fixture's runner thread does. */
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { ExportRunPayload, ReportingDeps } from './deps.js';
import { discardOutputs, reclaimRun, transitionJob, type ExportError, type JobState, type TransitionInput, type TransitionOutcome } from './job-state.js';
import { SourceUnavailableError, openExportTable } from './sources.js';
import { renderExport } from './writers/index.js';
import { findDefinition, findJob } from '../repo/queries.js';
import { EXPORT_BUCKET, exportAttemptKey, type ExportDefinitionRow, type ExportJobRow } from '../repo/tables.js';

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

/** The claim's outcome; a claimed job carries its definition, null when the tenant has none. */
type StartOutcome =
  | Exclude<TransitionOutcome, { outcome: 'legal' }>
  | { outcome: 'legal'; job: ExportJobRow; definition: ExportDefinitionRow | null };

/** A stored export as the done move records it, or the error the failed move records. */
type Produced =
  | { error: ExportError }
  | { error?: undefined; fileName: string; contentType: string; objectKey: string; outputSha256: string };

/** Opens, renders and streams the job's export into storage at `objectKey`, hashing it on the way; an unreadable source or any other failure becomes the job's error, a legacy 503 propagates. */
async function produce(
  deps: RunExportDeps,
  input: RunExportInput,
  job: ExportJobRow,
  definition: ExportDefinitionRow,
  objectKey: string,
): Promise<Produced> {
  try {
    const table = await openExportTable(deps, { job, definition, payload: input.payload });
    const rendering = await renderExport(job.format, { definition, table, job });
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    let streaming = true;
    const streamed = pipeline(rendering.body, hashing).finally(() => {
      streaming = false;
    });
    // A storage failing before it drains the body still ends the export's streams, with the storage's error.
    const stored = deps.storage.put(EXPORT_BUCKET, objectKey, hashing, { contentType: rendering.contentType }).catch((err: unknown) => {
      if (streaming) hashing.destroy(err as Error);
      throw err;
    });
    const [piped, put] = await Promise.allSettled([streamed, stored]);
    // Storage rejects with its own failure, or with the export's error that reached it through the body.
    if (put.status === 'rejected') throw put.reason;
    if (piped.status === 'rejected') throw piped.reason;
    if (put.value.sha256 !== hash.digest('hex')) {
      // Storage holds other bytes than the export streamed, so the failed job leaves no object behind.
      await deps.storage.delete(EXPORT_BUCKET, objectKey);
      return { error: 'export-failed' };
    }
    return { fileName: rendering.fileName, contentType: rendering.contentType, objectKey, outputSha256: put.value.sha256 };
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

/** Claims job `jobId`'s run: a queued job moves to running and a running one, left by an interrupted delivery, is reclaimed. */
async function claimRun(tx: TenantTx, deps: RunExportDeps, jobId: string): Promise<StartOutcome> {
  const current = await findJob(tx, jobId, { forUpdate: true });
  const now = deps.clock.now();
  const claimed =
    current?.state === 'running'
      ? { outcome: 'legal' as const, job: await reclaimRun(tx, deps.repository, { jobId, now }) }
      : await transitionJob(tx, deps.repository, { jobId, to: 'running', now });
  if (claimed.outcome !== 'legal') return claimed;
  return { outcome: 'legal', job: claimed.job, definition: await findDefinition(tx, claimed.job.definition_id) };
}

/** A finish's outcome; a skipped one carries the key the job's row names, null for none. */
type Finished = Exclude<RunExportResult, { outcome: 'skipped' }> | { outcome: 'skipped'; state: JobState | null; committedKey: string | null };

/** Records `produced` as job `jobId`'s outcome while the job still carries the row version `claim` left it, discarding every other output of the job; skipped otherwise. */
async function finishRun(tx: TenantTx, deps: RunExportDeps, jobId: string, claim: string, produced: Produced): Promise<Finished> {
  const current = await findJob(tx, jobId, { forUpdate: true });
  const skipped = { outcome: 'skipped', state: current?.state ?? null, committedKey: current?.object_key ?? null } as const;
  // A later delivery reclaimed the run, or a create's recovery failed it, after this claim.
  if (current?.row_version !== claim) return skipped;
  const finished = await transitionJob(tx, deps.repository, finishMove(jobId, produced, deps.clock.now()));
  if (finished.outcome !== 'legal') return skipped;
  // Earlier claims interrupted after storing, and a failed claim itself, leave objects no row names.
  discardOutputs(tx, deps.storage, finished.job);
  if (produced.error === undefined) return { outcome: 'done', state: finished.state };
  return { outcome: 'failed', state: finished.state, error: produced.error };
}

/**
 * Runs export job `input.jobId` under a claim: resolves with its recorded outcome, or `skipped` for a finished or missing job and
 * for a claim a later delivery took over, which deletes the object it stored; rejects with a LegacyServiceUnavailableError when a
 * unit gate refuses it, so a retried delivery reclaims the run.
 */
export async function runExport(deps: RunExportDeps, input: RunExportInput): Promise<RunExportResult> {
  const started = await withGatedTenant(deps.db, input.tenantId, (tx) => claimRun(tx, deps, input.jobId));
  if (started.outcome !== 'legal') return { outcome: 'skipped', state: started.state };
  const claim = started.job.row_version;

  // Every claim bumps the row version, so each stores to its own key and a superseded delivery never overwrites a committed output.
  const objectKey = exportAttemptKey(input.tenantId, input.jobId, started.job.format, claim);
  // The fixture's definition join finds no row and its runner records export-failed.
  const produced: Produced =
    started.definition === null ? { error: 'export-failed' } : await produce(deps, input, started.job, started.definition, objectKey);

  const finished = await withGatedTenant(deps.db, input.tenantId, (tx) => finishRun(tx, deps, input.jobId, claim, produced));
  if (finished.outcome !== 'skipped') return finished;
  if (finished.committedKey !== objectKey) await deps.storage.delete(EXPORT_BUCKET, objectKey);
  return { outcome: 'skipped', state: finished.state };
}
