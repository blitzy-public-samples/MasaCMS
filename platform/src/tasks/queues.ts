/** Registry of every Cloud Tasks queue: names, targets, creators, cadence and retry policy. */

/** Cloud Tasks queue retry policy; `maxAttempts: -1` means unlimited. */
export interface RetryPolicy {
  maxAttempts: number;
  minBackoffS: number;
  maxBackoffS: number;
  maxDoublings: number;
}

/** Retry policy of queues carrying one-off tasks. */
export const DEFAULT_RETRY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 100,
  minBackoffS: 1,
  maxBackoffS: 300,
  maxDoublings: 5,
});

/** Retry policy of self-rescheduling chains, whose successor exists before the current task is acknowledged. */
export const RECURRING_RETRY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 5,
  minBackoffS: 1,
  maxBackoffS: 60,
  maxDoublings: 4,
});

/** One queue: the route its tasks call and the services that create them. */
export interface QueueDefinition {
  readonly name: string;
  /** Service whose route the task calls. */
  readonly targetService: string;
  /** Route on the target service; `{param}` segments are filled by `targetUrl`. */
  readonly targetPath: string;
  /** Services that create tasks on the queue: they hold its local rows and need the enqueuer role in the cloud. */
  readonly creators: readonly string[];
  readonly recurring?: { readonly intervalS: number };
  /** Dispatch deadline in seconds, within Cloud Tasks' HTTP-target range of 15–1800. */
  readonly deadlineS: number;
  readonly retry: RetryPolicy;
  /** Present on queues that exist only in the local stack. */
  readonly localOnly?: boolean;
}

/** Deployed services that publish through an outbox and own a sweep queue. */
export const OUTBOX_PRODUCERS = ['identity', 'people', 'programs-sites', 'surveys', 'communications'] as const;

/** Outbox producers that run only locally and are never deployed. */
export const LOCAL_ONLY_PRODUCERS = ['stub'] as const;

/** Route every outbox sweep task calls on its producer. */
export const OUTBOX_SWEEP_PATH = '/internal/v1/outbox/sweep';

/** Interval of every outbox sweep chain, in seconds. */
export const OUTBOX_SWEEP_INTERVAL_S = 60;

/** Queue of the programs-sites site-monitor chain. */
export const SITEMONITOR_QUEUE = 'programs-sites-sitemonitor';

/** Site-monitor interval in seconds, the cadence of Masa's ACF task. */
export const SITEMONITOR_INTERVAL_S = 900;

/** Site-monitor dispatch deadline in seconds, Masa's request timeout. */
export const SITEMONITOR_DEADLINE_S = 600;

/** Name of a producer's outbox sweep queue. */
export function outboxSweepQueue<S extends string>(service: S): `${S}-outbox-sweep` {
  return `${service}-outbox-sweep`;
}

type QueueSpec = Omit<QueueDefinition, 'name'>;

function sweepSpecs<P extends string>(
  producers: readonly P[],
  localOnly: boolean,
): Record<`${P}-outbox-sweep`, QueueSpec> {
  const specs = {} as Record<`${P}-outbox-sweep`, QueueSpec>;
  for (const producer of producers) {
    specs[outboxSweepQueue(producer)] = {
      targetService: producer,
      targetPath: OUTBOX_SWEEP_PATH,
      creators: [producer],
      recurring: { intervalS: OUTBOX_SWEEP_INTERVAL_S },
      deadlineS: 60,
      retry: RECURRING_RETRY,
      ...(localOnly ? { localOnly: true } : {}),
    };
  }
  return specs;
}

function withNames<K extends string>(specs: Record<K, QueueSpec>): Readonly<Record<K, QueueDefinition>> {
  const defs = {} as Record<K, QueueDefinition>;
  for (const name of Object.keys(specs) as K[]) {
    const spec = specs[name];
    Object.freeze(spec.creators);
    if (spec.recurring) Object.freeze(spec.recurring);
    defs[name] = Object.freeze({ name, ...spec });
  }
  return Object.freeze(defs);
}

/** Every queue, keyed by name, in deterministic registry order. */
export const QUEUES = withNames({
  'surveys-launch': {
    targetService: 'surveys',
    // Under /internal/v1/tasks/ because task requests carry only the cloud-tasks transport credential.
    targetPath: '/internal/v1/tasks/surveys/{surveyId}/launch',
    creators: ['communications'],
    deadlineS: 60,
    retry: DEFAULT_RETRY,
  },
  'communications-reminders': {
    targetService: 'communications',
    targetPath: '/internal/v1/tasks/reminders/{scheduledTaskId}',
    creators: ['communications'],
    deadlineS: 60,
    retry: DEFAULT_RETRY,
  },
  'content-scheduled-publish': {
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/publish-scheduled-changesets',
    creators: ['programs-sites', 'strategies-content'],
    deadlineS: 300,
    retry: DEFAULT_RETRY,
  },
  'content-feed-import': {
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/feed-auto-import',
    creators: ['programs-sites'],
    deadlineS: 600,
    retry: DEFAULT_RETRY,
  },
  'reporting-export-run': {
    targetService: 'reporting',
    targetPath: '/internal/v1/tasks/exports/{exportId}/run',
    creators: ['reporting'],
    deadlineS: 1800,
    retry: DEFAULT_RETRY,
  },
  [SITEMONITOR_QUEUE]: {
    targetService: 'programs-sites',
    targetPath: '/internal/v1/jobs/sitemonitor',
    creators: ['programs-sites'],
    recurring: { intervalS: SITEMONITOR_INTERVAL_S },
    deadlineS: SITEMONITOR_DEADLINE_S,
    retry: RECURRING_RETRY,
  },
  ...sweepSpecs(OUTBOX_PRODUCERS, false),
  ...sweepSpecs(LOCAL_ONLY_PRODUCERS, true),
});

/** Name of a registry queue. */
export type QueueName = keyof typeof QUEUES;

/** Raised for a queue name outside the registry. */
export class UnknownQueueError extends Error {
  override readonly name = 'UnknownQueueError';

  constructor(readonly queue: string) {
    super(`Unknown task queue: ${queue}`);
  }
}

/** Raised when `OPT2_SERVICE_URLS` has no URL for a task target, a service or a task URL's origin. */
export class UnknownTaskTargetError extends Error {
  override readonly name = 'UnknownTaskTargetError';

  constructor(readonly service: string) {
    super(`OPT2_SERVICE_URLS has no URL for task target: ${service}`);
  }
}

/** True when the value names a registry queue. */
export function isQueueName(value: string): value is QueueName {
  return Object.hasOwn(QUEUES, value);
}

/** Registry entry of a queue; throws `UnknownQueueError` for any other name. */
export function queueDefinition(name: string): QueueDefinition {
  if (!isQueueName(name)) throw new UnknownQueueError(name);
  return QUEUES[name];
}

/** Recurring queues in registry order: outbox sweeps, local-only ones on request, and the site monitor only when asked. */
export function recurringQueues(
  opts: { includeLocalOnly?: boolean; withSiteMonitor?: boolean } = {},
): QueueDefinition[] {
  return Object.values(QUEUES).filter(
    (def) =>
      def.recurring !== undefined &&
      (opts.includeLocalOnly === true || def.localOnly !== true) &&
      (def.name !== SITEMONITOR_QUEUE || opts.withSiteMonitor === true),
  );
}

/** Queues on which the service creates tasks, in registry order. */
export function queuesCreatedBy(service: string): QueueDefinition[] {
  return Object.values(QUEUES).filter((def) => def.creators.includes(service));
}

/** Absolute task URL with each `{param}` URI-encoded; throws `UnknownTaskTargetError` or, for a missing param, `TypeError`. */
export function targetUrl(
  def: QueueDefinition,
  serviceUrls: Record<string, string>,
  params: Record<string, string> = {},
): string {
  const base = serviceUrls[def.targetService];
  if (!base) throw new UnknownTaskTargetError(def.targetService);
  const path = def.targetPath.replace(/\{([^}]+)\}/g, (_segment: string, param: string) => {
    const value = params[param];
    if (value === undefined) throw new TypeError(`Missing path parameter "${param}" for queue ${def.name}`);
    return encodeURIComponent(value);
  });
  return base.replace(/\/+$/, '') + path;
}

/** Seconds to wait after failed attempt `attempt`, where the first failure is attempt 1. */
export function retryDelayS(policy: RetryPolicy, attempt: number): number {
  const retries = Math.max(0, attempt - 1);
  // Cloud Tasks doubles the delay maxDoublings times, then grows it linearly by that last step, capped at maxBackoffS.
  const step = policy.minBackoffS * 2 ** Math.min(retries, policy.maxDoublings);
  return Math.min(policy.maxBackoffS, step * (1 + Math.max(0, retries - policy.maxDoublings)));
}

/** JSON-serialisable queue entry the topology generator writes for Terraform's queue instances. */
export interface QueueTopologyEntry {
  name: string;
  targetService: string;
  targetPath: string;
  creators: string[];
  intervalS?: number;
  deadlineS: number;
  retry: RetryPolicy;
}

/** Plain-data view of the registry for a target; `cloud` omits local-only queues. */
export function queueTopology(opts: { target: 'local' | 'cloud' }): QueueTopologyEntry[] {
  return Object.values(QUEUES)
    .filter((def) => opts.target === 'local' || def.localOnly !== true)
    .map((def) => ({
      name: def.name,
      targetService: def.targetService,
      targetPath: def.targetPath,
      creators: [...def.creators],
      ...(def.recurring ? { intervalS: def.recurring.intervalS } : {}),
      deadlineS: def.deadlineS,
      retry: { ...def.retry },
    }));
}
