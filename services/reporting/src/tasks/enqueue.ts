// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Creates the `reporting-export-run` task that runs one export job. */
import { QUEUES, targetUrl, type TaskPort } from '@opt2/platform/tasks';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { EnqueueExportRun } from '../domain/deps.js';

const queue = QUEUES['reporting-export-run'];

/** Deterministic task id of job `jobId`; a CF UUID already matches the task-name pattern, so it is used verbatim. */
export function exportRunTaskName(jobId: string): string {
  return `${queue.name}-${jobId}`;
}

/** Collaborators of the export-run enqueuer. */
export interface ExportRunEnqueuerDeps {
  tasks: TaskPort;
  serviceUrls: BaseEnv['OPT2_SERVICE_URLS'];
  clock: Clock;
}

/** Enqueuer that creates one task per export job, due now; a repeated create of the same job is a no-op success. */
export function createExportRunEnqueuer({ tasks, serviceUrls, clock }: ExportRunEnqueuerDeps): EnqueueExportRun {
  return async ({ tenantId, jobId, payload }) => {
    const name = exportRunTaskName(jobId);
    // Outside the catch: a missing reporting URL is a configuration error, not an unavailable queue.
    const url = targetUrl(queue, serviceUrls, { exportId: jobId });
    try {
      // The adapter wraps `body` as the wire body's `payload`, so the payload is passed unwrapped.
      await tasks.create({ queue: queue.name, name, scheduleTime: clock.now(), url, body: payload, deadlineS: queue.deadlineS, tenantId });
    } catch (err) {
      if (err instanceof LegacyServiceUnavailableError) throw err;
      const unavailable = new LegacyServiceUnavailableError(`Task queue ${queue.name} unavailable`, 'auto', 'tasks-unavailable');
      unavailable.cause = err;
      throw unavailable;
    }
  };
}
