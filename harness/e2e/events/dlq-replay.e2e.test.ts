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
  topicSchemaRelativePath,
  type EventEnvelope,
  type EventPublisher,
  type RawMessage,
  type TopicValidator,
} from '@opt2/platform/events';
import { cfDateTimeFormat, cfUuid } from '@opt2/platform/legacy-compat';
import { parseSlotName, queueDefinition } from '@opt2/platform/tasks';
import {
  TENANT_A,
  createTestSubscription,
  pubsubEmulatorAvailable,
  testEnvelope,
  type PulledMessage,
  type TestSubscription,
} from '@opt2/platform/testing';
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
  type EventRecordResult,
} from '../../src/events/report.js';
import {
  isOpenDay,
  pollUntil,
  readOwnerExport,
  siteRegistry,
  unitFor,
  type PollBounds,
  type RegistrySite,
  type SeamDeps,
} from '../../src/events/seams.js';
// The archive's CSRF exchange and the seed lookups seams.ts performs privately; reused here rather than re-implemented.
import { jsonApiTokens, loadSeedStore, type SeedStore } from '../../src/golden/session.js';
import { createHttpSession, type HttpSession } from '../../src/lib/http.js';
import { HARNESS_ROOT, repoPath, type EnvLike } from '../../src/lib/paths.js';
import { sessionForSubject } from '../helpers/admin-login.js';
import {
  fixtureStatus,
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
const ARCHIVED_TOPIC = 'people.person.archived.v1';
const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
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
const SKIPPED = 'skipped: fixtures unavailable' satisfies EventRecordResult;
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
/** Receiving the archive envelopes from the throwaway subscription. */
const PULL_POLL: Required<PollBounds> = { timeoutMs: 30_000, intervalMs: 1_000 };
const PULL_WINDOW_MS = 5_000;
/** Quiet period after the delivery evidence before an effect is read again. */
const SETTLE_MS = 5_000;
/** Out-of-order process check: three receipts and two blackout polls at their bound, the envelope pull and the reads around them. */
const PROCESS_ORDER_TEST_TIMEOUT_MS = 5 * DELIVERY_POLL.timeoutMs + PULL_POLL.timeoutMs + 90_000;
/** Aggregate versions of the out-of-order archives: the later archive is delivered first. */
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

/** Payload of `people.person.archived.v1`. */
interface PersonArchived {
  personId: string;
  siteId: string;
  effectiveFrom: string;
  archiveId: string;
  archivedAt: string;
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

/** A person to archive: Masa `UserID` and the site whose user pools hold it. */
interface ArchivePerson {
  userId: string;
  siteId: string;
}

/** A registry-derived destination tenant of a person's archive. */
interface ArchiveTarget {
  siteId: string;
  tenantId: string;
  reason: 'person-tenant' | 'userPool';
}

/** Expected and observed blackout day ids of one person in one registry-derived destination tenant. */
interface BlackoutDestination extends ArchiveTarget {
  expectedDayIds: string[];
  blackoutDayIds: string[];
}

/** A person with the gateway's answer to its archive, null until archived. */
interface ArchivedPerson extends ArchivePerson {
  archive: { status: number; body: string } | null;
}

/** An archived person with every destination the consumer's registry derives for it. */
interface ArchiveSubject extends ArchivedPerson {
  destinations: BlackoutDestination[];
}

/** One `timesheets.blackout` row: its day and the archive that wrote it, case-folded. */
interface BlackoutRecord {
  dayId: string;
  archiveId: string;
}

/** The out-of-order subject in one destination tenant: the days each archive adds, the rows held before and the rows read last. */
interface OrderDestination extends ArchiveTarget {
  /** Days open on or after the later effective date, which the version 2 archive blacks out. */
  lateDayIds: string[];
  /** Days open from the earlier effective date until the later one, which only the version 1 archive blacks out. */
  earlyDayIds: string[];
  held: BlackoutRecord[];
  rows: BlackoutRecord[];
}

/** A person archived twice out of order; `laterFrom` is its latest open work date, the version 2 archive's effective date. */
interface OrderSubject extends ArchivedPerson {
  laterFrom: string;
  destinations: OrderDestination[];
}

/** One out-of-order archive envelope, its delivery and the tenants holding its inbox receipt. */
interface OrderEvent {
  eventId: string;
  aggregateVersion: number;
  archiveId: string;
  effectiveFrom: string;
  messageId: string | null;
  receipts: string[];
  blackouts: { polls: number; elapsedMs: number; timedOut: boolean } | null;
}

interface TenantTimesheets {
  sheets: Row[];
  days: Row[];
}

let fixtures: ReturnType<typeof fixtureStatus> | undefined;
let noteSession: HttpSession | undefined;
let archiveSession: HttpSession | undefined;
let noteValidator: TopicValidator<StubNote> | undefined;
let archivedValidator: TopicValidator<PersonArchived> | undefined;
let seedStore: SeedStore | undefined;

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

function archiver(): HttpSession {
  if (archiveSession === undefined) throw new Error('beforeAll opened no tenant-a site-admin gateway session');
  return archiveSession;
}

function seed(): SeedStore {
  seedStore ??= loadSeedStore();
  return seedStore;
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

/** Throws unless the emulator variables the testing helpers read name the stack's project and emulator, and it answers. */
async function assertRunnerOnStackEmulator(): Promise<void> {
  const stack = stackPubSub();
  const runner = { projectId: process.env.GOOGLE_CLOUD_PROJECT ?? DEFAULT_PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST };
  if (runner.projectId !== stack.projectId || runner.emulatorHost !== stack.emulatorHost) {
    throw new Error(`the runner's Pub/Sub ${JSON.stringify(runner)} is not the stack's ${JSON.stringify(stack)}`);
  }
  if (!(await pubsubEmulatorAvailable())) throw new Error(`the Pub/Sub emulator at ${stack.emulatorHost} does not answer`);
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

/** `candidate` as a `people.person.archived.v1` payload; throws with the schema errors when it is not one. */
function archivedPayload(candidate: unknown): PersonArchived {
  archivedValidator ??= compileTopicSchema<PersonArchived>(readTopicSchema(repoPath(topicSchemaRelativePath(ARCHIVED_TOPIC))));
  const checked = archivedValidator.validatePayload(candidate);
  if (!checked.ok) {
    throw new Error(`not a ${ARCHIVED_TOPIC} payload (${checked.errors.join('; ')}): ${JSON.stringify(candidate)}`);
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

/** Records `key` as skipped and skips the test when the legacy fixtures are unavailable. */
async function skipWithoutFixtures(key: CheckKey, ctx: TestContext): Promise<void> {
  fixtures ??= fixtureStatus();
  if (fixtures.available) return;
  await recordEventResult<string>(key, { result: SKIPPED, evidence: { reason: fixtures.reason }, source: SOURCE });
  ctx.skip(SKIPPED);
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

/** Timesheets and days of `tenantId` from the timesheets export, read once per `cache`. */
async function timesheetsOf(tenantId: string, cache: Map<string, TenantTimesheets>): Promise<TenantTimesheets> {
  const known = cache.get(tenantId);
  if (known !== undefined) return known;
  const deps = await seamDeps();
  const sheets = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'timesheet'), tenantId }, deps);
  const days = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'timesheet_day'), tenantId }, deps);
  const read = { sheets: sheets.rows, days: days.rows };
  cache.set(tenantId, read);
  return read;
}

/** Person id of every sheet in `data`, by sheet id. */
function sheetOwners(data: TenantTimesheets): Map<string, string> {
  return new Map(data.sheets.map((sheet) => [idKey(text(sheet, 'timesheet_id')), idKey(text(sheet, 'person_id'))]));
}

/** `personId`'s days in `data` that are open on or after `effectiveFrom`. */
function openDays(data: TenantTimesheets, personId: string, effectiveFrom: string): Row[] {
  const owners = sheetOwners(data);
  const person = idKey(personId);
  return data.days.filter((day) => owners.get(idKey(text(day, 'timesheet_id'))) === person && isOpenDay(day, effectiveFrom));
}

/** Comparison form of a day's id. */
function dayIdOf(day: Row): string {
  return idKey(text(day, 'day_id'));
}

/** `yyyy-mm-dd` date of a day's canonical `work_date` text. */
function workDateOf(day: Row): string {
  return text(day, 'work_date').slice(0, 10);
}

/** Ids of `personId`'s days in `data` that are open on or after `effectiveFrom`. */
function openDayIds(data: TenantTimesheets, personId: string, effectiveFrom: string): string[] {
  return openDays(data, personId, effectiveFrom).map(dayIdOf);
}

/** Persons of `reserved.rehearsal`, whom only the GS-PE-RH scenarios may touch. */
function reservedPersons(): Set<string> {
  const persons = asRecord(seed().select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' }))?.persons;
  if (!Array.isArray(persons)) throw new Error('reserved.rehearsal.persons in the seed config is not a list');
  return new Set(persons.map((id) => idKey(String(id))));
}

/**
 * `count` tenant-a persons, in sheet key order, with open timesheet days on at least `minOpenDates` work dates on or
 * after `effectiveFrom`, outside `reserved.rehearsal` and without an archive record, chosen as seams.ts chooses its
 * seam-1 person.
 */
async function freshPersons(
  count: number,
  effectiveFrom: string,
  cache: Map<string, TenantTimesheets>,
  minOpenDates = 1,
): Promise<ArchivePerson[]> {
  const tenantId = TENANT_A.tenantId;
  const excluded = reservedPersons();
  const archives = await readOwnerExport({ service: 'people', unit: unitFor('people', 'person_archive'), tenantId }, await seamDeps());
  for (const row of archives.rows) excluded.add(idKey(text(row, 'person_id')));
  const data = await timesheetsOf(tenantId, cache);
  const owners = sheetOwners(data);
  const openDates = new Map<string, Set<string>>();
  for (const day of data.days) {
    const owner = owners.get(idKey(text(day, 'timesheet_id')));
    if (owner === undefined || !isOpenDay(day, effectiveFrom)) continue;
    const dates = openDates.get(owner) ?? new Set<string>();
    dates.add(workDateOf(day));
    openDates.set(owner, dates);
  }
  const chosen: ArchivePerson[] = [];
  const seen = new Set<string>();
  for (const sheet of data.sheets) {
    const userId = text(sheet, 'person_id');
    const key = idKey(userId);
    if (seen.has(key) || excluded.has(key) || (openDates.get(key)?.size ?? 0) < minOpenDates) continue;
    seen.add(key);
    const user = asRecord(seed().select({ as: 'person', source: 'dataset', path: 'masa.users', where: { userID: userId } }));
    const siteId = text(user, 'siteID');
    if (siteId.toLowerCase() !== TENANT_A.siteId) continue;
    chosen.push({ userId, siteId });
    if (chosen.length === count) return chosen;
  }
  throw new Error(
    `only ${chosen.length} of ${count} ${TENANT_A.siteId} persons outside reserved.rehearsal and without an archive ` +
      `have open days on ${minOpenDates} or more work dates on or after ${effectiveFrom}`,
  );
}

/** Blackout records in day id order, the order a default string sort gives the ids. */
function byDayId(a: BlackoutRecord, b: BlackoutRecord): number {
  return a.dayId < b.dayId ? -1 : a.dayId > b.dayId ? 1 : 0;
}

/** `personId`'s `timesheets.blackout` rows in `tenantId`, sorted by day id, one entry per row. */
async function blackoutsOf(personId: string, tenantId: string): Promise<BlackoutRecord[]> {
  const unit = unitFor('timesheets', 'blackout');
  const { rows } = await readOwnerExport({ service: 'timesheets', unit, tenantId }, await seamDeps());
  const person = idKey(personId);
  return rows
    .filter((row) => idKey(text(row, 'person_id')) === person)
    .map((row) => ({ dayId: idKey(text(row, 'day_id')), archiveId: idKey(text(row, 'archive_id')) }))
    .sort(byDayId);
}

/** Sorted day ids of `personId`'s `timesheets.blackout` rows in `tenantId`, one entry per row. */
async function blackoutRowsFor(personId: string, tenantId: string): Promise<string[]> {
  return (await blackoutsOf(personId, tenantId)).map((row) => row.dayId);
}

/**
 * Destinations the consumer's registry derives for `person`: its own site's tenant and every tenant whose public or
 * private user pool is that site.
 */
function archiveTargets(person: ArchivePerson, registry: readonly RegistrySite[]): ArchiveTarget[] {
  const site = person.siteId.toLowerCase();
  const own = registry.find((entry) => entry.siteId.toLowerCase() === site);
  if (own === undefined) throw new Error(`the site registry holds no ${person.siteId}`);
  const targets: ArchiveTarget[] = [{ siteId: own.siteId, tenantId: own.tenantId, reason: 'person-tenant' }];
  for (const entry of registry) {
    const known = targets.some((target) => target.tenantId === entry.tenantId);
    if (!known && (entry.publicUserPoolId === site || entry.privateUserPoolId === site)) {
      targets.push({ siteId: entry.siteId, tenantId: entry.tenantId, reason: 'userPool' });
    }
  }
  return targets;
}

/** `person` with each registry-derived destination, which expects one blackout per open day plus the blackouts it already held. */
async function archiveSubject(
  person: ArchivePerson,
  effectiveFrom: string,
  registry: readonly RegistrySite[],
  cache: Map<string, TenantTimesheets>,
): Promise<ArchiveSubject> {
  const destinations: BlackoutDestination[] = [];
  for (const { siteId, tenantId, reason } of archiveTargets(person, registry)) {
    const open = openDayIds(await timesheetsOf(tenantId, cache), person.userId, effectiveFrom);
    const held = await blackoutRowsFor(person.userId, tenantId);
    const expectedDayIds = [...new Set([...open, ...held])].sort();
    destinations.push({ siteId, tenantId, reason, expectedDayIds, blackoutDayIds: held });
  }
  return { ...person, archive: null, destinations };
}

/** Fresh archive subjects for `count` persons, their expectations read while timesheets is still up. */
async function freshSubjects(count: number, effectiveFrom: string): Promise<ArchiveSubject[]> {
  const cache = new Map<string, TenantTimesheets>();
  const registry = await siteRegistry(await seamDeps());
  const subjects: ArchiveSubject[] = [];
  for (const person of await freshPersons(count, effectiveFrom, cache)) {
    subjects.push(await archiveSubject(person, effectiveFrom, registry, cache));
  }
  return subjects;
}

/**
 * A fresh tenant-a person with open days on two or more work dates from `earlierFrom`, its open days without a blackout
 * split at the latest of their work dates; throws unless both sides of the split hold a day in some destination.
 */
async function orderSubject(earlierFrom: string): Promise<OrderSubject> {
  const cache = new Map<string, TenantTimesheets>();
  const registry = await siteRegistry(await seamDeps());
  const [person] = await freshPersons(1, earlierFrom, cache, 2);
  if (person === undefined) throw new Error(`no ${TENANT_A.siteId} person to archive out of order`);
  const reads: { target: ArchiveTarget; held: BlackoutRecord[]; open: Row[] }[] = [];
  for (const target of archiveTargets(person, registry)) {
    const held = await blackoutsOf(person.userId, target.tenantId);
    const heldDays = new Set(held.map((row) => row.dayId));
    const days = openDays(await timesheetsOf(target.tenantId, cache), person.userId, earlierFrom);
    reads.push({ target, held, open: days.filter((day) => !heldDays.has(dayIdOf(day))) });
  }
  const laterFrom = reads.flatMap(({ open }) => open.map(workDateOf)).sort().at(-1) ?? earlierFrom;
  const destinations = reads.map(({ target, held, open }): OrderDestination => ({
    ...target,
    lateDayIds: open.filter((day) => isOpenDay(day, laterFrom)).map(dayIdOf).sort(),
    earlyDayIds: open.filter((day) => !isOpenDay(day, laterFrom)).map(dayIdOf).sort(),
    held,
    rows: held,
  }));
  const late = destinations.reduce((total, destination) => total + destination.lateDayIds.length, 0);
  const early = destinations.reduce((total, destination) => total + destination.earlyDayIds.length, 0);
  if (late === 0 || early === 0) {
    throw new Error(
      `${person.userId} has ${late} open days without a blackout from ${laterFrom} and ${early} from ${earlierFrom} until ` +
        'then in its destinations; the out-of-order check needs both',
    );
  }
  return { ...person, archive: null, laterFrom, destinations };
}

/** Tenant-a `people.person.archived.v1` envelope of `person` at `version`: a new archive from the local midnight of `from`. */
function archiveEnvelope(person: ArchivePerson, version: number, from: string): EventEnvelope<PersonArchived> {
  return testEnvelope({
    topic: ARCHIVED_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: person.userId,
    aggregateVersion: version,
    payload: archivedPayload({
      personId: person.userId,
      siteId: person.siteId,
      effectiveFrom: `${from} 00:00:00.000`,
      archiveId: cfUuid(),
      archivedAt: cfDateTimeFormat(new Date(), LOCAL_TIMESTAMP_MASK),
    }),
  });
}

/** Archives `subject` from `effectiveFrom` through the gateway as tenant-a's site admin and asserts the success answer. */
async function archive(subject: ArchivedPerson, effectiveFrom: string): Promise<void> {
  const session = archiver();
  const result = await session.post(`${FIXTURE_API}/people/persons/${encodeURIComponent(subject.userId)}/archive`, {
    query: { siteid: subject.siteId },
    headers: await jsonApiTokens(session, subject.siteId, subject.userId),
    json: { effectiveFrom },
  });
  subject.archive = { status: result.status, body: result.text };
  const succeeded = result.status >= 200 && result.status < 300;
  expect(succeeded, `archive of ${subject.userId} answered ${result.status}: ${result.text}`).toBe(true);
}

/** Whether `actual` holds each expected day once (`matched`), still lacks some (`pending`), or holds a duplicate or stray one. */
function blackoutState(expected: readonly string[], actual: readonly string[]): 'matched' | 'pending' | 'broken' {
  const want = new Set(expected);
  if (new Set(actual).size !== actual.length || actual.some((id) => !want.has(id))) return 'broken';
  return actual.length === want.size ? 'matched' : 'pending';
}

/** Polls every destination of `subjects` until none is pending, storing the observed rows; returns the poll statistics. */
async function awaitBlackouts(
  subjects: readonly ArchiveSubject[],
): Promise<{ polls: number; elapsedMs: number; timedOut: boolean }> {
  const destinations = subjects.flatMap((subject) => subject.destinations.map((destination) => ({ subject, destination })));
  const outcome = await pollUntil(
    () => Promise.all(destinations.map(({ subject, destination }) => blackoutRowsFor(subject.userId, destination.tenantId))),
    (observed) =>
      destinations.every(({ destination }, i) => blackoutState(destination.expectedDayIds, observed[i] ?? []) !== 'pending'),
    { poll: REDELIVERY_POLL },
  );
  destinations.forEach(({ destination }, i) => {
    destination.blackoutDayIds = outcome.value[i] ?? [];
  });
  return { polls: outcome.polls, elapsedMs: outcome.elapsedMs, timedOut: outcome.timedOut };
}

/** Asserts each destination holds exactly one blackout per expected day, and that each person expected some. */
function expectOneBlackoutPerOpenDay(subjects: readonly ArchiveSubject[]): void {
  for (const subject of subjects) {
    const expected = subject.destinations.reduce((total, destination) => total + destination.expectedDayIds.length, 0);
    expect(expected, `expected blackouts of ${subject.userId}`).toBeGreaterThan(0);
    for (const destination of subject.destinations) {
      expect(destination.blackoutDayIds, `blackouts of ${subject.userId} in ${destination.siteId}`).toEqual(
        destination.expectedDayIds,
      );
    }
  }
}

/** Person id of an archive envelope's payload, case-folded. */
function archivedPersonOf(message: PulledMessage): string {
  const payload = asRecord(asRecord(decodeEnvelopeData(message.data))?.payload);
  return idKey(text(payload, 'personId'));
}

/** Event id of the first archive envelope of `personId` pulled from `subscription`; throws when none arrives within the pull poll. */
async function pullArchiveEventId(subscription: TestSubscription, personId: string): Promise<string> {
  const person = idKey(personId);
  const outcome = await pollUntil(
    async () => (await subscription.pull(10, PULL_WINDOW_MS)).find((message) => archivedPersonOf(message) === person),
    (message) => message !== undefined,
    { poll: PULL_POLL },
  );
  if (outcome.value === undefined) {
    throw new Error(`no ${ARCHIVED_TOPIC} envelope of ${personId} on ${subscription.name} within ${PULL_POLL.timeoutMs} ms`);
  }
  return text(asRecord(decodeEnvelopeData(outcome.value.data)), 'eventId');
}

/** Rows `destination` holds once both archives applied: the held rows, late days under `laterId`, early days under `earlierId`. */
function expectedOrderRows(destination: OrderDestination, laterId: string, earlierId: string): BlackoutRecord[] {
  return [
    ...destination.held,
    ...destination.lateDayIds.map((dayId) => ({ dayId, archiveId: idKey(laterId) })),
    ...destination.earlyDayIds.map((dayId) => ({ dayId, archiveId: idKey(earlierId) })),
  ].sort(byDayId);
}

/** Polls each destination of `subject` until it holds its held rows plus the `added` days, storing the rows; returns poll statistics. */
async function awaitOrderBlackouts(
  subject: OrderSubject,
  added: (destination: OrderDestination) => readonly string[],
): Promise<{ polls: number; elapsedMs: number; timedOut: boolean }> {
  const { destinations } = subject;
  const expected = destinations.map((destination) => [...destination.held.map((row) => row.dayId), ...added(destination)]);
  const outcome = await pollUntil(
    () => Promise.all(destinations.map((destination) => blackoutsOf(subject.userId, destination.tenantId))),
    (observed) =>
      destinations.every((_, i) => blackoutState(expected[i] ?? [], (observed[i] ?? []).map((row) => row.dayId)) !== 'pending'),
    { poll: DELIVERY_POLL },
  );
  destinations.forEach((destination, i) => {
    destination.rows = outcome.value[i] ?? [];
  });
  return { polls: outcome.polls, elapsedMs: outcome.elapsedMs, timedOut: outcome.timedOut };
}

/** The delivery record of `envelope`, before it is published. */
function orderEvent(envelope: EventEnvelope<PersonArchived>): OrderEvent {
  const { eventId, aggregateVersion, payload } = envelope;
  return {
    eventId,
    aggregateVersion,
    archiveId: payload.archiveId,
    effectiveFrom: payload.effectiveFrom,
    messageId: null,
    receipts: [],
    blackouts: null,
  };
}

/** Publishes `envelope`, then waits for its inbox receipt in each destination of `subject` and for `added` days' blackouts there. */
async function deliverArchive(
  subject: OrderSubject,
  envelope: EventEnvelope<PersonArchived>,
  event: OrderEvent,
  added: (destination: OrderDestination) => readonly string[],
): Promise<void> {
  event.messageId = await publishTo(ARCHIVED_TOPIC, envelope);
  const tenantIds = subject.destinations.map((destination) => destination.tenantId);
  event.receipts = receiptTenants(await awaitReceipt('timesheets', envelope.eventId, tenantIds), envelope.eventId);
  event.blackouts = await awaitOrderBlackouts(subject, added);
}

/**
 * Archives `subject` from `effectiveFrom` through the gateway and waits for that event's inbox receipt in each destination,
 * so the person searches, which skip persons with an archive record, pass it over afterwards.
 */
async function retire(subject: OrderSubject, effectiveFrom: string): Promise<{ eventId: string; archive: ArchivedPerson['archive'] }> {
  const subscription = await createTestSubscription({ name: ARCHIVED_TOPIC }, { consumer: 'opt2-order-check' });
  try {
    await archive(subject, effectiveFrom);
    const eventId = await pullArchiveEventId(subscription, subject.userId);
    await awaitReceipt('timesheets', eventId, subject.destinations.map((destination) => destination.tenantId));
    return { eventId, archive: subject.archive };
  } finally {
    await subscription.delete();
  }
}

describe('event delivery guarantees', () => {
  beforeAll(async () => {
    // A record left by an earlier run would otherwise stand for a check this run did not reach.
    await Promise.all(OWN_KEYS.map((key) => rm(e2eResultPath(key), { force: true })));
    await requireTableVersion(TABLE_VERSION);
    fixtures = fixtureStatus();
    noteSession = (await sessionForSubject('system-user', { origin: 'gateway', site: TENANT_A.siteId })).session;
    if (fixtures.available) archiveSession = (await sessionForSubject('site-admin', { origin: 'gateway' })).session;
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
    `archive versions 2 then 1 of one person each black out their own days once per destination ${CHECK_TAG('outOfOrderProcess')}`,
    { timeout: PROCESS_ORDER_TEST_TIMEOUT_MS },
    async (ctx) => {
      await skipWithoutFixtures('outOfOrderProcess', ctx);
      await runCheck('outOfOrderProcess', ctx, async (evidence) => {
        // The retirement pulls its archive envelope through the runner's emulator client.
        await assertRunnerOnStackEmulator();
        const effectiveFrom = seed().businessDate();
        const subject = await orderSubject(effectiveFrom);
        const later = archiveEnvelope(subject, LATE_VERSION, subject.laterFrom);
        const earlier = archiveEnvelope(subject, EARLY_VERSION, effectiveFrom);
        const laterEvent = orderEvent(later);
        const earlierEvent = orderEvent(earlier);
        const events = [laterEvent, earlierEvent];
        Object.assign(evidence, { effectiveFrom, subject, events });
        let failure: unknown;
        try {
          // Version 1 is published only once version 2 holds a receipt in every destination, so it is consumed second.
          await deliverArchive(subject, later, laterEvent, (destination) => destination.lateDayIds);
          await deliverArchive(subject, earlier, earlierEvent, (destination) => [...destination.lateDayIds, ...destination.earlyDayIds]);
          await delay(SETTLE_MS);
          const position = await positionOf('timesheets', events.map((event) => event.eventId));
          for (const event of events) event.receipts = receiptTenants(position, event.eventId);
          for (const destination of subject.destinations) destination.rows = await blackoutsOf(subject.userId, destination.tenantId);
          for (const destination of subject.destinations) {
            expect(destination.rows, `blackouts of ${subject.userId} in ${destination.siteId}`).toEqual(
              expectedOrderRows(destination, later.payload.archiveId, earlier.payload.archiveId),
            );
          }
          const tenantIds = subject.destinations.map((destination) => destination.tenantId.toLowerCase()).sort();
          for (const event of events) {
            expect(event.receipts, `receipt tenants of version ${event.aggregateVersion} (${event.eventId})`).toEqual(tenantIds);
          }
        } catch (err) {
          failure = err;
          throw err;
        } finally {
          try {
            evidence.retirement = await retire(subject, effectiveFrom);
          } catch (err) {
            // A failed check keeps its own error; the retirement's joins the evidence.
            if (failure === undefined) throw err;
            evidence.retirementError = messageOf(err);
          }
        }
      });
    },
  );

  it(
    `archive delivery dropped while timesheets is down is recovered by redelivery ${CHECK_TAG('droppedDeliveryRecovered')}`,
    { timeout: RESTART_TEST_TIMEOUT_MS },
    async (ctx) => {
      await skipWithoutFixtures('droppedDeliveryRecovered', ctx);
      await runCheck('droppedDeliveryRecovered', ctx, async (evidence) => {
        const effectiveFrom = seed().businessDate();
        const subjects = await freshSubjects(1, effectiveFrom);
        Object.assign(evidence, { effectiveFrom, subjects });
        await withRestoredServices(['timesheets'], async () => {
          await stopService('timesheets');
          for (const subject of subjects) await archive(subject, effectiveFrom);
          await startService('timesheets');
          await waitHealthy('timesheets');
          evidence.poll = await awaitBlackouts(subjects);
        });
        expectOneBlackoutPerOpenDay(subjects);
      });
    },
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
