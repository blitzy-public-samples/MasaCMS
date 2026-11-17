// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 consumer effect, queue side effects and recovery hook against a throwaway `communications` schema and an in-memory task port. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeEnvelope, type ConsumerDefinition, type DestinationResult, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { UnitNotAuthoritativeError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import type { OutboxRuntime, RecoveryContext } from '@opt2/platform/outbox';
import type { CreateTaskInput, CreateTaskResult, DeleteTaskResult, TaskPort } from '@opt2/platform/tasks';
import { tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  testEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  SCHEDULED_TASK_RECOVERY_AGE_MS,
  SCHEDULED_TASK_RECOVERY_HOOK,
  SURVEY_SOURCE_TYPE,
  applySurveyScheduled,
  dequeueScheduledTasks,
  enqueueScheduledTasks,
  scheduledTaskRecovery,
  type SurveyScheduleDeps,
} from '../../src/domain/survey-schedule.js';
import type { SurveyScheduledPayload } from '../../src/generated/events/surveys.survey.scheduled.v1.js';
import { portTaskName, reactivatedPortTaskName } from '../../src/domain/survey-tasks.js';
import { RECOVERY_BATCH_SIZE } from '../../src/repo/queries.js';
import { createCommunicationsRepository, type NewAdoptedScheduledTask } from '../../src/repo/repository.js';
import { UNITS, type ScheduledTaskRow, type ScheduledTaskStatus } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const TOPIC = 'surveys.survey.scheduled.v1';
const SUBSCRIPTION = 'communications.surveys.survey.scheduled.v1';
const SERVICE_URLS = { surveys: 'http://127.0.0.1:20017', communications: 'http://127.0.0.1:20015' };

interface LogLine {
  severity: string;
  message: string;
  tenantId?: string;
}

/** One consumed delivery and its destination result. */
type Delivery = () => Promise<DestinationResult | undefined>;

/** In-memory task port: creates are idempotent by queue and name, deletes report NOT_FOUND, and either call can be made to fail. */
class MemoryTaskPort implements TaskPort {
  readonly kind = 'local' as const;
  readonly live = new Map<string, CreateTaskInput>();
  readonly creates: CreateTaskInput[] = [];
  readonly deletes: Array<{ queue: string; name: string; tenantId?: string }> = [];
  failCreate = false;
  failDelete = false;

  create(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (this.failCreate) return Promise.reject(new Error('task port unavailable'));
    this.creates.push(input);
    const key = `${input.queue}/${input.name}`;
    const created = !this.live.has(key);
    this.live.set(key, input);
    return Promise.resolve({ name: input.name, created });
  }

  delete(queue: string, name: string, opts?: { tenantId?: string }): Promise<DeleteTaskResult> {
    if (this.failDelete) return Promise.reject(new Error('task port unavailable'));
    this.deletes.push({ queue, name, tenantId: opts?.tenantId });
    return Promise.resolve({ name, deleted: this.live.delete(`${queue}/${name}`) });
  }

  list(): ReturnType<TaskPort['list']> {
    return Promise.resolve({ tasks: [] });
  }

  get(): ReturnType<TaskPort['get']> {
    return Promise.resolve(undefined);
  }

  pauseQueue(): Promise<void> {
    return Promise.resolve();
  }

  resumeQueue(): Promise<void> {
    return Promise.resolve();
  }

  queueState(queue: string): ReturnType<TaskPort['queueState']> {
    return Promise.resolve({ queue, paused: false });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** CF-format survey id unique to `n`. */
function surveyId(n: number): string {
  return `AAAAAAAA-BBBB-CCCC-DDDD${String(n).padStart(12, '0')}`;
}

function schedule(survey: string, version: number, offsets: readonly number[]): SurveyScheduledPayload {
  return {
    surveyId: survey,
    siteId: TENANT_A.siteId,
    scheduleVersion: version,
    launchAt: '2026-07-01T09:00:00.000',
    launchTaskName: `opt2-survey-${survey}-launch`,
    reminders: offsets.map((offsetMinutes, i) => ({ n: i + 1, offsetMinutes, taskName: `opt2-survey-${survey}-reminder-${String(i + 1)}` })),
    targets: [],
  };
}

/** Runs `run` with the process time zone set to `tz`, then restores the previous one. */
async function inTimeZone<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function envelope(payload: SurveyScheduledPayload, aggregateVersion = payload.scheduleVersion): EventEnvelope<SurveyScheduledPayload> {
  return testEnvelope({
    topic: TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateType: 'survey-schedule',
    aggregateId: payload.surveyId,
    aggregateVersion,
    payload,
  });
}

const available = await pgAvailable();

describe.skipIf(!available)('survey schedule consumer and recovery against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let port: MemoryTaskPort;
  let deps: SurveyScheduleDeps;
  let def: ConsumerDefinition<SurveyScheduledPayload>;
  let logs: LogLine[];
  let surveys = 0;
  let survey: string;
  const logger = createLogger({
    service: 'communications',
    version: '1.0.0',
    env: 'local',
    destination: { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) },
  });

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await ensureUnitGates(handle.app, UNITS);
    await setGate('open');
    port = new MemoryTaskPort();
    logs = [];
    const clock = fixedClock(NOW);
    const repository = createCommunicationsRepository({ clock, schema: handle.schema });
    deps = { db: handle.app, repository, clock, logger, taskPort: port, serviceUrls: SERVICE_URLS };
    def = { topic: TOPIC, kind: 'process', supersedes: true, apply: applySurveyScheduled(deps) };
    surveys += 1;
    survey = surveyId(surveys);
  });

  async function setGate(state: 'open' | 'closed' | 'legacy'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = 'quiet' WHERE unit = $3`, [
        state,
        state === 'closed' ? 'test-holder' : null,
        'communications.scheduled_task',
      ]),
    );
  }

  async function consume(event: EventEnvelope<SurveyScheduledPayload>): Promise<DestinationResult | undefined> {
    const outcome = await consumeEnvelope(handle.app, def, event, { subscription: SUBSCRIPTION, messageId: event.eventId, logger });
    return outcome.destinations[0]?.result;
  }

  async function rows(source = survey, tenantId = TENANT_A.tenantId): Promise<ScheduledTaskRow[]> {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows: found } = await tx.query<ScheduledTaskRow>(
        `SELECT * FROM ${handle.schema}.scheduled_task WHERE source_id = $1 ORDER BY schedule_version, kind, reminder_n NULLS FIRST`,
        [source],
      );
      return found;
    });
  }

  function recoveryContext(elapsedMs: number): RecoveryContext {
    return { service: 'communications', runtime: {} as OutboxRuntime, clock: fixedClock(NOW.getTime() + elapsedMs), logger };
  }

  it('records the launch and one task per reminder, then queues each under the envelope tenant', async () => {
    expect(await consume(envelope(schedule(survey, 1, [60, 120])))).toBe('applied');

    const stored = await rows();
    const [launch, first] = stored;
    expect(stored.map((row) => [row.kind, row.queue, row.reminder_n, row.status, row.origin, row.source_type])).toEqual([
      ['survey-launch', 'surveys-launch', null, 'scheduled', 'event', SURVEY_SOURCE_TYPE],
      ['survey-reminder', 'communications-reminders', 1, 'scheduled', 'event', SURVEY_SOURCE_TYPE],
      ['survey-reminder', 'communications-reminders', 2, 'scheduled', 'event', SURVEY_SOURCE_TYPE],
    ]);
    expect(stored.every((row) => row.tenant_id === TENANT_A.tenantId && row.enqueued_at?.getTime() === NOW.getTime())).toBe(true);
    expect(launch).toMatchObject({
      task_name: `opt2-survey-${survey}-launch`,
      queue_task_name: `opt2-survey-${survey}-launch-v1`,
      target_route: '/internal/v1/tasks/surveys/launch',
    });
    expect(first?.target_route).toBe('/internal/v1/tasks/reminders');
    expect(port.creates.map((task) => ({ ...task, scheduleTime: task.scheduleTime.getTime() }))).toEqual(
      stored.map((row, i) => ({
        queue: row.queue,
        name: row.queue_task_name,
        scheduleTime: new Date(2026, 6, 1, 9, [0, 60, 120][i] ?? 0).getTime(),
        url:
          i === 0
            ? `${SERVICE_URLS.surveys}/internal/v1/tasks/surveys/launch`
            : `${SERVICE_URLS.communications}/internal/v1/tasks/reminders`,
        body:
          i === 0
            ? { surveyId: survey, siteId: TENANT_A.siteId, scheduleVersion: 1 }
            : { scheduledTaskId: row.scheduled_task_id, surveyId: survey, n: i, scheduleVersion: 1 },
        deadlineS: 60,
        tenantId: TENANT_A.tenantId,
      })),
    );
  });

  it.each([
    ['when consumed', false],
    ['by recovery after a failed queue call', true],
  ])('queues a launch at a time repeated by daylight saving, and its reminders, from the later offset %s', async (_label, recover) => {
    const scheduleTimes = await inTimeZone('America/New_York', async () => {
      port.failCreate = recover;
      try {
        expect(await consume(envelope({ ...schedule(survey, 1, [0, 60]), launchAt: '2026-11-01T01:30:00.000' }))).toBe('applied');
      } finally {
        port.failCreate = false;
      }
      if (recover) {
        await scheduledTaskRecovery(deps).run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));
      }
      return port.creates.map((task) => [task.name, task.scheduleTime.toISOString()]).sort();
    });

    expect(scheduleTimes).toEqual([
      [`opt2-survey-${survey}-launch-v1`, '2026-11-01T06:30:00.000Z'],
      [`opt2-survey-${survey}-reminder-1-v1`, '2026-11-01T06:30:00.000Z'],
      [`opt2-survey-${survey}-reminder-2-v1`, '2026-11-01T07:30:00.000Z'],
    ]);
  });

  it.each<[string, (first: EventEnvelope<SurveyScheduledPayload>) => EventEnvelope<SurveyScheduledPayload>, DestinationResult]>([
    ['a redelivery', (first) => first, 'duplicate'],
    ['a new event of the same aggregate version', (first) => envelope(first.payload), 'superseded'],
    ['a replay of the stored schedule version', (first) => envelope(first.payload, 5), 'applied'],
  ])('leaves %s without effect', async (_label, next, result) => {
    const first = envelope(schedule(survey, 1, [60]));
    await consume(first);
    const before = await rows();

    expect(await consume(next(first))).toBe(result);
    expect(await rows()).toEqual(before);
    expect(port.creates).toHaveLength(2);
    expect(port.deletes).toEqual([]);
  });

  /** Waits until `count` sessions wait on a lock in a statement naming this schema. */
  async function lockWaiters(count: number): Promise<void> {
    await vi.waitFor(
      async () => {
        const { rows: found } = await handle.adminPool.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND position($1 in query) > 0",
          [handle.schema],
        );
        expect(found[0]?.n).toBe(count);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  it.each<[string, (taskId: string, supersede: Delivery) => ReturnType<Delivery>]>([
    [
      'done before the delivery',
      async (taskId, supersede) => {
        await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => deps.repository.setScheduledTaskStatus(tx, taskId, 'done'));
        return supersede();
      },
    ],
    [
      'done while the supersede waits on its row',
      async (taskId, supersede) => {
        const { pending } = await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
          await deps.repository.setScheduledTaskStatus(tx, taskId, 'done');
          const delivery = supersede();
          await lockWaiters(1);
          return { pending: delivery };
        });
        return pending;
      },
    ],
  ])('supersedes the earlier version, deletes its queue tasks and keeps a task %s', async (_label, complete) => {
    await consume(envelope(schedule(survey, 1, [60, 120])));
    const [launch] = await rows();

    expect(await complete(launch?.scheduled_task_id ?? '', () => consume(envelope(schedule(survey, 2, [30]))))).toBe('applied');

    const stored = await rows();
    expect(stored.map((row) => [row.schedule_version, row.kind, row.status, row.dequeued_at !== null])).toEqual([
      [1, 'survey-launch', 'done', false],
      [1, 'survey-reminder', 'superseded', true],
      [1, 'survey-reminder', 'superseded', true],
      [2, 'survey-launch', 'scheduled', false],
      [2, 'survey-reminder', 'scheduled', false],
    ]);
    expect(port.deletes).toEqual(
      [1, 2].map((n) => ({ queue: 'communications-reminders', name: `opt2-survey-${survey}-reminder-${String(n)}-v1`, tenantId: TENANT_A.tenantId })),
    );
    expect([...port.live.keys()].filter((key) => key.endsWith('-v2'))).toHaveLength(2);
  });

  it('leaves a late earlier version without effect', async () => {
    await consume(envelope(schedule(survey, 2, [30])));
    const before = await rows();

    expect(await consume(envelope(schedule(survey, 1, [60])))).toBe('superseded');
    expect(await rows()).toEqual(before);
    expect(port.creates.map((task) => task.name)).toEqual([`opt2-survey-${survey}-launch-v2`, `opt2-survey-${survey}-reminder-1-v2`]);
  });

  it('propagates a gate error so the delivery is redelivered', async () => {
    await setGate('legacy');

    await expect(consume(envelope(schedule(survey, 1, [])))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await setGate('open');
    expect(await rows()).toEqual([]);
    expect(port.creates).toEqual([]);
  });

  it('counts an existing queue task as created and an absent one as deleted', async () => {
    port.failCreate = true;
    await consume(envelope(schedule(survey, 1, [])));
    port.failCreate = false;
    const [launch] = await rows();
    const task = launch as ScheduledTaskRow;
    await port.create({ queue: task.queue, name: task.queue_task_name, scheduleTime: NOW, url: SERVICE_URLS.surveys, deadlineS: 60 });

    await enqueueScheduledTasks(deps, TENANT_A.tenantId, [task], { siteId: TENANT_A.siteId });
    await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => deps.repository.setScheduledTaskStatus(tx, task.scheduled_task_id, 'superseded'));
    await dequeueScheduledTasks(deps, TENANT_A.tenantId, [task]);
    await dequeueScheduledTasks(deps, TENANT_A.tenantId, [task]);

    const [stamped] = await rows();
    expect(stamped?.enqueued_at).not.toBeNull();
    expect(stamped?.dequeued_at).not.toBeNull();
    expect(port.deletes.map((entry) => entry.name)).toEqual([task.queue_task_name, task.queue_task_name]);
    expect(logs.filter((line) => line.severity === 'ERROR')).toHaveLength(1);
  });

  /** Adopts this survey's launch without a queue task; `readopt` adopts it again, reactivating it once cancelled and dequeued. */
  async function adoptedLaunch(): Promise<{ row: ScheduledTaskRow; readopt: () => Promise<void> }> {
    const taskName = `opt2-survey-${survey}-launch`;
    const adoption: NewAdoptedScheduledTask = {
      taskName,
      queue: 'surveys-launch',
      queueTaskName: portTaskName(taskName, 1),
      reactivatedQueueTaskName: (current) => reactivatedPortTaskName(taskName, 1, current),
      kind: 'survey-launch',
      sourceType: SURVEY_SOURCE_TYPE,
      sourceId: survey,
      scheduleTime: new Date(2026, 6, 1, 9, 0, 0),
      targetRoute: '/internal/v1/tasks/surveys/launch',
      scheduleVersion: 1,
    };
    const adopt = () => withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => deps.repository.adoptScheduledTasks(tx, [adoption]));
    const [adopted] = await adopt();
    return {
      row: adopted?.row as ScheduledTaskRow,
      readopt: async () => {
        await adopt();
      },
    };
  }

  /** Makes the next create first commit `status` on `row`, dequeue it and run `after`, as a cancel or supersede overtaking it would. */
  function overtakeNextCreate(row: ScheduledTaskRow, status: ScheduledTaskStatus, after: () => Promise<void> = async () => undefined): void {
    const create = port.create.bind(port);
    vi.spyOn(port, 'create').mockImplementationOnce(async (input) => {
      await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) =>
        deps.repository.setScheduledTaskStatus(tx, row.scheduled_task_id, status, {}, 'scheduled'),
      );
      await dequeueScheduledTasks(deps, TENANT_A.tenantId, [row]);
      await after();
      return create(input);
    });
  }

  it.each<[string, ScheduledTaskStatus, boolean]>([
    ['cancellation', 'cancelled', false],
    ['supersede', 'superseded', false],
    ['cancellation and re-adoption', 'cancelled', true],
  ])('deletes a queue task created after a %s of its row', async (_label, status, reactivate) => {
    const { row, readopt } = await adoptedLaunch();
    overtakeNextCreate(row, status, reactivate ? readopt : undefined);

    await enqueueScheduledTasks(deps, TENANT_A.tenantId, [row], { siteId: TENANT_A.siteId });

    expect(port.creates.map((task) => task.name)).toEqual([row.queue_task_name]);
    expect(port.deletes).toEqual([row.queue_task_name, row.queue_task_name].map((name) => ({ queue: row.queue, name, tenantId: TENANT_A.tenantId })));
    expect([...port.live.keys()].filter((key) => key.includes(survey))).toEqual([]);
    expect((await rows()).map((stored) => [stored.status, stored.queue_task_name, stored.enqueued_at, stored.dequeued_at !== null])).toEqual([
      reactivate ? ['scheduled', `${row.queue_task_name}-r1`, null, false] : [status, row.queue_task_name, null, true],
    ]);
    expect(logs.filter((line) => line.severity === 'ERROR')).toEqual([]);

    // A reactivated row's own queue task is still created and stamped by the next enqueue.
    await enqueueScheduledTasks(deps, TENANT_A.tenantId, (await rows()).filter((stored) => stored.status === 'scheduled'), { siteId: TENANT_A.siteId });
    expect([...port.live.keys()].filter((key) => key.includes(survey))).toEqual(reactivate ? [`${row.queue}/${row.queue_task_name}-r1`] : []);
    expect((await rows()).every((stored) => (stored.status === 'scheduled' ? stored.enqueued_at : stored.dequeued_at) !== null)).toBe(true);
  });

  it('logs a failed delete of a queue task created after a cancellation of its row, keeping the row as the cancel stamped it', async () => {
    const { row } = await adoptedLaunch();
    overtakeNextCreate(row, 'cancelled', async () => {
      port.failDelete = true;
    });

    await enqueueScheduledTasks(deps, TENANT_A.tenantId, [row], { siteId: TENANT_A.siteId });

    expect([...port.live.keys()]).toEqual([`${row.queue}/${row.queue_task_name}`]);
    expect((await rows()).map((stored) => [stored.status, stored.enqueued_at, stored.dequeued_at !== null])).toEqual([['cancelled', null, true]]);
    expect(logs.filter((line) => line.severity === 'ERROR').map((line) => [line.tenantId, line.message])).toEqual([
      [TENANT_A.tenantId, `scheduled task ${row.queue_task_name} on ${row.queue}: created after its row moved on, and its delete failed`],
    ]);
  });

  it('takes the launch site from the registry, and leaves the row of an unregistered tenant unstamped', async () => {
    port.failCreate = true;
    await consume(envelope(schedule(survey, 1, [])));
    port.failCreate = false;
    const unregistered = tenantIdForSite('survey-schedule-unregistered');
    const [launch] = await rows();
    const row = launch as ScheduledTaskRow;
    const [orphan] = await withGatedTenant(handle.app, unregistered, (tx) =>
      deps.repository.insertScheduledTasks(tx, [
        {
          taskName: row.task_name,
          queue: row.queue,
          queueTaskName: row.queue_task_name,
          kind: row.kind,
          sourceType: row.source_type,
          sourceId: row.source_id,
          scheduleTime: row.schedule_time,
          targetRoute: row.target_route,
          scheduleVersion: row.schedule_version,
          origin: row.origin,
        },
      ]),
    );

    await enqueueScheduledTasks(deps, TENANT_A.tenantId, await rows());
    await enqueueScheduledTasks(deps, unregistered, [orphan as ScheduledTaskRow]);

    expect(port.creates.map((task) => [task.tenantId, task.body])).toEqual([
      [TENANT_A.tenantId, { surveyId: survey, siteId: TENANT_A.siteId, scheduleVersion: 1 }],
    ]);
    expect((await rows(survey, unregistered))[0]?.enqueued_at).toBeNull();
    expect(logs.filter((line) => line.severity === 'ERROR').map((line) => line.tenantId)).toEqual([TENANT_A.tenantId, unregistered]);
  });

  it.each([
    ['registered', false],
    ['deleted from the registry', true],
  ])('repairs side effects left unstamped longer than the recovery age while the unit gate is open, with the site %s', async (_label, deleted) => {
    port.failCreate = true;
    await consume(envelope(schedule(survey, 1, [60])));
    port.failDelete = true;
    await consume(envelope(schedule(survey, 2, [])));
    port.failCreate = false;
    port.failDelete = false;
    const hook = scheduledTaskRecovery(deps);
    const unstamped = async (): Promise<number> =>
      (await rows()).filter((row) => (row.status === 'scheduled' ? row.enqueued_at : row.dequeued_at) === null).length;

    expect(hook.name).toBe(SCHEDULED_TASK_RECOVERY_HOOK);
    expect(await unstamped()).toBe(3);
    if (deleted) {
      await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.tenant_registry SET deleted = true WHERE tenant_id = $1`, [TENANT_A.tenantId]));
    }
    try {
      await hook.run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS - 1));
      expect(await unstamped()).toBe(3);
      expect(port.deletes).toEqual([]);

      await hook.run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));
    } finally {
      await seedRegistry(handle.app);
    }

    expect(await unstamped()).toBe(0);
    expect(port.creates.map((task) => [task.name, task.tenantId, task.body])).toEqual([
      [`opt2-survey-${survey}-launch-v2`, TENANT_A.tenantId, { surveyId: survey, siteId: TENANT_A.siteId, scheduleVersion: 2 }],
    ]);
    expect(port.deletes.map((entry) => entry.name).sort()).toEqual([`opt2-survey-${survey}-launch-v1`, `opt2-survey-${survey}-reminder-1-v1`]);
  });

  it.each(['legacy', 'closed', 'missing'] as const)(
    'deletes leaked queue tasks of superseded and cancelled rows under a %s gate, stamping and enqueueing only once it opens',
    async (state) => {
      await consume(envelope(schedule(survey, 1, [60])));
      const [, reminder] = await rows();
      await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) =>
        deps.repository.setScheduledTaskStatus(tx, reminder?.scheduled_task_id ?? '', 'cancelled'),
      );
      port.failCreate = true;
      port.failDelete = true;
      await consume(envelope(schedule(survey, 2, [])));
      port.failCreate = false;
      const created = port.creates.length;
      const live = (): string[] => [...port.live.keys()].filter((key) => key.includes(survey)).sort();
      const leaked = [`communications-reminders/opt2-survey-${survey}-reminder-1-v1`, `surveys-launch/opt2-survey-${survey}-launch-v1`];
      const hook = scheduledTaskRecovery(deps);
      const errors = (): string[] => logs.filter((line) => line.severity === 'ERROR').map((line) => line.message);
      if (state === 'missing') {
        await withMetadata(handle.app, (tx) => tx.query(`DELETE FROM ${handle.schema}.unit_gate WHERE unit = $1`, ['communications.scheduled_task']));
      } else {
        await setGate(state);
      }
      expect(live()).toEqual(leaked);
      logs = [];

      await hook.run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));
      expect(live()).toEqual(leaked);
      expect(errors()).toHaveLength(2);
      port.failDelete = false;
      logs = [];

      await hook.run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));
      expect(live()).toEqual([]);
      expect(port.creates).toHaveLength(created);
      expect((await rows()).map((row) => [row.schedule_version, row.status, row.enqueued_at !== null, row.dequeued_at])).toEqual([
        [1, 'superseded', true, null],
        [1, 'cancelled', true, null],
        [2, 'scheduled', false, null],
      ]);
      // A refused or timed-out stamp would be logged as a dequeue left for recovery.
      expect(errors()).toEqual([]);

      await ensureUnitGates(handle.app, UNITS);
      await setGate('open');
      await hook.run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));
      expect((await rows()).map((row) => [row.status, row.status === 'scheduled' ? row.enqueued_at !== null : row.dequeued_at !== null])).toEqual([
        ['superseded', true],
        ['cancelled', true],
        ['scheduled', true],
      ]);
      expect(port.creates.slice(created).map((task) => task.name)).toEqual([`opt2-survey-${survey}-launch-v2`]);
      expect(live()).toEqual([`surveys-launch/opt2-survey-${survey}-launch-v2`]);
    },
  );

  it('recovers every batch of a tenant', async () => {
    port.failCreate = true;
    await consume(envelope(schedule(survey, 1, Array.from({ length: RECOVERY_BATCH_SIZE }, (_, i) => i))));
    port.failCreate = false;

    await scheduledTaskRecovery(deps).run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));

    const stored = await rows();
    expect(stored).toHaveLength(RECOVERY_BATCH_SIZE + 1);
    expect(stored.every((row) => row.enqueued_at !== null)).toBe(true);
    expect(new Set(port.creates.map((task) => task.name)).size).toBe(RECOVERY_BATCH_SIZE + 1);
  });

  it('logs a tenant whose recovery fails and recovers the others', async () => {
    port.failCreate = true;
    await consume(envelope(schedule(survey, 1, [])));
    port.failCreate = false;
    logs = [];
    const failing: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => (tenantId === TENANT_B.tenantId ? Promise.reject(new Error('tenant down')) : handle.app.withTenant(tenantId, fn)),
      withMetadata: (fn, options) => handle.app.withMetadata(fn, options),
      end: () => Promise.resolve(),
    };

    await scheduledTaskRecovery({ ...deps, db: failing }).run(recoveryContext(SCHEDULED_TASK_RECOVERY_AGE_MS + 1));

    expect((await rows())[0]?.enqueued_at).not.toBeNull();
    expect(logs.filter((line) => line.severity === 'ERROR').map((line) => line.tenantId)).toEqual([TENANT_B.tenantId]);
  });
});
