/** Legacy-side access: SQL Server, bridge, start-up guard, opt2_sync, restart. */
export { createLegacyDb, quoteIdent, MASTER_DATABASE } from './legacy-db.js';
export type { LegacyDb, LegacyDbEnv } from './legacy-db.js';

export {
  createBridgeClient,
  bridgeClientFromEnv,
  BRIDGE_JOBS,
  BridgeError,
  UnsupportedFileStoreError,
  BridgeHashMismatchError,
} from './bridge.js';
export type {
  BridgeClient,
  BridgeClientOptions,
  BridgeRequestOptions,
  BridgeJobName,
  BridgeJobParams,
  BridgeJobResult,
  BridgeCursor,
  SchedulerDescription,
  ScheduledTaskDefinition,
  SchedulerSelection,
  SchedulerRestoreRequest,
  SchedulerOpResult,
  SiteRefreshResult,
  FileListing,
  LegacyFileEntry,
  LegacyFileVariant,
  LegacyFileBytes,
  FilePutResult,
  FileDeleteTarget,
  FileDeleteResult,
} from './bridge.js';

export {
  STARTUP_PREDICATE_WHERE,
  STARTUP_COUNT_SQL,
  countStartupRows,
  runStartupGuardSequence,
  recoverStartupGuard,
  StartupGuardFrozenError,
  commitWithStartupGuard,
} from './startup-guard.js';
export type { StartupGuardSteps, StartupGuardOutcome } from './startup-guard.js';

export { initLegacy, opt2SyncReady, Opt2SyncUnavailableError } from './init-legacy.js';
export type { InitLegacyLogger, InitLegacyResult } from './init-legacy.js';

export { restartLegacy, superviseChild, RestartUnavailableError, LegacyRestartError } from './restart.js';
export type {
  RestartOptions,
  LegacyRestartResult,
  SuperviseOptions,
  SupervisedEnd,
  SignalFunction,
} from './restart.js';
