// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The effect of the fixture launch task callback (`surveys/surveys/{id}/launch`): a scheduled survey turns LAUNCHED once. */
import type { TenantTx } from '@opt2/platform/tenancy';
import { FixtureApiError } from '../legacy/fixture-envelope.js';
import type { SurveysRepository } from '../repo/repository.js';
import { getSchedule } from '../repo/queries.js';
import type { SurveyRow } from '../repo/tables.js';
import { SURVEY_STATUS, requireSurvey } from './surveys.js';

/** What a launch did: only `launched` wrote the survey. */
export type LaunchOutcome = 'launched' | 'already-launched' | 'superseded';

/** The launch outcome and the survey row after it. */
export type LaunchResult = { outcome: LaunchOutcome; survey: SurveyRow };

/** Launch parameters; `scheduleVersion` is the schedule version a launch task was created for, absent when the caller has none. */
export type LaunchParams = { repository: SurveysRepository; surveyId: string; scheduleVersion?: number };

/**
 * Sets the survey LAUNCHED with `launched_at` from the repository clock, in the caller's gated tenant transaction.
 * A task for an older schedule version is `superseded` and a survey launched before is `already-launched`; neither writes.
 * Throws the fixture `notFound` for an unknown survey and `forbidden` for one never scheduled.
 */
export async function launchSurvey(tx: TenantTx, { repository, surveyId, scheduleVersion }: LaunchParams): Promise<LaunchResult> {
  // The survey row is locked before its schedule is read, as the fixture callback locks it, so a concurrent reschedule
  // either commits before the version check below or waits for this launch to commit.
  await repository.lockSurvey(tx, surveyId);
  const survey = await requireSurvey(tx, surveyId);
  const schedule = await getSchedule(tx, survey.survey_id);
  if (schedule === null) {
    // The fixture finds no stored task-token hash for a survey never scheduled and answers `forbidden`.
    throw new FixtureApiError('forbidden');
  }
  if (scheduleVersion !== undefined && scheduleVersion < schedule.schedule_version) {
    return { outcome: 'superseded', survey };
  }
  // The fixture's update matches only `launched_at IS NULL`, so `launched_at`, not the status, marks an earlier launch.
  if (survey.launched_at !== null) {
    return { outcome: 'already-launched', survey };
  }
  const launched = await repository.setSurveyStatus(tx, survey.survey_id, SURVEY_STATUS.LAUNCHED);
  if (launched === null) {
    throw new FixtureApiError('notFound');
  }
  return { outcome: 'launched', survey: launched };
}
