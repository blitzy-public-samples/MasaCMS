/** Route registry of the migration service: every contract operation except service-kit's `healthz`, bound to the shared context and services. */
import type { FastifyInstance } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import { currentAuthority } from '../cutover/index.js';
import type { FaultRegistry } from '../faults/index.js';
import type { BackgroundStateApi } from '../quiesce/index.js';
import type { Projector } from '../reverse/index.js';
import type { SchedulerService } from '../scheduler/index.js';
import type { TransitionService } from '../transition/index.js';
import { hasOrphanArchive, type WindowService } from '../windows/index.js';
import { AUTHORITY_ROUTES, registerAuthorityRoutes } from './authority.js';
import { BACKGROUND_ROUTES, registerBackgroundRoutes } from './background.js';
import { FAULT_ROUTES, registerFaultRoutes } from './faults.js';
import { GATES_ROUTES, gateReadsOf, registerGatesRoutes } from './gates.js';
import { LEGACY_STEP_ROUTES, registerLegacyStepRoutes } from './legacy-steps.js';
import { PROBE_ROUTES, registerProbeRoutes } from './probes.js';
import { PROJECTION_ROUTES, registerProjectionRoutes } from './projection.js';
import { SCHEDULER_ROUTES, registerSchedulerRoutes } from './scheduler.js';
import { TRANSITION_ROUTES, registerTransitionRoutes } from './transitions.js';
import { WINDOW_ROUTES, registerWindowRoutes } from './windows.js';

export {
  AUTHORITY_ROUTES,
  BACKGROUND_ROUTES,
  FAULT_ROUTES,
  GATES_ROUTES,
  LEGACY_STEP_ROUTES,
  PROBE_ROUTES,
  PROJECTION_ROUTES,
  SCHEDULER_ROUTES,
  TRANSITION_ROUTES,
  WINDOW_ROUTES,
  gateReadsOf,
  registerAuthorityRoutes,
  registerBackgroundRoutes,
  registerFaultRoutes,
  registerGatesRoutes,
  registerLegacyStepRoutes,
  registerProbeRoutes,
  registerProjectionRoutes,
  registerSchedulerRoutes,
  registerTransitionRoutes,
  registerWindowRoutes,
};
export type { AuthorityRouteDeps } from './authority.js';
export type { BackgroundRouteDeps } from './background.js';
export type { FaultRouteDeps } from './faults.js';
export type { GatesRouteDeps } from './gates.js';
export type { LegacyStepRouteDeps } from './legacy-steps.js';
export type { ProbeRouteDeps } from './probes.js';
export type { ProjectionRouteDeps } from './projection.js';
export type { SchedulerBackgroundRecord, SchedulerRouteDeps } from './scheduler.js';
export type { TransitionRouteDeps } from './transitions.js';
export type { WindowRouteDeps } from './windows.js';

/** The shared context and the services `server.ts` builds once, which every route module is bound to. */
export interface RouteDeps {
  ctx: MigrationContext;
  windows: WindowService;
  projector: Projector;
  transitions: TransitionService;
  scheduler: SchedulerService;
  background: BackgroundStateApi;
  faults: FaultRegistry;
}

/** Every operation the registrars declare, in registration order: contract `path` and Fastify `url`. */
export const MIGRATION_ROUTES = Object.freeze([
  ...WINDOW_ROUTES,
  ...PROBE_ROUTES,
  ...PROJECTION_ROUTES,
  ...AUTHORITY_ROUTES,
  ...LEGACY_STEP_ROUTES,
  ...GATES_ROUTES,
  ...TRANSITION_ROUTES,
  ...SCHEDULER_ROUTES,
  ...BACKGROUND_ROUTES,
  ...FAULT_ROUTES,
]);

/** Registers the seventeen operations on an app from `createService`, whose deny-by-default hook checks each declaration. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;
  registerWindowRoutes(app, { windows: deps.windows });
  registerProbeRoutes(app, { orphanArchive: (filenames) => hasOrphanArchive(ctx.legacy, filenames) });
  registerProjectionRoutes(app, { projector: deps.projector, defaultTimeoutMs: ctx.config.projection.defaultAwaitTimeoutMs });
  registerAuthorityRoutes(app, {
    authority: () => currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths }),
    catalog: ctx.catalog,
  });
  registerLegacyStepRoutes(app, { windows: deps.windows });
  // Leases come from `gateReadsOf`'s single `leasesOfUnits` read, not `holdersOf`: a holder map lacks the lease kind and acquisition time `gatesList` reports.
  registerGatesRoutes(app, { catalog: ctx.catalog, ...gateReadsOf(ctx) });
  registerTransitionRoutes(app, { transitions: deps.transitions });
  // The contract's `SchedulerState` carries the background state, so the scheduler routes read the record the background routes write.
  registerSchedulerRoutes(app, { scheduler: deps.scheduler, background: deps.background });
  registerBackgroundRoutes(app, { background: deps.background });
  registerFaultRoutes(app, { faults: deps.faults });
}
