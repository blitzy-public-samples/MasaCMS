/** `schedulerStateGet` and `schedulerStateImport`: the captured native ColdFusion tasks and the site-monitor hand-off state. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, buildEnvelope, reportedMethod, serializeResponse } from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, type FastifyInstance, type FastifyReply } from '@opt2/platform/service-kit';

import type { paths } from '../generated/openapi.js';
import {
  SchedulerImportError,
  SchedulerStateConflictError,
  schedulerStateView,
  type BackgroundStateView,
  type SchedulerService,
  type SchedulerStateView,
} from '../scheduler/index.js';

/** The background record fields the `SchedulerState` answer carries; the quiesce module's `BackgroundStateApi` fits it. */
export interface SchedulerBackgroundRecord {
  suspended: boolean;
  since?: string | null;
}

/** The scheduler service and the background-state read the routes use. */
export interface SchedulerRouteDeps {
  scheduler: Pick<SchedulerService, 'state' | 'importState'>;
  /** Read-only: the contract's `SchedulerState` requires the quiesce-owned background state, which this module never writes. */
  background: { get(): Promise<SchedulerBackgroundRecord> };
}

const STATE_PATH = '/internal/v1/scheduler/state' satisfies keyof paths;
const IMPORT_PATH = '/internal/v1/scheduler/state:import' satisfies keyof paths;
// A literal colon in a Fastify path is written `::`.
const IMPORT_URL = '/internal/v1/scheduler/state::import';

/** Operations this module registers: contract `path` and Fastify `url`. */
export const SCHEDULER_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'schedulerStateGet', method: 'GET', path: STATE_PATH, url: STATE_PATH } as const),
  Object.freeze({ operationId: 'schedulerStateImport', method: 'POST', path: IMPORT_PATH, url: IMPORT_URL } as const),
]);

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformOperator]),
});

/** The contract's `BackgroundState`: `since` only while it is set. */
function backgroundView(record: SchedulerBackgroundRecord): BackgroundStateView {
  return record.since == null ? { suspended: record.suspended } : { suspended: record.suspended, since: record.since };
}

/** The stored records, the live scheduler and the background state as the contract's `SchedulerState`. */
async function currentState(deps: SchedulerRouteDeps): Promise<SchedulerStateView> {
  const [status, background] = await Promise.all([deps.scheduler.state(), deps.background.get()]);
  return schedulerStateView(status, backgroundView(background));
}

/** Answers a capture that contradicts the handed-off site monitor with the legacy error envelope at 409. */
function sendConflict(reply: FastifyReply, error: SchedulerStateConflictError): FastifyReply {
  const envelope = buildEnvelope({ method: reportedMethod(undefined), error: { message: error.message, code: 'invalid_request' } });
  return sendLegacyResponse(reply, serializeResponse(envelope, { statusCode: 409 }));
}

/** Registers both scheduler state operations; importing only records the capture and never registers or resumes a ColdFusion task. */
export function registerSchedulerRoutes(app: FastifyInstance, deps: SchedulerRouteDeps): void {
  app.get<{ Reply: SchedulerStateView }>(STATE_PATH, { config: { opt2: ROUTE_AUTH } }, () => currentState(deps));

  app.post<{ Body: unknown }>(IMPORT_URL, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    try {
      // The import normalises and validates the raw body itself, so it is validated exactly once.
      await deps.scheduler.importState(request.body);
    } catch (error) {
      if (error instanceof SchedulerImportError) throw new LegacyApiError('invalidParameters');
      if (error instanceof SchedulerStateConflictError) return sendConflict(reply, error);
      throw error;
    }
    // The contract answers with the `SchedulerState` after the import, not the import's own result.
    return currentState(deps);
  });
}
