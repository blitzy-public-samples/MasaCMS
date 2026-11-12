// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 consumer binding of `surveys.survey.scheduled.v1`: the topic's declarations and the schedule-task effect. */
import { readTopicSchema, type ConsumerDefinition } from '@opt2/platform/events';
import { applySurveyScheduled, type SurveyScheduleDeps } from '../domain/survey-schedule.js';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';

export type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';

/** Topic of the survey schedule event, produced by surveys. */
export const SURVEY_SCHEDULED_TOPIC = 'surveys.survey.scheduled.v1' as const;

/** The producer's payload schema, read once at module load from the surveys contracts. */
export const surveyScheduledSchema = readTopicSchema(
  new URL('../../../surveys/contracts/events/surveys.survey.scheduled.v1.json', import.meta.url),
);

/** Superseding `process` consumer: a later schedule version replaces the tasks of an earlier one; the envelope tenant is the only destination. */
export function surveyScheduledConsumer(deps: SurveyScheduleDeps): ConsumerDefinition<SurveyScheduledPayload> {
  return {
    topic: SURVEY_SCHEDULED_TOPIC,
    kind: 'process',
    supersedes: true,
    apply: applySurveyScheduled(deps),
  };
}
