/** HTTP surfaces of the site-monitor orchestrator: legacy `/_api/sitemonitor`, its recurring Cloud Task and the cursor hand-off state. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LEGACY_HTML_CONTENT_TYPE, LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, z, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, recurringHandler, recurringSpec, registerTaskRoute, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createMigrationJobsPort, createStepDispatcher } from '../jobs/dispatch.js';
import { runSiteMonitor, type SiteMonitorResult } from '../jobs/sitemonitor.js';
import { readState, writeCursor, type CursorState } from '../repo/sitemonitor-state.js';
import type { components } from '../generated/openapi.js';

type SiteMonitorState = components['schemas']['SiteMonitorState'];
type SiteMonitorRunResult = components['schemas']['SiteMonitorRunResult'];

/** Dependencies of the site-monitor routes; the service's `RouteDeps` satisfies it. */
export interface SiteMonitorRouteDeps {
  db: TenantDb;
  port: TaskPort;
  clock: Clock;
  /** `OPT2_SERVICE_URLS`. */
  serviceUrls: Record<string, string>;
}

/** Public-run prefixes; legacy compares them in any letter case (contentServer.cfc:669, 783), so createService routes them case-insensitively. */
export const SITEMONITOR_RUN_PREFIXES: readonly string[] = Object.freeze(['/_api/sitemonitor', '/index.cfm/_api/sitemonitor']);
const RUN_PATHS: readonly string[] = Object.freeze(SITEMONITOR_RUN_PREFIXES.map((prefix) => `${prefix}*`));
const TASK_PATH = '/internal/v1/jobs/sitemonitor';
const STATE_PATH = '/internal/v1/sitemonitor/state';

// Unauthenticated as in legacy, a reported pre-existing weakness; the run reads no `siteid`, so none is checked.
const PUBLIC_RUN: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });
const MIGRATION_ONLY: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.platformMigration]) });

/** The contract's `LocalTimestamp` mask: wall-clock time in the process zone, which is the legacy server's. */
const LOCAL_TIMESTAMP_MASK = "yyyy-MM-dd'T'HH:nn:ss.lll";
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

function localTimestamp(date: Date): string {
  return cfDateTimeFormat(date, LOCAL_TIMESTAMP_MASK);
}

/** Whether `text` names a real local instant: an ISO form without offset parses as local time, and only an exact round trip passes. */
function isLocalInstant(text: string): boolean {
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && localTimestamp(date) === text;
}

/** `SiteMonitorStateInput`, its timestamp parsed in the process zone. */
const STATE_INPUT = z.strictObject({
  lastMonitored: z
    .string()
    .regex(LOCAL_TIMESTAMP)
    .refine(isLocalInstant)
    .transform((text) => new Date(text)),
});

function toState(state: CursorState): SiteMonitorState {
  return {
    lastMonitored: state.lastMonitored === null ? null : localTimestamp(state.lastMonitored),
    updatedAt: state.updatedAt === null ? null : localTimestamp(state.updatedAt),
  };
}

/** A finished pass as `SiteMonitorRunResult`; every listed step completed, since a failed step aborts the pass. */
function toRunResult(result: SiteMonitorResult): SiteMonitorRunResult {
  return {
    theTime: localTimestamp(result.theTime),
    lastMonitored: localTimestamp(result.lastMonitored),
    steps: result.steps.map((outcome) => ({
      step: outcome.step,
      routedTo: outcome.route,
      status: 'completed',
      ...(outcome.siteId === undefined ? {} : { siteId: outcome.siteId }),
      theTime: localTimestamp(outcome.theTime),
      ...(outcome.task === undefined ? {} : { task: outcome.task }),
    })),
  };
}

/** Registers the public run, the recurring task route and the cursor state routes over one orchestrator. */
export async function registerSiteMonitorRoutes(app: FastifyInstance, deps: SiteMonitorRouteDeps): Promise<void> {
  const { db, port, clock, serviceUrls } = deps;
  const migration = createMigrationJobsPort({ client: app.opt2.client, clock });
  const dispatch = createStepDispatcher({ port, migration, serviceUrls, clock });
  const run = (): Promise<SiteMonitorResult> => runSiteMonitor({ db, clock, dispatch });

  // legacy: contentServer.cfc:745-747 returns "" once every step ran; a failed pass propagates and leaves the cursor.
  for (const url of RUN_PATHS) {
    app.route({
      method: ['GET', 'POST'],
      url,
      config: { opt2: PUBLIC_RUN },
      handler: async (_request, reply) => {
        await run();
        return sendLegacyResponse(reply, { status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: '' });
      },
    });
  }

  registerTaskRoute(app, TASK_PATH, {
    scope: 'system',
    handler: recurringHandler({ ...recurringSpec(SITEMONITOR_QUEUE, serviceUrls), port, clock }, async () =>
      toRunResult(await run()),
    ),
  });

  app.get<{ Reply: SiteMonitorState }>(STATE_PATH, { config: { opt2: MIGRATION_ONLY } }, async () => toState(await readState(db)));

  app.put<{ Reply: SiteMonitorState }>(STATE_PATH, { config: { opt2: MIGRATION_ONLY } }, async (request) => {
    const input = STATE_INPUT.safeParse(request.body);
    if (!input.success) throw new LegacyApiError('badRequest');
    return toState(await writeCursor(db, input.data.lastMonitored, clock));
  });
}
