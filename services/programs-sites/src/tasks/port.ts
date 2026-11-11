/** Programs-sites task port and recurring-queue wiring over `@opt2/platform/tasks` and `@opt2/platform/outbox`. */
import { createTaskPort, ensureOwnRecurring, registerQueueControl } from '@opt2/platform/tasks';
import type { EnsureRecurringResult, TaskPort } from '@opt2/platform/tasks';
import { registerOutboxSweep } from '@opt2/platform/outbox';
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { Logger } from '@opt2/platform/logging';

const SERVICE = 'programs-sites' as const;

type ServiceUrls = BaseEnv['OPT2_SERVICE_URLS'];

type TaskWiring = { port: TaskPort; serviceUrls: ServiceUrls; clock: Clock };

/** Builds the task port `OPT2_TASKS_ADAPTER` selects; `app.ts` closes it on shutdown. */
export async function createProgramsSitesTaskPort(
  env: BaseEnv,
  deps: { db: TenantDb; clock: Clock; logger: Logger },
): Promise<TaskPort> {
  // The platform reads OPT2_STATE_DIR and OPT2_SERVICE_URLS from `env` itself.
  return createTaskPort(env, { db: deps.db, clock: deps.clock, logger: deps.logger });
}

/** Registers the self-rescheduling `POST /internal/v1/outbox/sweep` chain task route. */
export async function registerSweep(app: FastifyInstance, opts: TaskWiring): Promise<void> {
  registerOutboxSweep(app, { service: SERVICE, port: opts.port, serviceUrls: opts.serviceUrls, clock: opts.clock });
}

/** Registers the pause, resume and ensure queue-control routes for the queues this service creates. */
export async function registerQueueControlRoutes(app: FastifyInstance, opts: TaskWiring): Promise<void> {
  registerQueueControl(app, { port: opts.port, service: SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}

/** Registers the outbox sweep, then the queue-control routes. */
export async function registerTaskInfrastructure(app: FastifyInstance, opts: TaskWiring): Promise<void> {
  await registerSweep(app, opts);
  await registerQueueControlRoutes(app, opts);
}

/**
 * Ensures the start-up recurring chains, which is the outbox sweep only.
 * The site-monitor chain is left to `opt2-tasks reconcile --with-sitemonitor`, so a legacy `ping=false` monitor never runs.
 */
export async function ensureStartupChains(
  port: TaskPort,
  opts: { serviceUrls: ServiceUrls; clock: Clock },
): Promise<EnsureRecurringResult[]> {
  return ensureOwnRecurring(port, { service: SERVICE, serviceUrls: opts.serviceUrls, clock: opts.clock });
}
