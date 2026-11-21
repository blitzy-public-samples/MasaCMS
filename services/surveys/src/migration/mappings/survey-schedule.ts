// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { SURVEY_SCHEDULE } from '../../repo/tables.js';

/** `synthetic.survey_schedule` ↔ `surveys.survey_schedule`; rows take the tenant of their parent survey. */
export const surveyScheduleMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.survey_schedule',
  // A surveys unit is one table named `surveys.<table>`: the schema-qualified form defineMapping needs, which SURVEY_SCHEDULE.table lacks.
  targetTable: SURVEY_SCHEDULE.unit,
  unit: SURVEY_SCHEDULE.unit,
  columns: [
    { legacy: 'schedule_id', target: 'schedule_id', type: 's' },
    { legacy: 'survey_id', target: 'survey_id', type: 's' },
    { legacy: 'launch_at', target: 'launch_at', type: 't' },
    { legacy: 'schedule_version', target: 'schedule_version', type: 'i' },
    { legacy: 'task_name', target: 'task_name', type: 's' },
    { legacy: 'task_token_hash', target: 'task_token_hash', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
  ],
  key: ['schedule_id'],
  tenant: { kind: 'parent', parentLegacyTable: 'synthetic.survey', columns: { survey_id: 'survey_id' } },
});
