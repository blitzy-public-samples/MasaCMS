/** Shared context every strategies-content route module receives from `registerRoutes`. */
import type { BaseEnv, Clock, FastifyRequest } from '@opt2/platform/service-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { TaskPort } from '@opt2/platform/tasks';
import type { Actor, DomainDeps } from '../domain/context.js';

export interface ContentRouteContext {
  domain: DomainDeps;
  storage: StoragePort;
  taskPort: TaskPort;
  env: BaseEnv & { MURA_VARIATIONS: boolean };
  clock: Clock;
  actorFor(request: FastifyRequest): Promise<Actor>;
}
