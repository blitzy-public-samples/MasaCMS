/** `backgroundSuspend` and `backgroundResume`: the stored suspension of `opt2-ops`, which the service's background loops read on every pass. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { FastifyInstance } from '@opt2/platform/service-kit';

import type { components, paths } from '../generated/openapi.js';
import { backgroundRecordSchema, backgroundStateView, type BackgroundStateApi } from '../quiesce/index.js';

type BackgroundState = components['schemas']['BackgroundState'];

/** The background record the routes read and write. */
export interface BackgroundRouteDeps {
  background: Pick<BackgroundStateApi, 'get' | 'suspend' | 'resume'>;
}

const SUSPEND_PATH = '/internal/v1/background:suspend' satisfies keyof paths;
const RESUME_PATH = '/internal/v1/background:resume' satisfies keyof paths;
// A literal colon in a Fastify path is written `::`.
const SUSPEND_URL = '/internal/v1/background::suspend';
const RESUME_URL = '/internal/v1/background::resume';

/** Operations this module registers: contract `path` and Fastify `url`. */
export const BACKGROUND_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'backgroundSuspend', method: 'POST', path: SUSPEND_PATH, url: SUSPEND_URL } as const),
  Object.freeze({ operationId: 'backgroundResume', method: 'POST', path: RESUME_PATH, url: RESUME_URL } as const),
]);

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformOperator]),
});

// As the contract's `BackgroundRecord`: no undeclared key at the top level or in a paused queue; push configs stay open.
const suspendBodySchema = backgroundRecordSchema.strict();

/** Registers both operations; they only store the record, while `opt2-ops` itself pauses and restores queues, subscriptions and ColdFusion tasks. */
export function registerBackgroundRoutes(app: FastifyInstance, deps: BackgroundRouteDeps): void {
  app.post<{ Body: unknown; Reply: BackgroundState }>(SUSPEND_URL, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const body = suspendBodySchema.safeParse(request.body);
    if (!body.success) throw new LegacyApiError('invalidParameters');
    return backgroundStateView(await deps.background.suspend(body.data));
  });

  app.post<{ Reply: BackgroundState }>(RESUME_URL, { config: { opt2: ROUTE_AUTH } }, async () => {
    const current = await deps.background.get();
    // As `opt2-ops resume`, a resume while nothing is suspended writes nothing.
    return backgroundStateView(current.suspended ? await deps.background.resume() : current);
  });
}
