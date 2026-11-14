// Unit tests for the pubsub-redelivery fault script, with snapshots, tenants, shapes, owner exports, the replay child and the drain faked,
// and Pub/Sub and the consumers' push routes replaced by in-memory doubles.
import { Buffer } from 'node:buffer';

import { pushPath, subscriptionName, type PushBody } from '@opt2/platform/events';
import { fixedClock, type Clock } from '@opt2/platform/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyTenantResolver } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { outboxCliPath, spawnChild, type ChildOutcome, type SpawnChildOptions } from '../../src/faults/process-control.js';
import { PushRestoreError, WitnessCleanupError } from '../../src/faults/redelivery-barrier.js';
import { createPubsubRedelivery, pubsubRedelivery, type PubsubRedeliveryParams } from '../../src/faults/scripts/pubsub-redelivery.js';
import type { FaultEnv, FaultScript } from '../../src/faults/scripts/types.js';
import {
  DrainTimeoutError,
  awaitDrained,
  isPushConfig,
  type DrainResult,
  type LeasedMessage,
  type MessageLease,
  type OwnerDrainCounts,
  type PubSubLike,
  type SavedPushConfig,
  type SubscriptionLike,
} from '../../src/quiesce/index.js';
import {
  describeUnitTable,
  fixtureTables,
  readFixtureStatus,
  readTargetUnitRows,
  toUnitRow,
  type UnitTableShape,
} from '../../src/reconcile/index.js';
import { getSnapshot, latestSnapshot, type SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  latestSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
}));

vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  createApplyTenantResolver: vi.fn(),
}));

vi.mock('../../src/reconcile/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reconcile/index.js')>()),
  describeUnitTable: vi.fn(),
  readTargetUnitRows: vi.fn(),
  fixtureTables: vi.fn(),
  readFixtureStatus: vi.fn(),
}));

vi.mock('../../src/quiesce/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/quiesce/index.js')>()),
  awaitDrained: vi.fn(),
}));

vi.mock('../../src/faults/process-control.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/faults/process-control.js')>()),
  spawnChild: vi.fn(),
  outboxCliPath: vi.fn(() => '/fake/platform/dist/outbox/cli.js'),
}));

const NOW = new Date('2026-06-30T12:00:00.000Z');
const S1_TAKEN = new Date('2026-06-30T08:00:00.000Z');
const SNAPSHOT_DB = 'muradb_opt2_snap_3';
const TENANT_A = '11111111-1111-5111-8111-111111111111';
const TENANT_B = '22222222-2222-5222-8222-222222222222';
const PRODUCERS = ['identity', 'people', 'programs-sites'] as const;

/** Unit tables of the fake catalog: owner, unit, legacy table and whether it migrates. */
const TABLES = [
  { owner: 'identity', unit: 'identity.user_account', legacyTable: 'dbo.tusers', migratable: true },
  { owner: 'people', unit: 'people.person', legacyTable: 'dbo.tusers', migratable: true },
  { owner: 'people', unit: 'people.person_archive', legacyTable: 'synthetic.person_archive', migratable: true },
  { owner: 'programs-sites', unit: 'programs_sites.site', legacyTable: 'dbo.tsettings', migratable: true },
  { owner: 'programs-sites', unit: 'programs_sites.site', legacyTable: 'dbo.tplugins', migratable: false },
] as const;

const KEYS_PER_CAPTURE = 4 * 2;

function shapeOf(unit: string, legacyTable: string, owner: string): UnitTableShape {
  return {
    unit,
    owner,
    legacyTable,
    keyed: true,
    keyColumns: ['ID'],
    columns: [
      { name: 'ID', type: 's' },
      { name: 'Name', type: 's' },
    ],
    excludedColumns: [],
    objectColumns: [],
    folded: false,
  };
}

function snapshot(seq: number, takenAt: Date): SnapshotRecord {
  return { seq, databaseName: `muradb_opt2_snap_${String(seq)}`, takenAt, state: 'ready' } as SnapshotRecord;
}

function outcome(exitCode: number | null, stdoutTail: string, stderrTail = ''): ChildOutcome {
  return { exitCode, signal: null, timedOut: false, stdoutTail, stderrTail };
}

function summaryLine(replayed: number): string {
  return `${JSON.stringify({ schema: 'identity', since: S1_TAKEN.toISOString(), replayed, failed: 0, skipped: 0, tenants: 2 })}\n`;
}

function counts(owner: string, pendingReceipts = 0): OwnerDrainCounts {
  return { owner, unpublished: 0, held: 0, pendingReceipts };
}

function drained(owners: OwnerDrainCounts[] = PRODUCERS.map((owner) => counts(owner))): DrainResult {
  return { owners, polls: 2, elapsedMs: 1004 };
}

const PROJECT = 'opt2-unit';
const PUSH_KEY = 'unit-push-key-6f1c';
const GROUP_CHANGED = 'identity.group.changed.v1';
const LOGIN_MAIL = 'identity.login-mail.requested.v1';
const PERSON_CHANGED = 'people.person.changed.v1';
const PERSON_ARCHIVED = 'people.person.archived.v1';
const SITE_CHANGED = 'programs-sites.site.changed.v1';
const NOTE_CREATED = 'stub.note.created.v1';
const WITNESS_PREFIX = 'witness_pubsub-redelivery_';
const WITNESS_NAME = /^witness_pubsub-redelivery_[0-9a-f]{8}\.(.+)$/;
const PUBLISH_TIME = '2026-06-30T11:59:00.000Z';
const DATA_OWNERS = ['identity', 'people', 'programs-sites', 'strategies-content', 'timesheets'] as const;

/** Consumer subscriptions of the fake project; the stub's topic belongs to no replayed producer. */
const SUBSCRIPTIONS = [
  { consumer: 'people', topic: GROUP_CHANGED, ordered: true, port: 20112 },
  { consumer: 'strategies-content', topic: GROUP_CHANGED, ordered: false, port: 20114 },
  { consumer: 'identity', topic: PERSON_CHANGED, ordered: true, port: 20111 },
  { consumer: 'timesheets', topic: SITE_CHANGED, ordered: false, port: 20118 },
  { consumer: 'stub', topic: NOTE_CREATED, ordered: false, port: 20199 },
] as const;

const PEOPLE_GROUP = subscriptionName('people', GROUP_CHANGED);
const CONTENT_GROUP = subscriptionName('strategies-content', GROUP_CHANGED);
const IDENTITY_PERSON = subscriptionName('identity', PERSON_CHANGED);
const TIMESHEETS_SITE = subscriptionName('timesheets', SITE_CHANGED);
const STUB_NOTE = subscriptionName('stub', NOTE_CREATED);
/** Held subscriptions in listing order. */
const HELD = [IDENTITY_PERSON, PEOPLE_GROUP, CONTENT_GROUP, TIMESHEETS_SITE];
/** Topics of the fake project: login mail and archived persons have no consumer, and the DLQ topic is no event topic. */
const TOPICS = [GROUP_CHANGED, LOGIN_MAIL, PERSON_ARCHIVED, PERSON_CHANGED, SITE_CHANGED, NOTE_CREATED, `${PEOPLE_GROUP}.dlq`];
/** Topics a witness watches, per replayed producer. */
const WITNESSED: Record<string, string[]> = {
  identity: [GROUP_CHANGED, LOGIN_MAIL],
  people: [PERSON_ARCHIVED, PERSON_CHANGED],
  'programs-sites': [SITE_CHANGED],
};

const eventId = (n: number): string => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Outbox rows each producer's replay republishes with their original event ids. */
const OUTBOX: Record<string, { eventId: string; topic: string; orderingKey: string }[]> = {
  identity: [
    { eventId: eventId(1), topic: GROUP_CHANGED, orderingKey: 'group-1' },
    { eventId: eventId(2), topic: GROUP_CHANGED, orderingKey: 'group-1' },
    { eventId: eventId(5), topic: LOGIN_MAIL, orderingKey: 'user-5' },
  ],
  people: [{ eventId: eventId(3), topic: PERSON_CHANGED, orderingKey: 'person-3' }],
  'programs-sites': [{ eventId: eventId(4), topic: SITE_CHANGED, orderingKey: 'site-4' }],
};

const INBOX_TOTALS = { identity: 10, people: 20, 'strategies-content': 30, timesheets: 40 };

const fullName = (name: string): string => `projects/${PROJECT}/subscriptions/${name}`;
const endpointOf = (name: string): string =>
  `http://127.0.0.1:${String(SUBSCRIPTIONS.find((entry) => subscriptionName(entry.consumer, entry.topic) === name)?.port)}${pushPath(name)}`;

/** One copy waiting on a fake subscription; `seq` is its publish order, and an `unidentified` copy carries no event id. */
interface QueuedCopy {
  seq: number;
  messageId: string;
  eventId: string;
  orderingKey: string;
  deliveryAttempt: number;
  unidentified?: true;
}

/** A fake subscription: its push config (`null` in pull), queue, leases and settlement record. */
interface FakeSubscription {
  name: string;
  topic: string;
  saved: SavedPushConfig;
  push: SavedPushConfig | null;
  queue: QueuedCopy[];
  leased: Map<string, QueuedCopy>;
  acked: string[];
  released: string[];
  subscription: SubscriptionLike & { modifyPushConfig: ReturnType<typeof vi.fn<(config: SavedPushConfig) => Promise<unknown>>> };
}

/** In-memory Pub/Sub: a pull on a subscription in push mode returns nothing, as the emulator's does; a witness starts empty, in pull mode. */
function fakeBroker() {
  let seq = 0;
  let ackSeq = 0;
  const subs = new Map<string, FakeSubscription>();
  const add = (name: string, topic: string, ordered: boolean, saved: SavedPushConfig): void => {
    const push = isPushConfig(saved) ? saved : null;
    const entry = { name, topic, saved, push, queue: [], leased: new Map(), acked: [], released: [] } as unknown as FakeSubscription;
    entry.subscription = {
      name: fullName(name),
      getMetadata: vi.fn(async () => [{ pushConfig: entry.push ?? { pushEndpoint: '' }, enableMessageOrdering: ordered }] as [object]),
      modifyPushConfig: vi.fn(async (config: SavedPushConfig) => {
        entry.push = isPushConfig(config) ? config : null;
        return [{}];
      }),
      seek: vi.fn(async () => [{}]),
    };
    subs.set(name, entry);
  };
  for (const { consumer, topic, ordered } of SUBSCRIPTIONS) {
    const name = subscriptionName(consumer, topic);
    add(name, topic, ordered, { pushEndpoint: `${endpointOf(name)}?key=${PUSH_KEY}`, attributes: {} });
  }
  /** Every witness creation, as `[topic, name]`, including those since deleted. */
  const witnessed: [string, string][] = [];
  const get = (full: string): FakeSubscription => {
    const entry = subs.get(full.replace(`projects/${PROJECT}/subscriptions/`, ''));
    if (entry === undefined) throw new Error(`no fake subscription ${full}`);
    return entry;
  };
  const leased = (entry: FakeSubscription, copy: QueuedCopy): LeasedMessage => {
    const ackId = `ack-${String((ackSeq += 1))}`;
    entry.leased.set(ackId, copy);
    if (copy.unidentified) {
      return { ackId, messageId: copy.messageId, data: Buffer.from('{}', 'utf8'), attributes: {}, publishTime: PUBLISH_TIME };
    }
    return {
      ackId,
      messageId: copy.messageId,
      data: Buffer.from(JSON.stringify({ eventId: copy.eventId, tenantId: TENANT_A }), 'utf8'),
      attributes: { eventId: copy.eventId, tenantId: TENANT_A },
      publishTime: PUBLISH_TIME,
      orderingKey: copy.orderingKey,
      deliveryAttempt: copy.deliveryAttempt,
      eventId: copy.eventId,
    };
  };
  const lease = (entry: FakeSubscription): MessageLease => ({
    pull: vi.fn(async (maxMessages: number) => (entry.push === null ? entry.queue.splice(0, maxMessages).map((copy) => leased(entry, copy)) : [])),
    acknowledge: vi.fn(async (ackIds: readonly string[]) => {
      for (const ackId of ackIds) {
        const copy = entry.leased.get(ackId);
        entry.leased.delete(ackId);
        if (copy !== undefined) entry.acked.push(copy.eventId);
      }
    }),
    release: vi.fn(async (ackIds: readonly string[]) => {
      for (const ackId of ackIds) {
        const copy = entry.leased.get(ackId);
        entry.leased.delete(ackId);
        if (copy === undefined) continue;
        entry.released.push(copy.eventId);
        entry.queue.push({ ...copy, deliveryAttempt: copy.deliveryAttempt + 1 });
      }
      entry.queue.sort((a, b) => a.seq - b.seq);
    }),
    close: vi.fn(async () => undefined),
  });
  const leases: MessageLease[] = [];
  const pubsub = {
    projectId: PROJECT,
    getSubscriptions: async () => [[...subs.values()].map((entry) => entry.subscription)] as [SubscriptionLike[]],
    subscription: (name: string) => get(fullName(name)).subscription,
    close: vi.fn(async () => undefined),
    peekEventIds: vi.fn(async (full: string) => {
      const entry = get(full);
      return entry.push === null ? [...new Set(entry.queue.map((copy) => copy.eventId))].sort() : [];
    }),
    leaseMessages: vi.fn(async (full: string) => {
      const created = lease(get(full));
      leases.push(created);
      return created;
    }),
    topicIds: vi.fn(async () => [...TOPICS].sort()),
    createWitness: vi.fn(async (topic: string, name: string) => {
      if (!TOPICS.includes(topic)) throw Object.assign(new Error(`5 NOT_FOUND: topic ${topic}`), { code: 5 });
      if (subs.has(name)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${name}`), { code: 6 });
      witnessed.push([topic, name]);
      add(name, topic, false, {});
    }),
    deleteSubscription: vi.fn(async (name: string) => {
      subs.delete(name);
    }),
  } satisfies PubSubLike;
  /** Publishes one copy to every subscription of `topic`. */
  const publish = (topic: string, id: string, orderingKey: string, unidentified = false): void => {
    for (const entry of subs.values()) {
      if (entry.topic !== topic) continue;
      seq += 1;
      entry.queue.push({ seq, messageId: `m-${String(seq)}`, eventId: id, orderingKey, deliveryAttempt: 1, ...(unidentified ? { unidentified } : {}) });
    }
  };
  /** Live witness subscriptions, by name. */
  const witnesses = (): string[] => [...subs.keys()].filter((name) => name.startsWith(WITNESS_PREFIX)).sort();
  return { pubsub, publish, leases, witnessed, witnesses, add, sub: (name: string) => subs.get(name) as FakeSubscription };
}

/** Takes the last `count` copies of each named subscription's queue out of reach; `reveal` puts them back in publish order. */
function withhold(counts: Readonly<Record<string, number>>): { copies: number; reveal: () => void } {
  const taken = Object.entries(counts).map(([name, count]) => [name, broker.sub(name).queue.splice(-count, count)] as const);
  return {
    copies: taken.reduce((sum, [, copies]) => sum + copies.length, 0),
    reveal: () => {
      for (const [name, copies] of taken) {
        const { queue } = broker.sub(name);
        queue.push(...copies.splice(0));
        queue.sort((a, b) => a.seq - b.seq);
      }
    },
  };
}

/** One push the consumer double received. */
interface PushCall {
  url: string;
  init: RequestInit;
  body: PushBody;
  eventId: string;
}

/** Target rows per `<unit>|<legacyTable>|<tenant>`, read by the faked owner export at call time. */
let targetData: Map<string, Record<string, string>[]>;
let disposed: number;
let broker: ReturnType<typeof fakeBroker>;
let pushes: PushCall[];
/** Consumer double's answer to each push; 204 unless a test replaces it. */
let answer: (call: PushCall) => Promise<Response>;
let inbox: Record<string, number | null>;
/** Order of replays, checksum reads and push answers. */
let timeline: string[];
let script: FaultScript<PubsubRedeliveryParams>;

const fetchDouble = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as PushBody;
  const call = { url: String(input), init: init ?? {}, body, eventId: body.message.attributes?.eventId ?? '' };
  pushes.push(call);
  const response = await answer(call);
  timeline.push(`answered:${call.eventId}`);
  return response;
});

/** The default replay child: publishes the producer's outbox copies to every subscription of their topics and reports their count. */
async function replayChild(_command: string, _args: readonly string[], options: SpawnChildOptions): Promise<ChildOutcome> {
  const producer = String(options.env.OPT2_SERVICE_NAME);
  const rows = OUTBOX[producer] ?? [];
  for (const row of rows) broker.publish(row.topic, row.eventId, row.orderingKey);
  timeline.push(`replay:${producer}`);
  return outcome(0, `opt2-outbox starting\n${summaryLine(rows.length)}\n`);
}

/** Replayed rows per producer under the default replay child. */
const REPUBLISHED: Record<string, number> = Object.fromEntries(Object.entries(OUTBOX).map(([producer, rows]) => [producer, rows.length]));

/** The passing `observed:<producer>` assertion of the default replay child. */
function observed(producer: string) {
  const topics = Object.fromEntries(WITNESSED[producer]?.map((topic) => [topic, OUTBOX[producer]?.filter((row) => row.topic === topic).length]) ?? []);
  return { name: `observed:${producer}`, status: 'pass', detail: { replayed: REPUBLISHED[producer], topics } };
}

/** Both passing assertions of one producer's default replay. */
function replayedAndObserved(producer: string, since = S1_TAKEN.toISOString()) {
  return [{ name: `replayed:${producer}`, status: 'pass', detail: { republished: REPUBLISHED[producer], since } }, observed(producer)];
}

function ctxWith(): MigrationContext {
  return {
    config: { dataOwners: [...DATA_OWNERS], paths: { tableOwnership: '/fake/opt2/table-ownership.json' } },
    env: { OPT2_STATE_DIR: '/fake/state', OPT2_SERVICE_URLS: {} },
    clock: fixedClock(NOW),
    owners: {
      position: vi.fn(async (owner: string) => ({
        owner,
        position: '0',
        outbox: null,
        inbox: inbox[owner] === null ? null : { total: inbox[owner] ?? 0, bySubscription: {} },
      })),
    },
    catalog: {
      unitsOfOwner: (owner: string) =>
        [...new Set(TABLES.filter((entry) => entry.owner === owner).map((entry) => entry.unit))].map((id) => ({ id, owner })),
      legacyTablesOf: (unit: string) => TABLES.filter((entry) => entry.unit === unit).map((entry) => entry.legacyTable),
      isMigratable: (table: string) => TABLES.some((entry) => entry.legacyTable === table && entry.migratable),
    },
  } as unknown as MigrationContext;
}

/** A clock that moves only when the script sleeps or a test advances it. */
function steppingClock(): { clock: Clock; advance: (ms: number) => void } {
  let nowMs = NOW.getTime();
  return { clock: { now: () => new Date(nowMs) }, advance: (ms) => (nowMs += ms) };
}

function envWith(ctx: MigrationContext = ctxWith()) {
  const envOf = vi.fn((name: string) => ({ OPT2_SERVICE_NAME: name, PG_USER: `${name.replaceAll('-', '_')}_app` }));
  const { clock, advance } = steppingClock();
  const sleep = vi.fn(async (ms: number) => {
    advance(ms);
  });
  return { env: { ctx, processControl: { envOf }, clock, sleep } as unknown as FaultEnv, envOf, ctx, advance, sleep };
}

function params(overrides: Partial<PubsubRedeliveryParams> = {}): PubsubRedeliveryParams {
  return pubsubRedelivery.paramsSchema.parse(overrides);
}

/** The passing `redelivered:<subscription>` assertion for `count` copies answered 204 at once. */
function redelivered(name: string, count: number) {
  return { name: `redelivered:${name}`, status: 'pass', detail: { endpoint: endpointOf(name), expected: count, delivered: count, statuses: { 204: count } } };
}

const HAPPY_REDELIVERIES = [redelivered(IDENTITY_PERSON, 1), redelivered(PEOPLE_GROUP, 2), redelivered(CONTENT_GROUP, 2), redelivered(TIMESHEETS_SITE, 1)];

beforeEach(() => {
  vi.clearAllMocks();
  disposed = 0;
  broker = fakeBroker();
  pushes = [];
  timeline = [];
  inbox = { ...INBOX_TOTALS };
  answer = async () => new Response(null, { status: 204 });
  script = createPubsubRedelivery({ pubsub: () => broker.pubsub, fetch: fetchDouble });
  targetData = new Map([
    [`identity.user_account|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'admin' }]],
    [`people.person|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'Ada' }, { ID: 'u2', Name: 'Grace' }]],
    [`programs_sites.site|dbo.tsettings|${TENANT_B}`, [{ ID: 'tenant-b', Name: 'Tenant B' }]],
  ]);
  vi.mocked(latestSnapshot).mockResolvedValue(snapshot(3, NOW));
  vi.mocked(getSnapshot).mockImplementation(async (_ctx, seq) => (seq === 0 ? null : snapshot(seq, seq === 1 ? S1_TAKEN : NOW)));
  vi.mocked(createApplyTenantResolver).mockResolvedValue({ resolve: vi.fn(), siteTenants: () => [TENANT_A, TENANT_B] });
  vi.mocked(fixtureTables).mockResolvedValue(new Set(['synthetic.person_archive']));
  vi.mocked(readFixtureStatus).mockResolvedValue({ available: true, reason: null, checkedAt: NOW.toISOString() });
  vi.mocked(describeUnitTable).mockImplementation(async (_deps, { unit, legacyTable }) =>
    shapeOf(unit, legacyTable, TABLES.find((entry) => entry.unit === unit)?.owner ?? 'unknown'),
  );
  vi.mocked(readTargetUnitRows).mockImplementation(async (_deps, shape, tenantId) => {
    const values = targetData.get(`${shape.unit}|${shape.legacyTable}|${tenantId}`) ?? [];
    timeline.push('checksum');
    return {
      rows: values.map((row) => toUnitRow(shape, row)),
      count: values.length,
      objects: null,
      dispose: async () => {
        disposed += 1;
      },
    };
  });
  vi.mocked(spawnChild).mockImplementation(replayChild);
  vi.mocked(awaitDrained).mockImplementation(async () => {
    timeline.push('drained');
    return drained();
  });
});

describe('pubsub-redelivery fault script', () => {
  it('is the config fault pubsub-redelivery and reconciles afterwards', () => {
    expect(pubsubRedelivery.name).toBe('pubsub-redelivery');
    expect(pubsubRedelivery.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(pubsubRedelivery.name);
  });

  it.each([
    [{}, { producers: [...PRODUCERS], drainTimeoutMs: 120_000 }],
    [
      { producers: ['people'], since: '2026-06-30T08:00:00+02:00', drainTimeoutMs: 5000 },
      { producers: ['people'], since: '2026-06-30T08:00:00+02:00', drainTimeoutMs: 5000 },
    ],
  ])('parses %j as %j', (input, expected) => {
    expect(pubsubRedelivery.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([
    { producers: [] },
    { producers: ['finance'] },
    { since: '2026-06-30' },
    { since: '2026-06-30T08:00:00' },
    { drainTimeoutMs: 0 },
    { drainTimeoutMs: 1.5 },
    { tenant: TENANT_A },
  ])('rejects %j', (input) => {
    expect(pubsubRedelivery.paramsSchema.safeParse(input).success).toBe(false);
  });

  it('replays every producer as itself while push is held, observes and pushes every copy, and finds inboxes, checksums and receipts unchanged', async () => {
    const { env, envOf, ctx, sleep } = envWith();
    const output = await script.run(env, params());
    const since = S1_TAKEN.toISOString();

    expect(output.assertions).toStrictEqual([
      ...PRODUCERS.flatMap((producer) => replayedAndObserved(producer)),
      ...HAPPY_REDELIVERIES,
      { name: 'inbox-unchanged', status: 'pass', detail: { totals: INBOX_TOTALS } },
      { name: 'drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } },
      { name: 'aggregates-unchanged', status: 'pass', detail: { keys: KEYS_PER_CAPTURE } },
      { name: 'projections-unchanged', status: 'pass', detail: { owners: 3 } },
    ]);
    expect(output.details).toStrictEqual({
      since,
      producers: [...PRODUCERS],
      republished: REPUBLISHED,
      subscriptions: HELD,
      checksumKeys: KEYS_PER_CAPTURE,
      skippedTables: [],
    });
    const runIds = new Set(broker.witnessed.map(([topic, name]) => name.slice(0, -(topic.length + 1))));
    expect(runIds.size).toBe(1);
    expect(broker.witnessed.map(([topic, name]) => [topic, WITNESS_NAME.exec(name)?.[1]])).toStrictEqual(
      PRODUCERS.flatMap((producer) => WITNESSED[producer] ?? []).map((topic) => [topic, topic]),
    );
    expect(broker.witnesses()).toStrictEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    for (const name of HELD) {
      const entry = broker.sub(name);
      expect(entry.subscription.modifyPushConfig.mock.calls).toStrictEqual([[{}], [entry.saved]]);
      expect(entry.push).toStrictEqual(entry.saved);
      expect(entry.queue).toStrictEqual([]);
      expect(entry.leased.size).toBe(0);
      expect(entry.released).toStrictEqual([]);
    }
    expect(broker.sub(STUB_NOTE).subscription.modifyPushConfig).not.toHaveBeenCalled();
    expect(broker.sub(PEOPLE_GROUP).acked).toStrictEqual([eventId(1), eventId(2)]);
    expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
    expect(broker.leases.every((lease) => vi.mocked(lease.close).mock.calls.length === 1)).toBe(true);
    expect(JSON.stringify(output)).not.toContain(PUSH_KEY);
    expect(vi.mocked(ctx.owners.position).mock.calls.map(([owner]) => owner)).toStrictEqual([
      ...Object.keys(INBOX_TOTALS),
      ...Object.keys(INBOX_TOTALS),
    ]);
    expect(envOf.mock.calls.map(([name]) => name)).toStrictEqual([...PRODUCERS]);
    expect(vi.mocked(spawnChild).mock.calls).toStrictEqual(
      PRODUCERS.map((producer) => [
        process.execPath,
        [outboxCliPath(), 'replay', '--since', since],
        { env: envOf.mock.results[PRODUCERS.indexOf(producer)]?.value, timeoutMs: 120_000 },
      ]),
    );
    expect(awaitDrained).toHaveBeenCalledExactlyOnceWith(ctx, { timeoutMs: 120_000 });
    expect(createApplyTenantResolver).toHaveBeenCalledExactlyOnceWith(ctx, { database: SNAPSHOT_DB });
    expect(vi.mocked(describeUnitTable).mock.calls.map(([, options]) => options)).toStrictEqual(
      TABLES.filter((entry) => entry.migratable).map(({ unit, legacyTable }) => ({ unit, legacyTable, database: SNAPSHOT_DB })),
    );
    expect(vi.mocked(readTargetUnitRows).mock.calls.every(([, , , options]) => options?.includeObjects === false)).toBe(true);
    expect(disposed).toBe(2 * KEYS_PER_CAPTURE);
  });

  it('posts each copy to the saved endpoint, key included, as the push wrapper of its pulled message', async () => {
    const { env } = envWith();
    await script.run(env, params({ producers: ['people'] }));

    expect(pushes).toHaveLength(1);
    const [call] = pushes;
    expect(call?.url).toBe(`${endpointOf(IDENTITY_PERSON)}?key=${PUSH_KEY}`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toStrictEqual({ 'content-type': 'application/json' });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.body).toStrictEqual({
      message: {
        data: Buffer.from(JSON.stringify({ eventId: eventId(3), tenantId: TENANT_A }), 'utf8').toString('base64'),
        attributes: { eventId: eventId(3), tenantId: TENANT_A },
        messageId: 'm-1',
        message_id: 'm-1',
        publishTime: PUBLISH_TIME,
        publish_time: PUBLISH_TIME,
        orderingKey: 'person-3',
      },
      subscription: fullName(IDENTITY_PERSON),
      deliveryAttempt: 1,
    });
  });

  it('captures the after-checksums only once the delayed consumer answers have arrived', async () => {
    answer = async (call) => {
      timeline.push(`received:${call.eventId}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(null, { status: 204 });
    };
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.filter((assertion) => assertion.status !== 'pass')).toStrictEqual([]);
    const lastAnswer = timeline.findLastIndex((entry) => entry.startsWith('answered:'));
    const afterChecksums = timeline.slice(lastAnswer + 1);
    expect(timeline.slice(0, KEYS_PER_CAPTURE)).toStrictEqual(Array.from({ length: KEYS_PER_CAPTURE }, () => 'checksum'));
    expect(timeline.indexOf('replay:programs-sites')).toBeLessThan(timeline.indexOf('received:' + eventId(1)));
    expect(afterChecksums).toStrictEqual(['drained', ...Array.from({ length: KEYS_PER_CAPTURE }, () => 'checksum')]);
    expect(timeline.filter((entry) => entry.startsWith('answered:'))).toHaveLength(6);
  });

  it('uses the given since and producers', async () => {
    const { env, envOf } = envWith();
    const since = '2026-06-30T09:30:00+02:00';
    const output = await script.run(env, params({ producers: ['people'], since, drainTimeoutMs: 5000 }));

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(envOf).toHaveBeenCalledExactlyOnceWith('people');
    expect(vi.mocked(spawnChild).mock.calls[0]?.[1]).toStrictEqual([outboxCliPath(), 'replay', '--since', since]);
    expect(vi.mocked(spawnChild).mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5000 });
    expect(output.assertions.slice(0, 2)).toStrictEqual(replayedAndObserved('people', since));
    expect(awaitDrained).toHaveBeenCalledWith(env.ctx, { timeoutMs: 5000 });
  });

  it('takes the latest snapshot itself as the earliest when no lower sequence exists', async () => {
    vi.mocked(getSnapshot).mockResolvedValue(null);
    const { env } = envWith();
    const output = await script.run(env, params({ producers: ['identity'] }));

    expect(vi.mocked(getSnapshot).mock.calls.map(([, seq]) => seq)).toStrictEqual([0, 1, 2]);
    expect(output.details).toMatchObject({ since: NOW.toISOString() });
  });

  it('fails without a snapshot before replaying or reading anything', async () => {
    vi.mocked(latestSnapshot).mockResolvedValue(null);
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions).toStrictEqual([
      { name: 'replayed', status: 'fail', detail: 'no snapshot', reason: 'take S0 and backfill before this fault' },
    ]);
    expect(spawnChild).not.toHaveBeenCalled();
    expect(readTargetUnitRows).not.toHaveBeenCalled();
    expect(awaitDrained).not.toHaveBeenCalled();
  });

  it('fails replayed:<producer> on a zero count and still checks the rest, its topics expecting no copy', async () => {
    vi.mocked(spawnChild).mockResolvedValueOnce(outcome(0, summaryLine(0)));
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.slice(0, 2)).toStrictEqual([
      {
        name: 'replayed:identity',
        status: 'fail',
        detail: { republished: 0, since: S1_TAKEN.toISOString() },
        reason: `no outbox rows since ${S1_TAKEN.toISOString()}; backfill emits state events — check \`since\``,
      },
      { name: 'observed:identity', status: 'pass', detail: { replayed: 0, topics: { [GROUP_CHANGED]: 0, [LOGIN_MAIL]: 0 } } },
    ]);
    expect(output.assertions.slice(2).map((assertion) => [assertion.name, assertion.status])).toStrictEqual([
      ['replayed:people', 'pass'],
      ['observed:people', 'pass'],
      ['replayed:programs-sites', 'pass'],
      ['observed:programs-sites', 'pass'],
      ...HELD.map((name) => [`redelivered:${name}`, 'pass']),
      ['inbox-unchanged', 'pass'],
      ['drained', 'pass'],
      ['aggregates-unchanged', 'pass'],
      ['projections-unchanged', 'pass'],
    ]);
    expect(output.assertions.find((assertion) => assertion.name === `redelivered:${PEOPLE_GROUP}`)?.detail).toStrictEqual({
      endpoint: endpointOf(PEOPLE_GROUP),
      expected: 0,
      delivered: 0,
      statuses: {},
    });
    expect(output.details).toMatchObject({ republished: { ...REPUBLISHED, identity: 0 } });
  });

  it.each([
    {
      title: 'a non-zero exit',
      child: outcome(1, summaryLine(2), 'row failed'),
      expected: { status: 'fail', detail: { exitCode: 1, signal: null, timedOut: false, republished: 2, stderrTail: 'row failed' } },
      republished: 2,
    },
    {
      title: 'an exit 0 without a summary line',
      child: outcome(0, 'not json\n'),
      expected: { status: 'fail', detail: { exitCode: 0, signal: null, timedOut: false, republished: undefined, stderrTail: '' } },
      republished: null,
    },
    {
      title: 'a timed-out child',
      child: { exitCode: null, signal: 'SIGTERM' as const, timedOut: true, stdoutTail: '', stderrTail: 'stalled' },
      expected: { status: 'fail', detail: { exitCode: null, signal: 'SIGTERM', timedOut: true, republished: undefined, stderrTail: 'stalled' } },
      republished: null,
    },
  ])('fails replayed and observed:<producer> on $title, replays the rest, and pushes nothing without a bounded replayed set', async ({ child, expected, republished }) => {
    vi.mocked(spawnChild).mockImplementationOnce(async (...args) => {
      // The rows are published, but the child's outcome gives no bound on them.
      await replayChild(...args);
      return child;
    });
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions).toStrictEqual([
      { name: 'replayed:identity', ...expected },
      {
        name: 'observed:identity',
        status: 'fail',
        detail: { replayed: null },
        reason: 'the replay did not exit 0 with its published count, so its replayed set cannot be bounded',
      },
      ...replayedAndObserved('people'),
      ...replayedAndObserved('programs-sites'),
      ...['redelivered', 'inbox-unchanged', 'drained', 'aggregates-unchanged', 'projections-unchanged'].map((name) => ({
        name,
        status: 'skipped',
        reason: 'replayed set not established',
      })),
    ]);
    expect(output.details).toMatchObject({ republished: { ...REPUBLISHED, identity: republished } });
    expect(fetchDouble).not.toHaveBeenCalled();
    expect(awaitDrained).not.toHaveBeenCalled();
    expect(readTargetUnitRows).toHaveBeenCalledTimes(KEYS_PER_CAPTURE);
    expect(broker.witnesses()).toStrictEqual([]);
    for (const name of HELD) expect(broker.sub(name).push).toStrictEqual(broker.sub(name).saved);
  });

  it('fails drained on a drain timeout and skips the after-checks', async () => {
    const undrained = { counts: counts('timesheets', 4), role: { producer: true, consumer: true } };
    vi.mocked(awaitDrained).mockRejectedValue(new DrainTimeoutError(120_000, [undrained]));
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.slice(-3)).toStrictEqual([
      { name: 'drained', status: 'fail', detail: [counts('timesheets', 4)] },
      { name: 'aggregates-unchanged', status: 'skipped', reason: 'drain did not complete' },
      { name: 'projections-unchanged', status: 'skipped', reason: 'drain did not complete' },
    ]);
    expect(readTargetUnitRows).toHaveBeenCalledTimes(KEYS_PER_CAPTURE);
  });

  it('propagates a drain failure other than a timeout', async () => {
    vi.mocked(awaitDrained).mockRejectedValue(new Error('pubsub unavailable'));
    const { env } = envWith();
    await expect(script.run(env, params())).rejects.toThrow('pubsub unavailable');
  });

  it.each([
    {
      title: 'a changed row',
      mutate: () => targetData.set(`people.person|dbo.tusers|${TENANT_A}`, [{ ID: 'u1', Name: 'Ada' }, { ID: 'u2', Name: 'Hopper' }]),
      differing: [`people|people.person|dbo.tusers|${TENANT_A}`],
    },
    {
      title: 'a row appearing in an empty tenant',
      mutate: () => targetData.set(`identity.user_account|dbo.tusers|${TENANT_B}`, [{ ID: 'u9', Name: 'late' }]),
      differing: [`identity|identity.user_account|dbo.tusers|${TENANT_B}`],
    },
  ])('fails aggregates-unchanged on $title during the replay', async ({ mutate, differing }) => {
    vi.mocked(spawnChild).mockImplementationOnce(async (...args) => {
      mutate();
      return replayChild(...args);
    });
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.find((assertion) => assertion.name === 'aggregates-unchanged')).toStrictEqual({
      name: 'aggregates-unchanged',
      status: 'fail',
      detail: { differingCount: 1, differing },
    });
  });

  it('caps the listed differing keys at 50 and counts them all', async () => {
    const many = Array.from({ length: 60 }, (_, index) => `00000000-0000-5000-8000-${String(index).padStart(12, '0')}`);
    vi.mocked(createApplyTenantResolver).mockResolvedValue({ resolve: vi.fn(), siteTenants: () => many });
    vi.mocked(spawnChild).mockImplementationOnce(async (...args) => {
      for (const tenant of many) targetData.set(`programs_sites.site|dbo.tsettings|${tenant}`, [{ ID: tenant, Name: 'new' }]);
      return replayChild(...args);
    });
    const { env } = envWith();
    const output = await script.run(env, params());
    const assertion = output.assertions.find((entry) => entry.name === 'aggregates-unchanged');

    expect(assertion?.status).toBe('fail');
    expect(assertion?.detail).toMatchObject({ differingCount: 60 });
    expect((assertion?.detail as { differing: string[] }).differing).toHaveLength(50);
  });

  it('fails projections-unchanged for owners with pending receipts', async () => {
    vi.mocked(awaitDrained).mockResolvedValue(drained([counts('identity'), counts('timesheets', 2)]));
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.at(-1)).toStrictEqual({ name: 'projections-unchanged', status: 'fail', detail: [counts('timesheets', 2)] });
  });

  it('skips projections-unchanged when the drain checked no owner', async () => {
    vi.mocked(awaitDrained).mockResolvedValue(drained([]));
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(output.assertions.at(-1)).toStrictEqual({
      name: 'projections-unchanged',
      status: 'skipped',
      reason: 'position response reports no receipt counters',
    });
  });

  it('leaves fixture tables out of the checksums while the fixtures are unavailable', async () => {
    vi.mocked(readFixtureStatus).mockResolvedValue({ available: false, reason: 'no CREATE SCHEMA', checkedAt: NOW.toISOString() });
    const { env } = envWith();
    const output = await script.run(env, params());

    expect(vi.mocked(describeUnitTable).mock.calls.map(([, options]) => options.legacyTable)).not.toContain('synthetic.person_archive');
    expect(output.details).toMatchObject({ skippedTables: ['people.person_archive|synthetic.person_archive'], checksumKeys: 6 });
  });

  it('skips reading the fixture status when the ownership file lists no fixture table', async () => {
    vi.mocked(fixtureTables).mockResolvedValue(new Set());
    const { env } = envWith();
    await script.run(env, params());

    expect(readFixtureStatus).not.toHaveBeenCalled();
  });

  it('propagates a failed checksum read after disposing the rows', async () => {
    const shape = shapeOf('identity.user_account', 'dbo.tusers', 'identity');
    vi.mocked(readTargetUnitRows).mockResolvedValueOnce({
      // Out of key order, which the checksum's diff rejects.
      rows: [toUnitRow(shape, { ID: 'u1', Name: 'x' }), toUnitRow(shape, { ID: 'u0', Name: 'y' })],
      count: 2,
      objects: null,
      dispose: async () => {
        disposed += 1;
      },
    });
    const { env } = envWith();

    await expect(script.run(env, params())).rejects.toThrow();
    expect(disposed).toBe(1);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  describe('redelivery barrier', () => {
    const AFTER_CHECKS = ['inbox-unchanged', 'drained', 'aggregates-unchanged', 'projections-unchanged'];
    const BUDGET_REASON = 'the budget ran out before every replayed copy was answered 2xx and the queue was empty';

    function expectAllRestored(): void {
      for (const { consumer, topic } of SUBSCRIPTIONS) {
        const entry = broker.sub(subscriptionName(consumer, topic));
        expect(entry.push).toStrictEqual(entry.saved);
      }
    }

    /** Makes every lease on a consumer subscription fail with `error`, leaving the witnesses' leases working. */
    function failDeliveryLeases(error: Error): void {
      const lease = broker.pubsub.leaseMessages.getMockImplementation();
      broker.pubsub.leaseMessages.mockImplementation(async (full: string) => {
        if (!full.includes(WITNESS_PREFIX)) throw error;
        return lease?.(full) as Promise<MessageLease>;
      });
    }

    /** Makes `reveal` run once the stepping clock has passed `afterMs` from the start; never when `afterMs` is undefined. */
    function revealAfter(env: FaultEnv, advance: (ms: number) => void, sleep: ReturnType<typeof envWith>['sleep'], afterMs: number | undefined, reveal: () => void): void {
      sleep.mockImplementation(async (ms: number) => {
        advance(ms);
        if (afterMs !== undefined && env.clock.now().getTime() >= NOW.getTime() + afterMs) reveal();
      });
    }

    it.each([
      { kind: 'a 503 answer', respond: async () => new Response('busy', { status: 503 }), label: '503' },
      {
        kind: 'a network error',
        respond: async (): Promise<Response> => {
          throw new TypeError(`fetch failed: ${endpointOf(TIMESHEETS_SITE)}?key=${PUSH_KEY}`);
        },
        label: 'network',
      },
      {
        kind: 'a timeout',
        respond: async (): Promise<Response> => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        label: 'timeout',
      },
    ])('fails redelivered:<subscription> once the budget ends with every push meeting $kind, releasing each copy', async ({ respond, label }) => {
      answer = async (call) => {
        if (!call.url.startsWith(endpointOf(TIMESHEETS_SITE))) return new Response(null, { status: 204 });
        // Answered after the other subscriptions completed, which share the stepping clock.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return respond();
      };
      const { env, sleep, ctx } = envWith();
      const output = await script.run(env, params({ drainTimeoutMs: 5000 }));

      expect(output.assertions.filter((assertion) => assertion.name.startsWith('redelivered:'))).toStrictEqual([
        redelivered(IDENTITY_PERSON, 1),
        redelivered(PEOPLE_GROUP, 2),
        redelivered(CONTENT_GROUP, 2),
        {
          name: `redelivered:${TIMESHEETS_SITE}`,
          status: 'fail',
          detail: {
            endpoint: endpointOf(TIMESHEETS_SITE),
            expected: 1,
            delivered: 0,
            statuses: { [label]: 5 },
            unprovenCount: 1,
            unproven: [eventId(4)],
          },
          reason: BUDGET_REASON,
        },
      ]);
      expect(output.assertions.slice(-4)).toStrictEqual(
        AFTER_CHECKS.map((name) => ({ name, status: 'skipped', reason: 'replayed copies not confirmed processed' })),
      );
      expect(broker.sub(TIMESHEETS_SITE).released).toStrictEqual(Array.from({ length: 5 }, () => eventId(4)));
      expect(broker.sub(TIMESHEETS_SITE).acked).toStrictEqual([]);
      expect(sleep.mock.calls).toStrictEqual(Array.from({ length: 5 }, () => [1000]));
      expect(awaitDrained).not.toHaveBeenCalled();
      expect(readTargetUnitRows).toHaveBeenCalledTimes(KEYS_PER_CAPTURE);
      expect(ctx.owners.position).toHaveBeenCalledTimes(Object.keys(INBOX_TOTALS).length);
      expect(JSON.stringify(output)).not.toContain(PUSH_KEY);
      expectAllRestored();
    });

    it.each([
      { title: 'an ordered subscription keeps the key order', name: PEOPLE_GROUP, pushed: [1, 1, 2], released: [1, 2] },
      { title: 'an unordered subscription pushes the rest', name: CONTENT_GROUP, pushed: [1, 2, 1], released: [1] },
    ])('releases a copy answered 503 and passes once its redelivery is answered 204: $title', async ({ name, pushed, released }) => {
      let refused = false;
      answer = async (call) => {
        if (refused || !call.url.startsWith(endpointOf(name))) return new Response(null, { status: 204 });
        refused = true;
        return new Response(null, { status: 503 });
      };
      const { env } = envWith();
      const output = await script.run(env, params({ producers: ['identity'] }));

      expect(output.assertions.find((assertion) => assertion.name === `redelivered:${name}`)).toStrictEqual({
        name: `redelivered:${name}`,
        status: 'pass',
        detail: { endpoint: endpointOf(name), expected: 2, delivered: 2, statuses: { 503: 1, 204: 2 } },
      });
      expect(pushes.filter((call) => call.url.startsWith(endpointOf(name))).map((call) => call.eventId)).toStrictEqual(pushed.map(eventId));
      expect(broker.sub(name).released).toStrictEqual(released.map(eventId));
      expect(output.assertions.every((assertion) => assertion.status === 'pass')).toBe(true);
    });

    it('stops pushing once the budget passes mid-batch and releases the unpushed copy', async () => {
      const { env, advance } = envWith();
      answer = async (call) => {
        if (call.url.startsWith(endpointOf(PEOPLE_GROUP))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          advance(5000);
        }
        return new Response(null, { status: 204 });
      };
      const output = await script.run(env, params({ producers: ['identity'], drainTimeoutMs: 5000 }));

      expect(output.assertions.find((assertion) => assertion.name === `redelivered:${PEOPLE_GROUP}`)).toStrictEqual({
        name: `redelivered:${PEOPLE_GROUP}`,
        status: 'fail',
        detail: { endpoint: endpointOf(PEOPLE_GROUP), expected: 2, delivered: 1, statuses: { 204: 1 }, unprovenCount: 1, unproven: [eventId(2)] },
        reason: BUDGET_REASON,
      });
      expect(pushes.filter((call) => call.url.startsWith(endpointOf(PEOPLE_GROUP))).map((call) => call.eventId)).toStrictEqual([eventId(1)]);
      expect(broker.sub(PEOPLE_GROUP).released).toStrictEqual([eventId(2)]);
      expectAllRestored();
    });

    it.each([
      { title: 'no producer replays a row', rows: {} as Record<string, { topic: string; id: number }[]> },
      { title: 'the replays reach only topics without a consumer', rows: { identity: [{ topic: LOGIN_MAIL, id: 5 }], people: [{ topic: PERSON_ARCHIVED, id: 6 }] } },
    ])('fails redelivered as not exercised when $title, without pushing', async ({ rows }) => {
      vi.mocked(spawnChild).mockImplementation(async (_command, _args, options) => {
        const own = rows[String(options.env.OPT2_SERVICE_NAME)] ?? [];
        for (const row of own) broker.publish(row.topic, eventId(row.id), `key-${String(row.id)}`);
        return outcome(0, summaryLine(own.length));
      });
      const { env } = envWith();
      const output = await script.run(env, params());

      expect(output.assertions.filter((assertion) => assertion.name.startsWith('observed:')).map((assertion) => assertion.status)).toStrictEqual([
        'pass',
        'pass',
        'pass',
      ]);
      expect(output.assertions.slice(6)).toStrictEqual([
        {
          name: 'redelivered',
          status: 'fail',
          detail: { subscriptions: 4, expected: 0 },
          reason: 'no replayed copy reached a consumer subscription of the replayed topics',
        },
        ...AFTER_CHECKS.map((name) => ({ name, status: 'skipped', reason: 'redelivery not exercised' })),
      ]);
      expect(fetchDouble).not.toHaveBeenCalled();
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
    });

    it.each([
      { title: 'some copies of one subscription and all copies of another', withheld: { [PEOPLE_GROUP]: 1, [CONTENT_GROUP]: 2 }, copies: 3 },
      { title: 'all copies of one subscription', withheld: { [CONTENT_GROUP]: 2 }, copies: 2 },
    ])('waits for $title that become pullable only later, and captures the after-checksums once they are answered', async ({ withheld, copies }) => {
      let late: ReturnType<typeof withhold> | undefined;
      vi.mocked(spawnChild).mockImplementation(async (...args) => {
        const result = await replayChild(...args);
        // A published copy need not be pullable at once from every subscription.
        late = withhold(withheld);
        return result;
      });
      const { env, advance, sleep } = envWith();
      revealAfter(env, advance, sleep, 3000, () => late?.reveal());
      const output = await script.run(env, params({ producers: ['identity'] }));

      expect(late?.copies).toBe(copies);
      expect(output.assertions).toStrictEqual([
        ...replayedAndObserved('identity'),
        redelivered(PEOPLE_GROUP, 2),
        redelivered(CONTENT_GROUP, 2),
        { name: 'inbox-unchanged', status: 'pass', detail: { totals: { people: 20, 'strategies-content': 30 } } },
        { name: 'drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } },
        { name: 'aggregates-unchanged', status: 'pass', detail: { keys: KEYS_PER_CAPTURE } },
        { name: 'projections-unchanged', status: 'pass', detail: { owners: 3 } },
      ]);
      expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(3);
      const lastAnswer = timeline.findLastIndex((entry) => entry.startsWith('answered:'));
      expect(timeline.slice(lastAnswer + 1)).toStrictEqual(['drained', ...Array.from({ length: KEYS_PER_CAPTURE }, () => 'checksum')]);
      expect(pushes.filter((call) => call.url.startsWith(endpointOf(CONTENT_GROUP))).map((call) => call.eventId)).toStrictEqual([eventId(1), eventId(2)]);
      expect(broker.sub(PEOPLE_GROUP).acked).toStrictEqual([eventId(1), eventId(2)]);
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
    });

    it('fails redelivered:<subscription> at the budget when withheld copies never become pullable, and skips the after-checks', async () => {
      vi.mocked(spawnChild).mockImplementation(async (...args) => {
        const result = await replayChild(...args);
        withhold({ [PEOPLE_GROUP]: 1, [CONTENT_GROUP]: 2 });
        return result;
      });
      const { env, ctx } = envWith();
      const output = await script.run(env, params({ producers: ['identity'], drainTimeoutMs: 5000 }));

      expect(output.assertions).toStrictEqual([
        ...replayedAndObserved('identity'),
        {
          name: `redelivered:${PEOPLE_GROUP}`,
          status: 'fail',
          detail: { endpoint: endpointOf(PEOPLE_GROUP), expected: 2, delivered: 1, statuses: { 204: 1 }, unprovenCount: 1, unproven: [eventId(2)] },
          reason: BUDGET_REASON,
        },
        {
          name: `redelivered:${CONTENT_GROUP}`,
          status: 'fail',
          detail: { endpoint: endpointOf(CONTENT_GROUP), expected: 2, delivered: 0, statuses: {}, unprovenCount: 2, unproven: [eventId(1), eventId(2)] },
          reason: BUDGET_REASON,
        },
        ...AFTER_CHECKS.map((name) => ({ name, status: 'skipped', reason: 'replayed copies not confirmed processed' })),
      ]);
      expect(awaitDrained).not.toHaveBeenCalled();
      expect(readTargetUnitRows).toHaveBeenCalledTimes(KEYS_PER_CAPTURE);
      expect(ctx.owners.position).toHaveBeenCalledTimes(2);
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
    });

    it.each([
      { title: 'arrive only later', afterMs: 3000, status: 'pass' },
      { title: 'never arrive', afterMs: undefined, status: 'fail' },
    ])('waits on the witness for replayed copies that $title, and pushes only a fully observed set', async ({ afterMs, status }) => {
      let late: ReturnType<typeof withhold> | undefined;
      const witnessOf = (topic: string): string => broker.witnessed.find(([watched]) => watched === topic)?.[1] ?? '';
      vi.mocked(spawnChild).mockImplementation(async (...args) => {
        const result = await replayChild(...args);
        late = withhold({ [witnessOf(GROUP_CHANGED)]: 1, [witnessOf(LOGIN_MAIL)]: 1 });
        return result;
      });
      const { env, advance, sleep } = envWith();
      revealAfter(env, advance, sleep, afterMs, () => late?.reveal());
      const output = await script.run(env, params({ producers: ['identity'], drainTimeoutMs: 5000 }));

      expect(late?.copies).toBe(2);
      if (status === 'pass') {
        expect(output.assertions.map((assertion) => assertion.status).every((outcome) => outcome === 'pass')).toBe(true);
        expect(output.assertions[1]).toStrictEqual(observed('identity'));
        expect(fetchDouble).toHaveBeenCalledTimes(4);
      } else {
        expect(output.assertions).toStrictEqual([
          replayedAndObserved('identity')[0],
          {
            name: 'observed:identity',
            status: 'fail',
            detail: { replayed: 3, observed: 1, topics: { [GROUP_CHANGED]: 1, [LOGIN_MAIL]: 0 } },
            reason: 'replayed set not fully observed: the witnesses received fewer distinct event ids than the replay published',
          },
          ...['redelivered', ...AFTER_CHECKS].map((name) => ({ name, status: 'skipped', reason: 'replayed set not established' })),
        ]);
        expect(sleep.mock.calls).toStrictEqual(Array.from({ length: 5 }, () => [1000]));
        expect(fetchDouble).not.toHaveBeenCalled();
      }
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
    });

    it.each([
      { title: 'an event the replay did not count', unidentified: false, detail: { replayed: 3, observed: 4, unidentified: 0, topics: { [GROUP_CHANGED]: 3, [LOGIN_MAIL]: 1 } } },
      { title: 'a message without an event id', unidentified: true, detail: { replayed: 3, observed: 3, unidentified: 1, topics: { [GROUP_CHANGED]: 2, [LOGIN_MAIL]: 1 } } },
    ])('fails observed:<producer> as not quiesced when a witness receives $title, and pushes nothing', async ({ unidentified, detail }) => {
      vi.mocked(spawnChild).mockImplementation(async (...args) => {
        const result = await replayChild(...args);
        broker.publish(GROUP_CHANGED, eventId(9), 'group-9', unidentified);
        return result;
      });
      const { env } = envWith();
      const output = await script.run(env, params({ producers: ['identity'] }));

      expect(output.assertions).toStrictEqual([
        replayedAndObserved('identity')[0],
        { name: 'observed:identity', status: 'fail', detail, reason: 'the producer published events besides the replay during the fault; it is not quiesced' },
        ...['redelivered', ...AFTER_CHECKS].map((name) => ({ name, status: 'skipped', reason: 'replayed set not established' })),
      ]);
      expect(fetchDouble).not.toHaveBeenCalled();
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
    });

    it('deletes the witnesses created before a failed witness creation, restores push delivery, and propagates without replaying', async () => {
      const failure = new Error('7 PERMISSION_DENIED: create subscription');
      const create = broker.pubsub.createWitness.getMockImplementation();
      broker.pubsub.createWitness.mockImplementation(async (topic: string, name: string) => {
        if (topic === LOGIN_MAIL) throw failure;
        return create?.(topic, name);
      });
      const { env } = envWith();

      await expect(script.run(env, params())).rejects.toBe(failure);
      expect(broker.witnessed.map(([topic]) => topic)).toStrictEqual([GROUP_CHANGED]);
      expect(broker.witnesses()).toStrictEqual([]);
      expect(broker.pubsub.deleteSubscription.mock.calls.map(([name]) => WITNESS_NAME.exec(name)?.[1])).toStrictEqual([GROUP_CHANGED, LOGIN_MAIL]);
      expect(spawnChild).not.toHaveBeenCalled();
      expectAllRestored();
    });

    it.each([
      ['a replay child that throws', () => vi.mocked(spawnChild).mockRejectedValueOnce(new Error('spawn EACCES')), 'spawn EACCES'],
      [
        'a witness pull that throws',
        () => vi.mocked(broker.pubsub.leaseMessages).mockRejectedValueOnce(new Error('14 UNAVAILABLE: witness pull failed')),
        '14 UNAVAILABLE: witness pull failed',
      ],
    ])('deletes every witness, restores push delivery and propagates on %s', async (_title, inject, message) => {
      inject();
      const { env } = envWith();

      await expect(script.run(env, params())).rejects.toThrow(message);
      expect(broker.witnessed).toHaveLength(5);
      expect(broker.witnesses()).toStrictEqual([]);
      expectAllRestored();
      expect(awaitDrained).not.toHaveBeenCalled();
    });

    it('raises WitnessCleanupError after restoring push delivery when a witness is not deleted, and resume deletes it', async () => {
      vi.mocked(broker.pubsub.deleteSubscription).mockRejectedValueOnce(new Error('14 UNAVAILABLE: delete failed'));
      const { env } = envWith();

      const error = await script.run(env, params({ producers: ['identity'] })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WitnessCleanupError);
      const [left] = (error as WitnessCleanupError).subscriptions;
      expect(WITNESS_NAME.exec(left ?? '')?.[1]).toBe(GROUP_CHANGED);
      expect((error as Error).message).toContain('14 UNAVAILABLE: delete failed');
      expect(broker.witnesses()).toStrictEqual([left]);
      expectAllRestored();

      expect((await script.resume(env, params({ producers: ['identity'] }))).assertions[1]).toStrictEqual({
        name: 'resume-witnesses-deleted',
        status: 'pass',
        detail: { deleted: [left] },
      });
      expect(broker.witnesses()).toStrictEqual([]);
    });

    it('raises the delivery failure and the witness cleanup failure together', async () => {
      const deliveryFailure = new Error('14 UNAVAILABLE: pull failed');
      failDeliveryLeases(deliveryFailure);
      vi.mocked(broker.pubsub.deleteSubscription).mockRejectedValueOnce(new Error('14 UNAVAILABLE: delete failed'));
      const { env } = envWith();

      const error = await script.run(env, params({ producers: ['identity'] })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0]).toBe(deliveryFailure);
      expect((error as AggregateError).errors[1]).toBeInstanceOf(WitnessCleanupError);
      expect(broker.witnesses()).toHaveLength(1);
      expectAllRestored();
    });

    it('refuses before replaying when a replayed topic subscription is already in pull mode', async () => {
      broker.sub(PEOPLE_GROUP).push = null;
      const { env } = envWith();
      const output = await script.run(env, params());

      expect(output).toStrictEqual({
        assertions: [
          {
            name: 'redelivered',
            status: 'fail',
            detail: { inPullMode: [PEOPLE_GROUP] },
            reason: 'push delivery of the replayed topics is suspended; run `opt2-ops resume` before this fault',
          },
        ],
        details: { since: S1_TAKEN.toISOString(), producers: [...PRODUCERS] },
      });
      expect(spawnChild).not.toHaveBeenCalled();
      for (const { consumer, topic } of SUBSCRIPTIONS) {
        expect(broker.sub(subscriptionName(consumer, topic)).subscription.modifyPushConfig).not.toHaveBeenCalled();
      }
      expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
    });

    it('fails redelivered when no subscription is on a topic of the replayed producers', async () => {
      vi.spyOn(broker.pubsub, 'getSubscriptions').mockResolvedValue([[broker.sub(STUB_NOTE).subscription]]);
      const { env } = envWith();
      const output = await script.run(env, params());

      expect(output.assertions).toStrictEqual([
        { name: 'redelivered', status: 'fail', detail: { subscriptions: 0 }, reason: 'no consumer subscribes to a topic of the replayed producers' },
      ]);
      expect(spawnChild).not.toHaveBeenCalled();
    });

    it('restores every push config, deletes every witness and propagates when delivery throws', async () => {
      failDeliveryLeases(new Error('14 UNAVAILABLE: pull failed'));
      const { env } = envWith();

      await expect(script.run(env, params())).rejects.toThrow('14 UNAVAILABLE: pull failed');
      expectAllRestored();
      expect(broker.witnesses()).toStrictEqual([]);
      expect(broker.leases.every((lease) => vi.mocked(lease.close).mock.calls.length === 1)).toBe(true);
      expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
      expect(awaitDrained).not.toHaveBeenCalled();
    });

    it('restores the switched subscriptions and propagates when a switch to pull fails', async () => {
      const failure = new Error('9 FAILED_PRECONDITION: switch refused');
      vi.mocked(broker.sub(PEOPLE_GROUP).subscription.modifyPushConfig).mockRejectedValueOnce(failure);
      const { env } = envWith();

      await expect(script.run(env, params())).rejects.toBe(failure);
      expect(broker.sub(IDENTITY_PERSON).subscription.modifyPushConfig.mock.calls).toStrictEqual([[{}], [broker.sub(IDENTITY_PERSON).saved]]);
      expect(broker.sub(CONTENT_GROUP).subscription.modifyPushConfig).not.toHaveBeenCalled();
      expectAllRestored();
      expect(spawnChild).not.toHaveBeenCalled();
    });

    it.each([
      ['an Error', (endpoint: string) => new Error(`3 INVALID_ARGUMENT: Invalid push endpoint given (endpoint=${endpoint})`)],
      ['a string', (endpoint: string) => `rejected key=${PUSH_KEY} for ${endpoint}`],
    ])('raises PushRestoreError without the push key when a restore rejects with %s, and resume reports it', async (_label, rejection) => {
      const entry = broker.sub(TIMESHEETS_SITE);
      const apply = entry.subscription.modifyPushConfig.getMockImplementation();
      entry.subscription.modifyPushConfig.mockImplementation(async (config: SavedPushConfig) => {
        if (isPushConfig(config)) throw rejection(config.pushEndpoint);
        return apply?.(config);
      });
      const { env } = envWith();

      const error = await script.run(env, params()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PushRestoreError);
      expect((error as PushRestoreError).subscriptions).toStrictEqual([TIMESHEETS_SITE]);
      expect((error as Error).message).toContain(TIMESHEETS_SITE);
      expect((error as Error).message).not.toContain(PUSH_KEY);
      expect(broker.sub(PEOPLE_GROUP).push).toStrictEqual(broker.sub(PEOPLE_GROUP).saved);
      expect((await script.resume(env, params())).assertions[0]).toMatchObject({
        name: 'resume-push-restored',
        status: 'fail',
        detail: { inPullMode: [TIMESHEETS_SITE] },
      });
    });

    it('raises both errors together when delivery throws and a restore fails', async () => {
      const deliveryFailure = new Error('14 UNAVAILABLE: pull failed');
      failDeliveryLeases(deliveryFailure);
      vi.mocked(broker.sub(TIMESHEETS_SITE).subscription.modifyPushConfig).mockImplementation(async (config: SavedPushConfig) => {
        if (isPushConfig(config)) throw new Error(`endpoint=${config.pushEndpoint}`);
        broker.sub(TIMESHEETS_SITE).push = null;
        return [{}];
      });
      const { env } = envWith();

      const error = await script.run(env, params()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0]).toBe(deliveryFailure);
      expect((error as AggregateError).errors[1]).toBeInstanceOf(PushRestoreError);
      expect((error as Error).message).toContain(TIMESHEETS_SITE);
      expect((error as Error).message).not.toContain(PUSH_KEY);
    });

    it.each([
      {
        title: 'a copy applied again',
        setup: () => {
          const respond = answer;
          answer = async (call) => {
            if (call.url.startsWith(endpointOf(TIMESHEETS_SITE))) inbox.timesheets = (inbox.timesheets ?? 0) + 1;
            return respond(call);
          };
        },
        exclude: [] as string[],
        detail: { differing: [{ owner: 'timesheets', before: 40, after: 41 }], unchecked: [] },
      },
      {
        title: 'a consumer without an inbox',
        setup: () => {
          inbox.people = null;
        },
        exclude: [] as string[],
        detail: { differing: [{ owner: 'people', before: null, after: null }], unchecked: [] },
      },
      {
        title: 'a consumer that is no drain participant',
        setup: () => undefined,
        exclude: ['timesheets'],
        detail: { differing: [], unchecked: ['timesheets'] },
      },
    ])('fails inbox-unchanged on $title and still compares the aggregates', async ({ setup, exclude, detail }) => {
      setup();
      const ctx = ctxWith();
      (ctx.config as { dataOwners: string[] }).dataOwners = DATA_OWNERS.filter((owner) => !exclude.includes(owner));
      const { env } = envWith(ctx);
      const output = await script.run(env, params());

      expect(output.assertions.find((assertion) => assertion.name === 'inbox-unchanged')).toStrictEqual({ name: 'inbox-unchanged', status: 'fail', detail });
      expect(output.assertions.slice(-3).map((assertion) => assertion.status)).toStrictEqual(['pass', 'pass', 'pass']);
    });
  });

  describe('resume', () => {
    const NO_LEFTOVER = { name: 'resume-witnesses-deleted', status: 'pass', detail: { deleted: [] } };
    it('passes once push delivery is in place and the consumers have drained', async () => {
      const { env } = envWith();
      await expect(script.resume(env, params({ drainTimeoutMs: 9000 }))).resolves.toStrictEqual({
        steps: ['delete-witnesses', 'await-drained'],
        assertions: [
          { name: 'resume-push-restored', status: 'pass' },
          NO_LEFTOVER,
          { name: 'resume-drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } },
        ],
      });
      expect(awaitDrained).toHaveBeenCalledExactlyOnceWith(env.ctx, { timeoutMs: 9000 });
      expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
    });

    it('fails resume-push-restored for a replayed topic subscription left in pull mode, and still drains', async () => {
      broker.sub(CONTENT_GROUP).push = null;
      broker.sub(STUB_NOTE).push = null;
      const { env } = envWith();

      await expect(script.resume(env, params({ producers: ['identity'] }))).resolves.toStrictEqual({
        steps: ['delete-witnesses', 'await-drained'],
        assertions: [
          {
            name: 'resume-push-restored',
            status: 'fail',
            detail: { inPullMode: [CONTENT_GROUP] },
            reason: 'push delivery is not restored; re-apply it with `npm run topology -- --target local` in harness',
          },
          NO_LEFTOVER,
          { name: 'resume-drained', status: 'pass', detail: { polls: 2, elapsedMs: 1004 } },
        ],
      });
    });

    it('fails resume-drained on a drain timeout without throwing', async () => {
      const undrained = { counts: counts('people', 1), role: { producer: true, consumer: true } };
      vi.mocked(awaitDrained).mockRejectedValue(new DrainTimeoutError(120_000, [undrained]));
      const { env } = envWith();

      await expect(script.resume(env, params())).resolves.toStrictEqual({
        steps: ['delete-witnesses', 'await-drained'],
        assertions: [
          { name: 'resume-push-restored', status: 'pass' },
          NO_LEFTOVER,
          { name: 'resume-drained', status: 'fail', detail: [counts('people', 1)] },
        ],
      });
    });

    it('propagates any other drain failure', async () => {
      vi.mocked(awaitDrained).mockRejectedValue(new Error('subscription missing'));
      const { env } = envWith();
      await expect(script.resume(env, params())).rejects.toThrow('subscription missing');
    });

    it('deletes every leftover witness of this fault, reports them, and leaves other subscriptions alone', async () => {
      const leftovers = [`${WITNESS_PREFIX}0badc0de.${GROUP_CHANGED}`, `${WITNESS_PREFIX}0badc0de.${PERSON_CHANGED}`];
      const foreign = [`witness_pubsub-redelivery-x_0badc0de.${GROUP_CHANGED}`, `witness_duplicate-batch_0badc0de.${GROUP_CHANGED}`];
      for (const name of [...leftovers, ...foreign]) broker.add(name, GROUP_CHANGED, false, {});
      const { env } = envWith();

      const output = await script.resume(env, params());

      expect(output.assertions[1]).toStrictEqual({ name: 'resume-witnesses-deleted', status: 'pass', detail: { deleted: leftovers } });
      expect(broker.pubsub.deleteSubscription.mock.calls.map(([name]) => name)).toStrictEqual(leftovers);
      for (const name of leftovers) expect(broker.sub(name)).toBeUndefined();
      for (const name of foreign) expect(broker.sub(name)).toBeDefined();
      expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
    });

    it('fails resume-witnesses-deleted naming a witness it could not delete, tries the rest, and still drains', async () => {
      const leftovers = [`${WITNESS_PREFIX}0badc0de.${GROUP_CHANGED}`, `${WITNESS_PREFIX}0badc0de.${LOGIN_MAIL}`];
      for (const name of leftovers) broker.add(name, GROUP_CHANGED, false, {});
      vi.mocked(broker.pubsub.deleteSubscription).mockRejectedValueOnce(new Error('7 PERMISSION_DENIED: delete'));
      const { env } = envWith();

      const output = await script.resume(env, params());

      expect(output.assertions[1]).toStrictEqual({
        name: 'resume-witnesses-deleted',
        status: 'fail',
        detail: { left: [leftovers[0]] },
        reason: `witness subscriptions not deleted: ${String(leftovers[0])}: Error: 7 PERMISSION_DENIED: delete`,
      });
      expect(broker.sub(leftovers[1] ?? '')).toBeUndefined();
      expect(output.assertions[2]).toMatchObject({ name: 'resume-drained', status: 'pass' });
    });

    it('propagates a failed subscription listing after closing its client', async () => {
      vi.spyOn(broker.pubsub, 'getSubscriptions').mockRejectedValueOnce(new Error('14 UNAVAILABLE'));
      const { env } = envWith();

      await expect(script.resume(env, params())).rejects.toThrow('14 UNAVAILABLE');
      expect(broker.pubsub.close).toHaveBeenCalledTimes(1);
      expect(awaitDrained).not.toHaveBeenCalled();
    });
  });
});
