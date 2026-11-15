// Unit tests for quiescence as `opt2-ops` composes it: the subscription seek, and drain-and-suspend then resume over the migration schema.
import { QUEUE_CONTROL_PREFIX, QUEUES, SITEMONITOR_QUEUE, outboxSweepQueue, queuesCreatedBy } from '@opt2/platform/tasks';
import { pgAvailable } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_KEY,
  DEFAULT_DRAIN_POLL_MS,
  MissingSubscriptionError,
  SeekVerificationError,
  awaitDrained,
  backgroundRecordSchema,
  createBackgroundState,
  defaultBackgroundRecord,
  drainAndSuspend,
  readPushConfig,
  resume,
  seekSubscriptions,
  type BackgroundRecord,
  type BackgroundStateApi,
  type PubSubLike,
  type SavedPushConfig,
  type SubscriptionLike,
} from '../../src/quiesce/index.js';
import { SCHEDULER_STATE_TABLE, SchedulerStateError, type PauseResult, type RestoreResult } from '../../src/scheduler/index.js';
import {
  MIGRATION_SCHEMA_SKIP_REASON,
  buildTestContext,
  withMigrationSchema,
  type MigrationSchemaHandle,
  type RoutedServiceCall,
  type TestContext,
} from '../helpers/context.js';
import { createMutableClock, testEnv } from '../helpers/env.js';
import { SITE_MONITOR_TASK } from '../helpers/fixtures.js';

const ENV = testEnv();
const PROJECT = ENV.GOOGLE_CLOUD_PROJECT;
const SUBSCRIPTION_PREFIX = `projects/${PROJECT}/subscriptions/`;
const ARCHIVED = 'timesheets.people.person.archived.v1';
const GROUP_CHANGED = 'people.identity.group.changed.v1';
const SITE_CHANGED = 'finance.programs-sites.site.changed.v1';
const DLQ_REPLAY = `${ARCHIVED}.dlq.replay`;
const FOREIGN = 'legacy-mail-queue';
const TO = '2026-06-30T10:00:00.000Z';
const TO_MS = Date.parse(TO);
const MINUTE_MS = 60_000;
const SURVEY_TASKS = ['opt2-survey-41-launch', 'opt2-survey-41-reminder-1'];

const endpoint = (name: string): string => `http://127.0.0.1:8100/internal/v1/events/${name}?key=unit-push-key`;
/** Push config as Pub/Sub reports it, with a null oneof member. */
const livePush = (name: string) => ({ pushEndpoint: endpoint(name), attributes: { 'x-goog-version': 'v1' }, oidcToken: null });
const PULL = { pushEndpoint: '', attributes: {}, oidcToken: null };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface FakeSubscriptionSpec {
  /** Push config as Pub/Sub reports it; one without a push endpoint is pull delivery. */
  push: unknown;
  ordered?: boolean;
  /** Publish times, in epoch ms, of the messages the subscription retains. */
  published?: number[];
  seekError?: Error;
}

/** In-memory Pub/Sub: a seek acknowledges the messages published before its time and redelivers the later ones. */
function fakePubSub(specs: Readonly<Record<string, FakeSubscriptionSpec>>, log?: TestContext['log']) {
  const entries = Object.entries(specs).map(([id, spec]) => {
    const state = { pushConfig: copy(spec.push), ackedBefore: Number.NEGATIVE_INFINITY, published: [...(spec.published ?? [])] };
    const subscription = {
      name: `${SUBSCRIPTION_PREFIX}${id}`,
      state,
      getMetadata: () =>
        Promise.resolve<[{ pushConfig: unknown; enableMessageOrdering: boolean }]>([
          { pushConfig: copy(state.pushConfig), enableMessageOrdering: spec.ordered === true },
        ]),
      modifyPushConfig: vi.fn((config: SavedPushConfig) => {
        log?.append('pubsub', 'modifyPushConfig', { id, config });
        state.pushConfig = copy(config);
        return Promise.resolve([{}]);
      }),
      seek: vi.fn((time: Date) => {
        if (spec.seekError !== undefined) return Promise.reject(spec.seekError);
        state.ackedBefore = time.getTime();
        return Promise.resolve([{}]);
      }),
    } satisfies SubscriptionLike & { state: unknown };
    return [id, subscription] as const;
  });
  const subscriptions = new Map(entries);
  const subscription = (id: string) => {
    const found = subscriptions.get(id);
    if (found === undefined) throw new Error(`No subscription ${id}`);
    return found;
  };
  const backlog = (id: string): number => {
    const { state } = subscription(id);
    return state.published.filter((at) => at >= state.ackedBefore).length;
  };
  const pubsub = {
    projectId: PROJECT,
    getSubscriptions: () => Promise.resolve<[SubscriptionLike[]]>([[...subscriptions.values()]]),
    subscription: (name: string): SubscriptionLike => subscription(name),
    close: vi.fn(() => Promise.resolve()),
    pullOnce: vi.fn((fullName: string) => Promise.resolve(Math.min(1, backlog(fullName.slice(SUBSCRIPTION_PREFIX.length))))),
  } satisfies PubSubLike;
  return {
    pubsub,
    subscription,
    backlog,
    publish(id: string, at: number): void {
      subscription(id).state.published.push(at);
    },
  };
}

/** A gRPC client error as `@google-cloud/pubsub` rejects with it. */
function grpcError(code: number): Error {
  return Object.assign(new Error(`${String(code)} seek refused`), { code });
}

type SeekContext = Parameters<typeof seekSubscriptions>[0];

function seekContext(env: SeekContext['env'] = ENV) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { ctx: { env, logger } as unknown as SeekContext, logger };
}

describe('seekSubscriptions', () => {
  it('seeks every OPT-2 subscription to the time in name order, then finds each backlog empty', async () => {
    const before = TO_MS - MINUTE_MS;
    const after = TO_MS + MINUTE_MS;
    const fake = fakePubSub({
      [GROUP_CHANGED]: { push: livePush(GROUP_CHANGED), published: [before] },
      [ARCHIVED]: { push: livePush(ARCHIVED), published: [before, before] },
      [SITE_CHANGED]: { push: PULL },
      [DLQ_REPLAY]: { push: PULL, published: [after] },
      [FOREIGN]: { push: PULL, published: [after] },
    });
    const { ctx, logger } = seekContext();

    const result = await seekSubscriptions(ctx, TO, { pubsub: fake.pubsub });

    const names = [SITE_CHANGED, GROUP_CHANGED, ARCHIVED];
    expect(result).toStrictEqual({ to: TO, subscriptions: names.map((name) => ({ name, sought: true, backlog: 0 })) });
    const seeks = names.map((name) => fake.subscription(name).seek);
    for (const seek of seeks) expect(seek).toHaveBeenCalledExactlyOnceWith(new Date(TO));
    const seekOrder = seeks.map((seek) => seek.mock.invocationCallOrder[0] ?? 0);
    expect(seekOrder).toStrictEqual([...seekOrder].sort((a, b) => a - b));
    expect(Math.max(...seekOrder)).toBeLessThan(fake.pubsub.pullOnce.mock.invocationCallOrder[0] ?? 0);
    expect(fake.pubsub.pullOnce.mock.calls).toStrictEqual(names.map((name) => [`${SUBSCRIPTION_PREFIX}${name}`]));
    expect(fake.subscription(DLQ_REPLAY).seek).not.toHaveBeenCalled();
    expect(fake.subscription(FOREIGN).seek).not.toHaveBeenCalled();
    expect(fake.backlog(DLQ_REPLAY)).toBe(1);
    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fake.pubsub.close).not.toHaveBeenCalled();
  });

  it.each([
    ['UNIMPLEMENTED', 12],
    ['FAILED_PRECONDITION', 9],
  ])('records the ordered-seek-unsupported fallback when the emulator refuses an ordered subscription with %s', async (_label, code) => {
    const fake = fakePubSub({
      [ARCHIVED]: { push: livePush(ARCHIVED), ordered: true, seekError: grpcError(code) },
      [GROUP_CHANGED]: { push: livePush(GROUP_CHANGED) },
    });

    const result = await seekSubscriptions(seekContext().ctx, TO, { pubsub: fake.pubsub });

    expect(result.subscriptions).toStrictEqual([
      { name: GROUP_CHANGED, sought: true, backlog: 0 },
      { name: ARCHIVED, sought: false, fallback: 'ordered-seek-unsupported', backlog: 0 },
    ]);
    expect(fake.pubsub.pullOnce).toHaveBeenCalledWith(`${SUBSCRIPTION_PREFIX}${ARCHIVED}`);
  });

  it.each([
    ['an unordered subscription', false, 12, ENV.PUBSUB_EMULATOR_HOST],
    ['an ordered subscription off the emulator', true, 12, undefined],
    ['another gRPC code', true, 5, ENV.PUBSUB_EMULATOR_HOST],
  ])('propagates the seek refusal of %s before peeking any backlog', async (_label, ordered, code, emulatorHost) => {
    const error = grpcError(code);
    const fake = fakePubSub({ [ARCHIVED]: { push: livePush(ARCHIVED), ordered, seekError: error } });

    const seek = seekSubscriptions(seekContext({ ...ENV, PUBSUB_EMULATOR_HOST: emulatorHost }).ctx, TO, { pubsub: fake.pubsub });

    await expect(seek).rejects.toBe(error);
    expect(fake.pubsub.pullOnce).not.toHaveBeenCalled();
  });

  it('throws SeekVerificationError naming each subscription that still delivers a message, after peeking them all', async () => {
    const fake = fakePubSub({
      [GROUP_CHANGED]: { push: livePush(GROUP_CHANGED), published: [TO_MS - MINUTE_MS] },
      [ARCHIVED]: { push: livePush(ARCHIVED), published: [TO_MS + 1000] },
      [SITE_CHANGED]: { push: PULL, published: [TO_MS - MINUTE_MS, TO_MS + 5 * MINUTE_MS] },
    });
    const { ctx, logger } = seekContext();

    const error = await seekSubscriptions(ctx, TO, { pubsub: fake.pubsub }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SeekVerificationError);
    expect(error).toMatchObject({ nonEmpty: [SITE_CHANGED, ARCHIVED] });
    expect(fake.pubsub.pullOnce).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.map((call: unknown[]) => call[1])).toStrictEqual([SITE_CHANGED, ARCHIVED]);
  });
});

const schemaAvailable = await pgAvailable();
const SERVICE_URLS = ENV.OPT2_SERVICE_URLS;
/** `<service> <queue>` of every registry queue each callee of the test env creates, sorted by service, then queue. */
const CREATED_QUEUES = Object.values(QUEUES)
  .flatMap(({ name, creators }) => creators.filter((service) => Object.hasOwn(SERVICE_URLS, service)).map((service) => `${service} ${name}`))
  .sort();
const QUEUE_CONTROL_PATH = new RegExp(`^${QUEUE_CONTROL_PREFIX}/([^/]+)/(pause|resume|ensure)$`);
const PAUSED: PauseResult = { siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_TASKS };
const RESTORED: RestoreResult = { siteMonitor: [SITE_MONITOR_TASK], surveys: SURVEY_TASKS };

const targetKey = ({ service, queue }: { service: string; queue: string }): string => `${service} ${queue}`;

/** Queue-control calls in order, as `<service> <queue>` and the operation. */
function queueOps(calls: readonly RoutedServiceCall[]): [string, string][] {
  return calls.flatMap((call) => {
    const match = QUEUE_CONTROL_PATH.exec(call.path);
    return match === null ? [] : [[`${call.service} ${match[1] ?? ''}`, match[2] ?? ''] as [string, string]];
  });
}

/** Latest queue-control operation of each queue. */
function lastOps(calls: readonly RoutedServiceCall[]): Record<string, string> {
  return Object.fromEntries(queueOps(calls));
}

/** Every doubled port of one drain-and-suspend and resume, with the subscriptions the drain barrier requires in push mode, except `ARCHIVED`. */
interface Cycle {
  t: TestContext;
  fake: ReturnType<typeof fakePubSub>;
  declared: string[];
  background: BackgroundStateApi;
  scheduler: { pauseAll: () => Promise<PauseResult>; restoreAll: () => Promise<RestoreResult> };
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  /** Saved form of every subscription's push config before the run; null for pull delivery. */
  before: Map<string, SavedPushConfig | null>;
}

async function cycle(): Promise<Cycle> {
  const t = await buildTestContext({ bridge: false, migrationDb: true, ownerNames: Object.keys(SERVICE_URLS) });
  try {
    return await cycleOver(t);
  } catch (error) {
    await t.close();
    throw error;
  }
}

async function cycleOver(t: TestContext): Promise<Cycle> {
  // On an empty project the barrier names every subscription the consumers' contracts declare.
  const probe = await awaitDrained(t.ctx, { timeoutMs: 0, pubsub: fakePubSub({}).pubsub }).catch((error: unknown) => error);
  if (!(probe instanceof MissingSubscriptionError)) throw new Error(`The drain probe answered ${String(probe)}`);
  const declared = [...probe.subscriptions].sort();
  const specs: Record<string, FakeSubscriptionSpec> = Object.fromEntries(
    declared.map((name) => [name, { push: name === ARCHIVED ? PULL : livePush(name) }]),
  );
  specs[DLQ_REPLAY] = { push: PULL, published: [t.clock.now().getTime() - MINUTE_MS] };
  specs[FOREIGN] = { push: livePush(FOREIGN) };
  const fake = fakePubSub(specs, t.log);
  const before = new Map(
    await Promise.all(Object.keys(specs).map(async (name) => [name, await readPushConfig(fake.subscription(name))] as const)),
  );

  const state = createBackgroundState(t.ctx);
  const background: BackgroundStateApi = {
    ...state,
    suspend(record: BackgroundRecord) {
      t.log.append('background', 'suspend');
      return state.suspend(record);
    },
  };
  const scheduler = {
    pauseAll: vi.fn(() => {
      t.log.append('scheduler', 'pauseAll');
      return Promise.resolve(copy(PAUSED));
    }),
    restoreAll: vi.fn(() => {
      t.log.append('scheduler', 'restoreAll');
      return Promise.resolve(copy(RESTORED));
    }),
  };
  const slept: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    slept.push(ms);
    t.clock.advance(ms);
    return Promise.resolve();
  };
  if (t.owners === null) throw new Error('The cycle needs the owner doubles');
  // People's first position answer still holds outbox rows, so the drain ensures its sweep and polls again.
  t.owners.owner('people').positionScript = (call) => (call === 1 ? { unpublished: 2, held: 1 } : {});
  return { t, fake, declared, background, scheduler, sleep, slept, before };
}

describe.skipIf(!schemaAvailable)(
  schemaAvailable ? 'drain-and-suspend, seek and resume' : `drain-and-suspend, seek and resume (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})`,
  () => {
    let c: Cycle;

    beforeEach(async () => {
      c = await cycle();
    });

    afterEach(async () => {
      await c?.t.close();
    });

    it('waits for the outbox, then leaves no queue, push subscription or ACF task able to run and records what it paused', async () => {
      const { t, fake, declared } = c;
      const start = t.clock.now().getTime();

      const result = await drainAndSuspend(t.ctx, { background: c.background, pubsub: fake.pubsub, scheduler: c.scheduler, sleep: c.sleep });

      expect(result.alreadySuspended).toBe(false);
      expect(result.drained.polls).toBe(2);
      expect(c.slept).toStrictEqual([DEFAULT_DRAIN_POLL_MS]);
      for (const drain of [result.drained, result.finalDrained]) {
        expect(drain.owners.filter(({ unpublished, held, pendingReceipts }) => unpublished + held + pendingReceipts > 0)).toStrictEqual([]);
      }
      const ops = queueOps(t.client.calls);
      expect(ops[0]).toStrictEqual([`people ${outboxSweepQueue('people')}`, 'ensure']);
      expect(ops.slice(1).every(([, op]) => op === 'pause')).toBe(true);

      expect(CREATED_QUEUES).toContain(`programs-sites ${SITEMONITOR_QUEUE}`);
      for (const service of Object.keys(SERVICE_URLS)) {
        for (const { name } of queuesCreatedBy(service)) expect(CREATED_QUEUES).toContain(`${service} ${name}`);
      }
      expect(lastOps(t.client.calls)).toStrictEqual(Object.fromEntries(CREATED_QUEUES.map((key) => [key, 'pause'])));

      const pushed = declared.filter((name) => name !== ARCHIVED);
      expect(result.switchedToPull).toStrictEqual(pushed);
      for (const name of declared) {
        await expect(readPushConfig(fake.subscription(name))).resolves.toBeNull();
        if (name !== ARCHIVED) expect(fake.subscription(name).modifyPushConfig).toHaveBeenCalledExactlyOnceWith({});
      }
      for (const name of [ARCHIVED, DLQ_REPLAY, FOREIGN]) expect(fake.subscription(name).modifyPushConfig).not.toHaveBeenCalled();
      expect(c.scheduler.pauseAll).toHaveBeenCalledOnce();

      const stored = await c.background.get();
      expect(stored).toStrictEqual({
        suspended: true,
        since: new Date(start + DEFAULT_DRAIN_POLL_MS).toISOString(),
        reason: 'drain-and-suspend',
        pushConfigs: Object.fromEntries(pushed.map((name) => [name, c.before.get(name)])),
        pausedQueues: CREATED_QUEUES.map((key) => {
          const [service = '', queue = ''] = key.split(' ');
          return { service, queue };
        }),
        pausedTasks: [SITE_MONITOR_TASK, ...SURVEY_TASKS].sort(),
      });
      expect(result.record).toStrictEqual({
        ...stored,
        pushConfigs: Object.fromEntries(pushed.map((name) => [name, { ...c.before.get(name), pushEndpoint: endpoint(name).split('?')[0] }])),
      });

      const order = t.log.entries.map(({ component, op }) => `${component} ${op}`);
      const first = (predicate: (entry: string) => boolean): number => order.findIndex(predicate);
      const last = (predicate: (entry: string) => boolean): number => order.findLastIndex(predicate);
      const isPause = (entry: string): boolean => entry.startsWith('client:') && entry.endsWith('/pause');
      const isSuspend = (entry: string): boolean => entry === 'background suspend';
      expect(order.filter(isSuspend)).toHaveLength(2);
      expect(first((entry) => entry.endsWith(' position'))).toBeLessThan(first(isSuspend));
      expect(first(isSuspend)).toBeLessThan(first((entry) => entry === 'scheduler pauseAll'));
      expect(first((entry) => entry === 'scheduler pauseAll')).toBeLessThan(first(isPause));
      expect(last(isPause)).toBeLessThan(first((entry) => entry === 'pubsub modifyPushConfig'));
      expect(last((entry) => entry === 'pubsub modifyPushConfig')).toBeLessThan(last(isSuspend));
    });

    it('seeks the suspended subscriptions, then resume restores exactly what was paused and clears the record', async () => {
      const { t, fake, declared } = c;
      await drainAndSuspend(t.ctx, { background: c.background, pubsub: fake.pubsub, scheduler: c.scheduler, sleep: c.sleep });
      // A message lands in pull mode before the reset point and must not survive the seek.
      fake.publish(GROUP_CHANGED, t.clock.now().getTime() + 1000);
      t.clock.advance(MINUTE_MS);
      const resetAt = t.clock.now().toISOString();
      expect(fake.backlog(GROUP_CHANGED)).toBe(1);

      const sought = await seekSubscriptions(t.ctx, resetAt, { pubsub: fake.pubsub });

      expect(sought.subscriptions).toStrictEqual(declared.map((name) => ({ name, sought: true, backlog: 0 })));
      expect(fake.backlog(DLQ_REPLAY)).toBe(1);

      const resumeFrom = t.client.calls.length;
      const logFrom = t.log.entries.length;
      const result = await resume(t.ctx, { background: c.background, pubsub: fake.pubsub, scheduler: c.scheduler });

      const pushed = declared.filter((name) => name !== ARCHIVED);
      expect(result.resumed).toBe(true);
      expect(result.restoredPush).toStrictEqual(pushed);
      for (const [name, saved] of c.before) {
        await expect(readPushConfig(fake.subscription(name))).resolves.toStrictEqual(saved);
      }
      for (const name of pushed) expect(fake.subscription(name).modifyPushConfig).toHaveBeenLastCalledWith(c.before.get(name));
      for (const name of [ARCHIVED, DLQ_REPLAY, FOREIGN]) expect(fake.subscription(name).modifyPushConfig).not.toHaveBeenCalled();

      const ops = queueOps(t.client.calls.slice(resumeFrom));
      expect(ops.filter(([, op]) => op === 'resume').map(([key]) => key)).toStrictEqual(CREATED_QUEUES);
      expect(result.resumedQueues.map(targetKey)).toStrictEqual(CREATED_QUEUES);
      const ensured = ops.filter(([, op]) => op === 'ensure').map(([key]) => key);
      expect(ensured.length).toBeGreaterThan(0);
      for (const key of ensured) {
        const queue = key.split(' ')[1] ?? '';
        expect(Object.values(QUEUES).find(({ name }) => name === queue)?.recurring).toBeDefined();
        expect(queue).not.toBe(SITEMONITOR_QUEUE);
      }
      expect(result.reconcile?.every(({ ok }) => ok)).toBe(true);
      expect(Object.values(lastOps(t.client.calls)).filter((op) => op === 'pause')).toStrictEqual([]);

      expect(c.scheduler.restoreAll).toHaveBeenCalledOnce();
      expect(result.restoredTasks).toStrictEqual(RESTORED);
      const resumeLog = t.log.entries.slice(logFrom).map(({ component, op }) => `${component} ${op}`);
      expect(resumeLog.findLastIndex((entry) => entry.startsWith('client:'))).toBeLessThan(resumeLog.indexOf('scheduler restoreAll'));

      const cleared = { ...defaultBackgroundRecord(), resumedAt: t.clock.now().toISOString() };
      expect(result.record).toStrictEqual(cleared);
      await expect(c.background.get()).resolves.toStrictEqual(cleared);

      const callsAfter = t.client.calls.length;
      const again = await resume(t.ctx, { background: c.background, pubsub: fake.pubsub, scheduler: c.scheduler });
      expect(again).toMatchObject({ resumed: false, restoredPush: [], resumedQueues: [], reconcile: null, restoredTasks: null });
      expect(t.client.calls).toHaveLength(callsAfter);
      expect(c.scheduler.restoreAll).toHaveBeenCalledOnce();
      expect(fake.pubsub.close).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(!schemaAvailable)(
  schemaAvailable ? 'createBackgroundState on the migration schema' : `createBackgroundState (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})`,
  () => {
    const clock = createMutableClock();
    let schema: MigrationSchemaHandle;
    let state: BackgroundStateApi;
    const RECORD: BackgroundRecord = {
      suspended: true,
      since: null,
      reason: 'golden capture',
      pushConfigs: { [ARCHIVED]: { pushEndpoint: endpoint(ARCHIVED), attributes: { 'x-goog-version': 'v1' }, noWrapper: { writeMetadata: false } } },
      pausedQueues: [{ service: 'programs-sites', queue: SITEMONITOR_QUEUE }],
      pausedTasks: [SITE_MONITOR_TASK],
    };
    const storedRow = async (): Promise<unknown> => {
      const { rows } = await schema.db.withMetadata((tx) =>
        tx.query<{ value: unknown }>(`SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`, [BACKGROUND_KEY]),
      );
      return rows[0]?.value;
    };

    beforeAll(async () => {
      const handle = await withMigrationSchema();
      if (handle === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
      schema = handle;
      state = createBackgroundState({ db: schema.db, clock });
    });

    afterAll(async () => {
      await schema?.drop();
    });

    beforeEach(async () => {
      await schema.db.withMetadata((tx) => tx.query(`DELETE FROM ${SCHEDULER_STATE_TABLE}`));
    });

    it('reads the default record, not suspended, while scheduler_state holds no background row', async () => {
      await expect(state.isSuspended()).resolves.toBe(false);
      await expect(state.get()).resolves.toStrictEqual(defaultBackgroundRecord());
      await expect(storedRow()).resolves.toBeUndefined();
    });

    it('stores a suspended record as jsonb under key background and reads an equal record back', async () => {
      const stored = await state.suspend({ ...RECORD, suspended: false });

      expect(stored).toStrictEqual({ ...RECORD, since: clock.now().toISOString() });
      await expect(storedRow()).resolves.toStrictEqual(stored);
      await expect(state.get()).resolves.toStrictEqual(stored);
      await expect(state.isSuspended()).resolves.toBe(true);
    });

    it('resume replaces the row with the default record stamped resumedAt', async () => {
      await state.suspend(RECORD);
      clock.advance(MINUTE_MS);

      const resumed = await state.resume();

      expect(resumed).toStrictEqual({ ...defaultBackgroundRecord(), resumedAt: clock.now().toISOString() });
      await expect(storedRow()).resolves.toStrictEqual(resumed);
      await expect(state.isSuspended()).resolves.toBe(false);
    });

    it('refuses a stored value the record schema rejects', async () => {
      const malformed = { suspended: 'yes', pushConfigs: [], pausedQueues: [{ service: '', queue: 'q' }] };
      await schema.db.withMetadata((tx) =>
        tx.query(`INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now())`, [
          BACKGROUND_KEY,
          JSON.stringify(malformed),
        ]),
      );

      expect(backgroundRecordSchema.safeParse(malformed).success).toBe(false);
      const error = await state.get().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SchedulerStateError);
      expect(error).toMatchObject({ key: BACKGROUND_KEY });
    });
  },
);
