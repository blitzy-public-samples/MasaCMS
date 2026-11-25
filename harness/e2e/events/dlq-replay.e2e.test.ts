// Event delivery guarantees on the running stack under cut-over table v0002: duplicate and out-of-order delivery, lost
// deliveries, the outbox sweep and its chain, DLQ replay and the full outbox replay; results feed opt2/reports/events.json.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  compileTopicSchema,
  createPublisher,
  decodeEnvelopeData,
  dlqTopicName,
  readTopicSchema,
  topicMeta,
  topicSchemaRelativePath,
  type EventEnvelope,
  type EventPublisher,
  type RawMessage,
  type TopicValidator,
} from '@opt2/platform/events';
import { cfDateTimeFormat, cfUuid } from '@opt2/platform/legacy-compat';
import { parseSlotName, queueDefinition } from '@opt2/platform/tasks';
import { TENANT_A, testEnvelope } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

import {
  STUB_DLQ_SUBSCRIPTION,
  STUB_NOTES_PATH,
  STUB_NOTE_TOPIC,
  defaultReplayExec,
  emulatorDlqPubSub,
  readStubProjection,
  runDlqCheck,
  stubDlqTarget,
  type StubProjection,
} from '../../src/events/dlq.js';
import { runOutboxReplay, type OutboxReplayResult } from '../../src/events/outbox-replay.js';
import {
  CHECK_TAG,
  EVENT_CHECK_IDS,
  e2eResultPath,
  main,
  recordEventResult,
  type EventE2EKey,
} from '../../src/events/report.js';
import {
  fanoutDestinations,
  pollUntil,
  readOwnerExport,
  siteRegistry,
  type PollBounds,
  type SeamDeps,
  type SeamDestination,
} from '../../src/events/seams.js';
import { createHttpSession, type HttpSession } from '../../src/lib/http.js';
import { HARNESS_ROOT, repoPath, type EnvLike } from '../../src/lib/paths.js';
import { sessionForSubject } from '../helpers/admin-login.js';
import {
  killService,
  migrationInvoker,
  readStack,
  requireTableVersion,
  serviceUrl,
  startService,
  stopService,
  waitHealthy,
  withRestoredServices,
  type ServiceName,
} from '../helpers/stack.js';

const SOURCE = 'harness/e2e/events/dlq-replay.e2e.test.ts';
const TABLE_VERSION = 'v0002';
/** Process topic of the stub's note comments; the stub's consumer adds one `stub.note_activity` row per applied event. */
const COMMENT_TOPIC = 'stub.note.commented.v1';
const ACTIVITY_UNIT = 'stub.note_activity';
/** Path of the owners' `migrationPosition` operation, which every service serves. */
const POSITION_PATH = '/internal/v1/migration/position';
const SWEEP_QUEUE = 'stub-outbox-sweep';
const OPT2_TASKS_BIN = path.join(HARNESS_ROOT, 'node_modules', '.bin', 'opt2-tasks');
const RECONCILE_ARGS = ['reconcile', '--queue', SWEEP_QUEUE, '--include-local-only', '--as', 'operator'] as const;
/** Emulator project of the testing helpers and the DLQ check when `GOOGLE_CLOUD_PROJECT` is unset. */
const DEFAULT_PROJECT = 'opt2-local';
/** Nothing listens on port 1, so every publish of a process started with it fails. */
const UNREACHABLE_EMULATOR = '127.0.0.1:1';
/** Lower bound of the full replay: every outbox row the stack holds. */
const FULL_REPLAY_SINCE = new Date(0);
// The stub contract has no task-delete or fault route and its queue control only pauses, resumes and ensures, so the chain's
// live task cannot be dropped without SQL on stub.scheduled_task_queue, which no harness code may run.
const NO_DROP_SURFACE = 'no supported control surface drops a live task without SQL on a service schema';
/** Keys this suite records; `fanoutRedelivery` belongs to seams.e2e.test.ts. */
const OWN_KEYS: readonly EventE2EKey[] = [...EVENT_CHECK_IDS.filter((id) => id !== 'fanoutRedelivery'), 'outboxReplay'];

// Each bound keeps a stalled delivery from hanging the run.
const SETUP_TIMEOUT_MS = 120_000;
const DELIVERY_TEST_TIMEOUT_MS = 120_000;
/** Checks that stop, kill or restart a process: the 60 s sweep interval or the push backoff, plus the restart and restore. */
const RESTART_TEST_TIMEOUT_MS = 240_000;
const REPLAY_TEST_TIMEOUT_MS = 600_000;
/** Push delivery to a running consumer. */
const DELIVERY_POLL: Required<PollBounds> = { timeoutMs: 45_000, intervalMs: 1_000 };
/** Redelivery once the consumer is back; the push backoff doubles from 10 s. */
const REDELIVERY_POLL: Required<PollBounds> = { timeoutMs: 120_000, intervalMs: 2_000 };
/** Quiet period after the delivery evidence before an effect is read again. */
const SETTLE_MS = 5_000;
/** Out-of-order process check: the first projection, two receipts and two activity polls at their bound, and the reads around them. */
const PROCESS_ORDER_TEST_TIMEOUT_MS = 5 * DELIVERY_POLL.timeoutMs + 60_000;
/** Aggregate versions of the out-of-order comments: the later comment is delivered first. */
const LATE_VERSION = 2;
const EARLY_VERSION = 1;
/** CFML mask of the contract's local `timestamp(3)` text, `yyyy-MM-dd HH:mm:ss.SSS`. */
const LOCAL_TIMESTAMP_MASK = 'yyyy-MM-dd HH:nn:ss.lll';

type Evidence = Record<string, unknown>;
type Row = Record<string, unknown>;
/** Keys whose evidence is free-form; `outboxReplay` must hold an {@link OutboxReplayResult}. */
type CheckKey = Exclude<EventE2EKey, 'outboxReplay'>;

/** Payload of `stub.note.created.v1`, as the note's save envelope also carries it. */
interface StubNote {
  noteId: string;
  title: string;
  body: string;
  created: string;
  rowVersion: number;
}

/** Fields of the owners' `PositionResponse` this suite reads. */
interface PositionAnswer {
  outbox: { unpublished: number; held: number } | null;
  inbox: { bySubscription: Record<string, number>; receipts?: Record<string, string[]> } | null;
}

/** Unpublished outbox rows (null without an outbox), inbox rows by subscription and receipt tenants by lower-cased event id. */
interface ServicePosition {
  unpublished: number | null;
  bySubscription: Record<string, number>;
  receipts: Record<string, string[]>;
}

/** Payload of `stub.note.commented.v1`. */
interface NoteComment {
  noteId: string;
  commentId: string;
  body: string;
  created: string;
}

/** One `stub.note_activity` row: the event that wrote it and its comment, case-folded. */
interface ActivityRecord {
  eventId: string;
  commentId: string;
}

/** One out-of-order comment envelope, its delivery, the tenants holding its inbox receipt and its activity poll. */
interface OrderEvent {
  eventId: string;
  aggregateVersion: number;
  commentId: string;
  messageId: string | null;
  receipts: string[];
  activity: { polls: number; elapsedMs: number; timedOut: boolean } | null;
}

/** One `opt2-tasks reconcile` result line. */
interface ReconcileLine {
  queue: string;
  service: string;
  ok: boolean;
  created?: boolean;
  name?: string;
  reason?: string;
  error?: string;
}

/** What a check body may report besides pass or fail. */
interface CheckOutcome {
  inconclusive?: string;
}

let noteSession: HttpSession | undefined;
let noteValidator: TopicValidator<StubNote> | undefined;
let commentValidator: TopicValidator<NoteComment> | undefined;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
}

/** String column `name` of an export row, '' when absent. */
function text(row: Row | undefined, name: string): string {
  const value = row?.[name];
  return typeof value === 'string' ? value : '';
}

/** Comparison form of a CF UUID: `char(35)` padding dropped and case folded. */
function idKey(id: string): string {
  return id.trimEnd().toUpperCase();
}

function tag(): string {
  return randomBytes(4).toString('hex');
}

function notes(): HttpSession {
  if (noteSession === undefined) throw new Error('beforeAll opened no tenant-a system-user gateway session');
  return noteSession;
}

/** Migration-credential deps of the owner export reads. */
async function seamDeps(): Promise<SeamDeps> {
  return { invoker: await migrationInvoker() };
}

/** Recorded environment of `name` over the runner's, as its own tools see it. */
function processEnv(name: ServiceName): EnvLike {
  const entry = readStack().processes[name];
  if (entry === undefined) throw new Error(`up.json records no ${name} process`);
  return { ...process.env, ...entry.env };
}

/** Project and emulator of the running stack, as the stub's recorded environment names them. */
function stackPubSub(): { projectId: string; emulatorHost: string } {
  const env = processEnv('stub');
  const emulatorHost = env.PUBSUB_EMULATOR_HOST;
  if (!emulatorHost) throw new Error('neither the stub nor the runner sets PUBSUB_EMULATOR_HOST');
  return { projectId: env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT, emulatorHost };
}

/** Runs `fn` with a platform publisher on the stack's emulator and closes it afterwards. */
async function withStackPublisher<T>(fn: (publisher: EventPublisher) => Promise<T>): Promise<T> {
  const publisher = createPublisher(stackPubSub());
  try {
    return await fn(publisher);
  } finally {
    await publisher.close();
  }
}

/** Publishes `envelope` to `topic` on the stack's emulator as the platform publisher does; resolves to its message id. */
function publishTo(topic: string, envelope: EventEnvelope): Promise<string> {
  return withStackPublisher((publisher) => publisher.publish(topic, envelope));
}

/** `candidate` as a `stub.note.created.v1` payload; throws with the schema errors when it is not one. */
function notePayload(candidate: unknown): StubNote {
  noteValidator ??= compileTopicSchema<StubNote>(readTopicSchema(repoPath(topicSchemaRelativePath(STUB_NOTE_TOPIC))));
  const checked = noteValidator.validatePayload(candidate);
  if (!checked.ok) {
    throw new Error(`not a ${STUB_NOTE_TOPIC} payload (${checked.errors.join('; ')}): ${JSON.stringify(candidate)}`);
  }
  return checked.value;
}

/** A tenant-a `stub.note.created.v1` envelope of `note` at `version`; a fresh `eventId` unless one is given. */
function noteEnvelope(note: StubNote, version: number, eventId?: string): EventEnvelope<StubNote> {
  return testEnvelope({
    topic: STUB_NOTE_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: note.noteId,
    aggregateVersion: version,
    eventId,
    payload: notePayload({ ...note, rowVersion: version }),
  });
}

/** Creates a tenant-a note through the gateway; returns it as its save envelope carries it. */
async function createNote(session: HttpSession, body: { title: string; body: string }): Promise<StubNote> {
  const result = await session.post(STUB_NOTES_PATH, { query: { siteid: TENANT_A.siteId }, json: body });
  if (result.status !== 200) throw new Error(`note create through the gateway answered ${result.status}: ${result.text}`);
  const data = asRecord(asRecord(result.json())?.data);
  return notePayload({
    noteId: data?.noteid,
    title: data?.title,
    body: data?.body,
    created: data?.created,
    rowVersion: Number(data?.rowversion),
  });
}

/**
 * Creates a tenant-a note through the gateway while the stub cannot publish; resolves to the committed note's id.
 * The stub abandons a request whose events it could not publish, so the gateway answers its fail-closed 503 and the note is found by its unique title.
 */
async function createUnpublishedNote(session: HttpSession, body: { title: string; body: string }): Promise<string> {
  const created = await session.post(STUB_NOTES_PATH, { query: { siteid: TENANT_A.siteId }, json: body });
  if (created.status !== 503) throw new Error(`note create through the gateway answered ${created.status}, not the 503 of an abandoned request: ${created.text}`);
  let after: string | null = null;
  do {
    const query: Record<string, string> = { siteid: TENANT_A.siteId, limit: '1000', ...(after === null ? {} : { after }) };
    const listed = await session.get(STUB_NOTES_PATH, { query });
    if (listed.status !== 200) throw new Error(`note list through the gateway answered ${listed.status}: ${listed.text}`);
    const page = asRecord(asRecord(listed.json())?.data);
    const items: unknown[] = Array.isArray(page?.items) ? page.items : [];
    const noteId = items.map(asRecord).find((item) => item?.title === body.title)?.noteid;
    if (typeof noteId === 'string') return noteId;
    after = typeof page?.next === 'string' ? page.next : null;
  } while (after !== null);
  throw new Error(`no committed note is titled ${body.title}`);
}

/** The note's `stub.note_projection` row read through the gateway; null until a delivery is consumed. */
function projectionOf(session: HttpSession, noteId: string): Promise<StubProjection | null> {
  return readStubProjection({ session, siteId: TENANT_A.siteId }, noteId);
}

/** Polls the projection of `noteId` until `done` holds; throws naming `what` and the last read otherwise. */
async function awaitProjection(
  noteId: string,
  done: (projection: StubProjection) => boolean,
  what: string,
  poll: Required<PollBounds> = DELIVERY_POLL,
): Promise<StubProjection> {
  const outcome = await pollUntil(() => projectionOf(notes(), noteId), (projection) => projection !== null && done(projection), {
    poll,
  });
  if (outcome.timedOut || outcome.value === null) {
    throw new Error(`${what} not seen on note ${noteId} within ${poll.timeoutMs} ms; last read ${JSON.stringify(outcome.value)}`);
  }
  return outcome.value;
}

/** A new tenant-a note and the projection of its first delivery. */
async function freshProjectedNote(): Promise<{ note: StubNote; projection: StubProjection }> {
  const note = await createNote(notes(), { title: `Delivery guarantees note ${tag()}`, body: 'Event delivery guarantee evidence.' });
  const projection = await awaitProjection(note.noteId, () => true, 'the first delivery');
  return { note, projection };
}

/** `service`'s outbox and inbox position with the receipts of `eventIds`, read as `platform.migration`. */
async function positionOf(service: ServiceName, eventIds: readonly string[]): Promise<ServicePosition> {
  const base = serviceUrl(service);
  const url = new URL(POSITION_PATH, base);
  if (eventIds.length > 0) url.searchParams.set('eventIds', eventIds.join(','));
  const headers = await (await migrationInvoker()).headersFor({ callee: service, url: url.href });
  const result = await createHttpSession({ baseUrl: base }).get(url.href, { headers });
  if (result.status !== 200) throw new Error(`${service} migration position answered ${result.status}: ${result.text}`);
  const { outbox, inbox } = result.json<PositionAnswer>();
  if (inbox === null) throw new Error(`${service} migration position lacks its inbox: ${result.text}`);
  return { unpublished: outbox?.unpublished ?? null, bySubscription: inbox.bySubscription, receipts: inbox.receipts ?? {} };
}

/** Inbox rows of the stub's note subscription in `position`. */
function noteInboxRows(position: ServicePosition): number {
  return position.bySubscription[STUB_DLQ_SUBSCRIPTION] ?? 0;
}

/** Sorted, lower-cased tenants holding an inbox receipt of `eventId` in `position`. */
function receiptTenants(position: ServicePosition, eventId: string): string[] {
  return (position.receipts[eventId.toLowerCase()] ?? []).map((tenantId) => tenantId.toLowerCase()).sort();
}

/** Polls until `eventId` holds an inbox receipt at `service` in each of `tenantIds`, so each destination consumed it. */
async function awaitReceipt(service: ServiceName, eventId: string, tenantIds: readonly string[]): Promise<ServicePosition> {
  const tenants = tenantIds.map((tenantId) => tenantId.toLowerCase());
  const outcome = await pollUntil(
    () => positionOf(service, [eventId]),
    (position) => {
      const held = receiptTenants(position, eventId);
      return tenants.every((tenant) => held.includes(tenant));
    },
    { poll: DELIVERY_POLL },
  );
  if (outcome.timedOut) {
    throw new Error(
      `no ${service} inbox receipt of event ${eventId} in each of ${tenants.join(', ')} within ${DELIVERY_POLL.timeoutMs} ms; ` +
        `last receipts ${JSON.stringify(receiptTenants(outcome.value, eventId))}`,
    );
  }
  return outcome.value;
}

/** Whether a dead letter carries event `eventId`, by its mirrored attribute or its envelope data. */
function isLetterOf(eventId: string): (message: RawMessage) => boolean {
  return (message) => {
    if (message.attributes.eventId === eventId) return true;
    try {
      return asRecord(decodeEnvelopeData(message.data))?.eventId === eventId;
    } catch (err) {
      // A dead letter carries the delivery's bytes unchanged, so its data need not be JSON.
      if (err instanceof SyntaxError) return false;
      throw err;
    }
  };
}

/**
 * Runs `body` for check `key`. A pending `fail` is written first, so a test cut off by its timeout stays failed; the
 * outcome and the evidence `body` gathered are written last, and an inconclusive outcome leaves no record.
 */
async function runCheck(
  key: CheckKey,
  ctx: TestContext,
  body: (evidence: Evidence) => Promise<CheckOutcome | void>,
): Promise<void> {
  const write = (result: 'pass' | 'fail', evidence: unknown): Promise<string> =>
    recordEventResult<string>(key, { result, evidence, source: SOURCE });
  await write('fail', { error: 'did not finish' });
  const evidence: Evidence = {};
  let failure: unknown;
  let outcome: CheckOutcome | void = undefined;
  try {
    outcome = await body(evidence);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (failure === undefined && ctx.signal.aborted) failure = new Error('finished after the test timeout');
    if (failure !== undefined) {
      await write('fail', { ...evidence, error: messageOf(failure) });
    } else if (outcome?.inconclusive !== undefined) {
      await rm(e2eResultPath(key), { force: true });
      await ctx.annotate(`inconclusive: ${outcome.inconclusive}`, 'notice');
    } else {
      await write('pass', evidence);
    }
  }
}

/** `candidate` as a `stub.note.commented.v1` payload; throws with the schema errors when it is not one. */
function commentPayload(candidate: unknown): NoteComment {
  commentValidator ??= compileTopicSchema<NoteComment>(readTopicSchema(repoPath(topicSchemaRelativePath(COMMENT_TOPIC))));
  const checked = commentValidator.validatePayload(candidate);
  if (!checked.ok) {
    throw new Error(`not a ${COMMENT_TOPIC} payload (${checked.errors.join('; ')}): ${JSON.stringify(candidate)}`);
  }
  return checked.value;
}

/** A tenant-a `stub.note.commented.v1` envelope of a new comment on `note` at `version`. */
function commentEnvelope(note: StubNote, version: number): EventEnvelope<NoteComment> {
  return testEnvelope({
    topic: COMMENT_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: note.noteId,
    aggregateVersion: version,
    payload: commentPayload({
      noteId: note.noteId,
      commentId: cfUuid(),
      body: `Out-of-order comment version ${version}`,
      created: cfDateTimeFormat(new Date(), LOCAL_TIMESTAMP_MASK),
    }),
  });
}

/** Destinations the consumer's registry derives for a tenant-a event on `topic`, under the topic's declared fan-out. */
async function destinationsOf(topic: string): Promise<SeamDestination[]> {
  const fanout = topicMeta(readTopicSchema(repoPath(topicSchemaRelativePath(topic)))).fanout ?? null;
  return fanoutDestinations(TENANT_A.siteId, await siteRegistry(await seamDeps()), fanout);
}

function byEventId(a: ActivityRecord, b: ActivityRecord): number {
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** `noteId`'s `stub.note_activity` rows in `tenantId`, one entry per row, sorted by event id. */
async function activityOf(noteId: string, tenantId: string): Promise<ActivityRecord[]> {
  const { rows } = await readOwnerExport({ service: 'stub', unit: ACTIVITY_UNIT, tenantId }, await seamDeps());
  const note = idKey(noteId);
  return rows
    .filter((row) => idKey(text(row, 'note_id')) === note)
    .map((row) => ({ eventId: text(row, 'event_id').toLowerCase(), commentId: idKey(text(row, 'comment_id')) }))
    .sort(byEventId);
}

/** The activity records `envelopes` add, in {@link activityOf} order. */
function expectedActivity(envelopes: readonly EventEnvelope<NoteComment>[]): ActivityRecord[] {
  return envelopes
    .map(({ eventId, payload }) => ({ eventId: eventId.toLowerCase(), commentId: idKey(payload.commentId) }))
    .sort(byEventId);
}

/** Whether `actual` holds each expected record once (`matched`), still lacks some (`pending`), or holds a duplicate or stray one. */
function activityState(expected: readonly ActivityRecord[], actual: readonly ActivityRecord[]): 'matched' | 'pending' | 'broken' {
  const keyOf = (record: ActivityRecord): string => `${record.eventId} ${record.commentId}`;
  const want = new Set(expected.map(keyOf));
  const held = actual.map(keyOf);
  if (new Set(held).size !== held.length || held.some((key) => !want.has(key))) return 'broken';
  return held.length === want.size ? 'matched' : 'pending';
}

/** The delivery record of `envelope`, before it is published. */
function orderEvent(envelope: EventEnvelope<NoteComment>): OrderEvent {
  const { eventId, aggregateVersion, payload } = envelope;
  return { eventId, aggregateVersion, commentId: payload.commentId, messageId: null, receipts: [], activity: null };
}

/**
 * Publishes `envelope`, then waits for its inbox receipt in each of `destinations` and for each to hold exactly the
 * activity of `delivered`, the envelopes published so far.
 */
async function deliverComment(
  envelope: EventEnvelope<NoteComment>,
  event: OrderEvent,
  destinations: readonly SeamDestination[],
  delivered: readonly EventEnvelope<NoteComment>[],
): Promise<void> {
  event.messageId = await publishTo(COMMENT_TOPIC, envelope);
  const tenantIds = destinations.map((destination) => destination.tenantId);
  event.receipts = receiptTenants(await awaitReceipt('stub', envelope.eventId, tenantIds), envelope.eventId);
  const expected = expectedActivity(delivered);
  const outcome = await pollUntil(
    () => Promise.all(destinations.map((destination) => activityOf(envelope.payload.noteId, destination.tenantId))),
    (observed) => destinations.every((_, i) => activityState(expected, observed[i] ?? []) !== 'pending'),
    { poll: DELIVERY_POLL },
  );
  event.activity = { polls: outcome.polls, elapsedMs: outcome.elapsedMs, timedOut: outcome.timedOut };
}

describe('event delivery guarantees', () => {
  beforeAll(async () => {
    // A record left by an earlier run would otherwise stand for a check this run did not reach.
    await Promise.all(OWN_KEYS.map((key) => rm(e2eResultPath(key), { force: true })));
    await requireTableVersion(TABLE_VERSION);
    noteSession = (await sessionForSubject('system-user', { origin: 'gateway', site: TENANT_A.siteId })).session;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await main([]);
  }, SETUP_TIMEOUT_MS);

  it(`duplicate delivery of one eventId gives one effect ${CHECK_TAG('duplicateDelivery')}`, { timeout: DELIVERY_TEST_TIMEOUT_MS }, (ctx) =>
    runCheck('duplicateDelivery', ctx, async (evidence) => {
      const { note, projection: before } = await freshProjectedNote();
      evidence.noteId = note.noteId;
      evidence.before = before;
      expect(before.applyCount, 'apply count after the first delivery').toBe(1);
      const original = before.lastEventId;
      const inboxBefore = await positionOf('stub', [original]);
      const copy = noteEnvelope(note, before.aggregateVersion, original);
      evidence.copyMessageIds = [await publishTo(STUB_NOTE_TOPIC, copy), await publishTo(STUB_NOTE_TOPIC, copy)];
      // A stale event on the same ordering key is consumed after both copies, so its receipt bounds their delivery.
      const sentinel = noteEnvelope(note, before.aggregateVersion);
      evidence.sentinelEventId = sentinel.eventId;
      await publishTo(STUB_NOTE_TOPIC, sentinel);
      await awaitReceipt('stub', sentinel.eventId, [TENANT_A.tenantId]);
      await delay(SETTLE_MS);
      const after = await projectionOf(notes(), note.noteId);
      const inboxAfter = await positionOf('stub', [original]);
      const receipts = inboxAfter.receipts[original] ?? [];
      const subscriptionBefore = noteInboxRows(inboxBefore);
      const subscriptionAfter = noteInboxRows(inboxAfter);
      evidence.after = after;
      evidence.inbox = { subscriptionBefore, subscriptionAfter, receipts };
      expect(after, 'projection after two duplicate deliveries').toEqual(before);
      expect(receipts, `inbox receipt tenants of ${original}`).toEqual([TENANT_A.tenantId.toLowerCase()]);
      expect(subscriptionAfter - subscriptionBefore, 'inbox rows added besides the sentinel').toBe(1);
    }),
  );

  it(
    `stale state version is acknowledged and ignored while a version gap is applied ${CHECK_TAG('outOfOrderState')}`,
    { timeout: DELIVERY_TEST_TIMEOUT_MS },
    (ctx) =>
      runCheck('outOfOrderState', ctx, async (evidence) => {
        const { note, projection: before } = await freshProjectedNote();
        evidence.noteId = note.noteId;
        evidence.before = before;
        const pubsub = emulatorDlqPubSub(stackPubSub());
        const dlqTopic = dlqTopicName(STUB_DLQ_SUBSCRIPTION);
        const observer = `opt2-stale-check-${tag()}.${dlqTopic}`;
        await pubsub.createSubscription(dlqTopic, observer);
        try {
          const stale = noteEnvelope({ ...note, title: `${note.title} (stale)` }, before.aggregateVersion);
          evidence.staleEventId = stale.eventId;
          await publishTo(STUB_NOTE_TOPIC, stale);
          await awaitReceipt('stub', stale.eventId, [TENANT_A.tenantId]);
          const isOurs = isLetterOf(stale.eventId);
          const letters = await pubsub.pull(observer, {
            timeoutMs: SETTLE_MS,
            decide: () => 'ack',
            done: (received) => received.some(isOurs),
          });
          evidence.staleDeadLetters = letters.filter(isOurs).length;
          expect(evidence.staleDeadLetters, `dead letters of the stale event on ${dlqTopic}`).toBe(0);
        } finally {
          try {
            await pubsub.deleteSubscription(observer);
          } finally {
            await pubsub.close();
          }
        }
        const afterStale = await projectionOf(notes(), note.noteId);
        evidence.afterStale = afterStale;
        expect(afterStale, 'projection after the stale version').toEqual(before);

        const gapVersion = before.aggregateVersion + 2;
        const gap = noteEnvelope({ ...note, title: `${note.title} (gap)` }, gapVersion);
        evidence.gapEventId = gap.eventId;
        await publishTo(STUB_NOTE_TOPIC, gap);
        const isGap = (projection: StubProjection): boolean => projection.lastEventId === gap.eventId;
        const afterGap = await awaitProjection(note.noteId, isGap, 'the gap version');
        evidence.afterGap = afterGap;
        expect(afterGap, 'projection after the gap version').toEqual({
          applyCount: before.applyCount + 1,
          aggregateVersion: gapVersion,
          lastEventId: gap.eventId,
        });
      }),
  );

  it(
    `committed but unpublished outbox row is published by the sweep after its process is killed ${CHECK_TAG('unpublishedRowSwept')}`,
    { timeout: RESTART_TEST_TIMEOUT_MS },
    (ctx) =>
      runCheck('unpublishedRowSwept', ctx, async (evidence) => {
        const recurring = queueDefinition(SWEEP_QUEUE).recurring;
        if (recurring === undefined) throw new Error(`${SWEEP_QUEUE} is not a recurring queue`);
        const sweepPoll: Required<PollBounds> = { timeoutMs: recurring.intervalS * 1000 + 60_000, intervalMs: 2_000 };
        await withRestoredServices(['stub'], async () => {
          await stopService('stub');
          await startService('stub', { extraEnv: { PUBSUB_EMULATOR_HOST: UNREACHABLE_EMULATOR } });
          await waitHealthy('stub');
          const noteId = await createUnpublishedNote(notes(), { title: `Unpublished row ${tag()}`, body: 'Committed while publishing fails.' });
          evidence.noteId = noteId;
          const position = await positionOf('stub', []);
          evidence.unpublishedBeforeKill = position.unpublished;
          expect(position.unpublished, 'unpublished stub outbox rows before the kill').toBeGreaterThanOrEqual(1);
          const early = await projectionOf(notes(), noteId);
          evidence.projectedBeforeKill = early !== null;
          expect(early, 'projection before the kill').toBeNull();
          await killService('stub');
          await startService('stub');
          await waitHealthy('stub');
          const restartedAt = Date.now();
          const swept = await awaitProjection(noteId, () => true, 'the swept delivery', sweepPoll);
          evidence.sweptWithinMs = Date.now() - restartedAt;
          evidence.projection = swept;
          expect(swept.applyCount, 'apply count of the swept delivery').toBe(1);
        });
      }),
  );

  it(`reconcile finds the stub outbox sweep chain live ${CHECK_TAG('sweepChainRecreated')}`, { timeout: RESTART_TEST_TIMEOUT_MS }, (ctx) =>
    runCheck('sweepChainRecreated', ctx, async (evidence) => {
      const run = await defaultReplayExec(OPT2_TASKS_BIN, RECONCILE_ARGS, processEnv('stub'));
      const lines = run.stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as ReconcileLine);
      evidence.reconcile = { exitCode: run.exitCode, lines };
      expect(run.exitCode, `opt2-tasks reconcile: ${run.stderr.trim()}`).toBe(0);
      const line = lines.find((candidate) => candidate.queue === SWEEP_QUEUE && candidate.service === 'stub');
      expect(line, `reconcile lines: ${run.stdout.trim()}`).toMatchObject({ ok: true, reason: 'live' });
      const slotStartS = parseSlotName(SWEEP_QUEUE, line?.name ?? '');
      evidence.liveTask = { name: line?.name ?? null, slotStartS: slotStartS ?? null };
      expect(slotStartS, `live task ${line?.name ?? ''} is a ${SWEEP_QUEUE} slot`).toBeDefined();
      return { inconclusive: NO_DROP_SURFACE };
    }),
  );

  it(
    `comment versions 2 then 1 of one note each record their own activity once per destination ${CHECK_TAG('outOfOrderProcess')}`,
    { timeout: PROCESS_ORDER_TEST_TIMEOUT_MS },
    (ctx) =>
      runCheck('outOfOrderProcess', ctx, async (evidence) => {
        const { note } = await freshProjectedNote();
        const destinations = await destinationsOf(COMMENT_TOPIC);
        const later = commentEnvelope(note, LATE_VERSION);
        const earlier = commentEnvelope(note, EARLY_VERSION);
        const laterEvent = orderEvent(later);
        const earlierEvent = orderEvent(earlier);
        const events = [laterEvent, earlierEvent];
        Object.assign(evidence, { noteId: note.noteId, destinations, events });
        // Version 1 is published only once version 2 holds a receipt in every destination, so it is consumed second.
        await deliverComment(later, laterEvent, destinations, [later]);
        await deliverComment(earlier, earlierEvent, destinations, [later, earlier]);
        await delay(SETTLE_MS);
        const position = await positionOf('stub', events.map((event) => event.eventId));
        for (const event of events) event.receipts = receiptTenants(position, event.eventId);
        const activity: Record<string, ActivityRecord[]> = {};
        for (const { siteId, tenantId } of destinations) activity[siteId] = await activityOf(note.noteId, tenantId);
        evidence.activity = activity;
        for (const { siteId } of destinations) {
          expect(activity[siteId], `activity of note ${note.noteId} in ${siteId}`).toEqual(expectedActivity([later, earlier]));
        }
        const tenantIds = destinations.map((destination) => destination.tenantId.toLowerCase()).sort();
        for (const event of events) {
          expect(event.receipts, `receipt tenants of version ${event.aggregateVersion} (${event.eventId})`).toEqual(tenantIds);
        }
      }),
  );

  it(
    `note delivery dropped while the stub is down is recovered by redelivery ${CHECK_TAG('droppedDeliveryRecovered')}`,
    { timeout: RESTART_TEST_TIMEOUT_MS },
    (ctx) =>
      runCheck('droppedDeliveryRecovered', ctx, async (evidence) => {
        const { note, projection: before } = await freshProjectedNote();
        const next = noteEnvelope({ ...note, title: `${note.title} (redelivered)` }, before.aggregateVersion + 1);
        Object.assign(evidence, { noteId: note.noteId, before, eventId: next.eventId });
        let after: StubProjection | undefined;
        await withRestoredServices(['stub'], async () => {
          await stopService('stub');
          evidence.messageId = await publishTo(STUB_NOTE_TOPIC, next);
          await startService('stub');
          await waitHealthy('stub');
          const isNext = (projection: StubProjection): boolean => projection.lastEventId === next.eventId;
          after = await awaitProjection(note.noteId, isNext, 'the redelivered version', REDELIVERY_POLL);
          evidence.after = after;
        });
        const receipts = receiptTenants(await awaitReceipt('stub', next.eventId, [TENANT_A.tenantId]), next.eventId);
        evidence.receipts = receipts;
        expect(after, 'projection after the redelivery').toEqual({
          applyCount: before.applyCount + 1,
          aggregateVersion: next.aggregateVersion,
          lastEventId: next.eventId,
        });
        expect(receipts, `inbox receipt tenants of ${next.eventId}`).toEqual([TENANT_A.tenantId.toLowerCase()]);
      }),
  );

  it(`dead-lettered message replays once ${CHECK_TAG('dlqReplayOnce')}`, { timeout: DELIVERY_TEST_TIMEOUT_MS }, (ctx) =>
    runCheck('dlqReplayOnce', ctx, async (evidence) => {
      const result = await runDlqCheck({
        target: stubDlqTarget({ tenantId: TENANT_A.tenantId, reader: { session: notes(), siteId: TENANT_A.siteId } }),
        env: processEnv('stub'),
      });
      Object.assign(evidence, result.evidence);
      expect(result.passed, result.evidence.failures.join('; ')).toBe(true);
    }),
  );

  it('full outbox replay leaves inbox counts and effect checksums unchanged', { timeout: REPLAY_TEST_TIMEOUT_MS }, async ({ signal }) => {
    let result: OutboxReplayResult | undefined;
    try {
      result = await runOutboxReplay({ since: FULL_REPLAY_SINCE, invoker: await migrationInvoker() });
      const detail = `differences ${JSON.stringify(result.differences)}; replays ${JSON.stringify(result.replays)}`;
      expect(result.unchanged, detail).toBe(true);
    } finally {
      // A replay that threw has no before and after snapshots, which the outboxReplay record must hold, so it records nothing.
      if (result !== undefined) {
        const passed = result.unchanged && !signal.aborted;
        await recordEventResult('outboxReplay', { result: passed ? 'pass' : 'fail', evidence: result, source: SOURCE });
      }
    }
  });
});
