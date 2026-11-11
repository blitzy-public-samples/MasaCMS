// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reminder-sent effect against a throwaway `surveys` schema: stamp once, repeat, supersession, notFound, isolation and the reschedule lock. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { fixedClock } from '@opt2/platform/service-kit';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { recordReminderSent, type ReminderSentInput } from '../../src/domain/reminders.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { createSurveysRepository, reminderTaskName, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS, type SurveyRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const LAUNCH_AT = new Date(2026, 6, 1, 9, 0, 0);
const SENT_AT = new Date(2026, 6, 1, 10, 0, 2, 500);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);

interface LoggedChange {
  table: string;
  op: string;
  columns: string[];
}

const available = await pgAvailable();

describe.skipIf(!available)('recordReminderSent against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;
  let tenants = 0;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createSurveysRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    tenants += 1;
    tenantId = tenantIdForSite(`surveys-reminders-${tenants}`);
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function record(input: Omit<ReminderSentInput, 'repository'>, tenant = tenantId) {
    return withGatedTenant(handle.app, tenant, (tx) => recordReminderSent(tx, { repository, ...input }));
  }

  function changelog(): Promise<LoggedChange[]> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<LoggedChange>(`SELECT "table", op, columns FROM ${handle.schema}.changelog ORDER BY seq`);
      return rows;
    });
  }

  /** Writes a schedule with `reminders` offsets the way a (re)schedule does, under the survey lock. */
  function schedule(tx: TenantTx, surveyId: string, hash: string, reminders: readonly number[]) {
    return repository
      .upsertSchedule(tx, surveyId, { launchAt: LAUNCH_AT, taskTokenHash: hash })
      .then(() =>
        repository.replaceReminders(
          tx,
          surveyId,
          reminders.map((offset) => ({ offsetMinutes: offset, remindAt: new Date(LAUNCH_AT.getTime() + offset * 60_000), taskTokenHash: hash })),
        ),
      );
  }

  async function scheduledSurvey(reminders: readonly number[] = [60, 120]): Promise<SurveyRow> {
    return inTenant(async (tx) => {
      const survey = await repository.insertSurvey(tx, { siteId: 'tenant-a', title: 'Pulse', createdById: USER_ID });
      await schedule(tx, survey.survey_id, HASH_1, reminders);
      return survey;
    });
  }

  /** Resolves once a session of this database waits on a lock, so a racing transaction has reached the survey lock. */
  async function lockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const { rows } = await withMetadata(handle.app, (tx) =>
        tx.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        ),
      );
      if ((rows[0]?.n ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('no transaction waited on the survey lock');
  }

  it('stamps sent_at of reminder n with the repository clock and logs one update', async () => {
    const survey = await scheduledSurvey();
    const before = (await changelog()).length;

    const result = await record({ surveyId: survey.survey_id, n: 2 });

    expect(result.outcome).toBe('recorded');
    expect(result.reminder).toMatchObject({
      tenant_id: tenantId,
      survey_id: survey.survey_id,
      offset_minutes: 120,
      task_name: reminderTaskName(survey.survey_id, 2),
    });
    expect(result.reminder.sent_at?.getTime()).toBe(NOW.getTime());
    expect((await changelog()).slice(before)).toEqual([{ table: 'survey_reminder', op: 'update', columns: ['sent_at'] }]);
  });

  it('stamps the reported sentAt for the current schedule version', async () => {
    const survey = await scheduledSurvey();

    const result = await record({ surveyId: survey.survey_id, n: 1, scheduleVersion: 1, sentAt: SENT_AT });

    expect(result.outcome).toBe('recorded');
    expect(result.reminder.sent_at?.getTime()).toBe(SENT_AT.getTime());
  });

  it('answers already-recorded with the stored row and no write on a repeat', async () => {
    const survey = await scheduledSurvey();
    const first = await record({ surveyId: survey.survey_id, n: 1 });
    const logged = (await changelog()).length;

    const repeat = await record({ surveyId: survey.survey_id, n: 1, scheduleVersion: 1, sentAt: SENT_AT });

    expect(repeat).toEqual({ outcome: 'already-recorded', reminder: first.reminder });
    expect(await changelog()).toHaveLength(logged);
  });

  it('answers superseded with no write for a reminder of an older schedule version', async () => {
    const survey = await scheduledSurvey();
    await inTenant((tx) => schedule(tx, survey.survey_id, HASH_2, [30]));
    const logged = (await changelog()).length;

    const result = await record({ surveyId: survey.survey_id, n: 1, scheduleVersion: 1 });

    expect(result.outcome).toBe('superseded');
    expect(result.reminder).toMatchObject({ offset_minutes: 30, task_token_hash: HASH_2, sent_at: null });
    expect(await changelog()).toHaveLength(logged);
  });

  it.each([
    ['an unknown survey', UNKNOWN_ID, 1],
    ['an unknown reminder ordinal', undefined, 3],
  ] as const)('answers the fixture notFound for %s and writes nothing', async (_case, unknownId, n) => {
    const survey = await scheduledSurvey();
    const logged = (await changelog()).length;

    const error = await record({ surveyId: unknownId ?? survey.survey_id, n }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type: 'notFound', messageOverride: undefined });
    expect(await changelog()).toHaveLength(logged);
  });

  it("answers notFound for another tenant's survey and leaves its reminder unstamped", async () => {
    const survey = await scheduledSurvey();

    const error = await record({ surveyId: survey.survey_id, n: 1 }, tenantIdForSite('surveys-reminders-other')).catch((e: unknown) => e);

    expect(error).toMatchObject({ type: 'notFound' });
    const reminders = await inTenant((tx) =>
      tx.query<{ sent_at: Date | null }>(`SELECT sent_at FROM ${handle.schema}.survey_reminder WHERE survey_id = $1`, [survey.survey_id]),
    );
    expect(reminders.rows.map((row) => row.sent_at)).toEqual([null, null]);
  });

  it('waits for a racing reschedule and then answers superseded without stamping the new reminder', async () => {
    const survey = await scheduledSurvey([60]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let rescheduled!: () => void;
    const written = new Promise<void>((resolve) => (rescheduled = resolve));
    const reschedule = inTenant(async (tx) => {
      await schedule(tx, survey.survey_id, HASH_2, [90]);
      rescheduled();
      await held;
    });
    await written;

    const recording = record({ surveyId: survey.survey_id, n: 1, scheduleVersion: 1 });
    await lockWaiter();
    release();
    await reschedule;
    const result = await recording;

    expect(result.outcome).toBe('superseded');
    expect(result.reminder).toMatchObject({ offset_minutes: 90, sent_at: null });
  });

  it('propagates the refusal of a reminder unit that is not target-authoritative', async () => {
    const survey = await scheduledSurvey();
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'legacy' WHERE unit = 'surveys.survey_reminder'`),
    );

    await expect(record({ surveyId: survey.survey_id, n: 1 })).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
  });
});
