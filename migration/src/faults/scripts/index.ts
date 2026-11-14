// Registry of the scripted migration faults, and the public API of their scripts.
import { applierKilledMidBatch } from './applier-killed-mid-batch.js';
import { duplicateBatch } from './duplicate-batch.js';
import { mssqlDroppedMidExtract } from './mssql-dropped-mid-extract.js';
import { serviceRestartedMidApply } from './service-restarted-mid-apply.js';
import { pubsubRedelivery } from './pubsub-redelivery.js';
import { windowImportInterrupted } from './window-import-interrupted.js';
import { projectorDelay } from './projector-delay.js';
import { forcedReinit } from './forced-reinit.js';
import type { FaultScript } from './types.js';

export * from './types.js';
export { applierKilledMidBatch, type ApplierKilledParams } from './applier-killed-mid-batch.js';
export { duplicateBatch, type DuplicateBatchParams } from './duplicate-batch.js';
export { mssqlDroppedMidExtract, type MssqlDroppedParams } from './mssql-dropped-mid-extract.js';
export { serviceRestartedMidApply, type ServiceRestartParams } from './service-restarted-mid-apply.js';
export { pubsubRedelivery, type PubsubRedeliveryParams } from './pubsub-redelivery.js';
export { windowImportInterrupted, type WindowImportParams } from './window-import-interrupted.js';
export { projectorDelay, type ProjectorDelayParams } from './projector-delay.js';
export { forcedReinit, type ForcedReinitParams } from './forced-reinit.js';

// ../index.ts owns FaultName and imports this registry, so it checks the key set against FAULT_NAMES;
// `satisfies` here checks only each entry's script contract, keeping this module independent of its importer.
/** Scripted faults by fault id, in the order of `faults` in the migration config. */
export const FAULT_SCRIPTS = {
  'applier-killed-mid-batch': applierKilledMidBatch,
  'duplicate-batch': duplicateBatch,
  'mssql-dropped-mid-extract': mssqlDroppedMidExtract,
  'service-restarted-mid-apply': serviceRestartedMidApply,
  'pubsub-redelivery': pubsubRedelivery,
  'window-import-interrupted': windowImportInterrupted,
  'projector-delay': projectorDelay,
  'forced-reinit': forcedReinit,
} satisfies Record<string, FaultScript>;
