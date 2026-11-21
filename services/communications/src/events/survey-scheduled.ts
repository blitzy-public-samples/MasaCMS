// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Seam 2 consumer binding of `surveys.survey.scheduled.v1`: the topic's declarations, the tenant re-check and the schedule-task effect. */
import { readTopicSchema, type ConsumerDefinition } from '@opt2/platform/events';
import { registryEntryForTenant } from '@opt2/platform/tenancy';
import { applySurveyScheduled, type SurveyScheduleDeps } from '../domain/survey-schedule.js';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';

export type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';

/** Topic of the survey schedule event, produced by surveys. */
export const SURVEY_SCHEDULED_TOPIC = 'surveys.survey.scheduled.v1' as const;

/** The producer's payload schema, read once at module load from the surveys contracts. */
export const surveyScheduledSchema = readTopicSchema(
  new URL('../../../surveys/contracts/events/surveys.survey.scheduled.v1.json', import.meta.url),
);

/** A site id in SQL Server's case-insensitive equality form: trailing spaces are insignificant, leading ones are not. */
function siteKey(siteId: string): string {
  return siteId.replace(/ +$/u, '').toLowerCase();
}

/** Superseding `process` consumer: a later schedule version replaces the tasks of an earlier one; the envelope tenant, the payload site's, is the only destination. */
export function surveyScheduledConsumer(deps: SurveyScheduleDeps): ConsumerDefinition<SurveyScheduledPayload> {
  return {
    topic: SURVEY_SCHEDULED_TOPIC,
    kind: 'process',
    supersedes: true,
    async checkTenant(tx, { aggregateType, aggregateId, payload }) {
      if (aggregateType !== 'survey-schedule' || aggregateId !== payload.surveyId) {
        return false;
      }
      const entry = await registryEntryForTenant(tx, tx.tenantId);
      if (entry === null) {
        return 'invalid-tenant';
      }
      return siteKey(entry.siteId) === siteKey(payload.siteId);
    },
    apply: applySurveyScheduled(deps),
  };
}
