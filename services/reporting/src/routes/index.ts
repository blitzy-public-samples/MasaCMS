// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the reporting route modules: `/v1/reporting`, the export source scope read and the local export file route. */
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { LocalStorageAdapter, StoragePort } from '@opt2/platform/storage';
import type { ReportingDeps } from '../domain/deps.js';
import { registerExportFileRoute } from './files.js';
import { registerExportScopeRoute } from './internal-scope.js';
import { registerV1Routes } from './v1.js';

/** True for the local adapter, the only storage port whose signed URLs this service verifies and serves. */
function isLocalStorage(storage: StoragePort): storage is LocalStorageAdapter {
  return storage.kind === 'local' && 'verifySignedUrl' in storage && typeof storage.verifySignedUrl === 'function';
}

/**
 * Registers the `/v1/reporting` routes and the export source scope read, plus the export file route when exports are in local
 * storage; `app.ts` registers the fixture routes.
 */
export async function registerRoutes(app: FastifyInstance, deps: ReportingDeps): Promise<void> {
  await registerV1Routes(app, deps);
  registerExportScopeRoute(app, deps);
  // Cloud signed URLs address Cloud Storage directly, so no reporting route serves them.
  if (isLocalStorage(deps.storage)) registerExportFileRoute(app, { storage: deps.storage, clock: deps.clock });
}
