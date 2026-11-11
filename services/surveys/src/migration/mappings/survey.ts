// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import { SURVEY } from '../../repo/tables.js';

/** Mapping of fixture table `synthetic.survey` to `surveys.survey`, tenant from the row's own `siteID`. */
export const surveyMapping = defineMapping({
  legacyTable: 'synthetic.survey',
  // A mapping's target table is schema-qualified; SURVEY.table is the repository's unqualified name, SURVEY.unit the qualified one.
  targetTable: SURVEY.unit,
  unit: SURVEY.unit,
  columns: [
    { legacy: 'survey_id', target: 'survey_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'title', target: 'title', type: 's' },
    { legacy: 'status', target: 'status', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'createdByID', target: 'createdbyid', type: 's' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'lastUpdateByID', target: 'lastupdatebyid', type: 's' },
    { legacy: 'launched_at', target: 'launched_at', type: 't' },
  ],
  key: ['survey_id'],
  tenant: { kind: 'site', column: 'siteID' },
});
