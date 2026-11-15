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
/** Path of the owners' `migrationPosition` operation in the stub contract. */
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

// Rule "WIP - Minimal Change 2" (no timeouts) does not bind this refactor run; each bound keeps a stalled delivery from
// hanging test-all stage 7.
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

/** Fields of the stub contract's `PositionResponse` this suite reads. */
interface PositionAnswer {
  outbox: { unpublished: number; held: number } | null;
  inbox: { bySubscription: Record<string, number>; receipts?: Record<string, string[]> } | null;
}

/** Unpublished outbox rows, inbox rows of the note subscription and receipt tenants by lower-cased event id. */
interface StubPosition {
  unpublished: number;
  subscription: number;
  receipts: Record<string, string[]>;
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

/** Expected and observed blackout day ids of one person in one registry-derived destination tenant. */
interface BlackoutDestination {
  siteId: string;
  tenantId: string;
  reason: 'person-tenant' | 'userPool';
  expectedDayIds: string[];
  blackoutDayIds: string[];
}

/** An archived person with every destination the consumer's registry derives for it. */
interface ArchiveSubject extends ArchivePerson {
  archive: { status: number; body: string } | null;
  destinations: BlackoutDestination[];
}

interface TenantTimesheets {
  sheets: Row[];
  days: Row[];
}

let fixtures: ReturnType<typeof fixtureStatus> | undefined;
let noteSession: HttpSession | undefined;
let archiveSession: HttpSession | undefined;
let sharedNote: StubNote | undefined;
let noteValidator: TopicValidator<StubNote> | undefined;
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

/** The note `duplicateDelivery` created and saw projected, else a fresh one once projected. */
async function projectedNote(): Promise<StubNote> {
  if (sharedNote !== undefined) return sharedNote;
  const note = await createNote(notes(), { title: `Delivery guarantees note ${tag()}`, body: 'Event delivery guarantee evidence.' });
  await awaitProjection(note.noteId, () => true, 'the first delivery');
  sharedNote = note;
  return note;
}

/** The stub's outbox and inbox position with the receipts of `eventIds`, read as `platform.migration`. */
async function stubPosition(eventIds: readonly string[]): Promise<StubPosition> {
  const base = serviceUrl('stub');
  const url = new URL(POSITION_PATH, base);
  if (eventIds.length > 0) url.searchParams.set('eventIds', eventIds.join(','));
  const headers = await (await migrationInvoker()).headersFor({ callee: 'stub', url: url.href });
  const result = await createHttpSession({ baseUrl: base }).get(url.href, { headers });
  if (result.status !== 200) throw new Error(`stub migration position answered ${result.status}: ${result.text}`);
  const { outbox, inbox } = result.json<PositionAnswer>();
  if (outbox === null || inbox === null) throw new Error(`stub migration position lacks its outbox or inbox: ${result.text}`);
  return {
    unpublished: outbox.unpublished,
    subscription: inbox.bySubscription[STUB_DLQ_SUBSCRIPTION] ?? 0,
    receipts: inbox.receipts ?? {},
  };
}

/** Polls until `eventId` holds a tenant-a inbox receipt at the stub, so its delivery was consumed and acknowledged. */
async function awaitReceipt(eventId: string): Promise<StubPosition> {
  const id = eventId.toLowerCase();
  const tenant = TENANT_A.tenantId.toLowerCase();
  const outcome = await pollUntil(() => stubPosition([id]), (position) => (position.receipts[id] ?? []).includes(tenant), {
    poll: DELIVERY_POLL,
  });
  if (outcome.timedOut) throw new Error(`no tenant-a inbox receipt of event ${id} within ${DELIVERY_POLL.timeoutMs} ms`);
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

/** Ids of `personId`'s days in `data` that are open on or after `effectiveFrom`. */
function openDayIds(data: TenantTimesheets, personId: string, effectiveFrom: string): string[] {
  const owners = sheetOwners(data);
  const person = idKey(personId);
  return data.days
    .filter((day) => owners.get(idKey(text(day, 'timesheet_id'))) === person && isOpenDay(day, effectiveFrom))
    .map((day) => idKey(text(day, 'day_id')));
}

/** Persons of `reserved.rehearsal`, whom only the GS-PE-RH scenarios may touch. */
function reservedPersons(): Set<string> {
  const persons = asRecord(seed().select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' }))?.persons;
  if (!Array.isArray(persons)) throw new Error('reserved.rehearsal.persons in the seed config is not a list');
  return new Set(persons.map((id) => idKey(String(id))));
}

/**
 * `count` tenant-a persons, in sheet key order, with open timesheet days on or after `effectiveFrom`, outside
 * `reserved.rehearsal` and without an archive record, chosen as seams.ts chooses its seam-1 person.
 */
async function freshPersons(
  count: number,
  effectiveFrom: string,
  cache: Map<string, TenantTimesheets>,
): Promise<ArchivePerson[]> {
  const tenantId = TENANT_A.tenantId;
  const excluded = reservedPersons();
  const archives = await readOwnerExport({ service: 'people', unit: unitFor('people', 'person_archive'), tenantId }, await seamDeps());
  for (const row of archives.rows) excluded.add(idKey(text(row, 'person_id')));
  const data = await timesheetsOf(tenantId, cache);
  const owners = sheetOwners(data);
  const open = new Set<string>();
  for (const day of data.days) {
    const owner = owners.get(idKey(text(day, 'timesheet_id')));
    if (owner !== undefined && isOpenDay(day, effectiveFrom)) open.add(owner);
  }
  const chosen: ArchivePerson[] = [];
  const seen = new Set<string>();
  for (const sheet of data.sheets) {
    const userId = text(sheet, 'person_id');
    const key = idKey(userId);
    if (seen.has(key) || excluded.has(key) || !open.has(key)) continue;
    seen.add(key);
    const user = asRecord(seed().select({ as: 'person', source: 'dataset', path: 'masa.users', where: { userID: userId } }));
    const siteId = text(user, 'siteID');
    if (siteId.toLowerCase() !== TENANT_A.siteId) continue;
    chosen.push({ userId, siteId });
    if (chosen.length === count) return chosen;
  }
  throw new Error(
    `only ${chosen.length} of ${count} ${TENANT_A.siteId} persons outside reserved.rehearsal and without an archive ` +
      `have open days on or after ${effectiveFrom}`,
  );
}

/** Sorted day ids of `personId`'s `timesheets.blackout` rows in `tenantId`, one entry per row. */
async function blackoutRowsFor(personId: string, tenantId: string): Promise<string[]> {
  const unit = unitFor('timesheets', 'blackout');
  const { rows } = await readOwnerExport({ service: 'timesheets', unit, tenantId }, await seamDeps());
  const person = idKey(personId);
  return rows
    .filter((row) => idKey(text(row, 'person_id')) === person)
    .map((row) => idKey(text(row, 'day_id')))
    .sort();
}

/**
 * `person` with each destination the consumer's registry derives: its own site's tenant and every tenant whose public or
 * private user pool is that site. Each expects one blackout per open day plus the blackouts it already held.
 */
async function archiveSubject(
  person: ArchivePerson,
  effectiveFrom: string,
  registry: readonly RegistrySite[],
  cache: Map<string, TenantTimesheets>,
): Promise<ArchiveSubject> {
  const site = person.siteId.toLowerCase();
  const own = registry.find((entry) => entry.siteId.toLowerCase() === site);
  if (own === undefined) throw new Error(`the site registry holds no ${person.siteId}`);
  const reasons = new Map<string, { siteId: string; reason: BlackoutDestination['reason'] }>([
    [own.tenantId, { siteId: own.siteId, reason: 'person-tenant' }],
  ]);
  for (const entry of registry) {
    if (!reasons.has(entry.tenantId) && (entry.publicUserPoolId === site || entry.privateUserPoolId === site)) {
      reasons.set(entry.tenantId, { siteId: entry.siteId, reason: 'userPool' });
    }
  }
  const destinations: BlackoutDestination[] = [];
  for (const [tenantId, { siteId, reason }] of reasons) {
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

/** Archives `subject` from `effectiveFrom` through the gateway as tenant-a's site admin and asserts the success answer. */
async function archive(subject: ArchiveSubject, effectiveFrom: string): Promise<void> {
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

/** The archive envelope of each of `subjects` pulled from `subscription`, in subject order; throws naming one still missing. */
async function pullArchives(subscription: TestSubscription, subjects: readonly ArchiveSubject[]): Promise<PulledMessage[]> {
  const wanted = new Set(subjects.map((subject) => idKey(subject.userId)));
  const found = new Map<string, PulledMessage>();
  await pollUntil(
    async () => {
      for (const message of await subscription.pull(10, PULL_WINDOW_MS)) {
        const personId = archivedPersonOf(message);
        if (wanted.has(personId) && !found.has(personId)) found.set(personId, message);
      }
      return found.size;
    },
    (size) => size === wanted.size,
    { poll: PULL_POLL },
  );
  return subjects.map((subject) => {
    const message = found.get(idKey(subject.userId));
    if (message === undefined) {
      throw new Error(`no ${ARCHIVED_TOPIC} envelope of ${subject.userId} on ${subscription.name} within ${PULL_POLL.timeoutMs} ms`);
    }
    return message;
  });
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
      const note = await projectedNote();
      evidence.noteId = note.noteId;
      const before = await awaitProjection(note.noteId, () => true, 'the first delivery');
      evidence.before = before;
      expect(before.applyCount, 'apply count after the first delivery').toBe(1);
      const original = before.lastEventId;
      const inboxBefore = await stubPosition([original]);
      const copy = noteEnvelope(note, before.aggregateVersion, original);
      evidence.copyMessageIds = [await publishTo(STUB_NOTE_TOPIC, copy), await publishTo(STUB_NOTE_TOPIC, copy)];
      // A stale event on the same ordering key is consumed after both copies, so its receipt bounds their delivery.
      const sentinel = noteEnvelope(note, before.aggregateVersion);
      evidence.sentinelEventId = sentinel.eventId;
      await publishTo(STUB_NOTE_TOPIC, sentinel);
      await awaitReceipt(sentinel.eventId);
      await delay(SETTLE_MS);
      const after = await projectionOf(notes(), note.noteId);
      const inboxAfter = await stubPosition([original]);
      const receipts = inboxAfter.receipts[original] ?? [];
      evidence.after = after;
      evidence.inbox = { subscriptionBefore: inboxBefore.subscription, subscriptionAfter: inboxAfter.subscription, receipts };
      expect(after, 'projection after two duplicate deliveries').toEqual(before);
      expect(receipts, `inbox receipt tenants of ${original}`).toEqual([TENANT_A.tenantId.toLowerCase()]);
      expect(inboxAfter.subscription - inboxBefore.subscription, 'inbox rows added besides the sentinel').toBe(1);
    }),
  );

  it(
    `stale state version is acknowledged and ignored while a version gap is applied ${CHECK_TAG('outOfOrderState')}`,
    { timeout: DELIVERY_TEST_TIMEOUT_MS },
    (ctx) =>
      runCheck('outOfOrderState', ctx, async (evidence) => {
        const note = await projectedNote();
        evidence.noteId = note.noteId;
        const before = await awaitProjection(note.noteId, () => true, 'the current version');
        evidence.before = before;
        const pubsub = emulatorDlqPubSub(stackPubSub());
        const dlqTopic = dlqTopicName(STUB_DLQ_SUBSCRIPTION);
        const observer = `opt2-stale-check-${tag()}.${dlqTopic}`;
        await pubsub.createSubscription(dlqTopic, observer);
        try {
          const stale = noteEnvelope({ ...note, title: `${note.title} (stale)` }, before.aggregateVersion);
          evidence.staleEventId = stale.eventId;
          await publishTo(STUB_NOTE_TOPIC, stale);
          await awaitReceipt(stale.eventId);
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
          const note = await createNote(notes(), { title: `Unpublished row ${tag()}`, body: 'Committed while publishing fails.' });
          evidence.noteId = note.noteId;
          const position = await stubPosition([]);
          evidence.unpublishedBeforeKill = position.unpublished;
          expect(position.unpublished, 'unpublished stub outbox rows before the kill').toBeGreaterThanOrEqual(1);
          const early = await projectionOf(notes(), note.noteId);
          evidence.projectedBeforeKill = early !== null;
          expect(early, 'projection before the kill').toBeNull();
          await killService('stub');
          await startService('stub');
          await waitHealthy('stub');
          const restartedAt = Date.now();
          const swept = await awaitProjection(note.noteId, () => true, 'the swept delivery', sweepPoll);
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
    `person archives delivered out of order each apply once per destination ${CHECK_TAG('outOfOrderProcess')}`,
    { timeout: RESTART_TEST_TIMEOUT_MS },
    async (ctx) => {
      await skipWithoutFixtures('outOfOrderProcess', ctx);
      await runCheck('outOfOrderProcess', ctx, async (evidence) => {
        const effectiveFrom = seed().businessDate();
        const subjects = await freshSubjects(2, effectiveFrom);
        Object.assign(evidence, { effectiveFrom, subjects });
        await assertRunnerOnStackEmulator();
        const subscription = await createTestSubscription({ name: ARCHIVED_TOPIC }, { consumer: 'opt2-order-check' });
        try {
          await withRestoredServices(['timesheets'], async () => {
            await stopService('timesheets');
            for (const subject of subjects) await archive(subject, effectiveFrom);
            const pulled = await pullArchives(subscription, subjects);
            evidence.eventIds = pulled.map((message) => message.attributes.eventId ?? null);
            evidence.republishedMessageIds = await withStackPublisher(async (publisher) => {
              const ids: string[] = [];
              for (const { data, attributes, orderingKey } of [...pulled].reverse()) {
                ids.push(await publisher.publishRaw(ARCHIVED_TOPIC, { data, attributes, orderingKey }));
              }
              return ids;
            });
            await startService('timesheets');
            await waitHealthy('timesheets');
            evidence.poll = await awaitBlackouts(subjects);
            // Each copy is ordered behind its original on the person's ordering key, so it arrives within the settle.
            await delay(SETTLE_MS);
            evidence.settled = await awaitBlackouts(subjects);
          });
        } finally {
          await subscription.delete();
        }
        expectOneBlackoutPerOpenDay(subjects);
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
