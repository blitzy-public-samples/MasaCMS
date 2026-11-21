// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 supersede rule through the communications push route over the in-memory fakes: v2 replaces v1's tasks, a late v1 has no effect, recovery repairs lost port calls. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@opt2/platform/events';
import { outboxRuntimeFor } from '@opt2/platform/outbox';
import { TENANT_A, fixedClock, pushTo } from '@opt2/platform/testing';
import { SCHEDULED_TASK_RECOVERY_AGE_MS, scheduledTaskRecovery, type SurveyScheduleDeps } from '../../src/domain/survey-schedule.js';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC, type SurveyScheduledPayload } from '../../src/events/survey-scheduled.js';
// SurveyScheduleDeps needs a CommunicationsRepository, and only repository.ts builds one; recovery stamps with its clock.
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { SCHEDULED_TASK, SCHEDULED_TASK_QUEUES, type ScheduledTaskRow } from '../../src/repo/tables.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

type Version = 1 | 2;

interface PortTask {
  queue: string;
  name: string;
}

const SURVEY_QUEUES: ReadonlySet<string> = new Set(SCHEDULED_TASK_QUEUES);

function scheduleEnvelope(version: Version, aggregateVersion: number = version): EventEnvelope<SurveyScheduledPayload> {
  return envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(version), { tenantId: TENANT_A.tenantId, aggregateVersion });
}

/** The launch and reminder port tasks schedule `version` plans, launch first. */
function plannedTasks(version: Version): PortTask[] {
  const payload = surveyScheduledPayload(version);
  return [
    { queue: 'surveys-launch', name: `${payload.launchTaskName}-v${String(version)}` },
    ...payload.reminders.map((reminder) => ({ queue: 'communications-reminders', name: `${reminder.taskName}-v${String(version)}` })),
  ];
}

const byName = (a: PortTask, b: PortTask): number => a.name.localeCompare(b.name);

/** {@link plannedTasks} by name, the order recovery cannot promise. */
function plannedSet(version: Version): PortTask[] {
  return plannedTasks(version).sort(byName);
}

describe('survey.scheduled supersede rule', () => {
  let built: TestApp;

  beforeEach(async () => {
    built = await buildTestApp();
  });

  afterEach(async () => {
    await built.app.close();
  });

  async function deliver(envelope: EventEnvelope<SurveyScheduledPayload>): Promise<void> {
    const response = await pushTo(built.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelope);
    expect(response.statusCode).toBe(204);
    expect(built.publisher.deadLetters(SURVEY_SCHEDULED_SUBSCRIPTION)).toEqual([]);
  }

  function rows(version?: Version): ScheduledTaskRow[] {
    const stored = built.db.rows('scheduled_task') as ScheduledTaskRow[];
    return stored.filter((row) => version === undefined || row.schedule_version === version);
  }

  function inboxStatus(eventId: string): unknown {
    return built.db.rows('inbox').find((row) => row.event_id === eventId)?.status;
  }

  function surveyTasks(tasks: readonly PortTask[]): PortTask[] {
    return tasks.filter((task) => SURVEY_QUEUES.has(task.queue)).map(({ queue, name }) => ({ queue, name })).sort(byName);
  }

  /** Survey port tasks the fake created, deleted ones included, by name. */
  function createdTasks(): PortTask[] {
    return surveyTasks(built.taskPort.tasks);
  }

  function liveTasks(): PortTask[] {
    return surveyTasks(built.taskPort.live());
  }

  /** Runs the recovery hook as the outbox sweep would at `at`, its repository stamping with the same clock. */
  async function recoverAt(at: number): Promise<void> {
    const clock = fixedClock(at);
    const { logger } = built.app.opt2;
    const deps: SurveyScheduleDeps = {
      db: built.db,
      repository: createCommunicationsRepository({ clock, schema: built.db.schema }),
      clock,
      logger,
      taskPort: built.taskPort,
      serviceUrls: built.env.OPT2_SERVICE_URLS,
    };
    await scheduledTaskRecovery(deps).run({
      service: built.env.OPT2_SERVICE_NAME,
      runtime: outboxRuntimeFor(built.db.schema),
      clock,
      logger,
    });
  }

  it('records and queues v1, then supersedes it with v2', async () => {
    await deliver(scheduleEnvelope(1));

    expect(rows().map((row) => [row.tenant_id, row.kind, row.queue, row.reminder_n, row.status, row.schedule_version, row.origin])).toEqual([
      [TENANT_A.tenantId, 'survey-launch', 'surveys-launch', null, 'scheduled', 1, 'event'],
      [TENANT_A.tenantId, 'survey-reminder', 'communications-reminders', 1, 'scheduled', 1, 'event'],
    ]);
    expect(rows().map((row) => ({ queue: row.queue, name: row.queue_task_name }))).toEqual(plannedTasks(1));
    expect(rows().every((row) => row.enqueued_at !== null && row.dequeued_at === null)).toBe(true);
    expect(createdTasks()).toEqual(plannedSet(1));

    const v2 = scheduleEnvelope(2);
    await deliver(v2);

    expect(rows(1).map((row) => [row.status, row.dequeued_at !== null])).toEqual([
      ['superseded', true],
      ['superseded', true],
    ]);
    expect([...built.taskPort.deleted].sort(byName)).toEqual(plannedSet(1));
    expect(rows(2).map((row) => [row.status, row.queue_task_name, row.enqueued_at !== null])).toEqual(
      plannedTasks(2).map((task) => ['scheduled', task.name, true]),
    );
    expect(liveTasks()).toEqual(plannedSet(2));
    expect(inboxStatus(v2.eventId)).toBe('applied');
  });

  it('ignores a redelivered v2', async () => {
    await deliver(scheduleEnvelope(1));
    const v2 = scheduleEnvelope(2);
    await deliver(v2);
    const before = { rows: rows(), created: createdTasks(), deleted: [...built.taskPort.deleted] };

    await deliver(v2);

    expect({ rows: rows(), created: createdTasks(), deleted: [...built.taskPort.deleted] }).toEqual(before);
    expect(built.db.rows('inbox').filter((row) => row.event_id === v2.eventId)).toHaveLength(1);
  });

  it.each([
    ['under its own aggregate version', 1, 'superseded'],
    ['replayed under a newer aggregate version', 3, 'applied'],
  ])('leaves a late v1 %s without effect', async (_label, aggregateVersion, status) => {
    await deliver(scheduleEnvelope(2));
    const before = { rows: rows(), created: createdTasks() };
    const late = scheduleEnvelope(1, aggregateVersion);

    await deliver(late);

    expect(inboxStatus(late.eventId)).toBe(status);
    expect(rows(1)).toEqual([]);
    expect({ rows: rows(), created: createdTasks() }).toEqual(before);
    expect(createdTasks().some((task) => task.name.endsWith('-v1'))).toBe(false);
    expect(built.taskPort.deleted).toEqual([]);
    expect(liveTasks()).toEqual(plannedSet(2));
  });

  it('acks a delivery whose port creates fail, then recovery enqueues each task once while the gate is open', async () => {
    built.taskPort.failCreate(plannedTasks(1).length);
    await deliver(scheduleEnvelope(1));
    built.taskPort.failCreate(0);

    expect(rows().map((row) => [row.status, row.enqueued_at])).toEqual([
      ['scheduled', null],
      ['scheduled', null],
    ]);
    expect(createdTasks()).toEqual([]);
    const created = Math.max(...rows().map((row) => row.created_at.getTime()));

    await recoverAt(created + SCHEDULED_TASK_RECOVERY_AGE_MS - 1);
    expect(rows().map((row) => row.enqueued_at)).toEqual([null, null]);
    expect(createdTasks()).toEqual([]);

    const repairedAt = created + SCHEDULED_TASK_RECOVERY_AGE_MS + 1;
    for (const state of ['closed', 'legacy'] as const) {
      built.db.setGate(SCHEDULED_TASK.unit, state);
      await recoverAt(repairedAt);
    }
    built.db.setGate(SCHEDULED_TASK.unit, 'open');
    expect(rows().map((row) => row.enqueued_at)).toEqual([null, null]);
    expect(createdTasks()).toEqual([]);

    await recoverAt(repairedAt);
    expect(rows().map((row) => row.enqueued_at?.getTime())).toEqual([repairedAt, repairedAt]);
    expect(createdTasks()).toEqual(plannedSet(1));

    const after = rows();
    await recoverAt(repairedAt + SCHEDULED_TASK_RECOVERY_AGE_MS);
    expect(createdTasks()).toEqual(plannedSet(1));
    expect(rows()).toEqual(after);
  });

  it('acks a delivery whose port deletes fail, then recovery dequeues each superseded task once', async () => {
    await deliver(scheduleEnvelope(1));
    built.taskPort.failDelete(plannedTasks(1).length);
    await deliver(scheduleEnvelope(2));
    built.taskPort.failDelete(0);

    expect(rows(1).map((row) => [row.status, row.dequeued_at])).toEqual([
      ['superseded', null],
      ['superseded', null],
    ]);
    expect(built.taskPort.deleted).toEqual([]);
    const [gone, kept] = plannedTasks(1) as [PortTask, PortTask];
    // A task already absent from the queue answers not-found, which recovery counts as deleted.
    await built.taskPort.delete(gone.queue, gone.name);
    const superseded = Math.max(...rows(1).map((row) => row.updated_at.getTime()));

    await recoverAt(superseded + SCHEDULED_TASK_RECOVERY_AGE_MS - 1);
    expect(rows(1).map((row) => row.dequeued_at)).toEqual([null, null]);
    expect(built.taskPort.deleted).toEqual([gone]);

    const repairedAt = superseded + SCHEDULED_TASK_RECOVERY_AGE_MS + 1;
    await recoverAt(repairedAt);
    expect(rows(1).map((row) => row.dequeued_at?.getTime())).toEqual([repairedAt, repairedAt]);
    expect(built.taskPort.deleted).toEqual([gone, kept]);

    const after = rows();
    await recoverAt(repairedAt + SCHEDULED_TASK_RECOVERY_AGE_MS);
    expect(built.taskPort.deleted).toEqual([gone, kept]);
    expect(rows()).toEqual(after);
    expect(liveTasks()).toEqual(plannedSet(2));
  });
});
