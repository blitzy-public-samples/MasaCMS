// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The surveys-owned effect of a sent reminder, as the fixture `surveys.cfc` remind callback writes it: `sent_at` stamped once. */
import type { TenantTx } from '@opt2/platform/tenancy';
import { FixtureApiError } from '../legacy/fixture-envelope.js';
import * as queries from '../repo/queries.js';
import { reminderTaskName, type SurveysRepository } from '../repo/repository.js';
import { SURVEY_REMINDER, type SurveyReminderRow } from '../repo/tables.js';
import { requireSurvey } from './surveys.js';

/**
 * `recorded` stamped `sent_at`; `already-recorded` found it stamped; `superseded` came from an older schedule version.
 * Only `recorded` writes. The fixture callback always stamps `sent_at`, so there is no validate-only outcome.
 */
export type ReminderOutcome = 'recorded' | 'already-recorded' | 'superseded';

/** The outcome and the stored reminder row after it. */
export type ReminderResult = { outcome: ReminderOutcome; reminder: SurveyReminderRow };

/** Parameters of {@link recordReminderSent}. */
export interface ReminderSentInput {
  repository: SurveysRepository;
  surveyId: string;
  /** 1-based reminder ordinal, the suffix of its task name. */
  n: number;
  /** Schedule version the reminder task belongs to; omitted where the caller already tied the task to the current schedule. */
  scheduleVersion?: number;
  /** Time to stamp, as communications reports it; defaults to the repository clock, as the fixture stamps its own now(). */
  sentAt?: Date;
}

/** The fixture's unknown-reminder error: `notFound` with its default message. */
function reminderNotFound(): FixtureApiError {
  return new FixtureApiError('notFound');
}

/**
 * Stamps reminder `n` of the transaction tenant's survey sent once, inside the caller's gated tenant transaction.
 * Throws the fixture's `notFound` for an unknown survey or reminder; gate errors propagate to the caller.
 */
export async function recordReminderSent(
  tx: TenantTx,
  { repository, surveyId, n, scheduleVersion, sentAt }: ReminderSentInput,
): Promise<ReminderResult> {
  const survey = await requireSurvey(tx, surveyId);
  // Reschedules bump the version and replace the reminders under this lock, so the reads below hold until commit;
  // the fixture callback likewise locks the survey before reading its reminder.
  await repository.lockSurvey(tx, survey.survey_id);
  const taskName = reminderTaskName(survey.survey_id, n);
  const found = (await queries.listReminders(tx, survey.survey_id)).find((reminder) => reminder.task_name === taskName);
  const stored =
    found === undefined
      ? null
      : await repository.findByKey<SurveyReminderRow>(tx, SURVEY_REMINDER.table, { reminder_id: found.reminder_id });
  if (stored === null) {
    throw reminderNotFound();
  }

  const schedule = await queries.getSchedule(tx, survey.survey_id);
  if (scheduleVersion !== undefined && scheduleVersion < (schedule?.schedule_version ?? 0)) {
    return { outcome: 'superseded', reminder: stored };
  }
  if (stored.sent_at !== null) {
    return { outcome: 'already-recorded', reminder: stored };
  }

  const stamped = await repository.markReminderSent(tx, survey.survey_id, n, sentAt);
  if (stamped === null) {
    throw reminderNotFound();
  }
  return { outcome: 'recorded', reminder: stamped };
}
