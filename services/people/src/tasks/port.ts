/** People task port and outbox-sweep chain wiring over `@opt2/platform/tasks` and `@opt2/platform/outbox`. */
import { createTaskPort, ensureOwnRecurring, outboxSweepQueue, registerQueueControl } from '@opt2/platform/tasks';
import type { EnsureRecurringResult, TaskPort } from '@opt2/platform/tasks';
import { registerOutboxSweep } from '@opt2/platform/outbox';
import type { RecoveryHook } from '@opt2/platform/outbox';
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { Logger } from '@opt2/platform/logging';

/** Service name the task queues and the sweep are registered under. */
export const PEOPLE_SERVICE = 'people' as const;

/** People's outbox sweep queue, `people-outbox-sweep`. */
export const PEOPLE_SWEEP_QUEUE = outboxSweepQueue(PEOPLE_SERVICE);

/** Port, per-service base URLs and clock shared by the task routes and the start-up chain. */
export type PeopleTaskWiring = { port: TaskPort; serviceUrls: BaseEnv['OPT2_SERVICE_URLS']; clock: Clock };

/** Builds the task port `OPT2_TASKS_ADAPTER` selects, locally over `db`'s schema; `app.ts` closes it on shutdown. */
export async function createPeopleTaskPort(
  env: BaseEnv,
  deps: { db: TenantDb; clock: Clock; logger: Logger },
): Promise<TaskPort> {
  // The platform reads OPT2_STATE_DIR and OPT2_SERVICE_URLS from `env` itself.
  return createTaskPort(env, { db: deps.db, clock: deps.clock, logger: deps.logger });
}

/**
 * Registers `POST /internal/v1/outbox/sweep` as the `people-outbox-sweep` chain task; the outbox must already be created.
 * `recoveryHooks` run in order after each sweep has published. Synchronous like the platform registrar, so a registration
 * error throws inside `buildApp`.
 */
export function registerSweep(
  app: FastifyInstance,
  opts: PeopleTaskWiring & { recoveryHooks: readonly RecoveryHook[] },
): void {
  registerOutboxSweep(app, {
    service: PEOPLE_SERVICE,
    port: opts.port,
    queue: PEOPLE_SWEEP_QUEUE,
    serviceUrls: opts.serviceUrls,
    clock: opts.clock,
    recoveryHooks: opts.recoveryHooks,
  });
}

/** Registers the pause, resume and ensure queue-control routes for the queues people creates. */
export function registerQueueControlRoutes(app: FastifyInstance, opts: PeopleTaskWiring): void {
  registerQueueControl(app, { port: opts.port, service: PEOPLE_SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}

/** Ensures a live task for people's only recurring chain, the outbox sweep. */
export async function ensureStartupChains(
  port: TaskPort,
  opts: Omit<PeopleTaskWiring, 'port'>,
): Promise<EnsureRecurringResult[]> {
  return ensureOwnRecurring(port, { service: PEOPLE_SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}
