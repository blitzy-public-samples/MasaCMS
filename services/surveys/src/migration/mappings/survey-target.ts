// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import { SURVEY_TARGET } from '../../repo/tables.js';

/** Maps `synthetic.survey_target` to `surveys.survey_target`; rows take their survey's tenant, since `siteID` names the targeted site. */
export const surveyTargetMapping = defineMapping({
  legacyTable: 'synthetic.survey_target',
  // defineMapping needs a schema-qualified target; the unit is that name, and SURVEY_TARGET.table is its unqualified repository form.
  targetTable: SURVEY_TARGET.unit,
  unit: SURVEY_TARGET.unit,
  columns: [
    { legacy: 'target_id', target: 'target_id', type: 's' },
    { legacy: 'survey_id', target: 'survey_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'group_name', target: 'group_name', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: ['target_id'],
  tenant: { kind: 'parent', parentLegacyTable: 'synthetic.survey', columns: { survey_id: 'survey_id' } },
});
