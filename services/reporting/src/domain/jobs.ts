// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job operations of the fixture and `/v1/` routes: queue a job and its run, read and list jobs, open a done job's output. */
import { LEGACY_ERROR_MAP, LegacyApiError, LegacyServiceUnavailableError, cfDateFormat, cfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { SIGNED_URL_TTL_S } from '@opt2/platform/storage';
import { withTenant } from '@opt2/platform/tenancy';
import type { ExportRunPayload, ReportingDeps } from './deps.js';
import type { JobState } from './job-state.js';
import { findDefinition, findJob, listJobs, type JobPage, type JobPaging } from '../repo/queries.js';
import type { NewExportJob } from '../repo/repository.js';
import { EXPORT_BUCKET, EXPORT_FORMATS, type ExportDefinitionRow, type ExportFormat, type ExportJobRow } from '../repo/tables.js';

/** Fixture envelope error types the export-job paths raise. */
export type ReportingDomainErrorType = 'notFound' | 'invalidParameters' | 'conflict';

// The fixture raises these without a message, so envelope.cfc answers its default message for the type.
const DEFAULT_MESSAGES: Readonly<Record<ReportingDomainErrorType, string>> = Object.freeze({
  notFound: 'Not Found',
  invalidParameters: LEGACY_ERROR_MAP.invalidParameters.message,
  conflict: 'Conflict',
});

/** A reporting fixture error of `type` carrying the fixture's message; `src/legacy/**` and the `/v1/` routes render it. */
export class ReportingDomainError extends Error {
  override readonly name = 'ReportingDomainError';

  constructor(
    readonly type: ReportingDomainErrorType,
    message: string = DEFAULT_MESSAGES[type],
  ) {
    super(message);
  }
}

/** Per-job parameters of a create request as received; an absent or null `asOf` is today in the legacy zone. */
export type CreateExportParams = { asOf?: unknown };

/** A create request; `tenantId`, `siteId` and `requestedById` are the verified token's `tid`, `site` and `sub`. */
export interface CreateExportInput {
  tenantId: string;
  siteId: string;
  definitionId: string;
  format: string;
  requestedById: string;
  params: CreateExportParams;
}

/** The tenant and job a read addresses; `tenantId` is the verified token's `tid`. */
export interface ExportJobRef {
  tenantId: string;
  jobId: string;
}

/** A done job's stored output, the state of a job not yet done, or no job. */
export type ExportOutput =
  | {
      outcome: 'ready';
      job: ExportJobRow;
      bucket: typeof EXPORT_BUCKET;
      objectKey: string;
      fileName: string;
      contentType: string;
      sha256: string;
    }
  | { outcome: 'not-ready'; state: JobState }
  | { outcome: 'not-found' };

/** The `ready` outcome of `openExportOutput`. */
export type ReadyExportOutput = Extract<ExportOutput, { outcome: 'ready' }>;

/** A time-limited download URL with its expiry as ISO-8601 UTC, the contract's `SignedUrl`. */
export type ExportDownloadUrl = { url: string; expiresAt: string };

const FORMATS: readonly string[] = EXPORT_FORMATS;
const AS_OF_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// SQL Server datetime's floor year.
const MIN_AS_OF_YEAR = 1753;
const QUOTED_STRING_SPECIAL = /["\\]/g;

/** True when `format` is an export output format. */
function isExportFormat(format: string): format is ExportFormat {
  return FORMATS.includes(format);
}

/** `asOf` when it is a real yyyy-mm-dd date from 1753 on, the legacy-zone date of `now` when absent or null, otherwise null. */
function resolveAsOf(asOf: unknown, now: Date): string | null {
  if (asOf === undefined || asOf === null) return cfDateFormat(now, 'yyyy-mm-dd');
  if (typeof asOf !== 'string') return null;
  const match = AS_OF_PATTERN.exec(asOf);
  if (match === null) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year >= MIN_AS_OF_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= lastDay ? asOf : null;
}

/** The row the fixture's INSERT writes: a queued job of `definition` created at `created`, every run column NULL. */
function queuedJob(tenantId: string, input: CreateExportInput, definition: ExportDefinitionRow, format: ExportFormat, created: Date): NewExportJob {
  return {
    tenant_id: tenantId,
    job_id: cfUuid(),
    siteid: input.siteId,
    definition_id: definition.definition_id,
    format,
    state: 'queued',
    requested_by_id: input.requestedById,
    created,
    started_at: null,
    finished_at: null,
    error: null,
    file_name: null,
    content_type: null,
    object_key: null,
    output_sha256: null,
  };
}

/**
 * Inserts a queued job of `input.definitionId` and, once it has committed, schedules its run; returns the stored row.
 * Throws `notFound` for a definition the tenant lacks, then `invalidParameters` for a bad `format` or `asOf`; a failed schedule
 * throws `LegacyServiceUnavailableError`.
 */
export async function createExportJob(
  deps: Pick<ReportingDeps, 'db' | 'repository' | 'clock' | 'enqueue'>,
  input: CreateExportInput,
): Promise<ExportJobRow> {
  const { job, asOf } = await withGatedTenant(deps.db, input.tenantId, async (tx) => {
    const definition = await findDefinition(tx, input.definitionId);
    if (definition === null) throw new ReportingDomainError('notFound');
    const format = input.format;
    if (!isExportFormat(format)) throw new ReportingDomainError('invalidParameters');
    const now = deps.clock.now();
    const asOf = resolveAsOf(input.params.asOf, now);
    if (asOf === null) throw new ReportingDomainError('invalidParameters');
    // The fixture fails runner-less queued jobs of the site here; a target run is a durable Cloud Task retried until it runs, so none is failed.
    const job = await deps.repository.insertJob(tx, queuedJob(tx.tenantId, input, definition, format, now), { actorUserId: input.requestedById });
    return { job, asOf };
  });
  const payload: ExportRunPayload = { jobId: job.job_id, asOf };
  try {
    await deps.enqueue({ tenantId: input.tenantId, jobId: job.job_id, payload });
  } catch (error) {
    // The committed queued row is kept; the caller answers the legacy 503.
    if (error instanceof LegacyServiceUnavailableError) throw error;
    const unavailable = new LegacyServiceUnavailableError(`Export job ${job.job_id} run could not be scheduled`, 'auto', 'export-run-unscheduled');
    throw Object.assign(unavailable, { cause: error });
  }
  return job;
}

/** The tenant's job `ref.jobId`, or null. */
export function getExportJob(deps: Pick<ReportingDeps, 'db'>, ref: ExportJobRef): Promise<ExportJobRow | null> {
  return withTenant(deps.db, ref.tenantId, (tx) => findJob(tx, ref.jobId));
}

/** One page of the tenant's jobs by `created`, then id, with the count of all of them. */
export function listExportJobs(deps: Pick<ReportingDeps, 'db'>, input: { tenantId: string; paging: JobPaging }): Promise<JobPage> {
  return withTenant(deps.db, input.tenantId, (tx) => listJobs(tx, input.paging));
}

/** Where the tenant's done job `ref.jobId` stores its output; throws `LegacyApiError('server_error')` for a done job storing none. */
export async function openExportOutput(deps: Pick<ReportingDeps, 'db'>, ref: ExportJobRef): Promise<ExportOutput> {
  const job = await getExportJob(deps, ref);
  if (job === null) return { outcome: 'not-found' };
  if (job.state !== 'done') return { outcome: 'not-ready', state: job.state };
  if (job.object_key === null || job.output_sha256 === null) throw new LegacyApiError('server_error');
  return {
    outcome: 'ready',
    job,
    bucket: EXPORT_BUCKET,
    objectKey: job.object_key,
    // ACF reads a NULL column as the empty string.
    fileName: job.file_name ?? '',
    contentType: job.content_type ?? '',
    sha256: job.output_sha256,
  };
}

/** A download URL of `ready`'s output valid for `SIGNED_URL_TTL_S` seconds, as an attachment named `ready.fileName`. */
export async function signedExportUrl(deps: Pick<ReportingDeps, 'storage' | 'clock'>, ready: ReadyExportOutput): Promise<ExportDownloadUrl> {
  const expiresAt = new Date(deps.clock.now().getTime() + SIGNED_URL_TTL_S * 1000).toISOString();
  const url = await deps.storage.signedUrl(EXPORT_BUCKET, ready.objectKey, {
    expiresS: SIGNED_URL_TTL_S,
    disposition: `attachment; filename="${ready.fileName.replace(QUOTED_STRING_SPECIAL, '\\$&')}"`,
  });
  return { url, expiresAt };
}
