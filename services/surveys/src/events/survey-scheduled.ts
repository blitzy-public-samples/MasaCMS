// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Producer of `surveys.survey.scheduled.v1`, the seam-2 process event communications turns into launch and reminder tasks. */
import { compileTopicSchema, readTopicSchema, type EventEnvelope, type TopicValidator } from '@opt2/platform/events';
import { writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';

/** Topic of the survey schedule event. */
export const SURVEY_SCHEDULED_TOPIC = 'surveys.survey.scheduled.v1' as const;

/** The topic's payload schema, read once at module load. */
export const surveyScheduledSchema = readTopicSchema(
  new URL('../../contracts/events/surveys.survey.scheduled.v1.json', import.meta.url),
);

/** Compiled payload validator; its meta declares a superseding `process` topic. */
export const surveyScheduledValidator: TopicValidator = compileTopicSchema(surveyScheduledSchema);

/** One committed schedule write to announce. */
export interface SurveyScheduledWrite {
  /** CF-format id of the survey; the event's aggregate id and ordering key. */
  surveyId: string;
  /** The schedule's `row_version` after the write, incremented in the same transaction. */
  rowVersion: number;
  payload: SurveyScheduledPayload;
  origin?: OutboxOrigin;
}

/** Writes the schedule's `process` outbox row in `tx`; returns null when `origin` suppresses it. */
export function writeSurveyScheduled(
  tx: TenantTx,
  input: SurveyScheduledWrite,
): Promise<EventEnvelope<SurveyScheduledPayload> | null> {
  return writeOutbox(tx, {
    topic: SURVEY_SCHEDULED_TOPIC,
    kind: 'process',
    aggregateType: 'survey-schedule',
    aggregateId: input.surveyId,
    aggregateVersion: input.rowVersion,
    payload: input.payload,
    origin: input.origin,
  });
}
