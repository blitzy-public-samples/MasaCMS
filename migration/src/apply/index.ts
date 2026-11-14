/** Apply folder's public API: every export of the backfill, forward feed and batch modules, and the shared target hint. */
export { runBackfill, BackfillAuthorityError } from './backfill.js';
export type { BackfillContext, BackfillOptions, BackfillResult, BackfillTableResult } from './backfill.js';

export { runFeed, applyTableDiff, restartFeedFor, FeedBaselineMissingError, FeedAuthorityError } from './feed.js';
export type {
  FeedContext,
  TableDiffContext,
  FeedOptions,
  FeedResult,
  FeedFilesResult,
  ApplyTableDiffOptions,
  TableDiffResult,
  OwnerDiffResult,
  RestartFeedOptions,
  RestartFeedResult,
  RestartTableResult,
} from './feed.js';

export { hintOf } from './targets.js';
export type { TargetHint } from './targets.js';

export {
  batchIdFor,
  createBatchSender,
  createOwnerBatcher,
  createApplyTenantResolver,
  batchSizeOf,
  parseApplyFault,
  parseInFlightKill,
  inFlightKillLine,
  fanOut,
  umbrellaTenantId,
  APPLY_FAULT,
  DEFAULT_BATCH_SIZE,
  ApplyFaultConfigError,
  InFlightKillMissedError,
} from './batch.js';
export type {
  BatchDirection,
  BatchIdParts,
  BatchSender,
  BatchSenderOptions,
  OwnerBatcher,
  OwnerBatcherOptions,
  OwnerBatchStats,
  ApplyChange,
  ApplyColumn,
  ApplyFault,
  ApplyFaultPoint,
  InFlightKill,
  TenantResolver,
} from './batch.js';
