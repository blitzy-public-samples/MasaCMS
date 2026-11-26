/** Identity task port and outbox-sweep chain wiring over `@opt2/platform/tasks` and `@opt2/platform/outbox`. */
import { createTaskPort, ensureOwnRecurring, registerQueueControl } from '@opt2/platform/tasks';
import type { EnsureRecurringResult, TaskPort } from '@opt2/platform/tasks';
import { registerOutboxSweep } from '@opt2/platform/outbox';
import { IDENTITY_SERVICE } from '@opt2/platform/service-kit';
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { Logger } from '@opt2/platform/logging';

// The service kit already names identity for service calls; one constant serves both.
export { IDENTITY_SERVICE };

/** Port, per-service base URLs and clock shared by the task routes and the start-up chain. */
export type IdentityTaskWiring = { port: TaskPort; serviceUrls: BaseEnv['OPT2_SERVICE_URLS']; clock: Clock };

/** Builds the task port `OPT2_TASKS_ADAPTER` selects, locally over `db`'s schema; `app.ts` closes it on shutdown. */
export async function createIdentityTaskPort(
  env: BaseEnv,
  deps: { db: TenantDb; clock: Clock; logger: Logger },
): Promise<TaskPort> {
  // The platform reads OPT2_STATE_DIR and OPT2_SERVICE_URLS from `env` itself.
  return createTaskPort(env, { db: deps.db, clock: deps.clock, logger: deps.logger });
}

/**
 * Registers `POST /internal/v1/outbox/sweep` as the `identity-outbox-sweep` chain task; the outbox must already be created.
 * Synchronous like the platform registrars it wraps, so a registration error throws inside `buildApp`.
 */
export function registerSweep(app: FastifyInstance, opts: IdentityTaskWiring): void {
  registerOutboxSweep(app, { service: IDENTITY_SERVICE, port: opts.port, serviceUrls: opts.serviceUrls, clock: opts.clock });
}

/** Registers the pause, resume and ensure queue-control routes for the queues identity creates. */
export function registerQueueControlRoutes(app: FastifyInstance, opts: IdentityTaskWiring): void {
  registerQueueControl(app, { port: opts.port, service: IDENTITY_SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}

/** Ensures a live task for identity's only recurring chain, the outbox sweep. */
export async function ensureStartupChains(
  port: TaskPort,
  opts: Omit<IdentityTaskWiring, 'port'>,
): Promise<EnsureRecurringResult[]> {
  return ensureOwnRecurring(port, { service: IDENTITY_SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}
