/** Write windows: the window service and its errors, the `windows.json` writer, unit leases, window import, legacy steps, the reload guard, the CLI's service calls and the orphan archive probe. */
export { createWindowService, writeWindowsReport, WindowRefusedError, WindowNotFoundError, WindowStateError } from './service.js';
export type { WindowService, WindowServiceOptions, WindowHooks, WindowsReportResult } from './service.js';

export { acquireLeases, releaseLeases, leasesOf, leasesOfUnits, holdersOf, LeaseUnavailableError } from './leases.js';
export type { LeaseKind, LeaseRow, AcquireLeasesInput } from './leases.js';

export { importWindow, toExtractScope, windowBatchId, WindowImportError } from './import.js';
export type { ImportInput, ImportResult } from './import.js';

export { LEGACY_STEP_ROUTE_KEY } from './legacy-steps.js';
export type { WindowLifecycle, LegacyStepInput, LegacyStepResult } from './legacy-steps.js';

export {
  RELOAD_ROUTE_KEY,
  reloadKey,
  contentUnits,
  freezeLegacyBound,
  unfreezeLegacyBound,
  createStartupGuardRunner,
} from './reload.js';
export type { ReloadWindowResult } from './reload.js';

export {
  openWindowViaService,
  completeWindowViaService,
  resolveWindowViaService,
  STARTUP_WINDOW_HOLDER_ENV,
  STARTUP_ROUTE_KEY,
} from './via-service.js';

export {
  ORPHAN_PROBE_MAX_FILENAMES,
  ORPHAN_PROBE_MAX_FILENAME_LENGTH,
  OrphanArchiveUnavailableError,
  hasOrphanArchive,
  orphanArchiveSql,
} from './orphan-archive.js';
