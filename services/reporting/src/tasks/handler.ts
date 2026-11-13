// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Options of the `reporting-export-run` task route: the target form of the fixture's `opt2-export-<jobId>` runner thread. */
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { TaskTenantMismatchError, type TaskContext, type TaskRouteOptions } from '@opt2/platform/tasks';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { ExportRunPayload, ReportingDeps } from '../domain/deps.js';
import { runExport } from '../domain/run-export.js';
import { findJob } from '../repo/queries.js';
import type { ExportJobRow, ExportState } from '../repo/tables.js';

/** The task's payload and the job it names, as visible under the body's tenant. */
export interface StoredExportRun {
  payload: ExportRunPayload;
  job: ExportJobRow;
}

/** The contract's `ExportTaskResult`: the job and the state it holds after the run. */
export interface ExportTaskResult {
  jobId: string;
  state: ExportState;
}

const AS_OF_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** `raw` as the contract's `ExportTaskPayload`, or null when it is not one. */
function exportRunPayload(raw: unknown): ExportRunPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { jobId, asOf } = raw as Record<string, unknown>;
  if (typeof jobId !== 'string' || !isCfUuid(jobId) || typeof asOf !== 'string' || !AS_OF_PATTERN.test(asOf)) return null;
  // The run acts as System, so the `sessionId` or `userToken` of a task queued by an earlier release is never read or forwarded.
  return { jobId, asOf };
}

/** The payload's job under the body's tenant; null when the payload is malformed or names no job there. */
async function findStoredExportRun(tx: TenantTx, raw: unknown): Promise<StoredExportRun | null> {
  // The platform parses only the wire body, so the payload is checked once here; a malformed one names no visible job.
  const payload = exportRunPayload(raw);
  if (payload === null) return null;
  // No row lock: the runner takes it when it claims the job.
  const job = await findJob(tx, payload.jobId);
  return job === null ? null : { payload, job };
}

/** Route options of the `reporting-export-run` task, which `app.ts` registers at the queue's target path. */
export function exportRunTaskOptions(deps: ReportingDeps): TaskRouteOptions<StoredExportRun> {
  return {
    scope: 'tenant',
    db: deps.db,
    findStored: findStoredExportRun,
    handler: async ({ request, tenantId, taskName, stored }: TaskContext<StoredExportRun>): Promise<ExportTaskResult> => {
      // The URL and the payload name one job; a task naming two is refused like one naming another tenant's job.
      const exportId = (request.params as { exportId?: string }).exportId;
      if (stored === undefined || tenantId === null || exportId !== stored.payload.jobId) {
        throw new TaskTenantMismatchError(tenantId, taskName);
      }
      const { jobId } = stored.payload;
      const { state } = await runExport(deps, { tenantId, jobId, payload: stored.payload });
      // A job gone before the runner claimed it is no longer visible under the tenant, and the contract's result needs a state.
      if (state === null) throw new TaskTenantMismatchError(tenantId, taskName);
      return { jobId, state };
    },
  };
}
