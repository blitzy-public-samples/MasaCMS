// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications task port over `@opt2/platform/tasks`. */
import { createTaskPort, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import type { Logger } from '@opt2/platform/logging';

/** Runtime handles the task adapters need. */
export interface CommunicationsTaskPortDeps {
  db: TenantDb;
  clock: Clock;
  logger: Logger;
}

/** Builds the task port `OPT2_TASKS_ADAPTER` selects; `app.ts` closes it on shutdown. */
export async function createCommunicationsTaskPort(env: BaseEnv, deps: CommunicationsTaskPortDeps): Promise<TaskPort> {
  // The platform reads OPT2_STATE_DIR and OPT2_SERVICE_URLS from `env` itself; its options take no copies of them.
  return createTaskPort(env, { db: deps.db, clock: deps.clock, logger: deps.logger });
}
