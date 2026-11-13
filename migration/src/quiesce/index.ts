/** Quiescence surface: background record, drain barrier, suspend, resume, seek and Pub/Sub adapter; `cli.js` (side effects) and drain's internal `topology.js` stay out. */
export {
  BACKGROUND_KEY,
  backgroundRecordSchema,
  defaultBackgroundRecord,
  backgroundStateView,
  createBackgroundState,
  BackgroundCallError,
  remoteBackgroundState,
} from './background.js';
export type { BackgroundRecord, BackgroundStateApi } from './background.js';

export {
  DEFAULT_DRAIN_POLL_MS,
  RECEIPT_QUERY_MAX_IDS,
  DrainTimeoutError,
  MissingSubscriptionError,
  UnlistedProducerError,
  ownerDrainCounts,
  isDrained,
  drainParticipants,
  awaitDrained,
} from './drain.js';
export type { OwnerDrainCounts, DrainRole, AwaitDrainedOptions, DrainResult, CheckedOwner, DrainContext } from './drain.js';

export { InvocationsRunningError, OrphanedWritesError, queueControlTargets, drainAndSuspend } from './suspend.js';
export type { QueueTarget, RunningQueue, DrainAndSuspendContext, DrainAndSuspendOptions, DrainAndSuspendResult } from './suspend.js';

export { ResumeReconcileError, resume } from './resume.js';
export type { ResumeContext, ResumeOptions, ResumeResult } from './resume.js';

export { SeekVerificationError, seekSubscriptions } from './seek.js';
export type { SeekOptions, SubscriptionSeekResult, SeekResult } from './seek.js';

export {
  createPubSub,
  subscriptionId,
  listOpt2Subscriptions,
  isPushConfig,
  readPushConfig,
  setPushConfig,
  peekBacklog,
  peekDeadLetterEventIds,
  redactEndpoint,
} from './subscriptions.js';
export type { SavedPushConfig, SubscriptionLike, PubSubLike, Opt2Subscription } from './subscriptions.js';
