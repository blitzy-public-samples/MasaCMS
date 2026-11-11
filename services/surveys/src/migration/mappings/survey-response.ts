// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import { SURVEY_RESPONSE } from '../../repo/tables.js';

/** `synthetic.survey_response` ↔ `surveys.survey_response`, tenant from the survey's `siteID`; `respondentSiteID` is data. */
export const surveyResponseMapping = defineMapping({
  legacyTable: 'synthetic.survey_response',
  // SURVEY_RESPONSE.table is unqualified; the target names it under the logical schema `surveys`.
  targetTable: `surveys.${SURVEY_RESPONSE.table}`,
  unit: SURVEY_RESPONSE.unit,
  columns: [
    { legacy: 'response_id', target: 'response_id', type: 's' },
    { legacy: 'survey_id', target: 'survey_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'respondentSiteID', target: 'respondentsiteid', type: 's' },
    { legacy: 'respondent_user_id', target: 'respondent_user_id', type: 's' },
    { legacy: 'answers', target: 'answers', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: ['response_id'],
  tenant: { kind: 'site', column: 'siteID' },
});
