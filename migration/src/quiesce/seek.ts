/** Resets the OPT-2 consumer subscriptions to a checkpoint time and verifies that none holds a message afterwards. */
import type { MigrationContext } from '../context.js';
import { createPubSub, listOpt2Subscriptions, peekBacklog, type Opt2Subscription, type PubSubLike } from './subscriptions.js';

const GRPC_FAILED_PRECONDITION = 9;
const GRPC_UNIMPLEMENTED = 12;

/** Ports used instead of the ones {@link seekSubscriptions} would create. */
export interface SeekOptions {
  /** Pub/Sub client; defaults to `createPubSub(ctx.env)`, which is closed when the call ends. */
  pubsub?: PubSubLike;
}

/** Outcome for one subscription; with `fallback`, the seek was refused and the backlog check alone proves the reset. */
export interface SubscriptionSeekResult {
  name: string;
  sought: boolean;
  fallback?: 'ordered-seek-unsupported';
  backlog: number;
}

/** The seek time and one outcome per subscription, in name order. */
export interface SeekResult {
  to: string;
  subscriptions: SubscriptionSeekResult[];
}

/** Raised when subscriptions still deliver a message after the seek; `nonEmpty` lists their short ids. */
export class SeekVerificationError extends Error {
  override readonly name = 'SeekVerificationError';
  readonly nonEmpty: string[];

  constructor(nonEmpty: string[]) {
    super(`Subscriptions not empty after seek: ${nonEmpty.join(', ')}`);
    this.nonEmpty = nonEmpty;
  }
}

/** gRPC status code carried by a client error, if any. */
function grpcCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** Seeks `sub` to `time`; on the emulator, its refusal of a timestamp seek on an ordered subscription becomes the fallback. */
async function seekOne(
  sub: Opt2Subscription,
  time: Date,
  onEmulator: boolean,
): Promise<Pick<SubscriptionSeekResult, 'sought' | 'fallback'>> {
  try {
    await sub.subscription.seek(time);
    return { sought: true };
  } catch (error) {
    const code = grpcCode(error);
    if (onEmulator && sub.ordered && (code === GRPC_UNIMPLEMENTED || code === GRPC_FAILED_PRECONDITION)) {
      return { sought: false, fallback: 'ordered-seek-unsupported' };
    }
    throw error;
  }
}

/**
 * Seeks every OPT-2 consumer subscription to `toIso`, one at a time in name order, then peeks each backlog without acking.
 * @throws SeekVerificationError when any subscription still delivers a message.
 */
export async function seekSubscriptions(
  ctx: Pick<MigrationContext, 'env' | 'logger'>,
  toIso: string,
  options: SeekOptions = {},
): Promise<SeekResult> {
  const pubsub = options.pubsub ?? createPubSub(ctx.env);
  try {
    const time = new Date(toIso);
    const onEmulator = Boolean(ctx.env.PUBSUB_EMULATOR_HOST);
    const subscriptions = await listOpt2Subscriptions(pubsub);

    const seeks: Omit<SubscriptionSeekResult, 'backlog'>[] = [];
    for (const sub of subscriptions) {
      seeks.push({ name: sub.name, ...(await seekOne(sub, time, onEmulator)) });
    }

    const results: SubscriptionSeekResult[] = [];
    for (const seek of seeks) {
      const result = { ...seek, backlog: await peekBacklog(pubsub, seek.name) };
      results.push(result);
      const outcome = result.fallback === undefined ? 'sought' : `not sought (${result.fallback})`;
      ctx.logger[result.backlog > 0 ? 'warn' : 'info']('subscription %s %s, backlog %d', result.name, outcome, result.backlog);
    }

    const nonEmpty = results.filter((result) => result.backlog > 0).map((result) => result.name);
    if (nonEmpty.length > 0) throw new SeekVerificationError(nonEmpty);
    return { to: toIso, subscriptions: results };
  } finally {
    if (options.pubsub === undefined) await pubsub.close();
  }
}
