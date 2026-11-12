// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job state moves as `synthetic.usp_export_job_transition` applies them; the only writer of `export_job.state`. */
import type { TenantTx } from '@opt2/platform/tenancy';
import { findJob } from '../repo/queries.js';
import type { ExportJobChanges, ReportingRepository } from '../repo/repository.js';
import { EXPORT_STATES, type ExportJobRow } from '../repo/tables.js';

/** Export job states, in lifecycle order. */
export const JOB_STATES = EXPORT_STATES;

/** One export job state. */
export type JobState = (typeof JOB_STATES)[number];

/** Values a failed job stores in `error`, as the fixture runner records them. */
export const EXPORT_ERRORS = Object.freeze(['source-unavailable', 'export-failed'] as const);

/** One failed-job error value. */
export type ExportError = (typeof EXPORT_ERRORS)[number];

/** States each state may move to. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  queued: Object.freeze(['running'] as const),
  running: Object.freeze(['done', 'failed'] as const),
  done: Object.freeze([] as const),
  failed: Object.freeze([] as const),
});

/** True when a job in state `from` may move to `to`. */
export function isLegalTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** One requested state move of job `jobId`, at `now` from the injected clock; `objectKey` names the stored output of a done job. */
export type TransitionInput =
  | { jobId: string; to: 'running'; now: Date }
  | { jobId: string; to: 'done'; now: Date; fileName: string; contentType: string; objectKey: string; outputSha256: string }
  | { jobId: string; to: 'failed'; now: Date; error: ExportError };

/** The procedure's result row: the applied state and stored job, the unchanged current state, or no job. */
export type TransitionOutcome =
  | { outcome: 'legal'; state: TransitionInput['to']; job: ExportJobRow }
  | { outcome: 'illegal-state'; state: JobState }
  | { outcome: 'not-found'; state: null };

/** The columns the procedure's UPDATE changes for `input`. */
function changesFor(input: TransitionInput): ExportJobChanges {
  switch (input.to) {
    case 'running':
      return { state: input.to, started_at: input.now };
    case 'done':
      return {
        state: input.to,
        finished_at: input.now,
        file_name: input.fileName,
        content_type: input.contentType,
        object_key: input.objectKey,
        output_sha256: input.outputSha256,
      };
    case 'failed':
      return { state: input.to, finished_at: input.now, error: input.error };
  }
}

/** Applies `input` to its job in the caller's gated tenant transaction, under the job's row lock; gate errors propagate. */
export async function transitionJob(tx: TenantTx, repository: ReportingRepository, input: TransitionInput): Promise<TransitionOutcome> {
  const current = await findJob(tx, input.jobId, { forUpdate: true });
  if (current === null) return { outcome: 'not-found', state: null };
  if (!isLegalTransition(current.state, input.to)) return { outcome: 'illegal-state', state: current.state };
  const job = await repository.updateJob(tx, { job_id: current.job_id }, changesFor(input));
  return { outcome: 'legal', state: input.to, job };
}
