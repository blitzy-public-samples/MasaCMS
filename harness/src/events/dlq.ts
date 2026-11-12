// DLQ check: a tenant-less delivery lands on `<subscription>.dlq` without an effect, and one replay applies it exactly once.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PubSub, type Message } from '@google-cloud/pubsub';
import {
  DEAD_LETTER_REASONS,
  DEAD_LETTER_REASON_ATTRIBUTE,
  compileTopicSchema,
  createPublisher,
  decodeEnvelopeData,
  describeDeadLetter,
  dlqReplaySubscriptionName,
  dlqTopicName,
  encodeEnvelope,
  envelopeAttributes,
  readTopicSchema,
  subscriptionName,
  topicOfSubscription,
  topicSchemaRelativePath,
  type DeadLetterReason,
  type EventEnvelope,
  type RawMessage,
  type TopicValidator,
} from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { localTimestamp } from '@opt2/platform/outbox';
import { TENANT_A, pubsubEmulatorAvailable, testEnvelope, withoutTenant } from '@opt2/platform/testing';

import { defaultRunner } from '../lib/git.js';
import { HARNESS_ROOT, repoPath, type EnvLike } from '../lib/paths.js';
import { pollUntil, readOwnerExport, type SeamDeps } from './seams.js';

/** Topic of the stub's self-consumed note event. */
export const STUB_NOTE_TOPIC = 'stub.note.created.v1';

/** The stub's push subscription on {@link STUB_NOTE_TOPIC}. */
export const STUB_DLQ_SUBSCRIPTION: string = subscriptionName('stub', STUB_NOTE_TOPIC);

/** Unit whose rows record each applied stub note event. */
export const STUB_EFFECT_UNIT = 'stub.note_projection';

/** Reason the consumer gives a delivery without `tenantId`. */
export const EXPECTED_DLQ_REASON: DeadLetterReason = 'missing-tenant';

/** The `opt2-events` bin installed in the harness package. */
export const OPT2_EVENTS_BIN: string = path.join(HARNESS_ROOT, 'node_modules', '.bin', 'opt2-events');

/** Key of the `opt2-events replay` summary line that counts republished messages. */
export const REPLAY_COUNT_KEY = 'replayed';

/** Default wait for the dead letter on the observer and on the replay subscription, in ms. */
export const DEFAULT_LAND_TIMEOUT_MS = 60_000;

/** Receive window in which the replay subscription must stay empty before the check starts, in ms. */
export const PRECONDITION_PULL_MS = 5_000;

/** Seconds without a message after which each replay run stops. */
export const REPLAY_IDLE_SECONDS = 5;

// Departs from Rule "WIP - Minimal Change 2" (no timeouts), which does not bind this refactor: a stuck replay bin would otherwise outlive the landing bound.
/** Longest run of one replay bin, in ms; well above its idle stop and {@link DEFAULT_LAND_TIMEOUT_MS}. */
export const REPLAY_EXEC_TIMEOUT_MS = 120_000;

/** Wait after the replayed effect appears before it is read again, in ms. */
export const EFFECT_SETTLE_MS = 5_000;

// Same default project as the @opt2/platform/testing emulator helpers.
const DEFAULT_PROJECT = 'opt2-local';
const PULL_MAX_MESSAGES = 10;

/** A consumer subscription to dead-letter into, its topic and tenant, and how the consumer's effect is counted. */
export interface DlqTarget {
  subscription: string;
  topic: string;
  tenantId: string;
  /** Unit the effect is read from through the owner's migration export. */
  effectUnit: string;
  /** A fresh valid envelope for `topic` in `tenantId`. */
  buildEnvelope(): EventEnvelope;
  /** Applications the consumer recorded for the aggregate. */
  effectCount(aggregateId: string, deps: SeamDeps): Promise<number>;
}

/** Options of {@link stubDlqTarget}. */
export interface StubDlqTargetOptions {
  /** Default `TENANT_A.tenantId`. */
  tenantId?: string;
  /** Clock of the payload's `created` time. */
  now?: () => number;
}

/** Payload of `stub.note.created.v1`. */
interface StubNotePayload {
  noteId: string;
  title: string;
  body: string;
  created: string;
  rowVersion: number;
}

/** A message received from a subscription; `id` is its Pub/Sub message id. */
export interface DlqPulledMessage extends RawMessage {
  id: string;
}

/** Settlement of a received message. */
export type PullDecision = 'ack' | 'nack';

/** Options of {@link DlqPubSub.pull}. */
export interface DlqPullOptions {
  /** Longest receive window, in ms. */
  timeoutMs: number;
  decide(message: DlqPulledMessage): PullDecision;
  /** Ends the window early once it holds for the messages received so far. */
  done?(received: readonly DlqPulledMessage[]): boolean;
}

/** Pub/Sub operations of the check; {@link emulatorDlqPubSub} drives the emulator. */
export interface DlqPubSub {
  /** Publishes `message` unchanged; resolves to its message id. */
  publish(topic: string, message: RawMessage): Promise<string>;
  /** Receives from `subscription` for up to `timeoutMs`, settling each delivery by `decide`; returns each message id once. */
  pull(subscription: string, options: DlqPullOptions): Promise<DlqPulledMessage[]>;
  createSubscription(topic: string, subscription: string): Promise<void>;
  deleteSubscription(subscription: string): Promise<void>;
  close(): Promise<void>;
}

/** One finished run of the replay bin. */
export interface ReplayRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `file` with `args` and `env` without a shell; resolves on any exit and rejects when it cannot start, or with code `ETIMEDOUT` past {@link REPLAY_EXEC_TIMEOUT_MS}. */
export type ReplayExec = (file: string, args: readonly string[], env: EnvLike) => Promise<ReplayRun>;

/** Collaborators of {@link runDlqCheck}; unset ones use the stub target, the Pub/Sub emulator and {@link OPT2_EVENTS_BIN}. */
export type DlqDeps = SeamDeps & {
  target?: DlqTarget;
  pubsub?: DlqPubSub;
  exec?: ReplayExec;
  /** Default {@link DEFAULT_LAND_TIMEOUT_MS}. */
  landTimeoutMs?: number;
};

/** Outcome of one `opt2-events replay` run. */
export interface ReplayEvidence {
  exitCode: number | null;
  /** The parsed JSON summary line; null when stdout ends in none. */
  summary: Record<string, unknown> | null;
  /** The summary's {@link REPLAY_COUNT_KEY} count. */
  republished: number | null;
}

/** Evidence of {@link runDlqCheck}; null values were not reached. */
export interface DlqEvidence {
  subscription: string;
  dlqTopic: string;
  eventId: string;
  aggregateId: string;
  rejection: { reason: string | null; effectAfter: number | null };
  correction: { discardedOriginal: boolean };
  replay: ReplayEvidence;
  effect: { before: number | null; after: number | null };
  secondReplay: ReplayEvidence & { effectAfter: number | null };
  failures: string[];
}

/** Result of {@link runDlqCheck}. */
export interface DlqResult {
  passed: boolean;
  evidence: DlqEvidence;
}

interface CheckContext {
  target: DlqTarget;
  deps: DlqDeps;
  pubsub: DlqPubSub;
  exec: ReplayExec;
  childEnv: EnvLike;
  landTimeoutMs: number;
  valid: EventEnvelope;
  evidence: DlqEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A projection row counts its `apply_count` applications; a row without one counts once.
function applications(row: Record<string, unknown>): number {
  const count = Number(row.apply_count);
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
}

/** The stub's note subscription as a {@link DlqTarget}; the effect is the note's `stub.note_projection` applications. */
export function stubDlqTarget(options: StubDlqTargetOptions = {}): DlqTarget {
  const tenantId = options.tenantId ?? TENANT_A.tenantId;
  const now = options.now ?? Date.now;
  let validator: TopicValidator<StubNotePayload> | undefined;
  return {
    subscription: STUB_DLQ_SUBSCRIPTION,
    topic: STUB_NOTE_TOPIC,
    tenantId,
    effectUnit: STUB_EFFECT_UNIT,
    buildEnvelope(): EventEnvelope {
      const noteId = cfUuid();
      const payload: StubNotePayload = {
        noteId,
        title: 'DLQ replay check',
        body: `Dead-letter replay evidence for note ${noteId}.`,
        created: localTimestamp(new Date(now())),
        rowVersion: 1,
      };
      validator ??= compileTopicSchema<StubNotePayload>(readTopicSchema(repoPath(topicSchemaRelativePath(STUB_NOTE_TOPIC))));
      const checked = validator.validatePayload(payload);
      if (!checked.ok) throw new Error(`stub note payload fails ${STUB_NOTE_TOPIC}: ${checked.errors.join('; ')}`);
      return testEnvelope({ topic: STUB_NOTE_TOPIC, tenantId, aggregateId: noteId, aggregateVersion: 1, payload });
    },
    async effectCount(aggregateId: string, deps: SeamDeps): Promise<number> {
      const { rows } = await readOwnerExport({ service: 'stub', unit: STUB_EFFECT_UNIT, tenantId }, deps);
      const noteId = aggregateId.toUpperCase();
      return rows
        .filter((row) => typeof row.note_id === 'string' && row.note_id.toUpperCase() === noteId)
        .reduce((sum, row) => sum + applications(row), 0);
    },
  };
}

/** Receives from `name` on `pubsub` within the window of `options`; messages arriving after it are nacked on close. */
async function streamPull(pubsub: PubSub, name: string, options: DlqPullOptions): Promise<DlqPulledMessage[]> {
  const receiver = pubsub.subscription(name, {
    flowControl: { maxMessages: PULL_MAX_MESSAGES, allowExcessMessages: false },
    closeOptions: { behavior: 'NACK' },
  });
  const received = new Map<string, DlqPulledMessage>();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, options.timeoutMs);
      receiver.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      receiver.on('message', (message: Message) => {
        const pulled: DlqPulledMessage = {
          id: message.id,
          data: message.data,
          attributes: { ...message.attributes },
          ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
        };
        if (options.decide(pulled) === 'ack') message.ack();
        else message.nack();
        if (!received.has(pulled.id)) received.set(pulled.id, pulled);
        if (options.done?.([...received.values()]) === true) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    // The error listener stays, so an error emitted while closing is not thrown as an unhandled event.
    receiver.removeAllListeners('message');
    await receiver.close();
  }
  return [...received.values()];
}

/** {@link DlqPubSub} on the Pub/Sub emulator at `emulatorHost`, in `projectId`. */
export function emulatorDlqPubSub(options: { projectId: string; emulatorHost: string }): DlqPubSub {
  const { projectId, emulatorHost } = options;
  const pubsub = new PubSub({ projectId, apiEndpoint: emulatorHost, emulatorMode: true });
  const publisher = createPublisher({ projectId, pubsub });
  return {
    publish: (topic, message) => publisher.publishRaw(topic, message),
    pull: (subscription, pullOptions) => streamPull(pubsub, subscription, pullOptions),
    async createSubscription(topic, subscription) {
      await pubsub.topic(topic).createSubscription(subscription);
    },
    async deleteSubscription(subscription) {
      await pubsub.subscription(subscription).delete();
    },
    // The publisher flushes its topics, then closes the shared client.
    close: () => publisher.close(),
  };
}

/** {@link ReplayExec} on `defaultRunner` in the current directory; rejects with code `ETIMEDOUT` past {@link REPLAY_EXEC_TIMEOUT_MS}. */
export const defaultReplayExec: ReplayExec = async (file, args, env) => {
  try {
    const { stdout, stderr } = await defaultRunner(file, args, { cwd: process.cwd(), env, timeoutMs: REPLAY_EXEC_TIMEOUT_MS });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof code === 'number') return { exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' };
    // The execFile error a timeout carries as its cause quotes the child's stderr, so it is dropped.
    if (code === 'ETIMEDOUT') throw Object.assign(new Error((error as Error).message), { code });
    throw error;
  }
};

/** Arguments of one `opt2-events replay` run for `subscription`. */
export function replayArgs(subscription: string): string[] {
  return ['replay', '--subscription', subscription, '--idle-seconds', String(REPLAY_IDLE_SECONDS)];
}

/** The JSON object on the last non-empty line of `stdout`, else null. */
export function parseReplaySummary(stdout: string): Record<string, unknown> | null {
  const line = stdout.trimEnd().split('\n').at(-1)?.trim();
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** `eventId` of the envelope in a message's data, else its `eventId` attribute. */
function eventIdOf(message: RawMessage): string | undefined {
  let decoded: unknown;
  try {
    decoded = decodeEnvelopeData(message.data);
  } catch (err) {
    // A dead letter carries the delivery's bytes unchanged, so its data need not be JSON.
    if (!(err instanceof SyntaxError)) throw err;
  }
  const fromData = isRecord(decoded) ? decoded.eventId : undefined;
  return typeof fromData === 'string' ? fromData : message.attributes.eventId;
}

function emptyReplay(): ReplayEvidence {
  return { exitCode: null, summary: null, republished: null };
}

/** Runs the replay bin once and records a failure unless it exits 0 having republished `expected` messages; a timed-out run has a null exit code. */
async function replayOnce(ctx: CheckContext, label: string, expected: number): Promise<ReplayEvidence> {
  let run: ReplayRun;
  try {
    run = await ctx.exec(OPT2_EVENTS_BIN, replayArgs(ctx.target.subscription), ctx.childEnv);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ETIMEDOUT') throw err;
    ctx.evidence.failures.push(`${label} timed out after ${REPLAY_EXEC_TIMEOUT_MS} ms`);
    return emptyReplay();
  }
  const summary = parseReplaySummary(run.stdout);
  const count = summary?.[REPLAY_COUNT_KEY];
  const republished = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  const { failures } = ctx.evidence;
  if (run.exitCode !== 0) failures.push(`${label} exited ${run.exitCode}: ${run.stderr.trim()}`);
  else if (republished === null) failures.push(`${label} printed no summary line with a ${REPLAY_COUNT_KEY} count`);
  else if (republished !== expected) failures.push(`${label} republished ${republished}, expected ${expected}`);
  return { exitCode: run.exitCode, summary, republished };
}

/** Publishes the tenant-less copy and reads its dead letter; false when none arrived, so there is nothing to correct. */
async function observeRejection(ctx: CheckContext, observer: string): Promise<boolean> {
  const { target, valid, evidence } = ctx;
  const { tenantId: _tenant, ...attributes } = envelopeAttributes(valid);
  await ctx.pubsub.publish(target.topic, {
    data: Buffer.from(JSON.stringify(withoutTenant(valid)), 'utf8'),
    attributes,
    orderingKey: valid.aggregateId,
  });
  const isOurs = (message: RawMessage): boolean => eventIdOf(message) === valid.eventId;
  const received = await ctx.pubsub.pull(observer, {
    timeoutMs: ctx.landTimeoutMs,
    decide: () => 'ack',
    done: (messages) => messages.some(isOurs),
  });
  const letter = received.find(isOurs);
  const effectAfter = await target.effectCount(valid.aggregateId, ctx.deps);
  evidence.rejection.effectAfter = effectAfter;
  if (effectAfter !== 0) evidence.failures.push(`tenant-less delivery produced ${effectAfter} effect(s), expected 0`);
  if (letter === undefined) {
    evidence.failures.push(`no dead letter of event ${valid.eventId} on ${evidence.dlqTopic} within ${ctx.landTimeoutMs} ms`);
    return false;
  }
  const raw = letter.attributes[DEAD_LETTER_REASON_ATTRIBUTE];
  evidence.rejection.reason = raw ?? null;
  const { reason } = describeDeadLetter(letter.attributes);
  if (reason === undefined) {
    evidence.failures.push(`dead letter reason ${JSON.stringify(raw ?? null)} is not one of ${DEAD_LETTER_REASONS.join('|')}`);
  } else if (reason !== EXPECTED_DLQ_REASON) {
    evidence.failures.push(`dead letter reason ${reason}, expected ${EXPECTED_DLQ_REASON}`);
  }
  return true;
}

/** Discards the bad original, re-enqueues the corrected copy, then replays twice and reads the effect after each run. */
async function correctAndReplay(ctx: CheckContext, replaySubscription: string): Promise<void> {
  const { target, valid, evidence } = ctx;
  const isOurs = (message: RawMessage): boolean => eventIdOf(message) === valid.eventId;
  const effectCount = (): Promise<number> => target.effectCount(valid.aggregateId, ctx.deps);

  const discarded = await ctx.pubsub.pull(replaySubscription, {
    timeoutMs: ctx.landTimeoutMs,
    decide: (message) => (isOurs(message) ? 'ack' : 'nack'),
    done: (messages) => messages.some(isOurs),
  });
  evidence.correction.discardedOriginal = discarded.some(isOurs);
  if (!evidence.correction.discardedOriginal) {
    evidence.failures.push(`dead letter of event ${valid.eventId} not found on ${replaySubscription} within ${ctx.landTimeoutMs} ms`);
  }
  await ctx.pubsub.publish(evidence.dlqTopic, {
    data: encodeEnvelope(valid),
    attributes: { ...envelopeAttributes(valid), [DEAD_LETTER_REASON_ATTRIBUTE]: EXPECTED_DLQ_REASON },
    orderingKey: valid.aggregateId,
  });

  const before = await effectCount();
  evidence.effect.before = before;
  if (before !== 0) evidence.failures.push(`effect count before replay is ${before}, expected 0`);
  evidence.replay = await replayOnce(ctx, 'replay', 1);
  if (evidence.replay.exitCode !== 0) return;

  const poll = await pollUntil(effectCount, (count) => count >= 1, ctx.deps);
  if (!poll.timedOut) await (ctx.deps.sleep ?? ((ms: number) => delay(ms)))(EFFECT_SETTLE_MS);
  const after = poll.timedOut ? poll.value : await effectCount();
  evidence.effect.after = after;
  if (after !== 1) evidence.failures.push(`effect count after replay is ${after}, expected 1`);

  const second = await replayOnce(ctx, 'second replay', 0);
  const effectAfter = await effectCount();
  evidence.secondReplay = { ...second, effectAfter };
  if (effectAfter !== 1) evidence.failures.push(`effect count after the second replay is ${effectAfter}, expected 1`);
}

/** Requires an empty replay backlog, then observes the rejection and replays inside a throwaway observer subscription. */
async function checkDeadLetterReplay(ctx: CheckContext): Promise<void> {
  const { evidence } = ctx;
  const replaySubscription = dlqReplaySubscriptionName(ctx.target.subscription);
  const backlog = await ctx.pubsub.pull(replaySubscription, { timeoutMs: PRECONDITION_PULL_MS, decide: () => 'nack' });
  if (backlog.length > 0) {
    evidence.failures.push(`precondition: dlq replay backlog not empty (${backlog.map((message) => message.id).join(', ')})`);
    return;
  }
  // createTestSubscription accepts only `<service>.<entity>.<event>.v<major>` topics, so the `.dlq` observer is created here.
  const observer = `opt2-dlq-check-${randomBytes(4).toString('hex')}.${evidence.dlqTopic}`;
  await ctx.pubsub.createSubscription(evidence.dlqTopic, observer);
  try {
    if (await observeRejection(ctx, observer)) await correctAndReplay(ctx, replaySubscription);
  } finally {
    try {
      await ctx.pubsub.deleteSubscription(observer);
    } catch (err) {
      evidence.failures.push(`observer subscription ${observer} not deleted: ${messageOf(err)}`);
    }
  }
}

/** Dead-letters a tenant-less copy of a valid event, replays the corrected copy and proves one republish and one effect. */
export async function runDlqCheck(deps: DlqDeps = {}): Promise<DlqResult> {
  const target = deps.target ?? stubDlqTarget({ now: deps.now });
  if (topicOfSubscription(target.subscription) !== target.topic) {
    throw new RangeError(`target subscription ${target.subscription} does not consume topic ${target.topic}`);
  }
  const valid = target.buildEnvelope();
  const evidence: DlqEvidence = {
    subscription: target.subscription,
    dlqTopic: dlqTopicName(target.subscription),
    eventId: valid.eventId,
    aggregateId: valid.aggregateId,
    rejection: { reason: null, effectAfter: null },
    correction: { discardedOriginal: false },
    replay: emptyReplay(),
    effect: { before: null, after: null },
    secondReplay: { ...emptyReplay(), effectAfter: null },
    failures: [],
  };
  const env = deps.env ?? process.env;
  const projectId = env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT;
  const childEnv: EnvLike = { ...process.env, ...env, GOOGLE_CLOUD_PROJECT: projectId };

  let pubsub = deps.pubsub;
  let owned: DlqPubSub | undefined;
  // The probe guards only the emulator client built here; an injected client is the caller's to provide.
  if (pubsub === undefined) {
    const emulatorHost = childEnv.PUBSUB_EMULATOR_HOST;
    if (!emulatorHost || !(await pubsubEmulatorAvailable())) {
      evidence.failures.push('pubsub emulator unavailable');
      return { passed: false, evidence };
    }
    owned = pubsub = emulatorDlqPubSub({ projectId, emulatorHost });
  }
  try {
    await checkDeadLetterReplay({
      target,
      deps,
      pubsub,
      exec: deps.exec ?? defaultReplayExec,
      childEnv,
      landTimeoutMs: deps.landTimeoutMs ?? DEFAULT_LAND_TIMEOUT_MS,
      valid,
      evidence,
    });
  } finally {
    await owned?.close();
  }
  return { passed: evidence.failures.length === 0, evidence };
}
