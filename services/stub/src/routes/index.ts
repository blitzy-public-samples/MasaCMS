/** Registry of the stub route modules, registered by `app.ts`. */
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { StubRepository } from '../repo/repository.js';
import { registerNoteRoutes } from './notes.js';

/** Runtime dependencies shared by every stub route module. */
export interface RouteDeps {
  db: TenantDb;
  repository: StubRepository;
  clock: Clock;
}

/** Registers the stub's note routes under `/opt2/stub/notes`. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await registerNoteRoutes(app, deps);
}
