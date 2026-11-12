// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the finance route modules: fixture, `/v1` and `/v2` finance, and the local attachment file route. */
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { LocalStorageAdapter, StoragePort } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { FinanceRepository } from '../repo/repository.js';
import { registerAttachmentFileRoute } from './files.js';
import { registerFixtureRoutes } from './fixture.js';
import { registerV1Routes } from './v1.js';

/** Runtime dependencies of every finance route module: the finance tenant database, repository, attachment storage and clock. */
export type FinanceDeps = { db: TenantDb; repository: FinanceRepository; storage: StoragePort; clock: Clock };

/** True for the local adapter, the only storage port whose signed URLs this service verifies and serves. */
function isLocalStorage(storage: StoragePort): storage is LocalStorageAdapter {
  return storage.kind === 'local' && 'verifySignedUrl' in storage && typeof storage.verifySignedUrl === 'function';
}

/** Registers the finance fixture and `/v1`/`/v2` routes, plus the attachment file route when attachments are in local storage. */
export async function registerRoutes(app: FastifyInstance, deps: FinanceDeps): Promise<void> {
  await registerFixtureRoutes(app, deps);
  await registerV1Routes(app, deps);
  // Cloud signed URLs address Cloud Storage directly, so no finance route serves them.
  if (isLocalStorage(deps.storage)) registerAttachmentFileRoute(app, { storage: deps.storage, clock: deps.clock });
}
