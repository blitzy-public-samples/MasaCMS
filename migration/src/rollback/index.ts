/** People-roster rollback: the roster group set R, the target re-baseline after `v0003`, and the rehearsal report. */
export { ROLLBACK_FROM_VERSION, ROLLBACK_VERSION, RollbackSetMismatchError, deriveRollbackSet, computeRollbackSet } from './set.js';
export type { SessionMode, RollbackSet, DeriveRollbackSetInput } from './set.js';

export { RollbackNotActiveError, rebaselineRecordPath, readRebaselineRecord, rebaselineRollbackSet } from './rebaseline.js';
export type { RebaselineRecord, RebaselineDeps } from './rebaseline.js';

export {
  ROLLBACK_REPORT_PATH,
  RECONCILIATION_REPORTS,
  REHEARSAL_SCENARIOS,
  SESSION_SCENARIO,
  renderRollbackReport,
  writeRollbackReport,
} from './report.js';
export type {
  RollbackResult,
  ReconciliationRef,
  ScenarioOutcome,
  FixtureStatus,
  RollbackGroupDetail,
  RollbackReportInput,
  WriteRollbackReportResult,
} from './report.js';
