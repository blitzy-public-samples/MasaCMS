// DLQ check against an in-memory Pub/Sub bus, stub consumer, gateway projection route, replay bin and clock: no emulator, socket or child process.
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_REASONS,
  DEAD_LETTER_REASON_ATTRIBUTE,
  decodeEnvelopeData,
  dlqReplaySubscriptionName,
  dlqTopicName,
  encodeEnvelope,
  eventTypeOf,
  originalAttributes,
  subscriptionName,
  topicOfSubscription,
  validateEnvelope,
  type EventEnvelope,
  type RawMessage,
} from '@opt2/platform/events';
import { buildEnvelope, legacyErrorResponse, serializeResponse } from '@opt2/platform/legacy-compat';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, pubsubEmulatorAvailable, testEnvelope, withoutTenant } from '@opt2/platform/testing';

import {
  EFFECT_SETTLE_MS,
  EXPECTED_DLQ_REASON,
  OPT2_EVENTS_BIN,
  PRECONDITION_PULL_MS,
  REPLAY_EXEC_TIMEOUT_MS,
  REPLAY_IDLE_SECONDS,
  STUB_DLQ_SUBSCRIPTION,
  STUB_NOTES_PATH,
  STUB_NOTE_TOPIC,
  defaultReplayExec,
  emulatorDlqPubSub,
  parseReplaySummary,
  readStubProjection,
  replayArgs,
  runDlqCheck,
  stubDlqTarget,
  type DlqDeps,
  type DlqPubSub,
  type DlqPullOptions,
  type DlqPulledMessage,
  type DlqResult,
  type ReplayExec,
  type StubReader,
} from '../../src/events/dlq.js';
import type { SeamDeps } from '../../src/events/seams.js';
import { adminLogin, loadSecretStore, type LoginResult, type SecretStore } from '../../src/golden/session.js';
import { createHttpSession, type HttpResult } from '../../src/lib/http.js';
import { HARNESS_ROOT, type EnvLike } from '../../src/lib/paths.js';

/** A streaming-pull receiver of the Pub/Sub client double. */
interface ReceiverRecord {
  name: string;
  options: unknown;
  closed: boolean;
}

/** One `@opt2/platform/events` `PubSub` client the double constructed. */
interface ClientRecord {
  options: unknown;
  closed: boolean;
}

// Client double backed by the test's FakeBus; hoisted because the mock factory runs while dlq.ts is imported.
const pubsubDouble = vi.hoisted(() => {
  type Listener = (value: unknown) => void;
  const state = {
    bus: undefined as FakeBus | undefined,
    clients: [] as ClientRecord[],
    receivers: [] as ReceiverRecord[],
    receiveError: undefined as Error | undefined,
  };
  const currentBus = (): FakeBus => {
    if (state.bus === undefined) throw new Error('no FakeBus bound to the Pub/Sub client double');
    return state.bus;
  };

  class Receiver {
    private readonly listeners = new Map<string, Listener[]>();

    constructor(private readonly record: ReceiverRecord) {}

    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      if (event === 'message') queueMicrotask(() => this.deliver());
      return this;
    }

    removeAllListeners(event: string): this {
      this.listeners.delete(event);
      return this;
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }

    async delete(): Promise<void> {
      currentBus().deleteSubscription(this.record.name);
    }

    private emit(event: string, value: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(value);
    }

    private deliver(): void {
      const error = state.receiveError;
      if (error !== undefined) {
        state.receiveError = undefined;
        this.emit('error', error);
        return;
      }
      const bus = currentBus();
      for (const queued of bus.queued(this.record.name)) {
        if ((this.listeners.get('message') ?? []).length === 0) return;
        this.emit('message', {
          id: queued.id,
          data: queued.data,
          attributes: { ...queued.attributes },
          orderingKey: queued.orderingKey ?? '',
          ack: () => bus.ack(this.record.name, queued.id),
          nack: () => undefined,
        });
      }
    }
  }

  class PubSub {
    private readonly record: ClientRecord;

    constructor(options: unknown) {
      this.record = { options, closed: false };
      state.clients.push(this.record);
    }

    topic(name: string) {
      return {
        publishMessage: async (message: RawMessage) => currentBus().publish(name, message),
        flush: async () => undefined,
        resumePublishing: () => undefined,
        createSubscription: async (subscription: string) => {
          currentBus().createSubscription(name, subscription);
          return [];
        },
      };
    }

    subscription(name: string, options?: unknown): Receiver {
      const record: ReceiverRecord = { name, options, closed: false };
      state.receivers.push(record);
      return new Receiver(record);
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }
  }

  return { state, PubSub };
});

vi.mock(import('@opt2/platform/events'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PubSub: pubsubDouble.PubSub as unknown as typeof actual.PubSub };
});

// Spawning is refused unless a test scripts execFile; the emulator probe answers false unless a test says otherwise.
vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal();
  const refuse = (): never => {
    throw new Error('dlq.test spawns no process');
  };
  return { ...actual, execFile: vi.fn(refuse) as unknown as typeof actual.execFile };
});

vi.mock(import('@opt2/platform/testing'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pubsubEmulatorAvailable: vi.fn(async () => false) };
});

// The default reader's legacy login and secret store are scripted per test; everything else stays real.
vi.mock(import('../../src/golden/session.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, adminLogin: vi.fn(), loadSecretStore: vi.fn() };
});

const TOPIC = STUB_NOTE_TOPIC;
const SUBSCRIPTION = STUB_DLQ_SUBSCRIPTION;
const DLQ_TOPIC = dlqTopicName(SUBSCRIPTION);
const REPLAY_SUBSCRIPTION = dlqReplaySubscriptionName(SUBSCRIPTION);
const OBSERVER = /^opt2-dlq-check-[0-9a-f]{8}\.stub\.stub\.note\.created\.v1\.dlq$/;

const PROJECT = 'opt2-dlq-unit';
// No listener on this port; every gateway request goes to the fake fetch.
const GATEWAY_URL = 'http://127.0.0.1:8500';
const PROJECTION_PATH = /^\/opt2\/stub\/notes\/([^/]+)\/projection$/;
const PROJECTED_AT = '2026-06-30 08:00:01.000';
const EVENT_ID = '09de93ab-5c1f-4b7e-9a2d-e516ce81f350';

const CLOCK_START = Date.parse('2026-06-30T08:00:00');
const POLL = { timeoutMs: 3_000, intervalMs: 1_000 };
const LAND_TIMEOUT_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRETS: SecretStore = {
  username: (site, role) => `FIXTURE-${site}-${role}`,
  secret: (name) => `FIXTURE-password-${name}`,
  values: () => [],
};

type Row = Record<string, unknown>;

/** How the fake stub consumer treats a delivery. */
interface ConsumerOptions {
  /** Applies a tenant-less delivery under TENANT_A instead of dead-lettering it. */
  acceptTenantless?: boolean;
  /** Overrides the `reason` attribute; null omits it. */
  reason?: string | null;
  /** Default true: one effect per `(tenantId, eventId)`. */
  dedupe?: boolean;
  /** Dead-letters a foreign non-JSON message just before the first tenant-less delivery's letter. */
  foreignLetter?: boolean;
}

/** Topics, subscriptions and the stub's self-consumer of `stub.note.created.v1`, recording every publish. */
class FakeBus {
  readonly published: { topic: string; message: DlqPulledMessage }[] = [];
  readonly deadLettered: DlqPulledMessage[] = [];
  readonly deleted: string[] = [];
  private readonly queues = new Map<string, { topic: string; messages: DlqPulledMessage[] }>();
  private readonly effects = new Map<string, { tenantId: string; row: Row }>();
  private readonly receipts = new Set<string>();
  private sequence = 0;
  private foreignPending: boolean;

  constructor(private readonly consumer: ConsumerOptions = {}) {
    this.foreignPending = consumer.foreignLetter === true;
    this.createSubscription(DLQ_TOPIC, REPLAY_SUBSCRIPTION);
  }

  publish(topic: string, message: RawMessage): string {
    this.sequence += 1;
    const delivered: DlqPulledMessage = {
      id: String(this.sequence),
      data: Buffer.from(message.data),
      attributes: { ...message.attributes },
      ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
    };
    this.published.push({ topic, message: delivered });
    for (const queue of this.queues.values()) {
      if (queue.topic === topic) queue.messages.push({ ...delivered, attributes: { ...delivered.attributes } });
    }
    if (topic === TOPIC) this.consume(delivered);
    return delivered.id;
  }

  createSubscription(topic: string, name: string): void {
    if (this.queues.has(name)) throw new Error(`subscription ${name} already exists`);
    this.queues.set(name, { topic, messages: [] });
  }

  deleteSubscription(name: string): void {
    if (!this.queues.delete(name)) throw new Error(`subscription ${name} not found`);
    this.deleted.push(name);
  }

  hasSubscription(name: string): boolean {
    return this.queues.has(name);
  }

  queued(name: string): DlqPulledMessage[] {
    const queue = this.queues.get(name);
    if (queue === undefined) throw new Error(`subscription ${name} not found`);
    return [...queue.messages];
  }

  ack(name: string, id: string): void {
    const queue = this.queues.get(name);
    if (queue !== undefined) queue.messages = queue.messages.filter((message) => message.id !== id);
  }

  publishedTo(topic: string): DlqPulledMessage[] {
    return this.published.filter((entry) => entry.topic === topic).map((entry) => entry.message);
  }

  effectRows(tenantId: string): Row[] {
    return [...this.effects.values()].filter((effect) => effect.tenantId === tenantId).map((effect) => effect.row);
  }

  seedEffect(tenantId: string, row: Row): void {
    this.effects.set(`${tenantId}|${String(row.note_id)}`, { tenantId, row });
  }

  private deadLetter(message: DlqPulledMessage, reason: string): void {
    const attributes = { ...message.attributes };
    const forced = this.consumer.reason;
    if (forced !== null) attributes[DEAD_LETTER_REASON_ATTRIBUTE] = forced ?? reason;
    this.deadLettered.push(message);
    this.publish(DLQ_TOPIC, { data: message.data, attributes, orderingKey: message.orderingKey });
  }

  private consume(message: DlqPulledMessage): void {
    let envelope: Partial<EventEnvelope<{ title?: string }>>;
    try {
      envelope = decodeEnvelopeData(message.data) as Partial<EventEnvelope<{ title?: string }>>;
    } catch {
      this.publish(DLQ_TOPIC, { data: message.data, attributes: { ...message.attributes, [DEAD_LETTER_REASON_ATTRIBUTE]: 'schema-invalid' } });
      return;
    }
    const { tenantId } = envelope;
    const valid = typeof tenantId === 'string' && UUID.test(tenantId);
    if (!valid && this.consumer.acceptTenantless !== true) {
      if (this.foreignPending) {
        this.foreignPending = false;
        const attributes = { [DEAD_LETTER_REASON_ATTRIBUTE]: 'schema-invalid' };
        this.publish(DLQ_TOPIC, { data: Buffer.from('not an envelope', 'utf8'), attributes });
      }
      this.deadLetter(message, tenantId === undefined ? 'missing-tenant' : 'invalid-tenant');
      return;
    }
    const tenant = valid ? tenantId : TENANT_A.tenantId;
    const receipt = `${tenant}|${String(envelope.eventId)}`;
    if (this.consumer.dedupe !== false && this.receipts.has(receipt)) return;
    this.receipts.add(receipt);
    const noteId = String(envelope.aggregateId);
    const key = `${tenant}|${noteId}`;
    const applied = Number(this.effects.get(key)?.row.apply_count ?? 0);
    this.effects.set(key, {
      tenantId: tenant,
      row: {
        note_id: noteId,
        title: envelope.payload?.title ?? '',
        aggregate_version: envelope.aggregateVersion ?? 1,
        apply_count: applied + 1,
        last_event_id: String(envelope.eventId),
      },
    });
  }
}

/** One `pull` the check made. */
interface PullRecord {
  subscription: string;
  timeoutMs: number;
}

/** {@link DlqPubSub} over a FakeBus; a pull settles every waiting message at once instead of waiting out its window. */
function fakePubSub(bus: FakeBus, failures: { deleteSubscription?: Error } = {}): DlqPubSub & { pulls: PullRecord[]; closed: boolean } {
  const pubsub = {
    pulls: [] as PullRecord[],
    closed: false,
    publish: async (topic: string, message: RawMessage) => bus.publish(topic, message),
    async pull(subscription: string, options: DlqPullOptions): Promise<DlqPulledMessage[]> {
      pubsub.pulls.push({ subscription, timeoutMs: options.timeoutMs });
      const received: DlqPulledMessage[] = [];
      for (const message of bus.queued(subscription)) {
        received.push(message);
        if (options.decide(message) === 'ack') bus.ack(subscription, message.id);
        if (options.done?.(received) === true) break;
      }
      return received;
    },
    createSubscription: async (topic: string, subscription: string) => bus.createSubscription(topic, subscription),
    async deleteSubscription(subscription: string): Promise<void> {
      if (failures.deleteSubscription !== undefined) throw failures.deleteSubscription;
      bus.deleteSubscription(subscription);
    },
    async close(): Promise<void> {
      pubsub.closed = true;
    },
  };
  return pubsub;
}

type FetchLike = NonNullable<SeamDeps['fetch']>;

/** A serialized legacy response as the gateway relays it. */
function legacyResponse({ status, headers, body }: { status: number; headers: Record<string, string>; body: string }): Response {
  return new Response(body, { status, headers });
}

/**
 * The gateway's `GET /opt2/stub/notes/{noteId}/projection` over the bus's effect rows, whose counts are numbers. The
 * user token is minted for `siteid` (`default` when absent), so the row is read in that site's tenant. Answers the
 * stub's envelope, which quotes the counts as digits, or the legacy 404 envelope; any other request answers 500.
 */
function fakeGateway(bus: FakeBus): { fetch: FetchLike; requests: URL[] } {
  const requests: URL[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    requests.push(url);
    const noteId = PROJECTION_PATH.exec(url.pathname)?.[1];
    if ((init.method ?? 'GET') !== 'GET' || url.origin !== GATEWAY_URL || noteId === undefined) {
      return new Response(`unexpected ${init.method ?? 'GET'} ${url.href}`, { status: 500 });
    }
    const siteid = url.searchParams.get('siteid') ?? 'default';
    const params = { siteid, noteId: decodeURIComponent(noteId) };
    const row = bus.effectRows(tenantIdForSite(siteid)).find((effect) => effect.note_id === params.noteId);
    if (row === undefined) {
      return legacyResponse(legacyErrorResponse('invalidMethodCall', { method: 'findProjection', params, mura404: true }));
    }
    const data = {
      noteId: row.note_id,
      title: row.title,
      body: '',
      created: PROJECTED_AT,
      aggregateVersion: row.aggregate_version,
      applyCount: row.apply_count,
      lastEventId: row.last_event_id,
      projectedAt: PROJECTED_AT,
    };
    return legacyResponse(serializeResponse(buildEnvelope({ method: 'findProjection', params, data })));
  };
  return { fetch, requests };
}

/** A reader of `siteId` whose gateway session sends every request to `fetch`. */
function readerOn(fetch: FetchLike, siteId: string = TENANT_A.siteId): StubReader {
  return { session: createHttpSession({ baseUrl: GATEWAY_URL, fetch }), siteId };
}

/** `siteid` of each projection read, by note id. */
function projectionReads(requests: readonly URL[]): [string | undefined, string | null][] {
  return requests.map((url) => [PROJECTION_PATH.exec(url.pathname)?.[1], url.searchParams.get('siteid')]);
}

/** How the fake `opt2-events` bin behaves. */
interface RunnerOptions {
  /** Publishes of each replayed message; above 1 models a duplicate delivery. */
  publishesPerMessage?: number;
  /** Leaves replayed messages on the replay subscription. */
  keepMessages?: boolean;
  exitCode?: number;
  /** Replaces the JSON summary line. */
  stdout?: string;
}

/** One run of the fake bin. */
interface RunnerCall {
  file: string;
  args: string[];
  env: EnvLike;
  replayed: number;
}

/** `opt2-events replay` over the bus: republishes each `<s>.dlq.replay` message to its topic with its original attributes. */
function fakeReplayRunner(bus: FakeBus, options: RunnerOptions = {}): { exec: ReplayExec; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const exec: ReplayExec = async (file, args, env) => {
    const call: RunnerCall = { file, args: [...args], env: { ...env }, replayed: 0 };
    calls.push(call);
    if (options.exitCode !== undefined) return { exitCode: options.exitCode, stdout: '', stderr: 'opt2-events: pull failed\n' };
    const subscription = args[args.indexOf('--subscription') + 1] ?? '';
    const source = dlqReplaySubscriptionName(subscription);
    const topic = topicOfSubscription(subscription);
    for (const message of bus.queued(source)) {
      for (let n = 0; n < (options.publishesPerMessage ?? 1); n += 1) {
        bus.publish(topic, { data: message.data, attributes: originalAttributes(message.attributes), orderingKey: message.orderingKey });
      }
      if (options.keepMessages !== true) bus.ack(source, message.id);
      call.replayed += 1;
    }
    const summary = { subscription, source, topic, replayed: call.replayed, stoppedBy: 'idle' };
    return { exitCode: 0, stdout: options.stdout ?? `${JSON.stringify(summary)}\n`, stderr: '' };
  };
  return { exec, calls };
}

/** A clock that only `sleep` advances, recording each sleep. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let now = CLOCK_START;
  const sleeps: number[] = [];
  return {
    now: () => now,
    async sleep(ms: number) {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-dlq-'));
});

afterEach(async () => {
  pubsubDouble.state.bus = undefined;
  pubsubDouble.state.clients.length = 0;
  pubsubDouble.state.receivers.length = 0;
  pubsubDouble.state.receiveError = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
  await rm(stateRoot, { recursive: true, force: true });
});

interface DlqStack {
  bus: FakeBus;
  pubsub: ReturnType<typeof fakePubSub>;
  runner: ReturnType<typeof fakeReplayRunner>;
  clock: ReturnType<typeof fakeClock>;
  requests: URL[];
  deps: DlqDeps;
}

/**
 * The bus, its adapters and the check's deps, whose stub target reads through a tenant-a reader on the fake gateway.
 * The env names that gateway for a default reader, and an empty emulator host so nothing probes a live one.
 */
function dlqStack(
  options: { consumer?: ConsumerOptions; runner?: RunnerOptions; deleteSubscription?: Error } = {},
): DlqStack {
  const bus = new FakeBus(options.consumer);
  const pubsub = fakePubSub(bus, { deleteSubscription: options.deleteSubscription });
  const runner = fakeReplayRunner(bus, options.runner);
  const clock = fakeClock();
  const { fetch, requests } = fakeGateway(bus);
  const deps: DlqDeps = {
    target: stubDlqTarget({ now: clock.now, reader: readerOn(fetch) }),
    pubsub,
    exec: runner.exec,
    fetch,
    env: { OPT2_STATE_DIR: stateRoot, OPT2_GATEWAY_URL: GATEWAY_URL, GOOGLE_CLOUD_PROJECT: PROJECT, PUBSUB_EMULATOR_HOST: '' },
    now: clock.now,
    sleep: clock.sleep,
    poll: POLL,
    landTimeoutMs: LAND_TIMEOUT_MS,
  };
  return { bus, pubsub, runner, clock, requests, deps };
}

/** Scripts the default reader's admin login to answer `ok` with `status`. */
function answerLogin(ok: boolean, status: number): void {
  vi.mocked(adminLogin).mockResolvedValue({ ok, result: { status } as HttpResult } satisfies LoginResult);
}

function decoded(message: { data: Buffer }): Partial<EventEnvelope> {
  return decodeEnvelopeData(message.data) as Partial<EventEnvelope>;
}

function failuresOf(result: DlqResult): string[] {
  return result.evidence.failures;
}


/** Scripts the next execFile call to answer `error`, `stdout` and `stderr`. */
function answerExec(error: (Error & { code?: number | string }) | null, stdout: string, stderr: string): void {
  type Callback = (err: typeof error, out: string, errOut: string) => void;
  const answer = (_file: string, _args: readonly string[], _options: unknown, callback: Callback): ChildProcess => {
    callback(error, stdout, stderr);
    return {} as ChildProcess;
  };
  vi.mocked(execFile).mockImplementationOnce(answer as unknown as typeof execFile);
}

describe('stubDlqTarget', () => {
  it('targets the stub self-subscription of stub.note.created.v1 and its note projection', () => {
    const target = stubDlqTarget();
    expect(target.subscription).toBe('stub.stub.note.created.v1');
    expect(target.subscription).toBe(subscriptionName('stub', 'stub.note.created.v1'));
    expect(target.topic).toBe('stub.note.created.v1');
    expect(topicOfSubscription(target.subscription)).toBe(target.topic);
    expect(target.tenantId).toBe(TENANT_A.tenantId);
    expect(target.effectUnit).toBe('stub.note_projection');
  });

  it('builds a fresh contract-valid envelope for the topic in the chosen tenant', () => {
    const target = stubDlqTarget({ tenantId: TENANT_B.tenantId, now: () => CLOCK_START });
    const first = target.buildEnvelope();
    const second = target.buildEnvelope();
    expect(validateEnvelope(first).ok).toBe(true);
    expect(first.eventType).toBe(eventTypeOf(target.topic));
    expect(first.tenantId).toBe(TENANT_B.tenantId);
    expect(first.payload).toMatchObject({ noteId: first.aggregateId, created: '2026-06-30 08:00:00.000', rowVersion: 1 });
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.aggregateId).not.toBe(first.aggregateId);
  });

  it.each([
    { label: 'its apply count', applyCount: 3, expected: 3 },
    { label: 'no application while the gateway answers 404', applyCount: null, expected: 0 },
  ])('counts its tenant note projection through the reader as $label', async ({ applyCount, expected }) => {
    const { bus, deps, requests } = dlqStack();
    const target = deps.target!;
    const noteId = target.buildEnvelope().aggregateId;
    const row = (note: string, count: number): Row => ({
      note_id: note,
      title: 'note',
      aggregate_version: 1,
      apply_count: count,
      last_event_id: EVENT_ID,
    });
    if (applyCount !== null) bus.seedEffect(TENANT_A.tenantId, row(noteId, applyCount));
    bus.seedEffect(TENANT_A.tenantId, row('OTHER-NOTE', 7));
    bus.seedEffect(TENANT_B.tenantId, row(noteId, 5));

    await expect(target.effectCount(noteId, deps)).resolves.toBe(expected);
    expect(projectionReads(requests)).toEqual([[noteId, TENANT_A.siteId]]);
    expect(vi.mocked(adminLogin)).not.toHaveBeenCalled();
  });

  it('refuses a reader of another tenant', () => {
    const reader = readerOn(fakeGateway(new FakeBus()).fetch, TENANT_B.siteId);
    expect(() => stubDlqTarget({ tenantId: TENANT_A.tenantId, reader })).toThrow(
      new RangeError(`reader site ${TENANT_B.siteId} is not of tenant ${TENANT_A.tenantId}`),
    );
    expect(stubDlqTarget({ tenantId: TENANT_B.tenantId.toUpperCase(), reader }).tenantId).toBe(TENANT_B.tenantId.toUpperCase());
  });

  it.each([
    { label: 'the injected secret store', injected: true },
    { label: 'the secret store of its env', injected: false },
  ])('logs in once per target as the seeded system user of its fixture site from $label', async ({ injected }) => {
    const { bus, deps, requests } = dlqStack();
    answerLogin(true, 200);
    vi.mocked(loadSecretStore).mockReturnValue(SECRETS);
    const readDeps: SeamDeps = { ...deps, secrets: injected ? SECRETS : undefined };
    const target = stubDlqTarget({ tenantId: TENANT_B.tenantId });
    const noteId = target.buildEnvelope().aggregateId;
    bus.seedEffect(TENANT_B.tenantId, { note_id: noteId, title: 'note', aggregate_version: 1, apply_count: 2, last_event_id: EVENT_ID });

    await expect(target.effectCount(noteId, readDeps)).resolves.toBe(2);
    await expect(target.effectCount('ABSENT-NOTE', readDeps)).resolves.toBe(0);
    const username = SECRETS.username(TENANT_B.siteId, 'system-user');
    expect(vi.mocked(adminLogin).mock.calls).toEqual([
      [expect.objectContaining({ baseUrl: GATEWAY_URL }), { username, password: SECRETS.secret(`seed:${username}`) }],
    ]);
    expect(vi.mocked(loadSecretStore).mock.calls).toEqual(injected ? [] : [[deps.env]]);
    expect(projectionReads(requests)).toEqual([
      [noteId, TENANT_B.siteId],
      ['ABSENT-NOTE', TENANT_B.siteId],
    ]);

    await stubDlqTarget({ tenantId: TENANT_B.tenantId }).effectCount(noteId, readDeps);
    expect(vi.mocked(adminLogin)).toHaveBeenCalledTimes(2);
  });

  it('rejects every read of a default reader whose login fails, without reading', async () => {
    const { deps, requests } = dlqStack();
    answerLogin(false, 200);
    const target = stubDlqTarget();
    const username = SECRETS.username(TENANT_A.siteId, 'system-user');
    const failure = `admin login as ${username} through the gateway failed (status 200)`;
    await expect(target.effectCount('NOTE', { ...deps, secrets: SECRETS })).rejects.toThrow(failure);
    await expect(target.effectCount('NOTE', { ...deps, secrets: SECRETS })).rejects.toThrow(failure);
    expect(vi.mocked(adminLogin)).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
  });

  it('asks for a reader when its tenant has no fixture site', async () => {
    const { deps } = dlqStack();
    const tenantId = tenantIdForSite('unseeded-site');
    await expect(stubDlqTarget({ tenantId }).effectCount('NOTE', { ...deps, secrets: SECRETS })).rejects.toThrow(
      `tenant ${tenantId} has no fixture site; pass a reader`,
    );
    expect(vi.mocked(adminLogin)).not.toHaveBeenCalled();
  });
});

describe('readStubProjection', () => {
  const NOTE_ID = 'NOTE ID/1';
  const projection = (data: Row): string => JSON.stringify({ apiversion: 'v1', method: 'findProjection', data });
  const valid = { noteid: 'N', applycount: '2', aggregateversion: '3', lasteventid: EVENT_ID.toUpperCase() };
  const notFound = legacyErrorResponse('invalidMethodCall', { method: 'findProjection', mura404: true }).body;

  it.each([
    { label: 'a projection, digits parsed and the event id lower-cased', status: 200, body: projection(valid), read: { applyCount: 2, aggregateVersion: 3, lastEventId: EVENT_ID }, error: null },
    { label: 'the legacy 404 envelope as null', status: 404, body: notFound, read: null, error: null },
    { label: 'a 403 as an error', status: 403, body: '{"error":{"code":"invalid_request"}}', read: null, error: 'not read' },
    { label: 'a 503 as an error', status: 503, body: 'unavailable', read: null, error: 'not read' },
    { label: 'a non-JSON 200 as an error', status: 200, body: '<html>', read: null, error: 'is not JSON' },
    { label: 'a 200 without data as an error', status: 200, body: '{"apiversion":"v1"}', read: null, error: 'is malformed' },
    { label: 'a zero applycount as an error', status: 200, body: projection({ ...valid, applycount: '0' }), read: null, error: 'is malformed' },
    { label: 'a numeric applycount as an error', status: 200, body: projection({ ...valid, applycount: 2 }), read: null, error: 'is malformed' },
    { label: 'an unsafe applycount as an error', status: 200, body: projection({ ...valid, applycount: '9007199254740993' }), read: null, error: 'is malformed' },
    { label: 'a zero-padded aggregateversion as an error', status: 200, body: projection({ ...valid, aggregateversion: '03' }), read: null, error: 'is malformed' },
    { label: 'a lasteventid that is no UUID as an error', status: 200, body: projection({ ...valid, lasteventid: 'event-1' }), read: null, error: 'is malformed' },
  ])('reads $label', async ({ status, body, read, error }) => {
    const requests: URL[] = [];
    const fetch: FetchLike = async (input) => {
      requests.push(new URL(input));
      return new Response(body, { status, headers: { 'content-type': 'application/json;charset=utf-8' } });
    };
    const pending = readStubProjection(readerOn(fetch), NOTE_ID);
    if (error === null) await expect(pending).resolves.toEqual(read);
    else await expect(pending).rejects.toThrow(`stub projection of ${NOTE_ID} ${error} (status ${status}): ${body}`);
    expect(requests.map((url) => url.href)).toEqual([
      `${GATEWAY_URL}${STUB_NOTES_PATH}/${encodeURIComponent(NOTE_ID)}/projection?siteid=${TENANT_A.siteId}`,
    ]);
  });
});

describe('runDlqCheck', () => {
  it('dead-letters a tenant-less envelope with a reason and no effect, then one replay applies it exactly once', async () => {
    const { bus, pubsub, runner, clock, deps } = dlqStack();
    const result = await runDlqCheck(deps);
    expect(failuresOf(result)).toEqual([]);
    expect(result.passed).toBe(true);
    const { evidence } = result;

    const onTopic = bus.publishedTo(TOPIC);
    const tenantless = onTopic.filter((message) => decoded(message).tenantId === undefined);
    expect(tenantless).toHaveLength(1);
    expect(tenantless[0]?.attributes).not.toHaveProperty('tenantId');
    expect(decoded(tenantless[0]!).eventId).toBe(evidence.eventId);

    expect(bus.deadLettered).toHaveLength(1);
    const [letter, corrected] = bus.publishedTo(DLQ_TOPIC);
    expect(letter?.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe(EXPECTED_DLQ_REASON);
    expect(evidence.rejection).toEqual({ reason: EXPECTED_DLQ_REASON, effectAfter: 0 });
    const valid = decoded(corrected!) as EventEnvelope;
    expect(valid.tenantId).toBe(TENANT_A.tenantId);
    expect(decoded(letter!)).toEqual(withoutTenant(valid));

    expect(runner.calls.map((call) => [call.file, ...call.args.slice(0, 3)])).toEqual([
      [OPT2_EVENTS_BIN, 'replay', '--subscription', 'stub.stub.note.created.v1'],
      [OPT2_EVENTS_BIN, 'replay', '--subscription', 'stub.stub.note.created.v1'],
    ]);
    expect(runner.calls[0]?.args).toEqual(replayArgs(SUBSCRIPTION));
    expect(runner.calls[0]?.env).toMatchObject({ GOOGLE_CLOUD_PROJECT: PROJECT, OPT2_STATE_DIR: stateRoot });
    expect(runner.calls.map((call) => call.replayed)).toEqual([1, 0]);

    const replayed = onTopic.filter((message) => decoded(message).tenantId !== undefined);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.attributes).toEqual(originalAttributes(corrected!.attributes));
    expect(replayed[0]?.attributes).not.toHaveProperty(DEAD_LETTER_REASON_ATTRIBUTE);
    expect(bus.effectRows(TENANT_A.tenantId)).toEqual([
      expect.objectContaining({ note_id: evidence.aggregateId, apply_count: 1, last_event_id: evidence.eventId }),
    ]);

    expect(evidence).toMatchObject({
      subscription: SUBSCRIPTION,
      dlqTopic: DLQ_TOPIC,
      correction: { discardedOriginal: true },
      replay: { exitCode: 0, republished: 1, summary: expect.objectContaining({ replayed: 1 }) },
      effect: { before: 0, after: 1 },
      secondReplay: { exitCode: 0, republished: 0, effectAfter: 1 },
    });
    expect(bus.queued(REPLAY_SUBSCRIPTION)).toEqual([]);
    expect(bus.deleted).toEqual([expect.stringMatching(OBSERVER)]);
    expect(pubsub.pulls).toEqual([
      { subscription: REPLAY_SUBSCRIPTION, timeoutMs: PRECONDITION_PULL_MS },
      { subscription: expect.stringMatching(OBSERVER), timeoutMs: LAND_TIMEOUT_MS },
      { subscription: REPLAY_SUBSCRIPTION, timeoutMs: LAND_TIMEOUT_MS },
    ]);
    expect(pubsub.closed).toBe(false);
    expect(clock.sleeps).toEqual([EFFECT_SETTLE_MS]);
  });

  it('passes on its default target, reading as the tenant-a system user logged in once through the gateway', async () => {
    const { deps, requests } = dlqStack();
    answerLogin(true, 200);
    const result = await runDlqCheck({ ...deps, target: undefined, secrets: SECRETS });
    expect(failuresOf(result)).toEqual([]);
    expect(result.evidence.effect).toEqual({ before: 0, after: 1 });
    const username = SECRETS.username(TENANT_A.siteId, 'system-user');
    expect(vi.mocked(adminLogin).mock.calls).toEqual([
      [expect.objectContaining({ baseUrl: GATEWAY_URL }), { username, password: SECRETS.secret(`seed:${username}`) }],
    ]);
    expect(projectionReads(requests)).toEqual(Array(5).fill([result.evidence.aggregateId, TENANT_A.siteId]));
  });

  it('fails when the consumer applies the tenant-less envelope instead of dead-lettering it', async () => {
    const { bus, runner, deps } = dlqStack({ consumer: { acceptTenantless: true } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(bus.publishedTo(DLQ_TOPIC)).toEqual([]);
    expect(result.evidence.rejection).toEqual({ reason: null, effectAfter: 1 });
    expect(failuresOf(result)).toEqual([
      'tenant-less delivery produced 1 effect(s), expected 0',
      `no dead letter of event ${result.evidence.eventId} on ${DLQ_TOPIC} within ${LAND_TIMEOUT_MS} ms`,
    ]);
    expect(runner.calls).toEqual([]);
    expect(bus.deleted).toEqual([expect.stringMatching(OBSERVER)]);
  });

  it.each([
    { label: 'without a reason attribute', reason: null, recorded: null, failure: `dead letter reason null is not one of ${DEAD_LETTER_REASONS.join('|')}` },
    { label: 'with an unknown reason', reason: 'bogus', recorded: 'bogus', failure: `dead letter reason "bogus" is not one of ${DEAD_LETTER_REASONS.join('|')}` },
    { label: 'with another known reason', reason: 'invalid-tenant', recorded: 'invalid-tenant', failure: 'dead letter reason invalid-tenant, expected missing-tenant' },
  ])('fails when the consumer dead-letters $label', async ({ reason, recorded, failure }) => {
    const { deps } = dlqStack({ consumer: { reason } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(result.evidence.rejection.reason).toBe(recorded);
    expect(failuresOf(result)).toEqual([failure]);
    expect(result.evidence.effect).toEqual({ before: 0, after: 1 });
  });

  it.each([
    { label: 'passes when the consumer dedupes', dedupe: true, after: 1, failures: [] },
    {
      label: 'fails when the consumer applies it twice',
      dedupe: false,
      after: 2,
      failures: ['effect count after replay is 2, expected 1', 'effect count after the second replay is 2, expected 1'],
    },
  ])('on a duplicate delivery of the replayed message it $label', async ({ dedupe, after, failures }) => {
    const { deps } = dlqStack({ consumer: { dedupe }, runner: { publishesPerMessage: 2 } });
    const result = await runDlqCheck(deps);
    expect(failuresOf(result)).toEqual(failures);
    expect(result.passed).toBe(failures.length === 0);
    expect(result.evidence.replay.republished).toBe(1);
    expect(result.evidence.effect.after).toBe(after);
  });

  it('fails when the dead letter stays on the replay subscription and the second replay republishes it', async () => {
    const { bus, deps } = dlqStack({ runner: { keepMessages: true } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(result.evidence.secondReplay).toMatchObject({ exitCode: 0, republished: 1, effectAfter: 1 });
    expect(failuresOf(result)).toEqual(['second replay republished 1, expected 0']);
    expect(bus.queued(REPLAY_SUBSCRIPTION)).toHaveLength(1);
  });

  it('bounds the wait for the replayed effect by the injected clock', async () => {
    const { clock, deps } = dlqStack({ runner: { publishesPerMessage: 0 } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(clock.sleeps).toEqual([POLL.intervalMs, POLL.intervalMs, POLL.intervalMs]);
    expect(clock.now() - CLOCK_START).toBe(POLL.timeoutMs);
    expect(result.evidence.effect).toEqual({ before: 0, after: 0 });
    expect(failuresOf(result)).toEqual([
      'effect count after replay is 0, expected 1',
      'effect count after the second replay is 0, expected 1',
    ]);
  });

  it('refuses to start while the replay subscription holds a backlog, leaving it in place', async () => {
    const { bus, pubsub, runner, deps } = dlqStack();
    const stale = testEnvelope({ topic: TOPIC, tenantId: TENANT_A.tenantId, aggregateId: 'STALE-NOTE', payload: {} });
    const id = bus.publish(DLQ_TOPIC, { data: encodeEnvelope(stale), attributes: { [DEAD_LETTER_REASON_ATTRIBUTE]: 'schema-invalid' } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(failuresOf(result)).toEqual([`precondition: dlq replay backlog not empty (${id})`]);
    expect(bus.publishedTo(TOPIC)).toEqual([]);
    expect(bus.queued(REPLAY_SUBSCRIPTION).map((message) => message.id)).toEqual([id]);
    expect(pubsub.pulls).toEqual([{ subscription: REPLAY_SUBSCRIPTION, timeoutMs: PRECONDITION_PULL_MS }]);
    expect(runner.calls).toEqual([]);
  });

  it('records a failed replay run and stops before reading the effect', async () => {
    const { runner, clock, deps } = dlqStack({ runner: { exitCode: 1 } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(failuresOf(result)).toEqual(['replay exited 1: opt2-events: pull failed']);
    expect(result.evidence.replay).toEqual({ exitCode: 1, summary: null, republished: null });
    expect(result.evidence.effect).toEqual({ before: 0, after: null });
    expect(result.evidence.secondReplay).toEqual({ exitCode: null, summary: null, republished: null, effectAfter: null });
    expect(runner.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    {
      label: 'the replay, stopping before reading the effect',
      run: 1,
      failure: `replay timed out after ${REPLAY_EXEC_TIMEOUT_MS} ms`,
      replay: { exitCode: null, summary: null, republished: null },
      effect: { before: 0, after: null },
      secondReplay: { exitCode: null, summary: null, republished: null, effectAfter: null },
      reads: 2,
      sleeps: [],
    },
    {
      label: 'the second replay',
      run: 2,
      failure: `second replay timed out after ${REPLAY_EXEC_TIMEOUT_MS} ms`,
      replay: { exitCode: 0, republished: 1 },
      effect: { before: 0, after: 1 },
      secondReplay: { exitCode: null, summary: null, republished: null, effectAfter: 1 },
      reads: 5,
      sleeps: [EFFECT_SETTLE_MS],
    },
  ])('records a timed-out run of $label', async ({ run, failure, replay, effect, secondReplay, reads, sleeps }) => {
    const { runner, clock, requests, deps } = dlqStack();
    let runs = 0;
    const exec: ReplayExec = async (file, args, env) => {
      runs += 1;
      if (runs !== run) return runner.exec(file, args, env);
      throw Object.assign(new Error(`${file} timed out after ${REPLAY_EXEC_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' });
    };
    const result = await runDlqCheck({ ...deps, exec });
    expect(result.passed).toBe(false);
    expect(failuresOf(result)).toEqual([failure]);
    expect(result.evidence.replay).toMatchObject(replay);
    expect(result.evidence.effect).toEqual(effect);
    expect(result.evidence.secondReplay).toEqual(secondReplay);
    expect(runs).toBe(run);
    expect(requests).toHaveLength(reads);
    expect(clock.sleeps).toEqual(sleeps);
  });

  it('propagates a replay run that fails to start', async () => {
    const { deps } = dlqStack();
    const spawnFailure = Object.assign(new Error('spawn opt2-events ENOENT'), { code: 'ENOENT' });
    await expect(runDlqCheck({ ...deps, exec: () => Promise.reject(spawnFailure) })).rejects.toBe(spawnFailure);
  });

  it.each(['replayed some messages\n', '{"replayed":-1}\n', '{"replayed":"1"}\n'])(
    'fails a replay run whose output %j carries no summary count',
    async (stdout) => {
      const { deps } = dlqStack({ runner: { stdout } });
      const result = await runDlqCheck(deps);
      expect(result.passed).toBe(false);
      expect(failuresOf(result)).toEqual([
        'replay printed no summary line with a replayed count',
        'second replay printed no summary line with a replayed count',
      ]);
      expect(result.evidence.replay.republished).toBeNull();
      expect(result.evidence.effect.after).toBe(1);
    },
  );

  it('locates its own dead letter by eventId among foreign letters and reports the extra replay', async () => {
    const { deps } = dlqStack({ consumer: { foreignLetter: true } });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(result.evidence.rejection).toEqual({ reason: EXPECTED_DLQ_REASON, effectAfter: 0 });
    expect(result.evidence.correction.discardedOriginal).toBe(true);
    expect(result.evidence.effect.after).toBe(1);
    expect(failuresOf(result)).toEqual(['replay republished 2, expected 1', 'second replay republished 1, expected 0']);
  });

  it('fails when the dead letter never reaches the replay subscription', async () => {
    const { bus, deps } = dlqStack();
    bus.deleteSubscription(REPLAY_SUBSCRIPTION);
    bus.createSubscription('stub.note.archived.v1', REPLAY_SUBSCRIPTION);
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(result.evidence.correction.discardedOriginal).toBe(false);
    expect(result.evidence.replay.republished).toBe(0);
    expect(failuresOf(result)).toEqual([
      `dead letter of event ${result.evidence.eventId} not found on ${REPLAY_SUBSCRIPTION} within ${LAND_TIMEOUT_MS} ms`,
      'replay republished 0, expected 1',
      'effect count after replay is 0, expected 1',
      'effect count after the second replay is 0, expected 1',
    ]);
  });

  it('records an observer subscription it could not delete', async () => {
    const { deps } = dlqStack({ deleteSubscription: new Error('permission denied') });
    const result = await runDlqCheck(deps);
    expect(result.passed).toBe(false);
    expect(failuresOf(result)).toEqual([
      expect.stringMatching(/^observer subscription opt2-dlq-check-[0-9a-f]{8}\.\S+\.dlq not deleted: permission denied$/),
    ]);
  });

  it('rejects a target whose subscription does not consume its topic before touching Pub/Sub', async () => {
    const { bus, pubsub, deps } = dlqStack();
    const target = { ...stubDlqTarget(), topic: 'stub.note.deleted.v1' };
    await expect(runDlqCheck({ ...deps, target })).rejects.toThrow(RangeError);
    expect(pubsub.pulls).toEqual([]);
    expect(bus.published).toEqual([]);
  });

  it.each([
    { label: 'no emulator host', host: '', probes: 0, rejection: undefined },
    { label: 'a probe that resolves false', host: 'pubsub.invalid:8085', probes: 1, rejection: undefined },
    {
      label: 'an emulator that does not answer',
      host: 'pubsub.invalid:8085',
      probes: 1,
      rejection: new Error('The Pub/Sub emulator at PUBSUB_EMULATOR_HOST=pubsub.invalid:8085 is unreachable'),
    },
  ])('fails without a Pub/Sub client when it finds $label', async ({ host, probes, rejection }) => {
    if (rejection !== undefined) vi.mocked(pubsubEmulatorAvailable).mockRejectedValueOnce(rejection);
    const { runner, deps } = dlqStack();
    const result = await runDlqCheck({ ...deps, pubsub: undefined, env: { ...deps.env, PUBSUB_EMULATOR_HOST: host } });
    expect(result).toMatchObject({ passed: false, evidence: { failures: ['pubsub emulator unavailable'] } });
    expect(vi.mocked(pubsubEmulatorAvailable)).toHaveBeenCalledTimes(probes);
    expect(pubsubDouble.state.clients).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('builds and closes its own emulator client when none is injected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bus, runner, deps } = dlqStack();
    pubsubDouble.state.bus = bus;
    vi.mocked(pubsubEmulatorAvailable).mockResolvedValueOnce(true);
    const host = 'pubsub.invalid:8085';
    const pending = runDlqCheck({ ...deps, pubsub: undefined, env: { ...deps.env, PUBSUB_EMULATOR_HOST: host } });
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    // The precondition receive window has no early end, so the fake clock runs it out.
    while (!settled) await vi.advanceTimersByTimeAsync(PRECONDITION_PULL_MS);
    const result = await pending;

    expect(failuresOf(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(pubsubDouble.state.clients).toEqual([
      { options: { projectId: PROJECT, apiEndpoint: host, emulatorMode: true }, closed: true },
    ]);
    const pulls = pubsubDouble.state.receivers.filter((receiver) => receiver.options !== undefined);
    expect(pulls).toEqual([
      expect.objectContaining({ name: REPLAY_SUBSCRIPTION, closed: true }),
      expect.objectContaining({ name: expect.stringMatching(OBSERVER), closed: true }),
      expect.objectContaining({ name: REPLAY_SUBSCRIPTION, closed: true }),
    ]);
    expect(bus.deleted).toEqual([expect.stringMatching(OBSERVER)]);
    expect(runner.calls.map((call) => call.env.PUBSUB_EMULATOR_HOST)).toEqual([host, host]);
  });
});

describe('emulatorDlqPubSub', () => {
  const host = 'pubsub.invalid:8085';
  const OBSERVED = 'unit-observer';

  it('publishes, manages subscriptions and settles each received delivery by its decision', async () => {
    const bus = new FakeBus();
    pubsubDouble.state.bus = bus;
    const client = emulatorDlqPubSub({ projectId: PROJECT, emulatorHost: host });
    await client.createSubscription(DLQ_TOPIC, OBSERVED);
    const first = await client.publish(DLQ_TOPIC, {
      data: Buffer.from('{"eventId":"one"}'),
      attributes: { eventId: 'one' },
      orderingKey: 'NOTE-1',
    });
    const second = await client.publish(DLQ_TOPIC, { data: Buffer.from('{"eventId":"two"}'), attributes: { eventId: 'two' } });

    const received = await client.pull(OBSERVED, {
      timeoutMs: 60_000,
      decide: (message) => (message.id === first ? 'ack' : 'nack'),
      done: (messages) => messages.length === 2,
    });
    expect(received).toEqual([
      { id: first, data: Buffer.from('{"eventId":"one"}'), attributes: { eventId: 'one' }, orderingKey: 'NOTE-1' },
      { id: second, data: Buffer.from('{"eventId":"two"}'), attributes: { eventId: 'two' } },
    ]);
    expect(bus.queued(OBSERVED).map((message) => message.id)).toEqual([second]);
    expect(pubsubDouble.state.receivers).toEqual([
      {
        name: OBSERVED,
        options: { flowControl: { maxMessages: 10, allowExcessMessages: false }, closeOptions: { behavior: 'NACK' } },
        closed: true,
      },
    ]);

    await client.deleteSubscription(OBSERVED);
    expect(bus.hasSubscription(OBSERVED)).toBe(false);
    await client.close();
    expect(pubsubDouble.state.clients).toEqual([
      { options: { projectId: PROJECT, apiEndpoint: host, emulatorMode: true }, closed: true },
    ]);
  });

  it('returns what arrived once the receive window ends without done holding', async () => {
    const bus = new FakeBus();
    pubsubDouble.state.bus = bus;
    const id = bus.publish(DLQ_TOPIC, { data: Buffer.from('{}'), attributes: {} });
    const client = emulatorDlqPubSub({ projectId: PROJECT, emulatorHost: host });
    const received = await client.pull(REPLAY_SUBSCRIPTION, { timeoutMs: 5, decide: () => 'nack' });
    expect(received.map((message) => message.id)).toEqual([id]);
    expect(bus.queued(REPLAY_SUBSCRIPTION)).toHaveLength(1);
    await client.close();
  });

  it('rejects with the receiver error and still closes the receiver', async () => {
    pubsubDouble.state.bus = new FakeBus();
    pubsubDouble.state.receiveError = new Error('stream reset');
    const client = emulatorDlqPubSub({ projectId: PROJECT, emulatorHost: host });
    await expect(client.pull(REPLAY_SUBSCRIPTION, { timeoutMs: 60_000, decide: () => 'ack' })).rejects.toThrow('stream reset');
    expect(pubsubDouble.state.receivers.map((receiver) => receiver.closed)).toEqual([true]);
    await client.close();
  });
});

describe('replay bin', () => {
  it('runs the harness opt2-events bin with the subscription and idle bound', () => {
    expect(OPT2_EVENTS_BIN).toBe(path.join(HARNESS_ROOT, 'node_modules', '.bin', 'opt2-events'));
    expect(replayArgs(SUBSCRIPTION)).toEqual(['replay', '--subscription', SUBSCRIPTION, '--idle-seconds', String(REPLAY_IDLE_SECONDS)]);
  });

  it.each([
    { label: 'empty output', stdout: '', summary: null },
    { label: 'a non-JSON last line', stdout: '{"replayed":1}\nreplay done\n', summary: null },
    { label: 'a JSON array', stdout: '[1]\n', summary: null },
    { label: 'log lines before the summary', stdout: 'pulling\n{"replayed":2}\n\n', summary: { replayed: 2 } },
  ])('parses the summary from $label', ({ stdout, summary }) => {
    expect(parseReplaySummary(stdout)).toEqual(summary);
  });

  it.each([
    { label: 'a clean exit', error: null, exitCode: 0 },
    { label: 'a non-zero exit', error: Object.assign(new Error('Command failed'), { code: 3 }), exitCode: 3 },
  ])('resolves $label with its output and exit code', async ({ error, exitCode }) => {
    answerExec(error, '{"replayed":1}\n', 'warning\n');
    const env = { PATH: '/usr/bin', GOOGLE_CLOUD_PROJECT: PROJECT };
    await expect(defaultReplayExec(OPT2_EVENTS_BIN, replayArgs(SUBSCRIPTION), env)).resolves.toEqual({
      exitCode,
      stdout: '{"replayed":1}\n',
      stderr: 'warning\n',
    });
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      OPT2_EVENTS_BIN,
      replayArgs(SUBSCRIPTION),
      { cwd: process.cwd(), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
      expect.any(Function),
    );
  });

  it('rejects when the bin cannot start', async () => {
    answerExec(Object.assign(new Error('spawn opt2-events ENOENT'), { code: 'ENOENT' }), '', '');
    await expect(defaultReplayExec(OPT2_EVENTS_BIN, replayArgs(SUBSCRIPTION), {})).rejects.toThrow('spawn opt2-events ENOENT');
  });

  it.each([
    { label: 'dies on SIGTERM', diesOn: 'SIGTERM', kills: [['SIGTERM']], destroyed: 0 },
    { label: 'ignores every signal', diesOn: null, kills: [['SIGTERM'], ['SIGKILL']], destroyed: 1 },
  ])('ends a bin that $label past REPLAY_EXEC_TIMEOUT_MS and rejects with a bare ETIMEDOUT', async ({ diesOn, kills, destroyed }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    type Callback = (err: Error | null, out: string, errOut: string) => void;
    let callback: Callback | undefined;
    const stdio = [{ destroy: vi.fn() }, { destroy: vi.fn() }, { destroy: vi.fn() }];
    const kill = vi.fn((signal: string) => {
      // execFile's own error quotes the child's stderr.
      const died = Object.assign(new Error(`Command failed: ${OPT2_EVENTS_BIN}\nchild-stderr`), { killed: true, code: null, signal });
      if (signal === diesOn) callback?.(died, 'child-stdout', 'child-stderr');
      return true;
    });
    const answer = (_file: string, _args: readonly string[], _options: unknown, cb: Callback): unknown => {
      callback = cb;
      return { exitCode: null, signalCode: null, kill, stdio };
    };
    vi.mocked(execFile).mockImplementationOnce(answer as unknown as typeof execFile);
    const env = { GOOGLE_CLOUD_PROJECT: PROJECT, OPT2_DLQ_TEST_MARKER: 'env-marker' };
    const pending = defaultReplayExec(OPT2_EVENTS_BIN, replayArgs(SUBSCRIPTION), env).catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'ETIMEDOUT', message: `${OPT2_EVENTS_BIN} timed out after ${REPLAY_EXEC_TIMEOUT_MS} ms` });
    expect((error as Error).cause).toBeUndefined();
    expect(kill.mock.calls).toEqual(kills);
    for (const stream of stdio) expect(stream.destroy).toHaveBeenCalledTimes(destroyed);
  });
});

