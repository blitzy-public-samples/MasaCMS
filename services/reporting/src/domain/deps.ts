// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Collaborators the reporting domain functions receive, wired by `app.ts`. */
import type { TenantDb } from '@opt2/platform/tenancy';
import type { StoragePort } from '@opt2/platform/storage';
import type { Clock, ServiceClient } from '@opt2/platform/service-kit';
import type { ReportingRepository } from '../repo/repository.js';
import type { components } from '../generated/openapi.js';

/** Payload of a `reporting-export-run` task, as the reporting contract declares it. */
export type ExportRunPayload = components['schemas']['ExportTaskPayload'];

/** Schedules the run of export job `jobId` in tenant `tenantId`. */
export type EnqueueExportRun = (input: { tenantId: string; jobId: string; payload: ExportRunPayload }) => Promise<void>;

/** Whether the run task of export job `jobId` in tenant `tenantId` is still pending or running. */
export type ExportRunScheduled = (input: { tenantId: string; jobId: string }) => Promise<boolean>;

/** Dependencies of every reporting domain function; `client` is the only route to finance and timesheets data. */
export interface ReportingDeps {
  db: TenantDb;
  repository: ReportingRepository;
  storage: StoragePort;
  clock: Clock;
  client: ServiceClient;
  enqueue: EnqueueExportRun;
  /** The probe `createExportRunProbe` of `../tasks/enqueue.js` builds. */
  runScheduled: ExportRunScheduled;
}
