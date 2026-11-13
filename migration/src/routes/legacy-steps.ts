/** `legacyStepRun`: one site-monitor step run on legacy through the bridge, inside a write window when its units need one. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { components, paths } from '../generated/openapi.js';
import { BRIDGE_JOBS, type BridgeJobName } from '../legacy/index.js';
import type { WindowService } from '../windows/index.js';
import { LegacyStepDeadlineError } from '../windows/legacy-steps.js';

type LegacyStepRequest = components['schemas']['LegacyStepRequest'];

/** The window service that derives the step's write set, opens any window and calls the bridge. */
export interface LegacyStepRouteDeps {
  windows: Pick<WindowService, 'runLegacyStep'>;
}

const LEGACY_STEPS_PATH = '/internal/v1/legacy-steps' satisfies keyof paths;

/** Operations this module registers: contract `path` and Fastify `url`. */
export const LEGACY_STEP_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'legacyStepRun', method: 'POST', path: LEGACY_STEPS_PATH, url: LEGACY_STEPS_PATH } as const),
]);

// The body's `siteId` names the legacy site the step runs for, never the caller's token site, so the hook's site check is off.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('programs-sites')]),
  siteCheck: false,
});

// The per-site steps of the monitor (contentServer.cfc:689-700, 740-743), for which the contract requires `siteId`.
const SITE_STEPS: ReadonlySet<BridgeJobName> = new Set(['trackBounces', 'feedAutoImport', 'onSiteMonitor']);

// The cursor values stay opaque strings: jobs.cfm parses them in the legacy time mask, so they reach it unchanged.
const bodySchema = z
  .strictObject({
    step: z.enum(BRIDGE_JOBS),
    theTime: z.string().min(1),
    lastMonitored: z.string().min(1),
    deadlineAt: z.iso.datetime({ offset: true }),
    siteId: z.string().min(1).optional(),
  })
  .refine((body) => body.siteId !== undefined || !SITE_STEPS.has(body.step)) satisfies z.ZodType<LegacyStepRequest>;

/** Registers `legacyStepRun`; the window service alone decides whether the step needs a window, from the inventory's write set. */
export function registerLegacyStepRoutes(app: FastifyInstance, deps: LegacyStepRouteDeps): void {
  app.post<{ Body: unknown }>(LEGACY_STEPS_PATH, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) throw new LegacyApiError('invalidParameters');
    try {
      return (await deps.windows.runLegacyStep(body.data)).response;
    } catch (error) {
      // A refused window and a failed step are LegacyServiceUnavailableErrors, which the service-kit error handler answers
      // with the legacy 503; only the deadline has its own status, which that handler cannot give. The body names no unit,
      // so an unknown unit can only come from the inventory and stays the handler's 500, not a 400.
      if (!(error instanceof LegacyStepDeadlineError)) throw error;
      request.log.warn(error.message);
      return sendLegacyResponse(reply, { ...apiUnavailableResponse(), status: 504 });
    }
  });
}
