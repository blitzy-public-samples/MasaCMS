// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 out-of-order delivery of `surveys.survey.scheduled.v1` through the push route, over a throwaway PostgreSQL schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@opt2/platform/events';
import type { CreateTaskInput } from '@opt2/platform/tasks';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createThrowawaySchema,
  deliverOutOfOrder,
  pgAvailable,
  pushTo,
  seedRegistry,
  versionedSequence,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SURVEY_TASK_QUEUES, portTaskName } from '../../src/domain/survey-tasks.js';
import { SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC, type SurveyScheduledPayload } from '../../src/events/survey-scheduled.js';
import { SCHEDULED_TASK, type ScheduledTaskRow } from '../../src/repo/tables.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { envelopeFor, surveyScheduledPayload } from '../helpers/payloads.js';

type ScheduleEnvelope = EventEnvelope<SurveyScheduledPayload>;

/** A port task as the assertions compare it. */
interface PortTask {
  queue: string;
  name: string;
  tenantId: string | undefined;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_CONFIGURED = Boolean(process.env.PG_HOST);
const available = PG_CONFIGURED && (await pgAvailable());
const SKIP_REASON = PG_CONFIGURED ? 'requires PostgreSQL: server unreachable' : 'requires PostgreSQL: PG_HOST not set';

// One survey per case, so the cases share the schema and the task port.
const SURVEYS = Object.freeze({
  v2First: 'D4E5F6A7-0004-4000-8000000000000201',
  v1First: 'D4E5F6A7-0004-4000-8000000000000202',
  redelivered: 'D4E5F6A7-0004-4000-8000000000000203',
});

/** Schedule versions 1 and 2 of `surveyId` as tenant-a envelopes of one aggregate, each with its own eventId. */
function schedules(surveyId: string): [ScheduleEnvelope, ScheduleEnvelope] {
  const base = envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1, { surveyId }), { tenantId: TENANT_A.tenantId });
  return versionedSequence(base, [1, 2], (version) => surveyScheduledPayload(version as 1 | 2, { surveyId })) as [
    ScheduleEnvelope,
    ScheduleEnvelope,
  ];
}

/** The port tasks schedule `version` of `surveyId` must create: the launch, then one per reminder. */
function expectedTasks(surveyId: string, version: 1 | 2): PortTask[] {
  const payload = surveyScheduledPayload(version, { surveyId });
  return [
    { queue: SURVEY_TASK_QUEUES['survey-launch'], name: portTaskName(payload.launchTaskName, version), tenantId: TENANT_A.tenantId },
    ...payload.reminders.map((reminder) => ({
      queue: SURVEY_TASK_QUEUES['survey-reminder'],
      name: portTaskName(reminder.taskName, version),
      tenantId: TENANT_A.tenantId,
    })),
  ];
}

function byName<T extends { name: string }>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => a.name.localeCompare(b.name));
}

function ofSurvey<T extends { name: string }>(tasks: readonly T[], surveyId: string): T[] {
  return tasks.filter((task) => task.name.startsWith(`opt2-survey-${surveyId}-`));
}

function portTask(input: CreateTaskInput): PortTask {
  return { queue: input.queue, name: input.name, tenantId: input.tenantId };
}

describe.skipIf(!available)(`survey.scheduled consumer${available ? '' : ` (${SKIP_REASON})`}`, () => {
  let schema!: ThrowawaySchema;
  let ctx!: TestApp<TenantDb>;

  /** The survey's `scheduled_task` rows under tenant-a, by schedule version, kind and reminder ordinal. */
  async function taskRows(surveyId: string): Promise<ScheduledTaskRow[]> {
    return withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<ScheduledTaskRow>(
        `SELECT * FROM ${schema.schema}.scheduled_task WHERE source_id = $1 ORDER BY schedule_version, kind, reminder_n NULLS FIRST`,
        [surveyId],
      );
      return rows;
    });
  }

  /** Statuses of tenant-a's inbox receipts for `eventId`. */
  async function inboxStatuses(eventId: string): Promise<string[]> {
    return withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      const { rows } = await tx.query<{ status: string }>(`SELECT status FROM ${schema.schema}.inbox WHERE event_id = $1`, [eventId]);
      return rows.map((row) => row.status);
    });
  }

  /** The survey's tasks the fake port created, holds live and deleted. */
  function portState(surveyId: string): { created: PortTask[]; live: PortTask[]; deleted: { queue: string; name: string }[] } {
    const { taskPort } = ctx;
    return {
      created: ofSurvey(taskPort.tasks, surveyId).map(portTask),
      live: ofSurvey(taskPort.live(), surveyId).map(portTask),
      deleted: ofSurvey(taskPort.deleted, surveyId),
    };
  }

  /** Waits until every row of `version` is in `status` with its queue stamp set. */
  async function settled(surveyId: string, version: number, status: 'scheduled' | 'superseded'): Promise<void> {
    await vi.waitFor(async () => {
      const rows = (await taskRows(surveyId)).filter((row) => row.schedule_version === version);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status).toBe(status);
        expect(status === 'scheduled' ? row.enqueued_at : row.dequeued_at).toBeInstanceOf(Date);
      }
    });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'communications', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ctx = await buildTestApp({ db: schema.app, seedRegistry: false });
    // The app's start-up ensures every gate as `legacy`; the consumer's only gated unit must accept target writes.
    const gate = await schema.adminPool.query(
      `UPDATE ${schema.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = $1`,
      [SCHEDULED_TASK.unit],
    );
    expect(gate.rowCount).toBe(1);
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  it('v2 then v1: late v1 is superseded', async () => {
    const survey = SURVEYS.v2First;
    const envelopes = schedules(survey);
    const [v1, v2] = envelopes;

    const responses = await deliverOutOfOrder(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopes, [1, 0]);

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204]);
    await settled(survey, 2, 'scheduled');
    const rows = await taskRows(survey);
    expect(rows.map((row) => [row.schedule_version, row.status, row.queue, row.queue_task_name, row.dequeued_at])).toEqual(
      expectedTasks(survey, 2).map((task) => [2, 'scheduled', task.queue, task.name, null]),
    );
    expect(await inboxStatuses(v1.eventId)).toEqual(['superseded']);
    expect(await inboxStatuses(v2.eventId)).toEqual(['applied']);
    const port = portState(survey);
    expect(byName(port.live)).toEqual(byName(expectedTasks(survey, 2)));
    expect(byName(port.created)).toEqual(byName(expectedTasks(survey, 2)));
    expect(port.deleted).toEqual([]);
  });

  it('v1 then v2: v2 replaces v1', async () => {
    const survey = SURVEYS.v1First;
    const envelopes = schedules(survey);
    const [v1, v2] = envelopes;

    const responses = await deliverOutOfOrder(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopes, [0, 1]);

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204]);
    await settled(survey, 1, 'superseded');
    await settled(survey, 2, 'scheduled');
    const rows = await taskRows(survey);
    expect(rows.map((row) => [row.schedule_version, row.status, row.queue_task_name])).toEqual([
      ...expectedTasks(survey, 1).map((task) => [1, 'superseded', task.name]),
      ...expectedTasks(survey, 2).map((task) => [2, 'scheduled', task.name]),
    ]);
    expect(await inboxStatuses(v1.eventId)).toEqual(['applied']);
    expect(await inboxStatuses(v2.eventId)).toEqual(['applied']);
    const port = portState(survey);
    expect(byName(port.deleted)).toEqual(byName(expectedTasks(survey, 1)).map(({ queue, name }) => ({ queue, name })));
    expect(byName(port.live)).toEqual(byName(expectedTasks(survey, 2)));
  });

  it('redelivered v1 after v2 changes nothing', async () => {
    const survey = SURVEYS.redelivered;
    const envelopes = schedules(survey);
    const [v1] = envelopes;
    const { app } = ctx;
    await deliverOutOfOrder(app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopes, [0, 1]);
    await settled(survey, 1, 'superseded');
    await settled(survey, 2, 'scheduled');
    const rowsBefore = await taskRows(survey);
    const portBefore = portState(survey);

    const response = await pushTo(app, SURVEY_SCHEDULED_SUBSCRIPTION, v1);

    expect(response.statusCode).toBe(204);
    expect(await taskRows(survey)).toEqual(rowsBefore);
    expect(portState(survey)).toEqual(portBefore);
    expect(await inboxStatuses(v1.eventId)).toEqual(['applied']);
  });
});
