import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, renderUnavailable } from '../../src/legacy-compat/index.js';
import { fixedClock } from '../../src/service-kit/clock.js';
import type { FastifyReply, FastifyRequest } from '../../src/service-kit/index.js';
import {
  assertCreateInput,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskContext,
  type TaskInfo,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from '../../src/tasks/port.js';
import { UnknownQueueError, UnknownTaskTargetError } from '../../src/tasks/queues.js';
import {
  MAX_SLOT_PROBES,
  RecurringSlotsTombstonedError,
  SuccessorCreationError,
  ensureOwnRecurring,
  ensureRecurring,
  parseSlotName,
  recurringHandler,
  recurringSpec,
  slotName,
  slotStartS,
  successorSlotS,
  type RecurringSpec,
  type RecurringTaskContext,
} from '../../src/tasks/recurring.js';

const NOW = '2026-06-30T12:07:30Z';
const NOW_S = 1_782_821_250;
const MONITOR_SLOT_S = 1_782_820_800;
const SWEEP_SLOT_S = 1_782_821_220;

const SWEEP = 'people-outbox-sweep';
const MONITOR = 'programs-sites-sitemonitor';

const SERVICE_URLS: Readonly<Record<string, string>> = {
  identity: 'http://127.0.0.1:8111',
  people: 'http://127.0.0.1:8112/',
  'programs-sites': 'http://127.0.0.1:8113',
  communications: 'http://127.0.0.1:8115',
  surveys: 'http://127.0.0.1:8117',
  stub: 'http://127.0.0.1:8199',
};

const key = (queue: string, name: string): string => `${queue}/${name}`;

function taskInfo(task: CreateTaskInput): TaskInfo {
  return {
    queue: task.queue,
    name: task.name,
    scheduleTime: task.scheduleTime,
    ...(task.tenantId === undefined ? {} : { tenantId: task.tenantId }),
    status: 'pending',
    attempts: 0,
  };
}

/** In-memory task port with Cloud Tasks name semantics: a live or tombstoned name answers ALREADY_EXISTS, and only a live one is found. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local';
  readonly live = new Map<string, CreateTaskInput>();
  readonly tombstones = new Set<string>();
  /** Live tasks `list` leaves out, as if created after its snapshot. */
  readonly unlisted = new Set<string>();
  readonly paused = new Set<string>();
  readonly calls: string[] = [];
  pageSize = 100;
  createFailure: Error | undefined;
  getFailure: Error | undefined;

  create(input: CreateTaskInput): Promise<CreateTaskResult> {
    this.calls.push(`create ${key(input.queue, input.name)}`);
    return new Promise((resolve) => {
      if (this.createFailure) throw this.createFailure;
      assertCreateInput(input);
      const id = key(input.queue, input.name);
      const created = !this.live.has(id) && !this.tombstones.has(id);
      if (created) this.live.set(id, input);
      resolve({ name: input.name, created });
    });
  }

  delete(queue: string, name: string): Promise<DeleteTaskResult> {
    this.calls.push(`delete ${key(queue, name)}`);
    const id = key(queue, name);
    const deleted = this.live.delete(id);
    if (deleted) this.tombstones.add(id);
    return Promise.resolve({ name, deleted });
  }

  /** Pages of `pageSize` in creation order; the token is the offset of the next page. */
  list(queue: string, page: TaskPageRequest = {}): Promise<TaskPage> {
    this.calls.push(page.pageToken === undefined ? `list ${queue}` : `list ${queue} ${page.pageToken}`);
    const all = [...this.live.entries()]
      .filter(([id, task]) => task.queue === queue && !this.unlisted.has(id))
      .map(([, task]) => taskInfo(task));
    const start = page.pageToken === undefined ? 0 : Number(page.pageToken);
    const end = start + (page.pageSize ?? this.pageSize);
    const tasks = all.slice(start, end);
    return Promise.resolve(end < all.length ? { tasks, nextPageToken: String(end) } : { tasks });
  }

  get(queue: string, name: string): Promise<TaskInfo | undefined> {
    this.calls.push(`get ${key(queue, name)}`);
    if (this.getFailure) return Promise.reject(this.getFailure);
    const task = this.live.get(key(queue, name));
    return Promise.resolve(task === undefined ? undefined : taskInfo(task));
  }

  pauseQueue(queue: string): Promise<void> {
    this.paused.add(queue);
    return Promise.resolve();
  }

  resumeQueue(queue: string): Promise<void> {
    this.paused.delete(queue);
    return Promise.resolve();
  }

  queueState(queue: string): Promise<QueueState> {
    return Promise.resolve({ queue, paused: this.paused.has(queue) });
  }

  close(): Promise<void> {
    this.calls.push('close');
    return Promise.resolve();
  }

  liveNames(queue: string): string[] {
    return [...this.live.values()].filter((task) => task.queue === queue).map((task) => task.name);
  }
}

/** Creates a live task named `name` on the spec's queue. */
async function seed(port: MemoryTaskPort, spec: RecurringSpec, name: string): Promise<void> {
  await port.create({ queue: spec.queue, name, scheduleTime: new Date(NOW), url: spec.url, deadlineS: spec.deadlineS });
}

/** Leaves the chain names of `count` consecutive slots from `fromS` as tombstones; returns those names. */
async function tombstone(port: MemoryTaskPort, spec: RecurringSpec, fromS: number, count: number): Promise<string[]> {
  const names = Array.from({ length: count }, (_, i) => slotName(spec.queue, fromS + i * spec.intervalS));
  for (const name of names) {
    await seed(port, spec, name);
    await port.delete(spec.queue, name);
  }
  port.calls.length = 0;
  return names;
}

function taskContext(queue: string, taskName: string): TaskContext {
  return {
    queue,
    taskName,
    retryCount: 0,
    executionCount: 0,
    tenantId: null,
    payload: null,
    request: {} as FastifyRequest,
    reply: {} as FastifyReply,
  };
}

const sweepSpec = (): RecurringSpec => recurringSpec(SWEEP, SERVICE_URLS);
const monitorSpec = (): RecurringSpec => recurringSpec(MONITOR, SERVICE_URLS);

describe('slotStartS', () => {
  it.each([
    { epochS: NOW_S, intervalS: 900, expected: MONITOR_SLOT_S },
    { epochS: NOW_S, intervalS: 60, expected: SWEEP_SLOT_S },
    { epochS: MONITOR_SLOT_S, intervalS: 900, expected: MONITOR_SLOT_S },
    { epochS: MONITOR_SLOT_S + 899, intervalS: 900, expected: MONITOR_SLOT_S },
    { epochS: 59, intervalS: 60, expected: 0 },
  ])('floors $epochS to $expected on a $intervalS s interval', ({ epochS, intervalS, expected }) => {
    expect(slotStartS(epochS, intervalS)).toBe(expected);
  });

  it('returns the interval-aligned start of the slot containing the instant', () => {
    fc.assert(
      fc.property(fc.nat({ max: 4_000_000_000 }), fc.integer({ min: 1, max: 86_400 }), (epochS, intervalS) => {
        const start = slotStartS(epochS, intervalS);
        expect(start % intervalS).toBe(0);
        expect(start).toBeLessThanOrEqual(epochS);
        expect(epochS).toBeLessThan(start + intervalS);
      }),
    );
  });
});

describe('slotName', () => {
  it('names a slot <queue>-<slot start epoch seconds>', () => {
    expect(slotName(SWEEP, SWEEP_SLOT_S)).toBe('people-outbox-sweep-1782821220');
    expect(slotName(MONITOR, 0)).toBe('programs-sites-sitemonitor-0');
  });

  it.each([-60, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects slot start %s with a TypeError', (slotS) => {
    expect(() => slotName(SWEEP, slotS)).toThrow(TypeError);
  });
});

describe('parseSlotName', () => {
  it('recovers the slot start from any queue name slotName produced', () => {
    fc.assert(
      fc.property(fc.string(), fc.maxSafeNat(), (queue, slotS) => {
        expect(parseSlotName(queue, slotName(queue, slotS))).toBe(slotS);
      }),
    );
  });

  it.each([
    { queue: SWEEP, name: SWEEP },
    { queue: SWEEP, name: `${SWEEP}-` },
    { queue: SWEEP, name: `${SWEEP}-12a` },
    { queue: SWEEP, name: `${SWEEP}--60` },
    { queue: SWEEP, name: `${SWEEP}-60-1` },
    { queue: SWEEP, name: `${SWEEP}-manual` },
    { queue: SWEEP, name: `x${SWEEP}-60` },
    { queue: SWEEP, name: 'identity-outbox-sweep-60' },
    { queue: SWEEP, name: `projects/p/locations/l/queues/${SWEEP}/tasks/${SWEEP}-60` },
  ])('returns undefined for $name, which is not a chain task name of $queue', ({ queue, name }) => {
    expect(parseSlotName(queue, name)).toBeUndefined();
  });

  it.each([
    { queue: 'a.b', name: 'aXb-60' },
    { queue: 'a+', name: 'aaa-60' },
    { queue: '[q]', name: 'q-60' },
    { queue: 'q|x', name: 'x-60' },
    { queue: 'q?', name: '-60' },
    { queue: 'q(x)*', name: 'q-60' },
    { queue: 'q{2}', name: 'qq-60' },
    { queue: '^q$', name: 'q-60' },
    { queue: 'q\\d', name: 'q1-60' },
  ])('matches the metacharacters of queue $queue literally, so $name is not its chain name', ({ queue, name }) => {
    expect(parseSlotName(queue, name)).toBeUndefined();
    expect(parseSlotName(queue, `${queue}-60`)).toBe(60);
  });
});

describe('successorSlotS', () => {
  it.each([
    { label: 'the next slot for an on-time run', currentS: MONITOR_SLOT_S, nowS: NOW_S, expected: MONITOR_SLOT_S + 900 },
    {
      label: 'the slot after now for a run three slots late',
      currentS: MONITOR_SLOT_S,
      nowS: MONITOR_SLOT_S + 2 * 900 + 5,
      expected: MONITOR_SLOT_S + 3 * 900,
    },
    {
      label: 'the slot after the current one when the current slot is still ahead of now',
      currentS: MONITOR_SLOT_S + 900,
      nowS: NOW_S,
      expected: MONITOR_SLOT_S + 2 * 900,
    },
  ])('returns $label', ({ currentS, nowS, expected }) => {
    expect(successorSlotS(currentS, nowS, 900)).toBe(expected);
  });

  it('returns the earliest aligned slot after both the current slot and the slot containing now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86_400 }),
        fc.nat({ max: 10_000_000 }),
        fc.nat({ max: 4_000_000_000 }),
        (intervalS, currentIndex, nowS) => {
          const currentS = currentIndex * intervalS;
          const successor = successorSlotS(currentS, nowS, intervalS);
          const nowSlotS = slotStartS(nowS, intervalS);
          expect(successor % intervalS).toBe(0);
          expect(successor).toBeGreaterThan(nowSlotS);
          expect(successor).toBeGreaterThan(currentS);
          const previous = successor - intervalS;
          expect(previous <= nowSlotS || previous <= currentS).toBe(true);
        },
      ),
    );
  });
});

describe('recurringSpec', () => {
  it.each([
    {
      queue: MONITOR,
      expected: { queue: MONITOR, intervalS: 900, deadlineS: 600, url: 'http://127.0.0.1:8113/internal/v1/jobs/sitemonitor' },
    },
    {
      queue: SWEEP,
      expected: { queue: SWEEP, intervalS: 60, deadlineS: 60, url: 'http://127.0.0.1:8112/internal/v1/outbox/sweep' },
    },
    {
      queue: 'stub-outbox-sweep',
      expected: { queue: 'stub-outbox-sweep', intervalS: 60, deadlineS: 60, url: 'http://127.0.0.1:8199/internal/v1/outbox/sweep' },
    },
  ])('derives the $queue chain from the registry', ({ queue, expected }) => {
    expect(recurringSpec(queue, SERVICE_URLS)).toStrictEqual(expected);
  });

  it.each(['surveys-launch', 'communications-reminders', 'content-scheduled-publish', 'reporting-export-run'])(
    'rejects the one-off queue %s with a TypeError',
    (queue) => {
      expect(() => recurringSpec(queue, SERVICE_URLS)).toThrow(new TypeError(`Queue ${queue} is not a recurring queue`));
    },
  );

  it.each([
    { label: 'a queue outside the registry', queue: 'finance-outbox-sweep', urls: SERVICE_URLS, error: UnknownQueueError },
    { label: 'a chain whose target has no URL', queue: SWEEP, urls: { identity: 'http://127.0.0.1:8111' }, error: UnknownTaskTargetError },
  ])('rejects $label', ({ queue, urls, error }) => {
    expect(() => recurringSpec(queue, urls)).toThrow(error);
  });
});

describe('ensureRecurring', () => {
  const clock = fixedClock(NOW);

  it('reports the earliest live chain task of the queue and creates nothing', async () => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    await seed(port, spec, slotName(SWEEP, SWEEP_SLOT_S + 120));
    await seed(port, spec, slotName(SWEEP, SWEEP_SLOT_S + 60));
    await seed(port, spec, slotName(SWEEP, SWEEP_SLOT_S + 180));
    await seed(port, spec, `${SWEEP}-manual`);
    port.calls.length = 0;

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({
      queue: SWEEP,
      name: `${SWEEP}-${String(SWEEP_SLOT_S + 60)}`,
      created: false,
      reason: 'live',
    });
    expect(port.calls).toStrictEqual([`list ${SWEEP}`]);
  });

  it.each([
    { label: 'an empty sweep queue', queue: SWEEP, slotS: SWEEP_SLOT_S, deadlineS: 60, foreign: [] },
    { label: 'an empty site-monitor queue', queue: MONITOR, slotS: MONITOR_SLOT_S, deadlineS: 600, foreign: [] },
    {
      label: 'a sweep queue holding only tasks that are not its chain tasks',
      queue: SWEEP,
      slotS: SWEEP_SLOT_S,
      deadlineS: 60,
      foreign: [`${SWEEP}-manual`, `${SWEEP}-60-retry`],
    },
  ])('creates the current slot task on $label', async ({ queue, slotS, deadlineS, foreign }) => {
    const port = new MemoryTaskPort();
    const spec = recurringSpec(queue, SERVICE_URLS);
    for (const name of foreign) await seed(port, spec, name);
    await seed(port, recurringSpec('identity-outbox-sweep', SERVICE_URLS), slotName('identity-outbox-sweep', SWEEP_SLOT_S));
    const name = slotName(queue, slotS);

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({
      queue,
      name,
      created: true,
      reason: 'created-current',
    });
    expect(port.live.get(key(queue, name))).toStrictEqual({
      queue,
      name,
      scheduleTime: new Date(slotS * 1000),
      url: spec.url,
      deadlineS,
      body: { slotStartS: slotS },
    });
  });

  it('finds the chain it created on a repeated call', async () => {
    const port = new MemoryTaskPort();
    const opts = { ...sweepSpec(), clock };
    const first = await ensureRecurring(port, opts);

    await expect(ensureRecurring(port, opts)).resolves.toStrictEqual({ ...first, created: false, reason: 'live' });
    expect(port.liveNames(SWEEP)).toStrictEqual([first.name]);
  });

  it.each([1, 2, MAX_SLOT_PROBES - 1])('restarts the chain past %i tombstoned slot names from the current one', async (count) => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    await tombstone(port, spec, SWEEP_SLOT_S, count);
    const nextS = SWEEP_SLOT_S + count * 60;
    const next = slotName(SWEEP, nextS);

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({
      queue: SWEEP,
      name: next,
      created: true,
      reason: 'created-next',
    });
    expect(port.liveNames(SWEEP)).toStrictEqual([next]);
    expect(port.live.get(key(SWEEP, next))?.scheduleTime).toStrictEqual(new Date(nextS * 1000));
  });

  it('fails with a 503 RecurringSlotsTombstonedError and creates nothing when every probed slot is a tombstone', async () => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    const probed = await tombstone(port, spec, SWEEP_SLOT_S, MAX_SLOT_PROBES);

    const error = (await ensureRecurring(port, { ...spec, clock }).catch((err: unknown) => err)) as RecurringSlotsTombstonedError;

    expect(error).toBeInstanceOf(RecurringSlotsTombstonedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ name: 'RecurringSlotsTombstonedError', queue: SWEEP, probed, reason: 'recurring-slots-tombstoned' });
    expect(renderUnavailable(error, 'opt2').status).toBe(503);
    expect(port.liveNames(SWEEP)).toStrictEqual([]);
    expect(port.calls).toStrictEqual([`list ${SWEEP}`, ...probed.flatMap((name) => [`create ${key(SWEEP, name)}`, `get ${key(SWEEP, name)}`])]);
  });

  it('reports a chain task that create finds live although list did not show it', async () => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    const current = slotName(SWEEP, SWEEP_SLOT_S);
    await seed(port, spec, current);
    port.unlisted.add(key(SWEEP, current));
    port.calls.length = 0;

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({
      queue: SWEEP,
      name: current,
      created: false,
      reason: 'live',
    });
    expect(port.calls).toStrictEqual([`list ${SWEEP}`, `create ${key(SWEEP, current)}`, `get ${key(SWEEP, current)}`]);
  });

  it('stops at the first page holding a chain task and reports its earliest one', async () => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    port.pageSize = 3;
    for (const name of [`${SWEEP}-manual`, slotName(SWEEP, SWEEP_SLOT_S + 180), slotName(SWEEP, SWEEP_SLOT_S + 120), slotName(SWEEP, SWEEP_SLOT_S + 60)]) {
      await seed(port, spec, name);
    }
    port.calls.length = 0;

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({
      queue: SWEEP,
      name: slotName(SWEEP, SWEEP_SLOT_S + 120),
      created: false,
      reason: 'live',
    });
    expect(port.calls).toStrictEqual([`list ${SWEEP}`]);
  });

  it.each([
    {
      label: 'reports the chain task of the second page',
      seeds: [`${SWEEP}-manual`, `${SWEEP}-manual-2`, slotName(SWEEP, SWEEP_SLOT_S + 60)],
      expected: { name: slotName(SWEEP, SWEEP_SLOT_S + 60), created: false, reason: 'live' },
      after: [],
    },
    {
      label: 'creates the current slot task after the last page',
      seeds: [`${SWEEP}-manual`, `${SWEEP}-manual-2`, `${SWEEP}-manual-3`],
      expected: { name: slotName(SWEEP, SWEEP_SLOT_S), created: true, reason: 'created-current' },
      after: [`create ${key(SWEEP, slotName(SWEEP, SWEEP_SLOT_S))}`],
    },
  ])('follows the page token past a page with no chain task and $label', async ({ seeds, expected, after }) => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    port.pageSize = 2;
    for (const name of seeds) await seed(port, spec, name);
    port.calls.length = 0;

    await expect(ensureRecurring(port, { ...spec, clock })).resolves.toStrictEqual({ queue: SWEEP, ...expected });
    expect(port.calls).toStrictEqual([`list ${SWEEP}`, `list ${SWEEP} 2`, ...after]);
  });
});

describe('recurringHandler', () => {
  const clock = fixedClock(NOW);

  it('creates the successor before the work runs and answers ok with the successor name', async () => {
    const port = new MemoryTaskPort();
    const seen: RecurringTaskContext[] = [];
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, (ctx) => {
      port.calls.push('work');
      seen.push(ctx);
      return Promise.resolve();
    });
    const ctx = taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S));
    const successor = slotName(SWEEP, SWEEP_SLOT_S + 60);

    await expect(handler(ctx)).resolves.toStrictEqual({ ok: true, successor });
    expect(port.calls).toStrictEqual([`create ${key(SWEEP, successor)}`, 'work']);
    expect(seen).toStrictEqual([{ ...ctx, slotStartS: SWEEP_SLOT_S, successor: { name: successor, created: true } }]);
    expect(port.live.get(key(SWEEP, successor))).toMatchObject({
      scheduleTime: new Date((SWEEP_SLOT_S + 60) * 1000),
      body: { slotStartS: SWEEP_SLOT_S + 60 },
    });
  });

  it('answers with the work result when the work returns one', async () => {
    const port = new MemoryTaskPort();
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, () => Promise.resolve({ swept: 3 }));

    await expect(handler(taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S)))).resolves.toStrictEqual({ swept: 3 });
  });

  it.each([
    { label: 'its own chain name', taskName: slotName(SWEEP, SWEEP_SLOT_S), currentS: SWEEP_SLOT_S },
    {
      label: 'a Cloud Tasks resource name',
      taskName: `projects/opt2/locations/europe-west1/queues/${SWEEP}/tasks/${slotName(SWEEP, SWEEP_SLOT_S - 120)}`,
      currentS: SWEEP_SLOT_S - 120,
    },
    { label: 'a chain name ten minutes late', taskName: slotName(SWEEP, SWEEP_SLOT_S - 600), currentS: SWEEP_SLOT_S - 600 },
    { label: 'a name outside the chain', taskName: '4170286934718346578', currentS: SWEEP_SLOT_S },
  ])('takes the slot from $label and schedules the successor after now', async ({ taskName, currentS }) => {
    const port = new MemoryTaskPort();
    const seen: RecurringTaskContext[] = [];
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, (ctx) => {
      seen.push(ctx);
      return Promise.resolve();
    });
    const successor = slotName(SWEEP, SWEEP_SLOT_S + 60);

    await expect(handler(taskContext(SWEEP, taskName))).resolves.toStrictEqual({ ok: true, successor });
    expect(seen.map((ctx) => ctx.slotStartS)).toStrictEqual([currentS]);
    expect(port.liveNames(SWEEP)).toStrictEqual([successor]);
  });

  it('schedules the site-monitor successor one 900 s slot ahead with its 600 s deadline', async () => {
    const port = new MemoryTaskPort();
    const handler = recurringHandler({ ...monitorSpec(), port, clock }, () => Promise.resolve());
    const successor = slotName(MONITOR, MONITOR_SLOT_S + 900);

    await expect(handler(taskContext(MONITOR, slotName(MONITOR, MONITOR_SLOT_S)))).resolves.toStrictEqual({ ok: true, successor });
    expect(port.live.get(key(MONITOR, successor))).toMatchObject({ deadlineS: 600, scheduleTime: new Date((MONITOR_SLOT_S + 900) * 1000) });
  });

  it('fails with a 503 SuccessorCreationError and never runs the work when the successor cannot be created', async () => {
    const port = new MemoryTaskPort();
    const outage = new Error('14 UNAVAILABLE: connection reset');
    port.createFailure = outage;
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, () => {
      port.calls.push('work');
      return Promise.resolve();
    });
    const successor = slotName(SWEEP, SWEEP_SLOT_S + 60);

    const error = (await handler(taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S))).catch((err: unknown) => err)) as SuccessorCreationError;

    expect(error).toBeInstanceOf(SuccessorCreationError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error.cause).toBe(outage);
    expect(error).toMatchObject({
      name: 'SuccessorCreationError',
      message: `Could not create successor task ${successor} on queue ${SWEEP}`,
      queue: SWEEP,
      successor,
      surface: 'auto',
      reason: 'successor-creation-failed',
    });
    expect(renderUnavailable(error, 'opt2').status).toBe(503);
    expect(port.calls).toStrictEqual([`create ${key(SWEEP, successor)}`]);
  });

  it.each([
    { label: 'a live successor it did not create', tombstoned: 0, live: true, successorS: SWEEP_SLOT_S + 60, created: false },
    { label: 'the slot after a tombstoned successor', tombstoned: 1, live: false, successorS: SWEEP_SLOT_S + 120, created: true },
    {
      label: 'the first slot past tombstoned successors',
      tombstoned: MAX_SLOT_PROBES - 1,
      live: false,
      successorS: SWEEP_SLOT_S + MAX_SLOT_PROBES * 60,
      created: true,
    },
  ])('runs the work and answers ok with $label', async ({ tombstoned, live, successorS, created }) => {
    const port = new MemoryTaskPort();
    const spec = sweepSpec();
    const dead = await tombstone(port, spec, SWEEP_SLOT_S + 60, tombstoned);
    const successor = slotName(SWEEP, successorS);
    if (live) await seed(port, spec, successor);
    port.calls.length = 0;
    const seen: RecurringTaskContext['successor'][] = [];
    const handler = recurringHandler({ ...spec, port, clock }, (ctx) => {
      seen.push(ctx.successor);
      return Promise.resolve();
    });

    await expect(handler(taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S)))).resolves.toStrictEqual({ ok: true, successor });
    expect(seen).toStrictEqual([{ name: successor, created }]);
    expect(port.liveNames(SWEEP)).toStrictEqual([successor]);
    expect(port.calls).toStrictEqual([
      ...dead.flatMap((name) => [`create ${key(SWEEP, name)}`, `get ${key(SWEEP, name)}`]),
      `create ${key(SWEEP, successor)}`,
      ...(created ? [] : [`get ${key(SWEEP, successor)}`]),
    ]);
  });

  it.each([
    {
      label: 'every probed successor slot is a tombstone',
      /** Arranges the port and returns the cause the error must carry. */
      arrange: async (port: MemoryTaskPort): Promise<unknown> => {
        return new RecurringSlotsTombstonedError(SWEEP, await tombstone(port, sweepSpec(), SWEEP_SLOT_S + 60, MAX_SLOT_PROBES));
      },
    },
    {
      label: 'the liveness check of an existing successor fails',
      arrange: async (port: MemoryTaskPort): Promise<unknown> => {
        await tombstone(port, sweepSpec(), SWEEP_SLOT_S + 60, 1);
        port.getFailure = new Error('14 UNAVAILABLE: connection reset');
        return port.getFailure;
      },
    },
  ])('fails with a 503 SuccessorCreationError and never runs the work when $label', async ({ arrange }) => {
    const port = new MemoryTaskPort();
    const cause = await arrange(port);
    const work = (): Promise<void> => {
      port.calls.push('work');
      return Promise.resolve();
    };
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, work);
    const successor = slotName(SWEEP, SWEEP_SLOT_S + 60);

    const error = (await handler(taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S))).catch((err: unknown) => err)) as SuccessorCreationError;

    expect(error).toBeInstanceOf(SuccessorCreationError);
    expect(error).toMatchObject({ queue: SWEEP, successor, reason: 'successor-creation-failed' });
    expect(error.cause).toStrictEqual(cause);
    expect(renderUnavailable(error, 'opt2').status).toBe(503);
    expect(port.calls).not.toContain('work');
    expect(port.liveNames(SWEEP)).toStrictEqual([]);
  });

  it('keeps the successor when the work fails, and a retry runs the work against that same successor', async () => {
    const port = new MemoryTaskPort();
    const failure = new Error('sweep failed');
    const seen: RecurringTaskContext['successor'][] = [];
    let attempts = 0;
    const handler = recurringHandler({ ...sweepSpec(), port, clock }, (ctx) => {
      seen.push(ctx.successor);
      attempts += 1;
      return attempts === 1 ? Promise.reject(failure) : Promise.resolve({ swept: 0 });
    });
    const ctx = taskContext(SWEEP, slotName(SWEEP, SWEEP_SLOT_S));
    const successor = slotName(SWEEP, SWEEP_SLOT_S + 60);

    await expect(handler(ctx)).rejects.toBe(failure);
    expect(port.liveNames(SWEEP)).toStrictEqual([successor]);
    await expect(handler({ ...ctx, retryCount: 1, executionCount: 1 })).resolves.toStrictEqual({ swept: 0 });
    expect(seen).toStrictEqual([
      { name: successor, created: true },
      { name: successor, created: false },
    ]);
    expect(port.liveNames(SWEEP)).toStrictEqual([successor]);
  });
});

describe('ensureOwnRecurring', () => {
  const clock = fixedClock(NOW);

  it.each([
    { service: 'people', withSiteMonitor: undefined, queues: [SWEEP] },
    { service: 'identity', withSiteMonitor: true, queues: ['identity-outbox-sweep'] },
    { service: 'programs-sites', withSiteMonitor: undefined, queues: ['programs-sites-outbox-sweep'] },
    { service: 'programs-sites', withSiteMonitor: false, queues: ['programs-sites-outbox-sweep'] },
    { service: 'programs-sites', withSiteMonitor: true, queues: [MONITOR, 'programs-sites-outbox-sweep'] },
    { service: 'stub', withSiteMonitor: undefined, queues: ['stub-outbox-sweep'] },
    { service: 'reporting', withSiteMonitor: true, queues: [] },
    { service: 'strategies-content', withSiteMonitor: undefined, queues: [] },
  ])('ensures exactly the chains $service creates (site monitor: $withSiteMonitor)', async ({ service, withSiteMonitor, queues }) => {
    const port = new MemoryTaskPort();

    const results = await ensureOwnRecurring(port, { service, serviceUrls: SERVICE_URLS, clock, withSiteMonitor });

    expect(results).toStrictEqual(
      queues.map((queue) => ({
        queue,
        name: slotName(queue, slotStartS(NOW_S, recurringSpec(queue, SERVICE_URLS).intervalS)),
        created: true,
        reason: 'created-current',
      })),
    );
    expect([...port.live.values()].map((task) => task.queue)).toStrictEqual(queues);
  });

  it('leaves a live chain alone while creating the missing ones', async () => {
    const port = new MemoryTaskPort();
    const liveMonitor = slotName(MONITOR, MONITOR_SLOT_S + 900);
    await seed(port, monitorSpec(), liveMonitor);

    await expect(
      ensureOwnRecurring(port, { service: 'programs-sites', serviceUrls: SERVICE_URLS, clock, withSiteMonitor: true }),
    ).resolves.toStrictEqual([
      { queue: MONITOR, name: liveMonitor, created: false, reason: 'live' },
      {
        queue: 'programs-sites-outbox-sweep',
        name: slotName('programs-sites-outbox-sweep', SWEEP_SLOT_S),
        created: true,
        reason: 'created-current',
      },
    ]);
  });

  it('fails with UnknownTaskTargetError when one of its chains has no target URL', async () => {
    const port = new MemoryTaskPort();

    await expect(
      ensureOwnRecurring(port, { service: 'people', serviceUrls: { identity: 'http://127.0.0.1:8111' }, clock }),
    ).rejects.toBeInstanceOf(UnknownTaskTargetError);
    expect(port.live.size).toBe(0);
  });
});
