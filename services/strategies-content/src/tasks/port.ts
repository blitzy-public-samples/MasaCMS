/** Strategies-content task port and queue-control wiring over `@opt2/platform/tasks`; this service runs no outbox sweep or recurring chain. */
import { createTaskPort, queuesCreatedBy, registerQueueControl } from '@opt2/platform/tasks';
import type { QueueName, TaskPort } from '@opt2/platform/tasks';
import type { BaseEnv, Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { Logger } from '@opt2/platform/logging';

/** Name this service creates tasks under and is addressed by in `OPT2_SERVICE_URLS`. */
export const CONTENT_SERVICE = 'strategies-content' as const;

/** Registry queues this service may create tasks on, in registry order. */
export function contentQueues(): readonly QueueName[] {
  // Registry definitions carry their own key as `name`.
  return queuesCreatedBy(CONTENT_SERVICE).map((def) => def.name as QueueName);
}

/** Builds the task port `OPT2_TASKS_ADAPTER` selects, locally over `db`'s schema; `app.ts` closes it on shutdown. */
export async function createContentTaskPort(
  env: BaseEnv,
  deps: { db: TenantDb; clock: Clock; logger: Logger },
): Promise<TaskPort> {
  // The platform reads OPT2_STATE_DIR, OPT2_SERVICE_URLS and GOOGLE_CLOUD_PROJECT from `env` itself.
  return createTaskPort(env, { db: deps.db, clock: deps.clock, logger: deps.logger });
}

/** Registers the pause, resume and ensure queue-control routes for the queues this service creates. */
export function registerContentQueueControl(
  app: FastifyInstance,
  deps: { port: TaskPort; serviceUrls: Record<string, string>; clock: Clock },
): void {
  registerQueueControl(app, { port: deps.port, service: CONTENT_SERVICE, serviceUrls: deps.serviceUrls, clock: deps.clock });
}
